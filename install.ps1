#Requires -Version 5.1
<#
.SYNOPSIS
    One-click installer for Claude Session Hub.
.DESCRIPTION
    Checks prerequisites, runs npm install, deploys hook scripts,
    injects Claude Code settings, and creates a desktop shortcut.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot

Write-Host "`n=== Claude Session Hub Installer ===" -ForegroundColor Cyan

# Step 1: Check Node.js
Write-Host "`n[1/5] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = (node --version 2>&1).ToString().TrimStart('v')
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 18) {
        Write-Host "Node.js $nodeVersion found, but >= 18 required." -ForegroundColor Red
        Write-Host "Download: https://nodejs.org/" -ForegroundColor Gray
        exit 1
    }
    Write-Host "  Node.js v$nodeVersion OK" -ForegroundColor Green
} catch {
    Write-Host "  Node.js not found. Install from https://nodejs.org/ (LTS >= 18)" -ForegroundColor Red
    exit 1
}

# Step 2: npm install
Write-Host "`n[2/5] Installing dependencies (npm install)..." -ForegroundColor Yellow
Write-Host "  This may take a few minutes (node-pty requires C++ compilation)." -ForegroundColor Gray
Push-Location $ProjectRoot
try {
    npm install 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  npm install failed." -ForegroundColor Red
        Write-Host "  If node-pty compilation failed, install C++ Build Tools:" -ForegroundColor Yellow
        Write-Host "    npm install -g windows-build-tools" -ForegroundColor Gray
        Write-Host "  Or install Visual Studio Build Tools from:" -ForegroundColor Gray
        Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Gray
        exit 1
    }
    Write-Host "  Dependencies installed OK" -ForegroundColor Green
} finally {
    Pop-Location
}

# Step 3: Deploy hook scripts
Write-Host "`n[3/5] Deploying hook scripts..." -ForegroundColor Yellow
$claudeScripts = Join-Path $env:USERPROFILE ".claude\scripts"
if (-not (Test-Path $claudeScripts)) {
    New-Item -ItemType Directory -Path $claudeScripts -Force | Out-Null
}
$scripts = @("session-hub-hook.py", "claude-hub-statusline.js")
foreach ($s in $scripts) {
    $src = Join-Path $ProjectRoot "scripts\$s"
    $dst = Join-Path $claudeScripts $s
    if (Test-Path $dst) {
        Write-Host "  $s already exists, skipping (won't overwrite)" -ForegroundColor Gray
    } else {
        Copy-Item $src $dst
        Write-Host "  Deployed $s" -ForegroundColor Green
    }
}

# Step 4: Inject Claude Code settings.json hooks
Write-Host "`n[4/5] Configuring Claude Code hooks..." -ForegroundColor Yellow
$settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
$settings = @{}
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json -AsHashtable
}
if (-not $settings.ContainsKey('hooks')) { $settings['hooks'] = @{} }
$hookPyPath = (Join-Path $claudeScripts "session-hub-hook.py") -replace '\\', '\\'
$statusJsPath = (Join-Path $claudeScripts "claude-hub-statusline.js") -replace '\\', '/'

$changed = $false

# Stop hook
$stopCmd = "python `"$hookPyPath`" stop"
if (-not $settings['hooks'].ContainsKey('Stop')) { $settings['hooks']['Stop'] = @() }
$hasStop = $settings['hooks']['Stop'] | Where-Object {
    $_.hooks | Where-Object { $_.command -like '*session-hub-hook*' }
}
if (-not $hasStop) {
    $settings['hooks']['Stop'] += @{
        matcher = ''
        hooks = @(@{ type = 'command'; command = $stopCmd; timeout = 5 })
    }
    $changed = $true
    Write-Host "  Added Stop hook" -ForegroundColor Green
} else {
    Write-Host "  Stop hook already configured, skipping" -ForegroundColor Gray
}

# UserPromptSubmit hook
$promptCmd = "python `"$hookPyPath`" prompt"
if (-not $settings['hooks'].ContainsKey('UserPromptSubmit')) { $settings['hooks']['UserPromptSubmit'] = @() }
$hasPrompt = $settings['hooks']['UserPromptSubmit'] | Where-Object {
    $_.hooks | Where-Object { $_.command -like '*session-hub-hook*' }
}
if (-not $hasPrompt) {
    $settings['hooks']['UserPromptSubmit'] += @{
        matcher = ''
        hooks = @(@{ type = 'command'; command = $promptCmd; timeout = 5 })
    }
    $changed = $true
    Write-Host "  Added UserPromptSubmit hook" -ForegroundColor Green
} else {
    Write-Host "  UserPromptSubmit hook already configured, skipping" -ForegroundColor Gray
}

# Statusline
$hasStatusLine = $settings.ContainsKey('statusLine') -and ($settings['statusLine'].command -like '*claude-hub-statusline*')
if (-not $hasStatusLine) {
    $settings['statusLine'] = @{
        type = 'command'
        command = "node `"$statusJsPath`""
    }
    $changed = $true
    Write-Host "  Added statusLine config" -ForegroundColor Green
} else {
    Write-Host "  statusLine already configured, skipping" -ForegroundColor Gray
}

if ($changed) {
    $claudeDir = Join-Path $env:USERPROFILE ".claude"
    if (-not (Test-Path $claudeDir)) {
        New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
    }
    $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8
    Write-Host "  settings.json updated" -ForegroundColor Green
}

# Step 5: Create desktop shortcut
Write-Host "`n[5/5] Creating desktop shortcut..." -ForegroundColor Yellow
& (Join-Path $ProjectRoot "create-shortcut.ps1")

Write-Host "`n=== Installation Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Double-click the 'Claude Hub' icon on your Desktop to start." -ForegroundColor White
Write-Host "  First time: run /login inside the Hub to authenticate with Claude." -ForegroundColor White
Write-Host ""
