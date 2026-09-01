/**
 * Trusted local read/action backend for the fixed company shell.
 *
 * Agent artifacts are read from `agents/<id>/artifacts/`; shared work lives
 * under `files/`. Company files cannot provide shell code or navigation. The
 * server is not a standalone launcher: only the desktop host creates it and
 * retains its mutation credential.
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
import { parse as parseToml } from "smol-toml";
import { discoverAuthority } from "./authority.ts";
import { canonicalCompanyRoot, listProductDepartments, readCompanyManifest } from "./company.ts";
import type { CompanyArtifactRecord } from "./company-artifacts.ts";
import {
	DEFAULT_SCHEDULED_JOB_ID,
	DEFAULT_SCHEDULED_JOB_TITLE,
	type RoutinePlacement,
	type RoutineTrigger,
	type ScheduledJobEffort,
} from "./company-connections.ts";
import type { CompanyConnectorManifestRecord } from "./company-connectors.ts";
import {
	COMPANY_POLICY_KEYS,
	isCompanyPolicyMode,
	parseCompanyPolicy,
	readCompanyPolicy,
	updateCompanyPolicySource,
} from "./company-policy.ts";
import type { CompanyRoom } from "./company-rooms.ts";
import type { StaffAgent, StaffAgentMessage } from "./company-staff.ts";
import {
	readFounderIdentity,
	signAuthorityPolicy,
	signGateApproval,
	verifyAuthorityPolicy,
} from "./founder-identity.ts";
import { isPublicSessionGroup, isPublicSessionRuntime, publicSessionRuntimeSnapshot } from "./session-visibility.ts";
import { FIXED_SHELL_NAVIGATION, type ShellNavigationState } from "./shell-navigation.ts";
import { readUsageRateCatalog, type UsageRateCatalog } from "./usage-pricing.ts";
import { companyUsageWindowError, readCompanyUsage } from "./usage-summary.ts";

export interface CompanyOrganizationHierarchyNodeView {
	id: string;
	kind: "cofounder" | "responsibility" | "project" | "room" | "agent";
	label: string;
	status: string;
	role?: string;
	canonicalId: string;
	children: CompanyOrganizationHierarchyNodeView[];
}

export interface CompanyOrganizationHierarchyView {
	schema: "qorpera.company-organization-hierarchy/v1";
	profileId: string;
	formationState: string;
	primary: CompanyOrganizationHierarchyNodeView[];
	inactive: CompanyOrganizationHierarchyNodeView[];
}

export interface CompanyAppOptions {
	root: string;
	port?: number;
	/** This root contains display projections only, never the live Company File.
	 * File reads, edits and approvals must use the authenticated cloud gateway. */
	governedCompanyFile?: boolean;
	/** Host-owned static shell served on the same local origin as its read models. */
	fixedShell?: { directory: string };
	/**
	 * Required on every MUTATING endpoint (gate resolution, inbox responses,
	 * authority edits) via the x-qorpera-token header. The backend listens on
	 * localhost, which the agent can reach with curl — without this token the
	 * agent could approve its own gates. The desktop host holds the token;
	 * renderer never receives it.
	 */
	authToken: string;
	/** Optional pricing source override for deterministic embedding and tests. */
	usageRateCatalog?: () => Promise<UsageRateCatalog>;
	/** Host-owned session lifecycle read model. Provider processes are
	 * temporary attachments. */
	sessionRuntime?: SessionRuntimeSource;
	/** Company-folder staff registry read through the desktop host. */
	staffReadModel?: () => readonly StaffAgent[];
	/** Company-folder multi-staff room registry read through the desktop host. */
	roomReadModel?: () => readonly CompanyRoom[];
	/** Agent-owned, ordinary company artifacts validated before display. */
	artifactReadModel?: () => readonly CompanyArtifactRecord[];
	/** Agent-built connector recipes discovered from ordinary company files.
	 * Authentication endpoints, client ids, and secret references are withheld
	 * from the renderer read model. */
	connectorReadModel?: () => readonly CompanyConnectorManifestRecord[];
	/** Founder-authorized definition edit. The desktop host owns persistence
	 * and reconstruction bookkeeping; this server only validates the token and body. */
	artifactUpdateModel?: (id: string, update: unknown) => CompanyArtifactRecord;
	/** Machine-local connection requests already stripped of credentials by
	 * the desktop host. The app server applies its own field allowlist too. */
	connectionRequestReadModel?: () => readonly CompanyConnectionRequestView[];
	/** Machine-local recurring work definitions. Dynamic run state remains a
	 * desktop concern; this view carries only the safe durable definition. */
	scheduledJobReadModel?: () => readonly CompanyScheduledJobView[];
	/** Durable agent-to-agent mail from the host-protected company ledger. */
	staffMessageReadModel?: () => readonly StaffAgentMessage[];
	/** Semantic company hierarchy projected from canonical Company File state.
	 * The app server strips it to this closed renderer view. */
	organizationReadModel?: () => CompanyOrganizationHierarchyView | undefined;
}

export type CompanyConnectionRequestStatus = "pending" | "connecting" | "connected" | "denied" | "failed" | "cancelled";
export type CompanyConnectionIntentPhase =
	| "suggested"
	| "selected"
	| "preparing"
	| "awaiting_setup"
	| "awaiting_auth"
	| "verifying"
	| "connected"
	| "syncing"
	| "ready"
	| "failed"
	| "denied"
	| "cancelled";

export interface CompanyConnectionRequestView {
	id: string;
	staffAgentId: string;
	sessionFile: string;
	displayName: string;
	purpose: string;
	destinations: Array<{ host: string; note?: string }>;
	providerSuggestions?: string[];
	recipeId?: string;
	artifactId?: string;
	dataNeedId?: string;
	status: CompanyConnectionRequestStatus;
	phase: CompanyConnectionIntentPhase;
	guidance?: string;
	selection?: { label: string; kind: "suggestion" | "custom"; selectedAt: string };
	createdAt: string;
	updatedAt: string;
	failure?: string;
	grantId?: string;
}

export interface CompanyScheduledJobView {
	id: string;
	title: string;
	prompt: string;
	triggers: RoutineTrigger[];
	enabled: boolean;
	effort: ScheduledJobEffort;
	placement: RoutinePlacement;
	createdAt: string;
	updatedAt: string;
	suspendedReason?: string;
	staffAgentId?: string;
}

export interface CompanyConnectorView {
	id: string;
	displayName: string;
	purpose: string;
	ownerAgentId: string;
	environment: "production" | "sandbox";
	operations: Array<{
		id: string;
		label: string;
		description: string;
		access: "read" | "write";
	}>;
	destinations: Array<{ host: string; note?: string }>;
	authentication: { kind: "none" | "api-key" | "oauth2"; label?: string };
	createdAt: string;
	updatedAt: string;
	relativePath: string;
}

