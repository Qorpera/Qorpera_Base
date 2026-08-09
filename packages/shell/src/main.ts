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
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import {
	companyRuntimeLockPath,
	conceptionKickoff,
	createProductWorktree,
	enforceCompanyKernelSettings,
	integrateRepo,
	listCompanies,
	listProductDepartments,
	type ProductDepartment,
	readProductProtectionInventory,
	registerCompany,
	scaffoldCompany,
} from "@qorpera/pi-coding-agent/company";
import { app, BrowserWindow, dialog, shell as electronShell, ipcMain, type WebContents } from "electron";
import electronUpdater from "electron-updater";
import {
	appendKernelObservation,
	applyKernelWriteFrame,
	bindTrailSession,
	commitTrailAppend,
	createKernelResponseSigner,
	inboxMessagesPath,
	type KernelIntentCapability,
	parseTrailAppendFrame,
	protectedControllerPaths,
	sandboxCommandArgs,
	sandboxConfigDir,
	sandboxRuntimeDir,
	type TrailBinding,
	writeSandboxProfile,
} from "./agent-runtime.ts";
import {
	captureCompanyGitBaseline,
	checkpointCompanyGit,
	commitCompanyMaterialization,
	finishPendingCompanyCheckpoint,
	reconcilePendingCompanyCheckpoints,
	savePendingCompanyCheckpoint,
} from "./company-checkpoint.ts";
import {
	ensureUserland,
	getActiveApp,
	isUnmodified,
	listVersions,
	mergeTaskPrompt,
	restoreVersion,
	setActiveApp,
	setVersionFavorite,
	snapshotIfChanged,
	type UserlandStatus,
	type UserlandVersion,
} from "./userland-manager.ts";

const RPC_ENTRY = fileURLToPath(import.meta.resolve("@qorpera/pi-coding-agent/rpc-entry"));
const CODEX_ENTRY = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
const DIRNAME = fileURLToPath(new URL(".", import.meta.url));
const FOUNDATION_READ_PATHS = [dirname(process.execPath), resolve(DIRNAME, "..", "..", "..")];
const MODEL_NETWORK_DOMAINS = [
	"api.openai.com",
	"chatgpt.com",
	"api.anthropic.com",
	"generativelanguage.googleapis.com",
	"aiplatform.googleapis.com",
	"api.groq.com",
	"api.mistral.ai",
	"api.x.ai",
	"openrouter.ai",
	"api.cerebras.ai",
	"api.deepseek.com",
	"api.z.ai",
	"api.moonshot.ai",
	"api.minimax.io",
	"api-inference.huggingface.co",
];
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
const SAFE_CHILD_ENV = new Set([
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"TEMP",
	"TMP",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"CEREBRAS_API_KEY",
	"DEEPSEEK_API_KEY",
]);

