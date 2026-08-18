import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	classifyToolCall,
	discoverAuthority,
	readAuthorityConfig,
	requestHash,
} from "@qorpera/pi-coding-agent/authority";
import type { KernelIntentCapability, KernelModelIntentBudget, ModelIntentTerminalStatus } from "@qorpera/pi-protocol";
import type { ConnectionRequest } from "./connection-requests.ts";

export type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";

function normalizedPhysicalPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertPhysicalCompanyTree(root: string, relativePath: string): string {
	const canonicalRoot = realpathSync(resolve(root));
	const target = resolve(canonicalRoot, relativePath);
	const rootRelative = relative(canonicalRoot, target);
	if (!rootRelative || rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
		throw new Error(`Company storage escaped its root: ${relativePath}`);
	}
	const visit = (path: string): void => {
		const entry = lstatSync(path);
		if (
			entry.isSymbolicLink() ||
			normalizedPhysicalPath(realpathSync(path)) !== normalizedPhysicalPath(path) ||
			(entry.isFile() && entry.nlink !== 1)
		) {
			throw new Error(`Company storage must be one physical entry: ${relativePath}`);
		}
		if (entry.isDirectory()) {
			for (const child of readdirSync(path)) visit(join(path, child));
		}
	};
	visit(target);
	return target;
}

interface QorperaSessionAuthority {
	actor: "company-agent" | "product-worker";
	attended: boolean;
	/** Stable staff member identity. */
	staffAgentId?: string;
	autonomous?: boolean;
	label?: string;
	department?: string;
	worktree?: string;
	/** Kernel-stamped grouping identity ("job:<id>", "merge", a future
	 * workflow run id): how the Agents view clusters related sessions
	 * without parsing free-text labels. */
	group?: string;
	/** Trail filename of the session that caused this spawn — the parent
	 * link for future subagent trees. The kernel stamps it; children can
	 * never claim a parent themselves. */
	parentSession?: string;
}

interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	qorpera?: QorperaSessionAuthority;
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	kernel?: {
		sequence: number;
		receivedAt: string;
		previousHash: string | null;
		hash: string;
	};
	provenance?: {
		source: "kernel" | "child";
		trust: "observed" | "assertion";
	};
	[key: string]: unknown;
}

export interface AgentScope {
	actor: "company-agent" | "product-worker";
	attended: boolean;
	staffAgentId?: string;
	autonomousLabel?: string;
	department?: string;
	worktree?: string;
	group?: string;
	parentSession?: string;
}

export interface TrailBinding {
	path: string;
	file: string;
	sessionId: string;
	cwd: string;
	token: string;
	authority: QorperaSessionAuthority;
	audit: { ids: Set<string>; sequence: number; lastHash: string };
}

export interface TrailAppendFrame {
	type: "qorpera_trail_append";
	token: string;
	entry: SessionEntry;
}

interface KernelWriteFrame {
	type: "qorpera_kernel_write";
	token: string;
	operation: "create_gate" | "consume_gate" | "trust_gate" | "append_notice" | "create_message";
	gate?: {
		id: string;
		file: string;
		effectClass: string;
		toolName: string;
		hash: string;
		args: unknown;
	};
	file?: string;
	message?: string;
	content?: string;
	status?: string;
	requestId?: string;
	hash?: string;
}

export interface KernelGateResponseBody {
	requestId: string;
	file: string;
	hash: string;
	granted: boolean;
}

export interface SignedKernelGateResponse extends KernelGateResponseBody {
	type: "qorpera_kernel_response";
	signature: string;
}

export interface SignedKernelBindingResponse {
	type: "qorpera_kernel_binding";
	nonce: string;
	sessionId: string;
	signature: string;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TRAIL_ENTRY_BYTES = 16 * 1024 * 1024;
const TRAIL_SESSION_VERSION = 5;
const TRAIL_ENTRY_TYPES = new Set([
	"message",
	"thinking_level_change",
	"model_change",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
]);

function readHeader(path: string): SessionHeader {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(MAX_HEADER_BYTES);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const end = buffer.subarray(0, size).indexOf(0x0a);
		if (end < 0) throw new Error(`trail session header is missing or too large: ${path}`);
		const header = JSON.parse(buffer.subarray(0, end).toString("utf-8")) as SessionHeader;
		if (header.type !== "session" || typeof header.id !== "string") {
			throw new Error(`trail session has an invalid header: ${path}`);
		}
		return header;
	} finally {
		closeSync(fd);
	}
}

function authorityForScope(scope: AgentScope): QorperaSessionAuthority {
	if (scope.actor === "product-worker" && (!scope.department || !scope.worktree)) {
		throw new Error("product-worker sessions require an exact department and worktree assignment");
	}
	if (
		scope.staffAgentId !== undefined &&
		(scope.staffAgentId.trim().length === 0 || scope.staffAgentId.length > 128)
	) {
		throw new Error("staff agent identity must be a non-empty string of at most 128 characters");
	}
	return {
		actor: scope.actor,
		attended: scope.attended,
		staffAgentId: scope.staffAgentId,
		autonomous: scope.autonomousLabel ? true : undefined,
		label: scope.autonomousLabel,
		department: scope.department,
		worktree: scope.worktree,
		group: scope.group,
		parentSession: scope.parentSession,
	};
}

function assertMatchingAuthority(actual: QorperaSessionAuthority | undefined, expected: QorperaSessionAuthority): void {
	if (!actual) throw new Error("legacy trail sessions have no trusted host binding and cannot be resumed");
	for (const key of ["actor", "staffAgentId", "department", "worktree"] as const) {
		if (actual[key] !== expected[key]) {
			throw new Error(`trail session authority does not match the requested ${key}`);
		}
	}
}

