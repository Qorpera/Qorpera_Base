import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { CoreReceipt } from "./core.ts";
import { ObjectUnavailableError } from "./objects.ts";
import type { SearchCursor, SearchRequest } from "./protocol.ts";
import { SearchPatternError } from "./regex.ts";
import { SEARCH_SLICE_MS, type SearchAnswer, type SearchFile, type SearchHit, type SearchRead } from "./search.ts";
import { byteOrder, type TreeDelta, type TreeEntry, type ViewTree } from "./view-tree.ts";

const DEFAULT_INDEX_MIB = 256;
const DEFAULT_THREADS = 4;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const SYNC_CHUNK_ENTRIES = 2_048;
const TURN_MS = 10;
const STOP_KILL_MS = 2_000;
const MAX_STDERR_BYTES = 8 * 1024;

const authorityBytesCache = new WeakMap<CoreReceipt, number>();

interface WorkerEntry {
	readonly i: number;
	readonly k: 0 | 1 | 2;
	readonly p: string;
	readonly v: string;
	readonly m?: string;
	readonly f?: string;
	readonly b?: number;
	readonly t?: string;
	readonly x?: boolean;
	readonly tg?: string;
	readonly rb: number;
}

interface SearchFrame {
	readonly op: "search";
	readonly id: number;
	readonly snapshotId: number;
	readonly profileId: string | null;
	readonly version: 1 | 2;
	readonly query: string | null;
	readonly regex: boolean;
	readonly path: string;
	readonly glob: string | null;
	readonly namesOnly: boolean;
	readonly filesOnly: boolean;
	readonly caseSensitive: boolean;
	readonly context: number;
	readonly links: boolean;
	readonly after: SearchCursor | null;
	readonly sliceMs: number;
	readonly longestLine?: number;
	readonly pieceBytes?: number;
}

interface SyncTreeFrame {
	readonly op: "syncTree";
	readonly id: number;
	readonly snapshotId: number;
	readonly append: boolean;
	readonly entries: readonly WorkerEntry[];
}

interface PatchTreeFrame {
	readonly op: "patchTree";
	readonly id: number;
	readonly baseSnapshotId: number;
	readonly snapshotId: number;
	readonly upserts: readonly WorkerEntry[];
	readonly removes: readonly string[];
}

interface DropTreeFrame {
	readonly op: "dropTree";
	readonly id: number;
	readonly snapshotId: number;
}

interface WorkerOk {
	readonly hits: readonly SearchHit[];
	readonly files: readonly SearchFile[];
	readonly searched: number;
	readonly binary: number;
	readonly unreadable: number;
	readonly longLines: number;
	readonly readRanges?: readonly number[];
	readonly logs: readonly string[];
	readonly next: SearchCursor | null;
}

interface WorkerError {
	readonly kind: string;
	readonly message: string;
	readonly entryIndex?: number;
}

interface WorkerResponse {
	readonly id: number;
	readonly synced?: boolean;
	readonly ok?: WorkerOk;
	readonly error?: WorkerError;
}

class NeedProfileError extends Error {
	readonly entryIndex: number;
	constructor(entryIndex: number) {
		super("Storage profile lookup required");
		this.entryIndex = entryIndex;
	}
}

class MissingTreeError extends Error {
	constructor() {
		super("Synced tree snapshot not found");
	}
}

interface PendingCall {
	readonly resolve: (resp: WorkerResponse) => void;
	readonly reject: (error: Error) => void;
}

interface SyncedTreeSnapshot {
	readonly snapshotId: number;
	readonly generation: number;
	readonly revision: number;
	readonly entries: readonly TreeEntry[];
	inUse: number;
	retired: boolean;
}

export interface AcquireSnapshotOptions {
	readonly missedSnapshotId?: number;
	readonly serving?: () => void;
}

export interface NativeSearchWorkerOptions {
	readonly folderProgram: string;
	readonly storageRoot: string;
	readonly indexMiB?: number;
	readonly threads?: number;
	readonly log?: (line: string) => void;
}

