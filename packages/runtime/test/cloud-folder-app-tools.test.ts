import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = [
		...cloudAppTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
		...cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity }),
	];
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue) => {
		const parsed = tool(name).parseArguments(value);
		const prepared = (await tool(name).prepare?.(parsed, f.context)) ?? parsed;
		return tool(name).execute(prepared, f.context);
	};
	return { ...f, tools, tool, call };
}

const read = (content: CloudToolContent) => JSON.parse(String(content.value));
async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}
function refusesArguments(tool: CloudNativeTool, value: JsonValue, text: string) {
	expect(() => tool.parseArguments(value)).toThrow(CloudToolArgumentRefusal);
	expect(() => tool.parseArguments(value)).toThrow(text);
}

const PAGE = '<!doctype html><link rel="stylesheet" href="style.css"><h1>Sales</h1><script src="js/app.js"></script>';
const manifest = (title: string, more: Record<string, JsonValue> = {}) => ({ title, ...more });
const save = (name: string, key: string, m: JsonValue, files: { path: string; text: string }[]) => ({
	name,
	operationKey: key,
	manifest: m,
	files,
});

it("offers save_app and post_app as Company File tools", async () => {
	const f = await fixture();
	expect(f.tools.slice(0, 2).map((tool) => [tool.name, tool.source])).toEqual([
		["save_app", "company_file"],
		["post_app", "company_file"],
	]);
});

it("refuses arguments it cannot save before anything is read", async () => {
	const f = await fixture();
	const tool = f.tool("save_app");
	refusesArguments(tool, save("Sales", "k", manifest("S"), []), "name must be the app's folder name");
	refusesArguments(tool, save("sales", "k", null, []), "give a manifest, files, or both");
	refusesArguments(tool, save("sales", "k", null, [{ path: "../x.html", text: "" }]), "relative to the app's folder");
	refusesArguments(tool, save("sales", "k", null, [{ path: "app.toml", text: "" }]), "written from manifest");
	refusesArguments(tool, save("sales", "k", null, [{ path: "run.sh", text: "" }]), "an app's text files are");
	refusesArguments(
		tool,
		save("sales", "k", null, [
			{ path: "a.css", text: "" },
			{ path: "A.css", text: "" },
		]),
		"listed twice",
	);
	refusesArguments(
		tool,
		save("sales", "k", manifest("S", { emblem: "rocket" }), []),
		"manifest.emblem must be one of",
	);
	refusesArguments(tool, save("sales", "k", manifest("S", { entry: "a.css" }), []), "manifest.entry");
	refusesArguments(f.tool("post_app"), { name: "sales", operationKey: "k", posted: "yes" }, "posted must be");
	expect(f.commits).toEqual([]);
});

it("makes a new app in one unit, owned by the agent and not posted, with the apps folder when there is none", async () => {
	const f = await fixture();
	const answer = read(
		await f.call(
			"save_app",
			save("sales", "make-1", manifest("Sales this week", { emblem: "chart", reads: ["tables"] }), [
				{ path: "index.html", text: PAGE },
				{ path: "style.css", text: "h1{color:teal}" },
				{ path: "js/app.js", text: "console.log(1)" },
			]),
		),
	);
	expect(answer).toMatchObject({
		schema: "qorpera.app-save/v1",
		state: "applied",
		app: "sales",
		created: true,
		link: "app:sales",
	});
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]?.units).toMatchObject([{ op: "new_folder", path: "apps" }]);
	const stored = parseAppManifest(f.text("apps/sales/app.toml") ?? "");
	expect(stored).toEqual({
		ok: true,
		manifest: {
			name: "Sales this week",
			about: null,
			emblem: "chart",
			colour: null,
			entry: "index.html",
			owner: f.identity.staffAgentId.toLowerCase(),
			posted: false,
			reads: ["tables"],
		},
	});
	expect(f.text("apps/sales/js/app.js")).toBe("console.log(1)");
	expect(f.files.get("apps/sales/style.css")?.file.mediaType).toBe("text/css");
	await refuses(
		f.call("save_app", save("other", "make-2", manifest("Other"), [{ path: "page.html", text: "<p>x" }])),
		"APP_ENTRY_MISSING",
	);
});

