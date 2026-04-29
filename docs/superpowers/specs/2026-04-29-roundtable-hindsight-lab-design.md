# 圆桌后验复盘 Lab · Phase 1 设计稿

> 版本：Phase 1（复盘 Lab · 后验式自学习）
> 日期：2026-04-29
> 上下文：投研圆桌（research mode）+ arena-memory M1 已上线。"自然 self-play 训练"（轨道 2，等用户讨论 + T+10 判卷）spec 仍在但**用户已决定不实施**——本设计完全替代。

---

## Context · 为什么做这个

**已有：**
1. **投研圆桌**（commit `cfe256d`）：fanout / debate / summary 三阶段 + 案例归档 `.arena/sessions/<datetime>-<title>.md`
2. **arena-memory M1**（commits `2c2c283` / `7709ff0` / `8f49c5c` 等）：`.arena/memory/shared/facts.md` 增量沉淀 + sentinel 自动注入到未来圆桌讨论 prompt
3. **LinDangAgent 数据层**：`fetch_for_arena.py` 已有 stock/concept/sector 三个子命令
4. **"轨道 2 自然 self-play" spec**（`docs/superpowers/specs/2026-04-28-roundtable-natural-selfplay-design.md`）：完整设计但**未实施**——它的瓶颈是样本完全靠用户主动讨论 + T+10 判卷才能积累，且 selection bias 强

**缺：** 圆桌的"自学习"能力——讨论结果只归档不学习。

**用户的想法：**
> 不必非要像考试一样考 AI；可以**后验地**从历史挑出经典 case（既不是平稳一条线、也不是单边大涨大跌——必须区间内有波动 >20% + 基本面有保证 + 预期差存在），让 AI 自己分析走势原因，互相讨论迭代，最终得到一个学习结果记录下来。

**这是第三种学习路径**——既非轨道 1（封闭量化训练）也非轨道 2（用户讨论 + T+10）：

| 维度 | 轨道 1（封闭量化） | 轨道 2（用户讨论 + T+10） | **Hindsight Lab（本 spec）** |
|---|---|---|---|
| 样本来源 | 历史快照重跑 | 用户真实讨论 | AI 主动从历史挑经典 case |
| 样本规模 | 海量受限算力 | 受限于讨论频次 | 中量（每周 10 只） |
| 等待周期 | 无 | T+10 | **无（走势已发生）** |
| 学习目标 | 准确率 hit-rate | hit-rate + covenant 演化 | **模式识别 / 因果归因 / 经验库沉淀** |
| selection bias | 可控 | 强 | **可控（按规则平衡选样）** |
| 联网策略 | 关 | 全开 | **分阶段：fanout 关 / debate 开** |
| 是否动 covenant | 是（A/B 验证后） | 是（A/B 验证后） | **不动**（只产案例 + 模式） |

---

## 一、目标与非目标

### 目标

1. **AI 出题人按"价值投机审美"挑题**：三家 AI（Claude / Gemini / Codex）联合 fan-out 出题，从 LinDangAgent 粗筛池里精选 case
2. **审美牵引反馈环**：用户对入选名单勾选 / 拒绝 / 简短反馈 → 自动 append 到出题 prompt → 长期向用户审美收敛
3. **单 case 深度复盘**：每只 case 跑完整 fanout → debate → summary，独立 markdown 报告
4. **hindsight bias 缓解**：fanout 阶段强制无网（仅量化数据），debate/summary 阶段开联网（验证 / 修正假设）
5. **双层学习沉淀**：
   - **案例库**：人类可查阅的复盘报告（独立 markdown / Hub 内嵌面板可视化）
   - **模式知识库**：跨 case 共性提炼写入 `.arena/memory/shared/facts.md`（复用 arena-memory M1，自动注入未来圆桌）
6. **每周 10 只节奏**：周日夜跑或用户手动触发，约 3 小时算力 / 周

### 非目标

- ❌ **不接 T+10 判卷 / 量化 hit-rate**（区别于轨道 2，不评判"准确率"）
- ❌ **不动 covenant.md 自动改**（区别于轨道 2，避免无 hit-rate 闭环时盲改 prompt 的风险）
- ❌ **不做 mock decision**（不让 AI"假装回到 T0"再揭示结果——纯事后归因）
- ❌ **不接交易系统**
- ❌ **不引入 cron daemon**（手动触发或半自动）
- ❌ **不引入新依赖**（HTML 复用 Hub 内嵌渲染层 / 不上 node-cron / markdown-it 等新包）

---

## 二、业界相关工作（简短调研）

### 学术参考

| 工作 | 启发 |
|---|---|
| **Reflexion** (Shinn et al., 2023) | LLM agent self-reflection 改进任务表现 → 本系统的"模式提炼"借鉴反思思路 |
| **Multi-Agent Debate** (Irving et al., 2018; Du et al., 2023) | 多 LLM 辩论提取真理 / 增强推理 → 本系统的"三家 fan-out 出题 + debate 复盘"是其在金融垂直的实例化 |
| **Hindsight Experience Replay** (Andrychowicz et al., 2017) | DRL 用 hindsight 重生成训练目标 → 启发"事后已知结果归因"思路 |
| **Constitutional AI** (Anthropic, 2022) | self-critique 改进输出 → 启发"用户审美牵引"反馈环 |

