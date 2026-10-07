/**
 * dsh-router-laya for OpenCode — a local Laya judge (dsh-router-laya's Python service)
 * decides the reasoning tier per request, and this plugin applies it as that request's
 * reasoning effort. The model is deliberately left alone: router-laya's whole point is
 * that one model is used at low/high/max effort.
 *
 * When does it route? Exactly when your OpenCode variant picker says **Default**.
 *   - picker = Default  -> the judge decides the tier for every turn (auto)
 *   - picker = low/medium/high/xhigh/max -> hands off, your choice is used verbatim
 *     (and the judge is not called at all, so this costs no latency)
 * Set ROUTER_LAYA_RESPECT_EXPLICIT=0 to keep routing even when a variant is pinned.
 *
 * Where the tier is written (both, deliberately):
 *   - `input.message.variant` — OpenCode's per-request variant. This is the channel that
 *     visibly works (verified: the same prompt at forced low vs forced max gave 0 vs
 *     1034 reasoning tokens). It also makes omo's own `applyAgentVariant` stand down
 *     for that turn (it skips when the message already carries a variant).
 *   - `output.options.reasoningEffort` — the request option, kept for models/providers
 *     that read it. OpenCode filters values the model does not declare, so an invalid
 *     value here fails silently (not usable as a channel test).
 *
 * What the judge sees (it does NOT read the conversation): the current message text, the
 * previous turn's tier, and the previous turn's text (the last two only for "keep the last
 * tier" intent and for retry/escalation detection).
 *
 * Two caches keep this honest, because OpenCode instantiates a local plugin once per
 * instance/context — several live instances all receive the same hooks:
 *   - per-session memory: one user turn = one judgment, however many LLM calls it makes
 *     (re-judging inside a turn would look like a retry and escalate by itself);
 *   - a small shared file: the other instances reuse the verdict instead of paying a
 *     second judge call and firing a second toast for the same turn.
 *
 * Env:
 *   ROUTER_LAYA=0                     disable everything (pass-through)
 *   ROUTER_LAYA_JUDGE_URL=...         judge endpoint (default http://127.0.0.1:8765/judge)
 *   ROUTER_LAYA_TIMEOUT_MS=10000      judge timeout; on failure the request is left
 *                                     untouched. MUST be >= this machine's per-turn
 *                                     judging time (else every turn fail-safes).
 *   ROUTER_LAYA_RESPECT_EXPLICIT=0    route even when a variant is pinned (default: defer)
 *   ROUTER_LAYA_PROBE=<value>         force this tier, skipping the judge
 *   ROUTER_LAYA_TOAST=0               silence the per-turn toast (default: on)
 *   ROUTER_LAYA_AUTOSTART=0           never try to start the judge service
 *   ROUTER_LAYA_PYTHON / _SCRIPT      override the judge's python / script path
 *
 * NOTE (export form): this file exports BOTH a default and a named `RouterLaya`
 * (the same function). OpenCode's loader accepts either shape across versions and
 * dedupes identical references, so this file loads everywhere without per-machine
 * edits. See the guide's §4.1 if you prefer to keep only one form.
 *
 * Runtime switches — files, so no OpenCode restart is needed:
 *   %TEMP%/router-laya-oc.mode    "manual" = pass-through, anything else/absent = auto
 *   %TEMP%/router-laya-oc.probe   force this tier for every request (A/B testing; delete
 *                                 to go back to real routing) — use declared levels
 *
 * Log: %TEMP%/router-laya-oc.log
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const JUDGE_URL = process.env.ROUTER_LAYA_JUDGE_URL ?? "http://127.0.0.1:8765/judge"
const JUDGE_PORT = (() => {
  try {
    return new URL(JUDGE_URL).port || "8765"
  } catch {
    return "8765"
  }
})()
const TIMEOUT_MS = Number(process.env.ROUTER_LAYA_TIMEOUT_MS ?? 10000)
const PROBE = process.env.ROUTER_LAYA_PROBE ?? ""
const DISABLED = process.env.ROUTER_LAYA === "0"
// Default ON: a pinned variant means the user has decided, so the judge stays out of the way.
const RESPECT_EXPLICIT = process.env.ROUTER_LAYA_RESPECT_EXPLICIT !== "0"
const TOAST = process.env.ROUTER_LAYA_TOAST !== "0"
const AUTOSTART = process.env.ROUTER_LAYA_AUTOSTART !== "0"
const LOG_FILE = join(tmpdir(), "router-laya-oc.log")
const MODE_FILE = join(tmpdir(), "router-laya-oc.mode")
const PROBE_FILE = join(tmpdir(), "router-laya-oc.probe")
const SHARED_FILE = join(tmpdir(), "router-laya-oc.shared.json")
const SPAWN_MARKER = join(tmpdir(), "router-laya-oc.spawn")
const SHARED_TTL_MS = 10 * 60 * 1000
const SPAWN_COOLDOWN_MS = 60 * 1000

// Judge service paths. First existing candidate wins; the env override comes first.
// Candidate 2 covers a venv built OUTSIDE the package (short path, avoids WinError 206);
// candidate 3 is the in-package venv the package's own setup.mjs builds.
const SERVICE_PYTHON_CANDIDATES = [
  process.env.ROUTER_LAYA_PYTHON,
  join(process.env.USERPROFILE ?? "", ".dsh-router-laya", "venv", "Scripts", "python.exe"),
  join(process.env.APPDATA ?? "", "npm", "node_modules", "dsh-router-laya", ".venv-router", "Scripts", "python.exe"),
].filter(Boolean)
const SERVICE_PYTHON =
  SERVICE_PYTHON_CANDIDATES.find((p) => existsSync(p)) ?? SERVICE_PYTHON_CANDIDATES[0]
const SERVICE_SCRIPT_CANDIDATES = [
  process.env.ROUTER_LAYA_SCRIPT,
  join(process.env.APPDATA ?? "", "npm", "node_modules", "dsh-router-laya", "service", "laya_router.py"),
].filter(Boolean)
const SERVICE_SCRIPT =
  SERVICE_SCRIPT_CANDIDATES.find((p) => existsSync(p)) ?? SERVICE_SCRIPT_CANDIDATES[0]

const TIERS = new Set(["low", "high", "max"])
/** Variant values that mean "no choice made" — only these let the judge route. */
const UNPINNED = new Set(["", "default", "auto", "none"])

