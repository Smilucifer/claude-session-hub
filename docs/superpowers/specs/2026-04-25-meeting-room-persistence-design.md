# 会议室持久化与重启恢复 Design

> 版本:Phase 1(完整版 β)
> 日期:2026-04-25
> 上下文:Hub 当前会议室元数据/timeline/cursors **完全 in-memory**(`core/meeting-room.js:1-30` 注释明确写"in-memory only")。子 session 中只有 Claude 通过 Hook 持久化了 `ccSessionId` 可以 resume,Codex/Gemini 的 sessionId 完全没存。Hub 重启 = 会议室和上下文全部蒸发。本设计补齐这块短板,实现"重启 Hub 后会议室连同三家 AI 子 session 完整恢复"。

---

## 一、目标与非目标

### 目标
1. **元数据持久化**:会议室及其成员关系(meetingId / title / layout / subSessions / cursors / scene / ...)在 Hub 重启后完整恢复。
2. **Timeline 持久化**:会议室完整 timeline(_timeline 数组 + _cursors)在 Hub 重启后可见。
3. **三家 AI native resume**:用户点开恢复后的会议室时,Claude/Codex/Gemini 子 session 通过各自 native resume 命令续上原对话上下文。
4. **失败兜底**:任一家 native resume 失败时,Hub 自动降级到 transcript 文本注入,保证用户始终能看到上次对话内容。
5. **Lazy spawn**:子 session **不在 Hub 启动时立即 spawn**,而是用户首次点开会议室时按需启动,避免启动慢和 token 浪费。

### 非目标
- 共享记忆/lessons 库(留给后续 Phase,见 brainstorm 里的"路径 1 第二步")。
- 跨设备同步(Hub 是本地应用,不引入 cloud sync)。
- 历史会议室搜索/检索 UI(留给规模化阶段)。
- AI Team Room(`core/team-session-manager.js`)的持久化(本设计不动 Team Room,只改 Meeting Room)。

---

## 二、现状分析(为本设计奠定基础)

### 2.1 已有能力(可复用)
| 模块 | 文件:行 | 现有能力 |
|---|---|---|
| Hub data dir | `core/data-dir.js:8` | `getHubDataDir()` 已支持 `CLAUDE_HUB_DATA_DIR` 测试隔离 |
| state.json 持久化 | `core/state-store.js`(整个文件) | 普通 session 元数据已持久化 |
| Claude ccSessionId 推送 | `scripts/session-hub-hook.py:62` + `main.js:141` | Hook 推 cc_session_id;`findTranscriptByCCSessionId` 反查 transcript |
| Claude resume | `main.js:699-700` | `resumeCCSessionId` + `useContinue` 已用 |
| 三家 transcript-tap | `core/transcript-tap.js` | 已绑定 hubSessionId ↔ 三家原生 transcript 文件 |

### 2.2 当前缺口
| 缺口 | 后果 |
|---|---|
| `MeetingRoomManager.meetings` 是 in-memory `Map` | 重启后 0 会议室 |
| `meeting._timeline / _cursors / _nextIdx` 在内存对象上 | 重启后 0 历史 |
| Codex 的 sid 没记录 | 无法 `codex resume <sid>` |
| Gemini 的 8charId / projectHash 没记录 | 无法 `--list-sessions` 反查 index |
| 子 session 重新 spawn 时,无地方读"上次的 sessionId" | resume 不可能 |

---

## 三、整体架构

### 3.1 存储格式(分文件)

```
~/.claude-session-hub/                     ← getHubDataDir()
├── state.json                             ← 既有,新增字段
│   └── meetings: [                        ← 新增,会议室元数据索引
│         { id, title, subSessions, layout, focusedSub,
│           syncContext, sendTarget, pinned, status,
│           lastScene, createdAt, lastMessageTime }
│       ]
│   └── sessions: [                        ← 既有,扩展 resumeMeta
│         { hubId, kind, ccSessionId, codexSid, geminiChatId,
│           geminiProjectHash, geminiProjectRoot, ... }
│       ]
└── meetings/                              ← 新建目录
    ├── <meetingId-1>.json                 ← 单个会议室的完整 timeline
    │   { id, _timeline, _cursors, _nextIdx,
    │     savedAt, schemaVersion: 1 }
    └── <meetingId-2>.json
```

**为什么分文件**:
- state.json 已 16KB,加 timeline 会膨胀;长期上看 timeline 单会议可能上千 turn
- 每个会议独立 IO,删除/迁移/分析独立
- 启动时只 load state.json(快),timeline 等用户点开会议室才 lazy load

