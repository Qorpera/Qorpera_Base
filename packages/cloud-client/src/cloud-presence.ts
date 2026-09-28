import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { HostedPresenceIdentity, HostedPrimaryDatabase, QorperaHostedPrimary } from "./hosted-primary.ts";
import { PresenceSignatures } from "./presence-signatures.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A tab's identity is looked up again after this long: a member who left the company
 * stops resolving within it, and routine syncs (every agent's file presence re-tracks
 * every 10 s on this topic) cost no lookup. */
const IDENTITY_TTL_MS = 60_000;
/** A sync whose identity lookup failed is tried again after this long, doubling up to the cap. */
const SYNC_RETRY_MS = 3_000;
const SYNC_RETRY_MAX_MS = 30_000;

function broadcastBytes(
	profileId: string,
	clientId: string,
	sequence: number,
	event: "typing" | "agent_activity" | "open_thread",
	staffAgentId: string,
	activity?: PresenceAgentActivityEvent["activity"],
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify([profileId, clientId, sequence, event, staffAgentId, activity ?? null]),
	);
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

/** The device registry calls presence needs; a client that does not carry the whole
 * hosted primary (the web app) supplies just these. */
export type PresenceDevices = Pick<
	QorperaHostedPrimary,
	"registerPresenceDevice" | "listPresenceDevices" | "unregisterPresenceDevice"
>;

export class SupabaseCloudPresenceTransport {
	readonly #client: Pick<SupabaseClient<HostedPrimaryDatabase>, "channel" | "removeChannel">;
	readonly #primary: PresenceDevices;

