import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderError } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue, context = f.context) =>
		tool(name).execute(tool(name).parseArguments(value), context);
	return { ...f, tools, tool, call };
}

const parse = (content: CloudToolContent) => JSON.parse(String(content.value));
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
async function refuses(
	call: Promise<unknown>,
	type: typeof CloudToolRefusal | typeof CloudToolArgumentRefusal,
	text: string,
) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(type);
	expect((error as Error).message).toContain(text);
}

it("offers the five tools as Company File tools, with the legacy names", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([
		["company_read", "company_file"],
		["company_list", "company_file"],
		["company_write", "company_file"],
		["company_mkdir", "company_file"],
		["company_delete", "company_file"],
	]);
});

it("reads a window of a file, releases exactly the text shown and cites the release", async () => {
	const f = await fixture({ files: { "docs/plan.md": "the plan, in full" } });
	const content = await f.call("company_read", { path: "docs/plan.md", offset: 4, limit: 4 });
	const answer = parse(content);
	expect(answer).toEqual({
		path: "docs/plan.md",
		kind: "file",
		version: f.files.get("docs/plan.md")?.version,
		offset: 4,
		bytesRead: 4,
		totalBytes: 17,
		text: "plan",
		nextOffset: 8,
	});
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({
		p_release_id: content.companyReadId,
		p_output_sha256: sha(String(content.value)),
		p_reads: [
			{
				path: "docs/plan.md",
				version: f.files.get("docs/plan.md")?.version,
				fileSha256: f.files.get("docs/plan.md")?.file.fileSha256,
			},
		],
	});
	// The last window has no next offset.
	expect(parse(await f.call("company_read", { path: "docs/plan.md", offset: 12, limit: 4096 }))).toMatchObject({
		text: " full",
		nextOffset: null,
	});
});

it("leaves a code point cut by the window for the next one, and refuses bytes that are not text", async () => {
	const f = await fixture({ files: { "notes.md": "aé€b" } });
	// a (1) é (2) € (3): a window of 4 bytes ends inside the euro sign.
	expect(parse(await f.call("company_read", { path: "notes.md", offset: 0, limit: 4 }))).toMatchObject({
		text: "aé",
		bytesRead: 3,
		nextOffset: 3,
	});
	expect(parse(await f.call("company_read", { path: "notes.md", offset: 3, limit: 4 }))).toMatchObject({
		text: "€b",
		nextOffset: null,
	});
	// Starting inside a code point is not text.
	await refuses(
		f.call("company_read", { path: "notes.md", offset: 2, limit: 4 }),
		CloudToolRefusal,
		"COMPANY_FILE_NOT_TEXT",
	);
	expect(f.releases).toHaveLength(2);
	// Past the end: an empty window, which still shows (and releases) the file's size and version.
	const past = await f.call("company_read", { path: "notes.md", offset: 99, limit: 4 });
	expect(parse(past)).toMatchObject({ offset: 99, bytesRead: 0, totalBytes: 7, text: "", nextOffset: null });
	expect(past.companyReadId).toBe(f.releases[2]?.p_release_id);
});

it("refuses an answer that cannot reach the model whole, before releasing anything", async () => {
	// Each & is escaped to six bytes by the fence: even the smallest answer for this path would be cut.
	const name = `d/${"&".repeat(1300)}.md`;
	const f = await fixture({ files: { [name]: "x" } });
	await refuses(
		f.call("company_read", { path: name, offset: 0, limit: 4 }),
		CloudToolRefusal,
		"COMPANY_FILE_ANSWER_TOO_LONG",
	);
	await refuses(
		f.call("company_list", { path: "d", after: null, limit: 5 }),
		CloudToolRefusal,
		"COMPANY_FILE_ANSWER_TOO_LONG",
	);
	expect(f.releases).toHaveLength(0);
});

it("cuts a window whose answer would not fit one result, so the model sees all it is released for", async () => {
	const f = await fixture({ files: { "angles.md": "<".repeat(4096) } });
	const content = await f.call("company_read", { path: "angles.md", offset: 0, limit: 4096 });
	const answer = parse(content);
	expect(fitsOneResult(String(content.value))).toBe(true);
	expect(answer.bytesRead).toBeGreaterThan(0);
	expect(answer.bytesRead).toBeLessThan(4096);
	expect(answer.text).toBe("<".repeat(answer.bytesRead));
	expect(answer.nextOffset).toBe(answer.bytesRead);
	expect(f.releases[0]?.p_output_sha256).toBe(sha(String(content.value)));
});

