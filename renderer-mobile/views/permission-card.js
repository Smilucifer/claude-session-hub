export function mountPermissionCard(slot, evt, onDecide) {
  slot.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'perm-card';
  const cmd = formatToolInput(evt.toolName, evt.toolInput);
  card.innerHTML = `
    <div class="perm-head">Claude 要执行</div>
    <div class="perm-tool">${escapeHtml(evt.toolName || '(unknown)')}</div>
    <pre class="perm-cmd">${escapeHtml(cmd)}</pre>
    <div class="perm-actions">
      <button class="perm-deny">拒绝 (2)</button>
      <button class="perm-allow">允许 (1)</button>
    </div>
  `;
  card.querySelector('.perm-allow').addEventListener('click', () => { onDecide('allow'); card.remove(); });
  card.querySelector('.perm-deny').addEventListener('click', () => { onDecide('deny'); card.remove(); });
  slot.appendChild(card);
  setTimeout(() => card.classList.add('visible'), 10);
  setTimeout(() => { if (card.parentNode) card.remove(); }, 30000);
}

function formatToolInput(tool, input) {
  if (!input) return '';
  if (tool === 'Bash') return input.command || JSON.stringify(input);
  if (tool === 'Edit' || tool === 'Write') return `${input.file_path || ''}\n${(input.new_string || input.content || '').slice(0, 200)}`;
  return JSON.stringify(input, null, 2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
