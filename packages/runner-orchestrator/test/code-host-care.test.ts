import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_BUNDLE_FOLDER, codeBundleName, createCodeBundleStore } from "../src/code-bundle-store.ts";
import {
	CODE_CARE_RPCS,
	type CodeCareJobs,
	type CodeCareOutcome,
	CodeHostCare,
	type CodeHostCareOptions,
} from "../src/code-host-care.ts";
import {
	type CodeAreaChecked,
	type CodeAreaRef,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
} from "../src/code-host-jobs.ts";
import { CODE_HOST_LAYOUT, type CodeHostJobOptions, type CodeHostJobs } from "../src/code-host-views.ts";
import { CodingControlBusy } from "../src/coding-executor.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const W1 = "aaaaaaaa-0000-4000-8000-000000000001";
const W2 = "aaaaaaaa-0000-4000-8000-000000000002";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const MAIN = "a".repeat(40);
const DAY = 86_400_000;
/** The night of 11 Nov 2026, 02:14:55 UTC. */
const NIGHT = Date.UTC(2026, 10, 11, 2, 14, 55);
const NEXT = "2026-11-12T02:31:00.000Z";
const STEP = "qorpera.code-care-step/v1";
const FINISH = "qorpera.code-care-finish/v1";
const REPOSITORY = { host: "qorpera", owner: "acme", name: "app", baseBranch: "main" };
const DUE = { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "acme", name: "app" };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fingerprint = (refs: readonly CodeAreaRef[]) =>
	digest(
		[...refs]
			.sort((a, b) => (a.name < b.name ? -1 : 1))
			.map((ref) => `${ref.sha} ${ref.name}\n`)
			.join(""),
	);
const yielded = () => new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "another job of the company joined the line");

/** One repository's code area, as the stand-ins for the code host's jobs see it. */
class Area {
	present = true;
	refs: CodeAreaRef[] = [
		{ name: "refs/heads/main", sha: MAIN },
		{ name: "refs/qorpera/kept-here", sha: "b".repeat(40) },
	];
	shallow = false;
	worktrees = [W1, W2];
	/** The sessions whose worktree files a retire removed, with git's folder for them still there. */
	filesGone: string[] = [];
	objects = { loose: 72, packs: 1, sizeKiB: 64 };
	repaired: "none" | "head" | "files" = "none";
	fsck: { state: "ok" | "problems" | "timeout"; exitCode: number | null; detail: string } = {
		state: "ok",
		exitCode: 0,
		detail: "",
	};
	bundle = Buffer.from("every ref of the repository, in one bundle");

	fingerprint(): string {
		return fingerprint(this.refs);
	}
	checked(): CodeAreaChecked {
		if (!this.present) return { state: "absent" };
		return {
			state: "present",
			mainSha: MAIN,
			refs: [...this.refs],
			refsSha256: this.fingerprint(),
			shallow: this.shallow,
			worktrees: this.worktrees.filter((id) => !this.filesGone.includes(id)),
			objects: { ...this.objects },
			repaired: this.repaired,
			restored: [],
		};
	}
	/** A session committed: its branch moved, and the bundle of every ref is another one. */
	commit(): void {
		const name = `refs/heads/qorpera/coding/${W1}`;
		this.refs = [...this.refs.filter((ref) => ref.name !== name), { name, sha: randomBytes(20).toString("hex") }];
		this.bundle = Buffer.concat([this.bundle, Buffer.from(" and one more commit")]);
		this.objects.loose += 3;
	}
}

interface Row {
	token: string | null;
	flags: { gc: boolean; retire: boolean };
	last: {
		refsSha256: string | null;
		fsckState: string | null;
		fsckAt: string | null;
		bundleRefsSha256: string | null;
		bundleName: string | null;
		deepAt: string | null;
	};
	/** The sessions the kernel names for a retire. */
	retire: string[];
	outcomes: CodeCareOutcome[];
}

/** The kernel's three RPCs and the deletion question, with a registry row per repository name. A finish writes the
 * row's last values as the migration's does. */
class Kernel {
	readonly calls: { method: string; args: Record<string, unknown> }[] = [];
	readonly rows = new Map<string, Row>();
	readonly log: string[];
	readonly clock: { now: number };
	due: unknown[] = [DUE];
	deleting: unknown = [];
	/** When a finish moves the refs the next run compares with: only with a clean fsck, as the migration does, or with
	 * whatever the outcome names (null too). Care must be right either way. */
	refsRule: "clean-fsck" | "as-given" = "clean-fsck";
	dueAnswer: (() => unknown) | undefined;
	stepAnswer: ((step: string, row: Row) => unknown) | undefined;
	finishAnswer: (() => unknown) | undefined;

	constructor(log: string[], clock: { now: number }) {
		this.log = log;
		this.clock = clock;
	}

	row(name = "app"): Row {
		let row = this.rows.get(name);
		if (!row) {
			row = {
				token: null,
				flags: { gc: false, retire: false },
				last: {
					refsSha256: null,
					fsckState: null,
					fsckAt: null,
					bundleRefsSha256: null,
					bundleName: null,
					deepAt: null,
				},
				retire: [],
				outcomes: [],
			};
			this.rows.set(name, row);
		}
		return row;
	}

	go(row: Row, step: string, flags = row.flags): unknown {
		return {
			schema: STEP,
			state: "go",
			token: row.token,
			leaseUntil: new Date(this.clock.now + 2 * 3_600_000).toISOString(),
			flags: { ...flags },
			last: { ...row.last },
			...(step === "retire" ? { retire: [...row.retire] } : {}),
		};
	}

	async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal.throwIfAborted();
		this.calls.push({ method, args: structuredClone(args) });
		if (method === "qorpera_code_care_due")
			return this.dueAnswer ? this.dueAnswer() : { schema: "qorpera.code-care-due/v1", repositories: this.due };
		if (method === "qorpera_code_hosts_deleting")
			return Array.isArray(this.deleting)
				? (args.p_company_ids as string[]).filter((id) => (this.deleting as unknown[]).includes(id))
				: this.deleting;
		const row = this.row(args.p_name as string);
		if (method === "qorpera_code_care_step") {
			const step = args.p_step as string;
			this.log.push(`step:${step}`);
			const forced = this.stepAnswer?.(step, row);
			if (forced !== undefined) return forced;
			if (step === "begin") {
				if (args.p_token !== null) throw new Error("a begin with a token");
				row.token = randomUUID();
			} else if (args.p_token !== row.token) return { schema: STEP, state: "lost" };
			return this.go(row, step);
		}
		if (method === "qorpera_code_care_finish") {
			const outcome = structuredClone(args.p_outcome) as CodeCareOutcome;
			this.log.push("finish");
			const forced = this.finishAnswer?.();
			if (forced !== undefined) return forced;
			row.outcomes.push(outcome);
			if (args.p_token !== row.token) return { schema: FINISH, state: "lost" };
			const at = new Date(this.clock.now).toISOString();
			if (this.refsRule === "as-given") row.last.refsSha256 = outcome.refsSha256;
			else if (outcome.fsck.state === "ok" && outcome.refsSha256 !== null) row.last.refsSha256 = outcome.refsSha256;
			if (outcome.fsck.state !== "skipped") {
				row.last.fsckState = outcome.fsck.state;
				row.last.fsckAt = at;
			}
			if (outcome.bundle.state === "stored") {
				row.last.bundleRefsSha256 = outcome.bundle.refsSha256;
				row.last.bundleName = outcome.bundle.name;
			}
			if (outcome.deep) row.last.deepAt = at;
			row.token = null;
			return { schema: FINISH, state: "recorded", nextCareAt: NEXT };
		}
		throw new Error(`not a care call: ${method}`);
	}
}

