import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { createInflate } from "node:zlib";
import { SecretRefusal, type SecretScan, type SecretSet, UNCHECKED } from "./secret-scan.ts";

/**
 * The save check of what git stores (5j-5 (a); RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"). Git keeps what it is
 * given compressed, as a loose object or in a pack, so a value a session commits is not in the stored bytes as they
 * are. A saved file is read by its name's shape, wherever a coding machine saves it: `objects/xx/<38 or 62 hex>` is a
 * loose object, inflated; `objects/pack/pack-<40 or 64 hex>.pack` is a pack, which git itself reads in a scratch
 * repository of its own (`index-pack`, then `cat-file --batch-all-objects --batch`). Both are scanned as stored too, as
 * every other file is. What cannot be read whole is refused as not checked; the service never drops it itself.
 */

/** How a saved file's bytes are read for the check. */
export type StoredForm = "plain" | "loose" | "pack" | "sha256-pack";

const LOOSE_NAME = /(?:^|\/)objects\/[0-9a-f]{2}\/(?:[0-9a-f]{38}|[0-9a-f]{62})$/;
const PACK_NAME = /(?:^|\/)objects\/pack\/pack-([0-9a-f]{40}|[0-9a-f]{64})\.pack$/;

/** A path's form, by its name alone: an object's temporary name (`tmp_obj_*`, `tmp_pack_*`) is plain, and is read again
 * once git moves it to its own. */
