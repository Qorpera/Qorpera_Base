// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SitesAccess, SitesView } from "../src/app/views/settings-sites.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CompanySite,
	type CompanySitePassword,
	createWebSites,
	parseCompanySite,
	parseCompanySitePassword,
	type WebSites,
} from "../src/cloud/sites.ts";
import { deferred, id, settle, timestamp } from "./fixtures.ts";

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

type SitesClientMock = Pick<WebSites, "list" | "password" | "setPassword" | "unpublish">;

const admin: SitesAccess = { canManage: () => true };

let view: SitesView | undefined;
afterEach(() => {
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	vi.restoreAllMocks();
});

function setup(sites: CompanySite[] = [], access: SitesAccess = admin, configure?: (client: SitesClientMock) => void) {
	const state = { sites: structuredClone(sites), password: "k7mq-x2pa-9fhd" };
	const answer = (siteId: string): CompanySitePassword => ({ siteId, password: state.password, changedAt: timestamp });
	const client: SitesClientMock = {
		list: vi.fn(async () => structuredClone(state.sites)),
		password: vi.fn(async (siteId: string) => answer(siteId)),
		setPassword: vi.fn(async (siteId: string, password: string | null) => {
			state.password = password ?? "n3wp-4ss-w0rd";
			return answer(siteId);
		}),
		unpublish: vi.fn(async (siteId: string) => {
			const before = state.sites.length;
			state.sites = state.sites.filter((site) => site.id !== siteId);
			return state.sites.length < before;
		}),
	};
	configure?.(client);
	view = new SitesView(client, new AbortController().signal, { access });
	document.body.append(view.el);
	return { client, state };
}

const cardOf = (siteId: string) => view?.el.querySelector<HTMLElement>(`[data-site="${siteId}"]`) ?? null;
const ids = () => [...view!.el.querySelectorAll<HTMLElement>("[data-site]")].map((card) => card.dataset.site);
const buttons = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const labels = (root: Element) => buttons(root).map((item) => item.textContent);
const press = (root: Element, label: string) =>
	buttons(root)
		.find((item) => item.textContent === label)!
		.click();
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;
const codes = (root: Element) => [...root.querySelectorAll("code")].map((code) => code.textContent);

