import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CHUNK_BYTES,
	type ChunkRef,
	type FileRef,
	folderKey,
	type PendingFile,
	PendingView,
	PublishFirst,
} from "../src/folder-service/pending.ts";
import { type CommitUnit, planBoundary } from "../src/folder-service/plan.ts";
import { ProtocolError } from "../src/folder-service/protocol.ts";
import { ViewTree } from "../src/folder-service/view-tree.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
let versions = 0;
const version = () => `00000000-0000-4000-8000-${(++versions).toString(16).padStart(12, "0")}`;

interface State {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	readonly version: string;
	readonly manifest?: string;
	/** A link's (protocol 4). */
	readonly target?: string;
}

/** The live folder as the core keeps it: by folded key, each with its spelled path. */
type Folder = Map<string, State>;

/** A path's content: a file's text, a folder (null), or a link's target. */
type Content = string | null | { readonly link: string };

function folderOf(paths: Record<string, Content>): Folder {
	const state: Folder = new Map();
	for (const [path, content] of Object.entries(paths))
		state.set(
			folderKey(path),
			content === null
				? { path, kind: "folder", version: version() }
				: typeof content === "object"
					? { path, kind: "symlink", version: version(), target: content.link }
					: { path, kind: "file", version: version(), manifest: hash(`manifest:${content}`) },
		);
	return state;
}

function treeOf(state: Folder): ViewTree {
	const tree = new ViewTree();
	for (const e of [...state.values()].sort((a, b) => a.path.length - b.path.length))
		tree.put(
			e.kind === "folder"
				? { path: e.path, kind: "folder", version: e.version }
				: e.kind === "symlink"
					? { path: e.path, kind: "symlink", version: e.version, target: e.target! }
					: {
							path: e.path,
							kind: "file",
							version: e.version,
							manifestSha256: e.manifest!,
							fileSha256: hash(e.manifest!),
							bytes: 3,
							mediaType: "text/plain",
							executable: false,
						},
		);
	return tree;
}

/** A chunk of the given text (sizes are what the planner checks; the bytes are never read here). */
const chunk = (text: string, bytes = text.length): ChunkRef => ({ sha256: hash(`chunk:${text}`), bytes });

/** What a staged file's reference would be: named after its chunks and bit. */
function staged(node: PendingFile): FileRef {
	const chunks = node.content?.chunks ?? [];
	const origin = node.origin?.entry ?? node.copyOf;
	const size = node.content?.size ?? origin?.bytes ?? 0;
	const id = node.content ? chunks.map((c) => c.sha256).join(",") : `as:${origin?.manifestSha256}`;
	return {
		manifestSha256: hash(`manifest:${id}:${node.executable}`),
		fileSha256: hash(id),
		bytes: size,
		mediaType: "text/plain",
		executable: node.executable,
	};
}

/** A view over a live folder; `publish` commits a boundary into it and settles the view, as the service does. */
function setup(paths: Record<string, Content>) {
	let state = folderOf(paths);
	let tree = treeOf(state);
	let seq = 10;
	const view = new PendingView(
		() => tree,
		() => seq,
		() => 1_000,
	);
	return {
		view,
		tree: () => tree,
		advance: () => seq++,
		/** Another machine's new file. */
		create(path: string, content: string) {
			state.set(folderKey(path), { path, kind: "file", version: version(), manifest: hash(`manifest:${content}`) });
			tree = treeOf(state);
			seq++;
			view.liveChanged([path]);
		},
		/** Another machine's save of a file: a new version. */
		change(path: string, content: string) {
			const e = state.get(folderKey(path))!;
			state.set(folderKey(path), { ...e, version: version(), manifest: hash(`manifest:${content}`) });
			tree = treeOf(state);
			seq++;
			view.liveChanged([path]);
		},
		/** Another machine's move of a file (a rename only in case, too): a new version at the new path. */
		move(from: string, to: string) {
			const e = state.get(folderKey(from))!;
			state.delete(folderKey(from));
			state.set(folderKey(to), { ...e, path: to, version: version() });
			tree = treeOf(state);
			seq++;
			view.liveChanged([from, to]);
		},
		/** Publishes the boundary: every unit must save, and the folder must then be what the view showed (but what the
		 * boundary keeps pending). */
		publish(): CommitUnit[] {
			const before = shown(view);
			const plan = planBoundary(view, staged);
			const units = plan.units.map((u) => u.unit);
			const { outcomes, state: after } = commit(state, units);
			expect(outcomes, JSON.stringify(units, null, 1)).toEqual(units.map(() => "saved"));
			state = after;
			tree = treeOf(state);
			seq++;
			view.settle(plan.keep);
			const now: Record<string, string> = {};
			for (const e of state.values())
				now[e.path] = e.kind === "folder" ? "folder" : e.kind === "symlink" ? `link:${e.target}` : e.manifest!;
			const expected = Object.fromEntries(Object.entries(before).filter(([p]) => !plan.keep.has(p)));
			for (const p of plan.keep) delete now[p];
			expect(now).toEqual(expected);
			return units;
		},
		plan: () => planBoundary(view, staged),
		commit: (units: readonly CommitUnit[]) => commit(state, units).outcomes,
	};
}

