import { describe, expect, it } from "vitest";
import {
	APP_GROUPS_MAX_BYTES,
	appGroupName,
	appGroupSlug,
	appGroupsGroups,
	isAppDrawerKey,
	parseAppGroups,
	resolveAppGroups,
	writeAppGroups,
} from "../src/app-groups.ts";
import { appPath } from "../src/interface-apps.ts";

const SPEC = `# Apps
The company's apps in the drawer, kept by its agents with organize_apps.

- page:mailbox Mailbox
- page:bank Bank
- app:company-finances Company finances
- group trips: Fjeldtur Trips
  - app:trip-planner Trip planner
  - app:travel-supply Travel supply
  - concepts Concepts
  - group routes: Routes
    - app:route-jotunheimen Jotunheimen
    - app:route-lofoten Lofoten
  - app:guide-roster Guide roster
- group market: Market
  - app:fjeldtur-brand Fjeldtur brand
`;

/** The list as keys and groups, without the words. */
type Shape = string | [string, string, Shape[]];
const shape = (items: ReturnType<typeof parseAppGroups>["items"]): Shape[] =>
	items.map((node) => (node.kind === "group" ? [node.id, node.name, shape(node.items)] : node.key));

describe("apps/groups.md", () => {
	it("reads the spec's example and writes it back byte for byte", () => {
		const file = parseAppGroups(SPEC);
		expect(file.head).toEqual(["# Apps", "The company's apps in the drawer, kept by its agents with organize_apps."]);
		expect(shape(file.items)).toEqual([
			"page:mailbox",
			"page:bank",
			"app:company-finances",
			[
				"trips",
				"Fjeldtur Trips",
				[
					"app:trip-planner",
					"app:travel-supply",
					"concepts",
					["routes", "Routes", ["app:route-jotunheimen", "app:route-lofoten"]],
					"app:guide-roster",
				],
			],
			["market", "Market", ["app:fjeldtur-brand"]],
		]);
		expect(file.items[0]).toEqual({ kind: "item", key: "page:mailbox", words: "Mailbox" });
		expect(file.notes).toEqual([]);
		expect(file.retired).toEqual([]);
		expect(writeAppGroups(file)).toBe(SPEC);
		expect(
			appGroupsGroups(file.items).map(({ group, parent, level }) => [group.id, parent?.id ?? null, level]),
		).toEqual([
			["trips", null, 0],
			["routes", "trips", 1],
			["market", null, 0],
		]);
	});

	it("reads a deeper line at its nearest allowed level: a group never goes past the second", () => {
		const file = parseAppGroups(`- group a: A
  - group b: B
    - group c: C
      - app:one
        - app:two
    - app:three
- app:four
      - app:five
`);
		// c is read beside b, its items in it; five, under a loose item, is read at the top.
		expect(shape(file.items)).toEqual([
			[
				"a",
				"A",
				[
					["b", "B", []],
					["c", "C", ["app:one", "app:two", "app:three"]],
				],
			],
			"app:four",
			"app:five",
		]);
		const again = parseAppGroups(writeAppGroups(file));
		expect(shape(again.items)).toEqual(shape(file.items));
		expect(writeAppGroups(again)).toBe(writeAppGroups(file));
	});

	it("lets the first line of a key or a group id win", () => {
		const file = parseAppGroups(`- group a: A
  - app:one first
- app:one again
- group a: A again
  - app:two
`);
		// The second group a is not read: its items stand where it stood.
		expect(shape(file.items)).toEqual([["a", "A", ["app:one"]], "app:two"]);
		expect(file.items[0]?.kind === "group" && file.items[0].items[0]).toEqual({
			kind: "item",
			key: "app:one",
			words: "first",
		});
	});

	it("keeps notes, odd lines and keys no drawer has, and reads tabs as two spaces", () => {
		const text = `# Apps

Our note before the list.
- page:mailbox
- group trips: Trips
\t- app:one
  - app:Not-A-Name odd words
  - group Bad Id: kept as a line
- 1. not a key
Some note between.
* app:two

A closing note.
`;
		const file = parseAppGroups(text);
		expect(file.head).toEqual(["# Apps", "", "Our note before the list."]);
		expect(file.notes).toEqual(["Some note between.", "", "A closing note."]);
		expect(shape(file.items)).toEqual([
			"page:mailbox",
			["trips", "Trips", ["app:one", "app:Not-A-Name", "group"]],
			"1.",
			"app:two",
		]);
		const written = writeAppGroups(file);
		expect(written).toBe(`# Apps

Our note before the list.

- page:mailbox
- group trips: Trips
  - app:one
  - app:Not-A-Name odd words
  - group Bad Id: kept as a line
- 1. not a key
- app:two

Some note between.

A closing note.
`);
		expect(writeAppGroups(parseAppGroups(written))).toBe(written);
	});

	it("keeps the ids of groups that are gone in one note, and never reads a group's own id as retired", () => {
		const file = parseAppGroups(`- group a: A
  - app:one

<!-- retired group ids: old, a, Bad, older -->
`);
		expect(file.retired).toEqual(["old", "older"]);
		expect(file.notes).toEqual([]);
		const written = writeAppGroups({ ...file, retired: [...file.retired, "b"] });
		expect(written).toBe(`- group a: A
  - app:one

<!-- retired group ids: old, older, b -->
`);
		expect(parseAppGroups(written).retired).toEqual(["old", "older", "b"]);
	});

	it("takes the first 64 KiB and ignores the rest, and an empty file is an empty list", () => {
		const line = "- app:one\n";
		const text = `${line}${"x".repeat(APP_GROUPS_MAX_BYTES)}\n- app:two\n`;
		expect(shape(parseAppGroups(text).items)).toEqual(["app:one"]);
		expect(parseAppGroups("")).toEqual({ head: [], items: [], notes: [], retired: [] });
		expect(writeAppGroups(parseAppGroups(""))).toBe("");
		expect(shape(parseAppGroups("- app:one\r\n- app:two\r\n").items)).toEqual(["app:one", "app:two"]);
	});

	it("reads a line or paragraph separator in an item's words, and writes it as a space", () => {
		const file = parseAppGroups("- group g: G\n  - app:sales Sales\u2028Dash\u2029board\n");
		expect(file.items).toEqual([
			{
				kind: "group",
				id: "g",
				name: "G",
				items: [{ kind: "item", key: "app:sales", words: "Sales\u2028Dash\u2029board" }],
			},
		]);
		const written = writeAppGroups(file);
		expect(written).toBe("- group g: G\n  - app:sales Sales Dash board\n");
		expect(writeAppGroups(parseAppGroups(written))).toBe(written);
		expect(appGroupName("Sales\u2028Dash")).toBeNull();
		// A line that names no drawer key is written as it was read: a group whose name breaks is no group, and stays so.
		const odd = "- group g: G\u2028X\n- note a\rb\n<!-- retired group ids: g -->\n";
		const oddFile = parseAppGroups(odd);
		expect(oddFile.items).toEqual([
			{ kind: "item", key: "group", words: "g: G\u2028X" },
			{ kind: "item", key: "note", words: "a\rb" },
		]);
		expect(oddFile.retired).toEqual(["g"]);
		expect(writeAppGroups(oddFile)).toBe("- group g: G\u2028X\n- note a\rb\n\n<!-- retired group ids: g -->\n");
		expect(parseAppGroups(writeAppGroups(oddFile))).toEqual(oddFile);
		// A break at either end of such a line's words is kept too, so it never turns into a group.
		const ends = "- group g: G\u2028\n- group \u2028h: H\n<!-- retired group ids: g, h -->\n";
		const endsFile = parseAppGroups(ends);
		expect(endsFile.items).toEqual([
			{ kind: "item", key: "group", words: "g: G\u2028" },
			{ kind: "item", key: "group", words: "\u2028h: H" },
		]);
		expect(writeAppGroups(endsFile)).toBe(
			"- group g: G\u2028\n- group \u2028h: H\n\n<!-- retired group ids: g, h -->\n",
		);
		expect(parseAppGroups(writeAppGroups(endsFile))).toEqual(endsFile);
		// Carriage returns at a line's end, however many and with spaces between, are no part of its words or key.
		const returns =
			"- group g: G\r \n- app:sales\r\r\n- group s: Sales\n  - app:sales\n<!-- retired group ids: g -->\n";
		const returnsFile = parseAppGroups(returns);
		expect(returnsFile.items).toEqual([
			{ kind: "group", id: "g", name: "G", items: [] },
			{ kind: "item", key: "app:sales", words: "" },
			{ kind: "group", id: "s", name: "Sales", items: [] },
		]);
		expect(returnsFile.retired).toEqual([]);
		expect(parseAppGroups(writeAppGroups(returnsFile))).toEqual(returnsFile);
	});

	it("is not an app of the drawer", () => {
		expect(appPath("apps/groups.md")).toBeNull();
	});
});

