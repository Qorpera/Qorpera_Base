import { PresenceSignatures } from "@qorpera/cloud-client/presence-signatures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type FoundingLive,
	type FoundingPresenceHandle,
	type FoundingPresenceHealth,
	type FoundingPresenceTab,
	joinFoundingPresence,
} from "../src/cloud/founding-presence.ts";

/* The founding table's presence topic (20260930531000), end to end between tabs: each tab is a real transport; the
 * hub stands in for Realtime (presence state, broadcasts to the other tabs) and the cloud's device registry, which
 * resolves a device only for someone with a seat at the table. */

const table = "90000000-0000-4000-8000-000000000900";
const anna = "10000000-0000-4000-8000-00000000000a";
const bo = "10000000-0000-4000-8000-00000000000b";
const stranger = "10000000-0000-4000-8000-00000000000f";

type Handler = (message: { payload?: unknown }) => void;

class FakeChannel {
	readonly topic: string;
	readonly key: string;
	readonly options: Record<string, unknown>;
	readonly #hub: Hub;
	sync: (() => void) | undefined;
	live: Handler | undefined;
	constructor(hub: Hub, topic: string, options: Record<string, unknown>) {
		this.#hub = hub;
		this.topic = topic;
		this.options = options;
		this.key = String((options.config as { presence: { key: string } }).presence.key);
	}
	on(kind: string, filter: { event: string }, callback: (message: { payload?: unknown }) => void) {
		if (kind === "presence" && filter.event === "sync") this.sync = () => callback({});
		if (kind === "broadcast" && filter.event === "live") this.live = callback;
		return this;
	}
	subscribe(callback: (status: string) => void) {
		this.#hub.channels.add(this);
		queueMicrotask(() => callback(this.#hub.refuseJoin ? "CHANNEL_ERROR" : "SUBSCRIBED"));
		return this;
	}
	async track(payload: Record<string, unknown>) {
		this.#hub.presence.set(this.key, payload);
		this.#hub.syncAll();
		return "ok";
	}
	async send(message: { event: string; payload: unknown }) {
		this.#hub.sent.push(message);
		for (const other of this.#hub.channels) if (other !== this) other.live?.({ payload: message.payload });
		return "ok";
	}
	presenceState() {
		return Object.fromEntries([...this.#hub.presence].map(([key, meta]) => [key, [{ presence_ref: "r", ...meta }]]));
	}
}

class Hub {
	readonly channels = new Set<FakeChannel>();
	readonly presence = new Map<string, Record<string, unknown>>();
	readonly devices = new Map<string, { userId: string; publicKey: string }>();
	readonly seats = new Set([anna, bo]);
	readonly sent: { event: string; payload: unknown }[] = [];
	readonly calls: { name: string; args: Record<string, unknown> }[] = [];
	refuseJoin = false;
	/** A cloud without the calls answers every one as missing. */
	missing = false;
	syncAll() {
		for (const channel of this.channels) channel.sync?.();
	}
	cloud(userId: string): Cloud {
		const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
			this.calls.push({ name, args });
			if (this.missing) throw new CloudRpcError(name, { message: "missing", code: "PGRST202" }, 404);
			if (!this.seats.has(userId) && name !== "qorpera_unregister_founding_presence")
				throw new CloudRpcError(name, { message: "This founding table is unavailable", code: "42501" }, 403);
			if (name === "qorpera_register_founding_presence") {
				const client = String(args.p_client_id);
				const held = this.devices.get(client);
				if (held && held.userId !== userId)
					throw new CloudRpcError(name, { message: "in use", code: "23505" }, 409);
				this.devices.set(client, { userId, publicKey: String(args.p_public_key) });
				return { client_id: client, user_id: userId, public_key: args.p_public_key };
			}
			if (name === "qorpera_list_founding_presence")
				return (args.p_client_ids as string[]).flatMap((client) => {
					const device = this.devices.get(client);
					return device && this.seats.has(device.userId)
						? [{ client_id: client, user_id: device.userId, public_key: device.publicKey }]
						: [];
				});
			if (name === "qorpera_unregister_founding_presence") {
				if (this.devices.get(String(args.p_client_id))?.userId === userId)
					this.devices.delete(String(args.p_client_id));
				return null;
			}
			throw new Error(`Unexpected RPC ${name}`);
		});
		const supabase = {
			channel: vi.fn((topic: string, options: Record<string, unknown>) => new FakeChannel(this, topic, options)),
			removeChannel: vi.fn(async (channel: FakeChannel) => {
				this.channels.delete(channel);
				this.presence.delete(channel.key);
				this.syncAll();
				return "ok";
			}),
		};
		return {
			config: { projectUrl: "https://fixture.invalid", publishableKey: "k" },
			supabase,
			rpc,
		} as unknown as Cloud;
	}
}

interface Tab {
	handle: FoundingPresenceHandle;
	cloud: Cloud;
	tabs: FoundingPresenceTab[][];
	lives: FoundingLive[];
	health: FoundingPresenceHealth[];
}

const handles: FoundingPresenceHandle[] = [];

function open(hub: Hub, userId: string): Tab {
	const cloud = hub.cloud(userId);
	const tab: Omit<Tab, "handle"> = { cloud, tabs: [], lives: [], health: [] };
	const handle = joinFoundingPresence(cloud, table, {
		tabs: (tabs) => tab.tabs.push(tabs),
		live: (live) => tab.lives.push(live),
		health: (health) => tab.health.push(health),
	});
	handles.push(handle);
	return { ...tab, handle };
}

/** Signing runs on Node's crypto, outside the fake clock: waits on the real one. */
const realTimeout = globalThis.setTimeout;

/** Lets signing, lookups and Realtime's microtasks finish. */
async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => realTimeout(resolve, 5));
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await new Promise((resolve) => realTimeout(resolve, 5));
		if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
	}
	throw new Error(`Still waiting for ${what}`);
}

