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

describe("an agent's wall above its composer", () => {
	it("shows what waits, with a summary on its button, and nothing worked on or done", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL);
		expect(poster.shown).toBe(true);
		expect(poster.el.getAttribute("aria-label")).toBe("Shop Operations's wall");
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 waits on you");
		expect(poster.el.querySelector(".agent-wall-state")?.classList.contains("is-waiting")).toBe(true);
		expect(
			[...poster.el.querySelectorAll(".agent-wall-part")].map((part) => part.getAttribute("aria-label")),
		).toEqual(["Waits on you"]);
		// A link in a headline reads as its words on the row; the link itself is there when the row opens.
		expect(texts(poster.el, ".agent-wall-text")).toEqual(["Pick a shop name. My pick is Båndklar. The names"]);
		// What is worked on and what is done are not shown (Jonas, 10 Nov 2026).
		expect(poster.el.textContent).not.toContain("working");
		expect(poster.el.textContent).not.toContain("Checking five shops' prices");
		expect(poster.el.textContent).not.toContain("done");
		expect(poster.el.textContent).not.toContain("Two suppliers found");
		expect(poster.el.querySelector(".is-working, .is-done, .agent-wall-done")).toBeNull();
	});

	it("draws links as the same folder-link and app-card buttons a message has", () => {
		const poster = new AgentWallPoster();
		poster.show(
			AGENT,
			"## Waits on you\n- Pick a shop name. [The names](folder:research/shop-names.md)\n- Approve the list, see [Launch checklist](app:launch-checklist)\n",
		);
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

	it("is hidden with no agent, no wall, or a wall with nothing that waits", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, null);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, "# Wall\n\n## Waits on you\n\n## Working on\n\n## Done\n");
		expect(poster.shown).toBe(false);
		// Only work going on and work done: nothing to show.
		poster.show(AGENT, "## Working on\n- Writing the plan\n- Finding a supplier\n");
		expect(poster.shown).toBe(false);
		poster.show(
			AGENT,
			"## Working on\n- Writing the plan\n\n## Done\n- 2026-11-05: Plan written\n- 2026-11-04: Team hired\n",
		);
		expect(poster.shown).toBe(false);
		poster.show(undefined, WALL);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, WALL);
		expect(poster.shown).toBe(true);
		poster.show(AGENT, "");
		expect(poster.shown).toBe(false);
	});

	it("shows what reads of a wall that breaks its rules", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Waits on you\n- Approve the plan\nnot an item\n\n## Done\n- yesterday: Hired\n");
		expect(poster.shown).toBe(true);
		expect(texts(poster.el, ".agent-wall-text")).toEqual(["Approve the plan"]);
	});

	it("starts closed, even when something waits, opens on a click, and keeps that per agent", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL);
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		expect(poster.el.querySelector<HTMLElement>(".agent-wall-fold")!.inert).toBe(true);
		expect(toggle(poster).getAttribute("aria-expanded")).toBe("false");
		expect(toggle(poster).textContent).toContain("1 waits on you");
		toggle(poster).click();
		expect(poster.el.classList.contains("is-folded")).toBe(false);
		expect(toggle(poster).getAttribute("aria-expanded")).toBe("true");
		expect(poster.el.querySelector(".agent-wall-close-word")?.textContent).toBe("Close");
		// The same agent's thread opened again keeps it open.
		const again = new AgentWallPoster();
		again.show(AGENT, WALL);
		expect(again.el.classList.contains("is-folded")).toBe(false);
		toggle(again).click();
		expect(again.el.classList.contains("is-folded")).toBe(true);
	});

	it("marks what is new once opened, and forgets it once closed", () => {
		const first = new AgentWallPoster();
		first.show(AGENT, "## Waits on you\n- Approve the plan\n");
		// Seen for the first time: nothing to mark from.
		expect(first.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 waits on you");
		const CHANGED = "## Waits on you\n- Approve the plan\n- Pick a supplier\n\n## Done\n- 2026-11-05: Plan written\n";
		const next = new AgentWallPoster();
		next.show(AGENT, CHANGED);
		expect(next.el.classList.contains("is-folded")).toBe(true);
		expect(next.el.querySelector(".agent-wall-summary")?.textContent).toBe("2 wait on you");
		toggle(next).click();
		expect(texts(next.el, ".agent-wall-item.is-new .agent-wall-text")).toEqual(["Pick a supplier"]);
		expect(next.el.querySelector(".agent-wall-item.is-new .visually-hidden")?.textContent).toBe(" (New)");
		toggle(next).click();
		// Seen now: the next visit marks nothing.
		const later = new AgentWallPoster();
		later.show(AGENT, CHANGED);
		toggle(later).click();
		expect(later.el.querySelector(".agent-wall-item.is-new")).toBeNull();
	});

	it("settles only the item answered, until it leaves the wall", () => {
		const onAnswer = vi.fn();
		const poster = new AgentWallPoster({ onAnswer });
		const both = "# Wall\n\n## Waits on you\n- Approve the post\n  The first.\n- Approve the post\n  The second.\n";
		const first = "# Wall\n\n## Waits on you\n- Approve the post\n  The first.\n";
		const second = "# Wall\n\n## Waits on you\n- Approve the post\n  The second.\n";
		const summary = () => poster.el.querySelector(".agent-wall-summary")?.textContent;
		const buttons = () => [...poster.el.querySelectorAll<HTMLButtonElement>(".agent-wall-answer")];
		poster.show(AGENT, both);
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-toggle")?.click();
		buttons()[1]?.click();
		// Pressing Answer settles nothing until the answer is sent.
		expect(summary()).toBe("2 wait on you");
		// A press on another item meanwhile changes nothing about the answer on its way.
		const sending = onAnswer.mock.lastCall?.[1] as string;
		buttons()[0]?.click();
		poster.answerSent(sending);
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer", "Answered"]);
		expect(summary()).toBe("1 waits on you · 1 answered");
		// The answered one goes: its answer does not pass to the other.
		poster.show(AGENT, first);
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer"]);
		// The same words later are a new question.
		poster.show(AGENT, second);
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer"]);
		buttons()[0]?.click();
		poster.answerSent(onAnswer.mock.lastCall?.[1] as string);
		// With nothing else left, the closed button still says something.
		expect(summary()).toBe("1 answered");
	});

	it("answers what waits from the composer, when the view offers it", () => {
		const onAnswer = vi.fn();
		const poster = new AgentWallPoster({ onAnswer });
		poster.show(AGENT, WALL);
		const answers = poster.el.querySelectorAll<HTMLButtonElement>(".agent-wall-answer");
		expect(answers).toHaveLength(1);
		expect(answers[0]?.closest(".agent-wall-part")?.classList.contains("is-waiting")).toBe(true);
		expect(answers[0]?.closest(".agent-wall-row")).toBeNull();
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-toggle")?.click();
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-answer")?.click();
		expect(onAnswer).toHaveBeenCalledTimes(1);
		const question = onAnswer.mock.calls[0]?.[0] as string;
		expect(question.length).toBeGreaterThan(0);
		// The question moved down to the composer.
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		// Answered, it waits on nobody; the agent takes it off when it has read the answer.
		poster.answerSent(onAnswer.mock.calls[0]?.[1] as string);
		expect(poster.el.querySelector(".agent-wall-answer")?.textContent).toBe("Answered");
		expect(poster.el.querySelector(".agent-wall-count-waiting")).toBeNull();
		// The button's dot is for what still waits.
		expect(poster.el.querySelector(".agent-wall-state")?.classList.contains("is-waiting")).toBe(false);
		// It can still be answered again.
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-answer")?.click();
		expect(onAnswer).toHaveBeenCalledTimes(2);
		const without = new AgentWallPoster({ member: "someone-else" });
		without.show(AGENT, WALL);
		expect(without.el.querySelector(".agent-wall-answer")).toBeNull();
	});

	it("stays closed and marks an item that joins while it shows", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n");
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n- Pick a supplier\n");
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("2 wait on you");
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["Pick a supplier"]);
		// The mark stays while the member is here.
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n- Pick a supplier\n- Name the shop\n");
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["Pick a supplier", "Name the shop"]);
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
			poster.show(AGENT, WALL);
			expect(poster.shown).toBe(true);
			toggle(poster).click();
			expect(poster.el.classList.contains("is-folded")).toBe(false);
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

