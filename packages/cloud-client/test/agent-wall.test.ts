import { parseWall, WALL_ITEM_MAX_CHARS, wallHandle } from "@qorpera/cloud-client/agent-wall";
import { expect, it } from "vitest";

const WALL = {
	waiting: [{ text: "Pick a shop name", detail: "My pick is Båndklar. [Names](folder:research/names.md)" }],
	working: [{ text: "Checking five shops' prices" }, { text: "Finding a supplier" }],
	done: [
		{ day: "2026-11-05", text: "Team hired" },
		{ day: "2026-10-20", text: "Budget made [Budget](folder:money/budget.md)" },
	],
};

it("names an agent's wall in its folder, and only there", () => {
	expect(wallHandle("QorperaOS/agents/co-founder/wall.md")).toBe("co-founder");
	expect(wallHandle("qorperaos/Agents/Nora/WALL.md")).toBe("Nora");
	expect(wallHandle("QorperaOS/agents/groups/wall.md")).toBeNull();
	expect(wallHandle("QorperaOS/agents/nora/notes/wall.md")).toBeNull();
	expect(wallHandle("notes/wall.md")).toBeNull();
});

const TEXT = [
	"# Wall",
	"",
	"## Waits on you",
	"- Pick a shop name",
	"  My pick is Båndklar. [Names](folder:research/names.md)",
	"",
	"## Working on",
	"- Checking five shops' prices",
	"- Finding a supplier",
	"",
	"## Done",
	"- 2026-11-05: Team hired",
	"- 2026-10-20: Budget made [Budget](folder:money/budget.md)",
	"",
].join("\n");

it("reads the kept form with no problems", () => {
	expect(parseWall(TEXT)).toEqual({ wall: WALL, problems: [], head: "# Wall" });
});

it("reads a member's edit in any case, and leaves out text outside the parts", () => {
	expect(
		parseWall(
			"# Wall\n\nOur notes.\n\n## working ON\n* Finding a supplier\n\n## DONE\n-   2026-11-05:   Team  hired\n",
		),
	).toEqual({
		wall: {
			waiting: [],
			working: [{ text: "Finding a supplier" }],
			done: [{ day: "2026-11-05", text: "Team hired" }],
		},
		problems: [],
		head: "# Wall\n\nOur notes.",
	});
});

it("names each problem with its line, and keeps every item that reads", () => {
	const parsed = parseWall(
		[
			"## Waits on you",
			"- A",
			"loose words",
			"## Later",
			"- B",
			"## Done",
			"- Team hired",
			"- 2026-02-30: Not a day",
			"- 2026-11-01: Older",
			"- 2026-11-04: Newer",
			`## Working on`,
			`- ${"x".repeat(WALL_ITEM_MAX_CHARS + 1)}`,
			"## Waits on you",
		].join("\n"),
	);
	expect(parsed.wall).toEqual({
		waiting: [{ text: "A" }],
		working: [],
		done: [
			{ day: "2026-11-01", text: "Older" },
			{ day: "2026-11-04", text: "Newer" },
		],
	});
	expect(parsed.problems.map((problem) => problem.code)).toEqual([
		"line",
		"line",
		"line",
		"line",
		"line",
		"shape",
		"shape",
	]);
	expect(parsed.problems.map((problem) => [problem.line, problem.message.slice(0, 40)])).toEqual([
		[3, "each line under a part is an item, start"],
		[4, 'a wall has the parts "## Now", "## Waits'],
		[7, "a done item starts with the day it was d"],
		[8, "a done item starts with the day it was d"],
		[12, "an item is at most 240 characters: put t"],
		[13, '"## Waits on you" is written twice'],
		[1, "done items go newest first"],
	]);
});

it("refuses more items than a part holds", () => {
	const text = "# Wall\n\n## Waits on you\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7\n\n## Working on\n\n## Done\n";
	expect(parseWall(text).problems).toEqual([
		{ code: "limit", line: 1, message: '"Waits on you" holds at most 6 items' },
	]);
});

it("reads a detail under its item, joined when it runs over two lines, and nothing else as one", () => {
	const parsed = parseWall(
		[
			"## Working on",
			"- Sketching the logo",
			"  Three ideas so far,",
			"  one in blue. [Sketch](folder:design/logo.svg)",
			"",
			"  a stray indented line",
			"## Done",
			"- 2026-11-05: Team hired",
			`  ${"x".repeat(241)}`,
		].join("\n"),
	);
	expect(parsed.wall.working).toEqual([
		{ text: "Sketching the logo", detail: "Three ideas so far, one in blue. [Sketch](folder:design/logo.svg)" },
	]);
	expect(parsed.wall.done).toEqual([{ day: "2026-11-05", text: "Team hired" }]);
	expect(parsed.problems.map((problem) => [problem.line, problem.message.slice(0, 24)])).toEqual([
		[6, "each line under a part i"],
		[9, "a detail is at most 240 "],
	]);
});

it("reads a bullet at any indent as an item, as walls were written before details, unless it is right under one", () => {
	expect(parseWall("## Working on\n  - Indented first\n- Second\n\n  - After a blank line\n").wall.working).toEqual([
		{ text: "Indented first" },
		{ text: "Second" },
		{ text: "After a blank line" },
	]);
	// Right under an item, an indented line is its detail, even one that starts with "- ".
	expect(parseWall("## Working on\n- Second\n  - a detail\n").wall.working).toEqual([
		{ text: "Second", detail: "- a detail" },
	]);
});

it("keeps a Now line on top: one line, no detail, absent from a wall written before it", () => {
	const text = TEXT.replace("# Wall\n", "# Wall\n\n## Now\n- Prices set, picking suppliers now\n");
	expect(parseWall(text)).toEqual({
		wall: { ...WALL, now: "Prices set, picking suppliers now" },
		problems: [],
		head: "# Wall",
	});
	expect(parseWall(TEXT).wall).not.toHaveProperty("now");
	const twice = parseWall("## Now\n- One\n- Two\n");
	expect(twice.wall.now).toBe("One");
	expect(twice.problems).toEqual([
		{ code: "line", line: 3, message: "the Now part holds one line: put the rest on the wall's items" },
	]);
	const detailed = parseWall("## Now\n- One\n  More words\n");
	expect(detailed.wall.now).toBe("One");
	expect(detailed.problems).toEqual([
		{ code: "line", line: 3, message: "the Now line is one line, with no detail under it" },
	]);
});
