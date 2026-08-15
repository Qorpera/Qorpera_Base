/**
 * Qorpera Base shell — the minimal desktop app every company controller is
 * built on (spec §7, v0.8 posture: between PI and a full desktop app).
 *
 * Fixed agent interface by construction: every company uses the same trusted
 * shell. Company-authored artifacts are sandboxed surfaces, while model
 * runtimes are replaceable local processes attached to durable staff and
 * trails. A packaged shell uses Electron's Node runtime and needs no system
 * Node installation.
 *
 * Windows: one window per open thing — the hub, or one company controller.
 * Several controllers run side by side, each with its own window, RPC child,
 * and backend; a company is never open in two windows at once.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@qorpera/pi-coding-agent";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import {
	type CompanyRuntimeLock,
	canonicalCompanyRoot,
	captureProductTransactionStorage,
	claimCompanyRuntimeLock,
	conceptionKickoff,
	createProductWorktree,
	enforceCompanyKernelSettings,
	integrateRepo,
	integrateRepoWithRuntimeLock,
	listCompanies,
	listProductDepartments,
	materializeClonedProductStorage,
	migrateLegacyManifestSurfaces,
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
	validateCompanyKernelStorage,
} from "@qorpera/pi-coding-agent/company";
import {
	bindCompanySecret,
	bindNetworkDestination,
	createScheduledJob,
	deleteScheduledJob,
	destinationAllowed,
	persistWebhookPort,
	type RoutineTriggerInput,
	readCompanyConnections,
	readScheduledJobs,
	readWebhookBinding,
	removeCompanySecret,
	removeNetworkDestination,
	resolveCompanySecret,
	type ScheduledJob,
	scheduledJobIntervalMinutes,
	suspendScheduledJob,
	updateScheduledJob,
} from "@qorpera/pi-coding-agent/company-connections";
import {
	archiveStaffAgent,
	createStaffAgent,
	createStaffAgents,
	readStaffAgents,
	type StaffAgent,
	updateStaffAgent,
} from "@qorpera/pi-coding-agent/company-staff";
import { FOUNDER_PUBLIC_FILE, founderPublicProjection } from "@qorpera/pi-coding-agent/founder-identity";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	session as electronSession,
	shell as electronShell,
	ipcMain,
	type Session,
	type WebContents,
} from "electron";
import electronUpdater from "electron-updater";
import { QorperaAccountAuth, type QorperaAccountInfo, type QorperaAccountProvider } from "./account-auth.ts";
import {
	appendKernelHttpObservation,
	appendKernelModelObservation,
	appendKernelMutationObservation,
	appendKernelObservation,
	appendKernelProductStorageObservation,
	appendKernelRuntimeExitObservation,
	appendKernelSessionEndObservation,
	appendKernelSessionInfo,
	appendKernelWakeObservation,
	applyKernelWriteFrame,
	bindTrailSession,
	brokeredChildEnvironment,
	codexSpawn,
	commitTrailAppend,
	createKernelResponseSigner,
	inboxMessagesPath,
	type KernelIntentCapability,
	kernelGateReviewDocument,
	killChildTree,
	killChildTreeSync,
	latestResumableTrailSession,
	migrateLegacyTrailSession,
	parseTrailAppendFrame,
	protectedControllerPaths,
	provisionSandbox,
	pruneEmptyTrailSessions,
	reconcileKernelGateCreations,
	sandboxCommandArgs,
	sandboxConfigDir,
	sandboxGitEnvironment,
	sandboxRuntimeDir,
	shareWindowsSandboxState,
	type TrailBinding,
	writeSandboxProfile,
} from "./agent-runtime.ts";
import {
	captureCompanyGitBaseline,
	checkpointCompanyGit,
	checkpointProductWorktreeGit,
	commitCompanyMaterialization,
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
	companyKernelStatePath,
	companyRootId,
	completeCompanyGateCreation,
	hasCompanyGateTrust,
	hasCompanyKernelState,
	listPendingCompanyGateCreations,
	reconcileCompanyProductStorage,
	rememberCompanyGateTrust,
	revokeCompanyGateTrust,
} from "./company-kernel-state.ts";
import {
	beginConnectionRequest,
	type ConnectionRequest,
	type ConnectionRequestIdentity,
	type CreateConnectionRequestInput,
	cancelConnectionRequest,
	completeConnectionRequest,
	createConnectionRequest,
	failConnectionRequest,
	getConnectionRequest,
	projectConnectionRequest,
	readRendererConnectionRequests,
} from "./connection-requests.ts";
import {
	type ControllerModelSelection,
	clearControllerModelPreference,
	clearDefaultControllerModelPreference,
	controllerLaunchOptions,
	controllerModelArgs,
	modelSelectionFromRpcFrame,
	readControllerModelPreference,
	readDefaultControllerModelPreference,
	writeControllerModelPreference,
	writeDefaultControllerModelPreference,
} from "./controller-model.ts";
import { migrateCompanyToFixedShell } from "./fixed-shell-migration.ts";
import { connectGitHubCli, readGitHubCliStatus } from "./github-connection.ts";
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
	type LocalExecutionPermission,
	localExecutionToolArgs,
	readLocalExecutionPermission,
	writeLocalExecutionPermission,
} from "./local-execution.ts";
import { ModelAccountStore, type ModelAccountView } from "./model-accounts.ts";
import { type BrokeredCredentials, type ModelRequestBroker, startModelRequestBroker } from "./model-request-broker.ts";
import {
	DEFAULT_PROFILE_ICON_ID,
	forgetProfileIcon,
	isProfileIconId,
	type ProfileIconId,
	readProfileIcon,
	writeProfileIcon,
} from "./profile-appearance.ts";
import { claimProfile, claimUnownedProfiles, forgetProfile, profileOwnedBy } from "./profile-ownership.ts";
import {
	isRendererRequestAllowed,
	lockDownRendererSession,
	lockDownRendererWebContents,
	rendererPartitionForCompany,
} from "./renderer-boundary.ts";
import { bitmapLooksBlank } from "./renderer-smoke.ts";
import {
	type PendingRoutineTrigger,
	persistRoutineTriggerEvent,
	pollGitHubRoutineTriggers,
	queueCustomRoutineTrigger,
	readRoutineTriggerState,
	removePendingRoutineTrigger,
	routineTriggerStatePath,
	writeRoutineTriggerState,
} from "./routine-triggers.ts";
import {
	SessionControlPlane,
	type SessionRuntimeActivity,
	type SessionRuntimeEventInput,
} from "./session-control-plane.ts";
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
	readWakeRunState,
	recordWakeOutcome,
	recordWakeStart,
	removeScheduledJobRunState,
	scheduledJobRunInterrupted,
	scheduledJobRunState,
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

const RPC_ENTRY = fileURLToPath(import.meta.resolve("@qorpera/pi-coding-agent/rpc-entry"));
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
const GITHUB_CONNECTION_DESTINATIONS = [
	["api.github.com", "GitHub API"],
	["uploads.github.com", "GitHub release uploads"],
	["raw.githubusercontent.com", "GitHub raw content"],
] as const;
const STAFF_DEFAULT_THINKING_LEVEL = "low";
const STAFF_DEFAULT_RESPONSE_SPEED = "fast";
const STAFF_TOOL_NAMES = "read,bash,edit,write,request_connection";
const MAX_KERNEL_REVIEW_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 5;
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
	// The founder's PUBLIC key only: the child verifies policy provenance in
	// the sandbox; signing stays with founder contexts (CLI + this kernel).
	const founderProjection = founderPublicProjection();
	if (founderProjection) writeFileSync(join(agentDir, FOUNDER_PUBLIC_FILE), founderProjection, "utf-8");
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
	selection?: ControllerModelSelection;
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
		readDefaultControllerModelPreference(userData),
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
			const companySelection = readControllerModelPreference(userData, company.root);
			if (!companySelection || companySelection.provider === info.selection.provider) continue;
			try {
				if (await runtime.getAuth(companySelection.provider)) continue;
			} catch {
				// Invalid profile-local credentials fall back to the account provider below.
			}
			writeControllerModelPreference(userData, company.root, info.selection);
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

let modelRequestBroker: ModelRequestBroker | undefined;
let modelAccountStore: ModelAccountStore | undefined;
let brokerModelRuntime: ModelRuntime | undefined;
let modelAccountUsageRefreshedAt = 0;
let modelAccountUsageRefreshInFlight: Promise<ModelAccountView[]> | undefined;
let qorperaAccountAuth: QorperaAccountAuth | undefined;
let currentQorperaAccountId: string | undefined;
let downloadedUpdateVersion: string | undefined;

function rememberAuthenticatedAccount(account: QorperaAccountInfo): QorperaAccountInfo {
	currentQorperaAccountId = account.authenticated && account.user ? account.user.id : undefined;
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
		return undefined;
	}
}

function claimExistingProfiles(account: QorperaAccountInfo): void {
	if (!account.user) return;
	claimUnownedProfiles(
		app.getPath("userData"),
		account.user.id,
		listCompanies().map((company) => company.root),
	);
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
	child: ChildProcessWithoutNullStreams;
	backendPort: number;
	backendClose?: () => void;
	backendToken: string;
	childOptions: ChildOptions;
	productWorker?: { department: string; worktree: string };
	/** Live wake session, if one is running (kernel-spawned, single-flight). */
	wakeChild?: ChildProcessWithoutNullStreams;
	/** Named scheduled job currently owning wakeChild; absent for event wakes. */
	wakeJobId?: string;
	/** Closes the inbound webhook listener (optional kernel module). */
	webhookClose?: () => void;
	/** An inbound event arrived while the company was busy; the wake ticker owes it a wake. */
	pendingInboundWake?: boolean;
	/** Prevent overlapping GitHub event polls for this open profile. */
	routineTriggerPolling?: boolean;
	inventoryWatcher?: ReturnType<typeof watch>;
	pendingInventoryRestart: boolean;
	transitionQueue: Promise<void>;
	/** Bounded crash-loop state for the replaceable attended RPC process. */
	runtimeReconnectAttempts: number;
	lastUnexpectedRuntimeExitAt?: number;
	/** During initial profile setup, return the attended runtime to the first
	 * selected staff member after the local intro queue has settled. */
	staffBootstrapReturn?: { staffAgentId: string; trailFile: string };
	closing: boolean;
	closePromise?: Promise<void>;
	runtimeLock: CompanyRuntimeLock;
}

