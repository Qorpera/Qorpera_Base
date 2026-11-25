// @vitest-environment jsdom

import { getEventListeners } from "node:events";
import type {
	CloudMemberDataDescription,
	CloudMemberDataEdit,
	CloudMemberDataPage,
} from "@qorpera/cloud-client/cloud-member-data";
import { CloudMemberDataError } from "@qorpera/cloud-client/cloud-member-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyDatabases, type CompanyDataCalls } from "../src/app/company-data.ts";
import type { InterfacePagesState } from "../src/app/interface-pages.ts";
import { companyInterfaces, hiddenInterfaces } from "../src/app/interfaces.ts";
import { columnKind, disposeData, humanName, refusalWords, renderData, shownValue } from "../src/app/views/data.ts";
import { renderInterface } from "../src/app/views/interface.ts";
import { fileKey, parseMemberAppLayout } from "../src/cloud/app-groups.ts";
import { parseInterfacePages } from "../src/cloud/interface-pages.ts";
import { interfaceEmblem } from "../src/ui/interface-emblem.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

const seen = (n: number) => String(n).padStart(64, "0");
const etag = "0123456789abcdef0123456789abcdef";
const asOf = "2026-11-15T10:00:00.000Z";

function describedWith(write = true, extra: Partial<CloudMemberDataDescription["databases"][number]> = {}) {
	return {
		databases: [
			{
				database: "shop",
				name: "Shop",
				about: null,
				write,
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
					{
						name: "open_repairs",
						kind: "view" as const,
						key: [],
						columns: [{ name: "bike", type: "text", settable: false }],
					},
					{
						name: "notes",
						kind: "table" as const,
						key: [],
						rows: 1,
						columns: [{ name: "note", type: "text", settable: true }],
					},
				],
				questions: [
					{ name: "waited-over-a-week", words: "Repairs waiting.", parameters: [] },
					{ name: "since", words: null, parameters: ["day"] },
				],
				changes: [],
				...extra,
			},
		],
		companyBytes: 12_000_000,
		limitBytes: 1_000_000_000,
	} satisfies CloudMemberDataDescription;
}

const repairs = (rows: [number, string, number, boolean][], more = false): CloudMemberDataPage => ({
	columns: ["id", "bike", "price", "ready"],
	key: ["id"],
	rows: rows.map((values) => ({ values, seen: seen(values[0]) })),
	more,
	...(more ? { next: [rows.at(-1)?.[0]] } : {}),
	etag,
	asOf,
});

function fakeCalls(described: CloudMemberDataDescription) {
	const edits: CloudMemberDataEdit[] = [];
	let current: unknown[] = [1, "Gazelle Orange C7", 450, true];
	const calls = {
		describe: vi.fn(async () => described),
		changes: vi.fn(async () => ({ writes: [], more: false, asOf })),
		rows: vi.fn(
			async (
				asked: { table: string; after?: readonly unknown[] },
				_signal?: AbortSignal,
			): Promise<CloudMemberDataPage> => {
				if (asked.table === "open_repairs")
					return {
						columns: ["bike"],
						key: [],
						rows: [{ values: ["Trek"], seen: seen(9) }],
						more: true,
						etag,
						asOf,
					};
				if (asked.table === "notes") return { columns: ["note"], key: [], rows: [], more: false, etag, asOf };
				if (asked.after) return repairs([[3, "Raleigh Tourist", 520, false]]);
				return repairs(
					[
						[1, "Gazelle Orange C7", 450, true],
						[2, "Batavus Finez", 350, false],
					],
					true,
				);
			},
		),
		query: vi.fn(async () => ({ columns: ["bike"], rows: [["Christiania Cargo"]], more: false, etag, asOf })),
		edit: vi.fn(async (edit: CloudMemberDataEdit) => {
			edits.push(edit);
			if (edit.op === "remove") return { columns: ["id", "bike", "price", "ready"], key: ["id"], row: null, asOf };
			const values = edit.op === "add" ? [9, "New", null, false] : [...current];
			for (const [name, value] of Object.entries(edit.values))
				values[["id", "bike", "price", "ready"].indexOf(name)] = value as never;
			if (edit.op === "change") current = values;
			return { columns: ["id", "bike", "price", "ready"], key: ["id"], row: { values, seen: seen(99) }, asOf };
		}),
		watchTables: vi.fn(
			(_watches: unknown, signal: AbortSignal): ReturnType<CompanyDataCalls["watchTables"]> =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("put away")), { once: true }),
				),
		),
	} satisfies CompanyDataCalls;
	return { calls, edits };
}

const pages = (hidden: string[] = []): InterfacePagesState => ({
	pages: (["mailbox", "members", "bank", "data"] as const).map((page) => ({
		page,
		on: true,
		hidden: hidden.includes(page),
	})),
	mayChange: true,
	personal: true,
});

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

function company(described: CloudMemberDataDescription | null | undefined, write = true) {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({
		loading: false,
		staff: [{ ...staff, id: id(40), displayName: "Kaya", templateId: "co-founder" }],
		sessions: [session],
		team: {
			...team,
			capabilities: { ...team.capabilities, write },
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
			],
		},
		interfacePages: pages(),
		companyData: described,
	});
	cleanup.push(() => controller.stop());
	return controller;
}

async function open(described: CloudMemberDataDescription, write = true, list = true) {
	const { calls, edits } = fakeCalls(described);
	const controller = company(described, write);
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
	if (list) {
		toList(container);
		await settle();
	}
	return { container, calls, edits, controller };
}

const toList = (root: ParentNode) =>
	(
		root.querySelector<HTMLButtonElement>(".data-plot[data-table='repairs']") ??
		root.querySelector<HTMLButtonElement>(".data-plot")
	)?.click();

