import { performance } from "node:perf_hooks";
import {
	closeCompanyComputerFolderView,
	openCompanyComputerFolderView,
	companyComputerFolderWithin as within,
} from "./cloud-company-computer-desktop-folder.ts";
import {
	askCompanyComputerFolderHelper,
	COMPANY_COMPUTER_FOLDER_BOUNDARY_MS,
	type CompanyComputerFolderAnswer,
	type CompanyComputerFolderReport,
	type CompanyComputerFolderRequest,
	type CompanyComputerFolderRun,
	type CompanyComputerFolderRunEvent,
	type CompanyComputerFolderView,
	companyComputerFolderName,
	startCompanyComputerFolderRun,
} from "./cloud-company-computer-folder-helper-client.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";

/** How long a command's view is asked for while the core does not answer. */
const OPEN_WAIT_MS = 30000;
/** How long the office waits for the helper's mount: its own takes at most 20 s. */
const MOUNT_WAIT_MS = 40000;
const DROP_WAIT_MS = 60000;
/** A final boundary, a drop and an end check with no final answer are asked again after this, doubling up to the
 * cap (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Mounts in the VM"). */
const FINAL_RETRY_MS = 5000;
const ENDED_RETRY_MS = 1000;
const RETRY_CAP_MS = 5 * 60 * 1000;
/** What a tool result lists of the paths the company folder did not take. */
const NOT_SAVED_SHOWN = 20;
const NOT_SAVED_BYTES = 8 * 1024;

/** Why a command does not run in the company folder; the command ends with it. */
const START_UNMOUNTED = "The company folder could not be mounted for this command; start it again.";
const START_FAILED = "The command could not start in the company folder; start it again.";
const START_LOST = "The company folder stopped answering for this command; start it again.";
/** Why a command's output is held back (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Before output reaches a model"). */
const HELD_UNANSWERED = "the company folder did not answer before the reply's deadline; read again";
const HELD_PAUSED = "the company is paused, so the company folder holds this output back";
const HELD_RUN_ENDED = "this run can no longer act in the company folder";
const HELD_REFUSED = "the company folder refused this command's view";
const HELD_STOPPED =
	"the company folder closed or refused this command's view, so the command was stopped and its output is held back; start it again";
const HELD_GONE = "the company folder no longer serves this command, so its output is held back; start it again";
const HELD_SAVING = "the command's last changes are still being saved; read again";
const HELD_NOT_TAKEN = "the company folder did not take this command's last changes";
/** Also the shell's answer to a run that did not start the command. */
export const COMPANY_COMPUTER_COMMAND_OTHER_RUN = "this command's output reaches only the run that started it";

/** What a command's folder tells its session: the run's output and exit, and `lost` when the helper went before the
 * command's end was seen. */
export type CompanyComputerCommandFolderEvent =
	| Exclude<CompanyComputerFolderRunEvent, { t: "ended" }>
	| { readonly t: "lost" };

/** A path of the command's that the company folder did not take, as a tool result shows it. */
export interface CompanyComputerCommandNotSaved {
	readonly path: string;
	readonly outcome: string;
	readonly reason?: string;
}

/**
 * Whether the command's output up to the session's mark may reach the run that started it. `final`: the command's
 * mount is gone, so what is shown now is all there is. `heldBack` says why output is held back; the final boundary's
 * paths not saved come once.
 */
export type CompanyComputerCommandRelease = (
	| { readonly released: true; readonly final?: true }
	| { readonly released: false; readonly heldBack: string }
) & {
	readonly notSaved?: readonly CompanyComputerCommandNotSaved[];
	readonly moreNotSaved?: number;
};

/**
 * `idle`: the command's view and mount are being made, and nothing runs yet. `none`: nothing ran in the folder.
 * `running`: the run request was sent. `ending`: the command ended (or the helper lost it), and its final boundary is
 * being asked. `released`: the final boundary has its answer and the mount is gone. `held`: the output is held back
 * for good.
 */
export type CompanyComputerCommandFolderStatus = "idle" | "none" | "running" | "ending" | "released" | "held";

