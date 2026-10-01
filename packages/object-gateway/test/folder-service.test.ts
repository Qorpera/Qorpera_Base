import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CoreEntry, parseFeedPage, parseListPage } from "../src/folder-service/core.ts";
import { NasObjects, ObjectIntegrityError, parseManifest } from "../src/folder-service/objects.ts";
import {
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	Kind,
	MAX_PAYLOAD,
	ProtocolError,
	parseHello,
	parseList,
	parseRead,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService } from "../src/folder-service/service.ts";
import { type TreeEntry, ViewTree } from "../src/folder-service/view-tree.ts";
import { CID, ENV, FakeCore, folder, grants, PASS, PROFILE, sha256, storeFile } from "./folder-service-fixtures.ts";

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});

async function tempdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "qorpera-folder-service-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A machine's side of one connection, as the bridge would hand it to the service. */
class Client {
	readonly #socket: Socket;
	readonly #reader = new FrameReader();
	readonly #frames: Frame[] = [];
	readonly #waiters: ((frame: Frame | undefined) => void)[] = [];
	closed = false;

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (data: Buffer) => {
			for (const frame of this.#reader.push(data)) this.#deliver(frame);
		});
		socket.on("close", () => {
			this.closed = true;
			for (const waiter of this.#waiters.splice(0)) waiter(undefined);
		});
	}

	static async open(path: string): Promise<Client> {
		const socket = connect(path);
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const client = new Client(socket);
		cleanup.push(() => {
			socket.destroy();
		});
		return client;
	}

	#deliver(frame: Frame): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter(frame);
		else this.#frames.push(frame);
	}

	send(kind: number, value: unknown): void {
		this.#socket.write(encodeJson(kind, value));
	}

	sendRaw(bytes: Buffer): void {
		this.#socket.write(bytes);
	}

	next(timeoutMs = 2_000): Promise<Frame | undefined> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		if (this.closed) return Promise.resolve(undefined);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("no frame")), timeoutMs);
			this.#waiters.push((f) => {
				clearTimeout(timer);
				resolve(f);
			});
		});
	}

	async json(timeoutMs?: number): Promise<{ kind: number; body: Record<string, unknown> }> {
		const frame = await this.next(timeoutMs);
		if (!frame) throw new Error("closed");
		return { kind: frame.kind, body: JSON.parse(frame.payload.toString("utf8")) };
	}

	async hello(role: "io" | "feed", pass = PASS, cid = CID): Promise<{ kind: number; body: Record<string, unknown> }> {
		this.send(Kind.bridge, { cid });
		this.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass, role });
		return this.json();
	}

	async list(path: string): Promise<string[]> {
		const names: string[] = [];
		let after: string | undefined;
		for (;;) {
			this.send(Kind.list, after === undefined ? { path } : { path, after });
			const { kind, body } = await this.json();
			if (kind !== Kind.listing) throw new Error(`list ${path}: ${JSON.stringify(body)}`);
			names.push(...(body.entries as { name: string }[]).map((e) => e.name));
			if (body.next === undefined || body.next === null) return names;
			after = body.next as string;
		}
	}

	async read(path: string, version: number, offset: number, length: number): Promise<Buffer | string> {
		this.send(Kind.read, { path, version, offset, length });
		const frame = await this.next();
		if (!frame) throw new Error("closed");
		if (frame.kind === Kind.data) return frame.payload;
		return (JSON.parse(frame.payload.toString("utf8")) as { code: string }).code;
	}
}

async function serve(core: FakeCore, root: string): Promise<{ service: FolderService; path: string }> {
	const lines: string[] = [];
	const service = new FolderService({
		core,
		objects: new NasObjects({ root, cacheBytes: 1024 * 1024 }),
		grants: grants(),
		log: (line) => lines.push(line),
	});
	const server: Server = createFolderServer(service, (line) => lines.push(line));
	const path = join(await tempdir(), "service.sock");
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	cleanup.push(() => service.stop());
	return { service, path };
}

