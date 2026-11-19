// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompanyApp, readApps } from "../src/app/interface-apps.ts";
import { AppPanel, type AppPanelHost, type AppPanelTarget } from "../src/app/views/app-panel.ts";
import { PAGE_CONTENT, PAGE_READY } from "../src/ui/page-frame.ts";
import { folderFake } from "./folder-fake.ts";

/* An app's page (views/app-panel.ts) with the frame's side played by hand: the panel puts the page together and makes
 * its frame; the test says "ready" as the frame document would, takes the port the panel hands over with the page, and
 * sends on it what the frame document sends for a link the member clicked. The frame document's own part (which clicks
 * it sends) is test/page-frame.test.ts' and scripts/test-web-app-frame-browser.mjs'. */

const panels: AppPanel[] = [];

afterEach(() => {
	for (const panel of panels.splice(0)) panel.dispose();
	vi.restoreAllMocks();
	document.body.replaceChildren();
	delete document.documentElement.dataset.theme;
});

function company(files: Record<string, string> = {}) {
	const fake = folderFake({ seed: [] });
	fake.put("apps/sales/app.toml", 'name = "Sales"\nposted = true\n');
	fake.put("apps/sales/index.html", '<!doctype html><title>Sales</title><p><a href="app:hiring">Hiring</a></p>');
	for (const [path, text] of Object.entries(files)) fake.put(path, text);
	// The apps as last read, as the company's reader keeps them for a panel that is told of a change.
	let read: readonly CompanyApp[] = [];
	const host = {
		folder: () => fake.folder,
		agents: () => [],
		readApps: async (signal: AbortSignal) => {
			read = await readApps(fake.folder, signal);
			return read;
		},
		apps: () => read,
		agentName: () => null,
		onFolderChange: () => () => {},
		openInStorage: vi.fn<(path: string) => void>(),
		openApp: vi.fn<(name: string) => void>(),
		budgetKey: crypto.randomUUID(),
	} satisfies AppPanelHost;
	return { fake, host };
}

/** Opens `target` as a page of its own and plays the frame up to the hand-over: the page it was handed, and a way to
 * send a call on its port and wait for the answer. */
async function opened(host: AppPanelHost, target: AppPanelTarget = { kind: "app", name: "sales" }) {
	const panel = new AppPanel(host, target, { kind: "page", back: { href: "#/c/x", label: "Back to the company" } });
	panels.push(panel);
	document.body.append(panel.el);
	const handed = async () => {
		const frame = await vi.waitFor(() => {
			const found = panel.el.querySelector<HTMLIFrameElement>("iframe.side-panel-frame");
			if (!found?.contentWindow || found.dataset.played) throw new Error("no new frame yet");
			return found;
		});
		frame.dataset.played = "true";
		const post = vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(() => {});
		frame.dispatchEvent(new Event("load"));
		const ready = new MessageEvent("message", { data: { type: PAGE_READY } });
		Object.defineProperty(ready, "source", { value: frame.contentWindow });
		window.dispatchEvent(ready);
		expect(post).toHaveBeenCalledOnce();
		const [message, , transfer] = post.mock.calls[0] as unknown as [
			{ type: string; html: string },
			string,
			MessagePort[],
		];
		expect(message.type).toBe(PAGE_CONTENT);
		expect(transfer).toHaveLength(1);
		const port = transfer[0] as MessagePort;
		let calls = 0;
		const call = (method: string, params: Record<string, unknown>) =>
			new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
				const id = ++calls;
				const answer = (event: MessageEvent) => {
					if (event.data?.id !== id) return;
					port.removeEventListener("message", answer);
					resolve(event.data);
				};
				port.addEventListener("message", answer);
				port.start();
				port.postMessage({ type: "qorpera-app-call", id, method, params });
			});
		return { html: message.html, clicked: (href: unknown) => call("open", { href }), call };
	};
	return { panel, handed, ...(await handed()) };
}

