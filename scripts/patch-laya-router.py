#!/usr/bin/env python3
"""Idempotent patcher for dsh-router-laya's `service/laya_router.py`.

Applies the three local forks this package needs, each independently and only if
missing, so it is safe to run repeatedly and after any `npm i -g` upgrade:

  [gate]      _claim_single_instance() -- Windows named-mutex single-instance gate.
              Must run BEFORE the 842 MB checkpoint load, otherwise a duplicate
              process still eats ~1 GB. (`HTTPServer`'s default SO_REUSEADDR means
              EADDRINUSE does NOT dedupe on Windows.)

  [thread]    HTTPServer -> ThreadingHTTPServer, plus _judge_lock (serializes the
              non-thread-safe Torch inference) and _log_lock (guards judge_log).
              Without it, concurrent /judge requests queue on one socket and the
              2nd/3rd blow past the client timeout -- the "concurrent requests
              block each other, judging times out" bug.

  [cors]      allow Origin `dsh-app://` so the DSH Electron desktop tier chip can
              read GET /state. Not a wildcard: ordinary web origins still blocked.

Usage:
    python patch-laya-router.py <path-to-laya_router.py> [--check]

Exit codes: 0 = ok (patched or already current); 2 = a patch anchor was not found
(upstream changed -- inspect manually); 1 = I/O error.
"""
import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path

MARK_GATE = "_claim_single_instance"
MARK_THREAD = "ThreadingHTTPServer"
MARK_CORS = 'startswith("dsh-app://")'

GATE_FUNC = '''def _claim_single_instance(port):
    """Windows named-mutex gate: only one router may own this port.

    HTTPServer defaults to allow_reuse_address, so a second process CAN bind the
    same port (EADDRINUSE does not dedupe on Windows); the OC plugin's fail-safe
    would then stack several 842 MB model instances -> memory collapses -> judging
    times out -> more spawns, a positive feedback loop. Must run BEFORE the
    checkpoint load, otherwise the duplicate still eats memory.
    """
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.restype = wintypes.HANDLE
    k.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    ctypes.set_last_error(0)
    h = k.CreateMutexW(None, False, "dsh-router-laya-service-%d" % int(port))  # no backslash in the name
    if not h:
        return None
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        print("[single-instance] another router already owns 127.0.0.1:%d -- exiting" % int(port),
              file=sys.stderr, flush=True)
        sys.exit(0)
    return h  # held while the process lives; released by the kernel on exit


'''

# --- patch anchors (exact upstream text; each must occur exactly once) -------------
OLD_IMPORT = "    from http.server import HTTPServer, BaseHTTPRequestHandler"
NEW_IMPORT = '''    import threading
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

    # Threaded HTTP: concurrent /judge no longer queue on one socket. Torch
    # inference stays serialized by _judge_lock (the model is not thread-safe).
    _judge_lock = threading.Lock()
    _log_lock = threading.Lock()
    _instance_guard = _claim_single_instance(port)  # before the checkpoint load'''

OLD_JUDGE_CALL = '''            try:
                if protocol == "finetuned":
                    j = ft_judge(agent, task, prev_tier=prev_tier, prev_task=prev_task)
                else:
                    j = decide(agent, task)
                j["id"] = body.get("id")'''
NEW_JUDGE_CALL = '''            try:
                if protocol == "finetuned":
                    with _judge_lock:
                        j = ft_judge(agent, task, prev_tier=prev_tier, prev_task=prev_task)
                else:
                    with _judge_lock:
                        j = decide(agent, task)
                j["id"] = body.get("id")'''

OLD_LOG = '''            if j.get("tier"):
                from collections import deque
                log = judge_log.setdefault(session_id, deque(maxlen=20))
                log.append({
                    "ts": time.time(),
                    "tier": j["tier"],
                    "triggered_by": j.get("triggered_by", ""),
                    "regenerate": bool(j.get("regenerate")),
                    "ms": j.get("ms"),
                    "task": (task or "")[:60],
                })'''
