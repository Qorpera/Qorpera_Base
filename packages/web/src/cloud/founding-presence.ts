import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import { REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import { type Cloud, CloudRpcError } from "./client.ts";
import { array, record, UUID_PATTERN, uuid } from "./parse.ts";

/* Who is at a founding table now, who is writing, and where (migration 20260930531000, topic
 * qorpera-founding-{profileId}). The lossy lane: nothing is stored, and the table's rules never read it. Each tab
 * registers a device id with a signing key at the table and signs everything it tracks and sends; the others look
 * the device up, so the person behind a tab comes from the table's seats, never from what the tab claims (as on the
 * company's presence topic, presence.ts). A cloud without the calls, or a table you no longer sit at, has no live
 * presence: the table reads itself every few seconds as before. */

export type FoundingField = "name" | "vision" | "role";

/** One tab at the table, as it last said. */
export interface FoundingPresenceTab {
	clientId: string;
	userId: string;
	/** The table is on its screen. */
	visible: boolean;
	/** The field it is writing in, if any. */
	field: FoundingField | null;
}

/** A tab's words in a field and where its caret stands. */
export interface FoundingLive {
	clientId: string;
	userId: string;
	field: FoundingField;
	text: string;
	/** The caret's place in the text (UTF-16 units), when the field has one. */
	caret: number | null;
	/** The words changed, not only the caret. */
	typing: boolean;
	/** The words are the tab's own edit, not the table's text or someone else's words it shows. */
	own: boolean;
}

/** `unavailable`: this cloud has no presence for tables, or you are no longer at this one; it is not tried again. */
export type FoundingPresenceHealth = "connecting" | "connected" | "degraded" | "unavailable" | "stopped";

export interface FoundingPresenceListener {
	tabs(tabs: FoundingPresenceTab[]): void;
	live(live: FoundingLive): void;
	health(health: FoundingPresenceHealth): void;
}

export interface FoundingPresenceHandle {
	/** Where this tab is: the table on screen or not, and the field it writes in. */
	setState(visible: boolean, field: FoundingField | null): void;
	/** This tab's words and caret in a field. Callers throttle. */
	sendLive(field: FoundingField, text: string, caret: number | null, typing: boolean, own: boolean): void;
	stop(): Promise<void>;
}

/** The longest text a tab sends or takes: the idea box's limit. */
export const FOUNDING_LIVE_MAX_UNITS = 5000;
/** A device is looked up again after this long, so a seat given up stops resolving within it. */
const IDENTITY_TTL_MS = 60_000;
/** A device the cloud did not know is asked about again after this long. */
const UNKNOWN_TTL_MS = 5_000;
/** A sync whose lookup failed is tried again after this long. */
const SYNC_RETRY_MS = 3_000;
/** Each tab registers again this often; the cloud resolves a device for two minutes after. */
const HEARTBEAT_MS = 60_000;
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const FIELDS: readonly FoundingField[] = ["name", "vision", "role"];
const SIGNATURE = /^[A-Za-z0-9+/]{40,240}={0,2}$/;

function field(value: unknown): FoundingField | null | undefined {
	if (value === null) return null;
	return FIELDS.find((item) => item === value);
}

function sequenceOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** What a tab signs: the table, the tab, its sequence, and what it says. */
function signedBytes(
	profileId: string,
	clientId: string,
	sequence: number,
	kind: "state" | "live",
	body: readonly unknown[],
): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(
		JSON.stringify(["qorpera.founding-presence/v1", profileId, clientId, sequence, kind, ...body]),
	);
}

interface Identity {
	clientId: string;
	userId: string;
	publicKey: string;
}

function identity(value: unknown): Identity {
	const input = record(value, "table presence device");
	if (typeof input.public_key !== "string" || !SIGNATURE.test(input.public_key))
		throw new Error("Invalid table presence key");
	return {
		clientId: uuid(input.client_id, "table presence device"),
		userId: uuid(input.user_id, "table presence person"),
		publicKey: input.public_key,
	};
}

/** Join the founding table's presence topic. `listener.tabs` gets every other tab that is in, `listener.live` each
 * verified word and caret update; the handle says where this tab is and what it writes. */
