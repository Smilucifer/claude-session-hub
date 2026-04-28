# 通用圆桌模式（General Roundtable）设计规格

日期: 2026-04-28
分支建议: `feature/general-roundtable`

## 背景

会议室目前有三种正交模式：

| 模式 | 字段 | 定位 | UI |
|---|---|---|---|
| 自由讨论（旧默认） | `driverMode=false && researchMode=false` | 三家平等无分工，靠手动 @ 路由 | 三 xterm 终端 + Focus/Blackboard 布局 + SM 标记 + 黑板 |
| 主驾模式（编码） | `driverMode=true` | Claude 主驾 + Gemini/Codex 副驾审查 | 同上 + .arena/state.md + MCP request_review |
| 投研圆桌（新增） | `researchMode=true` | 三家平等，A 股投研专题，状态机驱动 | 圆桌卡片 + 抽屉时间线 + fanout/debate/summary 状态机 |

实际使用暴露：

1. **自由讨论 UI 错位**：三 xterm 终端 + 黑板是为"看 CLI 协作做事"设计的，但用户实际把它当"通用智囊讨论"用（出 idea/解数学/想方案/写 PPT），UI 形态不匹配
2. **认知负担重**：手动 @ 路由 + SM 标记 + 黑板对"我有个想法想跟三个 AI 商量"过重
3. **投研圆桌的范式更优**：fanout/debate/summary 状态机 + 三平等卡片 UI，本来就是通用的，不应该被"投研"一个场景独占

用户决策（2026-04-28 brainstorming）：
- 投研圆桌 **零影响保留**（researchMode 路径完全不动）
- 自由讨论 **彻底替换**为通用圆桌（无老用户兼容包袱）
- prompt 通用化（不预设场景，"像 AI Web 网页那样任何问题都能交流"）
- 单家 @ 前缀（@claude/@gemini/@codex）回退为单聊语义

## 设计目标与硬约束

### 目标
- G1. 自由讨论默认走通用圆桌：开会议 = 卡片 UI + 状态机
- G2. prompt 通用、不预设场景（数学/通信/PPT/任意话题都能聊）
- G3. 支持单家 @ 私聊（@<who> 单家或多家但非全员）作为退路
- G4. 投研圆桌已有的 fanout/debate/summary 状态机原样复用

### 硬约束
- **C1. 投研圆桌零回归**：`research-mode.js` / `research-mcp-server.js` / researchMode 字段路径 / `<meetingId>-research.md` prompt 文件 / 投研 covenant 模板，**所有相关代码与文件不修改一行**。E2E 验证投研圆桌打开、fanout 一轮、@debate 一轮、@summary @claude 一轮全部正常
- **C2. 旧自由讨论 UI 与逻辑彻底清除**（无老用户）：三 xterm 终端的 Focus/Blackboard 布局、SM 标记自动注入、自由讨论的黑板逻辑、`buildContextSummary` 的 500 字符截断 —— 都从默认体验中消失。**driverMode 编码场景下保留这些**（主驾依然需要看终端）
- **C3. driverMode 完整保留**：编码主驾场景独立有价值，零修改
- **C4. 同一 meeting 同时只能处于一种模式**：roundtableMode / researchMode / driverMode 互斥，toggle 时自动清掉其他两个

## 范式：3X+Z 混合

通用圆桌的语义表：

| 用户输入 | 行为 | 状态机 | 是否入 turn-N.json |
|---|---|---|---|
| `普通文本` | fanout 三家独立回答 | TURN_FANOUT | ✅ |
| `@debate` 或 `@debate <补充>` | 中转上一轮另两家观点给当前家 | TURN_DEBATE | ✅ |
| `@summary @<who>` | 单家收到全部历史轮次，给最终意见 | TURN_SUMMARY | ✅ |
| `@all <文本>` | 显式群发，等同于 fanout | TURN_FANOUT | ✅ |
| `@<who> <文本>` | **单家私聊**，不入圆桌历史 | （不进状态机） | ❌ |
| `@<whoA> @<whoB> <文本>` | 多家但非全员私聊 | （不进状态机） | ❌ |

