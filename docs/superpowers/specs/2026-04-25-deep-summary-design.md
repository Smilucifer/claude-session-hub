# Deep Summary 智能摘要设计（Phase 2）

> 状态：Draft · 2026-04-25 · 接续 Phase 1 Hub Timeline

## 目标

会议室里用户点一个按钮，3 家 AI 协作的 timeline 被压缩成"共识 / 决策 / 分歧 / 未决"四张结构化卡片，让用户 0.5 秒看清每家 AI 的立场和会议结论。

## 范围

**本期做（Phase 2.1）**：
- 用户手动触发的"会议综合摘要"，结果只给人看（不喂回 AI 上下文）
- 强结构化 JSON 输出 + 卡片 UI 渲染
- Gemini CLI 默认 + DeepSeek API fallback 双轨可靠性

**本期不做（留 Phase 2.2 / 3）**：
- 长会议增量段摘要给 AI 看（F 痛点 — 等 Phase 1 cursor 不够用的真实数据再做）
- 自动触发（cat-cafe 多条件 AND — 等观察用户实际使用频率再决定阈值）
- Scene 自动识别（C 痛点 — Hub 已有手动 scene select）
- 摘要历史保存（每次点按钮都重新生成，不缓存）
- Settings UI 切换 LLM 提供方（先写死 Gemini CLI，让用户改 config 文件）
- 跨会议摘要 / 长期记忆库

## 架构

三层从上到下：

```
┌─────────────────────────────────────────────────────┐
│ UI 层  会议室右上角按钮 → Modal 弹窗 → 4 张卡片渲染   │
│        renderer/meeting-summary-modal.js            │
└────────────────────┬────────────────────────────────┘
                     │ ipcRenderer.invoke
                     ▼
┌─────────────────────────────────────────────────────┐
│ 服务层  编排 timeline 拉取 → prompt 构造 → 双轨调用   │
│         → 五层解析 → 返回 SummaryCard                │
│         core/deep-summary-service.js                │
└────────────────────┬────────────────────────────────┘
                     │
       ┌─────────────┴─────────────┐
       ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│ GeminiCliProvider│  fallback│ DeepSeekProvider│
│ (subprocess)    │ ────────▶│ (HTTP API)      │
│ 默认            │  限流/失败│ 兜底            │
└─────────────────┘         └─────────────────┘
       │                           │
       ▼                           ▼
   实际 CLI                    api.deepseek.com
```

数据源：Phase 1 的 `meetingManager.getTimeline(meetingId)`，已有，不需要新建。

## 数据 Schema

LLM 输出和 UI 消费之间的契约。

```typescript
type SummaryCard = {
  consensus: Array<{
    text: string;
    supporters: ('claude' | 'codex' | 'gemini' | 'user')[];
  }>;
  disagreements: Array<{
    topic: string;
    positions: Array<{
      by: 'claude' | 'codex' | 'gemini';
      view: string;
    }>;
  }>;
  decisions: Array<{
    text: string;
    confirmed_by: ('user' | 'consensus')[];
  }>;
  open_questions: string[];

  // 元数据
  _meta: {
    generated_at: number;       // unix ms
    timeline_length: number;    // 摘要时 timeline 多少条
    provider: 'gemini-cli' | 'deepseek-api';
    parse_status: 'ok' | 'partial' | 'failed';
    warnings?: string[];
    raw_output?: string;        // parse_status='failed' 时保留原文
  };
};
```

## 组件设计

| 文件 | 职责 | 行数估算 |
|---|---|---|
| `core/deep-summary-service.js`（新） | 编排：拉 timeline → 构 prompt → 调 provider → 解析 | ~120 |
| `core/summary-providers/gemini-cli.js`（新） | 调 Gemini CLI subprocess，处理超时、空响应、限流 | ~80 |
| `core/summary-providers/deepseek-api.js`（新） | HTTP POST api.deepseek.com，处理 retry | ~60 |
| `core/summary-parser.js`（新） | 五层防御：JSON.parse → codeBlock → regex → schema → bizValidation | ~100 |
| `renderer/meeting-summary-modal.js`（新） | Modal UI：触发按钮 + loading + 4 张卡片 + 错误降级 | ~150 |
| `renderer/meeting-room.css`（修） | 追加 modal + card 样式（基于 `_summary-format-demo.html`） | +120 |
| `main.js`（修） | 注册 IPC handler `generate-meeting-summary` | +15 |
| `renderer/meeting-room.js`（修） | 工具栏加摘要按钮，绑定 modal | +20 |
| `config/deep-summary-config.json`（新） | 默认 provider / API key 字段 / 超时阈值 | ~20 |

总：约 7 新文件 + 3 修改，~700 行代码。

## 数据流（成功路径）

