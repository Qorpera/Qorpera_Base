import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readdir, readlink, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
	COMPANY_COMPUTER_COMMAND_MOUNT,
	COMPANY_COMPUTER_FOLDER_ANSWER_BYTES,
	COMPANY_COMPUTER_FOLDER_REQUEST_BYTES,
	COMPANY_COMPUTER_FOLDER_ROOT,
	COMPANY_COMPUTER_FOLDER_RUN_CHUNK_BYTES,
	COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES,
	type CompanyComputerFolderAnswer,
	type CompanyComputerFolderAnswers,
	type CompanyComputerFolderBoundary,
	type CompanyComputerFolderMount,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderRunEvent,
	type CompanyComputerFolderRunInput,
	type CompanyComputerFolderView,
	companyComputerFolderPaths,
	isCompanyComputerFolderName,
	isCompanyComputerFolderReport,
	isCompanyComputerFolderView,
	parseCompanyComputerFolderRequest,
	parseCompanyComputerFolderRunInput,
} from "./cloud-company-computer-folder-helper-client.ts";
import { readCompanyComputerLinuxMetadata } from "./cloud-company-computer-linux-host.ts";
import { integer, properties, systemctl } from "./cloud-company-computer-systemd.ts";

/**
 * The office's folder helper (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Mounts in the VM"): the one root piece that mounts
 * the company folder for a desktop or a command, starts a command with its mount at `/company`, moves a desktop's mount
 * to a newer view, asks a mount's boundary and takes mounts away. The office service runs with no capabilities, no
 * devices and no `AF_VSOCK`, so it asks this helper over qorpera-office-folder-helper.socket; the stop control, root,
 * asks it too.
 *
 * A name is held exactly while its view file exists: the helper writes it first and removes it last, so a helper that
 * stopped half way leaves a name that `list` shows and `drop` takes away.
 */

/** The folder program, from the office image. */
export const COMPANY_COMPUTER_FOLDER_PROGRAM = "/opt/qorpera-folder/qorpera-folder";
/**
 * The mountpoint under the program's mount. Seen only while no program serves the mount (systemd's 5 s before a
 * restart): the office account then gets an error, not an empty company folder. Q3's proof measures `0000` against
 * this; the coordinator chose a loud error (14 Oct).
 */
export const COMPANY_COMPUTER_FOLDER_MOUNTPOINT_MODE = 0o700;
/** How long a mount may take to come up, and a switch to be taken, before the helper answers without it. */
const MOUNT_MS = 20000;
const SWITCH_MS = 20000;
/** How long a boundary waits for a program that is just exiting, to tell exit 3 from any other exit. */
const SETTLE_MS = 5000;
const POLL_MS = 200;
/** How often a run whose command exited looks for processes left in its mount namespace. */
const ENDED_POLL_MS = 1000;
/** How long `qorpera-folder command` may take to report its start; it gives up itself after 20 s. */
const LAUNCH_MS = 30000;
/** How long a launcher that was not let go may take to kill its command's starter and exit, before it is killed. */
const LAUNCH_STOP_MS = 5000;
/** A report line of `qorpera-folder command` at most. */
const COMMAND_REPORT_BYTES = 4096;
const PROOF_SCHEMA = "qorpera.folder-view-proof/v1";

export function companyComputerFolderUnit(name: string): string {
	if (!isCompanyComputerFolderName(name)) throw new Error("INVALID_COMPANY_COMPUTER_FOLDER_NAME");
	return `qorpera-office-folder-mount@${name}.service`;
}

/** What systemd says of a mount's unit. */
export interface CompanyComputerFolderUnitState {
	readonly active: string;
	readonly result: string;
	readonly execMainCode: number;
	readonly execMainStatus: number;
}

/** The machine as the helper uses it; tests give their own. */
export interface CompanyComputerFolderHelperSystem {
	/** Throws when systemd does not answer. */
	inspect(unit: string): Promise<CompanyComputerFolderUnitState>;
	start(unit: string): Promise<void>;
	/** Returns once the unit has stopped, its `ExecStopPost` included. */
	stop(unit: string): Promise<void>;
	resetFailed(unit: string): Promise<void>;
	/** This mount namespace's `/proc/self/mountinfo`. */
	mountinfo(): Promise<string>;
	/** Binds a directory onto itself and makes it shared, so a mount made inside reaches every bind of it. */
	share(path: string): Promise<void>;
	/** Detaches the top mount at a path (lazily). */
	detach(path: string): Promise<void>;
	/** Runs the folder program once. `code` is null when it did not exit by itself in time; `stdout` is undefined when
	 * it printed more than an answer can carry. */
	publish(args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: Buffer | undefined }>;
	/** Starts `qorpera-folder command` with these arguments. Its stdin, stdout and stderr are the command's, fd 3
	 * carries its reports, and fd 4 the helper's go; all five are pipes. */
	launch(args: readonly string[]): ChildProcess;
	/** Whether a process is left in the mount namespace with this inode, and that namespace is the command's of this
	 * mount (`isCompanyComputerCommandNamespace`): nsfs reuses the inodes of namespaces that ended. */
	namespaceInUse(mntns: number, name: string): Promise<boolean>;
}

/** A program that exited 3: the node closed or refused its view, and systemd does not start it again. */
function closedByNode(state: CompanyComputerFolderUnitState): boolean {
	return (
		state.active === "failed" &&
		state.result === "exit-code" &&
		state.execMainCode === 1 &&
		state.execMainStatus === 3
	);
}

export function companyComputerFolderProgram(
	state: CompanyComputerFolderUnitState | undefined,
): CompanyComputerFolderMount["program"] {
	switch (state?.active) {
		case "active":
			return "running";
		case "activating":
		case "reloading":
			return "restarting";
		case "failed":
			return closedByNode(state) ? "closed" : "stopped";
		case "inactive":
			return "stopped";
		default:
			return "unknown";
	}
}

