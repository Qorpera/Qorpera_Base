import { type CloudCodingRepository, isUuid, parseCloudCodingRepository, SHA256_HEX_PATTERN } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import {
	CODE_BUNDLE_MAXIMUM_BYTES,
	CODE_BUNDLE_NAME,
	CODE_BUNDLES_KEPT,
	type CodeBundleStore,
	type CodeBundleTarget,
	type CodeBundleWriter,
	codeBundleName,
} from "./code-bundle-store.ts";
import { type CodeHostDeletions, controlCodeHostDeletions } from "./code-host.ts";
import {
	type CodeAreaChecked,
	type CodeAreaRef,
	type CodeBundleSink,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { redactCodingErrorText } from "./coding-error-detail.ts";
import { CodingControlBusy } from "./coding-executor.ts";

/** Nightly care of the repositories kept in Qorpera (own code storage, step 2a): the coding executor's side. The
 * kernel says which repositories are due (`qorpera_code_care_due`, migration `20260930710000`) and holds each run's
 * lease and last outcome; the code host's jobs do the git; the bundle store keeps the copies. One repository at a
 * time, in the night's order:
 *
 *   1  check and repair `main/`          always
 *   2  fsck                              the refs changed since the last good run, or 7 days passed
 *   3  bundle, copied out to the store   the refs are in no stored bundle, and fsck found no problems
 *   4  pack                              flag `gc`: fsck ok, the refs in a stored bundle, no `shallow`, loose objects
 *   5  check and fsck after the pack     job 4's steps began
 *   6  retire, the worktrees' files      flag `retire`: the kernel names candidates, and the repository is sound
 *   7  retire, git's folders for them    job 6 removed files, found some already gone, or failed
 *
 * Each is a code host job of its own that yields (`CodeHostJobs.run`, `yields`): a turn's job that joins the
 * company's line cancels it, and it published nothing. With its place in the line, before its first git command, each
 * job asks the kernel whether the company is still quiet (`qorpera_code_care_step`): a turn that began before the job
 * took its place shows there, and one that begins later joins the line behind it. So a turn never meets a care job.
 * Every run that began ends with `qorpera_code_care_finish`. */

export const CODE_CARE_RPCS = ["qorpera_code_care_due", "qorpera_code_care_step", "qorpera_code_care_finish"] as const;

/** The code host jobs care runs: `code-host-jobs.ts`'s functions, given by the caller. `collect` is
 * `collectCodeGarbage` as it is. */
export interface CodeCareJobs {
	check(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository },
		options?: { deep?: boolean },
	): Promise<CodeAreaChecked>;
	fsck(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository },
		options?: { maximumMs?: number },
	): Promise<{ state: "ok" | "problems" | "timeout"; exitCode: number | null; detail: string }>;
	bundle(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository; refsSha256: string },
		sink: CodeBundleSink,
		options?: { maximumBytes?: number; chunkBytes?: number },
	): Promise<{ sha256: string; bytes: number; gitVersion: string; refs: CodeAreaRef[]; refsSha256: string }>;
	collect(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository },
		block: CodeHostGcBlock,
		options: { packRefs: false; prune: false },
	): Promise<{ state: "collected" | "busy" | "held" }>;
	retire(
		job: CodeHostJob,
		value: { repository: CloudCodingRepository; workerIds: readonly string[] },
		options: { phase: "files" | "git-folder" },
	): Promise<{ retired: string[]; kept: { workerId: string; reason: string }[] }>;
}

/** What `qorpera_code_care_finish` records of one run (`qorpera.code-care-outcome/v1`), with exactly these keys.
 * `refsSha256` is the night's only once fsck's question about those refs is settled (it ran to an answer, or was not
 * due): a run that ended before leaves it null, so the next run still sees the refs as new. */
export interface CodeCareOutcome {
	schema: "qorpera.code-care-outcome/v1";
	state: "done" | "busy" | "failed";
	problem: string | null;
	mainSha: string | null;
	refsSha256: string | null;
	repaired: "none" | "head" | "files" | null;
	deep: boolean;
	fsck: { state: "ok" | "problems" | "timeout" | "skipped"; detail: string | null };
	bundle: {
		state: "stored" | "unchanged" | "skipped" | "failed" | "too-large";
		name: string | null;
		sha256: string | null;
		bytes: number | null;
		refsSha256: string | null;
	};
	gc: { state: "collected" | "held" | "skipped" | "shallow" | "failed" | "damaged" };
	worktrees: number | null;
	retired: number;
}