const button = (root: ParentNode, label: string) => {
	const found = [...root.querySelectorAll("button")].find((one) => one.textContent?.trim() === label);
	if (!found) throw new Error(`No button ${label}`);
	return found;
};
const texts = (root: ParentNode, selector: string) =>
	[...root.querySelectorAll(selector)].map((element) => element.textContent?.trim());

describe("the Data page in the apps row", () => {
	it("shows only while describe lists a database, with the chest of drawers", () => {
		expect(companyInterfaces(company(undefined)).map((entry) => entry.name)).not.toContain("data");
		expect(
			companyInterfaces(company({ databases: [], companyBytes: 0, limitBytes: 1 })).map((one) => one.name),
		).not.toContain("data");
		const shown = companyInterfaces(company(describedWith())).find((entry) => entry.name === "data");
		expect(shown?.file.name).toBe("Data");
		const hiding = company(describedWith());
		hiding.store.set({ interfacePages: pages(["data"]) });
		expect(companyInterfaces(hiding).map((entry) => entry.name)).not.toContain("data");
		expect(hiddenInterfaces(hiding).map((entry) => entry.name)).toEqual(["data"]);
		hiding.store.set({ companyData: null });
		expect(hiddenInterfaces(hiding)).toEqual([]);
		const drawers = interfaceEmblem("drawers", 34);
		expect(drawers.querySelectorAll('g [data-fill="ink"]')).toHaveLength(1);
		expect(drawers.querySelectorAll('mask [data-stroke="cut"]')).toHaveLength(2);
	});

	it("draws its header and text until the databases are there to read", () => {
		const container = document.createElement("main");
		document.body.append(container);
		renderInterface(container, company(describedWith()), "data");
		expect(container.querySelector(".interface-title h1")?.textContent).toBe("Data");
		expect(texts(container, ".interface-text")).toEqual([expect.stringContaining("The company's databases.")]);
		container.remove();
	});

	it("knows the page by name in the cloud's list and in the member's own drawer", () => {
		expect(
			parseInterfacePages({
				schema: "qorpera.member-interface-pages/v1",
				pages: [{ page: "data", on: true, hidden: false }],
				mayChange: false,
			}).pages,
		).toEqual([{ page: "data", on: true, hidden: false }]);
		expect(() =>
			parseInterfacePages({
				schema: "qorpera.member-interface-pages/v1",
				pages: [{ page: "pulse", on: true }],
				mayChange: false,
			}),
		).toThrow();
		expect(fileKey("data")).toBe("page:data");
		const layout = parseMemberAppLayout({
			schema: "qorpera.member-app-layout/v1",
			places: {
				"page:data": { group: null, after: "page:bank", at: 1 },
				"page:pulse": { group: null, after: null, at: 0 },
			},
			groups: {},
			colours: { "page:data": "teal" },
			emblems: { "page:data": "box" },
		});
		expect(Object.keys(layout.places)).toEqual(["page:data"]);
		expect(layout.colours).toEqual({ "page:data": "teal" });
		expect(layout.emblems).toEqual({ "page:data": "box" });
	});
});

describe("the home and the two lines of names (app/views/data.ts)", () => {
	const table = (name: string, rows: number) => ({
		name,
		kind: "table" as const,
		key: ["id"],
		rows,
		columns: [
			{ name: "id", type: "integer", settable: false },
			{ name: "bike", type: "text", settable: true },
			{ name: "price", type: "numeric(10,2)", settable: true },
			{ name: "ready", type: "boolean", settable: true },
		],
	});
	const poker = () =>
		describedWith(true, {
			tables: [table("app_users", 3), table("hand_actions", 1284), table("hand_decisions", 0)],
			questions: [],
		});

	it("opens a database with several tables as fields, and reads no rows until one is picked", async () => {
		const { container, calls } = await open(poker(), true, false);
		expect(container.querySelector(".data-home-title")?.textContent).toBe("Shop12 MB of 1 GB");
		expect(texts(container, ".data-plot-name")).toEqual(["Hand actions", "Hand decisions", "App users"]);
		expect(texts(container, ".data-plot-count")).toEqual(["1,284", "Empty", "3"]);
		expect(container.querySelector(".data-plot.is-empty")?.textContent).toContain("Hand decisions");
		expect(container.querySelector(".data-tab")).toBeNull();
		expect(calls.rows).not.toHaveBeenCalled();
		expect(calls.watchTables).not.toHaveBeenCalled();

		container.querySelector<HTMLButtonElement>(".data-plot[data-table='hand_actions']")?.click();
		await settle();
		expect(calls.rows).toHaveBeenCalledWith(
			{ database: "shop", table: "hand_actions", limit: 100 },
			expect.anything(),
		);
		expect(texts(container, ".data-tab")).toEqual(["App users", "Hand"]);
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Hand");
		expect(texts(container, ".data-subtab")).toEqual(["Actions1,284", "Decisions0"]);
		expect(container.querySelector(".data-subtab[aria-selected='true']")?.textContent).toBe("Actions1,284");
		expect(container.querySelector(".data-plot")).toBeNull();
	});

	it("moves between a group's tables in the small line, and goes home by the small picture", async () => {
		const { container, calls } = await open(poker(), true, false);
		container.querySelector<HTMLButtonElement>(".data-plot[data-table='hand_actions']")?.click();
		await settle();
		button(container, "Decisions0").click();
		await settle();
		expect(calls.rows).toHaveBeenLastCalledWith(
			{ database: "shop", table: "hand_decisions", limit: 100 },
			expect.anything(),
		);
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Hand");

		button(container, "App users").click();
		await settle();
		expect(texts(container, ".data-subtab")).toEqual([]);
		expect(container.querySelector(".data-sub")).not.toBeNull();

		const home = container.querySelector<HTMLButtonElement>(".data-home-open");
		expect(home?.getAttribute("aria-label")).toBe("All of Shop");
		home?.click();
		await settle();
		expect(texts(container, ".data-plot-name")).toHaveLength(3);
		expect(container.querySelector(".data-tab")).toBeNull();
	});

	it("skips the home for a database with one table", async () => {
		const { container, calls } = await open(describedWith(true, { tables: [table("repairs", 3)] }), true, false);
		expect(container.querySelector(".data-plot")).toBeNull();
		expect(container.querySelector(".data-home-open")).toBeNull();
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Repairs");
		expect(calls.rows).toHaveBeenCalledTimes(1);
	});

	it("keeps kept questions in reach from the home, and What changed opens and closes there", async () => {
		const { container, calls } = await open(describedWith(), true, false);
		expect(texts(container, ".data-subtab")).toEqual(["Waited over a week", "Since"]);
		const changes = container.querySelector<HTMLButtonElement>(".data-changes-open");
		changes?.click();
		await settle();
		expect(container.querySelector(".data-changes")).not.toBeNull();
		expect(container.querySelector(".data-plot")).toBeNull();
		container.querySelector<HTMLButtonElement>(".data-changes-open")?.click();
		await settle();
		expect(container.querySelector(".data-changes")).toBeNull();
		expect(container.querySelector(".data-plot")).not.toBeNull();

		button(container, "Waited over a week").click();
		await settle();
		expect(calls.query).toHaveBeenCalledWith(
			{ database: "shop", question: "waited-over-a-week", params: {} },
			expect.anything(),
		);
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Questions");
	});
});

