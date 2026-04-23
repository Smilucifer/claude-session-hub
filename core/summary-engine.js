// core/summary-engine.js
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { stripAnsi } = require('./ansi-utils');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'summary-templates.json');

const START_MARKER = '<<<MEETING_SUMMARY>>>';
const END_MARKER = '<<<END_SUMMARY>>>';
const MARKER_INSTRUCTION = '\n\n（请在回答的最末尾，用 <<<MEETING_SUMMARY>>> 和 <<<END_SUMMARY>>> 标记包裹核心摘要（100-300字），保留关键结论与依据。若内容复杂难以精简，可将完整分析写入 .md 文件，标记内只需注明文件路径。不要解释这些标记。）';

class SummaryEngine {
  constructor(config = {}) {
    this._templatesPath = config.templatesPath || DEFAULT_TEMPLATES_PATH;
    this._templates = null;
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

  extractMarker(rawBuffer) {
    if (!rawBuffer) return '';
    const cleaned = stripAnsi(rawBuffer);
    const startIdx = cleaned.lastIndexOf(START_MARKER);
    if (startIdx < 0) return '';
    const contentStart = startIdx + START_MARKER.length;
    const endIdx = cleaned.indexOf(END_MARKER, contentStart);
    if (endIdx < 0) {
      return cleaned.slice(contentStart).trim();
    }
    return cleaned.slice(contentStart, endIdx).trim();
  }

  markerStatus(rawBuffer) {
    if (!rawBuffer) return 'none';
    const cleaned = stripAnsi(rawBuffer);
    const hasStart = cleaned.lastIndexOf(START_MARKER) >= 0;
    const hasEnd = cleaned.lastIndexOf(END_MARKER) >= 0;
    if (hasStart && hasEnd) return 'done';
    if (hasStart) return 'streaming';
    return 'none';
  }

  quickSummary(rawBuffer) {
    return this.extractMarker(rawBuffer);
  }

  async deepSummary(rawBuffer, options = {}) {
    const { agentName = 'AI', question = '', scene = 'free_discussion' } = options;

    const content = this.extractMarker(rawBuffer);
    if (!content) return '';

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
