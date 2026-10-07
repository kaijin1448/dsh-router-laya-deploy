# dsh-router-laya 安装 / 移植指南

> 本指南来自 2026-10-06 的一次完整落地：在一台 Windows 机器上把 dsh-router-laya 装进 **DeepSeek Harness（DSH）**，并把它移植给 **OpenCode（OC）**。
> 文中所有结论都经过实测；踩到的坑、绕法、验收命令都写进来了。
> 目标读者：在本机/新机上重做这套配置的人（或 agent）。
>
> **2026-10-07 更新**：① 补上 OC 侧判定服务的**自启动 / 冷启动 / 跨 harness 共享**语义（§4.2）；② 新增**成本安全**一节（§4.6）—— OC 移植插件不会改 provider/model，而 DSH 内置路由表**会**走官方计费，故 §3.2 的 `tiers` 覆盖改为必写；③ 补上端口与健康检查的**正确验法**（DSH 沙箱里 `Get-NetTCPConnection`/WMI 是假阴性）；④ 新增**附录 E：可选预热**（登录计划任务，消掉冷启动窗口）。
> **2026-10-07 二次更新（机器 B：OC 端零到一落地）**：在第二台机器（6 核 CPU + 受 DLP 管控的环境，下称"机器 B"）从零装通 OC 侧全链路，补充四类实战修正：
> ⑤ **安装期三个硬坑**（§2.2 / §2.6 / 附录 F）：npm 全局包在 WinGet 深路径 → 包内建 venv 触发 `WinError 206`（venv 挪短路径）；DLP 把 `requirements.lock.txt` 加密改名 `.IPGSD`（从 npm tarball 提取原文）；系统 VC 运行库过旧 → torch `c10.dll` 初始化失败 `WinError 1114`（每应用部署新版 runtime，免管理员）。
> ⑥ **权重下载提速**（§2.3 / 附录 A）：单流 ~3.7 MB/min → 6 并发抢块 ~43 MB/min（12 倍，19 分钟下完 842 MB）。
> ⑦ **插件目录与导出形式以本机为准**（§4.1）：机器 B 的插件目录是 `~/.config/opencode/plugin/`（**单数**，原文的 `plugins/` 复数来自机器 A）；导出用 `export default`。附录 C 已换成含 **autostart** 的完整版（修正原文"§4.2 描述 autostart、附录 C 快照却没有"的不一致）。
> ⑧ **判定延迟/超时必须按机器调**（§4.5 / 附录 D）：机器 B 判定 **4–9 s/轮**（机器 A 1.4 s），插件默认 `ROUTER_LAYA_TIMEOUT_MS=6000` **会永远超时**，必须调大（本次 20000）。另：`provider/example-model` **会**上报 reasoning token（与本指南"deepseek 系恒为 0"不同），可用于 A/B 自验。
> 落地实录与归档区见**附录 G**。
> **2026-10-07 三次更新（机器 B：DSH 端接入落地）**：在同一台机器 B 上把 **DSH Desktop 的 `web` profile** 接上同一个判定大脑。§3 整节按实测重写，并修正两处会让人踩坑（一处会直接吃光内存）的旧结论：
> ⑨ **DSH 侧没有 `dsh` CLI**（§3.1）：包不能靠 `dsh plugin add` 进 profile，改用包内 `install.mjs` 复制进 profile 的 `node_modules` + **手写插入行**；机器 B 的 DSH 家目录是 `%APPDATA%\dsh-desktop\harness`（**没有** `~/.dsh`），profile 是 `web`。§3.2 的 `tiers` 按本机注册的 provider 改（机器 B：`provider/example-model`）。
> ⑩ **「重复启动会 EADDRINUSE 自然去重」在 Windows 上不成立**（§4.2 / §6）：`HTTPServer` 默认 `SO_REUSEADDR`，第二个自动拉起能绑同一端口。OC 插件的 fail-safe 拉起叠出 **4 个 842 MB 常驻实例**，可用内存掉到 1.0 GB → 判定超时（>20 s）→ 又触发拉起，正反馈。修法是服务端加**命名互斥体单实例闸门**（在加载 checkpoint 之前生效）。
> ⑪ **档位芯片要刷新窗口才出现**（§3.4）：Web 启动图是页面加载时组合的，热挂载插件之后旧页面看不到芯片；另外热插入后的第一次 `/router-laya/mode` 读数可能是 `manual`（瞬时态），重新 apply 后稳定为 `auto`。
> DSH 端落地实录见**附录 H**。


---

## 0. 先搞清三个部件

| 部件 | 是什么 | 归谁 |
| --- | --- | --- |
| **判定大脑** | Python 服务 + 842 MB 微调分类模型（Laya 7 问），HTTP `127.0.0.1:8765` | **两个 harness 共用，装一次** |
| **DSH 接入** | npm bundle（host 半边走 Cordis patch）+ 浏览器芯片 | DSH 专用 |
| **OC 接入** | 一个本地 TS/JS 插件（`chat.params` 钩子） | OC 专用 |

接口（自实现插件时的唯一契约）：

```
POST /judge   {"task","prev_tier","prev_task","session_id"}
           -> {"tier":"low|high|max","triggered_by","base_tier","labels","probs","ms","regenerate"}
GET  /health  -> {"protocol":"finetuned","model":"<权重目录>","status":"ok"}
GET  /state   -> {"sessions":{ "<session_id>":[最近 20 条判定] },"protocol":"finetuned"}
```

判定**只看三样**：本轮消息文本、上轮档位、上轮文本。**不读对话历史**、不读文件/代码/工具结果；`session_id` 只用于 `/state` 展示。
其中上轮信息只服务两件事：①「继续」这类短指令保持上轮档位；② 检测到重试就沿 `low→high→max` 升一级。

---

## 1. 前置检查

```powershell
python --version          # 需要 >= 3.10（3.12 最稳；3.13 实测可用）
node --version            # 需要 >= 18
Get-PSDrive C | % { [math]::Round($_.Free/1GB,1) }   # 需要 ~2 GB（venv+权重实测 1.58 GB）
```

---

## 2. 判定服务（装一次，DSH 与 OC 共用）

### 2.1 安装

```powershell
npm i -g dsh-router-laya        # 全局副本：venv 和权重都落在它里面
```

包目录（下文记作 `<svc>`）：

```
%APPDATA%\npm\node_modules\dsh-router-laya
├─ .venv-router\        # Python venv（setup 建）
├─ weights\model\       # 842 MB checkpoint（setup 下）
├─ service\             # laya_router.py / finetuned_judge.py / intent_parser.py / laya\
└─ bin\setup.mjs        # 引导脚本
```

### 2.2 建 venv（**必须手动**，因为 setup 有个 bug）

`bin/setup.mjs` 第 122 行会崩：`TypeError: probe.base is not iterable` ——
`probePython()` 返回的对象没有 `base` 字段，但 `stepA()` 会去展开它。**首次运行必崩**，所以先手动把 venv 建好，setup 就会跳过那段：

```powershell
$svc = "$env:APPDATA\npm\node_modules\dsh-router-laya"
python -m venv "$svc\.venv-router"
& "$svc\.venv-router\Scripts\python.exe" -m pip install -r "$svc\service\requirements.lock.txt"
```

> 依赖：`torch==2.14.0+cpu`（走 PyTorch CPU 源，约 124 MB）、`transformers`、`safetensors`、`numpy` 等。
**机器 B 实测补充（2026-10-07）**：

- `probe.base is not iterable` **在 2.2.0 仍然存在**（`probePython()` 返回 `{version, exe, major, minor}` 没有 `base`，`stepA()` 第 122 行却展开 `...probe.base`）——"手动建 venv"的结论继续有效。
- **venv 位置要短**：npm 全局 prefix 若在深路径（本机 WinGet Node：`…\WinGet\Packages\OpenJS.NodeJS.LTS_…\node-v24.19.0-win-x64`，约 120 字符），包内建 venv 会让 pip 装 sympy 等深层包报 `[WinError 206] 文件名或扩展名太长`（突破 MAX_PATH 260）。对策：venv 放**短路径**（本次 `C:\Users\<user>\.dsh-router-laya\venv`），一切引用用全路径；`start_router.ps1` 通过 `$env:LAYA_PYTHON` 找到它（见 §2.4）。
- **DLP 环境**（天锐绿盾 / IP-guard 等透明加密）：`npm i -g` 解包后 `service/requirements.lock.txt` 可能被加密并改名 `requirements.lock.txt.IPGSD`（首字节 `%TSD-Header`），PS/python 都读不到原文。对策——从 npm tarball 提原文：

```
npm pack dsh-router-laya --pack-destination $env:TEMP
# python 读 tar 成员 package/service/requirements.lock.txt -> 写成 requirements.lock.md
#（.md 不在加密名单；pip 不挑扩展名）：
#   venv\Scripts\python.exe -m pip install -r service\requirements.lock.md
```


### 2.3 取 846 MB 权重

**先别直接用 `node weights/fetch.mjs`** —— 在这台机器的网络上单流会在大约 10 MB 处被掐断（`terminated`）。
而且 HF 兜底也没用：`huggingface.co` 返回 **401**、`hf-mirror.com` 返回 **404**，只有 GitHub Release 有货。

用**分块 Range + 逐块重试**的脚本（全文见附录 A）：

```powershell
node "$env:TEMP\fetch-laya-chunked.mjs"
```

