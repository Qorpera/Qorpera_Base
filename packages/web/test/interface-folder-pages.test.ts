// @vitest-environment jsdom

import {
	type AgentFile,
	type HumanTaskFile,
	type RoutineFile,
	type TodoFile,
	writeAgentFile,
	writeConnectionFile,
	writeContactFile,
	writeGroupFile,
	writeHumanTaskFile,
	writeRoutineFile,
	writeSectionsFile,
	writeTodoFile,
	writeVisionFile,
} from "@qorpera/cloud-client/company-state-files";
import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import { writeInterfaceOrderFile } from "@qorpera/cloud-client/interfaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import { interfaceRows } from "../src/app/interfaces.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import type { HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { fmtTime, h } from "../src/ui/dom.ts";
import { setLanguagePreference, setTimeZonePreference } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* The interfaces' folder pages (RUNTIME-INTERFACES.md §10, "Built: folder pages"): the sources from the company
 * folder's own files, `activity`, and the text, numbers and calendar blocks, drawn from a member's folder
 * (folder-fake.ts). */

/** Tuesday 6 October 2026, 10:00 UTC. */
const NOW = Date.parse("2026-10-06T10:00:00Z");
const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const ids = {
	page: id(601),
	books: id(701),
	invoices: id(702),
	hire: id(703),
	brief: id(711),
	finance: id(721),
	github: id(731),
	ida: id(741),
	disk: id(751),
	vat: id(752),
	old: id(753),
	events: id(761),
};

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	localStorage.clear();
	setLanguagePreference("en");
	setTimeZonePreference("UTC");
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	sessionStorage.clear();
	localStorage.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company() {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	const me = { userId: userA.id, email: "a@example.invalid", displayName: "Account A", role: "owner" as const };
	// Ada waits for the member; the Co-Founder's wake-up finished after.
	const activity: HostedStaffExecutionActivity[] = [
		{
			staffAgentId: ada.id,
			runId: id(81),
			sourceKind: "session_turn",
			activity: "needs_attention",
			jobStatus: "leased",
			updatedAt: "2026-10-06T09:00:00Z",
		},
		{
			staffAgentId: cofounder.id,
			runId: id(82),
			sourceKind: "wake",
			activity: "waiting",
			jobStatus: "completed",
			updatedAt: "2026-10-06T09:30:00Z",
		},
	];
	controller.store.set({
		loading: false,
		staff: [cofounder, ada],
		sessions: [session],
		team: { ...team, role: "owner", members: [{ ...me, joinedAt: timestamp }] },
		activity,
	});
	cleanup.push(() => controller.stop());
	return { f, controller };
}

const VISION =
	"We make [bookkeeping](https://example.com/books) calm. ![A ledger](https://example.com/l.png) <b>Always</b>.\n\n" +
	"We answer within the hour.";

const agent = (who: HostedStaffAgent, update: Partial<Omit<AgentFile, "kind">> = {}) =>
	writeAgentFile({
		id: who.id,
		name: who.displayName,
		role: who.id === cofounder.id ? "Co-Founder" : "Bookkeeper",
		agentKind: who.id === cofounder.id ? "co-founder" : "agent",
		status: "active",
		colour: null,
		figure: null,
		model: null,
		effort: null,
		instructions: "Help the company.",
		...update,
	});
const todo = (fileId: string, title: string, update: Partial<Omit<TodoFile, "kind">> = {}) =>
	writeTodoFile({ id: fileId, title, status: "open", requestedBy: null, detail: "Do it.", ...update });
const routine = (update: Partial<Omit<RoutineFile, "kind">> = {}) =>
	writeRoutineFile({
		id: ids.brief,
		title: "Morning brief",
		status: "active",
		trigger: { when: "weekly", days: ["mon"], time: "08:30", starts: null },
		timezone: "Europe/Copenhagen",
		ends: null,
		runs: null,
		quiet: null,
		effort: "low",
		reply: "required",
		conclusion: null,
		instructions: "Summarise what changed.",
		...update,
	});
const task = (fileId: string, title: string, update: Partial<Omit<HumanTaskFile, "kind" | "steps">> = {}) =>
	writeHumanTaskFile({
		id: fileId,
		title,
		status: "open",
		member: userA.id,
		contact: null,
		from: ada.id,
		todo: null,
		due: "2026-10-07T16:00:00Z",
		minutes: null,
		proof: [],
		files: [],
		reason: null,
		secret: null,
		secretState: null,
		connection: null,
		step: null,
		instructions: "## Why\nIt matters.\n## Steps\n- [ ] Do it",
		...update,
	});
const group = (name = "Finance") =>
	writeGroupFile({
		id: ids.finance,
		name,
		subtitle: null,
		agents: [cofounder.id, ada.id],
		people: [userA.id],
		purpose: "The money.",
	});
const connection = (status: "connected" | "broken" = "connected") =>
	writeConnectionFile({
		id: ids.github,
		service: "github",
		account: "acme",
		status,
		actions: [],
		connectedBy: userA.id,
		connectedAt: "2026-10-01T09:00:00Z",
		purpose: "The code.",
	});
const contact = (name = "Ida Holm") =>
	writeContactFile({
		id: ids.ida,
		name,
		organization: "Holm Revision",
		email: null,
		phone: null,
		asks: [],
		notes: "",
	});

/** The company folder's own files: the vision, two agents in a section, their todos and a routine, a group chat, a
 * connection, a contact, and three human tasks, one of them done. */
function companyFiles(fake: FolderFake): void {
	fake.put("vision/vision.md", writeVisionFile("Acme", VISION));
	fake.put(
		"agents/sections.md",
		writeSectionsFile({
			sections: [
				{
					name: "Office",
					line: 1,
					members: [
						{ id: ada.id, line: 2 },
						{ id: cofounder.id, line: 3 },
					],
				},
			],
		}),
	);
	fake.put("agents/co-founder/agent.md", agent(cofounder));
	fake.put("agents/ada/agent.md", agent(ada));
	fake.put("agents/ada/todos/close-books.md", todo(ids.books, "Close the books", { requestedBy: userA.id }));
	fake.put("agents/ada/todos/send-invoices.md", todo(ids.invoices, "Send the invoices", { status: "done" }));
	fake.put("agents/ada/routines/morning-brief.md", routine());
	fake.put("agents/groups/finance/group.md", group());
	fake.put("connections/github-acme.md", connection());
	fake.put("contacts/ida-holm.md", contact());
	fake.put("human-tasks/fit-disk.md", task(ids.disk, "Fit the second disk"));
	fake.put(
		"human-tasks/file-vat.md",
		task(ids.vat, "File the VAT", { member: null, contact: ids.ida, due: "2026-10-09T09:00:00Z" }),
	);
	fake.put("human-tasks/old-task.md", task(ids.old, "Order disks", { status: "done", due: "2026-10-08T09:00:00Z" }));
}

/** An interface named Everything with one view of `blocks`. */
function page(blocks: string, name = "Everything"): string {
	return `format = "qorpera.interface/v0"

[interface]
id = "${ids.page}"
name = "${name}"

[[view]]
name = "Now"
${blocks}`;
}

const list = (from: string, line: string) => `
[[view.block]]
kind = "list"
title = "${from}"
from = "${from}"
line = "${line}"
`;

/** A folder with the company's own files and one interface, `text`, and no library interfaces: what is read is
 * what that one page names. */
function bare(text: string): FolderFake {
	const fake = folderFake({ seed: [] });
	companyFiles(fake);
	fake.put("interfaces/order.md", writeInterfaceOrderFile([ids.page]));
	fake.put("interfaces/everything/interface.toml", text);
	return fake;
}

/** A folder seeded as at founding, with the company's own files, `rows` in the numbers table, and `text` as one more
 * interface when given. */
function seeded(rows: string, text?: string): FolderFake {
	const fake = folderFake({ seed: [] });
	let next = 500;
	for (const [path, file] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, file);
	companyFiles(fake);
	fake.put("tables/numbers/rows.csv", rows);
	if (text !== undefined) {
		const pulse = /^id = "([0-9a-f-]{36})"$/m.exec(fake.text("interfaces/pulse/interface.toml") ?? "")?.[1] ?? "";
		fake.put("interfaces/order.md", writeInterfaceOrderFile([pulse, ids.page]));
		fake.put("interfaces/everything/interface.toml", text);
	}
	return fake;
}

/** Follows `fake` for `controller`'s company, as the app does; `hint` stands in for the folder's hint. */
async function follow(fake: FolderFake, controller: CompanyController) {
	let onHint: ((seq: number) => void) | undefined;
	const stop = new AbortController();
	const reader = new CompanyInterfaceFolder(
		{
			signal: stop.signal,
			current: () => {},
			folder: () => fake.folder,
			folderHints: (hint) => {
				onHint = hint;
				return { close: async () => {} };
			},
		},
		(state) => controller.store.set({ interfaceFolder: state }),
	);
	cleanup.push(() => stop.abort());
	await reader.open();
	return {
		/** The folder's hint, and the sync it asks for a second later. */
		hint: async () => {
			onHint?.(fake.seq);
			await vi.advanceTimersByTimeAsync(1000);
		},
	};
}

/** `name` drawn on the page, redrawn whenever the company's state changes. */
function shown(controller: CompanyController, name = "everything"): HTMLElement {
	const main = h("main");
	document.body.append(main);
	const draw = () => renderInterface(main, controller, name);
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return main;
}

const texts = (root: ParentNode | undefined, selector: string) =>
	[...(root?.querySelectorAll(selector) ?? [])].map((element) => element.textContent);
/** The drawn block with the title `title`. */
const titled = (root: ParentNode, title: string) =>
	[...root.querySelectorAll<HTMLElement>(".interface-block")].find(
		(block) => block.querySelector(":scope > h2")?.textContent === title,
	);
const rowsOf = (controller: CompanyController, source: string) =>
	interfaceRows(controller, source)?.map(({ row }) => row);
/** A time of day as a calendar writes it. */
const clock = (iso: string) =>
	new Date(iso).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

describe("the folder's own sources", () => {
	const EVERYTHING = page(
		[
			'\n[[view.block]]\nkind = "text"\nfrom = "vision"\n',
			list("agents", "{name}"),
			list("groups", "{name}"),
			list("todos", "{title}"),
			list("routines", "{title}"),
			list("connections", "{account}"),
			list("contacts", "{name}"),
			list("human_tasks", "{title}"),
			list("interfaces", "{name}"),
			'\n[[view.block]]\nkind = "table"\ntitle = "Work"\nfrom = "todos"\ncolumns = ["agent", "title", "status"]\n',
			'order = "title"\n',
		].join(""),
	);

	it("has each source's rows from its files, with the columns §4 gives it", async () => {
		const fake = bare(EVERYTHING);
		const { controller } = company();
		await follow(fake, controller);
		expect(rowsOf(controller, "vision")).toEqual([{ text: writeVisionFile("Acme", VISION) }]);
		// The agents in the order of their sections; an agent's row leads to its conversation.
		expect(rowsOf(controller, "agents")).toEqual([
			{
				id: ada.id,
				name: "Ada",
				role: "Bookkeeper",
				figure: ada.id,
				colour: null,
				status: "active",
				section: "Office",
			},
			{
				id: cofounder.id,
				name: "Co-Founder",
				role: "Co-Founder",
				figure: cofounder.id,
				colour: null,
				status: "active",
				section: "Office",
			},
		]);
		expect(interfaceRows(controller, "agents")?.map((item) => item.href)).toEqual([
			`#/c/${profileA.profileId}/staff/${ada.id}`,
			`#/c/${profileA.profileId}`,
		]);
		expect(rowsOf(controller, "groups")).toEqual([
			{ id: ids.finance, name: "Finance", agents: [cofounder.id, ada.id], people: [userA.id] },
		]);
		expect(rowsOf(controller, "todos")).toEqual([
			{
				id: ids.books,
				agent: ada.id,
				title: "Close the books",
				status: "open",
				requested_by: userA.id,
				updated: "2026-10-04T09:00:00Z",
			},
			{
				id: ids.invoices,
				agent: ada.id,
				title: "Send the invoices",
				status: "done",
				requested_by: null,
				updated: "2026-10-04T09:00:00Z",
			},
		]);
		// A routine's next run: Monday 08:30 in Copenhagen.
		expect(rowsOf(controller, "routines")).toEqual([
			{
				id: ids.brief,
				agent: ada.id,
				title: "Morning brief",
				when: expect.any(String),
				next: "2026-10-12T06:30:00Z",
				status: "active",
			},
		]);
		expect(rowsOf(controller, "connections")).toEqual([
			{ id: ids.github, service: "github", account: "acme", status: "connected" },
		]);
		expect(rowsOf(controller, "contacts")).toEqual([
			{ id: ids.ida, name: "Ida Holm", organization: "Holm Revision" },
		]);
		// A task for a contact shows the contact's name; a task for a member, the member's id.
		expect(rowsOf(controller, "human_tasks")).toEqual([
			{
				id: ids.vat,
				title: "File the VAT",
				status: "open",
				person: "Ida Holm",
				from: ada.id,
				due: "2026-10-09T09:00:00Z",
			},
			{
				id: ids.disk,
				title: "Fit the second disk",
				status: "open",
				person: userA.id,
				from: ada.id,
				due: "2026-10-07T16:00:00Z",
			},
			{
				id: ids.old,
				title: "Order disks",
				status: "done",
				person: userA.id,
				from: ada.id,
				due: "2026-10-08T09:00:00Z",
			},
		]);
		expect(rowsOf(controller, "interfaces")).toEqual([expect.objectContaining({ id: ids.page, name: "Everything" })]);
		expect(interfaceRows(controller, "interfaces")?.map((item) => item.href)).toEqual([
			`#/c/${profileA.profileId}/i/everything`,
		]);
		// A table of the todos shows names and statuses in the member's words.
		const main = shown(controller);
		expect(texts(titled(main, "Work"), "thead th")).toEqual(["Agent", "Title", "Status"]);
		expect(texts(titled(main, "Work"), "tbody td")).toEqual([
			"Ada",
			"Close the books",
			"To do",
			"Ada",
			"Send the invoices",
			"Done",
		]);
		expect(texts(titled(main, "agents"), ".interface-item strong")).toEqual(["Ada", "Co-Founder"]);
	});

	it("redraws each source when its files change", async () => {
		const fake = bare(EVERYTHING);
		const { controller } = company();
		const { hint } = await follow(fake, controller);
		const main = shown(controller);
		fake.put("vision/vision.md", writeVisionFile("Acme", "We keep the books."));
		fake.put("agents/ada/agent.md", agent(ada, { role: "Controller" }));
		fake.put("agents/groups/finance/group.md", group("Money"));
		fake.put("agents/ada/todos/close-books.md", todo(ids.books, "Close the books", { status: "blocked" }));
		// A new folder: the Co-Founder's first todo.
		fake.put("agents/co-founder/todos/hire.md", todo(ids.hire, "Hire a seller"));
		fake.put("agents/ada/routines/morning-brief.md", routine({ status: "paused" }));
		fake.put("connections/github-acme.md", connection("broken"));
		fake.put("contacts/ida-holm.md", contact("Ida Berg"));
		fake.put("human-tasks/fit-disk.md", task(ids.disk, "Fit the second disk", { status: "done" }));
		fake.put("interfaces/everything/interface.toml", EVERYTHING.replace('name = "Everything"', 'name = "All of it"'));
		await hint();
		await vi.waitFor(() =>
			expect(texts(titled(main, "Work"), "tbody td")).toEqual([
				"Ada",
				"Close the books",
				"Blocked",
				"Co-Founder",
				"Hire a seller",
				"To do",
				"Ada",
				"Send the invoices",
				"Done",
			]),
		);
		expect(rowsOf(controller, "vision")).toEqual([{ text: writeVisionFile("Acme", "We keep the books.") }]);
		expect(rowsOf(controller, "agents")?.map((row) => row.role)).toEqual(["Controller", "Co-Founder"]);
		expect(rowsOf(controller, "groups")?.map((row) => row.name)).toEqual(["Money"]);
		expect(rowsOf(controller, "routines")?.map((row) => row.status)).toEqual(["paused"]);
		expect(rowsOf(controller, "connections")?.map((row) => row.status)).toEqual(["broken"]);
		expect(rowsOf(controller, "contacts")?.map((row) => row.name)).toEqual(["Ida Berg"]);
		expect(rowsOf(controller, "human_tasks")?.map((row) => [row.person, row.status])).toEqual([
			["Ida Berg", "open"],
			[userA.id, "done"],
			[userA.id, "done"],
		]);
		expect(rowsOf(controller, "interfaces")?.map((row) => row.name)).toEqual(["All of it"]);
	});

	it("leaves out a file that doesn't parse and lists it as its source's problem", async () => {
		const fake = bare(page(list("todos", "{title}")));
		fake.put("agents/ada/todos/broken.md", "---\nid: not-an-id\n---\n");
		const { controller } = company();
		await follow(fake, controller);
		const block = titled(shown(controller), "todos");
		expect(block?.querySelector(".interface-note p")?.textContent).toBe("Some rows can't be shown.");
		const problems = texts(block, ".interface-problems li");
		expect(problems.length).toBeGreaterThan(0);
		for (const problem of problems) expect(problem).toMatch(/^agents\/ada\/todos\/broken\.md(:\d+)?: \S/);
		expect(texts(block, ".interface-item strong")).toEqual(["Close the books", "Send the invoices"]);
	});

	it("lists and reads only the folders the drawn blocks name", async () => {
		const fake = bare(page(list("todos", "{title}")));
		const { controller } = company();
		await follow(fake, controller);
		const listed = fake.folder.list.mock.calls.map(([folder]) => folder);
		expect(listed).toEqual(expect.arrayContaining(["agents", "agents/ada", "agents/ada/todos"]));
		for (const folder of ["vision", "connections", "contacts", "human-tasks", "agents/groups", "agents/ada/routines"])
			expect(listed).not.toContain(folder);
		expect(rowsOf(controller, "routines")).toBeUndefined();
	});
});

describe("the activity source", () => {
	it("has one plain sentence per run, newest first, with its kind, agent and member", async () => {
		const fake = bare(
			page(`
[[view.block]]
kind = "table"
title = "Runs"
from = "activity"
columns = ["kind", "agent", "line"]
`),
		);
		const { controller } = company();
		await follow(fake, controller);
		expect(rowsOf(controller, "activity")).toEqual([
			{ at: "2026-10-06T09:30:00Z", kind: "wake", agent: cofounder.id, member: null, line: "Co-Founder finished" },
			{ at: "2026-10-06T09:00:00Z", kind: "run", agent: ada.id, member: null, line: "Ada needs you" },
		]);
		const block = titled(shown(controller), "Runs");
		expect(texts(block, "thead th")).toEqual(["Kind", "Agent", "What"]);
		expect(texts(block, "tbody td")).toEqual([
			"Wake-up",
			"Co-Founder",
			"Co-Founder finished",
			"Run",
			"Ada",
			"Ada needs you",
		]);
	});
});

describe("the text block", () => {
	const TEXTS = page(`
[[view.block]]
kind = "text"
title = "All"
from = "vision"

[[view.block]]
kind = "text"
title = "First"
from = "vision"
show = "first-paragraph"

[[view.block]]
kind = "text"
title = "Inline"
text = "Ask **Ada** first. <i>Now</i>."

[[view.block]]
kind = "text"
title = "Notes"
from = "file:notes/today.md"

[[view.block]]
kind = "text"
title = "Task"
from = "file:human-tasks/fit-disk.md"
`);
	const FIRST = "We make bookkeeping calm. A ledger <b>Always</b>.";

	it("draws the vision or its first paragraph, a link as its text and an image as its alt text, no HTML", async () => {
		const fake = bare(TEXTS);
		fake.put("notes/today.md", "Ship the **ledger**.\n\nThen rest.");
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller);
		expect(texts(main, ".interface-block > h2")).toEqual(["All", "First", "Inline", "Notes"]);
		const all = titled(main, "All")!.querySelector(".message-prose")!;
		expect(texts(all, "h2")).toEqual(["Acme"]);
		expect(texts(all, "p")).toEqual([FIRST, "We answer within the hour."]);
		expect(texts(all, "p span")).toEqual(["bookkeeping"]);
		const first = titled(main, "First")!.querySelector(".message-prose")!;
		expect(first.querySelector("h2")).toBeNull();
		expect(texts(first, "p")).toEqual([FIRST]);
		const inline = titled(main, "Inline")!.querySelector(".message-prose")!;
		expect(inline.textContent).toBe("Ask Ada first. <i>Now</i>.");
		expect(texts(inline, "strong")).toEqual(["Ada"]);
		const notes = titled(main, "Notes")!.querySelector(".message-prose")!;
		expect(texts(notes, "p")).toEqual(["Ship the ledger.", "Then rest."]);
		// Nothing leaves the page or is fetched, and no HTML is drawn.
		expect(
			main.querySelector(".interface-text a, .interface-text img, .interface-text b, .interface-text i"),
		).toBeNull();
		// A human task's file is outside content: it stays unread and its block isn't drawn.
		expect(fake.folder.read.mock.calls.map(([path]) => path)).toContain("notes/today.md");
		expect(fake.folder.read.mock.calls.map(([path]) => path)).not.toContain("human-tasks/fit-disk.md");
	});
});