### 隔离原则（私聊 vs 公共）
- 私聊回答**不写入** `<meetingId>-turn-N.json`，**不更新** `roundtable.json` 的 turns 数组
- 私聊回答 UI 上仅在被点名 AI 的卡片显示 💬 角标 + 抽屉新增 Tab"私聊历史"
- 用户后续想把私聊内容分享到公共讨论：手动复制 → 用 `@debate <复制内容>` 注入。**MVP 不做"私聊提升为公共"自动机制**

## 状态字段

### `meeting` 对象新增
```js
{
  // ... 现有字段保持不变
  researchMode: false,        // 投研圆桌（不动）
  driverMode: false,          // 主驾模式（不动）
  roundtableMode: true,       // 新增：通用圆桌（默认开）
  generalRoundtableCovenant: '', // 新增：通用圆桌可选公约（用户留白时为空字符串）
}
```

新建会议室时默认值：
```js
{
  driverMode: false,
  researchMode: false,
  roundtableMode: true,        // ← 默认开
  generalRoundtableCovenant: '',
  layout: 'focus',             // 兼容字段，但圆桌模式下不渲染 layout
}
```

### 互斥保障
- `update-meeting` IPC handler 收到 `roundtableMode: true` → 自动设 `researchMode: false` && `driverMode: false`
- 反之亦然（toggle research → 关 roundtable；toggle driver → 关 roundtable）
- `core/meeting-room.js::updateMeeting` 的 allowed 列表新增 `roundtableMode` 和 `generalRoundtableCovenant`

## Prompt 设计

### 文件命名
- 通用版：`<arena-prompts>/<meetingId>-roundtable.md`
- 投研版（不动）：`<arena-prompts>/<meetingId>-research.md`

### `GENERAL_ROUNDTABLE_RULES_TEMPLATE`（约 30 行）

```markdown
# 圆桌讨论规则

## 你的角色
你和另外两位 AI 同事（共三家：Claude / Gemini / Codex）受邀加入用户的圆桌讨论。
**地位完全平等，本色发挥，不需要扮演角色。** 你怎么思考就怎么回答，不要套模板。

## 圆桌的运作方式
用户用以下语法驱动讨论：

1. **默认提问**：用户发普通文本 → 三家独立回答（互不知情）。这一轮你不会看到另两家在写什么。
2. **@debate 触发**：用户发 `@debate` 或 `@debate <补充信息>` → 系统会把另两家上一轮的完整观点发给你 → 请你结合他们的视角发表新观点（可继承可反驳，可纳入用户补充的新信息）。
3. **@summary @<你> 触发**：用户发 `@summary @claude`（或 @gemini / @codex）→ 系统会把所有历史轮次的三家观点汇总给被点名那位 → 由他给出综合意见。
4. **@<你> 私聊**：用户发 `@claude <内容>`（或 @gemini / @codex / 多家但非全员）→ 仅你看到，不入圆桌历史。这是用户与你的私下讨论，专注一对一即可。

⚠ 你看不到另两家观点时，不要假装你看得到。专注本色独立回答。

## 协作礼仪
- @debate 时引用对方观点请明示（"Gemini 提到的 XX..."），便于用户追溯
- 不要因为另两家观点强势就放弃自己的判断；该坚持就坚持，该改就改要说明为什么
- @summary 阶段被点到时，写成可读决策报告（结论先行 + 关键分歧 + 行动建议），不要只复读三家观点
- 私聊时不要假装其他 AI 在场，专注一对一对话

## 工具与资源
你可以使用自己已有的能力辅助回答：联网搜索、读取本地文件、运行代码、调用 MCP 工具。
能查就查，不要假装"凭印象"。但每次工具调用前评估必要性，避免无意义的探查。

## 留白
你是用户的智囊伙伴，不是答题机器。
该坚持时坚持，该改主意时改主意，信息不足时主动说"我需要 X"。
```

