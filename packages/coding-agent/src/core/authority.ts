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
	| { kind: "allow"; notified?: true; effectClass?: EffectClass; scoped?: true; behavior?: BehaviorSignature }
	| { kind: "block"; reason: string; effectClass: EffectClass; gateId?: string; behavior?: BehaviorSignature };

/**
 * Caller-supplied context for the signature rule (EVOLUTION.md §3).
 * The "one new input" of EVOLUTION §9.1.
 */
export interface ToolCallContext {
	/**
	 * True when a founder is present with approval-capable UI (tui/rpc modes);
	 * headless runs (print/json/SDK) are unattended.
	 */
	attended: boolean;
	/**
	 * Absolute source path of the code that registered the executing tool,
	 * when the call originates from codified behavior (an extension-registered
	 * tool) rather than the model improvising with built-ins. Synthetic paths
	 * (`<builtin:…>`, `<sdk:…>`) and paths outside the authority root are
	 * ignored — only company-authored code is subject to signatures.
	 */
	behaviorPath?: string;
}

/** Signature status of the codified behavior backing a tool call. */
export interface BehaviorSignature {
	/** Root-relative POSIX path of the acting code. */
	path: string;
	/** sha256 of the file content at evaluation time. */
	contentHash: string;
	/** A durable founder approval exists for exactly this content. */
	signed: boolean;
	gateId?: string;
	gateStatus?: "pending" | "denied";
}

export type GateStatus = "pending" | "approved" | "denied" | "consumed";

export interface GateRecord {
	id: string;
	status: GateStatus;
	hash: string;
	filePath: string;
}

const EFFECT_CLASSES: EffectClass[] = ["money", "identity", "irreversible", "authority", "products"];
/**
 * Classes whose effects touch the world outside the company folder — the
 * signature rule applies to these. [authority] and [products] are spine/zone
 * protection with their own (stricter or path-scoped) semantics.
 */
const OUTWARD_CLASSES: ReadonlySet<EffectClass> = new Set(["money", "identity", "irreversible"]);
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
	// History rewrites — history is append-only from the agent's side
	// (EVOLUTION.md §4 invariant 1). Force-push, reset --hard, and clean -f
	// are already screened above.
	/\bgit\b[^|;&]*\bcommit\b[^|;&]*--amend\b/i,
	/\bgit\s+rebase\b/i,
	/\bgit\s+filter-branch\b/i,
	/\bgit[-\s]filter-repo\b/i,
	/\bgit\s+reflog\s+(expire|delete)\b/i,
	/\bgit\s+update-ref\b[^|;&]*(\s-d\b|--delete\b)/i,
	/\bgit\s+gc\b[^|;&]*--prune/i,
];

/**
 * Provenance trailers (EVOLUTION.md §4 invariant 3): every agent-authored
 * commit carries its trigger and rationale as trailers. Enforced here
 * because every agent commit — pi-native or engine mode — crosses this
 * boundary, while the founder's own commits in their own terminal never do.
 * Matching is deliberately narrow (`git [-c/-C …] commit`); exotic
 * invocations slip the screen the same way exotic destructive commands do —
 * tripwire-grade, like the rest of the bash screens.
 */
