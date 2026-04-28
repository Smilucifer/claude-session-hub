# 投研圆桌 · 自然 self-play 学习引擎 Design

> 版本：Phase 1（轨道 2 / 自然学习）
> 日期：2026-04-28
> 上下文：投研圆桌（research mode）已能跑 fanout / debate / summary 三阶段讨论并归档，但讨论结果"只归档不学习"。本设计为圆桌新增 **自然 self-play 学习能力**：用户真实场景讨论 → T+10 自动判卷 → 三家反思 → covenant/profile/prompt 自动改进。
>
> 本 spec 是双轨设计的 **轨道 2 部分**。轨道 1（量化训练 · 关闭联网）暂缓，待用户后续决策。
>
> 详细背景与权衡见：`docs/roundtable-self-learning-2026-04-28.html`

---

## 一、目标与非目标

### 目标
1. **真实场景训练**：用户白天和圆桌真实讨论时，三家 AI 全开联网/沙箱/MCP。这场讨论本身就是训练数据，零 distribution shift。
2. **方向自动识别**：summary 完成后由 DeepSeek 自动判别"决策类讨论"还是"思辨类讨论"。决策类登记进 outcome 系统等待 T+10 判卷；思辨类只归档不训练。
3. **T+10 自动判卷**：夜间 cron 扫描 `outcome_pending.jsonl`，找到判卷条件已满足的条目（exam_date + 10 个交易日已过），调用 LinDangAgent 拉实际涨跌算 hit/miss。
4. **三家自反思 + 跨家互审**：累积达阈值后触发反思，每家看自己 hit_rate/弱项 → 提 proposals → 跨家互审 → Opus 仲裁 → 输出最终采纳列表。
5. **三类改动 staging**：covenant 改动自动 staging；profile 增量观察自动 append；summary/debate prompt 改动必须用户审批。
6. **自动 A/B 验证**：staging 配置必须在 holdout 样本上 hit_rate +3% 才采纳；任一退步即回退。
7. **版本演化清空桶**：proposal 采纳后旧 nat_session 归档，新桶从 0 累积，避免老样本污染新版本评估。

### 非目标
- **轨道 1（量化训练 · 关联网）**：本 spec 不实施。M1 完成后由用户决定是否进入。
- **跨家分桶定制 covenant**：保持三家共用一份 covenant，等出现严重 hit_rate 失衡再考虑。
- **架构级反思**（如改三家分工 / 改 debate 模式）：proposal 白名单只允许 covenant/profile/prompt 编辑；架构建议另存 `architectural_suggestions.md` 供季度 review。
- **跨设备同步**：所有学习数据存本机 `~/.arena-research/`。
- **真金白银下单**：本 spec 只做 hit/miss 信号闭环，不接交易系统。

---

## 二、现状分析

### 2.1 圆桌已有能力（可复用）

| 模块 | 文件:行 | 现有能力 |
|---|---|---|
| 圆桌状态机 | `core/roundtable-orchestrator.js` | turns 持久化（`<hubData>/arena-prompts/<mid>-turn-N.json`）+ summary 后自动归档 `.arena/sessions/<datetime>-<title>.md` |
| summary 决策档案 | `main.js:878-921` | 写入 Claude session.cwd 下 `.arena/sessions/`；含 `meta.decisionTitle / summarizer / 全部历史轮次` |
| LinDangAgent 数据层 | `data/report_data.py:820` | `build_report_context(time_lock=...)` 已支持时间锁定，可用于 T+10 拉数据 |
| LinDangAgent outcomes 系统 | `outcomes.db` + `services/top100_review_service.py` | war_room 已有判卷调度，复用其 cron 模板 |
| transcript-tap | `core/transcript-tap.js` | summary 完成事件已能监听 |
| MCP 工具桥接 | `core/research-mcp-server.js` + `core/lindang-bridge.js` | 已有 fetch_lindang_stock 等三个工具，可加 `roundtable_register_outcome` |

### 2.2 当前缺口

