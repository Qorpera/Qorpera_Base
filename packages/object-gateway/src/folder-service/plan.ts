import { type FileRef, folderKey, type LiveRef, type PendingFile, type PendingView, unpublished } from "./pending.ts";
import { parentOf } from "./view-tree.ts";

/** A change set's units, as `qorpera_folder_commit` takes them (core §3). */
export type CommitUnit =
	| { readonly op: "write"; readonly path: string; readonly file: FileRef; readonly expectedVersion?: string }
	| { readonly op: "mkdir"; readonly path: string }
	| {
			readonly op: "new_folder";
			readonly path: string;
			readonly contents: readonly {
				readonly path: string;
				readonly kind: "file" | "folder";
				readonly file?: FileRef;
			}[];
	  }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion: string;
			readonly asOfSeq?: number;
	  };

export interface PlannedUnit {
	readonly unit: CommitUnit;
	/** The view's paths this unit publishes, for the report and for what stays pending when it does not save. */
	readonly paths: readonly string[];
	/** It carries new bytes (a write, or a new folder's files): if the core does not save it, and does not keep it as a
	 * conflict copy, its paths stay pending. */
	readonly bytes: boolean;
}

export interface BoundaryPlan {
	/** In commit order. */
	readonly units: readonly PlannedUnit[];
	/** Paths this boundary leaves pending, and why. */
	readonly waiting: readonly { readonly path: string; readonly reason: string }[];
	/** The nodes the boundary leaves pending whatever its units' outcomes. */
	readonly keep: ReadonlySet<string>;
}

type Item =
	| { kind: "write"; path: string; file: FileRef; expected: string; paths: string[] }
	| { kind: "delete"; path: string; ref: LiveRef; paths: string[] }
	| {
			kind: "create";
			path: string;
			contents: { path: string; kind: "file" | "folder"; file?: FileRef }[] | null;
			paths: string[];
	  }
	| { kind: "move"; from: string; to: string; ref: LiveRef; paths: string[] }
	| { kind: "new"; path: string; file: FileRef; expected?: string; paths: string[] };

/** `path` is strictly below `folder`, by folded keys. */
function below(path: string, folder: string): boolean {
	return folderKey(path).startsWith(`${folderKey(folder)}/`);
}

/**
 * The units of one boundary (RUNTIME-FOLDER-WRITES.md, "A boundary"): everything pending but files still open for
 * writing, bytes not staged yet, and names never published, as one change set. `PendingView` keeps every pending
 * change publishable that way: each unit names a live path as it is, no unit needs a version another unit makes, and
 * no unit's failure can lose another's work. A removed folder is one subtree removal; a new folder whose whole content
 * is new is one `new_folder`; a new file where the view removed a live file is that file's next version. Units are
 * ordered so a path is freed before it is filled, and a new folder made before what goes in it.
 */
export function planBoundary(view: PendingView, staged: (node: PendingFile) => FileRef | undefined): BoundaryPlan {
	const keep = new Set<string>();
	const waiting: { path: string; reason: string }[] = [];
	const writes: (Item & { kind: "write" })[] = [];
	const creates: (Item & { kind: "create" })[] = [];
	const moves: (Item & { kind: "move" })[] = [];
	const news: (Item & { kind: "new" })[] = [];
	const nodes = view.nodes();

	for (const [path, node] of nodes) {
		if (node.kind === "gone") continue;
		if (unpublished(path)) {
			keep.add(path);
			continue;
		}
		if (node.kind === "folder") {
			if (!node.origin) creates.push({ kind: "create", path, contents: null, paths: [path] });
			else if (node.origin.path !== path)
				moves.push({ kind: "move", from: node.origin.path, to: path, ref: node.origin, paths: [path] });
			continue;
		}
		if (node.open > 0) {
			keep.add(path);
			waiting.push({ path, reason: "still open for writing" });
			continue;
		}
		const origin = node.origin;
		if (origin && origin.path !== path) {
			moves.push({ kind: "move", from: origin.path, to: path, ref: origin, paths: [path] });
			continue;
		}
		const changed =
			node.content !== undefined || (origin !== undefined && node.executable !== origin.entry?.executable);
		if (origin && !changed) continue;
		const file = staged(node);
		if (!file) {
			keep.add(path);
			waiting.push({ path, reason: "its bytes are not saved yet" });
			continue;
		}
		if (origin) writes.push({ kind: "write", path, file, expected: origin.version, paths: [path] });
		else news.push({ kind: "new", path, file, paths: [path] });
	}

	// Removals: one per removed folder, with what was removed inside it.
	const removed = view.removed();
	const removedFolder = (path: string): boolean => {
		for (let p = parentOf(path); p !== ""; p = parentOf(p)) if (removed.get(p)?.kind === "folder") return true;
		return false;
	};
	const deletes: (Item & { kind: "delete" })[] = [];
	for (const [path, ref] of removed) {
		if (removedFolder(path)) continue;
		const paths = [path, ...[...removed.keys()].filter((p) => below(p, path))];
		deletes.push({ kind: "delete", path, ref, paths });
	}

	// A new file where the view removed a live file (its folder still there) is that file's next version: an editor's
	// temporary file renamed over its target.
	for (const item of news) {
		const index = deletes.findIndex((d) => d.ref.kind === "file" && folderKey(d.path) === folderKey(item.path));
		if (index < 0) continue;
		item.expected = deletes[index]!.ref.version;
		deletes.splice(index, 1);
	}

	// A new folder whose whole content is new and published here is one unit with its content (§2 "Units").
	const absorbed = new Set<Item>();
	for (const create of [...creates].sort((a, b) => a.path.length - b.path.length)) {
		if (absorbed.has(create)) continue;
		const inside = [...nodes].filter(([p]) => below(p, create.path));
		const eligible = inside.every(([p, n]) => {
			if (unpublished(p)) return true;
			if (n.kind === "gone" || n.origin) return false;
			return n.kind === "folder" || news.some((i) => i.path === p && i.expected === undefined);
		});
		if (!eligible) continue;
		const contents: { path: string; kind: "file" | "folder"; file?: FileRef }[] = [];
		for (const item of [...creates, ...news]) {
			if (!below(item.path, create.path)) continue;
			absorbed.add(item);
			create.paths.push(...item.paths);
			const rel = item.path.slice(create.path.length + 1);
			contents.push(
				item.kind === "new" ? { path: rel, kind: "file", file: item.file } : { path: rel, kind: "folder" },
			);
		}
		create.contents = contents.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
	}

	const items: Item[] = [
		...writes,
		...deletes,
		...creates.filter((i) => !absorbed.has(i)),
		...moves,
		...news.filter((i) => !absorbed.has(i)),
	];
	const units: PlannedUnit[] = [];
	for (const item of schedule(items, waiting, keep)) units.push(unitOf(item));
	return { units, waiting, keep };
}

