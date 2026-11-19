import { describe, expect, it } from "vitest";
import {
	type AppTreeNode,
	appColours,
	arrangeApps,
	arrangeAppsFully,
	colourApp,
	EMPTY_APP_LAYOUT,
	emblemApp,
	flattenApps,
	type MemberAppLayout,
	makeAppGroup,
	parseAppGroups,
	parseMemberAppLayout,
	placeApp,
	renameAppGroup,
	suggestGroupName,
	ungroupApps,
	withoutRefused,
} from "../src/cloud/app-groups.ts";

const FILE = `# Apps
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
      - group too-deep: Never three levels
        - app:route-rondane Rondane
  - app:guide-roster Guide roster
- group market: Market
  - app:fjeldtur-brand Fjeldtur brand
  - app:fjeldtur-brand A second time
  - agent:nobody Not a key
`;

const present = [
	"page:mailbox",
	"page:bank",
	"app:company-finances",
	"app:trip-planner",
	"app:travel-supply",
	"concepts",
	"app:route-jotunheimen",
	"app:route-lofoten",
	"app:route-rondane",
	"app:guide-roster",
	"app:fjeldtur-brand",
	"app:business-plan",
];

/** A tree as nested key lists, groups as `group:<id> <name>` followed by their insides. */
function shape(tree: readonly AppTreeNode[]): unknown[] {
	return tree.map((node) =>
		node.kind === "item" ? node.key : [`group:${node.id} ${node.name}`, ...shape(node.items)],
	);
}
const layout = (places: MemberAppLayout["places"] = {}, groups: MemberAppLayout["groups"] = {}): MemberAppLayout => ({
	...EMPTY_APP_LAYOUT,
	places,
	groups,
});

describe("apps/groups.md", () => {
	it("reads groups two levels deep, a deeper one at the nearest allowed level, each key once", () => {
		expect(shape(parseAppGroups(FILE))).toEqual([
			"page:mailbox",
			"page:bank",
			"app:company-finances",
			[
				"group:trips Fjeldtur Trips",
				"app:trip-planner",
				"app:travel-supply",
				"concepts",
				["group:routes Routes", "app:route-jotunheimen", "app:route-lofoten"],
				["group:too-deep Never three levels", "app:route-rondane"],
				"app:guide-roster",
			],
			["group:market Market", "app:fjeldtur-brand"],
		]);
		expect(parseAppGroups("no list here\n  - \n")).toEqual([]);
	});
});