function prepareBrokeredAgentDir(configDir: string, companyRoot: string): string {
	if (process.platform === "win32") {
		const codexHome = join(app.getPath("home"), ".codex");
		for (const relativePath of [
			join(".sandbox", "setup_marker.json"),
			join(".sandbox", "deny_read_acl_state.json"),
			join(".sandbox-secrets", "sandbox_users.json"),
		]) {
			const source = join(codexHome, relativePath);
			if (!existsSync(source)) {
				throw new Error(
					"The elevated Codex Windows sandbox is not provisioned. Qorpera refuses to start an unrestricted controller.",
				);
			}
			const target = join(configDir, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			if (!existsSync(target)) copyFileSync(source, target);
		}
	}
	const agentDir = join(configDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const source = join(app.getPath("home"), ".qorpera", "agent", "auth.json");
	let auth: Record<string, unknown> = {};
	try {
		const candidate = JSON.parse(readFileSync(source, "utf-8")) as Record<string, unknown>;
		auth = Object.fromEntries(Object.entries(candidate).filter(([provider]) => MODEL_AUTH_PROVIDERS.has(provider)));
	} catch {
		// No model credentials are available yet. The child remains network- and credential-denied.
	}
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(auth, null, "\t")}\n`, "utf-8");
	writeFileSync(
		join(agentDir, "trust.json"),
		`${JSON.stringify({ [resolve(companyRoot)]: true }, null, "\t")}\n`,
		"utf-8",
	);
	return agentDir;
}

function brokeredChildEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => SAFE_CHILD_ENV.has(key) && value));
}

let modelProxyPort: number | undefined;
let closeModelProxy: (() => void) | undefined;

async function startModelNetworkBroker(): Promise<void> {
	const allowed = new Set(MODEL_NETWORK_DOMAINS);
	const server = createServer((_request, response) => {
		response.writeHead(403, { "content-type": "text/plain" });
		response.end("Qorpera model broker requires an HTTPS CONNECT tunnel");
	});
	server.on("connect", (request, client, head) => {
		let target: URL;
		try {
			target = new URL(`https://${request.url}`);
		} catch {
			client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
		const port = Number(target.port || "443");
		if (!allowed.has(hostname) || port !== 443) {
			client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const upstream = connect({ host: hostname, port }, () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("model network broker did not bind a TCP port");
	modelProxyPort = address.port;
	closeModelProxy = () => server.close();
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
	inventoryWatcher?: ReturnType<typeof watch>;
	transitionQueue: Promise<void>;
	closing: boolean;
	runtimeLock: string;
}

/** One window = one slot: the hub while `runtime` is unset, a company
 * controller once one is open. All per-company state hangs off the slot so
 * controllers never share a child, a backend, or a kickoff flag. */
interface Slot {
	window: BrowserWindow;
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
const childBindings = new WeakMap<ChildProcessWithoutNullStreams, TrailBinding>();
const childIntentSigners = new WeakMap<
	ChildProcessWithoutNullStreams,
	(frame: Record<string, unknown>, attended: boolean) => KernelIntentCapability
>();
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
	const resolved = resolve(root);
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
	await runtime.transitionQueue;
	await stopChild(runtime.child);
	if (runtime.mergeChild) await stopChild(runtime.mergeChild);
	runtime.backendClose?.();
	rmSync(runtime.runtimeLock, { force: true });
	slot.runtime = undefined;
}

function claimCompanyRuntime(root: string): string {
	const path = companyRuntimeLockPath(root);
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		let owner = 0;
		try {
			owner = (JSON.parse(readFileSync(path, "utf-8")) as { pid?: number }).pid ?? 0;
		} catch {
			// Invalid records are stale only when no live owning process can be identified.
		}
		if (owner > 0) {
			let ownerIsLive = false;
			try {
				process.kill(owner, 0);
				ownerIsLive = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
					throw new Error("could not safely verify the existing company runtime owner", { cause: error });
				}
			}
			if (ownerIsLive) throw new Error("another desktop kernel already owns this company runtime");
		}
		rmSync(path, { force: true });
	}
	writeFileSync(path, `${JSON.stringify({ version: 1, pid: process.pid, root: resolve(root) })}\n`, { flag: "wx" });
	return path;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode === null) {
		intentionalKills.add(child);
		child.kill();
	}
	await childCheckpointCompletion.get(child);
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
	onRpcEvent?: (frame: { type?: string }) => void;
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
	} as const;
	const userData = app.getPath("userData");
	const configDir = sandboxConfigDir(userData, root, actor);
	const runtimeDir = sandboxRuntimeDir(userData, root, actor);
	const agentDir = prepareBrokeredAgentDir(configDir, root);
	let gitBaseline = captureCompanyGitBaseline(root);
	const binding = bindTrailSession(root, cwd, scope, sessionFile);
	const checkpointDir = join(dirname(sandboxConfigDir(userData, root, "controller")), "checkpoints");
	const checkpointState = join(checkpointDir, `${binding.token}.json`);
	savePendingCompanyCheckpoint(checkpointState, root, gitBaseline, binding.file);
	inboxMessagesPath(root);
	const products = readProductProtectionInventory(root).map((product) => ({
		repository: product.repositoryPath,
		worktrees: product.worktreesPath,
	}));
	writeSandboxProfile(
		configDir,
		runtimeDir,
		root,
		scope,
		protectedControllerPaths(root, products),
		[
			...FOUNDATION_READ_PATHS,
			join(configDir, "config.toml"),
			join(agentDir, "auth.json"),
			join(agentDir, "trust.json"),
		],
		MODEL_NETWORK_DOMAINS,
	);
	const rpcArgs = [RPC_ENTRY, "--mode", "rpc", "--session", binding.path];
	const args = sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, rpcArgs);
	const kernelSigner = createKernelResponseSigner();
	// QORPERA_AUTONOMOUS marks controller-initiated work: those sessions run
	// in rpc mode with nobody present, so outward-effect signatures cannot
	// treat them as founder sessions. Product roles remain separate either way.
	const env: NodeJS.ProcessEnv = brokeredChildEnvironment();
	env.ELECTRON_RUN_AS_NODE = "1";
	env.HOME = runtimeDir;
	env.USERPROFILE = runtimeDir;
	env.APPDATA = runtimeDir;
	env.LOCALAPPDATA = runtimeDir;
	env.XDG_CONFIG_HOME = runtimeDir;
	if (process.platform === "win32") {
		if (!modelProxyPort) throw new Error("model network broker is unavailable");
		const proxy = `http://127.0.0.1:${modelProxyPort}`;
		env.HTTP_PROXY = proxy;
		env.HTTPS_PROXY = proxy;
		env.ALL_PROXY = proxy;
		env.NODE_USE_ENV_PROXY = "1";
	}
	if (autonomousName) env.QORPERA_AUTONOMOUS = "1";
	delete env.QORPERA_ACTOR;
	delete env.QORPERA_PRODUCT_DEPARTMENT;
	delete env.QORPERA_PRODUCT_WORKTREE;
	env.CODEX_HOME = configDir;
	env.QORPERA_CODING_AGENT_DIR = agentDir;
	env.QORPERA_TRAIL_BROKER_TOKEN = binding.token;
	env.QORPERA_KERNEL_PUBLIC_KEY = kernelSigner.publicKey;
	env.QORPERA_KERNEL_REQUIRED = "1";
	const child = spawn(process.execPath, args, {
		cwd: runtimeDir,
		stdio: ["pipe", "pipe", "pipe"],
		env,
	}) as ChildProcessWithoutNullStreams;
	childBindings.set(child, binding);
	childIntentSigners.set(child, kernelSigner.signIntent);
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
			if (
				applyKernelWriteFrame(frame, binding, root, (response) => {
					child.stdin.write(`${JSON.stringify(kernelSigner.signResponse(response))}\n`);
				})
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
				const result = checkpointCompanyGit(root, gitBaseline, binding.file);
				gitBaseline = result.baseline;
				savePendingCompanyCheckpoint(checkpointState, root, gitBaseline, binding.file);
			}
			if (onRpcEvent) onRpcEvent(frame as { type?: string });
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
		try {
			const result = checkpointCompanyGit(root, gitBaseline, binding.file);
			finishPendingCompanyCheckpoint(checkpointState, result);
			if (!result.success) savePendingCompanyCheckpoint(checkpointState, root, result.baseline, binding.file);
		} finally {
			resolveCheckpoint?.();
		}
	});
	return child;
}

