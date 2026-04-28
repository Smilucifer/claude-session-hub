# 会议室 v3 设计规格：协作增强 + 结果聚合 + 持久记忆

日期: 2026-04-24

## 背景

会议室 v1/v2 完成了多终端并排、Focus/Blackboard 布局、SM 标记协议、摘要引擎。实际使用中暴露三个短板：

1. **协作深度浅**: 上下文注入是 500 字符尾部截断，丢失核心结论
2. **无结果聚合**: 用户需自己消化三路输出并综合结论
3. **无持久记忆**: 关闭会议室后所有上下文丢失

v3 针对这三个短板设计改进，保持会议室"轻量人控"定位的同时引入可选的半自动能力。

## 设计原则

- **人控为主，半自动可选**: 所有自动行为都有开关或由用户触发
- **复用现有基础设施**: summary-engine、Gemini Flash 管道、marker 协议、state.json 模式
- **三部分独立可实施**: 各部分无硬依赖，可按优先级分步落地

---

## Part 1: 智能上下文注入 + 分歧检测

### 1.1 智能上下文注入

**替代现有 `buildContextSummary()` 中的 500 字符截断逻辑。**

#### 规则

1. 从目标 Agent 以外的各子会话提取 `[SM-START]...[SM-END]` 标记内容
2. 如果标记内容 **≤1000 字符** → 直接作为上下文原文注入
3. 如果标记内容 **>1000 字符** → 调用 Gemini Flash 压缩到 ≤1000 字符
4. 如果无 SM 标记内容 → fallback 到 ringBuffer 最后 1000 字符（提升原有 500 上限）

#### Gemini Flash 压缩 prompt

```
将以下 AI 回答压缩到 1000 字符以内。
要求：保留关键结论、数据点和具体建议，压缩论证过程和重复内容。

原文：
{{content}}
```

#### 注入格式

```
[会议室协作同步]
【Claude】<SM内容或压缩后内容>
【Gemini】<SM内容或压缩后内容>
---
<用户消息>
```

#### 文件变更

- `renderer/meeting-room.js`:
  - `buildContextSummary()`: 重写逻辑，先尝试 SM 标记提取，按阈值决定原文/压缩
  - 新增 IPC 调用 `compress-context`（>1000 字符时触发）
- `core/summary-engine.js`:
  - 新增 `compressContext(content, maxChars)` 方法，调用 `_callGeminiPipe()`
- `main.js`:
  - 新增 IPC handler `compress-context`

#### 性能考虑

- 压缩调用是异步的，会增加发送延迟（Gemini Flash 约 1-3 秒）
- 仅当内容 >1000 字符时触发，短回答零延迟
- 压缩结果可缓存：key = `sessionId + SM内容hash`，同一轮不重复调用

### 1.2 半自动分歧检测

**可选功能，默认关闭，通过 Focus toolbar 开关控制。**

#### 触发条件

- 分歧检测开关 = 开
- 至少 2 个 Agent 的 marker status = `done`

#### 流程

1. 检测到条件满足 → 自动收集各 Agent 的 SM 标记内容
2. 调用 Gemini Flash 做分歧分析
3. UI 显示分歧提示条

#### Gemini Flash 分歧分析 prompt

```
分析以下多个 AI 对同一问题的回答，识别共识和分歧。

{{#each agents}}
【{{name}}】
{{content}}
{{/each}}

请以 JSON 格式输出：
{
  "consensus": ["共识点1", "共识点2"],
  "divergence": [
    {
      "topic": "分歧主题",
      "positions": {"Claude": "观点", "Gemini": "观点", "Codex": "观点"},
      "suggestedQuestion": "建议追问的问题"
    }
  ]
}
```

#### 分歧提示条 UI

位于 Focus 模式终端上方（或 Blackboard 顶部），高度约 60-80px：

- **共识状态**（绿色背景）: 显示共识要点数量 + 可展开列表
- **分歧状态**（黄色背景）: 显示分歧数量 + 可展开的分歧卡片
  - 每个分歧卡片：主题 + 各方立场摘要
  - 每个分歧卡片右侧：快捷追问按钮

#### 1.3 定向追问快捷操作

分歧卡片上的追问按钮：