describe("the member's own arrangement", () => {
	const company = parseAppGroups(FILE);

	it("draws the company's groups, leaves out what the drawer lacks, and puts what nothing names at the end", () => {
		const tree = arrangeApps(company, EMPTY_APP_LAYOUT, ["page:mailbox", "app:fjeldtur-brand", "app:new-one"]);
		expect(shape(tree)).toEqual(["page:mailbox", ["group:market Market", "app:fjeldtur-brand"], "app:new-one"]);
	});

	it("lays the member's renames, ungrouped groups, own groups and places over the company's", () => {
		const tree = arrangeApps(
			company,
			layout(
				{
					"group:m-1": { group: null, after: "page:bank" },
					"app:fjeldtur-brand": { group: "m-1", first: true },
					"app:business-plan": { group: "m-1", after: "app:fjeldtur-brand" },
				},
				{ "m-1": { mine: { name: "Daily" } }, routes: { name: "Hikes" }, trips: { removed: true } },
			),
			present,
		);
		expect(shape(tree)).toEqual([
			"page:mailbox",
			"page:bank",
			["group:m-1 Daily", "app:fjeldtur-brand", "app:business-plan"],
			"app:company-finances",
			"app:trip-planner",
			"app:travel-supply",
			"concepts",
			["group:routes Hikes", "app:route-jotunheimen", "app:route-lofoten"],
			["group:too-deep Never three levels", "app:route-rondane"],
			"app:guide-roster",
		]);
	});

	it("never puts a group three levels deep, nor into itself", () => {
		const tree = arrangeApps(
			company,
			layout({ "group:trips": { group: "routes", first: true }, "group:market": { group: "market", first: true } }),
			present,
		);
		expect(
			shape(tree)
				.filter((node) => Array.isArray(node))
				.map((node) => (node as string[])[0]),
		).toEqual(["group:trips Fjeldtur Trips", "group:market Market"]);
	});

	it("opens groups into the grid, their tiles right after the group", () => {
		const tiles = flattenApps(arrangeApps(company, EMPTY_APP_LAYOUT, present), new Set(["trips", "routes"]));
		expect(tiles.map((tile) => `${tile.key}${tile.open ? "+" : ""}@${tile.chain.join("/")}`)).toEqual([
			"page:mailbox@",
			"page:bank@",
			"app:company-finances@",
			"group:trips+@",
			"app:trip-planner@trips",
			"app:travel-supply@trips",
			"concepts@trips",
			"group:routes+@trips",
			"app:route-jotunheimen@trips/routes",
			"app:route-lofoten@trips/routes",
			"group:too-deep@trips",
			"app:guide-roster@trips",
			"group:market@",
			"app:business-plan@",
		]);
	});

	it("moves an app, and what the member placed after it keeps its place after what stood before it", () => {
		const tree = arrangeApps(company, EMPTY_APP_LAYOUT, present);
		let mine = placeApp(EMPTY_APP_LAYOUT, tree, "app:business-plan", null, "page:mailbox");
		mine = placeApp(mine, arrangeApps(company, mine, present), "app:fjeldtur-brand", null, "app:business-plan");
		expect(shape(arrangeApps(company, mine, present)).slice(0, 4)).toEqual([
			"page:mailbox",
			"app:business-plan",
			"app:fjeldtur-brand",
			"page:bank",
		]);
		mine = placeApp(mine, arrangeApps(company, mine, present), "app:business-plan", "market", null);
		expect(shape(arrangeApps(company, mine, present)).slice(0, 3)).toEqual([
			"page:mailbox",
			"app:fjeldtur-brand",
			"page:bank",
		]);
	});

	it("makes a group of two apps where the first stood, renames it, and takes it apart again", () => {
		const tree = arrangeApps(company, EMPTY_APP_LAYOUT, present);
		let mine = makeAppGroup(EMPTY_APP_LAYOUT, tree, "app:company-finances", "page:bank", "Money", "m-2");
		expect(shape(arrangeApps(company, mine, present)).slice(0, 3)).toEqual([
			"page:mailbox",
			["group:m-2 Money", "page:bank", "app:company-finances"],
			[
				"group:trips Fjeldtur Trips",
				"app:trip-planner",
				"app:travel-supply",
				"concepts",
				expect.anything(),
				expect.anything(),
				"app:guide-roster",
			],
		]);
		mine = renameAppGroup(mine, "m-2", "Finance", undefined);
		expect(mine.groups["m-2"]).toEqual({ mine: { name: "Finance" } });
		mine = ungroupApps(mine, arrangeApps(company, mine, present), "m-2");
		expect(mine.groups["m-2"]).toBeUndefined();
		expect(shape(arrangeApps(company, mine, present)).slice(0, 3)).toEqual([
			"page:mailbox",
			"page:bank",
			"app:company-finances",
		]);
	});

	it("keeps nothing of the member's when a company group is renamed back, and marks one taken apart", () => {
		let mine = renameAppGroup(EMPTY_APP_LAYOUT, "market", "Sales", "Market");
		expect(mine.groups).toEqual({ market: { name: "Sales" } });
		mine = renameAppGroup(mine, "market", "Market", "Market");
		expect(mine.groups).toEqual({});
		mine = ungroupApps(mine, arrangeApps(company, mine, present), "market");
		expect(mine.groups).toEqual({ market: { removed: true } });
		expect(shape(arrangeApps(company, mine, present)).slice(-2)).toEqual(["app:fjeldtur-brand", "app:business-plan"]);
	});

	it("reads only the shape the cloud keeps, and suggests a name from the first word two apps share", () => {
		expect(parseMemberAppLayout({ schema: "other" })).toEqual(EMPTY_APP_LAYOUT);
		expect(
			parseMemberAppLayout({
				schema: "qorpera.member-app-layout/v1",
				places: { "app:a": { group: "g", after: null }, "agent:x": {}, "group:BAD": {} },
				groups: { g: { mine: { name: "G" } }, "Bad Id": { name: "x" }, e: {} },
			}),
		).toEqual({
			schema: "qorpera.member-app-layout/v1",
			places: { "app:a": { group: "g", after: null, at: 0 } },
			groups: { g: { mine: { name: "G" } } },
		});
		expect(suggestGroupName("Fjeldtur brand", "fjeldtur business plan", "Group")).toBe("Fjeldtur");
		expect(suggestGroupName("Mailbox", "Bank", "Group")).toBe("Group");
	});
	it("keeps the member's order however the cloud orders a document's keys (review F1 on #1678)", () => {
		const keys = ["app:a", "app:b", "app:c"];
		let mine = placeApp(EMPTY_APP_LAYOUT, arrangeApps([], EMPTY_APP_LAYOUT, keys), "app:c", null, null);
		mine = placeApp(mine, arrangeApps([], mine, keys), "app:b", null, "app:c");
		expect(shape(arrangeApps([], mine, keys))).toEqual(["app:c", "app:b", "app:a"]);
		// The cloud's jsonb sorts keys by length, then bytes: the order of the document's keys says nothing.
		const sorted = Object.fromEntries(Object.entries(mine.places).sort(([a], [b]) => (a < b ? -1 : 1)));
		const reread = parseMemberAppLayout(JSON.parse(JSON.stringify({ ...mine, places: sorted })));
		expect(shape(arrangeApps([], reread, keys))).toEqual(["app:c", "app:b", "app:a"]);
	});

	it("puts what stood after a group after its last app when the group is taken apart (review F4 on #1678)", () => {
		const company = parseAppGroups("- group g: G\n  - app:a\n  - app:b\n- app:d\n- app:c\n");
		const keys = ["app:a", "app:b", "app:c", "app:d"];
		let mine = placeApp(EMPTY_APP_LAYOUT, arrangeApps(company, EMPTY_APP_LAYOUT, keys), "app:c", null, "group:g");
		expect(shape(arrangeApps(company, mine, keys))).toEqual([["group:g G", "app:a", "app:b"], "app:c", "app:d"]);
		mine = ungroupApps(mine, arrangeApps(company, mine, keys), "g");
		expect(shape(arrangeApps(company, mine, keys))).toEqual(["app:a", "app:b", "app:c", "app:d"]);
	});
	it("never shows an app twice when its group was moved and then the app (review F1 on #1678, round 2)", () => {
		const company = parseAppGroups("- group g: G\n  - app:planning\n  - app:b\n- group h: H\n  - app:c\n");
		const keys = ["app:planning", "app:b", "app:c"];
		let mine = placeApp(EMPTY_APP_LAYOUT, arrangeApps(company, EMPTY_APP_LAYOUT, keys), "group:g", "h", "app:c");
		mine = placeApp(mine, arrangeApps(company, mine, keys), "app:planning", null, null);
		const want = ["app:planning", ["group:h H", "app:c", ["group:g G", "app:b"]]];
		expect(shape(arrangeApps(company, mine, keys))).toEqual(want);
		for (const sorted of [
			Object.entries(mine.places).sort(([a], [b]) => (a < b ? -1 : 1)),
			Object.entries(mine.places).sort(([a], [b]) => (a < b ? 1 : -1)),
		])
			expect(shape(arrangeApps(company, { ...mine, places: Object.fromEntries(sorted) }, keys))).toEqual(want);
	});

	it("judges a move by where things stand after the moves before it (review F2 on #1678, round 2)", () => {
		const company = parseAppGroups("- group a: A\n  - group b: B\n    - app:b\n  - app:a\n- group c: C\n  - app:c\n");
		const keys = ["app:a", "app:b", "app:c"];
		let mine = placeApp(EMPTY_APP_LAYOUT, arrangeApps(company, EMPTY_APP_LAYOUT, keys), "group:b", null, "group:a");
		mine = placeApp(mine, arrangeApps(company, mine, keys), "group:a", "c", "app:c");
		// B stood right after A, so it takes A's place when A goes into C.
		expect(shape(arrangeApps(company, mine, keys))).toEqual([
			["group:b B", "app:b"],
			["group:c C", "app:c", ["group:a A", "app:a"]],
		]);
		// Then B moves again, after C: A stays in C (review F1 on #1678, round 3).
		const again = placeApp(mine, arrangeApps(company, mine, keys), "group:b", null, "group:c");
		expect(shape(arrangeApps(company, again, keys))).toEqual([
			["group:c C", "app:c", ["group:a A", "app:a"]],
			["group:b B", "app:b"],
		]);
		// A group never goes into itself, nor three levels deep.
		const loop = placeApp(mine, arrangeApps(company, mine, keys), "group:c", "a", null);
		expect(shape(arrangeApps(company, loop, keys))).toEqual(shape(arrangeApps(company, mine, keys)));
	});

	it("never brings back a move the drawer refused, nor lets it outweigh a newer one (review F1 on #1678, round 4)", () => {
		// The drawer writes each change on the document as it stands, less the places the arrangement refused.
		const write = (
			company: AppTreeNode[],
			mine: MemberAppLayout,
			keys: string[],
			change: (layout: MemberAppLayout, tree: AppTreeNode[]) => MemberAppLayout,
		) => {
			const { tree, refused } = arrangeAppsFully(company, mine, keys);
			return change(withoutRefused(mine, refused), tree);
		};
		// A: Y holds Q, so Y into W is refused; Q moved out later must not let Y jump into W.
		const a = parseAppGroups("- group y: Y\n  - group q: Q\n    - app:q\n  - app:y\n- group w: W\n  - app:w\n");
		const aKeys = ["app:q", "app:y", "app:w"];
		let mine = write(a, EMPTY_APP_LAYOUT, aKeys, (l, t) => placeApp(l, t, "group:y", "w", "app:w"));
		expect(shape(arrangeApps(a, mine, aKeys))[0]).toEqual(["group:y Y", ["group:q Q", "app:q"], "app:y"]);
		mine = write(a, mine, aKeys, (l, t) => placeApp(l, t, "group:q", null, null));
		expect(shape(arrangeApps(a, mine, aKeys))).toEqual([
			["group:q Q", "app:q"],
			["group:y Y", "app:y"],
			["group:w W", "app:w"],
		]);
		// B: the member put Z into Y; the company then puts Y into X, so that place is refused; Y into W then holds.
		const before = parseAppGroups(
			"- group x: X\n  - app:x\n- group y: Y\n  - app:y\n- group z: Z\n  - app:z\n- group w: W\n  - app:w\n",
		);
		const after = parseAppGroups(
			"- group x: X\n  - app:x\n  - group y: Y\n    - app:y\n- group z: Z\n  - app:z\n- group w: W\n  - app:w\n",
		);
		const bKeys = ["app:x", "app:y", "app:z", "app:w"];
		let own = write(before, EMPTY_APP_LAYOUT, bKeys, (l, t) => placeApp(l, t, "group:z", "y", "app:y"));
		own = write(after, own, bKeys, (l, t) => placeApp(l, t, "group:y", "w", "app:w"));
		expect(shape(arrangeApps(after, own, bKeys))).toEqual([
			["group:x X", "app:x"],
			["group:z Z", "app:z"],
			["group:w W", "app:w", ["group:y Y", "app:y"]],
		]);
	});

	it("takes an app's name up to 64 characters in the file and in the member's document (review F1 on #1678, round 8)", () => {
		const long = `app:${"a".repeat(64)}`;
		const company = parseAppGroups(`- group sales: Sales\n  - ${long} Long\n`);
		expect(shape(arrangeApps(company, EMPTY_APP_LAYOUT, [long]))).toEqual([["group:sales Sales", long]]);
		const read = parseMemberAppLayout({
			schema: "qorpera.member-app-layout/v1",
			places: { [long]: { group: "-ops", after: null, first: true, at: 1 } },
			groups: { "-ops": { mine: { name: "Ops" } } },
		});
		expect(read.places[long]).toEqual({ group: "-ops", after: null, first: true, at: 1 });
		expect(read.groups["-ops"]).toEqual({ mine: { name: "Ops" } });
	});
});