/** Writes a small file through a handle, as the folder program does: its one chunk, then close. */
function write(view: PendingView, path: string, text: string, options: { base?: string } = {}): void {
	const { handle } = view.openWrite(path, { create: true, exclusive: false, truncate: true, ...options });
	if (text.length > 0) view.setChunk(handle, 0, chunk(text));
	view.close(handle, text.length);
}

/** The core's unit rules (core §3) over folded keys, applied in order to a copy of the folder. */
function commit(folder: Folder, units: readonly CommitUnit[]) {
	const state: Folder = new Map(folder);
	const parentOk = (path: string) => {
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		return parent === "" || state.get(folderKey(parent))?.kind === "folder";
	};
	const subtree = (path: string) =>
		[...state.keys()].filter((k) => k === folderKey(path) || k.startsWith(`${folderKey(path)}/`));
	const outcomes = units.map((u) => {
		switch (u.op) {
			case "write":
			case "symlink": {
				// Either replaces a file or a link at the version it names.
				const now = state.get(folderKey(u.path));
				if (
					u.expectedVersion !== undefined
						? now === undefined || now.kind === "folder" || now.version !== u.expectedVersion
						: now
				)
					return "conflict";
				if (!parentOk(u.path)) return "refused";
				state.set(
					folderKey(u.path),
					u.op === "symlink"
						? { path: u.path, kind: "symlink", version: version(), target: u.target }
						: { path: u.path, kind: "file", version: version(), manifest: u.file.manifestSha256 },
				);
				return "saved";
			}
			case "mkdir":
			case "new_folder": {
				if (state.has(folderKey(u.path))) return "conflict";
				if (!parentOk(u.path)) return "refused";
				state.set(folderKey(u.path), { path: u.path, kind: "folder", version: version() });
				if (u.op === "new_folder")
					for (const c of u.contents)
						state.set(folderKey(`${u.path}/${c.path}`), {
							path: `${u.path}/${c.path}`,
							kind: c.kind,
							version: version(),
							...(c.file ? { manifest: c.file.manifestSha256 } : {}),
							...(c.target !== undefined ? { target: c.target } : {}),
						});
				return "saved";
			}
			case "delete": {
				const now = state.get(folderKey(u.path));
				if (!now || now.version !== u.expectedVersion) return "conflict";
				if (now.kind === "folder" && u.asOfSeq === undefined) return "refused";
				for (const k of subtree(u.path)) state.delete(k);
				return "saved";
			}
			case "move": {
				const now = state.get(folderKey(u.from));
				if (!now || now.version !== u.expectedVersion) return "conflict";
				if (folderKey(u.from) !== folderKey(u.to) && state.has(folderKey(u.to))) return "conflict";
				if (now.kind === "folder" && u.asOfSeq === undefined) return "refused";
				if (!parentOk(u.to)) return "refused";
				const moved = subtree(u.from).map((k) => state.get(k)!);
				for (const e of moved) state.delete(folderKey(e.path));
				for (const e of moved) {
					const path = u.to + e.path.slice(u.from.length);
					state.set(folderKey(path), { ...e, path, version: version() });
				}
				return "saved";
			}
		}
		throw new Error("Unknown unit");
	});
	return { outcomes, state };
}

/** The folder as the view shows it: each path's kind and, for a file, its bytes' identity; for a link, its target. */
function shown(view: PendingView, path = ""): Record<string, string> {
	const out: Record<string, string> = {};
	const page = view.children(path, undefined, 100_000);
	if (typeof page !== "object") throw new Error(`not a folder: ${path}`);
	for (const entry of page.entries) {
		const child = path === "" ? entry.name : `${path}/${entry.name}`;
		const r = view.resolve(child)!;
		if (entry.kind === "folder") {
			out[child] = "folder";
			Object.assign(out, shown(view, child));
		} else if (entry.kind === "symlink") out[child] = `link:${view.get(child)!.target}`;
		else if (r.kind === "live") out[child] = r.entry.manifestSha256!;
		else {
			const node = r.node as PendingFile;
			const changed =
				node.content !== undefined || !node.origin || node.executable !== node.origin.entry?.executable;
			out[child] = changed ? staged(node).manifestSha256 : node.origin!.entry!.manifestSha256!;
		}
	}
	return out;
}

function refused(fn: () => void, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
}

function publishFirst(fn: () => void): void {
	expect(fn).toThrow(PublishFirst);
}

