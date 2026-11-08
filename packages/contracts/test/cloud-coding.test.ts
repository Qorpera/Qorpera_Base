import { describe, expect, it } from "vitest";
import {
	CLOUD_CODING_WORKER_STATES,
	type CloudCodingDispatch,
	type CloudCodingWorker,
	parseCloudCodingBranch,
	parseCloudCodingDispatch,
	parseCloudCodingFollowup,
	parseCloudCodingPullRequest,
	parseCloudCodingRepository,
	parseCloudCodingWorker,
	parseGitHubCodingRepository,
} from "../src/cloud-coding.ts";

const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
const repository = () => ({ host: "github.com" as const, owner: "Qorpera", name: "app", baseBranch: "main" });
const dispatch = (): CloudCodingDispatch => ({
	operationKey: "build:one",
	repository: repository(),
	goal: "Build the requested feature",
	definitionOfDone: "Checks pass and a draft PR is published",
	context: "Bounded source context",
	sourceReadIds: [id(10)],
	todoPath: "projects/app/todos/feature.json",
	cancellationPolicy: "retain-workspace",
	completionPolicy: "notify-parent",
	publication: "draft-pr",
});
const worker = (): CloudCodingWorker => ({
	schema: "qorpera.coding-worker/v1",
	id: id(1),
	companyId: id(2),
	parentAgentId: id(3),
	parentRunId: id(4),
	repository: repository(),
	branch: `qorpera/${id(1)}`,
	vmId: id(5),
	version: 2,
	state: "running",
	turn: 1,
	pullRequest: { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha: "a".repeat(40) },
});

describe("cloud coding dispatch contract", () => {
	it("copies and freezes the complete bounded dispatch", () => {
		const input = dispatch();
		const result = parseCloudCodingDispatch(input);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
		expect(result.repository).not.toBe(input.repository);
		expect(result.sourceReadIds).not.toBe(input.sourceReadIds);
		expect(Object.isFrozen(result.repository)).toBe(true);
		expect(Object.isFrozen(result.sourceReadIds)).toBe(true);
		expect(parseCloudCodingDispatch({ ...input, context: "", sourceReadIds: [] }).sourceReadIds).toEqual([]);
	});
	it.each([
		["undeclared capability", { tools: ["shell"] }],
		["foreign cancellation policy", { cancellationPolicy: "delete-workspace" }],
		["human communication", { completionPolicy: "notify-human" }],
		["unguarded publication", { publication: "merge" }],
		["duplicate reads", { sourceReadIds: [id(10), id(10)] }],
		["invalid read", { sourceReadIds: ["opaque"] }],
		["too many reads", { sourceReadIds: Array.from({ length: 65 }, (_, n) => id(n)) }],
		["empty goal", { goal: " " }],
		["byte bound", { context: "界".repeat(10923) }],
		["NUL context", { context: "source\0suffix" }],
		["lone surrogate context", { context: "source\ud800suffix" }],
		["oversized operation key", { operationKey: "a".repeat(193) }],
	])("rejects %s", (_label, change) => {
		expect(() => parseCloudCodingDispatch({ ...dispatch(), ...change })).toThrow();
	});
	it.each([
		"/projects/task.json",
		"projects/../task.json",
		"projects//task.json",
		"projects/task.json/",
		"projects\\task.json",
		"projects/%2e%2e/task.json",
		"projects/CON.json",
		"projects/task. ",
		"projects/task\n.json",
		"projects/e\u0301.json",
		"projects/．．/task.json",
		"projects/ａ／b.json",
	])("rejects noncanonical Company File path %s", (todoPath) => {
		expect(() => parseCloudCodingDispatch({ ...dispatch(), todoPath })).toThrow();
	});
});

describe("coding repository and branch destinations", () => {
	it.each(["main", "release/2026.09", "qorpera/worker-1"])("accepts safe Git ref %s", (branch) => {
		expect(parseCloudCodingBranch(branch)).toBe(branch);
	});
	it.each([
		"-main",
		"main..other",
		"main^",
		"main~1",
		"@",
		"main@{1}",
		"refs//head",
		"x/.hidden",
		"x.lock",
		"x.lock/head",
		"x.",
		"x/",
		"x:y",
		"x\ny",
		"a".repeat(201),
	])("rejects unsafe Git ref %s", (baseBranch) => {
		expect(() => parseCloudCodingRepository({ ...repository(), baseBranch })).toThrow();
	});
	it.each([
		{ host: "github.com.evil.example" },
		{ host: "github.com:443" },
		{ owner: "../other" },
		{ owner: "-option" },
		{ name: "../app" },
		{ name: "app?token=secret" },
		{ name: "app.git/other" },
		{ url: "https://github.com/Qorpera/app" },
	])("rejects ambiguous repository %j", (change) => {
		expect(() => parseCloudCodingRepository({ ...repository(), ...change })).toThrow();
	});
});

