// renderer/meeting-summary-modal.js
// Modal for displaying generated meeting summary cards.

(function () {
  const { ipcRenderer } = require('electron');

  let _modalEl = null;
  let _state = 'idle';  // idle | loading | rendered | error
  let _lastResult = null;
  let _lastMeetingId = null;
  let _loadingTimer = null;
  let _loadingStartedAt = 0;

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ensureModal() {
    if (_modalEl) return _modalEl;
    _modalEl = document.createElement('div');
    _modalEl.id = 'mr-summary-modal';
    _modalEl.className = 'mr-summary-modal-hidden';
    _modalEl.innerHTML = `
      <div class="mr-summary-backdrop"></div>
      <div class="mr-summary-dialog" role="dialog" aria-label="会议摘要">
        <div class="mr-summary-header">
          <span class="mr-summary-title">📝 会议摘要</span>
          <span class="mr-summary-meta"></span>
          <button class="mr-summary-close" aria-label="关闭">×</button>
        </div>
        <div class="mr-summary-body"></div>
        <div class="mr-summary-footer">
          <button class="mr-summary-copy" hidden>复制 JSON</button>
          <button class="mr-summary-retry" hidden>重新生成</button>
          <button class="mr-summary-close-btn">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(_modalEl);
    _modalEl.querySelector('.mr-summary-close').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-close-btn').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-backdrop').addEventListener('click', close);
    _modalEl.querySelector('.mr-summary-retry').addEventListener('click', () => {
      if (_lastMeetingId) open(_lastMeetingId);
    });
    _modalEl.querySelector('.mr-summary-copy').addEventListener('click', () => {
      if (_lastResult && _lastResult.data) {
        const json = JSON.stringify(_lastResult.data, null, 2);
        navigator.clipboard.writeText(json).catch(() => {});
      }
    });
    return _modalEl;
  }

  function setState(state) {
    _state = state;
    const modal = ensureModal();
    modal.dataset.state = state;
    const retryBtn = modal.querySelector('.mr-summary-retry');
    const copyBtn = modal.querySelector('.mr-summary-copy');
    retryBtn.hidden = !(state === 'rendered' || state === 'error');
    copyBtn.hidden = !(state === 'rendered' && _lastResult && _lastResult.data);
  }

  function show() {
    ensureModal().classList.remove('mr-summary-modal-hidden');
  }
  function close() {
    ensureModal().classList.add('mr-summary-modal-hidden');
    if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
    setState('idle');
  }

  function renderLoading() {
    const body = ensureModal().querySelector('.mr-summary-body');
    _loadingStartedAt = Date.now();
    const update = () => {
      const elapsed = Math.round((Date.now() - _loadingStartedAt) / 1000);
      let msg;
      if (elapsed < 3) msg = '正在请求 Gemini CLI...';
      else if (elapsed < 30) msg = `Gemini 思考中(已 ${elapsed}s)...`;
      else if (elapsed < 60) msg = `较长会议摘要可能需要 1 分钟,请耐心等待(${elapsed}s)...`;
      else msg = `仍在等待响应(${elapsed}s),即将切换备用通道...`;
      body.innerHTML = `
        <div class="mr-summary-loading">
          <div class="mr-summary-spinner"></div>
          <div class="mr-summary-loading-text">${escapeHtml(msg)}</div>
        </div>
      `;
    };
    update();
    if (_loadingTimer) clearInterval(_loadingTimer);
    _loadingTimer = setInterval(update, 1000);
  }

  function renderError(result) {
    const body = ensureModal().querySelector('.mr-summary-body');
    const meta = result && result._meta ? result._meta : {};
    body.innerHTML = `
      <div class="mr-summary-error">
        <div class="mr-summary-error-title">⚠️ 摘要生成失败</div>
        <div class="mr-summary-error-msg">${escapeHtml(meta.last_error || '未知错误')}</div>
        ${meta.raw_output ? `
          <details>
            <summary>查看 LLM 原始输出</summary>
            <pre>${escapeHtml(meta.raw_output)}</pre>
          </details>` : ''}
      </div>
    `;
  }

  function renderCards(result) {
    // 详细在 Task 11 实现; 这里先占位让单元能运行
    const body = ensureModal().querySelector('.mr-summary-body');
    body.innerHTML = '<div>[cards placeholder — Task 11]</div>';
  }

  function renderMeta(result) {
    const meta = ensureModal().querySelector('.mr-summary-meta');
    const m = result && result._meta;
    if (!m) { meta.textContent = ''; return; }
    const ts = m.generated_at ? new Date(m.generated_at).toLocaleTimeString() : '';
    const len = m.timeline_length != null ? `第 ${m.timeline_length} 条` : '';
    const prov = m.provider ? m.provider : '';
    const elapsed = m.elapsed_ms ? `${(m.elapsed_ms / 1000).toFixed(1)}s` : '';
    meta.textContent = [len, ts, prov, elapsed].filter(Boolean).join(' · ');
  }

  async function open(meetingId) {
    _lastMeetingId = meetingId;
    show();
    setState('loading');
    renderLoading();
    try {
      const result = await ipcRenderer.invoke('generate-meeting-summary', meetingId);
      if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
      _lastResult = result;
      renderMeta(result);
      if (result.status === 'failed') {
        setState('error');
        renderError(result);
      } else {
        setState('rendered');
        renderCards(result);
      }
    } catch (e) {
      if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
      _lastResult = { status: 'failed', _meta: { last_error: e.message } };
      setState('error');
      renderError(_lastResult);
    }
  }

  window.MeetingSummaryModal = { open, close };
})();
