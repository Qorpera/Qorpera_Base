// @vitest-environment jsdom
import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWallReader } from "../src/app/agent-wall.ts";
import { AgentWallPoster, type WallPosterAgent, wallHidden, wallNews } from "../src/ui/agent-wall-poster.ts";
import { markdownInline } from "../src/ui/markdown.ts";

const AGENT: WallPosterAgent = {
	id: "a0000000-0000-4000-8000-000000000001",
	displayName: "Shop Operations",
	appearance: { color: "blue", shape: "rocket" },
};
const TODAY = "2026-11-05";

const WALL = `# Wall

## Waits on you
- Pick a shop name. My pick is Båndklar. [The names](folder:research/shop-names.md)

## Working on
- Checking five shops' prices
- Choosing the shop system, see [Launch checklist](app:launch-checklist)

## Done
- 2026-11-05: Two suppliers found
- 2026-11-04: Shop launch plan
- 2026-11-03: Test list
- 2026-11-02: Team hired
- 2026-10-01: Business registered
`;

const texts = (root: Element, selector: string) =>
	[...root.querySelectorAll(selector)].map((node) => node.textContent?.replace(/\s+/g, " ").trim());
const toggle = (poster: AgentWallPoster) => poster.el.querySelector<HTMLButtonElement>(".agent-wall-toggle")!;

beforeEach(() => localStorage.clear());
afterEach(() => document.body.replaceChildren());

