// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { SitesView } from "../src/app/views/settings-sites.ts";
import { ThreadSites, type ThreadSitesClient } from "../src/app/views/thread-sites.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CompanySite, CompanySiteAccess, CompanySitePassword } from "../src/cloud/sites.ts";
import { siteOfLink } from "../src/cloud/sites.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
import conversationCss from "../src/styles/conversation.css?raw";
import sitesCss from "../src/styles/sites.css?raw";
import { type LinkedSite, markdownBubbles } from "../src/ui/markdown.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

/* A site a message links, as the Sites page's row under the words (own code storage, thread pieces): which links lead to
 * the company's own sites, the card's markup and calls (the Sites page's own), who sees the password, a site Qorpera
 * took down, and the thread that draws it. */

const PASSWORD = "k7mq-x2pa-9fhd";
const DOTS = "••••••••••••";

/** A project's site at an address of its own (step 5.1). */
const gift: CompanySite = {
	id: id(81),
	slug: "saml-gift-message",
	title: "SAML gift message",
	kind: "files",
	url: "https://saml-gift-message.qorpera.com/",
	state: "live",
	source: "code/qorpera/saml-gift-message",
	files: 12,
	bytes: 2048,
	publishedAt: timestamp,
	publishedBy: null,
	createdAt: timestamp,
	passwordChangedAt: timestamp,
	machine: null,
	port: null,
};
/** A website still on the old sites host. */
const shop: CompanySite = {
	...gift,
	id: id(82),
	slug: "wristband-shop",
	title: "Wristband shop",
	url: "https://sites.qorpera.com/wristband-shop/",
	source: "product/shop",
};
/** An app link (v195): one port of a machine, at its own host. */
const app: CompanySite = {
	...gift,
	id: id(83),
	slug: "orders-api",
	title: "Orders API",
	kind: "app",
	url: "https://orders-api-preview.qorpera.com/",
	source: "orders",
	machine: "orders",
	port: 3000,
};
/** A website Qorpera took down. */
const old: CompanySite = {
	...gift,
	id: id(84),
	slug: "spring-sale",
	title: "Spring sale",
	url: "https://spring-sale.qorpera.com/",
	source: "marketing/spring",
};
const REASON = "It asked visitors for bank passwords";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	Reflect.deleteProperty(navigator, "clipboard");
	setLanguagePreference("system");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function client(sites: CompanySite[] = [gift, shop, app, old], options: { down?: boolean } = {}) {
	const access: CompanySiteAccess = {
		takenDown: new Map(options.down === false ? [] : [[old.id, { at: timestamp, reason: REASON }]]),
		named: new Map(),
	};
	return {
		list: vi.fn(async () => structuredClone(sites)),
		password: vi.fn(
			async (siteId: string): Promise<CompanySitePassword> => ({ siteId, password: PASSWORD, changedAt: timestamp }),
		),
		access: vi.fn(async () => access),
	} satisfies ThreadSitesClient;
}

async function cards(manage = true, calls: ThreadSitesClient = client()) {
	const changed = vi.fn();
	const lifetime = new AbortController();
	const sites = new ThreadSites(calls, () => manage, lifetime.signal, changed);
	cleanup.push(() => lifetime.abort());
	await settle();
	return { sites, changed, calls };
}

/** An agent's message drawn as a thread draws it, with the sites' cards. */
function message(sites: ThreadSites, text: string): HTMLElement {
	const root = h("article");
	const linked = (href: string): LinkedSite | undefined => {
		const site = sites.match(href);
		return site && { id: site.id, card: () => sites.card(site) };
	};
	for (const part of markdownBubbles(text, linked)) root.append(h("div", "bubble", part));
	document.body.append(root);
	return root;
}

function h(tag: string, className?: string, child?: Node): HTMLElement {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (child) element.append(child);
	return element;
}

const focusKey = (root: ParentNode, key: string) => root.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);