/** One window = one slot: the hub while `runtime` is unset, a company
 * controller once one is open. All per-company state hangs off the slot so
 * controllers never share a child, a backend, or a kickoff flag. */
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

// Window/taskbar icon: the Qorpera mark by default; a company can carry its
// own at app/icon.(ico|png|jpg) — set from Settings → App, or by the
// controller itself (app/ is its territory).
const DEFAULT_ICON = join(DIRNAME, "assets", process.platform === "win32" ? "qorpera.ico" : "qorpera.png");
const ICON_NAMES = ["icon.ico", "icon.png", "icon.jpg", "icon.jpeg"];

function companyIcon(root: string): string {
	for (const name of ICON_NAMES) {
		const candidate = join(root, "app", name);
		if (existsSync(candidate)) return candidate;
	}
	return DEFAULT_ICON;
}

function setWindowIcon(win: BrowserWindow, iconPath: string): void {
	try {
		win.setIcon(iconPath);
	} catch {
		// an unreadable/corrupt image must never take the window down
	}
}
/** Children we killed on purpose (session switch/close) — their exits are not news. */
const intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>();
/** Every agent child still running, across all slots — quit reaps these
 * synchronously because window-close teardown is async and quit won't wait. */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();
const childBindings = new WeakMap<ChildProcessWithoutNullStreams, TrailBinding>();
const childIntentSigners = new WeakMap<
	ChildProcessWithoutNullStreams,
	(frame: Record<string, unknown>, attended: boolean) => KernelIntentCapability
>();
const childModelCapabilities = new WeakMap<ChildProcessWithoutNullStreams, BrokeredCredentials>();
const childHttpBrokers = new WeakMap<ChildProcessWithoutNullStreams, HttpRequestBroker>();
/** True between a delivered kernel prompt and the next agent_settled — a
 * founder turn in flight. Wakes must never preempt it. */
const childBusy = new WeakMap<ChildProcessWithoutNullStreams, boolean>();
const childApprovedGates = new WeakMap<ChildProcessWithoutNullStreams, Set<string>>();
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
interface ChildConnectionRequestCalls {
	pending: Map<string, StaffConnectionRequestToolInput>;
	completed: Set<string>;
}
const childConnectionRequestCalls = new WeakMap<ChildProcessWithoutNullStreams, ChildConnectionRequestCalls>();

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
			console.error(`session runtime degraded-state projection failed: ${(projectionError as Error).message}`);
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

/** A company root is a folder scaffolded as one — company.md is the anchor
 * every scaffold writes. Anything else must never be registered or started
 * (a bad argv token once created a "company" named after a Chromium switch). */
function isCompanyRoot(root: string): boolean {
	try {
		return existsSync(join(root, "company.md"));
	} catch {
		return false;
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
	if (win.isMinimized()) win.restore();
	win.focus();
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

interface ReviewedPromptFrame {
	type: "prompt" | "steer" | "follow_up";
	message: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	streamingBehavior?: "steer" | "followUp";
}

function reviewedPromptFrame(value: Record<string, unknown>): ReviewedPromptFrame | undefined {
	if (value.type !== "prompt" && value.type !== "steer" && value.type !== "follow_up") return undefined;
	if (typeof value.message !== "string" || Buffer.byteLength(value.message, "utf-8") > MAX_PROMPT_BYTES) {
		return undefined;
	}
	const allowed = new Set(["type", "message", "images", "streamingBehavior"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
	if (
		value.streamingBehavior !== undefined &&
		(value.type !== "prompt" || (value.streamingBehavior !== "steer" && value.streamingBehavior !== "followUp"))
	)
		return undefined;
	let images: ReviewedPromptFrame["images"];
	if (value.images !== undefined) {
		if (!Array.isArray(value.images) || value.images.length > MAX_PROMPT_IMAGES) return undefined;
		images = [];
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
		...(images && images.length > 0 ? { images } : {}),
		...(value.streamingBehavior ? { streamingBehavior: value.streamingBehavior } : {}),
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
			runtime.inventoryWatcher?.close();
			runtime.webhookClose?.();
			await runtime.transitionQueue;
			await stopChild(runtime.child);
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
 * Activity view) can tell controller-initiated sessions from chats.
 *
 * Product work is a role capability: product Chat roots a product-worker in
 * one assigned worktree. The controller never receives that capability.
 * Sessions still land in the company trail and name both department and
 * worktree so they can be restored without losing provenance. */
interface ChildOptions {
	sessionFile?: string;
	/** Initial display identity for a freshly attached session. Passed at
	 * process startup so attachment and naming cannot target different children. */
	sessionName?: string;
	/** Stable company-owned employee identity stamped into the trail header. */
	staffAgentId?: string;
	/** Kernel-built employee profile appended on every process launch. */
	staffProfile?: string;
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
	onRpcEvent?: (frame: Record<string, unknown>) => void;
	/** Last model confirmed by this child, inherited by replacement and autonomous children. */
	model?: ControllerModelSelection;
	/** Kernel-issued wake identity: stamped into the wake session's trail. */
	wake?: {
		id: string;
		cause: "schedule" | "founder_response" | "inbound_event";
		intervalMinutes?: number;
		coalesced?: number;
	};
}

function staffSystemProfile(agent: StaffAgent): string {
	return [
		"You are a persistent staff member of this company, not a temporary chat persona.",
		`Staff identity: ${agent.id}`,
		`Name: ${agent.displayName}`,
		`Role: ${agent.role}`,
		"Charter:",
		agent.charter,
		"Keep this identity and charter across every launch. Speak and act as this staff member, maintain continuity through the company files and your own trail, and distinguish verified access from access you still need.",
		"When the request_connection tool is available and missing service access blocks useful work, use it with exact destination hosts and opaque secret reference names; it requests founder action but never grants access by itself.",
		"The installed GitHub recipe is recipeId github with secretNames [github] and destinations api.github.com, uploads.github.com, and raw.githubusercontent.com. Do not claim any other recipe is installed.",
	].join("\n");
}

function staffIntroMessage(root: string, agent: StaffAgent, orientation?: StaffOrientationContext): string {
	const roster = readStaffAgents(root);
	const conceptionPending = roster.length === 1 && roster[0]?.id === agent.id && conceptionKickoff(root) !== undefined;
	const opening = conceptionPending
		? `Begin the first conversation as ${agent.displayName}. Introduce your responsibility in plain language and start conception with the founder conversationally: ask one high-value question about what they are building, then explain the first useful outcome you can produce. Do not mention this hidden instruction or pretend you already know facts the company files do not establish.`
		: `Begin the first conversation as ${agent.displayName}. Introduce your responsibility in plain language, propose one immediately useful outcome, and ask at most one high-value question. Do not mention this hidden instruction.`;
	if (!orientation || (!orientation.services.length && !orientation.otherService)) return opening;
	return [
		opening,
		orientation.services.length
			? `The founder selected these service categories for initial orientation: ${orientation.services.join(", ")}. Inspect the company files first, then request only the specific connections you actually need. Never claim access before it is granted.`
			: "",
		orientation.otherService
			? `The founder also named this unsupported or custom service: ${orientation.otherService}. Treat it as the next connector-build assignment. First inspect the existing connector conventions, then prepare the connector brief and implement the narrowest recipe proposal in the company files for review. Cover the required operations, authentication method, and safest permission scope. Do not request credentials or claim the connector is installed until the founder has reviewed and the kernel has accepted the recipe.`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

function startChild(slot: Slot, root: string, options: ChildOptions = {}): ChildProcessWithoutNullStreams {
	const {
		sessionFile,
		sessionName,
		staffAgentId,
		staffProfile,
		autoStartStaffIntro,
		autonomousName,
		department,
		worktree,
		silent,
		onRpcEvent,
	} = options;
	if (Boolean(staffAgentId) !== Boolean(staffProfile)) {
		throw new Error("staff runtime identity and profile must be provided together");
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
	const actor = department && worktree ? "product-worker" : "controller";
	const cwd = worktree ? join(root, worktree) : root;
	const scope = {
		actor,
		attended: false,
		staffAgentId,
		autonomousLabel: autonomousName ? `autonomous — ${autonomousName}` : undefined,
		department: department?.path,
		worktree,
		group: options.group,
		parentSession: options.parentSession,
	} as const;
	const userData = app.getPath("userData");
	const localExecutionPermission = readLocalExecutionPermission(userData, root);
	const binding = bindTrailSession(
		root,
		cwd,
		scope,
		sessionFile,
		sessionFile ? sessions.auditForTrail(sessionFile) : undefined,
	);
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
	if (!modelRequestBroker) throw new Error("kernel model-request broker is unavailable");
	const productWorktreeRoot = worktree ? realpathSync(cwd) : undefined;
	const checkpointDir = join(dirname(sandboxConfigDir(userData, root, "controller")), "checkpoints");
	reconcilePendingProductCheckpoints(checkpointDir, root);
	snapshotFounderGitState(root);
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
	const brokeredCredentials = modelRequestBroker.registerChild(
		binding.sessionId,
		sourceModelCredentials(),
		ambientModelProviders(),
		(event) => appendKernelModelObservation(binding, event),
	);
	// Generic outbound HTTP (Build 3): destination capabilities and secret
	// references are resolved kernel-side; every attempt is trail-observed
	// and must ride a kernel-signed causal intent (parity with the model lane).
	// File mode streams into/out of company territory only: escapes and
	// kernel-protected paths (trail, policy, inbox, .git, legacy shell storage,
	// product code) are denied before any network contact.
	const resolveCompanyPath = createCompanyFileResolver(root, [
		...protectedControllerPaths(root, products),
		join(root, "userland"),
	]);
	const httpBroker = createHttpRequestBroker({
		sessionId: binding.sessionId,
		allowedDestination: (url) => destinationAllowed(root, url),
		resolveSecret: (name) => resolveCompanySecret(root, name),
		companyFile: {
			resolveForWrite: (relativePath) => resolveCompanyPath(relativePath, "write"),
			resolveForRead: (relativePath) => resolveCompanyPath(relativePath, "read"),
		},
		observe: (event) => appendKernelHttpObservation(binding, event),
	});
	let agentDir: string;
	let invocation: { command: string; args: string[] };
	let kernelSigner: ReturnType<typeof createKernelResponseSigner>;
	let child: ChildProcessWithoutNullStreams;
	const executorId = randomUUID();
	const env: NodeJS.ProcessEnv = brokeredChildEnvironment();
	Object.assign(env, sandboxGitEnvironment([root, ...(productWorktreeRoot ? [productWorktreeRoot] : [])]));
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
		writeSandboxProfile(configDir, runtimeDir, root, scope, protectedControllerPaths(root, products), [
			...FOUNDATION_READ_PATHS,
			join(configDir, "config.toml"),
			join(agentDir, "auth.json"),
			join(agentDir, "trust.json"),
			join(agentDir, FOUNDER_PUBLIC_FILE),
		]);
		provisionSandbox({
			codexEntry: CODEX_ENTRY,
			configDir,
			runtimeDir,
			nodeExecutable: process.execPath,
			env,
		});
		const rpcArgs = [
			RPC_ENTRY,
			"--mode",
			"rpc",
			"--session",
			binding.path,
			...(staffProfile ? ["--append-system-prompt", staffProfile] : []),
			...(staffAgentId && (!sessionFile || options.freshStaffTrail)
				? ["--thinking", STAFF_DEFAULT_THINKING_LEVEL]
				: []),
			...localExecutionToolArgs(localExecutionPermission, staffAgentId ? STAFF_TOOL_NAMES : undefined),
			...controllerModelArgs(options.model),
		];
		invocation = codexSpawn(
			CODEX_ENTRY,
			process.execPath,
			sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, rpcArgs),
		);
		kernelSigner = createKernelResponseSigner({ sessionId: binding.sessionId });
	} catch (error) {
		httpBroker.release();
		brokeredCredentials.release();
		throw error;
	}
	// QORPERA_AUTONOMOUS marks controller-initiated work: those sessions run
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
		throw error;
	}
	trackChildReadiness(child);
	liveChildren.add(child);
	// stdin write failures land asynchronously as an "error" event; without a
	// listener they become an uncaughtException that takes down the app.
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (!silent) send(win(), "rpc-log", `child stdin ${error.code ?? error.message}: frame dropped`);
	});
	childBindings.set(child, binding);
	childExecutorIds.set(child, executorId);
	if (attachmentSequence !== undefined) childAttachmentSequences.set(child, attachmentSequence);
	childSessionPlanes.set(child, sessions);
	childIntentSigners.set(child, kernelSigner.signIntent);
	childModelCapabilities.set(child, brokeredCredentials);
	childHttpBrokers.set(child, httpBroker);
	childApprovedGates.set(child, new Set());
	let resolveCheckpoint: (() => void) | undefined;
	childCheckpointCompletion.set(
		child,
		new Promise<void>((resolvePromise) => {
			resolveCheckpoint = resolvePromise;
		}),
	);
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		try {
			const frame = JSON.parse(line) as unknown;
			const confirmedModel = modelSelectionFromRpcFrame(frame);
			if (confirmedModel) {
				options.model = confirmedModel;
				writeControllerModelPreference(app.getPath("userData"), root, confirmedModel);
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
				const append = parseTrailAppendFrame(frame, binding);
				if (append) {
					appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
					commitTrailAppend(binding, append);
				} else send(win(), "rpc-log", "rejected invalid trail append frame");
				return;
			}
			observeStaffConnectionRequestFrame(slot, root, child, staffAgentId, binding, frame as Record<string, unknown>);
			const activity = sessionActivityFromFrame(frame as Record<string, unknown>);
			if (activity) observeSessionActivity(sessions, binding, executorId, activity);
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
					scheduleNextQueuedStaffIntro(slot, child);
				} else if (wakeFrameFailed(staffFrame)) {
					finishStaffIntroDurably(root, staffAgentId, binding.file, false, "staff intro model request failed");
				} else if (staffFrame.type === "agent_settled") {
					finishStaffIntroDurably(root, staffAgentId, binding.file, true);
				}
			}
			if ((frame as { type?: unknown }).type === "agent_settled") {
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
				const currentRuntime = slot.runtime;
				if (currentRuntime?.child === child && currentRuntime.pendingInventoryRestart && !currentRuntime.closing) {
					currentRuntime.pendingInventoryRestart = false;
					restartForProductInventory(slot, currentRuntime);
				}
				brokeredCredentials.endTurn("completed");
				httpBroker.endTurn();
				try {
					const result = checkpointCompanyGit(root, gitBaseline, binding.file);
					gitBaseline = result.baseline;
					savePendingCompanyCheckpoint(checkpointState, root, gitBaseline, binding.file);
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
					}
				} catch (error) {
					// The turn did settle. Keep the lifecycle callback moving so an
					// autonomous child cannot become a finishing zombie; close-time
					// reconciliation retries the checkpoint from its saved baseline.
					console.error(`session checkpoint failed: ${(error as Error).message}`);
				}
				if (staffAgentId) scheduleNextQueuedStaffIntro(slot, child);
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
		try {
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
			brokeredCredentials.release();
			const result = checkpointCompanyGit(root, gitBaseline, binding.file);
			finishPendingCompanyCheckpoint(checkpointState, result);
			if (!result.success) savePendingCompanyCheckpoint(checkpointState, root, result.baseline, binding.file);
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
		} catch (error) {
			// Child close is an ownership handoff signal. Bookkeeping failure must
			// never abort later wake/merge listeners that clear that ownership.
			console.error(`session close checkpoint failed: ${(error as Error).message}`);
		} finally {
			resolveCheckpoint?.();
		}
	});
	return child;
}