describe("the numbers block", () => {
	const ROWS = [
		"number,at,value,unit,target,kept_by",
		`Revenue,2026-09-01T09:00Z,1000,€,1500,${ada.id}`,
		`Revenue,2026-09-15T09:00Z,1100,€,1500,${ada.id}`,
		`Revenue,2026-10-01T09:00Z,1200,€,1500,${ada.id}`,
		`Churn,2026-10-01T09:00Z,3,%,,${ada.id}`,
		`Users,2026-06-01T09:00Z,40,count,,${ada.id}`,
		`Users,2026-10-05T09:00Z,40,count,,${ada.id}`,
		"",
	].join("\n");
	const NUMBERS = page(`
[[view.block]]
kind = "numbers"
title = "Numbers"
from = "table:numbers"
latest_by = "number"
value = "value"
target = "target"
trend = { over = "at", weeks = 12 }
opens = "number"

[[view.block]]
id = "number"
kind = "detail"
from = "table:numbers"
fields = ["number", "value"]
`);

	it("draws each number's value, its change, its target and its trend, and opens it", async () => {
		const fake = seeded(ROWS, NUMBERS);
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller);
		const tiles = () =>
			[...(titled(main, "Numbers")?.querySelectorAll(".interface-number-tiles li") ?? [])].map((tile) => ({
				label: tile.querySelector(".interface-number-label")?.textContent,
				value: tile.querySelector(".interface-number-value")?.textContent,
				change: tile.querySelector(".interface-number-change")?.textContent ?? null,
				target: tile.querySelector(".interface-number-target")?.textContent ?? null,
				trend: tile.querySelector("svg.interface-trend polyline")?.getAttribute("points")?.split(" ").length ?? 0,
			}));
		expect(tiles()).toEqual([
			{
				label: "Revenue",
				value: "€1,200",
				change: `+€100 since ${fmtTime("2026-09-15T09:00:00Z")}`,
				target: "Target €1,500",
				trend: 3,
			},
			{ label: "Churn", value: "3%", change: null, target: null, trend: 0 },
			// June is before the twelve weeks: its reading counts for the change and not for the trend.
			{
				label: "Users",
				value: "40",
				change: `No change since ${fmtTime("2026-06-01T09:00:00Z")}`,
				target: null,
				trend: 0,
			},
		]);
		expect(titled(main, "Numbers")?.querySelector("svg.interface-trend")?.getAttribute("aria-label")).toBe(
			"Trend over 12 weeks",
		);
		// A tile opens its number in the detail.
		titled(main, "Numbers")!.querySelector<HTMLButtonElement>("button.interface-number")!.click();
		await vi.waitFor(() => expect(texts(main, ".interface-fields dd")).toEqual(["Revenue", "1200"]));
		expect(titled(main, "Numbers")?.querySelector("button.interface-number")?.classList.contains("is-open")).toBe(
			true,
		);
	});
});