const GIT_COMMIT_COMMAND = /\bgit(\s+(?:-c|-C)\s+(?:"[^"]*"|'[^']*'|\S+))*\s+commit\b/;
const PROVENANCE_TRAILERS = [/Qorpera-Trigger:\s*\S/, /Qorpera-Rationale:\s*\S/];

function commitMissingProvenance(command: string): boolean {
	if (!GIT_COMMIT_COMMAND.test(command)) return false;
	return !PROVENANCE_TRAILERS.every((trailer) => trailer.test(command));
}

/**
 * Blank the bodies of `-m`/`--message` arguments before the bash screens: a
 * commit message MENTIONING inbox/ or a product path is data, not a write —
 * provenance trailers legitimately reference inbox items, which gated every
 * routine commit (observed live, conception 2026-08-05). Bodies carrying
 * shell execution constructs ($(…), backticks, ${…}) are NOT blanked — a
 * substitution inside a quoted message still executes, so it stays visible
 * to the screens. Unterminated or escaped-quote bodies fail to match and
 * stay visible too. Err toward gating. The provenance check runs on the RAW
 * command — the trailers live in the message.
 */
function stripMessageArgs(command: string): string {
	return command.replace(
		/(\s(?:-m|--message)(?:=|\s+))("([^"]*)"|'([^']*)'|((?!["'])\S+))/g,
		(match, prefix: string, _body: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
			const body = doubleQuoted ?? singleQuoted ?? bare ?? "";
			return /\$\(|`|\$\{/.test(body) ? match : `${prefix}""`;
		},
	);
}

/**
 * Blank the path arguments of index-only git verbs (`git add`, `git commit`
 * pathspecs) before the mention screens: staging or committing a file READS
 * it into the index — it cannot modify inbox/, the kernel files, or product
 * content, so a path mention there is bookkeeping, not an effect (observed
 * live 2026-08-05: every wake that committed its own inbox records gated).
 * Three properties preserved: flags stay visible (`--amend` must still hit
 * the destructive screen), segments carrying execution constructs are never
 * stripped (a substitution in an argument executes), and worktree-WRITING
 * git verbs (checkout, restore, reset, rm, mv, clean, stash, apply) are
 * untouched — their mentions still screen. Segments end at connectors AND
 * newlines so a following command is never swallowed.
 */
function stripIndexSafeGitPaths(command: string): string {
	return command.replace(/\b(git\s+(?:add|commit)\b)([^|;&\n\r]*)/gi, (match, verb: string, args: string) => {
		if (/\$\(|`|\$\{/.test(args)) return match;
		const flags = args.match(/\s--?[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S+))?/g) ?? [];
		return verb + flags.join("");
	});
}

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
 * that BOTH mentions a product path AND looks mutating touches that zone.
 * Returns every declared product the command mentions — the scope grant needs
 * to know whether a command stays inside ONE zone. Heuristic by nature —
 * precise enforcement rides on the path-arg tools and engine patch approvals.
 */
