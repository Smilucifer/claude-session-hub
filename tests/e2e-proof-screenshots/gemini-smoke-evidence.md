# Gemini MCP Smoke Test Evidence

## Outcome

Gemini CLI session successfully starts via PTY with the correct MCP config
injected. CLI is **blocked at authentication** (environment issue, not a code
bug) — it never completes, so we can't yet verify `team_respond` tool call.

## Method

1. Created Team Room `room-1776713031264` with only `charmander` (Gemini) member.
2. Called `team:ask` via IPC — this triggers `ensureSession` + `sendMessage`
   for charmander, which instantiates a Gemini PTY session.
3. After 30s, read PTY ring buffer via `ipcMain.handle('debug:get-session-buffer')`.

## Observations (buffer tail, 8192 chars total)

Key strings extracted from the raw PTY output:

```
1 GEMINI.md file · 1 MCP server · 31 skills
workspace: ~\.ai-team\.mcp-configs\gemini-room-1776713031264-charmander
branch: feature/team-mcp-mailbox
YOLO Ctrl+Y
Auto (Gemini 3)
⠇ Waiting for authentication... (Press Esc or Ctrl+C to cancel)
Type your message or @path/to/file
```

## What this proves

- `gemini --approval-mode yolo` command construction in `session-manager.js`
  correctly launches Gemini CLI.
- Per-character workdir generation via `_writeMcpConfig` for Gemini.
  The cwd `~\.ai-team\.mcp-configs\gemini-room-1776713031264-charmander` is
  where we wrote `.gemini/settings.json`.
- MCP server loaded: "1 MCP server" line shows Gemini picked up the
  `ai-team` server from the `.gemini/settings.json` we wrote.
- `conptyInheritCursor=false` fix applies to Gemini PTY too — 8192 chars
  of output (not just 4 bytes of DSR query like with the bug).
- Proxy env vars correctly propagate (Gemini is behind Clash at :7890).
- YOLO mode enabled (auto-approve tool calls).

## What blocks the full E2E

`⠇ Waiting for authentication...` — Gemini CLI auth state is either
expired or needs a fresh OAuth flow. This is a per-user environment issue,
not a code problem. Running `gemini auth login` (or whatever the correct
re-auth command is) should fix it.

## Next step for full E2E (after auth)

Once Gemini CLI authenticates, the same flow as Claude should work:
- bracketed-paste the user message via `writeToSession`
- Gemini processes, calls `team_respond` MCP tool
- Hub's `/api/team/response` endpoint receives callback
- UI renders reply

Two unknowns still to verify with a working authenticated Gemini:
- Does Gemini TUI accept bracketed-paste `\x1b[200~...\x1b[201~` like Claude does?
- Does Gemini's MCP tool calling surface reliably produce the POST to our
  `ai-team` server?

## Code changes committed

- `core/session-manager.js`: added `isGemini` kind, `gemini --approval-mode yolo`
  launch command, proxy env injection.
- `core/team-session-manager.js`: `_writeMcpConfig` generates
  `.gemini/settings.json` in a per-character workdir; `ensureSession` routes
  Gemini to use the workdir as cwd (not mcpConfigFile).
- `main.js`: added `debug:get-session-buffer` IPC handler for PTY introspection.
