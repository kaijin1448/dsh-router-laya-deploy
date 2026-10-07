<#
  Pre-heat the Laya judge service shared by the OC and DSH router-laya plugins.
    - idempotent: exits at once when the service is already healthy
    - hidden: launches pythonw.exe (no console window)
    - spawn matches the plugins exactly: <script> --http --port 8765, PYTHONIOENCODING=utf-8

  Paths auto-detect from `npm prefix -g`; override with env vars
  ROUTER_LAYA_PYTHON / ROUTER_LAYA_SCRIPT or the -Python/-Script params.

  Install (login task, delayed 30 s), see docs/router-laya-install-guide.md appendix E:
    $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"<path>\warm-laya-judge.vbs"'
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $trigger.Delay = 'PT30S'
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName 'warm-laya-judge' -Action $action -Trigger $trigger -Settings $settings -Force
#>
[CmdletBinding()]
param(
  [string]$Python = $env:ROUTER_LAYA_PYTHON,
  [string]$Script = $env:ROUTER_LAYA_SCRIPT,
  [int]$Port = 8765,
  [int]$WaitSeconds = 180
)
$ErrorActionPreference = 'SilentlyContinue'

if (-not $Python -or -not $Script) {
  $prefix = (& npm prefix -g).Trim()
  if (-not $Python) {
    $py  = Join-Path $prefix 'node_modules\dsh-router-laya\.venv-router\Scripts\python.exe'
    $pyw = $py -replace 'python(\.exe)?$', 'pythonw.exe'
    $Python = if (Test-Path $pyw) { $pyw } else { $py }
  }
  if (-not $Script) {
    $Script = Join-Path $prefix 'node_modules\dsh-router-laya\service\laya_router.py'
  }
}

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
