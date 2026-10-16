import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { CODE_HOST_EXPORT_MAXIMUM_BYTES, CodeHostRepositories } from "../src/code-host-repositories.ts";
import type { CodeAreaBroker } from "../src/code-host-seed.ts";
import type { CodeHostJobs, CodeHostSession } from "../src/code-host-views.ts";
import type { CodingSessionClaim } from "../src/coding-executor.ts";
import type { CodingFolderRepositorySession } from "../src/coding-folder-repositories.ts";
import type { CodingBrokerGitRunner } from "../src/coding-git.ts";
import type { LxdCodingMachineBinding } from "../src/coding-machine.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const WORKER = "44444444-4444-4444-8444-444444444444";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const REPOSITORY: CloudCodingRepository = { host: "github.com", owner: "acme", name: "app", baseBranch: "main" };
const signal = () => new AbortController().signal;

const claim: CodingSessionClaim = {
	workerId: WORKER,
	leaseToken: "lease-token",
	leaseUntil: "2026-10-16T12:00:00.000Z",
	sequence: 1,
	profileId: COMPANY,
	environmentId: ENVIRONMENT,
	agentId: "55555555-5555-4555-8555-555555555555",
	ownerUserId: "66666666-6666-4666-8666-666666666666",
	harness: "claude-code",
	model: null,
	repository: REPOSITORY,
	branch: `qorpera/coding/${WORKER}`,
	baseSha: BASE,
	harnessSessionRef: null,
	pullRequest: null,
	title: "Fix the build",
	goal: "The build passes.",
	definitionOfDone: "CI is green.",
	context: "",
	followUp: null,
};

type Attach = CodeHostJobs["attach"];
type Export = CodeHostJobs["export"];

function setUp(answers: { attach?: Attach; export?: Export } = {}) {
	const authorized = vi.fn(async (_signal: AbortSignal) => undefined);
	const lent = vi.fn();
	const runGit = vi.fn() as unknown as CodingBrokerGitRunner;
	const session: CodingFolderRepositorySession = {
		claim,
		machine: { machineId: "machine" } as LxdCodingMachineBinding,
		uid: 1000,
		baseSha: BASE,
		journalRoot: "/var/lib/qorpera-coding/git",
		assertAuthorized: authorized,
		async withRepositoryToken(repository, use) {
			lent(repository);
			return await use("token");
		},
		runGit,
	};
	const attach = vi.fn<Attach>(
		answers.attach ?? (async () => ({ seeded: "seeded", state: "added", headSha: BASE, restored: [] })),
	);
	const exportBranch = vi.fn<Export>(
		answers.export ?? (async ({ headSha }) => ({ headSha, bundle: Buffer.from("x") })),
	);
	const repositories = new CodeHostRepositories({ attach, export: exportBranch });
	return { session, repositories, attach, exportBranch, authorized, lent, runGit };
}

const expectedSession: CodeHostSession = {
	companyId: COMPANY,
	environmentId: ENVIRONMENT,
	repository: REPOSITORY,
	workerId: WORKER,
	baseSha: BASE,
};

