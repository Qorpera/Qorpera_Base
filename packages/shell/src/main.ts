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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import {
	conceptionKickoff,
	integrateRepo,
	listCompanies,
	listProductScopes,
	registerCompany,
	scaffoldCompany,
} from "@qorpera/pi-coding-agent/company";
import { app, BrowserWindow, dialog, shell as electronShell, ipcMain, type WebContents } from "electron";
import electronUpdater from "electron-updater";
import {
	ensureUserland,
	getActiveApp,
	isUnmodified,
	listVersions,
	mergeTaskPrompt,
	restoreVersion,
	setActiveApp,
	snapshotIfChanged,
	type UserlandStatus,
	type UserlandVersion,
} from "./userland-manager.ts";

const RPC_ENTRY = fileURLToPath(import.meta.resolve("@qorpera/pi-coding-agent/rpc-entry"));
const DIRNAME = fileURLToPath(new URL(".", import.meta.url));

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
	/** Live userland-merge session, if one is running (kernel-spawned, silent). */
	mergeChild?: ChildProcessWithoutNullStreams;
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
	intentionalKills.add(slot.runtime.child);
	slot.runtime.child.kill();
	if (slot.runtime.mergeChild) {
		intentionalKills.add(slot.runtime.mergeChild);
		slot.runtime.mergeChild.kill();
	}
	slot.runtime.backendClose?.();
	slot.runtime = undefined;
}

/** Spawn the intelligence: the CLI's RPC mode under Electron's own Node.
 * With sessionFile, resumes that trail session; without, starts fresh.
 * Autonomous work is tagged with a session name so the trail (and the
 * Activity view) can tell controller-initiated sessions from chats.
 *
 * A product scope (founder-selected, kernel-confirmed) roots the child INSIDE
 * the product and carries the grant as QORPERA_SCOPE — the authority layer
 * pre-approves that zone for this session and nothing else. The session file
 * still lands in the company trail (explicit --session-dir: a product dir has
 * no project settings pointing there), and a fresh scoped session is named
 * `scope — <path>` so the chat list can restore its scope on open. */
interface ChildOptions {
	sessionFile?: string;
	autonomousName?: string;
	scope?: string;
}

function startChild(slot: Slot, root: string, options: ChildOptions = {}): ChildProcessWithoutNullStreams {
	const { sessionFile, autonomousName, scope } = options;
	const win = slot.window;
	const args = [RPC_ENTRY, "--mode", "rpc"];
	if (sessionFile) args.push("--session", join(root, "trail", sessionFile));
	if (autonomousName) args.push("--name", `autonomous — ${autonomousName}`);
	if (scope) {
		args.push("--session-dir", join(root, "trail"));
		if (!sessionFile) args.push("--name", `scope — ${scope}`);
	}
	const child = spawn(process.execPath, args, {
		cwd: scope ? join(root, scope) : root,
		stdio: ["pipe", "pipe", "pipe"],
		env: scope
			? { ...process.env, ELECTRON_RUN_AS_NODE: "1", QORPERA_SCOPE: scope }
			: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	}) as ChildProcessWithoutNullStreams;
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		try {
			send(win, "rpc-event", JSON.parse(line));
		} catch {
			send(win, "rpc-log", line);
		}
	});
	createInterface({ input: child.stderr }).on("line", (line) => send(win, "rpc-log", line));
	child.on("exit", (code) => {
		if (!intentionalKills.has(child)) send(win, "rpc-exit", code);
	});
	return child;
}

/**
 * Run the staged userland merge as its OWN autonomous session — never
 * through the founder's chat child, so a reload can't re-send the task into
 * a session that already ran it. Silent: events are consumed here (the
 * agent's own settle ends the run), not forwarded to the chat pane. The
 * result reaches the renderer as one `merge-done` event, and the open-time
 * userland status is refreshed so the merge button reflects reality.
 */