### 金融业界对照

| 系统 | 思路 | 与本系统差异 |
|---|---|---|
| **BloombergGPT / FinGPT** | 金融大模型单 inference | 单模型，缺多 AI 协作 |
| **Morgan Stanley AI@MS / JPMorgan IndexGPT** | 大行 RAG 客户咨询助手 | 偏 Q&A，少 case-based learning |
| **同花顺 i 问财 / 东财 ChatGPT** | 国内单 AI 问答 | 无圆桌、无模式沉淀 |
| **Numerai** | 众包量化模型集成 | 目标是预测 alpha，不是学习 |
| **量化研究 backtest + post-mortem** | 人类研究员事后复盘 | 缺 AI 协作 + 模式自动化沉淀 |
| **医学 M&M conferences** | 集体复盘病例 | 思路最接近，但只人类参与 |

### 差异化定位

> "**三家 AI 圆桌后验复盘 + 双层沉淀（案例库 + 模式库）+ 用户审美牵引**" 在公开资料中找不到完全对应的系统。重点不在"准确率"而在**经验沉淀 + 知识结构化 + 与用户审美对齐**。

---

## 三、整体架构（端到端数据流）

```
[用户手动触发 或 周日夜跑]
         │
         ▼
┌──────────────────────────────────────┐
│ Step 1: LinDangAgent 粗筛           │
│ scan_history_pool(window=12m,        │
│                   min_volatility=0.20)│
│ 过滤: ST/新股/退市/振幅过小/数据缺失│
│ 输出: 100-200 只候选                │
│       + 33字段 + 区间起止 + 高/低点│
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Step 2: 三家 fan-out 出题           │
│ Claude / Gemini / Codex 并行          │
│ 每家收到:                           │
│   - 候选池 JSON                     │
│   - 出题人 system prompt（含用户   │
│     6 类机会"审美参考"）           │
│   - 反馈历史摘要（最近 N 条）       │
│ 每家输出: 10 只精选 + 入选理由      │
│ Hub 端: union → 最多 30 只           │
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Step 3: 用户勾选 + 反馈              │
│ Hub UI 'picks-review' 面板:          │
│   - 30 只 case 卡片 + 三家入选理由   │
│   - 用户勾选最终 10 只               │
│   - 可选: 写简短拒绝理由             │
│ 反馈写 feedback.jsonl                │
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Step 4: 单 case 复盘批次（串行）    │
│ 对每只 case 跑独立圆桌会议:        │
│   meetingId = lab-<batch>-<n>       │
│ ┌──────────────────────────────────┐│
│ │ fanout 阶段 (无网)             ││
│ │   - 仅 LinDangAgent 量化数据   ││
│ │   - K线 + 33字段 + 财报        ││
│ │   - 三家独立给"假设性归因"     ││
│ ├──────────────────────────────────┤│
│ │ debate 阶段 (开联网)           ││
│ │   - 三家可联网查当时新闻 / 政策││
│ │   - 验证 / 修正 / 补充 fanout 假设│
│ ├──────────────────────────────────┤│
│ │ summary 阶段                    ││
│ │   - 选定 summarizer 综合输出    ││
│ │   - 写 case-N-<symbol>.md       ││
│ └──────────────────────────────────┘│
│ 10 case * ~20 分钟 ≈ 3 小时          │
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Step 5: 模式提炼                    │
│ 三家看本批 10 只 case summary →     │
│ 提炼跨 case 共性 / 6 类应用心得     │
│ → arena-memory `appendFact()`        │
│ → .arena/memory/shared/facts.md      │
│ 自动 dedup（相同 what 不重复）       │
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Step 6: Hub '复盘 Lab' 面板呈现     │
│ 新 tab，三大区:                     │
│   - 历史 batch 列表                 │
│   - case 详情 viewer                │
│   - 审美牵引调试 (feedback / 拒绝率)│
└──────────────────────────────────────┘
```

---

## 四、关键组件

### 4.1 LinDangAgent 历史扫描（~80 行 Python）

**新增**：`C:\LinDangAgent\services\fetch_for_arena.py` 增 `scan_history_pool` 子命令

```python
# 子命令: python -m services.fetch_for_arena scan_history_pool \
#           --window 12m --min-volatility 0.20 --universe hot_rank \
#           --output-format json
def scan_history_pool(window_months=12, min_volatility=0.20, universe='hot_rank'):
    # 1. 取股票池（hot_rank 或全市场）
    # 2. 剔除 ST / 新股 < 6m / 退市 / 长期停牌
    # 3. 计算窗口内最大振幅 = (high - low) / low
    # 4. 过滤 max_amplitude >= min_volatility
    # 5. 复用 build_report_context 拉每只 33 字段 + 财报 + K 线摘要
    # 输出 JSON 数组 [{ts_code, name, period_start, period_end, max_drawdown,
    #                   max_gain, fundamental_summary, k_line_summary, ...}]
```

