'use strict';
// AI Team Room UI — full implementation
// Loaded by index.html after renderer.js
const TeamRoom = (() => {
  const { ipcRenderer } = require('electron');
  const { marked } = require('marked');
  const DOMPurify = require('dompurify');

  marked.setOptions({ breaks: true, gfm: true });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const MD_ALLOWED_TAGS = ['p','br','strong','em','del','s','code','pre','ul','ol','li',
    'blockquote','h1','h2','h3','h4','h5','h6','a','hr','table','thead','tbody','tr','th','td','span',
    'div','button'];
  const MD_ALLOWED_ATTR = ['href','title','target','rel','class','onclick'];

  // State
  let currentRoomId = null;
  let currentRoomConfig = null;
  let characters = {};    // id -> character object
  let thinkingEl = null;  // reference to thinking indicator DOM node
  let streamHandler = null; // registered team:event listener (for cleanup on re-init)
  let streamRound = 0;
  let streamRoundActors = new Set();
  let pendingExtractionStats = null;
  const MAX_VISIBLE_STREAM = 50;

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

  /** Avatar text: emoji for known characters, initials for others */
  const CHAR_EMOJI = { pikachu: '⚡', charmander: '🔥', squirtle: '🐢', user: '👤' };
  function initials(name, charId) {
    if (charId && CHAR_EMOJI[charId]) return CHAR_EMOJI[charId];
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

  /** Render markdown to sanitized HTML (bold/italic/code/list/link/table) */
  function formatContent(text) {
    const src = String(text == null ? '' : text);
    try {
      const html = marked.parse(src);
      let sanitized = DOMPurify.sanitize(html, { ALLOWED_TAGS: MD_ALLOWED_TAGS, ALLOWED_ATTR: MD_ALLOWED_ATTR });
      sanitized = sanitized.replace(/<pre>/g, '<div class="tr-code-wrapper"><button class="tr-code-copy" onclick="this.parentElement.querySelector(\'code\')&&navigator.clipboard.writeText(this.parentElement.querySelector(\'code\').textContent).then(()=>{this.textContent=\'\u2713\';this.classList.add(\'copied\');setTimeout(()=>{this.textContent=\'Copy\';this.classList.remove(\'copied\')},1500)})">Copy</button><pre>');
      sanitized = sanitized.replace(/<\/pre>/g, '</pre></div>');
      return sanitized;
    } catch (e) {
      console.warn('[TeamRoom] markdown parse failed, falling back to plain:', e && e.message);
      return esc(src).replace(/\n/g, '<br>');
    }
  }

  function _roundLabel(n) {
    if (n === 1) return 'ROUND 1 \u00B7 \u72EC\u7ACB\u601D\u8003';
    if (n === 2) return 'ROUND 2 \u00B7 \u4E92\u76F8\u8865\u5200';
    return `ROUND ${n} \u00B7 \u6DF1\u5165\u8BA8\u8BBA`;
  }

  function _insertRoundSeparator(container, roundNum) {
    const label = document.createElement('div');
    label.className = 'tr-round-label';
    label.textContent = _roundLabel(roundNum);
    container.appendChild(label);
  }

  function _appendEvolutionSummary(container, extraction, evolution) {
    const parts = [];
    if (extraction) {
      const p = extraction.personal || 0;
      if (p > 0) parts.push(`\u63D0\u53D6 <strong>${p}</strong> \u6761\u8BB0\u5FC6`);
    }
    if (evolution) {
      const l = evolution.lessons_saved || 0;
      const d = (evolution.wiki_distilled || 0) + (evolution.lessons_distilled || 0);
      if (l > 0) parts.push(`\u5B66\u5230 <strong>${l}</strong> \u6761\u7ECF\u9A8C`);
      if (d > 0) parts.push(`\u84B8\u998F <strong>${d}</strong> \u6761\u5171\u8BC6`);
    }
    if (parts.length === 0) return;
    const el = document.createElement('div');
    el.className = 'tr-evolution-summary';
    el.innerHTML = `\u{1F4DD} ${parts.join(' \u00B7 ')}`;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  function _trimThread(threadEl) {
    const hintCls = 'tr-collapsed-hint';
    const children = threadEl.children;
    const hasHint = children.length > 0 && children[0].classList.contains(hintCls);
    const contentCount = hasHint ? children.length - 1 : children.length;

    if (contentCount <= MAX_VISIBLE_STREAM) return;

    const excess = contentCount - MAX_VISIBLE_STREAM;
    const startIdx = hasHint ? 1 : 0;
    for (let i = 0; i < excess; i++) {
      threadEl.removeChild(threadEl.children[startIdx]);
    }

    if (!hasHint) {
      const hint = document.createElement('div');
      hint.className = hintCls;
      hint.textContent = '\u22EF \u70B9\u51FB\u52A0\u8F7D\u66F4\u65E9\u7684\u6D88\u606F';
      hint.onclick = () => refreshThread();
      threadEl.insertBefore(hint, threadEl.firstChild);
    }
  }

  // --- Mention autocomplete state ---

  const mentionState = {
    active: false,
    items: [],
    filtered: [],
    selectedIdx: 0,
    query: '',
    atIndex: -1,
    textNode: null,
  };

  function resetMention() {
    mentionState.active = false;
    mentionState.items = [];
    mentionState.filtered = [];
    mentionState.selectedIdx = 0;
    mentionState.query = '';
    mentionState.atIndex = -1;
    mentionState.textNode = null;
    const popup = $('tr-mention-popup');
    if (popup) {
      popup.style.display = 'none';
      popup.innerHTML = '';
    }
  }

  function buildMentionItems() {
    const cfg = currentRoomConfig || {};
    const members = cfg.members || [];
    const items = [{
      id: 'team',
      label: 'team',
      subtitle: '全体成员',
      avatarText: '👥',
      avatarCls: 'tr-user',
    }];
    for (const mid of members) {
      const ch = characters[mid];
      const cli = ch ? (ch.backing_cli || mid) : mid;
      const label = charName(mid);
      items.push({
        id: mid,
        label,
        subtitle: `@${mid}`,
        avatarText: initials(label, mid),
        avatarCls: avatarColor(cli),
      });
    }
    return items;
  }

  function filterMention(query) {
    const q = (query || '').toLowerCase();
    if (!q) return mentionState.items.slice();
    return mentionState.items.filter(it =>
      it.label.toLowerCase().includes(q) || it.id.toLowerCase().includes(q)
    );
  }

  function renderMentionPopup() {
    const popup = $('tr-mention-popup');
    if (!popup) return;
    const items = mentionState.filtered;
    if (items.length === 0) { resetMention(); return; }
    if (mentionState.selectedIdx >= items.length) mentionState.selectedIdx = 0;
    popup.innerHTML = items.map((it, i) => `
      <div class="tr-mention-item ${i === mentionState.selectedIdx ? 'active' : ''}" data-idx="${i}">
        <span class="tr-avatar ${it.avatarCls}">${esc(it.avatarText)}</span>
        <span class="tr-mention-name">${esc(it.label)}</span>
        <span class="tr-mention-sub">${esc(it.subtitle)}</span>
      </div>
    `).join('');
    popup.style.display = 'block';
    // Scroll active item into view
    const activeEl = popup.querySelector('.tr-mention-item.active');
    if (activeEl && activeEl.scrollIntoView) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function detectMention() {
    const inputBox = $('tr-input-box');
    if (!inputBox) { resetMention(); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { resetMention(); return; }
    const range = sel.getRangeAt(0);
    if (!range.collapsed) { resetMention(); return; }
    const node = range.startContainer;
    if (!inputBox.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      resetMention();
      return;
    }
    const offset = range.startOffset;
    const text = node.nodeValue.slice(0, offset);
    const m = text.match(/(^|\s)@([^\s@]*)$/);
    if (!m) { resetMention(); return; }
    const query = m[2];
    const atIndex = offset - query.length - 1;

    if (!mentionState.active) {
      mentionState.items = buildMentionItems();
      mentionState.selectedIdx = 0;
      mentionState.active = true;
    }
    mentionState.query = query;
    mentionState.atIndex = atIndex;
    mentionState.textNode = node;
    mentionState.filtered = filterMention(query);
    renderMentionPopup();
  }

  function commitMention() {
    const items = mentionState.filtered;
    if (!items || items.length === 0) { resetMention(); return; }
    const it = items[mentionState.selectedIdx] || items[0];
    const node = mentionState.textNode;
    const atIndex = mentionState.atIndex;
    if (!node || atIndex < 0) { resetMention(); return; }
    const text = node.nodeValue;
    const sel = window.getSelection();
    const caretOffset = (sel && sel.rangeCount && sel.getRangeAt(0).startContainer === node)
      ? sel.getRangeAt(0).startOffset
      : (atIndex + 1 + mentionState.query.length);
    const before = text.slice(0, atIndex);
    const after = text.slice(caretOffset);
    const insertion = `@${it.label} `;
    node.nodeValue = before + insertion + after;
    const newOffset = before.length + insertion.length;
    const range = document.createRange();
    range.setStart(node, newOffset);
    range.setEnd(node, newOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    resetMention();
  }

  function onMentionKeydown(e) {
    if (!mentionState.active) return;
    const n = mentionState.filtered.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (n > 0) {
        mentionState.selectedIdx = (mentionState.selectedIdx + 1) % n;
        renderMentionPopup();
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (n > 0) {
        mentionState.selectedIdx = (mentionState.selectedIdx - 1 + n) % n;
        renderMentionPopup();
      }
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (n > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        commitMention();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      resetMention();
    }
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

    // Input box event bindings
    const inputBox = $('tr-input-box');
    if (inputBox) {
      // @mention autocomplete: detect on every input change
      inputBox.addEventListener('input', () => detectMention());

      // Keydown: mention navigation takes priority, then Enter to send
      inputBox.addEventListener('keydown', (e) => {
        // Let mention handler intercept arrow/enter/tab/escape first
        if (mentionState.active) {
          onMentionKeydown(e);
          if (e.defaultPrevented) return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!sending) sendMessage();
        }
      });

      // Click on mention popup items
      const popup = $('tr-mention-popup');
      if (popup) {
        popup.addEventListener('mousedown', (e) => {
          const item = e.target.closest('.tr-mention-item');
          if (item) {
            e.preventDefault();
            mentionState.selectedIdx = parseInt(item.dataset.idx || '0', 10);
            commitMention();
          }
        });
      }
    }

    // Stream events — register once, remove old handler if re-init
    if (streamHandler) ipcRenderer.removeListener('team:event', streamHandler);
    streamHandler = (_event, payload) => {
      handleStreamEvent(payload);
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

    const membersHtml = members.map(mid => {
      const ch = characters[mid];
      const cli = ch ? (ch.backing_cli || mid) : mid;
      const colorCls = avatarColor(cli);
      const name = charName(mid);
      const av = initials(name, mid);
      return `<span class="tr-member">
        <span class="tr-avatar ${colorCls}">${esc(av)}</span>
        ${esc(name)}
      </span>`;
    }).join('');

    headerEl.innerHTML = `
      <div class="tr-header-top">
        <div>
          <div class="tr-room-name">${esc(cfg.display_name || currentRoomId)}</div>
          <div class="tr-room-meta">模式: ${esc(cfg.task_mode || 'natural')} · ${members.length} 成员</div>
        </div>
        <div class="tr-header-actions">
          <button class="tr-action-btn" id="tr-export-btn" title="导出对话">📋</button>
        </div>
      </div>
      <div class="tr-members">${membersHtml}</div>
    `;

    const exportBtn = $('tr-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportConversation);
    }
  }

  async function exportConversation() {
    if (!currentRoomId) return;
    try {
      const result = await ipcRenderer.invoke('team:exportConversation', currentRoomId);
      if (result && result.markdown) {
        const { clipboard } = require('electron');
        clipboard.writeText(result.markdown);
        const btn = $('tr-export-btn');
        if (btn) {
          const orig = btn.textContent;
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        }
      }
    } catch (e) {
      console.error('[TeamRoom] export failed:', e.message);
      const btn = $('tr-export-btn');
      if (btn) {
        btn.textContent = '✗';
        setTimeout(() => { btn.textContent = '📋'; }, 2000);
      }
    }
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
      } else if (t === 'checkpoint') {
        appendCheckpoint(threadEl, {
          actor: evt.actor, name: charName(evt.actor),
          content: evt.content || '', ts: evt.ts,
        });
      } else if (t === 'tool_use') {
        appendToolUse(threadEl, {
          actor: evt.actor, name: charName(evt.actor),
          tool: evt.tool || evt.content || 'tool',
          input: evt.input || {},
          ts: evt.ts,
        });
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
    const av = initials(name, charId);
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

  /** Render a single checkpoint card — muted "路过说一下" style, no round-counter impact. */
  function appendCheckpoint(container, evt) {
    const charId = evt.actor || 'system';
    const ch = characters[charId];
    const cli = ch ? (ch.backing_cli || charId) : charId;
    const colorCls = avatarColor(cli);
    const name = evt.name || charName(charId);
    const av = initials(name, charId);
    const content = evt.content || '';
    const ts = formatTs(evt.ts);

    const el = document.createElement('div');
    el.className = `tr-checkpoint ${colorCls}`;
    el.innerHTML = `
      <div class="tr-checkpoint-avatar">${esc(av)}</div>
      <div class="tr-checkpoint-body">
        <div class="tr-checkpoint-meta">
          <span class="tr-checkpoint-name">${esc(name)}</span>
          <span class="tr-checkpoint-prefix">路过说一下</span>
          <span class="tr-checkpoint-time">${esc(ts)}</span>
        </div>
        <div class="tr-checkpoint-bubble">${formatContent(content)}</div>
      </div>
    `;
    container.appendChild(el);
  }

  /** Format tool call input as readable function-call string. */
  function _formatToolCall(tool, input) {
    const name = tool || 'unknown';
    if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
      return `${name}()`;
    }
    const args = Object.entries(input)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    const full = `${name}(${args})`;
    return full.length > 120 ? full.slice(0, 117) + '...' : full;
  }

  /** Render a tool_use card — code-style, distinct from checkpoint. */
  function appendToolUse(container, { actor, name, tool, input, ts }) {
    const charId = actor || 'system';
    const ch = characters[charId];
    const cli = ch ? (ch.backing_cli || charId) : charId;
    const colorCls = avatarColor(cli);
    const displayName = name || charName(charId);
    const timeStr = formatTs(ts);
    const codeStr = _formatToolCall(tool, input);

    const el = document.createElement('div');
    el.className = `tr-tool-use ${colorCls}`;
    el.innerHTML = `
      <div class="tr-tool-use-avatar">\u{1F527}</div>
      <div class="tr-tool-use-body">
        <div class="tr-tool-use-meta">
          <span class="tr-tool-use-name">${esc(displayName)}</span>
          <span class="tr-tool-use-tag">\u8C03\u7528\u5DE5\u5177</span>
          <span class="tr-tool-use-time">${esc(timeStr)}</span>
        </div>
        <div class="tr-tool-use-code">${esc(codeStr)}</div>
      </div>
    `;
    container.appendChild(el);
  }

  // --- Inspector ---

  /** Append a single streaming event to the inspector's recent events list (live update). */
  function appendInspectorEvent(evt) {
    const inspEl = $('tr-inspector');
    if (!inspEl) return;
    // Find or create the events section container
    let evtSection = inspEl.querySelector('.tr-insp-events');
    if (!evtSection) return;

    const el = document.createElement('div');
    el.className = 'tr-event-item';
    const typeStr = evt.type || '?';
    const who = evt.name || evt.actor || '';
    const bodyStr = evt.content ? String(evt.content).slice(0, 60) : who;
    el.innerHTML = `
      <span class="tr-event-item-type">${esc(typeStr)}</span>
      <span class="tr-event-item-body">${esc(bodyStr)}</span>
    `;
    // Insert at top (most recent first)
    if (evtSection.firstChild) {
      evtSection.insertBefore(el, evtSection.firstChild);
    } else {
      evtSection.appendChild(el);
    }
  }

  async function refreshInspector() {
    const inspEl = $('tr-inspector');
    if (!inspEl || !currentRoomId) return;

    let wiki = null;
    let candidates = [];
    let events = [];
    try {
      wiki = await ipcRenderer.invoke('team:getWiki', currentRoomId);
    } catch (e) {
      console.warn('[TeamRoom] getWiki failed:', e.message);
    }
    try {
      candidates = await ipcRenderer.invoke('team:getWikiCandidates', currentRoomId) || [];
    } catch (e) { /* ignore if command not available */ }
    try {
      events = await ipcRenderer.invoke('team:getEvents', currentRoomId, 30);
    } catch (e) {
      console.warn('[TeamRoom] getEvents (inspector) failed:', e.message);
    }

    inspEl.innerHTML = '';

    // Wiki candidates (pending approval) section
    if (candidates.length > 0) {
      const candSection = document.createElement('div');
      candSection.className = 'tr-insp-section';
      const candTitle = document.createElement('div');
      candTitle.className = 'tr-insp-title tr-insp-title-pending';
      candTitle.textContent = `待审批 (${candidates.length})`;
      candSection.appendChild(candTitle);

      for (const item of candidates) {
        const el = document.createElement('div');
        el.className = 'tr-wiki-candidate';
        el.innerHTML = `
          <div class="tr-wiki-item-title">${esc(item.what || '')}</div>
          <div class="tr-wiki-item-body">${esc(item.why || '')}</div>
          <div class="tr-wiki-candidate-actions">
            <button class="tr-approve-btn" data-id="${esc(item.id)}" title="采纳">✓</button>
            <button class="tr-reject-btn" data-id="${esc(item.id)}" title="拒绝">✗</button>
            <span class="tr-wiki-item-imp">imp ${item.importance || '?'}</span>
          </div>
        `;
        candSection.appendChild(el);
      }

      candSection.addEventListener('click', async (e) => {
        const approveBtn = e.target.closest('.tr-approve-btn');
        const rejectBtn = e.target.closest('.tr-reject-btn');
        if (approveBtn) {
          const fid = approveBtn.dataset.id;
          try {
            await ipcRenderer.invoke('team:approveWiki', fid);
            await refreshInspector();
          } catch (err) { console.error('approve failed:', err); }
        } else if (rejectBtn) {
          const fid = rejectBtn.dataset.id;
          try {
            await ipcRenderer.invoke('team:rejectWiki', fid);
            await refreshInspector();
          } catch (err) { console.error('reject failed:', err); }
        }
      });

      inspEl.appendChild(candSection);
    }

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
    evtSection.className = 'tr-insp-section tr-insp-events';
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

  // --- Streaming Event Handler ---

  /** Map of char_id -> {el, timer, startTs} for per-character thinking indicators */
  const thinkingMap = {};

  function handleStreamEvent(payload) {
    // payload comes from main.js: { type: 'event', data: {...} } or { type: 'stdout', data: '...' }
    const evt = payload.type === 'event' ? payload.data : null;
    if (!evt) return;

    const threadEl = $('tr-thread');
    if (!threadEl) return;

    const evtType = evt.type;
    const actorId = evt.actor || 'system';
    const name = evt.name || charName(actorId);

    if (evtType === 'thinking') {
      if (streamRound === 0) {
        streamRound = 1;
        _insertRoundSeparator(threadEl, 1);
      } else if (streamRoundActors.has(actorId)) {
        streamRound++;
        streamRoundActors.clear();
        _insertRoundSeparator(threadEl, streamRound);
      }
      const ch = characters[actorId];
      const cli = ch ? (ch.backing_cli || actorId) : actorId;
      const colorCls = avatarColor(cli);
      const av = initials(name, actorId);

      const el = document.createElement('div');
      el.className = `tr-msg ${colorCls}`;
      el.setAttribute('data-thinking', actorId);
      el.innerHTML = `
        <div class="tr-msg-avatar">${esc(av)}</div>
        <div class="tr-msg-body">
          <div class="tr-msg-meta"><span class="tr-msg-name">${esc(name)}</span></div>
          <div class="tr-thinking"><span class="tr-thinking-text">思考中</span><span class="tr-thinking-elapsed"></span></div>
        </div>
      `;
      threadEl.appendChild(el);

      const startTs = Date.now();
      const elapsedSpan = el.querySelector('.tr-thinking-elapsed');
      const timer = setInterval(() => {
        const sec = Math.floor((Date.now() - startTs) / 1000);
        if (elapsedSpan) elapsedSpan.textContent = ` ${sec}s`;
      }, 1000);

      thinkingMap[actorId] = { el, timer, startTs };
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    else if (evtType === 'checkpoint') {
      // Do NOT remove the thinking indicator — the character is still working.
      appendCheckpoint(threadEl, {
        actor: actorId,
        name,
        content: evt.content || '',
        ts: evt.ts,
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    else if (evtType === 'tool_use') {
      appendToolUse(threadEl, {
        actor: actorId,
        name,
        tool: evt.tool || '',
        input: evt.input || {},
        ts: evt.ts,
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // text_delta：Claude --include-partial-messages 的字级增量，附到 thinking 卡片下做 live preview
    else if (evtType === 'text_delta') {
      const entry = thinkingMap[actorId];
      if (entry && entry.el) {
        let live = entry.el.querySelector('.tr-live-text');
        if (!live) {
          live = document.createElement('div');
          live.className = 'tr-live-text';
          live.style.cssText = 'color:var(--text-primary);margin-top:6px;white-space:pre-wrap;font-size:13px;opacity:0.85';
          const body = entry.el.querySelector('.tr-msg-body');
          if (body) body.appendChild(live);
        }
        live.textContent += (evt.text || '');
        threadEl.scrollTop = threadEl.scrollHeight;
      }
    }

    // thinking_delta：Claude extended thinking 的思考链增量，灰色 italic 显示
    else if (evtType === 'thinking_delta') {
      const entry = thinkingMap[actorId];
      if (entry && entry.el) {
        let live = entry.el.querySelector('.tr-live-thinking');
        if (!live) {
          live = document.createElement('div');
          live.className = 'tr-live-thinking';
          live.style.cssText = 'color:var(--text-secondary);font-style:italic;margin-top:6px;white-space:pre-wrap;font-size:12px';
          const body = entry.el.querySelector('.tr-msg-body');
          if (body) body.appendChild(live);
        }
        live.textContent += (evt.text || '');
        threadEl.scrollTop = threadEl.scrollHeight;
      }
    }

    // degraded：prompt 超预算自动降级（TRUNCATED / PATTERN_ONLY / ABORT）
    else if (evtType === 'degraded') {
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      const level = evt.level || 'truncated';
      const tokens = evt.estimated_tokens;
      const label = level === 'abort' ? '中止' : level === 'pattern_only' ? '仅模式' : '裁剪';
      const tokInfo = tokens ? ` (~${tokens}t)` : '';
      note.textContent = `\u{1F4C9} ${name} 上下文降级: ${label}${tokInfo}`;
      threadEl.appendChild(note);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // retry：自愈重试（session_invalid / timeout / transient_exit1）
    else if (evtType === 'retry') {
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      const reason = evt.reason || 'unknown';
      note.textContent = `\u{1F501} ${name} 自愈重试 (${reason})`;
      threadEl.appendChild(note);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // rate_limit：Claude 限流事件（不中断对话）
    else if (evtType === 'rate_limit') {
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      note.textContent = `\u26A0\uFE0F ${name} 触发限流`;
      threadEl.appendChild(note);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // compact_boundary：Claude 自动上下文压缩
    else if (evtType === 'compact_boundary') {
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      note.textContent = `\u267B\uFE0F ${name} 上下文已压缩`;
      threadEl.appendChild(note);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // web_search：Codex web_search 事件
    else if (evtType === 'web_search') {
      appendCheckpoint(threadEl, {
        actor: actorId,
        name,
        content: `\u{1F50D} 搜索: ${(evt.query || '').slice(0, 120)}`,
        ts: evt.ts,
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    else if (evtType === 'message') {
      if (thinkingMap[actorId]) {
        clearInterval(thinkingMap[actorId].timer);
        thinkingMap[actorId].el.remove();
        delete thinkingMap[actorId];
      }
      // Append real message
      appendMessage(threadEl, {
        kind: 'message', actor: actorId,
        content: evt.content || '', ts: evt.ts,
      });
      threadEl.scrollTop = threadEl.scrollHeight;
      streamRoundActors.add(actorId);
    }

    else if (evtType === 'pass') {
      if (thinkingMap[actorId]) {
        clearInterval(thinkingMap[actorId].timer);
        thinkingMap[actorId].el.remove();
        delete thinkingMap[actorId];
      }
      const label = document.createElement('div');
      label.className = 'tr-round-label';
      label.textContent = `${name}: PASS`;
      threadEl.appendChild(label);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    else if (evtType === 'error') {
      if (thinkingMap[actorId]) {
        clearInterval(thinkingMap[actorId].timer);
        thinkingMap[actorId].el.remove();
        delete thinkingMap[actorId];
      }
      const note = document.createElement('div');
      note.className = 'tr-system-note';
      note.textContent = evt.content || `${name} 错误`;
      threadEl.appendChild(note);
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    else if (evtType === 'converged') {
      for (const [id, entry] of Object.entries(thinkingMap)) {
        clearInterval(entry.timer);
        entry.el.remove();
        delete thinkingMap[id];
      }
      const label = document.createElement('div');
      label.className = 'tr-round-label';
      label.textContent = `[收敛] depth=${evt.depth}/${evt.max_depth}`;
      threadEl.appendChild(label);
      threadEl.scrollTop = threadEl.scrollHeight;

      // Refresh inspector after convergence (events are now in DB)
      refreshInspector();
      streamRound = 0;
      streamRoundActors.clear();
    }

    else if (evtType === 'extraction_done') {
      pendingExtractionStats = evt.stats || null;
    }

    else if (evtType === 'evolution_done') {
      _appendEvolutionSummary(threadEl, pendingExtractionStats, evt.stats || {});
      pendingExtractionStats = null;
    }

    _trimThread(threadEl);

    // Update recent events in inspector for every event
    appendInspectorEvent(evt);
  }

  // --- Send Message ---

  let sending = false;

  async function sendMessage() {
    if (sending) return;
    sending = true;
    const inputBox = $('tr-input-box');
    const sendBtn = $('tr-send-btn');
    if (!inputBox || !currentRoomId) { sending = false; return; }

    const text = inputBox.innerText.trim();
    if (!text) { sending = false; return; }

    // Clear input
    inputBox.innerText = '';

    // Show user message immediately
    const threadEl = $('tr-thread');
    if (threadEl) {
      appendMessage(threadEl, {
        kind: 'message', actor: 'user',
        content: text, ts: Math.floor(Date.now() / 1000),
      });
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    // Disable send while processing
    if (sendBtn) sendBtn.disabled = true;

    try {
      await ipcRenderer.invoke('team:ask', currentRoomId, text);
    } catch (e) {
      console.error('[TeamRoom] askTeam failed:', e.message);
      if (threadEl) {
        const errNote = document.createElement('div');
        errNote.className = 'tr-system-note';
        errNote.textContent = `错误: ${e.message}`;
        threadEl.appendChild(errNote);
      }
    } finally {
      sending = false;
      for (const [id, entry] of Object.entries(thinkingMap)) {
        clearInterval(entry.timer);
        entry.el.remove();
        delete thinkingMap[id];
      }
      if (sendBtn) sendBtn.disabled = false;
      if (inputBox) inputBox.focus();

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
