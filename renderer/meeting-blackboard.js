// renderer/meeting-blackboard.js
// Blackboard layout: structured summary comparison + sync controls.
// Consumed by meeting-room.js when layout === 'blackboard'.

(function () {
  const { ipcRenderer } = require('electron');

  let _summaryCache = {};
  let _expandedRaw = {};
  let _bbFocusedTab = null;
  let _syncing = false;

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    container.className = 'mr-terminals mr-blackboard';
    const subs = meeting.subSessions || [];
    if (subs.length === 0) {
      container.innerHTML = '<div class="mr-bb-empty">暂无子会话，请先添加 AI</div>';
      return;
    }

    const focused = _bbFocusedTab && subs.includes(_bbFocusedTab) ? _bbFocusedTab : subs[0];
    _bbFocusedTab = focused;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'mr-bb-tabs';
    for (const sid of subs) {
      const label = getLabel(sid);
      const btn = document.createElement('button');
      btn.className = 'mr-bb-tab' + (sid === focused ? ' active' : '');
      btn.dataset.sid = sid;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        _bbFocusedTab = sid;
        renderBlackboard(meeting, container);
      });
      tabBar.appendChild(btn);
    }
    container.appendChild(tabBar);

    // Content area
    const contentEl = document.createElement('div');
    contentEl.className = 'mr-bb-content';
    container.appendChild(contentEl);

    // Fetch summary + marker status for focused tab
    let summary = '';
    let markerStatus = 'none';
    try {
      [summary, markerStatus] = await Promise.all([
        ipcRenderer.invoke('quick-summary', focused),
        ipcRenderer.invoke('marker-status', focused),
      ]);
    } catch {}
    _summaryCache[focused] = { quick: summary || '', deep: (_summaryCache[focused] || {}).deep || '' };
    const displayText = _summaryCache[focused].deep || _summaryCache[focused].quick || '';

    // Info header with model badge + ctx + marker status + time
    const session = getSession(focused);
    const infoHtml = [];
    if (session && session.currentModel) {
      const cls = typeof modelClass === 'function' ? modelClass(session.currentModel.id) : '';
      const lbl = typeof modelShort === 'function' ? modelShort(session.currentModel) : (session.currentModel.displayName || '');
      infoHtml.push('<span class="model-badge ' + cls + '">' + escapeHtml(lbl) + '</span>');
    }
    if (session && typeof session.contextPct === 'number') {
      const cls = typeof pctClass === 'function' ? pctClass(session.contextPct) : 'ok';
      infoHtml.push('<span class="ctx-badge ' + cls + '">Ctx ' + session.contextPct + '%</span>');
    }
    if (markerStatus === 'done') infoHtml.push('<span class="mr-marker-status done">✓ 摘要就绪</span>');
    else if (markerStatus === 'streaming') infoHtml.push('<span class="mr-marker-status streaming">⏳ 输出中</span>');
    infoHtml.push('<span class="mr-bb-time">最后更新 ' + new Date().toLocaleTimeString() + '</span>');

    // Content: marker-based display
    if (displayText) {
      const { marked } = require('marked');
      const renderedHtml = marked.parse(displayText);
      contentEl.innerHTML =
        '<div class="mr-bb-info">' + infoHtml.join(' ') + '</div>' +
        '<div class="mr-bb-markdown">' + renderedHtml + '</div>';
    } else if (markerStatus === 'streaming') {
      contentEl.innerHTML =
        '<div class="mr-bb-info">' + infoHtml.join(' ') + '</div>' +
        '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">正在输出中…</div>';
    } else {
      contentEl.innerHTML =
        '<div class="mr-bb-info">' + infoHtml.join(' ') + '</div>' +
        '<div class="mr-bb-summary" style="color:var(--text-secondary);font-style:italic">未检测到摘要标记。请确认 AI 已完成回答。</div>';
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
            summary = await ipcRenderer.invoke('quick-summary', otherId);
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
          const summary = await ipcRenderer.invoke('quick-summary', otherId);
          return summary ? { label, summary } : null;
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