```
1. 用户点工具栏"📝 生成摘要"按钮
   ↓
2. meeting-summary-modal.js 打开 modal,显示 loading skeleton
   ↓
3. ipcRenderer.invoke('generate-meeting-summary', meetingId)
   ↓
4. main.js → deep-summary-service.generate(meetingId)
   ↓
5. service:
   a. timeline = meetingManager.getTimeline(meetingId)
   b. prompt = buildPrompt(timeline)  // 本期不读 meeting.lastScene
   c. raw = await geminiCliProvider.call(prompt)  // 默认
      ├─ 失败 → raw = await deepseekProvider.call(prompt)  // fallback
      └─ 都失败 → return { _meta: { parse_status:'failed', raw_output:err.message } }
   d. parsed = summaryParser.parse(raw)
   e. return parsed
   ↓
6. renderer 收到 SummaryCard,按 parse_status 渲染:
   - 'ok'      → 4 张卡片
   - 'partial' → 4 张卡片 + 顶部黄色 warning bar
   - 'failed'  → 显示 raw_output + "重新生成"按钮
```

## Provider 双轨策略

### 决策依据
- 用户已有 DeepSeek API key,无 Anthropic / Gemini API key
- Hub 现有 `_callGeminiPipe` 模式可复用 Gemini CLI
- DeepSeek 国内直连,无代理依赖
- 双轨能把"会议室同账号 Gemini 抢配额"和"DeepSeek 偶发 503"都兜住

### 默认链路
```
Gemini CLI (本地 subprocess + OAuth) ─失败─▶ DeepSeek API (HTTP) ─失败─▶ 错误降级
```

### Gemini CLI Provider 关键参数
- 模型：默认 Gemini 2.5 Pro（CLI 默认，不传 `-m`，遵守 cli-caller skill）
- 超时：90s（Pro 长 timeline 可能慢）
- system prompt 走 `GEMINI_SYSTEM_MD` 临时文件
- user prompt 走 stdin，控制在 5KB 以内
- 输出格式 `--output-format json`，提取 `.response` 字段
- 失败判定：stdout < 200 字节且无 `.response` 字段 → 视为限流空响应

### DeepSeek API Provider 关键参数
- 模型：`deepseek-chat`（V3.2，128K context）
- 端点：`https://api.deepseek.com/chat/completions`
- API key：从 `C:\LinDangAgent\secrets.toml` 读取 `DEEPSEEK_API_KEY`（Hub 已有此模式）
- 超时：60s
- response_format：`{ "type": "json_object" }`（DeepSeek JSON mode）
- 重试：1 次（指数退避 1s）

### Provider 接口
```typescript
interface SummaryProvider {
  name: 'gemini-cli' | 'deepseek-api';
  call(prompt: { system: string; user: string }): Promise<{
    raw: string;
    elapsed_ms: number;
  }>;  // 失败抛 Error,service 层 catch 后切下一轨
}
```

## 五层防御（解析）

### Layer 1：源头约束（prompt 端）

不靠 LLM 强 schema（Gemini CLI 不支持，DeepSeek 是 JSON mode 不是 schema），靠 prompt 哄 + few-shot：

```
SYSTEM_PROMPT 结构:
1. 角色锁定: "You are a meeting summarizer for a multi-AI collaboration room. Output ONLY valid JSON."
2. 字段说明: 每个字段的含义 + 取值约束(supporters 必须 ∈ {claude,codex,gemini,user})
3. Few-shot 示例: 1 个完整 JSON 示例 (用 _summary-format-demo.html 的 TypeScript 迁移场景)
4. 反例 (cat-cafe 模式): 不要把 "谢谢" 当决策 / 不要把"措辞不同"当分歧
5. 输出约束: "Respond with ONLY the JSON object, no markdown wrapping, no explanation."
```

### Layer 2：解析容错（JSON 不规范）

```javascript
function tryParseJson(raw) {
  // 2a. 直接 parse
  try { return JSON.parse(raw); } catch {}
  // 2b. 提取 ```json ... ``` 代码块
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  // 2c. 贪婪提取最大 {...}
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  return null;
}
```

### Layer 3：Schema 校验（部分降级）

每个字段独立校验，单字段失败不影响其他：

```javascript
function applySchema(obj) {
  const warnings = [];
  const result = {
    consensus: Array.isArray(obj.consensus) ? obj.consensus : (warnings.push('consensus 缺失'), []),
    disagreements: Array.isArray(obj.disagreements) ? obj.disagreements : (warnings.push('disagreements 缺失'), []),
    decisions: Array.isArray(obj.decisions) ? obj.decisions : (warnings.push('decisions 缺失'), []),
    open_questions: Array.isArray(obj.open_questions) ? obj.open_questions : (warnings.push('open_questions 缺失'), []),
  };
  return { result, warnings };
}
```

### Layer 4：业务校验（引用一致性）

