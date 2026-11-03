// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { Cloud } from "../src/cloud/client.ts";
import {
	RESUBSCRIBE_DELAYS_MS,
	RESUME_GRACE_MS,
	type RealtimePhase,
	subscribeProfileRealtime,
	subscribeSidebarRealtime,
} from "../src/cloud/realtime.ts";
import { deferred, fixture, profileA, userA } from "./fixtures.ts";

/* 3 Nov 2026: the rail showed "Live updates degraded" (channel error: transport failure) after
 * Realtime restarted and never subscribed again; only a new tab recovered. A failed channel is
 * now replaced after 1 s, 2 s, 5 s, 10 s, then every 30 s, with Realtime's token refreshed first;
 * a subscription resets the waits, and focus or coming back online tries at once. */

type Status = (status: string, error?: Error) => void;

interface FakeChannel {
	topic: string;
	state: string;
	status?: Status;
	on: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
}

function fakeCloud() {
	const channels: FakeChannel[] = [];
	const order: string[] = [];
	const setAuth = vi.fn(async () => {
		order.push("setAuth");
	});
	const removeChannel = vi.fn(async (channel: FakeChannel) => {
		order.push(`remove ${channels.indexOf(channel)}`);
		return "ok";
	});
	const socket = { connected: true };
	const connect = vi.fn(() => {
		order.push("connect");
	});
	const cloud = {
		supabase: {
			channel: vi.fn((topic: string) => {
				const channel: FakeChannel = {
					topic,
					state: "errored",
					on: vi.fn(() => channel),
					subscribe: vi.fn((status: Status) => {
						channel.status = status;
						order.push(`subscribe ${channels.indexOf(channel)}`);
						return channel;
					}),
				};
				channels.push(channel);
				return channel;
			}),
			removeChannel,
			realtime: { setAuth, connect, isConnected: () => socket.connected },
		},
	} as unknown as Cloud;
	return { cloud, channels, order, setAuth, removeChannel, socket, connect };
}

const transport = () => new Error("channel error: transport failure");

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a failed live-updates channel subscribes again by itself", () => {
	it("waits 1 s, 2 s, 5 s, 10 s, then 30 s, and starts over after a subscription", async () => {
		const { cloud, channels, setAuth } = fakeCloud();
		const health: [RealtimePhase, string | undefined][] = [];
		const subscription = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		expect(RESUBSCRIBE_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000, 30_000]);
		expect(channels).toHaveLength(1);
		channels[0]!.status!("SUBSCRIBED");
		channels[0]!.status!("CHANNEL_ERROR", transport());
		expect(health).toEqual([
			["connecting", undefined],
			["connected", undefined],
			["degraded", "channel error: transport failure"],
		]);
		const failures = ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED", "CHANNEL_ERROR", "CHANNEL_ERROR", "TIMED_OUT"];
		const waits = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
		for (const [index, wait] of waits.entries()) {
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(channels).toHaveLength(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(channels).toHaveLength(index + 2);
			expect(setAuth).toHaveBeenCalledTimes(index + 1);
			// Every channel has its own topic: the SDK reuses a channel by topic, even one being removed.
			expect(new Set(channels.map((channel) => channel.topic)).size).toBe(channels.length);
			if (index < waits.length - 1) channels.at(-1)!.status!(failures[index + 1]!);
		}
		expect(health.at(-1)?.[0]).toBe("degraded");
		channels.at(-1)!.status!("SUBSCRIBED");
		expect(health.at(-1)).toEqual(["connected", undefined]);
		// A new failure starts again at 1 s.
		const before = channels.length;
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(before + 1);
		subscription.stop();
	});

	it("refreshes Realtime's token before the new channel joins and removes the failed one after", async () => {
		const { cloud, channels, order, setAuth } = fakeCloud();
		const token = deferred<void>();
		setAuth.mockImplementationOnce(async () => {
			order.push("setAuth");
			await token.promise;
		});
		subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			() => {},
		);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(order).toEqual(["subscribe 0", "setAuth"]);
		expect(channels).toHaveLength(1);
		token.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["subscribe 0", "setAuth", "subscribe 1", "remove 0"]);
		expect(setAuth).toHaveBeenCalledWith();
	});

	it("ignores late answers from a channel it replaced", async () => {
		const { cloud, channels } = fakeCloud();
		const health: RealtimePhase[] = [];
		subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			(phase) => health.push(phase),
		);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		channels[1]!.status!("TIMED_OUT");
		// The removed channel closes and its old join answers late: neither counts.
		channels[0]!.status!("CLOSED");
		channels[0]!.status!("SUBSCRIBED");
		expect(health).toEqual(["connecting", "degraded", "degraded"]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(channels).toHaveLength(3);
	});

	it("tries at once when the window regains focus or the browser comes back online", async () => {
		const { cloud, channels } = fakeCloud();
		const subscription = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			() => {},
		);
		// Healthy or still joining: focus changes nothing.
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(1);
		channels[0]!.status!("SUBSCRIBED");
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(1);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(2);
		// The waiting retry was cancelled, and the new channel is still joining.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(2);
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(2);
		channels[1]!.status!("CHANNEL_ERROR", transport());
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(3);
		subscription.stop();
	});

	it("stops for good: no retry, no focus retry, and a retry under way opens nothing", async () => {
		const { cloud, channels, setAuth, removeChannel } = fakeCloud();
		const health: RealtimePhase[] = [];
		const first = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			(phase) => health.push(phase),
		);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		first.stop();
		expect(removeChannel).toHaveBeenCalledWith(channels[0]);
		expect(health.at(-1)).toBe("stopped");
		channels[0]!.status!("CLOSED");
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(channels).toHaveLength(1);
		expect(health.at(-1)).toBe("stopped");

		const token = deferred<void>();
		setAuth.mockImplementationOnce(() => token.promise);
		const second = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			() => {},
		);
		channels[1]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		second.stop();
		token.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(2);
		expect(removeChannel).toHaveBeenCalledWith(channels[1]);
	});

	it("reopens a socket that is down instead of queueing joins, and replaces the channel once it is up", async () => {
		const { cloud, channels, socket, connect, setAuth } = fakeCloud();
		subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			() => {},
		);
		socket.connected = false;
		channels[0]!.status!("CHANNEL_ERROR", transport());
		// Each wait while the socket is down only asks it to reconnect: no join or leave piles up.
		for (const wait of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(wait);
		expect(connect).toHaveBeenCalledTimes(6);
		expect(channels).toHaveLength(1);
		expect(setAuth).not.toHaveBeenCalled();
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(7);
		expect(channels).toHaveLength(1);
		// The SDK rejoins the failed channel once the socket opens: that ends the waits.
		socket.connected = true;
		channels[0]!.status!("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(channels).toHaveLength(1);
		// Up again but the channel stays failed: it is replaced at the next wait.
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(2);
		// A channel the server closed has no rejoin: replaced even while the socket is down.
		socket.connected = false;
		channels[1]!.state = "closed";
		channels[1]!.status!("CLOSED");
		// (the second failure since the last subscription: a 2 s wait)
		await vi.advanceTimersByTimeAsync(2_000);
		expect(channels).toHaveLength(3);
	});

	it("keeps the sidebar's channel subscribed the same way", async () => {
		const { cloud, channels } = fakeCloud();
		const changes = vi.fn();
		const subscription = subscribeSidebarRealtime(cloud, profileA.profileId, changes);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(2);
		expect(channels[1]!.on).toHaveBeenCalledWith(
			"postgres_changes",
			expect.objectContaining({ table: "qorpera_company_sidebar_revisions" }),
			changes,
		);
		subscription.stop();
	});
});

