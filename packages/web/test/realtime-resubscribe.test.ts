// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { Cloud } from "../src/cloud/client.ts";
import {
	liveHintTopic,
	RESUME_GRACE_MS,
	type RealtimePhase,
	type RealtimeResource,
	subscribeCompanyRealtime,
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
	let held: FakeChannel[] = [];
	const order: string[] = [];
	const setAuth = vi.fn(async () => {
		order.push("setAuth");
	});
	const removeChannel = vi.fn(async (channel: FakeChannel) => {
		order.push(`remove ${channels.indexOf(channel)}`);
		held = held.filter((each) => each !== channel);
		return "ok";
	});
	const socket = { connected: true };
	const connect = vi.fn(() => {
		order.push("connect");
	});
	const cloud = {
		supabase: {
			channel: vi.fn((topic: string) => {
				const existing = held.find((each) => each.topic === `realtime:${topic}`);
				if (existing) return existing;
				const channel: FakeChannel = {
					topic: `realtime:${topic}`,
					state: "errored",
					on: vi.fn(() => channel),
					subscribe: vi.fn((status: Status) => {
						channel.status = status;
						order.push(`subscribe ${channels.indexOf(channel)}`);
						return channel;
					}),
				};
				channels.push(channel);
				held.push(channel);
				return channel;
			}),
			getChannels: () => held,
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
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		await vi.advanceTimersByTimeAsync(0);
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
			expect(setAuth).toHaveBeenCalledTimes(index + 2);
			if (index < waits.length - 1) channels.at(-1)!.status!(failures[index + 1]!);
		}
		expect(health.at(-1)?.[0]).toBe("degraded");
		channels.at(-1)!.status!("SUBSCRIBED");
		expect(health.at(-1)).toEqual(["connected", undefined]);
		const before = channels.length;
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(before + 1);
		subscription.stop();
	});

	it("refreshes Realtime's token before the new channel joins after removing the failed one", async () => {
		const { cloud, channels, order, setAuth } = fakeCloud();
		subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		const token = deferred<void>();
		setAuth.mockImplementationOnce(async () => {
			order.push("setAuth");
			await token.promise;
		});
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(order).toEqual(["setAuth", "subscribe 0", "remove 0", "setAuth"]);
		expect(channels).toHaveLength(1);
		token.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["setAuth", "subscribe 0", "remove 0", "setAuth", "subscribe 1"]);
		expect(setAuth).toHaveBeenCalledWith();
	});

	it("ignores late answers from a channel it replaced", async () => {
		const { cloud, channels } = fakeCloud();
		const health: RealtimePhase[] = [];
		subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase) => health.push(phase),
		);
		await vi.advanceTimersByTimeAsync(0);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		channels[1]!.status!("TIMED_OUT");
		channels[0]!.status!("CLOSED");
		channels[0]!.status!("SUBSCRIBED");
		expect(health).toEqual(["connecting", "degraded", "degraded"]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(channels).toHaveLength(3);
	});

	it("tries at once when the window regains focus or the browser comes back online", async () => {
		const { cloud, channels } = fakeCloud();
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
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
		const first = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase) => health.push(phase),
		);
		await vi.advanceTimersByTimeAsync(0);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		first.stop();
		expect(removeChannel).toHaveBeenCalledWith(channels[0]);
		expect(health.at(-1)).toBe("stopped");
		channels[0]!.status!("CLOSED");
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(channels).toHaveLength(1);
		expect(health.at(-1)).toBe("stopped");

		const second = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		const token = deferred<void>();
		setAuth.mockImplementationOnce(() => token.promise);
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
		subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		socket.connected = false;
		channels[0]!.status!("CHANNEL_ERROR", transport());
		for (const wait of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(wait);
		expect(connect).toHaveBeenCalledTimes(6);
		expect(channels).toHaveLength(1);
		expect(setAuth).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new Event("online"));
		await vi.advanceTimersByTimeAsync(0);
		expect(connect).toHaveBeenCalledTimes(7);
		expect(channels).toHaveLength(1);
		socket.connected = true;
		channels[0]!.status!("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(channels).toHaveLength(1);
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channels).toHaveLength(2);
		socket.connected = false;
		channels[1]!.state = "closed";
		channels[1]!.status!("CLOSED");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(channels).toHaveLength(3);
	});
});

