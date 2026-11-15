// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { fixture, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

/* "A change is ready" in the app (own code storage, thread pieces): the agent's thread starts from the company's last
 * read of What's new, whichever desk made it, so a change put live on What's new's page is no card in the thread
 * opened next, with no read of its own (the lead's review of 01d21c76f, F1); and it stays true when answers come back
 * out of order: an older read that answers late puts nothing back, and no read out before the page's write is shared
 * after it (review r1 of #1848, F1). */

const TOKEN = "a".repeat(64);
const project = (ready: boolean, version: number) => ({
	owner: "qorpera",
	name: "wristband-shop",
	site: { slug: "wristband-shop", url: "https://sites.qorpera.com/wristband-shop/", title: "Wristband shop" },
	live: { version, kind: "release", since: timestamp, by: userA.id, from: null },
	back: null,
	ready: ready
		? {
				change: 17,
				token: TOKEN,
				agent: staff.id,
				changes: [
					{
						key: 17,
						notice: "The checkout shows the gift message.",
						picture: null,
						at: timestamp,
						wasLive: false,
					},
				],
				quiet: 0,
			}
		: null,
	waiting: 0,
	problem: null,
});
const readOf = (ready: boolean, version: number) => ({
	schema: "qorpera.code-releases/v1",
	canRelease: true,
	sites: [project(ready, version)],
});

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function draw() {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
	await settle();
}
const reads = (cloud: Cloud) =>
	vi.mocked(cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_list_code_releases").length;
const go = async (hash: string) => {
	location.hash = hash;
	await draw();
};
const chat = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
const page = `#/c/${profileA.profileId}/whats-new`;

/** The app on `hash`, over a cloud whose What's new read answers what is live when the read starts (version 3 with the
 * change ready, then version 4 with nothing ready once Put it live went through). `hold()` keeps the next read out
 * until `answer()`: it answers what was true when it started. */
async function mount(hash: string) {
	history.replaceState(null, "", `/${hash}`);
	const f = fixture();
	vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
	vi.mocked(f.api.getTeam).mockResolvedValue({
		...team,
		members: [
			{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			{ userId: userB.id, email: "bo@example.invalid", displayName: "Bo", role: "admin", joinedAt: timestamp },
		],
	});
	const state = { live: 3, holding: false, held: [] as (() => void)[] };
	vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
		if (name === "qorpera_list_code_releases") {
			const answer = structuredClone(readOf(state.live === 3, state.live));
			if (!state.holding) return answer;
			state.holding = false;
			return new Promise((resolve) => state.held.push(() => resolve(answer)));
		}
		if (name === "qorpera_put_code_release_live") {
			state.live = 4;
			return { schema: "qorpera.code-release/v1", state: "live", version: 4 };
		}
		throw new Error("Unexpected RPC");
	});
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud as Cloud, f.api);
	await draw();
	return {
		...f,
		root,
		hold: () => {
			state.holding = true;
		},
		answer: async () => {
			for (const answer of state.held.splice(0)) answer();
			await draw();
		},
	};
}
const card = (root: Element) => root.querySelector(".thread-ready-card");
const badge = (root: Element) => root.querySelector(".rail-app.rail-whats-new .rail-count")?.textContent ?? "";
async function putLiveOnPage(root: Element) {
	await go(page);
	[...root.querySelectorAll<HTMLButtonElement>(".whats-new-page button")]
		.find((item) => item.textContent === "Put it live")!
		.click();
	await draw();
	expect(root.querySelector(".whats-new-page")?.textContent).toContain("Version 4 is live.");
}

describe("A change is ready, in the app", () => {
	it("starts the agent's thread from the page's last read: a change put live there is no card, with no read of its own", async () => {
		const f = await mount(chat);
		// The agent's thread has the card, from the company's read.
		expect(card(f.root)).not.toBeNull();
		// Put live on What's new's page, which reads with calls of its own.
		await putLiveOnPage(f.root);
		const before = reads(f.cloud);
		// Back in the agent's thread, with no window focus between: what is true now, and no read of its own.
		await go(chat);
		expect(card(f.root)).toBeNull();
		expect(f.root.querySelector(".thread-ready")).toBeNull();
		expect(reads(f.cloud)).toBe(before);
	});

	it("keeps the page's answer when an older read of the drawer answers after it: no card, no badge put back", async () => {
		const f = await mount(chat);
		expect(card(f.root)).not.toBeNull();
		expect(badge(f.root)).toBe("1");
		// The window comes back on a slow link: the drawer's read (and the thread's, sharing it) is out, before the write.
		f.hold();
		window.dispatchEvent(new Event("focus"));
		await draw();
		// Put live on the page, whose own read after the write answers first.
		await putLiveOnPage(f.root);
		expect(badge(f.root)).toBe("");
		// The old read answers now, with what was true when it started: it puts nothing back.
		await f.answer();
		expect(badge(f.root)).toBe("");
		const before = reads(f.cloud);
		await go(chat);
		expect(card(f.root)).toBeNull();
		expect(reads(f.cloud)).toBe(before);
	});

	it("shares no read that was out before the page's write with a thread that reads after it", async () => {
		const f = await mount(chat);
		f.hold();
		window.dispatchEvent(new Event("focus"));
		await draw();
		await putLiveOnPage(f.root);
		await go(chat);
		expect(card(f.root)).toBeNull();
		// The window comes back again while the old read is still out: the drawer and the thread read anew, after the
		// write, and take nothing of the old answer for theirs.
		const before = reads(f.cloud);
		window.dispatchEvent(new Event("focus"));
		await draw();
		expect(reads(f.cloud)).toBe(before + 1);
		await f.answer();
		expect(card(f.root)).toBeNull();
		expect(badge(f.root)).toBe("");
	});
});
