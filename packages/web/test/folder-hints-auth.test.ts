// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyApps, sharedFolderHints } from "../src/app/interface-apps.ts";
import { WebCompanyFiles } from "../src/cloud/company-files.ts";
import { deferred, fixture, profileA, settle, userA } from "./fixtures.ts";

/* 3 Nov 2026: the Company File's hint channel (private) joined before Realtime had the member's token, went out with
 * the publishable key, was refused ("Unauthorized") and joined only on its 10 s retry. It now joins once the token
 * is set. */

const realtime = vi.hoisted(() => {
	const order: string[] = [];
	const joined = { status: (_status: string): void => {} };
	const broadcast = { callback: (_message: { payload?: unknown }): void => {} };
	const channel = {
		on: (_kind: string, _filter: unknown, callback: (message: { payload?: unknown }) => void) => {
			broadcast.callback = callback;
			return channel;
		},
		subscribe: (status?: (status: string) => void) => {
			order.push("subscribe");
			if (status) joined.status = status;
			return channel;
		},
	};
	return { order, channel, joined, broadcast };
});

const stops: AbortController[] = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop.abort();
	realtime.order.splice(0);
	vi.restoreAllMocks();
	vi.useRealTimers();
	Reflect.deleteProperty(document, "visibilityState");
});

function company() {
	const stop = new AbortController();
	stops.push(stop);
	const f = fixture();
	const supabase = f.cloud.supabase as unknown as {
		realtime: { setAuth: ReturnType<typeof vi.fn>; disconnect?: ReturnType<typeof vi.fn> };
		channel: ReturnType<typeof vi.fn>;
		removeChannel: ReturnType<typeof vi.fn>;
		removeAllChannels?: ReturnType<typeof vi.fn>;
	};
	supabase.realtime = {
		setAuth: vi.fn(async () => {
			realtime.order.push("setAuth");
		}),
	};
	supabase.channel = vi.fn((topic: string, options: unknown) => {
		realtime.order.push(`channel ${topic} ${JSON.stringify(options)}`);
		return realtime.channel;
	});
	supabase.removeChannel = vi.fn(async () => {
		realtime.order.push("remove");
		return "ok";
	});
	return {
		files: new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stop.signal, () => {}),
		supabase,
		stop,
	};
}