export function storedForm(path: string): StoredForm {
	if (LOOSE_NAME.test(path)) return "loose";
	const pack = PACK_NAME.exec(path);
	if (pack) return pack[1]?.length === 64 ? "sha256-pack" : "pack";
	return "plain";
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
const BATCH_HEADER = /^(?:[0-9a-f]{40}|[0-9a-f]{64}) (?:blob|tree|commit|tag) (0|[1-9][0-9]{0,12})$/;
const BATCH_LINE_MAX = 256;

/** How packs are read. The defaults are the node's, from what packs of code rebuild to and how fast the service scans
 * (RUNTIME-FOLDER-CODING-MACHINES.md, "Masking"). */
export interface PackReading {
	readonly git?: string;
	/** util-linux's prlimit, which runs git under the memory limit. */
	readonly prlimit?: string;
	/** Where each check's scratch repository is made: the unit's own /tmp, a tmpfs counted in its memory. */
	readonly scratch?: string;
	/** One check's whole time, git's and the scan's, from when it holds its turn. */
	readonly timeoutMs?: number;
	/** The address space git may take. */
	readonly memoryBytes?: number;
	/** Checks of packs at once on the node; the others wait their turn. */
	readonly atOnce?: number;
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
}

const READING: Required<PackReading> = {
	git: "/usr/bin/git",
	prlimit: "/usr/bin/prlimit",
	scratch: tmpdir(),
	timeoutMs: 30 * 60 * 1000,
	memoryBytes: 1024 ** 3,
	atOnce: 1,
	waitingMax: 8,
	waitingBytes: 2 * 1024 ** 3,
	packMax: 512 * 1024 ** 2,
	rebuiltFactor: 64,
	rebuiltFloor: 256 * 1024 ** 2,
	rebuiltMax: 4 * 1024 ** 3,
};

/** The save check for each form: one per node, so its pack checks take turns. */
export class SaveChecks {
	readonly #reading: Required<PackReading>;
	readonly #turns: Turns;

	constructor(reading: PackReading = {}) {
		this.#reading = { ...READING, ...reading };
		this.#turns = new Turns(this.#reading.atOnce, this.#reading.waitingMax, this.#reading.waitingBytes);
	}

	/** The check of a file of `size` bytes stored in `form`, for `secrets`. With no values there is nothing to look for,
	 * and nothing is read. */
	start(secrets: SecretSet, size: number, form: StoredForm): ContentCheck {
		if (secrets.size === 0 || form === "plain") return new PlainCheck(secrets.scan(size));
		if (form === "loose") return new LooseCheck(secrets, size);
		return new PackCheck(this.#reading, this.#turns, secrets, size, form === "sha256-pack");
	}
}

/** The stored bytes alone, as every file not named as git's is checked. */
class PlainCheck implements ContentCheck {
	readonly #scan: SecretScan;

	constructor(scan: SecretScan) {
		this.#scan = scan;
	}

	push(chunk: Buffer): Promise<void> {
		this.#scan.push(chunk);
		return Promise.resolve();
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
	readonly #secrets: SecretSet;
	readonly #stored: SecretScan;
	readonly #inflate = createInflate({ chunkSize: 64 * 1024 });
	readonly #ended: Promise<void>;
	/** The content's scan, once the header is read; the header's bytes so far before that. */
	#content: SecretScan | undefined;
	#header = Buffer.alloc(0);
	/** Content bytes still due. */
	#due = 0;
	#fed = 0;
	#failure: SecretRefusal | undefined;

	constructor(secrets: SecretSet, size: number) {
		this.#secrets = secrets;
		this.#stored = secrets.scan(size);
		this.#inflate.on("error", () => {
			this.#failure ??= new SecretRefusal(UNCHECKED);
		});
		this.#inflate.on("data", (out: Buffer) => {
			if (this.#failure) return;
			try {
				this.#take(out);
			} catch (error) {
				this.#failure = error instanceof SecretRefusal ? error : new SecretRefusal(UNCHECKED);
				this.#inflate.destroy();
			}
		});
		this.#ended = finished(this.#inflate);
		this.#ended.catch(() => undefined);
	}

	async push(chunk: Buffer): Promise<void> {
		this.#stored.push(chunk);
		this.#fed += chunk.length;
		await this.#write(chunk);
		this.#throwIfFailed();
		// What zlib did not take is past the stream's end.
		if (this.#inflate.bytesWritten !== this.#fed) throw new SecretRefusal(UNCHECKED);
	}

	async end(): Promise<void> {
		this.#stored.end();
		this.#throwIfFailed();
		this.#inflate.end();
		await this.#ended.catch(() => {
			this.#failure ??= new SecretRefusal(UNCHECKED);
		});
		this.#throwIfFailed();
		if (this.#inflate.bytesWritten !== this.#fed || !this.#content || this.#due !== 0)
			throw new SecretRefusal(UNCHECKED);
		this.#content.end();
	}

	abort(): Promise<void> {
		this.#inflate.destroy();
		return Promise.resolve();
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
		if (!this.#content) {
			const nul = out.indexOf(0);
			const header = Buffer.concat([this.#header, nul < 0 ? out : out.subarray(0, nul)]);
			if (header.length > HEADER_MAX) throw new SecretRefusal(UNCHECKED);
			if (nul < 0) {
				this.#header = header;
				return;
			}
			const size = Number(LOOSE_HEADER.exec(header.toString("latin1"))?.[1] ?? Number.NaN);
			if (!(size <= LOOSE_MAX)) throw new SecretRefusal(UNCHECKED);
			this.#content = this.#secrets.scan(size);
			this.#due = size;
			content = out.subarray(nul + 1);
		}
		if (content.length > this.#due) throw new SecretRefusal(UNCHECKED);
		this.#due -= content.length;
		this.#content.push(content);
	}

	#throwIfFailed(): void {
		if (this.#failure) throw this.#failure;
	}
}

/** Turns for the node's pack checks: at most `atOnce` at a time, the rest in order, at most `waitingMax` of them with
 * at most `waitingBytes` of packs together; one past either is refused as not checked now. */
class Turns {
	#free: number;
	readonly #waitingMax: number;
	readonly #waitingBytes: number;
	readonly #waiting: { readonly bytes: number; readonly go: () => void }[] = [];
	#waitingFor = 0;

	constructor(atOnce: number, waitingMax: number, waitingBytes: number) {
		this.#free = atOnce;
		this.#waitingMax = waitingMax;
		this.#waitingBytes = waitingBytes;
	}

	/** A turn for the check of a pack of `bytes`. */
	async take(bytes: number): Promise<() => void> {
		if (this.#free > 0) this.#free--;
		else if (this.#waiting.length >= this.#waitingMax || this.#waitingFor + bytes > this.#waitingBytes)
			throw new SecretRefusal(UNCHECKED, true);
		else {
			this.#waitingFor += bytes;
			await new Promise<void>((go) => this.#waiting.push({ bytes, go }));
		}
		let given = false;
		return () => {
			if (given) return;
			given = true;
			const next = this.#waiting.shift();
			if (next) {
				this.#waitingFor -= next.bytes;
				next.go();
			} else this.#free++;
		};
	}
}

/** A pack: git reads it, and each object it holds is scanned whole, deltas resolved; its stored bytes are scanned too.
 * A pack git cannot read whole, a thin one included, one larger than the bound, or one whose objects rebuild to more
 * than the bound, is refused as not checked. */
class PackCheck implements ContentCheck {
	readonly #reading: Required<PackReading>;
	readonly #turns: Turns;
	readonly #secrets: SecretSet;
	readonly #stored: SecretScan;
	readonly #size: number;
	readonly #sha256: boolean;
	#run: Promise<PackRun> | undefined;
	#fed = 0;

	constructor(reading: Required<PackReading>, turns: Turns, secrets: SecretSet, size: number, sha256: boolean) {
		this.#reading = reading;
		this.#turns = turns;
		this.#secrets = secrets;
		this.#stored = secrets.scan(size);
		this.#size = size;
		this.#sha256 = sha256;
	}

	async push(chunk: Buffer): Promise<void> {
		this.#stored.push(chunk);
		this.#fed += chunk.length;
		await (await this.#started()).feed(chunk);
	}

	async end(): Promise<void> {
		this.#stored.end();
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
			this.#sha256,
			this.#secrets.scan(rebuilt),
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
	readonly #reading: Required<PackReading>;
	readonly #dir: string;
	readonly #release: () => void;
	readonly #scan: SecretScan;
	readonly #rebuilt: number;
	readonly #timer: NodeJS.Timeout;
	#index: Git | undefined;
	#running: Git | undefined;
	/** Why the run stopped: a `SecretRefusal` if the pack could not be checked, any other error if git could not run. */
	#failure: Error | undefined;
	#closed: Promise<void> | undefined;

	private constructor(
		reading: Required<PackReading>,
		dir: string,
		release: () => void,
		scan: SecretScan,
		rebuilt: number,
	) {
		this.#reading = reading;
		this.#dir = dir;
		this.#release = release;
		this.#scan = scan;
		this.#rebuilt = rebuilt;
		this.#timer = setTimeout(() => {
			this.#fail(new SecretRefusal(UNCHECKED));
			void this.close();
		}, reading.timeoutMs);
	}

	/** Waits for its turn and makes the scratch repository. A failure to make it is not the pack's: it rejects with a
	 * plain error, and the file waits. No turn while too many wait rejects as not checked now. */
	static async start(
		reading: Required<PackReading>,
		turn: Promise<() => void>,
		sha256: boolean,
		scan: SecretScan,
		rebuilt: number,
	): Promise<PackRun> {
		const release = await turn;
		let dir: string | undefined;
		try {
			await access(reading.git, constants.X_OK);
			await access(reading.prlimit, constants.X_OK);
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
					"\tthreads = 1",
					"[gc]",
					"\tauto = 0",
					...(sha256 ? ["[extensions]", "\tobjectFormat = sha256"] : []),
					"",
				].join("\n"),
			);
			return new PackRun(reading, dir, release, scan, rebuilt);
		} catch (error) {
			if (dir) await rm(dir, { recursive: true, force: true });
			release();
			throw error;
		}
	}

	/** Gives index-pack the pack's next bytes. */
	async feed(chunk: Buffer): Promise<void> {
		this.#throwIfFailed();
		await written(this.#indexPack(), chunk);
		this.#throwIfFailed();
	}

	/** The run's index-pack, started at the pack's first bytes (or at its end, for a pack of none). */
	#indexPack(): Git {
		this.#index ??= this.#spawn(["index-pack", "--stdin", "--threads=1"]);
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
		const indexed = await index.closed;
		this.#throwIfFailed();
		if (indexed !== 0) throw new SecretRefusal(UNCHECKED);
		// On a pipe index-pack stops at the pack's own end, and never reads what follows: its copy must be every byte.
		const packs = (await readdir(join(this.#dir, "objects/pack"))).filter((name) => name.endsWith(".pack"));
		const copy = packs.length === 1 ? await stat(join(this.#dir, "objects/pack", packs[0] as string)) : undefined;
		if (copy?.size !== fed) throw new SecretRefusal(UNCHECKED);
		this.#throwIfFailed();
		const batch = new Batch(this.#scan, this.#rebuilt);
		const cat = this.#spawn(["cat-file", "--batch-all-objects", "--batch", "--unordered"]);
		cat.child.stdin?.end();
		cat.child.stdout?.on("data", (chunk: Buffer) => {
			if (this.#failure) return;
			try {
				batch.take(chunk);
			} catch (error) {
				this.#fail(error instanceof SecretRefusal ? error : new SecretRefusal(UNCHECKED));
			}
		});
		const read = await cat.closed;
		this.#throwIfFailed();
		if (read !== 0 || !batch.whole) throw new SecretRefusal(UNCHECKED);
	}

	/** Stops what still runs, removes the scratch repository and gives the turn back; once, whatever came before. */
	close(): Promise<void> {
		this.#closed ??= (async () => {
			clearTimeout(this.#timer);
			try {
				const running = this.#running;
				if (running) {
					kill(running);
					await running.closed;
				}
				await rm(this.#dir, { recursive: true, force: true });
			} finally {
				this.#release();
			}
		})();
		return this.#closed;
	}

	#spawn(args: readonly string[]): Git {
		// Its own process group, so a kill takes all of it.
		const child = spawn(
			this.#reading.prlimit,
			[`--as=${this.#reading.memoryBytes}`, "--", this.#reading.git, ...args],
			{
				cwd: this.#dir,
				env: gitEnv(this.#dir),
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			},
		);
		// What git says is never logged: it may name what the pack holds.
		child.stderr?.resume();
		child.stdout?.resume();
		// A pipe that breaks under a running git is the pack's (git stopped reading it); one that never ran is not.
		child.stdin?.on("error", () => {
			if (child.pid !== undefined) this.#fail(new SecretRefusal(UNCHECKED));
		});
		const closed = new Promise<number | null>((resolve) => {
			child.once("error", () => {
				this.#fail(new Error("git could not be started for the save check"));
				resolve(null);
			});
			child.once("close", (code) => resolve(code));
		});
		const git = { child, closed };
		this.#running = git;
		if (this.#failure) kill(git);
		return git;
	}

	#fail(failure: Error): void {
		this.#failure ??= failure;
		if (this.#running) kill(this.#running);
	}

	#throwIfFailed(): void {
		if (this.#failure) throw this.#failure;
	}
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
	const stdin = git.child.stdin;
	if (!stdin || stdin.destroyed) return Promise.resolve();
	return new Promise((resolve) => {
		const done = (): void => {
			stdin.off("close", done);
			resolve();
		};
		stdin.once("close", done);
		stdin.write(chunk, done);
	});
}

/** `cat-file --batch`'s output, read as it comes: per object "<oid> <type> <size>\n", the content and "\n". Each
 * object's content is scanned whole and by itself; the sizes count against what the pack may rebuild to. */
class Batch {
	readonly #scan: SecretScan;
	readonly #rebuiltMax: number;
	#line = Buffer.alloc(0);
	/** The content bytes still due, then the newline after them; -1 between objects. */
	#due = -1;
	#rebuilt = 0;

	constructor(scan: SecretScan, rebuiltMax: number) {
		this.#scan = scan;
		this.#rebuiltMax = rebuiltMax;
	}

	/** Every object read to its end. */
	get whole(): boolean {
		return this.#due === -1 && this.#line.length === 0;
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
				const size = Number(BATCH_HEADER.exec(this.#line.toString("latin1"))?.[1] ?? Number.NaN);
				this.#line = Buffer.alloc(0);
				this.#rebuilt += size;
				if (!(this.#rebuilt <= this.#rebuiltMax)) throw new SecretRefusal(UNCHECKED);
				this.#due = size;
				at = newline + 1;
			} else if (this.#due > 0) {
				const take = Math.min(this.#due, chunk.length - at);
				this.#scan.push(chunk.subarray(at, at + take));
				this.#due -= take;
				at += take;
			} else {
				if (chunk[at] !== 10) throw new SecretRefusal(UNCHECKED);
				this.#scan.end();
				this.#due = -1;
				at++;
			}
		}
	}
}