/**
 * A boundary's answer from `qorpera-folder publish --json`: 0 every path saved, 4 a path not saved or the boundary
 * refused, 3 the view closed, anything else no answer (a report printed before a later failure is kept). A report that
 * contradicts its exit code is no answer.
 */
export function companyComputerFolderBoundaryAnswer(
	code: number | null,
	stdout: Buffer | undefined,
): CompanyComputerFolderBoundary {
	if (code === 3) return { answer: "closed" };
	let report: unknown;
	try {
		const text = new TextDecoder("utf8", { fatal: true }).decode(stdout ?? Buffer.alloc(0));
		report = /^[^\n]+\n?$/.test(text) ? JSON.parse(text) : undefined;
	} catch {
		report = undefined;
	}
	if (!isCompanyComputerFolderReport(report)) return { answer: "unanswered" };
	const saved = report.refused === undefined && report.paths.every((entry) => entry.outcome === "saved");
	if (code === 0 && saved) return { answer: "saved", report };
	if (code === 4 && !saved) return { answer: "refused", report };
	return { answer: "unanswered", report };
}

export interface CompanyComputerMountEntry {
	/** The mount's root within its filesystem. */
	readonly root: string;
	readonly mountpoint: string;
	readonly optional: readonly string[];
	readonly fstype: string;
	readonly source: string;
}

export function parseCompanyComputerMountinfo(text: string): CompanyComputerMountEntry[] {
	const decode = (field: string) =>
		field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const fields = line.split(" ");
			const dash = fields.indexOf("-", 6);
			if (dash < 0 || fields.length < dash + 3) throw new Error("COMPANY_COMPUTER_FOLDER_MOUNTS_UNCONFIRMED");
			return {
				root: decode(fields[3]),
				mountpoint: decode(fields[4]),
				optional: fields.slice(6, dash),
				fstype: fields[dash + 1],
				source: decode(fields[dash + 2]),
			};
		});
}

/**
 * A command's mount namespace, from its own mount table: the top mount at the command mount is a clone of that
 * command's mount parent (shown as deleted once the helper took the parent away). The command holds no capability over
 * the namespace, which the initial user namespace owns, so it cannot make this true of another one.
 */
export function isCompanyComputerCommandNamespace(
	entries: readonly CompanyComputerMountEntry[],
	name: string,
): boolean {
	const top = entries.filter((entry) => entry.mountpoint === COMPANY_COMPUTER_COMMAND_MOUNT).at(-1);
	return top?.root.replace(/\/\/deleted$/, "").endsWith(`/mounts/${name}`) ?? false;
}

/** How many passes a look for a namespace's processes takes before it gives up, answering in use, while processes
 * keep being forked meanwhile. */
const SCAN_PASSES = 50;

/** A look at a machine's processes: the last pid it gave, the pids there now, and whether a process is in the
 * namespace looked for (false when it is gone; an error when that cannot be known). */
export interface CompanyComputerProcessScan {
	lastPid(): Promise<number>;
	pids(): Promise<readonly number[]>;
	inside(pid: number): Promise<boolean>;
}

/**
 * Whether a process is in a namespace that only grows by fork and that no process leaves: the command's filter refuses
 * setns and new user namespaces, and it holds no capability, so it can neither join the namespace (the initial user
 * namespace owns it) nor unshare a mount namespace of its own. One list of the processes is not enough: one can fork
 * while it is read, then exit before it is looked at, and its child came after the list. Pids are given in a cycle, so
 * each pass after the first looks again at the pids given during the one before, until a pass during which none was
 * given: a process then in the namespace was there through that pass, or forked during an earlier one. While the
 * computer keeps forking, such a pass can take long to come; the answer is then in use: late, never early. An error is
 * no answer.
 */
export async function companyComputerNamespaceInUse(scan: CompanyComputerProcessScan): Promise<boolean> {
	let from: number | undefined,
		to = await scan.lastPid();
	for (let pass = 0; pass < SCAN_PASSES; pass++) {
		for (const pid of await scan.pids()) {
			// After the first pass, only the pids after `from` up to `to`, in their cycle.
			const look = from === undefined || (from < to ? pid > from && pid <= to : pid > from || pid <= to);
			if (look && (await scan.inside(pid))) return true;
		}
		const last = await scan.lastPid();
		if (last === to) return false;
		from = to;
		to = last;
	}
	return true;
}

/** What `qorpera-folder command` reports on fd 3: the command ready to run (its pid and its mount namespace's inode;
 * it runs once the helper writes `G` on fd 4), its exit, or why it did not start (also after `started`, when it failed
 * before its program ran). */
export type CompanyComputerFolderCommandReport =
	| { readonly t: "started"; readonly pid: number; readonly mntns: number }
	| { readonly t: "exit"; readonly code: number | null; readonly signal: string | null }
	| { readonly t: "failed"; readonly error: string };

export function parseCompanyComputerFolderCommandReport(line: string): CompanyComputerFolderCommandReport | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const report = value as Record<string, unknown>,
		keys = Object.keys(report).sort().join();
	const positive = (field: unknown) => Number.isSafeInteger(field) && (field as number) > 0;
	switch (report.t) {
		case "started":
			return keys === "mntns,pid,t" && positive(report.pid) && positive(report.mntns)
				? { t: "started", pid: report.pid as number, mntns: report.mntns as number }
				: undefined;
		case "exit":
			return keys === "code,signal,t" &&
				(report.code === null ||
					(Number.isSafeInteger(report.code) && (report.code as number) >= 0 && (report.code as number) <= 255)) &&
				(report.signal === null || (typeof report.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(report.signal)))
				? { t: "exit", code: report.code as number | null, signal: report.signal as string | null }
				: undefined;
		case "failed":
			return keys === "error,t" && typeof report.error === "string"
				? { t: "failed", error: report.error }
				: undefined;
		default:
			return undefined;
	}
}

