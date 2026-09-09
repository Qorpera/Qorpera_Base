const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("companyComputer", {
	request: input => ipcRenderer.invoke("company-computer:member", input),
	viewRequest: input => ipcRenderer.invoke("company-computer:view", input),
	browserRequest: input => ipcRenderer.invoke("company-computer:browser", input),
});