describe("A site a message links: which links", () => {
	const list = [gift, shop, app];
	it("finds a website by its own host or its old link, and an app link by its host", () => {
		expect(siteOfLink(list, "https://saml-gift-message.qorpera.com/")?.id).toBe(gift.id);
		expect(siteOfLink(list, "https://saml-gift-message.qorpera.com/checkout?step=2#gift")?.id).toBe(gift.id);
		// The old link of a site at an address of its own now, and of one still there.
		expect(siteOfLink(list, "https://sites.qorpera.com/saml-gift-message/")?.id).toBe(gift.id);
		expect(siteOfLink(list, "https://sites.qorpera.com/wristband-shop/cart")?.id).toBe(shop.id);
		expect(siteOfLink(list, "https://sites.qorpera.com/wristband-shop")?.id).toBe(shop.id);
		expect(siteOfLink(list, "https://orders-api-preview.qorpera.com/orders/7")?.id).toBe(app.id);
	});

	it("never guesses: another host, a next host, a name the list does not have, or a link not plain https is none", () => {
		for (const href of [
			"https://example.com/saml-gift-message/",
			// Look first's host is no address of the site's to share.
			"https://saml-gift-message--next.qorpera.com/",
			"https://other-site.qorpera.com/",
			"https://sites.qorpera.com/other-site/",
			"https://sites.qorpera.com/wristband-shopper/",
			"http://saml-gift-message.qorpera.com/",
			"https://saml-gift-message.qorpera.com:8443/",
			"https://someone:pw@saml-gift-message.qorpera.com/",
			"https://orders-api-preview.qorpera.com.evil.example/",
			"mailto:hello@saml-gift-message.qorpera.com",
			"not a link",
		])
			expect(siteOfLink(list, href), href).toBeUndefined();
		expect(siteOfLink([], "https://saml-gift-message.qorpera.com/")).toBeUndefined();
	});
});

