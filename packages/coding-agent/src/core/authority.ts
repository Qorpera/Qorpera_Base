/**
 * Authority gates — Qorpera Base's enforcement layer (spec §4).
 *
 * Full freedom in thought and construction; gates on effect. `authority.toml`
 * at the company root defines four effect classes (money, identity,
 * irreversible, authority) with modes auto | notify | gate. `[authority]` is
 * ALWAYS gated regardless of configuration — it covers changes to the
 * authority file itself, the kernel files (AGENTS.md / CLAUDE.md at the
 * root), and the inbox (so the agent cannot approve its own requests).
 *
 * Gate mechanics are async by design: a blocked effect files a request at
 * `<root>/inbox/gate-*.md` and returns a block reason; the agent keeps
 * working elsewhere. A human resolves the request by editing its `status:`
 * line to `approved` or `denied`. Tool-call approvals are single-use
 * (consumed on the next matching call); extension-load approvals are durable
 * for the approved content hash (new content = new hash = new gate).
 *
 * Without an `authority.toml` anywhere above the working directory, every
 * decision is `allow` — Base behaves like the stock harness.
 *
 * This module is policy + record-keeping only. Enforcement happens where it
 * is wired: `agent-session.ts` (`_installAgentToolHooks`, before extension
 * handlers) and the resource loader's project-extension filter. See SEAMS.md
 * §c for the bypass analysis this design answers.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";

export type EffectClass = "money" | "identity" | "irreversible" | "authority" | "products";
export type AuthorityMode = "auto" | "notify" | "gate";

export interface AuthorityClassConfig {
	mode: AuthorityMode;
	limitUsd?: number;
}

export interface AuthorityConfig {
	classes: Record<EffectClass, AuthorityClassConfig>;
	/** Per-tool overrides from `[tools]`: tool name -> effect class or "none". */
	tools: Record<string, EffectClass | "none">;
	/**
	 * Root-relative paths of software products the controller may read and
	 * study freely but not modify without approval ([products] paths).
	 */
	productPaths: string[];
}

export interface Authority {
	/** Directory containing authority.toml — the company root. */
	root: string;
	configPath: string;
}

export type AuthorityDecision =
	| { kind: "allow" }
	| { kind: "allow"; notified: true; effectClass: EffectClass }
	| { kind: "block"; reason: string; effectClass: EffectClass; gateId?: string };

export type GateStatus = "pending" | "approved" | "denied" | "consumed";

export interface GateRecord {
	id: string;
	status: GateStatus;
	hash: string;
	filePath: string;
}

const EFFECT_CLASSES: EffectClass[] = ["money", "identity", "irreversible", "authority", "products"];
/** Path-arg zone checks apply only to tools that mutate the path. */
const MUTATING_PATH_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit"]);
const AUTHORITY_FILE = "authority.toml";
const INBOX_DIR = "inbox";
/** Root-level files whose modification is an [authority]-class effect. */
const PROTECTED_ROOT_FILES = new Set([AUTHORITY_FILE, "AGENTS.md", "CLAUDE.md"]);

/**
 * Conservative screen for destructive shell commands. False positives gate
 * (recoverable by approval); false negatives execute — so err toward gating.
 */
const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
	/\bgit\s+push\b[^|;&]*(--force\b|\s-f\b)/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\b[^|;&]*-[a-z]*f/i,
	/\bdrop\s+(table|database|schema)\b/i,
	/\btruncate\s+table\b/i,
	/\bmkfs\b/i,
	/\bformat\s+[a-z]:/i,
	/\brmdir\s+\/s\b/i,
	/\bdel\s+\/[sfq]\b/i,
	/\bshutdown\b/i,
	/--no-preserve-root\b/,
];

