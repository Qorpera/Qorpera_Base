// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type CompanyState } from "../src/app/company.ts";
import { liveVersions, WhatsNewView, whatsNewEntry } from "../src/app/views/whats-new.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { CloudShapeError } from "../src/cloud/parse.ts";
import {
	type CodeReleaseAnswer,
	type CodeReleaseSite,
	type CodeReleases,
	codeReleaseCalls,
	parseCodeReleaseAnswer,
	parseCodeReleases,
	parseSitePreviewAnswer,
	type SitePreviewAnswer,
} from "../src/cloud/releases.ts";
import type { CompanySite } from "../src/cloud/sites.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import {
	deferred,
	fixture,
	id,
	oneHostList,
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
const LISTED = {
	id: id(81),
	slug: "wristband-shop",
	title: "Wristband shop",
	kind: "files",
	url: "https://sites.qorpera.com/wristband-shop/",
	state: "live",
} as CompanySite;
const PUBLIC = { siteList: [LISTED], sitesPublic: new Map([[LISTED.id, true]]) };
const NOT_PUBLIC = { siteList: [LISTED], sitesPublic: new Map([[LISTED.id, false]]) };
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
		live: { version: 3, kind: "release", since: timestamp, by: userA.id, auto: false, byExecutor: null },
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

const releasesOf = (sites: CodeReleaseSite[], canRelease = true, preview = false): CodeReleases => ({
	canRelease,
	preview,
	sites,
});

/** The read as the kernel sends it (qorpera.code-releases/v1), with a key this web does not know. `preview` only while
 * it is offered (step 5.1: the kernel leaves the key out while sites have no addresses of their own). */