it("changes an app's files over the versions it reads, and keeps its owner and posted", async () => {
	const OWNER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const f = await fixture({
		folders: ["apps"],
		files: {
			"apps/sales/app.toml": `name = "Sales"\nowner = "${OWNER}"\nposted = true\n`,
			"apps/sales/index.html": PAGE,
		},
	});
	const version = f.files.get("apps/sales/index.html")?.version;
	const answer = read(
		await f.call(
			"save_app",
			save("sales", "change-1", manifest("Sales, by week"), [
				{ path: "index.html", text: "<h1>New</h1>" },
				{ path: "data/week.json", text: "{}" },
			]),
		),
	);
	expect(answer).toMatchObject({ state: "applied", created: false });
	expect(f.commits[0]?.units).toMatchObject([
		{ op: "write", path: "apps/sales/app.toml" },
		{ op: "mkdir", path: "apps/sales/data" },
		{ op: "write", path: "apps/sales/index.html", expectedVersion: version },
		{ op: "write", path: "apps/sales/data/week.json" },
	]);
	expect(parseAppManifest(f.text("apps/sales/app.toml") ?? "")).toMatchObject({
		ok: true,
		manifest: { name: "Sales, by week", owner: OWNER, posted: true },
	});
	expect(f.text("apps/sales/index.html")).toBe("<h1>New</h1>");
});

it("posts an app by its one line, and refuses posted through company_write", async () => {
	const f = await fixture({ folders: ["apps"], files: { "apps/sales/index.html": PAGE } });
	const me = f.identity.staffAgentId.toLowerCase();
	f.seed("apps/sales/app.toml", `name = "Sales" # shown\nposted = false\nemblem = "chart"\nowner = "${me}"\n`);
	const posted = read(await f.call("post_app", { name: "sales", operationKey: "post-1", posted: true }));
	expect(posted).toMatchObject({ schema: "qorpera.app-post/v1", state: "applied", posted: true });
	expect(f.text("apps/sales/app.toml")).toBe(
		`name = "Sales" # shown\nposted = true\nemblem = "chart"\nowner = "${me}"\n`,
	);
	expect(read(await f.call("post_app", { name: "sales", operationKey: "post-2", posted: true }))).toMatchObject({
		state: "unchanged",
	});
	await refuses(f.call("post_app", { name: "nothing", operationKey: "post-3", posted: true }), "APP_NOT_FOUND");
	const versionOf = f.files.get("apps/sales/app.toml")?.version as string;
	await refuses(
		f.call("company_write", {
			path: "apps/sales/app.toml",
			operationKey: "w-1",
			expectedVersion: versionOf,
			text: `name = "Sales"\nposted = false\nowner = "${me}"\n`,
		}),
		"APP_POSTED_BY_POST_APP",
	);
	await refuses(
		f.call("company_write", {
			path: "apps/sales/app.toml",
			operationKey: "w-3",
			expectedVersion: versionOf,
			text: 'name = "Sales"\nposted = true\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\n',
		}),
		"APP_OWNER_FIXED",
	);
	await refuses(
		f.call("company_edit", {
			path: "apps/sales/app.toml",
			operationKey: "e-1",
			expectedVersion: versionOf,
			oldText: "posted = true",
			newText: "posted = false",
		}),
		"APP_POSTED_BY_POST_APP",
	);
	await refuses(
		f.call("company_write", {
			path: "apps/new/app.toml",
			operationKey: "w-2",
			expectedVersion: null,
			text: "name =",
		}),
		"APP_MANIFEST_INVALID",
	);
	// Other changes of the manifest are the agent's to make.
	const edited = read(
		await f.call("company_edit", {
			path: "apps/sales/app.toml",
			operationKey: "e-2",
			expectedVersion: versionOf,
			oldText: 'emblem = "chart"',
			newText: 'emblem = "board"',
		}),
	);
	expect(edited.state).toBe("applied");
});

