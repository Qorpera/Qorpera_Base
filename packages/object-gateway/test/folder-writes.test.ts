import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import { MAX_COMMIT_STRUCTURED_BYTES, STRUCTURED_TOO_LARGE } from "../src/folder-service/plan.ts";
import {
	type BridgeInfo,
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	type Hello,
	Kind,
	ProtocolError,
	parseChunkPart,
	parseClose,
	parseGetChunk,
	parseOpen,
	parseRename,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, LISTING_ONLY, type ViewHandle } from "../src/folder-service/service.ts";
import {
	FolderStaging,
	type FolderUploads,
	GatewayUploads,
	manifestText,
	STAGE_CONCURRENCY,
} from "../src/folder-service/staging.ts";
import {
	ALLOCATION,
	BRIDGE,
	CODING,
	CODING_MACHINE_ID,
	codingGrants,
	companyGrants,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	grants,
	hashOf,
	MEMBER,
	noSecrets,
	OFFICE,
	PASS,
	PROFILE,
	secretsOf,
	storeFile,
	v,
	writableGrants,
} from "./folder-service-fixtures.ts";

/** Writes through the mount (F3 step 3c): the folder service's pending changes, staging and boundaries, against the
 * stand-in core and share (RUNTIME-FOLDER-WRITES.md). */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	// Last in, first out: a socket's clients go before the server, which closes only once they have.
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BIG = 4 * 1024 * 1024;
const hello: Hello = { protocol: 2, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" };

async function fixture(
	options: {
		quietMs?: number;
		readOnly?: boolean;
		now?: () => number;
		platform?: boolean;
		cacheBytes?: number;
		maxBoundaryBatches?: number;
		wrapUploads?: (inner: FakeUploads) => FolderUploads;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-"));
	const core = new FakeCore();
	const objects = new NasObjects({ root, cacheBytes: options.cacheBytes ?? 64 * 1024 * 1024 });
	const uploads = new FakeUploads(root, core);
	const folderUploads = options.wrapUploads ? options.wrapUploads(uploads) : uploads;
	const start = () =>
		new FolderService({
			core,
			objects,
			grants: options.readOnly ? grants() : writableGrants(options.quietMs, options.platform),
			staging: new FolderStaging(core, folderUploads, objects),
			log: () => undefined,
			...(options.now ? { now: options.now } : {}),
			...(options.maxBoundaryBatches !== undefined ? { maxBoundaryBatches: options.maxBoundaryBatches } : {}),
		});
	let service = start();
	const handles: ViewHandle[] = [];
	cleanups.push(async () => {
		for (const h of handles) h.release();
		service.stop();
		await rm(root, { recursive: true, force: true });
	});
	const open = async () => {
		const handle = await service.open(hello, BRIDGE);
		handles.push(handle);
		return handle;
	};
	/** The service stopped and started again: what was pending is gone; the machine's version map is not. */
	const restart = (): void => {
		for (const h of handles.splice(0)) h.release();
		service.stop();
		service = start();
	};
	return { root, core, objects, uploads, service, open, restart };
}

/** A small file, written as the folder program writes it: opened with truncate, its one chunk, closed. */
async function write(view: ViewHandle, path: string, text: string, base?: string): Promise<void> {
	const { handle } = await view.open({
		path,
		create: true,
		exclusive: false,
		truncate: true,
		...(base ? { base } : {}),
	});
	const data = Buffer.from(text);
	if (data.byteLength > 0)
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	await view.close(handle, data.byteLength);
}

async function read(view: ViewHandle, path: string): Promise<string> {
	const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	const entry = (await view.list(parent, undefined)).entries.find(
		(e) => e.name === path.slice(parent ? parent.length + 1 : 0),
	);
	if (!entry) throw new Error(`no ${path}`);
	return (await view.read({ path, version: entry.version, offset: 0, length: 1024 * 1024 })).toString();
}

/** A save as the folder program makes it, and the version its close answered (what its version map then holds). */
async function save(view: ViewHandle, path: string, text: string, base?: string): Promise<string> {
	const { handle } = await view.open({
		path,
		create: true,
		exclusive: false,
		truncate: true,
		...(base ? { base } : {}),
	});
	const data = Buffer.from(text);
	await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
	return (await view.close(handle, data.byteLength)).version;
}

function byPath<T extends { path: string }>(paths: readonly T[]): T[] {
	return [...paths].sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(ProtocolError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe("writes through the mount", () => {
	it("shows a new file at once, publishes it as one change set, then shows the live file", async () => {
		const { core, uploads, open } = await fixture();
		core.seed([folder("docs")]);
		const view = await open();
		expect(view.writable).toBe(true);
		await write(view, "docs/new.md", "hello");
		expect(await read(view, "docs/new.md")).toBe("hello");
		expect(core.entries.has("docs/new.md")).toBe(false);
		const report = await view.publish();
		expect(report.paths).toEqual([{ path: "docs/new.md", outcome: "saved" }]);
		const entry = core.entries.get("docs/new.md");
		expect(entry).toMatchObject({ kind: "file", bytes: 5, mediaType: "text/markdown", fileSha256: hashOf("hello") });
		// The chunk went under its own intent, the manifest under the file's; the chunk was not put twice.
		expect(uploads.puts).toEqual([hashOf("hello"), entry!.manifestSha256]);
		const live = (await view.list("docs", undefined)).entries.find((e) => e.name === "new.md");
		expect(live?.version).toBe(entry!.version);
		expect(await read(view, "docs/new.md")).toBe("hello");
	});

	it("edits a live file in place through its chunk, based on the version read", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "first", 1, BIG, { mediaType: "text/markdown" })]);
		const view = await open();
		const base = core.entries.get("plan.md")!.version;
		const { handle } = await view.open({ path: "plan.md", create: false, exclusive: false, truncate: false, base });
		const data = Buffer.from("second");
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		await view.close(handle, data.byteLength);
		expect(await read(view, "plan.md")).toBe("second");
		expect((await view.publish()).paths).toEqual([{ path: "plan.md", outcome: "saved" }]);
		expect(core.commits[0]!.units).toEqual([
			{
				op: "write",
				path: "plan.md",
				file: expect.objectContaining({ fileSha256: hashOf("second") }),
				expectedVersion: base,
			},
		]);
	});

	it("keeps a stale save as a conflict copy on its receipt, and shows the other machine's version", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const read1 = core.entries.get("plan.md")!.version;
		core.write(await storeFile(root, "plan.md", "theirs", 2, BIG));
		await service.poll();
		await service.settled();
		await write(view, "plan.md", "mine", read1);
		const report = await view.publish();
		expect(report.paths).toEqual([
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(await read(view, "plan.md")).toBe("theirs");
	});

	it("keeps a stale save through a temporary file renamed over its target as a conflict too", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const read1 = core.entries.get("plan.md")!.version;
		core.write(await storeFile(root, "plan.md", "theirs", 2, BIG));
		await service.poll();
		await service.settled();
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: read1, noReplace: false });
		const report = await view.publish();
		expect(report.paths).toEqual([
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.commits[0]!.units).toEqual([expect.objectContaining({ op: "write", expectedVersion: read1 })]);
		expect(await read(view, "plan.md")).toBe("theirs");
		expect(core.entries.has("plan.md.new")).toBe(false);
	});

	it("tries a refused save through a temporary file renamed over its target again at the version it replaced", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const read1 = core.entries.get("plan.md")!.version;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: read1, noReplace: false });
		core.refuse = (path) => path === "plan.md";
		expect((await view.publish()).paths).toEqual([
			{ path: "plan.md", outcome: "denied", reason: "denied", kept: true },
		]);
		expect(await read(view, "plan.md")).toBe("mine");
		// Kept, the save still replaces the version the editor renamed over, so it saves instead of conflicting.
		core.refuse = () => false;
		expect((await view.publish()).paths).toEqual([{ path: "plan.md", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: read1 }),
		]);
		expect(core.entries.get("plan.md")?.fileSha256).toBe(hashOf("mine"));
	});

	it("keeps a save that replaced a file a conflict once another machine removed that file, never making it again", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG), await storeFile(root, "todo.md", "v1", 2, BIG)]);
		const view = await open();
		const plan = core.entries.get("plan.md")!.version;
		const todo = core.entries.get("todo.md")!.version;
		// A save through a temporary file, and a file made again, in another case, where one was removed.
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: plan, noReplace: false });
		await view.unlink("todo.md", todo);
		await write(view, "TODO.md", "mine");
		// Another machine removes both before the boundary, and its change reaches the view: the saves still show.
		core.remove("plan.md");
		core.remove("todo.md");
		await service.poll();
		await service.settled();
		expect(await read(view, "plan.md")).toBe("mine");
		expect(await read(view, "TODO.md")).toBe("mine");
		const report = await view.publish();
		const units = core.commits.at(-1)!.units;
		expect(units).toHaveLength(2);
		expect(units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: plan }),
				expect.objectContaining({ op: "write", path: "TODO.md", expectedVersion: todo }),
			]),
		);
		expect(byPath(report.paths)).toEqual([
			{ path: "TODO.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.entries.has("plan.md")).toBe(false);
		expect(core.entries.has("TODO.md")).toBe(false);
	});

	it("keeps a save renamed only in case a conflict once another machine removed the file it replaced", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG), await storeFile(root, "todo.md", "v1", 2, BIG)]);
		const view = await open();
		const plan = core.entries.get("plan.md")!.version;
		const todo = core.entries.get("todo.md")!.version;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: plan, noReplace: false });
		await view.unlink("todo.md", todo);
		await write(view, "TODO.md", "mine");
		core.remove("plan.md");
		core.remove("todo.md");
		await service.poll();
		await service.settled();
		// Each renamed only in case after the change reached the view: still the next version of the file it replaced.
		await view.rename({ from: "plan.md", to: "Plan.md", noReplace: false });
		await view.rename({ from: "TODO.md", to: "todo.md", noReplace: false });
		expect(await read(view, "Plan.md")).toBe("mine");
		expect(await read(view, "todo.md")).toBe("mine");
		const report = await view.publish();
		const units = core.commits.at(-1)!.units;
		expect(units).toHaveLength(2);
		expect(units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "write", path: "Plan.md", expectedVersion: plan }),
				expect.objectContaining({ op: "write", path: "todo.md", expectedVersion: todo }),
			]),
		);
		expect(byPath(report.paths)).toEqual([
			{ path: "Plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
			{ path: "todo.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.entries.has("Plan.md")).toBe(false);
		expect(core.entries.has("todo.md")).toBe(false);
	});

	it("makes a save renamed over the file another machine renamed only in case one replacement of that", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const old = core.entries.get("plan.md")!;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: old.version, noReplace: false });
		// Another machine renames the file only in case, and its change reaches the view.
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "Plan.md", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// The save renamed over it replaces the version the machine saw there, as one unit.
		await view.rename({ from: "plan.md", to: "Plan.md", toBase: v(8), noReplace: false });
		expect(await read(view, "Plan.md")).toBe("mine");
		expect((await view.publish()).paths).toEqual([{ path: "Plan.md", outcome: "saved" }]);
		const units = core.commits.at(-1)!.units;
		expect(units).toEqual([expect.objectContaining({ op: "write", path: "Plan.md", expectedVersion: v(8) })]);
		expect(core.entries.has("plan.md")).toBe(false);
		expect(core.entries.get("Plan.md")!.version).not.toBe(v(8));
	});

	it("publishes a save, and another renamed over the file another machine renamed only in case beside it, as two units", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const old = core.entries.get("plan.md")!;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: old.version, noReplace: false });
		// Another machine renames the file only in case, and its change reaches the view: both names show.
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "Plan.md", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// Another save renamed over the new name, at the version there: in the core a unit at the first save's path too.
		// The first save still replaces the version it saw (a conflict, kept on the receipt): it never takes v8.
		await write(view, "plan.md.new", "next");
		await view.rename({ from: "plan.md.new", to: "Plan.md", toBase: v(8), noReplace: false });
		expect(await read(view, "plan.md")).toBe("mine");
		expect(await read(view, "Plan.md")).toBe("next");
		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toHaveLength(2);
		expect(core.commits[0]!.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: old.version }),
				expect.objectContaining({ op: "write", path: "Plan.md", expectedVersion: v(8) }),
			]),
		);
		expect(byPath(report.paths)).toEqual([
			{ path: "Plan.md", outcome: "saved" },
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.entries.get("Plan.md")!.fileSha256).toBe(hashOf("next"));
		expect(core.entries.has("plan.md.new")).toBe(false);
		expect([...core.copies.values()].flat()).toEqual([expect.objectContaining({ path: "plan.md", kind: "file" })]);
		expect(core.entries.has("plan.md")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "plan.md", expectedVersion: v(8) });
	});

	it("keeps a save a conflict when the file another machine renamed only in case beside it is edited in place", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const old = core.entries.get("plan.md")!;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: old.version, noReplace: false });
		// Another machine renames the file only in case, and its change reaches the view: both names show.
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "Plan.md", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// An edit in place of the new name, at v8: a unit of its own, and the save still replaces the version it saw.
		await write(view, "Plan.md", "edited", v(8));
		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual([
			expect.objectContaining({ op: "write", path: "Plan.md", expectedVersion: v(8) }),
			expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: old.version }),
		]);
		expect(byPath(report.paths)).toEqual([
			{ path: "Plan.md", outcome: "saved" },
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.entries.get("Plan.md")!.fileSha256).toBe(hashOf("edited"));
		expect([...core.copies.values()].flat()).toEqual([expect.objectContaining({ path: "plan.md", kind: "file" })]);
		expect(core.entries.has("plan.md")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "plan.md", expectedVersion: v(8) });
	});

	it("keeps a save a conflict when the file another machine renamed only in case beside it is moved away and removed", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const old = core.entries.get("plan.md")!;
		await write(view, "plan.md.new", "mine");
		await view.rename({ from: "plan.md.new", to: "plan.md", toBase: old.version, noReplace: false });
		// Another machine renames the file only in case, and its change reaches the view: both names show.
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "Plan.md", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		// The new name moved away, then removed: v8's removal is a unit of its own, and the save still replaces the
		// version it saw (a conflict), never v8.
		await view.rename({ from: "Plan.md", to: "moved.md", fromBase: v(8), noReplace: false });
		await view.unlink("moved.md", v(8));
		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual([
			expect.objectContaining({ op: "delete", path: "Plan.md", expectedVersion: v(8) }),
			expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: old.version }),
		]);
		expect(byPath(report.paths)).toEqual([
			{ path: "Plan.md", outcome: "saved" },
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(core.entries.has("Plan.md")).toBe(false);
		expect(core.entries.has("moved.md")).toBe(false);
		expect([...core.copies.values()].flat()).toEqual([expect.objectContaining({ path: "plan.md", kind: "file" })]);
		expect(core.entries.has("plan.md")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "plan.md", expectedVersion: v(8) });
	});

	it("keeps a save a conflict when the file it replaced, renamed to a name never published here, is removed", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([await storeFile(root, "notes.SWP", "v1", 1, BIG)]);
		const view = await open();
		const old = core.entries.get("notes.SWP")!;
		await write(view, "notes.SWP.new", "mine");
		await view.rename({ from: "notes.SWP.new", to: "notes.SWP", toBase: old.version, noReplace: false });
		// Another machine renames the file only in case, to a name this machine never publishes (the member route takes
		// it), and its change reaches the view; the machine then removes it there.
		core.commitChanges([
			{ ...old, op: "move_out" },
			{ ...old, path: "notes.swp", version: v(8), op: "move_in", priorVersion: old.version },
		]);
		await service.poll();
		await service.settled();
		await view.unlink("notes.swp", v(8));
		// The removal is a unit of its own; the save still replaces the version it saw, so it conflicts.
		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]!.units).toEqual([
			expect.objectContaining({ op: "delete", path: "notes.swp", expectedVersion: v(8) }),
			expect.objectContaining({ op: "write", path: "notes.SWP", expectedVersion: old.version }),
		]);
		expect(byPath(report.paths)).toEqual([
			{ path: "notes.SWP", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
			{ path: "notes.swp", outcome: "saved" },
		]);
		expect([...core.copies.values()].flat()).toEqual([expect.objectContaining({ path: "notes.SWP", kind: "file" })]);
		expect(core.entries.has("notes.SWP")).toBe(false);
		expect(core.entries.has("notes.swp")).toBe(false);
		for (const unit of core.commits.flatMap((c) => c.units))
			expect(unit).not.toMatchObject({ path: "notes.SWP", expectedVersion: v(8) });
	});

	it("keeps a stale save as a conflict when the service restarted between the read and the save", async () => {
		const { root, core, open, restart } = await fixture();
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const before = await open();
		expect(await read(before, "plan.md")).toBe("v1");
		// What the folder program's version map (in /run) holds for the path: the version it read.
		const read1 = (await before.list("", undefined)).entries.find((e) => e.name === "plan.md")!.version;
		restart();
		core.write(await storeFile(root, "plan.md", "theirs", 2, BIG));
		const view = await open();
		expect(await read(view, "plan.md")).toBe("theirs");
		// The editor saves its buffer in place, based on what it read before the restart.
		await write(view, "plan.md", "mine", read1);
		const report = await view.publish();
		expect(report.paths).toEqual([
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(await read(view, "plan.md")).toBe("theirs");
	});

	it("loses no byte the view held when any one unit of a boundary fails", async () => {
		const files: Record<string, string> = { "docs/new.txt": "new", "docs/a.txt": "a2", "made/in.txt": "in" };
		for (const target of ["docs/new.txt", "docs/a.txt", "keep/old.txt", "gone.txt", "made", "empty"]) {
			const { root, core, open } = await fixture();
			core.seed([
				folder("docs"),
				folder("keep"),
				await storeFile(root, "docs/a.txt", "a1", 1, BIG),
				await storeFile(root, "old.txt", "old", 2, BIG),
				await storeFile(root, "gone.txt", "gone", 3, BIG),
			]);
			const view = await open();
			const versionOf = (path: string) => core.entries.get(path)!.version;
			await write(view, "docs/new.txt", "new");
			await write(view, "docs/a.txt", "a2", versionOf("docs/a.txt"));
			await view.rename({ from: "old.txt", fromBase: versionOf("old.txt"), to: "keep/old.txt", noReplace: false });
			await view.unlink("gone.txt", versionOf("gone.txt"));
			await view.mkdir("made");
			await write(view, "made/in.txt", "in");
			await view.mkdir("empty");
			core.refuse = (path) => path === target;
			const report = await view.publish();
			const failed = (path: string) => path === target || path.startsWith(`${target}/`);
			expect(report.paths.length).toBeGreaterThan(0);
			for (const entry of report.paths)
				expect([target, entry.path, entry.outcome === "saved"]).toEqual([target, entry.path, !failed(entry.path)]);
			// New bytes are live, or still pending in this view and reported as kept.
			for (const [path, text] of Object.entries(files)) {
				if (core.entries.get(path)?.fileSha256 === hashOf(text)) continue;
				expect(report.paths.find((e) => e.path === path)).toMatchObject({ kept: true });
				expect(await read(view, path)).toBe(text);
			}
			// A move or a removal that failed leaves what it would have moved or removed live, and the view shows it.
			if (target === "keep/old.txt") expect(await read(view, "old.txt")).toBe("old");
			if (target === "gone.txt") expect(await read(view, "gone.txt")).toBe("gone");
			expect(core.entries.has("old.txt") !== core.entries.has("keep/old.txt")).toBe(true);
			// The next boundary saves what was kept.
			core.refuse = () => false;
			await view.publish();
			for (const [path, text] of Object.entries(files))
				expect(core.entries.get(path)?.fileSha256).toBe(hashOf(text));
		}
	});

	it("fails with BUSY a folder move that needs a file still open inside it published first", async () => {
		const { core, open } = await fixture();
		core.seed([folder("A")]);
		const view = await open();
		const { handle } = await view.open({ path: "A/open.txt", create: true, exclusive: false, truncate: true });
		await refused(view.rename({ from: "A", to: "B", noReplace: false }), "BUSY");
		expect(core.entries.has("B")).toBe(false);
		// Closed, the file is published first, then the folder moves.
		await view.close(handle, 0);
		await view.rename({ from: "A", to: "B", noReplace: false });
		expect((await view.publish()).paths).toEqual([{ path: "B", outcome: "saved" }]);
		expect([...core.entries.keys()].sort()).toEqual(["B", "B/open.txt"]);
	});

	it("keeps a refused change pending, says so, and saves it at a later boundary", async () => {
		const { core, open } = await fixture();
		core.seed([folder("locked")]);
		core.refuse = (path) => path.startsWith("locked/");
		const view = await open();
		await write(view, "locked/x.txt", "x");
		expect((await view.publish()).paths).toEqual([
			{ path: "locked/x.txt", outcome: "denied", reason: "denied", kept: true },
		]);
		expect(await read(view, "locked/x.txt")).toBe("x");
		core.refuse = () => false;
		expect((await view.publish()).paths).toEqual([{ path: "locked/x.txt", outcome: "saved" }]);
	});

	it("says which rule refused a change and why, as the core names it; the boundary's other changes save", async () => {
		const { core, open } = await fixture();
		core.seed([folder("QorperaOS"), folder("QorperaOS/interfaces")]);
		core.rule = (path) =>
			path.startsWith("QorperaOS/interfaces/")
				? { code: "layout_authoring", message: "page and table layout authoring is not available" }
				: undefined;
		const view = await open();
		await write(view, "QorperaOS/interfaces/page.md", "p");
		await write(view, "notes.md", "n");
		const report = await view.publish();
		expect(report.paths).toHaveLength(2);
		expect(report.paths).toContainEqual({
			path: "QorperaOS/interfaces/page.md",
			outcome: "refused",
			reason: "structured_rule: layout_authoring (page and table layout authoring is not available)",
			kept: true,
		});
		expect(report.paths).toContainEqual({ path: "notes.md", outcome: "saved" });
		expect(core.entries.has("notes.md")).toBe(true);
		expect(core.entries.has("QorperaOS/interfaces/page.md")).toBe(false);
	});

	it("publishes what is pending first when a change needs it", async () => {
		const { root, core, open } = await fixture();
		core.seed([folder("A"), await storeFile(root, "A/x", "x", 2, BIG)]);
		const view = await open();
		await view.rename({ from: "A", to: "B", noReplace: false });
		// A change inside the renamed folder: the rename is published first, then the change lands at B.
		await write(view, "B/y", "y");
		expect(core.commits.map((c) => c.units.map((u) => u.op))).toEqual([["move"]]);
		expect((await view.publish()).paths).toEqual([{ path: "B/y", outcome: "saved" }]);
		expect([...core.entries.keys()].sort()).toEqual(["B", "B/x", "B/y"]);
	});

	it("asks a commit that got no answer again under the same key, and changes nothing until it has one", async () => {
		const { core, open } = await fixture();
		const view = await open();
		await write(view, "f.txt", "f");
		core.commitFailures = { mode: "down", count: 3 };
		expect((await view.publish()).paths).toEqual([
			{ path: "f.txt", outcome: "not_applied", reason: "the save did not get through yet", kept: true },
		]);
		core.commitFailures = { mode: "down", count: 3 };
		await refused(view.mkdir("g"), "BUSY");
		// The core answers again: the next change first gets the old boundary's answer, under the same key.
		await view.mkdir("g");
		const keys = core.commits.map((c) => c.key);
		expect(new Set(keys).size).toBe(1);
		expect(core.entries.has("f.txt")).toBe(true);
		// A reply lost after the commit landed: asked again, the core answers the same, and nothing is applied twice.
		await view.publish();
		await write(view, "h.txt", "h");
		core.commitFailures = { mode: "lost", count: 1 };
		const report = await view.publish();
		expect(report.paths).toEqual([{ path: "h.txt", outcome: "saved" }]);
		expect(
			core.journal.filter((e) => e.kind === "change_set" && e.changes.some((c) => c.path === "h.txt")),
		).toHaveLength(1);
	});

	it("refuses an in-place change to a file not laid out on the 4 MiB grid; a whole write works", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "odd.txt", "small chunks", 1, 4)]);
		const view = await open();
		const { handle } = await view.open({ path: "odd.txt", create: false, exclusive: false, truncate: false });
		const data = Buffer.from("x");
		await refused(view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: 1, offset: 0, data }), "NOT_PERMITTED");
		await view.close(handle, 12);
		await write(view, "odd.txt", "whole");
		expect((await view.publish()).paths).toEqual([{ path: "odd.txt", outcome: "saved" }]);
	});

	it("publishes on its own after a quiet period", async () => {
		const { core, open } = await fixture({ quietMs: 500 });
		const view = await open();
		await write(view, "quiet.txt", "q");
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(core.entries.has("quiet.txt")).toBe(true);
	});

	it("takes a write handle on any connection of the view, and abandons it when the last one ends", async () => {
		const { core, open } = await fixture();
		// The folder program pools its connections: a file opened on one goes on through another.
		const first = await open();
		const second = await open();
		const { handle } = await first.open({ path: "pooled.txt", create: true, exclusive: false, truncate: true });
		const data = Buffer.from("pooled");
		await second.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		await first.close(handle, data.byteLength);
		// Opened again without truncating (a truncate is fixed at once, as O_TRUNC is), and changed in place.
		const left = await second.open({ path: "pooled.txt", create: false, exclusive: false, truncate: false });
		first.release();
		await second.chunk({
			handle: left.handle,
			index: 0,
			sha256: hashOf("x"),
			bytes: 1,
			offset: 0,
			data: Buffer.from("x"),
		});
		// The last connection ends with the file open: it is abandoned, and the bytes closed before stay.
		second.release();
		const third = await open();
		await refused(third.close(left.handle, 1), "BAD_REQUEST");
		expect(await read(third, "pooled.txt")).toBe("pooled");
		expect((await third.publish()).paths).toEqual([{ path: "pooled.txt", outcome: "saved" }]);
		expect(core.entries.get("pooled.txt")?.fileSha256).toBe(hashOf("pooled"));
	});

	it("keeps a draft out of the view until its close lands it; a discarded or abandoned one leaves nothing", async () => {
		const { core, open } = await fixture();
		core.seed([folder("docs")]);
		const view = await open();
		await write(view, "docs/live.md", "live");
		await view.publish();
		const draft = (path: string) => view.open({ path, create: true, exclusive: false, truncate: true, draft: true });
		const data = Buffer.from("drafted");
		const fill = (handle: number) =>
			view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		// Written but not closed, neither a new file nor one over a live file is in the view, nor published.
		const fresh = await draft("docs/new.md");
		const over = await draft("docs/live.md");
		await fill(fresh.handle);
		await fill(over.handle);
		expect((await view.list("docs", undefined)).entries.map((e) => e.name)).toEqual(["live.md"]);
		expect(await read(view, "docs/live.md")).toBe("live");
		expect((await view.publish()).paths).toEqual([]);
		// The close lands it, as a save there would.
		await view.close(fresh.handle, data.byteLength);
		await view.close(over.handle, data.byteLength);
		expect(await read(view, "docs/new.md")).toBe("drafted");
		expect(await read(view, "docs/live.md")).toBe("drafted");
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "docs/live.md", outcome: "saved" },
			{ path: "docs/new.md", outcome: "saved" },
		]);
		expect(core.entries.get("docs/live.md")?.fileSha256).toBe(hashOf("drafted"));
		// One given up, and one whose view's last connection ends, leave nothing.
		const given = await draft("docs/given.md");
		await fill(given.handle);
		await view.discard(given.handle);
		await refused(view.close(given.handle, data.byteLength), "BAD_REQUEST");
		const lost = await draft("docs/lost.md");
		await fill(lost.handle);
		view.release();
		const again = await open();
		await refused(again.close(lost.handle, data.byteLength), "BAD_REQUEST");
		expect((await again.list("docs", undefined)).entries.map((e) => e.name)).toEqual(["live.md", "new.md"]);
		expect((await again.publish()).paths).toEqual([]);
		expect(core.entries.has("docs/given.md") || core.entries.has("docs/lost.md")).toBe(false);
		// A draft never takes a git lock (that it starts empty is checked where its request is read).
		const lock = "code/o/n/repo.git/packed-refs.lock";
		await refused(
			again.open({ path: lock, create: true, exclusive: true, truncate: true, draft: true }),
			"BAD_REQUEST",
		);
	});

	it("lands a draft against what its open saw: a file another machine made there since is a conflict", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([folder("docs"), await storeFile(root, "docs/live.md", "v1", 1, BIG)]);
		const view = await open();
		const draft = (path: string) => view.open({ path, create: true, exclusive: false, truncate: true, draft: true });
		const data = Buffer.from("drafted");
		const fill = (handle: number) =>
			view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		// Opened where nothing was and over the live file; another machine then creates the one and changes the other.
		const fresh = await draft("docs/raced.md");
		const over = await draft("docs/live.md");
		await fill(fresh.handle);
		await fill(over.handle);
		core.write(await storeFile(root, "docs/raced.md", "theirs", 2, BIG));
		core.write(await storeFile(root, "docs/live.md", "theirs", 3, BIG));
		await service.poll();
		await service.settled();
		await view.close(fresh.handle, data.byteLength);
		await view.close(over.handle, data.byteLength);
		const report = await view.publish();
		expect(byPath(report.paths)).toEqual([
			{ path: "docs/live.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
			{ path: "docs/raced.md", outcome: "conflict", reason: "exists", receipt: report.commitId },
		]);
		expect(core.entries.get("docs/raced.md")?.fileSha256).toBe(hashOf("theirs"));
		expect(core.entries.get("docs/live.md")?.fileSha256).toBe(hashOf("theirs"));
		expect(await read(view, "docs/raced.md")).toBe("theirs");
		expect(await read(view, "docs/live.md")).toBe("theirs");
		// Over the view's own unsaved file, a draft holds it unpublished, and its close is that file's next save.
		await write(view, "docs/mine.md", "mine");
		const mine = await draft("docs/mine.md");
		await fill(mine.handle);
		await view.publish();
		expect(core.entries.has("docs/mine.md")).toBe(false);
		await view.close(mine.handle, data.byteLength);
		expect((await view.publish()).paths).toEqual([{ path: "docs/mine.md", outcome: "saved" }]);
		expect(core.entries.get("docs/mine.md")?.fileSha256).toBe(hashOf("drafted"));
		// Given up, it lets the file go as it was.
		await write(view, "docs/kept.md", "kept");
		const kept = await draft("docs/kept.md");
		await fill(kept.handle);
		await view.discard(kept.handle);
		expect((await view.publish()).paths).toEqual([{ path: "docs/kept.md", outcome: "saved" }]);
		expect(core.entries.get("docs/kept.md")?.fileSha256).toBe(hashOf("kept"));
	});

	it("lands a draft over what this view itself did there since its open, with or without a boundary between", async () => {
		const { root, core, open } = await fixture();
		const names = ["a", "b", "c", "d", "e"];
		core.seed([
			folder("docs"),
			...(await Promise.all(names.map((n, i) => storeFile(root, `docs/${n}.md`, "v1", i + 1, BIG)))),
		]);
		const view = await open();
		const data = Buffer.from("drafted");
		const handles: number[] = [];
		for (const name of names) {
			const path = `docs/${name}.md`;
			const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true, draft: true });
			await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
			handles.push(handle);
		}
		const [a, b, c, d, e] = handles as [number, number, number, number, number];
		await view.unlink("docs/a.md", undefined);
		await view.unlink("docs/b.md", undefined);
		await view.rename({ from: "docs/c.md", to: "docs/c-old.md", noReplace: false });
		await view.rename({ from: "docs/d.md", to: "docs/d-old.md", noReplace: false });
		await write(view, "docs/e.md", "own");
		// Removed or moved away, and landed before a boundary: the removal and the new file publish as one.
		await view.close(a, data.byteLength);
		await view.close(c, data.byteLength);
		const first = await view.publish();
		expect(first.paths.filter((entry) => entry.outcome !== "saved")).toEqual([]);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("drafted"));
		expect(core.entries.get("docs/c.md")?.fileSha256).toBe(hashOf("drafted"));
		expect(core.entries.has("docs/b.md") || core.entries.has("docs/d.md")).toBe(false);
		expect(core.entries.get("docs/e.md")?.fileSha256).toBe(hashOf("own"));
		// Removed, moved away or saved, published, then landed: over what the view published there, not as a conflict.
		await view.close(b, data.byteLength);
		await view.close(d, data.byteLength);
		await view.close(e, data.byteLength);
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "docs/b.md", outcome: "saved" },
			{ path: "docs/d.md", outcome: "saved" },
			{ path: "docs/e.md", outcome: "saved" },
		]);
		for (const name of names) expect(core.entries.get(`docs/${name}.md`)?.fileSha256).toBe(hashOf("drafted"));
		expect(core.entries.get("docs/c-old.md")?.fileSha256).toBe(hashOf("v1"));
		expect(core.entries.get("docs/d-old.md")?.fileSha256).toBe(hashOf("v1"));
	});

	it("lands a draft as a new file where this view took away a file it made after another machine's delete", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/a.md", "v1", 1, BIG),
			await storeFile(root, "docs/b.md", "v1", 2, BIG),
		]);
		const view = await open();
		const data = Buffer.from("drafted");
		const handles: number[] = [];
		for (const path of ["docs/a.md", "docs/b.md"]) {
			const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true, draft: true });
			await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
			handles.push(handle);
		}
		// Another machine deletes both; this view makes each anew, then removes the one and moves the other away.
		core.remove("docs/a.md");
		core.remove("docs/b.md");
		await service.poll();
		await service.settled();
		await write(view, "docs/a.md", "own");
		await write(view, "docs/b.md", "own");
		await view.unlink("docs/a.md", undefined);
		await view.rename({ from: "docs/b.md", to: "docs/b-old.md", noReplace: false });
		for (const handle of handles) await view.close(handle, data.byteLength);
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "docs/a.md", outcome: "saved" },
			{ path: "docs/b-old.md", outcome: "saved" },
			{ path: "docs/b.md", outcome: "saved" },
		]);
		expect(core.entries.get("docs/a.md")?.fileSha256).toBe(hashOf("drafted"));
		expect(core.entries.get("docs/b.md")?.fileSha256).toBe(hashOf("drafted"));
		expect(core.entries.get("docs/b-old.md")?.fileSha256).toBe(hashOf("own"));
	});

	it("lands a draft against the file this view's move would have taken away when that move is let go", async () => {
		for (const openFirst of [true, false])
			for (const after of ["nothing", "theirsGone", "noBoundary"] as const) {
				const { root, core, service, open } = await fixture();
				core.seed([folder("docs"), await storeFile(root, "docs/p.md", "v1", 1, BIG)]);
				const view = await open();
				const data = Buffer.from("drafted");
				const draft = async () => {
					const { handle } = await view.open({
						path: "docs/p.md",
						create: true,
						exclusive: false,
						truncate: true,
						draft: true,
					});
					await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
					return handle;
				};
				// The draft opens before or after this view moves the file away; another machine makes a file where it goes, so
				// the move is a conflict.
				const first = openFirst ? await draft() : undefined;
				await view.rename({ from: "docs/p.md", to: "docs/r.md", noReplace: false });
				const handle = first ?? (await draft());
				core.write(await storeFile(root, "docs/r.md", "theirs", 2, BIG));
				await service.poll();
				await service.settled();
				if (after === "noBoundary") {
					// Closed while the move is pending, the draft is a new file, as a create would be: where the move then fails,
					// that meets the file the move left, a conflict.
					await view.close(handle, data.byteLength);
					const { paths } = await view.publish();
					expect(paths.find((p) => p.path === "docs/p.md")?.outcome).toBe("conflict");
					expect(core.entries.get("docs/p.md")?.fileSha256).toBe(hashOf("v1"));
					expect(await read(view, "docs/p.md")).toBe("v1");
					expect((await view.publish()).paths).toEqual([]);
					continue;
				}
				await view.publish();
				expect(core.entries.get("docs/p.md")?.fileSha256).toBe(hashOf("v1"));
				expect(await read(view, "docs/p.md")).toBe("v1");
				if (after === "theirsGone") {
					// The draft lands against that file, as one opened over it does: another machine's delete after is a conflict.
					core.remove("docs/p.md");
					await service.poll();
					await service.settled();
				}
				await view.close(handle, data.byteLength);
				const { paths } = await view.publish();
				if (after === "theirsGone") {
					expect(paths.find((p) => p.path === "docs/p.md")?.outcome).toBe("conflict");
					expect(core.entries.has("docs/p.md")).toBe(false);
				} else {
					expect(paths).toEqual([{ path: "docs/p.md", outcome: "saved" }]);
					expect(core.entries.get("docs/p.md")?.fileSha256).toBe(hashOf("drafted"));
				}
			}
	});

	it("lands a draft with the executable bit of what it lands over, with or without a boundary between", async () => {
		for (const how of ["chmod", "moveIn"] as const)
			for (const boundary of [false, true]) {
				const { root, core, open } = await fixture();
				core.seed([
					folder("docs"),
					await storeFile(root, "docs/run.sh", "v1", 1, BIG),
					await storeFile(root, "docs/q.sh", "q1", 2, BIG, { executable: true }),
				]);
				const view = await open();
				const data = Buffer.from("drafted");
				const path = "docs/run.sh";
				const { handle } = await view.open({ path, create: true, exclusive: false, truncate: true, draft: true });
				await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
				if (how === "chmod") await view.setExecutable(path, true, undefined);
				else await view.rename({ from: "docs/q.sh", to: path, noReplace: false });
				if (boundary) await view.publish();
				await view.close(handle, data.byteLength);
				await view.publish();
				expect(core.entries.get(path)).toMatchObject({ fileSha256: hashOf("drafted"), executable: true });
			}
	});

	it("gives a draft up when its close cannot land it, and publishes the file it held", async () => {
		const { core, open } = await fixture();
		const view = await open();
		await view.mkdir("n");
		await write(view, "n/f.md", "mine");
		const data = Buffer.from("drafted");
		const { handle } = await view.open({
			path: "n/f.md",
			create: true,
			exclusive: false,
			truncate: true,
			draft: true,
		});
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		// The new folder moves with the file the draft holds: the draft's path has no folder now.
		await view.rename({ from: "n", to: "m", noReplace: false });
		await refused(view.close(handle, data.byteLength), "NOT_FOUND");
		await refused(view.close(handle, data.byteLength), "BAD_REQUEST");
		await view.publish();
		expect(core.entries.get("m/f.md")?.fileSha256).toBe(hashOf("mine"));
		expect(core.entries.has("n/f.md")).toBe(false);
		expect((await view.publish()).paths).toEqual([]);
	});

	it("lands a draft opened over the view's own file against the file the view took away there when that is let go", async () => {
		for (const took of ["move", "unlink"] as const)
			for (const gone of ["unlink", "rename"] as const) {
				const { root, core, service, open } = await fixture();
				core.seed([folder("docs"), await storeFile(root, "docs/p.md", "v1", 1, BIG)]);
				const view = await open();
				// The view takes the live file away, writes its own there, opens a draft over that and takes its own away too.
				if (took === "move") await view.rename({ from: "docs/p.md", to: "docs/r.md", noReplace: false });
				else await view.unlink("docs/p.md", undefined);
				await write(view, "docs/p.md", "mine");
				const data = Buffer.from("drafted");
				const { handle } = await view.open({
					path: "docs/p.md",
					create: true,
					exclusive: false,
					truncate: true,
					draft: true,
				});
				await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
				if (gone === "unlink") await view.unlink("docs/p.md", undefined);
				else await view.rename({ from: "docs/p.md", to: "docs/s.md", noReplace: false });
				// The boundary lets the view's taking away go: another machine took the move's destination, or the core
				// refuses the removal.
				if (took === "move") {
					core.write(await storeFile(root, "docs/r.md", "theirs", 2, BIG));
					await service.poll();
					await service.settled();
				} else core.refuse = (path) => path === "docs/p.md";
				await view.publish();
				core.refuse = () => false;
				expect(core.entries.get("docs/p.md")?.fileSha256).toBe(hashOf("v1"));
				expect(await read(view, "docs/p.md")).toBe("v1");
				await view.close(handle, data.byteLength);
				// The view's own file, moved on, is published once the draft no longer holds it.
				const { paths } = await view.publish();
				expect(paths.map((p) => [p.path, p.outcome]).sort()).toEqual(
					[["docs/p.md", "saved"], ...(gone === "rename" ? [["docs/s.md", "saved"]] : [])].sort(),
				);
				expect(core.entries.get("docs/p.md")?.fileSha256).toBe(hashOf("drafted"));
				if (gone === "rename") expect(core.entries.get("docs/s.md")?.fileSha256).toBe(hashOf("mine"));
				else expect(core.entries.has("docs/s.md")).toBe(false);
			}
	});

	it("gives a draft up when another machine makes its path a folder", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([folder("docs"), await storeFile(root, "docs/p.md", "v1", 1, BIG)]);
		const view = await open();
		const data = Buffer.from("drafted");
		const { handle } = await view.open({
			path: "docs/p.md",
			create: true,
			exclusive: false,
			truncate: true,
			draft: true,
		});
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		const old = core.entries.get("docs/p.md");
		if (!old) throw new Error("no file");
		core.commitChanges([
			{ ...old, op: "delete" },
			{ ...folder("docs/p.md", 5), op: "mkdir" },
		]);
		await service.poll();
		await service.settled();
		await refused(view.close(handle, data.byteLength), "NOT_A_FILE");
		await refused(view.close(handle, data.byteLength), "BAD_REQUEST");
		expect((await view.publish()).paths).toEqual([]);
		expect(core.entries.get("docs/p.md")?.kind).toBe("folder");
	});

	it("publishes the file a discarded draft held once the quiet period passes, with no change after", async () => {
		const { core, open } = await fixture({ quietMs: 500 });
		const view = await open();
		await write(view, "held.md", "held");
		const { handle } = await view.open({
			path: "held.md",
			create: true,
			exclusive: false,
			truncate: true,
			draft: true,
		});
		// The quiet period's boundary passes the file by while the draft holds it.
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(core.entries.has("held.md")).toBe(false);
		await view.discard(handle);
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(core.entries.get("held.md")?.fileSha256).toBe(hashOf("held"));
	});

	it("bases a save on the machine's own published save when it names the version that save made", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([folder("docs")]);
		const view = await open();
		// What the folder program's version map holds after a save: the version the close (or the bit) answered.
		const save = async (path: string, text: string, base?: string) => {
			const { handle } = await view.open({
				path,
				create: true,
				exclusive: false,
				truncate: true,
				...(base ? { base } : {}),
			});
			const data = Buffer.from(text);
			await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
			return (await view.close(handle, data.byteLength)).version;
		};
		const first = await save("docs/a.md", "one");
		await view.mkdir("new");
		const inner = await save("new/b.md", "b1");
		await view.publish();
		const [liveA, liveB] = [core.entries.get("docs/a.md")!.version, core.entries.get("new/b.md")!.version];
		expect([liveA, liveB]).not.toContain(first);
		// A file held open from before the boundary reads the same bytes under the version its save made.
		expect((await view.read({ path: "docs/a.md", version: first, offset: 0, length: 16 })).toString()).toBe("one");
		// The next saves name the versions the machine's own saves made: based on what those published, they save.
		const bit = (await view.setExecutable("new/b.md", true, inner)).version;
		const second = await save("docs/a.md", "two", first);
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "docs/a.md", outcome: "saved" },
			{ path: "new/b.md", outcome: "saved" },
		]);
		expect(byPath(core.commits.at(-1)!.units as readonly { path: string }[])).toEqual([
			expect.objectContaining({ path: "docs/a.md", expectedVersion: liveA }),
			expect.objectContaining({ path: "new/b.md", expectedVersion: liveB }),
		]);
		await save("new/b.md", "b2", bit);
		expect((await view.publish()).paths).toEqual([{ path: "new/b.md", outcome: "saved" }]);
		// Another machine's change after that: a save based on the machine's own last save is a conflict.
		core.write(await storeFile(root, "docs/a.md", "theirs", 50, BIG));
		await service.poll();
		await service.settled();
		await save("docs/a.md", "three", second);
		expect((await view.publish()).paths).toEqual([
			{ path: "docs/a.md", outcome: "conflict", reason: "version_changed", receipt: expect.any(String) },
		]);
	});

	it("tells the machine of the view's own folder going live by a name below it: it lists the folder again, keeps its entry", async () => {
		const told = (view: ViewHandle): string[] => {
			const paths: string[] = [];
			view.subscribe({ change: (message) => paths.push(...message.paths), closed: () => undefined });
			return paths;
		};
		// A moved folder: the machine may have listed it empty between the feed's round and the settle.
		{
			const { root, core, open } = await fixture();
			core.seed([folder("a"), await storeFile(root, "a/x", "x", 1, BIG)]);
			const view = await open();
			await view.rename({ from: "a", to: "b", noReplace: false });
			const paths = told(view);
			await view.publish();
			expect(core.entries.has("b/x")).toBe(true);
			expect(paths).toContain(`b/${LISTING_ONLY}`);
			expect(paths).not.toContain("b");
			expect((await view.list("b", undefined)).entries.map((entry) => entry.name)).toEqual(["x"]);
		}
		// A folder another machine made too, with a file in it: the machine listed it empty while it was the view's own.
		{
			const { root, core, service, open } = await fixture();
			const view = await open();
			await view.mkdir("shared");
			core.write(folder("shared"));
			core.write(await storeFile(root, "shared/y", "y", 60, BIG));
			await service.poll();
			await service.settled();
			const paths = told(view);
			await view.publish();
			expect(paths).toContain(`shared/${LISTING_ONLY}`);
			expect(paths).not.toContain("shared");
			expect((await view.list("shared", undefined)).entries.map((entry) => entry.name)).toEqual(["y"]);
		}
	});

	it("reads the version the view's own folder showed while pending as its live one: an rmdir after its publish removes it", async () => {
		const shownIn = async (view: ViewHandle, parent: string, name: string): Promise<string> =>
			(await view.list(parent, undefined)).entries.find((entry) => entry.name === name)!.version;
		// A new folder: the folder above lists it at the version it showed while pending, which the publish replaces.
		{
			const { core, open } = await fixture();
			const view = await open();
			await view.mkdir("out");
			const shown = await shownIn(view, "", "out");
			await view.publish();
			expect(core.entries.get("out")?.version).not.toBe(shown);
			await view.rmdir("out", shown);
			await view.publish();
			expect(core.entries.has("out")).toBe(false);
		}
		// A folder moved into another folder.
		{
			const { core, open } = await fixture();
			core.seed([folder("a"), folder("c")]);
			const view = await open();
			await view.rename({ from: "a", to: "c/a", noReplace: false });
			const shown = await shownIn(view, "c", "a");
			await view.publish();
			expect(core.entries.has("c/a")).toBe(true);
			await view.rmdir("c/a", shown);
			await view.publish();
			expect(core.entries.has("c/a")).toBe(false);
		}
		// A folder another machine made too.
		{
			const { core, service, open } = await fixture();
			const view = await open();
			await view.mkdir("shared");
			core.write(folder("shared"));
			await service.poll();
			await service.settled();
			const shown = await shownIn(view, "", "shared");
			await view.publish();
			expect(core.entries.get("shared")?.version).not.toBe(shown);
			await view.rmdir("shared", shown);
			await view.publish();
			expect(core.entries.has("shared")).toBe(false);
		}
	});

	it("bases a save on what this view's move published when it names the version the file showed before", async () => {
		const { root, core, service, open } = await fixture();
		core.seed([
			folder("reports"),
			folder("reports/2026"),
			await storeFile(root, "reports/2026/q1.md", "q1 first", 1, BIG),
			folder("archive"),
			await storeFile(root, "notes.md", "notes first", 2, BIG),
		]);
		const view = await open();
		const [q1, notes] = [core.entries.get("reports/2026/q1.md")!.version, core.entries.get("notes.md")!.version];
		await view.rename({ from: "reports/2026", to: "archive/2026", noReplace: false });
		await view.rename({ from: "notes.md", fromBase: notes, to: "notes-old.md", noReplace: false });
		// While the moves are pending, the files show at their new paths the versions they had: what the machine reads,
		// and what its version map takes as their bases.
		expect((await view.list("archive/2026", undefined)).entries.find((e) => e.name === "q1.md")?.version).toBe(q1);
		expect((await view.read({ path: "archive/2026/q1.md", version: q1, offset: 0, length: 16 })).toString()).toBe(
			"q1 first",
		);
		// Saves in place: each publishes the move first, which gives the file a new version; the save is based on it.
		await save(view, "archive/2026/q1.md", "q1 second", q1);
		await save(view, "notes-old.md", "notes second", notes);
		const [movedQ1, movedNotes] = [
			core.entries.get("archive/2026/q1.md")!.version,
			core.entries.get("notes-old.md")!.version,
		];
		expect([movedQ1, movedNotes]).not.toContain(q1);
		expect(movedNotes).not.toBe(notes);
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "archive/2026/q1.md", outcome: "saved" },
			{ path: "notes-old.md", outcome: "saved" },
		]);
		expect(byPath(core.commits.at(-1)!.units as readonly { path: string }[])).toEqual([
			expect.objectContaining({ op: "write", path: "archive/2026/q1.md", expectedVersion: movedQ1 }),
			expect.objectContaining({ op: "write", path: "notes-old.md", expectedVersion: movedNotes }),
		]);
		// Another machine's change after the move: a save based on the version from before the move is a conflict.
		core.write(await storeFile(root, "archive/2026/q1.md", "theirs", 50, BIG));
		await service.poll();
		await service.settled();
		await save(view, "archive/2026/q1.md", "q1 third", q1);
		expect((await view.publish()).paths).toEqual([
			{ path: "archive/2026/q1.md", outcome: "conflict", reason: "version_changed", receipt: expect.any(String) },
		]);
	});

	it("bases a save on what this view's move published when it names the version its own save made before", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "a.md", "one", 1, BIG), await storeFile(root, "c.md", "c one", 2, BIG)]);
		const view = await open();
		// A save, then a move of the file it saved: the machine's version map takes the version the save made along to
		// the new name. The move publishes the save first, and the next save there publishes the move first.
		const made = await save(view, "a.md", "one two", core.entries.get("a.md")!.version);
		await view.rename({ from: "a.md", fromBase: made, to: "b.md", noReplace: false });
		await save(view, "b.md", "one two three", made);
		expect((await view.publish()).paths).toEqual([{ path: "b.md", outcome: "saved" }]);
		expect(core.entries.has("a.md")).toBe(false);
		expect(core.entries.get("b.md")?.fileSha256).toBe(hashOf("one two three"));
		// Twice over: a file saved, moved, published, and moved on.
		const madeC = await save(view, "c.md", "c two", core.entries.get("c.md")!.version);
		await view.rename({ from: "c.md", fromBase: madeC, to: "d.md", noReplace: false });
		await view.publish();
		await view.rename({ from: "d.md", fromBase: madeC, to: "e.md", noReplace: false });
		await view.setExecutable("e.md", true, madeC);
		expect((await view.publish()).paths).toEqual([{ path: "e.md", outcome: "saved" }]);
		expect(core.entries.get("e.md")).toMatchObject({ fileSha256: hashOf("c two"), executable: true });
	});

	it("bases a save on the version a file has now when it moved away and back after its own save", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "a.md", "one", 1, BIG)]);
		const view = await open();
		const made = await save(view, "a.md", "one two", core.entries.get("a.md")!.version);
		await view.rename({ from: "a.md", fromBase: made, to: "t.md", noReplace: false });
		await view.publish();
		// Back at a.md, the machine's version map holds the save's version there again, as it did before the move.
		await view.rename({ from: "t.md", fromBase: core.entries.get("t.md")!.version, to: "a.md", noReplace: false });
		await save(view, "a.md", "one two three", made);
		const back = core.entries.get("a.md")!.version;
		expect((await view.publish()).paths).toEqual([{ path: "a.md", outcome: "saved" }]);
		expect(core.commits.at(-1)!.units).toEqual([
			expect.objectContaining({ op: "write", path: "a.md", expectedVersion: back }),
		]);
		expect(core.entries.get("a.md")?.fileSha256).toBe(hashOf("one two three"));
	});

	it("keeps a conflicting save pending until the core holds it on the receipt, a platform mount's too", async () => {
		// The platform may download any catalogued object, so only the receipt's own rows say a copy was kept.
		const { root, core, service, open } = await fixture({ platform: true });
		core.seed([await storeFile(root, "plan.md", "v1", 1, BIG)]);
		const view = await open();
		const read1 = core.entries.get("plan.md")!.version;
		core.write(await storeFile(root, "plan.md", "theirs", 2, BIG));
		await service.poll();
		await service.settled();
		await write(view, "plan.md", "mine", read1);
		// The core decided the conflict but kept no copy (P17 keeps one only when the bytes would have passed): the
		// save is not dropped, it stays this view's and is tried again.
		core.copyConflicts = false;
		expect((await view.publish()).paths).toEqual([
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", kept: true },
		]);
		expect(await read(view, "plan.md")).toBe("mine");
		core.copyConflicts = true;
		const report = await view.publish();
		expect(report.paths).toEqual([
			{ path: "plan.md", outcome: "conflict", reason: "version_changed", receipt: report.commitId },
		]);
		expect(await read(view, "plan.md")).toBe("theirs");
	});

	it("renews the intents that hold pending bytes, and replaces those that lapse", async () => {
		let now = Date.now();
		const { core, open, service } = await fixture({ now: () => now });
		const view = await open();
		await write(view, "kept.txt", "kept");
		const opened = [...core.intents.keys()];
		expect(opened).toHaveLength(1);
		const [singleIntent] = opened as [string];
		now += 10 * 60_000;
		core.renewFailures = 1;
		await service.renewIntents();
		expect(core.renewals).toEqual([singleIntent]);
		await service.renewIntents();
		expect(core.renewals.slice(1)).toEqual([singleIntent]);
		now += 10 * 60_000;
		core.lapsed.add(singleIntent);
		await service.renewIntents();
		const held = [...core.intents.keys()].filter((id) => !opened.includes(id));
		expect(held).toHaveLength(1);
		expect(core.intents.get(held[0]!)?.objects.has(hashOf("kept"))).toBe(true);
		expect((await view.publish()).paths).toEqual([{ path: "kept.txt", outcome: "saved" }]);
		expect(core.intents.size).toBe(2);
		now += 10 * 60_000;
		const before = core.renewals.length;
		await service.renewIntents();
		expect(core.renewals.length).toBe(before);
	});

	it("settles a boundary only once the feed has brought its change set back", async () => {
		const { core, open, service } = await fixture();
		const view = await open();
		const made = await save(view, "f.txt", "one");
		// The commit lands; the feed does not answer (the service's three tries, then the next change's).
		core.feedFailures = 4;
		expect((await view.publish()).paths).toEqual([{ path: "f.txt", outcome: "saved" }]);
		await refused(view.mkdir("g"), "BUSY");
		// The feed is back: the view settles, and a save based on the version its close answered is based on the
		// version it published.
		await service.poll();
		await service.settled();
		await view.mkdir("g");
		await save(view, "f.txt", "two", made);
		expect((await view.publish()).paths).toEqual(expect.arrayContaining([{ path: "f.txt", outcome: "saved" }]));
		expect(core.entries.get("f.txt")?.fileSha256).toBe(hashOf("two"));
	});

	it("keeps every published save's own version readable while its published version is", async () => {
		const { core, open } = await fixture();
		const view = await open();
		const first = await save(view, "a.md", "one");
		await view.publish();
		const second = await save(view, "a.md", "two", first);
		await view.publish();
		expect(core.entries.get("a.md")?.fileSha256).toBe(hashOf("two"));
		expect((await view.read({ path: "a.md", version: first, offset: 0, length: 16 })).toString()).toBe("one");
		expect((await view.read({ path: "a.md", version: second, offset: 0, length: 16 })).toString()).toBe("two");
	});

	it("saves a file renamed over another at the media type of the path it lands on", async () => {
		const { root, core, open } = await fixture();
		core.seed([await storeFile(root, "document.md", "v1", 1, BIG, { mediaType: "text/markdown" })]);
		const view = await open();
		const base = core.entries.get("document.md")!.version;
		// Staged at close as the temporary name gives it, then renamed.
		await write(view, "draft.tmp", "edited");
		await view.rename({ from: "draft.tmp", to: "document.md", toBase: base, noReplace: false });
		await write(view, "new.tmp", "notes");
		await view.rename({ from: "new.tmp", to: "notes.md", noReplace: false });
		await view.publish();
		expect(core.entries.get("document.md")).toMatchObject({
			fileSha256: hashOf("edited"),
			mediaType: "text/markdown",
		});
		expect(core.entries.get("notes.md")).toMatchObject({ fileSha256: hashOf("notes"), mediaType: "text/markdown" });
	});

	it("settles a new folder's files with the versions its change set gave them, after a failed feed and a reload", async () => {
		const { root, core, open, service } = await fixture();
		const view = await open();
		await view.mkdir("new");
		const made = await save(view, "new/f.md", "one");
		// The feed fails each time the service asks it to settle the boundary.
		core.feedFailures = 3;
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "new", outcome: "saved" },
			{ path: "new/f.md", outcome: "saved" },
		]);
		// Another machine commits, and an access change has the view listed again past the boundary's change set.
		core.write(await storeFile(root, "other.md", "other", 7, BIG));
		core.authority(() => false);
		await service.poll();
		await service.settled();
		// The machine saves again on the version its close answered: based on the version the new folder gave the file.
		await save(view, "new/f.md", "two", made);
		expect((await view.publish()).paths).toEqual([{ path: "new/f.md", outcome: "saved" }]);
		expect(core.entries.get("new/f.md")?.fileSha256).toBe(hashOf("two"));
		expect((await view.read({ path: "new/f.md", version: made, offset: 0, length: 16 })).toString()).toBe("one");
	});

	it("keeps a save's own version readable for as long as the version it published is", async () => {
		const { open } = await fixture();
		const view = await open();
		const made: string[] = [];
		for (let i = 1; i <= 18; i++) {
			made.push(await save(view, "log.md", `${i}`, made.at(-1)));
			await view.publish();
		}
		// The current version and the 16 replaced before it are readable: the 2nd save's own version still reads.
		expect((await view.read({ path: "log.md", version: made[1]!, offset: 0, length: 16 })).toString()).toBe("2");
		await refused(view.read({ path: "log.md", version: made[0]!, offset: 0, length: 16 }), "STALE");
	});

	it("lets go of the intents of bytes nothing needs any more", async () => {
		let now = Date.now();
		const { core, open, service } = await fixture({ now: () => now });
		const view = await open();
		for (const text of ["one", "two", "three"]) await write(view, "draft.md~", text);
		const swapOpened = [...core.intents.keys()];
		expect(swapOpened).toHaveLength(3);
		for (const text of ["alpha", "beta", "gamma"]) await write(view, "draft.md", text);
		const allOpened = [...core.intents.keys()];
		expect(allOpened).toHaveLength(6);
		now += 10 * 60_000;
		await service.renewIntents();
		expect(core.renewals).toEqual([swapOpened[2], allOpened[5]]);
	});

	it("cuts a file at its close, on the grid or to nothing, with no chunk sent", async () => {
		const { root, core, open } = await fixture();
		const big = "x".repeat(10 * 1024 * 1024);
		core.seed([await storeFile(root, "big.bin", big, 1, BIG), await storeFile(root, "log.txt", "lines", 1, BIG)]);
		const view = await open();
		// `truncate -s 8M` and `truncate -s 0`: opened without truncating, cut, closed.
		const bin = await view.open({ path: "big.bin", create: false, exclusive: false, truncate: false });
		await view.close(bin.handle, 8 * 1024 * 1024);
		const log = await view.open({ path: "log.txt", create: false, exclusive: false, truncate: false });
		await view.close(log.handle, 0);
		expect(await read(view, "log.txt")).toBe("");
		await view.publish();
		expect(core.entries.get("big.bin")).toMatchObject({
			bytes: 8 * 1024 * 1024,
			fileSha256: hashOf(big.slice(0, 8 * 1024 * 1024)),
		});
		expect(core.entries.get("log.txt")).toMatchObject({ bytes: 0, fileSha256: hashOf("") });
	});

	it("lands a change asked for while a boundary settles after that boundary, never in it", async () => {
		const { core, open } = await fixture();
		core.seed([folder("locked")]);
		core.refuse = (path) => path.startsWith("locked/");
		const view = await open();
		// A new folder with a file saves, and a refused write stays pending. The view's feed reaches the change set,
		// but reading the change set for the new folder's file versions fails three times, so it does not settle.
		await view.mkdir("build");
		await write(view, "build/out.txt", "out");
		await write(view, "locked/x.txt", "x");
		let reads = 0;
		let releaseRead!: () => void;
		const readHeld = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		core.feedHook = (afterSeq) => {
			if (afterSeq !== 0) return undefined;
			reads++;
			if (reads === 1) return undefined;
			if (reads <= 4) throw new Error("The core did not answer this page");
			// The next read, the new file's settling, is held; any later one goes through.
			return reads === 5 ? readHeld : undefined;
		};
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "build", outcome: "saved" },
			{ path: "build/out.txt", outcome: "saved" },
			{ path: "locked/x.txt", outcome: "denied", reason: "denied", kept: true },
		]);
		// A new file is asked for first; a boundary is asked for meanwhile, and its commit is held. The file must not
		// land while that boundary decides and settles.
		const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
		let releaseCommit!: () => void;
		core.commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const opening = view.open({ path: "new.txt", create: true, exclusive: false, truncate: true });
		await tick();
		const publishing = view.publish();
		await tick();
		releaseRead();
		await tick();
		releaseCommit();
		const [{ handle }] = await Promise.all([opening, publishing]);
		core.commitGate = undefined;
		core.feedHook = undefined;
		// The file landed after the boundary settled, and stays.
		const data = Buffer.from("new");
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: 3, offset: 0, data });
		await view.close(handle, 3);
		expect(await read(view, "new.txt")).toBe("new");
		core.refuse = () => false;
		expect(byPath((await view.publish()).paths)).toEqual([
			{ path: "locked/x.txt", outcome: "saved" },
			{ path: "new.txt", outcome: "saved" },
		]);
	});

	it("makes a change that had to publish first only once that boundary has settled", async () => {
		const { core, open } = await fixture();
		core.seed([folder("logs")]);
		const view = await open();
		// A new folder with a file, and the live folder moved away: its name is free only once that is published.
		await view.mkdir("build");
		await write(view, "build/out.txt", "out");
		await view.rename({ from: "logs", to: "logs.old", noReplace: false });
		// The boundary's change set reaches the view, but its new folder's file versions cannot be read yet.
		let reads = 0;
		core.feedHook = (afterSeq) => {
			if (afterSeq === 0 && reads++ > 0) throw new Error("The core did not answer this page");
			return undefined;
		};
		await refused(view.mkdir("logs"), "BUSY");
		// Once it settles, the change is made, and published; nothing undoes it.
		core.feedHook = undefined;
		await view.mkdir("logs");
		expect(byPath((await view.publish()).paths)).toEqual([{ path: "logs", outcome: "saved" }]);
		expect([...core.entries.keys()].sort()).toEqual(["build", "build/out.txt", "logs", "logs.old"]);
	});

	it("holds a chunk's intent while the chunk is started, and while the gateway finishes its put", async () => {
		let now = Date.now();
		const { core, uploads, open, service } = await fixture({ now: () => now });
		const view = await open();
		const later = async (): Promise<void> => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		};
		const gate = (): { held: Promise<void>; release: () => void } => {
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			return { held, release };
		};
		// The company's storage profile is being learnt when the renewal round runs.
		const profile = gate();
		core.uploadProfileGate = profile.held;
		const one = await view.open({ path: "one.bin", create: true, exclusive: false, truncate: true });
		const a = Buffer.from("a");
		const sendingA = view.chunk({ handle: one.handle, index: 0, sha256: hashOf(a), bytes: 1, offset: 0, data: a });
		await later();
		now += 10 * 60_000;
		await service.renewIntents();
		expect(core.renewals).toEqual([...core.intents.keys()]);
		profile.release();
		await sendingA;
		// The gateway is finishing the put of another chunk when the round runs.
		const end = gate();
		uploads.endGate = end.held;
		const two = await view.open({ path: "two.bin", create: true, exclusive: false, truncate: true });
		const b = Buffer.from("b");
		const sendingB = view.chunk({ handle: two.handle, index: 0, sha256: hashOf(b), bytes: 1, offset: 0, data: b });
		await later();
		now += 10 * 60_000;
		const before = core.renewals.length;
		await service.renewIntents();
		expect(core.renewals.slice(before)).toContain([...core.intents.keys()].at(-1));
		end.release();
		await sendingB;
	});

	it("renews a chunk's intent while its parts are still on their way", async () => {
		let now = Date.now();
		const { core, open, service } = await fixture({ now: () => now });
		const view = await open();
		const { handle } = await view.open({ path: "big.bin", create: true, exclusive: false, truncate: true });
		const data = Buffer.alloc(2 * 1024 * 1024, 1);
		const first = data.subarray(0, 1024 * 1024);
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data: first });
		now += 10 * 60_000;
		await service.renewIntents();
		expect(core.renewals).toEqual([...core.intents.keys()]);
	});

	it("answers a chunk it cannot start as a request error, and takes it again", async () => {
		const { core, open } = await fixture();
		const view = await open();
		const { handle } = await view.open({ path: "a.bin", create: true, exclusive: false, truncate: true });
		const data = Buffer.from("abc");
		const part = { handle, index: 0, sha256: hashOf(data), bytes: 3, offset: 0, data };
		// The company's storage profile cannot be learnt now.
		const down = Promise.reject(new Error("The database did not answer"));
		down.catch(() => undefined);
		core.uploadProfileGate = down;
		await refused(view.chunk(part), "UNAVAILABLE");
		core.uploadProfileGate = undefined;
		await view.chunk(part);
		await view.close(handle, 3);
		expect(await read(view, "a.bin")).toBe("abc");
	});

	it("fails a boundary whose company-state file cannot be read back as a request error", async () => {
		const { root, core, uploads, open } = await fixture();
		core.seed([folder("QorperaOS"), folder("QorperaOS/vision")]);
		const view = await open();
		await write(view, "QorperaOS/vision/vision.md", "# Where we are going");
		// The staged manifest is gone from the share before the boundary reads the file to parse it.
		await rm(join(root, PROFILE, uploads.puts.at(-1)!));
		await refused(view.publish(), "UNAVAILABLE");
		expect(core.entries.has("QorperaOS/vision/vision.md")).toBe(false);
	});

	it("answers a close it cannot cut, for want of the origin's bytes, and keeps the handle", async () => {
		const { root, core, open } = await fixture();
		const entry = await storeFile(root, "log.txt", "lines", 1, BIG);
		core.seed([entry]);
		const view = await open();
		const { handle } = await view.open({ path: "log.txt", create: false, exclusive: false, truncate: false });
		// The share cannot give the origin's manifest now: the close is refused as a request, not a broken connection.
		await rm(join(root, PROFILE, entry.manifestSha256!));
		await refused(view.close(handle, 0), "UNAVAILABLE");
		await storeFile(root, "log.txt", "lines", 1, BIG);
		await view.close(handle, 0);
		expect(await read(view, "log.txt")).toBe("");
	});

	it("takes no writes on a read-only view", async () => {
		const { open } = await fixture({ readOnly: true });
		const view = await open();
		expect(view.writable).toBe(false);
		await refused(view.mkdir("x"), "READ_ONLY");
	});
});

