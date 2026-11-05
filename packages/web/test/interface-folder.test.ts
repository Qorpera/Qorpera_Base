// @vitest-environment jsdom

import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import { parseInterfaceFile } from "@qorpera/cloud-client/interfaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import type { InterfacePagesState } from "../src/app/interface-pages.ts";
import { companyInterfaces, folderSources, pagesOn } from "../src/app/interfaces.ts";
import type { Route } from "../src/app/router.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* Interfaces steps I7 and C6a (RUNTIME-INTERFACES.md §10; the 2026-10-17 scope amendment): a company's pages are the
 * two the web ships, Mailbox and Members, each shown once it is on. What they read, their tables and files, comes from
 * the folder, parsed by the client from their text, and follows the folder's feed. The folder's QorperaOS/interfaces/
 * is never read. The folder is the member's (folder-fake.ts). */

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const me = userA.id;
const bea = id(42);

const AREAS = "QorperaOS/tables/areas/rows.csv";
const areas = (...rows: string[]) => `${["area,about,owner,shared,supervisor,agents", ...rows].join("\n")}\n`;
const SALES = `Sales,Deals and leads,${me},no,${bea},${ada.id}`;

const ON: InterfacePagesState = {
	pages: [
		{ page: "mailbox", on: true },
		{ page: "members", on: true },
	],
	mayChange: true,
};
const OFF: InterfacePagesState = {
	pages: [
		{ page: "mailbox", on: false },
		{ page: "members", on: false },
	],
	mayChange: true,
};

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	sessionStorage.clear();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

let companies = 0;
/** A company of two members, so Members' team need is met, with `pages`. Each test's company is new, so no page state
 * carries over. */
function company(pages: InterfacePagesState = ON) {
	const f = fixture();
	const profile = { ...profileA, profileId: id(300 + ++companies) };
	const controller = new CompanyController(f.api, profile, me);
	const member = (userId: string, displayName: string, role: "owner" | "admin") => ({
		userId,
		email: `${displayName.toLowerCase().replace(/\s/g, "")}@example.invalid`,
		displayName,
		role,
		joinedAt: timestamp,
	});
	controller.store.set({
		loading: false,
		staff: [cofounder, ada],
		sessions: [session],
		team: {
			...team,
			profileId: profile.profileId,
			role: "owner",
			members: [member(me, "Account A", "owner"), member(bea, "Bea", "admin")],
		},
		interfacePages: pages,
	});
	cleanup.push(() => controller.stop());
	return { f, controller };
}

/** A folder seeded as at founding (the library's interfaces and tables with fresh ids, and
 * `QorperaOS/interfaces/order.md`), with one area. */
function seeded(): FolderFake {
	const fake = folderFake({ seed: [] });
	let next = 500;
	for (const [path, text] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, text);
	fake.put(AREAS, areas(SALES));
	return fake;
}

/** A page with one list of what waits for the member, then `blocks`. */
function page(name: string, blocks = ""): string {
	return `format = "qorpera.interface/v0"

[interface]
id = "${id(601)}"
name = "${name}"

[[view]]
name = "Now"

[[view.block]]
kind = "list"
title = "${name} list"
from = "waiting"
line = "{title}"
${blocks}`;
}

/** Follows `fake` for the pages `controller`'s company has on, as the app does; `hint` stands in for the folder's
 * hint. */
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
	reader.read(pagesOn(controller.store.get().interfacePages));
	await reader.open();
	return {
		reader,
		/** The folder's hint, and the sync it asks for a second later. */
		hint: async () => {
			onHint?.(fake.seq);
			await vi.advanceTimersByTimeAsync(1000);
		},
		joined: () => onHint !== undefined,
	};
}

/** The Members page of a company following `fake`, on screen and drawn again on every change. */
async function shown(fake: FolderFake) {
	vi.useFakeTimers();
	const { controller } = company();
	const followed = await follow(fake, controller);
	const main = h("main");
	document.body.append(main);
	const draw = () => renderInterface(main, controller, "members");
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { controller, main, ...followed };
}

