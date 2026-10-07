#!/usr/bin/env python3
"""Deploy newer VC++ runtime DLLs next to python.exe and into torch\\lib.

Fixes torch `WinError 1114` / `Error loading c10.dll` caused by an old *system* VC
runtime (e.g. 14.29) when torch 2.14 needs >= 14.40. Per-application deployment --
no admin needed.

Targets (both, deliberately):
  1. <venv>\\Scripts  -- python.exe's own vcruntime140 search starts at the app dir
  2. <venv>\\Lib\\site-packages\\torch\\lib -- c10.dll's implicit deps search the
                        loading DLL's own dir first (CPython loads extensions with
                        LOAD_WITH_ALTERED_SEARCH_PATH)

Steps to get the wheel:
    <venv>\\Scripts\\python.exe -m pip download msvc-runtime --no-deps -d <some dir>

Usage:
    python msvc-fix.py --wheel <msvc_runtime-*.whl> --venv <path-to-venv>
"""
import argparse
import os
import shutil
import sys
import zipfile
from datetime import datetime


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheel", required=True, help="path to msvc_runtime-*.whl")
    ap.add_argument("--venv", required=True, help="path to the venv (contains Scripts/ and Lib/)")
    args = ap.parse_args()

    if not os.path.isfile(args.wheel):
        print("wheel not found: %s" % args.wheel, file=sys.stderr)
        return 1

    script_dir = os.path.join(args.venv, "Scripts")
    torch_lib = os.path.join(args.venv, "Lib", "site-packages", "torch", "lib")
    dests = [script_dir, torch_lib]

    for d in dests:
        if not os.path.isdir(d):
            print("warning: target dir does not exist (will create): %s" % d)

    stamp = datetime.now().strftime("%Y%m%d")
    z = zipfile.ZipFile(args.wheel)
    dlls = [i for i in z.infolist() if i.filename.lower().endswith(".dll")]
    print("DLLs found in wheel:")
    for i in dlls:
        print("   %s (%d bytes)" % (i.filename, i.file_size))
    if not dlls:
        print("no DLLs in wheel -- wrong file?", file=sys.stderr)
        return 1

    for i in dlls:
        name = os.path.basename(i.filename)
        if not name:
            continue
        data = z.read(i)
        for d in dests:
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, name)
            if os.path.exists(p):
                bak = "%s.bak-%s" % (p, stamp)
                if not os.path.exists(bak):
                    shutil.copy2(p, bak)
                    print("backed up existing: %s" % p)
            with open(p, "wb") as f:
                f.write(data)
        print("deployed: %s" % name)

    print("DONE -- verify in a NEW process:  %s -c \"import torch; print(torch.__version__)\""
          % os.path.join(script_dir, "python.exe"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
