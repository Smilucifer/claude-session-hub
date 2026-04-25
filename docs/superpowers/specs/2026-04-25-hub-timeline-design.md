# Hub Timeline 设计 — 会议室共享时间线 + 增量注入 + Feed UI

**Date**: 2026-04-25
**Author**: 立花道雪 + Claude
**Status**: Design (awaiting plan)
**Predecessor**: `2026-04-25-meeting-marker-protocol` (TranscriptTap, commit 9d27102)

---

## 1. Context（为什么）

会议室刚完成 SM-START/END 标识符 → CLI 自带 transcript 文件直读的重构（`core/transcript-tap.js`）。这一层让 Hub 能权威拿到三家 CLI（Claude/Codex/Gemini）的最终回答。

下一步要解决两个用户痛点：

1. **#1 跨 AI 上下文同步精确化**：当前 `buildContextSummary` 只能拿到目标 AI 之外其他 AI 的"最新一轮"回答；K 轮历史拿不到，AI 之间真正的"知道前面发生了什么"实现不了。
2. **#2 黑板墙信息密度低**：当前 3 个 AI 一个 tab，每 tab 只显示最后一轮摘要；用户想回看"Codex 第 3 轮怎么说的"必须切到对应 PTY 翻屏。

业界主流（cat-cafe LSM 共享摘要、Google ADK delta summarization、LangGraph state slicing、AutoGen GroupChat）都收敛到一个模式：**共享 timeline 数据底座 + per-receiver cursor 增量注入**。本设计采用该模式，命名 **Hub Timeline**。

---

## 2. 核心决策汇总（brainstorming 阶段已确认）

| # | 决策点 | 选定方案 | 理由 |
|---|---|---|---|
| 1 | 数据底座 | **Hub Timeline + cursor**（共享 timeline 数组 + per-AI cursor 整数） | 业界共识；零重复；UI 和注入复用同一份数据；L1 摘要可无破坏扩展 |
| 2 | 黑板墙形态 | **C 选项 — 统一 Feed 流**（不分 tab，时间倒序，AI 颜色徽章） | 群聊感最强；自然消化 timeline；用户从"切 tab 找信息"变"刷 feed" |
| 3 | retention 策略 | **B — 无上限内存** | 单会议室 timeline 几十 KB 量级；无 IO 开销；够用 |
| 4 | 存储位置 | **A — 仅 main 进程内存**（Phase 1）；Phase 2 持久化 | Phase 1 聚焦交互能力；持久化预留 serialize 接口 |
| 5 | timeline 内容 | **B — user + AI 双类条目** | Feed UI 必须有 user 锚点；@target 切换场景需要 user turn 注入 |
| 6 | cursor 初始值 | **A — cursor=0**（新 AI 看全部历史） | 加新 AI 的语义就是"听听它对前面讨论的看法" |
| 7 | restart cursor | **保留**（不重置） | restart = 换进程不换会议室身份。**实施附加**：`main.js` 的 `restart-session` 当前用 `createSession(old.kind)` 会 uuid 新 hubSessionId 导致 cursor 丢失；本设计要求改为 `createSession(old.kind, { id: old.id, cwd: old.cwd })` 复用旧 hubSessionId |
| 8 | syncContext 默认 | **C — 默认 OFF + 保留 toggle**（会议室级别） | 用户主动开启更可控；toggle ON 后效果同 A |

### 决策放弃记录

- **K=3 滑窗**：放弃。同段内容平均重复 K 次，token 浪费 4 倍以上，且 prompt cache 失效。
- **token 预算动态**：放弃。每个 AI context window 不同（Claude 1M / Codex 256k / Gemini 2M），动态计算复杂；增量注入已天然控制规模。
- **per-AI lastSeen Map**：放弃。注入效果与 Hub Timeline 完全等价，但数据是 N×N 冗余结构，且 UI 渲染要另存一份 timeline，不优雅。
- **黑板墙单 Tab 时间线 / 折叠历史**：放弃。Feed 形态对话感更强，用户偏好。

---

## 3. 数据模型

