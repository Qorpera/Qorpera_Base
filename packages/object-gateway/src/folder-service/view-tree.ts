import type { CoreEntry, CoreReceipt, FeedChange } from "./core.ts";
import type { WireEntry } from "./protocol.ts";

/** One path a view may see, as the folder service keeps it. A folder the actor may not list itself, but which holds
 * paths it may read, is shown anyway (`implicit`), so those paths can be reached. */
export interface TreeEntry {
	readonly path: string;
	readonly kind: "file" | "folder";
	/** The core's version id (a uuid); "" for a folder shown only because it holds readable paths. */
	readonly version: string;
	readonly manifestSha256?: string;
	readonly fileSha256?: string;
	readonly bytes: number;
	readonly mediaType?: string;
	readonly executable: boolean;
	readonly mtimeMs: number;
	readonly implicit: boolean;
	/** The core's read receipt (an agent's view only): from its listing, or, for a path the feed brought, the path's
	 * earlier one or the nearest folder's above it that has one, which the core checks again if it no longer holds. A
	 * new top-level path has none until the next listing: its reads go with an empty receipt, which the core checks. */
	readonly authority?: CoreReceipt;
}

export type ChildrenResult =
	| { readonly entries: readonly WireEntry[]; readonly next: string | null }
	| "not_found"
	| "not_a_folder";