function bashMentionedProducts(config: AuthorityConfig, command: string): string[] {
	if (config.productPaths.length === 0) return [];
	if (!WRITEISH_BASH.test(stripHarmlessRedirects(command))) return [];
	const mentioned: string[] = [];
	for (const productPath of config.productPaths) {
		const forward = productPath.replace(/\\/g, "/");
		const backward = forward.replace(/\//g, "\\");
		if (command.includes(forward) || command.includes(backward)) {
			mentioned.push(productPath);
			continue;
		}
		// Also match the zone's basename (`cd Qorpera_Desktop && git commit`).
		const base = forward.split("/").filter(Boolean).pop();
		if (base && command.includes(base)) mentioned.push(productPath);
	}
	return mentioned;
}

function bashTouchesProductWriteish(config: AuthorityConfig, command: string): boolean {
	return bashMentionedProducts(config, command).length > 0;
}

/**
 * The session's product scope, when the founder opened it scoped (spec: the
 * scope selector). The kernel is the only writer of QORPERA_SCOPE — it sets
 * the variable on the RPC child exactly when the founder confirmed the scope
 * in a kernel-owned dialog, so its presence IS the founder's approval for the
 * [products] zone it names. A value that does not match a declared product
 * path grants nothing (the ratified authority.toml stays the source of truth).
 */
export function grantedScope(config: AuthorityConfig): string | undefined {
	const raw = process.env.QORPERA_SCOPE;
	if (!raw) return undefined;
	const canonical = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
	return config.productPaths.find((path) => canonical(path) === canonical(raw));
}

/**
 * Does this products-classified effect fall ENTIRELY inside the granted
 * scope's zone? Path-arg tools answer precisely; bash answers via the same
 * mention screen that classified it — a command that also mentions another
 * product is not within scope and gates as usual.
 */
function effectWithinScope(
	authority: Authority,
	config: AuthorityConfig,
	toolName: string,
	args: unknown,
	cwd: string,
	scopePath: string,
): boolean {
	const pathArg = extractPathArg(args);
	if (pathArg && MUTATING_PATH_TOOLS.has(toolName)) {
		const scopeRoot = resolve(join(authority.root, scopePath));
		const resolved = resolveArgPath(pathArg, cwd);
		return resolved === scopeRoot || isUnderDir(resolved, scopeRoot);
	}
	if (toolName === "bash") {
		const command = bashCommandFromArgs(args);
		if (!command) return false;
		const screened = stripIndexSafeGitPaths(stripMessageArgs(command));
		const mentioned = bashMentionedProducts(config, screened);
		return mentioned.length > 0 && mentioned.every((path) => path === scopePath);
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
			// All three screens see the command with message bodies and
			// index-only git path args blanked — mentions there are data
			// and bookkeeping, not effects. Message strip runs first so a
			// blanked -m body can't hide constructs from the path strip.
			const screened = stripIndexSafeGitPaths(stripMessageArgs(command));
			if (bashTouchesProtected(screened)) return "authority";
			if (bashTouchesProductWriteish(config, screened)) return "products";
			if (overrideRaw === "none") return undefined;
			if (override) return override;
			if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(screened))) return "irreversible";
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
	// Founders resolve gates by editing status: in ANY editor — Windows
	// tools (Notepad, PowerShell 5.1 Set-Content -Encoding utf8) prepend a
	// BOM, which would silently hide the record and re-file the request
	// (hit live, 2026-08-05). Strip it before anchoring the frontmatter.
	const frontmatter = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
 * Resolve the signature status of the codified behavior behind a tool call.
 * Returns undefined when the path is synthetic, unreadable, or outside the
 * authority root (built-ins, SDK tools, user-global extensions — outside the
 * company's signature regime, mirroring extension-load gating's carve-out).
 *
 * Signatures are durable per content hash: approved (or consumed) covers
 * exactly that code, forever; any edit is a new hash and a new request. The
 * hash is computed from the file as it is NOW — with jiti hot-reload this
 * tracks what actually executes next; a stale in-memory registration from a
 * since-edited file resolves to the new (unsigned) content, which errs
 * toward gating.
 */
function resolveBehaviorSignature(
	authority: Authority,
	behaviorPath: string | undefined,
): BehaviorSignature | undefined {
	if (!behaviorPath) return undefined;
	const resolved = resolve(behaviorPath);
	if (!isUnderDir(resolved, authority.root)) return undefined;
	let contentHash: string;
	try {
		contentHash = createHash("sha256").update(readFileSync(resolved)).digest("hex");
	} catch {
		return undefined;
	}
	const path = relative(authority.root, resolved).split(sep).join("/");
	const records = findGateRecords(authority, requestHash("behavior_signature", { contentHash, path }));
	const signedRecord = records.find((record) => record.status === "approved" || record.status === "consumed");
	if (signedRecord) return { path, contentHash, signed: true, gateId: signedRecord.id };
	const pending = records.find((record) => record.status === "pending");
	if (pending) return { path, contentHash, signed: false, gateId: pending.id, gateStatus: "pending" };
	const denied = records.find((record) => record.status === "denied");
	if (denied) return { path, contentHash, signed: false, gateId: denied.id, gateStatus: "denied" };
	return { path, contentHash, signed: false };
}

/** Block an unattended outward effect from unsigned codified behavior, filing the signature request if new. */
function blockForUnsignedBehavior(
	authority: Authority,
	toolName: string,
	args: unknown,
	effectClass: EffectClass,
	behavior: BehaviorSignature,
): AuthorityDecision {
	if (behavior.gateStatus === "pending") {
		return {
			kind: "block",
			effectClass,
			gateId: behavior.gateId,
			behavior,
			reason: `Signature rule [${effectClass}]: ${behavior.path} is not signed for unattended outward action; signature request ${behavior.gateId} is awaiting the founder in inbox/. Continue with other work; retry after it is approved.`,
		};
	}
	if (behavior.gateStatus === "denied") {
		return {
			kind: "block",
			effectClass,
			gateId: behavior.gateId,
			behavior,
			reason: `Signature rule [${effectClass}]: the founder DECLINED to sign ${behavior.path} (request ${behavior.gateId}). Do not retry this action from this code; revise the code (a new version is a new signature request) or pursue another path.`,
		};
	}
	const gateId = writeGateRequest(authority, {
		toolName: "behavior_signature",
		effectClass,
		args: { contentHash: behavior.contentHash, path: behavior.path },
		hash: requestHash("behavior_signature", { contentHash: behavior.contentHash, path: behavior.path }),
		what: `sign ${behavior.path} (sha256 ${behavior.contentHash.slice(0, 12)}…) for unattended outward action — first triggered by: ${summarizeCall(toolName, args)}`,
	});
	const updated: BehaviorSignature = { ...behavior, gateId, gateStatus: "pending" };
	return {
		kind: "block",
		effectClass,
		gateId,
		behavior: updated,
		reason: `Signature rule [${effectClass}]: this action comes from company-authored code (${behavior.path}) running unattended, which requires a standing founder signature on that exact code. Signature request ${gateId} filed in inbox/ — once approved it is durable for this content (editing the file requires a new signature). NOW create inbox/msg-${gateId}-intent.md with your file-writing tool (NOT bash — bash writes into inbox/ are themselves gated): first line \`# <short outcome headline>\` naming what this code does for the company (never the mechanism), then 1-3 plain sentences for the founder covering what the code may do to the outside world once signed. Then continue with other work; retry after it is approved.`,
	};
}

/**
 * The main enforcement decision for a tool call. Single-use approvals: an
 * approved gate is consumed by the first matching call. Behavior signatures
 * (EVOLUTION.md §3) are durable and are checked before — and regardless of —
 * class modes.
 */
export function evaluateToolCall(
	authority: Authority,
	toolName: string,
	args: unknown,
	cwd: string,
	context?: ToolCallContext,
): AuthorityDecision {
	// Provenance rule (EVOLUTION.md §4 invariant 3): checked before
	// classification because a plain `git commit` is otherwise unclassified.
	// This is a message-format requirement, not a gate — no request is filed;
	// the agent retries with trailers.
	if (toolName === "bash") {
		const command = bashCommandFromArgs(args);
		if (command && commitMissingProvenance(command)) {
			return {
				kind: "block",
				effectClass: "authority",
				reason:
					"Provenance rule: every agent-authored commit ends its message with provenance trailers (EVOLUTION.md §4):\n\nQorpera-Trigger: <what prompted this change — founder request, routine, gate, observation>\nQorpera-Rationale: <why this change, one line>\n\nNo approval is needed — retry the commit with both trailers in the message.",
			};
		}
	}

	const config = readAuthorityConfig(authority);
	let effectClass = classifyToolCall(authority, config, toolName, args, cwd);
	if (!effectClass) return { kind: "allow" };

	// The scope grant (spec: the scope selector): a founder-scoped session is
	// pre-approved for ITS product zone — the founder's scope selection is the
	// approval, so per-write gates would be theater. Only the products class
	// relaxes, and only inside the granted zone: kernel files and the inbox
	// classified [authority] above, other products stay gated, and a
	// destructive command re-classifies as [irreversible] so scope never
	// grants history rewrites or force-pushes the founder didn't ask for.
	if (effectClass === "products") {
		const scope = grantedScope(config);
		if (scope && effectWithinScope(authority, config, toolName, args, cwd, scope)) {
			const command = toolName === "bash" ? bashCommandFromArgs(args) : undefined;
			const screened = command ? stripIndexSafeGitPaths(stripMessageArgs(command)) : undefined;
			if (screened && DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(screened))) {
				effectClass = "irreversible";
			} else {
				// Still resolved for the trail stamp: a scoped allow from
				// codified behavior records what code acted, same as any allow.
				return {
					kind: "allow",
					effectClass: "products",
					scoped: true,
					behavior: resolveBehaviorSignature(authority, context?.behaviorPath),
				};
			}
		}
	}

	// The signature rule: codified behavior taking an outward effect
	// unattended requires a standing founder signature on that behavior's
	// content hash. Checked regardless of class mode — auto-trust in a class
	// covers the model acting under founder direction, not agent-authored
	// code acting with nobody present. Attended calls fall through to the
	// normal per-action gates (presence is the intent source there).
	const behavior = resolveBehaviorSignature(authority, context?.behaviorPath);
	if (behavior && !behavior.signed && !context?.attended && OUTWARD_CLASSES.has(effectClass)) {
		return blockForUnsignedBehavior(authority, toolName, args, effectClass, behavior);
	}

	const mode = config.classes[effectClass].mode;
	if (mode === "auto") return { kind: "allow", effectClass, behavior };
	if (mode === "notify") {
		appendNotice(authority, `[${effectClass}] ${summarizeCall(toolName, args)} (auto-proceeded, notify mode)`);
		return { kind: "allow", notified: true, effectClass, behavior };
	}

	const hash = requestHash(toolName, args);
	const records = findGateRecords(authority, hash);
	const approved = records.find((record) => record.status === "approved");
	if (approved) {
		setGateStatus(approved, "consumed");
		appendNotice(authority, `[${effectClass}] ${approved.id} consumed: ${summarizeCall(toolName, args)}`);
		return { kind: "allow", notified: true, effectClass, behavior };
	}
	const pending = records.find((record) => record.status === "pending");
	if (pending) {
		return {
			kind: "block",
			effectClass,
			gateId: pending.id,
			behavior,
			reason: `Authority gate [${effectClass}]: request ${pending.id} is awaiting human approval in inbox/. Continue with other work; retry after it is approved.`,
		};
	}
	const denied = records.find((record) => record.status === "denied");
	if (denied) {
		return {
			kind: "block",
			effectClass,
			gateId: denied.id,
			behavior,
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
		behavior,
		reason: `Authority gate [${effectClass}]: this action requires human approval. Request ${gateId} filed in inbox/. NOW create inbox/msg-${gateId}-intent.md with your file-writing tool (NOT bash — bash writes into inbox/ are themselves gated): first line \`# <short outcome headline>\` naming what this achieves for the company (never the mechanism), then 1-3 plain sentences of context for the founder, no command syntax. Headline and text become the approval card; the exact command is shown separately. Then continue with other work; retry after it is approved.`,
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
