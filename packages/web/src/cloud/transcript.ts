import type { CloudSessionAttachment } from "@qorpera/cloud-client/cloud-session-attachments";
import { SESSION_IMAGE_TYPES } from "./session-attachments.ts";
import type { HostedSessionEvent, JsonValue, PendingSessionInput } from "./types.ts";

/* Transcript projection (runtime contract §6; launch acceptance item 8).
 * Only two things become visible conversation content: a member's admitted
 * input and an agent's send operation. Everything else — provider text without
 * a send record, receipts, session metadata, legacy local-executor output — is
 * counted and hidden. This module is pure so it can be tested without a DOM. */

export const RUNNER_ENTRY_SCHEMA = "qorpera.runner-transcript-entry/v1";
export const LEGACY_PART_SCHEMA = "qorpera.shared-trail-entry-part/v1";
export const SESSION_METADATA_SCHEMA = "qorpera.shared-session-metadata/v1";
export const AGENT_SEND_SCHEMA = "qorpera.agent-send/v1";

export interface TranscriptMessage {
	kind: "member" | "agent";
	id: string;
	sequence: number;
	authorUserId?: string;
	text: string;
	attachmentCount: number;
	attachments?: TranscriptAttachment[];
	phase?: "progress" | "final";
	runId?: string;
	createdAt: string;
	pending?: "queued" | "processing" | "failed";
	failureReason?: string;
}

export interface TranscriptAttachment {
	kind: "image" | "file";
	name: string;
	mediaType?: string;
	bytes?: number;
	/** Only a canonical member-input event can supply a preview reference. */
	reference?: CloudSessionAttachment;
}

export interface TranscriptCard {
	kind: "authorization_request" | "authorization_decision";
	id: string;
	sequence: number;
	actorUserId: string;
	body: JsonValue;
	createdAt: string;
}

export type TranscriptItem = TranscriptMessage | TranscriptCard;

export interface TranscriptProjection {
	items: TranscriptItem[];
	/** Events in the store that are not public output and were not rendered. */
	hiddenCount: number;
	lastSequence: number;
}