### 3.2 子 session resume 元数据(写入 state.json 的 sessions 数组)

| 字段 | 谁写 | 何时写 | resume 用法 |
|---|---|---|---|
| `ccSessionId` | Claude Hook(已有) | 每次 turn | `claude --resume <ccSessionId>` |
| `codexSid` | transcript-tap CodexTap | bind 成功时(rollout 文件首行 session_meta 解析) | `codex resume <codexSid>` |
| `geminiChatId` | transcript-tap GeminiTap | bind 成功时(从 chats/session-*.json 文件名提取 8charId) | 配合下两字段构造 list-sessions 查询 |
| `geminiProjectHash` | GeminiTap | bind 时 | 进 `~/.gemini/tmp/<projectHash>/chats/` 找文件 |
| `geminiProjectRoot` | GeminiTap | bind 时(从 `.project_root` 反查) | `gemini -r` 必须在 projectRoot 当 cwd 跑 |

### 3.3 启动时恢复时序

```
Hub 启动
  │
  ├─ getHubDataDir() → 读 state.json
  │   ├─ 重建 sessions Map(已有)
  │   └─ 重建 meetings Map(只填元数据,不 load timeline)
  │       ↓
  │       MeetingRoomManager.restoreMeetings(metaArray)
  │
  ├─ 用户在 UI 看到会议室列表(标题/成员数/最后活动时间)
  │
  └─ 用户点开会议室 X
      ├─ Lazy load: 读 meetings/<X>.json → 填 _timeline / _cursors
      ├─ Lazy spawn: 对 X 的每个 sub-session 检查
      │   ├─ Claude → spawn with `--resume <ccSessionId>` 或 fallback `--continue`
      │   ├─ Codex → spawn with `codex resume <codexSid>` 或 fallback transcript 注入
      │   └─ Gemini → spawn:
      │       1. 在 geminiProjectRoot 当 cwd
      │       2. 子进程先跑 `gemini --list-sessions --output-format json`
      │       3. 在输出里找 `geminiChatId` 匹配的条目,提取 index
      │       4. spawn `gemini -r <index>` 进入 PTY
      │       5. 任何步骤失败 → fallback transcript 注入
      │
      └─ 注:首次 spawn 会有 1-3 秒延迟(尤其 Gemini 要先跑 list-sessions),用户看 loading 状态
```

### 3.4 Timeline 持久化策略

| 触发 | 行为 |
|---|---|
| 每次 `_timeline.push()` | 标记 dirty,启动 5 秒 debounce 定时器 |
| 5 秒到期 | flush:写 `meetings/<id>.json` |
| 5 秒内有新 push | 重置定时器 |
| `app.before-quit` | 强制 flush 所有 dirty meeting |
| `SIGINT/SIGTERM` | 同上(`process.on` 注册) |

**故障窗口**:5 秒。即 Hub 在 5 秒内崩溃最多丢若干 turn。可接受,因为:
- AI 单 turn 通常 ≥10 秒
- 用户能从三家 transcript JSONL 读回(这才是权威源)

---

## 四、关键模块改动

### 4.1 新增文件

| 文件 | 行数 | 职责 |
|---|---|---|
| `core/meeting-store.js` | ~120 | 单文件 IO 抽象:`saveMeetingFile(id, data)` / `loadMeetingFile(id)` / `listMeetingFiles()` / `deleteMeetingFile(id)`。debounce 写入 + 启动/退出 hook。 |

### 4.2 修改文件

| 文件 | 改动 |
|---|---|
| `core/meeting-room.js` | (1) 加 `restoreMeetings(metaArray)` —— 只填元数据,不 load timeline<br>(2) 加 `loadTimelineLazy(meetingId)` —— 用户点开会议室时调,从 `meeting-store` 读 timeline 填进 in-memory map<br>(3) `addTurn / updateCursors` 等 mutation 调用 `meeting-store.markDirty(id)` |
| `core/state-store.js` | (1) `state.meetings` 字段:序列化时**只写元数据**(剔除 `_timeline / _cursors / _nextIdx`)<br>(2) `state.sessions[].codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot` 新增字段持久化 |
| `core/transcript-tap.js` | CodexTap bind 成功 → emit `session-resume-meta-update` 给 main 写入 state<br>GeminiTap 同上 |
| `core/session-manager.js` | `createSession(meta)` 接受新参数 `resumeFrom: { kind, sid/chatId, projectHash, projectRoot }`,根据 kind 构造对应 spawn 命令(见 §3.3 表) |
| `main.js` | (1) 启动序列加 `restoreMeetingsFromState()`<br>(2) IPC `meeting-open`(从普通 fetch 升级为 lazy-load timeline)<br>(3) IPC `meeting-spawn-sub-session-with-resume`(Lazy spawn 入口)<br>(4) IPC handler 接 transcript-tap 的 resume meta 更新事件<br>(5) `app.on('before-quit')` 调 `meeting-store.flushAll()` |
| `renderer/renderer.js` | UI 展示恢复后的会议室(灰色"未激活"状态);点击后显示 loading;subscribe lazy-spawn 进度事件 |
| `renderer/meeting-room.js`(渲染端 controller) | 处理 lazy-load timeline;处理 resume 失败的兜底 toast 提示 |

