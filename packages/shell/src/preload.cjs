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
	accountInfo: () => ipcRenderer.invoke("account:info"),
	accountSignIn: (input) =>
		ipcRenderer.invoke("account:sign-in", input, document.getElementById("accountRemember")?.checked === true),
	accountSignOut: () => ipcRenderer.invoke("account:sign-out"),
	openFeedback: () => ipcRenderer.invoke("feedback:open"),
	onAccountStatus: (handler) => ipcRenderer.on("account-status", (_event, message) => handler(message)),
	intelligenceInfo: () => ipcRenderer.invoke("intelligence:info"),
	configureIntelligence: (providerId) => ipcRenderer.invoke("intelligence:configure", providerId),
	disconnectIntelligence: () => ipcRenderer.invoke("intelligence:sign-out"),
	listCompanies: () => ipcRenderer.invoke("companies:list"),
	removeCompany: (root) => ipcRenderer.invoke("company:remove", root),
	acceptCloudInvitation: (invitationId) => ipcRenderer.invoke("profile:accept-invitation", invitationId),
	declineCloudInvitation: (invitationId) => ipcRenderer.invoke("profile:decline-invitation", invitationId),
	materializeCloudProfile: (profileId) => ipcRenderer.invoke("profile:materialize-cloud", profileId),
	cloudProfileOptions: () => ipcRenderer.invoke("profile:cloud-options"),
	enableCloudProfile: () => ipcRenderer.invoke("profile:enable-cloud"),
	attachCloudProfile: (profileId) => ipcRenderer.invoke("profile:attach-cloud", profileId),
	inviteProfileMember: (value) => ipcRenderer.invoke("profile-team:invite", value),
	cancelProfileInvitation: (invitationId) =>
		ipcRenderer.invoke("profile-team:cancel-invitation", invitationId),
	retryProfileInvitationDelivery: (invitationId) =>
		ipcRenderer.invoke("profile-team:retry-invitation-delivery", invitationId),
	updateProfileMemberRole: (memberUserId, role) =>
		ipcRenderer.invoke("profile-team:update-role", memberUserId, role),
	removeProfileMember: (memberUserId) => ipcRenderer.invoke("profile-team:remove-member", memberUserId),
	openCompany: (root) => ipcRenderer.invoke("company:open", root),
	newCompany: (dir, companyIcon, placement) => ipcRenderer.invoke("company:new", dir, companyIcon, placement),
	integrateCompany: (dir, from) => ipcRenderer.invoke("company:integrate", dir, from),
	addProduct: (product, from) => ipcRenderer.invoke("company:product-add", product, from),
	chooseProductSource: () => ipcRenderer.invoke("company:product-source-choose"),
	createScheduledJob: (input) => ipcRenderer.invoke("company:scheduled-job-create", input),
	updateScheduledJob: (id, input) => ipcRenderer.invoke("company:scheduled-job-update", id, input),
	deleteScheduledJob: (id) => ipcRenderer.invoke("company:scheduled-job-delete", id),
	runScheduledJob: (id) => ipcRenderer.invoke("company:scheduled-job-run", id),
	cloudCompanyWorkspaces: () => ipcRenderer.invoke("company-cloud:workspaces"),
	previewCloudCompanyWorkspace: (workspaceId) => ipcRenderer.invoke("company-cloud:preview", workspaceId),
	inspectCloudCompanyMerge: (workspaceId) => ipcRenderer.invoke("company-cloud:inspect-merge", workspaceId),
	mergeCloudCompanyWorkspace: (workspaceId) => ipcRenderer.invoke("company-cloud:merge", workspaceId),
	closeCompany: () => ipcRenderer.invoke("company:close"),
	openChat,
	staffCatalog: () => ipcRenderer.invoke("staff:catalog"),
	staffCreate: createStaff,
	staffBootstrap: bootstrapStaff,
	staffUpdate: (staffAgentId, update) => ipcRenderer.invoke("staff:update", staffAgentId, update),
	staffArchive: (staffAgentId) => ipcRenderer.invoke("staff:archive", staffAgentId),
	staffDelete: (staffAgentId) => ipcRenderer.invoke("staff:delete", staffAgentId),
	staffRestore: (staffAgentId) => ipcRenderer.invoke("staff:restore", staffAgentId),
	staffOpen: openStaff,
	copyStaffConversationId: (staffAgentId) => ipcRenderer.invoke("staff:copy-conversation-id", staffAgentId),
	staffIntroReady: (staffAgentId, sessionFile, retry = false) =>
		ipcRenderer.invoke("staff:intro-ready", staffAgentId, sessionFile, retry),
	roomCreate: (input) => ipcRenderer.invoke("room:create", input),
	roomOpen: (roomId) => ipcRenderer.invoke("room:open", roomId),
	roomSend: (roomId, input) => ipcRenderer.invoke("room:send", roomId, input),
	roomUpdate: (roomId, input) => ipcRenderer.invoke("room:update", roomId, input),
	roomArchive: (roomId) => ipcRenderer.invoke("room:archive", roomId),
	roomRestore: (roomId) => ipcRenderer.invoke("room:restore", roomId),
	onRoomEvent: (handler) => ipcRenderer.on("room-event", (_event, value) => handler(value)),
	showHub: () => ipcRenderer.invoke("hub:show"),
	setSettingsOverlayActive: (active) => ipcRenderer.send("settings:overlay", active),
	settingsInfo: () => ipcRenderer.invoke("settings:info"),
	setBackgroundEnabled: (enabled) => ipcRenderer.invoke("settings:background", enabled),
	setLocalExecution: (permission) => ipcRenderer.invoke("settings:local-execution", permission),
	modelAccountUsage: () => ipcRenderer.invoke("model-accounts:usage"),
	connectAccount: (connectionId) => ipcRenderer.invoke("connection:connect", connectionId),
	disconnectAccount: (connectionId, accountId) =>
		ipcRenderer.invoke("connection:disconnect", connectionId, accountId),
	cancelConnection: (connectionId) => ipcRenderer.invoke("connection:cancel", connectionId),
	connectionRequests: () => ipcRenderer.invoke("connection-requests:list"),
	selectConnectionRequest: (identity, selection) =>
		ipcRenderer.invoke("connection-request:select", identity, selection),
	prepareConnectionRequest: (identity) => ipcRenderer.invoke("connection-request:prepare", identity),
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
	onCloudCompanyInbox: (handler) => ipcRenderer.on("cloud-company-inbox", (_event, inbox) => handler(inbox)),
	rpcSend: (frame, expectedTrailFile) =>
		ipcRenderer.invoke("rpc:send", frame, expectedTrailFile ?? activeTrailFile),
	onRpcEvent: (handler) => ipcRenderer.on("rpc-event", (_event, frame) => handler(frame)),
	onRpcLog: (handler) => ipcRenderer.on("rpc-log", (_event, line) => handler(line)),
	onRpcExit: (handler) => ipcRenderer.on("rpc-exit", (_event, code) => handler(code)),
});