describe("an agent's wall on top of its chat", () => {
	it("shows the three parts in order, waiting first, with a summary row", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
		expect(poster.shown).toBe(true);
		expect(poster.el.getAttribute("aria-label")).toBe("Shop Operations's wall");
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe(
			"1 waits on you · 2 working on · 5 done",
		);
		expect(texts(poster.el, ".agent-wall-heading")).toEqual(["Waits on you1", "Working on2", "Done5"]);
		expect(texts(poster.el, ".is-waiting .agent-wall-text")).toEqual([
			"Pick a shop name. My pick is Båndklar. The names",
		]);
		expect(texts(poster.el, ".is-working .agent-wall-text")).toEqual([
			"Checking five shops' prices",
			// A link in a headline reads as its words on the row; the link itself is there when the row opens.
			"Choosing the shop system, see Launch checklist",
		]);
		// The two newest done, then the rest of the week behind "more done".
		expect(texts(poster.el, ".is-done .agent-wall-text")).toEqual(["Two suppliers found", "Shop launch plan"]);
		expect(texts(poster.el, ".agent-wall-more")).toEqual(["2 more done"]);
	});

	it("shows the week and how many are earlier behind more done, and folds it back", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-more button")!.click();
		expect(texts(poster.el, ".is-done .agent-wall-text")).toEqual([
			"Two suppliers found",
			"Shop launch plan",
			"Test list",
			"Team hired",
		]);
		expect(texts(poster.el, ".agent-wall-more")).toEqual(["Earlier: 1 · Show fewer"]);
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-more button")!.click();
		expect(texts(poster.el, ".is-done .agent-wall-text")).toHaveLength(2);
	});

	it("draws links as the same folder-link and app-card buttons a message has", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
		const folder = poster.el.querySelector<HTMLButtonElement>("button.folder-link")!;
		expect([folder.dataset.folderPath, folder.textContent]).toEqual(["research/shop-names.md", "The names"]);
		const app = poster.el.querySelector<HTMLButtonElement>("button.app-card")!;
		expect(app.dataset.appName).toBe("launch-checklist");
		// A click reaches a listener above the poster, as the app's own listener on the page answers it.
		const host = document.createElement("main");
		host.append(poster.el);
		document.body.append(host);
		const clicked: string[] = [];
		host.addEventListener("click", (event) => {
			const target = event.target as Element;
			const link = target.closest<HTMLElement>("[data-folder-path], [data-app-name]");
			if (link) clicked.push(link.dataset.folderPath ?? `app:${link.dataset.appName}`);
		});
		folder.click();
		app.querySelector("strong")!.click();
		expect(clicked).toEqual(["research/shop-names.md", "app:launch-checklist"]);
	});

	it("is hidden with no agent, no wall, or a wall with no items", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, null, TODAY);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, "# Wall\n\n## Waits on you\n\n## Working on\n\n## Done\n", TODAY);
		expect(poster.shown).toBe(false);
		poster.show(undefined, WALL, TODAY);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, WALL, TODAY);
		expect(poster.shown).toBe(true);
		poster.show(AGENT, "", TODAY);
		expect(poster.shown).toBe(false);
	});

	it("shows what reads of a wall that breaks its rules", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Working on\n- Writing the plan\nnot an item\n\n## Done\n- yesterday: Hired\n", TODAY);
		expect(poster.shown).toBe(true);
		expect(texts(poster.el, ".agent-wall-text")).toEqual(["Writing the plan"]);
	});

	it("opens when something waits on the member, folds to one line, and keeps the fold per agent", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(false);
		expect(toggle(poster).textContent).toBe("Fold");
		expect(toggle(poster).getAttribute("aria-expanded")).toBe("true");
		toggle(poster).click();
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		expect(toggle(poster).textContent).toBe("Open");
		expect(toggle(poster).getAttribute("aria-expanded")).toBe("false");
		expect(poster.el.querySelector<HTMLElement>(".agent-wall-fold")!.inert).toBe(true);
		// The summary row stays.
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toContain("1 waits on you");
		// The same agent's thread opened again keeps it folded.
		const again = new AgentWallPoster();
		again.show(AGENT, WALL, TODAY);
		expect(again.el.classList.contains("is-folded")).toBe(true);
		toggle(again).click();
		expect(again.el.classList.contains("is-folded")).toBe(false);
	});

	it("starts folded when nothing waits and nothing is new", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working on");
	});

	it("marks what is new since the member last saw the wall open, and opens for it", () => {
		const first = new AgentWallPoster();
		first.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		// Seen for the first time: nothing to mark from.
		expect(first.el.querySelectorAll(".is-new")).toHaveLength(0);
		toggle(first).click(); // open
		toggle(first).click(); // fold again: kept folded
		const next = new AgentWallPoster();
		next.show(AGENT, "## Working on\n- Writing the plan\n\n## Done\n- 2026-11-05: Plan written\n", TODAY);
		expect(next.el.classList.contains("is-folded")).toBe(false);
		expect(texts(next.el, ".agent-wall-item.is-new .agent-wall-text")).toEqual(["Plan written"]);
		expect(next.el.querySelector(".agent-wall-item.is-new .visually-hidden")?.textContent).toBe(" (New)");
		// Seen now, as it showed open: the next visit marks nothing.
		const later = new AgentWallPoster();
		later.show(AGENT, "## Working on\n- Writing the plan\n\n## Done\n- 2026-11-05: Plan written\n", TODAY);
		expect(later.el.querySelectorAll(".is-new")).toHaveLength(0);
	});

	it("opens and marks an item that joins while the poster is shown folded", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n\n## Working on\n- Writing the plan\n", TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(false);
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["Approve the plan"]);
		// The mark stays while the member is here.
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n\n## Working on\n- Writing the plan\n- More\n", TODAY);
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["Approve the plan", "More"]);
	});

	it("keeps working when storage throws", () => {
		const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		try {
			const poster = new AgentWallPoster();
			poster.show(AGENT, WALL, TODAY);
			expect(poster.shown).toBe(true);
			toggle(poster).click();
			expect(poster.el.classList.contains("is-folded")).toBe(true);
		} finally {
			get.mockRestore();
			set.mockRestore();
		}
	});
});

describe("an inline line of Markdown", () => {
	it("draws emphasis, code and links without blocks", () => {
		const line = markdownInline("**Plan** with `code`, [site](https://example.com) and [file](folder:a/b.md)");
		expect(line.tagName).toBe("SPAN");
		expect(line.querySelector("p")).toBeNull();
		expect(line.querySelector("strong")?.textContent).toBe("Plan");
		expect(line.querySelector("code")?.textContent).toBe("code");
		expect(line.querySelector("a")?.getAttribute("href")).toBe("https://example.com/");
		expect(line.querySelector<HTMLElement>(".folder-link")?.dataset.folderPath).toBe("a/b.md");
	});
});

