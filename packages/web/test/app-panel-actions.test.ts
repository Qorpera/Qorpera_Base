// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppNoteSent, HeldNote } from "../src/app/app-actions.ts";
import { type CompanyApp, readApps } from "../src/app/interface-apps.ts";
import { AppPanel, type AppPanelHost } from "../src/app/views/app-panel.ts";
import { PAGE_CONTENT, PAGE_READY } from "../src/ui/page-frame.ts";
import { staff } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

/* An app's page (views/app-panel.ts) asking for a change, with the frame's side played by hand: the panel puts the
 * page together and makes its frame; the test says "ready" as the frame document would, takes the port the panel hands
 * over with the page, and sends on it what the frame document sends for `qorpera.setRow(...)`. What a request shows and
 * saves is test/app-actions.test.ts'; here it is the panel's part: whose manifest and whose page a request belongs to
 * (review r1 of #1633, F1 and F2). */

const TABLE = "QorperaOS/tables/orders/table.toml";
const ROWS = "QorperaOS/tables/orders/rows.csv";
const ORDERS = `format = "qorpera.table/v0"

[table]
id = "1d6e4a57-8b3c-4f21-9e6d-0a7c5b2f8e15"
name = "Orders"
rows = "file"
key = ["order"]

[[column]]
name = "order"
type = "text"

[[column]]
name = "status"
type = "choice"
choices = ["packed", "shipped"]

[write]
agents = "all"
members = "all"
`;
const MAY_WRITE = 'name = "Shop"\nposted = true\nwrites = ["table:orders"]\n';
const MAY_NOT = 'name = "Shop"\nposted = true\n';
const ship = { table: "orders", key: "1042", cells: { status: "shipped" } };
const NOT_LISTED = 'Add "table:<name>" to writes in app.toml to change rows of that table';
const GONE = "The page was put away, or what it may ask for changed, before the member answered";

const panels: AppPanel[] = [];

