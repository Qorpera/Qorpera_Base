import {
	foldWallDone,
	isWallDay,
	parseWall,
	renderWall,
	WALL_ITEM_MAX_CHARS,
	wallHandle,
	wallPath,
} from "@qorpera/cloud-client/agent-wall";
import { expect, it } from "vitest";

const WALL = {
	waiting: ["Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)"],
	working: ["Checking five shops' prices", "Finding a supplier"],
	done: [
		{ day: "2026-11-05", text: "Team hired" },
		{ day: "2026-10-20", text: "Budget made [Budget](folder:money/budget.md)" },
	],
};

it("names an agent's wall in its folder, and only there", () => {
	expect(wallPath("co-founder")).toBe("QorperaOS/agents/co-founder/wall.md");
	expect(wallHandle("QorperaOS/agents/co-founder/wall.md")).toBe("co-founder");
	expect(wallHandle("qorperaos/Agents/Nora/WALL.md")).toBe("Nora");
	expect(wallHandle("QorperaOS/agents/groups/wall.md")).toBeNull();
	expect(wallHandle("QorperaOS/agents/nora/notes/wall.md")).toBeNull();
	expect(wallHandle("notes/wall.md")).toBeNull();
});

it("writes the kept form and reads it back", () => {
	const text = renderWall(WALL);
	expect(text).toBe(
		[
			"# Wall",
			"",
			"## Waits on you",
			"- Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)",
			"",
			"## Working on",
			"- Checking five shops' prices",
			"- Finding a supplier",
			"",
			"## Done",
			"- 2026-11-05: Team hired",
			"- 2026-10-20: Budget made [Budget](folder:money/budget.md)",
			"",
		].join("\n"),
	);
	expect(parseWall(text)).toEqual({ wall: WALL, problems: [] });
});

it("reads a member's edit in any case, and leaves out text outside the parts", () => {
	expect(
		parseWall(
			"# Wall\n\nOur notes.\n\n## working ON\n* Finding a supplier\n\n## DONE\n-   2026-11-05:   Team  hired\n",
		),
	).toEqual({
		wall: { waiting: [], working: ["Finding a supplier"], done: [{ day: "2026-11-05", text: "Team hired" }] },
		problems: [],
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
		waiting: ["A"],
		working: [],
		done: [
			{ day: "2026-11-01", text: "Older" },
			{ day: "2026-11-04", text: "Newer" },
		],
	});
	expect(parsed.problems.map((problem) => [problem.line, problem.message.slice(0, 40)])).toEqual([
		[3, "each line under a part is an item, start"],
		[4, 'a wall has the parts "## Waits on you", '],
		[7, "a done item starts with the day it was d"],
		[8, "a done item starts with the day it was d"],
		[12, "an item is at most 240 characters: put t"],
		[13, '"## Waits on you" is written twice'],
		[1, "done items go newest first"],
	]);
});

it("refuses more items than a part holds", () => {
	const text = renderWall({ waiting: ["1", "2", "3", "4", "5", "6", "7"], working: [], done: [] });
	expect(parseWall(text).problems).toEqual([{ line: 1, message: '"Waits on you" holds at most 6 items' }]);
});

it("folds done items older than a week into Earlier", () => {
	expect(foldWallDone(WALL.done, "2026-11-05")).toEqual({ recent: [WALL.done[0]], earlier: [WALL.done[1]] });
	expect(foldWallDone(WALL.done, "2026-10-26").recent).toEqual(WALL.done);
	expect(isWallDay("2026-11-05")).toBe(true);
	expect(isWallDay("2026-13-01")).toBe(false);
});
