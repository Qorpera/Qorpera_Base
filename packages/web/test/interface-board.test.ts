// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { CARDS_TABLE, interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
import type { TableValue } from "@qorpera/cloud-client/interfaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyInterfaceFolder } from "../src/app/interface-folder.ts";
import { CompanyInterfaceOffers } from "../src/app/interface-offers.ts";
import { interfaceRows, pagesOn } from "../src/app/interfaces.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type {
	InterfaceOfferAnswer,
	InterfaceOfferRequest,
	MemberInterfaceOffer,
	MemberInterfaceOffers,
} from "../src/cloud/interface-offers.ts";
import type {
	InterfaceSupervisionAnswer,
	MemberInterfaceSupervision,
	MemberInterfaceSupervisions,
} from "../src/cloud/interface-supervisions.ts";
import type { HostedProfileRole, HostedStaffAgent } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, session, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

/* Interfaces step I9a (RUNTIME-INTERFACES.md §3.2, §3.3, §10): the Members page from the folder. Its board draws the
 * areas in lanes, an area in the open pile is taken and one in the member's own lane released, with a button or a
 * drag, through the member's own folder client (folder-fake.ts); its People view reads the members source with a
 * lookup into the areas. Step I9c: an area is offered to another member, and an offer is answered on its card. The
 * page is the one the web ships, switched on (Interfaces C6a); the folder's QorperaOS/interfaces/ is never read.
 * Interfaces C6d: the page hides the cards, which an older company's folder still holds; a member adds an area and
 * changes its agents; and a cell that names someone who left stays theirs in the file but counts as empty for the
 * members who stay. */

const cofounder: HostedStaffAgent = { ...staff, id: id(40), displayName: "Co-Founder", templateId: "co-founder" };
const ada: HostedStaffAgent = { ...staff, id: id(41), displayName: "Ada", role: "Bookkeeper" };
const bo: HostedStaffAgent = { ...staff, id: id(44), displayName: "Bo", role: "Writer" };
/** An agent that no longer works here: no area gets it. */
const kit: HostedStaffAgent = { ...staff, id: id(45), displayName: "Kit", employmentStatus: "archived" };
const me = userA.id;
const bea = id(42);
const cyd = id(43);
/** A holder who is no longer a member. */
const gone = id(49);
const CALL = id(701);
const SEND = id(702);

const AREAS = "QorperaOS/tables/areas/rows.csv";
const CARDS = "QorperaOS/tables/cards/rows.csv";
const areaRows = [
	`Sales,Deals and leads,${me},no,${bea},${ada.id}`,
	`Support,,${bea},no,,`,
	// Shared beats its holder.
	`Brand,The look,${bea},yes,,`,
	"Ops,,,no,,",
	`Legal,,${gone},no,,`,
];
const areas = (...rows: string[]) => `area,about,owner,shared,supervisor,agents\n${rows.join("\n")}\n`;
/** The seeded areas with Ops's owner cell set to `owner`. */
const withOps = (owner: string) => areas(...areaRows.slice(0, 3), `Ops,,${owner},no,,`, ...areaRows.slice(4));
/** The cards an older company's folder holds (founding seeded the table until 21 October 2026), which the page no
 * longer draws (Interfaces C6d). */
const cards = `id,card,area,holder,state,added_by,todo\n${CALL},Call the bank,Sales,,open,,\n${SEND},Send invoices,Sales,${me},held,,\n`;

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
/** A company of three members and four agents, one of them archived, its Members page on. Each test's company is new,
 * so no page state carries over. */
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
		staff: [cofounder, ada, kit, bo],
		sessions: [session],
		team: {
			...team,
			profileId: profile.profileId,
			role,
			capabilities: { ...team.capabilities, write: role !== "viewer" },
			members: [member(me, "Account A", role), member(cyd, "Cyd", "contributor"), member(bea, "Bea", "admin")],
		},
		interfacePages: { pages: [{ page: "members", on: true }], mayChange: role === "owner" || role === "admin" },
	});
	cleanup.push(() => controller.stop());
	return controller;
}

/** A folder seeded as at founding, with `rows` in the areas table, and an older company's cards table with cards. */
function seeded(rows: string = areas(...areaRows)): FolderFake {
	const fake = folderFake({ seed: [] });
	let next = 500;
	for (const [path, text] of Object.entries(interfaceLibraryFiles(() => id(++next)))) fake.put(path, text);
	fake.put(AREAS, rows);
	fake.put("QorperaOS/tables/cards/table.toml", CARDS_TABLE);
	fake.put(CARDS, cards);
	return fake;
}

/** Follows `fake` for `controller`'s company's pages, as the app does; `hint` stands in for the folder's hint. */
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
		/** The folder's hint, and the sync it asks for a second later. */
		hint: async () => {
			onHint?.(fake.seq);
			await vi.advanceTimersByTimeAsync(1000);
		},
		/** The read again a page asks for after a change it could not make, as the app wires it. */
		reread: () => reader.sync(),
	};
}

/** The Members page on screen, drawn again on every change, writing through `fake`; with `offers`, its offers and
 * supervision consents are read and made through them as the app does (steps I9c and I9b). */
async function members(fake: FolderFake, role: HostedProfileRole = "owner", offers?: OffersFake) {
	vi.useFakeTimers();
	const controller = company(role);
	const followed = await follow(fake, controller);
	let reader: CompanyInterfaceOffers | undefined;
	if (offers) {
		const opened = new CompanyInterfaceOffers(
			offers.calls,
			offers.consents,
			(state) => controller.store.set({ interfaceOffers: state }),
			controller.signal,
		);
		cleanup.push(() => opened.dispose());
		opened.open();
		await vi.waitFor(() => expect(controller.store.get().interfaceOffers).toBeDefined());
		reader = opened;
	}
	const main = h("main");
	document.body.append(main);
	const writes = {
		folder: () => fake.folder,
		current: () => {},
		reread: followed.reread,
		...(reader ? { offers: reader } : {}),
	};
	const draw = () => renderInterface(main, controller, "members", writes);
	cleanup.push(controller.store.subscribe(draw));
	draw();
	return { controller, main, ...followed };
}

/** The open offers as the platform keeps them (supabase/CLIENT-CONTRACT.md "Offers of a claimed cell"): each one made
 * goes to the top, a decline or withdraw closes it. A save that changes the cell settles it too; here it stays listed
 * unless a test settles it, so the board must hide it by itself. With them the live supervision consents of `fake`'s
 * areas ("Supervision consent"): a consent is made and a withdraw ends it; a save that changes an area's supervisor
 * makes or ends one only where a test does. */
type OffersFake = ReturnType<typeof offersFake>;
function offersFake(fake?: FolderFake) {
	let live: MemberInterfaceSupervision[] = [];
	let consented = 950;
	const supervise = (key: readonly TableValue[], user: string = me) => {
		const supervision: MemberInterfaceSupervision = {
			id: id(++consented),
			table: fake ? areasTable(fake) : "",
			folder: "QorperaOS/tables/areas",
			key,
			user,
			state: "live",
			at: timestamp,
			endedAt: null,
		};
		live = [supervision, ...live];
		return supervision;
	};
	const end = (supervision: string) => {
		live = live.filter((each) => each.id !== supervision);
	};
	let open: MemberInterfaceOffer[] = [];
	let made = 900;
	const add = (
		fields: Pick<MemberInterfaceOffer, "table" | "key" | "from" | "to" | "was"> & { readonly at?: string },
	) => {
		const offer: MemberInterfaceOffer = {
			id: id(++made),
			folder: "QorperaOS/tables/areas",
			column: "owner",
			state: "open",
			agent: null,
			at: timestamp,
			...fields,
		};
		open = [offer, ...open];
		return offer;
	};
	const settle = (offer: string) => {
		open = open.filter((each) => each.id !== offer);
	};
	const close = async (offer: string) => settle(offer);
	return {
		add,
		/** Settles an offer as the save that changes its cell does. */
		settle,
		calls: {
			list: vi.fn(async (): Promise<MemberInterfaceOffers> => ({ offers: open, truncated: false })),
			offer: vi.fn(
				async (request: InterfaceOfferRequest): Promise<InterfaceOfferAnswer> => ({
					ok: true,
					offer: add({ ...request, from: me }),
				}),
			),
			decline: vi.fn(close),
			withdraw: vi.fn(close),
		},
		/** Makes a live consent, as a save that puts a member in an area's supervisor cell does. */
		supervise,
		/** Ends a consent, as a save that changes its cell does. */
		end,
		consents: {
			list: vi.fn(async (): Promise<MemberInterfaceSupervisions> => ({ supervisions: live, truncated: false })),
			consent: vi.fn(
				async (key: readonly TableValue[]): Promise<InterfaceSupervisionAnswer> => ({
					ok: true,
					supervision: supervise(key),
				}),
			),
			withdraw: vi.fn(async (supervision: string) => end(supervision)),
		},
	};
}

