import { randomUUID } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { COMPANY_STATE_SEEDED_PATHS } from "@qorpera/cloud-client/company-state-files";
import { ErrorCode, ProtocolError, type WireEntry } from "./protocol.ts";
import { byteOrder, nameOf, parentOf, type TreeEntry, type ViewTree, wireEntry } from "./view-tree.ts";

/** The version-2 manifest's limits (C1D §2): chunks of at most 4 MiB, at most 64 of them. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 64 * CHUNK_BYTES;

/** A live entry a pending change starts from: where it is in the live folder, and the writer's base
 * (RUNTIME-FOLDER-WRITES.md, "Pending changes and base versions"). */
export interface LiveRef {
	readonly path: string;
	readonly kind: "file" | "folder";
	/** For a save, the version the machine last read; for a move or removal, the version the name showed then. */
	readonly version: string;
	/** A folder's: the view's feed position when it was moved or removed (the unit's `asOfSeq`). */
	readonly asOfSeq?: number;
	/** A file's live entry then: its manifest, for a new manifest over the same chunks (the executable bit). */
	readonly entry?: TreeEntry;
}

export interface ChunkRef {
	readonly sha256: string;
	readonly bytes: number;
}

/** A file's new bytes: chunks on the 4 MiB grid, every one on the storage server under the view's own intents. */
export interface Content {
	readonly chunks: readonly ChunkRef[];
	readonly size: number;
}