export interface NativeSearchSource {
	readonly tree: ViewTree;
	readonly links?: boolean;
	readonly cachedProfile?: () => string | undefined;
	resolveProfile(entry: TreeEntry): Promise<string>;
	readonly now: () => number;
	readonly serving?: () => void;
	readonly log?: (line: string) => void;
	readonly sliceMs?: number;
	readonly pieceBytes?: number;
	readonly longestLine?: number;
}

function isPlainAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c) return false;
	}
	return true;
}

function jsonInnerBytes(text: string): number {
	return isPlainAscii(text) ? text.length : Buffer.byteLength(JSON.stringify(text)) - 2;
}

function authorityExtraBytes(authority: CoreReceipt | undefined): number {
	if (authority === undefined) return 0;
	let cached = authorityBytesCache.get(authority);
	if (cached === undefined) {
		cached = 13 + Buffer.byteLength(JSON.stringify(authority));
		authorityBytesCache.set(authority, cached);
	}
	return cached;
}

function readEncodedBytes(entry: TreeEntry): number {
	if (entry.version === "") return 0;
	return (
		34 +
		jsonInnerBytes(entry.path) +
		entry.kind.length +
		jsonInnerBytes(entry.version) +
		authorityExtraBytes(entry.authority)
	);
}

function toWorkerEntry(idx: number, entry: TreeEntry): WorkerEntry {
	const k: 0 | 1 | 2 = entry.kind === "file" ? 0 : entry.kind === "folder" ? 1 : 2;
	const rb = readEncodedBytes(entry);
	if (entry.kind === "file" && entry.bytes > 0) {
		return {
			i: idx,
			k,
			p: entry.path,
			v: entry.version,
			...(entry.manifestSha256 === undefined ? {} : { m: entry.manifestSha256 }),
			...(entry.fileSha256 === undefined ? {} : { f: entry.fileSha256 }),
			b: entry.bytes,
			...(entry.mediaType === undefined ? {} : { t: entry.mediaType }),
			x: entry.executable,
			rb,
		};
	}
	return {
		i: idx,
		k,
		p: entry.path,
		v: entry.version,
		...(entry.kind === "symlink" && entry.target !== undefined ? { tg: entry.target } : {}),
		rb,
	};
}

function hasOverlongName(path: string): boolean {
	if (path.length <= 85) return false;
	for (const seg of path.split("/")) {
		if (Buffer.byteLength(seg) > 255) return true;
	}
	return false;
}

function treePathOrder(a: string, b: string): number {
	if (a === b) return 0;
	if (a === "") return -1;
	if (b === "") return 1;
	let ai = 0;
	let bi = 0;
	while (true) {
		const aSlash = a.indexOf("/", ai);
		const bSlash = b.indexOf("/", bi);
		const aEnd = aSlash < 0 ? a.length : aSlash;
		const bEnd = bSlash < 0 ? b.length : bSlash;
		const ord = byteOrder(a.slice(ai, aEnd), b.slice(bi, bEnd));
		if (ord !== 0) return ord;
		if (aSlash < 0 && bSlash < 0) return 0;
		if (aSlash < 0) return -1;
		if (bSlash < 0) return 1;
		ai = aSlash + 1;
		bi = bSlash + 1;
	}
}

