// @vitest-environment jsdom

import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import { interfaceRows } from "../src/app/interfaces.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import type { HostedProfileRole, HostedStaffAgent } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* Interfaces step I9a (RUNTIME-INTERFACES.md §3.2, §3.3, §10): the Members page from the folder. Its board draws the
 * areas and cards in lanes, a card in the open pile is taken and one in the member's own lane released, with a button
 * or a drag, through the member's own folder client (folder-fake.ts); its People view reads the members source with
 * lookups into both tables. */

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const me = userA.id;
const bea = id(42);
const cyd = id(43);
/** A holder who is no longer a member. */
const gone = id(49);
const CALL = id(701);
const SEND = id(702);

const AREAS = "tables/areas/rows.csv";
const CARDS = "tables/cards/rows.csv";
const areaRows = [
	`Sales,Deals and leads,${me},no,${bea},${ada.id}`,
	`Support,,${bea},no,,`,
	// Shared beats its holder.
	`Brand,The look,${bea},yes,,`,
	"Ops,,,no,,",
	`Legal,,${gone},no,,`,
];
const areas = (...rows: string[]) => `area,about,owner,shared,supervisor,agents\n${rows.join("\n")}\n`;
const cards = (call: string, send: string) =>
	`id,card,area,holder,state,added_by,todo\n${CALL},Call the bank,Sales,${call},open,,\n${SEND},Send invoices,Sales,${send},held,,\n`;

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
/** A company of three members. Each test's company is new, so no page state carries over. */
function company(role: HostedProfileRole = "owner") {
	const f = fixture();
	const profile = { ...profileA, profileId: id(300 + ++companies) };
	const controller = new CompanyController(f.api, profile, me);
	const member = (userId: string, displayName: string, as: HostedProfileRole) => ({
		userId,
		email: `${displayName.toLowerCase().replace(/\s/g, "")}@example.invalid`,
		displayName,
		role: as,
		joinedAt: timestamp,
	});
	controller.store.set({
		loading: false,
		staff: [cofounder, ada],
		sessions: [session],
		team: {
			...team,
			profileId: profile.profileId,
			role,
			capabilities: { ...team.capabilities, write: role !== "viewer" },
			members: [member(me, "Account A", role), member(cyd, "Cyd", "contributor"), member(bea, "Bea", "admin")],
		},
	});
	cleanup.push(() => controller.stop());
	return controller;
}

/** A folder seeded as at founding, with areas and cards in the tables. */
function seeded(call = "", send: string = me): FolderFake {
	const fake = folderFake({ seed: [] });
	let next = 500;
	for (const [path, text] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, text);
	fake.put(AREAS, areas(...areaRows));
	fake.put(CARDS, cards(call, send));
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

/** The Members page on screen, drawn again on every change, writing through `fake`. */
async function members(fake: FolderFake, role: HostedProfileRole = "owner") {
	vi.useFakeTimers();
	const controller = company(role);
	const followed = await follow(fake, controller);
	const main = h("main");
	document.body.append(main);
	const draw = () => renderInterface(main, controller, "members", { folder: () => fake.folder, current: () => {} });
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { controller, main, ...followed };
}

const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent);
const lanes = (main: HTMLElement) => texts(main, ".interface-lane h3 span[id]");
const lane = (main: HTMLElement, title: string) =>
	[...main.querySelectorAll<HTMLElement>(".interface-lane")].find(
		(candidate) => candidate.querySelector("h3 span[id]")?.textContent === title,
	)!;
const titles = (main: HTMLElement, title: string) => texts(lane(main, title), ".interface-card-title");
const card = (main: HTMLElement, title: string) =>
	[...main.querySelectorAll<HTMLElement>(".interface-card")].find(
		(candidate) => candidate.querySelector(".interface-card-title")?.textContent === title,
	)!;
const buttonOf = (element: HTMLElement, label: string) =>
	[...element.querySelectorAll<HTMLButtonElement>(".interface-actions button")].find(
		(candidate) => candidate.textContent === label,
	);

/** Drags `from` to `to`'s lane with the mouse, as a member does. */
function drag(from: HTMLElement, to: HTMLElement, during?: () => void) {
	vi.spyOn(to, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 400));
	const pointer = (type: string, x: number, y: number, target: EventTarget = document) =>
		target.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 1,
				pointerType: "mouse",
				button: 0,
				clientX: x,
				clientY: y,
			}),
		);
	pointer("pointerdown", 600, 300, from.querySelector(".interface-card-title")!);
	pointer("pointermove", 500, 300);
	pointer("pointermove", 100, 200);
	during?.();
	pointer("pointerup", 100, 200);
}

/** Holds the next commit until `release` is called. */
function holdCommit(fake: FolderFake) {
	const original = fake.folder.commit.getMockImplementation()!;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	fake.folder.commit.mockImplementationOnce(async (...args) => {
		await held;
		return original(...args);
	});
	return () => release();
}