const BLOCK: CodeHostGcBlock = {
	begin: async () => ({ state: "blocking", held: 0 }),
	end: async () => undefined,
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: Partial<CodeHostCareOptions> = {}) {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "code-host-care-")));
	dirs.push(parent);
	const root = join(parent, CODE_BUNDLE_FOLDER);
	const log: string[] = [];
	const clock = { now: NIGHT };
	const storage = { mounted: true };
	const bundles = createCodeBundleStore({
		root,
		assert: async () => {
			if (!storage.mounted) throw new Error("CODING_STORAGE_MOUNT_UNCONFIRMED");
		},
	});
	const kernel = new Kernel(log, clock);
	const area = new Area();
	/** Every job the code hosts ran, with how it took its place in line. */
	const runs: { companyId: string; environmentId: string; options: CodeHostJobOptions | undefined }[] = [];
	const hosts: Pick<CodeHostJobs, "run"> = {
		async run<T>(
			companyId: string,
			environmentId: string,
			signal: AbortSignal,
			job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
			jobOptions?: CodeHostJobOptions,
		): Promise<T> {
			runs.push({ companyId, environmentId, options: jobOptions });
			signal.throwIfAborted();
			const shell = {
				run: async () => {
					throw new Error("the stand-ins run no command");
				},
			};
			return await job({ shell, layout: CODE_HOST_LAYOUT, signal }, BLOCK);
		},
	};
	/** The stand-ins for the code host's jobs: a test replaces one to make it fail or answer otherwise. */
	const jobs: CodeCareJobs = {
		check: async () => area.checked(),
		fsck: async () => ({ ...area.fsck }),
		bundle: async (_job, value, sink) => {
			for (let at = 0; at < area.bundle.length; at += 16) await sink.write(area.bundle.subarray(at, at + 16));
			return {
				sha256: digest(area.bundle),
				bytes: area.bundle.length,
				gitVersion: "2.56.0",
				refs: [...area.refs],
				refsSha256: value.refsSha256,
			};
		},
		collect: async () => {
			area.objects = { ...area.objects, loose: 0, packs: 2 };
			return { state: "collected" };
		},
		retire: async (_job, value, phase) => {
			if (phase.phase === "files") {
				const retired = value.workerIds.filter((id) => area.checked().state === "present" && has(id));
				area.filesGone.push(...retired);
				return {
					retired,
					kept: value.workerIds
						.filter((id) => !retired.includes(id))
						.map((workerId) => ({ workerId, reason: "NOT_THERE" })),
				};
			}
			const retired = value.workerIds.filter((id) => area.filesGone.includes(id));
			area.worktrees = area.worktrees.filter((id) => !retired.includes(id));
			area.filesGone = area.filesGone.filter((id) => !retired.includes(id));
			return { retired, kept: [] };
		},
	};
	const has = (id: string) => area.worktrees.includes(id) && !area.filesGone.includes(id);
	const seen: { job: string; args: unknown[] }[] = [];
	const logged = Object.fromEntries(
		(Object.keys(jobs) as (keyof CodeCareJobs)[]).map((name) => [
			name,
			async (...args: unknown[]) => {
				const last = args.at(-1) as { deep?: boolean; phase?: string } | undefined;
				log.push(`job:${name}${last?.deep ? ":deep" : last?.phase ? `:${last.phase}` : ""}`);
				seen.push({ job: name, args: args.slice(1) });
				return await (jobs[name] as (...all: unknown[]) => Promise<unknown>)(...args);
			},
		]),
	) as unknown as CodeCareJobs;
	const events: Record<string, unknown>[] = [];
	const care = new CodeHostCare({
		control: kernel,
		hosts,
		jobs: logged,
		bundles,
		owner: OWNER,
		machineIdSha256: MACHINE,
		report: (event) => events.push(event),
		now: () => clock.now,
		...options,
	});
	const folder = join(root, COMPANY, "acme", "app");
	return {
		care,
		kernel,
		area,
		jobs,
		seen,
		runs,
		events,
		log,
		clock,
		storage,
		bundles,
		root,
		folder,
		row: kernel.row(),
		/** One pass with a signal of its own. */
		pass: () => care.pass(new AbortController().signal),
		/** The last outcome a finish recorded, and the log since the last look. */
		outcome: () => kernel.row().outcomes.at(-1) as CodeCareOutcome,
		took: () => log.splice(0),
		errors: () =>
			events
				.filter((event) => event.event === "code-care-error")
				.map((event) => `${event.step}:${(event.error as Error).message}`),
		stored: () => (existsSync(folder) ? readdirSync(folder).sort() : []),
	};
}

const BEGIN_TO_BUNDLE = [
	"step:begin",
	"step:check",
	"job:check:deep",
	"step:fsck",
	"job:fsck",
	"step:bundle",
	"job:bundle",
];
const PACK = ["step:gc", "job:check", "job:collect", "step:verify", "job:check", "job:fsck"];
const RETIRE = ["step:retire", "job:retire:files", "step:retire-git", "job:retire:git-folder"];

