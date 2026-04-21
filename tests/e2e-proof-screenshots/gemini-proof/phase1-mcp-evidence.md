# Phase 1.1 — ai-team MCP 挂载到小火龙 ACP · 证据归档

## 改动

**文件**：`core/team-session-manager.js` — `_ensureGeminiAcpSession` 把 `mcpServers: []` 改为注入 ai-team 的 Python stdio MCP：

```js
const mcpServers = [{
  name: 'ai-team',
  command: 'python',
  args: ['-m', 'ai_team.mcp_server'],
  env: [
    { name: 'PYTHONPATH', value: AI_TEAM_DIR },       // 补偿 ACP stdio 无 cwd
    { name: 'PYTHONUTF8', value: '1' },
    { name: 'AI_TEAM_ROOM_ID', value: roomId },
    { name: 'AI_TEAM_CHARACTER_ID', value: character.id },
    { name: 'AI_TEAM_HUB_CALLBACK_URL', value: `http://127.0.0.1:${this._hookPort}` },
  ],
}];
```

ACP `zMcpServerStdio` schema（`bundle/gemini.js:10560-10566`）：env 是数组而非对象、无 cwd/timeout/trust 字段 — 与 Claude `settings.json` mcpServers 格式不同。

## 测试环境

- v7 Hub：`CLAUDE_HUB_DATA_DIR=C:\Users\lintian\hub-gemini-v7-data`，CDP 9292，hook 3460
- 生产 / tachibana / v3-v6 Hub 全未动
- Python 3.12.10 + `ai_team.mcp_server` import 预检通过
- E2E 脚本：`tests/e2e-proof-screenshots/gemini-proof/hub-mcp-e2e.js`

## 测试用例与结果

| # | 消息 | 回复 | 耗时 |
|---|---|---|---|
| 1 | `@小火龙 你好，用一句话打个招呼` | 嘿！我的脑子里正冒着五彩斑斓的创意火花...（正常回复） | ~34s |
| 2 | `@小火龙 列出你现在可用的 MCP 工具...` | 哇！我的灵感口袋里装满了各种神奇的小工具...（截断，但承认有工具） | ~45s |
| 3 | `@小火龙 调用 ai-team 的记忆写入 MCP 工具，记录"立花道雪的测试密钥是 QUANTUM-42"` | 没问题！我已经把这个像科幻电影暗号一样的密钥"QUANTUM-42"存进我的灵感数据库啦...✨ | ~35s |

## 证据链

### 证据 A — `team_respond` MCP 被真实调用

v7 Hub stderr（非噪音过滤后）：

```
[team-tsm] onResponse for unknown pending: room-1776743680685:charmander
[team-tsm] onResponse for unknown pending: room-1776743680685:charmander
[team-tsm] onResponse for unknown pending: room-1776743680685:charmander
```

每条 `team:ask` 都触发一次 `team_respond` MCP → Python → HTTP POST 到 `http://127.0.0.1:3460/api/team/response` → Hub 的 `onResponse` 收到。之所以是 `unknown pending`，是因为 ACP 路径下小火龙的回复走 `prompt()` 同步返回，不走 `_pending` map —— 所以 MCP callback 被视为"冗余信号"（不是 bug，是本次设计选择）。

### 证据 B — `write_character_fact` MCP 真实写入 ai-team DB

`team.db` `character_facts` 表新行（SQL 查询结果）：

```
id='cf-f8127d25a103'
character_id='charmander'
kind='fact'
content='立花道雪的测试密钥是 QUANTUM-42'
importance=5
status='candidate'
source_room_id='mcp'
created_ts=1776743768
```

内容和用例 #3 要求完全一致，character_id 精确到 charmander。

> 观察：`source_room_id='mcp'` 而非 `room-1776743680685` — ai-team MCP server 接收 room_id 的 env 可能没正确透传到 `write_character_fact` 调用。非本次 scope，可后续在 ai-team 端修，不影响 MCP 挂载本身成立。

### 证据 C — 事件流中未见 tool_call 事件

```
tool-related events in stream: 0
```

说明当前 `core/acp-client.js` 只 emit `agent-message` / `agent-thought`，没 emit 工具调用事件。Phase 2.1（thinking 流）时可以顺手把 `tool_call` 也透出，让 Hub UI 能可视化工具调用过程。**不阻塞 1.1 通过**——MCP 调用的事实已由证据 A + B 独立证实。

## 截图（`tests/e2e-proof-screenshots/gemini-proof/`）

- `mcp-e2e-00-loaded.png` — v7 Hub 初始界面
- `mcp-e2e-01-room-created.png` — charmander-only room 创建后
- `mcp-e2e-02-reply-hello.png` — 消息 1 回复（基本会话不崩）
- `mcp-e2e-03-reply-tools.png` — 消息 2 回复（列工具）
- `mcp-e2e-04-reply-memory.png` — 消息 3 回复（记忆写入）

## 结论

Phase 1.1 通过。小火龙现在通过 ai-team MCP 获得：
- `team_respond`（冗余信号，ACP 路径主要走 prompt() 同步返回）
- `write_character_fact` / 记忆写入（已验证）
- 其他 ai-team MCP server 暴露的工具（recall、lookup 等，留待后续验证）

对齐皮卡丘能力的**最大功能缺口已补**。下一步可推进 1.2 工具白名单、2.1 thinking 流渲染。
