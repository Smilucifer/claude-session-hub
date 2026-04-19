# Claude Session Hub - 分享与分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同事能通过 clone + 一键脚本 或 下载 exe 安装包 两种方式快速安装 Claude Session Hub。

**Architecture:** 去除硬编码个人路径 → 将 hook 脚本纳入 repo → 编写 install.ps1 自动部署 → 添加 README → 配置 electron-builder 打包 → 发布 GitHub Release。

**Tech Stack:** PowerShell (install script), electron-builder (packaging), NSIS (Windows installer)

---

## File Map

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `create-shortcut.ps1` | 硬编码路径 → `$PSScriptRoot` 动态路径 |
| Modify | `core/session-manager.js` | 代理地址提取为顶部常量 |
| Modify | `main.js` | 添加 `ensureHooksDeployed()` 首次启动自动部署 hook |
| Modify | `package.json` | 添加 electron-builder 配置 + `dist` 脚本 |
| Modify | `.gitignore` | 添加 `*.exe` |
| Create | `scripts/session-hub-hook.py` | Hook 脚本模板（从当前 `~/.claude/scripts/` 复制） |
| Create | `scripts/claude-hub-statusline.js` | Statusline 脚本模板（同上） |
| Create | `install.ps1` | 一键安装脚本 |
| Create | `README.md` | 项目文档 |
| Create | `LICENSE` | MIT 许可证 |

---

### Task 1: 去硬编码 — `create-shortcut.ps1`

**Files:**
- Modify: `create-shortcut.ps1:108,136,144-146`

- [ ] **Step 1: 替换 ico 输出路径**

将第 108 行：
```powershell
$icoPath = "C:\Users\lintian\claude-session-hub\claude-wx.ico"
```
替换为：
```powershell
$icoPath = Join-Path $PSScriptRoot "claude-wx.ico"
```

- [ ] **Step 2: 替换快捷方式的 TargetPath/Arguments/WorkingDirectory**

将第 144-146 行：
```powershell
$s.TargetPath        = "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe"
$s.Arguments         = '"C:\Users\lintian\claude-session-hub"'
$s.WorkingDirectory  = "C:\Users\lintian\claude-session-hub"
```
替换为：
```powershell
$s.TargetPath        = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$s.Arguments         = "`"$PSScriptRoot`""
$s.WorkingDirectory  = $PSScriptRoot
```

- [ ] **Step 3: Commit**

```bash
git add create-shortcut.ps1
git commit -m "fix: replace hardcoded paths with dynamic \$PSScriptRoot in create-shortcut.ps1"
```

---

### Task 2: 去硬编码 — `session-manager.js` 代理常量

**Files:**
- Modify: `core/session-manager.js:53-56`

- [ ] **Step 1: 在文件顶部（第 4 行后）添加代理常量**

在 `const RING_BUFFER_BYTES = 8192;` 之后添加：
```javascript
// Default proxy for Claude sessions. Change if your proxy differs.
const CLAUDE_PROXY = 'http://127.0.0.1:7890';
```

- [ ] **Step 2: 替换 createSession 中的硬编码代理**

将第 53-56 行：
```javascript
      sessionEnv.HTTP_PROXY = 'http://127.0.0.1:7890';
      sessionEnv.HTTPS_PROXY = 'http://127.0.0.1:7890';
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
```
替换为：
```javascript
      sessionEnv.HTTP_PROXY = CLAUDE_PROXY;
      sessionEnv.HTTPS_PROXY = CLAUDE_PROXY;
      sessionEnv.NO_PROXY = 'localhost,127.0.0.1';
```

- [ ] **Step 3: Commit**

```bash
git add core/session-manager.js
git commit -m "refactor: extract proxy address to CLAUDE_PROXY constant"
```

---

### Task 3: 将 hook 脚本纳入 repo

**Files:**
- Create: `scripts/session-hub-hook.py`（从 `~/.claude/scripts/session-hub-hook.py` 复制）
- Create: `scripts/claude-hub-statusline.js`（从 `~/.claude/scripts/claude-hub-statusline.js` 复制）

- [ ] **Step 1: 创建 scripts/ 目录并复制 hook 脚本**

```bash
mkdir -p scripts
cp ~/.claude/scripts/session-hub-hook.py scripts/session-hub-hook.py
cp ~/.claude/scripts/claude-hub-statusline.js scripts/claude-hub-statusline.js
```

- [ ] **Step 2: 验证文件内容完整**

```bash
head -5 scripts/session-hub-hook.py
head -5 scripts/claude-hub-statusline.js
```

预期：session-hub-hook.py 开头 `#!/usr/bin/env python3`，statusline.js 开头 `#!/usr/bin/env node`。

- [ ] **Step 3: Commit**

```bash
git add scripts/
git commit -m "feat: add hook scripts to repo for automated deployment"
```

---

