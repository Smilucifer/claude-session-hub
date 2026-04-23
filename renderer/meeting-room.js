// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.

(function () {
  const { ipcRenderer } = require('electron');

  let activeMeetingId = null;
  let meetingData = {};
  let subTerminals = {};

  // renderer.js loads before us — its `sessions` and `getOrCreateTerminal`
  // are accessible via the global lexical scope. We access them directly.

  const panelEl = () => document.getElementById('meeting-room-panel');
  const headerEl = () => document.getElementById('mr-header');
  const terminalsEl = () => document.getElementById('mr-terminals');
  const toolbarEl = () => document.getElementById('mr-toolbar');
  const inputBoxEl = () => document.getElementById('mr-input-box');
  const sendBtnEl = () => document.getElementById('mr-send-btn');

  function init() {
    // no-op — kept for backward compat; refs resolved lazily
  }

  function openMeeting(meetingId, meeting) {
    activeMeetingId = meetingId;
    meetingData[meetingId] = meeting;

    const panel = panelEl();
    panel.style.display = 'flex';

    renderHeader(meeting);
    renderTerminals(meeting);
    renderToolbar(meeting);
    setupInput(meeting);
  }

  function closeMeetingPanel() {
    activeMeetingId = null;
    const panel = panelEl();
    if (panel) panel.style.display = 'none';
    const el = terminalsEl();
    if (el) el.innerHTML = '';
    subTerminals = {};
  }

  function getActiveMeetingId() {
    return activeMeetingId;
  }

  function getMeetingData(meetingId) {
    return meetingData[meetingId] || null;
  }

  let _updating = false;
  function updateMeetingData(meetingId, updated) {
    if (_updating) return;
    _updating = true;
    try {
      const prev = meetingData[meetingId];
      meetingData[meetingId] = updated;
      if (activeMeetingId === meetingId) {
        renderHeader(updated);
        renderToolbar(updated);
        const prevSubs = prev ? prev.subSessions.join(',') : '';
        const newSubs = updated.subSessions ? updated.subSessions.join(',') : '';
        if (prevSubs !== newSubs) {
          renderTerminals(updated);
        }
      }
    } catch (e) {
      console.error('[meeting-room] updateMeetingData error:', e);
    } finally {
      _updating = false;
    }
  }

  // --- Header ---

  function renderHeader(meeting) {
    const el = headerEl();
    if (!el) return;
    const layoutSplit = meeting.layout === 'split';
    const focused = meeting.focusedSub || meeting.subSessions[0];

    let tabsHtml = '';
    if (meeting.layout === 'focus' && meeting.subSessions.length > 0) {
      const tabs = meeting.subSessions.map(sid => {
        const s = sessions ? sessions.get(sid) : null;
        const label = s ? (s.title || s.kind) : 'session';
        const badges = subModelBadgeHtml(s) + subCtxBadgeHtml(s);
        const cls = sid === focused ? 'mr-tab active' : 'mr-tab';
        return `<button class="${cls}" data-sid="${sid}">${escapeHtml(label)}${badges ? ' ' + badges : ''}</button>`;
      }).join('');
      tabsHtml = `<div class="mr-tabs" id="mr-tabs">${tabs}</div>`;
    }

    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>
        ${tabsHtml}
      </div>
      <div class="mr-header-right">
        <button class="mr-header-btn ${meeting.layout === 'split' ? 'active' : ''}" id="mr-btn-split">Split</button>
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
        <button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
      </div>
    `;

    document.getElementById('mr-btn-split').addEventListener('click', () => setLayout(meeting.id, 'split'));
    document.getElementById('mr-btn-focus').addEventListener('click', () => setLayout(meeting.id, 'focus'));
    document.getElementById('mr-btn-blackboard').addEventListener('click', () => setLayout(meeting.id, 'blackboard'));
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));

    // Focus mode tab click → switch focused sub-session
    const tabsEl = document.getElementById('mr-tabs');
    if (tabsEl) {
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-tab');
        if (!btn) return;
        const sid = btn.dataset.sid;
        if (sid && sid !== focused) {
          meeting.focusedSub = sid;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
          renderTerminals(meeting);
          renderHeader(meeting);
          const cached = subTerminals[sid];
          if (cached && cached.terminal) cached.terminal.scrollToBottom();
        }
      });
    }

    const titleSpan = document.getElementById('mr-title');
    titleSpan.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = meeting.title;
      input.className = 'mr-header-title';
      input.style.cssText = 'border:1px solid var(--accent);border-radius:4px;padding:2px 6px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;font-weight:600;outline:none;';
      titleSpan.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const trimmed = input.value.trim();
        if (trimmed && trimmed !== meeting.title) {
          meeting.title = trimmed;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { title: trimmed } });
        }
        const newSpan = document.createElement('span');
        newSpan.className = 'mr-header-title';
        newSpan.id = 'mr-title';
        newSpan.textContent = meeting.title;
        input.replaceWith(newSpan);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { input.value = meeting.title; input.blur(); }
      });
    });
  }

  // --- Add Sub-Session Menu ---

  function showAddSubMenu(meetingId) {
    const meeting = meetingData[meetingId];
    if (!meeting || meeting.subSessions.length >= 3) return;

    const btn = document.getElementById('mr-btn-add-sub');
    const rect = btn.getBoundingClientRect();

    const old = document.getElementById('mr-add-sub-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'mr-add-sub-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = rect.left + 'px';

    const kinds = [
      { kind: 'claude', label: 'Claude Code' },
      { kind: 'gemini', label: 'Gemini CLI' },
      { kind: 'codex', label: 'Codex CLI' },
      { kind: 'powershell', label: 'PowerShell' },
    ];

    for (const { kind, label } of kinds) {
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = label;
      item.addEventListener('click', async () => {
        menu.remove();
        const result = await ipcRenderer.invoke('add-meeting-sub', { meetingId, kind });
        if (result && result.meeting) {
          meetingData[meetingId] = result.meeting;
          renderTerminals(result.meeting);
          renderToolbar(result.meeting);
        }
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Terminal Rendering ---

  function renderTerminals(meeting) {
    const container = terminalsEl();
    if (!container) return;

    if (meeting.layout === 'blackboard') {
      container.innerHTML = '';
      container.className = 'mr-terminals mr-blackboard';
      subTerminals = {};
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboard(meeting, container);
      }
      return;
    }

    container.innerHTML = '';
    container.className = meeting.layout === 'focus' ? 'mr-terminals focus-mode' : 'mr-terminals';

    subTerminals = {};

    if (meeting.layout === 'focus') {
      renderFocusMode(meeting, container);
      return;
    }

    for (const sessionId of meeting.subSessions) {
      const slot = createSubSlot(meeting, sessionId);
      container.appendChild(slot);
    }

    for (let i = meeting.subSessions.length; i < 3; i++) {
      const empty = document.createElement('div');
      empty.className = 'mr-empty-slot';
      empty.innerHTML = '<div class="mr-empty-slot-icon">+</div><div class="mr-empty-slot-text">点击添加子会话</div>';
      empty.addEventListener('click', () => showAddSubMenu(meeting.id));
      container.appendChild(empty);
    }

    // Open terminals AFTER slots are in the DOM — xterm needs a mounted
    // container to initialize its canvas. Then fit in the next frame.
    for (const sessionId of meeting.subSessions) {
      openSubTerminal(sessionId);
    }
    requestAnimationFrame(() => {
      for (const sessionId of meeting.subSessions) {
        fitSubTerminal(sessionId);
      }
    });
  }

  function openSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.terminal || !cached.container) return;
    if (!cached.opened) {
      cached.terminal.open(cached.container);
      cached.opened = true;
    }
  }

  function subModelBadgeHtml(session) {
    if (!session || !session.currentModel) return '';
    const cls = typeof modelClass === 'function' ? modelClass(session.currentModel.id) : '';
    const label = typeof modelShort === 'function' ? modelShort(session.currentModel) : (session.currentModel.displayName || '');
    return `<span class="model-badge ${cls}" title="${escapeHtml(session.currentModel.id)}">${escapeHtml(label)}</span>`;
  }

  function subCtxBadgeHtml(session) {
    if (!session || typeof session.contextPct !== 'number') return '';
    const cls = typeof pctClass === 'function' ? pctClass(session.contextPct) : 'ok';
    return `<span class="ctx-badge ${cls}" title="Context ${session.contextPct}%">Ctx ${session.contextPct}%</span>`;
  }

  function createSubSlot(meeting, sessionId) {
    const session = sessions ? sessions.get(sessionId) : null;
    const isDormant = session && session.status === 'dormant';
    const isSelected = meeting.sendTarget === sessionId;
    const slotTitle = session ? (session.title || session.kind || 'session') : 'session';

    const slot = document.createElement('div');
    slot.className = 'mr-sub-slot' + (isSelected ? ' selected' : '') + (isDormant ? ' dormant' : '');
    slot.dataset.sessionId = sessionId;

    const badgeHtml = subModelBadgeHtml(session) + subCtxBadgeHtml(session);
    const header = document.createElement('div');
    header.className = 'mr-sub-header';
    header.innerHTML = `
      <span class="mr-sub-label">${escapeHtml(slotTitle)}${badgeHtml ? ' ' + badgeHtml : ''}</span>
      <button class="mr-sub-close" title="关闭此会话">✕</button>
    `;

    header.addEventListener('click', (e) => {
      if (e.target.classList.contains('mr-sub-close')) return;
      const newTarget = meeting.sendTarget === sessionId ? 'all' : sessionId;
      meeting.sendTarget = newTarget;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: newTarget } });
      renderTerminals(meeting);
      renderToolbar(meeting);
    });

    header.querySelector('.mr-sub-close').addEventListener('click', async () => {
      const result = await ipcRenderer.invoke('remove-meeting-sub', { meetingId: meeting.id, sessionId });
      if (result) {
        meetingData[meeting.id] = result;
        renderTerminals(result);
        renderToolbar(result);
      }
    });

    slot.appendChild(header);

    const termContainer = document.createElement('div');
    termContainer.className = 'mr-sub-terminal';
    termContainer.addEventListener('click', () => {
      const cached = subTerminals[sessionId];
      if (cached && cached.terminal) cached.terminal.scrollToBottom();
    });
    slot.appendChild(termContainer);

    if (!isDormant && typeof getOrCreateTerminal === 'function') {
      const cached = getOrCreateTerminal(sessionId);
      if (cached && cached.container) {
        cached.container.style.display = 'block';
        termContainer.appendChild(cached.container);
        subTerminals[sessionId] = cached;
      }
    }

    slot.addEventListener('contextmenu', (e) => {
      handleQuoteContext(e, meeting, sessionId);
    });

    return slot;
  }

  function fitSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.fitAddon) return;
    try {
      cached.fitAddon.fit();
      ipcRenderer.send('terminal-resize', {
        sessionId,
        cols: cached.terminal.cols,
        rows: cached.terminal.rows,
      });
    } catch (_) {}
  }

  // --- Focus Mode ---

  function renderFocusMode(meeting, container) {
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (!focused) return;

    const mainSlot = createSubSlot(meeting, focused);
    mainSlot.style.flex = '1';
    container.appendChild(mainSlot);

    openSubTerminal(focused);
    requestAnimationFrame(() => fitSubTerminal(focused));
  }

  // --- Layout Toggle ---

  function setLayout(meetingId, layout) {
    const meeting = meetingData[meetingId];
    if (!meeting) return;
    meeting.layout = layout;
    if (layout === 'focus' && !meeting.focusedSub) {
      meeting.focusedSub = meeting.subSessions[0] || null;
    }
    ipcRenderer.send('update-meeting', { meetingId, fields: { layout, focusedSub: meeting.focusedSub } });
    renderHeader(meeting);
    renderTerminals(meeting);
  }

  // --- Toolbar ---

  function renderToolbar(meeting) {
    const el = toolbarEl();
    if (!el) return;

    if (meeting.layout === 'blackboard') {
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboardToolbar(meeting, el);
      }
      return;
    }

    let optionsHtml = '<option value="all">全部</option>';
    for (const sid of meeting.subSessions) {
      const session = sessions ? sessions.get(sid) : null;
      const label = session ? (session.title || session.kind || sid) : sid;
      const sel = meeting.sendTarget === sid ? ' selected' : '';
      optionsHtml += `<option value="${sid}"${sel}>${escapeHtml(label)}</option>`;
    }

    el.innerHTML = `
      <label>发送到: <select class="mr-target-select" id="mr-target-select">${optionsHtml}</select></label>
      <div class="mr-sync-toggle ${meeting.syncContext ? 'active' : ''}" id="mr-sync-toggle">
        <span>自动同步: ${meeting.syncContext ? '开' : '关'}</span>
      </div>
    `;

    document.getElementById('mr-target-select').addEventListener('change', (e) => {
      meeting.sendTarget = e.target.value;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: meeting.sendTarget } });
      renderTerminals(meeting);
    });

    document.getElementById('mr-sync-toggle').addEventListener('click', () => {
      meeting.syncContext = !meeting.syncContext;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { syncContext: meeting.syncContext } });
      renderToolbar(meeting);
    });
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  function setupInput(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    if (!inputBox || !sendBtn) return;

    inputBox.textContent = '';

    if (_inputBound) return;
    _inputBound = true;

    const doSend = () => {
      const box = document.getElementById('mr-input-box');
      const text = box ? box.innerText.trim() : '';
      if (!text) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      handleMeetingSend(text, m);
      if (box) box.textContent = '';
    };

    sendBtn.addEventListener('click', doSend);

    inputBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
  }

  async function handleMeetingSend(text, meeting) {
    const current = meetingData[meeting.id] || meeting;
    const targets = current.sendTarget === 'all'
      ? current.subSessions.filter(sid => {
          const s = sessions ? sessions.get(sid) : null;
          return s && s.status !== 'dormant';
        })
      : [current.sendTarget];

    for (const sessionId of targets) {
      let payload = text;
      if (meeting.syncContext) {
        const context = await buildContextSummary(meeting, sessionId);
        payload = context + payload;
      }
      ipcRenderer.send('terminal-input', { sessionId, data: payload });
      // Send Enter separately so TUI apps (Claude/Gemini) register it as submit
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
      }, 80);
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
  }

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';
      const buf = await ipcRenderer.invoke('get-ring-buffer', id);
      if (buf) {
        const truncated = buf.slice(-500).replace(/\r/g, '').trim();
        const summary = truncated.length > 200 ? truncated.slice(-200) : truncated;
        lines.push(`- ${label}: ${summary}`);
      }
    }

    if (lines.length === 0) return '';
    return `[会议室上下文] 其他参会者最近的发言：\n${lines.join('\n')}\n---\n`;
  }

  // --- Quote (Right-click) ---

  function handleQuoteContext(e, meeting, sourceSessionId) {
    const cached = subTerminals[sourceSessionId];
    if (!cached || !cached.terminal) return;

    const selection = cached.terminal.getSelection();
    if (!selection) return;

    e.preventDefault();

    const old = document.getElementById('mr-quote-context-menu');
    if (old) old.remove();

    const others = meeting.subSessions.filter(id => id !== sourceSessionId);
    if (others.length === 0) return;

    const sourceSession = sessions ? sessions.get(sourceSessionId) : null;
    const sourceLabel = sourceSession ? sourceSession.kind : 'session';

    const menu = document.createElement('div');
    menu.id = 'mr-quote-context-menu';
    menu.className = 'mr-quote-menu';
    menu.style.top = e.clientY + 'px';
    menu.style.left = e.clientX + 'px';

    for (const targetId of others) {
      const targetSession = sessions ? sessions.get(targetId) : null;
      const targetLabel = targetSession ? targetSession.kind : 'session';
      const item = document.createElement('button');
      item.className = 'mr-quote-menu-item';
      item.textContent = `引用到 ${targetLabel}`;
      item.addEventListener('click', () => {
        menu.remove();
        const inputBox = document.getElementById('mr-input-box');
        if (inputBox) {
          inputBox.textContent = `> [来自 ${sourceLabel}] ${selection}\n`;
          const range = document.createRange();
          range.selectNodeContents(inputBox);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        meeting.sendTarget = targetId;
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: targetId } });
        renderToolbar(meeting);
        renderTerminals(meeting);
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
  }

  // --- Helpers ---

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Live badge refresh on status-event ---
  ipcRenderer.on('status-event', (_e, payload) => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(payload.sessionId)) return;
    const session = sessions ? sessions.get(payload.sessionId) : null;
    if (!session) return;
    const title = session.title || session.kind || 'session';
    const badges = subModelBadgeHtml(session) + subCtxBadgeHtml(session);
    const newHtml = `${escapeHtml(title)}${badges ? ' ' + badges : ''}`;
    // Update split-mode sub-slot header
    const slot = document.querySelector(`.mr-sub-slot[data-session-id="${payload.sessionId}"]`);
    if (slot) {
      const label = slot.querySelector('.mr-sub-label');
      if (label) label.innerHTML = newHtml;
    }
    // Update focus-mode tab
    const tab = document.querySelector(`.mr-tab[data-sid="${payload.sessionId}"]`);
    if (tab) tab.innerHTML = newHtml;
  });

  // --- Expose global ---

  window.MeetingRoom = {
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    updateMeetingData,
  };
})();
