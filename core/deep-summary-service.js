// core/deep-summary-service.js
const { buildPrompt } = require('./summary-prompt.js');
const { parse } = require('./summary-parser.js');

const MIN_TIMELINE_LENGTH = 2;

class DeepSummaryService {
  constructor({ providers }) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('DeepSummaryService requires at least one provider');
    }
    this.providers = providers;
  }

  /**
   * @param timeline Array<{idx,sid,text,ts}>
   * @param presentAIs Set<string>  会议室中实际存在的 AI kind('claude'|'codex'|'gemini'|'user')
   * @param labelMap Map<sid, {label, kind}>  for prompt rendering
   */
  async generate(timeline, presentAIs, labelMap = new Map()) {
    const generated_at = Date.now();
    if (!Array.isArray(timeline) || timeline.length < MIN_TIMELINE_LENGTH) {
      return {
        status: 'failed',
        _meta: {
          generated_at,
          timeline_length: timeline ? timeline.length : 0,
          provider: null,
          parse_status: 'failed',
          last_error: `timeline empty or too short (need >= ${MIN_TIMELINE_LENGTH})`,
        },
      };
    }

    const prompt = buildPrompt(timeline, labelMap);
    let lastError = null;
    let lastRaw = null;
    let usedProvider = null;
    let elapsed_ms = 0;

    for (const provider of this.providers) {
      try {
        const r = await provider.call(prompt);
        lastRaw = r.raw;
        usedProvider = provider.name;
        elapsed_ms = r.elapsed_ms;
        const parsed = parse(r.raw, presentAIs);
        if (parsed.status === 'failed') {
          lastError = `parse failed for ${provider.name}: ${(parsed.warnings || []).join(';')}`;
          continue;  // 尝试下一个 provider
        }
        return {
          status: parsed.status,
          data: parsed.data,
          warnings: parsed.warnings,
          _meta: {
            generated_at,
            timeline_length: timeline.length,
            provider: provider.name,
            elapsed_ms,
            parse_status: parsed.status,
          },
        };
      } catch (e) {
        lastError = `${provider.name}: ${e.message}`;
        continue;
      }
    }

    return {
      status: 'failed',
      _meta: {
        generated_at,
        timeline_length: timeline.length,
        provider: usedProvider,
        parse_status: 'failed',
        last_error: lastError || 'all providers failed',
        raw_output: lastRaw,
      },
    };
  }
}

module.exports = { DeepSummaryService };
