// @vitest-environment jsdom
import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentWallReader } from "../src/app/agent-wall.ts";
import { AgentWallPoster, type WallPosterAgent, wallNews } from "../src/ui/agent-wall-poster.ts";
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

describe("an agent's wall above its composer", () => {
	it("shows done, working and, nearest the composer, waiting, with a summary on its button", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
		expect(poster.shown).toBe(true);
		expect(poster.el.getAttribute("aria-label")).toBe("Shop Operations's wall");
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 waits on you · 2 working · 5 done");
		expect(poster.el.querySelector(".agent-wall-state")?.classList.contains("is-waiting")).toBe(true);
		expect(
			[...poster.el.querySelectorAll(".agent-wall-part")].map((part) => part.getAttribute("aria-label")),
		).toEqual(["Done", "Working on", "Waits on you"]);
		expect(texts(poster.el, ".is-waiting .agent-wall-text")).toEqual([
			"Pick a shop name. My pick is Båndklar. The names",
		]);
		expect(texts(poster.el, ".is-working .agent-wall-text")).toEqual([
			"Checking five shops' prices",
			// A link in a headline reads as its words on the row; the link itself is there when the row opens.
			"Choosing the shop system, see Launch checklist",
		]);
		// Done is one line until it opens.
		expect(texts(poster.el, ".is-done .agent-wall-text")).toEqual(["5 done"]);
		expect(poster.el.querySelectorAll(".is-done .agent-wall-item")).toHaveLength(0);
	});

	it("opens the done line to the week and says how many are earlier", () => {
		const poster = new AgentWallPoster();
		document.body.append(poster.el);
		poster.show(AGENT, WALL, TODAY);
		const done = () => poster.el.querySelector<HTMLButtonElement>(".agent-wall-done")!;
		done().click();
		expect(texts(poster.el, ".is-done .agent-wall-item .agent-wall-text")).toEqual([
			"Team hired",
			"Test list",
			"Shop launch plan",
			"Two suppliers found",
		]);
		expect(texts(poster.el, ".agent-wall-done .agent-wall-text")).toEqual(["Show fewer · Earlier: 1"]);
		expect(done().getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(done());
		done().click();
		expect(poster.el.querySelectorAll(".is-done .agent-wall-item")).toHaveLength(0);
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

	it("starts closed, even when something waits, opens on a click, and keeps that per agent", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, WALL, TODAY);
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
		again.show(AGENT, WALL, TODAY);
		expect(again.el.classList.contains("is-folded")).toBe(false);
		toggle(again).click();
		expect(again.el.classList.contains("is-folded")).toBe(true);
	});

	it("leads with a spinner while only work goes on, and with nothing when all is done", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working");
		expect(poster.el.querySelector(".agent-wall-state")?.classList.contains("is-working")).toBe(true);
		const done = new AgentWallPoster({ member: "someone-else" });
		done.show(AGENT, "## Done\n- 2026-11-05: Plan written\n", TODAY);
		expect(done.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 done");
		expect(done.el.querySelector(".agent-wall-state")?.className).toBe("agent-wall-state");
	});

	it("counts what is new on the closed button, shows it under the done line, and forgets it once closed", () => {
		const first = new AgentWallPoster();
		first.show(AGENT, "## Working on\n- Writing the plan\n\n## Done\n- 2026-11-04: Old\n", TODAY);
		// Seen for the first time: nothing to mark from.
		expect(first.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working · 1 done");
		const CHANGED = "## Working on\n- Writing the plan\n\n## Done\n- 2026-11-05: Plan written\n- 2026-11-04: Old\n";
		const next = new AgentWallPoster();
		next.show(AGENT, CHANGED, TODAY);
		// Stays closed for what is new: the button says so.
		expect(next.el.classList.contains("is-folded")).toBe(true);
		expect(next.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working · 1 just done");
		// Not seen while closed: another visit counts it too.
		const closed = new AgentWallPoster();
		closed.show(AGENT, CHANGED, TODAY);
		expect(closed.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working · 1 just done");
		toggle(closed).click();
		expect(texts(closed.el, ".agent-wall-done .agent-wall-text")).toEqual(["1 more done"]);
		expect(texts(closed.el, ".agent-wall-item.is-new .agent-wall-text")).toEqual(["Plan written"]);
		expect(closed.el.querySelector(".agent-wall-item.is-new .visually-hidden")?.textContent).toBe(" (New)");
		toggle(closed).click();
		expect(closed.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working · 2 done");
		// Seen now: the next visit marks nothing.
		const later = new AgentWallPoster();
		later.show(AGENT, CHANGED, TODAY);
		expect(later.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 working · 2 done");
	});

	it("has no done line when all that is done is new", () => {
		const first = new AgentWallPoster();
		first.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		const next = new AgentWallPoster();
		next.show(AGENT, "## Working on\n- Writing the plan\n\n## Done\n- 2026-11-05: Plan written\n", TODAY);
		expect(next.el.querySelector(".agent-wall-done")).toBeNull();
		expect(texts(next.el, ".is-done .agent-wall-text")).toEqual(["Plan written"]);
	});

	it("settles only the item answered, until it leaves the wall", () => {
		const poster = new AgentWallPoster({ onAnswer: vi.fn() });
		const both = "# Wall\n\n## Waits on you\n- Approve the post\n  The first.\n- Approve the post\n  The second.\n";
		const first = "# Wall\n\n## Waits on you\n- Approve the post\n  The first.\n";
		const second = "# Wall\n\n## Waits on you\n- Approve the post\n  The second.\n";
		const summary = () => poster.el.querySelector(".agent-wall-summary")?.textContent;
		const buttons = () => [...poster.el.querySelectorAll<HTMLButtonElement>(".agent-wall-answer")];
		poster.show(AGENT, both, TODAY);
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-toggle")?.click();
		buttons()[1]?.click();
		// Pressing Answer settles nothing until the answer is sent.
		expect(summary()).toBe("2 wait on you");
		poster.answerSent();
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer", "Answered"]);
		expect(summary()).toBe("1 waits on you · 1 answered");
		// The answered one goes: its answer does not pass to the other.
		poster.show(AGENT, first, TODAY);
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer"]);
		// The same words later are a new question.
		poster.show(AGENT, second, TODAY);
		expect(buttons().map((button) => button.textContent)).toEqual(["Answer"]);
		buttons()[0]?.click();
		poster.answerSent();
		// With nothing else left, the closed button still says something.
		expect(summary()).toBe("1 answered");
	});

	it("answers what waits from the composer, when the view offers it", () => {
		const onAnswer = vi.fn();
		const poster = new AgentWallPoster({ onAnswer });
		poster.show(AGENT, WALL, TODAY);
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
		poster.answerSent();
		expect(poster.el.querySelector(".agent-wall-answer")?.textContent).toBe("Answered");
		expect(poster.el.querySelector(".agent-wall-count-waiting")).toBeNull();
		// It can still be answered again.
		poster.el.querySelector<HTMLButtonElement>(".agent-wall-answer")?.click();
		expect(onAnswer).toHaveBeenCalledTimes(2);
		const without = new AgentWallPoster({ member: "someone-else" });
		without.show(AGENT, WALL, TODAY);
		expect(without.el.querySelector(".agent-wall-answer")).toBeNull();
	});

	it("stays closed and marks an item that joins while it shows", () => {
		const poster = new AgentWallPoster();
		poster.show(AGENT, "## Working on\n- Writing the plan\n", TODAY);
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n\n## Working on\n- Writing the plan\n", TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		expect(poster.el.querySelector(".agent-wall-summary")?.textContent).toBe("1 waits on you · 1 working");
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["Approve the plan"]);
		// The mark stays while the member is here.
		poster.show(AGENT, "## Waits on you\n- Approve the plan\n\n## Working on\n- Writing the plan\n- More\n", TODAY);
		expect(texts(poster.el, ".is-new .agent-wall-text")).toEqual(["More", "Approve the plan"]);
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

describe("Latest notes", () => {
	const MEMBER = "u0000000-0000-4000-8000-00000000000a";
	const CHANGED = WALL.replace(
		"- Checking five shops' prices\n",
		"- Checking five shops' prices\n- Writing the shop texts\n",
	);

	it("counts what this member has not seen open", () => {
		const poster = new AgentWallPoster({ member: MEMBER });
		poster.show(AGENT, WALL, TODAY);
		expect(wallNews(MEMBER, AGENT.id, CHANGED)).toEqual({ items: 9, unseen: 1 });
		// What another member saw on this device is theirs.
		expect(wallNews("someone-else", AGENT.id, CHANGED)).toEqual({ items: 9, unseen: 0 });
	});

	it("has no way to hide the wall, and a wall hidden before this shows again", () => {
		localStorage.setItem(`qorpera.agent-wall.hidden.${MEMBER}.${AGENT.id}`, "1");
		const poster = new AgentWallPoster({ member: MEMBER });
		poster.show(AGENT, WALL, TODAY);
		expect(poster.shown).toBe(true);
		expect(poster.el.querySelector(".agent-wall-hide")).toBeNull();
	});

	it("opens the wall, with what is new marked, and takes focus", () => {
		const poster = new AgentWallPoster({ member: MEMBER });
		document.body.append(poster.el);
		poster.show(AGENT, WALL, TODAY);
		poster.show(AGENT, CHANGED, TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(true);
		poster.reveal(AGENT.id);
		expect(poster.el.classList.contains("is-folded")).toBe(false);
		expect(texts(poster.el, ".agent-wall-item.is-new .agent-wall-text")).toEqual(["Writing the shop texts"]);
		expect(document.activeElement).toBe(toggle(poster));
	});

	it("opens once its text is read when Latest notes opened the thread first", () => {
		const poster = new AgentWallPoster({ member: MEMBER });
		document.body.append(poster.el);
		poster.reveal(AGENT.id);
		expect(poster.shown).toBe(false);
		poster.show(AGENT, WALL, TODAY);
		expect(poster.el.classList.contains("is-folded")).toBe(false);
		expect(document.activeElement).toBe(toggle(poster));
	});

	it("opens when storage keeps nothing", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		try {
			const poster = new AgentWallPoster({ member: MEMBER });
			poster.reveal(AGENT.id);
			poster.show(AGENT, WALL, TODAY);
			expect(poster.el.classList.contains("is-folded")).toBe(false);
		} finally {
			vi.restoreAllMocks();
		}
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
	const waiting = (poster: AgentWallPoster) => poster.el.querySelector<HTMLElement>(".is-waiting .agent-wall-item")!;

	it("shows headlines, and a click opens one's detail, links and preview", async () => {
		const image = vi.fn(async () => new Blob(["<svg/>"], { type: "image/svg+xml" }));
		const poster = new AgentWallPoster({ image });
		document.body.append(poster.el);
		poster.show(AGENT, DETAILED, TODAY);
		expect(texts(poster.el, ".agent-wall-text")).toEqual([
			"Building the shop demo",
			"Checking prices",
			"Pick a bundle",
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
		poster.show(AGENT, `${DETAILED}- Writing texts\n`, TODAY);
		expect(waiting(poster).classList.contains("is-open")).toBe(true);
		// The wall changed, so the opened item reads its picture again: an agent may have redrawn the sketch.
		expect(image).toHaveBeenCalledTimes(2);
		waiting(poster).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		expect(waiting(poster).querySelector<HTMLElement>(".agent-wall-detail")!.hidden).toBe(true);
		// An app it links opens as the message's app card.
		row(poster, 0).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		expect(row(poster, 0).querySelector(".agent-wall-preview.is-app .app-card")).not.toBeNull();
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
		waiting(poster).querySelector<HTMLButtonElement>(".agent-wall-row")!.click();
		await vi.waitFor(() => expect(waiting(poster).querySelector(".agent-wall-preview")).toBeNull());
		expect(waiting(poster).querySelector(".agent-wall-detail-text")).not.toBeNull();
	});
});
