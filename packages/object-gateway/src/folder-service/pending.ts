import { randomUUID } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { COMPANY_STATE_SEEDED_PATHS } from "@qorpera/cloud-client/company-state-files";
import type { WireEntry } from "./protocol.ts";
import { ErrorCode, ProtocolError } from "./protocol.ts";
import { byteOrder, nameOf, parentOf, type TreeEntry, type ViewTree, wireEntry } from "./view-tree.ts";

/** The version-2 manifest's limits (C1D §2): chunks of at most 4 MiB, at most 64 of them. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 64 * CHUNK_BYTES;

/** A live entry a pending change starts from: where it was in the live folder (before any of the view's own moves),
 * and the writer's base (RUNTIME-FOLDER-WRITES.md, "Pending changes and base versions"). */
export interface LiveRef {
	readonly path: string;
	readonly kind: "file" | "folder";
	/** The version the machine last read of it, else the version the view showed when the change began. */
	readonly version: string;
	/** A folder's: the view's feed position when it was first moved or removed (the unit's `asOfSeq`). */
	readonly asOfSeq?: number;
	/** A file's live entry then: its manifest, for a rename's or a bit's new manifest over the same chunks. */
	readonly entry?: TreeEntry;
	/** Where the view showed it when it was removed (for the report). */
	readonly shown?: string;
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

/** Hides a live path the view removed, or moved away (a merged path only). */
interface Gone {
	readonly kind: "gone";
}

type Node = PendingFile | PendingFolder | Gone;

/** What a path shows in the view: a pending node, or a live entry reached through the view's own moves. */
export type Resolved =
	| {
			readonly kind: "node";
			readonly path: string;
			readonly node: PendingFile | PendingFolder;
			/** The live folder whose children a moved folder shows; null for a new one, or a file. */
			readonly source: string | null;
	  }
	| { readonly kind: "live"; readonly path: string; readonly entry: TreeEntry; readonly source: string };

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

/** Top-level names only the folder program may use, and `node_modules` anywhere outside code areas (§2). */
const ADAPTER_ONLY = new Set([".qorpera", ".git", "trail", "inbox", "credentials", "secrets"]);

const SEEDED = new Set<string>(COMPANY_STATE_SEEDED_PATHS);

/** The core's folding of a name or path (`qorpera_folder_key`): two names that fold alike are one path. */
export function folderKey(path: string): string {
	return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

function join(parent: string, name: string): string {
	return parent === "" ? name : `${parent}/${name}`;
}

function under(path: string, folder: string): boolean {
	return folder === "" || path === folder || path.startsWith(`${folder}/`);
}

function fail(code: ErrorCode, message: string): never {
	throw new ProtocolError(code, message);
}

/** A new name the folder accepts (`EINVAL` otherwise): the Company File's path rules, and nothing only the folder
 * program may use. */
function checkNewPath(path: string): void {
	try {
		parseCloudCompanyPath(path);
	} catch {
		fail(ErrorCode.badRequest, "The folder does not accept this name");
	}
	const parts = path.split("/");
	if (ADAPTER_ONLY.has(folderKey(parts[0]!)) || (parts[0] !== "code" && parts.some((p) => p === "node_modules")))
		fail(ErrorCode.notPermitted, "This name is the folder program's own");
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
 * boundary publishes them. Memory only. Paths here are the view's own (merged) paths; a pending node keyed by its
 * path, a removed live path hidden by a gone node, a moved folder showing its live origin's children. Every live
 * entry the view removed is kept by its live path in `#removed`, with its base.
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
	readonly #handles = new Map<number, { readonly node: PendingFile; dirty: boolean }>();
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
		const r = this.resolve(path);
		let node: PendingFile;
		if (!r) {
			if (!options.create) fail(ErrorCode.notFound, "No such file");
			this.#newName(path);
			node = this.#newFile();
			this.#dropUnder(path);
			this.#set(path, node);
		} else {
			if (options.exclusive) fail(ErrorCode.exists, "The file exists");
			if (r.kind === "live") {
				if (r.entry.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
				node = this.#fromLive(r.entry, r.source, options.base);
				this.#set(path, node);
			} else {
				if (r.node.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
				node = r.node;
			}
			if (options.truncate && (node.content === undefined || node.content.size > 0)) {
				node.content = { chunks: [], size: 0 };
				this.#changed(node);
			}
		}
		node.open++;
		const handle = this.#nextHandle++;
		this.#handles.set(handle, { node, dirty: false });
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

	/** The handle is closed at `size`. The chunks must tile the file: every one but the last exactly 4 MiB. */
	close(handle: number, size: number): PendingFile {
		const node = this.file(handle);
		const dirty = this.#handles.get(handle)!.dirty;
		this.#handles.delete(handle);
		node.open--;
		if (node.content === undefined) return node;
		if (!Number.isSafeInteger(size) || size < 0) fail(ErrorCode.badRequest, "Bad size");
		if (size > MAX_FILE_BYTES) fail(ErrorCode.tooLarge, "The file is too large");
		const count = Math.ceil(size / CHUNK_BYTES);
		const chunks = node.content.chunks.slice(0, count);
		if (
			chunks.length !== count ||
			chunks.some(
				(c, i) => c === undefined || c.bytes !== (i < count - 1 ? CHUNK_BYTES : size - (count - 1) * CHUNK_BYTES),
			)
		)
			fail(ErrorCode.badRequest, "The file's chunks do not make up its size");
		const before = node.content;
		node.content = { chunks, size };
		if (dirty || before.size !== size || before.chunks.length !== chunks.length) this.#changed(node);
		return node;
	}

	mkdir(path: string): void {
		if (this.resolve(path)) fail(ErrorCode.exists, "The path exists");
		this.#newName(path);
		this.#dropUnder(path);
		this.#set(path, { kind: "folder", origin: undefined, version: randomUUID(), mtimeMs: this.#now() });
	}

	unlink(path: string, base?: string): void {
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such file");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) === "folder") fail(ErrorCode.notAFile, "Not a file");
		checkRemovable(path);
		this.#remove(r, base);
	}

	rmdir(path: string, base?: string): void {
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such folder");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) !== "folder") fail(ErrorCode.notAFolder, "Not a folder");
		if (path === "") fail(ErrorCode.notPermitted, "The folder's root stays");
		checkRemovable(path);
		if (this.#hasChildren(path)) fail(ErrorCode.notEmpty, "The folder is not empty");
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
		const source = this.resolve(from);
		if (!source) fail(ErrorCode.notFound, "No such path");
		if (from === "" || to === "") fail(ErrorCode.notPermitted, "The folder's root stays");
		const kind = source.kind === "live" ? source.entry.kind : source.node.kind;
		if (kind === "folder" && under(to, from)) fail(ErrorCode.badRequest, "A folder cannot go inside itself");
		const parent = this.resolve(parentOf(to));
		if (!parent || (parent.kind === "live" ? parent.entry.kind : parent.node.kind) !== "folder")
			fail(ErrorCode.notFound, "No such folder");
		checkMove(from, to);
		const target = this.resolve(to);
		if (target) {
			if (options.noReplace) fail(ErrorCode.exists, "The path exists");
			const targetKind = target.kind === "live" ? target.entry.kind : target.node.kind;
			if (kind === "file" && targetKind === "folder") fail(ErrorCode.notAFile, "Not a file");
			if (kind === "folder" && targetKind === "file") fail(ErrorCode.notAFolder, "Not a folder");
			if (targetKind === "folder" && this.#hasChildren(to)) fail(ErrorCode.notEmpty, "The folder is not empty");
			checkRemovable(to);
		} else if (folderKey(from) !== folderKey(to)) this.#newName(to);
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
		// The nodes under `from` move with it; then `from` is hidden if the live folder still shows something there.
		const moved: [string, Node][] = [];
		for (const [path, n] of this.#nodes) if (path !== from && under(path, from)) moved.push([path, n]);
		for (const [path] of moved) this.#unset(path);
		this.#unset(from);
		this.#hide(from);
		this.#set(to, node);
		for (const [path, n] of moved) this.#set(to + path.slice(from.length), n);
		node.mtimeMs = this.#now();
	}

	/** chmod: only the executable bit is kept. */
	setExecutable(path: string, executable: boolean, base?: string): void {
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such file");
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) === "folder") return;
		if (r.kind === "live" && r.entry.executable === executable) return;
		const node = r.kind === "node" ? (r.node as PendingFile) : this.#fromLive(r.entry, r.source, base);
		if (r.kind === "live") this.#set(path, node);
		if (node.executable === executable) return;
		node.executable = executable;
		this.#changed(node);
	}

	// ---- Inside ----------------------------------------------------------------------------------------------------

	/** A new name in an existing folder: allowed, and not a sibling's spelled otherwise (`EEXIST`). */
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
				shown: r.path,
				...(r.entry.kind === "folder" ? { asOfSeq: this.#seq() } : { entry: r.entry }),
			});
		} else {
			const origin = r.node.origin;
			if (origin) {
				const asOf = origin.kind === "folder" ? { asOfSeq: origin.asOfSeq ?? this.#seq() } : {};
				this.#removed.set(origin.path, { ...origin, ...asOf, shown: r.path });
			}
			for (const [path] of [...this.#nodes]) if (path !== r.path && under(path, r.path)) this.#unset(path);
			this.#unset(r.path);
		}
		this.#hide(r.path);
	}

	/** A new path where a removed folder was: the gone nodes left under it hide nothing now. */
	#dropUnder(path: string): void {
		for (const key of [...this.#nodes.keys()]) if (key !== path && under(key, path)) this.#unset(key);
	}

	/** A merged path the live folder would still show something at gets a gone node. */
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

	/** Every pending node, by path (for planning and tests). */
	nodes(): ReadonlyMap<string, PendingFile | PendingFolder | { readonly kind: "gone" }> {
		return this.#nodes;
	}

	/** Live entries the view removed, by live path. */
	removed(): ReadonlyMap<string, LiveRef> {
		return this.#removed;
	}

	/** The live path `path` stands for before any of the view's moves: through the nearest moved folder above it. */
	livePath(path: string): string {
		let at = path;
		const rest: string[] = [];
		for (;;) {
			const node = this.#nodes.get(at);
			if (node?.kind === "folder" && node.origin)
				return [node.origin.path, ...rest.reverse()].filter((p) => p !== "").join("/");
			if (at === "") return [...rest.reverse()].join("/");
			rest.push(nameOf(at));
			at = parentOf(at);
		}
	}

	/** After a boundary: the view shows the live folder again, except the nodes a boundary leaves pending (`keep`:
	 * files still open for writing, and names never published). Every removal was published, and no node kept hides a
	 * live path, so the gone nodes go too. */
	settle(keep: ReadonlySet<string>): void {
		for (const path of [...this.#nodes.keys()]) if (!keep.has(path)) this.#unset(path);
		this.#removed.clear();
	}

	/** Forgets everything (the view closed, or the service lost its state). Open handles stay valid but detached. */
	clear(): void {
		this.#nodes.clear();
		this.#children.clear();
		this.#removed.clear();
	}
}
