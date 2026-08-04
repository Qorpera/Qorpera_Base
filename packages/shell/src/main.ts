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
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { app, BrowserWindow, shell as electronShell, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import { ensureUserland, mergeTaskPrompt, type UserlandStatus } from "./userland-manager.ts";

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

/** `--company <root>`: per-company launchers open straight into their company. */
function pendingCompanyFromArgv(): string | undefined {
	const index = process.argv.indexOf("--company");
	return index >= 0 ? process.argv[index + 1] : undefined;
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

const BASE_USERLAND_DIR = join(DIRNAME, "userland");
/** Children we killed on purpose (session switch/close) — their exits are not news. */
const intentionalKills = new WeakSet<ChildProcessWithoutNullStreams>();

let window: BrowserWindow | undefined;
let runtime: CompanyRuntime | undefined;

function send(channel: string, payload: unknown): void {
	window?.webContents.send(channel, payload);
}

async function closeCompany(): Promise<void> {
	if (!runtime) return;
	intentionalKills.add(runtime.child);
	runtime.child.kill();
	runtime.backendClose?.();
	runtime = undefined;
}

/** Spawn the intelligence: the CLI's RPC mode under Electron's own Node.
 * With sessionFile, resumes that trail session; without, starts fresh.
 * Autonomous work is tagged with a session name so the trail (and the
 * Activity view) can tell controller-initiated sessions from chats. */
function startChild(root: string, sessionFile?: string, autonomousName?: string): ChildProcessWithoutNullStreams {
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
			send("rpc-event", JSON.parse(line));
		} catch {
			send("rpc-log", line);
		}
	});
	createInterface({ input: child.stderr }).on("line", (line) => send("rpc-log", line));
	child.on("exit", (code) => {
		if (!intentionalKills.has(child)) send("rpc-exit", code);
	});
	return child;
}

interface ActiveCompany {
	root: string;
	backendUrl: string;
	backendToken: string;
	kickoff: boolean;
	userland: UserlandStatus;
	usingBaseFallback: boolean;
	mergePrompt?: string;
}

function activeCompanyInfo(): ActiveCompany | undefined {
	if (!runtime) return undefined;
	const staged = runtime.userland.action === "staged" || runtime.userland.action === "already-staged";
	return {
		root: runtime.root,
		backendUrl: `http://127.0.0.1:${runtime.backendPort}`,
		backendToken: runtime.backendToken,
		kickoff: false,
		userland: runtime.userland,
		usingBaseFallback: runtime.usingBaseFallback,
		mergePrompt: staged ? mergeTaskPrompt(runtime.userland) : undefined,
	};
}