function validTrailEntry(entry: SessionEntry, ids: Set<string>): boolean {
	if (
		!TRAIL_ENTRY_TYPES.has(entry.type) ||
		typeof entry.id !== "string" ||
		entry.id.length === 0 ||
		entry.id.length > 128 ||
		ids.has(entry.id) ||
		(entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
	)
		return false;
	switch (entry.type) {
		case "message":
			return Boolean(entry.message && typeof entry.message === "object");
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string";
		case "model_change":
			return typeof entry.provider === "string" && typeof entry.modelId === "string";
		case "branch_summary":
			return typeof entry.fromId === "string" && ids.has(entry.fromId) && typeof entry.summary === "string";
		case "custom":
			return typeof entry.customType === "string";
		case "custom_message":
			return (
				typeof entry.customType === "string" &&
				(typeof entry.content === "string" || Array.isArray(entry.content)) &&
				typeof entry.display === "boolean"
			);
		case "label":
			return typeof entry.targetId === "string" && ids.has(entry.targetId);
		case "session_info":
			return entry.name === undefined || typeof entry.name === "string";
		default:
			return false;
	}
}

function validProvenance(entry: SessionEntry): boolean {
	return (
		Boolean(entry.provenance) &&
		(entry.provenance?.source === "kernel" || entry.provenance?.source === "child") &&
		(entry.provenance?.trust === "observed" || entry.provenance?.trust === "assertion") &&
		(entry.provenance.source === "kernel"
			? entry.provenance.trust === "observed"
			: entry.provenance.trust === "assertion")
	);
}

function unsignedTrailEntry(entry: SessionEntry): SessionEntry {
	const copy = { ...entry };
	delete copy.kernel;
	return copy;
}

function auditHash(entry: SessionEntry, previousHash: string): string {
	return createHash("sha256")
		.update(`${previousHash}\n${JSON.stringify(unsignedTrailEntry(entry))}`)
		.digest("hex");
}

export interface TrailAuditState {
	ids: Set<string>;
	sequence: number;
	lastHash: string;
}

export function createTrailAuditState(): TrailAuditState {
	return { ids: new Set(), sequence: 0, lastHash: "" };
}

/** Verify one physical append against the trail graph, provenance, sequence,
 * and hash chain, then advance the supplied cursor. Replay and live binding
 * share this exact integrity boundary. */
export function advanceTrailAuditState(audit: TrailAuditState, value: unknown, path: string): void {
	const entry = value as SessionEntry;
	if (!validTrailEntry(entry, audit.ids) || !validProvenance(entry)) {
		throw new Error(`trail session contains an invalid event graph or provenance: ${path}`);
	}
	const kernel = entry.kernel;
	const expectedSequence = audit.sequence + 1;
	const expectedPrevious = audit.lastHash || null;
	if (
		!kernel ||
		kernel.sequence !== expectedSequence ||
		kernel.previousHash !== expectedPrevious ||
		kernel.receivedAt !== entry.timestamp ||
		kernel.hash !== auditHash(entry, audit.lastHash)
	) {
		throw new Error(`trail session integrity metadata is invalid: ${path}`);
	}
	audit.ids.add(entry.id);
	audit.sequence = kernel.sequence;
	audit.lastHash = kernel.hash;
}

function loadTrailAudit(path: string): TrailBinding["audit"] {
	const lines = readFileSync(path, "utf-8").split(/\r?\n/).slice(1).filter(Boolean);
	const audit = createTrailAuditState();
	for (const line of lines) {
		advanceTrailAuditState(audit, JSON.parse(line), path);
	}
	return audit;
}

/**
 * The explicit append-only migration that bindTrailSession's schema check
 * demands: rewrite a pre-v5 founder chat in place as schema 5, stamping the
 * requesting scope's authority into the header and the kernel provenance and
 * hash chain onto every entry — exactly the stamps parseTrailAppendFrame
 * gives live appends, with each entry's original timestamp kept as its
 * receivedAt (history is being adopted, not re-authored). The original bytes
 * are preserved beside the file as `<file>.v<N>.bak` (not a .jsonl, so
 * session lists ignore it). Returns true if a migration happened, false if
 * the file is already current. Throws — migrating nothing — if any entry
 * cannot satisfy the v5 validator; a legacy file either adopts whole or
 * stays untouched.
 */
export function migrateLegacyTrailSession(root: string, sessionFile: string, scope: AgentScope): boolean {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
		throw new Error("trail session must be a JSONL filename inside the company trail");
	}
	const path = join(trailDir, sessionFile);
	if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
	assertPhysicalCompanyTree(root, join("trail", sessionFile));
	const header = readHeader(path);
	if (header.version === TRAIL_SESSION_VERSION) return false;
	if (scope.staffAgentId !== undefined) {
		throw new Error("legacy trail sessions remain system-owned and cannot be adopted by a staff agent");
	}
	const original = readFileSync(path, "utf-8");
	const entryLines = original.split(/\r?\n/).slice(1).filter(Boolean);
	const authority = authorityForScope(scope);
	const audit: TrailBinding["audit"] = { ids: new Set(), sequence: 0, lastHash: "" };
	const migrated: string[] = [
		JSON.stringify({
			type: "session",
			version: TRAIL_SESSION_VERSION,
			id: header.id,
			timestamp: header.timestamp,
			cwd: header.cwd,
			qorpera: authority,
		} satisfies SessionHeader),
	];
	for (const line of entryLines) {
		const entry = JSON.parse(line) as SessionEntry;
		if (!validTrailEntry(entry, audit.ids) || typeof entry.timestamp !== "string") {
			throw new Error(
				`legacy trail session holds an entry schema ${TRAIL_SESSION_VERSION} cannot adopt (${entry.type ?? "untyped"}): ${sessionFile}`,
			);
		}
		const stamped: SessionEntry = {
			...unsignedTrailEntry(entry),
			provenance: { source: "child", trust: "assertion" },
		};
		stamped.kernel = {
			sequence: audit.sequence + 1,
			receivedAt: entry.timestamp,
			previousHash: audit.lastHash || null,
			hash: "",
		};
		stamped.kernel.hash = auditHash(stamped, audit.lastHash);
		audit.ids.add(stamped.id);
		audit.sequence = stamped.kernel.sequence;
		audit.lastHash = stamped.kernel.hash;
		migrated.push(JSON.stringify(stamped));
	}
	writeFileSync(`${path}.v${header.version ?? 1}.bak`, original, "utf-8");
	const staging = `${path}.migrating`;
	writeFileSync(staging, `${migrated.join("\n")}\n`, "utf-8");
	renameSync(staging, path);
	return true;
}

/**
 * Replace the retired `controller` actor label in current-schema trails.
 * Entry bytes stay unchanged, so the append hash chain remains valid. The
 * original file is retained once beside the trail for recovery.
 */
