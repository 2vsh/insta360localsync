[CmdletBinding()]
param(
    [string]$Destination,
    [string]$CameraUrl,
    [string]$Config,
    [int]$Port = 0,
    [switch]$Demo,
    [switch]$Once,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
try {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = [version](& $nodeExe -p 'process.versions.node')
    if ($nodeVersion -lt [version]'22.13.0') { throw 'Install Node.js 22.13 or newer from https://nodejs.org/ and reopen this launcher.' }
    $configPath = if ($Config) { [System.IO.Path]::GetFullPath($Config) } else { Join-Path $projectRoot 'config.json' }
    $nodeArgs = @((Join-Path $projectRoot 'server.mjs'))
    if ($Demo) {
        if ($Once) { throw 'Use -Demo or -Once separately.' }
        $nodeArgs += '--demo'
        if ($Port -eq 0) { $Port = 8641 }
    } else {
        if (Test-Path -LiteralPath $configPath) {
            $settingsObject = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else {
            $settingsObject = Get-Content -LiteralPath (Join-Path $projectRoot 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $Destination) {
                Add-Type -AssemblyName System.Windows.Forms
                $picker = New-Object System.Windows.Forms.FolderBrowserDialog
                try {
                    $picker.Description = 'Choose the folder where your Insta360 X5 footage should be downloaded.'
                    $picker.ShowNewFolderButton = $true
                    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { Write-Host 'No folder selected. Nothing started.'; exit 0 }
                    $Destination = $picker.SelectedPath
                } finally { $picker.Dispose() }
            }
        }
        if ($Destination) { $settingsObject.destination = [System.IO.Path]::GetFullPath($Destination) }
        if ($CameraUrl) { $settingsObject.cameraUrl = $CameraUrl }
        if ($Port -ne 0) { $settingsObject.port = $Port }
        # Validate through the same code as the app before replacing any settings.
        $configJson = $settingsObject | ConvertTo-Json -Depth 5
        $OutputEncoding = New-Object System.Text.UTF8Encoding $false
        $validationScript = "import {validateConfig} from './lib/sync.mjs'; let s=''; for await (const c of process.stdin) s+=c; validateConfig(JSON.parse(s.replace(/^\uFEFF/,'')));"
        Push-Location -LiteralPath $projectRoot
        try { $configJson | & $nodeExe --input-type=module -e $validationScript; if ($LASTEXITCODE -ne 0) { throw 'Invalid settings. The existing config was kept.' } }
        finally { Pop-Location }
        $configJson | Set-Content -LiteralPath $configPath -Encoding UTF8
        $Port = $settingsObject.port
        $nodeArgs += @('--config', $configPath)
    }
    $nodeArgs += @('--port', [string]$Port)
    if ($Once) { $nodeArgs += '--once' }
    if (-not $NoBrowser -and -not $Once) { $nodeArgs += '--open' }
    Write-Host 'Insta360 Local Sync - keep this window open while downloading.'
    & $nodeExe @nodeArgs
    exit $LASTEXITCODE
} catch {
    Write-Host ('Could not start: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Requires Node.js 22.13 or newer: https://nodejs.org/'
    exit 1
}
