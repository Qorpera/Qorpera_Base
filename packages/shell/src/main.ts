/**
 * Qorpera Base shell — the minimal desktop app every company controller is
 * built on (spec §7, v0.8 posture: between PI and a full desktop app).
 *
 * Static foundation by construction: this window and its plumbing never
 * change per company. Everything self-evolving is interpreted from the
 * company folder at runtime — surfaces through the in-process backend,
 * the intelligence through the CLI's `--mode rpc` seam, spawned as a child
 * of Electron's own Node runtime (ELECTRON_RUN_AS_NODE), so a packaged
 * shell needs no system Node. Companies never build anything.
 *
 * Windows: one window per open thing — the hub, or one company controller.
 * Several controllers run side by side, each with its own window, RPC child,
 * and backend; a company is never open in two windows at once.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
	validateCompanyKernelStorage,
} from "@qorpera/pi-coding-agent/company";
import {
	createScheduledJob,
	deleteScheduledJob,
	destinationAllowed,
	persistWebhookPort,
	readScheduledJobs,
	readWebhookBinding,
	resolveCompanySecret,
	type ScheduledJob,
	suspendScheduledJob,
	updateScheduledJob,
} from "@qorpera/pi-coding-agent/company-connections";
import { FOUNDER_PUBLIC_FILE, founderPublicProjection } from "@qorpera/pi-coding-agent/founder-identity";
import {
	app,
	BrowserWindow,
	dialog,
	session as electronSession,
	shell as electronShell,
	ipcMain,
	type Session,
	type WebContents,
} from "electron";
import electronUpdater from "electron-updater";
import {
	appendKernelHttpObservation,
	appendKernelModelObservation,
	appendKernelMutationObservation,
	appendKernelObservation,
	appendKernelProductStorageObservation,
	appendKernelSessionEndObservation,
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
	type ControllerModelSelection,
	controllerLaunchOptions,
	controllerModelArgs,
	modelSelectionFromRpcFrame,
	writeControllerModelPreference,
} from "./controller-model.ts";
import { createHttpRequestBroker, type HttpRequestBroker } from "./http-request-broker.ts";
import { type BrokeredCredentials, type ModelRequestBroker, startModelRequestBroker } from "./model-request-broker.ts";
import {
	isRendererRequestAllowed,
	lockDownRendererSession,
	lockDownRendererWebContents,
	rendererPartitionForCompany,
} from "./renderer-boundary.ts";
import {
	assertUserlandStorage,
	ensureUserland,
	getActiveApp,
	isUnmodified,
	listVersions,
	mergeTaskPrompt,
	restoreVersion,
	reviewVersion,
	setActiveApp,
	setVersionFavorite,
	snapshotIfChanged,
	type UserlandStatus,
	type UserlandVersion,
} from "./userland-manager.ts";
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

let modelRequestBroker: ModelRequestBroker | undefined;

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
	/** Stable company identity (companyRootId) — keys renderer storage. */
	storageId: string;
	child: ChildProcessWithoutNullStreams;
	backendPort: number;
	backendClose?: () => void;
	userland: UserlandStatus;
	usingBaseFallback: boolean;
	backendToken: string;
	childOptions: ChildOptions;
	productWorker?: { department: string; worktree: string };
	/** Live userland-merge session, if one is running (kernel-spawned, silent). */
	mergeChild?: ChildProcessWithoutNullStreams;
	/** Live wake session, if one is running (kernel-spawned, single-flight). */
	wakeChild?: ChildProcessWithoutNullStreams;
	/** Named scheduled job currently owning wakeChild; absent for event wakes. */
	wakeJobId?: string;
	/** Closes the inbound webhook listener (optional kernel module). */
	webhookClose?: () => void;
	/** An inbound event arrived while the company was busy; the wake ticker owes it a wake. */
	pendingInboundWake?: boolean;
	inventoryWatcher?: ReturnType<typeof watch>;
	transitionQueue: Promise<void>;
	closing: boolean;
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
}

const BASE_USERLAND_DIR = join(DIRNAME, "userland");

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

const slots = new Map<number, Slot>();

/** A company root is a folder scaffolded as one — company.md is the anchor
 * every scaffold writes. Anything else must never be registered or have a
 * userland forked into it (a bad argv token once created a "company" named
 * after a Chromium switch). */
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
		return normalizedRoot(fileURLToPath(sender.getURL())) === normalizedRoot(join(BASE_USERLAND_DIR, "index.html"));
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
	input: { title: string; summary: string; exactText: string; metadata?: string; images?: KernelReviewImage[] },
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
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
			const candidate = image as { type?: unknown; data?: unknown; mimeType?: unknown };
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
			images.push({ type: "image", data: candidate.data, mimeType: candidate.mimeType });
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
	runtime.closing = true;
	runtime.inventoryWatcher?.close();
	runtime.webhookClose?.();
	await runtime.transitionQueue;
	await stopChild(runtime.child);
	if (runtime.wakeChild) await stopChild(runtime.wakeChild);
	if (runtime.mergeChild) await stopChild(runtime.mergeChild);
	runtime.backendClose?.();
	releaseCompanyRuntimeLock(runtime.runtimeLock);
	slot.runtime = undefined;
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