function sendKernelPrompt(
	child: ChildProcessWithoutNullStreams,
	frame: ReviewedPromptFrame,
	attended: boolean,
	origin: string,
): boolean {
	const binding = childBindings.get(child);
	const signIntent = childIntentSigners.get(child);
	if (!binding || !signIntent || child.exitCode !== null) return false;
	const unsignedFrame = { ...frame };
	const kernelIntent = signIntent(unsignedFrame, attended);
	if (!childModelCapabilities.get(child)?.authorizeIntent(kernelIntent)) return false;
	// The same intent authorizes the HTTP lane: both brokers track their own
	// usage of the shared per-turn capability.
	childHttpBrokers.get(child)?.authorizeIntent(kernelIntent);
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
function sendKernelStaffIntro(child: ChildProcessWithoutNullStreams, message: string): boolean {
	const binding = childBindings.get(child);
	const signIntent = childIntentSigners.get(child);
	if (!binding || !signIntent || child.exitCode !== null) return false;
	const frame = { type: "staff_intro" as const, message };
	const kernelIntent = signIntent(frame, false);
	if (!childModelCapabilities.get(child)?.authorizeIntent(kernelIntent)) return false;
	childHttpBrokers.get(child)?.authorizeIntent(kernelIntent);
	appendKernelObservation(binding, {
		frameType: "staff_intro",
		message,
		attended: false,
		origin: "kernel-staff-intro",
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
			origin: "kernel-staff-intro",
		})
	) {
		childModelCapabilities.get(child)?.endTurn("aborted");
		childHttpBrokers.get(child)?.endTurn();
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
		killChildTree(child);
		return false;
	}
	return true;
}

async function replaceRuntimeChild(slot: Slot, runtime: CompanyRuntime, options: ChildOptions): Promise<void> {
	const previousOptions = runtime.childOptions;
	await stopChild(runtime.child);
	if (slot.runtime !== runtime) return;
	try {
		runtime.childOptions = { ...options };
		runtime.child = startChild(slot, runtime.root, runtime.childOptions);
		// startChild durably stamps the creation-time name before spawning. It is
		// therefore safe—and necessary—to keep reconnects from appending it again.
		delete runtime.childOptions.sessionName;
		runtime.runtimeReconnectAttempts = 0;
		runtime.lastUnexpectedRuntimeExitAt = undefined;
	} catch (error) {
		// The old child is already dead — a failed swap must not leave the
		// company without an agent (a legacy-session bind failure did exactly
		// that: every later composer send talked to a corpse).
		if (slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, previousOptions, "chat-swap controller restore failed");
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
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || childBusy.get(runtime.child)) {
			return false;
		}
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
		report("Connected. Refreshing the active controller…");
		const refreshed = await refreshSlotModelCredentials(slot);
		const message = !slot.runtime
			? "Connected."
			: refreshed
				? "Connected. The active controller is ready to use it."
				: "Connected. It will be available when the current controller turn finishes.";
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
	if (!selection || !writeDefaultControllerModelPreference(userData, selection)) {
		return { ok: false, error: "could not persist the default intelligence" };
	}
	if (!writeIntelligenceAccountBinding(userData, { accountUserId: account.user.id, providerId })) {
		return { ok: false, error: "could not connect this intelligence to your Qorpera account" };
	}
	if (!boundToThisAccount) {
		for (const company of listCompanies()) writeControllerModelPreference(userData, company.root, selection);
	}
	const slot = slotOf(sender);
	if (slot?.runtime) writeControllerModelPreference(userData, slot.runtime.root, selection);
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
	const usesConnection = (selection: ControllerModelSelection | undefined): boolean =>
		Boolean(selection && connection.credentialProviders.some((providerId) => providerId === selection.provider));
	const activeUsesConnection = usesConnection(slot.runtime?.childOptions.model);
	const companyRootsUsingConnection = listCompanies()
		.filter((company) => usesConnection(readControllerModelPreference(userData, company.root)))
		.map((company) => company.root);
	if (usesConnection(readDefaultControllerModelPreference(userData))) clearDefaultControllerModelPreference(userData);
	for (const root of companyRootsUsingConnection) clearControllerModelPreference(userData, root);
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
	if (!root) return { ok: false, error: "Open a profile before disconnecting GitHub." };
	try {
		removeCompanySecret(root, "github");
		for (const [host] of GITHUB_CONNECTION_DESTINATIONS) removeNetworkDestination(root, host);
		return { ok: true, message: "GitHub disconnected from this profile." };
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
		clearDefaultControllerModelPreference(userData),
		...listCompanies().map((company) => clearControllerModelPreference(userData, company.root)),
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
			const approved = await confirmKernelReview(slot.window, {
				title: "Connect GitHub",
				summary: "Allow this company controller to use the selected GitHub account?",
				exactText: [
					`Account: ${account.accountName}`,
					`Scopes: ${account.scopes.join(", ") || "GitHub CLI defaults"}`,
					"Credential: secret://github (kernel-held; never shown to the controller)",
					`Destinations: ${GITHUB_CONNECTION_DESTINATIONS.map(([host]) => host).join(", ")}`,
				].join("\n"),
			});
			if (!approved) return { ok: false, cancelled: true };
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

function scheduleRuntimeReconnect(
	slot: Slot,
	runtime: CompanyRuntime,
	exitedChild: ChildProcessWithoutNullStreams,
	sessionFile: string,
	model: ControllerModelSelection | undefined,
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
		runtime.child = startChild(slot, runtime.root, resumeOptions);
	}).catch((error) => {
		console.error(`controller runtime reconnect failed: ${(error as Error).message}`);
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

function isCurrentRuntimeChild(slot: Slot, runtime: CompanyRuntime, child: ChildProcessWithoutNullStreams): boolean {
	return slot.runtime === runtime && !runtime.closing && runtime.child === child && child.exitCode === null;
}

function restartForProductInventory(slot: Slot, runtime: CompanyRuntime): void {
	void enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.wakeChild) return;
		if (childBusy.get(runtime.child)) {
			runtime.pendingInventoryRestart = true;
			return;
		}
		runtime.pendingInventoryRestart = false;
		const options = {
			...runtime.childOptions,
			sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
		};
		await stopChild(runtime.child);
		if (slot.runtime !== runtime) return;
		try {
			readProductProtectionInventory(runtime.root);
		} finally {
			await restoreAttendedChild(slot, runtime, options, "product-inventory controller restore failed");
		}
	}).catch((error) => {
		console.error(`product inventory transition stopped the controller: ${(error as Error).message}`);
	});
}