describe("reading an agent's wall", () => {
	const entry = (path: string, version: string, bytes: number): CloudMemberFolderEntry => ({
		path,
		kind: "file",
		version,
		seq: 1,
		updatedAt: "2026-11-05T10:00:00Z",
		file: {
			manifestSha256: "0".repeat(64),
			fileSha256: "1".repeat(64),
			bytes,
			mediaType: "text/markdown",
			executable: false,
		},
		target: null,
	});

	it("finds the agent's folder once, reads the file, and reads its bytes again only for a new version", async () => {
		let version = "v1";
		const text = "## Working on\n- Writing the plan\n";
		const folder = {
			stateFolders: vi.fn(async () => ({
				agents: [{ staffAgentId: AGENT.id, file: "QorperaOS/agents/shop-operations/agent.md" }],
				groups: [],
				routines: null,
			})),
			read: vi.fn(async (path: string) => ({
				entry: path === "QorperaOS/agents/shop-operations/wall.md" ? entry(path, version, text.length) : null,
			})),
			readFile: vi.fn(async () => new TextEncoder().encode(text)),
		};
		const read = agentWallReader(() => folder as never);
		const signal = new AbortController().signal;
		expect(await read(AGENT.id, signal)).toBe(text);
		expect(await read(AGENT.id, signal)).toBe(text);
		expect(folder.stateFolders).toHaveBeenCalledTimes(1);
		expect(folder.readFile).toHaveBeenCalledTimes(1);
		version = "v2";
		expect(await read(AGENT.id, signal)).toBe(text);
		expect(folder.readFile).toHaveBeenCalledTimes(2);
		expect(await read("a0000000-0000-4000-8000-000000000009", signal)).toBeNull();
	});

	it("answers null when the agent has no wall", async () => {
		const folder = {
			stateFolders: vi.fn(async () => ({
				agents: [{ staffAgentId: AGENT.id, file: "QorperaOS/agents/shop-operations/agent.md" }],
				groups: [],
				routines: null,
			})),
			read: vi.fn(async () => ({ entry: null })),
			readFile: vi.fn(),
		};
		const read = agentWallReader(() => folder as never);
		expect(await read(AGENT.id, new AbortController().signal)).toBeNull();
		// Each hint after that reads the file only: the agent's folder is looked up again at most once a minute.
		expect(await read(AGENT.id, new AbortController().signal)).toBeNull();
		expect(await read(AGENT.id, new AbortController().signal)).toBeNull();
		expect(folder.stateFolders).toHaveBeenCalledTimes(2);
		expect(folder.read).toHaveBeenCalledTimes(3);
		expect(folder.readFile).not.toHaveBeenCalled();
	});
});

