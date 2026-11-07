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
	/** The channel's status callback, as the last subscribe gave it. */
	const joined = { status: (_status: string): void => {} };
	const channel = {
		on: () => channel,
		subscribe: (status?: (status: string) => void) => {
			order.push("subscribe");
			if (status) joined.status = status;
			return channel;
		},
	};
	const client = {
		realtime: { setAuth: (): Promise<void> => Promise.resolve() },
		channel: (topic: string, options: unknown) => {
			order.push(`channel ${topic} ${JSON.stringify(options)}`);
			return channel;
		},
		removeChannel: async () => {
			order.push("remove");
			return "ok";
		},
	};
	return { order, client, joined };
});

vi.mock("@supabase/supabase-js", async (original) => ({
	...(await original<typeof import("@supabase/supabase-js")>()),
	createClient: () => realtime.client,
}));

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
	return new WebCompanyFiles(fixture().cloud, profileA, userA.id, "owner", stop.signal, () => {});
}

describe("the Company File's hint channel", () => {
	it("joins its private channel only once Realtime holds the member's token", async () => {
		const auth = deferred<void>();
		const setAuth = vi.spyOn(realtime.client.realtime, "setAuth").mockImplementation(() => {
			realtime.order.push("setAuth");
			return auth.promise;
		});
		const hints = company().folderHints(() => {});
		await settle();
		// No argument: Realtime asks for the member's token through the client's accessToken.
		expect(setAuth).toHaveBeenCalledWith();
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
		vi.spyOn(realtime.client.realtime, "setAuth").mockRejectedValueOnce(new Error("Sign in again"));
		const first = company().folderHints(() => {});
		await settle();
		expect(realtime.order.filter((step) => step === "subscribe")).toHaveLength(1);
		await first.close();
		realtime.order.splice(0);
		const auth = deferred<void>();
		vi.spyOn(realtime.client.realtime, "setAuth").mockReturnValueOnce(auth.promise);
		const second = company().folderHints(() => {});
		const closing = second.close();
		auth.resolve();
		await closing;
		await settle();
		expect(realtime.order).toEqual([]);
	});

	it("tells a hidden tab's apps poll whether the real channel is subscribed: it rests only while it is", async () => {
		vi.useFakeTimers();
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
		const files = company();
		// Each read of the apps asks for the folder first; the read that fails here keeps what was read before.
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
		// Not subscribed yet: the minute's poll reads.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(2);
		realtime.joined.status("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(2);
		// The channel fails: hints may be missed, so the poll reads again.
		realtime.joined.status("CHANNEL_ERROR");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reads).toHaveBeenCalledTimes(3);
		apps.dispose();
	});
});
