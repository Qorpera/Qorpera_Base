import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExecutionIdentity, JsonValue } from "@qorpera/contracts";
import {
	listSharedTrailSessions,
	materializeSharedTrailSession,
	type SharedTrailEntry,
	type SharedTrailScope,
	type SharedTrailSession,
	type TrailBinding,
	type TrailExecutionIdentity,
} from "./agent-runtime.ts";
import type {
	HostedSession,
	HostedSessionEvent,
	HostedSessionEventType,
	QorperaHostedPrimary,
} from "./hosted-primary.ts";

const CLOUD_TRAIL_STATE_SCHEMA = "qorpera.cloud-trail-sync/v3";
const LEGACY_CLOUD_TRAIL_STATE_SCHEMA = "qorpera.cloud-trail-sync/v2";
const SESSION_METADATA_SCHEMA = "qorpera.shared-session/v1";
const ENTRY_PART_SCHEMA = "qorpera.shared-trail-entry-part/v1";
const RUNNER_ENTRY_SCHEMA = "qorpera.runner-transcript-entry/v1";
const RAW_PART_BYTES = 128 * 1024;
const MAX_PARTS = 128;
const MAX_QUARANTINE_RECEIPTS = 1_000;
const MAX_RECENT_ENTRY_IDS = 2_048;
const TRAIL_METADATA_ONLY_TYPES = new Set(["session_info", "model_change", "thinking_level_change"]);

type CloudTrailPrimary = Pick<
	QorperaHostedPrimary,
	| "appendAccountEvent"
	| "closeSession"
	| "createSession"
	| "getSessionByClient"
	| "listSessionsPage"
	| "readSessionEvents"
>;

interface PendingEntryParts {
	entryType: string;
	partCount: number;
	parts: Array<string | null>;
	execution?: TrailExecutionIdentity;
}

interface QuarantinedHostedEvent {
	eventId: string;
	sequence: number;
	reason: string;
	quarantinedAt: string;
}

interface SessionSyncState {
	cursor: number;
	knownEntryIds: string[];
	metadataUploaded: boolean;
	lastUploadedEntryId?: string;
	pending: Record<string, PendingEntryParts>;
	quarantinedEvents: QuarantinedHostedEvent[];
}

interface CloudTrailState {
	schema: typeof CLOUD_TRAIL_STATE_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	sessionDiscovery?: { updatedAt: string; sessionId: string };
	adoptedSessionIds: string[];
	sessions: Record<string, SessionSyncState>;
}

export interface CloudTrailSyncResult {
	sessionsCreated: number;
	eventsUploaded: number;
	eventsDownloaded: number;
	eventsQuarantined: number;
	entriesMaterialized: number;
}

export interface CloudTrailSynchronizerOptions {
	root: string;
	userData: string;
	profileId: string;
	environmentId: string;
	primary: CloudTrailPrimary;
	loadObject?: (reference: { sha256: string; bytes: number; mediaType: string }) => Promise<Uint8Array>;
	canWrite: () => boolean;
	liveBindings?: () => Iterable<TrailBinding>;
	onMaterialized?: (binding: TrailBinding) => void;
	onCursorAdvanced?: (advance: { hostedSessionId: string; cursor: number; requiresReload: boolean }) => void;
}

function normalizedRoot(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasDurableTrailContent(session: SharedTrailSession): boolean {
	return session.entries.some((entry) => !TRAIL_METADATA_ONLY_TYPES.has(entry.type));
}

export function cloudTrailSyncStatePath(userData: string, root: string, profileId: string): string {
	const rootHash = createHash("sha256").update(normalizedRoot(root)).digest("hex").slice(0, 24);
	return join(userData, "cloud-trail-sync", `${profileId}-${rootHash}.json`);
}

function emptyState(options: CloudTrailSynchronizerOptions): CloudTrailState {
	return {
		schema: CLOUD_TRAIL_STATE_SCHEMA,
		profileId: options.profileId,
		environmentId: options.environmentId,
		root: normalizedRoot(options.root),
		adoptedSessionIds: [],
		sessions: {},
	};
}

function validPending(value: unknown): value is PendingEntryParts {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const pending = value as Partial<PendingEntryParts>;
	return (
		typeof pending.entryType === "string" &&
		Number.isSafeInteger(pending.partCount) &&
		(pending.partCount ?? 0) >= 1 &&
		(pending.partCount ?? 0) <= MAX_PARTS &&
		Array.isArray(pending.parts) &&
		pending.parts.length === pending.partCount &&
		pending.parts.every((part) => part === null || typeof part === "string") &&
		(pending.execution === undefined || validExecution(pending.execution))
	);
}

function validQuarantineReceipt(value: unknown): value is QuarantinedHostedEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const receipt = value as Partial<QuarantinedHostedEvent>;
	return (
		typeof receipt.eventId === "string" &&
		Number.isSafeInteger(receipt.sequence) &&
		(receipt.sequence ?? 0) > 0 &&
		typeof receipt.reason === "string" &&
		receipt.reason.length > 0 &&
		receipt.reason.length <= 256 &&
		typeof receipt.quarantinedAt === "string" &&
		Number.isFinite(Date.parse(receipt.quarantinedAt))
	);
}