- 目标：`<svc>\weights\model\model.safetensors`，**842,609,220 字节**
- sha256 必须等于 `f14cf869ebc4d0adab3102627a92f0b677678d05e5353e3e55dc11f4fc6172de`（脚本自己校验）
- 实测 2–6 MB/s，约 3–7 分钟

> 也可以反复跑官方的 `node weights/fetch.mjs`：它按 `.part` 续传，每次推进约 10 MB —— 能成，但要跑几十次，不推荐。
**机器 B 网络实测（2026-10-07）**：

- 源可达性同样是"只有 GitHub Release 能用"：`huggingface.co` 连接被重置、`hf-mirror.com` 404；github.com 能通但**间歇抽风**（连续几个请求连接超时，随后又通）。
- 单流实测仅 ~3.7 MB/min（0.06 MB/s）→ 换**并发分块**：2 MiB 块 + 6 worker 抢队列 + 位置写 + `chunks.json` 断点，实测 **~43 MB/min（0.7 MB/s，12 倍）**，19 分钟下完（脚本见附录 A 的 v3 版）。
- 并发数怎么定：先并行跑 4 条 `curl -r` 测**总吞吐**（本机单连接方差极大：29 KB/s ~ 573 KB/s），4 条总和远大于单条再上并发。


### 2.4 起服务并验收

```powershell
node "$svc\bin\setup.mjs" setup --skip-weights    # step a 跳过、c 打印配置行、d 起服务
curl.exe http://127.0.0.1:8765/health             # 期待 protocol=finetuned
```

冷启动约 **40 秒**（载入 842 MB checkpoint），之后常驻内存约 **1.9 GB**。

**如果 step d 报 `start_router.ps1 is not recognized`**：那是杀软/安全策略把 `service\start_router.ps1` 删了（`.sh` 孪生文件不会）。这个文件**不是必需的** —— DSH 插件与 OC 插件都会直接用 python 起服务。手动等价命令：

```powershell
& "$svc\.venv-router\Scripts\python.exe" "$svc\service\laya_router.py" --http --port 8765
```

### 2.5 随手测一下判定是否正常

```powershell
$body = '{"task":"分析这个并发 bug 的根因，并给出跨模块的重构方案","prev_tier":null,"prev_task":null,"session_id":"probe"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/judge -ContentType application/json -Body $body |
  Select-Object tier, triggered_by, ms          # 期待 max / laya / ~1.4s
```

### 2.6 安装期头号坑：torch `WinError 1114`（系统 VC 运行库过旧）

**症状**：服务起不来，`%TEMP%\laya-router-service.err.log` 尾部：

```
OSError: [WinError 1114] 动态链接库(DLL)初始化例程失败。
Error loading "…\torch\lib\c10.dll" or one of its dependencies.
```

**快速确诊两步**（分清"文件坏"还是"初始化失败"）：

1. datafile 模式能加载 ⇒ PE 完好，挂在 DllMain：
   `python -c "import ctypes; k=ctypes.WinDLL('kernel32',use_last_error=True); print(k.LoadLibraryExW(r'…\torch\lib\c10.dll',None,2))"`（非 0 = 映射成功）
2. `pefile` 解析 c10.dll 导入表：依赖全在系统（`MSVCP140 / VCRUNTIME140 / VCRUNTIME140_1 / dbghelp / api-ms-win-crt-*`）⇒ 不是缺文件，是**版本太旧**（机器 B 系统还是 2021 年的 14.29，torch 2.14 需要 ≥14.40 的 `msvcp140`）。

**修复（免管理员）：每应用部署新版 runtime**——`pip download msvc-runtime --no-deps` 拿到的 wheel 里就有整套（机器 B 用的 14.44）：

1. 解包 wheel，把 `msvcp140*.dll / vcruntime140*.dll / concrt140.dll` 等复制到 **`<venv>\Scripts\`**（python.exe 所在"应用目录"）**和** **`<svc>\torch\lib\`**（CPython 以 `LOAD_WITH_ALTERED_SEARCH_PATH` 加载扩展，c10 的隐式依赖优先搜它自己的目录）；
2. **新进程**里验证：`<venv>\Scripts\python.exe -c "import torch; print(torch.__version__)"`；
3. 脚本全文见**附录 F**（`msvc-fix.py`）。

> 为什么两个目录都要放：`vcruntime140` 在 python 启动时就被加载了，只放 `torch\lib` 改不了它——但 `venv\Scripts` 是 python.exe 自身依赖搜索的第一站，从源头换掉；`msvcp140` 此时还没被任何模块加载，`torch\lib` 的新版即可命中。


---

## 3. DSH 侧接入

### 3.1 装 loader 副本

**先判本机形态**——两条路互斥，走错会出现「重复 loader id」或「插件根本没挂上」：

```powershell
Get-Command dsh                       # 有 CLI → 走 (a)；没有 → 走 (b)
$env:DSH_HOME; $env:DSH_PROFILE_DIR; $env:DSH_PROFILE   # 运行中的 harness 会自报家目录/profile（机器 B：web）
```

**(a) 有 `dsh` CLI（原文机器 A 的路径）**

```powershell
dsh plugin --profile <profile> add dsh-router-laya
```

它做两件事：把包放进 `<DSH_HOME>/profiles/<profile>/node_modules/`，并把 `dsh-router-laya` 写进 profile `package.json` 的 `dsh.profile.bundles`（于是包自带的 `cordis.patch.yml` 会自动 insert 一行 `router-laya`）。
⚠️ 这时**绝对不要**再手写 `- insert: [- id: router-laya …]` —— 重复 loader id 会让 profile **起不来**（作者在包里专门警示过）；要改配置只用 §3.2 的 id-targeted 覆盖写法。

**(b) 没有 CLI（机器 B 实测路径：DSH Desktop 的 `web` profile）**

DSH Desktop 的 profile 由 Electron 托管，命令行进不去；用包自带的 `install.mjs` 把 4 个文件复制进 profile 的 `node_modules`（`@deepseek-ai/schemastery` 这类 peer 由 Desktop 的 host-module-fallback 兜底解析），**不动** `dsh.profile.bundles`，配置写在 §3.2 的**手写插入行**里：

```powershell
$svc  = "$((npm prefix -g))\node_modules\dsh-router-laya"      # 机器 B 在 WinGet Node 深路径下
$prof = "$env:APPDATA\dsh-desktop\harness\profiles\web"        # 等于 $env:DSH_PROFILE_DIR
node "$svc\install.mjs" "$prof\node_modules"
```

判据（两条路都适用）：`Select-String -Path "$prof\cordis.patch.yml" -Pattern 'id: router-laya'` 只应命中**一处**插入行；`dsh.profile.bundles` 里**不应**出现 `dsh-router-laya`（走 (b) 时）。

> 📌 profile 的 `node_modules` 由 pnpm 管理：走 (b) 复制的这个未登记副本，可能在后续 `pnpm install` / 插件市场装包时被清掉（芯片突然消失）。重跑上面那条 `install.mjs` 即可（幂等）。

### 3.2 写 profile 补丁层

编辑 `<DSH_HOME>\profiles\<profile>\cordis.patch.yml`（机器 B：`%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`），追加：

```yaml
# 走 3.1(b)（没有 dsh CLI）时用手写插入行：id 必须叫 router-laya，name 必须是包名。
- insert:
    - id: router-laya
      name: 'dsh-router-laya'
      config:
        auto: true
        mode: auto
        autoStart: true
        servicePython: '<venv>\Scripts\python.exe'      # 机器 B：C:\Users\<user>\.dsh-router-laya\venv\Scripts\python.exe
        serviceScript: '<svc>\service\laya_router.py'   # <svc> = npm prefix -g + \node_modules\dsh-router-laya
        tiers:                       # ← 必写！否则走 DeepSeek 官方通道计费（见下）
          low:      { provider: example-provider, model: example-model, effort: low }
          high:     { provider: example-provider, model: example-model, effort: high }
          max:      { provider: example-provider, model: example-model, effort: max }
          fallback: { provider: example-provider, model: example-model, effort: low }
        routes:                      # judge 模式用（顺手覆盖掉未注册的 qwen 槽位）
          easy:     { provider: example-provider, model: example-model, effort: low }
          medium:   { provider: example-provider, model: example-model, effort: low }
          hard:     { provider: example-provider, model: example-model, effort: high }
          fallback: { provider: example-provider, model: example-model, effort: low }
