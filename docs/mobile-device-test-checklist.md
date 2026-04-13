# Real-Device Acceptance Checklist — Mate X6

Run through this after activating the PreToolUse catch-all hook and pairing your phone. Check off each line after verification.

## Setup

- [ ] Hub running; console shows `[mobile] listening on :3470`
- [ ] `~/.claude/settings.json` has the catch-all PreToolUse hook
- [ ] Paired phone via QR, opened PWA, "Add to Home Screen" done

## Outer screen (folded, ~6.45")

- [ ] Session list renders with correct title / preview / time / unread badge
- [ ] Tapping a session enters detail view
- [ ] xterm shows prior output (ring-buffer replay)
- [ ] Typing Chinese (e.g. "继续") via system IME — sent as received by Claude, no garbage
- [ ] Quick bar: ESC / Ctrl-C / 1允许 / 2拒绝 / ↑ all functional
- [ ] Back arrow returns to list
- [ ] Connection dot green when Hub running

## Inner screen (unfolded, ~7.93")

- [ ] Unfolding auto-switches to two-pane (list left 35%, terminal right 65%)
- [ ] Tapping a different session in left pane swaps right pane without full reload
- [ ] Folding back returns to single-column mode

## Tool permission card

- [ ] In a Claude session on desktop, ask Claude to run a Bash command
- [ ] Permission card slides up on phone with the command preview
- [ ] Tap "允许" — Claude proceeds (1\r sent to PTY)
- [ ] Tap "拒绝" on a subsequent prompt — Claude backs off (2\r sent)

## Network resilience

- [ ] Lock phone for 2 minutes; unlock — PWA reconnects WS within 3 seconds
- [ ] Switch from home Wi-Fi to cellular (with Tailscale running on Hub) — connection recovers via Tailscale address
- [ ] Switch back to Wi-Fi — connection switches back

## Revocation

- [ ] On desktop Hub, click 📱 → 撤销 on the test device
- [ ] Phone next action fails (401); red banner appears
