import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonValue } from "@qorpera/pi-protocol";
import {
	listSharedTrailSessions,
	materializeSharedTrailSession,
	type SharedTrailEntry,
	type SharedTrailSession,
	type TrailBinding,
} from "./agent-runtime.ts";
import type {
	HostedSession,
	HostedSessionEvent,
	HostedSessionEventType,
	QorperaHostedPrimary,
} from "./hosted-primary.ts";

const CLOUD_TRAIL_STATE_SCHEMA = "qorpera.cloud-trail-sync/v1";
const SESSION_METADATA_SCHEMA = "qorpera.shared-session/v1";
const ENTRY_PART_SCHEMA = "qorpera.shared-trail-entry-part/v1";
const RAW_PART_BYTES = 128 * 1024;
const MAX_PARTS = 128;

type CloudTrailPrimary = Pick<
	QorperaHostedPrimary,
	"appendAccountEvent" | "createSession" | "listSessions" | "readSessionEvents"
>;

interface PendingEntryParts {
	entryType: string;
	partCount: number;
	parts: Array<string | null>;
}

interface SessionSyncState {
	cursor: number;
	knownEntryIds: string[];
	pending: Record<string, PendingEntryParts>;
}

interface CloudTrailState {
	schema: typeof CLOUD_TRAIL_STATE_SCHEMA;
	profileId: string;
	environmentId: string;
	root: string;
	sessions: Record<string, SessionSyncState>;
}

export interface CloudTrailSyncResult {
	sessionsCreated: number;
	eventsUploaded: number;
	eventsDownloaded: number;
	entriesMaterialized: number;
}

export interface CloudTrailSynchronizerOptions {
	root: string;
	userData: string;
	profileId: string;
	environmentId: string;
	primary: CloudTrailPrimary;
	canWrite: () => boolean;
	liveBindings?: () => Iterable<TrailBinding>;
	onMaterialized?: (binding: TrailBinding) => void;
}

function normalizedRoot(root: string): string {
	const normalized = resolve(root);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
		pending.parts.every((part) => part === null || typeof part === "string")
	);
}