export function migrateLegacyCompanyAgentTrails(root: string): number {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	let migratedCount = 0;
	for (const file of readdirSync(trailDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(trailDir, file);
		assertPhysicalCompanyTree(root, join("trail", file));
		const original = readFileSync(path, "utf-8");
		const newline = original.indexOf("\n");
		if (newline < 0) throw new Error(`trail session header is missing or too large: ${path}`);
		const header = readHeader(path);
		const authority = header.qorpera as (Omit<QorperaSessionAuthority, "actor"> & { actor?: string }) | undefined;
		if (header.version !== TRAIL_SESSION_VERSION || authority?.actor !== "controller") continue;
		loadTrailAudit(path);
		const migratedHeader: SessionHeader = {
			...header,
			qorpera: { ...authority, actor: "company-agent" },
		};
		const backup = `${path}.controller.bak`;
		if (!existsSync(backup)) writeFileSync(backup, original, { encoding: "utf-8", flag: "wx" });
		else if (readFileSync(backup, "utf-8") !== original) {
			throw new Error(`legacy trail backup does not match the source: ${file}`);
		}
		const staging = `${path}.${randomUUID()}.migrating`;
		try {
			writeFileSync(staging, `${JSON.stringify(migratedHeader)}\n${original.slice(newline + 1)}`, {
				encoding: "utf-8",
				flag: "wx",
			});
			renameSync(staging, path);
		} catch (error) {
			rmSync(staging, { force: true });
			throw error;
		}
		migratedCount++;
	}
	return migratedCount;
}

export function bindTrailSession(
	root: string,
	cwd: string,
	scope: AgentScope,
	sessionFile?: string,
	auditHint?: TrailAuditState,
): TrailBinding {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	const authority = authorityForScope(scope);
	let path: string;
	let sessionId: string;
	let audit: TrailBinding["audit"] = { ids: new Set(), sequence: 0, lastHash: "" };
	if (sessionFile) {
		if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
			throw new Error("trail session must be a JSONL filename inside the company trail");
		}
		path = join(trailDir, sessionFile);
		if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
		assertPhysicalCompanyTree(root, join("trail", sessionFile));
		const header = readHeader(path);
		sessionId = header.id;
		if (header.version !== TRAIL_SESSION_VERSION) {
			throw new Error(`trail session schema ${header.version ?? 1} requires an explicit append-only migration`);
		}
		assertMatchingAuthority(header.qorpera, authority);
		audit = auditHint
			? { ids: new Set(auditHint.ids), sequence: auditHint.sequence, lastHash: auditHint.lastHash }
			: loadTrailAudit(path);
	} else {
		const timestamp = new Date().toISOString();
		const id = randomUUID();
		sessionId = id;
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		path = join(trailDir, `${fileTimestamp}_${id}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: TRAIL_SESSION_VERSION,
			id,
			timestamp,
			cwd: resolve(cwd),
			qorpera: authority,
		};
		writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
	}
	return { path, file: basename(path), sessionId, cwd: resolve(cwd), token: randomUUID(), authority, audit };
}

/** Entry types that make a session part of the company's memory. Everything
 * else (header, model/thinking selection, a session name) is plumbing a
 * window open writes before anyone speaks. */
const TRAIL_CONTENT_TYPES = new Set(["message", "custom", "custom_message", "label", "branch_summary"]);

/**
 * Remove founder chat trail files that never carried any content — the
 * husk a window open used to mint per spawn. Kernel-side hygiene at company
 * open: autonomous sessions are agent work history and always stay,
 * and any file with a single content entry (or anything unparseable) stays.
 * Returns the number of files removed.
 */
export function pruneEmptyTrailSessions(root: string): number {
	const trailDir = join(root, "trail");
	if (!existsSync(trailDir)) return 0;
	let removed = 0;
	for (const file of readdirSync(trailDir)) {
		if (!file.endsWith(".jsonl")) continue;
		const path = join(trailDir, file);
		try {
			const entry = lstatSync(path);
			if (!entry.isFile() || entry.nlink !== 1 || entry.size > 256 * 1024) continue;
			const lines = readFileSync(path, "utf-8")
				.split("\n")
				.filter((line) => line.trim());
			if (lines.length === 0) continue;
			const header = JSON.parse(lines[0]) as SessionHeader;
			if (header.type !== "session") continue;
			if (header.qorpera?.autonomous || header.qorpera?.label) continue;
			let hasContent = false;
			for (const line of lines.slice(1)) {
				const parsed = JSON.parse(line) as { type?: string; customType?: string };
				// Kernel runtime facts describe the temporary executor attached to
				// a session; they are not company memory by themselves. Treating
				// them as content would make every no-op window-open chat permanent.
				if (parsed.type === "custom" && parsed.customType === "qorpera_kernel_session_runtime") continue;
				if (typeof parsed.type !== "string" || TRAIL_CONTENT_TYPES.has(parsed.type)) {
					hasContent = true;
					break;
				}
			}
			if (hasContent) continue;
			rmSync(path);
			removed++;
		} catch {
			// unparseable content is content we do not understand — keep it
		}
	}
	return removed;
}

export function parseTrailAppendFrame(value: unknown, binding: TrailBinding): TrailAppendFrame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const frame = value as Partial<TrailAppendFrame>;
	if (frame.type !== "qorpera_trail_append" || frame.token !== binding.token) return undefined;
	const entry = frame.entry as unknown;
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as SessionEntry;
	if (Buffer.byteLength(JSON.stringify(record), "utf-8") > MAX_TRAIL_ENTRY_BYTES) return undefined;
	if (!validTrailEntry(record, binding.audit.ids)) return undefined;
	const receivedAt = new Date().toISOString();
	const stamped: SessionEntry = {
		...unsignedTrailEntry(record),
		timestamp: receivedAt,
		provenance: { source: "child", trust: "assertion" },
	};
	stamped.kernel = {
		sequence: binding.audit.sequence + 1,
		receivedAt,
		previousHash: binding.audit.lastHash || null,
		hash: "",
	};
	stamped.kernel.hash = auditHash(stamped, binding.audit.lastHash);
	return { type: "qorpera_trail_append", token: binding.token, entry: stamped };
}

function stampKernelEntry(binding: TrailBinding, entry: SessionEntry): TrailAppendFrame {
	const receivedAt = new Date().toISOString();
	const stamped: SessionEntry = {
		...unsignedTrailEntry(entry),
		timestamp: receivedAt,
		provenance: { source: "kernel", trust: "observed" },
	};
	stamped.kernel = {
		sequence: binding.audit.sequence + 1,
		receivedAt,
		previousHash: binding.audit.lastHash || null,
		hash: "",
	};
	stamped.kernel.hash = auditHash(stamped, binding.audit.lastHash);
	return { type: "qorpera_trail_append", token: binding.token, entry: stamped };
}

function appendKernelCustomObservation(binding: TrailBinding, customType: string, data: unknown): void {
	const append = stampKernelEntry(binding, {
		type: "custom",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		customType,
		data,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

/** Establish a fresh session's display identity before any replaceable agent
 * process receives authority. This is ordinary session metadata rather than a
 * runtime observation, but it is kernel-stamped so attachment and naming are
 * one durable operation. */
export function appendKernelSessionInfo(binding: TrailBinding, name: string): void {
	const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
	if (!sanitizedName) throw new Error("session name cannot be empty");
	const append = stampKernelEntry(binding, {
		type: "session_info",
		id: randomUUID(),
		parentId: null,
		timestamp: "",
		name: sanitizedName,
	});
	appendFileSync(binding.path, `${JSON.stringify(append.entry)}\n`);
	commitTrailAppend(binding, append);
}

export function appendKernelObservation(
	binding: TrailBinding,
	input: {
		frameType: "prompt" | "steer" | "follow_up" | "staff_intro";
		message: string;
		attended: boolean;
		origin: string;
		intent: KernelIntentCapability;
		images: Array<{ mimeType: string; sha256: string; bytes: number }>;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_input", input);
}

export function appendKernelModelObservation(
	binding: TrailBinding,
	input: {
		event: "request" | "intent";
		intentNonce: string;
		requestHash: string;
		provider?: string;
		model?: string;
		requestSha256?: string;
		status: "started" | "completed" | "failed" | "aborted" | ModelIntentTerminalStatus;
		reservation?: { inputTokens: number; outputTokens: number; costUsd: number };
		usage?: { inputTokens: number; outputTokens: number; costUsd: number; calls?: number };
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_model_request", input);
}

export function appendKernelWakeObservation(
	binding: TrailBinding,
	input: {
		/** Kernel-issued causal identity for this wake. */
		wakeId: string;
		cause: "schedule" | "founder_response" | "inbound_event" | "agent_message";
		intervalMinutes?: number;
		/** Whole missed intervals coalesced into this wake (missed-wake policy). */
		coalesced?: number;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_wake", input);
}

/** Durable end-of-session marker, appended by the kernel when it releases a
 * child. Classification (Activity/Agents) reads it to distinguish "the kernel
 * closed this session" from "this trail just stopped growing" — without it,
 * liveness is a 30-minute mtime guess. `settled` records whether the child was
 * idle (post agent_settled) or mid-turn when the kernel released it. */
export function appendKernelSessionEndObservation(
	binding: TrailBinding,
	input: {
		settled: boolean;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_session_end", input);
}

/** Durable evidence for an unexpected provider-process exit. The trail stays
 * the session identity; this records why its replaceable runtime disappeared
 * before the kernel resumes the same file. */
export function appendKernelRuntimeExitObservation(
	binding: TrailBinding,
	input: {
		code: number | null;
		signal: NodeJS.Signals | null;
		busy: boolean;
		stderr: string;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_runtime_exit", input);
}

/** Canonical lifecycle event consumed by the kernel session projector. The
 * trail is the event log; the projected runtime state is always rebuildable
 * from these observations after a renderer or kernel restart. */
export function appendKernelSessionRuntimeObservation(
	binding: TrailBinding,
	input: {
		kind: string;
		at: string;
		kernelInstanceId: string;
		executorId: string;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_session_runtime", input);
}

export function appendKernelHttpObservation(
	binding: TrailBinding,
	input: {
		requestId: string;
		method: string;
		host: string;
		/** The URL exactly as the child sent it — secret references unresolved. */
		url: string;
		requestSha256: string;
		behavior?: { path: string; contentHash: string };
		status: "started" | "completed" | "failed" | "denied";
		deniedReason?: string;
		httpStatus?: number;
		bodyBytes?: number;
		/** File mode: company-relative paths streamed into / out of. */
		savedTo?: string;
		sentFile?: string;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_http_request", input);
}

/** Reconstructable record of the agent's visible computer navigation. Page
 * contents and screenshots stay out of the trail; it records only the action,
 * URL, and outcome needed to explain how a user handoff was reached. */
export function appendKernelComputerObservation(
	binding: TrailBinding,
	input: {
		requestId: string;
		action: string;
		url?: string;
		status: "started" | "completed" | "failed" | "denied" | "handoff";
		detail?: string;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_computer_action", input);
}

/** Portable connector reconstruction record. Secret values and provider
 * payloads never enter the request record; secretNames are opaque capability
 * references that tell a future agent what support must be rebound. */
export function appendKernelConnectionObservation(
	binding: TrailBinding,
	input: {
		version: 1;
		request: ConnectionRequest;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_connection", input);
}

export function appendKernelMutationObservation(
	binding: TrailBinding,
	input: {
		operation: string;
		exactReview: string;
		approved: boolean;
		phase: "decision" | "result";
		resultStatus?: number;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_founder_mutation", input);
}

export function appendKernelProductStorageObservation(
	binding: TrailBinding,
	input: {
		status: "hydration-required";
		paths: Array<{ path: string; kind: "repository" | "worktree" }>;
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_product_storage", input);
}

function appendKernelGateObservation(
	binding: TrailBinding,
	input: {
		requestId?: string;
		file: string;
		hash: string;
		transition: "created" | "creation-aborted" | "consumed" | "orphan-reset" | "trusted-use";
		phase: "started" | "completed";
	},
): void {
	appendKernelCustomObservation(binding, "qorpera_kernel_gate_transition", input);
}

function trailHasGateTransition(
	root: string,
	trailFile: string,
	file: string,
	hash: string,
	transition: "created" | "creation-aborted",
	phase: "started" | "completed",
): boolean {
	const path = assertPhysicalCompanyTree(root, join("trail", trailFile));
	loadTrailAudit(path);
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/).slice(1)) {
		if (!line) continue;
		const entry = JSON.parse(line) as SessionEntry;
		if (entry.type !== "custom" || entry.customType !== "qorpera_kernel_gate_transition") continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (data?.file === file && data.hash === hash && data.transition === transition && data.phase === phase)
			return true;
	}
	return false;
}

export function reconcileKernelGateCreations(
	binding: TrailBinding,
	root: string,
	pending: Array<{
		file: string;
		hash: string;
		trailFile: string;
		phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted";
	}>,
	advance: (
		file: string,
		hash: string,
		trailFile: string,
		phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted",
	) => void,
	complete: (file: string, hash: string) => void,
): void {
	for (const creation of pending) {
		let phase = creation.phase;
		let trailFile = creation.trailFile;
		if (phase === "planned") {
			if (trailHasGateTransition(root, trailFile, creation.file, creation.hash, "created", "started")) {
				phase = "started";
				advance(creation.file, creation.hash, trailFile, phase);
			} else {
				trailFile = binding.file;
				advance(creation.file, creation.hash, trailFile, "planned");
				appendKernelGateObservation(binding, {
					file: creation.file,
					hash: creation.hash,
					transition: "created",
					phase: "started",
				});
				phase = "started";
				advance(creation.file, creation.hash, trailFile, phase);
			}
		}
		if (phase === "started") {
			const path = join(root, "inbox", creation.file);
			let transition: "created" | "creation-aborted" = "creation-aborted";
			if (existsSync(path)) {
				assertPhysicalCompanyTree(root, join("inbox", creation.file));
				const record = parseGateDocument(creation.file, readFileSync(path, "utf-8"));
				if (!record || record.hash !== creation.hash) {
					throw new Error(`Pending host gate creation is not canonical: ${creation.file}`);
				}
				transition = "created";
			}
			phase = transition === "created" ? "finalizing-created" : "finalizing-aborted";
			trailFile = binding.file;
			advance(creation.file, creation.hash, trailFile, phase);
		}
		const transition = phase === "finalizing-created" ? "created" : "creation-aborted";
		if (!trailHasGateTransition(root, trailFile, creation.file, creation.hash, transition, "completed")) {
			if (trailFile !== binding.file) {
				trailFile = binding.file;
				advance(creation.file, creation.hash, trailFile, phase);
			}
			appendKernelGateObservation(binding, {
				file: creation.file,
				hash: creation.hash,
				transition,
				phase: "completed",
			});
		}
		complete(creation.file, creation.hash);
	}
}

const GATE_EFFECT_CLASSES = new Set(["money", "identity", "irreversible", "authority", "product_code"]);
const GATE_FIELDS = ["id", "status", "class", "tool", "hash", "created"] as const;
// Written by founder-context approval (signGateApproval); the child-side
// authority parser owns its semantics — the kernel must tolerate it, or a
// founder-identity machine's approved records stop parsing here entirely.
const OPTIONAL_GATE_FIELDS = ["approval"] as const;

interface ParsedGateDocument {
	id: string;
	status: "pending" | "approved" | "denied" | "consumed";
	hash: string;
	tool: string;
	content: string;
}

function parseGateDocument(file: string, content: string): ParsedGateDocument | undefined {
	const normalized = content.replace(/^\uFEFF/, "");
	const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
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
	const id = fields.get("id")!;
	const status = fields.get("status")!;
	const hash = fields.get("hash")!;
	if (`${id}.md` !== file || !/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?$/.test(id)) return undefined;
	if (!/^(pending|approved|denied|consumed)$/.test(status) || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
	if (!GATE_EFFECT_CLASSES.has(fields.get("class")!) || !fields.get("tool") || !fields.get("created"))
		return undefined;
	return {
		id,
		status: status as ParsedGateDocument["status"],
		hash,
		tool: fields.get("tool")!,
		content: normalized,
	};
}

/** Exact canonical pending record the trusted kernel shows before a founder transition. */
export function kernelGateReviewDocument(
	root: string,
	file: string,
	action: "approved" | "denied" = "approved",
): string | undefined {
	if (!/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?\.md$/.test(file)) return undefined;
	try {
		const record = parseGateDocument(file, readFileSync(join(root, "inbox", file), "utf-8"));
		if (record?.status === "pending") return record.content;
		if (
			action === "denied" &&
			record?.status === "consumed" &&
			(record.tool === "behavior_signature" || record.tool === "extension_load")
		)
			return record.content;
		return undefined;
	} catch {
		return undefined;
	}
}

function canonicalGateEffectClass(
	root: string,
	binding: TrailBinding,
	gate: NonNullable<KernelWriteFrame["gate"]>,
): string | undefined {
	if (gate.toolName === "behavior_signature" || gate.toolName === "extension_load") return "authority";
	const authority = discoverAuthority(binding.cwd);
	if (!authority || resolve(authority.root) !== resolve(root)) return undefined;
	return classifyToolCall(authority, readAuthorityConfig(authority), gate.toolName, gate.args, binding.cwd);
}

function canonicalGateContent(
	root: string,
	binding: TrailBinding,
	gate: NonNullable<KernelWriteFrame["gate"]>,
): string | undefined {
	const effectClass = canonicalGateEffectClass(root, binding, gate);
	if (
		`${gate.id}.md` !== gate.file ||
		!/^gate-[a-f0-9]{8}(?:-[2-9][0-9]*)?$/.test(gate.id) ||
		!gate.id.startsWith(`gate-${gate.hash.slice(0, 8)}`) ||
		!/^[a-f0-9]{64}$/.test(gate.hash) ||
		!effectClass ||
		!GATE_EFFECT_CLASSES.has(effectClass) ||
		effectClass !== gate.effectClass ||
		requestHash(gate.toolName, gate.args) !== gate.hash ||
		!gate.toolName ||
		gate.toolName.length > 128 ||
		/[\r\n]/.test(gate.toolName)
	)
		return undefined;
	let serializedArgs: string;
	try {
		serializedArgs = JSON.stringify(gate.args, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(serializedArgs, "utf-8") > 1024 * 1024) return undefined;
	return [
		"---",
		`id: ${gate.id}`,
		"status: pending   # resolved by Qorpera Base native review",
		`class: ${effectClass}`,
		`tool: ${gate.toolName}`,
		`hash: ${gate.hash}`,
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		`# Gate request: ${gate.toolName} (${effectClass})`,
		"",
		"**Exact tool:**",
		"",
		`    ${gate.toolName}`,
		"",
		"**Exact arguments:**",
		"",
		...serializedArgs.split("\n").map((line) => `    ${line}`),
		"",
		"**If denied:** the agent will not perform this action and will pursue another path.",
		"",
		"Resolve this request through Qorpera Base's native review UI.",
		"",
	].join("\n");
}

function transitionGate(
	path: string,
	file: string,
	record: ParsedGateDocument,
	status: ParsedGateDocument["status"],
): void {
	const lines = record.content.split(/\r?\n/);
	const statusLines = lines.flatMap((line, index) => (/^status:\s*/.test(line) ? [index] : []));
	if (statusLines.length !== 1) throw new Error("gate status transition requires exactly one canonical status field");
	lines[statusLines[0]] = `status: ${status}`;
	const next = `${lines.join("\n")}${record.content.endsWith("\n") ? "\n" : ""}`;
	if (!parseGateDocument(file, next)) throw new Error("gate status transition produced an invalid record");
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, next, { encoding: "utf-8", flag: "wx" });
	renameSync(temporary, path);
}