describe("A site a message links: the card under the words", () => {
	it("keeps the link a link in the words, and draws the site's card in a row of its own under them", async () => {
		const { sites } = await cards();
		const root = message(sites, "Your change is live at [the gift page](https://saml-gift-message.qorpera.com/).");
		const parts = [...root.children];
		expect(parts.map((part) => part.firstElementChild?.className)).toEqual(["message-prose", "app-cards site-cards"]);
		const word = parts[0]!.querySelector<HTMLAnchorElement>("a.site-link-word")!;
		expect(word.textContent).toBe("the gift page");
		expect(word.href).toBe("https://saml-gift-message.qorpera.com/");
		expect(word.target).toBe("_blank");
		expect(word.rel).toBe("noopener noreferrer");
		// The row has no bubble paint (as an app's card's row), and holds the Sites page's row, compact.
		expect(conversationCss).toContain(".bubble:has(> .app-cards)");
		const card = parts[1]!.querySelector<HTMLElement>(".site-cards > .site-card")!;
		const row = card.querySelector<HTMLElement>(":scope > article.site-row.is-thread.is-live")!;
		expect(row.dataset.site).toBe(gift.id);
		expect(row.getAttribute("aria-label")).toBe("SAML gift message");
		expect(row.querySelector("svg.site-emblem")).not.toBeNull();
		expect(row.querySelector(".site-name")?.textContent).toBe("SAML gift message");
		expect(row.querySelector(".site-state")?.textContent).toBe("Live");
		expect(focusKey(row, `site-copy-link:${gift.id}`)?.textContent).toBe("saml-gift-message.qorpera.com");
		expect(row.querySelector<HTMLAnchorElement>("a.site-link-open")?.href).toBe(gift.url);
		expect(row.querySelector(".site-secret-text")?.textContent).toBe(DOTS);
		// What is rare stays on the Sites page: no menu, no version, no machinery.
		expect(row.querySelector(".site-more, .site-from")).toBeNull();
		expect(row.textContent).not.toMatch(/code\/|qorpera\/|files|KiB/);
	});

	it("draws the Sites page's own row: the same markup, classes and controls", async () => {
		const calls = client([gift], { down: false });
		const { sites } = await cards(true, calls);
		const card = sites.card(gift);
		const page = new SitesView({ ...calls, setPassword: vi.fn(), unpublish: vi.fn() }, new AbortController().signal, {
			access: { canManage: () => true },
		});
		cleanup.push(() => page.dispose());
		document.body.append(page.el, card);
		await settle();
		const pageRow = page.el.querySelector<HTMLElement>(`[data-site="${gift.id}"]`)!;
		const shape = (row: Element) =>
			[...row.querySelectorAll("*")].map((node) => [node.tagName, node.getAttribute("class"), node.textContent]);
		const threadRow = card.querySelector(".site-row")!;
		// The same row, but for the page's menu and its version line; the thread's is marked compact.
		pageRow.querySelector(".site-more")?.remove();
		expect(shape(threadRow)).toEqual(shape(pageRow));
		expect(threadRow.className).toBe("site-row is-live is-thread");
	});

	it("shows each site once per message, and two sites side by side", async () => {
		const { sites } = await cards();
		const root = message(
			sites,
			[
				"The shop: https://sites.qorpera.com/wristband-shop/ and its cart https://sites.qorpera.com/wristband-shop/cart.",
				"",
				"- The new page: <https://saml-gift-message.qorpera.com/>",
				"- Again the shop: [here](https://sites.qorpera.com/wristband-shop/)",
				"",
				"Not ours: https://example.com/.",
			].join("\n"),
		);
		const rows = [...root.querySelectorAll(".site-cards")];
		expect(
			rows.map((row) => [...row.querySelectorAll<HTMLElement>(".site-row")].map((item) => item.dataset.site)),
		).toEqual([[shop.id], [gift.id]]);
		// Each row stands right after the words that link it.
		expect([...root.children].map((part) => part.firstElementChild?.className)).toEqual([
			"message-prose",
			"app-cards site-cards",
			"message-prose",
			"app-cards site-cards",
			"message-prose",
		]);
		// A link to anything else stays a plain link.
		const plain = [...root.querySelectorAll<HTMLAnchorElement>("a")].find(
			(link) => link.href === "https://example.com/",
		);
		expect(plain?.className).toBe("");
		// Without the company's sites, every link is plain, as before.
		expect(
			markdownBubbles("See https://sites.qorpera.com/wristband-shop/.").some((part) => part.matches(".app-cards")),
		).toBe(false);
	});

	it("shows an app link's card, and a site Qorpera took down with the Sites page's sentence and no link or password", async () => {
		const { sites } = await cards();
		const root = message(
			sites,
			"The API: https://orders-api-preview.qorpera.com/ and the sale https://spring-sale.qorpera.com/",
		);
		const [api, sale] = [...root.querySelectorAll<HTMLElement>(".site-row")];
		expect(api?.dataset.site).toBe(app.id);
		expect(api?.querySelector(".site-name")?.textContent).toBe("Orders API");
		expect(api?.querySelector(".site-pill-text")?.textContent).toBe("orders-api-preview.qorpera.com");
		expect(sale?.className).toBe("site-row is-down is-thread");
		expect(sale?.querySelector(".site-state")?.textContent).toBe("Taken down");
		expect(sale?.querySelector(".site-down")?.textContent).toBe(
			`Qorpera took this site down: ${REASON}. If you think this is wrong, tell us with Feedback in your menu.`,
		);
		expect(sale?.querySelector(".site-share, .site-link-open, .site-secret")).toBeNull();
	});

	it("shows and hides the password with the eye for an owner or admin, through the Sites page's call", async () => {
		const { sites, calls } = await cards();
		const root = message(
			sites,
			"Look: https://saml-gift-message.qorpera.com/ and again https://saml-gift-message.qorpera.com/",
		);
		const extra = message(sites, "Same site, another message: https://saml-gift-message.qorpera.com/");
		const eye = focusKey(root, `site-eye:${gift.id}`)!;
		expect(eye.getAttribute("aria-label")).toBe("Show password");
		eye.click();
		await settle();
		expect(calls.password).toHaveBeenCalledWith(gift.id, expect.any(AbortSignal));
		expect(root.querySelector(".site-secret-text")?.textContent).toBe(PASSWORD);
		// Every card of the site in the thread shows it.
		expect(extra.querySelector(".site-secret-text")?.textContent).toBe(PASSWORD);
		expect(document.activeElement).toBe(focusKey(root, `site-eye:${gift.id}`));
		focusKey(root, `site-eye:${gift.id}`)!.click();
		await settle();
		expect(root.querySelector(".site-secret-text")?.textContent).toBe(DOTS);
		expect(extra.querySelector(".site-secret-text")?.textContent).toBe(DOTS);
		expect(focusKey(root, `site-eye:${gift.id}`)?.getAttribute("aria-label")).toBe("Show password");
	});

	it("shows a member who may not see passwords the link alone", async () => {
		const { sites, calls } = await cards(false);
		const root = message(sites, "https://saml-gift-message.qorpera.com/");
		expect(root.querySelector(".site-link")).not.toBeNull();
		expect(root.querySelector(".site-secret, .site-eye")).toBeNull();
		expect(calls.password).not.toHaveBeenCalled();
	});

	it("takes a shown password away when the member's authority goes", async () => {
		let manage = true;
		const lifetime = new AbortController();
		cleanup.push(() => lifetime.abort());
		const sites = new ThreadSites(
			client(),
			() => manage,
			lifetime.signal,
			() => {},
		);
		await settle();
		const root = message(sites, "https://saml-gift-message.qorpera.com/");
		focusKey(root, `site-eye:${gift.id}`)!.click();
		await settle();
		expect(root.querySelector(".site-secret-text")?.textContent).toBe(PASSWORD);
		manage = false;
		sites.update();
		expect(root.querySelector(".site-secret")).toBeNull();
		expect(root.textContent).not.toContain(PASSWORD);
	});

	it("shows nothing a read answers after the member's authority went while it was out", async () => {
		const answer = deferred<CompanySitePassword>();
		const calls = client();
		calls.password.mockImplementationOnce(() => answer.promise);
		let manage = true;
		const lifetime = new AbortController();
		cleanup.push(() => lifetime.abort());
		const sites = new ThreadSites(
			calls,
			() => manage,
			lifetime.signal,
			() => {},
		);
		await settle();
		const root = message(sites, "https://saml-gift-message.qorpera.com/");
		focusKey(root, `site-eye:${gift.id}`)!.click();
		await settle();
		// While it is read, the password's pill breathes and its controls are off.
		expect(root.querySelector(".site-secret.is-reading")).not.toBeNull();
		expect((focusKey(root, `site-eye:${gift.id}`) as HTMLButtonElement).disabled).toBe(true);
		manage = false;
		sites.update();
		manage = true;
		sites.update();
		answer.resolve({ siteId: gift.id, password: PASSWORD, changedAt: timestamp });
		await settle();
		expect(root.textContent).not.toContain(PASSWORD);
		expect(root.querySelector(".site-secret-text")?.textContent).toBe(DOTS);
	});

	it("copies the link and a hidden password, and says under the card when a password could not be read", async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const calls = client();
		const { sites } = await cards(true, calls);
		const root = message(sites, "https://saml-gift-message.qorpera.com/");
		focusKey(root, `site-copy-link:${gift.id}`)!.click();
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(gift.url);
		expect(focusKey(root, `site-copy-link:${gift.id}`)?.classList.contains("is-copied")).toBe(true);
		focusKey(root, `site-copy-password:${gift.id}`)!.click();
		await settle();
		expect(writeText).toHaveBeenLastCalledWith(PASSWORD);
		// Copied without showing it.
		expect(root.querySelector(".site-secret-text")?.textContent).toBe(DOTS);
		calls.password.mockRejectedValueOnce(new CloudRpcError("x", { message: "denied", code: "42501" }, 403));
		focusKey(root, `site-eye:${gift.id}`)!.click();
		await settle();
		expect(root.querySelector(".site-card-said")?.textContent).toBe(
			"Only founders and admins can see passwords or take sites offline.",
		);
		expect(root.textContent).not.toContain("42501");
	});

	it("shows the link whole to copy by hand when the browser will not copy it", async () => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
		});
		const { sites } = await cards();
		const root = message(sites, "https://saml-gift-message.qorpera.com/");
		focusKey(root, `site-copy-link:${gift.id}`)!.click();
		await settle();
		const field = focusKey(root, `site-by-hand:link:${gift.id}`) as HTMLInputElement;
		expect(field.value).toBe(gift.url);
		expect(document.activeElement).toBe(field);
		expect(root.querySelector(".site-card-said")?.textContent).toMatch(/^Press (⌘C|Ctrl\+C) to copy\.$/);
	});

	it("says it in Danish", async () => {
		setLanguagePreference("da");
		const { sites } = await cards();
		const root = message(sites, "https://saml-gift-message.qorpera.com/ https://spring-sale.qorpera.com/");
		const [live, down] = [...root.querySelectorAll<HTMLElement>(".site-row")];
		expect(live?.querySelector(".site-state")?.textContent).toBe("Live");
		expect(focusKey(live!, `site-eye:${gift.id}`)?.getAttribute("aria-label")).toBe("Vis adgangskode");
		expect(down?.querySelector(".site-state")?.textContent).toBe("Taget ned");
	});

	it("lays the card out by its own width, compact, and keeps the Sites page's rules as they were", () => {
		expect(sitesCss).toMatch(/\.site-card \{[^}]*container: site-rows \/ inline-size/);
		expect(sitesCss).toMatch(/\.site-row\.is-thread \{[^}]*border: 1px solid var\(--border\)/);
		expect(sitesCss).toContain(":is(.sites, .whats-new) {");
		expect(conversationCss).toMatch(/\.message-prose a\.site-link-word \{ color: inherit; font-weight: 600;/);
	});
});

