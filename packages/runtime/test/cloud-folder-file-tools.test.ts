import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { CloudCompanyFolderError } from "@qorpera/runtime/cloud-company-folder-client";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	CloudNativeToolBoundary,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { fitsOneResult } from "@qorpera/runtime/cloud-worker-tools";
import { afterEach, expect, it, vi } from "vitest";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";
import { PNG_SIGNATURE, pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

async function fixture(
	seed: Parameters<typeof folderWriterFixture>[0] = {},
	options: Parameters<typeof folderWriterFixture>[1] = {},
) {
	const f = await folderWriterFixture(seed, options);
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

it("offers the seven tools as Company File tools, with the legacy names", async () => {
	const f = await fixture();
	expect(f.tools.map((tool) => [tool.name, tool.source])).toEqual([
		["company_read", "company_file"],
		["company_list", "company_file"],
		["company_write", "company_file"],
		["company_edit", "company_file"],
		["company_move", "company_file"],
		["company_mkdir", "company_file"],
		["company_delete", "company_file"],
	]);
	// A write or an edit carries a file's text, up to 512 KiB of it, escaped: their own argument bound.
	expect(f.tools.filter((tool) => tool.maxArgumentBytes !== undefined).map((tool) => tool.name)).toEqual([
		"company_write",
		"company_edit",
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

/** A 2×1 PNG: a red pixel, then a blue one. */
const RED_BLUE = pngFile(pngHeader(2, 1, 8, 2), pngRows([[255, 0, 0, 0, 0, 255]]));

it("shows an image read from its start as one PNG made here, after a released answer that names its hash", async () => {
	const f = await fixture();
	f.seed("photos/pair.png", RED_BLUE, "image/png");
	const stored = f.files.get("photos/pair.png");
	const content = await f.call("company_read", { path: "photos/pair.png", offset: 0, limit: 4 });
	const png = content.image?.png ?? Buffer.alloc(0);
	expect(parse(content)).toEqual({
		path: "photos/pair.png",
		kind: "image",
		version: stored?.version,
		mediaType: "image/png",
		totalBytes: RED_BLUE.byteLength,
		width: 2,
		height: 1,
		shownWidth: 2,
		shownHeight: 1,
		imageSha256: content.image?.sha256,
	});
	expect(png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
	expect(content.image?.sha256).toBe(createHash("sha256").update(png).digest("hex"));
	expect(f.releases).toHaveLength(1);
	expect(f.releases[0]).toMatchObject({
		p_release_id: content.companyReadId,
		p_output_sha256: sha(String(content.value)),
		p_reads: [{ path: "photos/pair.png", version: stored?.version, fileSha256: stored?.file.fileSha256 }],
	});
	// Its own start says what it is, whatever type it was stored with.
	f.seed("photos/pair.bin", RED_BLUE, "application/octet-stream");
	const untyped = await f.call("company_read", { path: "photos/pair.bin", offset: 0, limit: 4 });
	expect(parse(untyped)).toMatchObject({ kind: "image", mediaType: "image/png", imageSha256: content.image?.sha256 });
	// Read from anywhere else, it is a window of its bytes like any file.
	const window = await f.call("company_read", { path: "photos/pair.png", offset: 1, limit: 4 });
	expect(parse(window)).toMatchObject({ kind: "file", text: "PNG\r", nextOffset: 5 });
	expect(window.image).toBeUndefined();
	// An SVG is text.
	f.seed("photos/logo.svg", "<svg/>", "image/svg+xml");
	expect(parse(await f.call("company_read", { path: "photos/logo.svg", offset: 0, limit: 64 }))).toMatchObject({
		kind: "file",
		text: "<svg/>",
	});
});

it("refuses an image it does not show by name, before releasing anything", async () => {
	const f = await fixture();
	const refused = async (bytes: Uint8Array | string, mediaType: string, text: string) => {
		f.seed("photos/refused", bytes, mediaType);
		await refuses(f.call("company_read", { path: "photos/refused", offset: 0, limit: 4096 }), CloudToolRefusal, text);
	};
	const opening = "; open it on the company's computer";
	// Another format, named by its own start or by its type.
	await refused(
		Buffer.from("II*\0 a TIFF file", "latin1"),
		"image/tiff",
		`COMPANY_IMAGE_FORMAT_UNSUPPORTED: only PNG, JPEG, GIF and WebP images are shown here, and this one is TIFF${opening}`,
	);
	await refused(
		"not a picture",
		"image/heic",
		`COMPANY_IMAGE_FORMAT_UNSUPPORTED: only PNG, JPEG, GIF and WebP images are shown here${opening}`,
	);
	// A type that says PNG over bytes that are not one.
	await refused(
		"not a picture",
		"image/png",
		`COMPANY_IMAGE_UNREADABLE: the file is not the image its type says${opening}`,
	);
	// Too many pixels, from the header alone; too many bytes, before reading it.
	await refused(
		Buffer.concat([PNG_SIGNATURE, pngHeader(8000, 6000, 8, 2)]),
		"image/png",
		`COMPANY_IMAGE_TOO_LARGE: the image has 8000×6000 pixels, more than the 40 million shown here${opening}`,
	);
	const huge = Buffer.alloc(64 * 1024 * 1024 + 1);
	PNG_SIGNATURE.copy(huge);
	await refused(huge, "image/png", `COMPANY_IMAGE_TOO_LARGE: the file is larger than 64 MiB${opening}`);
	// A damaged PNG.
	const damaged = Buffer.from(RED_BLUE);
	damaged[29] ^= 1;
	await refused(damaged, "image/png", `COMPANY_IMAGE_UNREADABLE: a PNG chunk is damaged${opening}`);
	expect(f.releases).toHaveLength(0);
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

it("reads and lists a link as the target it holds, never following it, and lists nothing under it", async () => {
	const f = await fixture({ files: { "docs/plan.md": "the plan" }, links: { "docs/latest": "plan.md" } });
	const version = f.links.get("docs/latest")?.version;
	const read = await f.call("company_read", { path: "docs/latest", offset: 0, limit: 4096 });
	expect(parse(read)).toEqual({
		path: "docs/latest",
		kind: "symlink",
		version,
		offset: 0,
		bytesRead: 7,
		totalBytes: 7,
		target: "plan.md",
		nextOffset: null,
	});
	// The link is released, and nothing of the file it names.
	expect(read.companyReadId).toBe(f.releases[0]?.p_release_id);
	expect(f.releases[0]?.p_reads).toEqual([{ path: "docs/latest", version, authority: expect.any(Object) }]);
	// A path through a link is absent: the core never resolves one (LK1).
	const through = await f.call("company_read", { path: "docs/latest/plan.md", offset: 0, limit: 4 });
	expect(parse(through)).toEqual({ path: "docs/latest/plan.md", kind: "absent", version: null });
	const page = parse(await f.call("company_list", { path: "docs", after: null, limit: 5 }));
	expect(page.entries).toEqual([
		{ path: "docs/latest", kind: "symlink", version, bytes: null, target: "plan.md" },
		{ path: "docs/plan.md", kind: "file", version: f.files.get("docs/plan.md")?.version, bytes: 8 },
	]);
	await refuses(
		f.call("company_list", { path: "docs/latest", after: null, limit: 5 }),
		CloudToolRefusal,
		"COMPANY_FILE_NOT_A_FOLDER: that path is a link",
	);
	expect(f.releases).toHaveLength(2);
});

it("reads a link's target in windows that each fit one result, however much its characters escape", async () => {
	for (const target of ["&".repeat(4095), "\u0001".repeat(4095)]) {
		const f = await fixture({ links: { "docs/latest": target } });
		let shown = "";
		let offset: number | null = 0;
		let windows = 0;
		while (offset !== null) {
			const content = await f.call("company_read", { path: "docs/latest", offset, limit: 4096 });
			expect(fitsOneResult(String(content.value))).toBe(true);
			const answer = parse(content);
			expect(answer).toMatchObject({ kind: "symlink", offset, totalBytes: 4095 });
			expect(answer.bytesRead).toBeGreaterThan(0);
			shown += answer.target;
			offset = answer.nextOffset;
			windows++;
		}
		expect(shown).toBe(target);
		expect(windows).toBeGreaterThan(4);
		// Each window is released as shown.
		expect(f.releases).toHaveLength(windows);
	}
	// A window that starts inside a character is not text, one that ends inside one stops before it, and one past the
	// end is empty.
	const accent = await fixture({ links: { "docs/accent": "é".repeat(10) } });
	await refuses(
		accent.call("company_read", { path: "docs/accent", offset: 1, limit: 4 }),
		CloudToolRefusal,
		"COMPANY_FILE_NOT_TEXT",
	);
	expect(parse(await accent.call("company_read", { path: "docs/accent", offset: 2, limit: 5 }))).toMatchObject({
		target: "éé",
		bytesRead: 4,
		nextOffset: 6,
	});
	expect(parse(await accent.call("company_read", { path: "docs/accent", offset: 99, limit: 4 }))).toMatchObject({
		target: "",
		bytesRead: 0,
		totalBytes: 20,
		nextOffset: null,
	});
});

it("cuts a listed link's target, and a first link's further when its path is long", async () => {
	const long = "\u0001".repeat(4095);
	// Its path, escaped and shown twice (the entry and next), leaves less than 512 bytes of the target room.
	const wide = `docs/${"&".repeat(300)}`;
	const f = await fixture({ files: { "docs/b.md": "b" }, links: { [wide]: long, "docs/a": long, "docs/c": "b.md" } });
	const first = await f.call("company_list", { path: "docs", after: null, limit: 50 });
	expect(fitsOneResult(String(first.value))).toBe(true);
	const page = parse(first);
	expect(page.entries).toEqual([
		{
			path: wide,
			kind: "symlink",
			version: f.links.get(wide)?.version,
			bytes: null,
			target: expect.any(String),
			targetCut: true,
		},
	]);
	expect(page.entries[0].target.length).toBeGreaterThan(0);
	expect(page.entries[0].target.length).toBeLessThan(512);
	expect(long.startsWith(page.entries[0].target)).toBe(true);
	expect(page.next).toBe(wide);
	const second = await f.call("company_list", { path: "docs", after: page.next, limit: 50 });
	expect(fitsOneResult(String(second.value))).toBe(true);
	expect(parse(second)).toMatchObject({
		entries: [
			{
				path: "docs/a",
				kind: "symlink",
				version: f.links.get("docs/a")?.version,
				bytes: null,
				target: "\u0001".repeat(512),
				targetCut: true,
			},
			{ path: "docs/b.md", kind: "file", bytes: 1 },
			{ path: "docs/c", kind: "symlink", target: "b.md" },
		],
		next: null,
	});
	expect(parse(second).entries[2]).not.toHaveProperty("targetCut");
});

it("names as much of a long link's target as fits when it refuses to write over the link", async () => {
	const f = await fixture({ links: { "docs/long": "\u0001".repeat(4095) } });
	const expectedVersion = f.links.get("docs/long")?.version as string;
	const refused = await f.call("company_write", {
		path: "docs/long",
		operationKey: "write-1",
		expectedVersion,
		text: "x",
	});
	expect(fitsOneResult(String(refused.value))).toBe(true);
	const answer = parse(refused);
	expect(answer).toMatchObject({
		state: "not_applied",
		reason: "link",
		targetCut: true,
		next: expect.stringContaining("read the link with company_read for all of it"),
	});
	expect(answer.target.length).toBeGreaterThan(0);
	expect("\u0001".repeat(4095).startsWith(answer.target)).toBe(true);
	expect(refused.companyReadId).toBe(f.releases[0]?.p_release_id);
	expect(f.commits).toHaveLength(0);
});

it("never writes over a link at its version, naming its target, and meets one as there when creating a file", async () => {
	const f = await fixture({ links: { "docs/latest": "plan.md" } });
	const expectedVersion = f.links.get("docs/latest")?.version as string;
	const refused = await f.call("company_write", {
		path: "docs/latest",
		operationKey: "write-1",
		expectedVersion,
		text: "x",
	});
	expect(parse(refused)).toEqual({
		schema: "qorpera.company-folder-result/v1",
		state: "not_applied",
		operationKey: "write-1",
		path: "docs/latest",
		version: null,
		reason: "link",
		target: "plan.md",
		next: expect.stringContaining("COMPANY_FILE_IS_A_LINK: nothing was written"),
	});
	// The target shown is a read of the link, released; nothing was written and no receipt taken.
	expect(refused.companyReadId).toBe(f.releases[0]?.p_release_id);
	expect(f.releases[0]?.p_reads).toEqual([
		{ path: "docs/latest", version: expectedVersion, authority: expect.any(Object) },
	]);
	expect(f.commits).toHaveLength(0);
	expect(f.ledger.size).toBe(0);
	const exists = parse(
		await f.call("company_write", { path: "docs/latest", operationKey: "write-2", expectedVersion: null, text: "x" }),
	);
	expect(exists).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
	const mkdir = parse(
		await f.call("company_mkdir", { path: "docs/latest", operationKey: "mkdir-1", expectedVersion: null }),
	);
	expect(mkdir).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
	expect(f.links.get("docs/latest")).toMatchObject({ version: expectedVersion, target: "plan.md" });
	expect(f.files.has("docs/latest")).toBe(false);
	expect(f.folders.has("docs/latest")).toBe(false);
});

it("deletes a link, never the file it names", async () => {
	const f = await fixture({ files: { "docs/plan.md": "the plan" }, links: { "docs/latest": "plan.md" } });
	const expectedVersion = f.links.get("docs/latest")?.version as string;
	const answer = parse(
		await f.call("company_delete", { path: "docs/latest", operationKey: "delete-1", expectedVersion }),
	);
	expect(answer).toMatchObject({ state: "applied", outcome: "saved" });
	expect(f.commits[0]?.units).toEqual([{ op: "delete", path: "docs/latest", expectedVersion }]);
	expect(f.links.has("docs/latest")).toBe(false);
	expect(f.text("docs/plan.md")).toBe("the plan");
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

it("tells the model a page or table layout change is never made, and another rule's refusal can be fixed", async () => {
	const layout = { code: "layout_authoring", message: "page and table layout authoring is not available" };
	const f = await fixture(
		{ folders: ["interfaces", "docs"] },
		{
			hook: (path) =>
				path.startsWith("interfaces/")
					? { outcome: "refused", reason: "structured_rule", problems: [layout] }
					: path === "docs/rule.md"
						? {
								outcome: "refused",
								reason: "structured_rule",
								problems: [{ code: "other_rule", message: "fix it" }],
							}
						: null,
		},
	);
	const write = async (path: string, operationKey: string) =>
		parse(await f.call("company_write", { path, operationKey, expectedVersion: null, text: "x" }));
	const page = await write("interfaces/page.md", "write-page");
	expect(page).toMatchObject({
		state: "not_applied",
		outcome: "refused",
		reason: "structured_rule",
		problems: [layout],
	});
	expect(page.next).toContain("COMPANY_FILE_LAYOUT_AUTHORING: nothing was written");
	expect(page.next).toContain("Do not make this change again");
	expect(page.next).not.toContain("call again");
	const other = await write("docs/rule.md", "write-rule");
	expect(other).toMatchObject({ state: "not_applied", outcome: "refused", reason: "structured_rule" });
	expect(other.next).not.toContain("COMPANY_FILE_LAYOUT_AUTHORING");
	expect(other.next).toContain("call again with a new operationKey");
	expect(f.text("interfaces/page.md")).toBeNull();
	expect(f.text("docs/rule.md")).toBeNull();
});

it("observes a change that was not saved as denied with why, a replay too, and a parked one as proposed", async () => {
	const f = await fixture(
		{ files: { "docs/plan.md": "one" }, folders: ["docs", "held"] },
		{
			hook: (path) =>
				path === "docs/locked.md"
					? { outcome: "denied", reason: "denied" }
					: path === "held/plan.md"
						? { outcome: "waiting_for_review", reason: "waiting_for_review" }
						: path === "docs/bad.md"
							? { outcome: "refused", reason: "too_long" }
							: null,
		},
	);
	const observability = new CloudRuntimeObservability({
		assignmentId: f.binding.assignmentId,
		publish: async () => {},
	});
	const observed = async (tools: CloudNativeTool[], value: JsonValue) => {
		const span = observability.start("company_write");
		const tool = tools[2] as CloudNativeTool;
		await tool.execute(tool.parseArguments(value), { ...f.context, observation: span });
		return { status: span.result?.status, errorCategory: span.result?.errorCategory };
	};
	const write = (path: string, operationKey: string, expectedVersion: string | null = null) => ({
		path,
		operationKey,
		expectedVersion,
		text: "x",
	});
	const orphan = write("none/plan.md", "write-orphan");
	const denied = (errorCategory: string) => ({ status: "denied", errorCategory });
	expect(await observed(f.tools, write("docs/new.md", "write-new"))).toEqual({
		status: "succeeded",
		errorCategory: null,
	});
	expect(await observed(f.tools, write("docs/plan.md", "write-stale", randomUUID()))).toEqual(denied("stale_version"));
	expect(await observed(f.tools, write("docs/plan.md", "write-exists"))).toEqual(denied("stale_version"));
	expect(await observed(f.tools, orphan)).toEqual(denied("parent_missing"));
	expect(await observed(f.tools, write("docs/locked.md", "write-locked"))).toEqual(denied("authority_unavailable"));
	expect(await observed(f.tools, write("docs/bad.md", "write-bad"))).toEqual(denied("invalid_arguments"));
	expect(await observed(f.tools, write("held/plan.md", "write-held"))).toEqual({
		status: "proposed",
		errorCategory: "protected_path",
	});
	// The same refused call again, in this run and after a restart: its receipt answers, and nothing happened.
	expect(await observed(f.tools, orphan)).toEqual(denied("parent_missing"));
	const restarted = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	expect(await observed(restarted, orphan)).toEqual(denied("parent_missing"));
	expect(f.text("docs/locked.md")).toBeNull();
	await observability.close();
});

it("observes a refusal answered before any receipt as denied at the boundary, and the model's answer stays ok", async () => {
	const f = await fixture({ links: { "docs/latest": "plan.md" } });
	const rows: CloudRuntimeObservation[] = [];
	const observability = new CloudRuntimeObservability({
		assignmentId: f.binding.assignmentId,
		publish: async (batch) => {
			rows.push(...batch);
		},
		batchDelayMs: 0,
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: f.identity.companyId,
		runId: f.identity.runId,
		identity: f.identity,
		tools: f.tools,
		assertActive: async () => undefined,
		signal: new AbortController().signal,
		observability,
	});
	const write = async (callId: string, path: string, expectedVersion: string | null) => {
		const response = await boundary.invoke(callId, "qorpera", "company_write", {
			path,
			operationKey: callId,
			expectedVersion,
			text: "x",
		});
		return JSON.parse(response.contentItems[0]?.text ?? "null").status;
	};
	expect(await write("write-link", "docs/latest", f.links.get("docs/latest")?.version as string)).toBe("ok");
	expect(await write("write-orphan", "none/plan.md", null)).toBe("ok");
	expect(await write("write-new", "docs/new.md", null)).toBe("ok");
	boundary.close();
	await observability.close();
	expect(
		rows
			.filter((row) => row.phase === "finish" && row.operation === "company_write")
			.map((row) => [row.status, row.errorCategory]),
	).toEqual([
		["denied", "invalid_arguments"],
		["denied", "parent_missing"],
		["succeeded", null],
	]);
	expect(f.links.has("docs/latest")).toBe(true);
	expect(f.text("docs/new.md")).toBe("x");
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

it("notes a change of the company's pages and tables in the run's conversation, a replay's too (I10)", async () => {
	const f = await fixture({
		files: { "interfaces/pulse/README.md": "About Pulse.\n", "docs/plan.md": "plan" },
		folders: ["Tables"],
	});
	const note = vi.spyOn(f.folder, "noteInterfaceChanges");
	const asked = { p_binding: f.binding, p_request: {} };
	const version = (path: string) => f.files.get(path)?.version as string;
	const readme = {
		path: "interfaces/pulse/README.md",
		operationKey: "write-1",
		expectedVersion: version("interfaces/pulse/README.md"),
		text: "About Pulse, by the agent.\n",
	};
	expect(parse(await f.call("company_write", readme))).toMatchObject({ state: "applied" });
	// A folder by its path in any case: the folder's paths are one path in any case.
	const mkdir = { path: "Tables/leads", operationKey: "mkdir-1", expectedVersion: null };
	expect(parse(await f.call("company_mkdir", mkdir))).toMatchObject({ state: "applied" });
	// SQL notes each of the run's commits there once.
	expect(f.notes).toEqual([asked, asked]);
	expect(await Promise.all(note.mock.results.map((result) => result.value))).toEqual([1, 1]);
	// A change anywhere else is no page's or table's: no note is asked for.
	const plan = { path: "docs/plan.md", operationKey: "write-2", expectedVersion: version("docs/plan.md") };
	expect(parse(await f.call("company_write", { ...plan, text: "two" }))).toMatchObject({ state: "applied" });
	expect(f.notes).toHaveLength(2);
	// A note that fails after the commit is a folder error, never a refusal (which says nothing happened): the call is
	// unconfirmed.
	const folder = parse(await f.call("company_read", { path: "Tables/leads", offset: 0, limit: 4 })).version as string;
	const deletion = { path: "Tables/leads", operationKey: "delete-1", expectedVersion: folder };
	note.mockRejectedValueOnce(new CloudCompanyFolderError("unavailable"));
	const error = await f.call("company_delete", deletion).then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudCompanyFolderError);
	expect(error).not.toBeInstanceOf(CloudToolRefusal);
	expect(f.folders.has("Tables/leads")).toBe(false);
	expect(f.notes).toEqual([asked, asked]);
	// The same call again, as a later turn makes it: its receipt answers, nothing is committed twice, and the change
	// gets its note.
	const commits = f.commits.length;
	const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const again = tools.find((tool) => tool.name === "company_delete") as CloudNativeTool;
	expect(parse(await again.execute(again.parseArguments(deletion), f.context))).toMatchObject({ state: "applied" });
	expect(f.commits).toHaveLength(commits);
	expect(f.notes).toEqual([asked, asked, asked]);
	await expect(note.mock.results.at(-1)?.value).resolves.toBe(1);
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

// The 21 October 2026 amendment "how agents start work and use the company folder", item 5.
it("reads a window of up to 8 KiB, shown as far as one result holds, and writes a file of up to 512 KiB", async () => {
	const prose = "Sales by region and month. ".repeat(400);
	const f = await fixture({ files: { "sales/notes.md": prose }, folders: ["sales"] });
	const content = await f.call("company_read", { path: "sales/notes.md", offset: 0, limit: 8192 });
	const answer = parse(content);
	expect(fitsOneResult(String(content.value))).toBe(true);
	expect(answer.bytesRead).toBeGreaterThan(4096);
	expect(answer.text).toBe(prose.slice(0, answer.bytesRead));
	expect(answer.nextOffset).toBe(answer.bytesRead);
	expect(() => f.tool("company_read").parseArguments({ path: "sales/notes.md", offset: 0, limit: 8193 })).toThrow(
		CloudToolArgumentRefusal,
	);
	const page = `<!doctype html><html><body>${"<div>row</div>\n".repeat(30000)}</body></html>`;
	expect(Buffer.byteLength(page)).toBeGreaterThan(400 * 1024);
	expect(
		parse(
			await f.call("company_write", {
				path: "sales/sales-dashboard.html",
				operationKey: "write-page",
				expectedVersion: null,
				text: page,
			}),
		),
	).toMatchObject({ state: "applied" });
	expect(f.text("sales/sales-dashboard.html")).toBe(page);
	expect(() =>
		f.tool("company_write").parseArguments({
			path: "sales/too-large.html",
			operationKey: "write-too-large",
			expectedVersion: null,
			text: "x".repeat(512 * 1024 + 1),
		}),
	).toThrow(CloudToolArgumentRefusal);
});

it("edits one exact span of a file under the version read, and replays the same call from its receipt", async () => {
	const f = await fixture({ files: { "sales/page.html": "<h1>Sales</h1>\n<p>Q3</p>\n" } });
	const expectedVersion = f.files.get("sales/page.html")?.version as string;
	const edit = {
		path: "sales/page.html",
		operationKey: "edit-1",
		expectedVersion,
		oldText: "<p>Q3</p>",
		newText: "<p>Q4</p>",
	};
	const answer = parse(await f.call("company_edit", edit));
	expect(answer).toMatchObject({
		schema: "qorpera.company-folder-result/v1",
		state: "applied",
		operationKey: "edit-1",
		path: "sales/page.html",
		version: f.files.get("sales/page.html")?.version,
		outcome: "saved",
	});
	expect(f.text("sales/page.html")).toBe("<h1>Sales</h1>\n<p>Q4</p>\n");
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0]).toMatchObject({ key: `company_edit:${sha("edit-1")}`, receiptId: answer.receiptId });
	expect(f.commits[0]?.units).toEqual([
		{ op: "write", path: "sales/page.html", file: expect.any(Object), expectedVersion },
	]);
	// The same call, again: the file is at a new version now, and the receipt answers; nothing is committed twice.
	const tools = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity });
	const again = tools.find((tool) => tool.name === "company_edit") as CloudNativeTool;
	expect(parse(await again.execute(again.parseArguments(edit), f.context))).toEqual(answer);
	expect(f.commits).toHaveLength(1);
});

it("refuses an edit whose text is not found once, and answers a stale version as the core's conflict", async () => {
	const f = await fixture({ files: { "docs/list.md": "- a\n- a\n- b\n" } });
	const version = (path: string) => f.files.get(path)?.version as string;
	const edit = (oldText: string, operationKey: string, expectedVersion = version("docs/list.md")) =>
		f.call("company_edit", { path: "docs/list.md", operationKey, expectedVersion, oldText, newText: "- c" });
	await refuses(edit("- z", "edit-none"), CloudToolRefusal, "COMPANY_EDIT_NOT_FOUND");
	await refuses(edit("- a", "edit-twice"), CloudToolRefusal, "COMPANY_EDIT_NOT_UNIQUE");
	expect(f.commits).toHaveLength(0);
	const stale = parse(await edit("- b", "edit-stale", randomUUID()));
	expect(stale).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "version_changed", version: null });
	expect(stale.next).toContain("COMPANY_FILE_VERSION_CHANGED");
	const gone = parse(
		await f.call("company_edit", {
			path: "docs/gone.md",
			operationKey: "edit-gone",
			expectedVersion: randomUUID(),
			oldText: "a",
			newText: "b",
		}),
	);
	expect(gone).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "missing" });
	expect(f.text("docs/list.md")).toBe("- a\n- a\n- b\n");
	const folder = parse(await f.call("company_read", { path: "docs", offset: 0, limit: 4 })).version as string;
	await refuses(
		f.call("company_edit", {
			path: "docs",
			operationKey: "edit-folder",
			expectedVersion: folder,
			oldText: "a",
			newText: "b",
		}),
		CloudToolRefusal,
		"COMPANY_FILE_NOT_A_FILE",
	);
	for (const value of [
		{ oldText: "", newText: "x" },
		{ oldText: "same", newText: "same" },
		{ oldText: "a", newText: "x".repeat(512 * 1024 + 1) },
	])
		expect(() =>
			f.tool("company_edit").parseArguments({
				path: "docs/list.md",
				operationKey: "edit-bad",
				expectedVersion: version("docs/list.md"),
				...value,
			}),
		).toThrow(CloudToolArgumentRefusal);
});

it("moves a file or a folder with the review its call was approved under", async () => {
	const f = await fixture({
		files: { "sales/acme-proposal.md": "plan", "work/a.md": "a" },
		folders: ["sales/proposals"],
	});
	const expectedVersion = f.files.get("sales/acme-proposal.md")?.version as string;
	const answer = parse(
		await f.call("company_move", {
			from: "sales/acme-proposal.md",
			to: "sales/proposals/acme-proposal.md",
			operationKey: "move-1",
			expectedVersion,
			asOfSeq: null,
		}),
	);
	expect(answer).toMatchObject({
		state: "applied",
		outcome: "saved",
		path: "sales/acme-proposal.md",
		to: "sales/proposals/acme-proposal.md",
	});
	expect(f.text("sales/proposals/acme-proposal.md")).toBe("plan");
	expect(f.files.has("sales/acme-proposal.md")).toBe(false);
	expect(f.recordings[0]?.p_request).toMatchObject({
		actionReviewId: f.context.actionReviewId,
		tool: "company_move",
		argumentSha256: f.context.argumentSha256,
	});
	expect(f.commits[0]?.units).toEqual([
		{ op: "move", from: "sales/acme-proposal.md", to: "sales/proposals/acme-proposal.md", expectedVersion },
	]);
	// A folder moves as of the model's own listing of it, which its call carries, with everything in it, under its own
	// call's approval.
	const folder = parse(await f.call("company_read", { path: "work", offset: 0, limit: 4 })).version as string;
	const listing = parse(await f.call("company_list", { path: "work", after: null, limit: 50 }));
	expect(listing.asOfSeq).toEqual(expect.any(Number));
	const second = { ...f.context, callId: "move-call-2", actionReviewId: randomUUID() };
	expect(
		parse(
			await f.call(
				"company_move",
				{ from: "work", to: "projects", operationKey: "move-2", expectedVersion: folder, asOfSeq: listing.asOfSeq },
				second,
			),
		),
	).toMatchObject({ state: "applied" });
	expect(f.commits[1]?.units).toEqual([
		{ op: "move", from: "work", to: "projects", expectedVersion: folder, asOfSeq: listing.asOfSeq },
	]);
	expect(f.text("projects/a.md")).toBe("a");
	// A target that is taken is refused by the core, and nothing moves.
	const taken = parse(
		await f.call(
			"company_move",
			{
				from: "sales/proposals/acme-proposal.md",
				to: "projects/a.md",
				operationKey: "move-3",
				expectedVersion: f.files.get("sales/proposals/acme-proposal.md")?.version as string,
				asOfSeq: null,
			},
			{ ...f.context, callId: "move-call-3", actionReviewId: randomUUID() },
		),
	);
	expect(taken).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "exists" });
	expect(taken.next).toContain("COMPANY_FILE_EXISTS: nothing was moved");
	const refused: { [key: string]: JsonValue }[] = [
		{ from: "a.md", to: "a.md", operationKey: "move-4", expectedVersion, asOfSeq: null },
		{ from: "a.md", to: "b.md", operationKey: "move-4", expectedVersion },
		{ from: "a.md", to: "b.md", operationKey: "move-4", expectedVersion, asOfSeq: -1 },
	];
	for (const value of refused)
		expect(() => f.tool("company_move").parseArguments(value)).toThrow(CloudToolArgumentRefusal);
	// Without the automatic review's approval nothing is moved.
	const { actionReviewId: _approval, ...unreviewed } = f.context;
	await refuses(
		f.call(
			"company_move",
			{
				from: "sales/proposals/acme-proposal.md",
				to: "sales/proposals/acme-offer.md",
				operationKey: "move-5",
				expectedVersion,
				asOfSeq: null,
			},
			unreviewed,
		),
		CloudToolRefusal,
		"A move needs the automatic review's approval",
	);
});

it("moves a folder only as of the model's own listing, so a change in it since stops the move", async () => {
	const f = await fixture({ files: { "work/a.md": "a" } });
	const folder = parse(await f.call("company_read", { path: "work", offset: 0, limit: 4 })).version as string;
	const move = (operationKey: string, asOfSeq: number | null) =>
		f.call(
			"company_move",
			{ from: "work", to: "projects", operationKey, expectedVersion: folder, asOfSeq },
			{ ...f.context, callId: operationKey, actionReviewId: randomUUID() },
		);
	// A folder needs the listing: refused before anything is written.
	await refuses(move("move-unlisted", null), CloudToolRefusal, "COMPANY_MOVE_NEEDS_LISTING");
	expect(f.commits).toHaveLength(0);
	// The model listed the folder, then someone changed something in it: the folder's own version is the same, and the
	// move as of the listing is the core's conflict. Nothing moves.
	const listing = parse(await f.call("company_list", { path: "work", after: null, limit: 50 }));
	expect(
		parse(
			await f.call("company_write", {
				path: "work/b.md",
				operationKey: "write-b",
				expectedVersion: null,
				text: "b",
			}),
		),
	).toMatchObject({ state: "applied" });
	expect(parse(await f.call("company_read", { path: "work", offset: 0, limit: 4 })).version).toBe(folder);
	const stale = parse(await move("move-stale", listing.asOfSeq));
	expect(stale).toMatchObject({ state: "not_applied", outcome: "conflict", reason: "unseen_change" });
	expect(stale.next).toContain("something in the folder changed after your listing");
	expect(f.files.has("work/b.md") && !f.folders.has("projects")).toBe(true);
	// Listed again, it moves.
	const again = parse(await f.call("company_list", { path: "work", after: null, limit: 50 }));
	expect(parse(await move("move-listed", again.asOfSeq))).toMatchObject({ state: "applied" });
	expect(f.text("projects/b.md")).toBe("b");
});
