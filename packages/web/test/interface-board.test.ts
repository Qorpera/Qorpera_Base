// @vitest-environment jsdom

import { interfaceLibraryFiles } from "@qorpera/cloud-client/interface-library";
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
 * areas and cards in lanes, a card in the open pile is taken and one in the member's own lane released, with a button
 * or a drag, through the member's own folder client (folder-fake.ts); its People view reads the members source with
 * lookups into both tables. Step I9c: a card is offered to another member, and an offer is answered on the card. The
 * page is the one the web ships, switched on (Interfaces C6a); the folder's interfaces/ is never read. */

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
/** A company of three members, its Members page on. Each test's company is new, so no page state carries over. */
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
		interfacePages: { pages: [{ page: "members", on: true }], mayChange: role === "owner" || role === "admin" },
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
	const writes = { folder: () => fake.folder, current: () => {}, ...(reader ? { offers: reader } : {}) };
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
			folder: "tables/areas",
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
			folder: "tables/cards",
			column: "holder",
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
	/^id = "([0-9a-f-]{36})"$/m.exec(fake.text(`tables/${table}/table.toml`) ?? "")?.[1] ?? "";
const cardsTable = (fake: FolderFake) => tableId(fake, "cards");
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

	it("draws Take in the open pile and Release in the member's own lane, and no offers without the offers", async () => {
		const { main } = await members(seeded());
		const labels = (title: string) => texts(lane(main, title), ".interface-actions button, .interface-actions a");
		expect(labels("Open pile")).toEqual(["Take", "Take"]);
		expect(labels("You")).toEqual(["Release", "Release"]);
		for (const other of ["Bea", "Cyd", "Shared", "Someone who left"]) expect(labels(other)).toEqual([]);
		expect(main.textContent).not.toContain("Offer");
		expect(main.textContent).not.toContain("Answer");
		// Nor an area's supervision, which is drawn only where its consents are read (step I9b).
		expect(main.querySelector(".interface-supervision")).toBeNull();
		// A card someone else holds can't be dragged; one the member can take or release can.
		expect(card(main, "Support").classList.contains("is-draggable")).toBe(false);
		expect(card(main, "Call the bank").classList.contains("is-draggable")).toBe(true);
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

	it("says the card changed, not who took it, when the file keeps changing while the cell stays free", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		for (let attempt = 0; attempt < 4; attempt++) fake.answer("conflict", "version_changed");
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(4);
	});

	it("changes only the holder field, keeping every other byte of the rows file as written", async () => {
		const fake = seeded();
		// A byte-order mark, CRLF line ends, a blank line, a quoted field, and optional columns left out.
		const written = (call: string) =>
			`\ufeffid,card,area,holder,state\r\n${CALL},Call the bank,Sales,${call},open\r\n\r\n${SEND},"Send ""all"" invoices",Sales,${me},held\r\n`;
		fake.put(CARDS, written(""));
		const { main } = await members(fake);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.text(CARDS)).toBe(written(me));
	});

	it("adds the holder column at the end of a rows file that leaves it out", async () => {
		const fake = seeded();
		fake.put(CARDS, `id,card,state\n${CALL},Call the bank,open\n${SEND},Send invoices,held\n`);
		const { main } = await members(fake);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.text(CARDS)).toBe(
			`id,card,state,holder\n${CALL},Call the bank,open,${me}\n${SEND},Send invoices,held,\n`,
		);
	});

	it("writes nothing while the rows file has a row that doesn't fit, and lists it", async () => {
		const fake = seeded();
		const unfit = `${cards("", me)}${id(703)},Plan the week,Sales,,maybe,,\n`;
		fake.put(CARDS, unfit);
		const { main } = await members(fake);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(main.querySelector(".notice p")?.textContent).toBe("The card could not be taken."));
		const listed = texts(main, ".notice .interface-problems li");
		expect(listed).toHaveLength(1);
		expect(listed[0]).toContain("doesn't fit");
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(fake.text(CARDS)).toBe(unfit);
	});

	it("draws Take and Release only for owners and admins where only they write the rows", async () => {
		const fake = seeded();
		const toml = "tables/cards/table.toml";
		fake.put(toml, fake.text(toml)!.replace('members = "all"', 'members = "owners"'));
		const { main } = await members(fake, "contributor");
		const labels = (title: string) => texts(card(main, title), ".interface-actions button");
		// Every member writes areas; only owners and admins write cards.
		expect(labels("Ops")).toEqual(["Take"]);
		expect(labels("Sales")).toEqual(["Release"]);
		expect(labels("Call the bank")).toEqual([]);
		expect(labels("Send invoices")).toEqual([]);
		expect(card(main, "Call the bank").classList.contains("is-draggable")).toBe(false);
	});

	it("stops showing a landed card as saving after 10 s when the feed is slow to show it", async () => {
		const fake = seeded();
		const { main, hint } = await members(fake);
		buttonOf(card(main, "Call the bank"), "Take")!.click();
		await vi.waitFor(() => expect(fake.text(CARDS)).toBe(cards(me, me)));
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(card(main, "Call the bank").classList.contains("is-saving")).toBe(false);
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Call the bank", "Send invoices"]));
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

	it("puts a dragged card back on Escape, and takes nothing when it is let go", async () => {
		const fake = seeded();
		const { main } = await members(fake);
		drag(card(main, "Call the bank"), lane(main, "You"), () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			expect(main.querySelector(".is-drop-target, .is-drop-over, .is-dragging")).toBeNull();
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
	});
});

describe("offers on the Members board (I9c)", () => {
	it("offers a card from its picker, the cell as the card shows it, and draws the offer with Withdraw", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		const call = () => card(main, "Call the bank");
		expect(texts(call(), ".interface-actions button")).toEqual(["Take", "Offer…"]);
		expect(buttonOf(call(), "Offer…")?.getAttribute("aria-expanded")).toBe("false");
		buttonOf(call(), "Offer…")!.click();
		// Every other member who may change the cards, in the company's order; the focus on the first.
		const picker = () => call().querySelector<HTMLElement>(".interface-offer-picker");
		expect(picker()?.getAttribute("aria-label")).toBe("Offer to");
		expect(texts(picker()!, "button")).toEqual(["Cyd", "Bea", "Cancel"]);
		expect(buttonOf(call(), "Offer…")?.getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement?.textContent).toBe("Cyd");
		buttonOf(picker()!, "Bea")!.click();
		await vi.waitFor(() => expect(offerWords(call())).toEqual(["Offered to Bea"]));
		expect(offers.calls.offer).toHaveBeenCalledExactlyOnceWith({
			table: cardsTable(fake),
			key: [CALL],
			column: "holder",
			was: null,
			to: bea,
		});
		expect(picker()).toBeNull();
		expect(texts(call(), ".interface-actions button")).toEqual(["Withdraw", "Take", "Offer…"]);
		expect(document.activeElement?.textContent).toBe("Withdraw");
		// Bea has it on offer already, so only Cyd is left; Cancel and Escape put the focus back on Offer….
		buttonOf(call(), "Offer…")!.click();
		expect(texts(picker()!, "button")).toEqual(["Cyd", "Cancel"]);
		buttonOf(picker()!, "Cancel")!.click();
		expect(picker()).toBeNull();
		expect(document.activeElement?.textContent).toBe("Offer…");
		buttonOf(call(), "Offer…")!.click();
		picker()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(picker()).toBeNull();
		expect(document.activeElement?.textContent).toBe("Offer…");
		// An offer changes nothing in the folder.
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
	});

	it("offers a card the member holds as theirs, keeps it theirs, and withdraws the offer", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		const send = () => card(main, "Send invoices");
		buttonOf(send(), "Offer…")!.click();
		buttonOf(send(), "Cyd")!.click();
		await vi.waitFor(() => expect(offerWords(send())).toEqual(["Offered to Cyd"]));
		const [made] = offers.calls.offer.mock.calls[0] ?? [];
		expect(made).toEqual({ table: cardsTable(fake), key: [SEND], column: "holder", was: me, to: cyd });
		expect(titles(main, "You")).toEqual(["Sales", "Send invoices"]);
		const offer = (await offers.calls.list()).offers[0]!;
		buttonOf(send(), "Withdraw")!.click();
		await vi.waitFor(() => expect(send().querySelector(".interface-card-offers")).toBeNull());
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
		const call = () => card(main, "Call the bank");
		buttonOf(call(), "Offer…")!.click();
		// A click in the browser focuses the button; jsdom's doesn't. The picker closes as the offer goes, and the
		// focus stays on the card's Offer…, not on the next card's Take.
		buttonOf(call(), "Bea")!.focus();
		buttonOf(call(), "Bea")!.click();
		expect(document.activeElement).toBe(buttonOf(call(), "Offer…"));
		expect(buttonOf(call(), "Offer…")?.getAttribute("aria-disabled")).toBe("true");
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("Bea can't change the rows of this table."),
		);
		expect(call().querySelector(".interface-card-offers")).toBeNull();
		expect(document.activeElement).toBe(buttonOf(call(), "Offer…"));
		expect(buttonOf(call(), "Offer…")?.hasAttribute("aria-disabled")).toBe(false);
	});

	it("answers an offer to the member on the card: Accept writes only the holder cell, as the offer read it", async () => {
		const fake = seeded(bea);
		const offers = offersFake();
		offers.add({ table: cardsTable(fake), key: [CALL], from: bea, to: me, was: bea });
		const { main, hint } = await members(fake, "owner", offers);
		const call = () => card(main, "Call the bank");
		expect(titles(main, "Bea")).toEqual(["Support", "Call the bank"]);
		expect(offerWords(call())).toEqual(["Bea offers it to you"]);
		expect(texts(call(), ".interface-actions button")).toEqual(["Accept", "Not now"]);
		const before = fake.version(CARDS);
		const reads = offers.calls.list.mock.calls.length;
		// A click in the browser focuses the button; jsdom's doesn't.
		buttonOf(call(), "Accept")!.focus();
		buttonOf(call(), "Accept")!.click();
		await vi.waitFor(() => expect(fake.commits).toHaveLength(1));
		expect(fake.commits[0]?.operationKey).toMatch(/^web:board-accept:[0-9a-f-]{36}$/);
		expect(fake.commits[0]?.units).toEqual([
			{ op: "write", path: CARDS, text: cards(me, me), expectedVersion: before },
		]);
		// The save settles the offer, so the offers are read again.
		await vi.waitFor(() => expect(offers.calls.list.mock.calls.length).toBeGreaterThan(reads));
		expect(document.activeElement).toBe(buttonOf(call(), "Accept"));
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Call the bank", "Send invoices"]));
		// The fake still lists the offer, but the cell is no longer as it read, so no card draws it.
		expect(main.querySelector(".interface-card-offers")).toBeNull();
		expect(offers.calls.decline).not.toHaveBeenCalled();
		// The card's own Release has the focus its answer had.
		expect(document.activeElement).toBe(buttonOf(call(), "Release"));
		expect(lane(main, "You").contains(document.activeElement)).toBe(true);
	});

	it("keeps an accepted offer on its card, and the focus on Accept, while the card saves, though the save settled it", async () => {
		const fake = seeded(bea);
		const offers = offersFake();
		const offer = offers.add({ table: cardsTable(fake), key: [CALL], from: bea, to: me, was: bea });
		const { main, hint, controller } = await members(fake, "owner", offers);
		const call = () => card(main, "Call the bank");
		const original = fake.folder.commit.getMockImplementation()!;
		// The platform settles the offer with the save, as it does.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			const saved = await original(...args);
			offers.settle(offer.id);
			return saved;
		});
		buttonOf(call(), "Accept")!.focus();
		buttonOf(call(), "Accept")!.click();
		await vi.waitFor(() => expect(controller.store.get().interfaceOffers?.offers).toEqual([]));
		// The offers no longer list it, but the card is still Bea's on screen, saving, with its answer.
		expect(titles(main, "Bea")).toEqual(["Support", "Call the bank"]);
		expect(call().querySelector(".interface-card-saving")?.textContent).toBe("Saving…");
		expect(offerWords(call())).toEqual(["Bea offers it to you"]);
		expect(buttonOf(call(), "Accept")?.getAttribute("aria-disabled")).toBe("true");
		expect(document.activeElement).toBe(buttonOf(call(), "Accept"));
		await hint();
		await vi.waitFor(() => expect(titles(main, "You")).toEqual(["Sales", "Call the bank", "Send invoices"]));
		expect(main.querySelector(".interface-card-offers")).toBeNull();
		expect(document.activeElement).toBe(buttonOf(call(), "Release"));
	});

	it("declines an offer to the member with Not now, and writes nothing", async () => {
		const fake = seeded(bea);
		const offers = offersFake();
		const offer = offers.add({ table: cardsTable(fake), key: [CALL], from: bea, to: me, was: bea });
		const { main } = await members(fake, "owner", offers);
		buttonOf(card(main, "Call the bank"), "Not now")!.focus();
		buttonOf(card(main, "Call the bank"), "Not now")!.click();
		await vi.waitFor(() => expect(card(main, "Call the bank").querySelector(".interface-card-offers")).toBeNull());
		expect(offers.calls.decline).toHaveBeenCalledExactlyOnceWith(offer.id);
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Bea")).toEqual(["Support", "Call the bank"]);
		// Bea's card has no control of its own left (a card opens no detail), so the focus goes on to the next control on
		// the board: the Shared area's, which opens its detail.
		expect(document.activeElement).toBe(card(main, "Brand").querySelector(".interface-card-open"));
	});

	it("says the card changed when its cell moved after the offer read it, and writes nothing", async () => {
		const fake = seeded(bea);
		const offers = offersFake();
		offers.add({ table: cardsTable(fake), key: [CALL], from: bea, to: me, was: bea });
		const { main } = await members(fake, "owner", offers);
		const original = fake.folder.commit.getMockImplementation()!;
		// Bea gives the card to Cyd between the member's read and their save.
		fake.folder.commit.mockImplementationOnce(async (...args) => {
			fake.put(CARDS, cards(cyd, me));
			return original(...args);
		});
		buttonOf(card(main, "Call the bank"), "Accept")!.click();
		await vi.waitFor(() =>
			expect(main.querySelector(".notice")?.textContent).toBe("That changed while you were looking."),
		);
		expect(fake.commits).toHaveLength(1);
		expect(fake.text(CARDS)).toBe(cards(cyd, me));
	});

	it("draws the offers between others as a line with no answers", async () => {
		const fake = seeded(bea);
		const offers = offersFake();
		offers.add({ table: cardsTable(fake), key: [CALL], from: bea, to: cyd, was: bea });
		const { main } = await members(fake, "owner", offers);
		expect(offerWords(card(main, "Call the bank"))).toEqual(["Bea offered it to Cyd"]);
		expect(card(main, "Call the bank").querySelector(".interface-actions")).toBeNull();
	});

	it("offers a card dragged to another member's lane, and takes nothing", async () => {
		const fake = seeded();
		const offers = offersFake();
		const { main } = await members(fake, "owner", offers);
		drag(card(main, "Call the bank"), lane(main, "Bea"), () => {
			// The member's own lane takes it; another member's lane offers it to them.
			expect(texts(main, ".interface-lane.is-drop-target h3 span[id]")).toEqual(["You", "Bea", "Cyd"]);
		});
		await vi.waitFor(() => expect(offerWords(card(main, "Call the bank"))).toEqual(["Offered to Bea"]));
		expect(offers.calls.offer).toHaveBeenCalledExactlyOnceWith({
			table: cardsTable(fake),
			key: [CALL],
			column: "holder",
			was: null,
			to: bea,
		});
		expect(fake.folder.commit).not.toHaveBeenCalled();
		expect(titles(main, "Open pile")).toEqual(["Ops", "Call the bank"]);
	});

	it("offers only to members who may change the rows, and draws no offers for a viewer", async () => {
		const fake = seeded();
		const toml = "tables/cards/table.toml";
		fake.put(toml, fake.text(toml)!.replace('members = "all"', 'members = "owners"'));
		const { main } = await members(fake, "owner", offersFake());
		buttonOf(card(main, "Call the bank"), "Offer…")!.click();
		expect(texts(card(main, "Call the bank"), ".interface-offer-picker button")).toEqual(["Bea", "Cancel"]);
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
		expect(titles(main, "You")).toEqual(["Sales", "Ops", "Send invoices"]);
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
		const fake = seeded(bea);
		const offers = offersFake();
		offers.add({
			table: cardsTable(fake),
			key: [CALL],
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