---

## 五、Resume 兜底机制(降级链)

每家 AI 都有清晰的 3 级降级:

### Claude 降级链
```
Level 1: claude --resume <ccSessionId>
  ↓ 失败(transcript 文件被删 / sessionId 失效)
Level 2: claude --continue   (不指定 sessionId,起新 session 但保留 cwd 关联)
  ↓ 失败
Level 3: 起新空 session + 注入 transcript JSONL 末尾 N 条
```

### Codex 降级链
```
Level 1: codex resume <codexSid>
  ↓ 失败
Level 2: codex resume --last  (起最近一次 session,可能跨会议室,需用户确认)
  ↓ 失败  
Level 3: 起新 codex session + 注入 transcript JSONL 末尾 N 条
```

### Gemini 降级链
```
Level 1: gemini --list-sessions → 反查 index → gemini -r <index>
  ↓ 失败(list-sessions 找不到或 chats/ 目录被清)
Level 2: gemini -r latest  (起当前项目最近一次,可能不是用户想要的)
  ↓ 失败
Level 3: 起新 gemini session + 注入 chats/session-*.json 的 messages 末尾 N 条
```

**注入的具体形式**:transcript 末尾 N 条(默认 N=10)合并成一条 system-prompt-style 文本,前置标记 `[CONTEXT FROM PREVIOUS SESSION]`,然后空行 + 原始用户输入。AI CLI 启动后第一次收到此文本即可"看到上次说了什么"。

---

## 六、IPC API(后续 plan 需要)

```
新增 IPC:
  meeting-restore-list                 → 启动后渲染端拉取所有恢复的会议室元数据
  meeting-load-timeline { meetingId }  → 用户点开会议室时 lazy load timeline
  meeting-resume-spawn { meetingId, hubSessionId } → 用户点开会议室时 lazy spawn 某个子 session
  meeting-resume-status { hubSessionId, level: 1|2|3, error?: string } ← main → renderer 推送 spawn 进度

扩展 IPC:
  update-session                       → 新增字段 codexSid / geminiChatId / geminiProjectHash / geminiProjectRoot
```

---

## 七、文件改动清单(给 plan 用)

```
新增:
  core/meeting-store.js                 (~120 行)
  
修改:
  core/meeting-room.js                  (+50 行,加 restore/lazy-load)
  core/state-store.js                   (+30 行,扩展字段)
  core/transcript-tap.js                (+20 行,emit resume meta 事件)
  core/session-manager.js               (+40 行,resumeFrom 参数 + 三家 spawn 命令分支)
  main.js                               (+80 行,restore 时序 + 4 个 IPC + before-quit hook)
  renderer/renderer.js                  (+40 行,展示 dormant 会议室 + 进度 UI)
  renderer/meeting-room.js              (+30 行,lazy-load + 兜底 toast)

测试:
  tests/meeting-store.test.js           (新增,~80 行)
  tests/meeting-restore.test.js         (新增,~100 行,模拟重启场景)
  tests/_e2e-meeting-resume-real.js     (新增 E2E,起 isolated Hub → 开会议室 → kill → 再起 → 验证恢复)
```

---

## 八、验证标准(成功条件)

1. **元数据恢复**:重启 Hub 后,UI 列表显示所有会议室(标题/成员/最后活动时间)。
2. **Timeline 恢复**:点开任一会议室,完整看到上次的 timeline,cursor 状态正确。
3. **Claude resume**:Claude 子 session spawn 成功,新发一条消息时 Claude 知道之前讨论了什么。
4. **Codex resume**:同上,实测 `codex resume <sid>` 进入续接状态。
5. **Gemini resume**:`--list-sessions` 反查 index → `-r <index>` 进入续接状态。
6. **Resume 失败降级**:手动删除某家 transcript 文件 → spawn 自动降级到 Level 2 / 3,UI toast 提示"使用兜底注入"。
7. **Lazy spawn**:Hub 启动时 0 子进程,只有用户点开会议室才看到 PTY 启动。
8. **Crash 数据安全**:开 5 轮对话 → kill -9 Hub(模拟崩溃)→ 重启 → 至少看到 4 轮(允许丢 5 秒内最后 1 轮)。
9. **测试隔离不破**:`CLAUDE_HUB_DATA_DIR=...` 启动的并行 Hub 实例,持久化路径独立(满足 CLAUDE.md 铁律)。