describe("Hiding", () => {
	const MEMBER = "u0000000-0000-4000-8000-00000000000a";

	it("has no way to hide the wall, and a wall hidden before this shows again", () => {
		localStorage.setItem(`qorpera.agent-wall.hidden.${MEMBER}.${AGENT.id}`, "1");
		const poster = new AgentWallPoster({ member: MEMBER });
		poster.show(AGENT, WALL);
		expect(poster.shown).toBe(true);
		expect(poster.el.querySelector(".agent-wall-hide")).toBeNull();
	});
});

describe("items that open", () => {
	const DETAILED = `# Wall

## Waits on you
- Pick a bundle
  Two looks, same price. [The sketch](folder:sketches/bundles.svg)
- Try the shop demo
  See [Shop demo](app:shop-demo)
- Confirm the prices
`;
	const row = (poster: AgentWallPoster, index: number) =>
		poster.el.querySelectorAll<HTMLElement>(".agent-wall-item")[index]!;
	const waiting = (poster: AgentWallPoster) => poster.el.querySelector<HTMLElement>(".is-waiting .agent-wall-item")!;

	it("shows headlines, and a click opens one's detail, links and preview", async () => {
		const image = vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" }));
		const poster = new AgentWallPoster({ image });
		document.body.append(poster.el);
		poster.show(AGENT, DETAILED);
		expect(texts(poster.el, ".agent-wall-text")).toEqual([
			"Pick a bundle",
			"Try the shop demo",
			"Confirm the prices",
		]);
		// A headline with nothing more is no button.

		const button = waiting(poster).querySelector<HTMLButtonElement>(".agent-wall-row")!;
		const detail = waiting(poster).querySelector<HTMLElement>(".agent-wall-detail")!;
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
		// It stays open when the wall changes, and closes on a second click.
		poster.show(AGENT, `${DETAILED}- Writing texts\n`);
		expect(waiting(poster).classList.contains("is-open")).toBe(true);
		// The wall changed, so the opened item reads its picture again: an agent may have redrawn the sketch.
		expect(image).toHaveBeenCalledTimes(2);
		waiting(poster).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		expect(waiting(poster).querySelector<HTMLElement>(".agent-wall-detail")!.hidden).toBe(true);
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
		poster.show(AGENT, DETAILED);
		waiting(poster).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		await vi.waitFor(() => expect(waiting(poster).querySelector(".agent-wall-preview")).toBeNull());
		expect(waiting(poster).querySelector(".agent-wall-detail-text")).not.toBeNull();
	});
});
