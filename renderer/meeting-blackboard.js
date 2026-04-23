// renderer/meeting-blackboard.js
// Blackboard layout: structured summary comparison + sync controls.
// Consumed by meeting-room.js when layout === 'blackboard'.

(function () {
  const { ipcRenderer } = require('electron');

  let _summaryCache = {};
  let _expandedRaw = {};
  let _syncing = false;

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function renderBlackboard(meeting, container) {
    container.innerHTML = '';
    container.className = 'mr-terminals mr-blackboard';

    const subs = meeting.subSessions || [];
    if (subs.length === 0) {
      container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
      return;
    }

    for (const sid of subs) {
      if (!_summaryCache[sid]) {
        const quick = await ipcRenderer.invoke('quick-summary', sid);
        _summaryCache[sid] = { quick, deep: '' };
      }
    }

    for (const sid of subs) {
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || 'AI') : 'AI';
      const cache = _summaryCache[sid] || { quick: '', deep: '' };
      const displaySummary = cache.deep || cache.quick || '(暂无输出)';
      const isExpanded = !!_expandedRaw[sid];

      const col = document.createElement('div');
      col.className = 'mr-bb-column';
      col.dataset.sessionId = sid;

      col.innerHTML = `
        <div class="mr-bb-col-header">
          <span class="mr-bb-col-label">${escapeHtml(label)}</span>
          ${cache.deep ? '<span class="mr-bb-badge-deep">深度</span>' : ''}
        </div>
        <div class="mr-bb-summary">${escapeHtml(displaySummary)}</div>
        <button class="mr-bb-toggle-raw">${isExpanded ? '▼ 收起原文' : '▶ 展开原文'}</button>
        <div class="mr-bb-raw" style="display:${isExpanded ? 'block' : 'none'}">${escapeHtml(cache.quick || '')}</div>
      `;

      col.querySelector('.mr-bb-toggle-raw').addEventListener('click', () => {
        _expandedRaw[sid] = !_expandedRaw[sid];
        renderBlackboard(meeting, container);
      });

      container.appendChild(col);
    }
  }

  function renderBlackboardToolbar(meeting, toolbarEl) {
    if (!toolbarEl) return;

    let targetHtml = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || sid) : sid;
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
      <button class="mr-header-btn" id="mr-bb-quick-sync" ${_syncing ? 'disabled' : ''}>快速同步</button>
      <button class="mr-header-btn" id="mr-bb-deep-sync" style="background:var(--accent);color:#fff" ${_syncing ? 'disabled' : ''}>深度同步</button>
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

    document.getElementById('mr-bb-quick-sync').addEventListener('click', () => {
      handleSync(meeting, 'quick');
    });

    document.getElementById('mr-bb-deep-sync').addEventListener('click', () => {
      handleSync(meeting, 'deep');
    });
  }

  async function handleSync(meeting, mode) {
    if (_syncing) return;
    _syncing = true;

    try {
      const sceneEl = document.getElementById('mr-bb-scene-select');
      const scene = sceneEl ? sceneEl.value : 'free_discussion';
      const inputBox = document.getElementById('mr-input-box');
      const userFollowUp = inputBox ? inputBox.innerText.trim() : '';

      const targetIds = meeting.sendTarget === 'all'
        ? meeting.subSessions.filter(sid => {
            const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
            return s && s.status !== 'dormant';
          })
        : [meeting.sendTarget];

      for (const targetId of targetIds) {
        const otherIds = meeting.subSessions.filter(id => id !== targetId);
        const summaries = [];

        for (const otherId of otherIds) {
          const session = (typeof sessions !== 'undefined' && sessions) ? sessions.get(otherId) : null;
          const label = session ? (session.title || session.kind || 'AI') : 'AI';
          let summary = '';

          if (mode === 'deep') {
            summary = await ipcRenderer.invoke('deep-summary', {
              sessionId: otherId,
              scene,
              question: userFollowUp || '',
              agentName: label,
            });
            if (summary) {
              if (!_summaryCache[otherId]) _summaryCache[otherId] = { quick: '', deep: '' };
              _summaryCache[otherId].deep = summary;
            }
          }

          if (!summary) {
            summary = await ipcRenderer.invoke('quick-summary', otherId);
          }

          if (summary) {
            summaries.push({ label, summary });
          }
        }

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

      const container = document.getElementById('mr-terminals');
      if (container) await renderBlackboard(meeting, container);

      const prevLayout = meeting.subSessions.length > 1 ? 'split' : 'focus';
      meeting.layout = prevLayout;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { layout: prevLayout } });
      if (typeof MeetingRoom !== 'undefined') {
        MeetingRoom.openMeeting(meeting.id, meeting);
      }
    } catch (err) {
      console.error('[blackboard] sync error:', err);
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
  };
})();
