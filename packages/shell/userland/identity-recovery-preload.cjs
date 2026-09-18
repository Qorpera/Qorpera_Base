"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("identityRecovery", Object.freeze({
  request: (input) => ipcRenderer.invoke("identity-recovery:member", input),
}));
