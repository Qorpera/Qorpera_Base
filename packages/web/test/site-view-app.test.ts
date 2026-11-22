// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { SITE_DOOR_URL, SiteView } from "../src/app/views/site-view.ts";
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
async function mount(hash: string, sites: () => unknown, read = true, access?: () => unknown) {
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
		if (name === "qorpera_company_site_access" && access) return access();
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
		expect(passes(f.cloud)).toEqual([["qorpera_site_member_pass", { p_site: id(81) }, expect.any(AbortSignal)]]);
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

	it("leaves a website Qorpera took down out of the owed row, though the list still says it is live", async () => {
		const f = await mount(
			`#/c/${profileA.profileId}`,
			() => [row("wristband-shop", "Wristband shop"), row("launch-page", "Launch page")],
			true,
			() => ({
				schema: "qorpera.company-site-access/v1",
				hosts: true,
				sites: [
					{
						siteId: id(81),
						slug: "wristband-shop",
						title: "Wristband shop",
						kind: "files",
						source: "site",
						takenDown: null,
					},
					{
						siteId: id(82),
						slug: "launch-page",
						title: "Launch page",
						kind: "files",
						source: "site",
						takenDown: { at: timestamp, reason: "Phishing" },
					},
				],
			}),
		);
		expect(vi.mocked(f.cloud.rpc)).toHaveBeenCalledWith(
			"qorpera_company_site_access",
			{
				p_profile_id: profileA.profileId,
			},
			expect.any(AbortSignal),
		);
		expect(
			[...f.root.querySelectorAll<HTMLElement>(".rail-apps-owed [data-owed-place]")].map(
				(tile) => tile.dataset.owedPlace,
			),
		).toEqual(["site:wristband-shop"]);
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

	it("disposes and clears the active site view on revocation so later redraws do not re-dispose it", async () => {
		const disposeSpy = vi.spyOn(SiteView.prototype, "dispose");
		const f = await mount(siteHash("wristband-shop"), () => [row("wristband-shop", "Wristband shop")]);
		expect(disposeSpy).not.toHaveBeenCalled();

		vi.mocked(f.api.getTeam).mockRejectedValue(
			new CloudRpcError("getTeam", { code: "42501", message: "Access revoked" }),
		);
		f.hints.get("qorpera_profile_access_state")!();
		await draw();
		expect(f.root.querySelector("main")?.textContent).toContain("Your access to this company was revoked");
		expect(f.root.querySelector(".page.site-page")).toBeNull();
		const afterRevoke = disposeSpy.mock.calls.length;
		expect(afterRevoke).toBeGreaterThanOrEqual(1);

		window.dispatchEvent(new Event("resize"));
		await draw();
		expect(disposeSpy).toHaveBeenCalledTimes(afterRevoke);
	});

	it("coalesces concurrent focus-triggered site reads into one trailing re-read and skips redundant store churn when unchanged", async () => {
		const gates: Array<ReturnType<typeof deferred<ReturnType<typeof row>[]>>> = [];
		let listCalls = 0;
		await mount(siteHash("wristband-shop"), () => {
			listCalls += 1;
			const next = deferred<ReturnType<typeof row>[]>();
			gates.push(next);
			return next.promise;
		});
		expect(listCalls).toBe(1);
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("focus"));
		await draw();
		expect(listCalls).toBe(1);

		const updateSpy = vi.spyOn(SiteView.prototype, "update");
		gates[0]!.resolve([row("wristband-shop", "Wristband shop")]);
		await draw();
		expect(listCalls).toBe(2);
		updateSpy.mockClear();

		gates[1]!.resolve([row("wristband-shop", "Wristband shop")]);
		await draw();
		expect(listCalls).toBe(2);
		expect(updateSpy).not.toHaveBeenCalled();
	});
});
