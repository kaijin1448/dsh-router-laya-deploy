' launch the pre-heat script with no visible window
' Adjust the path to wherever you put warm-laya-judge.ps1, or set it via the
' ROUTER_LAYA_PREHEAT_PS1 env var if you start this from a wrapper.
Option Explicit
Dim sh, fso, ps1, env
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set env = sh.Environment("PROCESS")

ps1 = env("ROUTER_LAYA_PREHEAT_PS1")
If ps1 = "" Then
  ' default: alongside this .vbs
  ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "warm-laya-judge.ps1")
End If

sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
