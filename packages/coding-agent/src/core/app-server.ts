/**
 * The per-company desktop app — "[Company Name] Controller" (spec §7, v1).
 *
 * Qorpera Base is the foundation every company's app is built on. Connecting
 * it to a company folder yields that company's own desktop app: a chromeless
 * app-mode window (Edge/Chrome `--app`, WebView2-class rendering — no
 * Tauri/Electron toolchain, no dependencies beyond node:http) over a local
 * backend that renders whatever the controller has built in `app/` — nav
 * from `app/manifest.json`, surfaces served live, the inbox as an
 * approve/deny queue. Self-updating by construction: everything is read from
 * the folder on request and the window polls for changes, so a surface the
 * controller writes mid-session appears with no deploy step.
 *
 * Minimally viable on purpose. A packaged single-binary shell can replace
 * the window later without changing anything a controller builds.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";

export interface CompanyAppOptions {
	root: string;
	port?: number;
}

interface InboxItem {
	file: string;
	status: string;
	title: string;
}

function companyName(root: string): string {
	try {
		const md = readFileSync(join(root, "company.md"), "utf-8");
		const heading = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
		if (heading && !/^Company$/i.test(heading)) return heading.replace(/\s*[—-]\s*Company$/i, "");
	} catch {
		// fall through to basename
	}
	return basename(root);
}

/** Stable per-company port so the installed launcher always finds its app. */
export function companyPort(root: string): number {
	const digest = createHash("sha256").update(resolve(root).toLowerCase()).digest();
	return 4600 + (digest.readUInt16BE(0) % 400);
}

