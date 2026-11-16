// @vitest-environment jsdom

import type {
	CloudMemberDataChanges,
	CloudMemberDataChangesAsked,
	CloudMemberDataDescription,
	CloudMemberDataWrite,
} from "@qorpera/cloud-client/cloud-member-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyDatabases, type CompanyDataCalls } from "../src/app/company-data.ts";
import { renderData } from "../src/app/views/data.ts";
import { DataChanges, lastDays } from "../src/app/views/data-changes.ts";
import { presentationDay, presentationTimeZone } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

const asOf = "2026-11-15T10:00:00.000Z";
const etag = "0123456789abcdef0123456789abcdef";
const KAYA = id(40);
const BO = id(41);

const described = {
	databases: [
		{
			database: "shop",
			name: "Shop",
			about: null,
			write: true,
			list: true,
			applied: [],
			tables: [
				{
					name: "repairs",
					kind: "table" as const,
					key: ["id"],
					rows: 3,
					columns: [
						{ name: "id", type: "integer", settable: false },
						{ name: "bike", type: "text", settable: true },
						{ name: "price", type: "numeric(10,2)", settable: true },
						{ name: "ready", type: "boolean", settable: true },
					],
				},
			],
			questions: [],
			changes: [],
		},
		{ database: "hr", name: "People", about: null, write: false, list: false, questions: [], changes: [] },
	],
	companyBytes: 1,
	limitBytes: 2,
} satisfies CloudMemberDataDescription;

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const daysAgo = (days: number) => presentationDay(new Date(Date.now() - days * 86_400_000));

function write(by: CloudMemberDataWrite["by"], who: string | null, at: string, rest: Partial<CloudMemberDataWrite>) {
	return { at, by, id: who, via: "list", tables: [], lines: [], ...rest } satisfies CloudMemberDataWrite;
}

const added = write("member", userA.id, hoursAgo(0), {
	tables: [{ table: "repairs", op: "add", rows: 1 }],
	lines: [
		{
			table: "repairs",
			op: "add",
			rows: 1,
			key: { id: 5 },
			before: null,
			after: { id: 5, bike: "Raleigh Tourist", price: 520, ready: false },
			columns: ["bike", "id", "price", "ready"],
		},
	],
});
const ready = write("agent", KAYA, hoursAgo(0), {
	via: "mark-ready",
	tables: [{ table: "repairs", op: "change", rows: 1 }],
	lines: [
		{
			table: "repairs",
			op: "change",
			rows: 1,
			key: { id: 1 },
			before: { ready: false },
			after: { ready: true },
			columns: ["ready"],
		},
	],
});
const stepped = write("step", KAYA, hoursAgo(0), {
	via: "002-more",
	tables: [{ table: "repairs", op: "add", rows: 3 }],
});
const removed = write("member", BO, hoursAgo(0), {
	tables: [{ table: "repairs", op: "remove", rows: 1 }],
	lines: [
		{
			table: "repairs",
			op: "remove",
			rows: 1,
			key: { id: 2 },
			before: { id: 2, bike: "Batavus Finez", price: 350, ready: false },
			after: null,
			columns: ["bike", "id", "price", "ready"],
		},
	],
});

function changesCalls(pages: CloudMemberDataChanges[]) {
	const changes = vi.fn(async (asked: CloudMemberDataChangesAsked) => {
		const page =
			asked.after === undefined ? pages[0] : pages.find((_one, index) => pages[index - 1]?.next === asked.after);
		if (!page) throw Object.assign(new Error("refused"), { status: 403 });
		return page;
	});
	const calls = {
		describe: vi.fn(async () => described),
		changes,
		rows: vi.fn(async () => ({
			columns: ["id", "bike", "price", "ready"],
			key: ["id"],
			rows: [{ values: [1, "Gazelle Orange C7", 450, false], seen: "1".padStart(64, "0") }],
			more: false,
			etag,
			asOf,
		})),
		query: vi.fn(async () => ({ columns: [], rows: [], more: false, etag, asOf })),
		edit: vi.fn(async () => ({ columns: [], key: [], row: null, asOf })),
		watchTables: vi.fn(
			(_watches: unknown, signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("put away")), { once: true }),
				),
		),
	} satisfies CompanyDataCalls;
	return calls;
}

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function company() {
	const controller = new CompanyController(fixture().api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: [{ ...staff, id: KAYA, displayName: "Kaya", templateId: "co-founder" }],
		sessions: [session],
		team: {
			...team,
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
				{
					userId: BO,
					email: "bo@example.invalid",
					displayName: "Bo Lund",
					role: "contributor",
					joinedAt: timestamp,
				},
			],
		},
		companyData: described,
	});
	cleanup.push(() => controller.stop());
	return controller;
}

