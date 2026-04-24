// core/summary-engine.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { stripAnsi } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

const START_MARKER = 'SM-START';
const END_MARKER = 'SM-END';
const MARKER_INSTRUCTION = '\n\n[用SM-START和SM-END包裹回答内容]';

class SummaryEngine {
  constructor(config = {}) {
    this._templatesPath = config.templatesPath || DEFAULT_TEMPLATES_PATH;
    this._templates = null;
    this._markerCache = new Map();
  }

  _loadTemplates() {
    if (this._templates) return this._templates;
    try {
      const raw = fs.readFileSync(this._templatesPath, 'utf-8');
      this._templates = JSON.parse(raw);
    } catch (e) {
      console.error('[summary-engine] Failed to load templates:', e.message);
      return { scenes: {}, deep: { system: '', promptTemplate: '{{content}}' } };
    }
    return this._templates;
  }

  reloadTemplates() {
    this._templates = null;
    return this._loadTemplates();
  }

  getScenes() {
    const t = this._loadTemplates();
    const result = [];
    for (const [key, val] of Object.entries(t.scenes || {})) {
      result.push({ key, label: val.label || key });
    }
    return result;
  }

  getMarkerInstruction() {
    return MARKER_INSTRUCTION;
  }

  extractMarker(rawBuffer, sessionId) {
    if (!rawBuffer) return this._markerCache.get(sessionId) || '';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = cleaned.lastIndexOf(START_MARKER);
    if (startIdx < 0) {
      return this._markerCache.get(sessionId) || '';
    }
    const contentStart = startIdx + START_MARKER.length;
    const endIdx = cleaned.indexOf(END_MARKER, contentStart);
    if (endIdx < 0) {
      return cleaned.slice(contentStart).trim();
    }
    const content = cleaned.slice(contentStart, endIdx).trim();
    if (sessionId && content) this._markerCache.set(sessionId, content);
    return content;
  }

  markerStatus(rawBuffer, sessionId) {
    if (!rawBuffer) return this._markerCache.has(sessionId) ? 'done' : 'none';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = cleaned.lastIndexOf(START_MARKER);
    if (startIdx >= 0) {
      const endIdx = cleaned.indexOf(END_MARKER, startIdx + START_MARKER.length);
      if (endIdx >= 0) return 'done';
      return 'streaming';
    }
    if (this._markerCache.has(sessionId)) return 'done';
    if (cleaned.includes(END_MARKER)) return 'done';
    return 'none';
  }

  quickSummary(rawBuffer, sessionId) {
    return this.extractMarker(rawBuffer, sessionId);
  }

  async compressContext(content, maxChars = 1000) {
    if (!content || content.length <= maxChars) return content;
    const system = '你是一个协作上下文压缩助手。将内容压缩到指定字符数以内，保留关键结论、数据点和具体建议，压缩论证过程和重复内容。';
    const prompt = `将以下 AI 回答压缩到 ${maxChars} 字符以内。\n要求：保留关键结论、数据点和具体建议，压缩论证过程和重复内容。\n\n原文：\n${content}`;
    try {
      const compressed = await this._callGeminiPipe(system, prompt);
      return compressed || content.slice(0, maxChars);
    } catch (err) {
      console.error('[summary-engine] compressContext failed:', err.message);
      return content.slice(0, maxChars);
    }
  }

  async detectDivergence(agentOutputs) {
    if (!agentOutputs || Object.keys(agentOutputs).length < 2) {
      return { consensus: [], divergence: [] };
    }
    const system = '你是一个多AI协作分析助手。分析多个AI的回答，识别共识和分歧。只输出JSON，不要其他内容。';
    let prompt = '分析以下多个 AI 对同一问题的回答，识别共识和分歧。\n\n';
    for (const [name, content] of Object.entries(agentOutputs)) {
      prompt += `【${name}】\n${content}\n\n`;
    }
    prompt += '请以 JSON 格式输出：\n{\n  "consensus": ["共识点1", "共识点2"],\n  "divergence": [\n    {\n      "topic": "分歧主题",\n      "positions": {"Agent1": "观点", "Agent2": "观点"},\n      "suggestedQuestion": "建议追问的问题"\n    }\n  ]\n}';

    try {
      const raw = await this._callGeminiPipe(system, prompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { consensus: [], divergence: [] };
    } catch (err) {
      console.error('[summary-engine] detectDivergence failed:', err.message);
      return { consensus: [], divergence: [] };
    }
  }

  async deepSummary(rawBuffer, options = {}) {
    const { agentName = 'AI', question = '', scene = 'free_discussion' } = options;

    const content = this.extractMarker(rawBuffer);
    if (!content) {
      console.warn('[summary-engine] deepSummary: no marker content for', agentName);
      return '';
    }

    const t = this._loadTemplates();
    const sceneConfig = (t.scenes || {})[scene] || (t.scenes || {}).free_discussion || {};
    const instruction = sceneConfig.instruction || '';
    const system = (t.deep || {}).system || '';
    const template = (t.deep || {}).promptTemplate || '{{content}}';

    const prompt = template
      .replace('{{agent_name}}', agentName)
      .replace('{{question}}', question)
      .replace('{{content}}', content)
      .replace('{{instruction}}', instruction);

    try {
      const summary = await this._callGeminiPipe(system, prompt);
      return summary;
    } catch (err) {
      console.error('[summary-engine] Gemini pipe failed:', err.message);
      return '';
    }
  }

  buildInjection(otherSummaries, userFollowUp) {
    if (!otherSummaries || otherSummaries.length === 0) return userFollowUp || '';
    let payload = '[会议室协作同步]\n';
    for (const s of otherSummaries) {
      payload += `【${s.label}】${s.summary}\n`;
    }
    payload += '---\n';
    if (userFollowUp) payload += userFollowUp;
    return payload;
  }

  _callGeminiPipe(system, prompt) {
    return new Promise((resolve, reject) => {
      const args = ['-p'];
      if (system) {
        args.push('--system-prompt', system);
      }

      const child = execFile('gemini', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gemini -p failed: ${err.message} stderr: ${stderr}`));
          return;
        }
        resolve(stdout.trim());
      });

      child.stdin.on('error', (e) => {
        if (e.code !== 'EPIPE') reject(e);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { SummaryEngine, START_MARKER, END_MARKER, MARKER_INSTRUCTION };