interface Seams {
	readonly registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	readonly socket?: string;
	readonly ask: typeof askCompanyComputerFolderHelper;
	readonly run: typeof startCompanyComputerFolderRun;
	readonly log: (line: string) => void;
}

/**
 * Each shell command's mount of the company folder on a company machine (F3 4d, "A command's mount"): its own view
 * and mount, made before it runs; a boundary before its output reaches the run that started it; and, once no process
 * of it is left, the final boundary, asked again on its own until it has a final answer, then the mount goes.
 */
export class CompanyComputerCommandFolders {
	readonly #seams: Seams;

	constructor(options: {
		registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
		/** The helper's socket; the image's by default. */
		socket?: string;
		/** Test seams for the helper. */
		ask?: typeof askCompanyComputerFolderHelper;
		run?: typeof startCompanyComputerFolderRun;
		/** Where a final boundary that is asked again is logged; stderr by default. */
		log?: (line: string) => void;
	}) {
		this.#seams = {
			registry: options.registry,
			...(options.socket ? { socket: options.socket } : {}),
			ask: options.ask ?? askCompanyComputerFolderHelper,
			run: options.run ?? startCompanyComputerFolderRun,
			log: options.log ?? ((line) => console.error(line)),
		};
	}

	/** The folder of the command whose start's effect receipt (its shell command id) is `receipt`. */
	command(receipt: string): CompanyComputerCommandFolder {
		return new CompanyComputerCommandFolder(this.#seams, receipt);
	}
}