export function commitTrailAppend(binding: TrailBinding, append: TrailAppendFrame): void {
	const kernel = append.entry.kernel;
	if (
		!kernel ||
		kernel.sequence !== binding.audit.sequence + 1 ||
		kernel.previousHash !== (binding.audit.lastHash || null)
	) {
		throw new Error("trail append integrity state changed before commit");
	}
	binding.audit.ids.add(append.entry.id);
	binding.audit.sequence = kernel.sequence;
	binding.audit.lastHash = kernel.hash;
}

export function applyKernelWriteFrame(
	value: unknown,
	binding: TrailBinding,
	root: string,
	onGateResponse?: (response: KernelGateResponseBody) => void,
	consumeGateCapability?: (file: string, hash: string) => boolean,
	durableGateTrust?: {
		has: (file: string, hash: string) => boolean;
		remember: (file: string, hash: string) => void;
	},
	gateCreation?: {
		begin: (file: string, hash: string, trailFile: string) => void;
		advance: (
			file: string,
			hash: string,
			trailFile: string,
			phase: "planned" | "started" | "finalizing-created" | "finalizing-aborted",
		) => void;
		complete: (file: string, hash: string) => void;
	},
): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as Partial<KernelWriteFrame>;
	if (frame.type !== "qorpera_kernel_write") return false;
	if (frame.token !== binding.token) return true;
	const inbox = assertPhysicalCompanyTree(root, "inbox");
	if (frame.operation === "create_gate") {
		if (!frame.gate) return true;
		const content = canonicalGateContent(root, binding, frame.gate);
		if (!content) return true;
		const path = join(inbox, frame.gate.file);
		if (existsSync(path)) return true;
		gateCreation?.begin(frame.gate.file, frame.gate.hash, binding.file);
		appendKernelGateObservation(binding, {
			file: frame.gate.file,
			hash: frame.gate.hash,
			transition: "created",
			phase: "started",
		});
		gateCreation?.advance(frame.gate.file, frame.gate.hash, binding.file, "started");
		let created = false;
		try {
			writeFileSync(path, content, { encoding: "utf-8", flag: "wx" });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		gateCreation?.advance(
			frame.gate.file,
			frame.gate.hash,
			binding.file,
			created ? "finalizing-created" : "finalizing-aborted",
		);
		if (created) {
			appendKernelGateObservation(binding, {
				file: frame.gate.file,
				hash: frame.gate.hash,
				transition: "created",
				phase: "completed",
			});
		} else {
			appendKernelGateObservation(binding, {
				file: frame.gate.file,
				hash: frame.gate.hash,
				transition: "creation-aborted",
				phase: "completed",
			});
		}
		gateCreation?.complete(frame.gate.file, frame.gate.hash);
		return true;
	}
	if (frame.operation === "create_message") {
		if (
			typeof frame.requestId !== "string" ||
			typeof frame.file !== "string" ||
			!/^msg-[a-z0-9][a-z0-9-]{0,119}\.md$/i.test(frame.file) ||
			typeof frame.content !== "string" ||
			Buffer.byteLength(frame.content, "utf-8") > 64 * 1024 ||
			typeof frame.hash !== "string" ||
			createHash("sha256").update(frame.content).digest("hex") !== frame.hash
		) {
			return true;
		}
		let granted = false;
		try {
			writeFileSync(join(inbox, "messages", frame.file), frame.content, { encoding: "utf-8", flag: "wx" });
			granted = true;
			appendKernelCustomObservation(binding, "qorpera_kernel_inbox_message", {
				file: frame.file,
				hash: frame.hash,
				content: frame.content,
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted });
		return true;
	}
	if (frame.operation === "consume_gate" || frame.operation === "trust_gate") {
		if (
			frame.status !== "consumed" ||
			!frame.file ||
			!/^gate-[a-z0-9-]+\.md$/i.test(frame.file) ||
			typeof frame.requestId !== "string" ||
			typeof frame.hash !== "string"
		)
			return true;
		const path = join(inbox, frame.file);
		let record: ParsedGateDocument | undefined;
		try {
			record = parseGateDocument(frame.file, readFileSync(path, "utf-8"));
		} catch {
			onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted: false });
			return true;
		}
		const matchesHash = Boolean(record && record.hash === frame.hash);
		const durableTool = Boolean(record && (record.tool === "behavior_signature" || record.tool === "extension_load"));
		if (
			frame.operation === "trust_gate" &&
			matchesHash &&
			durableTool &&
			record?.status === "consumed" &&
			durableGateTrust?.has(frame.file, frame.hash)
		) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "trusted-use",
				phase: "completed",
			});
			onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted: true });
			return true;
		}
		const matchesApprovedRecord = Boolean(matchesHash && record?.status === "approved");
		const capabilityGranted = Boolean(matchesApprovedRecord && consumeGateCapability?.(frame.file, frame.hash));
		const granted = Boolean(
			capabilityGranted && (frame.operation === "consume_gate" || (durableTool && durableGateTrust)),
		);
		if (granted && record) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "consumed",
				phase: "started",
			});
			transitionGate(path, frame.file, record, "consumed");
			if (frame.operation === "trust_gate") durableGateTrust?.remember(frame.file, frame.hash);
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "consumed",
				phase: "completed",
			});
		} else if (
			matchesHash &&
			record &&
			(record.status === "approved" || (frame.operation === "trust_gate" && record.status === "consumed"))
		) {
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "orphan-reset",
				phase: "started",
			});
			transitionGate(path, frame.file, record, "pending");
			appendKernelGateObservation(binding, {
				requestId: frame.requestId,
				file: frame.file,
				hash: frame.hash,
				transition: "orphan-reset",
				phase: "completed",
			});
		}
		onGateResponse?.({ requestId: frame.requestId, file: frame.file, hash: frame.hash, granted });
		return true;
	}
	if (frame.operation === "append_notice") {
		if (typeof frame.message !== "string" || Buffer.byteLength(frame.message) > 4096) return true;
		const path = join(inbox, "notices.md");
		const prefix = existsSync(path) ? "" : "# Notices\n\n";
		appendFileSync(path, `${prefix}- ${new Date().toISOString()} ${frame.message.replace(/[\r\n]+/g, " ")}\n`);
	}
	return true;
}

