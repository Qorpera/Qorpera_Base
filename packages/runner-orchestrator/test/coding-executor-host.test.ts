import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudCodingSessionLayout, parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingComputerUsage } from "../src/coding-computer-usage.ts";
import { CodingMachineUnavailable, type CodingSessionClaim, type CodingTurnState } from "../src/coding-executor.ts";
import { codingHostId, LxdCodingExecutorHost, type LxdCodingExecutorHostOptions } from "../src/coding-executor-host.ts";
import {
	type CodingMachineReconcileOptions,
	type LxdCodingMachineBinding,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
} from "../src/coding-machine.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import type { LxdInstanceRecord } from "../src/lxd-client.ts";

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
	commandTransports: [] as {
		authorize: (
			action: string,
			scope: unknown,
			commandId: string,
			inputSha256: string,
			signal: AbortSignal,
		) => Promise<void>;
	}[],
}));
vi.mock("../src/coding-command-transport.ts", () => ({
	LxdCodingCommandTransport: class {
		constructor(options: (typeof mocked.commandTransports)[number]) {
			mocked.commandTransports.push(options);
		}
	},
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
vi.mock("../src/coding-machine.ts", async (original) => ({
	...(await original<typeof import("../src/coding-machine.ts")>()),
	reconcileCodingMachine: mocked.reconcile,
}));
vi.mock("../src/coding-git-seed.ts", () => ({
	resolveCloudCodingBase: mocked.resolveBase,
	fetchCloudCodingSeed: mocked.seedFetch,
}));
interface TransferOptions {
	scope: unknown;
	authorize(action: string, scope: unknown, transfer: string, digest: string, signal: AbortSignal): Promise<void>;
}
// As the real transfer does, each step asks the host's authority first.
vi.mock("../src/coding-git-transfer.ts", () => ({
	LxdCodingGitTransfer: class {
		readonly options: TransferOptions;
		constructor(options: TransferOptions) {
			this.options = options;
		}
		async seed(transferId: string, headSha: string, bundle: Buffer, signal: AbortSignal) {
			await this.options.authorize("seed", this.options.scope, transferId, "a".repeat(64), signal);
			return mocked.seedTransfer(transferId, headSha, bundle, signal);
		}
		async export(transferId: string, headSha: string, signal: AbortSignal) {
			await this.options.authorize("export", this.options.scope, transferId, "a".repeat(64), signal);
			return mocked.exportTransfer(transferId, headSha, signal);
		}
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
	for (const mock of Object.values(mocked)) if (typeof mock === "function") mock.mockReset();
	mocked.commandTransports.length = 0;
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Devices = Record<string, Readonly<Record<string, string>>>;
type Listed = Record<string, unknown>;

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-host-")));
	roots.push(root);
	await mkdir(join(root, "control"), { mode: 0o700 });
	const repository = { host: "github.com" as const, owner: "Qorpera", name: "app", baseBranch: "main" };
	const profileId = randomUUID(),
		environmentId = randomUUID(),
		ownerUserId = randomUUID();
	const session = (workerId = randomUUID()): CodingSessionClaim => ({
		workerId,
		leaseToken: randomUUID(),
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		sequence: 1,
		profileId,
		environmentId,
		agentId: randomUUID(),
		ownerUserId,
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
	});
	const claim = session();
	const turnOf = (of: CodingSessionClaim): CodingTurnState => ({
		workerId: of.workerId,
		sequence: of.sequence,
		turnId: codingHostId("turn", `${of.workerId}:${of.sequence}`),
		phase: "preparing",
		workerState: "active",
		vmAllocationId: machine.machineId,
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
	const storagePolicy = parseCloudCodingNasPolicy({
		schema: "qorpera.coding-nas-policy/v1",
		mountPoint: root,
		rootPath: root,
		source: "192.168.1.40:/coding",
		serverAddress: "192.168.1.40",
	});
	const placement = { policy: storagePolicy, machineIdSha256: "f".repeat(64) };
	const vmPolicy: LxdCodingExecutorHostOptions["vmPolicy"] = {
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "coding",
		cpus: 4,
		memoryBytes: 8589934592,
		rootDiskBytes: 34359738368,
	};
	const machine: LxdCodingMachineBinding = {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: randomUUID(),
		companyId: profileId,
		environmentId,
		memberUserId: ownerUserId,
		...vmPolicy,
	};
	const plan = lxdCodingMachinePlan(machine);
	const layout = (workerId: string) => cloudCodingSessionLayout(workerId);
	const sessionDevices = (workerId: string) =>
		lxdCodingSessionDevices(lxdCodingSessionStorage(machine, placement, workerId));
	const files = new Map<string, { uid: number; gid: number; mode: number; content: Buffer }>();
	for (const [path, content] of [
		["/proc/sys/kernel/random/boot_id", `${bootId}\n`],
		["/opt/qorpera-coding/cloud-coding-command-guest.mjs", "command"],
		["/opt/qorpera-coding/cloud-coding-git-guest.mjs", "git"],
		["/opt/qorpera-coding/cloud-coding-watchdog.mjs", "watchdog"],
		["/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "storage"],
	])
		files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(content) });
	// The member's machine as LXD holds it.
	const lxd = { exists: false, running: false, devices: { ...plan.request.devices } as Devices };
	const state = {
		guestUid: 200000 as number | null,
		runRefusal: null as string | null,
		planRefusal: null as string | null,
		custodyRefusal: null as string | null,
		suspend: "suspended" as "suspended" | "kept",
		listed: [] as Listed[],
		applyDevices: true,
		installFailure: undefined as "before" | "after-storage" | "after-guest" | undefined,
	};
	const receipt = (intent: string, workerId: string | null, guestUid: number | null) => ({
		schema: "qorpera.coding-machine-admission/v1",
		machineId: machine.machineId,
		workerId,
		instanceSha256: plan.instanceSha256,
		intent,
		guestUid,
		validForMs: 5000,
		nodeId,
		nodeVersion: 1,
	});
	const leases = new Map<string, string>([[claim.workerId, claim.leaseToken]]);
	const call = vi.fn<LxdCodingExecutorHostOptions["control"]["call"]>(async (method, args) => {
		switch (method) {
			case "qorpera_plan_coding_machine":
				if (leases.get(String(args.p_worker_id)) !== args.p_lease_token)
					throw new Error("Coding session lease unavailable");
				if (state.planRefusal) return { state: "refused", reason: state.planRefusal };
				return {
					schema: "qorpera.coding-machine-plan/v1",
					state: "planned",
					machineId: machine.machineId,
					binding: machine,
				};
			case "qorpera_authorize_coding_machine_run":
				if (leases.get(String(args.p_worker_id)) !== args.p_lease_token)
					throw new Error("Coding session lease unavailable");
				if (args.p_binding_text !== plan.text) throw new Error("Coding machine binding differs");
				if (state.runRefusal) return { state: "refused", reason: state.runRefusal };
				return receipt("run", String(args.p_worker_id), state.guestUid);
			case "qorpera_authorize_coding_machine_custody": {
				if (args.p_owner !== "coding-host") throw new Error("Coding machine custody differs");
				if (state.custodyRefusal) return { state: "refused", reason: state.custodyRefusal };
				const listed = state.listed.find((entry) => entry.machineId === args.p_machine_id);
				return {
					...receipt(String(args.p_intent), (args.p_worker_id as string | null) ?? null, null),
					machineId: args.p_machine_id,
					instanceSha256: (listed?.instanceSha256 as string | undefined) ?? plan.instanceSha256,
				};
			}
			case "qorpera_suspend_coding_machine":
				return state.suspend === "kept"
					? { state: "kept", reason: "MACHINE_USED_SINCE_STOP" }
					: { schema: "qorpera.coding-machine-sleep/v1", state: "suspended", machineId: args.p_machine_id };
			case "qorpera_release_coding_machine":
				return { schema: "qorpera.coding-machine-release/v1", state: "released", machineId: args.p_machine_id };
			case "qorpera_list_coding_machines":
				return state.listed;
			case "qorpera_record_coding_machine_error":
				return null;
		}
		throw new Error(`Unexpected control method ${method}`);
	});
	const instance = (): LxdInstanceRecord | undefined =>
		lxd.exists
			? {
					name: plan.request.name,
					type: "virtual-machine",
					status: lxd.running ? "Running" : "Stopped",
					statusCode: lxd.running ? 103 : 102,
					profiles: [],
					config: { ...plan.request.config, "volatile.base_image": machine.imageFingerprint },
					expandedConfig: { ...plan.request.config, "volatile.base_image": machine.imageFingerprint },
					devices: structuredClone(lxd.devices),
					expandedDevices: structuredClone(lxd.devices),
				}
			: undefined;
	const configuration = (workerId: string, name: string) => `${layout(workerId).configurationRoot}/${name}`;
	const client: LxdCodingExecutorHostOptions["client"] = {
		getInstance: vi.fn(async () => instance()),
		submitInstanceOperation: vi.fn(),
		inspectInstanceOperation: vi.fn(),
		replaceInstanceDevices: vi.fn(async (_project, _name, devices) => {
			if (state.applyDevices) lxd.devices = structuredClone(devices) as Devices;
		}),
		readInstanceFile: vi.fn(async (_project, _name, path) => {
			const file = files.get(path);
			if (!file) throw new Error("Missing file");
			return file;
		}),
		pushInstanceFile: vi.fn(async (_project, _name, path, content, mode) => {
			files.set(path, { uid: 0, gid: 0, mode, content: Buffer.from(content) });
		}),
		execInstance: vi.fn(async (_project, _name, command) => {
			if (command[0] === "/usr/bin/mountpoint") {
				const path = command.at(-1);
				if (!Object.values(lxd.devices).some((device) => device.path === path))
					throw new Error("LXD instance command failed");
				return;
			}
			// systemctl is-failed exits non-zero for a timer that has not failed.
			if (command[1] === "is-failed") throw new Error("LXD instance command failed");
			if (command[1] !== "/opt/qorpera-coding/cloud-coding-storage-guest.mjs") return;
			const [action, workerId] = command.slice(2) as [string, string];
			if (action === "detach") {
				for (const name of ["guest.json", "storage.json", "configuration-inbox.json"])
					files.delete(configuration(workerId, name));
				return;
			}
			if (action !== "install") return;
			const fail = (phase: typeof state.installFailure) => {
				if (state.installFailure === phase) {
					state.installFailure = undefined;
					throw new Error("Guest installation reply lost");
				}
			};
			fail("before");
			const staged = files.get(configuration(workerId, "configuration-inbox.json"));
			if (!staged) throw new Error("Packet missing");
			const packet = JSON.parse(staged.content.toString("utf8"));
			if (packet.schema !== "qorpera.coding-configuration-install/v1") throw new Error("Packet schema differs");
			for (const name of ["storage", "guest"] as const) {
				const path = configuration(workerId, `${name}.json`);
				const content = Buffer.from(JSON.stringify(packet[name]));
				const existing = files.get(path);
				if (existing && !existing.content.equals(content)) throw new Error("Guest configuration drift");
				if (!existing) files.set(path, { uid: 0, gid: 0, mode: 0o444, content });
				fail(name === "storage" ? "after-storage" : "after-guest");
			}
		}),
	};
	mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
		const intent = input.desiredState === "running" ? "run" : input.desiredState === "stopped" ? "stop" : "delete";
		await input.authorize(intent, input.signal);
		if (input.desiredState === "running") {
			lxd.exists = true;
			lxd.running = true;
		} else if (input.desiredState === "stopped") lxd.running = false;
		else lxd.exists = false;
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
		machineIdSha256: placement.machineIdSha256,
		journalRoot: join(root, "control"),
		storagePolicy,
		client,
		vmPolicy,
		guest: {
			uid: 1100,
			gid: 1100,
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
	/** A second session of the same member, leased. */
	const another = () => {
		const other = session();
		leases.set(other.workerId, other.leaseToken);
		return other;
	};
	/** The machine as housekeeping lists it. */
	const entry = (patch: Listed = {}): Listed => ({
		schema: "qorpera.coding-machine-state/v1",
		machineId: machine.machineId,
		kind: "member",
		workerId: null,
		binding: machine,
		instanceSha256: plan.instanceSha256,
		live: false,
		reserved: true,
		asleepSince: null,
		removing: false,
		superseded: false,
		released: false,
		lastUsedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		lastError: null,
		lastErrorAt: null,
		sleepDue: false,
		removeDue: false,
		...patch,
	});
	const calls = (method: string) => call.mock.calls.filter((entry) => entry[0] === method).map((entry) => entry[1]);
	const execs = () => vi.mocked(client.execInstance).mock.calls.map((entry) => entry[2]);
	return {
		claim,
		turn: () => turnOf(claim),
		turnOf,
		another,
		renew: (of: CodingSessionClaim) => {
			of.leaseToken = randomUUID();
			leases.set(of.workerId, of.leaseToken);
		},
		options,
		host,
		call,
		calls,
		client,
		execs,
		files,
		lxd,
		state,
		machine,
		plan,
		placement,
		sessionDevices,
		layout,
		configuration,
		entry,
		signal,
		submission,
		baseSha,
		pullRequest,
		scope: (of: CodingSessionClaim = claim) => ({
			workerId: of.workerId,
			vmId: machine.machineId,
			requestId: codingHostId("turn", `${of.workerId}:${of.sequence}`),
			turn: of.sequence,
		}),
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function paidUsage(f: Fixture) {
	const call = f.call.getMockImplementation()!;
	f.call.mockImplementation(async (method, args, signal) => {
		const result = await call(method, args, signal);
		return method === "qorpera_authorize_coding_machine_run"
			? { ...(result as object), schema: "qorpera.coding-machine-admission/v2", fundingRequired: true }
			: result;
	});
	const reference = { project: f.machine.project, instanceName: f.plan.request.name, operationId: randomUUID() };
	return {
		ensure: vi.fn<CodingComputerUsage["ensure"]>(async () => {}),
		manages: vi.fn(() => true),
		ownsStart: vi.fn<CodingComputerUsage["ownsStart"]>(async () => true),
		abandonClaim: vi.fn<CodingComputerUsage["abandonClaim"]>(async () => {}),
		start: vi.fn(async () => reference),
		stop: vi.fn(async () => reference),
		observe: vi.fn(async () => {}),
		assertRunning: vi.fn<CodingComputerUsage["assertRunning"]>(async () => {}),
		maintain: vi.fn(async () => {}),
		externalStart: vi.fn(async () => null),
		externalStop: vi.fn(async () => null),
	} satisfies CodingComputerUsage;
}
const reconciled = () =>
	mocked.reconcile.mock.calls.map((call) => (call[0] as CodingMachineReconcileOptions).desiredState);

describe("a coding turn on its member's machine", () => {
	it("blocks already attached commands on a metering gap, recovers, and keeps detach available", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const authorize = vi.fn(async () => undefined);
		await host.commandTransport(f.scope(), authorize, f.signal);
		const transport = mocked.commandTransports.at(-1)!;
		usage.assertRunning.mockRejectedValue(new Error("CODING_COMPUTER_RUNNING_PERMIT_REQUIRED"));
		// A paid receipt cannot fall back to free work if local management was lost.
		usage.manages.mockReturnValue(false);
		await expect(
			transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal),
		).rejects.toMatchObject({ reason: "COMPUTER_USAGE_NOT_READY" });
		expect(authorize).not.toHaveBeenCalled();
		await host.commandTransport(f.scope(), authorize, f.signal);
		await transport.authorize("cancel", f.scope(), randomUUID(), "a".repeat(64), f.signal);
		expect(authorize).toHaveBeenCalledOnce();
		authorize.mockClear();
		usage.assertRunning.mockResolvedValue(undefined);
		await transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal);
		expect(authorize).toHaveBeenCalledOnce();
		usage.assertRunning.mockRejectedValue(new Error("CODING_COMPUTER_RUNNING_PERMIT_REQUIRED"));
		await host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
	});
	it("refuses paid admission before any VM effect when the independent guard is missing", async () => {
		const f = await fixture();
		const call = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) => {
			const result = await call(method, args, signal);
			return method === "qorpera_authorize_coding_machine_run"
				? { ...(result as object), schema: "qorpera.coding-machine-admission/v2", fundingRequired: true }
				: result;
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"PAID_COMPUTER_GUARD_REQUIRED",
		);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
	});
	it("routes paid start through the guard after funding and observes before preparing session work", async () => {
		const f = await fixture();
		const usage = paidUsage(f);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		const reconcile = mocked.reconcile.getMockImplementation()!;
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			await input.authorize("run", input.signal);
			await input.client.submitInstanceOperation(
				f.machine.project,
				{ action: "start", name: f.plan.request.name },
				input.signal,
			);
			return reconcile(input);
		});
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(usage.start).toHaveBeenCalledTimes(1);
		expect(usage.ensure.mock.invocationCallOrder[0]).toBeLessThan(usage.start.mock.invocationCallOrder[0]);
		expect(usage.observe.mock.invocationCallOrder[0]).toBeLessThan(mocked.seedTransfer.mock.invocationCallOrder[0]);
		expect(usage.observe.mock.invocationCallOrder[0]).toBeLessThan(usage.assertRunning.mock.invocationCallOrder[0]);
		expect(usage.assertRunning.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(f.client.replaceInstanceDevices).mock.invocationCallOrder[0],
		);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("defers without attaching or starting session work until the first paid observation is confirmed", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		usage.assertRunning.mockRejectedValueOnce(new Error("CODING_COMPUTER_RUNNING_PERMIT_REQUIRED"));
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		const error = await host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(CodingMachineUnavailable);
		expect(error).toMatchObject({ reason: "COMPUTER_USAGE_NOT_READY" });
		expect(usage.observe).toHaveBeenCalledOnce();
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		expect(mocked.resolveBase).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
		await expect(host.commandTransport(f.scope(), async () => undefined, f.signal)).rejects.toThrow("NOT_PREPARED");
		// A later attempt after confirmed metering may prepare the same session.
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.client.replaceInstanceDevices).toHaveBeenCalledOnce();
		expect(mocked.seedTransfer).toHaveBeenCalledOnce();
	});
	it("does not turn unrelated paid confirmation failures into queue retries", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		const error = new Error("COMPUTER_GUARD_USAGE_CANONICAL_TIP_DIFFERS");
		usage.assertRunning.mockRejectedValueOnce(error);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		await expect(host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toBe(error);
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
	});
	it("keeps the session unattached while first paid confirmation is delayed", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		usage.assertRunning.mockImplementationOnce(async () => held);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		const preparing = host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await vi.waitFor(() => expect(usage.assertRunning).toHaveBeenCalledOnce());
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
		release?.();
		await preparing;
		expect(f.client.replaceInstanceDevices).toHaveBeenCalledOnce();
		expect(mocked.seedTransfer).toHaveBeenCalledOnce();
	});
	it("retains guard-only start ownership after in-memory paid management disappears", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		usage.manages.mockReturnValue(false);
		usage.start.mockRejectedValue(new Error("COMPUTER_PRESTART_ABANDONED"));
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			await input.authorize("run", input.signal);
			await input.client.submitInstanceOperation(
				f.machine.project,
				{ action: "start", name: f.plan.request.name },
				input.signal,
			);
			return { state: "running" };
		});
		await expect(host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("COMPUTER_PRESTART_ABANDONED");
		expect(usage.ownsStart).toHaveBeenCalledWith(f.machine.machineId, expect.any(AbortSignal));
		expect(usage.start).toHaveBeenCalledOnce();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
	});
	it("reconciles a failed paid prepare through abandonment before returning its original failure", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		const failure = new Error("PREPARE_REPLY_LOST");
		usage.ensure.mockRejectedValueOnce(failure);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		await expect(host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toBe(failure);
		expect(usage.abandonClaim).toHaveBeenCalledWith(f.claim, f.machine, expect.any(AbortSignal));
		expect(usage.abandonClaim.mock.calls[0][2].aborted).toBe(false);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("reports both prepare and unresolved abandonment failures without implying cancellation", async () => {
		const f = await fixture(),
			usage = paidUsage(f);
		const failure = new Error("PREPARE_REPLY_LOST"),
			recovery = new Error("GUARD_UNAVAILABLE");
		usage.ensure.mockRejectedValueOnce(failure);
		usage.abandonClaim.mockRejectedValueOnce(recovery);
		const host = new LxdCodingExecutorHost({ ...f.options, computerUsage: usage });
		const outcome = await host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
		expect(outcome).toBeInstanceOf(AggregateError);
		expect((outcome as AggregateError).errors).toEqual([failure, recovery]);
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("wakes the member's machine, attaches the session, and runs the pinned seed, push and draft PR", async () => {
		const f = await fixture();
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace).toEqual({ vmId: f.machine.machineId, baseSha: f.baseSha });
		await f.host.refreshLease(f.claim, f.signal);
		expect(await f.host.publish(f.claim, f.submission, f.signal)).toEqual({
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		expect(mocked.push.mock.invocationCallOrder[0]).toBeLessThan(mocked.publish.mock.invocationCallOrder[0]);
		expect(mocked.publish.mock.calls[0]?.[0]).toMatchObject({
			title: "Fix the delay after send",
			body: "Tests passed",
		});
		// Started under the machine's journal, then the session's folders hot-plugged.
		expect(reconciled()).toEqual(["running"]);
		const journal = (mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions).plan;
		expect(journal).toMatchObject({ machineId: f.machine.machineId, journalName: f.machine.machineId });
		expect(vi.mocked(f.client.replaceInstanceDevices).mock.calls).toEqual([
			[
				"coding",
				f.plan.request.name,
				{ ...f.plan.request.devices, ...f.sessionDevices(f.claim.workerId) },
				f.signal,
			],
		]);
		const layout = f.layout(f.claim.workerId);
		// The guest is up (agent, watchdog, pinned helpers, no self-update) before anything is hot-plugged.
		expect(f.execs()).toEqual([
			["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "image"],
			["/usr/bin/systemctl", "is-active", "--quiet", "qorpera-coding-watchdog.timer"],
			["/usr/bin/mountpoint", "--quiet", layout.dataRoot],
			["/usr/bin/mountpoint", "--quiet", layout.custodyRoot],
			...["prepare", "install", "initialize"].map((action) => [
				"/usr/bin/node",
				"/opt/qorpera-coding/cloud-coding-storage-guest.mjs",
				action,
				f.claim.workerId,
			]),
		]);
		expect(JSON.stringify(vi.mocked(f.client.pushInstanceFile).mock.calls)).not.toContain("test-token");
		expect(vi.mocked(f.client.pushInstanceFile).mock.calls.map((call) => call[2])).toEqual([
			f.configuration(f.claim.workerId, "configuration-inbox.json"),
		]);
		const packet = JSON.parse(
			f.files.get(f.configuration(f.claim.workerId, "configuration-inbox.json"))!.content.toString(),
		);
		expect(packet).toMatchObject({
			schema: "qorpera.coding-configuration-install/v1",
			guest: {
				schema: "qorpera.coding-command-guest/v3",
				workerId: f.claim.workerId,
				vmId: f.machine.machineId,
				uid: 200000,
				gid: 200000,
				workspacePath: layout.workspacePath,
				homePath: layout.homePath,
				cachePath: layout.cachePath,
				outputRoot: layout.outputRoot,
			},
			storage: { workerId: f.claim.workerId, companyId: f.claim.profileId },
		});
		// Every effect is authorized by the session's own lease on the exact machine and volume.
		for (const args of f.calls("qorpera_authorize_coding_machine_run"))
			expect(args).toMatchObject({
				p_worker_id: f.claim.workerId,
				p_lease_token: f.claim.leaseToken,
				p_binding_text: f.plan.text,
				p_storage: packet.storage,
				p_machine_id_sha256: "f".repeat(64),
			});
		expect(f.calls("qorpera_plan_coding_machine")).toEqual([
			{ p_worker_id: f.claim.workerId, p_lease_token: f.claim.leaseToken, p_machine_id_sha256: "f".repeat(64) },
		]);
	});
	it("runs a session whose NAS volume predates member machines as the image's coding user", async () => {
		const f = await fixture();
		f.state.guestUid = null;
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const packet = JSON.parse(
			f.files.get(f.configuration(f.claim.workerId, "configuration-inbox.json"))!.content.toString(),
		);
		expect(packet.guest).toMatchObject({ uid: 1100, gid: 1100 });
	});
	it("refuses a receipt that would run a session as a low guest uid", async () => {
		const f = await fixture();
		f.state.guestUid = 1500;
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_MACHINE_ADMISSION_UNCONFIRMED",
		);
		expect(mocked.reconcile).not.toHaveBeenCalled();
	});
	it("runs a second session of the same member on the same machine, each in its own folders", async () => {
		const f = await fixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const workspace = await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		expect(workspace.vmId).toBe(f.machine.machineId);
		expect(f.lxd.devices).toEqual({
			...f.plan.request.devices,
			...f.sessionDevices(f.claim.workerId),
			...f.sessionDevices(second.workerId),
		});
		expect(f.files.has(f.configuration(second.workerId, "guest.json"))).toBe(true);
		// Detaching one leaves the other attached and prepared.
		await f.host.detachSession(second, f.signal);
		expect(f.lxd.devices).toEqual({ ...f.plan.request.devices, ...f.sessionDevices(f.claim.workerId) });
		expect(f.lxd.running).toBe(true);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		await expect(f.host.commandTransport(f.scope(second), async () => undefined, f.signal)).rejects.toThrow(
			"NOT_PREPARED",
		);
	});
	it("keeps the lifecycle of one machine serial while two sessions attach at once", async () => {
		const f = await fixture();
		const second = f.another();
		let active = 0,
			maximum = 0;
		const apply = vi.mocked(f.client.replaceInstanceDevices).getMockImplementation()!;
		vi.mocked(f.client.replaceInstanceDevices).mockImplementation(async (...args) => {
			maximum = Math.max(maximum, ++active);
			await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
			await apply(...args);
			active--;
		});
		await Promise.all([
			f.host.prepareWorkspace(f.claim, f.turn(), f.signal),
			f.host.prepareWorkspace(second, f.turnOf(second), f.signal),
		]);
		expect(maximum).toBe(1);
		expect(Object.keys(f.lxd.devices).sort()).toEqual(
			Object.keys({
				...f.plan.request.devices,
				...f.sessionDevices(f.claim.workerId),
				...f.sessionDevices(second.workerId),
			}).sort(),
		);
	});
	it.each([
		"NODE_CAPACITY_EXHAUSTED",
		"MACHINE_RETIRING",
		"LEGACY_SESSION_BUSY",
		"PREVIOUS_MACHINE_AWAKE",
		"MACHINE_PLAN_CHANGED",
	])("waits out a %s refusal in the queue instead of failing the turn", async (reason) => {
		const f = await fixture();
		f.state.runRefusal = reason;
		const error = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CodingMachineUnavailable);
		expect((error as CodingMachineUnavailable).reason).toBe(reason);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		const g = await fixture();
		g.state.planRefusal = reason;
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toBeInstanceOf(
			CodingMachineUnavailable,
		);
	});
	it("fails the turn on any other refusal", async () => {
		const f = await fixture();
		f.state.runRefusal = "MACHINE_POLICY_DIFFERS";
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_MACHINE_REFUSED:MACHINE_POLICY_DIFFERS",
		);
		const g = await fixture();
		g.state.planRefusal = "SESSION_NOT_READY";
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			"CODING_HOST_MACHINE_PLAN_REFUSED",
		);
	});
	it.each([
		["another member", { memberUserId: randomUUID() }],
		["another company", { companyId: randomUUID() }],
		["another policy", { cpus: 2 }],
	])("refuses a planned machine of %s", async (_label, patch) => {
		const f = await fixture();
		f.call.mockImplementationOnce(async () => ({
			schema: "qorpera.coding-machine-plan/v1",
			state: "planned",
			machineId: f.machine.machineId,
			binding: { ...f.machine, ...patch },
		}));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_MACHINE_POLICY_DIFFERS",
		);
		expect(mocked.reconcile).not.toHaveBeenCalled();
	});
	it("judges an uncertain attach from the machine, and refuses one that did not happen", async () => {
		const f = await fixture();
		const apply = vi.mocked(f.client.replaceInstanceDevices).getMockImplementation()!;
		vi.mocked(f.client.replaceInstanceDevices).mockImplementationOnce(async (...args) => {
			await apply(...args);
			throw new Error("LXD reply lost");
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const g = await fixture();
		g.state.applyDevices = false;
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			"CODING_SESSION_ATTACH_UNCONFIRMED",
		);
		expect(g.execs().filter((command) => command[0] === "/usr/bin/node" && command[2] !== "image")).toEqual([]);
	});
	it("refuses to install a session's configuration for a boot other than the one it checked", async () => {
		const f = await fixture();
		const read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!;
		let boots = 0;
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			const file = await read(project, name, path, limit, signal);
			return path === "/proc/sys/kernel/random/boot_id" && ++boots > 1
				? { ...file, content: Buffer.from(`${randomUUID()}\n`) }
				: file;
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("CODING_MACHINE_BOOT_CHANGED");
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
	});
	it("waits until the guest has mounted both folders, bounded", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let unmounted = 2;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint" && unmounted-- > 0) throw new Error("LXD instance command failed");
			return fallback(project, name, command, signal);
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const g = await fixture();
		vi.mocked(g.client.execInstance).mockImplementation(async (_project, _name, command) => {
			if (command[0] === "/usr/bin/mountpoint") throw new Error("LXD instance command failed");
		});
		const impatient = new LxdCodingExecutorHost({ ...g.options, attachTimeoutMs: 50 });
		await expect(impatient.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			"CODING_SESSION_ATTACH_UNCONFIRMED",
		);
	});
	it("refuses a machine carrying anything but whole session folders of its own company", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.lxd.devices = { ...f.lxd.devices, secrets: { type: "disk", source: "/etc", path: "/mnt/etc" } };
		const second = f.another();
		await expect(f.host.prepareWorkspace(second, f.turnOf(second), f.signal)).rejects.toThrow(
			"CODING_MACHINE_DRIFTED",
		);
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
		const inbox = f.configuration(f.claim.workerId, "configuration-inbox.json");
		expect(vi.mocked(f.client.pushInstanceFile).mock.calls.map((call) => call[2])).toEqual([inbox, inbox]);
		// The session was attached once; the retry finds it attached.
		expect(f.client.replaceInstanceDevices).toHaveBeenCalledTimes(1);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
	});
	it.each(["before", "after-storage", "after-guest"] as const)(
		"resumes installation after %s failure without directly overwriting active files",
		async (phase) => {
			const f = await fixture();
			f.state.installFailure = phase;
			await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("installation reply lost");
			expect(mocked.seedFetch).not.toHaveBeenCalled();
			expect(f.execs().some((command) => command[2] === "initialize")).toBe(false);
			const installedStorage = f.files.get(f.configuration(f.claim.workerId, "storage.json"));
			const installedGuest = f.files.get(f.configuration(f.claim.workerId, "guest.json"));
			await new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.turn(), f.signal);
			if (installedStorage)
				expect(f.files.get(f.configuration(f.claim.workerId, "storage.json"))).toBe(installedStorage);
			if (installedGuest) expect(f.files.get(f.configuration(f.claim.workerId, "guest.json"))).toBe(installedGuest);
			expect(f.execs().filter((command) => command[2] === "install")).toHaveLength(2);
			expect(f.execs().filter((command) => command[2] === "initialize")).toHaveLength(1);
		},
	);
	it.each(["guest", "storage"])(
		"independently verifies installed %s protection before initialization",
		async (name) => {
			const f = await fixture();
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			f.files.get(f.configuration(f.claim.workerId, `${name}.json`))!.mode = 0o644;
			vi.mocked(f.client.execInstance).mockClear();
			await expect(
				new LxdCodingExecutorHost(f.options).prepareWorkspace(f.claim, f.turn(), f.signal),
			).rejects.toThrow(name === "guest" ? "GUEST_CONFIGURATION_UNCONFIRMED" : "GUEST_STORAGE_UNCONFIRMED");
			expect(f.execs().filter((command) => command[2] === "initialize")).toHaveLength(0);
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
	it("keeps seed, base and folders across a follow-up turn and never resets the repository", async () => {
		const f = await fixture();
		const first = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
		f.renew(f.claim);
		f.claim.sequence = 2;
		const second = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(second.vmId).toBe(first.vmId);
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		expect(f.client.replaceInstanceDevices).toHaveBeenCalledTimes(3);
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
	it("rejects command transport scope changes and publication before preparation", async () => {
		const f = await fixture();
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("NOT_PREPARED");
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await expect(f.host.commandTransport({ ...f.scope(), turn: 2 }, async () => undefined, f.signal)).rejects.toThrow(
			"NOT_PREPARED",
		);
	});
	it("refuses a configuration without pinned helpers", () => {
		expect(
			() =>
				new LxdCodingExecutorHost({
					control: { call: vi.fn() },
					owner: "coding-host",
					machineIdSha256: "f".repeat(64),
					journalRoot: "/srv/control",
					storagePolicy: {
						schema: "qorpera.coding-nas-policy/v1",
						mountPoint: "/srv",
						rootPath: "/srv",
						source: "192.168.1.40:/coding",
						serverAddress: "192.168.1.40",
					},
					client: {} as LxdCodingExecutorHostOptions["client"],
					vmPolicy: {
						providerId: "coding",
						providerPolicySha256: "a".repeat(64),
						project: "coding",
						imageFingerprint: "b".repeat(64),
						bootstrapSha256: "c".repeat(64),
						storagePool: "coding",
						network: "coding",
						cpus: 4,
						memoryBytes: 8589934592,
						rootDiskBytes: 34359738368,
					},
					guest: {
						uid: 1100,
						gid: 1100,
						storageHelperSha256: "latest",
						commandHelperSha256: "a".repeat(64),
						gitHelperSha256: "a".repeat(64),
						watchdogHelperSha256: "a".repeat(64),
						resourceProfile: {
							maxTimeoutMs: 1800000,
							memoryBytes: 2147483648,
							tasksMax: 256,
							cpuQuotaPercent: 200,
							maxLogBytes: 67108864,
						},
					},
					repositoryCredentials: { withRepositoryToken: vi.fn() },
				}),
		).toThrow("CODING_HOST_CONFIGURATION_INVALID");
	});
});
describe("the host's own configuration", () => {
	it.each([
		["a helper that is not pinned", { storageHelperSha256: "latest" }],
		["an image user inside the session uid range", { uid: 200000 }],
		["an image group inside the session uid range", { gid: 200001 }],
	])("is refused with %s", async (_label, guest) => {
		const f = await fixture();
		expect(() => new LxdCodingExecutorHost({ ...f.options, guest: { ...f.options.guest, ...guest } })).toThrow(
			"CODING_HOST_CONFIGURATION_INVALID",
		);
	});
});

describe("a freshly started member machine's guest", () => {
	it("fails before the turn if the watchdog artifact or timer differs", async () => {
		const f = await fixture();
		f.files.get("/opt/qorpera-coding/cloud-coding-watchdog.mjs")!.content = Buffer.from("changed");
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("ARTIFACT_CHANGED");
		const g = await fixture();
		const fallback = vi.mocked(g.client.execInstance).getMockImplementation()!;
		vi.mocked(g.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint" || command[1] === "is-enabled")
				return fallback(project, name, command, signal);
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
		const verbs = f.execs().map((command) => command[1]);
		expect(verbs.filter((verb) => verb === "is-active").length).toBeGreaterThanOrEqual(3);
		expect(verbs).not.toContain("is-failed");
		expect(verbs).not.toContain("is-enabled");
	});
	it("gives up with CODING_HOST_GUEST_NOT_READY when the guest's agent never comes up", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint") return fallback(project, name, command, signal);
			throw new Error("LXD instance agent not running");
		});
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
	it("re-reads the machine between readiness checks: one stopped elsewhere fails without waiting out the window", async () => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let checked = 0;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint") return fallback(project, name, command, signal);
			checked++;
			f.lxd.running = false;
			throw new Error("LXD instance agent not running");
		});
		const started = performance.now();
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("CODING_HOST_VM_NOT_RUNNING");
		expect(performance.now() - started).toBeLessThan(10000);
		expect(checked).toBe(1);
	});
	it("the caller's abort during the readiness wait wins over NOT_READY", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint" || command[1] === "is-enabled")
				return fallback(project, name, command, signal);
			if (command[1] === "is-active")
				globalThis.setTimeout(() => controller.abort(new Error("CODING_EXECUTOR_LEASE_LOST")), 100);
			throw new Error("LXD instance command failed");
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), controller.signal)).rejects.toThrow(
			"CODING_EXECUTOR_LEASE_LOST",
		);
		expect(f.execs().filter((command) => command[1] === "is-active")).toHaveLength(1);
	});
	it.each([
		["failed", "is-failed", "CODING_HOST_GUEST_WATCHDOG_FAILED"],
		["masked or disabled", "is-enabled", "CODING_HOST_GUEST_WATCHDOG_DISABLED"],
	])("fails at once when the watchdog timer is %s instead of waiting it out", async (_state, verb, code) => {
		const f = await fixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/mountpoint") return fallback(project, name, command, signal);
			if (command[1] === "is-active") throw new Error("LXD instance command failed");
			if (command[1] === "is-failed" && verb === "is-failed") return;
			if (command[1] === "is-failed" || command[1] === verb) throw new Error("LXD instance command failed");
		});
		const started = performance.now();
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(code);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(f.execs().filter((command) => command[1] === "is-active")).toHaveLength(1);
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
});

