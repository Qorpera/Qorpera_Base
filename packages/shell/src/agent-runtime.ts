import { createHash, randomUUID } from "node:crypto";
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
import type { KernelExecutionIdentity, KernelIntentCapability } from "@qorpera/pi-protocol";
import type { ConnectionRequest } from "./connection-requests.ts";

export type { KernelIntentCapability } from "@qorpera/pi-protocol";

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
	if (
		execution &&
		((execution.kind !== "turn" && execution.kind !== "wake") ||
			!UUID_PATTERN.test(execution.id) ||
			!UUID_PATTERN.test(execution.claimantId))
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

export function sandboxConfigDir(userData: string, root: string, actor: AgentScope["actor"]): string {
	return join(userData, "agent-sandbox", sandboxRootId(root), actor);
}

function sandboxRootId(root: string): string {
	const resolvedRoot = resolve(root);
	return createHash("sha256")
		.update(process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot)
		.digest("hex");
}