### Task 4: 首次启动自动部署 hook — `main.js`

**Files:**
- Modify: `main.js`（在 `app.whenReady()` 附近添加 `ensureHooksDeployed()`）

- [ ] **Step 1: 在 main.js 顶部（require 区之后、第一个函数定义之前）添加 ensureHooksDeployed 函数**

在 `const mobileAuth = require('./core/mobile-auth.js');` 之后添加：

```javascript
// Auto-deploy hook scripts + settings.json config on first launch.
// Idempotent — skips if already present, never overwrites user's existing hooks.
function ensureHooksDeployed() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const claudeDir = path.join(home, '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');

  // 1. Copy hook scripts if missing
  const srcDir = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');

  const scriptFiles = ['session-hub-hook.py', 'claude-hub-statusline.js'];
  for (const file of scriptFiles) {
    const dest = path.join(scriptsDir, file);
    const src = path.join(srcDir, file);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.copyFileSync(src, dest);
      console.log(`[hub] deployed ${file} -> ${dest}`);
    }
  }

  // 2. Merge hook config into settings.json if not present
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const hookPy = path.join(scriptsDir, 'session-hub-hook.py').replace(/\\/g, '\\\\');
  const statusJs = path.join(scriptsDir, 'claude-hub-statusline.js').replace(/\\/g, '/');

  let changed = false;

  // Ensure hooks object
  if (!settings.hooks) settings.hooks = {};

  // Stop hook
  const stopCmd = `python "${hookPy}" stop`;
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  const hasStop = settings.hooks.Stop.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasStop) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: stopCmd, timeout: 5 }]
    });
    changed = true;
  }

  // UserPromptSubmit hook
  const promptCmd = `python "${hookPy}" prompt`;
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  const hasPrompt = settings.hooks.UserPromptSubmit.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('session-hub-hook'))
  );
  if (!hasPrompt) {
    settings.hooks.UserPromptSubmit.push({
      matcher: '',
      hooks: [{ type: 'command', command: promptCmd, timeout: 5 }]
    });
    changed = true;
  }

  // Statusline
  if (!settings.statusLine || !String(settings.statusLine.command || '').includes('claude-hub-statusline')) {
    settings.statusLine = {
      type: 'command',
      command: `node "${statusJs}"`
    };
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('[hub] settings.json updated with hook config');
  }
}
```

- [ ] **Step 2: 在 app.whenReady() 回调最前面调用它**

找到 `app.whenReady().then(async () => {` （或等效代码），在其内部第一行添加：

```javascript
  ensureHooksDeployed();
```

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat: auto-deploy hook scripts and settings.json on first launch"
```

---

### Task 5: 编写 install.ps1 一键安装脚本

**Files:**
- Create: `install.ps1`

- [ ] **Step 1: 创建 install.ps1**

```powershell
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
# Ensure hooks structure
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
    # Ensure .claude directory exists
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
```

- [ ] **Step 2: Commit**

```bash
git add install.ps1
git commit -m "feat: add one-click install.ps1 for automated setup"
```

---

### Task 6: 编写 README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: 创建 README.md**

```markdown
# Claude Session Hub

Chat-style multi-session terminal manager for Claude Code on Windows.
Manage multiple Claude Code sessions in a single window — like WeChat, but for AI coding.

## Features

- **Multi-session tabs** — Create, switch, pin, and close Claude Code sessions
- **Dormant restore** — Sessions survive app restart; resume exactly where you left off
- **Unread badges** — Know which sessions have new AI replies
- **Context & usage monitoring** — Real-time context window % and 5h/7d rate limit bars
- **Terminal superpowers** — In-terminal search (Ctrl+F), URL click-to-open, file drag-and-drop
- **Mobile remote** — Control sessions from your phone via PWA (Tailscale-friendly)
- **Keyboard-first** — Full shortcut coverage (see below)

## Prerequisites

- **Windows 10/11**
- **Claude Code CLI** installed and logged in (`claude --version` to verify)
- **Clash proxy** running on `127.0.0.1:7890` (or edit `CLAUDE_PROXY` in `core/session-manager.js`)

## Quick Start

### Option A: From Source (recommended for developers)

```powershell
git clone https://github.com/TianLin0509/claude-session-hub.git
cd claude-session-hub
.\install.ps1
```

The installer will:
1. Check Node.js >= 18
2. Run `npm install` (compiles native modules — needs C++ Build Tools)
3. Deploy hook scripts to `~/.claude/scripts/`
4. Configure Claude Code hooks in `~/.claude/settings.json`
5. Create a desktop shortcut

> **node-pty compilation fails?** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload.

### Option B: Download Installer

