import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Cloud } from "../src/cloud/client.ts";
import {
	type CompanySite,
	createWebSites,
	parseCompanySite,
	parseCompanySiteAccess,
	parseCompanySitePassword,
} from "../src/cloud/sites.ts";
import { id, oneHostList, timestamp } from "./fixtures.ts";

const ORIGIN = "https://sites.qorpera.com";

const shop: CompanySite = {
	id: id(81),
	slug: "wristband-shop",
	title: "Wristband shop",
	kind: "files",
	url: `${ORIGIN}/wristband-shop/`,
	state: "live",
	source: "product/webshop-preview.html",
	files: 12,
	bytes: 2048,
	publishedAt: timestamp,
	publishedBy: { agentId: id(90), name: "Co-Founder" },
	createdAt: timestamp,
	passwordChangedAt: timestamp,
	machine: null,
	port: null,
};
// The first upload has not finished: no agent or time yet, and no title.
const draft: CompanySite = {
	...shop,
	id: id(82),
	slug: "launch-page",
	title: null,
	url: `${ORIGIN}/launch-page/`,
	state: "publishing",
	source: "marketing/launch",
	files: 1,
	bytes: 512,
	publishedAt: null,
	publishedBy: null,
};
// An app link (v195): one port of an always-on machine, at its own host.
const app: CompanySite = {
	...shop,
	id: id(83),
	slug: "saml-shop",
	title: "SAML shop",
	kind: "app",
	url: "https://saml-shop-preview.qorpera.com/",
	source: "shop-server",
	files: 0,
	bytes: 0,
	machine: "shop-server",
	port: 3000,
};
// A project's site made from its code (step 4): the plain row, its source the project's place under code/, no agent.
const gift: CompanySite = {
	...shop,
	id: id(85),
	slug: "gift-message",
	title: "Gift message",
	url: `${ORIGIN}/gift-message/`,
	source: "code/qorpera/gift-message",
	publishedBy: null,
};