```javascript
const VALID_AIS = new Set(['claude', 'codex', 'gemini', 'user']);

function validateBusiness(result, meeting) {
  const presentAIs = new Set(meeting.subSessions.map(sid => getSession(sid)?.kind).filter(Boolean));
  presentAIs.add('user');

  result.consensus = result.consensus.filter(c => {
    if (!c.text || !Array.isArray(c.supporters)) return false;
    c.supporters = c.supporters.filter(s => VALID_AIS.has(s) && presentAIs.has(s));
    return c.supporters.length > 0;
  });
  // disagreements / decisions 同理
  return result;
}
```

### Layer 5：终极降级（UI 端）

`parse_status === 'failed'` 时 modal 显示原文 + 重新生成按钮，不报红错。

### 故障率目标

| 故障类型 | 目标率 |
|---|---|
| JSON 完全坏 | < 0.5% |
| 字段缺失 | < 1%（partial 渲染） |
| 引用不存在的 AI | 0%（被 Layer 4 过滤） |
| 整体不可用（用户看不到任何东西） | < 2% |

## UI 设计

### 入口

会议室工具栏（`#mr-toolbar`）右侧加按钮：

```
[发送到: AI ▼] [场景: 自动 ▼]              [📝 生成摘要]
```

### Modal 结构

复用 `tests/_summary-format-demo.html` 视觉（暗色 + 毛玻璃 + 4 色卡片）。

```
┌─────────────────────────────────────────────────┐
│ 📝 会议摘要                                  [×] │
│ 第 23 轮 · 2026-04-25 14:32 · gemini-cli (8s)  │
├─────────────────────────────────────────────────┤
│ ✓ 共识 (1)                                      │
│ ┌─────────────────────────────────────────────┐ │
│ │ 引入 TypeScript                              │ │
│ │ [claude] [codex] [gemini]                    │ │
│ └─────────────────────────────────────────────┘ │
│                                                  │
│ ★ 决策 (1)                                      │
│ ⚡ 分歧 (1)                                      │
│ ? 未决 (1)                                      │
├─────────────────────────────────────────────────┤
│           [复制 JSON]  [重新生成]  [关闭]        │
└─────────────────────────────────────────────────┘
```

### 状态机

```
[idle] ──点按钮──▶ [loading] ──成功──▶ [rendered]
                       │                    │
                       ├──parse=partial─────┤ (额外显示 warning bar)
                       │                    │
                       └──parse=failed────▶ [error] ──重试──▶ [loading]
                                              │
                                              └──关闭──▶ [idle]
```

### Loading skeleton

3 秒以内显示"正在请求 Gemini CLI..."；
3-30 秒显示"Gemini 思考中（已 12s）..."；
30s+ 显示"较长会议摘要可能需要 1 分钟，请耐心等待..."；
60s 触发 fallback DeepSeek，UI 提示"切换到 DeepSeek API..."；
120s 总超时，进 error 状态。

## 错误处理

| 错误类型 | 行为 |
|---|---|
| Gemini CLI 启动失败（找不到二进制） | 立即 fallback DeepSeek，UI 提示一次 |
| Gemini CLI 限流空响应 | 立即 fallback DeepSeek，UI 提示一次 |
| Gemini CLI 超时（90s） | 立即 fallback DeepSeek |
| DeepSeek API 401 | error 状态，提示"请检查 secrets.toml 中 DEEPSEEK_API_KEY" |
| DeepSeek API 429 | 退避 5s 后重试 1 次，仍失败 → error 状态 |
| DeepSeek API 503 | 退避 2s 后重试 1 次 |
| 双 provider 均失败 | error 状态 + 最后一次 raw error 显示 |
| 解析返回 null | 显示原 LLM 输出 + 重新生成按钮 |
| Timeline 为空（< 2 条消息） | 灰显按钮，hover 提示"会议尚未开始" |
| 用户在 loading 中关闭 modal | 后台请求继续完成（节省成本），结果丢弃 |

## 测试策略

### 单元测试 `tests/_unit-deep-summary.js`
- `tryParseJson`：直接 JSON / 代码块 / 贪婪正则 / 完全坏 4 种 case
- `applySchema`：4 字段全有 / 缺 1 个 / 缺 3 个 / 全缺
- `validateBusiness`：supporters 含会议室没有的 AI / 完全无效
- `buildPrompt`：timeline 长 / 短 / 含特殊字符的转义

### 集成测试 `tests/_integration-deep-summary.js`
- Provider mock：Gemini 成功 → DeepSeek 不被调
- Provider mock：Gemini 抛异常 → DeepSeek 被调
- Provider mock：两者都失败 → 返回 failed 状态
- Service：timeline 空 → 直接返回错误，不调 provider

