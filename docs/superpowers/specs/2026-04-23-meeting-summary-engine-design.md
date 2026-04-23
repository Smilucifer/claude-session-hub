# Meeting Room Summary Engine Design

> Date: 2026-04-23
> Status: Approved
> Scope: Claude Session Hub — Meeting Room collaboration

## Problem

When multiple AIs (2-3) answer the same question in a meeting room, their outputs are isolated. The current `buildContextSummary()` extracts the last 200 characters of raw terminal output — too short, full of ANSI noise, no structure, no scene awareness. Users cannot efficiently compare answers or trigger cross-AI collaboration.

## Solution

A two-tier Summary Engine with a Blackboard layout mode, enabling structured comparison and selective collaboration injection.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Summary tiers | L0 (programmatic) + L2 (LLM) | L1 (regex templates) is over-engineering — fragile regex across 3 AI output styles, marginal benefit when Gemini Flash is near-free |
| Trigger mode | Semi-auto (UI buttons) | Full-auto wastes tokens on simple Q&A; full-manual is tedious |
| Blackboard UI | Third layout mode (Split/Focus/Blackboard) | Reuses existing layout switching mechanism in meeting-room.js |
| Summary display | Structured summary + expandable raw output | Quick comparison without losing detail |
| LLM model | Gemini Flash (default, configurable) | Lowest cost, fastest, sufficient quality for summarization |
| Injection format | Prepend + named source | Context-first prompt engineering; named enables targeted responses |
| Scene selection | Manual UI dropdown (default: "auto") | Auto-detection itself needs LLM; manual is simpler and reliable |
| Templates | 5 built-in + config file override | Covers main scenarios; power users can customize without UI changes |
| AI count | 2-3 agents supported | Blackboard renders 2 or 3 columns dynamically |

## Architecture

### New Files

- `core/summary-engine.js` — SummaryEngine class (L0 quick / L2 deep)
- `renderer/meeting-blackboard.js` — Blackboard layout UI
- `config/summary-templates.json` — Scene-specific prompt templates

### Modified Files

- `renderer/meeting-room.js` — Add `layout === 'blackboard'` branch + button events
- `renderer/meeting-room.css` — Blackboard styles
- `core/session-manager.js` — Increase RING_BUFFER_BYTES from 8192 to 16384

### Data Flow

```
User broadcasts question in meeting room
  ↓
2-3 AIs answer independently (existing logic, unchanged)
  ↓
User switches to Blackboard layout
  ↓
Blackboard panel renders:
  - Each AI's last response (extracted from ring buffer)
  - Structured summary (collapsed) + raw output (expandable)
  ↓
User selects target (dropdown) + scene (dropdown) + clicks sync button
  ↓
SummaryEngine generates summary:
  L0 (Quick Sync): ANSI clean → denoise → extract last response → truncate 2K chars
  L2 (Deep Sync):  ANSI clean → denoise → full content → Gemini Flash → structured summary
  ↓
Hub injects summary into target AI's terminal input:
  [会议室协作同步]
  【Claude Opus】<summary>
  【Gemini】<summary>
  ---
  <optional user follow-up from input box>
```

## SummaryEngine API

```javascript
class SummaryEngine {
  constructor(config)

  // L0: Zero LLM cost, ~0ms
  async quickSummary(rawBuffer: string): string
    // 1. stripAnsi() — remove escape sequences
    // 2. removePromptNoise() — remove CLI prompts, spinners, progress bars
    // 3. extractLastResponse() — detect last AI response boundary
    // 4. smartTruncate(2000) — truncate to 2K chars at sentence boundary

  // L2: Gemini Flash, ~1-2s, ~$0.001
  async deepSummary(rawBuffer: string, options: {
    agentName: string,
    question: string,
    scene: string        // 'free_discussion' | 'code_review' | 'stock_analysis' | 'debug' | 'knowledge_qa'
  }): string
    // 1. stripAnsi() + removePromptNoise() (same as L0, but NO truncation)
    // 2. Load scene-specific prompt template
    // 3. Call Gemini Flash with template + cleaned content
    // 4. Return structured summary

  // Assemble injection payload
  buildInjection(otherSummaries: Array<{label: string, summary: string}>,
                 userFollowUp?: string): string
    // Format: prepend + named sources
}
```

## Prompt Templates

Stored in `config/summary-templates.json`. Users can override by placing a custom file at the same path.