| 缺口 | 后果 |
|---|---|
| summary 完成后无方向标 | 没有结构化的 "看多/看空/中性"，无法算 hit/miss |
| 没有"决策类 vs 思辨类"判别 | 思辨讨论被错误推入训练，污染 hit_rate |
| 没有 outcome_pending.jsonl | 无 T+10 判卷调度入口 |
| 没有反思引擎 | hit_rate 数据躺尸，无 propose 能力 |
| 没有 staging 机制 | covenant 改动直接覆盖生产 risky；prompt 改动无审批通道 |
| 没有 A/B 验证 | 反思建议没法验证就采纳 = 盲改 |
| 没有 covenant 版本管理 | 旧样本在 v1 covenant 下判，新样本在 v2 下判，混算 hit_rate 信号失真 |

---

## 三、整体架构

### 3.1 数据流（端到端）

```
用户白天打开圆桌讨论"今天能不能买兆易创新"
                     │
                     ▼
         ┌───────────────────────────┐
         │  圆桌正常运作（联网全开）   │
         │  fanout → debate → summary │
         └────────────┬───────────────┘
                      │ summary 完成
                      ▼
         ┌────────────────────────────────────┐
         │  classify(summary_text)            │
         │  DeepSeek 自动判别                  │
         │  决策类 / 思辨类                    │
         └─────┬───────────────────┬──────────┘
               │决策类             │思辨类
               ▼                   ▼
   登记 outcome_pending.jsonl    profile 增量观察
   { ts_code, exam_date,         （只归档，不训练）
     directions, summarizer,
     covenant_hash }
               │
               │ … T+10 等待 …
               ▼
        夜间 cron 23:00
        扫 outcome_pending.jsonl
        找到 exam_date+10TD 已过的条目
               │
               ▼
        LinDangAgent 拉实际涨跌
        算 stock α / market β / sector β
        hit/miss 三家分别算
               │
               ▼
        写 nat_session.jsonl（带 covenant_hash）
        移除 outcome_pending 中对应条目
               │
               │ 累积达 30 条（按当前 covenant_hash 分桶）
               ▼
        ┌──────────────────────────────────┐
        │  反思引擎（三阶段）              │
        │  Stage A: 三家各自反思           │
        │  Stage B: 跨家互审               │
        │  Stage C: Opus 仲裁              │
        │  输出 proposals[]                │
        └────────────┬─────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────────┐
        │  Staging                          │
        │  covenant_staging.md  ← 自动      │
        │  profile_staging.md   ← 自动      │
        │  prompt_staging.md    ← 用户审批  │
        └────────────┬─────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────────┐
        │  A/B 验证                          │
        │  从 nat_session 抽 5 holdout     │
        │  旧 covenant 跑一遍 → 旧 hit_rate │
        │  新 covenant 跑一遍 → 新 hit_rate │
        │  两组 +3% 且无断崖 → 采纳         │
        └────────────┬─────────────────────┘
                     │采纳
                     ▼
        ┌──────────────────────────────────┐
        │  生效 + 清空桶                    │
        │  staging 覆盖到生产 covenant.md   │
        │  当前 nat_session.jsonl 归档为     │
        │     nat_session_archive_v1.jsonl  │
        │  新桶 nat_session_v2.jsonl 从 0   │
        └──────────────────────────────────┘
```

### 3.2 存储布局

```
~/.arena-research/                       ← 新建（学习数据根目录）
├── profile.md                           ← 用户画像（主体段 + 增量观察段）
├── covenant.md                          ← 当前生产 covenant（版本号在文件头）
├── covenant_history/                    ← covenant 历史版本归档
│   ├── v1.md
│   ├── v2.md
│   └── ...
├── outcome_pending.jsonl                ← 等待 T+10 判卷的条目
├── nat_session_v<N>.jsonl               ← 当前活跃桶（按 covenant 版本号分桶）
├── archive/
│   ├── nat_session_v1.jsonl             ← 已采纳新版本后归档的旧桶
│   └── nat_session_v2.jsonl
├── staging/
│   ├── covenant.md                      ← 候选 covenant
│   ├── profile.md                       ← 候选 profile
│   ├── research-rules.md                ← 候选 summary/debate prompt 模板
│   ├── changelog.md                     ← 本次变更摘要
│   └── ab_results.json                  ← A/B 验证记录
├── reflections/
│   ├── 2026-05-15_v1_reflect.json       ← 历次反思日志
│   └── ...
├── rejected_proposals.jsonl             ← A/B 失败的 proposals 历史
└── architectural_suggestions.md         ← 架构级建议（不自动采纳）
```