function rail(controller: CompanyController, f: ReturnType<typeof fixture>) {
	const element = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, element));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = {
		name: "company",
		profileId: controller.profile.profileId,
		section: "interface",
		id: "members",
	};
	renderRail(element, controller, {
		profiles: [controller.profile],
		user: userA,
		route,
		auth,
		invitations: 0,
		openSettings: () => {},
		openFeedback: () => {},
		agentActions: {},
	});
	return element;
}

const names = (controller: CompanyController) => companyInterfaces(controller).map((entry) => entry.name);
const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const read = (fake: FolderFake) => fake.folder.read.mock.calls.map(([path]) => path);
const card = (main: HTMLElement, title: string) =>
	[...main.querySelectorAll<HTMLElement>(".interface-card")].find(
		(candidate) => candidate.querySelector(".interface-card-title")?.textContent === title,
	);
/** The open area's owner, supervisor and agents. */
const fields = (main: HTMLElement) => texts(main, ".interface-detail.is-open .interface-fields dd");
/** The areas' note on the board: its one part since C6d hides the cards, so the note carries no part title. */
const areasNote = (main: HTMLElement) =>
	main.querySelector<HTMLElement>(".interface-board-block .interface-note") ?? undefined;

describe("the pages and the folder (I7, C6a)", () => {
	it("never reads or draws the folder's interfaces/: Pulse, a page an agent wrote, or one named like the two", async () => {
		const fake = seeded();
		fake.put("QorperaOS/interfaces/alpha/interface.toml", page("Alpha"));
		const members = "QorperaOS/interfaces/members/interface.toml";
		fake.put(members, fake.text(members)!.replace('name = "Members"', 'name = "Ours"'));
		const { f, controller } = company();
		await follow(fake, controller);
		expect(read(fake).filter((path) => path.startsWith("QorperaOS/interfaces"))).toEqual([]);
		expect(fake.folder.list).not.toHaveBeenCalled();
		// Mailbox needs mail: only Members is listed, as the web ships it.
		expect(names(controller)).toEqual(["members"]);
		expect(companyInterfaces(controller)[0]?.file.name).toBe("Members");
		expect(texts(rail(controller, f), ".rail-apps-drawer .rail-app-name")).toEqual(["Members"]);
		for (const name of ["pulse", "alpha", "mailbox"]) {
			const main = h("main");
			renderInterface(main, controller, name);
			expect(main.textContent).toContain("This page isn't available here yet.");
			expect(main.querySelector(".interface-block")).toBeNull();
		}
	});

	it("draws the Mailbox the web ships while the company has mail, never one stored under its name", async () => {
		const fake = seeded();
		const mailbox = "QorperaOS/interfaces/mailbox/interface.toml";
		fake.put(mailbox, fake.text(mailbox)!.replace('name = "Mailbox"', 'name = "Written by an agent"'));
		const { f, controller } = company();
		// The company's mail is on: the member mail read lists an address, so the Mailbox's need is met.
		controller.store.set({
			mail: {
				addresses: [{ address: "support@mail.example.test", handledBy: [], routines: [], last7Days: 0 }],
				waiting: [],
				lists: {},
				threads: {},
				answers: {},
			},
		});
		await follow(fake, controller);
		expect(read(fake).filter((path) => path.startsWith("QorperaOS/interfaces"))).toEqual([]);
		expect(fake.folder.list).not.toHaveBeenCalled();
		expect(names(controller)).toEqual(["mailbox", "members"]);
		expect(companyInterfaces(controller).map((entry) => entry.file.name)).toEqual(["Mailbox", "Members"]);
		expect(texts(rail(controller, f), ".rail-apps-drawer .rail-app-name")).toEqual(["Mailbox", "Members"]);
		const main = h("main");
		renderInterface(main, controller, "mailbox");
		expect(main.querySelector<HTMLElement>(".mailbox")?.dataset.interface).toBe("mailbox");
		expect(main.textContent).not.toContain("Written by an agent");
	});

	it("reads nothing while no page is on, what a page reads once it is on, and drops it once it is off", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		const { controller } = company(OFF);
		const { reader } = await follow(fake, controller);
		expect(read(fake)).toEqual([]);
		expect(controller.store.get().interfaceFolder?.tables.size).toBe(0);
		expect(names(controller)).toEqual([]);
		controller.store.set({ interfacePages: ON });
		reader.read(pagesOn(ON));
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() =>
			expect([...(controller.store.get().interfaceFolder?.tables.keys() ?? [])]).toEqual(["areas"]),
		);
		// Members' table and its rules text, not the cards it hides (C6d); Mailbox reads the company's mail, not the
		// folder.
		expect(read(fake).sort()).toEqual([
			"QorperaOS/rules/shared-areas.md",
			"QorperaOS/tables/areas/rows.csv",
			"QorperaOS/tables/areas/table.toml",
		]);
		expect(names(controller)).toEqual(["members"]);
		controller.store.set({ interfacePages: OFF });
		reader.read(pagesOn(OFF));
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(controller.store.get().interfaceFolder?.tables.size).toBe(0));
		expect(names(controller)).toEqual([]);
		// Switching a page off only hides it: nothing in the folder changed.
		expect(fake.commits).toEqual([]);
		expect(fake.text(AREAS)).toBe(areas(SALES));
	});
});