function startChild(slot: Slot, root: string, options: ChildOptions = {}): ChildProcessWithoutNullStreams {
	const { sessionFile, autonomousName, department, worktree, silent, onRpcEvent } = options;
	const win = slot.window;
	const actor = department && worktree ? "product-worker" : "controller";
	const cwd = worktree ? join(root, worktree) : root;
	const scope = {
		actor,
		attended: false,
		autonomousLabel: autonomousName ? `autonomous — ${autonomousName}` : undefined,
		department: department?.path,
		worktree,
		group: options.group,
		parentSession: options.parentSession,
	} as const;
	const userData = app.getPath("userData");
	const binding = bindTrailSession(root, cwd, scope, sessionFile);
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
	// kernel-protected paths (trail, policy, inbox, .git, userland, product
	// code) are denied before any network contact.
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
		const rpcArgs = [RPC_ENTRY, "--mode", "rpc", "--session", binding.path, ...controllerModelArgs(options.model)];
		invocation = codexSpawn(
			CODEX_ENTRY,
			process.execPath,
			sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, rpcArgs),
		);
		kernelSigner = createKernelResponseSigner({ sessionId: binding.sessionId });
	} catch (error) {
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
	try {
		child = spawn(invocation.command, invocation.args, {
			cwd: runtimeDir,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env,
		}) as ChildProcessWithoutNullStreams;
	} catch (error) {
		brokeredCredentials.release();
		throw error;
	}
	liveChildren.add(child);
	// stdin write failures land asynchronously as an "error" event; without a
	// listener they become an uncaughtException that takes down the app.
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (!silent) send(win, "rpc-log", `child stdin ${error.code ?? error.message}: frame dropped`);
	});
	childBindings.set(child, binding);
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
						kernelSigner.signBinding({ nonce: challenge.nonce, sessionId: binding.sessionId }),
					)}\n`,
				);
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
				} else send(win, "rpc-log", "rejected invalid trail append frame");
				return;
			}
			if ((frame as { type?: unknown }).type === "agent_settled") {
				childBusy.set(child, false);
				brokeredCredentials.endTurn("completed");
				httpBroker.endTurn();
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
			}
			if (onRpcEvent) onRpcEvent(frame as Record<string, unknown>);
			else if (!silent) send(win, "rpc-event", frame);
		} catch {
			if (!silent) send(win, "rpc-log", line);
		}
	});
	createInterface({ input: child.stderr }).on("line", (line) => {
		if (!silent) send(win, "rpc-log", line);
	});
	child.on("exit", (code) => {
		if (!silent && !intentionalKills.has(child)) send(win, "rpc-exit", code);
	});
	child.on("close", () => {
		liveChildren.delete(child);
		try {
			// Durable end marker BEFORE the close checkpoint, so the same kernel
			// commit that attributes this session's work also records its release.
			try {
				appendKernelSessionEndObservation(binding, { settled: !(childBusy.get(child) ?? false) });
			} catch (error) {
				console.error(`session-end observation failed: ${(error as Error).message}`);
			}
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
	if (!writeChildFrame(child, `${JSON.stringify({ ...unsignedFrame, kernelIntent })}\n`)) return false;
	childBusy.set(child, true);
	return true;
}

async function replaceRuntimeChild(slot: Slot, runtime: CompanyRuntime, options: ChildOptions): Promise<void> {
	const previousOptions = runtime.childOptions;
	await stopChild(runtime.child);
	if (slot.runtime !== runtime) return;
	try {
		runtime.childOptions = { ...options };
		runtime.child = startChild(slot, runtime.root, runtime.childOptions);
	} catch (error) {
		// The old child is already dead — a failed swap must not leave the
		// company without an agent (a legacy-session bind failure did exactly
		// that: every later composer send talked to a corpse).
		if (slot.runtime === runtime && !runtime.closing) {
			runtime.childOptions = previousOptions;
			runtime.child = startChild(slot, runtime.root, previousOptions);
		}
		throw error;
	}
	runtime.productWorker =
		runtime.childOptions.department && runtime.childOptions.worktree
			? { department: runtime.childOptions.department.path, worktree: runtime.childOptions.worktree }
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

function isCurrentRuntimeChild(slot: Slot, runtime: CompanyRuntime, child: ChildProcessWithoutNullStreams): boolean {
	return slot.runtime === runtime && !runtime.closing && runtime.child === child && child.exitCode === null;
}

function restartForProductInventory(slot: Slot, runtime: CompanyRuntime): void {
	void enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.mergeChild || runtime.wakeChild) return;
		const options = {
			...runtime.childOptions,
			sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
		};
		await stopChild(runtime.child);
		if (slot.runtime !== runtime) return;
		readProductProtectionInventory(runtime.root);
		runtime.childOptions = options;
		runtime.child = startChild(slot, runtime.root, options);
	}).catch((error) => {
		console.error(`product inventory transition stopped the controller: ${(error as Error).message}`);
	});
}

function isInside(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Run the staged userland merge as its OWN autonomous session — never
 * through the founder's chat child, so a reload can't re-send the task into
 * a session that already ran it. Silent: events are consumed here (the
 * agent's own settle ends the run), not forwarded to the chat pane. The
 * result reaches the renderer as one `merge-done` event, and the open-time
 * userland status is refreshed so the merge button reflects reality.
 */
function wakePrompt(
	cause: "schedule" | "founder_response" | "inbound_event",
	coalesced: number,
	job?: ScheduledJob,
): string {
	const missed =
		coalesced > 0
			? ` The kernel was closed or asleep for a while: ${coalesced} missed wake${coalesced === 1 ? "" : "s"} were coalesced into this one.`
			: "";
	if (cause === "founder_response") {
		return `Wake: the founder responded in the inbox. Read the updated items and continue the affected work; post follow-up inbox items for anything that needs the founder again.${missed}`;
	}
	if (cause === "inbound_event") {
		return `Wake: an external event arrived. Read the new files under inbox/events/, decide what they mean for the company, and act; events are durable, so handle every unprocessed one, not just the newest.${missed}`;
	}
	return `Scheduled job: ${job?.title ?? "Company orchestration"}.${missed}\n\n${job?.prompt ?? "Read company.md, the inbox, and app/routines/, decide for yourself what most needs doing, and do it. Post inbox/messages items for anything that needs the founder; when nothing needs doing, settle without inventing work."}`;
}

/** Compress a silent wake child's RPC frames into founder-legible status
 * beats for the Agents page. Deltas are dropped — only phase changes and tool
 * starts are worth a renderer round-trip. Purely observational: the wake child
 * stays silent on the rpc-event lane and is never rebound to the chat pane. */
function wakeActivitySummary(frame: Record<string, unknown>): { kind: string; detail?: string } | undefined {
	if (frame.type === "agent_start") return { kind: "start" };
	if (frame.type === "agent_settled") return { kind: "settled" };
	if (frame.type === "tool_execution_start") {
		const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
		const args = (frame.args ?? {}) as Record<string, unknown>;
		const target = [args.path, args.filePath, args.file_path, args.pattern, args.url, args.command].find(
			(value) => typeof value === "string" && value.trim(),
		) as string | undefined;
		return { kind: "tool", detail: target ? `${name} · ${target.slice(0, 120)}` : name };
	}
	if (frame.type === "message_update") {
		const delta = (frame as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
		if (delta?.type === "thinking_start") return { kind: "thinking" };
		if (delta?.type === "text_start") return { kind: "writing" };
	}
	return undefined;
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
async function startWakeChild(
	slot: Slot,
	runtime: CompanyRuntime,
	cause: "schedule" | "founder_response" | "inbound_event",
	coalesced: number,
	job?: ScheduledJob,
	manual = false,
): Promise<boolean> {
	if (runtime.mergeChild || runtime.wakeChild || runtime.closing) return false;
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
			silent: true,
			model: resumeOptions.model,
			wake: { id: wakeId, cause, intervalMinutes: job?.intervalMinutes, coalesced },
			onRpcEvent: (frame) => {
				if (frame.type === "agent_start") started = true;
				if (wakeFrameFailed(frame)) failed = true;
				const activity = wakeActivitySummary(frame);
				if (activity) {
					send(slot.window, "wake-activity", {
						root: runtime.root,
						trailFile: childBindings.get(child)?.file,
						at: Date.now(),
						...activity,
					});
				}
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
			try {
				runtime.childOptions = resumeOptions;
				runtime.child = startChild(slot, runtime.root, resumeOptions);
			} catch (restartError) {
				console.error(`wake startup left the controller stopped: ${(restartError as Error).message}`);
			}
		}
		return false;
	}
	runtime.wakeChild = child;
	runtime.wakeJobId = job?.id;
	const trailFile = childBindings.get(child)?.file;
	child.on("close", async () => {
		await childCheckpointCompletion.get(child);
		if (slot.runtime !== runtime || runtime.closing) return;
		runtime.wakeChild = undefined;
		runtime.wakeJobId = undefined;
		try {
			if (job && promptSent) {
				persistScheduledJobOutcome(runtime, job, settledCleanly, trailFile);
			}
		} catch (error) {
			console.error(`wake bookkeeping failed: ${(error as Error).message}`);
		}
		try {
			runtime.childOptions = resumeOptions;
			runtime.child = startChild(slot, runtime.root, resumeOptions);
		} catch (error) {
			console.error(`wake completion left the controller stopped: ${(error as Error).message}`);
		}
	});
	if (
		!sendKernelPrompt(
			child,
			{ type: "prompt", message: wakePrompt(cause, coalesced, job) },
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
			if (!runtime || runtime.closing || runtime.mergeChild || runtime.wakeChild) continue;
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
				const statePath = wakeRunStatePath(app.getPath("userData"), runtime.root);
				const state = readWakeRunState(statePath);
				const due = jobs
					.map((job) => ({
						job,
						decision: decideScheduledWake(job, scheduledJobRunState(state, job.id), Date.now()),
					}))
					.find((candidate) => candidate.decision.due);
				if (!due) continue;
				void startWakeChild(slot, runtime, "schedule", due.decision.coalesced, due.job).catch((error) => {
					console.error(`scheduled wake failed for ${runtime.root}: ${(error as Error).message}`);
				});
			} catch (error) {
				console.error(`wake tick failed for ${runtime.root}: ${(error as Error).message}`);
			}
		}
	}, 60_000).unref();
}

async function startMergeChild(slot: Slot, runtime: CompanyRuntime, reviewedPrompt: string): Promise<boolean> {
	if (runtime.wakeChild || runtime.closing) return false;
	const resumeOptions = {
		...runtime.childOptions,
		sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
	};
	await stopChild(runtime.child);
	if (slot.runtime !== runtime || runtime.closing) return false;
	try {
		runtime.userland = ensureUserland(runtime.root, BASE_USERLAND_DIR, shellVersion());
	} catch (error) {
		console.error(`pre-merge userland validation failed: ${(error as Error).message}`);
		runtime.child = startChild(slot, runtime.root, resumeOptions);
		return false;
	}
	if (
		(runtime.userland.action !== "staged" && runtime.userland.action !== "already-staged") ||
		mergeTaskPrompt(runtime.userland) !== reviewedPrompt
	) {
		runtime.child = startChild(slot, runtime.root, resumeOptions);
		return false;
	}
	let started = false;
	let child: ChildProcessWithoutNullStreams;
	child = startChild(slot, runtime.root, {
		autonomousName: `userland merge v${runtime.userland.stagedVersion}`,
		group: "merge",
		silent: true,
		model: resumeOptions.model,
		onRpcEvent: (frame) => {
			if (frame.type === "agent_start") started = true;
			// Any settle ends the run — including a prompt that failed before
			// starting (never keeping a settled merge child alive beats a zombie
			// that blocks userland:merge forever).
			if (frame.type === "agent_settled") {
				if (!started) console.error("merge session settled without starting (prompt failed?)");
				intentionalKills.add(child);
				killChildTree(child);
			}
		},
	});
	runtime.mergeChild = child;
	child.on("close", async () => {
		await childCheckpointCompletion.get(child);
		if (slot.runtime !== runtime || runtime.closing) return; // company was closed meanwhile
		runtime.mergeChild = undefined;
		// Re-read the manifest: a finished merge reads back as "current".
		// Guarded twice: a throw here is an uncaught exception in main (fs can
		// fail right after an agent rewrote userland/), and a MISSING manifest
		// must not reach ensureUserland — its first-open branch would wipe the
		// fork, .versions included.
		let ok = false;
		try {
			if (existsSync(join(runtime.root, "userland", "userland.json"))) {
				runtime.userland = ensureUserland(runtime.root, BASE_USERLAND_DIR, shellVersion());
				ok =
					runtime.userland.action === "current" ||
					runtime.userland.action === "fast-forwarded" ||
					runtime.userland.action === "auto-merged";
			}
		} catch (error) {
			console.error(`post-merge userland refresh failed: ${(error as Error).message}`);
		}
		send(slot.window, "merge-done", { ok, action: runtime.userland.action });
		runtime.childOptions = resumeOptions;
		runtime.child = startChild(slot, runtime.root, resumeOptions);
	});
	if (!sendKernelPrompt(child, { type: "prompt", message: reviewedPrompt }, true, "native-userland-merge-review")) {
		await stopChild(child);
		if (runtime.mergeChild === child) runtime.mergeChild = undefined;
		if (slot.runtime === runtime && !runtime.closing) runtime.child = startChild(slot, runtime.root, resumeOptions);
		return false;
	}
	return true;
}

/** Each open company owns its backend server and token. Hashed ports can
 * collide, so walk forward until a bind succeeds: the renderer resolves
 * everything relative to backendUrl, and only a server we own honors the
 * token we minted. */
async function listenBackend(root: string, authToken: string): Promise<{ port: number; close: () => void }> {
	const base = companyPort(root);
	for (let port = base; port < base + 10; port++) {
		const server = createCompanyAppServer({
			root,
			port,
			authToken,
			userland: { baseDir: BASE_USERLAND_DIR },
		});
		const listening = await new Promise<boolean>((resolvePromise) => {
			server.once("error", () => resolvePromise(false));
			server.listen(port, "127.0.0.1", () => resolvePromise(true));
		});
		if (listening) return { port, close: () => server.close() };
	}
	throw new Error(`no free backend port near ${base} for ${root}`);
}

function companyUserlandUrl(runtime: CompanyRuntime, choice: "fork" | "base"): string {
	return `http://127.0.0.1:${runtime.backendPort}/userland/${choice}/index.html`;
}

