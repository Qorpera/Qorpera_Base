// Preload bridge — the renderer's entire capability surface. CJS on purpose
// (sandboxed preload); kept tiny: companies and one RPC content pipe. Durable
// company/session state comes from the backend read model.
const { contextBridge, ipcRenderer } = require("electron");

// Platform-specific titlebar geometry and the persisted window material must
// be available before the renderer paints.
const sidebarTranslucency = process.argv.includes("--qorpera-sidebar-translucency=on") ? "on" : "off";
function syncWindowControlsVisibility() {
	if (process.platform !== "darwin" || !document.documentElement) return;
	document.documentElement.dataset.windowControls =
		navigator.windowControlsOverlay?.visible === false ? "hidden" : "visible";
}
function applyInitialShellAppearance() {
	document.documentElement.dataset.platform = process.platform;
	document.documentElement.dataset.sidebarTranslucency = sidebarTranslucency;
	syncWindowControlsVisibility();
}
if (document.documentElement) applyInitialShellAppearance();
else {
	window.addEventListener(
		"DOMContentLoaded",
		applyInitialShellAppearance,
		{ once: true },
	);
}
navigator.windowControlsOverlay?.addEventListener("geometrychange", syncWindowControlsVisibility);

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
	submitFeedback: (input) => ipcRenderer.invoke("feedback:submit", input),
	onAccountStatus: (handler) => ipcRenderer.on("account-status", (_event, message) => handler(message)),
	intelligenceInfo: () => ipcRenderer.invoke("intelligence:info"),
	configureIntelligence: (providerId) => ipcRenderer.invoke("intelligence:configure", providerId),
	disconnectIntelligence: () => ipcRenderer.invoke("intelligence:sign-out"),
	listCompanies: () => ipcRenderer.invoke("companies:list"),
	removeCompany: (root) => ipcRenderer.invoke("company:remove", root),
	leaveCloudProfile: (profileId, name) => ipcRenderer.invoke("profile:leave-cloud", profileId, name),
	deleteCloudProfile: (profileId, name) => ipcRenderer.invoke("profile:delete-cloud", profileId, name),
	acceptCloudInvitation: (invitationId) => ipcRenderer.invoke("profile:accept-invitation", invitationId),
	declineCloudInvitation: (invitationId) => ipcRenderer.invoke("profile:decline-invitation", invitationId),
	listCloudInvitations: () => ipcRenderer.invoke("profile:list-invitations"),
	friendsList: () => ipcRenderer.invoke("friends:list"),
	friendsRequest: (email) => ipcRenderer.invoke("friends:request", email),
	friendsRespond: (userId, accept) => ipcRenderer.invoke("friends:respond", userId, accept),
	friendsRemove: (userId) => ipcRenderer.invoke("friends:remove", userId),
	materializeCloudProfile: (profileId) => ipcRenderer.invoke("profile:materialize-cloud", profileId),
	migrateLocalCompany: (root) => ipcRenderer.invoke("profile:migrate-local", root),
	inviteProfileMember: (value) => ipcRenderer.invoke("profile-team:invite", value),
	cancelProfileInvitation: (invitationId) =>
		ipcRenderer.invoke("profile-team:cancel-invitation", invitationId),
	retryProfileInvitationDelivery: (invitationId) =>
		ipcRenderer.invoke("profile-team:retry-invitation-delivery", invitationId),
	updateProfileMemberRole: (memberUserId, role) =>
		ipcRenderer.invoke("profile-team:update-role", memberUserId, role),
	removeProfileMember: (memberUserId) => ipcRenderer.invoke("profile-team:remove-member", memberUserId),
	openCompany: (root) => ipcRenderer.invoke("company:open", root),
	pendingCompanyCreation: () => ipcRenderer.invoke("company:pending-creation"),
	newCompany: (name, companyIcon, clientCreationId) =>
		ipcRenderer.invoke("company:new", name, companyIcon, clientCreationId),
	setCompanyIcon: (companyIcon) => ipcRenderer.invoke("company:set-icon", companyIcon),
	openCompanyFile: () => ipcRenderer.invoke("company-file:open"),
	openCompanyFileConflictRemote: () => ipcRenderer.invoke("company-file:open-conflict-remote"),
	resolveCompanyFileConflict: (resolution) => ipcRenderer.invoke("company-file:resolve-conflict", resolution),
	openCompanyFileReview: (checkoutId, proposalHead, expectedCanonicalHead) =>
		ipcRenderer.invoke("company-file:open-review", checkoutId, proposalHead, expectedCanonicalHead),
	acceptCompanyFileReview: (checkoutId, proposalHead, expectedCanonicalHead) =>
		ipcRenderer.invoke("company-file:accept-review", checkoutId, proposalHead, expectedCanonicalHead),
	rejectCompanyFileReview: (checkoutId, proposalHead, expectedCanonicalHead) =>
		ipcRenderer.invoke("company-file:reject-review", checkoutId, proposalHead, expectedCanonicalHead),
	openCompanyProposal: (proposalId, proposalSnapshotId) =>
		ipcRenderer.invoke("company-file:open-proposal", proposalId, proposalSnapshotId),
	acceptCompanyProposal: (proposalId, proposalSnapshotId) =>
		ipcRenderer.invoke("company-file:accept-proposal", proposalId, proposalSnapshotId),
	retryCompanyProposalReview: (proposalId, proposalSnapshotId, assignmentId, proposalRevision) =>
		ipcRenderer.invoke(
			"company-file:retry-proposal-review",
			proposalId,
			proposalSnapshotId,
			assignmentId,
			proposalRevision,
		),
	rejectCompanyProposal: (proposalId, proposalSnapshotId) =>
		ipcRenderer.invoke("company-file:reject-proposal", proposalId, proposalSnapshotId),
	commentCompanyProposal: (proposalId, body, clientCommentId) =>
		ipcRenderer.invoke("company-file:comment-proposal", proposalId, body, clientCommentId),
	companyProposalComments: (proposalId) => ipcRenderer.invoke("company-file:proposal-comments", proposalId),
	stagePromptSend: (id, frame) => ipcRenderer.invoke("prompt-send:stage", id, frame),
	pendingPromptSend: () => ipcRenderer.invoke("prompt-send:pending"),
	acknowledgePromptSend: (id) => ipcRenderer.invoke("prompt-send:ack", id),
	resolveSessionRecovery: (staffAgentId, turnId, resolution) =>
		ipcRenderer.invoke("staff-session:resolve-recovery", staffAgentId, turnId, resolution),
	resolveExecutionRecovery: (staffAgentId, runId, action) =>
		ipcRenderer.invoke("staff-session:resolve-execution-recovery", staffAgentId, runId, action),
	resolveOperationRecovery: (staffAgentId, operationId, resolution) =>
		ipcRenderer.invoke("staff-session:resolve-operation", staffAgentId, operationId, resolution),
	resolveRunOperationRecovery: (staffAgentId, operationId, resolution) =>
		ipcRenderer.invoke("staff-session:resolve-run-operation", staffAgentId, operationId, resolution),
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
	setSidebarTranslucency: (enabled) => ipcRenderer.invoke("settings:sidebar-translucency", enabled),
	onSidebarTranslucency: (handler) => ipcRenderer.on("sidebar-translucency", (_event, enabled) => handler(enabled)),
	settingsInfo: () => ipcRenderer.invoke("settings:info"),
	setBackgroundEnabled: (enabled) => ipcRenderer.invoke("settings:background", enabled),
	setLocalExecution: (permission) => ipcRenderer.invoke("settings:local-execution", permission),
	nativeExecutionInfo: () => ipcRenderer.invoke("native-execution:info"),
	createMemberComputeIdentity: () => ipcRenderer.invoke("native-execution:create-member-identity"),
	beginNativeProviderLogin: (provider) => ipcRenderer.invoke("native-execution:begin-login", provider),
	createMemberExecutionSponsor: (providerConnectionId, providerConnectionVersion) =>
		ipcRenderer.invoke(
			"native-execution:create-member-sponsor",
			providerConnectionId,
			providerConnectionVersion,
		),
	revokeNativeProviderConnection: (providerConnectionId) =>
		ipcRenderer.invoke("native-execution:revoke", providerConnectionId),
	nativeSessionTurnProvenance: (staffAgentId) =>
		ipcRenderer.invoke("native-execution:session-provenance", staffAgentId),
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
	updateState: () => ipcRenderer.invoke("update:state"),
	updateCheck: () => ipcRenderer.invoke("update:check"),
	updateInstall: () => ipcRenderer.invoke("update:install"),
	onUpdateState: (handler) => ipcRenderer.on("update-state", (_event, state) => handler(state)),
	onUpdateStatus: (handler) => ipcRenderer.on("update-status", (_event, text) => handler(text)),
	onUpdateReady: (handler) => ipcRenderer.on("update-ready", (_event, version) => handler(version)),
	onStaffSessionRefreshed: (handler) =>
		ipcRenderer.on("staff-session-refreshed", (_event, payload) => handler(payload)),
	onStaffSessionQueue: (handler) =>
		ipcRenderer.on("staff-session-queue", (_event, payload) => handler(payload)),
	onProfileAccessChanged: (handler) =>
		ipcRenderer.on("profile-access-changed", (_event, access) => handler(access)),
	presenceThread: (staffAgentId) => ipcRenderer.send("presence:thread", staffAgentId ?? null),
	presenceTyping: (staffAgentId) => ipcRenderer.send("presence:typing", staffAgentId),
	onPresenceMembers: (handler) => ipcRenderer.on("presence-members", (_event, members) => handler(members)),
	onPresenceTyping: (handler) => ipcRenderer.on("presence-typing", (_event, event) => handler(event)),
	onPresenceActivity: (handler) => ipcRenderer.on("presence-activity", (_event, event) => handler(event)),
	onRunnerActivity: (handler) => ipcRenderer.on("runner-activity", (_event, activity) => handler(activity)),
	onConnectionStatus: (handler) => ipcRenderer.on("connection-status", (_event, status) => handler(status)),
	onOpenCompany: (handler) => ipcRenderer.on("open-company", (_event, root) => handler(root)),
	rpcSend: (frame, expectedTrailFile) =>
		ipcRenderer.invoke("rpc:send", frame, expectedTrailFile ?? activeTrailFile),
	onRpcEvent: (handler) => ipcRenderer.on("rpc-event", (_event, frame) => handler(frame)),
	onRpcLog: (handler) => ipcRenderer.on("rpc-log", (_event, line) => handler(line)),
	onRpcExit: (handler) => ipcRenderer.on("rpc-exit", (_event, code) => handler(code)),
});
