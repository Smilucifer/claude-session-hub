const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hubAPI', {
  createSession: (kind) => ipcRenderer.invoke('create-session', kind),
  closeSession: (sessionId) => ipcRenderer.invoke('close-session', sessionId),
  renameSession: (sessionId, title) => ipcRenderer.invoke('rename-session', { sessionId, title }),
  getSessions: () => ipcRenderer.invoke('get-sessions'),

  sendInput: (sessionId, data) => ipcRenderer.send('terminal-input', { sessionId, data }),
  resizeTerminal: (sessionId, cols, rows) => ipcRenderer.send('terminal-resize', { sessionId, cols, rows }),
  focusSession: (sessionId) => ipcRenderer.send('focus-session', { sessionId }),
  markRead: (sessionId) => ipcRenderer.send('mark-read', { sessionId }),

  onTerminalData: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('terminal-data', handler);
    return () => ipcRenderer.removeListener('terminal-data', handler);
  },
  onSessionCreated: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-created', handler);
    return () => ipcRenderer.removeListener('session-created', handler);
  },
  onSessionClosed: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-closed', handler);
    return () => ipcRenderer.removeListener('session-closed', handler);
  },
  onSessionUpdated: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('session-updated', handler);
    return () => ipcRenderer.removeListener('session-updated', handler);
  },
});