function readManifestSurfaces(root: string): Array<{ name: string; entry: string }> {
	try {
		const manifest = JSON.parse(readFileSync(join(root, "app", "manifest.json"), "utf-8")) as {
			surfaces?: Array<{ name?: string; title?: string; id?: string; entry?: string; path?: string }>;
		};
		// Liberal reader: the controller owns its conventions inside app/, so
		// accept the field spellings agents actually produce (observed live:
		// {id,title,path} with a surfaces/ prefix) alongside {name,entry}.
		return (manifest.surfaces ?? [])
			.map((surface) => {
				const rawEntry = surface.entry ?? surface.path;
				if (typeof rawEntry !== "string") return undefined;
				const entry = rawEntry.replace(/^\.?\/?(app\/)?surfaces\//, "");
				const name = surface.name ?? surface.title ?? surface.id ?? entry;
				return { name, entry };
			})
			.filter((surface): surface is { name: string; entry: string } => surface !== undefined);
	} catch {
		return [];
	}
}

function readInbox(root: string): InboxItem[] {
	const dir = join(root, "inbox");
	if (!existsSync(dir)) return [];
	const items: InboxItem[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md") || file === "README.md") continue;
		try {
			const content = readFileSync(join(dir, file), "utf-8");
			const status = content.match(/^status:\s*(\w+)/m)?.[1] ?? "";
			const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file;
			items.push({ file, status, title });
		} catch {
			// unreadable inbox entries are skipped
		}
	}
	return items;
}

function surfaceVersion(root: string, entry: string): number {
	try {
		return statSync(join(root, "app", "surfaces", entry)).mtimeMs;
	} catch {
		return 0;
	}
}

function stateFor(root: string): unknown {
	const surfaces = readManifestSurfaces(root).map((surface) => ({
		...surface,
		version: surfaceVersion(root, surface.entry),
	}));
	let trailSessions = 0;
	try {
		trailSessions = readdirSync(join(root, "trail")).filter((name) => name.endsWith(".jsonl")).length;
	} catch {
		// no trail yet
	}
	return {
		name: companyName(root),
		surfaces,
		inbox: readInbox(root),
		trailSessions,
	};
}

/** Serve a file strictly from inside app/surfaces (no traversal). */
function serveSurface(root: string, entry: string, response: ServerResponse): void {
	const surfacesRoot = resolve(join(root, "app", "surfaces"));
	const target = resolve(join(surfacesRoot, normalize(entry)));
	if (target !== surfacesRoot && !target.startsWith(surfacesRoot + sep)) {
		response.writeHead(403).end("outside surfaces");
		return;
	}
	try {
		const content = readFileSync(target);
		const type = target.endsWith(".html")
			? "text/html; charset=utf-8"
			: target.endsWith(".js")
				? "text/javascript"
				: target.endsWith(".css")
					? "text/css"
					: target.endsWith(".json")
						? "application/json"
						: "text/plain; charset=utf-8";
		response.writeHead(200, { "content-type": type }).end(content);
	} catch {
		response.writeHead(404).end("surface not found");
	}
}

/** The human resolves gates here — this is the approve/deny queue as UI. */
function resolveGate(root: string, file: string, action: string): boolean {
	if (!/^gate-[a-z0-9-]+\.md$/i.test(file)) return false;
	if (action !== "approved" && action !== "denied") return false;
	const path = join(root, "inbox", file);
	try {
		const content = readFileSync(path, "utf-8");
		if (!/^status:/m.test(content)) return false;
		writeFileSync(path, content.replace(/^status:.*$/m, `status: ${action}`), "utf-8");
		return true;
	} catch {
		return false;
	}
}

const CHROME_HTML = (name: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${name} Controller</title>
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; margin: 0; }
	body { display: flex; height: 100vh; font-family: 'Segoe UI', system-ui, sans-serif; background: #101418; color: #e6e9ec; }
	nav { width: 260px; min-width: 260px; border-right: 1px solid #232a31; padding: 16px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
	nav h1 { font-size: 15px; margin-bottom: 12px; letter-spacing: .02em; }
	nav h1 small { display: block; color: #7a8590; font-weight: 400; font-size: 11px; margin-top: 2px; }
	nav h2 { font-size: 11px; text-transform: uppercase; color: #7a8590; margin: 14px 0 4px; }
	nav button { text-align: left; background: none; border: 0; color: #cdd4da; padding: 7px 9px; border-radius: 6px; cursor: pointer; font-size: 13px; width: 100%; }
	nav button:hover { background: #1a2027; }
	nav button.active { background: #24303b; color: #fff; }
	main { flex: 1; display: flex; flex-direction: column; }
	main iframe { flex: 1; border: 0; width: 100%; background: #fff; }
	#panel { flex: 1; padding: 24px; overflow-y: auto; display: none; }
	.gate { border: 1px solid #232a31; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
	.gate .t { font-weight: 600; margin-bottom: 4px; }
	.gate .s { font-size: 12px; color: #7a8590; margin-bottom: 10px; }
	.gate button { margin-right: 8px; padding: 6px 14px; border-radius: 6px; border: 1px solid #2c3540; background: #1a2027; color: #e6e9ec; cursor: pointer; }
	.gate button.ok { border-color: #2f6b3a; }
	.gate button.no { border-color: #6b2f2f; }
	.empty { color: #7a8590; padding: 40px; text-align: center; }
	.badge { background: #6b2f2f; border-radius: 10px; font-size: 11px; padding: 1px 7px; margin-left: 6px; }
</style>
</head>
<body>
<nav>
	<h1 id="title">${name}<small>Controller — Qorpera Base</small></h1>
	<h2>Surfaces</h2>
	<div id="surfaces"><div class="empty" style="padding:8px">none built yet</div></div>
	<h2>Company</h2>
	<button id="inboxBtn" onclick="showPanel('inbox')">Inbox<span id="inboxBadge"></span></button>
	<button onclick="showPanel('trail')">Trail</button>
</nav>
<main>
	<iframe id="frame" hidden></iframe>
	<div id="panel"></div>
</main>
<script>
let state = { surfaces: [], inbox: [], trailSessions: 0 };
let current = null; // {kind:"surface", entry} | {kind:"panel", which}
async function refresh() {
	try {
		const next = await (await fetch("/api/state")).json();
		const changed = JSON.stringify(next) !== JSON.stringify(state);
		state = next;
		if (changed) render();
	} catch {}
}
function render() {
	const nav = document.getElementById("surfaces");
	nav.innerHTML = "";
	if (!state.surfaces.length) nav.innerHTML = '<div class="empty" style="padding:8px">none built yet</div>';
	for (const s of state.surfaces) {
		const b = document.createElement("button");
		b.textContent = s.name;
		if (current && current.kind === "surface" && current.entry === s.entry) b.className = "active";
		b.onclick = () => showSurface(s);
		nav.appendChild(b);
	}
	const pending = state.inbox.filter((g) => g.status === "pending").length;
	document.getElementById("inboxBadge").innerHTML = pending ? '<span class="badge">' + pending + "</span>" : "";
	if (!current && state.surfaces.length) showSurface(state.surfaces[0]);
	if (current && current.kind === "surface") {
		const s = state.surfaces.find((x) => x.entry === current.entry);
		if (s) { const src = "/surface/" + encodeURIComponent(s.entry) + "?v=" + s.version;
			const f = document.getElementById("frame"); if (f.getAttribute("src") !== src) f.src = src; }
	}
	if (current && current.kind === "panel") showPanel(current.which, true);
}
function showSurface(s) {
	current = { kind: "surface", entry: s.entry };
	document.getElementById("panel").style.display = "none";
	const f = document.getElementById("frame");
	f.hidden = false; f.src = "/surface/" + encodeURIComponent(s.entry) + "?v=" + s.version;
	render();
}
function showPanel(which, keep) {
	current = { kind: "panel", which };
	document.getElementById("frame").hidden = true;
	const p = document.getElementById("panel");
	p.style.display = "block";
	if (which === "inbox") {
		p.innerHTML = state.inbox.length ? "" : '<div class="empty">Inbox is empty</div>';
		for (const g of state.inbox) {
			const d = document.createElement("div");
			d.className = "gate";
			d.innerHTML = '<div class="t"></div><div class="s"></div>';
			d.querySelector(".t").textContent = g.title;
			d.querySelector(".s").textContent = g.file + " — status: " + g.status;
			if (g.status === "pending") {
				for (const [label, action, cls] of [["Approve", "approved", "ok"], ["Deny", "denied", "no"]]) {
					const b = document.createElement("button");
					b.textContent = label; b.className = cls;
					b.onclick = async () => { await fetch("/api/gate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: g.file, action }) }); refresh().then(() => showPanel("inbox", true)); };
					d.appendChild(b);
				}
			}
			p.appendChild(d);
		}
	} else if (which === "trail") {
		p.innerHTML = '<div class="empty">' + state.trailSessions + " session(s) recorded in trail/. Open the folder to audit; the in-app trail viewer is coming.</div>";
	}
	if (!keep) render();
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

export function createCompanyAppServer(options: CompanyAppOptions): Server {
	const root = resolve(options.root);
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(CHROME_HTML(companyName(root)));
			return;
		}
		if (url.pathname === "/api/state") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stateFor(root)));
			return;
		}
		if (url.pathname.startsWith("/surface/")) {
			serveSurface(root, decodeURIComponent(url.pathname.slice("/surface/".length)), response);
			return;
		}
		if (url.pathname === "/api/gate" && request.method === "POST") {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					const { file, action } = JSON.parse(body) as { file?: string; action?: string };
					const ok = resolveGate(root, file ?? "", action ?? "");
					response.writeHead(ok ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify({ ok }));
				} catch {
					response.writeHead(400).end("{}");
				}
			});
			return;
		}
		response.writeHead(404).end("not found");
	});
}

/**
 * Open the app WINDOW — chromeless app mode, its own taskbar entry — falling
 * back to the default browser only when no app-capable browser is found.
 */
function openAppWindow(url: string): void {
	if (process.platform === "win32") {
		// Probe real install paths — App Paths lookup via `start msedge` is
		// not reliable (Edge may be absent entirely, e.g. EU unbundling).
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData = process.env.LOCALAPPDATA ?? "";
		const candidates = [
			join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
			join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
			join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
		];
		const browser = candidates.find((candidate) => existsSync(candidate));
		if (browser) {
			spawn(browser, [`--app=${url}`], { stdio: "ignore", detached: true }).unref();
		} else {
			// Default browser tab — still works, just less app-like.
			spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
		}
		return;
	}
	if (process.platform === "darwin") {
		spawn("open", [url], { stdio: "ignore", detached: true }).unref();
		return;
	}
	spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

/** Write a desktop launcher: "<Company> Controller". */
function installLauncher(root: string): string | undefined {
	const name = companyName(root);
	const desktop = join(homedir(), "Desktop");
	if (!existsSync(desktop)) return undefined;
	if (process.platform === "win32") {
		const path = join(desktop, `${name} Controller.cmd`);
		// Backend console starts minimized; the app window is the app.
		// NOTE: the if-block needs parentheses — `if ... start & exit /b`
		// would run `exit /b` unconditionally (cmd grammar), killing the
		// relaunched instance before it starts.
		writeFileSync(
			path,
			[
				"@echo off",
				`if not "%1"=="min" (`,
				`\tstart /min "" "%~f0" min`,
				"\texit /b",
				")",
				`title ${name} Controller`,
				`qorpera app "${root}"`,
				"",
			].join("\r\n"),
			"utf-8",
		);
		return path;
	}
	const path = join(desktop, `${name.replace(/\s+/g, "-")}-controller.sh`);
	writeFileSync(path, `#!/bin/sh\ncd "${root}"\nexec qorpera app "${root}"\n`, { encoding: "utf-8", mode: 0o755 });
	return path;
}

/** `qorpera app [dir]` / `qorpera app install [dir]`. */
export async function handleAppCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "app") return false;
	const install = args[1] === "install";
	const positional = args.slice(install ? 2 : 1).filter((arg) => !arg.startsWith("--"));
	const root = resolve(positional[0] ?? process.cwd());
	if (!existsSync(join(root, "authority.toml"))) {
		console.error(`${root} is not a company folder (no authority.toml).`);
		process.exitCode = 1;
		return true;
	}
	const port = companyPort(root);
	if (install) {
		const launcher = installLauncher(root);
		console.log(launcher ? `Installed launcher: ${launcher}` : "Could not find a Desktop folder to install to.");
		return true;
	}
	const url = `http://127.0.0.1:${port}/`;
	const server = createCompanyAppServer({ root, port });
	const started = await new Promise<boolean>((resolvePromise) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") {
				// The company's backend is already running — just open the window.
				console.log(`${companyName(root)} Controller already running at ${url}; opening its window.`);
				resolvePromise(false);
			} else {
				console.error(`Could not start on port ${port}: ${error.message}`);
				process.exitCode = 1;
				resolvePromise(false);
			}
		});
		server.listen(port, "127.0.0.1", () => resolvePromise(true));
	});
	if (!started) {
		if (process.exitCode !== 1) openAppWindow(url);
		return true;
	}
	console.log(`${companyName(root)} Controller running at ${url}  (Ctrl+C to stop)`);
	openAppWindow(url);
	await new Promise(() => {}); // serve until killed
	return true;
}