### 3.3 与 Hub 的集成点

| Hub 模块 | 改动 | 说明 |
|---|---|---|
| `core/research-mode.js` | 修改 RESEARCH_RULES_TEMPLATE | summary 阶段加 covenant + profile 注入；不强制 TENDENCY 尾标（DeepSeek 后置抽取代替） |
| `core/roundtable-orchestrator.js` | 加 `onSummaryComplete` hook | summary 完成后调 outcome-tracker.classifyAndRegister |
| `main.js` | 新增 IPC + cron | `learn:reflect`/`learn:adopt`/`learn:status`；启动 cron daemon |
| `core/transcript-tap.js` | 不改 | 已能监听 summary 事件 |

---

## 四、关键组件

### 4.1 `core/learn/outcome-tracker.js`（~180 行）

负责：summary 完成后 → 类型判别 → 登记 outcome_pending → T+10 判卷 → 写 nat_session。

```js
// 主入口
async function onSummaryComplete({ meetingId, summaryText, summarizer, sidByKind, archivedSessionFile, covenantHash }) {
  // 1. DeepSeek 判类型 + 抽方向
  const classify = await classifyDecisionVsContemplation(summaryText);
  // returns: { kind: 'decision'|'contemplation', tsCode?, direction?, confidence? }

  if (classify.kind === 'contemplation') {
    // 思辨类 → 走 profile 增量观察通道（在反思引擎里处理），这里只标记
    return { type: 'contemplation', archived: archivedSessionFile };
  }

  // 决策类 → 必须有 tsCode + direction
  if (!classify.tsCode || !classify.direction) {
    // 决策类但 DeepSeek 抽不出股票/方向 → fallback：让 Claude（带历史 turn）抽一次
    const retry = await retryWithClaude(summaryText, archivedSessionFile);
    if (!retry.tsCode || !retry.direction) {
      return { type: 'unclassifiable', archived: archivedSessionFile };
    }
    Object.assign(classify, retry);
  }

  // 登记 outcome_pending
  const entry = {
    session_id: meetingId,
    ts_code: classify.tsCode,
    exam_date: today(),
    directions: extractAllThreeDirections(summaryText, sidByKind), // 三家 direction（可能从 turn 文本抽）
    summary_decision: classify.direction,
    confidence: classify.confidence,
    summarizer,
    covenant_hash: covenantHash,
    archived_session_file: archivedSessionFile,
    transcript_paths: getTranscriptPaths(sidByKind),
    registered_at: Date.now(),
  };
  appendJsonl(outcomePendingPath(), entry);
  return { type: 'decision', registered: true, entry };
}

// T+10 判卷（cron 调用）
async function judgePendingOutcomes() {
  const pending = readJsonl(outcomePendingPath());
  const remaining = [];
  for (const entry of pending) {
    const t10Date = addTradingDays(entry.exam_date, 10);
    if (todayBefore(t10Date)) {
      remaining.push(entry); // 还没到时间
      continue;
    }
    try {
      const actual = await lindangBridge.fetchActualReturn(entry.ts_code, entry.exam_date, 10);
      // returns: { stock: +5.2, market: +1.1, sector: +2.8, alpha: +2.4 }
      const hits = computeHits(entry.directions, actual);
      const session = {
        ...entry,
        actual_t10: actual,
        hits,
        judged_at: Date.now(),
      };
      appendJsonl(currentBucketPath(entry.covenant_hash), session);
    } catch (e) {
      console.error(`[learn] judge failed for ${entry.session_id}:`, e.message);
      // 失败 3 次后丢弃；记 pending 中尝试次数
      entry.judge_attempts = (entry.judge_attempts || 0) + 1;
      if (entry.judge_attempts < 3) remaining.push(entry);
    }
  }
  writeJsonl(outcomePendingPath(), remaining);
}
```

**Schema：outcome_pending.jsonl 一行**
```json
{
  "session_id": "uuid-v4",
  "ts_code": "603986.SH",
  "exam_date": "2026-04-28",
  "directions": {
    "claude": "bullish",
    "gemini": "neutral",
    "codex": "bullish"
  },
  "summary_decision": "bullish",
  "confidence": 0.7,
  "summarizer": "claude",
  "covenant_hash": "v3-abc123",
  "archived_session_file": "/path/.arena/sessions/2026-04-28-mr-tianyi.md",
  "transcript_paths": {
    "claude": "...", "gemini": "...", "codex": "..."
  },
  "registered_at": 1714291200000,
  "judge_attempts": 0
}
```