export type SessionRuntimeStatus =
	| "starting"
	| "idle"
	| "running"
	| "finishing"
	| "reconnecting"
	| "detached"
	| "settled"
	| "interrupted";

export type SessionRuntimeActivity =
	| { kind: "starting" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "tool"; tool: string; subject?: string };

export interface SessionRuntimeView {
	trailFile: string;
	sessionId: string;
	actor: "company-agent" | "product-worker";
	autonomous: boolean;
	staffAgentId?: string;
	/** Durable multi-staff room carried by this participant trail. */
	roomId?: string;
	label?: string;
	department?: string;
	worktree?: string;
	group?: string;
	parentSession?: string;
	status: SessionRuntimeStatus;
	live: boolean;
	kernelInstanceId: string;
	executorId: string;
	attachmentSequence?: number;
	updatedAt: string;
	turnStartedAt?: string;
	turnInterrupted?: boolean;
	activity?: SessionRuntimeActivity;
	reconnectAttempt?: number;
	exit?: {
		code: number | null;
		signal: string | null;
		busy: boolean;
		expected: boolean;
	};
}

export interface SessionRuntimeSnapshot {
	revision: number;
	generatedAt: string;
	sessions: SessionRuntimeView[];
}

export interface SessionRuntimeUpdate {
	event?: { kind: string; at: string };
	snapshot: SessionRuntimeSnapshot;
	session?: SessionRuntimeView;
}

export interface SessionRuntimeSource {
	snapshot: () => SessionRuntimeSnapshot;
	subscribe: (listener: (update: SessionRuntimeUpdate) => void) => () => void;
	/** False means the canonical replay rejected this trail's complete chain. */
	isTrailVisible?: (trailFile: string) => boolean;
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
	 * host-written and protected). The companion's # heading becomes the
	 * card TITLE, so the founder reads an outcome, not "Gate request: bash". */
	intent?: string;
	/** Gate items only: the gated tool and effect class, for the meta line. */
	gateTool?: string;
	gateClass?: string;
}

function companyName(root: string): string {
	try {
		return readCompanyManifest(root).name;
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
		throw new Error("host mutation target is not one physical file");
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

function writeOptionalAuthorityPolicy(root: string, content: string): void {
	const path = join(canonicalCompanyRoot(root), "authority.toml");
	if (readCompanyFile(root, "authority.toml")) {
		writeAtomicPhysicalFile(path, content);
		return;
	}
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "wx");
		writeFileSync(descriptor, content, "utf-8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		throw error;
	}
}

const BASE_AUTHORITY_POLICY = `# Optional company authority override.
# Without this file, Qorpera Base gates every effect class.

[money]
mode = "gate"

[identity]
mode = "gate"

[irreversible]
mode = "gate"

[authority]
mode = "gate"

# Behavioral instructions only. These do not grant permissions or replace
# the technical safeguards above.
[policy]
spending = "ask"
external_communication = "ask"
hard_to_reverse_changes = "ask"
information_sharing = "ask"
`;

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

function readCompanyFile(root: string, relativePath: string, maxBytes?: number): PhysicalFile | undefined {
	return readPhysicalFileWithin(root, relativePath, maxBytes);
}

function readShellNavigation(): ShellNavigationState {
	return {
		defaultPageId: FIXED_SHELL_NAVIGATION.defaultPageId,
		sectionIds: [...FIXED_SHELL_NAVIGATION.sectionIds],
		nodes: FIXED_SHELL_NAVIGATION.nodes.map((node) => ({
			...node,
			...(node.kind === "department" ? { items: [...node.items] } : { view: { ...node.view } }),
		})),
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
			items.push({
				file: `messages/${file}`,
				status,
				title,
				kind: "message",
				mtimeMs: source.mtimeMs,
			});
		} catch {
			// unreadable inbox entries are skipped
		}
	}
	return items;
}

/** What a trail session is a trail OF — founder-led conversation, scoped
 * product work, or one of the host's autonomous lanes. Derived from the
 * host-authored authority header, so the categorization is trustworthy. */
export type SessionCategory = "conversation" | "product" | "conception" | "merge" | "wake" | "autonomous";

interface SessionSummary {
	file: string;
	mtimeMs: number;
	/** Stable run start from the append-only session header. Unlike the file
	 * mtime, inspecting a trail cannot move this historical timestamp. */
	startedAtMs?: number;
	title: string;
	/** "autonomous" = agent-initiated work (tagged at spawn); "chat" = founder-brought. */
	kind: "chat" | "autonomous";
	/** Fine-grained trail category (user-led conversations are different). */
	category: SessionCategory;
	/** Stable staff member identity stamped into the immutable trail header. */
	staffAgentId?: string;
	/** Durable multi-staff room carried by this participant trail. */
	roomId?: string;
	/** Product-development department assigned to this chat. */
	department?: string;
	/** Exact product worktree assigned to this chat. */
	worktree?: string;
	/** Named scheduled-job identity parsed from the host-authenticated session label. */
	scheduledJobId?: string;
	scheduledJobTitle?: string;
	/** Original routine instruction recovered from the scheduled wake prompt. */
	scheduledJobPrompt?: string;
	/** Host-stamped grouping identity ("job:<id>", "merge", a workflow run id). */
	group?: string;
	/** Trail filename of the session that caused this spawn (subagent parent link). */
	parentSession?: string;
	/** Autonomous-run health derived from host-observed trail entries. */
	outcome?: "running" | "succeeded" | "failed" | "incomplete";
	/** Last model recorded for the run. */
	modelProvider?: string;
	modelId?: string;
	/** End-to-end elapsed time, from the session header to the terminal entry. */
	durationMs?: number;
	finishedAtMs?: number;
	/** Host-accounted aggregate usage for the intent. */
	calls?: number;
	costUsd?: number;
	/** Founder-facing failure explanation and recovery guidance. */
	failureCause?: string;
	failureGuidance?: string;
	failureDetail?: string;
	/** What completed before a failed or incomplete run stopped. */
	partialChangeSummary?: string;
	changedFiles?: string[];
	completedSteps?: number;
	/** Final assistant prose, bounded for projection into the owning agent chat. */
	resultText?: string;
	/** Canonical current lifecycle, when this historical session has a
	 * projected runtime attachment. */
	runtime?: SessionRuntimeView;
}

/** Chat-title material: chrome-injected context blocks are plumbing, not the
 * founder's words; whitespace collapses; one line, bounded. */
function sessionTitleText(text: string): string {
	return text
		.replace(/^(?:\[(?:Sidechat|Connection choice) context:[^\]]*\]\s*)+/, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 70);
}

