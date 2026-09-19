import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingExecutorClaim } from "../src/coding-executor.ts";
import { LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../src/coding-executor-host.ts";
import { type CodingVmReconcileOptions, lxdCodingVmPlan } from "../src/coding-vm.ts";

const mocked = vi.hoisted(() => ({
	reconcile: vi.fn(),
	resolveBase: vi.fn(),
	seedFetch: vi.fn(),
	seedTransfer: vi.fn(),
	exportTransfer: vi.fn(),
	native: vi.fn(),
	push: vi.fn(),
	publish: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("../src/coding-vm.ts", async (original) => ({
	...(await original<typeof import("../src/coding-vm.ts")>()),
	reconcileLxdCodingVm: mocked.reconcile,
}));
vi.mock("../src/coding-git-seed.ts", () => ({
	resolveCloudCodingBase: mocked.resolveBase,
	fetchCloudCodingSeed: mocked.seedFetch,
}));
vi.mock("../src/coding-git-transfer.ts", () => ({
	LxdCodingGitTransfer: class {
		seed = mocked.seedTransfer;
		export = mocked.exportTransfer;
	},
}));
vi.mock("../src/coding-native-dispatch.ts", () => ({ runCodingNativeTurn: mocked.native }));
vi.mock("../src/coding-git.ts", () => ({ pushCloudCodingBundle: mocked.push }));
vi.mock("../src/coding-workspace.ts", () => ({ publishCloudCodingDraftPullRequest: mocked.publish }));
vi.mock("../src/coding-lease-transport.ts", () => ({
	LxdCodingLeaseTransport: class {
		refresh = mocked.refresh;
	},
}));
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
beforeEach(() => {
	for (const mock of Object.values(mocked)) mock.mockReset();
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-host-")));
	roots.push(root);
	const workerId = randomUUID();
	const repository = { host: "github.com" as const, owner: "Qorpera", name: "app", baseBranch: "main" };
	const claim: CodingExecutorClaim = {
		requestId: randomUUID(),
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		environmentId: randomUUID(),
		worker: {
			schema: "qorpera.coding-worker/v1",
			id: workerId,
			companyId: randomUUID(),
			parentAgentId: randomUUID(),
			parentRunId: randomUUID(),
			repository,
			branch: `qorpera/coding/${workerId}`,
			vmId: null,
			version: 1,
			state: "running",
			turn: 1,
			pullRequest: null,
		},
		dispatch: {
			operationKey: "task-one",
			repository,
			goal: "Build",
			definitionOfDone: "Tests",
			context: "",
			sourceReadIds: [],
			todoPath: "projects/app/todo.json",
			cancellationPolicy: "retain-workspace",
			completionPolicy: "notify-parent",
			publication: "draft-pr",
		},
		kind: "dispatch",
		goal: "Build",
	};
	const bootId = randomUUID(),
		nodeId = randomUUID(),
		baseSha = "a".repeat(40),
		headSha = "b".repeat(40);
	const files = new Map<string, { uid: number; gid: number; mode: number; content: Buffer }>();
	for (const [path, content] of [
		["/proc/sys/kernel/random/boot_id", `${bootId}\n`],
		["/opt/qorpera-coding/cloud-coding-command-guest.mjs", "command"],
		["/opt/qorpera-coding/cloud-coding-git-guest.mjs", "git"],
		["/opt/qorpera-coding/cloud-coding-watchdog.mjs", "watchdog"],
	])
		files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(content) });
	let plan: ReturnType<typeof lxdCodingVmPlan> | undefined;
	let admissionState = "materialized";
	const call = vi.fn<LxdCodingExecutorHostOptions["control"]["call"]>(async (method, args) => {
		if (method === "qorpera_prepare_coding_execution") return {};
		if (method === "qorpera_describe_coding_execution")
			return { requestId: claim.requestId, workerId, admissionState, runId: randomUUID(), worker: claim.worker };
		if (method === "qorpera_authorize_coding_machine" || method === "qorpera_authorize_coding_cleanup") {
			plan = lxdCodingVmPlan(JSON.parse(String(args.p_binding_text)));
			claim.worker = { ...claim.worker, vmId: plan.binding.allocationId };
			return {
				schema: "qorpera.coding-vm-admission/v1",
				workerId,
				allocationId: plan.binding.allocationId,
				instanceSha256: plan.instanceSha256,
				intent: method === "qorpera_authorize_coding_cleanup" ? "stop" : "run",
				validForMs: 5000,
				nodeId,
				nodeVersion: 1,
			};
		}
		throw new Error(`Unexpected control method ${method}`);
	});
	const getInstance = vi.fn<LxdCodingExecutorHostOptions["client"]["getInstance"]>(async () => {
		if (!plan) throw new Error("Missing plan");
		return {
			name: plan.request.name,
			type: "virtual-machine",
			status: "Running",
			statusCode: 103,
			profiles: [],
			config: { ...plan.request.config, "volatile.base_image": plan.binding.imageFingerprint },
			expandedConfig: { ...plan.request.config, "volatile.base_image": plan.binding.imageFingerprint },
			devices: plan.request.devices,
			expandedDevices: plan.request.devices,
		};
	});
	const client: LxdCodingExecutorHostOptions["client"] = {
		getInstance,
		submitInstanceOperation: vi.fn(),
		inspectInstanceOperation: vi.fn(),
		readInstanceFile: vi.fn(async (_project, _name, path) => {
			const file = files.get(path);
			if (!file) throw new Error("Missing file");
			return file;
		}),
		pushInstanceFile: vi.fn(async (_project, _name, path, content, mode) => {
			files.set(path, { uid: 0, gid: 0, mode, content: Buffer.from(content) });
		}),
		execInstance: vi.fn(async () => undefined),
	};
	mocked.reconcile.mockImplementation(async (input: CodingVmReconcileOptions) => {
		await input.admission.authorize(input.binding, input.desiredState === "running" ? "run" : "stop", input.signal);
		return { state: input.desiredState };
	});
	mocked.resolveBase.mockResolvedValue(baseSha);
	mocked.seedFetch.mockResolvedValue({ headSha: baseSha, bundle: Buffer.from("seed"), bundleSha256: hash("seed") });
	mocked.seedTransfer.mockResolvedValue({});
	mocked.exportTransfer.mockResolvedValue({ bundle: Buffer.from("export"), receipt: {} });
	const finish = {
		schema: "qorpera.coding-finish/v1",
		requestId: claim.requestId,
		workerId,
		turn: 1,
		state: "ready-to-publish",
		summary: "Tests passed",
		headSha,
	};
	mocked.native.mockImplementation(async () => ({ worker: claim.worker, finish }));
	mocked.push.mockResolvedValue({ branch: claim.worker.branch, headSha });
	const pullRequest = { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha };
	mocked.publish.mockResolvedValue(pullRequest);
	const options: LxdCodingExecutorHostOptions = {
		control: { call },
		owner: "coding-host",
		machineIdSha256: "f".repeat(64),
		journalRoot: root,
		client,
		vmPolicy: {
			providerId: "coding",
			providerPolicySha256: "a".repeat(64),
			project: "coding",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "coding",
			network: "coding",
			cpus: 2,
			memoryBytes: 2147483648,
			rootDiskBytes: 10737418240,
		},
		orchestratorId: randomUUID(),
		controlPlaneConfig: {
			supabaseUrl: "https://control.example.org",
			publishableKey: "public",
			controlToken: "a".repeat(43),
			controlStatePath: join(root, "state.json"),
		},
		providerAdapter: { adapterId: "local", acquire: vi.fn(), deliver: vi.fn(), reconcile: vi.fn(), stop: vi.fn() },
		guest: {
			uid: 1000,
			gid: 1000,
			workspacePath: "/workspace/repository",
			commandHelperSha256: hash("command"),
			gitHelperSha256: hash("git"),
			watchdogHelperSha256: hash("watchdog"),
		},
		repositoryCredentials: { withRepositoryToken: async (_repository, use) => use("test-token-never-sent-to-guest") },
	};
	const host = new LxdCodingExecutorHost(options),
		signal = new AbortController().signal;
	return {
		claim,
		options,
		host,
		call,
		client,
		files,
		signal,
		finish,
		baseSha,
		pullRequest,
		setAdmission: (value: string) => {
			admissionState = value;
		},
	};
}

describe("concrete coding executor host composition", () => {
	it("prepares SQL admitted VM, pinned credential-free seed, canonical native turn, verified push and draft PR", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		await f.host.refreshLease(f.claim, f.signal);
		await f.host.runNative(f.claim, f.signal);
		expect(await f.host.publish(f.claim, f.signal)).toEqual({
			summary: "Tests passed",
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		expect(mocked.native).toHaveBeenCalledTimes(1);
		expect(mocked.push).toHaveBeenCalledTimes(1);
		expect(mocked.push.mock.invocationCallOrder[0]).toBeLessThan(mocked.publish.mock.invocationCallOrder[0]);
		expect(f.client.execInstance).toHaveBeenCalledWith(
			"coding",
			expect.any(String),
			["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
			f.signal,
		);
		expect(JSON.stringify(vi.mocked(f.client.pushInstanceFile).mock.calls)).not.toContain("test-token");
	});
	it("retains seed/base/VM across a followup and never resets the repository", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		const vm = f.claim.worker.vmId;
		await f.host.stopWorkspace(f.claim, f.signal);
		f.claim.requestId = randomUUID();
		f.claim.kind = "followup";
		f.claim.worker = { ...f.claim.worker, turn: f.claim.worker.turn + 1 };
		await f.host.prepareWorkspace(f.claim, f.signal);
		expect(f.claim.worker.vmId).toBe(vm);
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
	});
	it("can resume a completed native turn for publication without refusing its admission", async () => {
		const f = await fixture();
		f.setAdmission("completed");
		await f.host.prepareWorkspace(f.claim, f.signal);
		await f.host.runNative(f.claim, f.signal);
		expect(await f.host.publish(f.claim, f.signal)).toMatchObject({ pullRequest: f.pullRequest });
	});
	it("fails before native work if the watchdog artifact or timer differs", async () => {
		const f = await fixture();
		f.files.get("/opt/qorpera-coding/cloud-coding-watchdog.mjs")!.content = Buffer.from("changed");
		await expect(f.host.prepareWorkspace(f.claim, f.signal)).rejects.toThrow("ARTIFACT_CHANGED");
		expect(mocked.native).not.toHaveBeenCalled();
		const g = await fixture();
		vi.mocked(g.client.execInstance).mockRejectedValue(new Error("timer stopped"));
		await expect(g.host.prepareWorkspace(g.claim, g.signal)).rejects.toThrow("timer stopped");
	});
	it("does not publish or push a no-change original head", async () => {
		const f = await fixture();
		f.finish.headSha = f.baseSha;
		await f.host.prepareWorkspace(f.claim, f.signal);
		await f.host.runNative(f.claim, f.signal);
		expect(await f.host.publish(f.claim, f.signal)).toEqual({
			summary: "Tests passed",
			pullRequest: null,
			noChange: true,
		});
		expect(mocked.exportTransfer).toHaveBeenCalledTimes(1);
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("stops with cleanup authority after ordinary work authority is revoked", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(f.call.mock.calls.at(-1)?.[0]).toBe("qorpera_authorize_coding_cleanup");
		expect(f.call.mock.calls.at(-1)?.[1]).toMatchObject({
			p_owner: "coding-host",
			p_lease_token: f.claim.leaseToken,
		});
		await expect(f.host.refreshLease(f.claim, f.signal)).rejects.toThrow("NOT_PREPARED");
	});
	it("rejects command transport scope changes and publication without native submission", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		await expect(f.host.publish(f.claim, f.signal)).rejects.toThrow("SUBMISSION_MISSING");
		const scope = { workerId: f.claim.worker.id, vmId: f.claim.worker.vmId!, requestId: f.claim.requestId, turn: 2 };
		await expect(f.host.commandTransport(scope, async () => undefined, f.signal)).rejects.toThrow("NOT_PREPARED");
	});
});
