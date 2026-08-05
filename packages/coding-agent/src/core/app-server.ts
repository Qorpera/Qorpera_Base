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
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { discoverAuthority, readAuthorityConfig } from "./authority.ts";

export interface CompanyAppOptions {
	root: string;
	port?: number;
	/**
	 * Required on every MUTATING endpoint (gate resolution, inbox responses,
	 * authority edits) via the x-qorpera-token header. The backend listens on
	 * localhost, which the agent can reach with curl — without this token the
	 * agent could approve its own gates. The Electron kernel holds the token
	 * and hands it only to the renderer (file://, out of the agent's reach).
	 * If omitted (standalone browser mode), one is generated and embedded in
	 * the served chrome — a weaker posture, acceptable only for that mode.
	 */
	authToken?: string;
}

interface InboxItem {
	file: string;
	status: string;
	title: string;
	kind: "gate" | "message" | "note";
	/** File modification time — newest-first ordering and card meta lines. */
	mtimeMs: number;
	/** Gate items only: the agent's founder-facing outcome description, folded
	 * in from the companion inbox/msg-<gateId>-intent.md (the msg carve-out is
	 * the agent's one sanctioned inbox lane; the gate file itself is
	 * kernel-written and protected). */
	intent?: string;
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

/** Plain text of an intent companion: frontmatter/headings off, first chunk. */
function intentText(content: string): string {
	return content
		.replace(/^---[\s\S]*?---/, "")
		.replace(/^#+ .*$/gm, "")
		.trim()
		.slice(0, 600);
}

function readInbox(root: string): InboxItem[] {
	const dir = join(root, "inbox");
	if (!existsSync(dir)) return [];
	const names = readdirSync(dir);
	// Companion intent files (msg-<gateId>-intent.md) fold INTO their gate's
	// card instead of appearing as items of their own.
	const intents = new Map<string, string>();
	for (const file of names) {
		const gateId = file.match(/^msg-(gate-[a-z0-9-]+)-intent\.md$/i)?.[1];
		if (!gateId) continue;
		try {
			intents.set(gateId.toLowerCase(), intentText(readFileSync(join(dir, file), "utf-8")));
		} catch {
			// unreadable companions are ignored
		}
	}
	const items: InboxItem[] = [];
	for (const file of names) {
		if (!file.endsWith(".md") || file === "README.md") continue;
		if (/^msg-gate-[a-z0-9-]+-intent\.md$/i.test(file)) continue;
		try {
			const content = readFileSync(join(dir, file), "utf-8");
			const mtimeMs = statSync(join(dir, file)).mtimeMs;
			const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file;
			if (file.startsWith("gate-")) {
				const status = content.match(/^status:\s*(\w+)/m)?.[1] ?? "";
				const intent = intents.get(file.replace(/\.md$/i, "").toLowerCase());
				items.push({ file, status, title, kind: "gate", mtimeMs, intent });
			} else if (file.startsWith("msg-")) {
				// Agent-authored item; answered once a Response section exists.
				const status = /^##\s+Response/m.test(content) ? "answered" : "pending";
				items.push({ file, status, title, kind: "message", mtimeMs });
			} else {
				items.push({ file, status: "", title, kind: "note", mtimeMs });
			}
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

interface SessionSummary {
	file: string;
	mtimeMs: number;
	title: string;
	/** "autonomous" = controller-initiated work (tagged at spawn); "chat" = founder-brought. */
	kind: "chat" | "autonomous";
}

/** Trail sessions ARE the chat list (spec §3). Title = first user message;
 * autonomous work is tagged with a session name at spawn time. */
function listTrailSessions(root: string): SessionSummary[] {
	const dir = join(root, "trail");
	if (!existsSync(dir)) return [];
	const sessions: SessionSummary[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		try {
			const path = join(dir, file);
			const head = readFileSync(path, "utf-8").slice(0, 16_384);
			let title = "";
			let name = "";
			for (const line of head.split("\n").slice(0, 40)) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						name?: string;
						message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
					};
					if (entry.type === "session_info" && typeof entry.name === "string" && !name) {
						name = entry.name;
					}
					if (entry.type === "message" && entry.message?.role === "user" && !title) {
						const text = entry.message.content?.find((part) => part.type === "text")?.text ?? "";
						title = text.replace(/\s+/g, " ").slice(0, 70);
					}
					if (name && title) break;
				} catch {
					// partial trailing line in the head window
				}
			}
			const kind = name.toLowerCase().startsWith("autonomous") ? "autonomous" : "chat";
			sessions.push({
				file,
				mtimeMs: statSync(path).mtimeMs,
				title: kind === "autonomous" ? name : title || file.slice(0, 30),
				kind,
			});
		} catch {
			// unreadable session files are skipped
		}
	}
	return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const INBOX_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/;

/** Founder response: appended into the item; the agent reads it on next wake. */
function respondToInboxItem(root: string, file: string, response: string): boolean {
	if (!INBOX_FILE_PATTERN.test(file) || file === "README.md" || !response.trim()) return false;
	const path = join(root, "inbox", file);
	try {
		const content = readFileSync(path, "utf-8");
		writeFileSync(
			path,
			`${content.trimEnd()}\n\n## Response (founder, ${new Date().toISOString().slice(0, 16)}Z)\n\n${response.trim()}\n`,
			"utf-8",
		);
		return true;
	} catch {
		return false;
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
		sessions: listTrailSessions(root),
		trailSessions,
	};
}

const SURFACE_DOC_STYLE = `<style>
	:root { color-scheme: dark; }
	body { max-width: 880px; margin: 0 auto; padding: 28px 32px; background: #101418; color: #e6e9ec;
		font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; line-height: 1.55; }
	h1, h2, h3 { margin: 18px 0 8px; } h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
	p, ul, ol { margin: 0 0 10px; } ul, ol { padding-left: 24px; }
	code { background: #1a2027; border-radius: 4px; padding: 1px 5px; font-family: Consolas, monospace; font-size: 12.5px; }
	pre { background: #161b21; border: 1px solid #232a31; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
	pre code { background: none; padding: 0; }
	table { border-collapse: collapse; margin: 0 0 10px; } td, th { border: 1px solid #2c3540; padding: 5px 10px; font-size: 13px; }
	blockquote { border-left: 3px solid #2c3540; margin: 0 0 10px; padding-left: 12px; color: #aab3bb; }
	a { color: #7ab4ff; }
</style>`;

function escapeHtmlText(source: string): string {
	return source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serve a file strictly from inside app/surfaces (no traversal). Controllers
 * write surfaces in whatever form fits — HTML is served as-is; markdown and
 * plain text are rendered into a dark-styled document so prose surfaces are
 * first-class, not raw bytes.
 */
function serveSurface(root: string, entry: string, response: ServerResponse): void {
	const surfacesRoot = resolve(join(root, "app", "surfaces"));
	const target = resolve(join(surfacesRoot, normalize(entry)));
	if (target !== surfacesRoot && !target.startsWith(surfacesRoot + sep)) {
		response.writeHead(403).end("outside surfaces");
		return;
	}
	try {
		const content = readFileSync(target);
		if (target.endsWith(".md") || target.endsWith(".txt")) {
			const source = content.toString("utf-8");
			const body = target.endsWith(".md")
				? marked.parse(escapeHtmlText(source), { breaks: false, async: false })
				: `<pre>${escapeHtmlText(source)}</pre>`;
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(
					`<!doctype html><html><head><meta charset="utf-8">${SURFACE_DOC_STYLE}</head><body>${body}</body></html>`,
				);
			return;
		}
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

const CHROME_HTML = (name: string, token: string) => `<!doctype html>
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
					b.onclick = async () => { await fetch("/api/gate", { method: "POST", headers: { "content-type": "application/json", "x-qorpera-token": "${token}" }, body: JSON.stringify({ file: g.file, action }) }); refresh().then(() => showPanel("inbox", true)); };
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
	const authToken =
		options.authToken ?? createHash("sha256").update(`${root}${Date.now()}${Math.random()}`).digest("hex");
	const embedTokenInChrome = options.authToken === undefined;
	const authorized = (request: IncomingMessage): boolean => request.headers["x-qorpera-token"] === authToken;
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname === "/") {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(CHROME_HTML(companyName(root), embedTokenInChrome ? authToken : ""));
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
		if (url.pathname.startsWith("/api/inbox/") && request.method === "GET") {
			const file = decodeURIComponent(url.pathname.slice("/api/inbox/".length));
			if (!INBOX_FILE_PATTERN.test(file)) {
				response.writeHead(400).end("bad name");
				return;
			}
			try {
				response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end(readFileSync(join(root, "inbox", file), "utf-8"));
			} catch {
				response.writeHead(404).end("not found");
			}
			return;
		}
		if (url.pathname === "/api/authority/config" && request.method === "GET") {
			// Structured view for the settings UI (toggles, not prose).
			const authority = discoverAuthority(root);
			if (!authority) {
				response.writeHead(404).end("no authority.toml");
				return;
			}
			const config = readAuthorityConfig(authority);
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					classes: {
						money: config.classes.money,
						identity: config.classes.identity,
						irreversible: config.classes.irreversible,
						products: config.classes.products,
					},
					productPaths: config.productPaths,
				}),
			);
			return;
		}
		if (url.pathname === "/api/authority/config" && request.method === "POST") {
			if (!authorized(request)) {
				response.writeHead(401).end("token required");
				return;
			}
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					const update = JSON.parse(body) as {
						classes?: Record<string, { mode?: string; limitUsd?: number }>;
						productPaths?: string[];
					};
					// Surgical merge into the existing file so [tools] and any
					// custom sections survive; comments do not (Advanced tab
					// exists for comment-preserving edits).
					const path = join(root, "authority.toml");
					let existing: Record<string, unknown> = {};
					try {
						existing = parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
					} catch {
						existing = {};
					}
					const modes = new Set(["auto", "notify", "gate"]);
					for (const name of ["money", "identity", "irreversible", "products"]) {
						const incoming = update.classes?.[name];
						if (!incoming) continue;
						const section = { ...((existing[name] as Record<string, unknown>) ?? {}) };
						if (incoming.mode && modes.has(incoming.mode)) section.mode = incoming.mode;
						if (name === "money" && typeof incoming.limitUsd === "number") section.limit_usd = incoming.limitUsd;
						existing[name] = section;
					}
					if (Array.isArray(update.productPaths)) {
						const products = { ...((existing.products as Record<string, unknown>) ?? {}) };
						products.paths = update.productPaths.filter((p): p is string => typeof p === "string" && !!p.trim());
						existing.products = products;
					}
					existing.authority = { ...((existing.authority as Record<string, unknown>) ?? {}), mode: "gate" };
					writeFileSync(path, `${stringifyToml(existing)}\n`, "utf-8");
					response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
				} catch (error) {
					response
						.writeHead(400, { "content-type": "application/json" })
						.end(JSON.stringify({ ok: false, error: String(error).slice(0, 200) }));
				}
			});
			return;
		}
		if (url.pathname === "/api/authority" && request.method === "GET") {
			try {
				response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end(readFileSync(join(root, "authority.toml"), "utf-8"));
			} catch {
				response.writeHead(404).end("no authority.toml");
			}
			return;
		}
		if (url.pathname === "/api/authority" && request.method === "POST") {
			if (!authorized(request)) {
				response.writeHead(401).end("token required");
				return;
			}
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					const { content } = JSON.parse(body) as { content?: string };
					if (typeof content !== "string" || !content.trim()) {
						response.writeHead(400).end("empty");
						return;
					}
					parseToml(content); // reject unparseable TOML with a clear error
					writeFileSync(join(root, "authority.toml"), content, "utf-8");
					response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
				} catch (error) {
					response
						.writeHead(400, { "content-type": "application/json" })
						.end(JSON.stringify({ ok: false, error: String(error).slice(0, 200) }));
				}
			});
			return;
		}
		if (url.pathname === "/api/inbox/respond" && request.method === "POST") {
			if (!authorized(request)) {
				response.writeHead(401).end("token required");
				return;
			}
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				try {
					const { file, response: reply } = JSON.parse(body) as { file?: string; response?: string };
					const ok = respondToInboxItem(root, file ?? "", reply ?? "");
					response.writeHead(ok ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify({ ok }));
				} catch {
					response.writeHead(400).end("{}");
				}
			});
			return;
		}
		if (url.pathname === "/api/gate" && request.method === "POST") {
			if (!authorized(request)) {
				response.writeHead(401).end("token required");
				return;
			}
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
		// The Controller IS the Base shell opened into this company: one
		// foundation binary for every company, so Base updates reach all
		// controllers at once. Prefer the installed app; fall back to the
		// dev tree this CLI is running from.
		const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
		writeFileSync(
			path,
			[
				"@echo off",
				`set "EXE=%LocalAppData%\\Programs\\Qorpera Base\\Qorpera Base.exe"`,
				`if not exist "%EXE%" set "EXE=%LocalAppData%\\Programs\\qorpera-base\\Qorpera Base.exe"`,
				`if exist "%EXE%" (`,
				`\tstart "" "%EXE%" --company "${root}"`,
				"\texit /b",
				")",
				`cd /d "${repoRoot}"`,
				`start "" node_modules\\electron\\dist\\electron.exe packages\\shell\\dist\\main.js --company "${root}"`,
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

/** Desktop launcher for the Base hub itself (the shell with no --company). */
function installHubLauncher(): string | undefined {
	const desktop = join(homedir(), "Desktop");
	if (!existsSync(desktop) || process.platform !== "win32") return undefined;
	const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
	const path = join(desktop, "Qorpera Base.cmd");
	writeFileSync(
		path,
		[
			"@echo off",
			`set "EXE=%LocalAppData%\\Programs\\Qorpera Base\\Qorpera Base.exe"`,
			`if not exist "%EXE%" set "EXE=%LocalAppData%\\Programs\\qorpera-base\\Qorpera Base.exe"`,
			`if exist "%EXE%" (`,
			`\tstart "" "%EXE%"`,
			"\texit /b",
			")",
			`cd /d "${repoRoot}"`,
			`start "" node_modules\\electron\\dist\\electron.exe packages\\shell\\dist\\main.js`,
			"",
		].join("\r\n"),
		"utf-8",
	);
	return path;
}

/** `qorpera app [dir]` / `qorpera app install [dir]` / `qorpera app install-hub`. */
export async function handleAppCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "app") return false;
	if (args[1] === "install-hub") {
		const launcher = installHubLauncher();
		console.log(launcher ? `Installed launcher: ${launcher}` : "Could not install (no Desktop or unsupported OS).");
		return true;
	}
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