```

> **走 3.1(a)（有 `dsh` CLI，包已进 `dsh.profile.bundles`）时，把上面 `- insert:` 与 `- id: router-laya` 两行换成 id-targeted 覆盖写法**（其余 `config:` 原样）：
>
> ```yaml
> - id: router-laya
>   name: 'dsh-router-laya'
>   config:
>     …同上…
> ```
>
> 二者**只能选一种**：包自带 patch 已经会插入 `router-laya`，你再手写一个 insert 就是重复 id。

**`provider` / `model` 以本机 `cordis.patch.yml` 里已注册的为准**：机器 A 是 `example-provider` / `example-model`；机器 B 是内网网关 provider `example-provider` / `example-model`（`reasoningEfforts: off/low/high/max`）。先看本机 profile 里 `- id: llm-pi-ai` 那段的 provider 名与模型 id，别照抄别的机器。

加载器会**热应用**它（无需重启）：插件随即自己 `detach` 拉起判定服务（`harness.log` 里出现 `[router-laya] auto tier per turn; tiers low=… high=… max=…` 即挂载成功）。

> 🔴 **`tiers` 必须覆盖，否则扣的是 DeepSeek 官方余额。**
> 插件内置的 `TIER_TABLE`（**auto 模式实际使用**）和 `ROUTE_TABLE`（judge 模式）里，`low/high/max/fallback` **全部指向 `deepseek-official`** —— 那是 DSH 的官方通道，按你登录的 DeepSeek 账号结算；`hard` 还指向未注册的 `qwen-token-plan-cn`。
> 插件是**合并**而非替换（`const tiers = { ...TIER_TABLE, ...(cfg.tiers || {}) }`），所以把四个键给全，就没有任何路径会落到官方通道。
> 档位值须在该 provider 的 `reasoningEfforts` 白名单内：机器 A 的 `example-provider` 有 `low/medium/high/xhigh/max`、**没有 `off`/`none`**（发 `none` 会 400）；机器 B 的 `example-provider` 有 `off/low/high/max`。
> 只开 OC 的话**没有这个问题** —— 见 §4.6。

### 3.3 芯片读不到数据？打 CORS 补丁（**桌面端必做**）

**症状**：输入栏芯片一直显示 `AUTO · 待判定`（或 `离线`），但 `/health`、`/judge` 一切正常。

**根因**：桌面端 GUI 的页面 Origin 是 Electron 自定义协议 **`dsh-app://app`**，而 `service/laya_router.py` 的 `_cors()` 白名单只放行 `http://127.0.0.1:*` 和 `http://localhost:*` —— 响应被浏览器按跨源规则丢弃，芯片永远读不到 `/state`。

**补丁**（不是通配符，普通网页依旧无权限）：

```python
# service/laya_router.py  →  Handler._cors()
allowed = origin is not None and (
    origin.startswith("http://127.0.0.1:")
    or origin.startswith("http://localhost:")
    or origin.startswith("dsh-app://")        # ← 加这一条（Electron 桌面端）
)
```

想确认实际 Origin，可以顺便加一行只打一次的诊断（**注意必须写 stderr**：插件 spawn 服务时 stdout 是 `ignore`，写 stdout 什么也看不到）：

```python
if origin is not None and origin not in seen_origins:
    seen_origins.add(origin)
    print(f"[cors] origin {origin!r} allowed={allowed}", file=sys.stderr, flush=True)
```

**机器 B 实测（2026-10-07）**：桌面端实际发出的 Origin 两种都出现过 —— `http://127.0.0.1:43129`（web 载体的页面）与 `dsh-app://app`（Electron 壳）。补丁后逐个验：

```powershell
foreach ($o in 'dsh-app://app','http://127.0.0.1:43129','https://evil.example') {
  (Invoke-WebRequest 'http://127.0.0.1:8765/state' -Headers @{ Origin = $o } -UseBasicParsing).Headers['Access-Control-Allow-Origin']
}
# 期待：前两个回显自身，第三个为空 —— 仍是白名单，不是通配符
```

> ⚠️ `_cors()` 是**服务进程里的代码**：改完文件必须**重启判定服务**才生效（先 `netstat -ano | findstr :8765` 找到监听者杀掉，再由插件 / `start_router.ps1` 重新拉起）。只改文件不重启 = 没改。

### 3.4 验收

**(1) 服务层**

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health        # protocol 必须是 finetuned
netstat -ano | findstr :8765                          # 只应有 1 个 LISTENING（多实例问题见 §4.2）
```

**(2) 插件挂载层**（`harness.log`）

```powershell
Get-Content "$env:APPDATA\dsh-desktop\logs\harness.log" | Select-String '\[router-laya\]'
# 期待：auto tier per turn; tiers low=… high=… max=… fallback=…
#   ＋  judge service: already up / started (…python.exe)
```

**(3) 接口层** —— `/router-laya/mode` 是**同源路由**，端口就是本机 web 载体（机器 B `43129`，机器 A `19387`），token 在 `harness.log` 的 `dsh web:` 行里：

```powershell
$tok = (Get-Content "$env:APPDATA\dsh-desktop\logs\harness.log" |
        Select-String 'dsh web: http://127.0.0.1:\d+/\?token=' | Select-Object -Last 1).Line -replace '.*token=',''
Invoke-RestMethod "http://127.0.0.1:43129/router-laya/mode?token=$tok"    # 期待 {"mode":"auto","writable":true}
Invoke-RestMethod http://127.0.0.1:8765/state                             # 看到刚发那条消息的判定行 = 全链路通
```

**(4) 芯片层** —— 启动图里必须有这个包（新开/刷新窗口后生效）：

```powershell
(Invoke-WebRequest "http://127.0.0.1:43129/?token=$tok" -UseBasicParsing).Content -like '*dsh-router-laya/client.js*'
```

芯片文案对照：`离线` = 连不上服务；`待判定` = 连上了但本轮还没结果；`低/高/MAX` = 已路由。

> ⚠️ 三个容易误判的点（机器 B 实测）：
> 1. **刚挂载完不会立刻按文本判定**：任务文本是在 `agent/inbox/claimed` 时抓的；插件挂载前就已领取的那一轮没有文本，日志会出现 `turn N auto "(no task text captured)" -> judge unreachable -> fallback … effort=low`。**下一轮**才是真判定（`turn N auto "…" -> max (laya)`）。
> 2. **芯片要刷新窗口**：启动图（`__DSH_BOOT__`）是页面加载时组合的，热挂载的插件不会自己出现在已打开的旧页面里。
> 3. **热插入后的第一次 `mode` 读数可能是 `manual`**（瞬时态，路由会被 `isManual()` 挡住）：POST `{"mode":"auto"}`（或在芯片上点一下）即可；改一行配置让插件重新 apply 后读数稳定为 `auto`。

---

## 4. OpenCode 侧接入

判定大脑复用同一个 8765 服务，**不需要装 npm 的 loader 副本**。

### 4.1 放插件

把 `router-laya.js` 放到**本机的全局插件目录**（OC 启动时才加载 → 改完必须重启 OC）。

> ⚠️ **目录名与导出形式都以本机实际为准**（放错目录 = 插件静默不加载，日志里连 `init` 行都不会有）：
> - 目录：机器 A 是 `~/.config/opencode/plugins/`（复数）；**机器 B 实测是 `~/.config/opencode/plugin/`（单数）**。判定法：看现有插件的所在目录（如 `dir ~/.config/opencode/plugin*`）。
> - 导出：机器 B 的 opencode 用 `export default async ({ client }) => ({ …hooks })`（与该机既有插件一致）；机器 A 版是 named export。以本机既有插件写法为准。

```
~/.config/opencode/plugin/router-laya.js       # 全文见附录 C（含 autostart 的完整版）
```

### 4.2 判定服务由谁拉起（**OC 自启动，不依赖 DSH**）

OC 插件默认 `AUTOSTART`（`ROUTER_LAYA_AUTOSTART` 未设即视为开），两个触发点：

1. **插件加载时**（off the request path）：`void healthUp().then(up => { if (!up) startJudge() })`
2. **每轮请求时**：判定服务不可达 → 先 `startJudge()`，本轮走 fail-safe（保持你自己的模型配置，不乱降级）

```js
const SERVICE_PYTHON = process.env.ROUTER_LAYA_PYTHON ?? join(process.env.APPDATA, "npm","node_modules","dsh-router-laya",".venv-router","Scripts","python.exe")
const SERVICE_SCRIPT = process.env.ROUTER_LAYA_SCRIPT ?? join(process.env.APPDATA, "npm","node_modules","dsh-router-laya","service","laya_router.py")
const SPAWN_COOLDOWN_MS = 60 * 1000   // 拉起失败后 60 s 内不重试