interface AutonomousRunSummary {
	outcome: "running" | "succeeded" | "failed" | "incomplete";
	startedAtMs?: number;
	modelProvider?: string;
	modelId?: string;
	durationMs?: number;
	finishedAtMs?: number;
	calls?: number;
	costUsd?: number;
	failureCause?: string;
	failureGuidance?: string;
	failureDetail?: string;
	partialChangeSummary?: string;
	changedFiles?: string[];
	completedSteps?: number;
	resultText?: string;
}

interface TrailToolCall {
	name: string;
	arguments?: Record<string, unknown>;
}

function conciseFailureDetail(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return (
		value
			.split(/; stack=|\n\s+at /, 1)[0]
			?.trim()
			.slice(0, 320) || undefined
	);
}

function runFailureGuidance(
	errorMessage: string | undefined,
	intentStatus: string | undefined,
): { cause: string; guidance: string; detail?: string } {
	const detail = conciseFailureDetail(errorMessage);
	const raw = detail?.toLowerCase() ?? "";
	if (/oauth|invalid_grant|refresh token|sign-in|unauthori[sz]ed|\b401\b|\b403\b/.test(raw)) {
		return {
			cause: "The model connection needs attention.",
			guidance: "Reconnect that model account or choose another model, then retry the run.",
			detail,
		};
	}
	if (/insufficient_quota|quota|billing|credit balance/.test(raw)) {
		return {
			cause: "The model account cannot accept more work.",
			guidance: "Check its quota or billing, or choose another model, then retry the run.",
			detail,
		};
	}
	if (/context|prompt is too long|input.*too (?:large|long)|maximum.*tokens/.test(raw)) {
		return {
			cause: "The run was too large for this model.",
			guidance: "Retry with a shorter request, start a fresh chat, or choose a model with more context.",
			detail,
		};
	}
	if (
		/connection refused|connect error|disconnect|reset before headers|transport failure|socket hang up|timed? out|timeout|overloaded|rate.?limit|\b429\b|\b502\b|\b503\b|\b529\b/.test(
			raw,
		)
	) {
		return {
			cause: "The model service could not be reached.",
			guidance: "Retry now. If it happens again, choose another model or check the model connection in Settings.",
			detail,
		};
	}
	if (/terminated|aborted|stopped/.test(raw) || intentStatus === "aborted") {
		return {
			cause: "The agent stopped before it finished.",
			guidance: "Review the partial work below, then retry the run.",
			detail,
		};
	}
	return {
		cause: "The model could not complete this run.",
		guidance: "Review the partial work below, then retry. If it repeats, choose another model.",
		detail,
	};
}

function changedPath(tool: TrailToolCall): string | undefined {
	if (!/^(?:write|edit|apply_patch|patch|notebook_edit)$/i.test(tool.name)) return undefined;
	const value = tool.arguments?.path ?? tool.arguments?.filePath ?? tool.arguments?.file_path;
	return typeof value === "string" && value.trim() ? value.trim().replace(/\\/g, "/") : undefined;
}

function partialChangeSummary(completedSteps: number, changedFiles: string[], uncertainShellChanges: boolean): string {
	if (changedFiles.length) {
		const names = changedFiles.slice(0, 5).join(", ");
		const remainder = changedFiles.length > 5 ? ` and ${changedFiles.length - 5} more` : "";
		const shellNote = uncertainShellChanges ? " Other completed shell steps may also have changed files." : "";
		return `Changed ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}: ${names}${remainder}.${shellNote}`;
	}
	if (completedSteps === 0) return "No completed steps were recorded before the run stopped.";
	if (uncertainShellChanges) {
		return `Completed ${completedSteps} step${completedSteps === 1 ? "" : "s"} before stopping. Shell work may have changed files; review the work log before retrying.`;
	}
	return `Completed ${completedSteps} read-only step${completedSteps === 1 ? "" : "s"}. No file changes were recorded.`;
}

/** Read enough of a trail to classify an autonomous run without reparsing a
 * potentially 64 MiB history file on every two-second state poll. The head
 * carries the authenticated session/model declarations; the tail carries the
 * terminal assistant and host intent-accounting entries. */
