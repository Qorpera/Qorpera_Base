import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
	storageAssert: vi.fn(),
	emergencyStop: vi.fn(),
	storagePrepare: vi.fn(),
}));
vi.mock("../src/coding-emergency-stop.ts", () => ({ reconcileCodingEmergencyStop: mocked.emergencyStop }));
vi.mock("../src/coding-storage.ts", () => ({
	createCodingNasStorage: (policy: { rootPath: string }) => ({
		controlPath: `${policy.rootPath}/control`,
		prepareControl: mocked.storagePrepare,
		assertControl: mocked.storageAssert,
		prepare: mocked.storagePrepare,
		assert: mocked.storageAssert,
	}),
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
	await mkdir(join(root, "control"), { mode: 0o700 });
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
		["/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "storage"],
	])
		files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(content) });
	let plan: ReturnType<typeof lxdCodingVmPlan> | undefined;
	let admissionState = "materialized";
	let installFailure: "before" | "after-storage" | "after-guest" | undefined;
	const call = vi.fn<LxdCodingExecutorHostOptions["control"]["call"]>(async (method, args) => {
		if (method === "qorpera_prepare_coding_execution") return {};
		if (method === "qorpera_describe_coding_cleanup")
			return { schema: "qorpera.coding-cleanup/v1", binding: plan?.binding };
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
		execInstance: vi.fn(async (_project, _name, command) => {
			if (command[2] !== "install") return;
			const fail = (phase: typeof installFailure) => {
				if (installFailure === phase) {
					installFailure = undefined;
					throw new Error("Guest installation reply lost");
				}
			};
			fail("before");
			const staged = files.get("/etc/qorpera-coding/configuration-inbox.json");
			if (!staged) throw new Error("Packet missing");
			const packet = JSON.parse(staged.content.toString("utf8"));
			if (packet.schema !== "qorpera.coding-configuration-install/v1") throw new Error("Packet schema differs");
			for (const name of ["storage", "guest"] as const) {
				const path = `/etc/qorpera-coding/${name}.json`;
				const content = Buffer.from(JSON.stringify(packet[name]));
				const existing = files.get(path);
				if (existing && !existing.content.equals(content)) throw new Error("Guest configuration drift");
				if (!existing) files.set(path, { uid: 0, gid: 0, mode: 0o444, content });
				fail(name === "storage" ? "after-storage" : "after-guest");
			}
		}),
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
		journalRoot: join(root, "control"),
		storagePolicy: {
			schema: "qorpera.coding-nas-policy/v1",
			mountPoint: root,
			rootPath: root,
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		},
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
			controlStatePath: join(root, "control", "control.json"),
		},
		providerAdapter: { adapterId: "local", acquire: vi.fn(), deliver: vi.fn(), reconcile: vi.fn(), stop: vi.fn() },
		guest: {
			uid: 2000,
			gid: 2000,
			workspacePath: "/workspace/repository",
			homePath: "/workspace/home",
			cachePath: "/workspace/cache",
			outputRoot: "/var/lib/qorpera-coding/logs",
			storageHelperSha256: hash("storage"),
			resourceProfile: {
				maxTimeoutMs: 1800000,
				memoryBytes: 2147483648,
				tasksMax: 256,
				cpuQuotaPercent: 200,
				maxLogBytes: 67108864,
			},
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
		failInstall: (phase: typeof installFailure) => {
			installFailure = phase;
		},
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
		expect(vi.mocked(f.client.pushInstanceFile).mock.calls.map((call) => call[2])).toEqual([
			"/etc/qorpera-coding/configuration-inbox.json",
		]);
		const packet = JSON.parse(f.files.get("/etc/qorpera-coding/configuration-inbox.json")!.content.toString());
		expect(packet).toMatchObject({
			schema: "qorpera.coding-configuration-install/v1",
			guest: { workerId: f.claim.worker.id, vmId: f.claim.worker.vmId },
			storage: { workerId: f.claim.worker.id },
		});
		expect(vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2].at(-1))).toEqual([
			"qorpera-coding-watchdog.timer",
			"install",
			"initialize",
		]);
	});
	it("retries packet delivery after the durable host intent was written", async () => {
		const f = await fixture();
		vi.mocked(f.client.pushInstanceFile).mockRejectedValueOnce(new Error("Staging interrupted"));
		await expect(f.host.prepareWorkspace(f.claim, f.signal)).rejects.toThrow("Staging interrupted");
		expect(mocked.seedFetch).not.toHaveBeenCalled();
		const replacement = new LxdCodingExecutorHost(f.options);
		await replacement.prepareWorkspace(f.claim, f.signal);
		expect(vi.mocked(f.client.pushInstanceFile).mock.calls.map((call) => call[2])).toEqual([
			"/etc/qorpera-coding/configuration-inbox.json",
			"/etc/qorpera-coding/configuration-inbox.json",
		]);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
	});
	it.each(["before", "after-storage", "after-guest"] as const)(
		"resumes installation after %s failure without directly overwriting active files",
		async (phase) => {
			const f = await fixture();
			f.failInstall(phase);
			await expect(f.host.prepareWorkspace(f.claim, f.signal)).rejects.toThrow("installation reply lost");
			expect(mocked.seedFetch).not.toHaveBeenCalled();
			expect(vi.mocked(f.client.execInstance).mock.calls.some((call) => call[2].at(-1) === "initialize")).toBe(
				false,
			);
			const installedStorage = f.files.get("/etc/qorpera-coding/storage.json");
			const installedGuest = f.files.get("/etc/qorpera-coding/guest.json");
			await new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.signal);
			if (installedStorage) expect(f.files.get("/etc/qorpera-coding/storage.json")).toBe(installedStorage);
			if (installedGuest) expect(f.files.get("/etc/qorpera-coding/guest.json")).toBe(installedGuest);
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "install"),
			).toHaveLength(2);
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "initialize"),
			).toHaveLength(1);
			expect(
				vi
					.mocked(f.client.pushInstanceFile)
					.mock.calls.every(
						(call) => call[2] === "/etc/qorpera-coding/configuration-inbox.json" && call[4] === 0o444,
					),
			).toBe(true);
		},
	);
	it.each(["guest", "storage"])(
		"independently verifies installed %s protection before initialization",
		async (name) => {
			const f = await fixture();
			await f.host.prepareWorkspace(f.claim, f.signal);
			f.files.get(`/etc/qorpera-coding/${name}.json`)!.mode = 0o644;
			vi.mocked(f.client.execInstance).mockClear();
			await expect(new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.signal)).rejects.toThrow(
				name === "guest" ? "GUEST_CONFIGURATION_UNCONFIRMED" : "GUEST_STORAGE_UNCONFIRMED",
			);
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "initialize"),
			).toHaveLength(0);
		},
	);
	it("refuses NAS loss before starting or reading commands", async () => {
		const f = await fixture();
		mocked.storagePrepare.mockRejectedValueOnce(new Error("NAS unavailable"));
		await expect(f.host.prepareWorkspace(f.claim, f.signal)).rejects.toThrow("NAS unavailable");
		expect(mocked.reconcile).not.toHaveBeenCalled();
		await f.host.prepareWorkspace(f.claim, f.signal);
		mocked.storageAssert.mockRejectedValueOnce(new Error("NAS lost"));
		await expect(
			f.host.commandTransport(
				{ workerId: f.claim.worker.id, vmId: f.claim.worker.vmId!, requestId: f.claim.requestId, turn: 1 },
				async () => undefined,
				f.signal,
			),
		).rejects.toThrow("NAS lost");
	});
	it("serializes overlapping NAS checks instead of aborting normal concurrent tool reads", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		let enter: (() => void) | undefined, release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = 0,
			maximum = 0;
		mocked.storageAssert.mockImplementation(async () => {
			active++;
			maximum = Math.max(maximum, active);
			enter?.();
			await held;
			active--;
		});
		const scope = { workerId: f.claim.worker.id, vmId: f.claim.worker.vmId!, requestId: f.claim.requestId, turn: 1 };
		const first = f.host.commandTransport(scope, async () => undefined, f.signal);
		await entered;
		const second = f.host.commandTransport(scope, async () => undefined, f.signal);
		await Promise.resolve();
		release?.();
		await Promise.all([first, second]);
		expect(maximum).toBe(1);
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
	it("uses SQL emergency custody when NAS inspection refuses cleanup", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		mocked.storageAssert.mockRejectedValueOnce(new Error("NAS unavailable"));
		mocked.emergencyStop.mockResolvedValue({ state: "stopped" });
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(mocked.emergencyStop).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: f.claim.requestId, owner: "coding-host", control: f.options.control }),
		);
	});
	it("completes a current pre-allocation cancellation from exact SQL absence proof without physical IO", async () => {
		const f = await fixture();
		f.claim.kind = "cancel";
		f.call.mockResolvedValueOnce({
			schema: "qorpera.coding-cleanup-absent/v1",
			requestId: f.claim.requestId,
			workerId: f.claim.worker.id,
			allocationId: null,
		});
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(mocked.emergencyStop).not.toHaveBeenCalled();
		expect(mocked.storageAssert).not.toHaveBeenCalled();
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it.each(["dispatch", "allocated", "request", "worker", "extra-field"])(
		"refuses an absence descriptor with %s mismatch",
		async (mismatch) => {
			const f = await fixture();
			f.claim.kind = mismatch === "dispatch" ? "dispatch" : "cancel";
			if (mismatch === "allocated") f.claim.worker = { ...f.claim.worker, vmId: randomUUID() };
			f.call.mockResolvedValueOnce({
				schema: "qorpera.coding-cleanup-absent/v1",
				requestId: mismatch === "request" ? randomUUID() : f.claim.requestId,
				workerId: mismatch === "worker" ? randomUUID() : f.claim.worker.id,
				allocationId: null,
				...(mismatch === "extra-field" ? { binding: {} } : {}),
			});
			await expect(f.host.stopWorkspace(f.claim, f.signal)).rejects.toThrow("ABSENCE_UNCONFIRMED");
			expect(mocked.reconcile).not.toHaveBeenCalled();
			expect(mocked.emergencyStop).not.toHaveBeenCalled();
		},
	);
	it("never infers absence from a missing binding, even when the cancellation claims no VM", async () => {
		const f = await fixture();
		f.claim.kind = "cancel";
		await expect(f.host.stopWorkspace(f.claim, f.signal)).rejects.toThrow();
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(mocked.emergencyStop).not.toHaveBeenCalled();
	});
	it("falls back after five seconds of stalled journal IO and retains the pending writer", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		let enter: (() => void) | undefined, release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lateEffect = vi.fn();
		mocked.reconcile.mockImplementationOnce(async (input: CodingVmReconcileOptions) => {
			enter?.();
			await held;
			input.signal.throwIfAborted();
			lateEffect();
			return { state: input.desiredState };
		});
		mocked.emergencyStop.mockResolvedValue({ state: "stopped" });
		vi.useFakeTimers();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			globalThis.setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), milliseconds);
			return controller.signal;
		});
		try {
			const stopping = f.host.stopWorkspace(f.claim, f.signal);
			await entered;
			await vi.advanceTimersByTimeAsync(5001);
			await stopping;
			expect(mocked.emergencyStop).toHaveBeenCalledTimes(1);
			const calls = mocked.reconcile.mock.calls.length;
			await f.host.stopWorkspace(f.claim, f.signal);
			expect(mocked.reconcile).toHaveBeenCalledTimes(calls);
			expect(mocked.emergencyStop).toHaveBeenCalledTimes(2);
			release?.();
			await held;
			await Promise.resolve();
			expect(lateEffect).not.toHaveBeenCalled();
		} finally {
			release?.();
			timeout.mockRestore();
			vi.useRealTimers();
		}
	});
	it("stop aborts a retained running reconciliation before using independent cleanup", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		let enter: (() => void) | undefined, release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lateEffect = vi.fn();
		mocked.reconcile.mockImplementationOnce(async (input: CodingVmReconcileOptions) => {
			enter?.();
			await held;
			input.signal.throwIfAborted();
			lateEffect();
			return { state: input.desiredState };
		});
		mocked.emergencyStop.mockResolvedValue({ state: "stopped" });
		try {
			const preparing = f.host.prepareWorkspace(f.claim, f.signal).catch((error: unknown) => error);
			await entered;
			await f.host.stopWorkspace(f.claim, f.signal);
			expect(await preparing).toMatchObject({ message: "CODING_HOST_VM_STOP_REQUESTED" });
			expect(mocked.emergencyStop).toHaveBeenCalledTimes(1);
			release?.();
			await held;
			await Promise.resolve();
			expect(lateEffect).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
	});
	it("uses the retained SQL binding for cleanup after a deployment policy change", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.signal);
		const replacementHost = new LxdCodingExecutorHost({
			...f.options,
			vmPolicy: { ...f.options.vmPolicy, imageFingerprint: "e".repeat(64) },
		});
		await replacementHost.stopWorkspace(f.claim, f.signal);
		const last = mocked.reconcile.mock.calls.at(-1)?.[0] as CodingVmReconcileOptions;
		expect(last.binding.imageFingerprint).toBe(f.options.vmPolicy.imageFingerprint);
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