async function open(pages: CloudMemberDataChanges[]) {
	const calls = changesCalls(pages);
	const controller = company();
	const databases = new CompanyDatabases(
		() => calls,
		(next) => controller.store.set({ companyData: next }),
		controller.signal,
	);
	const container = document.createElement("main");
	document.body.append(container);
	const draw = () => renderData(container, controller, databases);
	draw();
	cleanup.push(controller.store.subscribe(draw));
	await settle();
	container.querySelector<HTMLButtonElement>(".data-changes-open")?.click();
	await settle();
	return { container, calls, controller };
}

const said = (root: ParentNode) =>
	[...root.querySelectorAll(".data-changes-said")].map((one) => one.textContent?.replace(/\s+/g, " ").trim());

describe("What changed (app/views/data-changes.ts)", () => {
	it("draws two weeks of changes by who made them, and says each change of the day as one sentence", async () => {
		const today = presentationDay(new Date());
		const page = {
			writes: [added, ready, stepped, removed],
			more: false,
			days: [
				{ day: daysAgo(3), by: "agent" as const, id: KAYA, rows: 4 },
				{ day: today, by: "agent" as const, id: KAYA, rows: 1 },
				{ day: today, by: "step" as const, id: KAYA, rows: 3 },
				{ day: today, by: "member" as const, id: userA.id, rows: 1 },
				{ day: today, by: "member" as const, id: BO, rows: 1 },
			],
			asOf,
		};
		const { container, calls } = await open([page]);
		expect(calls.changes).toHaveBeenCalledWith({ database: "shop", zone: presentationTimeZone() }, expect.anything());
		expect(container.querySelector(".data-changes-open")?.getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector(".data-changes-open")?.textContent).toBe("What changed");
		expect(container.querySelector(".data-tab[aria-selected='true']")).toBeNull();
		expect(container.querySelector(".data-changes-title")?.textContent).toBe("Last two weeksWho changed what");
		expect([...container.querySelectorAll(".data-changes-key")].map((one) => one.textContent)).toEqual([
			"Your agents",
			"You",
			"Others",
		]);
		expect(container.querySelectorAll(".data-changes-day")).toHaveLength(14);
		expect(container.querySelector(".data-changes-day[aria-pressed='true']")?.getAttribute("aria-label")).toMatch(
			/: 6 changes$/,
		);
		expect(container.querySelector(".data-changes-picked")?.textContent).toBe("Today");
		expect(said(container)).toEqual([
			"You added Raleigh Tourist to Repairs",
			"Kaya set Ready to Yes on Gazelle Orange C7 · Mark ready",
			"Kaya added 3 rows to Repairs",
			"Bo Lund removed Batavus Finez from Repairs",
		]);
		expect(container.querySelector("button.data-row")).toBeNull();
		expect([...container.querySelectorAll("button")].some((one) => one.textContent === "New row")).toBe(false);

		const quiet = [...container.querySelectorAll<HTMLButtonElement>(".data-changes-day")][12];
		quiet?.click();
		await settle();
		expect(container.querySelector(".data-changes-picked")?.textContent).toBe("Yesterday");
		expect(said(container)).toEqual([]);
		expect(container.querySelector(".data-changes-quiet")?.textContent).toBe("Nothing changed this day.");

		[...container.querySelectorAll<HTMLButtonElement>(".data-tab")]
			.find((one) => one.textContent === "Repairs")
			?.click();
		await settle();
		expect(container.querySelector(".data-changes")).toBeNull();
		expect(container.querySelector(".data-changes-open")?.getAttribute("aria-pressed")).toBe("false");
	});

	it("reads earlier pages until the chosen day is whole, and shows the latest day with changes first", async () => {
		const old = write("agent", KAYA, new Date(Date.now() - 5 * 86_400_000).toISOString(), {
			tables: [{ table: "repairs", op: "change", rows: 2 }],
		});
		const older = write("agent", KAYA, new Date(Date.now() - 9 * 86_400_000).toISOString(), {
			tables: [{ table: "repairs", op: "remove", rows: 4 }],
		});
		const first = {
			writes: [
				write("agent", KAYA, new Date(Date.now() - 2 * 86_400_000).toISOString(), {
					tables: [{ table: "repairs", op: "add", rows: 7 }],
				}),
			],
			more: true,
			next: "40",
			days: [
				{ day: daysAgo(2), by: "agent" as const, id: KAYA, rows: 7 },
				{ day: daysAgo(5), by: "agent" as const, id: KAYA, rows: 2 },
				{ day: daysAgo(9), by: "agent" as const, id: KAYA, rows: 4 },
			],
			asOf,
		};
		const second = { writes: [old], more: true, next: "20", asOf };
		const third = { writes: [older], more: false, asOf };
		const { container, calls } = await open([first, second, third]);
		expect(said(container)).toEqual(["Kaya added 7 rows to Repairs"]);
		expect(calls.changes).toHaveBeenCalledTimes(2);
		expect([...container.querySelectorAll(".data-changes-key")].map((one) => one.textContent)).toEqual([
			"Your agents",
		]);
		const days = [...container.querySelectorAll<HTMLButtonElement>(".data-changes-day")];
		days[13 - 9]?.click();
		await settle();
		expect(calls.changes).toHaveBeenLastCalledWith({ database: "shop", after: "20" }, expect.anything());
		expect(said(container)).toEqual(["Kaya removed 4 rows from Repairs"]);
		days[13 - 5]?.click();
		await settle();
		expect(calls.changes).toHaveBeenCalledTimes(3);
		expect(said(container)).toEqual(["Kaya changed 2 rows in Repairs"]);
	});

	it("says when what changed can't be read, and that nothing changed in two weeks", async () => {
		const failing = await open([]);
		expect(failing.container.querySelector(".data-changes-title")?.textContent).toBe(
			"Last two weeksWho changed what",
		);
		expect(failing.container.querySelector(".data-changes [role='alert'] .data-changes-quiet")?.textContent).toBe(
			"What changed can't be read just now",
		);
		document.body.replaceChildren();
		const quiet = await open([
			{
				writes: [
					write("agent", KAYA, new Date(Date.now() - 20 * 86_400_000).toISOString(), {
						tables: [{ table: "repairs", op: "add", rows: 1 }],
					}),
				],
				more: false,
				days: [],
				asOf,
			},
		]);
		expect(quiet.container.querySelector(".data-changes-none")?.textContent).toBe(
			"Nothing has changed in the last two weeks.",
		);
		expect(quiet.container.querySelector(".data-changes-chart")).toBeNull();
	});

	it("reads again without the time zone when the gateway does not know it", async () => {
		const page = { writes: [added], more: false, asOf };
		const calls = changesCalls([page]);
		calls.changes.mockImplementationOnce(async () => {
			throw Object.assign(new Error("No time zone"), { status: 400 });
		});
		const view = new DataChanges(company(), () => calls);
		const [shop] = described.databases;
		if (shop) view.show(shop);
		await settle();
		expect(calls.changes.mock.calls.map(([asked]) => asked)).toEqual([
			{ database: "shop", zone: presentationTimeZone() },
			{ database: "shop" },
		]);
		expect(said(view.el)).toEqual(["You added Raleigh Tourist to Repairs"]);
	});

	it("names no tab for a database whose tables the member does not get", async () => {
		const { container } = await open([]);
		[...container.querySelectorAll<HTMLButtonElement>(".data-database")]
			.find((one) => one.textContent === "People")
			?.click();
		await settle();
		expect(container.querySelector(".data-changes-open")).toBeNull();
		expect(container.querySelector(".data-changes")).toBeNull();
	});

	it("says each kind of change in plain words", () => {
		const view = new DataChanges(company(), () => changesCalls([]));
		const [shop] = described.databases;
		if (shop) view.show(shop);
		const line = (op: "add" | "change" | "remove", rest: object) => ({
			table: "repairs",
			op,
			rows: 1,
			key: { id: 3 },
			before: null,
			after: null,
			columns: null,
			...rest,
		});
		const one = (op: "add" | "change" | "remove", rest: object, extra: Partial<CloudMemberDataWrite> = {}) =>
			view.sentence(
				write("agent", KAYA, asOf, {
					tables: [{ table: "repairs", op, rows: 1 }],
					lines: [line(op, rest)],
					...extra,
				}),
			);
		expect(one("change", { after: { price: null }, before: { price: 450 }, columns: ["price"] })).toBe(
			"cleared Price on row 3 of Repairs",
		);
		expect(
			one("change", {
				after: { bike: "Trek", price: 1, ready: true, notes: "x" },
				columns: ["bike", "notes", "price", "ready"],
			}),
		).toBe("changed Bike, Notes, Price and Ready on Trek");
		expect(one("change", { after: { bike: "Trek" }, columns: ["a", "b", "bike", "c", "d", "e"] })).toBe(
			"changed A, B, Bike and 3 other columns on Trek",
		);
		expect(one("change", { key: null, columns: ["bike"] })).toBe("changed a row in Repairs");
		expect(
			one("change", {
				key: null,
				before: { bike: "Trek", price: 1, ready: false },
				after: { bike: "Trek", price: 2, ready: false },
				columns: ["bike", "price", "ready"],
			}),
		).toBe("set Price to 2 on Trek");
		expect(one("add", { after: null, key: { id: 3 } })).toBe("added a row to Repairs");
		expect(
			view.sentence(
				write("step", KAYA, asOf, {
					tables: [
						{ table: "repairs", op: "add", rows: 10000 },
						{ table: "parts_used", op: "remove", rows: 2 },
					],
					many: true,
				}),
			),
		).toBe("added 10,000 rows to Repairs and removed 2 rows from Parts used and more");
		expect(lastDays("2026-03-02", 3)).toEqual(["2026-02-28", "2026-03-01", "2026-03-02"]);
	});
});
