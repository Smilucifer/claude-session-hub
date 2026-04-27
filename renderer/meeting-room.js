// renderer/meeting-room.js
// Meeting Room UI — manages the parallel terminal panel.
// Exposes global `MeetingRoom` object consumed by renderer.js.

(function () {
  const { ipcRenderer } = require('electron');

  let activeMeetingId = null;
  let meetingData = {};
  let subTerminals = {};
  let _markerStatusCache = {};
  let _markerPollTimer = null;
  const _tabState = {};     // { sessionId: 'streaming'|'new-output'|'idle'|'error' }
  const _tabTimers = {};    // { sessionId: silenceTimerId }
  let _divergenceEnabled = false;
  let _divergenceResult = null;
  let _divergenceHash = '';
  let _driverSummaryEnabled = false; // Claude 摘要开关

  // renderer.js loads before us — its `sessions` and `getOrCreateTerminal`
  // are accessible via the global lexical scope. We access them directly.

  // --- Driver Mode: @command parser ---
  function parseDriverCommand(text, meeting) {
    if (!meeting || !meeting.driverMode) return { type: 'normal', text, targets: null };
    const trimmed = text.trim();
    if (/^@review\b/i.test(trimmed) || /^@审查\b/.test(trimmed)) {
      return { type: 'review', text: trimmed.replace(/^@(?:review|审查)\s*/i, '').trim() };
    }
    if (/^@gemini\b/i.test(trimmed)) {
      return { type: 'direct', targetKind: 'gemini', text: trimmed.replace(/^@gemini\s*/i, '').trim() };
    }
    if (/^@codex\b/i.test(trimmed)) {
      return { type: 'direct', targetKind: 'codex', text: trimmed.replace(/^@codex\s*/i, '').trim() };
    }
    if (/^@claude\b/i.test(trimmed)) {
      return { type: 'direct', targetKind: 'claude', text: trimmed.replace(/^@claude\s*/i, '').trim() };
    }
    return { type: 'driver-only', text };
  }

  function findSessionByKind(meeting, kind) {
    if (!meeting || !meeting.subSessions) return null;
    for (const sid of meeting.subSessions) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      if (s && s.kind === kind && s.status !== 'dormant') return sid;
    }
    return null;
  }

  function getCopilotSids(meeting) {
    if (!meeting || !meeting.subSessions) return [];
    return meeting.subSessions.filter(sid => {
      if (sid === meeting.driverSessionId) return false;
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      return s && s.status !== 'dormant';
    });
  }

  // --- Driver Mode: trigger review ---
  async function triggerReview(meeting, userText, triggerType) {
    const copilotSids = getCopilotSids(meeting);
    if (copilotSids.length === 0) {
      console.warn('[driver] no copilot sessions available for review');
      return;
    }

    // Write .arena/context.md snapshot
    try {
      await ipcRenderer.invoke('driver-write-context', { meetingId: meeting.id, arenaDir: '.arena' });
    } catch {}

    // Optionally ask Claude to summarize first
    let claudeSummary = '';
    if (_driverSummaryEnabled) {
      try {
        const instruction = await ipcRenderer.invoke('driver-summarize-instruction');
        if (instruction && meeting.driverSessionId) {
          ipcRenderer.send('terminal-input', { sessionId: meeting.driverSessionId, data: instruction });
          await new Promise(r => setTimeout(r, 120));
          ipcRenderer.send('terminal-input', { sessionId: meeting.driverSessionId, data: '\r' });
          // Wait for Claude to respond (poll transcript tap)
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const text = await ipcRenderer.invoke('get-last-assistant-text', meeting.driverSessionId);
            if (text && text.includes('当前目标') || text && text.includes('已完成')) {
              claudeSummary = text;
              break;
            }
          }
          if (!claudeSummary) {
            claudeSummary = await ipcRenderer.invoke('get-last-assistant-text', meeting.driverSessionId) || '';
          }
        }
      } catch (e) {
        console.warn('[driver] Claude summary failed:', e.message);
      }
    }

    // Get Claude's last output
    let claudeLastOutput = '';
    try {
      claudeLastOutput = await ipcRenderer.invoke('get-last-assistant-text', meeting.driverSessionId) || '';
    } catch {}

    // Get recent timeline
    let recentTimeline = '';
    try {
      recentTimeline = await ipcRenderer.invoke('driver-recent-timeline', { meetingId: meeting.id, count: 10 });
    } catch {}

    // Build per-copilot role-specific review prompts
    const promptMap = {};
    for (const sid of copilotSids) {
      const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(sid) : null;
      const kind = s ? s.kind : 'unknown';
      promptMap[sid] = buildReviewPayloadRenderer({
        kind,
        triggerType,
        triggerText: userText,
        claudeSummary,
        claudeLastOutput,
        recentTimeline,
        userText,
      });
    }

    // Show "审查中..." indicator
    renderReviewResult(meeting, [{ sid: 'pending', verdict: 'PENDING', reason: '审查中...' }]);

    // Send per-copilot prompts and wait
    try {
      const results = await ipcRenderer.invoke('driver-request-review', {
        meetingId: meeting.id,
        promptMap,
        timeoutMs: 120000,
      });

      // Enhance results with session labels
      const enhanced = results.map(r => {
        const s = (typeof sessions !== 'undefined' && sessions) ? sessions.get(r.sid) : null;
        return { ...r, label: s ? (s.title || s.kind || 'AI') : 'AI' };
      });

      renderReviewResult(meeting, enhanced);

      // Process results: FLAG → send reminder to Claude
      for (const r of enhanced) {
        if (r.verdict === 'FLAG' && meeting.driverSessionId) {
          const reminder = `[副驾提醒 from ${r.label}] ${r.reason}`;
          ipcRenderer.send('terminal-input', { sessionId: meeting.driverSessionId, data: reminder + '\r' });
        }
      }
    } catch (e) {
      console.error('[driver] review failed:', e.message);
      renderReviewResult(meeting, [{ sid: 'error', verdict: 'FLAG', reason: '审查流程异常: ' + e.message, label: 'System' }]);
    }
  }

  function buildReviewPayloadRenderer({ kind, triggerType, claudeSummary, claudeLastOutput, recentTimeline, userText }) {
    const roleLabel = kind === 'gemini'
      ? '你是架构审查副驾（Gemini）。请从方案/架构/需求理解角度审查。'
      : '你是代码实现审查副驾（Codex）。请从代码正确性/边界条件/测试遗漏角度审查。';

    const sections = ['=== 审查请求 ===', `角色: ${roleLabel}`, `触发: ${triggerType}`, ''];
    if (claudeSummary) { sections.push('--- Claude 任务摘要 ---', claudeSummary.slice(0, 5000), ''); }
    if (recentTimeline) { sections.push('--- 近期对话 ---', recentTimeline.slice(0, 8000), ''); }
    if (claudeLastOutput) { sections.push('--- Claude 最近操作 ---', claudeLastOutput.slice(0, 10000), ''); }
    if (userText) { sections.push('--- 用户补充 ---', userText, ''); }
    sections.push('如需更多上下文，可读取 .arena/context.md 或项目源码文件。');
    sections.push('', '请用以下格式回复（第一行必须是判定）:', 'OK|FLAG|BLOCKER: 一句话理由');
    let payload = sections.join('\n');
    if (payload.length > 20000) payload = payload.slice(0, 20000) + '\n[…已截断]';
    return payload;
  }

  // --- Driver Mode: render review result banner ---
  function renderReviewResult(meeting, results) {
    let bar = document.getElementById('mr-review-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mr-review-bar';
      const container = terminalsEl();
      if (container && container.parentElement) {
        container.parentElement.insertBefore(bar, container);
      }
    }

    const isPending = results.length === 1 && results[0].verdict === 'PENDING';
    if (isPending) {
      bar.innerHTML = '<div class="mr-review-header">审查中...</div>';
      bar.className = 'mr-review-bar';
      return;
    }

    let html = '<div class="mr-review-header">审查结果</div>';
    for (const r of results) {
      const cls = r.verdict === 'OK' ? 'mr-review-ok'
        : r.verdict === 'BLOCKER' ? 'mr-review-blocker'
        : 'mr-review-flag';
      const label = r.label || r.sid || 'AI';
      html += `<div class="mr-review-item ${cls}">
        <span class="mr-review-agent">${escapeHtml(label)}</span>
        <span class="mr-review-verdict">${escapeHtml(r.verdict)}</span>
        <span class="mr-review-reason">${escapeHtml(r.reason || '')}</span>
      </div>`;
    }

    const hasBlocker = results.some(r => r.verdict === 'BLOCKER');
    if (hasBlocker) {
      html += `<div class="mr-review-actions">
        <button class="mr-review-btn mr-review-override" onclick="document.getElementById('mr-review-bar').remove()">覆盖继续</button>
        <button class="mr-review-btn mr-review-abort" onclick="document.getElementById('mr-review-bar').remove()">中止</button>
      </div>`;
    }

    bar.innerHTML = html;
    bar.className = 'mr-review-bar';

    if (!hasBlocker) {
      setTimeout(() => { if (bar.parentElement) bar.remove(); }, 5000);
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Driver Mode: listen for auto-review events from Claude ---
  ipcRenderer.on('driver-auto-review', (_event, { meetingId, triggerType, claudeText }) => {
    const meeting = meetingData[meetingId];
    if (!meeting || !meeting.driverMode) return;
    triggerReview(meeting, claudeText || '', triggerType);
  });

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
    startMarkerPoll();
  }

  function closeMeetingPanel() {
    activeMeetingId = null;
    _inputBound = false;
    stopMarkerPoll();
    _markerStatusCache = {};
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
          setupInput(updated);
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
    const focused = meeting.focusedSub || meeting.subSessions[0];

    let tabsHtml = '';
    if (meeting.layout === 'focus' && meeting.subSessions.length > 0) {
      const tabs = meeting.subSessions.map(sid => {
        const s = sessions ? sessions.get(sid) : null;
        const label = s ? (s.title || s.kind) : 'session';
        const badges = subModelBadgeHtml(s) + subCtxBadgeHtml(s);
        const cls = sid === focused ? 'mr-tab active' : 'mr-tab';
        const state = _tabState[sid] || 'idle';
        const markerBadge = markerStatusHtml(sid);
        const statusDot = `<span class="mr-tab-status ${state}"></span>`;
        const newBadge = state === 'new-output' ? ' <span class="new-badge">NEW</span>' : '';
        const hasNewCls = state === 'new-output' ? ' has-new' : '';
        const driverIcon = meeting.driverMode ? (sid === meeting.driverSessionId ? ' <span class="mr-role-icon" title="主驾">&#128663;</span>' : ' <span class="mr-role-icon" title="副驾">&#128065;</span>') : '';
        return `<button class="${cls}${hasNewCls}" data-sid="${sid}">${statusDot}${escapeHtml(label)}${driverIcon}${badges ? ' ' + badges : ''} ${markerBadge}${newBadge}</button>`;
      }).join('');
      tabsHtml = `<div class="mr-tabs" id="mr-tabs">${tabs}</div>`;
    }

    el.innerHTML = `
      <div class="mr-header-left">
        <span class="mr-header-title" id="mr-title">${escapeHtml(meeting.title)}</span>${meeting.driverMode ? '<span class="mr-driver-badge">Driver</span>' : ''}
        ${tabsHtml}
      </div>
      <div class="mr-header-right">
        <button class="mr-header-btn ${meeting.layout === 'focus' ? 'active' : ''}" id="mr-btn-focus">Focus</button>
        <button class="mr-header-btn ${meeting.layout === 'blackboard' ? 'active' : ''}" id="mr-btn-blackboard">Blackboard</button>
        <button class="mr-header-btn" id="mr-btn-add-sub" title="添加子会话">+ 添加</button>
        <button class="btn-zoom btn-memo-toggle ${typeof localStorage !== 'undefined' && localStorage.getItem('claude-hub-memo-open') === 'true' ? 'active' : ''}" id="mr-btn-memo" title="Toggle memo panel"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9zM4 5h8M4 8h8M4 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg></button>
        <button class="btn-zoom" id="mr-btn-zoom-out" title="Shrink UI">A−</button>
        <button class="btn-zoom" id="mr-btn-zoom-in" title="Enlarge UI">A+</button>
        <button class="btn-close-session" id="mr-btn-close" title="关闭会议室" aria-label="Close meeting"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button>
      </div>
    `;

    document.getElementById('mr-btn-focus').addEventListener('click', () => setLayout(meeting.id, 'focus'));
    document.getElementById('mr-btn-blackboard').addEventListener('click', () => setLayout(meeting.id, 'blackboard'));
    document.getElementById('mr-btn-add-sub').addEventListener('click', () => showAddSubMenu(meeting.id));
    document.getElementById('mr-btn-memo').addEventListener('click', () => { if (typeof toggleMemoPanel === 'function') toggleMemoPanel(); });
    document.getElementById('mr-btn-zoom-out').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom - 1); });
    document.getElementById('mr-btn-zoom-in').addEventListener('click', () => { if (typeof applyZoom === 'function') applyZoom(currentZoom + 1); });
    document.getElementById('mr-btn-close').addEventListener('click', async () => {
      await ipcRenderer.invoke('close-meeting', meeting.id);
      closeMeetingPanel();
    });

    // Focus mode tab click → switch focused sub-session
    const tabsEl = document.getElementById('mr-tabs');
    if (tabsEl) {
      tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.mr-tab');
        if (!btn) return;
        const sid = btn.dataset.sid;
        if (sid && sid !== focused) {
          _tabState[sid] = 'idle';
          if (_tabTimers[sid]) { clearTimeout(_tabTimers[sid]); delete _tabTimers[sid]; }
          meeting.focusedSub = sid;
          ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { focusedSub: sid } });
          switchFocusTab(meeting, sid);
          renderHeader(meeting);
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
      { kind: 'deepseek', label: 'DeepSeek' },
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
          setupInput(result.meeting);
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
    for (const cached of Object.values(subTerminals)) {
      if (cached && cached.container && cached.container.parentElement) {
        cached.container.parentElement.removeChild(cached.container);
      }
    }
    container.innerHTML = '';
    if (meeting.layout === 'blackboard') {
      container.className = 'mr-terminals mr-blackboard';
      subTerminals = {};
      if (typeof MeetingBlackboard !== 'undefined') {
        MeetingBlackboard.renderBlackboard(meeting, container);
      }
      return;
    }
    container.className = 'mr-terminals focus-mode';
    subTerminals = {};
    renderFocusMode(meeting, container);
  }

  function openSubTerminal(sessionId) {
    const cached = subTerminals[sessionId];
    if (!cached || !cached.terminal || !cached.container) return;
    if (!cached.container.querySelector('.xterm-screen')) {
      cached.terminal.open(cached.container);
      cached.opened = true;
      if (typeof loadGpuRenderer === 'function') loadGpuRenderer(cached);
    }
    cached.terminal.refresh(0, cached.terminal.rows - 1);
    cached.terminal.scrollToBottom();
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

  function markerStatusHtml(sessionId) {
    const cache = _markerStatusCache[sessionId];
    if (cache === 'done') return '<span class="mr-marker-status mr-marker-badge done">✓</span>';
    if (cache === 'streaming') return '<span class="mr-marker-status mr-marker-badge streaming">⏳</span>';
    return '<span class="mr-marker-status mr-marker-badge none">—</span>';
  }

  function startMarkerPoll() {
    if (_markerPollTimer) return;
    _markerPollTimer = setInterval(async () => {
      if (!activeMeetingId) return;
      const meeting = meetingData[activeMeetingId];
      if (!meeting) return;
      let changed = false;
      for (const sid of meeting.subSessions) {
        const status = await ipcRenderer.invoke('marker-status', sid);
        if (_markerStatusCache[sid] !== status) {
          _markerStatusCache[sid] = status;
          changed = true;
        }
      }
      if (changed) {
        updateMarkerBadges(meeting);
        if (_divergenceEnabled) checkDivergence(meeting);
      }
    }, 2000);
  }

  function stopMarkerPoll() {
    if (_markerPollTimer) { clearInterval(_markerPollTimer); _markerPollTimer = null; }
  }

  function updateMarkerBadges(meeting) {
    for (const sid of meeting.subSessions) {
      const newHtml = markerStatusHtml(sid);
      const slotBadge = document.querySelector(`.mr-sub-slot[data-session-id="${sid}"] .mr-marker-badge`);
      if (slotBadge) slotBadge.outerHTML = newHtml;
      const tabBadge = document.querySelector(`.mr-tab[data-sid="${sid}"] .mr-marker-badge`);
      if (tabBadge) tabBadge.outerHTML = newHtml;
    }
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
    const markerBadge = markerStatusHtml(sessionId);
    const header = document.createElement('div');
    header.className = 'mr-sub-header';
    header.innerHTML = `
      <span class="mr-sub-label">${escapeHtml(slotTitle)}${badgeHtml ? ' ' + badgeHtml : ''} ${markerBadge}</span>
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
        delete _markerStatusCache[sessionId];
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

  function mountSubTerminal(sessionId) {
    if (!activeMeetingId || typeof getOrCreateTerminal !== 'function') return;
    const slot = document.querySelector(`.mr-sub-slot[data-session-id="${sessionId}"]`);
    if (!slot) return;
    slot.classList.remove('dormant');
    const termContainer = slot.querySelector('.mr-sub-terminal');
    if (!termContainer || termContainer.querySelector('.xterm')) return;
    const cached = getOrCreateTerminal(sessionId);
    if (cached && cached.container) {
      cached.container.style.display = 'block';
      termContainer.appendChild(cached.container);
      subTerminals[sessionId] = cached;
      openSubTerminal(sessionId);
      requestAnimationFrame(() => fitSubTerminal(sessionId));
    }
  }

  // --- Focus Mode ---

  function renderFocusMode(meeting, container) {
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (!focused) return;

    for (const sessionId of meeting.subSessions) {
      const slot = createSubSlot(meeting, sessionId);
      slot.style.flex = '1';
      slot.style.display = sessionId === focused ? '' : 'none';
      container.appendChild(slot);
    }

    for (const sessionId of meeting.subSessions) {
      openSubTerminal(sessionId);
    }
    // Only fit the visible (focused) terminal; hidden ones get wrong dims
    robustFit(focused);
  }

  // rAF-loop until container has real width, then fit + resize PTY
  function robustFit(sessionId) {
    const _refit = () => {
      const cached = subTerminals[sessionId];
      if (!cached || !cached.fitAddon) return;
      const el = cached.container || cached.fitAddon._addonDispose ? null : cached.terminal.element;
      if (el && !el.offsetWidth) { requestAnimationFrame(_refit); return; }
      try {
        cached.fitAddon.fit();
        ipcRenderer.send('terminal-resize', { sessionId, cols: cached.terminal.cols, rows: cached.terminal.rows });
      } catch (_) {}
    };
    requestAnimationFrame(_refit);
  }

  function switchFocusTab(meeting, newSid) {
    const container = terminalsEl();
    if (!container) return;
    const slots = container.querySelectorAll('.mr-sub-slot');
    for (const slot of slots) {
      slot.style.display = slot.dataset.sessionId === newSid ? '' : 'none';
    }
    // Use robust fit with rAF loop — single rAF often fires before layout propagates
    robustFit(newSid);
    setTimeout(() => {
      const cached = subTerminals[newSid];
      if (cached && cached.terminal) cached.terminal.scrollToBottom();
    }, 100);
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

    const summaryToggle = meeting.driverMode
      ? `<div class="mr-sync-toggle ${_driverSummaryEnabled ? 'active' : ''}" id="mr-summary-toggle"><span>Claude 摘要: ${_driverSummaryEnabled ? '开' : '关'}</span></div>`
      : '';

    el.innerHTML = `
      <button class="mr-header-btn" id="mr-sync-btn">⟳ 同步</button>
      <div class="mr-sync-toggle ${meeting.syncContext ? 'active' : ''}" id="mr-sync-toggle">
        <span>自动同步: ${meeting.syncContext ? '开' : '关'}</span>
      </div>
      <div class="mr-sync-toggle ${_divergenceEnabled ? 'active' : ''}" id="mr-divergence-toggle">
        <span>分歧检测: ${_divergenceEnabled ? '开' : '关'}</span>
      </div>
      ${summaryToggle}
    `;

    document.getElementById('mr-sync-toggle').addEventListener('click', () => {
      meeting.syncContext = !meeting.syncContext;
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { syncContext: meeting.syncContext } });
      renderToolbar(meeting);
    });

    const summaryEl = document.getElementById('mr-summary-toggle');
    if (summaryEl) {
      summaryEl.addEventListener('click', () => {
        _driverSummaryEnabled = !_driverSummaryEnabled;
        renderToolbar(meeting);
      });
    }

    document.getElementById('mr-divergence-toggle').addEventListener('click', () => {
      _divergenceEnabled = !_divergenceEnabled;
      renderToolbar(meeting);
      if (_divergenceEnabled) checkDivergence(meeting);
      else {
        _divergenceResult = null;
        const bar = document.getElementById('mr-divergence-bar');
        if (bar) bar.remove();
      }
    });

    document.getElementById('mr-sync-btn').addEventListener('click', () => {
      if (typeof MeetingBlackboard !== 'undefined' && MeetingBlackboard.handleSyncFromFocus) {
        MeetingBlackboard.handleSyncFromFocus(meeting);
      }
    });
  }

  // --- Input & Broadcasting ---

  let _inputBound = false;
  function setupInput(meeting) {
    const inputBox = document.getElementById('mr-input-box');
    const sendBtn = document.getElementById('mr-send-btn');
    const targetSelect = document.getElementById('mr-input-target');
    if (!inputBox || !sendBtn) return;

    inputBox.textContent = '';
    inputBox.dataset.placeholder = meeting.driverMode
      ? '输入指令给 Claude（@review @gemini @codex 触发副驾）'
      : '输入消息...';

    // Driver mode: disable target select (routing via @commands)
    if (meeting.driverMode && targetSelect) {
      targetSelect.style.opacity = '0.4';
      targetSelect.style.pointerEvents = 'none';
    } else if (targetSelect) {
      targetSelect.style.opacity = '';
      targetSelect.style.pointerEvents = '';
    }

    if (targetSelect) {
      targetSelect.innerHTML = '<option value="all">全部</option>';
      for (const sid of meeting.subSessions) {
        const session = sessions ? sessions.get(sid) : null;
        const label = session ? (session.title || session.kind || sid) : sid;
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = label;
        if (meeting.sendTarget === sid) opt.selected = true;
        targetSelect.appendChild(opt);
      }
      targetSelect.value = meeting.sendTarget || 'all';
    }

    if (_inputBound) return;
    _inputBound = true;

    if (targetSelect) {
      targetSelect.addEventListener('change', (e) => {
        const mid = activeMeetingId;
        const m = meetingData[mid];
        if (m) {
          m.sendTarget = e.target.value;
          ipcRenderer.send('update-meeting', { meetingId: m.id, fields: { sendTarget: m.sendTarget } });
        }
      });
    }

    const doSend = () => {
      const box = document.getElementById('mr-input-box');
      const text = box ? box.innerText.trim() : '';
      if (!text) return;
      const mid = activeMeetingId;
      const m = meetingData[mid];
      if (!m) return;
      const sel = document.getElementById('mr-input-target');
      if (sel) m.sendTarget = sel.value;
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
    const targets = current.sendTarget === 'all' ? current.subSessions : [current.sendTarget];

    // Single defensive filter: only sub-sessions still in the meeting and not dormant.
    const validTargets = targets.filter(sid => {
      if (!current.subSessions.includes(sid)) return false;
      const s = sessions ? sessions.get(sid) : null;
      return s && s.status !== 'dormant';
    });

    // Phase A: compute incremental context BEFORE appending user turn.
    // This way the just-typed user message does NOT leak into its own injection.
    // Cursor advance here uses the pre-append timeline state.
    const contextBySid = {};
    if (meeting.syncContext) {
      for (const sessionId of validTargets) {
        const result = await ipcRenderer.invoke('meeting-incremental-context', {
          meetingId: meeting.id, targetSid: sessionId,
        });
        if (result && result.turns && result.turns.length > 0) {
          contextBySid[sessionId] = formatIncrementalContext(result.turns, sessions);
        }
      }
    }

    // Phase B: append user turn to timeline. Always do this (even when no valid
    // targets) so Feed UI history is complete.
    await ipcRenderer.invoke('meeting-append-user-turn', { meetingId: meeting.id, text });

    if (validTargets.length === 0) {
      console.warn('[meeting-room] handleMeetingSend: no valid targets, message recorded in timeline only');
      meeting.lastMessageTime = Date.now();
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
      return;
    }

    // --- Driver Mode routing ---
    if (current.driverMode) {
      const cmd = parseDriverCommand(text, current);
      if (cmd.type === 'review') {
        renderReviewResult(current, [{ sid: 'pending', verdict: 'PENDING', reason: '审查中...' }]);
        triggerReview(current, cmd.text, 'user-review');
        meeting.lastMessageTime = Date.now();
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
        return;
      }
      let driverTargets;
      if (cmd.type === 'direct') {
        const sid = findSessionByKind(current, cmd.targetKind);
        driverTargets = sid ? [sid] : [];
        // For @gemini/@codex with summary enabled, prepend context
        if (_driverSummaryEnabled && cmd.targetKind !== 'claude') {
          let claudeLastOutput = '';
          try { claudeLastOutput = await ipcRenderer.invoke('get-last-assistant-text', current.driverSessionId) || ''; } catch {}
          let recentTl = '';
          try { recentTl = await ipcRenderer.invoke('driver-recent-timeline', { meetingId: meeting.id, count: 5 }); } catch {}
          const ctx = (recentTl ? recentTl + '\n' : '') + (claudeLastOutput ? '--- Claude 最近输出 ---\n' + claudeLastOutput.slice(0, 5000) + '\n---\n' : '');
          if (ctx && driverTargets.length > 0) {
            contextBySid[driverTargets[0]] = ctx;
          }
        }
      } else {
        driverTargets = current.driverSessionId ? [current.driverSessionId] : validTargets;
      }
      // Use driverTargets instead of validTargets
      for (const sessionId of driverTargets) {
        const payload = (contextBySid[sessionId] || '') + (cmd.text || text);
        ipcRenderer.send('terminal-input', { sessionId, data: payload });
        const session = sessions ? sessions.get(sessionId) : null;
        const enterDelay = session && session.kind === 'codex' ? 300 : 80;
        setTimeout(() => {
          ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
        }, enterDelay);
      }
      meeting.lastMessageTime = Date.now();
      ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
      return;
    }

    // --- Normal mode: Phase C send to each target ---
    for (const sessionId of validTargets) {
      const payload = (contextBySid[sessionId] || '') + text;
      ipcRenderer.send('terminal-input', { sessionId, data: payload });
      const session = sessions ? sessions.get(sessionId) : null;
      const enterDelay = session && session.kind === 'codex' ? 300 : 80;
      setTimeout(() => {
        ipcRenderer.send('terminal-input', { sessionId, data: '\r' });
      }, enterDelay);
    }

    meeting.lastMessageTime = Date.now();
    ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { lastMessageTime: meeting.lastMessageTime } });
    _contextCompressCache.clear();
    _divergenceResult = null;
    _divergenceHash = '';
    const divBar = document.getElementById('mr-divergence-bar');
    if (divBar) divBar.remove();
  }

  // Format incremental-context turns as a clear "meeting sync" prefix the AI can
  // recognize as not being from the user. Format:
  //   [会议室协作同步]
  //   【你】Q2 follow-up
  //   【Codex】R2_X content...
  //   ---
  function formatIncrementalContext(turns, sessions) {
    const lines = ['[会议室协作同步]'];
    for (const t of turns) {
      let label;
      if (t.sid === 'user') {
        label = '你';
      } else {
        const s = sessions ? sessions.get(t.sid) : null;
        label = s ? (s.title || s.kind || 'AI') : 'AI';
      }
      lines.push(`【${label}】${t.text}`);
    }
    lines.push('---', '');
    return lines.join('\n');
  }

  const _contextCompressCache = new Map();

  async function buildContextSummary(meeting, excludeSessionId) {
    const others = meeting.subSessions.filter(id => id !== excludeSessionId);
    if (others.length === 0) return '';

    const lines = [];
    for (const id of others) {
      const session = sessions ? sessions.get(id) : null;
      const label = session ? (session.kind || 'session') : 'session';

      // 1. Try SM marker content first
      let content = await ipcRenderer.invoke('quick-summary', id);

      // 2. Fallback to ring buffer last 1000 chars
      if (!content) {
        const raw = await ipcRenderer.invoke('get-ring-buffer', id);
        if (raw) content = raw.length > 1000 ? raw.slice(-1000) : raw;
      }

      if (!content) continue;

      // 3. Threshold: ≤1000 use as-is, >1000 compress via Gemini Flash
      if (content.length > 1000) {
        const cacheKey = id + ':' + simpleHash(content);
        if (_contextCompressCache.has(cacheKey)) {
          content = _contextCompressCache.get(cacheKey);
        } else {
          const compressed = await ipcRenderer.invoke('compress-context', { content, maxChars: 1000 });
          _contextCompressCache.set(cacheKey, compressed);
          content = compressed;
        }
      }

      lines.push(`【${label}】${content}`);
    }

    if (lines.length === 0) return '';
    return `[会议室协作同步]\n${lines.join('\n')}\n---\n`;
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  // --- Divergence Detection ---

  async function checkDivergence(meeting) {
    if (!_divergenceEnabled) return;
    let doneCount = 0;
    for (const sid of meeting.subSessions) {
      if (_markerStatusCache[sid] === 'done') doneCount++;
    }
    if (doneCount < 2) {
      _divergenceResult = null;
      renderDivergenceBar(meeting);
      return;
    }

    const hashes = [];
    for (const sid of meeting.subSessions) {
      const content = await ipcRenderer.invoke('quick-summary', sid);
      hashes.push(simpleHash(content || ''));
    }
    const hash = hashes.join('-');
    if (hash === _divergenceHash && _divergenceResult) {
      renderDivergenceBar(meeting);
      return;
    }

    _divergenceResult = await ipcRenderer.invoke('detect-divergence', { meetingId: meeting.id });
    _divergenceHash = hash;
    renderDivergenceBar(meeting);
  }

  function renderDivergenceBar(meeting) {
    let bar = document.getElementById('mr-divergence-bar');
    if (!_divergenceEnabled || !_divergenceResult) {
      if (bar) bar.remove();
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'mr-divergence-bar';
      const container = terminalsEl();
      if (container) container.parentElement.insertBefore(bar, container);
    }

    const { consensus = [], divergence = [] } = _divergenceResult;
    let html = '';

    if (divergence.length > 0) {
      html += `<div class="mr-div-header mr-div-warn">⚠ ${divergence.length} 个分歧点</div>`;
      html += '<div class="mr-div-cards">';
      for (const d of divergence) {
        const positions = Object.entries(d.positions || {})
          .map(([k, v]) => `<span class="mr-div-pos"><b>${escapeHtml(k)}</b>: ${escapeHtml(v)}</span>`)
          .join('');
        html += `<div class="mr-div-card">
          <div class="mr-div-topic">${escapeHtml(d.topic)}</div>
          <div class="mr-div-positions">${positions}</div>
          <div class="mr-div-actions">
            <button class="mr-div-ask" data-q="${escapeHtml(d.suggestedQuestion || '')}" data-target="all">追问全部</button>
            ${meeting.subSessions.map(sid => {
              const s = sessions ? sessions.get(sid) : null;
              const label = s ? (s.kind || 'AI') : 'AI';
              return `<button class="mr-div-ask" data-q="${escapeHtml(d.suggestedQuestion || '')}" data-target="${sid}">问 ${escapeHtml(label)}</button>`;
            }).join('')}
          </div>
        </div>`;
      }
      html += '</div>';
    }

    if (consensus.length > 0) {
      html += `<div class="mr-div-header mr-div-ok">✓ ${consensus.length} 个共识点</div>`;
      html += '<div class="mr-div-consensus">' + consensus.map(c => `<span class="mr-div-consensus-item">${escapeHtml(c)}</span>`).join('') + '</div>';
    }

    bar.innerHTML = html;

    bar.querySelectorAll('.mr-div-ask').forEach(btn => {
      btn.addEventListener('click', () => {
        const question = btn.dataset.q;
        const target = btn.dataset.target;
        const inputBox = document.getElementById('mr-input-box');
        if (inputBox && question) inputBox.textContent = question;
        if (target !== 'all') {
          meeting.sendTarget = target;
        } else {
          meeting.sendTarget = 'all';
        }
        ipcRenderer.send('update-meeting', { meetingId: meeting.id, fields: { sendTarget: meeting.sendTarget } });
        const sel = document.getElementById('mr-input-target');
        if (sel) sel.value = meeting.sendTarget;
        if (inputBox) inputBox.focus();
      });
    });
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

  // --- Tab output state tracking ---
  ipcRenderer.on('terminal-data', (_e, { sessionId }) => {
    if (!activeMeetingId) return;
    const meeting = meetingData[activeMeetingId];
    if (!meeting || !meeting.subSessions.includes(sessionId)) return;
    const focused = meeting.focusedSub || meeting.subSessions[0];
    if (sessionId === focused) return;

    _tabState[sessionId] = 'streaming';
    updateTabIndicator(sessionId);

    if (_tabTimers[sessionId]) clearTimeout(_tabTimers[sessionId]);
    _tabTimers[sessionId] = setTimeout(() => {
      if (_tabState[sessionId] === 'streaming') {
        _tabState[sessionId] = 'new-output';
        updateTabIndicator(sessionId);
      }
    }, 2000);
  });

  ipcRenderer.on('session-closed', (_e, { sessionId }) => {
    if (_tabState[sessionId] !== undefined) {
      _tabState[sessionId] = 'error';
      updateTabIndicator(sessionId);
    }
  });

  function updateTabIndicator(sessionId) {
    const tab = document.querySelector(`.mr-tab[data-sid="${sessionId}"]`);
    if (!tab) return;
    const state = _tabState[sessionId] || 'idle';
    let dot = tab.querySelector('.mr-tab-status');
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'mr-tab-status';
      tab.prepend(dot);
    }
    dot.className = `mr-tab-status ${state}`;
    let badge = tab.querySelector('.new-badge');
    if (state === 'new-output') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'new-badge';
        badge.textContent = 'NEW';
        tab.appendChild(badge);
      }
      tab.classList.add('has-new');
    } else {
      if (badge) badge.remove();
      tab.classList.remove('has-new');
    }
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
    const markerBadge = markerStatusHtml(payload.sessionId);
    const newHtml = `${escapeHtml(title)}${badges ? ' ' + badges : ''}`;
    // Update sub-slot header
    const slot = document.querySelector(`.mr-sub-slot[data-session-id="${payload.sessionId}"]`);
    if (slot) {
      const label = slot.querySelector('.mr-sub-label');
      if (label) label.innerHTML = `${newHtml} ${markerBadge}`;
    }
    // Update focus-mode tab (preserve status dot + NEW badge + marker badge)
    const tab = document.querySelector(`.mr-tab[data-sid="${payload.sessionId}"]`);
    if (tab) {
      const state = _tabState[payload.sessionId] || 'idle';
      const statusDot = `<span class="mr-tab-status ${state}"></span>`;
      const newBadge = state === 'new-output' ? ' <span class="new-badge">NEW</span>' : '';
      tab.innerHTML = `${statusDot}${newHtml} ${markerBadge}${newBadge}`;
    }
  });

  // --- Expose global ---

  window.MeetingRoom = {
    init,
    openMeeting,
    closeMeetingPanel,
    getActiveMeetingId,
    getMeetingData,
    updateMeetingData,
    mountSubTerminal,
    get _divergenceResult() { return _divergenceResult; },
  };
})();