/**
 * sessionID -> {
 *   text, pinned,          // this turn: task text, the variant the picker had (if any)
 *   turn,                  // bumped by chat.message; identifies the user turn
 *   tier, task,            // what we served last turn (feeds prev_tier / prev_task)
 *   cachedTurn, cachedTier // the verdict already computed for `turn`
 * }
 */
const sessions = new Map()

function log(message) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, "utf8")
  } catch {}
}

function digest(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 12)
}

/** Runtime switch: re-read per request, so flipping it needs no OpenCode restart. */
function manual() {
  if (DISABLED) return true
  try {
    return readFileSync(MODE_FILE, "utf8").trim() === "manual"
  } catch {
    return false
  }
}

/** A/B testing: force one tier for every request (file wins, env is the fallback). */
function probeValue() {
  if (PROBE) return PROBE
  try {
    return readFileSync(PROBE_FILE, "utf8").trim()
  } catch {
    return ""
  }
}

async function healthUp() {
  try {
    const base = JUDGE_URL.replace(/\/judge\/?$/, "")
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return false
    const info = await res.json()
    return info?.protocol === "finetuned"
  } catch {
    return false
  }
}

/**
 * Start the judge service (detached, shared with DSH). The service itself carries a
 * single-instance gate, so a duplicate spawn exits before loading the checkpoint.
 */
