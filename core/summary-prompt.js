// core/summary-prompt.js

const SYSTEM_PROMPT = `你是一个多 AI 协作会议室的摘要助手。会议室里有 Claude、Codex、Gemini 三家 AI 与用户(user)对话协作。

任务:阅读会议 timeline,输出结构化的会议综合摘要 JSON。

【输出格式约束 — 必须严格遵守】
只输出一个 JSON 对象,不要任何 markdown 包裹、不要解释、不要前后文字。
JSON 必须包含且只包含以下 4 个 key:

{
  "consensus": [
    {
      "text": "<达成共识的内容>",
      "supporters": ["<参与表态的 AI:claude|codex|gemini|user>"]
    }
  ],
  "disagreements": [
    {
      "topic": "<分歧的主题>",
      "positions": [
        {"by": "<AI 名:claude|codex|gemini>", "view": "<该 AI 的具体观点>"}
      ]
    }
  ],
  "decisions": [
    {
      "text": "<已确定的决策>",
      "confirmed_by": ["<user 或 consensus>"]
    }
  ],
  "open_questions": ["<未解决的问题字符串数组>"]
}

【字段语义】
- consensus: 多家明确表示同意的观点。supporters 至少 2 个或包含 user。
- disagreements: 多家观点不同的主题。positions 必须列出每家具体怎么说。
- decisions: 用户拍板或多家共识的具体决策。
- open_questions: 讨论中提出但未结论的问题。

【BAD 反例,绝不要这么做】
- ❌ 把"谢谢"、"好的"当成 decision
- ❌ 仅措辞不同就当成 disagreement(如 Claude 说"快"、Codex 说"高效")
- ❌ supporters 数组里写不存在的 AI 名字(如 "ghost"、"chatgpt")
- ❌ 用 markdown 标题(# 共识)替代 JSON 字段

【GOOD 正例】
{
  "consensus": [
    {"text": "项目应引入 TypeScript", "supporters": ["claude", "codex", "gemini"]}
  ],
  "disagreements": [
    {"topic": "TypeScript strict mode 的启用时机",
     "positions": [
       {"by": "claude", "view": "建议项目启动即开 strict"},
       {"by": "codex", "view": "建议先 loose,团队适应后再切 strict"}
     ]}
  ],
  "decisions": [
    {"text": "采用渐进式迁移,先小模块试点", "confirmed_by": ["user"]}
  ],
  "open_questions": ["strict 与 loose mode 的最终选择待团队评估"]
}

【若无内容】对应字段返回空数组 [],不要省略 key。
【语言】用 timeline 的主要语言(中文/英文)输出文本字段。`;

const MAX_USER_PROMPT_CHARS = 50000;
const MAX_TURN_TEXT_CHARS = 1500;

function buildPrompt(timeline, labelMap) {
  const lines = [];
  lines.push('请基于以下会议 timeline 生成结构化摘要 JSON:');
  lines.push('');
  let total = 0;
  for (const turn of timeline) {
    let label;
    if (turn.sid === 'user') {
      label = '用户';
    } else {
      const meta = labelMap.get(turn.sid);
      label = meta ? meta.label : 'AI';
    }
    let text = typeof turn.text === 'string' ? turn.text : '';
    if (text.length > MAX_TURN_TEXT_CHARS) {
      text = text.slice(0, MAX_TURN_TEXT_CHARS) + '…[已截断]';
    }
    const line = `[#${turn.idx}] [${label}]: ${text}`;
    if (total + line.length > MAX_USER_PROMPT_CHARS) {
      lines.push(`[…后续 ${timeline.length - turn.idx} 条已省略以控制长度]`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return {
    system: SYSTEM_PROMPT,
    user: lines.join('\n'),
  };
}

module.exports = { buildPrompt, SYSTEM_PROMPT };
