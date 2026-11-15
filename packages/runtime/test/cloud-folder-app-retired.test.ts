import { randomUUID } from "node:crypto";
import { bringBackApp, retireApp } from "@qorpera/cloud-client/app-retired";
import type { JsonValue } from "@qorpera/contracts";
import { cloudAppGroupsTool } from "@qorpera/runtime/cloud-folder-app-groups";
import { APP_RETIRED_MEMBERS_ONLY } from "@qorpera/runtime/cloud-folder-app-retired";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { cloudPictureTool } from "@qorpera/runtime/cloud-folder-picture-tool";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudPictureChannel } from "@qorpera/runtime/cloud-picture-channel";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

/* Retired interfaces (the founder, 15 November 2026): a member retires an agent's interface app, and its agent stops
 * keeping it. `apps/retired.md` is the members' list; every agent tool that changes an app or writes into its folder
 * refuses a retired one, and no agent changes the list. */

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const MEMBER = "6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8";
const PATH = "apps/retired.md";
const PAGE = "<!doctype html><h1>Plan</h1>";
const RETIRED = `# Retired interfaces\n- old-plan | ${MEMBER} | 2026-11-15T09:30:00Z\n`;
const REFUSAL =
	"APP_RETIRED: a member retired the interface old-plan on 15 November 2026. Leave it: do not change it, post it or remake it under another name, and conclude any routine you keep only for it. A member brings it back from their own sidebar; tell whoever asked for the change.";

/** A company with two of the agent's own apps, old-plan retired and sales not, and the run's app, file, layout and
 * picture tools. */
async function fixture(retired: string | null = RETIRED) {
	const f = await folderWriterFixture({ folders: ["apps", "drafts"], files: { "drafts/note.md": "hi" } });
	runs.push(f.run);
	const own = (title: string, posted: boolean) =>
		`name = "${title}"\nowner = "${f.identity.staffAgentId.toLowerCase()}"\nposted = ${posted}\n`;
	const seed: Record<string, string> = {
		"apps/old-plan/app.toml": own("Old plan", true),
		"apps/old-plan/index.html": PAGE,
		"apps/sales/app.toml": own("Sales", true),
		"apps/sales/index.html": PAGE,
		...(retired === null ? {} : { [PATH]: retired }),
	};
	for (const [path, text] of Object.entries(seed)) f.seed(path, text);
	const pictures = new CloudPictureChannel();
	const made = vi.fn(async () => ({
		png: pngFile(pngHeader(1, 1, 8, 2), pngRows([[255, 0, 0]])),
		transparent: false,
	}));
	pictures.attach(made);
	const tools: CloudNativeTool[] = [
		...cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
		...cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
		cloudAppGroupsTool({ folder: f.folder, operations: f.operations(), identity: f.identity }),
		cloudPictureTool({ folder: f.folder, operations: f.operations(), identity: f.identity, pictures }),
	];
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	/** A call as the boundary makes it: parsed, prepared before the review, then run. */
	const call = async (name: string, value: JsonValue): Promise<CloudToolContent> => {
		const context = { ...f.context, callId: randomUUID() };
		const parsed = tool(name).parseArguments(value);
		const prepared = (await tool(name).prepare?.(parsed, context)) ?? parsed;
		return tool(name).execute(prepared, context);
	};
	/** Only the prepare a call makes before its review. */
	const prepare = async (name: string, value: JsonValue) =>
		tool(name).prepare?.(tool(name).parseArguments(value), { ...f.context, callId: randomUUID() });
	const version = (path: string) => f.files.get(path)?.version as string;
	return { ...f, tool, call, prepare, version, made };
}

const read = (content: CloudToolContent) => JSON.parse(String(content.value));
async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toBe(text);
}
const save = (name: string, key: string, manifest: JsonValue, files: { path: string; text: string }[]) => ({
	name,
	operationKey: key,
	manifest,
	files,
});