function sendKernelPrompt(
	child: ChildProcessWithoutNullStreams,
	frame: { type: "prompt" | "steer" | "follow_up"; message: string; [key: string]: unknown },
	attended: boolean,
	origin: string,
): boolean {
	const binding = childBindings.get(child);
	const signIntent = childIntentSigners.get(child);
	if (!binding || !signIntent || child.exitCode !== null) return false;
	const unsignedFrame = { ...frame };
	delete unsignedFrame.kernelIntent;
	appendKernelObservation(binding, {
		frameType: frame.type,
		message: frame.message,
		attended,
		origin,
	});
	const kernelIntent = signIntent(unsignedFrame, attended);
	child.stdin.write(`${JSON.stringify({ ...unsignedFrame, kernelIntent })}\n`);
	return true;
}

async function replaceRuntimeChild(slot: Slot, runtime: CompanyRuntime, options: ChildOptions): Promise<void> {
	await stopChild(runtime.child);
	if (slot.runtime !== runtime) return;
	runtime.childOptions = { ...options };
	runtime.child = startChild(slot, runtime.root, runtime.childOptions);
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

function restartForProductInventory(slot: Slot, runtime: CompanyRuntime): void {
	void enqueueRuntimeTransition(runtime, async () => {
		if (slot.runtime !== runtime || runtime.mergeChild) return;
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
async function startMergeChild(slot: Slot, runtime: CompanyRuntime): Promise<boolean> {
	const prompt = mergeTaskPrompt(runtime.userland);
	const resumeOptions = {
		...runtime.childOptions,
		sessionFile: childBindings.get(runtime.child)?.file ?? runtime.childOptions.sessionFile,
	};
	await stopChild(runtime.child);
	if (slot.runtime !== runtime || runtime.closing) return false;
	let started = false;
	let child: ChildProcessWithoutNullStreams;
	child = startChild(slot, runtime.root, {
		autonomousName: `userland merge v${runtime.userland.stagedVersion}`,
		silent: true,
		onRpcEvent: (frame) => {
			if (frame.type === "agent_start") started = true;
			// Any settle ends the run — including a prompt that failed before
			// starting (never keeping a settled merge child alive beats a zombie
			// that blocks userland:merge forever).
			if (frame.type === "agent_settled") {
				if (!started) console.error("merge session settled without starting (prompt failed?)");
				intentionalKills.add(child);
				child.kill();
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
				ok = runtime.userland.action === "current" || runtime.userland.action === "fast-forwarded";
			}
		} catch (error) {
			console.error(`post-merge userland refresh failed: ${(error as Error).message}`);
		}
		send(slot.window, "merge-done", { ok, action: runtime.userland.action });
		runtime.childOptions = resumeOptions;
		runtime.child = startChild(slot, runtime.root, resumeOptions);
	});
	if (!sendKernelPrompt(child, { type: "prompt", message: prompt }, false, "kernel-userland-merge")) {
		await stopChild(child);
		if (runtime.mergeChild === child) runtime.mergeChild = undefined;
		if (slot.runtime === runtime && !runtime.closing) runtime.child = startChild(slot, runtime.root, resumeOptions);
		return false;
	}
	return true;
}

/** Each open company owns its backend server and token. The hashed port can
 * collide — another company's hash, or an external `qorpera app` — so walk
 * forward until a bind succeeds: the renderer resolves everything relative
 * to backendUrl, and only a server we own honors the token we minted. */
async function listenBackend(root: string, authToken: string): Promise<{ port: number; close: () => void }> {
	const base = companyPort(root);
	for (let port = base; port < base + 10; port++) {
		const server = createCompanyAppServer({ root, port, authToken });
		const listening = await new Promise<boolean>((resolvePromise) => {
			server.once("error", () => resolvePromise(false));
			server.listen(port, "127.0.0.1", () => resolvePromise(true));
		});
		if (listening) return { port, close: () => server.close() };
	}
	throw new Error(`no free backend port near ${base} for ${root}`);
}

interface ActiveCompany {
	root: string;
	backendUrl: string;
	kickoff: boolean;
	userland: UserlandStatus;
	usingBaseFallback: boolean;
	mergePrompt?: string;
	mergeRunning: boolean;
	activeApp: "fork" | "base";
	versions: UserlandVersion[];
	evolved: boolean;
}

function activeCompanyInfo(slot: Slot): ActiveCompany | undefined {
	const runtime = slot.runtime;
	if (!runtime) return undefined;
	const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
	const userlandDir = join(runtime.root, "userland");
	return {
		root: runtime.root,
		backendUrl: `http://127.0.0.1:${runtime.backendPort}`,
		kickoff: false,
		userland: runtime.userland,
		usingBaseFallback: runtime.usingBaseFallback,
		mergePrompt: staged ? mergeTaskPrompt(runtime.userland) : undefined,
		mergeRunning: Boolean(runtime.mergeChild && runtime.mergeChild.exitCode === null),
		activeApp: getActiveApp(userlandDir),
		versions: listVersions(userlandDir),
		evolved: !isUnmodified(userlandDir),
	};
}

async function openCompany(slot: Slot, root: string): Promise<void> {
	// Refuse non-companies outright: opening is what registers a root and
	// forks a userland into it, so an invalid path here would mint a fake
	// company. The window stays on (or returns to) the hub instead.
	if (!isCompanyRoot(root)) {
		console.error(`refusing to open non-company root: ${root}`);
		if (!slot.runtime) void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		return;
	}
	readProductProtectionInventory(root);
	enforceCompanyKernelSettings(root);
	const checkpointDir = join(dirname(sandboxConfigDir(app.getPath("userData"), root, "controller")), "checkpoints");
	reconcilePendingCompanyCheckpoints(checkpointDir, root);
	// A company never runs in two windows: two RPC children on one trail and
	// two tokens against one backend both end badly. Route to the live one.
	const existing = slotForCompany(root);
	if (existing && existing !== slot) {
		focusWindow(existing.window);
		return;
	}
	await closeCompany(slot);
	registerCompany(root);

	// The fork model (spec §9a): the company runs ITS OWN userland — forked
	// from base on first open, fast-forwarded when untouched, staged for a
	// controller merge when evolved. The kernel only loads it.
	const userland = ensureUserland(root, BASE_USERLAND_DIR, shellVersion());
	// Any evolution since the last open is captured as a restorable version —
	// the founder can always roll the app back from Settings → App.
	snapshotIfChanged(join(root, "userland"));
	commitCompanyMaterialization(root, [join(".qorpera", "settings.json"), "userland"]);

	// Backend for surfaces/state/inbox — reused machinery, in-process. The
	// token guards mutating endpoints; only the renderer ever receives it.
	const backendToken = randomUUID();
	const backend = await listenBackend(root, backendToken);

	// Never-conceived company: the conception session is autonomous work.
	const kickoff = conceptionKickoff(root);
	const childOptions: ChildOptions = kickoff ? { autonomousName: "conception" } : {};
	const runtimeLock = claimCompanyRuntime(root);
	let child: ChildProcessWithoutNullStreams;
	try {
		child = startChild(slot, root, childOptions);
	} catch (error) {
		rmSync(runtimeLock, { force: true });
		backend.close();
		throw error;
	}
	const runtime: CompanyRuntime = {
		root,
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
	runtime.inventoryWatcher = watch(join(root, ".qorpera"), { persistent: false }, (_event, file) => {
		if (file?.toString() === "products.json") restartForProductInventory(slot, runtime);
	});
	if (kickoff) {
		sendKernelPrompt(child, { type: "prompt", message: kickoff }, false, "kernel-conception");
	}
	slot.kickoffPending = Boolean(kickoff);

	// Load the company's own app — unless the founder switched this company to
	// the pristine base app (Settings → App). If the evolved userland fails to
	// boot, the kernel falls back to the base chrome — the company stays
	// reachable either way.
	const win = slot.window;
	if (win.isDestroyed()) return;
	setWindowIcon(win, companyIcon(root));
	if (getActiveApp(join(root, "userland")) === "base") {
		await win.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		return;
	}
	await win.loadFile(join(root, "userland", "index.html")).catch(async () => {
		if (slot.runtime) slot.runtime.usingBaseFallback = true;
		await win.loadFile(join(BASE_USERLAND_DIR, "index.html"));
	});
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
	if (typeof departmentPath === "string" && departmentPath.length > 0) {
		department = listProductDepartments(runtime.root).find(
			(entry) => entry.path === departmentPath && entry.repositoryExists,
		);
		if (!department) return { ok: false, error: "product department or repository is unavailable" };
		const confirmation = await dialog.showMessageBox(slot.window, {
			type: "warning",
			buttons: ["Cancel", "Open product worker"],
			defaultId: 0,
			cancelId: 0,
			message: `Open a product worker for ${department.name}?`,
			detail:
				"This trusted kernel action issues write access to one isolated task worktree. The company controller cannot issue this capability.",
		});
		if (confirmation.response !== 1) return { ok: false, error: "product worker authorization cancelled" };
		if (worktreePath) {
			const resolvedWorktree = resolve(runtime.root, worktreePath);
			const worktreesRoot = resolve(runtime.root, department.worktreesPath);
			if (!isInside(resolvedWorktree, worktreesRoot) || !existsSync(join(resolvedWorktree, ".git"))) {
				return { ok: false, error: "worktree is outside the product department or no longer exists" };
			}
			worktree = relative(runtime.root, resolvedWorktree);
		} else {
			worktree = createProductWorktree(runtime.root, department)?.path;
			if (!worktree) return { ok: false, error: "could not create product worktree" };
		}
	}
	const options: ChildOptions = {
		sessionFile: sessionFile ?? undefined,
		department,
		worktree,
	};
	await replaceRuntimeChild(slot, runtime, options);
	return { ok: true, department: department?.path, worktree };
}

function createWindow(): Slot {
	const win = new BrowserWindow({
		width: 1360,
		height: 860,
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
		},
	});
	const slot: Slot = { window: win, kickoffPending: false };
	slots.set(win.id, slot);
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
	void win.loadFile(join(BASE_USERLAND_DIR, "index.html"));
	win.webContents.setWindowOpenHandler(({ url }) => {
		void electronShell.openExternal(url);
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
	// A crashed evolved userland must not strand the company: fall back to
	// the base chrome (kernel duty — last-good behavior).
	win.webContents.on("render-process-gone", () => {
		if (slot.runtime && !slot.runtime.usingBaseFallback) {
			slot.runtime.usingBaseFallback = true;
			void win.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		}
	});
	// Closing a controller window is closing that company: kill its child
	// and backend; other windows are untouched.
	win.on("closed", () => {
		slots.delete(win.id);
		void closeCompany(slot);
	});
	return slot;
}

// Single instance: relaunching (e.g. a company launcher) routes into the
// running shell instead of stacking processes running different builds —
// but windows are per-company, so a launcher for a company that is not open
// gets a NEW window next to the others. Smoke runs are headless test boots
// and must not join or disturb a live instance.
const IS_SMOKE = process.argv.some((arg) => arg.startsWith("--smoke"));
if (!IS_SMOKE && !app.requestSingleInstanceLock()) {
	app.quit();
}
app.on("second-instance", (_event, argv) => {
	const root = companyFromArgv(argv);
	if (root) {
		const existing = slotForCompany(root);
		if (existing) focusWindow(existing.window);
		else void openCompany(createWindow(), root);
		return;
	}
	// Launching "Qorpera Base" itself means: take me to the hub — in its own
	// window, without yanking any open controller off its company.
	const hub = [...slots.values()].find((slot) => !slot.runtime);
	if (hub) focusWindow(hub.window);
	else createWindow();
});

app.whenReady().then(async () => {
	await startModelNetworkBroker();
	ipcMain.handle("companies:list", () => listCompanies());
	ipcMain.handle("company:open", (event, root: string) => {
		if (!isTrustedHubSender(event.sender)) return;
		const slot = slotOf(event.sender);
		if (slot) return openCompany(slot, root);
	});
	ipcMain.handle("company:new", async (event, dir: string) => {
		if (!isTrustedHubSender(event.sender) || typeof dir !== "string" || !dir.trim()) return;
		const target = resolve(dir);
		const confirmation = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, {
			type: "warning",
			buttons: ["Cancel", "Create company"],
			defaultId: 0,
			cancelId: 0,
			message: "Create a company folder at this location?",
			detail: target,
		});
		if (confirmation.response !== 1) return;
		const result = scaffoldCompany(target);
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
	ipcMain.handle("company:close", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return closeCompany(slot);
	});
	ipcMain.handle("chat:open", (event, sessionFile: string | null, department?: string, worktree?: string) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false };
		return enqueueRuntimeTransition(runtime, () => {
			if (slot.runtime !== runtime || runtime.closing || runtime.mergeChild) return Promise.resolve({ ok: false });
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
		const dir = appChoice === "base" ? BASE_USERLAND_DIR : join(runtime.root, "userland");
		await slot.window.loadFile(join(dir, "index.html")).catch(async () => {
			runtime.usingBaseFallback = true;
			await slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		});
		return true;
	});
	ipcMain.handle("userland:restore", async (event, id: string) => {
		const slot = slotOf(event.sender);
		if (!slot?.runtime || typeof id !== "string" || id.includes("/") || id.includes("\\") || id.includes(".."))
			return false;
		const runtime = slot.runtime;
		// Restoring an old version rejoins the CURRENT base on demand: the
		// restore stages it like an arriving update when the snapshot is
		// behind. The live status follows so the merge button shows without
		// a reopen (the reload below reboots the renderer off app:info).
		const status = restoreVersion(join(runtime.root, "userland"), id, {
			dir: BASE_USERLAND_DIR,
			version: shellVersion(),
		});
		if (!status) return false;
		runtime.userland = status;
		if (getActiveApp(join(runtime.root, "userland")) === "fork") {
			runtime.usingBaseFallback = false;
			await slot.window.loadFile(join(runtime.root, "userland", "index.html")).catch(async () => {
				runtime.usingBaseFallback = true;
				await slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
			});
		}
		return true;
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
			const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
			if (!staged) return { ok: false, reason: "nothing-staged" };
			if (runtime.mergeChild && runtime.mergeChild.exitCode === null)
				return { ok: false, reason: "already-running" };
			return { ok: await startMergeChild(slot, runtime) };
		});
	});
	ipcMain.handle("backend:authorized-post", async (event, path: string, body: unknown) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, status: 404, text: "no company" };
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
		if (serialized.length > 1024 * 1024) return { ok: false, status: 413, text: "request too large" };
		const confirmation = await dialog.showMessageBox(slot.window, {
			type: "warning",
			buttons: ["Cancel", "Authorize"],
			defaultId: 0,
			cancelId: 0,
			message: `Authorize kernel action: ${action}?`,
			detail: serialized.slice(0, 4000),
		});
		if (confirmation.response !== 1) return { ok: false, status: 403, text: "cancelled" };
		const response = await fetch(`http://127.0.0.1:${runtime.backendPort}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-qorpera-token": runtime.backendToken },
			body: serialized,
		});
		return { ok: response.ok, status: response.status, text: await response.text() };
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
		if (!slot || !runtime || runtime.mergeChild) return { ok: false };
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
			const message = "message" in frame && typeof frame.message === "string" ? frame.message : "";
			if (!message) return { ok: false };
			const target = runtime.productWorker ? runtime.productWorker.department : "company controller";
			const assignment = runtime.productWorker ? `\n\nAssigned worktree: ${runtime.productWorker.worktree}` : "";
			const confirmation = await dialog.showMessageBox(slot.window, {
				type: "warning",
				buttons: ["Cancel", "Send instruction"],
				defaultId: 0,
				cancelId: 0,
				message: `Authorize this instruction to the ${target}?`,
				detail: `${message.slice(0, 4000)}${assignment}`,
			});
			if (confirmation.response !== 1) return { ok: false };
			return {
				ok: sendKernelPrompt(
					runtime.child,
					frame as { type: "prompt" | "steer" | "follow_up"; message: string; [key: string]: unknown },
					true,
					"native-founder-confirmation",
				),
			};
		}
		if (!safeControlTypes.has(frame.type)) return { ok: false };
		runtime.child.stdin.write(`${JSON.stringify(frame)}\n`);
		return { ok: true };
	});

	const initial = createWindow();

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		autoUpdater.on("checking-for-update", () => sendAll("update-status", "checking…"));
		autoUpdater.on("update-available", (info) => sendAll("update-status", `downloading ${info.version}…`));
		autoUpdater.on("update-not-available", () => sendAll("update-status", "up to date"));
		autoUpdater.on("error", (error) => sendAll("update-status", `update error: ${error.message.slice(0, 80)}`));
		autoUpdater.on("update-downloaded", (info) => sendAll("update-ready", info.version));
		autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
			console.error(`update check failed: ${error.message}`);
		});
		ipcMain.handle("update:check", () => autoUpdater.checkForUpdatesAndNotify().catch(() => undefined));
		ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());
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
							const dir = useBase ? BASE_USERLAND_DIR : join(runtime.root, "userland");
							void slot.window.loadFile(join(dir, "index.html")).catch(async () => {
								runtime.usingBaseFallback = true;
								await slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
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
	// Fork-model smoke: open a company, prove its userland loads.
	const smokeCompanyIndex = process.argv.indexOf("--smoke-company");
	if (smokeCompanyIndex >= 0 && process.argv[smokeCompanyIndex + 1]) {
		void openCompany(initial, process.argv[smokeCompanyIndex + 1]).then(() => {
			setTimeout(() => {
				console.log(
					`USERLAND_LOADED ${initial.window.webContents.getURL()} action=${initial.runtime?.userland.action}`,
				);
				app.quit();
			}, 1500);
		});
	}
	// Multi-window smoke: two companies, two live controllers side by side.
	const smokeMultiIndex = process.argv.indexOf("--smoke-multi");
	if (smokeMultiIndex >= 0 && process.argv[smokeMultiIndex + 1] && process.argv[smokeMultiIndex + 2]) {
		const rootA = process.argv[smokeMultiIndex + 1];
		const rootB = process.argv[smokeMultiIndex + 2];
		void openCompany(initial, rootA).then(async () => {
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
		});
	}
});

app.on("will-quit", () => closeModelProxy?.());

app.on("window-all-closed", () => {
	app.quit();
});
