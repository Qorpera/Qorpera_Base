import { type CloudCodingRepository, isUuid, parseCloudCodingRepository, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import {
	CODE_BUNDLE_MAXIMUM_BYTES,
	CODE_BUNDLE_NAME,
	type CodeBundleManifest,
	type CodeBundleStore,
	type CodeBundleTarget,
	type CodeBundleWriter,
	codeBundleName,
} from "./code-bundle-store.ts";
import { type CodeHostJob, CodeHostJobFailure, CodeHostRefusal, codeRefsSha256 } from "./code-host-jobs.ts";
import {
	CODE_RESTORE_RPCS,
	type CodeAreaClosed,
	type CodeAreaOpened,
	type CodeAreaOpening,
	type CodeAreaSetAside,
	type CodeRestoreBundle,
	type CodeRestoringMark,
	closeCodeArea,
	openCodeArea,
	readCodeAreaMark,
	reopenCodeArea,
	restoreCodeArea,
	setAsideCodeArea,
} from "./code-host-restore.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import {
	CODE_IMPORT_FAILED_CODE,
	CODE_IMPORT_FAILURES,
	CODE_IMPORT_FILE_MAXIMUM_BYTES,
	CODE_IMPORT_REFUSED_CODE,
	CODE_IMPORT_RENEW_MS,
	CODE_IMPORT_RPCS,
	type CodeImportBundleStore,
	type CodeImportBundleWriter,
	type CodeImportFetch,
	type CodeImportFetched,
	type CodeImportInput,
	type CodeImportJobs,
	type CodeImportKept,
	type CodeImportLook,
	type CodeImportOutcome,
	type CodeImportRaw,
	type CodeImportRequest,
	type CodeImportStep,
	CodeImportStop,
	type CodeImportTransports,
	codeImportBranchValid,
	codeImportBundleName,
	codeImportGitHubOf,
	codeImportLookedAnswer,
	codeImportLookOf,
	codeImportOutcomeOf,
	codeImportProgressValue,
	codeImportRecord,
	codeImportRecordedAnswer,
	codeImportRelayRefusals,
	codeImportStopOf,
} from "./code-import.ts";
import { CodingControlBusy } from "./coding-executor.ts";

/** One import (own code storage, step 6, part C3): the coding executor's side of a code request of kind `import`, from
 * its claim to its outcome, going on from whatever the request's progress already holds. A request may be cut at any
 * line and claimed again (five runs): every step is safe to do again, and none that the kernel saved is done twice.
 *
 *   fetch / read  the first bundle, into an import writer of the store: from GitHub by part C2's fetch, through the
 *                 company's connection (the secret broker's relay) or straight for a public project, or from a file
 *                 under `code/_incoming/` by part B's read job. Then the writer is committed and `raw` written into
 *                 the progress, where the kernel keeps it. Step `fetch` is saved before the first relay call: the
 *                 broker's authority answers only while the progress names it and has no `raw` (S8).
 *   look          part B's look job on that bundle, which keeps its place in the company's line. The kernel answers
 *                 the step that first names `look` with `busy` while the company is not quiet: it has then put the
 *                 import back in the queue itself, and the run ends `busy` with nothing more written. The job's
 *                 restore-shaped bundle is committed as an ordinary bundle and written into the progress (`kept`);
 *                 only then is the look recorded (`qorpera_code_import_looked`). A look alone ends `done/looked`.
 *   close …       restore's own jobs (`code-host-restore.ts`) on the restore-shaped bundle, proven by the look
 *                 (`proven: true`): close (`fresh: false`), set aside until a job sees the place emptied, build, and
 *                 open, whose record (`qorpera_code_import_record`, the registry row and change 1) is made inside its
 *                 job, before the mark goes. Then `tidy` removes a file source's folder.
 *
 * How it ends, by where it got (the design's 5.3, as the lead's second check corrected it):
 * - The kernel took the request back (`busy` at the look, `lost` at any call) or was not heard, a job gave way, the
 *   executor is stopping, or a stop that says so (a cut transfer, the relay's busy): `busy`, and nothing more is done
 *   for the request. The next claim goes on from what the kernel saved and the place holds.
 * - A refusal or a failure before close: the place is untouched, and this import's store bundles are removed (never the
 *   one a mark at the place names).
 * - After close, before the set-aside job was let go: the place is opened again (`reopenCodeArea`), and the request
 *   fails `<code>:PLACE_AS_BEFORE` with its bundles removed; when it could not be opened, `<code>:PLACE_CLOSED`, with
 *   its bundles kept for the mark.
 * - After the set-aside job was let go, and after the record: only `busy` (or `done/imported` once it is all in). The
 *   next claim goes on from the mark; once the kernel has the record, a claim past the limit ends it done.
 *
 * Before a bundle is made, the place's mark is read: a mark of an earlier import that did not finish names a
 * restore-shaped bundle the place may be half built from. That bundle stays in the store, and the import goes on from it
 * as its own (the look then runs alone, for its facts). Every other bundle of the place's store folder is removed then:
 * a place with no registry row keeps none. After a done import the first bundle stays with the repository, and the
 * restore-shaped one is an ordinary bundle of the store.
 *
 * The lease is renewed every five minutes, by a step call that names the step the kernel last took. A lease found gone
 * (`lost`) stops the run at once. No outcome, progress, log line or error of the run carries a byte of the source, a
 * path from it or a key: codes, counts, and the names C1 checked. */

/** The run's step calls, the look's, the record's: `qorpera_code_request_step` with the import's two. */
export const CODE_IMPORT_RUN_RPCS = [CODE_RESTORE_RPCS[0], ...CODE_IMPORT_RPCS] as const;