describe("the Company File's hint channel", () => {
	it("joins its private channel on cloud.supabase only once Realtime holds the member's token", async () => {
		const auth = deferred<void>();
		const { files, supabase } = company();
		supabase.realtime.setAuth.mockImplementation(() => {
			realtime.order.push("setAuth");
			return auth.promise;
		});
		const hints = files.folderHints(() => {});
		await settle();
		expect(supabase.realtime.setAuth).toHaveBeenCalledWith("fixture-token");
		expect(realtime.order).toEqual(["setAuth"]);
		auth.resolve();
		await settle();
		expect(realtime.order).toEqual([
			"setAuth",
			`channel qorpera-folder-${profileA.environmentId} {"config":{"private":true}}`,
			"subscribe",
		]);
		await hints.close();
		expect(realtime.order.at(-1)).toBe("remove");
	});

	it("still joins when the token can't be set, and never joins once closed", async () => {
		const firstCompany = company();
		firstCompany.supabase.realtime.setAuth.mockRejectedValueOnce(new Error("Sign in again"));
		const first = firstCompany.files.folderHints(() => {});
		await settle();
		expect(realtime.order.filter((step) => step === "subscribe")).toHaveLength(1);
		await first.close();
		realtime.order.splice(0);
		const auth = deferred<void>();
		const secondCompany = company();
		secondCompany.supabase.realtime.setAuth.mockReturnValueOnce(auth.promise);
		const second = secondCompany.files.folderHints(() => {});
		const closing = second.close();
		auth.resolve();
		await closing;
		await settle();
		expect(realtime.order).toEqual([]);
	});

	it("tells a hidden tab's apps poll whether the real channel is subscribed: it rests only while it is", async () => {
		vi.useFakeTimers();
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		const { files } = company();
		const reads = vi.fn((): never => {
			throw new Error("No folder in this test");
		});
		const apps = new CompanyApps(
			{ signal: files.signal, folder: reads, folderHints: sharedFolderHints(files) },
			() => {},
		);
		apps.open();
		await settle();
		expect(reads).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(2);
		realtime.joined.status("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(2);
		realtime.joined.status("CHANNEL_ERROR");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(3);
		apps.dispose();
	});

	it("multiplexes multiple folderHints callers onto one shared channel and removes only that channel on teardown", async () => {
		const { files, supabase, stop } = company();
		const removeAllChannels = vi.fn(async () => []);
		const disconnect = vi.fn();
		supabase.removeAllChannels = removeAllChannels;
		supabase.realtime.disconnect = disconnect;

		const seenA: number[] = [];
		const seenB: number[] = [];
		const statesB: boolean[] = [];
		const a = files.folderHints((seq) => seenA.push(seq));
		const b = files.folderHints(
			(seq) => seenB.push(seq),
			(connected) => statesB.push(connected),
		);
		await settle();
		expect(supabase.channel).toHaveBeenCalledTimes(1);
		realtime.joined.status("SUBSCRIBED");
		realtime.broadcast.callback({ payload: { schema: "qorpera.folder-hint/v1", seq: 7 } });
		expect(seenA).toEqual([7]);
		expect(seenB).toEqual([7]);
		expect(statesB).toEqual([true]);

		await a.close();
		expect(supabase.removeChannel).toHaveBeenCalledTimes(0);
		await b.close();
		expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
		expect(removeAllChannels).not.toHaveBeenCalled();
		expect(disconnect).not.toHaveBeenCalled();

		files.folderHints(() => {});
		await settle();
		stop.abort();
		await settle();
		expect(supabase.removeChannel).toHaveBeenCalledTimes(2);
		expect(removeAllChannels).not.toHaveBeenCalled();
		expect(disconnect).not.toHaveBeenCalled();
	});

	it("waits for an in-flight folder-hint channel removal before opening a replacement channel on the same topic", async () => {
		const { files, supabase } = company();
		const pendingRemoval = deferred<string>();
		supabase.removeChannel.mockImplementationOnce(() => {
			realtime.order.push("remove-start");
			return pendingRemoval.promise.then((status) => {
				realtime.order.push("remove-done");
				return status;
			});
		});
		const first = files.folderHints(() => {});
		await settle();
		expect(supabase.channel).toHaveBeenCalledTimes(1);

		const closing = first.close();
		await settle();
		expect(realtime.order).toContain("remove-start");

		const second = files.folderHints(() => {});
		await settle();
		expect(supabase.channel).toHaveBeenCalledTimes(1);

		pendingRemoval.resolve("ok");
		await closing;
		await settle();
		expect(supabase.channel).toHaveBeenCalledTimes(2);
		const doneIndex = realtime.order.indexOf("remove-done");
		const secondChannelIndex = realtime.order.findIndex(
			(step, index) => index > doneIndex && step.startsWith("channel "),
		);
		expect(doneIndex).toBeGreaterThan(-1);
		expect(secondChannelIndex).toBeGreaterThan(doneIndex);
		await second.close();
	});

	it("shares one hint channel across separate WebCompanyFiles instances on the same cloud and company", async () => {
		const stopA = new AbortController();
		const stopB = new AbortController();
		stops.push(stopA, stopB);
		const f = fixture();
		const supabase = f.cloud.supabase as unknown as {
			realtime: { setAuth: ReturnType<typeof vi.fn> };
			channel: ReturnType<typeof vi.fn>;
			removeChannel: ReturnType<typeof vi.fn>;
		};
		supabase.realtime = {
			setAuth: vi.fn(async () => {
				realtime.order.push("setAuth");
			}),
		};
		supabase.channel = vi.fn((topic: string, options: unknown) => {
			realtime.order.push(`channel ${topic} ${JSON.stringify(options)}`);
			return realtime.channel;
		});
		supabase.removeChannel = vi.fn(async () => {
			realtime.order.push("remove");
			return "ok";
		});

		const filesA = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stopA.signal, () => {});
		const filesB = new WebCompanyFiles(f.cloud, profileA, userA.id, "owner", stopB.signal, () => {});

		const seenA: number[] = [];
		const seenB: number[] = [];
		const statesB: boolean[] = [];
		const hintsA = filesA.folderHints((seq) => seenA.push(seq));
		await settle();
		realtime.joined.status("SUBSCRIBED");

		const hintsB = filesB.folderHints(
			(seq) => seenB.push(seq),
			(connected) => statesB.push(connected),
		);
		await settle();
		expect(supabase.channel).toHaveBeenCalledTimes(1);
		expect(supabase.removeChannel).toHaveBeenCalledTimes(0);
		expect(statesB).toEqual([true]);

		realtime.broadcast.callback({ payload: { schema: "qorpera.folder-hint/v1", seq: 11 } });
		expect(seenA).toEqual([11]);
		expect(seenB).toEqual([11]);

		await hintsB.close();
		expect(supabase.removeChannel).toHaveBeenCalledTimes(0);
		realtime.broadcast.callback({ payload: { schema: "qorpera.folder-hint/v1", seq: 12 } });
		expect(seenA).toEqual([11, 12]);
		expect(seenB).toEqual([11]);

		await hintsA.close();
		expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
	});
});
