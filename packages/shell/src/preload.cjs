// Preload bridge — the renderer's entire capability surface. CJS on purpose
// (sandboxed preload); kept tiny: companies, one RPC pipe, nothing else.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qorpera", {
	listCompanies: () => ipcRenderer.invoke("companies:list"),
	openCompany: (root) => ipcRenderer.invoke("company:open", root),
	newCompany: (dir) => ipcRenderer.invoke("company:new", dir),
	closeCompany: () => ipcRenderer.invoke("company:close"),
	rpcSend: (frame) => ipcRenderer.invoke("rpc:send", frame),
	onRpcEvent: (handler) => ipcRenderer.on("rpc-event", (_event, frame) => handler(frame)),
	onRpcLog: (handler) => ipcRenderer.on("rpc-log", (_event, line) => handler(line)),
	onRpcExit: (handler) => ipcRenderer.on("rpc-exit", (_event, code) => handler(code)),
});