/** A table's id in `fake`, as an offer or a consent names it. */
const tableId = (fake: FolderFake, table: string) =>
	/^id = "([0-9a-f-]{36})"$/m.exec(fake.text(`QorperaOS/tables/${table}/table.toml`) ?? "")?.[1] ?? "";
const areasTable = (fake: FolderFake) => tableId(fake, "areas");
/** The words of a card's offer lines. */
const offerWords = (element: HTMLElement) => texts(element, ".interface-card-offer > span:first-child");

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
/** Any button under `root` by its words. */
const buttonNamed = (root: ParentNode, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);

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
	it("draws the areas in lanes: own first, the others by name, Shared, the open pile, then who left", async () => {
		const { main } = await members(seeded());
		expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile", "Someone who left"]);
		// The areas are the board's one part, so no lane titles its part.
		expect(titles(main, "You")).toEqual(["Sales"]);
		expect(main.querySelector(".interface-lane-part")).toBeNull();
		expect(titles(main, "Bea")).toEqual(["Support"]);
		expect(titles(main, "Shared")).toEqual(["Brand"]);
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
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
	});

	it("opens an area's detail from its card", async () => {
		const { main } = await members(seeded());
		expect(main.querySelector(".interface-detail")?.textContent).toContain("Choose one to see it here.");
		card(main, "Sales").querySelector<HTMLButtonElement>(".interface-card-open")!.click();
		expect(texts(main, ".interface-detail.is-open .interface-fields dt")).toEqual(["Owner", "Supervisor", "Agents"]);
		expect(texts(main, ".interface-detail.is-open .interface-fields dd")).toEqual(["Account A", "Bea", "Ada"]);
		expect(card(main, "Sales").classList.contains("is-open")).toBe(true);
	});

	it("draws Take in the open pile and Release in the member's own lane, and no offers without the offers", async () => {
		const { main } = await members(seeded());
		const labels = (title: string) => texts(lane(main, title), ".interface-actions button, .interface-actions a");
		expect(labels("Open pile")).toEqual(["Take"]);
		expect(labels("You")).toEqual(["Release"]);
		// An area whose owner left counts as empty (Interfaces C6d).
		expect(labels("Someone who left")).toEqual(["Take"]);
		for (const other of ["Bea", "Cyd", "Shared"]) expect(labels(other)).toEqual([]);
		expect(main.textContent).not.toContain("Offer");
		expect(main.textContent).not.toContain("Answer");
		// Nor an area's supervision, which is drawn only where its consents are read (step I9b).
		expect(main.querySelector(".interface-supervision")).toBeNull();
		// A card someone else holds can't be dragged; one the member can take or release can.
		expect(card(main, "Support").classList.contains("is-draggable")).toBe(false);
		expect(card(main, "Ops").classList.contains("is-draggable")).toBe(true);
		expect(card(main, "Sales").classList.contains("is-draggable")).toBe(true);
	});

	it("draws Take and Release on a Shared card by its holder, with no drag", async () => {
		const fake = seeded();
		const shared = (brand: string) => areas(`Brand,The look,${brand},yes,,`, "Web,,,yes,,", `Press,,${bea},yes,,`);
		fake.put(AREAS, shared(me));
		const { main, hint } = await members(fake);
		const labels = (title: string) => texts(card(main, title), ".interface-actions button");
		expect(titles(main, "Shared")).toEqual(["Brand", "Web", "Press"]);
		expect(labels("Brand")).toEqual(["Release"]);
		expect(labels("Web")).toEqual(["Take"]);
		expect(labels("Press")).toEqual([]);
		// The card stays in the Shared lane either way, so there is nowhere to drag it.
		expect(lane(main, "Shared").querySelector(".interface-card.is-draggable")).toBeNull();
		const before = fake.version(AREAS);
		buttonOf(card(main, "Brand"), "Release")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: shared(""), expectedVersion: before }]);
		await hint();
		await vi.waitFor(() => expect(labels("Brand")).toEqual(["Take"]));
		expect(titles(main, "Shared")).toEqual(["Brand", "Web", "Press"]);
		expect(main.querySelector(".interface-card.is-saving")).toBeNull();
	});

	it("draws no Take or Release for a member who may not write", async () => {
		const { main } = await members(seeded(), "viewer");
		expect(main.querySelector(".interface-board .interface-actions")).toBeNull();
		expect(main.querySelector(".interface-card.is-draggable")).toBeNull();
	});

	it("takes an area: only its owner cell changes, written with the version it read", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const before = fake.version(AREAS);
		buttonOf(card(main, "Ops"), "Take")!.click();
		// The card stays where it is, saving, until the save has landed and the board shows it.
		expect(titles(main, "Open pile")).toContain("Ops");
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(true);
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		const taken = withOps(me);
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-take:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: taken, expectedVersion: before }]);
		expect(fake.text(AREAS)).toBe(taken);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Ops"]));
		expect(titles(main, "Open pile")).toEqual([]);
		expect(main.querySelector(".interface-card.is-saving")).toBeNull();
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("releases an area in the member's own lane back to the open pile, keeping the rest of the file", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const before = fake.version(AREAS);
		buttonOf(card(main, "Sales"), "Release")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		const released = areas(`Sales,Deals and leads,,no,${bea},${ada.id}`, ...areaRows.slice(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-release:/);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: released, expectedVersion: before }]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Open pile")).toEqual(["Sales", "Ops"]));
		expect(titles(main, "You")).toEqual([]);
	});

	it("says someone else took it first when the cell was taken meanwhile, and writes nothing", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		// Bea takes the area between the member's read and their save.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(AREAS, withOps(bea));
			return original(...args);
		});
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice")?.textContent).toBe("Someone else took it first."));
		// The first save named the version it read and was refused; the read after it found the cell taken.
		expect(fake.commits).toHaveLength(1);
		expect(fake.text(AREAS)).toBe(withOps(bea));
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(false);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Bea")).toEqual(["Support", "Ops"]));
	});

	it("says the area changed when a release finds it no longer the member's", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(AREAS, areas(`Sales,Deals and leads,,no,${bea},${ada.id}`, ...areaRows.slice(1)));
			return original(...args);
		});
		buttonOf(card(main, "Sales"), "Release")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(1);
	});

	it("says the area changed, not who took it, when the file keeps changing while the cell stays free", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		for (let attempt = 0; attempt < 4; attempt++) fake.answer("conflict", "version_changed");
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(4);
	});

	it("changes only the owner field, keeping every other byte of the rows file as written", async () => {
		const fake = seeded();
		// A byte-order mark, CRLF line ends, a blank line, a quoted field, and optional columns left out.
		const bom = String.fromCharCode(0xfeff);
		const written = (owner: string) =>
			`${bom}area,about,owner,shared\r\nOps,,${owner},no\r\n\r\nSales,"Deals, ""big"" ones",${me},no\r\n`;
		fake.put(AREAS, written(""));
		const { main } = await members(fake);
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.text(AREAS)).toBe(written(me));
	});

	it("adds the owner column at the end of a rows file that leaves it out", async () => {
		const fake = seeded();
		fake.put(AREAS, "area,shared\nOps,no\nHR,no\n");
		const { main } = await members(fake);
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.text(AREAS)).toBe(`area,shared,owner\nOps,no,${me}\nHR,no,\n`);
	});

	it("writes nothing while the rows file has a row that doesn't fit, and lists it", async () => {
		const fake = seeded();
		const unfit = `${areas(...areaRows)}Plan,,,maybe,,\n`;
		fake.put(AREAS, unfit);
		const { main } = await members(fake);
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice p")?.textContent).toBe("The card could not be taken."));
		const listed = texts(main, ".notice .interface-problems li");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toContain("doesn't fit");
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(fake.text(AREAS)).toBe(unfit);
	});

	it("draws Take, Release and Add an area only for owners and admins where only they write the rows", async () => {
		const fake = seeded();
		const toml = "QorperaOS/tables/areas/table.toml";
		fake.put(toml, fake.text(toml)!.replace('members = "all"', 'members = "owners"'));
		const contributor = await members(fake, "contributor");
		expect(contributor.main.querySelector(".interface-board .interface-actions")).toBeNull();
		expect(contributor.main.querySelector(".interface-card.is-draggable")).toBeNull();
		expect(buttonNamed(contributor.main, "Add an area")).toBeUndefined();
		document.body.replaceChildren();
		const admin = await members(fake, "admin");
		expect(texts(card(admin.main, "Ops"), ".interface-actions button")).toEqual(["Take"]);
		expect(texts(card(admin.main, "Sales"), ".interface-actions button")).toEqual(["Release"]);
		expect(buttonNamed(admin.main, "Add an area")).toBeDefined();
	});

	it("stops showing a landed card as saving after 10 s when the feed is slow to show it", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(fake.text(AREAS)).toBe(withOps(me)));
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(false);
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Ops"]));
	});

	it("shows a refused save with its problems, and the card where it was", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		fake.answer("refused", "claim", ["owner can only be taken for yourself or let go."]);
		buttonOf(card(main, "Ops"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice p")?.textContent).toBe("The card could not be taken."));
		expect(texts(main, ".notice .interface-problems li")).toEqual([
			"owner can only be taken for yourself or let go.",
		]);
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(false);
		expect(fake.text(AREAS)).toBe(areas(...areaRows));
	});

	it("takes an area dragged from the open pile to the member's own lane, once the save lands", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		const release = holdCommit(fake);
		drag(card(main, "Ops"), lane(main, "You"), () => {
			// Only the member's own lane takes the card.
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["You"]);
			expect(lane(main, "You").classList.contains("is-drop-over")).toBe(true);
		});
		expect(main.querySelector(".is-drop-target, .is-drop-over")).toBeNull();
		await vi.waitFor(() => expect(fake.folder.commit).toHaveBeenCalledTimes(1));
		// The save hasn't landed: the card is still in the open pile, saving.
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
		expect(card(main, "Ops").classList.contains("is-saving")).toBe(true);
		release();
		await vi.waitFor(() => expect(fake.text(AREAS)).toBe(withOps(me)));
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Ops"]));
		expect(main.querySelector(".interface-card.is-saving")).toBeNull();
	});

	it("releases an area dragged from the member's own lane to the open pile", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		drag(card(main, "Sales"), lane(main, "Open pile"), () => {
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["Open pile"]);
		});
		const released = areas(`Sales,Deals and leads,,no,${bea},${ada.id}`, ...areaRows.slice(1));
		await vi.waitFor(() => expect(fake.text(AREAS)).toBe(released));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-release:/);
		await hint();
		await vi.waitFor(() => expect(titles(main, "Open pile")).toEqual(["Sales", "Ops"]));
	});

	it("takes nothing for a drag let go outside the member's lane", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		drag(card(main, "Ops"), lane(main, "Bea"));
		await vi.advanceTimersByTimeAsync(100);
		expect(fake.folder.commit).not.toHaveBeenCalled();
	});

	it("puts a dragged card back on Escape, and takes nothing when it is let go", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		drag(card(main, "Ops"), lane(main, "You"), () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			expect(main.querySelector(".is-drop-target, .is-drop-over, .is-dragging")).toBeNull();
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
	});
});

