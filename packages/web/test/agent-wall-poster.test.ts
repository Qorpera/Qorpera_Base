// @vitest-environment jsdom
import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWallReader } from "../src/app/agent-wall.ts";
import { AgentWallPoster, type WallPosterAgent } from "../src/ui/agent-wall-poster.ts";
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
			"Choosing the shop system, see Launch checklistApp · opens beside the chat",
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
		expect(folder.readFile).not.toHaveBeenCalled();
	});
});