it("refuses save_app on a retired app before its review: a change, and a new app made under its name", async () => {
	const f = await fixture();
	const change = save("old-plan", "change-1", null, [{ path: "index.html", text: "<h1>New</h1>" }]);
	await refuses(f.prepare("save_app", change) as Promise<unknown>, REFUSAL);
	// And at the save itself, should a member retire it between the review and the save.
	await refuses(f.tool("save_app").execute(f.tool("save_app").parseArguments(change), f.context), REFUSAL);
	// A retired app whose folder is gone is not made again under its name.
	const f2 = await fixture(`${RETIRED}- gone-app | ${MEMBER} | 2026-11-14T08:00:00Z\n`);
	await refuses(
		f2.call("save_app", save("gone-app", "make-1", { title: "Gone" }, [{ path: "index.html", text: PAGE }])),
		"APP_RETIRED: a member retired the interface gone-app on 14 November 2026. Leave it: do not change it, post it or remake it under another name, and conclude any routine you keep only for it. A member brings it back from their own sidebar; tell whoever asked for the change.",
	);
	expect(f.commits).toEqual([]);
	expect(f2.commits).toEqual([]);
	// Another app saves as before, and its answer releases the members' list it was checked against.
	expect(
		read(await f.call("save_app", save("sales", "change-2", null, [{ path: "index.html", text: "<h1>S</h1>" }]))),
	).toMatchObject({ state: "applied" });
	const released = f.releases.at(-1)?.p_reads as { path: string }[];
	expect(released.map((entry) => entry.path)).toContain(PATH);
});

it("refuses post_app on a retired app both ways, before its review", async () => {
	const f = await fixture();
	for (const posted of [true, false]) {
		const value = { name: "old-plan", operationKey: `post-${posted}`, posted };
		await refuses(f.prepare("post_app", value) as Promise<unknown>, REFUSAL);
		await refuses(f.tool("post_app").execute(f.tool("post_app").parseArguments(value), f.context), REFUSAL);
	}
	expect(f.commits).toEqual([]);
	expect(read(await f.call("post_app", { name: "sales", operationKey: "post-s", posted: false }))).toMatchObject({
		state: "applied",
		posted: false,
	});
	expect((f.releases.at(-1)?.p_reads as { path: string }[]).map((entry) => entry.path)).toEqual([
		"apps/sales/app.toml",
		PATH,
	]);
});

it("refuses a write, an edit, a new folder, a move and a deletion in a retired app's folder", async () => {
	const f = await fixture();
	const page = "apps/old-plan/index.html";
	await refuses(
		f.call("company_write", { path: page, operationKey: "w-1", expectedVersion: f.version(page), text: "<p>" }),
		REFUSAL,
	);
	await refuses(
		f.call("company_write", {
			path: "apps/old-plan/more.html",
			operationKey: "w-2",
			expectedVersion: null,
			text: "x",
		}),
		REFUSAL,
	);
	await refuses(
		f.call("company_edit", {
			path: page,
			operationKey: "e-1",
			expectedVersion: f.version(page),
			oldText: "Plan",
			newText: "Plans",
		}),
		REFUSAL,
	);
	await refuses(
		f.call("company_mkdir", { path: "apps/old-plan/pictures", operationKey: "m-1", expectedVersion: null }),
		REFUSAL,
	);
	const move = (from: string, to: string, asOfSeq: number | null = null) =>
		f.call("company_move", {
			from,
			to,
			operationKey: `mv-${to.replaceAll("/", "-")}`,
			expectedVersion: f.version(from) ?? "00000000-0000-4000-8000-000000000000",
			asOfSeq,
		});
	// Out of it, into it, and the folder itself under another name.
	await refuses(move(page, "drafts/index.html"), REFUSAL);
	await refuses(move("drafts/note.md", "apps/old-plan/note.md"), REFUSAL);
	await refuses(move("apps/old-plan", "apps/new-plan", 1), REFUSAL);
	await refuses(
		f.call("company_delete", { path: page, operationKey: "d-1", expectedVersion: f.version(page) }),
		REFUSAL,
	);
	expect(f.commits).toEqual([]);
	// The other app's files are the agent's own, as before.
	expect(
		read(
			await f.call("company_write", {
				path: "apps/sales/index.html",
				operationKey: "w-3",
				expectedVersion: f.version("apps/sales/index.html"),
				text: "<p>",
			}),
		),
	).toMatchObject({ state: "applied" });
});

