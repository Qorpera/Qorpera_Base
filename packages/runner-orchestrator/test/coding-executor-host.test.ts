import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSessionClaim, CodingTurnState } from "../src/coding-executor.ts";
import { codingHostId, LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../src/coding-executor-host.ts";
import { type CodingVmReconcileOptions, lxdCodingVmPlan } from "../src/coding-vm.ts";

const mocked = vi.hoisted(() => ({
	reconcile: vi.fn(),
	resolveBase: vi.fn(),
	seedFetch: vi.fn(),
	seedTransfer: vi.fn(),
	exportTransfer: vi.fn(),
	push: vi.fn(),
	publish: vi.fn(),
	refresh: vi.fn(),
	storageAssert: vi.fn(),
	storagePrepare: vi.fn(),
}));
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
	const claim: CodingSessionClaim = {
		workerId,
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		sequence: 1,
		profileId: randomUUID(),
		environmentId: randomUUID(),
		agentId: randomUUID(),
		ownerUserId: randomUUID(),
		harness: "codex",
		model: null,
		repository,
		branch: `qorpera/coding/${workerId}`,
		baseSha: null,
		harnessSessionRef: null,
		pullRequest: null,
		title: "Fix the delay after send",
		goal: "Build",
		definitionOfDone: "Tests",
		context: "",
		followUp: null,
	};
	let vmAllocationId: string | null = null;
	const turn = (): CodingTurnState => ({
		workerId,
		sequence: claim.sequence,
		turnId: codingHostId("turn", `${workerId}:${claim.sequence}`),
		phase: "preparing",
		workerState: "active",
		vmAllocationId,
		storageVolumeId: null,
		baseSha: null,
		occurrenceId: null,
		occurrenceStatus: null,
		runId: null,
		jobStatus: null,
		jobError: null,
		submission: null,
		pullRequest: null,
	});
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
	let installFailure: "before" | "after-storage" | "after-guest" | undefined;
	const call = vi.fn<LxdCodingExecutorHostOptions["control"]["call"]>(async (method, args) => {
		if (method === "qorpera_describe_coding_cleanup")
			return plan
				? {
						schema: "qorpera.coding-cleanup/v1",
						workerId,
						allocationId: plan.binding.allocationId,
						binding: plan.binding,
					}
				: { schema: "qorpera.coding-cleanup-absent/v1", workerId, allocationId: null };
		if (method === "qorpera_authorize_coding_machine" || method === "qorpera_authorize_coding_cleanup") {
			if (method === "qorpera_authorize_coding_machine" && args.p_lease_token !== claim.leaseToken)
				throw new Error("Coding session lease unavailable");
			if (method === "qorpera_authorize_coding_cleanup" && args.p_owner !== "coding-host")
				throw new Error("Coding cleanup custody differs");
			plan = lxdCodingVmPlan(JSON.parse(String(args.p_binding_text)));
			vmAllocationId = plan.binding.allocationId;
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
			// systemctl is-failed exits non-zero for a timer that has not failed.
			if (command[1] === "is-failed") throw new Error("LXD instance command failed");
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
	mocked.push.mockResolvedValue({ branch: claim.branch, headSha });
	const pullRequest = { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha };
	mocked.publish.mockResolvedValue(pullRequest);
	const submission = { kind: "finish" as const, summary: "Tests passed", headSha, operationKey: "done" };
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
		repositoryCredentials: {
			withRepositoryToken: vi.fn(async (_scope, _repository, use) => use("test-token-never-sent-to-guest")),
		},
	};
	const host = new LxdCodingExecutorHost(options),
		signal = new AbortController().signal;
	return {
		claim,
		turn,
		options,
		host,
		call,
		client,
		files,
		signal,
		submission,
		baseSha,
		pullRequest,
		scope: () => ({
			workerId,
			vmId: vmAllocationId!,
			requestId: codingHostId("turn", `${workerId}:${claim.sequence}`),
			turn: claim.sequence,
		}),
		failInstall: (phase: typeof installFailure) => {
			installFailure = phase;
		},
	};
}

describe("concrete coding executor host composition", () => {
	it("prepares the SQL-admitted VM, the pinned credential-free seed, the verified push and the draft PR", async () => {
		const f = await fixture();
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace).toEqual({ vmId: codingHostId("allocation", f.claim.workerId), baseSha: f.baseSha });
		await f.host.refreshLease(f.claim, f.signal);
		expect(await f.host.publish(f.claim, f.submission, f.signal)).toEqual({
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		expect(mocked.push).toHaveBeenCalledTimes(1);
		expect(mocked.push.mock.invocationCallOrder[0]).toBeLessThan(mocked.publish.mock.invocationCallOrder[0]);
		expect(mocked.publish.mock.calls[0]?.[0]).toMatchObject({
			title: "Fix the delay after send",
			body: "Tests passed",
		});
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
			guest: { workerId: f.claim.workerId, vmId: workspace.vmId },
			storage: { workerId: f.claim.workerId, companyId: f.claim.profileId },
		});
		expect(vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2].at(-1))).toEqual([
			"qorpera-coding-watchdog.timer",
			"image",
			"qorpera-coding-watchdog.timer",
			"install",
			"initialize",
		]);
		expect(f.client.execInstance).toHaveBeenCalledWith(
			"coding",
			expect.any(String),
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "image"],
			f.signal,
		);
		// Machine authority always names the session lease; cleanup names the owner.
		const machine = f.call.mock.calls.find((call) => call[0] === "qorpera_authorize_coding_machine")!;
		expect(machine[1]).toMatchObject({
			p_worker_id: f.claim.workerId,
			p_lease_token: f.claim.leaseToken,
			p_intent: "run",
		});
	});
	it("lends every Git and GitHub step the token of this claim's session only", async () => {
		const f = await fixture();
		// The Git and GitHub steps keep their (repository, use, signal) shape; the
		// host supplies the session scope.
		const lend = async (
			_input: unknown,
			options: {
				withRepositoryToken(
					repository: CodingSessionClaim["repository"],
					use: (token: string) => Promise<string>,
					signal: AbortSignal,
				): Promise<string>;
			},
		) => {
			expect(await options.withRepositoryToken(f.claim.repository, async (token) => token, f.signal)).toBe(
				"test-token-never-sent-to-guest",
			);
		};
		mocked.resolveBase.mockImplementation(async (repository, options) => {
			await lend(repository, options);
			return f.baseSha;
		});
		mocked.seedFetch.mockImplementation(async (input, options) => {
			await lend(input, options);
			return { headSha: f.baseSha, bundle: Buffer.from("seed"), bundleSha256: hash("seed") };
		});
		mocked.push.mockImplementation(async (input, _bundle, options) => {
			await lend(input, options);
			return { branch: f.claim.branch, headSha: f.submission.headSha };
		});
		mocked.publish.mockImplementation(async (input, options) => {
			await lend(input, options);
			return f.pullRequest;
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.publish(f.claim, f.submission, f.signal);
		const calls = vi.mocked(f.options.repositoryCredentials.withRepositoryToken).mock.calls;
		expect(calls).toHaveLength(4);
		for (const call of calls) {
			expect(call[0]).toEqual({
				companyId: f.claim.profileId,
				workerId: f.claim.workerId,
				leaseToken: f.claim.leaseToken,
			});
			expect(Object.isFrozen(call[0])).toBe(true);
			expect(call[1]).toEqual(f.claim.repository);
		}
	});
	it("retries packet delivery after the durable host intent was written", async () => {
		const f = await fixture();
		vi.mocked(f.client.pushInstanceFile).mockRejectedValueOnce(new Error("Staging interrupted"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("Staging interrupted");
		expect(mocked.seedFetch).not.toHaveBeenCalled();
		const replacement = new LxdCodingExecutorHost(f.options);
		await replacement.prepareWorkspace(f.claim, f.turn(), f.signal);
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
			await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("installation reply lost");
			expect(mocked.seedFetch).not.toHaveBeenCalled();
			expect(vi.mocked(f.client.execInstance).mock.calls.some((call) => call[2].at(-1) === "initialize")).toBe(
				false,
			);
			const installedStorage = f.files.get("/etc/qorpera-coding/storage.json");
			const installedGuest = f.files.get("/etc/qorpera-coding/guest.json");
			await new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.turn(), f.signal);
			if (installedStorage) expect(f.files.get("/etc/qorpera-coding/storage.json")).toBe(installedStorage);
			if (installedGuest) expect(f.files.get("/etc/qorpera-coding/guest.json")).toBe(installedGuest);
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "install"),
			).toHaveLength(2);
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "initialize"),
			).toHaveLength(1);
		},
	);
	it.each(["guest", "storage"])(
		"independently verifies installed %s protection before initialization",
		async (name) => {
			const f = await fixture();
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			f.files.get(`/etc/qorpera-coding/${name}.json`)!.mode = 0o644;
			vi.mocked(f.client.execInstance).mockClear();
			await expect(
				new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.turn(), f.signal),
			).rejects.toThrow(name === "guest" ? "GUEST_CONFIGURATION_UNCONFIRMED" : "GUEST_STORAGE_UNCONFIRMED");
			expect(
				vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2].at(-1) === "initialize"),
			).toHaveLength(0);
		},
	);
	it("refuses NAS loss before starting or reading commands", async () => {
		const f = await fixture();
		mocked.storagePrepare.mockRejectedValueOnce(new Error("NAS unavailable"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("NAS unavailable");
		expect(mocked.reconcile).not.toHaveBeenCalled();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		mocked.storageAssert.mockRejectedValueOnce(new Error("NAS lost"));
		await expect(f.host.commandTransport(f.scope(), async () => undefined, f.signal)).rejects.toThrow("NAS lost");
	});
	it("serializes overlapping NAS checks instead of aborting normal concurrent tool reads", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
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
		const scope = f.scope();
		const first = f.host.commandTransport(scope, async () => undefined, f.signal);
		await entered;
		const second = f.host.commandTransport(scope, async () => undefined, f.signal);
		await Promise.resolve();
		release?.();
		await Promise.all([first, second]);
		expect(maximum).toBe(1);
	});
	it("retains seed, base and VM across a follow-up turn and never resets the repository", async () => {
		const f = await fixture();
		const first = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.stopWorkspace(f.claim, f.signal);
		f.claim.leaseToken = randomUUID();
		f.claim.sequence = 2;
		const second = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(second.vmId).toBe(first.vmId);
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		// The scope of the second turn names the second turn.
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
	});
	it("refuses a turn whose pinned base or turn id differs from the kernel's", async () => {
		const f = await fixture();
		await expect(
			f.host.prepareWorkspace(f.claim, { ...f.turn(), baseSha: "c".repeat(40) }, f.signal),
		).rejects.toThrow("BASE_CHANGED");
		const g = await fixture();
		await expect(g.host.prepareWorkspace(g.claim, { ...g.turn(), turnId: randomUUID() }, g.signal)).rejects.toThrow(
			"TURN_ID_DIFFERS",
		);
	});
	it("fails before the turn if the watchdog artifact or timer differs", async () => {
		const f = await fixture();
		f.files.get("/opt/qorpera-coding/cloud-coding-watchdog.mjs")!.content = Buffer.from("changed");
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("ARTIFACT_CHANGED");
		const g = await fixture();
		vi.mocked(g.client.execInstance).mockImplementation(async (_project, _name, command) => {
			if (command[1] === "is-enabled") return;
			throw new Error("LXD instance command failed");
		});
		const impatient = new LxdCodingExecutorHost({ ...g.options, guestReadyTimeoutMs: 50 });
		await expect(impatient.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			"CODING_HOST_GUEST_NOT_READY",
		);
	});
	it("refuses an image that can update itself before delivering any configuration", async () => {
		// Live 2026-09-24 (run d1f454e2): unattended-upgrades restarted the
		// guest's services mid-turn and its inhibitor then refused the stop.
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command.at(-1) === "image") throw new Error("LXD instance command failed");
			return fallback(project, name, command, signal);
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			/^RUNNER_IMAGE_SELF_UPDATE_ENABLED$/,
		);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		expect(
			vi
				.mocked(f.client.execInstance)
				.mock.calls.filter((call) => ["install", "initialize"].includes(call[2].at(-1)!)),
		).toHaveLength(0);
		expect(mocked.seedFetch).not.toHaveBeenCalled();
	});
	it("does not report a guest whose agent dropped out during the image check as self-updating", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command.at(-1) === "image") throw new Error("LXD instance agent not running");
			return fallback(project, name, command, signal);
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			/^LXD instance agent not running$/,
		);
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("retries only a guest that is still starting, and fails at once with any other cause", async () => {
		const f = await fixture();
		vi.mocked(f.client.execInstance).mockRejectedValue(new Error("LXD request failed (404)"));
		const started = performance.now();
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("LXD request failed (404)");
		expect(vi.mocked(f.client.execInstance)).toHaveBeenCalledTimes(1);
		expect(performance.now() - started).toBeLessThan(5000);
	});
	it("waits while the guest's agent is not running yet, without probing the timer, then succeeds", async () => {
		// Live 2026-09-24 (session 26d3688c): the first checks after boot fail
		// with LXD's "LXD VM agent is not currently running".
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let offline = 2;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[1] === "is-active" && offline-- > 0) throw new Error("LXD instance agent not running");
			return fallback(project, name, command, signal);
		});
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace.baseSha).toBe(f.baseSha);
		const verbs = vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2][1]);
		expect(verbs.filter((verb) => verb === "is-active").length).toBeGreaterThanOrEqual(3);
		expect(verbs).not.toContain("is-failed");
		expect(verbs).not.toContain("is-enabled");
	});
	it("gives up with CODING_HOST_GUEST_NOT_READY when the guest's agent never comes up", async () => {
		const f = await fixture();
		vi.mocked(f.client.execInstance).mockRejectedValue(new Error("LXD instance agent not running"));
		const impatient = new LxdCodingExecutorHost({ ...f.options, guestReadyTimeoutMs: 50 });
		const started = performance.now();
		await expect(impatient.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_GUEST_NOT_READY",
		);
		expect(performance.now() - started).toBeLessThan(5000);
	});
	it("goes back to waiting when the agent drops out during the timer probes", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let active = 0,
			probes = 0;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[1] === "is-active" && ++active <= 2) throw new Error("LXD instance command failed");
			if (command[1] === "is-failed" && ++probes === 1) throw new Error("LXD instance agent not running");
			return fallback(project, name, command, signal);
		});
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace.baseSha).toBe(f.baseSha);
		expect(active).toBeGreaterThanOrEqual(3);
	});
	it.each(["LXD operation is invalid", "LXD operation failed"])(
		"fails at once on a generic exec failure (%s)",
		async (message) => {
			const f = await fixture();
			vi.mocked(f.client.execInstance).mockRejectedValue(new Error(message));
			const started = performance.now();
			await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(message);
			expect(performance.now() - started).toBeLessThan(5000);
			expect(vi.mocked(f.client.execInstance)).toHaveBeenCalledTimes(1);
		},
	);
	it("re-reads the VM between readiness checks: one stopped elsewhere fails without waiting out the window", async () => {
		const f = await fixture();
		vi.mocked(f.client.execInstance).mockRejectedValue(new Error("LXD instance agent not running"));
		const running = vi.mocked(f.client.getInstance).getMockImplementation()!;
		let reads = 0;
		vi.mocked(f.client.getInstance).mockImplementation(async (project, name, signal) => {
			const instance = await running(project, name, signal);
			return ++reads > 2 && instance ? { ...instance, status: "Stopped", statusCode: 102 } : instance;
		});
		const started = performance.now();
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("CODING_HOST_VM_NOT_RUNNING");
		expect(performance.now() - started).toBeLessThan(10000);
		expect(vi.mocked(f.client.execInstance)).toHaveBeenCalledTimes(2);
	});
	it("the caller's abort during the readiness wait wins over NOT_READY", async () => {
		const f = await fixture();
		const controller = new AbortController();
		vi.mocked(f.client.execInstance).mockImplementation(async (_project, _name, command) => {
			if (command[1] === "is-enabled") return;
			if (command[1] === "is-active")
				globalThis.setTimeout(() => controller.abort(new Error("CODING_EXECUTOR_LEASE_LOST")), 100);
			throw new Error("LXD instance command failed");
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), controller.signal)).rejects.toThrow(
			"CODING_EXECUTOR_LEASE_LOST",
		);
		expect(vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2][1] === "is-active")).toHaveLength(1);
	});
	it.each([
		["failed", "is-failed", "CODING_HOST_GUEST_WATCHDOG_FAILED"],
		["masked or disabled", "is-enabled", "CODING_HOST_GUEST_WATCHDOG_DISABLED"],
	])("fails at once when the watchdog timer is %s instead of waiting it out", async (_state, verb, code) => {
		const f = await fixture();
		vi.mocked(f.client.execInstance).mockImplementation(async (_project, _name, command) => {
			if (command[1] === "is-active") throw new Error("LXD instance command failed");
			if (command[1] === "is-failed" && verb === "is-failed") return;
			if (command[1] === "is-failed" || command[1] === verb) throw new Error("LXD instance command failed");
		});
		const started = performance.now();
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(code);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2][1] === "is-active")).toHaveLength(1);
	});
	it("waits for a freshly booted guest's watchdog timer instead of failing the session", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let checks = 0;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[1] === "is-active" && ++checks <= 2) throw new Error("LXD instance command failed");
			return fallback(project, name, command, signal);
		});
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace.baseSha).toBe(f.baseSha);
		expect(checks).toBeGreaterThanOrEqual(3);
	});
	it("does not publish or push a no-change original head", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(await f.host.publish(f.claim, { ...f.submission, headSha: f.baseSha }, f.signal)).toEqual({
			pullRequest: null,
			noChange: true,
		});
		expect(mocked.exportTransfer).toHaveBeenCalledTimes(1);
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("ends a stop from SQL's absence proof without physical IO, and never from a missing binding", async () => {
		const f = await fixture();
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(f.client.getInstance).not.toHaveBeenCalled();
		const g = await fixture();
		g.call.mockResolvedValueOnce({
			schema: "qorpera.coding-cleanup-absent/v1",
			workerId: randomUUID(),
			allocationId: null,
		});
		await expect(g.host.stopWorkspace(g.claim, g.signal)).rejects.toThrow("ABSENCE_UNCONFIRMED");
		const h = await fixture();
		await h.host.prepareWorkspace(h.claim, h.turn(), h.signal);
		h.call.mockResolvedValueOnce({
			schema: "qorpera.coding-cleanup-absent/v1",
			workerId: h.claim.workerId,
			allocationId: null,
		});
		await expect(h.host.stopWorkspace(h.claim, h.signal)).rejects.toThrow("ABSENCE_UNCONFIRMED");
	});
	it("stop aborts a retained running reconciliation", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
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
		try {
			const preparing = f.host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
			await entered;
			await expect(f.host.stopWorkspace(f.claim, f.signal)).rejects.toThrow("VM_IO_PENDING");
			expect(await preparing).toMatchObject({ message: "CODING_HOST_VM_STOP_REQUESTED" });
			release?.();
			await held;
			await Promise.resolve();
			expect(lateEffect).not.toHaveBeenCalled();
		} finally {
			release?.();
		}
	});
	it("quiesces a running guest under stop-only authority before the forced power-off", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		f.call.mockClear();
		mocked.reconcile.mockClear();
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2])).toEqual([
			["/usr/bin/systemctl", "stop", "qorpera-coding.slice"],
			["/usr/bin/sync"],
		]);
		const quiesced = vi.mocked(f.client.execInstance).mock.invocationCallOrder.at(-1)!;
		expect(quiesced).toBeLessThan(mocked.reconcile.mock.invocationCallOrder[0]);
		const cleanup = f.call.mock.calls.findIndex((call) => call[0] === "qorpera_authorize_coding_cleanup");
		expect(f.call.mock.invocationCallOrder[cleanup]).toBeLessThan(
			vi.mocked(f.client.execInstance).mock.invocationCallOrder[0],
		);
		expect(f.call.mock.calls.some((call) => call[0] === "qorpera_authorize_coding_machine")).toBe(false);
	});
	it("powers off without further guest commands when the guest's agent is not running", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		vi.mocked(f.client.execInstance).mockRejectedValue(new Error("LXD instance agent not running"));
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2])).toEqual([
			["/usr/bin/systemctl", "stop", "qorpera-coding.slice"],
		]);
		expect((mocked.reconcile.mock.calls.at(-1)?.[0] as CodingVmReconcileOptions).desiredState).toBe("stopped");
	});
	it("still powers off when the quiesce fails, and skips it for a VM that is not running", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		vi.mocked(f.client.execInstance).mockRejectedValueOnce(new Error("LXD instance command failed"));
		await f.host.stopWorkspace(f.claim, f.signal);
		// sync still runs after a failed slice stop; the stop still reconciles.
		expect(vi.mocked(f.client.execInstance).mock.calls.map((call) => call[2].at(-1))).toEqual([
			"qorpera-coding.slice",
			"/usr/bin/sync",
		]);
		expect((mocked.reconcile.mock.calls.at(-1)?.[0] as CodingVmReconcileOptions).desiredState).toBe("stopped");
		const g = await fixture();
		await g.host.prepareWorkspace(g.claim, g.turn(), g.signal);
		vi.mocked(g.client.execInstance).mockClear();
		const running = vi.mocked(g.client.getInstance).getMockImplementation()!;
		vi.mocked(g.client.getInstance).mockImplementation(async (project, name, signal) => {
			const instance = await running(project, name, signal);
			return instance && { ...instance, status: "Stopped", statusCode: 102 };
		});
		await g.host.stopWorkspace(g.claim, g.signal);
		expect(g.client.execInstance).not.toHaveBeenCalled();
		expect((mocked.reconcile.mock.calls.at(-1)?.[0] as CodingVmReconcileOptions).desiredState).toBe("stopped");
	});
	it("gives a stop more than 5 s to settle", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const started = performance.now();
		mocked.reconcile.mockImplementation(async (input: CodingVmReconcileOptions) => {
			await input.admission.authorize(input.binding, "stop", input.signal);
			return { state: performance.now() - started < 6000 ? "pending" : "stopped" };
		});
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(performance.now() - started).toBeGreaterThanOrEqual(6000);
	}, 20000);
	it("uses the retained SQL binding for cleanup after a deployment policy change", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const replacementHost = new LxdCodingExecutorHost({
			...f.options,
			vmPolicy: { ...f.options.vmPolicy, imageFingerprint: "e".repeat(64) },
		});
		await replacementHost.stopWorkspace(f.claim, f.signal);
		const last = mocked.reconcile.mock.calls.at(-1)?.[0] as CodingVmReconcileOptions;
		expect(last.binding.imageFingerprint).toBe(f.options.vmPolicy.imageFingerprint);
	});
	it("stops with cleanup custody after the session lease is gone", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.claim.leaseToken = randomUUID();
		await f.host.stopWorkspace(f.claim, f.signal);
		expect(f.call.mock.calls.at(-1)?.[0]).toBe("qorpera_authorize_coding_cleanup");
		expect(f.call.mock.calls.at(-1)?.[1]).toMatchObject({ p_owner: "coding-host", p_worker_id: f.claim.workerId });
		expect(f.call.mock.calls.at(-1)?.[1]).not.toHaveProperty("p_lease_token");
		await expect(f.host.refreshLease(f.claim, f.signal)).rejects.toThrow("NOT_PREPARED");
	});
	it("rejects command transport scope changes and publication before preparation", async () => {
		const f = await fixture();
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("NOT_PREPARED");
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await expect(f.host.commandTransport({ ...f.scope(), turn: 2 }, async () => undefined, f.signal)).rejects.toThrow(
			"NOT_PREPARED",
		);
	});
});