function readState(path: string, options: CloudTrailSynchronizerOptions): CloudTrailState {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState(options);
		const input = value as Partial<CloudTrailState>;
		if (
			input.schema !== CLOUD_TRAIL_STATE_SCHEMA ||
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
			sessions[sessionId] = {
				cursor: session.cursor as number,
				knownEntryIds: [...new Set(session.knownEntryIds)],
				pending,
			};
		}
		return { ...emptyState(options), sessions };
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
	const created: SessionSyncState = { cursor: 0, knownEntryIds: [], pending: {} };
	state.sessions[hostedSessionId] = created;
	return created;
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

function sharedEntry(value: JsonValue | undefined): SharedTrailEntry | undefined {
	const entry = bodyRecord(value ?? null);
	if (
		!entry ||
		typeof entry.type !== "string" ||
		typeof entry.id !== "string" ||
		(entry.parentId !== null && typeof entry.parentId !== "string") ||
		typeof entry.timestamp !== "string"
	) {
		return undefined;
	}
	return entry as SharedTrailEntry;
}

function consumeHostedEvent(event: HostedSessionEvent, state: SessionSyncState): SharedTrailEntry | undefined {
	const body = bodyRecord(event.body);
	if (!body) throw new Error(`hosted trail event ${event.eventId} has an invalid body`);
	if (body.schema === SESSION_METADATA_SCHEMA) {
		const entry = sharedEntry(body.entry);
		if (!entry || entry.type !== "session_info") throw new Error("hosted session metadata is invalid");
		return entry;
	}
	if (body.schema !== ENTRY_PART_SCHEMA) throw new Error(`hosted trail event ${event.eventId} has an unknown schema`);
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
		typeof payloadBase64 !== "string"
	) {
		throw new Error(`hosted trail entry part ${event.eventId} is invalid`);
	}
	let pending = state.pending[entryId];
	if (!pending) {
		pending = {
			entryType,
			partCount: partCount as number,
			parts: Array.from({ length: partCount as number }, () => null),
		};
		state.pending[entryId] = pending;
	}
	if (pending.entryType !== entryType || pending.partCount !== partCount) {
		throw new Error(`hosted trail entry parts conflict: ${entryId}`);
	}
	const index = partIndex as number;
	if (pending.parts[index] !== null && pending.parts[index] !== payloadBase64) {
		throw new Error(`hosted trail entry part conflicts: ${entryId}:${index}`);
	}
	pending.parts[index] = payloadBase64;
	if (pending.parts.some((part) => part === null)) return undefined;
	const json = Buffer.concat(pending.parts.map((part) => Buffer.from(part!, "base64"))).toString("utf-8");
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(json) as JsonValue;
	} catch {
		throw new Error(`hosted trail entry payload is invalid JSON: ${entryId}`);
	}
	const entry = sharedEntry(parsed);
	if (!entry || entry.id !== entryId || entry.type !== entryType) {
		throw new Error(`hosted trail entry payload identity is invalid: ${entryId}`);
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
				const entry = consumeHostedEvent(event, state);
				state.cursor = event.sequence;
				result.eventsDownloaded++;
				if (entry) {
					if (!state.knownEntryIds.includes(entry.id)) materialized.push(entry);
					state.knownEntryIds.push(entry.id);
					state.knownEntryIds = [...new Set(state.knownEntryIds)];
				}
			}
			if (materialized.length > 0) {
				const binding = materializeSharedTrailSession(
					this.#options.root,
					{
						localSessionId: hosted.clientSessionId,
						createdAt: hosted.createdAt,
						title: hosted.title,
						staffAgentId: hosted.staffAgentId,
					},
					materialized,
					bindings.get(hosted.clientSessionId),
				);
				bindings.set(hosted.clientSessionId, binding);
				this.#options.onMaterialized?.(binding);
				result.entriesMaterialized += materialized.length;
			}
			writeState(this.#statePath, cloudState);
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
	): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const appended = await this.#options.primary.appendAccountEvent({
					sessionId: hosted.sessionId,
					eventId: event.eventId,
					eventType: event.eventType,
					body: event.body,
					expectedSequence: state.cursor,
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
		if (!state.knownEntryIds.includes(metadataId)) {
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
			);
			state.knownEntryIds.push(metadataId);
			writeState(this.#statePath, cloudState);
		}
		for (const entry of local.entries) {
			if (state.knownEntryIds.includes(entry.id)) continue;
			for (const event of uploadEvents(hosted.sessionId, entry)) {
				await this.#append(hosted, cloudState, state, event, bindings, result);
			}
			delete state.pending[entry.id];
			state.knownEntryIds.push(entry.id);
			writeState(this.#statePath, cloudState);
		}
	}

	async #syncOnce(): Promise<CloudTrailSyncResult> {
		const result: CloudTrailSyncResult = {
			sessionsCreated: 0,
			eventsUploaded: 0,
			eventsDownloaded: 0,
			entriesMaterialized: 0,
		};
		const state = readState(this.#statePath, this.#options);
		const bindings = liveBindingMap(this.#options);
		const hostedSessions = await this.#options.primary.listSessions(this.#options.environmentId);
		for (const hosted of hostedSessions) {
			await this.#pullSession(hosted, state, sessionState(state, hosted.sessionId), bindings, result);
		}

		const localSessions = listSharedTrailSessions(this.#options.root);
		if (this.#options.canWrite()) {
			const hostedByClientId = new Map(hostedSessions.map((session) => [session.clientSessionId, session]));
			for (const local of localSessions) {
				if (hostedByClientId.has(local.localSessionId)) continue;
				const hosted = await this.#options.primary.createSession({
					environmentId: this.#options.environmentId,
					clientSessionId: local.localSessionId,
					title: local.title,
					staffAgentId: local.staffAgentId,
				});
				hostedByClientId.set(local.localSessionId, hosted);
				hostedSessions.push(hosted);
				result.sessionsCreated++;
			}
			const localById = new Map(localSessions.map((session) => [session.localSessionId, session]));
			for (const hosted of hostedSessions) {
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
