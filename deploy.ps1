<#
.SYNOPSIS
  One-command deployer for dsh-router-laya (judge service + OpenCode integration).

.DESCRIPTION
  Reproduces the whole working recipe idempotently:
    1. preflight      python >= 3.10, node >= 18, npm; locate the npm package dir
    2. install        npm i -g dsh-router-laya (only if missing)
    3. venv           reuse/create a Python venv + pip install requirements
    4. weights        chunked/resumable download of the 842 MB checkpoint (sha256-verified)
    5. patch          apply the 3 local forks: threading, single-instance gate, CORS
    6. oc plugin      copy router-laya.js into the OpenCode plugin dir
    7. start+verify   start the judge, assert /health protocol=finetuned and a /judge round-trip

  Safe to re-run: every step detects an already-done state and skips. Run with -DryRun
  first to see the plan without changing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -SkipWeights -Restart
  powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [int]$TimeoutMs = 10000,          # OC plugin judge timeout (see README: must be >= per-turn judging)
  [string]$VenvPath = "",           # override venv location; default: reuse package .venv-router, else ~/.dsh-router-laya/venv
  [switch]$SkipNpm,
  [switch]$SkipVenv,
  [switch]$SkipWeights,
  [switch]$SkipPatch,
  [switch]$NoOcPlugin,
  [switch]$Restart,                 # restart the judge even if it is already healthy
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Scripts = Join-Path $Root 'scripts'
$OcPlugin = Join-Path $Root 'oc\router-laya.js'

$script:StepNo = 0
function Step([string]$Text) { $script:StepNo++; Write-Host ""; Write-Host ("[{0}] {1}" -f $script:StepNo, $Text) -ForegroundColor Cyan }
function Ok([string]$Text)   { Write-Host "    OK   $Text" -ForegroundColor Green }
function Info([string]$Text) { Write-Host "    ..   $Text" -ForegroundColor Gray }
function Warn([string]$Text) { Write-Host "    !!   $Text" -ForegroundColor Yellow }
function Die([string]$Text)  { Write-Host "    FAIL $Text" -ForegroundColor Red; exit 1 }

function Require-Command([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Die "missing '$Name' -- $Hint" }
}

function Invoke-External {
  # run and return @{ Code; Output }
  param([string]$File, [string[]]$Arguments, [string]$WorkDir = $Root)
  if ($DryRun) { Info ("DRYRUN: {0} {1}" -f $File, ($Arguments -join ' ')); return @{ Code = 0; Output = @() } }
  $out = & $File @Arguments 2>&1
  return @{ Code = $LASTEXITCODE; Output = $out }
}

Write-Host "dsh-router-laya deployer" -ForegroundColor White
Write-Host ("  root={0}  port={1}  timeoutMs={2}  dryRun={3}" -f $Root, $Port, $TimeoutMs, [bool]$DryRun)

# ---------------------------------------------------------------- 1. preflight
Step "Preflight"
Require-Command python "install Python >= 3.10 (3.12 recommended)"
Require-Command node   "install Node.js >= 18"
Require-Command npm    "install Node.js (npm ships with it)"

$pyVer = (& python --version 2>&1) -join ' '
$nodeVer = (& node --version 2>&1) -join ' '
Info "python: $pyVer"
Info "node  : $nodeVer"

$npmPrefix = (& npm prefix -g).Trim()
if (-not $npmPrefix) { Die "could not resolve 'npm prefix -g'" }
$Svc = Join-Path $npmPrefix 'node_modules\dsh-router-laya'
Info "npm prefix: $npmPrefix"
Info "package   : $Svc"

if ($PSVersionTable.PSVersion.Major -lt 5) { Warn "PowerShell < 5 detected; scripts are written for PS 5.1+" }

# ---------------------------------------------------------------- 2. npm install
Step "npm package (dsh-router-laya)"
if (Test-Path $Svc) {
  Ok "already installed: $Svc"
} elseif ($SkipNpm) {
  Die "package missing and -SkipNpm set: $Svc"
} else {
  Info "installing globally (npm i -g dsh-router-laya) ..."
  $r = Invoke-External 'npm' @('i','-g','dsh-router-laya')
  if ($r.Code -ne 0) { $r.Output | Write-Host; Die "npm install failed" }
  if (-not $DryRun -and -not (Test-Path $Svc)) { Die "npm install finished but $Svc still missing" }
  Ok "installed"
}

$ServiceScript = Join-Path $Svc 'service\laya_router.py'
$Manifest      = Join-Path $Svc 'weights\manifest.json'

# ---------------------------------------------------------------- 3. venv
Step "Python venv + requirements"
$pkgVenv = Join-Path $Svc '.venv-router'
$extVenv = Join-Path $env:USERPROFILE '.dsh-router-laya\venv'