---

## 九、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Gemini index 动态变化(用户在别处跑了新 session) | 中 | resume 接到错的 session | `--list-sessions` 时严格按 8charId 匹配,匹配不到立即降级 |
| Codex CLI 升级改 resume 命令格式 | 低 | resume 全失败 | 在 spec 里硬编码 `codex resume <sid>`,如果 CLI 升级则文档跟进 |
| Claude `--continue` 行为不可控(spec 不明) | 低 | Level 2 降级行为不确定 | E2E 测试覆盖,如果 `--continue` 有副作用就跳过直接 Level 3 |
| Timeline 文件膨胀(单会议 1000+ turn) | 低(短期) | IO 慢,UI 卡 | Phase 2 加 timeline 分片(`meetings/<id>/<page>.json`),本 Phase 先单文件 |
| 5 秒 debounce 期间崩溃丢数据 | 中 | 丢最后 1-2 轮 | 三家 native transcript 才是权威源,真出问题时手工 read transcript 补回(超出本 spec 范围) |
| Lazy spawn 用户体感慢(首次点开 1-3s) | 中 | 用户体验下降 | UI 加明确的 "正在恢复 Codex / Gemini..." progress 状态 |
| transcript-tap 的 emit 频率高 → state.json 频繁写 | 中 | 磁盘 IO | session resume meta 也走 5 秒 debounce(只在 sid/chatId 变化时 mark dirty) |
| Hub 启动时 state.json 损坏 | 低 | 启动失败 | 加 schema 校验,损坏时备份 + 启动空 state(用户只丢一次重启的 timeline,会议室元数据可能丢) |

---

## 十、与现有铁律/Spec 的关系

- **CLAUDE.md 铁律 "node_modules 完整性"**:本 spec 不动 package.json,无影响。
- **CLAUDE.md 铁律 "并行测试 Hub 实例"**:`getHubDataDir()` 已自动隔离 `state.json` 和 `meetings/` 目录,本 spec 兼容。
- **CLAUDE.md 铁律 "禁止 kill 生产 Hub"**:E2E 测试用 isolated Hub 实例(`CLAUDE_HUB_DATA_DIR=temp + --remote-debugging-port=9226`),不影响生产。
- **现有 spec `2026-04-25-hub-timeline-design.md`**:Hub Timeline Phase 1 是 in-memory,本 spec 是 Phase 1 的"持久化补丁",兼容。
- **后续 spec(共享记忆同步)**:本 spec 不做 shared memory;留给紧接其后的 Phase。本 spec 完成后,共享记忆可以**复用 `core/meeting-store.js` 的 IO 抽象**写到 `~/.claude-session-hub/memory/shared.md`。

---

## 十一、开放问题(非阻塞,implementation 时再定)

1. **lazy load timeline 时是否一次性 load 全部?** 默认是,但如果单会议 timeline > 5MB 可能要分页。Phase 1 不做。
2. **删除会议室时 meetings/<id>.json 是否同步删除?** 默认是,但保留软删除选项。Phase 1 直接硬删。
3. **三家 resume 失败时是否给用户"放弃此子 session"的选项?** 默认是,UI 加"跳过此 AI"按钮。

---

## 十二、估算工程量

```
T1 core/meeting-store.js + 单测                              0.5 天
T2 state-store.js 扩展字段 + meeting-room.js restoreMeetings  0.5 天
T3 timeline lazy load + debounced flush                      0.5 天
T4 transcript-tap emit codexSid / geminiChatId               0.5 天
T5 session-manager.js 接 resumeFrom + 三家 spawn 命令分支     1.0 天
T6 main.js 启动恢复时序 + IPC + before-quit hook              0.5 天
T7 renderer 展示恢复列表 + lazy-spawn 进度 UI                 0.5 天
T8 三级降级 fallback 实现                                     0.5 天
T9 E2E 测试(开会议 → kill → 起 → 续)                        0.5 天

总计: 5 天
```

(超过原先估算的 3-5 天,主要因为 Gemini 的 list-sessions 反查和三级降级 比预想复杂。)