describe("keys, names and ids", () => {
	it("knows the drawer's keys", () => {
		for (const key of ["page:mailbox", "page:members", "page:bank", "app:sales-board", "concepts", "sites"])
			expect(isAppDrawerKey(key)).toBe(true);
		for (const key of ["page:pulse", "app:", "app:Sales", "app:a--b", "group:trips", "mailbox", "Concepts"])
			expect(isAppDrawerKey(key)).toBe(false);
	});

	it("takes a group's name as one line of 1 to 40 characters", () => {
		expect(appGroupName("  Fjeldtur   Trips ")).toBe("Fjeldtur Trips");
		expect(appGroupName("x".repeat(40))).toBe("x".repeat(40));
		expect(appGroupName("x".repeat(41))).toBeNull();
		expect(appGroupName("   ")).toBeNull();
		expect(appGroupName("a\nb")).toBeNull();
	});

	it("makes a group's id from its name, never one taken or retired", () => {
		expect(appGroupSlug("Fjeldtur Trips", new Set())).toBe("fjeldtur-trips");
		expect(appGroupSlug("Kunder & Ærøskøbing", new Set())).toBe("kunder-aeroeskoebing");
		expect(appGroupSlug("Café", new Set())).toBe("cafe");
		expect(appGroupSlug("!!!", new Set())).toBe("group");
		expect(appGroupSlug("Trips", new Set(["trips", "trips-2"]))).toBe("trips-3");
		// Cut to 40, never ending in a hyphen.
		expect(appGroupSlug(`${"a".repeat(39)} b`, new Set())).toBe("a".repeat(39));
		const taken = appGroupSlug("a".repeat(45), new Set(["a".repeat(40)]));
		expect(taken).toBe(`${"a".repeat(38)}-2`);
		expect(taken.length).toBeLessThanOrEqual(40);
	});
});

describe("what the drawer draws", () => {
	it("draws the listed keys the company has, leaves out groups with nothing, and puts the rest loose at the end", () => {
		const file = parseAppGroups(`- page:bank
- group trips: Trips
  - app:gone
  - group routes: Routes
    - app:gone-too
  - app:planner
- group empty: Empty
- sites
- app:Odd
`);
		const drawn = resolveAppGroups(file, ["page:mailbox", "page:bank", "app:planner", "app:zebra", "concepts"]);
		expect(drawn.items).toEqual([
			{ kind: "item", key: "page:bank" },
			{ kind: "group", id: "trips", name: "Trips", items: [{ kind: "item", key: "app:planner" }] },
			{ kind: "item", key: "page:mailbox" },
			{ kind: "item", key: "app:zebra" },
			{ kind: "item", key: "concepts" },
		]);
		expect(drawn.missing).toEqual(["app:gone", "app:gone-too", "sites"]);
	});
});