describe('colours (Jonas, 12 Nov 2026: "I would like for all the icons to share the same color as their group")', () => {
	const company = parseAppGroups(
		"- group trips: Trips\n  - app:planner Planner\n  - group routes: Routes\n    - app:lofoten Lofoten\n- app:finances Finances\n",
	);
	const OWN: Record<string, string> = { "app:planner": "teal", "app:lofoten": "green", "app:finances": "gold" };
	const own = (key: string) => OWN[key];
	const keys = ["app:planner", "app:lofoten", "app:finances"];

	it("draws a group in its first app's colour, a group in a group and every app in it in the group's", () => {
		const colours = appColours(arrangeApps(company, EMPTY_APP_LAYOUT, keys), EMPTY_APP_LAYOUT, own);
		expect(Object.fromEntries(colours)).toEqual({
			"group:trips": "teal",
			"app:planner": "teal",
			"group:routes": "teal",
			"app:lofoten": "teal",
			"app:finances": "gold",
		});
	});

	it("takes the member's colours over the drawer's, a group's for everything in it, an app's only while loose", () => {
		let mine = colourApp(EMPTY_APP_LAYOUT, "group:routes", "pink");
		mine = colourApp(mine, "app:finances", "blue");
		mine = colourApp(mine, "app:lofoten", "coral");
		const colours = appColours(arrangeApps(company, mine, keys), mine, own);
		expect(colours.get("group:trips")).toBe("teal");
		expect(colours.get("group:routes")).toBe("pink");
		expect(colours.get("app:lofoten")).toBe("pink");
		expect(colours.get("app:finances")).toBe("blue");
		// Lofoten loose: its own choice shows.
		const loose = placeApp(mine, arrangeApps(company, mine, keys), "app:lofoten", null, "app:finances");
		expect(appColours(arrangeApps(company, loose, keys), loose, own).get("app:lofoten")).toBe("coral");
	});

	it("draws a group in the company's colour from apps/groups.md, below the member's own, above its first app's", () => {
		const painted = parseAppGroups(
			"- group trips: Trips\n  - app:planner Planner\n  - group routes: Routes\n    - app:lofoten Lofoten\n- app:finances Finances\n<!-- group colours: trips=purple -->\n",
		);
		const colours = appColours(arrangeApps(painted, EMPTY_APP_LAYOUT, keys), EMPTY_APP_LAYOUT, own);
		expect(colours.get("group:trips")).toBe("purple");
		expect(colours.get("group:routes")).toBe("purple");
		expect(colours.get("app:lofoten")).toBe("purple");
		const mine = colourApp(EMPTY_APP_LAYOUT, "group:trips", "gold");
		expect(appColours(arrangeApps(painted, mine, keys), mine, own).get("app:planner")).toBe("gold");
	});

	it("leaves no colours in the document when the last goes, reads only palette colours, and ungroups a group's colour away", () => {
		const one = colourApp(EMPTY_APP_LAYOUT, "app:finances", "blue");
		expect(colourApp(one, "app:finances", null)).toEqual(EMPTY_APP_LAYOUT);
		expect(colourApp(one, "app:finances", null)).not.toHaveProperty("colours");
		const read = parseMemberAppLayout({
			schema: "qorpera.member-app-layout/v1",
			places: {},
			groups: {},
			colours: { "app:a": "teal", "app:b": "red", "agent:x": "blue", "group:g": "gray", "page:mailbox": 3 },
		});
		expect(read.colours).toEqual({ "app:a": "teal", "group:g": "gray" });
		expect(
			parseMemberAppLayout({ schema: "qorpera.member-app-layout/v1", places: {}, groups: {} }),
		).not.toHaveProperty("colours");
		const coloured = colourApp(EMPTY_APP_LAYOUT, "group:trips", "purple");
		const apart = ungroupApps(coloured, arrangeApps(company, coloured, keys), "trips");
		expect(apart.colours).toBeUndefined();
		expect(apart.groups).toEqual({ trips: { removed: true } });
	});
});

describe('icons (Jonas, 12 Nov 2026: "change the icons of the interfaces")', () => {
	it("keeps a member's icon per app, a built-in name or one of the app's own, and nothing when the last goes", () => {
		let mine = emblemApp(EMPTY_APP_LAYOUT, "app:planner", "map");
		mine = emblemApp(mine, "page:mailbox", "custom:compass");
		expect(mine.emblems).toEqual({ "app:planner": "map", "page:mailbox": "custom:compass" });
		expect(emblemApp(emblemApp(mine, "app:planner", null), "page:mailbox", null)).toEqual(EMPTY_APP_LAYOUT);
		const read = parseMemberAppLayout({
			schema: "qorpera.member-app-layout/v1",
			places: {},
			groups: {},
			emblems: {
				"app:a": "rocket",
				"app:b": "unicorn",
				"app:c": "custom:trail-sign",
				"app:d": "custom:../x",
				"group:g": "map",
				"page:bank": 3,
			},
		});
		expect(read.emblems).toEqual({ "app:a": "rocket", "app:c": "custom:trail-sign" });
		expect(
			parseMemberAppLayout({ schema: "qorpera.member-app-layout/v1", places: {}, groups: {} }),
		).not.toHaveProperty("emblems");
	});
});