	constructor(
		client: Pick<SupabaseClient<HostedPrimaryDatabase>, "channel" | "removeChannel">,
		primary: PresenceDevices,
	) {
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
		if (!UUID_PATTERN.test(profileId)) throw new Error("Invalid presence profile");
		// Private channel: Realtime authorizes the join against the presence
		// policies on realtime.messages (migration 20260819011000) with the
		// signed-in user's JWT, which supabase-js forwards automatically.
		let openThread: string | null = null;
		let subscribed = false;
		let stopped = false;
		let channel: RealtimeChannel | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let syncRetryTimer: ReturnType<typeof setTimeout> | undefined;
		let syncFailures = 0;
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		const identities = new Map<string, { identity: HostedPresenceIdentity; at: number }>();
		// Members are reported the first time, then only when who is where changed.
		let reported: string | undefined;
		const report = (members: PresenceMember[]): void => {
			const key = JSON.stringify(
				members
					.map((member) => [member.clientId, member.userId, member.name, member.staffAgentId])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			);
			if (key === reported) return;
			reported = key;
			onMembers(members);
		};
		let reconnectAttempts = 0;
		const clientId = crypto.randomUUID();
		const signatures = new PresenceSignatures();
		const publicKey = signatures.publicKey();
		let registration: Promise<HostedPresenceIdentity> | undefined;
		let outbound = Promise.resolve();
		let broadcastSequence = 0;
		let presenceGeneration = 0;
		const lastBroadcastSequence = new Map<string, number>();
		const lastPresenceSequence = new Map<string, number>();
		// Async browser signing must preserve sequence order, including track/send.
		// Work queued by a disconnected channel can never publish on its replacement.
		const publish = (
			event: "open_thread" | "typing" | "agent_activity",
			staffAgentId: string,
			activity?: PresenceAgentActivityEvent["activity"],
		): void => {
			if (stopped || !subscribed || !channel) return;
			const target = channel;
			const sequence = ++broadcastSequence;
			outbound = outbound
				.then(async () => {
					if (stopped || target !== channel || !subscribed) return;
					const signature = await signatures.sign(
						broadcastBytes(profileId, clientId, sequence, event, staffAgentId, activity),
					);
					if (stopped || target !== channel || !subscribed) return;
					if (event === "open_thread")
						await target.track({ staff_agent_id: staffAgentId || null, sequence, signature });
					else
						await target.send({
							type: "broadcast",
							event,
							payload: {
								client_id: clientId,
								sequence,
								staff_agent_id: staffAgentId,
								signature,
								...(activity ? { activity } : {}),
							},
						});
				})
				.catch(() => undefined);
		};
		const track = () => {
			publish("open_thread", openThread ?? "");
		};
		const resolveIdentities = async (clientIds: string[]): Promise<Map<string, HostedPresenceIdentity>> => {
			const requested = [...new Set(clientIds)].filter((id) => UUID_PATTERN.test(id));
			const resolved = new Map<string, HostedPresenceIdentity>();
			const now = Date.now();
			for (const [id, known] of identities) if (now - known.at >= IDENTITY_TTL_MS) identities.delete(id);
			const unknown = requested.filter((id) => {
				const known = identities.get(id);
				if (known && now - known.at < IDENTITY_TTL_MS) resolved.set(id, known.identity);
				return !resolved.has(id);
			});
			if (unknown.length) {
				for (const identity of await this.#primary.listPresenceDevices(profileId, unknown)) {
					identities.set(identity.clientId, { identity, at: now });
					resolved.set(identity.clientId, identity);
				}
			}
			return resolved;
		};
		const broadcastMemberEvent = (
			source: RealtimeChannel,
			payload: unknown,
			event: "typing" | "agent_activity",
			accept: (data: Record<string, unknown>, identity: HostedPresenceIdentity) => void,
		): void => {
			const data =
				payload && typeof payload === "object" && !Array.isArray(payload)
					? { ...(payload as Record<string, unknown>) }
					: undefined;
			if (
				stopped ||
				source !== channel ||
				!data ||
				typeof data.client_id !== "string" ||
				!UUID_PATTERN.test(data.client_id) ||
				typeof data.staff_agent_id !== "string" ||
				data.staff_agent_id.length > 256 ||
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
				.then(async (resolved) => {
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
					if (
						!(await PresenceSignatures.verify(
							identity.publicKey,
							broadcastBytes(profileId, identity.clientId, sequence, event, staffAgentId, activity),
							signature,
						))
					)
						return;
					if (stopped || source !== channel || sequence <= (lastBroadcastSequence.get(identity.clientId) ?? 0))
						return;
					lastBroadcastSequence.set(identity.clientId, sequence);
					accept(data, identity);
				})
				.catch(() => undefined);
		};
		const scheduleReconnect = (failed: RealtimeChannel, detail: string): void => {
			if (stopped || failed !== channel || reconnectTimer) return;
			subscribed = false;
			report([]);
			onHealth?.({ phase: "degraded", error: detail });
			console.error(`presence channel degraded: ${detail}`);
			channel = undefined;
			void this.#client.removeChannel(failed).catch(() => undefined);
			const delay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5));
			reconnectAttempts++;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				connect();
			}, delay);
			if (typeof reconnectTimer === "object") reconnectTimer.unref?.();
		};
		const register = (): Promise<HostedPresenceIdentity> => {
			if (!registration) {
				registration = publicKey.then((key) => this.#primary.registerPresenceDevice(profileId, clientId, key));
				void registration
					.finally(() => {
						registration = undefined;
					})
					.catch(() => undefined);
			}
			return registration;
		};
		const connect = (): void => {
			if (stopped) return;
			void register()
				.then(() => {
					if (stopped) return;
					const next = this.#client.channel(`qorpera-presence-${profileId}`, {
						config: { private: true, presence: { key: clientId }, broadcast: { self: false } },
					});
					channel = next;
					const syncMembers = (): void => {
						if (next !== channel) return;
						clearTimeout(syncRetryTimer);
						syncRetryTimer = undefined;
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
							.then(async (resolved) => {
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								const newest = new Map<string, PresenceMember & { sequence: number }>();
								for (const member of visible) {
									const identity = resolved.get(member.clientId);
									if (!identity || member.sequence < (lastPresenceSequence.get(member.clientId) ?? 0))
										continue;
									if (
										!(await PresenceSignatures.verify(
											identity.publicKey,
											broadcastBytes(
												profileId,
												member.clientId,
												member.sequence,
												"open_thread",
												member.staffAgentId ?? "",
											),
											member.signature,
										))
									)
										continue;
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
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								for (const member of newest.values()) {
									lastPresenceSequence.set(member.clientId, member.sequence);
								}
								syncFailures = 0;
								report([...newest.values()].map(({ sequence: _sequence, ...member }) => member));
							})
							.catch(() => {
								// The lookup failed: try this sync again unless a newer one came.
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								const delay = Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_MS * 2 ** syncFailures);
								syncFailures += 1;
								syncRetryTimer = setTimeout(() => {
									syncRetryTimer = undefined;
									if (generation === presenceGeneration) syncMembers();
								}, delay);
								if (typeof syncRetryTimer === "object") syncRetryTimer.unref?.();
							});
					};
					next.on("presence", { event: "sync" }, syncMembers);
					next.on("broadcast", { event: "typing" }, ({ payload }) => {
						broadcastMemberEvent(next, payload, "typing", (data, identity) => {
							onTyping({
								clientId: identity.clientId,
								userId: identity.userId,
								name: identity.name,
								staffAgentId: data.staff_agent_id as string,
							});
						});
					});
					next.on("broadcast", { event: "agent_activity" }, ({ payload }) => {
						broadcastMemberEvent(next, payload, "agent_activity", (data, identity) => {
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
					if (typeof reconnectTimer === "object") reconnectTimer.unref?.();
				});
		};
		connect();
		heartbeatTimer = setInterval(() => {
			if (stopped) return;
			void register().catch((error: unknown) => {
				if (channel)
					scheduleReconnect(channel, error instanceof Error ? error.message : "Presence heartbeat failed");
			});
		}, 60_000);
		if (typeof heartbeatTimer === "object") heartbeatTimer.unref?.();
		return {
			setOpenThread: (staffAgentId) => {
				openThread = staffAgentId;
				track();
			},
			sendTyping: (staffAgentId) => publish("typing", staffAgentId),
			sendActivity: (staffAgentId, activity) => publish("agent_activity", staffAgentId, activity),
			stop: async () => {
				stopped = true;
				subscribed = false;
				if (reconnectTimer) clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
				clearTimeout(syncRetryTimer);
				syncRetryTimer = undefined;
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				heartbeatTimer = undefined;
				const active = channel;
				channel = undefined;
				// Leave first: others stop seeing this tab at once, and the topic is free again.
				if (active) await this.#client.removeChannel(active);
				await registration?.catch(() => undefined);
				await this.#primary.unregisterPresenceDevice(profileId, clientId).catch(() => undefined);
				report([]);
				onHealth?.({ phase: "stopped" });
			},
		};
	}
}