/** One command's view, mount and run. Every helper request but the run and the end check runs after the one before. */
export class CompanyComputerCommandFolder {
	readonly #seams: Seams;
	readonly #receipt: string;
	readonly #name: string;
	#status: CompanyComputerCommandFolderStatus = "idle";
	#view?: CompanyComputerFolderView;
	#run?: CompanyComputerFolderRun;
	#event: (event: CompanyComputerCommandFolderEvent) => void = () => undefined;
	/** The helper answered `started`. */
	#started = false;
	/** Whether the command's output or exit came. */
	#seen = false;
	/** No process of the command is left (`ended`), or the helper says so after it lost the run. */
	#ended = false;
	#lost = false;
	/** Why output is held back for good. */
	#held?: string;
	/** The paths the company folder did not take that no release showed yet: the first few, each cut short, their
	 * bytes, and how many more. */
	#notSaved: CompanyComputerCommandNotSaved[] = [];
	#notSavedBytes = 0;
	#moreNotSaved = 0;
	/** Why the final boundary is being asked again. */
	#retry?: string;
	/** Settles when the final boundary has its answer. */
	#done?: Promise<void>;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(seams: Seams, receipt: string) {
		this.#seams = seams;
		this.#receipt = receipt;
		this.#name = companyComputerFolderName("command", receipt);
	}

	get status(): CompanyComputerCommandFolderStatus {
		return this.#status;
	}

	#helper<Request extends Exclude<CompanyComputerFolderRequest, { op: "run" }>>(
		request: Request,
		timeoutMs?: number,
		signal?: AbortSignal,
	) {
		return this.#seams.ask(request, {
			...(this.#seams.socket ? { socket: this.#seams.socket } : {}),
			...(timeoutMs ? { timeoutMs } : {}),
			...(signal ? { signal } : {}),
		});
	}

	#queue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.#chain.then(work);
		this.#chain = result.catch(() => undefined);
		return result;
	}

	/**
	 * Make the command's view and mount, then run it with `/company` in the shell whose pid namespace's init is
	 * `shellPid`. `still` is asked just before it runs: a session stopped meanwhile runs nothing. Answers `ran` once the
	 * run request is sent (its events follow), or why nothing ran. Never rejects.
	 */
	async start(
		input: {
			environmentId: string;
			shellPid: number;
			network: boolean;
			command: string;
			still: () => boolean;
		},
		event: (event: CompanyComputerCommandFolderEvent) => void,
		signal: AbortSignal,
	): Promise<{ ran: true } | { note: string }> {
		if (this.#status !== "idle") return { note: START_FAILED };
		this.#event = event;
		let made = false;
		try {
			const view = await openCompanyComputerFolderView(
				this.#seams.registry,
				{
					environmentId: input.environmentId,
					kind: "computer_shell_command",
					anchor: { shellCommandId: this.#receipt },
				},
				signal,
				performance.now() + OPEN_WAIT_MS,
			);
			if (!("viewId" in view)) {
				this.#status = "none";
				return { note: `The command did not start (${view.message}); start it again.` };
			}
			this.#view = view;
			made = true;
			const mounted = (await this.#helper({ op: "mount", name: this.#name, view }, MOUNT_WAIT_MS, signal))?.answer;
			if (mounted !== "mounted") return this.#none(START_UNMOUNTED);
			if (signal.aborted || !input.still()) return this.#none(START_FAILED);
		} catch {
			return this.#none(START_FAILED, made);
		}
		this.#status = "running";
		const run = this.#seams.run(
			{
				op: "run",
				name: this.#name,
				shellPid: input.shellPid,
				network: input.network,
				command: input.command,
			},
			(happened) => this.#happened(happened),
			this.#seams.socket ? { socket: this.#seams.socket } : {},
		);
		this.#run = run;
		void run.closed.then(() => {
			// The connection went before the command's end was seen.
			if (this.#started && !this.#ended) this.#lose();
		});
		const answer = await run.answer;
		if (answer?.answer === "started") {
			this.#started = true;
			return { ran: true };
		}
		if (answer === undefined) {
			// Whether it started is unknown: the helper stops one that did, and says when it ended.
			this.#lose();
			return { note: START_LOST };
		}
		// Nothing ran.
		this.#run = undefined;
		return this.#none(START_FAILED);
	}

	/** Nothing ran: the mount, if asked for, goes, and the view closes. */
	#none(note: string, made = true): { note: string } {
		this.#status = "none";
		if (made) void this.#queue(() => this.#gone(true));
		return { note };
	}

	#happened(event: CompanyComputerFolderRunEvent): void {
		if (event.t === "ended") {
			this.#ending();
			return;
		}
		this.#seen = true;
		this.#event(event);
	}

	/** The helper went before the command's end was seen: its session hears so, and the helper is asked when no
	 * process of it is left. */
	#lose(): void {
		if (this.#lost || this.#ended) return;
		this.#lost = true;
		this.#event({ t: "lost" });
		void (async () => {
			for (let wait = ENDED_RETRY_MS; !this.#ended; wait = Math.min(wait * 2, RETRY_CAP_MS)) {
				const answer = (await this.#helper({ op: "ended", name: this.#name }))?.answer;
				if (answer === "ended") return this.#ending();
				if (answer === "unknown") {
					// Its command never started, so it ran nothing; unless the helper no longer has a mount that did.
					if (this.#status === "running") {
						if (this.#seen) this.#hold(HELD_GONE);
						else this.#status = "none";
					}
					await this.#queue(() => this.#gone(true));
					return;
				}
				await later(wait);
			}
		})().catch(() => undefined);
	}

	/** No process of the command is left: its final boundary is asked, or a mount held back for good goes. */
	#ending(): void {
		if (this.#ended) return;
		this.#ended = true;
		if (this.#status === "held") {
			void this.#queue(() => this.#gone(true));
			return;
		}
		if (this.#status !== "running") return;
		this.#status = "ending";
		this.#done = this.#queue(() => this.#final()).catch(() => undefined);
	}

	/** The shell's stop for the command, once its run request was sent. False before that. */
	stop(): boolean {
		if (!this.#run) return false;
		this.#run.stop();
		return true;
	}

	/** Bytes for the command's input. False before its run request was sent, or after it ended. */
	write(data: Uint8Array, end: boolean): boolean {
		if (!this.#run) return false;
		this.#run.write(data, end);
		return true;
	}

	/**
	 * The boundary before the command's output reaches the run that started it ("Before output reaches a model"): the
	 * command's reads are released, and its changes published, first. Output up to the session's mark, taken before
	 * this is asked, may reach the run when it answers `released`. The caller waits until `until` (performance.now());
	 * the work goes on after that.
	 */
	async release(signal: AbortSignal, until: number): Promise<CompanyComputerCommandRelease> {
		signal.throwIfAborted();
		switch (this.#status) {
			case "idle":
				return { released: true };
			case "none":
				return { released: true, final: true };
			case "released":
				return { released: true, final: true, ...this.#takeReport() };
			case "held":
				return { released: false, heldBack: this.#held ?? HELD_GONE, ...this.#takeReport() };
			case "ending": {
				const done = this.#done ?? Promise.resolve();
				const answer = await within(
					done.then(() => true),
					signal,
					until,
					false,
				);
				if (!answer) return { released: false, heldBack: this.#retry ?? HELD_SAVING, ...this.#takeReport() };
				return this.release(signal, until);
			}
			case "running": {
				const work = this.#queue(() =>
					this.#status === "running" ? this.#boundary(signal, until) : Promise.resolve(undefined),
				).catch(() => {
					signal.throwIfAborted();
					return { released: false, heldBack: HELD_UNANSWERED } as const;
				});
				const answer = await within(work, signal, until, { released: false, heldBack: HELD_UNANSWERED } as const);
				// The command ended while the boundary waited its turn: the final one answers.
				if (!answer) return this.release(signal, until);
				return { ...answer, ...this.#takeReport() };
			}
		}
	}

	async #boundary(signal: AbortSignal, until: number): Promise<CompanyComputerCommandRelease> {
		const timeoutMs = Math.min(COMPANY_COMPUTER_FOLDER_BOUNDARY_MS, Math.floor(until - performance.now()) - 1000);
		if (timeoutMs < 1000) return { released: false, heldBack: HELD_UNANSWERED };
		const answer = await this.#helper(
			{ op: "boundary", name: this.#name, final: false, timeoutMs },
			timeoutMs + 1000,
			signal,
		);
		if (answer && "report" in answer && answer.report) this.#note(answer.report, false);
		signal.throwIfAborted();
		// Saved, or refused only for some paths (refused or conflicting saves): the reads were released.
		if (answer?.answer === "saved" || (answer?.answer === "refused" && answer.report.refused === undefined))
			return { released: true };
		if (answer?.answer === "unknown") {
			this.#hold(HELD_GONE);
			this.#run?.stop();
			return { released: false, heldBack: HELD_GONE };
		}
		if (
			answer?.answer === "closed" ||
			(answer?.answer === "refused" &&
				(answer.report.refused === "unreadable" || answer.report.refused === "unproven"))
		) {
			// Rule 4's way out: the command stops, and once no process of it is left its mount goes without a boundary
			// and its view closes.
			this.#hold(HELD_STOPPED);
			this.#run?.stop();
			return { released: false, heldBack: HELD_STOPPED };
		}
		return { released: false, heldBack: heldBack(answer) };
	}

	/** The final boundary: asked again on its own until it has a final answer, then the mount goes and its view
	 * closes. A command held back for good gets none, even one a boundary held back while the command ended. */
	async #final(): Promise<void> {
		if (this.#status !== "ending") return this.#gone(true);
		for (let wait = FINAL_RETRY_MS; this.#status === "ending"; wait = Math.min(wait * 2, RETRY_CAP_MS)) {
			const answer = await this.#helper({
				op: "unmount",
				name: this.#name,
				final: true,
				timeoutMs: COMPANY_COMPUTER_FOLDER_BOUNDARY_MS,
			});
			// A refusal is final once the final closed the view, or the core refused it but for the run check or the
			// pause. Without a reason the core did not answer, or a change still waits: the view stays open, and the
			// final is asked again.
			if (
				!answer ||
				answer.answer === "invalid" ||
				answer.answer === "unanswered" ||
				(answer.answer === "refused" &&
					!answer.report.closed &&
					(answer.report.refused === undefined ||
						answer.report.refused === "run_ended" ||
						answer.report.refused === "stopped"))
			) {
				if (answer && "report" in answer && answer.report) this.#note(answer.report, false);
				this.#retry = heldBack(answer);
				this.#seams.log(`office-folder: command ${this.#name}: final boundary asked again (${word(answer)})`);
				await later(wait);
				continue;
			}
			if (answer.answer === "unknown") {
				this.#hold(HELD_GONE);
				break;
			}
			if (answer.answer === "saved" || (answer.answer === "refused" && answer.report.closed))
				this.#status = "released";
			else this.#hold(HELD_NOT_TAKEN);
			if ("report" in answer) this.#note(answer.report, true);
			if (!answer.unmounted) {
				await this.#gone(true);
				return;
			}
			break;
		}
		await this.#gone(false);
	}

	#hold(reason: string): void {
		this.#status = "held";
		this.#held = reason;
	}

	/** A boundary's paths not saved, for the next release: a final answer's every one, another's only those it settled
	 * (what it kept goes with a later boundary, whose report says how). */
	#note(report: CompanyComputerFolderReport, final: boolean): void {
		for (const entry of report.paths) {
			if (entry.outcome === "saved" || (entry.kept && !final)) continue;
			const item = {
				path: head(entry.path, 300),
				outcome: head(entry.outcome, 64),
				...(entry.reason ? { reason: head(entry.reason, 200) } : {}),
			};
			const bytes = Buffer.byteLength(JSON.stringify(item));
			if (
				this.#moreNotSaved === 0 &&
				this.#notSaved.length < NOT_SAVED_SHOWN &&
				this.#notSavedBytes + bytes <= NOT_SAVED_BYTES
			) {
				this.#notSaved.push(item);
				this.#notSavedBytes += bytes;
			} else this.#moreNotSaved++;
		}
	}

	/** The paths not saved that no release showed yet, which come once. */
	#takeReport(): Pick<CompanyComputerCommandRelease, "notSaved" | "moreNotSaved"> {
		const report = {
			...(this.#notSaved.length ? { notSaved: this.#notSaved } : {}),
			...(this.#moreNotSaved ? { moreNotSaved: this.#moreNotSaved } : {}),
		};
		this.#notSaved = [];
		this.#notSavedBytes = 0;
		this.#moreNotSaved = 0;
		return report;
	}

	/** The mount goes without a boundary, asked again until the helper takes it away; then the view closes. */
	async #gone(drop: boolean): Promise<void> {
		for (let wait = FINAL_RETRY_MS; drop; wait = Math.min(wait * 2, RETRY_CAP_MS)) {
			const answer = (await this.#helper({ op: "drop", name: this.#name }, DROP_WAIT_MS))?.answer;
			if (answer === "dropped" || answer === "unknown") break;
			await later(wait);
		}
		const view = this.#view;
		this.#view = undefined;
		if (view) await closeCompanyComputerFolderView(this.#seams.registry, view);
	}
}

/** Why an output read is held back by a boundary that answered neither `saved` nor rule 4's way out. */
function heldBack(answer: CompanyComputerFolderAnswer<"boundary" | "unmount"> | undefined): string {
	if (answer?.answer !== "refused") return HELD_UNANSWERED;
	// A final the core has not answered yet, or whose change still waits.
	if (answer.report.refused === undefined) return HELD_SAVING;
	if (answer.report.refused === "stopped") return HELD_PAUSED;
	if (answer.report.refused === "run_ended") return HELD_RUN_ENDED;
	return HELD_REFUSED;
}

/** The answer as the office logs it: a plain name, never the company's paths or reasons. */
function word(answer: CompanyComputerFolderAnswer<"unmount"> | undefined): string {
	if (!answer) return "no answer";
	const reason = answer.answer === "refused" ? answer.report.refused : undefined;
	return reason && /^[a-z_]{1,32}$/.test(reason) ? `${answer.answer} ${reason}` : answer.answer;
}

/** At most `length` characters, never half of one. */
function head(text: string, length: number): string {
	const characters = Array.from(text);
	return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}

/** A wait that never keeps the service alive. */
function later(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
