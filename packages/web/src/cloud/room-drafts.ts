import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, record, timestamp, uuid } from "./parse.ts";
import { type MessageQuote, parseQuotes, QUOTES_MAX } from "./quotes.ts";
import type { RealtimePhase } from "./realtime.ts";

/* Shared drafts (20260928000500): a room member's unsent message, which the
 * room's other members see and edit live. The cloud orders every change by
 * revision and names the editor; the member's own browser sends the message,
 * as an ordinary room post, when it is ready. */

export interface RoomDraft {
	roomId: string;
	ownerUserId: string;
	body: string;
	/** The body's quotes of outside content (20260928469160), when it holds any. */
	quotes?: readonly MessageQuote[];
	revision: number;
	editorUserId: string;
	contributors: readonly string[];
	updatedAt: string;
}

export type RoomDraftWrite =
	| { status: "ok"; draft: RoomDraft }
	/** Someone changed the draft first: nothing was written, and this is the draft now. */
	| { status: "stale"; draft: RoomDraft }
	/** The draft is not there to edit: its owner left the room, or never started it. */
	| { status: "gone" };

/** The cloud's limit on a draft, in UTF-8 bytes (the room post limit). */
export const ROOM_DRAFT_BYTES = 65536;

export function parseRoomDraft(value: unknown, roomId: string): RoomDraft {
	const input = record(value, "room draft");
	if (input.schema !== "qorpera.room-draft/v1" || uuid(input.roomId, "room draft room") !== roomId)
		throw new CloudShapeError("room draft");
	if (typeof input.body !== "string" || new TextEncoder().encode(input.body).length > ROOM_DRAFT_BYTES)
		throw new CloudShapeError("room draft text");
	// A draft carries `quotes` only when it holds any, checked as a message's are. A draft whose quotes this client
	// can't hold (a quote whose words hold « or », which the cloud refuses since 20260930087000) is as good as absent:
	// none of its text is shown, so none of it can become the member's own words. It keeps its revision, so the owner's
	// next save lands over it, as any first save over a draft does; with no text, a teammate's is not listed.
	const quotes = input.quotes === undefined ? undefined : parseQuotes(input.quotes, input.body);
	const readable = input.quotes === undefined || quotes !== undefined;
	return {
		roomId,
		ownerUserId: uuid(input.ownerUserId, "room draft owner"),
		body: readable ? input.body : "",
		...(quotes ? { quotes } : {}),
		revision: boundedInteger(input.revision, "room draft revision", 0, Number.MAX_SAFE_INTEGER),
		editorUserId: uuid(input.editorUserId, "room draft editor"),
		contributors: array(input.contributors, "room draft contributors")
			.slice(0, 64)
			.map((id) => uuid(id, "room draft contributor")),
		updatedAt: timestamp(input.updatedAt, "room draft time"),
	};
}

export async function listRoomDrafts(cloud: Cloud, roomId: string): Promise<RoomDraft[]> {
	const input = record(await cloud.rpc("qorpera_list_room_drafts", { p_room_id: roomId }), "room drafts");
	if (input.schema !== "qorpera.room-drafts/v1" || uuid(input.roomId, "room drafts room") !== roomId)
		throw new CloudShapeError("room drafts");
	return array(input.drafts, "room drafts").map((draft) => parseRoomDraft(draft, roomId));
}

/** A draft's quotes this client can't write as they are: more than a message carries, or quotes that don't fit the
 * text. A write would fail the same way every time, so the draft waits for the member to change it. */
export class DraftQuotesError extends Error {
	/** More quotes than a message carries (the member removes some). */
	readonly tooMany: boolean;

	constructor(tooMany: boolean) {
		super(tooMany ? "A draft holds more quotes than a message can." : "Draft quotes are invalid.");
		this.name = "DraftQuotesError";
		this.tooMany = tooMany;
	}
}

/** Write a draft from `baseRevision`. This client knows quotes, so it always sends the draft's list: an empty one
 * when it holds none, which the cloud stores as none. A save that dropped a quote's record while keeping its words
 * is refused (22023); the composer never makes one (app/quotes.ts). */
export async function putRoomDraft(
	cloud: Cloud,
	roomId: string,
	ownerUserId: string,
	baseRevision: number,
	body: string,
	quotes: readonly MessageQuote[],
): Promise<RoomDraftWrite> {
	// A lone surrogate is not text the cloud can store; one character stands in for it, so the quotes still fit.
	const text = body.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
	if (quotes.length && !parseQuotes(quotes, text)) throw new DraftQuotesError(quotes.length > QUOTES_MAX);
	const input = record(
		await cloud.rpc("qorpera_put_room_draft", {
			p_room_id: roomId,
			p_owner_user_id: ownerUserId,
			p_base_revision: baseRevision,
			p_body: text,
			p_quotes: quotes.map(({ start, end, source, ref }) => ({ start, end, source, ref })),
		}),
		"room draft write",
	);
	if (input.schema !== "qorpera.room-draft-write/v1") throw new CloudShapeError("room draft write");
	if (input.status === "gone") return { status: "gone" };
	if (input.status !== "ok" && input.status !== "stale") throw new CloudShapeError("room draft write");
	const draft = parseRoomDraft(input.draft, roomId);
	if (draft.ownerUserId !== ownerUserId) throw new CloudShapeError("room draft write");
	return { status: input.status, draft };
}

export interface RoomDraftSubscription {
	stop(): Promise<void>;
}

/** The room's private draft topic. Members receive it; only the cloud publishes,
 * so a change carries the editor the cloud named. Lossy: a missed change is
 * recovered by the next listing or by a write that comes back stale. */
export function subscribeRoomDrafts(
	cloud: Cloud,
	roomId: string,
	onDraft: (draft: RoomDraft) => void,
	onHealth: (phase: RealtimePhase) => void,
): RoomDraftSubscription {
	const channel: RealtimeChannel = cloud.supabase
		.channel(`qorpera-room-drafts-${roomId}`, { config: { private: true } })
		.on("broadcast", { event: "draft" }, (message: { payload?: unknown }) => {
			try {
				onDraft(parseRoomDraft(message.payload, roomId));
			} catch {
				// A malformed change is skipped; the next listing restores the draft.
			}
		});
	onHealth("connecting");
	channel.subscribe((status) => {
		if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) onHealth("connected");
		else if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT)
			onHealth("degraded");
		else if (status === REALTIME_SUBSCRIBE_STATES.CLOSED) onHealth("stopped");
	});
	return {
		async stop() {
			await cloud.supabase.removeChannel(channel);
		},
	};
}