function isInside(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Build the exact unattended prompt for a scheduled or event-driven run. */
function wakePrompt(
	cause: "schedule" | "founder_response" | "inbound_event",
	coalesced: number,
	job?: ScheduledJob,
	trigger?: PendingRoutineTrigger,
): string {
	const missed =
		coalesced > 0
			? ` The kernel was closed or asleep for a while: ${coalesced} missed wake${coalesced === 1 ? "" : "s"} were coalesced into this one.`
			: "";
	if (cause === "founder_response") {
		return `Wake: the founder responded in the inbox. Read the updated items and continue the affected work; post follow-up inbox items for anything that needs the founder again.${missed}`;
	}
	if (cause === "inbound_event") {
		if (job && trigger) {
			return `Triggered routine: ${job.title}.\n\nEvent: ${trigger.event.summary}\nSource: ${trigger.event.source}${trigger.event.repository ? `\nRepository: ${trigger.event.repository}` : ""}${trigger.event.actor ? `\nActor: ${trigger.event.actor}` : ""}\nThe full event is stored under inbox/events/.\n\n${job.prompt}`;
		}
		return `Wake: an external event arrived. Read the new files under inbox/events/, decide what they mean for the company, and act; events are durable, so handle every unprocessed one, not just the newest.${missed}`;
	}
	return `Scheduled job: ${job?.title ?? "Company orchestration"}.${missed}\n\n${job?.prompt ?? "Read company.md, the inbox, and app/routines/, decide for yourself what most needs doing, and do it. Post inbox/messages items for anything that needs the founder; when nothing needs doing, settle without inventing work."}`;
}

/** Reduce provider-specific stream frames to a small session activity
 * vocabulary. Content deltas stay on the attached chat's RPC stream; these
 * ephemeral phase changes render identically in every live observer. */
function sessionActivityFromFrame(frame: Record<string, unknown>): SessionRuntimeActivity | undefined {
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
		(args.recipeId !== undefined && typeof args.recipeId !== "string") ||
		Object.keys(args).some(
			(key) => !["displayName", "purpose", "destinations", "secretNames", "recipeId"].includes(key),
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
		...(typeof args.recipeId === "string" ? { recipeId: args.recipeId } : {}),
	};
}

function observeStaffConnectionRequestFrame(
	slot: Slot,
	root: string,
	child: ChildProcessWithoutNullStreams,
	staffAgentId: string | undefined,
	binding: TrailBinding,
	frame: Record<string, unknown>,
): void {
	if (
		!staffAgentId ||
		(frame.type !== "tool_execution_start" && frame.type !== "tool_execution_end") ||
		frame.toolName !== "request_connection" ||
		typeof frame.toolCallId !== "string" ||
		!frame.toolCallId ||
		Buffer.byteLength(frame.toolCallId, "utf-8") > 512
	) {
		return;
	}
	const calls = childConnectionRequestCalls.get(child) ?? {
		pending: new Map<string, StaffConnectionRequestToolInput>(),
		completed: new Set<string>(),
	};
	childConnectionRequestCalls.set(child, calls);
	if (calls.completed.has(frame.toolCallId)) return;
	if (frame.type === "tool_execution_start") {
		if (calls.pending.has(frame.toolCallId)) return;
		const input = parsedStaffConnectionRequestToolInput(frame.args);
		if (input) calls.pending.set(frame.toolCallId, input);
		return;
	}
	const input = calls.pending.get(frame.toolCallId);
	calls.pending.delete(frame.toolCallId);
	calls.completed.add(frame.toolCallId);
	if (!input || frame.isError !== false) return;
	const runtime = slot.runtime;
	const attachedStaffChild =
		runtime && isCurrentRuntimeChild(slot, runtime, child) && runtime.childOptions.staffAgentId === staffAgentId;
	const scheduledStaffChild =
		runtime?.wakeChild === child && runtime.wakeJobId !== undefined && runtime.child !== child;
	if (!runtime || (!attachedStaffChild && !scheduledStaffChild)) {
		return;
	}
	if (!activeStaffAgent(root, staffAgentId)) return;
	try {
		const request = createConnectionRequest(app.getPath("userData"), root, {
			staffAgentId,
			sessionFile: binding.file,
			...input,
		});
		send(slot.window, "connection-requests-changed", projectConnectionRequest(request));
	} catch (error) {
		console.error(`staff connection request rejected: ${(error as Error).message}`);
	}
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
			`# Scheduled job suspended by the kernel\n\n**${job.title}** ended unsuccessfully ${WAKE_FAILURE_SUSPENSION_THRESHOLD} consecutive times, so the kernel suspended this job rather than keep spending. Review its recent runs under Activity, then re-enable it from the scheduled-job details panel.\n`,
			"utf-8",
		);
	}
	return { suspend: outcome.suspend };
}

/**
 * Run a wake as its OWN autonomous session, serialized against everything
 * else (Build 4): the chat child is stopped first and resumed after — one
 * environment writer at a time — and wakes are single-flight (never while
 * a merge or another wake runs). The wake's causal identity is stamped
 * into its trail session; its outcome feeds the failure streak, and at
 * the threshold the kernel suspends the schedule and posts a
 * founder-visible inbox item — escalation that does not depend on the
 * controller.
 */
