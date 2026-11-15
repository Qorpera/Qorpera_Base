import { describe, expect, it, vi } from "vitest";
import { companyReleaseReads } from "../src/app/release-reads.ts";
import type { CodeReleaseCalls, CodeReleases } from "../src/cloud/releases.ts";
import { deferred } from "./fixtures.ts";

/* A company's What's new reads (app/release-reads.ts, review r1 of #1848, F1): numbered as they start, the latest-started
 * answer as the company's last read, one shared read for the drawer and the threads, never across a write from any of
 * them or from What's new's page. */

const at = (version: number): CodeReleases => ({ canRelease: true, preview: false, sites: [{ version } as never] });

function setup() {
	const answers: ReturnType<typeof deferred<CodeReleases>>[] = [];
	const calls: CodeReleaseCalls = {
		list: vi.fn(() => {
			const answer = deferred<CodeReleases>();
			answers.push(answer);
			return answer.promise;
		}),
		putLive: vi.fn(async () => ({ state: "live", version: 4 }) as const),
		goBack: vi.fn(async () => ({ state: "live", version: 2 }) as const),
		openPreview: vi.fn(async () => ({ state: "moved" }) as const),
	};
	const reads = companyReleaseReads(calls, new AbortController().signal);
	return { calls, reads, answers };
}
const signal = new AbortController().signal;
const shown = { live: 3, change: 17, token: "a".repeat(64) };

describe("A company's What's new reads", () => {
	it("keeps the latest-started answer as the last read: an older read that answers later puts nothing back", async () => {
		const { reads, answers } = setup();
		const old = reads.shared.list(signal);
		const fresh = reads.own.list(signal);
		answers[1]!.resolve(at(4));
		await fresh;
		expect(reads.last).toEqual(at(4));
		answers[0]!.resolve(at(3));
		// The caller still gets its own answer; the company's last read stays the newer one.
		expect(await old).toEqual(at(3));
		expect(reads.last).toEqual(at(4));
	});

	it("shares one read out between the drawer and the threads", async () => {
		const { calls, reads, answers } = setup();
		const a = reads.shared.list(signal);
		const b = reads.shared.list(signal);
		expect(calls.list).toHaveBeenCalledOnce();
		answers[0]!.resolve(at(3));
		expect(await a).toBe(await b);
		// Once it landed, the next caller reads anew.
		void reads.shared.list(signal);
		expect(calls.list).toHaveBeenCalledTimes(2);
	});

	it("shares no read out before the page's write with a caller after it, with no last read yet", async () => {
		const { calls, reads, answers } = setup();
		expect(reads.last).toBeUndefined();
		const old = reads.shared.list(signal);
		await reads.own.putLive("qorpera", "shop", shown, signal);
		const after = reads.shared.list(signal);
		expect(calls.list).toHaveBeenCalledTimes(2);
		answers[1]!.resolve(at(4));
		expect(await after).toEqual(at(4));
		answers[0]!.resolve(at(3));
		await old;
		expect(reads.last).toEqual(at(4));
	});

	it("shares no read out while a write is on its way, from the shared calls too", async () => {
		const { calls, reads } = setup();
		const write = deferred<{ state: "live"; version: number }>();
		vi.mocked(calls.putLive).mockReturnValueOnce(write.promise);
		void reads.shared.list(signal);
		const going = reads.shared.putLive("qorpera", "shop", shown, signal);
		void reads.shared.list(signal);
		expect(calls.list).toHaveBeenCalledTimes(2);
		write.resolve({ state: "live", version: 4 });
		await going;
		void reads.shared.list(signal);
		expect(calls.list).toHaveBeenCalledTimes(3);
	});
});