describe("offers on the Members board (I9c)", () => {
	it("offers an area from its picker, the cell as the card shows it, and draws the offer with Withdraw", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		expect(texts(ops(), ".interface-actions button")).toEqual(["Take", "Offer…"]);
		expect(buttonOf(ops(), "Offer…")?.getAttribute("aria-expanded")).toBe("false");
		buttonOf(ops(), "Offer…")!.click();
		// Every other member who may change the areas, in the company's order; the focus on the first.
		const picker = () => ops().querySelector<HTMLElement>(".interface-offer-picker");
		expect(picker()?.getAttribute("aria-label")).toBe("Offer to");
		expect(texts(picker()!, "button")).toEqual(["Cyd", "Bea", "Cancel"]);
		expect(buttonOf(ops(), "Offer…")?.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement?.textContent).toBe("Cyd");
		buttonOf(picker()!, "Bea")!.click();
		await vi.waitFor(() => expect(offerWords(ops())).toEqual(["Offered to Bea"]));
		expect(offers.calls.offer).toHaveBeenCalledExactlyOnceWith({
			table: areasTable(fake),
			key: ["Ops"],
			column: "owner",
			was: null,
			to: bea,
		});
		expect(picker()).toBeNull();
		expect(texts(ops(), ".interface-actions button")).toEqual(["Withdraw", "Take", "Offer…"]);
		expect(document.activeElement?.textContent).toBe("Withdraw");
		// Bea has it on offer already, so only Cyd is left; Cancel and Escape put the focus back on Offer….
		buttonOf(ops(), "Offer…")!.click();
		expect(texts(picker()!, "button")).toEqual(["Cyd", "Cancel"]);
		buttonOf(picker()!, "Cancel")!.click();
		expect(picker()).toBeNull();
		expect(document.activeElement?.textContent).toBe("Offer…");
		buttonOf(ops(), "Offer…")!.click();
		picker()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(picker()).toBeNull();
		expect(document.activeElement?.textContent).toBe("Offer…");
		// An offer changes nothing in the folder.
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
	});

	it("offers an area the member owns as theirs, keeps it theirs, and withdraws the offer", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		const sales = () => card(main, "Sales");
		buttonOf(sales(), "Offer…")!.click();
		buttonOf(sales(), "Cyd")!.click();
		await vi.waitFor(() => expect(offerWords(sales())).toEqual(["Offered to Cyd"]));
		const [made] = offers.calls.offer.mock.calls[0] ?? [];
		expect(made).toEqual({ table: areasTable(fake), key: ["Sales"], column: "owner", was: me, to: cyd });
		expect(titles(main, "You")).toEqual(["Sales"]);
		const offer = (await offers.calls.list()).offers[0]!;
		buttonOf(sales(), "Withdraw")!.click();
		await vi.waitFor(() => expect(sales().querySelector(".interface-card-offers")).toBeNull());
		expect(offers.calls.withdraw).toHaveBeenCalledExactlyOnceWith(offer.id);
		expect(document.activeElement?.textContent).toBe("Offer…");
		expect(fake.folder.commit).not.toHaveBeenCalled();
	});

	it("shows a refused offer's words, and offers nothing", async () => {
		const fake = seeded();
		const offers = offersFake();
		offers.calls.offer.mockResolvedValueOnce({
			ok: false,
			reason: "write",
			message: "Bea can't change the rows of this table.",
		});
		const { main } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		buttonOf(ops(), "Offer…")!.click();
		// A click in the browser focuses the button; jsdom's doesn't. The picker closes as the offer goes, and the
		// focus stays on the card's Offer…, not on the next card's Take.
		buttonOf(ops(), "Bea")!.focus();
		buttonOf(ops(), "Bea")!.click();
		expect(document.activeElement).toBe(buttonOf(ops(), "Offer…"));
		expect(buttonOf(ops(), "Offer…")?.getAttribute("aria-disabled")).toBe("true");
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("Bea can't change the rows of this table."),
		);
		expect(ops().querySelector(".interface-card-offers")).toBeNull();
		expect(document.activeElement).toBe(buttonOf(ops(), "Offer…"));
		expect(buttonOf(ops(), "Offer…")?.hasAttribute("aria-disabled")).toBe(false);
	});

	it("answers an offer to the member on the card: Accept writes only the owner cell, as the offer read it", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		offers.add({ table: areasTable(fake), key: ["Ops"], from: bea, to: me, was: bea });
		const { main, hint } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		expect(titles(main, "Bea")).toEqual(["Support", "Ops"]);
		expect(offerWords(ops())).toEqual(["Bea offers it to you"]);
		expect(texts(ops(), ".interface-actions button")).toEqual(["Accept", "Not now"]);
		const before = fake.version(AREAS);
		const reads = offers.calls.list.mock.calls.length;
		// A click in the browser focuses the button; jsdom's doesn't.
		buttonOf(ops(), "Accept")!.focus();
		buttonOf(ops(), "Accept")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-accept:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([
			{ op: "write", path: AREAS, text: withOps(me), expectedVersion: before },
		]);
		// The save settles the offer, so the offers are read again.
		await vi.waitFor(() => expect(offers.calls.list.mock.calls.length).toBeGreaterThan(reads));
		expect(document.activeElement).toBe(buttonOf(ops(), "Accept"));
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Ops"]));
		// The fake still lists the offer, but the cell is no longer as it read, so no card draws it.
		expect(main.querySelector(".interface-card-offers")).toBeNull();
		expect(offers.calls.decline).not.toHaveBeenCalled();
		// The area is the member's now and no one supervises its agents, so its card asks (step I9b).
		expect(ops().querySelector(".interface-supervision > span")?.textContent).toBe("Supervise its agents too?");
		// The card's own Release has the focus its answer had.
		expect(document.activeElement).toBe(buttonOf(ops(), "Release"));
		expect(lane(main, "You").contains(document.activeElement)).toBe(true);
	});

	it("keeps an accepted offer on its card, and the focus on Accept, while the card saves, though the save settled it", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		const offer = offers.add({ table: areasTable(fake), key: ["Ops"], from: bea, to: me, was: bea });
		const { main, hint, controller } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		const original = fake.folder.commit.getMockImplementation()!;
		// The platform settles the offer with the save, as it does.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			const saved = await original(...args);
			offers.settle(offer.id);
			return saved;
		});
		buttonOf(ops(), "Accept")!.focus();
		buttonOf(ops(), "Accept")!.click();
		await vi.waitFor(() => expect(controller.store.get().interfaceOffers?.offers).toEqual([]));
		// The offers no longer list it, but the card is still Bea's on screen, saving, with its answer.
		expect(titles(main, "Bea")).toEqual(["Support", "Ops"]);
		expect(ops().querySelector(".interface-card-saving")?.textContent).toBe("Saving…");
		expect(offerWords(ops())).toEqual(["Bea offers it to you"]);
		expect(buttonOf(ops(), "Accept")?.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(buttonOf(ops(), "Accept"));
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Ops"]));
		expect(main.querySelector(".interface-card-offers")).toBeNull();
		expect(document.activeElement).toBe(buttonOf(ops(), "Release"));
	});

	it("declines an offer to the member with Not now, and writes nothing", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		const offer = offers.add({ table: areasTable(fake), key: ["Ops"], from: bea, to: me, was: bea });
		const { main } = await members(fake, "owner", offers);
		buttonOf(card(main, "Ops"), "Not now")!.focus();
		buttonOf(card(main, "Ops"), "Not now")!.click();
		await vi.waitFor(() => expect(card(main, "Ops").querySelector(".interface-card-offers")).toBeNull());
		expect(offers.calls.decline).toHaveBeenCalledExactlyOnceWith(offer.id);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Bea")).toEqual(["Support", "Ops"]);
		// Bea's area has no Take, Release or Offer… for the member, so the focus goes to its own button that opens its
		// detail.
		expect(document.activeElement).toBe(card(main, "Ops").querySelector(".interface-card-open"));
	});

	it("says the card changed when its cell moved after the offer read it, and writes nothing", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		offers.add({ table: areasTable(fake), key: ["Ops"], from: bea, to: me, was: bea });
		const { main } = await members(fake, "owner", offers);
		const original = fake.folder.commit.getMockImplementation()!;
		// Bea gives the area to Cyd between the member's read and their save.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(AREAS, withOps(cyd));
			return original(...args);
		});
		buttonOf(card(main, "Ops"), "Accept")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(1);
		expect(fake.text(AREAS)).toBe(withOps(cyd));
	});

	it("draws the offers between others as a line with no answers", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		offers.add({ table: areasTable(fake), key: ["Ops"], from: bea, to: cyd, was: bea });
		const { main } = await members(fake, "owner", offers);
		expect(offerWords(card(main, "Ops"))).toEqual(["Bea offered it to Cyd"]);
		expect(card(main, "Ops").querySelector(".interface-actions")).toBeNull();
	});

	it("offers an area dragged to another member's lane, and takes nothing", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		drag(card(main, "Ops"), lane(main, "Bea"), () => {
			// The member's own lane takes it; another member's lane offers it to them.
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["You", "Bea", "Cyd"]);
		});
		await vi.waitFor(() => expect(offerWords(card(main, "Ops"))).toEqual(["Offered to Bea"]));
		expect(offers.calls.offer).toHaveBeenCalledExactlyOnceWith({
			table: areasTable(fake),
			key: ["Ops"],
			column: "owner",
			was: null,
			to: bea,
		});
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops"]);
	});

	it("offers only to members who may change the rows, and draws no offers for a viewer", async () => {
		const fake = seeded();
		const toml = "QorperaOS/tables/areas/table.toml";
		fake.put(toml, fake.text(toml)!.replace('members = "all"', 'members = "owners"'));
		const { main } = await members(fake, "owner", offersFake());
		buttonOf(card(main, "Ops"), "Offer…")!.click();
		expect(texts(card(main, "Ops"), ".interface-offer-picker button")).toEqual(["Bea", "Cancel"]);
		document.body.replaceChildren();
		const viewer = await members(seeded(), "viewer", offersFake());
		expect(viewer.main.querySelector(".interface-board .interface-actions")).toBeNull();
	});
});

