'use strict';
// Research Roundtable mode — 三家平等的投研圆桌
// 与 driver-mode 平行的会议室模式：Claude / Gemini / Codex 地位平等，
// 共享同一份 system prompt（rules + 用户公约），本色发挥。
//
// 与 driver-mode 的差异：
//   - driver-mode：Claude 主驾 + Gemini/Codex 副驾（角色分化）
//   - research-mode：三家平等（不分角色），统一注入 rules + covenant
//
// Sprint 1 范围：仅 prompt 文件管理。MCP 工具集 / 轮次状态机在 Sprint 2-3。

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Template: Research Roundtable rules（系统级，所有会议室固定）
// ---------------------------------------------------------------------------
const RESEARCH_RULES_TEMPLATE = `# 投研圆桌规则（Research Roundtable）

## 你的角色
你和另外两位 AI 同事（共三家：Claude / Gemini / Codex）受邀加入用户的投研圆桌。
**地位完全平等，本色发挥，不需要扮演角色。** 你怎么思考就怎么回答，不要套模板。

## 圆桌的运作方式
用户用三种语法驱动圆桌：

1. **默认提问**：用户发普通文本 → 三家独立回答（互不知情）。这一轮你不会看到另两家在写什么。
2. **@debate 触发**：用户发 \`@debate\` 或 \`@debate 补充信息\` → 系统会把另两家上一轮的完整观点发给你 → 请你结合他们的视角发表新观点（可继承可反驳，可纳入用户补充的新信息）。
3. **@summary @<你> 触发**：用户发 \`@summary @claude\`（或 @gemini / @codex）→ 系统会把所有历史轮次的三家观点汇总给被点名那位 → 由他给出综合意见。

⚠ 你看不到另两家观点时，不要假装你看得到。专注本色独立回答。

## 数据获取（重要 · 主动查，不要等用户）

你**必须**主动获取数据，不要等用户贴数据给你。**优先级**严格如下：

### 优先级 1：LinDangAgent（用户的成熟数据层，最权威）
**位置**：\`C:\\LinDangAgent\`（用户长期维护的 A 股投研项目，五层数据兜底已封装）

怎么用（Bash / 沙箱跑代码即可，已自动批准）：
1. 先探查可用入口（最多 2 次 Bash）：
   - \`cd C:\\LinDangAgent && ls services/\` 看有没有现成 CLI
   - \`ls data/\` 看数据获取模块
2. 调用方式（任选）：
   - 找到 \`services/fetch_for_arena.py\` 等 CLI → \`python -m services.fetch_for_arena stock --symbol 603986\`
   - 直接调模块：\`python -c "from data.report_data import build_report_context; import json; print(json.dumps(build_report_context('603986'), default=str))"\`
   - 用 LinDangAgent 内置 tushare_client / fallback 拉单字段

可能的关键模块（自己看实际代码确认）：
- \`data/report_data.py::build_report_context\` — 33 字段全量
- \`data/tushare_client.py\` / \`data/fallback.py\` — 五层兜底
- \`Stock_top10/top10/hot_rank.py\` — 热门股 5 路候选
- \`Stock_top10/top10/signal.py\` — 量化信号 / 形态识别

### 优先级 2：MCP 工具（如可用）
- \`fetch_lindang_stock\` / \`fetch_concept_stocks\` / \`fetch_sector_overview\`（Sprint 3 后启用）
- \`ai-team.*\` 等全局 MCP 工具（系统已自动批准）

### 优先级 3：自身联网（LinDangAgent + MCP 不够时 fallback）
- WebFetch / WebSearch（Claude）/ Google Search grounding（Gemini）/ web_search（Codex）
- 适合：实时新闻 / 政策动态 / 行业景气 / 突发公告（这些 LinDangAgent 不一定有）

### 沙箱跑代码（任何家都可以）
量化指标 / 形态识别 / 数据校验：可写脚本调 akshare / tushare / 公开 API 兜底。

### 铁律
- **用户问 "怎么看 XX" 时，先按上述优先级查数据再给观点**。不要先要数据后给框架。
- **LinDangAgent 探查上限 2 次 Bash**：找不到合适入口就直接 fallback 联网，不要无限探。
- 数据**真**找不到时再明示"我尝试 LinDangAgent / 联网都失败了，需要你提供..."，但**不要默认伸手**。

⚠ **纯读不写**：不要修改 LinDangAgent 代码 / 不要 git commit / 不要删除文件 / 不要 npm install。本圆桌仅做投研讨论。如果讨论中发现需要改代码或部署，请明示并等用户确认。

## 协作礼仪
- @debate 时引用对方观点请明示（"Gemini 提到的关税利空..."），便于用户追溯
- 不要因为另两家观点强势就放弃自己的判断；该坚持就坚持，该改就改要说明为什么
- summary 阶段被点到时，写成可读决策报告（结论先行 + 关键分歧 + 行动建议），不要只复读三家观点
`;