**Schema：nat_session_v3.jsonl 一行（在 pending 基础上加判卷字段）**
```json
{
  "...all pending fields...": "...",
  "actual_t10": { "stock": 5.2, "market": 1.1, "sector": 2.8, "alpha": 2.4 },
  "hits": {
    "claude": true, "gemini": true, "codex": true,
    "decision": true
  },
  "judged_at": 1715117600000
}
```

### 4.2 `core/learn/classifier.js`（~80 行）

负责：调 DeepSeek 判别决策 vs 思辨 + 抽 ts_code/direction。

```js
const CLASSIFY_PROMPT = `你需要判别下面的投研讨论 summary 属于哪类：

- 决策类：明确给出"看多/看空/中性"的判断，针对**特定股票**
- 思辨类：分析市场/板块/策略/概念，但**不针对特定股票给方向**

如果是决策类，还要抽取：
1. ts_code（如 603986.SH）
2. direction（bullish/bearish/neutral）
3. confidence（0-1，summary 中体现的把握度）

输出 JSON：{ "kind": "decision"|"contemplation", "ts_code": "...", "direction": "...", "confidence": 0.0 }
缺失的字段填 null。`;

async function classifyDecisionVsContemplation(summaryText) {
  const res = await deepseekChat({
    system: CLASSIFY_PROMPT,
    message: summaryText.slice(0, 4000), // summary 通常 1500 字内
    temperature: 0.1,
    json_mode: true,
  });
  return JSON.parse(res.text);
}
```

**降级**：DeepSeek 不可用时 fallback 到 Claude Haiku（cli-caller skill 已实现）。

### 4.3 `core/learn/reflector.js`（~280 行，搬 LinDangAgent learning_reflector.py）

负责：读当前桶 nat_session → 三家自反思 → 跨家互审 → Opus 仲裁 → 输出 proposals。

**触发条件**：当前桶 nat_session_v<N>.jsonl 累积 ≥ 30 条 + 距上次反思 ≥ 7 天。

**Stage A — 三家自反思（并行）：**

每家 AI 看：
- 自己的 hit_rate / 决策方 hit_rate
- 按 sector / direction / confidence 分组的 hit_rate
- 自己 vs 另两家分歧时的对错频率
- debate 阶段改观点的频率 + 改后准确率

每家输出 `self_proposals[]`：
```json
[
  { "id": "C-P1", "type": "covenant_edit", "target": "关注权重段", "current": "技术面 20%", "proposed": "技术面 30%", "evidence": "我在技术弱项板块 hit 38%，平均 53%", "confidence": "medium" },
  { "id": "C-P2", "type": "summary_prompt_edit", "target": "结论先行段", "current": "...", "proposed": "...", "evidence": "...", "confidence": "low" }
]
```

**Stage B — 跨家互审：**

让每家审视另一家的 proposals（轮换：Claude 审 Gemini / Gemini 审 Codex / Codex 审 Claude）。每条标 pass/doubt/reject。

**Stage C — Opus 仲裁（仅当有 doubt）：**

Opus 看原 proposal + 质疑 + 答辩，做最终 adopt/reject。

**输出**：`reflections/<date>_v<N>_reflect.json`，含全部三阶段记录 + 最终 adopt 列表。

**关键约束**：
- proposal type 白名单：`covenant_edit` / `profile_obs` / `summary_prompt_edit` / `debate_prompt_edit`
- 其他类型（如 `architecture_change`）写入 `architectural_suggestions.md`，不进入 staging
- 反思 prompt 中**附 rejected_proposals.jsonl 历史**，避免反复提同样建议
- 反思 prompt 中**明示 selection bias**（N1）："用户讨论的票存在 selection bias，请区分'用户偏好场景的局部经验' vs '普遍规律'"

### 4.4 `core/learn/staging-manager.js`（~200 行）

负责：proposals → staging 文件 → A/B 验证 → 采纳 / 回退。