### 3.1 MeetingRoomManager 扩展

`core/meeting-room.js` 的 `meeting` 对象新增字段：

```js
{
  id: 'meeting-uuid',
  ...existing fields...,
  _timeline: [           // 共享时间线，新增
    { idx: 0, sid: 'user', text: 'Q1', ts: 1700000000000 },
    { idx: 1, sid: 'sub-uuid-claude', text: 'R1_C', ts: 1700000005000 },
    { idx: 2, sid: 'sub-uuid-codex', text: 'R1_X', ts: 1700000007000 },
    ...
  ],
  _cursors: {            // per-AI 游标，新增
    'sub-uuid-claude': 3,
    'sub-uuid-codex': 3,
    'sub-uuid-gemini': 3,
  },
  _nextIdx: 3,           // 下一个 turn 的 idx，单调递增
}
```

**字段约定**：
- `idx`: 整数，`_nextIdx++`，单调递增，永不复用（即使会议中删除 turn 也不复用）
- `sid`: 字符串，特殊值 `'user'` 表示用户消息；其他值是子会话的 hubSessionId
- `text`: 字符串，turn 完整内容；user turn 是用户输入，AI turn 是 transcriptTap 提取的回答
- `ts`: epoch ms，turn 落地时间

### 3.2 不变量（invariants）

1. `_timeline` 按 `idx` 升序；`idx` 连续无空洞
2. `_cursors[sid]` 永远 ≤ `_timeline.length`
3. 任意时刻 `meeting.subSessions` 包含的每个 sid 都在 `_cursors` 里有 entry
4. timeline 不持久化（Phase 1）；进程退出/会议室关闭即销毁

---

## 4. 数据流

### 4.1 写入路径

```
[AI turn]
  PTY → CLI 写 transcript 文件 → transcriptTap fs.watch 检测
    → emit 'turn-complete' { hubSessionId, text, completedAt }
      → main.js 拦截 → meetingManager.appendTurn(meetingId, hubSessionId, text, completedAt)
        → _timeline.push({ idx: _nextIdx++, sid: hubSessionId, text, ts: completedAt })
          → sendToRenderer('meeting-timeline-updated', { meetingId, turn })

[User turn]
  Feed UI 输入框 → handleMeetingSend(text)
    → ipcRenderer.invoke('meeting-append-user-turn', { meetingId, text })
      → meetingManager.appendTurn(meetingId, 'user', text, Date.now())
        → _timeline.push({ idx, sid:'user', text, ts })
          → sendToRenderer('meeting-timeline-updated', { meetingId, turn })
    → 然后正常 send 给目标 PTY（伴随 incremental context 如 syncContext ON）
```

### 4.2 增量注入路径（syncContext = ON）

```
handleMeetingSend(text, target_ai):
  if meeting.syncContext:
    contextPayload = await ipcRenderer.invoke('meeting-incremental-context', {
      meetingId, targetSid: target_ai
    })
    
    [in main.js]
    incrementalContext(meetingId, targetSid):
      newTurns = _timeline.slice(_cursors[targetSid]).filter(t => t.sid !== targetSid)
      payload = formatTurns(newTurns)  // "[xxx] R1_X\n[xxx] R1_G\n[user] Q2"
      _cursors[targetSid] = _timeline.length  // 推进游标
      return payload
  
  finalPayload = (contextPayload || '') + text
  ipcRenderer.send('terminal-input', { sessionId: target_ai, data: finalPayload })
```

### 4.3 Feed UI 渲染

```
renderer/meeting-blackboard.js renderBlackboard:
  timeline = await ipcRenderer.invoke('meeting-get-timeline', meetingId)
  // timeline = [{idx, sid, text, ts}, ...] 全量
  
  rendered = timeline
    .slice()
    .reverse()          // 最新在上
    .map(turn => renderTurnCard(turn, sessions))
    .join('')
  
  ipcRenderer.on('meeting-timeline-updated', ({ meetingId, turn }) => {
    if (turn.meetingId === currentMeetingId) {
      prependTurnCard(turn)   // 新 turn 插入顶部，无需全量 rerender
    }
  })
```