function validExecution(value: unknown): value is TrailExecutionIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const execution = value as Partial<TrailExecutionIdentity> & { runnerAssignmentId?: unknown };
	return (
		(execution.kind === "turn" || execution.kind === "wake" || execution.kind === "run") &&
		typeof execution.id === "string" &&
		/^[0-9a-f-]{36}$/i.test(execution.id) &&
		typeof execution.claimantId === "string" &&
		/^[0-9a-f-]{36}$/i.test(execution.claimantId) &&
		(execution.kind === "run"
			? typeof execution.runnerAssignmentId === "string" && /^[0-9a-f-]{36}$/i.test(execution.runnerAssignmentId)
			: execution.runnerAssignmentId === undefined)
	);
}

function isExecutionFenceRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /durable execution/i.test(error.message) || /42501/.test(error.message);
}

function sameExecution(left: TrailExecutionIdentity | undefined, right: TrailExecutionIdentity | undefined): boolean {
	/* Field comparison, never serialization: the runner writes its execution
	 * identity with a different key order than the hosted event parser
	 * constructs, and JSON.stringify equality rejected every runner-written
	 * transcript entry — stalling trail sync at the first live-turn message. */
	if (!left || !right) return left === right;
	const leftAssignment = (left as { runnerAssignmentId?: string }).runnerAssignmentId;
	const rightAssignment = (right as { runnerAssignmentId?: string }).runnerAssignmentId;
	return (
		left.kind === right.kind &&
		left.id === right.id &&
		left.claimantId === right.claimantId &&
		leftAssignment === rightAssignment
	);
}

function readState(path: string, options: CloudTrailSynchronizerOptions): CloudTrailState {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(options);
		const rawSchema = (value as { schema?: unknown }).schema;
		const input = value as Partial<CloudTrailState>;
		if (
			(rawSchema !== CLOUD_TRAIL_STATE_SCHEMA && rawSchema !== LEGACY_CLOUD_TRAIL_STATE_SCHEMA) ||
			input.profileId !== options.profileId ||
			input.environmentId !== options.environmentId ||
			input.root !== normalizedRoot(options.root) ||
			!input.sessions ||
			typeof input.sessions !== "object" ||
			Array.isArray(input.sessions)
		) {
			return emptyState(options);
		}
		const sessions: Record<string, SessionSyncState> = {};
		for (const [sessionId, candidate] of Object.entries(input.sessions)) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
			const session = candidate as Partial<SessionSyncState>;
			if (
				!Number.isSafeInteger(session.cursor) ||
				(session.cursor ?? -1) < 0 ||
				!Array.isArray(session.knownEntryIds) ||
				!session.knownEntryIds.every((id) => typeof id === "string") ||
				!session.pending ||
				typeof session.pending !== "object" ||
				Array.isArray(session.pending)
			) {
				continue;
			}
			const pending: Record<string, PendingEntryParts> = {};
			for (const [entryId, parts] of Object.entries(session.pending)) {
				if (validPending(parts)) pending[entryId] = parts;
			}
			const quarantinedEvents = Array.isArray(session.quarantinedEvents)
				? session.quarantinedEvents.filter(validQuarantineReceipt).slice(-MAX_QUARANTINE_RECEIPTS)
				: [];
			sessions[sessionId] = {
				cursor: session.cursor as number,
				knownEntryIds:
					rawSchema === LEGACY_CLOUD_TRAIL_STATE_SCHEMA
						? [...new Set(session.knownEntryIds)]
						: [...new Set(session.knownEntryIds)].slice(-MAX_RECENT_ENTRY_IDS),
				metadataUploaded:
					session.metadataUploaded === true ||
					session.knownEntryIds.some((entryId) => entryId.startsWith("cloud-session-info:")),
				...(typeof session.lastUploadedEntryId === "string"
					? { lastUploadedEntryId: session.lastUploadedEntryId }
					: {}),
				pending,
				quarantinedEvents,
			};
		}
		const discovery = input.sessionDiscovery;
		return {
			...emptyState(options),
			...(discovery &&
			typeof discovery.updatedAt === "string" &&
			Number.isFinite(Date.parse(discovery.updatedAt)) &&
			typeof discovery.sessionId === "string"
				? { sessionDiscovery: { updatedAt: discovery.updatedAt, sessionId: discovery.sessionId } }
				: {}),
			adoptedSessionIds: Array.isArray(input.adoptedSessionIds)
				? [...new Set(input.adoptedSessionIds.filter((id) => typeof id === "string"))]
				: [],
			sessions,
		};
	} catch {
		return emptyState(options);
	}
}