**Staging 写入：**
| proposal type | staging 文件 | 采纳条件 |
|---|---|---|
| covenant_edit | `staging/covenant.md` | A/B 验证通过 |
| profile_obs | 直接 append 到 `profile.md` 增量观察段 | 自动采纳 |
| summary_prompt_edit | `staging/research-rules.md` | **用户审批** + A/B 验证 |
| debate_prompt_edit | `staging/research-rules.md`（debate 段） | **用户审批** + A/B 验证 |

**A/B 验证（核心）：**

⚠ **关键问题**：轨道 2 的 holdout 是真实场景历史讨论（exam_date 在过去）。重跑时如果 AI 联网，会拿到 exam_date 之后的信息（look-ahead bias），A/B 结果失真。

**解决方案**：A/B 重跑必须 **关联网 + time_lock 模式**——

- 用 LinDangAgent `build_report_context(time_lock=exam_date)` 预拉数据快照
- 注入到三家圆桌作为 prompt 上下文
- 关闭三家所有 web/sandbox/MCP 工具（与轨道 1 类似的封闭模式）
- 三家只能基于 prompt 上下文 + 新/旧 covenant 重新讨论
- 这样 A/B 隔离了"信息源"，只测"covenant/prompt 改动"的影响

**Acknowledged limitation**：A/B 跑出的绝对 hit_rate 会比真实联网模式偏低（缺新闻/舆情）。但 **delta（新 vs 旧）是关键信号**，绝对值不重要——验证的是"covenant 改动是否带来增量提升"，不是"系统总能力"。

```js
async function runABValidation({ stagingCovenant, stagingPrompts }) {
  // 1. 从当前桶 nat_session_v<N> 抽 5 个 holdout（反思过程未参与）
  const holdouts = sampleHoldouts(currentBucketPath(), 5);

  // 2. 旧配置跑一遍（time_lock + 关联网模式）
  const oldHits = await reRunHoldoutClosed(holdouts, productionConfig());

  // 3. 新配置跑一遍（同模式）
  const newHits = await reRunHoldoutClosed(holdouts, {
    covenant: stagingCovenant, ...stagingPrompts
  });

  // 4. delta + 断崖检测
  const oldRate = oldHits.filter(h => h).length / holdouts.length;
  const newRate = newHits.filter(h => h).length / holdouts.length;
  const delta = newRate - oldRate;
  const cliffCheck = checkSectorCliff(holdouts, oldHits, newHits);

  return {
    old_rate: oldRate, new_rate: newRate, delta,
    pass: delta >= 0.03 && !cliffCheck.hasCliff,
    cliff_details: cliffCheck,
    mode: 'closed-time-locked',
  };
}

// reRunHoldoutClosed: 用 time_lock 重跑历史 holdout 且关闭联网
// 实际上是把轨道 2 的 holdout 临时降级到轨道 1 模式做对比
async function reRunHoldoutClosed(holdouts, config) {
  const hits = [];
  for (const h of holdouts) {
    const dataPack = await lindangBridge.fetchTimeLocked(h.ts_code, h.exam_date);
    const result = await orchestrator.runOneShotClosed({
      tsCode: h.ts_code,
      examDate: h.exam_date,
      dataPack,
      covenant: config.covenant,
      prompts: config.prompts,
      disableTools: true, // 关 web/sandbox/MCP
    });
    // 与原始 outcome 比较：方向相同就算 hit
    hits.push(result.direction === h.summary_decision &&
              checkActualHit(result.direction, h.actual_t10));
  }
  return hits;
}
```

**附注**：`reRunHoldoutClosed` 的实现部分复用了轨道 1 的基础设施（time_lock + 工具禁用）。M3 实施时会发现这部分代码值得抽出共用，到时候再重构——但 M3 不主动做轨道 1 的完整版。

**采纳路径（pass=true 时）：**
1. 把 `staging/covenant.md` → `covenant.md`
2. 当前桶 `nat_session_v<N>.jsonl` 归档到 `archive/`
3. covenant 版本号 +1（v3 → v4），新桶 `nat_session_v4.jsonl` 从 0 累积
4. covenant_history 存 v3.md 副本
5. 写入反思日志 `reflections/<date>_v3_reflect.json`，标 `adopted=true`

