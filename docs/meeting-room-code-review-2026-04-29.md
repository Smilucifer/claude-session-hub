---
feature_ids:
  - general-roundtable
  - meeting-room
topics:
  - code-review
  - roundtable-mode
  - driver-mode
  - regression-risk
doc_kind: review_handoff
created: 2026-04-29
---

# Claude Session Hub 会议室整体代码审视

## 结论

当前最新提交 `c2eef71 Merge branch 'feature/general-roundtable' into master` 后，会议室代码的主要风险不在语法层面，而在新引入的通用圆桌和既有投研圆桌/主驾模式之间的路由契约没有完全收拢。

本轮只审视并提出修改建议，没有改业务代码。已验证：

- `git status --short`：干净
- `node --check main.js`：通过
- `node --check renderer/meeting-room.js`：通过
- `node tests/unit-general-roundtable-mode.test.js`：通过
- `node tests/unit-parse-driver-command.test.js`：通过

## A2A Handoff

What: 修复会议室三模式整合后的路由、默认入口和测试覆盖缺口，优先保证通用圆桌可真实发起 fanout/debate/summary，同时不回归投研圆桌和主驾模式。

Why: 通用圆桌已经成为 `createMeeting()` 的默认字段，但后端轮次调度仍只允许 `researchMode`，导致默认圆桌的核心公共轮次不可用；现有测试主要覆盖 UI/文件/解析，没有打穿后端调度。

Tradeoff: 可以最小改动复用 `core/roundtable-orchestrator.js`，但要明确它从“投研专用状态机”升级为“圆桌通用状态机”；如果担心投研历史状态污染，则需要按 mode 分文件或在切换时定义清晰的状态隔离策略。

Open Questions: 通用圆桌是否应该成为“新建会议弹窗”的默认选中模式？目前 `core/createMeeting()` 默认是圆桌，但弹窗仍默认主驾；如果产品目标是“自由讨论替换为通用圆桌”，建议默认选中通用圆桌并重命名 UI。

Next Action: 先修 P0 后端 mode guard，再补一个能在 `roundtableMode` 下调用 `roundtable:turn` 并断言不返回 `not research mode` 的测试；随后再处理入口文案/默认值和测试质量。

## P0: 通用圆桌公共轮次被后端拒绝

证据：

- `renderer/meeting-room.js:1682-1694`：`researchMode || roundtableMode` 都会走 `triggerRoundtable()`，进而调用 `roundtable:turn`。
- `main.js:895-898`：`dispatchRoundtableTurn()` 只允许 `meeting.researchMode`，否则返回 `{ status: 'error', reason: 'not research mode' }`。

影响：

- 通用圆桌默认提问、`@debate`、`@summary @claude` 都会被后端拒绝。
- UI 有乐观 pending 状态，但 IPC resolve 后只是清状态，用户看到的是“不动/失败感”，核心功能不可用。
- 私聊 `@claude ...` 不经过 `roundtable:turn`，所以可能看起来局部可用，掩盖公共轮次失效。

建议修改：

1. 把 `dispatchRoundtableTurn()` 的 guard 改为允许 `meeting.researchMode || meeting.roundtableMode`。
2. 错误文案改成 `not roundtable-capable mode` 之类，避免误导。
3. 明确 summary 档案标题：当前 summary 归档固定写 `# 投研圆桌决策档案`，如果通用圆桌也复用这段，需要根据 mode 输出 `圆桌讨论决策档案` 或跳过投研专属归档。
4. 补测试：在 `roundtableMode: true` 的会议上调用 `roundtable:turn`，断言不会返回 `not research mode`。哪怕没有真实 CLI，也至少要覆盖 no_subs/no_sent 之前的 mode guard。

## P1: 新建会议入口和“通用圆桌默认”目标不一致

证据：

- `core/meeting-room.js` 的 `createMeeting()` 默认 `roundtableMode: true`。
- `renderer/renderer.js:1619-1621` 打开创建弹窗时仍强制选中 `driver`。
- `renderer/index.html:156-162` 仍显示 `主驾模式 / 投研圆桌 / 自由讨论`，没有把 `free` 改成 `通用圆桌`。
- `renderer/renderer.js:1642-1645` 只识别 `driver` 和 `research`；选择 `free` 时依赖后端默认 `roundtableMode: true`，这是隐式耦合。

影响：

- 如果目标是“自由讨论模式替换成通用圆桌”，用户从弹窗创建的默认体验仍是主驾，而不是圆桌。
- “自由讨论”文案和实际 roundtableMode 行为不一致，后续用户和维护者会误判模式。

建议修改：

