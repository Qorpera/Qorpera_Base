import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { UUID_PATTERN } from "./parse.ts";

/** Where an erase of one message stands (summary trees M3c, `qorpera.memory-message-erase/v1`). From `open` on, the
 * message is blanked in the thread; `rewritten` and `requested` are the company's memory being cleared of it, and
 * `done` holds no copy of it anywhere. `refused`: the member who asked was no longer an owner or admin when it
 * started. */
export type MessageEraseState = "pending" | "open" | "rewritten" | "requested" | "done" | "refused";

export interface MessageErase {
	readonly eraseId: string;
	readonly state: MessageEraseState;
	readonly sessionId: string;
	readonly eventId: string;
}

/** The erase route refused or gave no usable answer. `status` is its HTTP status, or null without one: 403 when the
 * member is not an owner or admin, 404 when the message (or the erase) is not there for them, 423 while the company is
 * paused or being deleted. */
export class MessageEraseError extends Error {
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = "MessageEraseError";
		this.status = status;
	}
}

/** A member's erases of single messages, for the whole company: there is no per-member copy of a conversation. */
export interface WebMessageErases {
	/** Asks to erase one event of a conversation. A second ask for the same message joins the first, and one already
	 * erased answers with the erase that did it. */
	request(sessionId: string, eventId: string, signal: AbortSignal): Promise<MessageErase>;
	/** Reads where an erase stands now. */
	status(erase: MessageErase, signal: AbortSignal): Promise<MessageErase>;
}

const SCHEMA = "qorpera.memory-message-erase/v1";
const STATES: ReadonlySet<string> = new Set<MessageEraseState>([
	"pending",
	"open",
	"rewritten",
	"requested",
	"done",
	"refused",
]);
/** The gateway gives its database calls 30 seconds; this covers them and the way there and back. */
const TIMEOUT_MS = 35_000;
const MAX_ANSWER_BYTES = 4096;

/** The erase route (`/v1/member-message-erases/`, object gateway) under the member's own token and transport. */
export function createWebMessageErases(options: {
	readonly environmentId: string;
	readonly objectGatewayUrl: string;
	readonly accessToken: (signal: AbortSignal) => Promise<string>;
	readonly fetch: typeof fetch;
}): WebMessageErases {
	const origin = new URL(options.objectGatewayUrl).origin;
	const call = async (
		method: "POST" | "GET",
		ids: readonly string[],
		expected: Partial<MessageErase>,
		signal: AbortSignal,
	): Promise<MessageErase> => {
		for (const id of [options.environmentId, ...ids])
			if (!UUID_PATTERN.test(id)) throw new MessageEraseError("Invalid message erase");
		return withCloudDeadline(
			async (requestSignal) => {
				const token = await options.accessToken(requestSignal);
				// No body and no content type: the gateway and its bridge take the authorization header alone.
				const response = await options.fetch(
					`${origin}/v1/member-message-erases/${[options.environmentId, ...ids].join("/")}`,
					{
						method,
						headers: { authorization: `Bearer ${token}` },
						signal: requestSignal,
						redirect: "error",
						cache: "no-store",
						credentials: "omit",
					},
				);
				if (response.status !== 200) {
					void response.body?.cancel().catch(() => undefined);
					throw new MessageEraseError(`Message erase is unavailable (${response.status})`, response.status);
				}
				const bytes = await readBoundedCloudResponse(response, MAX_ANSWER_BYTES, requestSignal);
				let value: unknown;
				try {
					value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				} catch {
					throw new MessageEraseError("Invalid message erase answer");
				}
				return parseMessageErase(value, expected);
			},
			TIMEOUT_MS,
			signal,
		);
	};
	return {
		request: (sessionId, eventId, signal) => call("POST", [sessionId, eventId], { sessionId, eventId }, signal),
		status: (erase, signal) => call("GET", [erase.eraseId], erase, signal),
	};
}

/** An answer counts only for the erase, conversation and message it was asked about. */
function parseMessageErase(value: unknown, expected: Partial<MessageErase>): MessageErase {
	const answer = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
	const id = (key: "eraseId" | "sessionId" | "eventId") => {
		const found = answer[key];
		const asked = expected[key];
		if (
			typeof found !== "string" ||
			!UUID_PATTERN.test(found) ||
			(asked !== undefined && found.toLowerCase() !== asked.toLowerCase())
		)
			throw new MessageEraseError("Invalid message erase answer");
		return found.toLowerCase();
	};
	const state = answer.state;
	if (answer.schema !== SCHEMA || typeof state !== "string" || !STATES.has(state))
		throw new MessageEraseError("Invalid message erase answer");
	return {
		eraseId: id("eraseId"),
		state: state as MessageEraseState,
		sessionId: id("sessionId"),
		eventId: id("eventId"),
	};
}