const child = spawn(SERVICE_PYTHON, [SERVICE_SCRIPT, "--http", "--port", JUDGE_PORT], {
  detached: true, windowsHide: true, stdio: "ignore",
})
child.unref()
```

要点：

- **单实例、跨 harness 共享**：DSH 插件与 OC 插件用的是同一个 `127.0.0.1:8765`。⚠️ **「重复启动会 EADDRINUSE 自然去重」在 Windows 上不成立**（2026-10-07 机器 B 实测改正）：`HTTPServer` 默认 `allow_reuse_address = 1`（`SO_REUSEADDR`），第二个进程**能绑上同一端口**，连 `netstat` 都能看到多个 LISTENING —— 必须靠服务端**单实例闸门**兜底（下一段 + §6）。
- **detached + unref**：OC 退出后服务继续跑 → 通常一辈子只冷启动一次。
- **`stdio: "ignore"`**：由 OC 拉起时服务**不写日志**；只有 DSH 插件拉起才写 `%TEMP%\laya-router-service.log`（排查服务本身时注意这点）。
- **冷启动窗口**（约 40 s，慢时 3 min）：这段时间每轮都 fail-safe 丢档，日志会连续出现：

  ```
  judge down -> spawned: …python.exe …laya_router.py --http --port 8765
  judge unavailable (fetch failed) -- leaving the request untouched
  ```

  这是**预期行为**、不是插件失效；服务起来后自动恢复判定。想去掉这个窗口见**附录 E：可选预热**。
- 结论：**只开 OC 也完全可用**，预热只影响冷启动那几分钟的档位质量。
**机器 B 实测补充**：最终版插件的 `SERVICE_PYTHON / SERVICE_SCRIPT` 改为**候选探测**（`ROUTER_LAYA_PYTHON/SCRIPT` env → `~/.dsh-router-laya/venv` → 包内 `.venv-router`），因为机器 B 的包不在 `%APPDATA%\npm`、venv 也不在包内（见附录 C）。另：本次在维护窗口**手动起过一次服务**，随后插件加载时 `healthUp()` 直接命中 → 不 spawn、零冷启动窗口（`%TEMP%\router-laya-oc.spawn` 为空可证）。
>
> **机器 B 实测补充 2（单实例闸门，2026-10-07）**：只靠 EADDRINUSE「去重」会出事。实测 OC 插件在判定超时后每 60 s 拉起一个新服务，`netstat` 里一度有 **4 个 `127.0.0.1:8765` LISTENING**（各 hold 842 MB 模型，可用内存从 5 GB 掉到 **1.0 GB**），越慢越拉、越拉越慢。修法 = 服务端**命名互斥体闸门**，且必须放在**加载 checkpoint 之前**（否则照样吃满内存）：
>
> ```python
> def _claim_single_instance(port):
>     if os.name != "nt": return None
>     import ctypes; from ctypes import wintypes
>     k = ctypes.WinDLL("kernel32", use_last_error=True)
>     k.CreateMutexW.restype = wintypes.HANDLE
>     k.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
>     ctypes.set_last_error(0)
>     h = k.CreateMutexW(None, False, "dsh-router-laya-service-%d" % int(port))  # 名字里别带反斜杠
>     if not h: return None
>     if ctypes.get_last_error() == 183:          # ERROR_ALREADY_EXISTS
>         print("[single-instance] another router already owns 127.0.0.1:%d -- exiting" % int(port),
>               file=sys.stderr, flush=True)
>         sys.exit(0)
>     return h                                     # 进程活着就一直持有，退出即由内核释放
> ```
>
> 在 `http_serve()` 里紧跟 `_log_lock = _threading.Lock()` 之后调用：`_instance_guard = _claim_single_instance(port)`。
> 反证法验收：先起一个，再手工起第二个 → 第二个在读 checkpoint **之前**退出并打印上面那行，`netstat` 始终 1 个 LISTENING；可用内存回到 4.4 GB，判定回到 5–6 s/轮。
> ⚠️ 纯名字（不带 `Local\` 前缀）就是**当前会话**的 Local 命名空间，两个 harness 在同一登录会话里，够用；写 `"Local\\…"` 时注意转义（写成 4 个反斜杠会让 `CreateMutexW` 直接失败并被静默吞掉）。


### 4.3 语义：picker 就是开关

| composer 的档位下拉 | 行为 |
| --- | --- |
| **Default**（实测传空值） | **AUTO**：判定服务决定本轮档位（每轮 +~1.3 s） |
| 任意具体档位（low/medium/high/xhigh/max） | **手选优先**：插件完全不干预，连判定都不调（~1 ms） |

逃生开关：`ROUTER_LAYA_RESPECT_EXPLICIT=0` 退回"总是路由"；`ROUTER_LAYA=0` 全关。

### 4.4 两个运行时开关（**不用重启**）

```powershell
"manual" | Out-File -Encoding ascii "$env:TEMP\router-laya-oc.mode"   # 全面旁路；删文件即恢复
"low"    | Out-File -Encoding ascii "$env:TEMP\router-laya-oc.probe"  # 强制档位（A/B 验证用）；删文件即恢复
```

### 4.5 验收

**① 看日志**（`%TEMP%\router-laya-oc.log`）：

```
init pid=… judge=http://127.0.0.1:8765/judge … respectExplicit=true toast=true
message session=ses_… variant=(default) -> AUTO turn=1 text="…"
route   session=ses_… turn=1 -> low (changed) (laya, 1326ms) model=provider/example-model
cached  session=ses_… turn=1 -> low                     ← 同一回合后续 LLM 调用，不重复判定
message session=ses_… variant=max -> MANUAL (hands off) turn=2
session=ses_… turn=2: picker pinned 'max' -- hands off   ← 手选档位，1ms 放行
```

**② 验"档位真的生效"**（关键，别省）：

用一个**会报 reasoning token 的模型**（实测 `provider/example-model` 会；`example-model` 恒为 0，不能用来验）：

1. probe 写 `low` → 发一句固定的话（例：`分析一下快速排序和归并排序在工程上的取舍`）
2. probe 改 `max` → 发**同一句**
3. 用附录 B 的脚本读 OC 消息库，比较 `tokens.reasoning`

本次实测：**`low` → reasoning 0 / 63.0 s；`max` → reasoning 1034 / 86.4 s** —— 同一 prompt 差三个数量级，证明档位确实落到了上游请求。
**机器 B 实测补充**：

- 本机模型 `provider/example-model` **会**上报 reasoning（"deepseek 系恒为 0"不成立于该供应商）：重启后首轮判定 `high` 的回复实测 **reasoning=3084 / 30.9 s**；历史各轮 0~3194 波动，可直接用附录 B 脚本做 A/B 自验。
- 判定耗时**随机器差异巨大**（机器 A ~1.4 s，机器 B 4–9 s/轮）。**`ROUTER_LAYA_TIMEOUT_MS` 必须 ≥ 本机判定耗时**：默认 6000 在机器 B 会**每轮超时、全部 fail-safe 丢档**（症状是日志里 `judge unavailable (The operation was aborted…)` 连成一片，但 `/health` 正常）。机器 B 调为 **20000**（最终版插件已内置）。


> ⚠️ **不要用非法值（`bogus`/未声明的档位）当通道探针**：OC 会把模型没声明的档位值静默过滤掉，请求照样成功，会得到"通道没通"的**假结论**（我在这上面栽过一次）。

**③ 验"判定服务本身健康"**（工具别用错）：

```powershell
netstat -ano | findstr :8765                      # 应有 127.0.0.1:8765 LISTENING
Invoke-RestMethod http://127.0.0.1:8765/health    # 必须 protocol=finetuned
```

> ⚠️ **在 DSH 沙箱里不要用 `Get-NetTCPConnection` / WMI 查进程**：会返回**空结果**，让你得出"服务没起来"的**假结论**（我在这上面栽过一次——服务其实一直在跑）。只有 `netstat` + `/health` 可靠。
> 同理，**从 DSH 沙箱内写 `%LOCALAPPDATA%\Temp` 会被拒绝**；自测脚本要落盘就写到工作区里，别写 temp。

**④ 档位分布自检**（区分"真在判定"和"恒为一档"）：

```powershell
$log = "$env:TEMP\router-laya-oc.log"
Get-Content $log | Select-String -Pattern '-> (low|high|max)( |$)' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
  Group-Object | Sort-Object Count -Descending