1. 将 radio value/name 从 `free` 语义更新为 `roundtable`，文案显示“通用圆桌”。
2. 如果产品默认要圆桌，`openCreateMeetingModal()` 默认选中 `roundtable`，而不是 `driver`。
3. 在 `submitCreateMeeting()` 显式处理 `meetingMode === 'roundtable'`，调用 `toggle-roundtable-mode` 写 prompt/covenant；不要只依赖 `createMeeting()` 的默认字段。
4. `_syncMeetingModeUI()` 为通用圆桌补描述，例如“三家平等讨论，支持 @debate / @summary / @单家私聊”。

## P1: 测试没有覆盖真实公共轮次链路

证据：

- `tests/_e2e-general-roundtable.js:257-279` 只用“无子会话的 @claude 私聊”作为 best-effort 检查，且接受输入清空或不清空两种结果。
- `tests/unit-parse-driver-command.test.js:1-4` 说明测试复制了 renderer 内部函数体，不是从真实源导入；它能防解析规则漂移，但不能证明真实 UI 和后端 IPC 正常。

影响：

- P0 的 `roundtableMode` 后端 guard 回归没有被现有测试抓住。
- E2E 通过容易给出“通用圆桌已可用”的错误信号。

建议修改：

1. 增加一个后端最小集成测试：构造/创建 meeting，设置 `roundtableMode: true`，调用或等价覆盖 `dispatchRoundtableTurn()` 的入口，断言不是 `not research mode`。
2. E2E 至少模拟一个真实公共轮次按钮/输入：普通文本触发 fanout，观察 IPC 返回状态或 UI 明确错误。
3. 如果 `dispatchRoundtableTurn()` 不方便测试，考虑导出纯调度依赖注入版本，或把 mode guard 和 target 构造抽成可测函数。
4. 保留 parser 单测可以，但不要把它当作端到端证明。

## P2: 模式切换注释与实现相反，容易误导后续修复

证据：

- `renderer/meeting-room.js:150-151` 注释说切到非 roundtable 时 `toggle-roundtable-mode enabled=false` 会清理 roundtable 文件。
- `main.js:1270` 明确写着关闭模式不清理文件，清理只在 close-meeting。

影响：

- 当前行为未必是错的，保留文件可以避免切换模式丢私聊历史。
- 但注释会误导后续维护者，以为禁用 roundtable 已清理 prompt/covenant/private 文件，从而在调试状态污染时走错方向。

建议修改：

1. 修正文档注释：禁用 roundtable 只切状态，不清理文件。
2. 如果需要避免 mode 间状态污染，另开设计：按 mode 分状态文件，或在 UI 提示“切换回来会保留上次圆桌状态”。

## P2: 圆桌状态文件在通用/投研之间共享，需要明确边界

证据：

- 通用圆桌和投研圆桌都复用 `core/roundtable-orchestrator.js`，状态文件仍是 `<meetingId>-roundtable.json` / `<meetingId>-turn-N.json`。
- `toggle-roundtable-mode enabled=false` 不清理文件；投研模式也会读取同一 orchestrator state。

影响：

- 同一会议室里从通用圆桌切到投研圆桌，历史 turns 可能混在同一个 state 里。
- 这可能是“保留上下文”的有意设计，也可能污染投研零回归。当前代码没有把这个产品语义写清楚。

建议修改：

1. 决策：通用和投研是否共享历史？如果共享，UI 和 summary 标题必须明确显示来源；如果不共享，文件名应区分，例如 `roundtable-general.json` 和 `roundtable-research.json`。
2. 至少补一个模式互切测试，断言切换后 `roundtable:get-state` 是预期的共享或隔离行为。

## 建议修复顺序

1. 修 P0：`dispatchRoundtableTurn()` 支持 `roundtableMode`，处理通用模式 summary 归档文案。
2. 补一个最小测试锁住 P0，先不用真实三家 CLI。
3. 统一创建入口：`free` 改 `roundtable`，默认选择按产品决策调整，提交时显式 `toggle-roundtable-mode`。
4. 修注释和文档，把“禁用时清理文件”的错误说法删掉。
5. 决策通用/投研 roundtable state 是否共享；按决策补互切测试。

## 验证清单

修完后至少跑：

```powershell
node --check main.js
node --check renderer\meeting-room.js
node tests\unit-general-roundtable-mode.test.js
node tests\unit-parse-driver-command.test.js
```

建议新增并运行：

```powershell
node tests\unit-roundtable-dispatch-mode.test.js
```

手动或 E2E 验证：

- 新建通用圆桌，三家子会话存在时普通输入能触发 fanout。
- `@debate` 在已有上一轮时能进入 debate，没上一轮时给出明确提示。
- `@summary @claude` 在通用圆桌下不写“投研圆桌决策档案”。
- 通用圆桌切投研再切回通用，历史状态符合预期设计。