**回退路径（pass=false）：**
1. staging 清空
2. 失败 proposals append 到 `rejected_proposals.jsonl`（含 reason）
3. 当前桶不归档（继续累积）
4. 写入反思日志，标 `adopted=false`

**审批通道（prompt_edit 类）：**

写 staging 文件 + 通知用户（Hub UI 弹通知 + 桌面通知）：
```
反思引擎建议改 summary prompt：
diff: {old → new}
理由: {evidence}
预期效果: {expected_effect}
A/B 验证: 旧 53% → 新 60% (+7%)

请审批：
- 同意 → covenant 一并采纳
- 拒绝 → 仅 covenant 部分采纳，prompt 不变
- 7 天未审批自动 expire
```

### 4.5 `core/learn/cron-daemon.js`（~100 行）

负责：启动夜间任务（用 `setInterval` 实现，不引入 node-cron — 见 5.4）。

- 每 30 分钟轮询一次，检查"距上次执行是否已超过 24h"
- 满足条件则跑全套：`judgePendingOutcomes` → `maybeReflect` → `maybeRunAB`
- 跨 Hub 重启幂等：`last_run.json` 记录每个任务的上次执行时间戳

```js
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const DAILY_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const LAST_RUN_FILE = path.join(arenaResearchDir(), 'last_run.json');

function startCronDaemon() {
  setInterval(tick, POLL_INTERVAL_MS);
  // 启动时立即 tick 一次（捕捉"昨天 Hub 没开机"漏跑的场景）
  tick().catch((e) => console.error('[learn-cron] initial tick failed:', e));
}

async function tick() {
  const lastRun = readLastRun(); // { judge: ts, reflect: ts, ab: ts }
  const now = Date.now();

  if (now - (lastRun.judge || 0) >= DAILY_RUN_INTERVAL_MS) {
    try {
      await outcomeTracker.judgePendingOutcomes();
      lastRun.judge = now;
    } catch (e) { console.error('[learn-cron] judge failed:', e); }
  }

  if (now - (lastRun.reflect || 0) >= DAILY_RUN_INTERVAL_MS) {
    try {
      await reflector.maybeReflect();
      lastRun.reflect = now;
    } catch (e) { console.error('[learn-cron] reflect failed:', e); }
  }

  if (now - (lastRun.ab || 0) >= DAILY_RUN_INTERVAL_MS) {
    try {
      await stagingManager.maybeRunAB();
      lastRun.ab = now;
    } catch (e) { console.error('[learn-cron] ab failed:', e); }
  }

  writeLastRun(lastRun);
}
```

### 4.6 IPC handlers（main.js +120 行）

| IPC | 用途 |
|---|---|
| `learn:status` | 返回当前桶大小 / 上次反思日期 / pending staging |
| `learn:trigger-reflect` | 手动触发反思（绕过定时调度） |
| `learn:approve-staging` | 用户审批 prompt 改动 |
| `learn:reject-staging` | 用户拒绝 prompt 改动 |
| `learn:get-staging-diff` | 获取 staging vs production 的 diff（UI 展示） |
| `learn:rollback-version` | 紧急情况下回滚到上一版本 covenant |

### 4.7 渲染端 UI（renderer/learn-panel.js +250 行）

新增"学习面板"（Hub 主界面顶部菜单加按钮）：
- 当前桶状态：`nat_session_v3.jsonl` 累积 23/30 条
- 最近一次反思：2026-04-15，采纳 2 条 covenant edit
- pending staging：`prompt edit 等待审批`（红色徽章）
- 历史曲线：每个 covenant 版本的 hit_rate

---

## 五、关键设计决议

### 5.1 N2 决议：决策类 vs 思辨类（用户选 B）

**实施**：DeepSeek 自动判别（4.2 节）。
- 优点：不打扰用户，AI 自己判类型
- 风险缓解：fallback 到 Claude Haiku；判别失败时标 `unclassifiable` 不入训练
- 准确率监控：每月统计 DeepSeek 判别 vs 用户事后修正的一致率，<90% 则上调到 v4-pro

### 5.2 N4 决议：covenant 版本演化（用户选 A · 清空桶）

**实施**：
- 每条 outcome 记 `covenant_hash`（covenant 文件 SHA256 前 8 位）
- 当前活跃桶按 hash 命名 `nat_session_v<N>.jsonl`
- proposal 采纳后，旧桶归档到 `archive/`，新桶从 0 累积
- 反思阈值固定 30，但前 3 个月可降级到 60（避免早期统计意义弱）

