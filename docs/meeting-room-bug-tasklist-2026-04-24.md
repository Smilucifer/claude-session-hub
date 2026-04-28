# Meeting Room Bug Tasklist

date: 2026-04-24
repo: `C:\Users\lintian\claude-session-hub`
scope: 仅整理问题与修复任务，不包含代码修改

## 使用方式

把这份文件直接发给 Claude，让他按下面每条逐项核实、修复、补测试，并给出证据。

要求 Claude 遵守：

1. 先复现/确认根因，再改代码。
2. 每个修复都要附验证证据。
3. 不要顺手改无关代码。

## 总结

本次静态审查发现 5 个主要问题：

1. Blackboard 在有摘要内容时可能直接运行时报错。
2. 休眠会议室恢复后，子会话不会自动重新挂载到会议面板。
3. 会议子会话异常退出后，不会从会议数据里移除，可能形成僵尸成员。
4. Blackboard 的 `lastScene` 不会持久化。
5. 会议对象的增删改没有及时持久化，异常退出时可能丢状态。

---

## 任务 1

### What

修复 Blackboard 渲染摘要时的运行时错误风险。

### Why

`renderer/meeting-blackboard.js` 当前这样写：

- `const DOMPurify = require('dompurify');`
- `DOMPurify.sanitize(...)`

但本地最小探针显示：

```js
const DOMPurify = require('dompurify');
typeof DOMPurify; // function
typeof DOMPurify.sanitize; // undefined
```

这说明 CommonJS 下拿到的是工厂函数，不是可直接调用 `sanitize` 的实例。

一旦 Blackboard 有 `displayText`，这里很可能抛：

```text
TypeError: DOMPurify.sanitize is not a function
```

### Where

- `renderer/meeting-blackboard.js:91`
- `renderer/meeting-blackboard.js:92`
- `renderer/meeting-blackboard.js:93`

### Expected Fix

Claude 需要确认当前 Electron renderer 环境下 `dompurify` 的正确用法，并改成可工作的初始化方式。

修复后要保证：

1. Blackboard 在有 Markdown 摘要时能正常渲染。
2. 渲染结果仍然经过净化，不能退回到裸 `innerHTML`。
3. 不引入新的 XSS 风险。

### Evidence Required

至少给出以下证据：

1. 复现前的错误日志或控制台报错。
2. 修复后的 Blackboard 截图或 E2E 结果。
3. 如有测试，附测试名与通过结果。

---

## 任务 2

### What

修复 dormant meeting 恢复后，子会话不自动重新挂载到会议面板的问题。

### Why

当前恢复链路是：

1. 点击会议室时，如果 `meeting.status === 'dormant'`，会遍历其 `subSessions` 并调用 `resumeDormantSession(sid)`。
2. 然后立即 `MeetingRoom.openMeeting(meetingId, meeting)`。
3. 子会话恢复成功后，renderer 收到 `session-created`。
4. 但对于 `session.meetingId`，代码直接 `renderSessionList(); return;`，没有通知会议面板重新渲染或重挂载 terminal。

这会导致：

1. 第一次点开休眠会议室时仍看到 dormant slot。
2. 终端不一定自动出现。
3. 需要额外触发一次 UI 更新后才恢复正常。

### Where

- `renderer/renderer.js:734`
- `renderer/renderer.js:739`
- `renderer/renderer.js:743`
- `renderer/renderer.js:2663`
- `renderer/renderer.js:2665`

### Expected Fix

Claude 需要确认并修复会议子会话恢复后的 UI 重挂载链路。

修复后要保证：

1. 点击 dormant meeting 后，恢复完成的子会话会自动出现在会议面板内。
2. 不需要用户再次切换列表或重新打开会议。
3. Focus/Blackboard 两种模式下都不会丢挂载。

### Evidence Required

至少给出以下证据：

1. dormant meeting 恢复前后的操作步骤。
2. 修复前后对比截图或录屏。
3. 如果补了自动化测试，附测试名。

---

## 任务 3

### What

修复会议子会话异常关闭后，会议内仍残留僵尸成员的问题。

### Why

现在 `session-closed` 只会：

1. 从 `sessions` Map 里删除该 session。
2. 清 terminal cache。
3. 更新普通会话 UI。

但不会把该 `sessionId` 从 `meeting.subSessions` 中删掉。

这会导致：