function Test-Venv([string]$V) {
  if (-not $V) { return $false }
  return (Test-Path (Join-Path $V 'Scripts\python.exe'))
}

if ($VenvPath) { $Venv = $VenvPath }
elseif (Test-Venv $pkgVenv) { $Venv = $pkgVenv }
elseif (Test-Venv $extVenv) { $Venv = $extVenv }
else { $Venv = $extVenv }   # short, package-external path -> avoids WinError 206, survives npm upgrade

$VenvPy = Join-Path $Venv 'Scripts\python.exe'
Info "venv: $Venv"

$venvUsable = $false
if (Test-Venv $Venv) {
  $t = Invoke-External $VenvPy @('-c','import torch; print(torch.__version__)')
  if ($t.Code -eq 0) { $venvUsable = $true; Ok ("torch present: {0}" -f (($t.Output) -join ' ')) }
  else { Warn "venv exists but 'import torch' failed (maybe WinError 1114) -- will reinstall requirements" }
}

if (-not $venvUsable) {
  if ($SkipVenv) { Die "venv unusable at $Venv and -SkipVenv set" }
  if (-not (Test-Venv $Venv)) {
    Info "creating venv at $Venv ..."
    New-Item -ItemType Directory -Force -Path (Split-Path $Venv) | Out-Null
    $r = Invoke-External 'python' @('-m','venv',$Venv)
    if ($r.Code -ne 0) { $r.Output | Write-Host; Die "python -m venv failed" }
  }
  # requirements.lock.txt may be DLP-encrypted/renamed .IPGSD -> extract from the npm tarball
  $req = Join-Path $Svc 'service\requirements.lock.txt'
  if (-not (Test-Path $req)) {
    $alt = Get-ChildItem (Join-Path $Svc 'service') -Filter 'requirements.lock.*' -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -ne 'requirements.lock.txt' } | Select-Object -First 1
    if ($alt) {
      Warn "requirements.lock.txt missing/renamed (DLP?): $($alt.Name)"
      Info "extracting original from npm tarball ..."
      $tarDir = Join-Path $env:TEMP ("rl-pkg-" + [guid]::NewGuid().ToString('N').Substring(0,8))
      New-Item -ItemType Directory -Force -Path $tarDir | Out-Null
      & npm pack dsh-router-laya --pack-destination $tarDir 2>&1 | Out-Null
      $tgz = Get-ChildItem $tarDir -Filter '*.tgz' | Select-Object -First 1
      if (-not $tgz) { Die "npm pack produced no tarball" }
      $reqOut = Join-Path $Svc 'service\requirements.lock.extracted.txt'
      $pyForTar = $VenvPy
      $code = "import tarfile,sys; t=tarfile.open(r'$($tgz.FullName)','r:gz'); m=t.extractfile('package/service/requirements.lock.txt'); open(r'$reqOut','wb').write(m.read()); print('extracted', r'$reqOut')"
      $r = Invoke-External $pyForTar @('-c',$code)
      if ($r.Code -ne 0) { Die "failed to extract requirements from tarball" }
      $req = $reqOut
      Ok "extracted requirements: $req"
    } else {
      Die "requirements.lock.txt not found under $Svc\service"
    }
  }
  Info "pip install -r $req ..."
  $r = Invoke-External $VenvPy @('-m','pip','install','--disable-pip-version-check','-r',$req)
  if ($r.Code -ne 0) {
    $r.Output | Write-Host
    Warn "pip failed. If it says [WinError 206] (path too long), retry with -VenvPath <short path>."
    Warn "If torch import later fails with WinError 1114, run scripts\msvc-fix.py (see README)."
    Die "pip install failed"
  }
  Ok "requirements installed"
} else {
  Ok "venv usable, skipping install"
}

# ---------------------------------------------------------------- 4. weights
Step "Weights (842 MB checkpoint)"
$modelFile = Join-Path $Svc 'weights\model\model.safetensors'
$needWeights = $true
if (Test-Path $modelFile) {
  $len = (Get-Item $modelFile).Length
  if ($len -eq 842609220) { $needWeights = $false; Ok "model.safetensors present ($len bytes)" }
  else { Warn "model.safetensors size $len != 842609220 -- re-fetching" }
}
if ($needWeights) {
  if ($SkipWeights) { Warn "-SkipWeights set; the judge may fail to load" }
  else {
    Info "running chunked downloader (resumable; may take ~20 min on a slow link) ..."
    $r = Invoke-External 'node' @((Join-Path $Scripts 'fetch-laya-chunked.mjs'), '--pkg', $Svc)
    if (-not $DryRun) { $r.Output | Write-Host }
    if ($r.Code -ne 0) { Die "weight download failed (re-run to resume)" }
    Ok "weights ready"
  }
} else { Ok "weights ready (cached)" }

