import { randomUUID } from "node:crypto";
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { HostedPresenceIdentity, HostedPrimaryDatabase, QorperaHostedPrimary } from "./hosted-primary.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Presence rides the lossy lane (SESSIONS.md): fire-and-forget pub/sub over
 * the profile's realtime channel, never stored, never durable. Two signals:
 * who has which staff thread open (tracked presence state, auto-cleared on
 * disconnect) and who is typing where (broadcast, expired by the receiver). */

export interface PresenceMember {
	clientId: string;
	userId: string;
	name: string;
	staffAgentId: string | null;
}

export interface PresenceTypingEvent {
	clientId: string;
	userId: string;
	name: string;
	staffAgentId: string;
}

export interface PresenceAgentActivityEvent {
	clientId: string;
	userId: string;
	name: string;
	staffAgentId: string;
	activity: "working" | "writing" | "idle";
}

export interface PresenceHealth {
	phase: "connected" | "degraded" | "stopped";
	error?: string;
}

export interface CloudPresenceHandle {
	/** Publish which staff thread this member has on screen (null = none). */
	setOpenThread(staffAgentId: string | null): void;
	/** Announce a keystroke burst in a staff thread. Callers throttle. */
	sendTyping(staffAgentId: string): void;
	/** Announce the attached agent's live phase. Durable history uses trail sync. */
	sendActivity(staffAgentId: string, activity: PresenceAgentActivityEvent["activity"]): void;
	stop(): Promise<void>;
}

export class SupabaseCloudPresenceTransport {
	readonly #client: SupabaseClient<HostedPrimaryDatabase>;
	readonly #primary: QorperaHostedPrimary;

	constructor(client: SupabaseClient<HostedPrimaryDatabase>, primary: QorperaHostedPrimary) {
		this.#client = client;
		this.#primary = primary;
	}

