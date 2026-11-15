// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { fixture, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

/* "A change is ready" in the app (own code storage, thread pieces): the agent's thread starts from the company's last
 * read of What's new, whichever desk made it, so a change put live on What's new's page is no card in the thread
 * opened next, with no read of its own (the lead's review of 01d21c76f, F1). */

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

describe("A change is ready, in the app", () => {
	it("starts the agent's thread from the page's last read: a change put live there is no card, with no read of its own", async () => {
		const chat = `#/c/${profileA.profileId}/chat/${session.sessionId}`;
		const page = `#/c/${profileA.profileId}/whats-new`;
		history.replaceState(null, "", `/${chat}`);
		const f = fixture();
		vi.mocked(f.api.listSessions).mockResolvedValue([{ ...session, staffAgentId: staff.id }]);
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
				{ userId: userB.id, email: "bo@example.invalid", displayName: "Bo", role: "admin", joinedAt: timestamp },
			],
		});
		let live = 3;
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name === "qorpera_list_code_releases") return structuredClone(readOf(live === 3, live));
			if (name === "qorpera_put_code_release_live") {
				live = 4;
				return { schema: "qorpera.code-release/v1", state: "live", version: 4 };
			}
			throw new Error("Unexpected RPC");
		});
		const root = document.createElement("div");
		document.body.append(root);
		dispose = mountApplication(root, f.cloud as Cloud, f.api);
		await draw();
		// The agent's thread has the card, from the company's read.
		expect(root.querySelector(".thread-ready-card")).not.toBeNull();
		// Put live on What's new's page, which reads with calls of its own.
		await go(page);
		const button = [...root.querySelectorAll<HTMLButtonElement>(".whats-new-page button")].find(
			(item) => item.textContent === "Put it live",
		)!;
		button.click();
		await draw();
		expect(root.querySelector(".whats-new-page")?.textContent).toContain("Version 4 is live.");
		const before = reads(f.cloud);
		// Back in the agent's thread, with no window focus between: what is true now, and no read of its own.
		await go(chat);
		expect(root.querySelector(".thread-ready-card, .thread-ready")).toBeNull();
		expect(reads(f.cloud)).toBe(before);
	});
});