**复用**：`top10/hot_rank.py` 池 + `top10/stock_filter.py` 过滤 + `data/report_data.py::build_report_context` 33 字段。

**输出量**：100-200 只候选 / 周（hot_rank 池约 500 只 → 振幅 >20% 过滤后约 100-200 只）。

---

### 4.2 出题人 fan-out（~150 行）

**新增**：`core/research-lab/ticket-proposer.js`

```js
async function proposeTickets({ candidatePool, feedbackHistory }) {
  const systemPrompt = composeProposerSystemPrompt(feedbackHistory);
  const userPrompt = formatCandidatePool(candidatePool);

  const tasks = [
    callClaude({ systemPrompt, userPrompt, model: 'opus' }),
    callGemini({ systemPrompt, userPrompt }),
    callCodex({ systemPrompt, userPrompt }),
  ];
  const [claudePicks, geminiPicks, codexPicks] = await Promise.allSettled(tasks);

  return {
    claude: parsePicks(claudePicks),
    gemini: parsePicks(geminiPicks),
    codex: parsePicks(codexPicks),
    union: mergeUnique([claudePicks, geminiPicks, codexPicks]).slice(0, 30),
  };
}
```

**出题人 system prompt 骨架**（约 600 字，写入 `proposer-prompt.md` 可演化）：

```
你是投研圆桌的"出题人"，今天的任务是从历史 A 股案例池里挑出适合圆桌复盘讨论的精典 case。

【挑选基础门槛】
- 区间内有波动 >20%（不是平稳一条线，也不是单边趋势）
- 基本面有保证（不是 ST、不是纯炒作妖股、有真实业绩支撑）
- 有炒作题材或预期差（市场认知 vs 真实情况存在错配）

【价值投机审美参考（用户提供，仅供理解风格，不要原文照搬，应当形成自己的判断）】
A 股的大交易机会粗略分为 6 类：
1. 政策主导：每次大政策带来超级行情（涨价去库存的地产、新能源车、雄安等）
2. 科技突破：新科技催化（消费电子 iPhone、特斯拉一体化压铸、AI 算力等）
3. 周期品种：横跨时间长涨幅巨大（猪周期、航运、煤、铜等）
4. 新消费：爆发性销售增长真实事件（TWS、扫地机器人、减肥药、冰雪经济等）
5. 突发事件供需失衡：少见但弹性极大（疫情医疗、PVDF 短缺、TMA 短缺等）
6. 利空错杀：经典但难做（华塑剂事件白酒、制裁中兴等，多数失败）

前 5 类积极找；第 6 类不重点研究。**你应当允许识别 6 类之外的新模式**。

【出题输出要求】
- 选 10 只 case
- 每只必须写：(1) 入选理由 200 字内 (2) 属于哪类机会（或新类）(3) 关键数据点（区间起止日期 / 涨跌幅 / 当时基本面状态）
- 避免连续选同一题材（保证多样性）

【用户审美反馈历史】
（最近 N 条用户拒绝 / 接受的样本 + 简短理由会自动 append 到这里）

输出 JSON: [{ts_code, name, opportunity_class, period, key_data, rationale}, ...]
```

**关键设计**：
- 三家收到**完全相同**的 system + user prompt（差异化来自模型本身，不是 prompt）
- `feedbackHistory` 自动 append 到 system prompt 末尾（**最近 20 条 reject / accept 摘要**）
- union 去重逻辑：`ts_code` 相同视为同 case，保留第一个 rationale

---

### 4.3 用户勾选反馈（~120 行）

**新增**：`renderer/research-lab-picks.js` + `renderer/research-lab-picks.css`

**UI**：Hub 弹出半屏面板
- 30 只 case 卡片（每张：股票名 + 区间走势缩略图 + 三家入选理由 tabs）
- 卡片左侧 checkbox（默认全勾，用户取消勾选）
- 每张卡片可选填"拒绝理由"（短文本框，可不填）
- 底部"确认"按钮（必须勾够 10 只 ± 2 容错才能确认）

**反馈写入**：

```jsonl
// .arena/research-lab/feedback.jsonl
{"v":1,"ts":1714339200000,"batch":"2026-W18","ts_code":"600519","action":"reject","reason":"白酒不属于价值投机风格","proposer":"gemini"}
{"v":1,"ts":1714339200000,"batch":"2026-W18","ts_code":"300316","action":"accept","reason":null,"proposer":"claude"}
```

**牵引机制**：每次出题时取 `feedback.jsonl` 最近 20 条 → 摘要 → append 到 system prompt 末尾。

---

### 4.4 单 case 复盘批次调度（~200 行）

**新增**：`core/research-lab/case-runner.js`