function writeState(path: string, state: CloudTrailState): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function sessionState(state: CloudTrailState, hostedSessionId: string): SessionSyncState {
	const existing = state.sessions[hostedSessionId];
	if (existing) return existing;
	const created: SessionSyncState = {
		cursor: 0,
		knownEntryIds: [],
		metadataUploaded: false,
		pending: {},
		quarantinedEvents: [],
	};
	state.sessions[hostedSessionId] = created;
	return created;
}

function rememberEntryId(state: SessionSyncState, entryId: string): void {
	state.knownEntryIds = [...state.knownEntryIds.filter((known) => known !== entryId), entryId].slice(
		-MAX_RECENT_ENTRY_IDS,
	);
}

function retireClosedSessionState(hosted: HostedSession, state: CloudTrailState): void {
	if (hosted.status !== "closed") return;
	const session = state.sessions[hosted.sessionId];
	if (!session || Object.keys(session.pending).length > 0) return;
	delete state.sessions[hosted.sessionId];
	state.adoptedSessionIds = state.adoptedSessionIds.filter((id) => id !== hosted.clientSessionId);
}

function deterministicEventId(sessionId: string, identity: string): string {
	const bytes = createHash("sha256").update(`${sessionId}\n${identity}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function metadataEntryId(localSessionId: string): string {
	return `cloud-session-info:${localSessionId}`;
}

function metadataBody(session: HostedSession): JsonValue {
	return {
		schema: SESSION_METADATA_SCHEMA,
		entry: {
			type: "session_info",
			id: metadataEntryId(session.clientSessionId),
			parentId: null,
			timestamp: session.createdAt,
			name: session.title,
		},
	};
}

function eventTypeForEntry(entry: SharedTrailEntry): HostedSessionEventType {
	return entry.type === "message" ? "message" : "session_info";
}

interface UploadEvent {
	eventId: string;
	eventType: HostedSessionEventType;
	body: JsonValue;
}

function uploadEvents(sessionId: string, entry: SharedTrailEntry): UploadEvent[] {
	const encoded = Buffer.from(JSON.stringify(entry), "utf-8");
	const partCount = Math.ceil(encoded.length / RAW_PART_BYTES);
	if (partCount < 1 || partCount > MAX_PARTS) throw new Error(`shared trail entry is too large: ${entry.id}`);
	const events: UploadEvent[] = [];
	for (let partIndex = 0; partIndex < partCount; partIndex++) {
		const start = partIndex * RAW_PART_BYTES;
		const payloadBase64 = encoded
			.subarray(start, Math.min(start + RAW_PART_BYTES, encoded.length))
			.toString("base64");
		events.push({
			eventId: deterministicEventId(sessionId, `entry:${entry.id}:part:${partIndex}`),
			eventType: eventTypeForEntry(entry),
			body: {
				schema: ENTRY_PART_SCHEMA,
				entryId: entry.id,
				entryType: entry.type,
				partIndex,
				partCount,
				payloadBase64,
			},
		});
	}
	return events;
}

function bodyRecord(body: JsonValue): Record<string, JsonValue> | undefined {
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, JsonValue>) : undefined;
}

function sharedExecutionScope(value: JsonValue | undefined, staffAgentId?: string): SharedTrailScope | undefined {
	const input = bodyRecord(value ?? null);
	if (!input || Object.keys(input).length === 0) return undefined;
	if (
		typeof input.attended !== "boolean" ||
		(input.staffAgentId !== undefined && typeof input.staffAgentId !== "string") ||
		(input.roomId !== undefined && typeof input.roomId !== "string") ||
		(input.autonomousLabel !== undefined && typeof input.autonomousLabel !== "string") ||
		(input.group !== undefined && typeof input.group !== "string") ||
		(input.parentSession !== undefined && typeof input.parentSession !== "string") ||
		(input.companySnapshotId !== undefined && typeof input.companySnapshotId !== "string") ||
		(input.staffVersion !== undefined &&
			(!Number.isSafeInteger(input.staffVersion) || (input.staffVersion as number) < 1)) ||
		(input.companySnapshotId === undefined) !== (input.staffVersion === undefined) ||
		Object.keys(input).some(
			(key) =>
				![
					"attended",
					"staffAgentId",
					"roomId",
					"autonomousLabel",
					"group",
					"parentSession",
					"companySnapshotId",
					"staffVersion",
				].includes(key),
		)
	) {
		throw new Error("hosted session execution scope is invalid");
	}
	if (input.staffAgentId !== undefined && input.staffAgentId !== staffAgentId) {
		throw new Error("hosted session staff identity conflicts with its execution scope");
	}
	return input as unknown as SharedTrailScope;
}

function sharedEntry(value: JsonValue | undefined): SharedTrailEntry | undefined {
	const entry = bodyRecord(value ?? null);
	if (
		!entry ||
		typeof entry.type !== "string" ||
		typeof entry.id !== "string" ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		typeof entry.timestamp !== "string" ||
		(entry.execution !== undefined && !validExecution(entry.execution))
	) {
		return undefined;
	}
	return entry as SharedTrailEntry;
}

function runnerInputAttachments(entry: SharedTrailEntry): Array<{ sha256: string; bytes: number; mediaType: string }> {
	const value = entry.qorperaAttachments;
	if (!Array.isArray(value) || value.length > 5) throw new HostedTrailEventError("invalid runner input attachments");
	return value.map((candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new HostedTrailEventError("invalid runner input attachment");
		}
		const input = candidate as Record<string, unknown>;
		if (
			typeof input.objectSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(input.objectSha256) ||
			!Number.isSafeInteger(input.bytes) ||
			(input.bytes as number) < 1 ||
			(input.bytes as number) > 8 * 1024 * 1024 ||
			typeof input.mediaType !== "string" ||
			!/^image\/[a-z0-9.+-]{1,64}$/i.test(input.mediaType)
		) {
			throw new HostedTrailEventError("invalid runner input attachment");
		}
		return { sha256: input.objectSha256, bytes: input.bytes as number, mediaType: input.mediaType };
	});
}

class HostedTrailEventError extends Error {
	readonly entryId?: string;
	/** True only when the fully assembled entry itself is unusable. A conflicting
	 * or malformed single event must never discard another writer's legitimately
	 * accumulated parts — quarantining the offending event alone is sufficient. */
	readonly discardsPending: boolean;

	constructor(message: string, entryId?: string, discardsPending = false) {
		super(message);
		this.entryId = entryId;
		this.discardsPending = discardsPending;
	}
}

function consumeHostedEvent(event: HostedSessionEvent, state: SessionSyncState): SharedTrailEntry | undefined {
	const body = bodyRecord(event.body);
	if (!body) throw new HostedTrailEventError("invalid event body");
	if (body.schema === SESSION_METADATA_SCHEMA) {
		const entry = sharedEntry(body.entry);
		if (event.eventType !== "session_info" || event.sessionInputId || !entry || entry.type !== "session_info") {
			throw new HostedTrailEventError("invalid session metadata");
		}
		return entry;
	}
	if (body.schema === RUNNER_ENTRY_SCHEMA) {
		const entry = sharedEntry(body.entry);
		const expectedEntryType = event.eventType === "message" ? "message" : "custom";
		const message = entry?.message as { role?: unknown; qorperaRunId?: unknown } | undefined;
		if (
			!entry ||
			entry.id !== event.eventId ||
			entry.type !== expectedEntryType ||
			(event.eventType !== "message" && entry.customType !== event.eventType) ||
			(event.sessionInputId
				? event.sessionInputId !== event.eventId ||
					event.execution !== undefined ||
					entry.execution !== undefined ||
					message?.role !== "user"
				: event.execution?.kind !== "run" || !sameExecution(entry.execution, event.execution))
		) {
			throw new HostedTrailEventError("invalid runner transcript entry");
		}
		if (event.sessionInputId) {
			if (!message || typeof message !== "object") {
				throw new HostedTrailEventError("runner input message is invalid");
			}
			runnerInputAttachments(entry);
		} else if (message && event.execution?.kind === "run") {
			if (message.qorperaRunId !== undefined && message.qorperaRunId !== event.execution.id) {
				throw new HostedTrailEventError("runner message provenance conflicts with its execution");
			}
			// AgentMessage is the renderer-facing projection and otherwise loses
			// the outer trail execution identity. Derive this join key from the
			// authoritative hosted event so each response can display its exact
			// sponsor/provider provenance on every device.
			message.qorperaRunId = event.execution.id;
		}
		return entry;
	}
	if (body.schema !== ENTRY_PART_SCHEMA) throw new HostedTrailEventError("unknown event schema");
	if (event.execution !== undefined && !validExecution(event.execution)) {
		throw new HostedTrailEventError("invalid event execution identity");
	}
	const { entryId, entryType, partIndex, partCount, payloadBase64 } = body;
	if (
		typeof entryId !== "string" ||
		!entryId ||
		typeof entryType !== "string" ||
		!Number.isSafeInteger(partIndex) ||
		!Number.isSafeInteger(partCount) ||
		(partIndex as number) < 0 ||
		(partCount as number) < 1 ||
		(partCount as number) > MAX_PARTS ||
		(partIndex as number) >= (partCount as number) ||
		typeof payloadBase64 !== "string" ||
		(event.eventType === "message" && entryType !== "message") ||
		(event.eventType === "session_info" && entryType === "message") ||
		(!["message", "session_info"].includes(event.eventType) && entryType !== "custom")
	) {
		throw new HostedTrailEventError("invalid entry part", typeof entryId === "string" ? entryId : undefined);
	}
	let pending = state.pending[entryId];
	if (!pending) {
		pending = {
			entryType,
			partCount: partCount as number,
			parts: Array.from({ length: partCount as number }, () => null),
			...(event.execution ? { execution: { ...event.execution } } : {}),
		};
		state.pending[entryId] = pending;
	}
	if (pending.entryType !== entryType || pending.partCount !== partCount) {
		throw new HostedTrailEventError("entry parts conflict", entryId);
	}
	if (!sameExecution(pending.execution, event.execution)) {
		throw new HostedTrailEventError("entry execution parts conflict", entryId, true);
	}
	const index = partIndex as number;
	if (pending.parts[index] !== null && pending.parts[index] !== payloadBase64) {
		throw new HostedTrailEventError("entry part conflicts", entryId);
	}
	pending.parts[index] = payloadBase64;
	if (pending.parts.some((part) => part === null)) return undefined;
	const json = Buffer.concat(pending.parts.map((part) => Buffer.from(part!, "base64"))).toString("utf-8");
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(json) as JsonValue;
	} catch {
		throw new HostedTrailEventError("entry payload is invalid JSON", entryId, true);
	}
	const entry = sharedEntry(parsed);
	if (!entry || entry.id !== entryId || entry.type !== entryType || !sameExecution(entry.execution, event.execution)) {
		throw new HostedTrailEventError("entry payload identity is invalid", entryId, true);
	}
	delete state.pending[entryId];
	return entry;
}

function liveBindingMap(options: CloudTrailSynchronizerOptions): Map<string, TrailBinding> {
	return new Map([...(options.liveBindings?.() ?? [])].map((binding) => [binding.sessionId, binding]));
}

function isSequenceConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("session event sequence changed") || message.includes("40001");
}

export class CloudTrailSynchronizer {
	readonly #options: CloudTrailSynchronizerOptions;
	readonly #statePath: string;
	#inFlight?: Promise<CloudTrailSyncResult>;

	constructor(options: CloudTrailSynchronizerOptions) {
		this.#options = options;
		this.#statePath = cloudTrailSyncStatePath(options.userData, options.root, options.profileId);
	}

	sync(): Promise<CloudTrailSyncResult> {
		if (this.#inFlight) return this.#inFlight;
		const operation = this.#syncOnce().finally(() => {
			if (this.#inFlight === operation) this.#inFlight = undefined;
		});
		this.#inFlight = operation;
		return operation;
	}

	cursorForHostedSession(hostedSessionId: string): number | undefined {
		return readState(this.#statePath, this.#options).sessions[hostedSessionId]?.cursor;
	}

	async hostedSessionForClient(clientSessionId: string): Promise<HostedSession> {
		await this.sync();
		const hosted = await this.#options.primary.getSessionByClient(this.#options.environmentId, clientSessionId);
		if (!hosted) throw new Error("operational trail session was not uploaded");
		return hosted;
	}

	async finalizeOperationalSession(clientSessionId: string): Promise<void> {
		const hosted = await this.hostedSessionForClient(clientSessionId);
		if (hosted.status === "open") await this.#options.primary.closeSession(hosted.sessionId);
	}

	async #pullSession(
		hosted: HostedSession,
		cloudState: CloudTrailState,
		state: SessionSyncState,
		bindings: Map<string, TrailBinding>,
		result: CloudTrailSyncResult,
	): Promise<void> {
		for (;;) {
			const events = await this.#options.primary.readSessionEvents(hosted.sessionId, state.cursor, 500);
			if (events.length === 0) return;
			const materialized: SharedTrailEntry[] = [];
			for (const event of events) {
				if (event.sessionId !== hosted.sessionId || event.sequence !== state.cursor + 1) {
					throw new Error(`hosted trail sequence is discontinuous for ${hosted.sessionId}`);
				}
				let entry: SharedTrailEntry | undefined;
				try {
					entry = consumeHostedEvent(event, state);
					if (entry && event.sessionInputId) {
						const attachments = runnerInputAttachments(entry);
						if (attachments.length > 0 && !this.#options.loadObject) {
							throw new HostedTrailEventError("runner input attachment storage is unavailable");
						}
						const message = entry.message as { content?: unknown };
						if (!Array.isArray(message.content)) {
							throw new HostedTrailEventError("runner input message content is invalid");
						}
						const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
						for (const attachment of attachments) {
							const bytes = await this.#options.loadObject!(attachment);
							images.push({
								type: "image",
								data: Buffer.from(bytes).toString("base64"),
								mimeType: attachment.mediaType,
							});
						}
						const { qorperaAttachments: _attachments, ...hydrated } = entry;
						entry = {
							...hydrated,
							message: { ...message, content: [...message.content, ...images] },
						};
					}
				} catch (error) {
					if (!(error instanceof HostedTrailEventError)) throw error;
					if (error.entryId && error.discardsPending) delete state.pending[error.entryId];
					state.quarantinedEvents.push({
						eventId: event.eventId,
						sequence: event.sequence,
						reason: error.message.slice(0, 256),
						quarantinedAt: new Date().toISOString(),
					});
					state.quarantinedEvents = state.quarantinedEvents
						.filter(
							(receipt, index, receipts) =>
								!receipts.slice(index + 1).some((candidate) => candidate.eventId === receipt.eventId),
						)
						.slice(-MAX_QUARANTINE_RECEIPTS);
					result.eventsQuarantined++;
					if (event.execution || event.sessionInputId) {
						writeState(this.#statePath, cloudState);
						throw new Error(
							`execution-bound hosted trail event ${event.eventId} could not be materialized: ${error.message}`,
						);
					}
				}
				state.cursor = event.sequence;
				result.eventsDownloaded++;
				if (entry) {
					if (!state.knownEntryIds.includes(entry.id)) materialized.push(entry);
					rememberEntryId(state, entry.id);
				}
			}
			if (materialized.length > 0) {
				const scope = hosted.executionScope
					? sharedExecutionScope(hosted.executionScope, hosted.staffAgentId)
					: undefined;
				if (
					scope?.companySnapshotId !== undefined &&
					(scope.companySnapshotId !== hosted.companySnapshotId || scope.staffVersion !== hosted.staffVersion)
				) {
					throw new Error("hosted session execution revisions conflict with its execution scope");
				}
				const binding = materializeSharedTrailSession(
					this.#options.root,
					{
						localSessionId: hosted.clientSessionId,
						createdAt: hosted.createdAt,
						title: hosted.title,
						staffAgentId: hosted.staffAgentId,
						...(scope ? { scope } : {}),
					},
					materialized,
					bindings.get(hosted.clientSessionId),
				);
				bindings.set(hosted.clientSessionId, binding);
				this.#options.onMaterialized?.(binding);
				result.entriesMaterialized += materialized.length;
			}
			writeState(this.#statePath, cloudState);
			this.#options.onCursorAdvanced?.({
				hostedSessionId: hosted.sessionId,
				cursor: state.cursor,
				requiresReload: materialized.length > 0,
			});
			if (events.length < 500) return;
		}
	}

	async #append(
		hosted: HostedSession,
		cloudState: CloudTrailState,
		state: SessionSyncState,
		event: UploadEvent,
		bindings: Map<string, TrailBinding>,
		result: CloudTrailSyncResult,
		execution?: ExecutionIdentity,
	): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const appended = await this.#options.primary.appendAccountEvent({
					sessionId: hosted.sessionId,
					eventId: event.eventId,
					eventType: event.eventType,
					body: event.body,
					expectedSequence: state.cursor,
					...(execution ? { execution } : {}),
				});
				result.eventsUploaded++;
				if (appended.sequence === state.cursor + 1) state.cursor = appended.sequence;
				else await this.#pullSession(hosted, cloudState, state, bindings, result);
				return;
			} catch (error) {
				if (!isSequenceConflict(error) || attempt === 2) throw error;
				await this.#pullSession(hosted, cloudState, state, bindings, result);
			}
		}
	}

	async #uploadSession(
		hosted: HostedSession,
		local: SharedTrailSession,
		cloudState: CloudTrailState,
		state: SessionSyncState,
		bindings: Map<string, TrailBinding>,
		result: CloudTrailSyncResult,
	): Promise<void> {
		const metadataId = metadataEntryId(hosted.clientSessionId);
		const sessionExecutionCandidate = local.entries.find((entry) => entry.execution)?.execution;
		const sessionExecution = sessionExecutionCandidate?.kind === "run" ? undefined : sessionExecutionCandidate;
		if (!state.metadataUploaded) {
			if (state.knownEntryIds.includes(metadataId)) {
				state.metadataUploaded = true;
			} else {
				await this.#append(
					hosted,
					cloudState,
					state,
					{
						eventId: deterministicEventId(hosted.sessionId, "metadata"),
						eventType: "session_info",
						body: metadataBody(hosted),
					},
					bindings,
					result,
					sessionExecution,
				);
				state.metadataUploaded = true;
				rememberEntryId(state, metadataId);
				writeState(this.#statePath, cloudState);
				this.#options.onCursorAdvanced?.({
					hostedSessionId: hosted.sessionId,
					cursor: state.cursor,
					requiresReload: false,
				});
			}
		}
		let firstUploadIndex = 0;
		if (state.lastUploadedEntryId) {
			const lastUploadedIndex = local.entries.findIndex((entry) => entry.id === state.lastUploadedEntryId);
			if (lastUploadedIndex < 0) throw new Error(`shared trail upload cursor is unavailable: ${hosted.sessionId}`);
			firstUploadIndex = lastUploadedIndex + 1;
		}
		let deferred = false;
		for (const entry of local.entries.slice(firstUploadIndex)) {
			if (state.knownEntryIds.includes(entry.id)) continue;
			// Runner transcript entries are authored directly through the hosted runner
			// broker. They are pull-only here, including after sync-state recovery when
			// their ids have rolled out of the bounded recent-entry cache.
			if (entry.execution?.kind === "run") continue;
			try {
				for (const event of uploadEvents(hosted.sessionId, entry)) {
					await this.#append(hosted, cloudState, state, event, bindings, result, entry.execution);
				}
			} catch (error) {
				/* The control plane's execution fence (42501) rejects trail
				 * entry parts without a durable execution — which unexecuted
				 * local entries can never have. The client and the fence
				 * currently disagree about whether such content belongs in
				 * the hosted trail at all; until that design question is
				 * settled, defer this session's remaining uploads instead of
				 * failing the whole synchronization run behind one entry.
				 * Everything already uploaded stays durable; pulls and other
				 * sessions continue unaffected. */
				if (isExecutionFenceRejection(error)) {
					deferred = true;
					break;
				}
				throw error;
			}
			delete state.pending[entry.id];
			state.lastUploadedEntryId = entry.id;
			rememberEntryId(state, entry.id);
			writeState(this.#statePath, cloudState);
			this.#options.onCursorAdvanced?.({
				hostedSessionId: hosted.sessionId,
				cursor: state.cursor,
				requiresReload: false,
			});
		}
		if (!deferred && local.entries.length > 0) {
			state.lastUploadedEntryId = local.entries.at(-1)?.id;
		}
		state.knownEntryIds = state.knownEntryIds.slice(-MAX_RECENT_ENTRY_IDS);
	}

	async #syncOnce(): Promise<CloudTrailSyncResult> {
		const result: CloudTrailSyncResult = {
			sessionsCreated: 0,
			eventsUploaded: 0,
			eventsDownloaded: 0,
			eventsQuarantined: 0,
			entriesMaterialized: 0,
		};
		const state = readState(this.#statePath, this.#options);
		const bindings = liveBindingMap(this.#options);
		const changedHostedSessions: HostedSession[] = [];
		let discovery = state.sessionDiscovery;
		for (;;) {
			const page = await this.#options.primary.listSessionsPage(this.#options.environmentId, discovery, 100);
			for (const hosted of page.items) {
				changedHostedSessions.push(hosted);
				const executionScope = bodyRecord(hosted.executionScope ?? null);
				if (
					hosted.staffAgentId &&
					!["autonomousLabel", "roomId", "group", "parentSession"].some(
						(key) => executionScope?.[key] !== undefined,
					)
				) {
					state.adoptedSessionIds = [...new Set([...state.adoptedSessionIds, hosted.clientSessionId])];
				}
				discovery = { updatedAt: hosted.updatedAt, sessionId: hosted.sessionId };
			}
			if (!page.hasMore) break;
			if (!page.items.length) throw new Error("hosted session discovery cursor did not advance");
		}
		for (const hosted of changedHostedSessions) {
			const hostedState = sessionState(state, hosted.sessionId);
			await this.#pullSession(hosted, state, hostedState, bindings, result);
			retireClosedSessionState(hosted, state);
		}
		if (discovery) state.sessionDiscovery = discovery;
		writeState(this.#statePath, state);

		const localSessions = listSharedTrailSessions(this.#options.root, {
			adoptedSessionIds: new Set(state.adoptedSessionIds),
		});
		if (this.#options.canWrite()) {
			const hostedByClientId = new Map(changedHostedSessions.map((session) => [session.clientSessionId, session]));
			for (const local of localSessions) {
				let hosted = hostedByClientId.get(local.localSessionId);
				hosted ??= await this.#options.primary.getSessionByClient(
					this.#options.environmentId,
					local.localSessionId,
				);
				// A window open writes local session/runtime metadata so the UI has a
				// trail to attach to. That cache is not a company conversation and must
				// not create cloud authority before anyone submits a durable input.
				if (!hosted && !hasDurableTrailContent(local)) continue;
				if (!hosted) {
					hosted = await this.#options.primary.createSession({
						environmentId: this.#options.environmentId,
						clientSessionId: local.localSessionId,
						title: local.title,
						staffAgentId: local.staffAgentId,
						...(local.scope ? { executionScope: local.scope as unknown as JsonValue } : {}),
						...(local.scope?.companySnapshotId
							? { companySnapshotId: local.scope.companySnapshotId, staffVersion: local.scope.staffVersion }
							: {}),
					});
					result.sessionsCreated++;
				}
				hostedByClientId.set(local.localSessionId, hosted);
				if (hosted.staffAgentId) {
					state.adoptedSessionIds = [...new Set([...state.adoptedSessionIds, hosted.clientSessionId])];
				}
			}
			const localById = new Map(localSessions.map((session) => [session.localSessionId, session]));
			for (const hosted of hostedByClientId.values()) {
				if (hosted.status !== "open") continue;
				const local = localById.get(hosted.clientSessionId);
				if (local) {
					await this.#uploadSession(hosted, local, state, sessionState(state, hosted.sessionId), bindings, result);
				}
			}
		}
		writeState(this.#statePath, state);
		return result;
	}
}
