import type { CloudSessionAttachment } from "@qorpera/cloud-client/cloud-session-attachments";
import {
	type InteractionAnswer,
	type InteractionRequest,
	parseInteractionAnswerEvent,
	parseInteractionAnswerInput,
	parseInteractionRequest,
} from "./interactions.ts";
import { type InterfaceChange, parseInterfaceChange } from "./interface-changes.ts";
import { type MessageQuote, parseQuotes } from "./quotes.ts";
import { SESSION_IMAGE_TYPES } from "./session-attachments.ts";
import type { HostedSessionEvent, HostedStaffSpeaker, JsonValue, PendingSessionInput } from "./types.ts";

/* Transcript projection (runtime contract §6; launch acceptance item 8).
 * Only two things become visible conversation content: a member's admitted
 * input and an agent's send operation. Everything else — provider text without
 * a send record, receipts, session metadata, legacy local-executor output — is
 * counted and hidden. This module is pure so it can be tested without a DOM. */

export const RUNNER_ENTRY_SCHEMA = "qorpera.runner-transcript-entry/v1";
export const LEGACY_PART_SCHEMA = "qorpera.shared-trail-entry-part/v1";
export const SESSION_METADATA_SCHEMA = "qorpera.shared-session-metadata/v1";
export const AGENT_SEND_SCHEMA = "qorpera.agent-send/v1";
/** A message between two agents, written by the kernel into their pair transcript (contract 14.6). */
export const PEER_MESSAGE_SCHEMA = "qorpera.peer-message/v1";
/** The chip in an agent's own thread that points at a peer message. */
export const PEER_LINK_SCHEMA = "qorpera.peer-link/v1";
/** One line in a pair transcript saying why an exchange stopped. */
export const PEER_BUDGET_SCHEMA = "qorpera.peer-budget/v1";
/** A member stopped a chain of agent work: the cards it raised in this conversation stay open (contract 14.6). */
export const CHAIN_STOPPED_SCHEMA = "qorpera.chain-stopped/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TranscriptMessage {
	kind: "member" | "agent";
	id: string;
	sequence: number;
	authorUserId?: string;
	text: string;
	/** A member's quotes of outside content in `text` (20260928459100): shown as quoted, never as their words. */
	quotes?: readonly MessageQuote[];
	attachmentCount: number;
	attachments?: TranscriptAttachment[];
	phase?: "progress" | "final";
	runId?: string;
	staffSpeaker?: HostedStaffSpeaker;
	/** A peer message sent without waking its recipient; it is read at the recipient's next turn. */
	held?: boolean;
	/** A message, question, answer or authorization a member erased (20260930441000): its body gone, its place kept. */
	erased?: true;
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
	/** An approval card's answer still on its way (queued, not yet in the transcript). */
	answer?: InteractionAnswer;
	/** An answer was given and its delivery failed: the card is open again. */
	answerFailed?: boolean;
	/** A member stopped the work that raised the card; an answer starts new work. */
	chainStopped?: boolean;
}

export interface TranscriptPeerLink {
	kind: "peer_link";
	id: string;
	sequence: number;
	direction: "in" | "out";
	/** Left without waking the coworker; read at its next turn. */
	held?: boolean;
	counterpartStaffId: string;
	pairSessionId: string;
	createdAt: string;
}

export interface TranscriptNote {
	kind: "note";
	id: string;
	sequence: number;
	text: string;
	createdAt: string;
}

/** An agent's change to the company's interfaces or tables, saved without review: one line with Undo (Interfaces I10). */
export interface TranscriptInterfaceChange {
	kind: "interface_change";
	id: string;
	sequence: number;
	change: InterfaceChange;
	createdAt: string;
}

/** A typed card the agent raised, with the member's answer once there is one
 * (queued or written). An answer whose card is not in the loaded window is dropped. */
export interface TranscriptInteraction {
	kind: "interaction";
	id: string;
	sequence: number;
	actorUserId: string;
	request: InteractionRequest;
	answer?: InteractionAnswer;
	/** An answer was sent and its delivery failed, so it never reached the agent: the card is open again. */
	answerFailed?: boolean;
	/** A member stopped the work that raised the card; an answer starts new work. */
	chainStopped?: boolean;
	createdAt: string;
}

export type TranscriptItem =
	| TranscriptMessage
	| TranscriptCard
	| TranscriptPeerLink
	| TranscriptNote
	| TranscriptInterfaceChange
	| TranscriptInteraction;

export interface TranscriptProjection {
	items: TranscriptItem[];
	/** Events in the store that are not public output and were not rendered. */
	hiddenCount: number;
	lastSequence: number;
}