1. 会议 tab/slot 里还保留一个已不存在的成员。
2. 会议计数不准确。
3. `sendTarget` 可能指向一个不存在的 session。
4. 后续广播或定向发送存在空发/脏状态风险。

### Where

- `main.js:315`
- `main.js:316`
- `renderer/renderer.js:2680`
- `renderer/renderer.js:2681`
- `core/meeting-room.js:35`
- `core/meeting-room.js:44`

### Expected Fix

Claude 需要决定在主进程还是 renderer 层做正式收敛，但修复后必须满足：

1. 子会话一旦真实关闭，所属会议自动同步移除该成员。
2. 如果被移除的是 `focusedSub`，要自动切换到剩余成员或置空。
3. 如果被移除的是 `sendTarget`，要回退到 `all`。
4. 会议更新事件能正确同步到 renderer。

### Evidence Required

至少给出以下证据：

1. 手动关闭或模拟退出子会话后的行为截图。
2. 会议对象更新前后的实际数据。
3. 回归测试结果。

---

## 任务 4

### What

修复 Blackboard 场景 `lastScene` 不持久化的问题。

### Why

`lastScene` 已经存在于会议模型里，也能在 UI 中更新，但 renderer 持久化会议列表时没有把它写入 `meetingList`。

结果是：

1. 用户在 Blackboard 里选过场景。
2. 会议运行期间看似正常。
3. 重启 Hub 后又回到默认场景。

### Where

- `core/meeting-room.js:24`
- `core/meeting-room.js:64`
- `renderer/meeting-blackboard.js:118`
- `renderer/meeting-blackboard.js:149`
- `renderer/renderer.js:2740`
- `renderer/renderer.js:2745`

### Expected Fix

修复后要保证：

1. `lastScene` 被纳入持久化。
2. 重启后 Blackboard 场景选择正确恢复。
3. 不影响旧状态文件兼容性。

### Evidence Required

至少给出以下证据：

1. 修复前后 `state.json` 中 meeting 数据对比。
2. 重启前后 UI 恢复结果。

---

## 任务 5

### What

修复会议对象变更没有及时持久化的问题。

### Why

renderer 当前只在这些事件后触发 `schedulePersist()`：

- `session-created`
- `session-closed`
- `session-updated`

但 `meeting-created` / `meeting-updated` / `meeting-closed` 只更新内存和列表，没有触发持久化。

这意味着：

1. 正常退出时，主进程 `before-quit` 可能兜底保存。
2. 但异常退出、进程崩溃、强制杀进程时，最近的会议改动可能丢失。

受影响的数据包括：

- 标题
- 布局
- pin
- `syncContext`
- `focusedSub`
- `sendTarget`
- 会议成员列表

### Where

- `renderer/renderer.js:2720`
- `renderer/renderer.js:2824`
- `renderer/renderer.js:2831`
- `renderer/renderer.js:2836`
- `renderer/renderer.js:2844`

### Expected Fix

Claude 需要把会议相关变化纳入同一套 debounce persist 机制，修复后要保证：

1. `meeting-created`
2. `meeting-updated`
3. `meeting-closed`

都会触发持久化。

同时避免：

1. 重复落盘过于频繁。
2. 现有 session persist 逻辑被破坏。

### Evidence Required

至少给出以下证据：

1. 触发会议变更后 `state.json` 的更新结果。
2. 异常退出场景下的恢复验证，或最小化模拟验证。

---

## 建议 Claude 的修复顺序

1. 先修任务 1，因为它会直接导致 Blackboard 崩。
2. 再修任务 2 和任务 3，因为它们影响会议室核心生命周期。
3. 最后修任务 4 和任务 5，这两项偏持久化一致性。

## 建议 Claude 补的测试

建议至少补以下覆盖：

1. Blackboard 有摘要内容时能正常渲染，不抛异常。
2. dormant meeting 恢复后会自动挂载子终端。
3. 子会话关闭后，会议成员列表同步收缩。
4. `lastScene` 会进入持久化并在重启后恢复。
5. `meeting-created/updated/closed` 会触发持久化。

## 备注

这份任务单基于静态代码审查整理。除 `dompurify` 导出形态外，其余问题主要依据主进程 IPC、renderer 恢复链、会议数据流和持久化链分析得出。建议 Claude 在修改前先做最小复现，避免把表象问题和根因问题混在一起。