it("refuses make_picture into a retired app before a picture is made", async () => {
	const f = await fixture();
	const value = {
		operationKey: "pic-1",
		path: "apps/old-plan/pictures/plan.png",
		prompt: "A plan on a table, top view, soft light, plain background.",
	};
	await refuses(f.prepare("make_picture", value) as Promise<unknown>, REFUSAL);
	await refuses(f.tool("make_picture").execute(f.tool("make_picture").parseArguments(value), f.context), REFUSAL);
	expect(f.made).not.toHaveBeenCalled();
	expect(f.commits).toEqual([]);
});

it("keeps the members' list closed to every agent write, edit, new folder, move and deletion", async () => {
	const f = await fixture();
	const version = f.version(PATH);
	await refuses(
		f.call("company_write", { path: PATH, operationKey: "w-1", expectedVersion: version, text: "# Retired\n" }),
		APP_RETIRED_MEMBERS_ONLY,
	);
	await refuses(
		f.call("company_write", { path: "Apps/Retired.md", operationKey: "w-2", expectedVersion: version, text: "" }),
		APP_RETIRED_MEMBERS_ONLY,
	);
	await refuses(
		f.call("company_edit", {
			path: PATH,
			operationKey: "e-1",
			expectedVersion: version,
			oldText: "old-plan",
			newText: "other",
		}),
		APP_RETIRED_MEMBERS_ONLY,
	);
	await refuses(
		f.call("company_move", {
			from: PATH,
			to: "drafts/retired.md",
			operationKey: "mv-1",
			expectedVersion: version,
			asOfSeq: null,
		}),
		APP_RETIRED_MEMBERS_ONLY,
	);
	// Moving the apps folder would take the list with it.
	await refuses(
		f.call("company_move", {
			from: "apps",
			to: "old-apps",
			operationKey: "mv-2",
			expectedVersion: "00000000-0000-4000-8000-000000000000",
			asOfSeq: 1,
		}),
		APP_RETIRED_MEMBERS_ONLY,
	);
	await refuses(
		f.call("company_delete", { path: PATH, operationKey: "d-1", expectedVersion: version }),
		APP_RETIRED_MEMBERS_ONLY,
	);
	expect(f.commits).toEqual([]);
	expect(APP_RETIRED_MEMBERS_ONLY).toBe(
		"APP_RETIRED_MEMBERS_ONLY: nothing was changed; apps/retired.md lists the interfaces members retired, and only a member retires an interface or brings one back, from their own sidebar. Leave the file as it is.",
	);
	// Nor made by an agent where there is none.
	const none = await fixture(null);
	await refuses(
		none.call("company_write", { path: PATH, operationKey: "w-3", expectedVersion: null, text: RETIRED }),
		APP_RETIRED_MEMBERS_ONLY,
	);
	await refuses(
		none.call("company_mkdir", { path: PATH, operationKey: "m-1", expectedVersion: null }),
		APP_RETIRED_MEMBERS_ONLY,
	);
	// Nor brought in with a folder (review r1 of #1843, F1): a folder that holds a retired.md, moved onto the apps
	// folder's own path, where the apps folder stands or after it was moved away.
	none.seed("staging/retired.md", RETIRED);
	const moveFolder = (from: string, to: string, key: string) =>
		none.call("company_move", {
			from,
			to,
			operationKey: key,
			expectedVersion: "00000000-0000-4000-8000-000000000000",
			asOfSeq: 1,
		});
	await refuses(moveFolder("staging", "apps", "mv-3"), APP_RETIRED_MEMBERS_ONLY);
	await refuses(moveFolder("staging", "Apps", "mv-4"), APP_RETIRED_MEMBERS_ONLY);
	// Anything at retired.md takes the list's place: a folder there too.
	none.folders.add("staging-2");
	none.folders.add("staging-2/retired.md");
	await refuses(moveFolder("staging-2", "apps", "mv-5"), APP_RETIRED_MEMBERS_ONLY);
	expect(none.commits).toEqual([]);
	// What stays allowed passes these rules and reaches the folder core, whatever it answers then (each in a run of its
	// own): the apps folder moved away while it holds no list, a folder with no retired.md moved onto the apps folder's
	// path, and a folder holding one moved anywhere else.
	for (const [from, to] of [
		["apps", "old-apps"],
		["plain", "apps"],
		["staging", "archive"],
	] as const) {
		const run = await fixture(null);
		run.seed("staging/retired.md", RETIRED);
		run.seed("plain/notes.md", "hi");
		const reached = await run
			.call("company_move", {
				from,
				to,
				operationKey: "mv-allowed",
				expectedVersion: "00000000-0000-4000-8000-000000000000",
				asOfSeq: 1,
			})
			.then(
				() => "answered",
				(error: unknown) => (error instanceof CloudToolRefusal ? error.message : "reached the commit"),
			);
		expect(reached, `${from} -> ${to}`).not.toContain("APP_RETIRED");
		expect(run.commits.length, `${from} -> ${to}`).toBeGreaterThan(0);
	}
});