# ---------------------------------------------------------------- 5. patch
Step "Apply local patches (threading + single-instance gate + CORS)"
if ($SkipPatch) {
  Warn "-SkipPatch set; the concurrency/timeout fixes were NOT applied"
} else {
  $r = Invoke-External 'python' @((Join-Path $Scripts 'patch-laya-router.py'), $ServiceScript)
  $r.Output | Write-Host
  if ($r.Code -ne 0) { Die "patching failed (upstream changed? see README troubleshooting)" }
  Ok "patched"
}

# ---------------------------------------------------------------- 6. OC plugin
Step "OpenCode plugin"
if ($NoOcPlugin) {
  Warn "-NoOcPlugin set; plugin not installed"
} else {
  if (-not (Test-Path $OcPlugin)) { Die "plugin source missing: $OcPlugin" }
  $cfg = Join-Path $env:USERPROFILE '.config\opencode'
  $cands = @((Join-Path $cfg 'plugins'), (Join-Path $cfg 'plugin'))
  $target = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $target) {
    $target = $cands[0]
    Info "no existing plugin dir; creating $target (if OC expects the singular 'plugin', copy the file there instead)"
  }
  $dest = Join-Path $target 'router-laya.js'
  if ($DryRun) { Info "DRYRUN: copy $OcPlugin -> $dest" }
  else {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item -LiteralPath $OcPlugin -Destination $dest -Force
  }
  Ok "plugin -> $dest"
  Info "judge timeout: set ROUTER_LAYA_TIMEOUT_MS=$TimeoutMs (plugin default). Restart OpenCode to load it."
}

# ---------------------------------------------------------------- 7. start + verify
Step "Start judge service and verify"
$listeners = @(netstat -ano | Select-String ":$Port\s.*LISTENING")
if ($listeners.Count -gt 0 -and -not $Restart) {
  Ok "already listening on $Port (use -Restart to restart)"
} else {
  if ($listeners.Count -gt 0) {
    Info "stopping existing listener(s) ..."
    $listeners | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique |
      ForEach-Object { if (-not $DryRun) { taskkill /PID $_ /F 2>&1 | Out-Null } }
    if (-not $DryRun) { Start-Sleep -Seconds 2 }
  }
  $pyw = Join-Path $Venv 'Scripts\pythonw.exe'
  $py  = if (Test-Path $pyw) { $pyw } else { $VenvPy }
  Info "spawning: $py $ServiceScript --http --port $Port"
  if ($DryRun) { Info "DRYRUN: start service" }
  else {
    Start-Process -FilePath $py -ArgumentList @($ServiceScript,'--http','--port',"$Port") -WindowStyle Hidden | Out-Null
  }
}

if ($DryRun) { Info "DRYRUN: skip verification"; Write-Host ""; Write-Host "DRY RUN COMPLETE" -ForegroundColor Yellow; exit 0 }

# wait for health (cold start ~40 s, slow up to 3 min)
$deadline = (Get-Date).AddSeconds(180)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 3
    if ($h.protocol -eq 'finetuned') { $healthy = $true; break }
  } catch { }
  Start-Sleep -Seconds 3
}
if (-not $healthy) {
  Warn "judge did not report protocol=finetuned within 180 s"
  Warn "check: netstat -ano | findstr :$Port   and   %TEMP%\laya-router-service*.log"
  Warn "if torch errored, run scripts\msvc-fix.py (README troubleshooting)"
  exit 1
}
Ok "health: protocol=finetuned"

# a real round-trip, via python (UTF-8 safe)
$probe = Join-Path $Scripts 'judge-probe.py'
if (Test-Path $probe) {
  $r = Invoke-External 'python' @($probe, '--base', "http://127.0.0.1:$Port")
  if (-not $DryRun) { $r.Output | Write-Host }
  if ($r.Code -eq 0) { Ok "judge round-trip OK" } else { Warn "judge round-trip failed" }
}

$n = @(netstat -ano | Select-String ":$Port\s.*LISTENING").Count
if ($n -eq 1) { Ok "exactly 1 listener (single-instance gate working)" }
else { Warn "$n listeners on $Port (expected 1) -- run the verify script for details" }

Write-Host ""
Write-Host "DEPLOY COMPLETE" -ForegroundColor Green
Write-Host "  judge   : http://127.0.0.1:$Port  (/health, /judge, /state)"
Write-Host "  next    : restart OpenCode to load the plugin; keep your picker on Default to let it route."
Write-Host "  verify  : powershell -File .\verify.ps1"