async function openCompany(root: string): Promise<void> {
	await closeCompany();
	registerCompany(root);

	// The fork model (spec §9a): the company runs ITS OWN userland — forked
	// from base on first open, fast-forwarded when untouched, staged for a
	// controller merge when evolved. The kernel only loads it.
	const userland = ensureUserland(root, BASE_USERLAND_DIR, shellVersion());

	// Backend for surfaces/state/inbox — reused machinery, in-process. The
	// token guards mutating endpoints; only the renderer ever receives it.
	const port = companyPort(root);
	const backendToken = randomUUID();
	const server = createCompanyAppServer({ root, port, authToken: backendToken });
	const backendClose = await new Promise<(() => void) | undefined>((resolvePromise) => {
		server.once("error", () => resolvePromise(undefined)); // already running: reuse it
		server.listen(port, "127.0.0.1", () => resolvePromise(() => server.close()));
	});

	// Never-conceived company: the conception session is autonomous work.
	const kickoff = conceptionKickoff(root);
	const child = startChild(root, undefined, kickoff ? "conception" : undefined);
	runtime = { root, child, backendPort: port, backendClose, userland, usingBaseFallback: false, backendToken };
	if (kickoff) {
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: kickoff })}\n`);
	}
	kickoffPending = Boolean(kickoff);

	// Load the company's own app. If its evolved userland fails to boot, the
	// kernel falls back to the base chrome — the company stays reachable.
	await window?.loadFile(join(root, "userland", "index.html")).catch(async () => {
		if (runtime) runtime.usingBaseFallback = true;
		await window?.loadFile(join(BASE_USERLAND_DIR, "index.html"));
	});
}

let kickoffPending = false;

function showHub(): void {
	void closeCompany();
	void window?.loadFile(join(BASE_USERLAND_DIR, "index.html"));
}

/** Switch the chat to a trail session (or a fresh one) without touching the backend. */
function openChat(sessionFile: string | null): void {
	if (!runtime) return;
	intentionalKills.add(runtime.child);
	runtime.child.kill();
	runtime.child = startChild(runtime.root, sessionFile ?? undefined);
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1360,
		height: 860,
		title: "Qorpera Base",
		backgroundColor: "#101418",
		webPreferences: {
			preload: join(DIRNAME, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	window.setMenuBarVisibility(false);
	void window.loadFile(join(BASE_USERLAND_DIR, "index.html"));
	window.webContents.setWindowOpenHandler(({ url }) => {
		void electronShell.openExternal(url);
		return { action: "deny" };
	});
	// A crashed evolved userland must not strand the company: fall back to
	// the base chrome (kernel duty — last-good behavior).
	window.webContents.on("render-process-gone", () => {
		if (runtime && !runtime.usingBaseFallback) {
			runtime.usingBaseFallback = true;
			void window?.loadFile(join(BASE_USERLAND_DIR, "index.html"));
		}
	});
}

// Single instance: relaunching (e.g. a company launcher) focuses the
// existing window and routes its --company there instead of stacking
// windows running different builds. Smoke runs are headless test boots and
// must not join or disturb a live instance.
const IS_SMOKE = process.argv.some((arg) => arg.startsWith("--smoke"));
if (!IS_SMOKE && !app.requestSingleInstanceLock()) {
	app.quit();
}
app.on("second-instance", (_event, argv) => {
	if (!window) return;
	if (window.isMinimized()) window.restore();
	window.focus();
	const index = argv.indexOf("--company");
	if (index >= 0 && argv[index + 1]) {
		send("open-company", argv[index + 1]);
	} else {
		// Launching "Qorpera Base" itself means: take me to the hub — even if
		// a controller is currently open in the window.
		showHub();
	}
});

app.whenReady().then(() => {
	ipcMain.handle("companies:list", () => listCompanies());
	ipcMain.handle("company:open", (_event, root: string) => openCompany(root));
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
	ipcMain.handle("company:close", () => closeCompany());
	ipcMain.handle("chat:open", (_event, sessionFile: string | null) => openChat(sessionFile));
	ipcMain.handle("hub:show", () => showHub());
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
	ipcMain.handle("app:info", () => {
		const active = activeCompanyInfo();
		if (active) active.kickoff = kickoffPending;
		kickoffPending = false;
		return { version: shellVersion(), pendingCompany: pendingCompanyFromArgv(), activeCompany: active };
	});
	ipcMain.handle("rpc:send", (_event, frame: unknown) => {
		runtime?.child.stdin.write(`${JSON.stringify(frame)}\n`);
	});

	createWindow();

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		autoUpdater.on("checking-for-update", () => send("update-status", "checking…"));
		autoUpdater.on("update-available", (info) => send("update-status", `downloading ${info.version}…`));
		autoUpdater.on("update-not-available", () => send("update-status", "up to date"));
		autoUpdater.on("error", (error) => send("update-status", `update error: ${error.message.slice(0, 80)}`));
		autoUpdater.on("update-downloaded", (info) => send("update-ready", info.version));
		autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
			console.error(`update check failed: ${error.message}`);
		});
		ipcMain.handle("update:check", () => autoUpdater.checkForUpdatesAndNotify().catch(() => undefined));
		ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());
	} else {
		ipcMain.handle("update:check", () => {
			send("update-status", "dev tree — rebuild the repo to update");
		});
		ipcMain.handle("update:install", () => {});
	}

	// Headless smoke: prove the shell boots, then leave.
	if (process.argv.includes("--smoke")) {
		window?.webContents.once("did-finish-load", () => {
			console.log("SHELL_READY");
			setTimeout(() => app.quit(), 1500);
		});
	}
	// Fork-model smoke: open a company, prove its userland loads.
	const smokeCompanyIndex = process.argv.indexOf("--smoke-company");
	if (smokeCompanyIndex >= 0 && process.argv[smokeCompanyIndex + 1]) {
		void openCompany(process.argv[smokeCompanyIndex + 1]).then(() => {
			setTimeout(() => {
				console.log(`USERLAND_LOADED ${window?.webContents.getURL()} action=${runtime?.userland.action}`);
				app.quit();
			}, 1500);
		});
	}
});

app.on("window-all-closed", () => {
	void closeCompany();
	app.quit();
});
