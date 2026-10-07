# Patches

`laya_router.threading-singleinstance-cors.patch` is a **reference** unified diff
showing exactly what `../scripts/patch-laya-router.py` changes inside
`service/laya_router.py`:

| hunk | change |
| --- | --- |
| 1 | add `_claim_single_instance()` (Windows named-mutex single-instance gate) |
| 2 | `HTTPServer` -> `ThreadingHTTPServer` + `_judge_lock`/`_log_lock` + call the gate |
| 3 | wrap Torch inference in `_judge_lock` |
| 4 | wrap `judge_log` writes in `_log_lock` |
| 5 | swap the server class at the bottom |
| 6 | allow the `dsh-app://` Origin in `_cors()` |

It is kept for review/audit only. **Do not apply it with `git apply`** to an
arbitrary checkout — upstream line numbers drift between releases and the patch
would fail. Use the patcher, which matches on exact text anchors and reports
clearly when upstream changed:

```powershell
python ..\scripts\patch-laya-router.py "<svc>\service\laya_router.py"
python ..\scripts\patch-laya-router.py "<svc>\service\laya_router.py" --check
```

The patcher is idempotent and safe to re-run after every `npm i -g` upgrade.