const last = <T>(list: T[]) => list[list.length - 1];

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.stop()));
	vi.useRealTimers();
});

describe("a founding table's live presence", () => {
	it("registers each tab's device, joins the table's private topic and sees the others where they are", async () => {
		const hub = new Hub();
		const annaTab = open(hub, anna);
		const boTab = open(hub, bo);
		await settle();
		const channel = vi.mocked(annaTab.cloud.supabase.channel).mock.calls[0]!;
		expect(channel[0]).toBe(`qorpera-founding-${table}`);
		expect(channel[1]).toMatchObject({ config: { private: true, broadcast: { self: false } } });
		// The device is registered before the join, with the key its messages are signed with.
		expect(hub.calls[0]?.name).toBe("qorpera_register_founding_presence");
		expect(hub.devices.size).toBe(2);
		expect(last(annaTab.health)).toBe("connected");
		expect(last(annaTab.tabs)).toEqual([{ clientId: expect.any(String), userId: bo, visible: true, field: null }]);
		boTab.handle.setState(true, "vision");
		await settle();
		expect(last(annaTab.tabs)?.[0]).toMatchObject({ userId: bo, visible: true, field: "vision" });
		boTab.handle.setState(false, null);
		await settle();
		expect(last(annaTab.tabs)?.[0]).toMatchObject({ userId: bo, visible: false, field: null });
	});

	it("passes on a tab's signed words and caret, and drops forged, replayed and stranger messages", async () => {
		const hub = new Hub();
		const annaTab = open(hub, anna);
		const boTab = open(hub, bo);
		await settle();
		boTab.handle.sendLive("vision", "Specialty coffee, roasted in Aarhus.", 12, true, true);
		await settle();
		expect(annaTab.lives).toEqual([
			{
				clientId: expect.any(String),
				userId: bo,
				field: "vision",
				text: "Specialty coffee, roasted in Aarhus.",
				caret: 12,
				typing: true,
				own: true,
			},
		]);
		const real = hub.sent[0]!.payload as Record<string, unknown>;
		const deliver = (payload: Record<string, unknown>) => {
			for (const channel of hub.channels) channel.live?.({ payload });
		};
		// Bo's message again (a replay), and Bo's device with other words under his signature.
		deliver(real);
		deliver({ ...real, sequence: Number(real.sequence) + 1, text: "We sell crypto." });
		// Words signed by a key that is not Bo's device's.
		const other = new PresenceSignatures();
		const forged = { ...real, sequence: Number(real.sequence) + 2, text: "We sell crypto." };
		deliver({
			...forged,
			signature: await other.sign(
				new TextEncoder().encode(
					JSON.stringify([
						"qorpera.founding-presence/v1",
						table,
						real.client_id,
						forged.sequence,
						"live",
						"vision",
						"We sell crypto.",
						12,
						true,
						true,
					]),
				),
			),
		});
		// A caret past the words, a field nobody writes in, and words that say nothing of whose they are.
		deliver({ ...real, sequence: Number(real.sequence) + 3, caret: 400 });
		deliver({ ...real, sequence: Number(real.sequence) + 4, field: "billing" });
		deliver({ ...real, sequence: Number(real.sequence) + 5, own: undefined });
		await settle();
		expect(annaTab.lives).toHaveLength(1);
		// A device the cloud resolves for nobody at the table (its seat was given up) is not anyone here.
		hub.seats.delete(bo);
		const late = open(hub, anna);
		await settle();
		expect(last(late.tabs)?.some((tab) => tab.userId === bo)).not.toBe(true);
		hub.seats.add(stranger);
		const strangerTab = open(hub, stranger);
		hub.seats.delete(stranger);
		await settle();
		strangerTab.handle.sendLive("vision", "Hello", 5, true, true);
		await settle();
		expect(late.lives).toEqual([]);
	});

	it("keeps sending in order and cuts words to the box's limit", async () => {
		const hub = new Hub();
		const annaTab = open(hub, anna);
		const boTab = open(hub, bo);
		await settle();
		boTab.handle.sendLive("vision", "A", 1, true, true);
		boTab.handle.sendLive("vision", "AB", 2, true, true);
		boTab.handle.sendLive("role", "x".repeat(6000), 9000, false, false);
		await settle();
		expect(annaTab.lives.map((live) => [live.field, live.text.length, live.caret, live.own])).toEqual([
			["vision", 1, 1, true],
			["vision", 2, 2, true],
			["role", 5000, 5000, false],
		]);
	});

	it("says a cloud without table presence is unavailable, and does not try again", async () => {
		vi.useFakeTimers();
		const hub = new Hub();
		hub.missing = true;
		const annaTab = open(hub, anna);
		await until(() => annaTab.health.length === 2, "the refusal");
		expect(annaTab.health).toEqual(["connecting", "unavailable"]);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(hub.calls.filter((call) => call.name === "qorpera_register_founding_presence")).toHaveLength(1);
		expect(annaTab.cloud.supabase.channel).not.toHaveBeenCalled();
	});

	it("says a table you no longer sit at is unavailable", async () => {
		const hub = new Hub();
		hub.seats.delete(anna);
		const annaTab = open(hub, anna);
		await settle();
		expect(last(annaTab.health)).toBe("unavailable");
		expect(annaTab.cloud.supabase.channel).not.toHaveBeenCalled();
	});

	it("joins again after the channel fails, and leaves the topic and its device when stopped", async () => {
		vi.useFakeTimers();
		const hub = new Hub();
		hub.refuseJoin = true;
		const annaTab = open(hub, anna);
		await until(() => last(annaTab.health) === "degraded", "the failed join");
		hub.refuseJoin = false;
		await vi.advanceTimersByTimeAsync(1_100);
		await until(() => last(annaTab.health) === "connected", "the second join");
		expect(annaTab.cloud.supabase.channel).toHaveBeenCalledTimes(2);
		// Each minute the device is registered again, so the others keep resolving it.
		const registered = () => hub.calls.filter((call) => call.name === "qorpera_register_founding_presence").length;
		const before = registered();
		await vi.advanceTimersByTimeAsync(60_000);
		await until(() => registered() === before + 1, "the minute's registration");
		await annaTab.handle.stop();
		expect(hub.channels.size).toBe(0);
		expect(hub.devices.size).toBe(0);
		expect(last(annaTab.health)).toBe("stopped");
	});
});