### 用户公约（可选）
- `meeting.generalRoundtableCovenant` 默认为空字符串
- UI 提供编辑入口（圆桌面板顶部"编辑公约"按钮，弹出 textarea），用户想加再加（个人偏好/红线/输出习惯）
- 写入文件 `<arena-prompts>/<meetingId>-roundtable.md`：rules + 分隔线 + covenant（如果非空）
- **不预置任何场景模板**（与投研版的 COVENANT_TEMPLATE 显著区别）

### Resume reminder
```
[系统提醒] 你正在通用圆桌（Roundtable）中恢复会话。请继续遵守以下规则：
- 三家平等，本色发挥
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合）/ @<你> 私聊
```

## UI 设计

### 默认视图：圆桌卡片（复用投研圆桌已有渲染）
- 顶部 header：`圆桌讨论` 标题（不显示"投研"）+ 已 N 轮 + 当前模式标签
- 三张卡片（Claude/Gemini/Codex），每张：状态（待命/思考中/已答/超时）+ 预览（前 600 字 markdown 渲染）+ 💬 私聊角标（如有未读私聊）
- 历史轮次折叠条 + 抽屉时间线（点卡片展开）
  - 抽屉内 Tab 增至两个：**轮次回答** / **私聊历史**

### 三 xterm 终端默认隐藏
- `display: none`，CLI 会话照旧跑（session-manager 不动）
- "高级"折叠区提供"显示终端"toggle，便于排错时打开

### 旧 UI 元素删除
| 元素 | 处理 |
|---|---|
| Focus / Blackboard 布局切换按钮 | 在 roundtableMode = true 时不渲染 |
| 黑板（meeting-blackboard.js）的渲染入口 | 仅 driverMode = true 时渲染 |
| SM 标记自动同步逻辑（buildContextSummary 500 字符截断） | roundtableMode 下不调用（不影响 driverMode） |
| 摘要引擎多场景下拉（自由讨论/代码审查/Debug/...） | 在 roundtableMode 下隐藏（投研和主驾仍可用） |

### 入口与 toggle
- 新建会议室按钮：默认创建 roundtableMode=true 的圆桌
- 顶部 toolbar 新增三态切换：`圆桌 | 主驾 | 投研`（互斥单选）
  - 切到投研：自动调用现有 `toggle-research-mode` IPC（不动）
  - 切到主驾：自动调用现有 `toggle-driver-mode` IPC（不动）
  - 切到圆桌：调用新增 `toggle-roundtable-mode` IPC

## 触发语法解析（renderer/meeting-room.js）

### `parseDriverCommand` 扩展
现有逻辑：
```js
if (meeting.researchMode) {
  // @summary / @debate 解析
  // 默认 fanout
}
if (!meeting.driverMode) return { type: 'normal', text, targets: null };
// driverMode 解析 @review/@gemini/@codex/...
```

新逻辑（在 researchMode 分支前插入 roundtableMode 分支）：
```js
if (meeting.researchMode) {
  // 不变
}
if (meeting.roundtableMode) {
  let rest = text.trim();
  // 1. @summary @<who> 优先
  const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
  let m;
  if ((m = rest.match(summaryRe))) {
    return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
  }
  // 2. @debate
  if (/^@debate\b\s*/i.test(rest)) {
    return { type: 'rt-debate', text: rest.replace(/^@debate\s*/i, '') };
  }
  // 3. @all 等同 fanout
  if (/^@all\b\s*/i.test(rest)) {
    return { type: 'rt-fanout', text: rest.replace(/^@all\s*/i, '') };
  }
  // 4. @<who> 单家或多家私聊（不入轮次）
  const targets = [];
  const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
  while (true) {
    const t = rest.match(tokenRe);
    if (!t) break;
    const tok = t[1].toLowerCase();
    if (!targets.includes(tok)) targets.push(tok);
    rest = rest.slice(t[0].length);
  }
  if (targets.length > 0 && targets.length < 3) {
    return { type: 'rt-private', targetKinds: targets, text: rest };
  }
  if (targets.length === 3) {
    // 三家全 @ 等同 @all
    return { type: 'rt-fanout', text: rest };
  }
  // 5. 默认 fanout
  return { type: 'rt-fanout', text: rest };
}
if (!meeting.driverMode) return { type: 'normal', text, targets: null };
// driverMode 不变
```

