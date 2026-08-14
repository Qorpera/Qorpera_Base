/**
 * Authority gates — Qorpera Base's enforcement layer (spec §4).
 *
 * Full freedom in thought and construction; gates on effect. `authority.toml`
 * at the company root defines four configurable effect classes (money,
 * identity, irreversible, authority) with modes auto | notify | gate.
 * Product code is a separate role boundary: controllers can only read it;
 * product-workers can mutate only their assigned worktree. `[authority]` is
 * ALWAYS gated regardless of configuration — it covers changes to the
 * authority file itself, the kernel files (AGENTS.md / CLAUDE.md at the
 * root), and the inbox (so the agent cannot approve its own requests).
 *
 * Gate mechanics are async by design: a blocked effect files a request at
 * `<root>/inbox/gate-*.md` and returns a block reason; the agent keeps
 * working elsewhere. Base resolves the request through exact native review.
 * Tool-call approvals are single-use (consumed on the next matching call);
 * extension and behavior trust is durable in the desktop kernel for the
 * reviewed company path and content hash (new content = new hash = new gate).
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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { AUTHORITY_SIGNATURE_PATH, verifyAuthorityPolicy, verifyGateApproval } from "./founder-identity.ts";
import { requestKernelGateConsumption, requestKernelGateTrust } from "./kernel-broker.ts";
import { writeRawStdout } from "./output-guard.ts";
import { mcpServerConfigurationFingerprint } from "./tools/mcp-config.ts";

export type ConfigurableEffectClass = "money" | "identity" | "irreversible" | "authority";
export type EffectClass = ConfigurableEffectClass | "product_code";
export type CompanyActor = "controller" | "product-worker";
export type AuthorityMode = "auto" | "notify" | "gate";

export interface AuthorityClassConfig {
	mode: AuthorityMode;
	limitUsd?: number;
}

export interface AuthorityConfig {
	classes: Record<ConfigurableEffectClass, AuthorityClassConfig>;
	/** Per-tool overrides from `[tools]`: tool name -> effect class or "none". */
	tools: Record<string, ConfigurableEffectClass | "none">;
}

export interface Authority {
	/** Directory containing authority.toml — the company root. */
	root: string;
	configPath: string;
}

export type AuthorityDecision =
	| {
			kind: "allow";
			notified?: true;
			effectClass?: EffectClass;
			attended?: true;
			actor?: CompanyActor;
			behavior?: BehaviorSignature;
			gateId?: string;
			mcpConfigurationHash?: string;
			kernelGate?: { file: string; hash: string; id: string; effectClass: EffectClass };
	  }
	| { kind: "block"; reason: string; effectClass: EffectClass; gateId?: string; behavior?: BehaviorSignature };

/**
 * Caller-supplied context for the signature rule (EVOLUTION.md §3).
 * The "one new input" of EVOLUTION §9.1.
 */
export interface ToolCallContext {
	/**
	 * True when a founder is present with approval-capable UI (tui/rpc modes)
	 * AND the session is not controller-initiated: kernel-spawned autonomous
	 * work (conception, merges, wakes) carries QORPERA_AUTONOMOUS and is never
	 * attended even though it runs in rpc mode. Headless runs (print/json/SDK)
	 * are unattended. Attended sessions are founder sessions: the founder's
	 * direction is the intent source for outward effects. Product-code writes
	 * remain role-scoped regardless of attendance.
	 */
	attended: boolean;
	/** Kernel-assigned organizational role. Missing means company controller. */
	actor?: CompanyActor;
	/** Root-relative worktree assigned by the product-development runtime. */
	productWorktree?: string;
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
	/** Durable approval awaiting proof from the live local desktop kernel. */
	kernelTrust?: { file: string; hash: string };
}

export type GateStatus = "pending" | "approved" | "denied" | "consumed";

export interface GateRecord {
	id: string;
	status: GateStatus;
	hash: string;
	filePath: string;
	content: string;
	/** Founder signature over (id, hash), present once signed approvals are in use. */
	approval?: string;
}