- **"追问全部"**: 将 `suggestedQuestion` 填入输入框，`sendTarget = 'all'`
- **"问 Claude"** / **"问 Gemini"** / **"问 Codex"**: 填入输入框 + 切换 `sendTarget`
- 用户可编辑追问内容后发送

#### 文件变更

- `renderer/meeting-room.js`:
  - 新增 `_divergenceEnabled` 状态（默认 false）
  - toolbar 新增"分歧检测"开关按钮
  - 新增 `renderDivergenceBar()` 渲染分歧提示条
  - marker-status 轮询中增加分歧检测触发逻辑
- `core/summary-engine.js`:
  - 新增 `detectDivergence(agentOutputs)` 方法
- `main.js`:
  - 新增 IPC handler `detect-divergence`
- `renderer/meeting-room.css`:
  - 分歧提示条样式（`.mr-divergence-bar`、`.mr-divergence-card`）

#### 缓存与去重

- 分歧检测结果缓存：key = 各 Agent SM 内容的 hash 拼接
- 同一轮回答不重复检测
- 用户发新消息后清除上一轮缓存

---

## Part 2: 结果聚合

### 2.1 一键综合报告

**Blackboard 模式工具栏新增"综合"按钮。**

#### 触发条件

- 至少 2 个 Agent 的 marker status = `done`
- 按钮状态：条件未满足时 disabled + tooltip 说明

#### 流程

1. 用户点击"综合"按钮
2. 收集各 Agent 的 `[SM-START]...[SM-END]` 全量内容
3. 调用 Gemini Flash 生成综合报告
4. 渲染在 Blackboard 的新 **"综合"** 标签页

#### Gemini Flash 综合 prompt

```
你是一个多AI协作会议的综合者。以下是不同AI对同一问题的回答。
请生成结构化的综合报告。

{{#each agents}}
【{{name}}】
{{content}}
{{/each}}

请按以下结构输出（Markdown 格式）：

## 共识
- 三方一致认为的要点

## 分歧
- 存在分歧的议题，列出各方立场和分歧原因

## 各方独有洞察
- 某方提到但其他方未涉及的有价值观点

## 建议结论
- 综合各方意见后的推荐结论
```

#### 综合标签页 UI

- Blackboard 的 tab 栏新增 **"📋 综合"** 标签（在各 Agent 标签之后）
- 内容使用 `marked` 渲染为 Markdown HTML
- 底部显示生成时间 + "重新生成"按钮
- 如果尚未生成 → 显示"点击工具栏的【综合】按钮生成综合报告"

#### 与 Part 1 的联动

- 如果分歧检测（1.2）已运行且缓存有效 → 综合报告直接复用分歧数据
- 综合 prompt 中注入已有的 consensus/divergence JSON，让 Gemini Flash 不重复分析
- 节省一次 Gemini Flash 调用

### 2.2 差异对比视图

**Blackboard 模式新增"对比"标签页。**

#### 流程

1. 用户切到"对比"标签页
2. 自动调用 Gemini Flash 提取各方关键议题和立场
3. 渲染议题×Agent 的矩阵视图

#### Gemini Flash 议题提取 prompt

```
分析以下多个 AI 的回答，提取所有讨论到的关键议题，
并列出每个 AI 在每个议题上的立场/观点。

{{#each agents}}
【{{name}}】
{{content}}
{{/each}}

请以 JSON 格式输出：
{
  "topics": [
    {
      "name": "议题名称",
      "positions": {
        "Claude": "该议题上的观点摘要",
        "Gemini": "该议题上的观点摘要",
        "Codex": "该议题上的观点摘要（未涉及则为 null）"
      },
      "agreement": true/false
    }
  ]
}
```

#### 对比视图 UI

- 每个议题一行，展开/折叠式
- 议题标题 + 一致性标记（绿色✓ / 黄色⚠）
- 展开后三列并排显示各 Agent 立场
- 一致的行绿色背景，分歧的行黄色背景

#### 文件变更

- `renderer/meeting-blackboard.js`:
  - tab 栏新增"综合"和"对比"两个标签
  - `renderAggregation()`: 渲染综合报告（Markdown）
  - `renderComparison()`: 渲染对比矩阵
- `core/summary-engine.js`:
  - 新增 `aggregateReports(agentOutputs, divergenceCache)` 方法
  - 新增 `extractTopics(agentOutputs)` 方法
