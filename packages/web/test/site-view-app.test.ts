// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { SITE_DOOR_URL } from "../src/app/views/site-view.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { deferred, fixture, id, profileA, settle, team, timestamp, userA, userB } from "./fixtures.ts";

/* A company's website in the app (company views step 4, V2): the route #/c/<id>/site/<slug> waits for the company's
 * sites, shows a live website with a member's pass, says so for one it can't show, follows the member to another
 * website, and tells the other members where this one is. */

const row = (slug: string, title: string, extra: Record<string, unknown> = {}) => ({
	schema: "qorpera.company-site/v1",
	id: id(slug === "wristband-shop" ? 81 : 82),
	slug,
	title,
	kind: "files",
	machine: null,
	port: null,
	url: `https://${slug}.qorpera.com/`,
	state: "live",
	source: "site",
	files: 3,
	bytes: 100,
	publishedAt: timestamp,
	publishedBy: null,
	createdAt: timestamp,
	passwordChangedAt: timestamp,
	...extra,
});
const pass = (slug: string) => ({
	schema: "qorpera.site-member-pass/v1",
	state: "open",
	host: `${slug}.qorpera.com`,
	pass: "A".repeat(43),
	expiresAt: "2026-11-15T10:01:00Z",
	action: `https://${slug}.qorpera.com/__qorpera/member`,
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
/** The app at `hash` over the fixture's cloud, whose sites read answers `sites` (a value, an error, or a promise). */
async function mount(hash: string, sites: () => unknown, read = true) {
	history.replaceState(null, "", `/${hash}`);
	const f = fixture();
	vi.mocked(f.api.getTeam).mockResolvedValue({
		...team,
		capabilities: { ...team.capabilities, read: read as true },
		members: [
			{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			{ userId: userB.id, email: "bo@example.invalid", displayName: "Bo", role: "admin", joinedAt: timestamp },
		],
	});
	vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args?: Record<string, unknown>) => {
		if (name === "qorpera_list_company_sites") {
			const value = await sites();
			if (value instanceof Error) throw value;
			return structuredClone(value);
		}
		if (name === "qorpera_site_member_pass") return pass(args?.p_site === id(81) ? "wristband-shop" : "launch-page");
		throw new CloudRpcError(name, { message: "not here", code: "PGRST202" }, 404);
	});
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud as Cloud, f.api);
	await draw();
	return { ...f, root };
}
const siteHash = (slug: string) => `#/c/${profileA.profileId}/site/${slug}`;
const passes = (cloud: Cloud) =>
	vi.mocked(cloud.rpc).mock.calls.filter(([name]) => name === "qorpera_site_member_pass");

describe("a company's website in the app", () => {
	it("opens a live website at its address with a member's pass, its tile lit, and says where the member is", async () => {
		const f = await mount(siteHash("wristband-shop"), () => [row("wristband-shop", "Wristband shop")]);
		const page = f.root.querySelector<HTMLElement>(".page.site-page")!;
		expect(page.querySelector(".site-address")?.textContent).toBe("wristband-shop.qorpera.com");
		expect(passes(f.cloud)).toEqual([["qorpera_site_member_pass", { p_site: id(81) }]]);
		expect(page.querySelector("iframe.site-frame")?.getAttribute("src")).toBe(SITE_DOOR_URL);
		const tile = f.root.querySelector<HTMLElement>(".rail-apps-owed [data-owed-place='site:wristband-shop']")!;
		expect(tile.getAttribute("aria-current")).toBe("page");
		const presence = vi.mocked(f.api.joinPresence).mock.results[0]?.value as {
			setOpenThread: ReturnType<typeof vi.fn>;
		};
		expect(presence.setOpenThread).toHaveBeenLastCalledWith("@site:wristband-shop");
	});

	it("waits for the company's sites on a deep link, then shows the website", async () => {
		const list = deferred<unknown>();
		const f = await mount(siteHash("wristband-shop"), () => list.promise);
		expect(f.root.querySelector(".page .skeleton-page")).not.toBeNull();
		expect(f.root.querySelector(".page.site-page")).toBeNull();
		list.resolve([row("wristband-shop", "Wristband shop")]);
		await draw();
		expect(f.root.querySelector(".page.site-page")).not.toBeNull();
		expect(f.root.querySelector(".page .skeleton-page")).toBeNull();
	});

	it("says it can't show a website that is not one of the company's live ones, or when the sites can't be read", async () => {
		const notLive = await mount(siteHash("wristband-shop"), () => [
			row("wristband-shop", "Wristband shop", { state: "publishing", publishedAt: null }),
		]);
		expect(notLive.root.querySelector(".page")?.textContent).toContain("This website can't be shown here right now.");
		expect(notLive.root.querySelector(".page.site-page")).toBeNull();
		expect(passes(notLive.cloud)).toEqual([]);
		dispose?.();
		document.body.replaceChildren();
		const failed = await mount(siteHash("wristband-shop"), () => new Error("Failed to fetch"));
		expect(failed.root.querySelector(".page")?.textContent).toContain("This website can't be shown here right now.");
		expect(failed.root.querySelector(".page .skeleton-page")).toBeNull();
		dispose?.();
		document.body.replaceChildren();
		// A member the company's sites are never read for does not wait either.
		const unread = await mount(siteHash("wristband-shop"), () => [row("wristband-shop", "Wristband shop")], false);
		expect(unread.root.querySelector(".page")?.textContent).toContain("This website can't be shown here right now.");
		expect(unread.root.querySelector(".page .skeleton-page")).toBeNull();
	});

	it("follows the member to another website, and leaves the first one behind", async () => {
		const f = await mount(siteHash("wristband-shop"), () => [
			row("wristband-shop", "Wristband shop"),
			row("launch-page", "Launch page"),
		]);
		const first = f.root.querySelector<HTMLElement>(".page.site-page")!;
		location.hash = siteHash("launch-page");
		window.dispatchEvent(new HashChangeEvent("hashchange"));
		await draw();
		const second = f.root.querySelector<HTMLElement>(".page.site-page")!;
		expect(second).not.toBe(first);
		expect(first.isConnected).toBe(false);
		expect(second.querySelector(".site-address")?.textContent).toBe("launch-page.qorpera.com");
		expect(passes(f.cloud).map(([, args]) => args)).toEqual([{ p_site: id(81) }, { p_site: id(82) }]);
	});
});