function kernelResponsePayload(response: KernelGateResponseBody): string {
	return JSON.stringify({
		requestId: response.requestId,
		file: response.file,
		hash: response.hash,
		granted: response.granted,
	});
}

function kernelBindingPayload(response: { nonce: string; sessionId: string }): string {
	return JSON.stringify({ nonce: response.nonce, sessionId: response.sessionId });
}

function kernelIntentPayload(intent: Omit<KernelIntentCapability, "signature">): string {
	return JSON.stringify({
		nonce: intent.nonce,
		sessionId: intent.sessionId,
		requestHash: intent.requestHash,
		attended: intent.attended,
		issuedAt: intent.issuedAt,
		expiresAt: intent.expiresAt,
		budget: {
			maxCalls: intent.budget.maxCalls,
			maxInputTokens: intent.budget.maxInputTokens,
			maxOutputTokens: intent.budget.maxOutputTokens,
			maxCostUsd: intent.budget.maxCostUsd,
		},
	});
}

function intentRequestHash(frame: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify(frame)).digest("hex");
}

/** Founder call (2026-08-13): the company agent runs at full permission on the
 * founder's own machine — no call, token, or dollar ceilings on their work
 * (the codex full-access posture). The signed-intent structure is unchanged:
 * every model call still rides a kernel-signed intent and every request and
 * its usage still land in the trail — the ceilings simply no longer bite.
 * Bounded budgets remain one option away via createKernelResponseSigner's
 * modelBudget parameter for lanes that want them. */
