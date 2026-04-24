// core/summary-engine.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { stripAnsi } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

const START_MARKER = 'HSUMMARY_START';
const END_MARKER = 'HSUMMARY_END';
const MARKER_INSTRUCTION = '\n\n[回答末尾用 HSUMMARY_START 和 HSUMMARY_END 包裹100-300字核心摘要。复杂内容可写入.md文件,标记内注明路径]';

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
