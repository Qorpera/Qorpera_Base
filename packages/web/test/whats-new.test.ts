// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { liveVersions, WhatsNewView, whatsNewEntry } from "../src/app/views/whats-new.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CodeReleaseAnswer,
	type CodeReleaseSite,
	type CodeReleases,
	codeReleaseCalls,
	parseCodeReleaseAnswer,
	parseCodeReleases,
} from "../src/cloud/releases.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";

/* What's new (own code storage step 4): every state of the plan's 9.3, Put it live, Go back and Not yet, and the read's
 * strict parse. Founders never read a change number, a commit, a check, a branch or a repository path. */

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Kaya", templateId: "co-founder" };
const vera: HostedStaffAgent = { ...staff, id: id(41), displayName: "Vera", role: "Developer" };
const gone: HostedStaffAgent = { ...vera, id: id(42), displayName: "Otto", employmentStatus: "archived" };

/** The shop's site, live at version 3 with version 2 kept, and six changes ready: four with a notice, two behind the
 * scenes, and two more on the way. */
function shop(extra: Partial<CodeReleaseSite> = {}): CodeReleaseSite {
	return {
		owner: "qorpera",
		name: "wristband-shop",
		site: { slug: "wristband-shop", url: "https://sites.qorpera.com/wristband-shop/", title: "Wristband shop" },
		live: { version: 3, kind: "release", since: timestamp, by: userA.id },
		back: { version: 2 },
		ready: {
			change: 17,
			token: TOKEN,
			agent: vera.id,
			changes: [
				{
					key: 17,
					notice: "The checkout shows the gift message.",
					picture: "code/qorpera/wristband-shop/changes/17.png",
					at: timestamp,
					wasLive: false,
				},
				{ key: 16, notice: "Sizes are easier to pick.", picture: null, at: timestamp, wasLive: false },
				{
					key: 14,
					notice: "The cart remembers what you added.",
					picture: "product/cart.png",
					at: timestamp,
					wasLive: false,
				},
				{ key: 13, notice: "Prices show with VAT.", picture: "missing.png", at: timestamp, wasLive: false },
			],
			quiet: 2,
		},
		waiting: 2,
		problem: null,
		givenUp: false,
		...extra,
	};
}

const releasesOf = (sites: CodeReleaseSite[], canRelease = true): CodeReleases => ({ canRelease, sites });

/** The read as the kernel sends it (qorpera.code-releases/v1), with a key this web does not know. */
function wire(releases: CodeReleases): unknown {
	return {
		schema: "qorpera.code-releases/v1",
		canRelease: releases.canRelease,
		sites: releases.sites.map((site) => ({ ...site, live: site.live && { ...site.live, from: null } })),
	};
}

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	let blobs = 0;
	URL.createObjectURL = vi.fn(() => `blob:picture-${++blobs}`);
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	localStorage.clear();
	location.hash = "";
	setLanguagePreference("system");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company(role: "owner" | "contributor" = "owner", agents: HostedStaffAgent[] = [cofounder, vera]) {
	const controller = new CompanyController(fixture().api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: agents,
		sessions: [session],
		team: {
			...team,
			role,
			members: [{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role, joinedAt: timestamp }],
		},
	});
	cleanup.push(() => controller.stop());
	return controller;
}

interface Setup {
	role?: "owner" | "contributor";
	agents?: HostedStaffAgent[];
	putLive?: (shown: unknown) => Promise<CodeReleaseAnswer>;
	goBack?: (shown: unknown) => Promise<CodeReleaseAnswer>;
	image?: (path: string) => Promise<Blob | null>;
}

