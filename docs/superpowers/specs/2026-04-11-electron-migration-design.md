# Electron Migration Design Spec

## Context

Session Hub currently uses Browser + Express + WebSocket architecture. The WebSocket layer causes ConPTY escape sequence leaks (CPR), port conflicts, warm pool incompatibility, and adds unnecessary latency. Migrating to Electron eliminates the WebSocket layer entirely, replacing it with direct IPC.

Backup tag `v1.0-browser` preserves the browser-based implementation.

## Architecture

```
Electron Main Process (main.js)
+-- SessionManager (reused from session-manager.ts)
+-- node-pty (direct PTY management)
+-- HTTP Server (hook endpoints only: /api/hook/stop, /api/hook/prompt)
+-- IPC Bridge -> Renderer

Electron Renderer Process (index.html + renderer.js)
+-- Native DOM (no React)
+-- xterm.js + FitAddon + Unicode11Addon (no WebGL)
+-- Session list, terminal panel, dropdown menu
+-- IPC <- Main
```

Data flow comparison:
- Old: PTY -> node-pty -> Express -> WebSocket serialize -> network -> browser parse -> xterm.js
- New: PTY -> node-pty -> IPC -> xterm.js (two fewer hops)

## File Structure

```
claude-session-hub/
  package.json          # Add electron dep, update scripts
  main.js               # Electron main process
  preload.js            # IPC bridge via contextBridge
  renderer/
    index.html          # Single page
    renderer.js         # Native DOM logic (replaces React)
    styles.css          # Reuse global.css with minor tweaks
  core/
    session-manager.js  # Reuse from src/server/session-manager.ts
    types.js            # Reuse from src/server/types.ts
  start.bat             # electron .
  src/                  # Old code preserved, not deleted
```

## IPC Protocol

Same message types as the existing WebSocket protocol, transported via Electron IPC:

### Renderer -> Main
- `create-session` `{ kind: 'claude' | 'powershell' }`
- `close-session` `{ sessionId }`
- `terminal-input` `{ sessionId, data }`
- `terminal-resize` `{ sessionId, cols, rows }`
- `focus-session` `{ sessionId }`
- `rename-session` `{ sessionId, title }`
- `mark-read` `{ sessionId }`

### Main -> Renderer
- `sessions` `{ sessions[] }`
- `session-created` `{ session }`
- `session-closed` `{ sessionId }`
- `session-updated` `{ session }`
- `terminal-data` `{ sessionId, data }`

## Reuse Plan

| Source File | Action |
|---|---|
| session-manager.ts | Reuse core logic, convert to .js, strip TS types |
| types.ts | Convert to .js, types become JSDoc comments |
| global.css | Reuse 95%, remove Vite/React specifics |
| SessionList/SessionItem logic | Rewrite in native DOM, same layout/style/behavior |
| TerminalPanel logic | Simplify: no React hooks, no WebGL, keep xterm.js + FitAddon |
| useWebSocket.ts | Delete, replaced by IPC |
| index.ts (Express) | Delete, hook endpoints move to main.js |
| session-hub-hook.py | No change, still POSTs to localhost:3456 |

## Key Design Decisions

1. **Pure JS, no TypeScript** - No build step, change and restart immediately
2. **Canvas renderer only** - No WebGL addon, eliminates GPU context loss crashes
3. **Hook HTTP server in main process** - Only `/api/hook/*` endpoints, hook script unchanged
4. **preload.js isolation** - Renderer cannot access node-pty directly, uses contextBridge API
5. **Debounce 200ms retained** - Claude session startup logic unchanged
6. **No electron-builder** - Dev mode only (`electron .`), start.bat for launch

## Features Retained

1. "+" dropdown menu: Claude Code / PowerShell selection
2. Claude auto-proxy + auto-launch
3. PowerShell with full profile
4. Session list with unread badges and time sorting
5. Chinese preview extraction (hook window + CJK segment extraction)
6. Hook-driven status updates (running/idle)
7. Inline title rename
8. Close session with PTY cleanup

## Feature Removed

- WebGL addon (source of GPU context loss crashes, Canvas renderer sufficient)

## Verification Plan

1. `electron .` starts -> window shows Session Hub UI
2. Click "+" -> Claude Code -> starts normally, no CPR leak
3. Chat produces correct Chinese preview in sidebar
4. Hook-driven running/idle status works
5. Multi-session switching, unread badges, rename all work
6. Close session cleans up PTY properly