function startJudge() {
  if (!AUTOSTART) return
  try {
    const last = Number(readFileSync(SPAWN_MARKER, "utf8").trim() || "0")
    if (Date.now() - last < SPAWN_COOLDOWN_MS) return
  } catch {}
  try {
    writeFileSync(SPAWN_MARKER, String(Date.now()), "utf8")
  } catch {}
  try {
    const child = spawn(SERVICE_PYTHON, [SERVICE_SCRIPT, "--http", "--port", String(JUDGE_PORT)], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    })
    child.unref()
    log(`judge down -> spawned: "${SERVICE_PYTHON}" "${SERVICE_SCRIPT}" --http --port ${JUDGE_PORT}`)
  } catch (error) {
    log(`spawn failed: ${error.message}`)
  }
}

/** Write the tier into every channel OpenCode reads for a request. */
function applyTier(input, output, tier) {
  output.options = { ...(output.options ?? {}), reasoningEffort: tier }
  const message = input?.message
  if (message !== null && typeof message === "object") message.variant = tier
}

/**
 * Cross-instance verdict cache. `text` is stored alongside the tier so a turn-number
 * collision can never serve a verdict that belongs to different text.
 */
function sharedGet(key, text) {
  try {
    const all = JSON.parse(readFileSync(SHARED_FILE, "utf8"))
    const hit = all?.[key]
    if (!hit || typeof hit.tier !== "string") return null
    if (Date.now() - (hit.ts ?? 0) > SHARED_TTL_MS) return null
    return hit.text === digest(text) ? hit.tier : null
  } catch {
    return null
  }
}

function sharedPut(key, tier, text) {
  try {
    let all = {}
    try {
      all = JSON.parse(readFileSync(SHARED_FILE, "utf8")) ?? {}
    } catch {}
    const now = Date.now()
    for (const [k, v] of Object.entries(all)) if (!v || now - (v.ts ?? 0) > SHARED_TTL_MS) delete all[k]
    all[key] = { tier, text: digest(text), ts: now }
    writeFileSync(SHARED_FILE, JSON.stringify(all), "utf8")
  } catch {}
}

async function toast(client, message) {
  if (!TOAST) return
  try {
    await client?.tui?.showToast?.({ body: { title: "router-laya", message, variant: "info", duration: 2500 } })
  } catch (error) {
    log(`toast failed: ${error.message}`)
  }
}

