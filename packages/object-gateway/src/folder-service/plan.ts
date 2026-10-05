import type { FileRef, LiveRef, PendingFile, PendingView } from "./pending.ts";
import { neverPublished } from "./pending.ts";
import { nameOf, parentOf } from "./view-tree.ts";

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
	/** The view's paths this unit publishes, for the report. */
	readonly paths: readonly string[];
}

export interface BoundaryPlan {
	/** In commit order. */
	readonly units: readonly PlannedUnit[];
	/** Paths this boundary does not publish, and why: those kept for a later one, and those dropped. */
	readonly waiting: readonly { readonly path: string; readonly reason: string }[];
	readonly dropped: readonly { readonly path: string; readonly reason: string }[];
	/** The nodes the boundary leaves pending. */
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

function under(path: string, folder: string): boolean {
	return folder === "" || path.startsWith(`${folder}/`);
}

function join(parent: string, name: string): string {
	return parent === "" ? name : `${parent}/${name}`;
}

/** A path in a place never published: a lock, swap, backup or trash name, or inside a trash folder. */
function unpublished(path: string): boolean {
	return path.split("/").some(neverPublished);
}

/** A live file's own reference: its bytes, kept, under another path (a file both moved and changed is a new file and
 * a removal; a swap of two files is two writes of each other's bytes). */
function liveFile(ref: LiveRef): FileRef | undefined {
	const e = ref.entry;
	if (!e || e.manifestSha256 === undefined || e.fileSha256 === undefined || e.mediaType === undefined)
		return undefined;
	return {
		manifestSha256: e.manifestSha256,
		fileSha256: e.fileSha256,
		bytes: e.bytes,
		mediaType: e.mediaType,
		executable: e.executable,
	};
}

/**
 * The units of one boundary (RUNTIME-FOLDER-WRITES.md, "A boundary"): everything pending but files still open for
 * writing and names never published, in one change set. Every unit names live paths as they are before the change set's
 * own moves, so a change inside a moved folder lands at its old path first and goes with the folder; a file both moved
 * and changed is a removal and a new file, so no unit needs a version another unit of the same change set makes.
 * Units are ordered so each finds what it needs: a path freed before it is filled, a new folder before what goes in it,
 * what is inside a moving folder before the folder moves, what moves out of a removed folder before it goes.
 */
export function planBoundary(view: PendingView, staged: (node: PendingFile) => FileRef | undefined): BoundaryPlan {
	const keep = new Set<string>();
	const waiting: { path: string; reason: string }[] = [];
	const dropped: { path: string; reason: string }[] = [];
	const nodes = view.nodes();

	// A file open for writing whose own path or folder moves would leave its open handle behind: the whole boundary
	// waits for it to close.
	const blocked: string[] = [];
	for (const [path, node] of nodes)
		if (
			node.kind === "file" &&
			node.open > 0 &&
			(view.livePath(path) !== path || (node.origin && node.origin.path !== path))
		)
			blocked.push(path);
	if (blocked.length > 0)
		return {
			units: [],
			waiting: blocked.map((path) => ({ path, reason: "open for writing while it, or a folder above it, moves" })),
			dropped: [],
			keep: new Set(nodes.keys()),
		};

	const removed = new Map<string, LiveRef & { reported: string[] }>();
	const remove = (ref: LiveRef, shown: string): void => {
		if (!removed.has(ref.path)) removed.set(ref.path, { ...ref, reported: [ref.shown ?? shown] });
	};
	for (const ref of view.removed().values()) remove(ref, ref.path);

	const writes: Item[] = [];
	const creates: (Item & { kind: "create"; merged: string })[] = [];
	const moves: (Item & { kind: "move" })[] = [];
	const news: (Item & { kind: "new" })[] = [];

	for (const [path, node] of nodes) {
		if (node.kind === "gone") continue;
		if (unpublished(path)) {
			// A live entry moved where nothing is published (a trash folder) is removed; the node stays in this view.
			if (node.origin) remove(node.origin, path);
			keep.add(path);
			continue;
		}
		if (node.kind === "folder") {
			if (!node.origin) {
				creates.push({ kind: "create", path: view.livePath(path), contents: null, paths: [path], merged: path });
				continue;
			}
			const to = join(view.livePath(parentOf(path)), nameOf(path));
			if (node.origin.path !== to)
				moves.push({ kind: "move", from: node.origin.path, to, ref: node.origin, paths: [path] });
			continue;
		}
		if (node.open > 0) {
			keep.add(path);
			waiting.push({ path, reason: "still open for writing" });
			continue;
		}
		const origin = node.origin;
		const changed =
			node.content !== undefined || (origin !== undefined && node.executable !== origin.entry?.executable);
		const to = view.livePath(path);
		const file = !origin || changed ? staged(node) : undefined;
		if ((!origin || changed) && !file) {
			keep.add(path);
			waiting.push({ path, reason: "its bytes are not saved yet" });
			continue;
		}
		if (!origin) news.push({ kind: "new", path: to, file: file!, paths: [path] });
		else if (origin.path === to) {
			if (changed) writes.push({ kind: "write", path: to, file: file!, expected: origin.version, paths: [path] });
		} else if (!changed) moves.push({ kind: "move", from: origin.path, to, ref: origin, paths: [path] });
		else {
			remove(origin, path);
			news.push({ kind: "new", path: to, file: file!, paths: [path] });
		}
	}

	// A new file where the view removed a live file is that file's next version.
	for (const item of news) {
		const replaced = removed.get(item.path);
		if (replaced?.kind !== "file") continue;
		item.expected = replaced.version;
		item.paths.push(...replaced.reported.filter((p) => !item.paths.includes(p)));
		removed.delete(item.path);
	}

	// One removal per removed folder: what was removed inside it goes with it (and is reported with it).
	const deletes: (Item & { kind: "delete" })[] = [];
	for (const [path, ref] of removed) {
		let top: string | undefined;
		for (let p = parentOf(path); p !== ""; p = parentOf(p)) if (removed.get(p)?.kind === "folder") top = p;
		if (top !== undefined) removed.get(top)!.reported.push(...ref.reported);
		else deletes.push({ kind: "delete", path, ref, paths: ref.reported });
	}

	// A new folder whose whole content is new and published here is one unit with its content (§2 "Units").
	const absorbed = new Set<Item>();
	const others = [...writes, ...deletes, ...moves];
	for (const create of creates.sort((a, b) => a.path.length - b.path.length)) {
		if (absorbed.has(create)) continue;
		const inside = [...nodes].filter(([p]) => under(p, create.merged));
		const eligible =
			inside.every(([p, n]) => {
				if (n.kind === "gone") return false;
				if (unpublished(p)) return true;
				if (n.origin) return false;
				return (
					n.kind === "folder" || (n.open === 0 && news.some((i) => i.paths[0] === p && i.expected === undefined))
				);
			}) && !others.some((i) => at(i).some((p) => under(p, create.path)));
		if (!eligible) continue;
		const contents: { path: string; kind: "file" | "folder"; file?: FileRef }[] = [];
		for (const item of [...creates, ...news]) {
			if (!under(item.path, create.path)) continue;
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
		...moves.sort((a, b) => b.from.split("/").length - a.from.split("/").length),
		...news.filter((i) => !absorbed.has(i)),
	];
	return { units: schedule(items, dropped).map(unitOf), waiting, dropped, keep };
}

function unitOf(item: Item): PlannedUnit {
	switch (item.kind) {
		case "write":
			return {
				unit: { op: "write", path: item.path, file: item.file, expectedVersion: item.expected },
				paths: item.paths,
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
			};
		case "create":
			return {
				unit:
					item.contents && item.contents.length > 0
						? { op: "new_folder", path: item.path, contents: item.contents }
						: { op: "mkdir", path: item.path },
				paths: item.paths,
			};
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
			};
	}
}

/** The paths an item fills, frees and works at. */
function fills(item: Item): string | undefined {
	return item.kind === "create" || item.kind === "new" ? item.path : item.kind === "move" ? item.to : undefined;
}

function frees(item: Item): string | undefined {
	return item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
}

function at(item: Item): string[] {
	return item.kind === "move" ? [item.from, item.to] : [item.path];
}

/** Orders the items so each runs after what it needs (Kahn's algorithm, in the given order where free). Two moves
 * that wait on each other (a swap) are broken: a file's move becomes a write of its bytes at the target and a removal
 * of the source; a folder swap cannot be one change set, so its moves are dropped with what waits on them. */
function schedule(items: Item[], dropped: { path: string; reason: string }[]): Item[] {
	const needs = (item: Item, other: Item): boolean => {
		if (item === other) return false;
		const target = fills(item);
		// The path it fills is freed by the other, or made by it (a new folder holding it).
		if (
			target !== undefined &&
			(frees(other) === target || (other.kind === "create" && other.path === parentOf(target)))
		)
			return true;
		// What is inside a moving folder goes first, at its old path.
		if (item.kind === "move" && item.ref.kind === "folder" && at(other).some((p) => under(p, item.from))) return true;
		// What moves out of a removed folder goes before it.
		if (item.kind === "delete" && item.ref.kind === "folder" && other.kind === "move" && under(other.from, item.path))
			return true;
		return false;
	};
	const order: Item[] = [];
	let left = [...items];
	while (left.length > 0) {
		const ready = left.filter((item) => !left.some((other) => needs(item, other)));
		if (ready.length > 0) {
			order.push(...ready);
			left = left.filter((item) => !ready.includes(item));
			continue;
		}
		// Stuck: a cycle of moves. Break it at a file.
		const move = left.find(
			(item): item is Item & { kind: "move" } => item.kind === "move" && item.ref.kind === "file",
		);
		const file = move ? liveFile(move.ref) : undefined;
		if (move && file) {
			left = left.filter((item) => item !== move);
			left.push(
				{ kind: "delete", path: move.from, ref: move.ref, paths: [] },
				{ kind: "new", path: move.to, file, paths: move.paths },
			);
			continue;
		}
		// Folders swapped: what is left cannot be ordered in one change set.
		for (const item of left)
			for (const path of item.paths)
				dropped.push({ path, reason: "two folders took each other's place; rename one at a time" });
		break;
	}
	return order;
}