describe("a link in an app's page", () => {
	it("opens another app where apps open, and a file of the company in Storage", async () => {
		const { host } = company();
		const app = await opened(host);
		expect(await app.clicked("app:hiring")).toEqual({ type: "qorpera-app-answer", id: 1, ok: true, value: null });
		expect(host.openApp).toHaveBeenCalledExactlyOnceWith("hiring");
		expect(await app.clicked("folder:strategy/plan%202027.md")).toMatchObject({ ok: true });
		expect(host.openInStorage).toHaveBeenCalledExactlyOnceWith("strategy/plan 2027.md");
		// Anything else opens nothing, and the page's own calls are answered as before.
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		for (const bad of ["other.html", "folder:QorperaOS/vision/vision.md", "javascript:alert(1)", "mailto:a@b.dk", 7])
			expect(await app.clicked(bad), String(bad)).toMatchObject({ ok: false });
		expect(host.openApp).toHaveBeenCalledOnce();
		expect(host.openInStorage).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		expect(app.panel.el.querySelector(".side-panel-link")).toBeNull();
		expect(await app.call("read", { path: "apps/sales/index.html" })).toMatchObject({ ok: true });
	});

	/** The bar above the page once a request is on it. */
	const shownBar = (panel: AppPanel) =>
		vi.waitFor(() => {
			const bar = panel.el.querySelector<HTMLElement>(".app-ask");
			if (!bar || bar.hidden || !bar.querySelector(".app-ask-address")) throw new Error("no link on the bar yet");
			return bar;
		});
	/** Open on the bar, pressed once it woke (a second after the bar came in). */
	const pressOpen = async (bar: HTMLElement) => {
		const yes = [...bar.querySelectorAll("button")].find((each) => each.textContent === "Open")!;
		await vi.waitFor(() => expect(yes.disabled).toBe(false), { timeout: 3000 });
		yes.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		yes.click();
	};
	/** A web link clicked in the page, shown on the bar, and opened there. */
	const through = async (app: Awaited<ReturnType<typeof opened>>, href: string) => {
		const answer = app.clicked(href);
		await pressOpen(await shownBar(app.panel));
		return answer;
	};

	it("opens a web page only from the bar's Open, once the member saw its whole address, with no way back", async () => {
		const { host } = company();
		const app = await opened(host);
		const tab = { opener: window as Window | null };
		const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
		const href = "https://example.com/pricing?plan=team&email=ada%40lund.dk#faq";
		const answer = app.clicked(href);
		const bar = await shownBar(app.panel);
		// Nothing opens at once (Jonas, 13 November 2026: "Show the address first"): the site, then the address in full.
		expect(open).not.toHaveBeenCalled();
		expect(bar.querySelector(".app-ask-title")?.textContent).toBe("This app wants to open a web page");
		expect(bar.querySelector(".app-ask-site")?.textContent).toBe("example.com");
		expect(bar.querySelector(".app-ask-address")?.textContent).toBe(href);
		// Above the page, drawn by Qorpera in the panel itself, not in the frame.
		expect(bar.parentElement).toBe(app.panel.el);
		await pressOpen(bar);
		expect(open).toHaveBeenCalledExactlyOnceWith(href, "_blank");
		expect(tab.opener).toBeNull();
		expect(await answer).toMatchObject({ ok: true });
		expect(app.panel.el.querySelector(".side-panel-link")).toBeNull();
		await vi.waitFor(() => expect(app.panel.el.querySelector<HTMLElement>(".app-ask")?.hidden).toBe(true));
	});

	it("opens no web page when the member says not now on the bar, or presses Escape there", async () => {
		const { host } = company();
		const app = await opened(host);
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const first = app.clicked("https://example.com/a");
		[...(await shownBar(app.panel)).querySelectorAll("button")]
			.find((each) => each.textContent === "Not now")!
			.click();
		expect(await first).toEqual({
			type: "qorpera-app-answer",
			id: expect.any(Number),
			ok: false,
			error: "The member said not now",
		});
		const second = app.clicked("https://example.com/b");
		(await shownBar(app.panel)).dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		expect(await second).toMatchObject({ ok: false, error: "The member said not now" });
		expect(open).not.toHaveBeenCalled();
	});

	it("offers a web page the browser would not open by itself as a link of Qorpera's own, above the frame", async () => {
		const { host } = company();
		const app = await opened(host);
		vi.spyOn(window, "open").mockReturnValue(null);
		const offered = () => app.panel.el.querySelector<HTMLElement>(".side-panel-link");
		expect(await through(app, "https://example.com/pricing?plan=team")).toMatchObject({ ok: true });
		const link = offered()?.querySelector("a");
		// Named by where it really leads, and opened as a link in a message opens.
		expect(link?.textContent).toBe("Open example.com/pricing");
		expect(link?.getAttribute("href")).toBe("https://example.com/pricing?plan=team");
		expect(link?.title).toBe("https://example.com/pricing?plan=team");
		expect([link?.target, link?.rel]).toEqual(["_blank", "noopener noreferrer"]);
		expect(document.activeElement).toBe(link);
		// Above the page, drawn by Qorpera in the panel itself, not in the frame. An app's own page has no header, so
		// the line and the bar are the only things of Qorpera's there.
		expect(offered()?.parentElement).toBe(app.panel.el);
		expect(offered()?.nextElementSibling?.classList.contains("side-panel-body")).toBe(true);
		expect(app.panel.el.querySelector(".side-panel-header")).toBeNull();
		// One at a time: the next one takes its place.
		expect(await through(app, "https://example.org/")).toMatchObject({ ok: true });
		expect(app.panel.el.querySelectorAll(".side-panel-link")).toHaveLength(1);
		expect(offered()?.querySelector("a")?.textContent).toBe("Open example.org");
		// Closed, it goes.
		offered()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
		expect(offered()).toBeNull();
		// Followed, it goes once the click has opened the tab; shown afresh, the page starts without one.
		expect(await through(app, "https://example.org/a")).toMatchObject({ ok: true });
		const followed = new MouseEvent("click", { bubbles: true, cancelable: true });
		offered()
			?.querySelector("a")
			?.addEventListener("click", (event) => event.preventDefault());
		offered()?.querySelector("a")?.dispatchEvent(followed);
		expect(offered()).not.toBeNull();
		await vi.waitFor(() => expect(offered()).toBeNull());
		expect(await through(app, "https://example.org/b")).toMatchObject({ ok: true });
		expect(offered()).not.toBeNull();
		void app.panel.reload(true);
		await app.handed();
		expect(offered()).toBeNull();
	});

	it("opens nothing from a page of the Company File, which is no app", async () => {
		const { host } = company({ "designs/board.html": '<a href="app:sales">Sales</a>' });
		const page = await opened(host, { kind: "page", path: "designs/board.html" });
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		for (const href of ["app:sales", "folder:designs/board.html", "https://example.com/"])
			expect(await page.clicked(href), href).toEqual({
				type: "qorpera-app-answer",
				id: expect.any(Number),
				ok: false,
				error: "Only an app in apps/ reads the company's data",
			});
		expect(host.openApp).not.toHaveBeenCalled();
		expect(host.openInStorage).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect(page.html).toBe('<!doctype html><html><head></head><body><a href="app:sales">Sales</a></body></html>');
	});
});

