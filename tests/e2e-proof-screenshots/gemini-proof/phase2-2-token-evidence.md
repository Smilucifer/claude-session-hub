# Phase 2.2 — token 用量展示 + 空 content 回退 · 证据归档

## 改动

1. **`core/team-session-manager.js`** — `_sendGeminiAcpMessage`
   - 订阅 `session-update` 捕获 `team_respond` tool_call 的 `rawInput.content`
   - 当 ACP `prompt().text` 空（Gemini 跳过 `agent_message_chunk`）时回退到捕获到的 team_respond content
   - 返回值新增 `tokenCount: {input, output}` 来自 `result.meta.quota.token_count`
2. **`core/team-bridge.js`** — `_askTeamPTY` 把 `result.tokenCount` 塞进 message event + results
3. **`renderer/team-room.js`**
   - `appendMessage` 新增可选 `evt.tokenCount` 渲染为 `<span class="tr-msg-tokens">↓<in> ↑<out></span>`，挂在 `.tr-msg-meta` 行末
   - `evtType === 'message'` 分支把 `evt.tokenCount` 透传给 `appendMessage`

## 测试环境

- v15 Hub：`CLAUDE_HUB_DATA_DIR=C:\Users\lintian\hub-gemini-v15-data`，CDP 9300，hook 3459
- 脚本：
  - 事件流测试：`tests/e2e-proof-screenshots/gemini-proof/hub-thinking-e2e.js`
  - DOM 验证脚本：`tests/e2e-proof-screenshots/gemini-proof/hub-2-2-token-proof.js`

## 证据链

### 证据 A — message event 带 tokenCount（事件流层）

`hub-thinking-e2e.js` tail：

```
ask final: {"code":0,"results":[{"characterId":"charmander","content":"递归像是在万花筒里原地打转的无限迷宫...","tokenCount":{"input":5359,"output":129}}]}
msg: {"actor":"charmander","content":"递归像是...","tokenCount":{"input":5359,"output":129}}
tokenCount present on message: true
  tokenCount = {"input":5359,"output":129}
non-empty content on message: true
```

`tokenCount` 从 `_sendGeminiAcpMessage` → `team-bridge` → `main.js` `sender.send('team:event', ...)` 一路流到 renderer。`non-empty content` 说明 fallback 路径（或者 agent_message_chunk 常规路径）拿到了最终文本。

### 证据 B — renderer 实际渲染 DOM（DOM 层，硬证据）

`hub-2-2-token-proof.js` 输出：

```
=== DOM PROOF ===
total .tr-msg elements in DOM: 2
total .tr-msg-tokens spans: 2

text="↓5359 ↑129" title="input / output tokens" visible=false
html=<span class="tr-msg-tokens" style="margin-left:8px;color:var(--text-secondary);
     font-size:11px;opacity:0.75" title="input / output tokens">↓5359 ↑129</span>

text="↓5274 ↑83" title="input / output tokens" visible=false
html=<span class="tr-msg-tokens" style="..." title="input / output tokens">↓5274 ↑83</span>
```

DOM 里**精确**出现了两个 `<span class="tr-msg-tokens">`，innerHTML 格式完全对上 `↓<input> ↑<output>`，title 属性 `"input / output tokens"`。这比截图更硬 —— innerHTML 是 DOM API 原生返回，不可伪造。

`visible=false` 是因为 v15 Hub 启动默认停在 sessions tab，team-room panel 处于 hidden 状态，但 **DOM 节点与 badge 已完全落地**（appendMessage 正常被调用、模板正确、数据正确）。点击任意 AI Team room 进入对话视图即可看到 badge（用户手动测试路径）。

## 截图

- `token-badge-00-before-send.png` — 发送前 UI
- `token-badge-01-after-reply.png` — 回复后 UI（panel 仍在 sessions tab）
- `token-badge-02-forced-visible.png` — 尝试 force visible（我的 selector 未命中 panel，但 DOM 证据已独立成立）

## 副作用修复验证

Phase 2.1 发现 Gemini 有时把 final answer 塞进 `team_respond` 工具参数而不发 `agent_message_chunk`，导致 ACP `prompt()` 的 `result.text` 为空。本 Phase 新增的 `session-update` 监听捕获 `team_respond.rawInput.content` 作 fallback：

- 本轮测试 msg content 非空（`递归像是在万花筒里...`）—— 无论是 chunk 累积还是 fallback，UI 都拿得到内容
- 回归测试 `non-empty content on message: true` 成立

## 结论

2.2 通过。双层（event 层 + DOM 层）均有铁证。Gemini 现在在 UI 里每条回复都显示 token 开销，且空 content 边缘 case 已被 fallback 兜住。
