import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";
import { UUID_PATTERN } from "./parse.ts";

export interface RoomMessageInput {
	roomId: string;
	sessionId: string;
	environmentId: string;
	clientInputId: string;
	text: string;
	/** Staged uploads of this input: an agent thread takes them, a group chat since 20260928030000. */
	images?: readonly { objectSha256: string; bytes: number; mediaType: string }[];
	sponsorBindingId: string;
	sponsorVersion: number;
}
export interface RoomMessageReceipt {
	schema: "qorpera.company-room-post/v1";
	roomId: string;
	sessionId: string;
	inputId: string;
	occurrenceIds: readonly string[];
}
export interface WebRoomMessages {
	post(input: RoomMessageInput, signal?: AbortSignal): Promise<RoomMessageReceipt>;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid room response.");
	return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Invalid room identity.");
	return value;
}

/** Member room contracts: 20260828022000/23000, with the admission lock
 * correction in 20260907000200. The cloud creates the input and room wakes
 * atomically; this adapter never dispatches an agent or manufactures a run. */
export function createWebRoomMessages(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId: string) => void,
): WebRoomMessages {
	uuid(profileId);
	uuid(memberId);
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid room configuration.");
	return {
		post: (input, signal) => {
			const request = { ...input };
			return withCloudDeadline(
				async (deadline): Promise<RoomMessageReceipt> => {
					const check = () => {
						deadline.throwIfAborted();
						current(request.sessionId);
					};
					check();
					if (
						Object.keys(request).some(
							(key) =>
								![
									"roomId",
									"sessionId",
									"environmentId",
									"clientInputId",
									"text",
									"images",
									"sponsorBindingId",
									"sponsorVersion",
								].includes(key),
						)
					)
						throw new Error("Room messages support text and images only.");
					const images = request.images ?? [];
					if (
						images.length > 5 ||
						images.some(
							(image) =>
								!/^[0-9a-f]{64}$/.test(image.objectSha256) ||
								!Number.isSafeInteger(image.bytes) ||
								image.bytes < 1 ||
								image.bytes > 8 * 1024 * 1024 ||
								!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mediaType),
						)
					)
						throw new Error("Room message images are invalid.");
					for (const value of [
						request.roomId,
						request.sessionId,
						request.environmentId,
						request.clientInputId,
						request.sponsorBindingId,
					])
						uuid(value);
					if (
						typeof request.text !== "string" ||
						!request.text.trim() ||
						request.text.includes("\0") ||
						new TextEncoder().encode(request.text).length > 65536 ||
						!Number.isSafeInteger(request.sponsorVersion) ||
						request.sponsorVersion < 1
					)
						throw new Error("Room message is invalid.");
					const rpc = async (
						method: "qorpera_list_company_rooms" | "qorpera_post_company_room_message",
						args: Record<string, unknown>,
					): Promise<unknown> => {
						const body = JSON.stringify(args);
						check();
						const { data, error } = await cloud.supabase.auth.getSession();
						check();
						if (
							error ||
							!data.session ||
							data.session.user.id !== memberId ||
							!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
						)
							throw new Error("Room member account changed.");
						const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
							method: "POST",
							headers: {
								authorization: `Bearer ${data.session.access_token}`,
								apikey: cloud.config.publishableKey,
								"content-type": "application/json",
							},
							body,
							signal: deadline,
							redirect: "error",
							cache: "no-store",
							credentials: "omit",
						});
						try {
							check();
							if (response.status === 401 || response.status === 403)
								throw new CloudRpcError(
									method,
									{ message: "You do not have permission to post in this room.", code: "42501" },
									response.status,
								);
							if (response.status !== 200) throw new Error("Room response is unavailable.");
							const value: unknown = JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 1024 * 1024, deadline),
								),
							);
							check();
							return value;
						} finally {
							if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
						}
					};
					const rooms = await rpc("qorpera_list_company_rooms", { p_profile_id: profileId });
					check();
					if (!Array.isArray(rooms)) throw new Error("Invalid room discovery.");
					const matches = rooms
						.map((value: unknown) => record(value))
						.filter((room) => room.roomId === request.roomId);
					if (matches.length !== 1) throw new Error("Room is unavailable.");
					const room = matches[0]!;
					if (
						room.status !== "active" ||
						room.sessionId !== request.sessionId ||
						room.environmentId !== request.environmentId ||
						!Array.isArray(room.members)
					)
						throw new Error("Room scope changed.");
					const members = room.members.map((value: unknown) => {
						const member = record(value);
						if (member.kind !== "member" && member.kind !== "staff_agent")
							throw new Error("Invalid room member.");
						return { kind: member.kind, id: uuid(member.id) };
					});
					if (members.filter((member) => member.kind === "member" && member.id === memberId).length !== 1)
						throw new Error("Room membership changed.");
					check();
					const value = record(
						await rpc("qorpera_post_company_room_message", {
							p_room_id: request.roomId,
							p_client_input_id: request.clientInputId,
							p_body: {
								schema: "qorpera.session-prompt/v1",
								text: request.text,
								images: images.map((image) => ({ ...image })),
							},
							p_sponsor_binding_id: request.sponsorBindingId,
							p_sponsor_version: request.sponsorVersion,
						}),
					);
					if (
						value.schema !== "qorpera.company-room-post/v1" ||
						value.roomId !== request.roomId ||
						value.sessionId !== request.sessionId ||
						!Array.isArray(value.occurrenceIds) ||
						Object.keys(value).some(
							(key) => !["schema", "roomId", "sessionId", "inputId", "occurrenceIds"].includes(key),
						)
					)
						throw new Error("Room receipt does not match the request.");
					const inputId = uuid(value.inputId),
						occurrenceIds = value.occurrenceIds.map((id: unknown) => uuid(id));
					if (new Set(occurrenceIds).size !== occurrenceIds.length) throw new Error("Invalid room occurrences.");
					check();
					return {
						schema: "qorpera.company-room-post/v1",
						roomId: request.roomId,
						sessionId: request.sessionId,
						inputId,
						occurrenceIds,
					};
				},
				15000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			)
				.then((result) => {
					companySignal.throwIfAborted();
					signal?.throwIfAborted();
					current(request.sessionId);
					return result;
				})
				.catch((error: unknown) => {
					if (error instanceof CloudRpcError && error.denied) throw error;
					throw new Error("Room message could not be confirmed. Refresh the conversation before trying again.");
				});
		},
	};
}
