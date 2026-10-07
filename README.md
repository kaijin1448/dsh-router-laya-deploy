# dsh-router-laya deploy kit

一键把 **dsh-router-laya** 判定服务（842 MB 本地推理模型 + HTTP 接口）和 **OpenCode 接入插件**装到一台 Windows 机器上，并打上三个必要的本地补丁。

判定大脑是原项目 [`HapyRain/dsh-router-laya`](https://github.com/HapyRain/dsh-router-laya) 的 Python 服务；本仓库只包含**部署脚本、补丁和接入插件**，不含模型权重（脚本从 GitHub Release 下载并校验 sha256）。

---

## 为什么需要这个包

原项目的安装脚本有两个真实痛点，本包直接解决：

1. **并发判定互相阻塞 → 超时。** 原服务用单线程 `HTTPServer`，多个会话同时判定时后到的请求排在队尾，超过客户端超时被丢弃（日志里 `judge unavailable (timeout)`，但 `/health` 一切正常）。本包把服务线程化，并用锁串行化非线程安全的 Torch 推理。
2. **Windows 上重复拉起会堆多个 842 MB 实例。** `HTTPServer` 默认 `SO_REUSEADDR`，`EADDRINUSE` 去重**不生效**，失败的拉起会正反馈式堆实例，把内存吃光。本包加 Windows 命名互斥体单实例闸门（在加载 checkpoint **之前**生效）。

外加 **DSH 桌面端 CORS 补丁**（Electron 的 `dsh-app://` Origin 默认被拒，芯片读不到数据）。

完整背景、逐条实测记录、排错表见 **[`docs/router-laya-install-guide.md`](docs/router-laya-install-guide.md)**。

---

## 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10/11 | 脚本用 PowerShell + 命名互斥体 |
| Python | >= 3.10（3.12 最稳） | 判定服务运行时 |
| Node.js | >= 18 | npm 包 + 下载器 |
| 磁盘 | ~2 GB | venv ~0.7 GB + 权重 842 MB + 内存常驻 ~1.5–1.9 GB |
| 内存 | >= 4 GB 空闲 | 服务常驻 |

> **网络**：权重只从 GitHub Release 下载（HuggingFace 镜像不可用）。慢链路约 20 分钟，下载器支持断点续传。

---

## 一键部署

```powershell
# 0) 取包
git clone https://github.com/kaijin1448/dsh-router-laya-deploy.git
cd dsh-router-laya-deploy

# 1) 先看计划，不改任何东西
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -DryRun

# 2) 正式部署
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

`deploy.ps1` 是**幂等**的，按顺序做 7 步，每步已完成就跳过：

| 步 | 动作 | 幂等判据 |
| --- | --- | --- |
| 1 | 前置检查（python/node/npm） | — |
| 2 | `npm i -g dsh-router-laya` | 包目录已存在 |
| 3 | 建 venv + `pip install -r requirements.lock.txt` | venv 能 `import torch` |
| 4 | 下载 842 MB 权重（分块/续传/sha256 校验） | `model.safetensors` 已 842,609,220 B |
| 5 | 打补丁（线程化 + 单实例闸门 + CORS） | 三个标记都在 |
| 6 | 复制 OC 插件到 `~/.config/opencode/{plugins,plugin}/` | — |
| 7 | 起服务 + 验收（`/health` + 一次 `/judge`） | — |

### 常用参数

```powershell
-VenvPath <短路径>   # venv 放包外（装深路径 npm 时避 WinError 206）
-SkipWeights         # 权重已下好，跳过
-Restart             # 服务已健康也强制重启（改完补丁后）
-NoOcPlugin          # 只装判定服务，不碰 OC
-DryRun              # 只打印计划
```

### 部署后

- **重启 OpenCode** 才会加载插件（OC 只在启动时读插件目录）。
- 档位下拉保持 **Default**，插件才会按每轮消息自动判定；选了具体档位则插件不干预。
- 期望开关文件（不用重启 OC）：
  - `%TEMP%\router-laya-oc.mode` 写 `manual` = 全局旁路；删文件恢复
  - `%TEMP%\router-laya-oc.probe` 写 `low/high/max` = 强制档位（A/B 验证）；删文件恢复

---

## 验收

```powershell
powershell -ExecutionPolicy Bypass -File .\verify.ps1
```

检查项：`/health` 协议、单监听者（单实例闸门）、三个补丁标记、真实 `/judge` 往返、权重字节数、OC 插件是否就位、**超时值是否 >= 实测判定耗时**。

单测判定服务：

```powershell
python .\scripts\judge-probe.py "分析这个并发 bug 的根因，并给出跨模块的重构方案"
# 期待 tier=max，by=laya
python .\scripts\judge-probe.py --health
```

> 用 Python 而不是 PowerShell 发中文：PS 5.1 的 `Invoke-RestMethod -Body <string>` 按本地代码页编码，判定端会收到 `?`，得出"复杂任务也判 low"的**假结论**。

---

## 超时怎么设（重要）

插件默认 `ROUTER_LAYA_TIMEOUT_MS=10000`。**它必须 >= 本机每轮判定耗时**，否则每轮都 fail-safe 丢档（症状：日志里 `judge unavailable (timeout)` 连成一片，但 `/health` 正常）。

- 参考：机器 A ~1.4 s/轮；机器 B（6 核 CPU）4–9 s/轮；本包默认 10000 覆盖 4–5 s 峰值。
- 环境变量覆盖：部署前设 `$env:ROUTER_LAYA_TIMEOUT_MS="20000"`，或直接改插件文件顶部默认值。
- 实测耗时：`python .\scripts\judge-probe.py "随便一句话"` 看返回的 `ms`；或看 `%TEMP%\router-laya-oc.log` 里的 `(laya, <ms>ms)`。

---

## 目录结构

```
router/
├─ deploy.ps1                  # 一键部署编排器
├─ verify.ps1                  # 验收脚本
├─ README.md
├─ LICENSE
├─ docs/
│  ├─ router-laya-install-guide.md   # 完整指南（所有坑与实测记录）
│  └─ router-laya-install-guide.html # 同上的 HTML 版
├─ scripts/
│  ├─ patch-laya-router.py     # 幂等补丁器（线程化 + 单实例闸门 + CORS）
│  ├─ fetch-laya-chunked.mjs   # 842 MB 分块并发下载器
│  ├─ judge-probe.py           # UTF-8 安全的判定探针
│  ├─ msvc-fix.py              # torch WinError 1114 修复（VC runtime 每应用部署）
│  ├─ build-guide-html.cjs     # 由 md 生成 html
│  └─ preheat/                 # 可选：登录时预热服务，消掉冷启动窗口
│     ├─ warm-laya-judge.ps1
│     └─ warm-laya-judge.vbs
├─ oc/
│  └─ router-laya.js           # OpenCode 接入插件（含自启动）
├─ patches/                    # 补丁样例/说明（可选参考）
└─ archive/                    # 历史快照（仅留档，不参与部署）
```

---

## 手动分步（不用一键脚本）

```powershell
# 1. 装包
npm i -g dsh-router-laya
$svc = "$(npm prefix -g)\node_modules\dsh-router-laya"

# 2. venv + 依赖（原 setup.mjs 有 probe.base bug，必须手动建）
python -m venv "$svc\.venv-router"
& "$svc\.venv-router\Scripts\python.exe" -m pip install -r "$svc\service\requirements.lock.txt"

# 3. 权重
node .\scripts\fetch-laya-chunked.mjs --pkg $svc

# 4. 补丁
python .\scripts\patch-laya-router.py "$svc\service\laya_router.py"

# 5. OC 插件
Copy-Item .\oc\router-laya.js "$env:USERPROFILE\.config\opencode\plugins\router-laya.js"

# 6. 起服务
& "$svc\.venv-router\Scripts\pythonw.exe" "$svc\service\laya_router.py" --http --port 8765
```

---

## 排错

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| `setup.mjs` 抛 `probe.base is not iterable` | 上游 bug | 用本包（手动建 venv），别跑上游 setup 的 venv 分支 |
| pip 报 `[WinError 206] 文件名或扩展名太长` | npm 全局包在深路径 | venv 放短路径：`-VenvPath C:\Users\<you>\.dsh-router-laya\venv` |
| `requirements.lock.txt` 变成 `.IPGSD` | DLP 透明加密 | deploy.ps1 会自动从 npm tarball 提取原文 |
| torch `WinError 1114` / `c10.dll` 初始化失败 | 系统 VC runtime 过旧 | `python scripts\msvc-fix.py --wheel <msvc_runtime-*.whl> --venv <venv>`（README 末） |
| 每轮 `judge unavailable (timeout)` 但 `/health` 正常 | 插件超时 < 判定耗时 | 调大 `ROUTER_LAYA_TIMEOUT_MS`（见上） |
| 服务明明在跑却查到"没起来" | 在 DSH 沙箱用了 `Get-NetTCPConnection`/WMI（假阴性） | 用 `netstat -ano \| findstr :8765` + `/health` |
| 多个 842 MB 实例、内存暴跌 | `SO_REUSEADDR` 让重复拉起都能绑端口 | 打单实例闸门（本包已含）；应急 `netstat -ano \| findstr :8765` 只留一个 |
| 日志中文乱码 | 控制台按 GBK 显示 UTF-8 文件（文件本身正常） | 用编辑器/VSCode 看 |

**WinError 1114 修复步骤**：

```powershell
& "<venv>\Scripts\python.exe" -m pip download msvc-runtime --no-deps -d "$env:TEMP\msvc-rt"
python scripts\msvc-fix.py --wheel (Get-ChildItem "$env:TEMP\msvc-rt\*.whl").FullName --venv "<venv>"
# 新进程验证：
& "<venv>\Scripts\python.exe" -c "import torch; print(torch.__version__)"
```

---

## 升级注意（`npm i -g` 会覆盖补丁）

`npm i -g dsh-router-laya` 重新解包会**覆盖包内所有补丁**（线程化、单实例闸门、CORS）。升级后重跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -SkipNpm -Restart
```

包外的 venv（如果用 `-VenvPath` 放外面）和权重备份不受升级影响。

---

## 许可与来源

- 本仓库的脚本与插件：见 [`LICENSE`](LICENSE)。
- 上游项目 `dsh-router-laya` 与模型权重为 **Apache-2.0**，版权归原作者；本仓库不重新分发权重。
- 插件只改推理强度（reasoning effort），**不改 provider/model** —— 每行日志末尾的 `model=<provider>/<model>` 可核对。
