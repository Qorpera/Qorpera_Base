import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
	classifyToolCall,
	discoverAuthority,
	readAuthorityConfig,
	requestHash,
} from "@qorpera/pi-coding-agent/authority";
import type {
	KernelExecutionIdentity,
	KernelIntentCapability,
	KernelModelIntentBudget,
	ModelIntentTerminalStatus,
} from "@qorpera/pi-protocol";
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
	/** Durable multi-staff room whose context this staff runtime carries. */
	roomId?: string;
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
	/** Cloud revisions whose materialized state this executor actually used. */
	companySnapshotId?: string;
	staffVersion?: number;
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
	roomId?: string;
	autonomousLabel?: string;
	department?: string;
	worktree?: string;
	group?: string;
	parentSession?: string;
	companySnapshotId?: string;
	staffVersion?: number;
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

const trailExecutions = new WeakMap<TrailBinding, KernelExecutionIdentity>();

export function bindTrailExecution(binding: TrailBinding, execution?: KernelExecutionIdentity): void {
	if (!execution) {
		trailExecutions.delete(binding);
		return;
	}
	if (
		(execution.kind !== "turn" && execution.kind !== "wake") ||
		!UUID_PATTERN.test(execution.id) ||
		!UUID_PATTERN.test(execution.claimantId)
	) {
		throw new Error("Trail execution identity is invalid");
	}
	trailExecutions.set(binding, { ...execution });
}

export interface TrailAppendFrame {
	type: "qorpera_trail_append";
	token: string;
	entry: SessionEntry;
}

export interface RunnerTrailExecutionIdentity {
	kind: "run";
	id: string;
	claimantId: string;
	runnerAssignmentId: string;
}

export type TrailExecutionIdentity = KernelExecutionIdentity | RunnerTrailExecutionIdentity;

/** Portable conversation entry. Local kernel stamps are deliberately absent:
 * each machine verifies and re-stamps materialized events into its own trail. */
export interface SharedTrailEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	execution?: TrailExecutionIdentity;
	[key: string]: unknown;
}

export interface SharedTrailScope {
	attended: boolean;
	staffAgentId?: string;
	roomId?: string;
	autonomousLabel?: string;
	group?: string;
	parentSession?: string;
	companySnapshotId?: string;
	staffVersion?: number;
}

export interface SharedTrailSession {
	localSessionId: string;
	trailFile: string;
	createdAt: string;
	title: string;
	staffAgentId?: string;
	scope?: SharedTrailScope;
	entries: SharedTrailEntry[];
}

export interface SharedTrailMaterialization {
	localSessionId: string;
	createdAt: string;
	title: string;
	staffAgentId?: string;
	scope?: SharedTrailScope;
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
	if (
		scope.roomId !== undefined &&
		(typeof scope.roomId !== "string" || !scope.roomId.trim() || scope.roomId.length > 128)
	) {
		throw new Error("room identity must be a non-empty string of at most 128 characters");
	}
	if (scope.roomId !== undefined && scope.staffAgentId === undefined) {
		throw new Error("room sessions require a staff agent identity");
	}
	if ((scope.companySnapshotId === undefined) !== (scope.staffVersion === undefined)) {
		throw new Error("cloud execution revisions must be provided together");
	}
	if (scope.companySnapshotId !== undefined && !UUID_PATTERN.test(scope.companySnapshotId)) {
		throw new Error("company snapshot identity must be a UUID");
	}
	if (scope.staffVersion !== undefined && (!Number.isSafeInteger(scope.staffVersion) || scope.staffVersion < 1)) {
		throw new Error("staff version must be a positive integer");
	}
	return {
		actor: scope.actor,
		attended: scope.attended,
		staffAgentId: scope.staffAgentId,
		roomId: scope.roomId,
		autonomous: scope.autonomousLabel ? true : undefined,
		label: scope.autonomousLabel,
		department: scope.department,
		worktree: scope.worktree,
		group: scope.group,
		parentSession: scope.parentSession,
		companySnapshotId: scope.companySnapshotId,
		staffVersion: scope.staffVersion,
	};
}

