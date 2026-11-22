import { execFile, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open as openFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { type AddressInfo, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ObjectLockConflict, ObjectStatementTimeout } from "../src/dependency.ts";
import {
	CORE_PAGE,
	type CoreEntry,
	CoreRefusal,
	parseCommitAnswer,
	parseFeedPage,
	parseListPage,
	SupabaseFolderCore,
} from "../src/folder-service/core.ts";
import { createNodeTransport, nodeRequest, ResponseTooLargeError } from "../src/folder-service/https-request.ts";
import { MountGrants, parseOperatorMounts } from "../src/folder-service/mounts.ts";
import {
	CHUNK_BYTES,
	NasObjects,
	ObjectIntegrityError,
	ObjectUnavailableError,
	parseManifest,
} from "../src/folder-service/objects.ts";
import {
	type BridgeInfo,
	encodeFrame,
	encodeJson,
	type Frame,
	FrameReader,
	fitReport,
	Kind,
	MAX_PAYLOAD,
	ProtocolError,
	parseBridge,
	parseHello,
	parseList,
	parseRead,
	type Report,
} from "../src/folder-service/protocol.ts";
import { createFolderServer } from "../src/folder-service/server.ts";
import { FolderService, type FolderServiceOptions } from "../src/folder-service/service.ts";
import { GatewayUploads } from "../src/folder-service/staging.ts";
import { type TreeEntry, ViewTree } from "../src/folder-service/view-tree.ts";
import {
	BRIDGE,
	CID,
	CODING,
	codingGrants,
	ENV,
	EXEC_HOST,
	FakeCore,
	folder,
	grants,
	hashOf,
	MACHINE,
	noSecrets,
	PASS,
	PROFILE,
	storeFile,
	v,
} from "./folder-service-fixtures.ts";

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

	close(): void {
		this.#socket.destroy();
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

	async hello(
		role: "io" | "feed",
		pass = PASS,
		bridge: BridgeInfo = BRIDGE,
		viewId = "proof",
	): Promise<{ kind: number; body: Record<string, unknown> }> {
		this.send(Kind.bridge, bridge);
		this.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId, pass, role });
		return this.json();
	}

	async list(path: string): Promise<string[]> {
		return (await this.entries(path)).map((e) => e.name as string);
	}

	async entries(path: string): Promise<Record<string, unknown>[]> {
		const entries: Record<string, unknown>[] = [];
		let after: string | undefined;
		for (;;) {
			this.send(Kind.list, after === undefined ? { path } : { path, after });
			const { kind, body } = await this.json();
			if (kind !== Kind.listing) throw new Error(`list ${path}: ${JSON.stringify(body)}`);
			entries.push(...(body.entries as Record<string, unknown>[]));
			if (body.next === undefined || body.next === null) return entries;
			after = body.next as string;
		}
	}

	async read(path: string, version: number, offset: number, length: number): Promise<Buffer | string> {
		this.send(Kind.read, { path, version: v(version), offset, length });
		const frame = await this.next();
		if (!frame) throw new Error("closed");
		if (frame.kind === Kind.data) return frame.payload;
		return (JSON.parse(frame.payload.toString("utf8")) as { code: string }).code;
	}
}

async function serve(
	core: FakeCore,
	root: string,
	now?: () => number,
	options: Partial<FolderServiceOptions> = {},
): Promise<{ service: FolderService; path: string }> {
	const lines: string[] = [];
	const service = new FolderService({
		core,
		objects: new NasObjects({ root, cacheBytes: 1024 * 1024 }),
		grants: grants(),
		log: (line) => lines.push(line),
		...(now ? { now } : {}),
		...options,
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
		expect(parseHello(json({ protocol: 2, environmentId: ENV, viewId: "v", pass: "p", role: "io" })).protocol).toBe(
			2,
		);
		expect(parseHello(json({ protocol: 3, environmentId: ENV, viewId: "v", pass: "p", role: "io" })).protocol).toBe(
			3,
		);
		expect(parseHello(json({ protocol: 4, environmentId: ENV, viewId: "v", pass: "p", role: "io" })).protocol).toBe(
			4,
		);
		expect(parseHello(json({ protocol: 5, environmentId: ENV, viewId: "v", pass: "p", role: "io" })).protocol).toBe(
			5,
		);
		for (const protocol of [0, 6, "4", 3.5])
			expect(() => parseHello(json({ protocol, environmentId: ENV, viewId: "v", pass: "p", role: "io" }))).toThrow();
		expect(() =>
			parseHello(json({ protocol: 1, environmentId: ENV, viewId: "v", pass: "p", role: "io", x: 1 })),
		).toThrow();
		expect(() =>
			parseHello(json({ protocol: 1, environmentId: ENV, viewId: "v w", pass: "p", role: "io" })),
		).toThrow();
		expect(parseList(json({ path: "a/b", after: "c" }))).toEqual({ path: "a/b", after: "c" });
		for (const path of ["/a", "a/", "a//b", "a/../b", "."]) expect(() => parseList(json({ path }))).toThrow();
		expect(() => parseRead(json({ path: "a", version: v(1), offset: 0, length: 2 * 1024 * 1024 }))).toThrow();
		expect(() => parseRead(json({ path: "", version: v(1), offset: 0, length: 1 }))).toThrow();
		expect(() => parseRead(json({ path: "a", version: 1, offset: 0, length: 1 }))).toThrow("Bad version");
		expect(parseBridge(json(BRIDGE))).toEqual(BRIDGE);
		expect(parseBridge(json({ cid: 9, lookup: "none" }))).toEqual({ cid: 9, lookup: "none" });
		expect(() => parseBridge(json({ cid: 9, lookup: "none", machine: BRIDGE.machine }))).toThrow();
		expect(() => parseBridge(json({ cid: 9, lookup: "found" }))).toThrow();
		expect(() => parseBridge(json({ cid: 2, lookup: "none" }))).toThrow("Bad CID");
	});
});

describe("folder core answers", () => {
	// The shapes as the live functions emit them (qorpera_folder_entry_json, 20260928120000:391-397; the feed,
	// 20260928237000:83-155): versions and cursor versions are uuids, and a resync answer's next is null. The
	// hosted-db script test-folder-service-core-shapes.mjs parses what the real functions return.
	it("reads list and feed pages as the core emits them, and refuses other shapes", () => {
		const entry = { path: "a", kind: "folder", version: v(1), seq: 3, authority: null };
		const page = parseListPage({ schema: "qorpera.folder-list/v1", asOfSeq: 4, entries: [entry], next: null });
		expect(page.entries[0]).toEqual({ path: "a", kind: "folder", version: v(1) });
		// An agent's listing names each entry's receipt; a rules path has no grant.
		const receipt = { resourceId: v(40), resourceRevision: 3, grantId: v(41), grantRevision: 2 };
		const rules = { resourceId: v(42), resourceRevision: 1, grantId: null, grantRevision: null };
		const withReceipts = parseListPage({
			schema: "qorpera.folder-list/v1",
			asOfSeq: 4,
			entries: [
				{ ...entry, authority: receipt },
				{ ...entry, path: "QorperaOS/rules", authority: rules },
			],
			next: null,
		});
		expect(withReceipts.entries.map((e) => e.authority)).toEqual([receipt, rules]);
		for (const bad of [
			{ resourceId: "x" },
			{ ...receipt, grantId: null },
			{ ...rules, grantRevision: 1 },
			{ ...receipt, resourceRevision: -1 },
			{ ...receipt, extra: 1 },
		])
			expect(() =>
				parseListPage({
					schema: "qorpera.folder-list/v1",
					asOfSeq: 4,
					entries: [{ ...entry, authority: bad }],
					next: null,
				}),
			).toThrow("receipt");
		// Every entry is checked in full, not only the first.
		const fileWithoutContent = { path: "b.md", kind: "file", version: v(2) };
		expect(() =>
			parseListPage({
				schema: "qorpera.folder-list/v1",
				asOfSeq: 1,
				entries: [entry, fileWithoutContent],
				next: null,
			}),
		).toThrow("file entry");
		expect(() =>
			parseListPage({
				schema: "qorpera.folder-list/v1",
				asOfSeq: 1,
				entries: [{ ...entry, version: 1 }],
				next: null,
			}),
		).toThrow("version");
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
					commitId: v(77),
					changes: [
						{ unitNo: 1, op: "delete", kind: "file", path: "a.md", version: v(3), priorVersion: v(2) },
						{ unitNo: 2, op: "move_in", kind: "folder", path: "b", version: v(5), priorVersion: v(4) },
					],
				},
			],
			next: { afterSeq: 8, cursor: { unitNo: 1, version: v(3) } },
			more: true,
		});
		expect(feed.events[1]).toEqual({
			seq: 9,
			kind: "change_set",
			// A move's arrival keeps the version the path had where it came from; anything else drops it.
			changes: [
				{ path: "a.md", kind: "file", version: v(3), op: "delete" },
				{ path: "b", kind: "folder", version: v(5), op: "move_in", priorVersion: v(4) },
			],
		});
		expect(feed.next).toEqual({ afterSeq: 8, cursor: { unitNo: 1, version: v(3) } });
		const resync = parseFeedPage({
			schema: "qorpera.folder-feed/v1",
			asOfSeq: 9,
			resync: true,
			events: [],
			next: null,
			more: false,
		});
		expect(resync).toMatchObject({ resync: true, next: null });
		expect(() =>
			parseFeedPage({
				schema: "qorpera.folder-feed/v1",
				asOfSeq: 9,
				resync: false,
				events: [{ seq: 1, kind: "change_set", changes: [{ op: "zap" }] }],
				next: { afterSeq: 9, cursor: null },
				more: false,
			}),
		).toThrow();
	});

	it("keeps the first problem a rule names with a unit's refusal, and only a problem with a code and a message", () => {
		const unit = (n: number, problems?: unknown) => ({
			unit: n,
			outcome: "refused",
			reason: "structured_rule",
			...(problems === undefined ? {} : { problems }),
		});
		const answer = parseCommitAnswer(
			{
				schema: "qorpera.folder-commit/v1",
				commitId: "6a1f3c2e-8b4d-4e5f-9a6b-7c8d9e0f1a2b",
				seq: null,
				units: [
					unit(1, [
						{
							line: null,
							key: null,
							code: "layout_authoring",
							message: "page and table layout authoring is not available",
						},
						{ line: 2, key: "name", code: "other", message: "Another." },
					]),
					unit(2, [{ line: 1, key: "x", code: null, message: "No code." }]),
					unit(3, "not a list"),
					unit(4),
				],
			},
			4,
		);
		expect(answer.units.map((u) => u.problem)).toEqual([
			{ code: "layout_authoring", message: "page and table layout authoring is not available" },
			undefined,
			undefined,
			undefined,
		]);
		expect(answer.units.every((u) => u.reason === "structured_rule")).toBe(true);
	});
});

