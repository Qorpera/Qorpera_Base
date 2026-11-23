import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { withCloudDeadline } from "./cloud-request.ts";
import type { HostedPresenceIdentity } from "./hosted-primary.ts";
import { PresenceSignatures } from "./presence-signatures.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A tab's identity is looked up again after this long: a member who left the company
 * stops resolving within it, and routine syncs (every agent's file presence re-tracks
 * every 10 s on this topic) cost no lookup. */
const IDENTITY_TTL_MS = 60_000;
const NEGATIVE_IDENTITY_TTL_MS = 20_000;
const MAX_IDENTITY_LOOKUP_BATCH = 100;
const OUTBOUND_CALL_TIMEOUT_MS = 5_000;
const REMOVE_CHANNEL_TIMEOUT_MS = 2_000;
const MAX_PENDING_OUTBOUND = 64;
/** A sync whose identity lookup failed is tried again after this long, doubling up to the cap. */
const SYNC_RETRY_MS = 3_000;
const SYNC_RETRY_MAX_MS = 30_000;
const MAX_TRACKED_CLIENTS = 4_096;
const SEQUENCE_RETENTION_MS = 6 * 60_000;
const DEVICE_REFRESH_MS = 45_000;
const TEXT_ENCODER = new TextEncoder();

function jitteredDelay(ceilingMs: number): number {
	return Math.max(1, Math.round(ceilingMs * (0.75 + Math.random() * 0.25)));
}

function recordSequence(
	map: Map<string, { sequence: number; at: number }>,
	key: string,
	sequence: number,
	now: number,
	isProtected: (clientId: string) => boolean,
): void {
	map.delete(key);
	if (map.size >= MAX_TRACKED_CLIENTS) {
		for (const [existing, entry] of map) {
			if (now - entry.at < SEQUENCE_RETENTION_MS) break;
			if (isProtected(existing)) continue;
			map.delete(existing);
			if (map.size < MAX_TRACKED_CLIENTS) break;
		}
	}
	map.set(key, { sequence, at: now });
}

