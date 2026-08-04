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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import { conceptionKickoff, listCompanies, registerCompany, scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { app, BrowserWindow, shell as electronShell, ipcMain } from "electron";
import electronUpdater from "electron-updater";

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
}

let window: BrowserWindow | undefined;
let runtime: CompanyRuntime | undefined;

function send(channel: string, payload: unknown): void {
	window?.webContents.send(channel, payload);
}

async function closeCompany(): Promise<void> {
	if (!runtime) return;
	runtime.child.kill();
	runtime.backendClose?.();
	runtime = undefined;
}

/** Spawn the intelligence: the CLI's RPC mode under Electron's own Node.
 * With sessionFile, resumes that trail session; without, starts fresh. */
function startChild(root: string, sessionFile?: string): ChildProcessWithoutNullStreams {
	const args = [RPC_ENTRY, "--mode", "rpc"];
	if (sessionFile) args.push("--session", join(root, "trail", sessionFile));
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
	child.on("exit", (code) => send("rpc-exit", code));
	return child;
}

async function openCompany(root: string): Promise<{ root: string; backendUrl: string; kickoff: boolean }> {
	await closeCompany();
	registerCompany(root);

	// Backend for surfaces/state/inbox — reused machinery, in-process.
	const port = companyPort(root);
	const server = createCompanyAppServer({ root, port });
	const backendClose = await new Promise<(() => void) | undefined>((resolvePromise) => {
		server.once("error", () => resolvePromise(undefined)); // already running: reuse it
		server.listen(port, "127.0.0.1", () => resolvePromise(() => server.close()));
	});

	const child = startChild(root);
	runtime = { root, child, backendPort: port, backendClose };

	// Never-conceived company: kick off the (autonomous) conception session.
	const kickoff = conceptionKickoff(root);
	if (kickoff) {
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: kickoff })}\n`);
	}
	return { root, backendUrl: `http://127.0.0.1:${port}`, kickoff: Boolean(kickoff) };
}

/** Switch the chat to a trail session (or a fresh one) without touching the backend. */
function openChat(sessionFile: string | null): void {
	if (!runtime) return;
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
	void window.loadFile(join(DIRNAME, "renderer", "index.html"));
	window.webContents.setWindowOpenHandler(({ url }) => {
		void electronShell.openExternal(url);
		return { action: "deny" };
	});
}

app.whenReady().then(() => {
	ipcMain.handle("companies:list", () => listCompanies());
	ipcMain.handle("company:open", (_event, root: string) => openCompany(root));
	ipcMain.handle("company:new", (_event, dir: string) => {
		const result = scaffoldCompany(dir);
		registerCompany(result.root);
		return result.root;
	});
	ipcMain.handle("company:close", () => closeCompany());
	ipcMain.handle("chat:open", (_event, sessionFile: string | null) => openChat(sessionFile));
	ipcMain.handle("app:info", () => ({ version: shellVersion(), pendingCompany: pendingCompanyFromArgv() }));
	ipcMain.handle("rpc:send", (_event, frame: unknown) => {
		runtime?.child.stdin.write(`${JSON.stringify(frame)}\n`);
	});

	createWindow();

	// Foundation self-update: packaged builds check Qorpera_Base_Releases
	// (public) via electron-updater; downloads apply on quit. The foundation
	// is deliberately static, so this stays quiet almost always.
	if (app.isPackaged) {
		const { autoUpdater } = electronUpdater;
		autoUpdater.on("update-downloaded", (info) => send("update-ready", info.version));
		autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
			console.error(`update check failed: ${error.message}`);
		});
	}

	// Headless smoke: prove the shell boots, then leave.
	if (process.argv.includes("--smoke")) {
		window?.webContents.once("did-finish-load", () => {
			console.log("SHELL_READY");
			setTimeout(() => app.quit(), 1500);
		});
	}
});

app.on("window-all-closed", () => {
	void closeCompany();
	app.quit();
});