function startMergeChild(slot: Slot, runtime: CompanyRuntime): void {
	const prompt = mergeTaskPrompt(runtime.userland);
	const args = [
		RPC_ENTRY,
		"--mode",
		"rpc",
		"--name",
		`autonomous — userland merge v${runtime.userland.stagedVersion}`,
	];
	const child = spawn(process.execPath, args, {
		cwd: runtime.root,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	}) as ChildProcessWithoutNullStreams;
	runtime.mergeChild = child;
	let started = false;
	createInterface({ input: child.stdout }).on("line", (line) => {
		let frame: { type?: string };
		try {
			frame = JSON.parse(line) as { type?: string };
		} catch {
			return;
		}
		if (frame.type === "agent_start") started = true;
		// Any settle ends the run — including a prompt that failed before
		// starting (never keeping a settled merge child alive beats a zombie
		// that blocks userland:merge forever).
		if (frame.type === "agent_settled") {
			if (!started) console.error("merge session settled without starting (prompt failed?)");
			intentionalKills.add(child);
			child.kill();
		}
	});
	createInterface({ input: child.stderr }).on("line", () => {});
	child.on("exit", () => {
		if (slot.runtime !== runtime) return; // company was closed meanwhile
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
	});
	child.stdin.write(`${JSON.stringify({ type: "prompt", message: prompt })}\n`);
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
	backendToken: string;
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
		backendToken: runtime.backendToken,
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

	// Backend for surfaces/state/inbox — reused machinery, in-process. The
	// token guards mutating endpoints; only the renderer ever receives it.
	const backendToken = randomUUID();
	const backend = await listenBackend(root, backendToken);

	// Never-conceived company: the conception session is autonomous work.
	const kickoff = conceptionKickoff(root);
	const child = startChild(slot, root, kickoff ? { autonomousName: "conception" } : {});
	slot.runtime = {
		root,
		child,
		backendPort: backend.port,
		backendClose: backend.close,
		userland,
		usingBaseFallback: false,
		backendToken,
	};
	if (kickoff) {
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: kickoff })}\n`);
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

function showHub(slot: Slot): void {
	void closeCompany(slot);
	setWindowIcon(slot.window, DEFAULT_ICON);
	void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
}

/** Switch the chat to a trail session (or a fresh one) without touching the backend.
 *
 * A requested product scope is validated against the ratified authority.toml:
 * an undeclared or missing zone grants nothing — the session opens unscoped
 * at the company root. The chip click IS the grant (founder decision,
 * 2026-08-06: no confirmation dialog — it broke the flow it exists to
 * serve). The residual exposure — evolved userland code invoking this IPC
 * without a human click — is accepted tripwire-grade: scope state is always
 * visible on the chrome, every scoped effect is stamped in the trail, and
 * autonomous spawns never carry a scope. Returns the effective scope so the
 * chrome reflects what was actually granted. */
function openChat(slot: Slot, sessionFile: string | null, scope?: string): { ok: boolean; scope?: string } {
	if (!slot.runtime) return { ok: false };
	const runtime = slot.runtime;
	let effectiveScope: string | undefined;
	if (typeof scope === "string" && scope.length > 0) {
		const declared = listProductScopes(runtime.root).find((entry) => entry.path === scope && entry.exists);
		if (declared) effectiveScope = declared.path;
	}
	intentionalKills.add(runtime.child);
	runtime.child.kill();
	runtime.child = startChild(slot, runtime.root, { sessionFile: sessionFile ?? undefined, scope: effectiveScope });
	return { ok: true, scope: effectiveScope };
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

app.whenReady().then(() => {
	ipcMain.handle("companies:list", () => listCompanies());
	ipcMain.handle("company:open", (event, root: string) => {
		const slot = slotOf(event.sender);
		if (slot) return openCompany(slot, root);
	});
	ipcMain.handle("company:new", (_event, dir: string) => {
		const result = scaffoldCompany(dir);
		registerCompany(result.root);
		return result.root;
	});
	ipcMain.handle("company:integrate", (_event, dir: string, from: string) => {
		const result = scaffoldCompany(dir);
		registerCompany(result.root);
		const ok = integrateRepo(result.root, from);
		return { root: result.root, ok };
	});
	ipcMain.handle("company:close", (event) => {
		const slot = slotOf(event.sender);
		if (slot) return closeCompany(slot);
	});
	ipcMain.handle("chat:open", (event, sessionFile: string | null, scope?: string) => {
		const slot = slotOf(event.sender);
		return slot ? openChat(slot, sessionFile, scope) : { ok: false };
	});
	ipcMain.handle("hub:show", (event) => {
		const slot = slotOf(event.sender);
		if (slot) showHub(slot);
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
	ipcMain.handle("userland:merge", (event) => {
		const slot = slotOf(event.sender);
		const runtime = slot?.runtime;
		if (!slot || !runtime) return { ok: false, reason: "no-company" };
		const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
		if (!staged) return { ok: false, reason: "nothing-staged" };
		if (runtime.mergeChild && runtime.mergeChild.exitCode === null) return { ok: false, reason: "already-running" };
		startMergeChild(slot, runtime);
		return { ok: true };
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
	ipcMain.handle("rpc:send", (event, frame: unknown) => {
		slotOf(event.sender)?.runtime?.child.stdin.write(`${JSON.stringify(frame)}\n`);
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

app.on("window-all-closed", () => {
	app.quit();
});