describe("an area's supervision on the Members board (I9b)", () => {
	/** The words of the supervision lines in `element`, and their buttons. */
	const words = (element: HTMLElement) => texts(element, ".interface-supervision > span:first-child");
	const supervising = (element: HTMLElement) => texts(element, ".interface-supervision button");
	const detail = (main: HTMLElement) => main.querySelector<HTMLElement>(".interface-detail.is-open")!;
	const openArea = (main: HTMLElement, title: string) =>
		card(main, title).querySelector<HTMLButtonElement>(".interface-card-open")!.click();
	/** The seeded folder, with Support's supervisor cell waiting for the member's yes. */
	const waitingForMe = () => {
		const fake = seeded();
		fake.put(AREAS, areas(areaRows[0]!, `Support,,${bea},no,${me},`, ...areaRows.slice(2)));
		return fake;
	};
	/** Makes the member's consent with the next save, as the platform's save that puts them in the cell does. */
	const consentsWithSave = (fake: FolderFake, offers: OffersFake, area: string) => {
		const original = fake.folder.commit.getMockImplementation()!;
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			const saved = await original(...args);
			offers.supervise([area]);
			return saved;
		});
	};

	it("says whose yes an area's supervisor cell waits for, on its card and in its detail, until it is given", async () => {
		const fake = seeded();
		const offers = offersFake(fake);
		const { main } = await members(fake, "owner", offers);
		const waiting = "Waiting for Bea's yes to supervise its agents.";
		expect(words(card(main, "Sales"))).toEqual([waiting]);
		expect(supervising(card(main, "Sales"))).toEqual([]);
		// No other area waits for anyone, and the member took none of them here, so their cards say nothing.
		for (const title of ["Support", "Brand", "Ops", "Legal"])
			expect(card(main, title).querySelector(".interface-supervision")).toBeNull();
		openArea(main, "Sales");
		expect(words(detail(main))).toEqual([waiting]);
		expect(supervising(detail(main))).toEqual([]);
		// Bea says yes; the page reads it when the window comes back into focus.
		offers.supervise(["Sales"], bea);
		window.dispatchEvent(new Event("focus"));
		await vi.waitFor(() => expect(main.querySelector(".interface-supervision")).toBeNull());
		expect(texts(detail(main), ".interface-fields dd")).toEqual(["Account A", "Bea", "Ada"]);
	});

	it("says yes in an area's detail where its supervisor cell waits for the member, pauses it, and steps down", async () => {
		const fake = waitingForMe();
		const offers = offersFake(fake);
		const refused = "Only the member it names as supervisor can consent.";
		offers.consents.consent.mockResolvedValueOnce({ ok: false, reason: "not_yours", message: refused });
		const { main, hint } = await members(fake, "owner", offers);
		const button = (label: string) => buttonOf(detail(main), label)!;
		const waiting = "Waiting for your yes to supervise its agents.";
		// Bea owns the area, so its card has no Take or Release; it asks for the member's yes there too.
		expect(words(card(main, "Support"))).toEqual([waiting]);
		expect(supervising(card(main, "Support"))).toEqual(["Supervise"]);
		openArea(main, "Support");
		expect(words(detail(main))).toEqual([waiting]);
		expect(supervising(detail(main))).toEqual(["Supervise", "Step down"]);
		// A click in the browser focuses the button; jsdom's doesn't. A refused yes says why, and changes nothing.
		button("Supervise").focus();
		button("Supervise").click();
		await vi.waitFor(() => expect(main.querySelector(".notice")?.textContent).toBe(refused));
		expect(supervising(detail(main))).toEqual(["Supervise", "Step down"]);
		button("Supervise").click();
		await vi.waitFor(() => expect(words(detail(main))).toEqual(["You supervise its agents."]));
		expect(offers.consents.consent).toHaveBeenLastCalledWith(["Support"]);
		expect(supervising(detail(main))).toEqual(["Pause", "Step down"]);
		expect(document.activeElement).toBe(button("Pause"));
		expect(card(main, "Support").querySelector(".interface-supervision")).toBeNull();
		expect(main.querySelector(".notice")).toBeNull();
		// Pause ends the yes, and the cell stays as it is.
		const [consent] = (await offers.consents.list()).supervisions;
		button("Pause").click();
		await vi.waitFor(() => expect(words(detail(main))).toEqual([waiting]));
		expect(offers.consents.withdraw).toHaveBeenCalledExactlyOnceWith(consent!.id);
		expect(document.activeElement).toBe(button("Supervise"));
		expect(fake.folder.commit).not.toHaveBeenCalled();
		// Step down lets the cell go, the way Release lets a card go.
		const before = fake.version(AREAS);
		button("Step down").focus();
		button("Step down").click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-release:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([
			{ op: "write", path: AREAS, text: areas(...areaRows), expectedVersion: before },
		]);
		await hint();
		await vi.waitFor(() => expect(words(detail(main))).toEqual(["Nobody supervises its agents."]));
		expect(supervising(detail(main))).toEqual(["Supervise"]);
		expect(document.activeElement).toBe(button("Supervise"));
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("supervises an area no one supervises from its detail: the save puts the member in its supervisor cell", async () => {
		const fake = seeded();
		const offers = offersFake(fake);
		const { main, hint } = await members(fake, "owner", offers);
		const button = (label: string) => buttonOf(detail(main), label)!;
		openArea(main, "Ops");
		expect(words(detail(main))).toEqual(["Nobody supervises its agents."]);
		consentsWithSave(fake, offers, "Ops");
		const before = fake.version(AREAS);
		button("Supervise").focus();
		button("Supervise").click();
		// The consent the save made shows before the folder does.
		await vi.waitFor(() => expect(words(detail(main))).toEqual(["You supervise its agents."]));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-take:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([
			{
				op: "write",
				path: AREAS,
				text: areas(...areaRows.slice(0, 3), `Ops,,,no,${me},`, ...areaRows.slice(4)),
				expectedVersion: before,
			},
		]);
		expect(supervising(detail(main))).toEqual(["Pause", "Step down"]);
		expect(document.activeElement).toBe(button("Pause"));
		await hint();
		await vi.waitFor(() => expect(texts(detail(main), ".interface-fields dd")[1]).toBe("Account A"));
		expect(words(detail(main))).toEqual(["You supervise its agents."]);
		// The member doesn't own the area, so its card asks nothing.
		expect(card(main, "Ops").querySelector(".interface-supervision")).toBeNull();
	});

	it("asks whether the member supervises an area's agents too once the area they took is theirs; Not now lets it be", async () => {
		const fake = seeded();
		const offers = offersFake(fake);
		const { main, hint } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		buttonOf(ops(), "Take")!.focus();
		buttonOf(ops(), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(ops().querySelector(".interface-supervision")).toBeNull();
		await hint();
		await vi.waitFor(() => expect(words(ops())).toEqual(["Supervise its agents too?"]));
		expect(titles(main, "You")).toEqual(["Sales", "Ops"]);
		expect(supervising(ops())).toEqual(["Supervise", "Not now"]);
		expect(document.activeElement).toBe(buttonOf(ops(), "Release"));
		buttonOf(ops(), "Not now")!.focus();
		buttonOf(ops(), "Not now")!.click();
		expect(ops().querySelector(".interface-supervision")).toBeNull();
		// The card's own Release has the focus its answer had.
		expect(document.activeElement).toBe(buttonOf(ops(), "Release"));
		expect(offers.consents.consent).not.toHaveBeenCalled();
		expect(fake.commits).toHaveLength(1);
	});

	it("supervises an area the member took from its card's question, and the question goes", async () => {
		const fake = seeded();
		const offers = offersFake(fake);
		const { main, hint } = await members(fake, "owner", offers);
		const ops = () => card(main, "Ops");
		buttonOf(ops(), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		await hint();
		await vi.waitFor(() => expect(words(ops())).toEqual(["Supervise its agents too?"]));
		consentsWithSave(fake, offers, "Ops");
		const before = fake.version(AREAS);
		buttonOf(ops(), "Supervise")!.focus();
		buttonOf(ops(), "Supervise")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		expect(fake.commits[1]?.units).toEqual([
			{
				op: "write",
				path: AREAS,
				text: areas(...areaRows.slice(0, 3), `Ops,,${me},no,${me},`, ...areaRows.slice(4)),
				expectedVersion: before,
			},
		]);
		await vi.waitFor(() => expect(ops().querySelector(".interface-supervision")).toBeNull());
		expect(document.activeElement).toBe(buttonOf(ops(), "Release"));
		await hint();
		openArea(main, "Ops");
		expect(words(detail(main))).toEqual(["You supervise its agents."]);
		expect(ops().querySelector(".interface-supervision")).toBeNull();
	});

	it("draws the lines with no buttons for a member who may not write, and nothing where the consents aren't read", async () => {
		const fake = waitingForMe();
		const { main } = await members(fake, "viewer", offersFake(fake));
		expect(words(card(main, "Support"))).toEqual(["Waiting for your yes to supervise its agents."]);
		openArea(main, "Support");
		expect(words(detail(main))).toEqual(["Waiting for your yes to supervise its agents."]);
		openArea(main, "Ops");
		expect(words(detail(main))).toEqual(["Nobody supervises its agents."]);
		expect(main.querySelector(".interface-supervision button")).toBeNull();
		document.body.replaceChildren();
		const unread = waitingForMe();
		const offers = offersFake(unread);
		offers.consents.list.mockRejectedValue(
			new CloudRpcError("qorpera_member_interface_supervisions", { message: "not found", code: "PGRST202" }, 404),
		);
		const owner = await members(unread, "owner", offers);
		openArea(owner.main, "Support");
		expect(owner.main.querySelector(".interface-supervision")).toBeNull();
	});
});
describe("offers in what waits for the member (I9c)", () => {
	it("gives an offer's time to the second, though the cloud's carries microseconds", async () => {
		const fake = seeded(withOps(bea));
		const offers = offersFake();
		offers.add({
			table: areasTable(fake),
			key: ["Ops"],
			from: bea,
			to: me,
			was: bea,
			at: "2026-10-07T09:14:49.123456Z",
		});
		const { controller } = await members(fake, "owner", offers);
		const offered = interfaceRows(controller, "waiting")?.filter(({ row }) => row.kind === "offer");
		expect(offered?.map(({ row }) => row.due)).toEqual(["2026-10-07T09:14:49Z"]);
	});
});

describe("the Members page's People view (I9a)", () => {
	it("draws the members with their roles and lookups as names; the rules text stays undrawn", async () => {
		const { main } = await members(seeded());
		main.querySelector<HTMLButtonElement>("#interface-view-1")!.click();
		expect(main.querySelectorAll(".interface-block")).toHaveLength(1);
		// The page hides the cards, so no column looks into them (Interfaces C6d).
		expect(texts(main, ".interface-table thead th")).toEqual(["Name", "Role", "Owns", "Supervises"]);
		const rows = [...main.querySelectorAll(".interface-table tbody tr")].map((row) =>
			[...row.querySelectorAll("td")].map((cell) => cell.textContent),
		);
		expect(rows).toEqual([
			["Account A", "Founder", "Sales", ""],
			["Bea", "Admin", "Support, Brand", "Ada"],
			["Cyd", "Contributor", "", ""],
		]);
		// The lookups sort like the other columns, by the names shown; empty ones come last.
		main.querySelectorAll<HTMLButtonElement>(".interface-sort")[2]!.click();
		expect(texts(main, ".interface-table tbody tr td:first-child")).toEqual(["Account A", "Bea", "Cyd"]);
		main.querySelectorAll<HTMLButtonElement>(".interface-sort")[3]!.click();
		expect(texts(main, ".interface-table tbody tr td:first-child")).toEqual(["Bea", "Account A", "Cyd"]);
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

describe("the Members page after C6d: areas, agents and who left (Interfaces C6d)", () => {
	/** The library's files, as founding writes them. */
	const library = interfaceLibraryFiles(() => id(1));
	/** The areas' rows file as founding writes it: its first line alone. */
	const noAreas = library["QorperaOS/tables/areas/rows.csv"]!;
	/** The seeded areas with Sales's agents cell set to `agents`, and Support's to `support`. */
	const withAgents = (agents: string, support = "") =>
		areas(`Sales,Deals and leads,${me},no,${bea},${agents}`, `Support,,${bea},no,,${support}`, ...areaRows.slice(2));
	const form = (main: HTMLElement) => main.querySelector<HTMLFormElement>("form.interface-area-form");
	const field = (main: HTMLElement, name: "area" | "about") =>
		main.querySelector<HTMLInputElement>(`form.interface-area-form input[data-focus-key$=":${name}"]`)!;
	/** Types `text` into `input`, as a member does. */
	const fill = (input: HTMLInputElement, text: string) => {
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const pressEscape = (element: HTMLElement) =>
		element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	const detail = (main: HTMLElement) => main.querySelector<HTMLElement>(".interface-detail.is-open")!;
	const openArea = (main: HTMLElement, title: string) =>
		card(main, title).querySelector<HTMLButtonElement>(".interface-card-open")!.click();
	/** The buttons under an area's agents in its detail, its picker's included. */
	const agentButtons = (main: HTMLElement) => texts(detail(main), ".interface-area-agents button");
	const picker = (main: HTMLElement) =>
		detail(main).querySelector<HTMLElement>('.interface-area-agents [role="group"][aria-label="Add an agent"]');
	/** A table file without its id line: each write gives the table a new id. */
	const idless = (text: string | undefined) => text?.replace(/^id = "[0-9a-f-]{36}"$/m, "");
	/** The new folder the first commit made, each file's id line left out. */
	const madeFolder = (fake: FolderFake) => {
		const unit = fake.commits[0]?.units[0];
		if (unit?.op !== "new_folder") return undefined;
		return {
			path: unit.path,
			contents: unit.contents.map((item) => (item.kind === "file" ? { ...item, text: idless(item.text) } : item)),
		};
	};
	/** The rows file's version as the next commit leaves it, which the write after it names. */
	const versionAfter = (fake: FolderFake) => {
		const original = fake.folder.commit.getMockImplementation()!;
		let version: string | undefined;
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			const saved = await original(...args);
			version = fake.version(AREAS);
			return saved;
		});
		return () => version;
	};

	it("says there are no areas yet, draws the lanes empty, and has Add an area for who may write", async () => {
		const { main } = await members(seeded(noAreas));
		expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile"]);
		expect(main.querySelector(".interface-card")).toBeNull();
		const adder = main.querySelector<HTMLElement>(".interface-area-add")!;
		expect(adder.querySelector(".interface-empty")?.textContent).toBe("No areas yet.");
		expect(texts(adder, "button")).toEqual(["Add an area"]);
		document.body.replaceChildren();
		const viewer = await members(seeded(noAreas), "viewer");
		expect(texts(viewer.main, ".interface-empty")).toContain("No areas yet.");
		expect(buttonNamed(viewer.main, "Add an area")).toBeUndefined();
	});

	it("adds an area from its form as the member's: a row at the end, written with the version it read", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		buttonNamed(main, "Add an area")!.click();
		expect(form(main)?.getAttribute("aria-label")).toBe("Add an area");
		expect(texts(form(main)!, "label span")).toEqual(["Name", "About"]);
		expect(texts(form(main)!, "button")).toEqual(["Save", "Cancel"]);
		expect(document.activeElement).toBe(field(main, "area"));
		// The form stands where the button was.
		expect(buttonNamed(main, "Add an area")).toBeUndefined();
		fill(field(main, "area"), "Hiring");
		fill(field(main, "about"), "People we need");
		const before = fake.version(AREAS);
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:area-add:[0-9a-f-]{36}$/);
		const added = areas(...areaRows, `Hiring,People we need,${me},no,,`);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: added, expectedVersion: before }]);
		// The form closes once the save lands, the focus back on Add an area.
		await vi.waitFor(() => expect(form(main)).toBeNull());
		expect(document.activeElement).toBe(buttonNamed(main, "Add an area"));
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Hiring"]));
		expect(card(main, "Hiring").querySelector(".interface-card-line")?.textContent).toBe("People we need");
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("says an area needs a name, or that there is one by that name already, and writes nothing", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "  ");
		buttonNamed(form(main)!, "Save")!.click();
		expect(main.querySelector(".notice")?.textContent).toBe("An area needs a name.");
		expect(document.activeElement).toBe(field(main, "area"));
		fill(field(main, "area"), "Sales");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("There is already an area called Sales."),
		);
		// The form stays open with what was typed, so it can be changed.
		expect(field(main, "area").value).toBe("Sales");
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(fake.text(AREAS)).toBe(areas(...areaRows));
	});

	it("closes the area form with Cancel or Escape, the focus back on Add an area, and writes nothing", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Cancel")!.click();
		expect(form(main)).toBeNull();
		expect(document.activeElement).toBe(buttonNamed(main, "Add an area"));
		// What was typed went with the form.
		buttonNamed(main, "Add an area")!.click();
		expect(field(main, "area").value).toBe("");
		pressEscape(field(main, "about"));
		expect(form(main)).toBeNull();
		expect(document.activeElement).toBe(buttonNamed(main, "Add an area"));
		expect(fake.folder.commit).not.toHaveBeenCalled();
	});

	it("draws the board empty with no areas table, and the first area writes the library's table first", async () => {
		const fake = seeded();
		fake.remove("QorperaOS/tables/areas");
		const { main, hint } = await members(fake);
		expect(main.querySelector(".interface-missing")).toBeNull();
		expect(main.textContent).not.toContain("This page isn't available here yet.");
		expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile"]);
		expect(main.querySelector(".interface-area-add .interface-empty")?.textContent).toBe("No areas yet.");
		const made = versionAfter(fake);
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		// One new folder with the table's two files as founding writes them, but for the table's new id.
		expect(fake.commits[0]?.operationKey).toMatch(/^web:areas-table:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toHaveLength(1);
		expect(madeFolder(fake)).toEqual({
			path: "QorperaOS/tables/areas",
			contents: [
				{ path: "table.toml", kind: "file", text: idless(library["QorperaOS/tables/areas/table.toml"]) },
				{ path: "rows.csv", kind: "file", text: noAreas },
			],
		});
		expect(fake.text("QorperaOS/tables/areas/table.toml")).toMatch(/^id = "[0-9a-f-]{36}"$/m);
		// Then the row, written with the version the new rows file has.
		expect(fake.commits[1]?.operationKey).toMatch(/^web:area-add:[0-9a-f-]{36}$/);
		expect(made()).toBeDefined();
		expect(fake.commits[1]?.units).toEqual([
			{ op: "write", path: AREAS, text: areas(`Hiring,,${me},no,,`), expectedVersion: made() },
		]);
		// Nothing else: no rules file, and the cards as they were.
		expect(fake.has("QorperaOS/rules/shared-areas.md")).toBe(false);
		expect(fake.text(CARDS)).toBe(cards);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Hiring"]));
		expect(main.querySelector(".interface-area-add .interface-empty")).toBeNull();
	});

	it("makes QorperaOS/tables/ with the areas table where the folder has no tables, and no cards table", async () => {
		// QorperaOS/ itself is always there: it is seeded and never deleted.
		const fake = folderFake({ seed: ["QorperaOS"] });
		const { main } = await members(fake);
		const made = versionAfter(fake);
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		expect(madeFolder(fake)).toEqual({
			path: "QorperaOS/tables",
			contents: [
				{ path: "areas", kind: "folder" },
				{ path: "areas/table.toml", kind: "file", text: idless(library["QorperaOS/tables/areas/table.toml"]) },
				{ path: "areas/rows.csv", kind: "file", text: noAreas },
			],
		});
		expect(fake.commits[1]?.units).toEqual([
			{ op: "write", path: AREAS, text: areas(`Hiring,,${me},no,,`), expectedVersion: made() },
		]);
		expect(fake.children("QorperaOS/tables")).toEqual(["QorperaOS/tables/areas"]);
		expect(fake.children("QorperaOS/tables/areas")).toEqual([
			"QorperaOS/tables/areas/rows.csv",
			"QorperaOS/tables/areas/table.toml",
		]);
	});

	it("looks again when another member made the areas table meanwhile, and adds the row to theirs", async () => {
		const fake = seeded();
		fake.remove("QorperaOS/tables/areas");
		const { main } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		let theirs: string | undefined;
		// Bea's first area makes the table between the member's look and their write.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put("QorperaOS/tables/areas/table.toml", library["QorperaOS/tables/areas/table.toml"]!);
			theirs = fake.put(AREAS, areas(`Press,,${bea},no,,`));
			return original(...args);
		});
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		// The new folder was answered that it exists; the row is written to Bea's file, with the version it read.
		expect(madeFolder(fake)?.path).toBe("QorperaOS/tables/areas");
		expect(fake.commits[1]?.units).toEqual([
			{
				op: "write",
				path: AREAS,
				text: areas(`Press,,${bea},no,,`, `Hiring,,${me},no,,`),
				expectedVersion: theirs,
			},
		]);
		expect(fake.text("QorperaOS/tables/areas/table.toml")).toBe(library["QorperaOS/tables/areas/table.toml"]);
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("draws an areas table with no rows file yet empty, and the first area writes the file's first line first", async () => {
		const fake = seeded();
		fake.remove(AREAS);
		const table = fake.text("QorperaOS/tables/areas/table.toml");
		const { main, hint } = await members(fake);
		expect(main.querySelector(".interface-missing")).toBeNull();
		expect(main.querySelector(".interface-area-add .interface-empty")?.textContent).toBe("No areas yet.");
		const made = versionAfter(fake);
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		// The rows file alone, made only where there is none, its first line naming the table's columns.
		expect(fake.commits[0]?.operationKey).toMatch(/^web:areas-rows:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: noAreas }]);
		// Then the row, written with the version the new rows file has; the table's definition as it was.
		expect(made()).toBeDefined();
		expect(fake.commits[1]?.units).toEqual([
			{ op: "write", path: AREAS, text: areas(`Hiring,,${me},no,,`), expectedVersion: made() },
		]);
		expect(fake.text("QorperaOS/tables/areas/table.toml")).toBe(table);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Hiring"]));
	});

	it("adds the row to the rows file another member made meanwhile, and makes no second one", async () => {
		const fake = seeded();
		fake.remove(AREAS);
		const { main } = await members(fake);
		const original = fake.folder.commit.getMockImplementation()!;
		let theirs: string | undefined;
		// Bea's first area makes the rows file between the member's look and their write.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			theirs = fake.put(AREAS, areas(`Press,,${bea},no,,`));
			return original(...args);
		});
		buttonNamed(main, "Add an area")!.click();
		fill(field(main, "area"), "Hiring");
		buttonNamed(form(main)!, "Save")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		// The rows file was answered that it exists; the row is written to Bea's, with the version it read.
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: noAreas }]);
		expect(fake.commits[1]?.units).toEqual([
			{
				op: "write",
				path: AREAS,
				text: areas(`Press,,${bea},no,,`, `Hiring,,${me},no,,`),
				expectedVersion: theirs,
			},
		]);
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("draws Remove for each of an area's agents and Add an agent, which lists working agents in no area", async () => {
		const fake = seeded();
		const { main } = await members(fake, "owner", offersFake(fake));
		openArea(main, "Sales");
		expect(texts(detail(main), ".interface-fields dd")).toEqual(["Account A", "Bea", "Ada"]);
		expect(agentButtons(main)).toEqual(["Remove Ada", "Add an agent"]);
		buttonNamed(detail(main), "Add an agent")!.click();
		// Ada is in Sales already and Kit no longer works here; the others by name, the focus on the first.
		expect(texts(picker(main)!, "button")).toEqual(["Bo", "Co-Founder", "Cancel"]);
		expect(document.activeElement?.textContent).toBe("Bo");
		expect(buttonNamed(detail(main), "Add an agent")).toBeUndefined();
		pressEscape(picker(main)!);
		expect(picker(main)).toBeNull();
		expect(document.activeElement?.textContent).toBe("Add an agent");
		buttonNamed(detail(main), "Add an agent")!.click();
		buttonNamed(picker(main)!, "Cancel")!.click();
		expect(picker(main)).toBeNull();
		expect(document.activeElement?.textContent).toBe("Add an agent");
		expect(fake.folder.commit).not.toHaveBeenCalled();
	});

	it("adds the agent chosen and removes one, each writing the area's agents cell as ids split by spaces", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake, "owner", offersFake(fake));
		openArea(main, "Sales");
		const before = fake.version(AREAS);
		buttonNamed(detail(main), "Add an agent")!.click();
		buttonNamed(picker(main)!, "Bo")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:area-agents:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([
			{ op: "write", path: AREAS, text: withAgents(`${ada.id} ${bo.id}`), expectedVersion: before },
		]);
		await hint();
		await vi.waitFor(() => expect(agentButtons(main)).toEqual(["Remove Ada", "Remove Bo", "Add an agent"]));
		const added = fake.version(AREAS);
		buttonNamed(detail(main), "Remove Ada")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(2));
		expect(fake.commits[1]?.units).toEqual([
			{ op: "write", path: AREAS, text: withAgents(bo.id), expectedVersion: added },
		]);
		await hint();
		await vi.waitFor(() => expect(agentButtons(main)).toEqual(["Remove Bo", "Add an agent"]));
		expect(main.querySelector(".notice")).toBeNull();
	});

	it("says every agent is in an area already when none is left to add", async () => {
		const fake = seeded(withAgents(`${ada.id} ${bo.id}`, cofounder.id));
		const { main } = await members(fake, "owner", offersFake(fake));
		openArea(main, "Sales");
		buttonNamed(detail(main), "Add an agent")!.click();
		const label = picker(main)?.querySelector(".interface-offer-picker-label");
		expect(label?.textContent).toBe("Every agent is in an area already.");
		expect(texts(picker(main)!, "button")).toEqual(["Cancel"]);
		expect(document.activeElement?.textContent).toBe("Cancel");
	});

	it("says only the supervisor adds agents while their yes is live, unless the yes is the member's own", async () => {
		const fake = seeded(areas(areaRows[0]!, `Support,,${bea},no,${me},`, ...areaRows.slice(2)));
		const offers = offersFake(fake);
		offers.supervise(["Sales"], bea);
		offers.supervise(["Support"]);
		const { main } = await members(fake, "owner", offers);
		openArea(main, "Sales");
		const only = "Only Bea, who supervises its agents, adds agents.";
		expect(texts(detail(main), ".interface-area-agents p")).toEqual([only]);
		// Taking an agent out is still the member's to do.
		expect(agentButtons(main)).toEqual(["Remove Ada"]);
		openArea(main, "Support");
		expect(detail(main).querySelector(".interface-area-agents p")).toBeNull();
		expect(agentButtons(main)).toEqual(["Add an agent"]);
	});

	it("draws an area's agents with no buttons, and no Add an area, for a member who may not write", async () => {
		const fake = seeded();
		const { main } = await members(fake, "viewer", offersFake(fake));
		openArea(main, "Sales");
		expect(texts(detail(main), ".interface-fields dd")).toEqual(["Account A", "Bea", "Ada"]);
		expect(detail(main).querySelector(".interface-area-agents")).toBeNull();
		expect(buttonNamed(main, "Add an area")).toBeUndefined();
	});

	it("says an agent is in another area when it was put there meanwhile, writes nothing, and reads again", async () => {
		const fake = seeded();
		const { main } = await members(fake, "owner", offersFake(fake));
		openArea(main, "Sales");
		buttonNamed(detail(main), "Add an agent")!.click();
		// Bea puts the Co-Founder in Support after the page drew the choices.
		fake.put(AREAS, withAgents(ada.id, cofounder.id));
		buttonNamed(picker(main)!, "Co-Founder")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("Co-Founder is already in another area."),
		);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		// The folder is read again a second later, so the choices are the ones there are now.
		await vi.advanceTimersByTimeAsync(1000);
		buttonNamed(detail(main), "Add an agent")!.click();
		await vi.waitFor(() => expect(texts(picker(main)!, "button")).toEqual(["Bo", "Cancel"]));
	});

	it("says only the supervisor adds agents now when the save is refused for that, and lists no problems", async () => {
		const fake = seeded();
		const offers = offersFake(fake);
		const { main } = await members(fake, "owner", offers);
		openArea(main, "Sales");
		const original = fake.folder.commit.getMockImplementation()!;
		// Bea says yes to supervise its agents between the member's read and their save, so the save is refused.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			offers.supervise(["Sales"], bea);
			return original(...args);
		});
		fake.answer("refused", "invalid", ["only the area's supervisor adds its agents; offer the agent to them"]);
		buttonNamed(detail(main), "Add an agent")!.click();
		buttonNamed(picker(main)!, "Bo")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("Only the area's supervisor adds its agents now."),
		);
		expect(main.querySelector(".notice .interface-problems")).toBeNull();
		expect(fake.commits).toHaveLength(1);
		expect(fake.text(AREAS)).toBe(areas(...areaRows));
		// The consents are read again, so the detail says who adds its agents now.
		const only = "Only Bea, who supervises its agents, adds agents.";
		await vi.waitFor(() => expect(texts(detail(main), ".interface-area-agents p")).toEqual([only]));
		expect(agentButtons(main)).toEqual(["Remove Ada"]);
	});

	it("says an area's agents changed after the page drew them, writes nothing, and reads them again", async () => {
		const fake = seeded();
		const { main } = await members(fake, "owner", offersFake(fake));
		openArea(main, "Sales");
		// Bea adds Bo to Sales after the page drew its agents.
		fake.put(AREAS, withAgents(`${ada.id} ${bo.id}`));
		buttonNamed(detail(main), "Remove Ada")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(agentButtons(main)).toEqual(["Remove Ada", "Remove Bo", "Add an agent"]));
	});

	it("takes an area whose owner left as an empty one: the save puts the member in its owner cell", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		expect(titles(main, "Someone who left")).toEqual(["Legal"]);
		const before = fake.version(AREAS);
		buttonOf(card(main, "Legal"), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-take:[0-9a-f-]{36}$/);
		const taken = areas(...areaRows.slice(0, 4), `Legal,,${me},no,,`);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: taken, expectedVersion: before }]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Legal"]));
		expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile"]);
	});

	it("offers an area whose owner left with its cell as it reads, and takes nothing", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		const legal = () => card(main, "Legal");
		expect(texts(legal(), ".interface-actions button")).toEqual(["Take", "Offer…"]);
		buttonOf(legal(), "Offer…")!.click();
		buttonOf(legal(), "Bea")!.click();
		await vi.waitFor(() => expect(offerWords(legal())).toEqual(["Offered to Bea"]));
		expect(offers.calls.offer).toHaveBeenCalledExactlyOnceWith({
			table: areasTable(fake),
			key: ["Legal"],
			column: "owner",
			was: gone,
			to: bea,
		});
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Someone who left")).toEqual(["Legal"]);
	});

	it("accepts a member's offer of an area whose owner left: the save puts the member in its owner cell", async () => {
		const fake = seeded();
		const offers = offersFake();
		offers.add({ table: areasTable(fake), key: ["Legal"], from: bea, to: me, was: gone });
		const { main, hint } = await members(fake, "owner", offers);
		const legal = () => card(main, "Legal");
		expect(offerWords(legal())).toEqual(["Bea offers it to you"]);
		const before = fake.version(AREAS);
		buttonOf(legal(), "Accept")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-accept:[0-9a-f-]{36}$/);
		const taken = areas(...areaRows.slice(0, 4), `Legal,,${me},no,,`);
		expect(fake.commits[0]?.units).toEqual([{ op: "write", path: AREAS, text: taken, expectedVersion: before }]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Legal"]));
	});

	it("draws no offer made by someone who left, so the member takes or offers the area as an empty one", async () => {
		const fake = seeded();
		const offers = offersFake();
		offers.add({ table: areasTable(fake), key: ["Legal"], from: gone, to: me, was: gone });
		const { main, controller } = await members(fake, "owner", offers);
		expect(card(main, "Legal").querySelector(".interface-card-offers")).toBeNull();
		expect(texts(card(main, "Legal"), ".interface-actions button")).toEqual(["Take", "Offer…"]);
		// Nor does it wait for the member.
		expect(interfaceRows(controller, "waiting")?.filter(({ row }) => row.kind === "offer")).toEqual([]);
	});

	it("names someone who left by the name presence still knows, in their lane and as their area's owner", async () => {
		const { main, controller } = await members(seeded());
		openArea(main, "Legal");
		expect(texts(detail(main), ".interface-fields dd")).toEqual(["Someone who left", "", ""]);
		controller.store.set({ here: [{ clientId: "g1", userId: gone, name: "Gus", staffAgentId: null }] });
		await vi.waitFor(() => expect(lanes(main)).toEqual(["You", "Bea", "Cyd", "Shared", "Open pile", "Gus (left)"]));
		expect(titles(main, "Gus (left)")).toEqual(["Legal"]);
		expect(texts(detail(main), ".interface-fields dd")).toEqual(["Gus (left)", "", ""]);
	});
});