describe("the end of a session's turn", () => {
	it("stops the session inside the guest, then unplugs its folders under detach custody; the machine keeps running", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		f.call.mockClear();
		await f.host.detachSession(f.claim, f.signal);
		expect(f.execs()).toEqual([
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", f.claim.workerId],
		]);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
		expect(f.lxd.running).toBe(true);
		expect(mocked.reconcile).toHaveBeenCalledTimes(1);
		const custody = f.calls("qorpera_authorize_coding_machine_custody");
		expect(custody).toHaveLength(2);
		for (const args of custody)
			expect(args).toEqual({
				p_machine_id: f.machine.machineId,
				p_owner: "coding-host",
				p_binding_text: f.plan.text,
				p_machine_id_sha256: "f".repeat(64),
				p_intent: "detach",
				p_worker_id: f.claim.workerId,
				p_lease_token: f.claim.leaseToken,
			});
		const guestDetach = vi.mocked(f.client.execInstance).mock.invocationCallOrder[0]!;
		expect(guestDetach).toBeLessThan(vi.mocked(f.client.replaceInstanceDevices).mock.invocationCallOrder.at(-1)!);
		await expect(f.host.refreshLease(f.claim, f.signal)).rejects.toThrow("NOT_PREPARED");
	});
	it("unplugs a session whose preparation failed or had to wait after its folders were attached", async () => {
		const f = await fixture();
		mocked.seedFetch.mockRejectedValueOnce(new Error("CODING_GIT_SEED_UNCONFIRMED"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("SEED_UNCONFIRMED");
		expect(f.lxd.devices).toEqual({ ...f.plan.request.devices, ...f.sessionDevices(f.claim.workerId) });
		await f.host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
		expect(f.execs().at(-1)).toEqual([
			"/usr/bin/node",
			"/opt/qorpera-coding/cloud-coding-storage-guest.mjs",
			"detach",
			f.claim.workerId,
		]);
		// A deferral after the attach (the node's observation lapsed mid-preparation) leaves nothing attached either.
		const g = await fixture();
		const push = vi.mocked(g.client.pushInstanceFile).getMockImplementation()!;
		vi.mocked(g.client.pushInstanceFile).mockImplementationOnce(async (...args) => {
			g.state.runRefusal = "NODE_OBSERVATION_UNAVAILABLE";
			return push(...args);
		});
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toBeInstanceOf(
			CodingMachineUnavailable,
		);
		g.state.runRefusal = null;
		await g.host.detachSession(g.claim, g.signal);
		expect(g.lxd.devices).toEqual(g.plan.request.devices);
	});
	it("starts no new command once the session's detach has begun", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		const [transport] = mocked.commandTransports;
		await transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal);
		f.state.custodyRefusal = "SESSION_IN_USE";
		await expect(f.host.detachSession(f.claim, f.signal)).rejects.toThrow("CUSTODY_REFUSED");
		f.call.mockClear();
		await expect(transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal)).rejects.toThrow(
			"CODING_HOST_TURN_NOT_PREPARED",
		);
		expect(f.calls("qorpera_authorize_coding_machine_run")).toEqual([]);
		// The detach itself can still be completed.
		f.state.custodyRefusal = null;
		await f.host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
	});
	it("leaves a session this process never prepared to housekeeping", async () => {
		const f = await fixture();
		await f.host.detachSession(f.claim, f.signal);
		expect(f.call).not.toHaveBeenCalled();
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it("still unplugs the folders when the guest step fails, and reports the failure", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockRejectedValueOnce(new Error("CODING_GUEST_SESSION_STOP_UNCONFIRMED"));
		await expect(f.host.detachSession(f.claim, f.signal)).rejects.toThrow("STOP_UNCONFIRMED");
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
	});
	it("refuses to report an unplug that did not happen", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.state.applyDevices = false;
		await expect(f.host.detachSession(f.claim, f.signal)).rejects.toThrow("CODING_SESSION_DETACH_UNCONFIRMED");
		f.state.applyDevices = true;
		await f.host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
	});
	it("skips the guest step on a machine that is not running and is done when the machine is gone", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		f.lxd.running = false;
		await f.host.detachSession(f.claim, f.signal);
		expect(f.client.execInstance).not.toHaveBeenCalled();
		expect(f.lxd.devices).toEqual(f.plan.request.devices);
		const g = await fixture();
		await g.host.prepareWorkspace(g.claim, g.turn(), g.signal);
		g.lxd.exists = false;
		vi.mocked(g.client.replaceInstanceDevices).mockClear();
		await g.host.detachSession(g.claim, g.signal);
		expect(g.client.replaceInstanceDevices).not.toHaveBeenCalled();
		await expect(g.host.refreshLease(g.claim, g.signal)).rejects.toThrow("NOT_PREPARED");
	});
	it("does nothing while SQL refuses detach custody", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		vi.mocked(f.client.execInstance).mockClear();
		f.state.custodyRefusal = "SESSION_IN_USE";
		await expect(f.host.detachSession(f.claim, f.signal)).rejects.toThrow(
			"CODING_MACHINE_CUSTODY_REFUSED:SESSION_IN_USE",
		);
		expect(f.client.execInstance).not.toHaveBeenCalled();
		expect(f.lxd.devices).toEqual({ ...f.plan.request.devices, ...f.sessionDevices(f.claim.workerId) });
	});
});

