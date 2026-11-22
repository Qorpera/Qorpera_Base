import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { createInflate } from "node:zlib";
import { CARRIES, SecretRefusal, type SecretScan, type SecretSet, UNCHECKED } from "./secret-scan.ts";

/** How a saved file's bytes are read for the check. */
export type StoredForm = "plain" | "loose" | "pack" | "sha256-pack";

const LOOSE_NAME = /(?:^|\/)objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/;
const PACK_NAME = /(?:^|\/)objects\/pack\/pack-([0-9a-f]{40}|[0-9a-f]{64})\.pack$/;

/** A path's form, by its name alone: an object's temporary name (`tmp_obj_*`, `tmp_pack_*`) is plain, and is read again
 * once git moves or links it to its own (`formChanged`), even once the temporary name was saved. */
export function storedForm(path: string): StoredForm {
	if (LOOSE_NAME.test(path)) return "loose";
	const pack = PACK_NAME.exec(path);
	if (pack) return pack[1]?.length === 64 ? "sha256-pack" : "pack";
	return "plain";
}

/** Whether bytes saved at `from` are read again when a move, rename or hard link gives them the name `to`: `to` stores
 * them in a git form `from` did not (a temporary name's object, at its own). */
export function formChanged(from: string, to: string): boolean {
	const form = storedForm(to);
	return form !== "plain" && form !== storedForm(from);
}

/** One file's check: its stored bytes pushed in order, then `end`. Either rejects with `SecretRefusal` once the file
 * carries a value or cannot be checked; any other error means the check could not run now (the file waits). `abort`
 * stops a check that will not end, and what it started goes with it. */
export interface ContentCheck {
	push(chunk: Buffer): Promise<void>;
	end(): Promise<void>;
	abort(): Promise<void>;
}

/** A loose object's content git writes at most: a larger header is refused as not checked. */
const LOOSE_MAX = 1024 ** 3;
/** The longest a loose object's header ("commit 1073741824", say) can be. */
const HEADER_MAX = 32;
const LOOSE_HEADER = /^(?:blob|tree|commit|tag) (0|[1-9][0-9]{0,9})$/;
const BATCH_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (?:blob|tree|commit|tag) (0|[1-9][0-9]{0,12})$/;
const BATCH_LINE_MAX = 256;

/** How packs are read. The defaults are the node's, from what packs of code rebuild to and how fast the service scans
 * (RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"). */
export interface PackReading {
	readonly git?: string;
	/** util-linux's prlimit, which runs git under the memory limit. */
	readonly prlimit?: string;
	readonly folderProgram?: string | undefined;
	/** Where each check's scratch repository is made: the unit's own /tmp, a tmpfs counted in its memory. */
	readonly scratch?: string;
	/** One check's whole time, git's and the scan's, from when it holds its turn. */
	readonly timeoutMs?: number;
	/** The address space git may take. */
	readonly memoryBytes?: number;
	/** Checks of packs at once on the node; the others wait their turn. */
	readonly atOnce?: number;
	readonly runningBytes?: number;
	/** Checks of packs that may wait for a turn at once, and the bytes of their packs together. A check past either is
	 * refused as not checked now (`SecretRefusal.again`), and its file is checked again at the next boundary. */
	readonly waitingMax?: number;
	readonly waitingBytes?: number;
	/** The largest pack read: its copy in the scratch repository is in memory. */
	readonly packMax?: number;
	/** What one pack's objects may come to rebuilt: this many times the pack's size, or `rebuiltFloor`, whichever is
	 * more, and never more than `rebuiltMax`. The factor bounds a pack whose deltas rebuild far more than packs of code
	 * do; the most, how long the scan of a large one takes, so whether a pack is read whole never depends on the node's
	 * load (the time bound is only for git that hangs). */
	readonly rebuiltFactor?: number;
	readonly rebuiltFloor?: number;
	readonly rebuiltMax?: number;
	readonly cleanOidCacheMax?: number;
	readonly nativeStreamMinBytes?: number;
	readonly streamAtOnce?: number;
}

type ResolvedPackReading = Omit<Required<PackReading>, "folderProgram"> & {
	readonly folderProgram: string | undefined;
};

const NATIVE_AT_ONCE = 2;
const NATIVE_STREAM_AT_ONCE = 16;
const SCAN_RESULT_MAX = 4096;
const NATIVE_STREAM_MIN_BYTES = 64 * 1024;
const CLEAN_OID_CACHE_MAX = 250_000;
const DELTA_BATCH_MAX = 65_536;
const MAX_EXCLUDE_OIDS_BYTES = 64 * 1024 * 1024;
const IDX_V2_MAGIC = 0xff744f63;
const IDX_V2_HEADER_LEN = 8 + 256 * 4;
const MAX_IDX_OBJECTS = 20_000_000;
const IDX_YIELD_INTERVAL = 8192;
const DELTA_OIDS_CHUNK_BYTES = 64 * 1024;

const READING: ResolvedPackReading = {
	git: "/usr/bin/git",
	prlimit: "/usr/bin/prlimit",
	folderProgram: undefined,
	scratch: tmpdir(),
	timeoutMs: 30 * 60 * 1000,
	memoryBytes: 1024 ** 3,
	atOnce: 1,
	runningBytes: 512 * 1024 ** 2,
	waitingMax: 32,
	waitingBytes: 2 * 1024 ** 3,
	packMax: 512 * 1024 ** 2,
	rebuiltFactor: 64,
	rebuiltFloor: 256 * 1024 ** 2,
	rebuiltMax: 4 * 1024 ** 3,
	cleanOidCacheMax: CLEAN_OID_CACHE_MAX,
	nativeStreamMinBytes: NATIVE_STREAM_MIN_BYTES,
	streamAtOnce: NATIVE_STREAM_AT_ONCE,
};

/** The save check for each form: one per node, so its pack checks take turns. */
export class SaveChecks {
	readonly #reading: ResolvedPackReading;
	readonly #turns: Turns;
	readonly #streamTurns: StreamTurns;
	readonly #cleanOids: CleanOidCache;

