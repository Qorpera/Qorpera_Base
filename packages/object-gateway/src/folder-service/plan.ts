import { companyStatePath } from "@qorpera/cloud-client/company-state-files";
import { folderKey } from "@qorpera/contracts";
import { gitObject, gitObjectPath, gitPlace, gitSharedPath } from "./git.ts";
import { formChanged } from "./git-objects.ts";
import { type FileRef, type LiveRef, type PendingFile, type PendingView, unpublished } from "./pending.ts";
import { UNCHECKED } from "./secret-scan.ts";
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
	/** The removals it leaves pending, held back so: the view keeps them (`PendingView.settle`). */
	readonly removals: ReadonlySet<string>;
	/** Paths the secret check refused (`SecretCheck`), and those held back as they wait on a change it refused (one
	 * they need, or one in their git directory), and why; kept pending, but never waiting: a final does not wait for
	 * them. A name it refused is shown as the folder above it, whose own name carries no value. */
	readonly refused: readonly { readonly path: string; readonly reason: string }[];
	/** Each code area whose git directory holds a change the check refused, and what the rest of the directory waits
	 * for (`WAITS_FOR_REFUSED` or `WAITS_FOR_UNCHECKED`): a git lease publishes and releases nothing there either. */
	readonly gitHeld: ReadonlyMap<string, string>;
}

/** What a coding machine's boundary is checked against (5j-5): its secret values (secret-scan.ts). */
export interface SecretCheck {
	/** Whether a name or a link's target carries one of the values. */
	carries(text: string): boolean;
	/** Whether the check of a changed file's bytes as `path` stores them still runs: it waits (`CHECK_RUNNING`). */
	checking(node: PendingFile, path: string): boolean;
	/** Why a changed file's bytes as they are now are not published (they carry a value, or could not be checked). */
	refused(node: PendingFile): string | undefined;
	/** The same for the bytes a file moved or renamed to `path` still has from its live source, where `path` gives them
	 * a git form the source's name did not (`formChanged`): not checked so yet, they are refused as not checked. */
	moved(node: PendingFile, path: string): string | undefined;
}

/** What a refusal of the check says: never the name or the value, nor where in it the value is. */
export const NAME_CARRIES = "a name in this folder carries a secret value";
export const TARGET_CARRIES = "its link's target carries a secret value";
export const WAITS_FOR_REFUSED = "it waits for a change that carries a secret value";
export const WAITS_FOR_UNCHECKED = "it waits for a change that could not be checked for secret values";
/** Why a file waits whose check has not ended (`SecretCheck.checking`): a later boundary publishes it. */
export const CHECK_RUNNING = "its check for secret values has not ended yet";
/** Why the rest of a code area's git directory waits while a file's check there has not ended: the check may yet refuse
 * the file, and then nothing else of its git change may be in the folder. */
export const WAITS_FOR_CHECK = "it waits for a change whose check for secret values has not ended yet";
export const MAX_COMMIT_UNITS = 1000;
export const MAX_NEW_FOLDER_ENTRIES = 10_000;
export const MAX_COMMIT_STRUCTURED_FILES = 64;
export const MAX_COMMIT_STRUCTURED_BYTES = 1024 * 1024;

export interface CommitBatchLimits {
	readonly maxUnits?: number;
	readonly maxStructuredFiles?: number;
	readonly maxStructuredBytes?: number;
}

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

/** For a live folder moved from `from` to `to`: whether the move gives a file it holds a git form its name did not
 * (`formChanged`). Such a file's bytes are checked as that form only when it is moved by itself. */