describe("an app's base style", () => {
	const BOTH = '<!doctype html><meta name="color-scheme" content="light dark"><p>State</p>';

	it("starts an app's page in the company's colours, and leaves a concept as written", async () => {
		const { host } = company({
			"QorperaOS/brand/brand.toml": 'accent = "#1f6f5b"\nbackground = "#f5f6ef"\ntext = "#1d2b24"\n',
			"apps/shop/app.toml": 'name = "Shop"\nconcept = true\n',
			"apps/shop/index.html": "<!doctype html><p>Shop</p>",
		});
		const app = await opened(host);
		expect(app.html).toContain("<head><style data-qorpera-base");
		expect(app.html).toContain("@layer qorpera-base {");
		for (const colour of ["--q-accent: #1f6f5b;", "--q-bg: #f5f6ef;", "--q-text: #1d2b24;", "color-scheme: light;"])
			expect(app.html).toContain(colour);
		expect(app.panel.el.querySelector(".side-panel-body")?.classList.contains("is-dark")).toBe(false);
		const concept = await opened(host, { kind: "app", name: "shop" });
		expect(concept.html).toBe("<!DOCTYPE html><html><head></head><body><p>Shop</p></body></html>");
	});

	it("follows the app's light and dark for a page that says it supports both, and shows it afresh on a change", async () => {
		const { host, fake } = company({ "apps/sales/index.html": BOTH });
		document.documentElement.dataset.theme = "dark";
		const app = await opened(host);
		expect(app.html).toContain("color-scheme: dark;");
		expect(app.html).toContain("--q-bg: #1f2120;");
		const body = app.panel.el.querySelector(".side-panel-body");
		expect(body?.classList.contains("is-dark")).toBe(true);
		// The app turns light: the page is put together again in the light scheme, in a new frame.
		document.documentElement.dataset.theme = "light";
		window.dispatchEvent(new Event("qorpera-theme-change"));
		const light = await app.handed();
		expect(light.html).toContain("color-scheme: light;");
		expect(body?.classList.contains("is-dark")).toBe(false);
		// The company's colours are read when the app opens and on Reload, not on every change in the folder.
		fake.put("QorperaOS/brand/brand.toml", 'accent = "#1f6f5b"\n');
		window.dispatchEvent(new Event("qorpera-theme-change"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(app.panel.el.querySelectorAll("iframe")).toHaveLength(1);
		expect(app.panel.el.querySelector<HTMLIFrameElement>("iframe")?.dataset.played).toBe("true");
		void app.panel.reload(true);
		expect((await app.handed()).html).toContain("--q-accent: #1f6f5b;");
	});

	it("keeps a page that does not say so light in a dark app, and keeps the colours it had when they can't be read", async () => {
		const { host, fake } = company({ "QorperaOS/brand/brand.toml": 'accent = "#1f6f5b"\n' });
		document.documentElement.dataset.theme = "dark";
		const app = await opened(host);
		expect(app.html).toContain("color-scheme: light;");
		expect(app.html).toContain("--q-accent: #1f6f5b;");
		expect(app.panel.el.querySelector(".side-panel-body")?.classList.contains("is-dark")).toBe(false);
		// The brand can't be read on a Reload: the page opens with the colours read before.
		const read = fake.folder.read.getMockImplementation();
		if (!read) throw new Error("the folder fake reads");
		fake.folder.read.mockImplementation(async (...args) => {
			if (args[0] === "QorperaOS/brand/brand.toml") throw new Error("offline");
			return read(...args);
		});
		void app.panel.reload(true);
		expect((await app.handed()).html).toContain("--q-accent: #1f6f5b;");
	});
});