```js
async function runCaseBatch(batchId, picks) {
  const results = [];
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    try {
      const meetingId = `lab-${batchId}-${String(i+1).padStart(2,'0')}`;
      const report = await runSingleCase({ meetingId, pick, batchId });
      results.push({ ...pick, status: 'success', report });
    } catch (e) {
      results.push({ ...pick, status: 'failed', error: e.message });
      console.error(`[lab] case ${pick.ts_code} failed:`, e);
      // 单 case 失败不影响其他
    }
    // 每只 case 之间 sleep 30 秒（避免 RPM 限流）
    await sleep(30000);
  }
  return results;
}

async function runSingleCase({ meetingId, pick, batchId }) {
  // 1. 创建临时 research-mode 会议室
  await createMeetingRoom(meetingId, { researchMode: true, ephemeral: true });

  // 2. fanout 阶段（无网）
  const fanoutPrompt = composeFanoutPrompt(pick, { dataPack: pick.full_data });
  const fanoutResults = await orchestrator.startTurn('fanout', fanoutPrompt, {
    disableWebSearch: true,  // 关键
    disableMCPSearch: true,
  });

  // 3. debate 阶段（开网）
  const debatePrompt = composeDebatePrompt(fanoutResults, pick);
  const debateResults = await orchestrator.startTurn('debate', debatePrompt, {
    disableWebSearch: false,  // 联网允许
    disableMCPSearch: false,
  });

  // 4. summary 阶段
  const summaryPrompt = composeSummaryPrompt(fanoutResults, debateResults, pick);
  const summary = await orchestrator.startTurn('summary', summaryPrompt, {
    summarizer: pickSummarizer(batchId, i),  // 三家轮值
  });

  // 5. 落 markdown
  const reportPath = path.join(arenaDir, 'research-lab', batchId,
                                `case-${i+1}-${pick.ts_code}.md`);
  await writeReport(reportPath, { pick, fanoutResults, debateResults, summary });

  // 6. 销毁临时会议室
  await closeMeetingRoom(meetingId);
  return reportPath;
}
```

**关键技术点**：
- **fanout 阶段强制无网** = hindsight bias 缓解的核心
- 复用现有 `core/roundtable-orchestrator.js`，加 `disableWebSearch / disableMCPSearch` 参数
- 临时 ephemeral 会议室（不在 Hub 主界面显示，跑完即销毁）
- 单 case 失败不影响其他（只标记 failed 跳过）
- 30s 间隔节流，避免 RPM 限流

---

### 4.5 模式提炼（~100 行）

**新增**：`core/research-lab/pattern-distiller.js`

**触发**：单批 10 只 case 跑完后自动调用。

```js
async function distillPatterns(batchId, caseReports) {
  const systemPrompt = `你是投研圆桌"模式提炼员"。请阅读本批 ${caseReports.length} 只 case 的 summary，
提炼跨 case 共性 / 价值投机经验 / 6 类应用心得。

输出 JSON: [{
  what: "...简短模式描述（一句话）",
  why: "...证据来自哪几只 case + 关键证据点",
  status: "observed" | "hypothesis",
  category: "policy" | "tech" | "cycle" | "consumer" | "supply_shock" | "mispriced" | "other"
}, ...]

要求：每条 fact 必须有至少 2 只 case 证据；少于 2 只标 hypothesis。`;

  // 三家分别提炼，取并集
  const [claudeFacts, geminiFacts, codexFacts] = await Promise.all([
    callClaude({ systemPrompt, userPrompt: formatReports(caseReports) }),
    callGemini({ systemPrompt, userPrompt: formatReports(caseReports) }),
    callCodex({ systemPrompt, userPrompt: formatReports(caseReports) }),
  ]);

  // 写入 arena-memory M1 facts.md
  const allFacts = [...claudeFacts, ...geminiFacts, ...codexFacts];
  for (const fact of allFacts) {
    await arenaMemoryStore.appendFact(projectCwd, {
      what: fact.what,
      why: fact.why + ` [batch=${batchId}]`,
      status: fact.status,
      source: `lab-${batchId}`,
    });
  }
  // appendFact 内部已 dedup（相同 ## what 行不重复）
}
```

**复用**：`core/arena-memory/store.js::appendFact`（commit `2c2c283`）已实现去重。

**写入位置**：`.arena/memory/shared/facts.md`（与 driver-mode 共用）—— 未来圆桌讨论自动注入（commit `8f49c5c` 已实现 sentinel injector）。

---

### 4.6 Hub 复盘 Lab 面板（~300 行）

**新增**：
- `renderer/research-lab-panel.js`
- `renderer/research-lab-panel.css`
- `renderer/index.html` +30 行（新 tab DOM）

**Tab 结构**：

