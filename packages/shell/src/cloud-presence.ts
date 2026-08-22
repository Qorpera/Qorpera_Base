import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { HostedPresenceIdentity, HostedPrimaryDatabase, QorperaHostedPrimary } from "./hosted-primary.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function broadcastBytes(
	profileId: string,
	clientId: string,
	sequence: number,
	event: "typing" | "agent_activity" | "open_thread",
	staffAgentId: string,
	activity?: PresenceAgentActivityEvent["activity"],
): Buffer {
	return Buffer.from(JSON.stringify([profileId, clientId, sequence, event, staffAgentId, activity ?? null]), "utf-8");
}

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
		const keyPair = generateKeyPairSync("ed25519");
		const publicKey = keyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
		let broadcastSequence = 0;
		let presenceGeneration = 0;
		const identities = new Map<string, HostedPresenceIdentity>();
		const lastBroadcastSequence = new Map<string, number>();
		const lastPresenceSequence = new Map<string, number>();
		const track = () => {
			if (!subscribed || !channel) return;
			const sequence = ++broadcastSequence;
			const signature = sign(
				null,
				broadcastBytes(profileId, clientId, sequence, "open_thread", openThread ?? ""),
				keyPair.privateKey,
			).toString("base64");
			void channel.track({ staff_agent_id: openThread, sequence, signature });
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
			event: "typing" | "agent_activity",
			accept: (data: Record<string, unknown>, identity: HostedPresenceIdentity) => void,
		): void => {
			const data = payload as Record<string, unknown> | undefined;
			if (
				!data ||
				typeof data.client_id !== "string" ||
				typeof data.staff_agent_id !== "string" ||
				typeof data.sequence !== "number" ||
				!Number.isSafeInteger(data.sequence) ||
				data.sequence < 1 ||
				typeof data.signature !== "string" ||
				!/^[A-Za-z0-9+/]{40,240}={0,2}$/.test(data.signature)
			)
				return;
			const remoteClientId = data.client_id;
			const staffAgentId = data.staff_agent_id;
			const signature = data.signature;
			if (remoteClientId === clientId) return;
			void resolveIdentities([remoteClientId])
				.then((resolved) => {
					const identity = resolved.get(remoteClientId);
					if (!identity || stopped) return;
					const sequence = data.sequence as number;
					if (sequence <= (lastBroadcastSequence.get(identity.clientId) ?? 0)) return;
					const activity =
						event === "agent_activity" &&
						(data.activity === "working" || data.activity === "writing" || data.activity === "idle")
							? data.activity
							: undefined;
					if (event === "agent_activity" && !activity) return;
					try {
						if (
							!verify(
								null,
								broadcastBytes(profileId, identity.clientId, sequence, event, staffAgentId, activity),
								createPublicKey({
									key: Buffer.from(identity.publicKey, "base64"),
									format: "der",
									type: "spki",
								}),
								Buffer.from(signature, "base64"),
							)
						)
							return;
					} catch {
						return;
					}
					lastBroadcastSequence.set(identity.clientId, sequence);
					accept(data, identity);
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
				.registerPresenceDevice(profileId, clientId, publicKey)
				.then((self) => {
					if (stopped) return;
					identities.set(clientId, self);
					const next = this.#client.channel(`qorpera-presence-${profileId}`, {
						config: { private: true, presence: { key: clientId }, broadcast: { self: false } },
					});
					channel = next;
					next.on("presence", { event: "sync" }, () => {
						if (next !== channel) return;
						const generation = ++presenceGeneration;
						const state = next.presenceState<{
							staff_agent_id?: unknown;
							sequence?: unknown;
							signature?: unknown;
						}>();
						const visible = Object.entries(state).flatMap(([remoteClientId, metas]) => {
							if (remoteClientId === clientId || !UUID_PATTERN.test(remoteClientId)) return [];
							return metas.flatMap((candidate) => {
								if (
									(typeof candidate.staff_agent_id === "string" || candidate.staff_agent_id === null) &&
									typeof candidate.sequence === "number" &&
									Number.isSafeInteger(candidate.sequence) &&
									candidate.sequence > 0 &&
									typeof candidate.signature === "string"
								) {
									return [
										{
											clientId: remoteClientId,
											staffAgentId:
												typeof candidate.staff_agent_id === "string" ? candidate.staff_agent_id : null,
											sequence: candidate.sequence as number,
											signature: candidate.signature as string,
										},
									];
								}
								return [];
							});
						});
						void resolveIdentities(visible.map((member) => member.clientId))
							.then((resolved) => {
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								const newest = new Map<string, PresenceMember & { sequence: number }>();
								for (const member of visible) {
									const identity = resolved.get(member.clientId);
									if (!identity || member.sequence < (lastPresenceSequence.get(member.clientId) ?? 0))
										continue;
									try {
										if (
											!verify(
												null,
												broadcastBytes(
													profileId,
													member.clientId,
													member.sequence,
													"open_thread",
													member.staffAgentId ?? "",
												),
												createPublicKey({
													key: Buffer.from(identity.publicKey, "base64"),
													format: "der",
													type: "spki",
												}),
												Buffer.from(member.signature, "base64"),
											)
										)
											continue;
									} catch {
										continue;
									}
									const prior = newest.get(member.clientId);
									if (prior && prior.sequence >= member.sequence) continue;
									newest.set(member.clientId, {
										clientId: member.clientId,
										staffAgentId: member.staffAgentId,
										userId: identity.userId,
										name: identity.name,
										sequence: member.sequence,
									});
								}
								for (const member of newest.values()) {
									lastPresenceSequence.set(member.clientId, member.sequence);
								}
								onMembers([...newest.values()].map(({ sequence: _sequence, ...member }) => member));
							})
							.catch(() => undefined);
					});
					next.on("broadcast", { event: "typing" }, ({ payload }) => {
						broadcastMemberEvent(payload, "typing", (data, identity) => {
							onTyping({
								clientId: identity.clientId,
								userId: identity.userId,
								name: identity.name,
								staffAgentId: data.staff_agent_id as string,
							});
						});
					});
					next.on("broadcast", { event: "agent_activity" }, ({ payload }) => {
						broadcastMemberEvent(payload, "agent_activity", (data, identity) => {
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
			void this.#primary.registerPresenceDevice(profileId, clientId, publicKey).catch((error: unknown) => {
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
				const sequence = ++broadcastSequence;
				const signature = sign(
					null,
					broadcastBytes(profileId, clientId, sequence, "typing", staffAgentId),
					keyPair.privateKey,
				).toString("base64");
				void channel.send({
					type: "broadcast",
					event: "typing",
					payload: { client_id: clientId, sequence, staff_agent_id: staffAgentId, signature },
				});
			},
			sendActivity: (staffAgentId, activity) => {
				if (!subscribed || !channel) return;
				const sequence = ++broadcastSequence;
				const signature = sign(
					null,
					broadcastBytes(profileId, clientId, sequence, "agent_activity", staffAgentId, activity),
					keyPair.privateKey,
				).toString("base64");
				void channel.send({
					type: "broadcast",
					event: "agent_activity",
					payload: {
						client_id: clientId,
						sequence,
						staff_agent_id: staffAgentId,
						activity,
						signature,
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
