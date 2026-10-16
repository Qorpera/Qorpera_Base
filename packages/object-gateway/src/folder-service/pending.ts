import { randomUUID } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { COMPANY_STATE_SEEDED_PATHS } from "@qorpera/cloud-client/company-state-files";
import { folderKey } from "@qorpera/contracts";
import { gitRefused, gitSharedPath, gitUnpublished } from "./git.ts";
import { ErrorCode, ProtocolError, type WireEntry } from "./protocol.ts";
import { byteOrder, nameOf, parentOf, type TreeEntry, type ViewTree, wireEntry } from "./view-tree.ts";

/** The version-2 manifest's limits (C1D §2): chunks of at most 4 MiB, at most 64 of them. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 64 * CHUNK_BYTES;

/** A live entry a pending change starts from: where it is in the live folder, and the writer's base
 * (RUNTIME-FOLDER-WRITES.md, "Pending changes and base versions"). */
export interface LiveRef {
	readonly path: string;
	readonly kind: "file" | "folder" | "symlink";
	/** For a save, the version the machine last read; for a move or removal, the version the name showed then. */
	readonly version: string;
	/** A folder's: the view's feed position when it was moved or removed (the unit's `asOfSeq`). */
	readonly asOfSeq?: number;
	/** A file's or link's live entry then: a file's manifest, for a new manifest over the same chunks (the executable
	 * bit); a link's target. */
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
	/** A new file's: the live file or link it replaces, at the writer's base (`PendingView`, "A new file or link that
	 * replaces a live one"). */
	replaces: LiveRef | undefined;
	/** New bytes; none while its bytes are still the origin's (a rename, or only the executable bit), or the live
	 * version's a hard link copied (`copyOf`). */
	content: Content | undefined;
	/** A hard link's new name, made from a live file's version (`J`): a new file whose bytes are still that version's,
	 * none sent or stored again. */
	copyOf: TreeEntry | undefined;
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

/** A symbolic link (protocol 4): its target, as written. A link is never changed in place, only made, moved or
 * removed. */
export interface PendingLink {
	readonly kind: "symlink";
	/** The live link it was renamed or moved from; none for a new link. */
	origin: LiveRef | undefined;
	/** A new link's: the live file or link it replaces, at the writer's base (`ln -sf`). */
	replaces: LiveRef | undefined;
	readonly target: string;
	version: string;
	mtimeMs: number;
}

/** Hides a live path the view removed, or moved away. */
interface Gone {
	readonly kind: "gone";
}

type Node = PendingFile | PendingFolder | PendingLink | Gone;

/** Where a read finds a path's bytes (`PendingView.source`). */
export type Source =
	| { readonly live: TreeEntry }
	| { readonly content: Content }
	| { readonly target: string; readonly live: TreeEntry | undefined };

/** Where a draft's close lands it, and the view's own file there that its open holds unpublished, if any (the
 * draft's file carries what else the open saw: the live file at the open's base, or none). */
interface Draft {
	readonly path: string;
	readonly held?: PendingFile;
	/** The live file this view took away there (removed or moved it), before the draft's open or since, until a
	 * boundary publishes that. If the boundary lets it go (the move fails, the removal is refused), so the path shows
	 * that file again, the draft lands against it (`settle`). */
	took?: LiveRef;
}

/** What a path shows in this view: a pending node, or a live entry (inside a moved folder, through its origin). */
export type Resolved =
	| {
			readonly kind: "node";
			readonly path: string;
			readonly node: PendingFile | PendingFolder | PendingLink;
			/** The live folder whose children a moved folder shows; null for a new one, a file or a link. */
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

/** A path in a place never published: a lock, swap, backup or trash name, or inside a trash folder; in a git
 * directory, what git has not finished, and its shared files, which only their lease publishes (git.ts). */
export function unpublished(path: string): boolean {
	return path.split("/").some(neverPublished) || gitUnpublished(path) || gitSharedPath(path);
}

const SEEDED = new Set<string>(COMPANY_STATE_SEEDED_PATHS);

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
function checkNewPath(path: string, codeHost: boolean): void {
	try {
		parseCloudCompanyPath(path);
	} catch {
		fail(ErrorCode.badRequest, "The folder does not accept this name");
	}
	if (reserved(folderKey(path))) fail(ErrorCode.notPermitted, "This name is reserved");
	if (gitRefused(path, codeHost)) fail(ErrorCode.notPermitted, "Git keeps this file on the machine, or refuses it");
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
 * and a moved folder shows its live origin's children. A new file or link that replaces a live file or link (an
 * editor's save through a temporary file, `ln -sf`, or one made where the view removed one) holds that one's base
 * itself (`replaces`) until it is published or goes: no other change, at that path in any case, moves it. Every other
 * live entry the view removed is kept by its live path, with its base, as a removal of its own. A change that would
 * need what is pending published first throws `PublishFirst`, so that every boundary is one change set whose units
 * each name a live path as it is: no unit needs a version another makes, and no unit's failure loses another's work.
 * Outside a moved folder, the view's paths are the live paths.
 */
export class PendingView {
	#live: () => ViewTree;
	#seq: () => number;
	readonly #now: () => number;
	readonly #nodes = new Map<string, Node>();
	/** The names of nodes under each folder path. */
	readonly #children = new Map<string, Set<string>>();
	/** Live entries the view removed, by their live path. */
	readonly #removed = new Map<string, LiveRef>();
	/** Open handles, and the file each writes; a draft's is in the view only once its close lands it (`openWrite`). */
	readonly #handles = new Map<number, { readonly node: PendingFile; readonly draft?: Draft }>();
	/** Files with chunks written, through any handle, since their state was last fixed. */
	readonly #unfixed = new WeakSet<PendingFile>();
	/** Each file open for writing as its last close (or its open, a truncate included) fixed it: what an abandoned
	 * handle goes back to. Writes no close fixed are not in it. */
	readonly #fixed = new WeakMap<PendingFile, Pick<PendingFile, "content" | "version" | "staged" | "executable">>();
	#nextHandle = 1;
	readonly #codeHost: boolean;

	/** `codeHost`: the code host's view, which writes git's session-local files too (git.ts `gitRefused`). */
	constructor(live: () => ViewTree, seq: () => number, now: () => number = Date.now, codeHost = false) {
		this.#live = live;
		this.#seq = seq;
		this.#now = now;
		this.#codeHost = codeHost;
	}

	/** The service atomically moves this overlay, including open handles, onto a successor desktop's live tree. */
	rebind(live: () => ViewTree, seq: () => number): void {
		this.#live = live;
		this.#seq = seq;
		// A sealed reference proves possession only for the actor that sealed it. The successor must stage again,
		// including a last-fixed save that an abandoned reopened handle can restore. Bytes and versions stay intact;
		// the service retains their old intents and any unanswered commit's original actor and exact units.
		const files = new Set<PendingFile>();
		for (const node of this.#nodes.values()) if (node.kind === "file") files.add(node);
		for (const { node } of this.#handles.values()) files.add(node);
		for (const node of files) {
			node.staged = undefined;
			const fixed = this.#fixed.get(node);
			if (fixed) this.#fixed.set(node, { ...fixed, staged: undefined });
		}
	}

	/** The files open drafts write, which are at no path until their close lands them. */
	drafts(): PendingFile[] {
		return [...this.#handles.values()].flatMap((open) => (open.draft ? [open.node] : []));
	}

	/** No pending change at all. */
	get empty(): boolean {
		return this.#nodes.size === 0 && this.#removed.size === 0;
	}

	/** Some change a boundary publishes, or waits to: a removal, or a new, moved or changed file or folder. Names never
	 * published (they stay until the view closes) and files opened but not changed are no unsaved work. */
	get unsaved(): boolean {
		if (this.#removed.size > 0) return true;
		for (const [path, node] of this.#nodes) {
			if (node.kind === "gone" || unpublished(path)) continue;
			const origin = node.origin;
			if (!origin || origin.path !== path) return true;
			if (node.kind === "file" && (node.content !== undefined || node.executable !== origin.entry?.executable))
				return true;
		}
		return false;
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
				// Nothing is below a file, and a path through a link is absent: a link is never followed.
				if (node.kind === "file" || node.kind === "symlink")
					return last ? { kind: "node", path, node, source: null } : undefined;
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
		if (node.kind === "symlink")
			return {
				path,
				kind: "symlink",
				version: node.version,
				bytes: Buffer.byteLength(node.target),
				executable: false,
				mtimeMs: node.mtimeMs,
				implicit: false,
				target: node.target,
			};
		const origin = node.origin?.entry ?? node.copyOf;
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

	/** Where a read of `path` at `version` finds its bytes: the live entry it shows (its own version), the pending
	 * chunks, or a link's target (with the live link it shows, if any). Undefined when the path no longer shows that
	 * version. */
	source(path: string, version: string): Source | undefined {
		const r = this.resolve(path);
		if (!r) return undefined;
		if (r.kind === "live") {
			if (r.entry.version !== version) return undefined;
			if (r.entry.kind === "symlink") return { target: r.entry.target!, live: r.entry };
			return r.entry.kind === "file" ? { live: r.entry } : undefined;
		}
		const node = r.node;
		if (node.kind === "folder" || node.version !== version) return undefined;
		if (node.kind === "symlink") return { target: node.target, live: node.origin?.entry };
		if (node.content) return { content: node.content };
		const origin = node.origin?.entry ?? node.copyOf;
		return origin ? { live: origin } : undefined;
	}

	/** One page of a folder's names, as `ViewTree.children` gives them; links only when `links` (protocol 4). */
	children(path: string, after: string | undefined, limit: number, links = true) {
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
			if (entry && (links || entry.kind !== "symlink")) entries.push(wireEntry(entry));
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

	/** Pending changes at or below the live folder `path`: nodes below it, or entries moved out from below it. By folded
	 * key: a change made under the folder before another machine renamed it only in case is below it in the core. */
	#pendingBelow(path: string, live: string): boolean {
		const key = folderKey(path);
		const liveKey = folderKey(live);
		for (const p of this.#nodes.keys()) if (p !== path && within(folderKey(p), key)) return true;
		for (const node of this.#nodes.values())
			if (
				node.kind !== "gone" &&
				node.origin &&
				node.origin.path !== live &&
				within(folderKey(node.origin.path), liveKey)
			)
				return true;
		for (const p of this.#removed.keys()) if (p !== live && within(folderKey(p), liveKey)) return true;
		return false;
	}

	/** A pending file, link or folder below the folder `path` by folded key. One made in it before another machine
	 * renamed it only in case does not show in it, but in the core it is in it. A name never published is no unit. */
	#hiddenBelow(path: string): boolean {
		const key = folderKey(path);
		for (const [p, node] of this.#nodes)
			if (node.kind !== "gone" && !unpublished(p) && folderKey(p).startsWith(`${key}/`)) return true;
		return false;
	}

	#movesOutBelow(live: string): boolean {
		for (const node of this.#nodes.values())
			if (node.kind !== "gone" && node.origin && node.origin.path !== live && within(node.origin.path, live))
				return true;
		return false;
	}

	/** A file the view moved here (its origin is another live path). */
	#moved(path: string, node: PendingFile | PendingFolder | PendingLink): boolean {
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
			readonly draft?: boolean;
		},
	): { handle: number; size: number; version: string } {
		if (options.draft) return this.#openDraft(path, options);
		const node = this.#writable(path, options);
		if (options.truncate && (node.content === undefined || node.content.size > 0)) {
			node.content = { chunks: [], size: 0 };
			this.#changed(node);
			this.#fix(node);
		}
		if (node.open === 0) this.#fix(node);
		node.open++;
		const handle = this.#nextHandle++;
		this.#handles.set(handle, { node });
		return {
			handle,
			size: node.content ? node.content.size : ((node.origin?.entry ?? node.copyOf)?.bytes ?? 0),
			version: node.version,
		};
	}

	/** The file a write at `path` goes to: a new one, the live one's change at the writer's base, or the pending one. */
	#writable(
		path: string,
		options: { readonly create: boolean; readonly exclusive: boolean; readonly base?: string },
	): PendingFile {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) {
			if (!options.create) fail(ErrorCode.notFound, "No such file");
			this.#newName(path);
			const node = this.#newFile();
			node.replaces = this.#takeRemoved(path);
			this.#set(path, node);
			return node;
		}
		if (options.exclusive) fail(ErrorCode.exists, "The file exists");
		// The kernel follows a link before opening; a program that reaches one here asked for its name to be new.
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) === "symlink")
			fail(ErrorCode.exists, "A link has this name");
		if (r.kind === "live") {
			if (r.entry.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
			const node = this.#fromLive(r.entry, r.source, options.base);
			this.#set(path, node);
			return node;
		}
		if (r.node.kind === "folder" || r.node.kind === "symlink") fail(ErrorCode.notAFile, "Not a file");
		if (this.#moved(path, r.node)) throw new PublishFirst("a change to a file this view moved");
		return r.node;
	}

	/** A write that is in the view only once it closes (a cache folder's file moving in: `crates/qorpera-folder`,
	 * `mount/on_disk.rs`). It is checked as an open of the path is, and its file is the change that open would make,
	 * against what it saw: a new file, or the live file's at the open's base. The view's own file there is held as an
	 * open one is, never published, so the close lands on it. Given up (`discard`) or abandoned, a draft leaves
	 * nothing. */
	#openDraft(
		path: string,
		options: { readonly create: boolean; readonly exclusive: boolean; readonly base?: string },
	): { handle: number; size: number; version: string } {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) {
			if (!options.create) fail(ErrorCode.notFound, "No such file");
			this.#newName(path);
		} else {
			if (options.exclusive) fail(ErrorCode.exists, "The file exists");
			const kind = r.kind === "live" ? r.entry.kind : r.node.kind;
			if (kind === "symlink") fail(ErrorCode.exists, "A link has this name");
			if (kind === "folder") fail(ErrorCode.notAFile, "Not a file");
		}
		const held = r?.kind === "node" && r.node.kind === "file" ? r.node : undefined;
		if (held && this.#moved(path, held)) throw new PublishFirst("a change to a file this view moved");
		const node = r?.kind === "live" ? this.#fromLive(r.entry, r.source, options.base) : this.#newFile();
		node.content = { chunks: [], size: 0 };
		this.#changed(node);
		node.open++;
		if (held) {
			if (held.open === 0) this.#fix(held);
			held.open++;
		}
		const handle = this.#nextHandle++;
		// Over nothing or the view's own file there, the live file the view took away from the path, if it did.
		const took = r?.kind === "live" ? undefined : this.#tookAway(path);
		this.#handles.set(handle, { node, draft: { path, ...(held ? { held } : {}), ...(took ? { took } : {}) } });
		return { handle, size: 0, version: node.version };
	}

	/** Whether a change of this view's still takes the live entry at `path` away: a move of it or of a folder above it,
	 * or a new file or link that replaces it (in any case). */
	#takesAway(path: string): boolean {
		const key = folderKey(path);
		for (const [at, node] of this.#nodes) {
			if (node.kind === "gone") continue;
			if (node.origin && node.origin.path !== at && within(path, node.origin.path)) return true;
			if (node.kind !== "folder" && node.replaces && folderKey(node.replaces.path) === key) return true;
		}
		return false;
	}

	/** The live file at `path` this view removed, moved away, or replaced with a new one of its own, if it did. */
	#tookAway(path: string): LiveRef | undefined {
		const removed = this.#removed.get(path);
		if (removed) return removed.kind === "file" ? removed : undefined;
		for (const [at, node] of this.#nodes) {
			if (at !== path && node.kind === "file" && node.origin?.path === path) return node.origin;
			if (
				node.kind !== "folder" &&
				node.kind !== "gone" &&
				node.replaces?.path === path &&
				node.replaces.kind === "file"
			)
				return node.replaces;
		}
		return undefined;
	}

	/** Where a handle's draft lands when it is closed; none for a handle that is not a draft's. */
	draftPath(handle: number): string | undefined {
		return this.#handles.get(handle)?.draft?.path;
	}

	/** The view's own file a handle's draft holds unpublished, if any. */
	draftHeld(handle: number): PendingFile | undefined {
		return this.#handles.get(handle)?.draft?.held;
	}

	/** Whether the handle is still open (a draft whose close could not land it is given up). */
	isOpen(handle: number): boolean {
		return this.#handles.has(handle);
	}

	/** The file a handle writes. */
	file(handle: number): PendingFile {
		const open = this.#handles.get(handle);
		if (!open) fail(ErrorCode.badRequest, "No such handle");
		return open.node;
	}

	/** The live entry whose chunks a handle's first chunk replaces one of, when the file still has its origin's bytes
	 * (or a hard link's source's): the service reads its manifest and calls `beginContent` first. */
	originToCopy(handle: number): TreeEntry | undefined {
		const node = this.file(handle);
		return node.content === undefined ? (node.origin?.entry ?? node.copyOf) : undefined;
	}

	/** The file's bytes become its own, starting from its origin's chunks. */
	beginContent(handle: number, originChunks: readonly ChunkRef[]): void {
		const node = this.file(handle);
		if (node.content !== undefined) return;
		node.content = { chunks: [...originChunks], size: (node.origin?.entry ?? node.copyOf)?.bytes ?? 0 };
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
		this.#unfixed.add(node);
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
			// Any handle's writes since the last fix make a new version: writes share the file.
			if (this.#unfixed.has(node) || before.size !== size || before.chunks.length !== chunks.length)
				this.#changed(node);
		}
		if (open.draft)
			try {
				return this.#land(handle, open.draft, node);
			} catch (error) {
				// Refused for good (its path is a folder now, say): the draft is given up and leaves nothing.
				if (!(error instanceof PublishFirst)) this.abandon(handle);
				throw error;
			}
		this.#handles.delete(handle);
		node.open--;
		this.#fix(node);
		if (node.open === 0) this.#fixed.delete(node);
		return node;
	}

	/** A draft's close: on the view's own file at its path (the one its open held, or one written since), its bytes
	 * are that file's next save. Otherwise its file lands there as the change its open would have made: a file another
	 * machine created or changed there since is a conflict when it is published, not overwritten; a path this view
	 * removed or moved the file away from takes it as a new file, as a create there would (if that move then fails,
	 * the new file meets the file it left: a conflict, both kept). It takes the executable bit of what it lands over
	 * (none for a new file), whether or not a boundary came between. */
	#land(handle: number, draft: Draft, written: PendingFile): PendingFile {
		const path = draft.path;
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		let node: PendingFile;
		if (r?.kind === "node") {
			if (r.node.kind === "symlink") fail(ErrorCode.exists, "A link has this name");
			if (r.node.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
			if (this.#moved(path, r.node)) throw new PublishFirst("a change to a file this view moved");
			node = r.node;
			node.content = written.content;
			this.#changed(node);
		} else {
			if (r?.entry.kind === "symlink") fail(ErrorCode.exists, "A link has this name");
			if (r?.entry.kind === "folder") fail(ErrorCode.notAFile, "Not a file");
			if (!r) {
				this.#newName(path);
				// Over what the view removed there: it replaces that, as a create there would.
				if (!written.origin) written.replaces = this.#takeRemoved(path);
			}
			written.executable = r?.entry.executable ?? false;
			node = written;
			node.open--;
			this.#set(path, node);
		}
		this.#handles.delete(handle);
		this.#unfixed.delete(written);
		if (draft.held === node) node.open--;
		else if (draft.held) this.#letGo(draft.held);
		// Writes share the file: a handle still open on it goes back to these bytes if it is abandoned.
		this.#fix(node);
		if (node.open === 0) this.#fixed.delete(node);
		return node;
	}

	/** A still-open handle is abandoned: what was written and no close fixed is lost (founder
	 * decision 3). Writes share the file, as in a page cache: while another handle is still open, its close will fix
	 * them; when this was the last, the file goes back to how the last close (or open) left it. A draft leaves nothing. */
	abandon(handle: number): void {
		const open = this.#handles.get(handle);
		if (!open) return;
		this.#handles.delete(handle);
		if (open.draft) {
			this.#unfixed.delete(open.node);
			if (open.draft.held) this.#letGo(open.draft.held);
		} else this.#letGo(open.node);
	}

	/** A handle on the file, or a draft's hold of it, ends without a close. */
	#letGo(node: PendingFile): void {
		node.open--;
		if (node.open > 0) return;
		const fixed = this.#fixed.get(node);
		if (fixed) Object.assign(node, fixed);
		this.#fixed.delete(node);
		this.#unfixed.delete(node);
	}

	#fix(node: PendingFile): void {
		this.#unfixed.delete(node);
		this.#fixed.set(node, {
			content: node.content,
			version: node.version,
			staged: node.staged,
			executable: node.executable,
		});
	}

	mkdir(path: string): void {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		if (this.resolve(path)) fail(ErrorCode.exists, "The path exists");
		this.#newName(path);
		this.#set(path, { kind: "folder", origin: undefined, version: randomUUID(), mtimeMs: this.#now() });
	}

	/** symlink(2) (`Y`): a new link at `path`, whose target the service checked. Answers its version. */
	symlink(path: string, target: string): string {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		if (this.resolve(path)) fail(ErrorCode.exists, "The path exists");
		this.#newName(path);
		const version = randomUUID();
		const replaces = this.#takeRemoved(path);
		this.#set(path, { kind: "symlink", origin: undefined, replaces, target, version, mtimeMs: this.#now() });
		return version;
	}

	/** link(2) (`J`): a new name `to` for what `from` shows at `base` (the version the machine showed; its current one
	 * when none). A file's new name is a new file whose bytes are still that version's, sent and stored once; a link's
	 * is a new link with its target. `replaced` finds a version of a live path the view still serves after a newer one
	 * replaced it. Answers the new name's version. */
	link(
		from: string,
		to: string,
		base: string | undefined,
		replaced: (livePath: string, version: string) => TreeEntry | undefined,
	): string {
		if (this.#insideMoved(to)) throw new PublishFirst("a change inside a folder this view moved");
		const source = this.resolve(from);
		if (!source) fail(ErrorCode.notFound, "No such file");
		let made: PendingFile | PendingLink;
		const version = randomUUID();
		const mtimeMs = this.#now();
		const link = (target: string): PendingLink => ({
			kind: "symlink",
			origin: undefined,
			replaces: undefined,
			target,
			version,
			mtimeMs,
		});
		if (source.kind === "live") {
			if (source.entry.kind === "folder") fail(ErrorCode.notPermitted, "A folder has no hard links");
			let entry: TreeEntry | undefined = source.entry;
			if (base !== undefined && base !== entry.version) entry = replaced(source.source, base);
			if (!entry) fail(ErrorCode.stale, "That version is no longer served");
			made = entry.kind === "symlink" ? link(entry.target!) : this.#copied(entry, version, mtimeMs);
		} else {
			const node = source.node;
			if (node.kind === "folder") fail(ErrorCode.notPermitted, "A folder has no hard links");
			if (base !== undefined && base !== node.version) fail(ErrorCode.stale, "That version is no longer served");
			if (node.kind === "symlink") made = link(node.target);
			else {
				// What a file open for writing will be is not known yet (P1).
				if (node.open > 0) fail(ErrorCode.busy, "The file is open for writing");
				const copyOf = node.content === undefined ? (node.origin?.entry ?? node.copyOf) : undefined;
				made = {
					...this.#copied(copyOf, version, mtimeMs),
					content: node.content,
					executable: node.executable,
					mediaType: node.staged?.file.mediaType ?? node.mediaType,
					staged: node.staged?.version === node.version ? { version, file: node.staged.file } : undefined,
				};
			}
		}
		if (this.resolve(to)) fail(ErrorCode.exists, "The path exists");
		this.#newName(to);
		made.replaces = this.#takeRemoved(to);
		this.#set(to, made);
		return version;
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
		if (r.kind === "live" && this.#hiddenBelow(path))
			throw new PublishFirst("removing a folder with changes inside it");
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
		if (kind === "folder" && folderKey(to).startsWith(`${folderKey(from)}/`))
			fail(ErrorCode.badRequest, "A folder cannot go inside itself");
		const parent = this.resolve(parentOf(to));
		if (!parent || (parent.kind === "live" ? parent.entry.kind : parent.node.kind) !== "folder")
			fail(ErrorCode.notFound, "No such folder");
		checkMove(from, to);
		const live = source.kind === "live" || source.node.origin !== undefined;
		// A live entry's move is published as one: it never goes where nothing is published.
		if (live && unpublished(to)) fail(ErrorCode.notHere, "A published path cannot go where nothing is published");
		if (source.kind === "node" && source.node.kind === "file" && source.node.origin) {
			// A file open for writing cannot move: what it writes after would be a change to a moved file.
			if (source.node.open > 0) fail(ErrorCode.busy, "The file is open for writing");
			if (source.node.content || source.node.executable !== source.node.origin.entry?.executable)
				throw new PublishFirst("moving a file this view changed");
		}
		if (source.kind === "live" && source.entry.kind === "folder" && this.#pendingBelow(from, source.source))
			throw new PublishFirst("moving a folder with changes inside it");
		const target = this.resolve(to);
		if (target) {
			if (options.noReplace) fail(ErrorCode.exists, "The path exists");
			const targetKind = target.kind === "live" ? target.entry.kind : target.node.kind;
			if (kind !== "folder" && targetKind === "folder") fail(ErrorCode.notAFile, "Not a file");
			if (kind === "folder" && targetKind !== "folder") fail(ErrorCode.notAFolder, "Not a folder");
			if (targetKind === "folder" && this.#hasChildren(to)) fail(ErrorCode.notEmpty, "The folder is not empty");
			checkRemovable(to);
			if (target.kind === "live" && target.entry.kind === "folder" && this.#pendingBelow(to, target.source))
				throw new PublishFirst("replacing a folder with changes inside it");
		} else {
			// A name never published renamed only in case to a published one is a new name there too.
			if (folderKey(from) !== folderKey(to) || (unpublished(from) && !unpublished(to))) this.#newName(to, from);
			if (this.#freedFolder(to)) throw new PublishFirst("reusing a path a folder this view moved or removed left");
			// Moves that take each other's places (a swap, a ring) publish one at a time.
			const origin = source.kind === "live" ? source.source : source.node.origin?.path;
			if (origin !== undefined && this.#cycle(origin, to))
				throw new PublishFirst("moves that take each other's places");
		}
		// The moving node: a pending one as it is, or one made from the live entry, at the writer's base.
		let node: PendingFile | PendingFolder | PendingLink;
		if (source.kind === "node") node = source.node;
		else if (source.entry.kind === "file") node = this.#fromLive(source.entry, source.source, options.fromBase);
		else if (source.entry.kind === "symlink")
			node = {
				kind: "symlink",
				origin: {
					path: source.source,
					kind: "symlink",
					version: options.fromBase ?? source.entry.version,
					entry: source.entry,
				},
				replaces: undefined,
				target: source.entry.target!,
				version: source.entry.version,
				mtimeMs: source.entry.mtimeMs,
			};
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
		if (source.kind === "live") this.#forget(source.source);
		else {
			this.#forget(from);
			if (source.node.origin) this.#forget(source.node.origin.path, source.node.origin);
		}
		// A new file or link renamed only in case still replaces the live one it replaced. Renamed elsewhere, over another
		// path, or to a name never published, it lets that one go; over a file or link, it replaces that one instead, and
		// elsewhere what the view removed at its new name. (One renamed from a name never published replaced nothing.)
		const fresh = node.kind !== "folder" && node.origin === undefined ? node : undefined;
		const lets =
			fresh && (target !== undefined || folderKey(from) !== folderKey(to) || unpublished(from) || unpublished(to));
		if (fresh && lets) this.#release(fresh);
		const take = fresh !== undefined && !unpublished(to);
		const replaces = target ? this.#replaced(target, to, options.toBase, take) : undefined;
		// A new folder's pending nodes move with it; then `from` is hidden if the live folder still shows what the node
		// holds there.
		const moved: [string, Node][] = [];
		for (const [path, n] of this.#nodes) if (path !== from && within(path, from)) moved.push([path, n]);
		for (const [path] of moved) this.#unset(path);
		this.#unset(from);
		this.#dropUnder(to);
		if (fresh && lets) fresh.replaces = target ? replaces : this.#takeRemoved(to);
		this.#hideHeld(from, node);
		this.#set(to, node);
		for (const [path, n] of moved) this.#set(to + path.slice(from.length), n);
		node.mtimeMs = this.#now();
	}

	/** chmod: only the executable bit is kept. */
	setExecutable(path: string, executable: boolean, base?: string): void {
		if (this.#insideMoved(path)) throw new PublishFirst("a change inside a folder this view moved");
		const r = this.resolve(path);
		if (!r) fail(ErrorCode.notFound, "No such file");
		// A folder's and a link's modes are the folder's own.
		if ((r.kind === "live" ? r.entry.kind : r.node.kind) !== "file") return;
		if (r.kind === "live" && r.entry.executable === executable) return;
		if (r.kind === "node" && this.#moved(path, r.node)) throw new PublishFirst("a change to a file this view moved");
		const node = r.kind === "node" ? (r.node as PendingFile) : this.#fromLive(r.entry, r.source, base);
		if (r.kind === "live") this.#set(path, node);
		if (node.executable === executable) return;
		node.executable = executable;
		this.#changed(node);
		// A bit set on a file open for writing is fixed at once, like the bit itself.
		const fixed = this.#fixed.get(node);
		if (fixed) this.#fixed.set(node, { ...fixed, executable, version: node.version, staged: undefined });
	}

	/** The feed changed these live paths. A removal whose live entry changed since is dropped, so the view shows the
	 * newer version again: a removal never takes a version the machine did not see. (A subtree removal or a move
	 * refuses changes it did not see by its `asOfSeq`; a save conflicts by its base.) A new file or link keeps the base
	 * of the live one it replaces: its unit names that version, so the core refuses it as a conflict rather than writing
	 * over, or bringing back, a version the machine never saw. */
	liveChanged(paths: readonly string[]): void {
		for (const path of paths) this.#dropStale(path);
	}

	// ---- Inside ----------------------------------------------------------------------------------------------------

	/** A new name in an existing folder: allowed, and not a sibling's spelled otherwise (`EEXIST`); a path a moved or
	 * removed live folder left, or one a pending file, link or folder spells otherwise, or a folder above it (beside a
	 * live one another machine made or renamed), publishes what is pending first. `except`: what a rename moves from. */
	#newName(path: string, except?: string): void {
		const parent = this.resolve(parentOf(path));
		if (!parent) fail(ErrorCode.notFound, "No such folder");
		if ((parent.kind === "live" ? parent.entry.kind : parent.node.kind) !== "folder")
			fail(ErrorCode.notAFolder, "Not a folder");
		checkNewPath(path, this.#codeHost);
		const key = folderKey(nameOf(path));
		const names = new Set<string>(this.#children.get(parentOf(path)) ?? []);
		if (parent.source !== null) for (const name of this.#live().names(parent.source)) names.add(name);
		for (const name of names)
			if (
				name !== nameOf(path) &&
				folderKey(name) === key &&
				join(parentOf(path), name) !== except &&
				this.resolve(join(parentOf(path), name))
			)
				fail(ErrorCode.exists, "A path differing only in case exists");
		if (this.#freedFolder(path)) throw new PublishFirst("reusing a path a folder this view moved or removed left");
		// Under a parent spelled otherwise (another machine made or renamed one only in case), a pending file, link or
		// folder at its path is no sibling, and does not show: in the core it is the same path, whose unit this one's
		// would need the version of, or a new folder this name would go into, so it publishes first. A name never
		// published is no unit: it folds with nothing.
		if (unpublished(path)) return;
		let at = "";
		for (const name of path.split("/")) {
			at = join(at, name);
			const key = folderKey(at);
			for (const [p, node] of this.#nodes)
				if (p !== at && p !== except && node.kind !== "gone" && !unpublished(p) && folderKey(p) === key)
					throw new PublishFirst("a new name at a path a pending one spells otherwise");
		}
	}

	#newFile(): PendingFile {
		return {
			kind: "file",
			origin: undefined,
			replaces: undefined,
			content: { chunks: [], size: 0 },
			copyOf: undefined,
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
			replaces: undefined,
			content: undefined,
			copyOf: undefined,
			executable: entry.executable,
			mediaType: entry.mediaType,
			open: 0,
			version: entry.version,
			mtimeMs: entry.mtimeMs,
			staged: undefined,
		};
	}

	/** A hard link's new file, its bytes still those of the live version `entry`. */
	#copied(entry: TreeEntry | undefined, version: string, mtimeMs: number): PendingFile {
		return {
			kind: "file",
			origin: undefined,
			replaces: undefined,
			content: undefined,
			copyOf: entry,
			executable: entry?.executable ?? false,
			mediaType: entry?.mediaType,
			open: 0,
			version,
			mtimeMs,
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
	#remove(r: Resolved, base: string | undefined, save = false): void {
		if (r.kind === "live") {
			// The machine removes what its name showed; a newer version it never saw is not taken (ESTALE: it looks again).
			// A file replaced by a save keeps the save's base, so the save conflicts instead.
			if (!save && r.entry.kind !== "folder" && base !== undefined && base !== r.entry.version)
				fail(ErrorCode.stale, "The file changed since the machine saw it");
			this.#removed.set(r.source, {
				path: r.source,
				kind: r.entry.kind,
				version: base ?? r.entry.version,
				...(r.entry.kind === "folder" ? { asOfSeq: this.#seq() } : { entry: r.entry }),
			});
			this.#forget(r.source);
			return;
		}
		const origin = r.node.origin;
		// A changed file whose live version moved on since its base is not removed with it: the change goes, and the
		// newer version shows again, as a conflict would have left it.
		const current = origin && this.#live().get(origin.path)?.version === origin.version;
		this.#dropUnder(r.path);
		this.#unset(r.path);
		// Its live origin moved on: the newer version shows again where it is, not hidden by this change's move.
		if (origin && !current) {
			if (this.#nodes.get(origin.path)?.kind === "gone") this.#unset(origin.path);
		} else {
			// What the view had at the path goes: a draft open there lands over that, as a new file.
			this.#forget(r.path);
			if (origin) {
				this.#removed.set(origin.path, origin.kind === "folder" ? { ...origin, asOfSeq: this.#seq() } : origin);
				this.#forget(origin.path, origin);
			}
			// A new file or link lets the live one it replaced go: removed at its base, or shown again if newer.
			else if (r.node.kind !== "folder") this.#release(r.node);
		}
		// What the live folder still shows at the path stays hidden if the view moved it away; anything else there the
		// view never took: what the node held is removed now, so it is another machine's (made, or renamed there only in
		// case), and shows again.
		this.#hideMoved(r.path);
	}

	// ---- A new file or link that replaces a live one ---------------------------------------------------------------
	//
	// It holds the live one's base itself, taken once: when it is renamed over the live one (an editor's save through
	// a temporary file, `ln -sf`), over a pending one that replaced it, or made where the view removed it. Its unit
	// names that version; nothing the view does at that path later, in any case, changes it. Only the node's own
	// removal, its move to another path (or over another), or its publication lets it go.

	/** What a new file or link renamed over `target` (at `to`, a published name when `take`) replaces: the live file or
	 * link there, at the writer's base, or what a pending one there replaced or was opened from. The target goes. */
	#replaced(target: Resolved, to: string, base: string | undefined, take: boolean): LiveRef | undefined {
		if (take && target.kind === "node" && target.node.kind !== "folder" && !this.#moved(target.path, target.node)) {
			const ref = target.node.replaces ?? target.node.origin;
			this.#dropUnder(target.path);
			this.#unset(target.path);
			// As its removal would: a draft open there lands over what replaces it, as a new file.
			this.#forget(target.path);
			if (ref) this.#forget(ref.path, ref);
			return ref;
		}
		this.#remove(target, base, true);
		return take ? this.#takeRemoved(to) : undefined;
	}

	/** The removal of a live file or link at `path` (in any case) that a new one made there replaces instead: it leaves
	 * the removals, and the live one stays hidden. A name never published replaces nothing: it is no unit. */
	#takeRemoved(path: string): LiveRef | undefined {
		if (unpublished(path)) return undefined;
		const key = folderKey(path);
		for (const [p, ref] of this.#removed)
			if (ref.kind !== "folder" && folderKey(p) === key) {
				this.#removed.delete(p);
				if (p !== path) this.#hide(p);
				return ref;
			}
		return undefined;
	}

	/** A new file or link lets the live one it replaced go: that one is removed at the writer's base if the feed has not
	 * changed it since; else its newer version shows again, as a conflict would leave it. */
	#release(node: PendingFile | PendingLink): void {
		const base = node.replaces;
		if (!base) return;
		node.replaces = undefined;
		if (this.#live().get(base.path)?.version === base.version) this.#removed.set(base.path, base);
		else if (this.#nodes.get(base.path)?.kind === "gone") this.#unset(base.path);
	}

	/** Drops a file's or link's removal whose live entry changed since the machine saw it. Answers whether it did. */
	#dropStale(path: string): boolean {
		const removed = this.#removed.get(path);
		if (!removed || removed.kind === "folder") return false;
		if (this.#live().get(path)?.version === removed.version) return false;
		this.#removed.delete(path);
		if (this.#nodes.get(path)?.kind === "gone") this.#unset(path);
		return true;
	}

	/** This view took the live entry at `path` away (removed or moved it; `ref`, under the view's own file there): a
	 * draft opened over it, or over a file in it, lands as a new file, over what the view did there, not against the
	 * version its open saw, unless the view's change never happens. */
	#forget(path: string, ref?: LiveRef): void {
		for (const { node, draft } of this.#handles.values()) {
			if (!draft) continue;
			if (node.origin && within(node.origin.path, path)) {
				draft.took = node.origin;
				node.origin = undefined;
			} else if (!node.origin && ref && draft.path === ref.path) draft.took = ref;
		}
	}

	/** The live version now at a live path (the planner checks a removal it would fold into its folder's). */
	liveVersion(path: string): string | undefined {
		return this.#live().get(path)?.version;
	}

	/** Nodes left under a path that now holds something else hide nothing there. */
	#dropUnder(path: string): void {
		for (const key of [...this.#nodes.keys()]) if (key !== path && within(key, path)) this.#unset(key);
	}

	/** A path the live folder would still show something at gets a gone node. */
	#hide(path: string): void {
		if (this.resolve(path)) this.#set(path, { kind: "gone" });
	}

	/** After `node` left `path`: a gone node there if the live folder still shows what the node holds (its origin, or
	 * the live one it still replaces), or what the view moved away. Anything else there the view never took, and it
	 * shows: another machine's (made, or renamed there only in case), or a newer version the node let go. */
	#hideHeld(path: string, node: PendingFile | PendingFolder | PendingLink): void {
		const r = this.resolve(path);
		if (r?.kind !== "live") return;
		if (r.source === node.origin?.path || (node.kind !== "folder" && r.source === node.replaces?.path))
			this.#set(path, { kind: "gone" });
		else this.#hideMoved(path);
	}

	/** A gone node at `path` if the live folder still shows there an entry the view moved away (a pending node at
	 * another path holds it as its origin): a new file or link made where it left, then removed or moved on, does not
	 * bring it back. */
	#hideMoved(path: string): void {
		const r = this.resolve(path);
		if (r?.kind !== "live") return;
		for (const [p, node] of this.#nodes)
			if (node.kind !== "gone" && p !== r.source && node.origin?.path === r.source) {
				this.#set(path, { kind: "gone" });
				return;
			}
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
	nodes(): ReadonlyMap<string, PendingFile | PendingFolder | PendingLink | { readonly kind: "gone" }> {
		return this.#nodes;
	}

	/** What a file open for writing goes back to if its last handle is abandoned (its last close or truncating open):
	 * bytes the service must keep holding while the file is open. */
	fixedState(node: PendingFile): Pick<PendingFile, "content" | "staged"> | undefined {
		return this.#fixed.get(node);
	}

	/** After a boundary: this view's own save or move gave `path` the live version `version`. A draft open there lands
	 * over it, as over the view's file before the boundary; a change another machine makes after it is a conflict. */
	publishedAt(path: string, version: string): void {
		const entry = this.#live().get(path);
		for (const { node, draft } of this.#handles.values())
			if (draft?.path === path)
				node.origin = { path, kind: "file", version, ...(entry?.version === version ? { entry } : {}) };
	}

	/** Live entries the view removed, by live path. */
	removed(): ReadonlyMap<string, LiveRef> {
		return this.#removed;
	}

	/** After a boundary: the view shows the live folder again, except the nodes the boundary keeps (`keep`: files
	 * still open, names never published, and new bytes the core did not save). Every removal and move was published
	 * (saved, or failed losing nothing), so the gone nodes and the removals go too. A kept new file or link that
	 * replaces a live one (an editor's save or `ln -sf` the core did not take) keeps its base, and replaces the same
	 * version again at the next boundary; the live one stays hidden where it is spelled otherwise. */
	settle(keep: ReadonlySet<string>): void {
		for (const path of [...this.#nodes.keys()]) if (!keep.has(path)) this.#unset(path);
		this.#removed.clear();
		for (const [path, node] of [...this.#nodes])
			if ((node.kind === "file" || node.kind === "symlink") && node.replaces && node.replaces.path !== path)
				this.#hide(node.replaces.path);
		// Where a removal or move of the view's failed, the path shows the file it would have taken away: a draft open
		// there lands against that file, as one opened over it does (a change another machine makes after is a conflict).
		// A move the boundary kept (one waiting on another), or a kept new file or link that replaces it, still takes it
		// away.
		for (const { node, draft } of this.#handles.values()) {
			if (!draft?.took || this.#takesAway(draft.took.path)) continue;
			const live = this.#live().get(draft.took.path);
			if (!node.origin && live?.kind === "file" && live.version === draft.took.version)
				node.origin = { path: draft.took.path, kind: "file", version: live.version, entry: live };
			draft.took = undefined;
		}
	}

	/** After a git publish (git.ts): the view shows the live files again where `made` names the version it published,
	 * unless the file changed or opened since. A new folder above them (an objects folder git made) shows live again
	 * too once the core has it and nothing in it is pending: else it would hide what was published into it. */
	settlePaths(made: ReadonlyMap<string, string>): void {
		for (const [path, version] of made) {
			const node = this.#nodes.get(path);
			if (node?.kind === "file" && node.version === version && node.open === 0) this.#unset(path);
		}
		for (const path of made.keys())
			for (let p = parentOf(path); p !== ""; p = parentOf(p)) {
				const node = this.#nodes.get(p);
				if (node?.kind !== "folder" || node.origin || this.#children.has(p)) break;
				if (this.#live().get(p)?.kind !== "folder") break;
				this.#unset(p);
			}
	}

	/** Before a git lock is taken (git.ts): what the view holds of the files the lock guards goes, so git reads them as
	 * the core has them. A file still open stays. */
	drop(paths: readonly string[]): void {
		for (const path of paths) {
			const node = this.#nodes.get(path);
			if (node?.kind === "gone" || (node?.kind === "file" && node.open === 0)) {
				this.#unset(path);
				// The live file a new one replaced shows again too, where it is spelled otherwise.
				const replaced = node.kind === "file" ? node.replaces?.path : undefined;
				if (replaced && replaced !== path && this.#nodes.get(replaced)?.kind === "gone") this.#unset(replaced);
			}
			if (node?.kind !== "file" || node.open === 0) this.#removed.delete(path);
		}
	}

	/** Forgets everything (the view closed). Open handles stay valid but detached. */
	clear(): void {
		this.#nodes.clear();
		this.#children.clear();
		this.#removed.clear();
	}
}