Go to [Releases](https://github.com/TianLin0509/claude-session-hub/releases), download the latest `.exe`, and run it. No Node.js or build tools needed.

## First Launch

1. Double-click the **Claude Hub** desktop shortcut
2. Press **Ctrl+N** to create your first Claude session
3. If this is your first time, type `/login` in the terminal to authenticate

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New Claude session |
| Ctrl+W | Close current session |
| Ctrl+Tab | Next session |
| Ctrl+Shift+Tab | Previous session |
| Ctrl+1..9 | Jump to session N |
| Ctrl+B | Toggle sidebar |
| Ctrl+F | Search in terminal |
| Ctrl+K | Focus sidebar search |
| Ctrl+C | Copy selection (or SIGINT if no selection) |
| Ctrl+V | Paste (text or image) |
| Ctrl+=/- | Zoom in/out |
| Ctrl+0 | Reset font size |
| Ctrl+End/Home | Scroll to bottom/top |

## Configuration

### Proxy

Default proxy is `http://127.0.0.1:7890` (Clash). To change, edit the `CLAUDE_PROXY` constant at the top of `core/session-manager.js`.

### Hook Scripts

Installed to `~/.claude/scripts/`:
- `session-hub-hook.py` — Notifies Hub when Claude finishes a reply
- `claude-hub-statusline.js` — Sends context/usage data to Hub's sidebar

These are registered in `~/.claude/settings.json` under `hooks` and `statusLine`.

## Uninstall

1. Delete the `claude-session-hub` folder
2. Remove hook entries from `~/.claude/settings.json` (search for `session-hub-hook`)
3. Delete `~/.claude/scripts/session-hub-hook.py` and `~/.claude/scripts/claude-hub-statusline.js`
4. Delete `~/.claude-session-hub/` (runtime state)

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with install guide, shortcuts, and configuration"
```

---

### Task 7: 添加 LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: 创建 MIT LICENSE 文件**

```
MIT License

Copyright (c) 2026 Claude Session Hub Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT license"
```

---

### Task 8: 配置 electron-builder 打包

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: 在 package.json 中添加 electron-builder 到 devDependencies**

在 `devDependencies` 中添加：
```json
"electron-builder": "^26.0.0"
```

- [ ] **Step 2: 在 package.json 的 scripts 中添加 dist 命令**

在 `scripts` 对象中添加：
```json
"dist": "electron-builder --win"
```

- [ ] **Step 3: 在 package.json 中添加 build 配置**

在 package.json 顶层添加 `build` 字段：
```json
"build": {
  "appId": "com.claude-session-hub",
  "productName": "Claude Session Hub",
  "win": {
    "target": "nsis",
    "icon": "claude-wx.ico"
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "installerIcon": "claude-wx.ico",
    "uninstallerIcon": "claude-wx.ico",
    "createDesktopShortcut": true
  },
  "files": [
    "main.js",
    "core/**/*",
    "renderer/**/*",
    "renderer-mobile/**/*",
    "scripts/**/*",
    "claude-wx.ico",
    "package.json"
  ],
  "extraResources": [
    {
      "from": "scripts",
      "to": "scripts"
    }
  ]
}
```

- [ ] **Step 4: 在 .gitignore 中添加 exe**

在 `.gitignore` 末尾追加：
```
*.exe
```

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git commit -m "feat: add electron-builder config for Windows installer packaging"
```

---

### Task 9: 构建安装包并发布 GitHub Release

**Files:** 无代码改动，纯操作步骤

- [ ] **Step 1: 安装 electron-builder**

```bash
cd C:/Users/lintian/claude-session-hub
npm install
```

- [ ] **Step 2: 构建安装包**

```bash
npm run dist
```

预期产物在 `dist/` 目录下，包含 `Claude Session Hub Setup x.x.x.exe`。

- [ ] **Step 3: 验证安装包可运行**

在一个干净路径下运行生成的 exe，确认：
- 安装向导正常弹出
- 安装完成后桌面有快捷方式
- 启动后 Hub 窗口正常显示

> 注意：这一步需要用户手动验证，不在自动化 CI 范围内。

- [ ] **Step 4: 创建 GitHub Release**

```bash
gh release create v0.1.0 "dist/Claude Session Hub Setup 0.1.0.exe" \
  --title "v0.1.0 — First Public Release" \
  --notes "First shareable release of Claude Session Hub.

## Install

### Option A: From Source
\`\`\`powershell
git clone https://github.com/TianLin0509/claude-session-hub.git
cd claude-session-hub
.\\install.ps1
\`\`\`

### Option B: Download Installer
Download \`Claude.Session.Hub.Setup.0.1.0.exe\` below and run it.

## Prerequisites
- Claude Code CLI installed and logged in
- Clash proxy on 127.0.0.1:7890

See [README](https://github.com/TianLin0509/claude-session-hub#readme) for full docs."
```

- [ ] **Step 5: 验证 Release 页面**

浏览器打开 `https://github.com/TianLin0509/claude-session-hub/releases` 确认 exe 可下载。
