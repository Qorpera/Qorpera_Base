import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdtemp, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { idleRuleBusy } from "@qorpera/contracts";
import type {
	CompanyComputerGuestBoundary,
	CompanyComputerGuestShell,
	CompanyComputerShellCommandResult,
	CompanyComputerShellListResult,
} from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import { CompanyComputerActionFailedError, companyComputerActionCheck } from "./cloud-company-computer-leases.ts";
import {
	assertCompanyComputerImageArtifact,
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	type CompanyComputerCommandLimits,
	companyComputerLinuxSandboxArgs,
	openCompanyComputerLinuxDirectory,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";
import {
	COMPANY_COMPUTER_HOSTS,
	COMPANY_COMPUTER_RESOLV_CONF,
	plumbCompanyComputerNetwork,
} from "./cloud-company-computer-linux-network.ts";
import { spawnCompanyComputerLinuxProcess } from "./cloud-company-computer-linux-process.ts";
import {
	COMPANY_COMPUTER_NAMESPACE_CHILD,
	COMPANY_COMPUTER_SHELL_LINE_LIMIT,
	type CompanyComputerShellHostEvent,
	type CompanyComputerShellHostRequest,
	parseCompanyComputerShellHostEvent,
} from "./cloud-company-computer-shell-host.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

/** Storage safety, not work limits: what the service keeps of each command. */
export const COMPANY_COMPUTER_SHELL_KEPT_OUTPUT = 1024 * 1024;
/** Output one reply shows; the native reply envelope is 48 KiB including JSON escaping. */
export const COMPANY_COMPUTER_SHELL_REPLY_OUTPUT = 16 * 1024;
/** Each shell's private /tmp, memory-backed like the service's other scratch space. */
export const COMPANY_COMPUTER_SHELL_TMP_BYTES = 512 * 1024 * 1024;
/** Finished commands remembered for a later read or list. */
const FINISHED_KEPT = 64;
const LISTED = 40;
/** Where every command starts. The company folder mount will replace this with `/company`. */
export function companyComputerShellWorkingDirectory(layout: CompanyComputerGuestLayout): string {
	return layout.workbenchRoot;
}
/** Image configuration a shell may read. Nothing here holds a secret; missing entries are skipped. */
const SHELL_IMAGE_FILES = [
	"/etc/passwd",
	"/etc/group",
	"/etc/nsswitch.conf",
	"/etc/ld.so.cache",
	"/etc/ssl/openssl.cnf",
];
const SHELL_IMAGE_DIRECTORIES = ["/etc/ssl/certs", "/etc/alternatives", "/etc/fonts", "/etc/xdg"];

/**
 * Why a command ended, for the platform's record of it: on its own, by the
 * agent, or by the machine (memory or task pressure, the operator's pause, or
 * the shell closing with its screen).
 */
export type CompanyComputerShellEndReason = "exited" | "stopped" | "pressure" | "paused" | "closed";

/**
 * What the office tells the platform about one shell, each busy report. Each
 * command names the run that started it and that start's effect receipt, which
 * the platform matches against the screen's own record.
 */
export interface CompanyComputerShellReport {
	/** workedAt: when the agent last started or typed into it, which restarts the check-in count. */
	open: { id: string; runId: string; receiptId: string; command: string; startedAt: string; workedAt: string }[];
	ended: {
		id: string;
		runId: string;
		receiptId: string;
		command: string;
		startedAt: string;
		reason: CompanyComputerShellEndReason;
		endedAt: string;
	}[];
}

/** The command head the platform keeps and shows; the rest stays in the shell. */
const REPORTED_COMMAND = 300;
/** At most REPORTED_COMMAND characters, never half of one (the platform refuses a lone surrogate). */
function reportedCommand(command: string): string {
	return Array.from(command).slice(0, REPORTED_COMMAND).join("");
}
/** Ended commands kept for the next report; older ones are left to the platform's own end. */
const REPORTED_ENDED = 256;

interface Session {
	id: string;
	/** The run that started it: it is told when the command stops, and asked about it. */
	runId: string;
	/** The start's effect receipt (its key). */
	receiptId: string;
	command: string;
	startedAt: string;
	/** When the agent last started or typed into it. */
	workedAt: string;
	state: "starting" | CompanyComputerShellCommandResult["state"];
	exitCode?: number;
	signal?: string;
	stopRequested: boolean;
	/** Why the machine ended it, when neither the command nor the agent did. */
	note?: string;
	endReason?: CompanyComputerShellEndReason;
	inputEnded: boolean;
	chunks: Buffer[];
	/** Absolute byte offsets: the first kept byte, the total, and what replies have shown. */
	keptFrom: number;
	total: number;
	readTo: number;
	waiters: Set<() => void>;
}

/** The physical namespace behind one shell. Test seams replace it with an in-process host. */
export interface CompanyComputerShellEnvironment {
	send(request: CompanyComputerShellHostRequest): void;
	/** Settles when the namespace has exited and been reaped. */
	readonly exited: Promise<void>;
	stop(): Promise<void>;
	/** The namespace's outermost process, for memory and task accounting from outside it. */
	readonly pid?: number;
}

export type CompanyComputerShellEnvironmentLauncher = (
	onEvent: (event: CompanyComputerShellHostEvent) => void,
	signal: AbortSignal,
) => Promise<CompanyComputerShellEnvironment>;

function alignStart(bytes: Buffer, index: number): number {
	while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) index++;
	return index;
}