describe("CodeHostCare", () => {
	it("names the control's RPCs", () => {
		expect(CODE_CARE_RPCS).toEqual(["qorpera_code_care_due", "qorpera_code_care_step", "qorpera_code_care_finish"]);
	});

	it("cares for a changed repository with the flags off: check, fsck and bundle, each a yielding job behind its own step, and the outcome finished", async () => {
		const t = setup();
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual([...BEGIN_TO_BUNDLE, "finish"]);
		// Each job took its company's line as one that yields.
		expect(t.runs).toEqual(
			Array.from({ length: 3 }, () => ({
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				options: { yields: true },
			})),
		);
		const name = "20261111T021455Z-aaaaaaaaaaaa";
		const outcome = t.outcome();
		expect(outcome).toEqual({
			schema: "qorpera.code-care-outcome/v1",
			state: "done",
			problem: null,
			mainSha: MAIN,
			refsSha256: t.area.fingerprint(),
			repaired: "none",
			deep: true,
			fsck: { state: "ok", detail: null },
			bundle: {
				state: "stored",
				name,
				sha256: digest(t.area.bundle),
				bytes: t.area.bundle.length,
				refsSha256: t.area.fingerprint(),
			},
			gc: { state: "skipped" },
			worktrees: 2,
			retired: 0,
		});
		// The bundle is on the storage with its manifest, and holds the bytes the job read out.
		expect(t.stored()).toEqual([`${name}.bundle`, `${name}.json`]);
		expect(readFileSync(join(t.folder, `${name}.bundle`))).toEqual(t.area.bundle);
		expect(JSON.parse(readFileSync(join(t.folder, `${name}.json`), "utf8"))).toMatchObject({
			schema: "qorpera.code-bundle/v1",
			companyId: COMPANY,
			environmentId: ENVIRONMENT,
			repository: REPOSITORY,
			createdAt: "2026-11-11T02:14:55.000Z",
			gitVersion: "2.56.0",
			mainSha: MAIN,
			refsSha256: t.area.fingerprint(),
			refs: t.area.refs,
			sha256: digest(t.area.bundle),
			bytes: t.area.bundle.length,
			verified: true,
			executorOwner: OWNER,
		});

		// What the kernel was asked, in order.
		const who = { p_owner: OWNER, p_machine_id_sha256: MACHINE };
		const which = { ...who, p_environment_id: ENVIRONMENT, p_repository_owner: "acme", p_name: "app" };
		const token = t.kernel.calls[1]?.args.p_token === null ? t.kernel.calls[2]?.args.p_token : undefined;
		expect(token).toMatch(/^[0-9a-f-]{36}$/);
		expect(t.kernel.calls).toEqual([
			{ method: "qorpera_code_care_due", args: { ...who, p_limit: 20 } },
			{ method: "qorpera_code_care_step", args: { ...which, p_token: null, p_step: "begin" } },
			{ method: "qorpera_code_care_step", args: { ...which, p_token: token, p_step: "check" } },
			{ method: "qorpera_code_care_step", args: { ...which, p_token: token, p_step: "fsck" } },
			{ method: "qorpera_code_care_step", args: { ...which, p_token: token, p_step: "bundle" } },
			{ method: "qorpera_code_care_finish", args: { ...which, p_token: token, p_outcome: outcome } },
		]);
		// And what the jobs were given.
		expect(t.seen.map((call) => [call.job, ...call.args.filter((arg) => typeof arg !== "function")])).toEqual([
			["check", { repository: REPOSITORY }, { deep: true }],
			["fsck", { repository: REPOSITORY }, undefined],
			[
				"bundle",
				{ repository: REPOSITORY, refsSha256: t.area.fingerprint() },
				expect.objectContaining({ write: expect.any(Function) }),
				{ maximumBytes: 2 * 1024 ** 3 },
			],
		]);
		expect(t.events).toEqual([
			{
				event: "code-care",
				step: "cared",
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				repository: "acme/app",
				state: "done",
				problem: null,
				repaired: "none",
				fsck: "ok",
				bundle: "stored",
				bundleName: name,
				bundleBytes: t.area.bundle.length,
				gc: "skipped",
				retired: 0,
				nextCareAt: NEXT,
				ms: 0,
			},
		]);
	});

	it("gives a repository with unchanged refs job 1 only; fsck again after a week, a bundle again when the refs change or the stored one is gone or spoiled", async () => {
		const t = setup();
		await t.pass();
		t.took();
		const first = t.stored();
		expect(first).toHaveLength(2);

		// The next night, nothing changed: the check alone, and not the slow look at main/.
		t.clock.now += DAY;
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "finish"]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			refsSha256: t.area.fingerprint(),
			deep: false,
			fsck: { state: "skipped", detail: null },
			bundle: { state: "unchanged", name: null, sha256: null, bytes: null, refsSha256: null },
			gc: { state: "skipped" },
		});
		expect(t.stored()).toEqual(first);
		expect(t.seen.at(-1)).toEqual({ job: "check", args: [{ repository: REPOSITORY }, { deep: false }] });

		// A week after the last fsck: it runs again, and so does the slow look. Still no new bundle.
		t.clock.now += 6 * DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "job:fsck", "finish"]);
		expect(t.outcome()).toMatchObject({ deep: true, fsck: { state: "ok" }, bundle: { state: "unchanged" } });
		expect(t.stored()).toEqual(first);

		// A session committed: fsck and a new bundle, beside the first.
		t.clock.now += DAY;
		t.area.commit();
		await t.pass();
		expect(t.took()).toEqual([
			"step:begin",
			"step:check",
			"job:check",
			"step:fsck",
			"job:fsck",
			"step:bundle",
			"job:bundle",
			"finish",
		]);
		const second = codeBundleName(new Date(t.clock.now).toISOString(), MAIN);
		expect(t.outcome().bundle).toEqual({
			state: "stored",
			name: second,
			sha256: digest(t.area.bundle),
			bytes: t.area.bundle.length,
			refsSha256: t.area.fingerprint(),
		});
		expect(t.stored()).toEqual([...first, `${second}.bundle`, `${second}.json`].sort());

		// The kernel's record names a bundle the store no longer holds: it is made again, without an fsck.
		t.clock.now += DAY;
		rmSync(join(t.folder, `${second}.bundle`));
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "step:bundle", "job:bundle", "finish"]);
		expect(t.errors()).toEqual(["bundle:CODE_BUNDLE_MISSING"]);
		const third = codeBundleName(new Date(t.clock.now).toISOString(), MAIN);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, bundle: { state: "stored", name: third } });
		expect(readFileSync(join(t.folder, `${third}.bundle`))).toEqual(t.area.bundle);

		// The stored bundle rotted where it lay: the same size, other bytes, the refs as they were, the flags off. It is
		// read whole every night, so the same night it is made again, and the spoiled one is no longer the record's.
		t.clock.now += DAY;
		writeFileSync(join(t.folder, `${third}.bundle`), Buffer.alloc(t.area.bundle.length, 0x2e));
		t.took();
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "step:bundle", "job:bundle", "finish"]);
		expect(t.errors()).toEqual(["bundle:CODE_BUNDLE_MISSING", "bundle:CODE_BUNDLE_DIFFERS"]);
		const fourth = codeBundleName(new Date(t.clock.now).toISOString(), MAIN);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			bundle: { state: "stored", name: fourth, sha256: digest(t.area.bundle) },
			gc: { state: "skipped" },
		});
		expect(readFileSync(join(t.folder, `${fourth}.bundle`))).toEqual(t.area.bundle);
		// The night after, the new one is whole: nothing is made.
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "finish"]);
		expect(t.errors()).toHaveLength(2);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, bundle: { state: "unchanged" } });
	});

	it("with the flags on, packs after a clean fsck and a stored bundle, looks at what the pack left, and retires in two jobs", async () => {
		const t = setup();
		t.row.flags = { gc: true, retire: true };
		// A session named twice is asked for once: the job refuses a list with a double.
		t.row.retire = [W1, W1];
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual([...BEGIN_TO_BUNDLE, ...PACK, ...RETIRE, "finish"]);
		expect(t.runs).toHaveLength(7);
		expect(t.runs.every((run) => run.options?.yields === true && run.companyId === COMPANY)).toBe(true);
		expect(t.seen.slice(3).map((call) => [call.job, ...call.args])).toEqual([
			// The refs are read again in the pack's own job, before anything is packed.
			["check", { repository: REPOSITORY }, {}],
			// Never pruning, never packing refs, with the job's own gc block.
			["collect", { repository: REPOSITORY }, BLOCK, { packRefs: false, prune: false, packArchivedRefs: true }],
			["check", { repository: REPOSITORY }, {}],
			["fsck", { repository: REPOSITORY }, undefined],
			["retire", { repository: REPOSITORY, workerIds: [W1] }, { phase: "files" }],
			["retire", { repository: REPOSITORY, workerIds: [W1] }, { phase: "git-folder" }],
		]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			refsSha256: t.area.fingerprint(),
			fsck: { state: "ok", detail: null },
			bundle: { state: "stored" },
			gc: { state: "collected" },
			worktrees: 1,
			retired: 1,
		});

		// The next night: nothing loose to pack, and the kernel names the same session, whose worktree is gone.
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", ...RETIRE, "finish"]);
		expect(t.outcome()).toMatchObject({ state: "done", gc: { state: "skipped" }, worktrees: 1, retired: 0 });
		// With no candidates the retire job runs nothing.
		t.row.retire = [];
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "step:retire", "finish"]);

		// A worktree whose files went on an earlier night, with git's folder left: the second job finishes it.
		t.row.retire = [W2];
		t.area.filesGone = [W2];
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", ...RETIRE, "finish"]);
		expect(t.outcome()).toMatchObject({ worktrees: 0, retired: 1 });
		expect(t.area.worktrees).toEqual([]);

		// Worktrees that all stay with their files (a file nobody committed, say) leave no folder of git's to remove: no
		// second job.
		const kept = setup();
		kept.row.flags = { gc: false, retire: true };
		kept.row.retire = [W1, W2];
		kept.jobs.retire = async (_job, value) => ({
			retired: [],
			kept: value.workerIds.map((workerId) => ({ workerId, reason: "NOT_CLEAN" })),
		});
		await expect(kept.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(kept.took()).toEqual([...BEGIN_TO_BUNDLE, "step:retire", "job:retire:files", "finish"]);
		expect(kept.outcome()).toMatchObject({ state: "done", problem: null, worktrees: 2, retired: 0 });
		// A removal that failed is still looked at by the second job: its save may have gone through all the same.
		const lost = setup();
		lost.row.flags = { gc: false, retire: true };
		lost.row.retire = [W1];
		const retire = lost.jobs.retire;
		lost.jobs.retire = async (job, value, phase) => {
			const answer = await retire(job, value, phase);
			if (phase.phase === "files")
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_UNANSWERED", "the node did not answer the publish");
			return answer;
		};
		await expect(lost.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(lost.took()).toEqual([...BEGIN_TO_BUNDLE, ...RETIRE, "finish"]);
		expect(lost.outcome()).toMatchObject({
			state: "failed",
			problem: "RETIRE_FAILED:CODE_HOST_PUBLISH_UNANSWERED",
			worktrees: 1,
			retired: 1,
		});

		// A flag switched off while the run went on is off for its job: the kernel's answer at the job's own step counts.
		const off = setup();
		off.row.flags = { gc: true, retire: true };
		off.row.retire = [W1];
		off.kernel.stepAnswer = (step, row) =>
			step === "gc" || step === "retire" ? off.kernel.go(row, step, { gc: false, retire: false }) : undefined;
		await off.pass();
		expect(off.took()).toEqual([...BEGIN_TO_BUNDLE, "step:gc", "step:retire", "finish"]);
		expect(off.outcome()).toMatchObject({ state: "done", gc: { state: "skipped" }, retired: 0, worktrees: 2 });
	});

	it("gives a repository fsck finds problems in no bundle, no pack and no retire, and looks again every night", async () => {
		const t = setup();
		t.row.flags = { gc: true, retire: true };
		t.row.retire = [W1];
		t.area.fsck = { state: "problems", exitCode: 1, detail: `missing blob ${"c".repeat(40)}\n${"x".repeat(3000)}` };
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "job:fsck", "finish"]);
		const outcome = t.outcome();
		expect(outcome).toMatchObject({
			state: "done",
			problem: "FSCK_PROBLEMS",
			refsSha256: t.area.fingerprint(),
			bundle: { state: "skipped", name: null },
			gc: { state: "skipped" },
			retired: 0,
		});
		expect(outcome.fsck.state).toBe("problems");
		expect(outcome.fsck.detail).toHaveLength(2000);
		expect(outcome.fsck.detail?.startsWith(`missing blob ${"c".repeat(40)}\n`)).toBe(true);
		expect(t.stored()).toEqual([]);
		// What fsck said goes into a JSON column: no NUL, and no half of a character where the text was cut.
		const odd = setup();
		odd.area.fsck = { state: "problems", exitCode: 1, detail: `a\0b${"x".repeat(1997)}\u{1F600} and more` };
		await odd.pass();
		expect(odd.outcome().fsck.detail).toBe(`ab${"x".repeat(1997)}�`);

		// The refs did not change, but the last fsck was not good: it runs again.
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "step:fsck", "job:fsck", "finish"]);
		// A run put off before fsck could look again still says what the last one found.
		t.kernel.stepAnswer = (step) => (step === "check" ? { schema: STEP, state: "busy" } : undefined);
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(t.outcome()).toMatchObject({ state: "busy", problem: "FSCK_PROBLEMS", fsck: { state: "skipped" } });
		t.kernel.stepAnswer = undefined;
		t.took();

		// Repaired: fsck is clean, and the bundle, the pack and the retire follow.
		t.area.fsck = { state: "ok", exitCode: 0, detail: "" };
		t.clock.now += DAY;
		await t.pass();
		expect(t.took()).toEqual([
			"step:begin",
			"step:check",
			"job:check",
			"step:fsck",
			"job:fsck",
			"step:bundle",
			"job:bundle",
			...PACK,
			...RETIRE,
			"finish",
		]);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, gc: { state: "collected" }, retired: 1 });

		// An fsck that ran out of time is a problem too; the bundle is still made, but nothing is packed or retired.
		const slow = setup();
		slow.row.flags = { gc: true, retire: true };
		slow.row.retire = [W1];
		slow.area.fsck = { state: "timeout", exitCode: null, detail: "" };
		await slow.pass();
		expect(slow.took()).toEqual([...BEGIN_TO_BUNDLE, "finish"]);
		expect(slow.outcome()).toMatchObject({
			state: "done",
			problem: "FSCK_TIMEOUT",
			fsck: { state: "timeout", detail: null },
			bundle: { state: "stored" },
			gc: { state: "skipped" },
			retired: 0,
		});
	});

	it("stops at a busy answer to any step, and at a job that yielded: nothing more runs, and the run finishes busy", async () => {
		const expected: Record<string, Partial<CodeCareOutcome> & Record<string, unknown>> = {
			check: { mainSha: null, refsSha256: null, fsck: { state: "skipped", detail: null }, worktrees: null },
			fsck: { mainSha: MAIN, refsSha256: null, fsck: { state: "skipped", detail: null } },
			bundle: { fsck: { state: "ok", detail: null }, bundle: expect.objectContaining({ state: "skipped" }) },
			gc: { bundle: expect.objectContaining({ state: "stored" }), gc: { state: "skipped" } },
			// The pack was saved, and nothing looked at it: the next run's fsck is due whatever the kernel kept.
			verify: {
				problem: "GC_NOT_VERIFIED",
				refsSha256: null,
				gc: { state: "collected" },
				fsck: { state: "timeout", detail: "GC_NOT_VERIFIED: the check after the pack did not finish" },
			},
			retire: { gc: { state: "collected" }, fsck: { state: "ok", detail: null }, retired: 0 },
			"retire-git": { gc: { state: "collected" }, retired: 0 },
		};
		const order = [...BEGIN_TO_BUNDLE, ...PACK, ...RETIRE];
		for (const [step, outcome] of Object.entries(expected)) {
			const t = setup();
			t.row.flags = { gc: true, retire: true };
			t.row.retire = [W1];
			t.kernel.stepAnswer = (asked) => (asked === step ? { schema: STEP, state: "busy" } : undefined);
			await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
			// Up to the step that answered busy, then the finish alone.
			expect([step, t.took()]).toEqual([step, [...order.slice(0, order.indexOf(`step:${step}`) + 1), "finish"]]);
			expect(t.row.outcomes).toHaveLength(1);
			expect([step, t.outcome()]).toEqual([
				step,
				expect.objectContaining({ state: "busy", problem: null, ...outcome }),
			]);
			expect(t.errors()).toEqual([]);
			// A bundle whose job never ran left no file behind.
			if (step === "bundle") expect(t.stored()).toEqual([]);
		}

		// A job cancelled because a turn's job joined the line: the same, from the job on.
		const jobs: [keyof CodeCareJobs, string, Record<string, unknown>][] = [
			["check", "job:check:deep", { mainSha: null }],
			["fsck", "job:fsck", { refsSha256: null }],
			["bundle", "job:bundle", { bundle: expect.objectContaining({ state: "skipped" }) }],
			// A job that yielded saved nothing: there is no pack to look at.
			["collect", "job:collect", { gc: { state: "skipped" }, fsck: { state: "ok", detail: null } }],
			["retire", "job:retire:files", { retired: 0 }],
		];
		for (const [job, entry, outcome] of jobs) {
			const t = setup();
			t.row.flags = { gc: true, retire: true };
			t.row.retire = [W1];
			t.jobs[job] = async () => {
				throw yielded();
			};
			await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
			expect([job, t.took()]).toEqual([job, [...order.slice(0, order.indexOf(entry) + 1), "finish"]]);
			expect([job, t.outcome()]).toEqual([
				job,
				expect.objectContaining({ state: "busy", problem: null, ...outcome }),
			]);
			expect(t.errors()).toEqual([]);
			if (job === "bundle") expect(t.stored()).toEqual([]);
		}
		// One that yields in the middle of its bundle leaves no part of it.
		const t = setup();
		t.jobs.bundle = async (_job, _value, sink) => {
			await sink.write(Buffer.from("half a bund"));
			throw yielded();
		};
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(t.stored()).toEqual([]);
		expect(t.outcome()).toMatchObject({ state: "busy", bundle: { state: "skipped" } });
	});

	it("starts nothing for a repository that is busy, not due or held by another run, and ends a run whose lease is lost", async () => {
		for (const [state, counts] of [
			["busy", { cared: 0, busy: 1, failed: 0 }],
			["not-due", { cared: 0, busy: 0, failed: 0 }],
			["lost", { cared: 0, busy: 0, failed: 0 }],
		] as const) {
			const t = setup();
			t.kernel.stepAnswer = () => ({ schema: STEP, state });
			await expect(t.pass()).resolves.toEqual(counts);
			expect(t.took()).toEqual(["step:begin"]);
			expect(t.runs).toEqual([]);
			expect(t.events).toEqual([
				{
					event: "code-care",
					step: "not-begun",
					companyId: COMPANY,
					environmentId: ENVIRONMENT,
					repository: "acme/app",
					state,
				},
			]);
		}
		// Care switched off, or the company's deletion asked for, while the run went on: put off, nothing more done.
		const off = setup();
		off.kernel.stepAnswer = (step) => (step === "fsck" ? { schema: STEP, state: "not-due" } : undefined);
		await expect(off.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(off.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "finish"]);
		expect(off.outcome()).toMatchObject({ state: "busy", problem: null, refsSha256: null });

		// The lease is gone: the finish is still asked, and the kernel's answer to it is reported.
		const lost = setup();
		lost.kernel.stepAnswer = (step) => (step === "fsck" ? { schema: STEP, state: "lost" } : undefined);
		lost.kernel.finishAnswer = () => ({ schema: FINISH, state: "lost" });
		await expect(lost.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(lost.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "finish"]);
		expect(lost.kernel.calls.at(-1)?.args.p_outcome).toMatchObject({ state: "failed", problem: "CARE_LEASE_LOST" });
		expect(lost.errors()).toEqual(["finish:CODE_CARE_FINISH_LOST"]);
		// An answer that is none: the job fails, as for a kernel that does not answer.
		for (const answer of [
			{ schema: "qorpera.code-care-step/v2", state: "go" },
			{ schema: STEP, state: "go", token: "not-the-run's" },
			{ schema: STEP, state: "go", token: randomUUID(), flags: { gc: false, retire: false }, last: {} },
			null,
		]) {
			const t = setup();
			t.kernel.stepAnswer = (step) => (step === "check" ? answer : undefined);
			await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
			expect(t.took()).toEqual(["step:begin", "step:check", "finish"]);
			expect(t.outcome()).toMatchObject({ state: "failed", problem: "CHECK_FAILED:CODE_CARE_STEP_UNCONFIRMED" });
		}
	});

	it("records a failed job and still finishes: the jobs that depend on it stop, the others and the other repositories go on", async () => {
		// The check failed: nothing else can run. The next repository is cared for all the same.
		const t = setup();
		t.kernel.due = [DUE, { ...DUE, name: "site" }];
		t.jobs.check = async (_job, value) => {
			if (value.repository.name === "app")
				throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", ["code/acme/app"]);
			return t.area.checked();
		};
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 1 });
		expect(t.took()).toEqual([
			...["step:begin", "step:check", "job:check:deep", "finish"],
			...BEGIN_TO_BUNDLE,
			"finish",
		]);
		expect(t.outcome()).toEqual({
			schema: "qorpera.code-care-outcome/v1",
			state: "failed",
			problem: "CHECK_FAILED:CODE_HOST_AREA_FROM_GITHUB",
			mainSha: null,
			refsSha256: null,
			repaired: null,
			deep: false,
			fsck: { state: "skipped", detail: null },
			bundle: { state: "skipped", name: null, sha256: null, bytes: null, refsSha256: null },
			gc: { state: "skipped" },
			worktrees: null,
			retired: 0,
		});
		expect(t.kernel.row("site").outcomes.at(-1)).toMatchObject({ state: "done", bundle: { state: "stored" } });
		expect(t.errors()).toEqual(["check:CODE_HOST_AREA_FROM_GITHUB: code/acme/app"]);
		expect(t.events.filter((event) => event.event === "code-care").map((event) => event.state)).toEqual([
			"failed",
			"done",
		]);

		// fsck failed: the bundle is still made, but the refs are not recorded as cared for, and nothing is packed or
		// retired. An error with no code of its own, and a kernel that does not answer the job's step, fail it the same.
		const failures: [string, (u: ReturnType<typeof setup>) => void][] = [
			[
				"FSCK_FAILED:CODE_HOST_FOLDER_UNAVAILABLE",
				(u) => {
					u.jobs.fsck = async () => {
						throw new CodeHostJobFailure(
							"CODE_HOST_FOLDER_UNAVAILABLE",
							"the folder program did not mount the view",
						);
					};
				},
			],
			[
				"FSCK_FAILED:UNCLASSIFIED",
				(u) => {
					u.jobs.fsck = async () => {
						throw new Error("something nobody named");
					};
				},
			],
			[
				"FSCK_FAILED:CODING_CONTROL_UNCONFIRMED",
				(u) => {
					u.kernel.stepAnswer = (step) => {
						if (step === "fsck") throw new Error("CODING_CONTROL_UNCONFIRMED");
						return undefined;
					};
				},
			],
		];
		for (const [problem, fail] of failures) {
			const u = setup();
			u.row.flags = { gc: true, retire: true };
			u.row.retire = [W1];
			fail(u);
			await expect(u.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
			expect([problem, u.took().filter((entry) => entry !== "job:fsck")]).toEqual([
				problem,
				["step:begin", "step:check", "job:check:deep", "step:fsck", "step:bundle", "job:bundle", "finish"],
			]);
			expect(u.outcome()).toMatchObject({
				state: "failed",
				problem,
				mainSha: MAIN,
				refsSha256: null,
				fsck: { state: "skipped", detail: null },
				bundle: { state: "stored" },
				gc: { state: "skipped" },
				retired: 0,
			});
			expect(u.errors()).toHaveLength(1);
		}

		// A step the kernel rolled back for a row another call holds is the company being busy, not a failure.
		const held = setup();
		held.kernel.stepAnswer = (step) => {
			if (step === "fsck") throw new CodingControlBusy();
			return undefined;
		};
		await expect(held.pass()).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(held.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "finish"]);
		expect(held.outcome()).toMatchObject({ state: "busy", problem: null, refsSha256: null });
		expect(held.errors()).toEqual([]);
	});

	it("stores a bundle only when its bytes are the ones the code host hashed, and records why one was not stored", async () => {
		const cases: [string, string | null, "done" | "failed", (t: ReturnType<typeof setup>) => void][] = [
			[
				"failed",
				"BUNDLE_FAILED:CODE_BUNDLE_DIFFERS",
				"failed",
				(t) => {
					const bundle = t.jobs.bundle;
					t.jobs.bundle = async (...args) => ({ ...(await bundle(...args)), sha256: digest("other bytes") });
				},
			],
			[
				"failed",
				"BUNDLE_FAILED:CODE_BUNDLE_DIFFERS",
				"failed",
				(t) => {
					const bundle = t.jobs.bundle;
					t.jobs.bundle = async (...args) => ({ ...(await bundle(...args)), bytes: t.area.bundle.length + 1 });
				},
			],
			[
				"failed",
				"BUNDLE_FAILED:CODE_CARE_BUNDLE_REFS_DIFFER",
				"failed",
				(t) => {
					const bundle = t.jobs.bundle;
					t.jobs.bundle = async (...args) => ({ ...(await bundle(...args)), refsSha256: "e".repeat(64) });
				},
			],
			[
				"failed",
				"BUNDLE_FAILED:CODE_HOST_BUNDLE_REFS_MOVED",
				"failed",
				(t) => {
					t.jobs.bundle = async () => {
						throw new CodeHostRefusal("CODE_HOST_BUNDLE_REFS_MOVED", ["refs/heads/main"]);
					};
				},
			],
			[
				"too-large",
				"BUNDLE_TOO_LARGE",
				"done",
				(t) => {
					t.jobs.bundle = async () => {
						throw new CodeHostRefusal("CODE_HOST_BUNDLE_TOO_LARGE", ["3221225472 bytes"]);
					};
				},
			],
		];
		for (const [state, problem, ended, arrange] of cases) {
			const t = setup();
			t.row.flags = { gc: true, retire: false };
			arrange(t);
			await expect(t.pass()).resolves.toEqual({
				cared: ended === "done" ? 1 : 0,
				busy: 0,
				failed: ended === "failed" ? 1 : 0,
			});
			// No pack without a stored bundle of the night's refs.
			expect([problem, t.took()]).toEqual([problem, [...BEGIN_TO_BUNDLE, "finish"]]);
			expect([problem, t.outcome()]).toEqual([
				problem,
				expect.objectContaining({
					state: ended,
					problem,
					refsSha256: t.area.fingerprint(),
					fsck: { state: "ok", detail: null },
					bundle: { state, name: null, sha256: null, bytes: null, refsSha256: null },
					gc: { state: "skipped" },
				}),
			]);
			expect(t.stored()).toEqual([]);
			expect(t.errors()).toHaveLength(1);
		}

		// More than the writer takes: the store's own cap, as the job's.
		const capped = setup({ bundleMaximumBytes: 20 });
		await expect(capped.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(capped.outcome()).toMatchObject({
			state: "done",
			problem: "BUNDLE_TOO_LARGE",
			bundle: { state: "too-large" },
		});
		expect(capped.seen.at(-1)?.args.at(-1)).toEqual({ maximumBytes: 20 });
		expect(capped.stored()).toEqual([]);

		// The storage is not mounted: no bundle job runs at all, and the night's other work is recorded.
		const unmounted = setup();
		unmounted.storage.mounted = false;
		await expect(unmounted.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(unmounted.took()).toEqual([
			"step:begin",
			"step:check",
			"job:check:deep",
			"step:fsck",
			"job:fsck",
			"finish",
		]);
		expect(unmounted.outcome()).toMatchObject({
			state: "failed",
			problem: "BUNDLE_FAILED:CODING_STORAGE_MOUNT_UNCONFIRMED",
			fsck: { state: "ok" },
			bundle: { state: "failed" },
		});
		expect(unmounted.errors()).toEqual([
			"deletions:CODING_STORAGE_MOUNT_UNCONFIRMED",
			"bundle:CODING_STORAGE_MOUNT_UNCONFIRMED",
		]);
		expect(existsSync(unmounted.root)).toBe(false);
		// Nor is the stored bundle of unchanged refs taken on trust while the storage is away.
		const away = setup();
		await away.pass();
		away.storage.mounted = false;
		away.clock.now += DAY;
		away.took();
		await expect(away.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(away.took()).toEqual(["step:begin", "step:check", "job:check", "finish"]);
		expect(away.outcome()).toMatchObject({
			state: "failed",
			problem: "BUNDLE_FAILED:CODING_STORAGE_MOUNT_UNCONFIRMED",
			bundle: { state: "failed" },
		});
	});

	it("keeps the newest 7 bundles of a repository, pruning only after a new one is stored", async () => {
		const t = setup();
		const names: string[] = [];
		for (let night = 0; night < 9; night++) {
			t.area.commit();
			await t.pass();
			names.push(t.outcome().bundle.name as string);
			t.clock.now += DAY;
		}
		expect(new Set(names).size).toBe(9);
		expect(t.stored()).toEqual(
			names
				.slice(2)
				.flatMap((name) => [`${name}.bundle`, `${name}.json`])
				.sort(),
		);
		// Nights without a new bundle remove nothing.
		await t.pass();
		await t.pass();
		expect(t.stored()).toHaveLength(14);
		expect(t.errors()).toEqual([]);
	});

	it("packs only what is safe to pack, and marks a repository the pack left damaged", async () => {
		/** What ran between the bundle and the retire. */
		const packed = (t: ReturnType<typeof setup>) => {
			const all = t.took();
			return all
				.slice(all.indexOf("job:bundle") + 1)
				.filter((entry) => entry !== "finish" && !RETIRE.includes(entry));
		};
		const gcOn = () => {
			const t = setup();
			t.row.flags = { gc: true, retire: true };
			t.row.retire = [W1];
			return t;
		};

		// A shallow repository has a problem of its own, whatever its flags, and is never packed. Its bundle is still
		// tried: git makes one that does not restore, the job's own proof fails it, and that is recorded as the bundle's
		// failure, not the run's.
		let t: ReturnType<typeof setup>;
		for (const gc of [true, false]) {
			t = gcOn();
			t.row.flags = { gc, retire: true };
			t.area.shallow = true;
			t.jobs.bundle = async () => {
				throw new CodeHostJobFailure("CODE_HOST_BUNDLE_FAILED", "the bundle does not restore every ref");
			};
			await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
			expect(packed(t)).toEqual([]);
			expect(t.outcome()).toMatchObject({
				state: "done",
				problem: "AREA_SHALLOW",
				refsSha256: t.area.fingerprint(),
				fsck: { state: "ok", detail: null },
				bundle: { state: "failed", name: null },
				gc: { state: gc ? "shallow" : "skipped" },
				retired: 1,
			});
			expect(t.errors()).toEqual(["bundle:CODE_HOST_BUNDLE_FAILED: the bundle does not restore every ref"]);
			expect(t.stored()).toEqual([]);
		}
		// Should its bundle pass the proof after all, it is stored like any other.
		t = gcOn();
		t.area.shallow = true;
		await t.pass();
		expect(packed(t)).toEqual([]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: "AREA_SHALLOW",
			bundle: { state: "stored" },
			gc: { state: "shallow" },
		});
		// The file came after the check: the pack's job refuses, having packed nothing.
		t = gcOn();
		t.jobs.collect = async () => {
			throw new CodeHostRefusal("CODE_HOST_GC_SHALLOW", ["code/acme/app/repo.git/shallow"]);
		};
		await t.pass();
		expect(packed(t)).toEqual(["step:gc", "job:check", "job:collect"]);
		expect(t.outcome()).toMatchObject({ state: "done", problem: "AREA_SHALLOW", gc: { state: "shallow" } });

		t = gcOn();
		t.area.objects.loose = 63;
		t.area.objects.packs = 7;
		await t.pass();
		expect(packed(t)).toEqual([]);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, gc: { state: "skipped" }, retired: 1 });

		t = gcOn();
		t.area.objects.loose = 0;
		t.area.objects.packs = 8;
		await t.pass();
		expect(packed(t)).toEqual(PACK);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, gc: { state: "collected" }, retired: 1 });

		t = gcOn();
		t.area.objects.loose = 0;
		await t.pass();
		expect(packed(t)).toEqual([]);
		expect(t.outcome()).toMatchObject({ state: "done", problem: null, gc: { state: "skipped" }, retired: 1 });

		// Leases still held, or another view's block: nothing was packed, so there is nothing to look at.
		for (const state of ["held", "busy"] as const) {
			t = gcOn();
			t.jobs.collect = async () => ({ state });
			await t.pass();
			expect(packed(t)).toEqual(["step:gc", "job:check", "job:collect"]);
			expect(t.outcome()).toMatchObject({ state: "done", problem: null, gc: { state: "held" }, retired: 1 });
		}

		// The pack failed, or its save's answer was lost: a new job still looks at what is there.
		t = gcOn();
		t.jobs.collect = async () => {
			throw new CodeHostJobFailure("CODE_HOST_PUBLISH_UNANSWERED", "the node did not answer the publish");
		};
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(packed(t)).toEqual(PACK);
		expect(t.outcome()).toMatchObject({
			state: "failed",
			problem: "GC_FAILED:CODE_HOST_PUBLISH_UNANSWERED",
			refsSha256: t.area.fingerprint(),
			fsck: { state: "ok", detail: null },
			gc: { state: "failed" },
			retired: 1,
		});

		// Damaged: fsck finds problems after the pack, or the repository is gone.
		const damage: ((u: ReturnType<typeof setup>) => void)[] = [
			(u) => {
				u.area.fsck = { state: "problems", exitCode: 2, detail: "missing tree" };
			},
			(u) => {
				u.area.present = false;
			},
		];
		for (const [index, harm] of damage.entries()) {
			t = gcOn();
			const before = t.area.fingerprint();
			const u = t;
			t.jobs.collect = async () => {
				harm(u);
				return { state: "collected" };
			};
			await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
			// Nothing is retired from a damaged repository.
			expect([index, t.took().slice(BEGIN_TO_BUNDLE.length)]).toEqual([
				index,
				[...PACK.slice(0, index === 1 ? 5 : 6), "finish"],
			]);
			expect(t.outcome()).toMatchObject({
				state: "done",
				problem: "GC_DAMAGED",
				refsSha256: before,
				fsck: index === 0 ? { state: "problems", detail: "missing tree" } : { state: "ok", detail: null },
				gc: { state: "damaged" },
				retired: 0,
			});
			expect(t.errors()).toEqual(["verify:GC_DAMAGED"]);
		}

		// The refs after the pack are not the ones packed (a pack moves no ref: other work came between its job and the
		// look at it). Not damaged, so packing stays on; not proven either, so the next run fscks first.
		t = gcOn();
		const moved = t;
		t.jobs.collect = async () => {
			moved.area.commit();
			return { state: "collected" };
		};
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took().slice(BEGIN_TO_BUNDLE.length)).toEqual([...PACK, "finish"]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: "GC_NOT_VERIFIED",
			refsSha256: null,
			fsck: { state: "timeout", detail: "GC_NOT_VERIFIED: the refs moved between the pack and the look at it" },
			gc: { state: "collected" },
			retired: 0,
		});
		expect(t.errors()).toEqual([]);
		t.jobs.collect = async () => ({ state: "collected" });
		t.area.objects.loose = 0;
		t.clock.now += DAY;
		await t.pass();
		expect(t.took().slice(0, 7)).toEqual(
			BEGIN_TO_BUNDLE.map((entry) => (entry === "job:check:deep" ? "job:check" : entry)),
		);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			fsck: { state: "ok" },
			bundle: { state: "stored" },
		});

		// A turn finished between the night's check and the pack, outside any job (here: while the stored copy of the
		// unchanged refs was read). The pack's job reads the refs again with the line held and packs nothing; nothing
		// is called damaged, and the next run checks, copies and packs the repository as it is then.
		t = setup();
		await t.pass();
		t.row.flags = { gc: true, retire: false };
		t.clock.now += DAY;
		t.took();
		const checkedRefs = t.area.fingerprint();
		const turned = t;
		t.kernel.stepAnswer = (step) => {
			if (step === "gc") turned.area.commit();
			return undefined;
		};
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "step:gc", "job:check", "finish"]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			refsSha256: checkedRefs,
			bundle: { state: "unchanged" },
			gc: { state: "skipped" },
		});
		expect(t.errors()).toEqual([]);
		t.kernel.stepAnswer = undefined;
		t.clock.now += DAY;
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual([
			"step:begin",
			"step:check",
			"job:check",
			"step:fsck",
			"job:fsck",
			"step:bundle",
			"job:bundle",
			...PACK,
			"finish",
		]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			refsSha256: t.area.fingerprint(),
			bundle: { state: "stored" },
			gc: { state: "collected" },
		});

		// The look after the pack did not finish (fsck ran out of time, or the job failed): not damaged, not proven. The
		// next run's fsck is due, whether the kernel keeps the refs it recorded or takes the outcome's none.
		for (const refsRule of ["clean-fsck", "as-given"] as const) {
			for (const fail of [false, true]) {
				t = gcOn();
				t.kernel.refsRule = refsRule;
				// A first night with the pack off records the refs and a clean fsck.
				t.row.flags = { gc: false, retire: false };
				await t.pass();
				t.row.flags = { gc: true, retire: true };
				t.clock.now += DAY;
				t.took();
				const u = t;
				const fsck = t.jobs.fsck;
				t.jobs.collect = async () => {
					if (fail)
						u.jobs.fsck = async () => {
							throw new CodeHostJobFailure("CODE_HOST_FOLDER_UNAVAILABLE");
						};
					else u.area.fsck = { state: "timeout", exitCode: null, detail: "" };
					return { state: "collected" };
				};
				await expect(t.pass()).resolves.toEqual({ cared: fail ? 0 : 1, busy: 0, failed: fail ? 1 : 0 });
				expect(t.took()).toEqual(["step:begin", "step:check", "job:check", ...PACK, "finish"]);
				expect(t.outcome()).toMatchObject({
					state: fail ? "failed" : "done",
					problem: "GC_NOT_VERIFIED",
					refsSha256: null,
					fsck: fail
						? { state: "timeout", detail: "GC_NOT_VERIFIED: the check after the pack did not finish" }
						: { state: "timeout", detail: null },
					bundle: { state: "unchanged" },
					gc: { state: "collected" },
					retired: 0,
				});
				t.jobs.fsck = fsck;
				t.area.fsck = { state: "ok", exitCode: 0, detail: "" };
				t.jobs.collect = async () => ({ state: "collected" });
				t.area.objects.loose = 0;
				t.clock.now += 3_600_000;
				await t.pass();
				expect([refsRule, fail, t.took().slice(0, 5)]).toEqual([
					refsRule,
					fail,
					["step:begin", "step:check", "job:check", "step:fsck", "job:fsck"],
				]);
				expect(t.outcome()).toMatchObject({ state: "done", problem: null, fsck: { state: "ok" } });
			}
		}

		// The copy behind a pack was stored on an earlier night: it is read whole first, and one that is spoiled is made
		// again before anything is packed.
		t = setup();
		await t.pass();
		t.row.flags = { gc: true, retire: false };
		t.clock.now += DAY;
		t.took();
		await t.pass();
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", ...PACK, "finish"]);
		expect(t.outcome()).toMatchObject({ problem: null, bundle: { state: "unchanged" }, gc: { state: "collected" } });
		t = setup();
		await t.pass();
		const name = t.outcome().bundle.name as string;
		// The same size, other bytes.
		writeFileSync(join(t.folder, `${name}.bundle`), Buffer.alloc(t.area.bundle.length, 0x2e));
		t.row.flags = { gc: true, retire: false };
		t.clock.now += DAY;
		t.took();
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual([
			"step:begin",
			"step:check",
			"job:check",
			"step:bundle",
			"job:bundle",
			...PACK,
			"finish",
		]);
		expect(t.errors()).toEqual(["bundle:CODE_BUNDLE_DIFFERS"]);
		expect(t.outcome()).toMatchObject({
			state: "done",
			problem: null,
			bundle: { state: "stored", sha256: digest(t.area.bundle) },
			gc: { state: "collected" },
		});
		// A store that cannot be read is no copy either: nothing is packed.
		t = setup();
		await t.pass();
		t.row.flags = { gc: true, retire: false };
		t.storage.mounted = false;
		t.clock.now += DAY;
		t.took();
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check", "finish"]);
		expect(t.outcome()).toMatchObject({ state: "failed", bundle: { state: "failed" }, gc: { state: "skipped" } });
	});

	it("records a repository that is not there: nothing to care for when it never was, a problem when care saw it before", async () => {
		const t = setup();
		t.area.present = false;
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check:deep", "finish"]);
		expect(t.outcome()).toEqual({
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
		});
		const gone = setup();
		await gone.pass();
		gone.area.present = false;
		gone.clock.now += DAY;
		await expect(gone.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(gone.outcome()).toMatchObject({ state: "done", problem: "AREA_ABSENT", mainSha: null });
		// A check that repaired main/ says what it repaired; an answer that is no check's fails the job.
		const repaired = setup();
		repaired.area.repaired = "files";
		await repaired.pass();
		expect(repaired.outcome()).toMatchObject({ state: "done", problem: null, repaired: "files" });
		const odd = setup();
		odd.jobs.check = async () => ({ ...odd.area.checked(), refsSha256: "short" }) as CodeAreaChecked;
		await expect(odd.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 1 });
		expect(odd.outcome()).toMatchObject({ state: "failed", problem: "CHECK_FAILED:CODE_CARE_ANSWER_INVALID" });
	});

	it("removes the bundle folders of companies being deleted, and no other", async () => {
		const t = setup();
		t.kernel.due = [DUE, { ...DUE, companyId: OTHER, name: "site" }];
		await expect(t.pass()).resolves.toEqual({ cared: 2, busy: 0, failed: 0 });
		expect(readdirSync(t.root).sort()).toEqual([COMPANY, OTHER]);
		// The first pass found no folder to ask about.
		expect(t.kernel.calls.filter((call) => call.method === "qorpera_code_hosts_deleting")).toEqual([]);

		t.kernel.due = [];
		t.kernel.deleting = [OTHER];
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 0 });
		expect(t.kernel.calls.filter((call) => call.method === "qorpera_code_hosts_deleting")).toEqual([
			{
				method: "qorpera_code_hosts_deleting",
				args: { p_owner: OWNER, p_machine_id_sha256: MACHINE, p_company_ids: [COMPANY, OTHER] },
			},
		]);
		expect(readdirSync(t.root)).toEqual([COMPANY]);
		expect(t.stored()).toHaveLength(2);
		expect(t.events.at(-1)).toEqual({ event: "code-care", step: "bundles-removed", companyId: OTHER });

		// An answer that is no list of the companies asked about removes nothing, and the pass goes on to its repositories.
		t.kernel.deleting = { deleting: [COMPANY] };
		t.kernel.due = [DUE];
		t.clock.now += DAY;
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(readdirSync(t.root)).toEqual([COMPANY]);
		expect(t.errors()).toEqual(["deletions:CODE_HOST_DELETIONS_UNCONFIRMED"]);
	});

	it("takes the repositories the kernel says are due, a few a pass, and reports an answer that is none", async () => {
		const t = setup({ limit: 3 });
		t.kernel.due = [{ ...DUE, companyId: "company" }, { ...DUE, owner: "Acme" }, { ...DUE, name: "../app" }, DUE];
		// The first three are no repository kept here; only as many as the pass asked for are looked at.
		await expect(t.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 0 });
		expect(t.kernel.calls[0]).toEqual({
			method: "qorpera_code_care_due",
			args: { p_owner: OWNER, p_machine_id_sha256: MACHINE, p_limit: 3 },
		});
		expect(t.errors()).toEqual(Array.from({ length: 3 }, () => "due:CODE_CARE_DUE_UNCONFIRMED"));
		t.kernel.due = [{ ...DUE, companyId: "company" }, DUE];
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });

		for (const answer of [
			() => ({ schema: "qorpera.code-care-due/v2", repositories: [DUE] }),
			() => ({ schema: "qorpera.code-care-due/v1", repositories: DUE }),
			() => null,
			() => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			},
		]) {
			const u = setup();
			u.kernel.dueAnswer = answer;
			await expect(u.pass()).resolves.toEqual({ cared: 0, busy: 0, failed: 0 });
			expect(u.took()).toEqual([]);
			expect(u.errors()).toHaveLength(1);
			expect(u.errors()[0]).toMatch(/^due:(CODE_CARE_DUE_UNCONFIRMED|CODING_CONTROL_UNCONFIRMED)$/);
		}
		// A begin the kernel does not answer starts no run; the next repository is still tried.
		const u = setup();
		u.kernel.due = [DUE, { ...DUE, name: "site" }];
		u.kernel.stepAnswer = (step, row) => {
			if (step === "begin" && row === u.kernel.row("app")) throw new Error("CODING_CONTROL_UNCONFIRMED");
			return undefined;
		};
		await expect(u.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 1 });
		expect(u.errors()).toEqual(["begin:CODING_CONTROL_UNCONFIRMED"]);

		for (const options of [
			{ limit: 0 },
			{ limit: 51 },
			{ limit: 1.5 },
			{ owner: "" },
			{ machineIdSha256: "d".repeat(63) },
			{ bundleMaximumBytes: 0 },
			{ fsckMs: 0 },
		])
			expect(() => setup(options)).toThrow("INVALID_CODE_HOST_CARE");
		// The bound on an fsck reaches the job.
		const bounded = setup({ fsckMs: 90_000 });
		await bounded.pass();
		expect(bounded.seen[1]).toEqual({ job: "fsck", args: [{ repository: REPOSITORY }, { maximumMs: 90_000 }] });
	});

	it("asks a finish the kernel did not answer once more, and reports one it could not record", async () => {
		const t = setup();
		let answers = 0;
		t.kernel.finishAnswer = () => {
			if (answers++ === 0) throw new Error("CODING_CONTROL_UNCONFIRMED");
			return undefined;
		};
		await expect(t.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(t.took().slice(-2)).toEqual(["finish", "finish"]);
		expect(t.errors()).toEqual([]);
		expect(t.events.at(-1)).toMatchObject({ step: "cared", state: "done", nextCareAt: NEXT });

		for (const answer of [
			() => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			},
			() => ({ schema: FINISH, state: "recorded" }),
			() => ({ schema: "qorpera.code-care-finish/v2", state: "recorded", nextCareAt: NEXT }),
		]) {
			const u = setup();
			u.kernel.finishAnswer = answer;
			// The run itself went well: it is counted as it ended, and the lost record is reported.
			await expect(u.pass()).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
			expect(u.took().slice(-2)).toEqual(["finish", "finish"]);
			expect(u.errors()).toHaveLength(1);
			expect(u.errors()[0]).toMatch(/^finish:(CODING_CONTROL_UNCONFIRMED|CODE_CARE_FINISH_UNCONFIRMED)$/);
			expect(u.events.at(-1)).toMatchObject({ step: "cared", state: "done", nextCareAt: null });
		}
	});

	it("ends the run it is in as busy when the pass is stopped, with a finish of its own, and starts no other", async () => {
		const t = setup();
		t.kernel.due = [DUE, { ...DUE, name: "site" }];
		const controller = new AbortController();
		const reason = new Error("CODING_EXECUTOR_SHUTDOWN");
		t.jobs.fsck = async (job) => {
			controller.abort(reason);
			job.signal.throwIfAborted();
			return t.area.fsck;
		};
		await expect(t.care.pass(controller.signal)).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(t.took()).toEqual(["step:begin", "step:check", "job:check:deep", "step:fsck", "job:fsck", "finish"]);
		expect(t.outcome()).toMatchObject({ state: "busy", problem: null, mainSha: MAIN, refsSha256: null });
		expect(t.kernel.rows.has("site")).toBe(false);
		expect(t.errors()).toEqual([]);
		// A pass stopped before it began does nothing.
		const u = setup();
		await expect(u.care.pass(controller.signal)).resolves.toEqual({ cared: 0, busy: 0, failed: 0 });
		expect(u.kernel.calls).toEqual([]);
		expect(u.events).toEqual([]);

		// Stopped while the pack's save may have gone through: it could not be looked at, and the record says so.
		const packing = setup();
		packing.row.flags = { gc: true, retire: true };
		packing.row.retire = [W1];
		const stopped = new AbortController();
		packing.jobs.collect = async (job) => {
			stopped.abort(reason);
			job.signal.throwIfAborted();
			return { state: "collected" };
		};
		await expect(packing.care.pass(stopped.signal)).resolves.toEqual({ cared: 0, busy: 1, failed: 0 });
		expect(packing.took()).toEqual([...BEGIN_TO_BUNDLE, "step:gc", "job:check", "job:collect", "finish"]);
		expect(packing.outcome()).toMatchObject({
			state: "busy",
			problem: "GC_NOT_VERIFIED",
			refsSha256: null,
			fsck: { state: "timeout" },
			gc: { state: "failed" },
			retired: 0,
		});
	});

	it("hangs nothing off the signal its passes are given, which may last as long as the process (abort-scope.ts)", async () => {
		const t = setup();
		t.row.flags = { gc: true, retire: true };
		t.row.retire = [W1];
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await expect(t.care.pass(lasting.signal)).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
			t.clock.now += DAY;
			await expect(t.care.pass(lasting.signal)).resolves.toEqual({ cared: 1, busy: 0, failed: 0 });
			// The passes made signals of their own for their calls and the store's uses, none of them on the lasting one.
			expect(watch.made()).toBeGreaterThan(10);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});
});