async function page(reads: CodeReleases[], options: Setup = {}) {
	const controller = company(options.role, options.agents);
	const queue = [...reads];
	const client = {
		list: vi.fn(async () => structuredClone(queue.length > 1 ? queue.shift()! : queue[0]!)),
		putLive: vi.fn(async (_owner: string, _name: string, shown: unknown) =>
			options.putLive ? options.putLive(shown) : ({ state: "live", version: 4 } as const),
		),
		goBack: vi.fn(async (_owner: string, _name: string, shown: unknown) =>
			options.goBack ? options.goBack(shown) : ({ state: "live", version: 2 } as const),
		),
	};
	const image = vi.fn(
		options.image ??
			(async (path: string) =>
				path === "missing.png" ? null : new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
	);
	const listed = vi.fn();
	const view = new WhatsNewView(controller, client, controller.signal, { image, listed });
	cleanup.push(() => view.dispose());
	document.body.append(view.el);
	await settle();
	return { controller, client, view, image, listed };
}

const text = (root: Element) => root.textContent ?? "";
const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const labels = (root: Element) => buttons(root).map((item) => item.textContent);
const press = (root: Element, label: string) =>
	buttons(root)
		.find((item) => item.textContent === label)!
		.click();
const block = (view: WhatsNewView) => view.el.querySelector<HTMLElement>('[data-site="qorpera/wristband-shop"]')!;
const lines = (root: Element) => [...root.querySelectorAll(".whats-new-line")].map((line) => line.textContent);
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;
/** Nothing technical: no change number, commit, repository path, check or the word release. */
function plain(root: Element) {
	const words = text(root);
	expect(words).not.toMatch(/\b(?:17|16|14|13)\b|qorpera\/|code\/|commit|branch|\bchecks?\b|release|token/i);
}

describe("What's new: the read", () => {
	it("reads every value it shows, and leaves a key it does not know", () => {
		const read = parseCodeReleases(wire(releasesOf([shop()])));
		expect(read).toEqual(releasesOf([shop()]));
		const first = parseCodeReleases(
			wire(
				releasesOf([shop({ site: null, live: null, back: null, ready: { ...shop().ready!, agent: null } })], false),
			),
		);
		expect(first.canRelease).toBe(false);
		expect(first.sites[0]?.ready?.agent).toBeNull();
		const bad = (change: (site: Record<string, unknown>) => void) => {
			const value = wire(releasesOf([shop()])) as { sites: Record<string, unknown>[] };
			change(value.sites[0]!);
			return () => parseCodeReleases(value);
		};
		expect(bad((site) => Object.assign(site.ready as object, { token: "short" }))).toThrow();
		expect(bad((site) => Object.assign(site.live as object, { kind: "forward" }))).toThrow();
		expect(bad((site) => Object.assign(site.site as object, { url: "http://sites.qorpera.com/x/" }))).toThrow();
		expect(
			bad((site) => Object.assign((site.ready as { changes: object[] }).changes[0]!, { picture: "../secret.png" })),
		).toThrow();
		expect(bad((site) => Object.assign(site, { waiting: -1 }))).toThrow();
		expect(() => parseCodeReleases({ schema: "qorpera.code-releases/v2", canRelease: true, sites: [] })).toThrow();
		// givenUp: a kernel from before the key leaves it out, which reads as not given up; only true is given up.
		const older = wire(releasesOf([shop()])) as { sites: Record<string, unknown>[] };
		delete older.sites[0]!.givenUp;
		expect(parseCodeReleases(older).sites[0]?.givenUp).toBe(false);
		const given = wire(releasesOf([shop({ givenUp: true })]));
		expect(parseCodeReleases(given).sites[0]?.givenUp).toBe(true);
		expect(
			parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "live", version: 4, url: "x" }),
		).toEqual({
			state: "live",
			version: 4,
		});
		expect(parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "moved" })).toEqual({ state: "moved" });
		expect(() => parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "maybe" })).toThrow();
	});

	it("calls the member's three functions with the company and exactly what the page drew", async () => {
		const rpc = vi.fn(async (name: string) =>
			name === "qorpera_list_code_releases"
				? wire(releasesOf([shop()]))
				: { schema: "qorpera.code-release/v1", state: "live", version: 4, url: "https://sites.qorpera.com/x/" },
		);
		const calls = codeReleaseCalls({ rpc } as unknown as Cloud, profileA.profileId);
		const signal = new AbortController().signal;
		await calls.list(signal);
		await calls.putLive("qorpera", "wristband-shop", { live: 3, change: 17, token: TOKEN }, signal);
		await calls.goBack("qorpera", "wristband-shop", { live: 3, to: 2 }, signal);
		expect(rpc.mock.calls).toEqual([
			["qorpera_list_code_releases", { p_profile_id: profileA.profileId }],
			[
				"qorpera_put_code_release_live",
				{
					p_profile_id: profileA.profileId,
					p_owner: "qorpera",
					p_name: "wristband-shop",
					p_shown: { live: 3, change: 17, token: TOKEN },
				},
			],
			[
				"qorpera_code_release_back",
				{
					p_profile_id: profileA.profileId,
					p_owner: "qorpera",
					p_name: "wristband-shop",
					p_shown: { live: 3, to: 2 },
				},
			],
		]);
	});
});

