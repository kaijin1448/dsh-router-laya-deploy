/**
 * Parallel chunked downloader for the dsh-router-laya judge checkpoint (842 MB).
 *
 * Why parallel: a single stream here does ~0.06-0.3 MB/s and stalls for minutes;
 * 6 workers pulling 2 MiB Range chunks measured ~43 MB/min (12x). Only the GitHub
 * Release endpoint serves reliably (hf-mirror 404s, huggingface.co resets).
 *
 * Resume: writes straight into a preallocated `.part` file at each chunk's offset;
 * completed chunks live in `<part>.chunks.json`, so a re-run fetches only the gaps.
 * Small files (all but model.safetensors) are fetched whole, single stream.
 * Every finished file is sha256-verified against weights/manifest.json.
 * Idempotent: run it as often as you like.
 *
 * Run:
 *   node fetch-laya-chunked.mjs [--pkg <dsh-router-laya package dir>]
 * Env: ROUTER_LAYA_PKG overrides the package dir.
 *   Default: "<npm global prefix>/node_modules/dsh-router-laya" (npm prefix -g).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function resolvePkg() {
  const i = process.argv.indexOf('--pkg');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.ROUTER_LAYA_PKG) return process.env.ROUTER_LAYA_PKG;
  // On Windows `npm` is a .cmd shim; name it directly (no shell, no arg-escaping warning).
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const prefix = execFileSync(npmBin, ['prefix', '-g'], { encoding: 'utf8' }).trim();
  return path.join(prefix, 'node_modules', 'dsh-router-laya');
}

const PKG = resolvePkg();
const DEST = path.join(PKG, 'weights', 'model');
const CHUNK = 2 * 1024 * 1024;
const WORKERS = 6;
const MAX_TRIES = 60;
const REQ_TIMEOUT_MS = 150_000;
const SMALL_CUTOFF = 16 * 1024 * 1024;
const MAX_WAIT_MS = 15_000;

if (!fs.existsSync(path.join(PKG, 'weights', 'manifest.json'))) {
  console.error(`manifest not found under ${PKG}\\weights -- is the npm package installed?`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'weights', 'manifest.json'), 'utf8'));
const RELEASE_BASE = (manifest.release_base || '').replace(/\/+$/, '');
const files = [...manifest.files].sort((a, b) => a.bytes - b.bytes); // small first, 842MB last

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => (n / 1e6).toFixed(1);
const stamp = () => new Date().toTimeString().slice(0, 8);

console.log(`package : ${PKG}`);
console.log(`dest    : ${DEST}`);
console.log(`source  : ${RELEASE_BASE}`);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function downloadSmall(url, f, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== f.bytes) throw new Error(`size ${buf.length} != ${f.bytes}`);
      fs.writeFileSync(dest, buf);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  [retry ${attempt}] ${e.message} (${stamp()})`);
      await sleep(Math.min(1500 * attempt, MAX_WAIT_MS));
    }
  }
  throw lastErr;
}

async function downloadQueued(url, f, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const sidecar = part + '.chunks.json';

  // NOTE: must NOT open with 'a' (O_APPEND ignores the position argument).
  const fd = fs.existsSync(part) ? fs.openSync(part, 'r+') : fs.openSync(part, 'w+');

  const totalChunks = Math.ceil(f.bytes / CHUNK);
  let done = new Set();
  try {
    const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (Array.isArray(saved?.done)) done = new Set(saved.done.filter((i) => Number.isInteger(i) && i >= 0 && i < totalChunks));
  } catch {}

  let doneBytes = 0;
  for (const i of done) doneBytes += Math.min(CHUNK, f.bytes - i * CHUNK);

  const pending = [];
  for (let i = 0; i < totalChunks; i++) if (!done.has(i)) pending.push(i);

  const t0 = Date.now();
  let lastPrint = 0;
  const saveSidecar = () => {
    try {
      fs.writeFileSync(sidecar, JSON.stringify({ done: [...done].sort((a, b) => a - b) }));
    } catch {}
  };
  const print = (force) => {
    const now = Date.now();
    if (!force && now - lastPrint < 15_000) return;
    lastPrint = now;
    const mins = Math.max((now - t0) / 60000, 0.05);
    const rate = doneBytes / 1e6 / mins;
    const eta = rate > 0.05 ? ((f.bytes - doneBytes) / 1e6 / rate).toFixed(1) : '?';
    console.log(`[${stamp()}] ${MB(doneBytes)}/${MB(f.bytes)} MB  ${rate.toFixed(1)} MB/min  eta ~${eta} min  (${done.size}/${totalChunks} chunks)`);
  };

  console.log(`[resume] ${done.size}/${totalChunks} chunks already done (${MB(doneBytes)} MB); ${pending.length} to fetch with ${WORKERS} workers`);
  print(true);

  let cursor = 0;
  let stopped = false;
  let failErr = null;

  async function worker(n) {
    while (!stopped) {
      const qi = cursor++;
      if (qi >= pending.length) return;
      const ci = pending[qi];
      const start = ci * CHUNK;
      const end = Math.min(start + CHUNK, f.bytes) - 1;
      let ok = false;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_TRIES && !ok; attempt++) {
        if (stopped) return;
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=${start}-${end}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
          });
          if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== end - start + 1) throw new Error(`short ${buf.length}/${end - start + 1}`);
          fs.writeSync(fd, buf, 0, buf.length, start);
          done.add(ci);
          doneBytes += buf.length;
          saveSidecar();
          ok = true;
        } catch (e) {
          lastErr = e;
          if (attempt === 1 || attempt % 10 === 0) {
            console.log(`  [w${n} chunk${ci} retry ${attempt}] ${e.message} (${stamp()})`);
          }
          await sleep(Math.min(800 * attempt, MAX_WAIT_MS));
        }
      }
      if (!ok) {
        stopped = true;
        failErr = new Error(`chunk ${ci} at ${MB(start)} MB failed after ${MAX_TRIES} tries: ${lastErr?.message}`);
        return;
      }
      print(false);
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, (_, n) => worker(n)));
  if (failErr) {
    fs.closeSync(fd); // keep part + sidecar for resume
    throw failErr;
  }

  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const sz = fs.statSync(part).size;
  if (sz !== f.bytes) throw new Error(`final size ${sz} != ${f.bytes}`);
  fs.rmSync(sidecar, { force: true });
  fs.renameSync(part, dest);
  print(true);
}

let failures = 0;
for (const f of files) {
  const dest = path.join(DEST, f.path);
  const url = `${RELEASE_BASE}/${f.path.split('/').join('__')}`;

  try {
    if (fs.existsSync(dest) && (await sha256File(dest)) === f.sha256) {
      console.log(`[ok] ${f.path} (cached)`);
      continue;
    }
    if (fs.existsSync(dest)) { console.log(`[redo] ${f.path} (sha mismatch)`); fs.rmSync(dest); }

    console.log(`[get] ${f.path} (${MB(f.bytes)} MB)`);
    if (f.bytes <= SMALL_CUTOFF) await downloadSmall(url, f, dest);
    else await downloadQueued(url, f, dest);
    const got = await sha256File(dest);
    if (got !== f.sha256) throw new Error(`sha256 mismatch (got ${got.slice(0, 12)}..., want ${f.sha256.slice(0, 12)}...)`);
    console.log(`[done] ${f.path} sha256 verified`);
  } catch (e) {
    failures++;
    console.log(`[FAIL] ${f.path}: ${e.message}`);
  }
}

console.log(failures === 0 ? 'ALL FILES OK' : `${failures} file(s) failed`);
process.exit(failures === 0 ? 0 : 1);