interface Entry {
	qorperaAttachments?: unknown;
	qorperaQuotes?: unknown;
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
		const admitted = !legacy && event.eventId === event.sessionInputId && entry.id === event.eventId;
		// The input's quotes, kept beside its attachments. A list that doesn't fit the text is left out: the text still
		// shows its marks.
		const quotes = admitted && entry.qorperaQuotes !== undefined ? parseQuotes(entry.qorperaQuotes, text) : undefined;
		if (admitted && Array.isArray(entry.qorperaAttachments)) {
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
			...(quotes ? { quotes } : {}),
			attachmentCount: attachments.length,
			...(attachments.length ? { attachments } : {}),
			createdAt: event.createdAt,
		};
	}
	if (entry.message.role === "assistant" && entry.delivery?.schema === PEER_MESSAGE_SCHEMA) {
		// A peer message: kernel-written into the pair transcript, spoken by the
		// sending agent named in the entry. It has no run execution identity of its
		// own and never counts as one of the sender's public sends.
		const delivery = entry.delivery as Record<string, unknown>;
		if (
			legacy ||
			event.sessionInputId ||
			event.execution ||
			entry.id !== event.eventId ||
			typeof delivery.from !== "string" ||
			!UUID.test(delivery.from) ||
			typeof delivery.runId !== "string" ||
			!UUID.test(delivery.runId) ||
			!Number.isSafeInteger(delivery.staffVersion) ||
			(delivery.staffVersion as number) < 1
		)
			return undefined;
		return {
			kind: "agent",
			id: event.eventId,
			sequence: event.sequence,
			text,
			attachmentCount: 0,
			phase: "final",
			runId: delivery.runId,
			...(delivery.held === true ? { held: true } : {}),
			staffSpeaker: {
				runId: delivery.runId,
				staffAgentId: delivery.from,
				staffVersion: delivery.staffVersion as number,
				...(typeof delivery.displayName === "string" && delivery.displayName.trim()
					? { displayName: delivery.displayName }
					: {}),
			},
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
			...(event.staffSpeaker?.runId === runId ? { staffSpeaker: event.staffSpeaker } : {}),
			createdAt: event.createdAt,
		};
	}
	return undefined;
}

/** An event a member erased (20260930441000): the cloud replaces its body with exactly `{"erased": true}`. */
export function isErased(body: JsonValue): boolean {
	const record = asRecord(body);
	return record?.erased === true && Object.keys(record).length === 1;
}

/** An erased event keeps its place, its author and the run that wrote it. A member's input, answer or decision stands
 * as theirs; anything else as the agent's. */
function erasedMessage(event: HostedSessionEvent): TranscriptMessage {
	const base = {
		id: event.eventId,
		sequence: event.sequence,
		text: "",
		attachmentCount: 0,
		erased: true as const,
		createdAt: event.createdAt,
	};
	const { eventType } = event;
	if (event.sessionInputId || eventType === "interaction_answer" || eventType === "authorization_decision")
		return { kind: "member", ...base, authorUserId: event.actorUserId };
	const runId = event.execution?.kind === "run" ? event.execution.id : undefined;
	return {
		kind: "agent",
		...base,
		...(runId ? { runId } : {}),
		...(runId && event.staffSpeaker?.runId === runId ? { staffSpeaker: event.staffSpeaker } : {}),
	};
}

