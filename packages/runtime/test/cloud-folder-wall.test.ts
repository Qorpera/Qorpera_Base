import { parseWall, renderWall } from "@qorpera/cloud-client/agent-wall";
import type { JsonValue } from "@qorpera/contracts";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { cloudWallTools, nextWall, wallToday } from "@qorpera/runtime/cloud-folder-wall";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const WALL = "QorperaOS/agents/nora/wall.md";
const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}, today = "2026-11-05") {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = [
		...cloudWallTools({
			folder: f.folder,
			operations: f.operations(),
			identity: f.identity,
			handle: "nora",
			today: () => today,
		}),
		...cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
	];
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	let calls = 0;
	const call = async (name: string, value: JsonValue) => {
		const parsed = tool(name).parseArguments(value);
		return tool(name).execute(parsed, { ...f.context, callId: `call-${++calls}` });
	};
	return { ...f, tool, call };
}

const read = (content: CloudToolContent) => JSON.parse(String(content.value));
const wall = (waiting: JsonValue, working: JsonValue, done: JsonValue = []) => ({ waiting, working, done });

it("offers update_wall as a Company File tool", async () => {
	const f = await fixture();
	expect([f.tool("update_wall").name, f.tool("update_wall").source]).toEqual(["update_wall", "company_file"]);
});

