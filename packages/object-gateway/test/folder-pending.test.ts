import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CHUNK_BYTES,
	type ChunkRef,
	type FileRef,
	type PendingFile,
	PendingView,
} from "../src/folder-service/pending.ts";
import { type CommitUnit, planBoundary } from "../src/folder-service/plan.ts";
import { ProtocolError } from "../src/folder-service/protocol.ts";
import { ViewTree } from "../src/folder-service/view-tree.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
let versions = 0;
const version = () => `00000000-0000-4000-8000-${(++versions).toString(16).padStart(12, "0")}`;

/** A live folder: folders, and files whose manifest is named after their content. */
function live(paths: Record<string, string | null>): ViewTree {
	const tree = new ViewTree();
	for (const [path, content] of Object.entries(paths))
		tree.put(
			content === null
				? { path, kind: "folder", version: version() }
				: {
						path,
						kind: "file",
						version: version(),
						manifestSha256: hash(`manifest:${content}`),
						fileSha256: hash(content),
						bytes: content.length,
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
	const size = node.content?.size ?? node.origin?.entry?.bytes ?? 0;
	const id = node.content ? chunks.map((c) => c.sha256).join(",") : `as:${node.origin?.entry?.manifestSha256}`;
	return {
		manifestSha256: hash(`manifest:${id}:${node.executable}`),
		fileSha256: hash(id),
		bytes: size,
		mediaType: "text/plain",
		executable: node.executable,
	};
}

function setup(paths: Record<string, string | null>) {
	const tree = live(paths);
	let seq = 10;
	const view = new PendingView(
		() => tree,
		() => seq,
		() => 1_000,
	);
	return { tree, view, advance: () => seq++ };
}

/** Writes a small file through a handle, as the folder program does: its one chunk, then close. */
function write(view: PendingView, path: string, text: string, options: { base?: string } = {}): void {
	const { handle } = view.openWrite(path, { create: true, exclusive: false, truncate: true, ...options });
	if (text.length > 0) view.setChunk(handle, 0, chunk(text));
	view.close(handle, text.length);
}

/** The core's unit rules (core §3), applied in order to a copy of the live folder; returns each unit's outcome. */
function commit(tree: ViewTree, units: readonly CommitUnit[]) {
	const state = new Map<string, { kind: "file" | "folder"; version: string; manifest?: string }>();
	for (const path of tree.paths()) {
		const e = tree.get(path)!;
		state.set(path, {
			kind: e.kind,
			version: e.version,
			...(e.manifestSha256 ? { manifest: e.manifestSha256 } : {}),
		});
	}
	const parentOk = (path: string) => {
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		return parent === "" || state.get(parent)?.kind === "folder";
	};
	const subtree = (path: string) => [...state.keys()].filter((p) => p === path || p.startsWith(`${path}/`));
	const outcomes = units.map((u) => {
		switch (u.op) {
			case "write": {
				const now = state.get(u.path);
				if (now ? now.kind !== "file" || now.version !== u.expectedVersion : u.expectedVersion !== undefined)
					return "conflict";
				if (!parentOk(u.path)) return "refused";
				state.set(u.path, { kind: "file", version: version(), manifest: u.file.manifestSha256 });
				return "saved";
			}
			case "mkdir":
			case "new_folder": {
				if (state.has(u.path)) return "conflict";
				if (!parentOk(u.path)) return "refused";
				state.set(u.path, { kind: "folder", version: version() });
				if (u.op === "new_folder")
					for (const c of u.contents)
						state.set(`${u.path}/${c.path}`, {
							kind: c.kind,
							version: version(),
							...(c.file ? { manifest: c.file.manifestSha256 } : {}),
						});
				return "saved";
			}
			case "delete": {
				const now = state.get(u.path);
				if (!now || now.version !== u.expectedVersion) return "conflict";
				if (now.kind === "folder" && u.asOfSeq === undefined) return "refused";
				for (const p of subtree(u.path)) state.delete(p);
				return "saved";
			}
			case "move": {
				const now = state.get(u.from);
				if (!now || now.version !== u.expectedVersion || state.has(u.to)) return "conflict";
				if (now.kind === "folder" && u.asOfSeq === undefined) return "refused";
				if (!parentOk(u.to)) return "refused";
				for (const p of subtree(u.from)) {
					const e = state.get(p)!;
					state.delete(p);
					state.set(u.to + p.slice(u.from.length), { ...e, version: version() });
				}
				return "saved";
			}
		}
		throw new Error("Unknown unit");
	});
	return { outcomes, state };
}

/** The folder as the view shows it: each path's kind and, for a file, its bytes' identity. */
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
		} else if (r.kind === "live") out[child] = r.entry.manifestSha256!;
		else {
			const node = r.node as PendingFile;
			const changed = node.content !== undefined || node.executable !== node.origin?.entry?.executable;
			out[child] = changed ? staged(node).manifestSha256 : node.origin!.entry!.manifestSha256!;
		}
	}
	return out;
}