it("reads a folder and an absent path: a folder is released, nothing is for an absent path", async () => {
	const f = await fixture({ folders: ["docs"] });
	const folder = await f.call("company_read", { path: "docs", offset: 0, limit: 4 });
	expect(parse(folder)).toMatchObject({ path: "docs", kind: "folder" });
	expect(folder.companyReadId).toBe(f.releases[0]?.p_release_id);
	const absent = await f.call("company_read", { path: "docs/none.md", offset: 0, limit: 4 });
	expect(parse(absent)).toEqual({ path: "docs/none.md", kind: "absent", version: null });
	expect(absent.companyReadId).toBeUndefined();
	expect(f.releases).toHaveLength(1);
});

it("lists a folder page by page, releasing the folder and every entry shown", async () => {
	const f = await fixture({
		files: { "docs/a.md": "a", "docs/b.md": "bb", "docs/c.md": "ccc" },
		folders: ["docs/old"],
	});
	const first = await f.call("company_list", { path: "docs", after: null, limit: 2 });
	const page = parse(first);
	expect(page).toMatchObject({
		path: "docs",
		kind: "folder",
		entries: [
			{ path: "docs/a.md", kind: "file", bytes: 1 },
			{ path: "docs/b.md", kind: "file", bytes: 2 },
		],
		next: "docs/b.md",
	});
	expect((f.releases[0]?.p_reads as { path: string }[]).map((read) => read.path)).toEqual([
		"docs",
		"docs/a.md",
		"docs/b.md",
	]);
	expect(first.companyReadId).toBe(f.releases[0]?.p_release_id);
	const second = parse(await f.call("company_list", { path: "docs", after: page.next, limit: 2 }));
	expect(second.entries.map((entry: { path: string }) => entry.path)).toEqual(["docs/c.md", "docs/old"]);
	expect(second.entries[1]).toMatchObject({ kind: "folder", bytes: null });
	// The top of the folder has no entry of its own.
	const top = parse(await f.call("company_list", { path: "", after: null, limit: 50 }));
	expect(top.version).toBeNull();
	expect(top.entries.map((entry: { path: string }) => entry.path)).toEqual(["agents", "docs"]);
	expect((f.releases[2]?.p_reads as { path: string }[]).map((read) => read.path)).toEqual(["agents", "docs"]);
});

it("shows a wide page as the entries that fit one result, going on after the last shown", async () => {
	const files: Record<string, string> = {};
	for (let index = 0; index < 50; index++) files[`wide/${String(index).padStart(2, "0")}-${"x".repeat(200)}.md`] = "x";
	const f = await fixture({ files });
	const content = await f.call("company_list", { path: "wide", after: null, limit: 50 });
	const page = parse(content);
	expect(fitsOneResult(String(content.value))).toBe(true);
	expect(page.entries.length).toBeGreaterThan(0);
	expect(page.entries.length).toBeLessThan(50);
	expect(page.next).toBe(page.entries.at(-1).path);
	expect(f.releases[0]?.p_reads).toHaveLength(page.entries.length + 1);
});

it("lists an absent path as absent and refuses to list a file", async () => {
	const f = await fixture({ files: { "docs/a.md": "a" } });
	expect(parse(await f.call("company_list", { path: "gone", after: null, limit: 5 }))).toEqual({
		path: "gone",
		kind: "absent",
		version: null,
		entries: [],
		next: null,
	});
	await refuses(
		f.call("company_list", { path: "docs/a.md", after: null, limit: 5 }),
		CloudToolRefusal,
		"COMPANY_FILE_NOT_A_FOLDER",
	);
	expect(f.releases).toHaveLength(0);
});

it("writes a file as one change set under the call's receipt, and replays the same call from it", async () => {
	const f = await fixture({ folders: ["docs"] });
	const write = { path: "docs/new.md", operationKey: "write-1", expectedVersion: null, text: "# New\n" };
	const answer = parse(await f.call("company_write", write));
	expect(answer).toMatchObject({
		schema: "qorpera.company-folder-result/v1",
		state: "applied",
		operationKey: "write-1",
		path: "docs/new.md",
		version: f.files.get("docs/new.md")?.version,
		outcome: "saved",
	});
	expect(f.text("docs/new.md")).toBe("# New\n");
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({
		key: `company_write:${sha("write-1")}`,
		receiptId: answer.receiptId,
		reviewId: undefined,
	});
	expect(f.commits[0]?.units).toEqual([{ op: "write", path: "docs/new.md", file: expect.any(Object) }]);
	expect(f.operationControl.completeFolderToolOperation).toHaveBeenCalledTimes(1);
	// The same call, again: the receipt answers and nothing is committed twice.
	const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const again = tools[2] as CloudNativeTool;
	expect(parse(await again.execute(again.parseArguments(write), f.context))).toEqual(answer);
	expect(f.commits).toHaveLength(1);
});

