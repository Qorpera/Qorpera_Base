import { parseWall, renderWall } from "@qorpera/cloud-client/agent-wall";
import type { JsonValue } from "@qorpera/contracts";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { cloudWallTools, nextWall } from "@qorpera/runtime/cloud-folder-wall";
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
	expect(parseWall(f.text(WALL) ?? "")).toEqual({
		wall: {
			waiting: ["Pick a shop name. My pick is Båndklar. [Names](folder:research/names.md)"],
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

it("puts a wall someone wrote out of shape back in shape from what reads", async () => {
	const f = await fixture({
		files: { [WALL]: "# Wall\n\nNotes.\n\n## Working on\n- Drafting the terms\nsome stray line\n" },
	});
	const answer = read(await f.call("update_wall", wall(null, null, ["Terms drafted"])));
	expect(answer.saved).toBe(true);
	expect(parseWall(f.text(WALL) ?? "")).toEqual({
		wall: { waiting: [], working: ["Drafting the terms"], done: [{ day: "2026-11-05", text: "Terms drafted" }] },
		problems: [],
	});
});

it("says the wall changed since it was read when the save meets a newer version", async () => {
	const f = await fixture({ files: { [WALL]: renderWall({ waiting: [], working: ["A"], done: [] }) } });
	const tool = f.tool("update_wall");
	const parsed = tool.parseArguments(wall(null, ["B"]));
	// A member's edit lands between the read and the save.
	const readText = f.folder.readText.bind(f.folder);
	f.folder.readText = async (...args: Parameters<typeof readText>) => {
		const found = await readText(...args);
		f.seed(WALL, renderWall({ waiting: [], working: ["C"], done: [] }));
		return found;
	};
	const answer = read(await tool.execute(parsed, { ...f.context, callId: "race" }));
	expect(answer).toMatchObject({ saved: false, outcome: "not_applied", reason: "version_changed" });
	expect(answer.refused).toContain("call again");
	expect(parseWall(f.text(WALL) ?? "").wall.working).toEqual(["C"]);
});

it("keeps done newest first and at most 40 items", () => {
	const stored = {
		waiting: [],
		working: [],
		done: Array.from({ length: 40 }, (_, index) => ({ day: "2026-10-01", text: `Old ${index}` })),
	};
	const next = nextWall(stored, { waiting: null, working: null, done: ["New"] }, "2026-11-05");
	expect(next.done).toHaveLength(40);
	expect(next.done[0]).toEqual({ day: "2026-11-05", text: "New" });
	expect(next.done.at(-1)?.text).toBe("Old 38");
	// An item done more than a week ago may be done again.
	expect(nextWall(stored, { waiting: null, working: null, done: ["Old 0"] }, "2026-11-05").done[0]).toEqual({
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