describe("the cards the Members page hides, which founding no longer seeds (Interfaces C6d)", () => {
	it("draws no cards on the board and no lookup of them in the People view, though the folder has them", async () => {
		const fake = seeded();
		expect(fake.text(CARDS)).toBe(cards);
		const { main } = await members(fake);
		expect(texts(main, ".interface-card-title")).toEqual(["Sales", "Support", "Brand", "Ops", "Legal"]);
		expect(main.querySelector(".interface-lane-part")).toBeNull();
		expect(main.textContent).not.toContain("Call the bank");
		expect(main.textContent).not.toContain("Send invoices");
		main.querySelector<HTMLButtonElement>("#interface-view-1")!.click();
		expect(texts(main, ".interface-table thead th")).toEqual(["Name", "Role", "Owns", "Supervises"]);
	});

	it("seeds no cards table, though the library's members interface still names it, and keeps its bytes", () => {
		let n = 0;
		const files = interfaceLibraryFiles(() => id(++n));
		expect(files["QorperaOS/tables/cards/table.toml"]).toBeUndefined();
		expect(files["QorperaOS/tables/cards/rows.csv"]).toBeUndefined();
		expect(files["QorperaOS/interfaces/members/interface.toml"]).toContain('from = "table:cards"');
		// The hash pins the library's bytes as master has them (C6d changes none; founding stopped seeding Pulse, numbers
		// and cards on 21 October 2026, and the same day moved them under QorperaOS/).
		const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
		expect(createHash("sha256").update(JSON.stringify(entries)).digest("hex")).toBe(
			"46f43d8eb010867c4dc41c05c1f4b708a387de54bae526b22df8eb55787eaa8e",
		);
	});
});