- `main.js`:
  - 新增 IPC handler `aggregate-reports`
  - 新增 IPC handler `extract-topics`
- `renderer/meeting-room.css`:
  - 综合标签样式、对比矩阵样式

#### 缓存

- 综合报告缓存在 `meeting.lastAggregation` 对象上
- 对比数据缓存在 `meeting.lastComparison` 对象上
- 用户发新消息或"重新生成"时清除

---

## Part 3: 持久记忆（自动存档）

### 3.1 自动存档机制

**会议室关闭时自动存档，无需用户确认。**

#### 触发条件

- 会议室关闭（用户点击关闭按钮 或 应用退出）
- 至少 1 个 Agent 产出了 SM 标记内容

不满足条件（如空会议室、未产出任何 SM 内容）则静默跳过，不存档。

#### 存档数据结构

```json
{
  "id": "archive-uuid",
  "meetingId": "original-meeting-id",
  "title": "会议室标题",
  "agents": [
    { "sessionId": "...", "kind": "claude", "model": "opus-4" }
  ],
  "scene": "free_discussion",
  "createdAt": "2026-04-24T10:30:00.000Z",
  "closedAt": "2026-04-24T11:15:00.000Z",
  "summary": "Gemini Flash 生成的会议摘要（≤500字符）",
  "agentOutputs": {
    "claude": "[SM-START]全量内容[SM-END]",
    "gemini": "[SM-START]全量内容[SM-END]",
    "codex": "[SM-START]全量内容[SM-END]"
  },
  "aggregation": "综合报告 Markdown（如果 Part 2 已生成，否则 null）",
  "divergence": { "consensus": [...], "divergence": [...] }
}
```

#### 存档摘要生成

关闭时调用 Gemini Flash 生成 ≤500 字符的会议摘要：

```
概括以下多AI协作会议的核心内容，500字符以内。
包含：关键结论、未解决问题、有参考价值的信息。

{{#each agentOutputs}}
【{{name}}】
{{content}}
{{/each}}
```

#### 存储

- 文件：`~/.claude-session-hub/meeting-archives.json`
- 格式：`{ "version": 1, "archives": [...] }`
- 无数量限制，无截断
- 通过 `getHubDataDir()` 获取路径（支持 `CLAUDE_HUB_DATA_DIR` 隔离）

### 3.2 存档浏览

**侧栏会议室区域新增"历史"折叠区域。**

#### UI

- 位于侧栏"会议室"列表下方，折叠标题："📁 历史会议"
- 展开后显示存档列表，按时间倒序
- 每条存档显示：标题 + 时间 + 参会 Agent 图标 + 摘要预览（单行截断）
- 点击存档 → Blackboard 模式展示完整存档内容（只读）
  - 各 Agent 标签页显示存档的 SM 内容
  - 如有综合报告 → "综合"标签页也展示
- 右键存档 → "删除存档"

#### 文件变更

- 新建 `core/meeting-archive.js`:
  - `MeetingArchiveManager` 类
  - `save(meetingData)`: 收集 SM 内容 + 调 Gemini Flash 生成摘要 + 写入文件
  - `list()`: 返回存档列表（不含 agentOutputs 全文，只含摘要）
  - `load(archiveId)`: 返回完整存档
  - `delete(archiveId)`: 删除指定存档
- `renderer/meeting-room.js` 或 `renderer/sidebar.js`:
  - 渲染"历史会议"折叠区域
  - 点击存档加载到 Blackboard 只读模式

### 3.3 加载历史到新会议

**从存档创建新会议，自动注入历史上下文。**

#### 流程

1. 用户在存档列表点击 **"继续讨论"** 按钮
2. 创建新会议室（空的，用户自行添加子会话）
3. 存档摘要作为初始上下文前缀，写入 `meeting.historyContext`
4. 第一次发送消息时，自动注入：

```
[历史会议参考] （2026-04-24 的讨论）
关键结论：...
未解决问题：...
---
<用户新消息>
```

5. 仅第一次注入，后续消息不再注入（避免重复）

#### 文件变更

- `core/meeting-room.js`:
  - `createMeeting()` 新增可选参数 `historyContext`
  - meeting 对象新增 `historyContext` 字段 + `historyInjected` 标记
- `renderer/meeting-room.js`:
  - `handleMeetingSend()` 中检查 `historyContext`，首次发送时注入