### IPC 路由（main.js）
在 `send-input` 或会议室消息派发 handler 中：
- `rt-fanout` / `rt-debate` / `rt-summary` → 走 RoundtableOrchestrator（与投研同一套）
- `rt-private` → 不走 orchestrator；直接对每个 targetKind 调 `send-input` 到对应 sessionId；UI 卡片更新 💬 角标 + 抽屉私聊 Tab

## 文件改动清单

### 新建
| 文件 | 说明 |
|---|---|
| `core/general-roundtable-mode.js` | 通用 RULES_TEMPLATE + writePromptFile / writeCovenantSnapshot / cleanupFiles（参照 research-mode.js 但删投研内容） |
| `docs/superpowers/specs/2026-04-28-free-roundtable-mode-design.md` | 本文件 |
| `docs/superpowers/plans/2026-04-28-free-roundtable-mode.md` | 实施计划（下一步产出） |

### 修改
| 文件 | 改动范围 | 影响投研？ |
|---|---|---|
| `core/meeting-room.js` | `createMeeting` 默认 `roundtableMode=true`；`updateMeeting` allowed 列表加 `roundtableMode`+`generalRoundtableCovenant`；互斥逻辑 | 否（仅扩展字段） |
| `main.js` | 新增 IPC handler `toggle-roundtable-mode`；`send-input` 路由扩展（rt-private 走单聊路径） | 否（仅新增分支） |
| `renderer/meeting-room.js` | `parseDriverCommand` 加 roundtableMode 分支；UI panel 渲染条件从 `meeting.researchMode` 扩展为 `meeting.researchMode \|\| meeting.roundtableMode`；私聊角标渲染；抽屉新增私聊 Tab；旧 Focus/Blackboard 渲染条件改为 `meeting.driverMode` only | 否（条件扩展，原 researchMode 路径不变） |
| `renderer/meeting-room.css` | 新增 💬 角标样式 + 抽屉 Tab 样式；旧 .mr-blackboard 等 in roundtableMode 不应用 | 否 |
| `renderer/index.html` | 顶部新增三态切换按钮（圆桌/主驾/投研） | 否 |
| `renderer/meeting-blackboard.js` | 增加渲染条件 `if (!meeting.driverMode) return;` 提前返回（仅主驾才渲染黑板） | 否（投研本来就不渲染） |
| `renderer/renderer.js` | 新建会议室入口绑定 default `roundtableMode: true` | 否 |

### 不动（C1 投研零影响）
- `core/research-mode.js`
- `core/research-mcp-server.js`
- `core/roundtable-orchestrator.js`（已通用，零修改）
- `arena-prompts/<id>-research.md` 文件命名
- IPC handlers：`toggle-research-mode`、`roundtable:get-state`、`roundtable:start-fanout/debate/summary`

### 删除（C2 旧自由讨论清除）
| 文件/段落 | 处理 |
|---|---|
| `renderer/meeting-room.js` 中 SM 标记自动注入到 `buildContextSummary` 的逻辑 | 在 roundtableMode 下提前 return（不删函数，driverMode 仍调用） |
| 摘要引擎"自由讨论"场景按钮入口 | UI 隐藏（保留 `summary-templates.json` 配置） |

实际上这些都是"在 roundtableMode 下不渲染/不调用"的条件分支，**代码不删，只让 roundtableMode 路径绕过**。这样 driverMode 仍然有完整的旧 UI。

## 持久化

### 文件命名共享
通用圆桌与投研圆桌**共用**以下文件名（同 meeting 下互斥，不会冲突）：
- `<meetingId>-roundtable.json` — 状态机（roundtable-orchestrator 写）
- `<meetingId>-turn-N.json` — 每轮快照（roundtable-orchestrator 写）