function wire(releases: CodeReleases): unknown {
	return {
		schema: "qorpera.code-releases/v1",
		canRelease: releases.canRelease,
		...(releases.preview ? { preview: true } : {}),
		sites: releases.sites.map((site) => ({
			...site,
			live: site.live && {
				version: site.live.version,
				kind: site.live.kind,
				since: site.live.since,
				by: site.live.by,
				...(site.live.auto ? { auto: true, byExecutor: site.live.byExecutor } : {}),
				from: null,
			},
		})),
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
	openPreview?: (shown: unknown) => Promise<SitePreviewAnswer>;
	image?: (path: string) => Promise<Blob | null>;
	takenDown?: (signal: AbortSignal) => Promise<ReadonlySet<string>>;
	sites?: Pick<CompanyState, "siteList" | "sitesPublic">;
}

/** Look first's one-time ticket, as the kernel makes one (43 characters), and its link on the shop's next host. */
const TICKET = "Tk3_-9aZqLm0PxW2vB8nC4dE6fG1hJ5kR7sU0yQwXeA";
const NEXT = `https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET}`;

async function page(reads: CodeReleases[], options: Setup = {}) {
	const controller = company(options.role, options.agents);
	controller.store.set(options.sites ?? PUBLIC);
	const queue = [...reads];
	const client = {
		list: vi.fn(async () => structuredClone(queue.length > 1 ? queue.shift()! : queue[0]!)),
		putLive: vi.fn(async (_owner: string, _name: string, shown: unknown) =>
			options.putLive ? options.putLive(shown) : ({ state: "live", version: 4 } as const),
		),
		goBack: vi.fn(async (_owner: string, _name: string, shown: unknown) =>
			options.goBack ? options.goBack(shown) : ({ state: "live", version: 2 } as const),
		),
		openPreview: vi.fn(
			async (_owner: string, _name: string, shown: unknown): Promise<SitePreviewAnswer> =>
				options.openPreview ? options.openPreview(shown) : { state: "open", url: NEXT },
		),
	};
	const image = vi.fn(
		options.image ??
			(async (path: string) =>
				path === "missing.png" ? null : new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
	);
	const listed = vi.fn();
	const view = new WhatsNewView(controller, client, controller.signal, {
		image,
		listed,
		...(options.takenDown ? { takenDown: options.takenDown } : {}),
	});
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
		expect(bad((site) => Object.assign(site.live as object, { auto: "yes" }))).toThrow(CloudShapeError);
		expect(bad((site) => Object.assign(site.live as object, { auto: true }))).toThrow(CloudShapeError);
		expect(bad((site) => Object.assign(site.live as object, { auto: true, byExecutor: "bad executor!" }))).toThrow(
			CloudShapeError,
		);
		expect(bad((site) => Object.assign(site.live as object, { auto: true, byExecutor: "x".repeat(121) }))).toThrow(
			CloudShapeError,
		);
		expect(bad((site) => Object.assign(site.live as object, { auto: false, byExecutor: "exec-1" }))).toThrow(
			CloudShapeError,
		);
		expect(bad((site) => Object.assign(site.live as object, { byExecutor: "exec-1" }))).toThrow(CloudShapeError);
		const autoLive = shop({
			live: {
				version: 4,
				kind: "release",
				since: timestamp,
				by: userA.id,
				auto: true,
				byExecutor: "executor:worker-1.prod_01",
			},
		});
		expect(parseCodeReleases(wire(releasesOf([autoLive])))).toEqual(releasesOf([autoLive]));
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
		rpc.mockImplementationOnce(async () => ({ schema: "qorpera.site-preview/v1", state: "open", url: NEXT }));
		expect(
			await calls.openPreview("qorpera", "wristband-shop", { change: 17, slug: "wristband-shop" }, signal),
		).toEqual({ state: "open", url: NEXT });
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
			[
				"qorpera_open_site_preview",
				{ p_profile_id: profileA.profileId, p_owner: "qorpera", p_name: "wristband-shop", p_change: 17 },
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
		expect(text(live)).not.toMatch(/password/i);
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

	it("calls a version Live now only when everyone can open the site, Not live yet when not, Current version while unknown", async () => {
		const heading = (view: WhatsNewView) => block(view).querySelector(".whats-new-live .site-name")?.textContent;
		const meta = (view: WhatsNewView) =>
			[...block(view).querySelectorAll(".whats-new-live .site-meta")].map((line) => line.textContent);
		const version = expect.stringMatching(/^Version 3 · since .+ · Ann said go$/);
		const { view: open } = await page([releasesOf([shop()])], { sites: PUBLIC });
		expect([heading(open), meta(open)]).toEqual(["Live now", [version]]);
		open.dispose();
		const { view: closed } = await page([releasesOf([shop()])], { sites: NOT_PUBLIC });
		expect([heading(closed), meta(closed)]).toEqual([
			"Not live yet",
			[version, "Only the company can open it. Go live in Sites."],
		]);
		const link = block(closed).querySelector<HTMLAnchorElement>(".whats-new-live .site-meta a")!;
		expect(link.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/sites`);
		expect(link.hasAttribute("href")).toBe(false);
		expect(text(block(closed))).not.toMatch(/password/i);
		closed.dispose();
		for (const sites of [{}, { siteList: [LISTED] }, { siteList: [] }]) {
			const { view: unknown } = await page([releasesOf([shop()])], { sites });
			expect([heading(unknown), meta(unknown)], JSON.stringify(sites)).toEqual(["Current version", [version]]);
			unknown.dispose();
		}
		const { view: app } = await page([releasesOf([shop()])], {
			sites: { siteList: [{ ...LISTED, kind: "app" } as CompanySite], sitesPublic: new Map([[LISTED.id, false]]) },
		});
		expect([heading(app), meta(app)]).toEqual(["Live now", [version]]);
		app.dispose();
		const { view: never } = await page([releasesOf([shop({ live: null, back: null })])], { sites: NOT_PUBLIC });
		expect([heading(never), meta(never)]).toEqual(["Not live yet", []]);
		never.dispose();
	});

	it("shows a member who is not an owner or admin the heading, but not the way to go live", async () => {
		const { view } = await page([releasesOf([shop()], false)], { role: "contributor", sites: NOT_PUBLIC });
		expect(block(view).querySelector(".whats-new-live .site-name")?.textContent).toBe("Not live yet");
		expect(block(view).querySelector(".whats-new-live .site-meta a")).toBeNull();
		expect(text(block(view))).not.toContain("Go live in Sites");
	});

	it("says the headings and the way to go live in Danish", async () => {
		setLanguagePreference("da");
		try {
			const heading = (view: WhatsNewView) => block(view).querySelector(".whats-new-live .site-name")?.textContent;
			const { view: closed } = await page([releasesOf([shop()])], { sites: NOT_PUBLIC });
			expect(heading(closed)).toBe("Ikke live endnu");
			expect(block(closed).querySelector(".whats-new-live .site-meta a")?.textContent).toBe(
				"Kun virksomheden kan åbne den. Gå live under Hjemmesider.",
			);
			closed.dispose();
			const { view: unknown } = await page([releasesOf([shop()])], { sites: {} });
			expect(heading(unknown)).toBe("Nuværende version");
			unknown.dispose();
			const { view: open } = await page([releasesOf([shop()])], { sites: PUBLIC });
			expect(heading(open)).toBe("Live nu");
		} finally {
			setLanguagePreference("system");
		}
	});

	it("draws the heading and the way to go live again as the answer comes, after the page was drawn, and follows it", async () => {
		const { view, controller, client } = await page([releasesOf([shop()])], { sites: {} });
		const heading = () => block(view).querySelector(".whats-new-live .site-name")?.textContent;
		const link = () => block(view).querySelector(".whats-new-live .site-meta a")?.textContent ?? null;
		expect([heading(), link()]).toEqual(["Current version", null]);
		controller.store.set({ siteList: [LISTED] });
		await settle();
		expect([heading(), link()]).toEqual(["Current version", null]);
		controller.store.set({ sitesPublic: new Map([[LISTED.id, false]]) });
		await settle();
		expect([heading(), link()]).toEqual(["Not live yet", "Only the company can open it. Go live in Sites."]);
		controller.store.set({ sitesPublic: new Map([[LISTED.id, true]]) });
		await settle();
		expect([heading(), link()]).toEqual(["Live now", null]);
		controller.store.set({ sitesTakenDown: new Set([LISTED.id]) });
		await settle();
		expect(heading()).toBe("Not live yet");
		expect(client.list).toHaveBeenCalledTimes(1);
		view.dispose();
		controller.store.set({ sitesTakenDown: new Set() });
		await settle();
		expect(view.el.textContent).toBe("");
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
			live: { version: 4, kind: "release", since: timestamp, by: userA.id, auto: false, byExecutor: null },
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
				live: { version: 4, kind: "release", since: timestamp, by: userA.id, auto: false, byExecutor: null },
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
		const gone = shop({
			live: { version: 2, kind: "back", since: timestamp, by: userA.id, auto: false, byExecutor: null },
			back: null,
		});
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
		const gone = shop({
			live: { version: 2, kind: "back", since: timestamp, by: userA.id, auto: false, byExecutor: null },
			back: null,
		});
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
			live: { version: 4, kind: "release", since: timestamp, by: userA.id, auto: false, byExecutor: null },
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
			live: { version: 2, kind: "back", since: timestamp, by: userA.id, auto: false, byExecutor: null },
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
			releasesOf([
				shop({
					live: { version: 3, kind: "release", since: timestamp, by: id(99), auto: false, byExecutor: null },
				}),
			]),
		]);
		expect(block(view).querySelector(".site-meta")?.textContent).toMatch(/^Version 3 · since [^·]+$/);
	});

	it("marks automatic executor releases and rollbacks without claiming the admin pressed go", async () => {
		const { view: released } = await page([
			releasesOf([
				shop({
					live: {
						version: 4,
						kind: "release",
						since: timestamp,
						by: userA.id,
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		const releaseSite = block(released);
		expect(releaseSite.querySelector(".site-meta")?.textContent).toMatch(
			/^Version 4 · since .+ · automatic \(enabled by Ann\)$/,
		);
		expect(text(releaseSite)).not.toContain("Ann said go");
		expect(text(releaseSite)).not.toContain("executor-1");
		plain(releaseSite);

		const { view: rolledBack } = await page([
			releasesOf([
				shop({
					live: {
						version: 2,
						kind: "back",
						since: timestamp,
						by: userA.id,
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		expect(block(rolledBack).querySelector(".site-meta")?.textContent).toMatch(
			/^Version 2 · since .+ · went back automatically \(enabled by Ann\)$/,
		);
		plain(block(rolledBack));

		const { view: anonRelease } = await page([
			releasesOf([
				shop({
					live: {
						version: 4,
						kind: "release",
						since: timestamp,
						by: id(99),
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		expect(block(anonRelease).querySelector(".site-meta")?.textContent).toMatch(/^Version 4 · since .+ · automatic$/);

		const { view: anonBack } = await page([
			releasesOf([
				shop({
					live: {
						version: 2,
						kind: "back",
						since: timestamp,
						by: null,
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		expect(block(anonBack).querySelector(".site-meta")?.textContent).toMatch(
			/^Version 2 · since .+ · went back automatically$/,
		);

		setLanguagePreference("da");
		const { view: daAuto } = await page([
			releasesOf([
				shop({
					live: {
						version: 4,
						kind: "release",
						since: timestamp,
						by: userA.id,
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		expect(block(daAuto).querySelector(".site-meta")?.textContent).toMatch(
			/^Version 4 · siden .+ · automatisk \(slået til af Ann\)$/,
		);

		const { view: daBack } = await page([
			releasesOf([
				shop({
					live: {
						version: 2,
						kind: "back",
						since: timestamp,
						by: userA.id,
						auto: true,
						byExecutor: "executor-1",
					},
				}),
			]),
		]);
		expect(block(daBack).querySelector(".site-meta")?.textContent).toMatch(
			/^Version 2 · siden .+ · sat live igen automatisk \(slået til af Ann\)$/,
		);
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
		expect(text(site)).not.toContain("Adgangskode");
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

describe("What's new: Look first (own code storage step 5.1)", () => {
	/** A tab as window.open hands it back: what the page may do with it, recorded. `opener` at the moment the tab is sent
	 * anywhere is kept, so a test sees the way back was cut before. */
	function tabs(blocked = false) {
		const opened: {
			opener: unknown;
			closed: boolean;
			location: { replace: ReturnType<typeof vi.fn> };
			close: ReturnType<typeof vi.fn>;
			openerWhenSent?: unknown;
		}[] = [];
		const open = vi.spyOn(window, "open").mockImplementation(() => {
			if (blocked) return null;
			const tab = {
				opener: window as unknown,
				closed: false,
				location: {
					replace: vi.fn((_url: string) => {
						tab.openerWhenSent = tab.opener;
					}),
				},
				close: vi.fn(() => {
					tab.closed = true;
				}),
				openerWhenSent: undefined as unknown,
			};
			opened.push(tab);
			return tab as unknown as Window;
		});
		return { open, opened };
	}
	const offered = () => releasesOf([shop()], true, true);
	const actions = (view: WhatsNewView) => block(view).querySelector(".whats-new-actions")!;
	const lookLine = (view: WhatsNewView) =>
		block(view).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent;
	const lost = () => Promise.reject(new CloudRpcError("x", { message: "TypeError: Failed to fetch", code: "" }, 0));

	it("shows nothing of it on a kernel without it, or while sites have no addresses of their own (today's read)", async () => {
		const { open } = tabs();
		// Today's read has no `preview`: it reads as false, and so does anything but true.
		expect(parseCodeReleases(wire(releasesOf([shop()]))).preview).toBe(false);
		for (const preview of [false, "true", 1, null, {}]) {
			const value = { ...(wire(releasesOf([shop()])) as object), preview };
			expect(parseCodeReleases(value).preview, String(preview)).toBe(false);
		}
		expect(parseCodeReleases(wire(offered())).preview).toBe(true);
		const { view, client } = await page([releasesOf([shop()])]);
		expect(labels(actions(view))).toEqual(["Put it live", "Not yet"]);
		expect(text(view.el)).not.toContain("Look first");
		press(block(view), "Put it live");
		await settle();
		expect(client.openPreview).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		// A client without the call (and the read offering it) shows no button either.
		const controller = company();
		const bare = new WhatsNewView(
			controller,
			{ list: vi.fn(async () => offered()), putLive: vi.fn(), goBack: vi.fn() },
			controller.signal,
		);
		cleanup.push(() => bare.dispose());
		document.body.append(bare.el);
		await settle();
		expect(labels(actions(bare))).toEqual(["Put it live", "Not yet"]);
	});

	it("shows Look first before Put it live for an owner or admin while the read offers it, and never to anyone else", async () => {
		const { view } = await page([offered()]);
		expect(labels(actions(view))).toEqual(["Look first", "Put it live", "Not yet"]);
		plain(block(view));
		// A member who is not an owner or admin: the kernel neither offers it nor lets them put a version live.
		const member = await page([releasesOf([shop()], false, false)], { role: "contributor" });
		expect(labels(block(member.view))).toEqual([]);
		expect(text(member.view.el)).not.toContain("Look first");
		// Even a read that offered it to a member who may not put a version live draws no button.
		const odd = await page([releasesOf([shop()], false, true)], { role: "contributor" });
		expect(labels(block(odd.view))).toEqual([]);
		// Nothing ready, or no site yet: nothing to look at.
		const nothing = await page([releasesOf([shop({ ready: null })], true, true)]);
		expect(labels(block(nothing.view))).toEqual(["Go back to version 2"]);
		const first = await page([releasesOf([shop({ site: null, live: null, back: null })], true, true)]);
		expect(labels(block(first.view))).toEqual(["Put the first version live", "Not yet"]);
	});

	it("opens a blank tab within the press, cuts its way back at once, then sends it to the one-time link, once", async () => {
		const { open, opened } = tabs();
		const answer = deferred<SitePreviewAnswer>();
		const { view, client } = await page([offered()], { openPreview: () => answer.promise });
		const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
		const look = buttons(block(view)).find((item) => item.textContent === "Look first")!;
		look.click();
		look.click();
		// Within the press, before the call answers: a blank tab, with no way back to this window.
		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(opened[0]?.opener).toBeNull();
		await settle();
		expect(client.openPreview).toHaveBeenCalledOnce();
		expect(client.openPreview).toHaveBeenCalledWith(
			"qorpera",
			"wristband-shop",
			{ change: 17, slug: "wristband-shop" },
			expect.any(AbortSignal),
		);
		expect(buttons(block(view)).map((item) => [item.textContent, item.disabled])).toEqual([
			["Go back to version 2", true],
			["Opening…", true],
			["Put it live", true],
			["Not yet", true],
		]);
		answer.resolve({ state: "open", url: NEXT });
		await settle();
		const tab = opened[0]!;
		expect(tab.location.replace).toHaveBeenCalledOnce();
		expect(tab.location.replace).toHaveBeenCalledWith(NEXT);
		expect(tab.openerWhenSent).toBeNull();
		expect(tab.close).not.toHaveBeenCalled();
		expect(labels(actions(view))).toEqual(["Look first", "Put it live", "Not yet"]);
		expect(block(view).querySelector(".service-outcome")).toBeNull();
		expect(client.list).toHaveBeenCalledOnce();
		// The ticket went to that one tab and nowhere else: not the page, not storage, not a line in the console.
		expect(document.documentElement.outerHTML).not.toContain(TICKET);
		expect(JSON.stringify({ ...localStorage })).not.toContain(TICKET);
		expect(JSON.stringify({ ...sessionStorage })).not.toContain(TICKET);
		for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(TICKET);
	});

	it.each([
		["the version went live or is no longer the one ready (moved)", async () => ({ state: "moved" }) as const],
		["Qorpera took the site down (gone)", async () => ({ state: "gone" }) as const],
		["sites have no addresses of their own now (off)", async () => ({ state: "off" }) as const],
		["no answer came", lost],
		["a refusal came", () => Promise.reject(new CloudRpcError("x", { message: "", code: "55P03" }, 500))],
	])("closes the tab when %s, and never sends it anywhere", async (_why, answer) => {
		const { opened } = tabs();
		const { view } = await page([offered(), releasesOf([shop()])], { openPreview: answer });
		press(block(view), "Look first");
		await settle();
		expect(opened[0]?.close).toHaveBeenCalledOnce();
		expect(opened[0]?.location.replace).not.toHaveBeenCalled();
	});

	it("says what changed when the version is no longer the one ready, and reads the page again", async () => {
		tabs();
		const newer = shop({ ready: { ...shop().ready!, change: 18, token: OTHER_TOKEN } });
		const { view, client } = await page([offered(), releasesOf([newer], true, true)], {
			openPreview: async () => ({ state: "moved" }),
		});
		press(block(view), "Look first");
		await settle();
		expect(block(view).querySelector("h3")?.previousElementSibling?.textContent).toBe(
			"Something changed while you looked. Here is what is ready now.",
		);
		expect(client.list).toHaveBeenCalledTimes(2);
		press(block(view), "Look first");
		await settle();
		expect(client.openPreview).toHaveBeenLastCalledWith(
			"qorpera",
			"wristband-shop",
			{ change: 18, slug: "wristband-shop" },
			expect.any(AbortSignal),
		);
	});

	it.each([
		[
			"Qorpera took the site down",
			async (): Promise<SitePreviewAnswer> => ({ state: "gone" }),
			"Qorpera took this site down, so it can't be opened. See why in Sites.",
			1,
		],
		["no answer came", lost, "The next version could not be opened: Qorpera could not be reached. Try again.", 1],
		[
			"a gateway's page came",
			() =>
				Promise.reject(
					new CloudRpcError("x", { message: "<html><body><h1>504 Gateway Time-out</h1></body></html>" }, 504),
				),
			"The next version could not be opened: Qorpera could not be reached. Try again.",
			1,
		],
		[
			"Qorpera was busy",
			() => Promise.reject(new CloudRpcError("x", { message: "lock timeout", code: "55P03" }, 500)),
			"The next version could not be opened. Try again.",
			1,
		],
		[
			"the request was refused as malformed",
			() => Promise.reject(new CloudRpcError("x", { message: "Look first request is invalid", code: "22023" }, 400)),
			"The next version could not be opened. Try again.",
			1,
		],
		[
			"the answer was not as expected",
			() => Promise.reject(new CloudShapeError("look first link")),
			"The next version could not be opened. Try again.",
			1,
		],
		[
			"the member is no longer an owner or admin",
			() => Promise.reject(new CloudRpcError("x", { message: "Releases unavailable", code: "42501" }, 403)),
			"Only founders and admins can look at a version before it goes live.",
			2,
		],
	])("says in its own words when %s", async (_why, answer, line, reads) => {
		tabs();
		const { view, client } = await page([offered()], { openPreview: answer });
		press(block(view), "Look first");
		await settle();
		expect(lookLine(view)).toBe(line);
		expect(client.list).toHaveBeenCalledTimes(reads);
		plain(block(view));
		expect(text(block(view))).not.toMatch(/42501|55P03|22023|Gateway|invalid|unavailable/);
		// Another press may try again: the button is there and on.
		expect(buttons(actions(view)).find((item) => item.textContent === "Look first")?.disabled).toBe(false);
	});

	it("asks for no link when the browser stopped the tab, and says so", async () => {
		const { open } = tabs(true);
		const { view, client } = await page([offered()]);
		press(block(view), "Look first");
		await settle();
		expect(open).toHaveBeenCalledOnce();
		expect(client.openPreview).not.toHaveBeenCalled();
		expect(lookLine(view)).toBe("The next version could not be opened. Try again.");
	});

	it("takes the button away when sites have no addresses of their own now, and reads the page again", async () => {
		tabs();
		const { view, client } = await page([offered(), releasesOf([shop()])], {
			openPreview: async () => ({ state: "off" }),
		});
		press(block(view), "Look first");
		await settle();
		expect(labels(actions(view))).toEqual(["Put it live", "Not yet"]);
		expect(block(view).querySelector(".service-outcome")).toBeNull();
		expect(client.list).toHaveBeenCalledTimes(2);
		// Until a read says otherwise, the press's answer stands, even over a read that still offers it.
		const stale = await page([offered(), offered()], { openPreview: async () => ({ state: "off" }) });
		const answered = deferred<CodeReleases>();
		stale.client.list.mockImplementationOnce(() => answered.promise);
		press(block(stale.view), "Look first");
		await settle();
		expect(labels(actions(stale.view))).toEqual(["Put it live", "Not yet"]);
		answered.resolve(offered());
		await settle();
		expect(labels(actions(stale.view))).toEqual(["Look first", "Put it live", "Not yet"]);
	});

	it("keeps its line through the read the window makes coming back from the closed tab, and drops it with the next", async () => {
		tabs();
		const { view, client } = await page([offered()], { openPreview: async () => ({ state: "gone" }) });
		press(block(view), "Look first");
		await settle();
		const line = "Qorpera took this site down, so it can't be opened. See why in Sites.";
		expect(lookLine(view)).toBe(line);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(lookLine(view)).toBe(line);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(lookLine(view)).toBeUndefined();
		// A page that moved: its own read, then the window's, keep the line; the next drops it.
		const moved = await page([offered()], { openPreview: async () => ({ state: "moved" }) });
		press(block(moved.view), "Look first");
		await settle();
		const said = () => [...block(moved.view).querySelectorAll(".service-outcome")].map((item) => item.textContent);
		expect(said()).toEqual(["Something changed while you looked. Here is what is ready now."]);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(moved.client.list).toHaveBeenCalledTimes(3);
		expect(said()).toEqual(["Something changed while you looked. Here is what is ready now."]);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(said()).toEqual([]);
	});

	it("closes the tab and sends it nowhere when the page is left while the call is out", async () => {
		const { opened } = tabs();
		const answer = deferred<SitePreviewAnswer>();
		const { view } = await page([offered()], {
			openPreview: () => answer.promise,
		});
		press(block(view), "Look first");
		await settle();
		view.dispose();
		answer.resolve({ state: "open", url: NEXT });
		await settle();
		expect(opened[0]?.close).toHaveBeenCalledOnce();
		expect(opened[0]?.location.replace).not.toHaveBeenCalled();
	});

	it("is in Danish", async () => {
		setLanguagePreference("da");
		tabs();
		const { view } = await page([offered()], { openPreview: async () => ({ state: "gone" }) });
		expect(labels(actions(view))).toEqual(["Se den først", "Sæt live", "Ikke endnu"]);
		press(block(view), "Se den først");
		await settle();
		expect(lookLine(view)).toBe(
			"Qorpera har taget hjemmesiden ned, så den kan ikke åbnes. Se hvorfor under Hjemmesider.",
		);
		const words: [() => Promise<SitePreviewAnswer>, string][] = [
			[lost, "Den næste version kunne ikke åbnes: Qorpera kunne ikke nås. Prøv igen."],
			[
				() => Promise.reject(new CloudRpcError("x", { message: "", code: "55P03" }, 500)),
				"Den næste version kunne ikke åbnes. Prøv igen.",
			],
			[
				() => Promise.reject(new CloudRpcError("x", { message: "", code: "42501" }, 403)),
				"Kun stiftere og administratorer kan se en version, før den går live.",
			],
		];
		for (const [answer, line] of words) {
			const each = await page([offered()], { openPreview: answer });
			press(block(each.view), "Se den først");
			await settle();
			expect(lookLine(each.view)).toBe(line);
		}
		const busy = deferred<SitePreviewAnswer>();
		const working = await page([offered()], { openPreview: () => busy.promise });
		press(block(working.view), "Se den først");
		await settle();
		expect(labels(actions(working.view))).toContain("Åbner…");
	});
});

describe("What's new: Look first's link and a refused write (step 5.1)", () => {
	it("takes as Look first's link exactly the next hosts of the one host list (SQL test 1252), each for its own site", () => {
		const answer = (url: string) => ({ schema: "qorpera.site-preview/v1", state: "open", url });
		const list = oneHostList();
		const slugs = [...new Set(list.map((entry) => entry.slug).filter(Boolean))];
		for (const { host, slug, scope, verdict } of list) {
			// A name the rule refuses (verdict name) has no site, so the kernel opens no Look first for it.
			if (verdict === "name") continue;
			const url = `https://${host}/.qorpera/enter?t=${TICKET}`;
			for (const drawn of slugs) {
				const label = `${url} for ${drawn}`;
				if (verdict === "taken" && scope === "next" && drawn === slug)
					expect(parseSitePreviewAnswer(answer(url), drawn), label).toEqual({ state: "open", url });
				else expect(() => parseSitePreviewAnswer(answer(url), drawn), label).toThrow(CloudShapeError);
			}
		}
	});

	it("reads Look first's answer: exactly the site's next host with a one-time ticket, nothing else", () => {
		const answer = (extra: Record<string, unknown>) => ({ schema: "qorpera.site-preview/v1", ...extra });
		expect(parseSitePreviewAnswer(answer({ state: "open", url: NEXT }), "wristband-shop")).toEqual({
			state: "open",
			url: NEXT,
		});
		for (const state of ["moved", "gone", "off"] as const)
			expect(parseSitePreviewAnswer(answer({ state, url: NEXT }), "wristband-shop")).toEqual({ state });
		// One host rule: `shop-next--next` is site shop-next's next host.
		const shopNext = `https://shop-next--next.qorpera.com/.qorpera/enter?t=${TICKET}`;
		expect(parseSitePreviewAnswer(answer({ state: "open", url: shopNext }), "shop-next")).toEqual({
			state: "open",
			url: shopNext,
		});
		const enter = `/.qorpera/enter?t=${TICKET}`;
		for (const url of [
			// Only the site's own next host, over https, with no sign-in or port.
			`https://other-shop--next.qorpera.com${enter}`,
			`https://wristband-shop.qorpera.com${enter}`,
			`https://wristband-shop-next.qorpera.com${enter}`,
			`https://wristband-shop--next--next.qorpera.com${enter}`,
			`https://wristband-shop-preview.qorpera.com${enter}`,
			`http://wristband-shop--next.qorpera.com${enter}`,
			`https://user:pass@wristband-shop--next.qorpera.com${enter}`,
			`https://wristband-shop--next.qorpera.com:8443${enter}`,
			`https://wristband-shop--next.qorpera.com:443${enter}`,
			`https://WRISTBAND-SHOP--next.qorpera.com${enter}`,
			`https://wristband-shop--next.qorpera.com.${enter}`,
			`https://x.wristband-shop--next.qorpera.com${enter}`,
			`https://wristband-shop--next.qorpera.org${enter}`,
			`https://wristband-shop--next.qorpera.com.example.org${enter}`,
			`https://wristband-shop--nextxqorpera.com${enter}`,
			// Only the enter path, and only one well-made ticket.
			`https://wristband-shop--next.qorpera.com/${`?t=${TICKET}`}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/unlock?t=${TICKET}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter/?t=${TICKET}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET.slice(1)}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET}A`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET.slice(1)}=`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET.slice(1)}+`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?t=${TICKET}&next=x`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?a=1?t=${TICKET}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter?x=${TICKET}`,
			`https://wristband-shop--next.qorpera.com/.qorpera/enter`,
			`${NEXT}#x`,
			`${NEXT}#`,
			` ${NEXT}`,
			"javascript:alert(1)",
			"",
			17,
			null,
		]) {
			const parse = () => parseSitePreviewAnswer(answer({ state: "open", url }), "wristband-shop");
			expect(parse, String(url)).toThrow(CloudShapeError);
		}
		// A link with the site's name but in another schema or state is no answer either.
		expect(() =>
			parseSitePreviewAnswer({ schema: "qorpera.site-preview/v2", state: "open", url: NEXT }, "wristband-shop"),
		).toThrow(CloudShapeError);
		expect(() => parseSitePreviewAnswer(answer({ state: "maybe" }), "wristband-shop")).toThrow(CloudShapeError);
		// An error never carries the link.
		try {
			parseSitePreviewAnswer(answer({ state: "open", url: `${NEXT}#x` }), "wristband-shop");
		} catch (error) {
			expect(String(error)).not.toContain(TICKET);
		}
	});

	it("reads a write refused for a site Qorpera took down, and says nothing changed", async () => {
		expect(
			parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "refused", code: "SITE_TAKEN_DOWN" }),
		).toEqual({ state: "refused", code: "SITE_TAKEN_DOWN" });
		expect(() => parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "refused" })).toThrow();
		expect(() => parseCodeReleaseAnswer({ schema: "qorpera.code-release/v1", state: "refused", code: "" })).toThrow();
		const down = await page([releasesOf([shop()])], {
			putLive: async () => ({ state: "refused", code: "SITE_TAKEN_DOWN" }),
		});
		press(block(down.view), "Put it live");
		await settle();
		expect(block(down.view).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent).toBe(
			"It did not go live: Qorpera took this site down. Nothing changed.",
		);
		expect(text(block(down.view))).not.toContain("SITE_TAKEN_DOWN");
		expect(down.client.list).toHaveBeenCalledTimes(2);
		const back = await page([releasesOf([shop()])], {
			goBack: async () => ({ state: "refused", code: "SITE_TAKEN_DOWN" }),
		});
		press(block(back.view), "Go back to version 2");
		await settle();
		press(dialog(), "Go back");
		await settle();
		expect(block(back.view).querySelector(".whats-new-live + .service-outcome.is-error")?.textContent).toBe(
			"It did not go back: Qorpera took this site down. Nothing changed.",
		);
		// A reason this web does not know yet still says nothing changed.
		const other = await page([releasesOf([shop()])], {
			putLive: async () => ({ state: "refused", code: "SOMETHING_NEW" }),
		});
		press(block(other.view), "Put it live");
		await settle();
		expect(block(other.view).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent).toBe(
			"It did not go live: something went wrong on Qorpera's side. Nothing changed.",
		);
		setLanguagePreference("da");
		const danish = await page([releasesOf([shop()])], {
			putLive: async () => ({ state: "refused", code: "SITE_TAKEN_DOWN" }),
		});
		press(block(danish.view), "Sæt live");
		await settle();
		expect(block(danish.view).querySelector(".whats-new-actions + .service-outcome.is-error")?.textContent).toBe(
			"Det blev ikke sat live: Qorpera har taget hjemmesiden ned. Intet er ændret.",
		);
	});
});