/** Walk upward from startDir looking for authority.toml. */
export function discoverAuthority(startDir: string): Authority | undefined {
	let dir = resolve(startDir);
	while (true) {
		const candidate = join(dir, AUTHORITY_FILE);
		if (existsSync(candidate)) {
			return { root: dir, configPath: candidate };
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Read the config fresh on every evaluation: the file is human-owned and may
 * be relaxed mid-session; picking edits up immediately is the point.
 * A malformed file fails CLOSED (every class gates) — a broken authority
 * file must never mean "no authority".
 */
export function readAuthorityConfig(authority: Authority): AuthorityConfig {
	const fallback: AuthorityConfig = {
		classes: {
			money: { mode: "gate" },
			identity: { mode: "gate" },
			irreversible: { mode: "gate" },
			authority: { mode: "gate" },
			products: { mode: "gate" },
		},
		tools: {},
		productPaths: [],
	};
	let raw: Record<string, unknown>;
	try {
		raw = parseToml(readFileSync(authority.configPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return fallback;
	}

	const config: AuthorityConfig = { classes: { ...fallback.classes }, tools: {}, productPaths: [] };
	const productsSection = raw.products;
	if (productsSection && typeof productsSection === "object") {
		const paths = (productsSection as Record<string, unknown>).paths;
		if (Array.isArray(paths)) {
			config.productPaths = paths.filter((entry): entry is string => typeof entry === "string");
		}
	}
	for (const effectClass of EFFECT_CLASSES) {
		const section = raw[effectClass];
		if (section && typeof section === "object") {
			const mode = (section as Record<string, unknown>).mode;
			if (mode === "auto" || mode === "notify" || mode === "gate") {
				config.classes[effectClass] = { mode };
			}
			const limit = (section as Record<string, unknown>).limit_usd;
			if (typeof limit === "number") {
				config.classes[effectClass].limitUsd = limit;
			}
		}
	}
	// The one non-configurable clause: [authority] is always gated. This is
	// what keeps "self-modifying with full freedom" from including modifying
	// the human out of the loop.
	config.classes.authority = { ...config.classes.authority, mode: "gate" };

	const tools = raw.tools;
	if (tools && typeof tools === "object") {
		for (const [name, value] of Object.entries(tools as Record<string, unknown>)) {
			if (value === "none" || (typeof value === "string" && (EFFECT_CLASSES as string[]).includes(value))) {
				config.tools[name] = value as EffectClass | "none";
			}
		}
	}
	return config;
}

function extractPathArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath"]) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return undefined;
}

function isUnderDir(target: string, root: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Does this file path touch authority-protected territory?
 *
 * The inbox is the controller↔founder channel: the agent MAY author
 * `msg-*.md` items (questions, proposals, plans, updates — the founder
 * responds in the shell). Everything else in inbox/ stays gated — gate
 * files especially, since writing those is self-approval.
 */
function isProtectedPath(authority: Authority, rawPath: string, cwd: string): boolean {
	const resolved = resolve(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
	const inboxDirPath = join(authority.root, INBOX_DIR);
	if (isUnderDir(resolved, inboxDirPath)) {
		const isDirectChild = dirname(resolved) === resolve(inboxDirPath);
		const isAgentMessage = /^msg-[a-z0-9][a-z0-9-]*\.md$/i.test(basename(resolved));
		return !(isDirectChild && isAgentMessage);
	}
	if (dirname(resolved) === resolve(authority.root) && PROTECTED_ROOT_FILES.has(basename(resolved))) return true;
	return false;
}

function bashCommandFromArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const command = (args as Record<string, unknown>).command;
	return typeof command === "string" ? command : undefined;
}

/**
 * Redirects that are not writes: stderr/stdout to the null device and
 * fd merges (`2>/dev/null`, `2>&1`). Stripped before the write-ish test —
 * live conception audit 2026-08-04 showed them gating pure study commands.
 */
function stripHarmlessRedirects(command: string): string {
	return command.replace(/\d?\s*>>?\s*(?:\/dev\/null|nul\b)/gi, " ").replace(/\d?\s*>&\s*\d/g, " ");
}

/** Shell fragments that indicate mutation (vs. reading/study). */
const WRITEISH_BASH =
	/(>>?|\btee\b|\bmv\b|\bcp\b|\brm\b|\brmdir\b|\bdel\b|\bsed\s+-i\b|\btouch\b|\bln\b|\bchmod\b|\bset-content\b|\badd-content\b|\bout-file\b|\bgit\s+(commit|push|checkout|switch|restore|reset|rebase|merge|apply|cherry-pick|clean|rm|mv|stash|tag)\b|\bnpm\s+(install|uninstall|update|version|publish)\b)/i;

/** Authority-class bash screens. All protected territory — inbox/, the
 * authority file, the kernel files — gates only in write-ish contexts:
 * reading inbox items is routine (the kernel TELLS the agent to read
 * founder responses; live remodels 2026-08-04 showed pure `cat`/`ls`/`wc`
 * study commands gating on a bare inbox mention). Write-ish + inbox
 * mention stays gated in full — bash never writes there, not even
 * msg-*.md (the write tool's carve-out is the one sanctioned lane). */
function bashTouchesProtected(command: string): boolean {
	// The company backend's mutating endpoints (gate approval, inbox
	// responses, authority edits) are for the HUMAN's UI — an agent curling
	// them is attempting self-authorization regardless of the token guard.
	if (/\/api\/(gate|authority|inbox\/respond)\b/.test(command)) return true;
	const stripped = stripHarmlessRedirects(command);
	if (!WRITEISH_BASH.test(stripped)) return false;
	if (/\binbox[/\\]/.test(stripped)) return true;
	if (stripped.includes(AUTHORITY_FILE)) return true;
	if (/\b(AGENTS|CLAUDE)\.md\b/i.test(stripped)) return true;
	return false;
}

function resolveArgPath(rawPath: string, cwd: string): string {
	return resolve(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
}

/** Is this resolved path inside a [products]-declared zone? */
function isUnderProduct(authority: Authority, config: AuthorityConfig, resolvedPath: string): boolean {
	for (const productPath of config.productPaths) {
		const productRoot = resolve(join(authority.root, productPath));
		if (resolvedPath === productRoot || isUnderDir(resolvedPath, productRoot)) return true;
	}
	return false;
}

/**
 * Product zone screen for shell commands: reading/study is free; a command
 * that BOTH mentions a product path AND looks mutating gates as products.
 * Heuristic by nature — precise enforcement rides on the path-arg tools and
 * engine patch approvals.
 */
function bashTouchesProductWriteish(config: AuthorityConfig, command: string): boolean {
	if (config.productPaths.length === 0) return false;
	if (!WRITEISH_BASH.test(stripHarmlessRedirects(command))) return false;
	for (const productPath of config.productPaths) {
		const forward = productPath.replace(/\\/g, "/");
		const backward = forward.replace(/\//g, "\\");
		if (command.includes(forward) || command.includes(backward)) return true;
		// Also match the zone's basename (`cd Qorpera_Desktop && git commit`).
		const base = forward.split("/").filter(Boolean).pop();
		if (base && command.includes(base)) return true;
	}
	return false;
}

/**
 * Classify a tool call into an effect class, or undefined for "no effect
 * class" (auto). Order: explicit [tools] override, then built-in rules.
 */
export function classifyToolCall(
	authority: Authority,
	config: AuthorityConfig,
	toolName: string,
	args: unknown,
	cwd: string,
): EffectClass | undefined {
	// Zone checks rank ABOVE [tools] overrides (including "none"): opting a
	// tool out of classification must not open the kernel files or product
	// zones. Zones apply only to mutating tools — reading/study is free.
	const pathArg = extractPathArg(args);
	if (pathArg && MUTATING_PATH_TOOLS.has(toolName)) {
		const resolved = resolveArgPath(pathArg, cwd);
		if (isProtectedPath(authority, pathArg, cwd)) return "authority";
		if (isUnderProduct(authority, config, resolved)) return "products";
	}

	const overrideRaw = config.tools[toolName];
	const override: EffectClass | undefined = overrideRaw === "none" ? undefined : overrideRaw;

	if (toolName === "bash") {
		const command = bashCommandFromArgs(args);
		if (command) {
			if (bashTouchesProtected(command)) return "authority";
			if (bashTouchesProductWriteish(config, command)) return "products";
			if (overrideRaw === "none") return undefined;
			if (override) return override;
			if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command))) return "irreversible";
		}
		return override;
	}

	if (overrideRaw === "none") return undefined;
	return override;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function requestHash(toolName: string, args: unknown): string {
	return createHash("sha256")
		.update(`${toolName}\n${canonicalJson(args)}`)
		.digest("hex");
}

function inboxDir(authority: Authority): string {
	return join(authority.root, INBOX_DIR);
}

function parseGateFile(filePath: string): GateRecord | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!frontmatter) return undefined;
	const fields = new Map<string, string>();
	for (const line of frontmatter[1].split(/\r?\n/)) {
		const match = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (match) fields.set(match[1], match[2].split("#")[0].trim());
	}
	const id = fields.get("id");
	const status = fields.get("status") as GateStatus | undefined;
	const hash = fields.get("hash");
	if (!id || !status || !hash) return undefined;
	if (!["pending", "approved", "denied", "consumed"].includes(status)) return undefined;
	return { id, status, hash, filePath };
}

export function findGateRecords(authority: Authority, hash: string): GateRecord[] {
	const dir = inboxDir(authority);
	if (!existsSync(dir)) return [];
	const records: GateRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.startsWith("gate-") || !name.endsWith(".md")) continue;
		const record = parseGateFile(join(dir, name));
		if (record && record.hash === hash) records.push(record);
	}
	return records;
}

function setGateStatus(record: GateRecord, status: GateStatus): void {
	const content = readFileSync(record.filePath, "utf-8");
	writeFileSync(record.filePath, content.replace(/^status:.*$/m, `status: ${status}`), "utf-8");
}

export interface GateRequestInput {
	toolName: string;
	effectClass: EffectClass;
	args: unknown;
	hash: string;
	what: string;
}

export function writeGateRequest(authority: Authority, input: GateRequestInput): string {
	const dir = inboxDir(authority);
	mkdirSync(dir, { recursive: true });
	const shortHash = input.hash.slice(0, 8);
	let fileName = `gate-${shortHash}.md`;
	let counter = 1;
	while (existsSync(join(dir, fileName))) {
		counter += 1;
		fileName = `gate-${shortHash}-${counter}.md`;
	}
	const id = `gate-${shortHash}${counter > 1 ? `-${counter}` : ""}`;
	const body = [
		"---",
		`id: ${id}`,
		"status: pending   # change to: approved | denied",
		`class: ${input.effectClass}`,
		`tool: ${input.toolName}`,
		`hash: ${input.hash}`,
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		`# Gate request: ${input.toolName} (${input.effectClass})`,
		"",
		`**What:** ${input.what}`,
		"",
		"**Arguments:**",
		"```json",
		JSON.stringify(input.args, null, 2) ?? "null",
		"```",
		"",
		"**If denied:** the agent will not perform this action and will pursue another path.",
		"",
		"To resolve, edit the `status:` line above to `approved` or `denied`.",
		"",
	].join("\n");
	writeFileSync(join(dir, fileName), body, "utf-8");
	return id;
}

function appendNotice(authority: Authority, message: string): void {
	const dir = inboxDir(authority);
	mkdirSync(dir, { recursive: true });
	const noticePath = join(dir, "notices.md");
	const line = `- ${new Date().toISOString()} ${message}\n`;
	if (existsSync(noticePath)) {
		writeFileSync(noticePath, readFileSync(noticePath, "utf-8") + line, "utf-8");
	} else {
		writeFileSync(noticePath, `# Notices\n\n${line}`, "utf-8");
	}
}

function summarizeCall(toolName: string, args: unknown): string {
	const command = bashCommandFromArgs(args);
	if (command) return `run \`${command.length > 200 ? `${command.slice(0, 200)}…` : command}\``;
	const pathArg = extractPathArg(args);
	if (pathArg) return `${toolName} → ${pathArg}`;
	return `call \`${toolName}\``;
}

/**
 * The main enforcement decision for a tool call. Single-use approvals: an
 * approved gate is consumed by the first matching call.
 */
export function evaluateToolCall(
	authority: Authority,
	toolName: string,
	args: unknown,
	cwd: string,
): AuthorityDecision {
	const config = readAuthorityConfig(authority);
	const effectClass = classifyToolCall(authority, config, toolName, args, cwd);
	if (!effectClass) return { kind: "allow" };

	const mode = config.classes[effectClass].mode;
	if (mode === "auto") return { kind: "allow" };
	if (mode === "notify") {
		appendNotice(authority, `[${effectClass}] ${summarizeCall(toolName, args)} (auto-proceeded, notify mode)`);
		return { kind: "allow", notified: true, effectClass };
	}

	const hash = requestHash(toolName, args);
	const records = findGateRecords(authority, hash);
	const approved = records.find((record) => record.status === "approved");
	if (approved) {
		setGateStatus(approved, "consumed");
		appendNotice(authority, `[${effectClass}] ${approved.id} consumed: ${summarizeCall(toolName, args)}`);
		return { kind: "allow", notified: true, effectClass };
	}
	const pending = records.find((record) => record.status === "pending");
	if (pending) {
		return {
			kind: "block",
			effectClass,
			gateId: pending.id,
			reason: `Authority gate [${effectClass}]: request ${pending.id} is awaiting human approval in inbox/. Continue with other work; retry after it is approved.`,
		};
	}
	const denied = records.find((record) => record.status === "denied");
	if (denied) {
		return {
			kind: "block",
			effectClass,
			gateId: denied.id,
			reason: `Authority gate [${effectClass}]: request ${denied.id} was DENIED by the human. Do not retry this action; pursue another path. (A human can still edit the gate file to approved.)`,
		};
	}
	const gateId = writeGateRequest(authority, {
		toolName,
		effectClass,
		args,
		hash,
		what: summarizeCall(toolName, args),
	});
	return {
		kind: "block",
		effectClass,
		gateId,
		reason: `Authority gate [${effectClass}]: this action requires human approval. Request ${gateId} filed in inbox/. NOW write inbox/msg-${gateId}-intent.md: 1-3 plain sentences for the founder on the OUTCOME this action serves — what it achieves for the company, no command syntax (it becomes the headline of the approval card; the exact command is shown separately). Then continue with other work; retry after it is approved.`,
	};
}

/**
 * Extension-load gating. Project-local extensions under the authority root
 * are agent-authorable code that runs with full user permissions (see
 * SEAMS.md c.3) — loading one is an [authority]-class effect. Approvals are
 * durable per content hash: approving a file approves that exact code;
 * changed content is a new request.
 */
export function filterExtensionPaths(
	authority: Authority,
	paths: string[],
	agentDir: string,
): { allowed: string[]; blocked: Array<{ path: string; gateId: string; pending: boolean }> } {
	const allowed: string[] = [];
	const blocked: Array<{ path: string; gateId: string; pending: boolean }> = [];
	for (const path of paths) {
		const resolved = resolve(path);
		const underRoot = isUnderDir(resolved, authority.root) || resolved === resolve(authority.root);
		const underAgentDir = isUnderDir(resolved, resolve(agentDir));
		if (!underRoot || underAgentDir) {
			allowed.push(path);
			continue;
		}
		let contentHash: string;
		try {
			contentHash = createHash("sha256").update(readFileSync(resolved)).digest("hex");
		} catch {
			allowed.push(path); // unreadable/missing: let the loader surface its own error
			continue;
		}
		const hash = requestHash("extension_load", {
			path: relative(authority.root, resolved).split(sep).join("/"),
			contentHash,
		});
		const records = findGateRecords(authority, hash);
		const approvedOrConsumed = records.find((record) => record.status === "approved" || record.status === "consumed");
		if (approvedOrConsumed) {
			allowed.push(path);
			continue;
		}
		const pending = records.find((record) => record.status === "pending");
		const denied = records.find((record) => record.status === "denied");
		if (pending) {
			blocked.push({ path, gateId: pending.id, pending: true });
			continue;
		}
		if (denied) {
			blocked.push({ path, gateId: denied.id, pending: false });
			continue;
		}
		const gateId = writeGateRequest(authority, {
			toolName: "extension_load",
			effectClass: "authority",
			args: { path: relative(authority.root, resolved).split(sep).join("/"), contentHash },
			hash,
			what: `load project extension ${relative(authority.root, resolved).split(sep).join("/")} (sha256 ${contentHash.slice(0, 12)}…)`,
		});
		blocked.push({ path, gateId, pending: true });
	}
	return { allowed, blocked };
}