describe("Settings → Sites", () => {
	it("lists each site with its link to open and copy, its state, who published it and where from", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		setup([shop, draft]);
		expect(view!.el.textContent).toContain("Checking…");
		await settle();
		expect(ids()).toEqual([shop.id, draft.id]);

		const card = cardOf(shop.id)!;
		expect(card.getAttribute("aria-label")).toBe("Wristband shop");
		expect(card.querySelector("strong")?.textContent).toBe("Wristband shop");
		expect(card.querySelector(".hook-state")?.textContent).toMatch(
			/^Live · Published .+ by Co-Founder · 12 files, 2\.0 KiB$/,
		);
		expect(card.textContent).toContain("From product/webshop-preview.html");
		const link = card.querySelector<HTMLAnchorElement>("code a")!;
		expect(link.href).toBe(shop.url);
		expect(link.textContent).toBe(shop.url);
		expect(link.target).toBe("_blank");
		expect(link.rel).toBe("noopener noreferrer");
		expect(labels(card)).toEqual(["Show password", "Change password", "Unpublish", "Copy"]);
		// No password is read until asked for.
		expect(codes(card)).toEqual([shop.url]);

		// A site still publishing goes by its name in the link.
		const publishing = cardOf(draft.id)!;
		expect(publishing.querySelector("strong")?.textContent).toBe("launch-page");
		expect(publishing.querySelector(".hook-state")?.textContent).toBe("Publishing… · 1 file, 512 B");

		press(card, "Copy");
		await settle();
		expect(writeText).toHaveBeenCalledWith(shop.url);
		expect(cardOf(shop.id)?.textContent).toContain("The link is copied.");
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`site-copy-link:${shop.id}`);

		writeText.mockRejectedValueOnce(new Error("denied"));
		press(cardOf(shop.id)!, "Copy");
		await settle();
		expect(cardOf(shop.id)?.textContent).toContain("The link could not be copied. Select it and copy it.");
	});

	it("shows an app link as an app on its machine and port, with its link, password and Unpublish", async () => {
		const { client } = setup([
			app,
			// Off: its machine was deleted.
			{ ...app, id: id(84), slug: "old-shop", title: null, state: "off", machine: null, port: 8080 },
		]);
		await settle();
		const card = cardOf(app.id)!;
		expect(card.querySelector("strong")?.textContent).toBe("SAML shop");
		expect(card.querySelector(".hook-state")?.textContent).toMatch(/^Live · Published .+ by Co-Founder$/);
		expect(card.textContent).toContain("App on machine shop-server, port 3000");
		expect(card.textContent).not.toContain("From ");
		expect(card.querySelector<HTMLAnchorElement>("code a")?.href).toBe("https://saml-shop-preview.qorpera.com/");
		expect(labels(card)).toEqual(["Show password", "Change password", "Unpublish", "Copy"]);
		expect(cardOf(id(84))?.querySelector(".hook-state")?.textContent).toMatch(/^Off · Published .+ by Co-Founder$/);
		expect(cardOf(id(84))?.textContent).toContain("App on port 8080 of a machine that was deleted");

		press(card, "Show password");
		await settle();
		expect(client.password).toHaveBeenCalledWith(app.id, expect.any(AbortSignal));
		expect(codes(cardOf(app.id)!)).toEqual([app.url, "k7mq-x2pa-9fhd"]);

		press(cardOf(app.id)!, "Unpublish");
		expect(dialog().textContent).toContain(
			"Take SAML shop offline? Its link stops working and its password is deleted. The app keeps running on its machine.",
		);
		press(dialog(), "Unpublish");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(app.id, expect.any(AbortSignal));
		expect(ids()).toEqual([id(84)]);
	});

	it("shows other members the sites and their links, without passwords or actions", async () => {
		const role = { manage: false };
		const { client } = setup([shop], { canManage: () => role.manage });
		await settle();
		expect(view!.el.textContent).toContain("Only founders and admins can see passwords or take sites offline.");
		expect(labels(cardOf(shop.id)!)).toEqual(["Copy"]);
		expect(cardOf(shop.id)?.querySelector("code a")?.textContent).toBe(shop.url);

		// The role arrives (or changes) after the page: it redraws with the actions.
		role.manage = true;
		view?.update();
		expect(labels(cardOf(shop.id)!)).toEqual(["Show password", "Change password", "Unpublish", "Copy"]);
		expect(view!.el.textContent).not.toContain("Only founders and admins");
		press(cardOf(shop.id)!, "Show password");
		await settle();
		expect(codes(cardOf(shop.id)!)).toContain("k7mq-x2pa-9fhd");

		// A member who is no longer an owner or admin keeps no password on screen.
		role.manage = false;
		view?.update();
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url]);
		expect(view!.el.textContent).not.toContain("k7mq-x2pa-9fhd");
		role.manage = true;
		view?.update();
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url]);
		expect(client.password).toHaveBeenCalledTimes(1);
	});

	it("shows an owner a site's password to copy, and hides it again", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const read = deferred<CompanySitePassword>();
		const { client } = setup([shop], admin, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(cardOf(shop.id)!, "Show password");
		expect(labels(cardOf(shop.id)!)).toContain("Working…");
		expect(buttons(cardOf(shop.id)!).every((item) => item.disabled || item.textContent === "Copy")).toBe(true);
		read.resolve({ siteId: shop.id, password: "k7mq-x2pa-9fhd", changedAt: timestamp });
		await settle();
		expect(client.password).toHaveBeenCalledWith(shop.id, expect.any(AbortSignal));
		const card = cardOf(shop.id)!;
		expect(codes(card)).toEqual([shop.url, "k7mq-x2pa-9fhd"]);
		expect(card.textContent).toContain(
			"Share the link and this password only with the people who should see the site.",
		);
		expect(card.textContent).toContain(
			"A visitor's own link opens the site for 7 days; a new password ends every visit.",
		);
		expect(labels(card)).toEqual(["Change password", "Unpublish", "Copy", "Copy", "Hide"]);
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`site-copy-password:${shop.id}`);

		(document.activeElement as HTMLButtonElement).click();
		await settle();
		expect(writeText).toHaveBeenCalledWith("k7mq-x2pa-9fhd");
		expect(cardOf(shop.id)?.textContent).toContain("The password is copied.");

		press(cardOf(shop.id)!, "Hide");
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url]);
		expect(cardOf(shop.id)?.textContent).not.toContain("The password is copied.");
		expect(document.activeElement?.textContent).toBe("Show password");
	});

	it("says why a password could not be read, keeping the focus on its button", async () => {
		setup([shop], admin, (client) => {
			vi.mocked(client.password)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_company_site_password", { message: "denied", code: "42501" }),
				)
				.mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		press(cardOf(shop.id)!, "Show password");
		await settle();
		expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		expect(document.activeElement?.textContent).toBe("Show password");
		press(cardOf(shop.id)!, "Show password");
		await settle();
		expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
			"The password could not be read. Try again.",
		);
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url]);
	});

	it("changes a site's password to one the owner types, after checking it", async () => {
		const { client } = setup([shop]);
		await settle();
		press(cardOf(shop.id)!, "Change password");
		const form = () => view!.el.querySelector<HTMLFormElement>(`#site-password-form-${shop.id}`)!;
		const field = () => form().querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(field());
		expect(field().getAttribute("aria-label")).toBe("New password for Wristband shop");
		expect(form().textContent).toContain("Every visitor enters the new password; the old one stops working at once.");
		const type = (value: string) => {
			field().value = value;
			field().dispatchEvent(new Event("input"));
			form().requestSubmit();
		};

		for (const bad of ["short", " ".repeat(12), `${"x".repeat(10)}\u0007`, "y".repeat(129)]) {
			type(bad);
			await settle();
			expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
				"A site password is 10 to 128 characters.",
			);
			expect(document.activeElement).toBe(field());
		}
		expect(client.setPassword).not.toHaveBeenCalled();

		type("our friends only 2026");
		expect(labels(form())).toContain("Working…");
		await settle();
		expect(client.setPassword).toHaveBeenCalledWith(shop.id, "our friends only 2026", expect.any(AbortSignal));
		expect(view!.el.querySelector(`#site-password-form-${shop.id}`)).toBeNull();
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url, "our friends only 2026"]);
		expect(cardOf(shop.id)?.textContent).toContain("The password is changed. Every visitor enters the new one.");
		expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(`site-copy-password:${shop.id}`);
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("makes a new random password, and says why the kernel refused one", async () => {
		const { client } = setup([shop], admin, (client) => {
			vi.mocked(client.setPassword)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_set_company_site_password", {
						message: "A site password is 10 to 128 characters",
						code: "22023",
					}),
				)
				.mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		press(cardOf(shop.id)!, "Change password");
		const form = () => view!.el.querySelector<HTMLFormElement>(`#site-password-form-${shop.id}`)!;
		const field = form().querySelector<HTMLInputElement>("input")!;
		field.value = "a long enough one";
		field.dispatchEvent(new Event("input"));
		form().requestSubmit();
		await settle();
		expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
			"A site password is 10 to 128 characters.",
		);
		// What was typed stays, with the focus.
		expect(form().querySelector("input")?.value).toBe("a long enough one");
		expect(document.activeElement).toBe(form().querySelector("input"));

		press(form(), "Make a new password");
		await settle();
		expect(client.setPassword).toHaveBeenLastCalledWith(shop.id, null, expect.any(AbortSignal));
		expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
			"The password could not be changed. Try again.",
		);

		press(form(), "Make a new password");
		await settle();
		expect(client.setPassword).toHaveBeenCalledTimes(3);
		expect(codes(cardOf(shop.id)!)).toEqual([shop.url, "n3wp-4ss-w0rd"]);

		// Cancel closes the form with nothing sent.
		press(cardOf(shop.id)!, "Change password");
		press(form(), "Cancel");
		expect(view!.el.querySelector(`#site-password-form-${shop.id}`)).toBeNull();
		expect(document.activeElement?.textContent).toBe("Change password");
		expect(client.setPassword).toHaveBeenCalledTimes(3);
	});

	it("takes a site offline only after the owner confirms", async () => {
		const { client } = setup([shop, draft]);
		await settle();
		press(cardOf(shop.id)!, "Unpublish");
		expect(dialog().textContent).toContain(
			"Take Wristband shop offline? Its link stops working and its password is deleted. The files stay in the Company File.",
		);
		press(dialog(), "Cancel");
		await settle();
		expect(client.unpublish).not.toHaveBeenCalled();
		expect(cardOf(shop.id)).not.toBeNull();

		press(cardOf(shop.id)!, "Unpublish");
		press(dialog(), "Unpublish");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(shop.id, expect.any(AbortSignal));
		expect(cardOf(shop.id)).toBeNull();
		expect(ids()).toEqual([draft.id]);

		press(cardOf(draft.id)!, "Unpublish");
		expect(dialog().textContent).toContain("Take launch-page offline?");
		press(dialog(), "Unpublish");
		await settle();
		expect(ids()).toEqual([]);
		expect(view!.el.textContent).toContain(
			"No sites yet. When an agent publishes a website for the company, it shows here with its link and password.",
		);
		expect(client.list).toHaveBeenCalledTimes(3);
	});

	it("says why a site could not be taken offline, and lets one gone elsewhere drop out", async () => {
		const { client, state } = setup([shop, draft]);
		await settle();
		vi.mocked(client.unpublish).mockRejectedValueOnce(
			new CloudRpcError("qorpera_unpublish_company_site", { message: "denied", code: "42501" }),
		);
		press(cardOf(shop.id)!, "Unpublish");
		press(dialog(), "Unpublish");
		await settle();
		expect(cardOf(shop.id)?.querySelector(".service-outcome")?.textContent).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		expect(document.activeElement?.textContent).toBe("Unpublish");

		// Taken offline elsewhere meanwhile: the read after the failure drops it.
		state.sites = state.sites.filter((site) => site.id !== draft.id);
		vi.mocked(client.unpublish).mockRejectedValueOnce(new Error("offline"));
		press(cardOf(draft.id)!, "Unpublish");
		press(dialog(), "Unpublish");
		await settle();
		expect(cardOf(draft.id)).toBeNull();
		expect(ids()).toEqual([shop.id]);
	});

	it("reads once more after a change made while a read was out, so the change shows", async () => {
		const { client, state } = setup([shop, draft]);
		await settle();
		const read = deferred<CompanySite[]>();
		vi.mocked(client.list).mockImplementationOnce(() => read.promise);
		// The password change's own read is still out when the owner takes the other site offline: it saw both sites.
		press(cardOf(shop.id)!, "Change password");
		press(view!.el.querySelector<HTMLFormElement>(`#site-password-form-${shop.id}`)!, "Make a new password");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		const before = structuredClone(state.sites);
		press(cardOf(draft.id)!, "Unpublish");
		press(dialog(), "Unpublish");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(draft.id, expect.any(AbortSignal));
		read.resolve(before);
		await settle();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(3);
		expect(ids()).toEqual([shop.id]);
	});

	it("shows a failed read with a way to try again", async () => {
		const { client } = setup([shop], admin, (client) => {
			vi.mocked(client.list).mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		expect(view!.el.querySelector('[role="alert"]')?.textContent).toContain("The company's sites could not be read.");
		expect(view!.el.querySelector("[data-sites]")).toBeNull();
		press(view!.el, "Try again");
		expect(view!.el.textContent).toContain("Checking…");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(view!.el.querySelector('[role="alert"]')).toBeNull();
		expect(ids()).toEqual([shop.id]);
	});
});

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

	it("lists the company's sites, reads and sets a password, and takes a site offline", async () => {
		const password = {
			schema: "qorpera.company-site-password/v1",
			siteId: shop.id,
			password: "p",
			changedAt: timestamp,
		};
		const cloud = cloudWith((name) =>
			name === "qorpera_list_company_sites"
				? [row()]
				: name === "qorpera_unpublish_company_site"
					? { schema: "qorpera.company-site-unpublish/v1", siteId: shop.id, removed: false }
					: password,
		);
		const sites = createWebSites(cloud, { profileId: id(10) });
		expect(await sites.list()).toEqual([shop]);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_list_company_sites", { p_profile_id: id(10) });
		expect(await sites.password(shop.id)).toEqual({ siteId: shop.id, password: "p", changedAt: timestamp });
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_company_site_password", { p_site_id: shop.id });
		await sites.setPassword(shop.id, null);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_set_company_site_password", {
			p_site_id: shop.id,
			p_password: null,
		});
		await sites.setPassword(shop.id, "our friends only");
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_set_company_site_password", {
			p_site_id: shop.id,
			p_password: "our friends only",
		});
		expect(await sites.unpublish(shop.id)).toBe(false);
		expect(cloud.rpc).toHaveBeenLastCalledWith("qorpera_unpublish_company_site", { p_site_id: shop.id });
		cloud.rpc.mockClear();
		await expect(sites.password("not-a-site")).rejects.toThrow("Invalid site.");
		await expect(sites.unpublish("not-a-site")).rejects.toThrow("Invalid site.");
		expect(cloud.rpc).not.toHaveBeenCalled();
	});

	it("refuses a malformed answer and a malformed company", async () => {
		await expect(
			createWebSites(
				cloudWith(() => ({})),
				{ profileId: id(10) },
			).list(),
		).rejects.toThrow("Invalid sites.");
		await expect(
			createWebSites(
				cloudWith(() => ({ schema: "qorpera.company-site-unpublish/v1", siteId: draft.id, removed: true })),
				{ profileId: id(10) },
			).unpublish(shop.id),
		).rejects.toThrow("Invalid site.");
		expect(() =>
			createWebSites(
				cloudWith(() => []),
				{ profileId: "main" },
			),
		).toThrow("Invalid company for sites.");
	});
});