describe("hiding the wall", () => {
	const MEMBER = "u0000000-0000-4000-8000-00000000000a";
	const hide = (poster: AgentWallPoster) => poster.el.querySelector<HTMLButtonElement>(".agent-wall-hide")!;
	const CHANGED = WALL.replace(
		"- Checking five shops' prices\n",
		"- Checking five shops' prices\n- Writing the shop texts\n",
	);

	it("hides for this member while the agent keeps the wall up to date, and says how to bring it back", () => {
		const onHide = vi.fn();
		const poster = new AgentWallPoster({ member: MEMBER, onHide });
		poster.show(AGENT, WALL, TODAY);
		expect(hide(poster).getAttribute("aria-label")).toBe(
			"Hide. Latest notes on Shop Operations's card brings it back.",
		);
		hide(poster).click();
		expect(poster.shown).toBe(false);
		expect(onHide).toHaveBeenCalledTimes(1);
		expect(wallHidden(MEMBER, AGENT.id)).toBe(true);
		// The agent's update does not bring it back, and what it added stays unseen for the card's count.
		poster.show(AGENT, CHANGED, TODAY);
		expect(poster.shown).toBe(false);
		expect(wallNews(MEMBER, AGENT.id, CHANGED)).toEqual({ items: 9, unseen: 1 });
		// What another member saw on this device is theirs.
		expect(wallNews("someone-else", AGENT.id, CHANGED)).toEqual({ items: 9, unseen: 0 });
		// A new thread view of the same agent keeps it hidden; another member on this device still sees it.
		const again = new AgentWallPoster({ member: MEMBER });
		again.show(AGENT, CHANGED, TODAY);
		expect(again.shown).toBe(false);
		const other = new AgentWallPoster({ member: "someone-else" });
		other.show(AGENT, CHANGED, TODAY);
		expect(other.shown).toBe(true);
	});

	it("comes back open from Latest notes, with what is new marked, and takes focus", () => {
		const poster = new AgentWallPoster({ member: MEMBER });
		document.body.append(poster.el);
		poster.show(AGENT, WALL, TODAY);
		toggle(poster).click();
		hide(poster).click();
		poster.show(AGENT, CHANGED, TODAY);
		poster.reveal(AGENT.id);
		expect(poster.shown).toBe(true);
		expect(wallHidden(MEMBER, AGENT.id)).toBe(false);
		expect(toggle(poster).textContent).toBe("Fold");
		expect(texts(poster.el, ".agent-wall-item.is-new .agent-wall-text")).toEqual(["Writing the shop texts"]);
		expect(document.activeElement).toBe(toggle(poster));
	});

	it("comes back once its text is read when Latest notes opened the thread first", () => {
		localStorage.setItem(`qorpera.agent-wall.hidden.${MEMBER}.${AGENT.id}`, "1");
		const poster = new AgentWallPoster({ member: MEMBER });
		document.body.append(poster.el);
		poster.reveal(AGENT.id);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, WALL, TODAY);
		expect(poster.shown).toBe(true);
		expect(toggle(poster).textContent).toBe("Fold");
		expect(document.activeElement).toBe(toggle(poster));
	});

	it("stays hidden while on screen when storage keeps nothing", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const poster = new AgentWallPoster({ member: MEMBER });
		poster.show(AGENT, WALL, TODAY);
		hide(poster).click();
		expect(poster.shown).toBe(false);
		poster.show(AGENT, CHANGED, TODAY);
		expect(poster.shown).toBe(false);
		poster.reveal(AGENT.id);
		expect(poster.shown).toBe(true);
		vi.restoreAllMocks();
	});

	it("takes no focus from a reveal long past, nor from a member typing", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const poster = new AgentWallPoster({ member: MEMBER });
			const field = document.createElement("textarea");
			document.body.append(poster.el, field);
			// The thread's read failed: the wall comes much later, on a folder hint.
			poster.reveal(AGENT.id);
			vi.setSystemTime(Date.now() + 60_000);
			poster.show(AGENT, WALL, TODAY);
			expect(poster.shown).toBe(true);
			expect(document.activeElement).toBe(document.body);
			// A reveal in time, while the member types: the wall shows open, the focus stays.
			const other = new AgentWallPoster({ member: MEMBER });
			document.body.append(other.el);
			field.focus();
			other.reveal(AGENT.id);
			other.show(AGENT, WALL, TODAY);
			expect(other.shown).toBe(true);
			expect(document.activeElement).toBe(field);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("items that open", () => {
	const DETAILED = `# Wall

## Waits on you
- Pick a bundle
  Two looks, same price. [The sketch](folder:sketches/bundles.svg)

## Working on
- Building the shop demo
  See [Shop demo](app:shop-demo)
- Checking prices
`;
	const row = (poster: AgentWallPoster, index: number) =>
		poster.el.querySelectorAll<HTMLElement>(".agent-wall-item")[index]!;

	it("shows headlines, and a click opens one's detail, links and preview", async () => {
		const image = vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" }));
		const poster = new AgentWallPoster({ image });
		document.body.append(poster.el);
		poster.show(AGENT, DETAILED, TODAY);
		expect(texts(poster.el, ".agent-wall-text")).toEqual([
			"Pick a bundle",
			"Building the shop demo",
			"Checking prices",
		]);
		// A headline with nothing more is no button.
		expect(row(poster, 2).querySelector(".agent-wall-row")).toBeNull();
		const button = row(poster, 0).querySelector<HTMLButtonElement>(".agent-wall-row")!;
		const detail = row(poster, 0).querySelector<HTMLElement>(".agent-wall-detail")!;
		expect([button.getAttribute("aria-expanded"), detail.hidden]).toEqual(["false", true]);
		expect(button.getAttribute("aria-controls")).toBe(detail.id);
		// The picture is read only when the item opens.
		expect(image).not.toHaveBeenCalled();
		button.click();
		expect([button.getAttribute("aria-expanded"), detail.hidden]).toEqual(["true", false]);
		expect(detail.querySelector(".agent-wall-detail-text")?.textContent).toBe("Two looks, same price. The sketch");
		// An SVG shows as a data: URL, never as a blob: page of the app's own origin.
		await vi.waitFor(() =>
			expect(detail.querySelector("img")?.getAttribute("src")).toBe(
				`data:image/svg+xml;charset=utf-8,${encodeURIComponent("<svg/>")}`,
			),
		);
		expect(image).toHaveBeenCalledWith("sketches/bundles.svg", expect.any(AbortSignal));
		// The picture opens in Storage, as its link does.
		expect(detail.querySelector<HTMLButtonElement>(".agent-wall-picture")?.dataset.folderPath).toBe(
			"sketches/bundles.svg",
		);
		// It stays open when the wall is drawn again, and closes on a second click.
		poster.show(AGENT, `${DETAILED}- Writing texts\n`, TODAY);
		expect(row(poster, 0).classList.contains("is-open")).toBe(true);
		expect(image).toHaveBeenCalledTimes(1);
		row(poster, 0).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		expect(row(poster, 0).querySelector<HTMLElement>(".agent-wall-detail")!.hidden).toBe(true);
		// An app it links opens as the message's app card.
		row(poster, 1).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		expect(row(poster, 1).querySelector(".agent-wall-preview.is-app .app-card")).not.toBeNull();
	});

	it("keeps a headline's links out of its row, reads an encoded picture path, and tells twin headlines apart", async () => {
		const image = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
		const created = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:logo");
		const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const poster = new AgentWallPoster({ image });
		document.body.append(poster.el);
		poster.show(
			AGENT,
			`## Waits on you
- Reply to ole@shop.dk, see www.shop.dk
  [Logo](folder:design/logo%20v2.png)
- Approve the post
  The first one.
- Approve the post
  The second one.
`,
			TODAY,
		);
		const buttons = [...poster.el.querySelectorAll<HTMLButtonElement>(".agent-wall-row")];
		// No link of any kind inside a row's button.
		expect(buttons.every((button) => !button.querySelector("a, button"))).toBe(true);
		expect(buttons[0]?.textContent).toContain("Reply to ole@shop.dk, see www.shop.dk");
		buttons[0]?.click();
		await vi.waitFor(() => expect(image).toHaveBeenCalledWith("design/logo v2.png", expect.any(AbortSignal)));
		await vi.waitFor(() =>
			expect(row(poster, 0).querySelector<HTMLButtonElement>(".agent-wall-picture")?.dataset.folderPath).toBe(
				"design/logo v2.png",
			),
		);
		// Two rows with the same headline open their own detail.
		const ids = buttons.map((button) => button.getAttribute("aria-controls"));
		expect(new Set(ids).size).toBe(3);
		buttons[2]?.click();
		expect(row(poster, 2).querySelector(".agent-wall-detail-text")?.textContent).toBe("The second one.");
		expect(row(poster, 1).querySelector<HTMLElement>(".agent-wall-detail")?.hidden).toBe(true);
		// The thread closes: its pictures go.
		poster.dispose();
		await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith("blob:logo"));
		created.mockRestore();
		revoked.mockRestore();
	});

	it("shows no preview when the picture cannot be read", async () => {
		const poster = new AgentWallPoster({ image: async () => null });
		document.body.append(poster.el);
		poster.show(AGENT, DETAILED, TODAY);
		row(poster, 0).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		await vi.waitFor(() => expect(row(poster, 0).querySelector(".agent-wall-preview")).toBeNull());
		expect(row(poster, 0).querySelector(".agent-wall-detail-text")).not.toBeNull();
	});
});