```
┌─ Hub 主界面 ─────────────────────────────────┐
│ [会议室] [复盘 Lab] [设置] ...               │
├─────────────────────────────────────────────┤
│ ┌─ 左侧 batch 列表 ──┬─ 右侧详情区 ────────┐│
│ │ 2026-W18 ✓        │ 当前选中: case-03     ││
│ │ 2026-W17 ✓        │ 寒武纪 (300316.SH)    ││
│ │ 2026-W16 ✓        │ 区间: 2024-08~12      ││
│ │ + 新建 batch       │ 涨幅: +147%           ││
│ │                    │ ─────                 ││
│ │                    │ [fanout]              ││
│ │                    │ Claude: ...           ││
│ │                    │ Gemini: ...           ││
│ │                    │ Codex: ...            ││
│ │                    │ [debate]              ││
│ │                    │ ...                   ││
│ │                    │ [summary]             ││
│ │                    │ ...                   ││
│ └────────────────────┴───────────────────────┘│
│ ┌─ 底部：审美牵引调试区 ────────────────────┐│
│ │ 累计反馈: 47 条 (32 accept / 15 reject)    ││
│ │ 三家拒绝率: Claude 28% / Gemini 35% / ...  ││
│ │ 最近 reject 理由 top: "白酒/医药/银行"    ││
│ └────────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

**主要 UI 状态**：
- 空 batch 状态："开跑本周 batch" 大按钮
- 候选池等待勾选状态：picks-review 弹出
- 跑 case 中：进度条 + 当前 case 名 + ETA
- 跑完成：case 报告 viewer

---

### 4.7 主流程编排（main.js +180 行）

**新增 IPC handlers**：

| IPC | 用途 |
|---|---|
| `lab:start-batch` | 触发新 batch（调 LinDangAgent 粗筛 + 三家出题）|
| `lab:get-picks` | 拿三家出题结果给 UI 显示 |
| `lab:confirm-picks` | 用户勾选确认 → 启动单 case 复盘批次 |
| `lab:get-batch-status` | 拿当前 batch 进度（跑到第几只 case）|
| `lab:list-batches` | 历史 batch 列表 |
| `lab:get-case-report` | 拿单 case markdown 报告 |
| `lab:get-feedback-stats` | 拿审美牵引统计 |

**hookServer 路由**（复用现有 `127.0.0.1:HOOK_PORT`）：
- `POST /api/lab/scan-pool` → LinDangAgent bridge
- `POST /api/lab/case-complete` → 单 case 完成事件回调

**不新增 cron**：用户在 UI 里点"开跑本周 batch"按钮 / 周日夜里手动触发 / 后续可加可选 setInterval（每周日 22:00 自动跑）但 v1 不实现。

---

## 五、数据存储布局

```
<projectCwd>/.arena/research-lab/
├── batch-2026-W18/                       ← 一周一个 batch 目录
│   ├── manifest.json                    ← {batch_id, started_at, completed_at,
│   │                                       picks: [...], status: "completed"}
│   ├── candidate-pool.json              ← LinDangAgent 粗筛输出（100-200 只）
│   ├── proposer-claude.json             ← Claude 出题输出
│   ├── proposer-gemini.json             ← Gemini 出题输出
│   ├── proposer-codex.json              ← Codex 出题输出
│   ├── user-confirmed.json              ← 用户勾选 + 反馈
│   ├── case-01-300316-cn.md             ← 单 case 复盘报告
│   ├── case-02-002241-jl.md
│   ├── ...
│   ├── case-10-...md
│   └── distilled-patterns.md            ← 本批共性模式提炼输出
├── feedback.jsonl                       ← 历次审美反馈（牵引出题）
├── proposer-prompt.md                   ← 出题人当前 prompt（可演化）
└── proposer-prompt-history/             ← 出题 prompt 演化版本
    ├── v1.md
    └── ...
```

**模式知识沉淀**：写入 `<projectCwd>/.arena/memory/shared/facts.md`（与 arena-memory M1 共用，自动 sentinel 注入未来圆桌）。

**单 case markdown 模板**：

```markdown
# case-N: <股票名> (<ts_code>)

**区间**: 2024-08-15 ~ 2024-12-31
**涨幅**: +147% (区间最高 vs 起点)
**机会类型**: 科技突破（AI 算力 / 国产替代）
**入选 proposer**: Claude / Codex
**入选理由**: <来自 proposer 输出>

---

## 量化数据快照（fanout 阶段输入）
- K 线特征: ...
- 33 字段摘要: ...
- 区间内财报: ...

## fanout 阶段（三家无网假设性归因）
### Claude
...
### Gemini
...
### Codex
...

## debate 阶段（三家联网验证 / 修正）
### 联网新增信息
- 2024-09 黄仁勋演讲 / 2024-10 国产替代加速 / ...
### Claude 修正
...
### Gemini 修正
...
### Codex 修正
...

## summary 阶段（综合归因）
**summarizer**: Claude
**最终归因**: ...
**关键时间节点**:
- 2024-08-XX: 启动信号 = ...
- 2024-10-XX: 主升浪 = ...
- 2024-12-XX: 见顶 = ...
**可迁移经验**: ...