describe("housekeeping of a member's machines", () => {
	async function awake(f: Fixture) {
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// A session left attached by a process that stopped before its detach.
		mocked.reconcile.mockClear();
		vi.mocked(f.client.execInstance).mockClear();
		vi.mocked(f.client.replaceInstanceDevices).mockClear();
		f.call.mockClear();
	}
	it("does nothing for machines not due", async () => {
		const f = await fixture();
		f.state.listed = [f.entry(), f.entry({ machineId: randomUUID(), live: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([]);
		expect(f.calls("qorpera_list_coding_machines")).toEqual([
			{ p_owner: "coding-host", p_machine_id_sha256: "f".repeat(64) },
		]);
		expect(mocked.reconcile).not.toHaveBeenCalled();
	});
	it("puts an idle machine to sleep: sessions stopped and flushed, powered off, folders unplugged, capacity suspended", async () => {
		const f = await fixture();
		await awake(f);
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "done" },
		]);
		expect(f.execs()).toEqual([["/usr/bin/systemctl", "stop", "qorpera-coding.slice"], ["/usr/bin/sync"]]);
		expect(reconciled()).toEqual(["stopped"]);
		expect(vi.mocked(f.client.execInstance).mock.invocationCallOrder.at(-1)).toBeLessThan(
			mocked.reconcile.mock.invocationCallOrder[0]!,
		);
		expect(f.lxd).toMatchObject({ exists: true, running: false, devices: f.plan.request.devices });
		const stops = f.calls("qorpera_authorize_coding_machine_custody");
		expect(stops.length).toBeGreaterThanOrEqual(2);
		for (const args of stops)
			expect(args).toMatchObject({ p_intent: "stop", p_worker_id: null, p_lease_token: null });
		expect(f.calls("qorpera_suspend_coding_machine")).toEqual([
			{
				p_machine_id: f.machine.machineId,
				p_owner: "coding-host",
				p_binding_text: f.plan.text,
				p_machine_id_sha256: "f".repeat(64),
			},
		]);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([]);
	});
	it("still powers off when the quiesce fails or the agent is gone, and skips it for a stopped machine", async () => {
		const f = await fixture();
		await awake(f);
		vi.mocked(f.client.execInstance).mockRejectedValueOnce(new Error("LXD instance command failed"));
		f.state.listed = [f.entry({ sleepDue: true })];
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(f.execs().map((command) => command.at(-1))).toEqual(["qorpera-coding.slice", "/usr/bin/sync"]);
		const g = await fixture();
		await awake(g);
		vi.mocked(g.client.execInstance).mockRejectedValue(new Error("LXD instance agent not running"));
		g.state.listed = [g.entry({ sleepDue: true })];
		expect((await g.host.housekeep(g.signal))[0]?.state).toBe("done");
		expect(g.execs()).toEqual([["/usr/bin/systemctl", "stop", "qorpera-coding.slice"]]);
		const h = await fixture();
		await awake(h);
		h.lxd.running = false;
		h.state.listed = [h.entry({ sleepDue: true })];
		expect((await h.host.housekeep(h.signal))[0]?.state).toBe("done");
		expect(h.client.execInstance).not.toHaveBeenCalled();
		expect(reconciled()).toEqual(["stopped"]);
	});
	it("polls a pending stop until it settles", async () => {
		const f = await fixture();
		await awake(f);
		const settle = mocked.reconcile.getMockImplementation()!;
		mocked.reconcile
			.mockResolvedValueOnce({ state: "pending" })
			.mockResolvedValueOnce({ state: "pending" })
			.mockImplementation(settle);
		f.state.listed = [f.entry({ sleepDue: true })];
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(mocked.reconcile).toHaveBeenCalledTimes(3);
	});
	it("reports a turn that took the machine in the meantime as not now, and writes no error", async () => {
		const f = await fixture();
		await awake(f);
		f.state.custodyRefusal = "MACHINE_IN_USE";
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "not-now", code: "MACHINE_IN_USE" },
		]);
		expect(mocked.reconcile).not.toHaveBeenCalled();
		expect(f.lxd.running).toBe(true);
		const g = await fixture();
		await awake(g);
		g.state.suspend = "kept";
		g.state.listed = [g.entry({ sleepDue: true })];
		expect(await g.host.housekeep(g.signal)).toEqual([
			{ machineId: g.machine.machineId, step: "sleep", state: "not-now", code: "MACHINE_USED_SINCE_STOP" },
		]);
		expect(g.calls("qorpera_record_coding_machine_error")).toEqual([]);
	});
	it("writes a failed step to the machine, never hides it, and clears it after a later success", async () => {
		const f = await fixture();
		await awake(f);
		mocked.reconcile.mockResolvedValueOnce({ state: "recovery-required" });
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "failed", code: "CODING_HOST_VM_RECOVERY_REQUIRED" },
		]);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			{
				p_machine_id: f.machine.machineId,
				p_owner: "coding-host",
				p_machine_id_sha256: "f".repeat(64),
				p_stage: "sleep",
				p_code: "CODING_HOST_VM_RECOVERY_REQUIRED",
			},
		]);
		f.call.mockClear();
		f.state.listed = [f.entry({ sleepDue: true, lastError: "sleep:CODING_HOST_VM_RECOVERY_REQUIRED" })];
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_stage: "sleep", p_code: null }),
		]);
	});
	it("names an unexpected failure UNCLASSIFIED", async () => {
		const f = await fixture();
		await awake(f);
		mocked.reconcile.mockRejectedValueOnce(new Error("socket hang up"));
		f.state.listed = [f.entry({ sleepDue: true })];
		expect((await f.host.housekeep(f.signal))[0]).toMatchObject({ state: "failed", code: "UNCLASSIFIED" });
	});
	it("removes an awake machine due for removal: sleep, journaled delete, then release", async () => {
		const f = await fixture();
		await awake(f);
		f.state.listed = [f.entry({ removeDue: true, superseded: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "delete", state: "done" },
		]);
		expect(reconciled()).toEqual(["stopped", "deleted"]);
		expect(f.lxd.exists).toBe(false);
		const order = (method: string) =>
			f.call.mock.invocationCallOrder[f.call.mock.calls.findIndex((c) => c[0] === method)]!;
		expect(order("qorpera_suspend_coding_machine")).toBeLessThan(mocked.reconcile.mock.invocationCallOrder[1]!);
		expect(order("qorpera_release_coding_machine")).toBeGreaterThan(mocked.reconcile.mock.invocationCallOrder[1]!);
		expect(
			f.calls("qorpera_authorize_coding_machine_custody").filter((args) => args.p_intent === "delete").length,
		).toBeGreaterThanOrEqual(1);
		expect(f.calls("qorpera_release_coding_machine")).toEqual([
			{
				p_machine_id: f.machine.machineId,
				p_owner: "coding-host",
				p_binding_text: f.plan.text,
				p_machine_id_sha256: "f".repeat(64),
			},
		]);
	});
	it("deletes an asleep machine without waking it", async () => {
		const f = await fixture();
		await awake(f);
		f.lxd.running = false;
		f.state.listed = [f.entry({ removeDue: true, reserved: false, asleepSince: new Date().toISOString() })];
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(reconciled()).toEqual(["deleted"]);
		expect(f.calls("qorpera_suspend_coding_machine")).toEqual([]);
		expect(f.calls("qorpera_release_coding_machine")).toHaveLength(1);
	});
	it("does not release a machine whose delete is not proven", async () => {
		const f = await fixture();
		await awake(f);
		f.lxd.running = false;
		mocked.reconcile.mockResolvedValueOnce({ state: "stopped" });
		f.state.listed = [f.entry({ removeDue: true, reserved: false, asleepSince: new Date().toISOString() })];
		expect((await f.host.housekeep(f.signal))[0]).toMatchObject({
			step: "delete",
			state: "failed",
			code: "CODING_HOST_VM_RECOVERY_REQUIRED",
		});
		expect(f.calls("qorpera_release_coding_machine")).toEqual([]);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_stage: "delete", p_code: "CODING_HOST_VM_RECOVERY_REQUIRED" }),
		]);
	});
	it("records a release that fails after the delete as its own step", async () => {
		const f = await fixture();
		await awake(f);
		f.lxd.running = false;
		const control = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_release_coding_machine" ? { state: "kept" } : control(method, args, signal),
		);
		f.state.listed = [f.entry({ removeDue: true, reserved: false, asleepSince: new Date().toISOString() })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				step: "release",
				state: "failed",
				code: "CODING_MACHINE_RELEASE_UNCONFIRMED",
			},
		]);
		expect(f.lxd.exists).toBe(false);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_stage: "release", p_code: "CODING_MACHINE_RELEASE_UNCONFIRMED" }),
		]);
	});
	it("closes a machine released elsewhere, or never given capacity, without touching LXD", async () => {
		for (const patch of [
			{ released: true, reserved: false },
			{ removeDue: true, reserved: false, asleepSince: null },
			{ removeDue: true, instanceSha256: null, reserved: false },
		]) {
			const f = await fixture();
			f.state.listed = [f.entry(patch)];
			expect(await f.host.housekeep(f.signal)).toEqual([
				{ machineId: f.machine.machineId, step: "delete", state: "done" },
			]);
			expect(mocked.reconcile).not.toHaveBeenCalled();
			expect(f.client.getInstance).not.toHaveBeenCalled();
			expect(f.calls("qorpera_release_coding_machine")).toHaveLength(1);
		}
	});
	it("retires a kept per-session VM from before member machines under its own journal", async () => {
		const f = await fixture();
		const workerId = randomUUID(),
			allocationId = randomUUID();
		const legacy: LxdCodingVmBinding = {
			schema: "qorpera.lxd-coding-vm/v2",
			workerId,
			allocationId,
			companyId: f.machine.companyId,
			environmentId: f.machine.environmentId,
			providerId: "coding",
			providerPolicySha256: "a".repeat(64),
			repository: f.claim.repository,
			storage: lxdCodingSessionStorage(f.machine, f.placement, workerId),
			project: "coding",
			imageFingerprint: "b".repeat(64),
			bootstrapSha256: "c".repeat(64),
			storagePool: "coding",
			network: "coding",
			cpus: 2,
			memoryBytes: 4294967296,
			rootDiskBytes: 34359738368,
		};
		const plan = lxdCodingVmPlan(legacy);
		f.state.listed = [
			f.entry({
				machineId: allocationId,
				kind: "session",
				workerId,
				binding: legacy,
				instanceSha256: plan.instanceSha256,
				reserved: false,
				asleepSince: new Date().toISOString(),
				removeDue: true,
			}),
		];
		expect(await f.host.housekeep(f.signal)).toEqual([{ machineId: allocationId, step: "delete", state: "done" }]);
		const journal = (mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions).plan;
		expect(journal).toMatchObject({
			machineId: allocationId,
			journalName: workerId,
			name: plan.request.name,
			request: null,
		});
		expect(reconciled()).toEqual(["deleted"]);
		expect(f.calls("qorpera_release_coding_machine")).toEqual([
			expect.objectContaining({ p_machine_id: allocationId, p_binding_text: JSON.stringify(plan.binding) }),
		]);
	});
	it("refuses a listed machine whose binding does not name it, and a malformed list", async () => {
		const f = await fixture();
		f.state.listed = [f.entry({ machineId: randomUUID(), sleepDue: true })];
		expect((await f.host.housekeep(f.signal))[0]).toMatchObject({
			state: "failed",
			code: "CODING_HOST_MACHINE_LIST_INVALID",
		});
		expect(mocked.reconcile).not.toHaveBeenCalled();
		f.state.listed = [f.entry({ kind: "office" })];
		await expect(f.host.housekeep(f.signal)).rejects.toThrow("CODING_HOST_MACHINE_LIST_INVALID");
		f.call.mockResolvedValueOnce({ machines: [] });
		await expect(f.host.housekeep(f.signal)).rejects.toThrow("CODING_HOST_MACHINE_LIST_INVALID");
	});
	it("lets a caller give up waiting for the machine without its step ever running", async () => {
		const f = await fixture();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const settle = mocked.reconcile.getMockImplementation()!;
		mocked.reconcile.mockImplementationOnce(async (input: CodingMachineReconcileOptions) => {
			await held;
			return settle(input);
		});
		const preparing = f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await vi.waitFor(() => expect(mocked.reconcile).toHaveBeenCalledTimes(1));
		const second = f.another(),
			impatient = new AbortController();
		const waiting = f.host.prepareWorkspace(second, f.turnOf(second), impatient.signal);
		// The second caller has planned and is queued behind the first one's step.
		await vi.waitFor(() =>
			expect(f.calls("qorpera_plan_coding_machine").some((args) => args.p_worker_id === second.workerId)).toBe(true),
		);
		await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
		impatient.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
		await expect(waiting).rejects.toThrow("CODING_EXECUTOR_SHUTDOWN");
		release?.();
		await preparing;
		await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
		expect(
			f.calls("qorpera_authorize_coding_machine_run").filter((args) => args.p_worker_id === second.workerId),
		).toEqual([]);
		expect(f.lxd.devices).toEqual({ ...f.plan.request.devices, ...f.sessionDevices(f.claim.workerId) });
	});
	it("asks for stop custody only after a running turn's lifecycle step on the same machine", async () => {
		const f = await fixture();
		await awake(f);
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const settle = mocked.reconcile.getMockImplementation()!;
		const control = f.call.getMockImplementation()!;
		const second = f.another();
		const order: string[] = [];
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			order.push(`${input.desiredState}:start`);
			await held;
			const result = await settle(input);
			order.push(`${input.desiredState}:end`);
			return result;
		});
		// SQL refuses: the second session's turn is live on the machine.
		f.call.mockImplementation(async (method, args, signal) => {
			if (method !== "qorpera_authorize_coding_machine_custody") return control(method, args, signal);
			order.push("custody");
			return { state: "refused", reason: "MACHINE_IN_USE" };
		});
		const preparing = f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		await vi.waitFor(() => expect(order).toEqual(["running:start"]));
		f.state.listed = [f.entry({ sleepDue: true })];
		const housekeeping = f.host.housekeep(f.signal);
		await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
		expect(order).toEqual(["running:start"]);
		release?.();
		expect(await housekeeping).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "not-now", code: "MACHINE_IN_USE" },
		]);
		await preparing;
		expect(order).toEqual(["running:start", "running:end", "custody"]);
	});
});