describe("the Members board (I9a)", () => {
	it("draws both parts in lanes: own first, the others by name, Shared, the open pile, then who left", async () => {
		const { main } = await members(seeded());
		expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile", "Someone who left"]);
		// Each lane's cards part by part, under the part's title.
		expect(titles(main, "You")).toEqual(["Sales", "Send invoices"]);
		expect(texts(lane(main, "You"), ".interface-lane-part")).toEqual(["Areas", "Cards"]);
		expect(titles(main, "Bea")).toEqual(["Support"]);
		expect(titles(main, "Shared")).toEqual(["Brand"]);
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
		expect(titles(main, "Someone who left")).toEqual(["Legal"]);
		// An empty lane keeps its title and says so quietly.
		expect(titles(main, "Cyd")).toEqual([]);
		expect(lane(main, "Cyd").querySelector(".interface-empty")?.textContent).toBe("Nothing here.");
		// A card's line, figures and note; a line or note whose columns are empty is left out.
		const sales = card(main, "Sales");
		expect(sales.querySelector(".interface-card-line")?.textContent).toBe("Deals and leads");
		expect(sales.querySelector(".interface-card-note")?.textContent).toBe("Supervised by Bea");
		expect(sales.querySelectorAll(".interface-card-figures > :not(.visually-hidden)")).toHaveLength(1);
		expect(sales.querySelector(".interface-card-figures .visually-hidden")?.textContent).toBe("Ada");
		const support = card(main, "Support");
		expect(support.querySelector(".interface-card-line, .interface-card-note, .interface-card-figures")).toBeNull();
		expect(card(main, "Call the bank").querySelector(".interface-card-line")?.textContent).toBe("Sales");
	});

	it("opens an area's detail from its card; a card has no detail", async () => {
		const { main } = await members(seeded());
		expect(main.querySelector(".interface-detail")?.textContent).toContain("Choose one to see it here.");
		expect(card(main, "Call the bank").querySelector(".interface-card-open")).toBeNull();
		card(main, "Sales").querySelector<HTMLButtonElement>(".interface-card-open")!.click();
		expect(texts(main, ".interface-detail.is-open .interface-fields dt")).toEqual(["Owner", "Supervisor", "Agents"]);
		expect(texts(main, ".interface-detail.is-open .interface-fields dd")).toEqual(["Account A", "Bea", "Ada"]);
		expect(card(main, "Sales").classList.contains("is-open")).toBe(true);
	});

	it("draws Take in the open pile and Release in the member's own lane, never offer or answer", async () => {
		const { main } = await members(seeded());
		const labels = (title: string) => texts(lane(main, title), ".interface-actions button, .interface-actions a");
		expect(labels("Open pile")).toEqual(["Take", "Take"]);
		expect(labels("You")).toEqual(["Release", "Release"]);
		for (const other of ["Bea", "Cyd", "Shared", "Someone who left"]) expect(labels(other)).toEqual([]);
		expect(main.textContent).not.toContain("Offer");
		expect(main.textContent).not.toContain("Answer");
		// A card someone else holds can't be dragged; one the member can take or release can.
		expect(card(main, "Support").classList.contains("is-draggable")).toBe(false);
		expect(card(main, "Call the bank").classList.contains("is-draggable")).toBe(true);
	});

	it("draws no Take or Release for a member who may not write", async () => {
		const { main } = await members(seeded(), "viewer");
		expect(main.querySelector(".interface-board .interface-actions")).toBeNull();
		expect(main.querySelector(".interface-card.is-draggable")).toBeNull();
	});

	it("takes a card: only its holder cell changes, written with the version it read", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const before = fake.version(CARDS);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		// The card stays where it is, saving, until the save has landed and the board shows it.
		expect(titles(main, "Open pile")).toContain("Call the bank");
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(true);
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		const taken = cards(me, me);
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-take:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: CARDS, text: taken, expectedVersion: before }]);
		expect(fake.text(CARDS)).toBe(taken);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Call the bank", "Send invoices"]));
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
		expect(main.querySelector(".interface-card.is-saving")).toBeNull();
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("releases a card in the member's own lane back to the open pile", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const before = fake.version(CARDS);
		buttonOf(card(main, "Send invoices"), "Release")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		const released = cards("", "");
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-release:/);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: CARDS, text: released, expectedVersion: before }]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank", "Send invoices"]));
		expect(titles(main, "You")).toEqual(["Sales"]);
	});

	it("releases an area the member owns, keeping the rest of the areas file", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		buttonOf(card(main, "Sales"), "Release")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.text(AREAS)).toBe(areas(`Sales,Deals and leads,,no,${bea},${ada.id}`, ...areaRows.slice(1)));
	});

	it("says someone else took it first when the cell was taken meanwhile, and writes nothing", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		// Bea takes the card between the member's read and their save.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(CARDS, cards(bea, me));
			return original(...args);
		});
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice")?.textContent).toBe("Someone else took it first."));
		// The first save named the version it read and was refused; the read after it found the cell taken.
		expect(fake.commits).toHaveLength(1);
		expect(fake.text(CARDS)).toBe(cards(bea, me));
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(false);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Bea")).toEqual(["Support", "Call the bank"]));
	});

	it("says the card changed when a release finds it no longer the member's", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(CARDS, cards("", ""));
			return original(...args);
		});
		buttonOf(card(main, "Send invoices"), "Release")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(1);
	});

	it("says someone else took it first when the file keeps changing", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		for (let attempt = 0; attempt < 4; attempt++) fake.answer("conflict", "version_changed");
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice")?.textContent).toBe("Someone else took it first."));
		expect(fake.commits).toHaveLength(4);
	});

	it("shows a refused save with its problems, and the card where it was", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		fake.answer("refused", "claim", ["holder can only be taken for yourself or let go."]);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice p")?.textContent).toBe("The card could not be taken."));
		expect(texts(main, ".notice .interface-problems li")).toEqual([
			"holder can only be taken for yourself or let go.",
		]);
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(false);
		expect(fake.text(CARDS)).toBe(cards("", me));
	});

	it("takes a card dragged from the open pile to the member's own lane, once the save lands", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const release = holdCommit(fake);
		drag(card(main, "Call the bank"), lane(main, "You"), () => {
			// Only the member's own lane takes the card.
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["You"]);
			expect(lane(main, "You").classList.contains("is-drop-over")).toBe(true);
		});
		expect(main.querySelector(".is-drop-target, .is-drop-over")).toBeNull();
		await vi.waitFor(() => expect(fake.folder.commit).toHaveBeenCalledTimes(1));
		// The save hasn't landed: the card is still in the open pile, saving.
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(true);
		release();
		await vi.waitFor(() => expect(fake.text(CARDS)).toBe(cards(me, me)));
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Call the bank", "Send invoices"]));
		expect(main.querySelector(".interface-card.is-saving")).toBeNull();
	});

	it("releases a card dragged from the member's own lane to the open pile", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		drag(card(main, "Send invoices"), lane(main, "Open pile"), () => {
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["Open pile"]);
		});
		await vi.waitFor(() => expect(fake.text(CARDS)).toBe(cards("", "")));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-release:/);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank", "Send invoices"]));
	});

	it("takes nothing for a drag let go outside the member's lane", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		drag(card(main, "Call the bank"), lane(main, "Bea"));
		await vi.advanceTimersByTimeAsync(100);
		expect(fake.folder.commit).not.toHaveBeenCalled();
	});
});