function autonomousRunSummary(content: Buffer, mtimeMs: number): AutonomousRunSummary {
	const headBytes = 262_144;
	const tailBytes = 524_288;
	const headEnd = Math.min(content.length, headBytes);
	const headLines = content.toString("utf-8", 0, headEnd).split("\n");
	if (content.length > headEnd) headLines.pop();
	const lines = [...headLines];
	if (content.length > headEnd) {
		const tailStart = Math.max(headEnd, content.length - tailBytes);
		const tailLines = content.toString("utf-8", tailStart).split("\n");
		// tailStart can split a UTF-8 sequence or JSON entry; discard that stub.
		tailLines.shift();
		lines.push(...tailLines);
	}

	let startedAt: number | undefined;
	let terminalAt: number | undefined;
	let lastObservedAt = 0;
	let modelProvider: string | undefined;
	let modelId: string | undefined;
	let lastAssistantStopReason: string | undefined;
	const assistantErrors: string[] = [];
	let lastRequestStatus: string | undefined;
	let intentStatus: string | undefined;
	let sessionEnded = false;
	let sessionEndAt: number | undefined;
	let calls: number | undefined;
	let requestCostUsd = 0;
	let sawRequestCost = false;
	let intentCostUsd: number | undefined;
	const toolCalls = new Map<string, TrailToolCall>();
	const changedFiles = new Set<string>();
	let completedSteps = 0;
	let uncertainShellChanges = false;
	let resultText: string | undefined;

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				timestamp?: string;
				provider?: string;
				modelId?: string;
				customType?: string;
				message?: {
					role?: string;
					provider?: string;
					model?: string;
					stopReason?: string;
					errorMessage?: string;
					toolCallId?: string;
					toolName?: string;
					isError?: boolean;
					content?: Array<{
						type?: string;
						text?: string;
						id?: string;
						name?: string;
						arguments?: Record<string, unknown>;
					}>;
				};
				data?: {
					event?: string;
					status?: string;
					provider?: string;
					model?: string;
					usage?: { calls?: number; costUsd?: number };
				};
			};
			const observedAt = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			if (Number.isFinite(observedAt)) lastObservedAt = Math.max(lastObservedAt, observedAt);
			if (entry.type === "session" && startedAt === undefined && Number.isFinite(observedAt)) startedAt = observedAt;
			// A message after an end marker means the trail was resumed: the
			// release is history, not this run's terminal state.
			if (entry.type === "message" && sessionEnded) {
				sessionEnded = false;
				sessionEndAt = undefined;
			}
			if (entry.type === "model_change") {
				if (typeof entry.provider === "string") modelProvider = entry.provider;
				if (typeof entry.modelId === "string") modelId = entry.modelId;
			}
			if (entry.type === "message" && entry.message?.role === "assistant") {
				if (typeof entry.message.provider === "string") modelProvider = entry.message.provider;
				if (typeof entry.message.model === "string") modelId = entry.message.model;
				if (typeof entry.message.stopReason === "string") {
					lastAssistantStopReason = entry.message.stopReason;
					if (entry.message.stopReason !== "toolUse" && Number.isFinite(observedAt)) terminalAt = observedAt;
				}
				if (entry.message.stopReason === "error" && typeof entry.message.errorMessage === "string") {
					assistantErrors.push(entry.message.errorMessage);
				}
				const assistantText = (entry.message.content ?? [])
					.filter((part) => part.type === "text" && typeof part.text === "string")
					.map((part) => part.text?.trim() ?? "")
					.filter(Boolean)
					.join("\n\n")
					.trim();
				if (assistantText && entry.message.stopReason === "stop") resultText = assistantText.slice(0, 8_192);
				for (const part of entry.message.content ?? []) {
					if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
						toolCalls.set(part.id, {
							name: part.name,
							arguments: part.arguments,
						});
					}
				}
			}
			if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.isError === false) {
				completedSteps += 1;
				const tool =
					(typeof entry.message.toolCallId === "string" ? toolCalls.get(entry.message.toolCallId) : undefined) ??
					(typeof entry.message.toolName === "string" ? { name: entry.message.toolName } : undefined);
				if (tool) {
					const path = changedPath(tool);
					if (path) changedFiles.add(path);
					if (/^(?:bash|shell|shell_command)$/i.test(tool.name)) uncertainShellChanges = true;
				}
			}
			if (entry.type === "custom" && entry.customType === "qorpera_kernel_session_end") {
				// The host released this session: liveness is settled fact from
				// here on, never an mtime guess.
				sessionEnded = true;
				if (Number.isFinite(observedAt)) sessionEndAt = observedAt;
				continue;
			}
			if (entry.type !== "custom" || entry.customType !== "qorpera_kernel_model_request") continue;
			if (typeof entry.data?.provider === "string") modelProvider = entry.data.provider;
			if (typeof entry.data?.model === "string") modelId = entry.data.model;
			if (entry.data?.event === "request") {
				lastRequestStatus = entry.data.status;
				const cost = entry.data.usage?.costUsd;
				if (entry.data.status === "completed" && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
					requestCostUsd += cost;
					sawRequestCost = true;
				}
			}
			if (entry.data?.event === "intent") {
				intentStatus = entry.data.status;
				const intentCalls = entry.data.usage?.calls;
				const cost = entry.data.usage?.costUsd;
				if (typeof intentCalls === "number" && Number.isFinite(intentCalls) && intentCalls >= 0)
					calls = intentCalls;
				if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) intentCostUsd = cost;
				if (
					(entry.data.status === "completed" ||
						entry.data.status === "failed" ||
						entry.data.status === "aborted") &&
					Number.isFinite(observedAt)
				) {
					terminalAt = observedAt;
				}
			}
		} catch {
			// Foreign or partial trail entries do not prevent classification.
		}
	}

	let outcome: AutonomousRunSummary["outcome"];
	if (
		intentStatus === "failed" ||
		intentStatus === "aborted" ||
		lastAssistantStopReason === "error" ||
		lastAssistantStopReason === "aborted" ||
		(intentStatus === "completed" && lastAssistantStopReason === undefined && lastRequestStatus === "failed")
	) {
		outcome = "failed";
	} else if (intentStatus === "completed" && lastAssistantStopReason === "stop") {
		outcome = "succeeded";
	} else if (sessionEnded) {
		// Host-released without terminal success markers: not running, and no
		// 30-minute wait to say so.
		outcome = "incomplete";
	} else {
		outcome = Date.now() - (lastObservedAt || mtimeMs) < 30 * 60_000 ? "running" : "incomplete";
	}
	if (terminalAt === undefined && sessionEndAt !== undefined) terminalAt = sessionEndAt;
	const usefulError =
		assistantErrors.find((message) => !/(?:host|kernel) model request denied|^terminated$/i.test(message.trim())) ??
		assistantErrors[0];
	const failure = outcome === "failed" ? runFailureGuidance(usefulError, intentStatus) : undefined;
	const files = [...changedFiles].sort();

	return {
		outcome,
		startedAtMs: startedAt,
		modelProvider,
		modelId,
		durationMs: startedAt !== undefined && terminalAt !== undefined ? Math.max(0, terminalAt - startedAt) : undefined,
		finishedAtMs: terminalAt,
		calls,
		costUsd: intentCostUsd ?? (sawRequestCost ? requestCostUsd : undefined),
		resultText,
		...(failure
			? {
					failureCause: failure.cause,
					failureGuidance: failure.guidance,
					failureDetail: failure.detail,
				}
			: {}),
		...(outcome === "failed" || outcome === "incomplete"
			? {
					partialChangeSummary: partialChangeSummary(completedSteps, files, uncertainShellChanges),
					changedFiles: files,
					completedSteps,
				}
			: {}),
	};
}

/** Trail sessions ARE the chat list (spec §3). Title = first user message,
 * falling back to the host's observed first input, then the stored session
 * name. A chat the founder never spoke into — opened and abandoned before any
 * input — is spawn residue, not history: it is skipped entirely, so panels
 * never pile up with contentless "New chat" rows. Autonomous work is tagged
 * with a session name at spawn time and always listed. */
function sortTrailSessions(sessions: SessionSummary[]): SessionSummary[] {
	return sessions.sort(
		(a, b) =>
			(b.kind === "autonomous" ? (b.startedAtMs ?? b.mtimeMs) : b.mtimeMs) -
			(a.kind === "autonomous" ? (a.startedAtMs ?? a.mtimeMs) : a.mtimeMs),
	);
}

