import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PresenceDevices, SupabaseCloudPresenceTransport } from "../src/cloud-presence.ts";
import type { HostedPresenceIdentity } from "../src/hosted-primary.ts";
import { PresenceSignatures } from "../src/presence-signatures.ts";

const profileId = "10000000-0000-4000-8000-000000000001";
const remoteId = "10000000-0000-4000-8000-000000000002";
const keys = generateKeyPairSync("ed25519");
const identity: HostedPresenceIdentity = {
	clientId: remoteId,
	userId: "10000000-0000-4000-8000-000000000003",
	name: "Member",
	publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function signed(event: "typing" | "open_thread", sequence: number, staff = "legal-agent") {
	return {
		client_id: remoteId,
		staff_agent_id: staff,
		sequence,
		signature: sign(
			null,
			Buffer.from(JSON.stringify([profileId, remoteId, sequence, event, staff, null])),
			keys.privateKey,
		).toString("base64"),
	};
}
class Channel {
	readonly tracked: Array<Record<string, unknown>> = [];
	readonly sent: Array<Record<string, unknown>> = [];
	state: Record<string, Array<Record<string, unknown>>> = {};
	status: (value: "SUBSCRIBED" | "CLOSED") => void = () => {};
	readonly handlers = new Map<string, (value: { payload: unknown }) => void>();
	on(kind: string, filter: { event: string }, handler: (value: { payload: unknown }) => void) {
		this.handlers.set(`${kind}:${filter.event}`, handler);
		return this;
	}
	subscribe(handler: Channel["status"]) {
		this.status = handler;
		return this;
	}
	presenceState() {
		return this.state;
	}
	track(value: Record<string, unknown>) {
		this.tracked.push(value);
		return Promise.resolve("ok");
	}
	send(value: Record<string, unknown>) {
		this.sent.push(value);
		return Promise.resolve("ok");
	}
	broadcast(value: unknown) {
		this.handlers.get("broadcast:typing")?.({ payload: value });
	}
	sync() {
		this.handlers.get("presence:sync")?.({ payload: null });
	}
}
function fixture() {
	const channels: Channel[] = [];
	const channel = vi.fn(() => {
		const value = new Channel();
		channels.push(value);
		return value as unknown as RealtimeChannel;
	});
	const remove = vi.fn(async () => "ok");
	const register = vi.fn(
		async (_profile: string, clientId: string, publicKey: string): Promise<HostedPresenceIdentity> => ({
			...identity,
			clientId,
			publicKey,
		}),
	);
	const list = vi.fn(async (_profile: string, _ids: string[]) => [identity]);
	const unregister = vi.fn(async () => {});
	const members = vi.fn();
	const typing = vi.fn();
	const primary = {
		registerPresenceDevice: register,
		listPresenceDevices: list,
		unregisterPresenceDevice: unregister,
	} as unknown as PresenceDevices;
	const client = { channel, removeChannel: remove } as unknown as SupabaseClient;
	const join = () => new SupabaseCloudPresenceTransport(client, primary).join(profileId, members, typing, () => {});
	return { channels, channel, remove, register, list, unregister, members, typing, join };
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("shared browser presence", () => {
	it("retains the desktop Ed25519/SPKI wire format in both directions", async () => {
		const signer = new PresenceSignatures();
		const bytes = new TextEncoder().encode("company presence");
		const publicKey = await signer.publicKey();
		const signature = await signer.sign(bytes);
		expect(
			verify(
				null,
				bytes,
				createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" }),
				Buffer.from(signature, "base64"),
			),
		).toBe(true);
		const remoteSignature = sign(null, bytes, keys.privateKey).toString("base64");
		expect(await PresenceSignatures.verify(identity.publicKey, bytes, remoteSignature)).toBe(true);
		expect(
			await PresenceSignatures.verify(identity.publicKey, new TextEncoder().encode("changed"), remoteSignature),
		).toBe(false);
		expect(await PresenceSignatures.verify(publicKey, bytes, remoteSignature)).toBe(false);
		expect(await PresenceSignatures.verify("invalid", bytes, remoteSignature)).toBe(false);
		expect(await PresenceSignatures.verify(publicKey, bytes, "invalid")).toBe(false);
	});
	it("uses the private membership channel and preserves outbound order across async signing", async () => {
		const f = fixture();
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			handle.setOpenThread("legal-agent");
			handle.sendTyping("legal-agent");
			handle.sendActivity("legal-agent", "working");
			await vi.waitFor(() => expect(c.sent).toHaveLength(2));
			expect(f.channel).toHaveBeenCalledWith(`qorpera-presence-${profileId}`, {
				config: { private: true, presence: { key: expect.any(String) }, broadcast: { self: false } },
			});
			expect(c.tracked.map((v) => v.sequence)).toEqual([1, 2]);
			expect(c.sent.map((v) => (v.payload as { sequence: number }).sequence)).toEqual([3, 4]);
			expect(c.sent[1].payload).not.toHaveProperty("user_id");
		} finally {
			await handle.stop();
		}
	});
	it("unregisters after an in-flight identity registration and never opens a stopped channel", async () => {
		const f = fixture();
		const gate = deferred<HostedPresenceIdentity>();
		f.register.mockReturnValueOnce(gate.promise);
		const handle = f.join();
		await vi.waitFor(() => expect(f.register).toHaveBeenCalledOnce());
		const stopping = handle.stop();
		expect(f.unregister).not.toHaveBeenCalled();
		gate.resolve(identity);
		await stopping;
		expect(f.unregister).toHaveBeenCalledOnce();
		expect(f.channels).toHaveLength(0);
	});
	it("discards a delayed broadcast from a disconnected channel", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const gate = deferred<HostedPresenceIdentity[]>();
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const old = f.channels[0];
			old.status("SUBSCRIBED");
			f.list.mockReturnValueOnce(gate.promise);
			old.broadcast(signed("typing", 1));
			old.status("CLOSED");
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(f.channels).toHaveLength(2));
			f.channels[1].status("SUBSCRIBED");
			gate.resolve([identity]);
			await vi.advanceTimersByTimeAsync(1);
			expect(f.typing).not.toHaveBeenCalled();
			f.channels[1].broadcast(signed("typing", 2));
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledOnce());
		} finally {
			await handle.stop();
		}
	});
	it("rechecks broadcast sequence after asynchronous verification", async () => {
		const f = fixture();
		const handle = f.join();
		const older = deferred<boolean>();
		vi.spyOn(PresenceSignatures, "verify")
			.mockImplementationOnce(() => older.promise)
			.mockResolvedValue(true);
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.broadcast(signed("typing", 1, "older"));
			await vi.waitFor(() => expect(PresenceSignatures.verify).toHaveBeenCalledOnce());
			c.broadcast(signed("typing", 2, "newer"));
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledOnce());
			older.resolve(true);
			await older.promise;
			await Promise.resolve();
			expect(f.typing).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ staffAgentId: "newer" }));
		} finally {
			older.resolve(false);
			await handle.stop();
		}
	});
	it("does not publish work queued for an old channel after reconnection", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const handle = f.join();
		const gate = deferred<string>();
		const realSign = PresenceSignatures.prototype.sign;
		const signer = vi.spyOn(PresenceSignatures.prototype, "sign").mockImplementationOnce(() => gate.promise);
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const old = f.channels[0];
			old.status("SUBSCRIBED");
			await vi.waitFor(() => expect(signer).toHaveBeenCalledOnce());
			handle.setOpenThread("legal-agent");
			handle.sendTyping("legal-agent");
			old.status("CLOSED");
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(f.channels).toHaveLength(2));
			f.channels[1].status("SUBSCRIBED");
			signer.mockImplementation(realSign);
			gate.resolve("unused old signature");
			await vi.waitFor(() => expect(f.channels[1].tracked).toHaveLength(1));
			expect(old.tracked).toEqual([]);
			expect(old.sent).toEqual([]);
			expect(f.channels[1].sent).toEqual([]);
			expect(f.channels[1].tracked[0]).toMatchObject({ staff_agent_id: "legal-agent", sequence: 4 });
		} finally {
			gate.resolve("discarded");
			await handle.stop();
		}
	});
	it("copies event fields before identity lookup and signature verification", async () => {
		const f = fixture();
		const handle = f.join();
		const gate = deferred<HostedPresenceIdentity[]>();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			f.list.mockReturnValueOnce(gate.promise);
			const value = signed("typing", 1);
			c.broadcast(value);
			value.staff_agent_id = "forged";
			gate.resolve([identity]);
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledOnce());
			expect(f.typing).toHaveBeenCalledWith(expect.objectContaining({ staffAgentId: "legal-agent" }));
		} finally {
			gate.resolve([]);
			await handle.stop();
		}
	});
	it("looks a tab up once a minute and reports members only when they change", async () => {
		const f = fixture();
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = { [remoteId]: [signed("open_thread", 1)] };
			c.sync();
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledOnce());
			expect(f.members.mock.calls[0]?.[0]).toEqual([
				{ clientId: remoteId, userId: identity.userId, name: identity.name, staffAgentId: "legal-agent" },
			]);
			// Another sync with nothing new (an agent re-tracking its file presence): no lookup, no report.
			c.sync();
			c.sync();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(f.list).toHaveBeenCalledOnce();
			expect(f.members).toHaveBeenCalledOnce();
			c.state = { [remoteId]: [signed("open_thread", 2, "sales-agent")] };
			c.sync();
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledTimes(2));
			expect(f.list).toHaveBeenCalledOnce();
			const later = Date.now() + 61_000;
			vi.spyOn(Date, "now").mockReturnValue(later);
			c.sync();
			await vi.waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
			expect(f.members).toHaveBeenCalledTimes(2);
		} finally {
			await handle.stop();
		}
	});
	it("tries a failed lookup again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const f = fixture();
		f.list.mockRejectedValueOnce(new Error("busy"));
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = { [remoteId]: [signed("open_thread", 1)] };
			c.sync();
			await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
			expect(f.members).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(3_000);
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledOnce());
			expect(f.list).toHaveBeenCalledTimes(2);
		} finally {
			await handle.stop();
		}
	});
	it("cannot restore members after a newer empty sync while signature verification is pending", async () => {
		const f = fixture();
		const handle = f.join();
		const gate = deferred<boolean>();
		vi.spyOn(PresenceSignatures, "verify").mockReturnValueOnce(gate.promise);
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = { [remoteId]: [signed("open_thread", 1)] };
			c.sync();
			await vi.waitFor(() => expect(PresenceSignatures.verify).toHaveBeenCalledOnce());
			c.state = {};
			c.sync();
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledWith([]));
			gate.resolve(true);
			await gate.promise;
			await Promise.resolve();
			expect(f.members.mock.calls).toEqual([[[]]]);
		} finally {
			gate.resolve(false);
			await handle.stop();
		}
	});
	it("caches imported Ed25519 SPKI verification keys across repeated checks and skips caching invalid keys", async () => {
		const fresh = generateKeyPairSync("ed25519");
		const freshPublicKey = fresh.publicKey.export({ type: "spki", format: "der" }).toString("base64");
		const payload = new TextEncoder().encode("cached key check");
		const sig = sign(null, payload, fresh.privateKey).toString("base64");
		const importSpy = vi.spyOn(crypto.subtle, "importKey");
		for (let i = 0; i < 6; i++) {
			expect(await PresenceSignatures.verify(freshPublicKey, payload, sig)).toBe(true);
		}
		expect(importSpy).toHaveBeenCalledTimes(1);
		expect(await PresenceSignatures.verify("A".repeat(60), payload, sig)).toBe(false);
		expect(await PresenceSignatures.verify("A".repeat(60), payload, sig)).toBe(false);
		expect(importSpy).toHaveBeenCalledTimes(3);
	});
	it("coalesces concurrent identity lookups and verifies duplicate presence metas newest-first", async () => {
		const f = fixture();
		const gate = deferred<HostedPresenceIdentity[]>();
		f.list.mockReturnValueOnce(gate.promise);
		const verifySpy = vi.spyOn(PresenceSignatures, "verify");
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = { [remoteId]: [signed("open_thread", 1, "old-agent"), signed("open_thread", 2, "new-agent")] };
			c.sync();
			c.broadcast(signed("typing", 1, "new-agent"));
			await vi.waitFor(() => expect(f.list).toHaveBeenCalledOnce());
			gate.resolve([identity]);
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledOnce());
			expect(f.list).toHaveBeenCalledOnce();
			expect(f.members.mock.calls[0]?.[0]).toEqual([
				{ clientId: remoteId, userId: identity.userId, name: identity.name, staffAgentId: "new-agent" },
			]);
			expect(verifySpy).toHaveBeenCalledTimes(2);
		} finally {
			gate.resolve([]);
			await handle.stop();
		}
	});
	it("never evicts replay floors for active or recently seen clients even past MAX_TRACKED_CLIENTS", async () => {
		const f = fixture();
		const fakeSignature = `${"A".repeat(86)}==`;
		let now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(PresenceSignatures, "verify").mockResolvedValue(true);
		f.list.mockImplementation(async (_profile: string, ids: string[]) =>
			ids.map((clientId) => ({
				clientId,
				userId: identity.userId,
				name: "Member",
				publicKey: identity.publicKey,
			})),
		);
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = { [remoteId]: [signed("open_thread", 10, "legal-agent")] };
			c.broadcast({ client_id: remoteId, staff_agent_id: "legal-agent", sequence: 10, signature: fakeSignature });
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledTimes(1));

			for (let i = 1; i <= 4_120; i++) {
				const attackerId = `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
				c.broadcast({
					client_id: attackerId,
					staff_agent_id: "legal-agent",
					sequence: 1,
					signature: fakeSignature,
				});
			}
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledTimes(4_121));

			c.broadcast({ client_id: remoteId, staff_agent_id: "replayed-1", sequence: 5, signature: fakeSignature });
			c.broadcast({ client_id: remoteId, staff_agent_id: "sentinel-1", sequence: 11, signature: fakeSignature });
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledTimes(4_122));
			expect(f.typing.mock.calls.at(-1)?.[0]).toMatchObject({ clientId: remoteId, staffAgentId: "sentinel-1" });

			now += 7 * 60_000;
			const lateAttacker = "30000000-0000-4000-8000-000000000001";
			c.broadcast({ client_id: lateAttacker, staff_agent_id: "legal-agent", sequence: 1, signature: fakeSignature });
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledTimes(4_123));

			const listCallsBeforeReplay = f.list.mock.calls.length;
			c.broadcast({ client_id: remoteId, staff_agent_id: "replayed-2", sequence: 9, signature: fakeSignature });
			await vi.waitFor(() => expect(f.list.mock.calls.length).toBeGreaterThan(listCallsBeforeReplay));
			expect(f.list.mock.calls.at(-1)?.[1]).toEqual([remoteId]);
			c.broadcast({ client_id: remoteId, staff_agent_id: "sentinel-2", sequence: 12, signature: fakeSignature });
			await vi.waitFor(() => expect(f.typing).toHaveBeenCalledTimes(4_124));
			expect(f.typing.mock.calls.at(-1)?.[0]).toMatchObject({ clientId: remoteId, staffAgentId: "sentinel-2" });
			expect(f.typing.mock.calls.some((call) => String(call[0]?.staffAgentId).startsWith("replayed-"))).toBe(false);
		} finally {
			await handle.stop();
		}
	});
	it("resets hung outbound track and bounds hung removeChannel across reconnect", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const old = f.channels[0];
			// WHY: Simulate a dying WebSocket where track() and removeChannel() never settle.
			old.track = () => new Promise<string>(() => {}) as never;
			f.remove.mockImplementationOnce(() => new Promise<string>(() => {}));
			old.status("SUBSCRIBED");
			await vi.advanceTimersByTimeAsync(10);
			old.status("CLOSED");
			await vi.advanceTimersByTimeAsync(3_100);
			await vi.waitFor(() => expect(f.channels).toHaveLength(2));
			const fresh = f.channels[1];
			fresh.status("SUBSCRIBED");
			handle.setOpenThread("legal-agent");
			await vi.waitFor(() => expect(fresh.tracked.length).toBeGreaterThanOrEqual(2));
			expect(fresh.tracked.at(-1)).toMatchObject({ staff_agent_id: "legal-agent" });
		} finally {
			await handle.stop();
		}
	});
	it("negatively caches unregistered client IDs and chunks large identity lookups", async () => {
		const f = fixture();
		const unknownId = "90000000-0000-4000-8000-000000000001";
		const batchSizes: number[] = [];
		f.list.mockImplementation(async (_profile: string, ids: string[]) => {
			batchSizes.push(ids.length);
			return ids.includes(remoteId) ? [identity] : [];
		});
		const handle = f.join();
		try {
			await vi.waitFor(() => expect(f.channels).toHaveLength(1));
			const c = f.channels[0];
			c.status("SUBSCRIBED");
			c.state = {
				[remoteId]: [signed("open_thread", 1)],
				[unknownId]: [{ staff_agent_id: "x", sequence: 1, signature: "A".repeat(88) }],
			};
			c.sync();
			await vi.waitFor(() => expect(f.members).toHaveBeenCalledOnce());
			expect(f.list).toHaveBeenCalledTimes(1);
			c.sync();
			c.sync();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(f.list).toHaveBeenCalledTimes(1);

			const crowded: Record<string, Array<Record<string, unknown>>> = {};
			for (let i = 1; i <= 125; i++) {
				crowded[`40000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = [
					{ staff_agent_id: "x", sequence: 1, signature: "A".repeat(88) },
				];
			}
			c.state = crowded;
			c.sync();
			await vi.waitFor(() => expect(batchSizes).toEqual([2, 100, 25]));
		} finally {
			await handle.stop();
		}
	});
});