describe("A site a message links, in a thread", () => {
	/** A thread with one message, drawn once the thread's own reads (its transcript, the company's sites) answered. */
	async function thread(text: string, options: { siteCount?: number; mine?: boolean } = {}) {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			team,
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
			siteCount: options.siteCount ?? 4,
		});
		const calls = client();
		const view = new ConversationView(company, session.sessionId, {
			companySites: { client: calls, canManage: () => true },
		});
		document.body.append(view.el);
		cleanup.push(() => {
			view.dispose();
			company.stop();
		});
		const item: TranscriptMessage = options.mine
			? {
					kind: "member",
					id: id(70),
					sequence: 1,
					text,
					attachmentCount: 0,
					authorUserId: userA.id,
					createdAt: timestamp,
				}
			: { kind: "agent", id: id(70), sequence: 1, text, attachmentCount: 0, createdAt: timestamp };
		await settle();
		company.conversation(session.sessionId).set({
			loading: false,
			projection: { items: [item], hiddenCount: 0, lastSequence: 1 },
		});
		view.update();
		return { view, calls };
	}

	it("draws an agent's message with its site's card once the company's sites are read", async () => {
		const { view, calls } = await thread("It is live: https://saml-gift-message.qorpera.com/");
		expect(calls.list).toHaveBeenCalledOnce();
		const message = view.el.querySelector<HTMLElement>("article.message")!;
		const parts = [...message.querySelectorAll(":scope > .bubble")].map((part) => part.firstElementChild?.className);
		expect(parts).toEqual(["message-prose", "app-cards site-cards"]);
		expect(message.querySelector(".site-row .site-name")?.textContent).toBe("SAML gift message");
		expect(message.querySelector("a.site-link-word")?.textContent).toBe("https://saml-gift-message.qorpera.com/");
	});

	it("draws a member's message with its site's card under the member's words", async () => {
		const { view } = await thread("Is https://sites.qorpera.com/wristband-shop/ right?", { mine: true });
		const message = view.el.querySelector<HTMLElement>("article.message.mine")!;
		const parts = [...message.querySelectorAll(":scope > .bubble")].map((part) => part.firstElementChild?.className);
		expect(parts).toEqual(["text", "app-cards site-cards"]);
		expect(message.querySelector(".site-row")?.getAttribute("aria-label")).toBe("Wristband shop");
	});

	it("reads no sites while the company has none, and draws the link as before", async () => {
		const { view, calls } = await thread("https://saml-gift-message.qorpera.com/", { siteCount: 0 });
		expect(calls.list).not.toHaveBeenCalled();
		expect(view.el.querySelector(".site-cards, .site-link-word")).toBeNull();
		expect(view.el.querySelector<HTMLAnchorElement>(".message-prose a")?.href).toBe(
			"https://saml-gift-message.qorpera.com/",
		);
	});
});