describe("folder protocol", () => {
	it("splits a byte stream into frames however it arrives", () => {
		const reader = new FrameReader();
		const wire = Buffer.concat([encodeJson(Kind.list, { path: "a" }), encodeFrame(Kind.data, Buffer.from("xyz"))]);
		const frames: Frame[] = [];
		for (const byte of wire) frames.push(...reader.push(Buffer.from([byte])));
		expect(frames.map((f) => f.kind)).toEqual([Kind.list, Kind.data]);
		expect(frames[1]!.payload.toString()).toBe("xyz");
		const bad = Buffer.alloc(5);
		bad.writeUInt32BE(MAX_PAYLOAD + 2, 0);
		expect(() => new FrameReader().push(bad)).toThrow(ProtocolError);
	});

	it("checks every request field", () => {
		const json = (v: unknown) => Buffer.from(JSON.stringify(v));
		expect(parseHello(json({ protocol: 1, environmentId: ENV, viewId: "proof", pass: "p", role: "io" })).role).toBe(
			"io",
		);
		expect(() => parseHello(json({ protocol: 2, environmentId: ENV, viewId: "v", pass: "p", role: "io" }))).toThrow();
		expect(() =>
			parseHello(json({ protocol: 1, environmentId: ENV, viewId: "v", pass: "p", role: "io", x: 1 })),
		).toThrow();
		expect(() =>
			parseHello(json({ protocol: 1, environmentId: ENV, viewId: "v w", pass: "p", role: "io" })),
		).toThrow();
		expect(parseList(json({ path: "a/b", after: "c" }))).toEqual({ path: "a/b", after: "c" });
		for (const path of ["/a", "a/", "a//b", "a/../b", "."]) expect(() => parseList(json({ path }))).toThrow();
		expect(() => parseRead(json({ path: "a", version: 1, offset: 0, length: 2 * 1024 * 1024 }))).toThrow();
		expect(() => parseRead(json({ path: "", version: 1, offset: 0, length: 1 }))).toThrow();
	});
});

describe("folder core answers", () => {
	it("reads list and feed pages and refuses unknown shapes", () => {
		const page = parseListPage({
			schema: "qorpera.folder-list/v1",
			asOfSeq: 4,
			entries: [{ path: "a", kind: "folder", version: 1, seq: 3, authority: { resourceId: "x" } }],
			next: null,
		});
		expect(page.entries[0]).toEqual({ path: "a", kind: "folder", version: 1 });
		expect(() => parseListPage({ schema: "qorpera.folder-list/v2", asOfSeq: 1, entries: [], next: null })).toThrow();
		const feed = parseFeedPage({
			schema: "qorpera.folder-feed/v1",
			asOfSeq: 9,
			resync: false,
			events: [
				{ seq: 8, kind: "authority" },
				{
					seq: 9,
					kind: "change_set",
					commitId: "c",
					changes: [{ unitNo: 1, op: "delete", kind: "file", path: "a.md", version: 3 }],
				},
			],
			next: { afterSeq: 9, cursor: null },
			more: false,
		});
		expect(feed.events[1]).toEqual({
			seq: 9,
			kind: "change_set",
			changes: [{ path: "a.md", kind: "file", version: 3, op: "delete" }],
		});
		expect(() =>
			parseFeedPage({
				...feed,
				schema: "qorpera.folder-feed/v1",
				events: [{ seq: 1, kind: "change_set", changes: [{ op: "zap" }] }],
			}),
		).toThrow();
	});
});

describe("view tree", () => {
	const file = (path: string, version = 1, bytes = 3): CoreEntry => ({
		path,
		kind: "file",
		version,
		manifestSha256: "a".repeat(64),
		fileSha256: "b".repeat(64),
		bytes,
		mediaType: "text/plain",
		executable: false,
	});

	it("shows folders above readable paths and pages children in byte order", () => {
		const tree = new ViewTree();
		tree.put(file("docs/z.md"));
		tree.put(file("docs/æ.md"));
		tree.put(file("docs/a.md"));
		tree.put(file("docs/B.md"));
		expect(tree.get("docs")?.implicit).toBe(true);
		const first = tree.children("docs", undefined, 2);
		expect(first).toEqual({
			entries: [expect.objectContaining({ name: "B.md" }), expect.objectContaining({ name: "a.md" })],
			next: "a.md",
		});
		const second = tree.children("docs", "a.md", 2);
		expect(second !== "not_found" && second !== "not_a_folder" && second.entries.map((e) => e.name)).toEqual([
			"z.md",
			"æ.md",
		]);
		expect(tree.children("nope", undefined, 2)).toBe("not_found");
		expect(tree.children("docs/a.md", undefined, 2)).toBe("not_a_folder");
	});

	it("removes subtrees and empty implicit folders, and reports every changed path", () => {
		const tree = new ViewTree();
		tree.put(folder("a"));
		tree.put(file("a/b/c.md"));
		tree.put(file("a/b/d.md"));
		expect(tree.remove("a/b/c.md")).toEqual(["a/b/c.md"]);
		expect(tree.remove("a/b/d.md")).toEqual(["a/b/d.md", "a/b"]);
		expect(tree.get("a")).toBeDefined();
		tree.put(file("a/x/y.md"));
		expect(tree.remove("a").sort()).toEqual(["a", "a/x", "a/x/y.md"]);
		expect(tree.size).toBe(0);
	});

	it("applies feed operations and diffs two trees", () => {
		const before = new ViewTree();
		before.put(file("k.md", 1));
		before.put(file("gone.md", 1));
		const after = new ViewTree();
		after.put(file("k.md", 2));
		after.apply({ ...file("new/n.md"), op: "move_in" });
		after.apply({ ...folder("made"), op: "mkdir" });
		expect(ViewTree.diff(before, after).sort()).toEqual(["gone.md", "k.md", "made", "new", "new/n.md"]);
		expect(after.apply({ path: "new/n.md", kind: "file", version: 1, op: "move_out" })).toEqual(["new/n.md", "new"]);
	});
});