```

本次实测（1049 行日志）：**`max 383 / high 287 / low 88`** —— 三档都出现、比例合理，说明判定确实按消息在变。

---

### 4.6 成本安全：这个插件**不会**改 provider/model

`applyTier` 只写两个通道（`plugins/router-laya.js`）：

```js
function applyTier(input, output, tier) {
  output.options = { ...(output.options ?? {}), reasoningEffort: tier }
  const message = input?.message
  if (message !== null && typeof message === "object") message.variant = tier
}
```

**没有 provider / model 字段** —— 它只能改"思考强度"，改不了"用哪个供应商"。所以：

- 你在 picker 里选的是 `<your-provider>-*`，它就永远只在这条线上改档位，**不可能**把流量送去官方 DeepSeek；
- 核对方法：日志每行末尾都带 `model=<provider>/<model>`，直接看是不是你预期的供应商。

这与 DSH 插件形成对比：DSH 内置路由表点名了 `deepseek-official`，**必须**用 §3.2 的 `tiers` 覆盖才安全。OC 移植版没有这个问题。

> 相关但独立的一个坑（同一次排查中发现）：OC 侧"内置官方 provider 复活"与 router-laya 无关 ——
> ① `~/.local/share/opencode/auth.json` 里的 `deepseek` 条目；② 用户级环境变量 `DEEPSEEK_API_KEY`；③ omo 内置 fallback 链里的 `providers: ["deepseek"]`。
> 这三处任一存在都会让 OC 走**官方计费**，且和 router-laya 完全无关。排查成本问题时先清这三处。

---

## 5. 排错表

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `setup.mjs` 抛 `probe.base is not iterable` | 上游 bug（venv 创建分支） | 先手动建 venv（§2.2），setup 会跳过该分支 |
| 权重下到 ~10 MB 就 `terminated` | 单流被网络掐断 | 用附录 A 的分块下载器；或反复跑官方 `fetch.mjs`（续传） |
| HF `401` / hf-mirror `404` | checkpoint 只在 GitHub Release | 别指望 HF 兜底 |
| `start_router.ps1 is not recognized` | 杀软删了 `.ps1` | 关杀软重装；或直接用 python 起服务（§2.4） |
| 芯片永远 `待判定`/`离线` | 桌面端 Origin 是 `dsh-app://app`，CORS 拦了 | 打 §3.3 的 CORS 补丁 |
| OC 里档位没效果 | 只写了 `output.options`，被钉选的 variant 盖掉 | 必须同时写 `input.message.variant`（附录 C 的 `applyTier`） |
| OC 每次请求判两遍（延迟翻倍） | OC 为每个实例/上下文各实例化一次插件 | 跨实例共享裁决文件（附录 C） |
| OC 一轮之内档位自己往上跳 | 工具循环里的重复 LLM 调用被当成"用户重试" | 按轮缓存（附录 C） |
| 改完插件没生效 | OC 只在启动时加载插件 | 重启 OC |
| 日志里 `model=provider/undefined` | OC 的 `Model` 字段是 `id` 不是 `modelID` | 读 `input.model.id` |
| `judge unavailable (fetch failed)` 连成一片 | 判定服务冷启动中（~40 s–3 min），或拉起被 60 s 冷却挡住 | 属预期，起来即恢复；想消掉窗口见附录 E |
| 服务明明在跑，却查到"没起来" | 在 DSH 沙箱里用了 `Get-NetTCPConnection`/WMI（**假阴性**） | 改用 `netstat -ano | findstr :8765` + `/health` |
| 日志里 `does not declare reasoning -- leaving the request untouched` | 当前模型 capabilities 未声明 reasoning | 换支持 reasoning 的模型；否则属预期跳过 |
| 档位恒为同一档、从不变化 | `probe` 文件存在（强制档位），或 picker 一直钉着具体档位 | 删 `%TEMP%\router-laya-oc.probe`；picker 调回 Default |
| `/health` 能通但判定无效 | 起的是 base 协议服务（响应里没有 `tier` 字段） | 必须是 `protocol=finetuned` 的那个服务 |
| DSH 侧改了 `tiers` 仍走官方通道 | 四个档位键没给全 —— 缺任一个都会回落内置表（`low/high/max/fallback`） | 四个键都写，见 §3.2 |
| 安装：pip 报 `[WinError 206] 文件名或扩展名太长` | npm 全局包在深路径（WinGet 系），包内 venv 的深路径突破 MAX_PATH | venv 放短路径（如 `~\.dsh-router-laya\venv`），全路径引用（§2.2） |
| 安装：`requirements.lock.txt` 不见了/变成 `.IPGSD` | DLP 透明加密把 .txt 加密改名 | 从 npm tarball 提原文存 `.md` 再 pip（§2.2） |
| 安装：`WinError 1114` + `c10.dll` 初始化失败 | 系统 VC 运行库过旧（<14.40） | 新版 runtime 部署到 `venv\Scripts` + `torch\lib`（§2.6 / 附录 F） |
| 每轮都 `judge unavailable`（超时）但 `/health` 正常 | 插件 `ROUTER_LAYA_TIMEOUT_MS` < 本机判定耗时（慢机） | 调大（机器 B 20000）；先看 `/judge` 返回的 `ms`（§4.5） |
| 日志中文乱码 | PowerShell 控制台按 GBK 显示 UTF-8 文件（文件本身正常） | 用编辑器/VSCode 看；或读前设 `[Console]::OutputEncoding` |
| 判定连续 `judge unavailable` + python 进程堆积 | ① 单线程 HTTP 服务被并发请求堵住；② 插件把「超时」误判为「服务死亡」反复 spawn（60 s 一次、各加载 842 MB 模型），形成越堵越慢的正反馈 | 服务线程化（`ThreadingHTTPServer` + 推理锁）；插件只在**连接失败且 `/health` 探测失败**时才拉起；**再加服务端单实例闸门**（否则仍会堆到 4 个，见 §4.2 补充 2 / §6）；清理由 `netstat -ano \| findstr :8765` 找监听者，只留一个，其余 `taskkill /PID <pid> /F` |
| 多个 842 MB 判定实例、可用内存暴跌（1 GB 级） | Windows 上 `SO_REUSEADDR` 让重复拉起**都能绑上 8765**（EADDRINUSE 不生效） | 打单实例闸门（§4.2 补充 2）；应急：`netstat -ano \| findstr :8765` 列出全部监听者，只留 1 个 |
| `GET /router-laya/mode` 读到 `manual`，插件不路由 | 热插入插件后的瞬时态（settings 平面第一次派生） | POST `{"mode":"auto"}` / 芯片上切一下；改一行配置让插件重新 apply 后稳定（§3.4） |
| 装了插件但输入栏没有档位芯片 | Web 启动图是页面加载时组合的，旧页面不含新 bundle | 刷新 / 重开 DSH 窗口；启动图里应出现 `dsh-router-laya/client.js`（§3.4） |
| `/router-laya/mode` 404 | 插件没挂上：profile 补丁没生效 / `name` 解析不到包 | 先看 `harness.log` 有没有 `[router-laya] auto tier per turn`；再查 profile `node_modules\dsh-router-laya` 是否还在（pnpm 会清） |
| PowerShell 探 `/judge` 得到 `tier=low` 且 `intent.span` 全是 `?` | PS 5.1 的 `Invoke-RestMethod -Body <string>` 按本地代码页发中文，任务文本被打成 `?`（服务没问题，是探针的问题） | body 用 `[Text.Encoding]::UTF8.GetBytes($json)` 发，`-ContentType 'application/json; charset=utf-8'` |
| `harness.log` 里插件行只报 `(no task text captured)` | 该轮用户消息在插件挂载**之前**就已领取（`agent/inbox/claimed` 抓不到历史文本） | 属预期；**下一轮**用户消息即正常判定 |


---

## 6. 本地分叉清单（**升级会覆盖，务必记账**）

| 文件 | 改动 | 备份 |
| --- | --- | --- |
| `<svc>\service\laya_router.py` | CORS 白名单加 `dsh-app://`（+ 每个 Origin 只打一次的 stderr 诊断） | 机器 B：`laya_router.py.bak-dsh-app-cors-20261007`；机器 A：`…cors-20261006` |
| `<svc>\service\laya_router.py` | **单实例闸门** `_claim_single_instance()`（命名互斥体，加载 checkpoint 之前生效）—— 见 §4.2 补充 2 | 机器 B：`laya_router.py.bak-single-instance-20261007` |
| `<DSH_HOME>\profiles\<p>\node_modules\dsh-router-laya\` | loader 副本（`index.js` `client.js` `cordis.patch.yml` `package.json`），由包内 `install.mjs` 复制；**非分叉，但 pnpm 会清掉未登记副本** | 重跑 `install.mjs` 即恢复（§3.1b） |
| `<DSH_HOME>\profiles\<p>\node_modules\dsh-router-laya\client.js` | （可选）离线容错 `POLL_FAILURES_BEFORE_OFFLINE` 2 → 30 | `router-laya-client.js.orig-20261006` |
| `<DSH_HOME>\profiles\<p>\cordis.patch.yml` | 追加**插入行**（无 dsh CLI 时）或 `tiers`/`routes` id-targeted 覆盖（**不覆盖会走 DeepSeek 官方计费**，见 §3.2） | 机器 B：`cordis.patch.yml.bak-pre-router-laya-20261007` |
| `~/.config/opencode/plugin/router-laya.js` | OC 移植插件（新增，非分叉；目录名以本机为准，见 §4.1） | — |
| `<venv>`（机器 B：`~\.dsh-router-laya\venv`） | venv 移出包外短路径（避 WinError 206）；**npm 升级不丢** | 归档区留 `requirements.lock.md` |
| `<venv>\Scripts\` 与 `<svc>\torch\lib\` 下的 `msvc*140*.dll` 等 | VC runtime 14.44 每应用部署（修 torch 1114） | 代码在 `msvc-fix.py`（附录 F），重装 venv/torch 后重跑 |
| 归档区 `~\.dsh-router-laya\` | 权重备份 846 MB + 下载器/修复/验收脚本 + `README.md` | — |
| `<svc>\service\laya_router.py` | **线程化补丁**（`HTTPServer`→`ThreadingHTTPServer` + `_judge_lock`/`_log_lock`）：并发请求不再阻塞 `/health`，Torch 推理仍串行（2026-10-07） | `.bak-20261007-threaded`；**npm 升级包会覆盖 → 需重打** |
| `<svc>\service\laya_router.py` | **机器 C 合并补丁**（2026-10-07）：一次性把线程化 + `_claim_single_instance()` 单实例闸门 打齐（含上面的 CORS 保留） | 机器 C：`laya_router.py.bak-threaded-singleinstance-20261007` |
| `~/.config/opencode/plugins/router-laya.js`（机器 C 为**复数** `plugins\`） | `ROUTER_LAYA_TIMEOUT_MS` 默认 **6000 → 10000**（本机实测单轮 1.9–4.7 s，并发时叠加，6000 会误杀第 3/4 个并发请求） | 机器 C：改前 15880 字节，源码在指南附录 C（把 20000 改成本机值即恢复） |


`npm i -g dsh-router-laya` 会重新解包，覆盖 `<svc>` 下的所有补丁（CORS、单实例闸门、线程化）；`dsh plugin --profile <p> add/update` 或 profile 的 `pnpm install` 会覆盖 / 清掉 profile 侧的分叉 → **升级后重新打补丁、重新复制 loader、复查 `cordis.patch.yml`**。

---

## 附录 A：权重下载器（`fetch-laya-chunked.mjs`）

> **v3（并发版，推荐）**：机器 B 实测 6 并发抢块 **~43 MB/min**，19 分钟下完 842 MB；同机单流只有 ~3.7 MB/min（预估 3.5 小时）。机器 A 原版（v1 单流分块）思路相同，差别只在并发与断点粒度；两版源都是 GitHub Release。
> 设计：2 MiB 块进共享队列、6 worker 抢；写同一 `.part`（`fs.writeSync(fd, buf, 0, len, offset)` 位置写）；`<part>.chunks.json` 记录已完成块 → 重跑只补缺块；小文件（<16 MB）走整体单流；全部完成后 sha256 校验。
> ⚠️ 打开 `.part` 不能用 `'a'`（O_APPEND 忽略 position，位置写失效）——用 `'r+'`/`'w+'`。
> ⚠️ 顶部 `PKG` 路径按本机改；github 间歇抽风靠「每块 60 次重试 + 等待封顶 15 s」扛过。

```js
/**
 * Parallel chunked downloader for the dsh-router-laya judge checkpoint (842 MB single file).
 *
 * v3: 6 concurrent workers pulling 2 MiB Range chunks off a shared queue. Reason: the single
 * stream here does ~0.06-0.3 MB/s and stalls for minutes at a time, while a 4-connection probe
 * showed the aggregate is several times higher. Writes go to a preallocated `.part` file at the
 * chunk's offset; progress lives in a sidecar (`<part>.chunks.json`) so a restart resumes only
 * the missing chunks. Only the GitHub Release endpoint serves here (hf-mirror 404s, hf.co resets).
 *
 * Small files (all but model.safetensors): whole-body fetch, single stream.
 * Every finished file is sha256-verified against weights/manifest.json.
 * Idempotent: re-run anytime.
 *
 * Run:  node fetch-laya-chunked.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const PKG = String.raw`C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node_modules\dsh-router-laya`;
const DEST = path.join(PKG, 'weights', 'model');
const CHUNK = 2 * 1024 * 1024;
const WORKERS = 6;
const MAX_TRIES = 60;
const REQ_TIMEOUT_MS = 150_000;
const SMALL_CUTOFF = 16 * 1024 * 1024;
const MAX_WAIT_MS = 15_000;

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'weights', 'manifest.json'), 'utf8'));
const RELEASE_BASE = (manifest.release_base || '').replace(/\/+$/, '');
const files = [...manifest.files].sort((a, b) => a.bytes - b.bytes); // small first, 842MB last

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => (n / 1e6).toFixed(1);
const stamp = () => new Date().toTimeString().slice(0, 8);

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

  const fd = fs.existsSync(part) ? fs.openSync(part, 'r+') : fs.openSync(part, 'w+');

  const totalChunks = Math.ceil(f.bytes / CHUNK);
  let done = new Set();
  try {
    const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (Array.isArray(saved?.done)) done = new Set(saved.done.filter((i) => Number.isInteger(i) && i >= 0 && i < totalChunks));
  } catch {}
  if (done.size === 0 && fs.existsSync(part) && fs.statSync(part).size === 0) {
    /* fresh */
  }

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
```

---

## 附录 B：读 OC 消息库看每轮 reasoning token（`oc-db-dur.py`）

> OC 把会话存在 `~/.local/share/opencode/opencode.db`（SQLite），`message.data` 是 JSON，含 `tokens.reasoning`。只读打开，不影响运行中的 OC。

```python
import sqlite3, json, datetime

