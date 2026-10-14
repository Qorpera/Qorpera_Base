import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
	COMPANY_COMPUTER_FOLDER_ANSWER_BYTES,
	COMPANY_COMPUTER_FOLDER_REQUEST_BYTES,
	COMPANY_COMPUTER_FOLDER_ROOT,
	type CompanyComputerFolderAnswer,
	type CompanyComputerFolderAnswers,
	type CompanyComputerFolderBoundary,
	type CompanyComputerFolderMount,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderView,
	companyComputerFolderPaths,
	isCompanyComputerFolderName,
	isCompanyComputerFolderReport,
	isCompanyComputerFolderView,
	parseCompanyComputerFolderRequest,
} from "./cloud-company-computer-folder-helper-client.ts";
import { readCompanyComputerLinuxMetadata } from "./cloud-company-computer-linux-host.ts";
import { integer, properties, systemctl } from "./cloud-company-computer-systemd.ts";

/**
 * The office's folder helper (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Mounts in the VM"): the one root piece that mounts
 * the company folder for a desktop or a command, moves a desktop's mount to a newer view, asks a mount's boundary and
 * takes mounts away. The office service runs with no capabilities, no devices and no `AF_VSOCK`, so it asks this
 * helper over qorpera-office-folder-helper.socket; the stop control, root, asks it too.
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
				mountpoint: decode(fields[4]),
				optional: fields.slice(6, dash),
				fstype: fields[dash + 1],
				source: decode(fields[dash + 2]),
			};
		});
}

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
	readonly log?: (line: string) => void;
}

export class CompanyComputerFolderHelper {
	readonly #system: CompanyComputerFolderHelperSystem;
	readonly #root: string;
	readonly #mountMs: number;
	readonly #switchMs: number;
	readonly #settleMs: number;
	readonly #pollMs: number;
	readonly #log: (line: string) => void;
	/** Each name's requests run one after another; `list` waits for none. */
	readonly #queues = new Map<string, Promise<unknown>>();

	constructor(system: CompanyComputerFolderHelperSystem, options: CompanyComputerFolderHelperOptions = {}) {
		this.#system = system;
		this.#root = options.root ?? COMPANY_COMPUTER_FOLDER_ROOT;
		this.#mountMs = options.mountMs ?? MOUNT_MS;
		this.#switchMs = options.switchMs ?? SWITCH_MS;
		this.#settleMs = options.settleMs ?? SETTLE_MS;
		this.#pollMs = options.pollMs ?? POLL_MS;
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

	answer(request: CompanyComputerFolderRequest): Promise<CompanyComputerFolderAnswer> {
		if (request.op === "list")
			return this.#list().catch((): CompanyComputerFolderAnswers["list"] => ({ answer: "failed" }));
		return this.#queued(request);
	}

	#queued(request: Exclude<CompanyComputerFolderRequest, { op: "list" }>): Promise<CompanyComputerFolderAnswer> {
		const before = this.#queues.get(request.name) ?? Promise.resolve();
		const result = before.then(() => this.#run(request));
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#queues.set(request.name, settled);
		void settled.then(() => {
			if (this.#queues.get(request.name) === settled) this.#queues.delete(request.name);
		});
		return result;
	}

	async #run(request: Exclude<CompanyComputerFolderRequest, { op: "list" }>): Promise<CompanyComputerFolderAnswer> {
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
}

/** One request line per connection, one answer line back. */
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
			if (length >= COMPANY_COMPUTER_FOLDER_REQUEST_BYTES) {
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
			if (!request) return reply({ answer: "invalid" });
			// The answer comes even if the asker left: the mount stays consistent, and `list` shows it.
			void helper.answer(request).then(reply);
		});
	});
	server.maxConnections = 64;
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
	};
}
