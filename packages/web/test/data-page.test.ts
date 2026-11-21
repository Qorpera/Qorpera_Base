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
		rows: vi.fn(async (asked: { table: string; after?: readonly unknown[] }): Promise<CloudMemberDataPage> => {
			if (asked.table === "open_repairs")
				return { columns: ["bike"], key: [], rows: [{ values: ["Trek"], seen: seen(9) }], more: true, etag, asOf };
			if (asked.table === "notes") return { columns: ["note"], key: [], rows: [], more: false, etag, asOf };
			if (asked.after) return repairs([[3, "Raleigh Tourist", 520, false]]);
			return repairs(
				[
					[1, "Gazelle Orange C7", 450, true],
					[2, "Batavus Finez", 350, false],
				],
				true,
			);
		}),
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
			(_watches: unknown, signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) =>
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

async function open(described: CloudMemberDataDescription, write = true) {
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
	return { container, calls, edits, controller };
}

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

describe("the list (app/views/data.ts)", () => {
	it("shows a table's rows under tabs for its tables and its kept questions", async () => {
		const { container, calls } = await open(describedWith());
		expect(texts(container, ".data-tab")).toEqual([
			"Repairs",
			"Open repairs",
			"Notes",
			"Waited over a week",
			"Since",
		]);
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

		button(container, "Waited over a week").click();
		await settle();
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
});
