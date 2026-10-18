import { folderKey } from "@qorpera/contracts";
import { gitObjectPath, gitPlace, gitSharedPath } from "./git.ts";
import { type FileRef, type LiveRef, type PendingFile, type PendingView, unpublished } from "./pending.ts";
import { parentOf } from "./view-tree.ts";

/** A structured file's parse for the commit's hook (`memberFolderStructured`, core §3 "Before the transaction"). */
type Structured = { readonly structured?: readonly Record<string, unknown>[] };

/** A change set's units, as `qorpera_folder_commit` takes them (core §3). */
export type CommitUnit =
	| ({
			readonly op: "write";
			readonly path: string;
			readonly file: FileRef;
			readonly expectedVersion?: string;
	  } & Structured)
	| { readonly op: "symlink"; readonly path: string; readonly target: string; readonly expectedVersion?: string }
	| { readonly op: "mkdir"; readonly path: string }
	| ({
			readonly op: "new_folder";
			readonly path: string;
			readonly contents: readonly NewFolderEntry[];
	  } & Structured)
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion: string;
			readonly asOfSeq?: number;
	  };

/** One path a `new_folder` makes: a file with its staged reference, a folder, or a link with its target. */
export interface NewFolderEntry {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	readonly file?: FileRef;
	readonly target?: string;
}

export interface PlannedUnit {
	readonly unit: CommitUnit;
	/** The view's paths this unit publishes, for the report and for what stays pending when it does not save. */
	readonly paths: readonly string[];
	/** It carries new content (a write, a link, or a new folder's files and links): if the core does not save it, and
	 * does not keep it as a conflict copy, its paths stay pending. */
	readonly bytes: boolean;
}

export interface BoundaryPlan {
	/** In commit order. */
	readonly units: readonly PlannedUnit[];
	/** Paths this boundary leaves pending, and why. */
	readonly waiting: readonly { readonly path: string; readonly reason: string }[];
	/** Changes this boundary drops without publishing (the view shows the live folder there again), and why. */
	readonly dropped: readonly { readonly path: string; readonly reason: string }[];
	/** The nodes the boundary leaves pending whatever its units' outcomes. */
	readonly keep: ReadonlySet<string>;
	/** Paths the secret check refused (`SecretCheck`), and those held back as they wait on a change it refused, and
	 * why; kept pending, but never waiting: a final does not wait for them. A name it refused is shown as the folder
	 * above it, whose own name carries no value. */
	readonly refused: readonly { readonly path: string; readonly reason: string }[];
}

/** What a coding machine's boundary is checked against (5j-5): its secret values (secret-scan.ts). */
export interface SecretCheck {
	/** Whether a name or a link's target carries one of the values. */
	carries(text: string): boolean;
	/** Why a changed file's bytes, as they are now, are not published (they carry a value, or could not be checked), or
	 * nothing. */
	refused(node: PendingFile): string | undefined;
}

/** What a refusal of the check says: never the name or the value, nor where in it the value is. */
export const NAME_CARRIES = "a name in this folder carries a secret value";
export const TARGET_CARRIES = "its link's target carries a secret value";
export const WAITS_FOR_REFUSED = "it waits for a change that carries a secret value";

type Item =
	| { kind: "write"; path: string; file: FileRef; expected: string; paths: string[] }
	| { kind: "delete"; path: string; ref: LiveRef; paths: string[] }
	| {
			kind: "create";
			path: string;
			contents: NewFolderEntry[] | null;
			paths: string[];
	  }
	| { kind: "move"; from: string; to: string; ref: LiveRef; paths: string[] }
	| { kind: "new"; path: string; file: FileRef; expected?: string; paths: string[] }
	| { kind: "link"; path: string; target: string; expected?: string; paths: string[] };

/** `path` is strictly below `folder`, by folded keys. */
function below(path: string, folder: string): boolean {
	return folderKey(path).startsWith(`${folderKey(folder)}/`);
}

/** The folder above the first name in `path` that carries a secret value, or nothing if none does. */
function carrierOf(path: string, check: SecretCheck): string | undefined {
	if (!check.carries(path)) return undefined;
	for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1))
		if (check.carries(path.slice(0, slash))) return parentOf(path.slice(0, slash));
	return parentOf(path);
}

/** For a live folder moved from `from` to `to`: the folder above the first name that carries a secret value in a path
 * the move gives what the folder holds, or nothing if none does. */
function carrierBelow(view: PendingView, from: string, to: string, check: SecretCheck): string | undefined {
	for (const live of view.liveBelow(from)) {
		const carrier = carrierOf(to + live.slice(from.length), check);
		if (carrier !== undefined) return carrier;
	}
	return undefined;
}