describe("a view's pending changes", () => {
	it("shows a new file at once, and publishes it as a write of an absent path", () => {
		const f = setup({ docs: null, "docs/a.md": "a" });
		write(f.view, "docs/new.md", "hello");
		expect(f.view.get("docs/new.md")).toMatchObject({ kind: "file", bytes: 5 });
		expect(f.publish()).toEqual([{ op: "write", path: "docs/new.md", file: expect.any(Object) }]);
		expect(f.view.empty).toBe(true);
	});

	it("bases a save on the version the machine read, not the newest", () => {
		const f = setup({ "plan.md": "v1" });
		const read = f.tree().get("plan.md")!.version;
		f.change("plan.md", "v2");
		write(f.view, "plan.md", "mine", { base: read });
		const units = f.plan().units.map((u) => u.unit);
		expect(units).toEqual([{ op: "write", path: "plan.md", file: expect.any(Object), expectedVersion: read }]);
		expect(f.commit(units)).toEqual(["conflict"]);
	});

	it("publishes an editor's save through a temporary file as the target's next version", () => {
		const f = setup({ "report.md": "old" });
		const base = f.tree().get("report.md")!.version;
		write(f.view, ".report.md.swx-tmp", "new text");
		f.view.rename(".report.md.swx-tmp", "report.md", { noReplace: false, toBase: base });
		expect(f.publish()).toEqual([
			{ op: "write", path: "report.md", file: expect.any(Object), expectedVersion: base },
		]);
	});

	it("renames a folder; a change inside it publishes the rename first", () => {
		const f = setup({ A: null, "A/x": "x", "A/sub": null, "A/sub/z": "z" });
		f.advance();
		f.view.rename("A", "B");
		expect(Object.keys(shown(f.view)).sort()).toEqual(["B", "B/sub", "B/sub/z", "B/x"]);
		publishFirst(() => write(f.view, "B/x", "x2"));
		publishFirst(() => f.view.unlink("B/x"));
		publishFirst(() => f.view.mkdir("B/sub/deeper"));
		expect(f.publish()).toEqual([
			{ op: "move", from: "A", to: "B", expectedVersion: expect.any(String), asOfSeq: 11 },
		]);
		write(f.view, "B/x", "x2");
		f.view.mkdir("B/sub/deeper");
		expect(f.publish().map((u) => u.op)).toEqual(["write", "mkdir"]);
	});

	it("publishes rm -rf as one subtree removal at the position the view had", () => {
		const f = setup({ D: null, "D/a": "a", "D/e": null, "D/e/b": "b", keep: "k" });
		f.view.unlink("D/e/b");
		f.view.rmdir("D/e");
		f.view.unlink("D/a");
		f.view.rmdir("D");
		expect(f.publish()).toEqual([{ op: "delete", path: "D", expectedVersion: expect.any(String), asOfSeq: 10 }]);
	});

	it("brings back a removed file another machine changed, so its folder's removal never takes it", () => {
		const f = setup({ D: null, "D/f": "v1" });
		f.view.unlink("D/f");
		f.change("D/f", "v2");
		expect(f.view.get("D/f")).toBeDefined();
		refused(() => f.view.rmdir("D"), "NOT_EMPTY");
	});

	it("makes a removed folder again only after the removal is published", () => {
		const f = setup({ D: null, "D/f": "f" });
		f.view.unlink("D/f");
		f.view.rmdir("D");
		publishFirst(() => f.view.mkdir("D"));
		publishFirst(() => f.view.mkdir("d"));
		f.publish();
		f.view.mkdir("D");
		write(f.view, "D/f", "new");
		expect(f.publish()).toEqual([
			{ op: "new_folder", path: "D", contents: [{ path: "f", kind: "file", file: expect.any(Object) }] },
		]);
	});

	it("reuses a moved folder's name only after the move is published", () => {
		const f = setup({ A: null, "A/f": "f" });
		f.view.rename("A", "B");
		publishFirst(() => f.view.mkdir("A"));
		publishFirst(() => f.view.mkdir("a"));
		f.publish();
		f.view.mkdir("A");
		f.view.rename("B/f", "A/f");
		expect(f.publish().map((u) => u.op)).toEqual(["mkdir", "move"]);
	});

	it("publishes mkdir -p and the files written in it as one new folder", () => {
		const f = setup({});
		f.view.mkdir("N");
		f.view.mkdir("N/M");
		write(f.view, "N/M/f", "f");
		write(f.view, "N/g", "g");
		expect(f.publish()).toEqual([
			{
				op: "new_folder",
				path: "N",
				contents: [
					{ path: "M", kind: "folder" },
					{ path: "g", kind: "file", file: expect.any(Object) },
					{ path: "M/f", kind: "file", file: expect.any(Object) },
				],
			},
		]);
	});

	it("rotates a log: the old file moved, a new one written where it was", () => {
		const f = setup({ "app.log": "old" });
		f.view.rename("app.log", "app.log.1");
		write(f.view, "app.log", "new");
		expect(f.publish().map((u) => u.op)).toEqual(["move", "write"]);
	});

	it("publishes a swap of two files once the ring would close", () => {
		const f = setup({ a: "A", b: "B" });
		f.view.rename("a", "t");
		f.view.rename("b", "a");
		publishFirst(() => f.view.rename("t", "b"));
		expect(f.publish().map((u) => u.op)).toEqual(["move", "move"]);
		f.view.rename("t", "b");
		f.publish();
		expect(shown(f.view)).toEqual({ a: hash("manifest:B"), b: hash("manifest:A") });
	});

	it("moves a file and a folder into a folder made in the same boundary", () => {
		const f = setup({ x: "x", P: null, "P/q": "q" });
		f.view.mkdir("N");
		f.view.rename("x", "N/x");
		f.view.rename("P", "N/P");
		expect(f.publish().map((u) => u.op)).toEqual(["mkdir", "move", "move"]);
	});

	it("removes a folder something was moved out of only after the move is published", () => {
		const f = setup({ D: null, "D/keep": "k", "D/gone": "g" });
		f.view.rename("D/keep", "keep");
		f.view.unlink("D/gone");
		publishFirst(() => f.view.rmdir("D"));
		f.publish();
		f.view.rmdir("D");
		expect(f.publish().map((u) => u.op)).toEqual(["delete"]);
	});

	it("replaces a folder that had changes inside only after they are published", () => {
		const f = setup({ D: null, "D/x": "dx", E: null, "E/x": "ex" });
		f.view.rename("D/x", "out");
		publishFirst(() => f.view.rename("E", "D"));
		f.publish();
		f.view.rename("E", "D");
		f.publish();
		expect(shown(f.view)).toEqual({ D: "folder", "D/x": hash("manifest:ex"), out: hash("manifest:dx") });
	});

	it("publishes a file's move and its change one at a time", () => {
		const f = setup({ old: "o", other: "p" });
		f.view.rename("old", "renamed");
		publishFirst(() => f.view.openWrite("renamed", { create: false, exclusive: false, truncate: true }));
		publishFirst(() => f.view.setExecutable("renamed", true));
		write(f.view, "other", "changed");
		publishFirst(() => f.view.rename("other", "other2"));
		f.publish();
		write(f.view, "renamed", "changed too");
		f.view.rename("other", "other2");
		expect(f.publish().map((u) => u.op)).toEqual(["write", "move"]);
	});

	it("publishes the executable bit as a new version over the same bytes", () => {
		const f = setup({ "run.sh": "#!" });
		f.view.setExecutable("run.sh", true);
		expect(f.publish()).toEqual([
			{
				op: "write",
				path: "run.sh",
				file: expect.objectContaining({ executable: true }),
				expectedVersion: expect.any(String),
			},
		]);
	});

	it("leaves a file still open for writing, and lock names, for a later boundary", () => {
		const f = setup({ docs: null });
		const { handle } = f.view.openWrite("docs/long.log", { create: true, exclusive: false, truncate: true });
		write(f.view, "docs/.~lock.report.odt#", "lock");
		write(f.view, "docs/done.md", "done");
		const plan = f.plan();
		expect(plan.units.map((u) => u.paths)).toEqual([["docs/done.md"]]);
		expect(plan.waiting).toEqual([{ path: "docs/long.log", reason: "still open for writing" }]);
		expect([...plan.keep].sort()).toEqual(["docs/.~lock.report.odt#", "docs/long.log"]);
		f.publish();
		expect(f.view.get("docs/long.log")).toBeDefined();
		expect(f.view.get("docs/.~lock.report.odt#")).toBeDefined();
		f.view.close(handle, 0);
		// The closed file goes at the next boundary; the lock name stays pending, but is no unsaved work.
		expect(f.view.unsaved).toBe(true);
		expect(f.publish()).toEqual([expect.objectContaining({ op: "write", path: "docs/long.log" })]);
		expect(f.view.empty).toBe(false);
		expect(f.view.unsaved).toBe(false);
		// A folder with a file open inside it moves only after the file is published.
		const g = setup({ A: null, "A/f": "f" });
		g.view.openWrite("A/f", { create: false, exclusive: false, truncate: false });
		publishFirst(() => g.view.rename("A", "B"));
	});

	it("counts as unsaved what a boundary publishes, not names never published or a file only opened", () => {
		const f = setup({ docs: null, "docs/a.md": "a", "docs/b.md": "b", "run.sh": "#!" });
		write(f.view, "docs/.~lock.a.md#", "lock");
		write(f.view, "docs/a.md~", "backup");
		f.view.mkdir(".Trash-1000");
		const { handle } = f.view.openWrite("docs/a.md", { create: false, exclusive: false, truncate: false });
		expect(f.view.unsaved).toBe(false);
		f.view.close(handle, 1);
		expect(f.view.unsaved).toBe(false);
		const changes: Array<() => void> = [
			() => write(f.view, "docs/a.md", "a2"),
			() => write(f.view, "docs/new.md", "n"),
			() => f.view.mkdir("docs/sub"),
			() => f.view.rename("docs/b.md", "docs/c.md"),
			() => f.view.unlink("docs/c.md"),
			() => f.view.setExecutable("run.sh", true),
		];
		for (const change of changes) {
			change();
			expect(f.view.unsaved).toBe(true);
			f.publish();
			expect(f.view.unsaved).toBe(false);
			expect(f.view.empty).toBe(false);
		}
	});

	it("keeps published paths out of trash folders; new files may go there", () => {
		const f = setup({ "doc.txt": "d" });
		f.view.mkdir(".Trash-1000");
		refused(() => f.view.rename("doc.txt", ".Trash-1000/doc.txt"), "NOT_HERE");
		write(f.view, "scratch.tmp", "s");
		f.view.rename("scratch.tmp", ".Trash-1000/scratch.tmp");
		expect([...f.plan().keep].sort()).toEqual([".Trash-1000", ".Trash-1000/scratch.tmp"]);
	});

	it("tiles a big file's chunks; a close they do not tile is refused and the handle stays open", () => {
		const f = setup({});
		const { handle } = f.view.openWrite("big.bin", { create: true, exclusive: true, truncate: true });
		f.view.setChunk(handle, 0, chunk("first", CHUNK_BYTES));
		f.view.setChunk(handle, 1, chunk("tail", 10));
		refused(() => f.view.close(handle, CHUNK_BYTES + 11), "BAD_REQUEST");
		expect(f.view.file(handle).open).toBe(1);
		expect(f.view.close(handle, CHUNK_BYTES + 10).content?.size).toBe(CHUNK_BYTES + 10);
		// A handle whose connection ended leaves the file as it was when the handle opened.
		const node = f.view.resolve("big.bin");
		const before = node?.kind === "node" ? (node.node as PendingFile) : undefined;
		const version = before!.version;
		const again = f.view.openWrite("big.bin", { create: false, exclusive: false, truncate: false });
		f.view.setChunk(again.handle, 1, chunk("other", 10));
		f.view.abandon(again.handle);
		expect(before!.version).toBe(version);
		expect(before!.content?.chunks[1]).toEqual(chunk("tail", 10));
		expect(before!.open).toBe(0);
	});

	it("never removes a version the machine did not see", () => {
		const f = setup({ D: null, "D/f": "v1", "D/g": "g" });
		const seen = f.tree().get("D/f")!.version;
		f.change("D/f", "v2");
		// The machine's name still showed v1: the removal is refused, and it looks again.
		refused(() => f.view.unlink("D/f", seen), "STALE");
		// A save over it with a stale base keeps that base (it would conflict). If the saved file then goes, v2 shows
		// again, as a changed file's newer version does (below), so no removal of D/f or of the folder can take it unseen.
		write(f.view, "D/t", "mine");
		f.view.rename("D/t", "D/f", { noReplace: false, toBase: seen });
		f.view.unlink("D/f");
		f.view.unlink("D/g");
		expect(shown(f.view)).toEqual({ D: "folder", "D/f": hash("manifest:v2") });
		refused(() => f.view.rmdir("D"), "NOT_EMPTY");
		expect(f.plan().units.map((u) => u.unit)).toEqual([
			{ op: "delete", path: "D/g", expectedVersion: f.tree().get("D/g")!.version },
		]);
	});

	it("drops a removed change whose file moved on, and shows the newer version", () => {
		const f = setup({ D: null, "D/f": "v1" });
		write(f.view, "D/f", "mine");
		f.change("D/f", "v2");
		f.view.unlink("D/f");
		expect(shown(f.view)).toEqual({ D: "folder", "D/f": hash("manifest:v2") });
		refused(() => f.view.rmdir("D"), "NOT_EMPTY");
	});

	it("shows the newer version again when a moved file whose origin moved on is removed", () => {
		const f = setup({ D: null, "D/f": "v1" });
		f.view.rename("D/f", "out");
		f.change("D/f", "v2");
		f.view.unlink("out");
		expect(shown(f.view)).toEqual({ D: "folder", "D/f": hash("manifest:v2") });
		refused(() => f.view.rmdir("D"), "NOT_EMPTY");
	});

	it("removes a folder as of the oldest position of the folders removed in it", () => {
		const f = setup({ D: null, "D/sub": null });
		f.view.rmdir("D/sub");
		// Another machine adds a file to the removed subfolder; the view no longer shows it, so D looks empty.
		f.create("D/sub/new", "n");
		f.view.rmdir("D");
		expect(f.plan().units.map((u) => u.unit)).toEqual([
			{ op: "delete", path: "D", expectedVersion: expect.any(String), asOfSeq: 10 },
		]);
	});

	it("moves no file open for writing or changed: an open one is busy, a changed one publishes first", () => {
		const f = setup({ a: "a", x: "x" });
		const { handle } = f.view.openWrite("a", { create: false, exclusive: false, truncate: false });
		refused(() => f.view.rename("a", "b"), "BUSY");
		f.view.close(handle, 3);
		f.view.setExecutable("x", true);
		publishFirst(() => f.view.rename("x", "y"));
	});

	it("keeps what another handle closed when one handle's connection ends", () => {
		const f = setup({ log: "l" });
		const a = f.view.openWrite("log", { create: false, exclusive: false, truncate: false });
		const b = f.view.openWrite("log", { create: false, exclusive: false, truncate: true });
		f.view.setChunk(b.handle, 0, chunk("from b"));
		const node = f.view.close(b.handle, 6);
		const version = node.version;
		f.view.abandon(a.handle);
		expect(node.version).toBe(version);
		expect(node.content).toEqual({ chunks: [chunk("from b")], size: 6 });
		expect(node.open).toBe(0);
		// The other order: what a handle writes after another closed, and never closes itself, is lost with it.
		const c = f.view.openWrite("log", { create: false, exclusive: false, truncate: false });
		const d = f.view.openWrite("log", { create: false, exclusive: false, truncate: false });
		f.view.setChunk(d.handle, 0, chunk("from d"));
		f.view.close(d.handle, 6);
		const closed = node.version;
		f.view.setChunk(c.handle, 0, chunk("from c"));
		f.view.abandon(c.handle);
		expect(node.version).toBe(closed);
		expect(node.content).toEqual({ chunks: [chunk("from d")], size: 6 });
		// A handle that wrote nothing closing after another wrote: the shared bytes changed, so the version does too.
		const g = f.view.openWrite("log", { create: false, exclusive: false, truncate: false });
		const h = f.view.openWrite("log", { create: false, exclusive: false, truncate: false });
		f.view.setChunk(g.handle, 0, chunk("from g"));
		f.view.close(h.handle, 6);
		expect(node.version).not.toBe(closed);
		expect(node.staged).toBeUndefined();
		f.view.abandon(g.handle);
		expect(node.content).toEqual({ chunks: [chunk("from g")], size: 6 });
	});

	it("renames a folder only in case, with what is in it", () => {
		const f = setup({ Docs: null, "Docs/a": "a" });
		f.view.rename("Docs", "docs");
		expect(Object.keys(shown(f.view)).sort()).toEqual(["docs", "docs/a"]);
		expect(f.publish()).toEqual([
			{ op: "move", from: "Docs", to: "docs", expectedVersion: expect.any(String), asOfSeq: 10 },
		]);
	});

	it("publishes first a change at a path a pending save spells otherwise, so the save keeps its own base", () => {
		const f = setup({ "plan.md": "v1" });
		const base = f.view.get("plan.md")!.version;
		write(f.view, "plan.md.new", "mine");
		f.view.rename("plan.md.new", "plan.md", { noReplace: false, toBase: base });
		// Another machine renames the file only in case: both names show.
		f.move("plan.md", "Plan.md");
		const moved = f.view.get("Plan.md")!.version;
		write(f.view, "next.tmp", "next");
		// A second save renamed over the new name, an edit, a mode change or a removal there would pair with the save's
		// replacement by folded key.
		publishFirst(() => f.view.rename("next.tmp", "Plan.md", { noReplace: false, toBase: moved }));
		publishFirst(() => write(f.view, "Plan.md", "edited", { base: moved }));
		publishFirst(() => f.view.setExecutable("Plan.md", true, moved));
		publishFirst(() => f.view.unlink("Plan.md", moved));
		// Nothing changed: the save still replaces the version it saw (the core's conflict), the new name stays live.
		const units = f.plan().units.map((u) => u.unit);
		expect(units).toHaveLength(2);
		expect(units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ op: "write", path: "plan.md", expectedVersion: base }),
				expect.objectContaining({ op: "write", path: "next.tmp" }),
			]),
		);
		expect(f.commit(units)).toEqual(
			units.map((u) => (u.op === "write" && u.path === "plan.md" ? "conflict" : "saved")),
		);
		expect(f.view.get("Plan.md")!.version).toBe(moved);
	});

	it("refuses at once what the folder never takes, folded as the core folds", () => {
		const f = setup({
			vision: null,
			"vision/vision.md": "v",
			agents: null,
			"agents/nora": null,
			"agents/nora/agent.md": "a",
			docs: null,
			"docs/Plan.md": "p",
			code: null,
			"code/repo": null,
		});
		refused(() => f.view.unlink("vision/vision.md"), "NOT_PERMITTED");
		refused(() => f.view.unlink("agents/nora/agent.md"), "NOT_PERMITTED");
		refused(() => f.view.rename("agents/nora", "docs/nora"), "NOT_PERMITTED");
		refused(() => f.view.mkdir("docs/con.txt"), "BAD_REQUEST");
		refused(() => f.view.mkdir("docs/a:b"), "BAD_REQUEST");
		refused(() => f.view.mkdir("Secrets"), "NOT_PERMITTED");
		refused(() => f.view.mkdir("docs/.git"), "NOT_PERMITTED");
		refused(() => f.view.mkdir("docs/NODE_MODULES"), "NOT_PERMITTED");
		f.view.mkdir("code/repo/.git");
		refused(() => f.view.mkdir("docs/plan.md"), "EXISTS");
		refused(() => f.view.rmdir("docs"), "NOT_EMPTY");
		refused(() => f.view.rename("docs", "docs/inside"), "BAD_REQUEST");
		refused(() => f.view.openWrite("docs/Plan.md", { create: true, exclusive: true, truncate: false }), "EXISTS");
		// A case-only rename of the same file is allowed.
		f.view.rename("docs/Plan.md", "docs/plan.md");
		expect(f.view.get("docs/plan.md")).toBeDefined();
		expect(f.view.get("docs/Plan.md")).toBeUndefined();
		f.publish();
	});
});

