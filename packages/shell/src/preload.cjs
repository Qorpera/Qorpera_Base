// Preload bridge — the renderer's entire capability surface. CJS on purpose
// (sandboxed preload); kept tiny: companies and one RPC content pipe. Durable
// company/session state comes from the backend read model.
const { contextBridge, ipcRenderer } = require("electron");

// The preload learns attachment only from kernel-confirmed replies, so the
// fixed renderer never receives an ambient "current child" capability.
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
async function createStaff(input) {
	const result = await ipcRenderer.invoke("staff:create", input);
	if (result?.ok && typeof result.sessionFile === "string") activeTrailFile = result.sessionFile;
	return result;
}
async function bootstrapStaff(input) {
	const result = await ipcRenderer.invoke("staff:bootstrap", input);
	const first = result?.ok && Array.isArray(result.staff) ? result.staff[0] : undefined;
	if (typeof first?.sessionFile === "string") activeTrailFile = first.sessionFile;
	return result;
}
async function openStaff(staffAgentId) {
	const result = await ipcRenderer.invoke("staff:open", staffAgentId);
	if (result?.ok && typeof result.sessionFile === "string") activeTrailFile = result.sessionFile;
	return result;
}

contextBridge.exposeInMainWorld("qorpera", {
	intelligenceInfo: () => ipcRenderer.invoke("intelligence:info"),
	configureIntelligence: (providerId) => ipcRenderer.invoke("intelligence:configure", providerId),
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
	staffCatalog: () => ipcRenderer.invoke("staff:catalog"),
	staffCreate: createStaff,
	staffBootstrap: bootstrapStaff,
	staffUpdate: (staffAgentId, update) => ipcRenderer.invoke("staff:update", staffAgentId, update),
	staffOpen: openStaff,
	staffIntroReady: (staffAgentId, sessionFile, retry = false) =>
		ipcRenderer.invoke("staff:intro-ready", staffAgentId, sessionFile, retry),
	showHub: () => ipcRenderer.invoke("hub:show"),
	settingsInfo: () => ipcRenderer.invoke("settings:info"),
	connectAccount: (connectionId) => ipcRenderer.invoke("connection:connect", connectionId),
	cancelConnection: (connectionId) => ipcRenderer.invoke("connection:cancel", connectionId),
	connectionRequests: () => ipcRenderer.invoke("connection-requests:list"),
	beginConnectionRequest: (identity) => ipcRenderer.invoke("connection-request:begin", identity),
	onConnectionRequestsChanged: (handler) =>
		ipcRenderer.on("connection-requests-changed", (_event, request) => handler(request)),
	appInfo,
	authorizedBackendPost: (path, body) => ipcRenderer.invoke("backend:authorized-post", path, body),
	updateInstall: () => ipcRenderer.invoke("update:install"),
	onUpdateStatus: (handler) => ipcRenderer.on("update-status", (_event, text) => handler(text)),
	onUpdateReady: (handler) => ipcRenderer.on("update-ready", (_event, version) => handler(version)),
	onConnectionStatus: (handler) => ipcRenderer.on("connection-status", (_event, status) => handler(status)),
	onOpenCompany: (handler) => ipcRenderer.on("open-company", (_event, root) => handler(root)),
	rpcSend: (frame, expectedTrailFile) =>
		ipcRenderer.invoke("rpc:send", frame, expectedTrailFile ?? activeTrailFile),
	onRpcEvent: (handler) => ipcRenderer.on("rpc-event", (_event, frame) => handler(frame)),
	onRpcLog: (handler) => ipcRenderer.on("rpc-log", (_event, line) => handler(line)),
	onRpcExit: (handler) => ipcRenderer.on("rpc-exit", (_event, code) => handler(code)),
});