it("refuses items it cannot keep before anything is read", async () => {
	const f = await fixture();
	const tool = f.tool("update_wall");
	const refuses = (value: JsonValue, text: string) => {
		expect(() => tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
		expect(() => tool.parseArguments(value)).toThrow(text);
	};
	refuses({ waiting: null, working: null }, "update_wall takes exactly");
	refuses(wall(["a\nb"], null), "an item is one line");
	refuses(wall([" "], null), "an item is empty");
	refuses(wall(["x".repeat(241)], null), "put the rest in a file and link it");
	refuses(wall(["1", "2", "3", "4", "5", "6", "7"], null), "waiting must be a list of at most 6 items");
	refuses(wall(null, null, null), "done must be a list");
	refuses(wall([{ headline: "A", note: "B" }], null), "has only headline and detail");
	refuses(wall([{ detail: "B" }], null), "is {headline, detail?}");
	refuses(wall([{ headline: "A", detail: "x".repeat(241) }], null), "a detail is at most 240 characters");
	refuses(wall([{ headline: "A", detail: "one\ntwo" }], null), "a detail is one or two sentences on one line");
	expect(f.commits).toEqual([]);
});

it("makes the wall in the agent's folder, then keeps it in place", async () => {
	const f = await fixture();
	const first = read(
		await f.call(
			"update_wall",
			wall(
				["Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)"],
				["Checking five shops' prices"],
				["Team hired"],
			),
		),
	);
	expect(first).toMatchObject({ schema: "qorpera.agent-wall/v1", path: WALL, saved: true });
	expect(f.text(WALL)).toBe(
		[
			"# Wall",
			"",
			"## Waits on you",
			"- Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)",
			"",
			"## Working on",
			"- Checking five shops' prices",
			"",
			"## Done",
			"- 2026-11-05: Team hired",
			"",
		].join("\n"),
	);
	// The price check finishes: it leaves working and goes on top of done; what waits is kept.
	const second = read(await f.call("update_wall", wall(null, [], ["Prices checked: most sell at 89–129 kr"])));
	expect(second.saved).toBe(true);
	expect(parseWall(f.text(WALL) ?? "")).toMatchObject({
		wall: {
			waiting: [{ text: "Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)" }],
			working: [],
			done: [
				{ day: "2026-11-05", text: "Prices checked: most sell at 89–129 kr" },
				{ day: "2026-11-05", text: "Team hired" },
			],
		},
		problems: [],
	});
	expect(f.commits).toHaveLength(2);
	// The same wall again saves nothing, and a done item already there this week is not added again.
	const again = read(await f.call("update_wall", wall(null, null, ["team hired"])));
	expect(again).toMatchObject({ saved: false, note: "Already so: nothing changed" });
	expect(f.commits).toHaveLength(2);
});

it("keeps a short headline with its detail, refuses a new long headline, and keeps one already there", async () => {
	const long = `${"An old item from before details, written as one long line ".repeat(2)}[Plan](folder:plan.md)`;
	const f = await fixture({ files: { [WALL]: `# Wall\n\n## Working on\n- ${long}\n` } });
	const answer = read(
		await f.call(
			"update_wall",
			wall(
				[
					{
						headline: "Pick a bundle",
						detail: "Two looks to choose from. [Sketches](folder:sketches/bundles.svg)",
					},
				],
				null,
				[{ headline: "Prices checked", detail: "Most sell at 89–129 kr." }],
			),
		),
	);
	expect(answer.wall).toEqual({
		waiting: [
			{ headline: "Pick a bundle", detail: "Two looks to choose from. [Sketches](folder:sketches/bundles.svg)" },
		],
		working: [{ headline: long }],
		done: [{ day: "2026-11-05", headline: "Prices checked", detail: "Most sell at 89–129 kr." }],
	});
	expect(f.text(WALL)).toBe(
		[
			"# Wall",
			"",
			"## Waits on you",
			"- Pick a bundle",
			"  Two looks to choose from. [Sketches](folder:sketches/bundles.svg)",
			"",
			"## Working on",
			`- ${long}`,
			"",
			"## Done",
			"- 2026-11-05: Prices checked",
			"  Most sell at 89–129 kr.",
			"",
		].join("\n"),
	);
	// The long one given back as it stands is kept; a new long one is refused, saying where the rest goes.
	expect(read(await f.call("update_wall", wall(null, [long]))).saved).toBe(false);
	const error = await f.call("update_wall", wall(null, [`${long} more`])).then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect((error as Error).message).toContain("WALL_HEADLINE_TOO_LONG: nothing was written");
	expect((error as Error).message).toContain("say the rest in its detail");
});

it("never rewrites a wall with lines that read as no item, and keeps the file's own note", async () => {
	const stray = "# Wall\n\nNotes.\n\n## Working on\n- Drafting the terms\nsome stray line\n";
	const f = await fixture({ files: { [WALL]: stray } });
	const error = await f.call("update_wall", wall(null, null, ["Terms drafted"])).then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain("WALL_OUT_OF_SHAPE: nothing was written");
	expect((error as Error).message).toContain("line 7: each line under a part is an item");
	expect(f.text(WALL)).toBe(stray);
	expect(f.commits).toEqual([]);
	// Written in shape with a note under the title, two Working on parts and done items out of order: the note is kept,
	// and the writer puts the rest right without losing an item.
	const g = await fixture({
		files: {
			[WALL]:
				"# Wall\n\nNotes.\n\n## Working on\n- Drafting the terms\n## Done\n- 2026-11-01: Older\n- 2026-11-03: Newer\n## Working on\n- Pricing\n",
		},
	});
	expect(read(await g.call("update_wall", wall(null, null, ["Terms drafted"]))).saved).toBe(true);
	expect(g.text(WALL)).toBe(
		[
			"# Wall",
			"",
			"Notes.",
			"",
			"## Waits on you",
			"",
			"## Working on",
			"- Drafting the terms",
			"- Pricing",
			"",
			"## Done",
			"- 2026-11-05: Terms drafted",
			"- 2026-11-03: Newer",
			"- 2026-11-01: Older",
			"",
		].join("\n"),
	);
});

it("refuses to keep a part filled past its limit, and drops the oldest done items past the file's size", async () => {
	const full = renderWall({
		waiting: ["1", "2", "3", "4", "5", "6", "7"].map((text) => ({ text })),
		working: [],
		done: [],
	});
	const f = await fixture({ files: { [WALL]: full } });
	const error = await f.call("update_wall", wall(null, ["Pricing"])).then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect((error as Error).message).toContain(
		'WALL_TOO_MANY: nothing was written; "Waits on you" holds at most 6 items',
	);
	expect(read(await f.call("update_wall", wall(["1"], ["Pricing"]))).saved).toBe(true);
	const big = {
		waiting: [],
		working: [],
		done: Array.from({ length: 40 }, (_, index) => ({
			day: "2026-11-01",
			text: `Item ${index}`,
			detail: "æ".repeat(230),
		})),
	};
	const g = await fixture({ files: { [WALL]: renderWall({ ...big, done: big.done.slice(0, 30) }) } });
	expect(
		read(
			await g.call(
				"update_wall",
				wall(
					null,
					null,
					big.done.slice(30, 42).map((item) => ({ headline: item.text, detail: item.detail })),
				),
			),
		).saved,
	).toBe(true);
	const kept = parseWall(g.text(WALL) ?? "");
	expect(kept.problems).toEqual([]);
	expect(new TextEncoder().encode(g.text(WALL) ?? "").length).toBeLessThanOrEqual(16 * 1024);
	expect(kept.wall.done[0]?.day).toBe("2026-11-05");
	expect(kept.wall.done.length).toBeLessThan(40);
});

it("dates finished items in the company's time zone", () => {
	const late = new Date("2026-11-04T23:30:00Z");
	expect(wallToday("Europe/Copenhagen", late)).toBe("2026-11-05");
	expect(wallToday(undefined, late)).toBe("2026-11-04");
	expect(wallToday("Not/AZone", late)).toBe("2026-11-04");
});

it("says the wall changed since it was read when the save meets a newer version", async () => {
	const f = await fixture({ files: { [WALL]: renderWall({ waiting: [], working: [{ text: "A" }], done: [] }) } });
	const tool = f.tool("update_wall");
	const parsed = tool.parseArguments(wall(null, ["B"]));
	// A member's edit lands between the read and the save.
	const readText = f.folder.readText.bind(f.folder);
	f.folder.readText = async (...args: Parameters<typeof readText>) => {
		const found = await readText(...args);
		f.seed(WALL, renderWall({ waiting: [], working: [{ text: "C" }], done: [] }));
		return found;
	};
	const answer = read(await tool.execute(parsed, { ...f.context, callId: "race" }));
	expect(answer).toMatchObject({ saved: false, outcome: "not_applied", reason: "version_changed" });
	expect(answer.refused).toContain("call again");
	expect(parseWall(f.text(WALL) ?? "").wall.working).toEqual([{ text: "C" }]);
});

it("keeps done newest first and at most 40 items", () => {
	const stored = {
		waiting: [],
		working: [],
		done: Array.from({ length: 40 }, (_, index) => ({ day: "2026-10-01", text: `Old ${index}` })),
	};
	const next = nextWall(stored, { waiting: null, working: null, done: [{ text: "New" }] }, "2026-11-05");
	expect(next.done).toHaveLength(40);
	expect(next.done[0]).toEqual({ day: "2026-11-05", text: "New" });
	expect(next.done.at(-1)?.text).toBe("Old 38");
	// An item done a week ago or more may be done again: the weekly report of last week is not this week's.
	expect(
		nextWall(
			{ waiting: [], working: [], done: [{ day: "2026-11-02", text: "Sent the weekly report" }] },
			{ waiting: null, working: null, done: [{ text: "Sent the weekly report" }] },
			"2026-11-09",
		).done,
	).toHaveLength(2);
	// An item done more than a week ago may be done again.
	expect(nextWall(stored, { waiting: null, working: null, done: [{ text: "Old 0" }] }, "2026-11-05").done[0]).toEqual({
		day: "2026-11-05",
		text: "Old 0",
	});
});

it("refuses a wall written with the file tools that breaks its rules", async () => {
	const f = await fixture();
	const error = await f
		.call("company_write", {
			path: WALL,
			text: "# Wall\n\n## Done\n- Team hired\n",
			operationKey: "w-1",
			expectedVersion: null,
		})
		.then(
			() => null,
			(thrown: unknown) => thrown,
		);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain("WALL_INVALID: nothing was written");
	expect((error as Error).message).toContain("a done item starts with the day it was done");
	expect(f.commits).toEqual([]);
});