### 5.3 N1 处理：selection bias

**作为 acknowledged limitation 写进反思 prompt**：
```
注意：本批样本来自用户主动讨论的票，存在 selection bias（往往是高 momentum 标的）。
请区分：
1. "用户偏好场景的局部经验" — 在这类题材上怎么做更准
2. "普遍规律" — 跨题材都成立的判断方法
你的 proposal 应明确标注属于哪类，标"局部经验"的不写到全局 covenant，写到 profile 增量观察。
```

### 5.4 关于新增依赖（cron 调度）

**不引入 node-cron**。Hub `CLAUDE.md` 铁律：禁止新增依赖。

实施改用：
- Hub 启动时启 `setInterval(judgePendingAndReflect, 30 * 60 * 1000)` 半小时轮询
- 每次轮询检查"距上次执行是否超过 24h"，是则跑全套
- 跨重启幂等：用 `last_run.json` 记录时间戳

### 5.5 三家方向抽取（决策类讨论）

DeepSeek classify 出整体 decision direction 后，要回头从每家 turn 文本里抽各自 direction（用于反思阶段算"我和另两家分歧时谁对"）。

实施：
- summary 完成后，DeepSeek 一次调用同时抽三家方向 + 整体决策方向
- 抽不出的标 `direction: null`，反思时排除该家
- 历史 turn 通过 `roundtable-orchestrator.getLastTurn()` 拿（已实现）

---

## 六、错误处理

| 场景 | 处理 |
|---|---|
| DeepSeek 不可用 | fallback Claude Haiku；都失败标 `classify_failed`，该次讨论不入训练（仅归档） |
| LinDangAgent T+10 数据拉不到 | 重试 3 次（每次间隔 24h）；3 次失败后丢弃 outcome（写日志） |
| 反思 Opus 调用失败 | 反思流程中断，下次 cron 重试；同一桶重试不超过 5 次 |
| A/B 验证 reRunRoundtable 失败 | 单条 holdout 失败标 `excluded`，整体允许至多 2 条 excluded；超过则 A/B 整体作废，本次反思 staging 清空 |
| covenant 文件被用户手动改 | hash 变化触发"非系统改动"日志告警；当前桶强制归档（视作版本变更） |
| 复权数据不一致 | 统一前复权，与 LinDangAgent war_room 保持一致 |
| 用户中途打断的会议 | 没触发 summary → 不进 outcome；已触发 summary 但 DeepSeek 判 unclassifiable → 不进训练 |
| selection bias 累积 | 反思 prompt 显式提示；profile 增量观察自动 append；季度 review 时由用户决定整理 |

---

## 七、测试策略

### 7.1 单元测试（`tests/learn-*.test.js`）

| 测试文件 | 覆盖 |
|---|---|
| `tests/learn-classifier.test.js` | mock DeepSeek 返回，验证 decision/contemplation/unclassifiable 三分支 |
| `tests/learn-outcome-tracker.test.js` | mock LinDangAgent，验证登记 → 判卷 → 写桶完整链路 |
| `tests/learn-reflector.test.js` | mock 三家 + Opus，验证三阶段输出 + proposals 白名单过滤 |
| `tests/learn-staging.test.js` | 验证 A/B 验证逻辑（断崖检测、+3% gate）+ 采纳/回退路径 + 桶清空 |
| `tests/learn-cron-daemon.test.js` | 验证 setInterval 跨重启幂等 |

### 7.2 E2E 测试（`tests/e2e-learn-natural.js`）

完整链路测试（用 mock 数据 + 真实 Hub 实例）：
1. 启动隔离 Hub（CLAUDE_HUB_DATA_DIR=C:\temp\hub-learn-test）
2. 创建圆桌 + 跑 fanout/debate/summary（讨论"兆易创新"）
3. 验证 outcome_pending.jsonl 写入正确
4. 注入 fake T+10 数据 → 触发 judgePending
5. 验证 nat_session_v1.jsonl 写入 + hits 正确
6. 重复 30 次（不同股票） → 验证反思自动触发
7. 验证 staging 文件生成
8. 注入 fake A/B 通过 → 验证 covenant 版本切换 + 桶归档