describe("coding follow-up identity", () => {
	const followup = () => ({
		operationKey: "continue:2",
		workerId: id(1),
		expectedVersion: 2,
		goal: "Fix the failing check",
	});
	it("addresses the existing worker and exact version", () => {
		expect(parseCloudCodingFollowup(followup())).toEqual(followup());
	});
	it.each([
		{ expectedVersion: 0 },
		{ expectedVersion: 1.5 },
		{ expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
		{ workerId: "other" },
		{ vmId: id(2) },
		{ branch: "replacement" },
		{ repository: repository() },
	])("rejects invalid or replacement follow-up identity %j", (change) => {
		expect(() => parseCloudCodingFollowup({ ...followup(), ...change })).toThrow();
	});
});

describe("coding worker public state", () => {
	it("preserves worker, parent, VM, repository, branch and PR identity", () => {
		const result = parseCloudCodingWorker(worker());
		expect(result).toEqual(worker());
		expect(Object.isFrozen(result.pullRequest)).toBe(true);
		expect(parseCloudCodingWorker({ ...worker(), state: "queued", vmId: null, pullRequest: null }).vmId).toBeNull();
		for (const state of CLOUD_CODING_WORKER_STATES)
			expect(parseCloudCodingWorker({ ...worker(), state }).state).toBe(state);
	});
	it.each([
		{ schema: "qorpera.coding-worker/v2" },
		{ id: "not-a-uuid" },
		{ state: "success" },
		{ version: 0 },
		{ turn: 0 },
		{ vmId: undefined },
		{ branch: "main" },
		{ secret: "forbidden" },
	])("rejects invalid worker %j", (change) => {
		expect(() => parseCloudCodingWorker({ ...worker(), ...change })).toThrow();
	});
	it.each([
		"https://github.com/Other/app/pull/12",
		"https://github.com/Qorpera/other/pull/12",
		"https://github.com/Qorpera/app/pull/13",
		"https://github.com/Qorpera/app/pull/012",
		"https://github.com/Qorpera/app/pull/12?token=secret",
		"https://github.com/Qorpera/app/pull/12#comment",
		"https://github.com@evil.example/Qorpera/app/pull/12",
		"http://github.com/Qorpera/app/pull/12",
	])("rejects PR outside the exact repository and number %s", (url) => {
		expect(() => parseCloudCodingWorker({ ...worker(), pullRequest: { ...worker().pullRequest, url } })).toThrow();
	});
	it.each([{ headSha: "a".repeat(7) }, { headSha: "A".repeat(40) }, { number: 0 }, { token: "secret" }])(
		"rejects ambiguous publication receipt %j",
		(change) => {
			expect(() => parseCloudCodingPullRequest({ ...worker().pullRequest, ...change }, repository())).toThrow();
		},
	);
});

describe("a repository kept in Qorpera (own code storage, slice 1)", () => {
	const kept = { host: "qorpera", owner: "company", name: "shop", baseBranch: "main" };
	it("names a folder: lower case only, never ending with a dot", () => {
		expect(parseCloudCodingRepository(kept)).toEqual(kept);
		expect(Object.isFrozen(parseCloudCodingRepository(kept))).toBe(true);
		expect(parseCloudCodingRepository({ ...kept, owner: "web-2", name: "shop_v2.app" }).name).toBe("shop_v2.app");
		for (const bad of [
			{ ...kept, owner: "Company" },
			{ ...kept, name: "Shop" },
			{ ...kept, name: "shop." },
			{ ...kept, owner: "-company" },
			{ ...kept, name: ".shop" },
			{ ...kept, host: "gitlab.com" },
		])
			expect(() => parseCloudCodingRepository(bad)).toThrow("INVALID_CODING_REPOSITORY");
		// GitHub's own rules are unchanged: mixed case and a trailing dot.
		expect(parseCloudCodingRepository({ ...repository(), name: "App." }).name).toBe("App.");
	});
	it("never reaches a GitHub step, and has no pull request", () => {
		expect(() => parseGitHubCodingRepository(kept)).toThrow("INVALID_CODING_REPOSITORY");
		expect(parseGitHubCodingRepository(repository())).toEqual(repository());
		expect(() =>
			parseCloudCodingPullRequest(
				{ url: "https://github.com/company/shop/pull/1", number: 1, headSha: "a".repeat(40) },
				parseCloudCodingRepository(kept),
			),
		).toThrow("INVALID_CODING_PULL_REQUEST");
		expect(parseCloudCodingWorker({ ...worker(), repository: kept, pullRequest: null }).repository).toEqual(kept);
	});
});