describe("objects on the storage server", () => {
	it("reads any range across chunks, checking every hash", async () => {
		const root = await tempdir();
		const entry = await storeFile(root, "f.txt", "hello, company folder", 1);
		const tree = new ViewTree();
		tree.put(entry);
		const objects = new NasObjects({ root, cacheBytes: 1024 });
		const e = tree.get("f.txt")!;
		expect((await objects.read(PROFILE, e, 0, 100)).toString()).toBe("hello, company folder");
		expect((await objects.read(PROFILE, e, 3, 7)).toString()).toBe("lo, com");
		expect((await objects.read(PROFILE, e, 21, 5)).byteLength).toBe(0);
		// A tampered chunk is never served.
		const fresh = await tempdir();
		const other = await storeFile(fresh, "g.txt", "abcdefgh", 1);
		const firstChunk = sha256("abcd");
		await writeFile(join(fresh, PROFILE, firstChunk), "abcX");
		const t2 = new ViewTree();
		t2.put(other);
		await expect(
			new NasObjects({ root: fresh, cacheBytes: 1024 }).read(PROFILE, t2.get("g.txt")!, 0, 8),
		).rejects.toThrow(ObjectIntegrityError);
	});

	it("refuses links and manifests that do not match their entry", async () => {
		const root = await tempdir();
		const entry = await storeFile(root, "f.txt", "abcdefgh", 1);
		const chunk = sha256("abcd");
		await rm(join(root, PROFILE, chunk));
		await writeFile(join(root, "elsewhere"), "abcd");
		await symlink(join(root, "elsewhere"), join(root, PROFILE, chunk));
		const tree = new ViewTree();
		tree.put(entry);
		await expect(new NasObjects({ root, cacheBytes: 1024 }).read(PROFILE, tree.get("f.txt")!, 0, 8)).rejects.toThrow(
			"Object is a link",
		);
		const wrong: TreeEntry = { ...tree.get("f.txt")!, executable: true };
		const manifest = JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: entry.fileSha256,
			bytes: 8,
			mediaType: "text/plain",
			executable: false,
			chunks: [
				{ sha256: chunk, bytes: 4 },
				{ sha256: sha256("efgh"), bytes: 4 },
			],
		});
		expect(() => parseManifest(Buffer.from(manifest), wrong)).toThrow("does not match");
		expect(() => parseManifest(Buffer.from(manifest), { ...wrong, executable: false, bytes: 9 })).toThrow();
	});
});