/** Restore's jobs as the run calls them on the restore-shaped bundle (`code-host-restore.ts`): `CODE_IMPORT_RESTORE_JOBS`
 * by default. `proven` (part B) skips only the fsck the look already ran. */
export interface CodeImportRestoreJobs {
	mark(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository },
	): Promise<{ there: boolean; mark: CodeRestoringMark | null }>;
	close(
		job: CodeHostJob,
		value: {
			repository: CloudCodingRepository;
			requestId: string;
			bundle: CodeRestoreBundle;
			at: string;
			fresh: boolean;
		},
		source: AsyncIterable<Uint8Array>,
		options: { fsckMs?: number; proven?: boolean },
	): Promise<CodeAreaClosed>;
	setAside(job: CodeHostJob, value: { repository: CloudCodingRepository; bundle: string }): Promise<CodeAreaSetAside>;
	build(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository; bundle: CodeRestoreBundle },
		source: AsyncIterable<Uint8Array>,
		options: { fsckMs?: number; proven?: boolean },
	): Promise<{ mainSha: string; refsSha256: string; refs: number }>;
	open(
		job: CodeHostJob,
		value: {
			repository: CloudCodingRepository;
			bundle: CodeRestoreBundle;
			sessions: readonly { workerId: string; baseSha: string }[];
		},
		record: (place: CodeAreaOpening) => Promise<void>,
	): Promise<CodeAreaOpened>;
	reopen(job: CodeHostJob, value: { repository: CloudCodingRepository; bundle: string }): Promise<{ state: string }>;
}
export const CODE_IMPORT_RESTORE_JOBS: CodeImportRestoreJobs = Object.freeze({
	mark: readCodeAreaMark,
	close: closeCodeArea,
	setAside: setAsideCodeArea,
	build: restoreCodeArea,
	open: openCodeArea,
	reopen: reopenCodeArea,
});