export const DEFAULT_MODEL_INTENT_BUDGET: Readonly<KernelModelIntentBudget> = Object.freeze({
	maxCalls: Number.MAX_SAFE_INTEGER,
	maxInputTokens: Number.MAX_SAFE_INTEGER,
	maxOutputTokens: Number.MAX_SAFE_INTEGER,
	maxCostUsd: Number.MAX_SAFE_INTEGER,
});

const DEFAULT_MODEL_INTENT_LIFETIME_MS = 30 * 60 * 1000;
const MAX_MODEL_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;

function checkedModelIntentBudget(budget: KernelModelIntentBudget): KernelModelIntentBudget {
	if (
		!Number.isInteger(budget.maxCalls) ||
		budget.maxCalls < 1 ||
		!Number.isInteger(budget.maxInputTokens) ||
		budget.maxInputTokens < 1 ||
		!Number.isInteger(budget.maxOutputTokens) ||
		budget.maxOutputTokens < 1 ||
		!Number.isFinite(budget.maxCostUsd) ||
		budget.maxCostUsd < 0
	) {
		throw new Error("host model intent budget is invalid");
	}
	return { ...budget };
}

export function createKernelResponseSigner(options: {
	sessionId: string;
	modelBudget?: KernelModelIntentBudget;
	intentLifetimeMs?: number;
}): {
	publicKey: string;
	signResponse: (response: KernelGateResponseBody) => SignedKernelGateResponse;
	signBinding: (response: { nonce: string; sessionId: string }) => SignedKernelBindingResponse;
	signIntent: (frame: Record<string, unknown>, attended: boolean) => KernelIntentCapability;
} {
	if (!options.sessionId) throw new Error("host intent signer requires a session id");
	const budget = checkedModelIntentBudget(options.modelBudget ?? DEFAULT_MODEL_INTENT_BUDGET);
	const lifetimeMs = options.intentLifetimeMs ?? DEFAULT_MODEL_INTENT_LIFETIME_MS;
	if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_MODEL_INTENT_LIFETIME_MS) {
		throw new Error("host model intent lifetime is invalid");
	}
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
	return {
		publicKey,
		signResponse: (response) => ({
			type: "qorpera_kernel_response",
			...response,
			signature: sign(null, Buffer.from(kernelResponsePayload(response)), pair.privateKey).toString("base64"),
		}),
		signBinding: (response) => ({
			type: "qorpera_kernel_binding",
			...response,
			signature: sign(null, Buffer.from(kernelBindingPayload(response)), pair.privateKey).toString("base64"),
		}),
		signIntent: (frame, attended) => {
			const issuedAtMs = Date.now();
			const intent = {
				nonce: randomUUID(),
				sessionId: options.sessionId,
				requestHash: intentRequestHash(frame),
				attended,
				issuedAt: new Date(issuedAtMs).toISOString(),
				expiresAt: new Date(issuedAtMs + lifetimeMs).toISOString(),
				budget: { ...budget },
			};
			return {
				...intent,
				signature: sign(null, Buffer.from(kernelIntentPayload(intent)), pair.privateKey).toString("base64"),
			};
		},
	};
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