function textOf(parts) {
  return (parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

async function judge(task, prev, sessionID) {
  const res = await fetch(JUDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: task.slice(0, 4000),
      prev_tier: prev?.tier ?? null,
      prev_task: prev?.task ?? null,
      session_id: sessionID ?? null,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (body.error) throw new Error(String(body.error))
  if (typeof body.tier !== "string" || !TIERS.has(body.tier)) throw new Error(`bad verdict ${JSON.stringify(body).slice(0, 120)}`)
  return { tier: body.tier, by: body.triggered_by ?? "", ms: body.ms ?? null }
}

async function RouterLayaPlugin({ client }) {
  log(`init pid=${process.pid} judge=${JUDGE_URL} python=${SERVICE_PYTHON} script=${SERVICE_SCRIPT} timeout=${TIMEOUT_MS} autostart=${AUTOSTART} respectExplicit=${RESPECT_EXPLICIT} toast=${TOAST}`)
  try {
    await client?.app?.log?.({
      body: { service: "router-laya", level: "info", message: "router-laya plugin loaded", extra: { judge: JUDGE_URL } },
    })
  } catch {}

  // Autostart off the request path: health-check once at load; spawn only when it is down.
  if (AUTOSTART) {
    void healthUp().then((up) => {
      if (!up) startJudge()
    })
  }

  return {
    /** New user turn: capture its text, the picker's variant, and open a fresh verdict slot. */
    "chat.message": async (input, output) => {
      const text = textOf(output?.parts)
      const variant = typeof input.variant === "string" ? input.variant.trim() : ""
      const pinned = !UNPINNED.has(variant.toLowerCase())
      const cur = sessions.get(input.sessionID) ?? {}
      sessions.set(input.sessionID, {
        ...cur,
        text,
        variant,
        pinned,
        turn: (cur.turn ?? 0) + 1,
        cachedTurn: -1,
        cachedTier: undefined,
      })
      log(`message session=${input.sessionID} agent=${input.agent ?? "-"} variant=${variant || "(default)"} -> ${pinned ? "MANUAL (hands off)" : "AUTO"} turn=${(cur.turn ?? 0) + 1} text=${JSON.stringify(text.slice(0, 60))}`)
    },

    /** Ask the judge (once per turn) and apply the tier to this request. */
    "chat.params": async (input, output) => {
      if (manual()) return
      const cur = sessions.get(input.sessionID) ?? {}
      const turn = cur.turn ?? 0
      const model = `${input.model?.providerID ?? "?"}/${input.model?.id ?? "?"}`

      // Same turn, already judged: reuse it. This keeps a multi-call turn (tool loop)
      // from being read as a retry -- the judge's escalation is for the *user* retrying.
      if (cur.cachedTier !== undefined && cur.cachedTurn === turn) {
        applyTier(input, output, cur.cachedTier)
        log(`cached session=${input.sessionID} turn=${turn} -> ${cur.cachedTier}`)
        return
      }

      const probe = probeValue()
      if (probe) {
        applyTier(input, output, probe)
        sessions.set(input.sessionID, { ...cur, cachedTurn: turn, cachedTier: probe })
        log(`probe session=${input.sessionID} turn=${turn}: forced ${probe} (variant+options) model=${model}`)
        return
      }

      // The picker is the switch: a pinned variant means the user decided, so hands off.
      if (RESPECT_EXPLICIT && cur.pinned) {
        log(`session=${input.sessionID} turn=${turn}: picker pinned '${cur.variant}' -- hands off`)
        return
      }

      const text = cur.text || textOf(input.message?.parts)
      if (!text) {
        log("no task text captured -- leaving the request untouched")
        return
      }
      if (input.model?.capabilities?.reasoning === false) {
        log(`model ${model} does not declare reasoning -- leaving the request untouched`)
        return
      }

      // Another OpenCode instance already judged this turn: reuse its verdict.
      const sharedKey = `${input.sessionID}|${turn}`
      const sharedTier = sharedGet(sharedKey, text)
      if (sharedTier !== null) {
        applyTier(input, output, sharedTier)
        sessions.set(input.sessionID, { ...cur, text, tier: sharedTier, task: text, cachedTurn: turn, cachedTier: sharedTier })
        log(`shared session=${input.sessionID} turn=${turn} -> ${sharedTier} (another instance judged it)`)
        return
      }

      try {
        // Judge down? Start it in the background and stay fail-safe for this turn.
        if (!(await healthUp())) {
          startJudge()
          log(`session=${input.sessionID} turn=${turn}: judge down -- left the request untouched`)
          return
        }
        const verdict = await judge(text, { tier: cur.tier, task: cur.task }, input.sessionID)
        applyTier(input, output, verdict.tier)
        const changed = verdict.tier !== cur.tier
        sessions.set(input.sessionID, { ...cur, text, tier: verdict.tier, task: text, cachedTurn: turn, cachedTier: verdict.tier })
        sharedPut(sharedKey, verdict.tier, text)
        log(`route session=${input.sessionID} turn=${turn} -> ${verdict.tier}${changed ? " (changed)" : ""} (${verdict.by}, ${verdict.ms}ms) model=${model}`)
        if (changed) await toast(client, `${verdict.tier.toUpperCase()} · ${verdict.by || "laya"} · ${verdict.ms ?? "?"}ms`)
      } catch (error) {
        // fail-safe: an unreachable judge must never break the turn; try to (re)start it too
        log(`judge unavailable (${error.message}) -- leaving the request untouched`)
        startJudge()
      }
    },
  }
}

// Dual export: OpenCode accepts a default function or a named function across
// versions, and dedupes identical references, so exporting the same function
// twice loads exactly once everywhere.
export default RouterLayaPlugin
export const RouterLaya = RouterLayaPlugin
