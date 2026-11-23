// @vitest-environment jsdom

import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import { type InterfaceFile, parseInterfaceFile } from "@qorpera/cloud-client/interfaces";
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
		{ page: "bank", on: true },
	],
	mayChange: true,
};
const OFF: InterfacePagesState = {
	pages: [
		{ page: "mailbox", on: false },
		{ page: "bank", on: false },
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

// WHY: No page the web ships reads a folder table any more; the library's Members definition still does.
function areasPage(): InterfaceFile {
	const text = interfaceLibraryFiles(() => id(700))["QorperaOS/interfaces/members/interface.toml"]!;
	const parsed = parseInterfaceFile(text);
	if (!parsed.ok) throw new Error("The library's Members definition does not parse");
	return parsed.file;
}

/** Follows `fake` for the pages `controller`'s company has on, as the app does; `hint` stands in for the folder's
 * hint. */
async function follow(fake: FolderFake, controller: CompanyController, definitions?: InterfaceFile[]) {
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
	reader.read(definitions ?? pagesOn(controller.store.get().interfacePages));
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

function rail(controller: CompanyController, f: ReturnType<typeof fixture>) {
	const element = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, element));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = {
		name: "company",
		profileId: controller.profile.profileId,
		section: "interface",
		id: "bank",
	};
	renderRail(element, controller, {
		profiles: [controller.profile],
		user: userA,
		route,
		auth,
		invitations: 0,
		openSettings: () => {},
		openFeedback: () => {},
		openFriends: () => {},
		agentActions: {},
	});
	return element;
}

const names = (controller: CompanyController) => companyInterfaces(controller).map((entry) => entry.name);
const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const read = (fake: FolderFake) => fake.folder.read.mock.calls.map(([path]) => path);

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
		expect(names(controller)).toEqual(["bank"]);
		expect(companyInterfaces(controller)[0]?.file.name).toBe("Bank");
		expect(texts(rail(controller, f), ".rail-apps-drawer [data-app-key] .rail-app-name")).toEqual(["Bank"]);
		for (const name of ["pulse", "alpha", "mailbox", "members"]) {
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
		expect(names(controller)).toEqual(["mailbox", "bank"]);
		expect(companyInterfaces(controller).map((entry) => entry.file.name)).toEqual(["Mailbox", "Bank"]);
		expect(texts(rail(controller, f), ".rail-apps-drawer [data-app-key] .rail-app-name")).toEqual([
			"Mailbox",
			"Bank",
		]);
		const main = h("main");
		renderInterface(main, controller, "mailbox");
		expect(main.querySelector<HTMLElement>(".mailbox")?.dataset.interface).toBe("mailbox");
		expect(main.textContent).not.toContain("Written by an agent");
	});

	it("reads nothing while no page is on, what a page reads once it is on, and drops it once it is off", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		fake.put("bank/summary.json", "{}");
		fake.put("finance/bank-setup.json", "{}");
		const { controller } = company(OFF);
		const { reader } = await follow(fake, controller);
		expect(read(fake)).toEqual([]);
		expect(controller.store.get().interfaceFolder?.files.size).toBe(0);
		expect(names(controller)).toEqual([]);
		controller.store.set({ interfacePages: ON });
		reader.read(pagesOn(ON));
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(controller.store.get().interfaceFolder?.files.size).toBe(2));
		expect(read(fake).sort()).toEqual(["bank/summary.json", "finance/bank-setup.json"]);
		expect(names(controller)).toEqual(["bank"]);
		controller.store.set({ interfacePages: OFF });
		reader.read(pagesOn(OFF));
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(controller.store.get().interfaceFolder?.files.size).toBe(0));
		expect(names(controller)).toEqual([]);
		// Switching a page off only hides it: nothing in the folder changed.
		expect(fake.commits).toEqual([]);
		expect(fake.text(AREAS)).toBe(areas(SALES));
	});
});

describe("files and tables from the folder", () => {
	const supervisors = (controller: CompanyController) =>
		controller.store
			.get()
			.interfaceFolder?.tables.get("areas")
			?.rows.map((row) => row.supervisor);

	it("reads a file source's text, and never a file whose text is outside content", async () => {
		const fake = seeded();
		fake.put("QorperaOS/rules/shared-areas.md", "Shared areas belong to everyone.");
		const { controller } = company();
		await follow(fake, controller, [areasPage()]);
		expect(read(fake)).toContain("QorperaOS/rules/shared-areas.md");
		expect(controller.store.get().interfaceFolder?.files.get("QorperaOS/rules/shared-areas.md")).toBe(
			"Shared areas belong to everyone.",
		);
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

	it("reads again only the files whose paths changed", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		const { controller } = company();
		const { hint, joined } = await follow(fake, controller, [areasPage()]);
		expect(joined()).toBe(true);
		expect(supervisors(controller)).toEqual([bea]);
		fake.folder.read.mockClear();
		fake.folder.readFile.mockClear();
		fake.folder.list.mockClear();
		fake.put(AREAS, areas(`Sales,Deals and leads,${me},no,${me},${ada.id}`));
		fake.put("notes/elsewhere.md", "Not read.");
		await hint();
		await vi.waitFor(() => expect(supervisors(controller)).toEqual([me]));
		expect(read(fake)).toEqual([AREAS]);
		expect(fake.folder.readFile).toHaveBeenCalledTimes(1);
		expect(fake.folder.list).not.toHaveBeenCalled();
	});

	it("reads everything again on resync, and when what the member may read changes", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		const { controller } = company();
		const { hint } = await follow(fake, controller, [areasPage()]);
		fake.folder.read.mockClear();
		fake.put(AREAS, areas(SALES, `Ops,,${bea},no,,`));
		fake.resync();
		await hint();
		await vi.waitFor(() => expect(supervisors(controller)).toHaveLength(2));
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
		const { joined } = await follow(fake, controller, [areasPage()]);
		expect(controller.store.get().interfaceFolder).toBeUndefined();
		expect(joined()).toBe(false);
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
		const { hint } = await follow(fake, controller, [areasPage()]);
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

	it("skips 60s folder polls while hidden and syncs on tab return", async () => {
		vi.useFakeTimers();
		const fake = seeded();
		const { controller } = company();
		await follow(fake, controller, [areasPage()]);
		const readCallsBefore = fake.folder.read.mock.calls.length + fake.folder.changes.mock.calls.length;
		const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		fake.put(AREAS, areas(SALES, `Ops,,${bea},no,,`));
		await vi.advanceTimersByTimeAsync(180_000);
		expect(fake.folder.read.mock.calls.length + fake.folder.changes.mock.calls.length).toBe(readCallsBefore);
		expect(rows(controller)).toEqual(["Sales"]);

		hiddenSpy.mockReturnValue(false);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(1_100);
		await vi.waitFor(() => expect(rows(controller)).toEqual(["Sales", "Ops"]));
	});
});