NEW_LOG = '''            if j.get("tier"):
                from collections import deque
                with _log_lock:
                    log = judge_log.setdefault(session_id, deque(maxlen=20))
                    log.append({
                        "ts": time.time(),
                        "tier": j["tier"],
                        "triggered_by": j.get("triggered_by", ""),
                        "regenerate": bool(j.get("regenerate")),
                        "ms": j.get("ms"),
                        "task": (task or "")[:60],
                    })'''

OLD_SERVER = '    server = HTTPServer(("127.0.0.1", port), Handler)'
NEW_SERVER = '    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)'

OLD_HTTP_SERVE_DEF = "def http_serve(port=8765):"

OLD_CORS = '''            allowed = origin is not None and (
                origin.startswith("http://127.0.0.1:")
                or origin.startswith("http://localhost:")
            )'''
NEW_CORS = '''            allowed = origin is not None and (
                origin.startswith("http://127.0.0.1:")
                or origin.startswith("http://localhost:")
                # LOCAL PATCH: the DSH Electron desktop serves its UI from the custom
                # scheme dsh-app://; without this the tier chip can never read /state.
                or origin.startswith("dsh-app://")
            )'''


def replace_once(src, old, new, label):
    """Assert `old` occurs exactly once, then replace. Aborts loudly on drift."""
    n = src.count(old)
    if n != 1:
        print(
            "[%s] anchor not found exactly once (found %d). Upstream laya_router.py "
            "changed -- patch it manually (see docs/router-laya-install-guide.md)." % (label, n),
            file=sys.stderr,
        )
        sys.exit(2)
    return src.replace(old, new)


def patch_threading(src):
    src = replace_once(src, OLD_IMPORT, NEW_IMPORT, "thread/import")
    src = replace_once(src, OLD_JUDGE_CALL, NEW_JUDGE_CALL, "thread/judge")
    src = replace_once(src, OLD_LOG, NEW_LOG, "thread/log")
    src = replace_once(src, OLD_SERVER, NEW_SERVER, "thread/server")
    return src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path", help="path to service/laya_router.py")
    ap.add_argument("--check", action="store_true",
                    help="report patch status only; do not write")
    ap.add_argument("--no-backup", action="store_true")
    args = ap.parse_args()

    path = Path(args.path)
    if not path.is_file():
        print("not a file: %s" % path, file=sys.stderr)
        return 1

    src = path.read_text(encoding="utf-8")
    report = {}

    has_gate = MARK_GATE in src
    has_thread = MARK_THREAD in src
    has_cors = MARK_CORS in src

    if args.check:
        print("gate   : %s" % ("present" if has_gate else "MISSING"))
        print("thread : %s" % ("present" if has_thread else "MISSING"))
        print("cors   : %s" % ("present" if has_cors else "MISSING"))
        return 0

    out = src

    # 1) gate must exist before threading references it
    if not has_gate:
        out = replace_once(out, OLD_HTTP_SERVE_DEF,
                           GATE_FUNC + OLD_HTTP_SERVE_DEF, "gate")
        report["gate"] = "applied"
    else:
        report["gate"] = "skip"

    # 2) threading (also consumes the gate)
    if not has_thread:
        out = patch_threading(out)
        report["thread"] = "applied"
    else:
        report["thread"] = "skip"
        if not has_gate:
            # threading marker present but gate missing -> inconsistent half-patch
            raise SystemExit("[inconsistent] ThreadingHTTPServer present but "
                             "_claim_single_instance missing -- inspect manually")

    # 3) CORS
    if not has_cors:
        out = replace_once(out, OLD_CORS, NEW_CORS, "cors")
        report["cors"] = "applied"
    else:
        report["cors"] = "skip"

    if out == src:
        print("already fully patched -- nothing to do")
        return 0

    # syntax check before writing
    import ast
    try:
        ast.parse(out)
    except SyntaxError as e:
        print("patched source has a syntax error (%s) -- NOT written" % e, file=sys.stderr)
        return 2

    if not args.no_backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = path.with_name(path.name + ".bak-patch-%s" % stamp)
        shutil.copy2(path, bak)
        print("backup: %s" % bak)

    path.write_text(out, encoding="utf-8")
    for k in ("gate", "thread", "cors"):
        print("  %-7s %s" % (k, report[k]))
    print("patched: %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
