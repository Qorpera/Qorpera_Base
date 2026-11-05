import {
	foldWallDone,
	isWallDay,
	parseWall,
	renderWall,
	WALL_ITEM_MAX_CHARS,
	wallHandle,
	wallPath,
	wallPreview,
} from "@qorpera/cloud-client/agent-wall";
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
	expect(wallPath("co-founder")).toBe("QorperaOS/agents/co-founder/wall.md");
	expect(wallHandle("QorperaOS/agents/co-founder/wall.md")).toBe("co-founder");
	expect(wallHandle("qorperaos/Agents/Nora/WALL.md")).toBe("Nora");
	expect(wallHandle("QorperaOS/agents/groups/wall.md")).toBeNull();
	expect(wallHandle("QorperaOS/agents/nora/notes/wall.md")).toBeNull();
	expect(wallHandle("notes/wall.md")).toBeNull();
});

it("keeps the file's own head as written", () => {
	const text = renderWall(WALL, "# Our wall\n\nAsk Nora about anything here.\n\n");
	expect(text.startsWith("# Our wall\n\nAsk Nora about anything here.\n\n## Waits on you\n")).toBe(true);
	expect(parseWall(text).head).toBe("# Our wall\n\nAsk Nora about anything here.");
	expect(renderWall(WALL, "").startsWith("# Wall\n\n## Waits on you")).toBe(true);
});

it("writes the kept form and reads it back", () => {
	const text = renderWall(WALL);
	expect(text).toBe(
		[
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
		].join("\n"),
	);
	expect(parseWall(text)).toEqual({ wall: WALL, problems: [], head: "# Wall" });
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
		[4, 'a wall has the parts "## Waits on you", '],
		[7, "a done item starts with the day it was d"],
		[8, "a done item starts with the day it was d"],
		[12, "an item is at most 240 characters: put t"],
		[13, '"## Waits on you" is written twice'],
		[1, "done items go newest first"],
	]);
});

it("refuses more items than a part holds", () => {
	const text = renderWall({
		waiting: ["1", "2", "3", "4", "5", "6", "7"].map((text) => ({ text })),
		working: [],
		done: [],
	});
	expect(parseWall(text).problems).toEqual([
		{ code: "limit", line: 1, message: '"Waits on you" holds at most 6 items' },
	]);
});

it("folds done items older than a week into Earlier", () => {
	expect(foldWallDone(WALL.done, "2026-11-05")).toEqual({ recent: [WALL.done[0]], earlier: [WALL.done[1]] });
	expect(foldWallDone(WALL.done, "2026-10-26").recent).toEqual(WALL.done);
	expect(isWallDay("2026-11-05")).toBe(true);
	expect(isWallDay("2026-13-01")).toBe(false);
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
	expect(
		parseWall(renderWall({ waiting: [], working: [{ text: "A", detail: "- B" }], done: [] })).wall.working,
	).toEqual([{ text: "A", detail: "- B" }]);
});

it("finds the picture or app an item shows when it opens", () => {
	expect(wallPreview({ text: "Logo", detail: "[Plan](folder:a/plan.md) [Logo](folder:a/logo.SVG)" })).toEqual({
		kind: "image",
		path: "a/logo.SVG",
	});
	expect(wallPreview({ text: "Shop [Demo](app:shop-demo)", detail: "[Shot](folder:a/shot.png)" })).toEqual({
		kind: "image",
		path: "a/shot.png",
	});
	expect(wallPreview({ text: "Shop", detail: "See [Demo](app:shop-demo)" })).toEqual({
		kind: "app",
		name: "shop-demo",
	});
	expect(wallPreview({ text: "Plan [Plan](folder:a/plan.md)" })).toBeNull();
});