function assertMatchingAuthority(actual: QorperaSessionAuthority | undefined, expected: QorperaSessionAuthority): void {
	if (!actual) throw new Error("legacy trail sessions have no trusted host binding and cannot be resumed");
	for (const key of [
		"actor",
		"staffAgentId",
		"roomId",
		"department",
		"worktree",
		"companySnapshotId",
		"staffVersion",
	] as const) {
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

function portableTrailEntries(path: string): SharedTrailEntry[] {
	const localEntries = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.slice(1)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
	const echoedUserMessages: Array<{ text: string; at: number }> = [];
	for (const entry of localEntries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as { role?: unknown; content?: unknown };
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content
			.map((part) =>
				part && typeof part === "object" && (part as { type?: unknown }).type === "text"
					? (part as { text?: unknown }).text
					: undefined,
			)
			.filter((part): part is string => typeof part === "string")
			.join("");
		if (text) echoedUserMessages.push({ text, at: Date.parse(entry.timestamp) });
	}
	const entries: SharedTrailEntry[] = [];
	const portableIds = new Set<string>();
	for (const entry of localEntries) {
		let candidate: SharedTrailEntry;
		if (entry.type === "custom" && entry.customType === "qorpera_kernel_input") {
			const data = entry.data;
			if (!data || typeof data !== "object" || Array.isArray(data)) continue;
			const input = data as { attended?: unknown; frameType?: unknown; message?: unknown };
			if (input.attended !== true || input.frameType !== "prompt" || typeof input.message !== "string") continue;
			const timestamp = Date.parse(entry.timestamp);
			if (
				echoedUserMessages.some(
					(message) => message.text === input.message && Math.abs(message.at - timestamp) <= 30_000,
				)
			)
				continue;
			candidate = {
				type: "message",
				id: `shared-input:${createHash("sha256").update(entry.id).digest("hex").slice(0, 32)}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: entry.timestamp,
				message: {
					role: "user",
					content: [{ type: "text", text: input.message }],
					timestamp,
				},
			};
		} else {
			if (entry.type === "custom" && entry.customType?.toString().startsWith("qorpera_kernel_")) continue;
			candidate = unsignedTrailEntry(entry) as SharedTrailEntry;
		}
		delete candidate.provenance;
		if (
			typeof candidate.timestamp !== "string" ||
			!Number.isFinite(Date.parse(candidate.timestamp)) ||
			(candidate.parentId !== null && !portableIds.has(candidate.parentId)) ||
			(candidate.type === "branch_summary" && !portableIds.has(candidate.fromId as string)) ||
			(candidate.type === "label" && !portableIds.has(candidate.targetId as string))
		) {
			continue;
		}
		const validationIds = new Set(portableIds);
		if (!validTrailEntry(candidate, validationIds)) continue;
		portableIds.add(candidate.id);
		entries.push(candidate);
	}
	return entries;
}

function sharedTrailTitle(entries: readonly SharedTrailEntry[], staffAgentId?: string): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
			return entry.name
				.replace(/[\r\n]+/g, " ")
				.trim()
				.slice(0, 256);
		}
	}
	return staffAgentId ? staffAgentId.replace(/[-_]+/g, " ").slice(0, 256) : "Founder chat";
}

function trailHasAttendedInput(path: string): boolean {
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/).slice(1)) {
		if (!line) continue;
		const entry = JSON.parse(line) as SessionEntry;
		if (entry.type !== "custom" || entry.customType !== "qorpera_kernel_input") continue;
		const data = entry.data;
		if (
			data &&
			typeof data === "object" &&
			!Array.isArray(data) &&
			(data as { attended?: unknown }).attended === true
		) {
			return true;
		}
	}
	return false;
}

/** Enumerate the cloud-portable company-agent trail. Product worktrees remain
 * under their own Git authority, but autonomous jobs, room deliveries, and
 * child-agent work are company operations and therefore belong in the shared
 * company history even when no person attended the turn. */
export function listSharedTrailSessions(
	root: string,
	options?: {
		/** Trail ids already registered as hosted sessions. Adoption IS the
		 * attendance: a staff-bootstrap trail carries attended:false, but once
		 * the arbiter registers its identity as the agent's one open session,
		 * excluding it from sync would strand the conversation on the machine
		 * that authored it — every other member sees a blank thread. */
		adoptedSessionIds?: ReadonlySet<string>;
	},
): SharedTrailSession[] {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	const sessions: SharedTrailSession[] = [];
	const sessionIds = new Set<string>();
	for (const file of readdirSync(trailDir)
		.filter((candidate) => candidate.endsWith(".jsonl"))
		.sort()) {
		const path = join(trailDir, file);
		const header = readHeader(path);
		const authority = header.qorpera;
		const operational = Boolean(
			authority?.autonomous || authority?.label || authority?.roomId || authority?.group || authority?.parentSession,
		);
		const attended = Boolean(
			authority?.attended || options?.adoptedSessionIds?.has(header.id) || trailHasAttendedInput(path),
		);
		if (
			header.version !== TRAIL_SESSION_VERSION ||
			!UUID_PATTERN.test(header.id) ||
			!authority ||
			authority.actor !== "company-agent" ||
			(!operational && !attended) ||
			authority.department ||
			authority.worktree
		) {
			continue;
		}
		loadTrailAudit(path);
		if (sessionIds.has(header.id)) throw new Error(`duplicate trail session identity: ${header.id}`);
		sessionIds.add(header.id);
		const entries = portableTrailEntries(path);
		if (entries.length === 0) continue;
		sessions.push({
			localSessionId: header.id,
			trailFile: file,
			createdAt: header.timestamp,
			title: sharedTrailTitle(entries, authority.staffAgentId),
			staffAgentId: authority.staffAgentId,
			scope: {
				attended,
				...(authority.staffAgentId ? { staffAgentId: authority.staffAgentId } : {}),
				...(authority.roomId ? { roomId: authority.roomId } : {}),
				...(authority.label ? { autonomousLabel: authority.label } : {}),
				...(authority.group ? { group: authority.group } : {}),
				...(authority.parentSession ? { parentSession: authority.parentSession } : {}),
				...(authority.companySnapshotId ? { companySnapshotId: authority.companySnapshotId } : {}),
				...(authority.staffVersion ? { staffVersion: authority.staffVersion } : {}),
			},
			entries,
		});
	}
	return sessions;
}

/** Read the kernel-bound staff identity for a local trail. Callers use this
 * to restore the correct staff runtime when a shared conversation is opened;
 * the renderer never supplies or overrides the identity. */
export function trailSessionStaffAgentId(root: string, sessionFile: string): string | undefined {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
		throw new Error("trail session must be a JSONL filename inside the company trail");
	}
	const path = join(trailDir, sessionFile);
	if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
	assertPhysicalCompanyTree(root, join("trail", sessionFile));
	const header = readHeader(path);
	if (header.version !== TRAIL_SESSION_VERSION) {
		throw new Error(`trail session schema ${header.version ?? 1} requires an explicit append-only migration`);
	}
	return header.qorpera?.staffAgentId;
}

/** The conversation a session file currently shows: message objects along the
 * active chain (the newest entry whose parent-path carries any message,
 * walked to its root), oldest first. Linear cloud materialization makes this
 * the whole synced conversation; a legacy forked file resolves to its newest
 * message-bearing branch, which is what the pane already showed. Serves the
 * renderer's get_messages surface without an attached child process. */
export function trailSessionMessages(root: string, sessionFile: string): Array<Record<string, unknown>> {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	if (basename(sessionFile) !== sessionFile || !sessionFile.endsWith(".jsonl")) {
		throw new Error("trail session must be a JSONL filename inside the company trail");
	}
	const path = join(trailDir, sessionFile);
	if (!existsSync(path)) throw new Error(`trail session does not exist: ${sessionFile}`);
	const entries = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.slice(1)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (let index = entries.length - 1; index >= 0; index--) {
		const chain: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor: SessionEntry | undefined = entries[index];
		while (cursor && !seen.has(cursor.id) && chain.length <= entries.length) {
			seen.add(cursor.id);
			chain.push(cursor);
			cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
		}
		const messages = chain
			.reverse()
			.filter((entry) => entry.type === "message" && entry.message && typeof entry.message === "object")
			.map((entry) => {
				const message = entry.message as Record<string, unknown>;
				return { timestamp: entry.timestamp, ...message };
			});
		if (messages.length > 0) return messages;
	}
	return [];
}

export function existingTrailFileForSession(root: string, sessionId: string): string | undefined {
	const trailDir = assertPhysicalCompanyTree(root, "trail");
	let match: string | undefined;
	for (const file of readdirSync(trailDir).filter((candidate) => candidate.endsWith(".jsonl"))) {
		const header = readHeader(join(trailDir, file));
		if (header.id !== sessionId) continue;
		if (match) throw new Error(`duplicate trail session identity: ${sessionId}`);
		match = file;
	}
	return match;
}

function stampSharedTrailEntry(binding: TrailBinding, entry: SharedTrailEntry): TrailAppendFrame {
	if (!Number.isFinite(Date.parse(entry.timestamp))) throw new Error("shared trail entry timestamp is invalid");
	const stamped: SessionEntry = {
		...unsignedTrailEntry(entry as SessionEntry),
		provenance: { source: "kernel", trust: "observed" },
	};
	stamped.kernel = {
		sequence: binding.audit.sequence + 1,
		receivedAt: entry.timestamp,
		previousHash: binding.audit.lastHash || null,
		hash: "",
	};
	stamped.kernel.hash = auditHash(stamped, binding.audit.lastHash);
	return { type: "qorpera_trail_append", token: binding.token, entry: stamped };
}

/** Merge hosted entries into a verified local trail. Passing the live binding
 * updates the exact audit cursor used by the attached executor. */
export function materializeSharedTrailSession(
	root: string,
	session: SharedTrailMaterialization,
	entries: readonly SharedTrailEntry[],
	liveBinding?: TrailBinding,
): TrailBinding {
	if (!UUID_PATTERN.test(session.localSessionId)) throw new Error("shared trail session id must be a UUID");
	if (!Number.isFinite(Date.parse(session.createdAt))) throw new Error("shared trail creation time is invalid");
	const scope: AgentScope = session.scope
		? {
				actor: "company-agent",
				attended: session.scope.attended,
				...(session.scope.staffAgentId ? { staffAgentId: session.scope.staffAgentId } : {}),
				...(session.scope.roomId ? { roomId: session.scope.roomId } : {}),
				...(session.scope.autonomousLabel ? { autonomousLabel: session.scope.autonomousLabel } : {}),
				...(session.scope.group ? { group: session.scope.group } : {}),
				...(session.scope.parentSession ? { parentSession: session.scope.parentSession } : {}),
				...(session.scope.companySnapshotId ? { companySnapshotId: session.scope.companySnapshotId } : {}),
				...(session.scope.staffVersion ? { staffVersion: session.scope.staffVersion } : {}),
			}
		: {
				actor: "company-agent",
				attended: true,
				...(session.staffAgentId ? { staffAgentId: session.staffAgentId } : {}),
			};
	let binding = liveBinding;
	if (binding && binding.sessionId !== session.localSessionId) {
		throw new Error("live trail binding does not match the shared session");
	}
	if (!binding) {
		let trailFile = existingTrailFileForSession(root, session.localSessionId);
		if (!trailFile) {
			const trailDir = assertPhysicalCompanyTree(root, "trail");
			const fileTimestamp = session.createdAt.replace(/[:.]/g, "-");
			trailFile = `${fileTimestamp}_${session.localSessionId}.jsonl`;
			const header: SessionHeader = {
				type: "session",
				version: TRAIL_SESSION_VERSION,
				id: session.localSessionId,
				timestamp: session.createdAt,
				cwd: resolve(root),
				qorpera: authorityForScope(scope),
			};
			writeFileSync(join(trailDir, trailFile), `${JSON.stringify(header)}\n`, { flag: "wx" });
		}
		binding = bindTrailSession(root, root, scope, trailFile);
	}

	const existing = new Map(portableTrailEntries(binding.path).map((entry) => [entry.id, entry]));
	/* Hosted sequence order is the conversation; lineage is client-derived.
	 * Every materialized entry chains onto the local leaf, because runner and
	 * peer devices author parent ids against histories this file never saw —
	 * honoring them fragments the session into parallel roots and the pane
	 * shows only the newest fragment. session_info metadata stays off-chain
	 * (its hosted form pins a null parent). */
	/* The leaf must be a physical file entry: the portable projection also
	 * synthesizes shared-input ids that exist only in the shared view. */
	let leafId: string | null = null;
	for (const entry of existing.values()) {
		if (entry.type !== "session_info" && binding.audit.ids.has(entry.id)) leafId = entry.id;
	}
	const sansParent = (entry: SharedTrailEntry): Record<string, unknown> => {
		const { parentId: _parentId, ...content } = entry;
		return content;
	};
	for (const input of entries) {
		const candidate = { ...input };
		delete candidate.kernel;
		delete candidate.provenance;
		const previous = existing.get(candidate.id);
		if (previous) {
			if (JSON.stringify(sansParent(previous)) !== JSON.stringify(sansParent(candidate))) {
				throw new Error(`shared trail entry identity conflict: ${candidate.id}`);
			}
			continue;
		}
		if (candidate.type !== "session_info") candidate.parentId = leafId;
		if (Buffer.byteLength(JSON.stringify(candidate), "utf-8") > MAX_TRAIL_ENTRY_BYTES) {
			throw new Error(`shared trail entry is too large: ${candidate.id}`);
		}
		if (!validTrailEntry(candidate as SessionEntry, binding.audit.ids)) {
			throw new Error(`shared trail entry graph is invalid: ${candidate.id}`);
		}
		const append = stampSharedTrailEntry(binding, candidate);
		appendBoundTrailEntry(binding, append.entry);
		commitTrailAppend(binding, append);
		existing.set(candidate.id, candidate);
		if (candidate.type !== "session_info") leafId = candidate.id;
	}
	return binding;
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

export function parseTrailAppendFrame(
	value: unknown,
	binding: TrailBinding,
	execution?: KernelExecutionIdentity,
): TrailAppendFrame | undefined {
	if (!value || typeof value !== "object") return undefined;
	const frame = value as Partial<TrailAppendFrame>;
	if (frame.type !== "qorpera_trail_append" || frame.token !== binding.token) return undefined;
	const entry = frame.entry as unknown;
	if (!entry || typeof entry !== "object") return undefined;
	const record = entry as SessionEntry;
	if (Buffer.byteLength(JSON.stringify(record), "utf-8") > MAX_TRAIL_ENTRY_BYTES) return undefined;
	if (!validTrailEntry(record, binding.audit.ids)) return undefined;
	const durableExecution = execution ?? trailExecutions.get(binding);
	if (
		durableExecution &&
		((durableExecution.kind !== "turn" && durableExecution.kind !== "wake") ||
			!UUID_PATTERN.test(durableExecution.id) ||
			!UUID_PATTERN.test(durableExecution.claimantId))
	) {
		return undefined;
	}
	const receivedAt = new Date().toISOString();
	const unsigned = unsignedTrailEntry(record);
	delete unsigned.execution;
	const stamped: SessionEntry = {
		...unsigned,
		timestamp: receivedAt,
		provenance: { source: "child", trust: "assertion" },
		...(durableExecution ? { execution: { ...durableExecution } } : {}),
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
	const execution = trailExecutions.get(binding);
	const stamped: SessionEntry = {
		...unsignedTrailEntry(entry),
		timestamp: receivedAt,
		provenance: { source: "kernel", trust: "observed" },
		...(execution ? { execution: { ...execution } } : {}),
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

/** Append a stamped entry to a bound trail file. Appends must never mint a
 * file: a binding whose file vanished is stale, and appendFileSync would
 * otherwise recreate the session headerless — poisoning every future reader.
 * Callers treat the throw as an ordinary persistence failure. */
export function appendBoundTrailEntry(binding: TrailBinding, entry: unknown): void {
	if (!existsSync(binding.path)) {
		throw new Error(`trail session file is missing for a live binding: ${binding.file}`);
	}
	appendFileSync(binding.path, `${JSON.stringify(entry)}\n`);
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
	appendBoundTrailEntry(binding, append.entry);
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
	appendBoundTrailEntry(binding, append.entry);
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
		execution: intent.execution ?? null,
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
	signIntent: (
		frame: Record<string, unknown>,
		attended: boolean,
		execution?: KernelExecutionIdentity,
	) => KernelIntentCapability;
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
		signIntent: (frame, attended, execution) => {
			const issuedAtMs = Date.now();
			const intent = {
				nonce: randomUUID(),
				sessionId: options.sessionId,
				requestHash: intentRequestHash(frame),
				attended,
				issuedAt: new Date(issuedAtMs).toISOString(),
				expiresAt: new Date(issuedAtMs + lifetimeMs).toISOString(),
				...(execution ? { execution: { ...execution } } : {}),
				budget: { ...budget },
			};
			return {
				...intent,
				signature: sign(null, Buffer.from(kernelIntentPayload(intent)), pair.privateKey).toString("base64"),
			};
		},
	};
}

export function inboxMessagesPath(root: string): string {
	return assertPhysicalCompanyTree(root, join("inbox", "messages"));
}

export function sandboxConfigDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	return join(userData, "agent-sandbox", sandboxRootId(root), actor);
}

function sandboxRootId(root: string): string {
	const resolvedRoot = resolve(root);
	return createHash("sha256")
		.update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
		.digest("hex");
}
