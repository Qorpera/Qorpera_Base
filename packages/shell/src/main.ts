/**
 * Qorpera Base shell — the fixed desktop app companies and their agents use.
 *
 * Fixed agent interface by construction: every company uses the same trusted
 * shell. Agent-authored artifacts are fixed, data-only scorecards, while
 * model runtimes are replaceable local processes attached to durable agents
 * and trails. A packaged shell uses Electron's Node runtime and needs no
 * system Node installation.
 *
 * Windows: one window per open thing — the hub, or one company.
 * Several companies run side by side, each with its own window, agent runtimes,
 * and backend; a company is never open in two windows at once.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type CompanyConnectorManifestRecord,
	companyConnectorMatchesRequest,
	companyConnectorSecretNames,
	readCompanyConnectorManifests,
} from "@qorpera/company/company-connectors";
import {
	appendCompanyRoomMessage,
	archiveCompanyRoom,
	type CompanyRoom,
	type CompanyRoomMessage,
	createCompanyRoom,
	type QueuedCompanyRoomDelivery,
	queueCompanyRoomDelivery,
	readCompanyRoom,
	readCompanyRoomMessage,
	readCompanyRoomMessages,
	readCompanyRooms,
	readQueuedCompanyRoomDeliveries,
	removeQueuedCompanyRoomDeliveries,
	rescheduleCompanyRoomDelivery,
	restoreCompanyRoom,
	updateCompanyRoom,
} from "@qorpera/company/company-rooms";
import {
	activateStaffAgent,
	archiveStaffAgent,
	assessCompanyArtifactSource,
	type CompanyArtifactObservationUpdate,
	type CompanyArtifactSourceAssessmentUpdate,
	type CompanyArtifactSourceIssueUpdate,
	createStaffAgent,
	createStaffAgents,
	createStarterCompanyArtifact,
	deleteStaffAgent,
	markStaffAgentMessagesDelivered,
	pendingStaffAgentMessages,
	queueStaffAgentMessage,
	readCompanyArtifacts,
	readStaffAgentMemory,
	readStaffAgentMessages,
	readStaffAgents,
	recentDeliveredStaffAgentMessages,
	recordCompanyArtifactObservation,
	reportCompanyArtifactSourceIssue,
	restoreStaffAgent,
	type StaffAgent,
	type StaffAgentMessage,
	type StaffAgentModel,
	staffAgentDirectoryPath,
	staffAgentInstructionsPath,
	staffAgentSkillsPath,
	transitionCompanyArtifactConnection,
	updateCompanyArtifact,
	updateStaffAgent,
} from "@qorpera/company/company-staff";
import type { CompanyOperationKind } from "@qorpera/contracts";
import { ModelRuntime } from "@qorpera/pi-coding-agent";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import {
	COMPANY_MANIFEST_RELATIVE_PATH,
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	captureProductTransactionStorage,
	claimCompanyRuntimeLock,
	createProductWorktree,
	enforceCompanyHostSettings,
	integrateRepoWithRuntimeLock,
	listCompanies,
	listProductDepartments,
	materializeClonedProductStorage,
	type ProductDepartment,
	type ProductWorktree,
	planProductWorktree,
	planProductWorktreeRecovery,
	productDepartmentId,
	readProductProtectionInventory,
	readProductStorageExpectations,
	readProductWorktreeAssignment,
	recoverProductWorktree,
	registerCompany,
	releaseCompanyRuntimeLock,
	scaffoldCompany,
	scaffoldProductDepartmentWithRuntimeLock,
	unregisterCompany,
	validateCompanyHostStorage,
} from "@qorpera/pi-coding-agent/company";
import {
	bindCompanySecret,
	bindNetworkDestination,
	createScheduledJob,
	deleteScheduledJob,
	destinationAllowed,
	persistWebhookPort,
	ROUTINE_PLACEMENTS,
	ROUTINE_WEEKDAYS,
	type RoutinePlacement,
	type RoutinePublicationPolicy,
	type RoutineTriggerInput,
	type RoutineWeekday,
	readCompanyConnections,
	readScheduledJobs,
	readWebhookBinding,
	removeCompanySecret,
	removeNetworkDestination,
	resolveCompanySecret,
	SCHEDULED_JOB_EFFORTS,
	type ScheduledJob,
	type ScheduledJobEffort,
	scheduledJobIntervalMinutes,
	setCompanySecretStore,
	suspendScheduledJob,
	updateScheduledJob,
	upsertStaffScheduledJob,
} from "@qorpera/pi-coding-agent/company-connections";
import { FOUNDER_PUBLIC_FILE, founderPublicRecord } from "@qorpera/pi-coding-agent/founder-identity";
import { runOAuthOnboarding } from "@qorpera/pi-coding-agent/oauth-onboarding";
import type { JsonValue, KernelExecutionIdentity } from "@qorpera/pi-protocol";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	session as electronSession,
	shell as electronShell,
	ipcMain,
	Menu,
	type NativeImage,
	nativeImage,
	type Session,
	safeStorage,
	Tray,
	type WebContents,
} from "electron";
import electronUpdater from "electron-updater";
import { QorperaAccountAuth, type QorperaAccountInfo, type QorperaAccountProvider } from "./account-auth.ts";
import {
	appendBoundTrailEntry,
	appendKernelComputerObservation,
	appendKernelConnectionObservation,
	appendKernelHttpObservation,
	appendKernelModelObservation,
	appendKernelMutationObservation,
	appendKernelObservation,
	appendKernelRuntimeExitObservation,
	appendKernelSessionEndObservation,
	appendKernelSessionInfo,
	appendKernelWakeObservation,
	applyKernelWriteFrame,
	bindTrailExecution,
	bindTrailSession,
	brokeredChildEnvironment,
	codexSpawn,
	commitTrailAppend,
	createKernelResponseSigner,
	existingTrailFileForSession,
	inboxMessagesPath,
	type KernelIntentCapability,
	kernelGateReviewDocument,
	killChildTree,
	killChildTreeSync,
	materializeSharedTrailSession,
	migrateLegacyCompanyAgentTrails,
	migrateLegacyTrailSession,
	parseTrailAppendFrame,
	protectedCompanyAgentPaths,
	provisionSandbox,
	pruneEmptyTrailSessions,
	reconcileKernelGateCreations,
	sandboxCommandArgs,
	sandboxConfigDir,
	sandboxGitEnvironment,
	sandboxRuntimeDir,
	shareWindowsSandboxState,
	type TrailBinding,
	trailSessionMessages,
	writeSandboxProfile,
} from "./agent-runtime.ts";
import { migrateCompanyToAgentsOnly } from "./agents-only-company-migration.ts";
import { readBackgroundCompanyRoots, setBackgroundCompanyEnabled } from "./background-companies.ts";
import { CloudProfileAccessRefresh } from "./cloud-access-refresh.ts";
import {
	acceptReviewedCloudCompanyExecution,
	type CloudCompanyExecutionCheckout,
	cloudCompanyExecutionTouchesAuthorityCritical,
	createCloudCompanyExecutionCheckout,
	discardCleanCloudCompanyExecution,
	findRecoverableCloudCompanyExecution,
	listRecoverableCloudCompanyExecutions,
	promoteCloudCompanyExecution,
	publishCloudCompanyExecutionProposal,
	quarantineCloudCompanyExecution,
	recoverInterruptedCloudCompanyReviewAcceptance,
	recoverOrphanedCloudCompanyExecutions,
	rejectReviewedCloudCompanyExecution,
	resolvePublishedCloudCompanyExecution,
} from "./cloud-company-execution.ts";
import {
	CloudCompanyFileCacheState,
	checkpointCloudCompanyFile,
	readCloudCompanyFileConflict,
} from "./cloud-company-file.ts";
import { previewCloudCompanySnapshot, replaceCloudCompanyCacheWithSnapshot } from "./cloud-company-merge.ts";
import {
	CloudCompanyProjection,
	cloudCompanyProjectionHasPersistedChanges,
	cloudCompanyProjectionRoot,
} from "./cloud-company-projection.ts";
import {
	discardCompanyProposalReviews,
	finalizeCompanyProposalReview,
	prepareCompanyProposalReview,
} from "./cloud-company-proposal-review.ts";
import { CloudCompanyPublication } from "./cloud-company-publication.ts";
import { currentCloudCompanyTreeReference, materializeCloudCompanyTree } from "./cloud-company-snapshot.ts";
import { CloudCompanySubstrate } from "./cloud-company-substrate.ts";
import { publishCompanySnapshotRestoreProofIfDue } from "./cloud-object-reachability.ts";
import type { CloudContentAddressedStore } from "./cloud-object-store.ts";
import type { CloudPresenceHandle } from "./cloud-presence.ts";
import {
	acknowledgeCloudPromptOutbox,
	pendingCloudPromptOutbox,
	stageCloudPromptOutbox,
} from "./cloud-prompt-outbox.ts";
import { CloudProfileRealtimeSync, type CloudRealtimeChange, type CloudRealtimeHealth } from "./cloud-realtime-sync.ts";
import { type ArbiterClaim, type ArbiterSessionRef, CloudSessionArbiter } from "./cloud-session-arbiter.ts";
import { CloudStaffSynchronizer } from "./cloud-staff-sync.ts";
import {
	type CloudSyncHealth,
	cloudSyncErrorIsRetryable,
	cloudSyncHealthAfter,
	DurableCloudSyncLoop,
	persistCloudSyncHealth,
} from "./cloud-sync-loop.ts";
import { CloudTrailSynchronizer } from "./cloud-trail-sync.ts";
import {
	type CompanyIconId,
	DEFAULT_COMPANY_ICON_ID,
	forgetCompanyIcon,
	isCompanyIconId,
	readCompanyIcon,
	writeCompanyIcon,
} from "./company-appearance.ts";
import {
	captureCompanyGitBaseline,
	checkpointCompanyGit,
	checkpointProductWorktreeGit,
	commitCompanyMaterialization,
	commitCompanyMaterializationAsync,
	finishPendingCompanyCheckpoint,
	reconcilePendingCompanyCheckpoints,
	reconcilePendingProductCheckpoints,
	savePendingCompanyCheckpoint,
	savePendingProductCheckpoint,
	snapshotFounderGitState,
} from "./company-checkpoint.ts";
import { createCompanyFileResolver } from "./company-file-paths.ts";
import {
	advanceCompanyGateCreation,
	beginCompanyGateCreation,
	companyHostStatePath,
	companyRootId,
	completeCompanyGateCreation,
	hasCompanyGateTrust,
	hasCompanyHostState,
	listPendingCompanyGateCreations,
	reconcileCompanyProductStorage,
	rememberCompanyGateTrust,
	revokeCompanyGateTrust,
} from "./company-host-state.ts";
import { type CompanyOperationBroker, createCompanyOperationBroker } from "./company-operation-broker.ts";
import { claimUnownedCompanies, companyOwnedBy, forgetCompany } from "./company-ownership.ts";
import { type ComputerBroker, createComputerBroker } from "./computer-broker.ts";
import {
	beginConnectionRequest,
	beginConnectionRequestSetup,
	beginConnectionRequestSync,
	type ConnectionIntentSelectionInput,
	type ConnectionRequest,
	type ConnectionRequestIdentity,
	type CreateConnectionRequestInput,
	cancelConnectionRequest,
	cancelPendingConnectionRequestsForStaff,
	completeConnectionRequest,
	completeConnectionRequestSync,
	createConnectionRequest,
	failConnectionRequest,
	getConnectionRequest,
	getRecoverableConnectionSetup,
	installPreparedConnectionRequestRecipe,
	prepareConnectionRequest,
	projectConnectionRequest,
	readConnectionRequests,
	readRendererConnectionRequests,
	resumeConnectionRequestAuthorization,
	retryFailedConnectionRequest,
	selectConnectionRequest,
	verifyConnectionRequest,
} from "./connection-requests.ts";
import { authorizeConnectorHttpExecution } from "./connector-execution-authorization.ts";
import {
	claimNextCustomTriggerBuild,
	customTriggerBuildStatePath,
	finishCustomTriggerBuild,
	queueCustomTriggerBuild,
	readCustomTriggerBuildState,
	writeCustomTriggerBuildState,
} from "./custom-trigger-builds.ts";
import {
	BUILT_IN_GITHUB_CONNECTOR_ID,
	ensureBuiltInGitHubConnector,
	GITHUB_CONNECTION_DESTINATIONS,
} from "./github-company-connector.ts";
import { connectGitHubCli, readGitHubCliStatus } from "./github-connection.ts";
import {
	type HostedAccountEntitlement,
	type HostedCompanyFile,
	type HostedCompanyProposal,
	type HostedCompanySnapshot,
	type HostedIncomingProfileInvitation,
	type HostedProfile,
	type HostedProfileTeam,
	type PendingSessionInput,
	SessionTurnOwnershipError,
} from "./hosted-primary.ts";
import {
	cacheHostedProfiles,
	cacheHostedTeam,
	loadHostedProfileCache,
	offlineHostedProfileTeam,
} from "./hosted-profile-cache.ts";
import { createHttpRequestBroker, type HttpRequestBroker } from "./http-request-broker.ts";
import {
	clearIntelligenceAccountBinding,
	intelligenceBindingMatches,
	readIntelligenceAccountBinding,
	writeIntelligenceAccountBinding,
} from "./intelligence-account.ts";
import {
	INTELLIGENCE_PROVIDER_CATALOG,
	intelligenceSelectionForProvider,
	isIntelligenceProviderId,
	resolveIntelligenceReadiness,
} from "./intelligence-onboarding.ts";
import {
	type BrokeredCredentials,
	type ModelRequestBroker,
	startModelRequestBroker,
} from "./legacy-local-model-request-broker.ts";
import { createLocalCompanySecretStore } from "./local-company-secret-store.ts";
import {
	type LocalExecutionPermission,
	localExecutionToolArgs,
	readLocalExecutionPermission,
	writeLocalExecutionPermission,
} from "./local-execution.ts";
import { alignCloudCompanyManifestName } from "./managed-company-identity.ts";
import { ModelAccountStore, type ModelAccountView } from "./model-accounts.ts";
import { parseProductFeedbackRequest } from "./product-feedback.ts";
import { hostedProfileAccess } from "./profile-collaboration.ts";
import {
	attachCloudProfile,
	beginProfilePromotion,
	completeProfilePromotion,
	ensureProfileAttachment,
	failProfilePromotion,
	forgetProfileAttachment,
	type ProfileAttachment,
	profileIdentityKey,
	readProfileAttachment,
	recordProfilePromotionCloudIdentity,
} from "./profile-identity.ts";
import { profileInvitationIdFromArgv, profileInvitationIdFromProtocolUrl } from "./profile-invitation-handoff.ts";
import {
	cancelProfileInvitation,
	claimUnownedProfiles,
	forgetProfile,
	inviteProfileMember,
	PROFILE_MEMBER_ROLES,
	type ProfileAccess,
	type ProfileCapability,
	type ProfileMemberRole,
	profileAccessFor,
	profileTeamInfo,
	removeProfileMember,
	updateProfileMemberRole,
} from "./profile-ownership.ts";
import { type ProductContext, productContext } from "./profile-product.ts";
import {
	isRendererRequestAllowed,
	lockDownRendererSession,
	lockDownRendererWebContents,
	rendererPartitionForCompany,
} from "./renderer-boundary.ts";
import { bitmapLooksBlank } from "./renderer-smoke.ts";
import {
	MAX_ROOM_DELEGATION_DEPTH,
	MAX_ROOM_DELEGATION_FANOUT,
	planRoomDelegation,
	type RoomDelegationContext,
	rootRoomDelegationContext,
} from "./room-delegation-policy.ts";
import {
	completePendingRoutineTrigger,
	dueCustomRoutineCheck,
	type PendingRoutineTrigger,
	persistRoutineTriggerEvent,
	pollGitHubRoutineTriggers,
	queueCustomRoutineTrigger,
	readRoutineTriggerState,
	recordCustomRoutineCheck,
	routineTriggerStatePath,
	writeRoutineTriggerState,
} from "./routine-triggers.ts";
import {
	clearCompanyRuntimeModelPreference,
	clearDefaultRuntimeModelPreference,
	modelSelectionFromRpcFrame,
	type RuntimeModelSelection,
	readCompanyRuntimeModelPreference,
	readDefaultRuntimeModelPreference,
	runtimeLaunchOptions,
	runtimeModelArgs,
	writeCompanyRuntimeModelPreference,
	writeDefaultRuntimeModelPreference,
} from "./runtime-model.ts";
import {
	SessionControlPlane,
	type SessionRuntimeActivity,
	type SessionRuntimeEventInput,
} from "./session-control-plane.ts";
import { readSidebarTranslucency, writeSidebarTranslucency } from "./shell-appearance.ts";
import { isStaffCharacterId, staffCharacterForTemplate } from "./staff-characters.ts";
import { removeStaffWorkspace } from "./staff-deletion.ts";
import { applyStaffRoutineOperation, type StaffRoutineOperation } from "./staff-routines.ts";
import {
	claimStaffIntro,
	finishStaffIntro,
	readStaffRuntimeState,
	recordStaffIntroPending,
	type StaffOrientationContext,
	staffRuntimeStatePath,
	writeStaffRuntimeState,
} from "./staff-runtime-state.ts";
import { getStaffTemplate, listStaffTemplates } from "./staff-templates.ts";
import {
	decideScheduledWake,
	nextScheduledWakeAt,
	readWakeRunState,
	recordWakeOutcome,
	recordWakeStart,
	removeScheduledJobRunState,
	scheduledJobRunInterrupted,
	scheduledJobRunState,
	scheduledWakeOccurrenceKey,
	WAKE_FAILURE_SUSPENSION_THRESHOLD,
	wakeFrameFailed,
	wakeRunStatePath,
	writeWakeRunState,
} from "./wake-scheduler.ts";
import { startWebhookListener } from "./webhook-listener.ts";

// Electron 43's Windows GPU compositor can produce a live but completely
// white renderer (Chromium UnknownVizError) on the founder's current display
// stack. Chromium reads --disable-gpu before app code runs, so packaged
// Windows launches bounce once through the proven process-level switch.
// CSS motion remains available through software compositing.
const WINDOWS_SOFTWARE_RENDERER_FLAG = "--qorpera-software-renderer";
if (process.platform === "win32" && app.isPackaged && !process.argv.includes("--disable-gpu")) {
	app.relaunch({
		args: [
			...process.argv.slice(1).filter((argument) => argument !== WINDOWS_SOFTWARE_RENDERER_FLAG),
			"--disable-gpu",
			WINDOWS_SOFTWARE_RENDERER_FLAG,
		],
	});
	app.exit(0);
} else if (process.platform === "win32") {
	app.disableHardwareAcceleration();
}

const LEGACY_PI_RPC_ENTRY = fileURLToPath(import.meta.resolve("@qorpera/pi-coding-agent/rpc-entry"));
const CODEX_ENTRY = resolveCodexEntry();

/**
 * Where the bundled Codex CLI is invoked from. On Windows this is the native
 * codex.exe itself: the npm wrapper script (bin/codex.js) re-spawns the
 * binary without windowsHide, and because the shell's whole process tree is
 * console-less, Windows allocates a visible console window for every sandbox
 * probe and agent start (two flashes and one persistent window per open).
 * Elsewhere the wrapper script stays the entry, run under electron-as-node.
 * codexSpawn() (agent-runtime) picks the spawn shape from the extension.
 */
function resolveCodexEntry(): string {
	const wrapper = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
	if (process.platform !== "win32") return wrapper;
	const platformPackage = process.arch === "arm64" ? "@openai/codex-win32-arm64" : "@openai/codex-win32-x64";
	const targetTriple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
	try {
		const packageRoot = dirname(fileURLToPath(import.meta.resolve(`${platformPackage}/package.json`)));
		const binary = join(packageRoot, "vendor", targetTriple, "bin", "codex.exe");
		if (existsSync(binary)) return binary;
	} catch {
		// Fall through to the wrapper; provisioning fails loudly if that breaks too.
	}
	return wrapper;
}
const DIRNAME = fileURLToPath(new URL(".", import.meta.url));
const FOUNDATION_READ_PATHS = [dirname(process.execPath), resolve(DIRNAME, "..", "..", "..")];
const MODEL_AUTH_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"anthropic",
	"google",
	"google-gemini-cli",
	"google-antigravity",
	"groq",
	"mistral",
	"xai",
	"openrouter",
	"cerebras",
	"deepseek",
	"zai",
	"kimi-coding",
	"minimax",
	"huggingface",
]);
const MODEL_CONNECTIONS = [
	{
		id: "openai-codex",
		name: "OpenAI",
		description: "ChatGPT Plus, Pro, Business, or Enterprise",
		credentialProviders: ["openai-codex", "openai"],
		ambientProviders: ["openai"],
		accountFallback: "ChatGPT account",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude Pro or Max",
		credentialProviders: ["anthropic"],
		ambientProviders: ["anthropic"],
		accountFallback: "Claude account",
	},
	{
		id: "xai",
		name: "xAI",
		description: "Grok account",
		credentialProviders: ["xai"],
		ambientProviders: ["xai"],
		accountFallback: "Grok account",
	},
] as const;
const MODEL_CONNECTION_IDS = new Set<string>(MODEL_CONNECTIONS.map((connection) => connection.id));
const STAFF_DEFAULT_THINKING_LEVEL = "low";
const STAFF_DEFAULT_RESPONSE_SPEED = "fast";
const STAFF_TOOL_NAMES =
	"read,bash,edit,write,request_connection,run_connector,assess_artifact_source,record_artifact_observation,report_artifact_source_issue,manage_routine,complete_setup,use_computer,send_agent_message";
const TRIGGER_BUILDER_TOOL_NAMES = "read,bash,edit,write,run_connector,finish_trigger_build";
const TRIGGER_CHECK_TOOL_NAMES = "read,run_connector,finish_trigger_check";
const MAX_KERNEL_REVIEW_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MODEL_ENV_PROVIDERS = new Map([
	["ANTHROPIC_API_KEY", "anthropic"],
	["OPENAI_API_KEY", "openai"],
	["GOOGLE_API_KEY", "google"],
	["GEMINI_API_KEY", "google"],
	["GROQ_API_KEY", "groq"],
	["MISTRAL_API_KEY", "mistral"],
	["XAI_API_KEY", "xai"],
	["OPENROUTER_API_KEY", "openrouter"],
	["CEREBRAS_API_KEY", "cerebras"],
	["DEEPSEEK_API_KEY", "deepseek"],
]);

function prepareBrokeredAgentDir(configDir: string, companyRoot: string, credentials: Record<string, unknown>): string {
	const agentDir = join(configDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(credentials, null, "\t")}\n`, "utf-8");
	writeFileSync(
		join(agentDir, "trust.json"),
		`${JSON.stringify({ [resolve(companyRoot)]: true }, null, "\t")}\n`,
		"utf-8",
	);
	// The founder's public key only: the child verifies policy provenance in
	// the sandbox; signing stays with founder contexts (CLI + this desktop host).
	const founderRecord = founderPublicRecord();
	if (founderRecord) writeFileSync(join(agentDir, FOUNDER_PUBLIC_FILE), founderRecord, "utf-8");
	return agentDir;
}

function sourceModelCredentials(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(join(app.getPath("home"), ".qorpera", "agent", "auth.json"), "utf-8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
}

function ambientModelProviders(): string[] {
	return [...new Set([...MODEL_ENV_PROVIDERS].flatMap(([name, provider]) => (process.env[name] ? [provider] : [])))];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function tokenAccountName(credential: Record<string, unknown>): string | undefined {
	if (typeof credential.access !== "string") return undefined;
	const tokenParts = credential.access.split(".");
	if (tokenParts.length !== 3 || !tokenParts[1]) return undefined;
	try {
		const claims = recordValue(JSON.parse(Buffer.from(tokenParts[1], "base64url").toString("utf-8")));
		if (!claims) return undefined;
		for (const source of [claims, recordValue(claims["https://api.openai.com/profile"])]) {
			if (!source) continue;
			for (const field of ["email", "emailAddress", "name", "preferred_username"]) {
				const value = source[field];
				if (typeof value === "string" && value.trim()) return value.trim();
			}
		}
	} catch {
		// Opaque access tokens have no displayable account metadata.
	}
	return undefined;
}

function connectionAccountName(
	connection: (typeof MODEL_CONNECTIONS)[number],
	credential: Record<string, unknown> | undefined,
	sourceProvider: string | undefined,
): string {
	if (!credential) return `${connection.name} API key`;
	if (credential.type === "api_key") return `${connection.name} API key`;
	for (const field of ["email", "accountName", "account_name", "name"]) {
		const value = credential[field];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	const tokenName = tokenAccountName(credential);
	if (tokenName) return tokenName;
	const accountId = credential.accountId;
	if (typeof accountId === "string" && accountId.trim()) {
		return `${connection.accountFallback} · ${accountId.slice(-8)}`;
	}
	if (sourceProvider && sourceProvider !== connection.id) return `${connection.name} API key`;
	return connection.accountFallback;
}

interface SettingsConnectionInfo {
	id: string;
	name: string;
	description: string;
	connected: boolean;
	accountName: string;
	accounts?: ModelAccountView[];
	group: "services" | "models";
}

function modelConnectionInfo(): SettingsConnectionInfo[] {
	const credentials = sourceModelCredentials();
	const ambient = new Set(ambientModelProviders());
	const accounts = modelAccountStore?.views() ?? [];
	return MODEL_CONNECTIONS.map((connection) => {
		const sourceProvider = connection.credentialProviders.find(
			(providerId) => recordValue(credentials[providerId]) !== undefined,
		);
		const credential = sourceProvider ? recordValue(credentials[sourceProvider]) : undefined;
		const ambientConnected = connection.ambientProviders.some((providerId) => ambient.has(providerId));
		const providerAccounts = accounts.filter((account) =>
			connection.credentialProviders.some((providerId) => providerId === account.providerId),
		);
		const connected = providerAccounts.length > 0 || credential !== undefined || ambientConnected;
		return {
			id: connection.id,
			name: connection.name,
			description: connection.description,
			connected,
			accountName:
				providerAccounts[0]?.accountName ??
				(connected ? connectionAccountName(connection, credential, sourceProvider) : ""),
			accounts: providerAccounts,
			group: "models",
		};
	});
}

async function modelAccountUsageInfo(force = true): Promise<ModelAccountView[]> {
	const store = modelAccountStore;
	const runtime = brokerModelRuntime;
	if (!store || !runtime) return [];
	if (!force && Date.now() - modelAccountUsageRefreshedAt < 60_000) return store.views();
	if (modelAccountUsageRefreshInFlight) return modelAccountUsageRefreshInFlight;
	const refresh = store.refreshUsage((accountId, providerId) =>
		store.withAccount(accountId, async () => {
			const resolution = await runtime.getAuth(providerId, { minOAuthValidityMs: 60_000 });
			return resolution?.auth.apiKey;
		}),
	);
	modelAccountUsageRefreshInFlight = refresh;
	try {
		const accounts = await refresh;
		modelAccountUsageRefreshedAt = Date.now();
		return accounts;
	} finally {
		if (modelAccountUsageRefreshInFlight === refresh) modelAccountUsageRefreshInFlight = undefined;
	}
}

function validStoredOnboardingCredential(credential: Record<string, unknown> | undefined): boolean {
	if (!credential) return false;
	return (
		credential.type === "oauth" &&
		typeof credential.access === "string" &&
		Boolean(credential.access.trim()) &&
		typeof credential.refresh === "string" &&
		Boolean(credential.refresh.trim()) &&
		typeof credential.expires === "number" &&
		Number.isFinite(credential.expires)
	);
}

function intelligenceInfo(): {
	providers: Array<{
		id: string;
		name: string;
		product: string;
		description: string;
		connected: boolean;
		accountName: string;
	}>;
	ready: boolean;
	selection?: RuntimeModelSelection;
	selectionSource?: "stored" | "inferred";
	requiresChoice: boolean;
} {
	if (IS_SMOKE) {
		const selection = intelligenceSelectionForProvider("openai-codex")!;
		return {
			providers: INTELLIGENCE_PROVIDER_CATALOG.map((provider) => ({
				id: provider.id,
				name: provider.name,
				product: provider.product,
				description: `Sign in with ${provider.product}`,
				connected: provider.id === selection.provider,
				accountName: provider.id === selection.provider ? "Smoke test" : "",
			})),
			ready: true,
			selection,
			selectionSource: "inferred",
			requiresChoice: false,
		};
	}
	const credentials = sourceModelCredentials();
	const modelConnections = new Map(
		MODEL_CONNECTIONS.map((connection) => {
			const sourceProvider = connection.credentialProviders.find((providerId) =>
				validStoredOnboardingCredential(recordValue(credentials[providerId])),
			);
			const credential = sourceProvider ? recordValue(credentials[sourceProvider]) : undefined;
			return [
				connection.id,
				{
					connected: Boolean(sourceProvider),
					accountName: sourceProvider ? connectionAccountName(connection, credential, sourceProvider) : "",
					description: connection.description,
				},
			] as const;
		}),
	);
	const userData = app.getPath("userData");
	const readiness = resolveIntelligenceReadiness(
		[...modelConnections.entries()].flatMap(([id, connection]) => (connection.connected ? [id] : [])),
		readDefaultRuntimeModelPreference(userData),
	);
	const accountBinding = readIntelligenceAccountBinding(userData);
	const intelligenceBelongsToAccount = intelligenceBindingMatches(
		accountBinding,
		currentQorperaAccountId,
		readiness.selection?.provider,
	);
	return {
		providers: INTELLIGENCE_PROVIDER_CATALOG.map((provider) => {
			const connection = modelConnections.get(provider.id);
			return {
				id: provider.id,
				name: provider.name,
				product: provider.product,
				description: connection?.description ?? `Sign in with ${provider.product}`,
				connected: connection?.connected ?? false,
				accountName: connection?.accountName ?? "",
			};
		}),
		ready: readiness.ready && intelligenceBelongsToAccount,
		...(intelligenceBelongsToAccount && readiness.selection ? { selection: readiness.selection } : {}),
		...(intelligenceBelongsToAccount && readiness.selectionSource
			? { selectionSource: readiness.selectionSource }
			: {}),
		requiresChoice: !intelligenceBelongsToAccount || readiness.requiresChoice,
	};
}

async function verifiedIntelligenceInfo(): Promise<ReturnType<typeof intelligenceInfo>> {
	const info = intelligenceInfo();
	if (!info.ready || !info.selection) return info;
	const modelAgentDir = join(app.getPath("home"), ".qorpera", "agent");
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(modelAgentDir, "auth.json"),
			modelsPath: join(modelAgentDir, "models.json"),
			allowModelNetwork: false,
		});
		if (!(await runtime.getAuth(info.selection.provider))) {
			throw new Error("the selected provider has no usable credential");
		}
		const userData = app.getPath("userData");
		for (const company of listCompanies()) {
			const companySelection = readCompanyRuntimeModelPreference(userData, company.root);
			if (!companySelection || companySelection.provider === info.selection.provider) continue;
			try {
				if (await runtime.getAuth(companySelection.provider)) continue;
			} catch {
				// Invalid profile-local credentials fall back to the account provider below.
			}
			writeCompanyRuntimeModelPreference(userData, company.root, info.selection);
		}
		return intelligenceInfo();
	} catch {
		// A stored OAuth shape is not proof that its refresh token is still valid.
		// Fail back to provider setup before a staff runtime can start.
		clearIntelligenceAccountBinding(app.getPath("userData"));
		return intelligenceInfo();
	}
}

async function githubConnectionInfo(root: string | undefined): Promise<SettingsConnectionInfo> {
	const status = await readGitHubCliStatus();
	let companyBound = false;
	if (root) {
		try {
			const connections = readCompanyConnections(root);
			companyBound =
				connections.secretNames.includes("github") &&
				connections.destinations.some((destination) => destination.host === "api.github.com");
		} catch {
			// An invalid company connection store is reported when the founder tries to reconnect it.
		}
	}
	const connected = root ? companyBound : status.connected;
	const description = !status.available
		? "Repositories and pull requests — GitHub CLI required"
		: root && status.connected && !companyBound
			? `Allow this company to use ${status.accountName}`
			: "Repositories, pull requests, issues, and releases";
	return {
		id: "github",
		name: "GitHub",
		description,
		connected,
		accountName: connected ? status.accountName || "GitHub account" : "",
		group: "services",
	};
}

interface ConnectionLogin {
	connectionId: string;
	controller: AbortController;
}

const connectionLogins = new Map<number, ConnectionLogin>();

function waitForBrowserOAuthCallback(...signals: Array<AbortSignal | undefined>): Promise<string> {
	return new Promise((_resolve, reject) => {
		const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
		const cancel = (): void => {
			for (const signal of activeSignals) signal.removeEventListener("abort", cancel);
			reject(new Error("Login cancelled"));
		};
		if (activeSignals.some((signal) => signal.aborted)) {
			cancel();
			return;
		}
		for (const signal of activeSignals) signal.addEventListener("abort", cancel, { once: true });
	});
}

function connectionError(error: unknown): { ok: false; cancelled?: true; error?: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (/cancelled|aborted/i.test(message)) return { ok: false, cancelled: true };
	return { ok: false, error: message.slice(0, 240) };
}

function safeConnectionFailure(error: string | undefined): string {
	const message = error?.trim().slice(0, 240);
	return message && !message.includes("://") && !/[{}<>="'&?]/.test(message) && !message.includes("secret://")
		? message
		: "Connector authorization failed";
}

let modelRequestBroker: ModelRequestBroker | undefined;
let modelAccountStore: ModelAccountStore | undefined;
let brokerModelRuntime: ModelRuntime | undefined;
let modelAccountUsageRefreshedAt = 0;
let modelAccountUsageRefreshInFlight: Promise<ModelAccountView[]> | undefined;
let qorperaAccountAuth: QorperaAccountAuth | undefined;
let currentQorperaAccountId: string | undefined;
const hostedProfilesById = new Map<string, HostedProfile>();
const hostedTeamsByProfileId = new Map<string, HostedProfileTeam>();
const freshHostedTeamProfileIds = new Set<string>();
const restrictedHostedAccessProfileIds = new Set<string>();
const hostedAccessRefreshes = new Map<string, CloudProfileAccessRefresh>();
type FoundationUpdatePhase = "idle" | "checking" | "downloading" | "current" | "ready" | "error" | "unavailable";
type FoundationUpdateState = {
	phase: FoundationUpdatePhase;
	message: string;
	version?: string;
};

let downloadedUpdateVersion: string | undefined;
let downloadedUpdateFile: string | undefined;

/* Squirrel.Mac validates an update against the running app's designated
 * requirement; an ad-hoc signature's requirement is its own cdhash, which a
 * newer build can never satisfy, so ad-hoc macOS builds cannot install
 * updates through Squirrel at all. Until Developer ID signing exists, an
 * ad-hoc build installs its (sha512-verified) downloaded archive by
 * replacing its own bundle. Detection is live so this path retires itself
 * the moment builds are properly signed. */
let bundledRuntimeNodeCache: string | null | undefined;
function bundledRuntimeNodeForAdhocBuild(): string | undefined {
	if (process.platform !== "darwin" || !app.isPackaged) return undefined;
	if (bundledRuntimeNodeCache !== undefined) return bundledRuntimeNodeCache ?? undefined;
	const candidate = join(app.getAppPath(), "runtime-node", "bin", "node");
	bundledRuntimeNodeCache = existsSync(candidate) && isAdhocSignedMacBuild() ? candidate : null;
	return bundledRuntimeNodeCache ?? undefined;
}

function isAdhocSignedMacBuild(): boolean {
	if (process.platform !== "darwin") return false;
	const bundle = resolve(dirname(app.getPath("exe")), "..", "..");
	const result = spawnSync("codesign", ["-dv", bundle], { encoding: "utf8" });
	return /Signature=adhoc/.test(`${result.stderr ?? ""}${result.stdout ?? ""}`);
}

function installMacUpdateBySelfReplace(archivePath: string): boolean {
	const bundle = resolve(dirname(app.getPath("exe")), "..", "..");
	if (!bundle.endsWith(".app") || !existsSync(archivePath)) return false;
	const script = join(app.getPath("temp"), `qorpera-self-update-${process.pid}.sh`);
	writeFileSync(
		script,
		[
			"#!/bin/sh",
			'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done',
			'STAGE="$(mktemp -d)" || exit 1',
			'ditto -xk "$2" "$STAGE" || exit 1',
			'NEW="$(find "$STAGE" -maxdepth 1 -name "*.app" | head -1)"',
			'[ -d "$NEW" ] || exit 1',
			'rm -rf "$3" && mv "$NEW" "$3" || exit 1',
			'xattr -dr com.apple.quarantine "$3" 2>/dev/null',
			'rm -rf "$STAGE"',
			'open "$3"',
			"",
		].join("\n"),
	);
	chmodSync(script, 0o700);
	spawn("/bin/sh", [script, String(process.pid), archivePath, bundle], {
		detached: true,
		stdio: "ignore",
	}).unref();
	return true;
}
let foundationUpdateState: FoundationUpdateState = {
	phase: "idle",
	message: "Check for updates",
};
let pendingProfileInvitationId = profileInvitationIdFromArgv(process.argv);
let profileInvitationHandoffInFlight = false;

function rememberAuthenticatedAccount(account: QorperaAccountInfo): QorperaAccountInfo {
	const nextAccountId = account.authenticated && account.user ? account.user.id : undefined;
	if (nextAccountId !== currentQorperaAccountId) {
		hostedProfilesById.clear();
		hostedTeamsByProfileId.clear();
		freshHostedTeamProfileIds.clear();
		restrictedHostedAccessProfileIds.clear();
		hostedAccessRefreshes.clear();
		if (nextAccountId) {
			const cached = loadHostedProfileCache(app.getPath("userData"), nextAccountId);
			for (const profile of cached.profiles) hostedProfilesById.set(profile.profileId, profile);
			for (const [profileId, team] of Object.entries(cached.teams)) hostedTeamsByProfileId.set(profileId, team);
		}
	}
	currentQorperaAccountId = nextAccountId;
	modelAccountStore?.setActiveOwner(currentQorperaAccountId);
	modelAccountUsageRefreshedAt = 0;
	return account;
}

async function refreshBrokerModels(providerIds?: readonly string[]): Promise<void> {
	if (!brokerModelRuntime) return;
	await brokerModelRuntime.refresh({ allowNetwork: false, ...(providerIds ? { providers: providerIds } : {}) });
}

async function authenticatedAccount(): Promise<QorperaAccountInfo | undefined> {
	if (!qorperaAccountAuth) return undefined;
	try {
		const account = rememberAuthenticatedAccount(await qorperaAccountAuth.info());
		return account.authenticated && account.user ? account : undefined;
	} catch {
		currentQorperaAccountId = undefined;
		hostedProfilesById.clear();
		hostedTeamsByProfileId.clear();
		freshHostedTeamProfileIds.clear();
		restrictedHostedAccessProfileIds.clear();
		hostedAccessRefreshes.clear();
		return undefined;
	}
}

function claimExistingCompanies(account: QorperaAccountInfo): void {
	if (!account.user) return;
	const userData = app.getPath("userData");
	claimUnownedCompanies(
		userData,
		account.user.id,
		listCompanies().map((company) => company.root),
	);
	const localRoots = listCompanies()
		.map((company) => company.root)
		.filter((root) => ensureProfileAttachment(userData, root).profileType === "local");
	claimUnownedProfiles(userData, account.user, localRoots);
}

async function refreshHostedProfiles(): Promise<HostedProfile[]> {
	const primary = qorperaAccountAuth?.hostedPrimary();
	if (!primary || !currentQorperaAccountId) return [];
	const profiles = await primary.listProfiles();
	hostedProfilesById.clear();
	for (const profile of profiles) hostedProfilesById.set(profile.profileId, profile);
	for (const profileId of hostedTeamsByProfileId.keys()) {
		if (!hostedProfilesById.has(profileId)) {
			hostedTeamsByProfileId.delete(profileId);
			freshHostedTeamProfileIds.delete(profileId);
		}
	}
	try {
		cacheHostedProfiles(app.getPath("userData"), currentQorperaAccountId, profiles);
	} catch (error) {
		console.error(
			`Cloud profile cache could not be saved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return profiles;
}

async function refreshHostedTeam(profileId: string): Promise<HostedProfileTeam> {
	const primary = qorperaAccountAuth?.hostedPrimary();
	if (!primary || !currentQorperaAccountId) throw new Error("Sign in to access this cloud profile.");
	const team = await primary.profileTeam(profileId);
	hostedTeamsByProfileId.set(profileId, team);
	freshHostedTeamProfileIds.add(profileId);
	try {
		cacheHostedTeam(app.getPath("userData"), currentQorperaAccountId, team);
	} catch (error) {
		console.error(`Cloud team cache could not be saved: ${error instanceof Error ? error.message : String(error)}`);
	}
	return team;
}

function effectiveHostedTeam(profileId: string): HostedProfileTeam | undefined {
	if (restrictedHostedAccessProfileIds.has(profileId)) return undefined;
	const team = hostedTeamsByProfileId.get(profileId);
	if (!team || freshHostedTeamProfileIds.has(profileId)) return team;
	return offlineHostedProfileTeam(team);
}

function profileAttachment(root: string): ProfileAttachment {
	return ensureProfileAttachment(app.getPath("userData"), root);
}

async function promoteProfileRoot(
	root: string,
	profileName: string,
): Promise<{
	profile: HostedProfile;
	team: HostedProfileTeam;
	attachment: ProfileAttachment;
}> {
	if (!qorperaAccountAuth || !currentQorperaAccountId) throw new Error("Sign in to promote this profile.");
	const primary = qorperaAccountAuth.hostedPrimary();
	const objects = qorperaAccountAuth.hostedObjects();
	const userData = app.getPath("userData");
	const current = profileAttachment(root);
	if (current.profileType === "cloud" && !current.promotion) {
		throw new Error("This profile is already attached to a cloud profile.");
	}
	const prepared = beginProfilePromotion(userData, root);
	const promotion = prepared.promotion;
	if (!promotion) throw new Error("Profile promotion could not be prepared.");
	try {
		const profile = await primary.createProfile({
			profileName,
			environmentName: profileName,
			contractVersion: 1,
			promotionId: promotion.promotionId,
		});
		recordProfilePromotionCloudIdentity(userData, root, {
			profileId: profile.profileId,
			environmentId: profile.environmentId,
		});
		await new CloudStaffSynchronizer({
			root,
			userData,
			profileId: profile.profileId,
			primary,
			canWrite: () => true,
		}).sync();
		hostedProfilesById.set(profile.profileId, profile);
		attachCloudProfile(userData, root, {
			profileId: profile.profileId,
			environmentId: profile.environmentId,
		});
		await checkpointCloudCompanyFile({
			userData,
			companyRoot: root,
			profileId: profile.profileId,
			environmentId: profile.environmentId,
			primary,
			objects,
		});
		const team = await refreshHostedTeam(profile.profileId);
		const runtime = slotForCompany(root)?.runtime;
		if (runtime) {
			await installCloudStaffSync(runtime);
			await installCloudTrailSync(runtime);
			installCloudCompanySync(runtime);
		}
		const attachment = completeProfilePromotion(userData, root);
		return { profile, team, attachment };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failProfilePromotion(userData, root, message);
		throw error;
	}
}

function activeProfileAccess(root: string): ProfileAccess | undefined {
	const attachment = profileAttachment(root);
	if (attachment.profileType === "cloud") {
		if (!currentQorperaAccountId) return undefined;
		if (restrictedHostedAccessProfileIds.has(attachment.profileId)) return undefined;
		const team = effectiveHostedTeam(attachment.profileId);
		return team ? hostedProfileAccess(team) : undefined;
	}
	if (currentQorperaAccountId) {
		return profileAccessFor(app.getPath("userData"), currentQorperaAccountId, root);
	}
	return IS_SMOKE
		? {
				role: "owner",
				ownerUserId: "00000000-0000-4000-8000-000000000000",
				capabilities: { read: true, write: true, authorize: true, manageMembers: true },
			}
		: undefined;
}

async function refreshProfileAccess(root: string): Promise<ProfileAccess | undefined> {
	const attachment = profileAttachment(root);
	if (attachment.profileType === "local") return activeProfileAccess(root);
	try {
		const access = hostedProfileAccess(await refreshHostedTeam(attachment.profileId));
		if (!hostedAccessRefreshes.get(attachment.profileId)?.refreshing()) {
			restrictedHostedAccessProfileIds.delete(attachment.profileId);
		}
		return access;
	} catch (error) {
		if (!cloudSyncErrorIsRetryable(error)) {
			hostedProfilesById.delete(attachment.profileId);
			hostedTeamsByProfileId.delete(attachment.profileId);
			freshHostedTeamProfileIds.delete(attachment.profileId);
			restrictedHostedAccessProfileIds.add(attachment.profileId);
			return undefined;
		}
		const cached = effectiveHostedTeam(attachment.profileId);
		if (cached) return hostedProfileAccess(cached);
		throw error;
	}
}

function slotHasProfileCapability(slot: Slot, capability: ProfileCapability): boolean {
	const root = slot.runtime?.root;
	if (!root) return false;
	if (IS_SMOKE) return true;
	const access = activeProfileAccess(root);
	if (!access) return false;
	return capability === "manage-members" ? access.capabilities.manageMembers : access.capabilities[capability];
}

function profilePermissionError(capability: ProfileCapability): { ok: false; error: string } {
	return {
		ok: false,
		error:
			capability === "write"
				? "This profile is read-only for your account."
				: capability === "authorize"
					? "Full profile access is required to authorize this action."
					: "Full profile access is required to manage members.",
	};
}

function shellVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(join(DIRNAME, "..", "package.json"), "utf-8")) as {
			productVersion?: string;
			version?: string;
		};
		return pkg.productVersion ?? pkg.version ?? "dev";
	} catch {
		return "dev";
	}
}

interface CompanyRuntime {
	root: string;
	/** Durable lifecycle source for every attended and autonomous session in
	 * this company. Child processes attach to it; they do not define it. */
	sessions: SessionControlPlane;
	/** Stable company identity (companyRootId) — keys renderer storage. */
	storageId: string;
	/** The named agent currently attached to the attended conversation. A
	 * company with no selected agent is an idle host and has no model process. */
	child?: ChildProcessWithoutNullStreams;
	/** Childless attended attachment for cloud staff conversations (founder
	 * ruling 2026-08-26: agents live in the cloud; the app is a window). The
	 * anchor carries the session's trail binding so the thread renders,
	 * selections persist, and prompts become cloud turns — with no local
	 * agent process at all. Mutually exclusive with `child`. */
	sessionAnchor?: { binding: TrailBinding; staffAgentId: string };
	backendPort: number;
	backendClose?: () => void;
	backendToken: string;
	childOptions: ChildOptions;
	productWorker?: { department: string; worktree: string };
	/** Live wake session, if one is running (kernel-spawned, single-flight). */
	wakeChild?: ChildProcessWithoutNullStreams;
	/** Hidden trigger builder/checker currently using the autonomous lane. */
	infrastructureWork?: "trigger-build" | "trigger-check";
	/** Named scheduled job currently owning wakeChild; absent for event wakes. */
	wakeJobId?: string;
	/** Group-chat delivery currently owning wakeChild; the autonomous lane is
	 * carrying a room participant turn, not a scheduled or event wake. */
	roomDelivery?: { roomId: string; staffAgentId: string };
	/** Closes the inbound webhook listener (optional kernel module). */
	webhookClose?: () => void;
	/** An inbound event arrived while the company was busy; the wake ticker owes it a wake. */
	pendingInboundWakeKeys?: Set<string>;
	/** Prevent overlapping GitHub event polls for this open company. */
	routineTriggerPolling?: boolean;
	inventoryWatcher?: ReturnType<typeof watch>;
	cloudTrailSync?: CloudTrailSynchronizer;
	cloudTrailSyncLoop?: DurableCloudSyncLoop;
	cloudTrailSyncHealth?: CloudSyncHealth;
	cloudStaffSync?: CloudStaffSynchronizer;
	cloudStaffSyncLoop?: DurableCloudSyncLoop;
	cloudStaffSyncHealth?: CloudSyncHealth;
	cloudRealtimeSync?: CloudProfileRealtimeSync;
	cloudPresence?: CloudPresenceHandle;
	/** Last renderer-declared open thread, retained while Presence connects. */
	cloudPresenceThread?: string | null;
	cloudPresenceHeartbeat?: NodeJS.Timeout;
	cloudRunnerActivityTimer?: NodeJS.Timeout;
	cloudRunnerActivityPolling?: boolean;
	cloudSessionRunPolling?: boolean;
	cloudSessionRunRevision?: number;
	/** Staff busy on the last runner-activity poll; a departure triggers an
	 * immediate trail pull so the finished turn's reply paints right away. */
	lastBusyStaff?: Set<string>;
	cloudRealtimeHealth?: CloudRealtimeHealth;
	cloudCompanyPublication?: CloudCompanyPublication;
	cloudCompanyPublicationHealth?: CloudSyncHealth;
	cloudCompanyProjection?: CloudCompanyProjection;
	cloudCompanyProjectionHealth?: CloudSyncHealth;
	cloudCompanySubstrate?: CloudCompanySubstrate;
	/** Hosted session arbitration for this company (SESSIONS.md): the one
	 * open session per staff agent, plus this machine's single turn claim. */
	cloudSessionArbiter?: CloudSessionArbiter;
	/** Hosted wake arbitration (SESSIONS.md): autonomous wakes as claimed
	 * rows, so a due occurrence executes on exactly one machine. */
	cloudSessionPump?: NodeJS.Timeout;
	cloudSessionArbiterHealth?: CloudSyncHealth;
	/** Why this machine is not claiming turns (affinity or freshness), for
	 * the visible waiting state. Cleared whenever a claim is attempted. */
	cloudSessionWaiting?: string;
	/** Hosted staff version captured by the currently attached child context. */
	attachedStaffVersion?: number;
	/** A remote turn synced into the bound thread while the child was busy;
	 * refresh (respawn from the updated trail) once the local turn settles. */
	pendingStaffThreadRefresh?: { staffAgentId: string; sessionFile: string };
	staffThreadRefreshInFlight?: Promise<void>;
	trailContextStale?: boolean;
	attachedTrailCursor?: { hostedSessionId: string; cursor: number };
	/** One re-adoption at a time: the pump found the attended chat bound to a
	 * trail other than the arbiter's open session and is re-attaching. */
	staffSessionReadoptInFlight?: boolean;
	pendingInventoryRestart: boolean;
	pendingStaffContextRestart: boolean;
	/** Connector setup recovery is attempted once per durable request during
	 * one company-open lifetime, even when infrastructure work swaps children. */
	resumedConnectionSetupIds: Set<string>;
	transitionQueue: Promise<void>;
	/** Bounded crash-loop state for the replaceable attended RPC process. */
	runtimeReconnectAttempts: number;
	lastUnexpectedRuntimeExitAt?: number;
	/** During initial company setup, return the attended runtime to the first
	 * selected staff member after the local intro queue has settled. */
	staffBootstrapReturn?: { staffAgentId: string; trailFile: string };
	closing: boolean;
	closePromise?: Promise<void>;
	runtimeLock: CompanyRuntimeLock;
}

function liveTrailBindings(runtime: CompanyRuntime): TrailBinding[] {
	const bindings = [
		runtime.child ? childBindings.get(runtime.child) : undefined,
		runtime.wakeChild ? childBindings.get(runtime.wakeChild) : undefined,
		// The childless anchor is a live binding: sync must materialize through
		// it, or its audit cursor diverges from the file the anchor appends to.
		runtime.sessionAnchor?.binding,
	];
	return bindings.filter((binding): binding is TrailBinding => binding !== undefined);
}

/** The attended conversation's trail binding, from the attached child or the
 * childless cloud anchor. */
function attendedSessionBinding(runtime: CompanyRuntime): TrailBinding | undefined {
	return (runtime.child ? childBindings.get(runtime.child) : undefined) ?? runtime.sessionAnchor?.binding;
}

function createCloudTrailSynchronizer(
	root: string,
	liveBindings: () => Iterable<TrailBinding>,
	onMaterialized: (binding: TrailBinding) => void,
	onCursorAdvanced: (advance: { hostedSessionId: string; cursor: number; requiresReload: boolean }) => void,
): CloudTrailSynchronizer | undefined {
	const attachment = profileAttachment(root);
	const primary = qorperaAccountAuth?.hostedPrimary();
	const objects = qorperaAccountAuth?.hostedObjects();
	if (attachment.profileType !== "cloud" || !primary || !objects || !currentQorperaAccountId) return undefined;
	return new CloudTrailSynchronizer({
		root,
		userData: app.getPath("userData"),
		profileId: attachment.profileId,
		environmentId: attachment.environmentId,
		primary,
		loadObject: (reference) =>
			objects.getObject(attachment.profileId, {
				sha256: reference.sha256,
				bytes: reference.bytes,
				mediaType: reference.mediaType,
			}),
		canWrite: () => activeProfileAccess(root)?.capabilities.write === true,
		liveBindings,
		onMaterialized,
		onCursorAdvanced,
	});
}

function createCloudStaffSynchronizer(root: string): CloudStaffSynchronizer | undefined {
	const attachment = profileAttachment(root);
	const primary = qorperaAccountAuth?.hostedPrimary();
	if (attachment.profileType !== "cloud" || !primary || !currentQorperaAccountId) return undefined;
	return new CloudStaffSynchronizer({
		root,
		userData: app.getPath("userData"),
		profileId: attachment.profileId,
		primary,
		canWrite: () => activeProfileAccess(root)?.capabilities.write === true,
	});
}

function recordCloudSyncHealth(
	runtime: CompanyRuntime,
	channel: "sessions" | "staff" | "trail",
	health: CloudSyncHealth,
): void {
	const previous =
		channel === "staff"
			? runtime.cloudStaffSyncHealth
			: channel === "trail"
				? runtime.cloudTrailSyncHealth
				: runtime.cloudSessionArbiterHealth;
	if (channel === "staff") runtime.cloudStaffSyncHealth = health;
	else if (channel === "trail") runtime.cloudTrailSyncHealth = health;
	else runtime.cloudSessionArbiterHealth = health;
	if (health.lastError && health.lastError !== previous?.lastError) {
		console.error(`cloud ${channel} sync ${health.phase}: ${health.lastError}`);
	}
}

/** Session arbitration has no DurableCloudSyncLoop of its own — the 10s pump
 * is its retry cadence — but its degradation must be as visible as every
 * other channel's: recorded on the runtime for the settings surface and
 * persisted so a packaged app leaves evidence behind. */
function recordCloudSessionArbiterOutcome(
	runtime: CompanyRuntime,
	outcome: { ok: true } | { ok: false; error: unknown },
): void {
	const health = cloudSyncHealthAfter(runtime.cloudSessionArbiterHealth, outcome);
	recordCloudSyncHealth(runtime, "sessions", health);
	const attachment = profileAttachment(runtime.root);
	if (attachment.profileType !== "cloud") return;
	try {
		persistCloudSyncHealth(app.getPath("userData"), runtime.root, attachment.profileId, "sessions", health);
	} catch (error) {
		console.error(
			`cloud sessions health could not be saved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function createCloudStaffSyncLoop(runtime: CompanyRuntime): DurableCloudSyncLoop | undefined {
	const sync = runtime.cloudStaffSync;
	const attachment = profileAttachment(runtime.root);
	if (!sync || attachment.profileType !== "cloud") return undefined;
	const loop = new DurableCloudSyncLoop({
		root: runtime.root,
		userData: app.getPath("userData"),
		profileId: attachment.profileId,
		channel: "staff",
		sync: () => sync.sync(),
		onHealth: (health) => recordCloudSyncHealth(runtime, "staff", health),
	});
	recordCloudSyncHealth(runtime, "staff", loop.health());
	return loop;
}

function startCloudStaffSync(runtime: CompanyRuntime): void {
	if (!runtime.cloudStaffSync || runtime.closing) return;
	if (!runtime.cloudStaffSyncLoop) runtime.cloudStaffSyncLoop = createCloudStaffSyncLoop(runtime);
	runtime.cloudStaffSyncLoop?.start();
}

function triggerCloudStaffSync(runtime: CompanyRuntime): void {
	if (!runtime.cloudStaffSync || runtime.closing) return;
	startCloudStaffSync(runtime);
	void runtime.cloudStaffSyncLoop?.trigger().catch((error) => {
		console.error(
			`cloud staff sync state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

async function installCloudStaffSync(runtime: CompanyRuntime): Promise<void> {
	if (!runtime.cloudStaffSync) runtime.cloudStaffSync = createCloudStaffSynchronizer(runtime.root);
	if (!runtime.cloudStaffSync) return;
	startCloudStaffSync(runtime);
	const health = await runtime.cloudStaffSyncLoop!.trigger();
	if (health.phase !== "healthy") throw new Error(health.lastError ?? "Cloud staff synchronization failed");
}

function createCloudTrailSyncLoop(runtime: CompanyRuntime): DurableCloudSyncLoop | undefined {
	const sync = runtime.cloudTrailSync;
	const attachment = profileAttachment(runtime.root);
	if (!sync || attachment.profileType !== "cloud") return undefined;
	const loop = new DurableCloudSyncLoop({
		root: runtime.root,
		userData: app.getPath("userData"),
		profileId: attachment.profileId,
		channel: "trail",
		sync: () => sync.sync(),
		onHealth: (health) => recordCloudSyncHealth(runtime, "trail", health),
	});
	recordCloudSyncHealth(runtime, "trail", loop.health());
	return loop;
}

function runtimeCloudSessionArbiter(runtime: CompanyRuntime): CloudSessionArbiter | undefined {
	if (runtime.cloudSessionArbiter) return runtime.cloudSessionArbiter;
	const attachment = profileAttachment(runtime.root);
	if (attachment.profileType !== "cloud" || !attachment.environmentId) return undefined;
	const primary = qorperaAccountAuth?.hostedPrimary();
	if (!primary || !currentQorperaAccountId) return undefined;
	runtime.cloudSessionArbiter = new CloudSessionArbiter(primary, attachment.environmentId);
	return runtime.cloudSessionArbiter;
}

/** The local trail file carrying the arbiter session's shared identity,
 * materializing an empty stub when this machine has never seen it. */
function localTrailForArbiterRef(runtime: CompanyRuntime, staff: StaffAgent, ref: ArbiterSessionRef): string {
	const local = existingTrailFileForSession(runtime.root, ref.clientSessionId);
	if (local) return local;
	const stub = materializeSharedTrailSession(
		runtime.root,
		{
			localSessionId: ref.clientSessionId,
			createdAt: ref.createdAt,
			title: ref.title,
			staffAgentId: staff.id,
		},
		[],
	);
	runtime.sessions.rememberAudit(stub);
	triggerCloudTrailSync(runtime);
	return stub.file;
}

function recordAttachedTrailCursor(runtime: CompanyRuntime, staffAgentId: string): void {
	const ref = runtime.cloudSessionArbiter?.sessionForStaff(staffAgentId);
	if (!ref) return;
	const cursor = runtime.cloudTrailSync?.cursorForHostedSession(ref.hostedSessionId);
	if (cursor === undefined) return;
	runtime.attachedTrailCursor = { hostedSessionId: ref.hostedSessionId, cursor };
	runtime.trailContextStale = false;
}

function recordAttachedTrailAdvance(
	runtime: CompanyRuntime,
	advance: { hostedSessionId: string; cursor: number; requiresReload: boolean },
): void {
	if (advance.requiresReload || runtime.trailContextStale) return;
	const staffAgentId = runtime.childOptions.staffAgentId;
	const ref = staffAgentId ? runtime.cloudSessionArbiter?.sessionForStaff(staffAgentId) : undefined;
	if (ref?.hostedSessionId !== advance.hostedSessionId) return;
	runtime.attachedTrailCursor = {
		hostedSessionId: advance.hostedSessionId,
		cursor: advance.cursor,
	};
}

/** A remote executor's turn just landed in the bound thread's trail file.
 * The attended child holds the session in memory and never re-reads the
 * file, so without this the new turn is invisible until the founder swaps
 * threads (which respawns the child) — and worse, a stale child that later
 * claimed a turn would execute on partial context. Refresh = respawn from
 * the updated file + tell the renderer to reload, exactly what the manual
 * swap-away-and-back does, minus the founder doing it. */
function scheduleStaffThreadRefresh(slot: Slot, runtime: CompanyRuntime, binding: TrailBinding): void {
	const staffAgentId = binding.authority.staffAgentId;
	if (!staffAgentId || runtime.closing || slot.runtime !== runtime) return;
	if (runtime.childOptions.staffAgentId !== staffAgentId) return;
	const child = runtime.child;
	if (!child) {
		// A childless anchor needs no respawn: sync just materialized through
		// the live binding, so the file is already current — the renderer only
		// needs to hear that the thread moved.
		const anchor = runtime.sessionAnchor;
		if (anchor && anchor.binding.sessionId === binding.sessionId) {
			recordAttachedTrailCursor(runtime, staffAgentId);
			send(slot.window, "staff-session-refreshed", { staffAgentId, sessionFile: anchor.binding.file });
		}
		return;
	}
	const current = childBindings.get(child);
	if (!current || current.sessionId !== binding.sessionId) return;
	runtime.trailContextStale = true;
	if (runtime.wakeChild || isChildBusy(child)) {
		runtime.pendingStaffThreadRefresh = { staffAgentId, sessionFile: binding.file };
		return;
	}
	const refresh = refreshAttachedStaffThread(slot, runtime, staffAgentId, binding.file);
	runtime.staffThreadRefreshInFlight = refresh;
	void refresh.finally(() => {
		if (runtime.staffThreadRefreshInFlight === refresh) runtime.staffThreadRefreshInFlight = undefined;
	});
}

async function refreshAttachedStaffThread(
	slot: Slot,
	runtime: CompanyRuntime,
	staffAgentId: string,
	sessionFile: string,
): Promise<void> {
	try {
		let refreshed: { child: ChildProcessWithoutNullStreams; sessionFile: string } | undefined;
		await enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing) return;
			if (runtime.childOptions.staffAgentId !== staffAgentId) return;
			const child = runtime.child;
			if (!child || runtime.wakeChild || isChildBusy(child)) return;
			const staff = activeStaffAgent(runtime.root, staffAgentId);
			if (!staff) return;
			// attachStaffChild short-circuits on an identical binding; the whole
			// point here is the respawn, so retire the current child first.
			await stopChild(child);
			if (slot.runtime !== runtime || runtime.closing) return;
			runtime.child = undefined;
			const attached = await attachStaffChild(slot, runtime, staff, sessionFile, false);
			if (runtime.child) refreshed = { child: runtime.child, sessionFile: attached.sessionFile };
		});
		if (!refreshed) return;
		// The renderer reloads the transcript through the new child; announcing
		// the refresh before it can answer repaints the thread stale. Waiting
		// here, outside the transition, keeps composer sends unblocked.
		await waitForChildReadiness(refreshed.child);
		if (slot.runtime === runtime && runtime.child === refreshed.child) {
			recordAttachedTrailCursor(runtime, staffAgentId);
			send(slot.window, "staff-session-refreshed", { staffAgentId, sessionFile: refreshed.sessionFile });
		}
	} catch (error) {
		console.error(`staff thread refresh failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function startCloudSessionPump(slot: Slot, runtime: CompanyRuntime): void {
	if (runtime.cloudSessionPump || runtime.closing) return;
	if (!runtimeCloudSessionArbiter(runtime)) return;
	const timer = setInterval(() => {
		void refreshCloudSessionQueue(slot, runtime).catch((error) => {
			console.error(`cloud session queue refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}, 10_000);
	timer.unref();
	runtime.cloudSessionPump = timer;
}
const CLOUD_SESSION_PROMPT_SCHEMA = "qorpera.session-prompt/v1";
const CLOUD_STAFF_INTRO_RETRY_SCHEMA = "qorpera.staff-intro-retry/v1";

interface CloudQueuedPromptBody {
	schema: typeof CLOUD_SESSION_PROMPT_SCHEMA;
	text: string;
	displayText?: string;
	images: CloudQueuedImageReference[];
}

interface CloudQueuedImageReference {
	objectSha256: string;
	bytes: number;
	mediaType: string;
}

interface ReviewedExecutionSponsor {
	sponsorBindingId: string;
	sponsorVersion: number;
	computeIdentityId: string;
	workerClass: "managed_sandbox" | "company_computer";
}

function isCloudStaffIntroRetry(value: unknown): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(value as { schema?: unknown }).schema === CLOUD_STAFF_INTRO_RETRY_SCHEMA,
	);
}

function cloudQueuedImageReference(value: unknown): CloudQueuedImageReference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<CloudQueuedImageReference>;
	if (
		typeof input.objectSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(input.objectSha256) ||
		!Number.isSafeInteger(input.bytes) ||
		(input.bytes ?? -1) < 1 ||
		(input.bytes ?? 0) > MAX_PROMPT_IMAGE_BYTES ||
		typeof input.mediaType !== "string" ||
		!REVIEW_IMAGE_TYPES.has(input.mediaType)
	) {
		return undefined;
	}
	return input as CloudQueuedImageReference;
}

function cloudQueuedPromptBody(value: unknown): CloudQueuedPromptBody | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Partial<CloudQueuedPromptBody>;
	if (
		input.schema !== CLOUD_SESSION_PROMPT_SCHEMA ||
		typeof input.text !== "string" ||
		Buffer.byteLength(input.text, "utf-8") > MAX_PROMPT_BYTES ||
		(input.displayText !== undefined &&
			(typeof input.displayText !== "string" || Buffer.byteLength(input.displayText, "utf-8") > MAX_PROMPT_BYTES)) ||
		!Array.isArray(input.images) ||
		input.images.length > MAX_PROMPT_IMAGES ||
		Object.keys(input).some((key) => !["schema", "text", "displayText", "images"].includes(key))
	) {
		return undefined;
	}
	const images = input.images.map(cloudQueuedImageReference);
	if (images.some((image) => image === undefined)) return undefined;
	if (images.reduce((total, image) => total + (image?.bytes ?? 0), 0) > MAX_PROMPT_IMAGE_BYTES) return undefined;
	return {
		schema: CLOUD_SESSION_PROMPT_SCHEMA,
		text: input.text,
		...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
		images: images as CloudQueuedImageReference[],
	};
}

async function prepareCloudPromptBody(
	runtime: CompanyRuntime,
	prompt: ReviewedPromptFrame,
): Promise<CloudQueuedPromptBody> {
	const attachment = profileAttachment(runtime.root);
	const objects = qorperaAccountAuth?.hostedObjects();
	if (attachment.profileType !== "cloud" || !objects) throw new Error("cloud prompt storage is unavailable");
	const images: CloudQueuedImageReference[] = [];
	let totalImageBytes = 0;
	for (const image of prompt.images ?? []) {
		const bytes = Buffer.from(image.data, "base64");
		totalImageBytes += bytes.byteLength;
		if (totalImageBytes > MAX_PROMPT_IMAGE_BYTES) throw new Error("prompt images exceed the 8 MiB turn allowance");
		const reference = await objects.putObject(attachment.profileId, bytes, image.mimeType);
		images.push({ objectSha256: reference.sha256, bytes: reference.bytes, mediaType: reference.mediaType });
	}
	return {
		schema: CLOUD_SESSION_PROMPT_SCHEMA,
		text: prompt.message,
		...(prompt.displayText !== undefined && prompt.displayText !== prompt.message
			? { displayText: prompt.displayText }
			: {}),
		images: images.map((image) => ({
			objectSha256: image.objectSha256,
			bytes: image.bytes,
			mediaType: image.mediaType,
		})),
	};
}

function rendererSessionQueue(inputs: readonly PendingSessionInput[]): Array<Record<string, unknown>> {
	return inputs
		.filter((input) => input.kind === "user_message" && !isCloudStaffIntroRetry(input.body))
		.map((input) => {
			const body = cloudQueuedPromptBody(input.body);
			const legacy = input.body as { text?: unknown };
			return {
				inputId: input.inputId,
				position: input.position,
				status: input.status,
				authorUserId: input.authorUserId,
				authorDisplayName: input.authorDisplayName,
				text: body?.displayText ?? body?.text ?? (typeof legacy.text === "string" ? legacy.text : ""),
				attachmentCount: body?.images.length ?? 0,
				...(input.failureReason ? { failureReason: input.failureReason } : {}),
				createdAt: input.createdAt,
			};
		});
}

function rendererSessionRecoveries(
	recoveries: Awaited<ReturnType<CloudSessionArbiter["recoveries"]>>["items"],
): Array<Record<string, unknown>> {
	return recoveries.map((recovery) => {
		const messages = recovery.inputs
			.filter((input) => input.kind === "user_message" && !isCloudStaffIntroRetry(input.body))
			.map((input) => {
				const body = cloudQueuedPromptBody(input.body);
				const legacy = input.body as { text?: unknown };
				return {
					author: input.authorDisplayName,
					text: body?.displayText ?? body?.text ?? (typeof legacy.text === "string" ? legacy.text : ""),
					attachmentCount: body?.images.length ?? 0,
				};
			});
		return {
			inputId: `recovery:${recovery.turnId}`,
			recoveryTurnId: recovery.turnId,
			status: "failed",
			authorDisplayName:
				messages.length === 1
					? messages[0]?.author
					: `${new Set(messages.map((message) => message.author)).size} members`,
			text: messages
				.map((message) => message.text)
				.filter(Boolean)
				.join("\n\n"),
			attachmentCount: messages.reduce((total, message) => total + message.attachmentCount, 0),
			failureReason: recovery.failureReason,
			operationCount: recovery.operationReceipts.length,
			operationReceipts: recovery.operationReceipts,
			canRetry: recovery.operationReceipts.every((receipt) => receipt.status === "cancelled"),
			createdAt: recovery.failedAt,
		};
	});
}

function rendererExecutionRunRecoveries(
	recoveries: Awaited<ReturnType<CloudSessionArbiter["executionRecoveries"]>>,
): Array<Record<string, unknown>> {
	return recoveries.map((recovery) => {
		const messages = recovery.inputs
			.filter((input) => input.kind === "user_message" && !isCloudStaffIntroRetry(input.body))
			.map((input) => {
				const body = cloudQueuedPromptBody(input.body);
				const legacy = input.body as { text?: unknown };
				return {
					author: input.authorDisplayName,
					text: body?.displayText ?? body?.text ?? (typeof legacy.text === "string" ? legacy.text : ""),
					attachmentCount: body?.images.length ?? 0,
				};
			});
		const canRetry =
			!recovery.proposalId && recovery.operationReceipts.every((receipt) => receipt.status === "cancelled");
		return {
			inputId: `run-recovery:${recovery.runId}`,
			recoveryRunId: recovery.runId,
			status: "failed",
			authorDisplayName:
				messages.length === 1
					? messages[0]?.author
					: `${new Set(messages.map((message) => message.author)).size} members`,
			text: messages
				.map((message) => message.text)
				.filter(Boolean)
				.join("\n\n"),
			attachmentCount: messages.reduce((total, message) => total + message.attachmentCount, 0),
			failureReason: recovery.failureReason,
			operationCount: recovery.operationReceipts.length,
			operationReceipts: recovery.operationReceipts,
			canRetry,
			...(!canRetry
				? {
						canRetryReason: recovery.proposalId
							? "Resolve the Company File proposal before deciding what to do with this prompt."
							: "A prior operation has a durable outcome, so this prompt cannot be run again automatically.",
					}
				: {}),
			createdAt: recovery.failedAt,
		};
	});
}

async function readRendererSessionQueue(
	arbiter: CloudSessionArbiter,
	staffAgentId: string,
	fallback: Array<Record<string, unknown>> = [],
): Promise<Array<Record<string, unknown>>> {
	const queue = await arbiter
		.pendingInputs(staffAgentId)
		.then(rendererSessionQueue)
		.catch(() => fallback);
	const recoveries = await arbiter
		.recoveries(staffAgentId)
		.then((page) => rendererSessionRecoveries(page.items))
		.catch(() => []);
	const executionRecoveries = await arbiter
		.executionRecoveries(staffAgentId)
		.then(rendererExecutionRunRecoveries)
		.catch(() => []);
	return [...queue, ...recoveries, ...executionRecoveries];
}

/** The pump found the attended chat bound to a trail other than the
 * arbiter's open session — the open ran while arbitration was unreachable
 * before cloud-only execution was enforced. Re-attach onto the adopted trail so this machine
 * rejoins the shared conversation instead of forking it for the rest of
 * the app run. Idle-only, single-flight, and re-checked inside the
 * runtime transition because the world may move while queued. */
async function readoptStaffCloudSession(
	slot: Slot,
	runtime: CompanyRuntime,
	staffAgentId: string,
	ref: ArbiterSessionRef,
): Promise<void> {
	if (runtime.staffSessionReadoptInFlight || runtime.closing) return;
	runtime.staffSessionReadoptInFlight = true;
	try {
		await enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing) return;
			if (runtime.childOptions.staffAgentId !== staffAgentId) return;
			// A childless anchor re-adopts the same way a live child does; only
			// a busy or wake-owned runtime defers.
			if (runtime.wakeChild || isChildBusy(runtime.child)) return;
			if (!runtime.child && !runtime.sessionAnchor) return;
			const binding = attendedSessionBinding(runtime);
			if (!binding || binding.sessionId === ref.clientSessionId) return;
			const staff = activeStaffAgent(runtime.root, staffAgentId);
			if (!staff) return;
			await attachStaffChild(slot, runtime, staff, localTrailForArbiterRef(runtime, staff, ref), false);
		});
	} catch (error) {
		console.error(`staff session re-adoption failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		runtime.staffSessionReadoptInFlight = false;
	}
}

async function refreshCloudSessionQueue(slot: Slot, runtime: CompanyRuntime): Promise<void> {
	// Durable cloud turns are claimed only by the Runner Orchestrator. The
	// desktop observes the queue; it never becomes an executor.
	await emitActiveStaffQueue(slot, runtime);
}

function startCloudTrailSync(runtime: CompanyRuntime): void {
	if (!runtime.cloudTrailSync || runtime.closing) return;
	if (!runtime.cloudTrailSyncLoop) runtime.cloudTrailSyncLoop = createCloudTrailSyncLoop(runtime);
	runtime.cloudTrailSyncLoop?.start();
}

function triggerCloudTrailSync(runtime: CompanyRuntime): void {
	if (!runtime.cloudTrailSync || runtime.closing) return;
	startCloudTrailSync(runtime);
	void runtime.cloudTrailSyncLoop?.trigger().catch((error) => {
		console.error(
			`cloud trail sync state could not be saved: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

async function installCloudTrailSync(runtime: CompanyRuntime): Promise<void> {
	if (!runtime.cloudTrailSync) {
		runtime.cloudTrailSync = createCloudTrailSynchronizer(
			runtime.root,
			() => liveTrailBindings(runtime),
			(binding) => runtime.sessions.rememberAudit(binding),
			(advance) => recordAttachedTrailAdvance(runtime, advance),
		);
	}
	if (!runtime.cloudTrailSync) return;
	startCloudTrailSync(runtime);
	const health = await runtime.cloudTrailSyncLoop!.trigger();
	if (health.phase !== "healthy") throw new Error(health.lastError ?? "Cloud trail synchronization failed");
}

function recordCloudCompanyHealth(runtime: CompanyRuntime, health: CloudSyncHealth): void {
	const previous = runtime.cloudCompanyPublicationHealth;
	runtime.cloudCompanyPublicationHealth = health;
	if (health.lastError && health.lastError !== previous?.lastError) {
		console.error(`Company File synchronization ${health.phase}: ${health.lastError}`);
	}
}

function installCloudCompanySync(runtime: CompanyRuntime): void {
	if (runtime.closing) return;
	const attachment = profileAttachment(runtime.root);
	const primary = qorperaAccountAuth?.hostedPrimary();
	const objects = qorperaAccountAuth?.hostedObjects();
	if (attachment.profileType !== "cloud" || !primary || !objects || !currentQorperaAccountId) return;
	if (!runtime.cloudCompanyPublication) {
		runtime.cloudCompanySubstrate ??= new CloudCompanySubstrate({
			userData: app.getPath("userData"),
			companyRoot: runtime.root,
			profileId: attachment.profileId,
			environmentId: attachment.environmentId,
			primary,
		});
		runtime.cloudCompanyPublication = new CloudCompanyPublication({
			userData: app.getPath("userData"),
			companyRoot: runtime.root,
			profileId: attachment.profileId,
			environmentId: attachment.environmentId,
			primary,
			objects,
			runtimeLock: runtime.runtimeLock,
			canWrite: () => activeProfileAccess(runtime.root)?.capabilities.write === true,
			runCheckpoint: (checkpoint) =>
				enqueueRuntimeTransition(runtime, async () => {
					if (runtime.closing) throw new Error("Cloud company publication stopped while the profile was closing");
					const liveWake = runtime.wakeChild;
					const wakeIsWriting = liveWake?.exitCode === null && liveWake.signalCode === null;
					const attendedIsWriting = isChildBusy(runtime.child);
					if (wakeIsWriting || attendedIsWriting) {
						throw new Error("Cloud company publication is waiting for the active agent run to finish");
					}
					if (
						runtime.cloudCompanyProjection?.hasPendingChanges() ||
						(await cloudCompanyProjectionHasPersistedChanges({
							companyRoot: runtime.root,
							projectionRoot: cloudCompanyProjectionRoot(app.getPath("userData"), attachment.profileId),
							userData: app.getPath("userData"),
							profileId: attachment.profileId,
						}))
					) {
						throw new Error("Company File Explorer changes must be recovered before cloud publication");
					}
					return checkpoint();
				}),
			onCheckpoint: async (checkpoint) => {
				await installCloudStaffSync(runtime);
				await installCloudTrailSync(runtime);
				await publishCompanySnapshotRestoreProofIfDue({
					userData: app.getPath("userData"),
					companyRoot: runtime.root,
					snapshot: checkpoint.snapshot,
					store: objects,
					primary,
				});
				await runtime.cloudCompanySubstrate!.publish(checkpoint.snapshot);
				await runtime.cloudCompanyProjection?.refresh();
			},
			onHealth: (health) => recordCloudCompanyHealth(runtime, health),
			onWatcherError: (error) => console.error(`cloud company watcher unavailable: ${error.message}`),
		});
		recordCloudCompanyHealth(runtime, runtime.cloudCompanyPublication.health());
		runtime.cloudCompanyPublication.start();
		void runtime.cloudCompanyPublication.publishNow().catch((error) => {
			console.error(
				`initial Company File synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}

function recordCloudRealtimeHealth(runtime: CompanyRuntime, health: CloudRealtimeHealth): void {
	const previous = runtime.cloudRealtimeHealth;
	runtime.cloudRealtimeHealth = health;
	if (health.error && health.error !== previous?.error)
		console.error(`cloud realtime ${health.phase}: ${health.error}`);
}

/** Presence lane (SESSIONS.md): typing and who-has-what-open, fire-and-forget
 * over the profile's realtime channel — lossy by design, never stored. The
 * renderer paints from whatever arrives; silence simply fades the signal. */
async function startCloudPresence(slot: Slot, runtime: CompanyRuntime): Promise<void> {
	if (runtime.cloudPresence || runtime.closing) return;
	const attachment = profileAttachment(runtime.root);
	const transport = qorperaAccountAuth?.hostedPresence();
	if (attachment.profileType !== "cloud" || !transport || !currentQorperaAccountId) return;
	if (runtime.cloudPresence || runtime.closing || slot.runtime !== runtime) return;
	runtime.cloudPresence = transport.join(
		attachment.profileId,
		(members) => {
			if (runtime.closing || slot.runtime !== runtime) return;
			send(slot.window, "presence-members", members);
		},
		(event) => {
			if (runtime.closing || slot.runtime !== runtime) return;
			send(slot.window, "presence-typing", event);
		},
		(event) => {
			if (runtime.closing || slot.runtime !== runtime) return;
			send(slot.window, "presence-activity", event);
		},
		(health) => {
			if (runtime.closing || slot.runtime !== runtime) return;
			if (health.phase === "degraded") send(slot.window, "presence-members", []);
		},
	);
	runtime.cloudPresence.setOpenThread(runtime.cloudPresenceThread ?? null);
	if (!runtime.cloudPresenceHeartbeat) {
		const heartbeat = setInterval(() => {
			if (runtime.closing || slot.runtime !== runtime || !runtime.cloudPresence) return;
			for (const child of [runtime.child, runtime.wakeChild]) {
				if (!child || !isChildBusy(child)) continue;
				const staffAgentId = childBindings.get(child)?.authority.staffAgentId;
				if (staffAgentId) runtime.cloudPresence.sendActivity(staffAgentId, "working");
			}
		}, 10_000);
		heartbeat.unref();
		runtime.cloudPresenceHeartbeat = heartbeat;
	}
}

async function refreshCloudRunnerActivity(slot: Slot, runtime: CompanyRuntime): Promise<void> {
	if (runtime.closing || slot.runtime !== runtime || runtime.cloudRunnerActivityPolling) return;
	const attachment = profileAttachment(runtime.root);
	const primary = qorperaAccountAuth?.hostedPrimary();
	if (attachment.profileType !== "cloud" || !primary) return;
	runtime.cloudRunnerActivityPolling = true;
	try {
		const activity = await primary.listStaffExecutionActivity(attachment.environmentId);
		if (!runtime.closing && slot.runtime === runtime) {
			send(slot.window, "runner-activity", { activity, healthy: true });
			// A staff leaving the busy set means its turn just finished — pull
			// the trail immediately so the reply paints now, not a sync tick
			// later.
			const busy = new Set(
				activity
					.filter((entry) => entry.activity === "working" || entry.activity === "waiting")
					.map((entry) => entry.staffAgentId),
			);
			const finished = [...(runtime.lastBusyStaff ?? [])].some((staffAgentId) => !busy.has(staffAgentId));
			runtime.lastBusyStaff = busy;
			if (finished) triggerCloudTrailSync(runtime);
		}
	} catch (error) {
		if (!runtime.closing && slot.runtime === runtime) {
			send(slot.window, "runner-activity", {
				activity: [],
				healthy: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		runtime.cloudRunnerActivityPolling = false;
	}
}

async function refreshCloudSessionRun(slot: Slot, runtime: CompanyRuntime): Promise<void> {
	const anchor = runtime.sessionAnchor;
	const control = qorperaAccountAuth?.cloudSessionRunControl();
	const ref = anchor && runtime.cloudSessionArbiter?.sessionForStaff(anchor.staffAgentId);
	if (
		runtime.closing ||
		slot.runtime !== runtime ||
		runtime.cloudSessionRunPolling ||
		!anchor ||
		!control ||
		!ref ||
		ref.clientSessionId !== anchor.binding.sessionId
	)
		return;
	runtime.cloudSessionRunPolling = true;
	const revision = runtime.cloudSessionRunRevision ?? 0;
	const identity = { staffAgentId: anchor.staffAgentId, trailFile: anchor.binding.file };
	try {
		const result = await control.read(ref.hostedSessionId, anchor.staffAgentId);
		if (
			!runtime.closing &&
			slot.runtime === runtime &&
			runtime.sessionAnchor === anchor &&
			(runtime.cloudSessionRunRevision ?? 0) === revision
		) {
			send(slot.window, "runner-activity", { sessionRun: { ...identity, healthy: true, run: result.run } });
		}
	} catch {
		if (
			!runtime.closing &&
			slot.runtime === runtime &&
			runtime.sessionAnchor === anchor &&
			(runtime.cloudSessionRunRevision ?? 0) === revision
		) {
			send(slot.window, "runner-activity", { sessionRun: { ...identity, healthy: false } });
		}
	} finally {
		runtime.cloudSessionRunPolling = false;
	}
}

function startCloudRunnerActivity(slot: Slot, runtime: CompanyRuntime): void {
	if (runtime.cloudRunnerActivityTimer || profileAttachment(runtime.root).profileType !== "cloud") return;
	void refreshCloudRunnerActivity(slot, runtime);
	void refreshCloudSessionRun(slot, runtime);
	const timer = setInterval(() => {
		void refreshCloudRunnerActivity(slot, runtime);
		void refreshCloudSessionRun(slot, runtime);
	}, 5_000);
	timer.unref();
	runtime.cloudRunnerActivityTimer = timer;
}

async function emitActiveStaffQueue(slot: Slot, runtime: CompanyRuntime): Promise<void> {
	const staffAgentId = runtime.childOptions.staffAgentId;
	const arbiter = runtime.cloudSessionArbiter;
	if (!staffAgentId || !arbiter?.sessionForStaff(staffAgentId) || slot.runtime !== runtime || runtime.closing) return;
	const queue = await readRendererSessionQueue(arbiter, staffAgentId);
	if (slot.runtime === runtime && !runtime.closing) {
		send(slot.window, "staff-session-queue", { staffAgentId, queue });
	}
}

function clearChildDurableTurn(child: ChildProcessWithoutNullStreams | undefined, claim?: ArbiterClaim): void {
	if (!child) return;
	const execution = childDurableExecutions.get(child);
	if (execution?.kind === "turn" && (!claim || execution.id === claim.turnId)) {
		clearChildDurableExecution(child);
	}
}

function abandonCloudSessionClaim(
	arbiter: CloudSessionArbiter,
	child: ChildProcessWithoutNullStreams | undefined,
	claim?: ArbiterClaim,
): void {
	arbiter.abandonClaim();
	clearChildDurableTurn(child, claim);
}

/** Finalize an already-settled claimed turn without converting an uncertain
 * network response into a second execution. A lost completion response is
 * retried while the independently renewed lease remains ours; a definitive
 * zero-row response is reconciled against the durable pending queue. */
async function completeCloudSessionClaim(
	slot: Slot,
	runtime: CompanyRuntime,
	arbiter: CloudSessionArbiter,
	claim: ArbiterClaim,
	attempt = 0,
): Promise<void> {
	if (slot.runtime !== runtime || runtime.closing || arbiter.activeClaim !== claim) return;
	try {
		await arbiter.renewIfDue();
		const fileHealth = await runtime.cloudCompanyPublication?.publishNow();
		const staffHealth = await runtime.cloudStaffSyncLoop?.trigger();
		const trailHealth = await runtime.cloudTrailSyncLoop?.trigger();
		if (runtime.cloudCompanyPublication && fileHealth?.phase !== "healthy") {
			throw new Error(fileHealth?.lastError ?? "Company File output did not finish syncing");
		}
		if (runtime.cloudStaffSync && staffHealth?.phase !== "healthy") {
			throw new Error(staffHealth?.lastError ?? "staff output did not finish syncing");
		}
		if (runtime.cloudTrailSync && trailHealth?.phase !== "healthy") {
			throw new Error(trailHealth?.lastError ?? "conversation output did not finish syncing");
		}
		const trailEndSequence = runtime.cloudTrailSync?.cursorForHostedSession(claim.hostedSessionId);
		if (trailEndSequence === undefined) throw new Error("conversation output has no durable cloud cursor");
		if (arbiter.activeClaim !== claim) throw new SessionTurnOwnershipError("complete");
		await arbiter.completeTurn(trailEndSequence, claim);
	} catch (error) {
		if (error instanceof SessionTurnOwnershipError) {
			let completedRemotely = false;
			try {
				completedRemotely = (await arbiter.turnStatus(claim)) === "completed";
			} catch {
				// The next queue refresh will reconcile once connectivity returns.
			}
			abandonCloudSessionClaim(arbiter, runtime.child, claim);
			if (!completedRemotely) console.error(`session turn ownership lost: ${error.message}`);
			await emitActiveStaffQueue(slot, runtime);
			return;
		}
		const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 4));
		if (attempt === 0) {
			console.error(`session turn completion deferred: ${error instanceof Error ? error.message : String(error)}`);
		}
		setTimeout(() => {
			void completeCloudSessionClaim(slot, runtime, arbiter, claim, attempt + 1);
		}, delay).unref();
		return;
	}
	clearChildDurableTurn(runtime.child, claim);
	await emitActiveStaffQueue(slot, runtime);
}

interface ExecutionReviewPolicy {
	policyKey: string;
	title: string;
	reviewerStaffIds: string[];
}

async function submitCloudSessionProposal(
	slot: Slot,
	runtime: CompanyRuntime,
	child: ChildProcessWithoutNullStreams,
	checkout: CloudCompanyExecutionCheckout,
	proposalHead: string,
	arbiter: CloudSessionArbiter,
	claim: ArbiterClaim,
	reviewPolicy?: ExecutionReviewPolicy,
	attempt = 0,
): Promise<void> {
	if (slot.runtime !== runtime || runtime.closing || arbiter.activeClaim !== claim) return;
	childOutputsRequireReview.add(child);
	let renewalTimer: NodeJS.Timeout | undefined;
	let renewalError: unknown;
	try {
		const turnStatus = await arbiter.turnStatus(claim);
		if (turnStatus !== "active" && turnStatus !== "review_pending") {
			abandonCloudSessionClaim(arbiter, child, claim);
			console.error(`Company File proposal stopped because the turn is ${turnStatus}`);
			await emitActiveStaffQueue(slot, runtime);
			return;
		}
		if (turnStatus === "active") {
			await arbiter.renewIfDue();
			renewalTimer = setInterval(() => {
				void arbiter.renewIfDue().catch((error) => {
					renewalError = error;
				});
			}, 15_000);
			renewalTimer.unref();
		}
		const staffHealth = await runtime.cloudStaffSyncLoop?.trigger();
		const trailHealth = await runtime.cloudTrailSyncLoop?.trigger();
		if (runtime.cloudStaffSync && staffHealth?.phase !== "healthy") {
			throw new Error(staffHealth?.lastError ?? "staff output did not finish syncing");
		}
		if (runtime.cloudTrailSync && trailHealth?.phase !== "healthy") {
			throw new Error(trailHealth?.lastError ?? "conversation output did not finish syncing");
		}
		if (renewalError) throw renewalError;
		const trailEndSequence = runtime.cloudTrailSync?.cursorForHostedSession(claim.hostedSessionId);
		if (trailEndSequence === undefined) throw new Error("conversation output has no durable cloud cursor");
		const attachment = profileAttachment(runtime.root);
		const primary = qorperaAccountAuth?.hostedPrimary();
		const objects = qorperaAccountAuth?.hostedObjects();
		if (attachment.profileType !== "cloud" || !primary || !objects) {
			throw new Error("cloud Company File proposal services are unavailable");
		}
		const authorityCritical = await cloudCompanyExecutionTouchesAuthorityCritical({
			checkoutRoot: checkout.checkoutRoot,
			proposalHead,
		});
		await publishCloudCompanyExecutionProposal({
			userData: app.getPath("userData"),
			environmentId: attachment.environmentId,
			baseSnapshotId: claim.companySnapshotId,
			checkout,
			execution: { kind: "turn", id: claim.turnId, claimantId: arbiter.claimantId },
			sessionId: claim.hostedSessionId,
			trailEndSequence,
			reason: reviewPolicy ? "policy" : authorityCritical ? "authority" : "conflict",
			...(reviewPolicy ? { policyKey: reviewPolicy.policyKey } : {}),
			title:
				reviewPolicy?.title ??
				`${authorityCritical ? "Authorize" : "Review"} ${activeStaffAgent(runtime.root, claim.staffAgentId)?.displayName ?? "agent"} Company File changes`,
			...(reviewPolicy ? { reviewerStaffIds: reviewPolicy.reviewerStaffIds } : {}),
			objects,
			primary,
		});
	} catch (error) {
		if (renewalTimer) clearInterval(renewalTimer);
		let status: Awaited<ReturnType<CloudSessionArbiter["turnStatus"]>> | undefined;
		try {
			status = await arbiter.turnStatus(claim);
		} catch {
			// Retry once the hosted control plane is reachable again.
		}
		if (status && status !== "active" && status !== "review_pending") {
			abandonCloudSessionClaim(arbiter, child, claim);
			console.error(
				`Company File proposal could not be retained after the turn became ${status}: ${error instanceof Error ? error.message : String(error)}`,
			);
			await emitActiveStaffQueue(slot, runtime);
			return;
		}
		const delay = Math.min(10_000, 1_000 * 2 ** Math.min(attempt, 4));
		if (attempt === 0) {
			console.error(
				`Company File proposal submission deferred: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		setTimeout(() => {
			void submitCloudSessionProposal(
				slot,
				runtime,
				child,
				checkout,
				proposalHead,
				arbiter,
				claim,
				reviewPolicy,
				attempt + 1,
			);
		}, delay).unref();
		return;
	} finally {
		if (renewalTimer) clearInterval(renewalTimer);
	}
	abandonCloudSessionClaim(arbiter, child, claim);
	await emitActiveStaffQueue(slot, runtime);
}
function startCloudRealtimeSync(slot: Slot, runtime: CompanyRuntime): void {
	if (runtime.cloudRealtimeSync || runtime.closing) return;
	const attachment = profileAttachment(runtime.root);
	const transport = qorperaAccountAuth?.hostedRealtime();
	if (attachment.profileType !== "cloud" || !transport || !currentQorperaAccountId) return;
	runtime.cloudRealtimeSync = new CloudProfileRealtimeSync({
		profileId: attachment.profileId,
		transport,
		onChange: (change: CloudRealtimeChange) => {
			if (runtime.closing) return;
			if (change.resource === "trail") {
				triggerCloudTrailSync(runtime);
				void emitActiveStaffQueue(slot, runtime);
			} else if (change.resource === "staff") triggerCloudStaffSync(runtime);
			else if (change.resource === "company-file") void runtime.cloudCompanyPublication?.publishNow();
			else triggerHostedAccessRefresh(attachment.profileId, change.subjectUserId);
		},
		onHealth: (health) => recordCloudRealtimeHealth(runtime, health),
	});
	runtime.cloudRealtimeSync.start();
}

/** One window = one slot: the hub while `runtime` is unset, a company
 * agent runtime once one is open. All per-company state hangs off the slot so
 * companies never share a child, a backend, or a kickoff flag. */
interface Slot {
	window: BrowserWindow;
	rendererSession: Session;
	/** The window's session partition. A WebContents can never change session,
	 * so when a slot must move to a different company partition, openCompany
	 * replaces the window and updates this alongside it. */
	partition: string;
	runtime?: CompanyRuntime;
	kickoffPending: boolean;
	openGeneration: number;
}

const FIXED_SHELL_DIR = join(DIRNAME, "userland");

function detachCloudProfileLocally(userId: string, profileId: string): void {
	const userData = app.getPath("userData");
	for (const company of listCompanies()) {
		const attachment = readProfileAttachment(userData, company.root);
		if (attachment?.profileType !== "cloud" || attachment.profileId !== profileId) continue;
		if (slotForCompany(company.root)) continue; // an open window keeps its runtime; the hub refresh reflects the loss
		unregisterCompany(company.root);
		forgetCompany(userData, userId, company.root);
		forgetCompanyIcon(userData, userId, company.root);
		forgetProfileAttachment(userData, company.root);
	}
}

const HIDDEN_CLOUD_PROFILES_SCHEMA = "qorpera.hidden-cloud-profiles/v1";

function hiddenCloudProfilesPath(userData: string): string {
	return join(userData, "hidden-cloud-profiles.json");
}

function readHiddenCloudProfiles(userData: string, accountId: string): Set<string> {
	try {
		const parsed = JSON.parse(readFileSync(hiddenCloudProfilesPath(userData), "utf8")) as {
			schema?: string;
			accounts?: Record<string, string[]>;
		};
		if (parsed.schema !== HIDDEN_CLOUD_PROFILES_SCHEMA) return new Set();
		const ids = parsed.accounts?.[accountId];
		return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

// Window/taskbar icon: company appearance is machine-local account state,
// never company-authored executable or UI content.
const DEFAULT_ICON = join(DIRNAME, "assets", process.platform === "win32" ? "qorpera.ico" : "qorpera.png");
const TITLE_BAR_OVERLAY = { color: "#ffffff", symbolColor: "#111111", height: 48 } as const;

function companyWindowIcon(root: string): string | NativeImage {
	if (!currentQorperaAccountId) return DEFAULT_ICON;
	const iconId = readCompanyIcon(app.getPath("userData"), currentQorperaAccountId, root);
	return iconId.startsWith("data:") ? nativeImage.createFromDataURL(iconId) : DEFAULT_ICON;
}

function setWindowIcon(win: BrowserWindow, icon: string | NativeImage): void {
	try {
		win.setIcon(icon);
	} catch {
		// an unreadable/corrupt image must never take the window down
	}
}

function setSettingsTitleBarOverlay(win: BrowserWindow, active: boolean): void {
	try {
		win.setTitleBarOverlay({
			...TITLE_BAR_OVERLAY,
			color: active ? "#8e8e8d" : TITLE_BAR_OVERLAY.color,
			symbolColor: active ? "#3e3e3c" : TITLE_BAR_OVERLAY.symbolColor,
		});
	} catch {
		// Native title-bar overlays are available on Windows and Linux only.
	}
}
/** Children we killed on purpose (session switch/close) — their exits are not news. */
const intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>();
/** Every agent child still running, across all slots — quit reaps these
 * synchronously because window-close teardown is async and quit won't wait. */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
const childBindings = new WeakMap<ChildProcessWithoutNullStreams, TrailBinding>();
const childProfileTypes = new WeakMap<ChildProcessWithoutNullStreams, ProfileAttachment["profileType"]>();
const childIntentSigners = new WeakMap<
	ChildProcessWithoutNullStreams,
	(frame: Record<string, unknown>, attended: boolean, execution?: KernelExecutionIdentity) => KernelIntentCapability
>();
const childModelCapabilities = new WeakMap<ChildProcessWithoutNullStreams, BrokeredCredentials>();
const childHttpBrokers = new WeakMap<ChildProcessWithoutNullStreams, HttpRequestBroker>();
const childComputerBrokers = new WeakMap<ChildProcessWithoutNullStreams, ComputerBroker>();
const childCompanyOperationBrokers = new WeakMap<ChildProcessWithoutNullStreams, CompanyOperationBroker>();
const childDurableExecutions = new WeakMap<ChildProcessWithoutNullStreams, KernelExecutionIdentity>();
const childCompanyExecutions = new WeakMap<ChildProcessWithoutNullStreams, CloudCompanyExecutionCheckout>();
const childOutputsRequireReview = new WeakSet<ChildProcessWithoutNullStreams>();
type TriggerWorkerContext =
	| { kind: "build"; buildId: string }
	| { kind: "check"; jobId: string; triggerId: string; adapterId: string; event: string };
const childTriggerWorkers = new WeakMap<ChildProcessWithoutNullStreams, TriggerWorkerContext>();
/** True between a delivered kernel prompt and the next agent_settled — a
 * founder turn in flight. Wakes must never preempt it. */
const childBusy = new WeakMap<ChildProcessWithoutNullStreams, boolean>();
const childApprovedGates = new WeakMap<ChildProcessWithoutNullStreams, Set<string>>();
/** Bounded delegation-graph position of a live room participant turn. */
const childRoomDelegationContexts = new WeakMap<ChildProcessWithoutNullStreams, RoomDelegationContext>();
const childCheckpointCompletion = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const childExecutorIds = new WeakMap<ChildProcessWithoutNullStreams, string>();
const childAttachmentSequences = new WeakMap<ChildProcessWithoutNullStreams, number>();
const childSessionPlanes = new WeakMap<ChildProcessWithoutNullStreams, SessionControlPlane>();
const childRuntimeReady = new WeakSet<ChildProcessWithoutNullStreams>();
interface ChildReadiness {
	promise: Promise<boolean>;
	resolve: (ready: boolean) => void;
	settled: boolean;
}
const childReadiness = new WeakMap<ChildProcessWithoutNullStreams, ChildReadiness>();
type StaffConnectionRequestToolInput = Omit<CreateConnectionRequestInput, "staffAgentId" | "sessionFile">;
interface StaffArtifactObservationToolInput {
	artifactId: string;
	update: CompanyArtifactObservationUpdate;
}
interface StaffArtifactSourceAssessmentToolInput {
	artifactId: string;
	update: CompanyArtifactSourceAssessmentUpdate;
}
interface StaffArtifactSourceIssueToolInput {
	artifactId: string;
	update: CompanyArtifactSourceIssueUpdate;
}
const KERNEL_INSTANCE_ID = randomUUID();
const sessionControlPlanes = new Map<string, SessionControlPlane>();

function trackChildReadiness(child: ChildProcessWithoutNullStreams): void {
	let resolveReadiness: (ready: boolean) => void = () => {};
	const promise = new Promise<boolean>((resolvePromise) => {
		resolveReadiness = resolvePromise;
	});
	childReadiness.set(child, { promise, resolve: resolveReadiness, settled: false });
}

function settleChildReadiness(child: ChildProcessWithoutNullStreams, ready: boolean): void {
	const state = childReadiness.get(child);
	if (!state || state.settled) return;
	state.settled = true;
	state.resolve(ready);
}

async function waitForChildReadiness(child: ChildProcessWithoutNullStreams): Promise<boolean> {
	if (childRuntimeReady.has(child)) return true;
	const state = childReadiness.get(child);
	if (!state) return false;
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			state.promise,
			new Promise<boolean>((resolvePromise) => {
				timeout = setTimeout(() => resolvePromise(false), 15_000);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function recordSessionRuntime(
	sessions: SessionControlPlane,
	binding: TrailBinding,
	event: SessionRuntimeEventInput,
): boolean {
	try {
		sessions.record(binding, event);
		return true;
	} catch (error) {
		console.error(`session runtime observation failed: ${(error as Error).message}`);
		try {
			sessions.observePersistenceFailure(binding, event.executorId);
		} catch (projectionError) {
			console.error(`session runtime degraded-state update failed: ${(projectionError as Error).message}`);
		}
		return false;
	}
}

function observeSessionActivity(
	sessions: SessionControlPlane,
	binding: TrailBinding,
	executorId: string,
	activity: SessionRuntimeActivity,
): void {
	try {
		sessions.observeActivity(binding, executorId, activity);
	} catch (error) {
		// Activity narration is deliberately ephemeral. Losing one beat must not
		// stop intelligence; the next lifecycle fact remains durable authority.
		console.error(`session activity observation failed: ${(error as Error).message}`);
	}
}

const slots = new Map<number, Slot>();

function slotsForHostedProfile(profileId: string): Slot[] {
	return [...slots.values()].filter((slot) => {
		const root = slot.runtime?.root;
		if (!root) return false;
		const attachment = profileAttachment(root);
		return attachment.profileType === "cloud" && attachment.profileId === profileId;
	});
}

async function suspendHostedProfileSlots(profileId: string, message: string, detail: string): Promise<void> {
	for (const slot of slotsForHostedProfile(profileId)) {
		await showHub(slot);
		if (slot.window.isDestroyed()) continue;
		await dialog.showMessageBox(slot.window, {
			type: "warning",
			title: "Cloud profile access changed",
			message,
			detail,
		});
	}
}

function triggerHostedAccessRefresh(profileId: string, subjectUserId?: string): void {
	const accountId = currentQorperaAccountId;
	if (!accountId) return;
	let accessRefresh = hostedAccessRefreshes.get(profileId);
	if (!accessRefresh) {
		let suspendRuntimes = false;
		accessRefresh = new CloudProfileAccessRefresh({
			refresh: async () => {
				if (currentQorperaAccountId !== accountId) throw new Error("Qorpera account changed during access refresh");
				const previous = hostedTeamsByProfileId.get(profileId);
				const profiles = await refreshHostedProfiles();
				if (!profiles.some((profile) => profile.profileId === profileId)) return "revoked";
				const team = await refreshHostedTeam(profileId);
				suspendRuntimes ||= previous?.capabilities.write === true && !team.capabilities.write;
				return "active";
			},
			onRestricted: () => {
				if (currentQorperaAccountId === accountId) restrictedHostedAccessProfileIds.add(profileId);
			},
			onActive: async () => {
				if (currentQorperaAccountId !== accountId) return;
				restrictedHostedAccessProfileIds.delete(profileId);
				if (suspendRuntimes) {
					suspendRuntimes = false;
					await suspendHostedProfileSlots(
						profileId,
						"This profile is now read-only for your account.",
						"Any running agent was stopped. You can reopen the profile to read its shared activity.",
					);
					return;
				}
				for (const slot of slotsForHostedProfile(profileId)) {
					if (!slot.runtime) continue;
					triggerCloudStaffSync(slot.runtime);
					triggerCloudTrailSync(slot.runtime);
					installCloudCompanySync(slot.runtime);
				}
			},
			onRevoked: async () => {
				if (currentQorperaAccountId !== accountId) return;
				hostedProfilesById.delete(profileId);
				hostedTeamsByProfileId.delete(profileId);
				freshHostedTeamProfileIds.delete(profileId);
				restrictedHostedAccessProfileIds.add(profileId);
				await suspendHostedProfileSlots(
					profileId,
					"Your access to this cloud profile was removed.",
					"Cloud synchronization and running agents were stopped. The managed Company File cache remains on this computer.",
				);
			},
			onError: (error) => {
				if (currentQorperaAccountId !== accountId) return;
				console.error(
					`cloud access refresh failed closed: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		});
		hostedAccessRefreshes.set(profileId, accessRefresh);
	}
	const restrict = subjectUserId === undefined || subjectUserId === accountId;
	void accessRefresh.trigger(restrict).catch((error) => {
		console.error(`cloud access transition failed: ${error instanceof Error ? error.message : String(error)}`);
	});
}

/** A company root is a folder carrying a company manifest. Anything else
 * must never be registered or started
 * (a bad argv token once created a "company" named after a Chromium switch). */
function isCompanyRoot(root: string): boolean {
	try {
		return existsSync(join(root, COMPANY_MANIFEST_RELATIVE_PATH));
	} catch {
		return false;
	}
}

function profileNameSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function newCompanyRoot(name: string): string {
	const slug = profileNameSlug(name);
	if (!slug) throw new Error("Profile name is invalid.");
	const home = process.platform === "win32" ? "C:\\Companies" : join(app.getPath("home"), "Companies");
	return join(home, slug);
}

interface PendingCompanyCreationEnvelope {
	schema: "qorpera.pending-company-creation/v1";
	clientCreationId: string;
	companyName: string;
	companyIcon: CompanyIconId;
	createdAt: string;
}

function pendingCompanyCreationPath(userData: string, accountId: string): string {
	return join(userData, "pending-company-creations", `${accountId}.json`);
}

function readPendingCompanyCreation(userData: string, accountId: string): PendingCompanyCreationEnvelope | undefined {
	try {
		const value = JSON.parse(
			readFileSync(pendingCompanyCreationPath(userData, accountId), "utf-8"),
		) as Partial<PendingCompanyCreationEnvelope>;
		if (
			value.schema !== "qorpera.pending-company-creation/v1" ||
			typeof value.clientCreationId !== "string" ||
			!UUID_PATTERN.test(value.clientCreationId) ||
			typeof value.companyName !== "string" ||
			!value.companyName.trim() ||
			value.companyName.length > 120 ||
			!isCompanyIconId(value.companyIcon) ||
			typeof value.createdAt !== "string" ||
			!Number.isFinite(Date.parse(value.createdAt))
		) {
			return undefined;
		}
		return value as PendingCompanyCreationEnvelope;
	} catch {
		return undefined;
	}
}

function persistPendingCompanyCreation(
	userData: string,
	accountId: string,
	envelope: PendingCompanyCreationEnvelope,
): void {
	const path = pendingCompanyCreationPath(userData, accountId);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function cloudCompanyCacheRoot(profile: HostedProfile): string {
	return `${newCompanyRoot(profile.profileName)}-${profile.profileId.slice(0, 8)}`;
}

interface CloudCacheMaterializationMarker {
	schema: "qorpera.cloud-cache-materialization/v1";
	profileId: string;
	environmentId: string;
	root: string;
}

function cloudCacheStaging(root: string): { parent: string; tree: string; marker: string } {
	const parent = `${resolve(root)}.qorpera-materializing`;
	return { parent, tree: join(parent, "Company File"), marker: join(parent, "owner.json") };
}

function ownedCloudCacheStaging(root: string, profile: HostedProfile): boolean {
	const staging = cloudCacheStaging(root);
	try {
		const marker = JSON.parse(readFileSync(staging.marker, "utf-8")) as Partial<CloudCacheMaterializationMarker>;
		return (
			marker.schema === "qorpera.cloud-cache-materialization/v1" &&
			marker.profileId === profile.profileId &&
			marker.environmentId === profile.environmentId &&
			marker.root === resolve(root)
		);
	} catch {
		return false;
	}
}

function alignManagedCloudCompanyName(root: string, profile: HostedProfile): void {
	if (!alignCloudCompanyManifestName(root, profile.profileName)) return;
	commitCompanyMaterialization(root, [COMPANY_MANIFEST_RELATIVE_PATH]);
}

async function materializeManagedCloudCache(
	root: string,
	profile: HostedProfile,
	objects: CloudContentAddressedStore,
	sourceSnapshot?: HostedCompanySnapshot,
): Promise<string> {
	const target = resolve(root);
	const staging = cloudCacheStaging(target);
	if (existsSync(staging.parent)) {
		if (!ownedCloudCacheStaging(target, profile)) {
			throw new Error(`The managed Company File staging path is already in use: ${staging.parent}`);
		}
		if (existsSync(target) && isCompanyRoot(target)) {
			alignManagedCloudCompanyName(target, profile);
			return target;
		}
		rmSync(staging.parent, { recursive: true, force: true });
	}
	if (existsSync(target)) throw new Error(`The managed Company File cache path already exists: ${target}`);
	mkdirSync(staging.parent, { recursive: true });
	writeFileSync(
		staging.marker,
		`${JSON.stringify({
			schema: "qorpera.cloud-cache-materialization/v1",
			profileId: profile.profileId,
			environmentId: profile.environmentId,
			root: target,
		} satisfies CloudCacheMaterializationMarker)}\n`,
		{ encoding: "utf-8", mode: 0o600, flag: "wx" },
	);
	if (sourceSnapshot) {
		await materializeCloudCompanyTree(
			staging.tree,
			profile.profileId,
			currentCloudCompanyTreeReference(sourceSnapshot.tree),
			objects,
		);
	}
	const scaffolded = scaffoldCompany(staging.tree);
	if (resolve(scaffolded.root) !== resolve(staging.tree)) throw new Error("Cloud cache scaffold moved unexpectedly");
	alignManagedCloudCompanyName(scaffolded.root, profile);
	renameSync(staging.tree, target);
	return target;
}

function finishManagedCloudCacheMaterialization(root: string, profile: HostedProfile): void {
	const staging = cloudCacheStaging(root);
	if (existsSync(staging.parent) && ownedCloudCacheStaging(root, profile)) {
		rmSync(staging.parent, { recursive: true, force: true });
	}
}

/**
 * Extract the `--company` root from an argv. Trusts `--company=<root>` first;
 * the positional form only if its value is not a switch. Chromium's
 * single-instance forwarding REORDERS argv (switches first, plain args last)
 * and appends its own switches — the observed result being `--company`
 * followed by `--allow-file-access-from-files` while the real root sits at
 * the tail. Recover it from there, gated on it actually being a company.
 */
function companyFromArgv(argv: string[]): string | undefined {
	for (const arg of argv) {
		if (arg.startsWith("--company=") && arg.length > "--company=".length) {
			const value = arg.slice("--company=".length);
			if (!value.startsWith("-")) return value;
		}
	}
	const index = argv.indexOf("--company");
	if (index < 0) return undefined;
	const next = argv[index + 1];
	if (next && !next.startsWith("-")) return next;
	for (let tail = argv.length - 1; tail > 0; tail--) {
		const candidate = argv[tail];
		if (!candidate.startsWith("-") && isCompanyRoot(candidate)) return candidate;
	}
	return undefined;
}

/** `--company <root>` delivered to the first window's renderer exactly once —
 * later hub windows must not re-open the launcher's company. */
let pendingCompany: string | undefined = companyFromArgv(process.argv);

function slotOf(sender: WebContents): Slot | undefined {
	const win = BrowserWindow.fromWebContents(sender);
	return win ? slots.get(win.id) : undefined;
}

function isTrustedHubSender(sender: WebContents): boolean {
	const slot = slotOf(sender);
	if (!slot || slot.runtime) return false;
	try {
		return normalizedRoot(fileURLToPath(sender.getURL())) === normalizedRoot(join(FIXED_SHELL_DIR, "index.html"));
	} catch {
		return false;
	}
}

/** Windows compares paths case-insensitively; launcher argv and the registry
 * may disagree on casing for the same folder. */
function normalizedRoot(root: string): string {
	let resolved: string;
	try {
		resolved = canonicalCompanyRoot(root);
	} catch {
		resolved = resolve(root);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function slotForCompany(root: string): Slot | undefined {
	const wanted = normalizedRoot(root);
	for (const slot of slots.values()) {
		if (slot.runtime && normalizedRoot(slot.runtime.root) === wanted) return slot;
	}
	return undefined;
}

function focusWindow(win: BrowserWindow): void {
	// A background company's window is hidden, not closed; every path that
	// surfaces a window must be able to bring it back, not just the tray.
	if (!win.isVisible()) win.show();
	if (win.isMinimized()) win.restore();
	win.focus();
}

/**
 * Machine-local background execution: an opted-in company keeps its runtime —
 * wake ticker, queued room deliveries, coworker mail, delegation — alive with
 * its window hidden instead of closing. A tray icon owns the hidden windows,
 * and login-start keeps the schedule running across reboots while any
 * company on this machine is opted in.
 */
let appQuitting = false;
let backgroundTray: Tray | undefined;

function backgroundCompanyEnabled(root: string): boolean {
	const wanted = normalizedRoot(root);
	return readBackgroundCompanyRoots(app.getPath("userData")).some((candidate) => normalizedRoot(candidate) === wanted);
}

function syncBackgroundLoginItem(roots: readonly string[]): void {
	if (process.platform !== "win32" && process.platform !== "darwin") return;
	try {
		app.setLoginItemSettings({ openAtLogin: roots.length > 0 });
	} catch (error) {
		console.error(`background login-item update failed: ${(error as Error).message}`);
	}
}

function showBackgroundWindows(): void {
	let focused = false;
	for (const slot of slots.values()) {
		if (slot.window.isDestroyed()) continue;
		if (!slot.window.isVisible()) slot.window.show();
		if (!focused) {
			focusWindow(slot.window);
			focused = true;
		}
	}
	syncBackgroundTray();
}

function syncBackgroundTray(): void {
	const hiddenBackground = [...slots.values()].some(
		(slot) =>
			slot.runtime &&
			!slot.runtime.closing &&
			!slot.window.isDestroyed() &&
			!slot.window.isVisible() &&
			backgroundCompanyEnabled(slot.runtime.root),
	);
	if (hiddenBackground && !backgroundTray) {
		try {
			backgroundTray = new Tray(DEFAULT_ICON);
			backgroundTray.setToolTip("Qorpera Base — background companies are running");
			backgroundTray.setContextMenu(
				Menu.buildFromTemplate([
					{ label: "Open Qorpera Base", click: () => showBackgroundWindows() },
					{ type: "separator" },
					{ label: "Quit Qorpera Base", click: () => app.quit() },
				]),
			);
			backgroundTray.on("click", () => showBackgroundWindows());
		} catch (error) {
			console.error(`background tray could not start: ${(error as Error).message}`);
		}
	} else if (!hiddenBackground && backgroundTray) {
		backgroundTray.destroy();
		backgroundTray = undefined;
	}
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

interface KernelReviewImage {
	mimeType: string;
	data: string;
	sha256: string;
	bytes: number;
}

async function confirmKernelReview(
	parent: BrowserWindow,
	input: {
		title: string;
		summary: string;
		exactText: string;
		metadata?: string;
		images?: KernelReviewImage[];
	},
): Promise<boolean> {
	if (parent.isDestroyed()) return false;
	const images = input.images ?? [];
	const imageMarkup = images
		.map(
			(image) =>
				`<figure><img src="data:${escapeHtml(image.mimeType)};base64,${image.data}" alt="Prompt attachment"><figcaption>${escapeHtml(image.mimeType)} · ${image.bytes} bytes · sha256 ${image.sha256}</figcaption></figure>`,
		)
		.join("");
	const metadata = input.metadata ? `<pre class="metadata">${escapeHtml(input.metadata)}</pre>` : "";
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(input.title)}</title><style>body{margin:0;background:#111;color:#eee;font:14px system-ui,sans-serif}main{padding:22px}.summary{font-weight:650;margin:0 0 14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1d1d1d;border:1px solid #444;border-radius:6px;padding:14px;max-height:38vh;overflow:auto}.metadata{max-height:16vh;color:#bbb}figure{margin:14px 0;border:1px solid #444;padding:10px;border-radius:6px}img{display:block;max-width:100%;max-height:36vh;margin:auto}figcaption{margin-top:8px;color:#bbb;overflow-wrap:anywhere}.actions{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:10px;padding-top:16px;background:#111}.button{color:#eee;text-decoration:none;border:1px solid #666;border-radius:5px;padding:9px 16px}.approve{background:#f2f2f2;color:#111}</style></head><body><main><p class="summary">${escapeHtml(input.summary)}</p>${metadata}<pre>${escapeHtml(input.exactText)}</pre>${imageMarkup}<div class="actions"><a class="button" href="qorpera-kernel-review://cancel">Cancel</a><a class="button approve" href="qorpera-kernel-review://approve">Authorize exact content</a></div></main></body></html>`;
	const review = new BrowserWindow({
		parent,
		modal: true,
		show: false,
		width: 820,
		height: 720,
		title: input.title,
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	review.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	return new Promise<boolean>((resolvePromise) => {
		let settled = false;
		const settle = (approved: boolean) => {
			if (settled) return;
			settled = true;
			resolvePromise(approved);
			if (!review.isDestroyed()) review.close();
		};
		review.webContents.on("will-navigate", (event, url) => {
			if (url === "qorpera-kernel-review://approve" || url === "qorpera-kernel-review://cancel") {
				event.preventDefault();
				settle(url.endsWith("//approve"));
			}
		});
		review.once("closed", () => settle(false));
		review.once("ready-to-show", () => review.show());
		void review.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => settle(false));
	});
}

async function promptKernelSecret(
	parent: BrowserWindow,
	input: { title: string; summary: string; label: string },
): Promise<string | undefined> {
	if (parent.isDestroyed()) return undefined;
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(input.title)}</title><style>body{margin:0;background:#f7f7f5;color:#171716;font:14px system-ui,sans-serif}main{padding:24px}p{margin:0 0 18px;color:#5e5e5a;line-height:1.45}label{display:block;margin-bottom:7px;font-weight:650}input{box-sizing:border-box;width:100%;height:40px;border:1px solid #b8b8b3;border-radius:6px;background:#fff;padding:0 10px;font:14px system-ui,sans-serif;outline:none}input:focus{border-color:#171716}.actions{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}.button,button{box-sizing:border-box;border:1px solid #aaa9a4;border-radius:5px;background:#fff;color:#171716;padding:9px 15px;font:13px system-ui,sans-serif}.submit{border-color:#171716;background:#171716;color:#fff}</style></head><body><main><p>${escapeHtml(input.summary)}</p><form autocomplete="off"><label for="credential">${escapeHtml(input.label)}</label><input id="credential" type="password" required maxlength="32768" autocomplete="new-password" spellcheck="false" autofocus><div class="actions"><button class="button" id="cancel" type="button">Cancel</button><button class="submit" type="submit">Continue</button></div></form></main></body></html>`;
	const prompt = new BrowserWindow({
		parent,
		modal: true,
		show: false,
		width: 520,
		height: 300,
		title: input.title,
		autoHideMenuBar: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	prompt.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	return new Promise<string | undefined>((resolvePromise) => {
		let settled = false;
		const settle = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			resolvePromise(value);
			if (!prompt.isDestroyed()) prompt.close();
		};
		prompt.webContents.on("will-navigate", (event) => event.preventDefault());
		prompt.webContents.once("did-finish-load", () => {
			void prompt.webContents
				.executeJavaScript(
					`new Promise((resolve) => {
						const form = document.querySelector("form");
						const credential = document.querySelector("#credential");
						const cancel = document.querySelector("#cancel");
						form.addEventListener("submit", (event) => {
							event.preventDefault();
							resolve(credential.value);
						}, { once: true });
						cancel.addEventListener("click", () => resolve(null), { once: true });
					})`,
					true,
				)
				.then((value: unknown) => {
					const secret = typeof value === "string" ? value : undefined;
					if (
						secret === undefined ||
						!secret ||
						secret !== secret.trim() ||
						/[\u0000-\u001f\u007f]/.test(secret) ||
						Buffer.byteLength(secret, "utf-8") > 32 * 1024
					) {
						settle(undefined);
						return;
					}
					settle(secret);
				})
				.catch(() => settle(undefined));
		});
		prompt.once("closed", () => settle(undefined));
		prompt.once("ready-to-show", () => prompt.show());
		void prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => settle(undefined));
	});
}

interface ReviewedPromptFrame {
	type: "prompt" | "steer" | "follow_up";
	message: string;
	/** Renderer-visible text before host-added private execution context. */
	displayText?: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	streamingBehavior?: "steer" | "followUp";
	clientInputId?: string;
	executionSponsor?: ReviewedExecutionSponsor;
}

function reviewedPromptFrame(value: Record<string, unknown>): ReviewedPromptFrame | undefined {
	if (value.type !== "prompt" && value.type !== "steer" && value.type !== "follow_up") return undefined;
	if (typeof value.message !== "string" || Buffer.byteLength(value.message, "utf-8") > MAX_PROMPT_BYTES) {
		return undefined;
	}
	if (
		value.displayText !== undefined &&
		(typeof value.displayText !== "string" || Buffer.byteLength(value.displayText, "utf-8") > MAX_PROMPT_BYTES)
	) {
		return undefined;
	}
	const allowed = new Set([
		"type",
		"message",
		"displayText",
		"images",
		"streamingBehavior",
		"clientInputId",
		"executionSponsor",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
	if (
		value.clientInputId !== undefined &&
		(typeof value.clientInputId !== "string" || !UUID_PATTERN.test(value.clientInputId))
	) {
		return undefined;
	}
	if (
		value.streamingBehavior !== undefined &&
		(value.type !== "prompt" || (value.streamingBehavior !== "steer" && value.streamingBehavior !== "followUp"))
	)
		return undefined;
	let images: ReviewedPromptFrame["images"];
	let executionSponsor: ReviewedExecutionSponsor | undefined;
	if (value.executionSponsor !== undefined) {
		if (value.type !== "prompt") return undefined;
		if (
			!value.executionSponsor ||
			typeof value.executionSponsor !== "object" ||
			Array.isArray(value.executionSponsor)
		) {
			return undefined;
		}
		const sponsor = value.executionSponsor as Record<string, unknown>;
		if (
			Object.keys(sponsor).some(
				(key) => !["sponsorBindingId", "sponsorVersion", "computeIdentityId", "workerClass"].includes(key),
			) ||
			typeof sponsor.sponsorBindingId !== "string" ||
			!UUID_PATTERN.test(sponsor.sponsorBindingId) ||
			!Number.isSafeInteger(sponsor.sponsorVersion) ||
			(sponsor.sponsorVersion as number) < 1 ||
			typeof sponsor.computeIdentityId !== "string" ||
			!UUID_PATTERN.test(sponsor.computeIdentityId) ||
			(sponsor.workerClass !== "managed_sandbox" && sponsor.workerClass !== "company_computer")
		) {
			return undefined;
		}
		executionSponsor = {
			sponsorBindingId: sponsor.sponsorBindingId,
			sponsorVersion: sponsor.sponsorVersion as number,
			computeIdentityId: sponsor.computeIdentityId,
			workerClass: sponsor.workerClass,
		};
	}
	if (value.images !== undefined) {
		if (!Array.isArray(value.images) || value.images.length > MAX_PROMPT_IMAGES) return undefined;
		images = [];
		let totalImageBytes = 0;
		for (const image of value.images) {
			if (!image || typeof image !== "object") return undefined;
			if (Object.keys(image).some((key) => key !== "type" && key !== "data" && key !== "mimeType")) {
				return undefined;
			}
			const candidate = image as {
				type?: unknown;
				data?: unknown;
				mimeType?: unknown;
			};
			if (
				candidate.type !== "image" ||
				typeof candidate.data !== "string" ||
				typeof candidate.mimeType !== "string" ||
				!REVIEW_IMAGE_TYPES.has(candidate.mimeType) ||
				!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(candidate.data)
			)
				return undefined;
			const decoded = Buffer.from(candidate.data, "base64");
			if (
				decoded.length === 0 ||
				decoded.length > MAX_PROMPT_IMAGE_BYTES ||
				decoded.toString("base64") !== candidate.data
			)
				return undefined;
			totalImageBytes += decoded.length;
			if (totalImageBytes > MAX_PROMPT_IMAGE_BYTES) return undefined;
			images.push({
				type: "image",
				data: candidate.data,
				mimeType: candidate.mimeType,
			});
		}
	}
	return {
		type: value.type,
		message: value.message,
		...(typeof value.displayText === "string" ? { displayText: value.displayText } : {}),
		...(images && images.length > 0 ? { images } : {}),
		...(value.streamingBehavior ? { streamingBehavior: value.streamingBehavior } : {}),
		...(typeof value.clientInputId === "string" ? { clientInputId: value.clientInputId } : {}),
		...(executionSponsor ? { executionSponsor } : {}),
	};
}

function send(win: BrowserWindow, channel: string, payload: unknown): void {
	// Child exit events can fire after the window is gone (closing a window
	// kills its RPC child, whose exit handler then calls send) — guard.
	if (win.isDestroyed() || win.webContents.isDestroyed()) return;
	win.webContents.send(channel, payload);
}

function sendAll(channel: string, payload: unknown): void {
	for (const slot of slots.values()) send(slot.window, channel, payload);
}

function setFoundationUpdateState(state: FoundationUpdateState): void {
	foundationUpdateState = state;
	sendAll("update-state", state);
	sendAll("update-status", state.message);
}

function invitationRoleDescription(role: HostedIncomingProfileInvitation["role"]): string {
	if (role === "admin") return "Admin — contribute, authorize actions, and manage members";
	if (role === "contributor") return "Contributor — contribute and communicate without authorizing actions";
	return "Viewer — read-only access";
}

function invitationHub(): Slot {
	const existing = [...slots.values()].find((slot) => !slot.runtime);
	return existing ?? createWindow();
}

function scheduleProfileInvitationHandoff(slot: Slot): void {
	const start = (): void => {
		setTimeout(() => void presentPendingProfileInvitation(slot), 0);
	};
	if (slot.window.webContents.isLoading()) slot.window.webContents.once("did-finish-load", start);
	else start();
}

function queueProfileInvitationHandoff(invitationId: string): void {
	pendingProfileInvitationId = invitationId;
	if (!app.isReady() || !qorperaAccountAuth) return;
	const hub = invitationHub();
	focusWindow(hub.window);
	scheduleProfileInvitationHandoff(hub);
}

function queueProfileInvitationProtocolUrl(value: string): boolean {
	const invitationId = profileInvitationIdFromProtocolUrl(value);
	if (!invitationId) return false;
	queueProfileInvitationHandoff(invitationId);
	return true;
}

async function presentPendingProfileInvitation(preferredHub?: Slot): Promise<void> {
	const invitationId = pendingProfileInvitationId;
	if (!invitationId || profileInvitationHandoffInFlight) return;
	const hub = preferredHub && !preferredHub.runtime ? preferredHub : invitationHub();
	profileInvitationHandoffInFlight = true;
	try {
		const account = await authenticatedAccount();
		if (!account?.user) {
			send(hub.window, "account-status", "Sign in with the invited email to preview this profile invitation.");
			return;
		}
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!primary) return;
		let invitation: HostedIncomingProfileInvitation | undefined;
		try {
			invitation = (await primary.listInvitations()).find((candidate) => candidate.id === invitationId);
		} catch {
			await dialog.showMessageBox(hub.window, {
				type: "error",
				title: "Invitation unavailable",
				message: "Qorpera could not load this invitation.",
				detail: "Check your connection and open the invitation link again.",
			});
			return;
		}
		if (pendingProfileInvitationId !== invitationId) return;
		if (!invitation) {
			pendingProfileInvitationId = undefined;
			await dialog.showMessageBox(hub.window, {
				type: "info",
				title: "Invitation unavailable",
				message: "This invitation is not available for the signed-in account.",
				detail: "It may have expired, been cancelled, already been used, or been sent to another email address.",
			});
			return;
		}
		const decision = await dialog.showMessageBox(hub.window, {
			type: "question",
			title: "Profile invitation",
			buttons: ["Accept invitation", "Not now"],
			defaultId: 1,
			cancelId: 1,
			message: `Join ${invitation.profileName}?`,
			detail: `${invitationRoleDescription(invitation.role)}\n\nInvited account: ${account.user.email}`,
		});
		if (pendingProfileInvitationId !== invitationId) return;
		pendingProfileInvitationId = undefined;
		if (decision.response !== 0) return;
		try {
			await primary.acceptInvitation(invitationId);
			await refreshHostedProfiles();
			await hub.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
		} catch {
			await dialog.showMessageBox(hub.window, {
				type: "error",
				title: "Invitation not accepted",
				message: "Qorpera could not accept this invitation.",
				detail: "No access was changed. Open the invitation link and try again.",
			});
		}
	} finally {
		profileInvitationHandoffInFlight = false;
		if (pendingProfileInvitationId && pendingProfileInvitationId !== invitationId) {
			scheduleProfileInvitationHandoff(invitationHub());
		}
	}
}

async function closeCompany(slot: Slot): Promise<void> {
	if (!slot.runtime) return;
	const runtime = slot.runtime;
	if (runtime.closePromise) {
		await runtime.closePromise;
		return;
	}
	runtime.closing = true;
	runtime.closePromise = (async () => {
		try {
			if (runtime.cloudSessionPump) clearInterval(runtime.cloudSessionPump);
			if (runtime.cloudPresenceHeartbeat) clearInterval(runtime.cloudPresenceHeartbeat);
			if (runtime.cloudRunnerActivityTimer) clearInterval(runtime.cloudRunnerActivityTimer);
			runtime.cloudStaffSyncLoop?.stop();
			runtime.cloudTrailSyncLoop?.stop();
			runtime.cloudCompanyPublication?.stop();
			runtime.cloudCompanyProjection?.close();
			await runtime.cloudRealtimeSync?.stop();
			await runtime.cloudPresence?.stop();
			runtime.inventoryWatcher?.close();
			runtime.webhookClose?.();
			await runtime.transitionQueue;
			if (runtime.child) await stopChild(runtime.child);
			if (runtime.wakeChild) await stopChild(runtime.wakeChild);
			runtime.backendClose?.();
			releaseCompanyRuntimeLock(runtime.runtimeLock);
		} finally {
			if (sessionControlPlanes.get(normalizedRoot(runtime.root)) === runtime.sessions) {
				sessionControlPlanes.delete(normalizedRoot(runtime.root));
			}
			if (slot.runtime === runtime) slot.runtime = undefined;
		}
	})();
	await runtime.closePromise;
	// Renderer storage survives on purpose: each company runs in its own
	// persist: partition, so cross-company isolation is the partition boundary
	// (what the old wipe-on-close provided), while a company's own prefs —
	// nav state, pane widths, the model catalog cache — come back on reopen.
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode === null) {
		intentionalKills.add(child);
		killChildTree(child);
	}
	await childCheckpointCompletion.get(child);
}

function isChildBusy(child: ChildProcessWithoutNullStreams | undefined): boolean {
	return child ? childBusy.get(child) === true : false;
}

function clearChildDurableExecution(child: ChildProcessWithoutNullStreams): void {
	childDurableExecutions.delete(child);
	const binding = childBindings.get(child);
	if (binding) bindTrailExecution(binding);
}

/** Write a frame to a child's stdin, tolerating a dead child. The child can
 * die between a frame being produced and the write landing; an unguarded
 * write then throws EPIPE (or emits it asynchronously on the stream, which
 * the per-child stdin "error" handler absorbs). A false return means the
 * child is gone and the frame was dropped. */
function writeChildFrame(child: ChildProcessWithoutNullStreams, payload: string): boolean {
	if (child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) return false;
	try {
		child.stdin.write(payload);
		return true;
	} catch {
		return false;
	}
}

/** Spawn the intelligence: the CLI's RPC mode under Electron's own Node.
 * With sessionFile, resumes that trail session; without, starts fresh.
 * Autonomous work is tagged with a session name so the trail (and the
 * Activity view) can tell agent-initiated sessions from chats.
 *
 * Product work is a role capability: product Chat roots a product-worker in
 * one assigned worktree. The general company agent never receives that capability.
 * Sessions still land in the company trail and name both department and
 * worktree so they can be restored without losing provenance. */
interface ChildOptions {
	sessionFile?: string;
	/** Initial display identity for a freshly attached session. Passed at
	 * process startup so attachment and naming cannot target different children. */
	sessionName?: string;
	/** Stable company-owned employee identity stamped into the trail header. */
	staffAgentId?: string;
	/** Durable multi-staff room whose participant trail this process carries. */
	roomId?: string;
	/** Host-built employee context appended on every process launch. */
	staffContext?: string;
	/** One-shot flags consumed by the process launched from these options. */
	freshStaffTrail?: boolean;
	autoStartStaffIntro?: boolean;
	autonomousName?: string;
	department?: ProductDepartment;
	worktree?: string;
	silent?: boolean;
	/** Kernel-stamped grouping identity ("job:<id>", "merge", a workflow run
	 * id) — how the Agents view clusters related sessions. */
	group?: string;
	/** Trail filename of the session that caused this spawn; the parent link
	 * for subagent trees. Kernel-stamped, never child-claimed. */
	parentSession?: string;
	/** Cloud revisions materialized before this child was allowed to execute. */
	companySnapshotId?: string;
	staffVersion?: number;
	/** Explicit founder-configured publication gate. Operational work omits it
	 * and publishes automatically. */
	reviewPolicy?: ExecutionReviewPolicy;
	onRpcEvent?: (frame: Record<string, unknown>) => void;
	/** Last model confirmed by this child, inherited by replacement and autonomous children. */
	model?: RuntimeModelSelection;
	/** Work-origin reasoning default. This belongs to the conversation or job, never the staff identity. */
	thinkingLevel?: ScheduledJobEffort;
	/** Host-selected tool surface for silent infrastructure workers. */
	toolNames?: string;
	/** Kernel-issued wake identity: stamped into the wake session's trail. */
	wake?: {
		id: string;
		cause: "schedule" | "founder_response" | "inbound_event" | "agent_message";
		intervalMinutes?: number;
		coalesced?: number;
	};
}

function staffAgentMessageLine(message: StaffAgentMessage, senderNames: Map<string, string>): string {
	const sender = senderNames.get(message.fromAgentId) ?? "a former coworker";
	return `- [${message.id}] from ${sender} (${message.fromAgentId}) at ${message.createdAt}${message.subject ? ` — ${message.subject}` : ""}:\n${message.body}`;
}

function staffMessagesContext(root: string, agentId: string, senderNames: Map<string, string>): string {
	let queued: StaffAgentMessage[];
	let recent: StaffAgentMessage[];
	try {
		queued = pendingStaffAgentMessages(root, agentId);
		recent = recentDeliveredStaffAgentMessages(root, agentId, 5);
	} catch {
		return "Your coworker mailbox could not be read this launch.";
	}
	const shownQueued = queued.slice(0, 12);
	const overflow = queued.length - shownQueued.length;
	if (!queued.length && !recent.length) return "You have no coworker messages.";
	return [
		...(queued.length
			? [
					"Unhandled coworker messages (act on each: do the work, reply with send_agent_message, or record why it needs nothing):",
					...shownQueued.map((message) => staffAgentMessageLine(message, senderNames)),
					...(overflow > 0 ? [`…and ${overflow} more queued messages.`] : []),
				]
			: []),
		...(recent.length
			? [
					"Recently delivered coworker messages (already shown to you once; listed for continuity):",
					...recent.map((message) => staffAgentMessageLine(message, senderNames)),
				]
			: []),
	].join("\n");
}

function staffSystemContext(root: string, agent: StaffAgent): string {
	const artifacts = readCompanyArtifacts(root).filter((artifact) => artifact.stewardAgentId === agent.id);
	const connectors = readCompanyConnectorManifests(root);
	const connectionBindings = readCompanyConnections(root);
	const routines = readScheduledJobs(root).filter((job) => job.staffAgentId === agent.id);
	const artifactInstructions = artifacts.length
		? [
				"Your owned artifacts are editable metric definitions inside your agent workspace. They describe what you care about without copying service data into the company:",
				...artifacts.map((artifact) => {
					const missing = artifact.dataNeeds
						.filter((need) => need.status === "missing")
						.map(
							(need) =>
								`${need.label} [artifactId=${artifact.id}, dataNeedId=${need.id}] (${need.connectorHints.join(", ")})`,
						)
						.join("; ");
					return `- ${artifact.relativePath}: ${artifact.title}; measures ${artifact.metrics.map((metric) => metric.label).join(", ")}${missing ? `; missing data: ${missing}` : ""}`;
				}),
				"Inspect these files at the start of relevant work. Keep metric definitions, scores, values, timestamps, and evidence references honest. Change, add, or remove metrics and data needs when the company's circumstances make the starter assumptions wrong.",
				"Artifact JSON uses a closed schema. Data-need status is only missing, selected, connected, available, or declined. Artifact status is only setting-up, waiting-for-data, partial, validating, or operating. Put file and connector evidence only in sourceRefs; never invent fields such as intakeRef, selection, or waiting-for-data on a data need. Re-read the artifact after editing it and repair any invalid value before ending the turn.",
				"Treat each missing data need as a setup plan: first use existing company files and usable connections, then propose only the smallest missing source choice. When using request_connection for one, include the exact artifactId and dataNeedId shown above. Name the artifact and affected metrics in the connection purpose. A proposal is not requested access. After the founder chooses and completes any private authorization, validate the source, update sourceRefs and evidence, and move the artifact toward operating status.",
			].join("\n")
		: agent.templateId
			? [
					`Your suggested-role artifact is missing or invalid. Inspect agents/${agent.id}/artifacts/starter-${agent.templateId}.json and repair it before continuing setup.`,
					"The qorpera.artifact/v1 schema is closed. Artifact status is setting-up, waiting-for-data, partial, validating, or operating. Metric status is unknown, measured, stale, or blocked. Data-need status is missing, selected, connected, available, or declined. Data needs use sourceRefs for evidence paths; remove unsupported fields. Do not replace the starter measures unless the company's circumstances require it.",
				].join("\n")
			: [
					"You do not own an artifact yet because this is a blank agent, not a suggested role. Begin broadly: ask what durable responsibility, outcome, or measure the founder wants you to own. Do not invent a specialty from your name.",
					`After the founder defines it, create an ordinary JSON artifact under agents/${agent.id}/artifacts/ using schema qorpera.artifact/v1. Give it an id, title, purpose, this stewardAgentId, status (setting-up, waiting-for-data, partial, validating, or operating), createdAt, and updatedAt. Artifact, metric, and data-need ids use only letters, numbers, dots, colons, underscores, and hyphens. Metrics need id, label, description, direction (higher-is-better, lower-is-better, target, or observe), status (unknown, measured, stale, or blocked), and evidence. Data needs require id, label, purpose, connectorHints, status (missing, selected, connected, available, or declined), and sourceRefs. Link supporting company work with relative paths into files/. Then use that adaptable artifact to drive setup and ongoing work.`,
				].join("\n");
	const connectorInstructions = connectors.length
		? [
				"The company connector recipes available to you are:",
				...connectors.map((connector) => {
					const requiredSecrets = companyConnectorSecretNames(connector);
					const missingDestinations = connector.destinations
						.map((destination) => destination.host)
						.filter((host) => !connectionBindings.destinations.some((binding) => binding.host === host));
					const missingSecrets = requiredSecrets.filter((name) => !connectionBindings.secretNames.includes(name));
					const readiness =
						missingDestinations.length || missingSecrets.length
							? `not bound; missing destinations [${missingDestinations.join(", ")}] and secrets [${missingSecrets.join(", ")}]`
							: "execution ready";
					return `- recipeId company:${connector.id}: ${connector.displayName}; manifest ${connector.relativePath}; implementation ${connector.implementation.kind} ${connector.implementation.entry}; operations [${connector.operations.map((operation) => `${operation.id}:${operation.access}`).join(", ")}]; environment ${connector.environment ?? "production"}; auth ${connector.authentication.kind}; destinations ${connector.destinations.map((destination) => destination.host).join(", ")}; secretNames [${requiredSecrets.join(", ")}]; ${readiness}`;
				}),
			].join("\n")
		: "The company does not have an installable connector manifest yet.";
	const routineInstructions = routines.length
		? [
				"Your recurring routines are:",
				...routines.map(
					(job) =>
						`- ${job.id}: ${job.title}; ${job.enabled && !job.suspendedReason ? "enabled" : "not active"}; ${job.triggers
							.map((trigger) => {
								if (trigger.kind !== "schedule") return trigger.kind;
								if (trigger.weekdays && trigger.localTime && trigger.timeZone) {
									return `${trigger.weekdays.join(", ")} at ${trigger.localTime} (${trigger.timeZone})`;
								}
								return `every ${trigger.intervalMinutes} minutes${trigger.startAt ? ` starting ${trigger.startAt}` : ""}`;
							})
							.join(", ")}`,
				),
			].join("\n")
		: "You do not have a recurring routine yet.";
	const memory = readStaffAgentMemory(root, agent.id);
	const memoryInstructions = [
		`Private memory: agents/${agent.id}/memory.md`,
		"This file is your durable personal memory across every session and wake. Record founder preferences, decisions, recurring context, and lessons the moment you learn them; prune anything wrong or stale. Keep it about how you work, not a copy of company data.",
		...(memory.trim() ? ["Current memory:", memory.trim()] : []),
	].join("\n");
	const skillsInstructions = `Personal skills: agents/${agent.id}/skills/ holds skill files loaded only into your sessions. When you develop a repeatable procedure worth keeping, save it there as a skill; company-wide skills belong to the founder under .qorpera/skills/.`;
	const coworkers = (() => {
		try {
			return readStaffAgents(root).filter((other) => other.id !== agent.id && other.employmentStatus === "active");
		} catch {
			return [];
		}
	})();
	const coworkerInstructions = coworkers.length
		? [
				"Your coworkers are:",
				...coworkers.map((other) => `- ${other.displayName} — ${other.role} [staffAgentId=${other.id}]`),
				"Use send_agent_message with a coworker's exact staffAgentId to hand off work, ask for something they own, or report a result they are waiting on. Messages are durable and read in the coworker's own next session, never live: include all context needed to act, and do not assume they can see your conversation. Respect each other's responsibilities instead of doing a coworker's job yourself.",
			].join("\n")
		: "You are currently the only active staff member, so send_agent_message has no valid recipient yet.";
	const senderNames = new Map([...coworkers, agent].map((member) => [member.id, member.displayName]));
	const messageInstructions = staffMessagesContext(root, agent.id, senderNames);
	const lifecycleInstructions =
		agent.lifecycleState === "setup"
			? [
					"Lifecycle state: setup.",
					"You are establishing yourself as a useful employee, not answering a single setup question. Be eager for responsibility without becoming repetitive: lead the founder through one concrete next decision at a time and keep moving after every answer.",
					"Conception is complete when: (1) the founder understands and has had a chance to refine the durable responsibility you will own; (2) your artifact reflects the measures that matter, including any additions or removals the company needs; and (3) you have enough usable company data or connected access to begin doing the work—not merely a selected source, empty template, or authorization request.",
					"Suggested roles begin from their starter artifact. Proactively pursue the smallest connectors or existing company data needed to make those measures usable, then ask what else in this responsibility the founder wants you to care about. Blank roles must first press for a durable area of responsibility and create an artifact around it.",
					"Never stop setup at an empty intake file. If a selected source does not provide usable data, say exactly what is still missing and immediately lead the next best path: use existing records, choose a specific live service, or connect/build the smallest appropriate connector.",
					"Before finishing setup, offer one concrete recurring responsibility with a useful cadence and explain what the founder would receive. A schedule is optional and must not block useful work. Do not repeatedly ask once the founder has responded.",
					"When the completion criteria are genuinely met, call complete_setup with no arguments. This is your own silent transition out of setup behavior: never announce, explain, or ask permission for the state change. Until then, end every reply with the single most useful next setup action.",
				].join("\n")
			: "Conception is complete. Any first-turn or during-setup clauses retained in older durable instructions no longer apply. Work normally from the responsibility, artifact, company evidence, and founder requests.";
	return [
		"You are a persistent staff member of this company, not a temporary chat persona.",
		`Staff identity: ${agent.id}`,
		`Name: ${agent.displayName}`,
		`Role: ${agent.role}`,
		`Durable instructions: agents/${agent.id}/instructions.md`,
		"Instructions:",
		agent.charter,
		lifecycleInstructions,
		memoryInstructions,
		skillsInstructions,
		coworkerInstructions,
		messageInstructions,
		artifactInstructions,
		connectorInstructions,
		routineInstructions,
		"Keep this identity and these instructions across every launch. You may refine your instructions as the role becomes clearer, but never use them to broaden your authority. Keep private working material inside your agent directory, shared company work under files/, and maintain continuity through company files and your trail.",
		"When the request_connection tool is available and a missing source blocks useful work after you have checked existing company data and connections, use it with exact destination hosts and opaque secret reference names. For an artifact data need, always include its exact artifactId and dataNeedId. When there is no installed provider recipe, include providerSuggestions with two to four concrete services likely to satisfy the need; do not offer broad categories or bundles. It proposes a founder choice; it does not request provider access or grant access by itself.",
		"A selected provider label is an exact setup contract. A named service means its private account data through least-privilege provider authentication unless the label explicitly says public export, uploaded file, or another no-auth workflow. Never silently substitute a public export, local file, manual template, or different provider for the selected service; ask before changing the source or access mode.",
		"Use run_connector for an execution-ready company-tool connector operation. Inspect its manifest and implementation contract before supplying input. A connector is transport, never an authoritative source by itself. After the smallest relevant read, use assess_artifact_source to decide separately for each datatype and affected measure whether the actual source is authoritative, supporting, or invalid. Base that decision on concrete source identity, entity scope, field meaning, time coverage, provenance, and evidence that the company actually uses this dataset as the operating record. Access, ownership, admin permission, and an empty result do not prove completeness or company usage: for example, a repository issue endpoint is not the company's defect record unless evidence establishes that workflow. Default to supporting when operational scope or completeness is unverified, and make absence or zero-count claims only from a dataset proven complete for that process. Use one stable sourceRef for the logical dataset or account; put endpoint and query details in evidence. Only then call record_artifact_observation for measures assessed authoritative. If a previously useful source is old or a real read fails, call report_artifact_source_issue for only the affected measures so their last valid values remain visible as stale or blocked. Never mark a linked connection ready from setup or authentication state alone.",
		"When manage_routine is available, you may create or change only your own recurring work. In an attended conversation, call it only after the founder explicitly agrees to the exact work and cadence or explicitly asks for the pause, resume, or removal. Never infer consent from general enthusiasm. Reuse one stable routineKey for the same responsibility so retries update rather than duplicate. Use weekly wall-clock schedules for named weekdays and times, with timeZone auto unless the founder asks for a specific timezone. Scheduled routines default to high effort.",
		"When use_computer is available, you own public connector setup navigation. Open the connector registrationUrl in the Qorpera-controlled Chrome profile, inspect after every navigation, and drive the provider UI until the first genuinely user-only boundary. You may fill non-sensitive public setup forms. Dismiss cookie and privacy prompts without opting into optional tracking where possible, and clear any other public dialog that obstructs the private form. Never type credentials, passwords, passkeys, recovery codes, MFA or OTP values, financial identifiers, or private founder data. Do not stop on a landing page. Call handoff only at an unobstructed sign-in, identity-verification, MFA, consent, or equivalent secure user-only boundary. The same managed Chrome profile remains open for the founder; after they complete the protected step, that completion authorizes all remaining setup within the exact selected connector scope. Snapshot the same profile and continue without requesting another approval. If a provider displays a generated client ID and secret, first read only the public ID, wait for that tool result, and update the connector manifest. In a later tool step, store the secret with the manifest's exact clientSecretName. Never issue those operations concurrently; never read, repeat, or place the secret in a file, and never ask the founder to copy or store it.",
		"A Connection choice context is a durable founder selection, not conversational prose. Honor the selected provider and access mode exactly. If the selected source has no installed recipe, treat it as a connector-build assignment. Create connectors/<connector-id>/manifest.json with schema qorpera.connector/v1 and an implementation entry in the same directory. The manifest names this ownerAgentId as its maintainer and provenance, not its exclusive consumer, plus displayName, purpose, environment when sandboxed, operations (id, label, description, read/write access), exact destination hosts, authentication (none, api-key, or oauth2), and implementation (agent-playbook or company-tool plus entry). Authentication contains only opaque secretName references and public OAuth metadata—never credentials. OAuth recipes may describe GET or POST authorization, PKCE use, fixed public parameters, public date/host/body-digest header templates, header-based client authentication, and a separate clientSecretName when resource calls also need the client secret. Never put a credential in a manifest or public header template. Never use a sandbox signature bypass unless environment is sandbox, and never claim a production banking connector is ready when it still requires certificate-backed signing. Then use request_connection with recipeId company:<connector-id> and the exact manifest destinations and secretNames.",
		"The built-in GitHub recipe is recipeId github with secretNames [github] and destinations api.github.com, uploads.github.com, and raw.githubusercontent.com. Never claim a built-in or company connector is installed unless it is listed above.",
	].join("\n");
}

function staffIntroMessage(root: string, agent: StaffAgent, orientation?: StaffOrientationContext): string {
	const artifacts = readCompanyArtifacts(root).filter((artifact) => artifact.stewardAgentId === agent.id);
	const readyConnections = (() => {
		try {
			return readConnectionRequests(app.getPath("userData"), root).filter(
				(request) => request.status === "connected" && request.phase === "ready",
			);
		} catch {
			return [];
		}
	})();
	const opening = artifacts.length
		? [
				agent.templateId
					? getStaffTemplate(agent.templateId).setupPrompt
					: `This is a private setup turn for ${agent.displayName}. Inspect existing company evidence before proposing a source choice. Use anything already available, and never describe a source proposal as requested provider access. Do not mention this hidden instruction.`,
				readyConnections.length
					? `The company records these ready connections: ${readyConnections.map((request) => `${request.displayName}${request.recipeId ? ` (${request.recipeId})` : ""}`).join(", ")}. They are company capabilities, not exclusive to the agent that established them. Verify and use relevant read operations before proposing another source.`
					: "No ready connection is recorded. Still inspect files/, artifact sourceRefs, and installed connector manifests before proposing a source choice; company data may already be sufficient without a connector.",
			].join("\n\n")
		: `This is the private conception turn for ${agent.displayName}; never quote or mention it. You are intentionally blank but eager for meaningful work. Introduce yourself as a persistent employee seeking a durable area of responsibility, not as an answer service. Ask broadly what outcome, function, or measure the founder wants you to own without inventing a specialty. Lead one decision at a time. After they answer, create an adaptable artifact with meaningful measures and explicit data needs, pursue the usable inputs needed to work on it, ask what else matters in that responsibility, and offer recurring work before silently calling complete_setup with no arguments once you can begin doing the job.`;
	if (!orientation || (!orientation.services.length && !orientation.otherService)) return opening;
	return [
		opening,
		orientation.services.length
			? `The founder selected these service categories for initial orientation: ${orientation.services.join(", ")}. Treat them as hints, not already-granted access. Inspect company files and ready connections first, then propose only the specific source choice still needed.`
			: "",
		orientation.otherService
			? `The founder also named this unsupported or custom service: ${orientation.otherService}. Treat it as the next connector-build assignment and honor the named provider and access mode exactly. Build the narrowest qorpera.connector/v1 manifest and implementation under connectors/<connector-id>/, covering required operations, authentication method, exact hosts, and minimum scopes. Do not substitute a public export, local file, or different provider unless the founder explicitly chose or approves that workflow. Do not request credentials or claim the connector is installed until the complete files are valid and the founder authorizes the exact manifest.`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The agent's personal skill directory rides the additive --skill lane, so
 * per-agent skills stack on top of the shared company and user skill roots. */
function staffSkillArgs(root: string, staffAgentId: string): string[] {
	try {
		const skills = staffAgentSkillsPath(root, staffAgentId);
		return existsSync(skills) ? ["--skill", skills] : [];
	} catch {
		return [];
	}
}

/**
 * Transitional Pi RPC attachment used by local companies and by the current
 * desktop transcript projection. Cloud profiles may attach for projection,
 * but sendLegacyLocalPrompt rejects every cloud prompt before authorization.
 */
function startLegacyPiSessionAttachment(
	slot: Slot,
	root: string,
	options: ChildOptions = {},
): ChildProcessWithoutNullStreams {
	const {
		sessionFile,
		sessionName,
		staffAgentId,
		staffContext,
		autoStartStaffIntro,
		autonomousName,
		department,
		worktree,
		silent,
		onRpcEvent,
	} = options;
	if (Boolean(staffAgentId) !== Boolean(staffContext)) {
		throw new Error("staff runtime identity and context must be provided together");
	}
	if (staffAgentId && (department || worktree)) {
		throw new Error("staff runtime identity cannot be combined with product-worker authority");
	}
	const sessions = sessionControlPlanes.get(normalizedRoot(root));
	if (!sessions) throw new Error(`session control plane is unavailable for ${root}`);
	// Resolve the window at SEND time, never at spawn time: opening a company
	// swaps the slot's window onto the durable partition AFTER the boot child
	// is started, and a captured reference then streams every child frame —
	// responses, history, exits — into the destroyed pre-swap window. That was
	// the "sessions never load on first open" bug: the child was alive and
	// answering, to a window that no longer existed.
	const win = () => slot.window;
	const actor = department && worktree ? "product-worker" : "company-agent";
	const userData = app.getPath("userData");
	const attachment = profileAttachment(root);
	const requireDurableExecution = attachment.profileType === "cloud";
	const checkpointDir = join(dirname(sandboxConfigDir(userData, root, "company-agent")), "checkpoints");
	reconcilePendingProductCheckpoints(checkpointDir, root);
	snapshotFounderGitState(root);
	const companyExecution =
		requireDurableExecution && !worktree
			? createCloudCompanyExecutionCheckout({
					userData,
					profileId: attachment.profileId,
					companyRoot: root,
					hostInstanceId: HOST_INSTANCE_ID,
				})
			: undefined;
	const cwd = worktree ? join(root, worktree) : (companyExecution?.checkoutRoot ?? root);
	const scope = {
		actor,
		attended: false,
		staffAgentId,
		roomId: options.roomId,
		autonomousLabel: autonomousName ? `autonomous — ${autonomousName}` : undefined,
		department: department?.path,
		worktree,
		group: options.group,
		parentSession: options.parentSession,
		companySnapshotId: options.companySnapshotId,
		staffVersion: options.staffVersion,
	} as const;
	const localExecutionPermission = readLocalExecutionPermission(userData, root);
	let binding: TrailBinding;
	try {
		binding = bindTrailSession(
			root,
			cwd,
			scope,
			sessionFile,
			sessionFile ? sessions.auditForTrail(sessionFile) : undefined,
		);
	} catch (error) {
		if (companyExecution) void discardCleanCloudCompanyExecution(companyExecution).catch(() => undefined);
		throw error;
	}
	if (sessionName) appendKernelSessionInfo(binding, sessionName);
	if (options.wake) {
		appendKernelWakeObservation(binding, {
			wakeId: options.wake.id,
			cause: options.wake.cause,
			...(options.wake.intervalMinutes !== undefined ? { intervalMinutes: options.wake.intervalMinutes } : {}),
			...(options.wake.coalesced ? { coalesced: options.wake.coalesced } : {}),
		});
	}
	reconcileKernelGateCreations(
		binding,
		root,
		listPendingCompanyGateCreations(userData, root),
		(file, hash, trailFile, phase) => advanceCompanyGateCreation(userData, root, file, hash, trailFile, phase),
		(file, hash) => completeCompanyGateCreation(userData, root, file, hash),
	);
	const configDir = sandboxConfigDir(userData, root, actor);
	const runtimeDir = sandboxRuntimeDir(userData, root, actor, binding.token);
	if (!modelRequestBroker) throw new Error("desktop host model-request broker is unavailable");
	const productWorktreeRoot = worktree ? realpathSync(cwd) : undefined;
	let gitBaseline = captureCompanyGitBaseline(root);
	if (productWorktreeRoot) snapshotFounderGitState(productWorktreeRoot, "product-worker");
	let productGitBaseline = productWorktreeRoot ? captureCompanyGitBaseline(productWorktreeRoot) : undefined;
	const checkpointState = join(checkpointDir, `${binding.token}.json`);
	const productCheckpointState = join(checkpointDir, `${binding.token}.product.json`);
	savePendingCompanyCheckpoint(checkpointState, root, gitBaseline, binding.file);
	if (productWorktreeRoot && productGitBaseline) {
		savePendingProductCheckpoint(productCheckpointState, root, productWorktreeRoot, productGitBaseline, binding.path);
	}
	inboxMessagesPath(root);
	const products = readProductProtectionInventory(root).map((product) => ({
		repository: product.repositoryPath,
		worktrees: product.worktreesPath,
	}));
	const agentCompanyRoot = companyExecution?.checkoutRoot ?? root;
	const brokeredCredentials = modelRequestBroker.registerChild(
		binding.sessionId,
		sourceModelCredentials(),
		ambientModelProviders(),
		(event) => appendKernelModelObservation(binding, event),
	);
	// Generic outbound HTTP: destination capabilities and secret references are
	// resolved by the desktop host; every attempt is trail-observed and must ride
	// a host-signed causal intent (parity with the model lane).
	// File mode streams into/out of company territory only: escapes and
	// host-protected paths (trail, policy, inbox, .git, legacy shell storage,
	// product code) are denied before any network contact.
	const resolveCompanyPath = createCompanyFileResolver(
		agentCompanyRoot,
		protectedCompanyAgentPaths(agentCompanyRoot, products),
	);
	const httpBroker = createHttpRequestBroker({
		sessionId: binding.sessionId,
		requireDurableExecution,
		allowedDestination: (url) => destinationAllowed(root, url),
		resolveSecret: (name) => resolveCompanySecret(root, name),
		companyFile: {
			resolveForWrite: (relativePath) => resolveCompanyPath(relativePath, "write"),
			resolveForRead: (relativePath) => resolveCompanyPath(relativePath, "read"),
		},
		observe: (event) => appendKernelHttpObservation(binding, event),
		execution: () => childDurableExecutions.get(child),
		beginReceipt: (execution, operationId, operationKind, inputSha256) => {
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("cloud operation receipts are unavailable");
			return primary.beginOperationReceipt(execution, operationId, operationKind, inputSha256);
		},
		completeReceipt: (execution, operationId, result) => {
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("cloud operation receipts are unavailable");
			return primary.completeOperationReceipt(execution, operationId, result);
		},
		syncOutput: async (output) => {
			const runtime = slot.runtime;
			if (!runtime || normalizedRoot(runtime.root) !== normalizedRoot(root)) {
				throw new Error("HTTP file output lost its runtime before durable staging");
			}
			const hostedObjects = qorperaAccountAuth?.hostedObjects();
			if (!hostedObjects) throw new Error("cloud object staging is unavailable");
			const reference = await hostedObjects.putFileFromPath(
				attachment.profileId,
				output.absolutePath,
				"application/octet-stream",
				{ bytes: output.bytes, sha256: output.sha256 },
			);
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("cloud operation receipts are unavailable");
			await primary.stageOperationReceiptObjects(output.execution, output.operationId, reference.objects);
			return { cloudManifestSha256: reference.manifestSha256, cloudObjects: reference.objects };
		},
	});
	let agentDir: string;
	let invocation: { command: string; args: string[] };
	let kernelSigner: ReturnType<typeof createKernelResponseSigner>;
	let child: ChildProcessWithoutNullStreams;
	const executorId = randomUUID();
	const env: NodeJS.ProcessEnv = brokeredChildEnvironment();
	Object.assign(env, sandboxGitEnvironment([agentCompanyRoot, ...(productWorktreeRoot ? [productWorktreeRoot] : [])]));
	env.ELECTRON_RUN_AS_NODE = "1";
	env.HOME = runtimeDir;
	env.USERPROFILE = runtimeDir;
	env.APPDATA = runtimeDir;
	env.LOCALAPPDATA = runtimeDir;
	env.TEMP = runtimeDir;
	env.TMP = runtimeDir;
	env.TMPDIR = runtimeDir;
	env.XDG_CONFIG_HOME = runtimeDir;
	try {
		agentDir = prepareBrokeredAgentDir(configDir, root, brokeredCredentials.credentials);
		shareWindowsSandboxState(userData, configDir);
		/* Runtime children must run as a properly signed binary: an ad-hoc
		 * signature fails the child codesign check inside the sandbox
		 * (task_name_for_pid failure 5) and the child dies before its first
		 * message — true for source checkouts AND for ad-hoc packaged
		 * builds. Until Developer ID signing lands, packaged builds bundle
		 * the officially signed Node and fall back to it automatically;
		 * development keeps the explicit override. */
		const runtimeNodeExecutable =
			process.env.QORPERA_RUNTIME_NODE?.trim() || bundledRuntimeNodeForAdhocBuild() || process.execPath;
		/* The official Node build reads the system OpenSSL configuration at
		 * startup and aborts when the sandbox denies it, so an external
		 * runtime node needs that path readable alongside its install tree. */
		const runtimeNodeReadPaths =
			runtimeNodeExecutable === process.execPath
				? []
				: [
						dirname(dirname(realpathSync(runtimeNodeExecutable))),
						...(process.platform === "darwin" ? ["/System/Library/OpenSSL"] : []),
					];
		writeSandboxProfile(
			configDir,
			runtimeDir,
			agentCompanyRoot,
			scope,
			protectedCompanyAgentPaths(agentCompanyRoot, products),
			[
				...FOUNDATION_READ_PATHS,
				...runtimeNodeReadPaths,
				/* Cloud-company staff children run confined to their execution
				 * worktree, but the session binding hands them a --session path
				 * in the live company root; without read access to that trail
				 * the child dies EPERM opening its own session history. Appends
				 * still flow through the kernel broker, never direct writes. */
				...(companyExecution ? [join(root, ".git"), join(root, "trail")] : []),
				join(configDir, "config.toml"),
				join(agentDir, "auth.json"),
				join(agentDir, "trust.json"),
				join(agentDir, FOUNDER_PUBLIC_FILE),
			],
		);
		provisionSandbox({
			codexEntry: CODEX_ENTRY,
			configDir,
			runtimeDir,
			nodeExecutable: runtimeNodeExecutable,
			env,
		});
		const rpcArgs = [
			LEGACY_PI_RPC_ENTRY,
			"--mode",
			"rpc",
			"--session",
			binding.path,
			...(staffContext ? ["--append-system-prompt", staffContext] : []),
			...(options.thinkingLevel
				? ["--thinking", options.thinkingLevel]
				: staffAgentId && (!sessionFile || options.freshStaffTrail)
					? ["--thinking", STAFF_DEFAULT_THINKING_LEVEL]
					: []),
			...localExecutionToolArgs(
				localExecutionPermission,
				staffAgentId ? (options.toolNames ?? STAFF_TOOL_NAMES) : undefined,
			),
			...(staffAgentId ? staffSkillArgs(agentCompanyRoot, staffAgentId) : []),
			...runtimeModelArgs(options.model),
		];
		invocation = codexSpawn(
			CODEX_ENTRY,
			runtimeNodeExecutable,
			sandboxCommandArgs(CODEX_ENTRY, runtimeDir, runtimeNodeExecutable, rpcArgs),
		);
		kernelSigner = createKernelResponseSigner({ sessionId: binding.sessionId });
	} catch (error) {
		httpBroker.release();
		brokeredCredentials.release();
		if (companyExecution) void discardCleanCloudCompanyExecution(companyExecution).catch(() => undefined);
		throw error;
	}
	// QORPERA_AUTONOMOUS marks agent-initiated work: those sessions run
	// in rpc mode with nobody present, so outward-effect signatures cannot
	// treat them as founder sessions. Product roles remain separate either way.
	if (autonomousName) env.QORPERA_AUTONOMOUS = "1";
	delete env.QORPERA_ACTOR;
	delete env.QORPERA_PRODUCT_DEPARTMENT;
	delete env.QORPERA_PRODUCT_WORKTREE;
	env.CODEX_HOME = configDir;
	env.QORPERA_CODING_AGENT_DIR = agentDir;
	env.QORPERA_TRAIL_BROKER_TOKEN = binding.token;
	env.QORPERA_KERNEL_PUBLIC_KEY = kernelSigner.publicKey;
	env.QORPERA_KERNEL_REQUIRED = "1";
	env.QORPERA_MODEL_BROKER_HANDLES = JSON.stringify(brokeredCredentials.handles);
	// A provider may not exist outside the canonical control plane. If the
	// durable attach fact cannot be written, fail before granting a process any
	// authority or model credentials.
	if (
		!recordSessionRuntime(sessions, binding, {
			kind: "executor_started",
			executorId,
		})
	) {
		httpBroker.release();
		brokeredCredentials.release();
		throw new Error("could not durably attach the agent runtime");
	}
	const attachmentSequence = sessions
		.snapshot()
		.sessions.find(
			(session) => session.trailFile === binding.file && session.executorId === executorId,
		)?.attachmentSequence;
	try {
		child = spawn(invocation.command, invocation.args, {
			cwd: runtimeDir,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env,
		}) as ChildProcessWithoutNullStreams;
	} catch (error) {
		recordSessionRuntime(sessions, binding, {
			kind: "executor_exited",
			executorId,
			expected: false,
			code: null,
			signal: null,
			busy: false,
			detail: (error as Error).message,
		});
		// No ChildProcess exists to emit an async exit or drive reconnect. Close
		// the durable state explicitly instead of leaving a reconnecting phantom.
		recordSessionRuntime(sessions, binding, {
			kind: "reconnect_failed",
			executorId,
			attempt: 1,
			detail: (error as Error).message,
		});
		httpBroker.release();
		brokeredCredentials.release();
		if (companyExecution) void discardCleanCloudCompanyExecution(companyExecution).catch(() => undefined);
		throw error;
	}
	const computerBroker = staffAgentId
		? createComputerBroker({
				sessionId: binding.sessionId,
				profilePath: join(app.getPath("userData"), "chrome-computers", companyRootId(root), staffAgentId),
				allowedInitialUrl: (url) =>
					readConnectionRequests(app.getPath("userData"), root).some((request) => {
						if (
							request.staffAgentId !== staffAgentId ||
							request.sessionFile !== binding.file ||
							!request.recipeId?.startsWith("company:")
						) {
							return false;
						}
						const connector = companyConnectorForRequest(root, request);
						if (connector?.authentication.kind !== "oauth2") return false;
						const registrationUrl = connector.authentication.registrationUrl;
						if (!registrationUrl) return false;
						try {
							return new URL(registrationUrl).origin === url.origin;
						} catch {
							return false;
						}
					}),
				onHandoff: () => {
					publishComputerHandoff(slot, root, child, staffAgentId, binding);
				},
				storeSecret: (name, value) =>
					continueCompanyConnectorRegistration(slot, root, child, staffAgentId, binding, name, value),
				observe: (event) => appendKernelComputerObservation(binding, event),
			})
		: undefined;
	const companyOperationBroker = staffAgentId
		? createCompanyOperationBroker({
				sessionId: binding.sessionId,
				requireDurableExecution,
				execution: () => childDurableExecutions.get(child),
				beginReceipt: async (execution, operationId, operationKind, inputSha256) => {
					const primary = qorperaAccountAuth?.hostedPrimary();
					if (!primary) throw new Error("cloud operation receipts are unavailable");
					const receipt = await primary.beginOperationReceipt(execution, operationId, operationKind, inputSha256);
					if (receipt.status !== "completed") return receipt;
					const result = recordValue(receipt.result);
					if (
						!result ||
						typeof result.message !== "string" ||
						Object.keys(result).some((key) => key !== "message")
					) {
						throw new Error("cloud operation receipt result is invalid");
					}
					return { started: false, status: "completed", result: { message: result.message } };
				},
				completeReceipt: async (execution, operationId, result) => {
					const primary = qorperaAccountAuth?.hostedPrimary();
					if (!primary) throw new Error("cloud operation receipts are unavailable");
					await slot.runtime?.cloudStaffSync?.sync();
					const completed = recordValue(await primary.completeOperationReceipt(execution, operationId, result));
					if (!completed || typeof completed.message !== "string") {
						throw new Error("cloud operation receipt result is invalid");
					}
					return { message: completed.message };
				},
				apply: (kind, input) =>
					applyStaffCompanyOperation(slot, root, agentCompanyRoot, child, staffAgentId, binding, kind, input),
			})
		: undefined;
	trackChildReadiness(child);
	liveChildren.add(child);
	// stdin write failures land asynchronously as an "error" event; without a
	// listener they become an uncaughtException that takes down the app.
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (!silent) send(win(), "rpc-log", `child stdin ${error.code ?? error.message}: frame dropped`);
	});
	childBindings.set(child, binding);
	childProfileTypes.set(child, profileAttachment(root).profileType);
	if (companyExecution) childCompanyExecutions.set(child, companyExecution);
	childExecutorIds.set(child, executorId);
	if (attachmentSequence !== undefined) childAttachmentSequences.set(child, attachmentSequence);
	childSessionPlanes.set(child, sessions);
	childIntentSigners.set(child, kernelSigner.signIntent);
	childModelCapabilities.set(child, brokeredCredentials);
	childHttpBrokers.set(child, httpBroker);
	if (computerBroker) childComputerBrokers.set(child, computerBroker);
	if (companyOperationBroker) childCompanyOperationBrokers.set(child, companyOperationBroker);
	childApprovedGates.set(child, new Set());
	let resolveCheckpoint: (() => void) | undefined;
	childCheckpointCompletion.set(
		child,
		new Promise<void>((resolvePromise) => {
			resolveCheckpoint = resolvePromise;
		}),
	);
	let executionSettlement: Promise<void> = Promise.resolve();
	let outputSettled = false;
	const finalizeSettledCompanyOutput = async (): Promise<void> => {
		const runtime = slot.runtime;
		let requiresReview = false;
		let reviewProposalHead: string | undefined;
		const checkpoint = async (): Promise<void> => {
			const result = checkpointCompanyGit(root, gitBaseline, binding.file);
			gitBaseline = result.baseline;
			savePendingCompanyCheckpoint(checkpointState, root, gitBaseline, binding.file);
			if (!result.success) throw new Error("Company trail checkpoint did not settle cleanly");
			if (companyExecution) {
				const promotion = await promoteCloudCompanyExecution(companyExecution, {
					requireReview: options.reviewPolicy !== undefined,
				});
				requiresReview = promotion.status === "requires_review";
				if (promotion.status === "requires_review") reviewProposalHead = promotion.proposalHead;
			}
			if (productWorktreeRoot && productGitBaseline) {
				const productResult = checkpointProductWorktreeGit(
					root,
					productWorktreeRoot,
					productGitBaseline,
					binding.path,
				);
				productGitBaseline = productResult.baseline;
				savePendingProductCheckpoint(
					productCheckpointState,
					root,
					productWorktreeRoot,
					productGitBaseline,
					binding.path,
				);
				if (!productResult.success) throw new Error("Product execution checkpoint did not settle cleanly");
			}
		};
		if (runtime && normalizedRoot(runtime.root) === normalizedRoot(root)) {
			await enqueueRuntimeTransition(runtime, checkpoint);
		} else {
			await checkpoint();
		}
		const activeArbiter = runtime?.child === child ? runtime.cloudSessionArbiter : undefined;
		const activeClaim = activeArbiter?.activeClaim;
		if (requiresReview) {
			childOutputsRequireReview.add(child);
			if (runtime && companyExecution && reviewProposalHead && activeArbiter && activeClaim) {
				await submitCloudSessionProposal(
					slot,
					runtime,
					child,
					companyExecution,
					reviewProposalHead,
					activeArbiter,
					activeClaim,
					options.reviewPolicy,
				);
			}
			return;
		}
		if (runtime && activeArbiter && activeClaim) {
			await completeCloudSessionClaim(slot, runtime, activeArbiter, activeClaim);
		}
	};
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		try {
			const frame = JSON.parse(line) as unknown;
			const confirmedModel = modelSelectionFromRpcFrame(frame);
			if (confirmedModel) {
				options.model = confirmedModel;
				if (staffAgentId) {
					// A confirmed model on a staff-bound child is that employee's
					// durable choice, not a company-wide default.
					persistStaffAgentModel(root, staffAgentId, confirmedModel).catch((error: unknown) => {
						console.error(
							`staff model persistence failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
				} else {
					writeCompanyRuntimeModelPreference(app.getPath("userData"), root, confirmedModel);
				}
			}
			const challenge = frame as {
				type?: unknown;
				token?: unknown;
				nonce?: unknown;
				sessionId?: unknown;
			};
			if (
				challenge.type === "qorpera_kernel_challenge" &&
				challenge.token === binding.token &&
				challenge.sessionId === binding.sessionId &&
				typeof challenge.nonce === "string" &&
				/^[0-9a-f-]{36}$/i.test(challenge.nonce)
			) {
				writeChildFrame(
					child,
					`${JSON.stringify(
						kernelSigner.signBinding({
							nonce: challenge.nonce,
							sessionId: binding.sessionId,
						}),
					)}\n`,
				);
				if (!childRuntimeReady.has(child)) {
					if (
						!recordSessionRuntime(sessions, binding, {
							kind: "executor_ready",
							executorId,
						})
					) {
						intentionalKills.add(child);
						child.kill();
						return;
					}
					childRuntimeReady.add(child);
					const staffDefaultsApplied =
						!staffAgentId ||
						writeChildFrame(
							child,
							`${JSON.stringify({ type: "set_response_speed", speed: STAFF_DEFAULT_RESPONSE_SPEED })}\n`,
						);
					if (!staffDefaultsApplied) {
						send(win(), "rpc-log", "staff response-speed default could not be applied");
					}
					settleChildReadiness(child, staffDefaultsApplied);
					if (staffAgentId && autoStartStaffIntro && staffDefaultsApplied) {
						scheduleAutomaticStaffIntro(slot, child, staffAgentId, binding.file);
					}
					if (staffAgentId && staffDefaultsApplied) {
						schedulePendingConnectorSetupResume(slot, child, staffAgentId, binding.file);
					}
				}
				return;
			}
			if (
				brokeredCredentials.handleFrame(frame, (response) => {
					writeChildFrame(child, `${JSON.stringify(response)}\n`);
				})
			)
				return;
			if (
				httpBroker.handleFrame(frame, (response) => {
					writeChildFrame(child, `${JSON.stringify(response)}\n`);
				})
			)
				return;
			if (
				computerBroker?.handleFrame(frame, (response) => {
					writeChildFrame(child, `${JSON.stringify(response)}\n`);
				})
			)
				return;
			if (
				companyOperationBroker?.handleFrame(frame, (response) => {
					writeChildFrame(child, `${JSON.stringify(response)}\n`);
				})
			)
				return;
			if (
				applyKernelWriteFrame(
					frame,
					binding,
					root,
					(response) => {
						writeChildFrame(child, `${JSON.stringify(kernelSigner.signResponse(response))}\n`);
					},
					(file, hash) => childApprovedGates.get(child)?.delete(`${file}:${hash}`) === true,
					{
						has: (file, hash) => hasCompanyGateTrust(userData, root, file, hash),
						remember: (file, hash) => rememberCompanyGateTrust(userData, root, file, hash),
					},
					{
						begin: (file, hash, trailFile) => beginCompanyGateCreation(userData, root, file, hash, trailFile),
						advance: (file, hash, trailFile, phase) =>
							advanceCompanyGateCreation(userData, root, file, hash, trailFile, phase),
						complete: (file, hash) => completeCompanyGateCreation(userData, root, file, hash),
					},
				)
			)
				return;
			if ((frame as { type?: unknown }).type === "qorpera_trail_append") {
				const append = parseTrailAppendFrame(frame, binding, childDurableExecutions.get(child));
				if (append) {
					appendBoundTrailEntry(binding, append.entry);
					commitTrailAppend(binding, append);
					sessions.rememberAudit(binding);
					if (append.entry.type === "message" || append.entry.type === "session_info") {
						const runtime = slot.runtime;
						if (runtime && normalizedRoot(runtime.root) === normalizedRoot(root)) triggerCloudTrailSync(runtime);
					}
				} else send(win(), "rpc-log", "rejected invalid trail append frame");
				return;
			}
			const activity = sessionActivityFromFrame(frame as Record<string, unknown>);
			if (activity) observeSessionActivity(sessions, binding, executorId, activity);
			if (activity && staffAgentId && slot.runtime?.cloudPresence) {
				slot.runtime.cloudPresence.sendActivity(staffAgentId, activity.kind === "writing" ? "writing" : "working");
			}
			if (activity && slot.runtime?.child === child && slot.runtime.cloudSessionArbiter?.activeClaim) {
				void slot.runtime.cloudSessionArbiter.renewIfDue().catch(() => undefined);
			}
			if (staffAgentId) {
				const staffFrame = frame as Record<string, unknown>;
				if (
					staffFrame.type === "response" &&
					staffFrame.command === "staff_intro" &&
					staffFrame.success === false
				) {
					const error = typeof staffFrame.error === "string" ? staffFrame.error : "staff intro RPC failed";
					finishStaffIntroDurably(root, staffAgentId, binding.file, false, error);
					recordSessionRuntime(sessions, binding, {
						kind: "turn_interrupted",
						executorId,
						origin: "staff-intro-rpc-failed",
					});
					childBusy.set(child, false);
					brokeredCredentials.endTurn("failed");
					httpBroker.endTurn();
					computerBroker?.endTurn();
					companyOperationBroker?.endTurn();
					scheduleNextQueuedStaffIntro(slot, child);
				} else if (wakeFrameFailed(staffFrame)) {
					finishStaffIntroDurably(root, staffAgentId, binding.file, false, "staff intro model request failed");
				} else if (staffFrame.type === "agent_settled") {
					finishStaffIntroDurably(root, staffAgentId, binding.file, true);
				}
			}
			if ((frame as { type?: unknown }).type === "agent_settled") {
				outputSettled = true;
				if (staffAgentId) slot.runtime?.cloudPresence?.sendActivity(staffAgentId, "idle");
				if (
					!recordSessionRuntime(sessions, binding, {
						kind: "turn_settled",
						executorId,
					})
				) {
					intentionalKills.add(child);
					child.kill();
					return;
				}
				childBusy.set(child, false);
				{
					const settledRuntime = slot.runtime;
					if (settledRuntime && settledRuntime.child === child && settledRuntime.pendingStaffThreadRefresh) {
						const pending = settledRuntime.pendingStaffThreadRefresh;
						settledRuntime.pendingStaffThreadRefresh = undefined;
						setTimeout(() => {
							const refresh = refreshAttachedStaffThread(
								slot,
								settledRuntime,
								pending.staffAgentId,
								pending.sessionFile,
							);
							settledRuntime.staffThreadRefreshInFlight = refresh;
							void refresh.finally(() => {
								if (settledRuntime.staffThreadRefreshInFlight === refresh) {
									settledRuntime.staffThreadRefreshInFlight = undefined;
								}
							});
						}, 500).unref();
					}
				}
				if (staffAgentId) {
					try {
						finishSyncedConnectionRequests(slot, root, staffAgentId, binding);
					} catch (error) {
						console.error(`connection sync reconciliation failed: ${(error as Error).message}`);
					}
				}
				brokeredCredentials.endTurn("completed");
				httpBroker.endTurn();
				computerBroker?.endTurn();
				companyOperationBroker?.endTurn();
				executionSettlement = finalizeSettledCompanyOutput()
					.catch(async (error: unknown) => {
						childOutputsRequireReview.add(child);
						console.error(
							`session output promotion failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						const failedRuntime = slot.runtime;
						const failedArbiter = failedRuntime?.child === child ? failedRuntime.cloudSessionArbiter : undefined;
						const failedClaim = failedArbiter?.activeClaim;
						if (failedArbiter && failedClaim) {
							await failedArbiter
								.quarantineTurn("Company File output could not be promoted safely", failedClaim)
								.catch(() => undefined);
						}
					})
					.finally(() => {
						const currentRuntime = slot.runtime;
						if (
							currentRuntime?.child === child &&
							(currentRuntime.pendingInventoryRestart || currentRuntime.pendingStaffContextRestart) &&
							!currentRuntime.closing
						) {
							currentRuntime.pendingInventoryRestart = false;
							currentRuntime.pendingStaffContextRestart = false;
							restartForProductInventory(slot, currentRuntime);
						} else if (currentRuntime?.child === child) {
							scheduleInfrastructureWork(slot, currentRuntime);
						}
						if (staffAgentId) scheduleNextQueuedStaffIntro(slot, child);
					});
			}
			if (onRpcEvent) onRpcEvent(frame as Record<string, unknown>);
			else if (
				!silent &&
				frame &&
				typeof frame === "object" &&
				!Array.isArray(frame) &&
				slot.runtime &&
				isCurrentRuntimeChild(slot, slot.runtime, child)
			) {
				send(win(), "rpc-event", {
					...(frame as Record<string, unknown>),
					_qorperaRuntime: {
						trailFile: binding.file,
						executorId,
						attachmentSequence: childAttachmentSequences.get(child),
					},
				});
			}
		} catch {
			if (!silent) send(win(), "rpc-log", line);
		}
	});
	const stderrTail: string[] = [];
	let stderrTailBytes = 0;
	createInterface({ input: child.stderr }).on("line", (line) => {
		stderrTail.push(line);
		stderrTailBytes += Buffer.byteLength(line, "utf-8") + 1;
		while (stderrTailBytes > 4096 && stderrTail.length > 1) {
			stderrTailBytes -= Buffer.byteLength(stderrTail.shift()!, "utf-8") + 1;
		}
		if (!silent) send(win(), "rpc-log", line);
	});
	let exitHandled = false;
	const handleRuntimeExit = (code: number | null, signal: NodeJS.Signals | null, immediateDetail = ""): void => {
		if (exitHandled) return;
		exitHandled = true;
		const detail = [stderrTail.join("\n"), immediateDetail].filter(Boolean).join("\n").slice(-4096);
		const expected = intentionalKills.has(child);
		settleChildReadiness(child, false);
		const busy = childBusy.get(child) ?? false;
		recordSessionRuntime(sessions, binding, {
			kind: "executor_exited",
			executorId,
			expected,
			code,
			signal,
			busy,
			...(detail ? { detail } : {}),
		});
		if (!expected) {
			try {
				appendKernelRuntimeExitObservation(binding, {
					code,
					signal,
					busy,
					stderr: detail,
				});
			} catch (error) {
				console.error(`runtime-exit observation failed: ${(error as Error).message}`);
			}
		}
		if (silent || expected) return;
		const runtime = slot.runtime;
		if (runtime && runtime.root === root && runtime.child === child && !runtime.closing && !autonomousName) {
			scheduleRuntimeReconnect(slot, runtime, child, binding.file, options.model, code, detail);
			return;
		}
		send(win(), "rpc-exit", code);
	};
	// spawn() reports command/setup failures asynchronously. Without this
	// listener they are process-level uncaught errors and the saved session is
	// left falsely attached to an executor that never existed.
	child.on("error", (error) => handleRuntimeExit(null, null, error.message));
	child.on("exit", (code, signal) => {
		handleRuntimeExit(code, signal);
	});
	child.on("close", () => {
		liveChildren.delete(child);
		void (async () => {
			await executionSettlement;
			if (staffAgentId) {
				finishStaffIntroDurably(
					root,
					staffAgentId,
					binding.file,
					false,
					"staff intro runtime exited before completion",
				);
			}
			// Durable end marker BEFORE the close checkpoint, so the same kernel
			// commit that attributes this session's work also records its release.
			// Autonomous sessions only: they are the ones run classification
			// consumes, they are never resumed (a resumed founder chat would
			// accumulate mid-stream end markers on every wake cycle), and
			// marking chat husks would make them content-bearing — unprunable —
			// while forcing a git checkpoint on every no-op chat replace.
			if (autonomousName) {
				try {
					appendKernelSessionEndObservation(binding, {
						settled: !(childBusy.get(child) ?? false),
					});
				} catch (error) {
					console.error(`session-end observation failed: ${(error as Error).message}`);
				}
			}
			sessions.rememberAudit(binding);
			httpBroker.release();
			computerBroker?.release();
			companyOperationBroker?.release();
			brokeredCredentials.release();
			const result = checkpointCompanyGit(root, gitBaseline, binding.file);
			finishPendingCompanyCheckpoint(checkpointState, result);
			if (!result.success) savePendingCompanyCheckpoint(checkpointState, root, result.baseline, binding.file);
			if (companyExecution) {
				if (!outputSettled || (childBusy.get(child) ?? false)) {
					const quarantined = await quarantineCloudCompanyExecution(companyExecution);
					if (quarantined.proposalHead) childOutputsRequireReview.add(child);
				}
				if (!childOutputsRequireReview.has(child)) await discardCleanCloudCompanyExecution(companyExecution);
			}
			if (productWorktreeRoot && productGitBaseline) {
				const productResult = checkpointProductWorktreeGit(
					root,
					productWorktreeRoot,
					productGitBaseline,
					binding.path,
				);
				finishPendingCompanyCheckpoint(productCheckpointState, productResult);
				if (!productResult.success) {
					savePendingProductCheckpoint(
						productCheckpointState,
						root,
						productWorktreeRoot,
						productResult.baseline,
						binding.path,
					);
				}
			}
		})()
			.catch((error: unknown) => {
				// Child close is an ownership handoff signal. Bookkeeping failure must
				// never abort later wake/merge listeners that clear that ownership.
				console.error(`session close checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
			})
			.finally(() => resolveCheckpoint?.());
	});
	return child;
}

function sendLegacyLocalPrompt(
	child: ChildProcessWithoutNullStreams,
	frame: ReviewedPromptFrame,
	attended: boolean,
	origin: string,
): boolean {
	const binding = childBindings.get(child);
	const signIntent = childIntentSigners.get(child);
	if (!binding || !signIntent || child.exitCode !== null) return false;
	if (childProfileTypes.get(child) === "cloud") {
		console.error("legacy local executor rejected a cloud prompt; cloud turns require a sponsored runner job");
		return false;
	}
	const unsignedFrame = { ...frame };
	delete unsignedFrame.displayText;
	const kernelIntent = signIntent(unsignedFrame, attended, childDurableExecutions.get(child));
	if (!childModelCapabilities.get(child)?.authorizeIntent(kernelIntent)) return false;
	// The same intent authorizes the HTTP lane: both brokers track their own
	// usage of the shared per-turn capability.
	childHttpBrokers.get(child)?.authorizeIntent(kernelIntent);
	childComputerBrokers.get(child)?.authorizeIntent(kernelIntent);
	childCompanyOperationBrokers.get(child)?.authorizeIntent(kernelIntent);
	const images = Array.isArray(unsignedFrame.images)
		? unsignedFrame.images.flatMap((image) => {
				if (!image || typeof image !== "object") return [];
				const candidate = image as { data?: unknown; mimeType?: unknown };
				if (typeof candidate.data !== "string" || typeof candidate.mimeType !== "string") return [];
				return [
					{
						mimeType: candidate.mimeType,
						sha256: createHash("sha256").update(candidate.data, "base64").digest("hex"),
						bytes: Buffer.byteLength(candidate.data, "base64"),
					},
				];
			})
		: [];
	appendKernelObservation(binding, {
		frameType: frame.type,
		message: frame.message,
		attended,
		origin,
		intent: kernelIntent,
		images,
	});
	const sessions = childSessionPlanes.get(child);
	const executorId = childExecutorIds.get(child);
	if (
		!sessions ||
		!executorId ||
		!recordSessionRuntime(sessions, binding, {
			kind: "turn_started",
			executorId,
			origin,
		})
	) {
		childModelCapabilities.get(child)?.endTurn("aborted");
		childHttpBrokers.get(child)?.endTurn();
		childComputerBrokers.get(child)?.endTurn();
		childCompanyOperationBrokers.get(child)?.endTurn();
		return false;
	}
	childBusy.set(child, true);
	if (!writeChildFrame(child, `${JSON.stringify({ ...unsignedFrame, kernelIntent })}\n`)) {
		recordSessionRuntime(sessions, binding, {
			kind: "turn_interrupted",
			executorId,
			origin: "prompt-dispatch-failed",
		});
		// A runtime whose stdin rejected a reviewed prompt is not a usable
		// attachment. Its unexpected exit drives the ordinary reconnect lane.
		killChildTree(child);
		return false;
	}
	return true;
}

function finishStaffIntroDurably(
	root: string,
	staffAgentId: string,
	trailFile: string,
	success: boolean,
	error?: string,
): void {
	const path = staffRuntimeStatePath(app.getPath("userData"), root);
	const current = readStaffRuntimeState(path);
	const next = finishStaffIntro(current, staffAgentId, trailFile, success, Date.now(), error);
	if (next !== current) writeStaffRuntimeState(path, next);
}

function reconcileInterruptedStaffIntros(root: string): void {
	const path = staffRuntimeStatePath(app.getPath("userData"), root);
	const current = readStaffRuntimeState(path);
	let next = current;
	for (const intro of Object.values(current.intros)) {
		if (intro.status !== "started") continue;
		next = finishStaffIntro(
			next,
			intro.staffAgentId,
			intro.trailFile,
			false,
			Date.now(),
			"staff intro was interrupted before completion",
		);
	}
	if (next !== current) writeStaffRuntimeState(path, next);
}

/** The only kernel path that can start an employee's proactive first turn.
 * Its RPC command persists hidden custom context instead of a visible user
 * message; the renderer receives only the employee's response stream. */
function sendLegacyLocalStaffDirective(
	child: ChildProcessWithoutNullStreams,
	message: string,
	origin = "kernel-staff-intro",
): boolean {
	const binding = childBindings.get(child);
	const signIntent = childIntentSigners.get(child);
	if (!binding || !signIntent || child.exitCode !== null) return false;
	if (childProfileTypes.get(child) === "cloud") {
		console.error(
			"legacy local executor rejected a cloud staff directive; cloud turns require a sponsored runner job",
		);
		return false;
	}
	const frame = { type: "staff_intro" as const, message };
	const kernelIntent = signIntent(frame, false, childDurableExecutions.get(child));
	if (!childModelCapabilities.get(child)?.authorizeIntent(kernelIntent)) return false;
	childHttpBrokers.get(child)?.authorizeIntent(kernelIntent);
	childComputerBrokers.get(child)?.authorizeIntent(kernelIntent);
	childCompanyOperationBrokers.get(child)?.authorizeIntent(kernelIntent);
	appendKernelObservation(binding, {
		frameType: "staff_intro",
		message,
		attended: false,
		origin,
		intent: kernelIntent,
		images: [],
	});
	const sessions = childSessionPlanes.get(child);
	const executorId = childExecutorIds.get(child);
	if (
		!sessions ||
		!executorId ||
		!recordSessionRuntime(sessions, binding, {
			kind: "turn_started",
			executorId,
			origin,
		})
	) {
		childModelCapabilities.get(child)?.endTurn("aborted");
		childHttpBrokers.get(child)?.endTurn();
		childComputerBrokers.get(child)?.endTurn();
		childCompanyOperationBrokers.get(child)?.endTurn();
		return false;
	}
	childBusy.set(child, true);
	if (!writeChildFrame(child, `${JSON.stringify({ ...frame, kernelIntent })}\n`)) {
		recordSessionRuntime(sessions, binding, {
			kind: "turn_interrupted",
			executorId,
			origin: "staff-intro-dispatch-failed",
		});
		childModelCapabilities.get(child)?.endTurn("aborted");
		childHttpBrokers.get(child)?.endTurn();
		childComputerBrokers.get(child)?.endTurn();
		childCompanyOperationBrokers.get(child)?.endTurn();
		killChildTree(child);
		return false;
	}
	return true;
}

async function replaceRuntimeChild(slot: Slot, runtime: CompanyRuntime, options: ChildOptions): Promise<void> {
	const previousOptions = runtime.childOptions;
	const previousChild = runtime.child;
	if (previousChild) await stopChild(previousChild);
	if (slot.runtime !== runtime) return;
	runtime.child = undefined;
	runtime.sessionAnchor = undefined;
	try {
		runtime.childOptions = { ...options };
		runtime.child = startLegacyPiSessionAttachment(slot, runtime.root, runtime.childOptions);
		// startChild durably stamps the creation-time name before spawning. It is
		// therefore safe—and necessary—to keep reconnects from appending it again.
		delete runtime.childOptions.sessionName;
		runtime.runtimeReconnectAttempts = 0;
		runtime.lastUnexpectedRuntimeExitAt = undefined;
	} catch (error) {
		// The old child is already dead — a failed swap must not leave the
		// company without an agent (a legacy-session bind failure did exactly
		// that: every later composer send talked to a corpse).
		if (previousChild && slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, previousOptions, "chat-swap agent runtime restore failed");
		}
		throw error;
	}
	runtime.productWorker =
		runtime.childOptions.department && runtime.childOptions.worktree
			? {
					department: runtime.childOptions.department.path,
					worktree: runtime.childOptions.worktree,
				}
			: undefined;
}

function enqueueRuntimeTransition<T>(runtime: CompanyRuntime, transition: () => Promise<T>): Promise<T> {
	const result = runtime.transitionQueue.then(transition, transition);
	runtime.transitionQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function refreshSlotModelCredentials(slot: Slot): Promise<boolean> {
	const runtime = slot.runtime;
	if (!runtime) return true;
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) {
			return false;
		}
		if (!runtime.child) return true;
		await replaceRuntimeChild(slot, runtime, {
			...runtime.childOptions,
			sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
		});
		return true;
	});
}

async function connectModelAccount(
	sender: WebContents,
	providerId: string,
): Promise<{
	ok: boolean;
	cancelled?: true;
	error?: string;
	message?: string;
}> {
	const slot = slotOf(sender);
	if (!slot || !MODEL_CONNECTION_IDS.has(providerId)) return { ok: false, error: "unsupported model account" };
	if (connectionLogins.has(sender.id)) return { ok: false, error: "another account connection is in progress" };
	const controller = new AbortController();
	connectionLogins.set(sender.id, { connectionId: providerId, controller });
	const report = (message: string): void => {
		send(slot.window, "connection-status", { connectionId: providerId, message });
	};
	try {
		const modelAgentDir = join(app.getPath("home"), ".qorpera", "agent");
		const runtime = await ModelRuntime.create({
			authPath: join(modelAgentDir, "auth.json"),
			modelsPath: join(modelAgentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const provider = runtime.getProvider(providerId);
		if (!provider?.auth.oauth) return { ok: false, error: "this account does not support browser sign-in" };
		report("Waiting for provider sign-in…");
		const credential = await runtime.login(providerId, "oauth", {
			signal: controller.signal,
			prompt: (prompt) => {
				if (prompt.type === "select") {
					const first = prompt.options[0];
					if (!first) return Promise.reject(new Error("No sign-in method is available"));
					return Promise.resolve(first.id);
				}
				if (prompt.type === "manual_code") {
					// Browser OAuth races this fallback prompt against the local callback
					// listener. Keep the fallback pending so the localhost listener stays
					// alive until the browser returns or the founder cancels the flow.
					return waitForBrowserOAuthCallback(prompt.signal, controller.signal);
				}
				return Promise.reject(new Error("This sign-in flow requires an unsupported prompt"));
			},
			notify: (event) => {
				if (event.type === "auth_url") {
					report("Finish signing in in your browser…");
					void electronShell.openExternal(event.url).catch((error: Error) => {
						report(`Could not open sign-in: ${error.message}`);
						controller.abort();
					});
				} else if (event.type === "device_code") {
					clipboard.writeText(event.userCode);
					report(`Code ${event.userCode} copied. Paste it in your browser…`);
					void electronShell.openExternal(event.verificationUri).catch((error: Error) => {
						report(`Could not open sign-in: ${error.message}`);
						controller.abort();
					});
				} else {
					report(event.message);
				}
			},
		});
		if (!modelAccountStore) throw new Error("Model account storage is unavailable");
		await modelAccountStore.add(providerId, credential);
		await refreshBrokerModels([providerId]);
		await modelAccountUsageInfo().catch(() => []);
		report("Connected. Refreshing the active agent…");
		const refreshed = await refreshSlotModelCredentials(slot);
		const message = !slot.runtime
			? "Connected."
			: refreshed
				? "Connected. The active agent is ready to use it."
				: "Connected. It will be available when the current agent turn finishes.";
		report(message);
		return { ok: true, message };
	} catch (error) {
		const result = connectionError(error);
		report(result.cancelled ? "Connection cancelled." : (result.error ?? "Connection failed."));
		return result;
	} finally {
		connectionLogins.delete(sender.id);
	}
}

async function configureIntelligence(
	sender: WebContents,
	providerId: string,
): Promise<
	{ ok: true; intelligence: ReturnType<typeof intelligenceInfo> } | { ok: false; cancelled?: true; error: string }
> {
	if (!isIntelligenceProviderId(providerId)) return { ok: false, error: "unsupported intelligence provider" };
	const account = await authenticatedAccount();
	if (!account?.user) return { ok: false, error: "sign in to Qorpera before connecting intelligence" };
	const userData = app.getPath("userData");
	const verified = await verifiedIntelligenceInfo();
	const connected = verified.providers.find((provider) => provider.id === providerId)?.connected ?? false;
	const boundToThisAccount = intelligenceBindingMatches(
		readIntelligenceAccountBinding(userData),
		account.user.id,
		providerId,
	);
	if (!connected || !boundToThisAccount) {
		const connection = await connectModelAccount(sender, providerId);
		if (!connection.ok) {
			return {
				ok: false,
				...(connection.cancelled ? { cancelled: true as const } : {}),
				error: connection.error ?? "intelligence connection failed",
			};
		}
	}
	const selection = intelligenceSelectionForProvider(providerId);
	if (!selection || !writeDefaultRuntimeModelPreference(userData, selection)) {
		return { ok: false, error: "could not persist the default intelligence" };
	}
	if (!writeIntelligenceAccountBinding(userData, { accountUserId: account.user.id, providerId })) {
		return { ok: false, error: "could not connect this intelligence to your Qorpera account" };
	}
	if (!boundToThisAccount) {
		for (const company of listCompanies()) writeCompanyRuntimeModelPreference(userData, company.root, selection);
	}
	const slot = slotOf(sender);
	if (slot?.runtime) writeCompanyRuntimeModelPreference(userData, slot.runtime.root, selection);
	return { ok: true, intelligence: intelligenceInfo() };
}

async function disconnectModelAccount(
	sender: WebContents,
	connectionId: string,
	accountId: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
	const slot = slotOf(sender);
	const connection = MODEL_CONNECTIONS.find((candidate) => candidate.id === connectionId);
	if (!slot || !connection || !modelAccountStore) return { ok: false, error: "unsupported model account" };
	const account = modelAccountStore.views().find((candidate) => candidate.id === accountId);
	if (!account || !connection.credentialProviders.some((providerId) => providerId === account.providerId)) {
		return { ok: false, error: "model account is unavailable" };
	}
	const login = connectionLogins.get(sender.id);
	if (login?.connectionId === connectionId) login.controller.abort();
	if (!(await modelAccountStore.remove(accountId))) return { ok: false, error: "model account is unavailable" };
	await refreshBrokerModels([account.providerId]);
	const hasRemainingAccounts = modelAccountStore
		.views()
		.some((candidate) => connection.credentialProviders.some((providerId) => providerId === candidate.providerId));
	if (hasRemainingAccounts) {
		await refreshSlotModelCredentials(slot).catch(() => false);
		return { ok: true, message: `${account.accountName} disconnected.` };
	}

	const userData = app.getPath("userData");
	const usesConnection = (selection: RuntimeModelSelection | undefined): boolean =>
		Boolean(selection && connection.credentialProviders.some((providerId) => providerId === selection.provider));
	const activeUsesConnection = usesConnection(slot.runtime?.childOptions.model);
	const companyRootsUsingConnection = listCompanies()
		.filter((company) => usesConnection(readCompanyRuntimeModelPreference(userData, company.root)))
		.map((company) => company.root);
	if (usesConnection(readDefaultRuntimeModelPreference(userData))) clearDefaultRuntimeModelPreference(userData);
	for (const root of companyRootsUsingConnection) clearCompanyRuntimeModelPreference(userData, root);
	if (readIntelligenceAccountBinding(userData)?.providerId === connectionId) clearIntelligenceAccountBinding(userData);
	if (activeUsesConnection && slot.runtime) {
		const { model: _model, ...remainingOptions } = slot.runtime.childOptions;
		slot.runtime.childOptions = remainingOptions;
		await refreshSlotModelCredentials(slot).catch(() => false);
	}
	return { ok: true, message: `${account.accountName} disconnected.` };
}

function disconnectGitHubAccount(sender: WebContents): { ok: true; message: string } | { ok: false; error: string } {
	const root = slotOf(sender)?.runtime?.root;
	if (!root) return { ok: false, error: "Open a company before disconnecting GitHub." };
	try {
		removeCompanySecret(root, "github");
		for (const [host] of GITHUB_CONNECTION_DESTINATIONS) removeNetworkDestination(root, host);
		return { ok: true, message: "GitHub disconnected from this company." };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function signOutIntelligence(
	sender: WebContents,
): Promise<{ ok: true; intelligence: ReturnType<typeof intelligenceInfo> } | { ok: false; error: string }> {
	const login = connectionLogins.get(sender.id);
	if (login) login.controller.abort();
	try {
		if (!modelAccountStore) throw new Error("Model account storage is unavailable");
		await modelAccountStore.removeAll();
		await refreshBrokerModels();
	} catch (error) {
		return {
			ok: false,
			error: `Could not remove intelligence accounts: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const userData = app.getPath("userData");
	const preferencesCleared = [
		clearDefaultRuntimeModelPreference(userData),
		...listCompanies().map((company) => clearCompanyRuntimeModelPreference(userData, company.root)),
		clearIntelligenceAccountBinding(userData),
	].every(Boolean);
	if (!preferencesCleared)
		return { ok: false, error: "The account was removed, but its saved model choice could not be cleared." };
	return { ok: true, intelligence: intelligenceInfo() };
}

async function connectGitHubAccount(sender: WebContents): Promise<{
	ok: boolean;
	cancelled?: true;
	error?: string;
	message?: string;
}> {
	const slot = slotOf(sender);
	if (!slot) return { ok: false, error: "GitHub can only be connected from a Qorpera window" };
	if (connectionLogins.has(sender.id)) return { ok: false, error: "another account connection is in progress" };
	const controller = new AbortController();
	connectionLogins.set(sender.id, { connectionId: "github", controller });
	const report = (message: string): void => {
		send(slot.window, "connection-status", { connectionId: "github", message });
	};
	try {
		const account = await connectGitHubCli({ signal: controller.signal, report });
		const companyRoot = slot.runtime?.root;
		if (companyRoot) {
			// The founder selected this exact company connector and completed its
			// GitHub sign-in. That protected provider interaction is the approval
			// boundary; a second host gate would ask for the same consent again.
			if (slot.runtime?.root !== companyRoot) return { ok: false, error: "the active company changed" };
			bindCompanySecret(companyRoot, "github", { kind: "static", value: account.token });
			for (const [host, note] of GITHUB_CONNECTION_DESTINATIONS) {
				bindNetworkDestination(companyRoot, host, note);
			}
		}
		const message = companyRoot
			? `Connected ${account.accountName} to this company.`
			: `Connected ${account.accountName}. Open a company to grant it access.`;
		report(message);
		return { ok: true, message };
	} catch (error) {
		const result = connectionError(error);
		report(result.cancelled ? "Connection cancelled." : (result.error ?? "Connection failed."));
		return result;
	} finally {
		connectionLogins.delete(sender.id);
	}
}

function companyConnectorForRequest(
	root: string,
	request: Pick<ConnectionRequest, "staffAgentId" | "displayName" | "destinations" | "secretNames" | "recipeId">,
): CompanyConnectorManifestRecord | undefined {
	if (!request.recipeId?.startsWith("company:")) return undefined;
	const connectorId = request.recipeId.slice("company:".length);
	const connector = readCompanyConnectorManifests(root).find((candidate) => candidate.id === connectorId);
	return connector && companyConnectorMatchesRequest(connector, request) ? connector : undefined;
}

function companyConnectorNeedsRegistration(root: string, connector: CompanyConnectorManifestRecord): boolean {
	const credentialName =
		connector.authentication.kind === "oauth2" ? connector.authentication.clientSecretName : undefined;
	if (!credentialName || connector.authentication.kind !== "oauth2" || !connector.authentication.registrationUrl) {
		return false;
	}
	try {
		return !readCompanyConnections(root).secretNames.includes(credentialName);
	} catch {
		return true;
	}
}

function companyConnectorSignInError(root: string, connector: CompanyConnectorManifestRecord): string | undefined {
	const credentialName =
		connector.authentication.kind === "oauth2" ? connector.authentication.clientSecretName : undefined;
	if (!credentialName || companyConnectorNeedsRegistration(root, connector)) return undefined;
	try {
		if (readCompanyConnections(root).secretNames.includes(credentialName)) return undefined;
	} catch {
		// Keep machine credential details out of the renderer-facing error.
	}
	return `${connector.displayName} sign-in is not available on this computer yet`;
}

async function connectCompanyConnector(
	sender: WebContents,
	connector: CompanyConnectorManifestRecord,
): Promise<{ ok: boolean; cancelled?: true; error?: string; message?: string; pendingSetup?: true }> {
	const slot = slotOf(sender);
	const companyRoot = slot?.runtime?.root;
	if (!slot || !companyRoot) return { ok: false, error: "A company connector requires an active company" };
	const signInError = companyConnectorSignInError(companyRoot, connector);
	if (signInError) return { ok: false, error: signInError };
	if (connectionLogins.has(sender.id)) return { ok: false, error: "another account connection is in progress" };
	const controller = new AbortController();
	connectionLogins.set(sender.id, { connectionId: connector.id, controller });
	const report = (message: string): void => {
		send(slot.window, "connection-status", { connectionId: connector.id, message });
	};
	let createdOAuthSecret = false;
	try {
		if (connector.authentication.kind !== "oauth2") {
			const authentication =
				connector.authentication.kind === "none"
					? "None"
					: `${connector.authentication.label} → secret://${connector.authentication.secretName}`;
			const approved = await confirmKernelReview(slot.window, {
				title: `Connect ${connector.displayName}`,
				summary: "Allow this company connector to use the exact operations and destinations below?",
				exactText: [
					`Manifest: ${connector.relativePath}`,
					`Environment: ${connector.environment ?? "production"}`,
					"Operations:",
					...connector.operations.map(
						(operation) => `- ${operation.access.toUpperCase()}: ${operation.label} — ${operation.description}`,
					),
					`Authentication: ${authentication}`,
					`Destinations: ${connector.destinations.map((destination) => destination.host).join(", ")}`,
				].join("\n"),
			});
			if (!approved) return { ok: false, cancelled: true };
		}
		if (slot.runtime?.root !== companyRoot) return { ok: false, error: "the active company changed" };
		const current = readCompanyConnections(companyRoot);
		const tokenBound =
			connector.authentication.kind !== "none" && current.secretNames.includes(connector.authentication.secretName);
		if (connector.authentication.kind === "api-key" && !tokenBound) {
			const secret = await promptKernelSecret(slot.window, {
				title: `Connect ${connector.displayName}`,
				summary: `Stored as secret://${connector.authentication.secretName}. The value stays in the host vault and is never sent to the agent or company files.`,
				label: connector.authentication.label,
			});
			if (secret === undefined) return { ok: false, cancelled: true };
			if (slot.runtime?.root !== companyRoot) return { ok: false, error: "the active company changed" };
			bindCompanySecret(companyRoot, connector.authentication.secretName, { kind: "static", value: secret });
		} else if (connector.authentication.kind === "oauth2") {
			const clientSecretName = connector.authentication.clientSecretName;
			const clientSecret =
				clientSecretName && current.secretNames.includes(clientSecretName)
					? await resolveCompanySecret(companyRoot, clientSecretName)
					: undefined;
			if (clientSecretName && clientSecret === undefined) {
				if (connector.authentication.registrationUrl) {
					const message = `${connector.displayName} is waiting at the private sign-in step in Chrome.`;
					report(message);
					return { ok: true, pendingSetup: true, message };
				}
				return { ok: false, error: `${connector.displayName} sign-in is not available on this computer yet` };
			}
			if (!tokenBound) {
				report(`Opening ${connector.displayName} sign-in in your browser…`);
				await runOAuthOnboarding(
					companyRoot,
					connector.authentication.secretName,
					{
						authUrl: connector.authentication.authorizationUrl,
						tokenUrl: connector.authentication.tokenUrl,
						clientId: connector.authentication.clientId,
						...(clientSecret ? { clientSecret } : {}),
						...(connector.authentication.scopes.length
							? {
									scope: connector.authentication.scopes.join(
										connector.authentication.authorization?.scopeSeparator === "comma" ? "," : " ",
									),
								}
							: {}),
						...(connector.authentication.authorization?.method
							? { authorizationMethod: connector.authentication.authorization.method }
							: {}),
						...(connector.authentication.authorization?.usePkce !== undefined
							? { usePkce: connector.authentication.authorization.usePkce }
							: {}),
						...(connector.authentication.authorization?.parameters
							? { authorizationParameters: connector.authentication.authorization.parameters }
							: {}),
						...(connector.authentication.authorization?.headers
							? { authorizationHeaders: connector.authentication.authorization.headers }
							: {}),
						...(connector.authentication.clientAuthentication
							? { clientAuthentication: connector.authentication.clientAuthentication }
							: {}),
						...(connector.authentication.tokenHeaders
							? { tokenHeaders: connector.authentication.tokenHeaders }
							: {}),
					},
					{
						signal: controller.signal,
						onAuthorizeUrl: (url) => {
							report(`${connector.displayName} is open in Qorpera Chrome. Complete the provider step there.`);
							const runtimeChild = slot.runtime?.child;
							const computer = runtimeChild ? childComputerBrokers.get(runtimeChild) : undefined;
							const opened = computer ? computer.openPrivateProviderUrl(url) : electronShell.openExternal(url);
							void opened.catch(() => {
								report("The browser could not be opened. Connection cancelled.");
								controller.abort();
							});
						},
					},
				);
				createdOAuthSecret = true;
				report(`Checking the ${connector.displayName} connection…`);
			}
			if (slot.runtime?.root !== companyRoot) {
				if (createdOAuthSecret) removeCompanySecret(companyRoot, connector.authentication.secretName);
				return { ok: false, error: "the active company changed" };
			}
		}
		for (const destination of connector.destinations) {
			bindNetworkDestination(companyRoot, destination.host, destination.note);
		}
		const message = `Connected ${connector.displayName} to this company.`;
		report(message);
		return { ok: true, message };
	} catch (error) {
		if (createdOAuthSecret && connector.authentication.kind === "oauth2") {
			removeCompanySecret(companyRoot, connector.authentication.secretName);
		}
		const result = connectionError(error);
		report(result.cancelled ? "Connection cancelled." : (result.error ?? "Connection failed."));
		return result;
	} finally {
		connectionLogins.delete(sender.id);
	}
}

function scheduleRuntimeReconnect(
	slot: Slot,
	runtime: CompanyRuntime,
	exitedChild: ChildProcessWithoutNullStreams,
	sessionFile: string,
	model: RuntimeModelSelection | undefined,
	code: number | null,
	detail: string,
): void {
	const binding = childBindings.get(exitedChild);
	const sessions = childSessionPlanes.get(exitedChild);
	const executorId = childExecutorIds.get(exitedChild);
	const now = Date.now();
	if (!runtime.lastUnexpectedRuntimeExitAt || now - runtime.lastUnexpectedRuntimeExitAt > 30_000) {
		runtime.runtimeReconnectAttempts = 0;
	}
	runtime.lastUnexpectedRuntimeExitAt = now;
	runtime.runtimeReconnectAttempts += 1;
	const attempt = runtime.runtimeReconnectAttempts;
	if (attempt > 3) {
		if (binding && sessions && executorId) {
			recordSessionRuntime(sessions, binding, {
				kind: "reconnect_failed",
				executorId,
				attempt,
				...(detail ? { detail } : {}),
			});
		}
		send(slot.window, "rpc-exit", code);
		return;
	}

	if (binding && sessions && executorId) {
		if (
			!recordSessionRuntime(sessions, binding, {
				kind: "reconnect_scheduled",
				executorId,
				attempt,
				code,
				...(detail ? { detail } : {}),
			})
		) {
			send(slot.window, "rpc-exit", code);
			return;
		}
	} else {
		send(slot.window, "rpc-exit", code);
		return;
	}
	void enqueueRuntimeTransition(runtime, async () => {
		await childCheckpointCompletion.get(exitedChild);
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, [250, 750, 2_000][attempt - 1]));
		if (slot.runtime !== runtime || runtime.closing || runtime.child !== exitedChild) return;
		const resumeOptions: ChildOptions = {
			...runtime.childOptions,
			sessionFile,
			model: model ?? runtime.childOptions.model,
		};
		runtime.childOptions = resumeOptions;
		runtime.child = startLegacyPiSessionAttachment(slot, runtime.root, resumeOptions);
	}).catch((error) => {
		console.error(`agent runtime reconnect failed: ${(error as Error).message}`);
		if (slot.runtime !== runtime || runtime.closing || runtime.child !== exitedChild) return;
		scheduleRuntimeReconnect(
			slot,
			runtime,
			exitedChild,
			sessionFile,
			model,
			code,
			`${detail}\nreconnect: ${(error as Error).message}`.trim(),
		);
	});
}

function isCurrentRuntimeChild(
	slot: Slot,
	runtime: CompanyRuntime,
	child: ChildProcessWithoutNullStreams | undefined,
): child is ChildProcessWithoutNullStreams {
	return Boolean(
		child && slot.runtime === runtime && !runtime.closing && runtime.child === child && child.exitCode === null,
	);
}

function restartForProductInventory(slot: Slot, runtime: CompanyRuntime): void {
	void enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.wakeChild) return;
		if (isChildBusy(runtime.child)) {
			runtime.pendingInventoryRestart = true;
			return;
		}
		runtime.pendingInventoryRestart = false;
		const child = runtime.child;
		if (!child) {
			readProductProtectionInventory(runtime.root);
			return;
		}
		const options = {
			...runtime.childOptions,
			sessionFile: childBindings.get(child)?.file ?? runtime.childOptions.sessionFile,
		};
		await stopChild(child);
		if (slot.runtime !== runtime) return;
		try {
			readProductProtectionInventory(runtime.root);
		} finally {
			await restoreAttendedChild(slot, runtime, options, "product-inventory agent runtime restore failed");
		}
	}).catch((error) => {
		console.error(`product inventory transition stopped the agent runtime: ${(error as Error).message}`);
	});
}

function isInside(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Build the exact unattended prompt for a scheduled or event-driven run. */
function wakePrompt(
	cause: "schedule" | "founder_response" | "inbound_event" | "agent_message",
	coalesced: number,
	job?: ScheduledJob,
	trigger?: PendingRoutineTrigger,
): string {
	const missed =
		coalesced > 0
			? ` Qorpera was closed or asleep for a while: ${coalesced} missed wake${coalesced === 1 ? "" : "s"} were coalesced into this one.`
			: "";
	if (cause === "agent_message") {
		return `Wake: a coworker sent you one or more messages. Read the unhandled coworker messages listed in your context and act on each: do the requested work if it belongs to your responsibility, reply with send_agent_message when the sender needs an answer, and post an inbox item if something needs the founder. Settle when every message is handled.${missed}`;
	}
	if (cause === "founder_response") {
		return `Wake: the founder responded in the inbox. Read the updated items and continue the affected work; post follow-up inbox items for anything that needs the founder again.${missed}`;
	}
	if (cause === "inbound_event") {
		if (job && trigger) {
			return `Triggered routine: ${job.title}.\n\nEvent: ${trigger.event.summary}\nSource: ${trigger.event.source}${trigger.event.repository ? `\nRepository: ${trigger.event.repository}` : ""}${trigger.event.actor ? `\nActor: ${trigger.event.actor}` : ""}\nThe full event is stored under inbox/events/.\n\n${job.prompt}`;
		}
		return `Wake: an external event arrived. Read the new files under inbox/events/, decide what they mean for the company, and act; events are durable, so handle every unprocessed one, not just the newest.${missed}`;
	}
	return `Scheduled job: ${job?.title ?? "Agent work"}.${missed}\n\n${job?.prompt ?? "Review your charter, owned artifacts, granted connectors, recent trail, and relevant inbox items. Advance the responsibility and measures you own; when nothing needs doing, settle without inventing work."}`;
}

/** Reduce provider-specific stream frames to a small session activity
 * vocabulary. Content deltas stay on the attached chat's RPC stream; these
 * ephemeral phase changes render identically in every live observer. */
function sessionActivityFromFrame(frame: Record<string, unknown>): SessionRuntimeActivity | undefined {
	if (frame.type === "agent_start") return { kind: "thinking" };
	if (frame.type === "tool_execution_start") {
		const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
		const args = (frame.args ?? {}) as Record<string, unknown>;
		// Expose only file-like subjects. Commands, search text, and URLs may
		// contain credentials or private input and belong in the live RPC stream.
		const target = [args.path, args.filePath, args.file_path].find(
			(value) => typeof value === "string" && value.trim(),
		) as string | undefined;
		return {
			kind: "tool",
			tool: name,
			...(target ? { subject: target.slice(0, 120) } : {}),
		};
	}
	if (frame.type === "message_update") {
		const delta = (frame as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
		if (delta?.type === "thinking_start") return { kind: "thinking" };
		if (delta?.type === "text_start") return { kind: "writing" };
	}
	return undefined;
}

function parsedStaffConnectionRequestToolInput(value: unknown): StaffConnectionRequestToolInput | undefined {
	const args = recordValue(value);
	if (
		!args ||
		typeof args.displayName !== "string" ||
		typeof args.purpose !== "string" ||
		!Array.isArray(args.destinations) ||
		!args.destinations.every((destination) => {
			const candidate = recordValue(destination);
			return (
				candidate !== undefined &&
				typeof candidate.host === "string" &&
				(candidate.note === undefined || typeof candidate.note === "string") &&
				Object.keys(candidate).every((key) => key === "host" || key === "note")
			);
		}) ||
		!Array.isArray(args.secretNames) ||
		!args.secretNames.every((secretName) => typeof secretName === "string") ||
		(args.providerSuggestions !== undefined &&
			(!Array.isArray(args.providerSuggestions) ||
				args.providerSuggestions.length < 2 ||
				args.providerSuggestions.length > 4 ||
				!args.providerSuggestions.every((suggestion) => typeof suggestion === "string"))) ||
		(args.recipeId !== undefined && typeof args.recipeId !== "string") ||
		(args.artifactId !== undefined && typeof args.artifactId !== "string") ||
		(args.dataNeedId !== undefined && typeof args.dataNeedId !== "string") ||
		(args.artifactId === undefined) !== (args.dataNeedId === undefined) ||
		Object.keys(args).some(
			(key) =>
				![
					"displayName",
					"purpose",
					"destinations",
					"secretNames",
					"providerSuggestions",
					"recipeId",
					"artifactId",
					"dataNeedId",
				].includes(key),
		)
	) {
		return undefined;
	}
	return {
		displayName: args.displayName,
		purpose: args.purpose,
		destinations: args.destinations.map((destination) => {
			const candidate = destination as { host: string; note?: string };
			return { host: candidate.host, ...(candidate.note !== undefined ? { note: candidate.note } : {}) };
		}),
		secretNames: [...args.secretNames] as string[],
		...(Array.isArray(args.providerSuggestions)
			? { providerSuggestions: [...args.providerSuggestions] as string[] }
			: {}),
		...(typeof args.recipeId === "string" ? { recipeId: args.recipeId } : {}),
		...(typeof args.artifactId === "string" ? { artifactId: args.artifactId } : {}),
		...(typeof args.dataNeedId === "string" ? { dataNeedId: args.dataNeedId } : {}),
	};
}

function parsedStaffRoutineOperation(value: unknown): StaffRoutineOperation | undefined {
	const input = recordValue(value);
	if (!input || typeof input.routineKey !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.routineKey)) {
		return undefined;
	}
	const reviewerStaffIds = input.reviewerStaffIds;
	if (
		reviewerStaffIds !== undefined &&
		(!Array.isArray(reviewerStaffIds) ||
			reviewerStaffIds.length > 20 ||
			new Set(reviewerStaffIds).size !== reviewerStaffIds.length ||
			!reviewerStaffIds.every(
				(id) =>
					typeof id === "string" &&
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
			))
	) {
		return undefined;
	}
	if (input.action === "upsert") {
		if (
			Object.keys(input).some(
				(key) =>
					![
						"action",
						"routineKey",
						"title",
						"instructions",
						"intervalMinutes",
						"startAt",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			typeof input.title !== "string" ||
			!input.title.trim() ||
			input.title !== input.title.trim() ||
			Buffer.byteLength(input.title, "utf-8") > 160 ||
			typeof input.instructions !== "string" ||
			!input.instructions.trim() ||
			input.instructions !== input.instructions.trim() ||
			Buffer.byteLength(input.instructions, "utf-8") > 32 * 1024 ||
			typeof input.intervalMinutes !== "number" ||
			!Number.isInteger(input.intervalMinutes) ||
			input.intervalMinutes < 5 ||
			input.intervalMinutes > 10_080 ||
			(input.startAt !== undefined &&
				(typeof input.startAt !== "string" ||
					input.startAt !== input.startAt.trim() ||
					input.startAt.length > 64 ||
					!Number.isFinite(Date.parse(input.startAt)))) ||
			(input.effort !== undefined && !SCHEDULED_JOB_EFFORTS.includes(input.effort as ScheduledJobEffort))
		) {
			return undefined;
		}
		return {
			action: "upsert",
			routineKey: input.routineKey,
			title: input.title,
			instructions: input.instructions,
			intervalMinutes: input.intervalMinutes,
			...(typeof input.startAt === "string" ? { startAt: input.startAt } : {}),
			...(input.effort !== undefined ? { effort: input.effort as ScheduledJobEffort } : {}),
			...(reviewerStaffIds !== undefined ? { reviewerStaffIds: reviewerStaffIds as string[] } : {}),
		};
	}
	if (input.action === "upsert_weekly") {
		const timeZone = input.timeZone ?? "auto";
		if (
			Object.keys(input).some(
				(key) =>
					![
						"action",
						"routineKey",
						"title",
						"instructions",
						"weekdays",
						"localTime",
						"timeZone",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			typeof input.title !== "string" ||
			!input.title.trim() ||
			input.title !== input.title.trim() ||
			Buffer.byteLength(input.title, "utf-8") > 160 ||
			typeof input.instructions !== "string" ||
			!input.instructions.trim() ||
			input.instructions !== input.instructions.trim() ||
			Buffer.byteLength(input.instructions, "utf-8") > 32 * 1024 ||
			!Array.isArray(input.weekdays) ||
			input.weekdays.length < 1 ||
			input.weekdays.length > 7 ||
			new Set(input.weekdays).size !== input.weekdays.length ||
			!input.weekdays.every(
				(weekday) => typeof weekday === "string" && ROUTINE_WEEKDAYS.includes(weekday as RoutineWeekday),
			) ||
			typeof input.localTime !== "string" ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime) ||
			typeof timeZone !== "string" ||
			!timeZone ||
			timeZone.length > 100 ||
			(input.effort !== undefined && !SCHEDULED_JOB_EFFORTS.includes(input.effort as ScheduledJobEffort))
		) {
			return undefined;
		}
		if (timeZone !== "auto") {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
			} catch {
				return undefined;
			}
		}
		return {
			action: "upsert_weekly",
			routineKey: input.routineKey,
			title: input.title,
			instructions: input.instructions,
			weekdays: input.weekdays as RoutineWeekday[],
			localTime: input.localTime,
			timeZone,
			...(input.effort !== undefined ? { effort: input.effort as ScheduledJobEffort } : {}),
			...(reviewerStaffIds !== undefined ? { reviewerStaffIds: reviewerStaffIds as string[] } : {}),
		};
	}
	if (input.action === "upsert_event") {
		if (
			Object.keys(input).some(
				(key) =>
					![
						"action",
						"routineKey",
						"eventDescription",
						"title",
						"instructions",
						"sourceHints",
						"checkEveryMinutes",
						"effort",
						"reviewerStaffIds",
					].includes(key),
			) ||
			typeof input.title !== "string" ||
			!input.title.trim() ||
			input.title !== input.title.trim() ||
			Buffer.byteLength(input.title, "utf-8") > 160 ||
			typeof input.instructions !== "string" ||
			!input.instructions.trim() ||
			input.instructions !== input.instructions.trim() ||
			Buffer.byteLength(input.instructions, "utf-8") > 32 * 1024 ||
			typeof input.eventDescription !== "string" ||
			!input.eventDescription.trim() ||
			input.eventDescription !== input.eventDescription.trim() ||
			Buffer.byteLength(input.eventDescription, "utf-8") > 2_000 ||
			(input.sourceHints !== undefined &&
				(!Array.isArray(input.sourceHints) ||
					input.sourceHints.length < 1 ||
					input.sourceHints.length > 8 ||
					!input.sourceHints.every(
						(hint) =>
							typeof hint === "string" && Boolean(hint.trim()) && hint === hint.trim() && hint.length <= 120,
					))) ||
			(input.checkEveryMinutes !== undefined &&
				(typeof input.checkEveryMinutes !== "number" ||
					!Number.isInteger(input.checkEveryMinutes) ||
					input.checkEveryMinutes < 5 ||
					input.checkEveryMinutes > 10_080)) ||
			(input.effort !== undefined && !SCHEDULED_JOB_EFFORTS.includes(input.effort as ScheduledJobEffort))
		) {
			return undefined;
		}
		return {
			action: "upsert_event",
			routineKey: input.routineKey,
			title: input.title,
			instructions: input.instructions,
			eventDescription: input.eventDescription,
			sourceHints: Array.isArray(input.sourceHints) ? (input.sourceHints as string[]) : [],
			checkEveryMinutes: typeof input.checkEveryMinutes === "number" ? input.checkEveryMinutes : 15,
			...(input.effort !== undefined ? { effort: input.effort as ScheduledJobEffort } : {}),
			...(reviewerStaffIds !== undefined ? { reviewerStaffIds: reviewerStaffIds as string[] } : {}),
		};
	}
	if (
		(input.action === "pause" || input.action === "resume" || input.action === "remove") &&
		Object.keys(input).every((key) => key === "action" || key === "routineKey")
	) {
		return { action: input.action, routineKey: input.routineKey };
	}
	return undefined;
}

function parsedRoutinePublicationPolicy(root: string, value: unknown): RoutinePublicationPolicy | null | undefined {
	if (value === undefined) return undefined;
	const policy = recordValue(value);
	if (!policy) return null;
	if (policy.mode === "automatic" && Object.keys(policy).length === 1) return { mode: "automatic" };
	if (
		policy.mode !== "review" ||
		Object.keys(policy).some((key) => key !== "mode" && key !== "reviewerStaffIds") ||
		!Array.isArray(policy.reviewerStaffIds) ||
		policy.reviewerStaffIds.length < 1 ||
		policy.reviewerStaffIds.length > 20 ||
		new Set(policy.reviewerStaffIds).size !== policy.reviewerStaffIds.length ||
		!policy.reviewerStaffIds.every((id) => typeof id === "string" && activeStaffAgent(root, id) !== undefined)
	) {
		return null;
	}
	return { mode: "review", reviewerStaffIds: [...policy.reviewerStaffIds] as string[] };
}

function parsedStaffArtifactObservation(value: unknown): StaffArtifactObservationToolInput | undefined {
	const input = recordValue(value);
	if (
		!input ||
		typeof input.artifactId !== "string" ||
		!input.artifactId.trim() ||
		input.artifactId.length > 256 ||
		typeof input.dataNeedId !== "string" ||
		typeof input.sourceRef !== "string" ||
		typeof input.observedAt !== "string" ||
		!Array.isArray(input.metrics) ||
		input.metrics.length === 0 ||
		input.metrics.length > 64 ||
		Object.keys(input).some(
			(key) => !["artifactId", "dataNeedId", "sourceRef", "observedAt", "metrics"].includes(key),
		)
	) {
		return undefined;
	}
	const metrics: Array<CompanyArtifactObservationUpdate["metrics"][number]> = [];
	for (const metric of input.metrics) {
		const entry = recordValue(metric);
		if (
			!entry ||
			typeof entry.id !== "string" ||
			(typeof entry.value !== "string" && typeof entry.value !== "number") ||
			(entry.score !== undefined && typeof entry.score !== "number") ||
			(entry.evidence !== undefined &&
				(!Array.isArray(entry.evidence) || !entry.evidence.every((evidence) => typeof evidence === "string"))) ||
			Object.keys(entry).some((key) => !["id", "value", "score", "evidence"].includes(key))
		) {
			return undefined;
		}
		metrics.push({
			id: entry.id,
			value: entry.value,
			...(entry.score !== undefined ? { score: entry.score } : {}),
			...(entry.evidence !== undefined ? { evidence: entry.evidence as string[] } : {}),
		});
	}
	return {
		artifactId: input.artifactId,
		update: {
			dataNeedId: input.dataNeedId,
			sourceRef: input.sourceRef,
			observedAt: input.observedAt,
			metrics,
		},
	};
}

function parsedStaffArtifactSourceAssessment(value: unknown): StaffArtifactSourceAssessmentToolInput | undefined {
	const input = recordValue(value);
	if (
		!input ||
		typeof input.artifactId !== "string" ||
		!input.artifactId.trim() ||
		input.artifactId.length > 256 ||
		typeof input.dataNeedId !== "string" ||
		typeof input.sourceRef !== "string" ||
		typeof input.dataType !== "string" ||
		(input.decision !== "authoritative" && input.decision !== "supporting" && input.decision !== "invalid") ||
		typeof input.rationale !== "string" ||
		!Array.isArray(input.metricIds) ||
		input.metricIds.length === 0 ||
		input.metricIds.length > 64 ||
		!input.metricIds.every((metricId) => typeof metricId === "string") ||
		!Array.isArray(input.evidence) ||
		input.evidence.length === 0 ||
		input.evidence.length > 64 ||
		!input.evidence.every((evidence) => typeof evidence === "string") ||
		typeof input.assessedAt !== "string" ||
		Object.keys(input).some(
			(key) =>
				![
					"artifactId",
					"dataNeedId",
					"sourceRef",
					"dataType",
					"decision",
					"rationale",
					"metricIds",
					"evidence",
					"assessedAt",
				].includes(key),
		)
	) {
		return undefined;
	}
	return {
		artifactId: input.artifactId,
		update: {
			dataNeedId: input.dataNeedId,
			sourceRef: input.sourceRef,
			dataType: input.dataType,
			decision: input.decision,
			rationale: input.rationale,
			metricIds: input.metricIds as string[],
			evidence: input.evidence as string[],
			assessedAt: input.assessedAt,
		},
	};
}

function parsedStaffArtifactSourceIssue(value: unknown): StaffArtifactSourceIssueToolInput | undefined {
	const input = recordValue(value);
	if (
		!input ||
		typeof input.artifactId !== "string" ||
		!input.artifactId.trim() ||
		input.artifactId.length > 256 ||
		typeof input.dataNeedId !== "string" ||
		typeof input.sourceRef !== "string" ||
		typeof input.occurredAt !== "string" ||
		(input.status !== "stale" && input.status !== "blocked") ||
		typeof input.reason !== "string" ||
		!Array.isArray(input.metricIds) ||
		input.metricIds.length === 0 ||
		input.metricIds.length > 64 ||
		!input.metricIds.every((metricId) => typeof metricId === "string") ||
		Object.keys(input).some(
			(key) =>
				!["artifactId", "dataNeedId", "sourceRef", "occurredAt", "status", "reason", "metricIds"].includes(key),
		)
	) {
		return undefined;
	}
	return {
		artifactId: input.artifactId,
		update: {
			dataNeedId: input.dataNeedId,
			sourceRef: input.sourceRef,
			occurredAt: input.occurredAt,
			status: input.status,
			reason: input.reason,
			metricIds: input.metricIds as string[],
		},
	};
}

async function applyStaffCompanyOperation(
	slot: Slot,
	companyRoot: string,
	operationRoot: string,
	child: ChildProcessWithoutNullStreams,
	staffAgentId: string,
	binding: TrailBinding,
	kind: CompanyOperationKind,
	value: unknown,
): Promise<{ message: string }> {
	const runtime = slot.runtime;
	const attached =
		runtime && isCurrentRuntimeChild(slot, runtime, child) && runtime.childOptions.staffAgentId === staffAgentId;
	const background = runtime?.wakeChild === child && runtime.child !== child;
	if (!runtime || (!attached && !background)) throw new Error("agent runtime is no longer attached to this company");
	const staff = activeStaffAgent(operationRoot, staffAgentId);
	if (!staff) throw new Error("agent is unavailable or archived");
	const triggerWorker = childTriggerWorkers.get(child);

	if (kind === "authorize_connector_http") {
		authorizeConnectorHttpExecution(app.getPath("userData"), companyRoot, value);
		return { message: "Connector request is authorized by its completed connection grant." };
	}

	if (kind === "finish_trigger_build") {
		if (!background || triggerWorker?.kind !== "build") throw new Error("no custom-trigger build is assigned");
		const input = recordValue(value);
		if (
			!input ||
			input.buildId !== triggerWorker.buildId ||
			(input.status !== "ready" && input.status !== "failed")
		) {
			throw new Error("custom-trigger build result is invalid");
		}
		const statePath = customTriggerBuildStatePath(app.getPath("userData"), companyRoot);
		const state = readCustomTriggerBuildState(statePath);
		const build = state.builds.find((candidate) => candidate.id === triggerWorker.buildId);
		if (!build || build.status !== "building" || build.staffAgentId !== staffAgentId) {
			throw new Error("custom-trigger build is no longer active");
		}
		if (input.status === "failed") {
			if (typeof input.error !== "string" || !input.error.trim() || input.error.length > 2_000) {
				throw new Error("custom-trigger failure needs a concrete bounded error");
			}
			const finished = finishCustomTriggerBuild(state, build.id, { status: "failed", error: input.error.trim() });
			writeCustomTriggerBuildState(statePath, finished.state);
			writeFileSync(
				join(inboxMessagesPath(operationRoot), `msg-trigger-build-failed-${Date.now()}.md`),
				`# Trigger could not be created\n\n**${build.title}**\n\n${input.error.trim()}\n`,
				"utf-8",
			);
			childTriggerWorkers.delete(child);
			return { message: "Custom trigger failure was recorded." };
		}
		if (
			typeof input.monitorInstructions !== "string" ||
			!input.monitorInstructions.trim() ||
			Buffer.byteLength(input.monitorInstructions, "utf-8") > 32 * 1024 ||
			!Array.isArray(input.connectorIds) ||
			input.connectorIds.length > 16 ||
			!input.connectorIds.every(
				(connectorId) => typeof connectorId === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(connectorId),
			) ||
			typeof input.eventLabel !== "string" ||
			!input.eventLabel.trim() ||
			Buffer.byteLength(input.eventLabel, "utf-8") > 160
		) {
			throw new Error("custom-trigger monitor definition is invalid");
		}
		const connectorIds = [...new Set(input.connectorIds as string[])];
		const installed = new Set(readCompanyConnectorManifests(operationRoot).map((connector) => connector.id));
		if (connectorIds.some((connectorId) => !installed.has(connectorId))) {
			throw new Error("custom-trigger monitor references an unavailable connector");
		}
		const adapterHash = createHash("sha256").update(`${staffAgentId}:${build.routineKey}`).digest("hex").slice(0, 24);
		const job = upsertStaffScheduledJob(operationRoot, staffAgentId, build.routineKey, {
			title: build.title,
			prompt: build.instructions,
			triggers: [
				{
					id: `custom-${adapterHash}`,
					kind: "custom",
					adapterId: `agent.${adapterHash}`,
					event: "matched",
					label: input.eventLabel.trim(),
					monitor: {
						instructions: input.monitorInstructions.trim(),
						intervalMinutes: build.checkEveryMinutes,
						connectorIds,
					},
				},
			],
			enabled: true,
			effort: build.effort,
			...(build.reviewerStaffIds === undefined
				? {}
				: {
						publication:
							build.reviewerStaffIds.length === 0
								? ({ mode: "automatic" } as const)
								: ({ mode: "review", reviewerStaffIds: build.reviewerStaffIds } as const),
					}),
		});
		const finished = finishCustomTriggerBuild(state, build.id, { status: "ready", jobId: job.id });
		writeCustomTriggerBuildState(statePath, finished.state);
		writeFileSync(
			join(inboxMessagesPath(operationRoot), `msg-trigger-build-ready-${Date.now()}.md`),
			`# Trigger created\n\n**${job.title}** will run when ${input.eventLabel.trim()}.\n`,
			"utf-8",
		);
		childTriggerWorkers.delete(child);
		return { message: "Custom trigger was validated and installed." };
	}

	if (kind === "finish_trigger_check") {
		if (!background || triggerWorker?.kind !== "check") throw new Error("no custom-trigger check is assigned");
		const input = recordValue(value);
		if (!input || (input.status !== "no_match" && input.status !== "matched" && input.status !== "failed")) {
			throw new Error("custom-trigger check result is invalid");
		}
		const statePath = routineTriggerStatePath(app.getPath("userData"), companyRoot);
		let state = readRoutineTriggerState(statePath);
		if (input.status === "failed") {
			if (typeof input.error !== "string" || !input.error.trim() || input.error.length > 2_000) {
				throw new Error("custom-trigger check failure needs a concrete bounded error");
			}
			state = recordCustomRoutineCheck(state, triggerWorker.jobId, triggerWorker.triggerId, {
				success: false,
				error: input.error.trim(),
			});
			const failures = state.customChecks?.[`${triggerWorker.jobId}:${triggerWorker.triggerId}`]?.failureStreak ?? 0;
			if (failures >= WAKE_FAILURE_SUSPENSION_THRESHOLD) {
				suspendScheduledJob(
					operationRoot,
					triggerWorker.jobId,
					`${failures} consecutive custom-trigger check failures`,
				);
				writeFileSync(
					join(inboxMessagesPath(operationRoot), `msg-trigger-check-suspended-${Date.now()}.md`),
					`# Trigger suspended\n\nA custom trigger was suspended after ${failures} failed checks.\n\n${input.error.trim()}\n`,
					"utf-8",
				);
			}
		} else {
			const checkpoint = input.checkpoint;
			if (checkpoint !== undefined && (typeof checkpoint !== "string" || checkpoint.length > 4_096)) {
				throw new Error("custom-trigger checkpoint is invalid");
			}
			if (input.status === "matched") {
				if (
					typeof input.eventId !== "string" ||
					!input.eventId.trim() ||
					input.eventId.length > 200 ||
					typeof input.summary !== "string" ||
					!input.summary.trim() ||
					input.summary.length > 300
				) {
					throw new Error("matched custom-trigger check needs a stable event id and summary");
				}
				state = recordCustomRoutineCheck(state, triggerWorker.jobId, triggerWorker.triggerId, {
					success: true,
					...(checkpoint !== undefined ? { checkpoint } : {}),
				});
				state = queueCustomRoutineTrigger(locallyPlacedScheduledJobs(operationRoot), state, {
					id: input.eventId.trim(),
					source: triggerWorker.adapterId,
					type: triggerWorker.event,
					occurredAt: new Date().toISOString(),
					summary: input.summary.trim(),
					payload: {},
				});
			} else {
				state = recordCustomRoutineCheck(state, triggerWorker.jobId, triggerWorker.triggerId, {
					success: true,
					...(checkpoint !== undefined ? { checkpoint } : {}),
				});
			}
		}
		writeRoutineTriggerState(statePath, state);
		childTriggerWorkers.delete(child);
		return { message: "Custom-trigger check result was persisted." };
	}

	if (kind === "request_connection") {
		const input = parsedStaffConnectionRequestToolInput(value);
		if (!input) throw new Error("connection proposal is invalid");
		const linkedArtifact = input.artifactId
			? readCompanyArtifacts(operationRoot).find(
					(artifact) =>
						artifact.id === input.artifactId &&
						artifact.stewardAgentId === staffAgentId &&
						artifact.dataNeeds.some((need) => need.id === input.dataNeedId),
				)
			: undefined;
		if (input.artifactId && !linkedArtifact) {
			throw new Error("linked artifact data need is not owned by this agent");
		}
		const requestInput: CreateConnectionRequestInput = {
			staffAgentId,
			sessionFile: binding.file,
			...input,
		};
		if (
			input.recipeId?.startsWith("company:") &&
			!companyConnectorForRequest(operationRoot, {
				staffAgentId,
				displayName: input.displayName,
				destinations: input.destinations,
				secretNames: input.secretNames,
				recipeId: input.recipeId,
			})
		) {
			throw new Error("company connector request does not match an installed manifest");
		}
		const userData = app.getPath("userData");
		const preparedRequest = input.recipeId?.startsWith("company:")
			? [...readConnectionRequests(userData, companyRoot)]
					.reverse()
					.find(
						(request) =>
							request.staffAgentId === staffAgentId &&
							request.sessionFile === binding.file &&
							request.status === "pending" &&
							request.phase === "preparing" &&
							request.recipeId === undefined &&
							request.artifactId === input.artifactId &&
							request.dataNeedId === input.dataNeedId,
					)
			: undefined;
		const retry =
			!preparedRequest && input.recipeId?.startsWith("company:")
				? retryFailedConnectionRequest(userData, companyRoot, requestInput)
				: undefined;
		const request = preparedRequest
			? installPreparedConnectionRequestRecipe(
					userData,
					companyRoot,
					{
						id: preparedRequest.id,
						staffAgentId: preparedRequest.staffAgentId,
						sessionFile: preparedRequest.sessionFile,
					},
					requestInput,
				)
			: (retry?.request ?? createConnectionRequest(userData, companyRoot, requestInput));
		if (linkedArtifact && input.dataNeedId && !preparedRequest && !retry) {
			const artifact = transitionCompanyArtifactConnection(
				operationRoot,
				staffAgentId,
				linkedArtifact.id,
				input.dataNeedId,
				request.id,
				"suggested",
			);
			commitCompanyMaterialization(operationRoot, [artifact.relativePath]);
		}
		for (const superseded of retry?.superseded ?? []) publishConnectionRequest(slot, binding, superseded);
		publishConnectionRequest(slot, binding, request);
		if (retry) {
			if (linkedArtifact && input.dataNeedId) {
				const artifact = transitionCompanyArtifactConnection(
					operationRoot,
					staffAgentId,
					linkedArtifact.id,
					input.dataNeedId,
					request.id,
					"selected",
				);
				commitCompanyMaterialization(operationRoot, [artifact.relativePath]);
			}
			const connector = companyConnectorForRequest(operationRoot, request);
			if (!connector) throw new Error("retried company connector no longer matches its installed manifest");
			const signInError = companyConnectorSignInError(companyRoot, connector);
			if (signInError) throw new Error(signInError);
			if (companyConnectorNeedsRegistration(companyRoot, connector)) {
				publishComputerHandoff(slot, companyRoot, child, staffAgentId, binding);
				return {
					message:
						"The previous founder selection was reused. Continue the installed connector setup without another source choice.",
				};
			}
			const identity: ConnectionRequestIdentity = {
				id: request.id,
				staffAgentId: request.staffAgentId,
				sessionFile: request.sessionFile,
			};
			const connecting = beginConnectionRequest(userData, companyRoot, identity);
			publishConnectionRequest(slot, binding, connecting);
			const result = await connectCompanyConnector(slot.window.webContents, connector);
			if (!result.ok || ("pendingSetup" in result && result.pendingSetup)) {
				const failure = safeConnectionFailure(result.error);
				const settled = result.cancelled
					? cancelConnectionRequest(userData, companyRoot, identity)
					: failConnectionRequest(userData, companyRoot, identity, failure);
				publishConnectionRequest(slot, binding, settled);
				transitionLinkedArtifactRequest(operationRoot, request, "failed");
				throw new Error(result.cancelled ? "Connector authorization was cancelled" : failure);
			}
			const verifying = verifyConnectionRequest(userData, companyRoot, identity);
			publishConnectionRequest(slot, binding, verifying);
			const connected = completeConnectionRequest(userData, companyRoot, identity, `company:${connector.id}`);
			publishConnectionRequest(slot, binding, connected);
			const syncing = beginConnectionRequestSync(userData, companyRoot, identity);
			publishConnectionRequest(slot, binding, syncing);
			transitionLinkedArtifactRequest(operationRoot, request, "connected");
			return {
				message:
					"The previously selected connector was authorized. Run its smallest read operation to verify data before marking it ready.",
			};
		}
		publishComputerHandoff(slot, companyRoot, child, staffAgentId, binding);
		return {
			message:
				"Source choice is ready for the founder. No provider access was requested and no service was connected.",
		};
	}

	if (kind === "manage_routine") {
		if (!attached) throw new Error("recurring work can only be changed from the attended agent conversation");
		const operation = parsedStaffRoutineOperation(value);
		if (!operation) throw new Error("routine operation is invalid");
		if (operation.action === "upsert_event") {
			const statePath = customTriggerBuildStatePath(app.getPath("userData"), companyRoot);
			const queued = queueCustomTriggerBuild(readCustomTriggerBuildState(statePath), {
				staffAgentId,
				routineKey: operation.routineKey,
				title: operation.title,
				instructions: operation.instructions,
				eventDescription: operation.eventDescription,
				sourceHints: operation.sourceHints,
				checkEveryMinutes: operation.checkEveryMinutes,
				effort: operation.effort ?? "high",
				...(operation.reviewerStaffIds !== undefined ? { reviewerStaffIds: operation.reviewerStaffIds } : {}),
			});
			writeCustomTriggerBuildState(statePath, queued.state);
			return {
				message:
					"The event trigger definition was saved. A silent builder will validate the data path and install it, or return a concrete error.",
			};
		}
		const result = applyStaffRoutineOperation(operationRoot, staffAgentId, operation, runtime.wakeJobId);
		if (result.action === "remove") {
			const path = wakeRunStatePath(app.getPath("userData"), companyRoot);
			writeWakeRunState(path, removeScheduledJobRunState(readWakeRunState(path), result.removedJobId));
		}
		runtime.childOptions.staffContext = staffSystemContext(operationRoot, staff);
		runtime.pendingStaffContextRestart = true;
		return {
			message:
				result.action === "remove"
					? "Recurring work was removed."
					: result.action === "pause"
						? "Recurring work was paused."
						: result.action === "resume"
							? "Recurring work was resumed."
							: "Recurring work was saved and is ready to run in fresh sessions.",
		};
	}

	if (kind === "assess_artifact_source") {
		const input = parsedStaffArtifactSourceAssessment(value);
		if (!input) throw new Error("artifact source assessment is invalid");
		const artifact = assessCompanyArtifactSource(
			operationRoot,
			staffAgentId,
			input.artifactId,
			input.update,
			background ? "worker" : "agent",
		);
		commitCompanyMaterialization(operationRoot, [artifact.relativePath]);
		if (attached) {
			runtime.childOptions.staffContext = staffSystemContext(operationRoot, staff);
			runtime.pendingStaffContextRestart = true;
		}
		return { message: "Source validity was recorded for the specified datatype and measures." };
	}

	if (kind === "record_artifact_observation") {
		const input = parsedStaffArtifactObservation(value);
		if (!input) throw new Error("artifact observation is invalid");
		const artifact = recordCompanyArtifactObservation(operationRoot, staffAgentId, input.artifactId, input.update);
		commitCompanyMaterialization(operationRoot, [artifact.relativePath]);
		if (attached) {
			runtime.childOptions.staffContext = staffSystemContext(operationRoot, staff);
			runtime.pendingStaffContextRestart = true;
		}
		return { message: "Artifact evidence was recorded from the verified source." };
	}

	if (kind === "report_artifact_source_issue") {
		const input = parsedStaffArtifactSourceIssue(value);
		if (!input) throw new Error("artifact source issue is invalid");
		const artifact = reportCompanyArtifactSourceIssue(operationRoot, staffAgentId, input.artifactId, input.update);
		commitCompanyMaterialization(operationRoot, [artifact.relativePath]);
		if (attached) {
			runtime.childOptions.staffContext = staffSystemContext(operationRoot, staff);
			runtime.pendingStaffContextRestart = true;
		}
		return { message: "Artifact source health was updated without discarding its last valid evidence." };
	}

	if (kind === "send_agent_message") {
		const input = recordValue(value);
		if (
			!input ||
			typeof input.toAgentId !== "string" ||
			typeof input.message !== "string" ||
			(input.subject !== undefined && typeof input.subject !== "string") ||
			Object.keys(input).some((key) => key !== "toAgentId" && key !== "subject" && key !== "message")
		) {
			throw new Error("coworker message is invalid");
		}
		if (input.toAgentId === staffAgentId) throw new Error("a coworker message cannot target its own sender");
		const recipient = activeStaffAgent(operationRoot, input.toAgentId);
		if (!recipient) throw new Error("the addressed coworker is unavailable or archived");
		const message = queueStaffAgentMessage(operationRoot, {
			fromAgentId: staffAgentId,
			toAgentId: recipient.id,
			...(input.subject?.trim() ? { subject: input.subject.trim() } : {}),
			body: input.message.trim(),
		});
		commitCompanyMaterialization(operationRoot, [join(".qorpera", "agent-messages.json")]);
		return {
			message: `Message ${message.id} was queued for ${recipient.displayName}. They will read it in their own next session and may reply the same way; do not wait for a live response.`,
		};
	}

	if (kind === "complete_setup") {
		if (!attached) throw new Error("setup can only finish from the attended agent conversation");
		const input = recordValue(value);
		if (!input || Object.keys(input).length !== 0) throw new Error("complete_setup takes no arguments");
		const activated = activateStaffAgent(operationRoot, staffAgentId);
		commitCompanyMaterialization(operationRoot, [join(".qorpera", "staff.json")]);
		runtime.childOptions.staffContext = staffSystemContext(operationRoot, activated);
		runtime.pendingStaffContextRestart = true;
		return { message: "Continue normally without announcing this internal transition." };
	}

	if (kind === "delegate_to_staff") {
		const roomId = binding.authority.roomId;
		if (!background || !roomId) {
			throw new Error("delegation is only available inside a group-chat room turn");
		}
		const input = recordValue(value);
		if (
			!input ||
			typeof input.staffAgentId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.staffAgentId) ||
			typeof input.message !== "string" ||
			input.message !== input.message.trim() ||
			!input.message ||
			input.message.includes("\0") ||
			Buffer.byteLength(input.message, "utf-8") > 4_000 ||
			Object.keys(input).some((key) => key !== "staffAgentId" && key !== "message")
		) {
			throw new Error("delegation requires a room participant and bounded message");
		}
		if (staff.templateId !== "agent-manager") throw new Error("only the Agent Manager can delegate room work");
		const room = readCompanyRoom(operationRoot, roomId);
		if (!room || room.status !== "active") throw new Error("this group chat is no longer active");
		if (!room.participantIds.includes(staffAgentId)) {
			throw new Error("the delegating manager is no longer a participant in this room");
		}
		if (!room.participantIds.includes(input.staffAgentId)) {
			throw new Error("delegation target is not a participant in this room");
		}
		const target = activeStaffAgent(operationRoot, input.staffAgentId);
		if (!target) throw new Error("delegation target is unavailable or archived");
		const context = childRoomDelegationContexts.get(child) ?? rootRoomDelegationContext(staffAgentId);
		const planned = planRoomDelegation(context, staffAgentId, input.staffAgentId);
		const message = appendCompanyRoomMessage(operationRoot, room.id, {
			speaker: { kind: "staff", staffAgentId },
			text: input.message,
			targetStaffAgentIds: [target.id],
			sourceTrailFile: binding.file,
		});
		try {
			queueCompanyRoomDelivery(operationRoot, room.id, {
				messageId: message.id,
				targetStaffAgentIds: [target.id],
				delegation: {
					depth: planned.target.depth,
					ancestorStaffAgentIds: [...planned.target.ancestorStaffAgentIds],
				},
			});
		} catch (error) {
			// The delegation message is already durable in the transcript; a retry
			// would append a duplicate assignment, so report instead of rethrowing.
			commitCompanyMaterialization(operationRoot, roomMaterializationPaths(room.id));
			sendRoomEvent(slot, { kind: "message", roomId: room.id, message });
			const detail = error instanceof Error ? error.message : String(error);
			return {
				message: `The delegation was posted to the room, but delivery to ${target.displayName} could not be queued: ${detail}. Do not repeat the delegation; report the problem in your own reply so the founder can resend it.`,
			};
		}
		childRoomDelegationContexts.set(child, planned.source);
		commitCompanyMaterialization(operationRoot, roomMaterializationPaths(room.id));
		sendRoomEvent(slot, { kind: "message", roomId: room.id, message });
		sendRoomEvent(slot, {
			kind: "delegation",
			roomId: room.id,
			fromStaffAgentId: staffAgentId,
			toStaffAgentId: target.id,
		});
		return {
			message: `Delegation queued for ${target.displayName} in this room. They respond in their own session; continue your own contribution without impersonating them or claiming their work is done.`,
		};
	}

	throw new Error(`company operation ${kind} is unavailable in this agent run`);
}

function publishConnectionRequest(slot: Slot, binding: TrailBinding, request: ConnectionRequest): void {
	try {
		appendKernelConnectionObservation(binding, { version: 1, request });
	} catch (error) {
		console.error(`connection reconstruction record failed: ${(error as Error).message}`);
	}
	send(slot.window, "connection-requests-changed", projectConnectionRequest(request));
}

function publishComputerHandoff(
	slot: Slot,
	root: string,
	child: ChildProcessWithoutNullStreams,
	staffAgentId: string,
	binding: TrailBinding,
): void {
	if (!childComputerBrokers.get(child)?.handoffReady()) return;
	const request = [...readConnectionRequests(app.getPath("userData"), root)]
		.reverse()
		.find(
			(candidate) =>
				candidate.staffAgentId === staffAgentId &&
				candidate.sessionFile === binding.file &&
				candidate.status === "pending" &&
				candidate.phase === "preparing" &&
				candidate.recipeId?.startsWith("company:") &&
				companyConnectorForRequest(root, candidate) !== undefined,
		);
	if (!request) return;
	try {
		const waiting = beginConnectionRequestSetup(app.getPath("userData"), root, {
			id: request.id,
			staffAgentId: request.staffAgentId,
			sessionFile: request.sessionFile,
		});
		publishConnectionRequest(slot, binding, waiting);
	} catch (error) {
		console.error(`computer handoff could not update connection request: ${(error as Error).message}`);
	}
}

function finishSyncedConnectionRequests(slot: Slot, root: string, staffAgentId: string, binding: TrailBinding): void {
	const artifacts = readCompanyArtifacts(root);
	for (const request of readConnectionRequests(app.getPath("userData"), root)) {
		if (request.staffAgentId !== staffAgentId || request.phase !== "syncing") continue;
		const artifact = request.artifactId
			? artifacts.find(
					(candidate) =>
						candidate.id === request.artifactId &&
						candidate.stewardAgentId === staffAgentId &&
						candidate.dataNeeds.some((need) => need.id === request.dataNeedId && need.status === "available"),
				)
			: undefined;
		if (request.artifactId && !artifact) continue;
		const ready = completeConnectionRequestSync(app.getPath("userData"), root, {
			id: request.id,
			staffAgentId: request.staffAgentId,
			sessionFile: request.sessionFile,
		});
		publishConnectionRequest(slot, binding, ready);
	}
}

async function continueCompanyConnectorRegistration(
	slot: Slot,
	root: string,
	child: ChildProcessWithoutNullStreams,
	staffAgentId: string,
	binding: TrailBinding,
	secretName: string,
	secretValue: string,
): Promise<void> {
	const runtime = slot.runtime;
	if (
		!runtime ||
		!isCurrentRuntimeChild(slot, runtime, child) ||
		runtime.root !== root ||
		runtime.childOptions.staffAgentId !== staffAgentId
	) {
		throw new Error("the active company or agent changed during connector setup");
	}
	const userData = app.getPath("userData");
	const request = [...readConnectionRequests(userData, root)]
		.reverse()
		.find(
			(candidate) =>
				candidate.staffAgentId === staffAgentId &&
				candidate.sessionFile === binding.file &&
				candidate.status === "connecting" &&
				candidate.phase === "awaiting_setup" &&
				candidate.recipeId?.startsWith("company:"),
		);
	const connector = request ? companyConnectorForRequest(root, request) : undefined;
	if (
		!request ||
		!connector ||
		connector.authentication.kind !== "oauth2" ||
		connector.authentication.clientSecretName !== secretName
	) {
		throw new Error("the secret is not declared by the active connector setup");
	}
	const clientId = connector.authentication.clientId.trim();
	if (
		!clientId ||
		/^(?:pending(?:[_ -].*)?|placeholder(?:[_ -].*)?|replace(?:[_ -]?me)?|todo(?:[_ -].*)?|your[_ -]?client[_ -]?id|<[^>]+>)$/i.test(
			clientId,
		)
	) {
		throw new Error(
			"the connector manifest clientId is still a placeholder; read the generated public client ID, update manifest.json, then call store_secret in a later tool step",
		);
	}
	bindCompanySecret(root, secretName, { kind: "static", value: secretValue });
	const identity: ConnectionRequestIdentity = {
		id: request.id,
		staffAgentId: request.staffAgentId,
		sessionFile: request.sessionFile,
	};
	const authorizing = resumeConnectionRequestAuthorization(userData, root, identity);
	publishConnectionRequest(slot, binding, authorizing);
	const result = await connectCompanyConnector(slot.window.webContents, connector);
	if (!result.ok || ("pendingSetup" in result && result.pendingSetup)) {
		const failure = safeConnectionFailure(result.error);
		const settled = result.cancelled
			? cancelConnectionRequest(userData, root, identity)
			: failConnectionRequest(userData, root, identity, failure);
		publishConnectionRequest(slot, binding, settled);
		transitionLinkedArtifactRequest(root, request, "failed");
		throw new Error(result.cancelled ? "Connector authorization was cancelled" : failure);
	}
	const verifying = verifyConnectionRequest(userData, root, identity);
	publishConnectionRequest(slot, binding, verifying);
	const connected = completeConnectionRequest(userData, root, identity, `company:${connector.id}`);
	publishConnectionRequest(slot, binding, connected);
	const syncing = beginConnectionRequestSync(userData, root, identity);
	publishConnectionRequest(slot, binding, syncing);
	transitionLinkedArtifactRequest(root, request, "connected");
}

function rendererConnectionRequestIdentity(
	runtime: CompanyRuntime,
	value: unknown,
): { identity: ConnectionRequestIdentity; binding: TrailBinding } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	const binding = attendedSessionBinding(runtime);
	if (
		Object.keys(candidate).some((key) => !["id", "staffAgentId", "sessionFile"].includes(key)) ||
		typeof candidate.id !== "string" ||
		typeof candidate.staffAgentId !== "string" ||
		typeof candidate.sessionFile !== "string" ||
		runtime.childOptions.staffAgentId !== candidate.staffAgentId ||
		!binding ||
		!activeStaffAgent(runtime.root, candidate.staffAgentId)
	) {
		return undefined;
	}
	return {
		identity: {
			id: candidate.id,
			staffAgentId: candidate.staffAgentId,
			sessionFile: candidate.sessionFile,
		},
		binding,
	};
}

function isGitHubNativeConnectionRequest(request: ConnectionRequest): boolean {
	const expectedDestinations = new Set<string>(GITHUB_CONNECTION_DESTINATIONS.map(([host]) => host));
	return (
		request.recipeId === "github" &&
		request.secretNames.length === 1 &&
		request.secretNames[0] === "github" &&
		request.destinations.length === expectedDestinations.size &&
		request.destinations.every((destination) => expectedDestinations.has(destination.host))
	);
}

function transitionLinkedArtifactRequest(
	root: string,
	request: ConnectionRequest,
	transition: "connected" | "failed" | "declined",
): void {
	if (!request.artifactId || !request.dataNeedId) return;
	try {
		const artifact = transitionCompanyArtifactConnection(
			root,
			request.staffAgentId,
			request.artifactId,
			request.dataNeedId,
			request.id,
			transition,
		);
		commitCompanyMaterialization(root, [artifact.relativePath]);
	} catch (error) {
		console.error(`artifact connection transition failed: ${(error as Error).message}`);
	}
}

async function resumeStaffAfterConnection(
	slot: Slot,
	runtime: CompanyRuntime,
	request: ConnectionRequest,
): Promise<void> {
	const child = runtime.child;
	if (
		!child ||
		slot.runtime !== runtime ||
		runtime.closing ||
		runtime.childOptions.staffAgentId !== request.staffAgentId ||
		!(await waitForChildReadiness(child))
	) {
		return;
	}
	const deadline = Date.now() + 20_000;
	while (childBusy.get(child) && Date.now() < deadline) {
		await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
		if (slot.runtime !== runtime || runtime.closing || runtime.child !== child) return;
	}
	if (runtime.wakeChild || childBusy.get(child) || runtime.child !== child) return;
	const artifact = request.artifactId
		? readCompanyArtifacts(runtime.root).find((candidate) => candidate.id === request.artifactId)
		: undefined;
	const target =
		artifact && request.dataNeedId
			? `the ${request.dataNeedId} data need in ${artifact.relativePath}`
			: `the ${request.displayName} source the founder selected`;
	const connectorId =
		request.grantId === "github-native"
			? BUILT_IN_GITHUB_CONNECTOR_ID
			: request.grantId?.startsWith("company:")
				? request.grantId.slice("company:".length)
				: undefined;
	const connector = connectorId
		? readCompanyConnectorManifests(runtime.root).find((candidate) => candidate.id === connectorId)
		: undefined;
	const execution = connector
		? ` The executable connector is ${connector.id}; use run_connector with one of its declared operations [${connector.operations.map((operation) => operation.id).join(", ")}].`
		: "";
	const staff = activeStaffAgent(runtime.root, request.staffAgentId);
	if (staff) runtime.childOptions.staffContext = staffSystemContext(runtime.root, staff);
	sendLegacyLocalStaffDirective(
		child,
		`Connection ready: the founder connected ${request.displayName} for ${target}.${execution} Verify that the granted source actually supports the intended work before relying on it. Then update the artifact's sourceRefs, evidence, data-need status, metrics, and updatedAt from observed data, and tell the founder what is now usable or still missing.`,
		"kernel-connection-ready",
	);
}

function persistScheduledJobOutcome(
	runtime: CompanyRuntime,
	job: ScheduledJob,
	success: boolean,
	trailFile?: string,
): { suspend: boolean } {
	const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
	const outcome = recordWakeOutcome(readWakeRunState(statePath), job.id, success, Date.now(), trailFile);
	writeWakeRunState(statePath, outcome.state);
	if (outcome.suspend) {
		suspendScheduledJob(
			runtime.root,
			job.id,
			`${WAKE_FAILURE_SUSPENSION_THRESHOLD} consecutive scheduled-job failures`,
		);
		writeFileSync(
			join(inboxMessagesPath(runtime.root), `msg-scheduled-job-suspended-${Date.now()}.md`),
			`# Scheduled job suspended\n\n**${job.title}** ended unsuccessfully ${WAKE_FAILURE_SUSPENSION_THRESHOLD} consecutive times, so Qorpera suspended it rather than keep spending. Review its recent runs under Activity, then re-enable it from the scheduled-job details panel.\n`,
			"utf-8",
		);
	}
	return { suspend: outcome.suspend };
}

function failCustomTriggerBuildByHost(root: string, buildId: string, error: string): void {
	const path = customTriggerBuildStatePath(app.getPath("userData"), root);
	const state = readCustomTriggerBuildState(path);
	const build = state.builds.find((candidate) => candidate.id === buildId);
	if (!build || build.status !== "building") return;
	const finished = finishCustomTriggerBuild(state, buildId, { status: "failed", error });
	writeCustomTriggerBuildState(path, finished.state);
	writeFileSync(
		join(inboxMessagesPath(root), `msg-trigger-build-failed-${Date.now()}.md`),
		`# Trigger could not be created\n\n**${build.title}**\n\n${error}\n`,
		"utf-8",
	);
}

function recordCustomTriggerCheckFailure(
	root: string,
	worker: Extract<TriggerWorkerContext, { kind: "check" }>,
	error: string,
): void {
	const path = routineTriggerStatePath(app.getPath("userData"), root);
	const state = recordCustomRoutineCheck(readRoutineTriggerState(path), worker.jobId, worker.triggerId, {
		success: false,
		error,
	});
	writeRoutineTriggerState(path, state);
	const failures = state.customChecks?.[`${worker.jobId}:${worker.triggerId}`]?.failureStreak ?? 0;
	if (failures < WAKE_FAILURE_SUSPENSION_THRESHOLD) return;
	suspendScheduledJob(root, worker.jobId, `${failures} consecutive custom-trigger check failures`);
	writeFileSync(
		join(inboxMessagesPath(root), `msg-trigger-check-suspended-${Date.now()}.md`),
		`# Trigger suspended\n\nA custom trigger was suspended after ${failures} failed checks.\n\n${error}\n`,
		"utf-8",
	);
}

async function startCustomTriggerBuilderExclusive(slot: Slot, runtime: CompanyRuntime): Promise<boolean> {
	if (profileAttachment(runtime.root).profileType === "cloud") {
		console.error("custom trigger builders require a durable cloud execution lane");
		return false;
	}
	if (runtime.wakeChild || runtime.closing || isChildBusy(runtime.child)) return false;
	const statePath = customTriggerBuildStatePath(app.getPath("userData"), runtime.root);
	const claimed = claimNextCustomTriggerBuild(readCustomTriggerBuildState(statePath));
	if (!claimed.build) return false;
	writeCustomTriggerBuildState(statePath, claimed.state);
	const build = claimed.build;
	const staff = activeStaffAgent(runtime.root, build.staffAgentId);
	if (!staff) {
		failCustomTriggerBuildByHost(runtime.root, build.id, "The owning agent is unavailable or archived.");
		return false;
	}
	const attendedChild = runtime.child;
	const resumeOptions: ChildOptions = {
		...runtime.childOptions,
		sessionFile: attendedChild
			? (childBindings.get(attendedChild)?.file ?? runtime.childOptions.sessionFile)
			: runtime.childOptions.sessionFile,
	};
	if (attendedChild) await stopChild(attendedChild);
	if (slot.runtime !== runtime || runtime.closing) return false;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startLegacyPiSessionAttachment(slot, runtime.root, {
			autonomousName: `custom-trigger builder — ${build.title}`,
			group: `infrastructure:trigger-build:${build.id}`,
			parentSession: resumeOptions.sessionFile,
			staffAgentId: staff.id,
			staffContext: staffSystemContext(runtime.root, staff),
			silent: true,
			model: resumeOptions.model,
			thinkingLevel: "high",
			toolNames: TRIGGER_BUILDER_TOOL_NAMES,
			onRpcEvent: (frame) => {
				if (frame.type === "agent_settled") {
					intentionalKills.add(child);
					killChildTree(child);
				}
			},
		});
	} catch (error) {
		failCustomTriggerBuildByHost(
			runtime.root,
			build.id,
			`The hidden trigger builder could not start: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (attendedChild)
			await restoreAttendedChild(slot, runtime, resumeOptions, "trigger-builder chat restore failed");
		return false;
	}
	runtime.wakeChild = child;
	runtime.infrastructureWork = "trigger-build";
	childTriggerWorkers.set(child, { kind: "build", buildId: build.id });
	child.on("close", () => {
		void enqueueRuntimeTransition(runtime, async () => {
			await childCheckpointCompletion.get(child);
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild !== child) return;
			const unfinished = childTriggerWorkers.get(child);
			if (unfinished?.kind === "build") {
				failCustomTriggerBuildByHost(
					runtime.root,
					unfinished.buildId,
					"The hidden trigger builder ended without installing a valid monitor.",
				);
				childTriggerWorkers.delete(child);
			}
			runtime.wakeChild = undefined;
			runtime.infrastructureWork = undefined;
			if (attendedChild)
				await restoreAttendedChild(slot, runtime, resumeOptions, "post-trigger-builder chat restore failed");
			scheduleInfrastructureWork(slot, runtime);
		}).catch((error) => console.error(`trigger-builder ownership transition failed: ${(error as Error).message}`));
	});
	if (!(await waitForChildReadiness(child))) {
		await stopChild(child);
		return false;
	}
	const connectors = readCompanyConnectorManifests(runtime.root).map((connector) => ({
		id: connector.id,
		displayName: connector.displayName,
		operations: connector.operations.map((operation) => ({ id: operation.id, access: operation.access })),
	}));
	const prompt = [
		"You are a hidden custom-trigger builder. Your work is infrastructure, not a conversation, and no intermediate output is shown to the founder.",
		`Build id: ${build.id}`,
		`Owning agent: ${staff.displayName} (${staff.id})`,
		`Routine: ${build.title}`,
		`Event requested in plain English: ${build.eventDescription}`,
		`Likely sources: ${build.sourceHints.length ? build.sourceHints.join(", ") : "infer from company files and installed connectors"}`,
		`Installed connectors: ${JSON.stringify(connectors)}`,
		"Inspect the company files and installed connector implementations. You may create the smallest credential-free connector or helper files needed when the company already contains enough information, but do not invent provider contracts, request credentials, or broaden authority.",
		"A ready result must give precise read-only monitor instructions that another fresh agent can execute repeatedly, name every connector id it relies on, and state a short human event label. If there is no executable source, report the exact blocker.",
		`Call finish_trigger_build exactly once with buildId ${build.id}. Do not finish with ordinary prose.`,
	].join("\n");
	if (!sendLegacyLocalPrompt(child, { type: "prompt", message: prompt }, false, "host-trigger-builder")) {
		await stopChild(child);
		return false;
	}
	return true;
}

async function startCustomTriggerCheckExclusive(slot: Slot, runtime: CompanyRuntime): Promise<boolean> {
	if (profileAttachment(runtime.root).profileType === "cloud") {
		console.error("custom trigger checks require a durable cloud execution lane");
		return false;
	}
	if (runtime.wakeChild || runtime.closing || isChildBusy(runtime.child)) return false;
	const statePath = routineTriggerStatePath(app.getPath("userData"), runtime.root);
	const due = dueCustomRoutineCheck(locallyPlacedScheduledJobs(runtime.root), readRoutineTriggerState(statePath));
	if (!due) return false;
	const staff = due.job.staffAgentId ? activeStaffAgent(runtime.root, due.job.staffAgentId) : undefined;
	if (!staff) {
		suspendScheduledJob(runtime.root, due.job.id, "custom trigger owner is unavailable or archived");
		return false;
	}
	const attendedChild = runtime.child;
	const resumeOptions: ChildOptions = {
		...runtime.childOptions,
		sessionFile: attendedChild
			? (childBindings.get(attendedChild)?.file ?? runtime.childOptions.sessionFile)
			: runtime.childOptions.sessionFile,
	};
	if (attendedChild) await stopChild(attendedChild);
	if (slot.runtime !== runtime || runtime.closing) return false;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startLegacyPiSessionAttachment(slot, runtime.root, {
			autonomousName: `custom-trigger check — ${due.job.title}`,
			group: `infrastructure:trigger-check:${due.job.id}:${due.trigger.id}`,
			parentSession: resumeOptions.sessionFile,
			staffAgentId: staff.id,
			staffContext: staffSystemContext(runtime.root, staff),
			silent: true,
			model: resumeOptions.model,
			thinkingLevel: "high",
			toolNames: TRIGGER_CHECK_TOOL_NAMES,
			onRpcEvent: (frame) => {
				if (frame.type === "agent_settled") {
					intentionalKills.add(child);
					killChildTree(child);
				}
			},
		});
	} catch (error) {
		recordCustomTriggerCheckFailure(
			runtime.root,
			{
				kind: "check",
				jobId: due.job.id,
				triggerId: due.trigger.id,
				adapterId: due.trigger.adapterId,
				event: due.trigger.event,
			},
			`The hidden trigger checker could not start: ${error instanceof Error ? error.message : String(error)}`,
		);
		if (attendedChild) await restoreAttendedChild(slot, runtime, resumeOptions, "trigger-check chat restore failed");
		return false;
	}
	const worker: Extract<TriggerWorkerContext, { kind: "check" }> = {
		kind: "check",
		jobId: due.job.id,
		triggerId: due.trigger.id,
		adapterId: due.trigger.adapterId,
		event: due.trigger.event,
	};
	runtime.wakeChild = child;
	runtime.wakeJobId = due.job.id;
	runtime.infrastructureWork = "trigger-check";
	childTriggerWorkers.set(child, worker);
	child.on("close", () => {
		void enqueueRuntimeTransition(runtime, async () => {
			await childCheckpointCompletion.get(child);
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild !== child) return;
			const unfinished = childTriggerWorkers.get(child);
			if (unfinished?.kind === "check") {
				recordCustomTriggerCheckFailure(
					runtime.root,
					unfinished,
					"The hidden trigger checker ended without recording a result.",
				);
				childTriggerWorkers.delete(child);
			}
			runtime.wakeChild = undefined;
			runtime.wakeJobId = undefined;
			runtime.infrastructureWork = undefined;
			if (attendedChild)
				await restoreAttendedChild(slot, runtime, resumeOptions, "post-trigger-check chat restore failed");
			scheduleInfrastructureWork(slot, runtime);
		}).catch((error) => console.error(`trigger-check ownership transition failed: ${(error as Error).message}`));
	});
	if (!(await waitForChildReadiness(child))) {
		await stopChild(child);
		return false;
	}
	const prompt = [
		"You are a hidden custom-trigger checker. No intermediate output is shown to the founder.",
		`Routine: ${due.job.title}`,
		`Trigger: ${due.trigger.label}`,
		`Last successful or failed check: ${due.lastCheckedAt ?? "never"}`,
		`Previous monitor checkpoint: ${due.checkpoint ?? "none"}`,
		`Monitor instructions: ${due.trigger.monitor.instructions}`,
		`Allowed connector ids: ${due.trigger.monitor.connectorIds.join(", ") || "company files only"}`,
		"Read only the required company files or connector operations. Determine whether one new event since the previous check satisfies the instructions. Do not perform the routine itself and do not mutate artifacts.",
		"Call finish_trigger_check exactly once: no_match when nothing new qualifies; matched with the source's stable event id and a short factual summary; failed with a concrete blocker. On no_match or matched, include a compact checkpoint string when the next check needs cursor or comparison state; it replaces the previous checkpoint. Do not finish with ordinary prose.",
	].join("\n");
	if (!sendLegacyLocalPrompt(child, { type: "prompt", message: prompt }, false, "host-trigger-check")) {
		await stopChild(child);
		return false;
	}
	return true;
}

function scheduleInfrastructureWork(slot: Slot, expectedRuntime: CompanyRuntime): void {
	setTimeout(() => {
		const runtime = slot.runtime;
		if (runtime !== expectedRuntime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) return;
		void enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) return;
			if (await startCustomTriggerBuilderExclusive(slot, runtime)) return;
			await startCustomTriggerCheckExclusive(slot, runtime);
		}).catch((error) => console.error(`trigger infrastructure failed: ${(error as Error).message}`));
	}, 0).unref();
}

/**
 * Run a wake as its OWN autonomous session, serialized against everything
 * else (Build 4): the chat child is stopped first and resumed after — one
 * environment writer at a time — and wakes are single-flight (never while
 * a merge or another wake runs). The wake's causal identity is stamped
 * into its trail session; its outcome feeds the failure streak, and at
 * the threshold the host suspends the schedule and posts a founder-visible
 * inbox item — escalation that does not depend on the assigned agent.
 */
async function startWakeChildExclusive(
	slot: Slot,
	runtime: CompanyRuntime,
	cause: "schedule" | "founder_response" | "inbound_event" | "agent_message",
	coalesced: number,
	job?: ScheduledJob,
	manual = false,
	trigger?: PendingRoutineTrigger,
	messageRecipient?: StaffAgent,
	occurrenceKey?: string,
): Promise<boolean> {
	if (runtime.wakeChild || runtime.closing) return false;
	// Never preempt a founder turn in flight: the wake defers to the next tick.
	if (isChildBusy(runtime.child)) return false;
	if (job) {
		const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
		const previous = scheduledJobRunState(readWakeRunState(statePath), job.id);
		if (scheduledJobRunInterrupted(previous)) {
			const outcome = persistScheduledJobOutcome(runtime, job, false, previous.activeTrailFile);
			if (outcome.suspend) return false;
		}
	}
	const assignedStaff = job?.staffAgentId ? activeStaffAgent(runtime.root, job.staffAgentId) : undefined;
	if (job?.staffAgentId && !assignedStaff) {
		suspendScheduledJob(runtime.root, job.id, "assigned staff member is unavailable or archived");
		return false;
	}
	const attendedStaff = runtime.childOptions.staffAgentId
		? activeStaffAgent(runtime.root, runtime.childOptions.staffAgentId)
		: undefined;
	const wakeStaff = assignedStaff ?? messageRecipient ?? attendedStaff;
	if (!wakeStaff) return false;
	// Wake arbitration (SESSIONS.md): occurrences with a deterministic,
	// machine-independent identity are claimed rows — exactly one machine with
	// write access executes; a loser consumes the occurrence locally without
	// running. Manual runs are founder intent on THIS machine and identity-less
	// events are machine-local, so both run unarbitrated. A cloud occurrence
	// with a deterministic key never falls back to an unclaimed local run.
	const wakeKey =
		manual && job
			? `manual:${job.id}:${occurrenceKey ?? randomUUID()}`
			: cause === "schedule" && job
				? (() => {
						const occurrence = scheduledWakeOccurrenceKey(job, Date.now());
						return occurrence ? `job:${job.id}:${occurrence}` : undefined;
					})()
				: cause === "inbound_event" && job && trigger
					? `trigger:${job.id}:${trigger.event.id}`
					: cause === "agent_message" && messageRecipient
						? (() => {
								try {
									const queued = readStaffAgentMessages(runtime.root).find(
										(message) => message.status === "queued" && message.toAgentId === messageRecipient.id,
									);
									return queued ? `mail:${queued.id}` : undefined;
								} catch {
									return undefined;
								}
							})()
						: occurrenceKey
							? `${cause}:${occurrenceKey}`
							: undefined;
	const cloudCompany = profileAttachment(runtime.root).profileType === "cloud";
	if (cloudCompany && !wakeKey) {
		console.error(`cloud ${cause} wake has no durable occurrence identity`);
		return false;
	}
	if (cloudCompany) {
		console.error(`cloud ${cause} wake is waiting for the runner orchestrator`);
		return false;
	}
	const wakeId = randomUUID();
	const attendedChild = runtime.child;
	const resumeOptions = {
		...runtime.childOptions,
		sessionFile: attendedChild
			? (childBindings.get(attendedChild)?.file ?? runtime.childOptions.sessionFile)
			: runtime.childOptions.sessionFile,
	};
	if (attendedChild) await stopChild(attendedChild);
	if (slot.runtime !== runtime || runtime.closing) return false;
	let started = false;
	let settledCleanly = false;
	let failed = false;
	let promptSent = false;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startLegacyPiSessionAttachment(slot, runtime.root, {
			autonomousName:
				cause === "schedule" && job
					? `wake — scheduled-job:${job.id} — ${job.title}`
					: cause === "inbound_event"
						? "wake — inbound event"
						: cause === "founder_response"
							? "wake — founder response"
							: cause === "agent_message"
								? "wake — coworker message"
								: "wake — schedule",
			group: job ? `job:${job.id}` : `wake:${cause}`,
			staffAgentId: wakeStaff.id,
			staffContext: staffSystemContext(runtime.root, wakeStaff),
			...(job?.publication.mode === "review"
				? {
						reviewPolicy: {
							policyKey: `routine:${job.id}`,
							title: `Review ${job.title}`,
							reviewerStaffIds: job.publication.reviewerStaffIds,
						},
					}
				: {}),
			silent: true,
			model: wakeStaff.model ?? resumeOptions.model,
			thinkingLevel: job?.effort ?? "high",
			wake: {
				id: wakeId,
				cause,
				intervalMinutes: job ? scheduledJobIntervalMinutes(job) : undefined,
				coalesced,
			},
			onRpcEvent: (frame) => {
				if (frame.type === "agent_start") started = true;
				if (wakeFrameFailed(frame)) failed = true;
				if (frame.type === "agent_settled") {
					settledCleanly = started && !failed;
					intentionalKills.add(child);
					killChildTree(child);
				}
			},
		});
	} catch (error) {
		console.error(`wake child failed to start: ${(error as Error).message}`);
		if (attendedChild && slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, resumeOptions, "wake-start chat restore failed");
		}
		return false;
	}
	runtime.wakeChild = child;
	runtime.wakeJobId = job?.id;
	const trailFile = childBindings.get(child)?.file;
	child.on("close", () => {
		void (async () => {
			await childCheckpointCompletion.get(child);
			await enqueueRuntimeTransition(runtime, async () => {
				if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild !== child) return;
				try {
					if (job && promptSent) {
						persistScheduledJobOutcome(runtime, job, settledCleanly, trailFile);
					}
				} catch (error) {
					console.error(`wake bookkeeping failed: ${(error as Error).message}`);
				}
				runtime.wakeChild = undefined;
				runtime.wakeJobId = undefined;
				if (attendedChild)
					await restoreAttendedChild(slot, runtime, resumeOptions, "post-wake chat restore failed");
			});
		})().catch((error) => console.error(`wake ownership transition failed: ${(error as Error).message}`));
	});
	if (!(await waitForChildReadiness(child))) {
		console.error(`staff-owned scheduled job runtime did not become ready: ${job?.title ?? wakeStaff.displayName}`);
		await stopChild(child);
		return false;
	}
	if (
		!sendLegacyLocalPrompt(
			child,
			{ type: "prompt", message: wakePrompt(cause, coalesced, job, trigger) },
			false,
			`host-wake-${cause}`,
		)
	) {
		await stopChild(child);
		return false;
	}
	promptSent = true;
	// The wake context was built fresh in this same transition, so any queued
	// coworker mail it displays is now delivered.
	deliverQueuedStaffMessages(runtime.root, wakeStaff.id);
	if (job) {
		const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
		writeWakeRunState(statePath, recordWakeStart(readWakeRunState(statePath), job.id, Date.now(), trailFile));
		if (manual) console.log(`scheduled job run started manually: ${job.title}`);
	}
	return true;
}

function startWakeChild(
	slot: Slot,
	runtime: CompanyRuntime,
	cause: "schedule" | "founder_response" | "inbound_event" | "agent_message",
	coalesced: number,
	job?: ScheduledJob,
	manual = false,
	trigger?: PendingRoutineTrigger,
	messageRecipient?: StaffAgent,
	occurrenceKey?: string,
): Promise<boolean> {
	return enqueueRuntimeTransition(runtime, () =>
		startWakeChildExclusive(slot, runtime, cause, coalesced, job, manual, trigger, messageRecipient, occurrenceKey),
	);
}

async function dispatchRoutineTrigger(
	slot: Slot,
	runtime: CompanyRuntime,
	jobs: readonly ScheduledJob[],
): Promise<boolean> {
	if (runtime.routineTriggerPolling) return false;
	runtime.routineTriggerPolling = true;
	try {
		const path = routineTriggerStatePath(app.getPath("userData"), runtime.root);
		let triggerState = readRoutineTriggerState(path);
		triggerState = await pollGitHubRoutineTriggers({ jobs, state: triggerState });
		writeRoutineTriggerState(path, triggerState);
		const pending = triggerState.pending.find((candidate) => jobs.some((job) => job.id === candidate.jobId));
		if (!pending) return false;
		const job = jobs.find((candidate) => candidate.id === pending.jobId);
		if (!job) return false;
		persistRoutineTriggerEvent(runtime.root, pending);
		const started = await startWakeChild(slot, runtime, "inbound_event", 0, job, false, pending);
		if (started) {
			writeRoutineTriggerState(path, completePendingRoutineTrigger(triggerState, pending.id));
		}
		return started;
	} catch (error) {
		console.error(`routine trigger poll failed for ${runtime.root}: ${(error as Error).message}`);
		return false;
	} finally {
		runtime.routineTriggerPolling = false;
	}
}

/**
 * The routine clock: once a minute, fire due scheduled work for
 * open companies. Wakes fire only while their company environment is open
 * in the shell; time spent closed is covered by the coalescing missed-wake
 * policy on the next open.
 */
function startWakeTicker(): void {
	setInterval(() => {
		for (const slot of slots.values()) {
			const runtime = slot.runtime;
			if (!runtime || runtime.closing || runtime.wakeChild) continue;
			if (isChildBusy(runtime.child)) continue;
			const customBuilds = readCustomTriggerBuildState(
				customTriggerBuildStatePath(app.getPath("userData"), runtime.root),
			);
			// Cloud-placed routines are fail-closed: this local host never runs
			// them, and they stay parked until a hosted execution lane exists.
			const customJobs = locallyPlacedScheduledJobs(runtime.root);
			if (
				customBuilds.builds.some((build) => build.status === "queued") ||
				dueCustomRoutineCheck(
					customJobs,
					readRoutineTriggerState(routineTriggerStatePath(app.getPath("userData"), runtime.root)),
				)
			) {
				scheduleInfrastructureWork(slot, runtime);
				continue;
			}
			// Inbound events that arrived mid-turn come first: their files are
			// already durable, they just never got their wake.
			if (runtime.pendingInboundWakeKeys?.size) {
				const pendingKeys = [...runtime.pendingInboundWakeKeys].sort();
				const occurrenceKey = createHash("sha256").update(pendingKeys.join("\n")).digest("hex");
				runtime.pendingInboundWakeKeys = undefined;
				void startWakeChild(
					slot,
					runtime,
					"inbound_event",
					0,
					undefined,
					false,
					undefined,
					undefined,
					occurrenceKey,
				)
					.then((started) => {
						if (!started && slot.runtime === runtime && !runtime.closing)
							runtime.pendingInboundWakeKeys = new Set(pendingKeys);
					})
					.catch((error) => {
						console.error(`inbound wake failed for ${runtime.root}: ${(error as Error).message}`);
						if (slot.runtime === runtime && !runtime.closing)
							runtime.pendingInboundWakeKeys = new Set(pendingKeys);
					});
				continue;
			}
			// Queued room deliveries wake one participant at a time. The durable
			// delivery registry is the queue itself, so a room conversation
			// survives restarts, retries with backoff, and runs when free.
			const roomDue = dueRoomDelivery(slot, runtime.root);
			if (roomDue) {
				void startRoomChild(slot, runtime, roomDue).catch((error) => {
					console.error(`room delivery wake failed for ${runtime.root}: ${(error as Error).message}`);
				});
				continue;
			}
			// Durable coworker mail wakes its recipient. The protected ledger is
			// the queue itself, so delivery survives restarts and closed companies;
			// mail addressed to archived staff simply waits.
			const messageRecipient = (() => {
				try {
					for (const message of readStaffAgentMessages(runtime.root)) {
						if (message.status !== "queued") continue;
						const recipient = activeStaffAgent(runtime.root, message.toAgentId);
						if (recipient) return recipient;
					}
				} catch (error) {
					console.error(`coworker message scan failed for ${runtime.root}: ${(error as Error).message}`);
				}
				return undefined;
			})();
			if (messageRecipient) {
				void startWakeChild(slot, runtime, "agent_message", 0, undefined, false, undefined, messageRecipient).catch(
					(error) => {
						console.error(`coworker message wake failed for ${runtime.root}: ${(error as Error).message}`);
					},
				);
				continue;
			}
			try {
				const jobs = locallyPlacedScheduledJobs(runtime.root);
				void dispatchRoutineTrigger(slot, runtime, jobs).then((started) => {
					if (started || slot.runtime !== runtime || runtime.closing || runtime.wakeChild) return;
					const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
					const state = readWakeRunState(statePath);
					const due = jobs
						.map((job) => ({
							job,
							decision: decideScheduledWake(job, scheduledJobRunState(state, job.id), Date.now()),
						}))
						.find((candidate) => candidate.decision.due);
					if (!due) return;
					void startWakeChild(slot, runtime, "schedule", due.decision.coalesced, due.job).catch((error) => {
						console.error(`scheduled wake failed for ${runtime.root}: ${(error as Error).message}`);
					});
				});
			} catch (error) {
				console.error(`wake tick failed for ${runtime.root}: ${(error as Error).message}`);
			}
		}
	}, 60_000).unref();
}

/**
 * Durable multi-staff rooms ride the single autonomous lane. A queued room
 * delivery wakes one participant at a time: the recipient's per-room trail
 * is resumed, the shared hash-chained transcript is rebuilt into the prompt,
 * and the reply is persisted back into the room before the next participant
 * runs. Concurrent participant processes stay out on purpose — the company
 * keeps its one-agent-process contract and single-writer git checkpointing;
 * the durable delivery queue is what makes the room feel concurrent.
 */
function roomMaterializationPaths(roomId: string): string[] {
	return [
		join(".qorpera", "rooms.json"),
		join(".qorpera", "room-deliveries.json"),
		join(".qorpera", "rooms", `${roomId}.jsonl`),
	];
}

function roomDisplayTitle(root: string, room: CompanyRoom): string {
	if (room.title) return room.title;
	const names = room.participantIds.flatMap((id) => {
		const staff = activeStaffAgent(root, id);
		return staff ? [staff.displayName] : [];
	});
	return names.join(", ") || "Group chat";
}

function roomSpeakerName(root: string, message: CompanyRoomMessage): string {
	if (message.speaker.kind === "founder") return "Founder";
	return activeStaffAgent(root, message.speaker.staffAgentId)?.displayName ?? "Former staff member";
}

function roomTranscriptContext(root: string, messages: readonly CompanyRoomMessage[]): string {
	const selected: string[] = [];
	let bytes = 0;
	for (const message of [...messages].reverse()) {
		const targets = message.targetStaffAgentIds?.length ? ` -> ${message.targetStaffAgentIds.join(", ")}` : "";
		const line = `${roomSpeakerName(root, message)}${targets}: ${message.text.slice(0, 6_000)}${message.images?.length ? ` [${message.images.length} image attachment${message.images.length === 1 ? "" : "s"}]` : ""}`;
		const lineBytes = Buffer.byteLength(line, "utf-8");
		if (selected.length >= 48 || bytes + lineBytes > 40 * 1024) break;
		selected.unshift(line);
		bytes += lineBytes;
	}
	return selected.join("\n\n");
}

function roomParticipantContext(root: string, room: CompanyRoom): string {
	return room.participantIds
		.flatMap((id) => {
			const staff = activeStaffAgent(root, id);
			return staff ? [`${staff.displayName} (${staff.id}) — ${staff.role}`] : [];
		})
		.join("\n");
}

function roomPrompt(root: string, room: CompanyRoom, recipient: StaffAgent, instruction: string): string {
	const transcript = roomTranscriptContext(root, readCompanyRoomMessages(root, room.id));
	return [
		`Qorpera group chat: ${roomDisplayTitle(root, room)}`,
		`You are responding as ${recipient.displayName}. Never impersonate or speak on behalf of another participant.`,
		"Participants (use the exact UUID only with delegate_to_staff):",
		roomParticipantContext(root, room),
		"A founder message is delivered to every listed target unless an @mention narrowed it. Participants respond one at a time in their own sessions; respond with your own contribution and settle without waiting on anyone else's turn.",
		recipient.templateId === "agent-manager"
			? `You may use delegate_to_staff for bounded assignments to other participants in this room. The host permits at most ${MAX_ROOM_DELEGATION_DEPTH} delegation hops, rejects cycles and repeated targets within one turn, and limits each manager turn to ${MAX_ROOM_DELEGATION_FANOUT} delegated participants.`
			: "Only the Agent Manager can delegate work to another room participant. Respond with your own contribution.",
		transcript ? `Recent durable room transcript:\n${transcript}` : "Recent durable room transcript: empty",
		`Current instruction:\n${instruction}`,
	].join("\n\n");
}

function roomDeliveryInstruction(root: string, message: CompanyRoomMessage, depth: number): string {
	const attachments = message.images?.length
		? `\n[${message.images.length} image attachment${message.images.length === 1 ? "" : "s"} shown in the founder's room view]`
		: "";
	if (message.speaker.kind === "staff") {
		const source = roomSpeakerName(root, message);
		return `${source} delegated this bounded assignment to you (hop ${depth} of ${MAX_ROOM_DELEGATION_DEPTH}):\n${message.text}${attachments}`;
	}
	return `The founder posted to this room:\n${message.text}${attachments}`;
}

function assistantRoomReply(frame: Record<string, unknown>): { key: string; text: string } | undefined {
	if (frame.type !== "message_end") return undefined;
	const message = recordValue(frame.message);
	if (
		!message ||
		message.role !== "assistant" ||
		(message.stopReason !== "stop" && message.stopReason !== "length") ||
		!Array.isArray(message.content)
	) {
		return undefined;
	}
	const text = message.content
		.flatMap((part) => {
			const content = recordValue(part);
			return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
		})
		.join("")
		.trim();
	if (!text) return undefined;
	const identity =
		typeof message.responseId === "string"
			? message.responseId
			: `${typeof message.timestamp === "number" ? message.timestamp : "unknown"}:${createHash("sha256").update(text).digest("hex")}`;
	return { key: identity, text };
}

interface DueRoomDelivery {
	room: CompanyRoom;
	delivery: QueuedCompanyRoomDelivery;
	target: StaffAgent;
	message: CompanyRoomMessage;
}

/** Routines this local host may execute or monitor. Cloud placement is
 * fail-closed at every point work can start — ticker, event triggers,
 * webhook dispatch, custom-trigger checks, and manual runs — not just the
 * cron decision. */
function locallyPlacedScheduledJobs(root: string): ScheduledJob[] {
	return readScheduledJobs(root).filter((job) => job.placement !== "cloud");
}

function dueRoomDelivery(slot: Slot, root: string): DueRoomDelivery | undefined {
	try {
		const now = Date.now();
		const deliveries = readQueuedCompanyRoomDeliveries(root);
		if (!deliveries.length) return undefined;
		const rooms = new Map(readCompanyRooms(root).map((room) => [room.id, room]));
		for (const delivery of deliveries) {
			if (Date.parse(delivery.nextAttemptAt) > now) continue;
			const room = rooms.get(delivery.roomId);
			if (!room || room.status !== "active") continue;
			// Membership and employment can change while a delivery waits. A
			// target that left the room or was archived can never be served, so
			// it is pruned here rather than parking the delivery forever.
			const servableIds = delivery.targetStaffAgentIds.filter(
				(id) => room.participantIds.includes(id) && activeStaffAgent(root, id) !== undefined,
			);
			if (servableIds.length !== delivery.targetStaffAgentIds.length) {
				const pruned = rescheduleCompanyRoomDelivery(root, delivery.id, servableIds, undefined, {
					preserveAttempts: true,
				});
				if (!pruned) {
					sendRoomEvent(slot, { kind: "delivered", roomId: room.id, deliveryId: delivery.id });
					continue;
				}
				sendRoomEvent(slot, { kind: "delivery", roomId: room.id, delivery: pruned });
			}
			const target = servableIds
				.map((id) => activeStaffAgent(root, id))
				.find((staff): staff is StaffAgent => staff !== undefined);
			if (!target) continue;
			const message = readCompanyRoomMessage(root, room.id, delivery.messageId);
			if (!message) {
				// The transcript no longer carries this message; drop the delivery.
				rescheduleCompanyRoomDelivery(root, delivery.id, []);
				sendRoomEvent(slot, { kind: "delivered", roomId: room.id, deliveryId: delivery.id });
				continue;
			}
			return { room, delivery, target, message };
		}
	} catch (error) {
		console.error(`room delivery scan failed for ${root}: ${(error as Error).message}`);
	}
	return undefined;
}

function latestRoomTrailFile(runtime: CompanyRuntime, roomId: string, staffAgentId: string): string | undefined {
	return runtime.sessions
		.snapshot()
		.sessions.filter((session) => session.roomId === roomId && session.staffAgentId === staffAgentId)
		.sort(
			(left, right) =>
				(right.attachmentSequence ?? 0) - (left.attachmentSequence ?? 0) ||
				right.updatedAt.localeCompare(left.updatedAt),
		)[0]?.trailFile;
}

function sendRoomEvent(slot: Slot, payload: Record<string, unknown>): void {
	send(slot.window, "room-event", payload);
}

async function startRoomChildExclusive(slot: Slot, runtime: CompanyRuntime, due: DueRoomDelivery): Promise<boolean> {
	if (runtime.wakeChild || runtime.closing) return false;
	// Never preempt a founder turn in flight: the delivery waits its turn.
	if (isChildBusy(runtime.child)) return false;
	const { room, delivery, target, message } = due;
	const attendedChild = runtime.child;
	const resumeOptions = {
		...runtime.childOptions,
		sessionFile: attendedChild
			? (childBindings.get(attendedChild)?.file ?? runtime.childOptions.sessionFile)
			: runtime.childOptions.sessionFile,
	};
	if (attendedChild) await stopChild(attendedChild);
	if (slot.runtime !== runtime || runtime.closing) return false;
	// The scan ran outside the transition queue and the stop awaited above, so
	// the room may have been archived, edited, or drained in the meantime.
	const liveRoom = readCompanyRoom(runtime.root, room.id);
	if (
		!liveRoom ||
		liveRoom.status !== "active" ||
		!liveRoom.participantIds.includes(target.id) ||
		!readQueuedCompanyRoomDeliveries(runtime.root, room.id).some((candidate) => candidate.id === delivery.id)
	) {
		if (attendedChild && slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, resumeOptions, "room-revalidation chat restore failed");
		}
		return false;
	}
	// Depth and ancestry ride the durable delivery record, so the bounded
	// delegation graph survives restarts; only within-turn fanout accounting
	// is per-child memory.
	const delegationContext: RoomDelegationContext = delivery.delegation
		? {
				depth: delivery.delegation.depth,
				ancestorStaffAgentIds: new Set(delivery.delegation.ancestorStaffAgentIds),
				delegatedStaffAgentIds: new Set(),
			}
		: rootRoomDelegationContext(target.id);
	// Build the prompt before wiring closures so the founder message (which may
	// carry image attachments) is not retained for the life of the child.
	const prompt = roomPrompt(
		runtime.root,
		liveRoom,
		target,
		roomDeliveryInstruction(runtime.root, message, delegationContext.depth),
	);
	const seenReplyKeys = new Set<string>();
	let started = false;
	let failed = false;
	let replyPersisted = false;
	let replyPersistFailed = false;
	let settledCleanly = false;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startLegacyPiSessionAttachment(slot, runtime.root, {
			sessionFile: latestRoomTrailFile(runtime, room.id, target.id),
			autonomousName: `room — ${roomDisplayTitle(runtime.root, room)} — ${target.displayName}`,
			group: `room:${room.id}`,
			staffAgentId: target.id,
			roomId: room.id,
			staffContext: staffSystemContext(runtime.root, target),
			silent: true,
			model: target.model ?? resumeOptions.model,
			toolNames: target.templateId === "agent-manager" ? `${STAFF_TOOL_NAMES},delegate_to_staff` : STAFF_TOOL_NAMES,
			onRpcEvent: (frame) => {
				if (frame.type === "agent_start") {
					started = true;
					sendRoomEvent(slot, { kind: "activity", roomId: room.id, staffAgentId: target.id, activity: "working" });
				} else if (frame.type === "tool_execution_start") {
					sendRoomEvent(slot, {
						kind: "activity",
						roomId: room.id,
						staffAgentId: target.id,
						activity: typeof frame.toolName === "string" ? frame.toolName : "tool",
					});
				}
				if (wakeFrameFailed(frame)) failed = true;
				const reply = assistantRoomReply(frame);
				if (reply && !seenReplyKeys.has(reply.key)) {
					seenReplyKeys.add(reply.key);
					try {
						const persisted = appendCompanyRoomMessage(runtime.root, room.id, {
							speaker: { kind: "staff", staffAgentId: target.id },
							text: reply.text,
							sourceTrailFile: childBindings.get(child)?.file,
						});
						replyPersisted = true;
						sendRoomEvent(slot, { kind: "message", roomId: room.id, message: persisted });
					} catch (error) {
						replyPersistFailed = true;
						console.error(`room reply persistence failed: ${(error as Error).message}`);
						sendRoomEvent(slot, {
							kind: "error",
							roomId: room.id,
							staffAgentId: target.id,
							message: `${target.displayName}'s response could not be saved to this room.`,
						});
					}
				}
				if (frame.type === "agent_settled") {
					// Any durably persisted reply means the room was served — a retry
					// would re-run the turn and duplicate it. Only a turn with NO
					// persisted reply retries, whether frames failed or a persist did.
					settledCleanly = started && (replyPersisted || (!failed && !replyPersistFailed));
					sendRoomEvent(slot, { kind: "activity", roomId: room.id, staffAgentId: target.id, activity: "idle" });
					intentionalKills.add(child);
					killChildTree(child);
				}
			},
		});
	} catch (error) {
		console.error(`room participant runtime failed to start: ${(error as Error).message}`);
		if (attendedChild && slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, resumeOptions, "room-start chat restore failed");
		}
		return false;
	}
	runtime.wakeChild = child;
	runtime.roomDelivery = { roomId: room.id, staffAgentId: target.id };
	childRoomDelegationContexts.set(child, delegationContext);
	child.on("close", () => {
		void enqueueRuntimeTransition(runtime, async () => {
			await childCheckpointCompletion.get(child);
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild !== child) return;
			runtime.wakeChild = undefined;
			runtime.roomDelivery = undefined;
			try {
				if (settledCleanly) {
					const remaining = delivery.targetStaffAgentIds.filter((id) => id !== target.id);
					const rescheduled = rescheduleCompanyRoomDelivery(runtime.root, delivery.id, remaining);
					if (!rescheduled) {
						sendRoomEvent(slot, { kind: "delivered", roomId: room.id, deliveryId: delivery.id });
					}
				} else {
					const rescheduled = rescheduleCompanyRoomDelivery(
						runtime.root,
						delivery.id,
						delivery.targetStaffAgentIds,
						`${target.displayName}'s room turn did not settle cleanly`,
					);
					if (rescheduled && rescheduled.attempts >= WAKE_FAILURE_SUSPENSION_THRESHOLD) {
						// Give up on the failing participant like the other autonomous
						// lanes do, so it cannot starve mail and routines forever — but
						// co-recipients who never got a turn keep theirs: they continue
						// on a fresh delivery with a clean attempt budget.
						rescheduleCompanyRoomDelivery(runtime.root, delivery.id, []);
						sendRoomEvent(slot, { kind: "delivered", roomId: room.id, deliveryId: delivery.id });
						// The first reschedule already filtered survivors to current
						// room members; the dispatch-time snapshot may be stale.
						const survivors = rescheduled.targetStaffAgentIds.filter((id) => id !== target.id);
						if (survivors.length) {
							try {
								const requeued = queueCompanyRoomDelivery(runtime.root, room.id, {
									messageId: delivery.messageId,
									targetStaffAgentIds: survivors,
									...(delivery.delegation ? { delegation: delivery.delegation } : {}),
								});
								sendRoomEvent(slot, { kind: "delivery", roomId: room.id, delivery: requeued });
							} catch (error) {
								console.error(`room delivery survivor requeue failed: ${(error as Error).message}`);
							}
						}
						writeFileSync(
							join(inboxMessagesPath(runtime.root), `msg-room-delivery-failed-${Date.now()}.md`),
							`# Group-chat delivery gave up\n\n**${roomDisplayTitle(runtime.root, room)}**\n\n${target.displayName}'s turn failed ${rescheduled.attempts} times in a row; delivery to them was retired${survivors.length ? " while the other recipients keep their queued delivery" : ""}. Open the group chat and resend when the underlying problem (model access, credentials, runtime) is resolved.\n`,
							"utf-8",
						);
						sendRoomEvent(slot, {
							kind: "error",
							roomId: room.id,
							staffAgentId: target.id,
							message: `Delivery to ${target.displayName} was retired after ${rescheduled.attempts} failed attempts.`,
						});
					} else if (rescheduled) {
						sendRoomEvent(slot, { kind: "delivery", roomId: room.id, delivery: rescheduled });
					} else {
						// The delivery vanished while the turn ran (archive or prune);
						// clear its card.
						sendRoomEvent(slot, { kind: "delivered", roomId: room.id, deliveryId: delivery.id });
					}
				}
				commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			} catch (error) {
				console.error(`room delivery bookkeeping failed: ${(error as Error).message}`);
				try {
					rescheduleCompanyRoomDelivery(runtime.root, delivery.id, []);
				} catch {
					// the delivery registry itself is unreadable; the scan will retry
				}
			}
			sendRoomEvent(slot, {
				kind: "activity",
				roomId: room.id,
				staffAgentId: target.id,
				activity: "offline",
			});
			if (attendedChild) await restoreAttendedChild(slot, runtime, resumeOptions, "post-room chat restore failed");
			scheduleRoomDeliveryPump(slot, runtime);
		}).catch((error) => console.error(`room ownership transition failed: ${(error as Error).message}`));
	});
	if (!(await waitForChildReadiness(child))) {
		console.error(`room participant runtime did not become ready: ${target.displayName}`);
		await stopChild(child);
		return false;
	}
	if (!sendLegacyLocalPrompt(child, { type: "prompt", message: prompt }, false, "host-room-delivery")) {
		await stopChild(child);
		return false;
	}
	return true;
}

function startRoomChild(slot: Slot, runtime: CompanyRuntime, due: DueRoomDelivery): Promise<boolean> {
	return enqueueRuntimeTransition(runtime, () => startRoomChildExclusive(slot, runtime, due));
}

/** Drain the next due room delivery soon, without waiting for the ticker. */
function scheduleRoomDeliveryPump(slot: Slot, runtime: CompanyRuntime): void {
	setTimeout(() => {
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild) return;
		if (isChildBusy(runtime.child)) return;
		const due = dueRoomDelivery(slot, runtime.root);
		if (!due) return;
		void startRoomChild(slot, runtime, due).catch((error) => {
			console.error(`room delivery failed for ${runtime.root}: ${(error as Error).message}`);
		});
	}, 500).unref();
}

async function restoreAttendedChild(
	slot: Slot,
	runtime: CompanyRuntime,
	options: ChildOptions,
	context: string,
): Promise<boolean> {
	if (options.staffAgentId && profileAttachment(runtime.root).profileType === "cloud") {
		// Cloud staff conversations restore as childless anchors — a wake or
		// room lane finishing must never resurrect a local agent process for
		// the attended thread.
		const staff = activeStaffAgent(runtime.root, options.staffAgentId);
		if (staff) {
			try {
				await attachStaffChild(slot, runtime, staff, options.sessionFile, false);
				return true;
			} catch (error) {
				console.error(`${context}: ${(error as Error).message}`);
			}
		}
		send(slot.window, "rpc-exit", null);
		return false;
	}
	for (const delay of [0, 250, 750, 2_000]) {
		if (delay) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
		if (slot.runtime !== runtime || runtime.closing) return false;
		try {
			runtime.childOptions = options;
			runtime.child = startLegacyPiSessionAttachment(slot, runtime.root, options);
			runtime.runtimeReconnectAttempts = 0;
			runtime.lastUnexpectedRuntimeExitAt = undefined;
			return true;
		} catch (error) {
			console.error(`${context}: ${(error as Error).message}`);
		}
	}
	send(slot.window, "rpc-exit", null);
	return false;
}

/** Each open company owns its backend server and token. Hashed ports can
 * collide, so walk forward until a bind succeeds: the renderer resolves
 * everything relative to backendUrl, and only a server we own honors the
 * token we minted. */
async function listenBackend(
	root: string,
	authToken: string,
	sessions: SessionControlPlane,
): Promise<{ port: number; close: () => void }> {
	const base = companyPort(root);
	for (let port = base; port < base + 10; port++) {
		const serverOptions: Parameters<typeof createCompanyAppServer>[0] & {
			sessionRuntime: SessionControlPlane;
		} = {
			root,
			port,
			authToken,
			fixedShell: { directory: FIXED_SHELL_DIR },
			sessionRuntime: sessions,
			staffReadModel: () => readStaffAgents(root),
			roomReadModel: () => readCompanyRooms(root),
			staffMessageReadModel: () => readStaffAgentMessages(root),
			artifactReadModel: () => readCompanyArtifacts(root),
			connectorReadModel: () => readCompanyConnectorManifests(root),
			artifactUpdateModel: (id, update) => {
				const artifact = updateCompanyArtifact(root, id, update);
				commitCompanyMaterialization(root, [artifact.relativePath]);
				return artifact;
			},
			connectionRequestReadModel: () => readRendererConnectionRequests(app.getPath("userData"), root),
			scheduledJobReadModel: () => readScheduledJobs(root),
		};
		const server = createCompanyAppServer(serverOptions);
		const listening = await new Promise<boolean>((resolvePromise) => {
			server.once("error", () => resolvePromise(false));
			server.listen(port, "127.0.0.1", () => resolvePromise(true));
		});
		if (listening) {
			return {
				port,
				close: () => {
					server.close();
					server.closeAllConnections();
				},
			};
		}
	}
	throw new Error(`no free backend port near ${base} for ${root}`);
}

function companyShellUrl(runtime: CompanyRuntime): string {
	return `http://127.0.0.1:${runtime.backendPort}/shell/index.html`;
}

function isTrustedProfileSwitcherSender(sender: WebContents): boolean {
	const slot = slotOf(sender);
	if (!slot) return false;
	if (!slot.runtime) return isTrustedHubSender(sender);
	try {
		const currentUrl = new URL(sender.getURL());
		const trustedUrl = new URL(companyShellUrl(slot.runtime));
		return currentUrl.origin === trustedUrl.origin && currentUrl.pathname === trustedUrl.pathname;
	} catch {
		return false;
	}
}

interface ActiveCompany {
	root: string;
	/** Typed profile identity. Local and cloud UUIDs never share a namespace. */
	id: string;
	companyIcon: CompanyIconId;
	profileType: ProfileAttachment["profileType"];
	profileId: string;
	product: ProductContext;
	environmentId?: string;
	access: ProfileAccess;
	backendUrl: string;
	kickoff: boolean;
	wakeRunning: boolean;
	/** Exact autonomous trail currently owned by the kernel, if any. */
	autonomousTrailFile?: string;
	scheduledJobs: Array<
		ScheduledJob & {
			lastRunAt?: string;
			lastFinishedAt?: string;
			lastOutcome?: "succeeded" | "failed";
			lastTrailFile?: string;
			nextRunAt?: string;
			failureStreak: number;
			running: boolean;
		}
	>;
	/** Trail file the live founder child is bound to (resumed or fresh), so
	 * the chrome can mark the session active and cache under the right key. */
	sessionFile?: string;
}

function activeCompanyInfo(slot: Slot): ActiveCompany | undefined {
	const runtime = slot.runtime;
	if (!runtime) return undefined;
	const access = activeProfileAccess(runtime.root);
	if (!access) return undefined;
	const attachment = profileAttachment(runtime.root);
	const autonomousChild =
		!runtime.infrastructureWork && !runtime.roomDelivery && runtime.wakeChild?.exitCode === null
			? runtime.wakeChild
			: undefined;
	const runState = readWakeRunState(wakeRunStatePath(app.getPath("userData"), runtime.root));
	const now = Date.now();
	const scheduledJobs = readScheduledJobs(runtime.root).map((job) => {
		const jobState = scheduledJobRunState(runState, job.id);
		const nextRunAt = nextScheduledWakeAt(job, jobState, now);
		return {
			...job,
			lastRunAt: jobState.lastWakeAt,
			lastFinishedAt: jobState.lastFinishedAt,
			lastOutcome: jobState.lastOutcome,
			lastTrailFile: jobState.lastTrailFile,
			nextRunAt,
			failureStreak: jobState.failureStreak,
			running: runtime.wakeJobId === job.id && Boolean(runtime.wakeChild && runtime.wakeChild.exitCode === null),
		};
	});
	return {
		root: runtime.root,
		id: runtime.storageId,
		companyIcon: currentQorperaAccountId
			? readCompanyIcon(app.getPath("userData"), currentQorperaAccountId, runtime.root)
			: DEFAULT_COMPANY_ICON_ID,
		profileType: attachment.profileType,
		profileId: attachment.profileId,
		product: productContext(),
		...(attachment.profileType === "cloud" ? { environmentId: attachment.environmentId } : {}),
		access,
		backendUrl: `http://127.0.0.1:${runtime.backendPort}`,
		kickoff: false,
		wakeRunning: Boolean(
			!runtime.infrastructureWork &&
				!runtime.roomDelivery &&
				runtime.wakeChild &&
				runtime.wakeChild.exitCode === null,
		),
		autonomousTrailFile: autonomousChild ? childBindings.get(autonomousChild)?.file : undefined,
		scheduledJobs,
		sessionFile: attendedSessionBinding(runtime)?.file,
	};
}

class CompanyOpenCancelledError extends Error {}

async function openCompany(slot: Slot, root: string): Promise<void> {
	try {
		root = canonicalCompanyRoot(root);
	} catch {
		console.error(`refusing to open unavailable company root: ${root}`);
		if (!slot.runtime) void slot.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
		return;
	}
	// Refuse non-companies outright: opening registers a root and starts its
	// local runtime, so an invalid path here would mint a fake company.
	if (!isCompanyRoot(root)) {
		console.error(`refusing to open non-company root: ${root}`);
		if (!slot.runtime) void slot.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
		return;
	}
	if (!IS_SMOKE) {
		try {
			if (!(await refreshProfileAccess(root))) {
				throw new Error("This profile is not shared with the signed-in Qorpera account.");
			}
		} catch (error) {
			console.error(
				`refusing to open inaccessible profile: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (!slot.runtime) void slot.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
			return;
		}
	}
	// A company never runs in two windows: two RPC children on one trail and
	// two tokens against one backend both end badly. Route to the live one.
	const existing = slotForCompany(root);
	if (existing && existing !== slot) {
		focusWindow(existing.window);
		return;
	}
	// Stable company identity: keys the durable renderer partition here and
	// the renderer's own storage keys (via appInfo). Ports and windows churn;
	// this hash does not.
	const storageId = companyRootId(root);
	const partition = rendererPartitionForCompany(storageId);
	const openingWindow = slot.window;
	const openGeneration = ++slot.openGeneration;
	const openingCancelled = (): boolean =>
		slot.openGeneration !== openGeneration || openingWindow.isDestroyed() || slot.window !== openingWindow;
	await closeCompany(slot);
	if (openingCancelled()) return;
	const runtimeLock = claimCompanyRuntimeLock(root);
	let pendingBackendClose: (() => void) | undefined;
	let pendingSessions: SessionControlPlane | undefined;
	let installedRuntime: CompanyRuntime | undefined;
	try {
		const openingAttachment = profileAttachment(root);
		if (openingAttachment.profileType === "cloud") {
			const openingProfile = hostedProfilesById.get(openingAttachment.profileId);
			if (openingProfile) alignManagedCloudCompanyName(root, openingProfile);
			const primary = qorperaAccountAuth?.hostedPrimary();
			const objects = qorperaAccountAuth?.hostedObjects();
			if (!primary || !objects) throw new Error("The cloud Company File is unavailable.");
			await recoverInterruptedCloudCompanyReviewAcceptance({
				userData: app.getPath("userData"),
				profileId: openingAttachment.profileId,
				companyRoot: root,
			});
			// The cache is never the authority. Pull/merge the canonical head
			// before host upgrades, staff synchronization, or any executor can
			// observe and mutate this company.
			await checkpointCloudCompanyFile({
				userData: app.getPath("userData"),
				companyRoot: root,
				profileId: openingAttachment.profileId,
				environmentId: openingAttachment.environmentId,
				primary,
				objects,
				runtimeLock,
				canWrite: activeProfileAccess(root)?.capabilities.write === true,
			});
			const recovered = await recoverOrphanedCloudCompanyExecutions({
				userData: app.getPath("userData"),
				profileId: openingAttachment.profileId,
				companyRoot: root,
				hostInstanceId: HOST_INSTANCE_ID,
				exclusiveHost: HAS_SINGLE_INSTANCE_LOCK,
			});
			if (recovered.reviewable > 0) {
				console.error(`${recovered.reviewable} interrupted Company File execution(s) recovered for review`);
			}
		}
		// The scaffold is how host upgrades reach existing companies: an
		// idempotent spine fill (never overwriting company content) so a
		// company conceived under an older host passes current validation.
		scaffoldCompany(root);
		validateCompanyHostStorage(root);
		const userData = app.getPath("userData");
		reconcileInterruptedStaffIntros(root);
		const checkpointDir = join(dirname(sandboxConfigDir(userData, root, "company-agent")), "checkpoints");
		reconcilePendingProductCheckpoints(checkpointDir, root);
		const hasLocalHostState = hasCompanyHostState(userData, root);
		if (!hasLocalHostState) materializeClonedProductStorage(root);
		readProductProtectionInventory(root);
		const productStorage = reconcileCompanyProductStorage(
			userData,
			root,
			readProductStorageExpectations(root),
			!hasLocalHostState,
		);
		if (productStorage.unhydrated.length > 0) {
			await dialog.showMessageBox(openingWindow, {
				type: "warning",
				buttons: ["Continue"],
				message: "This company clone has product storage that is not hydrated on this machine.",
				detail: productStorage.unhydrated.map((entry) => `${entry.kind}: ${entry.path}`).join("\n"),
			});
			if (openingCancelled()) throw new CompanyOpenCancelledError();
		}
		reconcilePendingCompanyCheckpoints(checkpointDir, root);
		snapshotFounderGitState(root);
		enforceCompanyHostSettings(root);
		registerCompany(root);
		const agentsOnlyMigration = migrateCompanyToAgentsOnly(root);
		if (agentsOnlyMigration.removed) {
			console.log(
				`removed obsolete company UI (${agentsOnlyMigration.removedRoots.join(", ")}; ${agentsOnlyMigration.filesRemoved} files, ${agentsOnlyMigration.versionsRemoved} saved versions): ${root}`,
			);
		}
		let recoveredGitHubConnectorPaths: readonly string[] = [];
		const connectedNativeGitHub = [...readConnectionRequests(userData, root)]
			.reverse()
			.find(
				(request) =>
					request.status === "connected" && request.grantId === "github-native" && request.recipeId === "github",
			);
		if (connectedNativeGitHub) {
			try {
				const installed = ensureBuiltInGitHubConnector(root, connectedNativeGitHub.staffAgentId);
				if (installed.created) recoveredGitHubConnectorPaths = installed.relativePaths;
			} catch (error) {
				console.error(`built-in GitHub connector recovery failed: ${(error as Error).message}`);
			}
		}
		commitCompanyMaterialization(root, [
			join(".qorpera", "settings.json"),
			"userland",
			"app",
			...recoveredGitHubConnectorPaths,
		]);

		// Backend for fixed navigation, agents, artifacts, routines, and inbox.
		// token guards mutating endpoints; only the renderer ever receives it.
		// Sweep contentless trails minted by older unnamed startup runtimes. Named
		// agent continuity is restored only when that agent is opened below.
		const migratedTrails = migrateLegacyCompanyAgentTrails(root);
		if (migratedTrails > 0) {
			console.log(`migrated ${migratedTrails} legacy company-agent trail${migratedTrails === 1 ? "" : "s"}`);
		}
		const swept = pruneEmptyTrailSessions(root);
		if (swept > 0) console.log(`pruned ${swept} contentless trail session${swept === 1 ? "" : "s"}`);
		// Reconstruct the company-owned session state before any new executor
		// attaches. The backend and every child share this one read model.
		const sessionCachePath = join(dirname(companyHostStatePath(app.getPath("userData"), root)), "sessions-v3.json");
		const cloudStaffSync = createCloudStaffSynchronizer(root);
		if (cloudStaffSync) {
			try {
				await cloudStaffSync.sync();
			} catch (error) {
				console.error(
					`initial cloud staff sync deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		const sessions = await SessionControlPlane.create(root, KERNEL_INSTANCE_ID, sessionCachePath);
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		pendingSessions = sessions;
		sessionControlPlanes.set(normalizedRoot(root), sessions);
		const cloudTrailSync = createCloudTrailSynchronizer(
			root,
			() => (installedRuntime ? liveTrailBindings(installedRuntime) : []),
			(binding) => {
				sessions.rememberAudit(binding);
				if (installedRuntime) scheduleStaffThreadRefresh(slot, installedRuntime, binding);
			},
			(advance) => {
				if (installedRuntime) recordAttachedTrailAdvance(installedRuntime, advance);
			},
		);
		if (cloudTrailSync) {
			try {
				await cloudTrailSync.sync();
			} catch (error) {
				console.error(
					`initial cloud trail sync deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		const backendToken = randomUUID();
		const backend = await listenBackend(root, backendToken, sessions);
		pendingBackendClose = backend.close;
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		// Opening a company starts the trusted host only. A model process is
		// attached later by staff:open, staff creation, or autonomous work; there
		// is no unnamed company-wide agent in the agents-only architecture.
		const childOptions: ChildOptions = {
			...runtimeLaunchOptions(app.getPath("userData"), root, undefined, undefined),
			thinkingLevel: STAFF_DEFAULT_THINKING_LEVEL,
		};
		const runtime: CompanyRuntime = {
			root,
			sessions,
			storageId,
			childOptions,
			backendPort: backend.port,
			backendClose: backend.close,
			backendToken,
			transitionQueue: Promise.resolve(),
			runtimeReconnectAttempts: 0,
			pendingInventoryRestart: false,
			pendingStaffContextRestart: false,
			resumedConnectionSetupIds: new Set(),
			cloudTrailSync,
			cloudStaffSync,
			closing: false,
			runtimeLock,
		};
		installedRuntime = runtime;
		slot.runtime = runtime;
		startCloudTrailSync(runtime);
		startCloudStaffSync(runtime);
		installCloudCompanySync(runtime);
		startCloudRealtimeSync(slot, runtime);
		void startCloudPresence(slot, runtime).catch((error: unknown) => {
			console.error(`cloud presence unavailable: ${error instanceof Error ? error.message : String(error)}`);
		});
		startCloudRunnerActivity(slot, runtime);
		startCloudSessionPump(slot, runtime);
		pendingBackendClose = undefined;
		pendingSessions = undefined;
		runtime.inventoryWatcher = watch(join(root, ".qorpera"), { persistent: false }, (_event, file) => {
			if (file?.toString() === "products.json") restartForProductInventory(slot, runtime);
		});
		// Inbound webhooks (optional kernel module): local-loopback listener,
		// events persisted to inbox/events/, a wake fired when the company is
		// idle — events arriving mid-turn wait as files, and the pending flag
		// makes the wake ticker owe them a wake once the turn settles.
		const webhookBinding = readWebhookBinding(root);
		if (webhookBinding?.enabled) {
			void startWebhookListener({
				root,
				token: webhookBinding.token,
				port: webhookBinding.port,
				onEvent: (file, triggerEvent) => {
					const live = slot.runtime;
					if (!live || live.closing) return;
					const occurrenceKey = basename(file);
					if (triggerEvent) {
						const path = routineTriggerStatePath(app.getPath("userData"), live.root);
						const previous = readRoutineTriggerState(path);
						const queued = queueCustomRoutineTrigger(
							locallyPlacedScheduledJobs(live.root),
							previous,
							triggerEvent,
						);
						if (queued.pending.length > previous.pending.length) {
							writeRoutineTriggerState(path, queued);
							if (!live.wakeChild && !isChildBusy(live.child))
								void dispatchRoutineTrigger(slot, live, locallyPlacedScheduledJobs(live.root));
							return;
						}
						// An event whose only matching routine is cloud-placed stays
						// parked for the hosted lane; it must not leak into the generic
						// local inbound wake either. The event file remains durable
						// under inbox/events for that lane to consume.
						const cloudMatched = queueCustomRoutineTrigger(
							readScheduledJobs(live.root).filter((job) => job.placement === "cloud"),
							previous,
							triggerEvent,
						);
						if (cloudMatched.pending.length > previous.pending.length) return;
					}
					if (live.wakeChild || isChildBusy(live.child)) {
						if (!live.pendingInboundWakeKeys) live.pendingInboundWakeKeys = new Set();
						live.pendingInboundWakeKeys.add(occurrenceKey);
						return;
					}
					void startWakeChild(
						slot,
						live,
						"inbound_event",
						0,
						undefined,
						false,
						undefined,
						undefined,
						occurrenceKey,
					).then((started) => {
						if (!started && slot.runtime === live && !live.closing) {
							if (!live.pendingInboundWakeKeys) live.pendingInboundWakeKeys = new Set();
							live.pendingInboundWakeKeys.add(occurrenceKey);
						}
					});
				},
			})
				.then((listener) => {
					// The company may have closed while the listener was binding:
					// closeCompany already ran, so nobody else will close this one —
					// and leaking it would hold the persisted port against reopen.
					if (slot.runtime !== runtime || runtime.closing) {
						listener.close();
						return;
					}
					runtime.webhookClose = listener.close;
					// Bindings enabled before ports were persisted get their
					// OS-assigned port recorded, so the endpoint stops moving.
					if (webhookBinding.port === undefined) {
						try {
							persistWebhookPort(root, listener.port);
						} catch (error) {
							console.error(`webhook port persistence failed: ${(error as Error).message}`);
						}
					}
					console.log(`webhook listener for ${root} at http://127.0.0.1:${listener.port}/hook/…`);
				})
				.catch((error) => console.error(`webhook listener failed to start: ${(error as Error).message}`));
		}
		slot.kickoffPending = false;

		// Every company uses the same trusted Base shell. Company-authored UI is
		// limited to sandboxed artifacts exposed inside that shell.
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		// A window that last showed the hub (throwaway partition) or another
		// company cannot host this company's durable partition — swap in a
		// replacement window, committed only once the chrome has loaded.
		const swap = slot.partition === partition ? undefined : beginRendererWindowSwap(slot, partition);
		const win = swap?.window ?? slot.window;
		try {
			setWindowIcon(win, companyWindowIcon(root));
			await win.loadURL(companyShellUrl(runtime));
			if (slot.openGeneration !== openGeneration || slot.runtime !== runtime) {
				swap?.abort();
				if (slot.runtime === runtime) await closeCompany(slot);
				return;
			}
			swap?.commit();
			scheduleInfrastructureWork(slot, runtime);
		} catch (loadError) {
			swap?.abort();
			throw loadError;
		}
	} catch (error) {
		if (installedRuntime) {
			if (slot.runtime === installedRuntime) await closeCompany(slot);
			else await installedRuntime.closePromise;
		} else {
			pendingBackendClose?.();
			if (pendingSessions && sessionControlPlanes.get(normalizedRoot(root)) === pendingSessions) {
				sessionControlPlanes.delete(normalizedRoot(root));
			}
			releaseCompanyRuntimeLock(runtimeLock);
		}
		if (error instanceof CompanyOpenCancelledError) return;
		throw error;
	}
}

async function showHub(slot: Slot): Promise<void> {
	await closeCompany(slot);
	setWindowIcon(slot.window, DEFAULT_ICON);
	await slot.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
}

/** Switch chat sessions. Product chats run a product-worker in one validated worktree. */
async function openChat(
	slot: Slot,
	sessionFile: string | null,
	departmentPath?: string,
	worktreePath?: string,
	sessionName?: string,
): Promise<{
	ok: boolean;
	sessionFile?: string;
	department?: string;
	worktree?: string;
	error?: string;
}> {
	if (!slot.runtime) return { ok: false };
	const runtime = slot.runtime;
	if (!departmentPath) {
		return { ok: false, error: "company conversations belong to named agents" };
	}
	let department: ProductDepartment | undefined;
	let worktree: string | undefined;
	let branch: string | undefined;
	if (typeof departmentPath === "string" && departmentPath.length > 0) {
		readProductProtectionInventory(runtime.root);
		department = listProductDepartments(runtime.root).find(
			(entry) => entry.path === departmentPath && entry.repositoryExists,
		);
		if (!department)
			return {
				ok: false,
				error: "product department or repository is unavailable",
			};
		let assignment: ProductWorktree;
		if (worktreePath) {
			const existingAssignment = readProductWorktreeAssignment(runtime.root, department, worktreePath);
			if (existingAssignment) {
				assignment = existingAssignment;
			} else {
				const recovery = planProductWorktreeRecovery(runtime.root, department, worktreePath, runtime.runtimeLock);
				if (!recovery)
					return {
						ok: false,
						error: "product worktree has no valid recovery source",
					};
				const approved = await confirmKernelReview(slot.window, {
					title: "Restore product worktree",
					summary: `Restore this assigned ${department.name} clone from its company-carried recovery record?`,
					exactText: resolve(runtime.root, recovery.path),
					metadata: [
						`Department: ${department.path}`,
						`Source repository: ${resolve(runtime.root, recovery.repositoryPath)}`,
						`Current clone origin: ${recovery.repositoryRemote}`,
						`Original source commit: ${recovery.sourceHead ?? "unborn repository"}`,
						`Recovery commit: ${recovery.recoveryHead ?? "unborn repository"}`,
						`Recovery bundles: ${recovery.recoveryBundles.length ? recovery.recoveryBundles.map((bundle) => bundle.path).join(", ") : "not required"}`,
						`Branch: ${recovery.assignment.branch}`,
					].join("\n"),
				});
				if (!approved) return { ok: false, error: "product worktree recovery cancelled" };
				const restored = recoverProductWorktree(runtime.root, department, runtime.runtimeLock, recovery);
				if (!restored) return { ok: false, error: "product worktree recovery failed" };
				reconcileCompanyProductStorage(
					app.getPath("userData"),
					runtime.root,
					readProductStorageExpectations(runtime.root),
					false,
				);
				assignment = restored;
			}
		} else {
			const plan = planProductWorktree(runtime.root, department, runtime.runtimeLock);
			if (!plan) return { ok: false, error: "could not plan product worktree" };
			const worktreesRoot = realpathSync(resolve(runtime.root, department.worktreesPath));
			const repository = realpathSync(resolve(runtime.root, department.repositoryPath));
			const plannedTarget = resolve(realpathSync(runtime.root), plan.path);
			if (
				!isInside(plannedTarget, worktreesRoot) ||
				normalizedRoot(dirname(plannedTarget)) !== normalizedRoot(worktreesRoot)
			) {
				return {
					ok: false,
					error: "planned product worktree escaped its assigned parent",
				};
			}
			const approved = await confirmKernelReview(slot.window, {
				title: "Create and authorize product worktree",
				summary: `Create this isolated clone and issue product-code write authority for ${department.name}?`,
				exactText: plannedTarget,
				metadata: [
					`Department: ${department.path}`,
					`Source repository: ${repository}`,
					`Clone origin: ${plan.sourceRemote}`,
					`Source commit: ${plan.sourceHead ?? "unborn repository"}`,
					`Branch: ${plan.branch}`,
				].join("\n"),
			});
			if (!approved) return { ok: false, error: "product worktree authorization cancelled" };
			const created = createProductWorktree(runtime.root, department, runtime.runtimeLock, plan);
			if (!created) return { ok: false, error: "could not create product worktree" };
			reconcileCompanyProductStorage(
				app.getPath("userData"),
				runtime.root,
				readProductStorageExpectations(runtime.root),
				false,
			);
			assignment = created;
		}
		worktree = assignment.path;
		branch = assignment.branch;
		const assignedWorktree = resolve(runtime.root, worktree);
		const expectedWorktree = resolve(realpathSync(runtime.root), worktree);
		const actualWorktree = realpathSync(assignedWorktree);
		const actualWorktreesRoot = realpathSync(resolve(runtime.root, department.worktreesPath));
		const actualRepository = realpathSync(resolve(runtime.root, department.repositoryPath));
		if (
			normalizedRoot(actualWorktree) !== normalizedRoot(expectedWorktree) ||
			!isInside(actualWorktree, actualWorktreesRoot)
		) {
			return {
				ok: false,
				error: "product worktree changed before authorization",
			};
		}
		if (worktreePath) {
			const approved = await confirmKernelReview(slot.window, {
				title: "Authorize product worker",
				summary: `Issue product-code write authority for ${department.name}?`,
				exactText: actualWorktree,
				metadata: [
					`Department: ${department.path}`,
					`Source repository: ${actualRepository}`,
					`Selected clone origin: ${assignment.sourceRemote}`,
					`Source commit: ${assignment.sourceHead ?? "unborn repository"}`,
					`Assignment created: ${assignment.createdAt}`,
					`Branch: ${branch}`,
				].join("\n"),
			});
			if (!approved) return { ok: false, error: "product worker authorization cancelled" };
		}
		if (!readProductWorktreeAssignment(runtime.root, department, worktree)) {
			return {
				ok: false,
				error: "product worktree changed after authorization",
			};
		}
	}
	const options: ChildOptions = {
		sessionFile: sessionFile ?? undefined,
		sessionName,
		department,
		worktree,
		model: runtime.childOptions.model,
		...(sessionFile ? {} : { thinkingLevel: STAFF_DEFAULT_THINKING_LEVEL }),
	};
	try {
		// Pre-pivot chats carry old-schema trail headers the bind refuses;
		// a founder explicitly opening one IS the sanctioned migration moment.
		if (options.sessionFile) {
			migrateLegacyTrailSession(runtime.root, options.sessionFile, {
				actor: "product-worker",
				attended: false,
				department: department?.path,
				worktree,
			});
		}
		await replaceRuntimeChild(slot, runtime, options);
	} catch (error) {
		console.error(`chat open failed: ${(error as Error).message}`);
		return { ok: false, error: (error as Error).message };
	}
	return {
		ok: true,
		sessionFile: attendedSessionBinding(runtime)?.file,
		department: department?.path,
		worktree,
	};
}

function activeStaffAgent(root: string, staffAgentId: string): StaffAgent | undefined {
	return readStaffAgents(root).find((agent) => agent.id === staffAgentId && agent.employmentStatus === "active");
}

/** The model a resumed session will actually continue on: the latest model
 * signal already recorded in its trail. Forcing agent.model over this on
 * every re-attach is what silently reverted composer model choices — and
 * with them the sponsorship transfer the choice was meant to perform. */
function trailModelSelection(root: string, sessionFile: string): RuntimeModelSelection | undefined {
	try {
		const path = isAbsolute(sessionFile) ? sessionFile : join(root, "trail", sessionFile);
		let model: RuntimeModelSelection | undefined;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
				model = { provider: entry.provider, modelId: entry.modelId };
			} else if (entry.type === "message") {
				const message = entry.message as Record<string, unknown> | undefined;
				if (
					message?.role === "assistant" &&
					typeof message.provider === "string" &&
					typeof message.model === "string"
				) {
					model = { provider: message.provider, modelId: message.model };
				}
			}
		}
		return model;
	} catch {
		return undefined;
	}
}

/** Persist a confirmed model as the employee's durable choice. Confirmation
 * frames repeat on every get_state, so unchanged selections write nothing. */
async function persistStaffAgentModel(root: string, staffAgentId: string, model: RuntimeModelSelection): Promise<void> {
	const current = readStaffAgents(root).find((agent) => agent.id === staffAgentId);
	if (!current || (current.model?.provider === model.provider && current.model?.modelId === model.modelId)) return;
	updateStaffAgent(root, staffAgentId, { model: { provider: model.provider, modelId: model.modelId } });
	// Async on purpose: this runs while the agent child is alive, where a
	// synchronous git call can park forever and freeze the shell.
	await commitCompanyMaterializationAsync(root, [join(".qorpera", "staff.json")]);
}

/** Hand queued coworker mail to a freshly spawned session. Called only after
 * a spawn whose staff context was built in the same transition, so delivery
 * marking can never outrun the context that displays the messages. */
function deliverQueuedStaffMessages(root: string, staffAgentId: string): void {
	try {
		const queued = pendingStaffAgentMessages(root, staffAgentId);
		if (queued.length) {
			markStaffAgentMessagesDelivered(
				root,
				queued.map((message) => message.id),
			);
		}
	} catch (error) {
		console.error(`coworker message delivery failed: ${(error as Error).message}`);
	}
}

function latestStaffTrailFile(runtime: CompanyRuntime, staffAgentId: string): string | undefined {
	return runtime.sessions
		.snapshot()
		.sessions.filter((session) => session.staffAgentId === staffAgentId && !session.autonomous)
		.sort(
			(left, right) =>
				(right.attachmentSequence ?? 0) - (left.attachmentSequence ?? 0) ||
				right.updatedAt.localeCompare(left.updatedAt),
		)[0]?.trailFile;
}

async function attachStaffChild(
	slot: Slot,
	runtime: CompanyRuntime,
	agent: StaffAgent,
	sessionFile: string | undefined,
	markIntroPending: boolean,
	autoStartStaffIntro = false,
): Promise<{ sessionFile: string }> {
	const previousChild = runtime.child;
	const attachedBinding = attendedSessionBinding(runtime);
	if (
		runtime.childOptions.staffAgentId === agent.id &&
		attachedBinding !== undefined &&
		attachedBinding.file === sessionFile &&
		(runtime.sessionAnchor !== undefined || isCurrentRuntimeChild(slot, runtime, runtime.child))
	) {
		return { sessionFile: attachedBinding.file };
	}
	const currentBinding = previousChild ? childBindings.get(previousChild) : undefined;
	const resumeOptions: ChildOptions = {
		...runtime.childOptions,
		sessionFile: currentBinding?.file ?? runtime.childOptions.sessionFile,
	};
	if (previousChild) await stopChild(previousChild);
	if (slot.runtime !== runtime || runtime.closing) throw new Error("company runtime changed before staff attachment");
	runtime.sessionAnchor = undefined;
	const options: ChildOptions = {
		sessionFile,
		...(sessionFile ? {} : { sessionName: agent.displayName }),
		staffAgentId: agent.id,
		staffContext: staffSystemContext(runtime.root, agent),
		model:
			(sessionFile ? trailModelSelection(runtime.root, sessionFile) : undefined) ??
			agent.model ??
			runtime.childOptions.model,
		...(autoStartStaffIntro ? { autoStartStaffIntro: true, freshStaffTrail: true } : {}),
	};
	if (profileAttachment(runtime.root).profileType === "cloud") {
		// Founder ruling (2026-08-26): cloud staff conversations are childless.
		// The thread is a synced view onto hosted truth, selections append to
		// the trail directly, and every prompt is a cloud turn — no local
		// agent process exists to spawn, crash, or pollute the conversation.
		const sessions = sessionControlPlanes.get(normalizedRoot(runtime.root));
		if (!sessions) throw new Error(`session control plane is unavailable for ${runtime.root}`);
		const scope = { actor: "company-agent", attended: false, staffAgentId: agent.id } as const;
		const binding = sessionFile
			? bindTrailSession(runtime.root, runtime.root, scope, sessionFile, sessions.auditForTrail(sessionFile))
			: bindTrailSession(runtime.root, runtime.root, scope);
		if (!sessionFile) appendKernelSessionInfo(binding, agent.displayName);
		sessions.rememberAudit(binding);
		deliverQueuedStaffMessages(runtime.root, agent.id);
		if (markIntroPending) {
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			const pending = recordStaffIntroPending(readStaffRuntimeState(statePath), agent.id, binding.file, Date.now());
			writeStaffRuntimeState(statePath, pending);
		}
		runtime.childOptions = options;
		runtime.attachedStaffVersion = runtime.cloudStaffSync?.versionForStaff(agent.id);
		recordAttachedTrailCursor(runtime, agent.id);
		delete runtime.childOptions.sessionName;
		delete runtime.childOptions.autoStartStaffIntro;
		delete runtime.childOptions.freshStaffTrail;
		runtime.sessionAnchor = { binding, staffAgentId: agent.id };
		runtime.child = undefined;
		runtime.productWorker = undefined;
		runtime.runtimeReconnectAttempts = 0;
		runtime.lastUnexpectedRuntimeExitAt = undefined;
		return { sessionFile: binding.file };
	}
	let child: ChildProcessWithoutNullStreams | undefined;
	try {
		child = startLegacyPiSessionAttachment(slot, runtime.root, options);
		const binding = childBindings.get(child);
		if (!binding) throw new Error("staff runtime did not receive a trail binding");
		deliverQueuedStaffMessages(runtime.root, agent.id);
		if (markIntroPending) {
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			const pending = recordStaffIntroPending(readStaffRuntimeState(statePath), agent.id, binding.file, Date.now());
			writeStaffRuntimeState(statePath, pending);
		}
		runtime.childOptions = options;
		runtime.attachedStaffVersion = runtime.cloudStaffSync?.versionForStaff(agent.id);
		recordAttachedTrailCursor(runtime, agent.id);
		delete runtime.childOptions.sessionName;
		delete runtime.childOptions.autoStartStaffIntro;
		delete runtime.childOptions.freshStaffTrail;
		runtime.child = child;
		runtime.productWorker = undefined;
		runtime.runtimeReconnectAttempts = 0;
		runtime.lastUnexpectedRuntimeExitAt = undefined;
		return { sessionFile: binding.file };
	} catch (error) {
		if (child) await stopChild(child);
		if (previousChild)
			await restoreAttendedChild(slot, runtime, resumeOptions, "staff-attachment agent runtime restore failed");
		throw error;
	}
}

/** Queue an attended prompt as a member-sponsored cloud turn. Shared by the
 * legacy child lane and the childless session anchor: validation of the
 * sponsor connection, the turn request, and the renderer queue echo are
 * identical either way. */
async function requestSponsoredCloudTurn(
	runtime: CompanyRuntime,
	arbiter: CloudSessionArbiter,
	staffAgentId: string,
	sessionRef: ArbiterSessionRef,
	reviewed: ReviewedPromptFrame,
): Promise<Record<string, unknown>> {
	const executionSponsor = reviewed.executionSponsor;
	if (!executionSponsor) {
		return {
			ok: false,
			error: "Select an active execution sponsor before sending. Cloud turns never use the desktop model runtime.",
		};
	}
	if (!reviewed.clientInputId || !qorperaAccountAuth) {
		return { ok: false, error: "cloud-sponsored message has no durable execution identity" };
	}
	const attachment = profileAttachment(runtime.root);
	if (attachment.profileType !== "cloud") {
		return { ok: false, error: "native subscription execution requires a cloud company" };
	}
	try {
		const control = qorperaAccountAuth.nativeSubscriptionControl();
		const available = await control.listConnections(attachment.profileId);
		const selected = available.connections.find(
			(connection) =>
				connection.sponsorBindingId === executionSponsor.sponsorBindingId &&
				connection.sponsorVersion === executionSponsor.sponsorVersion,
		);
		if (
			!available.computeIdentity ||
			available.computeIdentity.computeIdentityId !== executionSponsor.computeIdentityId ||
			!selected ||
			selected.connectionStatus !== "active" ||
			selected.authorizationState !== "active" ||
			selected.policy.implementationStatus !== "supported" ||
			selected.policy.enablementStatus !== "enabled"
		) {
			throw new Error("The selected personal subscription is unavailable or was revoked.");
		}
		const body = await prepareCloudPromptBody(runtime, reviewed);
		const request = await control.requestSessionTurn({
			sessionId: sessionRef.hostedSessionId,
			clientInputId: reviewed.clientInputId,
			clientRequestId: reviewed.clientInputId,
			body: body as unknown as JsonValue,
			sponsorMode: "member_connection",
			sponsorBindingId: executionSponsor.sponsorBindingId,
			sponsorVersion: executionSponsor.sponsorVersion,
			computeIdentityId: executionSponsor.computeIdentityId,
			workerClass: executionSponsor.workerClass,
		});
		const team = effectiveHostedTeam(attachment.profileId);
		const author = team?.members.find((member) => member.userId === currentQorperaAccountId);
		const queue = await readRendererSessionQueue(arbiter, staffAgentId, [
			{
				inputId: request.inputId,
				position: 0,
				status: request.status === "failed" ? "failed" : "queued",
				authorUserId: currentQorperaAccountId,
				authorDisplayName: author?.displayName ?? author?.email ?? "Company member",
				text: reviewed.displayText ?? reviewed.message,
				attachmentCount: reviewed.images?.length ?? 0,
				createdAt: new Date().toISOString(),
			},
		]);
		recordCloudSessionArbiterOutcome(runtime, { ok: true });
		return {
			ok: true,
			queued: true,
			queue,
			nativeExecution: {
				turnRequestId: request.turnRequestId,
				provider: selected.provider,
				nativeHarness: selected.nativeHarness,
				sponsorBindingId: executionSponsor.sponsorBindingId,
				sponsorVersion: executionSponsor.sponsorVersion,
			},
		};
	} catch (error) {
		recordCloudSessionArbiterOutcome(runtime, { ok: false, error });
		return {
			ok: false,
			error: `cloud subscription turn was not queued: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Last physical entry id of a bound trail file — the parent for selections
 * appended by the childless anchor, keeping the conversation one chain. */
function trailSessionLeafEntryId(path: string): string | null {
	const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean);
	for (let index = lines.length - 1; index >= 1; index--) {
		try {
			const entry = JSON.parse(lines[index]!) as { id?: unknown; type?: unknown };
			if (typeof entry.id === "string" && entry.type !== "session") return entry.id;
		} catch {
			/* a torn tail line never blocks a selection append */
		}
	}
	return null;
}

/** Session state for the childless anchor's get_state surface: the last
 * recorded model and thinking selections in the trail file. */
function anchoredSessionState(root: string, sessionFile: string): Record<string, unknown> {
	const state: Record<string, unknown> = { responseSpeed: "standard" };
	try {
		const lines = readFileSync(join(root, "trail", sessionFile), "utf-8")
			.split(/\r?\n/)
			.filter(Boolean);
		for (const line of lines.slice(1)) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (
					entry.type === "model_change" &&
					typeof entry.provider === "string" &&
					typeof entry.modelId === "string"
				) {
					state.model = { provider: entry.provider, id: entry.modelId };
				} else if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
					state.thinkingLevel = entry.thinkingLevel;
				}
			} catch {
				/* skip torn lines */
			}
		}
	} catch {
		/* an unreadable file serves defaults */
	}
	return state;
}

/** Answer the renderer's session RPC surface for a childless cloud anchor.
 * Reads come straight from the trail file, selections append to it, and a
 * prompt becomes a member-sponsored cloud turn — no local process involved. */
async function anchoredSessionRpc(
	slot: Slot,
	runtime: CompanyRuntime,
	anchor: NonNullable<CompanyRuntime["sessionAnchor"]>,
	frame: { type: string } & Record<string, unknown>,
	reviewedCloudPrompt: ReviewedPromptFrame | undefined,
): Promise<Record<string, unknown>> {
	const binding = anchor.binding;
	const respond = (command: string, data: Record<string, unknown>): { ok: true } => {
		send(slot.window, "rpc-event", { type: "response", command, success: true, data });
		return { ok: true };
	};
	const sessions = sessionControlPlanes.get(normalizedRoot(runtime.root));
	const appendSelection = (entry: Record<string, unknown>): Record<string, unknown> => {
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		const append = parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding);
		if (!append) return { ok: false, error: "selection could not be recorded" };
		appendBoundTrailEntry(binding, append.entry);
		commitTrailAppend(binding, append);
		sessions?.rememberAudit(binding);
		return { ok: true };
	};
	switch (frame.type) {
		case "get_messages":
		case "get_fork_messages":
			try {
				return respond(frame.type, { messages: trailSessionMessages(runtime.root, binding.file) });
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		case "get_state":
			return respond("get_state", anchoredSessionState(runtime.root, binding.file));
		case "set_thinking_level":
			return typeof frame.level === "string" && frame.level
				? appendSelection({
						type: "thinking_level_change",
						id: randomUUID(),
						parentId: trailSessionLeafEntryId(binding.path),
						timestamp: new Date().toISOString(),
						thinkingLevel: frame.level,
					})
				: { ok: false };
		case "set_model":
			return typeof frame.provider === "string" && typeof frame.modelId === "string"
				? appendSelection({
						type: "model_change",
						id: randomUUID(),
						parentId: trailSessionLeafEntryId(binding.path),
						timestamp: new Date().toISOString(),
						provider: frame.provider,
						modelId: frame.modelId,
					})
				: { ok: false };
		case "set_session_name": {
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			const name = typeof frame.name === "string" ? frame.name : "";
			if (!name.trim()) return { ok: false };
			try {
				appendKernelSessionInfo(binding, name);
				sessions?.rememberAudit(binding);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		case "set_response_speed":
			return { ok: true };
		case "abort": {
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			const ref = runtime.cloudSessionArbiter?.sessionForStaff(anchor.staffAgentId);
			const control = qorperaAccountAuth?.cloudSessionRunControl();
			if (!ref || !control || binding.sessionId !== ref.clientSessionId || typeof frame.runId !== "string") {
				return { ok: false, error: "Select the active cloud run in this conversation before stopping it." };
			}
			try {
				const status = await control.cancel(ref.hostedSessionId, frame.runId);
				triggerCloudTrailSync(runtime);
				void emitActiveStaffQueue(slot, runtime).catch(() => {});
				return { ok: true, status };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : "Cloud cancellation was not confirmed.",
				};
			} finally {
				runtime.cloudSessionRunRevision = (runtime.cloudSessionRunRevision ?? 0) + 1;
				void refreshCloudSessionRun(slot, runtime);
			}
		}
		case "prompt":
			return enqueueRuntimeTransition(runtime, async () => {
				if (slot.runtime !== runtime || runtime.closing || runtime.sessionAnchor !== anchor) {
					return { ok: false, error: "session changed before command" };
				}
				const reviewed = reviewedCloudPrompt ?? reviewedPromptFrame(frame);
				if (!reviewed || (!reviewed.message && !reviewed.images?.length)) return { ok: false };
				if (!slotHasProfileCapability(slot, "write")) {
					try {
						await refreshProfileAccess(runtime.root);
					} catch {
						/* unreachable cloud: the recheck below decides */
					}
					send(slot.window, "profile-access-changed", activeProfileAccess(runtime.root));
					if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
				}
				const arbiter = runtime.cloudSessionArbiter;
				if (!arbiter) return { ok: false, error: "cloud conversation is unavailable; your message was not sent" };
				let ref = arbiter.sessionForStaff(anchor.staffAgentId);
				if (!ref) {
					const staff = activeStaffAgent(runtime.root, anchor.staffAgentId);
					if (!staff) return { ok: false, error: "staff member is unavailable or archived" };
					try {
						ref = await arbiter.ensureSession(anchor.staffAgentId, staff.displayName, binding.sessionId);
						recordAttachedTrailCursor(runtime, anchor.staffAgentId);
						recordCloudSessionArbiterOutcome(runtime, { ok: true });
					} catch (error) {
						recordCloudSessionArbiterOutcome(runtime, { ok: false, error });
						return {
							ok: false,
							error: `cloud conversation could not be reached: ${error instanceof Error ? error.message : String(error)}`,
						};
					}
					if (slot.runtime !== runtime || runtime.closing || runtime.sessionAnchor !== anchor) {
						return { ok: false, error: "session changed before command" };
					}
				}
				if (!ref) return { ok: false, error: "cloud conversation is unavailable; your message was not sent" };
				if (binding.sessionId !== ref.clientSessionId) {
					void readoptStaffCloudSession(slot, runtime, anchor.staffAgentId, ref);
					return { ok: false, error: "conversation is rejoining its cloud history; retry in a moment" };
				}
				return requestSponsoredCloudTurn(runtime, arbiter, anchor.staffAgentId, ref, reviewed);
			});
		case "steer":
		case "follow_up":
			return { ok: false, error: "Steering is not available for cloud turns yet." };
		default:
			return { ok: false };
	}
}

const STAFF_AVATAR_COLORS = new Set([
	"#171716",
	"#9c7151",
	"#ff642e",
	"#ff365e",
	"#ffae00",
	"#00c878",
	"#00bfb3",
	"#0071e3",
	"#1684ff",
	"#8a4dff",
	"#ff2994",
	"#7c7c7a",
	"#5367e8",
]);
const STAFF_AVATAR_SHAPES = new Set(["soft-square", "round", "wide", "gem", "tilted", "drop"]);

function parsedStaffAppearance(value: unknown): StaffAgent["appearance"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid staff appearance");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some((key) => key !== "color" && key !== "shape" && key !== "creature") ||
		typeof record.color !== "string" ||
		typeof record.shape !== "string" ||
		(record.creature !== undefined && !isStaffCharacterId(record.creature)) ||
		!STAFF_AVATAR_COLORS.has(record.color) ||
		!STAFF_AVATAR_SHAPES.has(record.shape)
	) {
		throw new Error("invalid staff appearance");
	}
	return {
		color: record.color,
		shape: record.shape,
		...(typeof record.creature === "string" ? { creature: record.creature } : {}),
	};
}

function parsedStaffCreateInput(value: unknown): {
	templateId?: string;
	displayName?: string;
	appearance?: StaffAgent["appearance"];
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid staff creation input");
	const input = value as Record<string, unknown>;
	if (
		(input.templateId !== undefined && (typeof input.templateId !== "string" || !input.templateId)) ||
		(input.displayName !== undefined && typeof input.displayName !== "string") ||
		(input.appearance !== undefined &&
			(!input.appearance || typeof input.appearance !== "object" || Array.isArray(input.appearance))) ||
		Object.keys(input).some((key) => key !== "templateId" && key !== "displayName" && key !== "appearance")
	) {
		throw new Error("invalid staff creation input");
	}
	const displayName = typeof input.displayName === "string" ? input.displayName.trim() : undefined;
	if (displayName !== undefined && (!displayName || Buffer.byteLength(displayName, "utf-8") > 160)) {
		throw new Error("invalid staff display name");
	}
	if (input.templateId === undefined && !displayName) throw new Error("custom staff requires a display name");
	let appearance: StaffAgent["appearance"] | undefined;
	if (input.appearance !== undefined) {
		appearance = parsedStaffAppearance(input.appearance);
	}
	return {
		...(typeof input.templateId === "string" ? { templateId: input.templateId } : {}),
		...(displayName ? { displayName } : {}),
		...(appearance ? { appearance } : {}),
	};
}

function parsedTemplatedStaffCreateInput(value: unknown): ReturnType<typeof parsedStaffCreateInput> & {
	templateId: string;
} {
	const input = parsedStaffCreateInput(value);
	if (!input.templateId) throw new Error("initial staff requires a template");
	return { ...input, templateId: input.templateId };
}

function parsedStaffBootstrapInput(value: unknown): {
	agents: ReturnType<typeof parsedTemplatedStaffCreateInput>[];
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid staff bootstrap input");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => key !== "agents") ||
		!Array.isArray(input.agents) ||
		input.agents.length === 0 ||
		input.agents.length > listStaffTemplates().length
	) {
		throw new Error("invalid staff bootstrap input");
	}
	const agents = input.agents.map((agent) => parsedTemplatedStaffCreateInput(agent));
	if (new Set(agents.map((agent) => agent.templateId)).size !== agents.length) {
		throw new Error("initial staff templates must be unique");
	}
	return { agents };
}

async function bootstrapStaffTeam(
	slot: Slot,
	value: unknown,
): Promise<
	| { ok: true; staff: Array<{ staff: StaffAgent; sessionFile: string; introStatus: "pending" }> }
	| { ok: false; error: string }
> {
	let input: ReturnType<typeof parsedStaffBootstrapInput>;
	let templates: ReturnType<typeof getStaffTemplate>[];
	try {
		input = parsedStaffBootstrapInput(value);
		templates = input.agents.map((agent) => getStaffTemplate(agent.templateId));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before adding agents" };
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) {
			return { ok: false, error: "company runtime is busy" };
		}
		if (readStaffAgents(runtime.root).some((staff) => staff.employmentStatus === "active")) {
			return { ok: false, error: "this company already has agents; use Add agent instead" };
		}
		const previousChild = runtime.child;
		const resumeOptions: ChildOptions = {
			...runtime.childOptions,
			sessionFile: previousChild
				? (childBindings.get(previousChild)?.file ?? runtime.childOptions.sessionFile)
				: runtime.childOptions.sessionFile,
		};
		if (previousChild) await stopChild(previousChild);
		if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
		let staffChild: ChildProcessWithoutNullStreams | undefined;
		let created: StaffAgent[] = [];
		try {
			const cloudSessionAuthority = profileAttachment(runtime.root).profileType === "cloud";
			snapshotFounderGitState(runtime.root, "founder initial team creation");
			created = createStaffAgents(
				runtime.root,
				input.agents.map((agent, index) => {
					const template = templates[index]!;
					return {
						displayName: agent.displayName ?? template.name,
						role: template.role,
						charter: template.charter,
						templateId: template.id,
						appearance: {
							color: agent.appearance?.color ?? template.avatarColorToken,
							shape: agent.appearance?.shape ?? template.avatarShapeToken,
							creature: agent.appearance?.creature ?? staffCharacterForTemplate(template.id),
						},
					};
				}),
			);
			const artifactPaths = created.map(
				(staff, index) =>
					createStarterCompanyArtifact(
						runtime.root,
						staff.id,
						templates[index]!.id,
						templates[index]!.starterArtifact,
					).relativePath,
			);
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			let introState = readStaffRuntimeState(statePath);
			const bindings = created.map((staff) => {
				const binding = bindTrailSession(runtime.root, runtime.root, {
					actor: "company-agent",
					attended: false,
					staffAgentId: staff.id,
				});
				appendKernelSessionInfo(binding, staff.displayName);
				runtime.sessions.rememberAudit(binding);
				introState = recordStaffIntroPending(introState, staff.id, binding.file, Date.now());
				return binding;
			});
			writeStaffRuntimeState(statePath, introState);
			commitCompanyMaterialization(runtime.root, [
				join(".qorpera", "staff.json"),
				...created.map((staff) => relative(runtime.root, staffAgentDirectoryPath(runtime.root, staff.id))),
				...artifactPaths,
			]);
			triggerCloudStaffSync(runtime);
			const first = created[0]!;
			const firstBinding = bindings[0]!;
			const options: ChildOptions = {
				sessionFile: firstBinding.file,
				staffAgentId: first.id,
				staffContext: staffSystemContext(runtime.root, first),
				model: resumeOptions.model,
				freshStaffTrail: true,
				...(!cloudSessionAuthority ? { autoStartStaffIntro: true } : {}),
			};
			if (cloudSessionAuthority) {
				// Cloud staff conversations are childless: anchor onto the
				// pre-bound trail; the kickoff is a queue row the pump claims.
				runtime.childOptions = options;
				delete runtime.childOptions.freshStaffTrail;
				delete runtime.childOptions.autoStartStaffIntro;
				runtime.sessionAnchor = { binding: firstBinding, staffAgentId: first.id };
				runtime.child = undefined;
			} else {
				staffChild = startLegacyPiSessionAttachment(slot, runtime.root, options);
				runtime.childOptions = options;
				delete runtime.childOptions.freshStaffTrail;
				delete runtime.childOptions.autoStartStaffIntro;
				runtime.sessionAnchor = undefined;
				runtime.child = staffChild;
			}
			runtime.productWorker = undefined;
			runtime.staffBootstrapReturn = { staffAgentId: first.id, trailFile: firstBinding.file };
			runtime.runtimeReconnectAttempts = 0;
			runtime.lastUnexpectedRuntimeExitAt = undefined;
			if (cloudSessionAuthority) {
				runtimeCloudSessionArbiter(runtime);
				startCloudSessionPump(slot, runtime);
				setTimeout(() => {
					void refreshCloudSessionQueue(slot, runtime).catch(() => undefined);
				}, 0).unref();
			}
			return {
				ok: true,
				staff: created.map((staff, index) => ({
					staff,
					sessionFile: bindings[index]!.file,
					introStatus: "pending" as const,
				})),
			};
		} catch (error) {
			if (staffChild) await stopChild(staffChild);
			for (const staff of created) {
				try {
					archiveStaffAgent(runtime.root, staff.id);
				} catch {
					// Preserve the original failure; archived records are only rollback hygiene.
				}
			}
			if (previousChild)
				await restoreAttendedChild(slot, runtime, resumeOptions, "staff-bootstrap agent runtime restore failed");
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

async function createStaffMember(
	slot: Slot,
	value: unknown,
): Promise<
	{ ok: true; staff: StaffAgent; sessionFile: string; introStatus: "pending" } | { ok: false; error: string }
> {
	let input: ReturnType<typeof parsedStaffCreateInput>;
	let template: ReturnType<typeof getStaffTemplate> | undefined;
	try {
		input = parsedStaffCreateInput(value);
		template = input.templateId ? getStaffTemplate(input.templateId) : undefined;
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before adding staff" };
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) {
			return { ok: false, error: "company runtime is busy" };
		}
		const previousChild = runtime.child;
		const resumeOptions: ChildOptions = {
			...runtime.childOptions,
			sessionFile: previousChild
				? (childBindings.get(previousChild)?.file ?? runtime.childOptions.sessionFile)
				: runtime.childOptions.sessionFile,
		};
		if (previousChild) await stopChild(previousChild);
		if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
		let staffChild: ChildProcessWithoutNullStreams | undefined;
		try {
			snapshotFounderGitState(runtime.root, "founder staff creation");
			const displayName = input.displayName ?? template!.name;
			const staff = createStaffAgent(runtime.root, {
				displayName,
				role: template?.role ?? "Role to define with the founder",
				charter:
					template?.charter ??
					[
						`You are ${displayName}, a durable agent working over this company's files.`,
						"Your role is intentionally unconfigured. Do not invent a specialty or claim ownership until the founder defines what they want you around for.",
						"On the first turn, introduce yourself briefly and ask one direct question about the responsibility the founder wants you to own. Then turn their answer into a durable working role and a concrete first outcome.",
						"Inspect available company context before asking for access. Request only the exact service needed inside the conversation, and never claim access or completion you cannot verify.",
					].join(" "),
				...(template ? { templateId: template.id } : {}),
				appearance: {
					color: input.appearance?.color ?? template?.avatarColorToken ?? "#0071e3",
					shape: input.appearance?.shape ?? template?.avatarShapeToken ?? "round",
					creature: input.appearance?.creature ?? (template ? staffCharacterForTemplate(template.id) : "pebble"),
				},
			});
			const artifactPath = template
				? createStarterCompanyArtifact(runtime.root, staff.id, template.id, template.starterArtifact).relativePath
				: undefined;
			commitCompanyMaterialization(runtime.root, [
				join(".qorpera", "staff.json"),
				relative(runtime.root, staffAgentDirectoryPath(runtime.root, staff.id)),
				...(artifactPath ? [artifactPath] : []),
			]);
			triggerCloudStaffSync(runtime);
			if (profileAttachment(runtime.root).profileType === "cloud") {
				// Cloud staff conversations are childless from their first breath.
				const attached = await attachStaffChild(slot, runtime, staff, undefined, true);
				return { ok: true, staff, sessionFile: attached.sessionFile, introStatus: "pending" as const };
			}
			const options: ChildOptions = {
				sessionName: staff.displayName,
				staffAgentId: staff.id,
				staffContext: staffSystemContext(runtime.root, staff),
				model: resumeOptions.model,
			};
			staffChild = startLegacyPiSessionAttachment(slot, runtime.root, options);
			const binding = childBindings.get(staffChild);
			if (!binding) throw new Error("staff runtime did not receive a trail binding");
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			writeStaffRuntimeState(
				statePath,
				recordStaffIntroPending(readStaffRuntimeState(statePath), staff.id, binding.file, Date.now()),
			);
			runtime.childOptions = options;
			delete runtime.childOptions.sessionName;
			delete runtime.childOptions.autoStartStaffIntro;
			delete runtime.childOptions.freshStaffTrail;
			runtime.sessionAnchor = undefined;
			runtime.child = staffChild;
			runtime.productWorker = undefined;
			runtime.runtimeReconnectAttempts = 0;
			runtime.lastUnexpectedRuntimeExitAt = undefined;
			return { ok: true, staff, sessionFile: binding.file, introStatus: "pending" as const };
		} catch (error) {
			if (staffChild) await stopChild(staffChild);
			if (previousChild)
				await restoreAttendedChild(slot, runtime, resumeOptions, "staff-create agent runtime restore failed");
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

function parsedStaffUpdateInput(value: unknown): {
	displayName?: string;
	role?: string;
	appearance?: StaffAgent["appearance"];
	model?: StaffAgentModel | null;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid staff update");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length === 0 ||
		Object.keys(input).some(
			(key) => key !== "displayName" && key !== "role" && key !== "appearance" && key !== "model",
		) ||
		(input.displayName !== undefined && typeof input.displayName !== "string") ||
		(input.role !== undefined && typeof input.role !== "string") ||
		(input.appearance !== undefined &&
			(!input.appearance || typeof input.appearance !== "object" || Array.isArray(input.appearance)))
	) {
		throw new Error("invalid staff update");
	}
	const displayName = typeof input.displayName === "string" ? input.displayName.trim() : undefined;
	const role = typeof input.role === "string" ? input.role.trim() : undefined;
	const appearance = input.appearance === undefined ? undefined : parsedStaffAppearance(input.appearance);
	if (displayName !== undefined && (!displayName || Buffer.byteLength(displayName, "utf-8") > 160)) {
		throw new Error("invalid staff display name");
	}
	if (role !== undefined && (!role || Buffer.byteLength(role, "utf-8") > 320)) {
		throw new Error("invalid staff role");
	}
	let model: StaffAgentModel | null | undefined;
	if (input.model === null) {
		model = null;
	} else if (input.model !== undefined) {
		const record = input.model as Record<string, unknown>;
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			typeof record.provider !== "string" ||
			!record.provider.trim() ||
			typeof record.modelId !== "string" ||
			!record.modelId.trim() ||
			Object.keys(record).some((key) => key !== "provider" && key !== "modelId")
		) {
			throw new Error("invalid staff model selection");
		}
		model = { provider: record.provider.trim(), modelId: record.modelId.trim() };
	}
	return {
		...(displayName ? { displayName } : {}),
		...(role ? { role } : {}),
		...(appearance ? { appearance } : {}),
		...(model !== undefined ? { model } : {}),
	};
}

async function updateStaffMember(
	slot: Slot,
	staffAgentId: string,
	value: unknown,
): Promise<{ ok: true; staff: StaffAgent } | { ok: false; error: string }> {
	let update: ReturnType<typeof parsedStaffUpdateInput>;
	try {
		update = parsedStaffUpdateInput(value);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before editing staff" };
	return enqueueRuntimeTransition<{ ok: true; staff: StaffAgent } | { ok: false; error: string }>(
		runtime,
		async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
			if (isChildBusy(runtime.child) || runtime.wakeChild) {
				return { ok: false, error: "wait for the current company work to finish" };
			}
			try {
				if (!activeStaffAgent(runtime.root, staffAgentId))
					return { ok: false, error: "staff member is unavailable" };
				snapshotFounderGitState(runtime.root, "founder staff update");
				const staff = updateStaffAgent(runtime.root, staffAgentId, update);
				commitCompanyMaterialization(runtime.root, [
					join(".qorpera", "staff.json"),
					relative(runtime.root, staffAgentInstructionsPath(runtime.root, staff.id)),
				]);
				triggerCloudStaffSync(runtime);
				if (runtime.childOptions.staffAgentId === staff.id) {
					runtime.childOptions.staffContext = staffSystemContext(runtime.root, staff);
					if (update.model !== undefined) {
						const resolved =
							staff.model ?? readCompanyRuntimeModelPreference(app.getPath("userData"), runtime.root);
						runtime.childOptions.model = resolved;
						// Apply the founder's choice to the running session too; the
						// child's confirmation frame re-persists it idempotently.
						if (staff.model && runtime.child) {
							writeChildFrame(
								runtime.child,
								`${JSON.stringify({ type: "set_model", provider: staff.model.provider, modelId: staff.model.modelId })}\n`,
							);
						}
					}
				}
				return { ok: true, staff };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function archiveStaffMember(
	slot: Slot,
	staffAgentId: string,
): Promise<{ ok: true; staff: StaffAgent } | { ok: false; error: string }> {
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before archiving staff" };
	return enqueueRuntimeTransition<{ ok: true; staff: StaffAgent } | { ok: false; error: string }>(
		runtime,
		async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
			if (isChildBusy(runtime.child) || runtime.wakeChild) {
				return { ok: false, error: "wait for the current company work to finish" };
			}
			const staff = activeStaffAgent(runtime.root, staffAgentId);
			if (!staff) return { ok: false, error: "staff member is unavailable" };
			const previousChild = runtime.child;
			const attached = Boolean(
				(previousChild || runtime.sessionAnchor) && runtime.childOptions.staffAgentId === staff.id,
			);
			const previousBinding = attendedSessionBinding(runtime);
			const previousOptions: ChildOptions = {
				...runtime.childOptions,
				sessionFile: previousBinding?.file ?? runtime.childOptions.sessionFile,
			};
			let archived = false;
			try {
				snapshotFounderGitState(runtime.root, "founder staff archive");
				if (attached && previousChild) await stopChild(previousChild);
				if (attached) runtime.sessionAnchor = undefined;
				const deleted = archiveStaffAgent(runtime.root, staff.id);
				archived = true;
				commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
				try {
					cancelPendingConnectionRequestsForStaff(app.getPath("userData"), runtime.root, staff.id);
				} catch (error) {
					console.error(`staff connection request cleanup failed: ${(error as Error).message}`);
				}
				triggerCloudStaffSync(runtime);
				if (attached) {
					const next = readStaffAgents(runtime.root).find(
						(candidate) => candidate.employmentStatus !== "archived",
					);
					const nextTrail = next
						? (readStaffRuntimeState(staffRuntimeStatePath(app.getPath("userData"), runtime.root)).intros[next.id]
								?.trailFile ?? latestStaffTrailFile(runtime, next.id))
						: undefined;
					if (next && profileAttachment(runtime.root).profileType === "cloud") {
						await attachStaffChild(slot, runtime, next, nextTrail, !nextTrail);
					} else if (next) {
						const options: ChildOptions = {
							sessionFile: nextTrail,
							...(nextTrail ? {} : { sessionName: next.displayName, freshStaffTrail: true }),
							staffAgentId: next.id,
							staffContext: staffSystemContext(runtime.root, next),
							model: next.model ?? previousOptions.model,
						};
						runtime.child = startLegacyPiSessionAttachment(slot, runtime.root, options);
						runtime.childOptions = { ...options };
						delete runtime.childOptions.sessionName;
						delete runtime.childOptions.freshStaffTrail;
					} else {
						runtime.child = undefined;
						runtime.sessionAnchor = undefined;
						runtime.childOptions = { model: previousOptions.model };
					}
					runtime.productWorker = undefined;
					runtime.runtimeReconnectAttempts = 0;
					runtime.lastUnexpectedRuntimeExitAt = undefined;
				}
				return { ok: true, staff: deleted };
			} catch (error) {
				if (attached && slot.runtime === runtime && !runtime.closing) {
					if (archived) {
						runtime.child = undefined;
						runtime.childOptions = { model: previousOptions.model };
					} else {
						await restoreAttendedChild(
							slot,
							runtime,
							previousOptions,
							"staff-archive agent runtime restore failed",
						);
					}
				}
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function permanentlyDeleteStaffMember(
	slot: Slot,
	staffAgentId: string,
	keepArtifacts: boolean,
): Promise<{ ok: true; staff: StaffAgent } | { ok: false; error: string }> {
	const archived = await archiveStaffMember(slot, staffAgentId);
	if (!archived.ok) return archived;
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "company runtime closed after archiving the agent" };
	if (profileAttachment(runtime.root).profileType === "cloud") {
		runtime.cloudStaffSync ??= createCloudStaffSynchronizer(runtime.root);
		try {
			if (!runtime.cloudStaffSync) throw new Error("Cloud staff deletion is unavailable.");
			await runtime.cloudStaffSync.deleteStaff(staffAgentId);
		} catch (error) {
			const restored = await restoreStaffMember(slot, staffAgentId);
			if (restored.ok && slot.runtime === runtime && !runtime.closing) {
				triggerCloudStaffSync(runtime);
			} else if (!restored.ok) {
				console.error(`staff deletion rollback failed: ${restored.error}`);
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return enqueueRuntimeTransition<{ ok: true; staff: StaffAgent } | { ok: false; error: string }>(
		runtime,
		async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
			try {
				const artifactPaths = readCompanyArtifacts(runtime.root)
					.filter((artifact) => artifact.stewardAgentId === staffAgentId)
					.map((artifact) => artifact.relativePath);
				snapshotFounderGitState(runtime.root, "founder permanent staff deletion");
				const deleted = readStaffAgents(runtime.root).some((staff) => staff.id === staffAgentId)
					? deleteStaffAgent(runtime.root, staffAgentId)
					: archived.staff;
				const agentDirectory = staffAgentDirectoryPath(runtime.root, staffAgentId);
				removeStaffWorkspace(agentDirectory, keepArtifacts);
				commitCompanyMaterialization(runtime.root, [
					join(".qorpera", "staff.json"),
					relative(runtime.root, agentDirectory),
					...artifactPaths,
				]);
				try {
					cancelPendingConnectionRequestsForStaff(app.getPath("userData"), runtime.root, staffAgentId);
				} catch (error) {
					console.error(`staff connection request cleanup failed: ${(error as Error).message}`);
				}
				const computerProfile = join(
					app.getPath("userData"),
					"chrome-computers",
					companyRootId(runtime.root),
					staffAgentId,
				);
				try {
					if (existsSync(computerProfile)) rmSync(computerProfile, { recursive: true, force: true });
				} catch (error) {
					console.error(`staff computer cleanup failed: ${(error as Error).message}`);
				}
				triggerCloudStaffSync(runtime);
				return { ok: true, staff: deleted };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function restoreStaffMember(
	slot: Slot,
	staffAgentId: string,
): Promise<{ ok: true; staff: StaffAgent } | { ok: false; error: string }> {
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before restoring staff" };
	return enqueueRuntimeTransition<{ ok: true; staff: StaffAgent } | { ok: false; error: string }>(
		runtime,
		async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
			try {
				const archived = readStaffAgents(runtime.root).find(
					(candidate) => candidate.id === staffAgentId && candidate.employmentStatus === "archived",
				);
				if (!archived) return { ok: false, error: "archived staff member is unavailable" };
				snapshotFounderGitState(runtime.root, "founder staff restore");
				const staff = restoreStaffAgent(runtime.root, staffAgentId);
				commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
				return { ok: true, staff };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function openStaffMember(
	slot: Slot,
	staffAgentId: string,
): Promise<
	| {
			ok: true;
			staff: StaffAgent;
			sessionFile: string;
			introStatus?: "pending" | "started" | "completed" | "failed";
			queue?: Array<Record<string, unknown>>;
	  }
	| { ok: false; error: string }
> {
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before opening staff" };
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
		const staff = activeStaffAgent(runtime.root, staffAgentId);
		if (!staff) return { ok: false, error: "staff member is unavailable or archived" };
		const introState = readStaffRuntimeState(staffRuntimeStatePath(app.getPath("userData"), runtime.root)).intros[
			staff.id
		];
		const currentBinding = attendedSessionBinding(runtime);
		if (
			runtime.childOptions.staffAgentId === staff.id &&
			currentBinding &&
			(runtime.sessionAnchor !== undefined || isCurrentRuntimeChild(slot, runtime, runtime.child))
		) {
			const arbiter = runtime.cloudSessionArbiter;
			return {
				ok: true,
				staff,
				sessionFile: currentBinding.file,
				...(arbiter?.sessionForStaff(staff.id) ? { queue: await readRendererSessionQueue(arbiter, staff.id) } : {}),
				...(introState?.status ? { introStatus: introState.status } : {}),
			};
		}
		if (runtime.wakeChild || isChildBusy(runtime.child)) {
			return { ok: false, error: "company runtime is busy" };
		}
		try {
			let existingTrail = introState?.trailFile ?? latestStaffTrailFile(runtime, staff.id);
			const cloudCompany = profileAttachment(runtime.root).profileType === "cloud";
			// Cloud companies adopt an existing hosted session without creating
			// cloud state. A new session (and its kickoff row) is created atomically
			// only when the member submits the first durable input.
			let cloudAdopted = false;
			const sessionArbiter = slotHasProfileCapability(slot, "write")
				? runtimeCloudSessionArbiter(runtime)
				: undefined;
			if (cloudCompany && slotHasProfileCapability(slot, "write") && !sessionArbiter) {
				return { ok: false, error: "cloud conversation is unavailable" };
			}
			if (sessionArbiter) {
				try {
					const ref =
						sessionArbiter.sessionForStaff(staff.id) ?? (await sessionArbiter.adoptExistingSession(staff.id));
					if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
					if (ref) {
						existingTrail = localTrailForArbiterRef(runtime, staff, ref);
						cloudAdopted = true;
					}
					recordCloudSessionArbiterOutcome(runtime, { ok: true });
				} catch (error) {
					recordCloudSessionArbiterOutcome(runtime, { ok: false, error });
					if (cloudCompany) {
						return {
							ok: false,
							error: `cloud conversation could not be reached: ${error instanceof Error ? error.message : String(error)}`,
						};
					}
				}
			}
			if (!existingTrail && !slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			// Under arbitration the kickoff is a queue row: the pump claims and
			// dispatches it, so the machine-local intro trigger stays off and a
			// second machine can never re-run it.
			const attached = await attachStaffChild(slot, runtime, staff, existingTrail, !cloudAdopted && !existingTrail);
			if (runtimeCloudSessionArbiter(runtime)) {
				// The pump claims only the adopted cloud session; no attended
				// prompt or introduction is ever dispatched on a local fallback.
				startCloudSessionPump(slot, runtime);
				setTimeout(() => {
					void refreshCloudSessionQueue(slot, runtime).catch(() => undefined);
				}, 1_500).unref();
			}
			return {
				ok: true,
				staff,
				sessionFile: attached.sessionFile,
				...(sessionArbiter && cloudAdopted
					? { queue: await readRendererSessionQueue(sessionArbiter, staff.id) }
					: {}),
				...(introState?.status
					? { introStatus: introState.status }
					: !cloudAdopted && !existingTrail
						? { introStatus: "pending" as const }
						: {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

async function staffIntroReady(
	slot: Slot,
	staffAgentId: string,
	trailFile: string,
	retry: boolean,
): Promise<{ ok: boolean; status?: string; error?: string }> {
	const runtime = slot.runtime;
	if (!runtime) return { ok: false, error: "open a company before starting a staff introduction" };
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
		const staff = activeStaffAgent(runtime.root, staffAgentId);
		const child = runtime.child;
		if (!staff) return { ok: false, error: "staff member is unavailable" };
		if (!child) return { ok: false, error: "staff member is not attached" };
		if (profileAttachment(runtime.root).profileType === "cloud") {
			const binding = childBindings.get(child);
			if (
				runtime.childOptions.staffAgentId !== staff.id ||
				binding?.file !== trailFile ||
				!isCurrentRuntimeChild(slot, runtime, child)
			) {
				return { ok: false, error: "staff introduction target is not the attached session" };
			}
			const arbiter = runtimeCloudSessionArbiter(runtime);
			if (!arbiter) return { ok: false, error: "cloud conversation is unavailable" };
			if (retry) {
				return {
					ok: false,
					error: "Retry the introduction by sending a cloud message with an explicit execution sponsor.",
				};
			}
			setTimeout(() => {
				void refreshCloudSessionQueue(slot, runtime).catch(() => undefined);
			}, 0).unref();
			return { ok: true, status: "pending" };
		}
		return beginAttachedStaffIntro(slot, runtime, staff, child, trailFile, retry);
	});
}

function rendererRequestAllowed(slot: Slot, value: string): boolean {
	return isRendererRequestAllowed(value, {
		backendOrigin: slot.runtime ? `http://127.0.0.1:${slot.runtime.backendPort}` : undefined,
		trustedFileRoot: FIXED_SHELL_DIR,
	});
}

/** Sessions are per-partition singletons, and a company's persist: partition
 * outlives any one window — so each session is locked down and given its
 * request boundary exactly once, and the boundary resolves the requesting
 * window's slot per request instead of closing over one slot forever. */
const configuredRendererSessions = new WeakSet<Session>();
const slotsByWebContentsId = new Map<number, Slot>();

function rendererSessionFor(partition: string): Session {
	const rendererSession = electronSession.fromPartition(partition, {
		cache: false,
	});
	if (configuredRendererSessions.has(rendererSession)) return rendererSession;
	configuredRendererSessions.add(rendererSession);
	lockDownRendererSession(rendererSession);
	rendererSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
		const owner = details.webContentsId === undefined ? undefined : slotsByWebContentsId.get(details.webContentsId);
		// Requests the session cannot attribute to a live renderer window
		// (file: navigations carry no webContentsId) get the strictest policy
		// that keeps the kernel chrome bootable: trusted base files, no network.
		const allowed = owner
			? rendererRequestAllowed(owner, details.url)
			: isRendererRequestAllowed(details.url, {
					trustedFileRoot: FIXED_SHELL_DIR,
				});
		callback({ cancel: !allowed });
	});
	return rendererSession;
}

/** Hub windows get a throwaway in-memory partition; a window created FOR a
 * company boots straight onto that company's durable partition, so opening
 * it needs no window swap. */
function initialRendererPartition(companyRoot?: string): string {
	if (companyRoot) {
		try {
			return rendererPartitionForCompany(companyRootId(companyRoot));
		} catch {
			// Not an existing root — openCompany will refuse it; boot as a hub.
		}
	}
	return `qorpera-renderer-${randomUUID()}`;
}

function beginAttachedStaffIntro(
	slot: Slot,
	runtime: CompanyRuntime,
	staff: StaffAgent,
	child: ChildProcessWithoutNullStreams,
	trailFile: string,
	retry: boolean,
): { ok: boolean; status?: string; error?: string } {
	const binding = childBindings.get(child);
	if (
		runtime.childOptions.staffAgentId !== staff.id ||
		binding?.file !== trailFile ||
		!isCurrentRuntimeChild(slot, runtime, child)
	) {
		return { ok: false, error: "staff introduction target is not the attached session" };
	}
	if (!childRuntimeReady.has(child)) {
		return { ok: false, error: "staff introduction target is not the attached ready session" };
	}
	const path = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
	const current = readStaffRuntimeState(path);
	// An intro already claimed by a concurrent kick (creation and open both
	// kick) is a success for the second caller, not a busy refusal — the busy
	// state IS the introduction running.
	const existingStatus = current.intros[staff.id]?.status;
	if (!retry && (existingStatus === "started" || existingStatus === "completed")) {
		return { ok: true, status: existingStatus };
	}
	if (childBusy.get(child)) return { ok: false, error: "staff session is already working" };
	const claim = claimStaffIntro(current, staff.id, trailFile, Date.now(), retry);
	if (!claim.claimed) {
		const status = current.intros[staff.id]?.status;
		return {
			ok: status === "started" || status === "completed",
			status,
			...(status === "failed" && !retry ? { error: "staff introduction requires an explicit retry" } : {}),
		};
	}
	writeStaffRuntimeState(path, claim.state);
	if (
		!sendLegacyLocalStaffDirective(
			child,
			staffIntroMessage(runtime.root, staff, claim.state.intros[staff.id]?.orientation),
		)
	) {
		finishStaffIntroDurably(runtime.root, staff.id, trailFile, false, "staff intro dispatch failed");
		return { ok: false, status: "failed", error: "staff introduction could not be started" };
	}
	return { ok: true, status: "started" };
}

function scheduleAutomaticStaffIntro(
	slot: Slot,
	expectedChild: ChildProcessWithoutNullStreams,
	staffAgentId: string,
	trailFile: string,
): void {
	setTimeout(() => {
		const runtime = slot.runtime;
		if (!runtime || runtime.child !== expectedChild || runtime.closing) return;
		void enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.child !== expectedChild || runtime.closing) return;
			const staff = activeStaffAgent(runtime.root, staffAgentId);
			if (!staff) return;
			const result = beginAttachedStaffIntro(slot, runtime, staff, expectedChild, trailFile, false);
			if (!result.ok) console.error(`automatic staff intro failed: ${result.error ?? result.status ?? "unknown"}`);
		});
	}, 0).unref();
}

function schedulePendingConnectorSetupResume(
	slot: Slot,
	expectedChild: ChildProcessWithoutNullStreams,
	staffAgentId: string,
	trailFile: string,
): void {
	setTimeout(() => {
		const runtime = slot.runtime;
		if (!runtime || runtime.child !== expectedChild || runtime.closing) return;
		void enqueueRuntimeTransition(runtime, async () => {
			if (
				slot.runtime !== runtime ||
				runtime.child !== expectedChild ||
				runtime.closing ||
				runtime.wakeChild ||
				childBusy.get(expectedChild)
			) {
				return;
			}
			const request = getRecoverableConnectionSetup(app.getPath("userData"), runtime.root, staffAgentId, trailFile);
			if (!request) return;
			if (runtime.resumedConnectionSetupIds.has(request.id)) return;
			const connector = companyConnectorForRequest(runtime.root, request);
			if (!connector || !companyConnectorNeedsRegistration(runtime.root, connector)) return;
			runtime.resumedConnectionSetupIds.add(request.id);
			const sent = sendLegacyLocalStaffDirective(
				expectedChild,
				[
					`Resume the durable ${connector.displayName} setup that the founder already selected and authorized.`,
					`Re-read ${connector.relativePath}, then reopen its registrationUrl with use_computer in this agent's existing managed Chrome profile.`,
					"Continue every public setup step yourself. Do not request another selection or approval. Stop only at a genuinely private sign-in, identity verification, MFA, passkey, or provider-consent boundary. If the protected step is already complete, continue public setup. Read a generated public client ID first, wait for that result, update the manifest, and only then store the manifest-declared client secret through a later store_secret call without reading or repeating it.",
					"Do not narrate progress or produce a setup summary. Use the computer now and settle immediately after a handoff or successful continuation.",
				].join("\n"),
				"host-connector-setup-resume",
			);
			if (!sent) {
				runtime.resumedConnectionSetupIds.delete(request.id);
				console.error(`connector setup resume could not be dispatched: ${request.displayName}`);
			}
		}).catch((error) => console.error(`connector setup recovery failed: ${(error as Error).message}`));
	}, 0).unref();
}

function scheduleNextQueuedStaffIntro(slot: Slot, expectedChild: ChildProcessWithoutNullStreams): void {
	setTimeout(() => {
		const runtime = slot.runtime;
		if (!runtime || runtime.child !== expectedChild || runtime.closing) return;
		void enqueueRuntimeTransition(runtime, async () => {
			if (
				slot.runtime !== runtime ||
				runtime.child !== expectedChild ||
				runtime.closing ||
				runtime.wakeChild ||
				childBusy.get(expectedChild)
			) {
				return;
			}
			const state = readStaffRuntimeState(staffRuntimeStatePath(app.getPath("userData"), runtime.root));
			const active = new Map(
				readStaffAgents(runtime.root)
					.filter((staff) => staff.employmentStatus === "active")
					.map((staff) => [staff.id, staff]),
			);
			const next = Object.values(state.intros).find(
				(intro) => intro.status === "pending" && active.has(intro.staffAgentId),
			);
			if (next) {
				const cloudSessionAuthority = profileAttachment(runtime.root).profileType === "cloud";
				await attachStaffChild(
					slot,
					runtime,
					active.get(next.staffAgentId)!,
					next.trailFile,
					false,
					!cloudSessionAuthority,
				);
				if (cloudSessionAuthority) {
					setTimeout(() => {
						void refreshCloudSessionQueue(slot, runtime).catch(() => undefined);
					}, 0).unref();
				}
				return;
			}
			const returnTarget = runtime.staffBootstrapReturn;
			if (!returnTarget) return;
			delete runtime.staffBootstrapReturn;
			if (runtime.childOptions.staffAgentId === returnTarget.staffAgentId) return;
			const staff = active.get(returnTarget.staffAgentId);
			if (staff) await attachStaffChild(slot, runtime, staff, returnTarget.trailFile, false);
		});
	}, 0).unref();
}

/** Build one renderer window on the given partition and wire every kernel
 * duty to it. `forSlot` resolves the owning slot lazily: a fresh slot is
 * built around its first window, and a swap window joins an existing slot
 * that keeps pointing at the old window until the swap commits. */
function createRendererWindow(
	partition: string,
	forSlot: () => Slot,
	options: { bounds?: Electron.Rectangle; show?: boolean } = {},
): { window: BrowserWindow; rendererSession: Session } {
	const rendererSession = rendererSessionFor(partition);
	const sidebarTranslucency = process.platform === "darwin" && readSidebarTranslucency(app.getPath("userData"));
	const win = new BrowserWindow({
		width: 1360,
		height: 860,
		show: options.show ?? true,
		title: "Qorpera Base",
		backgroundColor: sidebarTranslucency ? "#00ffffff" : "#ffffff",
		...(sidebarTranslucency ? { vibrancy: "sidebar" as const, visualEffectState: "active" as const } : {}),
		// Frameless, Desktop-style chrome: the fixed shell draws the titlebar
		// (a -webkit-app-region: drag header), the OS overlays min/max/close.
		titleBarStyle: "hidden",
		titleBarOverlay: TITLE_BAR_OVERLAY,
		icon: DEFAULT_ICON,
		webPreferences: {
			preload: join(DIRNAME, "preload.cjs"),
			additionalArguments: [`--qorpera-sidebar-translucency=${sidebarTranslucency ? "on" : "off"}`],
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			session: rendererSession,
		},
	});
	lockDownRendererWebContents(win.webContents);
	win.webContents.on("console-message", (details) => {
		if (details.level !== "warning" && details.level !== "error") return;
		console.error(`renderer ${details.level} at ${details.sourceId}:${details.lineNumber}: ${details.message}`);
	});
	win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		if (!isMainFrame) return;
		console.error(`renderer load failed (${errorCode}) ${validatedURL}: ${errorDescription}`);
	});
	const contentsId = win.webContents.id;
	if (options.bounds) win.setBounds(options.bounds);
	win.setMenuBarVisibility(false);
	// Kernel duty: keep a thin native drag region above the fixed shell's
	// interactive header controls.
	win.webContents.on("did-finish-load", () => {
		setSettingsTitleBarOverlay(win, false);
		void win.webContents
			.insertCSS(
				"body::before{content:'';position:fixed;top:0;left:0;right:150px;height:12px;z-index:2147483647;-webkit-app-region:drag;}",
			)
			.catch(() => {});
		send(win, "update-state", foundationUpdateState);
		if (downloadedUpdateVersion) send(win, "update-ready", downloadedUpdateVersion);
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return { action: "deny" };
		}
		if ((target.protocol === "https:" || target.protocol === "http:") && Buffer.byteLength(url) <= 8192) {
			void confirmKernelReview(win, {
				title: "Open external link",
				summary: "Open this exact URL outside Qorpera Base?",
				exactText: target.href,
			}).then((approved) => {
				if (approved) void electronShell.openExternal(target.href);
			});
		}
		return { action: "deny" };
	});
	// Page loads are kernel-only. Swallow mouse history commands and drop
	// history after every kernel-initiated load so the fixed shell cannot
	// navigate back into a stale hub document.
	win.on("app-command", (event, command) => {
		if (command === "browser-backward" || command === "browser-forward") event.preventDefault();
	});
	win.webContents.on("did-finish-load", () => win.webContents.navigationHistory.clear());
	win.webContents.on("will-navigate", (event, url) => {
		if (!rendererRequestAllowed(forSlot(), url)) event.preventDefault();
	});
	// Reload the fixed shell after a renderer crash. Guarded to the slot's
	// current window; an uncommitted swap rejects its own pending load.
	win.webContents.on("render-process-gone", () => {
		const slot = forSlot();
		if (slot.window === win && slot.runtime) void win.loadURL(companyShellUrl(slot.runtime));
	});
	// An opted-in background company survives its window: closing the window
	// hides it instead, the runtime keeps its wake ticker and queued room
	// deliveries, and the tray owns the way back in. Quit always wins.
	win.on("close", (event) => {
		if (appQuitting) return;
		const slot = forSlot();
		if (slot.window !== win) return;
		const runtime = slot.runtime;
		if (!runtime || runtime.closing || !backgroundCompanyEnabled(runtime.root)) return;
		event.preventDefault();
		win.hide();
		syncBackgroundTray();
	});
	// Any path that re-surfaces a hidden background window retires the tray.
	win.on("show", () => syncBackgroundTray());
	// Closing a company window is closing that company: kill its child
	// and backend; other windows are untouched. A window retired by a swap
	// is no longer the slot's window — its company must stay running.
	win.on("closed", () => {
		connectionLogins.get(contentsId)?.controller.abort();
		connectionLogins.delete(contentsId);
		slots.delete(win.id);
		slotsByWebContentsId.delete(contentsId);
		const slot = forSlot();
		if (slot.window === win) {
			slot.openGeneration += 1;
			void closeCompany(slot);
		}
		// Destroyed windows (sign-out, swaps) bypass the "close" interception;
		// a tray pointing at a gone slot must not linger.
		syncBackgroundTray();
	});
	return { window: win, rendererSession };
}

/** Both maps a renderer window answers to: IPC (by window id) and the
 * session request boundary (by webContents id). */
function registerRendererWindow(win: BrowserWindow, slot: Slot): void {
	slots.set(win.id, slot);
	slotsByWebContentsId.set(win.webContents.id, slot);
}

function createWindow(companyRoot?: string): Slot {
	let slot: Slot;
	const partition = initialRendererPartition(companyRoot);
	const { window, rendererSession } = createRendererWindow(partition, () => slot);
	slot = { window, rendererSession, partition, kickoffPending: false, openGeneration: 0 };
	registerRendererWindow(window, slot);
	void window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
	return slot;
}

interface RendererWindowSwap {
	window: BrowserWindow;
	commit: () => void;
	abort: () => void;
}

/** A WebContents can never change its session, so moving a slot onto a
 * different company partition means replacing the window itself. The slot is
 * the stable identity: the replacement joins the lookup maps immediately
 * (IPC from its booting renderer must resolve), but the slot keeps pointing
 * at the old window until the new chrome actually loads — an aborted swap
 * leaves the old window (and whatever it shows) untouched. */
function beginRendererWindowSwap(slot: Slot, partition: string): RendererWindowSwap {
	const previous = slot.window;
	const bounds = previous.getBounds();
	const maximized = previous.isMaximized();
	const { window, rendererSession } = createRendererWindow(partition, () => slot, { bounds, show: false });
	registerRendererWindow(window, slot);
	return {
		window,
		commit: () => {
			slot.window = window;
			slot.rendererSession = rendererSession;
			slot.partition = partition;
			if (maximized) window.maximize();
			window.show();
			if (!previous.isDestroyed()) previous.destroy();
		},
		abort: () => {
			if (!window.isDestroyed()) window.destroy();
		},
	};
}

// Single instance: relaunching (e.g. a company launcher) routes into the
// running shell instead of stacking processes running different builds —
// but windows are per-company, so a launcher for a company that is not open
// gets a NEW window next to the others. Smoke runs are headless test boots
// and must not join or disturb a live instance — they contend for the same
// lock below and refuse to boot when they lose it.
const IS_SMOKE = process.argv.some((arg) => arg.startsWith("--smoke"));
const HOST_INSTANCE_ID = randomUUID();

// Electron's default uncaughtException behavior is a blocking native "Error"
// dialog — under headless smokes and autonomous kernels there is nobody to
// dismiss it, so the process hangs forever at 0% CPU while its servers go
// unserviced. Log and keep running instead (the same outcome as a founder
// dismissing the dialog, minus the founder).
process.on("uncaughtException", (error) => {
	console.error(`uncaught exception: ${error.stack ?? String(error)}`);
});
// Every boot — smoke included — must hold the per-userData single-instance
// lock: two processes doing read-modify-write over the same userData stores
// (profile-attachments.json among them) once silently downgraded a cloud
// attachment to local. A smoke that loses the lock refuses to run instead of
// joining or disturbing the live instance; run it against its own
// --user-data-dir to smoke next to a live shell.
const HAS_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!HAS_SINGLE_INSTANCE_LOCK) {
	if (IS_SMOKE) {
		console.error("SMOKE_REFUSED another instance is already running against this userData");
		app.exit(1);
	} else {
		app.quit();
	}
}
app.on("second-instance", (_event, argv) => {
	// A refused smoke boot notifies us as a side effect of trying the lock;
	// it must not conjure windows in the live instance.
	if (argv.some((arg) => arg.startsWith("--smoke"))) return;
	const invitationId = profileInvitationIdFromArgv(argv);
	if (invitationId) {
		queueProfileInvitationHandoff(invitationId);
		return;
	}
	const root = companyFromArgv(argv);
	if (root) {
		const existing = slotForCompany(root);
		if (existing) focusWindow(existing.window);
		else {
			// Route launchers through the signed-in fixed shell. The renderer
			// consumes this only after the account gate has completed.
			pendingCompany = root;
			createWindow();
		}
		return;
	}
	// Launching "Qorpera Base" itself means: take me to the hub — in its own
	// window, without yanking any open company window away from its company.
	const hub = [...slots.values()].find((slot) => !slot.runtime);
	if (hub) focusWindow(hub.window);
	else createWindow();
});
app.on("open-url", (event, url) => {
	if (!queueProfileInvitationProtocolUrl(url)) return;
	event.preventDefault();
});

app.whenReady().then(async () => {
	// A losing instance is on its way out via quit/exit above; it must not
	// touch any userData store in the meantime.
	if (!HAS_SINGLE_INSTANCE_LOCK) return;
	// Reconcile login-start with the durable background-company registry, so
	// removing the last opted-in company (or an edited registry) takes effect.
	syncBackgroundLoginItem(readBackgroundCompanyRoots(app.getPath("userData")));
	setCompanySecretStore(
		createLocalCompanySecretStore(join(app.getPath("userData"), "company-secret-vaults"), {
			id: "electron-safe-storage-v1",
			protect: (plaintext) => {
				if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable");
				return safeStorage.encryptString(plaintext);
			},
			unprotect: (ciphertext) => {
				if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable");
				return safeStorage.decryptString(ciphertext);
			},
		}),
	);
	qorperaAccountAuth = new QorperaAccountAuth(app.getPath("userData"), {
		openExternal: (url) => electronShell.openExternal(url),
		...(process.env.QORPERA_NATIVE_PROVIDER_URL?.trim()
			? { nativeProviderUrl: process.env.QORPERA_NATIVE_PROVIDER_URL.trim() }
			: {}),
	});
	try {
		rememberAuthenticatedAccount(await qorperaAccountAuth.info());
	} catch {
		rememberAuthenticatedAccount({ authenticated: false });
	}
	const modelAgentDir = join(app.getPath("home"), ".qorpera", "agent");
	modelAccountStore = new ModelAccountStore(
		join(app.getPath("userData"), "model-accounts.json"),
		join(modelAgentDir, "auth.json"),
		{ ownerUserId: currentQorperaAccountId },
	);
	brokerModelRuntime = await ModelRuntime.create({
		credentials: modelAccountStore,
		modelsPath: join(modelAgentDir, "models.json"),
		allowModelNetwork: false,
	});
	modelRequestBroker = await startModelRequestBroker({
		authPath: join(modelAgentDir, "auth.json"),
		modelsPath: join(modelAgentDir, "models.json"),
		allowedProviders: MODEL_AUTH_PROVIDERS,
		runtime: brokerModelRuntime,
		accountRouter: {
			lease: async (providerId) => {
				await modelAccountUsageInfo(false).catch(() => []);
				return modelAccountStore?.lease(providerId);
			},
			markRateLimited: (accountId) => modelAccountStore?.markRateLimited(accountId),
		},
	});
	void modelAccountUsageInfo(false).catch(() => []);
	startWakeTicker();
	const exactCompanyProposal = async (
		runtime: CompanyRuntime,
		proposalId: unknown,
		proposalSnapshotId: unknown,
	): Promise<{
		proposal: HostedCompanyProposal;
		attachment: Extract<ProfileAttachment, { profileType: "cloud" }>;
	}> => {
		if (typeof proposalId !== "string" || typeof proposalSnapshotId !== "string") {
			throw new Error("Company proposal identity is invalid.");
		}
		const attachment = profileAttachment(runtime.root);
		if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!primary) throw new Error("Cloud Company File access is unavailable.");
		const proposal = await primary.getCompanyProposal(proposalId);
		if (
			proposal.environmentId !== attachment.environmentId ||
			proposal.proposalSnapshot.snapshotId !== proposalSnapshotId
		) {
			throw new Error("The Company File proposal changed; review the current version first.");
		}
		return { proposal, attachment };
	};
	ipcMain.handle("account:info", async (event): Promise<QorperaAccountInfo> => {
		if (!slotOf(event.sender) || !qorperaAccountAuth) return { authenticated: false };
		try {
			const account = rememberAuthenticatedAccount(await qorperaAccountAuth.info());
			if (account.authenticated) claimExistingCompanies(account);
			return account;
		} catch (error) {
			currentQorperaAccountId = undefined;
			console.error(`Qorpera account read failed: ${error instanceof Error ? error.message : String(error)}`);
			return { authenticated: false };
		}
	});
	ipcMain.handle("account:sign-in", async (event, input: unknown, rememberLocally: unknown) => {
		const owner = slotOf(event.sender);
		if (!isTrustedHubSender(event.sender) || !owner || !qorperaAccountAuth) {
			return { ok: false, error: "Qorpera sign-in is only available from the company selector." };
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			return { ok: false, error: "invalid sign-in request" };
		}
		if (typeof rememberLocally !== "boolean") return { ok: false, error: "invalid remember-me selection" };
		const value = input as { provider?: unknown; email?: unknown };
		const report = (message: string): void => send(owner.window, "account-status", message);
		try {
			let account: QorperaAccountInfo;
			if (value.provider === "email" && typeof value.email === "string") {
				account = await qorperaAccountAuth.signInWithEmail(value.email, { rememberLocally }, report);
			} else if (value.provider === "github" || value.provider === "google") {
				account = await qorperaAccountAuth.signInWithProvider(
					value.provider as QorperaAccountProvider,
					{ rememberLocally },
					report,
				);
			} else {
				return { ok: false, error: "unsupported Qorpera sign-in provider" };
			}
			rememberAuthenticatedAccount(account);
			await refreshBrokerModels();
			claimExistingCompanies(account);
			if (pendingProfileInvitationId) scheduleProfileInvitationHandoff(owner);
			return { ok: true, account };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			report(message);
			return { ok: false, error: message };
		}
	});
	ipcMain.handle("account:sign-out", async (event) => {
		const owner = slotOf(event.sender);
		if (!owner || !qorperaAccountAuth) {
			return { ok: false, error: "Sign out is unavailable from this window." };
		}
		try {
			const account = await qorperaAccountAuth.signOut();
			const companySlots = [...slots.values()].filter((slot) => slot.runtime);
			const otherCompanySlots = companySlots.filter((slot) => slot !== owner);
			await Promise.all(otherCompanySlots.map((slot) => closeCompany(slot)));
			for (const slot of otherCompanySlots) {
				if (!slot.window.isDestroyed()) slot.window.destroy();
			}
			rememberAuthenticatedAccount(account);
			await refreshBrokerModels();
			if (owner.runtime) await showHub(owner);
			return { ok: true, account };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("feedback:submit", async (event, input: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || !qorperaAccountAuth) {
			return { ok: false, error: "Feedback is unavailable from this window." };
		}
		try {
			const request = parseProductFeedbackRequest(input);
			const profileType = slot.runtime ? profileAttachment(slot.runtime.root).profileType : "none";
			const feedbackId = await qorperaAccountAuth.submitProductFeedback({
				...request,
				diagnostics: request.includeDiagnostics
					? {
							schema: "qorpera.product-feedback-diagnostics/v1",
							appVersion: shellVersion(),
							platform: process.platform,
							architecture: process.arch,
							profileType,
						}
					: {},
			});
			return { ok: true, feedbackId };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("intelligence:info", async (event) => {
		if (!slotOf(event.sender)) return { ready: false, providers: [], requiresChoice: false };
		return verifiedIntelligenceInfo();
	});
	ipcMain.handle("intelligence:configure", (event, providerId: unknown) => {
		if (!slotOf(event.sender) || typeof providerId !== "string") {
			return { ok: false, error: "invalid intelligence provider" };
		}
		return configureIntelligence(event.sender, providerId);
	});
	ipcMain.handle("intelligence:sign-out", (event) => {
		if (!isTrustedHubSender(event.sender)) {
			return { ok: false, error: "Intelligence can only be disconnected from company settings." };
		}
		return signOutIntelligence(event.sender);
	});
	ipcMain.handle("staff:catalog", (event) => (slotOf(event.sender) ? listStaffTemplates() : []));
	ipcMain.handle("companies:list", async (event) => {
		if (!isTrustedProfileSwitcherSender(event.sender)) return [];
		const account = await authenticatedAccount();
		if (!account?.user) return [];
		claimExistingCompanies(account);
		const userId = account.user.id;
		const userData = app.getPath("userData");
		const companies = listCompanies();
		const migrationErrors = new Map<string, string>();
		for (const company of companies) {
			const attachment = profileAttachment(company.root);
			if (attachment.profileType !== "local" || !companyOwnedBy(userData, userId, company.root)) continue;
			try {
				await promoteProfileRoot(company.root, company.name);
			} catch (error) {
				migrationErrors.set(company.root, error instanceof Error ? error.message : String(error));
			}
		}
		const hostedProfiles = await refreshHostedProfiles().catch((error) => {
			console.error(`Cloud profile list refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			return [...hostedProfilesById.values()];
		});
		const incomingInvitations = await qorperaAccountAuth
			?.hostedPrimary()
			.listInvitations()
			.catch((error) => {
				console.error(
					`Cloud invitation list refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				return [];
			});
		const entries = await Promise.all(
			companies.map(async (company) => {
				const attachment = profileAttachment(company.root);
				let access: ProfileAccess | undefined;
				if (attachment.profileType === "cloud") {
					if (!hostedProfilesById.has(attachment.profileId)) return undefined;
					try {
						access = hostedProfileAccess(await refreshHostedTeam(attachment.profileId));
					} catch (error) {
						console.error(
							`Cloud profile access refresh failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						const cached = effectiveHostedTeam(attachment.profileId);
						access = cached ? hostedProfileAccess(cached) : undefined;
					}
				} else {
					if (!companyOwnedBy(userData, userId, company.root)) return undefined;
					access = profileAccessFor(userData, userId, company.root);
				}
				if (!access) return undefined;
				const hosted = hostedProfilesById.get(attachment.profileId);
				return {
					...company,
					...(hosted ? { name: hosted.profileName } : {}),
					id: profileIdentityKey(attachment),
					profileType: attachment.profileType,
					profileId: attachment.profileId,
					product: productContext(),
					promotion: attachment.promotion,
					...(attachment.profileType === "cloud" ? { environmentId: attachment.environmentId } : {}),
					access,
					companyIcon: readCompanyIcon(userData, userId, company.root),
					...(attachment.profileType === "local"
						? {
								migrationRequired: true as const,
								migrationError: migrationErrors.get(company.root) ?? "Cloud migration is waiting to retry.",
							}
						: {}),
				};
			}),
		);
		const attachedProfileIds = new Set(
			companies
				.map((company) => profileAttachment(company.root))
				.filter((attachment) => attachment.profileType === "cloud")
				.map((attachment) => attachment.profileId),
		);
		const availableCloudProfiles = await Promise.all(
			hostedProfiles
				.filter(
					(profile) =>
						!attachedProfileIds.has(profile.profileId) &&
						!readHiddenCloudProfiles(userData, userId).has(profile.profileId),
				)
				.map(async (profile) => {
					try {
						const access = hostedProfileAccess(await refreshHostedTeam(profile.profileId));
						return {
							name: profile.profileName,
							id: profileIdentityKey(profile),
							profileType: profile.profileType,
							profileId: profile.profileId,
							environmentId: profile.environmentId,
							product: productContext(),
							access,
							companyIcon: DEFAULT_COMPANY_ICON_ID,
							setupRequired: true as const,
						};
					} catch (error) {
						console.error(
							`Cloud profile access refresh failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						const cached = effectiveHostedTeam(profile.profileId);
						if (!cached) return undefined;
						return {
							name: profile.profileName,
							id: profileIdentityKey(profile),
							profileType: profile.profileType,
							profileId: profile.profileId,
							environmentId: profile.environmentId,
							product: productContext(),
							access: hostedProfileAccess(cached),
							companyIcon: DEFAULT_COMPANY_ICON_ID,
							setupRequired: true as const,
						};
					}
				}),
		);
		const pendingInvitations = (incomingInvitations ?? []).map((invitation) => ({
			name: invitation.profileName,
			id: `invitation:${invitation.id}`,
			profileType: "cloud" as const,
			profileId: invitation.profileId,
			environmentId: invitation.environmentId,
			product: productContext(),
			invitationId: invitation.id,
			invitationRole: invitation.role,
			invitationPending: true as const,
			expiresAt: invitation.expiresAt,
			companyIcon: DEFAULT_COMPANY_ICON_ID,
		}));
		return [...entries, ...availableCloudProfiles, ...pendingInvitations].filter((entry) => entry !== undefined);
	});
	ipcMain.handle("profile:migrate-local", async (event, root: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof root !== "string") {
			return { ok: false, error: "invalid company migration" };
		}
		const account = await authenticatedAccount();
		const company = listCompanies().find((candidate) => normalizedRoot(candidate.root) === normalizedRoot(root));
		if (!account?.user || !company || !companyOwnedBy(app.getPath("userData"), account.user.id, company.root)) {
			return { ok: false, error: "This company is not available to the signed-in account." };
		}
		try {
			const promoted = await promoteProfileRoot(company.root, company.name);
			return { ok: true, profile: promoted.profile, root: company.root };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile:accept-invitation", async (event, invitationId: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof invitationId !== "string") {
			return { ok: false, error: "invalid profile invitation" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in to accept this invitation." };
		try {
			await primary.acceptInvitation(invitationId);
			await refreshHostedProfiles();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile:list-invitations", async (event) => {
		if (!isTrustedHubSender(event.sender)) return { ok: false, error: "invalid sender" };
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in to see invitations." };
		try {
			return { ok: true, invitations: await primary.listInvitations() };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	// Friends are account-scoped, not profile-scoped: the hub renders the roster
	// and the company window's Team tab invites from it, so both trusted shell
	// surfaces may call these handlers.
	ipcMain.handle("friends:list", async (event) => {
		if (!isTrustedProfileSwitcherSender(event.sender)) return { ok: false, error: "invalid sender" };
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in to see friends." };
		try {
			return { ok: true, friends: await primary.listFriends() };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("friends:request", async (event, email: unknown) => {
		if (!isTrustedProfileSwitcherSender(event.sender) || typeof email !== "string") {
			return { ok: false, error: "invalid friend request" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in to add friends." };
		try {
			return { ok: true, status: await primary.sendFriendRequest(email) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("friends:respond", async (event, userId: unknown, accept: unknown) => {
		if (!isTrustedProfileSwitcherSender(event.sender) || typeof userId !== "string" || typeof accept !== "boolean") {
			return { ok: false, error: "invalid friend response" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in first." };
		try {
			await primary.respondFriendRequest(userId, accept);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("friends:remove", async (event, userId: unknown) => {
		if (!isTrustedProfileSwitcherSender(event.sender) || typeof userId !== "string") {
			return { ok: false, error: "invalid friend removal" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in first." };
		try {
			await primary.removeFriend(userId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile:decline-invitation", async (event, invitationId: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof invitationId !== "string") {
			return { ok: false, error: "invalid profile invitation" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in to decline this invitation." };
		try {
			await primary.declineInvitation(invitationId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile:materialize-cloud", async (event, profileId: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof profileId !== "string") {
			return { ok: false, error: "invalid cloud profile" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		const objects = qorperaAccountAuth?.hostedObjects();
		if (!account?.user || !primary || !objects) {
			return { ok: false, error: "Sign in to set up this cloud profile." };
		}
		try {
			const profile = (await refreshHostedProfiles()).find((candidate) => candidate.profileId === profileId);
			if (!profile) return { ok: false, error: "Cloud profile is not available to this account." };
			const team = await refreshHostedTeam(profile.profileId);
			const access = hostedProfileAccess(team);
			const companyFile = await primary.getCompanyFile(profile.environmentId);
			const existing = listCompanies().find((company) => {
				const attachment = readProfileAttachment(app.getPath("userData"), company.root);
				return attachment?.profileType === "cloud" && attachment.profileId === profile.profileId;
			});
			if (existing) {
				if (companyFile.state === "provisioning" && access.capabilities.write) {
					await checkpointCloudCompanyFile({
						userData: app.getPath("userData"),
						companyRoot: existing.root,
						profileId: profile.profileId,
						environmentId: profile.environmentId,
						primary,
						objects,
						canWrite: access.capabilities.write,
					});
				}
				finishManagedCloudCacheMaterialization(existing.root, profile);
				return { ok: true, root: existing.root };
			}
			const root = cloudCompanyCacheRoot(profile);
			let existingAttachment = readProfileAttachment(app.getPath("userData"), root);
			if (existsSync(root) && isCompanyRoot(root) && !existingAttachment && ownedCloudCacheStaging(root, profile)) {
				attachCloudProfile(app.getPath("userData"), root, {
					profileId: profile.profileId,
					environmentId: profile.environmentId,
				});
				existingAttachment = readProfileAttachment(app.getPath("userData"), root);
			}
			if (existsSync(root)) {
				if (
					isCompanyRoot(root) &&
					existingAttachment?.profileType === "cloud" &&
					existingAttachment.profileId === profile.profileId
				) {
					if (companyFile.state === "provisioning" && !access.capabilities.write) {
						return { ok: false, error: "The Company File is still being prepared by an editor." };
					}
					await checkpointCloudCompanyFile({
						userData: app.getPath("userData"),
						companyRoot: root,
						profileId: profile.profileId,
						environmentId: profile.environmentId,
						primary,
						objects,
						canWrite: access.capabilities.write,
					});
					finishManagedCloudCacheMaterialization(root, profile);
					registerCompany(root);
					return { ok: true, root };
				}
				return {
					ok: false,
					error: `The managed Company File cache path already exists: ${root}`,
				};
			}
			if (!companyFile.headSnapshotId && !access.capabilities.write) {
				return { ok: false, error: "The Company File is still being prepared by its creator." };
			}
			const sourceSnapshot = companyFile.headSnapshotId
				? await primary.getCompanySnapshot(companyFile.headSnapshotId)
				: undefined;
			const materializedRoot = await materializeManagedCloudCache(root, profile, objects, sourceSnapshot);
			attachCloudProfile(app.getPath("userData"), materializedRoot, {
				profileId: profile.profileId,
				environmentId: profile.environmentId,
			});
			if (sourceSnapshot) {
				CloudCompanyFileCacheState.open(
					app.getPath("userData"),
					profile.profileId,
					profile.environmentId,
					materializedRoot,
				).adopt(sourceSnapshot);
			} else {
				await checkpointCloudCompanyFile({
					userData: app.getPath("userData"),
					companyRoot: materializedRoot,
					profileId: profile.profileId,
					environmentId: profile.environmentId,
					primary,
					objects,
					canWrite: true,
				});
			}
			writeCompanyIcon(app.getPath("userData"), account.user.id, materializedRoot, DEFAULT_COMPANY_ICON_ID);
			registerCompany(materializedRoot);
			await new CloudStaffSynchronizer({
				root: materializedRoot,
				userData: app.getPath("userData"),
				profileId: profile.profileId,
				primary,
				canWrite: () => access.capabilities.write,
			}).sync();
			finishManagedCloudCacheMaterialization(materializedRoot, profile);
			return {
				ok: true,
				root: materializedRoot,
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile:leave-cloud", async (event, profileId: unknown, name: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof profileId !== "string") {
			return { ok: false, error: "invalid profile" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in before leaving a company." };
		const owner = BrowserWindow.fromWebContents(event.sender);
		if (!owner) return { ok: false, error: "Company selector is unavailable." };
		const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "this company";
		const confirmation = await dialog.showMessageBox(owner, {
			type: "warning",
			buttons: ["Cancel", "Leave company"],
			defaultId: 0,
			cancelId: 0,
			message: `Leave ${displayName}?`,
			detail:
				"Your membership is removed and the company disappears from your list on every computer. The company itself, its team, and its data stay intact. Rejoining needs a new invitation.",
		});
		if (confirmation.response !== 1) return { ok: false, cancelled: true };
		try {
			await primary.leaveProfile(profileId);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		detachCloudProfileLocally(account.user.id, profileId);
		return { ok: true };
	});
	ipcMain.handle("profile:delete-cloud", async (event, profileId: unknown, name: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof profileId !== "string") {
			return { ok: false, error: "invalid profile" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		if (!account?.user || !primary) return { ok: false, error: "Sign in before deleting a company." };
		const owner = BrowserWindow.fromWebContents(event.sender);
		if (!owner) return { ok: false, error: "Company selector is unavailable." };
		const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "this company";
		const confirmation = await dialog.showMessageBox(owner, {
			type: "warning",
			buttons: ["Cancel", "Delete from cloud"],
			defaultId: 0,
			cancelId: 0,
			message: `Delete ${displayName} from the cloud?`,
			detail:
				"This permanently deletes the cloud profile for every member: the team, its sessions, snapshots, and artifacts. Company folders already on a computer stay on that computer. This cannot be undone.",
		});
		if (confirmation.response !== 1) return { ok: false, cancelled: true };
		try {
			await primary.deleteProfile(profileId);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		detachCloudProfileLocally(account.user.id, profileId);
		return { ok: true };
	});
	ipcMain.handle("company:remove", async (event, root: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof root !== "string" || !root.trim()) {
			return { ok: false, error: "invalid company" };
		}
		if (slotForCompany(root)) {
			return { ok: false, error: "Close this company's window before removing it." };
		}
		const account = await authenticatedAccount();
		if (!account?.user) return { ok: false, error: "Sign in before removing a company." };
		const userData = app.getPath("userData");
		let access: ProfileAccess | undefined;
		try {
			access = await refreshProfileAccess(root);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (!access) return { ok: false, error: "Company is not available to the signed-in account." };
		const company = listCompanies().find((record) => normalizedRoot(record.root) === normalizedRoot(root));
		if (!company) return { ok: false, error: "Company is no longer registered." };
		const attachment = profileAttachment(company.root);
		const owner = BrowserWindow.fromWebContents(event.sender);
		if (!owner) return { ok: false, error: "Company selector is unavailable." };
		const confirmation = await dialog.showMessageBox(owner, {
			type: "warning",
			buttons: ["Cancel", "Remove from Qorpera"],
			defaultId: 0,
			cancelId: 0,
			message: `Remove ${company.name} from Qorpera?`,
			detail:
				attachment.profileType === "cloud"
					? `This removes only this computer's attachment. The cloud profile, team, and company folder at ${company.root} stay intact.`
					: `The company folder and everything in it will stay at ${company.root}. You can open it again later.`,
		});
		if (confirmation.response !== 1) return { ok: false, cancelled: true };
		if (!unregisterCompany(company.root))
			return { ok: false, error: "Qorpera could not update the company selector." };
		forgetCompany(userData, account.user.id, company.root);
		forgetCompanyIcon(userData, account.user.id, company.root);
		if (attachment.profileType === "local") forgetProfile(userData, account.user.id, company.root);
		forgetProfileAttachment(userData, company.root);
		return { ok: true };
	});
	ipcMain.handle("company:open", async (event, root: string) => {
		if (!isTrustedProfileSwitcherSender(event.sender)) return;
		const account = await authenticatedAccount();
		if (!account?.user || !(await refreshProfileAccess(root))) {
			throw new Error("This company is not available to the signed-in Qorpera account.");
		}
		const slot = slotOf(event.sender);
		if (slot) return openCompany(slot, root);
	});
	ipcMain.handle("company:pending-creation", async (event) => {
		if (!isTrustedHubSender(event.sender)) return { ok: false, error: "Company selector is unavailable." };
		const account = await authenticatedAccount();
		if (!account?.user) return { ok: false, error: "Sign in before creating a company." };
		return {
			ok: true,
			pending: readPendingCompanyCreation(app.getPath("userData"), account.user.id),
		};
	});
	ipcMain.handle("company:new", async (event, name: unknown, companyIcon: unknown, clientCreationId: unknown) => {
		if (
			!isTrustedHubSender(event.sender) ||
			typeof name !== "string" ||
			!name.trim() ||
			name.trim().length > 120 ||
			!isCompanyIconId(companyIcon) ||
			typeof clientCreationId !== "string" ||
			!UUID_PATTERN.test(clientCreationId)
		) {
			return { ok: false, error: "invalid company creation" };
		}
		const account = await authenticatedAccount();
		const primary = qorperaAccountAuth?.hostedPrimary();
		const objects = qorperaAccountAuth?.hostedObjects();
		if (!account?.user || !primary || !objects) {
			return { ok: false, error: "Sign in before creating a company." };
		}
		try {
			const userData = app.getPath("userData");
			const pending = readPendingCompanyCreation(userData, account.user.id);
			if (
				pending &&
				(pending.clientCreationId !== clientCreationId ||
					pending.companyName !== name.trim() ||
					pending.companyIcon !== companyIcon)
			) {
				throw new Error("Another company creation is waiting to resume.");
			}
			persistPendingCompanyCreation(userData, account.user.id, {
				schema: "qorpera.pending-company-creation/v1",
				clientCreationId,
				companyName: name.trim(),
				companyIcon,
				createdAt: pending?.createdAt ?? new Date().toISOString(),
			});
			const created = await primary.createCompany({
				clientCreationId,
				companyName: name.trim(),
				contractVersion: 2,
			});
			const root = cloudCompanyCacheRoot(created.profile);
			let existingAttachment = readProfileAttachment(app.getPath("userData"), root);
			if (
				existsSync(root) &&
				isCompanyRoot(root) &&
				!existingAttachment &&
				ownedCloudCacheStaging(root, created.profile)
			) {
				attachCloudProfile(app.getPath("userData"), root, {
					profileId: created.profile.profileId,
					environmentId: created.profile.environmentId,
				});
				existingAttachment = readProfileAttachment(app.getPath("userData"), root);
			}
			if (existsSync(root)) {
				if (
					!isCompanyRoot(root) ||
					existingAttachment?.profileType !== "cloud" ||
					existingAttachment.profileId !== created.profile.profileId
				) {
					throw new Error(`The managed Company File cache path is already in use: ${root}`);
				}
			} else {
				const materializedRoot = await materializeManagedCloudCache(root, created.profile, objects);
				attachCloudProfile(app.getPath("userData"), materializedRoot, {
					profileId: created.profile.profileId,
					environmentId: created.profile.environmentId,
				});
			}
			const checkpoint = await checkpointCloudCompanyFile({
				userData: app.getPath("userData"),
				companyRoot: root,
				profileId: created.profile.profileId,
				environmentId: created.profile.environmentId,
				primary,
				objects,
			});
			if (checkpoint.companyFile.state !== "ready") throw new Error("The Company File was not initialized.");
			hostedProfilesById.set(created.profile.profileId, created.profile);
			const team = await refreshHostedTeam(created.profile.profileId);
			await new CloudStaffSynchronizer({
				root,
				userData: app.getPath("userData"),
				profileId: created.profile.profileId,
				primary,
				canWrite: () => true,
			}).sync();
			finishManagedCloudCacheMaterialization(root, created.profile);
			writeCompanyIcon(app.getPath("userData"), account.user.id, root, companyIcon);
			registerCompany(root);
			rmSync(pendingCompanyCreationPath(userData, account.user.id), { force: true });
			return {
				ok: true,
				root,
				profile: created.profile,
				team,
				companyFile: checkpoint.companyFile,
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company:set-icon", async (event, companyIcon: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (!slot || !root || !isCompanyIconId(companyIcon)) {
			return { ok: false, error: "invalid company picture" };
		}
		const account = await authenticatedAccount();
		if (!account?.user) return { ok: false, error: "Sign in before changing a company picture." };
		try {
			writeCompanyIcon(app.getPath("userData"), account.user.id, root, companyIcon);
			setWindowIcon(slot.window, companyWindowIcon(root));
			return { ok: true, companyIcon };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company-file:open", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		try {
			const attachment = profileAttachment(runtime.root);
			if (attachment.profileType !== "cloud") {
				return { ok: false, error: "This company does not have a cloud Company File." };
			}
			const conflict = readCloudCompanyFileConflict(
				app.getPath("userData"),
				attachment.profileId,
				attachment.environmentId,
				runtime.root,
			);
			if (!runtime.cloudCompanyProjection) {
				const projection = new CloudCompanyProjection({
					companyRoot: runtime.root,
					projectionRoot: cloudCompanyProjectionRoot(app.getPath("userData"), attachment.profileId),
					userData: app.getPath("userData"),
					profileId: attachment.profileId,
					runtimeLock: runtime.runtimeLock,
					canWrite: () => slotHasProfileCapability(slot, "write"),
					onHealth: (projectionHealth) => {
						runtime.cloudCompanyProjectionHealth = projectionHealth;
					},
					onChanged: async () => {
						await enqueueRuntimeTransition(runtime, async () => {
							if (runtime.closing || slot.runtime !== runtime) {
								throw new Error("Company File Explorer import stopped while the company was closing");
							}
							if (runtime.wakeChild || isChildBusy(runtime.child)) {
								throw new Error("Company File Explorer import is waiting for the active agent run to finish");
							}
							const importedPaths = await projection.importChanges();
							await commitCompanyMaterializationAsync(runtime.root, importedPaths);
							runtime.cloudCompanyPublication?.notifyPathChanged();
						});
						const publicationHealth = await runtime.cloudCompanyPublication?.publishNow();
						if (publicationHealth && publicationHealth.phase !== "healthy") {
							throw new Error(
								publicationHealth.lastError ?? "Company File Explorer change did not finish syncing",
							);
						}
					},
				});
				runtime.cloudCompanyProjection = projection;
			}
			await runtime.cloudCompanyProjection.refresh();
			if (!conflict && !runtime.cloudCompanyProjection.hasPendingChanges()) {
				const health = await runtime.cloudCompanyPublication?.publishNow();
				if (health && health.phase !== "healthy") {
					return { ok: false, error: health.lastError ?? "The Company File could not be synchronized." };
				}
			}
			const openError = await electronShell.openPath(runtime.cloudCompanyProjection.path);
			if (openError) throw new Error(openError);
			return {
				ok: true,
				path: runtime.cloudCompanyProjection.path,
				readOnly: !slotHasProfileCapability(slot, "write"),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company-file:open-conflict-remote", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		try {
			const attachment = profileAttachment(runtime.root);
			if (attachment.profileType !== "cloud") throw new Error("This company has no cloud Company File.");
			const conflict = readCloudCompanyFileConflict(
				app.getPath("userData"),
				attachment.profileId,
				attachment.environmentId,
				runtime.root,
			);
			if (!conflict) throw new Error("There is no Company File conflict waiting for review.");
			const primary = qorperaAccountAuth?.hostedPrimary();
			const objects = qorperaAccountAuth?.hostedObjects();
			if (!primary || !objects) throw new Error("Cloud Company File access is unavailable.");
			const snapshot = await primary.getCompanySnapshot(conflict.remoteSnapshotId);
			if (snapshot.environmentId !== attachment.environmentId) {
				throw new Error("The cloud conflict belongs to another company environment.");
			}
			const preview = await previewCloudCompanySnapshot({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				snapshot,
				objects,
			});
			const openError = await electronShell.openPath(preview.path);
			if (openError) throw new Error(openError);
			return { ok: true, path: preview.path };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company-file:resolve-conflict", async (event, resolution: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		if (resolution !== "local" && resolution !== "cloud") {
			return { ok: false, error: "invalid Company File conflict resolution" };
		}
		try {
			const attachment = profileAttachment(runtime.root);
			if (attachment.profileType !== "cloud") throw new Error("This company has no cloud Company File.");
			const primary = qorperaAccountAuth?.hostedPrimary();
			const objects = qorperaAccountAuth?.hostedObjects();
			if (!primary || !objects) throw new Error("Cloud Company File access is unavailable.");
			await enqueueRuntimeTransition(runtime, async () => {
				if (runtime.wakeChild || isChildBusy(runtime.child)) {
					throw new Error("Wait for the active agent run before resolving Company File changes.");
				}
				if (runtime.cloudCompanyProjection?.hasPendingChanges()) {
					throw new Error("Wait for File Explorer changes to finish importing before resolving this conflict.");
				}
				const state = CloudCompanyFileCacheState.open(
					app.getPath("userData"),
					attachment.profileId,
					attachment.environmentId,
					runtime.root,
				);
				const conflict = state.binding.conflict;
				if (!conflict) throw new Error("There is no Company File conflict waiting for review.");
				const companyFile = await primary.getCompanyFile(attachment.environmentId);
				if (companyFile.headSnapshotId !== conflict.remoteSnapshotId) {
					throw new Error("The cloud Company File changed again. Synchronize before choosing a version.");
				}
				const remote = await primary.getCompanySnapshot(conflict.remoteSnapshotId);
				if (resolution === "cloud") {
					await replaceCloudCompanyCacheWithSnapshot({
						companyRoot: runtime.root,
						profileId: attachment.profileId,
						environmentId: attachment.environmentId,
						localTree: conflict.localTree,
						remoteSnapshot: remote,
						conflictPaths: conflict.paths,
						objects,
						runtimeLock: runtime.runtimeLock,
					});
				}
				state.resolveConflictAgainst(remote);
				runtime.cloudCompanyPublication?.notifyPathChanged();
			});
			const health = await runtime.cloudCompanyPublication?.publishNow();
			if (health && health.phase !== "healthy") {
				throw new Error(health.lastError ?? "The reviewed Company File version is waiting to sync.");
			}
			await runtime.cloudCompanyProjection?.refresh();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		"company-file:open-review",
		async (event, checkoutId: unknown, proposalHead: unknown, expectedCanonicalHead: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false, error: "Open a company first." };
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			try {
				const attachment = profileAttachment(runtime.root);
				if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
				const review =
					typeof checkoutId === "string" &&
					typeof proposalHead === "string" &&
					typeof expectedCanonicalHead === "string"
						? findRecoverableCloudCompanyExecution(
								app.getPath("userData"),
								attachment.profileId,
								checkoutId,
								proposalHead,
								expectedCanonicalHead,
							)
						: undefined;
				if (!review || normalizedRoot(review.companyRoot) !== normalizedRoot(runtime.root)) {
					throw new Error("There is no agent work waiting for review.");
				}
				const openError = await electronShell.openPath(review.checkoutRoot);
				if (openError) throw new Error(openError);
				return { ok: true, path: review.checkoutRoot };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle(
		"company-file:accept-review",
		async (event, checkoutId: unknown, proposalHead: unknown, expectedCanonicalHead: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false, error: "Open a company first." };
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			try {
				const attachment = profileAttachment(runtime.root);
				if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
				await enqueueRuntimeTransition(runtime, async () => {
					if (runtime.wakeChild || isChildBusy(runtime.child)) {
						throw new Error("Wait for the active agent run before publishing reviewed work.");
					}
					const review =
						typeof checkoutId === "string" &&
						typeof proposalHead === "string" &&
						typeof expectedCanonicalHead === "string"
							? findRecoverableCloudCompanyExecution(
									app.getPath("userData"),
									attachment.profileId,
									checkoutId,
									proposalHead,
									expectedCanonicalHead,
								)
							: undefined;
					if (!review || normalizedRoot(review.companyRoot) !== normalizedRoot(runtime.root)) {
						throw new Error("There is no agent work waiting for review.");
					}
					if (
						(await cloudCompanyExecutionTouchesAuthorityCritical(review)) &&
						!slotHasProfileCapability(slot, "authorize")
					) {
						throw new Error("Company authority changes require an Owner or Admin reviewer.");
					}
					await acceptReviewedCloudCompanyExecution(review);
					runtime.cloudCompanyPublication?.notifyPathChanged();
				});
				const health = await runtime.cloudCompanyPublication?.publishNow();
				if (health && health.phase !== "healthy") {
					throw new Error(health.lastError ?? "Reviewed work is waiting to sync.");
				}
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle(
		"company-file:reject-review",
		async (event, checkoutId: unknown, proposalHead: unknown, expectedCanonicalHead: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false, error: "Open a company first." };
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			try {
				const attachment = profileAttachment(runtime.root);
				if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
				await enqueueRuntimeTransition(runtime, async () => {
					if (runtime.wakeChild || isChildBusy(runtime.child)) {
						throw new Error("Wait for the active agent run before discarding reviewed work.");
					}
					const review =
						typeof checkoutId === "string" &&
						typeof proposalHead === "string" &&
						typeof expectedCanonicalHead === "string"
							? findRecoverableCloudCompanyExecution(
									app.getPath("userData"),
									attachment.profileId,
									checkoutId,
									proposalHead,
									expectedCanonicalHead,
								)
							: undefined;
					if (!review || normalizedRoot(review.companyRoot) !== normalizedRoot(runtime.root)) {
						throw new Error("There is no agent work waiting for review.");
					}
					await rejectReviewedCloudCompanyExecution(review);
				});
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle("company-file:open-proposal", async (event, proposalId: unknown, proposalSnapshotId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		try {
			const { proposal, attachment } = await exactCompanyProposal(runtime, proposalId, proposalSnapshotId);
			if (proposal.status !== "open") throw new Error("This Company File proposal is no longer awaiting review.");
			const objects = qorperaAccountAuth?.hostedObjects();
			if (!objects) throw new Error("Cloud Company File access is unavailable.");
			const preview = await previewCloudCompanySnapshot({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				snapshot: proposal.proposalSnapshot,
				objects,
			});
			const openError = await electronShell.openPath(preview.path);
			if (openError) throw new Error(openError);
			return { ok: true, path: preview.path };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company-file:accept-proposal", async (event, proposalId: unknown, proposalSnapshotId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		try {
			const { proposal, attachment } = await exactCompanyProposal(runtime, proposalId, proposalSnapshotId);
			if (proposal.status !== "open") throw new Error("This Company File proposal is no longer awaiting review.");
			const waitingReviews = proposal.reviews.filter(
				(review) => review.status === "queued" || review.status === "running",
			);
			const failedReviews = proposal.reviews.filter((review) => review.status === "failed");
			const requestedChanges = proposal.reviews.filter((review) => review.status === "changes_requested");
			if (
				proposal.execution.kind === "run" &&
				proposal.reviewerStaffIds.length > 0 &&
				proposal.reviews.length !== proposal.reviewerStaffIds.length
			) {
				throw new Error("The configured proposal reviews are still being prepared.");
			}
			if (requestedChanges.length === 0 && waitingReviews.length > 0) {
				throw new Error("Wait for the configured agent reviews before publishing this proposal.");
			}
			if (requestedChanges.length === 0 && failedReviews.length > 0) {
				throw new Error("Retry the failed agent review before publishing this proposal.");
			}
			if (runtime.wakeChild || isChildBusy(runtime.child)) {
				throw new Error("Wait for the active agent run before publishing reviewed work.");
			}
			if (runtime.cloudCompanyProjection?.hasPendingChanges()) {
				throw new Error("Wait for File Explorer changes to finish syncing before publishing reviewed work.");
			}
			const before = await runtime.cloudCompanyPublication?.publishNow();
			if (before && before.phase !== "healthy") {
				throw new Error(before.lastError ?? "The current Company File has not finished syncing.");
			}
			const primary = qorperaAccountAuth?.hostedPrimary();
			const objects = qorperaAccountAuth?.hostedObjects();
			if (!primary || !objects) throw new Error("Cloud Company File access is unavailable.");
			let reviewedProposal = proposal;
			const companyFile = await primary.getCompanyFile(attachment.environmentId);
			if (!companyFile.headSnapshotId) throw new Error("The current Company File has no published revision.");
			if (companyFile.headSnapshotId !== proposal.baseSnapshotId || requestedChanges.length > 0) {
				const head = await primary.getCompanySnapshot(companyFile.headSnapshotId);
				const review = await prepareCompanyProposalReview({
					userData: app.getPath("userData"),
					profileId: attachment.profileId,
					environmentId: attachment.environmentId,
					proposal,
					head,
					primary,
					objects,
				});
				if (requestedChanges.length > 0 && !review.existing) {
					const openError = await electronShell.openPath(review.path);
					if (openError) throw new Error(openError);
					return {
						ok: true,
						needsEdits: true,
						path: review.path,
						message: "Make the requested changes inside Company File, then click Submit revision.",
					};
				}
				if (review.hasUnresolvedConflicts) {
					const openError = await electronShell.openPath(review.path);
					if (openError) throw new Error(openError);
					return {
						ok: true,
						needsEdits: true,
						path: review.path,
						message: `Resolve the ${review.conflictCount} conflicting path${review.conflictCount === 1 ? "" : "s"} using Conflict Review, delete each resolved JSON marker, then click Submit revision.`,
					};
				}
				reviewedProposal = await finalizeCompanyProposalReview({
					userData: app.getPath("userData"),
					profileId: attachment.profileId,
					environmentId: attachment.environmentId,
					proposal,
					head,
					primary,
					objects,
				});
				if (reviewedProposal.reviews.some((review) => review.status !== "approved")) {
					return { ok: true, reviewPending: true };
				}
			}
			const acceptedProposal = await primary.acceptCompanyProposal(
				reviewedProposal.proposalId,
				reviewedProposal.proposalSnapshot.snapshotId,
			);
			if (
				acceptedProposal.status !== "accepted" ||
				acceptedProposal.proposalSnapshot.snapshotId !== reviewedProposal.proposalSnapshot.snapshotId
			) {
				throw new Error("The expected Company File proposal revision was not published.");
			}
			runtime.cloudCompanyPublication?.notifyPathChanged();
			const after = await runtime.cloudCompanyPublication?.publishNow();
			if (after && after.phase !== "healthy") {
				throw new Error(after.lastError ?? "The accepted Company File proposal is waiting to synchronize.");
			}
			await resolvePublishedCloudCompanyExecution({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				companyRoot: runtime.root,
				proposalId: acceptedProposal.proposalId,
				proposalSnapshotId: acceptedProposal.proposalSnapshot.snapshotId,
			});
			await discardCompanyProposalReviews(app.getPath("userData"), attachment.profileId, proposal.proposalId);
			await runtime.cloudCompanyProjection?.refresh();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		"company-file:retry-proposal-review",
		async (
			event,
			proposalId: unknown,
			proposalSnapshotId: unknown,
			assignmentId: unknown,
			proposalRevision: unknown,
		) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false, error: "Open a company first." };
			if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
			try {
				if (
					typeof assignmentId !== "string" ||
					typeof proposalRevision !== "number" ||
					!Number.isSafeInteger(proposalRevision)
				) {
					throw new Error("Company proposal review identity is invalid.");
				}
				const { proposal } = await exactCompanyProposal(runtime, proposalId, proposalSnapshotId);
				if (proposal.status !== "open" || proposal.reviewRevision !== proposalRevision) {
					throw new Error("This Company File proposal changed before the review was retried.");
				}
				const review = proposal.reviews.find(
					(candidate) =>
						candidate.assignmentId === assignmentId &&
						candidate.proposalRevision === proposalRevision &&
						candidate.status === "failed",
				);
				if (!review) throw new Error("This failed Company File review is no longer available.");
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud Company File access is unavailable.");
				await primary.retryCompanyProposalReview(review.assignmentId);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle("company-file:reject-proposal", async (event, proposalId: unknown, proposalSnapshotId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		try {
			const { proposal, attachment } = await exactCompanyProposal(runtime, proposalId, proposalSnapshotId);
			if (proposal.status !== "open") throw new Error("This Company File proposal is no longer awaiting review.");
			if (runtime.wakeChild || isChildBusy(runtime.child)) {
				throw new Error("Wait for the active agent run before rejecting reviewed work.");
			}
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("Cloud Company File access is unavailable.");
			const rejectedProposal = await primary.rejectCompanyProposal(
				proposal.proposalId,
				proposal.proposalSnapshot.snapshotId,
			);
			if (
				rejectedProposal.status !== "rejected" ||
				rejectedProposal.proposalSnapshot.snapshotId !== proposal.proposalSnapshot.snapshotId
			) {
				throw new Error("The expected Company File proposal revision was not discarded.");
			}
			await discardCompanyProposalReviews(app.getPath("userData"), attachment.profileId, proposal.proposalId);
			await resolvePublishedCloudCompanyExecution({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				companyRoot: runtime.root,
				proposalId: proposal.proposalId,
				proposalSnapshotId: proposal.proposalSnapshot.snapshotId,
			});
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		"company-file:comment-proposal",
		async (event, proposalId: unknown, body: unknown, clientCommentId: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false, error: "Open a company first." };
			try {
				if (typeof proposalId !== "string" || typeof body !== "string" || typeof clientCommentId !== "string") {
					throw new Error("Company proposal comment is invalid.");
				}
				const attachment = profileAttachment(runtime.root);
				if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud Company File access is unavailable.");
				const proposal = await primary.getCompanyProposal(proposalId);
				if (proposal.environmentId !== attachment.environmentId)
					throw new Error("Company proposal is unavailable.");
				const comment = await primary.appendCompanyProposalComment(proposalId, clientCommentId, body);
				return { ok: true, comment };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle("company-file:proposal-comments", async (event, proposalId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "Open a company first." };
		try {
			if (typeof proposalId !== "string") throw new Error("Company proposal identity is invalid.");
			const attachment = profileAttachment(runtime.root);
			if (attachment.profileType !== "cloud") throw new Error("This company has no cloud review queue.");
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("Cloud Company File access is unavailable.");
			const proposal = await primary.getCompanyProposal(proposalId);
			if (proposal.environmentId !== attachment.environmentId) throw new Error("Company proposal is unavailable.");
			return { ok: true, comments: (await primary.listCompanyProposalComments(proposalId)).items };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("company:product-add", async (event, product: string, from?: string) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (
			!slot ||
			!runtime ||
			typeof product !== "string" ||
			!product.trim() ||
			Buffer.byteLength(product, "utf-8") > 256 ||
			(from !== undefined && (typeof from !== "string" || Buffer.byteLength(from, "utf-8") > 8192))
		)
			return { ok: false, error: "invalid product transaction" };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || isChildBusy(runtime.child)) {
				return { ok: false, error: "company runtime is not available" };
			}
			const departmentId = productDepartmentId(product.trim());
			const previousChild = runtime.child;
			const options = {
				...runtime.childOptions,
				sessionFile: previousChild
					? (childBindings.get(previousChild)?.file ?? runtime.childOptions.sessionFile)
					: runtime.childOptions.sessionFile,
			};
			const storage = captureProductTransactionStorage(runtime.root);
			const approved = await confirmKernelReview(slot.window, {
				title: "Add product-development department",
				summary: "Run this exact product-registration transaction?",
				exactText: product.trim(),
				metadata: [
					`Company: ${storage.root.path}`,
					`Target: ${resolve(storage.departments.path, departmentId)}`,
					`Source repository: ${from?.trim() || "none (department only)"}`,
				].join("\n"),
			});
			if (!approved || slot.runtime !== runtime || runtime.closing) {
				return { ok: false, error: approved ? "company runtime changed" : "cancelled" };
			}
			runtime.inventoryWatcher?.close();
			runtime.inventoryWatcher = undefined;
			if (previousChild) await stopChild(previousChild);
			let department: ProductDepartment | undefined;
			let failure: Error | undefined;
			try {
				if (from?.trim()) {
					const integrated = integrateRepoWithRuntimeLock(
						runtime.root,
						from.trim(),
						product.trim(),
						runtime.runtimeLock,
						storage,
					);
					if (!integrated) throw new Error("could not clone the product source repository");
					department = integrated;
				} else {
					department = scaffoldProductDepartmentWithRuntimeLock(
						runtime.root,
						product.trim(),
						runtime.runtimeLock,
						storage,
					);
				}
				readProductProtectionInventory(runtime.root);
				reconcileCompanyProductStorage(
					app.getPath("userData"),
					runtime.root,
					readProductStorageExpectations(runtime.root),
					false,
				);
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				try {
					readProductProtectionInventory(runtime.root);
				} catch (restartError) {
					console.error(`product transaction cleanup failed: ${(restartError as Error).message}`);
				}
			}
			let watcher: ReturnType<typeof watch> | undefined;
			try {
				watcher = watch(join(runtime.root, ".qorpera"), { persistent: false }, (_event, file) => {
					if (file?.toString() === "products.json") restartForProductInventory(slot, runtime);
				});
			} catch (error) {
				failure ??= error instanceof Error ? error : new Error(String(error));
			}
			const restored = previousChild
				? await restoreAttendedChild(slot, runtime, options, "product-transaction agent runtime restore failed")
				: true;
			if (restored && watcher) runtime.inventoryWatcher = watcher;
			else watcher?.close();
			if (!restored) failure ??= new Error("the agent runtime could not be restored");
			if (!watcher) failure ??= new Error("the product inventory watcher could not be restored");
			return failure ? { ok: false, error: failure.message } : { ok: true, department: department! };
		});
	});
	ipcMain.handle("company:product-source-choose", async (event) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime) return { ok: false };
		const picked = await dialog.showOpenDialog(slot.window, {
			title: "Choose a local product repository",
			properties: ["openDirectory"],
		});
		const path = picked.filePaths[0];
		return picked.canceled || !path ? { ok: false } : { ok: true, path };
	});
	ipcMain.handle("company:scheduled-job-create", async (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || !value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "invalid scheduled job" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		const input = value as Record<string, unknown>;
		const publication = parsedRoutinePublicationPolicy(runtime.root, input.publication);
		if (
			typeof input.title !== "string" ||
			typeof input.prompt !== "string" ||
			!Array.isArray(input.triggers) ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			(input.effort !== undefined && !SCHEDULED_JOB_EFFORTS.includes(input.effort as ScheduledJobEffort)) ||
			(input.placement !== undefined && !ROUTINE_PLACEMENTS.includes(input.placement as RoutinePlacement)) ||
			(input.staffAgentId !== undefined && typeof input.staffAgentId !== "string") ||
			publication === null ||
			Object.keys(input).some(
				(key) =>
					![
						"title",
						"prompt",
						"triggers",
						"enabled",
						"effort",
						"placement",
						"staffAgentId",
						"publication",
					].includes(key),
			)
		) {
			return { ok: false, error: "invalid scheduled job" };
		}
		const assignedStaff =
			typeof input.staffAgentId === "string" ? activeStaffAgent(runtime.root, input.staffAgentId) : undefined;
		if (typeof input.staffAgentId === "string" && !assignedStaff) {
			return { ok: false, error: "scheduled-job staff member is unavailable or archived" };
		}
		const triggers = input.triggers as RoutineTriggerInput[];
		if (triggers.some((trigger) => trigger && typeof trigger === "object" && trigger.kind === "github")) {
			const github = await readGitHubCliStatus();
			if (!github.connected) return { ok: false, error: "Connect GitHub before activating a GitHub trigger." };
		}
		try {
			return {
				ok: true,
				job: createScheduledJob(runtime.root, {
					title: input.title,
					prompt: input.prompt,
					triggers,
					...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
					...(typeof input.effort === "string" ? { effort: input.effort as ScheduledJobEffort } : {}),
					...(typeof input.placement === "string" ? { placement: input.placement as RoutinePlacement } : {}),
					...(publication ? { publication } : {}),
					...(assignedStaff ? { staffAgentId: assignedStaff.id } : {}),
				}),
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
	ipcMain.handle("company:scheduled-job-update", async (event, id: unknown, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof id !== "string" || !value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "invalid scheduled-job update" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		const input = value as Record<string, unknown>;
		const publication = parsedRoutinePublicationPolicy(runtime.root, input.publication);
		if (
			(input.title !== undefined && typeof input.title !== "string") ||
			(input.prompt !== undefined && typeof input.prompt !== "string") ||
			(input.triggers !== undefined && !Array.isArray(input.triggers)) ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			(input.effort !== undefined && !SCHEDULED_JOB_EFFORTS.includes(input.effort as ScheduledJobEffort)) ||
			(input.placement !== undefined && !ROUTINE_PLACEMENTS.includes(input.placement as RoutinePlacement)) ||
			(input.staffAgentId !== undefined && input.staffAgentId !== null && typeof input.staffAgentId !== "string") ||
			publication === null ||
			Object.keys(input).some(
				(key) =>
					![
						"title",
						"prompt",
						"triggers",
						"enabled",
						"effort",
						"placement",
						"staffAgentId",
						"publication",
					].includes(key),
			)
		) {
			return { ok: false, error: "invalid scheduled-job update" };
		}
		const current = readScheduledJobs(runtime.root).find((job) => job.id === id);
		if (!current) return { ok: false, error: "scheduled job not found" };
		const assignedStaffId =
			input.staffAgentId === null
				? undefined
				: typeof input.staffAgentId === "string"
					? input.staffAgentId
					: current.staffAgentId;
		const assignedStaff = assignedStaffId ? activeStaffAgent(runtime.root, assignedStaffId) : undefined;
		if (assignedStaffId && !assignedStaff) {
			return { ok: false, error: "scheduled-job staff member is unavailable or archived" };
		}
		const triggers = input.triggers === undefined ? undefined : (input.triggers as RoutineTriggerInput[]);
		if (triggers?.some((trigger) => trigger && typeof trigger === "object" && trigger.kind === "github")) {
			const github = await readGitHubCliStatus();
			if (!github.connected) return { ok: false, error: "Connect GitHub before activating a GitHub trigger." };
		}
		try {
			return {
				ok: true,
				job: updateScheduledJob(runtime.root, id, {
					...(typeof input.title === "string" ? { title: input.title } : {}),
					...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
					...(triggers ? { triggers } : {}),
					...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
					...(typeof input.effort === "string" ? { effort: input.effort as ScheduledJobEffort } : {}),
					...(typeof input.placement === "string" ? { placement: input.placement as RoutinePlacement } : {}),
					...(publication ? { publication } : {}),
					...(input.staffAgentId === null
						? { staffAgentId: null }
						: typeof input.staffAgentId === "string"
							? { staffAgentId: input.staffAgentId }
							: {}),
				}),
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
	ipcMain.handle("company:scheduled-job-delete", async (event, id: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof id !== "string") return { ok: false, error: "invalid scheduled job" };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		const job = readScheduledJobs(runtime.root).find((candidate) => candidate.id === id);
		if (!job) return { ok: false, error: "scheduled job not found" };
		if (runtime.wakeJobId === id) return { ok: false, error: "scheduled job is running" };
		const confirmation = await dialog.showMessageBox(slot.window, {
			type: "warning",
			buttons: ["Cancel", "Delete scheduled job"],
			defaultId: 0,
			cancelId: 0,
			message: `Delete “${job.title}”?`,
			detail:
				"Its trail runs remain in the company. The recurring definition and local run state will stop being shown.",
		});
		if (confirmation.response !== 1) return { ok: false, error: "cancelled" };
		const deleted = deleteScheduledJob(runtime.root, id);
		if (deleted) {
			const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
			writeWakeRunState(statePath, removeScheduledJobRunState(readWakeRunState(statePath), id));
		}
		return { ok: deleted };
	});
	ipcMain.handle("company:scheduled-job-run", (event, id: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof id !== "string") return { ok: false, error: "invalid scheduled job" };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild) {
				return { ok: false, error: "company runtime is busy" };
			}
			const job = readScheduledJobs(runtime.root).find((candidate) => candidate.id === id);
			if (!job) return { ok: false, error: "scheduled job not found" };
			if (job.placement === "cloud") {
				return {
					ok: false,
					error: "This routine is placed in the cloud; hosted routine execution is not available yet.",
				};
			}
			return (await startWakeChildExclusive(slot, runtime, "schedule", 0, job, true))
				? { ok: true }
				: { ok: false, error: "company runtime is busy" };
		});
	});
	ipcMain.handle("company:close", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return closeCompany(slot);
	});
	ipcMain.handle(
		"chat:open",
		(event, sessionFile: string | null, department?: string, worktree?: string, sessionName?: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (!slot || !runtime) return { ok: false };
			if (sessionFile === null && !slotHasProfileCapability(slot, "write")) {
				return profilePermissionError("write");
			}
			if ((department || worktree) && !slotHasProfileCapability(slot, "authorize")) {
				return profilePermissionError("authorize");
			}
			if (
				sessionName !== undefined &&
				(typeof sessionName !== "string" ||
					!sessionName.trim() ||
					Buffer.byteLength(sessionName, "utf-8") > 512 ||
					/[\r\n]/.test(sessionName))
			) {
				return { ok: false, error: "invalid session name" };
			}
			if (sessionName !== undefined && sessionFile !== null) {
				return { ok: false, error: "only a fresh session can receive an initial name" };
			}
			return enqueueRuntimeTransition(runtime, () => {
				if (slot.runtime !== runtime || runtime.closing) return Promise.resolve({ ok: false });
				if (isChildBusy(runtime.child)) {
					return Promise.resolve({
						ok: false,
						error: "the agent is still working — stop it before switching conversations",
					});
				}
				// A dead click during autonomous work must say so — the founder is
				// otherwise left staring at a pane that "won't load".
				if (runtime.wakeChild) {
					return Promise.resolve({
						ok: false,
						error: runtime.roomDelivery
							? "a group chat is answering — watch it in the room, or try again once it settles"
							: "autonomous work is running — watch it under Agents, or try again once it settles",
					});
				}
				return openChat(slot, sessionFile, department, worktree, sessionName);
			});
		},
	);
	ipcMain.handle("staff:create", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot) return { ok: false, error: "untrusted staff creation request" };
		return slotHasProfileCapability(slot, "write") ? createStaffMember(slot, value) : profilePermissionError("write");
	});
	ipcMain.handle("staff:bootstrap", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot) return { ok: false, error: "untrusted staff bootstrap request" };
		return slotHasProfileCapability(slot, "write")
			? bootstrapStaffTeam(slot, value)
			: profilePermissionError("write");
	});
	ipcMain.handle("staff:update", (event, staffAgentId: unknown, value: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		return updateStaffMember(slot, staffAgentId, value);
	});
	ipcMain.handle("staff:archive", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return archiveStaffMember(slot, staffAgentId);
	});
	ipcMain.handle("staff:delete", (event, staffAgentId: unknown, options: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		if (
			!options ||
			typeof options !== "object" ||
			Array.isArray(options) ||
			Object.keys(options).length !== 1 ||
			!("keepArtifacts" in options) ||
			typeof options.keepArtifacts !== "boolean"
		) {
			return { ok: false, error: "invalid staff deletion options" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return permanentlyDeleteStaffMember(slot, staffAgentId, options.keepArtifacts);
	});
	ipcMain.handle("staff:restore", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		return restoreStaffMember(slot, staffAgentId);
	});
	ipcMain.handle("staff:open", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		return openStaffMember(slot, staffAgentId);
	});
	ipcMain.handle("staff:copy-conversation-id", (event, staffAgentId: unknown) => {
		const runtime = slotOf(event.sender)?.runtime;
		if (!runtime || typeof staffAgentId !== "string") {
			return { ok: false, error: "invalid conversation identity" };
		}
		const staff = activeStaffAgent(runtime.root, staffAgentId);
		if (!staff) return { ok: false, error: "staff conversation is unavailable" };
		clipboard.writeText(staff.id);
		return { ok: true, conversationId: staff.id };
	});
	ipcMain.handle("staff:intro-ready", (event, staffAgentId: unknown, trailFile: unknown, retry: unknown = false) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string" || typeof trailFile !== "string" || typeof retry !== "boolean") {
			return { ok: false, error: "invalid staff introduction target" };
		}
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		return staffIntroReady(slot, staffAgentId, trailFile, retry);
	});
	ipcMain.handle("room:create", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, error: "open a company before creating a group chat" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		const input = recordValue(value);
		if (
			!input ||
			!Array.isArray(input.participantIds) ||
			(input.title !== undefined && typeof input.title !== "string") ||
			Object.keys(input).some((key) => key !== "participantIds" && key !== "title")
		) {
			return { ok: false, error: "invalid group chat" };
		}
		try {
			if (input.participantIds.some((id) => typeof id !== "string" || !activeStaffAgent(runtime.root, id))) {
				return { ok: false, error: "every group participant must be an active staff agent" };
			}
			const room = createCompanyRoom(runtime.root, {
				participantIds: input.participantIds as string[],
				...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}),
			});
			commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			return { ok: true, room };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("room:open", (event, roomId: unknown) => {
		const runtime = slotOf(event.sender)?.runtime;
		if (!runtime || typeof roomId !== "string") return { ok: false, error: "invalid group chat" };
		try {
			const room = readCompanyRoom(runtime.root, roomId);
			if (!room) return { ok: false, error: "this group chat no longer exists" };
			return {
				ok: true,
				room,
				messages: readCompanyRoomMessages(runtime.root, room.id),
				deliveries: readQueuedCompanyRoomDeliveries(runtime.root, room.id),
				// Rehydrates the live participant state after a renderer reload.
				...(runtime.roomDelivery?.roomId === room.id
					? { activity: { staffAgentId: runtime.roomDelivery.staffAgentId, activity: "working" } }
					: {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("room:send", (event, roomId: unknown, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof roomId !== "string") return { ok: false, error: "invalid group chat" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		const input = recordValue(value);
		if (!input || Object.keys(input).some((key) => !["text", "images", "targetStaffAgentIds"].includes(key))) {
			return { ok: false, error: "invalid group message" };
		}
		try {
			const room = readCompanyRoom(runtime.root, roomId);
			if (!room || room.status !== "active") return { ok: false, error: "this group chat is not active" };
			const message = appendCompanyRoomMessage(runtime.root, room.id, {
				speaker: { kind: "founder" },
				...(input.text !== undefined ? { text: input.text as string } : {}),
				...(input.images !== undefined ? { images: input.images as { mimeType: string; data: string }[] } : {}),
				...(input.targetStaffAgentIds !== undefined
					? { targetStaffAgentIds: input.targetStaffAgentIds as string[] }
					: {}),
			});
			let delivery: QueuedCompanyRoomDelivery | undefined;
			let deliveryError: string | undefined;
			try {
				delivery = queueCompanyRoomDelivery(runtime.root, room.id, {
					messageId: message.id,
					// Archived members can stay in participantIds; only active staff
					// can ever be served, so a default broadcast targets just them.
					targetStaffAgentIds:
						message.targetStaffAgentIds ??
						room.participantIds.filter((id) => activeStaffAgent(runtime.root, id) !== undefined),
				});
			} catch (error) {
				// The founder message is already durable in the transcript; failing
				// the whole send would invite a duplicate resend of the same text.
				deliveryError = error instanceof Error ? error.message : String(error);
			}
			commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			sendRoomEvent(slot, { kind: "message", roomId: room.id, message });
			if (delivery) {
				sendRoomEvent(slot, { kind: "delivery", roomId: room.id, delivery });
				scheduleRoomDeliveryPump(slot, runtime);
			} else if (deliveryError) {
				sendRoomEvent(slot, {
					kind: "error",
					roomId: room.id,
					message: `The message was saved, but delivery could not be queued: ${deliveryError}`,
				});
			}
			return { ok: true, message, ...(delivery ? { delivery } : {}), ...(deliveryError ? { deliveryError } : {}) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("room:update", (event, roomId: unknown, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof roomId !== "string") return { ok: false, error: "invalid group chat" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		const input = recordValue(value);
		if (
			!input ||
			!Object.keys(input).length ||
			Object.keys(input).some((key) => key !== "participantIds" && key !== "title")
		) {
			return { ok: false, error: "invalid group chat update" };
		}
		try {
			if (
				Array.isArray(input.participantIds) &&
				input.participantIds.some((id) => typeof id !== "string" || !activeStaffAgent(runtime.root, id))
			) {
				return { ok: false, error: "every group participant must be an active staff agent" };
			}
			const room = updateCompanyRoom(runtime.root, roomId, input);
			// Membership edits prune queued deliveries for removed participants;
			// the module drops targets that are no longer in the room.
			for (const delivery of readQueuedCompanyRoomDeliveries(runtime.root, room.id)) {
				if (delivery.targetStaffAgentIds.some((id) => !room.participantIds.includes(id))) {
					rescheduleCompanyRoomDelivery(runtime.root, delivery.id, delivery.targetStaffAgentIds, undefined, {
						preserveAttempts: true,
					});
				}
			}
			commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			sendRoomEvent(slot, { kind: "room", roomId: room.id, room });
			return { ok: true, room };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("room:archive", (event, roomId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof roomId !== "string") return { ok: false, error: "invalid group chat" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		try {
			removeQueuedCompanyRoomDeliveries(runtime.root, roomId);
			const room = archiveCompanyRoom(runtime.root, roomId);
			commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			sendRoomEvent(slot, { kind: "room", roomId: room.id, room });
			return { ok: true, room };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("room:restore", (event, roomId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof roomId !== "string") return { ok: false, error: "invalid group chat" };
		if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
		try {
			const room = restoreCompanyRoom(runtime.root, roomId);
			commitCompanyMaterialization(runtime.root, roomMaterializationPaths(room.id));
			sendRoomEvent(slot, { kind: "room", roomId: room.id, room });
			return { ok: true, room };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("hub:show", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return showHub(slot);
	});
	ipcMain.on("settings:overlay", (event, active: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof active !== "boolean") return;
		setSettingsTitleBarOverlay(slot.window, active);
	});
	ipcMain.handle("settings:sidebar-translucency", (event, enabled: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof enabled !== "boolean") {
			return { ok: false, error: "invalid sidebar translucency preference" };
		}
		if (!writeSidebarTranslucency(app.getPath("userData"), enabled)) {
			return { ok: false, error: "Sidebar translucency preference could not be saved." };
		}
		for (const current of slots.values()) {
			if (process.platform === "darwin" && !current.window.isDestroyed()) {
				current.window.setBackgroundColor(enabled ? "#00ffffff" : "#ffffff");
				current.window.setVibrancy(enabled ? "sidebar" : null);
			}
			send(current.window, "sidebar-translucency", enabled);
		}
		return { ok: true, enabled };
	});
	ipcMain.handle("profile-team:invite", async (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (!slot || !root || !currentQorperaAccountId || !value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "invalid profile invitation" };
		}
		const input = value as { email?: unknown; role?: unknown };
		if (
			typeof input.email !== "string" ||
			!PROFILE_MEMBER_ROLES.some((role) => role === input.role) ||
			Object.keys(input).some((key) => key !== "email" && key !== "role")
		) {
			return { ok: false, error: "invalid profile invitation" };
		}
		try {
			const attachment = profileAttachment(root);
			if (attachment.profileType === "cloud") {
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud profile access is unavailable.");
				const invitation = await primary.inviteMember(
					attachment.profileId,
					input.email,
					input.role as ProfileMemberRole,
				);
				await refreshHostedTeam(attachment.profileId);
				return { ok: true, invitation };
			}
			const invitation = inviteProfileMember(
				app.getPath("userData"),
				currentQorperaAccountId,
				root,
				input.email,
				input.role as ProfileMemberRole,
			);
			return { ok: true, invitation };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile-team:cancel-invitation", async (event, invitationId: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (!slot || !root || !currentQorperaAccountId || typeof invitationId !== "string") {
			return { ok: false, error: "invalid profile invitation" };
		}
		try {
			const attachment = profileAttachment(root);
			if (attachment.profileType === "cloud") {
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud profile access is unavailable.");
				await primary.cancelInvitation(attachment.profileId, invitationId);
				await refreshHostedTeam(attachment.profileId);
				return { ok: true };
			}
			cancelProfileInvitation(app.getPath("userData"), currentQorperaAccountId, root, invitationId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile-team:retry-invitation-delivery", async (event, invitationId: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (!slot || !root || !currentQorperaAccountId || typeof invitationId !== "string") {
			return { ok: false, error: "invalid profile invitation" };
		}
		try {
			const attachment = profileAttachment(root);
			if (attachment.profileType !== "cloud") {
				throw new Error("Email delivery is only available for cloud profiles.");
			}
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!primary) throw new Error("Cloud profile access is unavailable.");
			const delivery = await primary.retryInvitationDelivery(attachment.profileId, invitationId);
			await refreshHostedTeam(attachment.profileId);
			return { ok: true, delivery };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile-team:update-role", async (event, memberUserId: unknown, role: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (
			!slot ||
			!root ||
			!currentQorperaAccountId ||
			typeof memberUserId !== "string" ||
			!PROFILE_MEMBER_ROLES.some((candidate) => candidate === role)
		) {
			return { ok: false, error: "invalid profile member update" };
		}
		try {
			const attachment = profileAttachment(root);
			if (attachment.profileType === "cloud") {
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud profile access is unavailable.");
				const member = await primary.updateMemberRole(
					attachment.profileId,
					memberUserId,
					role as ProfileMemberRole,
				);
				await refreshHostedTeam(attachment.profileId);
				return { ok: true, member };
			}
			const member = updateProfileMemberRole(
				app.getPath("userData"),
				currentQorperaAccountId,
				root,
				memberUserId,
				role as ProfileMemberRole,
			);
			return { ok: true, member };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("profile-team:remove-member", async (event, memberUserId: unknown) => {
		const slot = slotOf(event.sender);
		const root = slot?.runtime?.root;
		if (!slot || !root || !currentQorperaAccountId || typeof memberUserId !== "string") {
			return { ok: false, error: "invalid profile member" };
		}
		try {
			const attachment = profileAttachment(root);
			if (attachment.profileType === "cloud") {
				const primary = qorperaAccountAuth?.hostedPrimary();
				if (!primary) throw new Error("Cloud profile access is unavailable.");
				await primary.removeMember(attachment.profileId, memberUserId);
				await refreshHostedTeam(attachment.profileId);
				return { ok: true };
			}
			removeProfileMember(app.getPath("userData"), currentQorperaAccountId, root, memberUserId);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("native-execution:info", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const attachment = runtime ? profileAttachment(runtime.root) : undefined;
		if (!slot || !runtime || attachment?.profileType !== "cloud" || !qorperaAccountAuth) {
			return { ok: false, error: "Native cloud execution is available only inside a cloud company." };
		}
		try {
			return {
				ok: true,
				profileId: attachment.profileId,
				...(await qorperaAccountAuth.nativeSubscriptionControl().listConnections(attachment.profileId)),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("native-execution:create-member-identity", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const attachment = runtime ? profileAttachment(runtime.root) : undefined;
		const account = await authenticatedAccount();
		if (!slot || !runtime || attachment?.profileType !== "cloud" || !qorperaAccountAuth || !account?.user) {
			return { ok: false, error: "A signed-in cloud company is required." };
		}
		try {
			const control = qorperaAccountAuth.nativeSubscriptionControl();
			const existing = await control.listConnections(attachment.profileId);
			const computeIdentity =
				existing.computeIdentity ??
				(await control.createMemberComputeIdentity({
					profileId: attachment.profileId,
					displayName: `${account.user.displayName}'s cloud computer`,
					policy: {
						credentialExport: false,
						operatorBlindnessClaimed: false,
					},
				}));
			return { ok: true, computeIdentity };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("native-execution:begin-login", async (event, provider: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const attachment = runtime ? profileAttachment(runtime.root) : undefined;
		const account = await authenticatedAccount();
		if (
			!slot ||
			!runtime ||
			attachment?.profileType !== "cloud" ||
			!qorperaAccountAuth ||
			!account?.user ||
			(provider !== "openai" && provider !== "anthropic")
		) {
			return { ok: false, error: "Native provider login request is invalid." };
		}
		try {
			const bridge = qorperaAccountAuth.nativeProviderIdentityBridge();
			const control = qorperaAccountAuth.nativeSubscriptionControl();
			const existing = await control.listConnections(attachment.profileId);
			const computeIdentity =
				existing.computeIdentity ??
				(await control.createMemberComputeIdentity({
					profileId: attachment.profileId,
					displayName: `${account.user.displayName}'s cloud computer`,
					policy: {
						credentialExport: false,
						operatorBlindnessClaimed: false,
					},
				}));
			const authorization = await control.beginNativeProviderLogin({
				profileId: attachment.profileId,
				computeIdentityId: computeIdentity.computeIdentityId,
				provider,
				nativeHarness: provider === "openai" ? "codex-cli" : "claude-code",
			});
			const login = await bridge.beginLogin(authorization);
			if (login.interactionUrl) await electronShell.openExternal(login.interactionUrl);
			return {
				ok: true,
				login: {
					loginId: login.loginId,
					status: login.status,
					...(login.userCode ? { userCode: login.userCode } : {}),
					expiresAt: authorization.expiresAt,
				},
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		"native-execution:create-member-sponsor",
		async (event, providerConnectionId: unknown, providerConnectionVersion: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			const attachment = runtime ? profileAttachment(runtime.root) : undefined;
			if (
				!slot ||
				!runtime ||
				attachment?.profileType !== "cloud" ||
				!qorperaAccountAuth ||
				typeof providerConnectionId !== "string" ||
				!UUID_PATTERN.test(providerConnectionId) ||
				!Number.isSafeInteger(providerConnectionVersion) ||
				(providerConnectionVersion as number) < 1
			) {
				return { ok: false, error: "Native sponsor request is invalid." };
			}
			try {
				const control = qorperaAccountAuth.nativeSubscriptionControl();
				const available = await control.listConnections(attachment.profileId);
				const connection = available.connections.find(
					(item) =>
						item.connectionId === providerConnectionId && item.connectionVersion === providerConnectionVersion,
				);
				if (
					!available.computeIdentity ||
					!connection ||
					connection.connectionStatus !== "active" ||
					connection.authorizationState !== "active" ||
					connection.policy.implementationStatus !== "supported" ||
					connection.policy.enablementStatus !== "enabled"
				) {
					throw new Error("This native provider connection is not available for execution.");
				}
				const sponsor = connection.sponsorBindingId
					? { bindingId: connection.sponsorBindingId, version: connection.sponsorVersion }
					: await control.createMemberSponsor({
							profileId: attachment.profileId,
							clientBindingId: connection.connectionId,
							providerConnectionId: connection.connectionId,
							providerConnectionVersion: connection.connectionVersion,
						});
				if (!sponsor.version) throw new Error("Native sponsor version is unavailable.");
				return { ok: true, sponsor };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle("native-execution:revoke", async (event, providerConnectionId: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const attachment = runtime ? profileAttachment(runtime.root) : undefined;
		if (
			!slot ||
			!runtime ||
			attachment?.profileType !== "cloud" ||
			!qorperaAccountAuth ||
			typeof providerConnectionId !== "string" ||
			!UUID_PATTERN.test(providerConnectionId)
		) {
			return { ok: false, error: "Native connection revocation is invalid." };
		}
		try {
			const result = await qorperaAccountAuth.nativeSubscriptionControl().revokeConnection({
				profileId: attachment.profileId,
				providerConnectionId,
			});
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("native-execution:session-provenance", async (event, staffAgentId: unknown) => {
		const runtime = slotOf(event.sender)?.runtime;
		const arbiter = runtime?.cloudSessionArbiter;
		const ref = typeof staffAgentId === "string" ? arbiter?.sessionForStaff(staffAgentId) : undefined;
		if (!runtime || !ref || !qorperaAccountAuth) return { ok: true, provenance: [] };
		try {
			return {
				ok: true,
				provenance: await qorperaAccountAuth
					.nativeSubscriptionControl()
					.listSessionTurnProvenance(ref.hostedSessionId, 100),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("settings:info", async (event) => {
		const slot = slotOf(event.sender);
		const account = await authenticatedAccount();
		const root = slot?.runtime?.root;
		const attachment = root ? profileAttachment(root) : undefined;
		let team: HostedProfileTeam | ReturnType<typeof profileTeamInfo> | undefined;
		let access: ProfileAccess | undefined;
		let hostedProfile: HostedProfile | undefined;
		let companyFile: HostedCompanyFile | undefined;
		let accountEntitlement: HostedAccountEntitlement | undefined;
		let companyProposals: HostedCompanyProposal[] = [];
		let settingsRefreshError: string | undefined;
		let nativeExecution:
			| Awaited<ReturnType<ReturnType<QorperaAccountAuth["nativeSubscriptionControl"]>["listConnections"]>>
			| undefined;
		if (root && attachment && account?.user) {
			if (attachment.profileType === "cloud") {
				try {
					await refreshHostedProfiles();
					hostedProfile = hostedProfilesById.get(attachment.profileId);
					team = await refreshHostedTeam(attachment.profileId);
					access = hostedProfileAccess(team);
					const primary = qorperaAccountAuth?.hostedPrimary();
					accountEntitlement = await primary?.getAccountEntitlement();
					companyFile = await primary?.getCompanyFile(attachment.environmentId);
					companyProposals =
						(await primary?.listCompanyProposals(attachment.environmentId, "open", 100))?.items ?? [];
					nativeExecution = await qorperaAccountAuth
						?.nativeSubscriptionControl()
						.listConnections(attachment.profileId);
				} catch (error) {
					settingsRefreshError = error instanceof Error ? error.message : String(error);
					console.error(`Cloud profile settings refresh failed: ${settingsRefreshError}`);
					hostedProfile = hostedProfilesById.get(attachment.profileId);
					team = effectiveHostedTeam(attachment.profileId);
					access = team ? hostedProfileAccess(team) : undefined;
				}
			} else {
				team = profileTeamInfo(app.getPath("userData"), account.user.id, root);
				access = team ?? activeProfileAccess(root);
			}
		}
		const filePublication = slot?.runtime?.cloudCompanyPublication;
		const fileHealth = slot?.runtime?.cloudCompanyPublicationHealth;
		const projectionHealth = slot?.runtime?.cloudCompanyProjectionHealth;
		const fileCheckpoint = filePublication?.lastCheckpoint();
		let projectionHasPendingChanges = slot?.runtime?.cloudCompanyProjection?.hasPendingChanges() ?? false;
		if (!slot?.runtime?.cloudCompanyProjection && attachment?.profileType === "cloud" && root) {
			try {
				projectionHasPendingChanges = await cloudCompanyProjectionHasPersistedChanges({
					companyRoot: root,
					projectionRoot: cloudCompanyProjectionRoot(app.getPath("userData"), attachment.profileId),
					userData: app.getPath("userData"),
					profileId: attachment.profileId,
				});
			} catch {
				projectionHasPendingChanges = true;
			}
		}
		const recoverableReviews =
			attachment?.profileType === "cloud"
				? listRecoverableCloudCompanyExecutions(app.getPath("userData"), attachment.profileId).filter(
						(review) =>
							!review.cloudProposalId && (!root || normalizedRoot(review.companyRoot) === normalizedRoot(root)),
					)
				: [];
		const localRecoverableExecutions = recoverableReviews.length;
		const recoverableExecutions = localRecoverableExecutions + companyProposals.length;
		const fileConflictPaths =
			attachment?.profileType === "cloud" && root
				? (readCloudCompanyFileConflict(
						app.getPath("userData"),
						attachment.profileId,
						attachment.environmentId,
						root,
					)?.paths.length ?? 0)
				: 0;
		const fileIsCurrent = Boolean(
			companyFile?.headSnapshotId &&
				fileCheckpoint?.companyFile.headSnapshotId === companyFile.headSnapshotId &&
				!filePublication?.hasPendingWork() &&
				!projectionHasPendingChanges &&
				localRecoverableExecutions === 0 &&
				fileConflictPaths === 0,
		);
		return {
			account: account && accountEntitlement ? { ...account, entitlement: accountEntitlement } : account,
			company:
				slot?.runtime && account?.user
					? {
							root: slot.runtime.root,
							companyIcon: readCompanyIcon(app.getPath("userData"), account.user.id, slot.runtime.root),
							...(hostedProfile ? { name: hostedProfile.profileName } : {}),
						}
					: undefined,
			profile:
				root && attachment
					? {
							root,
							id: profileIdentityKey(attachment),
							profileType: attachment.profileType,
							profileId: attachment.profileId,
							product: productContext(),
							promotion: attachment.promotion,
							...(attachment.profileType === "cloud" ? { environmentId: attachment.environmentId } : {}),
							...(hostedProfile ? { name: hostedProfile.profileName } : {}),
							...(companyFile ? { companyFile } : {}),
							status: {
								...(settingsRefreshError ? { filesError: settingsRefreshError } : {}),
								recoverableExecutions,
								companyFileProposals: companyProposals,
								...(recoverableReviews[0]
									? {
											companyFileReview: {
												checkoutId: recoverableReviews[0].checkoutId,
												proposalHead: recoverableReviews[0].proposalHead,
												expectedCanonicalHead: recoverableReviews[0].expectedCanonicalHead,
												updatedAt: recoverableReviews[0].updatedAt,
											},
										}
									: {}),
								fileConflictPaths,
								identity: attachment.profileType,
								sharedStaff:
									attachment.profileType === "local"
										? "local"
										: slot?.runtime?.cloudStaffSyncHealth?.phase === "attention"
											? "attention"
											: slot?.runtime?.cloudStaffSyncHealth?.phase === "retrying"
												? "retrying"
												: slot?.runtime?.cloudStaffSyncHealth?.phase === "healthy"
													? "cloud"
													: "pending",
								trail:
									attachment.profileType === "local"
										? "local"
										: slot?.runtime?.cloudTrailSyncHealth?.phase === "attention"
											? "attention"
											: slot?.runtime?.cloudTrailSyncHealth?.phase === "retrying"
												? "retrying"
												: slot?.runtime?.cloudTrailSyncHealth?.phase === "healthy"
													? "cloud"
													: "pending",
								sessionsWaitingFor: slot?.runtime?.cloudSessionWaiting,
								sessions:
									attachment.profileType === "local"
										? "local"
										: slot?.runtime?.cloudSessionArbiterHealth?.phase === "attention"
											? "attention"
											: slot?.runtime?.cloudSessionArbiterHealth?.phase === "retrying"
												? "retrying"
												: slot?.runtime?.cloudSessionArbiterHealth?.phase === "healthy"
													? "cloud"
													: "pending",
								execution: "local",
								files:
									attachment.profileType === "local"
										? "local"
										: settingsRefreshError ||
												recoverableExecutions > 0 ||
												fileConflictPaths > 0 ||
												fileHealth?.phase === "attention" ||
												projectionHealth?.phase === "attention"
											? "attention"
											: fileHealth?.phase === "retrying" || projectionHealth?.phase === "retrying"
												? "offline"
												: fileHealth?.phase === "healthy" && fileIsCurrent
													? "cloud"
													: "pending",
							},
							access,
							team,
						}
					: undefined,
			localExecution: root ? readLocalExecutionPermission(app.getPath("userData"), root) : "always",
			sidebarTranslucency: readSidebarTranslucency(app.getPath("userData")),
			backgroundEnabled: root ? backgroundCompanyEnabled(root) : false,
			connections: [await githubConnectionInfo(root), ...modelConnectionInfo()],
			nativeExecution,
		};
	});
	ipcMain.handle("settings:background", (event, enabled: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof enabled !== "boolean") {
			return { ok: false, error: "invalid background execution preference" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		try {
			const roots = setBackgroundCompanyEnabled(app.getPath("userData"), runtime.root, enabled);
			syncBackgroundLoginItem(roots);
			syncBackgroundTray();
			return { ok: true, backgroundEnabled: enabled };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("settings:local-execution", async (event, permission: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || (permission !== "always" && permission !== "never")) {
			return { ok: false, error: "invalid local execution permission" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		if (
			!writeLocalExecutionPermission(app.getPath("userData"), runtime.root, permission as LocalExecutionPermission)
		) {
			return { ok: false, error: "Local execution permission could not be saved." };
		}
		if (runtime.wakeChild || isChildBusy(runtime.child)) {
			return { ok: true, permission, applies: "next-run" };
		}
		if (!runtime.child) return { ok: true, permission, applies: "next-run" };
		const attendedChild = runtime.child;
		try {
			await enqueueRuntimeTransition(runtime, async () => {
				if (slot.runtime !== runtime || runtime.closing) return;
				await replaceRuntimeChild(slot, runtime, {
					...runtime.childOptions,
					sessionFile: childBindings.get(attendedChild)?.file ?? runtime.childOptions.sessionFile,
				});
			});
			return { ok: true, permission, applies: "now" };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("model-accounts:usage", (event) => (slotOf(event.sender) ? modelAccountUsageInfo() : []));
	ipcMain.handle("connection:connect", (event, connectionId: unknown) => {
		if (typeof connectionId !== "string") return { ok: false, error: "invalid connection" };
		const slot = slotOf(event.sender);
		if (slot?.runtime && !slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return connectionId === "github"
			? connectGitHubAccount(event.sender)
			: connectModelAccount(event.sender, connectionId);
	});
	ipcMain.handle("connection:disconnect", (event, connectionId: unknown, accountId: unknown) => {
		if (typeof connectionId !== "string") return { ok: false, error: "invalid connection" };
		const slot = slotOf(event.sender);
		if (slot?.runtime && !slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		return connectionId === "github"
			? disconnectGitHubAccount(event.sender)
			: typeof accountId === "string"
				? disconnectModelAccount(event.sender, connectionId, accountId)
				: { ok: false, error: "invalid model account" };
	});
	ipcMain.handle("connection:cancel", (event, connectionId: unknown) => {
		const login = connectionLogins.get(event.sender.id);
		if (!login || login.connectionId !== connectionId) return false;
		login.controller.abort();
		return true;
	});
	ipcMain.handle("connection-requests:list", (event) => {
		const runtime = slotOf(event.sender)?.runtime;
		if (!runtime) return [];
		try {
			return readRendererConnectionRequests(app.getPath("userData"), runtime.root);
		} catch (error) {
			console.error(`connection request update failed: ${(error as Error).message}`);
			return [];
		}
	});
	ipcMain.handle("connection-request:select", (event, value: unknown, selectionValue: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const parsed = runtime ? rendererConnectionRequestIdentity(runtime, value) : undefined;
		if (!slot || !runtime || !parsed || !selectionValue || typeof selectionValue !== "object") {
			return { ok: false, error: "invalid connection intent selection" };
		}
		const selection = selectionValue as Record<string, unknown>;
		if (
			Object.keys(selection).some((key) => !["label", "kind"].includes(key)) ||
			typeof selection.label !== "string" ||
			(selection.kind !== "suggestion" && selection.kind !== "custom")
		) {
			return { ok: false, error: "invalid connection intent selection" };
		}
		try {
			const selectionInput: ConnectionIntentSelectionInput = {
				label: selection.label,
				kind: selection.kind,
			};
			const request = selectConnectionRequest(
				app.getPath("userData"),
				runtime.root,
				parsed.identity,
				selectionInput,
			);
			if (request.artifactId && request.dataNeedId) {
				const artifact = transitionCompanyArtifactConnection(
					runtime.root,
					request.staffAgentId,
					request.artifactId,
					request.dataNeedId,
					request.id,
					"selected",
				);
				commitCompanyMaterialization(runtime.root, [artifact.relativePath]);
			}
			publishConnectionRequest(slot, parsed.binding, request);
			return { ok: true, request: projectConnectionRequest(request) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("connection-request:prepare", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const parsed = runtime ? rendererConnectionRequestIdentity(runtime, value) : undefined;
		if (!slot || !runtime || !parsed) return { ok: false, error: "invalid connection request identity" };
		try {
			const request = prepareConnectionRequest(app.getPath("userData"), runtime.root, parsed.identity);
			publishConnectionRequest(slot, parsed.binding, request);
			return { ok: true, request: projectConnectionRequest(request) };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("connection-request:begin", async (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		const parsed = runtime ? rendererConnectionRequestIdentity(runtime, value) : undefined;
		if (!slot || !runtime || !parsed) {
			return { ok: false, error: "invalid connection request identity" };
		}
		if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
		const { identity, binding } = parsed;
		const attendedChild = runtime.child;
		if (!attendedChild) return { ok: false, error: "connection request agent is not attached" };
		const userData = app.getPath("userData");
		const root = runtime.root;
		let began = false;
		let originalRequest: ConnectionRequest | undefined;
		try {
			const request = getConnectionRequest(userData, root, identity.id);
			if (
				!request ||
				request.staffAgentId !== identity.staffAgentId ||
				request.sessionFile !== identity.sessionFile
			) {
				return { ok: false, error: "connection request ownership does not match" };
			}
			originalRequest = request;
			const githubNative = isGitHubNativeConnectionRequest(request);
			const companyConnector = companyConnectorForRequest(root, request);
			if (!githubNative && !companyConnector) {
				return { ok: false, error: "this connection does not have an installed native connector recipe" };
			}
			const signInError = companyConnector ? companyConnectorSignInError(root, companyConnector) : undefined;
			if (signInError) return { ok: false, error: signInError };
			if (
				companyConnector &&
				companyConnectorNeedsRegistration(root, companyConnector) &&
				!childComputerBrokers.get(attendedChild)?.handoffReady()
			) {
				return { ok: false, error: "The agent is still preparing the provider sign-in page" };
			}
			const connecting =
				companyConnector && companyConnectorNeedsRegistration(root, companyConnector)
					? beginConnectionRequestSetup(userData, root, identity)
					: beginConnectionRequest(userData, root, identity);
			began = true;
			publishConnectionRequest(slot, binding, connecting);
			const result = githubNative
				? await connectGitHubAccount(event.sender)
				: await connectCompanyConnector(event.sender, companyConnector!);
			if (result.ok && "pendingSetup" in result && result.pendingSetup) {
				return { ok: true, request: projectConnectionRequest(connecting) };
			}
			if (result.ok) {
				if (githubNative) {
					const installed = ensureBuiltInGitHubConnector(root, request.staffAgentId);
					if (installed.created) commitCompanyMaterialization(root, [...installed.relativePaths]);
				}
				const verifying = verifyConnectionRequest(userData, root, identity);
				publishConnectionRequest(slot, binding, verifying);
			}
			if (result.ok) {
				const connected = completeConnectionRequest(
					userData,
					root,
					identity,
					githubNative ? "github-native" : `company:${companyConnector!.id}`,
				);
				publishConnectionRequest(slot, binding, connected);
				const syncing = beginConnectionRequestSync(userData, root, identity);
				publishConnectionRequest(slot, binding, syncing);
				transitionLinkedArtifactRequest(root, request, "connected");
				void resumeStaffAfterConnection(slot, runtime, syncing);
				return { ok: true, request: projectConnectionRequest(syncing) };
			}
			const failure = safeConnectionFailure(result.error);
			const settled = result.cancelled
				? cancelConnectionRequest(userData, root, identity)
				: failConnectionRequest(userData, root, identity, failure);
			const projected = projectConnectionRequest(settled);
			transitionLinkedArtifactRequest(root, request, "failed");
			publishConnectionRequest(slot, binding, settled);
			return {
				ok: false,
				...(result.cancelled ? { cancelled: true as const } : { error: failure }),
				request: projected,
			};
		} catch (error) {
			if (began) {
				try {
					const failed = failConnectionRequest(
						userData,
						root,
						identity,
						"Connector authorization could not be finalized",
					);
					if (originalRequest) transitionLinkedArtifactRequest(root, originalRequest, "failed");
					const projected = projectConnectionRequest(failed);
					publishConnectionRequest(slot, binding, failed);
					return { ok: false, error: "Connector authorization could not be finalized", request: projected };
				} catch (settlementError) {
					console.error(`connection request settlement failed: ${(settlementError as Error).message}`);
				}
				return { ok: false, error: "Connector authorization could not be finalized" };
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("backend:authorized-post", async (event, path: string, body: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, status: 404, text: "no company" };
		const capability: ProfileCapability = path === "/api/inbox/respond" ? "write" : "authorize";
		if (!slotHasProfileCapability(slot, capability)) {
			return {
				ok: false,
				status: 403,
				text:
					capability === "write"
						? "This profile is read-only for your account."
						: "Full profile access is required to authorize this action.",
			};
		}
		return enqueueRuntimeTransition(runtime, async () => {
			if (!isCurrentRuntimeChild(slot, runtime, runtime.child)) {
				return {
					ok: false,
					status: 409,
					text: "company session changed before review",
				};
			}
			const reviewedChild = runtime.child;
			const actions = new Map([
				["/api/gate", "resolve an authority gate"],
				["/api/inbox/respond", "send a founder inbox response"],
				["/api/authority/config", "change company policy instructions"],
				["/api/authority", "replace the company authority policy"],
				["/api/artifact/update", "edit an agent artifact definition"],
			]);
			const action = actions.get(path);
			if (!action) return { ok: false, status: 400, text: "unsupported host action" };
			const serialized = JSON.stringify(body);
			if (typeof serialized !== "string") return { ok: false, status: 400, text: "invalid request" };
			if (Buffer.byteLength(serialized, "utf-8") > MAX_KERNEL_REVIEW_BYTES) {
				return {
					ok: false,
					status: 413,
					text: "request exceeds the exact-review limit",
				};
			}
			let gateDocument: string | undefined;
			if (path === "/api/gate") {
				if (!body || typeof body !== "object" || Array.isArray(body)) {
					return { ok: false, status: 400, text: "invalid gate transition" };
				}
				const record = body as Record<string, unknown>;
				if (
					Object.keys(record).some((key) => key !== "file" && key !== "action") ||
					typeof record.file !== "string" ||
					(record.action !== "approved" && record.action !== "denied")
				) {
					return { ok: false, status: 400, text: "invalid gate transition" };
				}
				gateDocument = kernelGateReviewDocument(runtime.root, record.file, record.action);
				if (!gateDocument)
					return {
						ok: false,
						status: 409,
						text: "gate is not canonically pending",
					};
			}
			const exactReview = gateDocument ? `${gateDocument}\nRequested transition:\n${serialized}` : serialized;
			const trailBinding = childBindings.get(reviewedChild);
			// Choosing an instruction in Settings is already an explicit founder
			// action. Save it directly; technical authority mutations retain the
			// separate exact-review confirmation below.
			const requiresExactReview = path !== "/api/authority/config";
			const approved = requiresExactReview
				? await confirmKernelReview(slot.window, {
						title: "Authorize company mutation",
						summary: `Authorize this exact host action: ${action}?`,
						exactText: exactReview,
						metadata: `Endpoint: ${path}`,
					})
				: true;
			if (!isCurrentRuntimeChild(slot, runtime, reviewedChild)) {
				return {
					ok: false,
					status: 409,
					text: "company session changed during review",
				};
			}
			if (!approved) {
				if (trailBinding) {
					appendKernelMutationObservation(trailBinding, {
						operation: path,
						exactReview,
						approved: false,
						phase: "decision",
					});
				}
				return { ok: false, status: 403, text: "cancelled" };
			}
			if (
				gateDocument &&
				kernelGateReviewDocument(
					runtime.root,
					(body as { file: string }).file,
					(body as { action: "approved" | "denied" }).action,
				) !== gateDocument
			) {
				return { ok: false, status: 409, text: "gate changed after review" };
			}
			if (trailBinding && requiresExactReview) {
				appendKernelMutationObservation(trailBinding, {
					operation: path,
					exactReview,
					approved: true,
					phase: "decision",
				});
			}
			let gateCapability: { approvals: Set<string>; key: string } | undefined;
			if (gateDocument && path === "/api/gate" && (body as { action?: unknown }).action === "approved") {
				const hash = gateDocument?.match(/^hash:\s*([a-f0-9]{64})$/m)?.[1];
				const file = (body as { file?: unknown }).file;
				const approvals = childApprovedGates.get(reviewedChild);
				if (!hash || typeof file !== "string" || !approvals) {
					return {
						ok: false,
						status: 409,
						text: "gate capability target is unavailable",
					};
				}
				gateCapability = { approvals, key: `${file}:${hash}` };
				// Mint before the backend transition so child stdout can never observe
				// an approved file without its matching one-shot capability.
				approvals.add(gateCapability.key);
			}
			let response: Response;
			try {
				response = await fetch(`http://127.0.0.1:${runtime.backendPort}${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-qorpera-token": runtime.backendToken,
					},
					body: serialized,
				});
			} catch (error) {
				if (gateCapability) gateCapability.approvals.delete(gateCapability.key);
				throw error;
			}
			if (!response.ok && gateCapability) gateCapability.approvals.delete(gateCapability.key);
			if (
				response.ok &&
				gateDocument &&
				path === "/api/gate" &&
				(body as { action?: unknown }).action === "denied"
			) {
				const hash = gateDocument.match(/^hash:\s*([a-f0-9]{64})$/m)?.[1];
				const file = (body as { file?: unknown }).file;
				if (hash && typeof file === "string") {
					revokeCompanyGateTrust(app.getPath("userData"), runtime.root, file, hash);
				}
			}
			if (trailBinding) {
				appendKernelMutationObservation(trailBinding, {
					operation: path,
					exactReview,
					approved: true,
					phase: "result",
					resultStatus: response.status,
				});
			}
			return {
				ok: response.ok,
				status: response.status,
				text: await response.text(),
			};
		});
	});
	ipcMain.handle("app:info", (event) => {
		const slot = slotOf(event.sender);
		const active = slot ? activeCompanyInfo(slot) : undefined;
		if (active && slot) {
			active.kickoff = slot.kickoffPending;
			slot.kickoffPending = false;
		}
		const pending = pendingCompany;
		pendingCompany = undefined;
		return {
			version: shellVersion(),
			pendingCompany: pending,
			activeCompany: active,
		};
	});
	// Presence signals from the renderer. Lossy lane: no acks, no errors — a
	// dropped signal just means a teammate's indicator arrives a beat later.
	ipcMain.on("presence:thread", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime) return;
		const openThread = typeof staffAgentId === "string" && staffAgentId ? staffAgentId : null;
		slot.runtime.cloudPresenceThread = openThread;
		slot.runtime.cloudPresence?.setOpenThread(openThread);
	});
	ipcMain.on("presence:typing", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime || typeof staffAgentId !== "string" || !staffAgentId) return;
		slot.runtime.cloudPresence?.sendTyping(staffAgentId);
	});
	ipcMain.handle("prompt-send:stage", async (event, id: unknown, frame: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof id !== "string" || !UUID_PATTERN.test(id)) {
			return { ok: false, error: "Prompt outbox identity is invalid." };
		}
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
			return { ok: false, error: "Prompt outbox message is invalid." };
		}
		const reviewed = reviewedPromptFrame({ ...(frame as Record<string, unknown>), clientInputId: id });
		if (!reviewed || reviewed.type !== "prompt") {
			return { ok: false, error: "Prompt outbox message is invalid." };
		}
		const attachment = profileAttachment(runtime.root);
		const staffAgentId = runtime.childOptions.staffAgentId;
		const sessionId = attendedSessionBinding(runtime)?.sessionId;
		if (attachment.profileType !== "cloud" || !staffAgentId || !sessionId) {
			return { ok: true, id, staged: false };
		}
		try {
			const record = await stageCloudPromptOutbox({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				staffAgentId,
				sessionId,
				id,
				envelope: {
					message: reviewed.message,
					...(reviewed.displayText !== undefined ? { displayText: reviewed.displayText } : {}),
					...(reviewed.images ? { images: reviewed.images } : {}),
					...(reviewed.executionSponsor ? { executionSponsor: reviewed.executionSponsor } : {}),
				},
			});
			return { ok: true, id: record.id, staged: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("prompt-send:pending", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: true, pending: null };
		const attachment = profileAttachment(runtime.root);
		const staffAgentId = runtime.childOptions.staffAgentId;
		const sessionId = attendedSessionBinding(runtime)?.sessionId;
		if (attachment.profileType !== "cloud" || !staffAgentId || !sessionId) {
			return { ok: true, pending: null };
		}
		try {
			const pending = await pendingCloudPromptOutbox({
				userData: app.getPath("userData"),
				profileId: attachment.profileId,
				staffAgentId,
			});
			return pending
				? {
						ok: true,
						pending: {
							id: pending.id,
							digest: pending.digest,
							requiresSessionConfirmation: pending.sessionId !== sessionId,
							frame: { type: "prompt", ...pending.envelope, clientInputId: pending.id },
						},
					}
				: { ok: true, pending: null };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("prompt-send:ack", async (event, id: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || typeof id !== "string" || !UUID_PATTERN.test(id)) return { ok: false };
		const attachment = profileAttachment(runtime.root);
		const staffAgentId = runtime.childOptions.staffAgentId;
		const sessionId = attendedSessionBinding(runtime)?.sessionId;
		if (attachment.profileType !== "cloud" || !staffAgentId || !sessionId) return { ok: true };
		try {
			return {
				ok: await acknowledgeCloudPromptOutbox({
					userData: app.getPath("userData"),
					profileId: attachment.profileId,
					staffAgentId,
					sessionId,
					id,
				}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle(
		"staff-session:resolve-recovery",
		async (event, staffAgentId: unknown, turnId: unknown, resolution: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (
				!slot ||
				!runtime ||
				typeof staffAgentId !== "string" ||
				typeof turnId !== "string" ||
				!UUID_PATTERN.test(turnId) ||
				(resolution !== "retry" && resolution !== "discard")
			) {
				return { ok: false, error: "Conversation recovery request is invalid." };
			}
			if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
			const arbiter = runtime.cloudSessionArbiter;
			if (!arbiter?.sessionForStaff(staffAgentId)) {
				return { ok: false, error: "The shared staff conversation is unavailable." };
			}
			try {
				await arbiter.resolveRecovery(staffAgentId, turnId, resolution);
				const queue = await readRendererSessionQueue(arbiter, staffAgentId);
				if (runtime.childOptions.staffAgentId === staffAgentId) {
					send(slot.window, "staff-session-queue", { staffAgentId, queue });
					if (resolution === "retry") void refreshCloudSessionQueue(slot, runtime);
				}
				return { ok: true, queue };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle(
		"staff-session:resolve-execution-recovery",
		async (event, staffAgentId: unknown, runId: unknown, action: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (
				!slot ||
				!runtime ||
				typeof staffAgentId !== "string" ||
				typeof runId !== "string" ||
				!UUID_PATTERN.test(runId) ||
				(action !== "retry" && action !== "discard")
			) {
				return { ok: false, error: "Hosted conversation recovery request is invalid." };
			}
			if (!slotHasProfileCapability(slot, "write")) return profilePermissionError("write");
			const arbiter = runtime.cloudSessionArbiter;
			if (!arbiter?.sessionForStaff(staffAgentId)) {
				return { ok: false, error: "The shared staff conversation is unavailable." };
			}
			try {
				const available = await arbiter.executionRecoveries(staffAgentId);
				if (!available.some((recovery) => recovery.runId === runId)) {
					throw new Error("This hosted conversation recovery changed; refresh and review it again.");
				}
				await arbiter.resolveExecutionRecovery(staffAgentId, runId, action);
				const queue = await readRendererSessionQueue(arbiter, staffAgentId);
				if (runtime.childOptions.staffAgentId === staffAgentId) {
					send(slot.window, "staff-session-queue", { staffAgentId, queue });
				}
				return { ok: true, queue };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle(
		"staff-session:resolve-operation",
		async (event, staffAgentId: unknown, operationId: unknown, resolution: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (
				!slot ||
				!runtime ||
				typeof staffAgentId !== "string" ||
				typeof operationId !== "string" ||
				!UUID_PATTERN.test(operationId) ||
				(resolution !== "confirmed_completed" && resolution !== "confirmed_not_run")
			) {
				return { ok: false, error: "Operation recovery request is invalid." };
			}
			if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
			const arbiter = runtime.cloudSessionArbiter;
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!arbiter?.sessionForStaff(staffAgentId) || !primary) {
				return { ok: false, error: "The shared operation recovery is unavailable." };
			}
			try {
				await primary.resolveOperationReceipt(operationId, resolution);
				const queue = await readRendererSessionQueue(arbiter, staffAgentId);
				if (runtime.childOptions.staffAgentId === staffAgentId) {
					send(slot.window, "staff-session-queue", { staffAgentId, queue });
				}
				return { ok: true, queue };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
	ipcMain.handle(
		"staff-session:resolve-run-operation",
		async (event, staffAgentId: unknown, operationId: unknown, resolution: unknown) => {
			const slot = slotOf(event.sender);
			const runtime = slot?.runtime;
			if (
				!slot ||
				!runtime ||
				typeof staffAgentId !== "string" ||
				typeof operationId !== "string" ||
				!UUID_PATTERN.test(operationId) ||
				(resolution !== "confirmed_completed" && resolution !== "confirmed_not_run")
			) {
				return { ok: false, error: "Hosted operation recovery request is invalid." };
			}
			if (!slotHasProfileCapability(slot, "authorize")) return profilePermissionError("authorize");
			const arbiter = runtime.cloudSessionArbiter;
			const primary = qorperaAccountAuth?.hostedPrimary();
			if (!arbiter?.sessionForStaff(staffAgentId) || !primary) {
				return { ok: false, error: "The hosted operation recovery is unavailable." };
			}
			try {
				const available = await arbiter.executionRecoveries(staffAgentId);
				if (
					!available.some((recovery) =>
						recovery.operationReceipts.some((receipt) => receipt.operationId === operationId),
					)
				) {
					throw new Error("This hosted operation recovery changed; refresh and review it again.");
				}
				await primary.resolveRunOperationReceipt(operationId, resolution);
				const queue = await readRendererSessionQueue(arbiter, staffAgentId);
				if (runtime.childOptions.staffAgentId === staffAgentId) {
					send(slot.window, "staff-session-queue", { staffAgentId, queue });
				}
				return { ok: true, queue };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);

	ipcMain.handle("rpc:send", async (event, frame: unknown, expectedTrailFile: unknown) => {
		const reviewedCloudPrompt =
			frame && typeof frame === "object" && "type" in frame && frame.type === "prompt"
				? reviewedPromptFrame(frame as Record<string, unknown>)
				: undefined;
		const cloudSponsoredPrompt = reviewedCloudPrompt?.executionSponsor !== undefined;
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || (runtime.wakeChild && !cloudSponsoredPrompt)) {
			// Every silent ok:false here previously cost a debugging session;
			// a rejection that keeps the founder's draft must at least say why.
			// Read-only polls (get_state etc.) reject quietly — they retry.
			const frameType = frame && typeof frame === "object" && "type" in frame ? String(frame.type) : "";
			if (frameType === "prompt" || frameType === "steer" || frameType === "follow_up") {
				console.error(`rpc:send reject: slot=${!!slot} runtime=${!!runtime} wake=${!!runtime?.wakeChild}`);
				return { ok: false, error: "agent is busy with autonomous work" };
			}
			return { ok: false };
		}
		if (!frame || typeof frame !== "object" || !("type" in frame) || typeof frame.type !== "string") {
			return { ok: false };
		}
		if (typeof expectedTrailFile !== "string" || !expectedTrailFile) {
			console.error("rpc:send reject: no session attachment");
			return { ok: false, error: "session attachment required" };
		}
		const anchor = !runtime.child ? runtime.sessionAnchor : undefined;
		if (anchor) {
			if (anchor.binding.file !== expectedTrailFile) {
				return { ok: false, error: "session changed before command" };
			}
			return anchoredSessionRpc(
				slot,
				runtime,
				anchor,
				frame as { type: string } & Record<string, unknown>,
				reviewedCloudPrompt,
			);
		}
		const attachedTo = (child: ChildProcessWithoutNullStreams): boolean =>
			childBindings.get(child)?.file === expectedTrailFile;
		const promptTypes = new Set(["prompt", "steer", "follow_up"]);
		const readOnlyControlTypes = new Set([
			"get_state",
			"get_messages",
			"get_available_models",
			"get_available_thinking_levels",
			"get_session_stats",
			"get_entries",
			"get_tree",
			"get_fork_messages",
			"get_commands",
		]);
		const safeControlTypes = new Set([
			"abort",
			"get_state",
			"get_messages",
			"set_model",
			"cycle_model",
			"get_available_models",
			"get_available_thinking_levels",
			"set_thinking_level",
			"set_response_speed",
			"cycle_thinking_level",
			"set_steering_mode",
			"set_follow_up_mode",
			"set_auto_retry",
			"abort_retry",
			"get_session_stats",
			"get_entries",
			"get_tree",
			"get_fork_messages",
			"get_commands",
			"set_session_name",
		]);
		if (promptTypes.has(frame.type)) {
			if (!slotHasProfileCapability(slot, "write")) {
				// A cold hosted-team cache right after open must not eat the
				// founder's message: re-resolve access once before refusing, and
				// tell the renderer whatever the answer turned out to be.
				try {
					await refreshProfileAccess(runtime.root);
				} catch {
					/* unreachable cloud: the recheck below decides */
				}
				send(slot.window, "profile-access-changed", activeProfileAccess(runtime.root));
				if (!slotHasProfileCapability(slot, "write")) {
					console.error("rpc:send reject: write capability missing after access refresh");
					return profilePermissionError("write");
				}
			}
			return enqueueRuntimeTransition(runtime, async () => {
				if (!isCurrentRuntimeChild(slot, runtime, runtime.child)) {
					console.error("rpc:send reject: runtime child changed before prompt");
					return { ok: false, error: "session changed before command" };
				}
				const reviewedChild = runtime.child;
				const reviewed = reviewedCloudPrompt ?? reviewedPromptFrame(frame as Record<string, unknown>);
				if (!reviewed || (!reviewed.message && !reviewed.images?.length)) return { ok: false };
				if (!cloudSponsoredPrompt && runtime.childOptions.staffAgentId && !childRuntimeReady.has(reviewedChild)) {
					console.error("rpc:send reject: staff child not ready");
					return { ok: false, error: "staff member is still getting ready" };
				}
				if (!attachedTo(reviewedChild)) {
					console.error("rpc:send reject: prompt bound to a different session file");
					return { ok: false, error: "session changed before command" };
				}
				// Founder call (2026-08-13): typing in the composer IS the founder
				// acting — a native dialog re-confirming their own words was pure
				// friction and is gone. The kernel still observes the exact input
				// (attended, with origin) into the trail; the tradeoff accepted is
				// that "attended" now trusts the local renderer rather than an
				// OS-level dialog, the same posture as the founder's other local
				// coding tools.
				if (!isCurrentRuntimeChild(slot, runtime, reviewedChild) || !attachedTo(reviewedChild)) {
					return { ok: false, error: "session changed before command" };
				}
				const promptOrigin = currentQorperaAccountId
					? `account:${currentQorperaAccountId}:composer-attended`
					: "composer-attended";
				// Under session arbitration a fresh prompt is a queue row first:
				// exactly one revision-current machine claims and executes it. A
				// cloud conversation never falls back to a machine-local send.
				const sendArbiter = runtime.cloudSessionArbiter;
				const sendStaffId = runtime.childOptions.staffAgentId;
				const sendBinding = childBindings.get(reviewedChild);
				const cloudStaffConversation =
					sendStaffId !== undefined && profileAttachment(runtime.root).profileType === "cloud";
				if (cloudStaffConversation && !sendArbiter) {
					return { ok: false, error: "cloud conversation is unavailable; your message was not sent" };
				}
				let sendRef = sendArbiter && sendStaffId ? sendArbiter.sessionForStaff(sendStaffId) : undefined;
				if (
					sendArbiter &&
					sendStaffId &&
					!sendRef &&
					sendBinding &&
					frame.type === "prompt" &&
					slotHasProfileCapability(slot, "write")
				) {
					// The open-time ensure failed; retry before accepting the prompt.
					const sendStaff = activeStaffAgent(runtime.root, sendStaffId);
					if (sendStaff) {
						try {
							sendRef = await sendArbiter.ensureSession(
								sendStaffId,
								sendStaff.displayName,
								sendBinding.sessionId,
							);
							recordAttachedTrailCursor(runtime, sendStaffId);
							recordCloudSessionArbiterOutcome(runtime, { ok: true });
						} catch (error) {
							recordCloudSessionArbiterOutcome(runtime, { ok: false, error });
							return {
								ok: false,
								error: `cloud conversation could not be reached: ${error instanceof Error ? error.message : String(error)}`,
							};
						}
						if (!isCurrentRuntimeChild(slot, runtime, reviewedChild) || !attachedTo(reviewedChild)) {
							return { ok: false, error: "session changed before command" };
						}
						if (sendRef && sendBinding.sessionId !== sendRef.clientSessionId) {
							void readoptStaffCloudSession(slot, runtime, sendStaffId, sendRef);
							return { ok: false, error: "conversation is rejoining its cloud history; retry in a moment" };
						}
					}
				}
				if (
					sendArbiter &&
					sendStaffId &&
					sendRef &&
					sendBinding &&
					sendBinding.sessionId === sendRef.clientSessionId &&
					frame.type === "prompt"
				) {
					return requestSponsoredCloudTurn(runtime, sendArbiter, sendStaffId, sendRef, reviewed);
				}
				if (cloudStaffConversation && frame.type === "prompt") {
					return { ok: false, error: "cloud conversation is not attached; your message was not sent" };
				}
				/* Cloud-only execution (founder ruling 2026-08-26): the local
				 * executor is removed. A prompt that cannot become a cloud turn
				 * fails honestly instead of running inside the app. */
				if (frame.type === "prompt" && runtime.childOptions.staffAgentId) {
					return {
						ok: false,
						error: "Agents execute in the cloud. This conversation has no active cloud session yet — reopen the thread or check the company's subscription connection.",
					};
				}
				return { ok: sendLegacyLocalPrompt(reviewedChild, reviewed, true, promptOrigin) };
			});
		}
		if (!safeControlTypes.has(frame.type)) return { ok: false };
		if (!readOnlyControlTypes.has(frame.type) && !slotHasProfileCapability(slot, "write")) {
			return profilePermissionError("write");
		}
		const targetChild = runtime.child;
		if (!isCurrentRuntimeChild(slot, runtime, targetChild) || !attachedTo(targetChild)) {
			return { ok: false, error: "session changed before command" };
		}
		if (frame.type === "abort") {
			childModelCapabilities.get(targetChild)?.endTurn("aborted");
			childHttpBrokers.get(targetChild)?.endTurn();
			childComputerBrokers.get(targetChild)?.endTurn();
			childCompanyOperationBrokers.get(targetChild)?.endTurn();
		}
		return { ok: writeChildFrame(targetChild, `${JSON.stringify(frame)}\n`) };
	});

	// A window that already knows its company (launcher argv, company smoke)
	// boots directly onto that company's durable partition — the open then
	// happens in place, with no window swap.
	const smokeCompanyIndex = process.argv.indexOf("--smoke-company");
	const smokeCompanyRoot = smokeCompanyIndex >= 0 ? process.argv[smokeCompanyIndex + 1] : undefined;
	const smokeBootstrapPicker = process.argv.includes("--smoke-bootstrap");
	const initial = createWindow(pendingCompany ?? smokeCompanyRoot);
	if (pendingProfileInvitationId) scheduleProfileInvitationHandoff(initial);

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		let updateCheckInFlight: Promise<void> | undefined;
		autoUpdater.on("checking-for-update", () => {
			setFoundationUpdateState({ phase: "checking", message: "Checking for updates…" });
		});
		autoUpdater.on("update-available", (info) => {
			setFoundationUpdateState({
				phase: "downloading",
				message: `Downloading v${info.version}…`,
				version: info.version,
			});
		});
		autoUpdater.on("update-not-available", () => {
			setFoundationUpdateState({ phase: "current", message: "Qorpera Base is up to date" });
		});
		autoUpdater.on("error", (error) => {
			setFoundationUpdateState({
				phase: "error",
				message: `Update check failed: ${error.message.slice(0, 80)}`,
			});
		});
		autoUpdater.on("update-downloaded", (info) => {
			downloadedUpdateVersion = info.version;
			downloadedUpdateFile = info.downloadedFile;
			setFoundationUpdateState({
				phase: "ready",
				message: `v${info.version} downloaded — restart to update`,
				version: info.version,
			});
			sendAll("update-ready", info.version);
		});
		const checkForFoundationUpdate = (): Promise<void> => {
			if (downloadedUpdateVersion) return Promise.resolve();
			if (updateCheckInFlight) return updateCheckInFlight;
			updateCheckInFlight = autoUpdater
				.checkForUpdatesAndNotify()
				.then(() => undefined)
				.catch((error: Error) => {
					console.error(`update check failed: ${error.message}`);
					setFoundationUpdateState({
						phase: "error",
						message: `Update check failed: ${error.message.slice(0, 80)}`,
					});
				})
				.finally(() => {
					updateCheckInFlight = undefined;
				});
			return updateCheckInFlight;
		};
		ipcMain.handle("update:state", (event) => {
			return slotOf(event.sender) ? foundationUpdateState : undefined;
		});
		ipcMain.handle("update:check", async (event) => {
			if (!slotOf(event.sender)) return undefined;
			await checkForFoundationUpdate();
			return foundationUpdateState;
		});
		void checkForFoundationUpdate();
		ipcMain.handle("update:install", (event) => {
			const slot = slotOf(event.sender);
			if (!slot || !downloadedUpdateVersion) return false;
			// Clicking the versioned Update control is the founder's explicit
			// consent. Kernel exact-content review is for company capabilities and
			// mutations, not a signed application update already verified by the
			// packaged updater.
			sendAll("update-status", `restarting to install ${downloadedUpdateVersion}…`);
			if (downloadedUpdateFile && isAdhocSignedMacBuild()) {
				if (!installMacUpdateBySelfReplace(downloadedUpdateFile)) return false;
				app.quit();
				return true;
			}
			autoUpdater.quitAndInstall(false, true);
			return true;
		});
	} else {
		foundationUpdateState = IS_SMOKE
			? { phase: "idle", message: "Check for updates" }
			: {
					phase: "unavailable",
					message: "Updates are checked by installed builds",
				};
		ipcMain.handle("update:state", (event) => {
			return slotOf(event.sender) ? foundationUpdateState : undefined;
		});
		ipcMain.handle("update:check", (event) => {
			return slotOf(event.sender) ? foundationUpdateState : undefined;
		});
		ipcMain.handle("update:install", () => false);

		// In development, reload the fixed renderer after the copied shell files
		// settle. Main-process changes still require an app restart.
		if (!IS_SMOKE) {
			let reloadTimer: NodeJS.Timeout | undefined;
			try {
				watch(DIRNAME, { recursive: true }, () => {
					if (reloadTimer) clearTimeout(reloadTimer);
					// A build writes many files; act once the burst settles.
					reloadTimer = setTimeout(() => {
						if (!existsSync(join(FIXED_SHELL_DIR, "index.html"))) return; // mid-copy
						for (const slot of slots.values()) {
							if (slot.window.isDestroyed()) continue;
							const runtime = slot.runtime;
							if (!runtime) {
								void slot.window.loadFile(join(FIXED_SHELL_DIR, "index.html"));
								continue;
							}
							void slot.window.loadURL(companyShellUrl(runtime));
						}
					}, 600);
				});
			} catch (error) {
				// A broken watcher must never take the shell down — dev nicety only.
				console.error(`dev reload watcher unavailable: ${(error as Error).message}`);
			}
		}
	}

	// Visual smoke: capture the window to a PNG once it has settled — the
	// cheap way to verify chrome work without a human at the keyboard.
	// Composes with --smoke-company (captures after the company loads).
	const shotIndex = process.argv.indexOf("--smoke-shot");
	const smokeShotTarget = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;
	if (smokeShotTarget) {
		let timer: NodeJS.Timeout | undefined;
		initial.window.webContents.on("did-finish-load", () => {
			if (smokeCompanyRoot && !initial.window.webContents.getURL().startsWith("http://127.0.0.1:")) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(async () => {
				try {
					const readyDeadline = Date.now() + 10_000;
					let rendererReady = "";
					while (!rendererReady && Date.now() < readyDeadline) {
						rendererReady = await initial.window.webContents.executeJavaScript(
							'document.documentElement.dataset.qorperaReady ?? ""',
						);
						if (!rendererReady) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
					}
					if (!rendererReady) throw new Error("renderer did not finish booting");
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
					const image = await initial.window.webContents.capturePage();
					if (bitmapLooksBlank(image.toBitmap())) throw new Error("renderer capture is visually blank");
					writeFileSync(smokeShotTarget, image.toPNG());
					console.log(`SHOT_SAVED ${smokeShotTarget}`);
				} catch (error) {
					console.error(`SHOT_FAILED ${(error as Error).message}`);
					app.exit(1);
					return;
				}
				app.quit();
			}, 100);
		});
	}
	// Headless smoke: prove the shell boots, then leave.
	if (process.argv.includes("--smoke") && !smokeShotTarget) {
		initial.window.webContents.once("did-finish-load", () => {
			console.log("SHELL_READY");
			setTimeout(() => app.quit(), 1500);
		});
	}
	// A smoke run must never hang: an openCompany failure (sandbox
	// provisioning, company lock, …) would otherwise become an unhandled
	// rejection that leaves the process alive with no exit path.
	let smokeFailurePending = false;
	const failSmoke = (error: Error): void => {
		if (smokeFailurePending) return;
		smokeFailurePending = true;
		console.error(`SMOKE_FAILED ${error.message}`);
		void Promise.all([...slots.values()].map((slot) => closeCompany(slot)))
			.catch((cleanupError) => console.error(`SMOKE_CLEANUP_FAILED ${(cleanupError as Error).message}`))
			.finally(() => app.exit(1));
	};
	// Fixed-shell smoke: open a company and prove its trusted renderer loads.
	if (smokeCompanyRoot) {
		void openCompany(initial, smokeCompanyRoot)
			.then(async () => {
				if (smokeBootstrapPicker) {
					const result = (await initial.window.webContents.executeJavaScript(`
					(async () => {
					let rendererError = "";
					const captureError = (event) => { rendererError = event.error?.stack ?? event.message ?? "unknown renderer error"; };
					window.addEventListener("error", captureError);
					await new Promise((resolve, reject) => {
						let attempts = 0;
						const inspect = () => {
							if (document.querySelectorAll(".staff-bootstrap-card").length >= 3) resolve();
							else if (++attempts >= 50) reject(new Error("staff bootstrap cards did not render"));
							else setTimeout(inspect, 100);
						};
						inspect();
					});
					for (let index = 0; index < 3; index += 1) document.querySelectorAll(".staff-bootstrap-card")[index]?.click();
					return {
						title: document.querySelector(".staff-bootstrap-head h1")?.textContent,
						cardCount: document.querySelectorAll(".staff-bootstrap-card").length,
						actionText: document.querySelector(".staff-bootstrap-actions .primary-button")?.textContent,
						rendererError,
					};
					})()
				`)) as { title?: string; cardCount?: number; actionText?: string; rendererError?: string };
					if (
						result.title !== "Choose your starting team" ||
						result.cardCount !== 10 ||
						result.actionText !== "Start 3 staff"
					) {
						throw new Error(
							`staff bootstrap picker did not render (title=${result.title ?? "missing"}, action=${result.actionText ?? "missing"}, cards=${result.cardCount ?? 0}, renderer=${result.rendererError ?? "none"})`,
						);
					}
					console.log(`BOOTSTRAP_PICKER_READY cards=${result.cardCount}`);
				}
				if (!smokeShotTarget)
					setTimeout(() => {
						console.log(`SHELL_LOADED ${initial.window.webContents.getURL()}`);
						app.quit();
					}, 1500);
			})
			.catch(failSmoke);
	}
	// Multi-window smoke: two companies side by side.
	const smokeMultiIndex = process.argv.indexOf("--smoke-multi");
	if (smokeMultiIndex >= 0 && process.argv[smokeMultiIndex + 1] && process.argv[smokeMultiIndex + 2]) {
		const rootA = process.argv[smokeMultiIndex + 1];
		const rootB = process.argv[smokeMultiIndex + 2];
		void openCompany(initial, rootA)
			.then(async () => {
				const second = createWindow();
				await openCompany(second, rootB);
				// Re-opening an already-open company must route, not double-run.
				const third = createWindow();
				await openCompany(third, rootA);
				setTimeout(() => {
					for (const slot of slots.values()) {
						const runtime = slot.runtime;
						console.log(
							runtime
								? `WINDOW company=${runtime.root} port=${runtime.backendPort} url=${slot.window.webContents.getURL()}`
								: `WINDOW hub url=${slot.window.webContents.getURL()}`,
						);
					}
					console.log("MULTI_OK");
					app.quit();
				}, 1500);
			})
			.catch(failSmoke);
	}
});

app.on("before-quit", () => {
	appQuitting = true;
});

app.on("will-quit", () => {
	backgroundTray?.destroy();
	backgroundTray = undefined;
	modelRequestBroker?.close();
	// Window-close teardown (closeCompany) is async — it awaits the transition
	// queue before it kills anything — and quit does not wait for it, so any
	// agent tree still alive here would outlive the shell (observed on Windows:
	// codex.exe children surviving app quit). Reap synchronously; the pending
	// checkpoint files are reconciled on next open, same as after a crash.
	for (const child of liveChildren) {
		intentionalKills.add(child);
		killChildTreeSync(child);
	}
	liveChildren.clear();
});

app.on("window-all-closed", () => {
	app.quit();
});