/** One chunk part as a frame payload: its header's length, the header, the bytes. */
function part(header: Record<string, unknown>, data: Buffer): Buffer {
	const head = Buffer.from(JSON.stringify(header));
	const length = Buffer.alloc(4);
	length.writeUInt32BE(head.byteLength, 0);
	return Buffer.concat([length, head, data]);
}

describe("protocol 2", () => {
	it("checks every write request field", () => {
		const json = (value: unknown) => Buffer.from(JSON.stringify(value));
		const base = "00000000-0000-4000-8000-000000000001";
		expect(parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, base }))).toEqual({
			path: "a",
			base,
			create: true,
			exclusive: false,
			truncate: true,
		});
		expect(() => parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, x: 1 }))).toThrow();
		expect(() => parseOpen(json({ path: "", create: true, exclusive: false, truncate: true }))).toThrow();
		expect(() => parseOpen(json({ path: "a", create: 1, exclusive: false, truncate: true }))).toThrow();
		expect(() =>
			parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, base: "v1" })),
		).toThrow();
		expect(parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, draft: true }))).toEqual({
			path: "a",
			create: true,
			exclusive: false,
			truncate: true,
			draft: true,
		});
		expect(parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, draft: false }))).toEqual({
			path: "a",
			create: true,
			exclusive: false,
			truncate: true,
		});
		expect(() =>
			parseOpen(json({ path: "a", create: true, exclusive: false, truncate: false, draft: true })),
		).toThrow();
		expect(() => parseOpen(json({ path: "a", create: true, exclusive: false, truncate: true, draft: 1 }))).toThrow();
		expect(parseClose(json({ handle: 1, size: 3 }))).toEqual({ handle: 1, size: 3 });
		expect(parseClose(json({ handle: 1, size: 0, discard: true }))).toEqual({ handle: 1, size: 0, discard: true });
		expect(() => parseClose(json({ handle: 1, size: 0, discard: "yes" }))).toThrow();
		expect(() => parseClose(json({ handle: 1, size: 0, x: 1 }))).toThrow();
		const sha = hashOf("abc");
		expect(
			parseChunkPart(part({ handle: 1, index: 0, sha256: sha, bytes: 3, offset: 0 }, Buffer.from("abc"))),
		).toMatchObject({ handle: 1, index: 0, sha256: sha, bytes: 3, offset: 0 });
		for (const bad of [
			part({ handle: 1, index: 64, sha256: sha, bytes: 3, offset: 0 }, Buffer.from("abc")),
			part({ handle: 1, index: 0, sha256: sha, bytes: 3, offset: 1 }, Buffer.from("abc")),
			part({ handle: 1, index: 0, sha256: "x", bytes: 3, offset: 0 }, Buffer.from("abc")),
			part({ handle: 1, index: 0, sha256: sha, bytes: 4 * 1024 * 1024 + 1, offset: 0 }, Buffer.from("abc")),
			part({ handle: 1, index: 0, sha256: sha, bytes: 3, offset: 0 }, Buffer.alloc(0)),
			part({ handle: 1, index: 0, sha256: sha, bytes: 3 * 1024 * 1024, offset: 0 }, Buffer.alloc(1024 * 1024 + 1)),
			part({ handle: 1, index: 0, sha256: sha, bytes: 3, offset: 0, extra: true }, Buffer.from("abc")),
			Buffer.from([0, 0]),
		])
			expect(() => parseChunkPart(bad)).toThrow();
		expect(() => parseGetChunk(json({ handle: 1, index: 0, offset: 0, length: 1024 * 1024 + 1 }))).toThrow();
		expect(parseRename(json({ from: "a", to: "b", noReplace: false }))).toEqual({
			from: "a",
			to: "b",
			noReplace: false,
		});
		expect(() => parseRename(json({ from: "a", to: "b" }))).toThrow();
	});

	it("writes and publishes over the socket, and refuses writes to a machine on protocol 1", async () => {
		const { service } = await fixture();
		const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-socket-"));
		const server = createFolderServer(service, () => undefined);
		const path = join(dir, "service.sock");
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanups.push(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		});
		const client = async (protocol: number, role: "io" | "feed" = "io") => {
			const socket = connect(path);
			await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
			cleanups.push(async () => {
				socket.destroy();
			});
			const reader = new FrameReader();
			const frames: Frame[] = [];
			const waiters: ((frame: Frame) => void)[] = [];
			socket.on("data", (data: Buffer) => {
				for (const frame of reader.push(data)) {
					const waiter = waiters.shift();
					if (waiter) waiter(frame);
					else frames.push(frame);
				}
			});
			const next = (): Promise<Frame> =>
				frames.length > 0 ? Promise.resolve(frames.shift()!) : new Promise((resolve) => waiters.push(resolve));
			const ask = async (kind: number, payload: Buffer | Record<string, unknown>) => {
				socket.write(Buffer.isBuffer(payload) ? encodeFrame(kind, payload) : encodeJson(kind, payload));
				const frame = await next();
				return { kind: frame.kind, body: JSON.parse(frame.payload.toString()) as Record<string, unknown> };
			};
			socket.write(encodeJson(Kind.bridge, BRIDGE));
			const hello = await ask(Kind.hello, { protocol, environmentId: ENV, viewId: "proof", pass: PASS, role });
			return { hello, ask };
		};
		const v2 = await client(2);
		expect(v2.hello.body).toMatchObject({ protocol: 2, readOnly: false });
		const opened = await v2.ask(Kind.open, { path: "n.txt", create: true, exclusive: false, truncate: true });
		expect(opened.kind).toBe(Kind.opened);
		const handle = opened.body.handle as number;
		const data = Buffer.from("over the socket");
		expect(
			(
				await v2.ask(
					Kind.chunk,
					part({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0 }, data),
				)
			).kind,
		).toBe(Kind.done);
		expect((await v2.ask(Kind.close, { handle, size: data.byteLength })).kind).toBe(Kind.done);
		const report = await v2.ask(Kind.publish, {});
		expect(report.kind).toBe(Kind.report);
		expect(report.body.paths).toEqual([{ path: "n.txt", outcome: "saved" }]);
		const v1 = await client(1);
		expect(v1.hello.body).toMatchObject({ protocol: 1, readOnly: true });
		expect(await v1.ask(Kind.mkdir, { path: "x" })).toMatchObject({ kind: Kind.error, body: { code: "READ_ONLY" } });
		// The connection carries on after a refused request.
		expect((await v1.ask(Kind.list, { path: "" })).kind).toBe(Kind.listing);
		// A feed's hello says what the view takes, so the folder program mounts read-write; the feed itself takes only
		// acknowledgements.
		const feed = await client(2, "feed");
		expect(feed.hello.body).toMatchObject({ protocol: 2, readOnly: false });
		expect(await feed.ask(Kind.mkdir, { path: "y" })).toMatchObject({
			kind: Kind.error,
			body: { code: "BAD_REQUEST" },
		});
	});
});

