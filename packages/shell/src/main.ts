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
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
// Deep imports from the coding agent (the foundation's own machinery).
import { companyPort, createCompanyAppServer } from "@qorpera/pi-coding-agent/app-server";
import { conceptionKickoff, listCompanies, registerCompany, scaffoldCompany } from "@qorpera/pi-coding-agent/company";
import { app, BrowserWindow, shell as electronShell, ipcMain } from "electron";

const RPC_ENTRY = fileURLToPath(import.meta.resolve("@qorpera/pi-coding-agent/rpc-entry"));
const DIRNAME = fileURLToPath(new URL(".", import.meta.url));

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

	// The intelligence: the CLI's RPC mode as a child of Electron's own Node.
	const child = spawn(process.execPath, [RPC_ENTRY, "--mode", "rpc"], {
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

	runtime = { root, child, backendPort: port, backendClose };

	// Never-conceived company: open with the conception interview.
	const kickoff = conceptionKickoff(root);
	if (kickoff) {
		child.stdin.write(`${JSON.stringify({ type: "prompt", message: kickoff })}\n`);
	}
	return { root, backendUrl: `http://127.0.0.1:${port}`, kickoff: Boolean(kickoff) };
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
	ipcMain.handle("rpc:send", (_event, frame: unknown) => {
		runtime?.child.stdin.write(`${JSON.stringify(frame)}\n`);
	});

	createWindow();

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
