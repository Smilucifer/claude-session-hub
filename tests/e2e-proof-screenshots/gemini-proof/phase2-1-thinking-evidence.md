# Phase 2.1 — agent_thought_chunk → thinking_delta UI 渲染 · 证据归档

## 改动

1. **`core/acp-client.js`** — 放宽 `session/update` chunk 的文本提取条件
   - 原：`update.content?.type === 'text'` （Gemini 0.38.2 部分 thought chunk 不带 `type==='text'`，会被漏掉）
   - 现：`typeof update.content?.text === 'string'` 有字符串就取

2. **`core/team-session-manager.js`** — `sendMessage` 加第 5 个可选参数 `onEvent`；Gemini ACP 分支在 `_sendGeminiAcpMessage` 里订阅 `client.on('agent-thought', ...)`，把事件转成 Hub `thinking_delta` event 推给上层。

3. **`core/team-bridge.js`** — `_askTeamPTY` 调用 `sendMessage` 时把 `onEvent` 透传下去（Claude/Codex 路径不动，他们忽略第 5 参数）。

renderer 端**零改动** —— `team-room.js:894-909` 已存在的 `thinking_delta` 处理器直接复用（Claude extended-thinking 原本就用它）。

## 测试环境

- v13 Hub：`CLAUDE_HUB_DATA_DIR=C:\Users\lintian\hub-gemini-v13-data`，CDP 9298，**hook server 绑定成功 :3459**（前几次 v9–v12 因为我自己开太多 Hub 把 3456–3460 占满，hook bind 失败 → `teamSessionManager` 根本没被 `main.js` 实例化 → `team-bridge` fall-back 到 legacy Python subprocess 路径 → 绕开全部 ACP 代码。**这不是 2.1 的 bug，是测试环境问题**，kill 掉 v6–v12 腾端口后一把过）
- 脚本：`tests/e2e-proof-screenshots/gemini-proof/hub-thinking-e2e.js`
- 消息：`@小火龙 请思考一下：如果用 Python 写一个 Fibonacci 数列函数，memoization 和递归哪个更快？请在脑中分析后用 1-2 句话总结。`

## 证据链

### 证据 A — listener 实际挂载并触发（文件 debug log 绕过 stdout buffer）

调试期间在 `_sendGeminiAcpMessage` 里临时写 `C:\Users\lintian\AppData\Local\Temp\hub-thought-debug-charmander.log`（现已回滚）：

```
listener-installed onEvent=function key=room-1776746598789:charmander sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d
FIRE sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d match=true len=448
FIRE sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d match=true len=393
FIRE sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d match=true len=393
FIRE sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d match=true len=386
FIRE sid=7ef3cc69-82fd-4d92-a6b2-32e368994f3d match=true len=128
```

listener 挂载成功、onEvent 是函数、sessionId 严格匹配、5 次真实 FIRE、总 1748 字符。

### 证据 B — renderer 实收 thinking_delta 事件

E2E 脚本从 renderer `window.__teamEvents` 收集到：

```
live thinking_delta events: 5
concatenated thinking text length: 1748
preview: **Evaluating Function Performance**

I've been examining the performance differences between memoized and recursive Python Fibonacci functions. Initial tests are complete; the memoized version is significantly faster, as expected. I'm now exploring how different input sizes affect the performance gap...
```

renderer 的现有 `thinking_delta` handler (`team-room.js:894-909`) 把这些文本附在 thinking bubble 下方以灰色 italic 呈现。小火龙现在**独享**皮卡丘拿不到的能力：你能实时看见它在想什么。

### 证据 C — 与 1.1 / 1.2 共存不 regress

- 第 1 条回复完成（50s 端到端），没有死锁、没有 timeout
- 同时保持 MCP 调用能力（team.db 里 charmander event 照常写入）

## 已知 minor 副作用

`msg content=""` ：本次 Gemini 把 final answer 塞进了 `team_respond` MCP 工具参数而不是 `agent_message_chunk`，所以 ACP `prompt()` 同步返回的 `result.text` 为空。team.db 里的 message 是 Python MCP server 写的（由 `team_respond` 工具），有完整内容。

影响：`team:ask` 的直接 return value.content 空，但 UI 侧 `message` event 和 DB events 都是完整的。**Phase 2.2（展示 token 用量）顺便修这个**——让 `_sendGeminiAcpMessage` 在 `result.text` 为空时 fall back 到最后一个 `team_respond` 调用的 `content` 参数，或者直接读 DB 最新 charmander event。

## 截图

- `thinking-00-loaded.png` / `thinking-01-room.png` — 初始 & room
- `thinking-02-live-thought.png` — thinking_delta 进行中（灰色 italic 思考流）
- `thinking-03-final.png` — 完成态

## 结论

2.1 通过。小火龙思考流接通 Hub UI。下一步 2.2 token 用量展示，顺带修 ACP 空 content 回退。
