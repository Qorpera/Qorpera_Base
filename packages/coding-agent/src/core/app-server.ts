/**
 * The per-company desktop app — "[Company Name] Controller" (spec §7, v1).
 *
 * Qorpera Base is the foundation every company's app is built on. Connecting
 * it to a company folder yields that company's own desktop app: an Electron
 * window over a kernel-owned local backend that renders whatever the
 * controller has built in `app/` — nav
 * from `app/projection.json`, surfaces served live, the inbox as an
 * approve/deny queue. Self-updating by construction: everything is read from
 * the folder on request and the window polls for changes, so a surface the
 * controller writes mid-session appears with no deploy step.
 *
 * The server is not a standalone launcher. Only the desktop kernel may
 * create it and retain its mutation credential.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { marked } from "marked";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { discoverAuthority, readAuthorityConfig } from "./authority.ts";
import { canonicalCompanyRoot, listProductDepartments } from "./company.ts";
import { readFounderIdentity, signAuthorityPolicy, signGateApproval } from "./founder-identity.ts";
import {
	PLATFORM_PROJECTION_NODES,
	PROJECTION_SCHEMA,
	type ProjectionNode,
	type ProjectionState,
	parseProjectionDocument,
} from "./projection.ts";
import { readUsageRateCatalog, type UsageRateCatalog } from "./usage-pricing.ts";
import { companyUsageWindowError, readCompanyUsage } from "./usage-summary.ts";

export interface CompanyAppOptions {
	root: string;
	port?: number;
	/** Kernel-owned static roots. Company UI is served through the same local
	 * origin as its read models so an agent-authored renderer never receives
	 * ambient file:// or outbound-network authority. */
	userland?: { baseDir: string };
	/**
	 * Required on every MUTATING endpoint (gate resolution, inbox responses,
	 * authority edits) via the x-qorpera-token header. The backend listens on
	 * localhost, which the agent can reach with curl — without this token the
	 * agent could approve its own gates. The Electron kernel holds the token;
	 * agent-authored same-origin surfaces never receive it.
	 */
	authToken: string;
	/** Optional pricing source override for deterministic embedding and tests. */
	usageRateCatalog?: () => Promise<UsageRateCatalog>;
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
	 * kernel-written and protected). The companion's # heading becomes the
	 * card TITLE, so the founder reads an outcome, not "Gate request: bash". */
	intent?: string;
	/** Gate items only: the gated tool and effect class, for the meta line. */
	gateTool?: string;
	gateClass?: string;
}

function companyName(root: string): string {
	try {
		const file = readCompanyFile(root, "company.md");
		if (!file) throw new Error("company identity is not a physical file");
		const md = file.content.toString("utf-8");
		const heading = md.match(/^#\s+(.+)$/m)?.[1]?.trim();
		if (heading && !/^Company$/i.test(heading)) return heading.replace(/\s*[—-]\s*Company$/i, "");
	} catch {
		// fall through to basename
	}
	return basename(root);
}

/** Stable per-company port so the installed launcher always finds its app. */
export function companyPort(root: string): number {
	const digest = createHash("sha256").update(canonicalCompanyRoot(root).toLowerCase()).digest();
	return 4600 + (digest.readUInt16BE(0) % 400);
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface PhysicalFile {
	path: string;
	content: Buffer;
	mtimeMs: number;
}

const MAX_APP_FILE_BYTES = 64 * 1024 * 1024;

function samePhysicalFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
	);
}

/** Open, validate, and read one file through the same handle. A path is never
 * reopened after validation, so a concurrent junction or symlink swap fails
 * identity checks instead of redirecting a privileged read. */