describe("What's new: the page", () => {
	it("shows what is live and the ready changes as pictures with one line each, newest first", async () => {
		const { view, image } = await page([releasesOf([shop()])]);
		const site = block(view);
		expect(site.querySelector("h2")?.textContent).toBe("Wristband shop");
		const live = site.querySelector(".whats-new-live")!;
		expect(live.querySelector("strong")?.textContent).toBe("Live now");
		expect(live.querySelector(".site-meta")?.textContent).toMatch(/^Version 3 · since .+ · Ann said go$/);
		const open = [...live.querySelectorAll<HTMLAnchorElement>("a")].find(
			(link) => link.textContent === "Open the site",
		)!;
		expect(open.getAttribute("href")).toBe("https://sites.qorpera.com/wristband-shop/");
		expect(open.target).toBe("_blank");
		const password = [...live.querySelectorAll<HTMLAnchorElement>("a")].find(
			(link) => link.textContent === "The password is in Sites.",
		)!;
		expect(password.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/sites`);
		expect(labels(live)).toEqual(["Go back to version 2"]);
		expect(site.querySelector("h3")?.textContent).toBe("6 changes are ready");
		expect(lines(site)).toEqual([
			"The checkout shows the gift message.",
			"Sizes are easier to pick.",
			"The cart remembers what you added.",
			"Prices show with VAT.",
		]);
		const cards = [...site.querySelectorAll<HTMLElement>(".whats-new-change")];
		// A picture read from the folder; a change without one, or whose picture cannot be read, is its line on a plain tile.
		expect(cards.map((card) => card.classList.contains("is-plain"))).toEqual([false, true, false, true]);
		expect(cards[0]?.querySelector("img")?.getAttribute("src")).toMatch(/^blob:picture-/);
		expect(image.mock.calls.map(([path]) => path)).toEqual([
			"code/qorpera/wristband-shop/changes/17.png",
			"product/cart.png",
			"missing.png",
		]);
		expect(site.querySelector(".whats-new-behind")?.textContent).toBe("and 2 changes behind the scenes");
		expect(labels(site.querySelector(".whats-new-actions")!)).toEqual(["Put it live", "Not yet"]);
		expect(site.querySelector(".whats-new-waiting")?.textContent).toBe("2 more changes are not ready yet.");
		plain(site);
		// A draw keeps the cards and their pictures as they are.
		const first = cards[0];
		press(site, "Put it live");
		await settle();
		expect(block(view).querySelector(".whats-new-change")).toBe(first);
	});

	it("draws what is live as a row of the Sites page: the globe, a quiet line, pill buttons", async () => {
		const { view } = await page([releasesOf([shop()])]);
		const row = block(view).querySelector(".whats-new-live > .site-row.is-whats-new")!;
		expect(row.querySelector("svg.site-emblem")).not.toBeNull();
		expect(row.querySelector(".site-name")?.textContent).toBe("Live now");
		expect([...row.querySelectorAll(".site-meta")].map((line) => line.textContent)).toEqual([
			expect.stringMatching(/^Version 3 · since .+ · Ann said go$/),
			"The password is in Sites.",
		]);
		// Open the site and Go back, as the Sites page's quiet pills; no grey card around them.
		const actions = row.querySelector(".site-actions")!;
		expect([...actions.children].map((item) => [item.tagName, item.className, item.textContent])).toEqual([
			["A", "site-button", "Open the site"],
			["BUTTON", "site-button", "Go back to version 2"],
		]);
		expect(block(view).querySelector(".service-card, .hook-card, .connection-list")).toBeNull();
		// Before the first version, the globe is grey.
		const first = await page([releasesOf([shop({ site: null, live: null, back: null })])]);
		expect(block(first.view).querySelector(".site-row.is-whats-new.is-waiting .site-emblem")).not.toBeNull();
	});

	it("tells the Sites page the version each site made from code has live", () => {
		expect(
			liveVersions(
				releasesOf([
					shop(),
					shop({ name: "gift", site: { slug: "gift", url: "https://sites.qorpera.com/gift/", title: null } }),
					shop({ name: "new", site: null, live: null }),
					shop({
						name: "waiting",
						site: { slug: "waiting", url: "https://sites.qorpera.com/waiting/", title: null },
						live: null,
					}),
				]),
			),
		).toEqual({ "wristband-shop": 3, gift: 3 });
	});

	it("says nothing new is ready, and still offers Go back", async () => {
		const { view } = await page([releasesOf([shop({ ready: null, waiting: 1 })])]);
		const site = block(view);
		expect(text(site)).toContain("Nothing new is ready.");
		expect(text(site)).toContain("1 more change is not ready yet.");
		expect(site.querySelector(".whats-new-actions")).toBeNull();
		expect(labels(site)).toEqual(["Go back to version 2"]);
	});

	it("puts the first version live: not live yet, no link, no Go back", async () => {
		const { view, client } = await page([
			releasesOf([shop({ site: null, live: null, back: null, waiting: 0, ready: { ...shop().ready!, quiet: 0 } })]),
		]);
		const site = block(view);
		// Before its first upload the project goes by its name.
		expect(site.querySelector("h2")?.textContent).toBe("wristband-shop");
		expect(site.querySelector(".whats-new-live strong")?.textContent).toBe("Not live yet");
		expect(site.querySelector(".whats-new-live a")).toBeNull();
		// Nothing to open or go back to: no empty row of buttons.
		expect(site.querySelector(".whats-new-live .site-actions")).toBeNull();
		expect(site.querySelector("h3")?.textContent).toBe("4 changes are ready");
		expect(site.querySelector(".whats-new-behind")).toBeNull();
		expect(labels(site)).toEqual(["Put the first version live", "Not yet"]);
		press(site, "Put the first version live");
		await settle();
		expect(client.putLive).toHaveBeenCalledWith(
			"qorpera",
			"wristband-shop",
			{ live: null, change: 17, token: TOKEN },
			expect.any(AbortSignal),
		);
	});

	it("counts changes behind the scenes alone, and one of each", async () => {
		const quietOnly = shop({ ready: { ...shop().ready!, changes: [], quiet: 3 } });
		const { view } = await page([releasesOf([quietOnly])]);
		expect(block(view).querySelector("h3")?.textContent).toBe("3 changes are ready");
		expect(block(view).querySelector(".whats-new-behind")?.textContent).toBe("3 changes behind the scenes");
		expect(block(view).querySelector(".whats-new-changes")).toBeNull();
		const one = await page([
			releasesOf([
				shop({ waiting: 1, ready: { ...shop().ready!, changes: [shop().ready!.changes[1]!], quiet: 1 } }),
			]),
		]);
		expect(block(one.view).querySelector("h3")?.textContent).toBe("2 changes are ready");
		expect(block(one.view).querySelector(".whats-new-behind")?.textContent).toBe("and 1 change behind the scenes");
		const single = await page([releasesOf([shop({ ready: { ...shop().ready!, changes: [], quiet: 1 } })])]);
		expect(block(single.view).querySelector("h3")?.textContent).toBe("1 change is ready");
		expect(block(single.view).querySelector(".whats-new-behind")?.textContent).toBe("1 change behind the scenes");
	});

	it("shows a member who is not an owner or admin what is ready, without the buttons, Go back or the password", async () => {
		const { view } = await page([releasesOf([shop()], false)], { role: "contributor" });
		const site = block(view);
		expect(lines(site)).toHaveLength(4);
		expect(labels(site)).toEqual([]);
		expect(text(site)).toContain("Founders and admins put changes live.");
		expect(text(site)).not.toContain("The password is in Sites.");
		expect(text(site)).toContain("Open the site");
	});

	it("puts it live: both buttons off while the call is out, then the new version, read again", async () => {
		const answer = deferred<CodeReleaseAnswer>();
		const after = shop({
			live: { version: 4, kind: "release", since: timestamp, by: userA.id },
			back: { version: 3 },
			ready: null,
		});
		const { view, client, listed } = await page([releasesOf([shop()]), releasesOf([after])], {
			putLive: () => answer.promise,
		});
		press(block(view), "Put it live");
		await settle();
		expect(client.putLive).toHaveBeenCalledWith(
			"qorpera",
			"wristband-shop",
			{ live: 3, change: 17, token: TOKEN },
			expect.any(AbortSignal),
		);
		const busy = buttons(block(view));
		expect(busy.map((item) => [item.textContent, item.disabled])).toEqual([
			["Go back to version 2", true],
			["Putting it live…", true],
			["Not yet", true],
		]);
		answer.resolve({ state: "live", version: 4 });
		await settle();
		const site = block(view);
		expect(site.querySelector(".whats-new-live + .service-outcome")?.textContent).toBe("Version 4 is live.");
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(site.querySelector(".site-meta")?.textContent).toMatch(/^Version 4 · since .+ · Ann said go$/);
		expect(text(site)).toContain("Nothing new is ready.");
		expect(listed).toHaveBeenLastCalledWith(releasesOf([after]));
	});

	it("draws the page again when it moved while the member looked, and nothing changed", async () => {
		const newer = shop({ ready: { ...shop().ready!, change: 18, token: OTHER_TOKEN } });
		const { view, client } = await page([releasesOf([shop()]), releasesOf([newer])], {
			putLive: async () => ({ state: "moved" }),
		});
		press(block(view), "Put it live");
		await settle();
		expect(block(view).querySelector("h3")?.previousElementSibling?.textContent).toBe(
			"Something changed while you looked. Here is what is ready now.",
		);
		expect(client.list).toHaveBeenCalledTimes(2);
		press(block(view), "Put it live");
		await settle();
		expect(client.putLive).toHaveBeenLastCalledWith(
			"qorpera",
			"wristband-shop",
			{ live: 3, change: 18, token: OTHER_TOKEN },
			expect.any(AbortSignal),
		);
	});

	it.each([
		[
			new CloudRpcError("x", { message: "Releases unavailable", code: "42501" }, 403),
			"only founders and admins can put a version live",
		],
		[
			new CloudRpcError("x", { message: "canceling statement due to lock timeout", code: "55P03" }, 500),
			"Qorpera was busy for a moment",
		],
		[new CloudRpcError("x", { message: "no such repository", code: "P0002" }, 404), "the project is no longer there"],
		[
			new CloudRpcError("x", { message: "canceling statement due to statement timeout", code: "57014" }, 500),
			"Qorpera was busy for a moment",
		],
		[
			new CloudRpcError("x", { message: "p_shown is invalid", code: "22023" }, 400),
			"something went wrong on Qorpera's side",
		],
	])("says why it did not go live when the database refused it, and that nothing changed (%s)", async (error, why) => {
		const { view } = await page([releasesOf([shop()])], { putLive: () => Promise.reject(error) });
		press(block(view), "Put it live");
		await settle();
		const outcome = block(view).querySelector(".whats-new-actions + .service-outcome.is-error");
		expect(outcome?.textContent).toBe(`It did not go live: ${why}. Nothing changed.`);
		expect(outcome?.textContent).not.toContain("42501");
		expect(labels(block(view))).toContain("Put it live");
	});

	it("sends Put it live once, however often it is pressed while the call is out", async () => {
		const answer = deferred<CodeReleaseAnswer>();
		const { view, client } = await page([releasesOf([shop()])], { putLive: () => answer.promise });
		const put = buttons(block(view)).find((item) => item.textContent === "Put it live")!;
		put.click();
		put.click();
		await settle();
		press(block(view), "Putting it live…");
		await settle();
		expect(client.putLive).toHaveBeenCalledOnce();
		answer.resolve({ state: "live", version: 4 });
		await settle();
		expect(client.putLive).toHaveBeenCalledOnce();
	});

	/** A page over a list whose answers are given one by one: a value, an error to throw, or a promise to hold. */
	async function stepped(
		answers: (CodeReleases | Error | Promise<CodeReleases>)[],
		writes: { putLive?: () => Promise<CodeReleaseAnswer>; goBack?: () => Promise<CodeReleaseAnswer> },
	) {
		const controller = company();
		const list = vi.fn(async () => {
			const next = answers.shift() ?? releasesOf([shop()]);
			if (next instanceof Error) throw next;
			return structuredClone(await next);
		});
		const view = new WhatsNewView(
			controller,
			{ list, putLive: vi.fn(writes.putLive ?? vi.fn()), goBack: vi.fn(writes.goBack ?? vi.fn()) },
			controller.signal,
		);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		return { view, list };
	}
	const lost = () => Promise.reject(new CloudRpcError("x", { message: "TypeError: Failed to fetch", code: "" }, 0));
	const fourLive = () =>
		releasesOf([
			shop({
				live: { version: 4, kind: "release", since: timestamp, by: userA.id },
				back: { version: 3 },
				ready: null,
			}),
		]);
	const focus = async () => {
		window.dispatchEvent(new Event("focus"));
		await settle();
	};
	const said = (view: WhatsNewView) =>
		[...block(view).querySelectorAll(".service-outcome")].map((line) => line.textContent);

	it("claims neither outcome when the answer is lost, says it is not known while reads fail, and settles with the first read that succeeds", async () => {
		const followUp = deferred<CodeReleases>();
		const { view, list } = await stepped(
			[releasesOf([shop()]), followUp.promise, new Error("Failed to fetch"), fourLive(), fourLive()],
			{ putLive: lost },
		);
		press(block(view), "Put it live");
		await settle();
		// The write committed, and its answer was lost: neither "went live" nor "nothing changed" yet.
		expect(said(view)).toEqual(["It may not have gone live: Qorpera could not be reached. Checking…"]);
		expect(block(view).querySelector(".whats-new-live + .service-outcome")).not.toBeNull();
		followUp.reject(new Error("Failed to fetch"));
		await settle();
		const unknown =
			"Qorpera could not be reached, so it is not known whether it went live. Open this page again in a moment.";
		expect(said(view)).toEqual([unknown]);
		expect(text(view.el)).not.toContain("Nothing changed");
		await focus();
		expect(list).toHaveBeenCalledTimes(3);
		expect(said(view)).toEqual([unknown]);
		// The first read that succeeds settles it: the version is live.
		await focus();
		expect(said(view)).toEqual(["Version 4 is live."]);
		// And the next one takes the line away: no old outcome over what a read shows.
		await focus();
		expect(list).toHaveBeenCalledTimes(5);
		expect(said(view)).toEqual([]);
	});

	/** Failures that may come after the write committed: nothing in them proves it did not go through. */
	const ambiguous: [string, CloudRpcError][] = [
		[
			"a gateway's 502",
			new CloudRpcError(
				"qorpera_put_code_release_live",
				{ message: "An invalid response was received from the upstream server" },
				502,
			),
		],
		[
			"a gateway's 504 page",
			new CloudRpcError(
				"qorpera_put_code_release_live",
				{ message: "<html><body><h1>504 Gateway Time-out</h1></body></html>" },
				504,
			),
		],
		[
			"a 500 with no SQLSTATE",
			new CloudRpcError("qorpera_put_code_release_live", { message: "Internal Server Error", code: "" }, 500),
		],
		[
			"a 500 with another SQLSTATE",
			new CloudRpcError("qorpera_put_code_release_live", { message: "internal", code: "XX000" }, 500),
		],
		[
			"a 200 whose body is no JSON",
			new CloudRpcError("qorpera_put_code_release_live", { message: "<html>ok</html>" }, 200),
		],
		[
			"a token refused by the gateway",
			new CloudRpcError("qorpera_put_code_release_live", { message: "JWT expired", code: "PGRST301" }, 401),
		],
	];

	it.each(ambiguous)(
		"says it went live when %s came after the write committed and the read shows it",
		async (_kind, error) => {
			const { view } = await stepped([releasesOf([shop()]), fourLive()], { putLive: () => Promise.reject(error) });
			press(block(view), "Put it live");
			await settle();
			expect(said(view)).toEqual(["Version 4 is live."]);
			expect(text(view.el)).not.toContain("Nothing changed");
		},
	);

	it.each(ambiguous)("says it is not known when %s came and the read fails too", async (_kind, error) => {
		const { view } = await stepped([releasesOf([shop()]), new Error("Failed to fetch")], {
			putLive: () => Promise.reject(error),
		});
		press(block(view), "Put it live");
		await settle();
		expect(said(view)).toEqual([
			"Qorpera could not be reached, so it is not known whether it went live. Open this page again in a moment.",
		]);
		expect(text(view.el)).not.toContain("Nothing changed");
	});

	it("says the same of a Go back that a gateway's 502 answered after it committed", async () => {
		const gone = shop({ live: { version: 2, kind: "back", since: timestamp, by: userA.id }, back: null });
		const { view } = await stepped([releasesOf([shop()]), releasesOf([gone])], {
			goBack: () => Promise.reject(ambiguous[0]![1]),
		});
		press(block(view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(said(view)).toEqual(["Version 2 is live."]);
	});

	it("takes the line away when the read after a lost answer shows nothing changed, with the ready changes there again", async () => {
		const { view } = await stepped([releasesOf([shop()]), releasesOf([shop()])], { putLive: lost });
		press(block(view), "Put it live");
		await settle();
		expect(said(view)).toEqual([]);
		expect(labels(block(view).querySelector(".whats-new-actions")!)).toEqual(["Put it live", "Not yet"]);
	});

	it("never lets a read that left before the press settle it", async () => {
		const early = deferred<CodeReleases>();
		const late = deferred<CodeReleases>();
		const { view } = await stepped([releasesOf([shop()]), early.promise, late.promise], { putLive: lost });
		// A read is out (the window came back) when the member presses.
		window.dispatchEvent(new Event("focus"));
		press(block(view), "Put it live");
		await settle();
		// It answers with the page as it was before the press: that settles nothing.
		early.resolve(releasesOf([shop()]));
		await settle();
		expect(said(view)).toEqual(["It may not have gone live: Qorpera could not be reached. Checking…"]);
		late.resolve(fourLive());
		await settle();
		expect(said(view)).toEqual(["Version 4 is live."]);
	});

	it("says the same of a Go back whose answer was lost, and settles it when the older version is live", async () => {
		const gone = shop({ live: { version: 2, kind: "back", since: timestamp, by: userA.id }, back: null });
		const { view } = await stepped([releasesOf([shop()]), new Error("Failed to fetch"), releasesOf([gone])], {
			goBack: lost,
		});
		press(block(view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(said(view)).toEqual([
			"Qorpera could not be reached, so it is not known whether it went back. Open this page again in a moment.",
		]);
		await focus();
		expect(said(view)).toEqual(["Version 2 is live."]);
	});

	it("takes any outcome away once a later read succeeds", async () => {
		const { view } = await page([releasesOf([shop()]), fourLive()]);
		press(block(view), "Put it live");
		await settle();
		expect(said(view)).toEqual(["Version 4 is live."]);
		await focus();
		expect(said(view)).toEqual([]);
		const refused = await page([releasesOf([shop()])], {
			putLive: () => Promise.reject(new CloudRpcError("x", { message: "", code: "42501" }, 403)),
		});
		press(block(refused.view), "Put it live");
		await settle();
		expect(said(refused.view)).toEqual([
			"It did not go live: only founders and admins can put a version live. Nothing changed.",
		]);
		await focus();
		expect(said(refused.view)).toEqual([]);
	});

	it("draws what is live again when Go back finds the page moved", async () => {
		const newer = shop({
			live: { version: 4, kind: "release", since: timestamp, by: userA.id },
			back: { version: 3 },
		});
		const { view } = await page([releasesOf([shop()]), releasesOf([newer])], {
			goBack: async () => ({ state: "moved" }),
		});
		press(block(view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(block(view).querySelector(".whats-new-live + .service-outcome")?.textContent).toBe(
			"Something changed while you looked. Here is what is live now.",
		);
		expect(labels(block(view).querySelector(".whats-new-live")!)).toEqual(["Go back to version 3"]);
	});

	it("reads again when the window comes back, keeps what it showed when a read gets no answer, and drops it when the cloud refuses the member", async () => {
		const controller = company();
		const list = vi
			.fn()
			.mockResolvedValueOnce(releasesOf([shop()]))
			.mockRejectedValueOnce(new Error("Failed to fetch"))
			.mockRejectedValueOnce(
				new CloudRpcError("qorpera_list_code_releases", { message: "Releases unavailable", code: "42501" }, 403),
			);
		const view = new WhatsNewView(controller, { list, putLive: vi.fn(), goBack: vi.fn() }, controller.signal);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		expect(labels(block(view))).toContain("Put it live");
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(list).toHaveBeenCalledTimes(2);
		expect(text(view.el)).toContain("What's new could not be read.");
		expect(labels(block(view))).toContain("Put it live");
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(list).toHaveBeenCalledTimes(3);
		expect(view.el.querySelector("[data-site]")).toBeNull();
		expect(labels(view.el)).toEqual(["Try again"]);
	});

	it("shows a picture that does not decode as its line on a plain tile", async () => {
		const { view } = await page([releasesOf([shop()])]);
		const first = block(view).querySelector<HTMLElement>(".whats-new-change")!;
		first.querySelector("img")!.dispatchEvent(new Event("error"));
		expect(first.classList.contains("is-plain")).toBe(true);
		expect(first.querySelector("img")).toBeNull();
		expect(first.querySelector(".whats-new-line")?.textContent).toBe("The checkout shows the gift message.");
	});

	it("asks once before going back, and goes back to the version Go back named", async () => {
		const back = shop({
			live: { version: 2, kind: "back", since: timestamp, by: userA.id },
			back: null,
			ready: {
				...shop().ready!,
				changes: shop().ready!.changes.map((change) => ({ ...change, wasLive: change.key <= 14 })),
			},
		});
		const { view, client } = await page([releasesOf([shop()]), releasesOf([back])]);
		press(block(view), "Go back to version 2");
		await settle();
		expect(dialog().querySelector("p")?.textContent).toBe(
			"Put version 2 back up? Version 3 comes off the site at once; its changes stay ready.",
		);
		expect(labels(dialog())).toEqual(["Cancel", "Go back"]);
		press(dialog(), "Cancel");
		await settle();
		expect(client.goBack).not.toHaveBeenCalled();
		press(block(view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(client.goBack).toHaveBeenCalledWith(
			"qorpera",
			"wristband-shop",
			{ live: 3, to: 2 },
			expect.any(AbortSignal),
		);
		const site = block(view);
		expect(site.querySelector(".whats-new-live + .service-outcome")?.textContent).toBe("Version 2 is live.");
		// Gone back: who put the older version up again, and the changes it took off are ready again, marked.
		expect(site.querySelector(".site-meta")?.textContent).toMatch(/^Version 2 · since .+ · Ann went back$/);
		expect(labels(site.querySelector(".whats-new-live")!)).toEqual([]);
		expect(
			[...site.querySelectorAll(".whats-new-change")].map(
				(card) => card.querySelector(".whats-new-was")?.textContent ?? null,
			),
		).toEqual([null, null, "Was live before", "Was live before"]);
	});

	it("says a Go back did not happen, and why", async () => {
		const { view } = await page([releasesOf([shop()])], {
			goBack: () => Promise.reject(new CloudRpcError("x", { message: "", code: "42501" }, 403)),
		});
		press(block(view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(block(view).querySelector(".whats-new-live + .service-outcome.is-error")?.textContent).toBe(
			"It did not go back: only founders and admins can put a version live. Nothing changed.",
		);
	});

	it.each([
		["SITE_LIMIT", "This project can't get a site: the company has 10. Take one offline in Sites."],
		["SITE_UPLOAD_FAILED", "The newest version could not be prepared. Qorpera is trying again."],
	])("says in one plain line why the newest version is not there (%s)", async (problem, line) => {
		const { view } = await page([releasesOf([shop({ problem, ready: null })])]);
		const notice = block(view).querySelector(".notice-warn");
		expect(notice?.textContent).toBe(line);
		expect(text(block(view))).not.toContain(problem);
	});

	it.each([
		// Five failures of one change: no upload tries it again until a newer change is saved.
		["SITE_UPLOAD_FAILED", "The newest version could not be prepared. The next change that is saved gets a new try."],
		// The company's ten sites stay the reason, given up or not.
		["SITE_LIMIT", "This project can't get a site: the company has 10. Take one offline in Sites."],
	])("never says Qorpera is trying again once it stopped trying (%s)", async (problem, line) => {
		const { view } = await page([releasesOf([shop({ problem, givenUp: true, ready: null })])]);
		expect(block(view).querySelector(".notice-warn")?.textContent).toBe(line);
		expect(text(block(view))).not.toContain("trying again");
	});

	it("leaves the name out when the member who said go left the company", async () => {
		const { view } = await page([
			releasesOf([shop({ live: { version: 3, kind: "release", since: timestamp, by: id(99) } })]),
		]);
		expect(block(view).querySelector(".site-meta")?.textContent).toMatch(/^Version 3 · since [^·]+$/);
	});

	it("says when the page could not be read, and reads it again on Try again", async () => {
		const controller = company();
		const list = vi
			.fn()
			.mockRejectedValueOnce(new CloudRpcError("qorpera_list_code_releases", { message: "", code: "PGRST202" }, 404))
			.mockResolvedValue(releasesOf([]));
		const view = new WhatsNewView(controller, { list, putLive: vi.fn(), goBack: vi.fn() }, controller.signal);
		cleanup.push(() => view.dispose());
		expect(text(view.el)).toContain("Checking…");
		await settle();
		expect(text(view.el)).toContain("What's new could not be read.");
		press(view.el, "Try again");
		await settle();
		expect(text(view.el)).toBe("Nothing new is ready.");
	});

	it("is in Danish", async () => {
		setLanguagePreference("da");
		const { view } = await page([releasesOf([shop()])]);
		const site = block(view);
		expect(site.querySelector(".whats-new-live strong")?.textContent).toBe("Live nu");
		expect(site.querySelector(".site-meta")?.textContent).toMatch(/^Version 3 · siden .+ · Ann sagde ja$/);
		expect(site.querySelector("h3")?.textContent).toBe("6 ændringer er klar");
		expect(site.querySelector(".whats-new-behind")?.textContent).toBe("og 2 ændringer bag kulisserne");
		expect(labels(site)).toEqual(["Gå tilbage til version 2", "Sæt live", "Ikke endnu"]);
		expect(text(site)).toContain("Åbn hjemmesiden");
		expect(text(site)).toContain("Adgangskoden står under Hjemmesider.");
		expect(text(site)).toContain("2 ændringer mere er ikke klar endnu.");
	});
});

describe("What's new: Not yet", () => {
	it("opens the agent's thread with Not yet waiting in its composer, sends nothing, and quiets the badge here", async () => {
		const { view, controller, listed } = await page([releasesOf([shop()])]);
		expect(whatsNewEntry(controller, releasesOf([shop()]))).toEqual({ ready: 6 });
		const opened = vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		const draft = vi.spyOn(controller, "addToDraft").mockImplementation(() => {});
		const sent = vi.spyOn(controller, "sendPrompt");
		location.hash = `#/c/${profileA.profileId}/whats-new`;
		press(block(view), "Not yet");
		await settle();
		expect(opened).toHaveBeenCalledWith(expect.objectContaining({ id: vera.id }));
		expect(draft).toHaveBeenCalledWith(session.sessionId, { text: "Not yet: ", quotes: [] });
		expect(sent).not.toHaveBeenCalled();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${vera.id}`);
		// Quiet in this browser for what the page showed; anything newer counts again.
		expect(whatsNewEntry(controller, releasesOf([shop()]))).toEqual({ ready: 0 });
		expect(listed).toHaveBeenCalledTimes(2);
		const newer = shop({ ready: { ...shop().ready!, token: OTHER_TOKEN } });
		expect(whatsNewEntry(controller, releasesOf([newer]))).toEqual({ ready: 6 });
		// Another member, or another company, is not quieted.
		const other = new CompanyController(fixture().api, profileA, id(2));
		cleanup.push(() => other.stop());
		expect(whatsNewEntry(other, releasesOf([shop()]))).toEqual({ ready: 6 });
	});

	it.each([
		["no agent made the change", null, [cofounder, vera]],
		["the agent left", gone.id, [cofounder, vera, gone]],
	])("tells the Co-Founder when %s", async (_why, agent, agents) => {
		const { view, controller } = await page([releasesOf([shop({ ready: { ...shop().ready!, agent } })])], { agents });
		const opened = vi
			.spyOn(controller, "openCofounderConversation")
			.mockResolvedValue({ sessionId: session.sessionId });
		const draft = vi.spyOn(controller, "addToDraft").mockImplementation(() => {});
		location.hash = `#/c/${profileA.profileId}/whats-new`;
		press(block(view), "Not yet");
		await settle();
		expect(opened).toHaveBeenCalledOnce();
		expect(draft).toHaveBeenCalledWith(session.sessionId, { text: "Not yet: ", quotes: [] });
		expect(location.hash).toBe(`#/c/${profileA.profileId}`);
	});

	it("does not put Not yet twice, and stays on the page when the thread cannot open", async () => {
		const { view, controller } = await page([releasesOf([shop()])]);
		controller.conversation(session.sessionId, false).set({ draft: "Not yet: the colours" });
		vi.spyOn(controller, "openStaffConversation")
			.mockResolvedValueOnce(session.sessionId)
			// The cloud's own words for a thread that would not open name machinery: never shown.
			.mockRejectedValueOnce(new Error("permission denied for function qorpera_agent_thread"));
		const draft = vi.spyOn(controller, "addToDraft");
		location.hash = `#/c/${profileA.profileId}/whats-new`;
		press(block(view), "Not yet");
		await settle();
		expect(draft).not.toHaveBeenCalled();
		location.hash = `#/c/${profileA.profileId}/whats-new`;
		press(block(view), "Not yet");
		await settle();
		expect(block(view).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent).toBe(
			"The thread could not be opened.",
		);
		expect(text(block(view))).not.toContain("qorpera_agent_thread");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/whats-new`);
	});

	it("has no entry while no project makes a website", () => {
		expect(whatsNewEntry(company(), releasesOf([]))).toBeUndefined();
		expect(whatsNewEntry(company(), releasesOf([shop({ ready: null })]))).toEqual({ ready: 0 });
	});

	it("gives a member who cannot put a version live the entry, without a count they could never clear", () => {
		expect(whatsNewEntry(company("contributor"), releasesOf([shop()], false))).toEqual({ ready: 0 });
	});

	it("quiets only the project it was said to, and counts every project's changes", async () => {
		const other = shop({
			owner: "qorpera",
			name: "gift-cards",
			site: { slug: "gift-cards", url: "https://sites.qorpera.com/gift-cards/", title: "Gift cards" },
			ready: { ...shop().ready!, token: OTHER_TOKEN, changes: [shop().ready!.changes[1]!], quiet: 0 },
		});
		const { view, controller } = await page([releasesOf([shop(), other])]);
		// In the read's order (live sites first, then the others: 729000 orders them).
		expect([...view.el.querySelectorAll(".whats-new-site h2")].map((title) => title.textContent)).toEqual([
			"Wristband shop",
			"Gift cards",
		]);
		expect(whatsNewEntry(controller, releasesOf([shop(), other]))).toEqual({ ready: 7 });
		vi.spyOn(controller, "openStaffConversation").mockResolvedValue(session.sessionId);
		vi.spyOn(controller, "addToDraft").mockImplementation(() => {});
		location.hash = `#/c/${profileA.profileId}/whats-new`;
		press(view.el.querySelector('[data-site="qorpera/gift-cards"]')!, "Not yet");
		await settle();
		expect(whatsNewEntry(controller, releasesOf([shop(), other]))).toEqual({ ready: 6 });
	});
});
