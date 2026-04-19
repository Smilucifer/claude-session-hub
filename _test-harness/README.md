# Mobile PWA Test Harness

Standalone mock backend + Playwright-friendly bootstrap for iterating on
`renderer-mobile/` without touching the production Claude Session Hub
(Electron `mobile-server` on ports 3470–3479).

## Running

```powershell
cd C:\Users\lintian\claude-session-hub
node _test-harness/mock-server.js 3481
```

Then open `http://localhost:3481/_bootstrap` in any browser (including Chrome
DevTools mobile emulation or a real phone on the LAN). The bootstrap page
seeds `localStorage` with a mock token + address so the PWA skips pairing
and lands directly on the session list.

## Fixtures

`test-data.js` provides four sessions; the key one is **远程桌面** whose
buffer contains the exact combination that used to render badly on mobile:

- a 66-col Unicode box-drawing table
- ANSI colour codes (green/yellow/red status cells)
- a fenced code block
- a numbered list with inline `npm run test` spans
- a trailing Claude-Code `>` prompt chrome line

## Screenshots

The `screenshots/` folder captures the regression set:

| File | Viewport | What it shows |
|---|---|---|
| `before_01_list.png` | 390×856 | original list view |
| `before_02_session_remote.png` | 390×856 | **bug state** — table separator rows hidden, columns dangling |
| `after_10_auto_fit_applied.png` | 390×856 | fixed — auto-fit picked 10px, table fully rendered |
| `after_11_wide_session.png` | 760×1080 | fold-open viewport, 14px default, table fits comfortably |
| `final_01_narrow_list.png` | 390×856 | polished list (rounded cards, model badges, pin, unread border) |
| `final_04_permission_card_fixed2.png` | 390×856 | permission card stack above quick-bar |
| `final_06_scroll_with_fab.png` | 390×856 | scroll-to-bottom FAB visible when scrolled up |