describe("the gateway's upload", () => {
	it("fails a part waiting for the socket to drain when the put ends, and when it is aborted", async () => {
		// A gateway that takes the request and reads nothing, then drops it.
		const server = createHttpServer((request) => {
			request.pause();
			setTimeout(() => request.socket.destroy(), 100);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const uploads = new GatewayUploads({
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			token: "t".repeat(43),
		});
		cleanups.push(async () => {
			uploads.close();
		});
		const actor = { kind: "member" as const, userId: MEMBER };
		const part = Buffer.alloc(4 * 1024 * 1024);
		const dropped = uploads.start(ENV, actor, v(1), hashOf("x"), 64 * 1024 * 1024);
		await expect(
			(async () => {
				for (let i = 0; i < 16; i++) await dropped.write(part);
			})(),
		).rejects.toMatchObject({ code: "UNAVAILABLE" });
		const aborted = uploads.start(ENV, actor, v(2), hashOf("y"), 64 * 1024 * 1024);
		const waiting = (async () => {
			for (let i = 0; i < 16; i++) await aborted.write(part);
		})();
		setTimeout(() => aborted.abort(), 20);
		await expect(waiting).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});
});

/** A draft against every pair of events it can meet between its open and its close, with and without a boundary between
 * them (RUNTIME-FOLDER-SERVICE.md, drafts). It lands as the view's newest change at its path, over what this view itself
 * did there since its open, published or not; against what another machine did there since, it is a conflict. The quiet
 * period's boundary is this same boundary on a timer (the quiet-period tests above). */
describe("a draft against every pair of events", () => {
	const P = "docs/p.md";
	const Q = "docs/q.md";
	const STARTS = ["absent", "live", "held", "unlinked", "movedAway", "movedHeld"] as const;
	const FIRST = [
		"save",
		"unlink",
		"moveAway",
		"moveIn",
		"redraft",
		"fill",
		"theirs",
		"theirsGone",
		"theirsMoved",
		"theirsAway",
		"theirsQ",
	] as const;
	const SECOND = [...FIRST, "close", "discard"] as const;
	type Event = (typeof SECOND)[number];
	/** The view's own change at P not yet published: whether it shows a file there, the live version it is based on,
	 * whether it took away what was there (removed it, or made or moved a file in over that), whether the draft holds
	 * it (it was opened over that file), the view's move of the live file there away (to where, and what it moved; that
	 * hides the path until it publishes, whatever another machine does there), and whether that move fails at its
	 * boundary because another machine took its destination; where it failed under the file the draft holds, the
	 * version of the file it left there (`under`); and whether the file it shows there is a new one over what it took
	 * away (`fresh`: that file replaces the version it took, as one unit, where a file moved in over it lets it go). */
	type Own = {
		present: boolean;
		base: string | undefined;
		replaced: boolean;
		held: boolean;
		away?: { readonly to: string; readonly text: string | undefined };
		doomed?: boolean;
		under?: string;
		fresh?: boolean;
	};
	const DRAFTED = Buffer.from("drafted");
	const SECOND_DRAFT = Buffer.from("second");
	const names = new Map(
		["p1", "q1", "mine", "own", "second", "drafted", "", "theirs 1", "theirs 2"].map((text) => [hashOf(text), text]),
	);
	const name = (sha: string | undefined) => (sha === undefined ? "nothing" : `"${names.get(sha) ?? sha.slice(0, 8)}"`);

	/** One sequence from `start`: what went wrong, "skip" where an event cannot happen, or nothing. */
	async function sequence(
		start: (typeof STARTS)[number],
		[first, second]: readonly [Event, Event],
		boundary: boolean,
	): Promise<string | undefined> {
		const { root, core, service, open } = await fixture();
		core.seed([folder("docs"), await storeFile(root, Q, "q1", 3, BIG)]);
		if (start !== "absent" && start !== "held") core.seed([await storeFile(root, P, "p1", 2, BIG)]);
		const view = await open();
		const version = () => core.entries.get(P)?.version;
		const shown = (path: string) => read(view, path).catch(() => undefined);
		let own: Own | undefined;
		if (start === "held") {
			await write(view, P, "mine");
			own = { present: true, base: undefined, replaced: false, held: true };
		} else if (start === "unlinked" || start === "movedAway") {
			if (start === "unlinked") await view.unlink(P, undefined);
			else await view.rename({ from: P, to: "docs/gone.md", noReplace: false });
			own = { present: false, base: version(), replaced: true, held: false };
			if (start === "movedAway") own.away = { to: "docs/gone.md", text: "p1" };
		} else if (start === "movedHeld") {
			// The view moved the live file away and wrote its own file there: the draft holds that one.
			await view.rename({ from: P, to: "docs/gone.md", noReplace: false });
			own = { present: true, base: version(), replaced: true, held: true, away: { to: "docs/gone.md", text: "p1" } };
			await write(view, P, "mine");
		}
		const before = await shown(P);
		const { handle } = await view.open({ path: P, create: true, exclusive: false, truncate: true, draft: true });
		if ((await shown(P)) !== before) return "its open changed what the view shows";
		/** What the draft lands against when the view has no change of its own at P: the live version its open saw, none
		 * once the view took the file away or moved another over it, or what the view's own save or move published. */
		let origin = own ? (own.present ? own.base : undefined) : version();
		let filled = false;
		let qShown = true;
		let ended: "close" | "discard" | undefined;
		/** A boundary published the view's own change at P: saved where it was based on what the core had, a conflict
		 * otherwise. Either way the view has no change of its own there after it (unless the draft holds the file). */
		const published = (prior: string | undefined) => {
			if (!own) return;
			// The file the draft holds stays the view's, a new file there once the view's move away is published (through,
			// or let go: then it meets the file the move left).
			if (own.held) {
				const now = version();
				if (own.away)
					own = {
						present: own.present,
						base: undefined,
						replaced: false,
						held: true,
						...(now === own.base ? { under: now } : {}),
					};
				return;
			}
			// A move of the view's away goes (through, or let go) before what it made at P: with P gone, P is free.
			if (own.base === prior || (own.away && prior === undefined)) origin = version();
			own = undefined;
		};
		/** A change; where it had to publish first (the core moved, or the view's move away no longer shows at its
		 * destination: it was let go), that boundary came before it. */
		const change = async (act: () => Promise<unknown>) => {
			const [prior, seq] = [version(), core.seq];
			await act();
			if (core.seq !== seq || (own?.away && (await shown(own.away.to)) !== own.away.text)) published(prior);
		};
		/** The view's own change at P, a file there after it or none. */
		const mine = (present: boolean, moved: boolean, away?: Own["away"]) => {
			const now = version();
			if (!own) {
				own = { present, base: now, replaced: !present || (moved && now !== undefined), held: false };
				if (away) own.away = away;
			} else if (present) {
				// A move in over the view's own file replaces the file a failed move left under it too: that move in fails
				// against it (the view never saw it), and the draft then lands against it.
				const base = moved && own.under !== undefined ? own.under : own.base;
				own = {
					...own,
					present,
					base,
					replaced: own.replaced || (moved && base !== undefined),
					held: own.held && !moved,
					// A save over what the view took away makes a new file there, and one into that file keeps it new.
					fresh: !moved && (own.fresh === true || !own.present),
				};
			} else if (own.base === undefined) own = undefined;
			else own = { ...own, present, replaced: true, held: false, fresh: false };
			if (!present || moved) origin = undefined;
		};
		const theirs = async (how: "write" | "delete" | "move", n: number) => {
			if (how === "write") core.write(await storeFile(root, P, `theirs ${n}`, 100 + n, BIG));
			else if (how === "delete") core.remove(P);
			else {
				const old = core.entries.get(P);
				if (!old) throw new Error("nothing to move");
				core.commitChanges([
					{ ...old, op: "move_out" },
					{ ...old, path: "docs/r.md", version: v(110 + n), op: "move_in", priorVersion: old.version },
				]);
			}
			await service.poll();
			await service.settled();
			// What the view took away there is moot once another machine changed or removed it: that removal goes, but a new
			// file of the view's there still replaces the version it took (the core's conflict). The view's move away keeps
			// hiding the path until its boundary (where it fails, its source changed).
			if (own?.replaced && !own.away && !own.fresh)
				own = own.present ? { ...own, base: undefined, replaced: false } : undefined;
		};
		const act = async (event: Event, n: number): Promise<string | undefined> => {
			const showsP = own ? own.present : version() !== undefined;
			switch (event) {
				case "save":
					await change(() => write(view, P, "own"));
					mine(true, false);
					return;
				case "unlink":
					if (!showsP) return "skip";
					await change(() => view.unlink(P, undefined));
					mine(false, false);
					return;
				case "moveAway": {
					if (!showsP) return "skip";
					const text = await shown(P);
					await change(() => view.rename({ from: P, to: "docs/away.md", noReplace: false }));
					mine(false, false, { to: "docs/away.md", text });
					return;
				}
				case "moveIn":
					if (!qShown) return "skip";
					qShown = false;
					await change(() => view.rename({ from: Q, to: P, noReplace: false }));
					mine(true, true);
					return;
				case "redraft":
					await change(async () => {
						const again = await view.open({
							path: P,
							create: true,
							exclusive: false,
							truncate: true,
							draft: true,
						});
						const data = SECOND_DRAFT;
						await view.chunk({
							handle: again.handle,
							index: 0,
							sha256: hashOf(data),
							bytes: data.byteLength,
							offset: 0,
							data,
						});
						await view.close(again.handle, data.byteLength);
					});
					mine(true, false);
					return;
				case "fill":
					filled = true;
					await view.chunk({
						handle,
						index: 0,
						sha256: hashOf(DRAFTED),
						bytes: DRAFTED.byteLength,
						offset: 0,
						data: DRAFTED,
					});
					return;
				case "theirs":
					await theirs("write", n);
					return;
				case "theirsGone":
					if (version() === undefined) return "skip";
					await theirs("delete", n);
					return;
				case "theirsMoved":
					if (version() === undefined) return "skip";
					await theirs("move", n);
					return;
				case "theirsAway":
					// Another machine makes files where the view's moves away go: those moves fail at their boundary.
					for (const [i, path] of ["docs/away.md", "docs/gone.md"].entries())
						core.write(await storeFile(root, path, `theirs ${n}`, 120 + 2 * n + i, BIG));
					await service.poll();
					await service.settled();
					if (own?.away) own = { ...own, doomed: true };
					return;
				case "theirsQ":
					// Another machine changes the file the view's move in takes: that move fails at its boundary.
					core.write(await storeFile(root, Q, `theirs ${n}`, 130 + n, BIG));
					await service.poll();
					await service.settled();
					return;
				case "close":
					ended = "close";
					await change(() => view.close(handle, filled ? DRAFTED.byteLength : 0));
					return;
				case "discard":
					ended = "discard";
					if (own) own = { ...own, held: false };
					await view.discard(handle);
					return;
			}
		};
		for (const [n, event] of [first, second].entries()) {
			if (n === 1 && boundary) {
				// After a boundary the view has no change of its own at P left (saved, a conflict, or a move let go).
				const prior = version();
				await view.publish();
				published(prior);
			}
			const skipped = await act(event, n + 1).catch(
				(e: unknown) => `${event} failed: ${(e as { code?: string }).code ?? String(e)}`,
			);
			if (skipped) return skipped;
			if (!ended && filled && (await shown(P)) === "drafted") return `the view shows the draft after ${event}`;
		}
		if (!ended) {
			ended = "close";
			await change(() => view.close(handle, filled ? DRAFTED.byteLength : 0));
		}
		const landing = own ? own.base : origin;
		const [priorVersion, priorSha] = [version(), core.entries.get(P)?.fileSha256];
		await view.publish();
		const sha = core.entries.get(P)?.fileSha256;
		const drafted = hashOf(filled ? DRAFTED : "");
		if (ended === "close") {
			// Over the view's move of the file at P away, the draft lands as a new file there (as a create would): saved
			// where that move goes through or P is gone by then, a conflict with the file the move left where it fails.
			const lands = own?.away
				? (!own.doomed && priorVersion === own.base) || priorVersion === undefined
				: priorVersion === landing;
			const want = lands ? drafted : priorSha;
			if (sha !== want) return `the core holds ${name(sha)}, ${name(want)} expected`;
		} else if (sha === drafted) return "a discarded draft landed";
		const after = await shown(P);
		if ((after === undefined ? undefined : hashOf(after)) !== sha)
			return `the view shows ${after === undefined ? "nothing" : `"${after}"`}, the core ${name(sha)}`;
		const again = await view.publish();
		if (again.paths.length > 0) return `${JSON.stringify(again.paths)} stayed pending`;
	}

	for (const start of STARTS)
		it(`lands as the view's newest change at its path, over a start ${start}`, async () => {
			const failures: string[] = [];
			let ran = 0;
			for (const first of FIRST)
				for (const boundary of [false, true])
					for (const second of SECOND) {
						const failure = await sequence(start, [first, second], boundary).catch(
							(e: unknown) => `threw ${String(e)}`,
						);
						for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
						if (failure === "skip") continue;
						ran++;
						if (failure) failures.push(`${first}${boundary ? " | " : ", "}${second}: ${failure}`);
					}
			expect(failures).toEqual([]);
			expect(ran).toBeGreaterThan(80);
		}, 300_000);
});

describe("write-through ByteCache and sliding-window staging", () => {
	it("serves stageFile and secret scans from write-through ByteCache with zero NAS chunk reads", async () => {
		const { root, core, objects, uploads, open } = await fixture();
		const view = await open();

		const singleBytes = Buffer.from("single-part write-through payload");
		const singleSha = hashOf(singleBytes);
		const singleHandle = await view.open({ path: "single.txt", create: true, exclusive: false, truncate: true });
		await view.chunk({
			handle: singleHandle.handle,
			index: 0,
			sha256: singleSha,
			bytes: singleBytes.byteLength,
			offset: 0,
			data: singleBytes,
		});
		expect(objects.has(PROFILE, singleSha)).toBe(true);
		await rm(join(root, PROFILE, singleSha));
		await view.close(singleHandle.handle, singleBytes.byteLength);

		const multiBytes = Buffer.from("first half of chunk + second half of chunk");
		const multiSha = hashOf(multiBytes);
		const mid = Math.floor(multiBytes.byteLength / 2);
		const multiHandle = await view.open({ path: "multi.txt", create: true, exclusive: false, truncate: true });
		await view.chunk({
			handle: multiHandle.handle,
			index: 0,
			sha256: multiSha,
			bytes: multiBytes.byteLength,
			offset: 0,
			data: multiBytes.subarray(0, mid),
		});
		expect(objects.has(PROFILE, multiSha)).toBe(false);
		await view.chunk({
			handle: multiHandle.handle,
			index: 0,
			sha256: multiSha,
			bytes: multiBytes.byteLength,
			offset: mid,
			data: multiBytes.subarray(mid),
		});
		expect(objects.has(PROFILE, multiSha)).toBe(true);
		await rm(join(root, PROFILE, multiSha));
		await view.close(multiHandle.handle, multiBytes.byteLength);

		const report = await view.publish();
		expect(byPath(report.paths)).toEqual([
			{ path: "multi.txt", outcome: "saved" },
			{ path: "single.txt", outcome: "saved" },
		]);

		const staging = new FolderStaging(core, uploads, objects);
		const staged = await staging.stageFile(
			ENV,
			{ kind: "member", userId: MEMBER },
			PROFILE,
			{
				size: singleBytes.byteLength + multiBytes.byteLength,
				chunks: [
					{ sha256: singleSha, bytes: singleBytes.byteLength },
					{ sha256: multiSha, bytes: multiBytes.byteLength },
				],
			},
			"text/plain",
			false,
			secretsOf("not-present-secret-value"),
		);
		expect(staged.file.fileSha256).toBe(hashOf(Buffer.concat([singleBytes, multiBytes])));

		uploads.failures = 1;
		const failedBytes = Buffer.from("never-cached-on-failure");
		const failedSha = hashOf(failedBytes);
		const failedHandle = await view.open({ path: "fail.txt", create: true, exclusive: false, truncate: true });
		await refused(
			view.chunk({
				handle: failedHandle.handle,
				index: 0,
				sha256: failedSha,
				bytes: failedBytes.byteLength,
				offset: 0,
				data: failedBytes,
			}),
			"UNAVAILABLE",
		);
		expect(objects.has(PROFILE, failedSha)).toBe(false);
		await view.close(failedHandle.handle, 0);
	});

	it("aborts in-flight multi-part uploads on close so the upload buffer budget never leaks", async () => {
		const { objects, open } = await fixture({ cacheBytes: 1024 });
		const view = await open();
		for (let i = 0; i < 4; i++) {
			const partial = Buffer.alloc(512, 0x30 + i);
			const opened = await view.open({ path: `aborted-${i}.bin`, create: true, exclusive: false, truncate: true });
			await view.chunk({
				handle: opened.handle,
				index: 0,
				sha256: hashOf(partial),
				bytes: partial.byteLength,
				offset: 0,
				data: partial.subarray(0, 256),
			});
			await view.close(opened.handle, 0);
		}
		const complete = Buffer.alloc(512, 0x7a);
		const completeSha = hashOf(complete);
		const opened = await view.open({ path: "complete.bin", create: true, exclusive: false, truncate: true });
		await view.chunk({
			handle: opened.handle,
			index: 0,
			sha256: completeSha,
			bytes: complete.byteLength,
			offset: 0,
			data: complete.subarray(0, 256),
		});
		await view.chunk({
			handle: opened.handle,
			index: 0,
			sha256: completeSha,
			bytes: complete.byteLength,
			offset: 256,
			data: complete.subarray(256),
		});
		expect(objects.has(PROFILE, completeSha)).toBe(true);
		await view.close(opened.handle, complete.byteLength);
	});

	it("stages remaining files past STAGING_PARALLEL without stalling behind one slow file", async () => {
		const count = 12;
		const files = Array.from({ length: count }, (_, i) => {
			const name = `f${String(i).padStart(2, "0")}.txt`;
			const body = Buffer.from(`sliding-window-file-${i}`);
			const sha = hashOf(body);
			const manifestSha = hashOf(
				manifestText({
					fileSha256: sha,
					bytes: body.byteLength,
					mediaType: "text/plain",
					executable: false,
					chunks: [{ sha256: sha, bytes: body.byteLength }],
				}),
			);
			return { name, body, sha, manifestSha };
		});
		const manifestShas = new Set(files.map((f) => f.manifestSha));
		const slowManifestSha = files[0]!.manifestSha;
		let rejectManifests = true;
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let activeManifests = 0;
		let peakManifests = 0;
		const completedFast = new Set<string>();
		let allFastDone!: () => void;
		const fastFinished = new Promise<void>((resolve) => {
			allFastDone = resolve;
		});

		const { open } = await fixture({
			wrapUploads: (inner) => ({
				start(environmentId, actor, intentId, sha256, bytes) {
					const base = inner.start(environmentId, actor, intentId, sha256, bytes);
					if (!manifestShas.has(sha256)) return base;
					return {
						write: (part) => base.write(part),
						abort: () => base.abort(),
						end: async () => {
							if (rejectManifests) throw new Error("defer staging until publish");
							activeManifests++;
							peakManifests = Math.max(peakManifests, activeManifests);
							try {
								if (sha256 === slowManifestSha) await slowGate;
								await base.end();
								if (sha256 !== slowManifestSha) {
									completedFast.add(sha256);
									if (completedFast.size === count - 1) allFastDone();
								}
							} finally {
								activeManifests--;
							}
						},
					};
				},
			}),
		});
		const view = await open();
		for (const file of files) {
			const opened = await view.open({ path: file.name, create: true, exclusive: false, truncate: true });
			await view.chunk({
				handle: opened.handle,
				index: 0,
				sha256: file.sha,
				bytes: file.body.byteLength,
				offset: 0,
				data: file.body,
			});
			await view.close(opened.handle, file.body.byteLength);
		}
		rejectManifests = false;
		const publishing = view.publish();
		await fastFinished;
		expect(completedFast.size).toBe(count - 1);
		expect(peakManifests).toBeLessThanOrEqual(8);
		releaseSlow();
		const report = await publishing;
		expect(report.paths).toHaveLength(count);
		expect(report.paths.every((p) => p.outcome === "saved")).toBe(true);
	});
});

describe("multi-batch boundary commits", () => {
	it("publishes up to 1,000 units in a single commit RPC without batch splitting", async () => {
		const { core, open } = await fixture();
		core.seed([folder("bulk")]);
		const view = await open();
		for (let i = 0; i < 1000; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);
		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(core.commits[0]?.units).toHaveLength(1000);
		expect(core.commits[0]?.key).not.toMatch(/:b\d+$/);
		expect(report.refused).toBeUndefined();
		expect(report.commitId).toBeTruthy();
		expect(report.seq).toBe(core.seq);
		expect(report.paths).toHaveLength(1000);
		expect(report.paths.every((p) => p.outcome === "saved")).toBe(true);
		for (let i = 0; i < 1000; i++) expect(core.entries.has(`bulk/f${String(i).padStart(4, "0")}.txt`)).toBe(true);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.commits).toHaveLength(1);
	});

	it("splits a 2,500-file boundary into 1,000 + 1,000 + 500 sequential commits and clears pending state", async () => {
		const { core, open } = await fixture();
		core.seed([folder("bulk")]);
		const view = await open();
		for (let i = 0; i < 2500; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `body-${i % 16}`);
		const report = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000, 500]);
		const baseKey = core.commits[0]!.key;
		expect(baseKey).not.toMatch(/:b\d+$/);
		expect(core.commits[1]?.key).toBe(`${baseKey}:b1`);
		expect(core.commits[2]?.key).toBe(`${baseKey}:b2`);
		expect(report.refused).toBeUndefined();
		expect(report.commitId).toBeTruthy();
		expect(report.seq).toBe(core.seq);
		expect(report.paths).toHaveLength(2500);
		expect(report.paths.every((p) => p.outcome === "saved")).toBe(true);
		for (let i = 0; i < 2500; i++) expect(core.entries.has(`bulk/f${String(i).padStart(4, "0")}.txt`)).toBe(true);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
		expect(core.commits).toHaveLength(3);
	});

	it("preserves parent-before-child, free-before-fill, and kept denied bytes across multi-batch boundaries", async () => {
		const { root, core, open } = await fixture();
		const seeded = [
			folder("work"),
			await storeFile(root, "work/old.txt", "old", 1),
			await storeFile(root, "work/move-src.txt", "moved", 2),
			await storeFile(root, "work/outside.txt", "outside", 3),
			await storeFile(root, "work/del-me.txt", "gone", 4),
			await storeFile(root, "work/keep-deny.txt", "orig", 5),
		];
		for (let i = 0; i < 1050; i++)
			seeded.push(await storeFile(root, `work/u${String(i).padStart(4, "0")}.txt`, "v1", 10 + i));
		core.seed(seeded);
		core.refuse = (path) => path === "work/keep-deny.txt";

		const view = await open();
		const keepEntry = core.entries.get("work/keep-deny.txt")!;
		await write(view, "work/keep-deny.txt", "updated-secret", keepEntry.version);
		for (let i = 0; i < 1050; i++) {
			const path = `work/u${String(i).padStart(4, "0")}.txt`;
			await write(view, path, "v2", core.entries.get(path)!.version);
		}
		await view.unlink("work/del-me.txt", undefined);
		await view.rename({ from: "work/move-src.txt", to: "work/old.txt", noReplace: false });
		await view.mkdir("work/sub");
		await view.rename({ from: "work/outside.txt", to: "work/sub/moved.txt", noReplace: false });
		for (let i = 0; i < 100; i++) await write(view, `work/sub/n${String(i).padStart(3, "0")}.txt`, `n-${i % 8}`);

		const report = await view.publish();
		expect(core.commits.length).toBeGreaterThan(1);
		expect(core.commits.every((c) => c.units.length <= 1000)).toBe(true);
		const flatUnits = core.commits.flatMap((c) => c.units);
		const mkdirIdx = flatUnits.findIndex((u) => u.op === "mkdir" && u.path === "work/sub");
		const firstChildIdx = flatUnits.findIndex(
			(u) =>
				(u.op === "write" && u.path.startsWith("work/sub/")) || (u.op === "move" && u.to.startsWith("work/sub/")),
		);
		expect(mkdirIdx).toBeGreaterThanOrEqual(0);
		expect(firstChildIdx).toBeGreaterThan(mkdirIdx);
		const deleteOldIdx = flatUnits.findIndex((u) => u.op === "delete" && u.path === "work/old.txt");
		const moveIntoOldIdx = flatUnits.findIndex((u) => u.op === "move" && u.to === "work/old.txt");
		expect(deleteOldIdx).toBeGreaterThanOrEqual(0);
		expect(moveIntoOldIdx).toBeGreaterThan(deleteOldIdx);

		const deniedEntry = report.paths.find((p) => p.path === "work/keep-deny.txt");
		expect(deniedEntry).toEqual({ path: "work/keep-deny.txt", outcome: "denied", reason: "denied", kept: true });
		expect(report.paths.filter((p) => p.path !== "work/keep-deny.txt").every((p) => p.outcome === "saved")).toBe(
			true,
		);
		expect(core.entries.has("work/del-me.txt")).toBe(false);
		expect(core.entries.has("work/move-src.txt")).toBe(false);
		expect(core.entries.has("work/old.txt")).toBe(true);
		expect(core.entries.has("work/sub/moved.txt")).toBe(true);
		expect(core.entries.has("work/sub/n099.txt")).toBe(true);

		core.refuse = () => false;
		const commitsBeforeRetry = core.commits.length;
		const retry = await view.publish();
		expect(core.commits).toHaveLength(commitsBeforeRetry + 1);
		expect(core.commits.at(-1)?.units).toHaveLength(1);
		expect(retry.paths).toEqual([{ path: "work/keep-deny.txt", outcome: "saved" }]);
		expect(await read(view, "work/keep-deny.txt")).toBe("updated-secret");
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("keeps command finals on the single-commit path after endCommand while auto-splitting non-final publishes", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-final-"));
		const core = new FakeCore();
		core.seed([folder("out"), folder("pre")]);
		const viewId = "5e6f7081-92a3-4b4c-8d5e-6f708192a3b4";
		const cmdPass = "cmdpass_0123456789-abcdefghijklmnopqrstuvwx";
		core.openView(viewId, cmdPass, { kind: "computer_shell_command", machineId: ALLOCATION });
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: companyGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		const atOffice: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
		const view = await service.open({ protocol: 3, environmentId: ENV, viewId, pass: cmdPass, role: "io" }, atOffice);
		cleanups.push(async () => {
			view.release();
			service.stop();
			await rm(root, { recursive: true, force: true });
		});

		for (let i = 0; i < 1050; i++) await write(view, `pre/f${String(i).padStart(4, "0")}.txt`, `p-${i % 8}`);
		const runningReport = await view.publish(false);
		expect(core.commits.map((c) => ({ count: c.units.length, final: c.final }))).toEqual([
			{ count: 1000, final: false },
			{ count: 50, final: false },
		]);
		expect(runningReport.refused).toBeUndefined();
		expect(runningReport.paths).toHaveLength(1050);
		expect(runningReport.paths.every((p) => p.outcome === "saved")).toBe(true);

		for (let i = 0; i < 1050; i++) await write(view, `out/f${String(i).padStart(4, "0")}.txt`, `o-${i % 8}`);
		core.endCommand(viewId);
		const finalReport = await view.publish(true);
		expect(core.commits.slice(2).map((c) => ({ count: c.units.length, final: c.final }))).toEqual([
			{ count: 1050, final: true },
		]);
		expect(finalReport.refused).toBe("invalid");
		expect(finalReport.commitId).toBeNull();
		expect(finalReport.seq).toBeNull();
		expect(finalReport.closed).toBeUndefined();
		expect([...core.entries.keys()].filter((p) => p.startsWith("out/"))).toHaveLength(0);
	});

	it("stops on mid-batch refusal, clears batch 1, keeps batches 2 and 3 pending, and retries cleanly", async () => {
		const { core, open } = await fixture();
		core.seed([folder("bulk")]);
		const view = await open();
		for (let i = 0; i < 2500; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "stopped";
			return undefined;
		};
		const first = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000]);
		expect(first.refused).toBe("stopped");
		expect(first.commitId).toBeNull();
		expect(first.seq).toBeNull();
		expect(first.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(first.paths.filter((p) => p.outcome === "refused" && p.kept)).toHaveLength(1500);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(1000);

		core.commitHook = undefined;
		core.commitRefusal = undefined;
		const second = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000, 1000, 500]);
		expect(second.refused).toBeUndefined();
		expect(second.commitId).toBeTruthy();
		expect(second.seq).toBe(core.seq);
		expect(second.paths).toHaveLength(1500);
		expect(second.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(2500);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("handles non-liftable mid-batch denied refusal without corrupting pending state", async () => {
		const { root, core, open } = await fixture();
		const seeded = [folder("bulk"), await storeFile(root, "bulk/del.txt", "d", 1)];
		for (let i = 0; i < 1000; i++)
			seeded.push(await storeFile(root, `bulk/e${String(i).padStart(4, "0")}.txt`, "v1", 10 + i));
		core.seed(seeded);
		const view = await open();
		for (let i = 0; i < 1000; i++) {
			const path = `bulk/e${String(i).padStart(4, "0")}.txt`;
			await write(view, path, "v2", core.entries.get(path)!.version);
		}
		await view.unlink("bulk/del.txt", undefined);
		for (let i = 0; i < 200; i++) await write(view, `bulk/n${String(i).padStart(4, "0")}.txt`, `n-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "denied";
			return undefined;
		};
		const first = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 201]);
		expect(first.refused).toBe("denied");
		expect(first.commitId).toBeNull();
		expect(first.seq).toBeNull();
		expect(first.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(first.paths.filter((p) => p.outcome === "refused" && p.kept)).toHaveLength(200);
		expect(first.paths.find((p) => p.path === "bulk/del.txt")).toEqual({
			path: "bulk/del.txt",
			outcome: "refused",
			reason: "denied",
		});

		core.commitHook = undefined;
		core.commitRefusal = undefined;
		const second = await view.publish();
		expect(second.refused).toBeUndefined();
		expect(second.paths).toHaveLength(200);
		expect(second.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.has("bulk/del.txt")).toBe(true);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("replays an unanswered mid-batch commit under its deterministic key and finishes remaining batches", async () => {
		const { core, open } = await fixture();
		core.seed([folder("bulk")]);
		const view = await open();
		for (let i = 0; i < 2500; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitFailures = { count: 3, mode: "down" };
			return undefined;
		};
		const first = await view.publish();
		const baseKey = core.commits[0]!.key;
		expect(core.commits.map((c) => ({ key: c.key, count: c.units.length }))).toEqual([
			{ key: baseKey, count: 1000 },
			{ key: `${baseKey}:b1`, count: 1000 },
			{ key: `${baseKey}:b1`, count: 1000 },
			{ key: `${baseKey}:b1`, count: 1000 },
		]);
		expect(first.commitId).toBeTruthy();
		expect(first.seq).toBe(1);
		expect(first.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(first.paths.filter((p) => p.outcome === "not_applied" && p.kept)).toHaveLength(1500);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(1000);

		core.commitHook = undefined;
		const second = await view.publish();
		expect(core.commits.slice(4).map((c) => ({ key: c.key, count: c.units.length }))).toEqual([
			{ key: `${baseKey}:b1`, count: 1000 },
			{ key: expect.stringMatching(/^folder-view:/), count: 500 },
		]);
		expect(second.commitId).toBeTruthy();
		expect(second.paths).toHaveLength(1500);
		expect(second.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(2500);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("splits boundaries exceeding 64 structured files into compliant batches", async () => {
		const { core, open } = await fixture();
		core.seed([folder("QorperaOS")]);
		const view = await open();
		await view.mkdir("QorperaOS/rules");
		for (let i = 0; i < 70; i++)
			await write(view, `QorperaOS/rules/r${String(i).padStart(2, "0")}.md`, `# Rule ${i}\n`);
		const report = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([65, 6]);
		expect(core.commits[0]?.units[0]).toEqual({ op: "mkdir", path: "QorperaOS/rules" });
		expect(report.refused).toBeUndefined();
		expect(report.paths).toHaveLength(71);
		expect(report.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.has("QorperaOS/rules/r69.md")).toBe(true);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("orders git objects before index and logs across batches and keeps repo metadata intact on mid-batch refusal", async () => {
		const { root, core, open } = await fixture();
		const indexEntry = await storeFile(root, "code/acme/app/repo.git/worktrees/w1/index", "idx-v1", 1);
		const logEntry = await storeFile(root, "code/acme/app/repo.git/worktrees/w1/logs/HEAD", "log-v1", 2);
		core.seed([
			folder("code"),
			folder("code/acme"),
			folder("code/acme/app"),
			folder("code/acme/app/repo.git"),
			folder("code/acme/app/repo.git/objects"),
			folder("code/acme/app/repo.git/objects/00"),
			folder("code/acme/app/repo.git/worktrees"),
			folder("code/acme/app/repo.git/worktrees/w1"),
			indexEntry,
			folder("code/acme/app/repo.git/worktrees/w1/logs"),
			logEntry,
		]);
		const view = await open();
		await write(view, "code/acme/app/repo.git/worktrees/w1/index", "idx-v2", indexEntry.version);
		await write(view, "code/acme/app/repo.git/worktrees/w1/logs/HEAD", "log-v2", logEntry.version);
		for (let i = 0; i < 1050; i++)
			await write(view, `code/acme/app/repo.git/objects/00/${String(i).padStart(38, "a")}`, `obj-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "stopped";
			return undefined;
		};
		const partial = await view.publish();
		expect(partial.refused).toBe("stopped");
		expect(partial.commitId).toBeNull();
		expect(core.commits).toHaveLength(2);
		expect(
			core.commits[0]?.units.every((u) => u.op === "write" && u.path.startsWith("code/acme/app/repo.git/objects/")),
		).toBe(true);
		expect(core.entries.get("code/acme/app/repo.git/worktrees/w1/index")?.version).toBe(indexEntry.version);
		expect(core.entries.get("code/acme/app/repo.git/worktrees/w1/logs/HEAD")?.version).toBe(logEntry.version);

		core.commitHook = undefined;
		core.commitRefusal = undefined;
		const done = await view.publish();
		expect(done.refused).toBeUndefined();
		expect(done.paths.every((p) => p.outcome === "saved")).toBe(true);
		const lastCommitPaths = core.commits.at(-1)?.units.map((u) => (u.op === "move" ? u.to : u.path)) ?? [];
		expect(lastCommitPaths).toContain("code/acme/app/repo.git/worktrees/w1/index");
		expect(lastCommitPaths).toContain("code/acme/app/repo.git/worktrees/w1/logs/HEAD");
		expect(core.entries.get("code/acme/app/repo.git/worktrees/w1/index")?.version).not.toBe(indexEntry.version);
		expect(core.entries.get("code/acme/app/repo.git/worktrees/w1/logs/HEAD")?.version).not.toBe(logEntry.version);
	});

	it("stops at maxBoundaryBatches and completes remaining batches on the next publish", async () => {
		const { core, open } = await fixture({ maxBoundaryBatches: 2 });
		core.seed([folder("bulk")]);
		const view = await open();
		for (let i = 0; i < 2500; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);

		const first = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000]);
		expect(first.refused).toBeUndefined();
		expect(first.commitId).toBeNull();
		expect(first.seq).toBeNull();
		expect(first.paths.filter((p) => p.outcome === "saved")).toHaveLength(2000);
		expect(first.paths.filter((p) => p.outcome === "not_applied" && p.kept)).toHaveLength(500);

		const second = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000, 500]);
		expect(second.commitId).toBeTruthy();
		expect(second.paths).toHaveLength(500);
		expect(second.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("records one notice per committed or refused batch for unasked desktop boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-notices-"));
		const core = new FakeCore();
		core.seed([folder("docs")]);
		const viewId = "4d5e6f70-8192-4a3b-8c4d-5e6f708192a3";
		const deskPass = "deskpass_0123456789-abcdefghijklmnopqrstuvw";
		core.openView(viewId, deskPass, { kind: "computer_desktop", machineId: ALLOCATION });
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: companyGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		const atOffice: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
		const view = await service.open(
			{ protocol: 3, environmentId: ENV, viewId, pass: deskPass, role: "io" },
			atOffice,
		);
		const asks = service.notices(
			{ protocol: 4, environmentId: ENV, viewId, pass: deskPass, role: "notices" },
			atOffice,
		);
		cleanups.push(async () => {
			service.stop();
			await rm(root, { recursive: true, force: true });
		});

		for (let i = 0; i < 2500; i++) await write(view, `docs/f${String(i).padStart(4, "0")}.txt`, `d-${i % 8}`);
		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "stopped";
			return undefined;
		};
		view.release();
		for (
			const end = Date.now() + 5_000;
			asks.page({ after: 0, nonce: null }).notices.length < 2 && Date.now() < end;
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		const page = asks.page({ after: 0, nonce: null });
		expect(page.notices).toHaveLength(2);
		expect(page.notices[0]).toMatchObject({ n: 1, commitId: expect.any(String), seq: 1 });
		expect(page.notices[1]).toMatchObject({ n: 2, refused: "stopped", pathCount: 1500 });
	});

	it("stops mid-batch when a view becomes unproven or closes during an earlier batch", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-midstop-"));
		const core = new FakeCore();
		core.seed([folder("u"), folder("c")]);
		const unprovenViewId = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f708192a3";
		const closedViewId = "8a8b9c0d-1e2f-4a3b-8c4d-5e6f708192a3";
		const passA = "deskpass_a123456789-abcdefghijklmnopqrstuvw";
		const passB = "deskpass_b123456789-abcdefghijklmnopqrstuvw";
		core.openView(unprovenViewId, passA, { kind: "computer_desktop", machineId: ALLOCATION });
		core.openView(closedViewId, passB, { kind: "computer_desktop", machineId: ALLOCATION });
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: companyGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		const atOffice: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
		const viewA = await service.open(
			{ protocol: 3, environmentId: ENV, viewId: unprovenViewId, pass: passA, role: "io" },
			atOffice,
		);
		const viewB = await service.open(
			{ protocol: 3, environmentId: ENV, viewId: closedViewId, pass: passB, role: "io" },
			atOffice,
		);
		cleanups.push(async () => {
			viewA.release();
			viewB.release();
			service.stop();
			await rm(root, { recursive: true, force: true });
		});

		for (let i = 0; i < 1200; i++) await write(viewA, `u/f${String(i).padStart(4, "0")}.txt`, `u-${i % 8}`);
		core.commitHook = async (callIndex) => {
			if (callIndex === 0) await viewA.reads({ log: "log-a", reads: [], lost: true });
		};
		const unprovenReport = await viewA.publish();
		expect(core.commits).toHaveLength(1);
		expect(unprovenReport.refused).toBe("unproven");
		expect(unprovenReport.commitId).toBeNull();
		expect(unprovenReport.seq).toBeNull();
		expect(unprovenReport.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(unprovenReport.paths.filter((p) => p.outcome === "refused" && p.kept)).toHaveLength(200);

		core.commitHook = undefined;
		const commitsBeforeClosed = core.commits.length;
		for (let i = 0; i < 1200; i++) await write(viewB, `c/f${String(i).padStart(4, "0")}.txt`, `c-${i % 8}`);
		const origCommit = core.commit.bind(core);
		let closedTriggered = false;
		core.commit = async (...args) => {
			const answer = await origCommit(...args);
			if (!closedTriggered && core.commits.length === commitsBeforeClosed + 1) {
				closedTriggered = true;
				core.views.get(closedViewId)!.state = "closed";
				await service.renewLeases();
			}
			return answer;
		};
		await expect(viewB.publish()).rejects.toMatchObject({ code: "VIEW_CLOSED" });
		expect(core.commits).toHaveLength(commitsBeforeClosed + 1);
		expect([...core.entries.keys()].filter((p) => p.startsWith("c/"))).toHaveLength(1000);
	});

	it("holds all uncommitted batches on a command view mid-batch refusal", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-cmdhold-"));
		const core = new FakeCore();
		const seeded = [folder("cmd"), await storeFile(root, "cmd/del.txt", "d", 1)];
		for (let i = 0; i < 1000; i++)
			seeded.push(await storeFile(root, `cmd/e${String(i).padStart(4, "0")}.txt`, "v1", 10 + i));
		core.seed(seeded);
		const viewId = "6e6f7081-92a3-4b4c-8d5e-6f708192a3b4";
		const cmdPass = "cmdpass_1123456789-abcdefghijklmnopqrstuvwx";
		core.openView(viewId, cmdPass, { kind: "computer_shell_command", machineId: ALLOCATION });
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: companyGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		const atOffice: BridgeInfo = { cid: 90, lookup: "found", machine: OFFICE };
		const view = await service.open({ protocol: 3, environmentId: ENV, viewId, pass: cmdPass, role: "io" }, atOffice);
		cleanups.push(async () => {
			view.release();
			service.stop();
			await rm(root, { recursive: true, force: true });
		});

		for (let i = 0; i < 1000; i++) {
			const path = `cmd/e${String(i).padStart(4, "0")}.txt`;
			await write(view, path, "v2", core.entries.get(path)!.version);
		}
		await view.unlink("cmd/del.txt", undefined);
		for (let i = 0; i < 100; i++) await write(view, `cmd/n${String(i).padStart(3, "0")}.txt`, `n-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "denied";
			return undefined;
		};
		const first = await view.publish(false);
		expect(first.refused).toBe("denied");
		expect(first.commitId).toBeNull();
		expect(first.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(first.paths.filter((p) => p.outcome === "refused" && p.kept)).toHaveLength(101);
		expect(first.paths.find((p) => p.path === "cmd/del.txt")).toEqual({
			path: "cmd/del.txt",
			outcome: "refused",
			reason: "denied",
			kept: true,
		});

		core.commitHook = undefined;
		core.commitRefusal = undefined;
		const second = await view.publish(false);
		expect(second.refused).toBeUndefined();
		expect(second.paths).toHaveLength(101);
		expect(second.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.has("cmd/del.txt")).toBe(false);
	});

	it("settles uncommitted batches on a coding view last-boundary mid-batch refusal", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-codinglast-"));
		const core = new FakeCore();
		const seeded = [folder("src"), await storeFile(root, "src/del.txt", "d", 1)];
		for (let i = 0; i < 1000; i++)
			seeded.push(await storeFile(root, `src/e${String(i).padStart(4, "0")}.txt`, "v1", 10 + i));
		core.seed(seeded);
		const viewId = "9e6f7081-92a3-4b4c-8d5e-6f708192a3b4";
		const codingPass = "codepass_123456789-abcdefghijklmnopqrstuvwx";
		core.openView(viewId, codingPass, { kind: "coding_session", codingMachineId: CODING_MACHINE_ID });
		const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
		const service = new FolderService({
			core,
			objects,
			grants: codingGrants(),
			staging: new FolderStaging(core, new FakeUploads(root, core), objects),
			log: () => undefined,
		});
		service.secrets(CODING_MACHINE_ID, noSecrets());
		const atCoding: BridgeInfo = { cid: 91, lookup: "found", machine: CODING };
		const view = await service.open(
			{ protocol: 3, environmentId: ENV, viewId, pass: codingPass, role: "io" },
			atCoding,
		);
		cleanups.push(async () => {
			view.release();
			service.stop();
			await rm(root, { recursive: true, force: true });
		});

		for (let i = 0; i < 1000; i++) {
			const path = `src/e${String(i).padStart(4, "0")}.txt`;
			await write(view, path, "v2", core.entries.get(path)!.version);
		}
		await view.unlink("src/del.txt", undefined);
		for (let i = 0; i < 100; i++) await write(view, `src/n${String(i).padStart(3, "0")}.txt`, `n-${i % 8}`);

		core.commitHook = (callIndex) => {
			if (callIndex === 1) core.commitRefusal = "denied";
			return undefined;
		};
		const boundary = await service.boundary(CODING_MACHINE_ID, [viewId]);
		expect(boundary.reads).toBe("released");
		const report = boundary.views.find((entry) => entry.viewId === viewId)?.report;
		expect(report?.refused).toBe("denied");
		expect(report?.commitId).toBeNull();
		expect(report?.seq).toBeNull();
		expect(report?.paths.filter((p) => p.outcome === "saved")).toHaveLength(1000);
		expect(report?.paths.filter((p) => p.outcome === "refused" && p.kept)).toHaveLength(100);
		expect(report?.paths.find((p) => p.path === "src/del.txt")).toEqual({
			path: "src/del.txt",
			outcome: "refused",
			reason: "denied",
		});

		core.commitHook = undefined;
		core.commitRefusal = undefined;
		const retry = await service.boundary(CODING_MACHINE_ID, []);
		const retryReport = retry.views.find((entry) => entry.viewId === viewId)?.report;
		expect(retryReport?.refused).toBeUndefined();
		expect(retryReport?.paths).toHaveLength(100);
		expect(retryReport?.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.has("src/del.txt")).toBe(true);
	});

	it("defers feed catch-up and FUSE change push across multi-batch commits until settlement at the end", async () => {
		const { core, open } = await fixture();
		core.seed([folder("bulk")]);
		const pushes: unknown[] = [];
		const view = await open();
		view.subscribe({ change: (message) => pushes.push(message), closed: () => undefined });
		for (let i = 0; i < 2500; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);

		let feedCalls = 0;
		const origFeed = core.feed.bind(core);
		core.feed = async (...args) => {
			feedCalls++;
			return origFeed(...args);
		};
		pushes.length = 0;

		const report = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 1000, 500]);
		expect(report.refused).toBeUndefined();
		expect(report.commitId).toBeTruthy();
		expect(report.seq).toBe(core.seq);
		expect(report.paths).toHaveLength(2500);
		expect(report.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(feedCalls).toBe(1);
		expect(pushes.length).toBeLessThanOrEqual(2);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(2500);
	});

	it("settles committed earlier batches when a mid-loop structured NAS read throws", async () => {
		const { core, objects, open } = await fixture();
		core.seed([folder("bulk"), folder("QorperaOS"), folder("QorperaOS/rules")]);
		const view = await open();
		for (let i = 0; i < 1000; i++) await write(view, `bulk/f${String(i).padStart(4, "0")}.txt`, `v-${i % 8}`);
		await write(view, "QorperaOS/rules/r0.md", "# Rule 0\n");
		for (let i = 0; i < 20; i++) await write(view, `bulk/z${String(i).padStart(4, "0")}.txt`, `z-${i % 4}`);

		const origRead = objects.read.bind(objects);
		let failOnce = true;
		objects.read = async (profileId, entry, offset, length) => {
			if (failOnce && entry.path === "QorperaOS/rules/r0.md") {
				failOnce = false;
				throw new Error("transient NAS outage");
			}
			return origRead(profileId, entry, offset, length);
		};

		await expect(view.publish()).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(core.commits.map((c) => c.units.length)).toEqual([1000]);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/f"))).toHaveLength(1000);
		expect(core.entries.has("QorperaOS/rules/r0.md")).toBe(false);

		const retry = await view.publish();
		expect(core.commits.map((c) => c.units.length)).toEqual([1000, 21]);
		expect(retry.refused).toBeUndefined();
		expect(retry.paths).toHaveLength(21);
		expect(retry.paths.every((p) => p.outcome === "saved")).toBe(true);
		expect(core.entries.has("QorperaOS/rules/r0.md")).toBe(true);
		expect([...core.entries.keys()].filter((p) => p.startsWith("bulk/"))).toHaveLength(1020);
		expect(await view.publish()).toEqual({ commitId: null, seq: null, paths: [] });
	});

	it("fails fast on a single structured file over 1 MiB while publishing valid sibling files", async () => {
		const { core, open } = await fixture();
		core.seed([folder("QorperaOS"), folder("QorperaOS/rules")]);
		const view = await open();
		await write(view, "QorperaOS/rules/huge.md", "x".repeat(MAX_COMMIT_STRUCTURED_BYTES + 1));
		await write(view, "QorperaOS/rules/ok.md", "# Valid rule\n");

		const report = await view.publish();
		expect(core.commits).toHaveLength(1);
		expect(report.paths).toContainEqual({
			path: "QorperaOS/rules/huge.md",
			outcome: "refused",
			reason: STRUCTURED_TOO_LARGE,
			kept: true,
		});
		expect(report.paths).toContainEqual({ path: "QorperaOS/rules/ok.md", outcome: "saved" });
		expect(core.entries.has("QorperaOS/rules/ok.md")).toBe(true);
		expect(core.entries.has("QorperaOS/rules/huge.md")).toBe(false);
	});

	it("parallelizes multi-chunk puts and ordered chunk reads up to STAGE_CONCURRENCY", async () => {
		const { root, core, objects } = await fixture();
		const chunkBuffers = Array.from({ length: 6 }, (_, i) => Buffer.from(`chunk-${i}-${"a".repeat(128)}`));
		const chunkRefs = chunkBuffers.map((buf) => ({ sha256: hashOf(buf), bytes: buf.byteLength }));
		for (let i = 0; i < chunkBuffers.length; i++) {
			await storeFile(root, `seed-${i}.bin`, chunkBuffers[i]!, i + 1, chunkBuffers[i]!.byteLength);
		}
		const freshObjects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		let readInFlight = 0;
		let readPeak = 0;
		const origChunk = freshObjects.chunk.bind(freshObjects);
		freshObjects.chunk = async (profileId, sha256, bytes, priority) => {
			readInFlight++;
			readPeak = Math.max(readPeak, readInFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, 15));
				return await origChunk(profileId, sha256, bytes, priority);
			} finally {
				readInFlight--;
			}
		};

		let putInFlight = 0;
		let putPeak = 0;
		const baseUploads = new FakeUploads(root, core);
		const trackedUploads: FolderUploads = {
			start(environmentId, actor, intentId, sha256, bytes) {
				const inner = baseUploads.start(environmentId, actor, intentId, sha256, bytes);
				return {
					write: (part) => inner.write(part),
					end: async () => {
						putInFlight++;
						putPeak = Math.max(putPeak, putInFlight);
						try {
							await new Promise((resolve) => setTimeout(resolve, 15));
							await inner.end();
						} finally {
							putInFlight--;
						}
					},
					abort: () => inner.abort(),
				};
			},
		};
		const staging = new FolderStaging(core, trackedUploads, freshObjects);
		const totalSize = chunkBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
		const staged = await staging.stageFile(
			ENV,
			{ kind: "member", userId: MEMBER },
			PROFILE,
			{ chunks: chunkRefs, size: totalSize },
			"application/octet-stream",
			false,
			secretsOf("absent-secret-value-0001"),
		);
		expect(staged.file.fileSha256).toBe(hashOf(Buffer.concat(chunkBuffers)));
		expect(readPeak).toBe(STAGE_CONCURRENCY);
		expect(putPeak).toBe(STAGE_CONCURRENCY);
		expect(objects.maxCacheBytes).toBeGreaterThan(0);
	});

	it("preserves early 413 status and rejects truncated responses without hanging in GatewayUploads", async () => {
		const token = "t".repeat(43);
		let mode: "reject413" | "truncate" = "reject413";
		const server = createHttpServer((req, res) => {
			if (mode === "reject413") {
				res.writeHead(413, { connection: "close" });
				res.end();
				req.socket.destroy();
				return;
			}
			res.writeHead(200, { "content-length": "100" });
			res.write("partial");
			res.flushHeaders();
			setTimeout(() => req.socket.destroy(), 15);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const { port } = server.address() as AddressInfo;
		const uploads = new GatewayUploads({ url: `http://127.0.0.1:${port}`, token });
		cleanups.push(async () => {
			uploads.close();
		});
		const actor = { kind: "view" as const, viewId: "9e6f7081-92a3-4b4c-8d5e-6f708192a3b4", pass: PASS };

		const payload = Buffer.alloc(2 * 1024 * 1024, 7);
		const u1 = uploads.start(ENV, actor, "intent-413", hashOf(payload), payload.byteLength);
		let err413: unknown;
		try {
			await u1.write(payload.subarray(0, 64 * 1024));
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			await u1.write(payload.subarray(64 * 1024));
			await u1.end();
		} catch (error) {
			err413 = error;
		}
		expect(err413).toBeInstanceOf(ProtocolError);
		expect((err413 as ProtocolError).code).toBe("TOO_LARGE");

		mode = "truncate";
		const small = Buffer.from("hello");
		const u2 = uploads.start(ENV, actor, "intent-trunc", hashOf(small), small.byteLength);
		await u2.write(small);
		await expect(u2.end()).rejects.toMatchObject({ code: "UNAVAILABLE" });
	});

	it("skips redundant NAS chunk reads for single-chunk stageFile without secrets", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-stage-skip-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const core = new FakeCore();
		const objects = new NasObjects({ root, cacheBytes: 16 * 1024 * 1024 });
		const staging = new FolderStaging(core, new FakeUploads(root, core), objects);
		const data = Buffer.from("single-chunk-bytes");
		const file = await storeFile(root, "one.txt", data, 1, data.byteLength);
		core.seed([file]);
		const sha = hashOf(data);
		const content = { size: data.byteLength, chunks: [{ sha256: sha, bytes: data.byteLength }] };
		core.catalog.set(sha, data.byteLength);
		const chunkSpy = vi.spyOn(objects, "chunk");
		const actor = { kind: "view" as const, viewId: "9e6f7081-92a3-4b4c-8d5e-6f708192a3b4", pass: PASS };
		core.openView(actor.viewId, PASS);
		await staging.stageFile(ENV, actor, PROFILE, content, "text/plain", false);
		await staging.stageFile(ENV, actor, PROFILE, content, "text/plain", false, noSecrets());
		expect(chunkSpy).toHaveBeenCalledTimes(0);

		await staging.stageFile(ENV, actor, PROFILE, content, "text/plain", false, secretsOf("not-in-file"));
		expect(chunkSpy).toHaveBeenCalledTimes(1);
	});

	it("pushes only settled batch paths in #settleNodes and runs due renewIntents concurrently without overlap", async () => {
		let clock = 1_000_000;
		const f = await fixture({ now: () => clock, maxBoundaryBatches: 1 });
		f.core.seed([folder("QorperaOS"), folder("QorperaOS/rules"), folder("src")]);
		const view = await f.open();
		const feedMessages: { resync: boolean; paths: string[] }[] = [];
		view.subscribe({
			change: (msg) => feedMessages.push({ resync: msg.resync, paths: [...msg.paths] }),
			closed: () => undefined,
		});
		for (let i = 0; i < 65; i++) await write(view, `QorperaOS/rules/r${String(i).padStart(3, "0")}.md`, `rule-${i}`);
		for (let i = 0; i < 5; i++) await write(view, `src/later-${i}.txt`, `later-${i}`);
		feedMessages.length = 0;
		const report = await view.publish(false);
		expect(report.paths.filter((p) => p.outcome === "saved")).toHaveLength(64);
		const firstBatchMsg = feedMessages.find((m) => m.paths.includes("QorperaOS/rules/r000.md"));
		expect(firstBatchMsg).toBeDefined();
		expect(firstBatchMsg?.resync).toBe(false);
		expect(firstBatchMsg?.paths.some((p) => p.startsWith("src/later-"))).toBe(false);
		const secondReport = await view.publish(false);
		expect(secondReport.paths.every((p) => p.outcome === "saved")).toBe(true);

		for (let i = 0; i < 6; i++) await write(view, `src/intent-${i}.txt`, `unique-intent-payload-${i}`);
		clock += 11 * 60_000;
		let active = 0;
		let peak = 0;
		let renewCalls = 0;
		const origRenew = f.core.renewUpload.bind(f.core);
		f.core.renewUpload = async (env, actor, id) => {
			renewCalls++;
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			active--;
			return origRenew(env, actor, id);
		};
		await Promise.all([f.service.renewIntents(), f.service.renewIntents()]);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
		expect(renewCalls).toBe(6);
	});

	it("reuses a single-chunk upload intent on stage and falls back cleanly when metadata changes or intent lapses", async () => {
		const { core, open } = await fixture();
		const sealSpy = vi.spyOn(core, "sealUpload");
		const view = await open();
		await write(view, "plain.md", "# Title\n");
		expect(core.intents.size).toBe(1);
		const firstId = [...core.intents.keys()][0]!;
		expect(sealSpy).toHaveBeenCalledTimes(1);
		expect(sealSpy).toHaveBeenLastCalledWith(ENV, expect.anything(), firstId);
		expect((await view.publish()).paths).toEqual([{ path: "plain.md", outcome: "saved" }]);
		expect(core.entries.get("plain.md")?.mediaType).toBe("text/markdown");

		const beforeRename = core.intents.size;
		await write(view, "temp.bin", "renamed markdown");
		await view.rename({ from: "temp.bin", to: "final.md", noReplace: false });
		expect((await view.publish()).paths).toEqual([{ path: "final.md", outcome: "saved" }]);
		expect(core.entries.get("final.md")?.mediaType).toBe("text/markdown");
		expect(core.intents.size).toBe(beforeRename + 2);

		const beforeLapse = core.intents.size;
		const { handle } = await view.open({
			path: "lapsed.txt",
			create: true,
			exclusive: false,
			truncate: true,
		});
		const data = Buffer.from("lapsed chunk intent");
		await view.chunk({ handle, index: 0, sha256: hashOf(data), bytes: data.byteLength, offset: 0, data });
		const chunkIntentId = [...core.intents.keys()].at(-1)!;
		core.lapsed.add(chunkIntentId);
		await view.close(handle, data.byteLength);
		expect((await view.publish()).paths).toEqual([{ path: "lapsed.txt", outcome: "saved" }]);
		expect(core.intents.size).toBe(beforeLapse + 2);
		expect(await read(view, "lapsed.txt")).toBe("lapsed chunk intent");
	});
});