export interface CodeImportOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	/** The store nightly care writes to: the restore-shaped bundle is one of its ordinary bundles. */
	bundles: Pick<CodeBundleStore, "begin" | "read" | "find">;
	/** The same store's import side (part C2): the first bundle, and the names and the removal of both kinds. */
	imports: CodeImportBundleStore;
	/** The fetch's two ways to GitHub (part C2, `deploy/coding-worker/repository-fetch.ts`). */
	transports: CodeImportTransports;
	/** Part C2's `fetchGitHubImport`. */
	fetch: CodeImportFetch;
	/** Part B's jobs (`code-host-import.ts`). */
	jobs: CodeImportJobs;
	/** Restore's jobs; `CODE_IMPORT_RESTORE_JOBS` when left out. */
	restoreJobs?: CodeImportRestoreJobs;
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-import` and `code-import-error` (with a code, never the error itself: a code host's error may
	 * name paths of the source). */
	report?: (event: Record<string, unknown>) => void;
	now?: () => number;
	/** How long a proof's fsck may take; the jobs' own bound when left out. */
	fsckMs?: number;
	/** How the lease's renewal waits: `fire` after `ms`, and a cancel. `setTimeout` when left out. */
	timer?: (ms: number, fire: () => void) => () => void;
}

const OUTCOME = "qorpera.code-request-outcome/v1";
const CALL_MS = 10_000;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
/** Steps from which the set-aside job was let go, as a claim's progress names them. */
const LET_GO: ReadonlySet<CodeImportStep> = new Set(["set-aside", "build", "open", "tidy"]);

/** The kernel took the request back (`busy`, `lost`), or a call of it was not heard (`unheard`): nothing more is done
 * for the request in this run. */
class ImportStopped extends Error {
	readonly stop: "busy" | "lost" | "unheard";
	constructor(stop: "busy" | "lost" | "unheard") {
		super(`CODE_IMPORT_STOPPED:${stop}`);
		this.stop = stop;
	}
}

interface ImportRun {
	request: CodeImportRequest;
	input: CodeImportInput;
	/** The place, a repository kept in Qorpera. */
	repository: CloudCodingRepository;
	target: CodeBundleTarget;
	named: Record<string, unknown>;
	/** The executor's signal and the run's own: a lease found gone ends both the fetch and the job under way. */
	signal: AbortSignal;
	halt: AbortController;
	/** The executor's own keys of the progress, as the next step call sends them. */
	progress: {
		raw?: CodeImportRaw;
		kept?: CodeImportKept;
		at?: string;
		setAside?: string | null;
		built?: true;
		relayRefused?: number;
	};
	/** The step under way, and the last one the kernel took (the row's): a renewal names that one, so it never is the
	 * first to name the look. */
	step: CodeImportStep;
	confirmed: CodeImportStep | undefined;
	/** The kernel has the record: from the claim, or made by this run. */
	recorded: boolean;
	looked: CodeImportLook | null;
	/** `open`: this run has not begun to close the place. `closed`: it began to, and the set-aside job was not let go.
	 * `aside`: the set-aside job was let go (in this claim or an earlier one); the place opens only once it is built. */
	stage: "open" | "closed" | "aside";
	/** The bundle a mark at the place names, as this claim read it (null: no mark); undefined until it is read. */
	mark?: string | null;
	/** The kernel took the request back, or the run ended: nothing more is asked. */
	ended?: "busy" | "lost";
	finished: boolean;
	/** Every call of the kernel's, one after another. */
	calls: Promise<unknown>;
	cancel?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An error's fixed code: the code host's own, or a message that is one. */
function codeOf(error: unknown): string {
	if ((error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal) && FIXED.test(error.code))
		return error.code;
	if (error instanceof CodeImportStop) return error.code;
	return error instanceof Error && FIXED.test(error.message) ? error.message : "UNCLASSIFIED";
}

const keptFacts = (kept: CodeImportKept): CodeRestoreBundle => ({
	name: kept.name,
	sha256: kept.sha256,
	bytes: kept.bytes,
	refsSha256: kept.refsSha256,
	mainSha: kept.mainSha,
});

/** A stored bundle's time, from its name (`YYYYMMDDTHHMMSSZ-…`), in milliseconds. */
function timeOf(name: string): number {
	const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name) ?? [];
	const time = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
	if (!Number.isFinite(time)) throw new Error("INVALID_CODE_IMPORT_PROGRESS");
	return time;
}

export class CodeImport {
	readonly #control: CodeImportOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #bundles: Pick<CodeBundleStore, "begin" | "read" | "find">;
	readonly #imports: CodeImportBundleStore;
	readonly #transports: CodeImportTransports;
	readonly #fetch: CodeImportFetch;
	readonly #jobs: CodeImportJobs;
	readonly #restore: CodeImportRestoreJobs;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #now: () => number;
	readonly #fsck: { fsckMs?: number };
	readonly #timer: (ms: number, fire: () => void) => () => void;

	constructor(options: CodeImportOptions) {
		const restore = options.restoreJobs ?? CODE_IMPORT_RESTORE_JOBS;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!SHA256_HEX_PATTERN.test(options.machineIdSha256) ||
			typeof options.control?.call !== "function" ||
			typeof options.hosts?.run !== "function" ||
			typeof options.fetch !== "function" ||
			typeof options.transports?.connection !== "function" ||
			typeof options.transports?.public !== "function" ||
			!["read", "look", "remove"].every(
				(name) => typeof (options.jobs as unknown as Record<string, unknown>)?.[name] === "function",
			) ||
			!["mark", "close", "setAside", "build", "open", "reopen"].every(
				(name) => typeof (restore as unknown as Record<string, unknown>)[name] === "function",
			) ||
			(options.fsckMs !== undefined && (!Number.isSafeInteger(options.fsckMs) || options.fsckMs < 1))
		)
			throw new Error("INVALID_CODE_IMPORT");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#bundles = options.bundles;
		this.#imports = options.imports;
		this.#transports = options.transports;
		this.#fetch = options.fetch;
		this.#jobs = options.jobs;
		this.#restore = restore;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#now = options.now ?? Date.now;
		this.#fsck = options.fsckMs === undefined ? {} : { fsckMs: options.fsckMs };
		this.#timer =
			options.timer ??
			((ms, fire) => {
				const timer = setTimeout(fire, ms);
				return () => clearTimeout(timer);
			});
	}

	/** One import to its outcome, as `qorpera_code_request_finish` takes it. It never throws. */
	async run(request: CodeImportRequest, signal: AbortSignal): Promise<CodeImportOutcome> {
		const started = this.#now();
		let outcome: CodeImportOutcome, run: ImportRun | undefined;
		try {
			run = this.#runOf(request, signal);
			outcome = await this.#import(run);
		} catch (error) {
			if (run) outcome = await this.#ended(run, error);
			else {
				outcome = { schema: OUTCOME, state: "failed", code: "IMPORT_REQUEST_INVALID" };
				this.#report({
					event: "code-import-error",
					step: "request",
					requestId: request?.requestId,
					code: codeOf(error),
				});
			}
		}
		if (run) {
			// Nothing of this run's is asked after its outcome: the renewal stops, and a call under way is waited for.
			run.finished = true;
			run.cancel?.();
			await run.calls;
		}
		this.#report({
			event: "code-import",
			step: "ended",
			...(run?.named ?? { requestId: request?.requestId }),
			state: outcome.state,
			...("result" in outcome ? { result: outcome.result } : {}),
			...("code" in outcome ? { code: outcome.code } : {}),
			ms: this.#now() - started,
		});
		return outcome;
	}

	/** The claimed import, as the run takes it (part Q parsed it with `codeImportRequestOf`). */
	#runOf(request: CodeImportRequest, signal: AbortSignal): ImportRun {
		if (!isRecord(request)) throw new Error("IMPORT_REQUEST_INVALID");
		const { requestId, token, companyId, environmentId, input, progress } = request;
		if (
			![requestId, token, companyId, environmentId].every((id) => isUuid(id)) ||
			request.kind !== "import" ||
			!isRecord(input as unknown) ||
			!isRecord(progress as unknown) ||
			!isRecord(input.from as unknown) ||
			!(input.via === "file" ? "file" in input.from : "github" in input.from)
		)
			throw new Error("IMPORT_REQUEST_INVALID");
		let repository: CloudCodingRepository;
		try {
			repository = parseCloudCodingRepository({
				host: "qorpera",
				owner: request.owner,
				name: request.name,
				baseBranch: "main",
			});
		} catch {
			throw new Error("IMPORT_REQUEST_INVALID");
		}
		const halt = new AbortController();
		const own: ImportRun["progress"] = {};
		for (const key of ["raw", "kept", "at", "setAside", "built", "relayRefused"] as const)
			if (progress[key] !== undefined) (own as Record<string, unknown>)[key] = progress[key];
		const step = progress.step;
		return {
			request,
			input,
			repository,
			target: { companyId, owner: repository.owner, name: repository.name },
			named: {
				requestId,
				companyId,
				environmentId,
				repository: `${repository.owner}/${repository.name}`,
				via: input.via,
			},
			signal: AbortSignal.any([signal, halt.signal]),
			halt,
			progress: own,
			step: step ?? (input.via === "file" ? "read" : "fetch"),
			confirmed: step,
			recorded: progress.recorded !== undefined,
			looked: request.looked,
			stage:
				progress.recorded !== undefined ||
				progress.built === true ||
				progress.setAside !== undefined ||
				(step !== undefined && LET_GO.has(step))
					? "aside"
					: "open",
			finished: false,
			calls: Promise.resolve(),
		};
	}

	async #import(run: ImportRun): Promise<CodeImportOutcome> {
		const { input, progress } = run;
		// A first claim names its first step before anything else (before the relay's first call: S8).
		if (run.confirmed === undefined) await this.#step(run, run.step, run.signal);
		else this.#renew(run);
		if (progress.raw === undefined) {
			// The store folder of a place with no registry row keeps nothing but what a mark there names.
			run.step = input.via === "file" ? "read" : "fetch";
			await this.#markOf(run);
			await this.#tidyStore(run);
			progress.raw = input.via === "file" ? await this.#read(run) : await this.#fetched(run);
			delete progress.relayRefused;
			await this.#step(run, run.step, run.signal);
			this.#report({
				event: "code-import",
				step: "raw",
				...run.named,
				bytes: progress.raw.bytes,
				refs: progress.raw.refs,
			});
		}
		if (run.looked === null) await this.#looking(run);
		const look = run.looked as CodeImportLook;
		if (input.look) {
			await this.#removeBundles(run, false);
			return { schema: OUTCOME, state: "done", result: "looked" };
		}
		if (!look.fits) {
			const why = look.why ?? "IMPORT_LOOK_ANSWER_INVALID";
			throw new CodeImportStop(
				!(CODE_IMPORT_FAILURES as readonly string[]).includes(why) && CODE_IMPORT_REFUSED_CODE.test(why)
					? "refused"
					: "failed",
				why,
			);
		}
		const kept = progress.kept;
		if (kept === undefined) throw new Error("IMPORT_PROGRESS_INVALID");
		if (progress.built !== true && progress.setAside === undefined) {
			// A claim whose set-aside job was let go goes on with it: that job reads the mark itself.
			let shut: CodeAreaClosed | undefined;
			if (run.stage === "open") {
				run.step = "close";
				shut = await this.#job(
					run,
					async (job) => {
						const stored = await this.#stored(run, kept, job.signal);
						run.stage = "closed";
						return await this.#restore.close(
							job,
							{
								repository: run.repository,
								requestId: run.request.requestId,
								bundle: stored.bundle,
								at: `${new Date(this.#now()).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`,
								fresh: false,
							},
							stored.pieces,
							{ ...this.#fsck, proven: true },
						);
					},
					false,
				);
				progress.at = shut.at;
				this.#report({ event: "code-import", step: "closed", ...run.named, state: shut.state, mark: shut.step });
			}
			if (shut?.step === "emptied") {
				run.stage = "aside";
				progress.setAside = shut.setAside;
			} else {
				run.step = "set-aside";
				// The job that moves, and then one that sees what the folder kept of the move.
				for (let moves = 0; ; ) {
					const aside = await this.#job(
						run,
						(job) => this.#restore.setAside(job, { repository: run.repository, bundle: kept.name }),
						false,
					);
					if (aside.state !== "moved") {
						progress.setAside = aside.movedTo;
						break;
					}
					moves += 1;
					if (moves > 1) throw new Error("RESTORE_SET_ASIDE_NOT_KEPT");
				}
			}
			this.#report({ event: "code-import", step: "set-aside", ...run.named, aside: progress.setAside !== null });
		}
		if (progress.built !== true) {
			run.step = "build";
			const built = await this.#job(
				run,
				async (job) => {
					const stored = await this.#stored(run, kept, job.signal);
					return await this.#restore.build(
						job,
						{ repository: run.repository, bundle: stored.bundle },
						stored.pieces,
						{
							...this.#fsck,
							proven: true,
						},
					);
				},
				false,
			);
			if (built?.mainSha !== kept.mainSha || built.refsSha256 !== kept.refsSha256)
				throw new Error("IMPORT_BUILD_ANSWER_INVALID");
			progress.built = true;
			this.#report({ event: "code-import", step: "built", ...run.named, refs: built.refs });
		}
		// The open: the record inside its job, while the place is still closed; never twice.
		run.step = "open";
		const opened = await this.#job(
			run,
			(job) =>
				this.#restore.open(
					job,
					{ repository: run.repository, bundle: keptFacts(kept), sessions: [] },
					async (place) => {
						if (!run.recorded) await this.#record(run, kept, look, place, job.signal);
					},
				),
			false,
		);
		this.#report({ event: "code-import", step: "opened", ...run.named, state: opened.state });
		if (input.via === "file" && "file" in input.from) {
			// The file is in the repository now. A file that could not be removed is left: the import is in.
			run.step = "tidy";
			const path = input.from.file;
			try {
				const tidied = await this.#job(
					run,
					(job) => this.#jobs.remove(job, { repository: run.repository, path }),
					false,
				);
				this.#report({ event: "code-import", step: "tidied", ...run.named, removed: tidied?.removed === true });
			} catch (error) {
				if (error instanceof ImportStopped) throw error;
				this.#report({ event: "code-import-error", step: "tidy", ...run.named, code: codeOf(error) });
			}
		}
		const raw = progress.raw as CodeImportRaw;
		return codeImportOutcomeOf({
			schema: OUTCOME,
			state: "done",
			result: "imported",
			change: 1,
			mainSha: kept.mainSha,
			bundle: kept.name,
			rawBundle: raw.name,
			setAside: progress.setAside ?? null,
		});
	}

	/** The look: part B's job on the first bundle, and the look recorded. The restore-shaped bundle is in the store and
	 * in the progress before the look is recorded, so a claim that comes with the look never looks again. One that
	 * comes with the bundle and no look runs the job alone, at the bundle's own time, for the look; so does an import
	 * that goes on from a mark's bundle, and a look alone. */
	async #looking(run: ImportRun): Promise<void> {
		const { input, progress } = run;
		run.step = "look";
		let look: CodeImportLook;
		if (input.look) look = (await this.#look(run, true, Math.floor(this.#now() / 1000) * 1000)).look;
		else if (progress.kept) look = (await this.#look(run, true, timeOf(progress.kept.name))).look;
		else {
			const goOn = await this.#goOn(run);
			if (goOn) {
				look = (await this.#look(run, true, timeOf(goOn.name))).look;
				if (look.fits) progress.kept = goOn;
			} else {
				await this.#tidyStore(run);
				const looked = await this.#look(run, false, Math.floor(this.#now() / 1000) * 1000);
				look = looked.look;
				if (looked.kept) progress.kept = looked.kept;
			}
			if (progress.kept) await this.#step(run, run.step, run.signal);
		}
		await this.#looked(run, look);
		run.looked = look;
		this.#report({ event: "code-import", step: "looked", ...run.named, fits: look.fits, why: look.why });
	}

	/** Part B's look job, in the company's line without giving way (its step is where the kernel waits for quiet).
	 * `alone`: the facts only; otherwise the restore-shaped bundle too, committed as an ordinary bundle named at `now`. */
	async #look(run: ImportRun, alone: boolean, now: number): Promise<{ look: CodeImportLook; kept?: CodeImportKept }> {
		const raw = run.progress.raw as CodeImportRaw;
		let writer: CodeBundleWriter | undefined;
		try {
			if (!alone)
				writer = await this.#bundles.begin(
					run.target,
					{ expectedBytes: raw.bytes, maximumBytes: CODE_BUNDLE_MAXIMUM_BYTES },
					run.signal,
				);
			const made = writer;
			const answer = await this.#source(run, () =>
				this.#job(
					run,
					async (job) => {
						const { pieces } = await this.#imports.readImport(run.target, raw.name, job.signal);
						return await this.#jobs.look(
							job,
							{ repository: run.repository, raw, look: alone, now },
							pieces,
							{
								write: (chunk) =>
									made
										? made.write(chunk, job.signal)
										: Promise.reject(new Error("IMPORT_LOOK_ANSWER_INVALID")),
							},
							this.#fsck,
						);
					},
					false,
				),
			);
			let look: CodeImportLook;
			try {
				look = codeImportLookOf(answer?.look);
			} catch {
				throw new Error("IMPORT_LOOK_ANSWER_INVALID");
			}
			if (look.mainSha !== raw.mainSha) throw new Error("IMPORT_LOOK_ANSWER_INVALID");
			if (answer.state === "looked" && (alone || !look.fits)) return { look };
			if (answer.state !== "kept" || alone || !look.fits || !made) throw new Error("IMPORT_LOOK_ANSWER_INVALID");
			const { bundle } = answer;
			if (
				!isRecord(bundle) ||
				bundle.mainSha !== raw.mainSha ||
				!Array.isArray(bundle.refs) ||
				codeRefsSha256(bundle.refs) !== bundle.refsSha256
			)
				throw new Error("IMPORT_LOOK_ANSWER_INVALID");
			const createdAt = new Date(now).toISOString(),
				name = codeBundleName(createdAt, bundle.mainSha);
			await made.commit(
				name,
				{
					environmentId: run.request.environmentId,
					createdAt,
					gitVersion: bundle.gitVersion,
					mainSha: bundle.mainSha,
					refsSha256: bundle.refsSha256,
					refs: bundle.refs.map(({ name, sha }) => ({ name, sha })),
					sha256: bundle.sha256,
					bytes: bundle.bytes,
					executorOwner: this.#owner,
				},
				run.signal,
			);
			writer = undefined;
			return {
				look,
				kept: {
					name,
					sha256: bundle.sha256,
					bytes: bundle.bytes,
					refsSha256: bundle.refsSha256,
					mainSha: bundle.mainSha,
					refs: bundle.refs.length,
				},
			};
		} finally {
			await writer?.abort().catch((error: unknown) => this.#failed(run, "look", error));
		}
	}

	/** The look recorded (`qorpera_code_import_looked`): written once; the same again is the kernel's to take. */
	async #looked(run: ImportRun, look: CodeImportLook): Promise<void> {
		const state = await this.#call(
			run,
			run.signal,
			CODE_IMPORT_RPCS[0],
			() => ({ p_look: look }),
			(answer) => this.#lostIf(run, codeImportLookedAnswer(answer)),
		);
		if (state === "lost") throw this.#end(run, "lost");
	}

	/** The import written into the change record (`qorpera_code_import_record`), from inside the job that opens the
	 * place, before its mark goes: the registry row and change 1. A kernel that was not heard is asked once more (made
	 * again, the record answers what it recorded); still not heard, the run ends put off with the place closed, and the
	 * next claim's open records. */
	async #record(
		run: ImportRun,
		kept: CodeImportKept,
		look: CodeImportLook,
		place: CodeAreaOpening,
		signal: AbortSignal,
	): Promise<void> {
		const imported = codeImportRecord({ bundle: kept.name, mainSha: place.mainSha, files: look.files });
		for (let tried = 0; ; tried += 1) {
			try {
				const answer = await this.#call(
					run,
					signal,
					CODE_IMPORT_RPCS[1],
					() => ({ p_imported: imported }),
					(value) => {
						const recorded = codeImportRecordedAnswer(value);
						this.#lostIf(run, recorded.state);
						return recorded;
					},
				);
				if (answer.state === "lost") throw this.#end(run, "lost");
				run.recorded = true;
				this.#report({ event: "code-import", step: "recorded", ...run.named, change: answer.change });
				return;
			} catch (error) {
				if (!(error instanceof ImportStopped) || error.stop !== "unheard" || tried > 0) throw error;
			}
		}
	}

	/** GitHub's bytes into the first bundle, by the transport the input names. The relay's own 403 is counted in the
	 * progress (`relayRefused`): busy twice, refused the third time in a row; any other end starts the count again. */
	async #fetched(run: ImportRun): Promise<CodeImportRaw> {
		const { input, request, progress } = run;
		const from = input.from as { github: string; branch?: string };
		const github = codeImportGitHubOf(from.github);
		const transport =
			input.via === "connection"
				? this.#transports.connection(
						{ companyId: request.companyId, requestId: request.requestId, leaseToken: request.token },
						github,
					)
				: this.#transports.public(github);
		const before = progress.relayRefused ?? 0;
		try {
			return await this.#first(run, input.maximumBytes, (writer) =>
				this.#fetch(
					{
						transport,
						repository: github,
						branch: from.branch ?? null,
						maximumBytes: input.maximumBytes,
						signal: run.signal,
					},
					writer,
				),
			);
		} catch (error) {
			if (error instanceof ImportStopped) throw error;
			const { relayRefused, stop } = codeImportRelayRefusals(before, codeImportStopOf(error, run.signal));
			const ended = stop as CodeImportStop;
			if (relayRefused) progress.relayRefused = relayRefused;
			else delete progress.relayRefused;
			// The count is the next claim's: saved when the request is put off.
			if (ended.end === "busy" && relayRefused !== before && !run.signal.aborted)
				await this.#step(run, run.step, run.signal).catch((failure: unknown) =>
					this.#failed(run, "fetch", failure),
				);
			throw ended;
		}
	}

	/** A file source into the first bundle, by part B's read job (a job that gives way to a turn's). */
	async #read(run: ImportRun): Promise<CodeImportRaw> {
		const { input } = run;
		const from = input.from as { file: string; branch?: string };
		const maximumBytes = Math.min(input.maximumBytes, CODE_IMPORT_FILE_MAXIMUM_BYTES);
		return await this.#first(run, maximumBytes, (writer) =>
			this.#job(
				run,
				(job) =>
					this.#jobs.read(
						job,
						{
							repository: run.repository,
							path: from.file,
							sha256: input.fileSha256 as string,
							branch: from.branch ?? null,
							maximumBytes,
						},
						{ write: (chunk) => writer.write(chunk, job.signal) },
					),
				true,
			),
		);
	}

	/** An import writer of the store, filled by `fill` and committed as `import-<UTC>-<12 hex>`; aborted on every other
	 * end, the executor stopping among them. */
	async #first(
		run: ImportRun,
		maximumBytes: number,
		fill: (writer: CodeImportBundleWriter) => Promise<CodeImportFetched>,
	): Promise<CodeImportRaw> {
		const { input } = run;
		let writer: CodeImportBundleWriter | undefined = await this.#imports.begin(
			run.target,
			{ kind: "import", expectedBytes: maximumBytes, maximumBytes },
			run.signal,
		);
		try {
			const filled = writer;
			const fetched = await this.#source(run, () => fill(filled));
			if (!isRecord(fetched)) throw new Error("IMPORT_FETCH_ANSWER_INVALID");
			// A default branch that is no name the import keeps is never written anywhere.
			if (typeof fetched.defaultBranch !== "string" || !codeImportBranchValid(fetched.defaultBranch))
				throw new CodeImportStop("refused", "IMPORT_BRANCH_NAME");
			if (
				typeof fetched.sha256 !== "string" ||
				!SHA256_HEX_PATTERN.test(fetched.sha256) ||
				!Number.isSafeInteger(fetched.bytes) ||
				fetched.bytes < 1 ||
				fetched.bytes > maximumBytes ||
				typeof fetched.mainSha !== "string" ||
				!/^[0-9a-f]{40}$/.test(fetched.mainSha) ||
				!Array.isArray(fetched.refs) ||
				fetched.refs.length < 1 ||
				!Number.isSafeInteger(fetched.leftOut) ||
				fetched.leftOut < 0
			)
				throw new Error("IMPORT_FETCH_ANSWER_INVALID");
			const createdAt = new Date(this.#now()).toISOString(),
				name = codeImportBundleName(createdAt, fetched.mainSha);
			await filled.commit(
				name,
				{
					environmentId: run.request.environmentId,
					createdAt,
					from: input.from,
					defaultBranch: fetched.defaultBranch,
					mainSha: fetched.mainSha,
					refs: fetched.refs.map(({ name, sha }) => ({ name, sha })),
					leftOut: fetched.leftOut,
					sha256: fetched.sha256,
					bytes: fetched.bytes,
					executorOwner: this.#owner,
				},
				run.signal,
			);
			writer = undefined;
			return {
				name,
				sha256: fetched.sha256,
				bytes: fetched.bytes,
				defaultBranch: fetched.defaultBranch,
				mainSha: fetched.mainSha,
				refs: fetched.refs.length,
				leftOut: fetched.leftOut,
			};
		} finally {
			await writer?.abort().catch((error: unknown) => this.#failed(run, run.step, error));
		}
	}

	/** Part B's and C2's work, whose errors are the import's stops (`codeImportStopOf`); the kernel's own stay as they
	 * are. */
	async #source<T>(run: ImportRun, work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			throw error instanceof ImportStopped ? error : codeImportStopOf(error, run.signal);
		}
	}

	/** The place's mark, read by a job of its own that writes nothing and asks the kernel nothing: the bundle it names
	 * (null without one). Before the look the job gives way to a turn's. */
	async #markOf(run: ImportRun): Promise<string | null> {
		if (run.ended) throw new ImportStopped(run.ended);
		const { mark } = await this.#hosts.run(
			run.request.companyId,
			run.request.environmentId,
			run.signal,
			(job) => this.#restore.mark(job, { repository: run.repository }),
			{ yields: run.looked === null },
		);
		run.mark = mark?.bundle ?? null;
		if (mark) this.#report({ event: "code-import", step: "mark", ...run.named, mark: mark.step });
		return run.mark;
	}

	/** The bundle a mark at the place names, when the store still has it: an earlier import closed the place for it
	 * and did not finish, and the place may be half built from it. The import goes on from it as its own. */
	async #goOn(run: ImportRun): Promise<CodeImportKept | null> {
		const name = run.mark === undefined ? await this.#markOf(run) : run.mark;
		if (!name || !CODE_BUNDLE_NAME.test(name)) return null;
		const manifest: CodeBundleManifest | null = await this.#bundles.find(run.target, name, run.signal);
		if (!manifest) return null;
		this.#report({ event: "code-import", step: "go-on", ...run.named });
		return {
			name,
			sha256: manifest.sha256,
			bytes: manifest.bytes,
			refsSha256: manifest.refsSha256,
			mainSha: manifest.mainSha,
			refs: manifest.refsCount,
		};
	}

	/** Every bundle of the place's store folder but this import's own and the one a mark at the place names (read in
	 * this claim): what a cut run, a failed import or a repository that was there before left. */
	async #tidyStore(run: ImportRun): Promise<void> {
		const keep = new Set([run.progress.raw?.name, run.progress.kept?.name, run.mark]);
		try {
			for (const name of await this.#imports.names(run.target, run.signal))
				if (!keep.has(name)) {
					await this.#imports.remove(run.target, name, run.signal);
					this.#report({ event: "code-import", step: "store", ...run.named, removed: name });
				}
		} catch (error) {
			if (run.signal.aborted) throw error;
			this.#failed(run, "store", error);
		}
	}

	/** This import's bundles, removed from the store as it ends refused or failed. Never the one a mark at the place
	 * names: unless the place was just opened again, it is read first, and a place that cannot be read keeps it. */
	async #removeBundles(run: ImportRun, reopened: boolean): Promise<void> {
		const { raw, kept } = run.progress;
		let keep: string | null = null;
		if (kept && !reopened)
			try {
				keep = run.mark === undefined ? await this.#markOf(run) : run.mark;
			} catch (error) {
				this.#failed(run, "mark", error);
				keep = kept.name;
			}
		for (const name of [raw?.name, kept?.name])
			if (name !== undefined && name !== keep)
				try {
					await this.#imports.remove(run.target, name, run.signal);
				} catch (error) {
					this.#failed(run, "store", error);
				}
	}

	/** The restore-shaped bundle's bytes, from the store, as the progress names them. */
	async #stored(run: ImportRun, kept: CodeImportKept, signal: AbortSignal) {
		const { manifest, pieces } = await this.#bundles.read(run.target, kept.name, signal);
		if (
			manifest.sha256 !== kept.sha256 ||
			manifest.bytes !== kept.bytes ||
			manifest.refsSha256 !== kept.refsSha256 ||
			manifest.mainSha !== kept.mainSha
		)
			throw new Error("IMPORT_KEPT_DIFFERS");
		return { bundle: keptFacts(kept), pieces };
	}

	/** One job of the import on the company's code host. With its place in the company's line it asks the kernel first
	 * (`qorpera_code_request_step`): it renews the lease, saves how far the import got, and, at the step that first names
	 * the look, says whether the company is quiet. Only on `go` do its steps run. The set-aside step let go is the
	 * boundary after which the place is never opened again untouched. Only the read job (before the look) yields. */
	async #job<T>(run: ImportRun, steps: (job: CodeHostJob) => Promise<T>, yields: boolean): Promise<T> {
		if (run.ended) throw new ImportStopped(run.ended);
		return await this.#hosts.run(
			run.request.companyId,
			run.request.environmentId,
			run.signal,
			async (job) => {
				await this.#step(run, run.step, job.signal);
				if (run.step === "set-aside") run.stage = "aside";
				return await steps(job);
			},
			{ yields },
		);
	}

	/** A step call with the progress as it stands when the call goes. `go` resolves; `busy` (the kernel put the import
	 * back in the queue) and `lost` end the run's work at once and throw; an answer that was not heard throws too, and
	 * ends nothing. With no `step` it names the one the kernel took last (a renewal): read only when the call goes, after
	 * any call before it was answered, so a renewal never takes the row's step back. */
	async #step(run: ImportRun, step: CodeImportStep | undefined, signal: AbortSignal): Promise<CodeImportStep> {
		let named: CodeImportStep | undefined;
		const state = await this.#call(
			run,
			signal,
			CODE_IMPORT_RUN_RPCS[0],
			() => {
				named = step ?? run.confirmed;
				if (named === undefined) throw new Error("IMPORT_PROGRESS_INVALID");
				return { p_progress: codeImportProgressValue({ ...run.progress, step: named }) };
			},
			(answer) => {
				if (
					!isRecord(answer) ||
					answer.schema !== "qorpera.code-request-step/v1" ||
					(answer.state !== "go" && answer.state !== "busy" && answer.state !== "lost")
				)
					throw new Error("CODE_IMPORT_STEP_UNCONFIRMED");
				// Taken while no other call can go: the next one (a renewal) reads it.
				if (answer.state === "go") run.confirmed = named;
				else this.#end(run, answer.state);
				return answer.state;
			},
		);
		if (state !== "go") throw this.#end(run, state);
		this.#renew(run);
		return named as CodeImportStep;
	}

	/** One call of the kernel's, after the run's earlier ones: none while the kernel has taken the request back. A call
	 * that rejects, or whose answer `read` does not take, was not heard. */
	async #call<T>(
		run: ImportRun,
		signal: AbortSignal,
		method: (typeof CODE_IMPORT_RUN_RPCS)[number],
		args: () => Record<string, unknown>,
		read: (answer: unknown) => T,
	): Promise<T> {
		const call = run.calls.then(async () => {
			if (run.ended) throw new ImportStopped(run.ended);
			const sent = args();
			let answer: unknown;
			try {
				answer = await this.#control.call(
					method,
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_request_id: run.request.requestId,
						p_token: run.request.token,
						...sent,
					},
					AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]),
				);
				return read(answer);
			} catch (error) {
				this.#failed(run, method, error);
				throw new ImportStopped("unheard");
			}
		});
		run.calls = call.catch(() => undefined);
		return await call;
	}

	/** The lease renewed in five minutes, by a step call that names the step the kernel last took (never the first to
	 * name the look), unless the run ended first. Each step call that was let go sets the time again. */
	#renew(run: ImportRun): void {
		run.cancel?.();
		run.cancel = undefined;
		if (run.finished || run.ended || run.confirmed === undefined) return;
		run.cancel = this.#timer(CODE_IMPORT_RENEW_MS, () => {
			run.cancel = undefined;
			if (run.finished || run.ended) return;
			this.#step(run, undefined, run.signal).then(
				(step) => this.#report({ event: "code-import", step: "renewed", ...run.named, at: step }),
				(error: unknown) => {
					// Not heard: asked again in five minutes, within the lease's fifteen.
					if (error instanceof ImportStopped && error.stop === "unheard") this.#renew(run);
				},
			);
		});
	}

	/** An answer that the lease is gone ends the run's work there and then, before any other call can go. */
	#lostIf<T extends string>(run: ImportRun, state: T): T {
		if (state === "lost") this.#end(run, "lost");
		return state;
	}

	/** The kernel took the request back: the renewal stops, and so does the work under way (the fetch, the job). */
	#end(run: ImportRun, state: "busy" | "lost"): ImportStopped {
		const stopped = new ImportStopped(state);
		if (!run.ended) {
			run.ended = state;
			run.cancel?.();
			run.cancel = undefined;
			this.#report({
				event: "code-import",
				step: state === "lost" ? "lease-lost" : "put-back",
				...run.named,
				at: run.step,
			});
			run.halt.abort(stopped);
		}
		return stopped;
	}

	#failed(run: ImportRun, step: string, error: unknown): void {
		this.#report({ event: "code-import-error", step, ...run.named, code: codeOf(error) });
	}

	/** How a run that threw ends (the module's comment has the rules). */
	async #ended(run: ImportRun, error: unknown): Promise<CodeImportOutcome> {
		const stop =
			error instanceof ImportStopped || error instanceof CodeImportStop
				? error
				: run.signal.aborted
					? new CodeImportStop("busy", "IMPORT_STOPPED")
					: error instanceof CodingControlBusy
						? new CodeImportStop("busy", "CODING_CONTROL_BUSY")
						: [YIELDED, "CODE_BUNDLE_STORE_TIMEOUT"].includes(codeOf(error))
							? new CodeImportStop("busy", codeOf(error))
							: new CodeImportStop("failed", codeOf(error));
		const code = stop instanceof ImportStopped ? `IMPORT_${stop.stop.toUpperCase()}` : stop.code;
		if (stop instanceof ImportStopped || stop.end === "busy" || run.recorded || run.stage === "aside") {
			// Put off: nothing more is done for the request here, and the next claim goes on from the kernel's progress
			// and the place. A failure once the place was moved aside, or once it was recorded, puts it off too.
			if (!(stop instanceof ImportStopped) && stop.end !== "busy") this.#failed(run, run.step, error);
			this.#report({ event: "code-import", step: "put-off", ...run.named, at: run.step, code, stage: run.stage });
			return { schema: OUTCOME, state: "busy" };
		}
		this.#failed(run, run.step, error);
		const failed = (text: string): CodeImportOutcome => ({
			schema: OUTCOME,
			state: "failed",
			code: CODE_IMPORT_FAILED_CODE.test(text) ? text : "UNCLASSIFIED",
		});
		if (run.stage === "closed") {
			if (await this.#reopen(run)) {
				await this.#removeBundles(run, true);
				return failed(`${code}:PLACE_AS_BEFORE`);
			}
			return failed(`${code}:PLACE_CLOSED`);
		}
		await this.#removeBundles(run, false);
		return stop.end === "refused" && CODE_IMPORT_REFUSED_CODE.test(code)
			? { schema: OUTCOME, state: "refused", code }
			: failed(code);
	}

	/** Opens a place this run closed, when nothing was moved out of it (`reopenCodeArea`). The job does not yield, and
	 * asks the kernel nothing. */
	async #reopen(run: ImportRun): Promise<boolean> {
		const kept = run.progress.kept;
		if (!kept || run.signal.aborted) return false;
		try {
			const reopened = await this.#hosts.run(run.request.companyId, run.request.environmentId, run.signal, (job) =>
				this.#restore.reopen(job, { repository: run.repository, bundle: kept.name }),
			);
			this.#report({ event: "code-import", step: "reopened", ...run.named, state: reopened.state });
			return true;
		} catch (error) {
			this.#failed(run, "reopen", error);
			return false;
		}
	}
}