async function startWakeChildExclusive(
	slot: Slot,
	runtime: CompanyRuntime,
	cause: "schedule" | "founder_response" | "inbound_event",
	coalesced: number,
	job?: ScheduledJob,
	manual = false,
	trigger?: PendingRoutineTrigger,
): Promise<boolean> {
	if (runtime.wakeChild || runtime.closing) return false;
	// Never preempt a founder turn in flight: the wake defers to the next tick.
	if (childBusy.get(runtime.child)) return false;
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
	const wakeId = randomUUID();
	const resumeOptions = {
		...runtime.childOptions,
		sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
	};
	await stopChild(runtime.child);
	if (slot.runtime !== runtime || runtime.closing) return false;
	let started = false;
	let settledCleanly = false;
	let failed = false;
	let promptSent = false;
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startChild(slot, runtime.root, {
			autonomousName:
				cause === "schedule" && job
					? `wake — scheduled-job:${job.id} — ${job.title}`
					: cause === "inbound_event"
						? "wake — inbound event"
						: cause === "founder_response"
							? "wake — founder response"
							: "wake — schedule",
			group: job ? `job:${job.id}` : `wake:${cause}`,
			...(assignedStaff ? { staffAgentId: assignedStaff.id, staffProfile: staffSystemProfile(assignedStaff) } : {}),
			silent: true,
			model: resumeOptions.model,
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
		if (slot.runtime === runtime && !runtime.closing) {
			await restoreAttendedChild(slot, runtime, resumeOptions, "wake-start controller restore failed");
		}
		return false;
	}
	runtime.wakeChild = child;
	runtime.wakeJobId = job?.id;
	const trailFile = childBindings.get(child)?.file;
	child.on("close", () => {
		void enqueueRuntimeTransition(runtime, async () => {
			await childCheckpointCompletion.get(child);
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild !== child) return;
			runtime.wakeChild = undefined;
			runtime.wakeJobId = undefined;
			try {
				if (job && promptSent) {
					persistScheduledJobOutcome(runtime, job, settledCleanly, trailFile);
				}
			} catch (error) {
				console.error(`wake bookkeeping failed: ${(error as Error).message}`);
			}
			await restoreAttendedChild(slot, runtime, resumeOptions, "post-wake controller restore failed");
		}).catch((error) => console.error(`wake ownership transition failed: ${(error as Error).message}`));
	});
	if (assignedStaff && !(await waitForChildReadiness(child))) {
		console.error(
			`staff-owned scheduled job runtime did not become ready: ${job?.title ?? assignedStaff.displayName}`,
		);
		await stopChild(child);
		return false;
	}
	if (
		!sendKernelPrompt(
			child,
			{ type: "prompt", message: wakePrompt(cause, coalesced, job, trigger) },
			false,
			`kernel-wake-${cause}`,
		)
	) {
		await stopChild(child);
		return false;
	}
	promptSent = true;
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
	cause: "schedule" | "founder_response" | "inbound_event",
	coalesced: number,
	job?: ScheduledJob,
	manual = false,
	trigger?: PendingRoutineTrigger,
): Promise<boolean> {
	return enqueueRuntimeTransition(runtime, () =>
		startWakeChildExclusive(slot, runtime, cause, coalesced, job, manual, trigger),
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
			writeRoutineTriggerState(path, removePendingRoutineTrigger(triggerState, pending.id));
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
 * The kernel's clock (Build 4): once a minute, fire due scheduled wakes for
 * open companies. Wakes fire only while their company environment is open
 * in the shell; time spent closed is covered by the coalescing missed-wake
 * policy on the next open.
 */
function startWakeTicker(): void {
	setInterval(() => {
		for (const slot of slots.values()) {
			const runtime = slot.runtime;
			if (!runtime || runtime.closing || runtime.wakeChild) continue;
			if (childBusy.get(runtime.child)) continue;
			// Inbound events that arrived mid-turn come first: their files are
			// already durable, they just never got their wake.
			if (runtime.pendingInboundWake) {
				runtime.pendingInboundWake = false;
				void startWakeChild(slot, runtime, "inbound_event", 0)
					.then((started) => {
						if (!started && slot.runtime === runtime && !runtime.closing) runtime.pendingInboundWake = true;
					})
					.catch((error) => {
						console.error(`inbound wake failed for ${runtime.root}: ${(error as Error).message}`);
						if (slot.runtime === runtime && !runtime.closing) runtime.pendingInboundWake = true;
					});
				continue;
			}
			try {
				const jobs = readScheduledJobs(runtime.root);
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

async function restoreAttendedChild(
	slot: Slot,
	runtime: CompanyRuntime,
	options: ChildOptions,
	context: string,
): Promise<boolean> {
	for (const delay of [0, 250, 750, 2_000]) {
		if (delay) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delay));
		if (slot.runtime !== runtime || runtime.closing) return false;
		try {
			runtime.childOptions = options;
			runtime.child = startChild(slot, runtime.root, options);
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

interface ActiveCompany {
	root: string;
	/** Stable company identity — the renderer keys its localStorage by this,
	 * never by the (port-derived, collision-walked) backendUrl. */
	id: string;
	profileIcon: ProfileIconId;
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
	const autonomousChild = runtime.wakeChild?.exitCode === null ? runtime.wakeChild : undefined;
	const runState = readWakeRunState(wakeRunStatePath(app.getPath("userData"), runtime.root));
	const now = Date.now();
	const scheduledJobs = readScheduledJobs(runtime.root).map((job) => {
		const jobState = scheduledJobRunState(runState, job.id);
		const lastRunMs = jobState.lastWakeAt ? Date.parse(jobState.lastWakeAt) : Number.NaN;
		const intervalMinutes = scheduledJobIntervalMinutes(job);
		const nextRunAt =
			job.enabled && !job.suspendedReason && intervalMinutes !== undefined
				? new Date(Number.isFinite(lastRunMs) ? lastRunMs + intervalMinutes * 60_000 : now).toISOString()
				: undefined;
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
		profileIcon: currentQorperaAccountId
			? readProfileIcon(app.getPath("userData"), currentQorperaAccountId, runtime.root)
			: DEFAULT_PROFILE_ICON_ID,
		backendUrl: `http://127.0.0.1:${runtime.backendPort}`,
		kickoff: false,
		wakeRunning: Boolean(runtime.wakeChild && runtime.wakeChild.exitCode === null),
		autonomousTrailFile: autonomousChild ? childBindings.get(autonomousChild)?.file : undefined,
		scheduledJobs,
		sessionFile: childBindings.get(runtime.child)?.file,
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
	let pendingChild: ChildProcessWithoutNullStreams | undefined;
	let installedRuntime: CompanyRuntime | undefined;
	try {
		// The scaffold is how kernel upgrades reach existing companies: an
		// idempotent spine fill (never overwriting company content) so a
		// company conceived under an older kernel passes current validation.
		scaffoldCompany(root);
		validateCompanyKernelStorage(root);
		const userData = app.getPath("userData");
		reconcileInterruptedStaffIntros(root);
		const checkpointDir = join(dirname(sandboxConfigDir(userData, root, "controller")), "checkpoints");
		reconcilePendingProductCheckpoints(checkpointDir, root);
		const hasLocalKernelState = hasCompanyKernelState(userData, root);
		if (!hasLocalKernelState) materializeClonedProductStorage(root);
		readProductProtectionInventory(root);
		const productStorage = reconcileCompanyProductStorage(
			userData,
			root,
			readProductStorageExpectations(root),
			!hasLocalKernelState,
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
		enforceCompanyKernelSettings(root);
		// Pre-projection companies: fold app/manifest.json surfaces into
		// app/projection.json (files untouched) and drop the dead key.
		migrateLegacyManifestSurfaces(root);
		registerCompany(root);
		const fixedShellMigration = migrateCompanyToFixedShell(root);
		if (fixedShellMigration.removed) {
			console.log(
				`removed legacy company shell (${fixedShellMigration.filesRemoved} files, ${fixedShellMigration.versionsRemoved} saved versions): ${root}`,
			);
		}
		commitCompanyMaterialization(root, [
			join(".qorpera", "settings.json"),
			"userland",
			join("app", "manifest.json"),
			join("app", "projection.json"),
		]);

		// Backend for surfaces/state/inbox — reused machinery, in-process. The
		// token guards mutating endpoints; only the renderer ever receives it.
		// Founder continuity across restarts: sweep the contentless trail files
		// earlier opens minted (they carry no memory), then reopen the founder
		// chat most recently attached by the kernel instead of creating a fresh
		// session per open.
		const swept = pruneEmptyTrailSessions(root);
		if (swept > 0) console.log(`pruned ${swept} contentless trail session${swept === 1 ? "" : "s"}`);
		// Reconstruct the company-owned session state before any new executor
		// attaches. The backend and every child share this one projection.
		const sessionCachePath = join(dirname(companyKernelStatePath(app.getPath("userData"), root)), "sessions-v2.json");
		const sessions = await SessionControlPlane.create(root, KERNEL_INSTANCE_ID, sessionCachePath);
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		pendingSessions = sessions;
		sessionControlPlanes.set(normalizedRoot(root), sessions);
		const backendToken = randomUUID();
		const backend = await listenBackend(root, backendToken, sessions);
		pendingBackendClose = backend.close;
		if (openingCancelled()) throw new CompanyOpenCancelledError();
		const resumable = sessions.latestAttendedControllerTrailFile() ?? latestResumableTrailSession(root);
		// Startup may resume only a legacy/unowned controller conversation.
		// Staff trails carry explicit identity and are opened by staff:open. A
		// fresh company stays idle with an empty roster; its first employee's
		// hidden staff_intro begins conception conversationally.
		// A resumed trail records the model that session last used, but the
		// founder's confirmed preference is newer authority. Pass it on every
		// controller launch so reopening an old chat cannot silently move the
		// controller, and the scheduled jobs it spawns, back to a stale model.
		const childOptions: ChildOptions = controllerLaunchOptions(app.getPath("userData"), root, undefined, resumable);
		const child = startChild(slot, root, childOptions);
		pendingChild = child;
		const childBinding = childBindings.get(child);
		if (childBinding && productStorage.unhydrated.length > 0) {
			appendKernelProductStorageObservation(childBinding, {
				status: "hydration-required",
				paths: productStorage.unhydrated.map(({ path, kind }) => ({
					path,
					kind,
				})),
			});
		}
		const runtime: CompanyRuntime = {
			root,
			sessions,
			storageId,
			child,
			childOptions,
			backendPort: backend.port,
			backendClose: backend.close,
			backendToken,
			transitionQueue: Promise.resolve(),
			runtimeReconnectAttempts: 0,
			pendingInventoryRestart: false,
			closing: false,
			runtimeLock,
		};
		installedRuntime = runtime;
		slot.runtime = runtime;
		pendingChild = undefined;
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
				onEvent: (_file, triggerEvent) => {
					const live = slot.runtime;
					if (!live || live.closing) return;
					if (triggerEvent) {
						const path = routineTriggerStatePath(app.getPath("userData"), live.root);
						const previous = readRoutineTriggerState(path);
						const queued = queueCustomRoutineTrigger(readScheduledJobs(live.root), previous, triggerEvent);
						if (queued.pending.length > previous.pending.length) {
							writeRoutineTriggerState(path, queued);
							if (!live.wakeChild && !childBusy.get(live.child))
								void dispatchRoutineTrigger(slot, live, readScheduledJobs(live.root));
							return;
						}
					}
					if (live.wakeChild || childBusy.get(live.child)) {
						live.pendingInboundWake = true;
						return;
					}
					void startWakeChild(slot, live, "inbound_event", 0).then((started) => {
						if (!started && slot.runtime === live && !live.closing) live.pendingInboundWake = true;
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
			setWindowIcon(win, companyIcon(root));
			await win.loadURL(companyShellUrl(runtime));
			if (slot.openGeneration !== openGeneration || slot.runtime !== runtime) {
				swap?.abort();
				if (slot.runtime === runtime) await closeCompany(slot);
				return;
			}
			swap?.commit();
		} catch (loadError) {
			swap?.abort();
			throw loadError;
		}
	} catch (error) {
		if (installedRuntime) {
			if (slot.runtime === installedRuntime) await closeCompany(slot);
			else await installedRuntime.closePromise;
		} else {
			if (pendingChild) await stopChild(pendingChild);
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
					`Kernel assignment created: ${assignment.createdAt}`,
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
	};
	try {
		// Pre-pivot chats carry old-schema trail headers the bind refuses;
		// a founder explicitly opening one IS the sanctioned migration moment.
		if (options.sessionFile) {
			migrateLegacyTrailSession(runtime.root, options.sessionFile, {
				actor: department && worktree ? "product-worker" : "controller",
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
		sessionFile: childBindings.get(runtime.child)?.file,
		department: department?.path,
		worktree,
	};
}

function activeStaffAgent(root: string, staffAgentId: string): StaffAgent | undefined {
	return readStaffAgents(root).find((agent) => agent.id === staffAgentId && agent.employmentStatus === "active");
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
	const currentBinding = childBindings.get(runtime.child);
	if (
		runtime.childOptions.staffAgentId === agent.id &&
		currentBinding !== undefined &&
		currentBinding.file === sessionFile &&
		isCurrentRuntimeChild(slot, runtime, runtime.child)
	) {
		return { sessionFile: currentBinding.file };
	}
	const resumeOptions: ChildOptions = {
		...runtime.childOptions,
		sessionFile: currentBinding?.file ?? runtime.childOptions.sessionFile,
	};
	await stopChild(runtime.child);
	if (slot.runtime !== runtime || runtime.closing) throw new Error("company runtime changed before staff attachment");
	let child: ChildProcessWithoutNullStreams | undefined;
	try {
		const options: ChildOptions = {
			sessionFile,
			...(sessionFile ? {} : { sessionName: agent.displayName }),
			staffAgentId: agent.id,
			staffProfile: staffSystemProfile(agent),
			model: runtime.childOptions.model,
			...(autoStartStaffIntro ? { autoStartStaffIntro: true, freshStaffTrail: true } : {}),
		};
		child = startChild(slot, runtime.root, options);
		const binding = childBindings.get(child);
		if (!binding) throw new Error("staff runtime did not receive a trail binding");
		if (markIntroPending) {
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			const pending = recordStaffIntroPending(readStaffRuntimeState(statePath), agent.id, binding.file, Date.now());
			writeStaffRuntimeState(statePath, pending);
		}
		runtime.childOptions = options;
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
		await restoreAttendedChild(slot, runtime, resumeOptions, "staff-attachment controller restore failed");
		throw error;
	}
}

const STAFF_AVATAR_COLORS = new Set([
	"#ff642e",
	"#ff365e",
	"#ffae00",
	"#00c878",
	"#00bfb3",
	"#1684ff",
	"#8a4dff",
	"#ff2994",
	"#5367e8",
]);
const STAFF_AVATAR_SHAPES = new Set(["soft-square", "round", "wide", "gem", "tilted", "drop"]);

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
		const record = input.appearance as Record<string, unknown>;
		if (
			Object.keys(record).some((key) => key !== "color" && key !== "shape") ||
			typeof record.color !== "string" ||
			typeof record.shape !== "string" ||
			!STAFF_AVATAR_COLORS.has(record.color) ||
			!STAFF_AVATAR_SHAPES.has(record.shape)
		) {
			throw new Error("invalid staff appearance");
		}
		appearance = { color: record.color, shape: record.shape };
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
	if (!runtime) return { ok: false, error: "open a profile before adding staff" };
	return enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || childBusy.get(runtime.child)) {
			return { ok: false, error: "profile runtime is busy" };
		}
		if (readStaffAgents(runtime.root).some((staff) => staff.employmentStatus === "active")) {
			return { ok: false, error: "this profile already has staff; use Add staff instead" };
		}
		const resumeOptions: ChildOptions = {
			...runtime.childOptions,
			sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
		};
		await stopChild(runtime.child);
		if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "profile runtime changed" };
		let staffChild: ChildProcessWithoutNullStreams | undefined;
		let created: StaffAgent[] = [];
		try {
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
						},
					};
				}),
			);
			const statePath = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
			let introState = readStaffRuntimeState(statePath);
			const bindings = created.map((staff) => {
				const binding = bindTrailSession(runtime.root, runtime.root, {
					actor: "controller",
					attended: false,
					staffAgentId: staff.id,
				});
				appendKernelSessionInfo(binding, staff.displayName);
				runtime.sessions.rememberAudit(binding);
				introState = recordStaffIntroPending(introState, staff.id, binding.file, Date.now());
				return binding;
			});
			writeStaffRuntimeState(statePath, introState);
			commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
			const first = created[0]!;
			const firstBinding = bindings[0]!;
			const options: ChildOptions = {
				sessionFile: firstBinding.file,
				staffAgentId: first.id,
				staffProfile: staffSystemProfile(first),
				model: resumeOptions.model,
				freshStaffTrail: true,
				autoStartStaffIntro: true,
			};
			staffChild = startChild(slot, runtime.root, options);
			runtime.childOptions = options;
			delete runtime.childOptions.freshStaffTrail;
			delete runtime.childOptions.autoStartStaffIntro;
			runtime.child = staffChild;
			runtime.productWorker = undefined;
			runtime.staffBootstrapReturn = { staffAgentId: first.id, trailFile: firstBinding.file };
			runtime.runtimeReconnectAttempts = 0;
			runtime.lastUnexpectedRuntimeExitAt = undefined;
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
			await restoreAttendedChild(slot, runtime, resumeOptions, "staff-bootstrap controller restore failed");
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
		if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || childBusy.get(runtime.child)) {
			return { ok: false, error: "company runtime is busy" };
		}
		const resumeOptions: ChildOptions = {
			...runtime.childOptions,
			sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
		};
		await stopChild(runtime.child);
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
					color: input.appearance?.color ?? template?.avatarColorToken ?? "#1684ff",
					shape: input.appearance?.shape ?? template?.avatarShapeToken ?? "round",
				},
			});
			commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
			const options: ChildOptions = {
				sessionName: staff.displayName,
				staffAgentId: staff.id,
				staffProfile: staffSystemProfile(staff),
				model: resumeOptions.model,
			};
			staffChild = startChild(slot, runtime.root, options);
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
			runtime.child = staffChild;
			runtime.productWorker = undefined;
			runtime.runtimeReconnectAttempts = 0;
			runtime.lastUnexpectedRuntimeExitAt = undefined;
			return { ok: true, staff, sessionFile: binding.file, introStatus: "pending" as const };
		} catch (error) {
			if (staffChild) await stopChild(staffChild);
			await restoreAttendedChild(slot, runtime, resumeOptions, "staff-create controller restore failed");
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

function parsedStaffUpdateInput(value: unknown): { displayName?: string; role?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid staff update");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length === 0 ||
		Object.keys(input).some((key) => key !== "displayName" && key !== "role") ||
		(input.displayName !== undefined && typeof input.displayName !== "string") ||
		(input.role !== undefined && typeof input.role !== "string")
	) {
		throw new Error("invalid staff update");
	}
	const displayName = typeof input.displayName === "string" ? input.displayName.trim() : undefined;
	const role = typeof input.role === "string" ? input.role.trim() : undefined;
	if (displayName !== undefined && (!displayName || Buffer.byteLength(displayName, "utf-8") > 160)) {
		throw new Error("invalid staff display name");
	}
	if (role !== undefined && (!role || Buffer.byteLength(role, "utf-8") > 320)) {
		throw new Error("invalid staff role");
	}
	return { ...(displayName ? { displayName } : {}), ...(role ? { role } : {}) };
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
			if (childBusy.get(runtime.child) || runtime.wakeChild) {
				return { ok: false, error: "wait for the current company work to finish" };
			}
			try {
				if (!activeStaffAgent(runtime.root, staffAgentId))
					return { ok: false, error: "staff member is unavailable" };
				snapshotFounderGitState(runtime.root, "founder staff update");
				const staff = updateStaffAgent(runtime.root, staffAgentId, update);
				commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
				if (runtime.childOptions.staffAgentId === staff.id) {
					runtime.childOptions.staffProfile = staffSystemProfile(staff);
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
	if (!runtime) return { ok: false, error: "open a company before deleting staff" };
	return enqueueRuntimeTransition<{ ok: true; staff: StaffAgent } | { ok: false; error: string }>(
		runtime,
		async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, error: "company runtime changed" };
			if (childBusy.get(runtime.child) || runtime.wakeChild) {
				return { ok: false, error: "wait for the current company work to finish" };
			}
			const staff = activeStaffAgent(runtime.root, staffAgentId);
			if (!staff) return { ok: false, error: "staff member is unavailable" };
			const attached = runtime.childOptions.staffAgentId === staff.id;
			const previousBinding = childBindings.get(runtime.child);
			const previousOptions: ChildOptions = {
				...runtime.childOptions,
				sessionFile: previousBinding?.file ?? runtime.childOptions.sessionFile,
			};
			let archived = false;
			try {
				snapshotFounderGitState(runtime.root, "founder staff delete");
				if (attached) await stopChild(runtime.child);
				const deleted = archiveStaffAgent(runtime.root, staff.id);
				archived = true;
				commitCompanyMaterialization(runtime.root, [join(".qorpera", "staff.json")]);
				if (attached) {
					const next = readStaffAgents(runtime.root).find(
						(candidate) => candidate.employmentStatus !== "archived",
					);
					const nextTrail = next
						? (readStaffRuntimeState(staffRuntimeStatePath(app.getPath("userData"), runtime.root)).intros[next.id]
								?.trailFile ?? latestStaffTrailFile(runtime, next.id))
						: undefined;
					const options: ChildOptions = next
						? {
								sessionFile: nextTrail,
								...(nextTrail ? {} : { sessionName: next.displayName, freshStaffTrail: true }),
								staffAgentId: next.id,
								staffProfile: staffSystemProfile(next),
								model: previousOptions.model,
							}
						: { model: previousOptions.model };
					runtime.child = startChild(slot, runtime.root, options);
					runtime.childOptions = { ...options };
					delete runtime.childOptions.sessionName;
					delete runtime.childOptions.freshStaffTrail;
					runtime.productWorker = undefined;
					runtime.runtimeReconnectAttempts = 0;
					runtime.lastUnexpectedRuntimeExitAt = undefined;
				}
				return { ok: true, staff: deleted };
			} catch (error) {
				if (attached && slot.runtime === runtime && !runtime.closing) {
					await restoreAttendedChild(
						slot,
						runtime,
						archived ? { model: previousOptions.model } : previousOptions,
						"staff-delete controller restore failed",
					);
				}
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	);
}

async function openStaffMember(
	slot: Slot,
	staffAgentId: string,
): Promise<
	| { ok: true; staff: StaffAgent; sessionFile: string; introStatus?: "pending" | "started" | "completed" | "failed" }
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
		const currentBinding = childBindings.get(runtime.child);
		if (
			runtime.childOptions.staffAgentId === staff.id &&
			currentBinding &&
			isCurrentRuntimeChild(slot, runtime, runtime.child)
		) {
			return {
				ok: true,
				staff,
				sessionFile: currentBinding.file,
				...(introState?.status ? { introStatus: introState.status } : {}),
			};
		}
		if (runtime.wakeChild || childBusy.get(runtime.child)) {
			return { ok: false, error: "company runtime is busy" };
		}
		try {
			const existingTrail = introState?.trailFile ?? latestStaffTrailFile(runtime, staff.id);
			const attached = await attachStaffChild(slot, runtime, staff, existingTrail, !existingTrail);
			return {
				ok: true,
				staff,
				sessionFile: attached.sessionFile,
				...(introState?.status
					? { introStatus: introState.status }
					: !existingTrail
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
	if (childBusy.get(child)) return { ok: false, error: "staff session is already working" };
	const path = staffRuntimeStatePath(app.getPath("userData"), runtime.root);
	const current = readStaffRuntimeState(path);
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
		!sendKernelStaffIntro(child, staffIntroMessage(runtime.root, staff, claim.state.intros[staff.id]?.orientation))
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
				await attachStaffChild(slot, runtime, active.get(next.staffAgentId)!, next.trailFile, false, true);
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
	const win = new BrowserWindow({
		width: 1360,
		height: 860,
		show: options.show ?? true,
		title: "Qorpera Base",
		backgroundColor: "#ffffff",
		// Frameless, Desktop-style chrome: the fixed shell draws the titlebar
		// (a -webkit-app-region: drag header), the OS overlays min/max/close.
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#ffffff", symbolColor: "#111111", height: 40 },
		icon: DEFAULT_ICON,
		webPreferences: {
			preload: join(DIRNAME, "preload.cjs"),
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
		void win.webContents
			.insertCSS(
				"body::before{content:'';position:fixed;top:0;left:0;right:150px;height:12px;z-index:2147483647;-webkit-app-region:drag;}",
			)
			.catch(() => {});
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
	// Closing a controller window is closing that company: kill its child
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
// and must not join or disturb a live instance.
const IS_SMOKE = process.argv.some((arg) => arg.startsWith("--smoke"));

// Electron's default uncaughtException behavior is a blocking native "Error"
// dialog — under headless smokes and autonomous kernels there is nobody to
// dismiss it, so the process hangs forever at 0% CPU while its servers go
// unserviced. Log and keep running instead (the same outcome as a founder
// dismissing the dialog, minus the founder).
process.on("uncaughtException", (error) => {
	console.error(`uncaught exception: ${error.stack ?? String(error)}`);
});
if (!IS_SMOKE && !app.requestSingleInstanceLock()) {
	app.quit();
}
app.on("second-instance", (_event, argv) => {
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
	// window, without yanking any open controller off its company.
	const hub = [...slots.values()].find((slot) => !slot.runtime);
	if (hub) focusWindow(hub.window);
	else createWindow();
});

app.whenReady().then(async () => {
	qorperaAccountAuth = new QorperaAccountAuth(app.getPath("userData"), {
		openExternal: (url) => electronShell.openExternal(url),
	});
	try {
		const account = await qorperaAccountAuth.info();
		currentQorperaAccountId = account.authenticated && account.user ? account.user.id : undefined;
	} catch {
		currentQorperaAccountId = undefined;
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
	ipcMain.handle("account:info", async (event): Promise<QorperaAccountInfo> => {
		if (!slotOf(event.sender) || !qorperaAccountAuth) return { authenticated: false };
		try {
			const account = rememberAuthenticatedAccount(await qorperaAccountAuth.info());
			if (account.authenticated) claimExistingProfiles(account);
			return account;
		} catch (error) {
			currentQorperaAccountId = undefined;
			console.error(`Qorpera account read failed: ${error instanceof Error ? error.message : String(error)}`);
			return { authenticated: false };
		}
	});
	ipcMain.handle("account:sign-in", async (event, input: unknown) => {
		const owner = slotOf(event.sender);
		if (!isTrustedHubSender(event.sender) || !owner || !qorperaAccountAuth) {
			return { ok: false, error: "Qorpera sign-in is only available from the profile selector." };
		}
		if (!input || typeof input !== "object" || Array.isArray(input)) {
			return { ok: false, error: "invalid sign-in request" };
		}
		const value = input as { provider?: unknown; email?: unknown };
		const report = (message: string): void => send(owner.window, "account-status", message);
		try {
			let account: QorperaAccountInfo;
			if (value.provider === "email" && typeof value.email === "string") {
				account = await qorperaAccountAuth.signInWithEmail(value.email, report);
			} else if (value.provider === "github" || value.provider === "google") {
				account = await qorperaAccountAuth.signInWithProvider(value.provider as QorperaAccountProvider, report);
			} else {
				return { ok: false, error: "unsupported Qorpera sign-in provider" };
			}
			rememberAuthenticatedAccount(account);
			await refreshBrokerModels();
			claimExistingProfiles(account);
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
	ipcMain.handle("feedback:open", async (event) => {
		if (!slotOf(event.sender)) return { ok: false, error: "Feedback is unavailable from this window." };
		try {
			await electronShell.openExternal("https://github.com/Qorpera/Qorpera_Base/issues/new");
			return { ok: true };
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
			return { ok: false, error: "Intelligence can only be disconnected from profile settings." };
		}
		return signOutIntelligence(event.sender);
	});
	ipcMain.handle("staff:catalog", (event) => (slotOf(event.sender) ? listStaffTemplates() : []));
	ipcMain.handle("companies:list", async (event) => {
		if (!isTrustedHubSender(event.sender)) return [];
		const account = await authenticatedAccount();
		if (!account?.user) return [];
		claimExistingProfiles(account);
		const userId = account.user.id;
		const userData = app.getPath("userData");
		return listCompanies()
			.filter((company) => profileOwnedBy(userData, userId, company.root))
			.map((company) => ({ ...company, profileIcon: readProfileIcon(userData, userId, company.root) }));
	});
	ipcMain.handle("profile:remove", async (event, root: unknown) => {
		if (!isTrustedHubSender(event.sender) || typeof root !== "string" || !root.trim()) {
			return { ok: false, error: "invalid profile" };
		}
		if (slotForCompany(root)) {
			return { ok: false, error: "Close this profile's window before removing it." };
		}
		const account = await authenticatedAccount();
		if (!account?.user || !profileOwnedBy(app.getPath("userData"), account.user.id, root)) {
			return { ok: false, error: "Profile is not owned by the signed-in account." };
		}
		const company = listCompanies().find((record) => normalizedRoot(record.root) === normalizedRoot(root));
		if (!company) return { ok: false, error: "Profile is no longer registered." };
		const owner = BrowserWindow.fromWebContents(event.sender);
		if (!owner) return { ok: false, error: "Profile selector is unavailable." };
		const confirmation = await dialog.showMessageBox(owner, {
			type: "warning",
			buttons: ["Cancel", "Remove profile"],
			defaultId: 0,
			cancelId: 0,
			message: `Remove ${company.name} from Qorpera?`,
			detail: `The company folder and everything in it will stay at ${company.root}. You can open it again later.`,
		});
		if (confirmation.response !== 1) return { ok: false, cancelled: true };
		if (!unregisterCompany(company.root))
			return { ok: false, error: "Qorpera could not update the profile selector." };
		forgetProfile(app.getPath("userData"), account.user.id, company.root);
		forgetProfileIcon(app.getPath("userData"), account.user.id, company.root);
		return { ok: true };
	});
	ipcMain.handle("company:open", async (event, root: string) => {
		if (!isTrustedHubSender(event.sender)) return;
		const account = await authenticatedAccount();
		if (!account?.user || !profileOwnedBy(app.getPath("userData"), account.user.id, root)) {
			throw new Error("This profile does not belong to the signed-in Qorpera account.");
		}
		const slot = slotOf(event.sender);
		if (slot) return openCompany(slot, root);
	});
	ipcMain.handle("company:new", async (event, dir: unknown, profileIcon: unknown) => {
		if (
			!isTrustedHubSender(event.sender) ||
			typeof dir !== "string" ||
			!dir.trim() ||
			!isProfileIconId(profileIcon)
		) {
			return;
		}
		const account = await authenticatedAccount();
		if (!account?.user) throw new Error("Sign in before creating a profile.");
		// The founding modal already shows the derived path — clicking Create IS
		// the decision; a second native confirmation was pure friction (founder
		// direction 2026-08-12).
		const result = scaffoldCompany(resolve(dir));
		registerCompany(result.root);
		claimProfile(app.getPath("userData"), account.user.id, result.root);
		writeProfileIcon(app.getPath("userData"), account.user.id, result.root, profileIcon);
		return result.root;
	});
	ipcMain.handle("company:integrate", async (event, dir: string, from: string) => {
		if (!isTrustedHubSender(event.sender) || typeof dir !== "string" || !dir.trim() || typeof from !== "string") {
			return;
		}
		const account = await authenticatedAccount();
		if (!account?.user) throw new Error("Sign in before creating a profile.");
		const target = resolve(dir);
		const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, {
			type: "warning",
			buttons: ["Cancel", "Create and integrate"],
			defaultId: 0,
			cancelId: 0,
			message: "Create this company and integrate the product source?",
			detail: `Company: ${target}\nSource: ${from}`,
		});
		if (confirmation.response !== 1) return;
		const result = scaffoldCompany(target);
		registerCompany(result.root);
		claimProfile(app.getPath("userData"), account.user.id, result.root);
		const ok = integrateRepo(result.root, from);
		return { root: result.root, ok };
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
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild || childBusy.get(runtime.child)) {
				return { ok: false, error: "company runtime is not available" };
			}
			const departmentId = productDepartmentId(product.trim());
			const options = {
				...runtime.childOptions,
				sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
			};
			const storage = captureProductTransactionStorage(runtime.root);
			const approved = await confirmKernelReview(slot.window, {
				title: "Add product-development department",
				summary: "Run this exact kernel product-registration transaction?",
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
			await stopChild(runtime.child);
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
			const restored = await restoreAttendedChild(
				slot,
				runtime,
				options,
				"product-transaction controller restore failed",
			);
			if (restored && watcher) runtime.inventoryWatcher = watcher;
			else watcher?.close();
			if (!restored) failure ??= new Error("the controller runtime could not be restored");
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
		const input = value as Record<string, unknown>;
		if (
			typeof input.title !== "string" ||
			typeof input.prompt !== "string" ||
			!Array.isArray(input.triggers) ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			(input.staffAgentId !== undefined && typeof input.staffAgentId !== "string") ||
			Object.keys(input).some((key) => !["title", "prompt", "triggers", "enabled", "staffAgentId"].includes(key))
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
		const input = value as Record<string, unknown>;
		if (
			(input.title !== undefined && typeof input.title !== "string") ||
			(input.prompt !== undefined && typeof input.prompt !== "string") ||
			(input.triggers !== undefined && !Array.isArray(input.triggers)) ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			(input.staffAgentId !== undefined && input.staffAgentId !== null && typeof input.staffAgentId !== "string") ||
			Object.keys(input).some((key) => !["title", "prompt", "triggers", "enabled", "staffAgentId"].includes(key))
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
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.wakeChild) {
				return { ok: false, error: "company runtime is busy" };
			}
			const job = readScheduledJobs(runtime.root).find((candidate) => candidate.id === id);
			if (!job) return { ok: false, error: "scheduled job not found" };
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
				if (childBusy.get(runtime.child)) {
					return Promise.resolve({
						ok: false,
						error: "the controller is still working — stop it before switching conversations",
					});
				}
				// A dead click during autonomous work must say so — the founder is
				// otherwise left staring at a pane that "won't load".
				if (runtime.wakeChild) {
					return Promise.resolve({
						ok: false,
						error: "autonomous work is running — watch it under Agents, or try again once it settles",
					});
				}
				return openChat(slot, sessionFile, department, worktree, sessionName);
			});
		},
	);
	ipcMain.handle("staff:create", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		return slot ? createStaffMember(slot, value) : { ok: false, error: "untrusted staff creation request" };
	});
	ipcMain.handle("staff:bootstrap", (event, value: unknown) => {
		const slot = slotOf(event.sender);
		return slot ? bootstrapStaffTeam(slot, value) : { ok: false, error: "untrusted staff bootstrap request" };
	});
	ipcMain.handle("staff:update", (event, staffAgentId: unknown, value: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		return updateStaffMember(slot, staffAgentId, value);
	});
	ipcMain.handle("staff:archive", (event, staffAgentId: unknown) => {
		const slot = slotOf(event.sender);
		if (!slot || typeof staffAgentId !== "string") return { ok: false, error: "invalid staff identity" };
		return archiveStaffMember(slot, staffAgentId);
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
		return staffIntroReady(slot, staffAgentId, trailFile, retry);
	});
	ipcMain.handle("hub:show", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return showHub(slot);
	});
	ipcMain.handle("settings:info", async (event) => {
		const slot = slotOf(event.sender);
		const account = await authenticatedAccount();
		return {
			account,
			profile: slot?.runtime ? { root: slot.runtime.root } : undefined,
			localExecution: slot?.runtime
				? readLocalExecutionPermission(app.getPath("userData"), slot.runtime.root)
				: "always",
			connections: [await githubConnectionInfo(slot?.runtime?.root), ...modelConnectionInfo()],
		};
	});
	ipcMain.handle("settings:local-execution", async (event, permission: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || (permission !== "always" && permission !== "never")) {
			return { ok: false, error: "invalid local execution permission" };
		}
		if (
			!writeLocalExecutionPermission(app.getPath("userData"), runtime.root, permission as LocalExecutionPermission)
		) {
			return { ok: false, error: "Local execution permission could not be saved." };
		}
		if (runtime.wakeChild || childBusy.get(runtime.child)) {
			return { ok: true, permission, applies: "next-run" };
		}
		try {
			await enqueueRuntimeTransition(runtime, async () => {
				if (slot.runtime !== runtime || runtime.closing) return;
				await replaceRuntimeChild(slot, runtime, {
					...runtime.childOptions,
					sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
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
		return connectionId === "github"
			? connectGitHubAccount(event.sender)
			: connectModelAccount(event.sender, connectionId);
	});
	ipcMain.handle("connection:disconnect", (event, connectionId: unknown, accountId: unknown) => {
		if (typeof connectionId !== "string") return { ok: false, error: "invalid connection" };
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
			console.error(`connection request projection failed: ${(error as Error).message}`);
			return [];
		}
	});
	ipcMain.handle("connection-request:begin", async (event, value: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || !value || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, error: "invalid connection request identity" };
		}
		const candidate = value as Record<string, unknown>;
		const binding = childBindings.get(runtime.child);
		if (
			Object.keys(candidate).some((key) => !["id", "staffAgentId", "sessionFile"].includes(key)) ||
			typeof candidate.id !== "string" ||
			typeof candidate.staffAgentId !== "string" ||
			typeof candidate.sessionFile !== "string" ||
			runtime.childOptions.staffAgentId !== candidate.staffAgentId ||
			!binding ||
			!activeStaffAgent(runtime.root, candidate.staffAgentId)
		) {
			return { ok: false, error: "connection request is not owned by the selected staff member" };
		}
		const identity: ConnectionRequestIdentity = {
			id: candidate.id,
			staffAgentId: candidate.staffAgentId,
			sessionFile: candidate.sessionFile,
		};
		const userData = app.getPath("userData");
		const root = runtime.root;
		let began = false;
		try {
			const request = getConnectionRequest(userData, root, identity.id);
			if (
				!request ||
				request.staffAgentId !== identity.staffAgentId ||
				request.sessionFile !== identity.sessionFile
			) {
				return { ok: false, error: "connection request ownership does not match" };
			}
			if (!isGitHubNativeConnectionRequest(request)) {
				return { ok: false, error: "this connection does not have an installed native connector recipe" };
			}
			const connecting = beginConnectionRequest(userData, root, identity);
			began = true;
			send(slot.window, "connection-requests-changed", projectConnectionRequest(connecting));
			const result = await connectGitHubAccount(event.sender);
			const settled = result.ok
				? completeConnectionRequest(userData, root, identity, "github-native")
				: result.cancelled
					? cancelConnectionRequest(userData, root, identity)
					: failConnectionRequest(userData, root, identity, "GitHub connection failed");
			const projected = projectConnectionRequest(settled);
			send(slot.window, "connection-requests-changed", projected);
			return result.ok
				? { ok: true, request: projected }
				: {
						ok: false,
						...(result.cancelled ? { cancelled: true as const } : { error: "GitHub connection failed" }),
						request: projected,
					};
		} catch (error) {
			if (began) {
				try {
					const failed = failConnectionRequest(
						userData,
						root,
						identity,
						"GitHub connection could not be finalized",
					);
					const projected = projectConnectionRequest(failed);
					send(slot.window, "connection-requests-changed", projected);
					return { ok: false, error: "GitHub connection could not be finalized", request: projected };
				} catch (settlementError) {
					console.error(`connection request settlement failed: ${(settlementError as Error).message}`);
				}
				return { ok: false, error: "GitHub connection could not be finalized" };
			}
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
	ipcMain.handle("backend:authorized-post", async (event, path: string, body: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, status: 404, text: "no company" };
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
				["/api/authority/config", "change company authority modes"],
				["/api/authority", "replace the company authority policy"],
			]);
			const action = actions.get(path);
			if (!action) return { ok: false, status: 400, text: "unsupported kernel action" };
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
			const approved = await confirmKernelReview(slot.window, {
				title: "Authorize company mutation",
				summary: `Authorize this exact kernel action: ${action}?`,
				exactText: exactReview,
				metadata: `Endpoint: ${path}`,
			});
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
			if (trailBinding) {
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
	ipcMain.handle("rpc:send", async (event, frame: unknown, expectedTrailFile: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || runtime.wakeChild) return { ok: false };
		if (!frame || typeof frame !== "object" || !("type" in frame) || typeof frame.type !== "string") {
			return { ok: false };
		}
		if (typeof expectedTrailFile !== "string" || !expectedTrailFile) {
			return { ok: false, error: "session attachment required" };
		}
		const attachedTo = (child: ChildProcessWithoutNullStreams): boolean =>
			childBindings.get(child)?.file === expectedTrailFile;
		const promptTypes = new Set(["prompt", "steer", "follow_up"]);
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
			return enqueueRuntimeTransition(runtime, async () => {
				if (!isCurrentRuntimeChild(slot, runtime, runtime.child)) return { ok: false };
				const reviewedChild = runtime.child;
				if (runtime.childOptions.staffAgentId && !childRuntimeReady.has(reviewedChild)) {
					return { ok: false, error: "staff member is still getting ready" };
				}
				if (!attachedTo(reviewedChild)) {
					return { ok: false, error: "session changed before command" };
				}
				const reviewed = reviewedPromptFrame(frame as Record<string, unknown>);
				if (!reviewed || (!reviewed.message && !reviewed.images?.length)) return { ok: false };
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
				return {
					ok: sendKernelPrompt(reviewedChild, reviewed, true, "composer-attended"),
				};
			});
		}
		if (!safeControlTypes.has(frame.type)) return { ok: false };
		const targetChild = runtime.child;
		if (!isCurrentRuntimeChild(slot, runtime, targetChild) || !attachedTo(targetChild)) {
			return { ok: false, error: "session changed before command" };
		}
		if (frame.type === "abort") childModelCapabilities.get(targetChild)?.endTurn("aborted");
		return { ok: writeChildFrame(targetChild, `${JSON.stringify(frame)}\n`) };
	});

	// A window that already knows its company (launcher argv, company smoke)
	// boots directly onto that company's durable partition — the open then
	// happens in place, with no window swap.
	const smokeCompanyIndex = process.argv.indexOf("--smoke-company");
	const smokeCompanyRoot = smokeCompanyIndex >= 0 ? process.argv[smokeCompanyIndex + 1] : undefined;
	const smokeBootstrapPicker = process.argv.includes("--smoke-bootstrap");
	const initial = createWindow(pendingCompany ?? smokeCompanyRoot);

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		autoUpdater.on("checking-for-update", () => sendAll("update-status", "checking…"));
		autoUpdater.on("update-available", (info) => sendAll("update-status", `downloading ${info.version}…`));
		autoUpdater.on("update-not-available", () => sendAll("update-status", "up to date"));
		autoUpdater.on("error", (error) => sendAll("update-status", `update error: ${error.message.slice(0, 80)}`));
		autoUpdater.on("update-downloaded", (info) => {
			downloadedUpdateVersion = info.version;
			sendAll("update-ready", info.version);
		});
		autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
			console.error(`update check failed: ${error.message}`);
		});
		ipcMain.handle("update:install", (event) => {
			const slot = slotOf(event.sender);
			if (!slot || !downloadedUpdateVersion) return false;
			// Clicking the versioned Update control is the founder's explicit
			// consent. Kernel exact-content review is for company capabilities and
			// mutations, not a signed application update already verified by the
			// packaged updater.
			sendAll("update-status", `restarting to install ${downloadedUpdateVersion}…`);
			autoUpdater.quitAndInstall(false, true);
			return true;
		});
	} else {
		ipcMain.handle("update:install", () => {});

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
	// Multi-window smoke: two companies, two live controllers side by side.
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

app.on("will-quit", () => {
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