/**
 * The company-tool runner (Build 2): executes company-authored programs as
 * clean-environment subprocesses. For this tool the acting behavior is the
 * PROGRAM being run, not the runner itself — behaviorPath derives from the
 * call's path argument so the signature rule covers the program's content
 * hash, and the behavior stamp lands in the trail even for auto-class runs.
 */
export const COMPANY_TOOL_NAME = "run_company_tool";

/**
 * The kernel HTTP lane (Build 3). Outbound contact defaults to the
 * [identity] class — acting toward the outside world as the company —
 * unless the founder overrides it in [tools] (including "none"). The
 * destination allowlist and secret dereferencing are enforced kernel-side
 * regardless of this classification.
 */
export const HTTP_TOOL_NAME = "http_request";

/**
 * The MCP gateway can spawn agent-configured host processes and invoke
 * arbitrary external capabilities whose effect cannot be inferred from the
 * gateway's generic arguments. It therefore defaults to the always-gated
 * [authority] class until the founder explicitly classifies or disables it
 * through [tools].
 */
export const MCP_TOOL_NAME = "use_mcp_tool";

const CONFIGURABLE_EFFECT_CLASSES: ConfigurableEffectClass[] = ["money", "identity", "irreversible", "authority"];
/**
 * Classes whose effects touch the world outside the company folder — the
 * signature rule applies to these. [authority] and product_code are
 * spine/role protection with their own stricter semantics.
 */
