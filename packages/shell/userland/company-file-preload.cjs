const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companyFile", {
	request: (input) => ipcRenderer.invoke("company-file:governed", input),
	selectPresence: (paths) => ipcRenderer.invoke("company-file:presence-select", paths),
	onPresence: (callback) => {
		const listener = (_event, view) => callback(view);
		ipcRenderer.on("company-file:presence", listener);
		return () => ipcRenderer.removeListener("company-file:presence", listener);
	},
});