afterEach(() => {
	for (const panel of panels.splice(0)) panel.dispose();
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

function company(manifest: string) {
	const fake = folderFake({ seed: [] });
	fake.put("apps/shop/app.toml", manifest);
	fake.put("apps/shop/index.html", "<!doctype html><title>Shop</title><p>Orders</p>");
	fake.put(TABLE, ORDERS);
	fake.put(ROWS, "order,status\n1042,packed\n");
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
		openInStorage: () => {},
		openApp: () => {},
		budgetKey: crypto.randomUUID(),
		writer: () => fake.folder,
		current: () => {},
	} satisfies AppPanelHost;
	/** The folder changed: the company's reader reads the apps, then the panel hears of it. */
	const changed = async (panel: AppPanel) => {
		await host.readApps(new AbortController().signal);
		await panel.reload(false);
	};
	return { fake, host, changed };
}

type Answer = { ok: boolean; value?: unknown; error?: string };

/** Opens the app as a page of its own and plays the frame up to the hand-over: a way to send a call on its port. */
async function opened(host: AppPanelHost) {
	const panel = new AppPanel(
		host,
		{ kind: "app", name: "shop" },
		{ kind: "page", back: { href: "#/c/x", label: "Back to the company" } },
	);
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
		const [message, , transfer] = post.mock.calls[0] as unknown as [{ type: string }, string, MessagePort[]];
		expect(message.type).toBe(PAGE_CONTENT);
		const port = transfer[0] as MessagePort;
		let calls = 0;
		const call = (method: string, params: Record<string, unknown>) =>
			new Promise<Answer>((resolve) => {
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
		return { frame, call };
	};
	const bar = () => panel.el.querySelector<HTMLElement>(".app-ask") as HTMLElement;
	const shown = () =>
		vi.waitFor(() => {
			if (bar().hidden) throw new Error("no request on the bar yet");
		});
	return { panel, handed, bar, shown, ...(await handed()) };
}

/** Lets what is already under way end: the reads, the checks and their answers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("an app's request and the manifest it was made under", () => {
	it("follows the manifest under a page that stays: what is taken away is refused at once, what is added works", async () => {
		const { fake, host, changed } = company(MAY_WRITE);
		const app = await opened(host);
		const first = app.call("setRow", ship);
		await app.shown();
		// The manifest loses `writes`; the page's own files are as they were, so the frame stays.
		fake.put("apps/shop/app.toml", MAY_NOT);
		await changed(app.panel);
		expect(app.panel.el.querySelector("iframe.side-panel-frame")).toBe(app.frame);
		// The request that waited goes, unsaved, and the page is told; a new one is refused before anything is shown.
		expect(app.bar().hidden).toBe(true);
		expect(await first).toMatchObject({ ok: false, error: GONE });
		expect(await app.call("setRow", ship)).toMatchObject({ ok: false, error: NOT_LISTED });
		expect(app.bar().hidden).toBe(true);
		expect(fake.commits).toEqual([]);
		// Listed again, it asks again, without a Reload.
		fake.put("apps/shop/app.toml", MAY_WRITE);
		await changed(app.panel);
		expect(app.panel.el.querySelector("iframe.side-panel-frame")).toBe(app.frame);
		void app.call("setRow", ship);
		await app.shown();
		expect(app.bar().textContent).toContain("This app wants to change a row in a company table");
	});

	it("follows the manifest even when the page cannot be put together again", async () => {
		const { fake, host, changed } = company(MAY_WRITE);
		const app = await opened(host);
		const first = app.call("setRow", ship);
		await app.shown();
		// The manifest loses `writes`, and the page's own file fails to read: the earlier page keeps standing.
		fake.put("apps/shop/app.toml", MAY_NOT);
		const read = fake.folder.read.getMockImplementation() as typeof fake.folder.read;
		fake.folder.read.mockImplementation(async (path, signal) => {
			if (path === "apps/shop/index.html") throw new Error("offline");
			return read(path, signal);
		});
		await changed(app.panel);
		expect(app.panel.el.querySelector("iframe.side-panel-frame")).toBe(app.frame);
		// It stands without what the manifest took away: the waiting request is gone, a new one is refused.
		expect(app.bar().hidden).toBe(true);
		expect(await first).toMatchObject({ ok: false, error: GONE });
		expect(await app.call("setRow", ship)).toMatchObject({ ok: false, error: NOT_LISTED });
		expect(fake.commits).toEqual([]);
	});

	it("keeps a waiting request when the folder changed but the manifest did not", async () => {
		const { fake, host, changed } = company(MAY_WRITE);
		const app = await opened(host);
		void app.call("setRow", ship);
		await app.shown();
		fake.put("notes/today.md", "# Today");
		await changed(app.panel);
		expect(app.bar().hidden).toBe(false);
	});

	it("refuses a request whose check was still running when its page was put away", async () => {
		const { fake, host } = company(MAY_WRITE);
		const app = await opened(host);
		// The table's definition is slow to read: the request is still being checked.
		const read = fake.folder.read.getMockImplementation() as typeof fake.folder.read;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		fake.folder.read.mockImplementation(async (path, signal) => {
			if (path === TABLE) await held;
			return read(path, signal);
		});
		void app.call("setRow", ship);
		await vi.waitFor(() => expect(fake.folder.read).toHaveBeenCalledWith(TABLE, expect.anything()));
		// The member reloads: a new page in a new frame. The old page's request must not reach the bar.
		const reloading = app.panel.reload(true);
		const again = await app.handed();
		await reloading;
		expect(again.frame).not.toBe(app.frame);
		release();
		await settle();
		expect(app.bar().hidden).toBe(true);
		expect(fake.commits).toEqual([]);
		// The new page asks as usual.
		fake.folder.read.mockImplementation(read);
		void again.call("setRow", ship);
		await app.shown();
	});

	it("refuses one whose check was still running when the app could no longer be shown", async () => {
		const { fake, host, changed } = company(MAY_WRITE);
		const app = await opened(host);
		const read = fake.folder.read.getMockImplementation() as typeof fake.folder.read;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		fake.folder.read.mockImplementation(async (path, signal) => {
			if (path === TABLE) await held;
			return read(path, signal);
		});
		void app.call("setRow", ship);
		await vi.waitFor(() => expect(fake.folder.read).toHaveBeenCalledWith(TABLE, expect.anything()));
		// The manifest breaks: the app is not shown any more.
		fake.put("apps/shop/app.toml", "name = ");
		await changed(app.panel);
		expect(app.panel.el.querySelector("iframe.side-panel-frame")).toBeNull();
		release();
		await settle();
		expect(app.bar().hidden).toBe(true);
		expect(fake.commits).toEqual([]);
	});
});

describe("a note an app's page asks the member to send its owner", () => {
	const OWNER = "22222222-2222-4222-8222-222222222222";
	/** The company's side of a note (app/tell-agent.ts): the owner hears it, each send is kept, and `went` says how
	 * the next send goes (a promise the test settles, for a send under way). Notes held for an app are kept by app, as
	 * the company keeps them across its pages. */
	function withNotes(host: AppPanelHost) {
		const sent: [agentId: string, note: { header: string; text: string }][] = [];
		const held = new Map<string, HeldNote>();
		const back = new Map<string, () => void>();
		let went: () => Promise<AppNoteSent> = async () => ({ sent: true, href: `#/c/x/staff/${OWNER}` });
		const told = {
			...host,
			tell: {
				receiver: (owner: string | null) => (owner === OWNER ? { agentId: OWNER } : { refused: "Nobody" }),
				agent: (agentId: string) => (agentId === OWNER ? { ...staff, id: OWNER, displayName: "Ada" } : undefined),
				send: async (agentId: string, note: { header: string; text: string }) => {
					sent.push([agentId, note]);
					return went();
				},
				held: (app: string) => held.get(app),
				// As the company keeps them (app/application.ts): one on its way and held again is back on the page.
				hold: (app: string, note: HeldNote | undefined) => {
					const was = held.get(app);
					if (note) held.set(app, note);
					else held.delete(app);
					if (was?.sending && note && !note.sending) back.get(app)?.();
				},
				listen: (app: string, listener: () => void) => {
					back.set(app, listener);
					return () => {
						if (back.get(app) === listener) back.delete(app);
					};
				},
			},
		} satisfies AppPanelHost;
		return {
			told,
			sent,
			held,
			next: (how: () => Promise<AppNoteSent>) => {
				went = how;
			},
		};
	}
	/** The bar's field, typed in as a member types. */
	const write = (bar: HTMLElement, words: string) => {
		const field = bar.querySelector<HTMLTextAreaElement>("textarea")!;
		field.value = words;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	};
	/** Send note, pressed once it is awake. */
	const pressSend = async (bar: HTMLElement) => {
		const send = [...bar.querySelectorAll("button")].find((each) => each.textContent === "Send note")!;
		await vi.waitFor(() => expect(send.disabled).toBe(false), { timeout: 3000 });
		send.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		send.click();
	};

	it("needs no word in writes, and sends the member's words as the page's answer waits", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const { told, sent } = withNotes(host);
		const app = await opened(told);
		// A draft past its bound never reaches the bar.
		expect(await app.call("tell", { about: "Lund, A", at: "1043", text: "x".repeat(281) })).toMatchObject({
			ok: false,
			error: "tell's text is at most 280 characters",
		});
		expect(app.bar().hidden).toBe(true);
		const note = app.call("tell", { about: "Lund, A", at: "1043", text: "Get a quote" });
		await app.shown();
		expect(app.bar().querySelector(".app-ask-title")?.textContent).toBe("This app wants to send your note to Ada");
		const field = app.bar().querySelector<HTMLTextAreaElement>("textarea")!;
		expect(document.activeElement).toBe(field);
		field.value = "Get two quotes, please.";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		const send = [...app.bar().querySelectorAll("button")].find((each) => each.textContent === "Send note")!;
		await vi.waitFor(() => expect(send.disabled).toBe(false), { timeout: 3000 });
		send.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
		send.click();
		expect(await note).toMatchObject({ ok: true, value: { sent: true } });
		expect(sent).toEqual([[OWNER, { header: "app:shop#1043 · Lund, A", text: "Get two quotes, please." }]]);
		// The same app asks again at once: refused for a few seconds, with no bar.
		await vi.waitFor(() => expect(app.bar().querySelector("textarea")).toBeNull());
		expect(await app.call("tell", { about: "Lund, A" })).toMatchObject({
			ok: false,
			error: "A note was sent from this app a moment ago: ask again in a few seconds",
		});
	});

	it("puts a note that waits for the member away, unsent, when the page is reloaded", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const { told, sent } = withNotes(host);
		const app = await opened(told);
		const note = app.call("tell", { about: "Lund, A", text: "Get a quote" });
		await app.shown();
		const reloading = app.panel.reload(true);
		await app.handed();
		await reloading;
		expect(await note).toMatchObject({ ok: false, error: GONE });
		expect(app.bar().hidden).toBe(true);
		expect(sent).toEqual([]);
	});

	it("keeps a note its thread can't take through Open and back, with the member's words, and sends it then", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const notes = withNotes(host);
		notes.next(async () => ({ sent: false, href: `#/c/x/staff/${OWNER}`, held: true }));
		const app = await opened(notes.told);
		const asked = app.call("tell", { about: "Lund, A", at: "1043", text: "Get a quote" });
		await app.shown();
		write(app.bar(), "Get two quotes.");
		await pressSend(app.bar());
		await vi.waitFor(() => expect(app.bar().querySelector<HTMLElement>(".app-ask-held")?.hidden).toBe(false));
		// The member changes their words, then goes to the thread to look (Open): the app's page is put away.
		write(app.bar(), "Get two quotes, by Friday.");
		expect(app.bar().querySelector(".app-ask-held a")?.getAttribute("data-href")).toBe(`#/c/x/staff/${OWNER}`);
		app.panel.dispose();
		// (The page went with its frame: nothing answers it now.)
		void asked;
		expect(notes.held.get("shop")).toEqual({
			agentId: OWNER,
			app: "Shop",
			about: "Lund, A",
			header: "app:shop#1043 · Lund, A",
			words: "Get two quotes, by Friday.",
		});
		// Back on the app: the same note is on the bar, with their words, and goes once the thread can take it.
		notes.next(async () => ({ sent: true, href: `#/c/x/staff/${OWNER}` }));
		const back = await opened(notes.told);
		await back.shown();
		expect(back.bar().querySelector(".app-ask-title")?.textContent).toBe("This app wants to send your note to Ada");
		expect(back.bar().querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Get two quotes, by Friday.");
		await pressSend(back.bar());
		await vi.waitFor(() => expect(back.bar().textContent).toContain("Sent to Ada"));
		expect(notes.sent.map(([, note]) => note.text)).toEqual(["Get two quotes.", "Get two quotes, by Friday."]);
		expect(notes.held.size).toBe(0);
	});

	it("shows a kept note on no bar while it is on its way, sends it once a press, and brings it back if held again (#1739 r2, F2)", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const notes = withNotes(host);
		const kept = { agentId: OWNER, app: "Shop", about: "Lund, A", header: "app:shop · Lund, A", words: "Kept words" };
		notes.held.set("shop", kept);
		let deliver = (_went: AppNoteSent) => {};
		const deferredSend = () =>
			new Promise<AppNoteSent>((resolve) => {
				deliver = resolve;
			});
		notes.next(deferredSend);
		const app = await opened(notes.told);
		await app.shown();
		write(app.bar(), "Kept words, again");
		await pressSend(app.bar());
		await vi.waitFor(() => expect(notes.sent).toHaveLength(1));
		expect(notes.held.get("shop")).toEqual({ ...kept, words: "Kept words, again", sending: true });
		// The member leaves and comes back before it is through: no bar shows it meanwhile, so nothing sends it twice.
		app.panel.dispose();
		const back = await opened(notes.told);
		await settle();
		expect(back.bar().hidden).toBe(true);
		// Held again: back on the bar of the page on screen now, with the words.
		deliver({ sent: false, href: `#/c/x/staff/${OWNER}`, held: true });
		await back.shown();
		expect(back.bar().querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Kept words, again");
		expect(notes.held.get("shop")).toEqual({ ...kept, words: "Kept words, again" });
		// Sent this time, while the member is away again: let go, and no bar on the way back.
		notes.next(deferredSend);
		await pressSend(back.bar());
		await vi.waitFor(() => expect(notes.sent).toHaveLength(2));
		back.panel.dispose();
		const again = await opened(notes.told);
		await settle();
		expect(again.bar().hidden).toBe(true);
		deliver({ sent: true, href: `#/c/x/staff/${OWNER}` });
		await settle();
		expect(notes.held.size).toBe(0);
		expect(again.bar().hidden).toBe(true);
		expect(notes.sent.map(([, note]) => note.text)).toEqual(["Kept words, again", "Kept words, again"]);
	});

	it("puts a kept note back on the bar when the app's manifest changes under a page that stays (#1739 r2, F3)", async () => {
		const { fake, host, changed } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const notes = withNotes(host);
		notes.held.set("shop", {
			agentId: OWNER,
			app: "Shop",
			about: "Lund, A",
			header: "app:shop · Lund, A",
			words: "Kept words",
		});
		const app = await opened(notes.told);
		await app.shown();
		// The manifest changes and the page does not: the earlier bridge's bar goes with it, and the new one shows the
		// note again.
		fake.put("apps/shop/app.toml", `${MAY_NOT}owner = "${OWNER}"\nabout = "Orders to ship"\n`);
		await changed(app.panel);
		expect(app.panel.el.querySelector("iframe.side-panel-frame")).toBe(app.frame);
		await app.shown();
		expect(app.bar().querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Kept words");
	});

	it("lets a kept note go when the member says not now to it on the way back", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const notes = withNotes(host);
		notes.held.set("shop", {
			agentId: OWNER,
			app: "Shop",
			about: "Lund, A",
			header: "app:shop · Lund, A",
			words: "Kept words",
		});
		const app = await opened(notes.told);
		await app.shown();
		[...app.bar().querySelectorAll("button")].find((each) => each.textContent === "Not now")!.click();
		expect(app.bar().hidden).toBe(true);
		expect(notes.held.size).toBe(0);
		expect(notes.sent).toEqual([]);
	});

	it("counts the app's pause from a note that went while the member had left the app", async () => {
		const { host } = company(`${MAY_NOT}owner = "${OWNER}"\n`);
		const notes = withNotes(host);
		let deliver = (_went: AppNoteSent) => {};
		notes.next(
			() =>
				new Promise<AppNoteSent>((resolve) => {
					deliver = resolve;
				}),
		);
		const app = await opened(notes.told);
		const asked = app.call("tell", { about: "Lund, A", text: "Get a quote" });
		await app.shown();
		await pressSend(app.bar());
		await vi.waitFor(() => expect(notes.sent).toHaveLength(1));
		// The member leaves the app while the note is on its way: the bar is put away, and the note still goes.
		app.panel.dispose();
		void asked;
		deliver({ sent: true, href: `#/c/x/staff/${OWNER}` });
		await settle();
		// Back at once: the app's next note waits its pause, as after any note that went.
		const back = await opened(notes.told);
		expect(await back.call("tell", { about: "Lund, A" })).toMatchObject({
			ok: false,
			error: "A note was sent from this app a moment ago: ask again in a few seconds",
		});
		expect(back.bar().hidden).toBe(true);
	});
});