interface ActiveCompany {
	root: string;
	/** Stable company identity — the renderer keys its localStorage by this,
	 * never by the (port-derived, collision-walked) backendUrl. */
	id: string;
	backendUrl: string;
	kickoff: boolean;
	userland: UserlandStatus;
	usingBaseFallback: boolean;
	mergePrompt?: string;
	mergeRunning: boolean;
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
	activeApp: "fork" | "base";
	versions: UserlandVersion[];
	evolved: boolean;
	/** Trail file the live founder child is bound to (resumed or fresh), so
	 * the chrome can mark the session active and cache under the right key. */
	sessionFile?: string;
}

function activeCompanyInfo(slot: Slot): ActiveCompany | undefined {
	const runtime = slot.runtime;
	if (!runtime) return undefined;
	const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
	const userlandDir = join(runtime.root, "userland");
	const autonomousChild =
		runtime.wakeChild?.exitCode === null
			? runtime.wakeChild
			: runtime.mergeChild?.exitCode === null
				? runtime.mergeChild
				: undefined;
	const runState = readWakeRunState(wakeRunStatePath(app.getPath("userData"), runtime.root));
	const now = Date.now();
	const scheduledJobs = readScheduledJobs(runtime.root).map((job) => {
		const jobState = scheduledJobRunState(runState, job.id);
		const lastRunMs = jobState.lastWakeAt ? Date.parse(jobState.lastWakeAt) : Number.NaN;
		const nextRunAt =
			job.enabled && !job.suspendedReason
				? new Date(Number.isFinite(lastRunMs) ? lastRunMs + job.intervalMinutes * 60_000 : now).toISOString()
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
		backendUrl: `http://127.0.0.1:${runtime.backendPort}`,
		kickoff: false,
		userland: runtime.userland,
		usingBaseFallback: runtime.usingBaseFallback,
		mergePrompt: staged ? mergeTaskPrompt(runtime.userland) : undefined,
		mergeRunning: Boolean(runtime.mergeChild && runtime.mergeChild.exitCode === null),
		wakeRunning: Boolean(runtime.wakeChild && runtime.wakeChild.exitCode === null),
		autonomousTrailFile: autonomousChild ? childBindings.get(autonomousChild)?.file : undefined,
		scheduledJobs,
		activeApp: getActiveApp(userlandDir),
		versions: listVersions(userlandDir),
		evolved: !isUnmodified(userlandDir),
		sessionFile: childBindings.get(runtime.child)?.file,
	};
}

async function openCompany(slot: Slot, root: string): Promise<void> {
	try {
		root = canonicalCompanyRoot(root);
	} catch {
		console.error(`refusing to open unavailable company root: ${root}`);
		if (!slot.runtime) void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		return;
	}
	// Refuse non-companies outright: opening is what registers a root and
	// forks a userland into it, so an invalid path here would mint a fake
	// company. The window stays on (or returns to) the hub instead.
	if (!isCompanyRoot(root)) {
		console.error(`refusing to open non-company root: ${root}`);
		if (!slot.runtime) void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
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
	await closeCompany(slot);
	const runtimeLock = claimCompanyRuntimeLock(root);
	let pendingBackendClose: (() => void) | undefined;
	try {
		// The scaffold is how kernel upgrades reach existing companies: an
		// idempotent spine fill (never overwriting company content) so a
		// company conceived under an older kernel passes current validation.
		scaffoldCompany(root);
		validateCompanyKernelStorage(root);
		assertUserlandStorage(join(root, "userland"));
		const userData = app.getPath("userData");
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
			await dialog.showMessageBox(slot.window, {
				type: "warning",
				buttons: ["Continue"],
				message: "This company clone has product storage that is not hydrated on this machine.",
				detail: productStorage.unhydrated.map((entry) => `${entry.kind}: ${entry.path}`).join("\n"),
			});
		}
		reconcilePendingCompanyCheckpoints(checkpointDir, root);
		snapshotFounderGitState(root);
		enforceCompanyKernelSettings(root);
		// Pre-projection companies: fold app/manifest.json surfaces into
		// app/projection.json (files untouched) and drop the dead key.
		migrateLegacyManifestSurfaces(root);
		registerCompany(root);

		// The fork model (spec §9a): the company runs ITS OWN userland — forked
		// from base on first open, fast-forwarded when untouched, staged for a
		// controller merge when evolved. The kernel only loads it.
		const userland = ensureUserland(root, BASE_USERLAND_DIR, shellVersion());
		// Any evolution since the last open is captured as a restorable version —
		// the founder can always roll the app back from Settings → App.
		snapshotIfChanged(join(root, "userland"));
		commitCompanyMaterialization(root, [
			join(".qorpera", "settings.json"),
			"userland",
			join("app", "manifest.json"),
			join("app", "projection.json"),
		]);

		// Backend for surfaces/state/inbox — reused machinery, in-process. The
		// token guards mutating endpoints; only the renderer ever receives it.
		const backendToken = randomUUID();
		const backend = await listenBackend(root, backendToken);
		pendingBackendClose = backend.close;

		// Never-conceived company: the conception session is autonomous work.
		const kickoff = conceptionKickoff(root);
		// Founder continuity across restarts: sweep the contentless trail files
		// earlier opens minted (they carry no memory), then reopen the newest
		// controller-scope chat instead of creating a fresh session per open.
		const swept = pruneEmptyTrailSessions(root);
		if (swept > 0) console.log(`pruned ${swept} contentless trail session${swept === 1 ? "" : "s"}`);
		// A resumed trail records the model that session last used, but the
		// founder's confirmed preference is newer authority. Pass it on every
		// controller launch so reopening an old chat cannot silently move the
		// controller, and the scheduled jobs it spawns, back to a stale model.
		const childOptions: ChildOptions = controllerLaunchOptions(
			app.getPath("userData"),
			root,
			kickoff,
			latestResumableTrailSession(root),
		);
		let child: ReturnType<typeof startChild>;
		try {
			child = startChild(slot, root, childOptions);
		} catch (error) {
			// A malformed newest session must never block the company: fall fresh.
			if (!childOptions.sessionFile) throw error;
			console.error(`could not resume ${childOptions.sessionFile}: ${(error as Error).message}`);
			childOptions.sessionFile = undefined;
			child = startChild(slot, root, childOptions);
		}
		const childBinding = childBindings.get(child);
		if (childBinding && productStorage.unhydrated.length > 0) {
			appendKernelProductStorageObservation(childBinding, {
				status: "hydration-required",
				paths: productStorage.unhydrated.map(({ path, kind }) => ({ path, kind })),
			});
		}
		const runtime: CompanyRuntime = {
			root,
			storageId,
			child,
			childOptions,
			backendPort: backend.port,
			backendClose: backend.close,
			userland,
			usingBaseFallback: false,
			backendToken,
			transitionQueue: Promise.resolve(),
			closing: false,
			runtimeLock,
		};
		slot.runtime = runtime;
		pendingBackendClose = undefined;
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
				onEvent: () => {
					const live = slot.runtime;
					if (!live || live.closing) return;
					if (live.mergeChild || live.wakeChild || childBusy.get(live.child)) {
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
		if (kickoff) {
			sendKernelPrompt(child, { type: "prompt", message: kickoff }, false, "kernel-conception");
		}
		slot.kickoffPending = Boolean(kickoff);

		// Load the company's own app — unless the founder switched this company to
		// the pristine base app (Settings → App). If the evolved userland fails to
		// boot, the kernel falls back to the base chrome — the company stays
		// reachable either way.
		if (slot.window.isDestroyed()) return;
		// A window that last showed the hub (throwaway partition) or another
		// company cannot host this company's durable partition — swap in a
		// replacement window, committed only once the chrome has loaded.
		const swap = slot.partition === partition ? undefined : beginRendererWindowSwap(slot, partition);
		const win = swap?.window ?? slot.window;
		try {
			setWindowIcon(win, companyIcon(root));
			if (getActiveApp(join(root, "userland")) === "base") {
				await win.loadURL(companyUserlandUrl(runtime, "base"));
			} else {
				await win.loadURL(companyUserlandUrl(runtime, "fork")).catch(async () => {
					if (slot.runtime) slot.runtime.usingBaseFallback = true;
					await win.loadURL(companyUserlandUrl(runtime, "base"));
				});
			}
			swap?.commit();
		} catch (loadError) {
			swap?.abort();
			throw loadError;
		}
	} catch (error) {
		if (slot.runtime?.runtimeLock.token === runtimeLock.token) await closeCompany(slot);
		else {
			pendingBackendClose?.();
			releaseCompanyRuntimeLock(runtimeLock);
		}
		throw error;
	}
}

async function showHub(slot: Slot): Promise<void> {
	await closeCompany(slot);
	setWindowIcon(slot.window, DEFAULT_ICON);
	await slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
}

/** Switch chat sessions. Product chats run a product-worker in one validated worktree. */
async function openChat(
	slot: Slot,
	sessionFile: string | null,
	departmentPath?: string,
	worktreePath?: string,
): Promise<{ ok: boolean; department?: string; worktree?: string; error?: string }> {
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
		if (!department) return { ok: false, error: "product department or repository is unavailable" };
		let assignment: ProductWorktree;
		if (worktreePath) {
			const existingAssignment = readProductWorktreeAssignment(runtime.root, department, worktreePath);
			if (existingAssignment) {
				assignment = existingAssignment;
			} else {
				const recovery = planProductWorktreeRecovery(runtime.root, department, worktreePath, runtime.runtimeLock);
				if (!recovery) return { ok: false, error: "product worktree has no valid recovery source" };
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
				return { ok: false, error: "planned product worktree escaped its assigned parent" };
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
			return { ok: false, error: "product worktree changed before authorization" };
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
			return { ok: false, error: "product worktree changed after authorization" };
		}
	}
	const options: ChildOptions = {
		sessionFile: sessionFile ?? undefined,
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
	return { ok: true, department: department?.path, worktree };
}

function rendererRequestAllowed(slot: Slot, value: string): boolean {
	return isRendererRequestAllowed(value, {
		backendOrigin: slot.runtime ? `http://127.0.0.1:${slot.runtime.backendPort}` : undefined,
		trustedFileRoot: BASE_USERLAND_DIR,
	});
}

/** Sessions are per-partition singletons, and a company's persist: partition
 * outlives any one window — so each session is locked down and given its
 * request boundary exactly once, and the boundary resolves the requesting
 * window's slot per request instead of closing over one slot forever. */
const configuredRendererSessions = new WeakSet<Session>();
const slotsByWebContentsId = new Map<number, Slot>();

function rendererSessionFor(partition: string): Session {
	const rendererSession = electronSession.fromPartition(partition, { cache: false });
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
			: isRendererRequestAllowed(details.url, { trustedFileRoot: BASE_USERLAND_DIR });
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
		backgroundColor: "#101010",
		// Frameless, Desktop-style chrome: the userland draws the titlebar
		// (a -webkit-app-region: drag header), the OS overlays min/max/close.
		titleBarStyle: "hidden",
		titleBarOverlay: { color: "#101010", symbolColor: "#e4e4e1", height: 40 },
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
	const contentsId = win.webContents.id;
	if (options.bounds) win.setBounds(options.bounds);
	win.setMenuBarVisibility(false);
	// Kernel duty: the window must stay draggable in EVERY userland, including
	// evolved forks that predate the frameless titlebar and draw no drag
	// region of their own. A thin top strip guarantees that; userlands with a
	// real titlebar simply overlap it.
	win.webContents.on("did-finish-load", () => {
		void win.webContents
			.insertCSS(
				"body::before{content:'';position:fixed;top:0;left:0;right:150px;height:12px;z-index:2147483647;-webkit-app-region:drag;}",
			)
			.catch(() => {});
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
	// Page loads are kernel-only. The window's history holds the hub and the
	// base/fork chromes as ordinary pages, so mouse back/forward buttons (or
	// any history walk) re-enter the same company through a DIFFERENT chrome —
	// which reads as the app spontaneously changing shape. Swallow the mouse
	// app-commands and drop history after every kernel-initiated load.
	win.on("app-command", (event, command) => {
		if (command === "browser-backward" || command === "browser-forward") event.preventDefault();
	});
	win.webContents.on("did-finish-load", () => win.webContents.navigationHistory.clear());
	win.webContents.on("will-navigate", (event, url) => {
		if (!rendererRequestAllowed(forSlot(), url)) event.preventDefault();
	});
	// A crashed evolved userland must not strand the company: fall back to
	// the base chrome (kernel duty — last-good behavior). Guarded to the
	// slot's CURRENT window: an uncommitted swap window's crash is handled by
	// its pending loadURL rejecting instead.
	win.webContents.on("render-process-gone", () => {
		const slot = forSlot();
		if (slot.window === win && slot.runtime && !slot.runtime.usingBaseFallback) {
			slot.runtime.usingBaseFallback = true;
			void win.loadURL(companyUserlandUrl(slot.runtime, "base"));
		}
	});
	// Closing a controller window is closing that company: kill its child
	// and backend; other windows are untouched. A window retired by a swap
	// is no longer the slot's window — its company must stay running.
	win.on("closed", () => {
		slots.delete(win.id);
		slotsByWebContentsId.delete(contentsId);
		const slot = forSlot();
		if (slot.window === win) void closeCompany(slot);
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
	slot = { window, rendererSession, partition, kickoffPending: false };
	registerRendererWindow(window, slot);
	void window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
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
		else void openCompany(createWindow(root), root);
		return;
	}
	// Launching "Qorpera Base" itself means: take me to the hub — in its own
	// window, without yanking any open controller off its company.
	const hub = [...slots.values()].find((slot) => !slot.runtime);
	if (hub) focusWindow(hub.window);
	else createWindow();
});

app.whenReady().then(async () => {
	const modelAgentDir = join(app.getPath("home"), ".qorpera", "agent");
	modelRequestBroker = await startModelRequestBroker({
		authPath: join(modelAgentDir, "auth.json"),
		modelsPath: join(modelAgentDir, "models.json"),
		allowedProviders: MODEL_AUTH_PROVIDERS,
	});
	startWakeTicker();
	ipcMain.handle("companies:list", () => listCompanies());
	ipcMain.handle("company:open", (event, root: string) => {
		if (!isTrustedHubSender(event.sender)) return;
		const slot = slotOf(event.sender);
		if (slot) return openCompany(slot, root);
	});
	ipcMain.handle("company:new", async (event, dir: string) => {
		if (!isTrustedHubSender(event.sender) || typeof dir !== "string" || !dir.trim()) return;
		// The founding modal already shows the derived path — clicking Create IS
		// the decision; a second native confirmation was pure friction (founder
		// direction 2026-08-12).
		const result = scaffoldCompany(resolve(dir));
		registerCompany(result.root);
		return result.root;
	});
	ipcMain.handle("company:integrate", async (event, dir: string, from: string) => {
		if (!isTrustedHubSender(event.sender) || typeof dir !== "string" || !dir.trim() || typeof from !== "string") {
			return;
		}
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
			if (slot.runtime !== runtime || runtime.closing || runtime.mergeChild || runtime.wakeChild) {
				return { ok: false, error: "company runtime is not available" };
			}
			const departmentId = productDepartmentId(product.trim());
			const options = {
				...runtime.childOptions,
				sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
			};
			runtime.inventoryWatcher?.close();
			await stopChild(runtime.child);
			try {
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
				if (!approved) throw new Error("cancelled");
				let department: ProductDepartment;
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
				runtime.childOptions = options;
				runtime.child = startChild(slot, runtime.root, options);
				runtime.inventoryWatcher = watch(join(runtime.root, ".qorpera"), { persistent: false }, (_event, file) => {
					if (file?.toString() === "products.json") restartForProductInventory(slot, runtime);
				});
				return { ok: true, department };
			} catch (error) {
				try {
					readProductProtectionInventory(runtime.root);
					runtime.childOptions = options;
					runtime.child = startChild(slot, runtime.root, options);
					runtime.inventoryWatcher = watch(
						join(runtime.root, ".qorpera"),
						{ persistent: false },
						(_event, file) => {
							if (file?.toString() === "products.json") restartForProductInventory(slot, runtime);
						},
					);
				} catch (restartError) {
					console.error(`product transaction left the controller stopped: ${(restartError as Error).message}`);
				}
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
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
			typeof input.intervalMinutes !== "number" ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			Object.keys(input).some((key) => !["title", "prompt", "intervalMinutes", "enabled"].includes(key))
		) {
			return { ok: false, error: "invalid scheduled job" };
		}
		const approved = await confirmKernelReview(slot.window, {
			title: "Create scheduled job",
			summary: "Bind this recurring controller work to the open company?",
			exactText: input.prompt,
			metadata: [
				`Company: ${runtime.root}`,
				`Title: ${input.title}`,
				`Schedule: every ${input.intervalMinutes} minutes`,
				`Status: ${input.enabled === false ? "paused" : "active"}`,
			].join("\n"),
		});
		if (!approved) return { ok: false, error: "cancelled" };
		try {
			return {
				ok: true,
				job: createScheduledJob(runtime.root, {
					title: input.title,
					prompt: input.prompt,
					intervalMinutes: input.intervalMinutes,
					...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
				}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
			(input.intervalMinutes !== undefined && typeof input.intervalMinutes !== "number") ||
			(input.enabled !== undefined && typeof input.enabled !== "boolean") ||
			Object.keys(input).some((key) => !["title", "prompt", "intervalMinutes", "enabled"].includes(key))
		) {
			return { ok: false, error: "invalid scheduled-job update" };
		}
		const current = readScheduledJobs(runtime.root).find((job) => job.id === id);
		if (!current) return { ok: false, error: "scheduled job not found" };
		const approved = await confirmKernelReview(slot.window, {
			title: "Update scheduled job",
			summary: "Apply these recurring-work settings to the open company?",
			exactText: typeof input.prompt === "string" ? input.prompt : current.prompt,
			metadata: [
				`Company: ${runtime.root}`,
				`Title: ${typeof input.title === "string" ? input.title : current.title}`,
				`Schedule: every ${typeof input.intervalMinutes === "number" ? input.intervalMinutes : current.intervalMinutes} minutes`,
				`Status: ${(typeof input.enabled === "boolean" ? input.enabled : current.enabled) ? "active" : "paused"}`,
			].join("\n"),
		});
		if (!approved) return { ok: false, error: "cancelled" };
		try {
			return {
				ok: true,
				job: updateScheduledJob(runtime.root, id, {
					...(typeof input.title === "string" ? { title: input.title } : {}),
					...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
					...(typeof input.intervalMinutes === "number" ? { intervalMinutes: input.intervalMinutes } : {}),
					...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
				}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
			if (slot.runtime !== runtime || runtime.closing || runtime.mergeChild || runtime.wakeChild) {
				return { ok: false, error: "company runtime is busy" };
			}
			const job = readScheduledJobs(runtime.root).find((candidate) => candidate.id === id);
			if (!job) return { ok: false, error: "scheduled job not found" };
			const approved = await confirmKernelReview(slot.window, {
				title: "Run scheduled job now",
				summary: "Start this controller job immediately?",
				exactText: job.prompt,
				metadata: [
					`Company: ${runtime.root}`,
					`Title: ${job.title}`,
					`Usual schedule: every ${job.intervalMinutes} minutes`,
				].join("\n"),
			});
			if (!approved) return { ok: false, error: "cancelled" };
			return (await startWakeChild(slot, runtime, "schedule", 0, job, true))
				? { ok: true }
				: { ok: false, error: "company runtime is busy" };
		});
	});
	ipcMain.handle("company:close", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return closeCompany(slot);
	});
	ipcMain.handle("chat:open", (event, sessionFile: string | null, department?: string, worktree?: string) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false };
		return enqueueRuntimeTransition(runtime, () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.mergeChild || runtime.wakeChild) {
				return Promise.resolve({ ok: false });
			}
			return openChat(slot, sessionFile, department, worktree);
		});
	});
	ipcMain.handle("hub:show", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return showHub(slot);
	});
	ipcMain.handle("settings:info", () => {
		// Connected providers: names only, never secrets. Kernel-level read.
		let providers: string[] = [];
		try {
			const authPath = join(app.getPath("home"), ".qorpera", "agent", "auth.json");
			providers = Object.keys(JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>);
		} catch {
			// no auth yet
		}
		return {
			version: shellVersion(),
			packaged: app.isPackaged,
			providers,
			agentDir: join(app.getPath("home"), ".qorpera", "agent"),
		};
	});
	// Settings → App: switch this company between its evolved fork and the
	// pristine base app, or roll the fork back to a saved version. Both
	// reload the window into whichever app is now active.
	ipcMain.handle("userland:set-active", async (event, appChoice: "fork" | "base") => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime) return false;
		const runtime = slot.runtime;
		setActiveApp(join(runtime.root, "userland"), appChoice === "base" ? "base" : "fork");
		runtime.usingBaseFallback = false;
		await slot.window.loadURL(companyUserlandUrl(runtime, appChoice)).catch(async () => {
			runtime.usingBaseFallback = true;
			await slot.window.loadURL(companyUserlandUrl(runtime, "base"));
		});
		return true;
	});
	ipcMain.handle("userland:restore", async (event, id: string) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime || typeof id !== "string" || id.includes("/") || id.includes("\\") || id.includes(".."))
			return false;
		const runtime = slot.runtime;
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.mergeChild || runtime.wakeChild) return false;
			const userlandDir = join(runtime.root, "userland");
			const reviewed = reviewVersion(userlandDir, id);
			if (!reviewed) return false;
			const reviewDocument = JSON.stringify(reviewed, null, "\t");
			const approved = await confirmKernelReview(slot.window, {
				title: "Restore company app version",
				summary:
					"Replace the live company userland with this exact saved version? The current state is snapshotted first.",
				exactText: reviewDocument,
				metadata: `Target: ${userlandDir}\nCurrent Base: ${shellVersion()}`,
			});
			if (!approved) return false;
			const resumeOptions = {
				...runtime.childOptions,
				sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
			};
			await stopChild(runtime.child);
			if (slot.runtime !== runtime || runtime.closing) return false;
			const restart = (): void => {
				runtime.childOptions = resumeOptions;
				runtime.child = startChild(slot, runtime.root, resumeOptions);
			};
			if (JSON.stringify(reviewVersion(userlandDir, id), null, "\t") !== reviewDocument) {
				restart();
				return false;
			}
			let status: UserlandStatus | undefined;
			try {
				// Restoring an old version rejoins the CURRENT base on demand: the
				// current base is staged when the snapshot is behind.
				status = restoreVersion(userlandDir, id, {
					dir: BASE_USERLAND_DIR,
					version: shellVersion(),
				});
			} catch (error) {
				restart();
				throw error;
			}
			if (!status) {
				restart();
				return false;
			}
			runtime.userland = status;
			restart();
			if (getActiveApp(userlandDir) === "fork") {
				runtime.usingBaseFallback = false;
				await slot.window.loadURL(companyUserlandUrl(runtime, "fork")).catch(async () => {
					runtime.usingBaseFallback = true;
					await slot.window.loadURL(companyUserlandUrl(runtime, "base"));
				});
			}
			return true;
		});
	});
	// Settings → App: star a saved version. Metadata only — no reload needed.
	ipcMain.handle("userland:favorite", (event, id: string, favorite: boolean) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime || typeof id !== "string" || id.includes("/") || id.includes("\\") || id.includes(".."))
			return false;
		return setVersionFavorite(join(slot.runtime.root, "userland"), id, Boolean(favorite));
	});
	// Settings → App: pick a window icon for this company (copied into app/,
	// so it travels with the company folder and the controller can manage it).
	ipcMain.handle("userland:set-icon", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false };
		const picked = await dialog.showOpenDialog(slot.window, {
			title: "Choose the controller's window icon",
			properties: ["openFile"],
			filters: [{ name: "Images", extensions: ["ico", "png", "jpg", "jpeg"] }],
		});
		const source = picked.filePaths[0];
		if (picked.canceled || !source) return { ok: false };
		const ext = extname(source).toLowerCase().replace(".", "") || "png";
		// One icon file only — remove other variants so precedence stays obvious.
		for (const name of ICON_NAMES) {
			rmSync(join(runtime.root, "app", name), { force: true });
		}
		const target = join(runtime.root, "app", `icon.${ext === "jpeg" ? "jpg" : ext}`);
		mkdirSync(join(runtime.root, "app"), { recursive: true });
		copyFileSync(source, target);
		setWindowIcon(slot.window, target);
		return { ok: true };
	});
	// The merge button's backend: one merge session at a time, kernel-owned.
	ipcMain.handle("userland:merge", async (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, reason: "no-company" };
		return enqueueRuntimeTransition(runtime, async () => {
			if (slot.runtime !== runtime || runtime.closing) return { ok: false, reason: "no-company" };
			if (runtime.wakeChild) return { ok: false, reason: "wake-running" };
			const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
			if (!staged) return { ok: false, reason: "nothing-staged" };
			if (runtime.mergeChild && runtime.mergeChild.exitCode === null)
				return { ok: false, reason: "already-running" };
			const prompt = mergeTaskPrompt(runtime.userland);
			const approved = await confirmKernelReview(slot.window, {
				title: "Authorize autonomous userland merge",
				summary: "Start this exact agent task with write access to company userland?",
				exactText: prompt,
				metadata: `Target: ${join(runtime.root, "userland")}`,
			});
			if (!approved) return { ok: false, reason: "cancelled" };
			return { ok: await startMergeChild(slot, runtime, prompt) };
		});
	});
	ipcMain.handle("backend:authorized-post", async (event, path: string, body: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, status: 404, text: "no company" };
		return enqueueRuntimeTransition(runtime, async () => {
			if (runtime.mergeChild || !isCurrentRuntimeChild(slot, runtime, runtime.child)) {
				return { ok: false, status: 409, text: "company session changed before review" };
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
				return { ok: false, status: 413, text: "request exceeds the exact-review limit" };
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
				if (!gateDocument) return { ok: false, status: 409, text: "gate is not canonically pending" };
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
				return { ok: false, status: 409, text: "company session changed during review" };
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
					return { ok: false, status: 409, text: "gate capability target is unavailable" };
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
					headers: { "content-type": "application/json", "x-qorpera-token": runtime.backendToken },
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
			return { ok: response.ok, status: response.status, text: await response.text() };
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
		return { version: shellVersion(), pendingCompany: pending, activeCompany: active };
	});
	ipcMain.handle("rpc:send", async (event, frame: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime || runtime.mergeChild || runtime.wakeChild) return { ok: false };
		if (!frame || typeof frame !== "object" || !("type" in frame) || typeof frame.type !== "string") {
			return { ok: false };
		}
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
				if (runtime.mergeChild || !isCurrentRuntimeChild(slot, runtime, runtime.child)) return { ok: false };
				const reviewedChild = runtime.child;
				const reviewed = reviewedPromptFrame(frame as Record<string, unknown>);
				if (!reviewed || (!reviewed.message && !reviewed.images?.length)) return { ok: false };
				// Founder call (2026-08-13): typing in the composer IS the founder
				// acting — a native dialog re-confirming their own words was pure
				// friction and is gone. The kernel still observes the exact input
				// (attended, with origin) into the trail; the tradeoff accepted is
				// that "attended" now trusts the local renderer rather than an
				// OS-level dialog, the same posture as the founder's other local
				// coding tools.
				if (!isCurrentRuntimeChild(slot, runtime, reviewedChild)) return { ok: false };
				return {
					ok: sendKernelPrompt(reviewedChild, reviewed, true, "composer-attended"),
				};
			});
		}
		if (!safeControlTypes.has(frame.type)) return { ok: false };
		if (frame.type === "abort") childModelCapabilities.get(runtime.child)?.endTurn("aborted");
		return { ok: writeChildFrame(runtime.child, `${JSON.stringify(frame)}\n`) };
	});

	// A window that already knows its company (launcher argv, company smoke)
	// boots directly onto that company's durable partition — the open then
	// happens in place, with no window swap.
	const smokeCompanyIndex = process.argv.indexOf("--smoke-company");
	const smokeCompanyRoot = smokeCompanyIndex >= 0 ? process.argv[smokeCompanyIndex + 1] : undefined;
	const initial = createWindow(pendingCompany ?? smokeCompanyRoot);

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		let downloadedVersion: string | undefined;
		autoUpdater.on("checking-for-update", () => sendAll("update-status", "checking…"));
		autoUpdater.on("update-available", (info) => sendAll("update-status", `downloading ${info.version}…`));
		autoUpdater.on("update-not-available", () => sendAll("update-status", "up to date"));
		autoUpdater.on("error", (error) => sendAll("update-status", `update error: ${error.message.slice(0, 80)}`));
		autoUpdater.on("update-downloaded", (info) => {
			downloadedVersion = info.version;
			sendAll("update-ready", info.version);
		});
		autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
			console.error(`update check failed: ${error.message}`);
		});
		ipcMain.handle("update:check", () => autoUpdater.checkForUpdatesAndNotify().catch(() => undefined));
		ipcMain.handle("update:install", async (event) => {
			const slot = slotOf(event.sender);
			if (!slot || !downloadedVersion) return false;
			const approved = await confirmKernelReview(slot.window, {
				title: "Install Qorpera Base update",
				summary: "Quit every company controller and install this foundation update?",
				exactText: downloadedVersion,
			});
			if (!approved) return false;
			autoUpdater.quitAndInstall();
			return true;
		});
	} else {
		ipcMain.handle("update:check", () => {
			sendAll("update-status", "dev tree — rebuild the repo to update");
		});
		ipcMain.handle("update:install", () => {});

		// Dev-lane reflection (founder direction 2026-08-06): in a dev tree the
		// build output IS the product changing, so the kernel watches dist and
		// re-runs the open flow when it settles — fork maintenance (fast-forward
		// is content-driven) and a window reload, no restart ritual. Kernel
		// (main-process) changes still need a restart; this lane is the chrome.
		if (!IS_SMOKE) {
			let reloadTimer: NodeJS.Timeout | undefined;
			try {
				watch(DIRNAME, { recursive: true }, () => {
					if (reloadTimer) clearTimeout(reloadTimer);
					// A build writes many files; act once the burst settles.
					reloadTimer = setTimeout(() => {
						if (!existsSync(join(BASE_USERLAND_DIR, "index.html"))) return; // mid-copy
						for (const slot of slots.values()) {
							if (slot.window.isDestroyed()) continue;
							const runtime = slot.runtime;
							if (!runtime) {
								void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
								continue;
							}
							try {
								runtime.userland = ensureUserland(runtime.root, BASE_USERLAND_DIR, shellVersion());
							} catch (error) {
								console.error(`dev reload: fork maintenance failed: ${(error as Error).message}`);
							}
							const useBase =
								getActiveApp(join(runtime.root, "userland")) === "base" || runtime.usingBaseFallback;
							void slot.window
								.loadURL(companyUserlandUrl(runtime, useBase ? "base" : "fork"))
								.catch(async () => {
									runtime.usingBaseFallback = true;
									await slot.window.loadURL(companyUserlandUrl(runtime, "base"));
								});
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
	if (shotIndex >= 0 && process.argv[shotIndex + 1]) {
		const target = process.argv[shotIndex + 1];
		let timer: NodeJS.Timeout | undefined;
		initial.window.webContents.on("did-finish-load", () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(async () => {
				try {
					const image = await initial.window.webContents.capturePage();
					writeFileSync(target, image.toPNG());
					console.log(`SHOT_SAVED ${target}`);
				} catch (error) {
					console.error(`SHOT_FAILED ${(error as Error).message}`);
				}
				app.quit();
			}, 1600);
		});
	}
	// Headless smoke: prove the shell boots, then leave.
	if (process.argv.includes("--smoke")) {
		initial.window.webContents.once("did-finish-load", () => {
			console.log("SHELL_READY");
			setTimeout(() => app.quit(), 1500);
		});
	}
	// A smoke run must never hang: an openCompany failure (sandbox
	// provisioning, company lock, …) would otherwise become an unhandled
	// rejection that leaves the process alive with no exit path.
	const failSmoke = (error: Error): void => {
		console.error(`SMOKE_FAILED ${error.message}`);
		app.exit(1);
	};
	// Fork-model smoke: open a company, prove its userland loads.
	if (smokeCompanyRoot) {
		void openCompany(initial, smokeCompanyRoot).then(() => {
			setTimeout(() => {
				console.log(
					`USERLAND_LOADED ${initial.window.webContents.getURL()} action=${initial.runtime?.userland.action}`,
				);
				app.quit();
			}, 1500);
		}, failSmoke);
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