/** A command mount's record of its command (`command.json` in its state folder): the command's mount namespace, null
 * while it starts and for good if it never did, and whether no process is left in it. The helper lets the launcher run
 * the command only once its namespace is recorded here, so a null one never ran anything, whatever happened to the
 * helper meanwhile. */
interface CommandRecord {
	readonly mntns: number | null;
	readonly ended: boolean;
}

function isCommandRecord(value: unknown): value is CommandRecord {
	if (typeof value !== "object" || value === null || Object.keys(value).sort().join() !== "ended,mntns") return false;
	const { mntns, ended } = value as Record<string, unknown>;
	return typeof ended === "boolean" && (mntns === null || (Number.isSafeInteger(mntns) && (mntns as number) > 0));
}

/** A run's start: the launcher, once it reported the command started, or the answer that ran nothing. */
type Launched =
	| {
			readonly answer: "started";
			readonly child: ChildProcess;
			readonly mntns: number;
			/** Settles once the launcher exited and its pipes closed. */
			readonly closed: Promise<void>;
			/** The launcher's exit report, once it came. */
			readonly exit: () => { readonly code: number | null; readonly signal: string | null } | undefined;
	  }
	| { readonly answer: Exclude<CompanyComputerFolderAnswers["run"]["answer"], "started"> };

/** The top mount at the mountpoint is the folder program's. */
function served(entries: readonly CompanyComputerMountEntry[], mountpoint: string): boolean {
	const top = entries.filter((entry) => entry.mountpoint === mountpoint).at(-1);
	return top?.fstype === "fuse.qorpera" && top.source === "qorpera-company";
}

function shared(entries: readonly CompanyComputerMountEntry[], parent: string): boolean {
	const top = entries.filter((entry) => entry.mountpoint === parent).at(-1);
	return top?.optional.some((field) => field.startsWith("shared:")) ?? false;
}