describe("tables from the folder", () => {
	it("reads a table's definition and rows, parses the rows against it, and says which rows don't fit", async () => {
		const fake = seeded();
		fake.put(AREAS, areas(SALES, `Support,,${bea},maybe,,`));
		const { main } = await shown(fake);
		expect(read(fake)).toEqual(expect.arrayContaining(["QorperaOS/tables/areas/table.toml", AREAS]));
		expect(card(main, "Sales")).toBeDefined();
		expect(card(main, "Support")).toBeUndefined();
		const note = areasNote(main);
		expect(note?.querySelector("p")?.textContent).toBe("Some rows can't be shown.");
		expect(texts(note!, "li")).toEqual([expect.stringMatching(/^Line 3: .*shared/)]);
		card(main, "Sales")!.querySelector<HTMLButtonElement>(".interface-card-open")!.click();
		expect(fields(main)).toEqual(["Account A", "Bea", "Ada"]);
	});

	it("shows a table whose rows file can't be read with its problem only", async () => {
		const fake = seeded();
		fake.put(AREAS, "name,amount\nRevenue,1200\n");
		const { main } = await shown(fake);
		expect(areasNote(main)?.querySelector("p")?.textContent).toBe("This table can't be read.");
		expect(main.querySelector(".interface-card")).toBeNull();
	});

	it("reads a file source's text, and never a file whose text is outside content", async () => {
		const fake = seeded();
		fake.put("QorperaOS/rules/shared-areas.md", "Shared areas belong to everyone.");
		const { main } = await shown(fake);
		expect(read(fake)).toContain("QorperaOS/rules/shared-areas.md");
		main.querySelector<HTMLButtonElement>("#interface-view-1")!.click();
		const blocks = main.querySelectorAll(".interface-block");
		expect(blocks).toHaveLength(2);
		expect(blocks[1]?.textContent).toContain("Shared areas belong to everyone.");
		const parsed = parseInterfaceFile(
			page(
				"Alpha",
				`
[[view.block]]
kind = "list"
title = "Today"
from = "file:notes/today.md"
line = "{text}"

[[view.block]]
kind = "list"
title = "Mail"
from = "file:hooks/mail/1.md"
line = "{text}"
`,
			),
		);
		expect(parsed.ok && folderSources(parsed.file).files).toEqual(["notes/today.md"]);
	});

	it("says a table can't be read when its rows failed to download, never that it is empty, until a read lands", async () => {
		const fake = seeded();
		fake.failDownload(AREAS);
		const { main, hint } = await shown(fake);
		expect(areasNote(main)?.querySelector("p")?.textContent).toBe("This table can't be read.");
		expect(areasNote(main)?.querySelector("li")).toBeNull();
		expect(card(main, "Sales")).toBeUndefined();
		// The next sync reads everything again, the rows this time.
		fake.heal(AREAS);
		await hint();
		await vi.waitFor(() => expect(card(main, "Sales")).toBeDefined());
		expect(areasNote(main)).toBeUndefined();
	});

	it("draws the page again when its table recovers with no rows at all", async () => {
		const fake = seeded();
		// Only the first line: a table with no rows, which reads the same as one that can't be read but for that.
		fake.put(AREAS, areas());
		fake.failDownload(AREAS);
		const { main, hint } = await shown(fake);
		expect(areasNote(main)?.querySelector("p")?.textContent).toBe("This table can't be read.");
		fake.heal(AREAS);
		await hint();
		await vi.waitFor(() => expect(areasNote(main)).toBeUndefined());
		expect(main.querySelector(".interface-card")).toBeNull();
	});
});