---

## 5. 文件改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `core/meeting-room.js` | 修改 | MeetingRoomManager 加 `_timeline`/`_cursors`/`_nextIdx`；新增 `appendTurn(meetingId, sid, text, ts)`、`getTimeline(meetingId)`、`incrementalContext(meetingId, targetSid)`、`getCursor(meetingId, sid)`、`addSubSessionAttachCursor(meetingId, sid)` |
| `core/transcript-tap.js` | 不改 | 现有 'turn-complete' event 已够用 |
| `main.js` | 修改 | (1) `transcriptTap.on('turn-complete', ev => meetingManager.appendTurnFromTap(...))` 串接；(2) 新 IPC: `meeting-append-user-turn`, `meeting-get-timeline`, `meeting-incremental-context`；(3) `addSubSession` 时调 `addSubSessionAttachCursor`；(4) **`restart-session` 改为 `createSession(old.kind, { id: old.id, cwd: old.cwd })` 保留 hubSessionId**（决策 #7 实施附加） |
| `renderer/meeting-blackboard.js` | 重写 | Feed 流布局；订阅 'meeting-timeline-updated'；`renderTurnCard(turn, session)` 渲染单条；保留 toolbar |
| `renderer/meeting-room.js` | 修改 | `handleMeetingSend`：先 `meeting-append-user-turn`，再 `meeting-incremental-context`（如 syncContext ON）拼到 payload，最后 send |
| `renderer/meeting-room.css` | 追加 | Feed 样式（按 mockup） |
| `tests/_e2e-hub-timeline.js` | 新增 | E2E 测试入口（详见第 7 节） |

预计 LOC：~600 行新增 + ~150 行重写。

---

## 6. 兼容性 / 兜底

1. **transcript-tap 失败**（hook 没触发 / 文件路径漂移）：AI turn 不入 timeline，UI Feed 显示"⏳ AI 回答中..."占位；超时（60s）后变"⚠ 未捕获回答"占位
2. **syncContext OFF**：完全跳过 incrementalContext 和 cursor 推进，用户消息直接 send 给 PTY；timeline 仍记录（用于 Feed UI），cursor 不动
3. **会议室删除 sub-session**：`_cursors[sid]` 清理，但保留该 sid 在历史 timeline turn 里的引用；UI 渲染时 sid 找不到 session 显示 "已离开" 灰色
4. **timeline 极长**（>100 turns）：Phase 1 仍全量 push；Phase 2 加 L1 摘要（数据结构上 turn 增加 `kind:'summary'` 类型，cursor 自然跳过）
5. **进程崩溃**：内存 timeline 全丢；Phase 2 加持久化解决

---

## 7. 测试方案（重点：用户明确强调"压力测试要充分，端到端实际测试"）

### 7.1 单元测试（自动化，不需要 CLI）

文件：`tests/_unit-hub-timeline.js`

```
describe('MeetingRoomManager timeline'):
  test_appendTurn_increments_idx          // push 多条，idx 0,1,2...
  test_appendTurn_emits_event             // emit/return event for IPC
  test_addSubSession_initializes_cursor_to_zero  // 新 AI cursor=0
  test_incremental_context_excludes_target       // newTurns 不含 target 自己
  test_incremental_context_advances_cursor       // 调用后 cursor 推进
  test_incremental_context_repeated_returns_empty   // 同一 cursor 第二次调返回空
  test_user_turn_included_in_increment    // user turn 算进 newTurns
  test_remove_sub_session_clears_cursor   // 删除 sub 后 cursor 移除
  test_restart_session_keeps_cursor       // restart 同一 hubSessionId cursor 保留
```

### 7.2 集成测试（自动化，不需要 CLI）

文件：`tests/_integration-hub-timeline.js`

```
- mock transcriptTap.emit('turn-complete') → 验证 timeline 增长 + IPC 推送
- mock IPC 'meeting-append-user-turn' → 验证 user turn 写入
- mock multiple AI 并发 turn-complete → 验证 idx 不冲突（单线程 JS 自然安全，但要验证 race-free 假设）
```

