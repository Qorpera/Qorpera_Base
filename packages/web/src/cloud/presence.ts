import {
	type CloudPresenceHandle,
	type PresenceDevices,
	type PresenceHealth,
	type PresenceMember,
	SupabaseCloudPresenceTransport,
} from "@qorpera/cloud-client/cloud-presence";
import type { Cloud } from "./client.ts";
import { array, nonEmptyString, record, uuid } from "./parse.ts";

/* Who has which conversation open (CLIENT-CONTRACT.md §3, qorpera-presence-{profileId}).
 * The lossy lane: nothing is stored. Each browser tab registers a device key and
 * signs what it tracks; a member's name comes from the cloud's membership, never
 * from what a tab claims (migrations 20260819011000, 20260820001000). The web
 * tracks the open conversation's session id where the desktop tracked a staff
 * thread. */

export type { CloudPresenceHandle, PresenceHealth, PresenceMember };

function identity(value: unknown) {
	const input = record(value, "presence identity");
	return {
		clientId: uuid(input.client_id, "presence client"),
		userId: uuid(input.user_id, "presence member"),
		name: nonEmptyString(input.name, "presence name", 256),
		publicKey: nonEmptyString(input.public_key, "presence key", 256),
	};
}

function devices(cloud: Cloud): PresenceDevices {
	return {
		registerPresenceDevice: async (profileId, clientId, publicKey) =>
			identity(
				await cloud.rpc("qorpera_register_presence_device", {
					p_profile_id: profileId,
					p_client_id: clientId,
					p_public_key: publicKey,
				}),
			),
		listPresenceDevices: async (profileId, clientIds) =>
			array(
				await cloud.rpc("qorpera_list_presence_devices", {
					p_profile_id: profileId,
					p_client_ids: [...new Set(clientIds)].slice(0, 200),
				}),
				"presence identities",
			).map(identity),
		unregisterPresenceDevice: async (profileId, clientId) => {
			await cloud.rpc("qorpera_unregister_presence_device", { p_profile_id: profileId, p_client_id: clientId });
		},
	};
}

/** Join the company's presence channel: `onMembers` gets every other tab that is in, with the
 * conversation it has open. The handle's setOpenThread says which one this tab shows. */
export function joinCompanyPresence(
	cloud: Cloud,
	profileId: string,
	onMembers: (members: PresenceMember[]) => void,
	onHealth: (health: PresenceHealth) => void,
): CloudPresenceHandle {
	return new SupabaseCloudPresenceTransport(cloud.supabase, devices(cloud)).join(
		profileId,
		onMembers,
		() => {},
		() => {},
		onHealth,
	);
}