describe("a view's links (protocol 4)", () => {
	/** No live version replaced: `J` from a version the view no longer serves. */
	const none = () => undefined;

	it("shows a new link at once with its target, and publishes it as a symlink of an absent path", () => {
		const f = setup({ docs: null, "docs/v1.md": "one" });
		const version = f.view.symlink("docs/latest", "v1.md");
		expect(f.view.get("docs/latest")).toMatchObject({ kind: "symlink", version, bytes: 5, target: "v1.md" });
		expect(f.view.source("docs/latest", version)).toEqual({ target: "v1.md", live: undefined });
		refused(() => f.view.symlink("docs/latest", "v2.md"), "EXISTS");
		refused(() => f.view.mkdir("docs/latest"), "EXISTS");
		refused(() => f.view.openWrite("docs/latest", { create: true, exclusive: false, truncate: true }), "EXISTS");
		// A link is never followed: nothing is below one.
		refused(() => f.view.mkdir("docs/latest/x"), "NOT_A_FOLDER");
		expect(f.view.get("docs/latest/x")).toBeUndefined();
		// Below protocol 4 a listing leaves it out.
		const page = f.view.children("docs", undefined, 100, false);
		expect(typeof page === "object" && page.entries.map((e) => e.name)).toEqual(["v1.md"]);
		expect(f.publish()).toEqual([{ op: "symlink", path: "docs/latest", target: "v1.md" }]);
		expect(f.tree().get("docs/latest")).toMatchObject({ kind: "symlink", target: "v1.md" });
	});

	it("publishes ln -sf (a link renamed over the old one) as one symlink unit at the replaced version", () => {
		const f = setup({ docs: null, "docs/latest": { link: "v1.md" } });
		const old = f.tree().get("docs/latest")!.version;
		f.view.symlink("docs/CuXXXXXX", "v2.md");
		f.view.rename("docs/CuXXXXXX", "docs/latest", { noReplace: false, toBase: old });
		expect(f.publish()).toEqual([{ op: "symlink", path: "docs/latest", target: "v2.md", expectedVersion: old }]);
	});

	it("publishes a new file renamed over a link, and a new link renamed over a file, at the replaced version", () => {
		const f = setup({ "notes.md": { link: "real.md" }, "plan.md": "text" });
		const link = f.tree().get("notes.md")!.version;
		const file = f.tree().get("plan.md")!.version;
		write(f.view, ".notes.md.tmp", "own text");
		f.view.rename(".notes.md.tmp", "notes.md", { noReplace: false, toBase: link });
		f.view.symlink("plan.md.new", "elsewhere.md");
		f.view.rename("plan.md.new", "plan.md", { noReplace: false, toBase: file });
		expect(f.publish()).toEqual([
			{ op: "write", path: "notes.md", file: expect.any(Object), expectedVersion: link },
			{ op: "symlink", path: "plan.md", target: "elsewhere.md", expectedVersion: file },
		]);
	});

	it("publishes a removed link as a delete and a renamed one as a move; a folder holding one is not empty", () => {
		const f = setup({ D: null, "D/l": { link: "x" }, gone: { link: "a" }, old: { link: "b" } });
		refused(() => f.view.rmdir("D"), "NOT_EMPTY");
		f.view.unlink("gone");
		f.view.rename("old", "new");
		expect(f.publish()).toEqual([
			{ op: "delete", path: "gone", expectedVersion: expect.any(String) },
			{ op: "move", from: "old", to: "new", expectedVersion: expect.any(String) },
		]);
		f.view.unlink("D/l");
		f.view.rmdir("D");
		expect(f.publish()).toEqual([{ op: "delete", path: "D", expectedVersion: expect.any(String), asOfSeq: 11 }]);
	});

	it("publishes links made in a new folder with its content", () => {
		const f = setup({});
		f.view.mkdir("site");
		f.view.mkdir("site/assets");
		write(f.view, "site/index.html", "<p>");
		f.view.symlink("site/home.html", "index.html");
		f.view.symlink("site/assets/logo", "../logo.svg");
		expect(f.publish()).toEqual([
			{
				op: "new_folder",
				path: "site",
				contents: [
					{ path: "assets", kind: "folder" },
					{ path: "index.html", kind: "file", file: expect.any(Object) },
					{ path: "home.html", kind: "symlink", target: "index.html" },
					{ path: "assets/logo", kind: "symlink", target: "../logo.svg" },
				],
			},
		]);
	});

	it("publishes J from a live file as a new file over the source's bytes", () => {
		const f = setup({ "a.md": "a" });
		const source = f.tree().get("a.md")!;
		const version = f.view.link("a.md", "b.md", undefined, none);
		expect(f.view.get("b.md")).toMatchObject({ kind: "file", version, bytes: source.bytes });
		expect(f.view.source("b.md", version)).toEqual({ live: source });
		expect((f.view.nodes().get("b.md") as PendingFile).copyOf).toBe(source);
		const [unit] = f.publish();
		expect(unit).toEqual({ op: "write", path: "b.md", file: expect.any(Object) });
	});

	it("publishes J from a version another machine replaced as that version's bytes", () => {
		const f = setup({ "a.md": "v1" });
		const read = f.tree().get("a.md")!;
		f.change("a.md", "v2");
		refused(() => f.view.link("a.md", "b.md", read.version, none), "STALE");
		f.view.link("a.md", "b.md", read.version, (path, version) =>
			path === "a.md" && version === read.version ? read : undefined,
		);
		expect((f.view.nodes().get("b.md") as PendingFile).copyOf).toBe(read);
		f.publish();
	});

	it("publishes J from a pending file as a second write of the same staged bytes", () => {
		const f = setup({ "a.md": "old" });
		write(f.view, "a.md", "new text");
		write(f.view, "fresh.md", "fresh");
		f.view.link("a.md", "b.md", undefined, none);
		f.view.link("fresh.md", "c.md", f.view.get("fresh.md")!.version, none);
		const units = f.publish();
		const file = (path: string) => units.find((u) => u.op === "write" && u.path === path)!;
		expect(units).toHaveLength(4);
		expect(file("b.md")).toEqual({ ...file("a.md"), path: "b.md", expectedVersion: undefined });
		expect(file("c.md")).toEqual({ ...file("fresh.md"), path: "c.md" });
	});

	it("publishes J from a link as a link with its target", () => {
		const f = setup({ latest: { link: "v1.md" } });
		f.view.link("latest", "also", undefined, none);
		f.view.symlink("mine", "v2.md");
		f.view.link("mine", "mine2", undefined, none);
		expect(f.publish()).toEqual([
			{ op: "symlink", path: "also", target: "v1.md" },
			{ op: "symlink", path: "mine", target: "v2.md" },
			{ op: "symlink", path: "mine2", target: "v2.md" },
		]);
	});

	it("refuses J from a file open for writing, onto a present name, from a stale version, and from a folder", () => {
		const f = setup({ D: null, "a.md": "a", "c.md": "c" });
		f.view.openWrite("open.md", { create: true, exclusive: false, truncate: true });
		refused(() => f.view.link("open.md", "b.md", undefined, none), "BUSY");
		refused(() => f.view.link("a.md", "c.md", undefined, none), "EXISTS");
		refused(() => f.view.link("a.md", "b.md", "00000000-0000-4000-8000-ffffffffffff", none), "STALE");
		refused(() => f.view.link("D", "E", undefined, none), "NOT_PERMITTED");
		refused(() => f.view.link("missing", "b.md", undefined, none), "NOT_FOUND");
		write(f.view, "new.md", "n");
		refused(() => f.view.link("new.md", "b.md", "00000000-0000-4000-8000-ffffffffffff", none), "STALE");
		expect(f.view.get("b.md")).toBeUndefined();
	});

	it("never publishes a lock link, and counts it as no unsaved work", () => {
		const f = setup({ "notes.md": "n" });
		f.view.symlink(".#notes.md", "jonas@mac.local.4242:1760000000");
		expect(f.view.unsaved).toBe(false);
		expect(f.plan().keep).toEqual(new Set([".#notes.md"]));
		expect(f.publish()).toEqual([]);
		expect(f.view.get(".#notes.md")).toMatchObject({ kind: "symlink" });
	});
});