interface Entry {
	qorperaAttachments?: unknown;
	type?: unknown;
	id?: unknown;
	message?: { role?: unknown; content?: unknown };
	delivery?: { schema?: unknown; phase?: unknown };
	execution?: { kind?: unknown; id?: unknown; claimantId?: unknown; runnerAssignmentId?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function attachmentMetadata(item: Record<string, unknown>): TranscriptAttachment {
	const name = typeof item.name === "string" ? item.name : typeof item.filename === "string" ? item.filename : "";
	const mediaType =
		typeof item.mimeType === "string"
			? item.mimeType
			: typeof item.mediaType === "string"
				? item.mediaType
				: undefined;
	const kind = item.type === "file" ? "file" : "image";
	return {
		kind,
		name: name.trim().slice(0, 256) || (kind === "image" ? "Image attachment" : "File attachment"),
		...(mediaType ? { mediaType: mediaType.slice(0, 128) } : {}),
		...(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0
			? { bytes: item.bytes }
			: {}),
	};
}

function contentText(content: unknown): { text: string; attachments: TranscriptAttachment[] } {
	if (typeof content === "string") return { text: content, attachments: [] };
	if (!Array.isArray(content)) return { text: "", attachments: [] };
	const parts: string[] = [];
	const attachments: TranscriptAttachment[] = [];
	for (const part of content) {
		const item = asRecord(part);
		if (!item) continue;
		if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
		else if (item.type === "image" || item.type === "image_url" || item.type === "file")
			attachments.push(attachmentMetadata(item));
	}
	return { text: parts.join("\n"), attachments };
}

function decodeLegacyParts(parts: string[]): Entry | undefined {
	try {
		const bytes = parts.map((part) => Uint8Array.from(atob(part), (character) => character.charCodeAt(0)));
		const length = bytes.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const joined = new Uint8Array(length);
		let offset = 0;
		for (const chunk of bytes) {
			joined.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
		return asRecord(parsed) as Entry | undefined;
	} catch {
		return undefined;
	}
}

function messageFromEntry(entry: Entry, event: HostedSessionEvent, legacy: boolean): TranscriptMessage | undefined {
	if (entry.type !== "message" || !entry.message) return undefined;
	const { text, attachments } = contentText(entry.message.content);
	if (entry.message.role === "user") {
		// Member input. Cloud-admitted inputs carry the session input id; legacy
		// desktop entries are attributed through the event actor.
		if (!legacy && !event.sessionInputId) return undefined;
		if (
			!legacy &&
			event.eventId === event.sessionInputId &&
			entry.id === event.eventId &&
			Array.isArray(entry.qorperaAttachments)
		) {
			const images = entry.qorperaAttachments;
			let total = 0;
			const canonical: TranscriptAttachment[] = [];
			for (const image of images.slice(0, 6)) {
				const ref = asRecord(image);
				if (
					!ref ||
					Object.keys(ref).length !== 3 ||
					typeof ref.objectSha256 !== "string" ||
					!/^[0-9a-f]{64}$/.test(ref.objectSha256) ||
					typeof ref.bytes !== "number" ||
					!Number.isSafeInteger(ref.bytes) ||
					ref.bytes < 1 ||
					typeof ref.mediaType !== "string" ||
					!SESSION_IMAGE_TYPES.has(ref.mediaType)
				)
					break;
				total += ref.bytes;
				canonical.push({
					kind: "image",
					name: "Image attachment",
					bytes: ref.bytes,
					mediaType: ref.mediaType,
					reference: { sha256: ref.objectSha256, bytes: ref.bytes, mediaType: ref.mediaType },
				});
			}
			if (images.length <= 5 && canonical.length === images.length && total <= 8 * 1024 * 1024)
				attachments.push(...canonical);
		}
		return {
			kind: "member",
			id: event.eventId,
			sequence: event.sequence,
			authorUserId: event.actorUserId,
			text,
			attachmentCount: attachments.length,
			...(attachments.length ? { attachments } : {}),
			createdAt: event.createdAt,
		};
	}
	if (entry.message.role === "assistant") {
		// Only an explicit send operation is public output (§6.1).
		if (
			legacy ||
			entry.delivery?.schema !== AGENT_SEND_SCHEMA ||
			(entry.delivery.phase !== "progress" && entry.delivery.phase !== "final") ||
			event.sessionInputId ||
			entry.id !== event.eventId ||
			event.execution?.kind !== "run" ||
			entry.execution?.kind !== "run" ||
			entry.execution.id !== event.execution.id ||
			entry.execution.claimantId !== event.execution.claimantId ||
			!event.execution.runnerAssignmentId ||
			entry.execution.runnerAssignmentId !== event.execution.runnerAssignmentId
		)
			return undefined;
		const phase = entry.delivery.phase;
		const runId = event.execution.id;
		return {
			kind: "agent",
			id: event.eventId,
			sequence: event.sequence,
			text,
			attachmentCount: attachments.length,
			...(attachments.length ? { attachments } : {}),
			phase,
			...(runId ? { runId } : {}),
			createdAt: event.createdAt,
		};
	}
	return undefined;
}

export function projectTranscript(
	events: readonly HostedSessionEvent[],
	pending: readonly PendingSessionInput[] = [],
): TranscriptProjection {
	const items: TranscriptItem[] = [];
	let hiddenCount = 0;
	let lastSequence = 0;
	const inputIds = new Set<string>();
	const legacyParts = new Map<string, { count: number; parts: (string | null)[]; event: HostedSessionEvent }>();
	for (const event of events) {
		lastSequence = Math.max(lastSequence, event.sequence);
		if (event.sessionInputId) inputIds.add(event.sessionInputId);
		if (event.eventType === "authorization_request" || event.eventType === "authorization_decision") {
			items.push({
				kind: event.eventType,
				id: event.eventId,
				sequence: event.sequence,
				actorUserId: event.actorUserId,
				body: event.body,
				createdAt: event.createdAt,
			});
			continue;
		}
		if (event.eventType !== "message") {
			if (event.eventType !== "session_info") hiddenCount++;
			continue;
		}
		const body = asRecord(event.body);
		if (!body) {
			hiddenCount++;
			continue;
		}
		if (body.schema === RUNNER_ENTRY_SCHEMA) {
			const message = messageFromEntry((asRecord(body.entry) ?? {}) as Entry, event, false);
			if (message) items.push(message);
			else hiddenCount++;
			continue;
		}
		if (body.schema === LEGACY_PART_SCHEMA) {
			const entryId = typeof body.entryId === "string" ? body.entryId : undefined;
			const partIndex = body.partIndex;
			const partCount = body.partCount;
			if (
				!entryId ||
				!Number.isSafeInteger(partIndex) ||
				!Number.isSafeInteger(partCount) ||
				(partCount as number) < 1 ||
				(partCount as number) > 128 ||
				(partIndex as number) < 0 ||
				(partIndex as number) >= (partCount as number) ||
				typeof body.payloadBase64 !== "string"
			) {
				hiddenCount++;
				continue;
			}
			let pendingEntry = legacyParts.get(entryId);
			if (
				pendingEntry &&
				(pendingEntry.count !== partCount || pendingEntry.event.actorUserId !== event.actorUserId)
			) {
				hiddenCount++;
				continue;
			}
			if (!pendingEntry) {
				pendingEntry = {
					count: partCount as number,
					parts: Array.from({ length: partCount as number }, () => null),
					event,
				};
				legacyParts.set(entryId, pendingEntry);
			}
			pendingEntry.parts[partIndex as number] = body.payloadBase64;
			if (pendingEntry.parts.some((part) => part === null)) continue;
			legacyParts.delete(entryId);
			const entry = decodeLegacyParts(pendingEntry.parts as string[]);
			const message = entry ? messageFromEntry(entry, pendingEntry.event, true) : undefined;
			if (message) items.push(message);
			else hiddenCount++;
			continue;
		}
		hiddenCount++;
	}
	hiddenCount += legacyParts.size;
	for (const input of pending) {
		if (input.kind !== "user_message" || inputIds.has(input.inputId)) continue;
		const body = asRecord(input.body);
		if (body?.schema === "qorpera.staff-intro-retry/v1") continue;
		const text =
			typeof body?.displayText === "string" ? body.displayText : typeof body?.text === "string" ? body.text : "";
		const images = Array.isArray(body?.images) ? body.images : [];
		const attachments = images.map((image) => attachmentMetadata({ ...asRecord(image), type: "image" }));
		items.push({
			kind: "member",
			id: input.inputId,
			sequence: Number.MAX_SAFE_INTEGER,
			authorUserId: input.authorUserId,
			text,
			attachmentCount: attachments.length,
			...(attachments.length ? { attachments } : {}),
			createdAt: input.createdAt,
			pending: input.status,
			...(input.failureReason ? { failureReason: input.failureReason } : {}),
		});
	}
	items.sort((a, b) => (a.sequence === b.sequence ? a.createdAt.localeCompare(b.createdAt) : a.sequence - b.sequence));
	return { items, hiddenCount, lastSequence };
}
