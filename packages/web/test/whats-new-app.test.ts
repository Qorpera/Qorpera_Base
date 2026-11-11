// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { fixture, profileA, session, settle, team, timestamp, userA, userB } from "./fixtures.ts";

/* What's new in the app (own code storage step 4): the read for the apps drawer's entry when the company opens and
 * when the window gets focus, a cloud without it (or one that refuses the member) showing no entry, and the page at
 * #/c/<id>/whats-new. */

const TOKEN = "a".repeat(64);
const read = {
	schema: "qorpera.code-releases/v1",
	canRelease: true,
	sites: [
		{
			owner: "qorpera",
			name: "wristband-shop",
			site: { slug: "wristband-shop", url: "https://sites.qorpera.com/wristband-shop/", title: "Wristband shop" },
			live: { version: 3, kind: "release", since: timestamp, by: userA.id, from: null },
			back: null,
			ready: {
				change: 17,
				token: TOKEN,
				agent: null,
				changes: [
					{
						key: 17,
						notice: "The checkout shows the gift message.",
						picture: null,
						at: timestamp,
						wasLive: false,
					},
				],
				quiet: 1,
			},
			waiting: 0,
			problem: null,
		},
	],
};

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
/** The app over the fixture's cloud, whose What's new read answers `answer` (a value, or an error to throw). */
async function mount(hash: string, answer: () => unknown) {
	history.replaceState(null, "", `/${hash}`);
	const f = fixture();
	// Another member, so the company's presence is joined.
	vi.mocked(f.api.getTeam).mockResolvedValue({
		...team,
		members: [
			{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			{ userId: userB.id, email: "bo@example.invalid", displayName: "Bo", role: "admin", joinedAt: timestamp },
		],
	});
	vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
		if (name !== "qorpera_list_code_releases") throw new Error("Unexpected RPC");
		const value = answer();
		if (value instanceof Error) throw value;
		return structuredClone(value);
	});
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud as Cloud, f.api);
	await draw();
	return { ...f, root };
}
const entry = (root: Element) => root.querySelector<HTMLElement>(".rail-app.rail-whats-new");
const reads = (cloud: Cloud) =>
	vi.mocked(cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_list_code_releases");

describe("What's new in the app", () => {
	it("reads it when the company opens, shows its entry with what is ready, and its page at its address", async () => {
		const f = await mount(`#/c/${profileA.profileId}/whats-new`, () => read);
		expect(reads(f.cloud)[0]).toEqual(["qorpera_list_code_releases", { p_profile_id: profileA.profileId }]);
		expect(entry(f.root)?.querySelector(".rail-count")?.textContent).toBe("2");
		expect(entry(f.root)?.getAttribute("aria-current")).toBe("page");
		const page = f.root.querySelector<HTMLElement>(".page.whats-new-page")!;
		expect(page.querySelector("h1")?.textContent).toBe("What's new");
		expect(page.querySelector(".whats-new-site h2")?.textContent).toBe("Wristband shop");
		// The other members' rails can say who is here.
		const presence = vi.mocked(f.api.joinPresence).mock.results[0]?.value as {
			setOpenThread: ReturnType<typeof vi.fn>;
		};
		expect(presence.setOpenThread).toHaveBeenLastCalledWith("@whats-new");
	});

	it("reads it again when the window gets focus, and drops the entry once the cloud refuses the member", async () => {
		let answer: unknown = read;
		const f = await mount(`#/c/${profileA.profileId}/chat/${session.sessionId}`, () => answer);
		expect(entry(f.root)).not.toBeNull();
		// A read that did not answer leaves the entry as it was.
		answer = new Error("Failed to fetch");
		window.dispatchEvent(new Event("focus"));
		await draw();
		expect(entry(f.root)).not.toBeNull();
		answer = new CloudRpcError("qorpera_list_code_releases", { message: "Releases unavailable", code: "42501" }, 403);
		window.dispatchEvent(new Event("focus"));
		await draw();
		expect(reads(f.cloud)).toHaveLength(3);
		expect(entry(f.root)).toBeNull();
	});

	it("shows no entry on a cloud without the read, and says so on the page", async () => {
		const f = await mount(
			`#/c/${profileA.profileId}/whats-new`,
			() => new CloudRpcError("qorpera_list_code_releases", { message: "missing", code: "PGRST202" }, 404),
		);
		expect(entry(f.root)).toBeNull();
		expect(f.root.querySelector(".whats-new-page")?.textContent).toContain("What's new could not be read.");
	});
});
