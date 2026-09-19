import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { array, CloudShapeError, nonEmptyString, oneOf, record, uuid } from "./parse.ts";
import type { HostedSession } from "./types.ts";

export interface GroupChatDetails {
	name: string;
	purpose: string;
	status: "active" | "archived";
	members: { kind: "member" | "staff_agent"; id: string }[];
}

/** Membership comes from the room, never from its title or transcript authors. */
export async function readGroupChatDetails(
	cloud: Cloud,
	session: HostedSession,
	signal: AbortSignal,
): Promise<GroupChatDetails> {
	const roomId = uuid(session.executionScope?.roomId, "group chat id");
	const response = await withCloudDeadline(
		() => cloud.rpc("qorpera_list_company_rooms", { p_profile_id: session.profileId }),
		10_000,
		signal,
	);
	signal.throwIfAborted();
	const matches = array(response, "group chats")
		.map((value) => record(value, "group chat"))
		.filter((room) => room.roomId === roomId);
	const room = matches[0];
	if (
		matches.length !== 1 ||
		!room ||
		room.sessionId !== session.sessionId ||
		room.environmentId !== session.environmentId
	)
		throw new Error("This group chat is no longer available.");
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
		name: nonEmptyString(room.name, "group name"),
		purpose: room.purpose,
		status: oneOf(room.status, ["active", "archived"], "group status"),
		members,
	};
}