function readPhysicalFileWithin(
	directory: string,
	entry: string,
	maxBytes = MAX_APP_FILE_BYTES,
): PhysicalFile | undefined {
	let descriptor: number | undefined;
	try {
		const requestedRoot = resolve(directory);
		const rootBefore = realpathSync(requestedRoot);
		if (!lstatSync(rootBefore).isDirectory()) return undefined;
		const target = resolve(rootBefore, normalize(entry));
		const rel = relative(rootBefore, target);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;

		descriptor = openSync(target, "r");
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.nlink !== 1 || opened.size < 0 || opened.size > maxBytes) return undefined;

		const rootAfterOpen = realpathSync(requestedRoot);
		const actual = realpathSync(target);
		const current = statSync(target);
		if (
			normalizedPath(rootAfterOpen) !== normalizedPath(rootBefore) ||
			normalizedPath(actual) !== normalizedPath(target) ||
			!samePhysicalFile(opened, current)
		) {
			return undefined;
		}

		const content = Buffer.alloc(opened.size);
		let offset = 0;
		while (offset < content.length) {
			const count = readSync(descriptor, content, offset, content.length - offset, offset);
			if (count === 0) return undefined;
			offset += count;
		}

		const completed = fstatSync(descriptor);
		const rootAfterRead = realpathSync(requestedRoot);
		const actualAfterRead = realpathSync(target);
		const currentAfterRead = statSync(target);
		if (
			!samePhysicalFile(opened, completed) ||
			!samePhysicalFile(opened, currentAfterRead) ||
			normalizedPath(rootAfterRead) !== normalizedPath(rootBefore) ||
			normalizedPath(actualAfterRead) !== normalizedPath(target)
		) {
			return undefined;
		}
		return { path: actual, content, mtimeMs: opened.mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/**
 * Founder policy writes arrive through this token-gated, natively-reviewed
 * server — that IS the founder acting, so a machine with a signing identity
 * re-ratifies the policy it just wrote (manifesto §3.1). Without one,
 * legacy semantics apply and nothing is signed.
 */
function ratifyPolicyIfFounder(root: string): void {
	try {
		if (readFounderIdentity()?.privateKeyPem) signAuthorityPolicy(root);
	} catch (error) {
		console.error(`policy ratification failed: ${(error as Error).message}`);
	}
}

function writeAtomicPhysicalFile(path: string, content: string): void {
	const entry = lstatSync(path);
	if (
		entry.isSymbolicLink() ||
		!entry.isFile() ||
		entry.nlink !== 1 ||
		normalizedPath(realpathSync(path)) !== normalizedPath(path)
	) {
		throw new Error("kernel mutation target is not one physical file");
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx");
		writeFileSync(descriptor, content, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		throw error;
	}
}

/** Resolve one physical regular file without following a link at any level. */
function physicalFileWithin(directory: string, entry: string): string | undefined {
	try {
		const root = realpathSync(resolve(directory));
		if (!lstatSync(root).isDirectory()) return undefined;
		const target = resolve(root, normalize(entry));
		const rel = relative(root, target);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
		const actual = realpathSync(target);
		if (normalizedPath(actual) !== normalizedPath(target) || !lstatSync(target).isFile()) return undefined;
		return actual;
	} catch {
		return undefined;
	}
}

function physicalDirectoryWithin(directory: string, entry = "."): string | undefined {
	try {
		const root = realpathSync(resolve(directory));
		if (!lstatSync(root).isDirectory()) return undefined;
		const target = resolve(root, normalize(entry));
		const rel = relative(root, target);
		if (rel && (rel.startsWith("..") || isAbsolute(rel))) return undefined;
		const actual = realpathSync(target);
		if (normalizedPath(actual) !== normalizedPath(target) || !lstatSync(target).isDirectory()) return undefined;
		return actual;
	} catch {
		return undefined;
	}
}

function companyFileWithin(root: string, directoryPath: string, entry: string): string | undefined {
	const directory = physicalDirectoryWithin(root, directoryPath);
	return directory ? physicalFileWithin(directory, entry) : undefined;
}

function readCompanyFile(root: string, relativePath: string, maxBytes?: number): PhysicalFile | undefined {
	return readPhysicalFileWithin(root, relativePath, maxBytes);
}

function readCompanyFileWithin(
	root: string,
	directoryPath: string,
	entry: string,
	maxBytes?: number,
): PhysicalFile | undefined {
	const directory = physicalDirectoryWithin(root, directoryPath);
	return directory ? readPhysicalFileWithin(directory, entry, maxBytes) : undefined;
}

function safeSurfaceEntry(root: string, entry: string): boolean {
	return companyFileWithin(root, join("app", "surfaces"), entry) !== undefined;
}

function readProjection(root: string): ProjectionState {
	const diagnostics: string[] = [];
	let parsed: ProjectionState;
	try {
		const file = readCompanyFile(root, join("app", "projection.json"));
		if (!file) throw new Error("projection is not a physical file");
		parsed = parseProjectionDocument(JSON.parse(file.content.toString("utf-8")));
	} catch {
		parsed = {
			schema: PROJECTION_SCHEMA,
			default: "q:chats",
			navigation: [],
			nodes: [],
			diagnostics: ["app/projection.json is missing or unreadable"],
		};
	}
	diagnostics.push(...parsed.diagnostics);
	const nodes: ProjectionNode[] = [...PLATFORM_PROJECTION_NODES, ...parsed.nodes].map((node) => {
		if (node.kind !== "page" || node.view.type !== "surface") return node;
		if (!safeSurfaceEntry(root, node.view.entry)) {
			diagnostics.push(`surface page ${node.id} has an unsafe entry`);
			return {
				...node,
				view: {
					type: "builtin" as const,
					id: "qorpera.placeholder" as const,
					context: { title: node.label, message: "This page has an invalid surface entry." },
				},
			};
		}
		return { ...node, view: { ...node.view, version: surfaceVersion(root, node.view.entry) } };
	});
	return {
		schema: PROJECTION_SCHEMA,
		default: parsed.default ?? "q:chats",
		navigation: ["q:main", ...parsed.navigation],
		nodes,
		diagnostics,
	};
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
	const dir = physicalDirectoryWithin(root, "inbox");
	if (!dir) return [];
	const names = readdirSync(dir);
	const messagesDir = physicalDirectoryWithin(dir, "messages");
	const messageNames = messagesDir ? readdirSync(messagesDir) : [];
	// Companion intent files (msg-<gateId>-intent.md) fold INTO their gate's
	// card instead of appearing as items of their own.
	const intents = new Map<string, { title?: string; text: string }>();
	for (const file of messageNames) {
		const gateId = file.match(/^msg-(gate-[a-z0-9-]+)-intent\.md$/i)?.[1];
		if (!gateId) continue;
		try {
			const source = messagesDir ? readPhysicalFileWithin(messagesDir, file) : undefined;
			if (!source) continue;
			const content = source.content.toString("utf-8");
			intents.set(gateId.toLowerCase(), {
				title: content.match(/^#\s+(.+)$/m)?.[1]?.trim(),
				text: intentText(content),
			});
		} catch {
			// unreadable companions are ignored
		}
	}
	const items: InboxItem[] = [];
	for (const file of names) {
		if (!file.endsWith(".md") || file === "README.md") continue;
		try {
			const source = readPhysicalFileWithin(dir, file);
			if (!source) continue;
			const content = source.content.toString("utf-8");
			const { mtimeMs } = source;
			const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file;
			if (file.startsWith("gate-")) {
				const status = content.match(/^status:\s*(\w+)/m)?.[1] ?? "";
				const companion = intents.get(file.replace(/\.md$/i, "").toLowerCase());
				items.push({
					file,
					status,
					title: companion?.title ?? title,
					kind: "gate",
					mtimeMs,
					intent: companion?.text,
					gateTool: content.match(/^tool:\s*(.+)$/m)?.[1]?.trim(),
					gateClass: content.match(/^class:\s*(.+)$/m)?.[1]?.trim(),
				});
			} else {
				items.push({ file, status: "", title, kind: "note", mtimeMs });
			}
		} catch {
			// unreadable inbox entries are skipped
		}
	}
	for (const file of messageNames) {
		if (!/^msg-[a-z0-9][a-z0-9-]*\.md$/i.test(file) || /^msg-gate-[a-z0-9-]+-intent\.md$/i.test(file)) continue;
		try {
			const source = messagesDir ? readPhysicalFileWithin(messagesDir, file) : undefined;
			if (!source) continue;
			const content = source.content.toString("utf-8");
			const title = content.match(/^#\s+(.+)$/m)?.[1] ?? file;
			const status = /^##\s+Response/m.test(content) ? "answered" : "pending";
			items.push({ file: `messages/${file}`, status, title, kind: "message", mtimeMs: source.mtimeMs });
		} catch {
			// unreadable inbox entries are skipped
		}
	}
	return items;
}

function surfaceVersion(root: string, entry: string): number {
	try {
		return readCompanyFileWithin(root, join("app", "surfaces"), entry)?.mtimeMs ?? 0;
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
	/** Product-development department assigned to this chat. */
	department?: string;
	/** Exact product worktree assigned to this chat. */
	worktree?: string;
	/** Stable projection page ID a sidechat session is docked to, if any. */
	page?: string;
}

/** Chat-title material: chrome-injected context blocks are plumbing, not the
 * founder's words; whitespace collapses; one line, bounded. */
function sessionTitleText(text: string): string {
	return text
		.replace(/^\[Sidechat context:[^\]]*\]\s*/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 70);
}

/** Trail sessions ARE the chat list (spec §3). Title = first user message,
 * falling back to the kernel's observed first input, then the stored session
 * name; sessions with no words yet list as "New chat". Autonomous work is
 * tagged with a session name at spawn time. */
function listTrailSessions(root: string): SessionSummary[] {
	const dir = physicalDirectoryWithin(root, "trail");
	if (!dir) return [];
	const sessions: SessionSummary[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		try {
			const source = readPhysicalFileWithin(dir, file);
			if (!source) continue;
			// 256 KiB reaches past the kernel-input copy of a large first prompt
			// and image parts that can sit ahead of the first user message entry.
			const headBytes = 262_144;
			const head = source.content.toString("utf-8", 0, headBytes);
			const lines = head.split("\n");
			// The window may cut the final line mid-entry; never parse the stub.
			if (source.content.length > headBytes) lines.pop();
			let title = "";
			let kernelInput = "";
			let name = "";
			let sessionAuthority:
				| {
						autonomous?: boolean;
						label?: string;
						department?: string;
						worktree?: string;
				  }
				| undefined;
			for (const line of lines.slice(0, 400)) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						customType?: string;
						data?: { message?: unknown };
						name?: string;
						qorpera?: typeof sessionAuthority;
						message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
					};
					if (entry.type === "session" && entry.qorpera) sessionAuthority = entry.qorpera;
					if (entry.type === "session_info" && typeof entry.name === "string" && !name) {
						name = entry.name;
					}
					// The kernel records the founder's exact first input before the
					// child's own message entry lands — the cheapest title source.
					if (
						entry.type === "custom" &&
						entry.customType === "qorpera_kernel_input" &&
						!kernelInput &&
						typeof entry.data?.message === "string"
					) {
						kernelInput = sessionTitleText(entry.data.message);
					}
					if (entry.type === "message" && entry.message?.role === "user" && !title) {
						const content = entry.message.content;
						const text =
							typeof content === "string"
								? content
								: (content?.find((part) => part.type === "text")?.text ?? "");
						title = sessionTitleText(text);
					}
					if (name && title) break;
				} catch {
					// unparseable line (foreign entry shape); keep scanning
				}
			}
			const kind = sessionAuthority?.autonomous ? "autonomous" : "chat";
			// Sidechats carry immutable projection page IDs so moving a surface file
			// does not detach its conversations from the UI instrument.
			const page = kind === "chat" ? name.match(/^page — (.+)$/)?.[1] : undefined;
			// Page and product tags are plumbing; a founder-given name is title material.
			const chatName = page || /^product — /.test(name) ? "" : name;
			sessions.push({
				file,
				mtimeMs: source.mtimeMs,
				title:
					kind === "autonomous"
						? (sessionAuthority?.label ?? name)
						: title || kernelInput || chatName || "New chat",
				kind,
				department: sessionAuthority?.department,
				worktree: sessionAuthority?.worktree,
				page,
			});
		} catch {
			// unreadable session files are skipped
		}
	}
	return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface PullRequestSummary {
	file: string;
	title: string;
	status: string;
	number?: number;
	url?: string;
	branch?: string;
	updatedAt?: string;
}

function listPullRequestRecords(root: string, readModelPath: string): PullRequestSummary[] {
	const dir = physicalDirectoryWithin(root, readModelPath);
	if (!dir) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.flatMap((file) => {
				try {
					const source = readPhysicalFileWithin(dir, file, 256 * 1024);
					if (!source) return [];
					const record = JSON.parse(source.content.toString("utf-8")) as Record<string, unknown>;
					if (typeof record.title !== "string") return [];
					const url = typeof record.url === "string" && /^https?:\/\//i.test(record.url) ? record.url : undefined;
					return [
						{
							file,
							title: record.title.slice(0, 300),
							status: typeof record.status === "string" ? record.status.slice(0, 40) : "unknown",
							number: typeof record.number === "number" ? record.number : undefined,
							url,
							branch: typeof record.branch === "string" ? record.branch.slice(0, 300) : undefined,
							updatedAt: typeof record.updatedAt === "string" ? record.updatedAt.slice(0, 80) : undefined,
						},
					];
				} catch {
					return [];
				}
			})
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	} catch {
		return [];
	}
}

const INBOX_FILE_PATTERN = /^(?:messages\/)?[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/;

/** Founder response: appended into the item; the agent reads it on next wake. */
function respondToInboxItem(root: string, file: string, response: string): boolean {
	if (!INBOX_FILE_PATTERN.test(file) || !file.startsWith("messages/msg-") || !response.trim()) return false;
	const source = readCompanyFile(root, join("inbox", file));
	if (!source) return false;
	try {
		const content = source.content.toString("utf-8");
		writeAtomicPhysicalFile(
			source.path,
			`${content.trimEnd()}\n\n## Response (founder, ${new Date().toISOString().slice(0, 16)}Z)\n\n${response.trim()}\n`,
		);
		return true;
	} catch {
		return false;
	}
}

function stateFor(root: string): unknown {
	let trailSessions = 0;
	try {
		const trail = physicalDirectoryWithin(root, "trail");
		trailSessions = trail ? readdirSync(trail).filter((name) => name.endsWith(".jsonl")).length : 0;
	} catch {
		// no trail yet
	}
	let departments: Array<ReturnType<typeof listProductDepartments>[number] & { pullRequests: PullRequestSummary[] }> =
		[];
	try {
		departments = listProductDepartments(root).map((department) => ({
			...department,
			pullRequests: listPullRequestRecords(root, department.pullRequestsPath),
		}));
	} catch {
		// a malformed department record must not take company state down
	}
	return {
		name: companyName(root),
		projection: readProjection(root),
		inbox: readInbox(root),
		sessions: listTrailSessions(root),
		trailSessions,
		departments,
	};
}

/**
 * The base surface design system. Values mirror the base userland tokens
 * verbatim so surfaces blend into the chrome that embeds them. Served at
 * /assets/surface.css and linked into rendered .md/.txt surfaces; HTML
 * surfaces opt in with <link rel="stylesheet" href="/assets/surface.css">.
 * A company override at app/surfaces/theme.css is served at /assets/theme.css
 * and always linked AFTER the tokens — controllers (or the founder) restyle
 * by redefining variables, not by forking the sheet.
 */
const SURFACE_TOKENS_CSS = `/* Tokens mirror the base userland (tokens.css) so surfaces blend into the
 * chrome that embeds them. Token system and document metrics adapted from
 * T3 Code <https://github.com/pingdotgg/t3code>, MIT, (c) 2026 T3 Tools Inc.
 * Type is the system stack by design: surfaces ship no font files, so a
 * webfont name here would silently fall back anyway. */
:root {
	color-scheme: dark;
	--chrome: #0a0a0a;
	--bg: color-mix(in srgb, var(--chrome) 96%, #ffffff);
	--pane-strong: rgba(255, 255, 255, 0.05); --hover: rgba(255, 255, 255, 0.07);
	--text: #f5f5f5; --text-muted: #a6a6a6; --text-soft: #7f7f7f;
	--border: rgba(255, 255, 255, 0.07); --border-strong: rgba(255, 255, 255, 0.15);
	--primary: oklch(0.588 0.217 264); --blue: oklch(0.74 0.13 264);
	--accent: #cc7d5e; --accent-soft: rgba(204, 125, 94, 0.15);
	--danger: #f26b5e; --danger-soft: rgba(242, 107, 94, 0.14);
	--warning: #fbbf24; --warning-soft: rgba(245, 158, 11, 0.15);
	--ok: #34d399; --ok-soft: rgba(16, 185, 129, 0.14);
	--radius-sm: 6px; --radius: 10px; --radius-lg: 14px; --radius-pill: 999px;
	--font-ui: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
	--font-mono: ui-monospace, "SFMono-Regular", "Cascadia Code", Consolas, monospace;
}
body { max-width: 880px; margin: 0 auto; padding: 28px 32px; background: var(--bg); color: var(--text);
	font-family: var(--font-ui); font-size: 14px; line-height: 1.55;
	background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");
	background-repeat: repeat; background-size: 256px 256px; }
h1, h2, h3 { margin: 20px 0 8px; font-weight: 600; line-height: 1.3; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
h1:first-child { margin-top: 0; }
p, ul, ol { margin: 0 0 10px; } ul, ol { padding-left: 22px; } li + li { margin-top: 4px; }
code { border: 1px solid var(--border); background: rgba(255, 255, 255, 0.04); border-radius: var(--radius-sm);
	padding: 1px 5px; font-family: var(--font-mono); font-size: 12px; }
pre { background: rgba(255, 255, 255, 0.04); border: 1px solid var(--border); border-radius: 12px;
	padding: 12px 14px; overflow-x: auto; scrollbar-width: thin; }
pre code { border: 0; background: none; padding: 0; }
table { border-collapse: collapse; margin: 0 0 10px; font-size: 12.5px; }
td, th { border: 0; border-bottom: 1px solid color-mix(in srgb, var(--border-strong) 60%, transparent);
	padding: 7px 12px; text-align: left; }
th { font-weight: 600; white-space: nowrap; }
blockquote { border-left: 2px solid var(--border-strong); margin: 0 0 10px; padding-left: 12px; color: var(--text-muted); }
a { color: var(--blue); text-decoration: none; }
a:hover { background-image: radial-gradient(circle, currentcolor 0.75px, transparent 1px);
	background-position: left bottom; background-repeat: repeat-x; background-size: 4px 2px; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { border-radius: 3px; background: rgba(255, 255, 255, 0.08); }

/* ---- kit classes: layout vocabulary for HTML surfaces ---------------------
 * Additive only — element styles above keep working without them. */
.q-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 12px 0; }
.q-card { background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.q-card > :first-child { margin-top: 0; } .q-card > :last-child { margin-bottom: 0; }
.q-title { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
.q-meta { font-size: 11.5px; color: var(--text-soft); }
.q-stat { display: flex; flex-direction: column; gap: 2px; }
.q-stat-value { font-size: 24px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.2; }
.q-stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-soft); font-weight: 600; }
.q-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600;
	text-transform: uppercase; letter-spacing: 0.04em; border-radius: 5px; padding: 2px 6px;
	background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }
.q-badge.ok { background: var(--ok-soft); color: var(--ok); }
.q-badge.warn { background: var(--warning-soft); color: var(--warning); }
.q-badge.danger { background: var(--danger-soft); color: var(--danger); }
.q-badge.accent { background: var(--accent-soft); color: var(--accent); }
.q-row { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 8px; }
.q-row:hover { background: rgba(255, 255, 255, 0.04); }
.q-divider { border: 0; border-top: 1px solid var(--border); margin: 14px 0; }
`;

/**
 * Read-only capability kit for HTML surfaces (window.qorpera): live state
 * instead of frozen prose — surfaces as instruments, not reports.
 * Deliberately has NO mutating powers: the backend's mutating endpoints
 * require the kernel-held token (self-approval hole closed in 0.7.0) and
 * surfaces must never carry it. An action bridge (invoke(prompt) starting a
 * controller session) is planned and needs its own token design — never
 * fake it here through founder-lane endpoints.
 */
const SURFACE_KIT_JS = `window.qorpera = {
	/** Company state: name, projection, inbox summary, sessions. */
	async getState() { return (await fetch("/api/state")).json(); },
	/** Raw text of a substrate file (app/substrates/<name>). */
	async readSubstrate(name) {
		const r = await fetch("/api/substrate/" + encodeURIComponent(name));
		if (!r.ok) throw new Error("substrate not found: " + name);
		return r.text();
	},
	/** Raw text of an inbox item (msg-*.md / gate-*.md). */
	async readInbox(file) {
		const r = await fetch("/api/inbox/" + encodeURIComponent(file));
		if (!r.ok) throw new Error("inbox item not found: " + file);
		return r.text();
	},
	/** Run fn now and every ms milliseconds — live instruments. */
	every(ms, fn) { fn(); return setInterval(fn, ms); },
};
`;

const SURFACE_HEAD_LINKS = `<link rel="stylesheet" href="/assets/surface.css"><link rel="stylesheet" href="/assets/theme.css">`;

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
	const target = readCompanyFileWithin(root, join("app", "surfaces"), entry);
	if (!target) {
		response.writeHead(403).end("outside surfaces");
		return;
	}
	try {
		const { content } = target;
		if (target.path.endsWith(".md") || target.path.endsWith(".txt")) {
			const source = content.toString("utf-8");
			const body = target.path.endsWith(".md")
				? marked.parse(escapeHtmlText(source), { breaks: false, async: false })
				: `<pre>${escapeHtmlText(source)}</pre>`;
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(
					`<!doctype html><html><head><meta charset="utf-8">${SURFACE_HEAD_LINKS}</head><body>${body}</body></html>`,
				);
			return;
		}
		const type = target.path.endsWith(".html")
			? "text/html; charset=utf-8"
			: target.path.endsWith(".js")
				? "text/javascript"
				: target.path.endsWith(".css")
					? "text/css"
					: target.path.endsWith(".json")
						? "application/json"
						: "text/plain; charset=utf-8";
		response.writeHead(200, { "content-type": type }).end(content);
	} catch {
		response.writeHead(404).end("surface not found");
	}
}

/**
 * Serve a substrate file read-only from inside app/substrates (no
 * traversal) — the data side of surfaces-as-instruments.
 */
function serveSubstrate(root: string, entry: string, response: ServerResponse): void {
	const target = readCompanyFileWithin(root, join("app", "substrates"), entry);
	if (!target) {
		response.writeHead(403).end("outside substrates");
		return;
	}
	try {
		response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(target.content);
	} catch {
		response.writeHead(404).end("substrate not found");
	}
}

function staticContentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

function serveUserland(directory: string, entry: string, response: ServerResponse): void {
	const target = readPhysicalFileWithin(directory, entry || "index.html");
	serveUserlandTarget(target, response);
}

function serveCompanyUserland(root: string, entry: string, response: ServerResponse): void {
	const target = readCompanyFileWithin(root, "userland", entry || "index.html");
	serveUserlandTarget(target, response);
}

function serveUserlandTarget(target: PhysicalFile | undefined, response: ServerResponse): void {
	if (!target) {
		response.writeHead(404).end("userland asset not found");
		return;
	}
	response
		.writeHead(200, {
			"content-type": staticContentType(target.path),
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		})
		.end(target.content);
}

function decodedPath(value: string, response: ServerResponse): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		response.writeHead(400).end("invalid path encoding");
		return undefined;
	}
}