### E2E 测试 `tests/_e2e-deep-summary-real.js`
通过 CDP 在隔离 Hub 实例上：
- A. 真实 3 家 AI 跑 5-10 轮 → 用户点摘要按钮 → modal 显示 4 张卡片（gemini-cli 路径）
- B. 配置 `fallback_chain: ["deepseek-api"]` 单轨 → 验证 DeepSeek 路径独立可用
- C. 临时把 Gemini CLI 路径改成 `gemini-not-exist` → 验证 fallback 触发，DeepSeek 接住
- D. 用 timeline = 1 条消息 → 验证按钮 disable
- E. 注入测试桩让 provider 返回乱码 → 验证 parser 五层防御 + UI error 降级
- F. 验证 `parse_status='partial'` 时仍渲染卡片 + 顶部 warning bar（mock provider 返回缺字段 JSON）

## 配置文件

`config/deep-summary-config.json`：
```json
{
  "fallback_chain": ["gemini-cli", "deepseek-api"],
  "gemini_cli": {
    "timeout_ms": 90000,
    "model_override": null
  },
  "deepseek_api": {
    "model": "deepseek-chat",
    "endpoint": "https://api.deepseek.com/chat/completions",
    "timeout_ms": 60000,
    "max_retries": 1,
    "secrets_file": "C:\\LinDangAgent\\secrets.toml",
    "secrets_key": "DEEPSEEK_API_KEY"
  },
  "ui": {
    "modal_max_width_px": 900,
    "show_raw_json_button": true
  }
}
```

约定：`fallback_chain[0]` 是默认 provider，按数组顺序失败 fallback。`model_override: null` 表示用 CLI 默认模型。

## 设计决策日志

| # | 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|---|
| 1 | 摘要给谁看 | 给人 / 给 AI / 都要 | 给人 | Phase 1 cursor 已解决 AI 上下文，先做"看见会议"是最大新价值 |
| 2 | 表达形式 | 自然语言 / 混合 / 结构化 JSON | 结构化 JSON | "看见每家 AI 立场"是 Hub 多 AI 的核心价值，B 唯一做透 |
| 3 | 触发时机 | 手动 / 自动 / 双轨 | 手动 | 阈值需要真实数据驱动，先手动跑通看用户行为 |
| 4 | LLM 选型 | Gemini Pro API / DeepSeek API / Gemini CLI / 双轨 | 双轨（Gemini CLI 主 + DeepSeek API 备） | 用户无 Gemini API key；Gemini CLI 复用现有；DeepSeek 兜底配额冲突 |
| 5 | UI 入口 | 按钮+Modal / 常驻区域 / 侧栏 | 按钮+Modal | 符合"完全手动"，不污染 Feed UI |

## 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| Gemini CLI 与会议室 Gemini 抢配额 | 中 | DeepSeek fallback；UI 提示用户切换默认 provider |
| DeepSeek API 账号余额不足 | 低 | 预估月成本 < $1，提前告知用户；error 状态显示真实 API error |
| LLM 输出"无意义"摘要（共识为空、瞎编分歧） | 中 | prompt 反例样本 + 用户反馈渠道（v0.2 加"摘要不准"按钮） |
| Modal 在长 timeline 下加载超 60s 用户失去耐心 | 中 | 进度提示文案分段；DeepSeek fallback 速度更快 |
| 用户多次点按钮浪费配额 | 低 | loading 期间按钮 disable；不缓存（接受重复成本） |
| Gemini CLI 升级改输出格式 | 中 | parser 五层防御覆盖；E2E 测试每次升级跑一遍 |

## 成功标准

- [ ] 单元测试覆盖率 ≥ 90%（parser + service）
- [ ] E2E 5 个场景全 PASS
- [ ] 用户从点按钮到看到卡片 ≤ 30s（Gemini CLI 路径，10 轮会议）
- [ ] 解析整体不可用率 < 2%（在 50 次真实摘要采样中验证）
- [ ] Fallback 链路在 Gemini 失败时 100% 触发并成功
- [ ] Modal UI 在 1366×768 / 1920×1080 / 2560×1440 三档分辨率显示正常

## 相关文件参考

- Phase 1 数据源：`C:\Users\lintian\claude-session-hub\core\meeting-room.js`（getTimeline）
- Hub 现有 Gemini CLI 集成：`C:\Users\lintian\claude-session-hub\core\summary-engine.js`（_callGeminiPipe，可参考但不复用）
- Hub 现有 DeepSeek 模式：`C:\Users\lintian\.claude\scripts\deepseek_r1.py`（参考 secrets.toml 读取方式）
- UI 视觉参考：`C:\Users\lintian\claude-session-hub\tests\_summary-format-demo.html`
- cli-caller skill 限流规则：`C:\Users\lintian\.claude\skills\cli-caller\SKILL.md`
- cat-cafe 摘要参考实现：`C:\Users\lintian\clowder-ai\packages\api\src\domains\memory\AbstractiveSummaryClient.ts`