describe("the calendar block", () => {
	it("draws the days ahead: an open human task's due time and a routine's next run", async () => {
		const fake = bare(
			page(`
[[view.block]]
kind = "calendar"
title = "Coming up"
from = ["routines", "human_tasks"]
days = 14

[[view.block]]
kind = "calendar"
title = "Soon"
from = ["routines", "human_tasks"]
days = 3
`),
		);
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller);
		const coming = titled(main, "Coming up");
		// The done task is left out; a day with nothing on it is too.
		expect(texts(coming, ".interface-day h3")).toEqual(["Tomorrow", "Friday, October 9", "Monday, October 12"]);
		expect(texts(coming, ".interface-day-items strong")).toEqual([
			"Fit the second disk",
			"File the VAT",
			"Morning brief",
		]);
		expect(texts(coming, ".interface-day-items small")).toEqual([
			`${clock("2026-10-07T16:00:00Z")} · Task`,
			`${clock("2026-10-09T09:00:00Z")} · Task`,
			`${clock("2026-10-12T06:30:00Z")} · Routine`,
		]);
		expect(coming?.querySelectorAll(".interface-day-items .interface-item-figure")).toHaveLength(3);
		expect(texts(titled(main, "Soon"), ".interface-day h3")).toEqual(["Tomorrow"]);
	});

	it("draws from the sources it has, a table's dates among them, and isn't drawn without one", async () => {
		const fake = bare(
			page(`
[[view.block]]
kind = "calendar"
title = "Plans"
from = ["routines", "table:events", "table:missing"]

[[view.block]]
kind = "calendar"
title = "Nowhere"
from = ["table:missing"]
`),
		);
		fake.put(
			"tables/events/table.toml",
			`format = "qorpera.table/v0"

[table]
id = "${ids.events}"
name = "Events"
rows = "file"
key = ["event"]

[[column]]
name = "event"
type = "text"

[[column]]
name = "on"
type = "date"
`,
		);
		fake.put("tables/events/rows.csv", "event,on\nBoard meeting,2026-10-08\nSummer party,2026-09-01\n");
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller);
		expect(texts(main, ".interface-block > h2")).toEqual(["Plans"]);
		const plans = titled(main, "Plans");
		expect(texts(plans, ".interface-day h3")).toEqual(["Thursday, October 8", "Monday, October 12"]);
		expect(texts(plans, ".interface-day-items strong")).toEqual(["Board meeting", "Morning brief"]);
		expect(texts(plans, ".interface-day-items small")).toEqual([
			"Events",
			`${clock("2026-10-12T06:30:00Z")} · Routine`,
		]);
		expect(plans?.querySelector(".interface-note")).toBeNull();
	});
});