通用圆桌**独占**：
- `<meetingId>-roundtable.md` — system prompt（rules + covenant）
- `<meetingId>-roundtable-private.json` — 新增：私聊历史 `{ claude: [{text, timestamp}], gemini: [...], codex: [...] }`

投研圆桌**独占**（不动）：
- `<meetingId>-research.md`
- `<meetingId>-covenant.md`
- `<meetingId>-research-mcp.json`

切换模式时不清旧文件（容错保留）；`closeMeeting` 调 cleanup 时统一清。

## 投研零回归保障（C1）

### 验收测试
1. 启动 Hub（隔离实例 `CLAUDE_HUB_DATA_DIR=C:\temp\hub-roundtable-test`）
2. 创建新会议室 → 默认 roundtableMode=true，验证圆桌 UI 渲染、单聊解析、@debate 走状态机
3. 切到投研模式（toggle-research-mode）→ 验证：
   - 圆桌 UI 切换到投研版（标题 / firstRunHint / covenant 编辑入口）
   - fanout 一轮：发普通问题，三家收到 `<meetingId>-research.md`，回答持久化
   - @debate 一轮：解析正确，中转上轮观点
   - @summary @claude 一轮：Claude 收到全部历史，输出最终决策
4. Playwright 截图对比：投研圆桌的 prompt 文件、turn-N.json、UI 渲染与改造前完全一致

### 代码审查
- 提交前 grep `research-mode.js` `research-mcp-server.js`：确认零 diff
- diff `roundtable-orchestrator.js`：确认零 diff
- IPC handler diff：仅新增 `toggle-roundtable-mode`，原有 `toggle-research-mode` 不动

## 边界与已知不做（MVP 范围）

- ❌ **私聊提升为公共**：用户想分享私聊到公共讨论 → 手动复制贴 `@debate <内容>`。MVP 不做自动机制
- ❌ **场景模板下拉**：通用版不预置数学/通信/PPT 模板。用户想用就在 covenant 里自己写
- ❌ **跨会议室记忆**：每个会议室独立的 roundtable 状态，不共享 covenant 默认值
- ❌ **投研 → 通用迁移工具**：用户切换 mode 时旧轮次保留但不可视；不做导出导入
- ❌ **Phase 2 加入"分歧检测""结果聚合"**：v3 spec 里规划的能力不在本次 MVP

## 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| roundtable-orchestrator 复用导致投研 turn-N.json 名字冲突 | 投研轮次错乱 | 互斥字段保证同一 meeting 不同时 research+roundtable；切模式时旧 turn 文件保留只读 |
| parseDriverCommand 修改引入 researchMode 路径回归 | 投研触发语法解析失败 | E2E 验收里强制覆盖投研 fanout/debate/summary |
| 默认 `roundtableMode=true` 让现有未关闭的旧会议室突然 UI 切换 | 用户体验断裂 | 用户已确认无老用户 + 旧 meeting 持久化字段缺省 false（迁移逻辑：load 时 `meeting.roundtableMode ??= false` 而非 true） |
| 三 xterm 隐藏后 CLI 进程死锁/输出堆积 | 卡住 | session-manager 的 ringBuffer 仍工作；预留"显示终端"toggle |

回滚策略：
- `roundtableMode` 字段为新字段，全部置 false 即恢复"啥模式都不开"的会议室（裸三终端）
- `general-roundtable-mode.js` 删除 + renderer 条件回滚 → 完全回到改造前

## 下一步

进入 plan 阶段，输出可执行的分阶段实施计划：
- Phase 1（后端骨架）：core/general-roundtable-mode.js + meeting-room.js 字段 + IPC handler
- Phase 2（前端解析与渲染）：parseDriverCommand 扩展 + 卡片 UI 条件 + 私聊路径
- Phase 3（旧 UI 退役）：Focus/Blackboard 在 roundtableMode 下不渲染 + 切换按钮
- Phase 4（E2E 与零回归）：Playwright 验证投研 + 通用 + driverMode 三路全过

每个 Phase 独立可测。
