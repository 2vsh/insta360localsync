@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0scripts\Start-Sync.ps1" %*
set "syncExit=%errorlevel%"
if not "%syncExit%"=="0" pause
exit /b %syncExit%