function broadcastBytes(
	profileId: string,
	clientId: string,
	sequence: number,
	event: "typing" | "agent_activity" | "open_thread",
	staffAgentId: string,
	activity?: PresenceAgentActivityEvent["activity"],
): Uint8Array<ArrayBuffer> {
	return TEXT_ENCODER.encode(JSON.stringify([profileId, clientId, sequence, event, staffAgentId, activity ?? null]));
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

export interface CloudPresenceOptions {
	present?: boolean;
}

export interface CloudPresenceHandle {
	/** Publish which staff thread this member has on screen (null = none). */
	setOpenThread(staffAgentId: string | null): void;
	setPresent?(present: boolean): void;
	/** Announce a keystroke burst in a staff thread. Callers throttle. */
	sendTyping(staffAgentId: string): void;
	/** Announce the attached agent's live phase. Durable history uses trail sync. */
	sendActivity(staffAgentId: string, activity: PresenceAgentActivityEvent["activity"]): void;
	stop(): Promise<void>;
}

/** The device registry calls presence needs; a client that does not carry the whole
 * hosted primary (the web app) supplies just these. */
export interface PresenceDevices {
	registerPresenceDevice(profileId: string, clientId: string, publicKey: string): Promise<HostedPresenceIdentity>;
	listPresenceDevices(profileId: string, clientIds: string[]): Promise<HostedPresenceIdentity[]>;
	unregisterPresenceDevice(profileId: string, clientId: string): Promise<void>;
}

type PresenceSupabaseClient = Pick<SupabaseClient, "channel" | "removeChannel"> & {
	readonly realtime?: Partial<Pick<SupabaseClient["realtime"], "setAuth">>;
};

export class SupabaseCloudPresenceTransport {
	readonly #client: PresenceSupabaseClient;
	readonly #primary: PresenceDevices;

	constructor(client: PresenceSupabaseClient, primary: PresenceDevices) {
		this.#client = client;
		this.#primary = primary;
	}

	join(
		profileId: string,
		onMembers: (members: PresenceMember[]) => void,
		onTyping: (event: PresenceTypingEvent) => void,
		onActivity: (event: PresenceAgentActivityEvent) => void,
		onHealth?: (health: PresenceHealth) => void,
		options?: CloudPresenceOptions,
	): CloudPresenceHandle {
		if (!UUID_PATTERN.test(profileId)) throw new Error("Invalid presence profile");
		// Private channel: Realtime authorizes the join against the presence
		// policies on realtime.messages (migration 20260819011000) with the
		// signed-in user's JWT, which supabase-js forwards automatically.
		let openThread: string | null = null;
		let present = options?.present ?? true;
		let subscribed = false;
		let stopped = false;
		let channel: RealtimeChannel | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let syncRetryTimer: ReturnType<typeof setTimeout> | undefined;
		let syncFailures = 0;
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		let registeredAt = 0;
		let registrationAttempted = false;
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
		const register = (): Promise<HostedPresenceIdentity> => {
			if (!registration) {
				registrationAttempted = true;
				registration = publicKey
					.then((key) => this.#primary.registerPresenceDevice(profileId, clientId, key))
					.then((identity) => {
						registeredAt = Date.now();
						return identity;
					});
				void registration
					.finally(() => {
						registration = undefined;
					})
					.catch(() => undefined);
			}
			return registration;
		};
		const ensureRegistered = (): Promise<HostedPresenceIdentity | undefined> => {
			if (stopped) return Promise.resolve(undefined);
			if (registeredAt > 0 && Date.now() - registeredAt < DEVICE_REFRESH_MS) return Promise.resolve(undefined);
			return register();
		};
		let outbound = Promise.resolve();
		let pendingOutbound = 0;
		let broadcastSequence = 0;
		let presenceGeneration = 0;
		const isSequenceProtected = (id: string): boolean => {
			if (identities.has(id)) return true;
			const state = channel?.presenceState();
			return state !== undefined && Object.hasOwn(state, id);
		};
		const lastBroadcastSequence = new Map<string, { sequence: number; at: number }>();
		const lastPresenceSequence = new Map<string, { sequence: number; at: number }>();
		// Async browser signing must preserve sequence order, including track/send.
		// Work queued by a disconnected channel can never publish on its replacement.
		const publish = (
			event: "open_thread" | "typing" | "agent_activity",
			staffAgentId: string,
			activity?: PresenceAgentActivityEvent["activity"],
		): void => {
			if (stopped || !subscribed || !channel) return;
			if (event === "open_thread" && !present) return;
			if (event !== "open_thread" && pendingOutbound >= MAX_PENDING_OUTBOUND) return;
			const target = channel;
			const sequence = ++broadcastSequence;
			pendingOutbound += 1;
			outbound = outbound
				.then(async () => {
					if (stopped || target !== channel || !subscribed) return;
					if (event === "open_thread" && !present) return;
					try {
						await ensureRegistered();
					} catch (error: unknown) {
						if (!stopped && target === channel && present)
							scheduleReconnect(
								target,
								error instanceof Error ? error.message : "Presence identity registration failed",
							);
						return;
					}
					if (stopped || target !== channel || !subscribed) return;
					if (event === "open_thread" && !present) return;
					const signature = await signatures.sign(
						broadcastBytes(profileId, clientId, sequence, event, staffAgentId, activity),
					);
					if (stopped || target !== channel || !subscribed) return;
					if (event === "open_thread" && !present) return;
					// WHY: Bound track/send calls so a dying WebSocket cannot stall outbound presence indefinitely.
					if (event === "open_thread")
						await withCloudDeadline(
							() => target.track({ staff_agent_id: staffAgentId || null, sequence, signature }),
							OUTBOUND_CALL_TIMEOUT_MS,
						);
					else
						await withCloudDeadline(
							() =>
								target.send({
									type: "broadcast",
									event,
									payload: {
										client_id: clientId,
										sequence,
										staff_agent_id: staffAgentId,
										signature,
										...(activity ? { activity } : {}),
									},
								}),
							OUTBOUND_CALL_TIMEOUT_MS,
						);
				})
				.catch(() => undefined)
				.finally(() => {
					if (target === channel && pendingOutbound > 0) pendingOutbound -= 1;
				});
		};
		const track = () => {
			if (!present) return;
			publish("open_thread", openThread ?? "");
		};
		const untrack = (): void => {
			if (stopped || !subscribed || !channel) return;
			const target = channel;
			outbound = outbound
				.then(async () => {
					if (stopped || target !== channel || !subscribed || present) return;
					if (typeof target.untrack !== "function") return;
					await withCloudDeadline(() => target.untrack(), OUTBOUND_CALL_TIMEOUT_MS);
				})
				.catch(() => undefined);
		};
		const unknownIdentities = new Map<string, number>();
		const identitiesInFlight = new Map<string, Promise<HostedPresenceIdentity | undefined>>();
		const resolveIdentities = async (clientIds: string[]): Promise<Map<string, HostedPresenceIdentity>> => {
			const requested = [...new Set(clientIds)].filter((id) => UUID_PATTERN.test(id));
			const resolved = new Map<string, HostedPresenceIdentity>();
			const now = Date.now();
			for (const [id, known] of identities) if (now - known.at >= IDENTITY_TTL_MS) identities.delete(id);
			for (const [id, missedAt] of unknownIdentities) {
				if (now - missedAt >= NEGATIVE_IDENTITY_TTL_MS) unknownIdentities.delete(id);
			}
			const waiting: Array<Promise<readonly [string, HostedPresenceIdentity | undefined]>> = [];
			const missing: string[] = [];
			for (const id of requested) {
				const known = identities.get(id);
				if (known && now - known.at < IDENTITY_TTL_MS) {
					resolved.set(id, known.identity);
					continue;
				}
				const missedAt = unknownIdentities.get(id);
				if (missedAt !== undefined && now - missedAt < NEGATIVE_IDENTITY_TTL_MS) {
					continue;
				}
				const pending = identitiesInFlight.get(id);
				if (pending) {
					waiting.push(pending.then((identity) => [id, identity] as const));
					continue;
				}
				missing.push(id);
			}
			if (missing.length > 0) {
				// WHY: Chunk large device lookups and negatively cache absent IDs so unregistered clients cannot cause RPC storms.
				for (let offset = 0; offset < missing.length; offset += MAX_IDENTITY_LOOKUP_BATCH) {
					const chunk = missing.slice(offset, offset + MAX_IDENTITY_LOOKUP_BATCH);
					const batch = this.#primary.listPresenceDevices(profileId, chunk).then((list) => {
						const byId = new Map<string, HostedPresenceIdentity>();
						const checkedAt = Date.now();
						for (const identity of list) {
							unknownIdentities.delete(identity.clientId);
							identities.set(identity.clientId, { identity, at: checkedAt });
							byId.set(identity.clientId, identity);
						}
						for (const id of chunk) {
							if (!byId.has(id)) {
								if (unknownIdentities.size >= MAX_TRACKED_CLIENTS) {
									const oldest = unknownIdentities.keys().next().value;
									if (oldest !== undefined) unknownIdentities.delete(oldest);
								}
								unknownIdentities.set(id, checkedAt);
							}
						}
						return byId;
					});
					for (const id of chunk) {
						const entry = batch.then((byId) => byId.get(id));
						identitiesInFlight.set(id, entry);
						void entry
							.finally(() => {
								if (identitiesInFlight.get(id) === entry) identitiesInFlight.delete(id);
							})
							.catch(() => undefined);
						waiting.push(entry.then((identity) => [id, identity] as const));
					}
				}
			}
			if (waiting.length > 0) {
				for (const [id, identity] of await Promise.all(waiting)) {
					if (identity) resolved.set(id, identity);
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
					if (sequence <= (lastBroadcastSequence.get(identity.clientId)?.sequence ?? 0)) return;
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
					if (
						stopped ||
						source !== channel ||
						sequence <= (lastBroadcastSequence.get(identity.clientId)?.sequence ?? 0)
					)
						return;
					recordSequence(lastBroadcastSequence, identity.clientId, sequence, Date.now(), isSequenceProtected);
					accept(data, identity);
				})
				.catch(() => undefined);
		};
		let removing: Promise<unknown> = Promise.resolve();
		const stopHeartbeat = (): void => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
		};
		const startHeartbeat = (): void => {
			if (stopped || !present || heartbeatTimer) return;
			heartbeatTimer = setInterval(() => {
				if (stopped || !present) return;
				void register().catch((error: unknown) => {
					if (channel && present)
						scheduleReconnect(channel, error instanceof Error ? error.message : "Presence heartbeat failed");
				});
			}, 60_000);
			if (typeof heartbeatTimer === "object") heartbeatTimer.unref?.();
		};
		const scheduleReconnect = (failed: RealtimeChannel, detail: string): void => {
			if (stopped || failed !== channel || reconnectTimer) return;
			subscribed = false;
			stopHeartbeat();
			report([]);
			onHealth?.({ phase: "degraded", error: detail });
			console.error(`presence channel degraded: ${detail}`);
			channel = undefined;
			// WHY: Reset outbound chain and bound removeChannel so a stalled old socket cannot deadlock publishing or reconnect.
			outbound = Promise.resolve();
			pendingOutbound = 0;
			removing = withCloudDeadline(() => this.#client.removeChannel(failed), REMOVE_CHANNEL_TIMEOUT_MS).catch(
				() => undefined,
			);
			const delay = jitteredDelay(Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5)));
			reconnectAttempts++;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				connect();
			}, delay);
			if (typeof reconnectTimer === "object") reconnectTimer.unref?.();
		};
		const connect = (): void => {
			if (stopped) return;
			void (present ? register() : Promise.resolve(undefined))
				.then(async () => {
					await removing;
					await this.#client.realtime?.setAuth?.().catch(() => undefined);
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
								const byClient = new Map<string, typeof visible>();
								for (const member of visible) {
									const identity = resolved.get(member.clientId);
									if (
										!identity ||
										member.sequence < (lastPresenceSequence.get(member.clientId)?.sequence ?? 0)
									)
										continue;
									const list = byClient.get(member.clientId);
									if (list) list.push(member);
									else byClient.set(member.clientId, [member]);
								}
								const verified = await Promise.all(
									[...byClient.entries()].map(async ([remoteClientId, candidates]) => {
										const identity = resolved.get(remoteClientId);
										if (!identity) return undefined;
										if (candidates.length > 1) candidates.sort((a, b) => b.sequence - a.sequence);
										for (const member of candidates) {
											if (
												await PresenceSignatures.verify(
													identity.publicKey,
													broadcastBytes(
														profileId,
														member.clientId,
														member.sequence,
														"open_thread",
														member.staffAgentId ?? "",
													),
													member.signature,
												)
											) {
												return {
													clientId: member.clientId,
													staffAgentId: member.staffAgentId,
													userId: identity.userId,
													name: identity.name,
													sequence: member.sequence,
												};
											}
										}
										return undefined;
									}),
								);
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								const members: PresenceMember[] = [];
								const recordedAt = Date.now();
								for (const member of verified) {
									if (!member) continue;
									recordSequence(
										lastPresenceSequence,
										member.clientId,
										member.sequence,
										recordedAt,
										isSequenceProtected,
									);
									const { sequence: _sequence, ...publicMember } = member;
									members.push(publicMember);
								}
								syncFailures = 0;
								report(members);
							})
							.catch(() => {
								// The lookup failed: try this sync again unless a newer one came.
								if (next !== channel || stopped || generation !== presenceGeneration) return;
								const delay = jitteredDelay(Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_MS * 2 ** syncFailures));
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
							if (present) {
								startHeartbeat();
								track();
							}
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
					if (stopped || reconnectTimer) return;
					onHealth?.({
						phase: "degraded",
						error: error instanceof Error ? error.message : "Presence identity registration failed",
					});
					const delay = jitteredDelay(Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempts, 5)));
					reconnectAttempts++;
					reconnectTimer = setTimeout(() => {
						reconnectTimer = undefined;
						connect();
					}, delay);
					if (typeof reconnectTimer === "object") reconnectTimer.unref?.();
				});
		};
		connect();
		startHeartbeat();
		return {
			setOpenThread: (staffAgentId) => {
				openThread = staffAgentId;
				track();
			},
			setPresent: (nextPresent) => {
				if (stopped || nextPresent === present) return;
				present = nextPresent;
				if (present) {
					startHeartbeat();
					track();
				} else {
					stopHeartbeat();
					untrack();
				}
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
				stopHeartbeat();
				const active = channel;
				channel = undefined;
				outbound = Promise.resolve();
				pendingOutbound = 0;
				identities.clear();
				unknownIdentities.clear();
				identitiesInFlight.clear();
				lastBroadcastSequence.clear();
				lastPresenceSequence.clear();
				// Leave first: others stop seeing this tab at once, and the topic is free again.
				if (active) {
					await withCloudDeadline(() => this.#client.removeChannel(active), REMOVE_CHANNEL_TIMEOUT_MS).catch(
						() => undefined,
					);
				}
				await registration?.catch(() => undefined);
				if (registrationAttempted)
					await this.#primary.unregisterPresenceDevice(profileId, clientId).catch(() => undefined);
				report([]);
				onHealth?.({ phase: "stopped" });
			},
		};
	}
}
