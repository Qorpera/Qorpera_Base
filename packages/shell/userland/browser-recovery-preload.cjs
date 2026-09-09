const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("browserRecovery", {request: input => ipcRenderer.invoke("browser-recovery:member", input)});