describe("CodeHostRepositories", () => {
	it("attaches the session to its company's code area and gives the machine its worktree", async () => {
		const { session, repositories, attach, runGit } = setUp();
		const aborted = signal();
		await expect(repositories.prepare(session, aborted)).resolves.toEqual({
			cwd: `/company/code/acme/app/worktrees/${WORKER}`,
		});
		expect(attach).toHaveBeenCalledTimes(1);
		const [value, broker, given] = attach.mock.calls[0] as [CodeHostSession, CodeAreaBroker, AbortSignal];
		expect(value).toEqual(expectedSession);
		expect(given).toBe(aborted);
		expect(broker.journalRoot).toBe("/var/lib/qorpera-coding/git");
		expect(broker.runGit).toBe(runGit);
	});

	it("gives every spelling of a repository the one lower-case code area, and GitHub the claimed spelling", async () => {
		const { session, repositories, attach, lent } = setUp();
		const repository = { ...REPOSITORY, owner: "Acme", name: "App" };
		const spelled = { ...session, claim: { ...claim, repository } };
		await expect(repositories.prepare(spelled, signal())).resolves.toEqual({
			cwd: `/company/code/acme/app/worktrees/${WORKER}`,
		});
		const [value, broker] = attach.mock.calls[0] as [CodeHostSession, CodeAreaBroker, AbortSignal];
		expect(value.repository).toEqual(repository);
		await broker.withRepositoryToken({ ...repository }, async () => undefined, signal());
		expect(lent).toHaveBeenCalledWith(repository);
		await expect(broker.withRepositoryToken(REPOSITORY, async () => undefined, signal())).rejects.toThrow(
			"CODE_HOST_REPOSITORY_DIFFERS",
		);
	});

	it("lends the broker the session's authority and token for the claimed repository only", async () => {
		const { session, repositories, attach, authorized, lent } = setUp();
		await repositories.prepare(session, signal());
		const broker = attach.mock.calls[0]?.[1] as CodeAreaBroker;
		const checked = signal();
		await broker.assertAuthorized({ ...REPOSITORY }, checked);
		expect(authorized).toHaveBeenCalledTimes(1);
		expect(authorized.mock.calls[0]?.[0]).toBe(checked);
		await expect(
			broker.withRepositoryToken({ ...REPOSITORY }, async (token) => `used ${token}`, signal()),
		).resolves.toBe("used token");
		expect(lent).toHaveBeenCalledWith(REPOSITORY);
		for (const other of [
			{ ...REPOSITORY, owner: "other" },
			{ ...REPOSITORY, name: "other" },
			{ ...REPOSITORY, baseBranch: "release" },
		]) {
			await expect(broker.assertAuthorized(other, signal())).rejects.toThrow("CODE_HOST_REPOSITORY_DIFFERS");
			await expect(broker.withRepositoryToken(other, async () => "used", signal())).rejects.toThrow(
				"CODE_HOST_REPOSITORY_DIFFERS",
			);
		}
		expect(authorized).toHaveBeenCalledTimes(1);
		expect(lent).toHaveBeenCalledTimes(1);
	});

	it("gives no worktree when the attach fails", async () => {
		const { session, repositories } = setUp({
			attach: async () => {
				throw new Error("CODE_HOST_SEED_BASE_GONE");
			},
		});
		await expect(repositories.prepare(session, signal())).rejects.toThrow("CODE_HOST_SEED_BASE_GONE");
	});

	it("exports the submitted commit under the NAS path's cap", async () => {
		const { session, repositories, exportBranch } = setUp();
		const aborted = signal();
		await expect(repositories.export(session, HEAD, aborted)).resolves.toEqual(Buffer.from("x"));
		expect(exportBranch).toHaveBeenCalledWith(
			{ ...expectedSession, headSha: HEAD },
			{ maximumBytes: 64 * 1024 ** 2 },
			aborted,
		);
		expect(CODE_HOST_EXPORT_MAXIMUM_BYTES).toBe(64 * 1024 ** 2);
	});

	it("exports nothing for a branch still at its base", async () => {
		const { session, repositories } = setUp({ export: async ({ headSha }) => ({ headSha, bundle: null }) });
		await expect(repositories.export(session, BASE, signal())).resolves.toBeNull();
	});

	it("refuses an export that is not exactly the submitted commit", async () => {
		const cases: { headSha: string; answer: Awaited<ReturnType<Export>> }[] = [
			{ headSha: HEAD, answer: { headSha: "c".repeat(40), bundle: Buffer.from("x") } },
			{ headSha: HEAD, answer: { headSha: HEAD, bundle: null } },
			{ headSha: BASE, answer: { headSha: BASE, bundle: Buffer.from("x") } },
		];
		for (const { headSha, answer } of cases) {
			const { session, repositories } = setUp({ export: async () => answer });
			await expect(repositories.export(session, headSha, signal())).rejects.toThrow("CODE_HOST_EXPORT_DIFFERS");
		}
	});
});