function lowerBoundPath(entries: readonly TreeEntry[], path: string): number {
	let lo = 0;
	let hi = entries.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (treePathOrder(entries[mid]!.path, path) < 0) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function applyDeltas(
	base: readonly TreeEntry[],
	deltas: readonly TreeDelta[],
): { readonly entries: TreeEntry[]; readonly upserts: WorkerEntry[]; readonly removes: string[] } {
	const upserts: WorkerEntry[] = [];
	const removes: string[] = [];
	if (deltas.length <= 8) {
		const next = base.slice();
		for (const delta of deltas) {
			const pos = lowerBoundPath(next, delta.path);
			const exists = pos < next.length && next[pos]!.path === delta.path;
			if (delta.entry === undefined) {
				if (exists) next.splice(pos, 1);
				removes.push(delta.path);
			} else {
				if (exists) next[pos] = delta.entry;
				else next.splice(pos, 0, delta.entry);
				upserts.push(toWorkerEntry(0, delta.entry));
			}
		}
		return { entries: next, upserts, removes };
	}
	const pending = new Map<string, TreeEntry | undefined>();
	for (const delta of deltas) {
		pending.set(delta.path, delta.entry);
		if (delta.entry === undefined) removes.push(delta.path);
		else upserts.push(toWorkerEntry(0, delta.entry));
	}
	const kept: TreeEntry[] = [];
	for (let i = 0; i < base.length; i++) {
		const entry = base[i]!;
		if (pending.has(entry.path)) {
			const replacement = pending.get(entry.path);
			pending.delete(entry.path);
			if (replacement !== undefined) kept.push(replacement);
		} else {
			kept.push(entry);
		}
	}
	const inserted: TreeEntry[] = [];
	for (const entry of pending.values()) {
		if (entry !== undefined) inserted.push(entry);
	}
	if (inserted.length === 0) return { entries: kept, upserts, removes };
	inserted.sort((a, b) => treePathOrder(a.path, b.path));
	const merged: TreeEntry[] = [];
	let ki = 0;
	let ii = 0;
	while (ki < kept.length && ii < inserted.length) {
		if (treePathOrder(kept[ki]!.path, inserted[ii]!.path) <= 0) merged.push(kept[ki++]!);
		else merged.push(inserted[ii++]!);
	}
	while (ki < kept.length) merged.push(kept[ki++]!);
	while (ii < inserted.length) merged.push(inserted[ii++]!);
	return { entries: merged, upserts, removes };
}

function expandReadRanges(entries: readonly TreeEntry[], ranges: readonly number[] | undefined): SearchRead[] {
	if (!ranges || ranges.length === 0) return [];
	const out: SearchRead[] = [];
	for (let i = 0; i + 1 < ranges.length; i += 2) {
		const start = ranges[i]!;
		const end = start + ranges[i + 1]!;
		for (let j = start; j < end; j++) {
			const entry = entries[j]!;
			out.push({
				path: entry.path,
				kind: entry.kind,
				version: entry.version,
				...(entry.authority === undefined ? {} : { authority: entry.authority }),
			});
		}
	}
	return out;
}

export class NativeSearchWorker {
	readonly #folderProgram: string;
	readonly #storageRoot: string;
	readonly #indexMiB: number;
	readonly #threads: number;
	readonly #log: ((line: string) => void) | undefined;
	#proc: ChildProcessWithoutNullStreams | undefined;
	#generation = 0;
	#nextId = 1;
	#nextSnapshotId = 1;
	readonly #pending = new Map<number, PendingCall>();
	readonly #snapshots = new WeakMap<ViewTree, SyncedTreeSnapshot>();
	readonly #inFlight = new WeakMap<ViewTree, Promise<SyncedTreeSnapshot>>();
	readonly #finalizer: FinalizationRegistry<{ readonly generation: number; readonly snapshotId: number }>;
	#chunks: Buffer[] = [];
	#buffered = 0;
	#expectedLen = 0;
	#stderr = "";
	#closed = false;

	constructor(options: NativeSearchWorkerOptions) {
		this.#folderProgram = options.folderProgram;
		this.#storageRoot = options.storageRoot;
		this.#indexMiB = options.indexMiB ?? DEFAULT_INDEX_MIB;
		this.#threads = options.threads ?? DEFAULT_THREADS;
		this.#log = options.log;
		this.#finalizer = new FinalizationRegistry(({ generation, snapshotId }) => {
			if (!this.#closed && this.#proc && this.#generation === generation) {
				this.#sendDropTree(snapshotId);
			}
		});
	}

	get pid(): number | undefined {
		return this.#proc?.pid;
	}

	async acquireSnapshot(tree: ViewTree, options: AcquireSnapshotOptions = {}): Promise<SyncedTreeSnapshot> {
		if (this.#closed) throw new ObjectUnavailableError("Search worker is closed");
		const { missedSnapshotId, serving } = options;
		for (let round = 0; round < 4; round++) {
			this.#ensureRunning();
			const generation = this.#generation;
			const current = this.#snapshots.get(tree);
			if (
				current &&
				current.generation === generation &&
				current.revision === tree.revision &&
				current.snapshotId !== missedSnapshotId
			) {
				current.inUse++;
				return current;
			}
			const inflight = this.#inFlight.get(tree);
			if (inflight) {
				try {
					const synced = await inflight;
					if (
						synced.generation === this.#generation &&
						synced.snapshotId !== missedSnapshotId &&
						!synced.retired
					) {
						synced.inUse++;
						return synced;
					}
				} catch (error) {
					if (!(error instanceof MissingTreeError)) throw error;
				}
				continue;
			}
			const promise = this.#syncOrPatch(tree, generation, current, missedSnapshotId, serving);
			this.#inFlight.set(tree, promise);
			try {
				const synced = await promise;
				if (synced.generation === this.#generation && synced.snapshotId !== missedSnapshotId && !synced.retired) {
					synced.inUse++;
					return synced;
				}
			} catch (error) {
				if (!(error instanceof MissingTreeError)) throw error;
			} finally {
				if (this.#inFlight.get(tree) === promise) this.#inFlight.delete(tree);
			}
		}
		throw new ObjectUnavailableError("Search snapshot could not be synchronized");
	}

	releaseSnapshot(snapshot: SyncedTreeSnapshot): void {
		if (snapshot.inUse > 0) snapshot.inUse--;
		if (
			snapshot.retired &&
			snapshot.inUse === 0 &&
			!this.#closed &&
			this.#proc &&
			this.#generation === snapshot.generation
		) {
			this.#sendDropTree(snapshot.snapshotId);
		}
	}

	async search(frame: Omit<SearchFrame, "op" | "id">): Promise<WorkerOk> {
		const resp = await this.#sendFrame({ op: "search", ...frame });
		if (resp.ok) return resp.ok;
		throw new ObjectUnavailableError("Search worker sent an empty response");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const proc = this.#proc;
		this.#proc = undefined;
		this.#chunks = [];
		this.#buffered = 0;
		this.#expectedLen = 0;
		this.#stderr = "";
		const closedError = new ObjectUnavailableError("Search worker is closed");
		for (const call of this.#pending.values()) call.reject(closedError);
		this.#pending.clear();
		if (!proc) return;
		this.#terminate(proc, true);
	}

	async #syncOrPatch(
		tree: ViewTree,
		generation: number,
		base: SyncedTreeSnapshot | undefined,
		missedSnapshotId: number | undefined,
		serving: (() => void) | undefined,
	): Promise<SyncedTreeSnapshot> {
		if (
			base &&
			base.generation === generation &&
			base.snapshotId !== missedSnapshotId &&
			base.revision >= 0 &&
			base.revision !== tree.revision
		) {
			const targetRev = tree.revision;
			const deltas = tree.changesSince(base.revision);
			if (deltas !== undefined && deltas.length > 0 && !deltas.some((d) => hasOverlongName(d.path))) {
				const { entries, upserts, removes } = applyDeltas(base.entries, deltas);
				const snapshotId = this.#nextSnapshotId++;
				try {
					await this.#sendFrame({
						op: "patchTree",
						baseSnapshotId: base.snapshotId,
						snapshotId,
						upserts,
						removes,
					});
					const next: SyncedTreeSnapshot = {
						snapshotId,
						generation,
						revision: targetRev,
						entries,
						inUse: 0,
						retired: false,
					};
					this.#installSnapshot(tree, next, base);
					return next;
				} catch (error) {
					if (!(error instanceof MissingTreeError)) throw error;
				}
			}
		}
		return this.#fullSync(tree, generation, base, serving);
	}

	async #fullSync(
		tree: ViewTree,
		generation: number,
		previous: SyncedTreeSnapshot | undefined,
		serving: (() => void) | undefined,
	): Promise<SyncedTreeSnapshot> {
		const startRevision = tree.revision;
		const snapshotId = this.#nextSnapshotId++;
		const entries: TreeEntry[] = [];
		let chunk: WorkerEntry[] = [];
		let firstChunk = true;
		let walked = 0;
		let turnAt = performance.now();
		try {
			for (const entry of tree.walk("")) {
				entries.push(entry);
				chunk.push(toWorkerEntry(entries.length - 1, entry));
				walked++;
				if (chunk.length >= SYNC_CHUNK_ENTRIES) {
					await this.#sendFrame({
						op: "syncTree",
						snapshotId,
						append: !firstChunk,
						entries: chunk,
					});
					firstChunk = false;
					chunk = [];
					serving?.();
					await nextTurn();
					turnAt = performance.now();
				} else if ((walked & 255) === 0 && performance.now() - turnAt >= TURN_MS) {
					serving?.();
					await nextTurn();
					turnAt = performance.now();
				}
			}
			if (chunk.length > 0 || firstChunk) {
				await this.#sendFrame({
					op: "syncTree",
					snapshotId,
					append: !firstChunk,
					entries: chunk,
				});
				firstChunk = false;
			}
		} catch (error) {
			if (!firstChunk && !this.#closed && this.#proc && this.#generation === generation) {
				this.#sendDropTree(snapshotId);
			}
			throw error;
		}

		let finalId = snapshotId;
		let finalEntries = entries;
		let finalRevision = startRevision;
		if (tree.revision !== startRevision) {
			const endRevision = tree.revision;
			const deltas = tree.changesSince(startRevision);
			if (deltas !== undefined && deltas.length > 0 && !deltas.some((d) => hasOverlongName(d.path))) {
				const patched = applyDeltas(entries, deltas);
				const patchedId = this.#nextSnapshotId++;
				try {
					await this.#sendFrame({
						op: "patchTree",
						baseSnapshotId: snapshotId,
						snapshotId: patchedId,
						upserts: patched.upserts,
						removes: patched.removes,
					});
					if (!this.#closed && this.#proc && this.#generation === generation) {
						this.#sendDropTree(snapshotId);
					}
					finalId = patchedId;
					finalEntries = patched.entries;
					finalRevision = endRevision;
				} catch (error) {
					if (!this.#closed && this.#proc && this.#generation === generation) {
						this.#sendDropTree(snapshotId);
					}
					throw error;
				}
			} else {
				finalRevision = -1;
			}
		}

		const next: SyncedTreeSnapshot = {
			snapshotId: finalId,
			generation,
			revision: finalRevision,
			entries: finalEntries,
			inUse: 0,
			retired: false,
		};
		this.#installSnapshot(tree, next, previous);
		return next;
	}

	#installSnapshot(tree: ViewTree, next: SyncedTreeSnapshot, previous: SyncedTreeSnapshot | undefined): void {
		this.#snapshots.set(tree, next);
		this.#finalizer.unregister(tree);
		this.#finalizer.register(tree, { generation: next.generation, snapshotId: next.snapshotId }, tree);
		if (previous && previous.generation === next.generation && previous.snapshotId !== next.snapshotId) {
			previous.retired = true;
			if (previous.inUse === 0 && !this.#closed && this.#proc && this.#generation === previous.generation) {
				this.#sendDropTree(previous.snapshotId);
			}
		}
	}

	#sendDropTree(snapshotId: number): void {
		const proc = this.#proc;
		if (!proc || this.#closed) return;
		const frame: DropTreeFrame = { op: "dropTree", id: 0, snapshotId };
		const payload = Buffer.from(JSON.stringify(frame), "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(payload.byteLength, 0);
		try {
			proc.stdin.write(header);
			proc.stdin.write(payload);
		} catch {}
	}

	#sendFrame(
		request: Omit<SearchFrame, "id"> | Omit<SyncTreeFrame, "id"> | Omit<PatchTreeFrame, "id">,
	): Promise<WorkerResponse> {
		if (this.#closed) return Promise.reject(new ObjectUnavailableError("Search worker is closed"));
		const proc = this.#ensureRunning();
		const id = this.#nextId++;
		const payload = Buffer.from(JSON.stringify({ id, ...request }), "utf8");
		if (payload.byteLength === 0 || payload.byteLength > MAX_FRAME_BYTES) {
			return Promise.reject(new ObjectUnavailableError("Search request frame exceeds worker limit"));
		}
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(payload.byteLength, 0);
		return new Promise<WorkerResponse>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			try {
				proc.stdin.write(header);
				proc.stdin.write(payload);
			} catch (error) {
				this.#failProc(proc, new ObjectUnavailableError(`Search worker write failed: ${(error as Error).message}`));
			}
		});
	}

	#ensureRunning(): ChildProcessWithoutNullStreams {
		if (this.#proc) return this.#proc;
		const args = [
			"search-worker",
			"--storage-root",
			this.#storageRoot,
			"--index-mib",
			String(this.#indexMiB),
			"--threads",
			String(this.#threads),
		];
		// WHY: isolate child env from service credentials and cap glibc malloc arenas for bounded RSS.
		const proc = spawn(this.#folderProgram, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LC_ALL: "C",
				MALLOC_ARENA_MAX: "2",
			},
		});
		this.#proc = proc;
		this.#generation++;
		this.#chunks = [];
		this.#buffered = 0;
		this.#expectedLen = 0;
		this.#stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => this.#onStdout(proc, chunk));
		proc.stderr.on("data", (chunk: Buffer) => this.#onStderr(proc, chunk));
		proc.stdin.on("error", (error: Error) => {
			this.#failProc(proc, new ObjectUnavailableError(`Search worker stdin error: ${error.message}`));
		});
		proc.on("error", (error: Error) => {
			this.#failProc(proc, new ObjectUnavailableError(`Search worker failed: ${error.message}`));
		});
		proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			this.#failProc(proc, new ObjectUnavailableError(`Search worker exited (${signal ?? code ?? "unknown"})`));
		});
		return proc;
	}

	#onStderr(proc: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (this.#proc !== proc) return;
		if (this.#stderr.length >= MAX_STDERR_BYTES) return;
		const text = chunk.toString("utf8");
		this.#stderr += text.slice(0, MAX_STDERR_BYTES - this.#stderr.length);
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length > 0) this.#log?.(`folder-service: search-worker: ${trimmed}`);
		}
	}

	#onStdout(proc: ChildProcessWithoutNullStreams, chunk: Buffer): void {
		if (this.#proc !== proc) return;
		if (chunk.byteLength === 0) return;
		this.#chunks.push(chunk);
		this.#buffered += chunk.byteLength;
		while (this.#buffered >= 4) {
			if (this.#expectedLen === 0) {
				let head = this.#chunks[0]!;
				if (head.byteLength < 4) {
					head = Buffer.concat(this.#chunks, this.#buffered);
					this.#chunks = [head];
				}
				const len = head.readUInt32BE(0);
				if (len === 0 || len > MAX_FRAME_BYTES) {
					this.#failProc(proc, new ObjectUnavailableError("Search worker sent an invalid frame length"));
					return;
				}
				this.#expectedLen = len;
			}
			if (this.#buffered < 4 + this.#expectedLen) return;
			const len = this.#expectedLen;
			this.#expectedLen = 0;
			const buf = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#buffered);
			const payload = buf.subarray(4, 4 + len);
			const remainder = buf.subarray(4 + len);
			this.#chunks = remainder.byteLength > 0 ? [remainder] : [];
			this.#buffered = remainder.byteLength;
			let parsed: WorkerResponse;
			try {
				parsed = JSON.parse(payload.toString("utf8")) as WorkerResponse;
			} catch {
				this.#failProc(proc, new ObjectUnavailableError("Search worker sent malformed JSON"));
				return;
			}
			const pending = this.#pending.get(parsed.id);
			if (!pending) continue;
			this.#pending.delete(parsed.id);
			if (parsed.error) {
				if (parsed.error.kind === "pattern") pending.reject(new SearchPatternError(parsed.error.message));
				else if (parsed.error.kind === "missing_tree") pending.reject(new MissingTreeError());
				else if (parsed.error.kind === "need_profile" && parsed.error.entryIndex !== undefined)
					pending.reject(new NeedProfileError(parsed.error.entryIndex));
				else pending.reject(new ObjectUnavailableError(parsed.error.message));
			} else {
				pending.resolve(parsed);
			}
		}
	}

	#failProc(proc: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.#proc !== proc) return;
		this.#proc = undefined;
		this.#chunks = [];
		this.#buffered = 0;
		this.#expectedLen = 0;
		const detail = this.#stderr.trim();
		this.#stderr = "";
		if (!this.#closed) {
			const suffix = detail.length > 0 ? ` (${detail.split("\n")[0]})` : "";
			this.#log?.(`folder-service: ${error.message}${suffix}`);
		}
		for (const call of this.#pending.values()) call.reject(error);
		this.#pending.clear();
		this.#terminate(proc, false);
	}

	#terminate(proc: ChildProcessWithoutNullStreams, graceful: boolean): void {
		try {
			proc.stdin.end();
		} catch {}
		if (proc.exitCode !== null || proc.signalCode !== null) return;
		if (!graceful) {
			try {
				proc.kill("SIGTERM");
			} catch {}
		}
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const termTimer = setTimeout(() => {
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			try {
				proc.kill(graceful ? "SIGTERM" : "SIGKILL");
			} catch {}
			if (graceful) {
				killTimer = setTimeout(() => {
					if (proc.exitCode !== null || proc.signalCode !== null) return;
					try {
						proc.kill("SIGKILL");
					} catch {}
				}, STOP_KILL_MS);
				killTimer.unref();
			}
		}, STOP_KILL_MS);
		termTimer.unref();
		proc.once("exit", () => {
			clearTimeout(termTimer);
			if (killTimer) clearTimeout(killTimer);
		});
	}
}