db = 'file:C:/Users/user/.local/share/opencode/opencode.db?mode=ro'
con = sqlite3.connect(db, uri=True, timeout=10)
cur = con.cursor()
rows = cur.execute("select id, session_id, time_created, data from message order by time_created desc limit 10").fetchall()
print(f"{'time':9} {'dur(s)':7} {'model':42} {'reason':6} {'out':5} {'finish':10}")
for mid, sid, tc, data in rows:
    j = json.loads(data)
    if j.get('role') != 'assistant':
        continue
    t = j.get('time') or {}
    dur = ((t.get('completed') or 0) - (t.get('created') or 0)) / 1000 if t.get('completed') else None
    tk = j.get('tokens') or {}
    when = datetime.datetime.fromtimestamp((tc or 0) / 1000).strftime('%H:%M:%S')
    print(f"{when:9} {str(round(dur,1) if dur else '-'):7} {(j.get('providerID') or '?') + '/' + (j.get('modelID') or '?'):42} "
          f"{str(tk.get('reasoning')):6} {str(tk.get('output')):5} {str(j.get('finish')):10}")
con.close()
```

---

## 附录 C：OC 插件全文（机器 B 最终版，含 autostart）

> **与机器 A 版的差异**：① 导出形式 `export default`（机器 B 的 opencode；机器 A 为 named export——以本机既有插件写法为准，见 §4.1）；② 服务路径**候选探测**（`ROUTER_LAYA_PYTHON/SCRIPT` env → `~/.dsh-router-laya/venv` → 包内 `.venv-router`）；③ 含 **autostart**（加载时健康检查 + 每轮不可达时拉起，60 s 冷却标记 `%TEMP%\router-laya-oc.spawn`）——修正原文「§4.2 描述 autostart、附录 C 快照却没有」的不一致；④ `ROUTER_LAYA_TIMEOUT_MS` 默认 **20000**（机器 B 判定 4–9 s）。
> 放置路径：`~/.config/opencode/plugin/router-laya.js`（**目录名以本机为准**）。改完重启 OC 生效。

```js
/**
 * dsh-router-laya for OpenCode — a local Laya judge (dsh-router-laya's Python service)
 * decides the reasoning tier per request, and this plugin applies it as that request's
 * reasoning effort. The model is deliberately left alone: router-laya's whole point is
 * that one model is used at low/high/max effort.
 *
 * Installed on this machine 2026-10-07 from router-laya-install-guide §4 (OC port), with
 * these local adaptations:
 *   - plugin dir here is ~/.config/opencode/plugin (singular; verified live via skill-sync),
 *     not `plugins/` as the guide's source machine had.
 *   - the judge service auto-starts from here (spawn, 60 s cooldown). Service paths: the
 *     npm package lives under the WinGet node prefix (npm prefix -g), and its venv was
 *     built OUTSIDE the package at ~/.dsh-router-laya/venv (short path — the package path
 *     itself is ~165 chars, and pip blew up on Windows MAX_PATH inside it).
 *
 * When does it route? Exactly when your OpenCode variant picker says **Default**.
 *   - picker = Default  -> the judge decides the tier for every turn (auto)
 *   - picker = low/medium/high/xhigh/max -> hands off, your choice is used verbatim
 *     (and the judge is not called at all, so this costs no latency)
 * Set ROUTER_LAYA_RESPECT_EXPLICIT=0 to keep routing even when a variant is pinned.
 *
 * Where the tier is written (both, deliberately):
 *   - `input.message.variant` — OpenCode's per-request variant. This is the channel that
 *     visibly works (verified upstream: the same prompt at forced low vs forced max gave
 *     0 vs 1034 reasoning tokens). It also makes omo's own `applyAgentVariant` stand down
 *     for that turn (it skips when the message already carries a variant).
 *   - `output.options.reasoningEffort` — the request option, kept for models/providers that
 *     read it. OpenCode filters values the model does not declare, so an invalid value here
 *     fails silently (not usable as a channel test).
 *
 * What the judge sees (it does NOT read the conversation): the current message text, the
 * previous turn's tier, and the previous turn's text (the last two only for "keep the last
 * tier" intent and for retry/escalation detection).
 *
 * Two caches keep this honest, because OpenCode instantiates a local plugin once per
 * instance/context — several live instances all receive the same hooks:
 *   - per-session memory: one user turn = one judgment, however many LLM calls it makes
 *     (re-judging inside a turn would look like a retry and escalate by itself);
 *   - a small shared file: the other instances reuse the verdict instead of paying a second
 *     judge call and firing a second toast for the same turn.
 *
 * Env:
 *   ROUTER_LAYA=0                     disable everything (pass-through)
 *   ROUTER_LAYA_JUDGE_URL=...         judge endpoint (default http://127.0.0.1:8765/judge)
 *   ROUTER_LAYA_TIMEOUT_MS=20000      judge timeout; on failure the request is left untouched
 *                                     (this machine: CPU-only 6 核 CPU judges in ~4-9 s,
 *                                      so the guide's 6000 default was raised to 20000)
 *   ROUTER_LAYA_RESPECT_EXPLICIT=0    route even when a variant is pinned (default: defer)
 *   ROUTER_LAYA_PROBE=<value>         force this tier, skipping the judge
 *   ROUTER_LAYA_TOAST=0               silence the per-turn toast (default: on)
 *   ROUTER_LAYA_AUTOSTART=0           never auto-start the judge service
 *   ROUTER_LAYA_PYTHON / ROUTER_LAYA_SCRIPT   override the judge service paths
 *
 * Runtime switches — files, so no OpenCode restart is needed:
 *   %TEMP%/router-laya-oc.mode    "manual" = pass-through, anything else/absent = auto
 *   %TEMP%/router-laya-oc.probe   force this tier for every request (A/B testing; delete to
 *                                 go back to real routing) — use declared levels (low/high/max)
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
const TIMEOUT_MS = Number(process.env.ROUTER_LAYA_TIMEOUT_MS ?? 20000)
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

// Judge service paths (this machine). First existing candidate wins; env overrides first.
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
  String.raw`C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node_modules\dsh-router-laya\service\laya_router.py`,
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

/** Start the judge service (detached, shared with DSH; EADDRINUSE self-dedupes). */
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

