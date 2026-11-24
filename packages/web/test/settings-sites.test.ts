// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompanyState, hostingNotingPublic, siteAnswer } from "../src/app/company.ts";
import { Store } from "../src/app/state.ts";
import { type SitesAccess, SitesView, shownLink } from "../src/app/views/settings-sites.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import type { CompanySiteHostingState, SiteDnsSetup, WebSiteHosting } from "../src/cloud/site-hosting.ts";
import {
	type CompanySite,
	type CompanySitePassword,
	createWebSites,
	parseCompanySite,
	parseCompanySiteAccess,
	parseCompanySitePassword,
	type WebSites,
} from "../src/cloud/sites.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { setLanguagePreference, t } from "../src/ui/preferences.ts";
import { deferred, id, oneHostList, settle, timestamp } from "./fixtures.ts";
import { COMPANY, fakeClient, storeWith, summary, workspace } from "./surface-fixtures.ts";

const ORIGIN = "https://sites.qorpera.com";
const PASSWORD = "k7mq-x2pa-9fhd";
const DOTS = "••••••••••••";

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
const booking: CompanySite = {
	...app,
	id: id(87),
	slug: "booking",
	title: null,
	url: "https://booking-preview.qorpera.com/",
	source: "booking-server",
	machine: "booking-server",
	port: 8080,
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

type SitesClientMock = Pick<WebSites, "list" | "password" | "setPassword" | "unpublish">;

const admin: SitesAccess = { canManage: () => true };

let view: SitesView | undefined;
afterEach(() => {
	openMenu()?.close();
	view?.dispose();
	view = undefined;
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	Reflect.deleteProperty(navigator, "userAgent");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function setup(
	sites: CompanySite[] = [],
	access: SitesAccess = admin,
	configure?: (client: SitesClientMock) => void,
	options: { versions?: Record<string, number>; mascot?: () => HTMLElement; hosting?: WebSiteHosting } = {},
) {
	const state = { sites: structuredClone(sites), password: PASSWORD, versions: options.versions ?? {} };
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
	view = new SitesView(client, new AbortController().signal, {
		access,
		releases: { href: "#/c/company/whats-new", version: (site) => state.versions[site.slug] },
		...(options.mascot ? { mascot: options.mascot } : {}),
		...(options.hosting ? { hosting: options.hosting } : {}),
	});
	document.body.append(view.el);
	return { client, state };
}

/** The browser's clipboard, as a page sees it: `write` answers each copy. */
function clipboard(write: (text: string) => Promise<void> = async () => {}) {
	const writeText = vi.fn(write);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
	return writeText;
}
const refuse = async () => {
	throw new Error("denied");
};

const rowOf = (siteId: string) => view?.el.querySelector<HTMLElement>(`[data-site="${siteId}"]`) ?? null;
const ids = () => [...view!.el.querySelectorAll<HTMLElement>("[data-site]")].map((row) => row.dataset.site);
const control = (siteId: string, kind: string) =>
	view!.el.querySelector<HTMLElement>(`[data-focus-key="site-${kind}:${siteId}"]`);
const press = (siteId: string, kind: string) => control(siteId, kind)!.click();
const buttonsIn = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const pressLabel = (root: Element, label: string) =>
	buttonsIn(root)
		.find((item) => item.textContent === label)!
		.click();
const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].at(-1)!;
const question = () => document.querySelector<HTMLFormElement>('form[role="dialog"]');
const toast = () => view!.el.querySelector(".sites-toast")?.textContent;
const secretOf = (siteId: string) => rowOf(siteId)?.querySelector(".site-secret-text")?.textContent;
const menuLabels = () =>
	[...(openMenu()?.el.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].map((item) => ({
		label: item.textContent,
		danger: item.classList.contains("danger"),
	}));
const choose = (label: string) =>
	[...openMenu()!.el.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
		.find((item) => item.textContent === label)!
		.click();
const focusKey = () => (document.activeElement as HTMLElement | null)?.dataset.focusKey;

describe("Sites: the rows", () => {
	it("draws each site as one row: the globe, its title and state, its link to copy and open, no password", async () => {
		setup([shop, draft]);
		expect(view!.el.textContent).toContain("Checking…");
		await settle();
		expect(ids()).toEqual([shop.id, draft.id]);
		expect(view!.el.querySelector("h1")?.textContent).toBe("Sites");
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe("Share a site with its link once it is live.");

		const row = rowOf(shop.id)!;
		expect(row.getAttribute("aria-label")).toBe("Wristband shop");
		expect(row.querySelector("svg.site-emblem")).not.toBeNull();
		expect(row.querySelector(".site-name")?.textContent).toBe("Wristband shop");
		expect(row.querySelector(".site-state, .site-public-badge")).toBeNull();
		expect(row.textContent).not.toMatch(/files|KiB|product\/|From /);
		// The link, as the page shows it, copies on a press; the arrow opens the site in a new tab.
		expect(control(shop.id, "copy-link")?.textContent).toBe("sites.qorpera.com/wristband-shop");
		expect(control(shop.id, "copy-link")?.title).toBe("Copy the link");
		const open = row.querySelector<HTMLAnchorElement>("a.site-link-open")!;
		expect(open.href).toBe(shop.url);
		expect(open.target).toBe("_blank");
		expect(open.rel).toBe("noopener noreferrer");
		expect(open.getAttribute("aria-label")).toBe("Open the site");
		expect(row.querySelector(".site-secret")).toBeNull();
		expect(control(shop.id, "copy-password")).toBeNull();
		expect(control(shop.id, "eye")).toBeNull();
		expect(row.textContent).not.toMatch(/password/i);
		expect(control(shop.id, "more")?.getAttribute("aria-label")).toBe("More options for Wristband shop");
		expect(control(shop.id, "more")?.getAttribute("aria-haspopup")).toBe("menu");
		// Every rare thing is in the menu: the row has no other button.
		expect(buttonsIn(row)).toHaveLength(2);

		// A site still publishing goes by its name in the link.
		const publishing = rowOf(draft.id)!;
		expect(publishing.querySelector(".site-name")?.textContent).toBe("launch-page");
		expect(publishing.querySelector(".site-state")?.textContent).toBe("Publishing…");
		expect(publishing.querySelector<HTMLElement>(".site-state")?.title).toBe("");
	});

	it("shows an app link at its own host with its password hidden, and a site that is off", async () => {
		setup([app, { ...app, id: id(84), slug: "old-shop", title: null, state: "off", machine: null, port: 8080 }]);
		await settle();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
			"Share a site with its link once it is live. An app link also needs its password.",
		);
		expect(control(app.id, "copy-link")?.textContent).toBe("saml-shop-preview.qorpera.com");
		expect(secretOf(app.id)).toBe(DOTS);
		expect(control(app.id, "copy-password")?.getAttribute("aria-label")).toBe("Copy the password");
		expect(control(app.id, "eye")?.getAttribute("aria-label")).toBe("Show password");
		expect(buttonsIn(rowOf(app.id)!)).toHaveLength(4);
		expect(secretOf(id(84))).toBe(DOTS);
		expect(rowOf(app.id)?.querySelector<HTMLAnchorElement>("a.site-link-open")?.href).toBe(app.url);
		// No machine or port is named to a founder.
		expect(rowOf(app.id)?.textContent).not.toMatch(/port|machine|shop-server/);
		expect(rowOf(id(84))?.querySelector(".site-state")?.textContent).toBe("Off");
		expect(shownLink("https://sites.qorpera.com/a-b/")).toBe("sites.qorpera.com/a-b");
	});

	it("shows a website at an address of its own as one on the sites host: its link copies, opens and reads by hand", async () => {
		// Own code storage step 5.1: a website's link becomes https://<slug>.qorpera.com/; nothing else in its row changes.
		const own: CompanySite = { ...shop, url: "https://wristband-shop.qorpera.com/" };
		const write = clipboard();
		setup([own, draft]);
		await settle();
		expect(control(own.id, "copy-link")?.textContent).toBe("wristband-shop.qorpera.com");
		const open = rowOf(own.id)!.querySelector<HTMLAnchorElement>("a.site-link-open")!;
		expect([open.href, open.target, open.rel]).toEqual([own.url, "_blank", "noopener noreferrer"]);
		press(own.id, "copy-link");
		await settle();
		expect(write).toHaveBeenCalledWith(own.url);
		expect(toast()).toBe("The link is copied.");
		// The browser will not copy: the whole link, selected.
		clipboard(refuse);
		press(own.id, "copy-link");
		await settle();
		const field = view!.el.querySelector<HTMLInputElement>(`[data-focus-key="site-by-hand:link:${own.id}"]`)!;
		expect([field.value, field.selectionStart, field.selectionEnd]).toEqual([own.url, 0, own.url.length]);
		// A site on the sites host beside it reads as before.
		expect(control(draft.id, "copy-link")?.textContent).toBe("sites.qorpera.com/launch-page");
		expect(shownLink("https://wristband-shop.qorpera.com/")).toBe("wristband-shop.qorpera.com");
	});

	it("says what a site made from code has live, with the way to What's new, and follows it", async () => {
		const { state } = setup([gift, shop], admin, undefined, { versions: { "gift-message": 2 } });
		await settle();
		const line = rowOf(gift.id)!.querySelector(".site-from")!;
		expect(line.textContent).toBe("Version 2 · What's new");
		expect(line.querySelector("a")?.textContent).toBe("What's new");
		expect(line.querySelector("a")?.getAttribute("data-href") ?? line.querySelector("a")?.getAttribute("href")).toBe(
			"#/c/company/whats-new",
		);
		expect(rowOf(gift.id)?.textContent).not.toContain("code/");
		// A site an agent published says nothing of the kind.
		expect(rowOf(shop.id)?.querySelector(".site-from")).toBeNull();
		// What's new puts another version live: the row follows at the next update.
		state.versions = { "gift-message": 3 };
		view!.update();
		expect(rowOf(gift.id)?.querySelector(".site-from")?.textContent).toBe("Version 3 · What's new");
		// Not read yet: only the way there.
		state.versions = {};
		view!.update();
		expect(rowOf(gift.id)?.querySelector(".site-from")?.textContent).toBe("What's new");
	});

	it("shows an empty page with the Co-Founder and how a site comes to be", async () => {
		const mascot = vi.fn(() => document.createElement("span"));
		setup([], admin, undefined, { mascot });
		await settle();
		const empty = view!.el.querySelector(".sites-empty")!;
		expect(empty.querySelector("h2")?.textContent).toBe("No sites yet");
		expect(empty.querySelector("p")?.textContent).toBe("Ask an agent for a website and it shows up here.");
		expect(empty.firstElementChild).toBe(mascot.mock.results[0]?.value);
		// No line to share with when there is nothing to share.
		expect(view!.el.querySelector(".sites-head p")).toBeNull();
		expect(view!.el.querySelector("[data-sites]")).toBeNull();
		expect(mascot).toHaveBeenCalledTimes(1);
	});

	it("shows a failed read with a way to try again", async () => {
		const { client } = setup([shop], admin, (client) => {
			vi.mocked(client.list).mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		expect(view!.el.querySelector('[role="alert"]')?.textContent).toContain("The company's sites could not be read.");
		expect(view!.el.querySelector("[data-sites]")).toBeNull();
		expect(view!.el.querySelector(".sites-empty")).toBeNull();
		pressLabel(view!.el, "Try again");
		expect(view!.el.textContent).toContain("Checking…");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(view!.el.querySelector('[role="alert"]')).toBeNull();
		expect(ids()).toEqual([shop.id]);
	});
});

describe("Sites: copying", () => {
	it("copies the link with one press and says so at the foot", async () => {
		const write = clipboard();
		setup([shop]);
		await settle();
		press(shop.id, "copy-link");
		await settle();
		expect(write).toHaveBeenCalledWith(shop.url);
		expect(toast()).toBe("The link is copied.");
		expect(control(shop.id, "copy-link")?.classList.contains("is-copied")).toBe(true);
		expect(view!.el.querySelector(".sites-toast-area")?.getAttribute("role")).toBe("status");
	});

	it("shows the whole link selected when the browser will not copy it, and says what to press", async () => {
		clipboard(refuse);
		Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh)" });
		setup([shop]);
		await settle();
		press(shop.id, "copy-link");
		await settle();
		const field = view!.el.querySelector<HTMLInputElement>(`[data-focus-key="site-by-hand:link:${shop.id}"]`)!;
		expect(field.value).toBe(shop.url);
		expect(field.readOnly).toBe(true);
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, shop.url.length]);
		expect(toast()).toBe("Press ⌘C to copy.");
		// Elsewhere it is Ctrl+C; no line reads like an error.
		Reflect.deleteProperty(navigator, "userAgent");
		Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Windows NT 10.0)" });
		press(shop.id, "copy-link");
		await settle();
		expect(toast()).toBe("Press Ctrl+C to copy.");
		// A copy that works puts the pill back as it was.
		clipboard();
		press(shop.id, "copy-link");
		await settle();
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(control(shop.id, "copy-link")?.textContent).toBe("sites.qorpera.com/wristband-shop");
	});

	it("shows and hides a password with the eye", async () => {
		const read = deferred<CompanySitePassword>();
		const { client } = setup([app, booking], admin, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(app.id, "eye");
		// While it is read, the password pills and menus are off; the link still copies.
		expect(rowOf(app.id)?.querySelector(".site-secret.is-reading")).not.toBeNull();
		expect((control(booking.id, "eye") as HTMLButtonElement).disabled).toBe(true);
		expect((control(booking.id, "more") as HTMLButtonElement).disabled).toBe(true);
		expect((control(app.id, "copy-link") as HTMLButtonElement).disabled).toBe(false);
		read.resolve({ siteId: app.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(client.password).toHaveBeenCalledWith(app.id, expect.any(AbortSignal));
		expect(secretOf(app.id)).toBe(PASSWORD);
		expect(control(app.id, "eye")?.getAttribute("aria-label")).toBe("Hide password");
		// Shown, the copy pill is named by the password itself.
		expect(control(app.id, "copy-password")?.hasAttribute("aria-label")).toBe(false);
		expect(focusKey()).toBe(`site-eye:${app.id}`);
		expect(secretOf(booking.id)).toBe(DOTS);

		press(app.id, "eye");
		expect(secretOf(app.id)).toBe(DOTS);
		expect(control(app.id, "eye")?.getAttribute("aria-label")).toBe("Show password");
		expect(focusKey()).toBe(`site-eye:${app.id}`);
		expect(view!.el.textContent).not.toContain(PASSWORD);
	});

	it("says why a password could not be read, keeping the focus on the eye", async () => {
		setup([app], admin, (client) => {
			vi.mocked(client.password)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_company_site_password", { message: "denied", code: "42501" }),
				)
				.mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		press(app.id, "eye");
		await settle();
		expect(toast()).toBe("Only founders and admins can see passwords or take sites offline.");
		expect(focusKey()).toBe(`site-eye:${app.id}`);
		press(app.id, "eye");
		await settle();
		expect(toast()).toBe("The password could not be read. Try again.");
		expect(secretOf(app.id)).toBe(DOTS);
	});

	it("copies a hidden password without showing it, and a shown one as it stands", async () => {
		const write = clipboard();
		const { client } = setup([app]);
		await settle();
		press(app.id, "copy-password");
		await settle();
		expect(client.password).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith(PASSWORD);
		expect(toast()).toBe("The password is copied.");
		expect(secretOf(app.id)).toBe(DOTS);
		expect(focusKey()).toBe(`site-copy-password:${app.id}`);

		press(app.id, "eye");
		await settle();
		write.mockClear();
		press(app.id, "copy-password");
		await settle();
		expect(write).toHaveBeenCalledWith(PASSWORD);
		// Shown already: nothing is read again.
		expect(client.password).toHaveBeenCalledTimes(2);
	});

	it("hands a password still being read to the clipboard as it is read, where the browser takes that", async () => {
		const items: { data: Record<string, Promise<Blob>> }[] = [];
		vi.stubGlobal(
			"ClipboardItem",
			class {
				data: Record<string, Promise<Blob>>;
				constructor(data: Record<string, Promise<Blob>>) {
					this.data = data;
					items.push(this);
				}
			},
		);
		const write = vi.fn(async () => {});
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
		const read = deferred<CompanySitePassword>();
		setup([app], admin, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(app.id, "copy-password");
		// The press's own moment: the clipboard is asked before the read has come back.
		expect(write).toHaveBeenCalledTimes(1);
		read.resolve({ siteId: app.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		const blob = await items[0]!.data["text/plain"];
		expect([blob?.type, blob?.size]).toEqual(["text/plain", PASSWORD.length]);
		expect(writeText).not.toHaveBeenCalled();
		expect(toast()).toBe("The password is copied.");
	});

	it("shows a password selected to copy by hand when the browser will not copy it", async () => {
		clipboard(refuse);
		setup([app]);
		await settle();
		press(app.id, "copy-password");
		await settle();
		const field = view!.el.querySelector<HTMLInputElement>(`[data-focus-key="site-by-hand:password:${app.id}"]`)!;
		expect(field.value).toBe(PASSWORD);
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, PASSWORD.length]);
		expect(toast()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		// Hidden again, it leaves the page.
		press(app.id, "eye");
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(view!.el.textContent).not.toContain(PASSWORD);
	});
});

describe("Sites: the menu and its questions", () => {
	it("keeps what is rare in one menu: an app link's Change password, and Take offline in red", async () => {
		setup([app, shop]);
		await settle();
		const more = control(app.id, "more") as HTMLButtonElement;
		more.click();
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(openMenu()?.el.getAttribute("aria-label")).toBe("SAML shop");
		expect(menuLabels()).toEqual([
			{ label: "Change password", danger: false },
			{ label: "Take offline", danger: true },
		]);
		// The keyboard: the first row has the focus, the arrows move it, Escape shuts the menu and gives it back.
		expect(document.activeElement?.textContent).toBe("Change password");
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement?.textContent).toBe("Take offline");
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(openMenu()).toBeUndefined();
		expect(focusKey()).toBe(`site-more:${app.id}`);
		expect(control(app.id, "more")?.getAttribute("aria-expanded")).toBe("false");
		press(shop.id, "more");
		expect(menuLabels()).toEqual([{ label: "Take offline", danger: true }]);
		expect(document.activeElement?.textContent).toBe("Take offline");
	});

	it("changes a site's password to one the owner types, after checking it", async () => {
		const { client } = setup([app]);
		await settle();
		press(app.id, "more");
		choose("Change password");
		const form = question()!;
		const field = form.querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(field);
		expect(form.querySelector("h2")?.textContent).toBe("New password for SAML shop");
		expect(field.getAttribute("aria-label")).toBe("New password for SAML shop");
		expect(form.textContent).toContain("Every visitor enters the new password; the old one stops working at once.");
		const problem = () => form.querySelector('[role="alert"]')?.textContent;
		const type = (value: string) => {
			field.value = value;
			form.requestSubmit();
		};
		for (const bad of ["short", " ".repeat(12), `${"x".repeat(10)}\u0007`, "y".repeat(129)]) {
			type(bad);
			await settle();
			expect(problem()).toBe("A site password is 10 to 128 characters.");
			expect(document.activeElement).toBe(field);
		}
		expect(client.setPassword).not.toHaveBeenCalled();

		type("our friends only 2026");
		expect(buttonsIn(form).map((item) => item.textContent)).toContain("Working…");
		expect(buttonsIn(form).every((item) => item.disabled)).toBe(true);
		await settle();
		expect(client.setPassword).toHaveBeenCalledWith(app.id, "our friends only 2026", expect.any(AbortSignal));
		expect(question()).toBeNull();
		// The new password is shown, ready to copy, and the toast says it changed.
		expect(secretOf(app.id)).toBe("our friends only 2026");
		expect(toast()).toBe("The password is changed.");
		expect(focusKey()).toBe(`site-copy-password:${app.id}`);
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("makes a new random password, says in the question why one was refused, and cancels with nothing sent", async () => {
		const { client } = setup([app], admin, (client) => {
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
		press(app.id, "more");
		choose("Change password");
		const form = question()!;
		const field = form.querySelector<HTMLInputElement>("input")!;
		field.value = "a long enough one";
		form.requestSubmit();
		await settle();
		expect(form.querySelector('[role="alert"]')?.textContent).toBe("A site password is 10 to 128 characters.");
		// What was typed stays, with the focus, and the buttons work again.
		expect(question()).toBe(form);
		expect(field.value).toBe("a long enough one");
		expect(document.activeElement).toBe(field);
		expect(buttonsIn(form).some((item) => item.disabled)).toBe(false);

		pressLabel(form, "Make a new password");
		await settle();
		expect(client.setPassword).toHaveBeenLastCalledWith(app.id, null, expect.any(AbortSignal));
		expect(form.querySelector('[role="alert"]')?.textContent).toBe("The password could not be changed. Try again.");

		pressLabel(form, "Make a new password");
		await settle();
		expect(client.setPassword).toHaveBeenCalledTimes(3);
		expect(question()).toBeNull();
		expect(secretOf(app.id)).toBe("n3wp-4ss-w0rd");

		// Cancel, and Escape, close the question with nothing sent; the focus goes back to "⋯".
		press(app.id, "more");
		choose("Change password");
		pressLabel(question()!, "Cancel");
		expect(question()).toBeNull();
		expect(focusKey()).toBe(`site-more:${app.id}`);
		press(app.id, "more");
		choose("Change password");
		question()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(question()).toBeNull();
		expect(client.setPassword).toHaveBeenCalledTimes(3);
	});

	it("takes a site offline only after the owner confirms, and says so", async () => {
		const { client } = setup([shop, draft]);
		await settle();
		press(shop.id, "more");
		choose("Take offline");
		expect(dialog().textContent).toContain(
			"Take Wristband shop offline? Its link stops working. The files stay in the Company File.",
		);
		pressLabel(dialog(), "Cancel");
		await settle();
		expect(client.unpublish).not.toHaveBeenCalled();
		expect(rowOf(shop.id)).not.toBeNull();

		press(shop.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(shop.id, expect.any(AbortSignal));
		expect(rowOf(shop.id)).toBeNull();
		expect(ids()).toEqual([draft.id]);
		expect(toast()).toBe("Wristband shop is offline.");
		// The focus goes on to the next site's menu.
		expect(focusKey()).toBe(`site-more:${draft.id}`);

		press(draft.id, "more");
		choose("Take offline");
		expect(dialog().textContent).toContain("Take launch-page offline?");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(ids()).toEqual([]);
		expect(view!.el.querySelector(".sites-empty h2")?.textContent).toBe("No sites yet");
		expect(client.list).toHaveBeenCalledTimes(3);
	});

	it("asks in each kind's words: an app keeps running, a site made from code waits in What's new", async () => {
		const { client } = setup([app, gift]);
		await settle();
		press(app.id, "more");
		choose("Take offline");
		expect(dialog().textContent).toContain(
			"Take SAML shop offline? Its link stops working and its password is deleted. The app keeps running on its machine.",
		);
		pressLabel(dialog(), "Cancel");
		await settle();
		press(gift.id, "more");
		choose("Take offline");
		expect(dialog().textContent).toContain(
			"Take Gift message offline? Its earlier versions go with it. The newest one waits in What's new until you put it live.",
		);
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(gift.id, expect.any(AbortSignal));
		expect(ids()).toEqual([app.id]);
	});

	it("says why a site could not be taken offline, and lets one gone elsewhere drop out", async () => {
		const { client, state } = setup([shop, draft]);
		await settle();
		vi.mocked(client.unpublish).mockRejectedValueOnce(
			new CloudRpcError("qorpera_unpublish_company_site", { message: "denied", code: "42501" }),
		);
		press(shop.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(toast()).toBe("Only founders and admins can see passwords or take sites offline.");
		expect(rowOf(shop.id)).not.toBeNull();
		expect(focusKey()).toBe(`site-more:${shop.id}`);

		// Taken offline elsewhere meanwhile: the read after the failure drops it.
		state.sites = state.sites.filter((site) => site.id !== draft.id);
		vi.mocked(client.unpublish).mockRejectedValueOnce(new Error("offline"));
		press(draft.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(toast()).toBe("The site could not be taken offline. Try again.");
		expect(rowOf(draft.id)).toBeNull();
		expect(ids()).toEqual([shop.id]);
	});

	it("reads once more after a change made while a read was out, so the change shows", async () => {
		const { client, state } = setup([app, draft]);
		await settle();
		const read = deferred<CompanySite[]>();
		vi.mocked(client.list).mockImplementationOnce(() => read.promise);
		// The password change's own read is still out when the owner takes the other site offline: it saw both sites.
		press(app.id, "more");
		choose("Change password");
		pressLabel(question()!, "Make a new password");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(2);
		const before = structuredClone(state.sites);
		press(draft.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(client.unpublish).toHaveBeenCalledWith(draft.id, expect.any(AbortSignal));
		read.resolve(before);
		await settle();
		await settle();
		expect(client.list).toHaveBeenCalledTimes(3);
		expect(ids()).toEqual([app.id]);
	});
});

describe("Sites: answers that come back late", () => {
	// Every answer that comes back after the page moved on acts only on the page it was asked from: never a password
	// the member hid or that changed since, never the focus pulled out from under a question.
	const later = "2026-09-05T10:05:00Z";
	const refusal = () => Promise.reject(new Error("denied"));

	it("never brings back a password the member hid while its copy was out (review F1)", async () => {
		const copy = deferred<void>();
		clipboard(() => copy.promise);
		setup([app]);
		await settle();
		press(app.id, "eye");
		await settle();
		expect(secretOf(app.id)).toBe(PASSWORD);
		press(app.id, "copy-password");
		press(app.id, "eye");
		expect(secretOf(app.id)).toBe(DOTS);
		copy.reject(new Error("denied"));
		await settle();
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(control(app.id, "eye")?.getAttribute("aria-label")).toBe("Show password");
		expect(toast()).toBeUndefined();
	});

	it("never brings back the old password when it was changed while its copy was out (review F1)", async () => {
		const copy = deferred<void>();
		clipboard(() => copy.promise);
		setup([app]);
		await settle();
		press(app.id, "eye");
		await settle();
		press(app.id, "copy-password");
		press(app.id, "more");
		choose("Change password");
		const form = question()!;
		form.querySelector<HTMLInputElement>("input")!.value = "our friends only 2026";
		form.requestSubmit();
		await settle();
		expect(secretOf(app.id)).toBe("our friends only 2026");
		copy.reject(new Error("denied"));
		await settle();
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(secretOf(app.id)).toBe("our friends only 2026");
	});

	it("never moves the focus behind a question when a read comes back (review F2)", async () => {
		const { client, state } = setup([app, booking]);
		await settle();
		const read = deferred<CompanySite[]>();
		vi.mocked(client.list).mockImplementationOnce(() => read.promise);
		press(app.id, "more");
		choose("Change password");
		pressLabel(question()!, "Make a new password");
		await settle();
		expect(question()).toBeNull();
		// The change's own read is still out when the member opens the other site's question.
		press(booking.id, "more");
		choose("Change password");
		const field = question()!.querySelector("input")!;
		expect(document.activeElement).toBe(field);
		read.resolve([app, booking]);
		await settle();
		expect(document.activeElement).toBe(field);
		// The same behind the take-offline question, for a read that comes back and for a version What's new tells.
		pressLabel(question()!, "Cancel");
		const second = deferred<CompanySite[]>();
		vi.mocked(client.list).mockImplementationOnce(() => second.promise);
		vi.mocked(client.password).mockRejectedValueOnce(new Error("offline"));
		// A read that fails reads the list again.
		press(booking.id, "eye");
		await settle();
		press(app.id, "more");
		choose("Take offline");
		const confirm = dialog().querySelector<HTMLButtonElement>("button.btn-danger")!;
		expect(document.activeElement).toBe(confirm);
		second.resolve([app, booking, gift]);
		await settle();
		expect(document.activeElement).toBe(confirm);
		state.versions = { "gift-message": 4 };
		view!.update();
		expect(rowOf(gift.id)?.querySelector(".site-from")?.textContent).toBe("Version 4 · What's new");
		expect(document.activeElement).toBe(confirm);
	});

	it("shows nothing a read answers after the member's authority went or the page was left", async () => {
		const role = { manage: true };
		const read = deferred<CompanySitePassword>();
		const { client } = setup([app], { canManage: () => role.manage }, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(app.id, "eye");
		role.manage = false;
		view!.update();
		role.manage = true;
		view!.update();
		read.resolve({ siteId: app.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(secretOf(app.id)).toBe(DOTS);
		// The page left while a read is out: its answer draws nothing.
		const again = deferred<CompanySitePassword>();
		vi.mocked(client.password).mockImplementationOnce(() => again.promise);
		press(app.id, "eye");
		const el = view!.el;
		view!.dispose();
		again.resolve({ siteId: app.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(el.textContent).toBe("");
		expect(document.body.textContent).not.toContain(PASSWORD);
	});

	it("drops a hidden password's copy by hand when the member's authority went while it was read, even if it came back", async () => {
		const role = { manage: true };
		clipboard(refusal);
		const read = deferred<CompanySitePassword>();
		setup([app], { canManage: () => role.manage }, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(app.id, "copy-password");
		role.manage = false;
		view!.update();
		role.manage = true;
		view!.update();
		read.resolve({ siteId: app.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(document.body.textContent).not.toContain(PASSWORD);
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(toast()).toBeUndefined();
	});

	it("shows no new password when the member's authority went while it was being set", async () => {
		const role = { manage: true };
		const set = deferred<CompanySitePassword>();
		setup([app], { canManage: () => role.manage }, (client) => {
			vi.mocked(client.setPassword).mockImplementationOnce(() => set.promise);
		});
		await settle();
		press(app.id, "more");
		choose("Change password");
		pressLabel(question()!, "Make a new password");
		role.manage = false;
		view!.update();
		expect(question()).toBeNull();
		role.manage = true;
		view!.update();
		set.resolve({ siteId: app.id, password: "n3wp-4ss-w0rd", changedAt: later });
		await settle();
		expect(document.body.textContent).not.toContain("n3wp-4ss-w0rd");
		expect(secretOf(app.id)).toBe(DOTS);
	});

	it("takes a password off the screen when the list says it was changed since (elsewhere)", async () => {
		const { state } = setup([app, booking]);
		await settle();
		press(app.id, "eye");
		await settle();
		expect(secretOf(app.id)).toBe(PASSWORD);
		// Another owner changed it; a read the page makes for its own reasons (here: the other site taken offline) says so.
		state.sites = state.sites.map((site) => (site.id === app.id ? { ...site, passwordChangedAt: later } : site));
		press(booking.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(ids()).toEqual([app.id]);
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(secretOf(app.id)).toBe(DOTS);
	});

	it("leaves a link's copy by hand out once its site went, and never pulls the focus off another field", async () => {
		const copy = deferred<void>();
		clipboard(() => copy.promise);
		const { client, state } = setup([shop, draft]);
		await settle();
		press(shop.id, "copy-link");
		press(shop.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(ids()).toEqual([draft.id]);
		copy.reject(new Error("denied"));
		await settle();
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(toast()).toBe("Wristband shop is offline.");

		// Elsewhere: the member is typing in another field when the answer to the page's press comes back.
		const outside = document.createElement("input");
		document.body.append(outside);
		const unpublish = deferred<boolean>();
		vi.mocked(client.unpublish).mockImplementationOnce(() => unpublish.promise);
		press(draft.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		outside.focus();
		state.sites = [];
		unpublish.resolve(true);
		await settle();
		expect(document.activeElement).toBe(outside);
		expect(ids()).toEqual([]);
	});
});

describe("Sites: who may do what", () => {
	it("shows other members the sites and their links, without passwords or a menu", async () => {
		const role = { manage: false };
		const { client } = setup([shop, app], { canManage: () => role.manage });
		await settle();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		for (const site of [shop, app]) {
			const row = rowOf(site.id)!;
			expect(row.querySelector(".site-secret")).toBeNull();
			expect(control(site.id, "more")).toBeNull();
			expect(buttonsIn(row).map((item) => item.dataset.focusKey)).toEqual([`site-copy-link:${site.id}`]);
			expect(row.querySelector("a.site-link-open")).not.toBeNull();
		}

		role.manage = true;
		view!.update();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
			"Share a site with its link once it is live. An app link also needs its password.",
		);
		expect(rowOf(shop.id)?.querySelector(".site-secret")).toBeNull();
		expect(secretOf(app.id)).toBe(DOTS);
		press(app.id, "eye");
		await settle();
		expect(secretOf(app.id)).toBe(PASSWORD);
		press(app.id, "more");
		choose("Change password");
		expect(question()).not.toBeNull();

		// A member who is no longer an owner or admin keeps no password on screen, and the question goes.
		role.manage = false;
		view!.update();
		expect(question()).toBeNull();
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(rowOf(app.id)?.querySelector(".site-secret")).toBeNull();
		role.manage = true;
		view!.update();
		expect(secretOf(app.id)).toBe(DOTS);
		expect(client.password).toHaveBeenCalledTimes(1);
	});

	it("tells other members of a company with websites only what founders and admins do, with no word of a password", async () => {
		setup([shop, draft], { canManage: () => false });
		await settle();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
			"Only founders and admins can make a site live or take it offline.",
		);
		expect(view!.el.textContent).not.toMatch(/password/i);
	});
});

describe("Sites: a site Qorpera took down (own code storage step 5.1)", () => {
	const REASON = "It asked visitors for bank passwords.";
	const SAID =
		"Qorpera took this site down: It asked visitors for bank passwords. If you think this is wrong, tell us with Feedback in your menu.";
	/** The access read as the kernel answers it (qorpera.company-site-access/v1), with keys this web does not know. */
	const accessOf = (down: Record<string, string>, extra: Record<string, unknown> = {}) => ({
		schema: "qorpera.company-site-access/v1",
		hosts: true,
		...extra,
		sites: [shop, draft, app, gift].map((site) => ({
			siteId: site.id,
			takenDown: site.id in down ? { at: timestamp, reason: down[site.id] } : null,
			public: false,
		})),
	});
	const withAccess = (answer: () => unknown) => (client: SitesClientMock) => {
		(client as SitesClientMock & Pick<WebSites, "access">).access = vi.fn(async () => {
			const value = answer();
			if (value instanceof Error) throw value;
			return parseCompanySiteAccess(value);
		});
	};
	const links = (row: Element) => [...row.querySelectorAll<HTMLAnchorElement>("a")].map((link) => link.href);

	it("says so in its row in one plain sentence, and offers no link to the gone page, its password nor a menu", async () => {
		setup(
			[shop, app, gift],
			admin,
			withAccess(() => accessOf({ [shop.id]: REASON, [app.id]: "Spam." })),
		);
		await settle();
		const row = rowOf(shop.id)!;
		expect(row.classList.contains("is-down")).toBe(true);
		expect(row.querySelector(".site-state")?.textContent).toBe("Taken down");
		expect(row.querySelector(".site-state.is-down")).not.toBeNull();
		expect(row.querySelector(".site-down")?.textContent).toBe(SAID);
		// Nothing that leads to the site: no link to copy or open, no password to share.
		expect(row.querySelector(".site-share, .site-link, .site-secret")).toBeNull();
		expect(links(row)).toEqual([]);
		expect(row.innerHTML).not.toContain("sites.qorpera.com");
		// No menu: until Qorpera restores it, the kernel refuses taking it offline and its password opens nothing.
		expect(buttonsIn(row)).toEqual([]);
		expect(row.querySelector(".site-more")).toBeNull();
		// An app link taken down says the same, in its own row, with no menu either.
		const link = rowOf(app.id)!;
		expect(link.querySelector(".site-down")?.textContent).toBe(
			"Qorpera took this site down: Spam. If you think this is wrong, tell us with Feedback in your menu.",
		);
		expect(links(link)).toEqual([]);
		expect(buttonsIn(link)).toEqual([]);
		// A site not taken down is as before; a project's site keeps its way to What's new.
		const other = rowOf(gift.id)!;
		expect(other.querySelector(".site-state")).toBeNull();
		expect(other.querySelector(".site-down")).toBeNull();
		expect(control(gift.id, "copy-link")?.textContent).toBe("sites.qorpera.com/gift-message");
		expect(rowOf(gift.id)?.querySelector(".site-secret")).toBeNull();
		press(gift.id, "more");
		expect(menuLabels().map((item) => item.label)).toEqual(["Take offline"]);
	});

	it("tells every member why, with no menu for those who may not take it offline", async () => {
		setup(
			[shop],
			{ canManage: () => false },
			withAccess(() => accessOf({ [shop.id]: REASON })),
		);
		await settle();
		const row = rowOf(shop.id)!;
		expect(row.querySelector(".site-down")?.textContent).toBe(SAID);
		expect(buttonsIn(row)).toEqual([]);
		expect(links(row)).toEqual([]);
	});

	it("keeps a project's site's way to What's new, with no menu: it stays until Qorpera restores it", async () => {
		const { client } = setup(
			[gift],
			admin,
			withAccess(() => accessOf({ [gift.id]: REASON })),
			{
				versions: { "gift-message": 3 },
			},
		);
		await settle();
		expect(rowOf(gift.id)?.querySelector(".site-from")?.textContent).toBe("Version 3 · What's new");
		expect(buttonsIn(rowOf(gift.id)!)).toEqual([]);
		expect(client.unpublish).not.toHaveBeenCalled();
	});

	it("draws a row for a project's site taken down before it ever went live, which no list has (review of #1774, F4)", async () => {
		// A project's site whose first version still waits in What's new: the list leaves it out; the access read names it.
		const fresh = {
			id: id(86),
			slug: "spring-sale",
			title: "Spring sale",
			kind: "files",
			source: "code/company/spring-sale",
		};
		let down = true;
		const access = () => ({
			schema: "qorpera.company-site-access/v1",
			hosts: true,
			sites: [
				{
					siteId: shop.id,
					slug: shop.slug,
					title: shop.title,
					kind: "files",
					source: shop.source,
					takenDown: null,
				},
				{
					siteId: fresh.id,
					slug: fresh.slug,
					title: fresh.title,
					kind: fresh.kind,
					source: fresh.source,
					takenDown: down ? { at: timestamp, reason: REASON } : null,
				},
			],
		});
		setup([shop], admin, withAccess(access), { versions: {} });
		await settle();
		expect(ids()).toEqual([shop.id, fresh.id]);
		const row = rowOf(fresh.id)!;
		expect(row.querySelector(".site-name")?.textContent).toBe("Spring sale");
		expect(row.querySelector(".site-state")?.textContent).toBe("Taken down");
		expect(row.querySelector(".site-down")?.textContent).toBe(SAID);
		// The row and nothing else: no link, no password, no menu; its way to What's new, where its version waits.
		expect(row.innerHTML).not.toContain("qorpera.com");
		expect(row.querySelectorAll("a")).toHaveLength(1);
		expect(row.querySelector(".site-share, .site-link, .site-secret, .site-more")).toBeNull();
		expect(buttonsIn(row)).toEqual([]);
		expect(row.querySelector(".site-from")?.textContent).toBe("What's new");
		// A member who may not manage sites sees the same row.
		view?.dispose();
		document.body.replaceChildren();
		setup([shop], { canManage: () => false }, withAccess(access));
		await settle();
		expect(rowOf(fresh.id)?.querySelector(".site-down")?.textContent).toBe(SAID);
		expect(buttonsIn(rowOf(fresh.id)!)).toEqual([]);
		// Restored: the row goes with the next read (the list still leaves the site out until it goes live).
		down = false;
		view?.dispose();
		document.body.replaceChildren();
		setup([shop], admin, withAccess(access));
		await settle();
		expect(ids()).toEqual([shop.id]);
		// An access read whose entry does not name the site (a kernel's answer it cannot read whole) draws no such row.
		view?.dispose();
		document.body.replaceChildren();
		down = true;
		setup(
			[shop],
			admin,
			withAccess(() => ({ ...access(), sites: access().sites.map(({ slug: _slug, ...entry }) => entry) })),
		);
		await settle();
		expect(ids()).toEqual([shop.id]);
	});

	it("sends nothing when Qorpera took the site down while its Take offline was on the way, and the focus skips its row", async () => {
		let answer: unknown = accessOf({});
		const { client } = setup(
			[shop, gift, booking],
			admin,
			withAccess(() => answer),
		);
		await settle();
		/** A read of the list (and of what Qorpera took down) that is still out: a password read that fails reads again. */
		const readOut = async (down: Record<string, string>) => {
			const read = deferred<CompanySite[]>();
			vi.mocked(client.list).mockImplementationOnce(() => read.promise);
			vi.mocked(client.password).mockRejectedValueOnce(new Error("offline"));
			answer = accessOf(down);
			press(booking.id, "eye");
			await settle();
			return async () => {
				read.resolve([shop, gift, booking]);
				await settle();
			};
		};
		const asked = () => document.querySelector('[role="alertdialog"]');
		// The read says so while the project's site's menu is open: Take offline asks nothing and sends nothing.
		let lands = await readOut({ [gift.id]: REASON });
		press(gift.id, "more");
		await lands();
		expect(rowOf(gift.id)?.querySelector(".site-down")?.textContent).toBe(SAID);
		choose("Take offline");
		await settle();
		expect(asked()).toBeNull();
		// Restored, then taken down again while the question is open: its yes sends nothing.
		await (await readOut({}))();
		lands = await readOut({ [gift.id]: REASON });
		press(gift.id, "more");
		choose("Take offline");
		await lands();
		expect(rowOf(gift.id)?.querySelector(".site-down")?.textContent).toBe(SAID);
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(client.unpublish).not.toHaveBeenCalled();
		expect(rowOf(gift.id)).not.toBeNull();
		// Taking the site before it offline moves the focus past the row with no menu, to the site after it.
		press(shop.id, "more");
		choose("Take offline");
		pressLabel(dialog(), "Take offline");
		await settle();
		expect(client.unpublish).toHaveBeenCalledExactlyOnceWith(shop.id, expect.any(AbortSignal));
		expect(focusKey()).toBe(`site-more:${booking.id}`);
	});

	it("draws the page exactly as before on a kernel without the read, or with an answer it cannot read", async () => {
		const drawn = async (configure?: (client: SitesClientMock) => void) => {
			view?.dispose();
			document.body.replaceChildren();
			setup([shop, draft, app, gift], admin, configure, { versions: { "gift-message": 3 } });
			await settle();
			// Each globe numbers its own mask: the number is all that differs between two pages drawn alike.
			return view!.el.innerHTML.replace(/emblem-cuts-\d+/g, "emblem-cuts");
		};
		const before = await drawn();
		expect(before).toContain("sites.qorpera.com/wristband-shop");
		const missing = new CloudRpcError("qorpera_company_site_access", { message: "missing", code: "PGRST202" }, 404);
		for (const answer of [
			() => missing,
			() => new Error("Failed to fetch"),
			() => ({}),
			() => [],
			() => ({ schema: "qorpera.company-site-access/v2", sites: [] }),
			() => ({ schema: "qorpera.company-site-access/v1", sites: {} }),
			// Entries it cannot read say nothing of their site.
			() => ({
				schema: "qorpera.company-site-access/v1",
				sites: [
					{ siteId: shop.id, takenDown: { at: timestamp } },
					{ siteId: shop.id, takenDown: { at: timestamp, reason: "   " } },
					{ siteId: shop.id, takenDown: { at: "yesterday", reason: REASON } },
					{ siteId: shop.id, takenDown: [REASON] },
					{ siteId: shop.id, takenDown: true },
					{ siteId: "shop", takenDown: { at: timestamp, reason: REASON } },
					{ takenDown: { at: timestamp, reason: REASON } },
					null,
					REASON,
				],
			}),
			() => accessOf({}),
		])
			expect(await drawn(withAccess(answer)), JSON.stringify(answer())).toBe(before);
	});

	it("keeps what the last read said when a read fails, forgets a password on screen, and gives the link back once up again", async () => {
		let answer: unknown = accessOf({ [shop.id]: REASON });
		const { client } = setup(
			[shop, app, booking],
			admin,
			withAccess(() => answer),
		);
		await settle();
		expect(rowOf(shop.id)?.querySelector(".site-down")).not.toBeNull();
		const newPassword = async (password: string) => {
			press(app.id, "more");
			choose("Change password");
			question()!.querySelector("input")!.value = password;
			question()!.requestSubmit();
			await settle();
		};
		// A read whose access answer fails: what the last one said stands.
		answer = new Error("Failed to fetch");
		await newPassword("our friends only");
		expect(client.list).toHaveBeenCalledTimes(2);
		expect(rowOf(shop.id)?.querySelector(".site-down")).not.toBeNull();
		expect(secretOf(app.id)).toBe("our friends only");
		// Taken down while its new password is on screen: the password leaves with the link.
		answer = accessOf({ [shop.id]: REASON, [app.id]: REASON });
		await newPassword("our friends again");
		expect(client.list).toHaveBeenCalledTimes(3);
		expect(rowOf(app.id)?.querySelector(".site-down")).not.toBeNull();
		expect(rowOf(app.id)?.querySelector(".site-secret")).toBeNull();
		expect(view!.el.textContent).not.toContain("our friends again");
		// Up again (Qorpera restored both): the links are back, and the password hidden. A password read that fails (the
		// other site's) reads the list again.
		answer = accessOf({});
		vi.mocked(client.password).mockRejectedValueOnce(new Error("offline"));
		press(booking.id, "eye");
		await settle();
		expect(client.list).toHaveBeenCalledTimes(4);
		expect(rowOf(shop.id)?.querySelector(".site-down")).toBeNull();
		expect(control(app.id, "copy-link")?.textContent).toBe("saml-shop-preview.qorpera.com");
		expect(secretOf(app.id)).toBe(DOTS);
	});

	it("says the reason as Qorpera wrote it, without a full stop of its own, and in Danish", async () => {
		const said = async (reason: string) => {
			view?.dispose();
			document.body.replaceChildren();
			setup(
				[shop],
				admin,
				withAccess(() => accessOf({ [shop.id]: reason })),
			);
			await settle();
			return rowOf(shop.id)?.querySelector(".site-down")?.textContent;
		};
		expect(await said("Phishing")).toBe(
			"Qorpera took this site down: Phishing. If you think this is wrong, tell us with Feedback in your menu.",
		);
		expect(await said("Phishing. . ")).toBe(
			"Qorpera took this site down: Phishing. If you think this is wrong, tell us with Feedback in your menu.",
		);
		// Read as text: braces and markup stay as they are.
		expect(await said("{name} <b>x</b>")).toBe(
			"Qorpera took this site down: {name} <b>x</b>. If you think this is wrong, tell us with Feedback in your menu.",
		);
		expect(rowOf(shop.id)?.querySelector("b")).toBeNull();
		expect(await said("...")).toBe(
			"Qorpera took this site down: .... If you think this is wrong, tell us with Feedback in your menu.",
		);
		setLanguagePreference("da");
		try {
			await said(REASON);
			expect(rowOf(shop.id)?.querySelector(".site-state")?.textContent).toBe("Taget ned");
			expect(rowOf(shop.id)?.querySelector(".site-down")?.textContent).toBe(
				"Qorpera har taget hjemmesiden ned: It asked visitors for bank passwords. Hvis du mener, det er forkert, så skriv til os under Feedback i din menu.",
			);
		} finally {
			setLanguagePreference("system");
		}
	});

	it("sends a member who thinks it wrong to Feedback in their menu, by that item's own label", () => {
		// The menu's item, as the account menu draws it, in both languages.
		const shell = readFileSync(resolve("src/app/views/shell.ts"), "utf8");
		expect(shell).toContain('h("span", { class: "account-item-label" }, uiText("Feedback"))');
		const said = (lang: string) => {
			setLanguagePreference(lang);
			try {
				return {
					item: t("Feedback"),
					sentence: t(
						"Qorpera took this site down: {reason}. If you think this is wrong, tell us with {feedback} in your menu.",
						{ reason: "Spam", feedback: t("Feedback") },
					),
				};
			} finally {
				setLanguagePreference("system");
			}
		};
		expect(said("en")).toEqual({
			item: "Feedback",
			sentence: "Qorpera took this site down: Spam. If you think this is wrong, tell us with Feedback in your menu.",
		});
		expect(said("da")).toEqual({
			item: "Feedback",
			sentence:
				"Qorpera har taget hjemmesiden ned: Spam. Hvis du mener, det er forkert, så skriv til os under Feedback i din menu.",
		});
	});
});

describe("Sites and What's new's live row at every width", () => {
	// jsdom lays nothing out, so the stylesheet's rules are what is pinned here; measured in headless Chrome at 390, 768,
	// 1024, 1280 and 1440 px, the sidebar open and compact, in English and Danish (lanes/own-code-storage/sites-redo).
	const css = readFileSync(resolve("src/styles/sites.css"), "utf8");
	const app = readFileSync(resolve("src/styles/app.css"), "utf8");

	it("lays both pages' rows out by their own width, not the window's", () => {
		expect(css).toContain(":is(.sites, .whats-new) {");
		expect(css).toMatch(/:is\(\.sites, \.whats-new\) \{[^}]*container: site-rows \/ inline-size;/);
		expect(app).toContain('@import "./sites.css";');
	});

	it("puts the pills under the globe on a narrow page, and What's new's buttons under its line", () => {
		const narrow = css.match(/@container site-rows not \(min-width: 36em\) \{([^@]*?)\n\}/)?.[1] ?? "";
		expect(narrow).toContain('.site-row { grid-template-areas: "emblem head end" "body body body"; }');
		const live = css.match(/@container site-rows not \(min-width: 56em\) \{([^@]*?)\n\}/)?.[1] ?? "";
		expect(live).toContain('.site-row.is-whats-new { grid-template-areas: "emblem head head" ". end end"; }');
	});

	it("never writes px in a container condition (the design-px build step refuses it)", () => {
		expect(
			[...css.matchAll(/@container[^{]*/g)].map(([query]) => query).filter((query) => /\dpx/.test(query)),
		).toEqual([]);
	});

	it("keeps still under reduced motion", () => {
		const still = css.match(/@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\n\}/)?.[1] ?? "";
		expect(still).toContain(".site-row.is-new, .site-row.is-leaving, .sites-empty, .sites-toast");
	});
});

describe("Sites: a custom domain's DNS lines", () => {
	const hostingWith = (dns: (hostname: string, isApex: boolean) => SiteDnsSetup): WebSiteHosting => {
		const state: CompanySiteHostingState = {
			hostsDomain: "qorpera.com",
			hostsEnabled: true,
			publicEnabled: true,
			domainsEnabled: true,
			edgeIpv4: "203.0.113.7",
			edgeIpv6: "2001:db8::7",
			edgeCnameTarget: "edge.qorpera.com",
			sites: new Map(),
		};
		return {
			read: vi.fn(async () => state),
			setPublic: vi.fn(async () => true),
			addDomain: vi.fn(async (siteId: string, hostname: string, isApex: boolean) => ({
				id: id(71),
				siteId,
				hostname,
				isApex,
				isPrimary: false,
				status: "pending_dns" as const,
				verificationToken: "9f3a1c",
				dns: dns(hostname, isApex),
			})),
			removeDomain: vi.fn(async () => true),
			setPrimaryDomain: vi.fn(async () => ""),
			recheckDomain: vi.fn(async () => "pending_dns" as const),
		};
	};
	const setupDns = (hostname: string, recordType: "A" | "CNAME", ipv4: string | null) => ({
		recordType,
		ipv4,
		ipv6: "2001:db8::7",
		cnameTarget: "edge.qorpera.com",
		txtHost: `_qorpera.${hostname}`,
		txtValue: "qorpera-verify=9f3a1c",
	});
	const addDomain = async (hosting: WebSiteHosting, domain: string) => {
		setup([shop], admin, undefined, { hosting });
		await settle();
		press(shop.id, "more");
		choose("Custom domain");
		const form = question()!;
		form.querySelector<HTMLInputElement>("input")!.value = domain;
		form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await settle();
		return [...form.querySelectorAll(".site-dns-guide > div")].map((line) => line.textContent);
	};

	it("lists an apex domain's A, AAAA and TXT lines as before", async () => {
		const lines = await addDomain(
			hostingWith((hostname) => setupDns(hostname, "A", "203.0.113.7")),
			"thetaband.dk",
		);
		expect(lines).toEqual([
			"Domain added. Point your DNS records below:",
			"Record A · @ · 203.0.113.7",
			"Record AAAA · @ · 2001:db8::7",
			"Record TXT · _qorpera.thetaband.dk · qorpera-verify=9f3a1c",
		]);
	});

	it("lists a subdomain's CNAME and TXT lines as before, and a CNAME when an apex has no IPv4", async () => {
		expect(
			await addDomain(
				hostingWith((hostname) => setupDns(hostname, "CNAME", null)),
				"www.thetaband.dk",
			),
		).toEqual([
			"Domain added. Point your DNS records below:",
			"Record CNAME · www.thetaband.dk · edge.qorpera.com",
			"Record TXT · _qorpera.www.thetaband.dk · qorpera-verify=9f3a1c",
		]);
		openMenu()?.close();
		question()?.closest(".modal-backdrop")?.remove();
		view?.dispose();
		expect(
			await addDomain(
				hostingWith((hostname) => setupDns(hostname, "A", null)),
				"thetaband.dk",
			),
		).toEqual([
			"Domain added. Point your DNS records below:",
			"Record CNAME · thetaband.dk · edge.qorpera.com",
			"Record TXT · _qorpera.thetaband.dk · qorpera-verify=9f3a1c",
		]);
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

	it("reads and draws today's answers exactly as before: websites on the sites host, app links at their own", async () => {
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
		view = new SitesView(sites, new AbortController().signal, { access: admin });
		document.body.append(view.el);
		await settle();
		expect(
			[shop, draft, app].map((site) => [
				control(site.id, "copy-link")?.textContent,
				rowOf(site.id)?.querySelector<HTMLAnchorElement>("a.site-link-open")?.href,
			]),
		).toEqual([
			["sites.qorpera.com/wristband-shop", shop.url],
			["sites.qorpera.com/launch-page", draft.url],
			["saml-shop-preview.qorpera.com", app.url],
		]);
	});

	it("reads and draws websites at addresses of their own beside today's links; a look before going live fails the list", async () => {
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
		view = new SitesView(sites, new AbortController().signal, { access: admin });
		document.body.append(view.el);
		await settle();
		expect(
			[own, gift, app].map((site) => [
				control(site.id, "copy-link")?.textContent,
				rowOf(site.id)?.querySelector<HTMLAnchorElement>("a.site-link-open")?.href,
			]),
		).toEqual([
			["wristband-shop.qorpera.com", own.url],
			["sites.qorpera.com/gift-message", gift.url],
			["saml-shop-preview.qorpera.com", app.url],
		]);
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

	it("draws a site Qorpera took down through the real calls, the rest as today", async () => {
		const cloud = cloudWith((name) =>
			name === "qorpera_company_site_access"
				? {
						schema: "qorpera.company-site-access/v1",
						hosts: false,
						sites: [
							{ siteId: shop.id, takenDown: { at: timestamp, reason: "Spam" } },
							{ siteId: app.id, takenDown: null },
						],
					}
				: [row(), appRow()],
		);
		view = new SitesView(createWebSites(cloud, { profileId: id(10) }), new AbortController().signal, {
			access: admin,
		});
		document.body.append(view.el);
		await settle();
		expect(cloud.rpc.mock.calls.map(([name]) => name).sort()).toEqual([
			"qorpera_company_site_access",
			"qorpera_list_company_sites",
		]);
		expect(rowOf(shop.id)?.querySelector(".site-down")?.textContent).toBe(
			"Qorpera took this site down: Spam. If you think this is wrong, tell us with Feedback in your menu.",
		);
		expect(rowOf(shop.id)?.querySelector("a")).toBeNull();
		expect(control(app.id, "copy-link")?.textContent).toBe("saml-shop-preview.qorpera.com");
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

describe("Sites: a website made private here", () => {
	it("turns the website's rail line into Not live yet", async () => {
		const company = new Store<CompanyState>({ loading: false } as CompanyState);
		company.set({ siteList: [shop], siteListUnread: false });
		let isPublic = true;
		const hostingState = (): CompanySiteHostingState => ({
			hostsDomain: "qorpera.com",
			hostsEnabled: true,
			publicEnabled: true,
			domainsEnabled: false,
			edgeIpv4: null,
			edgeIpv6: null,
			edgeCnameTarget: null,
			sites: new Map([
				[
					shop.id,
					{
						siteId: shop.id,
						slug: shop.slug,
						isPublic,
						deploymentKind: "static",
						storageMode: "db",
						liveDeploymentId: null,
						domains: [],
					},
				],
			]),
		});
		const hosting: WebSiteHosting = {
			read: vi.fn(async () => hostingState()),
			setPublic: vi.fn(async (_siteId: string, next: boolean) => {
				isPublic = next;
				return next;
			}),
			addDomain: vi.fn(),
			removeDomain: vi.fn(),
			setPrimaryDomain: vi.fn(),
			recheckDomain: vi.fn(),
		};
		const surfaces = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [
					summary({ siteSlug: shop.slug, liveUrl: shop.url, activeSessionCount: 0 }),
				]),
				getSurfaceWorkspace: vi.fn(async () => workspace([])),
			}),
		);
		await surfaces.load();
		const rail = new SurfaceRail(surfaces, COMPANY, new AbortController().signal, undefined, undefined, (surface) =>
			siteAnswer(company.get(), surface),
		);
		const line = () => {
			rail.update(undefined);
			return rail.el.querySelector(".rail-surface-sub")?.textContent;
		};
		setup([shop], admin, undefined, { hosting: hostingNotingPublic(company, hosting) });
		await settle();
		expect(line()).toBe("Live · sites.qorpera.com");
		press(shop.id, "more");
		choose("Make it not live");
		await settle();
		expect(hosting.setPublic).toHaveBeenCalledWith(shop.id, false, expect.any(AbortSignal));
		expect(line()).toBe("Not live yet");
		surfaces.dispose();
	});
});

describe("Sites: a website has no password, an app link keeps its own", () => {
	const summer: CompanySite = {
		...shop,
		id: id(88),
		slug: "summer-sale",
		title: "Summer sale",
		url: `${ORIGIN}/summer-sale/`,
	};
	const hostingOf = (shown: Record<string, boolean>, fail = false) => {
		const known = { ...shown };
		const state = (): CompanySiteHostingState => ({
			hostsDomain: "qorpera.com",
			hostsEnabled: true,
			publicEnabled: true,
			domainsEnabled: false,
			edgeIpv4: null,
			edgeIpv6: null,
			edgeCnameTarget: null,
			sites: new Map(
				[shop, summer, app].map((site) => [
					site.id,
					{
						siteId: site.id,
						slug: site.slug,
						isPublic: known[site.id] === true,
						deploymentKind: "static" as const,
						storageMode: "db" as const,
						liveDeploymentId: null,
						domains: [],
					},
				]),
			),
		});
		const hosting: WebSiteHosting = {
			read: vi.fn(async () => state()),
			setPublic: vi.fn(async (siteId: string, next: boolean) => {
				if (fail) throw new Error("offline");
				known[siteId] = next;
				return next;
			}),
			addDomain: vi.fn(),
			removeDomain: vi.fn(),
			setPrimaryDomain: vi.fn(),
			recheckDomain: vi.fn(),
		};
		return hosting;
	};
	const badge = (siteId: string) => rowOf(siteId)?.querySelector(".site-public-badge")?.textContent ?? null;
	const word = (siteId: string) => rowOf(siteId)?.querySelector(".site-state")?.textContent ?? null;

	it("calls a website Live only when everyone can open it, and Not live yet otherwise; an app link Public", async () => {
		const { client } = setup([shop, summer, app], admin, undefined, { hosting: hostingOf({ [shop.id]: true }) });
		await settle();
		expect([badge(shop.id), word(shop.id)]).toEqual(["Live", null]);
		expect(rowOf(shop.id)?.querySelector<HTMLElement>(".site-public-badge")?.title).toMatch(
			/^Published .+ by Co-Founder$/,
		);
		expect([badge(summer.id), word(summer.id)]).toEqual(["Not live yet", null]);
		expect([badge(app.id), word(app.id)]).toEqual([null, "Live"]);
		for (const site of [shop, summer]) {
			expect(rowOf(site.id)?.querySelector(".site-secret")).toBeNull();
			expect(rowOf(site.id)?.textContent).not.toMatch(/password|Public/i);
		}
		expect(secretOf(app.id)).toBe(DOTS);
		press(shop.id, "more");
		expect(menuLabels().map((item) => item.label)).toEqual(["Make it not live", "Take offline"]);
		openMenu()?.close();
		press(summer.id, "more");
		expect(menuLabels().map((item) => item.label)).toEqual(["Go live", "Take offline"]);
		openMenu()?.close();
		press(app.id, "more");
		expect(menuLabels().map((item) => item.label)).toEqual(["Change password", "Make public", "Take offline"]);
		openMenu()?.close();
		expect(client.password).not.toHaveBeenCalled();
	});

	it("calls a website nothing while whether everyone can open it is unknown, then what the read says", async () => {
		const hosting = hostingOf({ [shop.id]: true });
		const ready = await hosting.read();
		const held = deferred<CompanySiteHostingState>();
		vi.mocked(hosting.read).mockImplementationOnce(() => held.promise);
		setup([shop, summer, draft, app], admin, undefined, { hosting });
		await settle();
		expect([word(shop.id), badge(shop.id)]).toEqual([null, null]);
		expect([word(summer.id), badge(summer.id)]).toEqual([null, null]);
		expect(word(draft.id)).toBe("Publishing…");
		expect([word(app.id), badge(app.id)]).toEqual(["Live", null]);
		held.resolve(ready);
		await settle();
		expect([word(shop.id), badge(shop.id)]).toEqual([null, "Live"]);
		expect([word(summer.id), badge(summer.id)]).toEqual([null, "Not live yet"]);
		expect(word(draft.id)).toBe("Publishing…");
		expect([word(app.id), badge(app.id)]).toEqual(["Live", null]);
	});

	it("puts a website live and takes it back in the owner's words, and an app link public as before", async () => {
		const hosting = hostingOf({});
		setup([summer, app], admin, undefined, { hosting });
		await settle();
		press(summer.id, "more");
		choose("Go live");
		await settle();
		expect(hosting.setPublic).toHaveBeenLastCalledWith(summer.id, true, expect.any(AbortSignal));
		expect(toast()).toBe("The site is live.");
		expect(badge(summer.id)).toBe("Live");
		press(summer.id, "more");
		choose("Make it not live");
		await settle();
		expect(hosting.setPublic).toHaveBeenLastCalledWith(summer.id, false, expect.any(AbortSignal));
		expect(toast()).toBe("The site is not live any more.");
		expect(badge(summer.id)).toBe("Not live yet");
		press(app.id, "more");
		choose("Make public");
		await settle();
		expect(toast()).toBe("The site is now public.");
		expect(badge(app.id)).toBe("Public");
		press(app.id, "more");
		choose("Make private");
		await settle();
		expect(toast()).toBe("The site is now private.");
		expect(badge(app.id)).toBeNull();
	});

	it("says a website did not go live, or is still live, when the change fails", async () => {
		setup([shop, summer, app], admin, undefined, { hosting: hostingOf({ [shop.id]: true }, true) });
		await settle();
		press(summer.id, "more");
		choose("Go live");
		await settle();
		expect(toast()).toBe("The site did not go live. Try again.");
		press(shop.id, "more");
		choose("Make it not live");
		await settle();
		expect(toast()).toBe("The site is still live. Try again.");
		press(app.id, "more");
		choose("Make public");
		await settle();
		expect(toast()).toBe("Site visibility could not be changed. Try again.");
	});

	it("says it all in Danish", async () => {
		setLanguagePreference("da");
		try {
			setup([shop, summer, app], admin, undefined, { hosting: hostingOf({ [shop.id]: true, [app.id]: true }) });
			await settle();
			expect([badge(shop.id), badge(summer.id), badge(app.id)]).toEqual(["Live", "Ikke live endnu", "Offentlig"]);
			expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
				"Del en hjemmeside med dens link, når den er live. Et app-link skal også bruge sin adgangskode.",
			);
			press(summer.id, "more");
			expect(menuLabels().map((item) => item.label)).toEqual(["Gå live", "Tag offline"]);
			openMenu()?.close();
			press(shop.id, "more");
			expect(menuLabels().map((item) => item.label)).toEqual(["Slå live fra", "Tag offline"]);
			choose("Slå live fra");
			await settle();
			expect(toast()).toBe("Hjemmesiden er ikke live længere.");
			press(app.id, "more");
			expect(menuLabels().map((item) => item.label)).toEqual(["Skift adgangskode", "Gør privat", "Tag offline"]);
		} finally {
			setLanguagePreference("system");
		}
	});
});
