# File Preview Panel — 设计文档

## 概述

在 Claude Session Hub 中内嵌文件预览能力，用户 Ctrl+Click 终端中的文件路径时，支持的格式（HTML/Markdown/图片）直接在 Hub 内预览，无需切出去打开外部程序。预览以独立标签页形式呈现，按需出现、手动关闭。

## 需求

- **触发方式**：被动触发 — 改造现有 Ctrl+Click，可预览格式在 Hub 内打开，其余仍走外部程序
- **支持格式**：HTML、Markdown（.md/.markdown）、图片（png/jpg/gif/webp/bmp）
- **面板位置**：独立标签页，与 terminal-panel 平级
- **生命周期**：Ctrl+Click 触发后标签出现，手动关闭（X 或 Esc）后标签消失，回到来源面板
- **安全模型**：内容基本可信（AI 生成），但加基本防护

## 技术方案：Electron webview 标签页

选择 webview 而非 iframe 或独立窗口，原因：
- HTML 渲染完整（JS/CSS 正常执行，本地资源引用可用）
- webview 天然进程隔离，不影响 Hub 主进程
- 内嵌在主窗口内，不需要切出去

## 改动文件

| 文件 | 改动 | 预估行数 |
|------|------|----------|
| `renderer/index.html` | 新增 preview-panel DOM 结构 | +15 |
| `renderer/renderer.js` | 预览逻辑 + 面板切换 + activate 分流 + Esc 监听 | +80, ~10 修改 |
| `renderer/styles.css` | preview-panel / markdown / image 样式 | +60 |
| `main.js` | webviewTag 配置 + read-file IPC | +15 |

零新增依赖。总计约 170 行新增 + 10 行修改。

## 架构

### 1. 整体流程

```
用户 Ctrl+Click 终端路径
  → registerLocalPathLinks activate 回调
  → 扩展名匹配 PREVIEW_PATH_RE?
    → 是：openPreviewPanel(filePath) — Hub 内渲染
    → 否：ipcRenderer.invoke('open-path') — 外部打开（原行为）
```

### 2. 新增正则

```js
const PREVIEW_PATH_RE = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp)(?![A-Za-z0-9])/gi;
```

与现有 ABS_PATH_RE / IMAGE_PATH_RE 同模式，扩展名范围覆盖三种文件类型。

### 3. preview-panel DOM

```html
<div class="preview-panel" id="preview-panel" style="display:none">
  <div class="preview-header">
    <span class="preview-title" id="preview-title">Preview</span>
    <div class="preview-header-actions">
      <button id="preview-open-external" title="在外部打开">↗</button>
      <button id="preview-close" title="关闭预览 (Esc)">✕</button>
    </div>
  </div>
  <div class="preview-body" id="preview-body"></div>
</div>
```

与 terminal-panel、team-room-panel、meeting-room-panel、memo-panel 平级，加入互斥面板切换体系。

### 4. 面板切换

- 打开预览 → 记住来源面板 ID，隐藏当前面板，显示 preview-panel
- 关闭预览 → 隐藏 preview-panel，恢复来源面板
- 侧栏会话高亮不变，预览不影响会话状态

### 5. 三种文件类型渲染

#### HTML → webview

```js
const wv = document.createElement('webview');
wv.src = `file:///${filePath.replace(/\\/g, '/')}`;
wv.style.cssText = 'width:100%;height:100%;border:none;';
previewBody.innerHTML = '';
previewBody.appendChild(wv);
```

- main.js 需要 `webPreferences: { webviewTag: true }`

#### Markdown → marked + dompurify

```js
const raw = await ipcRenderer.invoke('read-file', filePath);
const html = DOMPurify.sanitize(marked.parse(raw));
previewBody.innerHTML = `<div class="preview-markdown">${html}</div>`;
```

- 复用 Hub 已有的 marked + dompurify 依赖
- 新增 IPC `read-file`（见下方）

#### 图片 → img

```js
const fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
previewBody.innerHTML = `<img src="${fileUrl}" class="preview-image">`;
```

### 6. 新增 IPC

| 频道 | 方向 | 用途 |
|------|------|------|
| `read-file` | renderer → main | 读取本地文件内容（Markdown 用） |

安全约束：
- 只允许 `.md` / `.markdown` 扩展名
- 文件大小上限 5MB
- 路径必须是绝对路径

```js
ipcMain.handle('read-file', async (_e, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.md', '.markdown'].includes(ext)) return { error: 'unsupported' };
  const stat = await fs.promises.stat(filePath);
  if (stat.size > 5 * 1024 * 1024) return { error: 'too large' };
  return { content: await fs.promises.readFile(filePath, 'utf-8') };
});
```

### 7. CSP 与安全

- index.html CSP 不需要改 — webview 独立进程有自己的 CSP
- img-src 已包含 `file:`，图片预览可用
- main.js 仅新增 `webviewTag: true`

### 8. 样式

- preview-panel: flex:1 占满主区域，与 terminal-panel 同级布局
- preview-header: 高度 ~40px，`var(--bg-secondary)` 背景
- preview-body: `flex:1; overflow:auto;`，`var(--bg-primary)` 背景
- preview-markdown: `padding:24px 32px; max-width:800px; margin:0 auto;` 居中阅读，复用 team-room markdown 风格
- preview-image: 居中 `object-fit:contain`，深色背景衬托

### 9. 快捷键

| 快捷键 | 行为 |
|--------|------|
| Esc | 关闭预览面板，回到来源面板 |
| Ctrl+Click | 可预览格式 → Hub 内预览；其余 → 外部打开 |

## 不做的事

- 不加文件浏览器/拖拽（被动触发模式）
- 不加多标签预览（一次只预览一个文件，新预览替换旧内容）
- 不加编辑能力（纯只读预览）
- 不加 PDF/代码高亮（后续按需扩展）

## 可扩展性

预留扩展点：
- `PREVIEW_PATH_RE` 扩展名列表可增加新格式
- `openPreviewPanel` 内部按扩展名分流，新增格式只需加一个 `else if` 分支
- `read-file` IPC 的扩展名白名单可放宽