function listTrailSessions(root: string, onlyFiles?: ReadonlySet<string>): SessionSummary[] {
	const dir = physicalDirectoryWithin(root, "trail");
	if (!dir) return [];
	const sessions: SessionSummary[] = [];
	for (const file of onlyFiles ?? readdirSync(dir)) {
		if (!file.endsWith(".jsonl")) continue;
		try {
			const source = readPhysicalFileWithin(dir, file);
			if (!source) continue;
			const lines = source.content.toString("utf-8").split("\n");
			let title = "";
			let hostInput = "";
			let name = "";
			// Words are title material; a user message ENTRY (even an image-only
			// one) is proof of content — tracked apart so wordless-but-real chats
			// still list.
			let sawUserMessage = false;
			let scheduledJobPrompt = "";
			let sessionAuthority:
				| {
						autonomous?: boolean;
						staffAgentId?: string;
						roomId?: string;
						label?: string;
						department?: string;
						worktree?: string;
						group?: string;
						parentSession?: string;
				  }
				| undefined;
			let titleEntries = 0;
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						customType?: string;
						data?: { message?: unknown };
						name?: string;
						qorpera?: typeof sessionAuthority;
						message?: {
							role?: string;
							content?: string | Array<{ type?: string; text?: string }>;
						};
					};
					// Runtime attachments are transport history, not title material.
					// Do not let a long-lived, idle conversation's reconnects crowd its
					// eventual first founder message out of the bounded title scan.
					if (entry.type === "custom" && entry.customType === "qorpera_kernel_session_runtime") continue;
					titleEntries += 1;
					if (entry.type === "session" && entry.qorpera) sessionAuthority = entry.qorpera;
					if (entry.type === "session_info" && typeof entry.name === "string" && !name) {
						name = entry.name;
					}
					// The host records the founder's exact first input before the
					// child's own message entry lands — the cheapest title source.
					if (
						entry.type === "custom" &&
						entry.customType === "qorpera_kernel_input" &&
						!hostInput &&
						typeof entry.data?.message === "string"
					) {
						hostInput = sessionTitleText(entry.data.message);
					}
					if (entry.type === "message" && entry.message?.role === "user") {
						sawUserMessage = true;
						const content = entry.message.content;
						const text =
							typeof content === "string"
								? content
								: (content?.find((part) => part.type === "text")?.text ?? "");
						if (!scheduledJobPrompt && /^Scheduled job:[^\n]*\n\n/u.test(text)) {
							scheduledJobPrompt = text
								.replace(/^Scheduled job:[^\n]*\n\n/u, "")
								.trim()
								.slice(0, 8_192);
						}
						if (!title) {
							title = sessionTitleText(text);
						}
					}
					if (name && title) break;
				} catch {
					// unparseable line (foreign entry shape); keep scanning
				}
				if (titleEntries >= 400) break;
			}
			if (!isPublicSessionGroup(sessionAuthority?.group)) continue;
			const kind = sessionAuthority?.autonomous ? "autonomous" : "chat";
			const label = (sessionAuthority?.label ?? "").toLowerCase();
			const scheduledJob = sessionAuthority?.autonomous
				? (sessionAuthority.label ?? "").match(/^autonomous — wake — scheduled-job:([a-z0-9-]+) — (.+)$/i)
				: undefined;
			const legacyScheduledJob = label === "autonomous — wake — schedule";
			// The host-stamped group is the structured identity; the label regex
			// remains as the fallback for trails written before stamping existed.
			const stampedJobId = sessionAuthority?.group?.startsWith("job:")
				? sessionAuthority.group.slice("job:".length)
				: undefined;
			const scheduledJobId =
				stampedJobId ?? scheduledJob?.[1] ?? (legacyScheduledJob ? DEFAULT_SCHEDULED_JOB_ID : undefined);
			const scheduledJobTitle =
				scheduledJob?.[2]?.trim() ?? (legacyScheduledJob ? DEFAULT_SCHEDULED_JOB_TITLE : undefined);
			const category: SessionCategory = sessionAuthority?.autonomous
				? label.includes("conception")
					? "conception"
					: label.includes("merge")
						? "merge"
						: label.includes("wake")
							? "wake"
							: "autonomous"
				: sessionAuthority?.department || sessionAuthority?.worktree
					? "product"
					: "conversation";
			// Legacy surface-sidechat and product tags are plumbing, not title material.
			const chatName = /^(?:page|product) — /.test(name) ? "" : name;
			// Every openChat spawn writes a trail file before the founder types;
			// scope switches and app opens leave these behind by the dozen. No
			// user message, no host input, no founder-given name → nothing to
			// resume, nothing to list.
			if (kind === "chat" && !sawUserMessage && !hostInput && !chatName) continue;
			const run = kind === "autonomous" ? autonomousRunSummary(source.content, source.mtimeMs) : undefined;
			sessions.push({
				file,
				mtimeMs: source.mtimeMs,
				title:
					kind === "autonomous"
						? (scheduledJobTitle ?? sessionAuthority?.label ?? name)
						: title || hostInput || chatName || "New chat",
				kind,
				category,
				staffAgentId: sessionAuthority?.staffAgentId,
				roomId: sessionAuthority?.roomId,
				department: sessionAuthority?.department,
				worktree: sessionAuthority?.worktree,
				scheduledJobId,
				scheduledJobTitle,
				...(scheduledJobId && scheduledJobPrompt ? { scheduledJobPrompt } : {}),
				group: sessionAuthority?.group,
				parentSession: sessionAuthority?.parentSession,
				...run,
			});
		} catch {
			// unreadable session files are skipped
		}
	}
	return sortTrailSessions(sessions);
}

/** The session catalog is a derived read model, not a second source of truth.
 * Polling state may stat trail files cheaply, but it reparses a trail only
 * when that file set actually changes. */