/**
 * The units of one boundary (RUNTIME-FOLDER-WRITES.md, "A boundary"): everything pending but files still open for
 * writing, bytes not staged yet, and names never published, as one change set. `PendingView` keeps every pending
 * change publishable that way: each unit names a live path as it is, no unit needs a version another unit makes, and
 * no unit's failure can lose another's work. A removed folder is one subtree removal; a new folder whose whole content
 * is new is one `new_folder`; a new file or link that replaces a live one names the version it replaces, which its
 * node holds (`PendingView`). Units are ordered so a path is freed before it is filled, and a new folder made before
 * what goes in it.
 *
 * With `check` (a coding machine's view, 5j-5), a name new in the view that carries one of the machine's secret
 * values, a new link's target that does, and a file whose bytes do are not published but refused, and kept pending:
 * the names before anything else, so no list holds one. A folder's move gives what it holds new names too, and each is
 * checked. A refused move keeps its source where it is (`PendingView.settle`), so what needs a
 * refused change waits with it: a change into the path it would free or into the folder it would make, and the removal
 * or move of a folder that holds a source it keeps.
 */
export function planBoundary(
	view: PendingView,
	staged: (node: PendingFile, path: string) => FileRef | undefined,
	check?: SecretCheck,
): BoundaryPlan {
	const keep = new Set<string>();
	const waiting: { path: string; reason: string }[] = [];
	const dropped: { path: string; reason: string }[] = [];
	const refused: { path: string; reason: string }[] = [];
	const refusedOnce = new Set<string>();
	const refuse = (path: string, reason: string): void => {
		if (refusedOnce.has(`${reason}\n${path}`)) return;
		refusedOnce.add(`${reason}\n${path}`);
		refused.push({ path, reason });
	};
	// The refused moves and new folders, which what needs them waits on.
	const refusedItems: Item[] = [];
	const writes: (Item & { kind: "write" })[] = [];
	const creates: (Item & { kind: "create" })[] = [];
	const moves: (Item & { kind: "move" })[] = [];
	const news: (Item & { kind: "new" })[] = [];
	const links: (Item & { kind: "link" })[] = [];
	const nodes = view.nodes();

	for (const [path, node] of nodes) {
		if (node.kind === "gone") continue;
		if (unpublished(path, view.codeHost)) {
			keep.add(path);
			continue;
		}
		const from = node.origin && node.origin.path !== path ? node.origin.path : undefined;
		let carrier: string | undefined;
		if (check && (!node.origin || from !== undefined)) {
			carrier = carrierOf(path, check);
			// A folder moved takes what it holds along: each of their new paths is a new name too.
			if (carrier === undefined && from !== undefined && node.kind === "folder")
				carrier = carrierBelow(view, from, path, check);
		}
		if (carrier !== undefined) {
			keep.add(path);
			refuse(carrier, NAME_CARRIES);
			if (node.origin)
				refusedItems.push({ kind: "move", from: node.origin.path, to: path, ref: node.origin, paths: [path] });
			else if (node.kind === "folder") refusedItems.push({ kind: "create", path, contents: null, paths: [path] });
			continue;
		}
		if (node.kind === "folder") {
			if (!node.origin) creates.push({ kind: "create", path, contents: null, paths: [path] });
			else if (node.origin.path !== path)
				moves.push({ kind: "move", from: node.origin.path, to: path, ref: node.origin, paths: [path] });
			continue;
		}
		if (node.kind === "symlink") {
			// A link is never changed in place: made, or moved.
			if (!node.origin && check?.carries(node.target)) {
				keep.add(path);
				refuse(path, TARGET_CARRIES);
			} else if (!node.origin)
				links.push({ kind: "link", path, target: node.target, expected: node.replaces?.version, paths: [path] });
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
		const refusal = check?.refused(node);
		if (refusal) {
			keep.add(path);
			refuse(path, refusal);
			continue;
		}
		const file = staged(node, path);
		if (!file) {
			keep.add(path);
			waiting.push({ path, reason: "its bytes are not saved yet" });
			continue;
		}
		if (origin) writes.push({ kind: "write", path, file, expected: origin.version, paths: [path] });
		else news.push({ kind: "new", path, file, expected: node.replaces?.version, paths: [path] });
	}

	// Removals: one per removed folder, with what was removed inside it.
	const removed = view.removed();
	const removedFolder = (path: string): boolean => {
		for (let p = parentOf(path); p !== ""; p = parentOf(p)) if (removed.get(p)?.kind === "folder") return true;
		return false;
	};
	const deletes: (Item & { kind: "delete" })[] = [];
	for (const [path, ref] of removed) {
		// A git directory's shared file goes only with its lease (git.ts): a removal without one is dropped.
		if (removedFolder(path) || gitSharedPath(path, view.codeHost)) continue;
		const inside = [...removed].filter(([p]) => below(p, path));
		// A folder's removal takes everything in it as of its position: a file in it whose live version is not the one
		// its own removal named (it changed before that removal, from a base the machine had not seen) would go
		// unseen, so the folder stays, and so does what was removed in it.
		if (inside.some(([p, r]) => r.kind !== "folder" && view.liveVersion(p) !== r.version)) {
			for (const p of [path, ...inside.map(([q]) => q)])
				dropped.push({ path: p, reason: "something in the folder changed since the machine saw it" });
			continue;
		}
		// The oldest position of any folder removed in it: a removed subfolder hid what came into it after.
		const asOfSeq = Math.min(
			ref.asOfSeq ?? Number.MAX_SAFE_INTEGER,
			...inside.map(([, r]) => (r.kind === "folder" ? (r.asOfSeq ?? 0) : Number.MAX_SAFE_INTEGER)),
		);
		deletes.push({
			kind: "delete",
			path,
			ref: ref.kind === "folder" ? { ...ref, asOfSeq } : ref,
			paths: [path, ...inside.map(([p]) => p)],
		});
	}

	// A new folder whose whole content is new and published here is one unit with its content (§2 "Units").
	const absorbed = new Set<Item>();
	// Not, in a session's view, a folder in a git directory: 5b refuses a session's `new_folder` there (it checks each
	// key in it as moved), so each folder there is a `mkdir` and each file its own write, and each meets its key's own
	// rule (a worktree's first commit makes `logs` and `logs/HEAD`). Nor, in any view, a git directory's objects folder:
	// another session may make the same one first, which a `mkdir` of it is saved over (5b), a `new_folder` not.
	for (const create of [...creates].sort((a, b) => a.path.length - b.path.length)) {
		if (absorbed.has(create) || gitObjectPath(create.path)) continue;
		if (!view.codeHost && gitPlace(create.path).kind === "git") continue;
		const inside = [...nodes].filter(([p]) => below(p, create.path));
		const eligible = inside.every(([p, n]) => {
			if (unpublished(p, view.codeHost)) return true;
			if (n.kind === "gone" || n.origin) return false;
			return n.kind === "folder" || [...news, ...links].some((i) => i.path === p && i.expected === undefined);
		});
		if (!eligible) continue;
		const contents: NewFolderEntry[] = [];
		for (const item of [...creates, ...news, ...links]) {
			if (!below(item.path, create.path)) continue;
			absorbed.add(item);
			create.paths.push(...item.paths);
			const rel = item.path.slice(create.path.length + 1);
			contents.push(
				item.kind === "new"
					? { path: rel, kind: "file", file: item.file }
					: item.kind === "link"
						? { path: rel, kind: "symlink", target: item.target }
						: { path: rel, kind: "folder" },
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
		...links.filter((i) => !absorbed.has(i)),
	];
	// What needs a refused change waits with it, and so on: a move it holds back keeps its source too.
	const blocked = new Set<Item>(refusedItems);
	for (let grew = blocked.size > 0; grew; ) {
		grew = false;
		const sources = [...blocked].flatMap((b) => (b.kind === "move" ? [b.from] : []));
		for (const item of items) {
			if (blocked.has(item)) continue;
			const from = item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
			const holds = from !== undefined && sources.some((s) => folderKey(s) === folderKey(from) || below(s, from));
			if (holds || [...blocked].some((b) => needs(item, b))) {
				blocked.add(item);
				grew = true;
			}
		}
	}
	for (const item of items)
		if (blocked.has(item))
			for (const path of item.paths) {
				keep.add(path);
				refuse(path, WAITS_FOR_REFUSED);
			}
	const units: PlannedUnit[] = [];
	for (const item of schedule(
		items.filter((i) => !blocked.has(i)),
		waiting,
		keep,
	))
		units.push(unitOf(item));
	return { units, waiting, dropped, keep, refused };
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
		case "link":
			return {
				unit: {
					op: "symlink",
					path: item.path,
					target: item.target,
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
	const path =
		item.kind === "create" || item.kind === "new" || item.kind === "link"
			? item.path
			: item.kind === "move"
				? item.to
				: undefined;
	return path === undefined ? undefined : folderKey(path);
}

function frees(item: Item): string | undefined {
	const path = item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
	return path === undefined ? undefined : folderKey(path);
}

/** `item` runs after `other`: it fills the path `other` frees, or goes in the new folder `other` makes. */
function needs(item: Item, other: Item): boolean {
	if (item === other) return false;
	const target = fills(item);
	if (target === undefined) return false;
	if (frees(other) === target) return true;
	return other.kind === "create" && folderKey(other.path) === folderKey(parentOf(target));
}

/** Orders the items so each runs after what it needs (Kahn's algorithm, in the given order where free): a path freed
 * before it is filled, a new folder before what goes in it. PendingView never lets two wait on each other; if they
 * ever did, they would wait for the next boundary rather than be published out of order. */
function schedule(items: Item[], waiting: { path: string; reason: string }[], keep: Set<string>): Item[] {
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