### 7.3 真实 E2E 压力测试（用户明确允许真实 CLI 调用）

文件：`tests/_e2e-hub-timeline-real.js`

**前置**：启动隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR`），通过 CDP 驱动 IPC。

#### Scenario A — 基础 happy path（3 家齐全 + syncContext ON + @all）

```
步骤：
1. 创建会议室
2. 加入 Claude / Codex / Gemini 三个子会话（noInheritCursor:true 让 PTY 输出能被 transcriptTap 抓到）
3. 等三家 TUI ready
4. 打开 syncContext
5. send "用一个字回答: 1+1 等于几" 给 all
6. 等三家全部回答完成（task_complete / Stop hook / type:"gemini" 都触发）
7. send "把刚才的答案翻译成英文" 给 all（依赖前一轮上下文）
8. 等三家全部回答完成

验证：
- 第二轮：每个 AI 的输入 PTY 历史里包含其他 2 家的回答（增量注入生效）
- 任意 AI 的累积 PTY 不包含同一段内容重复（零重复）
- timeline 长度 = 1(user) + 3(AI Round 1) + 1(user) + 3(AI Round 2) = 8
- cursors[每个 AI] = 8（最新位置）
- Feed UI 渲染 8 条，时间倒序
```

#### Scenario B — syncContext OFF 验证不注入

```
步骤：
1. 同 A 步骤 1-3
2. 不开 syncContext
3. send "回答 1+1" 给 all → 三家回答 R1
4. send "回答 2+2" 给 all → 三家回答 R2

验证：
- 任意 AI 的 PTY 累积只包含自己的对话历史（无其他 AI 注入痕迹）
- timeline 仍记录 8 条（OFF 不影响 timeline 写入，只跳过注入）
- cursors[每个 AI] = 0（OFF 时 cursor 不推进）
```

#### Scenario C — 中途加入 AI（cursor=0 看全历史）

```
步骤：
1. 创建会议室 + Claude + Codex（不加 Gemini）
2. 开 syncContext
3. 进行 3 轮对话 → timeline 长度 = 1+2+1+2+1+2 = 9
4. 加入 Gemini（addSubSession）
5. send "请综合大家观点" 给 all（包括新 Gemini）

验证：
- Gemini 收到的注入 = 全部 9 条 timeline（cursor=0 → length）
- Gemini 回答里能体现"已知前 3 轮 Claude/Codex 的讨论"（语义验证：手工或 LLM 判断回答质量）
- cursors[Gemini] = 10（注入后推进）
```

#### Scenario D — @target 单聊后切回 @all

```
步骤：
1. 3 家齐全 + syncContext ON
2. send "Q1" @all → 三家回答
3. send "Q2 仅 Codex 看" @target=Codex → 只 Codex 回答
4. send "Q3" @all → 三家回答

验证：
- Q3 时 Claude/Gemini 收到的注入包含 Q2 的 user turn + Codex 的 R2_X（之前没看到的）
- 零重复：R1_X 不重复出现（已在 Q1 注入过）
```

#### Scenario E — Restart AI（cursor 保留）

```
步骤：
1. 3 家齐全，进行 5 轮对话 → cursors[Claude]=cursors[Codex]=cursors[Gemini]=15+
2. restart Claude（同一 hubSessionId 重新 spawn 新 PTY）
3. send "继续" @all

验证：
- 新 Claude 进程接收的注入 = 仅最近一轮（cursor 保留在 15+，timeline 只新增 1 条 user turn）
- 不是从 cursor=0 全部重灌（避免 token 浪费）
```

#### Scenario F — 长会议 + 并发回答

```
步骤：
1. 3 家齐全 + syncContext ON
2. 连发 10 轮 @all 问题（"用一句话回答 X^2 等于几"，X=1..10）
3. 每轮等三家全部回答完再发下一轮