const ROOT: TreeEntry = {
	path: "",
	kind: "folder",
	version: "",
	bytes: 0,
	executable: false,
	mtimeMs: 0,
	implicit: true,
};

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Names in byte order of their UTF-8, the order the machine sees and pages by. */
export function byteOrder(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function entryOf(e: CoreEntry, previous: TreeEntry | undefined, folder: TreeEntry | undefined): TreeEntry {
	const time = e.updatedAt === undefined ? Number.NaN : Date.parse(e.updatedAt);
	const authority = e.authority ?? previous?.authority ?? folder?.authority;
	return {
		path: e.path,
		kind: e.kind,
		version: e.version,
		...(e.manifestSha256 === undefined ? {} : { manifestSha256: e.manifestSha256 }),
		...(e.fileSha256 === undefined ? {} : { fileSha256: e.fileSha256 }),
		bytes: e.kind === "file" ? (e.bytes ?? 0) : 0,
		...(e.mediaType === undefined ? {} : { mediaType: e.mediaType }),
		executable: e.kind === "file" && e.executable === true,
		mtimeMs: Number.isFinite(time) ? time : (previous?.mtimeMs ?? 0),
		implicit: false,
		...(authority === undefined ? {} : { authority }),
	};
}

function sameReceipt(a: CoreReceipt | undefined, b: CoreReceipt | undefined): boolean {
	return (
		a === b ||
		(a !== undefined &&
			b !== undefined &&
			a.resourceId === b.resourceId &&
			a.resourceRevision === b.resourceRevision &&
			a.grantId === b.grantId &&
			a.grantRevision === b.grantRevision)
	);
}

function same(a: TreeEntry, b: TreeEntry): boolean {
	return (
		a.kind === b.kind &&
		a.version === b.version &&
		a.bytes === b.bytes &&
		a.executable === b.executable &&
		a.mtimeMs === b.mtimeMs &&
		a.manifestSha256 === b.manifestSha256 &&
		// A new receipt reaches the machines too (an access change lists the view again), so their logs stay current.
		sameReceipt(a.authority, b.authority)
	);
}

export function wireEntry(e: TreeEntry): WireEntry {
	return {
		name: nameOf(e.path),
		kind: e.kind,
		size: e.kind === "file" ? e.bytes : 0,
		mtimeMs: e.mtimeMs,
		executable: e.executable,
		version: e.version,
		...(e.authority === undefined ? {} : { authority: e.authority }),
	};
}

/** Everything one view may see, in memory: built from the core's recursive listing, kept current from its feed.
 * Every change returns the paths whose entry, or whose folder's listing, changed. */
export class ViewTree {
	readonly #entries = new Map<string, TreeEntry>();
	readonly #children = new Map<string, Set<string>>();
	readonly #sorted = new Map<string, string[]>();

	get size(): number {
		return this.#entries.size;
	}

	get(path: string): TreeEntry | undefined {
		return path === "" ? ROOT : this.#entries.get(path);
	}

	paths(): IterableIterator<string> {
		return this.#entries.keys();
	}

	children(path: string, after: string | undefined, limit: number): ChildrenResult {
		const folder = this.get(path);
		if (!folder) return "not_found";
		if (folder.kind !== "folder") return "not_a_folder";
		const names = this.#names(path);
		let start = 0;
		if (after !== undefined) {
			// First name ordered after `after` (binary search; `after` itself may be gone by now).
			let lo = 0;
			let hi = names.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (byteOrder(names[mid]!, after) <= 0) lo = mid + 1;
				else hi = mid;
			}
			start = lo;
		}
		const page = names.slice(start, start + limit);
		const prefix = path === "" ? "" : `${path}/`;
		return {
			entries: page.map((name) => wireEntry(this.#entries.get(prefix + name)!)),
			next: start + limit < names.length ? page[page.length - 1]! : null,
		};
	}

	/** `path` and everything under it, depth first in the order a machine lists them (each folder's names in byte
	 * order), from `from` on when given (that path and what follows it), reached straight, without passing what comes
	 * before. The tree may change meanwhile: a path gone by the time it is reached is passed over. */
	*walk(path: string, from?: string): Generator<TreeEntry> {
		const entry = this.get(path);
		if (!entry) return;
		if (from === undefined || from === path) {
			yield entry;
			if (entry.kind !== "folder") return;
			for (const name of this.#names(path)) yield* this.walk(path === "" ? name : `${path}/${name}`);
			return;
		}
		const prefix = path === "" ? "" : `${path}/`;
		// A `from` outside `path`: all of it if `from` comes first, none of it if after.
		if (!from.startsWith(prefix)) {
			if (path !== "" && byteOrder(from, path) < 0) yield* this.walk(path);
			return;
		}
		if (entry.kind !== "folder") return;
		yield* this.#walkFrom(path, from.slice(prefix.length).split("/"));
	}

	/** The paths under the folder `path` at or after its descendant named by `rest`, in walk order. */
	*#walkFrom(path: string, rest: readonly string[]): Generator<TreeEntry> {
		const names = this.#names(path);
		const first = rest[0]!;
		let lo = 0;
		let hi = names.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (byteOrder(names[mid]!, first) < 0) lo = mid + 1;
			else hi = mid;
		}
		const join = (name: string): string => (path === "" ? name : `${path}/${name}`);
		if (lo < names.length && names[lo] === first) {
			const child = this.get(join(first));
			// The named entry itself and all it holds, or, deeper, only what it holds from there on.
			if (rest.length === 1) yield* this.walk(join(first));
			else if (child?.kind === "folder") yield* this.#walkFrom(join(first), rest.slice(1));
			lo++;
		}
		for (let i = lo; i < names.length; i++) yield* this.walk(join(names[i]!));
	}

	/** A folder's names in byte order (cached until the folder changes). */
	#names(path: string): readonly string[] {
		let names = this.#sorted.get(path);
		if (!names) {
			// A name over 255 bytes cannot be shown on Linux, and could not be paged after (`after` is a name).
			names = [...(this.#children.get(path) ?? [])].filter((n) => Buffer.byteLength(n) <= 255).sort(byteOrder);
			this.#sorted.set(path, names);
		}
		return names;
	}

	/** Adds or replaces one entry (and any folders above it that are not known yet). `replaced` hears of every file entry
	 * it removes or replaces with another version. */
	put(e: CoreEntry, replaced?: (old: TreeEntry) => void): string[] {
		const changed: string[] = [];
		const ancestors: string[] = [];
		for (let p = parentOf(e.path); p !== ""; p = parentOf(p)) ancestors.push(p);
		for (const p of ancestors.reverse()) {
			const existing = this.#entries.get(p);
			if (existing?.kind === "file") {
				// A file where a folder must be: the newer path wins, as it will in the core.
				changed.push(...this.remove(p, replaced));
			}
			if (!this.#entries.has(p)) {
				this.#link({ ...ROOT, path: p });
				changed.push(p);
			}
		}
		const previous = this.#entries.get(e.path);
		if (previous?.kind === "folder" && e.kind === "file") changed.push(...this.#removeBelow(e.path, replaced));
		const next = entryOf(e, previous, this.#withReceipt(parentOf(e.path)));
		if (previous?.kind === "file" && (next.kind !== "file" || next.version !== previous.version))
			replaced?.(previous);
		if (!previous || !same(previous, next) || previous.implicit) changed.push(e.path);
		this.#link(next);
		return changed;
	}

	/** Removes a path and everything under it; an implicit folder left empty goes too. `replaced` hears of every file
	 * entry removed, the path's descendants included. */
	remove(path: string, replaced?: (old: TreeEntry) => void): string[] {
		if (path === "" || !this.#entries.has(path)) return [];
		const changed = this.#removeBelow(path, replaced);
		const removed = this.#entries.get(path);
		if (removed?.kind === "file") replaced?.(removed);
		this.#unlink(path);
		changed.push(path);
		for (let p = parentOf(path); p !== ""; p = parentOf(p)) {
			const folder = this.#entries.get(p);
			if (!folder?.implicit || (this.#children.get(p)?.size ?? 0) > 0) break;
			this.#unlink(p);
			changed.push(p);
		}
		return changed;
	}

	/** Applies one feed change. `replaced` hears of every file entry the change removes or replaces, the descendants of a
	 * folder it removes included, so a reader of an old version can keep it. */
	apply(change: FeedChange, replaced?: (old: TreeEntry) => void): string[] {
		switch (change.op) {
			case "delete":
			case "move_out":
				return this.remove(change.path, replaced);
			case "mkdir":
				return this.put({ ...change, kind: "folder" }, replaced);
			default:
				return this.put(change, replaced);
		}
	}

	/** The paths that differ between two trees of the same view. */
	static diff(before: ViewTree, after: ViewTree): string[] {
		const changed: string[] = [];
		for (const [path, entry] of before.#entries) {
			const next = after.#entries.get(path);
			if (!next || !same(entry, next)) changed.push(path);
		}
		for (const path of after.#entries.keys()) if (!before.#entries.has(path)) changed.push(path);
		return changed;
	}

	/** The nearest folder at or above `path` that has a receipt (a folder made only to hold a path has none). */
	#withReceipt(path: string): TreeEntry | undefined {
		for (let p = path; p !== ""; p = parentOf(p)) {
			const entry = this.#entries.get(p);
			if (entry?.authority) return entry;
		}
		return undefined;
	}

	#link(entry: TreeEntry): void {
		const parent = parentOf(entry.path);
		this.#entries.set(entry.path, entry);
		let names = this.#children.get(parent);
		if (!names) {
			names = new Set();
			this.#children.set(parent, names);
		}
		if (!names.has(nameOf(entry.path))) {
			names.add(nameOf(entry.path));
			this.#sorted.delete(parent);
		}
	}

	#unlink(path: string): void {
		const parent = parentOf(path);
		this.#entries.delete(path);
		this.#children.delete(path);
		this.#sorted.delete(path);
		const names = this.#children.get(parent);
		if (names?.delete(nameOf(path))) this.#sorted.delete(parent);
	}

	#removeBelow(path: string, replaced?: (old: TreeEntry) => void): string[] {
		const changed: string[] = [];
		const names = this.#children.get(path);
		if (!names) return changed;
		for (const name of [...names]) {
			const child = `${path}/${name}`;
			changed.push(...this.#removeBelow(child, replaced));
			const removed = this.#entries.get(child);
			if (removed?.kind === "file") replaced?.(removed);
			this.#unlink(child);
			changed.push(child);
		}
		return changed;
	}
}
