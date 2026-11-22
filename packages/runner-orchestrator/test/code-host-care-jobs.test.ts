// OPTIONAL, for the merged tree (Parts B and C together): nightly care with the real code host jobs on a local disk.
// It passed on node 2 in Part C's worktree against a private copy of Part B's code-host-jobs.ts at 362fb0890
// (run 20261110T133714-62037-2cb2f6fb; the copy was removed again, nothing of it is committed). To keep it, save it as
// packages/runner-orchestrator/test/code-host-care-jobs.test.ts once code-host-jobs.ts is Part B's.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_BUNDLE_FOLDER, createCodeBundleStore } from "../src/code-bundle-store.ts";
import { type CodeCareJobs, type CodeCareOutcome, CodeHostCare } from "../src/code-host-care.ts";
import {
	addCodeWorktree,
	bundleCodeArea,
	type CodeHostCommand,
	type CodeHostGcBlock,
	type CodeHostJob,
	checkCodeArea,
	collectCodeGarbage,
	fsckCodeArea,
	retireCodeWorktrees,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import type { CodeHostJobs } from "../src/code-host-views.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile);
const GIT = "/usr/bin/git";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodeHostCare with the code host's own jobs", () => {
	it("checks, fscks, bundles, packs and retires a repository on a local disk, and the bundle restores", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "code-host-care-jobs-")));
		roots.push(root);
		const companyRoot = join(root, "folder"),
			scratchRoot = join(root, "scratch"),
			controlRoot = join(root, "control");
		for (const dir of [companyRoot, scratchRoot, controlRoot]) await mkdir(dir);
		const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
		const commands: CodeHostCommand[] = [];
		const jobOf = (signal = new AbortController().signal): CodeHostJob => ({
			shell: localShell(commands),
			layout: { companyRoot, scratchRoot, git: GIT },
			signal,
		});
		const repository = { host: "qorpera" as const, owner: "acme", name: "app", baseBranch: "main" };
		const started = await startCodeArea(jobOf(), { repository });
		// A session's worktree with one commit of its own.
		const worker = randomUUID();
		await addCodeWorktree(jobOf(), { repository, workerId: worker, baseSha: started.baseSha });
		const code = join(companyRoot, "code/acme/app"),
			tree = join(code, "worktrees", worker);
		await writeFile(join(tree, "hello.txt"), "hello\n");
		await git(tree, "add", "--all");
		await git(
			tree,
			"-c",
			"user.name=Session",
			"-c",
			"user.email=s@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"work",
		);
		const head = await git(tree, "rev-parse", "HEAD");

		const block: CodeHostGcBlock = {
			begin: async () => ({ state: "blocking", held: 0 }),
			end: async () => undefined,
		};
		const hosts: Pick<CodeHostJobs, "run"> = {
			run: async (_companyId, _environmentId, signal, job) => job(jobOf(signal), block),
		};
		// The real functions, as the executor wires them: no adapter.
		const jobs: CodeCareJobs = {
			check: checkCodeArea,
			fsck: fsckCodeArea,
			bundle: bundleCodeArea,
			collect: collectCodeGarbage,
			retire: retireCodeWorktrees,
		};
		const clock = { now: Date.UTC(2026, 10, 11, 2, 0, 0) };
		// The kernel's registry row, with a finish that writes as the migration does.
		const row = {
			token: null as string | null,
			flags: { gc: false, retire: false },
			last: {
				refsSha256: null as string | null,
				fsckState: null as string | null,
				fsckAt: null as string | null,
				bundleRefsSha256: null as string | null,
				bundleName: null as string | null,
				deepAt: null as string | null,
			},
			retire: [] as string[],
			outcomes: [] as CodeCareOutcome[],
			steps: [] as string[],
		};
		const control = {
			async call(method: string, args: Record<string, unknown>): Promise<unknown> {
				if (method === "qorpera_code_care_due")
					return {
						schema: "qorpera.code-care-due/v1",
						repositories: [{ companyId: COMPANY, environmentId: ENVIRONMENT, owner: "acme", name: "app" }],
					};
				if (method === "qorpera_code_hosts_deleting") return [];
				if (method === "qorpera_code_care_step") {
					const step = args.p_step as string;
					row.steps.push(step);
					if (step === "begin") row.token = randomUUID();
					return {
						schema: "qorpera.code-care-step/v1",
						state: "go",
						token: row.token,
						leaseUntil: new Date(clock.now + 2 * 3_600_000).toISOString(),
						flags: row.flags,
						last: row.last,
						...(step === "retire" ? { retire: row.retire } : {}),
					};
				}
				const outcome = structuredClone(args.p_outcome) as CodeCareOutcome;
				row.outcomes.push(outcome);
				const at = new Date(clock.now).toISOString();
				if (outcome.fsck.state === "ok" && outcome.refsSha256) row.last.refsSha256 = outcome.refsSha256;
				if (outcome.fsck.state !== "skipped") {
					row.last.fsckState = outcome.fsck.state;
					row.last.fsckAt = at;
				}
				if (outcome.bundle.state === "stored") {
					row.last.bundleRefsSha256 = outcome.bundle.refsSha256;
					row.last.bundleName = outcome.bundle.name;
				}
				if (outcome.deep) row.last.deepAt = at;
				return { schema: "qorpera.code-care-finish/v1", state: "recorded", nextCareAt: "2026-11-12T02:00:00.000Z" };
			},
		};
		const events: Record<string, unknown>[] = [];
		const care = new CodeHostCare({
			control,
			hosts,
			jobs,
			bundles: createCodeBundleStore({ root: join(controlRoot, CODE_BUNDLE_FOLDER) }),
			owner: "coding-node-1",
			machineIdSha256: "d".repeat(64),
			report: (event) => events.push(event),
			now: () => clock.now,
			gcLooseThreshold: 1,
		});
		const pass = async () => {
			row.steps.length = 0;
			const counts = await care.pass(new AbortController().signal);
			return { counts, steps: [...row.steps], outcome: row.outcomes.at(-1) as CodeCareOutcome };
		};
		const errors = () =>
			events.filter((event) => event.event === "code-care-error").map((event) => String(event.error));

		// Night 1, both flags off: check, fsck, and the bundle on the storage.
		const first = await pass();
		expect(errors()).toEqual([]);
		expect(first.counts).toEqual({ cared: 1, busy: 0, failed: 0 });
		expect(first.steps).toEqual(["begin", "check", "fsck", "bundle"]);
		expect(first.outcome).toMatchObject({
			state: "done",
			problem: null,
			mainSha: started.baseSha,
			repaired: "none",
			deep: true,
			fsck: { state: "ok", detail: null },
			bundle: { state: "stored" },
			gc: { state: "skipped" },
			worktrees: 1,
			retired: 0,
		});
		const folder = join(controlRoot, CODE_BUNDLE_FOLDER, COMPANY, "acme", "app");
		const name = first.outcome.bundle.name as string;
		expect(readdirSync(folder).sort()).toEqual([`${name}.bundle`, `${name}.json`]);
		// The stored bundle restores as a plain repository with every ref: main, the session's branch and the mark.
		const restored = join(root, "restored.git");
		await git(root, "clone", "--quiet", "--mirror", join(folder, `${name}.bundle`), restored);
		await git(restored, "fsck", "--full", "--strict");
		expect((await git(restored, "for-each-ref", "--format=%(refname) %(objectname)")).split("\n").sort()).toEqual(
			[
				`refs/heads/main ${started.baseSha}`,
				`refs/heads/qorpera/coding/${worker} ${head}`,
				`refs/qorpera/kept-here ${started.baseSha}`,
			].sort(),
		);

		// Night 2, nothing changed: the check alone.
		clock.now += DAY;
		const second = await pass();
		expect(second.steps).toEqual(["begin", "check"]);
		expect(second.outcome).toMatchObject({ state: "done", problem: null, bundle: { state: "unchanged" } });

		// Night 3, both flags on: the pack, the look after it, and the session's worktree retired (its folder holds
		// exactly its branch's head). The branch stays.
		clock.now += DAY;
		row.flags = { gc: true, retire: true };
		row.retire = [worker];
		const third = await pass();
		expect(errors()).toEqual([]);
		expect(third.steps).toEqual(["begin", "check", "gc", "verify", "retire", "retire-git"]);
		expect(third.outcome).toMatchObject({
			state: "done",
			problem: null,
			fsck: { state: "ok" },
			bundle: { state: "unchanged" },
			gc: { state: "collected" },
			worktrees: 0,
			retired: 1,
		});
		expect(existsSync(tree)).toBe(false);
		expect(existsSync(join(code, "repo.git/worktrees", worker))).toBe(false);
		expect(await git(join(code, "repo.git"), "rev-parse", `refs/heads/qorpera/coding/${worker}`)).toBe(head);
		// A follow-up gets its worktree back from the branch.
		await expect(
			addCodeWorktree(jobOf(), { repository, workerId: worker, baseSha: started.baseSha }),
		).resolves.toMatchObject({ state: "added", headSha: head });

		// A `shallow` file: the repository's problem, and no pack. (Here every commit is still behind a ref, so the bundle
		// restores and is stored; with history really cut, the job's proof fails it and the outcome says bundle "failed".)
		await writeFile(join(code, "repo.git/shallow"), `${head}\n`);
		await writeFile(join(tree, "more.txt"), "more\n");
		await git(tree, "add", "--all");
		await git(
			tree,
			"-c",
			"user.name=Session",
			"-c",
			"user.email=s@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"more",
		);
		row.retire = [];
		clock.now += DAY;
		const shallow = await pass();
		expect(shallow.steps).toEqual(["begin", "check", "fsck", "bundle", "retire"]);
		expect(shallow.outcome).toMatchObject({ state: "done", problem: "AREA_SHALLOW", gc: { state: "shallow" } });
	});
});
