# Mobile Remote — Setup Guide

PWA-based phone remote for Claude Session Hub. One-time pair + long-lived token + multi-address auto-discovery. Works over LAN, Tailscale, Cloudflare Tunnel, or any other path that reaches the Hub's port 3470.

## Architecture at a glance

```
[Phone PWA]  --HTTP+WebSocket-->  [Electron Hub main process]
                                    sessionManager (PTY pool)
                                    hookServer 3456-3460
                                    mobileServer 3470   <-- new
                                      + Express static serves /renderer-mobile
                                      + REST /api/*
                                      + WebSocket /ws
```

All session data lives in the desktop Hub. The phone is a thin live mirror.

## One-time deploy steps (only once, after upgrading the Hub)

### 1. Update the hook script

Confirm `~/.claude/scripts/session-hub-hook.py` contains the `tool-use` branch. The Phase 4 refactor of this plan added:

- Parsing `tool_name` + `tool_input` from stdin
- New `event == 'tool-use'` URL routing to `CLAUDE_HUB_MOBILE_PORT` (defaults to 3470)

If you're upgrading from an older Hub, pull the latest version of this script from this repo's documentation (or the commit that introduced Phase 4).

### 2. Register the catch-all PreToolUse hook

Add to `~/.claude/settings.json` under `hooks.PreToolUse`, **adding a second array element alongside any existing Bash-matched hooks**:

```json
"PreToolUse": [
  { "matcher": "Bash", "hooks": [ /* keep existing cli-caller / refactor_guard hooks */ ] },
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\lintian\\.claude\\scripts\\session-hub-hook.py\" tool-use",
        "timeout": 3
      }
    ]
  }
]
```

**Caveat:** this catch-all fires before **every** tool call in **every** Claude Code session (including sessions outside the Hub), adding ~30 ms of Python startup overhead each. Hook exits immediately if `CLAUDE_HUB_SESSION_ID` is not set, so out-of-Hub sessions incur only the subprocess cost, no network calls. If the overhead becomes noticeable you can comment out this block and lose only the permission-card preview feature.

Verify the JSON parses:
```bash
python -c "import json;json.load(open(r'C:/Users/lintian/.claude/settings.json'))" && echo ok
```

### 3. Restart the Hub

Close and re-launch Claude Session Hub. The console will print:
```
[mobile] listening on :3470
```

If `3470` is busy, it falls back to 3471-3479 automatically.

## One-time pairing (with phone in hand, on same LAN as computer)

1. In the Hub, click the **📱** button in the sidebar header.
2. The dialog auto-fills your LAN IPv4 addresses. **Add any extra addresses your phone should try later**:
   - Tailscale IP (see below) for cellular / public-network use
   - Any ngrok / Cloudflare Tunnel / frp endpoint you maintain
3. Name the device (e.g. `华为 Mate X6`), click **生成配对二维码**.
4. Scan the QR with your phone. Your browser opens to `/pair?...`; you'll see "配对成功 ✓" and land on the session list.
5. In Chrome / ArkWeb menu, choose **添加到主屏幕** (Add to Home Screen). An app-like icon appears on your phone home.

Done. Unless you clear browser data or revoke the device on the Hub, this phone stays paired permanently.

## Optional: Tailscale for public access

If you're away from home Wi-Fi (e.g. at work on cellular), Tailscale gives your Hub machine a fixed `100.x.x.x` IP reachable from anywhere you're logged into the Tailnet.

### Install
- **Computer (Windows)**:
  ```powershell
  winget install Tailscale.Tailscale
  ```
  Launch Tailscale from the tray, log in.
- **Phone**: Install "Tailscale" from App Gallery / Play Store / App Store, log in same account.

### Find your computer's Tailscale IP
```powershell
tailscale ip -4
# prints e.g. 100.64.0.12
```

### Add to pairing
When pairing (step 2 above), add `100.64.0.12:3470` to the address list.

Now the PWA tries all addresses in parallel on every open — LAN wins when home, Tailscale wins on cellular, zero manual switching.

## Revoking a device

Open the Hub → click **📱** → scroll to **已配对设备** → click **撤销** on the row. The phone immediately stops working.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| PWA shows `未配对` | localStorage was cleared (e.g. "clear site data") | Re-pair via QR |
| PWA shows `所有已知地址均不可达` | Hub is off / address list stale | Start Hub; verify `curl http://<IP>:3470/api/ping` returns 401 (server reachable) |
| Chinese prompts display garbage in Claude | Python stdin decode bug | This Hub's hook uses UTF-8 explicitly; if you see this, check no other tool is wrapping stdin |
| Permission card never appears | PreToolUse catch-all missing from `settings.json` | See step 2 above |
| `tailscale ip -4` returns nothing | Tailscale not logged in | Launch Tailscale from tray, log in |

## Security notes

- Every WS frame and HTTP request is gated by a 256-bit random token (bcrypt-hashed on server, stored plain in phone's `localStorage`).
- One token is bound to one `deviceId` on first register — re-using a leaked QR on a second phone is rejected.
- `/api/hook/tool-use` is loopback-only (127.0.0.1) — other LAN devices cannot inject fake permission cards.
- Revoking a device deletes its bcrypt hash; the phone gets 401 immediately.
- Mobile server binds to `0.0.0.0:3470` so any LAN peer can reach `/api/ping` / `/ws` handshake, but without a valid token they're 401'd.

## What's intentionally NOT supported (MVP scope)

- Creating / closing / restarting sessions from the phone (keep on desktop)
- Web Push notifications (use existing Hook → Server 酱 / 企业微信 machine integration instead)
- iOS deep testing (Mate X6 is the reference target)
- Voice input, photo paste
- Ring-buffer replay on reconnect (lastSeq is plumbed but replay logic deferred)
