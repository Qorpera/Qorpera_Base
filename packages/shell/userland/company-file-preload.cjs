const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companyFile", {
	request: (input) => ipcRenderer.invoke("company-file:governed", input),
});