	constructor(reading: PackReading = {}) {
		const folderProgram = reading.folderProgram;
		this.#reading = {
			...READING,
			...reading,
			atOnce: reading.atOnce ?? (folderProgram ? NATIVE_AT_ONCE : READING.atOnce),
			folderProgram,
		};
		this.#turns = new Turns(
			this.#reading.atOnce,
			this.#reading.runningBytes,
			this.#reading.waitingMax,
			this.#reading.waitingBytes,
		);
		this.#streamTurns = new StreamTurns(this.#reading.streamAtOnce);
		this.#cleanOids = new CleanOidCache(this.#reading.cleanOidCacheMax);
	}

	/** The check of a file of `size` bytes stored in `form`, for `secrets`. With no values there is nothing to look for,
	 * and nothing is read. */
	start(secrets: SecretSet, size: number, form: StoredForm): ContentCheck {
		if (secrets.size === 0) return new PlainCheck(secrets.scan(size));
		if (form === "plain") {
			if (this.#reading.folderProgram && Number.isSafeInteger(size) && size >= this.#reading.nativeStreamMinBytes) {
				return new NativeStreamScan(
					this.#reading,
					this.#reading.folderProgram,
					secrets,
					size,
					"/",
					this.#reading.timeoutMs,
					false,
					this.#streamTurns,
				);
			}
			return new PlainCheck(secrets.scan(size));
		}
		if (form === "loose") return new LooseCheck(this.#reading, this.#streamTurns, secrets, size);
		return new PackCheck(this.#reading, this.#turns, this.#cleanOids, secrets, size, form === "sha256-pack");
	}
}

class NativeStreamScan implements ContentCheck {
	readonly #reading: ResolvedPackReading;
	readonly #folderProgram: string;
	readonly #secrets: SecretSet;
	readonly #rebuiltMax: number;
	readonly #cwd: string;
	readonly #timeoutMs: number | undefined;
	readonly #skipAccessCheck: boolean;
	readonly #streamTurns: StreamTurns | undefined;
	#proc: Git | undefined;
	#timer: NodeJS.Timeout | undefined;
	#starting: Promise<Git | undefined> | undefined;
	#cancelTurn: (() => void) | undefined;
	#release: (() => void) | undefined;
	#aborting: Promise<void> | undefined;
	#failure: Error | undefined;
	#stdoutChunks: Buffer[] = [];
	#stdoutBytes = 0;
	#stdoutOverflow = false;
	#stdinFailed = false;
	#ending = false;
	#aborted = false;

	constructor(
		reading: ResolvedPackReading,
		folderProgram: string,
		secrets: SecretSet,
		rebuiltMax: number,
		cwd: string,
		timeoutMs: number | undefined,
		skipAccessCheck: boolean,
		streamTurns?: StreamTurns,
	) {
		this.#reading = reading;
		this.#folderProgram = folderProgram;
		this.#secrets = secrets;
		this.#rebuiltMax = Math.max(0, Math.floor(rebuiltMax));
		this.#cwd = cwd;
		this.#timeoutMs = timeoutMs;
		this.#skipAccessCheck = skipAccessCheck;
		this.#streamTurns = streamTurns;
	}

	async push(chunk: Buffer): Promise<void> {
		this.#throwIfFailed();
		if (chunk.length === 0) return;
		const proc = await this.#ensureStarted();
		if (!proc) {
			this.#throwIfFailed();
			return;
		}
		await writeWritable(proc.child.stdin, chunk);
		if (this.#failure) throw this.#failure;
		if (this.#stdinFailed) {
			const code = await proc.closed;
			const error = this.#exitError(code, false) ?? new SecretRefusal(UNCHECKED);
			this.#fail(error);
			throw this.#failure!;
		}
	}

	async end(): Promise<void> {
		try {
			this.#throwIfFailed();
			if (!this.#starting) return;
			const proc = await this.#starting;
			this.#throwIfFailed();
			if (!proc) return;
			this.#ending = true;
			await endWritable(proc.child.stdin);
			const code = await proc.closed;
			this.#clearTimer();
			if (this.#failure) throw this.#failure;
			const error = this.#exitError(code, true);
			if (error) {
				this.#fail(error);
				throw this.#failure!;
			}
		} finally {
			await this.abort();
		}
	}

	kill(): void {
		this.#clearTimer();
		if (this.#proc) kill(this.#proc);
	}

	abort(): Promise<void> {
		this.#aborted = true;
		this.#clearTimer();
		this.#cancelTurn?.();
		this.#cancelTurn = undefined;
		this.#aborting ??= (async () => {
			const proc = await this.#starting?.catch(() => undefined);
			if (proc) {
				kill(proc);
				await proc.closed;
			}
			this.#releaseTurn();
		})();
		return this.#aborting;
	}

	#ensureStarted(): Promise<Git | undefined> {
		this.#starting ??= this.#start();
		return this.#starting;
	}

	async #start(): Promise<Git | undefined> {
		if (this.#aborted || this.#failure) return undefined;
		if (this.#streamTurns) {
			const pending = this.#streamTurns.take();
			this.#cancelTurn = pending.cancel;
			let release: () => void;
			try {
				release = await pending.promise;
			} finally {
				this.#cancelTurn = undefined;
			}
			this.#release = release;
			if (this.#aborted || this.#failure) {
				this.#releaseTurn();
				return undefined;
			}
		}
		try {
			if (!this.#skipAccessCheck) {
				await access(this.#reading.prlimit, constants.X_OK);
				if (!(await stat(this.#reading.prlimit)).isFile())
					throw new Error("prlimit could not be started for the save check");
				await access(this.#folderProgram, constants.X_OK);
				if (!(await stat(this.#folderProgram)).isFile())
					throw new Error("folder program could not be started for the save check");
			}
			if (this.#aborted || this.#failure) {
				this.#releaseTurn();
				return undefined;
			}
			const child = spawn(
				this.#reading.prlimit,
				[`--as=${this.#reading.memoryBytes}`, "--", this.#folderProgram, "scan-stream", "--spec-fd", "3"],
				{
					cwd: this.#cwd,
					env: { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
					stdio: ["pipe", "pipe", "pipe", "pipe"],
					detached: true,
				},
			);
			child.stderr?.resume();
			// WHY: scan-stream closes stdin immediately on secret detection; classify via exit status and stdout JSON instead of failing EPIPE as unchecked.
			child.stdin?.on("error", () => {
				this.#stdinFailed = true;
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				this.#stdoutBytes += chunk.length;
				if (this.#stdoutBytes > SCAN_RESULT_MAX) {
					this.#stdoutOverflow = true;
					this.#fail(new SecretRefusal(UNCHECKED));
					return;
				}
				this.#stdoutChunks.push(chunk);
			});
			const closed = new Promise<number | null>((resolve) => {
				let done = false;
				const finish = (code: number | null): void => {
					if (done) return;
					done = true;
					this.#clearTimer();
					resolve(code);
				};
				child.once("error", () => {
					this.#fail(new Error("folder program could not be started for the save check"));
					finish(null);
				});
				child.once("close", (code) => finish(code));
			});
			const proc: Git = { child, closed };
			this.#proc = proc;
			void closed.finally(() => this.#releaseTurn());
			if (this.#timeoutMs !== undefined) {
				this.#timer = setTimeout(() => {
					this.#fail(new SecretRefusal(UNCHECKED));
				}, this.#timeoutMs);
			}
			const specStream = child.stdio[3] as Writable | null;
			if (!specStream) {
				this.#fail(new Error("folder program spec pipe was unavailable for the save check"));
			} else {
				specStream.on("error", () => undefined);
				specStream.end(JSON.stringify({ ...this.#secrets.toSpec(), rebuiltMax: this.#rebuiltMax }));
			}
			void closed.then((code) => {
				if (this.#aborted || this.#ending || this.#failure) return;
				this.#fail(this.#exitError(code, false) ?? new SecretRefusal(UNCHECKED));
			});
			if (this.#aborted || this.#failure) kill(proc);
			return proc;
		} catch (error) {
			this.#releaseTurn();
			throw error;
		}
	}

	#releaseTurn(): void {
		const release = this.#release;
		this.#release = undefined;
		release?.();
	}

	#exitError(code: number | null, allowClean: boolean): Error | undefined {
		if (code === 1 || code === 2 || code === 126 || code === 127) {
			return new Error("folder program could not run scan-stream for the save check");
		}
		if (code !== 0 || this.#stdoutOverflow) return new SecretRefusal(UNCHECKED);
		const result = parseScanResult(Buffer.concat(this.#stdoutChunks).toString("utf8"));
		if (result === "secret") return new SecretRefusal(CARRIES);
		if (allowClean && result === "clean" && !this.#stdinFailed) return undefined;
		return new SecretRefusal(UNCHECKED);
	}

	#clearTimer(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#fail(failure: Error): void {
		this.#failure ??= failure;
		this.kill();
	}

	#throwIfFailed(): void {
		if (this.#failure) throw this.#failure;
		if (this.#aborted) throw new SecretRefusal(UNCHECKED);
	}
}

/** The stored bytes alone, as every file not named as git's is checked. */
class PlainCheck implements ContentCheck {
	readonly #scan: SecretScan;

	constructor(scan: SecretScan) {
		this.#scan = scan;
	}

	push(chunk: Buffer): Promise<void> {
		return this.#scan.pushAsync(chunk);
	}

	end(): Promise<void> {
		this.#scan.end();
		return Promise.resolve();
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}
}

/** A loose object: one zlib stream of "<type> <size>\0" and the content. Its stored bytes are scanned, and the content
 * they inflate to as well. Anything but one whole stream (bad zlib, bytes after its end, a cut-off end) holding one
 * header and exactly the content its size gives is refused as not checked. */
class LooseCheck implements ContentCheck {
	readonly #reading: ResolvedPackReading;
	readonly #streamTurns: StreamTurns;
	readonly #secrets: SecretSet;
	readonly #storedJs: SecretScan | undefined;
	readonly #storedNative: NativeStreamScan | undefined;
	readonly #inflate = createInflate({ chunkSize: 64 * 1024 });
	readonly #ended: Promise<void>;
	#headerParsed = false;
	#contentJs: SecretScan | undefined;
	#contentNative: NativeStreamScan | undefined;
	#contentWork: Promise<void> = Promise.resolve();
	#contentPending = 0;
	#turnAcquire: Promise<() => void> | undefined;
	#cancelTurn: (() => void) | undefined;
	#releaseTurn: (() => void) | undefined;
	#aborting: Promise<void> | undefined;
	#header = Buffer.alloc(0);
	/** Content bytes still due. */
	#due = 0;
	#fed = 0;
	#failure: Error | undefined;
	#aborted = false;

	constructor(reading: ResolvedPackReading, streamTurns: StreamTurns, secrets: SecretSet, size: number) {
		this.#reading = reading;
		this.#streamTurns = streamTurns;
		this.#secrets = secrets;
		if (reading.folderProgram && Number.isSafeInteger(size) && size >= reading.nativeStreamMinBytes) {
			this.#storedNative = new NativeStreamScan(
				reading,
				reading.folderProgram,
				secrets,
				size,
				"/",
				reading.timeoutMs,
				false,
			);
		} else {
			this.#storedJs = secrets.scan(size);
		}
		this.#inflate.on("error", () => {
			this.#failure ??= new SecretRefusal(UNCHECKED);
		});
		this.#inflate.on("data", (out: Buffer) => {
			if (this.#failure || this.#aborted) return;
			try {
				this.#take(out);
			} catch (error) {
				this.#failure ??= error instanceof SecretRefusal ? error : new SecretRefusal(UNCHECKED);
				this.#inflate.destroy();
			}
		});
		this.#ended = finished(this.#inflate);
		this.#ended.catch(() => undefined);
	}

	async push(chunk: Buffer): Promise<void> {
		this.#throwIfFailed();
		if (this.#storedNative) {
			if (chunk.length > 0) {
				await this.#ensureStreamTurn();
				await this.#storedNative.push(chunk);
			}
		} else {
			await this.#storedJs!.pushAsync(chunk);
		}
		this.#throwIfFailed();
		this.#fed += chunk.length;
		await this.#write(chunk);
		await this.#contentWork;
		this.#throwIfFailed();
		// What zlib did not take is past the stream's end.
		if (this.#inflate.bytesWritten !== this.#fed) throw new SecretRefusal(UNCHECKED);
	}

	async end(): Promise<void> {
		try {
			if (this.#storedNative) await this.#storedNative.end();
			else this.#storedJs!.end();
			this.#throwIfFailed();
			this.#inflate.end();
			await this.#ended.catch(() => {
				this.#failure ??= new SecretRefusal(UNCHECKED);
			});
			await this.#contentWork;
			this.#throwIfFailed();
			if (this.#inflate.bytesWritten !== this.#fed || !this.#headerParsed || this.#due !== 0)
				throw new SecretRefusal(UNCHECKED);
			if (this.#contentNative) await this.#contentNative.end();
			else this.#contentJs?.end();
		} finally {
			await this.abort();
		}
	}

	abort(): Promise<void> {
		this.#aborted = true;
		this.#cancelTurn?.();
		this.#cancelTurn = undefined;
		this.#aborting ??= (async () => {
			this.#inflate.destroy();
			this.#storedNative?.kill();
			this.#contentNative?.kill();
			await this.#contentWork;
			await Promise.all([
				this.#storedNative?.abort() ?? Promise.resolve(),
				this.#contentNative?.abort() ?? Promise.resolve(),
			]);
			const release = this.#releaseTurn ?? (await this.#turnAcquire?.catch(() => undefined));
			this.#releaseTurn = undefined;
			release?.();
		})();
		return this.#aborting;
	}

	async #ensureStreamTurn(): Promise<void> {
		if (this.#releaseTurn) return;
		if (!this.#turnAcquire) {
			// WHY: stored and inflated scan-stream processes share one StreamTurns permit so streamAtOnce=1 cannot deadlock.
			const pending = this.#streamTurns.take();
			this.#cancelTurn = pending.cancel;
			this.#turnAcquire = pending.promise.then((release) => {
				this.#cancelTurn = undefined;
				if (this.#aborted) {
					release();
					throw new SecretRefusal(UNCHECKED);
				}
				this.#releaseTurn = release;
				return release;
			});
		}
		await this.#turnAcquire;
	}

	/** Resolves once zlib took the chunk, or the stream ended. */
	#write(chunk: Buffer): Promise<void> {
		const inflate = this.#inflate;
		if (inflate.destroyed) return Promise.resolve();
		return new Promise((resolve) => {
			const done = (): void => {
				inflate.off("close", done);
				resolve();
			};
			inflate.once("close", done);
			inflate.write(chunk, done);
		});
	}

	#take(out: Buffer): void {
		let content = out;
		if (!this.#headerParsed) {
			const nul = out.indexOf(0);
			const header = Buffer.concat([this.#header, nul < 0 ? out : out.subarray(0, nul)]);
			if (header.length > HEADER_MAX) throw new SecretRefusal(UNCHECKED);
			if (nul < 0) {
				this.#header = header;
				return;
			}
			const size = Number(LOOSE_HEADER.exec(header.toString("latin1"))?.[1] ?? Number.NaN);
			if (!(size <= LOOSE_MAX)) throw new SecretRefusal(UNCHECKED);
			this.#headerParsed = true;
			if (this.#reading.folderProgram && size >= this.#reading.nativeStreamMinBytes) {
				this.#contentNative = new NativeStreamScan(
					this.#reading,
					this.#reading.folderProgram,
					this.#secrets,
					size,
					"/",
					this.#reading.timeoutMs,
					false,
				);
			} else {
				this.#contentJs = this.#secrets.scan(size);
			}
			this.#due = size;
			content = out.subarray(nul + 1);
		}
		if (content.length > this.#due) throw new SecretRefusal(UNCHECKED);
		this.#due -= content.length;
		if (content.length === 0) return;
		if (this.#contentNative) {
			const native = this.#contentNative;
			// WHY: copy zlib output before async pipe write and pause inflate so backpressure bounds memory.
			const copy = Buffer.from(content);
			this.#contentPending++;
			this.#inflate.pause();
			this.#contentWork = this.#contentWork.then(async () => {
				try {
					if (!this.#failure && !this.#aborted) {
						await this.#ensureStreamTurn();
						if (!this.#failure && !this.#aborted) await native.push(copy);
					}
				} catch (error) {
					this.#failure ??= error instanceof Error ? error : new SecretRefusal(UNCHECKED);
					this.#inflate.destroy();
				} finally {
					this.#contentPending--;
					if (this.#contentPending === 0 && !this.#failure && !this.#aborted && !this.#inflate.destroyed) {
						this.#inflate.resume();
					}
				}
			});
			return;
		}
		this.#contentJs?.push(content);
	}

	#throwIfFailed(): void {
		if (this.#failure) throw this.#failure;
		if (this.#aborted) throw new SecretRefusal(UNCHECKED);
	}
}

/** Turns for the node's pack checks: at most `atOnce` at a time, the rest in order, at most `waitingMax` of them with
 * at most `waitingBytes` of packs together; one past either is refused as not checked now. */
class Turns {
	readonly #atOnce: number;
	readonly #runningBytes: number;
	readonly #waitingMax: number;
	readonly #waitingBytes: number;
	readonly #waiting: { readonly bytes: number; readonly go: () => void }[] = [];
	#running = 0;
	#runningFor = 0;
	#waitingFor = 0;

	constructor(atOnce: number, runningBytes: number, waitingMax: number, waitingBytes: number) {
		this.#atOnce = atOnce;
		this.#runningBytes = runningBytes;
		this.#waitingMax = waitingMax;
		this.#waitingBytes = waitingBytes;
	}

	#canRun(bytes: number): boolean {
		return this.#running < this.#atOnce && (this.#running === 0 || this.#runningFor + bytes <= this.#runningBytes);
	}

	/** A turn for the check of a pack of `bytes`. */
	async take(bytes: number): Promise<() => void> {
		if (this.#waiting.length === 0 && this.#canRun(bytes)) {
			this.#running++;
			this.#runningFor += bytes;
		} else if (this.#waiting.length >= this.#waitingMax || this.#waitingFor + bytes > this.#waitingBytes)
			throw new SecretRefusal(UNCHECKED, true);
		else {
			this.#waitingFor += bytes;
			await new Promise<void>((go) => this.#waiting.push({ bytes, go }));
		}
		let given = false;
		return () => {
			if (given) return;
			given = true;
			this.#running--;
			this.#runningFor -= bytes;
			while (this.#waiting.length > 0 && this.#canRun((this.#waiting[0] as { readonly bytes: number }).bytes)) {
				const next = this.#waiting.shift() as { readonly bytes: number; readonly go: () => void };
				this.#waitingFor -= next.bytes;
				this.#running++;
				this.#runningFor += next.bytes;
				next.go();
			}
		};
	}
}

class StreamTurns {
	readonly #atOnce: number;
	readonly #waiting: {
		readonly go: () => void;
		readonly cancel: (error: Error) => void;
	}[] = [];
	#running = 0;

	constructor(atOnce: number) {
		this.#atOnce = Number.isFinite(atOnce) ? Math.max(1, Math.floor(atOnce)) : NATIVE_STREAM_AT_ONCE;
	}

	take(): { readonly promise: Promise<() => void>; readonly cancel: () => void } {
		if (this.#running < this.#atOnce && this.#waiting.length === 0) {
			this.#running++;
			return { promise: Promise.resolve(this.#releaser()), cancel: () => undefined };
		}
		let entry: { readonly go: () => void; readonly cancel: (error: Error) => void } | undefined;
		let settled = false;
		const promise = new Promise<() => void>((resolve, reject) => {
			entry = {
				go: () => {
					settled = true;
					resolve(this.#releaser());
				},
				cancel: (error: Error) => {
					settled = true;
					reject(error);
				},
			};
			this.#waiting.push(entry);
		});
		return {
			promise,
			cancel: () => {
				if (settled || !entry) return;
				const index = this.#waiting.indexOf(entry);
				if (index >= 0) this.#waiting.splice(index, 1);
				entry.cancel(new SecretRefusal(UNCHECKED));
			},
		};
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#running--;
			while (this.#running < this.#atOnce && this.#waiting.length > 0) {
				const next = this.#waiting.shift() as { readonly go: () => void; readonly cancel: (error: Error) => void };
				this.#running++;
				next.go();
			}
		};
	}
}

/** A pack: git reads it, and each object it holds is scanned whole, deltas resolved; its stored bytes are scanned too.
 * A pack git cannot read whole, a thin one included, one larger than the bound, or one whose objects rebuild to more
 * than the bound, is refused as not checked. */
class PackCheck implements ContentCheck {
	readonly #reading: ResolvedPackReading;
	readonly #turns: Turns;
	readonly #cleanOids: CleanOidCache;
	readonly #secrets: SecretSet;
	readonly #stored: SecretScan | undefined;
	readonly #size: number;
	readonly #sha256: boolean;
	#run: Promise<PackRun> | undefined;
	#fed = 0;

	constructor(
		reading: ResolvedPackReading,
		turns: Turns,
		cleanOids: CleanOidCache,
		secrets: SecretSet,
		size: number,
		sha256: boolean,
	) {
		this.#reading = reading;
		this.#turns = turns;
		this.#cleanOids = cleanOids;
		this.#secrets = secrets;
		this.#stored = reading.folderProgram ? undefined : secrets.scan(size);
		this.#size = size;
		this.#sha256 = sha256;
	}

	async push(chunk: Buffer): Promise<void> {
		if (this.#stored) await this.#stored.pushAsync(chunk);
		this.#fed += chunk.length;
		await (await this.#started()).feed(chunk);
	}

	async end(): Promise<void> {
		this.#stored?.end();
		const run = await this.#started();
		try {
			await run.finish(this.#fed);
		} finally {
			await run.close();
		}
	}

	async abort(): Promise<void> {
		const run = await this.#run?.catch(() => undefined);
		await run?.close();
	}

	#started(): Promise<PackRun> {
		if (this.#size > this.#reading.packMax) return Promise.reject(new SecretRefusal(UNCHECKED));
		const { rebuiltFactor, rebuiltFloor, rebuiltMax } = this.#reading;
		const rebuilt = Math.min(rebuiltMax, Math.max(rebuiltFloor, rebuiltFactor * this.#size));
		this.#run ??= PackRun.start(
			this.#reading,
			this.#turns.take(this.#size),
			this.#cleanOids,
			this.#sha256,
			this.#secrets,
			this.#size,
			rebuilt,
		);
		return this.#run;
	}
}

/** git as one check runs it: with no configuration but the scratch repository's, which has no hooks and no remotes. */
function gitEnv(dir: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/local/bin:/usr/bin:/bin",
		HOME: dir,
		XDG_CONFIG_HOME: dir,
		GIT_DIR: dir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
	};
}

/** A git process of one check's, and its end: its exit code, or null once killed or never started. */
interface Git {
	readonly child: ChildProcess;
	readonly closed: Promise<number | null>;
}

/** One pack's check in its turn: a scratch repository the pack is indexed into and read back from, object by object,
 * removed however the check ends. Past the time bound the run ends itself, so a check left waiting gives its turn back. */
class PackRun {
	readonly #reading: ResolvedPackReading;
	readonly #dir: string;
	readonly #release: () => void;
	readonly #cleanOids: CleanOidCache;
	readonly #sha256: boolean;
	readonly #secrets: SecretSet;
	readonly #rebuilt: number;
	readonly #rawScan: NativeStreamScan | undefined;
	readonly #timer: NodeJS.Timeout;
	readonly #running = new Set<Git>();
	#index: Git | undefined;
	/** Why the run stopped: a `SecretRefusal` if the pack could not be checked, any other error if git could not run. */
	#failure: Error | undefined;
	#closing = false;
	#closed: Promise<void> | undefined;

	private constructor(
		reading: ResolvedPackReading,
		dir: string,
		release: () => void,
		cleanOids: CleanOidCache,
		sha256: boolean,
		secrets: SecretSet,
		size: number,
		rebuilt: number,
	) {
		this.#reading = reading;
		this.#dir = dir;
		this.#release = release;
		this.#cleanOids = cleanOids;
		this.#sha256 = sha256;
		this.#secrets = secrets;
		this.#rebuilt = rebuilt;
		this.#rawScan = reading.folderProgram
			? new NativeStreamScan(reading, reading.folderProgram, secrets, size, dir, undefined, true)
			: undefined;
		this.#timer = setTimeout(() => {
			this.#fail(new SecretRefusal(UNCHECKED));
			void this.close();
		}, reading.timeoutMs);
	}

	/** Waits for its turn and makes the scratch repository. A failure to make it is not the pack's: it rejects with a
	 * plain error, and the file waits. No turn while too many wait rejects as not checked now. */
	static async start(
		reading: ResolvedPackReading,
		turn: Promise<() => void>,
		cleanOids: CleanOidCache,
		sha256: boolean,
		secrets: SecretSet,
		size: number,
		rebuilt: number,
	): Promise<PackRun> {
		const release = await turn;
		let dir: string | undefined;
		try {
			await access(reading.git, constants.X_OK);
			await access(reading.prlimit, constants.X_OK);
			if (reading.folderProgram) {
				await access(reading.folderProgram, constants.X_OK);
				if (!(await stat(reading.folderProgram)).isFile())
					throw new Error("folder program could not be started for the save check");
			}
			dir = await mkdtemp(join(reading.scratch, "qorpera-save-check-"));
			for (const sub of ["objects/pack", "objects/info", "refs"]) await mkdir(join(dir, sub), { recursive: true });
			await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
			await writeFile(
				join(dir, "config"),
				[
					"[core]",
					`\trepositoryformatversion = ${sha256 ? 1 : 0}`,
					"\tbare = true",
					"\thooksPath = /dev/null",
					"\tpackedGitWindowSize = 32m",
					"\tpackedGitLimit = 256m",
					"\tdeltaBaseCacheLimit = 96m",
					"[pack]",
					"\tthreads = 2",
					"[gc]",
					"\tauto = 0",
					...(sha256 ? ["[extensions]", "\tobjectFormat = sha256"] : []),
					"",
				].join("\n"),
			);
			return new PackRun(reading, dir, release, cleanOids, sha256, secrets, size, rebuilt);
		} catch (error) {
			if (dir) await rm(dir, { recursive: true, force: true });
			release();
			throw error;
		}
	}

	/** Gives index-pack the pack's next bytes. */
	async feed(chunk: Buffer): Promise<void> {
		this.#throwIfFailed();
		if (this.#rawScan) {
			await Promise.all([
				written(this.#indexPack(), chunk),
				this.#rawScan.push(chunk).catch((error: unknown) => {
					this.#fail(error instanceof Error ? error : new SecretRefusal(UNCHECKED));
					throw error;
				}),
			]);
		} else {
			await written(this.#indexPack(), chunk);
		}
		this.#throwIfFailed();
	}

	/** The run's index-pack, started at the pack's first bytes (or at its end, for a pack of none). */
	#indexPack(): Git {
		this.#index ??= this.#spawnGit(["index-pack", "--stdin", "--threads=2"], ["pipe", "pipe", "pipe"], true, true);
		return this.#index;
	}

	/** Ends the pack and reads every object of it back. `fed`: the pack's whole size. Once the run stopped, whatever
	 * fails after is why it stopped. */
	async finish(fed: number): Promise<void> {
		try {
			await this.#finish(fed);
		} catch (error) {
			throw this.#failure ?? error;
		}
	}

	async #finish(fed: number): Promise<void> {
		this.#throwIfFailed();
		const index = this.#indexPack();
		index.child.stdin?.end();
		const [indexed] = await Promise.all([index.closed, this.#rawScan ? this.#rawScan.end() : Promise.resolve()]);
		this.#throwIfFailed();
		if (indexed !== 0) throw new SecretRefusal(UNCHECKED);
		// On a pipe index-pack stops at the pack's own end, and never reads what follows: its copy must be every byte.
		const packs = (await readdir(join(this.#dir, "objects/pack"))).filter((name) => name.endsWith(".pack"));
		const packName = packs.length === 1 ? (packs[0] as string) : undefined;
		const copy = packName ? await stat(join(this.#dir, "objects/pack", packName)) : undefined;
		if (!packName || copy?.size !== fed) throw new SecretRefusal(UNCHECKED);
		this.#throwIfFailed();
		const idx = this.#cleanOids.enabled ? await this.#readIdx(packName) : undefined;
		this.#throwIfFailed();
		const digest = this.#secrets.digest;
		if (idx && this.#cleanOids.hasDigest(digest)) {
			const { deltaIndices, cachedIndices } = await this.#cleanOids.partitionIndices(digest, idx);
			this.#throwIfFailed();
			if (deltaIndices.length === 0) return;
			if (cachedIndices.length > 0) {
				let mode: PackScanMode;
				if (deltaIndices.length * 2 <= idx.total && deltaIndices.length <= DELTA_BATCH_MAX) {
					await sortIndicesByPackOffset(idx, deltaIndices);
					this.#throwIfFailed();
					mode = { kind: "delta", idx, deltaIndices };
				} else {
					mode = { kind: "all", idx, excludeIndices: cachedIndices };
				}
				if (this.#reading.folderProgram) {
					await this.#scanNative(this.#reading.folderProgram, mode);
				} else {
					await this.#scanJs(mode);
				}
				await this.#cleanOids.recordIndices(digest, idx, deltaIndices);
				return;
			}
		}
		if (this.#reading.folderProgram) {
			await this.#scanNative(this.#reading.folderProgram, { kind: "all" });
		} else {
			await this.#scanJs({ kind: "all" });
		}
		if (idx) await this.#cleanOids.recordIdx(digest, idx);
	}

	async #readIdx(packName: string): Promise<ParsedIdx | undefined> {
		const idxPath = join(this.#dir, "objects/pack", `${packName.slice(0, -".pack".length)}.idx`);
		try {
			return await parseIdxV2(await readFile(idxPath), this.#sha256);
		} catch {
			return undefined;
		}
	}

	async #feedIndices(
		stream: Writable | null,
		idx: ParsedIdx,
		indices: readonly number[],
		maxCount = indices.length,
	): Promise<boolean> {
		if (!stream) return false;
		let writeFailed = false;
		stream.on("error", () => {
			writeFailed = true;
		});
		const { oidLen, oids } = idx;
		const count = Math.min(indices.length, maxCount);
		const lines: string[] = [];
		let chunkBytes = 0;
		let sinceYield = 0;
		for (let i = 0; i < count; i++) {
			if (this.#failure || this.#closing || writeFailed || stream.destroyed) return false;
			const off = (indices[i] as number) * oidLen;
			const hex = oids.toString("hex", off, off + oidLen);
			lines.push(`${hex}\n`);
			chunkBytes += hex.length + 1;
			sinceYield++;
			if (chunkBytes >= DELTA_OIDS_CHUNK_BYTES) {
				await writeWritable(stream, Buffer.from(lines.join(""), "ascii"));
				lines.length = 0;
				chunkBytes = 0;
				sinceYield = 0;
			} else if (sinceYield >= IDX_YIELD_INTERVAL) {
				sinceYield = 0;
				await yieldLoop();
			}
		}
		if (this.#failure || this.#closing || writeFailed || stream.destroyed) return false;
		if (lines.length > 0) {
			await writeWritable(stream, Buffer.from(lines.join(""), "ascii"));
		}
		await endWritable(stream);
		return !writeFailed;
	}

	async #scanJs(mode: PackScanMode): Promise<void> {
		let excludedHex: Set<string> | undefined;
		if (mode.kind === "all" && mode.idx && mode.excludeIndices && mode.excludeIndices.length > 0) {
			excludedHex = new Set<string>();
			const { oidLen, oids } = mode.idx;
			for (let i = 0; i < mode.excludeIndices.length; i++) {
				if (i > 0 && (i & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
				const off = (mode.excludeIndices[i] as number) * oidLen;
				excludedHex.add(oids.toString("hex", off, off + oidLen));
			}
			this.#throwIfFailed();
		}
		const isDelta = mode.kind === "delta";
		const batch = new Batch(this.#secrets.scan(this.#rebuilt), this.#rebuilt, excludedHex);
		const catArgs = isDelta
			? ["cat-file", "--batch", "--buffer"]
			: ["cat-file", "--batch-all-objects", "--batch", "--unordered"];
		const cat = this.#spawnGit(catArgs, ["pipe", "pipe", "pipe"], true, !isDelta);
		let deltaFed: Promise<boolean>;
		if (isDelta) {
			deltaFed = this.#feedIndices(cat.child.stdin, mode.idx, mode.deltaIndices);
		} else {
			cat.child.stdin?.end();
			deltaFed = Promise.resolve(true);
		}
		cat.child.stdout?.on("data", (chunk: Buffer) => {
			if (this.#failure) return;
			try {
				batch.take(chunk);
			} catch (error) {
				this.#fail(error instanceof SecretRefusal ? error : new SecretRefusal(UNCHECKED));
			}
		});
		const [read, fedAll] = await Promise.all([cat.closed, deltaFed]);
		this.#throwIfFailed();
		if (read !== 0 || !fedAll || !batch.whole || (isDelta && batch.count !== mode.deltaIndices.length))
			throw new SecretRefusal(UNCHECKED);
	}

	async #scanNative(folderProgram: string, mode: PackScanMode): Promise<void> {
		const isDelta = mode.kind === "delta";
		const hasExcludes =
			mode.kind === "all" && Boolean(mode.idx && mode.excludeIndices && mode.excludeIndices.length > 0);
		const catArgs = isDelta
			? ["cat-file", "--batch", "--buffer"]
			: ["cat-file", "--batch-all-objects", "--batch", "--unordered"];
		const cat = this.#spawnGit(catArgs, [isDelta ? "pipe" : "ignore", "pipe", "pipe"], false, false);
		const catStdout = cat.child.stdout;
		if (!catStdout) {
			kill(cat);
			await cat.closed;
			throw new Error("git stdout pipe was unavailable for the save check");
		}
		catStdout.on("error", () => undefined);
		const scanArgs = hasExcludes
			? ["scan-pack", "--spec-fd", "3", "--exclude-oids-fd", "4"]
			: ["scan-pack", "--spec-fd", "3"];
		const scanStdio: StdioOptions = hasExcludes
			? [catStdout, "pipe", "pipe", "pipe", "pipe"]
			: [catStdout, "pipe", "pipe", "pipe"];
		let scanner: Git;
		try {
			scanner = this.#spawnProgram(
				folderProgram,
				scanArgs,
				{ PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
				scanStdio,
				"folder program could not be started for the save check",
				false,
				false,
			);
		} catch (error) {
			catStdout.destroy();
			kill(cat);
			await cat.closed;
			throw error;
		}
		catStdout.destroy();
		const chunks: Buffer[] = [];
		let stdoutBytes = 0;
		let overflow = false;
		scanner.child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > SCAN_RESULT_MAX) {
				overflow = true;
				this.#fail(new SecretRefusal(UNCHECKED));
				return;
			}
			chunks.push(chunk);
		});
		const specStream = scanner.child.stdio[3] as Writable | null;
		if (!specStream) {
			this.#fail(new Error("folder program spec pipe was unavailable for the save check"));
		} else {
			specStream.on("error", () => undefined);
			specStream.end(JSON.stringify({ ...this.#secrets.toSpec(), rebuiltMax: this.#rebuilt }));
		}
		const excludeStream = hasExcludes ? (scanner.child.stdio[4] as Writable | null) : null;
		if (hasExcludes && !excludeStream) {
			this.#fail(new Error("folder program exclude pipe was unavailable for the save check"));
		}
		const deltaFed = isDelta
			? this.#feedIndices(cat.child.stdin, mode.idx, mode.deltaIndices)
			: Promise.resolve(true);
		const excludeFed =
			hasExcludes && mode.kind === "all" && mode.idx && mode.excludeIndices
				? this.#feedIndices(
						excludeStream,
						mode.idx,
						mode.excludeIndices,
						Math.floor(MAX_EXCLUDE_OIDS_BYTES / (mode.idx.oidLen * 2 + 1)),
					)
				: Promise.resolve(true);
		const scanned = await scanner.closed;
		const cleanup = async (): Promise<void> => {
			kill(cat);
			excludeStream?.destroy();
			await Promise.all([cat.closed, deltaFed, excludeFed]);
		};
		if (this.#failure) {
			await cleanup();
			throw this.#failure;
		}
		if (scanned === 1 || scanned === 2 || scanned === 126 || scanned === 127) {
			await cleanup();
			throw new Error("folder program could not run scan-pack for the save check");
		}
		if (scanned !== 0 || overflow) {
			await cleanup();
			throw new SecretRefusal(UNCHECKED);
		}
		const result = parseScanResult(Buffer.concat(chunks).toString("utf8"));
		if (result === "secret") {
			await cleanup();
			throw new SecretRefusal(CARRIES);
		}
		if (result !== "clean") {
			await cleanup();
			throw new SecretRefusal(UNCHECKED);
		}
		const [read, fedDelta, fedExclude] = await Promise.all([cat.closed, deltaFed, excludeFed]);
		this.#throwIfFailed();
		if (read !== 0 || !fedDelta || !fedExclude) throw new SecretRefusal(UNCHECKED);
	}

	/** Stops what still runs, removes the scratch repository and gives the turn back; once, whatever came before. */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			this.#closing = true;
			clearTimeout(this.#timer);
			try {
				const running = [...this.#running];
				for (const proc of running) kill(proc);
				this.#rawScan?.kill();
				await Promise.all([...running.map((proc) => proc.closed), this.#rawScan?.abort() ?? Promise.resolve()]);
				await rm(this.#dir, { recursive: true, force: true });
			} finally {
				this.#release();
			}
		})();
		return this.#closed;
	}

	#spawnGit(args: readonly string[], stdio: StdioOptions, resumeStdout: boolean, failOnStdinError: boolean): Git {
		return this.#spawnProgram(
			this.#reading.git,
			args,
			gitEnv(this.#dir),
			stdio,
			"git could not be started for the save check",
			resumeStdout,
			failOnStdinError,
		);
	}

	#spawnProgram(
		program: string,
		args: readonly string[],
		env: NodeJS.ProcessEnv,
		stdio: StdioOptions,
		startError: string,
		resumeStdout: boolean,
		failOnStdinError: boolean,
	): Git {
		// Its own process group, so a kill takes all of it.
		const child = spawn(this.#reading.prlimit, [`--as=${this.#reading.memoryBytes}`, "--", program, ...args], {
			cwd: this.#dir,
			env,
			stdio,
			detached: true,
		});
		// What git says is never logged: it may name what the pack holds.
		child.stderr?.resume();
		if (resumeStdout) child.stdout?.resume();
		if (failOnStdinError) {
			// A pipe that breaks under a running git is the pack's (git stopped reading it); one that never ran is not.
			child.stdin?.on("error", () => {
				if (child.pid !== undefined) this.#fail(new SecretRefusal(UNCHECKED));
			});
		}
		const closed = new Promise<number | null>((resolve) => {
			let done = false;
			const finish = (code: number | null): void => {
				if (done) return;
				done = true;
				resolve(code);
			};
			child.once("error", () => {
				this.#fail(new Error(startError));
				finish(null);
			});
			child.once("close", (code) => finish(code));
		});
		const proc: Git = { child, closed };
		this.#running.add(proc);
		void closed.finally(() => this.#running.delete(proc));
		if (this.#failure || this.#closing) kill(proc);
		return proc;
	}

	#fail(failure: Error): void {
		this.#failure ??= failure;
		this.#rawScan?.kill();
		for (const proc of this.#running) kill(proc);
	}

	#throwIfFailed(): void {
		if (this.#failure) throw this.#failure;
		if (this.#closing) throw new SecretRefusal(UNCHECKED);
	}
}

type PackScanMode =
	| { readonly kind: "all"; readonly idx?: ParsedIdx; readonly excludeIndices?: readonly number[] }
	| { readonly kind: "delta"; readonly idx: ParsedIdx; readonly deltaIndices: readonly number[] };

interface ParsedIdx {
	readonly total: number;
	readonly oidLen: number;
	readonly oids: Buffer;
	readonly offsets32: Buffer;
	readonly offsets64: Buffer;
}

function yieldLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function parseIdxV2(buf: Buffer, sha256: boolean): Promise<ParsedIdx | undefined> {
	const oidLen = sha256 ? 32 : 20;
	const trailerLen = oidLen * 2;
	if (buf.length < IDX_V2_HEADER_LEN + trailerLen) return undefined;
	if (buf.readUInt32BE(0) !== IDX_V2_MAGIC || buf.readUInt32BE(4) !== 2) return undefined;
	let prev = 0;
	for (let i = 0; i < 256; i++) {
		const count = buf.readUInt32BE(8 + i * 4);
		if (count < prev) return undefined;
		prev = count;
	}
	const total = prev;
	if (total > MAX_IDX_OBJECTS) return undefined;
	const minSize = IDX_V2_HEADER_LEN + total * (oidLen + 8) + trailerLen;
	const largeBytes = buf.length - minSize;
	if (largeBytes < 0 || largeBytes % 8 !== 0) return undefined;
	const largeCount = largeBytes / 8;
	const oids = buf.subarray(IDX_V2_HEADER_LEN, IDX_V2_HEADER_LEN + total * oidLen);
	const offsets32Start = IDX_V2_HEADER_LEN + total * (oidLen + 4);
	const offsets32End = offsets32Start + total * 4;
	const offsets32 = buf.subarray(offsets32Start, offsets32End);
	const offsets64 = buf.subarray(offsets32End, buf.length - trailerLen);
	let lo = 0;
	let checked = 0;
	for (let bucket = 0; bucket < 256; bucket++) {
		const hi = buf.readUInt32BE(8 + bucket * 4);
		for (let idx = lo; idx < hi; idx++) {
			const curOff = idx * oidLen;
			if (oids[curOff] !== bucket) return undefined;
			if (idx > lo) {
				const prevOff = (idx - 1) * oidLen;
				let cmp = 0;
				for (let b = 0; b < oidLen; b++) {
					const diff = (oids[prevOff + b] as number) - (oids[curOff + b] as number);
					if (diff !== 0) {
						cmp = diff;
						break;
					}
				}
				if (cmp >= 0) return undefined;
			}
			const rawOff = offsets32.readUInt32BE(idx * 4);
			if (rawOff >= 0x80000000 && rawOff - 0x80000000 >= largeCount) return undefined;
			checked++;
			if ((checked & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
		}
		lo = hi;
	}
	return { total, oidLen, oids, offsets32, offsets64 };
}

function packOffsetOf(idx: ParsedIdx, index: number): number {
	const raw = idx.offsets32.readUInt32BE(index * 4);
	if (raw < 0x80000000) return raw;
	return Number(idx.offsets64.readBigUInt64BE((raw - 0x80000000) * 8));
}

async function sortIndicesByPackOffset(idx: ParsedIdx, indices: number[]): Promise<void> {
	const n = indices.length;
	if (n <= 1) return;
	let srcIdx = new Uint32Array(n);
	let srcOff = new Float64Array(n);
	let dstIdx = new Uint32Array(n);
	let dstOff = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		if (i > 0 && (i & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
		const entry = indices[i] as number;
		srcIdx[i] = entry;
		srcOff[i] = packOffsetOf(idx, entry);
	}
	let steps = 0;
	for (let width = 1; width < n; width *= 2) {
		for (let left = 0; left < n; left += width * 2) {
			const mid = Math.min(left + width, n);
			const right = Math.min(left + width * 2, n);
			let i = left;
			let j = mid;
			let k = left;
			while (i < mid && j < right) {
				if ((srcOff[i] as number) <= (srcOff[j] as number)) {
					dstIdx[k] = srcIdx[i] as number;
					dstOff[k] = srcOff[i] as number;
					i++;
				} else {
					dstIdx[k] = srcIdx[j] as number;
					dstOff[k] = srcOff[j] as number;
					j++;
				}
				k++;
			}
			while (i < mid) {
				dstIdx[k] = srcIdx[i] as number;
				dstOff[k] = srcOff[i] as number;
				i++;
				k++;
			}
			while (j < right) {
				dstIdx[k] = srcIdx[j] as number;
				dstOff[k] = srcOff[j] as number;
				j++;
				k++;
			}
			steps += right - left;
			if (steps >= IDX_YIELD_INTERVAL) {
				steps = 0;
				await yieldLoop();
			}
		}
		const tmpIdx = srcIdx;
		srcIdx = dstIdx;
		dstIdx = tmpIdx;
		const tmpOff = srcOff;
		srcOff = dstOff;
		dstOff = tmpOff;
	}
	for (let i = 0; i < n; i++) {
		if (i > 0 && (i & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
		indices[i] = srcIdx[i] as number;
	}
}

class CleanOidCache {
	readonly #max: number;
	readonly #byDigest = new Map<string, Set<string>>();
	#total = 0;

	constructor(max = CLEAN_OID_CACHE_MAX) {
		this.#max = Number.isSafeInteger(max) && max > 0 ? max : 0;
	}

	get enabled(): boolean {
		return this.#max > 0;
	}

	hasDigest(digest: string): boolean {
		return this.#max > 0 && (this.#byDigest.get(digest)?.size ?? 0) > 0;
	}

	async partitionIndices(
		digest: string,
		idx: ParsedIdx,
	): Promise<{ readonly deltaIndices: number[]; readonly cachedIndices: number[] }> {
		let set = this.#byDigest.get(digest);
		const deltaIndices: number[] = [];
		const cachedIndices: number[] = [];
		const { total, oidLen, oids } = idx;
		if (!set || set.size === 0) {
			for (let i = 0; i < total; i++) {
				if (i > 0 && (i & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
				deltaIndices.push(i);
			}
			return { deltaIndices, cachedIndices };
		}
		this.#byDigest.delete(digest);
		this.#byDigest.set(digest, set);
		for (let i = 0; i < total; i++) {
			if (i > 0 && (i & (IDX_YIELD_INTERVAL - 1)) === 0) {
				await yieldLoop();
				set = this.#byDigest.get(digest);
				if (!set || set.size === 0) {
					for (let j = i; j < total; j++) {
						if (j > i && ((j - i) & (IDX_YIELD_INTERVAL - 1)) === 0) await yieldLoop();
						deltaIndices.push(j);
					}
					return { deltaIndices, cachedIndices };
				}
			}
			const off = i * oidLen;
			const key = oids.toString("latin1", off, off + oidLen);
			if (set.has(key)) {
				set.delete(key);
				set.add(key);
				cachedIndices.push(i);
			} else {
				deltaIndices.push(i);
			}
		}
		return { deltaIndices, cachedIndices };
	}

	async recordIndices(digest: string, idx: ParsedIdx, indices: readonly number[]): Promise<void> {
		if (this.#max <= 0 || indices.length === 0) return;
		let set = this.#touchDigest(digest);
		const { oidLen, oids } = idx;
		const start = indices.length > this.#max ? indices.length - this.#max : 0;
		for (let i = start; i < indices.length; i++) {
			if (i > start && ((i - start) & (IDX_YIELD_INTERVAL - 1)) === 0) {
				await yieldLoop();
				set = this.#touchDigest(digest);
			}
			const off = (indices[i] as number) * oidLen;
			this.#insert(set, oids.toString("latin1", off, off + oidLen));
		}
	}

	async recordIdx(digest: string, idx: ParsedIdx): Promise<void> {
		if (this.#max <= 0 || idx.total === 0) return;
		let set = this.#touchDigest(digest);
		const { total, oidLen, oids } = idx;
		const start = total > this.#max ? total - this.#max : 0;
		for (let i = start; i < total; i++) {
			if (i > start && ((i - start) & (IDX_YIELD_INTERVAL - 1)) === 0) {
				await yieldLoop();
				set = this.#touchDigest(digest);
			}
			const off = i * oidLen;
			this.#insert(set, oids.toString("latin1", off, off + oidLen));
		}
	}

	#touchDigest(digest: string): Set<string> {
		let set = this.#byDigest.get(digest);
		if (set) {
			this.#byDigest.delete(digest);
			this.#byDigest.set(digest, set);
		} else {
			set = new Set<string>();
			this.#byDigest.set(digest, set);
		}
		return set;
	}

	#insert(set: Set<string>, key: string): void {
		if (set.has(key)) {
			set.delete(key);
			set.add(key);
			return;
		}
		set.add(key);
		this.#total++;
		while (this.#total > this.#max) {
			const oldest = this.#byDigest.entries().next().value;
			if (!oldest) break;
			const [oldDigest, oldSet] = oldest;
			const oldKey = oldSet.values().next().value;
			if (oldKey !== undefined) {
				oldSet.delete(oldKey);
				this.#total--;
			}
			if (oldSet.size === 0) this.#byDigest.delete(oldDigest);
		}
	}
}

function parseScanResult(text: string): "clean" | "secret" | "unchecked" {
	const trimmed = text.trim();
	if (!trimmed || trimmed.includes("\n")) return "unchecked";
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return "unchecked";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "unchecked";
	const status = (parsed as Record<string, unknown>).status;
	if (status === "secret") return "secret";
	if (status === "clean") {
		const rebuilt = (parsed as Record<string, unknown>).rebuilt;
		if (typeof rebuilt === "number" && Number.isSafeInteger(rebuilt) && rebuilt >= 0) return "clean";
	}
	return "unchecked";
}

/** Kills a git process's group while git itself has not exited (its group id is free for reuse after). */
function kill(git: Git): void {
	const pid = git.child.pid;
	if (pid === undefined || git.child.exitCode !== null || git.child.signalCode !== null) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Gone already.
	}
}

/** Resolves once the chunk is in git's pipe, or git's input closed. */
function written(git: Git, chunk: Buffer): Promise<void> {
	return writeWritable(git.child.stdin, chunk);
}

function writeWritable(stream: Writable | null, chunk: Buffer): Promise<void> {
	if (!stream || stream.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const done = (): void => {
			if (settled) return;
			settled = true;
			stream.off("close", done);
			stream.off("error", done);
			resolve();
		};
		stream.once("close", done);
		stream.once("error", done);
		stream.write(chunk, done);
	});
}

function endWritable(stream: Writable | null): Promise<void> {
	if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const done = (): void => {
			if (settled) return;
			settled = true;
			stream.off("close", done);
			stream.off("error", done);
			resolve();
		};
		stream.once("close", done);
		stream.once("error", done);
		stream.end(done);
	});
}

/** `cat-file --batch`'s output, read as it comes: per object "<oid> <type> <size>\n", the content and "\n". Each
 * object's content is scanned whole and by itself; the sizes count against what the pack may rebuild to. */
class Batch {
	readonly #scan: SecretScan;
	readonly #rebuiltMax: number;
	readonly #excludedHex: ReadonlySet<string> | undefined;
	#line = Buffer.alloc(0);
	/** The content bytes still due, then the newline after them; -1 between objects. */
	#due = -1;
	#skip = false;
	#rebuilt = 0;
	#count = 0;

	constructor(scan: SecretScan, rebuiltMax: number, excludedHex?: ReadonlySet<string>) {
		this.#scan = scan;
		this.#rebuiltMax = rebuiltMax;
		this.#excludedHex = excludedHex;
	}

	/** Every object read to its end. */
	get whole(): boolean {
		return this.#due === -1 && this.#line.length === 0;
	}

	get count(): number {
		return this.#count;
	}

	take(chunk: Buffer): void {
		let at = 0;
		while (at < chunk.length) {
			if (this.#due < 0) {
				const newline = chunk.indexOf(10, at);
				const part = chunk.subarray(at, newline < 0 ? chunk.length : newline);
				if (this.#line.length + part.length > BATCH_LINE_MAX) throw new SecretRefusal(UNCHECKED);
				this.#line = Buffer.concat([this.#line, part]);
				if (newline < 0) return;
				const match = BATCH_HEADER.exec(this.#line.toString("latin1"));
				const oid = match?.[1];
				const size = Number(match?.[2] ?? Number.NaN);
				this.#line = Buffer.alloc(0);
				if (!oid || !Number.isSafeInteger(size)) throw new SecretRefusal(UNCHECKED);
				const skip = this.#excludedHex?.has(oid) ?? false;
				if (!skip) {
					this.#rebuilt += size;
					if (!(this.#rebuilt <= this.#rebuiltMax)) throw new SecretRefusal(UNCHECKED);
				}
				this.#skip = skip;
				this.#due = size;
				at = newline + 1;
			} else if (this.#due > 0) {
				const take = Math.min(this.#due, chunk.length - at);
				if (!this.#skip) this.#scan.push(chunk.subarray(at, at + take));
				this.#due -= take;
				at += take;
			} else {
				if (chunk[at] !== 10) throw new SecretRefusal(UNCHECKED);
				if (!this.#skip) this.#scan.end();
				this.#skip = false;
				this.#due = -1;
				this.#count++;
				at++;
			}
		}
	}
}