it("answers a stale version and a missing folder as not applied, with what to do next", async () => {
	const f = await fixture({ files: { "docs/plan.md": "one" } });
	const stale = parse(
		await f.call("company_write", {
			path: "docs/plan.md",
			operationKey: "write-1",
			expectedVersion: randomUUID(),
			text: "two",
		}),
	);
	expect(stale).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "version_changed", version: null });
	expect(stale.next).toContain("COMPANY_FILE_VERSION_CHANGED");
	const exists = parse(
		await f.call("company_write", {
			path: "docs/plan.md",
			operationKey: "write-2",
			expectedVersion: null,
			text: "x",
		}),
	);
	expect(exists).toMatchObject({ outcome: "conflict", reason: "exists" });
	expect(exists.next).toContain("COMPANY_FILE_EXISTS");
	const orphan = parse(
		await f.call("company_write", {
			path: "none/plan.md",
			operationKey: "write-3",
			expectedVersion: null,
			text: "x",
		}),
	);
	expect(orphan).toMatchObject({ state: "not_applied", outcome: "refused", reason: "parent_missing" });
	expect(orphan.next).toContain("COMPANY_FILE_PARENT_MISSING");
	expect(f.text("docs/plan.md")).toBe("one");
});

it("keeps a changed file's media type and executable bit", async () => {
	const f = await fixture({ files: { "code/run.sh": "echo one" } });
	const stored = f.files.get("code/run.sh");
	if (!stored) throw new Error("No seeded script");
	stored.file = { ...stored.file, mediaType: "text/x-shellscript", executable: true };
	const answer = parse(
		await f.call("company_write", {
			path: "code/run.sh",
			operationKey: "write-1",
			expectedVersion: stored.version,
			text: "echo two",
		}),
	);
	expect(answer).toMatchObject({ state: "applied" });
	expect(f.commits[0]?.units[0]?.file).toMatchObject({ mediaType: "text/x-shellscript", executable: true });
	// A new file gets the type its name gives.
	await f.call("company_write", {
		path: "code/new.md",
		operationKey: "write-2",
		expectedVersion: null,
		text: "# New",
	});
	expect(f.commits[1]?.units[0]?.file).toMatchObject({ mediaType: "text/markdown", executable: false });
});

it("makes a folder, and refuses a version for one", async () => {
	const f = await fixture();
	expect(
		parse(await f.call("company_mkdir", { path: "contracts", operationKey: "mkdir-1", expectedVersion: null })),
	).toMatchObject({ state: "applied", outcome: "saved", path: "contracts" });
	expect(f.folders.has("contracts")).toBe(true);
	expect(
		parse(await f.call("company_mkdir", { path: "contracts", operationKey: "mkdir-2", expectedVersion: null })),
	).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
	expect(() =>
		f.tool("company_mkdir").parseArguments({ path: "x", operationKey: "mkdir-3", expectedVersion: randomUUID() }),
	).toThrow(CloudToolArgumentRefusal);
});

// Ported from the path gateway's own tools (removed in C-P5): the run's identity, an approval or an address
// never comes from the model.
it("takes no identity, approval or address a model adds to a call, before anything is read", async () => {
	const f = await fixture({ files: { "docs/plan.md": "plan" } });
	const read = vi.spyOn(f.folder, "read");
	const extras: { [key: string]: JsonValue }[] = [
		{ companyId: randomUUID() },
		{ approved: true },
		{ binding: {} },
		{ sha256: "a".repeat(64) },
		{ url: "https://outside.example" },
	];
	const calls: [string, { [key: string]: JsonValue }][] = [
		["company_read", { path: "docs/plan.md", offset: 0, limit: 4 }],
		["company_list", { path: "docs", after: null, limit: 5 }],
		["company_write", { path: "docs/plan.md", operationKey: "w-1", expectedVersion: null, text: "x" }],
	];
	// Each call parses as it is; only the added key refuses it.
	for (const [name, value] of calls) f.tool(name).parseArguments(value);
	for (const extra of extras)
		for (const [name, value] of calls)
			expect(() => f.tool(name).parseArguments({ ...value, ...extra })).toThrow(CloudToolArgumentRefusal);
	expect(read).not.toHaveBeenCalled();
	expect(f.releases).toHaveLength(0);
	expect(f.commits).toHaveLength(0);
});