export async function searchViewNative(
	worker: NativeSearchWorker,
	source: NativeSearchSource,
	request: SearchRequest,
): Promise<SearchAnswer> {
	const v2 = request.version === 2;
	const useRegex = v2 && request.regex;
	const filesOnly = v2 && request.filesOnly;
	const context = v2 ? request.context : 0;
	const links = source.links ?? false;
	const sliceMs = source.sliceMs ?? SEARCH_SLICE_MS;
	const deadline = source.now() + sliceMs;

	let activeSnapshot: SyncedTreeSnapshot | undefined = await worker.acquireSnapshot(source.tree, {
		serving: source.serving,
	});
	source.serving?.();
	let profileId: string | null = source.cachedProfile?.() ?? null;

	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const snapshot = activeSnapshot;
			try {
				const ok = await worker.search({
					snapshotId: snapshot.snapshotId,
					profileId,
					version: request.version,
					query: request.query,
					regex: useRegex,
					path: request.path,
					glob: request.glob,
					namesOnly: request.namesOnly,
					filesOnly,
					caseSensitive: request.caseSensitive,
					context,
					links,
					after: request.after,
					sliceMs: Math.max(0, Math.ceil(deadline - source.now())),
					...(source.longestLine === undefined ? {} : { longestLine: source.longestLine }),
					...(source.pieceBytes === undefined ? {} : { pieceBytes: source.pieceBytes }),
				});
				source.serving?.();
				for (const line of ok.logs) source.log?.(line);
				const reads = expandReadRanges(snapshot.entries, ok.readRanges);
				return v2
					? {
							hits: ok.hits,
							files: ok.files,
							searched: ok.searched,
							binary: ok.binary,
							unreadable: ok.unreadable,
							longLines: ok.longLines,
							reads,
							next: ok.next,
						}
					: {
							hits: ok.hits,
							searched: ok.searched,
							binary: ok.binary,
							unreadable: ok.unreadable,
							reads,
							next: ok.next,
						};
			} catch (error) {
				if (error instanceof MissingTreeError) {
					const missedSnapshotId = snapshot.snapshotId;
					worker.releaseSnapshot(snapshot);
					activeSnapshot = undefined;
					activeSnapshot = await worker.acquireSnapshot(source.tree, {
						missedSnapshotId,
						serving: source.serving,
					});
					source.serving?.();
					continue;
				}
				if (error instanceof NeedProfileError && profileId === null) {
					const target = snapshot.entries[error.entryIndex];
					if (!target) throw new ObjectUnavailableError("Search worker referenced an unknown entry");
					profileId = await source.resolveProfile(target);
					source.serving?.();
					continue;
				}
				throw error;
			}
		}
		throw new ObjectUnavailableError("Search could not complete after snapshot retries");
	} finally {
		if (activeSnapshot !== undefined) worker.releaseSnapshot(activeSnapshot);
	}
}