/** The human resolves gates here — this is the approve/deny queue as UI. */
function resolveGate(root: string, file: string, action: string): boolean {
	if (!/^gate-[a-z0-9-]+\.md$/i.test(file)) return false;
	if (action !== "approved" && action !== "denied") return false;
	const source = readCompanyFile(root, join("inbox", file));
	if (!source) return false;
	try {
		const content = source.content.toString("utf-8");
		const status = content.match(/^status:\s*(\w+)/m)?.[1];
		const tool = content.match(/^tool:\s*(.+)$/m)?.[1]?.trim();
		const pendingTransition = status === "pending";
		const durableRevocation =
			status === "consumed" && action === "denied" && (tool === "behavior_signature" || tool === "extension_load");
		if (!pendingTransition && !durableRevocation) return false;
		let updated = content.replace(/^status:.*$/m, `status: ${action}`).replace(/^approval:.*\r?\n?/m, "");
		// Signed approvals (manifesto §3.2): with a founder identity, the
		// approval carries the founder's signature over (id, hash) — without
		// it, an approved status line is data the authority layer ignores.
		if (action === "approved" && readFounderIdentity()?.privateKeyPem) {
			const id = updated.match(/^id:\s*(\S+)/m)?.[1];
			const hash = updated.match(/^hash:\s*([a-f0-9]{64})/m)?.[1];
			if (id && hash) {
				updated = updated.replace(/^hash:.*$/m, (line) => `${line}\napproval: ${signGateApproval(id, hash)}`);
			}
		}
		writeAtomicPhysicalFile(source.path, updated);
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
	<div id="navigation"></div>
</nav>
<main>
	<iframe id="frame" hidden></iframe>
	<div id="panel"></div>
</main>
<script>
let state = { projection: { navigation: [], nodes: [], diagnostics: [] }, inbox: [], sessions: [], trailSessions: 0 };
let current = null; // stable projection node ID
async function refresh() {
	try {
		const next = await (await fetch("/api/state")).json();
		const changed = JSON.stringify(next) !== JSON.stringify(state);
		state = next;
		if (changed) render();
	} catch {}
}
function render() {
	const nav = document.getElementById("navigation");
	nav.innerHTML = "";
	if (current && !node(current)) current = null;
	for (const departmentId of state.projection.navigation) {
		const department = node(departmentId);
		if (!department || department.kind !== "department") continue;
		const heading = document.createElement("h2");
		heading.textContent = department.label;
		nav.appendChild(heading);
		for (const childId of department.items) {
			const child = node(childId);
			if (!child) continue;
			const button = document.createElement("button");
			button.textContent = child.label;
			if (current === child.id) button.className = "active";
			button.onclick = () => openNode(child.id);
			nav.appendChild(button);
		}
	}
	if (!current && state.projection.default) openNode(state.projection.default);
	const target = node(current);
	if (target && target.kind === "page" && target.view.type === "surface") {
		const src = "/surface/" + encodeURIComponent(target.view.entry) + "?v=" + (target.view.version || 0);
		const frame = document.getElementById("frame");
		if (frame.getAttribute("src") !== src) frame.src = src;
	}
	if (target && target.kind === "page" && target.view.type === "builtin") {
		if (target.view.id === "qorpera.inbox") showPanel("inbox", true);
		if (target.view.id === "qorpera.activity" || target.view.id === "qorpera.chats") showPanel("trail", true);
	}
}
function node(id) { return state.projection.nodes.find((entry) => entry.id === id); }
function openNode(id) {
	const target = node(id);
	if (!target) return;
	current = id;
	if (target.kind === "department" || target.kind === "category") return showCollection(target);
	if (target.view.type === "surface") return showSurface(target);
	if (target.view.id === "qorpera.inbox") return showPanel("inbox");
	if (target.view.id === "qorpera.activity" || target.view.id === "qorpera.chats") return showPanel("trail");
	const message = target.view.context && target.view.context.message || "This builtin is available in the desktop app.";
	showMessage(target.label, message);
}
function showSurface(page) {
	document.getElementById("panel").style.display = "none";
	const f = document.getElementById("frame");
	f.hidden = false; f.src = "/surface/" + encodeURIComponent(page.view.entry) + "?v=" + (page.view.version || 0);
	render();
}
function showCollection(collection) {
	const p = document.getElementById("panel");
	document.getElementById("frame").hidden = true;
	p.style.display = "block";
	p.innerHTML = "<h1></h1>";
	p.querySelector("h1").textContent = collection.label;
	for (const id of collection.items) {
		const page = node(id);
		if (!page || page.kind !== "page") continue;
		const button = document.createElement("button");
		button.className = "gate";
		button.textContent = page.label;
		button.onclick = () => openNode(page.id);
		p.appendChild(button);
	}
	render();
}
function showMessage(title, message) {
	const p = document.getElementById("panel");
	document.getElementById("frame").hidden = true;
	p.style.display = "block";
	p.innerHTML = '<div class="gate"><div class="t"></div><div class="s"></div></div>';
	p.querySelector(".t").textContent = title;
	p.querySelector(".s").textContent = message;
	render();
}
function showPanel(which, keep) {
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
			} else if (g.status === "consumed" && (g.gateTool === "behavior_signature" || g.gateTool === "extension_load")) {
				const b = document.createElement("button");
				b.textContent = "Revoke trust"; b.className = "no";
				b.onclick = async () => { await fetch("/api/gate", { method: "POST", headers: { "content-type": "application/json", "x-qorpera-token": "${token}" }, body: JSON.stringify({ file: g.file, action: "denied" }) }); refresh().then(() => showPanel("inbox", true)); };
				d.appendChild(b);
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

async function serveCompanyUsage(
	root: string,
	window: { sinceDay: string; untilDay: string; timeZone: string },
	usageRateCatalog: () => Promise<UsageRateCatalog>,
	response: ServerResponse,
): Promise<void> {
	try {
		const rates = await usageRateCatalog();
		const summary = await readCompanyUsage(root, window, rates);
		response
			.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
			.end(JSON.stringify(summary));
	} catch (error) {
		response
			.writeHead(500, { "content-type": "application/json" })
			.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
}

export function createCompanyAppServer(options: CompanyAppOptions): Server {
	const root = canonicalCompanyRoot(options.root);
	const usageRateCatalog = options.usageRateCatalog ?? readUsageRateCatalog;
	const authToken = options.authToken;
	if (!authToken) throw new Error("company app server requires a desktop-kernel authorization token");
	const authorized = (request: IncomingMessage): boolean => request.headers["x-qorpera-token"] === authToken;
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname.startsWith("/userland/base/") && options.userland) {
			const entry = decodedPath(url.pathname.slice("/userland/base/".length), response);
			if (entry !== undefined) serveUserland(options.userland.baseDir, entry, response);
			return;
		}
		if (url.pathname.startsWith("/userland/fork/") && options.userland) {
			const entry = decodedPath(url.pathname.slice("/userland/fork/".length), response);
			if (entry !== undefined) serveCompanyUserland(root, entry, response);
			return;
		}
		if (url.pathname === "/") {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(CHROME_HTML(companyName(root), ""));
			return;
		}
		if (url.pathname === "/api/state") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(stateFor(root)));
			return;
		}
		if (url.pathname === "/api/usage" && request.method === "GET") {
			const window = {
				sinceDay: url.searchParams.get("sinceDay") ?? "",
				untilDay: url.searchParams.get("untilDay") ?? "",
				timeZone: url.searchParams.get("timeZone") ?? "",
			};
			const windowError = companyUsageWindowError(window);
			if (windowError) {
				response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: windowError }));
				return;
			}
			void serveCompanyUsage(root, window, usageRateCatalog, response);
			return;
		}
		if (url.pathname === "/assets/surface.css") {
			response.writeHead(200, { "content-type": "text/css" }).end(SURFACE_TOKENS_CSS);
			return;
		}
		if (url.pathname === "/assets/surface-kit.js") {
			response.writeHead(200, { "content-type": "text/javascript" }).end(SURFACE_KIT_JS);
			return;
		}
		if (url.pathname === "/assets/theme.css") {
			// Company override point: served empty when absent so the link
			// in every rendered surface is always safe. Read BEFORE writing
			// headers — a throw after writeHead kills the server.
			let theme = "";
			try {
				const file = readCompanyFileWithin(root, join("app", "surfaces"), "theme.css");
				if (file) theme = file.content.toString("utf-8");
			} catch {
				// absent: serve empty
			}
			response.writeHead(200, { "content-type": "text/css" }).end(theme);
			return;
		}
		if (url.pathname.startsWith("/api/substrate/") && request.method === "GET") {
			const entry = decodedPath(url.pathname.slice("/api/substrate/".length), response);
			if (entry !== undefined) serveSubstrate(root, entry, response);
			return;
		}
		if (url.pathname.startsWith("/surface/")) {
			const entry = decodedPath(url.pathname.slice("/surface/".length), response);
			if (entry !== undefined) serveSurface(root, entry, response);
			return;
		}
		if (url.pathname.startsWith("/api/inbox/") && request.method === "GET") {
			const file = decodedPath(url.pathname.slice("/api/inbox/".length), response);
			if (file === undefined) return;
			if (!INBOX_FILE_PATTERN.test(file)) {
				response.writeHead(400).end("bad name");
				return;
			}
			try {
				const source = readCompanyFile(root, join("inbox", file));
				if (!source) throw new Error("inbox item is not a physical file");
				response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end(source.content.toString("utf-8"));
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
					},
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
					};
					// Surgical merge into the existing file so [tools] and any
					// custom sections survive; comments do not (Advanced tab
					// exists for comment-preserving edits).
					const source = readCompanyFile(root, "authority.toml");
					if (!source) throw new Error("authority policy is not a physical file");
					let existing: Record<string, unknown> = {};
					try {
						existing = parseToml(source.content.toString("utf-8")) as Record<string, unknown>;
					} catch {
						existing = {};
					}
					const modes = new Set(["auto", "notify", "gate"]);
					for (const name of ["money", "identity", "irreversible"]) {
						const incoming = update.classes?.[name];
						if (!incoming) continue;
						const section = { ...((existing[name] as Record<string, unknown>) ?? {}) };
						if (incoming.mode && modes.has(incoming.mode)) section.mode = incoming.mode;
						if (name === "money" && typeof incoming.limitUsd === "number") section.limit_usd = incoming.limitUsd;
						existing[name] = section;
					}
					existing.authority = { ...((existing.authority as Record<string, unknown>) ?? {}), mode: "gate" };
					writeAtomicPhysicalFile(source.path, `${stringifyToml(existing)}\n`);
					ratifyPolicyIfFounder(root);
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
				const source = readCompanyFile(root, "authority.toml");
				if (!source) throw new Error("authority policy is not a physical file");
				response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end(source.content.toString("utf-8"));
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
					const source = readCompanyFile(root, "authority.toml");
					if (!source) throw new Error("authority policy is not a physical file");
					writeAtomicPhysicalFile(source.path, content);
					ratifyPolicyIfFounder(root);
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