describe("live", () => {
	it("reads again only the files whose paths changed, and redraws the open page in place", async () => {
		const fake = seeded();
		const { main, hint, joined } = await shown(fake);
		expect(joined()).toBe(true);
		card(main, "Sales")!.querySelector<HTMLButtonElement>(".interface-card-open")!.click();
		expect(fields(main)).toEqual(["Account A", "Bea", "Ada"]);
		const scroller = main.querySelector<HTMLElement>(".interface-page")!;
		scroller.scrollTop = 120;
		fake.folder.read.mockClear();
		fake.folder.readFile.mockClear();
		fake.folder.list.mockClear();
		fake.put(AREAS, areas(`Sales,Deals and leads,${me},no,${me},${ada.id}`));
		// Something else changed too, which no page reads.
		fake.put("notes/elsewhere.md", "Not read.");
		await hint();
		await vi.waitFor(() => expect(fields(main)).toEqual(["Account A", "Account A", "Ada"]));
		expect(read(fake)).toEqual([AREAS]);
		expect(fake.folder.readFile).toHaveBeenCalledTimes(1);
		expect(fake.folder.list).not.toHaveBeenCalled();
		// The page was drawn again, where the member left it: the same area open, the same scroll.
		const again = main.querySelector<HTMLElement>(".interface-page")!;
		expect(again).not.toBe(scroller);
		expect(again.scrollTop).toBe(120);
		expect(card(main, "Sales")?.classList.contains("is-open")).toBe(true);
	});

	it("reads everything again on resync, and when what the member may read changes", async () => {
		const fake = seeded();
		const { main, hint } = await shown(fake);
		fake.folder.read.mockClear();
		fake.put(AREAS, areas(SALES, `Ops,,${bea},no,,`));
		fake.resync();
		await hint();
		await vi.waitFor(() => expect(card(main, "Ops")).toBeDefined());
		expect(read(fake)).toEqual(
			expect.arrayContaining(["QorperaOS/tables/areas/table.toml", "QorperaOS/tables/areas/rows.csv"]),
		);
		fake.folder.read.mockClear();
		fake.authority();
		await hint();
		await vi.waitFor(() => expect(read(fake)).toContain("QorperaOS/tables/areas/rows.csv"));
		expect(read(fake).filter((path) => path.startsWith("QorperaOS/interfaces"))).toEqual([]);
	});
});

describe("a read that fails", () => {
	const rows = (controller: CompanyController) =>
		controller.store
			.get()
			.interfaceFolder?.tables.get("areas")
			?.rows.map((row) => row.area);

	it("publishes nothing when the first read fails, until the poll reads the folder", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		fake.fail("QorperaOS/tables");
		fake.fail("QorperaOS/rules");
		const { controller } = company();
		const { joined } = await follow(fake, controller);
		expect(controller.store.get().interfaceFolder).toBeUndefined();
		expect(joined()).toBe(false);
		// Members is listed by its team: its People view draws from the members themselves.
		expect(names(controller)).toEqual(["members"]);
		// The one-minute poll tries again, and follows the hint once a read lands.
		fake.heal("QorperaOS/tables");
		fake.heal("QorperaOS/rules");
		await vi.advanceTimersByTimeAsync(61_000);
		await vi.waitFor(() => expect(rows(controller)).toEqual(["Sales"]));
		expect(joined()).toBe(true);
	});

	it("keeps what it read through a read that fails later", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		const { controller } = company();
		const { hint } = await follow(fake, controller);
		expect(rows(controller)).toEqual(["Sales"]);
		fake.put(AREAS, areas(SALES, `Ops,,${bea},no,,`));
		fake.fail("QorperaOS/tables");
		// The changed table can't be read, and then neither can anything of it: the page keeps what it read.
		await hint();
		await hint();
		expect(rows(controller)).toEqual(["Sales"]);
		fake.heal("QorperaOS/tables");
		await hint();
		await vi.waitFor(() => expect(rows(controller)).toEqual(["Sales", "Ops"]));
	});
});