describe("sites client", () => {
	const row = (extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.company-site/v1",
		id: shop.id,
		slug: shop.slug,
		title: shop.title,
		kind: "files",
		machine: null,
		port: null,
		url: shop.url,
		state: "live",
		source: shop.source,
		files: shop.files,
		bytes: shop.bytes,
		publishedAt: timestamp,
		publishedBy: { agentId: id(90), name: "Co-Founder" },
		createdAt: timestamp,
		passwordChangedAt: timestamp,
		...extra,
	});
	const appRow = (extra: Record<string, unknown> = {}) =>
		row({
			id: app.id,
			slug: app.slug,
			title: app.title,
			kind: "app",
			machine: app.machine,
			port: app.port,
			url: app.url,
			source: app.source,
			files: 0,
			bytes: 0,
			...extra,
		});
	function cloudWith(rpc: (name: string, args: Record<string, unknown>) => unknown) {
		return {
			rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
		} as unknown as Cloud & { rpc: ReturnType<typeof vi.fn> };
	}

	it("reads a site row exactly, and refuses any other shape", () => {
		expect(parseCompanySite(row())).toEqual(shop);
		expect(
			parseCompanySite(row({ title: null, state: "publishing", publishedAt: null, publishedBy: null })),
		).toMatchObject({ title: null, state: "publishing", publishedAt: null, publishedBy: null });
		// A project's site made from its code (step 4) is the same row: its source is the project's place, no agent.
		expect(parseCompanySite(row({ source: "code/qorpera/gift-message", publishedBy: null }))).toMatchObject({
			source: "code/qorpera/gift-message",
			publishedBy: null,
		});
		for (const bad of [
			row({ schema: "qorpera.company-site/v2" }),
			row({ extra: true }),
			row({ id: "site" }),
			row({ slug: "Wristband" }),
			row({ slug: "a" }),
			// The link is the site's own, over https, with nothing else in it.
			row({ url: "http://sites.qorpera.com/wristband-shop/" }),
			row({ url: `${ORIGIN}/other-shop/` }),
			row({ url: `${ORIGIN}/wristband-shop/?next=x` }),
			row({ url: `${ORIGIN}/wristband-shop/#x` }),
			row({ url: "https://user:pass@sites.qorpera.com/wristband-shop/" }),
			row({ url: "javascript:alert(1)//wristband-shop/" }),
			row({ title: "" }),
			row({ state: "offline" }),
			row({ files: -1 }),
			row({ bytes: 1.5 }),
			row({ publishedBy: { agentId: "x", name: "Co-Founder" } }),
			row({ publishedBy: { agentId: id(90), name: "Co-Founder", extra: 1 } }),
			row({ password: "k7mq-x2pa-9fhd" }),
			// A website names no machine or port, and its link is on the sites host.
			row({ kind: "page" }),
			row({ kind: undefined }),
			row({ machine: "shop-server" }),
			row({ port: 3000 }),
			// An app link names its port, and its link is its own host with nothing after it.
			appRow({ port: null }),
			appRow({ port: 0 }),
			appRow({ port: 65536 }),
			appRow({ port: "3000" }),
			appRow({ machine: "Shop Server" }),
			appRow({ url: `${ORIGIN}/saml-shop/` }),
			appRow({ url: "https://other-shop-preview.qorpera.com/" }),
			appRow({ url: "https://saml-shopper-preview.qorpera.com/" }),
			appRow({ url: "https://saml-shop-preview.qorpera.com/admin" }),
			appRow({ url: "http://saml-shop-preview.qorpera.com/" }),
			// A website is live or publishing; an app link is live or off.
			row({ state: "off" }),
			appRow({ state: "publishing" }),
			null,
			[],
		])
			expect(() => parseCompanySite(bad)).toThrow("Invalid site.");
		expect(parseCompanySite(appRow())).toEqual(app);
		expect(parseCompanySite(appRow({ state: "off", machine: null }))).toMatchObject({
			kind: "app",
			state: "off",
			machine: null,
			port: 3000,
		});
		expect(
			parseCompanySitePassword(
				{ schema: "qorpera.company-site-password/v1", siteId: shop.id, password: "p", changedAt: timestamp },
				shop.id,
			),
		).toEqual({ siteId: shop.id, password: "p", changedAt: timestamp });
		for (const bad of [
			{ schema: "qorpera.company-site-password/v1", siteId: draft.id, password: "p", changedAt: timestamp },
			{ schema: "qorpera.company-site-password/v1", siteId: shop.id, password: "", changedAt: timestamp },
			{ schema: "qorpera.company-site-password/v1", siteId: shop.id, password: "p", changedAt: timestamp, x: 1 },
		])
			expect(() => parseCompanySitePassword(bad, shop.id)).toThrow("Invalid site password.");
	});

	it("reads a website at an address of its own (step 5.1): exactly https://<its name>.qorpera.com/, nothing else", () => {
		const own = "https://wristband-shop.qorpera.com/";
		expect(parseCompanySite(row({ url: own }))).toEqual({ ...shop, url: own });
		expect(
			parseCompanySite(row({ url: own, title: null, state: "publishing", publishedAt: null, publishedBy: null })),
		).toMatchObject({ url: own, state: "publishing" });
		// The longest name a site may have; its look before going live (6 more) is 54 characters, inside DNS's 63.
		const long = `a${"b".repeat(46)}c`;
		expect(parseCompanySite(row({ slug: long, url: `https://${long}.qorpera.com/` })).url).toBe(
			`https://${long}.qorpera.com/`,
		);
		expect(parseCompanySite(row({ slug: "9-lives-2026", url: "https://9-lives-2026.qorpera.com/" })).slug).toBe(
			"9-lives-2026",
		);
		for (const url of [
			// Over https, with no sign-in, port, path, query or fragment, not even an empty one.
			"http://wristband-shop.qorpera.com/",
			"https://user:pass@wristband-shop.qorpera.com/",
			"https://user@wristband-shop.qorpera.com/",
			"https://wristband-shop.qorpera.com:8443/",
			"https://wristband-shop.qorpera.com:443/",
			"https://wristband-shop.qorpera.com",
			"https://wristband-shop.qorpera.com//",
			"https://wristband-shop.qorpera.com/index.html",
			"https://wristband-shop.qorpera.com/wristband-shop",
			"https://wristband-shop.qorpera.com/?",
			"https://wristband-shop.qorpera.com/?next=x",
			"https://wristband-shop.qorpera.com/#",
			"https://wristband-shop.qorpera.com/#x",
			// Its own name, as the kernel writes it: never another site's, its look before going live, or an app link's.
			"https://other-shop.qorpera.com/",
			"https://wristband.qorpera.com/",
			"https://wristband-shop--next.qorpera.com/",
			"https://wristband-shop-preview.qorpera.com/",
			"https://Wristband-Shop.qorpera.com/",
			// One label before qorpera.com itself, and no other domain.
			"https://wristband-shop.qorpera.com./",
			"https://x.wristband-shop.qorpera.com/",
			"https://wristband-shop.sites.qorpera.com/",
			"https://wristband-shop.qorpera.com.example.org/",
			"https://wristband-shopxqorpera.com/",
			"https://wristband-shop.qorperaxcom/",
			"https://wristband-shop.qorpera.org/",
			"https://wristband-shop.example.com/",
			"https://qorpera.com/",
		])
			expect(() => parseCompanySite(row({ url })), url).toThrow("Invalid site.");
		// The longest names' look before going live is no address either (the host regex's `--next` part).
		expect(() => parseCompanySite(row({ slug: long, url: `https://${long}--next.qorpera.com/` }))).toThrow(
			"Invalid site.",
		);
		// A name with `--` (which the kernel refuses from step 5.1) has no host: shop--next.qorpera.com is site shop's look
		// before going live. Its link on the sites host reads as today.
		expect(() => parseCompanySite(row({ slug: "shop--next", url: "https://shop--next.qorpera.com/" }))).toThrow(
			"Invalid site.",
		);
		expect(parseCompanySite(row({ slug: "shop--next", url: `${ORIGIN}/shop--next/` })).url).toBe(
			`${ORIGIN}/shop--next/`,
		);
	});

	it("reads one host rule with SQL and site-serve: `--next` ends a name's look before going live, `-next` is a name", () => {
		const site = (slug: string, url: string) => parseCompanySite(row({ slug, url }));
		// The shortest name a site may have, and the longest, each at its own host.
		expect(site("abc", "https://abc.qorpera.com/").url).toBe("https://abc.qorpera.com/");
		const long = "x".repeat(48);
		expect(site(long, `https://${long}.qorpera.com/`).url).toBe(`https://${long}.qorpera.com/`);
		expect(() => site(long, `https://${long}--next.qorpera.com/`)).toThrow("Invalid site.");
		// shop--next.qorpera.com is site shop's next host: neither site shop's address nor a site's of its own.
		expect(site("shop", "https://shop.qorpera.com/").url).toBe("https://shop.qorpera.com/");
		expect(() => site("shop", "https://shop--next.qorpera.com/")).toThrow("Invalid site.");
		expect(() => site("shop--next", "https://shop--next.qorpera.com/")).toThrow("Invalid site.");
		// A label ending in a single `-next` is a plain name: its own site's address, and no other's.
		expect(site("shop-next", "https://shop-next.qorpera.com/").url).toBe("https://shop-next.qorpera.com/");
		expect(() => site("shop", "https://shop-next.qorpera.com/")).toThrow("Invalid site.");
		// Upper case anywhere in the host is not the link the kernel writes.
		for (const url of ["https://SHOP.qorpera.com/", "https://Shop.qorpera.com/", "https://shop.QORPERA.com/"])
			expect(() => site("shop", url), url).toThrow("Invalid site.");
	});

	it("reads the access answer as the cloud gives it, a time as PostgreSQL writes it in JSON", async () => {
		const at = "2026-11-13T19:00:00.123456+00:00";
		const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
			schema: "qorpera.company-site-access/v1",
			hosts: true,
			sites: [
				{
					siteId: shop.id,
					slug: shop.slug,
					title: shop.title,
					kind: "files",
					source: shop.source,
					takenDown: { at, reason: "Spam" },
				},
				{ siteId: draft.id, slug: draft.slug, title: null, kind: "files", source: draft.source, takenDown: null },
			],
		}));
		const access = await createWebSites({ rpc } as unknown as Cloud, { profileId: id(10) }).access();
		expect(rpc.mock.calls).toEqual([
			["qorpera_company_site_access", { p_profile_id: id(10) }, expect.any(AbortSignal)],
		]);
		expect([...access.takenDown]).toEqual([[shop.id, { at, reason: "Spam" }]]);
		// Each site taken down by its name too (the review of #1774, F4); one not taken down is not named.
		expect([...access.named]).toEqual([
			[shop.id, { slug: shop.slug, title: shop.title, kind: "files", source: shop.source }],
		]);
	});

	it("takes as a website's link exactly the own hosts of the one host list (SQL test 1252), each for its own site", () => {
		const list = oneHostList();
		const slugs = [...new Set(list.map((entry) => entry.slug).filter(Boolean))];
		for (const { host, slug, scope, verdict } of list) {
			// A name the rule refuses (verdict name) never reaches the web: the kernel makes no site of it, and migration
			// 20260930756000 refuses to run while one is stored. The parse reads the link's shape and the row's own slug.
			if (verdict === "name") continue;
			const url = `https://${host}/`;
			for (const named of slugs) {
				const label = `${url} for ${named}`;
				if (verdict === "taken" && scope === "site" && named === slug)
					expect(parseCompanySite(row({ slug: named, url })).url, label).toBe(url);
				else expect(() => parseCompanySite(row({ slug: named, url })), label).toThrow("Invalid site.");
			}
		}
	});

	it("reads today's answers exactly as before: websites on the sites host, app links at their own", async () => {
		const today = [
			row(),
			row({
				id: draft.id,
				slug: draft.slug,
				title: null,
				url: draft.url,
				state: "publishing",
				source: draft.source,
				files: draft.files,
				bytes: draft.bytes,
				publishedAt: null,
				publishedBy: null,
			}),
			appRow(),
		];
		const sites = createWebSites(
			cloudWith(() => structuredClone(today)),
			{ profileId: id(10) },
		);
		expect(await sites.list()).toEqual([shop, draft, app]);
	});

	it("reads websites at addresses of their own beside today's links; a look before going live fails the list", async () => {
		const own: CompanySite = { ...shop, url: "https://wristband-shop.qorpera.com/" };
		let answer: unknown[] = [
			row({ url: own.url }),
			row({
				id: gift.id,
				slug: gift.slug,
				title: gift.title,
				url: gift.url,
				source: gift.source,
				publishedBy: null,
			}),
			appRow(),
		];
		const sites = createWebSites(
			cloudWith(() => structuredClone(answer)),
			{ profileId: id(10) },
		);
		expect(await sites.list()).toEqual([own, gift, app]);
		// One row in any other form fails the whole list, as today.
		answer = [row({ url: "https://wristband-shop--next.qorpera.com/" }), appRow()];
		await expect(sites.list()).rejects.toThrow("Invalid site.");
	});

	it("keeps the marker step 5.1's hosts-on gate reads in the live web bundle: the own-host regex's text", () => {
		// The gate fetches the deployed bundle and looks for this text; the regex is what puts it there.
		expect(readFileSync(resolve("src/cloud/sites.ts"), "utf8")).toContain(
			String.raw`const SITE_HOST = /^([a-z0-9]+(?:-[a-z0-9]+)*)(--next)?\.qorpera\.com$/;`,
		);
	});

	it("lists the company's sites and reads a password", async () => {
		const password = {
			schema: "qorpera.company-site-password/v1",
			siteId: shop.id,
			password: "p",
			changedAt: timestamp,
		};
		const cloud = cloudWith((name) => (name === "qorpera_list_company_sites" ? [row()] : password));
		const sites = createWebSites(cloud, { profileId: id(10) });
		expect(await sites.list()).toEqual([shop]);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_list_company_sites", { p_profile_id: id(10) });
		expect(await sites.password(shop.id)).toEqual({ siteId: shop.id, password: "p", changedAt: timestamp });
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_company_site_password", { p_site_id: shop.id });
		cloud.rpc.mockClear();
		await expect(sites.password("not-a-site")).rejects.toThrow("Invalid site.");
		expect(cloud.rpc).not.toHaveBeenCalled();
		expect(Object.keys(sites).sort()).toEqual(["access", "list", "memberPass", "password"]);
	});

	it("reads which sites Qorpera took down (step 5.1), leniently, and asks for it with the company", async () => {
		const at = "2026-11-13T18:00:00.000Z";
		const value = {
			schema: "qorpera.company-site-access/v1",
			hosts: true,
			later: { public: true },
			sites: [
				{ siteId: shop.id, takenDown: { at, reason: "  Phishing.  ", by: "operator" }, public: false },
				{ siteId: draft.id, takenDown: null },
				{ siteId: app.id },
				{ siteId: gift.id, takenDown: { at, reason: "x".repeat(400) } },
			],
		};
		const read = parseCompanySiteAccess(value);
		expect([...read.takenDown]).toEqual([
			[shop.id, { at, reason: "Phishing." }],
			[gift.id, { at, reason: "x".repeat(300) }],
		]);
		for (const bad of [
			null,
			[],
			"x",
			{ ...value, schema: "qorpera.company-site-access/v2" },
			{ ...value, schema: undefined },
			{ ...value, sites: null },
			{ ...value, sites: { [shop.id]: { at, reason: "x" } } },
		])
			expect(() => parseCompanySiteAccess(bad), JSON.stringify(bad)).toThrow("Invalid site access.");
		// An entry not as expected says nothing of its site; the others still count.
		for (const entry of [
			{ siteId: shop.id, takenDown: { at, reason: "" } },
			{ siteId: shop.id, takenDown: { at, reason: " \n " } },
			{ siteId: shop.id, takenDown: { at, reason: 7 } },
			{ siteId: shop.id, takenDown: { reason: "x" } },
			{ siteId: shop.id, takenDown: { at: "soon", reason: "x" } },
			{ siteId: shop.id, takenDown: ["x"] },
			{ siteId: shop.id, takenDown: "x" },
			{ siteId: "site", takenDown: { at, reason: "x" } },
			{ siteId: 81, takenDown: { at, reason: "x" } },
			{ takenDown: { at, reason: "x" } },
			[shop.id],
			null,
		])
			expect(
				[...parseCompanySiteAccess({ ...value, sites: [entry, value.sites[3]] }).takenDown.keys()],
				JSON.stringify(entry),
			).toEqual([gift.id]);
		const cloud = cloudWith(() => value);
		expect([...(await createWebSites(cloud, { profileId: id(10) }).access()).takenDown.keys()]).toEqual([
			shop.id,
			gift.id,
		]);
		expect(cloud.rpc).toHaveBeenLastCalledWith(
			"qorpera_company_site_access",
			{ p_profile_id: id(10) },
			expect.any(AbortSignal),
		);
	});

	it("refuses a malformed answer and a malformed company", async () => {
		await expect(
			createWebSites(
				cloudWith(() => ({})),
				{ profileId: id(10) },
			).list(),
		).rejects.toThrow("Invalid sites.");
		expect(() =>
			createWebSites(
				cloudWith(() => []),
				{ profileId: "main" },
			),
		).toThrow("Invalid company for sites.");
	});
});
