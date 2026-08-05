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
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import {
	conceptionKickoff,
	integrateRepo,
	listCompanies,
	registerCompany,
	scaffoldCompany,
} from "@qorpera/pi-coding-agent/company";
import { app, BrowserWindow, shell as electronShell, ipcMain, type WebContents } from "electron";
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
/** Children we killed on purpose (session switch/close) — their exits are not news. */
const intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>();

const slots = new Map<number, Slot>();

/** `--company <root>` delivered to the first window's renderer exactly once —
 * later hub windows must not re-open the launcher's company. */
let pendingCompany: string | undefined = (() => {
	const index = process.argv.indexOf("--company");
	return index >= 0 ? process.argv[index + 1] : undefined;
})();

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
	slot.runtime.backendClose?.();
	slot.runtime = undefined;
}

/** Spawn the intelligence: the CLI's RPC mode under Electron's own Node.
 * With sessionFile, resumes that trail session; without, starts fresh.
 * Autonomous work is tagged with a session name so the trail (and the
 * Activity view) can tell controller-initiated sessions from chats. */
function startChild(
	slot: Slot,
	root: string,
	sessionFile?: string,
	autonomousName?: string,
): ChildProcessWithoutNullStreams {
	const win = slot.window;
	const args = [RPC_ENTRY, "--mode", "rpc"];
	if (sessionFile) args.push("--session", join(root, "trail", sessionFile));
	if (autonomousName) args.push("--name", `autonomous — ${autonomousName}`);
	const child = spawn(process.execPath, args, {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
		activeApp: getActiveApp(userlandDir),
		versions: listVersions(userlandDir),
		evolved: !isUnmodified(userlandDir),
	};
}

async function openCompany(slot: Slot, root: string): Promise<void> {
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
	const child = startChild(slot, root, undefined, kickoff ? "conception" : undefined);
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
	void slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
}

/** Switch the chat to a trail session (or a fresh one) without touching the backend. */
function openChat(slot: Slot, sessionFile: string | null): void {
	if (!slot.runtime) return;
	intentionalKills.add(slot.runtime.child);
	slot.runtime.child.kill();
	slot.runtime.child = startChild(slot, slot.runtime.root, sessionFile ?? undefined);
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
	const index = argv.indexOf("--company");
	const root = index >= 0 ? argv[index + 1] : undefined;
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
	ipcMain.handle("chat:open", (event, sessionFile: string | null) => {
		const slot = slotOf(event.sender);
		if (slot) openChat(slot, sessionFile);
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
		const ok = restoreVersion(join(runtime.root, "userland"), id);
		if (ok && getActiveApp(join(runtime.root, "userland")) === "fork") {
			runtime.usingBaseFallback = false;
			await slot.window.loadFile(join(runtime.root, "userland", "index.html")).catch(async () => {
				runtime.usingBaseFallback = true;
				await slot.window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
			});
		}
		return ok;
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
