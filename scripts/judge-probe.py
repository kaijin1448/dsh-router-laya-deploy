#!/usr/bin/env python3
"""Probe the Laya judge service and print the verdict.

This sends UTF-8 bytes explicitly -- PowerShell 5.1's `Invoke-RestMethod -Body <string>`
posts Chinese in the local code page, so the judge sees `?` and you draw a false
conclusion. Doing it from Python sidesteps that trap.

Usage:
    python judge-probe.py [task] [--prev-tier low] [--prev-task "..."] [--url ...]
    python judge-probe.py --health
"""
import argparse
import json
import sys
import urllib.request
import urllib.error

DEFAULT_URL = "http://127.0.0.1:8765"


def get(url, timeout=10):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post(url, payload, timeout=30):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task", nargs="?", default="分析这个并发 bug 的根因，并给出跨模块的重构方案")
    ap.add_argument("--prev-tier", default=None)
    ap.add_argument("--prev-task", default=None)
    ap.add_argument("--session-id", default="probe")
    ap.add_argument("--base", default=DEFAULT_URL)
    ap.add_argument("--health", action="store_true")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    try:
        if args.health:
            info = get(base + "/health")
            print(json.dumps(info, ensure_ascii=False, indent=2))
            ok = info.get("protocol") == "finetuned"
            print("HEALTH:", "OK (finetuned)" if ok else "WRONG PROTOCOL")
            return 0 if ok else 1

        v = post(base + "/judge", {
            "task": args.task,
            "prev_tier": args.prev_tier,
            "prev_task": args.prev_task,
            "session_id": args.session_id,
        })
        print(json.dumps(v, ensure_ascii=False, indent=2))
        if v.get("error"):
            print("JUDGE ERROR:", v["error"], file=sys.stderr)
            return 1
        print("TIER=%s  by=%s  ms=%s" % (v.get("tier"), v.get("triggered_by"), v.get("ms")))
        return 0
    except urllib.error.URLError as e:
        print("judge unreachable: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