const OUTWARD_CLASSES: ReadonlySet<EffectClass> = new Set(["money", "identity", "irreversible"]);
/** Path-arg zone checks apply only to tools that mutate the path. */
const MUTATING_PATH_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit"]);
const AUTHORITY_FILE = "authority.toml";
const INBOX_DIR = "inbox";
/** Root-level files whose modification is an [authority]-class effect. */
const PROTECTED_ROOT_FILES = new Set([AUTHORITY_FILE, "AGENTS.md", "CLAUDE.md"]);
const PRODUCT_REGISTRY_PATH = join(".qorpera", "products.json");
const GATE_FIELDS = ["id", "status", "class", "tool", "hash", "created"] as const;
/** Founder-signature over (id, hash), written at approval time. */
const OPTIONAL_GATE_FIELDS = ["approval"] as const;

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
		},
		tools: {},
	};
	// Policy provenance (manifesto §3.1, invariant 15): once a founder
	// identity exists in this context, only policy the LOCAL founder signed
	// grants auto/notify modes — unsigned, tampered, or foreign-signed
	// policy fails closed to everything-gated, exactly like malformed toml.
	// Machines without a founder identity keep legacy semantics.
	const provenance = verifyAuthorityPolicy(authority.root);
	if (provenance !== "no-identity" && provenance !== "valid") return fallback;
	let raw: Record<string, unknown>;
	try {
		raw = parseToml(readFileSync(authority.configPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return fallback;
	}

	const config: AuthorityConfig = { classes: { ...fallback.classes }, tools: {} };
	for (const effectClass of CONFIGURABLE_EFFECT_CLASSES) {
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
			if (
				value === "none" ||
				(typeof value === "string" && (CONFIGURABLE_EFFECT_CLASSES as string[]).includes(value))
			) {
				config.tools[name] = value as ConfigurableEffectClass | "none";
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
		const messagesDir = resolve(inboxDirPath, "messages");
		const isDirectChild = dirname(resolved) === messagesDir;
		const isAgentMessage = /^msg-[a-z0-9][a-z0-9-]*\.md$/i.test(basename(resolved));
		return !(isDirectChild && isAgentMessage);
	}
	if (dirname(resolved) === resolve(authority.root) && PROTECTED_ROOT_FILES.has(basename(resolved))) return true;
	if (resolved === resolve(authority.root, PRODUCT_REGISTRY_PATH)) return true;
	if (resolved === resolve(authority.root, AUTHORITY_SIGNATURE_PATH)) return true;
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
	/(>>?|\btee\b|\bmv\b|\bcp\b|\brm\b|\brmdir\b|\bdel\b|\bsed\s+-i\b|\btouch\b|\bln\b|\bchmod\b|\bset-content\b|\badd-content\b|\bout-file\b|\bgit\s+(commit|push|checkout|switch|restore|reset|rebase|merge|apply|cherry-pick|clean|rm|mv|stash|tag)\b|\bgh\s+pr\s+(create|edit|close|merge|reopen|review)\b|\bnpm\s+(install|uninstall|update|version|publish)\b)/i;

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
	if (/\.qorpera[/\\]products\.json/i.test(stripped)) return true;
	if (/\b(AGENTS|CLAUDE)\.md\b/i.test(stripped)) return true;
	return false;
}

function resolveArgPath(rawPath: string, cwd: string): string {
	return resolve(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
}

function productCodeKind(authority: Authority, resolvedPath: string): "repository" | "worktree" | undefined {
	const rel = relative(authority.root, resolvedPath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	const parts = rel.split(sep);
	if (parts[0] !== "departments" || !parts[1]?.endsWith("-development")) return undefined;
	if (parts[2] === "repository") return "repository";
	if (parts[2] === "worktrees" && parts.length >= 4) return "worktree";
	return undefined;
}

/** Product-code shell screen: study is free; mutations from or naming code roots are classified. */
function bashTouchesProductCode(authority: Authority, command: string, cwd: string): boolean {
	if (!WRITEISH_BASH.test(stripHarmlessRedirects(command))) return false;
	if (productCodeKind(authority, resolve(cwd))) return true;
	if (/(?:departments[/\\])?[^/\\\s]+-development[/\\](?:repository|worktrees)(?:[/\\]|\b)/i.test(command)) {
		return true;
	}
	const cwdRel = relative(authority.root, resolve(cwd)).split(sep);
	return (
		cwdRel[0] === "departments" &&
		cwdRel[1]?.endsWith("-development") &&
		/\b(?:repository|worktrees)[/\\]/i.test(command)
	);
}

const WORKTREE_ESCAPE_BASH =
	/\b(?:cd|pushd|set-location)\s+\.\.(?:[/\\]|\s|$)|\bgit\s+(?:-C|--git-dir|--work-tree|worktree)\b|\.\.[/\\].*(?:>|\b(?:mv|cp|rm|touch|tee)\b)/i;

function assignedProductWorktree(authority: Authority, context: ToolCallContext | undefined): string | undefined {
	if (context?.actor !== "product-worker" || !context.productWorktree) return undefined;
	const worktree = resolve(join(authority.root, context.productWorktree));
	return productCodeKind(authority, worktree) === "worktree" ? worktree : undefined;
}

function productWorkerMutationAllowed(
	authority: Authority,
	toolName: string,
	args: unknown,
	cwd: string,
	context: ToolCallContext | undefined,
): boolean {
	const worktree = assignedProductWorktree(authority, context);
	if (!worktree) return false;
	const pathArg = extractPathArg(args);
	if (pathArg && MUTATING_PATH_TOOLS.has(toolName)) {
		const target = resolveArgPath(pathArg, cwd);
		return target === worktree || isUnderDir(target, worktree);
	}
	if (toolName !== "bash") return false;
	const command = bashCommandFromArgs(args);
	if (!command || WORKTREE_ESCAPE_BASH.test(command)) return false;
	const resolvedCwd = resolve(cwd);
	return resolvedCwd === worktree || isUnderDir(resolvedCwd, worktree);
}

function isMutatingCall(toolName: string, args: unknown): boolean {
	if (MUTATING_PATH_TOOLS.has(toolName)) return true;
	if (toolName !== "bash") return false;
	const command = bashCommandFromArgs(args);
	return Boolean(command && WRITEISH_BASH.test(stripHarmlessRedirects(command)));
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
	// Protected boundaries rank ABOVE [tools] overrides (including "none").
	// They apply only to mutating tools — reading/study is free.
	const pathArg = extractPathArg(args);
	if (pathArg && MUTATING_PATH_TOOLS.has(toolName)) {
		const resolved = resolveArgPath(pathArg, cwd);
		if (isProtectedPath(authority, pathArg, cwd)) return "authority";
		if (productCodeKind(authority, resolved)) return "product_code";
	}

	const overrideRaw = config.tools[toolName];
	const override: ConfigurableEffectClass | undefined = overrideRaw === "none" ? undefined : overrideRaw;

	if (toolName === "bash") {
		const command = bashCommandFromArgs(args);
		if (command) {
			// All three screens see the command with message bodies and
			// index-only git path args blanked — mentions there are data
			// and bookkeeping, not effects. Message strip runs first so a
			// blanked -m body can't hide constructs from the path strip.
			const screened = stripIndexSafeGitPaths(stripMessageArgs(command));
			if (bashTouchesProtected(screened)) return "authority";
			if (bashTouchesProductCode(authority, screened, cwd)) return "product_code";
			if (overrideRaw === "none") return undefined;
			if (override) return override;
			if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(screened))) return "irreversible";
		}
		// A host shell can hide any external effect behind an otherwise unknown
		// executable or interpreter. Keep the specific screens above for richer
		// classes, but fail closed for every unclassified command until the
		// founder explicitly assigns bash a narrower class or opts it out.
		return override ?? "authority";
	}

	if (overrideRaw === "none") return undefined;
	if (toolName === MCP_TOOL_NAME) return override ?? "authority";
	if (toolName === HTTP_TOOL_NAME) return override ?? "identity";
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

const MCP_BINDING_TTL_MS = 60_000;
const mcpExecutionBindings = new Map<string, Array<{ configurationHash: string; expiresAt: number }>>();

function mcpServerName(args: unknown): string {
	if (!args || typeof args !== "object" || Array.isArray(args)) return "";
	const server = (args as Record<string, unknown>).server;
	return typeof server === "string" ? server : "";
}

function mcpGateArgs(args: unknown, configurationHash: string | undefined): unknown {
	if (!configurationHash) return args;
	const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
	return { ...record, serverConfigurationSha256: configurationHash };
}

function mcpBindingKey(authority: Authority, args: unknown): string {
	return `${resolve(authority.root)}\u0000${requestHash(MCP_TOOL_NAME, args)}`;
}

function registerMcpExecutionBinding(authority: Authority, args: unknown, configurationHash: string): void {
	const key = mcpBindingKey(authority, args);
	const now = Date.now();
	const queue = (mcpExecutionBindings.get(key) ?? []).filter((entry) => entry.expiresAt > now);
	queue.push({ configurationHash, expiresAt: now + MCP_BINDING_TTL_MS });
	mcpExecutionBindings.set(key, queue);
}

/** Consume the authority hook's one-shot binding immediately before MCP execution. */
export function consumeMcpExecutionBinding(authority: Authority, args: unknown): string | undefined {
	const key = mcpBindingKey(authority, args);
	const now = Date.now();
	const queue = (mcpExecutionBindings.get(key) ?? []).filter((entry) => entry.expiresAt > now);
	const binding = queue.shift();
	if (queue.length > 0) mcpExecutionBindings.set(key, queue);
	else mcpExecutionBindings.delete(key);
	return binding?.configurationHash;
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
	// Strip a possible BOM before anchoring the canonical frontmatter. The
	// file is evidence only; Base's native kernel review mints authority.
	const frontmatter = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!frontmatter) return undefined;
	const fields = new Map<string, string>();
	for (const line of frontmatter[1].split(/\r?\n/)) {
		const match = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (
			!match ||
			(!GATE_FIELDS.includes(match[1] as (typeof GATE_FIELDS)[number]) &&
				!OPTIONAL_GATE_FIELDS.includes(match[1] as (typeof OPTIONAL_GATE_FIELDS)[number])) ||
			fields.has(match[1])
		) {
			return undefined;
		}
		fields.set(match[1], match[2].split("#")[0].trim());
	}
	if (GATE_FIELDS.some((field) => !fields.has(field))) return undefined;
	const id = fields.get("id");
	const status = fields.get("status") as GateStatus | undefined;
	const hash = fields.get("hash");
	if (!id || !status || !hash || `${id}.md` !== basename(filePath)) return undefined;
	if (!/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
	if (!["pending", "approved", "denied", "consumed"].includes(status)) return undefined;
	if (
		!CONFIGURABLE_EFFECT_CLASSES.includes(fields.get("class") as ConfigurableEffectClass) &&
		fields.get("class") !== "product_code"
	) {
		return undefined;
	}
	if (!fields.get("tool") || !fields.get("created")) return undefined;
	const approval = fields.get("approval");
	return {
		id,
		status,
		hash,
		filePath,
		content: content.replace(/^\uFEFF/, ""),
		...(approval ? { approval } : {}),
	};
}

/**
 * Is this approved/consumed record a REAL founder approval? Without a
 * founder identity, a status edit is the approval (legacy). With one, only
 * records carrying the local founder's signature over (id, hash) count \u2014
 * an unsigned or foreign-signed "approved" line is treated as still
 * pending, never as authority (manifesto \u00A73.2: a founder response that is
 * merely a file edit is data, not authority).
 */
function gateApprovalValid(record: GateRecord): boolean {
	const provenance = verifyGateApproval(record.id, record.hash, record.approval);
	return provenance === "no-identity" || provenance === "valid";
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
	const lines = record.content.split(/\r?\n/);
	const statusLines = lines.flatMap((line, index) => (/^status:\s*/.test(line) ? [index] : []));
	if (statusLines.length !== 1) throw new Error("gate status transition requires exactly one canonical status field");
	lines[statusLines[0]] = `status: ${status}`;
	const content = `${lines.join("\n")}${record.content.endsWith("\n") ? "\n" : ""}`;
	const temporary = `${record.filePath}.${process.pid}-${Date.now()}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, record.filePath);
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
		"status: pending   # resolved by Qorpera Base native review",
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
		"Resolve this request through Qorpera Base's native review UI.",
		"",
	].join("\n");
	const brokerToken = process.env.QORPERA_TRAIL_BROKER_TOKEN;
	if (brokerToken) {
		// Raw writer: the rpc output guard redirects plain stdout to stderr.
		writeRawStdout(
			`${JSON.stringify({
				type: "qorpera_kernel_write",
				token: brokerToken,
				operation: "create_gate",
				gate: {
					id,
					file: fileName,
					effectClass: input.effectClass,
					toolName: input.toolName,
					hash: input.hash,
					args: input.args,
				},
			})}\n`,
		);
	} else {
		writeFileSync(join(dir, fileName), body, "utf-8");
	}
	return id;
}

function appendNotice(authority: Authority, message: string): void {
	const brokerToken = process.env.QORPERA_TRAIL_BROKER_TOKEN;
	if (brokerToken) {
		writeRawStdout(
			`${JSON.stringify({
				type: "qorpera_kernel_write",
				token: brokerToken,
				operation: "append_notice",
				message,
			})}\n`,
		);
		return;
	}
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
 * Signatures are durable in the path-scoped desktop kernel: a native-reviewed
 * capability covers exactly that company path and content hash across child
 * replacement, while copied company files carry no authority. The
 * hash is computed from the file as it is NOW — with jiti hot-reload this
 * tracks what actually executes next; a stale in-memory registration from a
 * since-edited file resolves to the new (unsigned) content, which errs
 * toward gating.
 */
/**
 * The acting code behind a tool call. For the company-tool runner the
 * behavior is the program named by the call's path argument (resolved
 * against cwd); for everything else it is the source file that registered
 * the tool, as supplied by the caller.
 */
function effectiveBehaviorPath(
	toolName: string,
	args: unknown,
	cwd: string,
	context: ToolCallContext | undefined,
): string | undefined {
	if (toolName === COMPANY_TOOL_NAME) {
		const pathArg = extractPathArg(args);
		return pathArg ? resolveArgPath(pathArg, cwd) : undefined;
	}
	return context?.behaviorPath;
}

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
	const hash = requestHash("behavior_signature", { contentHash, path });
	const records = findGateRecords(authority, hash);
	const approved = records.find((record) => record.status === "approved" && gateApprovalValid(record));
	if (approved) {
		return {
			path,
			contentHash,
			signed: false,
			gateId: approved.id,
			kernelTrust: { file: basename(approved.filePath), hash: approved.hash },
		};
	}
	const pending = records.find((record) => record.status === "pending");
	if (pending) return { path, contentHash, signed: false, gateId: pending.id, gateStatus: "pending" };
	const denied = records.find((record) => record.status === "denied");
	if (denied) return { path, contentHash, signed: false, gateId: denied.id, gateStatus: "denied" };
	const consumed = records.find((record) => record.status === "consumed" && gateApprovalValid(record));
	if (consumed) {
		return {
			path,
			contentHash,
			signed: false,
			gateId: consumed.id,
			kernelTrust: { file: basename(consumed.filePath), hash: consumed.hash },
		};
	}
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
		reason: `Signature rule [${effectClass}]: this action comes from company-authored code (${behavior.path}) running unattended, which requires a standing founder signature on that exact code. Signature request ${gateId} filed in inbox/ — once approved it is durable for this content (editing the file requires a new signature). NOW create inbox/messages/msg-${gateId}-intent.md with your file-writing tool (NOT bash — bash writes into inbox/ are themselves gated): first line \`# <short outcome headline>\` naming what this code does for the company (never the mechanism), then 1-3 plain sentences for the founder covering what the code may do to the outside world once signed. Then continue with other work; retry after it is approved.`,
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
	if (
		context?.actor === "product-worker" &&
		isMutatingCall(toolName, args) &&
		!productWorkerMutationAllowed(authority, toolName, args, cwd, context)
	) {
		return {
			kind: "block",
			effectClass: "product_code",
			reason:
				"Product-worker boundary: this actor may modify only its kernel-assigned worktree. Continue inside that worktree or return the task to the controller for reassignment; this boundary cannot be approved away.",
		};
	}

	// Kernel policy boundary (Build 2): when a mutating tool precisely
	// targets kernel-owned territory, block WITHOUT filing a gate — the
	// desktop kernel's sandbox mounts these paths read-only for the agent,
	// so an approval could never execute. Filing one would be noise that
	// looks actionable. The working lanes are named in the reason instead.
	// (Bash mention-based screens stay on the ordinary gate path: the target
	// is imprecise there.)
	{
		const pathArg = extractPathArg(args);
		if (pathArg && MUTATING_PATH_TOOLS.has(toolName) && isProtectedPath(authority, pathArg, cwd)) {
			const resolved = resolveArgPath(pathArg, cwd);
			const isPolicyFile =
				(dirname(resolved) === resolve(authority.root) && PROTECTED_ROOT_FILES.has(basename(resolved))) ||
				resolved === resolve(authority.root, PRODUCT_REGISTRY_PATH);
			return {
				kind: "block",
				effectClass: "authority",
				reason: isPolicyFile
					? `Kernel policy boundary: ${basename(resolved)} is founder-ratified and read-only to you at the OS layer — an approval could not execute, so none is filed. Propose the change instead: write inbox/messages/msg-<slug>.md describing the exact edit and why; the founder applies it from the app (Settings → Authority).`
					: "Kernel policy boundary: inbox gate records and notices are kernel territory and read-only to you at the OS layer — writing them is self-approval and cannot be approved away. Author inbox/messages/msg-*.md items instead; that is your one sanctioned inbox lane.",
			};
		}
	}

	const config = readAuthorityConfig(authority);
	const mcpConfigurationHash =
		toolName === MCP_TOOL_NAME ? mcpServerConfigurationFingerprint(authority.root, mcpServerName(args)) : undefined;
	const gatedArgs = mcpGateArgs(args, mcpConfigurationHash);
	let effectClass = classifyToolCall(authority, config, toolName, args, cwd);
	if (!effectClass) {
		// Company-tool runs stamp behavior identity even when unclassified:
		// the trail must attribute every execution of company-authored code.
		if (toolName === COMPANY_TOOL_NAME) {
			return {
				kind: "allow",
				behavior: resolveBehaviorSignature(authority, effectiveBehaviorPath(toolName, args, cwd, context)),
			};
		}
		return { kind: "allow", ...(mcpConfigurationHash ? { mcpConfigurationHash } : {}) };
	}

	// Product code is a role boundary, not an approval mode. A controller is
	// read-only even when a founder is present; implementation happens in a
	// kernel-assigned product-worker worktree. A product-worker's destructive
	// commands still re-classify and hit the ordinary irreversible gate.
	if (effectClass === "product_code") {
		if (context?.actor !== "product-worker") {
			return {
				kind: "block",
				effectClass,
				reason:
					"Product-development boundary: the company controller may read product code but cannot modify repositories or worktrees. Delegate the task through the product department's Chat; this boundary cannot be approved away.",
			};
		}
		if (!productWorkerMutationAllowed(authority, toolName, args, cwd, context)) {
			return {
				kind: "block",
				effectClass,
				reason:
					"Product-worker boundary: this mutation is outside the assigned worktree and cannot be approved away.",
			};
		}
		const command = toolName === "bash" ? bashCommandFromArgs(args) : undefined;
		const screened = command ? stripIndexSafeGitPaths(stripMessageArgs(command)) : undefined;
		if (
			screened &&
			(DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(screened)) ||
				/\bgh\s+pr\s+(?:merge|close)\b/i.test(screened))
		) {
			effectClass = "irreversible";
		} else {
			return {
				kind: "allow",
				effectClass: "product_code",
				actor: "product-worker",
				behavior: resolveBehaviorSignature(authority, effectiveBehaviorPath(toolName, args, cwd, context)),
			};
		}
	}

	// The signature rule: codified behavior taking an outward effect
	// unattended requires a standing founder signature on that behavior's
	// content hash. Checked regardless of class mode — auto-trust in a class
	// covers the model acting under founder direction, not agent-authored
	// code acting with nobody present. Attended calls fall through to the
	// normal per-action gates (presence is the intent source there).
	const behavior = resolveBehaviorSignature(authority, effectiveBehaviorPath(toolName, args, cwd, context));
	if (
		behavior &&
		!behavior.signed &&
		!behavior.kernelTrust &&
		!context?.attended &&
		OUTWARD_CLASSES.has(effectClass)
	) {
		return blockForUnsignedBehavior(authority, toolName, args, effectClass, behavior);
	}

	const mode = config.classes[effectClass].mode;
	if (mode === "auto") {
		return { kind: "allow", effectClass, behavior, ...(mcpConfigurationHash ? { mcpConfigurationHash } : {}) };
	}
	if (mode === "notify") {
		appendNotice(authority, `[${effectClass}] ${summarizeCall(toolName, args)} (auto-proceeded, notify mode)`);
		return {
			kind: "allow",
			notified: true,
			effectClass,
			behavior,
			...(mcpConfigurationHash ? { mcpConfigurationHash } : {}),
		};
	}

	const hash = requestHash(toolName, gatedArgs);
	const records = findGateRecords(authority, hash);
	const approved = records.find((record) => record.status === "approved" && gateApprovalValid(record));
	if (approved) {
		if (process.env.QORPERA_TRAIL_BROKER_TOKEN) {
			return {
				kind: "allow",
				notified: true,
				effectClass,
				behavior,
				...(mcpConfigurationHash ? { mcpConfigurationHash } : {}),
				kernelGate: { file: basename(approved.filePath), hash, id: approved.id, effectClass },
			};
		}
		setGateStatus(approved, "consumed");
		appendNotice(authority, `[${effectClass}] ${approved.id} consumed: ${summarizeCall(toolName, args)}`);
		return {
			kind: "allow",
			notified: true,
			effectClass,
			behavior,
			...(mcpConfigurationHash ? { mcpConfigurationHash } : {}),
		};
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
			reason: `Authority gate [${effectClass}]: request ${denied.id} was DENIED by the founder. Do not retry this action; pursue another path unless the founder reopens it for native review.`,
		};
	}
	const gateId = writeGateRequest(authority, {
		toolName,
		effectClass,
		args: gatedArgs,
		hash,
		what: summarizeCall(toolName, args),
	});
	return {
		kind: "block",
		effectClass,
		gateId,
		behavior,
		reason: `Authority gate [${effectClass}]: this action requires human approval. Request ${gateId} filed in inbox/. NOW create inbox/messages/msg-${gateId}-intent.md with your file-writing tool (NOT bash — bash writes into inbox/ are themselves gated): first line \`# <short outcome headline>\` naming what this achieves for the company (never the mechanism), then 1-3 plain sentences of context for the founder, no command syntax. Headline and text become the approval card; the exact command is shown separately. Then continue with other work; retry after it is approved.`,
	};
}

/** Complete a brokered single-use approval before the tool is allowed to execute. */
export async function finalizeAuthorityDecision(
	authority: Authority,
	decision: AuthorityDecision,
	toolName: string,
	args: unknown,
): Promise<AuthorityDecision> {
	if (decision.kind !== "allow") return decision;
	let finalized = decision;
	if (toolName === MCP_TOOL_NAME) {
		const currentHash = mcpServerConfigurationFingerprint(authority.root, mcpServerName(args));
		if (!finalized.mcpConfigurationHash || finalized.mcpConfigurationHash !== currentHash) {
			return {
				kind: "block",
				effectClass: finalized.effectClass ?? "authority",
				reason:
					"MCP authority binding: the selected server configuration changed after policy evaluation. Retry the call so the current configuration is reviewed before any server starts.",
			};
		}
	}
	if (finalized.behavior?.kernelTrust) {
		const trust = finalized.behavior.kernelTrust;
		const granted = await requestKernelGateTrust(trust.file, trust.hash);
		if (!granted) {
			return {
				kind: "block",
				effectClass: finalized.effectClass ?? "authority",
				gateId: finalized.behavior.gateId,
				behavior: { ...finalized.behavior, signed: false, kernelTrust: undefined },
				reason: `Signature rule: ${finalized.behavior.path} has no live local kernel trust. Review its signature request again in Base.`,
			};
		}
		finalized = {
			...finalized,
			behavior: { ...finalized.behavior, signed: true, kernelTrust: undefined },
		};
	}
	if (!finalized.kernelGate) {
		if (toolName === MCP_TOOL_NAME && finalized.mcpConfigurationHash) {
			registerMcpExecutionBinding(authority, args, finalized.mcpConfigurationHash);
		}
		return finalized;
	}
	const gate = finalized.kernelGate;
	const granted = await requestKernelGateConsumption(gate.file, gate.hash);
	if (!granted) {
		return {
			kind: "block",
			effectClass: gate.effectClass,
			gateId: gate.id,
			behavior: finalized.behavior,
			reason: `Authority gate [${gate.effectClass}]: ${gate.id} was already consumed or is no longer approved. Request a fresh approval before retrying.`,
		};
	}
	appendNotice(authority, `[${gate.effectClass}] ${gate.id} consumed: ${summarizeCall(toolName, args)}`);
	const { kernelGate: _kernelGate, ...completed } = finalized;
	if (toolName === MCP_TOOL_NAME && completed.mcpConfigurationHash) {
		registerMcpExecutionBinding(authority, args, completed.mcpConfigurationHash);
	}
	return { ...completed, gateId: gate.id };
}

/**
 * Extension-load gating. Project-local extensions under the authority root
 * are agent-authorable code that runs with full user permissions (see
 * SEAMS.md c.3) — loading one is an [authority]-class effect. Approvals are
 * durable per company path and content hash in the desktop kernel. Native
 * review establishes trust for that exact code; changed content requires
 * fresh trust and the founder may revoke existing trust from the inbox.
 */
export async function filterExtensionPaths(
	authority: Authority,
	paths: string[],
	agentDir: string,
): Promise<{ allowed: string[]; blocked: Array<{ path: string; gateId: string; pending: boolean }> }> {
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
		const approved = records.find((record) => record.status === "approved" && gateApprovalValid(record));
		if (approved) {
			if (await requestKernelGateTrust(basename(approved.filePath), approved.hash)) allowed.push(path);
			else blocked.push({ path, gateId: approved.id, pending: true });
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
		const consumed = records.find((record) => record.status === "consumed" && gateApprovalValid(record));
		if (consumed) {
			if (await requestKernelGateTrust(basename(consumed.filePath), consumed.hash)) allowed.push(path);
			else blocked.push({ path, gateId: consumed.id, pending: true });
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