describe("view tree", () => {
	const file = (path: string, version = 1, bytes = 3): CoreEntry => ({
		path,
		kind: "file",
		version: v(version),
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

	it("never lists a name Linux cannot show, so paging never continues after one", () => {
		const tree = new ViewTree();
		tree.put(file(`docs/${"x".repeat(256)}`));
		tree.put(file("docs/a.md"));
		expect(tree.children("docs", undefined, 1)).toEqual({
			entries: [expect.objectContaining({ name: "a.md" })],
			next: null,
		});
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
		expect(after.apply({ path: "new/n.md", kind: "file", version: v(1), op: "move_out" })).toEqual([
			"new/n.md",
			"new",
		]);
	});

	it("keeps each entry's receipt, gives a path the feed brought its earlier or its folder's, and counts a new one", () => {
		const docs = { resourceId: v(50), resourceRevision: 1, grantId: v(51), grantRevision: 1 };
		const tree = new ViewTree();
		tree.put({ ...folder("docs"), authority: docs });
		tree.put({ ...file("docs/a.md"), authority: docs });
		// The feed names no receipt: a new version keeps the path's, a new path takes its folder's.
		tree.apply({ ...file("docs/a.md", 2), op: "write" });
		tree.apply({ ...file("docs/b.md"), op: "write" });
		const page = tree.children("docs", undefined, 10);
		expect(page !== "not_found" && page !== "not_a_folder" && page.entries.map((e) => e.authority)).toEqual([
			docs,
			docs,
		]);
		// A path under a folder the feed just made takes the nearest receipt above it; a new top-level path has none.
		tree.apply({ ...file("docs/new/deep.md"), op: "write" });
		tree.apply({ ...file("top.md"), op: "write" });
		const deep = tree.children("docs/new", undefined, 10);
		expect(deep !== "not_found" && deep !== "not_a_folder" && deep.entries[0]?.authority).toEqual(docs);
		const top = tree.children("", undefined, 10);
		expect(
			top !== "not_found" && top !== "not_a_folder" && top.entries.find((e) => e.name === "top.md")?.authority,
		).toBe(undefined);
		// A listing after an access change brings a newer receipt: the path changed for the machines.
		const relisted = new ViewTree();
		relisted.put({ ...folder("docs"), authority: docs });
		relisted.put({ ...file("docs/a.md", 2), authority: { ...docs, grantRevision: 2 } });
		relisted.put({ ...file("docs/b.md"), authority: docs });
		relisted.put({ ...file("docs/new/deep.md"), authority: docs });
		relisted.put(file("top.md"));
		expect(ViewTree.diff(tree, relisted)).toEqual(["docs/a.md"]);
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
		const firstChunk = hashOf("abcd");
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
		const chunk = hashOf("abcd");
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
				{ sha256: hashOf("efgh"), bytes: 4 },
			],
		});
		expect(() => parseManifest(Buffer.from(manifest), wrong)).toThrow("does not match");
		expect(() => parseManifest(Buffer.from(manifest), { ...wrong, executable: false, bytes: 9 })).toThrow();
	});

	it("caches parsed manifests while re-validating entry metadata and zero-copy single-chunk slices", async () => {
		const root = await tempdir();
		const entry = await storeFile(root, "f.txt", "abcdefgh", 1);
		const tree = new ViewTree();
		tree.put(entry);
		const e = tree.get("f.txt")!;
		const objects = new NasObjects({ root, cacheBytes: 4096 });
		expect((await objects.read(PROFILE, e, 0, 4)).toString()).toBe("abcd");
		expect((await objects.read(PROFILE, e, 2, 4)).toString()).toBe("cdef");
		await expect(objects.read(PROFILE, { ...e, executable: true }, 0, 4)).rejects.toThrow("does not match");
		await expect(objects.read(PROFILE, { ...e, mediaType: "application/json" }, 0, 4)).rejects.toThrow(
			"does not match",
		);
		await expect(objects.read(PROFILE, { ...e, bytes: 9 }, 0, 4)).rejects.toThrow("does not match");
		const chunks = [
			{ sha256: hashOf("abcd"), bytes: 4 },
			{ sha256: hashOf("efgh"), bytes: 4 },
		];
		expect((await objects.readChunks(PROFILE, chunks, 1, 2)).toString()).toBe("bc");
		expect((await objects.readChunks(PROFILE, chunks, 2, 4)).toString()).toBe("cdef");
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
		const other = { cid: 43, lookup: "found", machine: { ...MACHINE, name: "qorpera-machine-other" } } as const;
		expect((await otherMachine.hello("io", PASS, other)).body.code).toBe("VIEW_REFUSED");
		const rebuilt = await Client.open(path);
		const replaced = { cid: CID, lookup: "found", machine: { ...MACHINE, physicalId: v(9) } } as const;
		expect((await rebuilt.hello("io", PASS, replaced)).body.code).toBe("VIEW_REFUSED");
		const stale = await Client.open(path);
		expect((await stale.hello("io", PASS, { cid: CID, lookup: "none" })).body.code).toBe("VIEW_REFUSED");
		// LXD could not be asked: "try again", never a refusal the machine would take as its view's end.
		const noLxd = await Client.open(path);
		expect((await noLxd.hello("io", PASS, { cid: CID, lookup: "unavailable" })).body.code).toBe("UNAVAILABLE");
		// Before the hello, a frame larger than a hello is refused, so no machine can make the service hold it.
		const big = await Client.open(path);
		const head = Buffer.alloc(5);
		head.writeUInt32BE(1024 * 1024, 0);
		head[4] = Kind.bridge;
		big.sendRaw(head);
		expect((await big.json()).body.code).toBe("BAD_REQUEST");
		expect(await big.next()).toBeUndefined();
		const noBridge = await Client.open(path);
		noBridge.send(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" });
		expect((await noBridge.json()).body.code).toBe("BAD_REQUEST");
		// A machine cannot name a CID itself: a second bridge frame ends the connection.
		const forged = await Client.open(path);
		expect((await forged.hello("io")).kind).toBe(Kind.helloOk);
		forged.send(Kind.bridge, { cid: 7, lookup: "none" });
		expect((await forged.json()).body.code).toBe("BAD_REQUEST");
		expect(await forged.next()).toBeUndefined();
	});

	it("answers the notices role with the view's notices, and ends it at any other frame (F3 4f-2b-2)", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { path } = await serve(core, root);
		const notices = async (hello: Record<string, unknown> = {}, pass = PASS) => {
			const client = await Client.open(path);
			client.send(Kind.bridge, BRIDGE);
			client.send(Kind.hello, { protocol: 4, environmentId: ENV, viewId: "proof", pass, role: "notices", ...hello });
			return { client, answer: await client.json() };
		};
		const { client, answer } = await notices();
		expect(answer).toEqual({ kind: Kind.helloOk, body: { protocol: 4, viewId: "proof" } });
		// No machine holds the view: none to give, and nothing listed for the asking.
		client.send(Kind.notices, { after: 0, nonce: null });
		expect(await client.json()).toEqual({
			kind: Kind.noticed,
			body: { nonce: null, notices: [], last: 0, more: false },
		});
		expect(core.listCalls).toBe(0);
		const io = await Client.open(path);
		expect((await io.hello("io")).kind).toBe(Kind.helloOk);
		client.send(Kind.notices, { after: 0, nonce: null });
		const { kind, body } = await client.json();
		expect(kind).toBe(Kind.noticed);
		expect(body).toMatchObject({ notices: [], last: 0, more: false });
		expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/);
		// It only asks for notices: anything else, or a bad ask, ends it.
		client.send(Kind.list, { path: "" });
		expect((await client.json()).body.code).toBe("BAD_REQUEST");
		expect(await client.next()).toBeUndefined();
		const badAsk = (await notices()).client;
		badAsk.send(Kind.notices, { after: 0, nonce: "not-a-series" });
		expect((await badAsk.json()).body.code).toBe("BAD_REQUEST");
		expect(await badAsk.next()).toBeUndefined();
		// Protocol 4 only, joining no mount; and a wrong pass is refused at the hello.
		for (const hello of [{ protocol: 3 }, { previous: { viewId: "old", pass: PASS } }, { abandon: true }]) {
			const bad = await notices(hello);
			expect(bad.answer.body.code).toBe("BAD_REQUEST");
			expect(await bad.client.next()).toBeUndefined();
		}
		const wrong = await notices({}, "not-the-pass");
		expect(wrong.answer.body.code).toBe("VIEW_REFUSED");
		expect(await wrong.client.next()).toBeUndefined();
		// The machine that holds the view is served as before.
		expect(await io.list("docs")).toEqual(["plan.md"]);
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

	it("waits for a machine to read its answers before reading its next request", async () => {
		const root = await tempdir();
		const core = await company(root);
		core.write(await storeFile(root, "big.bin", "y".repeat(1024 * 1024), 2, 1024 * 1024));
		let reads = 0;
		const objects = new NasObjects({ root, cacheBytes: 8 * 1024 * 1024 });
		const counted = Object.assign(Object.create(objects) as NasObjects, {
			read: (...args: Parameters<NasObjects["read"]>) => {
				reads++;
				return objects.read(...args);
			},
		});
		const service = new FolderService({ core, objects: counted, grants: grants(), log: () => {} });
		const server = createFolderServer(service, () => {});
		const path = join(await tempdir(), "service.sock");
		await new Promise<void>((resolve) => server.listen(path, resolve));
		cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const socket = connect(path);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		cleanup.push(() => {
			socket.destroy();
		});
		socket.write(encodeJson(Kind.bridge, BRIDGE));
		socket.write(
			encodeJson(Kind.hello, { protocol: 1, environmentId: ENV, viewId: "proof", pass: PASS, role: "io" }),
		);
		// 32 reads of 256 KiB sent at once, and nothing read back.
		socket.pause();
		for (let i = 0; i < 32; i++)
			socket.write(encodeJson(Kind.read, { path: "big.bin", version: v(2), offset: 0, length: 256 * 1024 }));
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(reads).toBeLessThan(16);
		// Reading on gets every answer.
		const reader = new FrameReader();
		let answers = 0;
		socket.on("data", (data: Buffer) => {
			for (const frame of reader.push(data)) if (frame.kind === Kind.data) answers++;
		});
		socket.resume();
		const deadline = Date.now() + 25_000;
		while (answers < 32 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(answers).toBe(32);
	});

	it("tells machines to drop everything when the changed paths do not fit one frame", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const feed = await Client.open(path);
		await feed.hello("feed");
		const segment = "s".repeat(250);
		const deep = Array.from({ length: 15 }, () => segment).join("/");
		for (let i = 0; i < 600; i++) core.write(folder(`${deep}/${i}`, i + 2));
		await service.poll();
		await service.settled();
		expect((await feed.json()).body).toEqual({ seq: core.seq, resync: true, paths: [] });
	});

	it("tells machines the changes of the pages it applied when a later feed page fails", async () => {
		const root = await tempdir();
		const core = await company(root);
		core.feedPage = 1;
		const { service, path } = await serve(core, root);
		const feed = await Client.open(path);
		await feed.hello("feed");
		core.write(await storeFile(root, "docs/plan.md", "the plan, version two", 2));
		core.write(await storeFile(root, "readme.md", "hi again", 2));
		// The first page (docs/plan.md) applies, the second fails: what the tree took in is still told.
		core.feedCalls = 0;
		core.failFeedAt = 2;
		await service.poll();
		await service.settled();
		core.failFeedAt = undefined;
		await service.poll();
		await service.settled();
		expect((await feed.json()).body).toEqual({ seq: 1, resync: false, paths: ["docs/plan.md"] });
		expect((await feed.json()).body).toEqual({ seq: 2, resync: false, paths: ["readme.md"] });
	});

	it("keeps the files of a folder moved or deleted parent first readable for files opened before", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const io = await Client.open(path);
		await io.hello("io");
		expect(await io.read("docs/plan.md", 1, 4, 4)).toEqual(Buffer.from("plan"));
		// The feed orders a change set's changes by version: here the folder's own move comes before its file's.
		const plan = core.entries.get("docs/plan.md")!;
		core.commitChanges([
			{ ...folder("docs"), op: "move_out" },
			{ ...plan, op: "move_out" },
			{ ...folder("archive", 3), op: "move_in" },
			{ ...plan, path: "archive/plan.md", version: v(3), op: "move_in" },
		]);
		await service.poll();
		await service.settled();
		expect(await io.list("")).toEqual(["archive", "private", "readme.md", "tools"]);
		expect(await io.read("docs/plan.md", 1, 4, 4)).toEqual(Buffer.from("plan"));
		// A folder deleted before its files: the files opened before still read.
		expect(await io.read("private/salary.md", 1, 0, 6)).toEqual(Buffer.from("secret"));
		const salary = core.entries.get("private/salary.md")!;
		core.commitChanges([
			{ ...core.entries.get("private")!, op: "delete" },
			{ ...salary, op: "delete" },
		]);
		await service.poll();
		await service.settled();
		expect(await io.list("")).toEqual(["archive", "readme.md", "tools"]);
		expect(await io.read("private/salary.md", 1, 0, 6)).toEqual(Buffer.from("secret"));
	});

	it("keeps replaced versions readable for files opened before, until access changes", async () => {
		const root = await tempdir();
		const core = await company(root);
		const { service, path } = await serve(core, root);
		const io = await Client.open(path);
		await io.hello("io");
		for (let version = 2; version <= 18; version++) {
			core.write(await storeFile(root, "readme.md", `hi ${version}`, version));
			await service.poll();
			await service.settled();
		}
		expect(await io.read("readme.md", 18, 0, 5)).toEqual(Buffer.from("hi 18"));
		expect(await io.read("readme.md", 2, 0, 4)).toEqual(Buffer.from("hi 2"));
		// Sixteen replaced versions are kept per path; the oldest beyond them reads as stale.
		expect(await io.read("readme.md", 1, 0, 2)).toBe("STALE");
		core.authority(() => false);
		await service.poll();
		await service.settled();
		expect(await io.read("readme.md", 2, 0, 4)).toBe("STALE");
		expect(await io.read("readme.md", 18, 0, 5)).toEqual(Buffer.from("hi 18"));
	});
});