describe("the Members page's People view (I9a)", () => {
	it("draws the members with their roles and lookups as names or a count; the rules text stays undrawn", async () => {
		const { main } = await members(seeded());
		main.querySelector<HTMLButtonElement>("#interface-view-1")!.click();
		expect(main.querySelectorAll(".interface-block")).toHaveLength(1);
		expect(texts(main, ".interface-table thead th")).toEqual(["Name", "Role", "Owns", "Supervises", "Holds"]);
		const rows = [...main.querySelectorAll(".interface-table tbody tr")].map((row) =>
			[...row.querySelectorAll("td")].map((cell) => cell.textContent),
		);
		expect(rows).toEqual([
			["Account A", "Founder", "Sales", "", "1"],
			["Bea", "Admin", "Support, Brand", "Ada", "0"],
			["Cyd", "Contributor", "", "", "0"],
		]);
		// The lookups sort like the other columns: by the names shown, and by the count.
		main.querySelectorAll<HTMLButtonElement>(".interface-sort")[2]!.click();
		expect(texts(main, ".interface-table tbody tr td:first-child")).toEqual(["Account A", "Bea", "Cyd"]);
		main.querySelectorAll<HTMLButtonElement>(".interface-sort")[4]!.click();
		main.querySelectorAll<HTMLButtonElement>(".interface-sort")[4]!.click();
		expect(texts(main, ".interface-table tbody tr td:first-child")[0]).toBe("Account A");
	});

	it("reads the members source with who is here from presence, the member looking included", () => {
		const controller = company();
		const here = () => interfaceRows(controller, "members")?.map(({ row }) => [row.name, row.here]);
		// Presence not joined: nobody is here.
		expect(here()).toEqual([
			["Account A", false],
			["Bea", false],
			["Cyd", false],
		]);
		controller.store.set({ here: [{ clientId: "b1", userId: bea, name: "Bea", staffAgentId: null }] });
		expect(here()).toEqual([
			["Account A", true],
			["Bea", true],
			["Cyd", false],
		]);
		expect(interfaceRows(controller, "members")?.[1]).toEqual({
			key: `members:${bea}`,
			row: { id: bea, name: "Bea", picture: bea, role: "admin", here: true },
		});
	});
});