/** Mounts at or below a path, the deepest and latest first. */
function below(entries: readonly CompanyComputerMountEntry[], path: string): string[] {
	return entries
		.map((entry, index) => ({ path: entry.mountpoint, index }))
		.filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`))
		.sort((a, b) => b.path.length - a.path.length || b.index - a.index)
		.map((entry) => entry.path);
}

export interface CompanyComputerFolderHelperOptions {
	readonly root?: string;
	readonly mountMs?: number;
	readonly switchMs?: number;
	readonly settleMs?: number;
	readonly pollMs?: number;
	readonly endedPollMs?: number;
	readonly launchMs?: number;
	readonly launchStopMs?: number;
	readonly log?: (line: string) => void;
}

export class CompanyComputerFolderHelper {
	readonly #system: CompanyComputerFolderHelperSystem;
	readonly #root: string;
	readonly #mountMs: number;
	readonly #switchMs: number;
	readonly #settleMs: number;
	readonly #pollMs: number;
	readonly #endedPollMs: number;
	readonly #launchMs: number;
	readonly #launchStopMs: number;
	readonly #log: (line: string) => void;
	/** Each name's requests, and a run's start, run one after another; `list`, `ended` and a command's life wait for
	 * none. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(system: CompanyComputerFolderHelperSystem, options: CompanyComputerFolderHelperOptions = {}) {
		this.#system = system;
		this.#root = options.root ?? COMPANY_COMPUTER_FOLDER_ROOT;
		this.#mountMs = options.mountMs ?? MOUNT_MS;
		this.#switchMs = options.switchMs ?? SWITCH_MS;
		this.#settleMs = options.settleMs ?? SETTLE_MS;
		this.#pollMs = options.pollMs ?? POLL_MS;
		this.#endedPollMs = options.endedPollMs ?? ENDED_POLL_MS;
		this.#launchMs = options.launchMs ?? LAUNCH_MS;
		this.#launchStopMs = options.launchStopMs ?? LAUNCH_STOP_MS;
		this.#log = options.log ?? ((line) => console.error(line));
	}

	/** Makes the helper's folders, or checks the ones a previous helper made: root's, and no symlink. */
	async prepare(): Promise<void> {
		const owner = process.geteuid?.();
		for (const [path, mode] of [
			[this.#root, 0o755],
			[`${this.#root}/views`, 0o700],
			[`${this.#root}/state`, 0o700],
			[`${this.#root}/mounts`, 0o755],
		] as const) {
			await mkdir(path, { mode }).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "EEXIST") throw error;
			});
			const info = await lstat(path);
			if (!info.isDirectory() || info.uid !== owner) throw new Error("COMPANY_COMPUTER_FOLDER_ROOT_UNCONFIRMED");
			await chmod(path, mode);
		}
		// A view a stopped helper wrote but never gave a name.
		for (const entry of await readdir(`${this.#root}/views`))
			if (entry.startsWith(".")) await rm(`${this.#root}/views/${entry}`, { force: true });
	}

	/** Every request but `run`, which has a connection of its own (`run`). */
	answer(request: Exclude<CompanyComputerFolderRequest, { op: "run" }>): Promise<CompanyComputerFolderAnswer> {
		if (request.op === "list")
			return this.#list().catch((): CompanyComputerFolderAnswers["list"] => ({ answer: "failed" }));
		if (request.op === "ended")
			return this.#ended(request.name).catch((): CompanyComputerFolderAnswers["ended"] => ({ answer: "failed" }));
		return this.#enqueue(request.name, () => this.#perform(request));
	}

	/**
	 * A run, on the connection its request came on: the answer line, then, after `started`, the command's output, its
	 * exit and `ended`, as the office service's writes and stop come in. The connection ends after `ended`. An asker
	 * that leaves earlier, or sends a malformed line, stops the command; its mount's `ended` still answers.
	 */
	run(request: Extract<CompanyComputerFolderRequest, { op: "run" }>, socket: Socket, rest: Buffer): void {
		let child: ChildProcess | undefined,
			left = false,
			finished = false,
			blocked = false;
		const inputs: CompanyComputerFolderRunInput[] = [];
		const paused = new Set<Readable>();
		const send = (line: CompanyComputerFolderAnswer<"run"> | CompanyComputerFolderRunEvent): void => {
			if (!left && !socket.destroyed && !socket.write(`${JSON.stringify(line)}\n`)) blocked = true;
		};
		const resume = (): void => {
			blocked = false;
			for (const stream of paused) stream.resume();
			paused.clear();
		};
		socket.on("drain", resume);
		const leave = (): void => {
			if (left) return;
			left = true;
			if (!finished) socket.destroy();
			resume();
			// A launcher that exited has no process left to signal: a stop after the command's exit does nothing.
			child?.kill("SIGTERM");
		};
		// The shell host's write and stop; both wait for the start.
		const apply = (input: CompanyComputerFolderRunInput): void => {
			if (!child) {
				inputs.push(input);
				return;
			}
			if (input.t === "stop") {
				child.kill("SIGTERM");
				return;
			}
			const stdin = child.stdin;
			if (!stdin || stdin.writableEnded) return;
			const data = Buffer.from(input.data, "base64");
			if (data.length) stdin.write(data);
			if (input.end) stdin.end();
		};
		const chunks: Buffer[] = [];
		let length = 0;
		const take = (bytes: Buffer): void => {
			let next = bytes;
			for (let newline = next.indexOf(0x0a); newline >= 0 && !left; newline = next.indexOf(0x0a)) {
				if (length + newline >= COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES) return void leave();
				chunks.push(next.subarray(0, newline));
				next = next.subarray(newline + 1);
				let input: CompanyComputerFolderRunInput | undefined;
				try {
					input = parseCompanyComputerFolderRunInput(
						new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
					);
				} catch {
					input = undefined;
				}
				chunks.length = 0;
				length = 0;
				if (!input) return void leave();
				apply(input);
			}
			if (left || !next.length) return;
			length += next.length;
			if (length >= COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES) return void leave();
			chunks.push(next);
		};
		take(rest);
		socket.on("data", take);
		socket.on("end", leave);
		socket.on("close", leave);
		socket.on("error", leave);
		void this.#enqueue(request.name, () => this.#launch(request))
			.catch((error: unknown): Launched => {
				this.#log(`folder-helper: run ${request.name}: ${String(error)}`);
				return { answer: "failed" };
			})
			.then((launched) => {
				if (launched.answer !== "started") {
					finished = true;
					send({ answer: launched.answer });
					socket.end();
					return;
				}
				child = launched.child;
				send({ answer: "started" });
				for (const stream of [child.stdout, child.stderr]) {
					if (!stream) continue;
					stream.on("data", (bytes: Buffer) => {
						for (let offset = 0; offset < bytes.length; offset += COMPANY_COMPUTER_FOLDER_RUN_CHUNK_BYTES)
							send({
								t: "out",
								data: bytes
									.subarray(offset, offset + COMPANY_COMPUTER_FOLDER_RUN_CHUNK_BYTES)
									.toString("base64"),
							});
						if (blocked && !left && !stream.isPaused()) {
							stream.pause();
							paused.add(stream);
						}
					});
				}
				child.stdin?.on("error", () => undefined);
				for (const input of inputs.splice(0)) apply(input);
				if (left) child.kill("SIGTERM");
				void launched.closed.then(async () => {
					send({ t: "exit", ...(launched.exit() ?? { code: null, signal: null }) });
					// Background jobs, and programs that left the command's process group, keep its mount in use.
					while (!left && (await this.#system.namespaceInUse(launched.mntns, request.name).catch(() => true)))
						await delay(this.#endedPollMs);
					if (left) return;
					await this.#markEnded(request.name, launched.mntns).catch((error: unknown) =>
						this.#log(`folder-helper: run ${request.name}: ${String(error)}`),
					);
					finished = true;
					send({ t: "ended" });
					socket.end();
				});
			});
	}

	#enqueue<T>(name: string, task: () => Promise<T>): Promise<T> {
		const before = this.#queues.get(name) ?? Promise.resolve();
		const result = before.then(task);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(name, settled);
		void settled.then(() => {
			if (this.#queues.get(name) === settled) this.#queues.delete(name);
		});
		return result;
	}

	async #perform(
		request: Exclude<CompanyComputerFolderRequest, { op: "list" | "ended" | "run" }>,
	): Promise<CompanyComputerFolderAnswer> {
		switch (request.op) {
			case "mount":
				return this.#mount(request.name, request.view).catch((): CompanyComputerFolderAnswers["mount"] => ({
					answer: "failed",
				}));
			case "switch":
				return this.#switch(request.name, request.view).catch((): CompanyComputerFolderAnswers["switch"] => ({
					answer: "failed",
				}));
			case "boundary":
				return this.#boundary(request.name, request.final, request.timeoutMs).catch(
					(): CompanyComputerFolderAnswers["boundary"] => ({ answer: "unanswered" }),
				);
			case "unmount":
				return this.#unmount(request.name, request.final, request.timeoutMs);
			case "drop":
				return this.#drop(request.name).catch((): CompanyComputerFolderAnswers["drop"] => ({ answer: "failed" }));
		}
	}

	async #mount(name: string, view: CompanyComputerFolderView): Promise<CompanyComputerFolderAnswers["mount"]> {
		if (await this.#held(name)) return { answer: "held" };
		await this.#writeView(name, view, false);
		let answer: CompanyComputerFolderAnswers["mount"]["answer"];
		try {
			answer = await this.#start(name);
		} catch {
			answer = "failed";
		}
		if (answer !== "mounted" && !(await this.#release(name).catch(() => false))) answer = "failed";
		this.#log(`folder-helper: mount ${name}: ${answer}`);
		return { answer };
	}

	async #start(name: string): Promise<"mounted" | "closed" | "unanswered" | "failed"> {
		const paths = companyComputerFolderPaths(name, this.#root),
			unit = companyComputerFolderUnit(name);
		// Whatever a helper that stopped half way left for this name.
		if (!(await this.#clear(name))) return "failed";
		// The program's read log starts only in an empty state folder.
		await mkdir(paths.state, { mode: 0o700 });
		await chmod(paths.state, 0o700);
		await mkdir(paths.parent, { mode: 0o755 });
		await chmod(paths.parent, 0o755);
		await mkdir(paths.mountpoint, { mode: COMPANY_COMPUTER_FOLDER_MOUNTPOINT_MODE });
		await chmod(paths.mountpoint, COMPANY_COMPUTER_FOLDER_MOUNTPOINT_MODE);
		await this.#system.share(paths.parent);
		if (!shared(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.parent)) return "failed";
		await this.#system.start(unit);
		// The unit is up once the program runs (Type=exec); the mount comes after the node accepts its view.
		const deadline = Date.now() + this.#mountMs;
		for (;;) {
			if (served(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.mountpoint)) return "mounted";
			const state = await this.#system.inspect(unit).catch(() => undefined);
			if (state && closedByNode(state)) return "closed";
			if (Date.now() >= deadline) return "unanswered";
			await delay(this.#pollMs);
		}
	}

	async #switch(name: string, view: CompanyComputerFolderView): Promise<CompanyComputerFolderAnswers["switch"]> {
		if (!(await this.#held(name))) return { answer: "unknown" };
		// A command's view never moves: it ends with the command.
		if (!name.startsWith("desktop-")) return { answer: "refused" };
		const paths = companyComputerFolderPaths(name, this.#root),
			unit = companyComputerFolderUnit(name);
		const current = await this.#readView(paths.view),
			accepted = await this.#readProof(paths.state);
		// The program refuses both (a mount cannot switch company; a view's pass never changes): refused here, the
		// mount keeps its view.
		for (const known of [current, accepted])
			if (
				known &&
				(known.environmentId !== view.environmentId || (known.viewId === view.viewId && known.pass !== view.pass))
			)
				return { answer: "refused" };
		if (await this.#closed(unit)) return { answer: "closed" };
		if (current.viewId !== view.viewId) await this.#writeView(name, view, true);
		// The program watches its view file and says hello with the newer view, then records it as accepted.
		const deadline = Date.now() + this.#switchMs;
		for (;;) {
			const proof = await this.#readProof(paths.state).catch(() => undefined);
			if (proof?.viewId === view.viewId) return { answer: "switched" };
			const state = await this.#system.inspect(unit).catch(() => undefined);
			if (state && closedByNode(state)) return { answer: "closed" };
			if (Date.now() >= deadline) return { answer: "pending" };
			await delay(this.#pollMs);
		}
	}

	async #boundary(name: string, final: boolean, timeoutMs: number): Promise<CompanyComputerFolderAnswers["boundary"]> {
		if (!(await this.#held(name))) return { answer: "unknown" };
		// After exit 3 the view is closed and publishes nothing more: answered at once, without the node.
		if (await this.#closed(companyComputerFolderUnit(name))) return { answer: "closed" };
		// Otherwise the folder program publishes the mount's state, whether its mount still runs or not: it hands over
		// the reads it logged, then asks the node to publish what it holds for the view.
		const paths = companyComputerFolderPaths(name, this.#root);
		const run = await this.#system.publish(
			["publish", "--view-file", paths.view, "--state-dir", paths.state, ...(final ? ["--final"] : []), "--json"],
			timeoutMs,
		);
		const answer = companyComputerFolderBoundaryAnswer(run.code, run.stdout);
		this.#log(`folder-helper: boundary ${name}${final ? " (final)" : ""}: ${answer.answer}`);
		return answer;
	}

	/** The mount goes only after an answer that ends it (`saved` or `closed`); after any other it stays, so a boundary
	 * can be asked again, and a caller that takes the answer as final drops it. */
	async #unmount(name: string, final: boolean, timeoutMs: number): Promise<CompanyComputerFolderAnswers["unmount"]> {
		const boundary = await this.#boundary(name, final, timeoutMs).catch(
			(): CompanyComputerFolderAnswers["boundary"] => ({ answer: "unanswered" }),
		);
		if (boundary.answer === "unknown") return boundary;
		const unmounted =
			(boundary.answer === "saved" || boundary.answer === "closed") &&
			(await this.#release(name).catch(() => false));
		this.#log(`folder-helper: unmount ${name}: ${unmounted ? "unmounted" : "kept"}`);
		return { ...boundary, unmounted };
	}

	async #drop(name: string): Promise<CompanyComputerFolderAnswers["drop"]> {
		if (!(await this.#held(name))) return { answer: "unknown" };
		const answer = (await this.#release(name)) ? "dropped" : "failed";
		this.#log(`folder-helper: drop ${name}: ${answer}`);
		return { answer };
	}

	async #list(): Promise<CompanyComputerFolderAnswers["list"]> {
		const names = (await readdir(`${this.#root}/views`))
			.filter((entry) => entry.endsWith(".json"))
			.map((entry) => entry.slice(0, -".json".length))
			.filter(isCompanyComputerFolderName)
			.sort();
		const mounts = await Promise.all(
			names.map(async (name): Promise<CompanyComputerFolderMount> => {
				const view = await this.#readView(companyComputerFolderPaths(name, this.#root).view).catch(() => undefined);
				const state = await this.#system.inspect(companyComputerFolderUnit(name)).catch(() => undefined);
				return { name, viewId: view?.viewId ?? "", program: companyComputerFolderProgram(state) };
			}),
		);
		return { answer: "list", mounts };
	}

	/** Takes a held name's mount away, its view file last. False when something stayed: the name stays held. */
	async #release(name: string): Promise<boolean> {
		if (!(await this.#clear(name))) return false;
		await rm(companyComputerFolderPaths(name, this.#root).view, { force: true });
		return !(await this.#held(name));
	}

	/** Stops the mount's program and removes its mounts, folders and state; the view file stays. */
	async #clear(name: string): Promise<boolean> {
		const paths = companyComputerFolderPaths(name, this.#root),
			unit = companyComputerFolderUnit(name);
		await this.#system.stop(unit);
		const state = await this.#system.inspect(unit);
		if (state.active === "failed") await this.#system.resetFailed(unit);
		else if (state.active !== "inactive") return false;
		// The program's own ExecStopPost detaches a mount it left; then the parent's bind goes.
		for (let round = 0; round < 16; round++) {
			const [top] = below(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.parent);
			if (top === undefined) break;
			await this.#system.detach(top).catch(() => undefined);
		}
		if (below(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.parent).length) return false;
		for (const path of [paths.mountpoint, paths.parent])
			await rmdir(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		await rm(paths.state, { recursive: true, force: true });
		return true;
	}

	/** The unit's program exited 3. A program just exiting is waited for briefly. */
	async #closed(unit: string): Promise<boolean> {
		const deadline = Date.now() + this.#settleMs;
		for (;;) {
			const state = await this.#system.inspect(unit).catch(() => undefined);
			if (state?.active !== "deactivating" || Date.now() >= deadline)
				return state !== undefined && closedByNode(state);
			await delay(this.#pollMs);
		}
	}

	async #held(name: string): Promise<boolean> {
		try {
			if (!(await lstat(companyComputerFolderPaths(name, this.#root).view)).isFile())
				throw new Error("COMPANY_COMPUTER_FOLDER_VIEW_UNCONFIRMED");
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Writes a view file as the program requires it (root's, 0600): a new one only if the name is free, or a newer
	 * one in place of the old in one step. */
	async #writeView(name: string, view: CompanyComputerFolderView, replace: boolean): Promise<void> {
		const target = companyComputerFolderPaths(name, this.#root).view,
			next = `${this.#root}/views/.${name}.next`;
		await rm(next, { force: true });
		await writeFile(next, `${JSON.stringify(view)}\n`, { mode: 0o600, flag: "wx" });
		try {
			if (replace) await rename(next, target);
			else await link(next, target);
		} finally {
			await rm(next, { force: true });
		}
	}

	async #readView(path: string): Promise<CompanyComputerFolderView> {
		const value: unknown = JSON.parse(await readCompanyComputerLinuxMetadata(path, 4096));
		if (!isCompanyComputerFolderView(value)) throw new Error("COMPANY_COMPUTER_FOLDER_VIEW_UNCONFIRMED");
		return value;
	}

	/** The view the program last accepted (its `view.json`), or undefined before it wrote one. */
	async #readProof(state: string): Promise<CompanyComputerFolderView | undefined> {
		let text: string;
		try {
			text = await readCompanyComputerLinuxMetadata(`${state}/view.json`, 4096);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (
			typeof value !== "object" ||
			value === null ||
			Object.keys(value).sort().join() !== "schema,view" ||
			(value as { schema?: unknown }).schema !== PROOF_SCHEMA ||
			!isCompanyComputerFolderView((value as { view?: unknown }).view)
		)
			throw new Error("COMPANY_COMPUTER_FOLDER_PROOF_UNCONFIRMED");
		return (value as { view: CompanyComputerFolderView }).view;
	}

	/** Starts a command mount's one command, once its launcher reported the start. */
	async #launch(request: Extract<CompanyComputerFolderRequest, { op: "run" }>): Promise<Launched> {
		const { name } = request;
		const paths = companyComputerFolderPaths(name, this.#root);
		if (!(await this.#held(name))) return { answer: "unknown" };
		// A command's mount is its own: once a command was claimed, even one that never started, none other runs in it.
		if ((await this.#readRecord(name).catch(() => null)) !== undefined) return { answer: "refused" };
		if (await this.#closed(companyComputerFolderUnit(name))) return { answer: "closed" };
		if (!served(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.mountpoint)) {
			this.#log(`folder-helper: run ${name}: its mount is not served`);
			return { answer: "failed" };
		}
		await this.#writeRecord(name, { mntns: null, ended: false }, false);
		const child = this.#system.launch([
			"command",
			"--shell-pid",
			String(request.shellPid),
			"--tree",
			paths.parent,
			"--network",
			request.network ? "yes" : "no",
			"--",
			"/usr/bin/bash",
			"--noprofile",
			"--norc",
			"-c",
			request.command,
		]);
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});
		const go = child.stdio[4] as Writable | null | undefined;
		go?.on("error", () => undefined);
		let exit: { readonly code: number | null; readonly signal: string | null } | undefined;
		// The first report decides the start; the launcher sends its exit report last.
		const first = await new Promise<CompanyComputerFolderCommandReport | undefined>((resolve) => {
			let decided = false,
				broken = false;
			const decide = (report: CompanyComputerFolderCommandReport | undefined): void => {
				if (decided) return;
				decided = true;
				clearTimeout(timer);
				resolve(report);
			};
			const timer = setTimeout(() => decide(undefined), this.#launchMs);
			child.on("error", () => decide(undefined));
			const reports = child.stdio[3] as Readable | null | undefined;
			if (!reports) return decide(undefined);
			const report = (text: string | undefined): void => {
				const parsed = text === undefined ? undefined : parseCompanyComputerFolderCommandReport(text);
				if (!decided) return void decide(parsed);
				if (parsed?.t === "exit") exit = { code: parsed.code, signal: parsed.signal };
				else
					this.#log(
						`folder-helper: run ${name}: ${parsed?.t === "failed" ? JSON.stringify(parsed.error) : "a malformed report"}`,
					);
			};
			const chunks: Buffer[] = [];
			let length = 0;
			reports.on("data", (bytes: Buffer) => {
				let next = bytes;
				for (let newline = next.indexOf(0x0a); newline >= 0 && !broken; newline = next.indexOf(0x0a)) {
					if (length + newline > COMMAND_REPORT_BYTES) break;
					chunks.push(next.subarray(0, newline));
					next = next.subarray(newline + 1);
					let text: string | undefined;
					try {
						text = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
					} catch {
						text = undefined;
					}
					chunks.length = 0;
					length = 0;
					report(text);
				}
				if (broken) return;
				length += next.length;
				if (length > COMMAND_REPORT_BYTES) {
					// No line that long comes from the launcher: its reports are not read any more.
					broken = true;
					report(undefined);
				} else chunks.push(next);
			});
			reports.on("error", () => decide(undefined));
			reports.once("end", () => decide(undefined));
		});
		// The command runs only once its mount namespace is on record: then `ended` can always answer for it.
		const recorded =
			first?.t === "started" &&
			(await this.#writeRecord(name, { mntns: first.mntns, ended: false }, true).then(
				() => true,
				(error: unknown) => {
					this.#log(`folder-helper: run ${name}: its record: ${String(error)}`);
					return false;
				},
			));
		if (first?.t === "started" && recorded && go) {
			// A launcher that gave up meanwhile reports its failure and exits; the run then ends with no exit code.
			go.end("G");
			this.#log(`folder-helper: run ${name}: started`);
			return { answer: "started", child, mntns: first.mntns, closed, exit: () => exit };
		}
		// Without the go, the launcher kills and reaps its command's starter, which ran nothing of the command's, and
		// exits. One that does not exit in time is killed: the starter, which waits for an answer only the launcher
		// writes, then ends by itself before it runs anything. Its pipes drain so it can go.
		go?.destroy();
		child.stdout?.resume();
		child.stderr?.resume();
		if (!(await Promise.race([exited.then(() => true), delay(this.#launchStopMs).then(() => false)]))) {
			child.kill("SIGKILL");
			await exited;
		}
		this.#log(
			`folder-helper: run ${name}: failed: ${first?.t === "failed" ? JSON.stringify(first.error) : first?.t === "started" ? "its record was not written" : "no start report"}`,
		);
		return { answer: "failed" };
	}

	async #ended(name: string): Promise<CompanyComputerFolderAnswers["ended"]> {
		if (!(await this.#held(name))) return { answer: "unknown" };
		const record = await this.#readRecord(name);
		if (record === undefined || record.mntns === null) return { answer: "unknown" };
		if (record.ended) return { answer: "ended" };
		if (await this.#system.namespaceInUse(record.mntns, name)) return { answer: "running" };
		await this.#markEnded(name, record.mntns);
		return { answer: "ended" };
	}

	/** Records that no process is left in the command's mount namespace, if the record is still that command's. */
	async #markEnded(name: string, mntns: number): Promise<void> {
		const record = await this.#readRecord(name);
		if (record?.mntns === mntns && !record.ended) await this.#writeRecord(name, { mntns, ended: true }, true);
	}

	async #readRecord(name: string): Promise<CommandRecord | undefined> {
		let text: string;
		try {
			text = await readCompanyComputerLinuxMetadata(
				`${companyComputerFolderPaths(name, this.#root).state}/command.json`,
				4096,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value: unknown = JSON.parse(text);
		if (!isCommandRecord(value)) throw new Error("COMPANY_COMPUTER_FOLDER_RECORD_UNCONFIRMED");
		return value;
	}

	/** Writes the record in one step: a first one only if there is none (the command's claim), or a newer one in place
	 * of the old. */
	async #writeRecord(name: string, record: CommandRecord, replace: boolean): Promise<void> {
		const state = companyComputerFolderPaths(name, this.#root).state,
			next = `${state}/.command-${randomUUID()}`;
		await writeFile(next, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
		try {
			if (replace) await rename(next, `${state}/command.json`);
			else await link(next, `${state}/command.json`);
		} finally {
			await rm(next, { force: true });
		}
	}
}

/** One request line per connection, one answer line back; a run's connection carries the run after its answer. */
export function createCompanyComputerFolderHelperServer(helper: CompanyComputerFolderHelper): Server {
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		const chunks: Buffer[] = [];
		let length = 0,
			done = false;
		const reply = (answer: CompanyComputerFolderAnswer) => {
			if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
		};
		const timer = setTimeout(() => {
			if (!done) socket.destroy();
		}, 5000);
		socket.on("error", () => undefined);
		socket.on("end", () => {
			if (!done) socket.destroy();
		});
		socket.on("data", (chunk: Buffer) => {
			if (done) return;
			const newline = chunk.indexOf(0x0a);
			const part = newline < 0 ? chunk : chunk.subarray(0, newline);
			length += part.length;
			// A run's request carries its command; every other request fits in a request line.
			if (length >= COMPANY_COMPUTER_FOLDER_RUN_LINE_BYTES) {
				done = true;
				clearTimeout(timer);
				return reply({ answer: "invalid" });
			}
			chunks.push(part);
			if (newline < 0) return;
			done = true;
			clearTimeout(timer);
			let request: CompanyComputerFolderRequest | undefined;
			try {
				request = parseCompanyComputerFolderRequest(
					new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
				);
			} catch {
				request = undefined;
			}
			if (!request || (request.op !== "run" && length >= COMPANY_COMPUTER_FOLDER_REQUEST_BYTES))
				return reply({ answer: "invalid" });
			if (request.op === "run") {
				helper.run(request, socket, chunk.subarray(newline + 1));
				return;
			}
			// The answer comes even if the asker left: the mount stays consistent, and `list` shows it.
			void helper.answer(request).then(reply);
		});
	});
	// A run's connection lasts its command's life. The office's own task limit bounds its commands, so this is no cap
	// of its own.
	server.maxConnections = 1024;
	return server;
}

const NEVER = new AbortController().signal;
const FIELDS = ["ActiveState", "Result", "ExecMainCode", "ExecMainStatus"];

function command(file: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, {
			cwd: "/",
			env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
			stdio: ["ignore", "ignore", "inherit"],
			timeout: 10000,
			killSignal: "SIGKILL",
		});
		child.once("error", () => reject(new Error("COMPANY_COMPUTER_FOLDER_COMMAND_FAILED")));
		child.once("close", (code) =>
			code === 0 ? resolve() : reject(new Error("COMPANY_COMPUTER_FOLDER_COMMAND_FAILED")),
		);
	});
}

export function createLinuxCompanyComputerFolderHelperSystem(): CompanyComputerFolderHelperSystem {
	return {
		async inspect(unit) {
			const value = properties(
				await systemctl(["show", "--all", `--property=${FIELDS.join(",")}`, unit], 5000, NEVER),
				FIELDS,
			);
			return {
				active: value.ActiveState,
				result: value.Result,
				execMainCode: integer(value.ExecMainCode, 6),
				execMainStatus: integer(value.ExecMainStatus, 255),
			};
		},
		async start(unit) {
			await systemctl(["start", unit], 30000, NEVER);
		},
		async stop(unit) {
			// The unit's TimeoutStopSec=20s, then its ExecStopPost.
			await systemctl(["stop", unit], 40000, NEVER);
		},
		async resetFailed(unit) {
			await systemctl(["reset-failed", unit], 10000, NEVER);
		},
		mountinfo: () => readCompanyComputerLinuxMetadata("/proc/self/mountinfo", 1048576),
		async share(path) {
			await command("/usr/bin/mount", ["--bind", path, path]);
			await command("/usr/bin/mount", ["--make-rshared", path]);
		},
		detach: (path) => command("/usr/bin/umount", ["-l", path]),
		publish(args, timeoutMs) {
			return new Promise((resolve) => {
				const child = spawn(COMPANY_COMPUTER_FOLDER_PROGRAM, args, {
					cwd: "/",
					env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
					stdio: ["ignore", "pipe", "inherit"],
				});
				const chunks: Buffer[] = [];
				let length = 0,
					killed = false;
				const kill = () => {
					killed = true;
					child.kill("SIGKILL");
				};
				const timer = setTimeout(kill, timeoutMs);
				child.stdout.on("data", (chunk: Buffer) => {
					length += chunk.length;
					// The report must fit in the answer line with its wrapping.
					if (length > COMPANY_COMPUTER_FOLDER_ANSWER_BYTES - 4096) kill();
					else chunks.push(chunk);
				});
				child.once("error", () => {
					clearTimeout(timer);
					resolve({ code: null, stdout: undefined });
				});
				child.once("close", (code) => {
					clearTimeout(timer);
					resolve(killed ? { code: null, stdout: undefined } : { code, stdout: Buffer.concat(chunks) });
				});
			});
		},
		launch: (args) =>
			spawn(COMPANY_COMPUTER_FOLDER_PROGRAM, args, {
				cwd: "/",
				env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
				stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
			}),
		namespaceInUse(mntns, name) {
			const wanted = `mnt:[${mntns}]`;
			// A task that exited: its links and its mount table no longer read (EINVAL opening the table of one that is
			// exiting). Any other error is no answer.
			const gone = (error: unknown): undefined => {
				if (!["ENOENT", "ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				return undefined;
			};
			// Undefined when the task's link does not read (it exited, or it is a leader whose other threads still run).
			const inside = async (task: string): Promise<boolean | undefined> => {
				const target = await readlink(`${task}/ns/mnt`).catch(gone);
				if (target !== wanted) return target === undefined ? undefined : false;
				const table = await readCompanyComputerLinuxMetadata(`${task}/mountinfo`, 1048576).catch(gone);
				return table !== undefined && isCompanyComputerCommandNamespace(parseCompanyComputerMountinfo(table), name);
			};
			return companyComputerNamespaceInUse({
				lastPid: async () =>
					integer((await readCompanyComputerLinuxMetadata("/proc/sys/kernel/ns_last_pid", 64)).trim(), 4194304),
				pids: async () => (await readdir("/proc")).filter((pid) => /^[1-9][0-9]*$/.test(pid)).map(Number),
				async inside(pid) {
					let found = await inside(`/proc/${pid}`);
					if (found === undefined)
						for (const tid of await readdir(`/proc/${pid}/task`).catch(
							(error: unknown): string[] => gone(error) ?? [],
						)) {
							if (tid !== String(pid)) found = await inside(`/proc/${pid}/task/${tid}`);
							if (found !== undefined) break;
						}
					return found === true;
				},
			});
		},
	};
}
