import type { CloudMemberDataPage, CloudMemberDataTable } from "@qorpera/cloud-client/cloud-member-data";
import { describe, expect, it, vi } from "vitest";
import type { CompanyDataCalls } from "../src/app/company-data.ts";
import { type DataLink, DataLinked, tableLinks } from "../src/app/views/data-links.ts";

const column = (name: string, type = "text") => ({ name, type, settable: true });
const table = (name: string, columns: string[], references?: CloudMemberDataTable["references"]) =>
	({
		name,
		kind: "table",
		key: ["id"],
		columns: columns.map((one) => column(one)),
		...(references ? { references } : {}),
	}) satisfies CloudMemberDataTable;

const link: DataLink = { column: "customer_id", table: "customers", to: "id" };
const page = (rows: unknown[][], more = false): CloudMemberDataPage => ({
	columns: ["id", "name"],
	key: ["id"],
	rows: rows.map((values, index) => ({ values, seen: `s${index}` })),
	more,
	etag: "0123456789abcdef0123456789abcdef",
	asOf: "2026-11-25T10:00:00.000Z",
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function linked(rows: (asked: { at?: Record<string, unknown> }) => Promise<CloudMemberDataPage>) {
	const read = vi.fn(rows);
	const arrived = vi.fn();
	const calls = { rows: read } as unknown as CompanyDataCalls;
	return { read, arrived, rows: new DataLinked(() => calls, new AbortController().signal, arrived) };
}

describe("where a table's columns point (app/views/data-links.ts)", () => {
	it("links a column by a one-column reference into a table of the database that has the column", () => {
		const customers = table("customers", ["id", "name"]);
		const orders = table(
			"orders",
			["id", "customer_id", "a", "b", "elsewhere", "ghost"],
			[
				{ columns: ["customer_id"], table: "customers", to: ["id"] },
				{ columns: ["customer_id"], table: "customers", to: ["name"] },
				{ columns: ["a", "b"], table: "customers", to: ["id", "name"] },
				{ columns: ["elsewhere"], table: "missing", to: ["id"] },
				{ columns: ["ghost"], table: "customers", to: ["nope"] },
			],
		);
		expect([...tableLinks(orders, [orders, customers])]).toEqual([["customer_id", link]]);
		expect(tableLinks(customers, [orders, customers]).size).toBe(0);
		expect(tableLinks(undefined, []).size).toBe(0);
	});
});

describe("the rows a list points at (app/views/data-links.ts)", () => {
	it("reads the values a page needs once, together, and says when they are there", async () => {
		const { read, arrived, rows } = linked(async () => page([["a", "Ann"]]));
		rows.want("shop", link, ["a", "b", "a", null, { odd: 1 }]);
		rows.want("shop", link, ["a", "b"]);
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith(
			{ database: "shop", table: "customers", at: { id: ["a", "b"] }, limit: 200 },
			expect.anything(),
		);
		expect(arrived).toHaveBeenCalledTimes(1);
		expect(rows.row("shop", link, "a")?.values).toEqual(["a", "Ann"]);
		expect(rows.row("shop", link, "b")).toBeUndefined();
		rows.want("shop", link, ["a", "b"]);
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("asks again for what a failed read or a page cut short left out, and not for what the store refused", async () => {
		let fail: unknown = new Error("offline");
		const failing = linked(async () => {
			if (fail) throw fail;
			return page([["a", "Ann"]]);
		});
		failing.rows.want("shop", link, ["a"]);
		await settle();
		expect(failing.rows.row("shop", link, "a")).toBeUndefined();
		fail = undefined;
		failing.rows.want("shop", link, ["a"]);
		await settle();
		expect(failing.read).toHaveBeenCalledTimes(2);
		expect(failing.rows.row("shop", link, "a")?.values).toEqual(["a", "Ann"]);

		const cut = linked(async (asked) =>
			(asked.at?.id as string[]).includes("a") ? page([["a", "Ann"]], true) : page([["b", "Bea"]]),
		);
		cut.rows.want("shop", link, ["a", "b"]);
		await settle();
		cut.rows.want("shop", link, ["a", "b"]);
		await settle();
		expect(cut.read).toHaveBeenLastCalledWith(
			{ database: "shop", table: "customers", at: { id: ["b"] }, limit: 200 },
			expect.anything(),
		);
		expect(cut.rows.row("shop", link, "b")?.values).toEqual(["b", "Bea"]);

		const refused = linked(async () => {
			throw Object.assign(new Error("no"), { status: 403 });
		});
		refused.rows.want("shop", link, ["a"]);
		await settle();
		refused.rows.want("shop", link, ["a"]);
		await settle();
		expect(refused.read).toHaveBeenCalledTimes(1);
	});

	it("reads a table's rows again once they are dropped, and only that table's", async () => {
		const { read, rows } = linked(async () => page([["a", "Ann"]]));
		const other: DataLink = { column: "seller_id", table: "sellers", to: "id" };
		rows.want("shop", link, ["a"]);
		rows.want("shop", other, ["a"]);
		await settle();
		rows.drop("shop", "customers");
		expect(rows.row("shop", link, "a")).toBeUndefined();
		expect(rows.row("shop", other, "a")).toBeDefined();
		rows.want("shop", link, ["a"]);
		rows.want("shop", other, ["a"]);
		await settle();
		expect(read).toHaveBeenCalledTimes(3);
	});
});