function alignEnd(bytes: Buffer, index: number): number {
	while (index > 0 && (bytes[index] & 0xc0) === 0x80) index--;
	return index;
}

/** Where a trailing, still incomplete UTF-8 character starts, or the length when there is none. */
function completeEnd(bytes: Buffer): number {
	const start = alignEnd(bytes, bytes.length - 1);
	if (start < 0 || start >= bytes.length) return bytes.length;
	const lead = bytes[start];
	const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
	return bytes.length - start < needed ? start : bytes.length;
}

function decode(bytes: Buffer): string {
	return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Bookkeeping for one shell: commands, their kept output and waits. It trusts
 * nothing the namespace reports beyond ids it issued and bounded sizes.
 */
export class CompanyComputerLinuxShell implements CompanyComputerGuestShell {
	readonly #launch: CompanyComputerShellEnvironmentLauncher;
	readonly #sessions = new Map<string, Session>();
	readonly #keys = new Map<string, string>();
	readonly #stop = new AbortController();
	#environment?: Promise<CompanyComputerShellEnvironment>;
	/** The current namespace once its start has finished; commands are sent to it. */
	#ready?: CompanyComputerShellEnvironment;
	/** The running namespace's outermost process, once its start has finished. */
	#pid?: number;
	/** Why a namespace is ending, for the commands that end with it. */
	#endNote?: {
		environment: Promise<CompanyComputerShellEnvironment>;
		note?: string;
		reason: CompanyComputerShellEndReason;
	};
	/** Commands that ended since the platform last heard, oldest first. */
	readonly #unreported = new Map<string, CompanyComputerShellReport["ended"][number]>();
	/** A namespace being stopped as a whole: new commands wait for the next one. */
	#ending?: Promise<CompanyComputerShellEnvironment>;
	/** Each launch's own cancellation, joined with the shell's lifetime. */
	readonly #launches = new Map<Promise<CompanyComputerShellEnvironment>, AbortController>();
	/** Namespaces let go of before they were confirmed gone; closing waits for each and fails if one is not. */
	readonly #released = new Set<Promise<void>>();
	/** Of those, the ones still stopping. */
	#releasing = 0;
	#processes = 0;
	#closing?: Promise<void>;

	constructor(launch: CompanyComputerShellEnvironmentLauncher) {
		this.#launch = launch;
	}

	/** Anything still running in the shell keeps the computer from powering off. */
	get busy(): boolean {
		// A namespace still being stopped may still run something. One whose stop
		// could not be confirmed does not keep the machine on: powering off ends it.
		if (this.#releasing) return true;
		if (!this.#environment) return false;
		return (
			this.#processes > 0 ||
			[...this.#sessions.values()].some((s) => s.state === "starting" || s.state === "running")
		);
	}

	#wake(session: Session): void {
		for (const wake of session.waiters) wake();
		session.waiters.clear();
	}

	#event(environment: Promise<CompanyComputerShellEnvironment>, event: CompanyComputerShellHostEvent): void {
		if (this.#environment !== environment) return;
		if (event.t === "procs") {
			this.#processes = event.count;
			return;
		}
		if (event.t === "ready") return;
		const session = this.#sessions.get(event.id);
		if (!session) return;
		if (event.t === "started") {
			// Waits end when the command ends, not when it starts.
			if (session.state === "starting") session.state = "running";
			return;
		}
		if (event.t === "failed") {
			if (session.state === "starting") {
				session.state = "exited";
				session.exitCode = 127;
				this.#end(session, "exited");
			}
		} else if (event.t === "out") {
			const bytes = Buffer.from(event.data, "base64");
			if (session.state === "exited" || session.state === "stopped" || !bytes.length) return;
			session.chunks.push(bytes);
			session.total += bytes.length;
			// Keep the newest bytes; the oldest go first.
			while (session.total - session.keptFrom > COMPANY_COMPUTER_SHELL_KEPT_OUTPUT && session.chunks.length) {
				const excess = session.total - session.keptFrom - COMPANY_COMPUTER_SHELL_KEPT_OUTPUT;
				const first = session.chunks[0];
				if (first.length <= excess) {
					session.chunks.shift();
					session.keptFrom += first.length;
				} else {
					session.chunks[0] = first.subarray(excess);
					session.keptFrom += excess;
				}
			}
			return;
		} else if (event.t === "exit") {
			if (session.state === "exited" || session.state === "stopped") return;
			session.state = session.stopRequested ? "stopped" : "exited";
			this.#end(session, session.stopRequested ? "stopped" : "exited");
			if (event.code !== null) session.exitCode = event.code;
			if (event.signal !== null) session.signal = event.signal;
		}
		this.#wake(session);
		this.#forget();
	}

	/** A command ended: the platform hears why with the next report. */
	#end(session: Session, reason: CompanyComputerShellEndReason): void {
		session.endReason = reason;
		this.#unreported.set(session.id, {
			id: session.id,
			runId: session.runId,
			receiptId: session.receiptId,
			command: reportedCommand(session.command),
			startedAt: session.startedAt,
			reason,
			endedAt: new Date().toISOString(),
		});
		for (const id of this.#unreported.keys()) {
			if (this.#unreported.size <= REPORTED_ENDED) break;
			this.#unreported.delete(id);
		}
	}

	/** Remember at most a fixed number of finished commands. */
	#forget(): void {
		const finished = [...this.#sessions.values()].filter((s) => s.state === "exited" || s.state === "stopped");
		for (const session of finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT))) {
			this.#sessions.delete(session.id);
			for (const [key, id] of this.#keys) if (id === session.id) this.#keys.delete(key);
		}
	}

	/** The namespace ended: every command in it has ended with it. */
	#ended(environment: Promise<CompanyComputerShellEnvironment>): void {
		if (this.#environment !== environment) return;
		const end = this.#endNote?.environment === environment ? this.#endNote : undefined;
		if (end) this.#endNote = undefined;
		this.#environment = undefined;
		this.#ready = undefined;
		this.#pid = undefined;
		this.#launches.delete(environment);
		if (this.#ending === environment) this.#ending = undefined;
		this.#processes = 0;
		for (const session of this.#sessions.values())
			if (session.state === "starting" || session.state === "running") {
				session.state = "stopped";
				if (end?.note) session.note = end.note;
				this.#end(session, end?.reason ?? "closed");
				this.#wake(session);
			}
	}

	/**
	 * The namespace, started once for the commands that need it. Its start
	 * belongs to the shell, not to any call: on a busy machine it may take
	 * longer than a call may wait, so commands queue until it is ready, and a
	 * start that fails ends them with the reason.
	 */
	#open(): Promise<CompanyComputerShellEnvironment> {
		this.#stop.signal.throwIfAborted();
		if (this.#environment) return this.#environment;
		const cancel = new AbortController();
		const environment: Promise<CompanyComputerShellEnvironment> = this.#launch(
			// A launcher may report before this call has returned; its events keep their order.
			(event) => queueMicrotask(() => this.#event(environment, event)),
			AbortSignal.any([this.#stop.signal, cancel.signal]),
		);
		this.#environment = environment;
		this.#launches.set(environment, cancel);
		environment.then(
			(opened) => {
				if (this.#environment === environment) {
					this.#ready = opened;
					this.#pid = opened.pid;
				}
				void opened.exited.then(
					() => this.#ended(environment),
					() => this.#ended(environment),
				);
			},
			(error: unknown) => {
				// A start that could not confirm its namespace gone stays an unknown
				// outcome: closing waits for nothing more but reports it unconfirmed.
				if (!(error instanceof CompanyComputerActionFailedError))
					this.#release(Promise.reject(new Error("OFFICE_SHELL_DRAIN_UNCONFIRMED", { cause: error })));
				if (this.#endNote?.environment !== environment && !this.#stop.signal.aborted)
					this.#endNote = {
						environment,
						note: "The shell could not start; start the command again.",
						reason: "closed",
					};
				this.#ended(environment);
			},
		);
		return environment;
	}

	/** Tracks a namespace that was let go of until its stop is confirmed. */
	#release(teardown: Promise<void>): void {
		this.#released.add(teardown);
		this.#releasing++;
		// A confirmed stop is forgotten; an unconfirmed one stays for closing to report.
		void teardown
			.then(
				() => this.#released.delete(teardown),
				() => undefined,
			)
			.finally(() => this.#releasing--);
	}

	/**
	 * Stop everything in the current namespace. A namespace still starting is
	 * cancelled and let go of now, and closing waits for its stop; a ready one
	 * is stopped here. New commands meanwhile wait for the next namespace.
	 */
	async #stopAll(reason: CompanyComputerShellEndReason, note?: string): Promise<void> {
		const current = this.#environment;
		if (!current) return;
		const opened = this.#ready;
		this.#endNote = { environment: current, reason, ...(note ? { note } : {}) };
		if (!opened) {
			this.#launches.get(current)?.abort();
			this.#release(
				current.then(
					(launched) => launched.stop(),
					(error: unknown) => {
						if (!(error instanceof CompanyComputerActionFailedError)) throw error;
					},
				),
			);
			this.#ended(current);
			return;
		}
		this.#ending = current;
		await opened.stop();
		this.#ended(current);
	}

	#session(sessionId: string): Session {
		const session = this.#sessions.get(sessionId);
		if (!session) throw new Error("OFFICE_SHELL_SESSION_UNKNOWN");
		return session;
	}

	async #wait(session: Session, waitMs: number, signal: AbortSignal): Promise<void> {
		if (session.state === "exited" || session.state === "stopped" || waitMs <= 0) return;
		await new Promise<void>((done, fail) => {
			const release = (): void => {
				clearTimeout(timer);
				signal.removeEventListener("abort", cancel);
				session.waiters.delete(finish);
			};
			const finish = (): void => {
				release();
				done();
			};
			const cancel = (): void => {
				release();
				fail(new Error("OFFICE_SHELL_WAIT_CANCELLED"));
			};
			const timer = setTimeout(finish, waitMs);
			session.waiters.add(finish);
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		});
	}

	/** What this reply shows: everything unread, or its head and tail with the middle counted. */
	#result(session: Session): CompanyComputerShellCommandResult {
		const from = Math.max(session.readTo, session.keptFrom);
		const dropped = from - session.readTo;
		let bytes = Buffer.concat(session.chunks).subarray(from - session.keptFrom);
		// A character split between two chunks waits for its rest while the command runs.
		if (session.state === "starting" || session.state === "running") bytes = bytes.subarray(0, completeEnd(bytes));
		session.readTo = from + bytes.length;
		let output = "";
		let cut = 0;
		for (let budget = COMPANY_COMPUTER_SHELL_REPLY_OUTPUT; ; budget = Math.floor(budget / 2)) {
			if (bytes.length <= budget) {
				cut = 0;
				output = decode(bytes);
			} else {
				const head = alignEnd(bytes, Math.floor(budget / 4));
				const tail = alignStart(bytes, bytes.length - Math.floor((budget * 3) / 4));
				cut = tail - head;
				output = `${decode(bytes.subarray(0, head))}\n[${cut} bytes not shown]\n${decode(bytes.subarray(tail))}`;
			}
			// Control bytes grow sixfold in JSON; the reply must still fit its envelope.
			if (Buffer.byteLength(JSON.stringify(output)) <= COMPANY_COMPUTER_SHELL_REPLY_OUTPUT + 4096 || budget < 256)
				break;
		}
		if (dropped) output = `[${dropped} earlier bytes not kept]\n${output}`;
		return {
			sessionId: session.id,
			state: session.state === "starting" ? "running" : session.state,
			...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
			...(session.signal === undefined ? {} : { signal: session.signal }),
			output,
			...(dropped + cut ? { skippedBytes: dropped + cut } : {}),
			...(session.note === undefined ? {} : { note: session.note }),
		};
	}

	/** The ready namespace a live command runs in; never a fresh one. */
	#current(session: Session): CompanyComputerShellEnvironment {
		if (!this.#environment || (session.state !== "starting" && session.state !== "running"))
			throw new Error("OFFICE_SHELL_SESSION_ENDED");
		if (!this.#ready) throw new Error("OFFICE_SHELL_STARTING");
		return this.#ready;
	}

	async start(input: Parameters<CompanyComputerGuestShell["start"]>[0]): Promise<{ sessionId: string }> {
		const known = this.#keys.get(input.key);
		if (known && this.#sessions.has(known)) return { sessionId: known };
		// A command must not land in a shell the machine is ending; the next start opens a fresh one.
		if (this.#environment && this.#ending === this.#environment) throw new Error("OFFICE_SHELL_RESTARTING");
		input.signal.throwIfAborted();
		const environment = this.#open();
		const session: Session = {
			id: randomUUID(),
			runId: input.runId,
			receiptId: input.key,
			command: input.command,
			startedAt: new Date().toISOString(),
			workedAt: new Date().toISOString(),
			state: "starting",
			stopRequested: false,
			inputEnded: false,
			chunks: [],
			keptFrom: 0,
			total: 0,
			readTo: 0,
			waiters: new Set(),
		};
		this.#sessions.set(session.id, session);
		this.#keys.set(input.key, session.id);
		// Sent once the shell is ready; a command stopped before that never runs.
		void environment.then(
			(opened) => {
				if (this.#ready === opened && session.state === "starting" && !session.stopRequested)
					opened.send({ t: "start", id: session.id, command: input.command });
			},
			() => undefined,
		);
		return { sessionId: session.id };
	}

	known(sessionId: string): boolean {
		return this.#sessions.has(sessionId);
	}

	async result(input: Parameters<CompanyComputerGuestShell["result"]>[0]): Promise<CompanyComputerShellCommandResult> {
		const session = this.#session(input.sessionId);
		await this.#wait(session, input.waitMs, input.signal);
		return this.#result(session);
	}

	async write(input: Parameters<CompanyComputerGuestShell["write"]>[0]): Promise<{ sessionId: string }> {
		const session = this.#session(input.sessionId);
		if (session.inputEnded) throw new Error("OFFICE_SHELL_INPUT_ENDED");
		const environment = this.#current(session);
		input.signal.throwIfAborted();
		session.inputEnded = input.endInput;
		session.workedAt = new Date().toISOString();
		environment.send({
			t: "write",
			id: session.id,
			data: Buffer.from(input.text).toString("base64"),
			end: input.endInput,
		});
		return { sessionId: session.id };
	}

	async stop(
		input: Parameters<CompanyComputerGuestShell["stop"]>[0],
	): Promise<{ sessionId: string } | { stopped: number }> {
		if (input.sessionId === undefined) {
			const running = [...this.#sessions.values()].filter(
				(s) => s.state === "starting" || s.state === "running",
			).length;
			await this.#stopAll("stopped");
			return { stopped: running };
		}
		const session = this.#session(input.sessionId);
		if (session.state === "starting" || session.state === "running") {
			session.stopRequested = true;
			if (this.#ready && this.#environment) {
				// The group gets SIGTERM, then SIGKILL two seconds later.
				this.#ready.send({ t: "stop", id: session.id });
			} else {
				// Its shell is still starting: it will never be sent.
				session.state = "stopped";
				this.#wake(session);
			}
		}
		return { sessionId: session.id };
	}

	list(): CompanyComputerShellListResult {
		const commands: CompanyComputerShellListResult["commands"] = [];
		let bytes = 0;
		for (const session of [...this.#sessions.values()].reverse().slice(0, LISTED)) {
			// A preview: one line, no control characters, so every entry stays small in JSON.
			const preview = session.command.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
			const entry = {
				sessionId: session.id,
				command: preview.length > 120 ? `${preview.slice(0, 120)}…` : preview,
				state: session.state === "starting" ? ("running" as const) : session.state,
				...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
				startedAt: session.startedAt,
				unreadBytes: session.total - Math.max(session.readTo, session.keptFrom),
			};
			bytes += Buffer.byteLength(JSON.stringify(entry));
			if (bytes > COMPANY_COMPUTER_SHELL_REPLY_OUTPUT) break;
			commands.push(entry);
		}
		const omitted = this.#sessions.size - commands.length;
		return {
			commands,
			...(omitted ? { omittedCommands: omitted } : {}),
			processes: this.#environment ? this.#processes : 0,
		};
	}

	/** The running namespace's outermost process, for accounting; none while it starts or after it ended. */
	get namespacePid(): number | undefined {
		return this.#pid;
	}

	/**
	 * The machine is about to run out of memory or tasks: everything in this
	 * shell ends, with the reason on each command, and the next start opens a
	 * fresh one. A storage-safety stop, taken before the kernel's own.
	 */
	async relieve(note: string): Promise<void> {
		// Only a ready namespace holds anything to weigh. Tracked until its stop is
		// confirmed: an unconfirmed stop stays busy and weighed, and the note stays
		// until this namespace ends, even if that is after a stop that timed out.
		if (!this.#ready) return;
		await this.#stopAll("pressure", note);
	}

	/**
	 * The operator paused the company: everything in this shell ends, a
	 * namespace still starting too, with the reason on each command. The next
	 * start after the pause opens a fresh one.
	 */
	async pause(note: string): Promise<void> {
		await this.#stopAll("paused", note);
	}

	/**
	 * What the platform keeps of this shell: the commands still open, and those
	 * that ended since the last acknowledged report.
	 */
	report(): CompanyComputerShellReport {
		return {
			open: [...this.#sessions.values()]
				.filter((s) => s.state === "starting" || s.state === "running")
				.map((s) => ({
					id: s.id,
					runId: s.runId,
					receiptId: s.receiptId,
					command: reportedCommand(s.command),
					startedAt: s.startedAt,
					workedAt: s.workedAt,
				})),
			ended: [...this.#unreported.values()],
		};
	}

	/** The platform recorded these ends. */
	reported(ids: readonly string[]): void {
		for (const id of ids) this.#unreported.delete(id);
	}

	/** Ends every process in the shell and the namespace itself. A timeout is never success. */
	close(): Promise<void> {
		this.#stop.abort();
		this.#closing ??= cloudToolRequest(
			async () => {
				const current = this.#environment;
				if (current) {
					// Closing aborts a start in progress; its launch then settles quickly.
					const opened = await current.catch(() => undefined);
					await opened?.stop();
					this.#ended(current);
				}
				const released = await Promise.allSettled([...this.#released]);
				if (released.some((result) => result.status === "rejected"))
					throw new Error("OFFICE_SHELL_DRAIN_UNCONFIRMED");
			},
			new AbortController().signal,
			15000,
		);
		return this.#closing;
	}
}

/**
 * The real shell namespace of one screen. Same sandbox as today's commands:
 * no host network device, PID view, capabilities or privileges; the workbench
 * and the desktop home read-write, a read-only image. Never the screen's
 * display: any X client of the screen could read what a member types there,
 * so agents open programs on the screen through desktop actions instead.
 * Its network is its own: the root plumber adds a veth as it starts, and the
 * machine's firewall lets it reach the public internet on any port and
 * protocol but nothing private, the machine itself or other computers.
 * Browser profiles, sign-ins, service credentials and the NAS are not mounted.
 * Its processes are the machine's first choice when memory runs out.
 */
export function createCompanyComputerLinuxShellLauncher(options: {
	binding: CompanyComputerScreenBinding;
	layout: CompanyComputerGuestLayout;
	workbenchMount: RecoveryDirectoryMount;
	limits: CompanyComputerCommandLimits;
	/** Existing private local directory with root-owned ancestors, outside every persistent root. */
	runtimeRoot: string;
	boundary: CompanyComputerGuestBoundary;
	timeZone?: string;
	/** Test seam for the root plumber's socket. */
	plumbSocket?: string;
}): CompanyComputerShellEnvironmentLauncher {
	assertCompanyComputerScreenBinding(options.binding, options.binding);
	assertCompanyComputerGuestLayout(options.layout);
	const { binding, layout, runtimeRoot } = options;
	if (
		runtimeRoot === "/" ||
		runtimeRoot !== resolve(runtimeRoot) ||
		/[\x00-\x1f\x7f\\]/.test(runtimeRoot) ||
		Object.values(layout).some(
			(root) => runtimeRoot === root || runtimeRoot.startsWith(`${root}/`) || root.startsWith(`${runtimeRoot}/`),
		)
	)
		throw new Error("UNSAFE_OFFICE_CONTROL_PATH");
	if (options.timeZone !== undefined && !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(options.timeZone))
		throw new Error("INVALID_OFFICE_TIME_ZONE");
	return async (onEvent, lifetime) => {
		const files: FileHandle[] = [];
		let temporary: string | undefined;
		const release = async (): Promise<void> => {
			await Promise.all(files.map((file) => file.close().catch(() => undefined)));
			if (temporary) await rm(temporary, { recursive: true, force: true });
		};
		// A start that failed before its namespace existed left nothing running:
		// the action failed as its own and the screen is not drained for it (the
		// gate checks its authority again). The same holds once a started
		// namespace is confirmed gone; one that is not stays an unknown outcome.
		let launched: ReturnType<typeof spawnCompanyComputerLinuxProcess>;
		try {
			if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.())
				throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
			lifetime.throwIfAborted();
			await companyComputerActionCheck(
				cloudToolRequest((checked) => options.boundary.assertReady(binding, checked), lifetime),
			);
			await assertCompanyComputerLinuxHost(options.limits, lifetime);
			for (const path of [
				"/usr/bin/bwrap",
				"/usr/bin/tini",
				"/usr/bin/bash",
				"/usr/bin/node",
				COMPANY_COMPUTER_NAMESPACE_CHILD,
			])
				await assertCompanyComputerImageArtifact(path);
			await assertCompanyComputerImageArtifact("/usr", true);
			files.push(await openCompanyComputerLinuxDirectory(layout.workbenchRoot, false));
			files.push(await openCompanyComputerLinuxDirectory(layout.desktopHome, true));
			await assertCompanyComputerWorkbenchMount(files[0], options.workbenchMount, [
				layout.workbenchRoot,
				layout.desktopHome,
			]);
			const runtime = await openCompanyComputerLinuxDirectory(runtimeRoot, true);
			try {
				temporary = await mkdtemp(join(runtimeRoot, `shell-${binding.screenOrdinal}-`));
			} finally {
				await runtime.close();
			}
			await writeFile(join(temporary, "hosts"), COMPANY_COMPUTER_HOSTS, { mode: 0o444, flag: "wx" });
			await writeFile(join(temporary, "resolv.conf"), COMPANY_COMPUTER_RESOLV_CONF, { mode: 0o444, flag: "wx" });
			const args = [
				// Package builds unpack into /tmp; tmpfs pages are only used when written,
				// and they are memory: the pressure guard counts them.
				...companyComputerLinuxSandboxArgs(COMPANY_COMPUTER_SHELL_TMP_BYTES),
				"--bind-fd",
				"5",
				layout.workbenchRoot,
				"--bind-fd",
				"6",
				"/home/qorpera",
				"--ro-bind",
				join(temporary, "hosts"),
				"/etc/hosts",
				"--ro-bind",
				join(temporary, "resolv.conf"),
				"/etc/resolv.conf",
			];
			for (const [paths, directory] of [
				[SHELL_IMAGE_FILES, false],
				[SHELL_IMAGE_DIRECTORIES, true],
			] as const)
				for (const path of paths) {
					if (!(await lstat(path).catch(() => undefined))) continue;
					await assertCompanyComputerImageArtifact(path, directory);
					args.push("--ro-bind", path, path);
				}
			for (const [name, value] of Object.entries({
				HOME: "/home/qorpera",
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
				SHELL: "/usr/bin/bash",
				TERM: "dumb",
				...(options.timeZone ? { TZ: options.timeZone } : {}),
			}))
				args.push("--setenv", name, value);
			args.push("--chdir", companyComputerShellWorkingDirectory(layout), "--remount-ro", "/");
			lifetime.throwIfAborted();
			launched = spawnCompanyComputerLinuxProcess({
				args,
				files,
				stdin: "ignore",
				pipeCount: 2,
				// The computer's own network, before anything in the namespace runs.
				// Without the plumber it starts with loopback only.
				beforeStart: async (pid) => {
					await plumbCompanyComputerNetwork({
						ordinal: binding.screenOrdinal,
						role: "shell",
						pid,
						...(options.plumbSocket ? { socket: options.plumbSocket } : {}),
					});
				},
				// The machine's out-of-memory choice falls on the shell before the
				// service, the desktops and the browsers; commands inherit it.
				command: [
					"/usr/bin/bash",
					"--noprofile",
					"--norc",
					"-c",
					`printf 1000 > /proc/self/oom_score_adj || exit 1; exec /usr/bin/node ${COMPANY_COMPUTER_NAMESPACE_CHILD} --shell-host`,
					"qorpera-shell-host",
				],
			});
		} catch (error) {
			await release();
			throw new CompanyComputerActionFailedError(error);
		}
		const { child } = launched;
		const exited = new Promise<void>((finished, failed) => {
			child.once("close", () => void release().then(finished, failed));
		});
		void exited.catch(() => undefined);
		const stop = (): Promise<void> => {
			launched.stop();
			return cloudToolRequest(() => exited, new AbortController().signal, 10000);
		};
		const kill = (): void => void stop().catch(() => undefined);
		lifetime.addEventListener("abort", kill, { once: true });
		void exited.finally(() => lifetime.removeEventListener("abort", kill));
		let logs = 0;
		for (const stream of [child.stdout!, child.stderr!])
			stream.on("data", (bytes: Buffer) => {
				logs += bytes.length;
				if (logs > 1024 * 1024) kill();
			});
		const toHost = child.stdio[3] as Duplex;
		const fromHost = child.stdio[4] as Duplex;
		toHost.on("error", () => undefined);
		fromHost.on("error", kill);
		let ready: () => void = () => undefined;
		let gone: (error: Error) => void = () => undefined;
		const hostReady = new Promise<void>((resolveReady, rejectReady) => {
			ready = resolveReady;
			gone = rejectReady;
		});
		void hostReady.catch(() => undefined);
		// An entry file without the shell host (an older image revision) exits at once.
		child.once("close", () => gone(new Error("OFFICE_SHELL_HOST_EXITED")));
		let buffer = "";
		let overflowed = false;
		fromHost.setEncoding("utf8");
		fromHost.on("data", (text: string) => {
			if (overflowed) return;
			buffer += text;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let event: CompanyComputerShellHostEvent | undefined;
				try {
					event = parseCompanyComputerShellHostEvent(line);
				} catch {
					event = undefined;
				}
				if (event?.t === "ready") ready();
				if (event) onEvent(event);
				newline = buffer.indexOf("\n");
			}
			// Anything in the namespace can write here; an endless line ends the shell.
			if (buffer.length > COMPANY_COMPUTER_SHELL_LINE_LIMIT) {
				overflowed = true;
				buffer = "";
				kill();
			}
		});
		try {
			await launched.started;
			// Nobody waits on this with a call's deadline: commands queue until it is ready.
			await cloudToolRequest(() => hostReady, lifetime, 15000);
		} catch (error) {
			try {
				await stop();
			} catch (drain) {
				throw new Error("OFFICE_SHELL_DRAIN_UNCONFIRMED", { cause: new AggregateError([error, drain]) });
			}
			throw new CompanyComputerActionFailedError(error);
		}
		return {
			send: (request) => {
				if (!toHost.destroyed) toHost.write(`${JSON.stringify(request)}\n`);
			},
			exited,
			stop,
			...(child.pid === undefined ? {} : { pid: child.pid }),
		};
	};
}

/** Memory a shell holds (its processes' private memory and its /tmp) and its tasks. */
export interface CompanyComputerShellUsage {
	memoryBytes: number;
	tasks: number;
	/**
	 * Processor time in clock ticks (USER_HZ, 100 a second on Linux): every
	 * process's own and its finished children's, so a build's short-lived
	 * compilers count too. It only grows while the shell's namespace lives.
	 */
	cpuTicks: number;
	/**
	 * Bytes the shell's processes passed to read and write calls on files,
	 * pipes and the terminal (/proc/<pid>/io rchar + wchar; a socket's send and
	 * recv do not count, but a download writes what it receives): every process
	 * of the namespace except the shell host, which relays every command's
	 * output. A background program left running under the namespace's init
	 * counts too. Counts of a reaped process move to its parent: when that is
	 * the host (a command that ended), the sum goes down, and that sample is
	 * simply not busy.
	 */
	ioBytes: number;
}

/** Linux's USER_HZ, the unit of processor time in /proc/<pid>/stat on every architecture we run. */
export const COMPANY_COMPUTER_CLOCK_TICKS_PER_SECOND = 100;

/**
 * Whether a shell was busy between two samples of the same namespace, by the
 * one idle rule (@qorpera/contracts idle-rule): at least 5% of one processor
 * core, or at least 512 KiB moved in a 30-second sample.
 */
export function companyComputerShellBusy(
	before: { cpuTicks: number; ioBytes: number; at: number },
	after: { cpuTicks: number; ioBytes: number; at: number },
): boolean {
	return idleRuleBusy(
		{ cpuSeconds: before.cpuTicks / COMPANY_COMPUTER_CLOCK_TICKS_PER_SECOND, ioBytes: before.ioBytes, at: before.at },
		{ cpuSeconds: after.cpuTicks / COMPANY_COMPUTER_CLOCK_TICKS_PER_SECOND, ioBytes: after.ioBytes, at: after.at },
	);
}

/** The bytes a process passed to read and write calls (/proc/<pid>/io rchar + wchar); 0 when it cannot be read. */
export function companyComputerProcessIoBytes(io: string): number {
	const read = Number(/^rchar: ([0-9]+)$/m.exec(io)?.[1] ?? 0);
	const written = Number(/^wchar: ([0-9]+)$/m.exec(io)?.[1] ?? 0);
	return Number.isSafeInteger(read) && Number.isSafeInteger(written) ? read + written : 0;
}

/**
 * Each shell's usage, read from outside its namespace in one pass over /proc:
 * every process under its Bubblewrap monitor (anonymous resident memory,
 * threads and processor time, and the bytes all but the shell host read and
 * wrote), and the /tmp they see. The memory measure matches the pressure
 * below: memory the kernel cannot reclaim without swap. A process that exits
 * meanwhile counts as nothing.
 */
export async function readCompanyComputerShellUsage(
	rootPids: readonly number[],
): Promise<Map<number, CompanyComputerShellUsage>> {
	const children = new Map<number, number[]>();
	const ticks = new Map<number, number>();
	for (const name of await readdir("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		const stat = await readCompanyComputerLinuxMetadata(`/proc/${name}/stat`, 4096).catch(() => "");
		// The command name may hold spaces and parentheses; the fields after it
		// start at the state (field 3): the parent is field 4, and the processor
		// time is fields 14 to 17 (its own, and its finished children's).
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const parent = Number(fields[1]);
		if (Number.isSafeInteger(parent)) children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
		const time = fields.slice(11, 15).reduce((sum, field) => sum + Number(field), 0);
		if (Number.isSafeInteger(time)) ticks.set(Number(name), time);
	}
	const usages = new Map<number, CompanyComputerShellUsage>();
	for (const rootPid of rootPids) {
		const usage = { memoryBytes: 0, tasks: 0, cpuTicks: 0, ioBytes: 0 };
		// Each process, and whether it is below the shell host (whose own bytes are its commands' relayed output).
		const pending: { pid: number; belowHost: boolean }[] = [{ pid: rootPid, belowHost: false }];
		let inside: number | undefined;
		while (pending.length) {
			const { pid, belowHost } = pending.pop()!;
			const host =
				!belowHost &&
				(await readCompanyComputerLinuxMetadata(`/proc/${pid}/cmdline`, 4096).catch(() => "")).includes(
					"\0--shell-host",
				);
			pending.push(...(children.get(pid) ?? []).map((child) => ({ pid: child, belowHost: belowHost || host })));
			if (pid !== rootPid) inside ??= pid;
			const status = await readCompanyComputerLinuxMetadata(`/proc/${pid}/status`, 65536).catch(() => "");
			usage.memoryBytes += Number(/^RssAnon:\s+([0-9]+) kB$/m.exec(status)?.[1] ?? 0) * 1024;
			usage.tasks += Number(/^Threads:\s+([0-9]+)$/m.exec(status)?.[1] ?? 0);
			usage.cpuTicks += ticks.get(pid) ?? 0;
			if (!host)
				usage.ioBytes += companyComputerProcessIoBytes(
					await readCompanyComputerLinuxMetadata(`/proc/${pid}/io`, 4096).catch(() => ""),
				);
		}
		if (inside !== undefined) {
			const tmp = await statfs(`/proc/${inside}/root/tmp`).catch(() => undefined);
			if (tmp) usage.memoryBytes += (tmp.blocks - tmp.bfree) * tmp.bsize;
		}
		usages.set(rootPid, usage);
	}
	return usages;
}

/**
 * What the office's cgroup holds that the kernel cannot reclaim without swap
 * (anonymous memory and tmpfs; kernel memory such as slab and page tables is
 * left out), and its tasks.
 */
export async function readCompanyComputerShellPressure(): Promise<{
	memoryBytes: number;
	memoryMax: number;
	tasks: number;
	tasksMax: number;
}> {
	const cgroup = /^0::(\/[^\n]*)\n?$/.exec(await readCompanyComputerLinuxMetadata("/proc/self/cgroup", 4096));
	if (!cgroup || resolve(cgroup[1]) !== cgroup[1]) throw new Error("OFFICE_CGROUP_V2_REQUIRED");
	const root = `/sys/fs/cgroup${cgroup[1] === "/" ? "" : cgroup[1]}`;
	const read = (name: string) => readCompanyComputerLinuxMetadata(`${root}/${name}`, 65536);
	const stat = await read("memory.stat");
	const field = (name: string): number => Number(new RegExp(`^${name} ([0-9]+)$`, "m").exec(stat)?.[1] ?? 0);
	const limit = (value: string): number => (value.trim() === "max" ? Number.MAX_SAFE_INTEGER : Number(value.trim()));
	return {
		memoryBytes: field("anon") + field("shmem"),
		memoryMax: limit(await read("memory.max")),
		tasks: Number((await read("pids.current")).trim()),
		tasksMax: limit(await read("pids.max")),
	};
}

/**
 * Memory safety, not a work limit. The shells share the office service's
 * memory and task limits with the service itself, every desktop and every
 * browser, and the kernel's out-of-memory stop would end the whole service
 * (the unit keeps systemd's default OOMPolicy). When what cannot be
 * reclaimed nears the memory limit, or tasks near their limit, the shell
 * holding the most ends first, with the reason on each of its commands. Only
 * a shell that is a real part of the excess ends: pressure from browsers or
 * desktops never costs an agent a small shell. Checks run while any shell is up.
 */
export class CompanyComputerShellPressureGuard {
	readonly #shells: () => CompanyComputerLinuxShell[];
	readonly #pressure: typeof readCompanyComputerShellPressure;
	readonly #usage: typeof readCompanyComputerShellUsage;
	readonly #timer: ReturnType<typeof setInterval>;
	#checking = false;

	constructor(options: {
		shells: () => CompanyComputerLinuxShell[];
		intervalMs?: number;
		pressure?: typeof readCompanyComputerShellPressure;
		usage?: typeof readCompanyComputerShellUsage;
	}) {
		this.#shells = options.shells;
		this.#pressure = options.pressure ?? readCompanyComputerShellPressure;
		this.#usage = options.usage ?? readCompanyComputerShellUsage;
		this.#timer = setInterval(() => {
			if (this.#checking) return;
			this.#checking = true;
			void this.check()
				.catch(() => undefined)
				.finally(() => {
					this.#checking = false;
				});
		}, options.intervalMs ?? 2000);
		this.#timer.unref?.();
	}

	/** One check; returns the shell it ended, if any. */
	async check(): Promise<CompanyComputerLinuxShell | undefined> {
		const open = this.#shells().flatMap((shell) => {
			const pid = shell.namespacePid;
			return pid === undefined ? [] : [{ shell, pid }];
		});
		if (!open.length) return undefined;
		const pressure = await this.#pressure();
		const memoryExcess =
			pressure.memoryBytes - (pressure.memoryMax - Math.max(256 * 1024 * 1024, pressure.memoryMax / 8));
		const taskExcess = pressure.tasks - (pressure.tasksMax - Math.max(32, Math.floor(pressure.tasksMax / 8)));
		if (memoryExcess <= 0 && taskExcess <= 0) return undefined;
		const usages = await this.#usage(open.map(({ pid }) => pid));
		// Memory first, then tasks: a shell that holds no real share of one may of the other.
		for (const kind of ["memory", "tasks"] as const) {
			const excess = kind === "memory" ? memoryExcess : taskExcess;
			if (excess <= 0) continue;
			let heaviest: { shell: CompanyComputerLinuxShell; weight: number } | undefined;
			for (const { shell, pid } of open) {
				const usage = usages.get(pid) ?? { memoryBytes: 0, tasks: 0, cpuTicks: 0 };
				const weight = kind === "memory" ? usage.memoryBytes : usage.tasks;
				if (!heaviest || weight > heaviest.weight) heaviest = { shell, weight };
			}
			// Ending a shell must relieve the pressure: it holds at least the excess,
			// or a sixteenth of the whole limit.
			const floor = Math.max(excess, (kind === "memory" ? pressure.memoryMax : pressure.tasksMax) / 16);
			if (!heaviest || heaviest.weight < floor) continue;
			await heaviest.shell.relieve(
				kind === "memory"
					? "Stopped because the machine was running out of memory; this shell used the most."
					: "Stopped because the machine was running out of processes; this shell had the most.",
			);
			return heaviest.shell;
		}
		return undefined;
	}

	close(): void {
		clearInterval(this.#timer);
	}
}