describe("run box views", () => {
	const VIEW = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
	const BOX_PASS = "boxpass_0123456789-abcdefghijklmnopqrstuvwx";
	const EXEC: BridgeInfo = { cid: 77, lookup: "found", machine: EXEC_HOST };

	async function box(
		clock?: { now: number },
		options: Partial<FolderServiceOptions> = {},
	): Promise<{ core: FakeCore; service: FolderService; path: string; root: string }> {
		const root = await tempdir();
		const core = new FakeCore();
		if (clock) core.now = () => clock.now;
		core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
		core.openView(VIEW, BOX_PASS);
		return { core, root, ...(await serve(core, root, clock ? () => clock.now : undefined, options)) };
	}

	it("opens a core view for the execution host only, with its own pass, and renews its lease while connected", async () => {
		const { core, service, path } = await box();
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		expect(await io.list("docs")).toEqual(["plan.md"]);
		expect(await io.read("docs/plan.md", 1, 4, 4)).toEqual(Buffer.from("plan"));
		// Another machine (here, the operator mount's) may not present a run box view.
		const other = await Client.open(path);
		expect((await other.hello("io", BOX_PASS, BRIDGE, VIEW)).body.code).toBe("VIEW_REFUSED");
		const noLxd = await Client.open(path);
		expect((await noLxd.hello("io", BOX_PASS, { cid: 77, lookup: "unavailable" }, VIEW)).body.code).toBe(
			"UNAVAILABLE",
		);
		// Joining the open view takes its pass; a pass of the wrong shape never reaches the core.
		const wrong = await Client.open(path);
		expect((await wrong.hello("io", `${"z".repeat(42)}y`, EXEC, VIEW)).body.code).toBe("VIEW_REFUSED");
		const malformed = await Client.open(path);
		expect((await malformed.hello("io", "short", EXEC, VIEW)).body.code).toBe("VIEW_REFUSED");
		// Renewed at once on the first listing, then on each round while a machine is connected.
		expect(core.views.get(VIEW)!.renewals).toBe(1);
		await service.renewLeases();
		expect(core.views.get(VIEW)!.renewals).toBe(2);
		// No machine connected: the lease is left to run out.
		io.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await service.renewLeases();
		expect(core.views.get(VIEW)!.renewals).toBe(2);
	});

	it("closes the view on every connection when the core ends it, and keeps it through a renewal that failed", async () => {
		const { core, service, path } = await box();
		const feed = await Client.open(path);
		expect((await feed.hello("feed", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		const io = await Client.open(path);
		await io.hello("io", BOX_PASS, EXEC, VIEW);
		core.renewalFails = true;
		await service.renewLeases();
		expect(await io.list("")).toEqual(["docs"]);
		core.renewalFails = false;
		core.views.get(VIEW)!.state = "closed";
		await service.renewLeases();
		expect((await feed.json()).body).toMatchObject({ code: "VIEW_CLOSED", message: "The view was ended" });
		expect(await feed.next()).toBeUndefined();
		io.send(Kind.list, { path: "" });
		expect((await io.json()).body.code).toBe("VIEW_CLOSED");
	});

	it("refuses a first hello whose pass the core does not know, and still lets the right pass in", async () => {
		const { path } = await box();
		const wrong = await Client.open(path);
		expect((await wrong.hello("io", `${"q".repeat(42)}w`, EXEC, VIEW)).body.code).toBe("VIEW_CLOSED");
		const right = await Client.open(path);
		expect((await right.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		// Another company folder never joins the view.
		const elsewhere = await Client.open(path);
		elsewhere.send(Kind.bridge, EXEC);
		elsewhere.send(Kind.hello, {
			protocol: 1,
			environmentId: "22222222-2222-4333-8444-555555555555",
			viewId: VIEW,
			pass: BOX_PASS,
			role: "io",
		});
		expect((await elsewhere.json()).body.code).toBe("VIEW_REFUSED");
	});

	it("never lets a hello the core has not checked yet lock out the right one, whatever it named", async () => {
		const { core, path } = await box();
		let open = (): void => {};
		core.listGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const elsewhere = await Client.open(path);
		elsewhere.send(Kind.bridge, EXEC);
		elsewhere.send(Kind.hello, {
			protocol: 1,
			environmentId: "22222222-2222-4333-8444-555555555555",
			viewId: VIEW,
			pass: BOX_PASS,
			role: "io",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		// While the other company folder's hello is being checked, the right one is asked to try again.
		const right = await Client.open(path);
		expect((await right.hello("io", BOX_PASS, EXEC, VIEW)).body.code).toBe("UNAVAILABLE");
		open();
		core.listGate = undefined;
		expect((await elsewhere.json()).body.code).toBe("VIEW_CLOSED");
		const again = await Client.open(path);
		expect((await again.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
	});

	it("drops a core view no machine holds, and lists and renews it again when one comes back", async () => {
		const { core, path } = await box();
		const first = await Client.open(path);
		await first.hello("io", BOX_PASS, EXEC, VIEW);
		const lists = core.listCalls;
		first.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		const back = await Client.open(path);
		expect((await back.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		expect(core.listCalls).toBeGreaterThan(lists);
		expect(core.views.get(VIEW)!.renewals).toBe(2);
	});

	it("serves nothing past the lease the core confirmed, and serves again once a renewal succeeds", async () => {
		const clock = { now: Date.now() };
		const { core, service, path } = await box(clock);
		const io = await Client.open(path);
		await io.hello("io", BOX_PASS, EXEC, VIEW);
		expect(await io.list("")).toEqual(["docs"]);
		core.renewalFails = true;
		clock.now += 60_000;
		await service.renewLeases();
		expect(await io.list("")).toEqual(["docs"]);
		clock.now += 61_000;
		io.send(Kind.list, { path: "" });
		expect((await io.json()).body.code).toBe("UNAVAILABLE");
		expect(await io.read("docs/plan.md", 1, 0, 4)).toBe("UNAVAILABLE");
		core.renewalFails = false;
		await service.renewLeases();
		expect(await io.list("")).toEqual(["docs"]);
	});

	it("closes the view when a renewal is refused", async () => {
		const { core, service, path } = await box();
		const feed = await Client.open(path);
		await feed.hello("feed", BOX_PASS, EXEC, VIEW);
		core.views.get(VIEW)!.pass = "x".repeat(43);
		await service.renewLeases();
		expect((await feed.json()).body).toMatchObject({ code: "VIEW_CLOSED", message: "The view was refused" });
	});

	it("lists each entry with the receipt the core gave the view, and a path the feed brought with its folder's", async () => {
		const { core, service, path } = await box();
		const receipt = (n: number) => ({ resourceId: v(60), resourceRevision: n, grantId: v(61), grantRevision: 1 });
		core.receipts = () => receipt(1);
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		expect((await io.entries("")).map((e) => e.authority)).toEqual([receipt(1)]);
		expect(await io.entries("docs")).toEqual([expect.objectContaining({ name: "plan.md", authority: receipt(1) })]);
		core.write(await storeFile(join(await tempdir(), "share"), "docs/new.md", "new", 1));
		await service.poll();
		expect((await io.entries("docs")).map((e) => [e.name, e.authority])).toEqual([
			["new.md", receipt(1)],
			["plan.md", receipt(1)],
		]);
		// An operator mount reads as a member: its listing has no receipts.
		const operator = await Client.open(path);
		expect((await operator.hello("io")).kind).toBe(Kind.helloOk);
		expect((await operator.entries("docs")).every((e) => !("authority" in e))).toBe(true);
	});

	it("searches the run's view on the node: hits, the reads with their receipts, and where to go on", async () => {
		const { core, path } = await box();
		const receipt = { resourceId: v(60), resourceRevision: 4, grantId: null, grantRevision: null };
		core.receipts = () => receipt;
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		const search = { query: "PLAN", path: "", glob: null, namesOnly: false, caseSensitive: false, after: null };
		io.send(Kind.search, search);
		const found = await io.json();
		expect(found.kind).toBe(Kind.found);
		expect(found.body).toEqual({
			hits: [{ path: "docs/plan.md", kind: "file", line: 1, text: "the plan", version: v(1), offset: 0 }],
			searched: 1,
			binary: 0,
			unreadable: 0,
			reads: [
				{ path: "docs", kind: "folder", version: v(1), authority: receipt },
				{ path: "docs/plan.md", kind: "file", version: v(1), authority: receipt },
			],
			next: null,
		});
		// A path not in the view, and a bad request, are answered and the connection goes on.
		io.send(Kind.search, { ...search, path: "nowhere" });
		expect((await io.json()).body.code).toBe("NOT_FOUND");
		io.send(Kind.search, { ...search, query: "" });
		expect((await io.json()).body.code).toBe("BAD_REQUEST");
		io.send(Kind.search, { ...search, namesOnly: true, query: "plan." });
		const names = (await io.json()).body;
		expect(names).toMatchObject({ hits: [{ path: "docs/plan.md", kind: "file", line: 0, text: "" }], next: null });
		// The name shown is a read of its entry.
		expect((names.reads as { path: string }[]).map((r) => r.path)).toEqual(["docs", "docs/plan.md"]);
		// An operator mount's machine never searches through this service: search is for a run's own view.
		const operator = await Client.open(path);
		expect((await operator.hello("io")).kind).toBe(Kind.helloOk);
		operator.send(Kind.search, search);
		expect((await operator.json()).body.code).toBe("BAD_REQUEST");
	});

	it("says in its hello it speaks search version 2, and answers one with context, a pattern, files and a find", async () => {
		const { path } = await box();
		const io = await Client.open(path);
		const hello = await io.hello("io", BOX_PASS, EXEC, VIEW);
		expect(hello.kind).toBe(Kind.helloOk);
		expect(hello.body.search).toEqual({ version: 2, regex: true });
		const ask = {
			version: 2,
			query: "PL.N",
			regex: true,
			path: "",
			glob: null,
			namesOnly: false,
			filesOnly: false,
			caseSensitive: false,
			context: 1,
			after: null,
		};
		io.send(Kind.search, ask);
		expect((await io.json()).body).toEqual({
			hits: [
				{
					path: "docs/plan.md",
					kind: "file",
					line: 1,
					text: "the plan",
					version: v(1),
					offset: 0,
					before: [],
					after: [],
					from: 0,
				},
			],
			files: [],
			searched: 1,
			binary: 0,
			unreadable: 0,
			longLines: 0,
			reads: [
				{ path: "docs", kind: "folder", version: v(1) },
				{ path: "docs/plan.md", kind: "file", version: v(1) },
			],
			next: null,
		});
		io.send(Kind.search, { ...ask, context: 0, filesOnly: true });
		expect((await io.json()).body).toMatchObject({
			hits: [],
			files: [{ path: "docs/plan.md", version: v(1), count: 1 }],
		});
		// A pattern this search does not run is answered with why, and the connection goes on.
		io.send(Kind.search, { ...ask, query: "(a)\\1" });
		expect((await io.json()).body).toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringMatching(/^REGEX_BACKREFERENCE: /),
		});
		io.send(Kind.search, { ...ask, query: null, regex: false, context: 0, namesOnly: true, glob: "*.md" });
		expect((await io.json()).body).toMatchObject({ hits: [{ path: "docs/plan.md", line: 0 }], next: null });
		// A version 1 search is answered as before, without the new parts.
		io.send(Kind.search, {
			query: "plan",
			path: "",
			glob: null,
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect(Object.keys((await io.json()).body).sort()).toEqual([
			"binary",
			"hits",
			"next",
			"reads",
			"searched",
			"unreadable",
		]);
		// An operator mount's hello says nothing of search.
		const operator = await Client.open(path);
		expect((await operator.hello("io")).body.search).toBeUndefined();
	});

	it("runs a few search pages at once on the node and the rest in turn, and keeps run views within the paths they may hold", async () => {
		const root = await tempdir();
		const core = new FakeCore();
		core.seed([folder("docs"), await storeFile(root, "docs/plan.md", "the plan", 1)]);
		core.openView(VIEW, BOX_PASS);
		const objects = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const read = objects.read.bind(objects);
		let open!: () => void;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		let reads = 0;
		objects.read = async (...args) => {
			reads++;
			await gate;
			return read(...args);
		};
		const { path } = await serve(core, root, undefined, { objects, searchRunning: 1 });
		const search = { query: "plan", path: "", glob: null, namesOnly: false, caseSensitive: false, after: null };
		const first = await Client.open(path);
		await first.hello("io", BOX_PASS, EXEC, VIEW);
		const second = await Client.open(path);
		await second.hello("io", BOX_PASS, EXEC, VIEW);
		first.send(Kind.search, search);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const asked = reads;
		expect(asked).toBeGreaterThan(0);
		second.send(Kind.search, search);
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The second page waits its turn: it has read nothing.
		expect(reads).toBe(asked);
		open();
		expect((await first.json()).body).toMatchObject({ hits: [{ path: "docs/plan.md" }] });
		expect((await second.json()).body).toMatchObject({ hits: [{ path: "docs/plan.md" }] });
		expect(reads).toBeGreaterThan(asked);
		// A run view whose tree would take the node's run views past their paths is refused, with why.
		const small = await box(undefined, { searchPaths: 1 });
		const refused = await Client.open(small.path);
		expect((await refused.hello("io", BOX_PASS, EXEC, VIEW)).body).toMatchObject({
			code: "UNAVAILABLE",
			message: expect.stringMatching(/^SEARCH_FULL: /),
		});
		const room = await box(undefined, { searchPaths: 2 });
		const served = await Client.open(room.path);
		expect((await served.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
	});

	it("closes a run view whose feed grows it past the paths the node's run views may hold, at the page that does", async () => {
		const { core, service, path, root } = await box(undefined, { searchPaths: 3 });
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		// Three change sets, a feed page each: the second takes the view to four paths, and no third page is asked.
		core.feedPage = 1;
		for (const [n, name] of ["a", "b", "c"].entries())
			core.write(await storeFile(root, `docs/${name}.md`, name, n + 2));
		const calls = core.feedCalls;
		await service.poll();
		await service.settled();
		expect(core.feedCalls - calls).toBe(2);
		io.send(Kind.search, {
			query: "plan",
			path: "",
			glob: null,
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect((await io.json()).body).toMatchObject({
			code: "VIEW_CLOSED",
			message: expect.stringMatching(/^SEARCH_FULL: /),
		});
	});

	it("closes a run view a feed page grew past the bound before an access change, though the listing again fails", async () => {
		const { core, service, path, root } = await box(undefined, { searchPaths: 2 });
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		// One page: a new path (three in all), then an access change; the listing again would fail at its first page.
		core.write(await storeFile(root, "docs/more.md", "more", 2));
		core.authority(() => false);
		const failing = Promise.reject(new Error("The core did not answer"));
		failing.catch(() => undefined);
		core.listGate = failing;
		await service.poll();
		await service.settled();
		io.send(Kind.search, {
			query: "plan",
			path: "",
			glob: null,
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect((await io.json()).body).toMatchObject({
			code: "VIEW_CLOSED",
			message: expect.stringMatching(/^SEARCH_FULL: /),
		});
	});

	it("counts a run view's trees while they are listed: distinct views at once, a listing again, and hellos that join", async () => {
		const VIEW2 = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e";
		const PASS2 = "boxpass_9876543210-abcdefghijklmnopqrstuvwx";
		// Two views of four paths each (listed two a page), where the node's run views may hold six: one is served.
		const root = await tempdir();
		const core = new FakeCore();
		core.seed([
			folder("docs"),
			await storeFile(root, "docs/a.md", "a", 1),
			await storeFile(root, "docs/b.md", "b", 2),
			await storeFile(root, "docs/plan.md", "the plan", 3),
		]);
		core.openView(VIEW, BOX_PASS);
		core.openView(VIEW2, PASS2);
		let open!: () => void;
		core.listGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const { path } = await serve(core, root, undefined, { searchPaths: 6 });
		const first = await Client.open(path);
		const second = await Client.open(path);
		const answers = Promise.all([first.hello("io", BOX_PASS, EXEC, VIEW), second.hello("io", PASS2, EXEC, VIEW2)]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		open();
		const bodies = (await answers).map((a) => (a.kind === Kind.helloOk ? "served" : (a.body.message as string)));
		expect(bodies.filter((b) => b === "served")).toHaveLength(1);
		expect(bodies.filter((b) => b.startsWith("SEARCH_FULL: "))).toHaveLength(1);
		// A listing again holds the old tree and the new one at once: a view of two paths where three fit is closed by it.
		const clock = { now: Date.now() };
		const again = await box(clock, { searchPaths: 3, reloadMs: 1_000 });
		const io = await Client.open(again.path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		clock.now += 2_000;
		await again.service.poll();
		await again.service.settled();
		io.send(Kind.search, {
			query: "plan",
			path: "",
			glob: null,
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect((await io.json()).body).toMatchObject({
			code: "VIEW_CLOSED",
			message: expect.stringMatching(/^SEARCH_FULL: /),
		});
		// Two hellos at once on a view too large for the node: neither is served, the one that joined while it was
		// listed included.
		const small = await box(undefined, { searchPaths: 1 });
		const a = await Client.open(small.path);
		const b = await Client.open(small.path);
		for (const answer of await Promise.all([
			a.hello("io", BOX_PASS, EXEC, VIEW),
			b.hello("io", BOX_PASS, EXEC, VIEW),
		]))
			expect(answer.body).toMatchObject({ code: "UNAVAILABLE", message: expect.stringMatching(/^SEARCH_FULL: /) });
	});

	it("answers a search on a view the core ended VIEW_CLOSED, so the run opens another", async () => {
		const { core, service, path } = await box();
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		core.views.get(VIEW)!.state = "closed";
		await service.renewLeases();
		io.send(Kind.search, {
			query: "plan",
			path: "",
			glob: null,
			namesOnly: false,
			caseSensitive: false,
			after: null,
		});
		expect((await io.json()).body.code).toBe("VIEW_CLOSED");
	});

	it("counts a file whose bytes are gone from the share as unreadable, and fails the page when the company's objects are not there at all", async () => {
		const { path, root } = await box();
		const io = await Client.open(path);
		expect((await io.hello("io", BOX_PASS, EXEC, VIEW)).kind).toBe(Kind.helloOk);
		const search = { query: "plan", path: "", glob: null, namesOnly: false, caseSensitive: false, after: null };
		// One chunk of docs/plan.md is missing: the file is passed over and counted, and the page goes on.
		await rm(join(root, PROFILE, hashOf("plan")));
		io.send(Kind.search, search);
		expect((await io.json()).body).toMatchObject({ hits: [], searched: 0, unreadable: 1, next: null });
		// No profile folder at all (a share that is not mounted shows an empty mountpoint): nothing can be read now.
		await rm(join(root, PROFILE), { recursive: true });
		io.send(Kind.search, search);
		expect((await io.json()).body.code).toBe("UNAVAILABLE");
	});

	it("takes no core view at all from a node with no run box hosts", () => {
		const none = new MountGrants([]);
		const hello = { protocol: 1, environmentId: ENV, viewId: VIEW, pass: BOX_PASS, role: "io" as const };
		expect(() => none.admit(hello, EXEC)).toThrow("did not match");
		expect(() =>
			parseOperatorMounts([
				{ id: VIEW, environmentId: ENV, actor: { kind: "platform" }, machine: MACHINE, passSha256: hashOf("p") },
			]),
		).toThrow("not uuids");
	});
});

describe("NasObjects write-through put", () => {
	it("seeds hash-verified chunks into ByteCache, isolates caller buffers, and enforces bounds", async () => {
		const root = await tempdir();
		const objects = new NasObjects({ root, cacheBytes: 16 });
		const source = Buffer.from("hello world");
		const sha = hashOf(source);
		objects.put(PROFILE, sha, source);
		source.fill(0);
		expect(objects.has(PROFILE, sha)).toBe(true);
		expect(objects.cachedBytes).toBe(11);
		expect((await objects.chunk(PROFILE, sha, 11)).toString()).toBe("hello world");
		await expect(objects.chunk(PROFILE, sha, 10)).rejects.toThrow(ObjectIntegrityError);

		expect(() => objects.put("not-a-uuid", sha, Buffer.from("hello world"))).toThrow(ObjectIntegrityError);
		expect(() => objects.put(PROFILE, "bad-hash", Buffer.from("hello world"))).toThrow(ObjectIntegrityError);
		expect(() => objects.put(PROFILE, hashOf(""), Buffer.alloc(0))).toThrow(ObjectIntegrityError);
		expect(() => objects.put(PROFILE, hashOf("x"), Buffer.alloc(CHUNK_BYTES + 1))).toThrow(ObjectIntegrityError);
		expect(() => objects.put(PROFILE, hashOf("expected"), Buffer.from("tampered"))).toThrow(ObjectIntegrityError);
		expect(objects.has(PROFILE, hashOf("expected"))).toBe(false);

		const overCap = Buffer.alloc(20, 0x41);
		const overSha = hashOf(overCap);
		objects.put(PROFILE, overSha, overCap);
		expect(objects.has(PROFILE, overSha)).toBe(false);
		expect(objects.cachedBytes).toBe(11);
	});
});

describe("SupabaseFolderCore paging and oversized fallback", () => {
	it("requests CORE_PAGE = 1000 and falls back to 200 on ResponseTooLargeError without opening the circuit", async () => {
		expect(CORE_PAGE).toBe(1000);
		const seen: Array<{ path: string; limit: number }> = [];
		const core = new SupabaseFolderCore({
			projectUrl: "https://core.example",
			secretKey: "sb_secret_test",
			transport: async (url, req) => {
				const body = JSON.parse(req.body ?? "{}") as { p_limit: number };
				seen.push({ path: url.pathname, limit: body.p_limit });
				if (body.p_limit === CORE_PAGE && seen.length <= 3) throw new ResponseTooLargeError();
				if (url.pathname.endsWith("/qorpera_folder_list")) {
					return {
						status: 200,
						body: Buffer.from(
							JSON.stringify({
								schema: "qorpera.folder-list/v1",
								asOfSeq: 5,
								entries: [],
								nextAfter: null,
							}),
						),
					};
				}
				return {
					status: 200,
					body: Buffer.from(
						JSON.stringify({
							schema: "qorpera.folder-feed/v1",
							asOfSeq: 5,
							resync: false,
							more: false,
							events: [],
							next: { afterSeq: 5, cursor: null },
						}),
					),
				};
			},
		});
		const actor = { kind: "platform" as const };
		const listed = await core.list(ENV, actor, null);
		expect(listed.asOfSeq).toBe(5);
		const fed = await core.feed(ENV, actor, 5, null);
		expect(fed.more).toBe(false);
		const listedAgain = await core.list(ENV, actor, null);
		expect(listedAgain.asOfSeq).toBe(5);
		expect(seen).toEqual([
			{ path: "/rest/v1/rpc/qorpera_folder_list", limit: 1000 },
			{ path: "/rest/v1/rpc/qorpera_folder_list", limit: 200 },
			{ path: "/rest/v1/rpc/qorpera_folder_feed", limit: 1000 },
			{ path: "/rest/v1/rpc/qorpera_folder_feed", limit: 200 },
			{ path: "/rest/v1/rpc/qorpera_folder_list", limit: 1000 },
		]);

		const alwaysLarge = new SupabaseFolderCore({
			projectUrl: "https://core.example",
			secretKey: "sb_secret_test",
			transport: async () => {
				throw new ResponseTooLargeError();
			},
		});
		await expect(alwaysLarge.list(ENV, actor, null)).rejects.toThrow("Object dependency is unavailable");
	});

	it("rejects with ResponseTooLargeError from nodeRequest when response exceeds maxBytes", async () => {
		const server = createHttpServer((_req, res) => {
			res.writeHead(200);
			res.end("x".repeat(256));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const { port } = server.address() as AddressInfo;
		await expect(
			nodeRequest(
				new URL(`http://127.0.0.1:${port}/`),
				{ method: "GET", headers: {} },
				64,
				new AbortController().signal,
			),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("decodes fragmented and multi-frame streams in FrameReader without retaining large slabs or unbounded chunk wrappers", () => {
		const reader = new FrameReader();
		const bigPayload = Buffer.alloc(512 * 1024, 0x37);
		const bigFrame = encodeFrame(Kind.data, bigPayload);
		const decoded: Frame[] = [];
		for (let at = 0; at < bigFrame.byteLength; at += 513) {
			decoded.push(...reader.push(bigFrame.subarray(at, Math.min(bigFrame.byteLength, at + 513))));
		}
		expect(decoded).toHaveLength(1);
		expect(decoded[0]!.kind).toBe(Kind.data);
		expect(decoded[0]!.payload.equals(bigPayload)).toBe(true);
		expect(reader.allocatedBytes).toBe(0);

		const slabReader = new FrameReader();
		const filler = encodeFrame(Kind.data, Buffer.alloc(10_000, 0x22));
		const tailFrame = encodeFrame(Kind.data, Buffer.from("tail-ok"));
		const slab = Buffer.concat([filler, tailFrame.subarray(0, 6)]);
		expect(slab.byteLength).toBeGreaterThan(8192);
		const fromSlab = slabReader.push(slab);
		expect(fromSlab).toHaveLength(1);
		expect(slabReader.push(Buffer.alloc(0))).toEqual([]);
		const finishedTail = slabReader.push(tailFrame.subarray(6));
		expect(finishedTail).toHaveLength(1);
		expect(finishedTail[0]!.payload.toString("utf8")).toBe("tail-ok");
		expect(finishedTail[0]!.payload.buffer).not.toBe(slab.buffer);

		const dripReader = new FrameReader();
		const maxPayload = Buffer.alloc(MAX_PAYLOAD, 0x5c);
		const maxFrame = encodeFrame(Kind.data, maxPayload);
		expect(dripReader.push(maxFrame.subarray(0, 4))).toEqual([]);
		expect(dripReader.allocatedBytes).toBeLessThanOrEqual(256);
		let maxAllocated = dripReader.allocatedBytes;
		const dripOut: Frame[] = [];
		for (let i = 4; i < maxFrame.byteLength; i++) {
			dripOut.push(...dripReader.push(maxFrame.subarray(i, i + 1)));
			if (dripReader.allocatedBytes > maxAllocated) maxAllocated = dripReader.allocatedBytes;
		}
		expect(dripOut).toHaveLength(1);
		expect(dripOut[0]!.payload.byteLength).toBe(MAX_PAYLOAD);
		expect(dripOut[0]!.payload[0]).toBe(0x5c);
		expect(dripOut[0]!.payload[MAX_PAYLOAD - 1]).toBe(0x5c);
		expect(maxAllocated).toBeLessThanOrEqual(MAX_PAYLOAD + 1);
		expect(dripReader.allocatedBytes).toBe(0);

		const zeroLen = new FrameReader();
		expect(zeroLen.push(Buffer.from([0, 0]))).toEqual([]);
		expect(() => zeroLen.push(Buffer.from([0, 0]))).toThrow(ProtocolError);
	});

	it("batches large clocks requests and isolates per-company PG lock conflicts and statement timeouts from the global circuit", async () => {
		const clockBatches: number[] = [];
		let mode: "40001" | "40P01" | "55P03" | "57014" | "ok" = "40001";
		let holdTimeout: (() => void) | undefined;
		const timeoutStarted = new Promise<void>((resolve) => {
			holdTimeout = resolve;
		});
		let releaseTimeout: (() => void) | undefined;
		const timeoutGate = new Promise<void>((resolve) => {
			releaseTimeout = resolve;
		});
		const core = new SupabaseFolderCore({
			projectUrl: "https://core.example",
			secretKey: "sb_secret_test",
			transport: async (url) => {
				if (url.pathname.endsWith("/qorpera_folder_clocks")) {
					const raw = url.searchParams.get("environment_id") ?? "";
					const ids = raw.slice("in.(".length, -1).split(",");
					clockBatches.push(ids.length);
					return {
						status: 200,
						body: Buffer.from(JSON.stringify(ids.map((id, i) => ({ environment_id: id, last_seq: i + 1 })))),
					};
				}
				if (mode === "57014") {
					holdTimeout?.();
					await timeoutGate;
					return {
						status: 500,
						body: Buffer.from(JSON.stringify({ code: "57014", message: "statement timeout" })),
					};
				}
				if (mode !== "ok") {
					return { status: 500, body: Buffer.from(JSON.stringify({ code: mode, message: "lock conflict" })) };
				}
				return {
					status: 200,
					body: Buffer.from(
						JSON.stringify({ schema: "qorpera.folder-list/v1", asOfSeq: 7, entries: [], next: null }),
					),
				};
			},
		});
		const envs = Array.from({ length: 250 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
		const clocks = await core.clocks(envs);
		expect(clockBatches).toEqual([100, 100, 50]);
		expect(clocks.size).toBe(250);

		const actor = { kind: "platform" as const };
		for (const code of ["40001", "40P01", "55P03"] as const) {
			mode = code;
			await expect(core.list(envs[0]!, actor, null)).rejects.toBeInstanceOf(ObjectLockConflict);
			mode = "ok";
			expect((await core.list(envs[1]!, actor, null)).asOfSeq).toBe(7);
		}

		mode = "57014";
		const slow = core.list(envs[0]!, actor, null);
		await timeoutStarted;
		mode = "ok";
		expect((await core.list(envs[1]!, actor, null)).asOfSeq).toBe(7);
		releaseTimeout?.();
		await expect(slow).rejects.toBeInstanceOf(ObjectStatementTimeout);
		expect((await core.list(envs[2]!, actor, null)).asOfSeq).toBe(7);
	});

	it("isolates in-flight profile lookups by actor and loads small NAS objects into unpooled buffers", async () => {
		const root = await tempdir();
		const content = Buffer.from("hello-unpooled-profile-test");
		const file = await storeFile(root, "note.txt", content, 1, content.byteLength);
		const reader = new NasObjects({ root, cacheBytes: 1024 * 1024 });
		const direct = await reader.readChunks(
			PROFILE,
			[{ sha256: file.fileSha256!, bytes: content.byteLength }],
			0,
			content.byteLength,
		);
		expect(direct.equals(content)).toBe(true);
		expect(direct.buffer.byteLength).toBe(content.byteLength);

		const core = new FakeCore();
		const viewA = "20000000-0000-4000-8000-000000000001";
		const viewB = "20000000-0000-4000-8000-000000000002";
		const passA = "pass-a-".padEnd(43, "a");
		const passB = "pass-b-".padEnd(43, "b");
		core.openView(viewA, passA);
		core.openView(viewB, passB);
		core.seed([file]);
		let releaseA: (() => void) | undefined;
		const aWaiting = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		let aStartedResolve: (() => void) | undefined;
		const aStarted = new Promise<void>((resolve) => {
			aStartedResolve = resolve;
		});
		core.objectProfile = async (_env, actor) => {
			if (actor.kind === "view" && actor.viewId === viewA) {
				aStartedResolve?.();
				await aWaiting;
				throw new CoreRefusal("denied", "Folder view has ended");
			}
			return PROFILE;
		};
		const execBridge: BridgeInfo = { cid: 77, lookup: "found", machine: EXEC_HOST };
		const { path } = await serve(core, root);
		const clientA = await Client.open(path);
		const clientB = await Client.open(path);
		cleanup.push(
			() => clientA.close(),
			() => clientB.close(),
		);
		expect((await clientA.hello("io", passA, execBridge, viewA)).kind).toBe(Kind.helloOk);
		expect((await clientB.hello("io", passB, execBridge, viewB)).kind).toBe(Kind.helloOk);
		const readA = clientA.read("note.txt", 1, 0, content.byteLength);
		await aStarted;
		const readB = await clientB.read("note.txt", 1, 0, content.byteLength);
		expect(Buffer.isBuffer(readB) && readB.equals(content)).toBe(true);
		releaseA?.();
		const resA = await readA;
		expect(typeof resA).toBe("string");
	});

	it("keeps small objects in a dedicated ByteCache pool immune to large-chunk scans and prioritizes interactive reads", async () => {
		const root = await tempdir();
		const reader = new NasObjects({ root, cacheBytes: 512 * 1024, parallel: 1 });
		const smallPayloads = Array.from({ length: 4 }, (_, i) => Buffer.from(`small-manifest-${i}-${"m".repeat(512)}`));
		const smallHashes = smallPayloads.map((buf) => hashOf(buf));
		for (let i = 0; i < smallPayloads.length; i++) reader.put(PROFILE, smallHashes[i]!, smallPayloads[i]!);
		for (const hash of smallHashes) expect(reader.has(PROFILE, hash)).toBe(true);

		for (let i = 0; i < 12; i++) {
			const large = Buffer.alloc(128 * 1024, i + 1);
			reader.put(PROFILE, hashOf(large), large);
		}
		for (const hash of smallHashes) expect(reader.has(PROFILE, hash)).toBe(true);
		expect(reader.cachedBytes).toBeLessThanOrEqual(512 * 1024);

		const files = await Promise.all(
			[0, 1, 2, 3].map((i) => storeFile(root, `prio-${i}.bin`, Buffer.from(`prio-body-${i}`), i + 1, 11)),
		);
		const prioReader = new NasObjects({ root, cacheBytes: 1024 * 1024, parallel: 1 });
		const order: number[] = [];
		const c0 = prioReader.chunk(PROFILE, files[0]!.fileSha256!, files[0]!.bytes!, "bulk").then(() => order.push(0));
		const c1 = prioReader.chunk(PROFILE, files[1]!.fileSha256!, files[1]!.bytes!, "bulk").then(() => order.push(1));
		const c2 = prioReader.chunk(PROFILE, files[2]!.fileSha256!, files[2]!.bytes!, "bulk").then(() => order.push(2));
		const interactive = prioReader
			.chunk(PROFILE, files[3]!.fileSha256!, files[3]!.bytes!, "interactive")
			.then(() => order.push(3));
		await Promise.all([c0, c1, c2, interactive]);
		expect(order[0]).toBe(0);
		expect(order[1]).toBe(3);
	});

	it("compacts oversized reports within MAX_PAYLOAD while keeping non-saved entries first and wire keys intact", () => {
		const paths: Report["paths"] = Array.from({ length: 30_000 }, (_, i) => ({
			path: `deep/nested/folder/component-${String(i).padStart(5, "0")}/index.ts`,
			outcome: "saved",
		}));
		const problem = {
			path: "deep/nested/folder/denied-file.ts",
			outcome: "refused" as const,
			reason: "denied",
			kept: true,
		};
		const huge: Report = {
			commitId: "11111111-1111-4111-8111-111111111111",
			seq: 42,
			paths: [...paths, problem],
		};
		expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(MAX_PAYLOAD);
		const fitted = fitReport(huge);
		expect(Object.keys(fitted).sort()).toEqual(["commitId", "paths", "seq"]);
		expect(fitted.paths[0]).toEqual(problem);
		expect(fitted.paths.length).toBeLessThan(huge.paths.length);
		expect(fitted.paths.length).toBeGreaterThan(1000);
		const encoded = encodeJson(Kind.report, fitted);
		expect(encoded.byteLength - 5).toBeLessThanOrEqual(MAX_PAYLOAD);
	});

	it("supports private LAN CA certificates and keep-alive connection reuse in SupabaseFolderCore and GatewayUploads", async () => {
		expect(() => createNodeTransport({ ca: "bad-pem" })).toThrow("CA certificate is invalid");
		expect(
			() => new SupabaseFolderCore({ projectUrl: "https://127.0.0.1:8443", secretKey: "k", ca: "bad-pem" }),
		).toThrow("CA certificate is invalid");
		expect(() => new GatewayUploads({ url: "https://127.0.0.1:8443", token: "t".repeat(43), ca: "bad-pem" })).toThrow(
			"CA certificate is invalid",
		);

		const directory = await tempdir();
		const make = (name: string): void => {
			const made = spawnSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-keyout",
					join(directory, `${name}-key.pem`),
					"-out",
					join(directory, `${name}.pem`),
					"-days",
					"1",
					"-subj",
					"/CN=localhost",
					"-addext",
					"subjectAltName=IP:127.0.0.1",
				],
				{ encoding: "utf8", timeout: 15_000 },
			);
			if (made.status !== 0) throw new Error("Could not create test TLS certificate");
		};
		make("lan");
		make("other");
		const cert = await readFile(join(directory, "lan.pem"), "utf8");
		const key = await readFile(join(directory, "lan-key.pem"), "utf8");
		const otherCa = await readFile(join(directory, "other.pem"), "utf8");

		let connections = 0;
		const server: HttpsServer = createHttpsServer({ cert, key }, (req, res) => {
			req.resume();
			if (req.method === "PUT") {
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ status: "stored" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify([{ environment_id: ENV, last_seq: 9 }]));
		});
		server.on("connection", () => {
			connections++;
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const core = new SupabaseFolderCore({ projectUrl: origin, secretKey: "service-key", ca: cert });
		const wrongCore = new SupabaseFolderCore({ projectUrl: origin, secretKey: "service-key", ca: otherCa });
		const uploads = new GatewayUploads({ url: origin, token: "t".repeat(43), ca: cert });
		cleanup.push(() => {
			core.close();
			wrongCore.close();
			uploads.close();
		});

		expect((await core.clocks([ENV])).get(ENV)).toBe(9);
		expect((await core.clocks([ENV])).get(ENV)).toBe(9);
		expect(connections).toBe(1);
		await expect(wrongCore.clocks([ENV])).rejects.toThrow();

		const body = Buffer.from("lan-upload");
		const put1 = uploads.start(
			ENV,
			{ kind: "platform" },
			"11111111-1111-4111-8111-111111111111",
			hashOf(body),
			body.length,
		);
		await put1.write(body);
		await put1.end();
		const put2 = uploads.start(
			ENV,
			{ kind: "platform" },
			"11111111-1111-4111-8111-111111111111",
			hashOf(body),
			body.length,
		);
		await put2.write(body);
		await put2.end();
		expect(connections).toBeLessThanOrEqual(3);
	});

	it("retries once on stale keep-alive socket resets for GatewayUploads PUT and createNodeTransport GET only", async () => {
		let mode: "reset-reused" | "reset-fresh" = "reset-reused";
		let connections = 0;
		let requestsOnResetFresh = 0;
		const seenPerSocket = new WeakMap<object, number>();
		const server = createHttpServer((req, res) => {
			const count = (seenPerSocket.get(req.socket) ?? 0) + 1;
			seenPerSocket.set(req.socket, count);
			if (mode === "reset-fresh") {
				requestsOnResetFresh++;
				req.socket.destroy();
				return;
			}
			if (count === 2) {
				req.socket.destroy();
				return;
			}
			req.resume();
			req.once("end", () => {
				res.writeHead(req.method === "PUT" ? 201 : 200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			});
		});
		server.on("connection", () => {
			connections++;
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const uploads = new GatewayUploads({ url: origin, token: "t".repeat(43) });
		const transport = createNodeTransport();
		cleanup.push(() => {
			uploads.close();
			transport.close();
		});

		const body = Buffer.from("retry-body");
		const put1 = uploads.start(
			ENV,
			{ kind: "platform" },
			"11111111-1111-4111-8111-111111111111",
			hashOf(body),
			body.length,
		);
		await put1.write(body);
		await put1.end();
		expect(connections).toBe(1);

		const put2 = uploads.start(
			ENV,
			{ kind: "platform" },
			"11111111-1111-4111-8111-111111111111",
			hashOf(body),
			body.length,
		);
		await put2.write(body);
		await put2.end();
		expect(connections).toBe(2);

		const get1 = await transport.request(
			new URL(`${origin}/clocks`),
			{ method: "GET", headers: {} },
			1024,
			AbortSignal.timeout(5_000),
		);
		expect(get1.status).toBe(200);
		const beforeRetryConnections = connections;
		const get2 = await transport.request(
			new URL(`${origin}/clocks`),
			{ method: "GET", headers: {} },
			1024,
			AbortSignal.timeout(5_000),
		);
		expect(get2.status).toBe(200);
		expect(connections).toBe(beforeRetryConnections + 1);

		const get3 = await transport.request(
			new URL(`${origin}/clocks`),
			{ method: "GET", headers: {} },
			1024,
			AbortSignal.timeout(5_000),
		);
		expect(get3.status).toBe(200);
		const beforePostConnections = connections;
		await expect(
			transport.request(
				new URL(`${origin}/rpc`),
				{ method: "POST", headers: {}, body: "{}" },
				1024,
				AbortSignal.timeout(5_000),
			),
		).rejects.toThrow();
		expect(connections).toBe(beforePostConnections);

		mode = "reset-fresh";
		const freshUploads = new GatewayUploads({ url: origin, token: "t".repeat(43) });
		const freshTransport = createNodeTransport();
		cleanup.push(() => {
			freshUploads.close();
			freshTransport.close();
		});
		const put3 = freshUploads.start(
			ENV,
			{ kind: "platform" },
			"11111111-1111-4111-8111-111111111111",
			hashOf(body),
			body.length,
		);
		await put3.write(body);
		await expect(put3.end()).rejects.toMatchObject({ code: "UNAVAILABLE" });
		expect(requestsOnResetFresh).toBe(1);

		await expect(
			freshTransport.request(
				new URL(`${origin}/clocks`),
				{ method: "GET", headers: {} },
				1024,
				AbortSignal.timeout(5_000),
			),
		).rejects.toThrow();
		expect(requestsOnResetFresh).toBe(2);
	});

	it("validates per-caller size on joined #pending NasObjects reads and drops expired waiters without leaking slots", async () => {
		const root = await tempdir();
		const content = Buffer.from("same-hash-size-check");
		const file = await storeFile(root, "item.txt", content, 1, content.byteLength);
		const reader = new NasObjects({ root, cacheBytes: 1024 * 1024, parallel: 1, timeoutMs: 1_000 });
		const [ok, bad] = await Promise.allSettled([
			reader.chunk(PROFILE, file.fileSha256!, content.byteLength),
			reader.chunk(PROFILE, file.fileSha256!, content.byteLength + 1),
		]);
		expect(ok.status === "fulfilled" && ok.value.equals(content)).toBe(true);
		expect(bad.status === "rejected" && bad.reason instanceof ObjectIntegrityError).toBe(true);

		const slow = new NasObjects({ root, cacheBytes: 0, parallel: 1, timeoutMs: 40 });
		const other = await storeFile(root, "other.txt", Buffer.from("second-obj"), 2, 10);
		const fifoHash = "f".repeat(64);
		const fifoPath = join(root, PROFILE, fifoHash);
		await promisify(execFile)("mkfifo", [fifoPath]);
		let unblocked = false;
		const unblockFifo = async () => {
			if (unblocked) return;
			unblocked = true;
			const writer = await openFile(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK).catch(() => undefined);
			await writer?.close();
		};
		try {
			const stuck = slow.chunk(PROFILE, fifoHash, 10).catch((error) => error);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			const queued = await Promise.all([
				slow.chunk(PROFILE, other.fileSha256!, 10).catch((error) => error),
				slow.chunk(PROFILE, file.fileSha256!, content.byteLength).catch((error) => error),
			]);
			expect(await stuck).toBeInstanceOf(ObjectUnavailableError);
			for (const err of queued) expect(err).toBeInstanceOf(ObjectUnavailableError);
			await unblockFifo();
			await new Promise<void>((resolve) => setTimeout(resolve, 15));
			expect((await slow.chunk(PROFILE, other.fileSha256!, 10)).toString()).toBe("second-obj");
		} finally {
			await unblockFifo();
		}
	});

	it("does not resurrect a closed non-run_box view after an in-flight #reload completes, and runs stopCleanly machine boundaries in parallel", async () => {
		const root = await tempdir();
		const file = await storeFile(root, "doc.txt", Buffer.from("hi"), 1);
		const core = new FakeCore();
		core.seed([file]);
		const viewId = "20000000-0000-4000-8000-000000000010";
		const pass = "pass-reload-".padEnd(43, "r");
		core.openView(viewId, pass);
		const { service, path } = await serve(core, root);
		const execBridge: BridgeInfo = { cid: 81, lookup: "found", machine: EXEC_HOST };
		const io = await Client.open(path);
		expect((await io.hello("io", pass, execBridge, viewId)).kind).toBe(Kind.helloOk);

		let listEntered!: () => void;
		let releaseList!: () => void;
		const listStarted = new Promise<void>((resolve) => {
			listEntered = resolve;
		});
		const listGate = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		const origFeed = core.feed.bind(core);
		let triggerResync = true;
		core.feed = async (env, actor, afterSeq) => {
			if (triggerResync) {
				triggerResync = false;
				return { asOfSeq: core.seq, resync: true, events: [], next: { afterSeq: 0, cursor: null }, more: false };
			}
			return origFeed(env, actor, afterSeq);
		};
		const origList = core.list.bind(core);
		core.list = async (env, actor, after) => {
			listEntered();
			await listGate;
			return origList(env, actor, after);
		};

		core.seq++;
		const polling = service.poll();
		await listStarted;
		core.views.delete(viewId);
		await service.renewLeases();
		releaseList();
		await polling;
		const afterClose = await io.read("doc.txt", 1, 0, 2);
		expect(afterClose).toBe("VIEW_CLOSED");

		const core2 = new FakeCore();
		core2.seed([file]);
		const machineA = "30000000-0000-4000-8000-0000000000a1";
		const machineB = "30000000-0000-4000-8000-0000000000b2";
		const viewA = "30000000-0000-4000-8000-000000000011";
		const viewB = "30000000-0000-4000-8000-000000000012";
		const passA = "pass-stop-a-".padEnd(43, "a");
		const passB = "pass-stop-b-".padEnd(43, "b");
		core2.openView(viewA, passA, { kind: "coding_session", codingMachineId: machineA });
		core2.openView(viewB, passB, { kind: "coding_session", codingMachineId: machineB });
		const service2 = new FolderService({
			core: core2,
			objects: new NasObjects({ root, cacheBytes: 1024 * 1024 }),
			grants: codingGrants(),
			log: () => undefined,
		});
		cleanup.push(() => service2.stop());
		service2.secrets(machineA, noSecrets());
		service2.secrets(machineB, noSecrets());
		const bridgeA: BridgeInfo = {
			cid: 91,
			lookup: "found",
			machine: { ...CODING, name: `qorpera-coding-machine-${machineA.replaceAll("-", "")}` },
		};
		const bridgeB: BridgeInfo = {
			cid: 92,
			lookup: "found",
			machine: { ...CODING, name: `qorpera-coding-machine-${machineB.replaceAll("-", "")}` },
		};
		const hA = await service2.open(
			{ protocol: 3, environmentId: ENV, viewId: viewA, pass: passA, role: "io" },
			bridgeA,
		);
		const hB = await service2.open(
			{ protocol: 3, environmentId: ENV, viewId: viewB, pass: passB, role: "io" },
			bridgeB,
		);
		cleanup.push(
			() => hA.release(),
			() => hB.release(),
		);
		await hA.read({ path: "doc.txt", version: v(1), offset: 0, length: 2 });
		await hB.read({ path: "doc.txt", version: v(1), offset: 0, length: 2 });
		let arrived = 0;
		let releaseBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		core2.releaseHook = async () => {
			arrived++;
			if (arrived >= 2) releaseBarrier();
			await barrier;
		};
		expect(await service2.stopCleanly()).toBe(true);
		expect(arrived).toBe(2);
	});
});
