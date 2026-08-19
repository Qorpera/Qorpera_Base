import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { HostedPrimaryDatabase } from "./hosted-primary.ts";

/** Presence rides the lossy lane (SESSIONS.md): fire-and-forget pub/sub over
 * the profile's realtime channel, never stored, never durable. Two signals:
 * who has which staff thread open (tracked presence state, auto-cleared on
 * disconnect) and who is typing where (broadcast, expired by the receiver). */

export interface PresenceMember {
	userId: string;
	name: string;
	staffAgentId: string | null;
}

export interface PresenceTypingEvent {
	userId: string;
	name: string;
	staffAgentId: string;
}

export interface CloudPresenceHandle {
	/** Publish which staff thread this member has on screen (null = none). */
	setOpenThread(staffAgentId: string | null): void;
	/** Announce a keystroke burst in a staff thread. Callers throttle. */
	sendTyping(staffAgentId: string): void;
	stop(): Promise<void>;
}

export class SupabaseCloudPresenceTransport {
	readonly #client: SupabaseClient<HostedPrimaryDatabase>;

	constructor(client: SupabaseClient<HostedPrimaryDatabase>) {
		this.#client = client;
	}

	join(
		profileId: string,
		self: { userId: string; name: string },
		onMembers: (members: PresenceMember[]) => void,
		onTyping: (event: PresenceTypingEvent) => void,
	): CloudPresenceHandle {
		const channel: RealtimeChannel = this.#client.channel(`qorpera-presence-${profileId}`, {
			config: { presence: { key: self.userId }, broadcast: { self: false } },
		});
		let openThread: string | null = null;
		let subscribed = false;
		const track = () => {
			if (!subscribed) return;
			void channel.track({ name: self.name, staff_agent_id: openThread });
		};
		channel.on("presence", { event: "sync" }, () => {
			const state = channel.presenceState<{ name?: unknown; staff_agent_id?: unknown }>();
			const members: PresenceMember[] = [];
			for (const [userId, metas] of Object.entries(state)) {
				const meta = metas[metas.length - 1];
				if (!meta) continue;
				members.push({
					userId,
					name: typeof meta.name === "string" ? meta.name : "",
					staffAgentId: typeof meta.staff_agent_id === "string" ? meta.staff_agent_id : null,
				});
			}
			onMembers(members);
		});
		channel.on("broadcast", { event: "typing" }, ({ payload }) => {
			const data = payload as Record<string, unknown> | undefined;
			if (!data || typeof data.user_id !== "string" || typeof data.staff_agent_id !== "string") return;
			if (data.user_id === self.userId) return;
			onTyping({
				userId: data.user_id,
				name: typeof data.name === "string" ? data.name : "",
				staffAgentId: data.staff_agent_id,
			});
		});
		channel.subscribe((status) => {
			if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
				subscribed = true;
				track();
			}
		});
		return {
			setOpenThread: (staffAgentId) => {
				openThread = staffAgentId;
				track();
			},
			sendTyping: (staffAgentId) => {
				void channel.send({
					type: "broadcast",
					event: "typing",
					payload: { user_id: self.userId, name: self.name, staff_agent_id: staffAgentId },
				});
			},
			stop: async () => {
				await this.#client.removeChannel(channel);
			},
		};
	}
}
