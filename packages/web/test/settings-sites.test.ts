// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SitesAccess, SitesView, shownLink } from "../src/app/views/settings-sites.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CompanySite,
	type CompanySitePassword,
	createWebSites,
	parseCompanySite,
	parseCompanySitePassword,
	type WebSites,
} from "../src/cloud/sites.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { deferred, id, settle, timestamp } from "./fixtures.ts";

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
	options: { versions?: Record<string, number>; mascot?: () => HTMLElement } = {},
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
	it("draws each site as one row: the globe, its title and state, its link to copy and open, its password hidden", async () => {
		setup([shop, draft]);
		expect(view!.el.textContent).toContain("Checking…");
		await settle();
		expect(ids()).toEqual([shop.id, draft.id]);
		expect(view!.el.querySelector("h1")?.textContent).toBe("Sites");
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe("Share a site with its link and password.");

		const row = rowOf(shop.id)!;
		expect(row.getAttribute("aria-label")).toBe("Wristband shop");
		expect(row.querySelector("svg.site-emblem")).not.toBeNull();
		expect(row.querySelector(".site-name")?.textContent).toBe("Wristband shop");
		// The state is a dot and a word; when and by whom it was published is its tip. No sizes, file counts or folders.
		const state = row.querySelector<HTMLElement>(".site-state")!;
		expect(state.textContent).toBe("Live");
		expect(state.title).toMatch(/^Published .+ by Co-Founder$/);
		expect(row.textContent).not.toMatch(/files|KiB|product\/|From /);
		// The link, as the page shows it, copies on a press; the arrow opens the site in a new tab.
		expect(control(shop.id, "copy-link")?.textContent).toBe("sites.qorpera.com/wristband-shop");
		expect(control(shop.id, "copy-link")?.title).toBe("Copy the link");
		const open = row.querySelector<HTMLAnchorElement>("a.site-link-open")!;
		expect(open.href).toBe(shop.url);
		expect(open.target).toBe("_blank");
		expect(open.rel).toBe("noopener noreferrer");
		expect(open.getAttribute("aria-label")).toBe("Open the site");
		// The password sits beside it as dots, with an eye; nothing is read until asked for.
		expect(secretOf(shop.id)).toBe(DOTS);
		expect(control(shop.id, "copy-password")?.getAttribute("aria-label")).toBe("Copy the password");
		expect(control(shop.id, "eye")?.getAttribute("aria-label")).toBe("Show password");
		expect(control(shop.id, "more")?.getAttribute("aria-label")).toBe("More options for Wristband shop");
		expect(control(shop.id, "more")?.getAttribute("aria-haspopup")).toBe("menu");
		// Every rare thing is in the menu: the row has no other button.
		expect(buttonsIn(row)).toHaveLength(4);

		// A site still publishing goes by its name in the link.
		const publishing = rowOf(draft.id)!;
		expect(publishing.querySelector(".site-name")?.textContent).toBe("launch-page");
		expect(publishing.querySelector(".site-state")?.textContent).toBe("Publishing…");
		expect(publishing.querySelector<HTMLElement>(".site-state")?.title).toBe("");
	});

	it("shows an app link at its own host, and a site that is off", async () => {
		setup([app, { ...app, id: id(84), slug: "old-shop", title: null, state: "off", machine: null, port: 8080 }]);
		await settle();
		expect(control(app.id, "copy-link")?.textContent).toBe("saml-shop-preview.qorpera.com");
		expect(rowOf(app.id)?.querySelector<HTMLAnchorElement>("a.site-link-open")?.href).toBe(app.url);
		// No machine or port is named to a founder.
		expect(rowOf(app.id)?.textContent).not.toMatch(/port|machine|shop-server/);
		expect(rowOf(id(84))?.querySelector(".site-state")?.textContent).toBe("Off");
		expect(shownLink("https://sites.qorpera.com/a-b/")).toBe("sites.qorpera.com/a-b");
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
		const { client } = setup([shop, draft], admin, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(shop.id, "eye");
		// While it is read, the password pills and menus are off; the link still copies.
		expect(rowOf(shop.id)?.querySelector(".site-secret.is-reading")).not.toBeNull();
		expect((control(draft.id, "eye") as HTMLButtonElement).disabled).toBe(true);
		expect((control(draft.id, "more") as HTMLButtonElement).disabled).toBe(true);
		expect((control(shop.id, "copy-link") as HTMLButtonElement).disabled).toBe(false);
		read.resolve({ siteId: shop.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(client.password).toHaveBeenCalledWith(shop.id, expect.any(AbortSignal));
		expect(secretOf(shop.id)).toBe(PASSWORD);
		expect(control(shop.id, "eye")?.getAttribute("aria-label")).toBe("Hide password");
		// Shown, the copy pill is named by the password itself.
		expect(control(shop.id, "copy-password")?.hasAttribute("aria-label")).toBe(false);
		expect(focusKey()).toBe(`site-eye:${shop.id}`);
		expect(secretOf(draft.id)).toBe(DOTS);

		press(shop.id, "eye");
		expect(secretOf(shop.id)).toBe(DOTS);
		expect(control(shop.id, "eye")?.getAttribute("aria-label")).toBe("Show password");
		expect(focusKey()).toBe(`site-eye:${shop.id}`);
		expect(view!.el.textContent).not.toContain(PASSWORD);
	});

	it("says why a password could not be read, keeping the focus on the eye", async () => {
		setup([shop], admin, (client) => {
			vi.mocked(client.password)
				.mockRejectedValueOnce(
					new CloudRpcError("qorpera_company_site_password", { message: "denied", code: "42501" }),
				)
				.mockRejectedValueOnce(new Error("offline"));
		});
		await settle();
		press(shop.id, "eye");
		await settle();
		expect(toast()).toBe("Only founders and admins can see passwords or take sites offline.");
		expect(focusKey()).toBe(`site-eye:${shop.id}`);
		press(shop.id, "eye");
		await settle();
		expect(toast()).toBe("The password could not be read. Try again.");
		expect(secretOf(shop.id)).toBe(DOTS);
	});

	it("copies a hidden password without showing it, and a shown one as it stands", async () => {
		const write = clipboard();
		const { client } = setup([shop]);
		await settle();
		press(shop.id, "copy-password");
		await settle();
		expect(client.password).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith(PASSWORD);
		expect(toast()).toBe("The password is copied.");
		expect(secretOf(shop.id)).toBe(DOTS);
		expect(focusKey()).toBe(`site-copy-password:${shop.id}`);

		press(shop.id, "eye");
		await settle();
		write.mockClear();
		press(shop.id, "copy-password");
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
		setup([shop], admin, (client) => {
			vi.mocked(client.password).mockImplementationOnce(() => read.promise);
		});
		await settle();
		press(shop.id, "copy-password");
		// The press's own moment: the clipboard is asked before the read has come back.
		expect(write).toHaveBeenCalledTimes(1);
		read.resolve({ siteId: shop.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		const blob = await items[0]!.data["text/plain"];
		expect([blob?.type, blob?.size]).toEqual(["text/plain", PASSWORD.length]);
		expect(writeText).not.toHaveBeenCalled();
		expect(toast()).toBe("The password is copied.");
	});

	it("shows a password selected to copy by hand when the browser will not copy it", async () => {
		clipboard(refuse);
		setup([shop]);
		await settle();
		press(shop.id, "copy-password");
		await settle();
		const field = view!.el.querySelector<HTMLInputElement>(`[data-focus-key="site-by-hand:password:${shop.id}"]`)!;
		expect(field.value).toBe(PASSWORD);
		expect(document.activeElement).toBe(field);
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, PASSWORD.length]);
		expect(toast()).toMatch(/^Press (⌘|Ctrl\+)C to copy\.$/);
		// Hidden again, it leaves the page.
		press(shop.id, "eye");
		expect(view!.el.querySelector(".site-pill-field")).toBeNull();
		expect(view!.el.textContent).not.toContain(PASSWORD);
	});
});

describe("Sites: the menu and its questions", () => {
	it("keeps what is rare in one menu: Change password, and Take offline in red", async () => {
		setup([shop]);
		await settle();
		const more = control(shop.id, "more") as HTMLButtonElement;
		more.click();
		expect(more.getAttribute("aria-expanded")).toBe("true");
		expect(openMenu()?.el.getAttribute("aria-label")).toBe("Wristband shop");
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
		expect(focusKey()).toBe(`site-more:${shop.id}`);
		expect(control(shop.id, "more")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("changes a site's password to one the owner types, after checking it", async () => {
		const { client } = setup([shop]);
		await settle();
		press(shop.id, "more");
		choose("Change password");
		const form = question()!;
		const field = form.querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(field);
		expect(form.querySelector("h2")?.textContent).toBe("New password for Wristband shop");
		expect(field.getAttribute("aria-label")).toBe("New password for Wristband shop");
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
		expect(client.setPassword).toHaveBeenCalledWith(shop.id, "our friends only 2026", expect.any(AbortSignal));
		expect(question()).toBeNull();
		// The new password is shown, ready to copy, and the toast says it changed.
		expect(secretOf(shop.id)).toBe("our friends only 2026");
		expect(toast()).toBe("The password is changed.");
		expect(focusKey()).toBe(`site-copy-password:${shop.id}`);
		expect(client.list).toHaveBeenCalledTimes(2);
	});

	it("makes a new random password, says in the question why one was refused, and cancels with nothing sent", async () => {
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
		press(shop.id, "more");
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
		expect(client.setPassword).toHaveBeenLastCalledWith(shop.id, null, expect.any(AbortSignal));
		expect(form.querySelector('[role="alert"]')?.textContent).toBe("The password could not be changed. Try again.");

		pressLabel(form, "Make a new password");
		await settle();
		expect(client.setPassword).toHaveBeenCalledTimes(3);
		expect(question()).toBeNull();
		expect(secretOf(shop.id)).toBe("n3wp-4ss-w0rd");

		// Cancel, and Escape, close the question with nothing sent; the focus goes back to "⋯".
		press(shop.id, "more");
		choose("Change password");
		pressLabel(question()!, "Cancel");
		expect(question()).toBeNull();
		expect(focusKey()).toBe(`site-more:${shop.id}`);
		press(shop.id, "more");
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
			"Take Wristband shop offline? Its link stops working and its password is deleted. The files stay in the Company File.",
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
			"Take Gift message offline? Its earlier versions go with it. The newest one waits in What's new, with a new password, until you put it live.",
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
		const { client, state } = setup([shop, draft]);
		await settle();
		const read = deferred<CompanySite[]>();
		vi.mocked(client.list).mockImplementationOnce(() => read.promise);
		// The password change's own read is still out when the owner takes the other site offline: it saw both sites.
		press(shop.id, "more");
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
		expect(ids()).toEqual([shop.id]);
	});
});

describe("Sites: who may do what", () => {
	it("shows other members the sites and their links, without passwords or a menu", async () => {
		const role = { manage: false };
		const { client } = setup([shop], { canManage: () => role.manage });
		await settle();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		const row = rowOf(shop.id)!;
		expect(row.querySelector(".site-secret")).toBeNull();
		expect(control(shop.id, "more")).toBeNull();
		expect(buttonsIn(row).map((item) => item.dataset.focusKey)).toEqual([`site-copy-link:${shop.id}`]);
		expect(row.querySelector("a.site-link-open")).not.toBeNull();

		// The role arrives (or changes) after the page: it redraws with the password and the menu.
		role.manage = true;
		view!.update();
		expect(view!.el.querySelector(".sites-head p")?.textContent).toBe("Share a site with its link and password.");
		expect(secretOf(shop.id)).toBe(DOTS);
		press(shop.id, "eye");
		await settle();
		expect(secretOf(shop.id)).toBe(PASSWORD);
		press(shop.id, "more");
		choose("Change password");
		expect(question()).not.toBeNull();

		// A member who is no longer an owner or admin keeps no password on screen, and the question goes.
		role.manage = false;
		view!.update();
		expect(question()).toBeNull();
		expect(view!.el.textContent).not.toContain(PASSWORD);
		expect(rowOf(shop.id)?.querySelector(".site-secret")).toBeNull();
		role.manage = true;
		view!.update();
		expect(secretOf(shop.id)).toBe(DOTS);
		expect(client.password).toHaveBeenCalledTimes(1);
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
		// The old cards' rules are gone with the cards.
		expect(app).not.toContain("page-cards");
	});

	it("puts the pills under the globe on a narrow page, and What's new's buttons under its line", () => {
		const narrow = css.match(/@container site-rows not \(min-width: 36em\) \{([^@]*?)\n\}/)?.[1] ?? "";
		expect(narrow).toContain('.site-row { grid-template-areas: "emblem head end" "body body body"; }');
		const live = css.match(/@container site-rows not \(min-width: 40em\) \{([^@]*?)\n\}/)?.[1] ?? "";
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