// ---------------------------------------------------------------------------
// Template: User covenant（用户级，可在创建会议室时编辑）
// 这是默认模板。用户在 UI 里改了之后，改后内容写入文件，rules 不变 covenant 可变。
// ---------------------------------------------------------------------------
const COVENANT_TEMPLATE = `# 立花道雪投研圆桌 · 房间公约 v1

## 我们能讨论什么
任何 A 股投研话题：
- 个股决策："今天能不能买入兆易创新？"
- 概念→选股："最近 DDR5 概念很火，找最正宗的标的"
- 板块研判："半导体板块后续怎么走？"
- 复盘："今天高位股集体回调，怎么看？"
- 宏观："美联储议息对成长股影响？"
- 持仓建议："我现在的持仓结构有什么问题？"

⚠ **问什么样的问题，给什么样的回答**。不要把所有问题都套同一套模板。

## 我的投资风格（参考，不强制套用）
- 基本面强 + 题材正宗（不蹭概念）+ 短期启动趋势已立（放量突破、均线多头）
- 风险偏好：中性偏稳，单股仓位通常 1-3 万

## 我重点关注（看具体问题类型自己取舍）
基本面、预期差、资金面、技术面 — 大致权重 15% / 35% / 30% / 20%
- 单股决策：偏向资金面 / 技术面 / 预期差
- 板块研判：偏向行业景气 / 资金流向 / 政策催化
- 概念选股：强调"正宗度"（核心受益度，不是蹭概念）

## 红线（任何讨论都要避开）
- 非行业龙头硬蹭概念（除非有独家技术 / 议价能力证据）
- 技术明显走坏（破关键支撑、量价背离）
- 监管 / 财务造假风险

## 输出习惯（建议，不强制）
- 关键结论先行（推荐 / 不推荐 / 中性 / 观望）
- 必要时附推理路径，不需要套八股
- 量化指标尽量给具体数字，定性判断尽量给参照系
- 不必非要给"决策" — 有时把问题想清楚就够了

## 留白
你是我的投研伙伴，不是工具。
该坚持时坚持，该改主意时改主意。
信息不足时主动说"我需要 X 数据"，不要硬猜。
`;

// ---------------------------------------------------------------------------
// Resume reminder（投研圆桌的 Claude resume 时再注入）
// ---------------------------------------------------------------------------
const RESEARCH_RESUME_REMINDER = `[系统提醒] 你正在投研圆桌（Research Roundtable）中恢复会话。请继续遵守以下规则：
- 你和另外两位 AI（Gemini/Codex）地位平等，本色发挥
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合给最终意见）
- 数据获取：优先用 MCP 工具 fetch_lindang_stock / fetch_concept_stocks / fetch_sector_overview
- 实时信息可用自己的联网能力；量化可用沙箱跑代码（不要乱改本地代码）
`;

// ---------------------------------------------------------------------------
// Prompt file management
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 合成 system prompt 文件：rules（系统约束）+ covenant（用户偏好）
// 三家共享同一文件，平等注入。
function writeResearchPromptFile(hubDataDir, meetingId, customCovenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-research.md`);
  const covenant = (typeof customCovenantText === 'string' && customCovenantText.trim().length > 0)
    ? customCovenantText
    : COVENANT_TEMPLATE;
  const content = `${RESEARCH_RULES_TEMPLATE}\n\n---\n\n${covenant}`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// 仅持久化用户改过的 covenant，方便 resume 时重建
function writeCovenantSnapshot(hubDataDir, meetingId, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-covenant.md`);
  fs.writeFileSync(filePath, covenantText || COVENANT_TEMPLATE, 'utf-8');
  return filePath;
}

function readCovenantSnapshot(hubDataDir, meetingId) {
  const filePath = path.join(arenaPromptsDir(hubDataDir), `${meetingId}-covenant.md`);
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

// 写 MCP config 文件（仿 driver-mode.writeDriverMcpConfig），用于 Claude --mcp-config 注入
function writeResearchMcpConfig(hubDataDir, meetingId, hookPort, hookToken, aiKind) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-research-mcp.json`);
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  const config = {
    mcpServers: {
      'arena-research': {
        command: process.execPath,
        args: [mcpServerPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ARENA_MEETING_ID: meetingId,
          ARENA_HUB_PORT: String(hookPort),
          ARENA_HOOK_TOKEN: hookToken,
          ARENA_AI_KIND: aiKind || 'unknown',
        },
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return filePath;
}

// 给 Codex 启动命令的 MCP entry（session-manager.js 用 -c 拼接到 codex spawn）
function buildResearchMcpEntryForCodex(meetingId, hookPort, hookToken) {
  const mcpServerPath = path.resolve(__dirname, 'research-mcp-server.js');
  return {
    name: 'arena_research', // codex toml 中 key 不能含 -
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ARENA_MEETING_ID: meetingId,
      ARENA_HUB_PORT: String(hookPort),
      ARENA_HOOK_TOKEN: hookToken,
      ARENA_AI_KIND: 'codex',
    },
  };
}

function cleanupResearchFiles(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  // 删除所有 <meetingId>-* 前缀文件（research.md / covenant.md / roundtable.json / turn-N.json 等）
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${meetingId}-`)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

module.exports = {
  RESEARCH_RULES_TEMPLATE,
  COVENANT_TEMPLATE,
  RESEARCH_RESUME_REMINDER,
  writeResearchPromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  writeResearchMcpConfig,
  buildResearchMcpEntryForCodex,
  cleanupResearchFiles,
};