it("deletes a file with the review its call was approved under", async () => {
	const f = await fixture({ files: { "docs/old.md": "old" } });
	const expectedVersion = f.files.get("docs/old.md")?.version as string;
	const answer = parse(
		await f.call("company_delete", { path: "docs/old.md", operationKey: "delete-1", expectedVersion }),
	);
	expect(answer).toMatchObject({ state: "applied", outcome: "saved" });
	expect(f.files.has("docs/old.md")).toBe(false);
	expect(f.recordings).toHaveLength(1);
	expect(f.recordings[0]?.p_request).toMatchObject({
		actionReviewId: f.context.actionReviewId,
		tool: "company_delete",
		argumentSha256: f.context.argumentSha256,
	});
	expect(f.commits[0]?.reviewId).toBeDefined();
	expect(f.commits[0]?.units).toEqual([{ op: "delete", path: "docs/old.md", expectedVersion }]);
});

it("deletes an empty folder as of the listing that found it empty, and refuses a folder with something in it", async () => {
	const f = await fixture({ files: { "full/a.md": "a" }, folders: ["empty"] });
	const read = async (path: string) =>
		parse(await f.call("company_read", { path, offset: 0, limit: 4 })).version as string;
	const answer = parse(
		await f.call("company_delete", { path: "empty", operationKey: "delete-1", expectedVersion: await read("empty") }),
	);
	expect(answer).toMatchObject({ state: "applied", outcome: "saved" });
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "delete", path: "empty", asOfSeq: expect.any(Number) });
	await refuses(
		f.call("company_delete", { path: "full", operationKey: "delete-2", expectedVersion: await read("full") }),
		CloudToolRefusal,
		"COMPANY_FOLDER_NOT_EMPTY",
	);
	expect(f.commits).toHaveLength(1);
});

it("answers a folder that changed after the listing that found it empty as a conflict", async () => {
	const f = await fixture({ files: { "busy/new.md": "new" } });
	const version = parse(await f.call("company_read", { path: "busy", offset: 0, limit: 4 })).version as string;
	// The listing found it empty before the file came: the deletion is as of that listing.
	vi.spyOn(f.folder, "list").mockResolvedValueOnce({ asOfSeq: 0, entries: [], next: null });
	const answer = parse(
		await f.call("company_delete", { path: "busy", operationKey: "delete-1", expectedVersion: version }),
	);
	expect(answer).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "unseen_change" });
	expect(answer.next).toContain("COMPANY_FILE_VERSION_CHANGED");
	expect(f.commits[0]?.units[0]).toMatchObject({ op: "delete", path: "busy", asOfSeq: 0 });
	expect(f.files.has("busy/new.md")).toBe(true);
});

it("refuses a deletion with no approval before anything is written", async () => {
	const f = await fixture({ files: { "docs/old.md": "old" } });
	const { actionReviewId: _approval, ...context } = f.context;
	await refuses(
		f.call(
			"company_delete",
			{
				path: "docs/old.md",
				operationKey: "delete-1",
				expectedVersion: f.files.get("docs/old.md")?.version as string,
			},
			context,
		),
		CloudToolRefusal,
		"approval",
	);
	expect(f.commits).toHaveLength(0);
	expect(f.files.has("docs/old.md")).toBe(true);
});

it("tells the model the company's work is stopped, or the folder unavailable, and shows nothing", async () => {
	const f = await fixture({ files: { "docs/plan.md": "plan" } });
	const read = vi.spyOn(f.folder, "read").mockRejectedValueOnce(new CloudCompanyFolderError("stopped"));
	await refuses(
		f.call("company_read", { path: "docs/plan.md", offset: 0, limit: 4 }),
		CloudToolRefusal,
		"COMPANY_WORK_STOPPED",
	);
	read.mockRejectedValueOnce(new CloudCompanyFolderError("unavailable"));
	await refuses(
		f.call("company_list", { path: "docs", after: null, limit: 5 }),
		CloudToolRefusal,
		"COMPANY_FOLDER_UNAVAILABLE",
	);
	// A read the run may no longer make is not shown.
	read.mockRestore();
	vi.spyOn(f.folder, "release").mockRejectedValueOnce(new CloudCompanyFolderError("read_revoked"));
	await refuses(
		f.call("company_read", { path: "docs/plan.md", offset: 0, limit: 4 }),
		CloudToolRefusal,
		"READ_REVOKED",
	);
	expect(f.releases).toHaveLength(0);
});
