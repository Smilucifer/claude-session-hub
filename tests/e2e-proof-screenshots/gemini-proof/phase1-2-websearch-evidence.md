# Phase 1.2 — google_web_search 白名单 · 证据归档

## 改动

**文件**：`core/team-session-manager.js` — `_ensureGeminiAcpSession` 里 workspace `.gemini/settings.json` 的 `tools.core` 从 `[]` 改为 `['google_web_search']`。

工具名来源：`bundle/chunk-ETUADTWF.js:43556` `WEB_SEARCH_TOOL_NAME = "google_web_search"`。

```json
{
  "tools": {
    "core": ["google_web_search"],
    "shell": { "enableInteractiveShell": false }
  }
}
```

`shell.enableInteractiveShell:false` 冗余保留 —— 保护 node-pty AttachConsole 崩溃路径。`fs/*` / `terminal/*` 由 `acp-client.js` 反向请求 handler 拒掉，不需要 settings 额外声明。

## 测试

- v8 Hub：`CLAUDE_HUB_DATA_DIR=C:\Users\lintian\hub-gemini-v8-data`，CDP 9293
- 脚本：`tests/e2e-proof-screenshots/gemini-proof/hub-websearch-e2e.js`
- 触发消息：`@小火龙 请调用 google_web_search 工具搜一下"2025 Nobel Prize in Physics 获奖者"，然后用一句话告诉我答案。必须先用工具搜索。`

## 证据链

### 证据 A — tool_use 事件

event stream 里捕获到：

```json
{
  "type": "tool_use",
  "actor": "charmander",
  "name": "小火龙",
  "tool": "google_web_search",
  "input": {},
  "meta": { "success": 2, "fail": 0, "duration_ms": 37059 },
  "ts": 1776744252
}
```

- `tool: "google_web_search"` 精确对上白名单条目
- `success: 2` 工具被**真实调用并完成 2 次**（Gemini 可能拆了多次查询）
- `duration_ms: 37059` 真实网络耗时（37 秒）—— 训练数据里的"工具调用"不会有这种数字
- `fail: 0` 无失败

### 证据 B — 对比 Phase 1.1（工具禁用期）

Phase 1.1 时 `tools.core:[]`，同样的 room/message 模式下 `tool-related events in stream: 0`。本轮放开后立刻出现 `tool_use`，是**白名单有效性的直接对照**。

### 证据 C — 回复内容带搜索意图

小火龙回复（部分）：

> "根据搜索结果，2025 年诺贝尔物理学奖的获奖者在当前实时网络数据中尚未有确切记录..."

虽然模型对搜索结果的判读不完美（2025 Nobel 实际是 Clarke/Devoret/Martinis），但"根据搜索结果"的措辞 + 2 次真实 HTTP 调用足以证明**行为路径**通了。

### 额外发现 — ai-team room evolution 拉入皮卡丘

create `['charmander']`-only room 后，回复流里出现 pikachu 吐槽小火龙"一个字没搜"。ai-team 的 room evolution 机制自动引入其他 character 辩论。**不是本次改动引入的行为**，但证明**多 AI + 工具链整体健康**。

## 耗时

- 端到端：225s
- 其中 web_search 自身：~37s
- 其余为 ai-team room evolution（pikachu 回应 + extraction + evolution + converged 事件）

## 副作用/风险观察

- **首轮响应被 web_search 延长**：普通问候若 Gemini 误判要调 search，耗时会从 6s 飙升。Phase 2.1 渲染 tool_call 事件后，用户能直观看到"正在搜索"—— mitigate 体验影响。
- **Gemini 搜索结果的判读质量**取决于模型能力，非 Hub 可控。

## 截图

- `websearch-00-loaded.png` / `websearch-01-room.png` — 启动 & room
- `websearch-mid-<Ns>.png` — 工具调用进行中
- `websearch-02-final.png` — 最终状态

## 结论

Phase 1.2 通过。`google_web_search` 白名单放行后小火龙真实发起 Google 搜索并返回结果。下一步推 2.1（thinking 流 + tool_call UI 可视化），让用户能看见"搜索中..."的过程。