/**
 * The child environment allowlist (credential denial, docs/sandbox.md): no
 * provider keys or founder state reach an agent child. Everything here is
 * machine shape, not secrets. ProgramFiles / ProgramFiles(x86) are
 * load-bearing on Windows: the coding agent's bash tool probes
 * %ProgramFiles%\Git\bin\bash.exe first, and without them its PATH fallback
 * finds the System32 WSL stub, which cannot run inside the offline sandbox —
 * every bash call then fails and kernel-spawned staff or scheduled sessions
 * are left without a shell.
 */
export const SAFE_CHILD_ENV = new Set([
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"LANG",
	"LC_ALL",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"USERNAME",
	"USERDOMAIN",
]);

export function brokeredChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	// Windows environment names are case-insensitive and their casing depends
	// on the launching shell ("Path" from Explorer, "PATH"/"PROGRAMFILES" from
	// an MSYS terminal), so the allowlist must match case-insensitively there
	// or load-bearing variables silently vanish from the child.
	if (process.platform !== "win32") {
		return Object.fromEntries(Object.entries(source).filter(([key, value]) => SAFE_CHILD_ENV.has(key) && value));
	}
	const allowed = new Set([...SAFE_CHILD_ENV].map((name) => name.toUpperCase()));
	return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toUpperCase()) && value));
}

/**
 * Git sees the Windows sandbox account as a different owner from the founder
 * and otherwise refuses even read-only commands with "dubious ownership".
 * Supply protected command-scope config for only the repositories this child
 * is already authorized to access. This avoids a machine-global wildcard,
 * ignores inherited Git config, and keeps credential prompts disabled.
 */
export function sandboxGitEnvironment(safeDirectories: string[]): Record<string, string> {
	const normalized = [
		...new Set(
			safeDirectories.map((path) => {
				const directory = resolve(path);
				return process.platform === "win32" ? directory.replaceAll("\\", "/") : directory;
			}),
		),
	];
	const env: Record<string, string> = {
		GIT_ATTR_NOSYSTEM: "1",
		GIT_CONFIG_COUNT: String(normalized.length),
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const [index, directory] of normalized.entries()) {
		env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
		env[`GIT_CONFIG_VALUE_${index}`] = directory;
	}
	return env;
}