describe("What's new: a site Qorpera took down (step 5.1)", () => {
	const DOWN = "Qorpera took this site down, so it can't be opened. See why in Sites.";
	const openLink = (view: WhatsNewView) =>
		[...block(view).querySelectorAll<HTMLAnchorElement>("a.site-button")].find((link) =>
			link.textContent?.includes("Open the site"),
		);

	it("offers no link to a site Qorpera took down, and says so to every member", async () => {
		for (const role of ["owner", "contributor"] as const) {
			const takenDown = vi.fn(async () => new Set(["wristband-shop"]));
			const { view } = await page([releasesOf([shop()], role === "owner")], { role, takenDown });
			expect(takenDown).toHaveBeenCalledTimes(1);
			expect(openLink(view), role).toBeUndefined();
			expect(block(view).querySelector('a[href*="sites.qorpera.com"]'), role).toBeNull();
			expect(text(block(view)), role).toContain(DOWN);
			// No password to share either: the Sites page has none to show for it.
			expect(text(block(view)), role).not.toContain("The password is in Sites.");
			// What is live and ready is still said; nothing the kernel would refuse is offered (review of #1774, round 3).
			expect(text(block(view)), role).toContain("Live now");
			expect(text(block(view)), role).toContain("6 changes are ready");
			if (role === "owner") expect(labels(block(view))).toEqual(["Not yet"]);
			plain(block(view));
			view.dispose();
		}
	});

	it("offers an owner no Look first, Put it live or Go back for a site taken down, only Not yet (review of #1774, round 3)", async () => {
		const read = () => releasesOf([shop()], true, true);
		// Up: all four, as before.
		const { view: up } = await page([read()], { takenDown: async () => new Set<string>() });
		expect(labels(block(up))).toEqual(["Go back to version 2", "Look first", "Put it live", "Not yet"]);
		up.dispose();
		// Taken down: the line says why, and only Not yet is left; a site never live has no Put the first version live.
		const { view, client } = await page([read()], { takenDown: async () => new Set(["wristband-shop"]) });
		expect(labels(block(view))).toEqual(["Not yet"]);
		expect(text(block(view))).toContain(DOWN);
		expect(client.openPreview).not.toHaveBeenCalled();
		view.dispose();
		const { view: first } = await page([releasesOf([shop({ live: null, back: null })], true, true)], {
			takenDown: async () => new Set(["wristband-shop"]),
		});
		expect(labels(block(first))).toEqual(["Not yet"]);
		expect(text(block(first))).toContain(DOWN);
		first.dispose();
		// In Danish too.
		setLanguagePreference("da");
		try {
			const { view: da } = await page([read()], { takenDown: async () => new Set(["wristband-shop"]) });
			expect(labels(block(da))).toEqual(["Ikke endnu"]);
			expect(text(block(da))).toContain(
				"Qorpera har taget hjemmesiden ned, så den kan ikke åbnes. Se hvorfor under Hjemmesider.",
			);
			da.dispose();
		} finally {
			setLanguagePreference("system");
		}
	});

	it("draws the page as before without the read, with a read that fails, and with no site taken down", async () => {
		for (const takenDown of [
			undefined,
			async () => {
				throw new CloudRpcError("x", { message: "Could not find the function", code: "PGRST202" }, 404);
			},
			async () => new Set<string>(),
			async () => new Set(["another-shop"]),
		]) {
			const { view } = await page([releasesOf([shop()])], takenDown ? { takenDown } : {});
			expect(openLink(view)?.href).toBe("https://sites.qorpera.com/wristband-shop/");
			expect(text(block(view))).not.toContain(DOWN);
			expect(text(block(view))).not.toMatch(/password/i);
			view.dispose();
		}
	});

	it("keeps what the last read said when one fails, and shows the link again once the site is back", async () => {
		const answers: (ReadonlySet<string> | Error)[] = [new Set(["wristband-shop"]), new Error("no answer"), new Set()];
		const takenDown = vi.fn(async () => {
			const next = answers.shift();
			if (next instanceof Error) throw next;
			return next ?? new Set<string>();
		});
		const { view } = await page([releasesOf([shop()])], { takenDown });
		expect(openLink(view)).toBeUndefined();
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(takenDown).toHaveBeenCalledTimes(2);
		expect(openLink(view)).toBeUndefined();
		expect(text(block(view))).toContain(DOWN);
		window.dispatchEvent(new Event("focus"));
		await settle();
		expect(takenDown).toHaveBeenCalledTimes(3);
		expect(openLink(view)?.href).toBe("https://sites.qorpera.com/wristband-shop/");
		expect(text(block(view))).not.toContain(DOWN);
	});

	it("says so for a site that was never live too, whose Look first answers so (review of #1774, F4)", async () => {
		const { view } = await page([releasesOf([shop({ live: null, back: null })])], {
			takenDown: async () => new Set(["wristband-shop"]),
		});
		expect(text(block(view))).toContain("Not live yet");
		expect(text(block(view))).toContain(DOWN);
		expect(openLink(view)).toBeUndefined();
		view.dispose();
		// Not taken down: nothing said.
		const { view: up } = await page([releasesOf([shop({ live: null, back: null })])], {
			takenDown: async () => new Set<string>(),
		});
		expect(text(block(up))).not.toContain(DOWN);
	});

	it("says it in Danish", async () => {
		setLanguagePreference("da");
		const { view } = await page([releasesOf([shop()])], { takenDown: async () => new Set(["wristband-shop"]) });
		expect(text(block(view))).toContain(
			"Qorpera har taget hjemmesiden ned, så den kan ikke åbnes. Se hvorfor under Hjemmesider.",
		);
		expect(openLink(view)).toBeUndefined();
	});

	it("shares one IntersectionObserver across release tiles and disconnects it on dispose", async () => {
		let created = 0;
		const observed: Element[] = [];
		const unobserved: Element[] = [];
		let disconnected = 0;
		let cb: IntersectionObserverCallback | undefined;
		class FakeIntersectionObserver {
			constructor(callback: IntersectionObserverCallback) {
				created += 1;
				cb = callback;
			}
			observe(el: Element) {
				observed.push(el);
			}
			unobserve(el: Element) {
				unobserved.push(el);
			}
			disconnect() {
				disconnected += 1;
			}
		}
		vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
		try {
			const { view, image } = await page([releasesOf([shop()])]);
			expect(created).toBe(1);
			expect(observed).toHaveLength(3);
			expect(image).not.toHaveBeenCalled();

			cb!([{ target: observed[0]!, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
			await settle();
			expect(unobserved).toEqual([observed[0]]);
			expect(image).toHaveBeenCalledTimes(1);

			view.dispose();
			expect(disconnected).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("unobserves dropped release tile picture boxes when a refresh replaces ready changes", async () => {
		const observed: Element[] = [];
		const unobserved: Element[] = [];
		class FakeIntersectionObserver {
			observe(el: Element) {
				observed.push(el);
			}
			unobserve(el: Element) {
				unobserved.push(el);
			}
			disconnect() {}
		}
		vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
		try {
			const { view } = await page([releasesOf([shop()]), releasesOf([shop({ ready: null })])]);
			expect(observed).toHaveLength(3);
			expect(unobserved).toHaveLength(0);

			window.dispatchEvent(new Event("focus"));
			await settle();
			expect(unobserved).toEqual(observed);
			view.dispose();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