export default async ({ client }) => {
  log(`init pid=${process.pid} judge=${JUDGE_URL} python=${SERVICE_PYTHON} script=${SERVICE_SCRIPT} autostart=${AUTOSTART} respectExplicit=${RESPECT_EXPLICIT} toast=${TOAST}`)
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

      // Same turn, already judged: reuse it. This is what keeps a multi-call turn (tool loop)
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

      // Another OpenCode instance already judged this turn: reuse its verdict (no 2nd call, no 2nd toast).
      const sharedKey = `${input.sessionID}|${turn}`
      const sharedTier = sharedGet(sharedKey, text)
      if (sharedTier !== null) {
        applyTier(input, output, sharedTier)
        sessions.set(input.sessionID, { ...cur, text, tier: sharedTier, task: text, cachedTurn: turn, cachedTier: sharedTier })
        log(`shared session=${input.sessionID} turn=${turn} -> ${sharedTier} (another instance judged it)`)
        return
      }

      try {
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
```

---

## 附录 D：速查

```
判定服务      http://127.0.0.1:8765      （/judge POST、/health、/state）
健康检查      Invoke-RestMethod http://127.0.0.1:8765/health  → protocol 必须是 finetuned
端口检查      netstat -ano | findstr :8765                    （沙箱里别用 Get-NetTCPConnection）
DSH 芯片接口   http://<web载体端口>/router-laya/mode?token=…（机器 A 19387；机器 B 43129，token 见 harness.log 的 `dsh web:` 行）
DSH 家目录     %APPDATA%\dsh-desktop\harness（= $env:DSH_HOME；机器 B 没有 ~/.dsh），profile = web（$env:DSH_PROFILE）
DSH 补丁层     <DSH_HOME>\profiles\<profile>\cordis.patch.yml   （tiers/routes 必写，见 §3.2）
DSH 挂载证据   harness.log：`[router-laya] auto tier per turn; tiers low=…` ＋ `judge service: already up|started`
DSH 插件日志   %APPDATA%\dsh-desktop\logs\harness.log（插件 stderr 会桥接到这里）
服务包目录     %APPDATA%\npm\node_modules\dsh-router-laya（以 `npm prefix -g` 实际值为准；机器 B 在 WinGet 深路径下）
机器 B venv    ~\.dsh-router-laya\venv（包外短路径）＋归档区 ~\.dsh-router-laya\（权重备份/脚本/README/dsh-side 安装脚本）
单实例闸门     命名互斥体 dsh-router-laya-service-<port>；重复启动在【读 checkpoint 之前】退出并打 [single-instance]（§4.2 补充 2）
谁拉起服务     OC 插件（加载时 + 每轮不可达时）／DSH 插件（auto: true 开机异步拉起）／可选预热（附录 E）
服务日志      %TEMP%\laya-router-service.log（DSH 插件拉）；%TEMP%\laya-router-service.out.log / .err.log
              （start_router.ps1 拉时写这两个；OC 插件拉是 stdio:ignore，不写）
OC 插件日志    %TEMP%\router-laya-oc.log
OC 插件开关    %TEMP%\router-laya-oc.mode    ("manual" = 旁路)
OC 强制档位    %TEMP%\router-laya-oc.probe   (A/B 验证)
OC 共享裁决    %TEMP%\router-laya-oc.shared.json
OC 拉起节流    %TEMP%\router-laya-oc.spawn   (60 s 冷却标记)
OC 消息库      ~/.local/share/opencode/opencode.db
OC 运行日志    ~/.local/share/opencode/log/opencode.log
权重校验       model.safetensors = 842,609,220 B
              sha256 f14cf869ebc4d0adab3102627a92f0b677678d05e5353e3e55dc11f4fc6172de
判定耗时       机器 A ~1.4 s/轮；机器 B 4–9 s/轮（CPU 而异，计入首字延迟）
              插件 ROUTER_LAYA_TIMEOUT_MS 必须 ≥ 它（机器 B 用 20000）；服务常驻内存 ~1.5–1.9 GB
冷启动         ~40 s（慢时 3 min）；期间每轮 fail-safe 丢档
```

**一句话成本安全**：OC 插件只改 reasoningEffort（每行 `model=` 可核对供应商）；DSH 插件内置表指向 `deepseek-official`，**必须**覆盖 `tiers`（§3.2）。

---

## 附录 E：可选预热（登录计划任务，消掉冷启动窗口）

**什么时候需要**：你习惯"开机后先开 OC"。OC 插件虽然会自启动判定服务，但冷启动那 ~40 s–3 min 内每轮都 fail-safe 丢档（§4.2）。
预热只在**登录时**把服务拉起来，不改判定逻辑；**没有它也能正常工作**。

三个部件：幂等脚本 + 隐藏启动器 + 登录触发任务。

**① `C:\Users\<you>\.dsh\bin\warm-laya-judge.ps1`**（幂等；启动方式与插件 spawn 完全一致）
> 路径只是机器 A 的约定：机器 B 没有 `~/.dsh`，脚本放归档区 `~\.dsh-router-laya\`（或任意目录）即可，计划任务里写全路径。

```powershell
# Pre-heat the Laya judge service shared by the OC and DSH router-laya plugins.
#   - idempotent: exits at once when the service is already healthy
#   - hidden: launches pythonw.exe (no console window)
#   - spawn matches the DSH plugin exactly: <script> --http --port 8765, PYTHONIOENCODING=utf-8
$ErrorActionPreference = 'SilentlyContinue'

$Python = 'C:\Users\<you>\AppData\Roaming\npm\node_modules\dsh-router-laya\.venv-router\Scripts\pythonw.exe'
$Script = 'C:\Users\<you>\AppData\Roaming\npm\node_modules\dsh-router-laya\service\laya_router.py'
$Port   = 8765
$WaitSeconds = 180

if ($env:LOCALAPPDATA) { $TempRoot = Join-Path $env:LOCALAPPDATA 'Temp' } else { $TempRoot = $env:TEMP }
$PreheatLog = Join-Path $TempRoot 'laya-preheat.log'
$ServiceLog = Join-Path $TempRoot 'laya-router-service.log'

function Write-PreheatLog([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $PreheatLog -Value ("[$stamp] $Message") -Encoding UTF8
}

function Test-JudgeHealthy {
    try {
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = $null
        $body = $wc.DownloadString("http://127.0.0.1:$Port/health")
        return ($body -match '"protocol"\s*:\s*"finetuned"')
    } catch { return $false }
}

function Test-PortBusy {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        return ($task.Wait(800) -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

if (Test-JudgeHealthy) {
    Write-PreheatLog "already healthy on 127.0.0.1:$Port - nothing to do"
    exit 0
}
if (Test-PortBusy) {
    Write-PreheatLog "port $Port busy but /health is not the finetuned protocol - not spawning"
    exit 2
}
foreach ($p in @($Python, $Script)) {
    if (-not (Test-Path $p)) { Write-PreheatLog "missing required file: $p"; exit 3 }
}

Write-PreheatLog "judge down - spawning pythonw (--http --port $Port)"
$inner = 'set PYTHONIOENCODING=utf-8 && "{0}" "{1}" --http --port {2} >> "{3}" 2>&1' -f $Python, $Script, $Port, $ServiceLog
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList @('/c', $inner) -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-JudgeHealthy) { Write-PreheatLog "judge ready"; exit 0 }
}
Write-PreheatLog "judge did not become healthy within $WaitSeconds s - see $ServiceLog"
exit 1
```

**② `C:\Users\<you>\.dsh\bin\warm-laya-judge.vbs`**（隐藏启动，避免登录时黑框一闪）

```vbscript
' launch the pre-heat script with no visible window
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""C:\Users\<you>\.dsh\bin\warm-laya-judge.ps1""", 0, False
```

**③ 注册任务**

```powershell
# 登录后延迟 30 s 执行（给桌面留启动时间）；隐藏窗口交给 VBS
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"C:\Users\<you>\.dsh\bin\warm-laya-judge.vbs"'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'warm-laya-judge' -Action $action -Trigger $trigger -Settings $settings -Force

# 立刻预热一次（不想重启验证时）
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\<you>\.dsh\bin\warm-laya-judge.ps1"

# 撤销
Disable-ScheduledTask    -TaskName 'warm-laya-judge'
Unregister-ScheduledTask -TaskName 'warm-laya-judge'
```

**④ 验收**

```powershell
Get-ScheduledTask     -TaskName 'warm-laya-judge' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName 'warm-laya-judge' | Select-Object LastRunTime,LastTaskResult   # 期待 0
Get-Content "$env:LOCALAPPDATA\Temp\laya-preheat.log" -Tail 3   # "already healthy" 或 "judge ready"
```

**注意**

- 脚本**幂等**：服务已健康就直接退出；端口被非 finetuned 服务占用时不硬抢（避免 EADDRINUSE 空转）。
- 预热只是让服务"开机就在"，**不会多出一个进程**（服务本身常驻 ~1.9 GB，本来也是常驻）。
- 已实测：任务链路（`wscript → powershell → ps1 → /health → 退出码 0`）通过；`pythonw + --http --port 8765 + 重定向` 启动链路通过。
- 不想要了：`Unregister-ScheduledTask` + 删掉这两个文件即可 —— §4.2 已说明**没有预热也能用**，代价只是冷启动窗口丢档。

---

## 附录 F：torch `WinError 1114` 修复（`msvc-fix.py`）

> 背景见 §2.6。从 `pip download msvc-runtime --no-deps` 得到的 wheel 里提取全套 VC runtime DLL，部署到 `<venv>\Scripts\` 与 `<svc>\torch\lib\`（两处都要，原因见 §2.6 末尾）。
> 已在机器 B 验证：修复后 `import torch` + 张量运算正常、服务正常冷启动。WHEEL/DESTS 路径按本机改。

```python
"""Deploy newer VC++ runtime DLLs (14.44 from the msvc-runtime wheel) next to python.exe and
into torch\\lib so the loader picks them up ahead of the ancient system copy (14.29).
No admin needed; per-application deployment.

Targets:
  1. venv\\Scripts  -- python.exe's own vcruntime140 search starts at the app dir
  2. torch\\lib     -- c10.dll's implicit deps search the loading DLL's dir first
                      (CPython loads extensions with LOAD_WITH_ALTERED_SEARCH_PATH)
"""
import os
import shutil
import zipfile

WHEEL = r"C:\Users\<user>\AppData\Local\Temp\opencode\msvc-rt\msvc_runtime-14.44.35112-cp312-cp312-win_amd64.whl"
DESTS = [
    r"C:\Users\<user>\.dsh-router-laya\venv\Scripts",
    r"C:\Users\<user>\.dsh-router-laya\venv\Lib\site-packages\torch\lib",
]

z = zipfile.ZipFile(WHEEL)
dlls = [i for i in z.infolist() if i.filename.lower().endswith(".dll")]
print("DLLs found in wheel:")
for i in dlls:
    print("  ", i.filename, i.file_size)

for i in dlls:
    name = os.path.basename(i.filename)
    if not name:
        continue
    data = z.read(i)
    for d in DESTS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            bak = p + ".bak-20261007"
            if not os.path.exists(bak):
                shutil.copy2(p, bak)
                print("backed up existing:", p)
        with open(p, "wb") as f:
            f.write(data)
    print("deployed:", name)

print("DONE")
```

---

## 附录 G：机器 B（OC 端）零到一落地实录（2026-10-07）

**环境**：一台 6 核 CPU 笔记本· Windows + 受管控环境的 DLP · Node v24（WinGet 安装）· Python 3.12 · opencode 桌面版。

**时间线**：

| 阶段 | 结果 |
| --- | --- |
| npm 装包 + 手动 venv + pip | ~5 分钟（requirements 从 tarball 提取；venv 放短路径） |
| 842 MB 权重 | **19 分钟**（v3 并发下载器 43 MB/min；单流预估 3.5 小时） |
| torch 1114 排查 + 修复 | ~15 分钟（datafile 确诊 → msvc-runtime wheel → 部署 14.44） |
| 起服务 + `/judge` 验收 | ~3 分钟（冷启动 ~40 s；中文任务判 max/low/high 均正确） |
| 插件写入 + 静态验证 | ~5 分钟（bun 加载检查 + 在 opencode app.asar 里扫描 `chat.params`/`chat.message`/`showToast` 确认 hook 存在） |

**归档区 `~\.dsh-router-laya\`**（包外持久区，`npm` 升级不动它）：`venv\`、`weights-backup\model\`（846 MB，升级后秒级恢复权重）、`fetch-laya-chunked.mjs`、`msvc-fix.py`、`judge-probe.py`、`requirements.lock.md`、`router-laya.js.copy`、`README.md`。

**重启后验收记录（实录）**：

```
[10:05:42] init pid=36684 judge=http://127.0.0.1:8765/judge … autostart=true respectExplicit=true toast=true
[10:06:29] message session=ses_… variant=(default) -> AUTO turn=1 text="…"
[10:06:36] route   session=ses_… turn=1 -> high (changed) (laya, 6238ms) model=provider/example-model
/health => finetuned ；/state 有判定记录 ；%TEMP%\router-laya-oc.spawn 为空（复用已健康服务，零冷启动）
```

**维护铁律**：
1. `npm i -g dsh-router-laya` 升级包 → 包内 `weights\model` 与包内补丁会丢：从 `weights-backup` 复制回（秒级）或重跑下载器（~20 分钟）；venv 在包外不受影响。
2. 重装 venv/torch 后若出现 `WinError 1114` → 重跑 `msvc-fix.py`（附录 F）。
3. 判定服务常驻 ~1.5 GB 内存；内存紧张时先查 `/health`，不要盲目重拉。⚠️ **别指望 EADDRINUSE 去重**（§4.2 补充 2）：打单实例闸门之前，重复拉起会真的堆出多个 842 MB 实例。

---

## 附录 H：机器 B（DSH 端）零到一落地实录（2026-10-07）

**前提**：判定大脑（venv + 842 MB 权重 + 服务进程）已在 OC 侧装好并常驻 `127.0.0.1:8765`（附录 G）。DSH 侧**不重建 venv、不重下权重**，只做接入。

**环境**：DSH Desktop（Electron）· profile `web` · `DSH_HOME=%APPDATA%\dsh-desktop\harness` · **没有 `dsh` CLI** · 默认模型 `provider/example-model`。

### H.1 实际步骤

| 步 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 侦察：`netstat -ano \| findstr :8765` + `/health` | 服务已在（`protocol=finetuned`）；包在 `npm prefix -g` 下（WinGet 深路径），**不在** `%APPDATA%\npm` |
| 2 | `node <svc>\install.mjs <DSH_HOME>\profiles\web\node_modules` | 复制 4 个文件；`@deepseek-ai/schemastery` 由 Desktop 的 host-module-fallback 解析 |
| 3 | `cordis.patch.yml` 追加**手写插入行**（§3.1b / §3.2），`tiers`/`routes` 指 `provider/example-model` | 加载器**热应用**：`harness.log` 出现 `[router-laya] auto tier per turn; tiers …` |
| 4 | `laya_router.py` 打 CORS 补丁 → **重启服务** | `dsh-app://app`、`http://127.0.0.1:43129` 放行；`evil.example` 不给 |
| 5 | 发现服务实例堆积（4 个 × 842 MB，可用内存 1.0 GB）→ 加**单实例闸门** | `netstat` 恒定 1 个 LISTENING；可用内存回到 4.4 GB |

### H.2 验收证据（实录）

```
netstat -ano | findstr :8765   ->  1 × LISTENING 127.0.0.1:8765
/health                        ->  {"protocol":"finetuned","finetuned":true,"status":"ok"}
/judge（UTF-8 原始字节）        ->  复杂并发重构 max(5.2s) ／ 翻译 low(5.7s) ／ 二分 high(5.4s)
harness.log                    ->  [router-laya] auto tier per turn; tiers low=provider/example-model effort=low high=… max=…
                               ->  [router-laya] judge service: already up (http://127.0.0.1:8765)
启动图 ?token=…                 ->  含 dsh-router-laya/client.js（刷新窗口后输入栏出现档位芯片）
GET /router-laya/mode          ->  {"mode":"auto","writable":true}
再起一个服务实例                 ->  立即退出：[single-instance] another router already owns 127.0.0.1:8765 -- exiting
```

### H.3 本机特有的坑（按踩到的顺序）

1. **没有 `dsh` CLI、没有 `~/.dsh`** —— 原文 §3.1 / §3.2 / 附录 D 的路径全部不成立；按 §3.1(b) 手写插入行。
2. **热插入后 `mode` 首次读数可能是 `manual`** —— 插件直接不路由（`isManual()` 提前 return）；POST `{"mode":"auto"}` 或在芯片上切一下即可，重新 apply 后稳定 `auto`。
3. **任务文本有"出生时刻"** —— `agent/inbox/claimed` 只对**挂载之后**领取的消息生效；挂载那一轮的日志会是 `(no task text captured) -> … fallback … effort=low`，**下一轮**起才是真判定。
4. **芯片要刷新窗口** —— 启动图在页面加载时组合，热挂载的 bundle 不会自己出现在已打开的旧页面。
5. **Windows 上 `SO_REUSEADDR` 让"自然去重"失效** —— 见 H.1 步 5 与 §4.2 补充 2；这是本次唯一会**吃光内存**的问题。
6. **PowerShell 探针的编码陷阱** —— PS 5.1 的 `Invoke-RestMethod -Body <string>` 按本地代码页发中文，判定端收到一串 `?`，会得出"复杂任务也只判 low"的**假结论**。必须发 UTF-8 字节：`-Body ([Text.Encoding]::UTF8.GetBytes($json))`。与 §4.5「别用非法档位当探针」同类：**先证明探针本身没坏**。
7. **在 DSH 沙箱里跑 agent 时的限制** —— 写 `%LOCALAPPDATA%\Temp`、`Stop-Process`、`Get-NetTCPConnection`/WMI 可能被拒或是假阴性；进程状态照旧用 `netstat` + `/health` 判定，需要落盘就写工作区。

### H.4 归档与可复用脚本

- 归档区 `~\.dsh-router-laya\` 追加 `dsh-side\`：`install-dsh-router-laya.ps1`（幂等：复制 loader + 写补丁行 + CORS + 重启）、`settle-judge-service.ps1`（收敛实例）、`add-single-instance-guard.ps1` / `fix-single-instance-guard.ps1`（闸门）。
- `README.md` 已补「DSH 侧接入」一节（落点表 + 分叉表 + 验收记录）：本附录讲**为什么**，README 讲**本机落点在哪**。