## 用户审阅
（用户可在 Hub 面板里写阅读笔记 / 标记重点 case）
```

---

## 六、关键设计决议

### 6.1 完全替代 Track 2，不再走 user-discussion + T+10
- 用户决定（Q1=A）：Track 2 spec 留档不删，标注"已论证但未实施"
- 节省：T+10 等待延迟、selection bias 强、量化判卷复杂度
- 代价：失去"hit-rate 量化反馈环"——但本系统目标是**经验沉淀**而非"准确率"，不需要

### 6.2 双层沉淀（案例库 + 模式库）+ 不动 covenant
- 用户决定（Q2=D）：案例库（人查阅）+ 模式库（自动注入未来讨论），不自动改 covenant
- 风险可控：模式库 = 增量 facts 不删历史 / 出题 prompt 演化需用户审批 / covenant 保持稳定
- 配合 arena-memory M1：facts.md 已有 sentinel 注入机制，模式库零成本接入

### 6.3 LinDangAgent 粗筛 + 三家 fan-out + 用户勾选
- 用户决定（Q4=A + iii）
- LinDangAgent 担任"硬筛可投资性"（数据问题）→ AI 担任"识别价值投机机会"（审美问题）→ 用户最后 30 秒确认（牵引信号）
- 三家差异化出题 = 三种审美呈现，比单 AI 出题视野广
- 不实现 B（自然语言搜索 MCP 工具）—— YAGNI，先看 A 跑顺再说

### 6.4 6 类机会作为"风格参考"非教条
- 用户原话："**我刚给的 prompt 可以作为参考，也不用完全一致（否则 AI 就被训练得和我给的 prompt 完全一样了）**"
- 出题 system prompt 精炼 6 类描述（约 300 字）+ 显式提示"应允许识别 6 类之外的新模式"
- 反馈机制保证长期向用户审美收敛但不机械复读

### 6.5 单 case 一轮独立深复盘
- 用户决定（Q5=A）：每只 case 跑完整 fanout / debate / summary 三阶段
- 总耗时 ~3 小时 / 批，可周日夜跑或用户手动触发
- 产独立 markdown 报告，可单独引用 / 分享 / 检索

### 6.6 fanout 量化 / debate 联网 分阶段
- 用户决定（Q6=A）
- **hindsight bias 缓解的核心设计**：fanout 让 AI 仅基于量化数据形成"假设"，不被新闻先入为主；debate 阶段联网验证 / 修正
- 实现：扩展 `roundtable-orchestrator` 加 `disableWebSearch` / `disableMCPSearch` 参数

### 6.7 每周 10 只 + Hub 内嵌面板
- 用户决定（Q7=A）：周节奏 + Hub 内嵌不外置 HTML 文件
- 一年 ~520 只 case 积累 → 模式库自然丰富
- Hub 内嵌 = 体验一致 + 数据自带 + 不污染文件系统

### 6.8 不引入 cron daemon
- 与轨道 2 spec 一致 + Hub 风格 + 用户偏好"按需"
- v1 用户手动点按钮触发；后续可加 setInterval 半自动（每周日 22:00 检查）但不强求

### 6.9 不新增依赖
- HTML 渲染：Hub 内嵌（复用既有渲染层）
- markdown 生成：JS 字符串模板（不引入 markdown-it）
- 调度：用户手动 + setInterval 兜底（不引入 node-cron）

---

## 七、错误处理 / 风险

| 场景 | 处理 |
|---|---|
| LinDangAgent scan_history_pool 接口失败 | bridge try/catch，本批跳过 + UI 提示 + 不消耗 AI 调用 |
| 三家某家出题失败 | union 减一家继续，标记失败家；三家全失败时整批失败 |
| 单 case 复盘失败 | 跳过该 case，剩余继续；最后报告 ☑/✗ 状态明确 |
| 联网搜索失败（debate 阶段） | 降级到无网模式继续 + 报告标注"联网失败" |
| AI 出题完全偏离用户审美 | 用户拒绝率高 → 反馈累积到 prompt → 长期收敛；监控指标：每月 reject 率应下降 |
| 长期 facts.md 膨胀 | M1 已有 dedup（相同 ## what 不重复）；后续可加季度 review 触发归并 |
| hindsight bias（用结果反推原因） | fanout 强制无网；debate prompt 警示"避免事后聪明，应当解释为什么这种走势是可预期的"|
| 单 case 复盘耗时过长 | 单 case 设 30 分钟超时；超时跳过；总 batch 设 4 小时上限 |
| ts_code 数据缺失（已退市等） | LinDangAgent 粗筛阶段过滤掉，不进候选池 |
| 用户 30 秒勾选不及完成 | 默认全勾保持；不强制反馈，可后置补 |

---

## 八、测试策略

### 8.1 单元测试

| 测试文件 | 覆盖 |
|---|---|
| `tests/lab-proposer.test.js` | mock 候选池 → 验证三家输出格式 + union 去重逻辑 |
| `tests/lab-feedback.test.js` | 验证 reject 写入 + prompt append 逻辑 |
| `tests/lab-case-runner.test.js` | mock 圆桌 → 验证 10 只串行调度 + 错误恢复 + fanout 关网 / debate 开网 |
| `tests/lab-pattern-distiller.test.js` | mock case 报告 → 验证 facts 抽取 + arena-memory store 调用 |
| `tests/lab-html-renderer.test.js` | 验证 markdown 模板生成 |

### 8.2 E2E（隔离 Hub + Playwright CDP）

**严格遵守 Hub `CLAUDE.md` 测试铁律**：
```powershell
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-lab-test"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9277
```

**E2E 脚本**：`tests/e2e-research-lab.js`
1. 启隔离 Hub
2. 点击主界面"复盘 Lab" tab → "开跑本周 batch"按钮
3. mock LinDangAgent 返回 100 只测试候选
4. 验证三家 fan-out 出题 → picks-review 弹窗显示 30 只
5. 用户勾选 10 只 → 确认
6. 验证单 case 复盘启动（mock 圆桌结果）
7. 验证 markdown 报告 + facts.md 更新
8. 验证 Hub 面板正确显示 batch 详情

**截图验证点**：
- candidate-pool 状态
- picks-review 弹窗
- case 跑动进度条
- case 详情 viewer
- 审美牵引调试区

### 8.3 真实场景验收（M6）

跑 1 个真实 batch（10 只历史 case），验证：
- ✓ 入选名单贴合用户审美（≥ 6/10 接受）
- ✓ case 复盘报告质量（用户阅读后能学到东西，至少 3/10 有"啊原来如此"感）
- ✓ 模式库沉淀（facts.md 至少新增 3-5 条 fact）
- ✓ Hub 面板可视化齐全无 bug
- ✓ 无 hindsight bias 翻车（fanout 阶段三家不应已知"涨了 147%"细节）

---

## 九、里程碑

| Sprint | 内容 | 工期 |
|---|---|---|
| **M1** | LinDangAgent `scan_history_pool` 子命令 + Hub bridge + IPC `lab:start-batch` | 1 天 |
| **M2** | 出题人 fan-out + proposer system prompt + union 逻辑 + 单元测试 | 1 天 |
| **M3** | picks-review UI 面板 + feedback.jsonl + IPC `lab:get-picks` / `lab:confirm-picks` + 出题 prompt append 反馈 | 1.5 天 |
| **M4** | 单 case 复盘 batch 调度 + fanout 关网 / debate 开网扩展 + markdown 报告生成 + 错误恢复 | 1.5 天 |
| **M5** | 模式提炼器 + arena-memory M1 集成 + facts.md 写入 | 1 天 |
| **M6** | Hub 复盘 Lab 面板（左 batch 列表 / 右 case viewer / 底审美牵引区） | 1.5 天 |
| **M7** | E2E（Playwright CDP 隔离 Hub）+ 真实 batch 验收 + 调优 | 1 天 |
| **合计** | | **~8.5 天** |

每个 M 完成后由用户验证 stop 点，通过后进入下一 M：
1. M1 → 跑通粗筛接口 + 候选池 100-200 只
2. M2 → 三家 fan-out 输出 union 30 只 + 入选理由格式正确
3. M3 → picks-review UI 可勾选 + feedback 写入 + 出题 prompt 自动收集反馈
4. M4 → 单 case 复盘跑通（mock LinDangAgent 数据）+ fanout 无网 / debate 联网验证
5. M5 → 模式提炼输出 + facts.md 增量正确
6. M6 → Hub 面板完整 + 历史 batch 列表 + case 详情 viewer
7. M7 → 一个真实 batch 跑通 + 6/10 满意度 + 模式库新增

---

## 十、关键文件清单（汇总）

| 操作 | 文件 | 行数预估 |
|---|---|---|
| 新建 | `core/research-lab/ticket-proposer.js` | ~150 |
| 新建 | `core/research-lab/case-runner.js` | ~200 |
| 新建 | `core/research-lab/pattern-distiller.js` | ~100 |
| 新建 | `core/research-lab/lab-storage.js` | ~80（manifest 读写、batch 目录管理） |
| 新建 | `core/lab-bridge.js`（LinDangAgent scan_history_pool 桥接） | ~80 |
| 新建（LinDangAgent 仓库） | `services/fetch_for_arena.py::scan_history_pool` 子命令 | ~80 |
| 新建 | `renderer/research-lab-panel.js` | ~250 |
| 新建 | `renderer/research-lab-panel.css` | ~150 |
| 新建 | `renderer/research-lab-picks.js`（picks-review UI） | ~120 |
| 新建 | `docs/research-lab-proposer-prompt.md`（出题人 prompt 模板） | ~50 |
| 新建 | `tests/lab-*.test.js` 单元测试 | ~400 |
| 新建 | `tests/e2e-research-lab.js` | ~300 |
| 修改 | `core/roundtable-orchestrator.js`（加 disableWebSearch / disableMCPSearch 参数） | +40 |
| 修改 | `main.js`（IPC handlers + hookServer 路由 + 启动时初始化 lab） | +180 |
| 修改 | `renderer/index.html`（新增"复盘 Lab" tab DOM） | +30 |
| 修改 | `renderer/renderer.js`（tab 切换逻辑） | +30 |

合计 ~2240 行（含测试）。

---

## 十一、成功标准

**M1 通过**：
- LinDangAgent `scan_history_pool` 返回 ≥100 只候选 / 周
- 输出格式合规（含 ts_code / period / 33 字段摘要）

**M3 通过**：
- 三家 fan-out 出题 + union 去重至 30 只
- picks-review UI 可勾选 + feedback.jsonl 写入正确
- 出题 prompt 下次调用自动 append 最近 20 条反馈

**M5 通过**：
- 模式提炼输出 ≥ 5 条 fact
- arena-memory `facts.md` 增量写入 + dedup 正确

**M7 通过 / 项目验收**：
- ✓ 真实跑通 1 个 batch（10 只历史 case）
- ✓ 入选名单 user prefer rate ≥ 60%（10 只接受 ≥ 6 只）
- ✓ case 复盘报告质量（用户阅读后认可 ≥ 3 只"啊原来如此"）
- ✓ 模式库累积 ≥ 3 条新 fact
- ✓ Hub 面板可视化齐全
- ✓ E2E 通过（Playwright CDP 隔离 Hub）

---

## 十二、不做的事（YAGNI 重申）

- ❌ **不做 Track 2**（user-discussion + T+10 判卷）— 已被本系统替代
- ❌ **不动 covenant.md**（保护当前圆桌系统稳定）
- ❌ **不接 hit-rate 量化判卷**（本系统目标是经验沉淀非准确率）
- ❌ **不做 mock decision**（不让 AI 假装回到 T0）
- ❌ **不接交易系统**
- ❌ **不引入新依赖**（含 node-cron / markdown-it 等）
- ❌ **不扩展 LinDangAgent NLU 自然语言搜索**（YAGNI，先 A 跑顺再考虑 B 方案）
- ❌ **不做跨设备同步 / 多用户**（本机使用即可）
- ❌ **不做 case-level mock 决策评估**（hindsight 模式只复盘不评估）
- ❌ **不做"出题人 prompt 自动改"**（提议自动产生 → 必须用户审批后采纳）

---

## 十三、与已有系统的关系

| 已有系统 | 关系 |
|---|---|
| **投研圆桌**（research mode） | **复用** orchestrator 跑 fanout/debate/summary；扩展加 disableWebSearch 参数 |
| **arena-memory M1** | **复用** `appendFact` 写 facts.md + sentinel injector 自动注入未来圆桌 |
| **driver mode + 主驾系统** | **不影响**——本系统跑 ephemeral 临时会议室，不污染主驾流程 |
| **LinDangAgent fetch_for_arena.py** | **扩展**——新增 `scan_history_pool` 子命令 |
| **轨道 2 spec**（natural-selfplay） | **替代**——保留 spec 文件归档但不实施 |
| **Hub 主界面 / index.html** | **扩展**——新增"复盘 Lab" tab |

---

## 十四、风险监控

每月一次手动 review：

| 指标 | 阈值 | 异常处理 |
|---|---|---|
| 用户对 picks 接受率 | ≥ 60% | < 60% → 检查 feedback append 逻辑 + 调整 system prompt |
| facts.md 新增条数 / 月 | ≥ 10 条 | < 10 → 检查 distiller / 三家是否同质化输出 |
| case 报告质量主观评价 | ≥ 3/10 "啊原来如此" | < 3 → 调整 fanout/debate prompt + 检查数据完整度 |
| hindsight bias 自检 | fanout 阶段无"已知后续"细节 | 出现 → 强化 prompt 警示 + 检查 disableWebSearch 是否生效 |
| 单 batch 耗时 | ≤ 4 小时 | > 4 → 检查 RPM 节流 + 单 case 超时设置 |

---

## 十五、未来扩展（v2 候选）

不在本 Phase 1 范围内，仅记录后续方向：

1. **B 方案融合**：扩展 LinDangAgent 加自然语言搜索 MCP 工具，让 AI 出题人能自由探索粗筛池外的 case
2. **跨 batch 模式融合**：积累 6+ 个 batch 后，让三家 review 历史 facts.md 提炼"meta-pattern"（模式的模式）
3. **半自动调度**：每周日 22:00 自动启 batch（用 setInterval 实现，不引入 cron）
4. **用户笔记功能**：case 详情 viewer 加"我的笔记"输入区，长期形成"用户读史本"
5. **Case 导出**：单 case markdown / 整 batch HTML 导出分享
6. **回归 hit-rate**：如果用户后期想加量化反馈，可与 Track 2 spec 重新合并设计

---

> 本 spec 是 brainstorming 收敛后的设计稿。所有关键决策点已与用户对齐：
> - Q1=A（替代 Track 2）/ Q2=D（双层沉淀不动 covenant）
> - Q3=AI 自挑 + 6 类参考非教条 + 用户审美牵引
> - Q4=A（粗筛 + fan-out）+ iii（三家联合）
> - Q5=A（单 case 深复盘）/ Q6=A（分阶段 fanout 关 / debate 开）/ Q7=A（每周 10 + Hub 内嵌）
