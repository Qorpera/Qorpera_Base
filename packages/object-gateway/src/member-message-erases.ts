import type { IncomingMessage, ServerResponse } from "node:http";
import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { memberFolderWriter } from "./member-folder-commits.ts";
import { UUID } from "./native-objects.ts";

/*
 * A member's erase of one message (summary trees M3c; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10, migration
 * 20260930441000). An owner or admin asks to erase one message, question, answer or authorization of a room's
 * conversation, and reads where the erase stands; the eraser (memory-message-eraser.ts) carries it out.
 * - `POST …/<environmentId>/<sessionId>/<eventId>`, with no body: the writer check
 *   (`qorpera_member_folder_writer`, with the member's token) names the member, and the request
 *   (`qorpera_memory_message_erase_request`, with the service key) records the erase for that member, or answers the
 *   one already asked for the event.
 * - `GET …/<environmentId>/<eraseId>`: where the erase stands (`qorpera_memory_message_erase_status`), the member
 *   named the same way.
 * Both answer the erase (`qorpera.memory-message-erase/v1`) as the database gave it, with the copies it leaves
 * (`copies`, migration 20260930470000): files at other paths, in any environment of the company, that hold the
 * message's memory, each `{environmentId, path, live}`, which the member erases there by their paths. The database's
 * refusals keep their statuses: 42501 (not a member, or not an owner or admin asking) is 403, P0002 (no such
 * conversation, message or erase, or one a member who is no owner or admin reads) 404, 22023 400, and 55000 (a paused
 * company) 423.
 */

const ROUTE = /^\/v1\/member-message-erases\/([0-9a-f-]{36})\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/;
const KEYS = ["schema", "eraseId", "state", "sessionId", "eventId", "blocks", "runsPending", "copies"] as const;
const STATES = new Set(["pending", "open", "rewritten", "requested", "done", "refused"]);

export interface MemberMessageEraseOptions {
	readonly authority: Pick<MemberCompanyAuthority, "member" | "publisher">;
}

/**
 * A copy the erase leaves: its environment and path, and whether the path is in that folder now (else only its history
 * holds it).
 */
function copy(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { environmentId, path, live, ...rest } = value as Record<string, unknown>;
	return (
		typeof environmentId === "string" &&
		UUID.test(environmentId) &&
		typeof path === "string" &&
		path !== "" &&
		typeof live === "boolean" &&
		Object.keys(rest).length === 0
	);
}

/** The database's answer: one erase, with the ids the route asked for in `expected`; 503 otherwise. */
function erase(value: unknown, expected: Record<string, string>): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObjectDependencyError(503);
	const item = value as Record<string, unknown>;
	const id = (key: string) => {
		const value = item[key];
		return typeof value === "string" && UUID.test(value);
	};
	const count = (key: string) => Number.isSafeInteger(item[key]) && (item[key] as number) >= 0;
	if (
		Object.keys(item).length !== KEYS.length ||
		KEYS.some((key) => !Object.hasOwn(item, key)) ||
		item.schema !== "qorpera.memory-message-erase/v1" ||
		!id("eraseId") ||
		!id("sessionId") ||
		!id("eventId") ||
		typeof item.state !== "string" ||
		!STATES.has(item.state) ||
		!count("blocks") ||
		!count("runsPending") ||
		!Array.isArray(item.copies) ||
		!item.copies.every(copy) ||
		Object.entries(expected).some(([key, wanted]) => item[key] !== wanted)
	)
		throw new ObjectDependencyError(503);
	return item;
}

/** The member is the one the database names for the token; a request's body or headers never name them. */
export async function serveMemberMessageErase(
	request: IncomingMessage,
	response: ServerResponse,
	options: MemberMessageEraseOptions,
): Promise<void> {
	const match = ROUTE.exec(request.url ?? "");
	if (!match || !UUID.test(match[1]) || !UUID.test(match[2]) || (match[3] !== undefined && !UUID.test(match[3])))
		throw new ObjectDependencyError(404);
	const [, environmentId, id, eventId] = match;
	if (request.method !== (eventId ? "POST" : "GET")) throw new ObjectDependencyError(405);
	const header = request.headers.authorization;
	if (!header || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header)) throw new ObjectDependencyError(401);
	const length = request.headers["content-length"];
	if ((length !== undefined && length !== "0") || request.headers["transfer-encoding"] !== undefined)
		throw new ObjectDependencyError(400);
	const token = header.slice(7);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new ObjectDependencyError(503)), 30_000);
	const signal = controller.signal;
	try {
		const member = memberFolderWriter(
			await options.authority.member(
				"qorpera_member_folder_writer",
				token,
				{ p_environment_id: environmentId },
				signal,
			),
		);
		const ids = { p_environment_id: environmentId, p_user_id: member.actor.userId };
		const answer = eventId
			? erase(
					await options.authority.publisher(
						"qorpera_memory_message_erase_request",
						{ ...ids, p_session_id: id, p_event_id: eventId },
						signal,
					),
					{ sessionId: id, eventId },
				)
			: erase(
					await options.authority.publisher(
						"qorpera_memory_message_erase_status",
						{ ...ids, p_erase_id: id },
						signal,
					),
					{ eraseId: id },
				);
		signal.throwIfAborted();
		response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store" });
		response.end(JSON.stringify(answer));
	} finally {
		clearTimeout(timer);
	}
}
