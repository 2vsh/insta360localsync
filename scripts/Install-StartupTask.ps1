[CmdletBinding()]
param(
    [string]$TaskName = 'Insta360 Local Sync',
    [string]$Config,
    [switch]$AtBoot,
    [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Config) { $Config = Join-Path $projectRoot 'config.json' }
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $settings.autoSync) { throw 'Enable automatic checks and save settings in the app first.' }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$serverPath = Join-Path $projectRoot 'server.mjs'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw "Task '$TaskName' already exists. Remove or rename it before installing another." }
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument ('"{0}" --config "{1}"' -f $serverPath, $configPath) -WorkingDirectory $projectRoot
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if ($AtBoot) {
    # Run this mode from an elevated PowerShell on a server. SYSTEM has no user
    # drive mappings; use a local destination outside OneDrive/user-only storage.
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
} else {
    $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
    $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
}
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $taskSettings -Principal $principal -Description 'Download new Insta360 footage into the configured local folder.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
Write-Host "Installed '$TaskName'. Close any foreground sync app before starting the task."
Write-Host 'Open http://127.0.0.1:8640 (or the port in your config) to view it.'
