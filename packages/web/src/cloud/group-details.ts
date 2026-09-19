import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, uuid } from "./parse.ts";
import type { HostedSession } from "./types.ts";

export interface GroupChatDetails {
	roomId: string;
	sessionId: string;
	environmentId: string;
	version: number;
	name: string;
	purpose: string;
	status: "active" | "archived";
	members: { kind: "member" | "staff_agent"; id: string }[];
}

export type GroupChatDraft = Pick<GroupChatDetails, "name" | "purpose" | "members">;

export async function listGroupChatDetails(
	cloud: Cloud,
	profileId: string,
	signal: AbortSignal,
): Promise<GroupChatDetails[]> {
	const response = await withCloudDeadline(
		() => cloud.rpc("qorpera_list_company_rooms", { p_profile_id: profileId }),
		10_000,
		signal,
	);
	signal.throwIfAborted();
	// An archived room can be created before it ever owns a conversation. It
	// has no avatar to render; malformed non-null session identities still fail.
	const rooms = array(response, "group chats")
		.map((value) => record(value, "group chat"))
		.filter((room) => room.sessionId !== null)
		.map(parseGroupChatDetails);
	if (new Set(rooms.map((room) => room.roomId)).size !== rooms.length)
		throw new CloudShapeError("group chat identities");
	return rooms;
}

/** Membership comes from the room, never from its title or transcript authors. */
export async function readGroupChatDetails(
	cloud: Cloud,
	session: HostedSession,
	signal: AbortSignal,
): Promise<GroupChatDetails> {
	const roomId = uuid(session.executionScope?.roomId, "group chat id");
	const matches = (await listGroupChatDetails(cloud, session.profileId, signal)).filter(
		(room) => room.roomId === roomId,
	);
	const room = matches[0];
	if (
		matches.length !== 1 ||
		!room ||
		room.sessionId !== session.sessionId ||
		room.environmentId !== session.environmentId
	)
		throw new Error("This group chat is no longer available.");
	return room;
}

function parseGroupChatDetails(value: unknown): GroupChatDetails {
	const room = record(value, "group chat");
	if (typeof room.purpose !== "string") throw new CloudShapeError("group description");
	const members = array(room.members, "group participants").map((value) => {
		const member = record(value, "group participant");
		return {
			kind: oneOf(member.kind, ["member", "staff_agent"], "participant kind"),
			id: uuid(member.id, "participant id"),
		};
	});
	if (new Set(members.map((member) => `${member.kind}:${member.id}`)).size !== members.length)
		throw new CloudShapeError("group participants");
	return {
		roomId: uuid(room.roomId, "group chat id"),
		sessionId: uuid(room.sessionId, "group chat session id"),
		environmentId: uuid(room.environmentId, "group chat environment id"),
		version: boundedInteger(room.version, "group chat revision", 1, Number.MAX_SAFE_INTEGER),
		name: nonEmptyString(room.name, "group name"),
		purpose: room.purpose,
		status: oneOf(room.status, ["active", "archived"], "group status"),
		members,
	};
}
