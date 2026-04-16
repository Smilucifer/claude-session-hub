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