describe("folder service", () => {
	async function company(root: string): Promise<FakeCore> {
		const core = new FakeCore();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/plan.md", "the plan, version one", 1),
			await storeFile(root, "readme.md", "hi", 1),
			folder("private"),
			await storeFile(root, "private/salary.md", "secret", 1),
			await storeFile(root, "tools/run.sh", "#!/bin/sh\n", 1, 4, { executable: true }),
		]);
		return core;
	}

	it("refuses a wrong pass, another machine, or a frame before the bridge's", async () => {
		const root = await tempdir();
		const { path } = await serve(await company(root), root);
		const wrongPass = await Client.open(path);
		expect((await wrongPass.hello("io", "not-the-pass")).body.code).toBe("VIEW_REFUSED");
		expect(await wrongPass.next()).toBeUndefined();
		const otherMachine = await Client.open(path);
		expect((await otherMachine.hello("io", PASS, 43)).body.code).toBe("VIEW_REFUSED");
		const noBridge = await Client.open(path);
		noBridge.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" });
		expect((await noBridge.json()).body.code).toBe("BAD_REQUEST");
		// A machine cannot name a CID itself: a second bridge frame ends the connection.
		const forged = await Client.open(path);
		expect((await forged.hello("io")).kind).toBe(Kind.helloOk);
		forged.send(Kind.bridge, { cid: 7 });
		expect((await forged.json()).body.code).toBe("BAD_REQUEST");
		expect(await forged.next()).toBeUndefined();
	});

	it("lists the view's whole tree and reads bytes", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { path } = await serve(core, root);
		const io = await Client.open(path);
		const ok = await io.hello("io");
		expect(ok.body).toMatchObject({ protocol: 1, viewId: "proof", asOfSeq: 0, readOnly: true });
		expect(await io.list("")).toEqual(["docs", "private", "readme.md", "tools"]);
		expect(await io.list("docs")).toEqual(["plan.md"]);
		expect(await io.read("docs/plan.md", 1, 4, 4)).toEqual(Buffer.from("plan"));
		expect(await io.read("docs/plan.md", 2, 0, 4)).toBe("STALE");
		expect(await io.read("docs/nope.md", 1, 0, 4)).toBe("NOT_FOUND");
		expect(await io.read("docs", 1, 0, 4)).toBe("NOT_A_FILE");
		io.send(Kind.list, { path: "readme.md" });
		expect((await io.json()).body.code).toBe("NOT_A_FOLDER");
		// The profile is learnt once.
		await io.read("readme.md", 1, 0, 2);
		expect(core.profileCalls).toBe(1);
	});

	it("pushes a change to the feed within one poll, keeps the old version readable, and shows the new one", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const feed = await Client.open(path);
		expect((await feed.hello("feed")).kind).toBe(Kind.helloOk);
		const io = await Client.open(path);
		await io.hello("io");
		core.write(await storeFile(root, "docs/plan.md", "the plan, version two!", 2));
		await service.poll();
		await service.settled();
		const change = await feed.json();
		expect(change).toEqual({ kind: Kind.change, body: { seq: 1, resync: false, paths: ["docs/plan.md"] } });
		feed.send(Kind.ack, { seq: 1 });
		expect(await io.read("docs/plan.md", 2, 15, 7)).toEqual(Buffer.from("on two!"));
		expect(await io.read("docs/plan.md", 1, 4, 4)).toEqual(Buffer.from("plan"));
		core.remove("readme.md");
		await service.poll();
		await service.settled();
		expect((await feed.json()).body.paths).toEqual(["readme.md"]);
		expect(await io.list("")).toEqual(["docs", "private", "tools"]);
		service.heartbeat();
		expect((await feed.json()).body).toEqual({ seq: 2, resync: false, paths: [] });
	});

	it("lists again after an access change and hides what was taken away", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const feed = await Client.open(path);
		await feed.hello("feed");
		const io = await Client.open(path);
		await io.hello("io");
		expect(await io.list("private")).toEqual(["salary.md"]);
		const calls = core.listCalls;
		core.authority((p) => p === "private" || p.startsWith("private/"));
		await service.poll();
		await service.settled();
		expect(core.listCalls).toBeGreaterThan(calls);
		expect(((await feed.json()).body.paths as string[]).sort()).toEqual(["private", "private/salary.md"]);
		expect(await io.list("")).toEqual(["docs", "readme.md", "tools"]);
		expect(await io.read("private/salary.md", 1, 0, 6)).toBe("NOT_FOUND");
	});

	it("closes the view on every connection when its owner loses it", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const feed = await Client.open(path);
		await feed.hello("feed");
		const io = await Client.open(path);
		await io.hello("io");
		core.deny = true;
		core.write(await storeFile(root, "readme.md", "changed", 2));
		await service.poll();
		await service.settled();
		expect((await feed.json()).body.code).toBe("VIEW_CLOSED");
		expect(await feed.next()).toBeUndefined();
		io.send(Kind.list, { path: "" });
		expect((await io.json()).body.code).toBe("VIEW_CLOSED");
		const again = await Client.open(path);
		expect((await again.hello("io")).body.code).toBe("VIEW_CLOSED");
	});
});