describe("the list (app/views/data.ts)", () => {
	it("shows a table's rows under tabs for its tables and its kept questions", async () => {
		const { container, calls } = await open(describedWith());
		expect(texts(container, ".data-tab")).toEqual(["Repairs", "Open repairs", "Notes", "Questions"]);
		expect(texts(container, ".data-subtab")).toEqual([]);
		expect(container.querySelector(".data-tab[aria-selected='true']")?.textContent).toBe("Repairs");
		expect(calls.rows).toHaveBeenCalledWith({ database: "shop", table: "repairs", limit: 100 }, expect.anything());
		expect(texts(container, ".data-row-head .data-cell")).toEqual(["Bike", "Price", "Ready", "Id"]);
		expect(texts(container, "button.data-row .is-lead")).toEqual(["Gazelle Orange C7", "Batavus Finez"]);
		expect(container.querySelector(".data-foot")?.textContent).toContain("3 rows");
		expect(container.querySelector(".data-foot")?.textContent).toContain("12 MB of 1 GB");
		expect(button(container, "New row")).toBeTruthy();
		expect(calls.watchTables).toHaveBeenCalledWith(
			[{ database: "shop", table: "repairs", limit: 100, etag }],
			expect.anything(),
		);

		button(container, "Questions").click();
		await settle();
		expect(texts(container, ".data-subtab")).toEqual(["Waited over a week", "Since"]);
		expect(container.querySelector(".data-subtab[aria-selected='true']")?.textContent).toBe("Waited over a week");
		expect(calls.query).toHaveBeenCalledWith(
			{ database: "shop", question: "waited-over-a-week", params: {} },
			expect.anything(),
		);
		expect(texts(container, ".data-row:not(.data-row-head) .is-lead")).toEqual(["Christiania Cargo"]);
		expect(container.querySelector("button.data-row")).toBeNull();
		expect(container.querySelector(".data-foot")?.textContent).toContain("A kept question, read only");
	});

	it("sorts by a column head through the gateway, and pages on by key", async () => {
		const { container, calls } = await open(describedWith());
		button(container, "Bike").click();
		await settle();
		expect(calls.rows).toHaveBeenLastCalledWith(
			{ database: "shop", table: "repairs", order: "bike", desc: false, limit: 100 },
			expect.anything(),
		);
		expect(container.querySelector(".data-sort.is-on")?.getAttribute("aria-pressed")).toBe("true");
		button(container, "Bike").click();
		await settle();
		expect(calls.rows).toHaveBeenLastCalledWith(
			{ database: "shop", table: "repairs", order: "bike", desc: true, limit: 100 },
			expect.anything(),
		);
		button(container, "Show more").click();
		await settle();
		expect(calls.rows).toHaveBeenLastCalledWith(
			{ database: "shop", table: "repairs", order: "bike", desc: true, limit: 100, after: [2] },
			expect.anything(),
		);
		expect(texts(container, "button.data-row .is-lead")).toEqual([
			"Gazelle Orange C7",
			"Batavus Finez",
			"Raleigh Tourist",
		]);
		expect(container.querySelector(".data-more")).toBeNull();
	});

	it("says a view and a table without a key are read only, and opens their rows to read", async () => {
		const { container } = await open(describedWith());
		button(container, "Open repairs").click();
		await settle();
		expect(() => button(container, "New row")).toThrow();
		expect(container.querySelector(".data-foot")?.textContent).toContain("A view, read only");
		expect(container.querySelector(".data-foot")?.textContent).toContain("The first 1 rows");
		button(container, "Notes").click();
		await settle();
		expect(container.querySelector(".data-foot")?.textContent).toContain("No key, read only");
		expect(container.querySelector(".data-none")?.textContent).toBe("No rows yet");
		button(container, "Open repairs").click();
		await settle();
		button(container, "Trek").click();
		expect(container.querySelector(".data-field-input")).toBeNull();
		expect(texts(container, ".data-field-value")).toEqual(["Trek"]);
		expect(container.querySelector(".data-remove")).toBeNull();
	});

	it("shows a member without the write right the rows and no way to change them", async () => {
		const { container } = await open(describedWith(false));
		expect(() => button(container, "New row")).toThrow();
		expect(container.querySelector(".data-foot")?.textContent).toContain("Read only for you");
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		expect(container.querySelector(".data-field-input")).toBeNull();
		expect(texts(container, ".data-field-value")).toEqual(["Gazelle Orange C7", "450", "Yes", "1"]);
		expect(container.querySelector(".data-remove")).toBeNull();
	});

	it("says there is no data yet, and who sees a database's tables", async () => {
		const none = await open({ databases: [], companyBytes: 0, limitBytes: 1 });
		expect(none.container.querySelector(".data-empty h1")?.textContent).toBe("No company data yet");
		const hidden = await open({
			...describedWith(),
			databases: [
				{ database: "hr", name: null, about: null, write: false, list: false, questions: [], changes: [] },
			],
		});
		expect(hidden.container.querySelector(".data-empty p")?.textContent).toBe(
			"Only those who may change this database see its tables.",
		);
	});

	it("aborts active table watches and detaches abort listeners when disposed", async () => {
		const { container, calls, controller } = await open(describedWith());
		const watchSignal = calls.watchTables.mock.calls[0]?.[1] as AbortSignal;
		expect(watchSignal.aborted).toBe(false);
		const listenersBefore = getEventListeners(controller.signal, "abort").length;
		disposeData(container);
		expect(watchSignal.aborted).toBe(true);
		expect(getEventListeners(controller.signal, "abort").length).toBeLessThan(listenersBefore);
	});

	it("keeps watch polling live across multiple rounds without leaking abort listeners", async () => {
		vi.useFakeTimers();
		try {
			const { calls } = fakeCalls(describedWith());
			const watchSignals: AbortSignal[] = [];
			const resolvers: Array<() => void> = [];
			calls.watchTables.mockImplementation(
				(_watches: unknown, signal: AbortSignal) =>
					new Promise<{ same: true }>((resolve) => {
						watchSignals.push(signal);
						resolvers.push(() => resolve({ same: true }));
					}),
			);
			const controller = company(describedWith(), true);
			const databases = new CompanyDatabases(
				() => calls,
				(next) => controller.store.set({ companyData: next }),
				controller.signal,
			);
			const container = document.createElement("main");
			document.body.append(container);
			renderData(container, controller, databases);
			toList(container);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.watchTables).toHaveBeenCalledTimes(1);
			expect(watchSignals[0]?.aborted).toBe(false);
			const listenersRound1 = getEventListeners(controller.signal, "abort").length;
			resolvers[0]!();
			await vi.advanceTimersByTimeAsync(500);
			expect(calls.watchTables).toHaveBeenCalledTimes(2);
			expect(watchSignals[1]?.aborted).toBe(false);
			expect(getEventListeners(controller.signal, "abort").length).toBe(listenersRound1);
			disposeData(container);
			expect(watchSignals[1]?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("a row, changed as the member types (app/views/data.ts)", () => {
	it("writes a changed field when the member leaves it, with the row's key and seen", async () => {
		const { container, edits } = await open(describedWith());
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		expect(container.querySelector(".data-thing-title")?.textContent).toBe("Gazelle Orange C7");
		const bike = container.querySelector<HTMLInputElement>("#data-field-bike")!;
		bike.value = "Gazelle Orange C8";
		bike.dispatchEvent(new Event("input"));
		bike.dispatchEvent(new Event("change"));
		await settle();
		expect(edits).toEqual([
			{
				database: "shop",
				table: "repairs",
				op: "change",
				key: { id: 1 },
				seen: seen(1),
				values: { bike: "Gazelle Orange C8" },
			},
		]);
		expect(container.querySelector(".data-thing-title")?.textContent).toBe("Gazelle Orange C8");
		container.querySelector<HTMLButtonElement>("#data-field-ready")!.click();
		await settle();
		expect(edits.at(-1)).toEqual({
			database: "shop",
			table: "repairs",
			op: "change",
			key: { id: 1 },
			seen: seen(99),
			values: { ready: false },
		});
		button(container, "Repairs").click();
		expect(texts(container, "button.data-row .is-lead")).toContain("Gazelle Orange C8");
	});

	it("shows the row as it is now after someone else changed it, in plain words", async () => {
		const { container, calls } = await open(describedWith());
		calls.edit.mockRejectedValueOnce(
			new CloudMemberDataError("The row was changed since it was read", 409, {
				row: { values: [1, "Gazelle by Emma", 470, true], seen: seen(7) },
			}),
		);
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.value = "500";
		price.dispatchEvent(new Event("input"));
		price.dispatchEvent(new Event("change"));
		await settle();
		expect(container.querySelector(".data-notice")?.textContent).toBe(
			"Someone changed this row just now. This is how it is now.",
		);
		expect(container.querySelector<HTMLInputElement>("#data-field-price")?.value).toBe("470");
		expect(container.querySelector(".data-thing-title")?.textContent).toBe("Gazelle by Emma");
	});

	it("asks before a removal on the bar above the page, and removes only on the member's yes", async () => {
		const { container, edits } = await open(describedWith());
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		button(container, "Remove row").click();
		const bar = container.querySelector<HTMLElement>(".data-ask")!;
		expect(bar.hidden).toBe(false);
		expect(bar.querySelector(".app-ask-title")?.textContent).toBe("Remove Gazelle Orange C7?");
		expect(document.activeElement?.textContent).toBe("Not now");
		button(bar, "Not now").click();
		expect(bar.hidden).toBe(true);
		expect(edits).toEqual([]);
		button(container, "Remove row").click();
		button(bar, "Remove").click();
		await settle();
		expect(edits).toEqual([{ database: "shop", table: "repairs", op: "remove", key: { id: 1 }, seen: seen(1) }]);
		expect(bar.hidden).toBe(true);
		expect(texts(container, "button.data-row .is-lead")).toEqual(["Batavus Finez"]);
		expect(container.querySelector(".data-foot")?.textContent).toContain("2 rows");
	});

	it("adds a new row once the member fills it in, and says what is missing", async () => {
		const { container, calls, edits } = await open(describedWith());
		button(container, "New row").click();
		expect(container.querySelector(".data-thing-title")?.textContent).toBe("New row");
		expect(container.querySelector("#data-field-id")).toBeNull();
		calls.edit.mockRejectedValueOnce(
			new CloudMemberDataError('null value in column "price" violates not-null constraint', 400, { code: "23502" }),
		);
		const bike = container.querySelector<HTMLInputElement>("#data-field-bike")!;
		bike.value = "Kildemoes";
		bike.dispatchEvent(new Event("input"));
		bike.dispatchEvent(new Event("change"));
		await settle();
		expect(container.querySelector("[data-column='price'] .data-field-note")?.textContent).toBe("Fill in Price too.");
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.value = "180";
		price.dispatchEvent(new Event("input"));
		price.dispatchEvent(new Event("change"));
		await settle();
		expect(edits.at(-1)).toEqual({
			database: "shop",
			table: "repairs",
			op: "add",
			values: { bike: "Kildemoes", price: "180" },
		});
		expect(container.querySelector(".data-thing-title")?.textContent).toBe("Kildemoes");
		expect(container.querySelector("#data-field-id")).not.toBeNull();
	});
});

describe("a new row and a toggle, while the store answers", () => {
	it("keeps a field filled in while the first add is on its way, and writes it to the new row", async () => {
		const { container, calls, edits } = await open(describedWith());
		let land: () => void = () => {};
		const first = calls.edit.getMockImplementation()!;
		calls.edit.mockImplementationOnce(
			(edit: CloudMemberDataEdit) =>
				new Promise((resolve) => {
					land = () => resolve(first(edit));
				}),
		);
		button(container, "New row").click();
		const bike = container.querySelector<HTMLInputElement>("#data-field-bike")!;
		bike.value = "Kildemoes";
		bike.dispatchEvent(new Event("input"));
		bike.dispatchEvent(new Event("change"));
		await settle();
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.value = "180";
		price.dispatchEvent(new Event("input"));
		price.dispatchEvent(new Event("change"));
		land();
		await settle();
		expect(edits[0]).toEqual({ database: "shop", table: "repairs", op: "add", values: { bike: "Kildemoes" } });
		expect(edits[1]).toMatchObject({ op: "change", key: { id: 9 }, values: { price: "180" } });
		expect(edits).toHaveLength(2);
		expect(container.querySelector<HTMLInputElement>("#data-field-price")?.value).toBe("180");
	});

	it("keeps the field a member is typing in when the add lands", async () => {
		const { container, calls } = await open(describedWith());
		let land: () => void = () => {};
		const first = calls.edit.getMockImplementation()!;
		calls.edit.mockImplementationOnce(
			(edit: CloudMemberDataEdit) =>
				new Promise((resolve) => {
					land = () => resolve(first(edit));
				}),
		);
		button(container, "New row").click();
		const bike = container.querySelector<HTMLInputElement>("#data-field-bike")!;
		bike.value = "Kildemoes";
		bike.dispatchEvent(new Event("input"));
		bike.dispatchEvent(new Event("change"));
		await settle();
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.focus();
		price.value = "18";
		price.dispatchEvent(new Event("input"));
		land();
		await settle();
		const now = container.querySelector<HTMLInputElement>("#data-field-price")!;
		expect(now.value).toBe("18");
		expect(document.activeElement).toBe(now);
		now.blur();
		await settle();
		expect(calls.edit).toHaveBeenLastCalledWith(
			{ database: "shop", table: "repairs", op: "change", key: { id: 9 }, seen: seen(99), values: { price: "18" } },
			expect.anything(),
		);
	});

	it("shows a JSON string with its quotes and sends it back as the string it is", async () => {
		const described = describedWith();
		const table = described.databases[0]!.tables![0]!;
		(table.columns as { name: string; type: string; settable: boolean }[])[1] = {
			name: "bike",
			type: "jsonb",
			settable: true,
		};
		const { container, calls, edits } = await open(described);
		calls.rows.mockResolvedValueOnce(repairs([[1, "42" as never, 450, true]]));
		button(container, "Price").click();
		await settle();
		button(container, '"42"450Yes1').click();
		await settle();
		const bike = container.querySelector<HTMLTextAreaElement>("#data-field-bike")!;
		expect(bike.value).toBe('"42"');
		bike.value = '"43"';
		bike.dispatchEvent(new Event("input"));
		bike.dispatchEvent(new Event("change"));
		await settle();
		expect(edits.at(-1)).toMatchObject({ op: "change", values: { bike: "43" } });
	});

	it("adds nothing for a field emptied again before the member leaves it", async () => {
		const { container, edits } = await open(describedWith());
		button(container, "New row").click();
		const bike = container.querySelector<HTMLInputElement>("#data-field-bike")!;
		bike.focus();
		bike.value = "";
		bike.dispatchEvent(new Event("input"));
		bike.blur();
		await settle();
		expect(edits).toEqual([]);
	});

	it("keeps a toggle as the member set it while an earlier change lands", async () => {
		const { container, calls, edits } = await open(describedWith());
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		let land: () => void = () => {};
		const first = calls.edit.getMockImplementation()!;
		calls.edit.mockImplementationOnce(
			(edit: CloudMemberDataEdit) =>
				new Promise((resolve) => {
					land = () => resolve(first(edit));
				}),
		);
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.value = "500";
		price.dispatchEvent(new Event("input"));
		price.dispatchEvent(new Event("change"));
		const ready = container.querySelector<HTMLButtonElement>("#data-field-ready")!;
		ready.click();
		expect(ready.textContent).toBe("No");
		await settle();
		land();
		await settle();
		expect(ready.textContent).toBe("No");
		expect(edits.at(-1)).toMatchObject({ op: "change", values: { ready: false } });
	});

	it("shows the last toggle while several of its writes are on their way", async () => {
		const { container, calls } = await open(describedWith());
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		const lands: (() => void)[] = [];
		const first = calls.edit.getMockImplementation()!;
		calls.edit.mockImplementation(
			(edit: CloudMemberDataEdit) =>
				new Promise((resolve) => {
					lands.push(() => resolve(first(edit)));
				}),
		);
		const ready = container.querySelector<HTMLButtonElement>("#data-field-ready")!;
		ready.click();
		ready.click();
		ready.click();
		expect(ready.textContent).toBe("No");
		for (let landed = 0; landed < 3; landed++) {
			await settle();
			expect(lands).toHaveLength(landed + 1);
			lands[landed]?.();
			await settle();
			expect(ready.textContent).toBe("No");
			expect(ready.closest(".data-field")?.classList.contains("is-saving")).toBe(landed < 2);
			expect(ready.closest(".data-field")?.classList.contains("is-saved")).toBe(landed === 2);
		}
	});

	it("puts back only a refused toggle, not a field saved before it", async () => {
		const { container, calls } = await open(describedWith());
		button(container, "Gazelle Orange C7450Yes1").click();
		await settle();
		const first = calls.edit.getMockImplementation()!;
		calls.edit.mockImplementationOnce(async (edit: CloudMemberDataEdit) => first(edit));
		calls.edit.mockRejectedValueOnce(new CloudMemberDataError("check", 400, { code: "23514" }));
		const price = container.querySelector<HTMLInputElement>("#data-field-price")!;
		price.value = "500";
		price.dispatchEvent(new Event("input"));
		price.dispatchEvent(new Event("change"));
		const ready = container.querySelector<HTMLButtonElement>("#data-field-ready")!;
		ready.click();
		await settle();
		expect(ready.textContent).toBe("Yes");
		expect(container.querySelector<HTMLInputElement>("#data-field-price")?.value).toBe("500");
		expect(container.querySelector("[data-column='ready'] .data-field-note")?.textContent).toBe(
			"That value isn't allowed here.",
		);
	});
});

describe("the page's words for values and refusals", () => {
	it("reads a column's type, names it, and shows its values", () => {
		expect(
			["boolean", "integer", "numeric(10,2)", "date", "timestamp with time zone", "jsonb", "text"].map(columnKind),
		).toEqual(["boolean", "number", "number", "date", "time", "json", "text"]);
		expect(["integer[]", "numeric(10,2)[]", "integer"].map(columnKind)).toEqual(["text", "text", "number"]);
		expect(humanName("open_repairs")).toBe("Open repairs");
		expect(humanName("waited-over-a-week")).toBe("Waited over a week");
		expect(shownValue(true, "boolean")).toBe("Yes");
		expect(shownValue(null, "text")).toBe("");
		expect(shownValue({ a: 1 }, "json")).toBe('{"a":1}');
		expect(shownValue("2026-11-09", "date")).toMatch(/2026/);
	});

	it("never shows a status code or the store's own words", () => {
		for (const [error, words] of [
			[new CloudMemberDataError("x", 400, { code: "23505" }), "Another row has this already."],
			[new CloudMemberDataError("x", 400, { code: "22P02" }), "That doesn't fit this field."],
			[new CloudMemberDataError("x", 403), "You can't change this table."],
			[new CloudMemberDataError("x", 507), "The company's data is full. Removing rows still works."],
			[new CloudMemberDataError("x", 408), "Not saved. Try again."],
			[new Error("network"), "Not saved. Try again."],
		] as const)
			expect(refusalWords(error)).toBe(words);
	});

	it("appends Show more rows incrementally, preserves scrolled pages and clears loading across live watch updates, and caches Intl formatters", async () => {
		vi.useFakeTimers();
		try {
			const { calls } = fakeCalls(describedWith());
			const watchResolves: Array<
				(value: { changed: Array<{ index: number; answer: CloudMemberDataPage }> }) => void
			> = [];
			calls.watchTables.mockImplementation(
				(_watches: unknown, signal: AbortSignal) =>
					new Promise((resolve, reject) => {
						watchResolves.push(resolve);
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
			);
			let pendingMoreResolve: ((page: CloudMemberDataPage) => void) | undefined;
			calls.rows.mockImplementation(async (asked: { after?: readonly unknown[] }) => {
				if (!asked.after) {
					return repairs(
						[
							[1, "Bike 1", 100, true],
							[2, "Bike 2", 200, false],
						],
						true,
					);
				}
				const cursor = Number(asked.after[0]);
				if (cursor === 999) {
					return new Promise<CloudMemberDataPage>((resolve) => {
						pendingMoreResolve = resolve;
					});
				}
				const nextId = cursor + 1;
				return repairs([[nextId, `Bike ${nextId}`, nextId * 100, true]], cursor >= 1000 ? true : nextId < 8);
			});

			const controller = company(describedWith(), true);
			const databases = new CompanyDatabases(
				() => calls,
				(next) => controller.store.set({ companyData: next }),
				controller.signal,
			);
			const container = document.createElement("main");
			document.body.append(container);
			const draw = () => renderData(container, controller, databases);
			draw();
			toList(container);
			cleanup.push(controller.store.subscribe(draw));
			await vi.advanceTimersByTimeAsync(0);

			const initialRows = [...container.querySelectorAll<HTMLElement>("button.data-row")];
			expect(initialRows).toHaveLength(2);

			button(container, "Show more").click();
			await vi.advanceTimersByTimeAsync(0);
			const afterFirstMore = [...container.querySelectorAll<HTMLElement>("button.data-row")];
			expect(afterFirstMore).toHaveLength(3);
			expect(afterFirstMore[0]).toBe(initialRows[0]);
			expect(afterFirstMore[1]).toBe(initialRows[1]);

			for (let i = 0; i < 4; i += 1) {
				button(container, "Show more").click();
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(container.querySelectorAll("button.data-row")).toHaveLength(7);

			calls.rows.mockClear();
			const firstWatch = watchResolves.shift();
			firstWatch?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs(
								[
									[1, "Bike 1 Updated", 150, true],
									[999, "Bike 999", 999, false],
								],
								true,
							),
							etag: "fedcba9876543210fedcba9876543210",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(1);
			pendingMoreResolve?.(repairs([[1000, "Bike 1000", 1000, true]], true));
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(5);
			expect(container.querySelectorAll("button.data-row")).toHaveLength(7);
			expect(texts(container, "button.data-row .is-lead")).toContain("Bike 1004");
			expect(container.querySelector(".data-more-rows")).toBeNull();

			await vi.advanceTimersByTimeAsync(500);
			const secondWatch = watchResolves.shift();
			expect(secondWatch).toBeDefined();

			calls.rows.mockImplementationOnce(
				() =>
					new Promise<CloudMemberDataPage>((resolve) => {
						pendingMoreResolve = resolve;
					}),
			);
			button(container, "Show more").click();
			expect(container.querySelector(".data-more-rows")).not.toBeNull();
			secondWatch?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[1, "Live Replace", 111, true]], true),
							etag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(container.querySelector(".data-more-rows")).toBeNull();
			expect(button(container, "Show more")).toBeTruthy();
			pendingMoreResolve?.(repairs([[50, "Stale page", 500, true]], false));
			await vi.advanceTimersByTimeAsync(0);
			expect(container.querySelector(".data-more-rows")).toBeNull();
			expect(texts(container, "button.data-row .is-lead")).not.toContain("Stale page");

			shownValue(10, "number");
			shownValue("2026-11-09", "date");
			shownValue("2026-11-09T10:30:00Z", "time");
			const numSpy = vi.spyOn(Intl, "NumberFormat");
			const dateSpy = vi.spyOn(Intl, "DateTimeFormat");
			shownValue(42.5, "number");
			shownValue(99.1, "number");
			shownValue("2026-11-10", "date");
			shownValue("2026-11-10T11:45:00Z", "time");
			expect(numSpy).not.toHaveBeenCalled();
			expect(dateSpy).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reconnects IntersectionObserver to the reused sentinel across incremental appends and failure retries", async () => {
		const observed: Element[] = [];
		let activeCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
		let disconnects = 0;
		class FakeIntersectionObserver {
			readonly #cb: (entries: Array<{ isIntersecting: boolean }>) => void;
			constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
				this.#cb = cb;
			}
			observe(el: Element): void {
				observed.push(el);
				activeCallback = this.#cb;
			}
			disconnect(): void {
				disconnects += 1;
				if (activeCallback === this.#cb) activeCallback = undefined;
			}
		}
		vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
		try {
			const { calls } = fakeCalls(describedWith());
			calls.watchTables.mockImplementation(() => new Promise(() => {}));
			calls.rows
				.mockResolvedValueOnce(
					repairs(
						[
							[1, "Bike 1", 100, true],
							[2, "Bike 2", 200, false],
						],
						true,
					),
				)
				.mockResolvedValueOnce(repairs([[3, "Bike 3", 300, true]], true))
				.mockRejectedValueOnce(new Error("temporary"))
				.mockResolvedValueOnce(repairs([[4, "Bike 4", 400, true]], true))
				.mockResolvedValueOnce(repairs([[5, "Bike 5", 500, true]], false));

			const controller = company(describedWith(), true);
			const databases = new CompanyDatabases(
				() => calls,
				(next) => controller.store.set({ companyData: next }),
				controller.signal,
			);
			const container = document.createElement("main");
			document.body.append(container);
			const draw = () => renderData(container, controller, databases);
			draw();
			toList(container);
			cleanup.push(controller.store.subscribe(draw));
			await settle();

			const initialRows = [...container.querySelectorAll<HTMLElement>("button.data-row")];
			const sentinel = container.querySelector<HTMLElement>(".data-more")!;
			expect(sentinel).not.toBeNull();
			expect(sentinel.querySelector("button")).toBeNull();
			expect(observed.at(-1)).toBe(sentinel);
			observed.length = 0;

			activeCallback?.([{ isIntersecting: true }]);
			await settle();
			const afterAppend = [...container.querySelectorAll<HTMLElement>("button.data-row")];
			expect(afterAppend).toHaveLength(3);
			expect(afterAppend[0]).toBe(initialRows[0]);
			expect(afterAppend[1]).toBe(initialRows[1]);
			expect(container.querySelector(".data-more")).toBe(sentinel);
			expect(observed).toEqual([sentinel]);

			activeCallback?.([{ isIntersecting: true }]);
			await settle();
			expect(button(container, "Try again")).toBeTruthy();
			expect(activeCallback).toBeUndefined();
			expect(observed).toEqual([sentinel]);

			button(container, "Try again").click();
			await settle();
			expect(container.querySelectorAll("button.data-row")).toHaveLength(4);
			expect(container.querySelector(".data-more")).toBe(sentinel);
			expect(observed).toEqual([sentinel, sentinel]);
			expect(activeCallback).toBeDefined();

			activeCallback?.([{ isIntersecting: true }]);
			await settle();
			expect(container.querySelectorAll("button.data-row")).toHaveLength(5);
			expect(container.querySelector(".data-more")).toBeNull();
			expect(disconnects).toBeGreaterThanOrEqual(4);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("caps watch multi-page refetches, stops on repeated cursors, and aborts in-flight #again fetches when hidden", async () => {
		vi.useFakeTimers();
		const originalVis = Object.getOwnPropertyDescriptor(document, "visibilityState");
		let vis: DocumentVisibilityState = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => vis,
		});
		try {
			const { calls } = fakeCalls(describedWith());
			const watchResolves: Array<(answer: Awaited<ReturnType<CompanyDataCalls["watchTables"]>>) => void> = [];
			calls.watchTables.mockImplementation(
				() =>
					new Promise<Awaited<ReturnType<CompanyDataCalls["watchTables"]>>>((resolve) => {
						watchResolves.push(resolve);
					}),
			);
			calls.rows.mockImplementation(async (asked) => {
				const n = asked.after ? Number(asked.after[0]) + 1 : 1;
				return {
					...repairs([[n, `Bike ${n}`, n * 10, true]], true),
					next: [String(n)],
				};
			});

			const controller = company(describedWith(), true);
			const databases = new CompanyDatabases(
				() => calls,
				(next) => controller.store.set({ companyData: next }),
				controller.signal,
			);
			const container = document.createElement("main");
			document.body.append(container);
			const draw = () => renderData(container, controller, databases);
			draw();
			toList(container);
			cleanup.push(controller.store.subscribe(draw));
			await vi.advanceTimersByTimeAsync(0);

			for (let i = 0; i < 12; i++) {
				button(container, "Show more").click();
				await vi.advanceTimersByTimeAsync(0);
			}
			expect(container.querySelectorAll("button.data-row")).toHaveLength(13);

			calls.rows.mockClear();
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[1, "Bike 1 Updated", 15, true]], true),
							next: ["1"],
							etag: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(9);
			expect(container.querySelectorAll("button.data-row")).toHaveLength(13);
			expect(texts(container, "button.data-row .is-lead")).toContain("Bike 1 Updated");
			expect(texts(container, "button.data-row .is-lead")).toContain("Bike 13");

			await vi.advanceTimersByTimeAsync(500);
			calls.rows.mockClear();
			calls.rows.mockImplementation(async (asked) => {
				const prev = asked.after ? Number(asked.after[0]) : 0;
				const n = prev === 13 ? 1 : prev + 1;
				return {
					...repairs([[n, `Bike ${n}`, n * 10, true]], true),
					next: [String(n)],
				};
			});
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[13, "Bike 13 Promoted", 130, true]], true),
							next: ["13"],
							etag: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(9);
			expect(container.querySelectorAll("button.data-row")).toHaveLength(13);
			const promotedLeads = texts(container, "button.data-row .is-lead");
			expect(promotedLeads[0]).toBe("Bike 13 Promoted");
			expect(promotedLeads).toContain("Bike 10");
			expect(promotedLeads).toContain("Bike 11");
			expect(promotedLeads).toContain("Bike 12");

			await vi.advanceTimersByTimeAsync(500);
			calls.rows.mockClear();
			calls.rows.mockImplementation(async (asked) => {
				const after = asked.after?.[0];
				if (after === "edge-10") {
					return {
						...repairs(
							[
								[10, "Bike 10", 100, true],
								[11, "Bike 11", 110, true],
								[12, "Bike 12", 120, true],
							],
							false,
						),
					};
				}
				const n = after ? Number(after) + 1 : 2;
				if (n === 10) {
					return {
						...repairs([[13, "Bike 13 At Edge", 135, true]], true),
						next: ["edge-10"],
					};
				}
				return {
					...repairs([[n, `Bike ${n}`, n * 10, true]], true),
					next: [String(n)],
				};
			});
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[1, "Bike 1", 10, true]], true),
							next: ["1"],
							etag: "ffffffffffffffffffffffffffffffff",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(9);
			expect(container.querySelectorAll("button.data-row")).toHaveLength(10);
			button(container, "Show more").click();
			await vi.advanceTimersByTimeAsync(0);
			const recoveredLeads = texts(container, "button.data-row .is-lead");
			expect(recoveredLeads).toContain("Bike 13 At Edge");
			expect(recoveredLeads).toContain("Bike 10");
			expect(recoveredLeads).toContain("Bike 11");
			expect(recoveredLeads).toContain("Bike 12");

			await vi.advanceTimersByTimeAsync(500);
			calls.rows.mockClear();
			calls.rows.mockImplementation(async (asked) => {
				const after = asked.after?.[0];
				if (after === "11") {
					return {
						...repairs(
							[
								[1, "Bike 1 Demoted", 125, true],
								[12, "Bike 12", 120, true],
							],
							false,
						),
					};
				}
				const n = after ? Number(after) + 1 : 3;
				return {
					...repairs([[n, `Bike ${n}`, n * 10, true]], true),
					next: [String(n)],
				};
			});
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[2, "Bike 2", 20, true]], true),
							next: ["2"],
							etag: "abababababababababababababababab",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(9);
			expect(container.querySelectorAll("button.data-row")).toHaveLength(10);
			button(container, "Show more").click();
			await vi.advanceTimersByTimeAsync(0);
			expect(texts(container, "button.data-row .is-lead")).toContain("Bike 1 Demoted");

			await vi.advanceTimersByTimeAsync(500);
			calls.rows.mockClear();
			calls.rows.mockImplementation(async () => ({
				...repairs([[2, "Bike 2 Loop", 20, true]], true),
				next: ["1"],
			}));
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[1, "Bike 1 Loop", 15, true]], true),
							next: ["1"],
							etag: "dddddddddddddddddddddddddddddddd",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.rows).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(500);
			let againSignal: AbortSignal | undefined;
			calls.rows.mockImplementationOnce(
				(_asked, signal) =>
					new Promise<CloudMemberDataPage>((_resolve, reject) => {
						againSignal = signal;
						signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
							once: true,
						});
					}),
			);
			watchResolves.shift()?.({
				changed: [
					{
						index: 0,
						answer: {
							...repairs([[200, "Fresh 200", 200, true]], true),
							next: ["200"],
							etag: "cccccccccccccccccccccccccccccccc",
						},
					},
				],
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(againSignal).toBeDefined();
			expect(againSignal?.aborted).toBe(false);

			vis = "hidden";
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(0);
			expect(againSignal?.aborted).toBe(true);
			expect(texts(container, "button.data-row .is-lead")).not.toContain("Fresh 200");
		} finally {
			if (originalVis) Object.defineProperty(document, "visibilityState", originalVis);
			else delete (document as unknown as Record<string, unknown>).visibilityState;
			vi.useRealTimers();
		}
	});
});