```json
{
  "summaryModel": "gemini",
  "deep": {
    "system": "You are a collaboration summary assistant. Extract key information from an AI's response and output a concise structured summary. Always respond in the same language as the input content.",
    "promptTemplate": "以下是 {{agent_name}} 对问题「{{question}}」的回答：\n\n{{content}}\n\n{{instruction}}"
  },
  "scenes": {
    "free_discussion": {
      "label": "自由讨论",
      "instruction": "请提取关键信息，包括但不限于：\n- 核心观点\n- 支撑论据\n- 如果有权衡取舍，指出放弃了什么\n- 如果有未决问题，列出\n跳过不适用的项。200字以内。"
    },
    "code_review": {
      "label": "代码审查",
      "instruction": "从代码审查中提取：\n- 发现的问题列表（含文件名/行号/严重级别）\n- 修复建议\n- 代码优点（如果提到了）\n按严重级别排序，200字以内。"
    },
    "stock_analysis": {
      "label": "投研分析",
      "instruction": "从投研分析中提取：\n- 结论/评级/评分\n- 核心投资逻辑\n- 主要风险点\n- 催化剂/时间节点\n200字以内。"
    },
    "debug": {
      "label": "Debug",
      "instruction": "从调试分析中提取：\n- 根因定位（哪个模块/函数/行）\n- 修复方案\n- 验证步骤\n- 是否有副作用或关联问题\n200字以内。"
    },
    "knowledge_qa": {
      "label": "知识问答",
      "instruction": "用一两句话概括回答的核心要点。50字以内。"
    }
  }
}
```

## Blackboard Layout UI

### Header Buttons

```
[Split] [Focus] [Blackboard]
```

Third button added to existing meeting room header. Clicking sets `meeting.layout = 'blackboard'` and re-renders.

### Blackboard Panel Structure

```
┌──────────────────────────────────────────┐
│  Agent 1 (name)     │  Agent 2 (name)    │   ← 2-3 columns, dynamic
│  ┌── Summary ─────┐ │ ┌── Summary ─────┐ │
│  │ structured text │ │ │ structured text │ │
│  │                 │ │ │                 │ │
│  │ ▶ Show raw      │ │ │ ▶ Show raw      │ │
│  └─────────────────┘ │ └─────────────────┘ │
├──────────────────────────────────────────┤
│  Send to: [All ▼]     Scene: [Auto ▼]    │
│  [Quick Sync]  [Deep Sync]               │
│  [Input box ............................] │
└──────────────────────────────────────────┘
```

- **Summary area**: Displays L0 quick summary by default (auto-generated when switching to Blackboard layout). User can upgrade to L2 by clicking Deep Sync.
- **Expandable raw output**: Click "Show raw" to see full cleaned terminal output in a scrollable container.
- **Column count**: 2 columns for 2 sub-sessions, 3 columns for 3 sub-sessions. CSS grid: `grid-template-columns: repeat(N, 1fr)`.
- **Scene dropdown**: Options are loaded from `summary-templates.json` scenes. Default "Auto" uses `free_discussion`.

### Sync Button Behavior

1. User selects "Send to" target (specific AI or All)
2. User optionally selects scene
3. User clicks Quick Sync or Deep Sync
4. For each target AI:
   - SummaryEngine generates summaries of ALL OTHER AIs' responses
   - `buildInjection()` assembles the payload
   - Payload is injected into target AI's terminal via existing `terminal-input` IPC
   - If user typed in the input box, append that text after the `---` separator
5. Switch layout back to Split/Focus so user can see the AI processing the injection

### Step 5 Rationale

After sync, the user wants to see the target AI's live reaction. Auto-switching to Split or Focus (whichever was last used) provides immediate feedback.

## IPC Additions

| Channel | Direction | Type | Purpose |
|---------|-----------|------|---------|
| `quick-summary` | renderer → main | invoke | L0 summary: takes sessionId, returns cleaned text |
| `deep-summary` | renderer → main | invoke | L2 summary: takes sessionId + scene + question, calls Gemini Flash, returns structured summary |

## Configuration

### Default Config (config/summary-templates.json)

See Prompt Templates section above. Users override by editing this file directly.

### Settings in meeting data model

```javascript
// Additional fields in meeting object (core/meeting-room.js)
{
  // ... existing fields ...
  lastScene: 'free_discussion',  // Remember user's last scene selection
}
```

## Ring Buffer Change

`core/session-manager.js` line 5:

```javascript
// Before
const RING_BUFFER_BYTES = 8192;

// After
const RING_BUFFER_BYTES = 16384;
```

This doubles the available context for summary extraction. No other changes to the ring buffer mechanism.

## Injection Format

```
[会议室协作同步]
【Claude Opus】核心观点是X，理由是Y，但对Z存疑...
【Gemini】倾向方案B，认为A的性能风险较大...
---
<user follow-up text, if any>
```

- `[会议室协作同步]` prefix signals to the receiving AI that this is collaboration context
- `【name】` brackets clearly separate each source
- `---` separator distinguishes context from user's own question
- Each AI only receives summaries of OTHER AIs (never its own)

## Out of Scope

- Auto-detection of scene type (requires LLM, adds cost for marginal benefit)
- Automatic Phase 3 debate (user controls when to sync)
- Meeting room templates/presets
- Cross-meeting-room collaboration
- Conversation history export from blackboard
