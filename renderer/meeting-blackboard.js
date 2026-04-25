// renderer/meeting-blackboard.js
// Blackboard layout: structured summary comparison + sync controls.
// Consumed by meeting-room.js when layout === 'blackboard'.

(function () {
  const { ipcRenderer } = require('electron');

  let _summaryCache = {};
  let _expandedRaw = {};
  let _bbFocusedTab = null;
  let _syncing = false;

  let _currentMeetingId = null;
  let _feedListenerAttached = false;
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getSessionLabel(sid) {
    if (sid === 'user') return '你';
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
    if (!s) return '已离开';
    return s.title || s.kind || 'AI';
  }

  function getSessionKind(sid) {
    if (sid === 'user') return 'user';
    const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
    return s ? s.kind : 'unknown';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function renderTurnCard(turn) {
    const kind = getSessionKind(turn.sid);
    const label = getSessionLabel(turn.sid);
    const text = typeof turn.text === 'string' ? turn.text : '';
    const longThreshold = 500;
    const isLong = text.length > longThreshold;
    const preview = isLong ? text.slice(0, longThreshold) : text;
    const previewHtml = escapeHtml(preview);
    const fullHtml = escapeHtml(text);
    const foldId = `mr-feed-fold-${turn.idx}`;

    return `<div class="mr-feed-turn mr-feed-kind-${escapeHtml(kind)}" data-idx="${escapeHtml(String(turn.idx))}">
    <div class="mr-feed-meta">
      <span class="mr-feed-badge mr-feed-badge-${escapeHtml(kind)}">${escapeHtml(label)}</span>
      <span class="mr-feed-time">${escapeHtml(formatTime(turn.ts))}</span>
      <span class="mr-feed-idx">#${escapeHtml(String(turn.idx))}</span>
    </div>
    <div class="mr-feed-body">${
      isLong
        ? `<span id="${foldId}-preview">${previewHtml}<span class="mr-feed-ellipsis">…</span></span>
           <span id="${foldId}-full" style="display:none">${fullHtml}</span>
           <button class="mr-feed-toggle" data-fold-id="${foldId}">展开</button>`
        : fullHtml
    }</div>
  </div>`;
  }

  function attachFoldHandler(container) {
    container.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.mr-feed-toggle');
      if (!btn) return;
      const foldId = btn.getAttribute('data-fold-id');
      const preview = document.getElementById(foldId + '-preview');
      const full = document.getElementById(foldId + '-full');
      if (!preview || !full) return;
      if (full.style.display === 'none') {
        preview.style.display = 'none';
        full.style.display = 'inline';
        btn.textContent = '收起';
      } else {
        preview.style.display = 'inline';
        full.style.display = 'none';
        btn.textContent = '展开';
      }
    });
  }

  // Authoritative-first resolver: try transcript tap (Claude Stop hook / Codex
  // rollout task_complete / Gemini JSONL gemini-message), fall back to the
  // legacy marker-based extractor. Returns { text, source } where source is
  // 'transcript' | 'marker' | 'none'. Empty text is treated as miss.
  async function resolveSummary(sessionId) {
    let transcriptText = null;
    try { transcriptText = await ipcRenderer.invoke('get-last-assistant-text', sessionId); } catch {}
    if (transcriptText && transcriptText.trim()) {
      return { text: transcriptText.trim(), source: 'transcript' };
    }
    let markerText = '';
    try { markerText = await ipcRenderer.invoke('quick-summary', sessionId); } catch {}
    if (markerText && markerText.trim()) {
      return { text: markerText.trim(), source: 'marker' };
    }
    return { text: '', source: 'none' };
  }

  function getSession(sid) {
    return (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
  }

  function getLabel(sid) {
    const s = getSession(sid);
    return s ? (s.title || s.kind || 'AI') : 'AI';
  }

  async function renderBlackboard(meeting, container) {
    container.innerHTML = '';
    container.className = 'mr-terminals mr-blackboard mr-feed';
    _currentMeetingId = meeting.id;

    if (!meeting.subSessions || meeting.subSessions.length === 0) {
      container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
      return;
    }

    const feedEl = document.createElement('div');
    feedEl.className = 'mr-feed-list';
    container.appendChild(feedEl);

    const timeline = await ipcRenderer.invoke('meeting-get-timeline', meeting.id);
    const reversed = timeline.slice().reverse();
    feedEl.innerHTML = reversed.map(renderTurnCard).join('');
    attachFoldHandler(feedEl);

    if (!_feedListenerAttached) {
      _feedListenerAttached = true;
      ipcRenderer.on('meeting-timeline-updated', (_event, { meetingId, turn }) => {
        if (meetingId !== _currentMeetingId) return;
        const list = document.querySelector('.mr-feed-list');
        if (!list) return;
        const card = document.createElement('div');
        card.innerHTML = renderTurnCard(turn);
        const node = card.firstElementChild;
        list.insertBefore(node, list.firstChild);
      });
    }
  }

  function renderBlackboardToolbar(meeting, toolbarEl) {
    if (!toolbarEl) return;

    let targetHtml = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const label = getLabel(sid);
      const sel = meeting.sendTarget === sid ? ' selected' : '';
      targetHtml += `<option value="${sid}"${sel}>${escapeHtml(label)}</option>`;
    }

    const lastScene = meeting.lastScene || 'free_discussion';
    const sceneSelectId = 'mr-bb-scene-select';

    toolbarEl.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-bb-target">${targetHtml}</select></label>
      <label>场景: <select class="mr-target-select" id="${sceneSelectId}">
        <option value="free_discussion">自动</option>
      </select></label>
      <button class="mr-summary-btn" id="mr-bb-summary-btn" title="生成会议摘要">📝 摘要</button>
    `;

    ipcRenderer.invoke('get-summary-scenes').then(scenes => {
      const select = document.getElementById(sceneSelectId);
      if (!select) return;
      select.innerHTML = '';
      for (const s of scenes) {
        const opt = document.createElement('option');
        opt.value = s.key;
        opt.textContent = s.label;
        if (s.key === lastScene) opt.selected = true;
        select.appendChild(opt);
      }
    });

    document.getElementById('mr-bb-target').addEventListener('change', (e) => {
      meeting.sendTarget = e.target.value;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: meeting.sendTarget } });
    });

    const sceneEl = document.getElementById(sceneSelectId);
    if (sceneEl) {
      sceneEl.addEventListener('change', (e) => {
        meeting.lastScene = e.target.value;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastScene: meeting.lastScene } });
      });
    }

    const summaryBtn = document.getElementById('mr-bb-summary-btn');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', () => {
        if (window.MeetingSummaryModal && typeof window.MeetingSummaryModal.open === 'function') {
          window.MeetingSummaryModal.open(meeting.id);
        } else {
          console.error('[blackboard] MeetingSummaryModal not loaded');
        }
      });
      // 当 timeline < 2 条时禁用
      const enable = async () => {
        try {
          const tl = await ipcRenderer.invoke('meeting-get-timeline', meeting.id);
          summaryBtn.disabled = !Array.isArray(tl) || tl.length < 2;
          summaryBtn.title = summaryBtn.disabled
            ? '会议尚未开始(需要至少 2 条对话)'
            : '生成会议摘要';
        } catch {}
      };
      enable();
    }

  }

  async function handleSync(meeting, mode) {
    if (_syncing) return;
    _syncing = true;
    const toolbarEl = document.getElementById('mr-toolbar');
    if (toolbarEl) renderBlackboardToolbar(meeting, toolbarEl);

    try {
      const sceneEl = document.getElementById('mr-bb-scene-select');
      const scene = sceneEl ? sceneEl.value : 'free_discussion';
      const inputBox = document.getElementById('mr-input-box');
      const userFollowUp = inputBox ? inputBox.innerText.trim() : '';

      const targetIds = meeting.sendTarget === 'all'
        ? meeting.subSessions.filter(sid => {
            const s = getSession(sid);
            return s && s.status !== 'dormant';
          })
        : [meeting.sendTarget];

      for (const targetId of targetIds) {
        const otherIds = meeting.subSessions.filter(id => id !== targetId);

        const summaryResults = await Promise.all(otherIds.map(async (otherId) => {
          const label = getLabel(otherId);
          let summary = '';

          if (mode === 'deep') {
            try {
              summary = await ipcRenderer.invoke('deep-summary', {
                sessionId: otherId, scene,
                question: userFollowUp || '',
                agentName: label,
              });
            } catch (e) {
              console.warn('[blackboard] deep-summary failed for', otherId, e.message);
            }
            if (summary) {
              if (!_summaryCache[otherId]) _summaryCache[otherId] = { quick: '', deep: '' };
              _summaryCache[otherId].deep = summary;
            }
          }

          if (!summary) {
            const res = await resolveSummary(otherId);
            summary = res.text || '';
          }

          return summary ? { label, summary } : null;
        }));

        const summaries = summaryResults.filter(Boolean);

        if (summaries.length > 0) {
          const payload = await ipcRenderer.invoke('build-injection', { summaries, userFollowUp });
          if (payload) {
            ipcRenderer.send('terminal-input', { sessionId: targetId, data: payload });
            setTimeout(() => {
              ipcRenderer.send('terminal-input', { sessionId: targetId, data: '\r' });
            }, 80);
          }
        }
      }

      if (inputBox && userFollowUp) inputBox.textContent = '';

      const container = document.querySelector('.mr-blackboard');
      if (container) renderBlackboard(meeting, container);
    } catch (err) {
      console.error('[blackboard] sync error:', err);
    } finally {
      _syncing = false;
    }
  }

  async function handleSyncFromFocus(meeting) {
    if (_syncing) return;
    _syncing = true;
    try {
      const inputBox = document.getElementById('mr-input-box');
      const userFollowUp = inputBox ? inputBox.innerText.trim() : '';
      const targetIds = meeting.sendTarget === 'all'
        ? meeting.subSessions.filter(sid => { const s = getSession(sid); return s && s.status !== 'dormant'; })
        : [meeting.sendTarget];

      for (const targetId of targetIds) {
        const otherIds = meeting.subSessions.filter(id => id !== targetId);
        const summaryResults = await Promise.all(otherIds.map(async (otherId) => {
          const label = getLabel(otherId);
          const res = await resolveSummary(otherId);
          return res.text ? { label, summary: res.text } : null;
        }));
        const summaries = summaryResults.filter(Boolean);
        if (summaries.length > 0) {
          const payload = await ipcRenderer.invoke('build-injection', { summaries, userFollowUp });
          if (payload) {
            ipcRenderer.send('terminal-input', { sessionId: targetId, data: payload });
            setTimeout(() => ipcRenderer.send('terminal-input', { sessionId: targetId, data: '\r' }), 80);
          }
        }
      }
      if (inputBox && userFollowUp) inputBox.textContent = '';
    } catch (err) {
      console.error('[blackboard] sync from focus error:', err);
    } finally {
      _syncing = false;
    }
  }

  function clearCache() {
    _summaryCache = {};
    _expandedRaw = {};
  }

  window.MeetingBlackboard = {
    renderBlackboard,
    renderBlackboardToolbar,
    clearCache,
    handleSyncFromFocus,
  };
})();
