<#
.SYNOPSIS
  Verify a dsh-router-laya deployment end to end.
.DESCRIPTION
  Checks: /health protocol, exactly one listener (single-instance gate), patched
  service markers, a real /judge round-trip, the OC plugin file, and the ticket
  plugin timeout vs. measured judging latency.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\verify.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [string]$VenvPath = ""
)
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$pass = 0; $fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  if ($Ok) { $script:pass++; Write-Host ("  PASS  {0}" -f $Name) -ForegroundColor Green }
  else     { $script:fail++; Write-Host ("  FAIL  {0}  {1}" -f $Name, $Detail) -ForegroundColor Red }
}

$npmPrefix = (& npm prefix -g 2>$null).Trim()
$Svc = Join-Path $npmPrefix 'node_modules\dsh-router-laya'

Write-Host "verifying dsh-router-laya on port $Port" -ForegroundColor White

# 1. service health
$proto = $null
try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 4; $proto = $h.protocol } catch {}
Check "health protocol=finetuned" ($proto -eq 'finetuned') "got '$proto'"

# 2. single listener
$n = @(netstat -ano | Select-String ":$Port\s.*LISTENING").Count
Check "exactly 1 listener" ($n -eq 1) "found $n"

# 3. patched service markers
$svcPy = Join-Path $Svc 'service\laya_router.py'
if (Test-Path $svcPy) {
  $src = Get-Content $svcPy -Raw
  Check "patch: ThreadingHTTPServer" ($src -match 'ThreadingHTTPServer')
  Check "patch: _judge_lock"          ($src -match '_judge_lock')
  Check "patch: _claim_single_instance" ($src -match '_claim_single_instance')
  Check "patch: dsh-app CORS"         ($src -match 'dsh-app://')
  # re-check via the patcher itself
  $chk = & python (Join-Path $Root 'scripts\patch-laya-router.py') $svcPy --check 2>&1
  Check "patcher reports all present" (($chk -join "`n") -notmatch 'MISSING') ($chk -join '; ')
} else {
  Check "service source present" $false $svcPy
}

# 4. judge round-trip (UTF-8 safe via python)
$probe = Join-Path $Root 'scripts\judge-probe.py'
if ((Test-Path $probe) -and (Get-Command python -ErrorAction SilentlyContinue)) {
  $out = & python $probe --base "http://127.0.0.1:$Port" 2>&1
  $ok = ($out -join "`n") -match 'TIER=(low|high|max)'
  Check "judge round-trip returns a tier" $ok
  if ($ok) { ($out | Select-String 'TIER=').Line | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray } }
} else {
  Check "judge-probe.py available" $false
}

# 5. weights
$mf = Join-Path $Svc 'weights\model\model.safetensors'
Check "model.safetensors 842,609,220 B" ((Test-Path $mf) -and ((Get-Item $mf).Length -eq 842609220))

# 6. OC plugin
$cfg = Join-Path $env:USERPROFILE '.config\opencode'
$pluginCands = @(
  (Join-Path $cfg 'plugins\router-laya.js'),
  (Join-Path $cfg 'plugin\router-laya.js')
)
$plugin = $pluginCands | Where-Object { Test-Path $_ } | Select-Object -First 1
Check "OC plugin installed" ([bool]$plugin) "looked in $cfg\{plugins,plugin}\router-laya.js"

# 7. timeout vs latency
if (Test-Path (Join-Path $env:TEMP 'router-laya-oc.log')) {
  $ms = Select-String -Path (Join-Path $env:TEMP 'router-laya-oc.log') -Pattern '\(laya, (\d+)ms\)' |
        ForEach-Object { [int][regex]::Match($_.Line,'\(laya, (\d+)ms\)').Groups[1].Value }
  if ($ms) {
    $max = ($ms | Measure-Object -Maximum).Maximum
    $timeout = if ($env:ROUTER_LAYA_TIMEOUT_MS) { [int]$env:ROUTER_LAYA_TIMEOUT_MS } else { 10000 }
    Check "timeout ($timeout ms) >= max observed ($max ms)" ($timeout -ge $max)
  }
}

Write-Host ""
Write-Host ("RESULT: {0} passed, {1} failed" -f $pass, $fail) -ForegroundColor ($(if ($fail -eq 0) {'Green'} else {'Red'}))
exit $(if ($fail -eq 0) { 0 } else { 1 })