export function projectTranscript(
	events: readonly HostedSessionEvent[],
	pending: readonly PendingSessionInput[] = [],
): TranscriptProjection {
	const items: TranscriptItem[] = [];
	let hiddenCount = 0;
	let lastSequence = 0;
	const inputIds = new Set<string>();
	const interactions = new Map<string, TranscriptInteraction>();
	const cards = new Map<string, TranscriptCard>();
	const answers = new Map<string, InteractionAnswer>();
	const failedAnswers = new Set<string>();
	const stoppedCards = new Set<string>();
	const legacyParts = new Map<string, { count: number; parts: (string | null)[]; event: HostedSessionEvent }>();
	for (const event of events) {
		lastSequence = Math.max(lastSequence, event.sequence);
		if (event.sessionInputId) inputIds.add(event.sessionInputId);
		if (isErased(event.body)) {
			items.push(erasedMessage(event));
			continue;
		}
		if (event.eventType === "authorization_request" || event.eventType === "authorization_decision") {
			const card: TranscriptCard = {
				kind: event.eventType,
				id: event.eventId,
				sequence: event.sequence,
				actorUserId: event.actorUserId,
				body: event.body,
				createdAt: event.createdAt,
			};
			if (event.eventType === "authorization_request") cards.set(event.eventId.toLowerCase(), card);
			items.push(card);
			continue;
		}
		if (event.eventType === "interaction_request") {
			const request = parseInteractionRequest(event.body);
			if (!request) {
				hiddenCount++;
				continue;
			}
			const interaction: TranscriptInteraction = {
				kind: "interaction",
				id: event.eventId,
				sequence: event.sequence,
				actorUserId: event.actorUserId,
				request,
				createdAt: event.createdAt,
			};
			interactions.set(event.eventId.toLowerCase(), interaction);
			items.push(interaction);
			continue;
		}
		if (event.eventType === "interaction_answer") {
			const parsed = parseInteractionAnswerEvent(event.body);
			if (parsed) answers.set(parsed.interactionId, { ...parsed.answer, answeredAt: event.createdAt });
			else hiddenCount++;
			continue;
		}
		if (event.eventType !== "message") {
			if (event.eventType === "session_info") {
				const info = asRecord(event.body);
				if (
					info?.schema === PEER_LINK_SCHEMA &&
					(info.direction === "in" || info.direction === "out") &&
					typeof info.counterpartStaffId === "string" &&
					UUID.test(info.counterpartStaffId) &&
					typeof info.pairSessionId === "string" &&
					UUID.test(info.pairSessionId)
				)
					items.push({
						kind: "peer_link",
						id: event.eventId,
						sequence: event.sequence,
						direction: info.direction,
						...(info.held === true ? { held: true } : {}),
						counterpartStaffId: info.counterpartStaffId,
						pairSessionId: info.pairSessionId,
						createdAt: event.createdAt,
					});
				else if (info?.schema === CHAIN_STOPPED_SCHEMA && Array.isArray(info.cardIds)) {
					// Drawn on its cards, which may be anywhere above it; a card not loaded is left alone.
					for (const cardId of info.cardIds)
						if (typeof cardId === "string" && UUID.test(cardId)) stoppedCards.add(cardId.toLowerCase());
				} else if (info?.schema === PEER_BUDGET_SCHEMA && typeof info.text === "string" && info.text.trim())
					items.push({
						kind: "note",
						id: event.eventId,
						sequence: event.sequence,
						text: info.text.slice(0, 512),
						createdAt: event.createdAt,
					});
				else {
					const change = parseInterfaceChange(info);
					if (change)
						items.push({
							kind: "interface_change",
							id: event.eventId,
							sequence: event.sequence,
							change,
							createdAt: event.createdAt,
						});
				}
			} else hiddenCount++;
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
	const waiting: TranscriptMessage[] = [];
	for (const input of pending) {
		if (input.kind !== "user_message" || inputIds.has(input.inputId)) continue;
		const body = asRecord(input.body);
		if (body?.schema === "qorpera.staff-intro-retry/v1") continue;
		const queuedAnswer = parseInteractionAnswerInput(input.body);
		if (queuedAnswer) {
			// A queued answer shows on its card, never as a message bubble. One whose
			// delivery failed never reached the agent and settles nothing.
			if (input.status === "failed") failedAnswers.add(queuedAnswer.interactionId);
			else if (!answers.has(queuedAnswer.interactionId))
				answers.set(queuedAnswer.interactionId, {
					...queuedAnswer.answer,
					answeredBy: input.authorUserId,
					answeredAt: input.createdAt,
					pending: true,
				});
			continue;
		}
		const text =
			typeof body?.displayText === "string" ? body.displayText : typeof body?.text === "string" ? body.text : "";
		// A quoted message has no displayText, so its quotes are spans of the text shown.
		const quotes =
			body?.quotes !== undefined && body.displayText === undefined ? parseQuotes(body.quotes, text) : undefined;
		const images = Array.isArray(body?.images) ? body.images : [];
		const attachments = images.map((image) => attachmentMetadata({ ...asRecord(image), type: "image" }));
		waiting.push({
			kind: "member",
			id: input.inputId,
			sequence: Number.MAX_SAFE_INTEGER,
			authorUserId: input.authorUserId,
			text,
			...(quotes ? { quotes } : {}),
			attachmentCount: attachments.length,
			...(attachments.length ? { attachments } : {}),
			createdAt: input.createdAt,
			pending: input.status,
			...(input.failureReason ? { failureReason: input.failureReason } : {}),
		});
	}
	for (const [interactionId, answer] of answers) {
		const interaction = interactions.get(interactionId) ?? cards.get(interactionId);
		if (interaction) interaction.answer = answer;
	}
	for (const interactionId of failedAnswers) {
		const interaction = interactions.get(interactionId) ?? cards.get(interactionId);
		if (interaction && !interaction.answer) interaction.answerFailed = true;
	}
	for (const cardId of stoppedCards) {
		const card = interactions.get(cardId) ?? cards.get(cardId);
		if (card) card.chainStopped = true;
	}
	items.sort((a, b) => (a.sequence === b.sequence ? a.createdAt.localeCompare(b.createdAt) : a.sequence - b.sequence));
	// A waiting message stands before the first member message sent after it, else at
	// the end. At the end always, one the cloud never takes would sink under days of
	// newer messages. Agent output is no measure: a message sent while the agent works
	// stays below it, where it lands once taken (a taken input keeps its send time).
	let from = 0;
	for (const message of waiting) {
		const sent = Date.parse(message.createdAt);
		let at = from;
		// Waiting messages placed so far all stand before `from`.
		while (at < items.length && !(items[at]!.kind === "member" && Date.parse(items[at]!.createdAt) > sent)) at++;
		items.splice(at, 0, message);
		from = at + 1;
	}
	return { items, hiddenCount, lastSequence };
}