describe("the company's live badge recovers without a new tab", () => {
	it("says nothing about a channel that failed while the page was hidden if it is back within the grace", async () => {
		const { cloud, channels } = fakeCloud();
		const health: [RealtimePhase, string | undefined][] = [];
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		await vi.advanceTimersByTimeAsync(0);
		channels[0]!.status!("SUBSCRIBED");
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		channels[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(500);
		expect(channels).toHaveLength(1);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(channels).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 1);
		channels[1]!.status!("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
		expect(health.map(([phase]) => phase)).toEqual(["connecting", "connected", "connected"]);
		visibility = "hidden";
		channels[1]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(60_000);
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		expect(health).toHaveLength(3);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS - 1);
		visibility = "hidden";
		await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
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
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		await vi.advanceTimersByTimeAsync(0);
		channels[0]!.status!("SUBSCRIBED");
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
		await vi.advanceTimersByTimeAsync(10_000);
		channels.at(-1)!.status!("SUBSCRIBED");
		channels.at(-1)!.status!("CHANNEL_ERROR", transport());
		expect(health.at(-1)).toEqual(["degraded", "channel error: transport failure"]);
		subscription.stop();
	});

	it("reads again what a hidden tab's channel may have missed, though its failure never showed", async () => {
		const f = fixture();
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
			if (topic === liveHintTopic(profileA.profileId, userA.id)) channels.push(channel);
			return channel as never;
		});
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		vi.mocked(f.api.listMemberMentions).mockResolvedValue([]);
		let visibility: DocumentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		const controller = new CompanyController(f.api, profileA, userA.id);
		try {
			await controller.start();
			channels[0]!.status!("SUBSCRIBED");
			const activity = vi.mocked(f.api.listStaffActivity).mock.calls.length;
			visibility = "hidden";
			channels[0]!.status!("CHANNEL_ERROR", transport());
			await vi.advanceTimersByTimeAsync(500);
			visibility = "visible";
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(0);
			channels.at(-1)!.status!("SUBSCRIBED");
			await vi.advanceTimersByTimeAsync(0);
			expect(controller.store.get().realtime).toBe("connected");
			expect(vi.mocked(f.api.listStaffActivity).mock.calls.length).toBeGreaterThan(activity);
		} finally {
			controller.stop();
		}
	});

	it("goes from degraded back to connected after the automatic resubscription", async () => {
		const f = fixture();
		// The company's own hints channel (its push topic); anything else opens channels of its own.
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
			if (topic === liveHintTopic(profileA.profileId, userA.id)) channels.push(channel);
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

/* 8 Nov 2026 (perf T3): the company's hints come by push on the member's own private topic, at once after their commit
 * (5 ms on a test machine, against 246 ms by postgres_changes, which also keeps Realtime polling the database). A
 * database without the topic refuses the join; the hints then come by postgres_changes as before. */

/** A client that hands back the channel it holds for a topic, as Supabase's does, until that channel is removed. */
function pushCloud() {
	const made: (FakeChannel & {
		params?: unknown;
		bindings: [string, Record<string, string>, (message: unknown) => void][];
	})[] = [];
	const order: string[] = [];
	let held: typeof made = [];
	const setAuth = vi.fn(async () => {
		order.push("setAuth");
	});
	const removeChannel = vi.fn(async (channel: FakeChannel) => {
		order.push(`remove ${made.indexOf(channel as (typeof made)[number])}`);
		held = held.filter((each) => each !== channel);
		return "ok";
	});
	const cloud = {
		supabase: {
			channel: vi.fn((topic: string, params?: unknown) => {
				const existing = held.find((each) => each.topic === `realtime:${topic}`);
				if (existing) return existing;
				const channel: (typeof made)[number] = {
					topic: `realtime:${topic}`,
					state: "errored",
					params,
					bindings: [],
					on: vi.fn((kind: string, filter: Record<string, string>, callback: (message: unknown) => void) => {
						channel.bindings.push([kind, filter, callback]);
						return channel;
					}),
					subscribe: vi.fn((status: Status) => {
						channel.status = status;
						order.push(`subscribe ${made.indexOf(channel)}`);
						return channel;
					}),
				};
				made.push(channel);
				held.push(channel);
				return channel;
			}),
			getChannels: () => held,
			removeChannel,
			realtime: { setAuth, connect: vi.fn(), isConnected: () => true },
		},
	} as unknown as Cloud;
	return { cloud, made, order, removeChannel, setAuth };
}

const refusal = (topic: string) =>
	new Error(`Unauthorized: You do not have permissions to read from this Channel topic: ${topic}`);

describe("a company's hints by push", () => {
	const topic = liveHintTopic(profileA.profileId, userA.id);

	it("joins the member's own private topic once Realtime holds the token, and each event names what to read again", async () => {
		const { cloud, made, order, setAuth } = pushCloud();
		const token = deferred<void>();
		setAuth.mockImplementationOnce(async () => {
			order.push("setAuth");
			await token.promise;
		});
		const changes: RealtimeResource[] = [];
		const health: RealtimePhase[] = [];
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			(resource) => changes.push(resource),
			(phase) => health.push(phase),
		);
		// A join without the member's token would be refused, after Realtime's 5 s backoff.
		await vi.advanceTimersByTimeAsync(0);
		expect(made).toHaveLength(0);
		token.resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["setAuth", "subscribe 0"]);
		expect(topic).toBe(`qorpera-live-${profileA.profileId}-${userA.id}`);
		expect(made[0]!.topic).toBe(`realtime:${topic}`);
		expect(made[0]!.params).toEqual({ config: { private: true } });
		// Broadcasts only: nothing that keeps Realtime polling the database.
		expect(made[0]!.bindings.map(([kind, filter]) => [kind, filter.event])).toEqual([
			["broadcast", "sessions"],
			["broadcast", "staff"],
			["broadcast", "access"],
			["broadcast", "company-file"],
			["broadcast", "sidebar"],
			// Member chats (20260930715000): to the two members of the changed chat.
			["broadcast", "member-chats"],
			// A company's machines (20260930712000): to every member.
			["broadcast", "machines"],
			["broadcast", "surfaces"],
			["broadcast", "activity"],
		]);
		made[0]!.status!("SUBSCRIBED");
		expect(health).toEqual(["connecting", "connected"]);
		expect(subscription.live()).toBe(true);
		const fire = (event: string) => made[0]!.bindings.find(([, filter]) => filter.event === event)![2]({ event });
		for (const event of [
			"sessions",
			"staff",
			"access",
			"company-file",
			"member-chats",
			"machines",
			"surfaces",
			"activity",
		])
			fire(event);
		expect(changes).toEqual([
			"sessions",
			"staff",
			"access",
			"company-file",
			"member-chats",
			"machines",
			"surfaces",
			"activity",
		]);
		// The sidebar's hints count from when the sidebar was read, as its own channel did.
		fire("sidebar");
		expect(changes).toHaveLength(8);
		const sidebar = vi.fn();
		const following = subscription.followSidebar(sidebar);
		fire("sidebar");
		expect(sidebar).toHaveBeenCalledTimes(1);
		expect(changes).toHaveLength(8);
		expect(following.live()).toBe(true);
		// No channel of its own while the company's topic carries them.
		expect(made).toHaveLength(1);
		subscription.stop();
		expect(cloud.supabase.removeChannel).toHaveBeenCalledWith(made[0]);
	});

	it("retries once immediately on a refused join and then backs off on push without falling back to postgres_changes", async () => {
		const { cloud, made, order } = pushCloud();
		const health: RealtimePhase[] = [];
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase) => health.push(phase),
		);
		await vi.advanceTimersByTimeAsync(0);
		made[0]!.status!("CHANNEL_ERROR", refusal(topic));
		await vi.advanceTimersByTimeAsync(0);
		expect(order).toEqual(["setAuth", "subscribe 0", "remove 0", "setAuth", "subscribe 1"]);
		expect(made[1]!.topic).toBe(`realtime:${topic}`);
		expect(health).toEqual(["connecting"]);
		made[1]!.status!("CHANNEL_ERROR", refusal(topic));
		expect(health).toEqual(["connecting", "degraded"]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(made).toHaveLength(3);
		expect(made.every((each) => each.topic === `realtime:${topic}`)).toBe(true);
		expect(made.flatMap((each) => each.bindings).every(([kind]) => kind === "broadcast")).toBe(true);
		made[2]!.status!("SUBSCRIBED");
		expect(health).toEqual(["connecting", "degraded", "connected"]);
		subscription.stop();
	});

	it("stays on push after one refusal, and counts refusals again from each subscription", async () => {
		const { cloud, made } = pushCloud();
		subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		made[0]!.status!("CHANNEL_ERROR", refusal(topic));
		await vi.advanceTimersByTimeAsync(0);
		made[1]!.status!("SUBSCRIBED");
		made[1]!.status!("CLOSED");
		await vi.advanceTimersByTimeAsync(1_000);
		made[2]!.status!("CHANNEL_ERROR", refusal(topic));
		await vi.advanceTimersByTimeAsync(0);
		expect(made).toHaveLength(4);
		expect(made.every((each) => each.topic === `realtime:${topic}`)).toBe(true);
	});

	it("waits for a channel still leaving the same topic, as a company closed just before leaves one", async () => {
		const { cloud, made, order, removeChannel } = pushCloud();
		const first = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		// The first one's leave has not finished when the company opens again.
		const leave = deferred<string>();
		removeChannel.mockImplementationOnce(async () => {
			order.push("remove 0");
			return leave.promise;
		});
		first.stop();
		const second = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		// It removes the held channel again rather than take it back, then joins on a new one.
		expect(order).toEqual(["setAuth", "subscribe 0", "remove 0", "remove 0", "setAuth", "subscribe 1"]);
		expect(made).toHaveLength(2);
		expect(made[1]!.topic).toBe(`realtime:${topic}`);
		expect(made[1]!.subscribe).toHaveBeenCalledTimes(1);
		leave.resolve("ok");
		second.stop();
	});

	it("replaces a failed push channel only once the failed one is gone, and stays on push", async () => {
		const { cloud, made, order } = pushCloud();
		subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			() => {},
		);
		await vi.advanceTimersByTimeAsync(0);
		made[0]!.status!("SUBSCRIBED");
		made[0]!.status!("CHANNEL_ERROR", transport());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(order).toEqual(["setAuth", "subscribe 0", "remove 0", "setAuth", "subscribe 1"]);
		expect(made[1]!.topic).toBe(`realtime:${topic}`);
		// Closed by the server (a token refresh that no longer reads the topic): the next try joins the topic again,
		// and only a refused join moves it off push.
		made[1]!.status!("CLOSED");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(made).toHaveLength(3);
		expect(made[2]!.topic).toBe(`realtime:${topic}`);
	});

	it("does not report degraded or schedule retries when stopped while channel cleanup times out", async () => {
		const { cloud, channels, removeChannel } = fakeCloud();
		const health: [RealtimePhase, string | undefined][] = [];
		const subscription = subscribeCompanyRealtime(
			cloud,
			profileA.profileId,
			userA.id,
			() => {},
			(phase, error) => health.push([phase, error]),
		);
		await vi.advanceTimersByTimeAsync(0);
		channels[0]!.status!("SUBSCRIBED");
		channels[0]!.status!("CHANNEL_ERROR", transport());
		health.length = 0;

		removeChannel.mockImplementationOnce(() => new Promise(() => {}));
		await vi.advanceTimersByTimeAsync(1_000);
		subscription.stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(health).toEqual([["stopped", undefined]]);
		expect(channels).toHaveLength(1);
	});
});
