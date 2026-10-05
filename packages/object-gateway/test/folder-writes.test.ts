import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NasObjects } from "../src/folder-service/objects.ts";
import {
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	type Hello,
	Kind,
	ProtocolError,
	parseChunkPart,
	parseGetChunk,
	parseOpen,
	parseRename,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, type ViewHandle } from "../src/folder-service/service.ts";
import { FolderStaging } from "../src/folder-service/staging.ts";
import {
	BRIDGE,
	ENV,
	FakeCore,
	FakeUploads,
	folder,
	grants,
	hashOf,
	PASS,
	storeFile,
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

async function fixture(options: { quietMs?: number; readOnly?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-writes-"));
	const core = new FakeCore();
	const objects = new NasObjects({ root, cacheBytes: 64 * 1024 * 1024 });
	const uploads = new FakeUploads(root, core);
	const start = () =>
		new FolderService({
			core,
			objects,
			grants: options.readOnly ? grants() : writableGrants(options.quietMs),
			staging: new FolderStaging(core, uploads, objects),
			log: () => undefined,
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
	return { root, core, uploads, service, open, restart };
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
		const byPath = (paths: readonly { path: string }[]) => [...paths].sort((a, b) => (a.path < b.path ? -1 : 1));
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
		const client = async (protocol: number) => {
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
			const hello = await ask(Kind.hello, { protocol, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" });
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
	});
});