it("leaves another agent's app to save_app, which asks first, and lets no app move in from elsewhere", async () => {
	const OTHER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";
	const f = await fixture({
		folders: ["apps", "drafts"],
		files: {
			"apps/sales/app.toml": `name = "Sales"\nowner = "${OTHER}"\nposted = true\n`,
			"apps/sales/index.html": PAGE,
			"drafts/x/app.toml": 'name = "X"\nposted = true\n',
			"drafts/x/index.html": PAGE,
			"drafts/note.md": "hi",
		},
	});
	const version = f.files.get("apps/sales/index.html")?.version as string;
	await refuses(
		f.call("company_write", {
			path: "apps/sales/index.html",
			operationKey: "w-1",
			expectedVersion: version,
			text: "<p>",
		}),
		"APP_NOT_YOURS",
	);
	// save_app reads the app before its review: another's app is delegation, the agent's own is not.
	const tool = f.tool("save_app");
	const prepare = (value: JsonValue) => tool.prepare?.(tool.parseArguments(value), f.context);
	expect(await prepare(save("sales", "s-1", null, [{ path: "index.html", text: "<p>new" }]))).toMatchObject({
		foreignOwner: true,
	});
	expect(
		await prepare(save("new-one", "s-2", manifest("New"), [{ path: "index.html", text: "<p>" }])),
	).not.toHaveProperty("foreignOwner");
	const move = (from: string, to: string) =>
		f.call("company_move", {
			from,
			to,
			operationKey: `m-${to.replaceAll("/", "-")}`,
			expectedVersion: f.files.get(from)?.version ?? "00000000-0000-4000-8000-000000000000",
			asOfSeq: f.files.has(from) ? null : 1,
		});
	await refuses(move("drafts/x", "apps/x"), "APP_MOVE_REFUSED");
	await refuses(move("drafts/x/app.toml", "apps/sales/app.toml"), "APP_MOVE_REFUSED");
	await refuses(move("drafts/note.md", "apps/sales/note.md"), "APP_NOT_YOURS");
});

it("reviews posting, and changing another's app, as delegation", async () => {
	const { cloudActionEffect, describeCloudAction } = await import("@qorpera/runtime/cloud-action-review");
	const runtime = (name: string) => ({ name, source: "runtime" as const });
	expect(cloudActionEffect(runtime("save_app"), { name: "sales" })).toBe("internal");
	expect(cloudActionEffect(runtime("save_app"), { name: "sales", foreignOwner: true })).toBe("delegation");
	expect(cloudActionEffect(runtime("post_app"), { name: "sales", posted: true })).toBe("delegation");
	expect(describeCloudAction(runtime("post_app"), { name: "sales", posted: true }).title).toBe(
		"Post an app for every member",
	);
	expect(describeCloudAction(runtime("save_app"), { name: "sales", foreignOwner: true }).title).toBe(
		"Change another agent's app",
	);
});

it("counts a video as a file of its app, but not toward the bytes of the rest", async () => {
	const app = 'name = "Ideas"\nowner = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f"\nposted = false\n';
	const big = await fixture({
		folders: ["apps"],
		files: {
			"apps/ideas/app.toml": app,
			"apps/ideas/index.html": PAGE,
			"apps/ideas/a.mp4": "x".repeat(5 * 1024 * 1024),
		},
	});
	// Refused, this would throw.
	await big.call("save_app", save("ideas", "video-1", null, [{ path: "more.txt", text: "more" }]));
	const notes = Object.fromEntries(Array.from({ length: 62 }, (_, n) => [`apps/ideas/n${n}.txt`, "note"]));
	const full = await fixture({
		folders: ["apps"],
		files: { "apps/ideas/app.toml": app, "apps/ideas/index.html": PAGE, "apps/ideas/a.mp4": "x", ...notes },
	});
	await refuses(
		full.call("save_app", save("ideas", "video-2", null, [{ path: "one-more.txt", text: "more" }])),
		"APP_TOO_LARGE",
	);
});