### 7.3 真实场景验证（验收）

- 跑通 5 次真实讨论（你白天讨论 5 只票，每次 summary 后看 outcome_pending 写入正确）
- 等到第 10 个交易日，看判卷结果合理
- 反思阈值临时调到 5（仅验收用），看反思输出 proposals 合理
- 模拟用户审批 prompt edit
- A/B 验证流程跑一次（用真实 holdout）

---

## 八、迁移与里程碑

### M1（~1.5 天）outcome 登记 + T+10 判卷
- 4.1 outcome-tracker.js（含 fallback Claude Haiku）
- 4.2 classifier.js
- 修改 roundtable-orchestrator.js 加 `onSummaryComplete` hook
- LinDangAgent 加 `fetchActualReturn(ts_code, exam_date, days)` 接口
- 单测 + 5 次真实讨论验证

### M2（~2 天）反思引擎
- 4.3 reflector.js（搬 LinDangAgent learning_reflector）
- 4.4 staging-manager.js 的 staging 写入部分（不含 A/B）
- IPC `learn:trigger-reflect` 手动触发
- 单测 + 触发一次反思（用 5 条样本）

### M3（~1.5 天）staging + A/B 验证
- staging-manager.js 的 A/B 部分
- IPC `learn:approve-staging` / `learn:reject-staging`
- 桶清空 + 版本切换
- 单测 + E2E 跑一遍完整闭环

### M4（~1 天）cron daemon + UI
- 4.5 cron-daemon.js（用 setInterval 不用 node-cron）
- 4.7 学习面板 UI
- 启动时自动启 daemon
- E2E 隔离 Hub 验证

### M5（~0.5 天）调优 + 发布
- 真实场景 5 次讨论端到端
- 修复体现的问题
- commit + 用户验收

**总计：~6.5 天**

---

## 九、风险与降级

| 风险 | 信号 | 降级 |
|---|---|---|
| DeepSeek 判类型准确率太低 | 月度统计 < 90% | 升级到 v4-pro 或换 Claude Haiku 主用 |
| 一周样本 < 5 个 | 反思阈值永远不到 | 阈值动态调整：前 3 月用 60，3 月后降 30，6 月后降 20 |
| 三家某家 hit_rate 持续 < 40% | 拖累整体 | 启用"分家定制 covenant"（脱离本 spec 范围，需新设计） |
| A/B 验证一年都过不了 | 反思能力到瓶颈 | 阈值降到 +1%（早期）；或人工 review 直接采纳 |
| covenant 改动累积越改越乱 | hit_rate 反向下降 | 紧急回滚（IPC `learn:rollback-version`）+ 暂停反思 daemon |
| 用户经常拒绝 prompt staging | 反思价值打折 | 反思 prompt 只产 covenant_edit + profile_obs，不动 prompt |

---

## 十、成功标准

**M1 通过**：5 次真实讨论后 outcome_pending.jsonl 有 5 条；T+10 后 nat_session_v1.jsonl 有 5 条；hit/miss 标注正确。

**M3 通过**：模拟反思 5 条样本，输出至少 1 条 covenant_edit proposal；A/B 验证流程跑通（无论 pass 还是 fail）。

**M5 通过 / 项目验收**：
- Hub 启动 daemon 自动运行 7 天无崩溃
- 累积 ≥ 30 条 nat_session
- 触发首次反思
- 至少 1 条 proposal 进入 staging
- 用户能通过 UI 审批 / 拒绝 staging
- 整体 spec 覆盖功能 100% 跑通

---

## 十一、不做的事（YAGNI 重申）

- ❌ 不做轨道 1（量化训练）— 等 M5 后用户决定
- ❌ 不做架构级反思（三家分工 / debate 模式）— 写到 architectural_suggestions.md
- ❌ 不做新依赖（含 node-cron）— 用 setInterval
- ❌ 不做跨设备同步 — 本机 `~/.arena-research/`
- ❌ 不做"分家定制 covenant"— 等 hit_rate 严重失衡再启动新 spec
- ❌ 不做用户每条手动审核 outcome — DeepSeek 自动判类型 + 用户后置整理 profile
- ❌ 不接交易系统 — hit/miss 是信号闭环，不下单
