'use strict';
// AI Team Room UI — full implementation
// Loaded by index.html after renderer.js
const TeamRoom = (() => {
  const { ipcRenderer } = require('electron');

  // State
  let currentRoomId = null;
  let currentRoomConfig = null;
  let characters = {};    // id -> character object
  let thinkingEl = null;  // reference to thinking indicator DOM node
  let streamHandler = null; // registered team:event listener (for cleanup on re-init)

  // DOM refs (resolved once DOM is ready)
  const $ = id => document.getElementById(id);

  // --- Helpers ---

  /** Escape HTML by creating a text node */
  function esc(s) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s == null ? '' : s)));
    return d.innerHTML;
  }

  /** Get display name for a character id */
  function charName(id) {
    if (id === 'user') return '你';
    const ch = characters[id];
    if (ch) return ch.display_name || ch.name || id;
    return id;
  }

  /** Derive CSS class from cli field (claude/gemini/codex/user) */
  function avatarColor(cli) {
    if (!cli) return 'tr-user';
    const c = String(cli).toLowerCase();
    if (c.includes('claude')) return 'tr-claude';
    if (c.includes('gemini')) return 'tr-gemini';
    if (c.includes('codex')) return 'tr-codex';
    return 'tr-user';
  }

  /** Initials for avatar from a name string */
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name || '?').slice(0, 2).toUpperCase();
  }

  /** Format unix timestamp (seconds) to HH:MM:SS */
  function formatTs(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  /** Replace newlines with <br> in escaped text */
  function formatContent(text) {
    return esc(text).replace(/\n/g, '<br>');
  }

  // --- Init ---

  async function init() {
    // Load characters once
    try {
      const chars = await ipcRenderer.invoke('team:loadCharacters');
      if (chars && typeof chars === 'object') {
        characters = chars;
      }
    } catch (e) {
      console.warn('[TeamRoom] loadCharacters failed:', e.message);
    }

    // Send button
    const sendBtn = $('tr-send-btn');
    if (sendBtn) sendBtn.addEventListener('click', sendMessage);

    // Enter key in input box (Shift+Enter = newline)
    const inputBox = $('tr-input-box');
    if (inputBox) {
      inputBox.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
    }

    // Stream events — register once, remove old handler if re-init
    if (streamHandler) ipcRenderer.removeListener('team:event', streamHandler);
    streamHandler = (_event, payload) => {
      console.log('[TeamRoom] stream:', payload.type);
    };
    ipcRenderer.on('team:event', streamHandler);
  }

  // --- Open Room ---

  async function openRoom(roomId, roomConfig) {
    currentRoomId = roomId;
    currentRoomConfig = roomConfig || {};
    renderHeader();
    await refreshThread();
    await refreshInspector();
  }

  function renderHeader() {
    const headerEl = $('tr-header');
    if (!headerEl) return;
    const cfg = currentRoomConfig || {};
    const members = cfg.members || [];

    // Build members bar HTML
    const membersHtml = members.map(mid => {
      const ch = characters[mid];
      const cli = ch ? (ch.backing_cli || mid) : mid;
      const colorCls = avatarColor(cli);
      const name = charName(mid);
      const av = initials(name);
      return `<span class="tr-member">
        <span class="tr-avatar ${colorCls}">${esc(av)}</span>
        ${esc(name)}
      </span>`;
    }).join('');

    headerEl.innerHTML = `
      <div class="tr-room-name">${esc(cfg.display_name || currentRoomId)}</div>
      <div class="tr-room-meta">模式: ${esc(cfg.task_mode || 'natural')} &nbsp;·&nbsp; ${members.length} 成员</div>
      <div class="tr-members">${membersHtml}</div>
    `;
  }

  // --- Thread ---

  async function refreshThread() {
    const threadEl = $('tr-thread');
    if (!threadEl || !currentRoomId) return;
    let events = [];
    try {
      events = await ipcRenderer.invoke('team:getEvents', currentRoomId, 200);
    } catch (e) {
      console.warn('[TeamRoom] getEvents failed:', e.message);
    }
    threadEl.innerHTML = '';
    if (!events || events.length === 0) {
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      note.textContent = '暂无消息，发送第一条消息开始对话';
      threadEl.appendChild(note);
      return;
    }

    let lastRound = null;
    for (const evt of events) {
      // Round label
      if (evt.round_id != null && evt.round_id !== lastRound) {
        lastRound = evt.round_id;
        const label = document.createElement('div');
        label.className = 'tr-round-label';
        label.textContent = `Round ${evt.round_id}`;
        threadEl.appendChild(label);
      }

      const t = evt.kind || '';
      if (t === 'message' || t === 'user_message') {
        appendMessage(threadEl, evt);
      } else if (t === 'converged' || t === 'pass') {
        const label = document.createElement('div');
        label.className = 'tr-round-label';
        const txt = t === 'converged'
          ? `[收敛] ${evt.data ? JSON.stringify(evt.data).slice(0, 80) : ''}`
          : `[Pass] ${evt.actor || ''}: ${(evt.data && evt.data.decision) || ''}`;
        label.textContent = txt;
        threadEl.appendChild(label);
      } else if (t === 'system_note' || t === 'error') {
        const note = document.createElement('div');
        note.className = 'tr-system-note';
        note.textContent = evt.content || (evt.data ? JSON.stringify(evt.data) : t);
        threadEl.appendChild(note);
      } else {
        // Generic fallback as system note for unknown types
        const note = document.createElement('div');
        note.className = 'tr-system-note';
        note.textContent = `[${t}] ${evt.content || ''}`;
        threadEl.appendChild(note);
      }
    }

    // Scroll to bottom
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  /** Render a single message bubble and append to container */
  function appendMessage(container, evt) {
    const charId = evt.actor || 'user';
    const ch = characters[charId];
    const cli = ch ? (ch.backing_cli || charId) : (charId === 'user' ? 'user' : charId);
    const colorCls = avatarColor(cli);
    const name = charName(charId);
    const av = initials(name);
    const content = evt.content || (evt.data ? JSON.stringify(evt.data) : '');
    const ts = formatTs(evt.ts);

    const msgEl = document.createElement('div');
    msgEl.className = `tr-msg ${colorCls}`;
    msgEl.innerHTML = `
      <div class="tr-msg-avatar">${esc(av)}</div>
      <div class="tr-msg-body">
        <div class="tr-msg-meta">
          <span class="tr-msg-name">${esc(name)}</span>
          <span class="tr-msg-time">${esc(ts)}</span>
        </div>
        <div class="tr-msg-bubble">${formatContent(content)}</div>
      </div>
    `;
    container.appendChild(msgEl);
  }

  // --- Inspector ---

  async function refreshInspector() {
    const inspEl = $('tr-inspector');
    if (!inspEl || !currentRoomId) return;

    let wiki = null;
    let events = [];
    try {
      wiki = await ipcRenderer.invoke('team:getWiki', currentRoomId);
    } catch (e) {
      console.warn('[TeamRoom] getWiki failed:', e.message);
    }
    try {
      events = await ipcRenderer.invoke('team:getEvents', currentRoomId, 30);
    } catch (e) {
      console.warn('[TeamRoom] getEvents (inspector) failed:', e.message);
    }

    inspEl.innerHTML = '';

    // Wiki section
    const wikiSection = document.createElement('div');
    wikiSection.className = 'tr-insp-section';
    const wikiTitle = document.createElement('div');
    wikiTitle.className = 'tr-insp-title';
    wikiTitle.textContent = 'Wiki';
    wikiSection.appendChild(wikiTitle);

    if (wiki && Array.isArray(wiki) && wiki.length > 0) {
      for (const item of wiki) {
        const el = document.createElement('div');
        el.className = 'tr-wiki-item';
        el.innerHTML = `
          <div class="tr-wiki-item-title">${esc(item.what || '')}</div>
          <div class="tr-wiki-item-body">${esc(item.why || '')}</div>
        `;
        wikiSection.appendChild(el);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'tr-wiki-item-body';
      empty.textContent = '暂无 wiki 条目';
      wikiSection.appendChild(empty);
    }
    inspEl.appendChild(wikiSection);

    // Event log section
    const evtSection = document.createElement('div');
    evtSection.className = 'tr-insp-section';
    const evtTitle = document.createElement('div');
    evtTitle.className = 'tr-insp-title';
    evtTitle.textContent = '最近事件';
    evtSection.appendChild(evtTitle);

    const recent = (events || []).slice(-20).reverse();
    for (const evt of recent) {
      const el = document.createElement('div');
      el.className = 'tr-event-item';
      const typeStr = evt.kind || '?';
      const bodyStr = evt.content
        ? String(evt.content).slice(0, 60)
        : (evt.data ? JSON.stringify(evt.data).slice(0, 60) : '');
      el.innerHTML = `
        <span class="tr-event-item-type">${esc(typeStr)}</span>
        <span class="tr-event-item-body">${esc(bodyStr)}</span>
      `;
      evtSection.appendChild(el);
    }
    if (recent.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tr-event-item-body';
      empty.textContent = '暂无事件';
      evtSection.appendChild(empty);
    }
    inspEl.appendChild(evtSection);
  }

  // --- Send Message ---

  async function sendMessage() {
    const inputBox = $('tr-input-box');
    const sendBtn = $('tr-send-btn');
    if (!inputBox || !currentRoomId) return;

    const text = inputBox.innerText.trim();
    if (!text) return;

    // Clear input
    inputBox.innerText = '';

    // Show user message immediately
    const threadEl = $('tr-thread');
    if (threadEl) {
      const fakeEvt = {
        kind: 'message',
        actor: 'user',
        content: text,
        ts: Math.floor(Date.now() / 1000),
      };
      appendMessage(threadEl, fakeEvt);
      threadEl.scrollTop = threadEl.scrollHeight;

      // Show thinking indicator
      thinkingEl = document.createElement('div');
      thinkingEl.className = 'tr-msg tr-claude';
      thinkingEl.innerHTML = `
        <div class="tr-msg-avatar">${esc('AI')}</div>
        <div class="tr-msg-body">
          <div class="tr-msg-meta"><span class="tr-msg-name">Team</span></div>
          <div class="tr-thinking">思考中</div>
        </div>
      `;
      threadEl.appendChild(thinkingEl);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // Disable send while processing
    if (sendBtn) sendBtn.disabled = true;

    try {
      await ipcRenderer.invoke('team:ask', currentRoomId, text);
    } catch (e) {
      console.error('[TeamRoom] askTeam failed:', e.message);
      // Show error note
      if (threadEl) {
        const errNote = document.createElement('div');
        errNote.className = 'tr-system-note';
        errNote.textContent = `错误: ${e.message}`;
        threadEl.appendChild(errNote);
      }
    } finally {
      // Remove thinking indicator
      if (thinkingEl && thinkingEl.parentNode) {
        thinkingEl.parentNode.removeChild(thinkingEl);
        thinkingEl = null;
      }
      if (sendBtn) sendBtn.disabled = false;

      // Refresh UI
      await refreshThread();
      await refreshInspector();
    }
  }

  // --- Bootstrap ---

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, openRoom, refreshThread, refreshInspector, sendMessage };
})();
