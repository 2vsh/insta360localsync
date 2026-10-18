[CmdletBinding()]
param([string]$TaskName = 'Insta360 Local Sync')
$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed '$TaskName'. Downloaded files and settings were kept."