export interface CodeHostCareOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	jobs: CodeCareJobs;
	bundles: CodeBundleStore;
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-care` and `code-care-error` (whose `error` is the error itself, for the log to redact). */
	report?: (event: Record<string, unknown>) => void;
	now?: () => number;
	/** How many due repositories one pass takes, 1 to 50. Default 20. */
	limit?: number;
	/** How long an fsck may take; the job's own bound when left out. */
	fsckMs?: number;
	/** The largest bundle copied out. Default 2 GiB, the job's own. */
	bundleMaximumBytes?: number;
}

type CareStep = "begin" | "check" | "fsck" | "bundle" | "gc" | "verify" | "retire" | "retire-git";
type CareStop = "busy" | "lost" | "not-due";
interface CareLast {
	refsSha256: string | null;
	fsckState: string | null;
	fsckAt: string | null;
	bundleRefsSha256: string | null;
	bundleName: string | null;
	deepAt: string | null;
}
interface CareGo {
	state: "go";
	token: string;
	flags: { gc: boolean; retire: boolean };
	last: CareLast;
	/** The sessions whose worktrees may go: only a `retire` step names any. */
	retire: string[];
}
interface CareDue {
	companyId: string;
	environmentId: string;
	owner: string;
	name: string;
}
interface CareRun extends CareDue {
	repository: CloudCodingRepository;
	token: string;
	flags: CareGo["flags"];
	last: CareLast;
	/** A job failed: the run ends `failed`. */
	failed: boolean;
	/** Nothing this night put the repository's objects in doubt: only then does a worktree go. */
	sound: boolean;
	/** The session ids with a worktree folder, at the run's latest look. */
	worktrees: string[];
}
type Present = Extract<CodeAreaChecked, { state: "present" }>;

const WEEK_MS = 7 * 86_400_000;
const CALL_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
/** What a failed job is called in a run's problem. */
const JOB: Readonly<Record<Exclude<CareStep, "begin">, string>> = {
	check: "CHECK",
	fsck: "FSCK",
	bundle: "BUNDLE",
	gc: "GC",
	verify: "VERIFY",
	retire: "RETIRE",
	"retire-git": "RETIRE_GIT",
};

/** The kernel did not let a job go on: the company is busy, the run's lease is gone, or care is not due any more. */
class CareStopped extends Error {
	readonly stop: CareStop;
	constructor(stop: CareStop) {
		super(`CODE_CARE_STOPPED:${stop}`);
		this.stop = stop;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string | null => value === null || typeof value === "string";
const hex64 = (value: unknown): value is string => typeof value === "string" && SHA256_HEX_PATTERN.test(value);

/** An error's fixed code: the code host's own, or a message that is one. */
function codeOf(error: unknown): string {
	if ((error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal) && FIXED.test(error.code))
		return error.code;
	return error instanceof Error && FIXED.test(error.message) ? error.message : "UNCLASSIFIED";
}

/** A check's answer, as the jobs promise it. */
function checkedOf(value: unknown): CodeAreaChecked {
	if (isRecord(value) && value.state === "absent") return { state: "absent" };
	if (
		!isRecord(value) ||
		value.state !== "present" ||
		typeof value.mainSha !== "string" ||
		!SHA.test(value.mainSha) ||
		!hex64(value.refsSha256) ||
		typeof value.shallow !== "boolean" ||
		!Array.isArray(value.worktrees) ||
		!value.worktrees.every((id) => isUuid(id)) ||
		!isRecord(value.objects) ||
		![value.objects.loose, value.objects.sizeKiB].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) ||
		!(["none", "head", "files"] as unknown[]).includes(value.repaired)
	)
		throw new Error("CODE_CARE_ANSWER_INVALID");
	return value as CodeAreaChecked;
}

export class CodeHostCare {
	readonly #control: CodeHostCareOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #jobs: CodeCareJobs;
	readonly #bundles: CodeBundleStore;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #now: () => number;
	readonly #limit: number;
	readonly #fsck: { maximumMs: number } | undefined;
	readonly #bundleMaximumBytes: number;
	readonly #deleting: CodeHostDeletions;

	constructor(options: CodeHostCareOptions) {
		const limit = options.limit ?? 20,
			bundleMaximumBytes = options.bundleMaximumBytes ?? CODE_BUNDLE_MAXIMUM_BYTES;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			!hex64(options.machineIdSha256) ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 50 ||
			!Number.isSafeInteger(bundleMaximumBytes) ||
			bundleMaximumBytes < 1 ||
			(options.fsckMs !== undefined && (!Number.isSafeInteger(options.fsckMs) || options.fsckMs < 1))
		)
			throw new Error("INVALID_CODE_HOST_CARE");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#jobs = options.jobs;
		this.#bundles = options.bundles;
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		this.#report = options.report ?? (() => undefined);
		this.#now = options.now ?? Date.now;
		this.#limit = limit;
		this.#fsck = options.fsckMs === undefined ? undefined : { maximumMs: options.fsckMs };
		this.#bundleMaximumBytes = bundleMaximumBytes;
		this.#deleting = controlCodeHostDeletions({
			control: options.control,
			owner: options.owner,
			machineIdSha256: options.machineIdSha256,
		});
	}

	/** One pass: the bundle folders of companies being deleted go, then the repositories that are due are cared for,
	 * one at a time, each through the night's order, its outcome recorded with `qorpera_code_care_finish` on every path.
	 * It never throws for one repository's failure, nor for a kernel or a storage that does not answer: those are
	 * reported (`code-care-error`). `cared` counts the runs that ended `done`, `busy` those put off (at their start
	 * too), `failed` the rest that began or could not begin. A pass that is stopped ends the run it is in as `busy`. */
	async pass(signal: AbortSignal): Promise<{ cared: number; busy: number; failed: number }> {
		const counts = { cared: 0, busy: 0, failed: 0 };
		// The pass's signal may live as long as the process: it is handed to no `AbortSignal.any` (abort-scope.ts).
		await withAbortScope(signal, async (scoped) => {
			await this.#removeDeleted(scoped);
			let due: CareDue[];
			try {
				due = await this.#due(scoped);
			} catch (error) {
				if (!scoped.aborted) this.#report({ event: "code-care-error", step: "due", error });
				return;
			}
			for (const repository of due) {
				if (scoped.aborted) return;
				const ended = await this.#care(repository, scoped);
				if (ended === "done") counts.cared += 1;
				else if (ended !== "not-due") counts[ended] += 1;
			}
		});
		return counts;
	}

	/** The bundles of a company being deleted go with it: the store's company folders the kernel names. */
	async #removeDeleted(signal: AbortSignal): Promise<void> {
		try {
			const companies = await this.#bundles.companies(signal);
			if (companies.length === 0) return;
			for (const companyId of await this.#deleting(companies, signal)) {
				try {
					if (await this.#bundles.removeCompany(companyId, signal))
						this.#report({ event: "code-care", step: "bundles-removed", companyId });
				} catch (error) {
					if (signal.aborted) return;
					this.#report({ event: "code-care-error", step: "bundles-remove", companyId, error });
				}
			}
		} catch (error) {
			if (!signal.aborted) this.#report({ event: "code-care-error", step: "deletions", error });
		}
	}

	async #due(signal: AbortSignal): Promise<CareDue[]> {
		const answer = await this.#call(
			CODE_CARE_RPCS[0],
			{ p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_limit: this.#limit },
			signal,
		);
		if (!isRecord(answer) || answer.schema !== "qorpera.code-care-due/v1" || !Array.isArray(answer.repositories))
			throw new Error("CODE_CARE_DUE_UNCONFIRMED");
		const due: CareDue[] = [];
		for (const entry of answer.repositories.slice(0, this.#limit)) {
			const { companyId, environmentId, owner, name } = isRecord(entry) ? entry : {};
			try {
				if (!isUuid(companyId) || !isUuid(environmentId)) throw new Error("CODE_CARE_DUE_UNCONFIRMED");
				const repository = parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch: "main" });
				due.push({ companyId, environmentId, owner: repository.owner, name: repository.name });
			} catch {
				// One entry that names no repository kept here does not hold up the others.
				this.#report({ event: "code-care-error", step: "due", error: new Error("CODE_CARE_DUE_UNCONFIRMED") });
			}
		}
		return due;
	}

	/** One repository's run, from its `begin` to its `finish`. */
	async #care(due: CareDue, signal: AbortSignal): Promise<"done" | "busy" | "failed" | "not-due"> {
		const started = this.#now();
		const repository = parseCloudCodingRepository({
			host: "qorpera",
			owner: due.owner,
			name: due.name,
			baseBranch: "main",
		});
		const run: CareRun = {
			...due,
			repository,
			token: "",
			flags: { gc: false, retire: false },
			last: {
				refsSha256: null,
				fsckState: null,
				fsckAt: null,
				bundleRefsSha256: null,
				bundleName: null,
				deepAt: null,
			},
			failed: false,
			sound: false,
			worktrees: [],
		};
		const named = {
			companyId: due.companyId,
			environmentId: due.environmentId,
			repository: `${due.owner}/${due.name}`,
		};
		let begun: CareGo | { state: CareStop };
		try {
			begun = await this.#step(run, "begin", signal);
		} catch (error) {
			if (signal.aborted) return "not-due";
			this.#report({ event: "code-care-error", step: "begin", ...named, error });
			return "failed";
		}
		if (begun.state !== "go") {
			this.#report({ event: "code-care", step: "not-begun", ...named, state: begun.state });
			return begun.state === "busy" ? "busy" : "not-due";
		}
		run.token = begun.token;
		run.flags = begun.flags;
		run.last = begun.last;
		const outcome: CodeCareOutcome = {
			schema: "qorpera.code-care-outcome/v1",
			state: "done",
			problem: null,
			mainSha: null,
			refsSha256: null,
			repaired: null,
			deep: false,
			fsck: { state: "skipped", detail: null },
			bundle: { state: "skipped", name: null, sha256: null, bytes: null, refsSha256: null },
			gc: { state: "skipped" },
			worktrees: null,
			retired: 0,
		};
		let stop: CareStop | undefined;
		try {
			stop = await this.#night(run, outcome, signal);
		} catch (error) {
			// The night's order records its jobs' failures itself: anything else is the run's.
			stop = this.#stopped(error, signal);
			if (!stop) {
				run.failed = true;
				outcome.problem ??= `CARE_FAILED:${codeOf(error)}`;
				this.#report({ event: "code-care-error", step: "night", ...named, error });
			}
		}
		// A run that ended before fsck could look again: what the last fsck found still stands.
		if (outcome.problem === null && outcome.fsck.state === "skipped")
			outcome.problem =
				run.last.fsckState === "problems"
					? "FSCK_PROBLEMS"
					: run.last.fsckState === "timeout"
						? "FSCK_TIMEOUT"
						: null;
		if (stop === "lost") outcome.problem ??= "CARE_LEASE_LOST";
		outcome.state =
			stop === "busy" || stop === "not-due" ? "busy" : stop === "lost" || run.failed ? "failed" : "done";
		const recorded = await this.#finish(run, outcome, named, signal);
		this.#report({
			event: "code-care",
			step: "cared",
			...named,
			state: outcome.state,
			problem: outcome.problem,
			repaired: outcome.repaired,
			fsck: outcome.fsck.state,
			bundle: outcome.bundle.state,
			...(outcome.bundle.state === "stored"
				? { bundleName: outcome.bundle.name, bundleBytes: outcome.bundle.bytes }
				: {}),
			gc: outcome.gc.state,
			retired: outcome.retired,
			nextCareAt: recorded ?? null,
			ms: this.#now() - started,
		});
		return outcome.state;
	}

	/** The night's order for one repository. It fills in the outcome, and answers what stopped the run early, if anything
	 * did. A job that fails is recorded and stops the jobs that depend on it; the others still run. */
	async #night(run: CareRun, outcome: CodeCareOutcome, signal: AbortSignal): Promise<CareStop | undefined> {
		const { repository, last } = run;
		const target: CodeBundleTarget = { companyId: run.companyId, owner: run.owner, name: run.name };

		// 1. Check, and repair main/. The slower look at main/'s content once a week.
		const deep = this.#since(last.deepAt) >= WEEK_MS;
		let checked: CodeAreaChecked;
		try {
			checked = await this.#job(run, "check", signal, async (job) =>
				checkedOf(await this.#jobs.check(job, { repository }, { deep })),
			);
		} catch (error) {
			return this.#failed(run, outcome, "check", error, signal);
		}
		if (checked.state === "absent") {
			// Never made (its session never ran a turn) is nothing to care for. Gone after care saw it is a problem.
			if (last.refsSha256 !== null || last.bundleName !== null || last.fsckAt !== null)
				outcome.problem = "AREA_ABSENT";
			return undefined;
		}
		outcome.mainSha = checked.mainSha;
		outcome.repaired = checked.repaired;
		outcome.deep = deep;
		outcome.worktrees = checked.worktrees.length;
		run.worktrees = checked.worktrees;
		// A session wrote `repo.git/shallow`: history may be cut. That is the repository's problem, for an operator. It is
		// never packed, and its bundle is still tried, though git makes one that does not restore and the job's own
		// proof fails it.
		if (checked.shallow) outcome.problem = "AREA_SHALLOW";

		// 2. fsck, when the refs changed since the last good one, or a week passed.
		let health: "ok" | "problems" | "timeout" | "unknown" = "ok";
		if (last.refsSha256 !== checked.refsSha256 || last.fsckState !== "ok" || this.#since(last.fsckAt) >= WEEK_MS) {
			try {
				const fsck = await this.#job(run, "fsck", signal, (job) =>
					this.#jobs.fsck(job, { repository }, this.#fsck),
				);
				if (!["ok", "problems", "timeout"].includes(fsck?.state)) throw new Error("CODE_CARE_ANSWER_INVALID");
				health = fsck.state;
				outcome.fsck = { state: fsck.state, detail: fsck.state === "ok" ? null : this.#detail(fsck.detail) };
				if (fsck.state !== "ok") outcome.problem ??= fsck.state === "problems" ? "FSCK_PROBLEMS" : "FSCK_TIMEOUT";
			} catch (error) {
				const stop = this.#failed(run, outcome, "fsck", error, signal);
				if (stop) return stop;
				health = "unknown";
			}
		}
		if (health !== "unknown") outcome.refsSha256 = checked.refsSha256;
		run.sound = health === "ok";

		// 3. Bundle, unless a stored bundle already holds these refs. It holds them only when it is read whole this night
		// and its bytes are its manifest's: a copy nobody reads can rot for as long as the refs stand still. A repository
		// fsck found problems in gets no bundle: the last good copy is worth more than a copy of the damage.
		let holds: string | null = null;
		if (
			last.bundleRefsSha256 === checked.refsSha256 &&
			last.bundleName !== null &&
			CODE_BUNDLE_NAME.test(last.bundleName)
		) {
			try {
				const found = await this.#bundles.find(target, last.bundleName, signal);
				const whole =
					found?.refsSha256 === checked.refsSha256
						? await this.#bundles.verify(target, last.bundleName, signal)
						: null;
				if (whole?.refsSha256 === checked.refsSha256) holds = last.bundleName;
				// The kernel's record names a bundle the store does not hold any more, or holds with other bytes than its
				// manifest's: it is made again. The spoiled one stays until the store's own pruning takes it.
				else this.#problem(run, "bundle", new Error(found ? "CODE_BUNDLE_DIFFERS" : "CODE_BUNDLE_MISSING"));
			} catch (error) {
				outcome.bundle.state = "failed";
				const stop = this.#failed(run, outcome, "bundle", error, signal);
				if (stop) return stop;
			}
		}
		if (holds) outcome.bundle.state = "unchanged";
		else if (outcome.bundle.state !== "failed" && health !== "problems") {
			const stop = await this.#bundle(run, outcome, target, checked, signal);
			if (stop) return stop;
			if (outcome.bundle.state === "stored") holds = outcome.bundle.name;
		}

		// 4 and 5. Pack, and look at what it left.
		if (run.flags.gc) {
			const stop = await this.#pack(run, outcome, checked, holds, signal);
			if (stop) return stop;
		}

		// 6 and 7. Retire.
		if (run.flags.retire && run.sound) return await this.#retire(run, outcome, signal);
		return undefined;
	}

	/** Job 3: the bundle's pieces go to a writer of the store as the job reads them out, and get their name only when
	 * their SHA-256 and size are the ones the code host measured. Older bundles go only after a new one is stored. */
	async #bundle(
		run: CareRun,
		outcome: CodeCareOutcome,
		target: CodeBundleTarget,
		checked: Present,
		signal: AbortSignal,
	): Promise<CareStop | undefined> {
		const maximumBytes = this.#bundleMaximumBytes;
		let writer: CodeBundleWriter | undefined;
		try {
			// The storage is checked, and room for the bundle twice over, before the code host makes it.
			const begun = await this.#bundles.begin(
				target,
				{ expectedBytes: Math.min(checked.objects.sizeKiB * 1024, maximumBytes), maximumBytes },
				signal,
			);
			writer = begun;
			const made = await this.#job(run, "bundle", signal, (job) =>
				this.#jobs.bundle(
					job,
					{ repository: run.repository, refsSha256: checked.refsSha256 },
					{ write: (chunk) => begun.write(chunk, job.signal) },
					{ maximumBytes },
				),
			);
			if (made?.refsSha256 !== checked.refsSha256) throw new Error("CODE_CARE_BUNDLE_REFS_DIFFER");
			const createdAt = new Date(this.#now()).toISOString();
			const name = codeBundleName(createdAt, checked.mainSha);
			const stored = await begun.commit(
				name,
				{
					environmentId: run.environmentId,
					createdAt,
					gitVersion: made.gitVersion,
					mainSha: checked.mainSha,
					refsSha256: made.refsSha256,
					refs: made.refs,
					sha256: made.sha256,
					bytes: made.bytes,
					executorOwner: this.#owner,
				},
				signal,
			);
			outcome.bundle = {
				state: "stored",
				name,
				sha256: stored.sha256,
				bytes: stored.bytes,
				refsSha256: stored.refsSha256,
			};
		} catch (error) {
			// Nothing after a commit; a writer that did not get there leaves no file.
			await writer?.abort().catch((failure: unknown) => this.#problem(run, "bundle", failure));
			const stop = this.#stopped(error, signal);
			if (stop) return stop;
			const code = codeOf(error);
			if (code === "CODE_HOST_BUNDLE_TOO_LARGE" || code === "CODE_BUNDLE_TOO_LARGE") {
				outcome.bundle.state = "too-large";
				outcome.problem ??= "BUNDLE_TOO_LARGE";
				this.#problem(run, "bundle", error);
			} else {
				outcome.bundle.state = "failed";
				// A shallow repository's bundle is expected to fail its proof: recorded, and not the run's failure.
				if (checked.shallow) this.#problem(run, "bundle", error);
				else this.#failed(run, outcome, "bundle", error, signal);
			}
			return undefined;
		}
		try {
			await this.#bundles.prune(target, CODE_BUNDLES_KEPT, signal);
		} catch (error) {
			// The new bundle is stored either way; the older ones wait for the next.
			if (!signal.aborted) this.#problem(run, "prune", error);
		}
		return undefined;
	}

	/** Jobs 4 and 5: the pack (never pruning, never packing refs), only for a repository fsck found whole, whose refs are
	 * in a stored bundle, that has no `shallow` file and has loose objects to pack. The pack's own job reads the refs
	 * once more before it packs, with the company's line held: a turn that finished since the night's check (between
	 * two jobs, or while the stored copy was read) moved them, and then nothing is packed this night. Then a new job
	 * looks at what was really saved: a repository that is gone or that fsck now finds problems in is `damaged`. A pack
	 * whose result could not be looked at, or after which the refs are not the ones packed (a pack moves no ref, so
	 * other work came in between: not damage, and not proof either), leaves fsck's state `timeout`, so the next run
	 * looks first. */
	async #pack(
		run: CareRun,
		outcome: CodeCareOutcome,
		checked: Present,
		holds: string | null,
		signal: AbortSignal,
	): Promise<CareStop | undefined> {
		const { repository } = run;
		if (checked.shallow) {
			outcome.gc.state = "shallow";
			return undefined;
		}
		// The copy that stands behind the pack (`holds`) was written this night or read whole this night.
		if (!run.sound || holds === null || checked.objects.loose < 1) return undefined;
		// Whether the pack's own steps began: from then on, what the job saved must be looked at.
		let packing = false;
		try {
			const collected = await this.#job(run, "gc", signal, async (job, block, go) => {
				if (!go.flags.gc) return undefined;
				// What is packed is what fsck passed and a copy holds: the refs of the night's check. They are read
				// again here, where no other job of the company can run: moved refs are another repository than the
				// one that was checked, and its pack waits for the run that checks it.
				const now = checkedOf(await this.#jobs.check(job, { repository }, {}));
				if (now.state !== "present" || now.refsSha256 !== checked.refsSha256) return { state: "moved" as const };
				packing = true;
				return await this.#jobs.collect(job, { repository }, block, { packRefs: false, prune: false });
			});
			if (collected?.state === "collected") outcome.gc.state = "collected";
			else {
				// The refs moved since the check, leases were still held, or another view holds the block: nothing was
				// packed. Only the last two are the pack's own `held`.
				if (collected && collected.state !== "moved") outcome.gc.state = "held";
				packing = false;
			}
		} catch (error) {
			// The file came since the check: the job refused before it packed anything.
			if (error instanceof CodeHostRefusal && error.code === "CODE_HOST_GC_SHALLOW") {
				outcome.gc.state = "shallow";
				outcome.problem ??= "AREA_SHALLOW";
				return undefined;
			}
			const stop = this.#stopped(error, signal);
			// A job that yielded, or that the kernel did not let go on, published nothing. One cut off by the pass's own
			// end may have, as may one that failed (a publish whose answer was lost): both are looked at below.
			if (stop && !(packing && signal.aborted)) return stop;
			outcome.gc.state = "failed";
			if (!stop) this.#failed(run, outcome, "gc", error, signal);
		}
		if (!packing) return undefined;
		// Not proven whole after the pack: fsck's state is left `timeout` (its own, or this one), which makes the next
		// run's fsck due whatever else the kernel kept.
		const unverified = (fsck: CodeCareOutcome["fsck"]) => {
			run.sound = false;
			outcome.refsSha256 = null;
			outcome.fsck = fsck;
			outcome.problem ??= "GC_NOT_VERIFIED";
		};
		try {
			const { again, fsck } = await this.#job(run, "verify", signal, async (job) => {
				const again = checkedOf(await this.#jobs.check(job, { repository }, {}));
				if (again.state !== "present") return { again, fsck: undefined };
				const fsck = await this.#jobs.fsck(job, { repository }, this.#fsck);
				if (!["ok", "problems", "timeout"].includes(fsck?.state)) throw new Error("CODE_CARE_ANSWER_INVALID");
				return { again, fsck };
			});
			if (fsck) outcome.fsck = { state: fsck.state, detail: fsck.state === "ok" ? null : this.#detail(fsck.detail) };
			if (again.state !== "present" || fsck?.state === "problems") {
				run.sound = false;
				outcome.gc.state = "damaged";
				outcome.problem = "GC_DAMAGED";
				this.#problem(run, "verify", new Error("GC_DAMAGED"));
			} else if (fsck?.state !== "ok") unverified(outcome.fsck);
			else if (again.refsSha256 !== checked.refsSha256)
				// Whole, but not the refs that were packed. A pack moves no ref, so other work came between its job and
				// this one. That is no damage, and this look proves nothing about the pack either: the next run starts
				// with an fsck of the refs as they are then, and packing stays on.
				unverified({
					state: "timeout",
					detail: "GC_NOT_VERIFIED: the refs moved between the pack and the look at it",
				});
			else {
				outcome.mainSha = again.mainSha;
				outcome.worktrees = again.worktrees.length;
				run.worktrees = again.worktrees;
				if (again.repaired !== "none") outcome.repaired = again.repaired;
			}
		} catch (error) {
			unverified({ state: "timeout", detail: "GC_NOT_VERIFIED: the check after the pack did not finish" });
			return this.#failed(run, outcome, "verify", error, signal);
		}
		return undefined;
	}

	/** Jobs 6 and 7: the kernel names the sessions whose worktrees may go, with the job's place in the line held; the
	 * job removes the files of those whose folder holds exactly its branch's head, and a new job, which sees what was
	 * saved, removes git's folder for each whose files are gone (one an earlier night left as well). The second job
	 * runs only when there may be such a folder, and only its answer counts a worktree as retired. */
	async #retire(run: CareRun, outcome: CodeCareOutcome, signal: AbortSignal): Promise<CareStop | undefined> {
		const { repository } = run;
		let workerIds: string[] = [];
		// Whether git's folders may have to go: a worktree's files went this night, or were gone already (an earlier
		// night's removal whose second job never came), or the removal failed and what it saved is not known.
		let folders = false;
		try {
			await this.#job(run, "retire", signal, async (job, _block, go) => {
				workerIds = go.flags.retire ? go.retire : [];
				if (workerIds.length === 0) return;
				folders = true;
				const files = await this.#jobs.retire(job, { repository, workerIds }, { phase: "files" });
				folders = files.retired.length > 0 || files.kept.some((kept) => kept.reason === "NOT_THERE");
			});
		} catch (error) {
			const stop = this.#stopped(error, signal);
			if (stop) return stop;
			this.#failed(run, outcome, "retire", error, signal);
		}
		if (!folders) return undefined;
		try {
			const folders = await this.#job(run, "retire-git", signal, (job) =>
				this.#jobs.retire(job, { repository, workerIds }, { phase: "git-folder" }),
			);
			const retired = new Set(folders.retired);
			outcome.retired = retired.size;
			outcome.worktrees = run.worktrees.filter((id) => !retired.has(id)).length;
		} catch (error) {
			return this.#failed(run, outcome, "retire-git", error, signal);
		}
		return undefined;
	}

	/** One job of the run on the company's code host, which yields. With its place in the company's line it asks the
	 * kernel first: only on `go` do its steps run. */
	async #job<T>(
		run: CareRun,
		step: Exclude<CareStep, "begin">,
		signal: AbortSignal,
		steps: (job: CodeHostJob, block: CodeHostGcBlock, go: CareGo) => Promise<T>,
	): Promise<T> {
		return await this.#hosts.run(
			run.companyId,
			run.environmentId,
			signal,
			async (job, block) => {
				const answer = await this.#step(run, step, job.signal);
				if (answer.state !== "go") throw new CareStopped(answer.state);
				return await steps(job, block, answer);
			},
			{ yields: true },
		);
	}

	/** `begin` starts the run (no token yet); every other step renews its lease and asks whether the company is still
	 * quiet. */
	async #step(run: CareRun, step: CareStep, signal: AbortSignal): Promise<CareGo | { state: CareStop }> {
		const answer = await this.#call(
			CODE_CARE_RPCS[1],
			{
				p_owner: this.#owner,
				p_machine_id_sha256: this.#machineIdSha256,
				p_environment_id: run.environmentId,
				p_repository_owner: run.owner,
				p_name: run.name,
				p_token: step === "begin" ? null : run.token,
				p_step: step,
			},
			signal,
		);
		if (isRecord(answer) && answer.schema === "qorpera.code-care-step/v1") {
			if (answer.state === "busy" || answer.state === "lost" || answer.state === "not-due")
				return { state: answer.state };
			const { token, flags, last, retire = [] } = answer;
			if (
				answer.state === "go" &&
				isUuid(token) &&
				(step === "begin" || token === run.token) &&
				isRecord(flags) &&
				typeof flags.gc === "boolean" &&
				typeof flags.retire === "boolean" &&
				isRecord(last) &&
				[last.refsSha256, last.fsckState, last.fsckAt, last.bundleRefsSha256, last.bundleName, last.deepAt].every(
					text,
				) &&
				Array.isArray(retire) &&
				retire.length <= 20 &&
				retire.every((id) => isUuid(id))
			)
				return {
					state: "go",
					token,
					flags: { gc: flags.gc, retire: flags.retire },
					last: {
						refsSha256: last.refsSha256 as string | null,
						fsckState: last.fsckState as string | null,
						fsckAt: last.fsckAt as string | null,
						bundleRefsSha256: last.bundleRefsSha256 as string | null,
						bundleName: last.bundleName as string | null,
						deepAt: last.deepAt as string | null,
					},
					// Each session once: the job refuses a list that names one twice.
					retire: step === "retire" ? [...new Set(retire as string[])] : [],
				};
		}
		throw new Error("CODE_CARE_STEP_UNCONFIRMED");
	}

	/** Records the run's outcome, asked once more when the first try got no answer; a pass that was stopped still gets
	 * a few seconds for it. Answers when the kernel will have the repository cared for next, or undefined when the
	 * outcome was not recorded (which is reported). */
	async #finish(
		run: CareRun,
		outcome: CodeCareOutcome,
		named: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string | undefined> {
		let failure: unknown;
		for (let tries = 0; tries < 2; tries++) {
			try {
				const answer = await this.#call(
					CODE_CARE_RPCS[2],
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_environment_id: run.environmentId,
						p_repository_owner: run.owner,
						p_name: run.name,
						p_token: run.token,
						p_outcome: outcome,
					},
					signal.aborted ? AbortSignal.timeout(CALL_MS / 2) : signal,
				);
				if (isRecord(answer) && answer.schema === "qorpera.code-care-finish/v1") {
					if (answer.state === "recorded" && typeof answer.nextCareAt === "string") return answer.nextCareAt;
					// The run's lease ended, or another run has the repository: nothing was recorded, and asking again
					// would change nothing.
					if (answer.state === "lost") {
						failure = new Error("CODE_CARE_FINISH_LOST");
						break;
					}
				}
				failure = new Error("CODE_CARE_FINISH_UNCONFIRMED");
			} catch (error) {
				failure = error;
			}
		}
		this.#report({ event: "code-care-error", step: "finish", ...named, error: failure });
		return undefined;
	}

	#call(method: (typeof CODE_CARE_RPCS)[number], args: Record<string, unknown>, signal: AbortSignal) {
		return this.#control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]));
	}

	/** What ended a job without its failing: the kernel's answer, a turn's job that joined the line, or the pass's own
	 * end, which puts the run off like a busy company does. */
	#stopped(error: unknown, signal: AbortSignal): CareStop | undefined {
		if (error instanceof CareStopped) return error.stop;
		if (error instanceof CodeHostJobFailure && error.code === YIELDED) return "busy";
		// The kernel rolled a call of the job's back whole, for a row another call holds: the job threw, so it published
		// nothing, and the company is busy.
		if (error instanceof CodingControlBusy) return "busy";
		return signal.aborted ? "busy" : undefined;
	}

	/** A job's error: what stopped the run, or else a failure, which is recorded as the run's problem (the first one
	 * stays) and reported. */
	#failed(
		run: CareRun,
		outcome: CodeCareOutcome,
		step: Exclude<CareStep, "begin">,
		error: unknown,
		signal: AbortSignal,
	): CareStop | undefined {
		const stop = this.#stopped(error, signal);
		if (stop) return stop;
		run.failed = true;
		outcome.problem ??= `${JOB[step]}_FAILED:${codeOf(error)}`;
		this.#problem(run, step, error);
		return undefined;
	}

	#problem(run: CareRun, step: string, error: unknown): void {
		this.#report({
			event: "code-care-error",
			step,
			companyId: run.companyId,
			environmentId: run.environmentId,
			repository: `${run.owner}/${run.name}`,
			error,
		});
	}

	/** What fsck said, for the kernel's record: at most 2,000 characters, with nothing shaped like a credential, and
	 * nothing a JSON column refuses (a NUL, or half a character where the text was cut). */
	#detail(value: unknown): string | null {
		const said =
			typeof value === "string"
				? redactCodingErrorText(value)
						.replaceAll("\0", "")
						.slice(0, 2000)
						.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
				: "";
		return said || null;
	}

	/** How long ago `time` was; forever when there is none. */
	#since(time: string | null): number {
		const at = time === null ? Number.NaN : Date.parse(time);
		return Number.isFinite(at) ? this.#now() - at : Number.POSITIVE_INFINITY;
	}
}