function unitOf(item: Item): PlannedUnit {
	switch (item.kind) {
		case "write":
			return {
				unit: { op: "write", path: item.path, file: item.file, expectedVersion: item.expected },
				paths: item.paths,
				bytes: true,
			};
		case "new":
			return {
				unit: {
					op: "write",
					path: item.path,
					file: item.file,
					...(item.expected ? { expectedVersion: item.expected } : {}),
				},
				paths: item.paths,
				bytes: true,
			};
		case "delete":
			return {
				unit: {
					op: "delete",
					path: item.path,
					expectedVersion: item.ref.version,
					...(item.ref.kind === "folder" ? { asOfSeq: item.ref.asOfSeq ?? 0 } : {}),
				},
				paths: item.paths,
				bytes: false,
			};
		case "create":
			return item.contents && item.contents.length > 0
				? { unit: { op: "new_folder", path: item.path, contents: item.contents }, paths: item.paths, bytes: true }
				: { unit: { op: "mkdir", path: item.path }, paths: item.paths, bytes: false };
		case "move":
			return {
				unit: {
					op: "move",
					from: item.from,
					to: item.to,
					expectedVersion: item.ref.version,
					...(item.ref.kind === "folder" ? { asOfSeq: item.ref.asOfSeq ?? 0 } : {}),
				},
				paths: item.paths,
				bytes: false,
			};
	}
}

/** The path an item fills, and the one it frees, by folded key. */
function fills(item: Item): string | undefined {
	const path = item.kind === "create" || item.kind === "new" ? item.path : item.kind === "move" ? item.to : undefined;
	return path === undefined ? undefined : folderKey(path);
}

function frees(item: Item): string | undefined {
	const path = item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
	return path === undefined ? undefined : folderKey(path);
}

/** Orders the items so each runs after what it needs (Kahn's algorithm, in the given order where free): a path freed
 * before it is filled, a new folder before what goes in it. PendingView never lets two wait on each other; if they
 * ever did, they would wait for the next boundary rather than be published out of order. */
function schedule(items: Item[], waiting: { path: string; reason: string }[], keep: Set<string>): Item[] {
	const needs = (item: Item, other: Item): boolean => {
		if (item === other) return false;
		const target = fills(item);
		if (target === undefined) return false;
		if (frees(other) === target) return true;
		return other.kind === "create" && folderKey(other.path) === folderKey(parentOf(target));
	};
	const order: Item[] = [];
	let left = [...items];
	while (left.length > 0) {
		const ready = left.filter((item) => !left.some((other) => needs(item, other)));
		if (ready.length === 0) {
			for (const item of left)
				for (const path of item.paths) {
					keep.add(path);
					waiting.push({ path, reason: "its changes wait on each other; they are published one at a time" });
				}
			break;
		}
		order.push(...ready);
		left = left.filter((item) => !ready.includes(item));
	}
	return order;
}