- `main.js`:
  - 新增 IPC handlers: `save-meeting-archive` / `list-meeting-archives` / `load-meeting-archive` / `delete-meeting-archive` / `create-meeting-from-archive`

### 3.4 存档持久化与隔离

- 路径通过 `getHubDataDir()` 获取，自动支持 `CLAUDE_HUB_DATA_DIR` env 隔离
- 存档文件与 `state.json` 分离，互不影响
- 应用退出时在 `before-quit` 事件中同步执行存档（遍历所有活跃会议，有 SM 内容的自动存档），完成后再保存 state.json
- Gemini Flash 摘要生成设 5 秒超时，超时则 summary 留空字符串（不阻塞退出）

---

## IPC 接口汇总

| IPC Channel | 类型 | 所属 Part | 入参 | 出参 |
|-------------|------|-----------|------|------|
| `compress-context` | invoke | Part 1 | `{content, maxChars}` | `compressed: string` |
| `detect-divergence` | invoke | Part 1 | `{meetingId}` | `{consensus, divergence}` |
| `aggregate-reports` | invoke | Part 2 | `{meetingId, divergenceCache?}` | `markdown: string` |
| `extract-topics` | invoke | Part 2 | `{meetingId}` | `{topics: [...]}` |
| `save-meeting-archive` | invoke | Part 3 | `{meetingId}` | `{archiveId}` |
| `list-meeting-archives` | invoke | Part 3 | - | `archives: [...]` |
| `load-meeting-archive` | invoke | Part 3 | `{archiveId}` | `archive: {...}` |
| `delete-meeting-archive` | invoke | Part 3 | `{archiveId}` | - |
| `create-meeting-from-archive` | invoke | Part 3 | `{archiveId}` | `{meetingId}` |

## 新增/修改文件汇总

| 文件 | 操作 | 涉及 Part |
|------|------|-----------|
| `core/summary-engine.js` | 修改 | 1, 2 |
| `core/meeting-room.js` | 修改 | 1, 3 |
| `core/meeting-archive.js` | **新建** | 3 |
| `renderer/meeting-room.js` | 修改 | 1, 2, 3 |
| `renderer/meeting-room.css` | 修改 | 1, 2, 3 |
| `renderer/meeting-blackboard.js` | 修改 | 2 |
| `main.js` | 修改 | 1, 2, 3 |
| `config/summary-templates.json` | 修改 | 1, 2 |

## 实施优先级建议

1. **Part 1.1**（智能上下文注入）→ 改动最小，收益最直接
2. **Part 3.1 + 3.2**（自动存档 + 浏览）→ 独立模块，不影响现有功能
3. **Part 2.1**（一键综合）→ 依赖 SM 标记成熟度
4. **Part 1.2 + 1.3**（分歧检测 + 定向追问）→ 与 Part 2 联动
5. **Part 2.2**（差异对比视图）→ UI 最复杂
6. **Part 3.3**（加载历史到新会议）→ 依赖 3.1/3.2

## 测试计划

每个 Part 完成后需通过以下验证：

### Part 1 验证
1. 创建会议室 → 添加 2+ AI → 发送问题 → 检查上下文注入是否使用 SM 内容（短回答原文/长回答压缩）
2. 开启分歧检测 → 等所有 Agent 完成 → 验证分歧提示条出现 → 点击追问按钮 → 验证输入框填充
3. 发送新消息 → 验证上一轮分歧缓存清除

### Part 2 验证
1. 至少 2 Agent 完成 → 点击"综合"按钮 → 验证 Blackboard "综合"标签页渲染
2. 切到"对比"标签页 → 验证议题矩阵显示 + 一致/分歧颜色标记
3. 已有分歧检测缓存 → 点击"综合" → 验证不重复调用 Gemini Flash

### Part 3 验证
1. 会议有 SM 内容 → 关闭会议 → 验证 `meeting-archives.json` 写入
2. 空会议关闭 → 验证不存档
3. 侧栏"历史会议" → 点击存档 → 验证 Blackboard 只读展示
4. 点击"继续讨论" → 创建新会议 → 发送消息 → 验证历史上下文注入 + 仅注入一次
5. `CLAUDE_HUB_DATA_DIR` 隔离下 → 验证存档文件在隔离目录
