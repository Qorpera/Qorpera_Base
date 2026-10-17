import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
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
	type CompanyComputerFolderNotices,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderRunEvent,
	type CompanyComputerFolderRunInput,
	type CompanyComputerFolderView,
	companyComputerFolderAnswerLogged,
	companyComputerFolderPaths,
	isCompanyComputerFolderName,
	isCompanyComputerFolderNotices,
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
 * restart): the office account then gets an error, not an empty company folder; the coordinator chose a loud error
 * (14 Oct). Not `0000`: the program opens the mountpoint for its `rootmode=`, and root bounded to CAP_SYS_ADMIN may
 * not open a `0000` directory (Q3 measured EACCES, 15 Oct), so it opens as the owner.
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
/** How long a `notices` ask may take, the relay's start included. */
const NOTICES_MS = 10000;
/** The least time between two starts of the relay. */
const RELAY_RESTART_MS = 1000;
/** The folder service's frames on a `notices` connection (object-gateway `folder-service/protocol.ts`): a u32
 * big-endian length of the kind byte and the payload, the kind, then the payload's JSON. */
const FOLDER_PROTOCOL = 4;
const FRAME = { hello: 0x48, helloOk: 0x68, notices: 0x51, noticed: 0x71 } as const;
/** The service's largest frame; a page of notices is about 1 MiB. */
const FRAME_BYTES = 2 * 1024 * 1024;

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
	/** Runs `qorpera-folder relay` on this socket path (the path must not exist): each connection to it is carried to
	 * the node's folder service. Settles once the relay exited. */
	relay(socket: string): Promise<void>;
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
	/** The mount's id and its parent's, in the reading process's own mount namespace. */
	readonly id: number;
	readonly parent: number;
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
			if (dash < 0 || fields.length < dash + 3 || !/^[0-9]+$/.test(fields[0]) || !/^[0-9]+$/.test(fields[1]))
				throw new Error("COMPANY_COMPUTER_FOLDER_MOUNTS_UNCONFIRMED");
			return {
				id: Number(fields[0]),
				parent: Number(fields[1]),
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

/** How many passes a look for a namespace's tasks takes before it gives up, answering in use, while tasks keep being
 * made meanwhile; and how many times it lists one process's threads again while its threads keep ending. */
const SCAN_PASSES = 50;

/** A look at a machine's tasks: the last pid it gave (a thread's id is a pid too), the processes there now (their
 * thread group ids), how many threads a process has now (undefined once it is gone; 0 from a read that says nothing,
 * see companyComputerThreadCount), its threads there now (none once
 * it is gone), and whether a thread is in the namespace looked for (undefined once it is gone; an error when that
 * cannot be known). */
export interface CompanyComputerProcessScan {
	lastPid(): Promise<number>;
	processes(): Promise<readonly number[]>;
	count(group: number): Promise<number | undefined>;
	threads(group: number): Promise<readonly number[]>;
	inside(group: number, thread: number): Promise<boolean | undefined>;
}

/**
 * Whether a task is in a namespace that only grows by fork and clone and that no task leaves: the command's filter
 * refuses setns and new user namespaces, and it holds no capability, so it can neither join the namespace (the initial
 * user namespace owns it) nor unshare a mount namespace of its own.
 *
 * One look at every task is not enough: a task can fork while the processes are listed, then end before it is looked
 * at, and its child came after the list. So the look is made in whole passes until a quiet one, a pass during which
 * the last pid given did not move (fewer than pid_max are given during one). Every task then in the namespace was made
 * before that pass and lived through it, so the pass looked at it:
 * - its process's thread group id stayed listed under /proc throughout, as the leader's pid lives until the group's
 *   last task ends (a leader that ended first stays a zombie), and it passes to the task that execs;
 * - the kernel's list of a process's threads can stop early, or resume past a thread, only after one of its threads
 *   ended, listed or not (`next_tid`, `first_tid`): a thread that ends as the list reaches it is not on it, and neither
 *   is any thread after it. The process's thread count (`Threads:` in its status) is the length of that very list:
 *   the kernel changes both together, under the process's signal lock, and reads the count under it. So the count is
 *   read before and after the list, and the threads are listed again until it did not change and the list is that
 *   long: in a quiet pass no thread was made, so no thread ended while the list was made. A count of 0 is read again:
 *   the read found a task the kernel let go of meanwhile, such as a leader whose place a thread took by exec. A listed
 *   thread that reads as gone has ended, and holds no namespace;
 * - a thread that execs takes the group id without a new pid, so the leader's place is looked at last, after the list
 *   it may have left. A leader that is a zombie reads as gone: its threads are listed.
 * While the computer keeps making tasks, a quiet pass can take long to come; the answer is then in use: late, never
 * early. An error is no answer.
 */
export async function companyComputerNamespaceInUse(scan: CompanyComputerProcessScan): Promise<boolean> {
	let last = await scan.lastPid();
	for (let pass = 0; pass < SCAN_PASSES; pass++) {
		for (const group of await scan.processes()) if (await groupInside(scan, group)) return true;
		const now = await scan.lastPid();
		if (now === last) return false;
		last = now;
	}
	return true;
}

async function groupInside(scan: CompanyComputerProcessScan, group: number): Promise<boolean> {
	for (let list = 0; list < SCAN_PASSES; list++) {
		const count = await scan.count(group);
		if (count === undefined) return false;
		if (count === 0) continue;
		const threads = await scan.threads(group);
		if ((await scan.count(group)) !== count || threads.length !== count) continue;
		for (const thread of threads) if (thread !== group && (await scan.inside(group, thread))) return true;
		return (await scan.inside(group, group)) === true;
	}
	return true;
}

/** How many threads a process has now (`Threads:` in its status), undefined once it is gone. 0 is what a read says that
 * found a task the kernel let go of before the read took its count: the task that execs into a leader's place lets the
 * old leader go, so 0 does not say the process is gone. The status's first line is the process's name, which the
 * process sets: its bytes need not be UTF-8, so the status is read as latin1, and only a line feed ends a line, as the
 * kernel escapes it in the name but not a carriage return. */
export async function companyComputerThreadCount(group: number): Promise<number | undefined> {
	let status: string;
	try {
		status = await readFile(`/proc/${group}/status`, {
			encoding: "latin1",
			flag: constants.O_RDONLY | constants.O_NOFOLLOW,
		});
	} catch (error) {
		if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
	const fields = status.split("\n").slice(1);
	const threads = fields.filter((line) => line.startsWith("Threads:"));
	if (threads.length !== 1) throw new Error("COMPANY_COMPUTER_THREADS_UNCONFIRMED");
	return integer(/^Threads:\t([0-9]+)$/.exec(threads[0])?.[1] ?? "", 4194304);
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

/**
 * The folder program's mount. fuser's direct mount always passes the type `fuse` and names the source by FSName, so
 * the kernel lists the program as `fuse qorpera-company` (#1007's mountinfo, Q3's run); `fuse.qorpera` is a mount
 * made through fusermount.
 */
export function isCompanyComputerFolderMount(entry: Pick<CompanyComputerMountEntry, "fstype" | "source">): boolean {
	return (entry.fstype === "fuse" || entry.fstype === "fuse.qorpera") && entry.source === "qorpera-company";
}

/** The top mount at the mountpoint is the folder program's. */
export function companyComputerFolderServed(
	entries: readonly CompanyComputerMountEntry[],
	mountpoint: string,
): boolean {
	const top = entries.filter((entry) => entry.mountpoint === mountpoint).at(-1);
	return !!top && isCompanyComputerFolderMount(top);
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
	readonly noticesMs?: number;
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
	readonly #noticesMs: number;
	readonly #log: (line: string) => void;
	/** Each name's requests, and a run's start, run one after another; `list`, `ended`, `notices` and a command's life
	 * wait for none. */
	readonly #queues = new Map<string, Promise<unknown>>();
	/** The relay `notices` asks go through while it runs, and when it last started. */
	#relay: Promise<void> | undefined;
	#relayAt = Number.NEGATIVE_INFINITY;

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
		this.#noticesMs = options.noticesMs ?? NOTICES_MS;
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
			[`${this.#root}/relay`, 0o700],
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
		if (request.op === "notices")
			return this.#notices(request).catch((): CompanyComputerFolderAnswers["notices"] => ({ answer: "unanswered" }));
		return this.#enqueue(request.name, () => this.#perform(request));
	}

	/**
	 * A view's notices from the node's folder service ("Refusals come from the folder service"), asked on its `notices`
	 * role through the folder program's relay: the view's own id and pass, so the service checks them as it checks the
	 * mount's. Only the page goes back, never the pass. A service without the role (an older one answers its hello
	 * "Bad role"), no relay or no answer in time is `unanswered`.
	 */
	async #notices(
		request: Extract<CompanyComputerFolderRequest, { op: "notices" }>,
	): Promise<CompanyComputerFolderAnswers["notices"]> {
		const deadline = Date.now() + this.#noticesMs;
		const connection = await this.#relayConnection(deadline);
		if (!connection) return { answer: "unanswered" };
		const page = await askNotices(connection, request, deadline - Date.now());
		return page ? { answer: "notices", ...page } : { answer: "unanswered" };
	}

	/** A connection through the relay, which starts on the first ask and again (at most once a second) after it exited;
	 * undefined when none came by `deadline` (Date.now()). */
	async #relayConnection(deadline: number): Promise<Socket | undefined> {
		const socket = `${this.#root}/relay/relay.sock`;
		for (;;) {
			if (!this.#relay && Date.now() - this.#relayAt >= RELAY_RESTART_MS) {
				this.#relayAt = Date.now();
				// A socket the last relay left would keep this one from listening.
				const running: Promise<void> = rm(socket, { force: true })
					.then(() => this.#system.relay(socket))
					.catch((error: unknown) => this.#log(`folder-helper: relay: ${String(error)}`))
					.then(() => {
						if (this.#relay === running) this.#relay = undefined;
					});
				this.#relay = running;
			}
			const connection = await connected(socket);
			if (connection) return connection;
			if (Date.now() >= deadline) return undefined;
			await delay(Math.min(this.#pollMs, Math.max(0, deadline - Date.now())));
		}
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
		request: Exclude<CompanyComputerFolderRequest, { op: "list" | "ended" | "notices" | "run" }>,
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
			if (
				companyComputerFolderServed(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.mountpoint)
			)
				return "mounted";
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
		// The report as a log keeps it ("The report"): a stop's has no other place, since the stop control writes
		// nothing and ends the office service.
		this.#log(
			`folder-helper: boundary ${name}${final ? " (final)" : ""}: ${JSON.stringify(companyComputerFolderAnswerLogged(answer))}`,
		);
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
		if (
			!companyComputerFolderServed(parseCompanyComputerMountinfo(await this.#system.mountinfo()), paths.mountpoint)
		) {
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

/** A connection to a Unix socket, or undefined when none is made. */
function connected(path: string): Promise<Socket | undefined> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		socket.once("error", () => resolve(undefined));
		socket.once("connect", () => {
			socket.removeAllListeners("error");
			// Its asker listens for errors from here on.
			socket.on("error", () => undefined);
			resolve(socket);
		});
	});
}

/**
 * One ask on the folder service's `notices` role: the hello, then, once it is accepted, one `Q` for the notices after
 * `after`. Resolves to the page its `q` carries, or to undefined on an error frame (a refused view, or a service
 * without the role), a frame out of turn, a malformed page, the connection's end or `ms`. The connection is closed
 * after.
 */
function askNotices(
	socket: Socket,
	request: Extract<CompanyComputerFolderRequest, { op: "notices" }>,
	ms: number,
): Promise<CompanyComputerFolderNotices | undefined> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let length = 0,
			accepted = false,
			done = false;
		const finish = (page: CompanyComputerFolderNotices | undefined): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(page);
		};
		const timer = setTimeout(() => finish(undefined), Math.max(0, ms));
		const send = (kind: number, value: unknown): void => {
			const payload = Buffer.from(JSON.stringify(value));
			const head = Buffer.alloc(5);
			head.writeUInt32BE(payload.length + 1, 0);
			head[4] = kind;
			socket.write(Buffer.concat([head, payload]));
		};
		socket.on("error", () => finish(undefined));
		socket.on("close", () => finish(undefined));
		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			length += chunk.length;
			let buffer = Buffer.concat(chunks, length);
			while (!done && buffer.length >= 4) {
				const size = buffer.readUInt32BE(0);
				if (size === 0 || size - 1 > FRAME_BYTES) return finish(undefined);
				if (buffer.length < 4 + size) break;
				const kind = buffer[4];
				let value: unknown;
				try {
					value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(5, 4 + size)));
				} catch {
					return finish(undefined);
				}
				buffer = buffer.subarray(4 + size);
				if (!accepted && kind === FRAME.helloOk) {
					accepted = true;
					send(FRAME.notices, { after: request.after, nonce: request.nonce });
				} else if (accepted && kind === FRAME.noticed && isCompanyComputerFolderNotices(value))
					return finish(value);
				else return finish(undefined);
			}
			chunks.length = 0;
			length = buffer.length;
			if (length > 0) chunks.push(buffer);
		});
		send(FRAME.hello, {
			protocol: FOLDER_PROTOCOL,
			environmentId: request.view.environmentId,
			viewId: request.view.viewId,
			pass: request.view.pass,
			role: "notices",
		});
	});
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
		relay(socket) {
			return new Promise((resolve) => {
				// It runs until it fails or the helper stops (its unit's cgroup goes with it); its words go to the journal.
				const child = spawn(COMPANY_COMPUTER_FOLDER_PROGRAM, ["relay", "--listen", `unix:${socket}`], {
					cwd: "/",
					env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
					stdio: ["ignore", "ignore", "inherit"],
				});
				child.once("error", () => resolve());
				child.once("close", () => resolve());
			});
		},
		namespaceInUse(mntns, name) {
			const wanted = `mnt:[${mntns}]`;
			// A task that exited: its links and its mount table no longer read (EINVAL opening the table of one that is
			// exiting). Any other error is no answer.
			const gone = (error: unknown): undefined => {
				if (!["ENOENT", "ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				return undefined;
			};
			const ids = (names: readonly string[]) => names.filter((id) => /^[1-9][0-9]*$/.test(id)).map(Number);
			return companyComputerNamespaceInUse({
				lastPid: async () =>
					integer((await readCompanyComputerLinuxMetadata("/proc/sys/kernel/ns_last_pid", 64)).trim(), 4194304),
				processes: async () => ids(await readdir("/proc")),
				count: companyComputerThreadCount,
				threads: async (group) =>
					ids(await readdir(`/proc/${group}/task`).catch((error: unknown): string[] => gone(error) ?? [])),
				// Undefined when the thread's link or its table does not read: it ended, or it is a leader that ended
				// before its other threads.
				async inside(group, thread) {
					const task = `/proc/${group}/task/${thread}`;
					const target = await readlink(`${task}/ns/mnt`).catch(gone);
					if (target !== wanted) return target === undefined ? undefined : false;
					const table = await readCompanyComputerLinuxMetadata(`${task}/mountinfo`, 1048576).catch(gone);
					return table === undefined
						? undefined
						: isCompanyComputerCommandNamespace(parseCompanyComputerMountinfo(table), name);
				},
			});
		},
	};
}