export function writeSandboxProfile(
	configDir: string,
	runtimeDir: string,
	companyRoot: string,
	scope: AgentScope,
	protectedPaths: string[],
	foundationReadPaths: string[],
): string {
	mkdirSync(configDir, { recursive: true });
	mkdirSync(runtimeDir, { recursive: true });
	const permissions = new Map<string, "read" | "write">([
		[":minimal", "read"],
		[":tmpdir", "write"],
		[":slash_tmp", "write"],
		[resolve(runtimeDir), "write"],
		[resolve(companyRoot), scope.actor === "company-agent" ? "write" : "read"],
	]);
	for (const path of foundationReadPaths) permissions.set(resolve(path), "read");
	for (const path of protectedPaths) permissions.set(resolve(path), "read");
	if (scope.actor === "company-agent") {
		// The one sanctioned agent-writable inbox lane (authority.ts
		// isProtectedPath): the company agent authors inbox/messages/msg-*.md
		// items. The OS grant is directory-level; which FILES inside are
		// legitimate stays enforced at the tool boundary. Gate records and
		// notices live at inbox/ root and remain read-only here.
		permissions.set(join(resolve(companyRoot), "inbox", "messages"), "write");
	}
	if (scope.actor === "product-worker") {
		const worktree = resolve(companyRoot, scope.worktree!);
		permissions.set(worktree, "write");
		permissions.set(join(worktree, ".git"), "read");
	}

	const filesystem = [...permissions]
		.map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`)
		.join("\n");
	const windows = process.platform === "win32" ? '\n[windows]\nsandbox = "elevated"\n' : "";
	const config = `default_permissions = "qorpera-agent"\n${windows}\n[features]\nnetwork_proxy = false\n\n[network]\nenabled = false\n\n[permissions.qorpera-agent.filesystem]\n${filesystem}\n\n[permissions.qorpera-agent.network]\nenabled = false\n`;
	const configPath = join(configDir, "config.toml");
	writeFileSync(configPath, config, "utf-8");
	return configPath;
}

export function sandboxCommandArgs(codexEntry: string, runtimeDir: string, program: string, args: string[]): string[] {
	return [
		codexEntry,
		"sandbox",
		"--permission-profile",
		"qorpera-agent",
		"-C",
		resolve(runtimeDir),
		"--",
		program,
		...args,
	];
}

/**
 * Spawn shape for a sandboxCommandArgs() invocation. A native codex.exe entry
 * is executed directly (spawning it through the npm wrapper script would
 * re-spawn the binary without windowsHide and flash a console window on
 * Windows); a wrapper-script entry runs under the given node executable.
 */
export function codexSpawn(
	codexEntry: string,
	nodeExecutable: string,
	sandboxArgs: string[],
): { command: string; args: string[] } {
	if (codexEntry.toLowerCase().endsWith(".exe")) return { command: codexEntry, args: sandboxArgs.slice(1) };
	return { command: nodeExecutable, args: sandboxArgs };
}

interface KillableChild {
	pid?: number;
	exitCode: number | null;
	kill: (signal?: NodeJS.Signals | number) => boolean;
}

/**
 * Kill an agent child and its whole process tree. The direct child is
 * codex.exe ("sandbox" subcommand) wrapping the actual agent process, and on
 * Windows ChildProcess.kill() terminates only the direct child — the wrapped
 * subtree survives (observed: codex.exe trees outliving the shell). taskkill
 * /T walks and kills the tree while the parent chain is still intact.
 */
export function killChildTree(child: KillableChild): void {
	if (child.exitCode !== null) return;
	if (process.platform === "win32" && child.pid) {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
			"error",
			() => child.kill(),
		);
		return;
	}
	child.kill();
}

/**
 * Synchronous variant for app quit: quit does not wait for async teardown,
 * so the reap must complete before the event loop dies or the tree leaks.
 */
export function killChildTreeSync(child: KillableChild): void {
	if (child.exitCode !== null) return;
	if (process.platform === "win32" && child.pid) {
		const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 10_000,
		});
		if (!result.error) return;
	}
	child.kill();
}

/**
 * The Codex Windows sandbox accounts (CodexSandboxOffline/Online) are
 * machine-global, but Codex stores their credentials and setup marker per
 * CODEX_HOME — and Qorpera mints a CODEX_HOME per company × actor. Left
 * alone, every config dir that provisions runs the elevated setup, resets
 * the global accounts' passwords, and thereby invalidates the secret every
 * OTHER config dir stored: with two companies on one machine the founder is
 * asked to approve the same elevation forever (observed: 100+ UAC prompts).
 *
 * Junction the state that describes those global accounts (.sandbox marker,
 * ACL record, logs; .sandbox-secrets DPAPI blobs) into one per-Windows-user
 * store, so a single approved setup satisfies every company and actor.
 * Nothing leaves Codex's control — the same files, one location. Existing
 * per-dir state is migrated newest-first so at most one further elevation
 * is requested after this ships.
 */
export function shareWindowsSandboxState(userData: string, configDir: string): void {
	if (process.platform !== "win32") return;
	// dirname(userData) is the per-user roaming AppData root, so dev
	// (…\Electron) and packaged (…\Qorpera Base) shells converge on one store.
	const sharedRoot = join(dirname(userData), "Qorpera", "agent-sandbox-shared");
	mkdirSync(configDir, { recursive: true });
	for (const name of [".sandbox", ".sandbox-secrets"]) {
		const shared = join(sharedRoot, name);
		mkdirSync(shared, { recursive: true });
		const local = join(configDir, name);
		let existing: ReturnType<typeof lstatSync> | undefined;
		try {
			existing = lstatSync(local);
		} catch {
			existing = undefined;
		}
		if (existing?.isSymbolicLink()) continue;
		if (existing) {
			for (const entry of readdirSync(local)) {
				const source = join(local, entry);
				const target = join(shared, entry);
				try {
					if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs) continue;
					rmSync(target, { recursive: true, force: true });
					renameSync(source, target);
				} catch {
					// A file the migration cannot move (locked log, permission) only
					// costs one more elevated setup — never block the company agent.
				}
			}
			rmSync(local, { recursive: true, force: true });
		}
		symlinkSync(shared, local, "junction");
	}
}

/**
 * Exercise the bundled Codex sandbox before an agent is started. On a clean
 * Windows profile this invokes Codex's supported elevated setup path; on an
 * existing profile Codex validates and refreshes its own ACL/firewall state
 * against the shared per-user store (shareWindowsSandboxState above).
 */
export function provisionWindowsSandbox(options: {
	codexEntry: string;
	configDir: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	if (process.platform !== "win32") return;
	const env = {
		...options.env,
		CODEX_HOME: options.configDir,
		ELECTRON_RUN_AS_NODE: "1",
	};
	const systemRoot = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? options.env.WINDIR;
	if (!systemRoot) {
		throw new Error("Bundled Codex Windows sandbox provisioning failed: Windows system root is unavailable.");
	}
	const whoami = join(systemRoot, "System32", "whoami.exe");
	const identityInvocation = codexSpawn(
		options.codexEntry,
		options.nodeExecutable,
		sandboxCommandArgs(options.codexEntry, options.runtimeDir, whoami, []),
	);
	const identity = spawnSync(identityInvocation.command, identityInvocation.args, {
		cwd: options.runtimeDir,
		env,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
		timeout: 10 * 60 * 1000,
		windowsHide: true,
	});
	if (
		identity.error ||
		identity.status !== 0 ||
		!identity.stdout.trim().toLowerCase().includes("codexsandboxoffline")
	) {
		const detail = [identity.error?.message, identity.stderr, identity.stdout]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n")
			.trim()
			.slice(0, 4096);
		throw new Error(
			`Bundled Codex Windows sandbox provisioning failed; Qorpera will not start the agent runtime.${detail ? `\n${detail}` : ""}`,
		);
	}

	assertSandboxNetworkIsolation({ ...options, env });
}

/**
 * Exercise the effective offline identity, not only the sandbox's setup
 * marker. Any successful direct HTTPS request means network isolation is
 * absent or stale, so the company agent must not start.
 */
function assertSandboxNetworkIsolation(options: {
	codexEntry: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	const networkInvocation = codexSpawn(
		options.codexEntry,
		options.nodeExecutable,
		sandboxCommandArgs(options.codexEntry, options.runtimeDir, options.nodeExecutable, [
			"-e",
			'Promise.any([fetch("https://example.com/"),fetch("https://api.openai.com/")]).then(()=>process.exit(42),()=>process.exit(0))',
		]),
	);
	const network = spawnSync(networkInvocation.command, networkInvocation.args, {
		cwd: options.runtimeDir,
		env: options.env,
		encoding: "utf-8",
		maxBuffer: 1024 * 1024,
		timeout: 30_000,
		windowsHide: true,
	});
	if (network.error || network.status !== 0) {
		const detail = [network.error?.message, network.stderr, network.stdout]
			.filter((value): value is string => Boolean(value?.trim()))
			.join("\n")
			.trim()
			.slice(0, 4096);
		throw new Error(
			`Bundled Codex sandbox network isolation failed; Qorpera will not start the agent runtime.${detail ? `\n${detail}` : ""}`,
		);
	}
}

/**
 * Fail-closed sandbox verification on every platform (manifesto §7.2 —
 * isolation strength is stated honestly or the company agent does not start).
 * Windows adds the Codex offline-identity check; every platform must prove
 * network isolation is actually enforced before an agent runs. If the
 * bundled sandbox no-ops on a platform, the probe's fetch succeeds and the
 * kernel refuses to start rather than running an agent with an unenforced
 * profile.
 */
export function provisionSandbox(options: {
	codexEntry: string;
	configDir: string;
	runtimeDir: string;
	nodeExecutable: string;
	env: NodeJS.ProcessEnv;
}): void {
	if (process.platform === "win32") {
		provisionWindowsSandbox(options);
		return;
	}
	assertSandboxNetworkIsolation({
		...options,
		env: { ...options.env, CODEX_HOME: options.configDir, ELECTRON_RUN_AS_NODE: "1" },
	});
}

export function protectedCompanyAgentPaths(
	root: string,
	productPaths: Array<{ repository: string; worktrees: string }>,
): string[] {
	return [
		join(root, ".git"),
		join(root, "trail"),
		join(root, "authority.toml"),
		join(root, ".qorpera"),
		join(root, "inbox"),
		...productPaths.flatMap((product) => [join(root, product.repository), join(root, product.worktrees)]),
	].filter((path) => existsSync(path));
}

export function inboxMessagesPath(root: string): string {
	return assertPhysicalCompanyTree(root, join("inbox", "messages"));
}

export function sandboxConfigDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	return join(userData, "agent-sandbox", sandboxRootId(root), actor);
}

export function sandboxRuntimeDir(
	userData: string,
	root: string,
	actor: AgentScope["actor"],
	capabilityId: string,
): string {
	if (!/^[0-9a-f-]{36}$/i.test(capabilityId)) throw new Error("sandbox runtime requires a capability identifier");
	if (process.platform === "win32") {
		const programData = process.env.ProgramData ?? process.env.PROGRAMDATA;
		if (!programData) throw new Error("Qorpera sandbox runtime requires the Windows ProgramData directory");
		return join(programData, "Qorpera", "agent-sandbox-runtime", sandboxRootId(root), actor, capabilityId);
	}
	return join(dirname(sandboxConfigDir(userData, root, actor)), "runtime", actor, capabilityId);
}

function sandboxRootId(root: string): string {
	const resolvedRoot = resolve(root);
	return createHash("sha256")
		.update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
		.digest("hex");
}