export function joinFoundingPresence(
	cloud: Cloud,
	profileId: string,
	listener: FoundingPresenceListener,
): FoundingPresenceHandle {
	const clientId = crypto.randomUUID();
	const signatures = new PresenceSignatures();
	let stopped = false;
	let channel: RealtimeChannel | undefined;
	let subscribed = false;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let failures = 0;
	let registration: Promise<void> | undefined;
	let state: { visible: boolean; field: FoundingField | null } = { visible: true, field: null };
	let sequence = 0;
	let outbound = Promise.resolve();
	let syncGeneration = 0;
	let syncTimer: ReturnType<typeof setTimeout> | undefined;
	const identities = new Map<string, { identity: Identity | undefined; at: number }>();
	const lookups = new Map<string, Promise<Identity | undefined>>();
	const lastState = new Map<string, number>();
	const lastLive = new Map<string, number>();
	let reported = "";

	const report = (tabs: FoundingPresenceTab[]): void => {
		const key = JSON.stringify(tabs.map((tab) => [tab.clientId, tab.userId, tab.visible, tab.field]).sort());
		if (key === reported) return;
		reported = key;
		listener.tabs(tabs);
	};

	/** The cloud says this table has no presence for this tab: stop for good. */
	const finalRefusal = (error: unknown): boolean =>
		error instanceof CloudRpcError && (error.missing || error.code === "42501");

	const end = (health: FoundingPresenceHealth): void => {
		stopped = true;
		subscribed = false;
		clearTimeout(retryTimer);
		clearTimeout(syncTimer);
		clearInterval(heartbeat);
		const active = channel;
		channel = undefined;
		if (active) void cloud.supabase.removeChannel(active).catch(() => undefined);
		report([]);
		listener.health(health);
	};

	const register = (): Promise<void> => {
		registration ??= signatures
			.publicKey()
			.then((publicKey) =>
				cloud.rpc("qorpera_register_founding_presence", {
					p_profile_id: profileId,
					p_client_id: clientId,
					p_public_key: publicKey,
				}),
			)
			.then(() => undefined)
			.finally(() => {
				registration = undefined;
			});
		return registration;
	};

	/** The devices behind these tab ids, from the cache or in one call for the rest. */
	const resolve = async (remotes: readonly string[]): Promise<Map<string, Identity>> => {
		const resolved = new Map<string, Identity>();
		const waits: Promise<void>[] = [];
		const unknown: string[] = [];
		const now = Date.now();
		for (const remote of new Set(remotes)) {
			const known = identities.get(remote);
			if (known && now - known.at < (known.identity ? IDENTITY_TTL_MS : UNKNOWN_TTL_MS)) {
				if (known.identity) resolved.set(remote, known.identity);
				continue;
			}
			const pending = lookups.get(remote);
			if (pending)
				waits.push(
					pending.then((who) => {
						if (who) resolved.set(remote, who);
					}),
				);
			else unknown.push(remote);
		}
		if (unknown.length > 0) {
			const batch = cloud
				.rpc("qorpera_list_founding_presence", { p_profile_id: profileId, p_client_ids: unknown })
				.then((value) => {
					const found = new Map(
						array(value, "table presence devices")
							.map(identity)
							.map((who) => [who.clientId, who] as const),
					);
					const at = Date.now();
					for (const remote of unknown) identities.set(remote, { identity: found.get(remote), at });
					return found;
				});
			for (const remote of unknown) {
				const one = batch.then((found) => found.get(remote));
				lookups.set(remote, one);
				void one.then(
					() => lookups.delete(remote),
					() => lookups.delete(remote),
				);
				waits.push(
					one.then((who) => {
						if (who) resolved.set(remote, who);
					}),
				);
			}
		}
		await Promise.all(waits);
		return resolved;
	};

	const publish = (kind: "state" | "live", body: readonly unknown[], payload: Record<string, unknown>): void => {
		if (stopped || !subscribed || !channel) return;
		const target = channel;
		const number = ++sequence;
		outbound = outbound
			.then(async () => {
				if (stopped || target !== channel) return;
				const signature = await signatures.sign(signedBytes(profileId, clientId, number, kind, body));
				if (stopped || target !== channel) return;
				if (kind === "state") await target.track({ ...payload, sequence: number, signature });
				else
					await target.send({
						type: "broadcast",
						event: "live",
						payload: { ...payload, client_id: clientId, sequence: number, signature },
					});
			})
			.catch(() => undefined);
	};

	const track = (): void => publish("state", [state.visible, state.field], { ...state });

	const sync = (source: RealtimeChannel): void => {
		if (source !== channel || stopped) return;
		clearTimeout(syncTimer);
		syncTimer = undefined;
		const generation = ++syncGeneration;
		const candidates = Object.entries(source.presenceState<Record<string, unknown>>()).flatMap(([key, metas]) => {
			const remote = key.toLowerCase();
			if (remote === clientId || !UUID_PATTERN.test(remote)) return [];
			return metas.flatMap((meta) => {
				const at = field(meta.field);
				const number = sequenceOf(meta.sequence);
				return typeof meta.visible === "boolean" &&
					at !== undefined &&
					number !== undefined &&
					typeof meta.signature === "string"
					? [{ remote, visible: meta.visible, field: at, number, signature: meta.signature }]
					: [];
			});
		});
		resolve(candidates.map((candidate) => candidate.remote))
			.then(async (who) => {
				const checked = await Promise.all(
					candidates.map(async (candidate) => {
						const person = who.get(candidate.remote);
						const bytes = signedBytes(profileId, candidate.remote, candidate.number, "state", [
							candidate.visible,
							candidate.field,
						]);
						return person && (await PresenceSignatures.verify(person.publicKey, bytes, candidate.signature))
							? { ...candidate, userId: person.userId }
							: undefined;
					}),
				);
				if (source !== channel || stopped || generation !== syncGeneration) return;
				const newest = new Map<string, NonNullable<(typeof checked)[number]>>();
				for (const tab of checked) {
					if (!tab || tab.number < (lastState.get(tab.remote) ?? 0)) continue;
					const prior = newest.get(tab.remote);
					if (!prior || prior.number < tab.number) newest.set(tab.remote, tab);
				}
				for (const tab of newest.values()) lastState.set(tab.remote, tab.number);
				report(
					[...newest.values()].map((tab) => ({
						clientId: tab.remote,
						userId: tab.userId,
						visible: tab.visible,
						field: tab.field,
					})),
				);
			})
			.catch(() => {
				// The lookup failed: try this sync again, unless a newer one came.
				if (source !== channel || stopped || generation !== syncGeneration) return;
				syncTimer = setTimeout(() => {
					syncTimer = undefined;
					if (generation === syncGeneration) sync(source);
				}, SYNC_RETRY_MS);
			});
	};

	const received = (source: RealtimeChannel, payload: unknown): void => {
		if (source !== channel || stopped || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
		const data = payload as Record<string, unknown>;
		const at = field(data.field);
		const number = sequenceOf(data.sequence);
		const remote = typeof data.client_id === "string" ? data.client_id.toLowerCase() : "";
		const text = typeof data.text === "string" && data.text.length <= FOUNDING_LIVE_MAX_UNITS ? data.text : undefined;
		const caret =
			data.caret === null
				? null
				: typeof data.caret === "number" && Number.isSafeInteger(data.caret) && data.caret >= 0
					? data.caret
					: undefined;
		const typing = data.typing;
		const own = data.own;
		const signature = data.signature;
		if (
			!at ||
			number === undefined ||
			remote === clientId ||
			!UUID_PATTERN.test(remote) ||
			text === undefined ||
			caret === undefined ||
			(caret !== null && caret > text.length) ||
			typeof typing !== "boolean" ||
			typeof own !== "boolean" ||
			typeof signature !== "string"
		)
			return;
		resolve([remote])
			.then(async (who) => {
				const person = who.get(remote);
				if (!person || number <= (lastLive.get(remote) ?? 0)) return;
				const bytes = signedBytes(profileId, remote, number, "live", [at, text, caret, typing, own]);
				if (!(await PresenceSignatures.verify(person.publicKey, bytes, signature))) return;
				if (source !== channel || stopped || number <= (lastLive.get(remote) ?? 0)) return;
				lastLive.set(remote, number);
				listener.live({ clientId: remote, userId: person.userId, field: at, text, caret, typing, own });
			})
			.catch(() => undefined);
	};

	const retry = (failed: RealtimeChannel | undefined): void => {
		if (stopped || retryTimer) return;
		subscribed = false;
		if (failed && failed === channel) {
			channel = undefined;
			void cloud.supabase.removeChannel(failed).catch(() => undefined);
		}
		report([]);
		listener.health("degraded");
		const delay = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** Math.min(failures, 5));
		failures++;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			connect();
		}, delay);
	};

	const connect = (): void => {
		if (stopped) return;
		listener.health("connecting");
		register()
			.then(() => {
				if (stopped) return;
				const next = cloud.supabase.channel(`qorpera-founding-${profileId}`, {
					config: { private: true, presence: { key: clientId }, broadcast: { self: false } },
				});
				channel = next;
				next.on("presence", { event: "sync" }, () => sync(next));
				next.on("broadcast", { event: "live" }, (message: { payload?: unknown }) =>
					received(next, message.payload),
				);
				next.subscribe((status) => {
					if (next !== channel || stopped) return;
					if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
						subscribed = true;
						failures = 0;
						listener.health("connected");
						track();
					} else if (
						status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
						status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
						status === REALTIME_SUBSCRIBE_STATES.CLOSED
					)
						retry(next);
				});
			})
			.catch((error: unknown) => {
				if (stopped) return;
				if (finalRefusal(error)) end("unavailable");
				else retry(undefined);
			});
	};

	connect();
	heartbeat = setInterval(() => {
		if (stopped || !channel) return;
		register().catch((error: unknown) => {
			if (stopped) return;
			if (finalRefusal(error)) end("unavailable");
			else retry(channel);
		});
	}, HEARTBEAT_MS);

	return {
		setState(visible, at) {
			if (state.visible === visible && state.field === at) return;
			state = { visible, field: at };
			track();
		},
		sendLive(at, text, caret, typing, own) {
			const words = text.slice(0, FOUNDING_LIVE_MAX_UNITS);
			const place = caret === null ? null : Math.max(0, Math.min(caret, words.length));
			publish("live", [at, words, place, typing, own], { field: at, text: words, caret: place, typing, own });
		},
		async stop() {
			if (stopped) return;
			const active = channel;
			channel = undefined;
			end("stopped");
			if (active) await cloud.supabase.removeChannel(active).catch(() => undefined);
			await registration?.catch(() => undefined);
			await cloud
				.rpc("qorpera_unregister_founding_presence", { p_profile_id: profileId, p_client_id: clientId })
				.catch(() => undefined);
		},
	};
}