/** Publishes the view's boundary against the live folder: every unit must save, and the result must be what the view
 * showed. Returns the units. */
function publish(tree: ViewTree, view: PendingView): CommitUnit[] {
	const before = shown(view);
	const plan = planBoundary(view, staged);
	const units = plan.units.map((u) => u.unit);
	const { outcomes, state } = commit(tree, units);
	expect(outcomes, JSON.stringify(units, null, 1)).toEqual(units.map(() => "saved"));
	const after: Record<string, string> = {};
	for (const [path, e] of state) after[path] = e.kind === "folder" ? "folder" : e.manifest!;
	expect(after).toEqual(before);
	return units;
}

const refused = (fn: () => void, code: string) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
};

describe("a view's pending changes", () => {
	it("shows a new file at once, and publishes it as a write of an absent path", () => {
		const { tree, view } = setup({ docs: null, "docs/a.md": "a" });
		write(view, "docs/new.md", "hello");
		expect(view.get("docs/new.md")).toMatchObject({ kind: "file", bytes: 5 });
		const units = publish(tree, view);
		expect(units).toEqual([{ op: "write", path: "docs/new.md", file: expect.any(Object) }]);
	});

	it("bases an edit on the version the machine read, not the newest", () => {
		const { tree, view } = setup({ "plan.md": "v1" });
		const read = tree.get("plan.md")!.version;
		// Another machine published v2 meanwhile; the editor saves its v1-derived text with base v1.
		tree.put({ ...tree.get("plan.md")!, version: version(), manifestSha256: hash("manifest:v2") });
		write(view, "plan.md", "mine", { base: read });
		const plan = planBoundary(view, staged);
		expect(plan.units.map((u) => u.unit)).toEqual([
			{ op: "write", path: "plan.md", file: expect.any(Object), expectedVersion: read },
		]);
		expect(
			commit(
				tree,
				plan.units.map((u) => u.unit),
			).outcomes,
		).toEqual(["conflict"]);
	});

	it("publishes an editor's save through a temporary file as the target's next version", () => {
		const { tree, view } = setup({ "report.md": "old" });
		const base = tree.get("report.md")!.version;
		write(view, ".report.md.swx-tmp", "new text");
		view.rename(".report.md.swx-tmp", "report.md", { noReplace: false, toBase: base });
		const units = publish(tree, view);
		expect(units).toEqual([{ op: "write", path: "report.md", file: expect.any(Object), expectedVersion: base }]);
	});

	it("moves, edits and creates inside a renamed folder at its old paths, then moves the folder", () => {
		const { tree, view, advance } = setup({ A: null, "A/x": "x", "A/y": "y", "A/sub": null, "A/sub/z": "z" });
		advance();
		view.rename("A", "B");
		write(view, "B/x", "x2");
		view.unlink("B/y");
		write(view, "B/n", "n");
		view.mkdir("B/sub/deeper");
		expect(view.get("A")).toBeUndefined();
		expect(Object.keys(shown(view)).sort()).toEqual(["B", "B/n", "B/sub", "B/sub/deeper", "B/sub/z", "B/x"]);
		const units = publish(tree, view);
		const move = units.findIndex((u) => u.op === "move");
		expect(units[move]).toEqual({
			op: "move",
			from: "A",
			to: "B",
			expectedVersion: tree.get("A")!.version,
			asOfSeq: 11,
		});
		expect(move).toBe(units.length - 1);
		expect(units.slice(0, -1).every((u) => ("path" in u ? u.path : u.from).startsWith("A/"))).toBe(true);
	});

	it("publishes rm -rf as one subtree removal at the position the view had", () => {
		const { tree, view } = setup({ D: null, "D/a": "a", "D/e": null, "D/e/b": "b", keep: "k" });
		view.unlink("D/e/b");
		view.rmdir("D/e");
		view.unlink("D/a");
		view.rmdir("D");
		const units = publish(tree, view);
		expect(units).toEqual([{ op: "delete", path: "D", expectedVersion: tree.get("D")!.version, asOfSeq: 10 }]);
	});

	it("makes a removed folder again: the removal first, then the new folder with its content", () => {
		const { tree, view } = setup({ D: null, "D/old": "o" });
		view.unlink("D/old");
		view.rmdir("D");
		view.mkdir("D");
		write(view, "D/x", "x");
		const units = publish(tree, view);
		expect(units.map((u) => u.op)).toEqual(["delete", "new_folder"]);
	});

	it("publishes mkdir -p and the files written in it as one new folder", () => {
		const { tree, view } = setup({});
		view.mkdir("N");
		view.mkdir("N/M");
		write(view, "N/M/f", "f");
		write(view, "N/g", "g");
		const units = publish(tree, view);
		expect(units).toEqual([
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

	it("keeps a backup rename and a recreated file: the old file moved, the new one written", () => {
		const { tree, view } = setup({ "notes.txt": "old" });
		view.rename("notes.txt", "notes.txt.bak");
		write(view, "notes.txt", "new");
		const units = publish(tree, view);
		expect(units.map((u) => u.op)).toEqual(["move", "write"]);
	});

	it("swaps two files through a third name", () => {
		const { tree, view } = setup({ a: "A", b: "B" });
		view.rename("a", "t");
		view.rename("b", "a");
		view.rename("t", "b");
		expect(shown(view)).toEqual({ a: hash("manifest:B"), b: hash("manifest:A") });
		publish(tree, view);
	});

	it("moves a file into a folder made in the same boundary, and a folder into another", () => {
		const { tree, view } = setup({ x: "x", P: null, "P/q": "q" });
		view.mkdir("N");
		view.rename("x", "N/x");
		view.rename("P", "N/P");
		const units = publish(tree, view);
		expect(units.map((u) => u.op)).toEqual(["mkdir", "move", "move"]);
	});

	it("moves a file out of a folder before removing the folder", () => {
		const { tree, view } = setup({ D: null, "D/keep": "k", "D/gone": "g" });
		view.rename("D/keep", "keep");
		view.unlink("D/gone");
		view.rmdir("D");
		const units = publish(tree, view);
		expect(units.map((u) => u.op)).toEqual(["move", "delete"]);
	});

	it("publishes a file both moved and changed as a new file and a removal", () => {
		const { tree, view } = setup({ old: "o" });
		view.rename("old", "renamed");
		const { handle } = view.openWrite("renamed", { create: false, exclusive: false, truncate: true });
		view.setChunk(handle, 0, chunk("changed"));
		view.close(handle, 7);
		const units = publish(tree, view);
		expect(units.map((u) => u.op).sort()).toEqual(["delete", "write"]);
	});

	it("publishes the executable bit as a new version over the same bytes", () => {
		const { tree, view } = setup({ "run.sh": "#!" });
		view.setExecutable("run.sh", true);
		const units = publish(tree, view);
		expect(units).toEqual([
			{
				op: "write",
				path: "run.sh",
				file: expect.objectContaining({ executable: true }),
				expectedVersion: expect.any(String),
			},
		]);
	});

	it("leaves a file still open for writing, and lock names, for a later boundary", () => {
		const { view } = setup({ docs: null });
		const { handle } = view.openWrite("docs/long.log", { create: true, exclusive: false, truncate: true });
		write(view, "docs/.~lock.report.odt#", "lock");
		write(view, "docs/done.md", "done");
		const plan = planBoundary(view, staged);
		expect(plan.units.map((u) => u.paths)).toEqual([["docs/done.md"]]);
		expect(plan.waiting).toEqual([{ path: "docs/long.log", reason: "still open for writing" }]);
		expect([...plan.keep].sort()).toEqual(["docs/.~lock.report.odt#", "docs/long.log"]);
		view.settle(plan.keep);
		expect(view.get("docs/done.md")).toBeUndefined();
		expect(view.get("docs/long.log")).toBeDefined();
		view.close(handle, 0);
	});

	it("waits whole while a file open for writing moves with its folder", () => {
		const { view } = setup({ A: null, "A/f": "f" });
		view.openWrite("A/f", { create: false, exclusive: false, truncate: false });
		view.rename("A", "B");
		const plan = planBoundary(view, staged);
		expect(plan.units).toEqual([]);
		expect(plan.waiting).toEqual([{ path: "B/f", reason: "open for writing while it, or a folder above it, moves" }]);
	});

	it("publishes a live file moved into a trash folder as its removal", () => {
		const { tree, view } = setup({ "doc.txt": "d" });
		view.mkdir(".Trash-1000");
		view.rename("doc.txt", ".Trash-1000/doc.txt");
		const plan = planBoundary(view, staged);
		expect(plan.units.map((u) => u.unit)).toEqual([
			{ op: "delete", path: "doc.txt", expectedVersion: tree.get("doc.txt")!.version },
		]);
		expect([...plan.keep].sort()).toEqual([".Trash-1000", ".Trash-1000/doc.txt"]);
	});

	it("tiles a big file's chunks, and refuses a size its chunks do not make", () => {
		const { view } = setup({});
		const { handle } = view.openWrite("big.bin", { create: true, exclusive: true, truncate: true });
		view.setChunk(handle, 0, chunk("first", CHUNK_BYTES));
		view.setChunk(handle, 1, chunk("tail", 10));
		refused(() => view.close(handle, CHUNK_BYTES + 11), "BAD_REQUEST");
		const again = view.openWrite("big.bin", { create: false, exclusive: false, truncate: false });
		view.setChunk(again.handle, 1, chunk("tail", 10));
		expect(view.close(again.handle, CHUNK_BYTES + 10).content?.size).toBe(CHUNK_BYTES + 10);
	});

	it("refuses at once what the folder never takes", () => {
		const { view } = setup({
			vision: null,
			"vision/vision.md": "v",
			agents: null,
			"agents/nora": null,
			"agents/nora/agent.md": "a",
			docs: null,
			"docs/Plan.md": "p",
		});
		refused(() => view.unlink("vision/vision.md"), "NOT_PERMITTED");
		refused(() => view.unlink("agents/nora/agent.md"), "NOT_PERMITTED");
		refused(() => view.rename("agents/nora", "docs/nora"), "NOT_PERMITTED");
		refused(() => view.mkdir("docs/con.txt"), "BAD_REQUEST");
		refused(() => view.mkdir("docs/a:b"), "BAD_REQUEST");
		refused(() => view.mkdir(".git"), "NOT_PERMITTED");
		refused(() => view.mkdir("docs/node_modules"), "NOT_PERMITTED");
		refused(() => view.mkdir("docs/plan.md"), "EXISTS");
		refused(() => view.rmdir("docs"), "NOT_EMPTY");
		refused(() => view.rename("docs", "docs/inside"), "BAD_REQUEST");
		refused(() => view.openWrite("docs/Plan.md", { create: true, exclusive: true, truncate: false }), "EXISTS");
		// A case-only rename of the same file is allowed.
		view.rename("docs/Plan.md", "docs/plan.md");
		expect(view.get("docs/plan.md")).toBeDefined();
		expect(view.get("docs/Plan.md")).toBeUndefined();
	});
});
