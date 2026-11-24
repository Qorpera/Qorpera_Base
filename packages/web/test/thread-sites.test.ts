// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type SiteAnswer } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { ThreadSites, type ThreadSitesClient } from "../src/app/views/thread-sites.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CompanySite, CompanySiteAccess, CompanySitePassword } from "../src/cloud/sites.ts";
import { siteOfLink } from "../src/cloud/sites.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
import conversationCss from "../src/styles/conversation.css?raw";
import { type LinkedSite, markdownBubbles } from "../src/ui/markdown.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

/* A site a message links, as one calm row under the words, a sibling of an app's card (own code storage, thread pieces):
 * which links lead to the company's own sites, the row, the owner's key that copies the password without ever showing
 * it, a site Qorpera took down, and the thread that draws it. */

const PASSWORD = "k7mq-x2pa-9fhd";

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

async function cards(
	manage = true,
	calls: ThreadSitesClient = client(),
	answer: (siteId: string) => SiteAnswer = () => "unknown",
) {
	const changed = vi.fn();
	const lifetime = new AbortController();
	const sites = new ThreadSites(calls, () => manage, lifetime.signal, changed, answer);
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

const keyOf = (root: ParentNode) => root.querySelector<HTMLButtonElement>(".site-card-key");
const note = (root: ParentNode) => root.querySelector(".app-card-note")?.textContent;

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
	it("keeps the link a link in the words, and draws the site as one row of its own under them, an app card's sibling", async () => {
		const { sites } = await cards();
		const root = message(sites, "Your change is live at [the gift page](https://saml-gift-message.qorpera.com/).");
		const parts = [...root.children];
		expect(parts.map((part) => part.firstElementChild?.className)).toEqual(["message-prose", "app-cards site-cards"]);
		const word = parts[0]!.querySelector<HTMLAnchorElement>("a.site-link-word")!;
		expect(word.textContent).toBe("the gift page");
		expect(word.href).toBe("https://saml-gift-message.qorpera.com/");
		expect(word.target).toBe("_blank");
		expect(word.rel).toBe("noopener noreferrer");
		// The row has no bubble paint, as an app card's row; the card wears the app card's own frame.
		expect(conversationCss).toContain(".bubble:has(> .app-cards)");
		const card = parts[1]!.querySelector<HTMLElement>(".site-cards > .app-card.site-card")!;
		expect(card.dataset.siteId).toBe(gift.id);
		// The whole row is the way to the site, in a new tab.
		const open = card.querySelector<HTMLAnchorElement>(":scope > a.site-card-open")!;
		expect(open.href).toBe(gift.url);
		expect(open.target).toBe("_blank");
		expect(open.rel).toBe("noopener noreferrer");
		expect(open.getAttribute("aria-label")).toBe("Open SAML gift message");
		expect(open.querySelector(".app-card-emblem svg.site-emblem")).not.toBeNull();
		expect(card.querySelector(".app-card-title")?.textContent).toBe("SAML gift message");
		expect(card.querySelector(".site-state")).toBeNull();
		expect(note(card)).toBe("saml-gift-message.qorpera.com");
		expect(card.querySelector<HTMLElement>(".app-card-note")?.title).toBe(gift.url);
		expect([...card.children].map((child) => child.className)).toEqual(["site-card-open", "app-card-go"]);
		expect(keyOf(card)).toBeNull();
		expect(card.querySelector(".site-pill, .site-secret, .site-eye, .site-more, .site-from")).toBeNull();
		expect(card.textContent).not.toMatch(/••|code\/|qorpera\/|files|KiB|password/i);
	});

	it("shows each site once per message, and two sites as two rows", async () => {
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
			rows.map((row) => [...row.querySelectorAll<HTMLElement>(".site-card")].map((item) => item.dataset.siteId)),
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

	it("shows an app link's row, and a site Qorpera took down grey with its reason, leading nowhere", async () => {
		const { sites } = await cards();
		const root = message(
			sites,
			"The API: https://orders-api-preview.qorpera.com/ and the sale https://spring-sale.qorpera.com/",
		);
		const [api, sale] = [...root.querySelectorAll<HTMLElement>(".site-card")];
		expect(api?.querySelector(".app-card-title")?.textContent).toBe("Orders API");
		expect(note(api!)).toBe("orders-api-preview.qorpera.com");
		expect([...api!.children].map((child) => child.className)).toEqual([
			"site-card-open",
			"site-pill-icon site-card-key",
			"app-card-go",
		]);
		expect(keyOf(api!)?.getAttribute("aria-label")).toBe("Copy the password");
		expect(sale?.className).toBe("app-card site-card is-down");
		expect(sale?.querySelector(".site-state")?.textContent).toBe("Taken down");
		expect(note(sale!)).toBe(REASON);
		expect(sale?.querySelector<HTMLElement>(".app-card-note")?.title).toBe(REASON);
		expect(sale?.querySelector("div.site-card-open .app-card-title")?.textContent).toBe("Spring sale");
		expect(sale?.querySelector("a, [href], [data-href]")).toBeNull();
		expect(sale?.querySelector(".site-card-key, .app-card-go")).toBeNull();
	});

	it("copies the password with the key, never showing it, and says so for a moment", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		const { sites, calls } = await cards();
		const root = message(sites, "https://orders-api-preview.qorpera.com/");
		keyOf(root)!.click();
		await settle();
		expect(calls.password).toHaveBeenCalledWith(app.id, expect.any(AbortSignal));
		expect(writeText).toHaveBeenCalledWith(PASSWORD);
		expect(note(root)).toBe("The password is copied.");
		expect(root.textContent).not.toContain(PASSWORD);
		await vi.advanceTimersByTimeAsync(2100);
		expect(note(root)).toBe("orders-api-preview.qorpera.com");
		vi.useRealTimers();
	});

	it("says why when the password could not be read, or the browser would not copy it", async () => {
		const calls = client();
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
		});
		const { sites } = await cards(true, calls);
		const root = message(sites, "https://orders-api-preview.qorpera.com/");
		keyOf(root)!.click();
		await settle();
		expect(note(root)).toBe("The browser would not copy the password.");
		calls.password.mockRejectedValueOnce(new CloudRpcError("x", { message: "denied", code: "42501" }, 403));
		keyOf(root)!.click();
		await settle();
		expect(note(root)).toBe("Only founders and admins can see passwords or take sites offline.");
		expect(root.querySelector(".app-card-note.is-error")).not.toBeNull();
		expect(root.textContent).not.toContain("42501");
	});

	it("shows a member who may not see passwords the row without the key, and follows a change of role", async () => {
		let manage = false;
		const calls = client();
		const lifetime = new AbortController();
		cleanup.push(() => lifetime.abort());
		const sites = new ThreadSites(calls, () => manage, lifetime.signal, () => {});
		await settle();
		const root = message(sites, "https://orders-api-preview.qorpera.com/");
		expect(keyOf(root)).toBeNull();
		expect(root.querySelector(".app-card-go")).not.toBeNull();
		manage = true;
		sites.update();
		expect(keyOf(root)).not.toBeNull();
		manage = false;
		sites.update();
		expect(keyOf(root)).toBeNull();
		expect(calls.password).not.toHaveBeenCalled();
	});

	it("lets go of the rows of a message drawn again before any redraw: only the rows on screen are kept (review r1 of #1848, F2)", async () => {
		let manage = true;
		const lifetime = new AbortController();
		cleanup.push(() => lifetime.abort());
		const sites = new ThreadSites(client(), () => manage, lifetime.signal, () => {});
		await settle();
		// The message's body drawn three times (its words changed, or the language), each time before any redraw: the
		// first two bodies leave the thread.
		const text = "https://saml-gift-message.qorpera.com/ and https://orders-api-preview.qorpera.com/";
		message(sites, text).remove();
		message(sites, text).remove();
		const shown = message(sites, text);
		expect(sites.drawn).toBe(6);
		// The next redraw (here, a change of role) keeps the two rows on screen alone, and draws them.
		manage = false;
		sites.update();
		expect(sites.drawn).toBe(2);
		expect(shown.querySelectorAll(".site-card")).toHaveLength(2);
		expect(shown.querySelector(".site-card-key")).toBeNull();
	});

	it("says it in Danish", async () => {
		setLanguagePreference("da");
		const { sites } = await cards();
		const root = message(
			sites,
			"https://saml-gift-message.qorpera.com/ https://orders-api-preview.qorpera.com/ https://spring-sale.qorpera.com/",
		);
		const [live, api, down] = [...root.querySelectorAll<HTMLElement>(".site-card")];
		expect(live?.querySelector(".site-state")).toBeNull();
		expect(keyOf(live!)).toBeNull();
		expect(keyOf(api!)?.getAttribute("aria-label")).toBe("Kopiér adgangskoden");
		expect(down?.querySelector(".site-state")?.textContent).toBe("Taget ned");
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
		});
		keyOf(api!)!.click();
		await settle();
		expect(note(api!)).toBe("Browseren ville ikke kopiere adgangskoden.");
	});

	it("calls a website Live only when everyone can open it, Not live yet when not, and nothing while unknown", async () => {
		const answers = new Map<string, SiteAnswer>();
		const draft: CompanySite = {
			...shop,
			id: id(85),
			slug: "launch",
			url: "https://launch.qorpera.com/",
			state: "publishing",
		};
		const { sites } = await cards(
			true,
			client([gift, shop, app, old, draft]),
			(siteId) => answers.get(siteId) ?? "unknown",
		);
		const root = message(
			sites,
			"https://saml-gift-message.qorpera.com/ https://orders-api-preview.qorpera.com/ https://spring-sale.qorpera.com/ https://launch.qorpera.com/",
		);
		const card = (siteId: string) => root.querySelector<HTMLElement>(`.site-card[data-site-id="${siteId}"]`)!;
		const state = (siteId: string) => card(siteId).querySelector(".site-state");
		expect(state(gift.id)).toBeNull();
		expect(state(app.id)?.textContent).toBe("Live");
		expect(state(old.id)?.textContent).toBe("Taken down");
		expect(state(draft.id)?.textContent).toBe("Publishing…");
		answers.set(gift.id, "private").set(app.id, "private").set(old.id, "live").set(draft.id, "live");
		sites.update();
		expect(state(gift.id)?.textContent).toBe("Not live yet");
		expect(state(gift.id)?.querySelector(".site-dot")).toBeNull();
		expect(state(app.id)?.textContent).toBe("Live");
		expect(keyOf(card(app.id))).not.toBeNull();
		expect(state(old.id)?.textContent).toBe("Taken down");
		expect(state(draft.id)?.textContent).toBe("Publishing…");
		answers.set(gift.id, "live");
		sites.update();
		expect(state(gift.id)?.textContent).toBe("Live");
		expect(state(gift.id)?.querySelector(".site-dot")).not.toBeNull();
		expect(keyOf(card(gift.id))).toBeNull();
		answers.delete(gift.id);
		sites.update();
		expect(state(gift.id)).toBeNull();
		setLanguagePreference("da");
		answers.set(gift.id, "private");
		sites.update();
		expect(state(gift.id)?.textContent).toBe("Ikke live endnu");
		answers.set(gift.id, "live");
		sites.update();
		expect(state(gift.id)?.textContent).toBe("Live");
		expect(state(old.id)?.textContent).toBe("Taget ned");
	});

	it("wears the app card's frame and lays its key above the row's link", () => {
		expect(conversationCss).toMatch(/\.site-card \{ position: relative;/);
		expect(conversationCss).toMatch(/\.site-card-open::after \{ content: ""; position: absolute; inset: 0;/);
		expect(conversationCss).toMatch(/\.site-card-key \{ position: relative; z-index: 1;/);
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
		return { view, calls, company };
	}

	it("draws an agent's message with its site's card once the company's sites are read", async () => {
		const { view, calls } = await thread("It is live: https://saml-gift-message.qorpera.com/");
		expect(calls.list).toHaveBeenCalledOnce();
		const message = view.el.querySelector<HTMLElement>("article.message")!;
		const parts = [...message.querySelectorAll(":scope > .bubble")].map((part) => part.firstElementChild?.className);
		expect(parts).toEqual(["message-prose", "app-cards site-cards"]);
		expect(message.querySelector(".site-card .app-card-title")?.textContent).toBe("SAML gift message");
		expect(message.querySelector("a.site-link-word")?.textContent).toBe("https://saml-gift-message.qorpera.com/");
	});

	it("draws a member's message with its site's card under the member's words", async () => {
		const { view } = await thread("Is https://sites.qorpera.com/wristband-shop/ right?", { mine: true });
		const message = view.el.querySelector<HTMLElement>("article.message.mine")!;
		const parts = [...message.querySelectorAll(":scope > .bubble")].map((part) => part.firstElementChild?.className);
		expect(parts).toEqual(["text", "app-cards site-cards"]);
		expect(message.querySelector(".site-card .app-card-title")?.textContent).toBe("Wristband shop");
	});

	it("follows what the company knows of whether everyone can open the site, as it comes", async () => {
		const { view, company } = await thread("It is up: https://saml-gift-message.qorpera.com/");
		const state = () => view.el.querySelector(".site-card .site-state");
		expect(state()).toBeNull();
		company.store.set({ sitesPublic: new Map([[gift.id, false]]) });
		await settle();
		expect(state()?.textContent).toBe("Not live yet");
		company.store.set({ sitesPublic: new Map([[gift.id, true]]) });
		await settle();
		expect(state()?.textContent).toBe("Live");
		company.store.set({ sitesTakenDown: new Set([gift.id]) });
		await settle();
		expect(state()?.textContent).toBe("Not live yet");
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