function createTrailSessionReadModel(
	root: string,
	isTrailVisible?: (trailFile: string) => boolean,
): () => SessionSummary[] {
	const cached = new Map<string, { fingerprint: string; session?: SessionSummary }>();
	return () => {
		const dir = physicalDirectoryWithin(root, "trail");
		if (!dir) {
			cached.clear();
			return [];
		}
		const present = new Set(
			readdirSync(dir).filter((file) => file.endsWith(".jsonl") && isTrailVisible?.(file) !== false),
		);
		for (const file of present) {
			let fingerprint: string;
			let mtimeMs: number | undefined;
			try {
				const stat = statSync(join(dir, file), { bigint: true });
				fingerprint = `${stat.size}:${stat.mtimeNs}`;
				mtimeMs = Number(stat.mtimeNs / 1_000_000n);
			} catch {
				fingerprint = "unreadable";
			}
			const previous = cached.get(file);
			if (previous?.fingerprint === fingerprint) continue;
			if (previous?.session?.kind === "chat" && mtimeMs !== undefined) {
				// A chat's identity/title/scope are established before its first
				// founder turn. Later appends only move it in recency order, so a
				// growing persistent conversation never needs whole-file reparsing.
				cached.set(file, {
					fingerprint,
					session: { ...previous.session, mtimeMs },
				});
				continue;
			}
			cached.set(file, {
				fingerprint,
				session: listTrailSessions(root, new Set([file]))[0],
			});
		}
		for (const file of cached.keys()) {
			if (!present.has(file)) cached.delete(file);
		}
		return sortTrailSessions([...cached.values()].flatMap((entry) => (entry.session ? [{ ...entry.session }] : [])));
	};
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

function safeReadModel<T, View>(read: (() => readonly T[]) | undefined, project: (value: T) => View): View[] {
	if (!read) return [];
	try {
		const values = read();
		if (!Array.isArray(values)) return [];
		return values.map(project);
	} catch {
		return [];
	}
}

function staffView(agent: StaffAgent): StaffAgent {
	return {
		id: agent.id,
		displayName: agent.displayName,
		role: agent.role,
		charter: agent.charter,
		...(agent.templateId !== undefined ? { templateId: agent.templateId } : {}),
		...(agent.departmentId !== undefined ? { departmentId: agent.departmentId } : {}),
		appearance: {
			color: agent.appearance.color,
			shape: agent.appearance.shape,
			...(agent.appearance.creature !== undefined ? { creature: agent.appearance.creature } : {}),
		},
		...(agent.model !== undefined ? { model: { provider: agent.model.provider, modelId: agent.model.modelId } } : {}),
		employmentStatus: agent.employmentStatus,
		lifecycleState: agent.lifecycleState,
		createdAt: agent.createdAt,
		updatedAt: agent.updatedAt,
	};
}

function roomView(room: CompanyRoom): CompanyRoom {
	return {
		id: room.id,
		participantIds: [...room.participantIds],
		historicalParticipantIds: [...room.historicalParticipantIds],
		...(room.title !== undefined ? { title: room.title } : {}),
		status: room.status,
		createdAt: room.createdAt,
		updatedAt: room.updatedAt,
	};
}

function staffMessageView(message: StaffAgentMessage): StaffAgentMessage {
	return {
		id: message.id,
		fromAgentId: message.fromAgentId,
		toAgentId: message.toAgentId,
		...(message.subject !== undefined ? { subject: message.subject } : {}),
		body: message.body,
		createdAt: message.createdAt,
		status: message.status,
		...(message.deliveredAt !== undefined ? { deliveredAt: message.deliveredAt } : {}),
	};
}

function artifactView(artifact: CompanyArtifactRecord): CompanyArtifactRecord {
	return {
		schema: artifact.schema,
		id: artifact.id,
		title: artifact.title,
		purpose: artifact.purpose,
		stewardAgentId: artifact.stewardAgentId,
		...(artifact.accountableDepartmentId !== undefined
			? { accountableDepartmentId: artifact.accountableDepartmentId }
			: {}),
		status: artifact.status,
		...(artifact.score !== undefined ? { score: artifact.score } : {}),
		metrics: artifact.metrics.map((metric) => ({
			id: metric.id,
			label: metric.label,
			description: metric.description,
			direction: metric.direction,
			...(metric.unit !== undefined ? { unit: metric.unit } : {}),
			...(metric.target !== undefined ? { target: metric.target } : {}),
			status: metric.status,
			...(metric.statusReason !== undefined ? { statusReason: metric.statusReason } : {}),
			...(metric.statusChangedAt !== undefined ? { statusChangedAt: metric.statusChangedAt } : {}),
			...(metric.value !== undefined ? { value: metric.value } : {}),
			...(metric.score !== undefined ? { score: metric.score } : {}),
			evidence: [...metric.evidence],
			...(metric.observedAt !== undefined ? { observedAt: metric.observedAt } : {}),
			...(metric.sourceRef !== undefined ? { sourceRef: metric.sourceRef } : {}),
			...(metric.observations !== undefined
				? { observations: metric.observations.map((observation) => ({ ...observation })) }
				: {}),
		})),
		dataNeeds: artifact.dataNeeds.map((need) => ({
			id: need.id,
			label: need.label,
			purpose: need.purpose,
			connectorHints: [...need.connectorHints],
			status: need.status,
			sourceRefs: [...need.sourceRefs],
			sourceAssessments: need.sourceAssessments.map((assessment) => ({
				sourceRef: assessment.sourceRef,
				dataType: assessment.dataType,
				decision: assessment.decision,
				rationale: assessment.rationale,
				metricIds: [...assessment.metricIds],
				evidence: [...assessment.evidence],
				assessedAt: assessment.assessedAt,
				assessedBy: assessment.assessedBy,
			})),
			...(need.connectionRequestId !== undefined ? { connectionRequestId: need.connectionRequestId } : {}),
		})),
		...(artifact.starter !== undefined ? { starter: { templateId: artifact.starter.templateId } } : {}),
		createdAt: artifact.createdAt,
		updatedAt: artifact.updatedAt,
		relativePath: artifact.relativePath,
	};
}

function connectionRequestView(request: CompanyConnectionRequestView): CompanyConnectionRequestView {
	return {
		id: request.id,
		staffAgentId: request.staffAgentId,
		sessionFile: request.sessionFile,
		displayName: request.displayName,
		purpose: request.purpose,
		destinations: request.destinations.map((destination) => ({
			host: destination.host,
			...(destination.note !== undefined ? { note: destination.note } : {}),
		})),
		...(request.providerSuggestions !== undefined ? { providerSuggestions: [...request.providerSuggestions] } : {}),
		...(request.recipeId !== undefined ? { recipeId: request.recipeId } : {}),
		...(request.artifactId !== undefined ? { artifactId: request.artifactId } : {}),
		...(request.dataNeedId !== undefined ? { dataNeedId: request.dataNeedId } : {}),
		status: request.status,
		phase: request.phase,
		...(request.guidance !== undefined ? { guidance: request.guidance } : {}),
		...(request.selection ? { selection: { ...request.selection } } : {}),
		createdAt: request.createdAt,
		updatedAt: request.updatedAt,
		...(request.failure !== undefined ? { failure: request.failure } : {}),
		...(request.grantId !== undefined ? { grantId: request.grantId } : {}),
	};
}

function connectorView(connector: CompanyConnectorManifestRecord): CompanyConnectorView {
	return {
		id: connector.id,
		displayName: connector.displayName,
		purpose: connector.purpose,
		ownerAgentId: connector.ownerAgentId,
		environment: connector.environment ?? "production",
		operations: connector.operations.map((operation) => ({ ...operation })),
		destinations: connector.destinations.map((destination) => ({ ...destination })),
		authentication: {
			kind: connector.authentication.kind,
			...(connector.authentication.kind !== "none" ? { label: connector.authentication.label } : {}),
		},
		createdAt: connector.createdAt,
		updatedAt: connector.updatedAt,
		relativePath: connector.relativePath,
	};
}

function scheduledJobView(job: CompanyScheduledJobView): CompanyScheduledJobView {
	return {
		id: job.id,
		title: job.title,
		prompt: job.prompt,
		triggers: job.triggers.map((trigger) => {
			if (trigger.kind === "schedule") return { ...trigger };
			if (trigger.kind === "github") return { ...trigger, events: [...trigger.events], actors: [...trigger.actors] };
			return { ...trigger };
		}),
		enabled: job.enabled,
		effort: job.effort,
		placement: job.placement,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		...(job.suspendedReason !== undefined ? { suspendedReason: job.suspendedReason } : {}),
		...(job.staffAgentId !== undefined ? { staffAgentId: job.staffAgentId } : {}),
	};
}

function organizationNodeView(node: CompanyOrganizationHierarchyNodeView): CompanyOrganizationHierarchyNodeView {
	return {
		id: node.id,
		kind: node.kind,
		label: node.label,
		status: node.status,
		...(node.role !== undefined ? { role: node.role } : {}),
		canonicalId: node.canonicalId,
		children: node.children.map(organizationNodeView),
	};
}

function organizationHierarchyView(
	hierarchy: CompanyOrganizationHierarchyView | undefined,
): CompanyOrganizationHierarchyView | undefined {
	if (!hierarchy) return undefined;
	return {
		schema: "qorpera.company-organization-hierarchy/v1",
		profileId: hierarchy.profileId,
		formationState: hierarchy.formationState,
		primary: hierarchy.primary.map(organizationNodeView),
		inactive: hierarchy.inactive.map(organizationNodeView),
	};
}

function stateFor(
	root: string,
	runtime?: SessionRuntimeSnapshot,
	sessions?: SessionSummary[],
	staff: readonly StaffAgent[] = [],
	rooms: readonly CompanyRoom[] = [],
	artifacts: readonly CompanyArtifactRecord[] = [],
	connectors: readonly CompanyConnectorView[] = [],
	connectionRequests: readonly CompanyConnectionRequestView[] = [],
	scheduledJobs: readonly CompanyScheduledJobView[] = [],
	agentMessages: readonly StaffAgentMessage[] = [],
	governedCompanyFile = false,
	organizationHierarchy?: CompanyOrganizationHierarchyView,
): unknown {
	const projectedSessions = sessions ?? listTrailSessions(root);
	const publicRuntime = runtime ? publicSessionRuntimeSnapshot(runtime) : undefined;
	let departments: Array<
		ReturnType<typeof listProductDepartments>[number] & {
			pullRequests: PullRequestSummary[];
		}
	> = [];
	try {
		departments = (governedCompanyFile ? [] : listProductDepartments(root)).map((department) => ({
			...department,
			pullRequests: listPullRequestRecords(root, department.pullRequestsPath),
		}));
	} catch {
		// a malformed department record must not take company state down
	}
	const runtimeByTrail = new Map((publicRuntime?.sessions ?? []).map((session) => [session.trailFile, session]));
	const routineChatFiles = new Set<string>();
	const routineRunsByStaff = new Map<string, number>();
	for (const session of projectedSessions) {
		if (!session.staffAgentId || !session.scheduledJobId) continue;
		const count = routineRunsByStaff.get(session.staffAgentId) ?? 0;
		if (count >= 12) continue;
		routineRunsByStaff.set(session.staffAgentId, count + 1);
		routineChatFiles.add(session.file);
	}
	return {
		name: companyName(root),
		shellNavigation: readShellNavigation(),
		inbox: governedCompanyFile ? [] : readInbox(root),
		companyFile: { mode: governedCompanyFile ? "governed" : "legacy" },
		sessions: projectedSessions.map((session) => {
			const view = {
				...session,
				runtime: runtimeByTrail.get(session.file),
			};
			if (!routineChatFiles.has(session.file)) {
				delete view.resultText;
				delete view.scheduledJobPrompt;
			}
			return view;
		}),
		runtime: publicRuntime ?? { revision: 0, generatedAt: "", sessions: [] },
		staff,
		rooms,
		artifacts,
		connectors,
		connectionRequests,
		scheduledJobs,
		agentMessages,
		organizationHierarchy: organizationHierarchyView(organizationHierarchy) ?? null,
		trailSessions: projectedSessions.length,
		departments,
	};
}

function writeServerEvent(response: ServerResponse, event: string, data: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

function serveFixedShell(directory: string, entry: string, response: ServerResponse): void {
	const target = readPhysicalFileWithin(directory, entry || "index.html");
	serveFixedShellTarget(target, response);
}

function serveFixedShellTarget(target: PhysicalFile | undefined, response: ServerResponse): void {
	if (!target) {
		response.writeHead(404).end("shell asset not found");
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
export function resolveGate(root: string, file: string, action: string): boolean {
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
<title>${name}</title>
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
	<h1 id="title">${name}<small>Qorpera Base</small></h1>
	<div id="navigation"></div>
</nav>
<main>
	<div id="panel"></div>
</main>
<script>
let state = { shellNavigation: { defaultPageId: "q:chats", sectionIds: [], nodes: [] }, inbox: [], sessions: [], trailSessions: 0 };
let current = null;
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
	for (const sectionId of state.shellNavigation.sectionIds) {
		const section = node(sectionId);
		if (!section || section.kind !== "department") continue;
		const heading = document.createElement("h2");
		heading.textContent = section.label;
		nav.appendChild(heading);
		for (const childId of section.items) {
			const child = node(childId);
			if (!child) continue;
			const button = document.createElement("button");
			button.textContent = child.label;
			if (current === child.id) button.className = "active";
			button.onclick = () => openNode(child.id);
			nav.appendChild(button);
		}
	}
	if (!current && state.shellNavigation.defaultPageId) openNode(state.shellNavigation.defaultPageId);
	const target = node(current);
	if (target && target.kind === "page") {
		if (target.view.id === "qorpera.inbox") showPanel("inbox", true);
		if (target.view.id === "qorpera.activity" || target.view.id === "qorpera.chats") showPanel("trail", true);
	}
}
function node(id) { return state.shellNavigation.nodes.find((entry) => entry.id === id); }
function openNode(id) {
	const target = node(id);
	if (!target || target.kind !== "page") return;
	current = id;
	if (target.view.id === "qorpera.inbox") return showPanel("inbox");
	if (target.view.id === "qorpera.activity" || target.view.id === "qorpera.chats") return showPanel("trail");
}
function showPanel(which, keep) {
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
			.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
			})
			.end(JSON.stringify(summary));
	} catch (error) {
		response.writeHead(500, { "content-type": "application/json" }).end(
			JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}

export function createCompanyAppServer(options: CompanyAppOptions): Server {
	const root = canonicalCompanyRoot(options.root);
	const trailSessions = createTrailSessionReadModel(root, options.sessionRuntime?.isTrailVisible);
	const usageRateCatalog = options.usageRateCatalog ?? readUsageRateCatalog;
	const authToken = options.authToken;
	if (!authToken) throw new Error("company app server requires a desktop-host authorization token");
	const authorized = (request: IncomingMessage): boolean => request.headers["x-qorpera-token"] === authToken;
	return createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (
			options.governedCompanyFile &&
			(url.pathname === "/api/authority" ||
				url.pathname.startsWith("/api/authority/") ||
				url.pathname.startsWith("/api/inbox/") ||
				url.pathname === "/api/gate" ||
				url.pathname === "/api/artifact/update")
		) {
			response
				.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" })
				.end(JSON.stringify({ error: "Use the live Company File editor for file reads, changes and approvals." }));
			return;
		}
		if (url.pathname.startsWith("/shell/") && options.fixedShell) {
			const entry = decodedPath(url.pathname.slice("/shell/".length), response);
			if (entry !== undefined) serveFixedShell(options.fixedShell.directory, entry, response);
			return;
		}
		if (url.pathname === "/") {
			if (options.fixedShell) {
				response.writeHead(302, { location: "/shell/index.html" }).end();
				return;
			}
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(CHROME_HTML(companyName(root), ""));
			return;
		}
		if (url.pathname === "/api/state") {
			const staff = safeReadModel(options.staffReadModel, staffView);
			const rooms = safeReadModel(options.roomReadModel, roomView);
			const artifacts = safeReadModel(options.artifactReadModel, artifactView);
			const connectors = safeReadModel(options.connectorReadModel, connectorView);
			const connectionRequests = safeReadModel(options.connectionRequestReadModel, connectionRequestView);
			const scheduledJobs = safeReadModel(options.scheduledJobReadModel, scheduledJobView);
			const agentMessages = safeReadModel(options.staffMessageReadModel, staffMessageView);
			let organizationHierarchy: CompanyOrganizationHierarchyView | undefined;
			try {
				organizationHierarchy = options.organizationReadModel?.();
			} catch {
				// A malformed or temporarily unavailable semantic projection must
				// not take down the rest of the company read model.
			}
			response
				.writeHead(200, {
					"content-type": "application/json",
					"cache-control": "no-store",
				})
				.end(
					JSON.stringify(
						stateFor(
							root,
							options.sessionRuntime?.snapshot(),
							trailSessions(),
							staff,
							rooms,
							artifacts,
							connectors,
							connectionRequests,
							scheduledJobs,
							agentMessages,
							options.governedCompanyFile,
							organizationHierarchy,
						),
					),
				);
			return;
		}
		if (url.pathname === "/api/artifact/update" && request.method === "POST") {
			if (!authorized(request)) {
				response.writeHead(401).end("token required");
				return;
			}
			if (!options.artifactUpdateModel) {
				response.writeHead(404).end("unavailable");
				return;
			}
			let body = "";
			let exceeded = false;
			request.on("data", (chunk: Buffer) => {
				if (exceeded) return;
				body += chunk.toString("utf-8");
				if (Buffer.byteLength(body, "utf-8") > 256 * 1024) exceeded = true;
			});
			request.on("end", () => {
				try {
					if (exceeded) throw new Error("Artifact update exceeds 256 KiB");
					const input = JSON.parse(body) as { id?: unknown; update?: unknown };
					if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string") {
						throw new Error("Artifact update is invalid");
					}
					const artifact = options.artifactUpdateModel!(input.id, input.update);
					response
						.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
						.end(JSON.stringify({ ok: true, artifact: artifactView(artifact) }));
				} catch (error) {
					response
						.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" })
						.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
				}
			});
			return;
		}
		if (url.pathname === "/api/runtime" && request.method === "GET") {
			if (!options.sessionRuntime) {
				response
					.writeHead(404, { "content-type": "application/json" })
					.end(JSON.stringify({ error: "unavailable" }));
				return;
			}
			response.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			});
			writeServerEvent(response, "snapshot", publicSessionRuntimeSnapshot(options.sessionRuntime.snapshot()));
			const unsubscribe = options.sessionRuntime.subscribe((update) => {
				// Stream only the event discriminator plus the canonical read model.
				// Provider diagnostics stay in the protected trail and never become
				// ambient same-origin shell data.
				if (update.event?.kind === "activity" && update.session) {
					if (!isPublicSessionRuntime(update.session)) return;
					writeServerEvent(response, "runtime", {
						event: { kind: update.event.kind, at: update.event.at },
						revision: update.snapshot.revision,
						generatedAt: update.snapshot.generatedAt,
						session: update.session,
					});
					return;
				}
				writeServerEvent(response, "runtime", {
					...(update.event ? { event: { kind: update.event.kind, at: update.event.at } } : {}),
					snapshot: publicSessionRuntimeSnapshot(update.snapshot),
				});
			});
			// The response owns an SSE subscription. The request body is already
			// complete for GET and is not a reliable lifetime signal for the stream.
			response.once("close", unsubscribe);
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
			// The settings UI exposes behavioral policy only. Technical authority
			// remains a separate, non-configurable kernel concern here.
			const authority = discoverAuthority(root);
			if (!authority) {
				response.writeHead(404).end("no authority.toml");
				return;
			}
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ policy: readCompanyPolicy(authority) }));
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
					const update = JSON.parse(body) as { policy?: unknown };
					if (!update.policy || typeof update.policy !== "object" || Array.isArray(update.policy)) {
						throw new Error("policy must be an object");
					}
					const incoming = update.policy as Record<string, unknown>;
					if (Object.keys(incoming).length === 0) throw new Error("policy update is empty");
					if (Object.keys(incoming).some((key) => !(COMPANY_POLICY_KEYS as readonly string[]).includes(key))) {
						throw new Error("policy contains an unknown category");
					}

					const source = readCompanyFile(root, "authority.toml");
					if (source) {
						const provenance = verifyAuthorityPolicy(root);
						if (provenance !== "no-identity" && provenance !== "valid") {
							throw new Error("authority.toml must be ratified before changing policy instructions");
						}
					}
					const sourceText = source?.content.toString("utf-8") ?? BASE_AUTHORITY_POLICY;
					const policy = parseCompanyPolicy(sourceText);
					for (const key of COMPANY_POLICY_KEYS) {
						const value = incoming[key];
						if (value === undefined) continue;
						if (!isCompanyPolicyMode(value)) throw new Error(`invalid policy mode for ${key}`);
						policy[key] = value;
					}
					const current = readCompanyFile(root, "authority.toml");
					if (source && (!current || !current.content.equals(source.content))) {
						throw new Error("authority.toml changed while policy instructions were being saved");
					}
					writeOptionalAuthorityPolicy(root, updateCompanyPolicySource(sourceText, policy));
					ratifyPolicyIfFounder(root);
					const authority = discoverAuthority(root);
					const effectivePolicy = authority ? readCompanyPolicy(authority) : policy;
					response
						.writeHead(200, { "content-type": "application/json" })
						.end(JSON.stringify({ ok: true, policy: effectivePolicy }));
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
				response
					.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
					.end(source?.content.toString("utf-8") ?? BASE_AUTHORITY_POLICY);
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
					writeOptionalAuthorityPolicy(root, content);
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
					const { file, response: reply } = JSON.parse(body) as {
						file?: string;
						response?: string;
					};
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
					const { file, action } = JSON.parse(body) as {
						file?: string;
						action?: string;
					};
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