验证：
- timeline 长度 = 10 + 30 = 40 条
- 没有 turn 丢失（idx 连续 0..39）
- 没有重复 turn（idx 不重复）
- cursor 单调递增
- Feed UI 滚动流畅，渲染 40 条不卡
```

#### Scenario G — 快速连发不等待（压力）

```
步骤：
1. 3 家齐全
2. 不等回答，连发 5 条 user turn @all
3. 三家陆续回答完成

验证：
- 5 条 user turn 全在 timeline 里（idx 连续）
- 三家最终回答的 turn-complete 事件不丢（每家最少 5 条 AI turn）
- timeline 总长度 ≥ 20
- 没有 idx 冲突
- 没有 race condition 导致 cursor 错位
```

#### Scenario H — Feed UI 实时更新

```
步骤：
1. 切到黑板墙 Feed 视图
2. 发 1 条 @all 问题
3. 监测 DOM 变化

验证：
- user turn 立即出现在 Feed 顶部
- 三家 AI 回答完成后，3 条 AI turn 依次插入到 Feed 顶部（不需要手动 refresh）
- 每条带正确的 AI 颜色徽章 + 时间戳
- 长 turn（>500 字）显示折叠按钮
```

#### Scenario I — Tap 失败兜底

```
步骤：
1. 创建会议室 + Claude
2. send 一条问题
3. **手动删除** Hub 推 stop hook 的能力（临时改 settings.json 或 kill hook server）
4. Claude 真实回答了但 Hub 没收到 turn-complete

验证：
- Feed UI 显示 "⏳ Claude 回答中..."占位
- 60s 后变 "⚠ 未捕获 Claude 回答" 占位
- 不影响其他 AI 后续 turn 的正常处理
```

### 7.4 性能压力（数值上限）

```
- timeline 100 条：cursors 操作 < 1ms（slice + filter）
- timeline 1000 条：cursors 操作 < 10ms（仍 OK）
- timeline 10000 条：可能需要 L1 摘要（Phase 2）
```

### 7.5 验收标准

**必过**：Scenario A/B/C/D/E/F/G/H/I 全部 PASS
**性能**：timeline 100 条以内 incrementalContext 调用 < 5ms
**回归**：原有 marker 兜底路径仍能工作（关闭 transcriptTap 后 fallback marker）

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 增量注入 payload 格式让 AI 误以为是用户在说话 | 用明确 marker：`[会议室协作同步 - 来自 Codex]\n<text>` |
| Feed UI 实时更新事件风暴（10 个 turn 同时到达） | 200ms 防抖批量 rerender |
| timeline 单条 turn 极长（AI 输出 1MB） | turn 写入前 cap 到 100KB；超出截尾"...[Truncated]" |
| transcriptTap turn-complete 重复触发同一回答 | meeting._timeline 加去重：检查 `last turn.sid === sid && text === text && ts < 2s` 跳过 |
| 多个会议室同时活跃 | meeting._timeline 是 meeting 实例字段，天然隔离 |
| Renderer 收到 'meeting-timeline-updated' 但 currentMeeting 不匹配 | event payload 带 meetingId，renderer 检查后再 prepend |

---

## 9. 实施分阶段

**Phase 1.1**：数据层（MeetingRoomManager 扩展 + IPC handlers + transcriptTap 串接）
**Phase 1.2**：注入逻辑（buildContextSummary 重写为 incrementalContext）
**Phase 1.3**：Feed UI 重写（meeting-blackboard.js）
**Phase 1.4**：E2E 测试（Scenario A-I 全跑）
**Phase 2**（未来）：持久化 + L1 摘要 + 按 token 预算上限

---

## 10. 数据来源

- cat-cafe LSM Compaction：`reference_catcafe_patterns.md`
- Google ADK delta summarization：[Architecting context-aware multi-agent](https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/)
- LangGraph state management：[CrewAI vs LangGraph vs AutoGen 2026](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63)
- Multi-Agent Memory Survey：[arxiv 2603.10062](https://arxiv.org/html/2603.10062v1)
- Brainstorming session（含三方案对比 + 场景演练）：用户与 Claude 2026-04-25 实时讨论
- TranscriptTap 前置工作：commit `9d27102`
