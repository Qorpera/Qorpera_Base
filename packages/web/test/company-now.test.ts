// @vitest-environment jsdom

import {
	READING_SHAPES,
	type ReadingFile,
	type ReadingThing,
	writeReadingFile,
} from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import {
	CANVAS,
	COLUMN_BELOW,
	figureSpots,
	layoutReading,
	type ReadingSpot,
	SLOTS,
	slotOrder,
} from "../src/app/reading-layout.ts";
import { type CompanyNowHost, CompanyNowView, type NowFolder } from "../src/app/views/company-now.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { type CompanyStanding, parseCompanyStanding, RUNNING } from "../src/cloud/company-standing.ts";
import type { HostedProfileMember, HostedStaffAgent } from "../src/cloud/types.ts";
import { presentationLocale } from "../src/ui/preferences.ts";
import { THING_SHAPES, thingShape } from "../src/ui/thing-shapes.ts";
import { fixture, id, profileA, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* The company's page, `#/c/{id}/now` (app/views/company-now.ts; Jonas, 14 Nov 2026: "It should feel like the company is
 * conscious almost"): the company's reading of itself (QorperaOS/vision/reading.md) as a picture of shapes that fill,
 * the agents at them, what waits for the member, what changed, and the company standing still. */

const agent = (n: number, name: string, extra: Partial<HostedStaffAgent> = {}): HostedStaffAgent => ({
	...staff,
	id: id(n),
	displayName: name,
	createdAt: `2026-09-05T10:00:${String(n).padStart(2, "0")}Z`,
	...extra,
});
const cofounder = agent(40, "Co-Founder", { templateId: "co-founder" });
const research = agent(41, "Customer research");
const market = agent(42, "Market");
const product = agent(43, "Product");
const engineering = agent(44, "Engineering");
const brand = agent(45, "Brand");
const strategy = agent(46, "Strategy");
const sales = agent(47, "Sales");
const crew = [cofounder, research, market, product, engineering, brand, strategy];
const handles: [string, HostedStaffAgent][] = [
	["co-founder", cofounder],
	["customer-research", research],
	["market", market],
	["product", product],
	["engineering", engineering],
	["brand", brand],
	["strategy", strategy],
	["sales", sales],
];
const member = (userId: string, name: string): HostedProfileMember => ({
	userId,
	email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.invalid`,
	displayName: name,
	role: "owner",
	joinedAt: timestamp,
});
const jonas = member(userA.id, "Jonas Krüger");
const sofie = member(id(60), "Sofie Lund");

const thing = (
	key: string,
	name: string,
	shape: ReadingThing["shape"],
	full: number,
	state: string,
	agents: string[],
	waitsFor: string[] = [],
): ReadingThing => ({ key, name, shape, full, state, agents, waitsFor });

/** The sketch's Pedalværk, "now". */
const now: Omit<ReadingFile, "kind"> = {
	sentence: "We know what a workshop needs and have a repair tracker on paper. Nothing is built yet.",
	line: "Most of us are on the tracker. One thing waits for you.",
	attention: "tracker",
	things: [
		thing("needs", "What workshops need", "factory", 62, "One workshop known", ["customer-research"]),
		thing("market", "The market", "pin", 55, "Aarhus compared", ["market"]),
		thing("tracker", "The repair tracker", "board", 34, "On paper", ["product", "engineering"]),
		thing("customers", "Customers", "person", 0, "Nobody yet", []),
		thing("money", "Money", "coin", 14, "Waits for you", ["strategy"], ["founders"]),
		thing("look", "The look", "drop", 30, "Being made", ["brand"]),
	],
	changes: [],
	notes: [],
};
/** The sketch's "later": Sales joined, the market's watch ended, customers the attention now. */
const later: Omit<ReadingFile, "kind"> = {
	sentence: "A second workshop wants the tracker. Selling now takes more of us than finding out.",
	line: "So the team changed today.",
	attention: "customers",
	things: [
		thing("needs", "What workshops need", "factory", 85, "Known", []),
		thing("market", "The market", "pin", 60, "Watch ended", ["market"]),
		thing("tracker", "The repair tracker", "board", 70, "In use at one workshop", ["product", "engineering"]),
		thing("customers", "Customers", "person", 24, "Two workshops", ["customer-research", "sales"]),
		thing("money", "Money", "coin", 40, "First invoice sent", ["strategy"]),
		thing("look", "The look", "drop", 85, "Set", ["brand"]),
	],
	changes: [
		{ agent: "sales", what: "joined", line: "Sales joined" },
		{ agent: "market", what: "changed", line: "Market's daily watch ended" },
	],
	notes: [],
};

/** A member folder that holds the reading (or none), and the agents' folders. */
function fakeFolder(text: string | null, agents: [string, HostedStaffAgent][] = handles) {
	const state = { text, version: "v1", agents };
	const encoded = () => new TextEncoder().encode(state.text ?? "");
	const folder = {
		read: vi.fn(async (path: string) => ({
			asOfSeq: 1,
			entry:
				state.text === null
					? null
					: {
							path,
							kind: "file",
							version: state.version,
							seq: 1,
							updatedAt: timestamp,
							file: { bytes: encoded().byteLength },
							target: null,
						},
		})),
		readFile: vi.fn(async () => encoded()),
		stateFolders: vi.fn(async () => ({
			agents: state.agents.map(([handle, entry]) => ({
				staffAgentId: entry.id,
				file: `QorperaOS/agents/${handle}/agent.md`,
			})),
			groups: [],
			routines: null,
		})),
	};
	return { folder, state };
}

const cleanup: (() => void)[] = [];
beforeEach(() => stubFigureMotion());
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function page(
	text: string | null,
	extra: {
		staff?: HostedStaffAgent[];
		members?: HostedProfileMember[];
		standing?: () => Promise<CompanyStanding>;
		agents?: [string, HostedStaffAgent][];
	} = {},
) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: extra.staff ?? [...crew, sales],
		team: { ...team, members: extra.members ?? [jonas, sofie] },
	});
	cleanup.push(() => controller.stop());
	const { folder, state } = fakeFolder(text, extra.agents);
	const listeners = new Set<() => void>();
	const host = {
		folder: () => folder as unknown as NowFolder,
		onFolderChange: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		standing: vi.fn(extra.standing ?? (async () => RUNNING)),
		openSettings: vi.fn(),
		ask: vi.fn(async () => {}),
		draft: vi.fn(async () => {}),
	} satisfies CompanyNowHost;
	const view = new CompanyNowView(controller, host);
	document.body.append(view.el);
	cleanup.push(() => view.dispose());
	/** The company's agents' folder changed: the page reads its reading again. */
	const change = async (next: string | null, version: string) => {
		state.text = next;
		state.version = version;
		for (const listener of [...listeners]) listener();
		await settle();
	};
	return { view, host, folder, controller, change, el: view.el };
}

const title = (el: HTMLElement) => el.querySelector(".now-title")?.textContent;
const line = (el: HTMLElement) => {
	const element = el.querySelector<HTMLElement>(".now-line")!;
	return element.hidden ? null : element.textContent;
};
const things = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".now-thing")];
const thingEl = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`.now-thing[data-thing="${key}"]`)!;
const figure = (el: HTMLElement, who: HostedStaffAgent) =>
	el.querySelector<HTMLAnchorElement>(`.now-figure[data-agent="${who.id}"]`);
const figureNames = (el: HTMLElement) =>
	[...el.querySelectorAll<HTMLElement>(".now-figure[data-agent]")].map((entry) => entry.getAttribute("aria-label"));
const settingsButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(".now-settings")!;

describe("the things' shapes", () => {
	it("draws every shape of the platform's set, and the blob for a name it does not have", () => {
		for (const name of READING_SHAPES) {
			expect(THING_SHAPES[name], name).toMatch(/^M[\d.,\-MLHVCAZmlhvcaz ]+$/);
			expect(thingShape(name)).toBe(THING_SHAPES[name]);
		}
		expect(Object.keys(THING_SHAPES).sort()).toEqual([...READING_SHAPES].sort());
		expect(thingShape("spaceship")).toBe(THING_SHAPES.blob);
	});
});

describe("where the things stand (app/reading-layout.ts)", () => {
	const overlap = (a: ReadingSpot["box"], b: ReadingSpot["box"]) =>
		a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
	const items = (count: number) =>
		Array.from({ length: count }, (_, index) => ({ key: `t${index}`, agents: index % 3 }));

	it.each([3, 4, 5, 6, 7])(
		"keeps %i things clear of each other and inside the picture at 720, 1052 and 1400 px",
		(count) => {
			for (const screen of [720, 1052, 1400])
				for (const height of [925 - 180 - 130, 700 - 180 - 130, 1200 - 180 - 130]) {
					// The pane at the Big scale, its title and its foot taken off.
					const layout = layoutReading(items(count), "t2", { width: screen / 1.3, height: height / 1.3 }, screen);
					expect(layout.column, `${count} at ${screen}`).toBe(false);
					expect(layout.width).toBeLessThanOrEqual(screen / 1.3 + 0.001);
					expect(layout.height).toBeLessThanOrEqual(Math.max(height / 1.3, CANVAS.height * 0.2) + 0.001);
					const spots = layout.spots;
					expect(spots).toHaveLength(count);
					for (const spot of spots) {
						expect(spot.box.left, `${spot.key} at ${screen}`).toBeGreaterThanOrEqual(0);
						expect(spot.box.top).toBeGreaterThanOrEqual(0);
						expect(spot.box.right).toBeLessThanOrEqual(layout.width + 0.001);
						expect(spot.box.bottom).toBeLessThanOrEqual(layout.height + 0.001);
					}
					for (const [index, a] of spots.entries())
						for (const b of spots.slice(index + 1))
							expect(overlap(a.box, b.box), `${count}: ${a.key} and ${b.key} at ${screen}`).toBe(false);
				}
		},
	);

	it("puts the attended thing in the middle and biggest, the rest by how many agents attend to them", () => {
		for (const count of [3, 4, 5, 6, 7]) {
			const slots = SLOTS[count]!;
			expect(slots).toHaveLength(count);
			const [first, ...rest] = slots;
			expect(first![0]).toBe(CANVAS.width / 2);
			for (const slot of rest) expect(slot[2]).toBeLessThan(first![2]);
			for (const [index, slot] of rest.entries())
				if (index) expect(slot[2]).toBeLessThanOrEqual(rest[index - 1]![2]);
		}
		const order = slotOrder(
			[
				{ key: "a", agents: 0 },
				{ key: "b", agents: 2 },
				{ key: "c", agents: 1 },
				{ key: "d", agents: 2 },
			],
			"c",
		);
		expect(order.map((entry) => entry.key)).toEqual(["c", "b", "d", "a"]);
		// The canvas is never drawn larger than the sketch, and smaller to fit.
		const wide = layoutReading(items(6), "t0", { width: 2400, height: 1600 }, 3120);
		expect(wide.unit).toBeCloseTo(1 / 1.3);
		const narrow = layoutReading(items(6), "t0", { width: 600, height: 1000 }, 780);
		expect(narrow.unit).toBeCloseTo(600 / CANVAS.width);
	});

	it("stacks the things in one column under 720 px, the attended one first", () => {
		const layout = layoutReading(items(5), "t3", { width: 700 / 1.3, height: 400 }, COLUMN_BELOW - 1);
		expect(layout.column).toBe(true);
		expect(layout.spots.map((spot) => spot.key)[0]).toBe("t3");
		for (const [index, spot] of layout.spots.entries()) {
			if (index) expect(spot.box.top).toBeGreaterThanOrEqual(layout.spots[index - 1]!.box.bottom);
			expect(spot.box.left).toBeGreaterThanOrEqual(0);
			expect(spot.box.right).toBeLessThanOrEqual(layout.width + 0.001);
		}
		expect(layout.height).toBeGreaterThanOrEqual(layout.spots.at(-1)!.box.bottom);
	});

	it("keeps a thing's figures inside its footprint, however many", () => {
		const layout = layoutReading(items(7), "t0", { width: 1052 / 1.3, height: 620 / 1.3 }, 1052);
		for (const spot of layout.spots)
			for (let count = 1; count <= 12; count++) {
				const spots = figureSpots(spot, layout.unit, count, Math.min(4, count));
				expect(spots).toHaveLength(count);
				for (const at of spots) {
					expect(at.left).toBeGreaterThanOrEqual(spot.box.left - 0.001);
					expect(at.left + at.size).toBeLessThanOrEqual(spot.box.right + 0.001);
					expect(at.top).toBeGreaterThanOrEqual(spot.box.top - 0.001);
				}
				// Right, then left, then outward.
				if (count >= 2) {
					expect(spots[0]!.left).toBeGreaterThan(spot.x);
					expect(spots[1]!.left + spots[1]!.size).toBeLessThan(spot.x);
				}
				if (count >= 3) expect(spots[2]!.left).toBeGreaterThan(spots[0]!.left);
			}
	});
});

describe("the company's standing", () => {
	it("reads the member read's answer, and refuses another shape", () => {
		expect(
			parseCompanyStanding({
				schema: "qorpera.company-standing/v1",
				stopped: true,
				since: "2026-11-14T07:00:00+00:00",
				why: "login_full",
				member: userA.id,
				resetsAt: "2026-11-20T05:55:00+00:00",
				waiting: 3,
			}),
		).toEqual({
			stopped: true,
			since: "2026-11-14T07:00:00+00:00",
			why: "login_full",
			member: userA.id,
			resetsAt: "2026-11-20T05:55:00+00:00",
			waiting: 3,
		});
		expect(
			parseCompanyStanding({
				schema: "qorpera.company-standing/v1",
				stopped: false,
				since: null,
				why: null,
				member: null,
				resetsAt: null,
				waiting: 0,
			}),
		).toEqual(RUNNING);
		expect(() => parseCompanyStanding({ schema: "qorpera.company-standing/v1", stopped: "yes" })).toThrow();
		expect(() =>
			parseCompanyStanding({ schema: "qorpera.company-standing/v1", stopped: true, why: "tired", waiting: 0 }),
		).toThrow();
	});
});

describe("the company's page (app/views/company-now.ts)", () => {
	it("before the first reading: the company's figures in a row, the Co-Founder first, one line and no shapes", async () => {
		const { el, folder } = page(null, { staff: [research, cofounder, market] });
		await settle();
		expect(el.querySelector("h1.visually-hidden")?.textContent).toBe(profileA.profileName);
		expect(title(el)).toBe("We are finding our feet. The first reading comes with the next plan.");
		expect(line(el)).toBeNull();
		expect(things(el)).toEqual([]);
		expect(figureNames(el)).toEqual(["Co-Founder", "Customer research", "Market"]);
		expect(el.querySelector(".now-canvas")?.classList.contains("is-row")).toBe(true);
		expect(folder.readFile).not.toHaveBeenCalled();
		expect(el.querySelector<HTMLElement>(".now-changes")!.hidden).toBe(true);
	});

	it("draws the reading: the sentence and its line, each thing as its shape filled as far as it is", async () => {
		const { el } = page(writeReadingFile(now));
		await settle();
		expect(title(el)).toBe(now.sentence);
		expect(line(el)).toBe(now.line);
		expect(things(el).map((entry) => entry.dataset.thing)).toEqual([
			"needs",
			"market",
			"tracker",
			"customers",
			"money",
			"look",
		]);
		const tracker = thingEl(el, "tracker");
		expect(tracker.classList.contains("is-attended")).toBe(true);
		expect(tracker.querySelector(".now-thing-name")?.textContent).toBe("The repair tracker");
		expect(tracker.querySelector(".now-thing-state")?.textContent).toBe("On paper");
		expect(tracker.querySelector(".now-shape")?.getAttribute("aria-label")).toBe("The repair tracker: On paper");
		expect(tracker.querySelector<HTMLElement>(".now-fill")!.style.height).toBe("34%");
		expect(tracker.querySelector(".now-solid path")?.getAttribute("d")).toBe(THING_SHAPES.board);
		// Empty: a dashed outline and no fill.
		expect(thingEl(el, "customers").classList.contains("is-empty")).toBe(true);
		expect(thingEl(el, "needs").classList.contains("is-empty")).toBe(false);
		// The attended thing is the biggest.
		const size = (key: string) =>
			Number.parseFloat(
				thingEl(el, key)
					.querySelector<HTMLElement>(".now-shape")!
					.style.width.match(/calc\(([\d.]+)/)![1]!,
			);
		for (const key of ["needs", "market", "customers", "money", "look"])
			expect(size(key)).toBeLessThan(size("tracker"));
		// The agents at their things, by name; a click goes to the agent's thread.
		expect(figureNames(el).sort()).toEqual(
			["Customer research", "Market", "Product", "Engineering", "Strategy", "Brand"].sort(),
		);
		const productFigure = figure(el, product)!;
		expect(productFigure.title).toBe("Product");
		expect(productFigure.dataset.href).toBe(`#/c/${profileA.profileId}/staff/${product.id}`);
		expect(productFigure.querySelector(".figure")).not.toBeNull();
		// Sales was not in the reading: it is not drawn.
		expect(figure(el, sales)).toBeNull();
		expect(el.querySelector(".now-composer, .now-ask textarea")?.getAttribute("placeholder")).toBe(
			`Ask ${profileA.profileName}…`,
		);
	});

	it("draws a working agent as the rail does, with its dot", async () => {
		const { el, controller, view } = page(writeReadingFile(now));
		vi.spyOn(controller, "agentState").mockImplementation((agentId) => (agentId === product.id ? "working" : "idle"));
		await settle();
		view.update();
		const working = figure(el, product)!;
		expect(working.querySelector(".now-figure-status")).not.toBeNull();
		expect(figure(el, brand)!.querySelector(".now-figure-status")).toBeNull();
	});

	it("moves the same shapes and figures when the reading changes, and brings in who joined", async () => {
		const { el, change, view } = page(writeReadingFile(now));
		await settle();
		const tracker = thingEl(el, "tracker");
		const research0 = figure(el, research)!;
		const left = research0.style.left;
		const trackerTop = tracker.style.top;
		await change(writeReadingFile(later), "v2");
		view.update();
		expect(title(el)).toBe(later.sentence);
		// The same elements, in new places.
		expect(thingEl(el, "tracker")).toBe(tracker);
		expect(tracker.style.top).not.toBe(trackerTop);
		expect(figure(el, research)).toBe(research0);
		expect(research0.style.left).not.toBe(left);
		expect(thingEl(el, "customers").classList.contains("is-attended")).toBe(true);
		expect(thingEl(el, "tracker").classList.contains("is-attended")).toBe(false);
		expect(figure(el, sales)).not.toBeNull();
	});

	it("puts the member's face at a thing that waits for them or the founders, and another member's for their id", async () => {
		const reading = {
			...now,
			things: now.things.map((entry) =>
				entry.key === "look" ? { ...entry, waitsFor: [sofie.userId, id(99)] } : entry,
			),
		};
		const { el } = page(writeReadingFile(reading));
		await settle();
		const faces = [...el.querySelectorAll<HTMLElement>(".now-face")];
		expect(faces.map((face) => [face.dataset.member, face.title])).toEqual([
			[userA.id, "Jonas Krüger"],
			[sofie.userId, "Sofie Lund"],
		]);
		expect(faces[0]!.querySelector(".person-avatar")).not.toBeNull();
	});

	it("draws no agent whose role ended, nor one the file names that the company does not have", async () => {
		const reading = {
			...now,
			things: now.things.map((entry) =>
				entry.key === "market" ? { ...entry, agents: ["market", "ghost"] } : entry,
			),
		};
		const ended = { ...market, employmentStatus: "archived" as const };
		const { el } = page(writeReadingFile(reading), {
			staff: [cofounder, research, ended, product, engineering, brand, strategy],
			agents: handles.filter(([handle]) => handle !== "market"),
		});
		await settle();
		expect(figure(el, market)).toBeNull();
		expect(figureNames(el)).not.toContain("Market");
		expect(thingEl(el, "market")).not.toBeNull();
	});

	it("says what changed in one quiet line, and Not right? opens the Co-Founder's thread with a draft", async () => {
		const { el, host } = page(writeReadingFile(later));
		await settle();
		const changes = el.querySelector<HTMLElement>(".now-changes")!;
		expect(changes.hidden).toBe(false);
		expect([...changes.querySelectorAll(".now-change")].map((entry) => entry.textContent)).toEqual([
			"Sales joined",
			"Market's daily watch ended",
		]);
		expect(changes.querySelectorAll(".now-change .figure")).toHaveLength(2);
		const pill = changes.querySelector<HTMLButtonElement>(".now-pill")!;
		expect(pill.textContent).toBe("Not right?");
		pill.click();
		await settle();
		expect(host.draft).toHaveBeenCalledWith("Not right: Sales joined; Market's daily watch ended.");
		expect(host.ask).not.toHaveBeenCalled();
	});

	it.each([
		{
			why: "login_full" as const,
			member: userA.id,
			reason: (date: string) => `Your ChatGPT is full, so none of us can work. It opens again on ${date}.`,
			button: "Use another sign-in",
		},
		{
			why: "login_full" as const,
			member: sofie.userId,
			reason: (date: string) => `Sofie's ChatGPT is full, so none of us can work. It opens again on ${date}.`,
			button: "Use another sign-in",
		},
		{
			why: "sign_in" as const,
			member: userA.id,
			reason: () => "Your ChatGPT needs a new sign-in, so none of us can work.",
			button: "Sign in again",
		},
		{
			why: "sign_in" as const,
			member: sofie.userId,
			reason: () => "Sofie's ChatGPT needs a new sign-in, so none of us can work.",
			button: "Sign in again",
		},
		{
			why: "no_login" as const,
			member: userA.id,
			reason: () => "You have not connected ChatGPT, so none of us can work.",
			button: "Connect ChatGPT",
		},
		{
			why: "no_login" as const,
			member: sofie.userId,
			reason: () => "Sofie has no ChatGPT yet, so none of us can work.",
			button: "Connect ChatGPT",
		},
	])("stands still, grey, when the standing says so: $why for $member", async ({ why, member, reason, button }) => {
		const resets = new Date(Date.now() + 6 * 24 * 3600 * 1000);
		const date = new Intl.DateTimeFormat(presentationLocale(), { day: "numeric", month: "long" }).format(resets);
		const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
		const { el, host } = page(writeReadingFile(later), {
			standing: async () => ({
				stopped: true,
				since,
				why,
				member,
				resetsAt: why === "login_full" ? resets.toISOString() : null,
				waiting: 4,
			}),
		});
		await settle();
		expect(el.classList.contains("is-still")).toBe(true);
		expect(title(el)).toMatch(/^We have stood still since .+\.$/);
		expect(line(el)).toBe(reason(date));
		const settings = settingsButton(el);
		expect(settings.hidden).toBe(false);
		expect(settings.textContent).toBe(button);
		settings.click();
		expect(host.openSettings).toHaveBeenCalledWith("ai-subscriptions");
		// The picture stays, grey and still: no working marks, no change line.
		expect(things(el)).toHaveLength(6);
		expect(figure(el, product)!.classList.contains("is-still")).toBe(true);
		expect(el.querySelector(".now-figure-status")).toBeNull();
		expect(el.querySelector<HTMLElement>(".now-changes")!.hidden).toBe(true);
	});

	it("stands still with no reason when every login is ready: the title alone, no line and no button", async () => {
		const { el } = page(writeReadingFile(now), {
			standing: async () => ({
				stopped: true,
				since: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
				why: null,
				member: null,
				resetsAt: null,
				waiting: 2,
			}),
		});
		await settle();
		expect(el.classList.contains("is-still")).toBe(true);
		expect(title(el)).toMatch(/^We have stood still since .+\.$/);
		expect(line(el)).toBeNull();
		expect(settingsButton(el).hidden).toBe(true);
	});

	it("counts as running while wakes wait but the standing does not say stopped", async () => {
		const { el } = page(writeReadingFile(now), {
			standing: async () => ({
				stopped: false,
				since: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
				why: "login_full",
				member: userA.id,
				resetsAt: null,
				waiting: 1,
			}),
		});
		await settle();
		expect(el.classList.contains("is-still")).toBe(false);
		expect(title(el)).toBe(now.sentence);
		expect(settingsButton(el).hidden).toBe(true);
	});

	it("stands still before the first reading too: the figures in a row, grey", async () => {
		const { el } = page(null, {
			standing: async () => ({
				stopped: true,
				since: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
				why: "sign_in",
				member: userA.id,
				resetsAt: null,
				waiting: 1,
			}),
		});
		await settle();
		expect(title(el)).toMatch(/^We have stood still since/);
		expect(things(el)).toEqual([]);
		expect(figure(el, cofounder)!.classList.contains("is-still")).toBe(true);
	});

	it("counts an older backend, without the standing read, as running, and does not ask it again", async () => {
		const standing = vi.fn(async (): Promise<CompanyStanding> => {
			throw new CloudRpcError("qorpera_read_company_standing", { message: "not found", code: "PGRST202" }, 404);
		});
		const { el, host } = page(writeReadingFile(now), { standing });
		await settle();
		expect(el.classList.contains("is-still")).toBe(false);
		expect(title(el)).toBe(now.sentence);
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await settle();
		expect(host.standing).toHaveBeenCalledTimes(1);
	});

	it("reads the reading again on a change hint, but its bytes only when its version changed", async () => {
		const { folder, change } = page(writeReadingFile(now));
		await settle();
		expect(folder.readFile).toHaveBeenCalledTimes(1);
		await change(writeReadingFile(now), "v1");
		expect(folder.read).toHaveBeenCalledTimes(2);
		expect(folder.readFile).toHaveBeenCalledTimes(1);
		await change(writeReadingFile(later), "v2");
		expect(folder.readFile).toHaveBeenCalledTimes(2);
	});

	it("draws nothing from a read that answers after the page went away", async () => {
		const { el, view, folder } = page(writeReadingFile(now));
		view.dispose();
		await settle();
		expect(folder.read).toHaveBeenCalled();
		expect(things(el)).toEqual([]);
		expect(title(el)).toBe("");
	});

	it("stacks the things in one column in a narrow pane", async () => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				readonly #callback: () => void;
				constructor(callback: () => void) {
					this.#callback = callback;
				}
				observe() {
					queueMicrotask(() => this.#callback());
				}
				disconnect() {}
			},
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			width: 390,
			height: 600,
			top: 0,
			left: 0,
			right: 390,
			bottom: 600,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		});
		const { el } = page(writeReadingFile(now));
		await settle();
		expect(el.querySelector(".now-canvas")?.classList.contains("is-column")).toBe(true);
		const tops = things(el).map((entry) => Number.parseFloat(entry.style.top.match(/calc\(([\d.]+)/)![1]!));
		// The attended thing first.
		expect(tops[2]).toBe(Math.min(...tops));
	});

	it("asks the company: the question goes to the Co-Founder's thread as the member's own message", async () => {
		const { el, host } = page(writeReadingFile(now));
		await settle();
		const input = el.querySelector<HTMLTextAreaElement>(".now-ask textarea")!;
		const send = el.querySelector<HTMLButtonElement>(".now-ask .composer-send")!;
		expect(send.disabled).toBe(true);
		input.value = "  How are we doing?  ";
		input.dispatchEvent(new Event("input"));
		expect(send.disabled).toBe(false);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(host.ask).toHaveBeenCalledWith("How are we doing?");
		expect(input.value).toBe("");
		// A refusal says why, and keeps the words.
		host.ask.mockRejectedValueOnce(new Error("Select an active model account before sending."));
		input.value = "Again?";
		input.dispatchEvent(new Event("input"));
		el.querySelector<HTMLFormElement>(".now-ask")!.requestSubmit();
		await settle();
		expect(el.querySelector<HTMLElement>(".now-note")!.hidden).toBe(false);
		expect(el.querySelector(".now-note")?.textContent).toBe("Select an active model account before sending.");
		expect(input.value).toBe("Again?");
	});
});