function formBelow(view: PendingView, from: string, to: string): boolean {
	for (const live of view.liveBelow(from)) if (formChanged(live, to + live.slice(from.length))) return true;
	return false;
}

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
	// Each code area whose git directory holds a refused change, and what the rest of that directory waits for.
	const gitHeld = new Map<string, string>();
	const holdGit = (path: string, reason: string): void => {
		const place = gitPlace(path);
		if (place.kind !== "git") return;
		const waits = reason === UNCHECKED ? WAITS_FOR_UNCHECKED : WAITS_FOR_REFUSED;
		if (gitHeld.get(place.area) !== WAITS_FOR_REFUSED) gitHeld.set(place.area, waits);
	};
	// Each code area whose git directory holds a file whose check has not ended: the rest of the directory waits too.
	const gitChecking = new Set<string>();
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
			holdGit(path, NAME_CARRIES);
			if (node.origin)
				refusedItems.push({ kind: "move", from: node.origin.path, to: path, ref: node.origin, paths: [path] });
			else if (node.kind === "folder") refusedItems.push({ kind: "create", path, contents: null, paths: [path] });
			continue;
		}
		if (node.kind === "folder") {
			if (!node.origin) creates.push({ kind: "create", path, contents: null, paths: [path] });
			else if (from !== undefined) {
				const move = { kind: "move" as const, from, to: path, ref: node.origin, paths: [path] };
				if (check && formBelow(view, from, path)) {
					keep.add(path);
					refuse(path, UNCHECKED);
					holdGit(path, UNCHECKED);
					refusedItems.push(move);
				} else moves.push(move);
			}
			continue;
		}
		if (node.kind === "symlink") {
			// A link is never changed in place: made, or moved.
			if (!node.origin && check?.carries(node.target)) {
				keep.add(path);
				refuse(path, TARGET_CARRIES);
				holdGit(path, TARGET_CARRIES);
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
		if (check?.checking(node, path)) {
			keep.add(path);
			waiting.push({ path, reason: CHECK_RUNNING });
			const place = gitPlace(path);
			if (place.kind === "git") gitChecking.add(place.area);
			continue;
		}
		const origin = node.origin;
		if (origin && origin.path !== path) {
			const move = { kind: "move" as const, from: origin.path, to: path, ref: origin, paths: [path] };
			const refusal = check && formChanged(origin.path, path) ? check.moved(node, path) : undefined;
			if (refusal) {
				keep.add(path);
				refuse(path, refusal);
				holdGit(path, refusal);
				refusedItems.push(move);
			} else moves.push(move);
			continue;
		}
		const changed =
			node.content !== undefined || (origin !== undefined && node.executable !== origin.entry?.executable);
		if (origin && !changed) continue;
		const refusal = check?.refused(node);
		if (refusal) {
			keep.add(path);
			refuse(path, refusal);
			holdGit(path, refusal);
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
	const keyCache = new Map<string, string>();
	const keyOf = (path: string): string => {
		let key = keyCache.get(path);
		if (key === undefined) {
			key = folderKey(path);
			keyCache.set(path, key);
		}
		return key;
	};
	const removed = view.removed();
	const removedFolder = (path: string): boolean => {
		for (let p = parentOf(path); p !== ""; p = parentOf(p)) if (removed.get(p)?.kind === "folder") return true;
		return false;
	};
	const topRemoved: [string, LiveRef][] = [];
	const topRemovedKeys = new Set<string>();
	for (const [path, ref] of removed) {
		// A git directory's shared file goes only with its lease (git.ts): a removal without one is dropped.
		if (removedFolder(path) || gitSharedPath(path, view.codeHost)) continue;
		topRemoved.push([path, ref]);
		topRemovedKeys.add(keyOf(path));
	}
	const removedInside = new Map<string, [string, LiveRef][]>();
	if (topRemovedKeys.size > 0) {
		for (const entry of removed) {
			for (let anc = parentOf(keyOf(entry[0])); anc !== ""; anc = parentOf(anc)) {
				if (!topRemovedKeys.has(anc)) continue;
				let list = removedInside.get(anc);
				if (!list) {
					list = [];
					removedInside.set(anc, list);
				}
				list.push(entry);
			}
		}
	}
	const deletes: (Item & { kind: "delete" })[] = [];
	for (const [path, ref] of topRemoved) {
		const inside = removedInside.get(keyOf(path)) ?? [];
		// A folder's removal takes everything in it as of its position: a file in it whose live version is not the one
		// its own removal named (it changed before that removal, from a base the machine had not seen) would go
		// unseen, so the folder stays, and so does what was removed in it.
		if (inside.some(([p, r]) => r.kind !== "folder" && view.liveVersion(p) !== r.version)) {
			dropped.push({ path, reason: "something in the folder changed since the machine saw it" });
			for (const [q] of inside)
				dropped.push({ path: q, reason: "something in the folder changed since the machine saw it" });
			continue;
		}
		// The oldest position of any folder removed in it: a removed subfolder hid what came into it after.
		let asOfSeq = ref.asOfSeq ?? Number.MAX_SAFE_INTEGER;
		for (const [, r] of inside) {
			if (r.kind === "folder") {
				const seq = r.asOfSeq ?? 0;
				if (seq < asOfSeq) asOfSeq = seq;
			}
		}
		const paths = [path];
		for (const [p] of inside) paths.push(p);
		deletes.push({
			kind: "delete",
			path,
			ref: ref.kind === "folder" ? { ...ref, asOfSeq } : ref,
			paths,
		});
	}

	// A new folder whose whole content is new and published here is one unit with its content (§2 "Units").
	const absorbed = new Set<Item>();
	const sortedCreates = [...creates].sort((a, b) => a.path.length - b.path.length);
	const candidateCreateKeys = new Set<string>();
	// Not, in a session's view, a folder in a git directory: 5b refuses a session's `new_folder` there (it checks each
	// key in it as moved), so each folder there is a `mkdir` and each file its own write, and each meets its key's own
	// rule (a worktree's first commit makes `logs` and `logs/HEAD`). Nor, in any view, a git directory's objects folder:
	// another session may make the same one first, which a `mkdir` of it is saved over (5b), a `new_folder` not.
	for (const create of sortedCreates) {
		if (gitObjectPath(create.path)) continue;
		if (!view.codeHost && gitPlace(create.path).kind === "git") continue;
		candidateCreateKeys.add(keyOf(create.path));
	}
	const ineligibleCreateKeys = new Set<string>();
	const itemsUnderCreate = new Map<string, (Item & { kind: "create" | "new" | "link" })[]>();
	if (candidateCreateKeys.size > 0) {
		const freeNewOrLink = new Set<string>();
		for (const item of news) if (item.expected === undefined) freeNewOrLink.add(item.path);
		for (const item of links) if (item.expected === undefined) freeNewOrLink.add(item.path);
		for (const [p, n] of nodes) {
			if (unpublished(p, view.codeHost)) continue;
			const ok = n.kind !== "gone" && !n.origin && (n.kind === "folder" || freeNewOrLink.has(p));
			if (ok) continue;
			for (let anc = parentOf(keyOf(p)); anc !== ""; anc = parentOf(anc)) {
				if (candidateCreateKeys.has(anc)) ineligibleCreateKeys.add(anc);
			}
		}
		for (const item of [...creates, ...news, ...links]) {
			for (let anc = parentOf(keyOf(item.path)); anc !== ""; anc = parentOf(anc)) {
				if (!candidateCreateKeys.has(anc) || ineligibleCreateKeys.has(anc)) continue;
				let list = itemsUnderCreate.get(anc);
				if (!list) {
					list = [];
					itemsUnderCreate.set(anc, list);
				}
				list.push(item);
			}
		}
	}
	for (const create of sortedCreates) {
		const createKey = keyOf(create.path);
		if (absorbed.has(create) || !candidateCreateKeys.has(createKey) || ineligibleCreateKeys.has(createKey)) continue;
		const under = itemsUnderCreate.get(createKey) ?? [];
		if (!fitsNewFolder(under)) continue;
		const contents: NewFolderEntry[] = [];
		for (const item of under) {
			absorbed.add(item);
			for (const p of item.paths) create.paths.push(p);
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
	if (blocked.size > 0) {
		const byFrom = new Map<string, Item[]>();
		const needingFrees = new Map<string, Item[]>();
		const needingCreate = new Map<string, Item[]>();
		const pushItem = (map: Map<string, Item[]>, key: string, item: Item): void => {
			let list = map.get(key);
			if (!list) {
				list = [];
				map.set(key, list);
			}
			list.push(item);
		};
		for (const item of items) {
			const from = item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
			if (from !== undefined) pushItem(byFrom, keyOf(from), item);
			const target = fills(item, keyOf);
			if (target !== undefined) {
				pushItem(needingFrees, target, item);
				pushItem(needingCreate, keyOf(parentOf(target)), item);
			}
		}
		const queue: Item[] = [...blocked];
		for (let head = 0; head < queue.length; head++) {
			const b = queue[head]!;
			const enqueue = (list: Item[] | undefined, skipSelf: boolean): void => {
				if (!list) return;
				for (const item of list) {
					if ((skipSelf && item === b) || blocked.has(item)) continue;
					blocked.add(item);
					queue.push(item);
				}
			};
			if (b.kind === "move") {
				for (let anc = keyOf(b.from); anc !== ""; anc = parentOf(anc)) enqueue(byFrom.get(anc), false);
			}
			const freed = frees(b, keyOf);
			if (freed !== undefined) enqueue(needingFrees.get(freed), true);
			if (b.kind === "create") enqueue(needingCreate.get(keyOf(b.path)), true);
		}
	}
	// A git directory with a refused change publishes nothing else until the refusal's way out: no object, ref, log or
	// index of the change, nor any change after it, reaches the folder half made. One with a check not ended publishes
	// nothing else until it ends, as the check may yet refuse its file: what waits for it is waiting, not refused.
	const heldIn = (item: Item): string | undefined => {
		let waits: string | undefined;
		for (const path of item.kind === "move" ? [item.from, ...item.paths] : item.paths) {
			const place = gitPlace(path);
			if (place.kind !== "git") continue;
			const refusal = gitHeld.get(place.area);
			if (refusal) return refusal;
			if (gitChecking.has(place.area)) waits = WAITS_FOR_CHECK;
		}
		return waits;
	};
	const held = new Set<Item>();
	for (const item of items) {
		const waits = blocked.has(item) ? WAITS_FOR_REFUSED : heldIn(item);
		if (!waits) continue;
		held.add(item);
		for (const path of item.paths) {
			keep.add(path);
			if (waits === WAITS_FOR_CHECK) waiting.push({ path, reason: waits });
			else refuse(path, waits);
		}
	}
	const order = schedule(
		items.filter((i) => !held.has(i)),
		waiting,
		keep,
		keyOf,
	);
	const units = order.map(unitOf);
	// A removal not published here stays the view's, for a later boundary to publish.
	const published = new Set<Item>(order);
	const removals = new Set(deletes.filter((d) => !published.has(d)).flatMap((d) => d.paths));
	return { units, waiting, dropped, keep, removals, refused, gitHeld };
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
function fills(item: Item, keyOf: (path: string) => string): string | undefined {
	const path =
		item.kind === "create" || item.kind === "new" || item.kind === "link"
			? item.path
			: item.kind === "move"
				? item.to
				: undefined;
	return path === undefined ? undefined : keyOf(path);
}

function frees(item: Item, keyOf: (path: string) => string): string | undefined {
	const path = item.kind === "delete" ? item.path : item.kind === "move" ? item.from : undefined;
	return path === undefined ? undefined : keyOf(path);
}

function gitDirOf(path: string): { readonly dir: string; readonly rest: string } | undefined {
	const place = gitPlace(path);
	if (place.kind === "git") return place.rest === "" ? undefined : { dir: `${place.area}/repo.git`, rest: place.rest };
	if (path.startsWith(".git/")) return { dir: ".git", rest: path.slice(5) };
	const idx = path.indexOf("/.git/");
	if (idx !== -1) return { dir: path.slice(0, idx + 5), rest: path.slice(idx + 6) };
	return undefined;
}

function gitPhaseOf(
	item: Item,
	filledKeys: ReadonlySet<string>,
	keyOf: (path: string) => string,
): { readonly dir: string; readonly phase: 1 | 2 | 3 } | undefined {
	const targetPath = item.kind === "move" ? item.to : item.path;
	const info = gitDirOf(targetPath);
	if (!info) return undefined;
	const dir = keyOf(info.dir);
	if (gitObject(info.rest)) {
		if (item.kind === "delete") return filledKeys.has(keyOf(item.path)) ? undefined : { dir, phase: 3 };
		return { dir, phase: 1 };
	}
	if (item.kind === "move") {
		const fromInfo = gitDirOf(item.from);
		if (fromInfo && gitObject(fromInfo.rest)) return undefined;
	}
	return { dir, phase: 2 };
}

function gitMetaDir(unit: CommitUnit): string | undefined {
	const targetPath = unit.op === "move" ? unit.to : unit.path;
	const info = gitDirOf(targetPath);
	if (!info || gitObject(info.rest)) return undefined;
	if (unit.op === "move") {
		const fromInfo = gitDirOf(unit.from);
		if (fromInfo && gitObject(fromInfo.rest)) return undefined;
	}
	return folderKey(info.dir);
}

/** Orders the items so each runs after what it needs (Kahn's algorithm, in the given order where free): a path freed
 * before it is filled, a new folder before what goes in it. PendingView never lets two wait on each other; if they
 * ever did, they would wait for the next boundary rather than be published out of order. */
function schedule(
	items: Item[],
	waiting: { path: string; reason: string }[],
	keep: Set<string>,
	keyOf: (path: string) => string,
): Item[] {
	const count = items.length;
	if (count === 0) return [];
	const byFrees = new Map<string, number[]>();
	const byCreate = new Map<string, number[]>();
	const filledKeys = new Set<string>();
	const pushIndex = (map: Map<string, number[]>, key: string, index: number): void => {
		let list = map.get(key);
		if (!list) {
			list = [];
			map.set(key, list);
		}
		list.push(index);
	};
	for (let i = 0; i < count; i++) {
		const item = items[i]!;
		const freed = frees(item, keyOf);
		if (freed !== undefined) pushIndex(byFrees, freed, i);
		if (item.kind === "create") pushIndex(byCreate, keyOf(item.path), i);
		const target = fills(item, keyOf);
		if (target !== undefined) filledKeys.add(target);
	}
	const gitBuckets = new Map<string, { objects: number[]; meta: number[]; deletes: number[] }>();
	const metaDirByIndex = new Map<number, string>();
	for (let i = 0; i < count; i++) {
		const phased = gitPhaseOf(items[i]!, filledKeys, keyOf);
		if (!phased) continue;
		let bucket = gitBuckets.get(phased.dir);
		if (!bucket) {
			bucket = { objects: [], meta: [], deletes: [] };
			gitBuckets.set(phased.dir, bucket);
		}
		if (phased.phase === 1) bucket.objects.push(i);
		else if (phased.phase === 2) {
			bucket.meta.push(i);
			metaDirByIndex.set(i, phased.dir);
		} else bucket.deletes.push(i);
	}
	let barrierCount = 0;
	for (const bucket of gitBuckets.values()) {
		if (bucket.objects.length > 0 && (bucket.meta.length > 0 || bucket.deletes.length > 0)) barrierCount++;
		if (bucket.meta.length > 0 && bucket.deletes.length > 0) barrierCount++;
	}
	const total = count + barrierCount;
	const dependents: number[][] = Array.from({ length: total }, () => []);
	const inDegree = new Int32Array(total);
	for (let i = 0; i < count; i++) {
		const target = fills(items[i]!, keyOf);
		if (target === undefined) continue;
		const fromFrees = byFrees.get(target);
		const fromCreate = byCreate.get(keyOf(parentOf(target)));
		if (!fromFrees && !fromCreate) continue;
		let seen: Set<number> | undefined;
		const link = (other: number): void => {
			if (other === i) return;
			if (fromFrees && fromCreate) {
				if (!seen) seen = new Set();
				if (seen.has(other)) return;
				seen.add(other);
			}
			dependents[other]!.push(i);
			inDegree[i]!++;
		};
		if (fromFrees) for (const other of fromFrees) link(other);
		if (fromCreate) for (const other of fromCreate) link(other);
	}
	let nextBarrier = count;
	for (const bucket of gitBuckets.values()) {
		if (bucket.objects.length > 0 && (bucket.meta.length > 0 || bucket.deletes.length > 0)) {
			const barrier = nextBarrier++;
			for (const i of bucket.objects) {
				dependents[i]!.push(barrier);
				inDegree[barrier]!++;
			}
			const targets = bucket.meta.length > 0 ? bucket.meta : bucket.deletes;
			for (const j of targets) {
				dependents[barrier]!.push(j);
				inDegree[j]!++;
			}
		}
		if (bucket.meta.length > 0 && bucket.deletes.length > 0) {
			const barrier = nextBarrier++;
			for (const j of bucket.meta) {
				dependents[j]!.push(barrier);
				inDegree[barrier]!++;
			}
			for (const k of bucket.deletes) {
				dependents[barrier]!.push(k);
				inDegree[k]!++;
			}
		}
	}
	const order: Item[] = [];
	let wave: number[] = [];
	for (let i = 0; i < count; i++) if (inDegree[i] === 0) wave.push(i);
	const sortWave = (indices: number[]): void => {
		if (indices.length <= 1) return;
		if (metaDirByIndex.size === 0) indices.sort((a, b) => a - b);
		else
			indices.sort((a, b) => {
				const da = metaDirByIndex.get(a) ?? "";
				const db = metaDirByIndex.get(b) ?? "";
				return da < db ? -1 : da > db ? 1 : a - b;
			});
	};
	sortWave(wave);
	while (wave.length > 0) {
		const nextWave: number[] = [];
		const unlock = (node: number): void => {
			for (const dep of dependents[node]!) {
				const remaining = --inDegree[dep]!;
				if (remaining !== 0) continue;
				if (dep >= count) unlock(dep);
				else nextWave.push(dep);
			}
		};
		for (const i of wave) {
			order.push(items[i]!);
			unlock(i);
		}
		sortWave(nextWave);
		wave = nextWave;
	}
	if (order.length < count) {
		for (let i = 0; i < count; i++) {
			if (inDegree[i]! === 0) continue;
			for (const path of items[i]!.paths) {
				keep.add(path);
				waiting.push({ path, reason: "its changes wait on each other; they are published one at a time" });
			}
		}
	}
	return order;
}

function fitsNewFolder(under: readonly (Item & { kind: "create" | "new" | "link" })[]): boolean {
	if (under.length > MAX_NEW_FOLDER_ENTRIES) return false;
	let structuredFiles = 0;
	let structuredBytes = 0;
	for (const item of under) {
		if (item.kind !== "new" || !companyStatePath(item.path)) continue;
		structuredFiles++;
		structuredBytes += item.file.bytes;
		if (structuredFiles > MAX_COMMIT_STRUCTURED_FILES || structuredBytes > MAX_COMMIT_STRUCTURED_BYTES) return false;
	}
	return true;
}

function structuredCost(unit: CommitUnit): { readonly files: number; readonly bytes: number } {
	if (unit.op === "write")
		return companyStatePath(unit.path) ? { files: 1, bytes: unit.file.bytes } : { files: 0, bytes: 0 };
	if (unit.op !== "new_folder") return { files: 0, bytes: 0 };
	let files = 0;
	let bytes = 0;
	for (const entry of unit.contents) {
		if (!entry.file || !companyStatePath(`${unit.path}/${entry.path}`)) continue;
		files++;
		bytes += entry.file.bytes;
	}
	return { files, bytes };
}

export function planCommitBatches(
	units: readonly PlannedUnit[],
	limits?: CommitBatchLimits,
): readonly (readonly PlannedUnit[])[] {
	if (units.length === 0) return [];
	const maxUnits = Math.max(1, limits?.maxUnits ?? MAX_COMMIT_UNITS);
	const maxStructuredFiles = Math.max(1, limits?.maxStructuredFiles ?? MAX_COMMIT_STRUCTURED_FILES);
	const maxStructuredBytes = Math.max(1, limits?.maxStructuredBytes ?? MAX_COMMIT_STRUCTURED_BYTES);
	const costs = units.map((planned) => structuredCost(planned.unit));
	const metaSpan = new Map<string, { first: number; last: number }>();
	for (let i = 0; i < units.length; i++) {
		const dir = gitMetaDir(units[i]!.unit);
		if (dir === undefined) continue;
		const existing = metaSpan.get(dir);
		if (existing) existing.last = i;
		else metaSpan.set(dir, { first: i, last: i });
	}
	const spanEndAt = new Map<number, number>();
	for (const { first, last } of metaSpan.values()) {
		if (last <= first) continue;
		const prev = spanEndAt.get(first);
		if (prev === undefined || last > prev) spanEndAt.set(first, last);
	}
	const batches: PlannedUnit[][] = [];
	let current: PlannedUnit[] = [];
	let structuredFiles = 0;
	let structuredBytes = 0;
	const flush = (): void => {
		batches.push(current);
		current = [];
		structuredFiles = 0;
		structuredBytes = 0;
	};
	for (let i = 0; i < units.length; i++) {
		const planned = units[i]!;
		const spanEnd = spanEndAt.get(i);
		if (current.length > 0 && spanEnd !== undefined) {
			const spanUnits = spanEnd - i + 1;
			let spanFiles = 0;
			let spanBytes = 0;
			for (let j = i; j <= spanEnd; j++) {
				spanFiles += costs[j]!.files;
				spanBytes += costs[j]!.bytes;
			}
			const spanFits = spanUnits <= maxUnits && spanFiles <= maxStructuredFiles && spanBytes <= maxStructuredBytes;
			const spanOverflows =
				current.length + spanUnits > maxUnits ||
				structuredFiles + spanFiles > maxStructuredFiles ||
				structuredBytes + spanBytes > maxStructuredBytes;
			if (spanFits && spanOverflows) flush();
		}
		const cost = costs[i]!;
		const exceeds =
			current.length >= maxUnits ||
			structuredFiles + cost.files > maxStructuredFiles ||
			structuredBytes + cost.bytes > maxStructuredBytes;
		if (current.length > 0 && exceeds) flush();
		current.push(planned);
		structuredFiles += cost.files;
		structuredBytes += cost.bytes;
	}
	if (current.length > 0) batches.push(current);
	return batches.length === 1 ? [units] : batches;
}