describe("the company's live badge recovers without a new tab", () => {
	it("says nothing about a channel that failed while the page was hidden if it is back within the grace", async () => {
		const { cloud, channels } = fakeCloud();
		const health: [RealtimePhase, string | undefined][] = [];
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const subscription = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		channels[0]!.status!("SUBSCRIBED");
		// 3 Nov 2026: Chrome froze the hidden tab, Realtime closed its socket, and on return the badge flashed
		// "channel error: transport failure" for the second the channel took to come back.
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(500);
		expect(channels).toHaveLength(1);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		// Back: it tries at once, and says nothing while the new channel joins.
		expect(channels).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 1);
		channels[1]!.status!("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
		expect(health.map(([phase]) => phase)).toEqual(["connecting", "connected", "connected"]);
		// Hidden for long, its retries failing too: still nothing, and once back the grace starts then.
		visibility = "hidden";
		channels[1]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(60_000);
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		expect(health).toHaveLength(3);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 1);
		expect(health).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(health.at(-1)).toEqual(["degraded", "channel error: transport failure"]);
		subscription.stop();
	});

	it("holds a failure that arrives just after the page came back for the grace, then says so if it lasts", async () => {
		const { cloud, channels } = fakeCloud();
		const health: [RealtimePhase, string | undefined][] = [];
		const subscription = subscribeProfileRealtime(
			cloud,
			profileA.profileId,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		channels[0]!.status!("SUBSCRIBED");
		// A frozen tab hears of its closed socket only once it runs again.
		document.dispatchEvent(new Event("resume"));
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		channels[1]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 1_001);
		expect(health.map(([phase]) => phase)).toEqual(["connecting", "connected"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(health).toEqual([
			["connecting", undefined],
			["connected", undefined],
			["degraded", "channel error: transport failure"],
		]);
		// Outside the grace a failure shows at once, as before.
		await vi.advanceTimersByTimeAsync(10_000);
		channels.at(-1)!.status!("SUBSCRIBED");
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		expect(health.at(-1)).toEqual(["degraded", "channel error: transport failure"]);
		subscription.stop();
	});

	it("goes from degraded back to connected after the automatic resubscription", async () => {
		const f = fixture();
		// The company's own hints channel; the sidebar (and anything else) opens channels of its own.
		const channels: { status?: Status }[] = [];
		vi.mocked(f.cloud.supabase.channel).mockImplementation((topic: string) => {
			const channel = {
				on: vi.fn(() => channel),
				subscribe: vi.fn((status: Status) => {
					channel.status = status;
					return channel;
				}),
				status: undefined as Status | undefined,
			};
			if (topic.startsWith(`qorpera-profile-${profileA.profileId}-`)) channels.push(channel);
			return channel as never;
		});
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		vi.mocked(f.api.listMemberMentions).mockResolvedValue([]);
		const controller = new CompanyController(f.api, profileA, userA.id);
		try {
			await controller.start();
			channels[0]!.status!("SUBSCRIBED");
			channels[0]!.status!("CHANNEL_ERROR", transport());
			expect(controller.store.get()).toMatchObject({
				realtime: "degraded",
				realtimeError: "channel error: transport failure",
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(channels).toHaveLength(2);
			channels[1]!.status!("SUBSCRIBED");
			expect(controller.store.get()).toMatchObject({ realtime: "connected", realtimeError: undefined });
		} finally {
			controller.stop();
		}
	});
});