/** A sealed upload: what a write unit names (C1D §3). */
export interface FileRef {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

export interface PendingFile {
	readonly kind: "file";
	/** The live file it was opened, renamed or moved from; none for a new file. */
	origin: LiveRef | undefined;
	/** New bytes; none while its bytes are still the origin's (a rename, or only the executable bit). */
	content: Content | undefined;
	executable: boolean;
	/** The origin's media type; a new file's comes from its name when it is staged. */
	mediaType: string | undefined;
	/** Handles open for writing on it. A file open for writing is never published (§2 "Never published"). */
	open: number;
	/** The version the machine reads it at: the origin's while it has the origin's bytes and bit, else a new id at
	 * each change. */
	version: string;
	mtimeMs: number;
	/** The staged reference for `version`, once the service sealed it. */
	staged: { readonly version: string; readonly file: FileRef } | undefined;
}

export interface PendingFolder {
	readonly kind: "folder";
	/** The live folder it was moved or renamed from; none for a new folder. */
	origin: LiveRef | undefined;
	version: string;
	mtimeMs: number;
}

/** Hides a live path the view removed, or moved away. */
interface Gone {
	readonly kind: "gone";
}

type Node = PendingFile | PendingFolder | Gone;

/** What a path shows in this view: a pending node, or a live entry (inside a moved folder, through its origin). */
export type Resolved =
	| {
			readonly kind: "node";
			readonly path: string;
			readonly node: PendingFile | PendingFolder;
			/** The live folder whose children a moved folder shows; null for a new one, or a file. */
			readonly source: string | null;
	  }
	| { readonly kind: "live"; readonly path: string; readonly entry: TreeEntry; readonly source: string };

/** A change that cannot join what is pending in one change set without a unit needing a version the change set
 * itself makes, or one unit's failure losing another's work (RUNTIME-FOLDER-WRITES.md, "Changes that publish what is
 * pending first"). The service publishes what is pending, then makes the change again. */
export class PublishFirst extends Error {
	constructor(why: string) {
		super(why);
		this.name = "PublishFirst";
	}
}

/** Names a program uses for its own bookkeeping, published never (§2 "Never published"): lock, swap, backup and trash
 * files. They stay in this view, and go when it closes. */
export function neverPublished(name: string): boolean {
	return (
		/^\.~lock\..*#$/.test(name) ||
		name.startsWith("~$") ||
		name.endsWith(".swp") ||
		name.endsWith(".swo") ||
		name.startsWith(".#") ||
		name.endsWith("~") ||
		name.startsWith(".Trash-")
	);
}

/** A path in a place never published: a lock, swap, backup or trash name, or inside a trash folder. */
export function unpublished(path: string): boolean {
	return path.split("/").some(neverPublished);
}

const SEEDED = new Set<string>(COMPANY_STATE_SEEDED_PATHS);

/** The core's folding of a name or path (`qorpera_folder_key`): two paths that fold alike are one path. */
export function folderKey(path: string): string {
	return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

/** The core's reserved paths (`qorpera_folder_path_reserved`), by folded key. */
function reserved(key: string): boolean {
	const parts = key.split("/");
	return (
		[".qorpera", "trail", "inbox", "credentials", "secrets"].includes(parts[0]!) ||
		(parts[0] !== "code" && parts.some((p) => p === ".git" || p === "node_modules"))
	);
}

function join(parent: string, name: string): string {
	return parent === "" ? name : `${parent}/${name}`;
}

/** `path` is `folder` or below it. */
function within(path: string, folder: string): boolean {
	return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

function fail(code: ErrorCode, message: string): never {
	throw new ProtocolError(code, message);
}

/** A new name the folder accepts: the Company File's path rules (`EINVAL`), and not a reserved path (`EPERM`). */
function checkNewPath(path: string): void {
	try {
		parseCloudCompanyPath(path);
	} catch {
		fail(ErrorCode.badRequest, "The folder does not accept this name");
	}
	if (reserved(folderKey(path))) fail(ErrorCode.notPermitted, "This name is reserved");
}

/** Seeded paths, a lone `agent.md` or `group.md`, and agent and group folders may not go, or go elsewhere (§2,
 * contract 5.6). The core refuses them too; here the machine hears at once. */
function checkRemovable(path: string): void {
	const key = folderKey(path);
	if (SEEDED.has(key)) fail(ErrorCode.notPermitted, "A seeded path stays");
	if (/^agents\/[^/]+\/agent\.md$/.test(key) || /^agents\/groups\/[^/]+\/group\.md$/.test(key))
		fail(ErrorCode.notPermitted, "Remove the agent's or group's folder instead");
}

function checkMove(from: string, to: string): void {
	checkRemovable(from);
	const source = folderKey(from);
	const target = folderKey(to);
	const agent = (key: string) => /^agents\/[^/]+$/.test(key) && key !== "agents/groups";
	const group = (key: string) => /^agents\/groups\/[^/]+$/.test(key);
	if ((agent(source) && !agent(target)) || (group(source) && !group(target)))
		fail(ErrorCode.notPermitted, "An agent's or group's folder stays in its place");
}

/**
 * One view's pending changes over its live tree (RUNTIME-FOLDER-WRITES.md): what the view's own machine sees until a
 * boundary publishes them. Memory only.
 *
 * Pending nodes are keyed by the view's paths; a live path the view removed or moved away is hidden by a gone node,
 * and a moved folder shows its live origin's children. Every live entry the view removed is kept by its live path,
 * with its base. A change that would need what is pending published first throws `PublishFirst`, so that every
 * boundary is one change set whose units each name a live path as it is: no unit needs a version another makes, and
 * no unit's failure loses another's work. Outside a moved folder, the view's paths are the live paths.
 */
export class PendingView {
	readonly #live: () => ViewTree;
	readonly #seq: () => number;
	readonly #now: () => number;
	readonly #nodes = new Map<string, Node>();
	/** The names of nodes under each folder path. */
	readonly #children = new Map<string, Set<string>>();
	/** Live entries the view removed, by their live path. */
	readonly #removed = new Map<string, LiveRef>();
	/** Open handles: the file, whether this handle wrote, and the file as it was when the handle opened. */
	readonly #handles = new Map<
		number,
		{
			readonly node: PendingFile;
			dirty: boolean;
			readonly before: Pick<PendingFile, "content" | "version" | "staged" | "executable">;
		}
	>();
	#nextHandle = 1;

	constructor(live: () => ViewTree, seq: () => number, now: () => number = Date.now) {
		this.#live = live;
		this.#seq = seq;
		this.#now = now;
	}

	/** No pending change at all. */
	get empty(): boolean {
		return this.#nodes.size === 0 && this.#removed.size === 0;
	}

	/** What `path` shows in this view, or undefined when it is absent. */
	resolve(path: string): Resolved | undefined {
		if (path === "") return { kind: "live", path: "", entry: this.#live().get("")!, source: "" };
		let source: string | null = "";
		let at = "";
		for (const name of path.split("/")) {
			at = join(at, name);
			const last = at === path;
			const node = this.#nodes.get(at);
			if (node) {
				if (node.kind === "gone") return undefined;
				if (node.kind === "file") return last ? { kind: "node", path, node, source: null } : undefined;
				source = node.origin ? node.origin.path : null;
				if (last) return { kind: "node", path, node, source };
				continue;
			}
			if (source === null) return undefined;
			source = join(source, name);
			const entry = this.#live().get(source);
			if (!entry || this.#removed.has(source)) return undefined;
			if (last) return { kind: "live", path, entry, source };
			if (entry.kind !== "folder") return undefined;
		}
		return undefined;
	}

	/** The entry `path` shows, as a listing gives it. */
	get(path: string): TreeEntry | undefined {
		const r = this.resolve(path);
		if (!r) return undefined;
		if (r.kind === "live") return path === r.entry.path ? r.entry : { ...r.entry, path };
		const node = r.node;
		if (node.kind === "folder")
			return {
				path,
				kind: "folder",
				version: node.version,
				bytes: 0,
				executable: false,
				mtimeMs: node.mtimeMs,
				implicit: false,
			};
		const origin = node.origin?.entry;
		return {
			path,
			kind: "file",
			version: node.version,
			bytes: node.content ? node.content.size : (origin?.bytes ?? 0),
			executable: node.executable,
			mtimeMs: node.mtimeMs,
			implicit: false,
			...(node.mediaType ? { mediaType: node.mediaType } : {}),
		};
	}

	/** Where a read of `path` at `version` finds its bytes: the live entry it shows (its own version), or the pending
	 * chunks. Undefined when the path no longer shows that version. */
	source(path: string, version: string): { live: TreeEntry } | { content: Content } | undefined {
		const r = this.resolve(path);
		if (!r) return undefined;
		if (r.kind === "live")
			return r.entry.version === version && r.entry.kind === "file" ? { live: r.entry } : undefined;
		const node = r.node;
		if (node.kind !== "file" || node.version !== version) return undefined;
		if (node.content) return { content: node.content };
		return node.origin?.entry ? { live: node.origin.entry } : undefined;
	}

	/** One page of a folder's names, as `ViewTree.children` gives them. */
	children(path: string, after: string | undefined, limit: number) {
		const r = this.resolve(path);
		if (!r) return "not_found" as const;
		const folder = r.kind === "live" ? r.entry.kind === "folder" : r.node.kind === "folder";
		if (!folder) return "not_a_folder" as const;
		const names = new Set<string>();
		if (r.source !== null) for (const name of this.#live().names(r.source)) names.add(name);
		for (const name of this.#children.get(path) ?? []) names.add(name);
		const sorted = [...names].filter((n) => Buffer.byteLength(n) <= 255).sort(byteOrder);
		let start = 0;
		if (after !== undefined) while (start < sorted.length && byteOrder(sorted[start]!, after) <= 0) start++;
		const entries: WireEntry[] = [];
		let i = start;
		for (; i < sorted.length && entries.length < limit; i++) {
			const entry = this.get(join(path, sorted[i]!));
			if (entry) entries.push(wireEntry(entry));
		}
		return { entries, next: i < sorted.length ? sorted[i - 1]! : null };
	}

	/** Whether the folder at `path` shows any child. */
	#hasChildren(path: string): boolean {
		const r = this.resolve(path);
		if (!r) return false;
		if (r.source !== null)
			for (const name of this.#live().names(r.source)) if (this.resolve(join(path, name))) return true;
		for (const name of this.#children.get(path) ?? []) if (this.resolve(join(path, name))) return true;
		return false;
	}

	// ---- The rules that keep a boundary one change set -------------------------------------------------------------

	/** A folder above `path` (or `path` itself, with `self`) that the view moved from elsewhere. */
	#insideMoved(path: string, self = false): boolean {
		for (let p = self ? path : parentOf(path); p !== ""; p = parentOf(p)) {
			const node = this.#nodes.get(p);
			if (node?.kind === "folder" && node.origin) return true;
		}
		return false;
	}

	/** A path a live folder the view moved or removed left, at or above `path` (by folded key). */
	#freedFolder(path: string): boolean {
		const key = folderKey(path);
		const hit = (p: string): boolean => {
			const k = folderKey(p);
			return key === k || key.startsWith(`${k}/`);
		};
		for (const [p, ref] of this.#removed) if (ref.kind === "folder" && hit(p)) return true;
		for (const [p, node] of this.#nodes)
			if (node.kind === "gone" && hit(p) && this.#live().get(p)?.kind === "folder") return true;
		return false;
	}

	/** Moving the live entry at `origin` to `target` would close a cycle of moves (a swap, or a longer ring): the entry
	 * moved away from `target`, the one moved away from where that went, and so on, comes back to `origin`. */
	#cycle(origin: string, target: string): boolean {
		const home = folderKey(origin);
		let at = folderKey(target);
		const seen = new Set<string>();
		for (;;) {
			let next: string | undefined;
			for (const [p, node] of this.#nodes)
				if (node.kind !== "gone" && node.origin && folderKey(node.origin.path) === at && folderKey(p) !== at)
					next = p;
			if (next === undefined) return false;
			const key = folderKey(next);
			if (key === home) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			at = key;
		}
	}

	/** Pending changes at or below the live folder `path`: nodes below it, or entries moved out from below it. */
	#pendingBelow(path: string, live: string): boolean {
		for (const p of this.#nodes.keys()) if (p !== path && within(p, path)) return true;
		for (const node of this.#nodes.values())
			if (node.kind !== "gone" && node.origin && node.origin.path !== live && within(node.origin.path, live))
				return true;
		for (const p of this.#removed.keys()) if (p !== live && within(p, live)) return true;
		return false;
	}

	#movesOutBelow(live: string): boolean {
		for (const node of this.#nodes.values())
			if (node.kind !== "gone" && node.origin && node.origin.path !== live && within(node.origin.path, live))
				return true;
		return false;
	}

	/** A file the view moved here (its origin is another live path). */
	#moved(path: string, node: PendingFile | PendingFolder): boolean {
		return node.origin !== undefined && node.origin.path !== path;
	}

	// ---- Changes -------------------------------------------------------------------------------------------------

	/** Opens a file for writing (creating it when asked) and returns its handle. */
	openWrite(
		path: string,
		options: {
			readonly create: boolean;
			readonly exclusive: boolean;
			readonly truncate: boolean;
			readonly base?: string;
		},
	): { handle: number; size: number; version: string } {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		let node: PendingFile;
		if (!r) {
			if (!options.create) fail(ErrorCode.notFound, "No such file");
			this.#newName(path);
			node = this.#newFile();
			this.#set(path, node);
		} else {
			if (options.exclusive) fail(ErrorCode.exists, "The file exists");
			if (r.kind === "live") {
				if (r.entry.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
				node = this.#fromLive(r.entry, r.source, options.base);
				this.#set(path, node);
			} else {
				if (r.node.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
				if (this.#moved(path, r.node)) throw new PublishFirst("a change to a file this view moved");
				node = r.node;
			}
			if (options.truncate && (node.content === undefined || node.content.size > 0)) {
				node.content = { chunks: [], size: 0 };
				this.#changed(node);
			}
		}
		node.open++;
		const handle = this.#nextHandle++;
		const before = { content: node.content, version: node.version, staged: node.staged, executable: node.executable };
		this.#handles.set(handle, { node, dirty: false, before });
		return {
			handle,
			size: node.content ? node.content.size : (node.origin?.entry?.bytes ?? 0),
			version: node.version,
		};
	}

	/** The file a handle writes. */
	file(handle: number): PendingFile {
		const open = this.#handles.get(handle);
		if (!open) fail(ErrorCode.badRequest, "No such handle");
		return open.node;
	}

	/** The live entry whose chunks a handle's first chunk replaces one of, when the file still has its origin's bytes:
	 * the service reads its manifest and calls `beginContent` first. */
	originToCopy(handle: number): TreeEntry | undefined {
		const node = this.file(handle);
		return node.content === undefined ? node.origin?.entry : undefined;
	}

	/** The file's bytes become its own, starting from its origin's chunks. */
	beginContent(handle: number, originChunks: readonly ChunkRef[]): void {
		const node = this.file(handle);
		if (node.content !== undefined) return;
		node.content = { chunks: [...originChunks], size: node.origin?.entry?.bytes ?? 0 };
	}

	/** Chunk `index` of the file's bytes is now `chunk` (already on the storage server). */
	setChunk(handle: number, index: number, chunk: ChunkRef): void {
		const node = this.file(handle);
		if (node.content === undefined) fail(ErrorCode.badRequest, "The file's bytes were not started");
		if (!Number.isSafeInteger(index) || index < 0 || index >= 64) fail(ErrorCode.tooLarge, "The file is too large");
		if (chunk.bytes < 1 || chunk.bytes > CHUNK_BYTES) fail(ErrorCode.badRequest, "Bad chunk");
		const chunks = [...node.content.chunks];
		if (index > chunks.length) fail(ErrorCode.badRequest, "A chunk before this one is missing");
		chunks[index] = chunk;
		node.content = { chunks, size: node.content.size };
		node.mtimeMs = this.#now();
		this.#handles.get(handle)!.dirty = true;
	}

	/** The handle is closed at `size`. The chunks must tile the file, every one but the last exactly 4 MiB; until they
	 * do, the close is refused and the handle stays open. */
	close(handle: number, size: number): PendingFile {
		const open = this.#handles.get(handle);
		if (!open) fail(ErrorCode.badRequest, "No such handle");
		const node = open.node;
		if (node.content !== undefined) {
			if (!Number.isSafeInteger(size) || size < 0) fail(ErrorCode.badRequest, "Bad size");
			if (size > MAX_FILE_BYTES) fail(ErrorCode.tooLarge, "The file is too large");
			const count = Math.ceil(size / CHUNK_BYTES);
			const chunks = node.content.chunks.slice(0, count);
			if (
				chunks.length !== count ||
				chunks.some(
					(c, i) =>
						c === undefined || c.bytes !== (i < count - 1 ? CHUNK_BYTES : size - (count - 1) * CHUNK_BYTES),
				)
			)
				fail(ErrorCode.badRequest, "The file's chunks do not make up its size");
			const before = node.content;
			node.content = { chunks, size };
			if (open.dirty || before.size !== size || before.chunks.length !== chunks.length) this.#changed(node);
		}
		this.#handles.delete(handle);
		node.open--;
		return node;
	}

	/** The machine's connection ended with the handle still open: what this handle wrote is lost (founder decision 3),
	 * and the file is as it was when the handle opened (a truncate at open included). */
	abandon(handle: number): void {
		const open = this.#handles.get(handle);
		if (!open) return;
		this.#handles.delete(handle);
		open.node.open--;
		Object.assign(open.node, open.before);
	}

	mkdir(path: string): void {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		if (this.resolve(path)) fail(ErrorCode.exists, "The path exists");
		this.#newName(path);
		this.#set(path, { kind: "folder", origin: undefined, version: randomUUID(), mtimeMs: this.#now() });
	}

	unlink(path: string, base?: string): void {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such file");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) === "folder") fail(ErrorCode.notAFile, "Not a file");
		checkRemovable(path);
		this.#remove(r, base);
	}

	rmdir(path: string, base?: string): void {
		if (path === "") fail(ErrorCode.notPermitted, "The folder's root stays");
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such folder");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) !== "folder") fail(ErrorCode.notAFolder, "Not a folder");
		checkRemovable(path);
		if (this.#hasChildren(path)) fail(ErrorCode.notEmpty, "The folder is not empty");
		// What moved out of it publishes first: its removal must not be able to take them if their moves fail.
		if (r.kind === "live" && this.#movesOutBelow(r.source))
			throw new PublishFirst("removing a folder something was moved out of");
		this.#remove(r, base);
	}

	/** rename(2): `to` is replaced when it exists, unless `noReplace`. */
	rename(
		from: string,
		to: string,
		options: { readonly noReplace: boolean; readonly fromBase?: string; readonly toBase?: string } = {
			noReplace: false,
		},
	): void {
		if (from === to) return;
		if (from === "" || to === "") fail(ErrorCode.notPermitted, "The folder's root stays");
		if (this.#insideMoved(from) || this.#insideMoved(to))
			throw new PublishFirst("a change inside a folder this view moved");
		const source = this.resolve(from);
		if (!source) fail(ErrorCode.notFound, "No such path");
		const kind = source.kind === "live" ? source.entry.kind : source.node.kind;
		if (kind === "folder" && within(folderKey(to), folderKey(from)))
			fail(ErrorCode.badRequest, "A folder cannot go inside itself");
		const parent = this.resolve(parentOf(to));
		if (!parent || (parent.kind === "live" ? parent.entry.kind : parent.node.kind) !== "folder")
			fail(ErrorCode.notFound, "No such folder");
		checkMove(from, to);
		const live = source.kind === "live" || source.node.origin !== undefined;
		// A live entry's move is published as one: it never goes where nothing is published.
		if (live && unpublished(to)) fail(ErrorCode.notHere, "A published path cannot go where nothing is published");
		if (source.kind === "node" && source.node.kind === "file" && source.node.origin && source.node.content)
			throw new PublishFirst("moving a file this view changed");
		if (source.kind === "live" && source.entry.kind === "folder" && this.#pendingBelow(from, source.source))
			throw new PublishFirst("moving a folder with changes inside it");
		const target = this.resolve(to);
		if (target) {
			if (options.noReplace) fail(ErrorCode.exists, "The path exists");
			const targetKind = target.kind === "live" ? target.entry.kind : target.node.kind;
			if (kind === "file" && targetKind === "folder") fail(ErrorCode.notAFile, "Not a file");
			if (kind === "folder" && targetKind === "file") fail(ErrorCode.notAFolder, "Not a folder");
			if (targetKind === "folder" && this.#hasChildren(to)) fail(ErrorCode.notEmpty, "The folder is not empty");
			checkRemovable(to);
			if (target.kind === "live" && target.entry.kind === "folder" && this.#pendingBelow(to, target.source))
				throw new PublishFirst("replacing a folder with changes inside it");
		} else {
			if (folderKey(from) !== folderKey(to)) this.#newName(to);
			if (this.#freedFolder(to)) throw new PublishFirst("reusing a path a folder this view moved or removed left");
			// Moves that take each other's places (a swap, a ring) publish one at a time.
			const origin = source.kind === "live" ? source.source : source.node.origin?.path;
			if (origin !== undefined && this.#cycle(origin, to))
				throw new PublishFirst("moves that take each other's places");
		}
		// The moving node: a pending one as it is, or one made from the live entry, at the writer's base.
		let node: PendingFile | PendingFolder;
		if (source.kind === "node") node = source.node;
		else if (source.entry.kind === "file") node = this.#fromLive(source.entry, source.source, options.fromBase);
		else
			node = {
				kind: "folder",
				origin: {
					path: source.source,
					kind: "folder",
					version: options.fromBase ?? source.entry.version,
					asOfSeq: this.#seq(),
				},
				version: source.entry.version,
				mtimeMs: source.entry.mtimeMs,
			};
		if (target) this.#remove(target, options.toBase);
		// A new folder's pending nodes move with it; then `from` is hidden if the live folder still shows something.
		const moved: [string, Node][] = [];
		for (const [path, n] of this.#nodes) if (path !== from && within(path, from)) moved.push([path, n]);
		for (const [path] of moved) this.#unset(path);
		this.#unset(from);
		this.#hide(from);
		this.#dropUnder(to);
		this.#set(to, node);
		for (const [path, n] of moved) this.#set(to + path.slice(from.length), n);
		node.mtimeMs = this.#now();
	}

	/** chmod: only the executable bit is kept. */
	setExecutable(path: string, executable: boolean, base?: string): void {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such file");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) === "folder") return;
		if (r.kind === "live" && r.entry.executable === executable) return;
		if (r.kind === "node" && this.#moved(path, r.node)) throw new PublishFirst("a change to a file this view moved");
		const node = r.kind === "node" ? (r.node as PendingFile) : this.#fromLive(r.entry, r.source, base);
		if (r.kind === "live") this.#set(path, node);
		if (node.executable === executable) return;
		node.executable = executable;
		this.#changed(node);
	}

	/** The feed changed these live paths. A removal whose live entry changed since is dropped, so the view shows the
	 * newer version again: a removal never takes a version the machine did not see. (A subtree removal or a move
	 * refuses changes it did not see by its `asOfSeq`; a save conflicts by its base.) */
	liveChanged(paths: readonly string[]): void {
		for (const path of paths) {
			const removed = this.#removed.get(path);
			if (!removed || removed.kind !== "file") continue;
			if (this.#live().get(path)?.version === removed.version) continue;
			this.#removed.delete(path);
			if (this.#nodes.get(path)?.kind === "gone") this.#unset(path);
		}
	}

	// ---- Inside ----------------------------------------------------------------------------------------------------

	/** A new name in an existing folder: allowed, and not a sibling's spelled otherwise (`EEXIST`); a path a moved or
	 * removed live folder left publishes what is pending first. */
	#newName(path: string): void {
		const parent = this.resolve(parentOf(path));
		if (!parent) fail(ErrorCode.notFound, "No such folder");
		if ((parent.kind === "live" ? parent.entry.kind : parent.node.kind) !== "folder")
			fail(ErrorCode.notAFolder, "Not a folder");
		checkNewPath(path);
		const key = folderKey(nameOf(path));
		const names = new Set<string>(this.#children.get(parentOf(path)) ?? []);
		if (parent.source !== null) for (const name of this.#live().names(parent.source)) names.add(name);
		for (const name of names)
			if (name !== nameOf(path) && folderKey(name) === key && this.resolve(join(parentOf(path), name)))
				fail(ErrorCode.exists, "A path differing only in case exists");
		if (this.#freedFolder(path)) throw new PublishFirst("reusing a path a folder this view moved or removed left");
	}

	#newFile(): PendingFile {
		return {
			kind: "file",
			origin: undefined,
			content: { chunks: [], size: 0 },
			executable: false,
			mediaType: undefined,
			open: 0,
			version: randomUUID(),
			mtimeMs: this.#now(),
			staged: undefined,
		};
	}

	#fromLive(entry: TreeEntry, source: string, base: string | undefined): PendingFile {
		return {
			kind: "file",
			origin: { path: source, kind: "file", version: base ?? entry.version, entry },
			content: undefined,
			executable: entry.executable,
			mediaType: entry.mediaType,
			open: 0,
			version: entry.version,
			mtimeMs: entry.mtimeMs,
			staged: undefined,
		};
	}

	#changed(node: PendingFile): void {
		node.version = randomUUID();
		node.staged = undefined;
		node.mtimeMs = this.#now();
	}

	/** Takes whatever `path` shows out of the view: a live entry is recorded as removed at the writer's base, a pending
	 * one's origin with it. */
	#remove(r: Resolved, base: string | undefined): void {
		if (r.kind === "live") {
			this.#removed.set(r.source, {
				path: r.source,
				kind: r.entry.kind,
				version: base ?? r.entry.version,
				...(r.entry.kind === "folder" ? { asOfSeq: this.#seq() } : { entry: r.entry }),
			});
		} else {
			const origin = r.node.origin;
			if (origin)
				this.#removed.set(origin.path, origin.kind === "folder" ? { ...origin, asOfSeq: this.#seq() } : origin);
			this.#dropUnder(r.path);
			this.#unset(r.path);
		}
		this.#hide(r.path);
	}

	/** Nodes left under a path that now holds something else hide nothing there. */
	#dropUnder(path: string): void {
		for (const key of [...this.#nodes.keys()]) if (key !== path && within(key, path)) this.#unset(key);
	}

	/** A path the live folder would still show something at gets a gone node. */
	#hide(path: string): void {
		if (this.resolve(path)) this.#set(path, { kind: "gone" });
	}

	#set(path: string, node: Node): void {
		this.#nodes.set(path, node);
		const parent = parentOf(path);
		let names = this.#children.get(parent);
		if (!names) {
			names = new Set();
			this.#children.set(parent, names);
		}
		names.add(nameOf(path));
	}

	#unset(path: string): void {
		if (!this.#nodes.delete(path)) return;
		const parent = parentOf(path);
		const names = this.#children.get(parent);
		if (names?.delete(nameOf(path)) && names.size === 0) this.#children.delete(parent);
	}

	// ---- What a boundary publishes ------------------------------------------------------------------------------

	/** Every pending node, by path. */
	nodes(): ReadonlyMap<string, PendingFile | PendingFolder | { readonly kind: "gone" }> {
		return this.#nodes;
	}

	/** Live entries the view removed, by live path. */
	removed(): ReadonlyMap<string, LiveRef> {
		return this.#removed;
	}

	/** After a boundary: the view shows the live folder again, except the nodes the boundary keeps (`keep`: files
	 * still open, names never published, and new bytes the core did not save). Every removal and move was published
	 * (saved, or failed losing nothing), so the gone nodes go too. */
	settle(keep: ReadonlySet<string>): void {
		for (const path of [...this.#nodes.keys()]) if (!keep.has(path)) this.#unset(path);
		this.#removed.clear();
	}

	/** Forgets everything (the view closed). Open handles stay valid but detached. */
	clear(): void {
		this.#nodes.clear();
		this.#children.clear();
		this.#removed.clear();
	}
}
