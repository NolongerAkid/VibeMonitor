const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibeMonitor", {
  onSessionsUpdate: (cb) => ipcRenderer.on("sessions-update", (_, data) => cb(data)),
  onPanelState: (cb) => ipcRenderer.on("panel-state", (_, expanded) => cb(expanded)),
  togglePanel: () => ipcRenderer.send("toggle-panel"),
  expandPanel: () => ipcRenderer.send("expand-panel"),
  collapsePanel: () => ipcRenderer.send("collapse-panel"),
  approvalAction: (sessionId, action) => ipcRenderer.send("approval-action", { sessionId, action }),
  jumpToSession: (sessionId) => ipcRenderer.send("jump-to-session", { sessionId }),
  renameSession: (sessionId, name) => ipcRenderer.send("rename-session", { sessionId, name }),
  markRead: (sessionId) => ipcRenderer.send("mark-read", { sessionId }),
  newSession: () => ipcRenderer.send("new-session"),
  getSessions: () => ipcRenderer.invoke("get-sessions"),
});
