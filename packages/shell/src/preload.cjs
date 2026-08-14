// Preload bridge — the renderer's entire capability surface. CJS on purpose
// (sandboxed preload); kept tiny: companies and one RPC content pipe. Durable
// company/session state comes from the backend read model.
const { contextBridge, ipcRenderer } = require("electron");

// Compatibility for company-evolved userlands that predate explicit trail
// scoping. The preload learns attachment only from kernel-confirmed replies;
// old renderers therefore gain the same exact-session check without being
// handed an ambient "current child" capability.
let activeTrailFile;
async function appInfo() {
	const result = await ipcRenderer.invoke("app:info");
	if (typeof result?.activeCompany?.sessionFile === "string") {
		activeTrailFile = result.activeCompany.sessionFile;
	}
	return result;
}
async function openChat(sessionFile, department, worktree, sessionName) {
	const result = await ipcRenderer.invoke("chat:open", sessionFile, department, worktree, sessionName);
	if (result?.ok && typeof result.sessionFile === "string") activeTrailFile = result.sessionFile;
	return result;
}

contextBridge.exposeInMainWorld("qorpera", {
	listCompanies: () => ipcRenderer.invoke("companies:list"),
	openCompany: (root) => ipcRenderer.invoke("company:open", root),
	newCompany: (dir) => ipcRenderer.invoke("company:new", dir),
	integrateCompany: (dir, from) => ipcRenderer.invoke("company:integrate", dir, from),
	addProduct: (product, from) => ipcRenderer.invoke("company:product-add", product, from),
	chooseProductSource: () => ipcRenderer.invoke("company:product-source-choose"),
	createScheduledJob: (input) => ipcRenderer.invoke("company:scheduled-job-create", input),
	updateScheduledJob: (id, input) => ipcRenderer.invoke("company:scheduled-job-update", id, input),
	deleteScheduledJob: (id) => ipcRenderer.invoke("company:scheduled-job-delete", id),
	runScheduledJob: (id) => ipcRenderer.invoke("company:scheduled-job-run", id),
	closeCompany: () => ipcRenderer.invoke("company:close"),
	openChat,
	showHub: () => ipcRenderer.invoke("hub:show"),
	settingsInfo: () => ipcRenderer.invoke("settings:info"),
	appInfo,
	authorizedBackendPost: (path, body) => ipcRenderer.invoke("backend:authorized-post", path, body),
	setActiveApp: (app) => ipcRenderer.invoke("userland:set-active", app),
	restoreVersion: (id) => ipcRenderer.invoke("userland:restore", id),
	favoriteVersion: (id, favorite) => ipcRenderer.invoke("userland:favorite", id, favorite),
	mergeUserland: () => ipcRenderer.invoke("userland:merge"),
	chooseIcon: () => ipcRenderer.invoke("userland:set-icon"),
	onMergeDone: (handler) => ipcRenderer.on("merge-done", (_event, result) => handler(result)),
	updateCheck: () => ipcRenderer.invoke("update:check"),
	updateInstall: () => ipcRenderer.invoke("update:install"),
	onUpdateStatus: (handler) => ipcRenderer.on("update-status", (_event, text) => handler(text)),
	onUpdateReady: (handler) => ipcRenderer.on("update-ready", (_event, version) => handler(version)),
	onOpenCompany: (handler) => ipcRenderer.on("open-company", (_event, root) => handler(root)),
	rpcSend: (frame, expectedTrailFile) =>
		ipcRenderer.invoke("rpc:send", frame, expectedTrailFile ?? activeTrailFile),
	onRpcEvent: (handler) => ipcRenderer.on("rpc-event", (_event, frame) => handler(frame)),
	onRpcLog: (handler) => ipcRenderer.on("rpc-log", (_event, line) => handler(line)),
	onRpcExit: (handler) => ipcRenderer.on("rpc-exit", (_event, code) => handler(code)),
});