describe("Pulse from the folder", () => {
	const ROWS = `number,at,value,unit,target,kept_by\nRevenue,2026-10-01T09:00Z,1200,€,1500,${ada.id}\n`;

	it("draws every block whose source the folder has", async () => {
		const fake = seeded(ROWS);
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller, "pulse");
		expect(texts(main, ".interface-block > h2")).toEqual([
			"Needs you",
			"The numbers",
			"Working now",
			"What happened",
			"The work",
			"Coming up",
		]);
		expect(main.querySelector(".interface-text .message-prose")?.textContent).toBe(
			"We make bookkeeping calm. A ledger <b>Always</b>.",
		);
		expect(texts(titled(main, "The numbers"), ".interface-number-value")).toEqual(["€1,200"]);
		expect(texts(titled(main, "What happened"), ".interface-item strong")).toEqual([
			"Co-Founder finished",
			"Ada needs you",
		]);
		const work = titled(main, "The work");
		expect(texts(work, ".interface-item strong")).toEqual(["Ada"]);
		expect(texts(work, ".interface-item small")).toEqual(["Close the books"]);
		expect(texts(work, ".interface-item-status")).toEqual(["To do"]);
		expect(texts(titled(main, "Coming up"), ".interface-day h3")).toEqual([
			"Tomorrow",
			"Friday, October 9",
			"Monday, October 12",
		]);
	});

	it("leaves out a block whose source is missing", async () => {
		const fake = seeded(ROWS);
		fake.remove("tables/numbers");
		const { controller } = company();
		await follow(fake, controller);
		const main = shown(controller, "pulse");
		expect(texts(main, ".interface-block > h2")).toEqual([
			"Needs you",
			"Working now",
			"What happened",
			"The work",
			"Coming up",
		]);
	});
});