	join(
		profileId: string,
		onMembers: (members: PresenceMember[]) => void,
		onTyping: (event: PresenceTypingEvent) => void,
		onActivity: (event: PresenceAgentActivityEvent) => void,
		onHealth?: (health: PresenceHealth) => void,
	): CloudPresenceHandle {
		// Private channel: Realtime authorizes the join against the presence
		// policies on realtime.messages (migration 20260819011000) with the
		// signed-in user's JWT, which supabase-js forwards automatically.
		let openThread: string | null = null;
		let subscribed = false;
		let stopped = false;
		let channel: RealtimeChannel | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		let reconnectAttempts = 0;
		const clientId = randomUUID();
		const identities = new Map<string, HostedPresenceIdentity>();
		const track = () => {
			if (!subscribed || !channel) return;
			void channel.track({ staff_agent_id: openThread });
		};
		const resolveIdentities = async (clientIds: string[]): Promise<Map<string, HostedPresenceIdentity>> => {
			const requested = [...new Set(clientIds)].filter((id) => UUID_PATTERN.test(id));
			if (requested.length) {
				for (const id of requested) identities.delete(id);
				for (const identity of await this.#primary.listPresenceDevices(profileId, requested)) {
					identities.set(identity.clientId, identity);
				}
			}
			return identities;
		};
		const broadcastMemberEvent = (
			payload: unknown,
			accept: (data: Record<string, unknown>, identity: HostedPresenceIdentity) => void,
		): void => {
			const data = payload as Record<string, unknown> | undefined;
			if (!data || typeof data.client_id !== "string" || typeof data.staff_agent_id !== "string") return;
			if (data.client_id === clientId) return;
			void resolveIdentities([data.client_id])
				.then((resolved) => {
					const identity = resolved.get(data.client_id as string);
					if (identity && !stopped) accept(data, identity);
				})
				.catch(() => undefined);
		};
		const scheduleReconnect = (failed: RealtimeChannel, detail: string): void => {
			if (stopped || failed !== channel || reconnectTimer) return;
			subscribed = false;
			onMembers([]);
			onHealth?.({ phase: "degraded", error: detail });
			console.error(`presence channel degraded: ${detail}`);
			void this.#client.removeChannel(failed);
			channel = undefined;
			const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5));
			reconnectAttempts++;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				connect();
			}, delay);
			reconnectTimer.unref?.();
		};
		const connect = (): void => {
			if (stopped) return;
			void this.#primary
				.registerPresenceDevice(profileId, clientId)
				.then((self) => {
					if (stopped) return;
					identities.set(clientId, self);
					const next = this.#client.channel(`qorpera-presence-${profileId}`, {
						config: { private: true, presence: { key: clientId }, broadcast: { self: false } },
					});
					channel = next;
					next.on("presence", { event: "sync" }, () => {
						if (next !== channel) return;
						const state = next.presenceState<{ staff_agent_id?: unknown }>();
						const visible = Object.entries(state).flatMap(([remoteClientId, metas]) => {
							if (remoteClientId === clientId || !UUID_PATTERN.test(remoteClientId)) return [];
							const meta = metas.find(
								(candidate) =>
									typeof candidate.staff_agent_id === "string" || candidate.staff_agent_id === null,
							);
							return meta
								? [
										{
											clientId: remoteClientId,
											staffAgentId: typeof meta.staff_agent_id === "string" ? meta.staff_agent_id : null,
										},
									]
								: [];
						});
						void resolveIdentities(visible.map((member) => member.clientId))
							.then((resolved) => {
								if (next !== channel || stopped) return;
								onMembers(
									visible.flatMap((member) => {
										const identity = resolved.get(member.clientId);
										return identity ? [{ ...member, userId: identity.userId, name: identity.name }] : [];
									}),
								);
							})
							.catch(() => undefined);
					});
					next.on("broadcast", { event: "typing" }, ({ payload }) => {
						broadcastMemberEvent(payload, (data, identity) => {
							onTyping({
								clientId: identity.clientId,
								userId: identity.userId,
								name: identity.name,
								staffAgentId: data.staff_agent_id as string,
							});
						});
					});
					next.on("broadcast", { event: "agent_activity" }, ({ payload }) => {
						broadcastMemberEvent(payload, (data, identity) => {
							if (data.activity !== "working" && data.activity !== "writing" && data.activity !== "idle") return;
							onActivity({
								clientId: identity.clientId,
								userId: identity.userId,
								name: identity.name,
								staffAgentId: data.staff_agent_id as string,
								activity: data.activity,
							});
						});
					});
					next.subscribe((status, error) => {
						if (next !== channel || stopped) return;
						if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
							subscribed = true;
							reconnectAttempts = 0;
							onHealth?.({ phase: "connected" });
							track();
							return;
						}
						if (
							status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
							status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
							status === REALTIME_SUBSCRIBE_STATES.CLOSED
						) {
							scheduleReconnect(next, error?.message ?? `Realtime channel ${status.toLowerCase()}`);
						}
					});
				})
				.catch((error: unknown) => {
					if (stopped) return;
					onHealth?.({
						phase: "degraded",
						error: error instanceof Error ? error.message : "Presence identity registration failed",
					});
					const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5));
					reconnectAttempts++;
					reconnectTimer = setTimeout(() => {
						reconnectTimer = undefined;
						connect();
					}, delay);
					reconnectTimer.unref?.();
				});
		};
		connect();
		heartbeatTimer = setInterval(() => {
			if (stopped) return;
			void this.#primary.registerPresenceDevice(profileId, clientId).catch((error: unknown) => {
				if (channel)
					scheduleReconnect(channel, error instanceof Error ? error.message : "Presence heartbeat failed");
			});
		}, 60_000);
		heartbeatTimer.unref?.();
		return {
			setOpenThread: (staffAgentId) => {
				openThread = staffAgentId;
				track();
			},
			sendTyping: (staffAgentId) => {
				if (!subscribed || !channel) return;
				void channel.send({
					type: "broadcast",
					event: "typing",
					payload: { client_id: clientId, staff_agent_id: staffAgentId },
				});
			},
			sendActivity: (staffAgentId, activity) => {
				if (!subscribed || !channel) return;
				void channel.send({
					type: "broadcast",
					event: "agent_activity",
					payload: {
						client_id: clientId,
						staff_agent_id: staffAgentId,
						activity,
					},
				});
			},
			stop: async () => {
				stopped = true;
				subscribed = false;
				if (reconnectTimer) clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
				const active = channel;
				channel = undefined;
				await this.#primary.unregisterPresenceDevice(profileId, clientId).catch(() => undefined);
				if (active) await this.#client.removeChannel(active);
				onMembers([]);
				onHealth?.({ phase: "stopped" });
			},
		};
	}
}