it("marks a retired app in organize_apps list, counts it in no group, and still moves it", async () => {
	const f = await fixture();
	const listed = read(await f.call("organize_apps", { action: "list" }));
	expect(listed.layout).toEqual([
		"page:mailbox Mailbox",
		"page:members Members",
		"page:bank Bank",
		"app:old-plan Old plan (retired by a member)",
		"app:sales Sales",
	]);
	expect(listed.looseApps).toBe(1);
	expect((f.releases.at(-1)?.p_reads as { path: string }[]).map((entry) => entry.path)).toContain(PATH);
	const made = read(await f.call("organize_apps", { action: "create_group", name: "Plans", items: ["app:old-plan"] }));
	expect(made).toMatchObject({ changed: true, group: "plans" });
	expect(read(await f.call("organize_apps", { action: "list" })).layout).toContain(
		"  app:old-plan Old plan (retired by a member)",
	);
	expect(read(await f.call("organize_apps", { action: "list" })).layout).toContain("group plans: Plans (0 apps)");
});

it("works as before for a company with no members' list, or a line it cannot read", async () => {
	for (const retired of [null, "# Retired interfaces\n- old-plan\n- old-plan | someone | yesterday\n"]) {
		const f = await fixture(retired);
		expect(
			read(
				await f.call("save_app", save("old-plan", "change-1", null, [{ path: "index.html", text: "<h1>N</h1>" }])),
			),
		).toMatchObject({ state: "applied" });
		expect(read(await f.call("post_app", { name: "old-plan", operationKey: "p-1", posted: false }))).toMatchObject({
			state: "applied",
		});
		expect(read(await f.call("organize_apps", { action: "list" })).layout).toContain(
			"app:old-plan Old plan (not posted)",
		);
	}
	// A list that is not text retires nothing either.
	const folder = await fixture(null);
	folder.folders.add(PATH);
	expect(
		read(await folder.call("save_app", save("old-plan", "c-1", null, [{ path: "index.html", text: "<h1>F</h1>" }]))),
	).toMatchObject({ state: "applied" });
});

it("saves a brought-back app again without trouble", async () => {
	const f = await fixture();
	const change = save("old-plan", "change-1", null, [{ path: "index.html", text: "<h1>Back</h1>" }]);
	await refuses(f.call("save_app", change), REFUSAL);
	// A member brings it back: their own write of the list, which no agent tool makes.
	f.seed(PATH, bringBackApp(f.text(PATH) as string, "old-plan"));
	expect(read(await f.call("save_app", change))).toMatchObject({ state: "applied" });
	expect(f.text("apps/old-plan/index.html")).toBe("<h1>Back</h1>");
	expect(read(await f.call("post_app", { name: "old-plan", operationKey: "p-1", posted: false }))).toMatchObject({
		state: "applied",
	});
	// And retired again, refused again.
	f.seed(PATH, retireApp(f.text(PATH), "old-plan", MEMBER, "2026-11-16T07:00:00Z") as string);
	await refuses(
		f.call("company_write", {
			path: "apps/old-plan/index.html",
			operationKey: "w-1",
			expectedVersion: f.version("apps/old-plan/index.html"),
			text: "<p>",
		}),
		REFUSAL.replace("15 November", "16 November"),
	);
});
