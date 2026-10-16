import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODING_GUEST, cloudCodingSessionLayout, parseCloudCodingNasPolicy } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingMachineUnavailable, type CodingSessionClaim, type CodingTurnState } from "../src/coding-executor.ts";
import {
	CODING_FOLDER_GIT_ENVIRONMENT,
	codingHostId,
	LxdCodingExecutorHost,
	type LxdCodingExecutorHostOptions,
} from "../src/coding-executor-host.ts";
import type { CodingFolderControl } from "../src/coding-folder-control.ts";
import type { CodingFolderRepositories } from "../src/coding-folder-repositories.ts";
import { CodingFolderViews } from "../src/coding-folder-views.ts";
import { CodingHostLeases, judgeCodingHostLease } from "../src/coding-host-lease.ts";
import {
	type CodingMachineReconcileOptions,
	type LxdCodingMachineBinding,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
} from "../src/coding-machine.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import type { LxdInstanceExecStreamClient, LxdInstanceProgramClient, LxdInstanceRecord } from "../src/lxd-client.ts";
import { testAgentMac, testAgentPlug } from "./helpers/coding-machine.ts";

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
	startOperation: vi.fn(),
	keptCommand: vi.fn(),
	guestCancel: vi.fn(),
	guestQuiesce: vi.fn(),
	guestStop: vi.fn(),
	guestStatus: vi.fn(),
	guestMount: vi.fn(),
	folderTransports: [] as Record<string, unknown>[],
	leaseTransports: [] as { scope: { workerId: string; turn: number; requestId: string }; open: boolean }[],
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
vi.mock("../src/coding-folder-command-transport.ts", () => ({
	LxdCodingFolderCommandTransport: class {
		constructor(options: Record<string, unknown>) {
			mocked.folderTransports.push(options);
		}
	},
	codingFolderKeptCommand: mocked.keptCommand,
}));
// The guest agent on the folder model, as its client answers.
vi.mock("../src/coding-guest-client.ts", () => ({
	LxdCodingGuestClient: class {
		cancel = mocked.guestCancel;
		quiesce = mocked.guestQuiesce;
		stopSession = mocked.guestStop;
		status = mocked.guestStatus;
		mount = mocked.guestMount;
	},
	CodingGuestRefused: class extends Error {},
}));
vi.mock("../src/coding-machine.ts", async (original) => ({
	...(await original<typeof import("../src/coding-machine.ts")>()),
	reconcileCodingMachine: mocked.reconcile,
	codingMachineStartOperation: mocked.startOperation,
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
		constructor(options: (typeof mocked.leaseTransports)[number]) {
			mocked.leaseTransports.push(options);
		}
	},
}));
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
beforeEach(() => {
	for (const mock of Object.values(mocked)) if (typeof mock === "function") mock.mockReset();
	mocked.commandTransports.length = 0;
	mocked.folderTransports.length = 0;
	mocked.leaseTransports.length = 0;
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Devices = Record<string, Readonly<Record<string, string>>>;
type Listed = Record<string, unknown>;

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-host-")));
	roots.push(root);
	await mkdir(join(root, "control"), { mode: 0o700 });
	// The node's host leases, on the node's own clock.
	const hostRoot = join(root, "host"),
		hostClock = { bootId: randomUUID(), uptimeMs: 7_200_000 };
	await mkdir(hostRoot, { mode: 0o700 });
	const hostLeases = new CodingHostLeases({
		root: hostRoot,
		clock: { bootId: async () => hostClock.bootId, uptimeMs: async () => hostClock.uptimeMs },
	});
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
	const sequences = new Map<string, number>();
	const sequenceOf = (workerId: string) => sequences.get(workerId) ?? 1;
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
		network: "qagent0",
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
	// The plan's base devices with the agent card as the plug made it (its MAC).
	const base = {
		...plan.request.devices,
		network: { ...plan.request.devices.network, hwaddr: testAgentMac },
	} as Devices;
	const lxd = { exists: false, running: false, devices: { ...base } };
	const state = {
		guestUid: 200000 as number | null,
		runRefusal: null as string | null,
		planRefusal: null as string | null,
		custodyRefusal: null as string | null,
		suspend: "suspended" as "suspended" | "kept",
		listed: [] as Listed[],
		applyDevices: true,
		installFailure: undefined as "before" | "after-storage" | "after-guest" | undefined,
		attachRefusal: null as string | null,
		/** The keeper's answer per session: kept (the default, turn closed) or released with a reason. */
		release: new Map<string, string>(),
		/** Running commands, processor time and bytes moved per session, as the guest's observe action reports them. */
		observed: new Map<
			string,
			{ cpuUsageUsec: number; ioBytes?: number; running: { commandId: string; turn: number; command: string }[] }
		>(),
		uptimeMs: 100000,
		/** The watchdog's lease per session, as the executor's renewals left it (guest clock). */
		guestLeases: new Map<string, { tokenSha256: string; expiresAtMs: number }>(),
		/** Sessions SQL attached in the last 30 seconds: kept even when the observation does not name them. */
		recent: new Set<string>(),
		/** Runs inside the keep call, before SQL answers: a turn attaching during a keeper pass. */
		duringKeep: null as (() => Promise<unknown>) | null,
		/** Runs inside the attach call, before SQL answers: a slow attach. */
		duringAttach: null as (() => void) | null,
	};
	// The watchdog: a generation's lease renews while live and never again once run out.
	mocked.refresh.mockImplementation(async (scope: { workerId: string }, tokenSha256: string, ttlMs: number) => {
		const prior = state.guestLeases.get(scope.workerId);
		if (prior?.tokenSha256 === tokenSha256 && prior.expiresAtMs <= state.uptimeMs)
			throw new Error("CODING_GUEST_LEASE_GENERATION_UNAVAILABLE");
		state.guestLeases.set(scope.workerId, { tokenSha256, expiresAtMs: state.uptimeMs + ttlMs });
	});
	// Attachments as SQL holds them: session -> token.
	const attachments = new Map<string, string>();
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
			case "qorpera_attach_coding_session": {
				const workerId = String(args.p_worker_id);
				if (leases.get(workerId) !== args.p_lease_token) throw new Error("Coding session lease unavailable");
				if (state.attachRefusal) return { state: "refused", reason: state.attachRefusal };
				const during = state.duringAttach;
				state.duringAttach = null;
				during?.();
				// The live attachment's generation is kept only if the guest still holds it.
				const known = attachments.get(workerId);
				const token = known && args.p_guest_generation === hash(known) ? known : randomUUID();
				attachments.set(workerId, token);
				return {
					schema: "qorpera.coding-attachment/v1",
					state: "attached",
					workerId,
					machineId: machine.machineId,
					attachmentToken: token,
					validForMs: 59000,
					turn: {
						sequence: sequenceOf(workerId),
						turnId: codingHostId("turn", `${workerId}:${sequenceOf(workerId)}`),
						open: true,
					},
				};
			}
			case "qorpera_keep_coding_attachments": {
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				const during = state.duringKeep;
				state.duringKeep = null;
				await during?.();
				const seen = new Set(
					(args.p_observation as { sessions: { workerId: string }[] }).sessions.map((entry) => entry.workerId),
				);
				// A session the observation does not name is released, unless it was attached just now.
				const reasonOf = (workerId: string) =>
					state.release.get(workerId) ?? (seen.has(workerId) || state.recent.has(workerId) ? null : "EXPIRED");
				return {
					schema: "qorpera.coding-attachments/v1",
					machineId: machine.machineId,
					sessions: [...attachments].map(([workerId, token]) =>
						reasonOf(workerId)
							? { workerId, state: "release", reason: reasonOf(workerId), attachmentToken: token }
							: {
									workerId,
									state: "kept",
									attachmentToken: token,
									validForMs: 59000,
									turn: {
										sequence: sequenceOf(workerId),
										turnId: codingHostId("turn", `${workerId}:${sequenceOf(workerId)}`),
										open: false,
									},
								},
					),
				};
			}
			case "qorpera_record_coding_session_detached":
				if (attachments.get(String(args.p_worker_id)) === args.p_attachment_token)
					attachments.delete(String(args.p_worker_id));
				return { schema: "qorpera.coding-detached/v1", workerId: args.p_worker_id, state: "detached" };
			case "qorpera_archive_quiet_coding_sessions":
				return 0;
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
			if (command[2] === "observe") {
				// Every session installed in the guest this boot, as cloud-coding-guest-observation.ts publishes it.
				const published = (path: string, value: unknown) =>
					files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(JSON.stringify(value)) });
				const sessions = [...files.keys()]
					.map((path) => /^\/run\/qorpera-coding\/([0-9a-f-]{36})\/configuration\/guest\.json$/.exec(path)?.[1])
					.filter((workerId): workerId is string => workerId !== undefined)
					.map((workerId) => {
						const seen = state.observed.get(workerId) ?? { cpuUsageUsec: 0, running: [] };
						const lease = state.guestLeases.get(workerId);
						published(`/run/qorpera-coding/observation-${workerId}.json`, {
							schema: "qorpera.coding-guest-running/v1",
							bootId,
							workerId,
							running: seen.running,
							moreRunning: 0,
						});
						return {
							workerId,
							cpuUsageUsec: seen.cpuUsageUsec,
							ioBytes: seen.ioBytes ?? 0,
							running: seen.running.length,
							lease: lease && {
								tokenSha256: lease.tokenSha256,
								expiresInMs: Math.max(0, lease.expiresAtMs - state.uptimeMs),
							},
						};
					})
					.map((session) => ({ ...session, lease: session.lease ?? null }));
				published("/run/qorpera-coding/observation.json", {
					schema: "qorpera.coding-guest-observation/v3",
					bootId,
					uptimeMs: state.uptimeMs,
					sessions,
				});
				return;
			}
			const [action, workerId] = command.slice(2) as [string, string];
			if (action === "detach") {
				for (const name of ["guest.json", "storage.json", "configuration-inbox.json"])
					files.delete(configuration(workerId, name));
				state.guestLeases.delete(workerId);
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
				maxLogBytes: 67108864,
			},
			commandHelperSha256: hash("command"),
			gitHelperSha256: hash("git"),
			watchdogHelperSha256: hash("watchdog"),
		},
		repositoryCredentials: {
			withRepositoryToken: vi.fn(async (_scope, _repository, use) => use("test-token-never-sent-to-guest")),
		},
		agentPlug: testAgentPlug,
		hostLeases,
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
		attached: [...attachments].map(([workerId, attachmentToken]) => ({ workerId, attachmentToken })),
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
		attachments,
		sequences,
		call,
		calls,
		client,
		execs,
		files,
		lxd,
		state,
		machine,
		plan,
		base,
		placement,
		sessionDevices,
		layout,
		configuration,
		entry,
		signal,
		submission,
		hostRoot,
		hostClock,
		/** What the host watchdog would judge the machine's lease now. */
		hostLease: (machineId = machine.machineId) =>
			judgeCodingHostLease(lxdCodingMachineName(machineId), vmPolicy.project, {
				root: hostRoot,
				bootId: hostClock.bootId,
				nowMs: hostClock.uptimeMs,
			}),
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
/** One keeper pass and the take-offs it started, settled: the pass's renewals, then the take-offs' outcomes. */
async function pass(f: Fixture) {
	const renewed = await f.host.keep(f.signal);
	return [...renewed, ...(await f.host.settled())];
}
const reconciled = () =>
	mocked.reconcile.mock.calls.map((call) => (call[0] as CodingMachineReconcileOptions).desiredState);

describe("a coding turn on its member's machine", () => {
	it("wakes the member's machine, attaches the session, and runs the pinned seed, push and draft PR", async () => {
		const f = await fixture();
		const workspace = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(workspace).toEqual({ vmId: f.machine.machineId, baseSha: f.baseSha });
		// The turn recorded the session's attachment and took the guest lease under it, turn open.
		expect(f.calls("qorpera_attach_coding_session")).toEqual([
			{
				p_worker_id: f.claim.workerId,
				p_lease_token: f.claim.leaseToken,
				p_binding_text: f.plan.text,
				p_storage: lxdCodingSessionStorage(f.machine, f.placement, f.claim.workerId),
				p_machine_id_sha256: "f".repeat(64),
				// No guest lease yet: a new generation.
				p_guest_generation: null,
			},
		]);
		expect(mocked.refresh).toHaveBeenCalledTimes(1);
		expect(mocked.refresh.mock.calls[0]?.[1]).toBe(hash(f.attachments.get(f.claim.workerId)!));
		expect(mocked.leaseTransports.map((transport) => [transport.scope, transport.open])).toEqual([[f.scope(), true]]);
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
		// The node's agent plug, for the create.
		expect((mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions).plug).toBe(testAgentPlug);
		expect(vi.mocked(f.client.replaceInstanceDevices).mock.calls).toEqual([
			["coding", f.plan.request.name, { ...f.base, ...f.sessionDevices(f.claim.workerId) }, f.signal],
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
			// The attach reads which generation the guest still holds.
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "observe"],
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
				schema: "qorpera.coding-command-guest/v4",
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
			...f.base,
			...f.sessionDevices(f.claim.workerId),
			...f.sessionDevices(second.workerId),
		});
		expect(f.files.has(f.configuration(second.workerId, "guest.json"))).toBe(true);
		// An attached session is never unplugged by its turn; the keeper takes it off once released.
		await f.host.detachSession(second, f.signal);
		expect(Object.keys(f.lxd.devices)).toEqual(
			Object.keys({
				...f.base,
				...f.sessionDevices(f.claim.workerId),
				...f.sessionDevices(second.workerId),
			}),
		);
		f.host.endTurn(second);
		f.state.release.set(second.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		expect(await pass(f)).toEqual(
			expect.arrayContaining([
				{
					machineId: f.machine.machineId,
					workerId: second.workerId,
					step: "detach",
					state: "done",
					code: "ARCHIVED",
				},
				{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			]),
		);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
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
				...f.base,
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
		"COMPUTER_HOURS_EXHAUSTED",
		"NODE_AGENT_EXIT_UNHEALTHY",
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
	it("keeps the session attached across a follow-up turn: folders, seed, base and attachment, the new turn open", async () => {
		const f = await fixture();
		const first = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId);
		f.host.endTurn(f.claim);
		// Standing by: still plugged in, nothing unplugged at the end of the turn.
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		await expect(f.host.commandTransport(f.scope(), async () => undefined, f.signal)).rejects.toThrow("NOT_PREPARED");
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		const second = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(second.vmId).toBe(first.vmId);
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
		expect(mocked.seedFetch).toHaveBeenCalledTimes(1);
		expect(mocked.seedTransfer).toHaveBeenCalledTimes(1);
		expect(f.client.replaceInstanceDevices).toHaveBeenCalledTimes(1);
		// The same attachment's generation, so the guest keeps what the first turn left running.
		expect(f.attachments.get(f.claim.workerId)).toBe(token);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: hash(token!) });
		expect(mocked.leaseTransports.map((transport) => [transport.scope.turn, transport.open])).toEqual([
			[1, true],
			[2, true],
		]);
		expect(new Set(mocked.refresh.mock.calls.map((call) => call[1]))).toEqual(new Set([hash(token!)]));
		// The scope of the second turn names the second turn.
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
	});
	it("takes a new generation when the guest's lease is gone or too close to running out for a renewal to reach it", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId)!;
		f.host.endTurn(f.claim);
		// 45 s were granted; 14 s are left.
		f.state.uptimeMs += 31000;
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: null });
		const next = f.attachments.get(f.claim.workerId)!;
		expect(next).not.toBe(token);
		expect(mocked.refresh.mock.calls.at(-1)?.[1]).toBe(hash(next));
	});
	it("attaches once more under a new generation when the kept one runs out in the guest during a slow attach", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId)!;
		f.host.endTurn(f.claim);
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		// SQL keeps the generation the guest held, but answers only after it ran out there.
		f.state.duringAttach = () => {
			f.state.uptimeMs += 60000;
		};
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.calls("qorpera_attach_coding_session").slice(-2)).toEqual([
			expect.objectContaining({ p_guest_generation: hash(token) }),
			expect.objectContaining({ p_guest_generation: null }),
		]);
		const next = f.attachments.get(f.claim.workerId)!;
		expect(next).not.toBe(token);
		expect(f.state.guestLeases.get(f.claim.workerId)?.tokenSha256).toBe(hash(next));
		expect(mocked.leaseTransports.at(-1)).toMatchObject({ scope: f.scope(), open: true });
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
						network: "qagent0",
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

describe("a session between its turns", () => {
	/** The session attached by its turn, the turn ended, and SQL releasing it for `reason`. */
	async function released(f: Fixture, reason = "ARCHIVED") {
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.release.set(f.claim.workerId, reason);
		f.state.listed = [f.entry()];
		vi.mocked(f.client.execInstance).mockClear();
		f.call.mockClear();
	}
	const takenOff = (f: Fixture, code = "ARCHIVED") => ({
		machineId: f.machine.machineId,
		workerId: f.claim.workerId,
		step: "detach",
		state: "done",
		code,
	});
	it("stays attached after its turn; the keeper renews its attachment and closes the turn in its guest lease", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		f.state.observed.set(f.claim.workerId, {
			cpuUsageUsec: 1000,
			running: [{ commandId: randomUUID(), turn: 1, command: "npm run dev" }],
		});
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		expect(mocked.leaseTransports.map((transport) => transport.open)).toEqual([true, false]);
		const [keep] = f.calls("qorpera_keep_coding_attachments");
		expect(keep).toMatchObject({
			p_machine_id: f.machine.machineId,
			p_owner: "coding-host",
			p_binding_text: f.plan.text,
			p_observation: {
				schema: "qorpera.coding-machine-observation/v1",
				// The first look has nothing to compare the processor time with.
				busy: false,
				sessions: [{ workerId: f.claim.workerId, busy: false, running: [{ turn: 1, command: "npm run dev" }] }],
			},
		});
		// Every guest file is one read of LXD's file API.
		expect(
			vi
				.mocked(f.client.readInstanceFile)
				.mock.calls.filter((call) => call[2].startsWith("/run/qorpera-coding/observation"))
				.map((call) => [call[2], call[3]]),
		).toEqual(
			expect.arrayContaining([
				["/run/qorpera-coding/observation.json", 65536],
				[`/run/qorpera-coding/observation-${f.claim.workerId}.json`, 65536],
			]),
		);
		// The one idle rule's two signals: a server that waits stays quiet; a build that works is busy, and so is a
		// download that moves data with little processor.
		const busy = () =>
			(f.calls("qorpera_keep_coding_attachments").at(-1) as { p_observation: { busy: boolean } }).p_observation.busy;
		f.state.uptimeMs += 10000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1000 + 100000, ioBytes: 1000, running: [] });
		await f.host.keep(f.signal);
		expect(busy()).toBe(false);
		f.state.uptimeMs += 10000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1000 + 100000 + 5000000, ioBytes: 2000, running: [] });
		await f.host.keep(f.signal);
		expect(busy()).toBe(true);
		// 0.1 s of processor in 10 s (1%), but 200 KB moved (more than 512 KiB in 30 s): busy by its data.
		f.state.uptimeMs += 10000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1000 + 200000 + 5000000, ioBytes: 202000, running: [] });
		await f.host.keep(f.signal);
		expect(busy()).toBe(true);
		// 100 KB in 10 s and as little processor: below both thresholds.
		f.state.uptimeMs += 10000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1000 + 300000 + 5000000, ioBytes: 302000, running: [] });
		await f.host.keep(f.signal);
		expect(busy()).toBe(false);
		// A reply that is not the measured shape is refused.
		f.state.uptimeMs += 10000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1000 + 300000 + 5000000, ioBytes: -1, running: [] });
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_OBSERVATION_UNCONFIRMED",
			},
		]);
	});
	it("is taken off once released: running commands cancelled, stopped in the guest, unplugged under detach custody", async () => {
		const f = await fixture();
		const command = randomUUID();
		await released(f);
		f.state.observed.set(f.claim.workerId, {
			cpuUsageUsec: 0,
			running: [{ commandId: command, turn: 1, command: "npm run dev" }],
		});
		expect(await pass(f)).toEqual([takenOff(f)]);
		expect(f.execs()).toEqual([
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "observe"],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-command-guest.mjs", "cancel", f.claim.workerId, command],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", f.claim.workerId],
		]);
		expect(f.lxd.devices).toEqual(f.base);
		expect(f.lxd.running).toBe(true);
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
				p_lease_token: null,
			});
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({
				p_worker_id: f.claim.workerId,
				p_reason: "ARCHIVED",
				p_stopped: [{ commandId: command, turn: 1, command: "npm run dev" }],
			}),
		]);
		expect(f.attachments.has(f.claim.workerId)).toBe(false);
	});
	it("unplugs a session whose preparation failed or had to wait after its folders were attached", async () => {
		const f = await fixture();
		mocked.seedFetch.mockRejectedValueOnce(new Error("CODING_GIT_SEED_UNCONFIRMED"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("SEED_UNCONFIRMED");
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		await f.host.detachSession(f.claim, f.signal);
		expect(f.lxd.devices).toEqual(f.base);
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
		expect(g.lxd.devices).toEqual(g.base);
	});
	it("starts no new command once its turn has ended", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		const [transport] = mocked.commandTransports;
		await transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal);
		f.host.endTurn(f.claim);
		f.call.mockClear();
		await expect(transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal)).rejects.toThrow(
			"CODING_HOST_TURN_NOT_PREPARED",
		);
		expect(f.calls("qorpera_authorize_coding_machine_run")).toEqual([]);
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("NOT_PREPARED");
	});
	it("leaves a session this process never prepared to housekeeping", async () => {
		const f = await fixture();
		await f.host.detachSession(f.claim, f.signal);
		expect(f.call).not.toHaveBeenCalled();
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it("still unplugs the folders when the guest step fails, and reports the failure", async () => {
		const f = await fixture();
		await released(f);
		const exec = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[2] === "detach") throw new Error("CODING_GUEST_SESSION_STOP_UNCONFIRMED");
			return exec(project, name, command, signal);
		});
		expect(await pass(f)).toEqual([
			{ ...takenOff(f), state: "failed", code: "CODING_GUEST_SESSION_STOP_UNCONFIRMED" },
		]);
		expect(f.lxd.devices).toEqual(f.base);
		// Not recorded as detached: the next pass takes it off again.
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([]);
	});
	it("refuses to report an unplug that did not happen", async () => {
		const f = await fixture();
		await released(f);
		f.state.applyDevices = false;
		expect(await pass(f)).toEqual([{ ...takenOff(f), state: "failed", code: "CODING_SESSION_DETACH_UNCONFIRMED" }]);
		f.state.applyDevices = true;
		expect(await pass(f)).toEqual([takenOff(f)]);
		expect(f.lxd.devices).toEqual(f.base);
	});
	it("skips the guest step on a machine that is not running and is done when the machine is gone", async () => {
		const f = await fixture();
		mocked.seedFetch.mockRejectedValueOnce(new Error("CODING_GIT_SEED_UNCONFIRMED"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("SEED_UNCONFIRMED");
		vi.mocked(f.client.execInstance).mockClear();
		f.lxd.running = false;
		await f.host.detachSession(f.claim, f.signal);
		expect(f.client.execInstance).not.toHaveBeenCalled();
		expect(f.lxd.devices).toEqual(f.base);
		const g = await fixture();
		mocked.seedFetch.mockRejectedValueOnce(new Error("CODING_GIT_SEED_UNCONFIRMED"));
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow("SEED_UNCONFIRMED");
		g.lxd.exists = false;
		vi.mocked(g.client.replaceInstanceDevices).mockClear();
		await g.host.detachSession(g.claim, g.signal);
		expect(g.client.replaceInstanceDevices).not.toHaveBeenCalled();
	});
	it("does nothing while SQL refuses detach custody", async () => {
		const f = await fixture();
		await released(f);
		f.state.custodyRefusal = "SESSION_ATTACHED";
		expect(await pass(f)).toEqual([{ ...takenOff(f), state: "not-now", code: "SESSION_ATTACHED" }]);
		expect(f.execs()).toEqual([["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "observe"]]);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
	});
	it("keeps renewing a session whose renewal only failed once", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		mocked.refresh.mockRejectedValueOnce(new Error("LXD instance command failed"));
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "keep",
				state: "failed",
				code: "UNCLASSIFIED",
			},
		]);
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
	});
	it("leaves out a session whose guest lease ran out for good, so SQL releases it and it is taken off", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const token = f.attachments.get(f.claim.workerId)!;
		f.state.listed = [f.entry()];
		// No renewal reached the guest for longer than its lease.
		f.state.uptimeMs += 60000;
		// Attached in the last 30 seconds, SQL keeps it: nothing is renewed, and it waits for a later pass.
		f.state.recent.add(f.claim.workerId);
		mocked.refresh.mockClear();
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "keep",
				state: "not-now",
				code: "GUEST_LEASE_EXPIRED",
			},
		]);
		expect(mocked.refresh).not.toHaveBeenCalled();
		f.state.recent.clear();
		expect(await pass(f)).toEqual([takenOff(f, "EXPIRED")]);
		expect(
			(f.calls("qorpera_keep_coding_attachments").at(-1) as { p_observation: { sessions: unknown[] } }).p_observation
				.sessions,
		).toEqual([]);
		expect(f.lxd.devices).toEqual(f.base);
		// What it had running is SQL's to name: the watchdog stopped it before this look.
		expect(f.calls("qorpera_record_coding_session_detached").at(-1)).toMatchObject({
			p_reason: "EXPIRED",
			p_attachment_token: token,
			p_stopped: [],
		});
	});
	it("attaches a running turn's session again when its guest lease ran out, so the turn goes on", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId)!;
		f.state.listed = [f.entry()];
		// The turn still runs; no renewal reached the guest in time.
		f.state.uptimeMs += 60000;
		expect(await pass(f)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "keep",
				state: "done",
				code: "REATTACHED",
			},
		]);
		const next = f.attachments.get(f.claim.workerId)!;
		expect(next).not.toBe(token);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({
			p_lease_token: f.claim.leaseToken,
			p_guest_generation: null,
		});
		expect(mocked.leaseTransports.at(-1)).toMatchObject({ scope: f.scope(), open: true });
		// Never taken off: the folders stay, and the turn's commands run under the new generation.
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([]);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
	});
	it("keeps renewing while another session of the machine is being taken off", async () => {
		const f = await fixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		f.state.release.set(second.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const exec = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[2] === "detach") await held;
			return exec(project, name, command, signal);
		});
		const renewals = mocked.refresh.mock.calls.length;
		// The pass returns with the first session renewed while the second's take-off is still held.
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(mocked.refresh.mock.calls.length).toBe(renewals + 1);
		// A second pass renews again and starts no second take-off.
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		release?.();
		expect(await f.host.settled()).toEqual([
			{ machineId: f.machine.machineId, workerId: second.workerId, step: "detach", state: "done", code: "ARCHIVED" },
		]);
		expect(f.execs().filter((command) => command[2] === "detach")).toHaveLength(1);
	});
	it("ends a machine's step at its deadline, so a stuck guest never holds up the pass", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const exec = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[2] === "observe") return new Promise<void>(() => {});
			return exec(project, name, command, signal);
		});
		const impatient = new LxdCodingExecutorHost({ ...f.options, keepDeadlineMs: 50 });
		expect(await impatient.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_KEEP_DEADLINE",
			},
		]);
	});
	it("leaves a session a turn attached during the pass to that turn", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		f.state.duringKeep = () => f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		mocked.leaseTransports.length = 0;
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "keep",
				state: "not-now",
				code: "TURN_ATTACHED",
			},
		]);
		// Only the turn's own renewal: its turn open, never closed again by the older keep answer.
		expect(mocked.leaseTransports.map((transport) => [transport.scope.turn, transport.open])).toEqual([[2, true]]);
		// The next pass renews it under what SQL says now.
		await f.host.keep(f.signal);
		expect(mocked.leaseTransports.at(-1)).toMatchObject({ open: false });
	});
	it("is adopted by a new executor process from the guest's journaled configuration", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.state.listed = [f.entry()];
		const successor = new LxdCodingExecutorHost(f.options);
		expect(await successor.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(mocked.leaseTransports.at(-1)).toMatchObject({ scope: f.scope(), open: false });
		// A configuration that is not the one journaled for this boot is never adopted.
		const other = new LxdCodingExecutorHost(f.options);
		const path = f.configuration(f.claim.workerId, "guest.json");
		const original = f.files.get(path)!;
		f.files.set(path, {
			...original,
			content: Buffer.from(JSON.stringify({ ...JSON.parse(original.content.toString()), uid: 200001 })),
		});
		expect(await other.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_GUEST_BINDING_CHANGED",
			},
		]);
	});
});

describe("the host lease of a member's machine", () => {
	it("is written before the machine starts and renewed by each pass while SQL reserves it here, attached or not", async () => {
		const f = await fixture();
		const reconcile = mocked.reconcile.getMockImplementation()!;
		const leased: string[] = [];
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			leased.push(`${input.desiredState}: ${await f.hostLease()}`);
			return reconcile(input);
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(leased).toEqual(["running: live"]);
		f.host.endTurn(f.claim);
		const unattached = randomUUID(),
			asleep = randomUUID();
		f.state.listed = [
			f.entry(),
			f.entry({ machineId: unattached, binding: { ...f.machine, machineId: unattached }, attached: [] }),
			f.entry({
				machineId: asleep,
				binding: { ...f.machine, machineId: asleep },
				attached: [],
				reserved: false,
				asleepSince: new Date().toISOString(),
			}),
		];
		f.hostClock.uptimeMs += 89_999;
		expect(await f.hostLease()).toBe("live");
		f.hostClock.uptimeMs += 1;
		expect(await f.hostLease()).toBe("lapsed");
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(await f.hostLease()).toBe("live");
		expect(await f.hostLease(unattached)).toBe("live");
		// Asleep, it holds no capacity here and may not run.
		expect(await f.hostLease(asleep)).toBe("missing");
		const name = lxdCodingMachineName(f.machine.machineId);
		expect(JSON.parse(await readFile(join(f.hostRoot, `${name}.json`), "utf8"))).toEqual({
			schema: "qorpera.coding-host-lease/v1",
			project: "coding",
			name,
			machineId: f.machine.machineId,
			bootId: f.hostClock.bootId,
			renewedAtBootMs: f.hostClock.uptimeMs,
			expiresAtBootMs: f.hostClock.uptimeMs + 90_000,
		});
		// SQL no longer lists them: no renewal, and the next pass after they lapse removes them.
		f.state.listed = [];
		f.hostClock.uptimeMs += 90_000;
		expect(await f.host.keep(f.signal)).toEqual([]);
		expect(await readdir(f.hostRoot)).toEqual([]);
	});
	it("starts no machine whose lease cannot be written", async () => {
		const f = await fixture();
		await chmod(f.hostRoot, 0o755);
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_LEASE_ROOT_UNPROTECTED",
		);
		expect(reconciled()).toEqual([]);
		expect(f.lxd.running).toBe(false);
	});
	it("reports each machine whose lease a pass cannot write, and still keeps its sessions", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		await chmod(f.hostRoot, 0o755);
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_LEASE_ROOT_UNPROTECTED",
			},
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		await chmod(f.hostRoot, 0o700);
		// A listed machine its binding does not name gets no lease, and its failure is reported once.
		const stray = randomUUID();
		f.state.listed = [f.entry({ machineId: stray })];
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: stray, workerId: null, step: "keep", state: "failed", code: "CODING_HOST_MACHINE_LIST_INVALID" },
		]);
		expect(await f.hostLease(stray)).toBe("missing");
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
	it("puts a quiet machine to sleep: sessions taken off, powered off, folders unplugged, capacity suspended", async () => {
		const f = await fixture();
		await awake(f);
		const command = randomUUID();
		f.state.observed.set(f.claim.workerId, {
			cpuUsageUsec: 0,
			running: [{ commandId: command, turn: 1, command: "npm run dev" }],
		});
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "done" },
		]);
		// Each attached session first: what it runs is cancelled and it leaves the guest; then every slice stops.
		expect(f.execs()).toEqual([
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "observe"],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-command-guest.mjs", "cancel", f.claim.workerId, command],
			["/usr/bin/node", "/opt/qorpera-coding/cloud-coding-storage-guest.mjs", "detach", f.claim.workerId],
			["/usr/bin/systemctl", "stop", "qorpera-coding.slice"],
			["/usr/bin/sync"],
		]);
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({
				p_worker_id: f.claim.workerId,
				p_reason: "SLEEP",
				p_stopped: [{ commandId: command, turn: 1, command: "npm run dev" }],
			}),
		]);
		expect(mocked.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
			f.call.mock.invocationCallOrder[
				f.call.mock.calls.findIndex((c) => c[0] === "qorpera_record_coding_session_detached")
			]!,
		);
		expect(reconciled()).toEqual(["stopped"]);
		expect(vi.mocked(f.client.execInstance).mock.invocationCallOrder.at(-1)).toBeLessThan(
			mocked.reconcile.mock.invocationCallOrder[0]!,
		);
		expect(f.lxd).toMatchObject({ exists: true, running: false, devices: f.base });
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
	it("drops the machine's host lease once it is stopped, and once it is deleted", async () => {
		const f = await fixture();
		await awake(f);
		expect(await f.hostLease()).toBe("live");
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 0, running: [] });
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "done" },
		]);
		expect(await f.hostLease()).toBe("missing");
		// One a keeper pass wrote while it stopped goes with its delete.
		await f.options.hostLeases?.renew({ project: "coding", machineId: f.machine.machineId });
		f.state.listed = [f.entry({ removeDue: true, reserved: false, asleepSince: new Date().toISOString() })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "delete", state: "done" },
		]);
		expect(f.lxd.exists).toBe(false);
		expect(await f.hostLease()).toBe("missing");
	});
	it("still powers off when the quiesce fails or the agent is gone, and skips it for a stopped machine", async () => {
		const f = await fixture();
		await awake(f);
		vi.mocked(f.client.execInstance).mockRejectedValueOnce(new Error("LXD instance command failed"));
		f.state.listed = [f.entry({ sleepDue: true, attached: [] })];
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(f.execs().map((command) => command.at(-1))).toEqual(["qorpera-coding.slice", "/usr/bin/sync"]);
		const g = await fixture();
		await awake(g);
		vi.mocked(g.client.execInstance).mockRejectedValue(new Error("LXD instance agent not running"));
		g.state.listed = [g.entry({ sleepDue: true, attached: [] })];
		expect((await g.host.housekeep(g.signal))[0]?.state).toBe("done");
		expect(g.execs()).toEqual([["/usr/bin/systemctl", "stop", "qorpera-coding.slice"]]);
		const h = await fixture();
		await awake(h);
		h.lxd.running = false;
		h.state.listed = [h.entry({ sleepDue: true })];
		expect((await h.host.housekeep(h.signal))[0]?.state).toBe("done");
		expect(h.client.execInstance).not.toHaveBeenCalled();
		expect(reconciled()).toEqual(["stopped"]);
		// A session attached to a machine that sleeps is still recorded detached, with nothing seen running.
		expect(h.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({ p_worker_id: h.claim.workerId, p_reason: "SLEEP", p_stopped: [] }),
		]);
		// A machine whose observation fails still sleeps, and its sessions are recorded.
		const k = await fixture();
		await awake(k);
		const exec = vi.mocked(k.client.execInstance).getMockImplementation()!;
		vi.mocked(k.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[2] === "observe") throw new Error("LXD instance command failed");
			return exec(project, name, command, signal);
		});
		k.state.listed = [k.entry({ sleepDue: true })];
		expect((await k.host.housekeep(k.signal))[0]?.state).toBe("done");
		expect(k.lxd.running).toBe(false);
		expect(k.calls("qorpera_record_coding_session_detached")).toHaveLength(1);
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
		// Its sessions were taken off for a newer machine, not for sleep.
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({ p_worker_id: f.claim.workerId, p_reason: "RETIRED" }),
		]);
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
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
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

/** The fixture on the folder model: the session's views, the folder service's boundary, its repositories and the guest
 * agent, faked. `repositories` false leaves the executor's default: none, at /company. */
async function folderFixture(repositories = true) {
	const f = await fixture();
	const startOperationId = randomUUID(),
		viewId = randomUUID(),
		cwd = `/company/code/app/worktrees/${f.claim.workerId}`;
	mocked.startOperation.mockResolvedValue(startOperationId);
	mocked.guestStatus.mockResolvedValue({ commands: [] });
	mocked.guestCancel.mockResolvedValue({});
	mocked.guestQuiesce.mockResolvedValue({});
	mocked.guestStop.mockResolvedValue({});
	const views = {
		attach: vi.fn<CodingFolderViews["attach"]>(async () => ({ viewId })),
		end: vi.fn<CodingFolderViews["end"]>(async (workerId) => ({ workerId, viewId, saved: true, closed: true })),
		endMachine: vi.fn<CodingFolderViews["endMachine"]>(async () => []),
	};
	const boundary = vi.fn<CodingFolderControl["boundary"]>(async (machine) => ({
		machine,
		reads: "released",
		views: [{ viewId, unsaved: 0 }],
	}));
	const sessionRepositories = {
		prepare: vi.fn<CodingFolderRepositories["prepare"]>(async () => ({ cwd })),
		export: vi.fn<CodingFolderRepositories["export"]>(async () => Buffer.from("bundle")),
	};
	const onMount = vi.fn();
	const folder = {
		views,
		control: { boundary },
		client: {} as LxdInstanceExecStreamClient,
		...(repositories ? { repositories: sessionRepositories } : {}),
		onMount,
	};
	const host = new LxdCodingExecutorHost({ ...f.options, folder });
	/** An executor process whose views are real ones over `records`, as `real` makes them; each call is the next. */
	const executor = (real: Awaited<ReturnType<typeof realViews>>) =>
		new LxdCodingExecutorHost({
			...f.options,
			folder: { ...folder, views: real.views(), control: { boundary: real.boundary } },
		});
	return {
		...f,
		host,
		executor,
		views,
		boundary,
		repositories: sessionRepositories,
		onMount,
		startOperationId,
		viewId,
		cwd,
	};
}

/** Real views, recorded in a folder of their own, over a faked core and folder service, and a machine that has the
 * agent and the folder program already (the guest agent's mount is `mocked.guestMount`). */
async function realViews() {
	const parent = await realpath(await mkdtemp(join(tmpdir(), "coding-host-views-")));
	roots.push(parent);
	const root = join(parent, "folder-views"),
		viewId = randomUUID(),
		pass = "P".repeat(43),
		agent = "// the guest agent\n",
		program = "the folder program";
	const opens: Record<string, unknown>[] = [],
		closes: Record<string, unknown>[] = [];
	const control = {
		async call(method: string, args: Record<string, unknown>) {
			if (method === "qorpera_folder_view_open") {
				opens.push(args);
				return { schema: "qorpera.folder-view/v1", viewId, pass, leaseUntil: "2026-10-16T01:00:00Z" };
			}
			if (method !== "qorpera_folder_view_close") throw new Error(`Unexpected method ${method}`);
			closes.push(args);
			return { schema: "qorpera.folder-view-close/v1", state: "closed", reason: "closed" };
		},
	};
	const boundary = vi.fn<CodingFolderControl["boundary"]>(async (machine, final) => ({
		machine,
		reads: "released",
		views: final.map((id) => ({ viewId: id, unsaved: 0 })),
	}));
	const client = {
		async execInstanceStream() {
			const stdout = `${hash(agent)}  ${CODING_GUEST.agent}\n${hash(program)}  ${CODING_GUEST.folderProgram}\n`;
			return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
		},
		async pushInstanceProgram() {
			throw new Error("Unexpected push");
		},
	} as unknown as LxdInstanceExecStreamClient & LxdInstanceProgramClient;
	mocked.guestMount.mockResolvedValue({ mount: "mounted" });
	const views = () =>
		new CodingFolderViews({
			control,
			folder: { boundary },
			client,
			agent: Buffer.from(agent),
			program: Buffer.from(program),
			records: { root },
		});
	return { root, viewId, pass, opens, closes, boundary, views };
}

describe("a coding session on the folder model", () => {
	it("attaches the session in SQL, mounts its view under that attachment for its own user, and plugs and seeds nothing", async () => {
		const f = await folderFixture();
		expect(await f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).toEqual({
			vmId: f.machine.machineId,
			baseSha: f.baseSha,
		});
		expect(reconciled()).toEqual(["running"]);
		// The start this boot came from, read from the machine's journal once it runs.
		const { plan, journalRoot } = mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions;
		expect(mocked.startOperation.mock.calls).toEqual([[journalRoot, plan]]);
		expect(mocked.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
			mocked.startOperation.mock.invocationCallOrder[0]!,
		);
		// A new attachment: this process holds no generation on the boot yet.
		expect(f.calls("qorpera_attach_coding_session")).toEqual([
			expect.objectContaining({
				p_worker_id: f.claim.workerId,
				p_lease_token: f.claim.leaseToken,
				p_guest_generation: null,
			}),
		]);
		const token = f.attachments.get(f.claim.workerId);
		expect(f.views.attach.mock.calls).toEqual([
			[
				{
					workerId: f.claim.workerId,
					environmentId: f.claim.environmentId,
					attachmentToken: token,
					machine: f.machine,
					uid: 200000,
				},
				expect.any(Number),
				f.signal,
			],
		]);
		// The view is held while SQL keeps the attachment.
		const until = f.views.attach.mock.calls[0]![1];
		expect(until).toBeGreaterThan(Date.now() + 50000);
		expect(until).toBeLessThanOrEqual(Date.now() + 59000);
		expect(f.onMount.mock.calls).toEqual([
			[{ workerId: f.claim.workerId, machineId: f.machine.machineId, viewId: f.viewId }],
		]);
		// Attached in SQL, then mounted, then the session's repositories made ready on the mount.
		const attached = f.call.mock.calls.findIndex((call) => call[0] === "qorpera_attach_coding_session");
		expect(f.call.mock.invocationCallOrder[attached]).toBeLessThan(f.views.attach.mock.invocationCallOrder[0]!);
		expect(f.views.attach.mock.invocationCallOrder[0]).toBeLessThan(
			f.repositories.prepare.mock.invocationCallOrder[0]!,
		);
		expect(f.repositories.prepare.mock.calls[0]?.[0]).toMatchObject({
			claim: f.claim,
			machine: f.machine,
			uid: 200000,
			baseSha: f.baseSha,
		});
		// The machine runs and its LXD agent answers. The host plugs, configures, seeds and leases nothing in the guest:
		// the view (faked here) brings the guest agent and the folder program.
		expect(f.execs()).toEqual([["/usr/bin/true"]]);
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		expect(mocked.seedFetch).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
		expect(mocked.refresh).not.toHaveBeenCalled();
		expect(mocked.leaseTransports).toEqual([]);
		// Its commands run as its user, at its worktree, with Git's settings for the company folder, under this boot's
		// start, and kept in the session's custody folder.
		const authorize = vi.fn(async () => undefined);
		await f.host.commandTransport(f.scope(), authorize, f.signal);
		expect(mocked.commandTransports).toEqual([]);
		expect(mocked.folderTransports).toEqual([
			expect.objectContaining({
				machine: f.machine,
				scope: f.scope(),
				startOperationId: f.startOperationId,
				session: { uid: 200000, gid: 200000, cwd: f.cwd, environment: CODING_FOLDER_GIT_ENVIRONMENT },
				custody: lxdCodingSessionStorage(f.machine, f.placement, f.claim.workerId).custodySource,
				limitBytes: 67108864,
			}),
		]);
		expect(CODING_FOLDER_GIT_ENVIRONMENT).toMatchObject({
			GIT_CONFIG_COUNT: "13",
			GIT_CONFIG_KEY_2: "gc.auto",
			GIT_CONFIG_VALUE_2: "0",
			GIT_CONFIG_KEY_12: "protocol.ext.allow",
			GIT_CONFIG_VALUE_12: "never",
		});
		// Each of its steps asks the turn's own authority first.
		const transport = mocked.folderTransports[0] as { authorize: (...args: unknown[]) => Promise<void> };
		const runs = f.calls("qorpera_authorize_coding_machine_run").length;
		await transport.authorize("start", f.scope(), randomUUID(), "a".repeat(64), f.signal);
		expect(f.calls("qorpera_authorize_coding_machine_run")).toHaveLength(runs + 1);
		expect(authorize).toHaveBeenCalledTimes(1);
	});
	it.each([null, 524288])("refuses a session SQL gives no user in the guest agent's range (%s)", async (uid) => {
		const f = await folderFixture();
		f.state.guestUid = uid;
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_FOLDER_SESSION_UID_MISSING",
		);
		expect(f.calls("qorpera_attach_coding_session")).toEqual([]);
		expect(f.views.attach).not.toHaveBeenCalled();
	});
	it("keeps the attachment's generation for a later turn on the same boot, and takes a new one after a restart", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId)!;
		const next = async (sequence: number) => {
			f.host.endTurn(f.claim);
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		await next(2);
		// The same view, with whatever the first turn's commands left running.
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: hash(token) });
		expect(f.attachments.get(f.claim.workerId)).toBe(token);
		expect(f.views.attach.mock.calls.map((call) => call[0].attachmentToken)).toEqual([token, token]);
		// The machine restarted: nothing of the session is left in it, and a new generation is taken.
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		await next(3);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: null });
		expect(f.attachments.get(f.claim.workerId)).not.toBe(token);
		expect(f.views.attach.mock.calls.at(-1)?.[0].attachmentToken).toBe(f.attachments.get(f.claim.workerId));
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
	});
	it("publishes what the machine's boundary saved: the boundary first, then the session's bundle, pushed and opened as a draft", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(await f.host.publish(f.claim, f.submission, f.signal)).toEqual({
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(f.boundary.mock.calls).toEqual([[f.machine.machineId, [], f.signal]]);
		expect(f.repositories.export.mock.calls).toEqual([
			[expect.objectContaining({ claim: f.claim, uid: 200000, baseSha: f.baseSha }), f.submission.headSha, f.signal],
		]);
		expect(f.boundary.mock.invocationCallOrder[0]).toBeLessThan(f.repositories.export.mock.invocationCallOrder[0]!);
		expect(mocked.exportTransfer).not.toHaveBeenCalled();
		expect(mocked.push.mock.calls[0]?.[1]).toEqual(Buffer.from("bundle"));
		expect(mocked.push.mock.invocationCallOrder[0]).toBeLessThan(mocked.publish.mock.invocationCallOrder[0]!);
	});
	it.each([
		["holds the machine's reads", { reads: "unanswered" as const, views: [] }],
		["did not save a view", { reads: "released" as const, views: [{ viewId: randomUUID(), error: "SAVE_FAILED" }] }],
		["left a view's paths unsaved", { reads: "released" as const, views: [{ viewId: randomUUID(), unsaved: 2 }] }],
		[
			"refused a view's save whole",
			{ reads: "released" as const, views: [{ viewId: randomUUID(), unsaved: 0, refused: "stopped" }] },
		],
		["answered a view without its report", { reads: "released" as const, views: [{ viewId: randomUUID() }] }],
	])("publishes nothing when the boundary %s", async (_case, answer) => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.boundary.mockResolvedValueOnce({ machine: f.machine.machineId, ...answer });
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("CODING_FOLDER_BOUNDARY_HELD");
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("starts commands at the company folder and has nothing to publish while there are no repositories", async () => {
		const f = await folderFixture(false);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		expect(mocked.folderTransports[0]).toMatchObject({ session: { cwd: "/company" } });
		expect(await f.host.publish(f.claim, f.submission, f.signal)).toEqual({ pullRequest: null, noChange: true });
		expect(f.boundary).toHaveBeenCalledTimes(1);
		expect(f.repositories.export).not.toHaveBeenCalled();
		// An open pull request with nothing to push to it is no publication.
		f.claim.pullRequest = f.pullRequest;
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("CODING_FOLDER_EXPORT_EMPTY");
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("reports a session busy while a command it started runs, as the host kept it, and renews no guest lease", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		vi.mocked(f.client.execInstance).mockClear();
		const running = randomUUID(),
			exited = randomUUID(),
			unkept = randomUUID();
		mocked.guestStatus.mockResolvedValue({
			commands: [
				{ commandId: running, state: "running" },
				{ commandId: exited, state: "exited" },
				{ commandId: unkept, state: "running" },
			],
		});
		// The host kept no start of the third: it is not reported.
		mocked.keptCommand.mockImplementation(async (_custody: string, _workerId: string, commandId: string) =>
			commandId === running ? { turn: 1, command: `npm run dev ${"é".repeat(200)}` } : undefined,
		);
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(mocked.guestStatus.mock.calls).toEqual([
			[{ schema: "qorpera.coding-guest-session/v1", workerId: f.claim.workerId }, expect.any(AbortSignal)],
		]);
		const custody = lxdCodingSessionStorage(f.machine, f.placement, f.claim.workerId).custodySource;
		expect(mocked.keptCommand.mock.calls).toEqual([
			[custody, f.claim.workerId, running],
			[custody, f.claim.workerId, unkept],
		]);
		expect(f.calls("qorpera_keep_coding_attachments")).toEqual([
			expect.objectContaining({
				p_observation: {
					schema: "qorpera.coding-machine-observation/v1",
					busy: true,
					sessions: [
						{
							workerId: f.claim.workerId,
							busy: true,
							// Clipped to 300 bytes, whole characters.
							running: [{ commandId: running, turn: 1, command: `npm run dev ${"é".repeat(144)}` }],
						},
					],
				},
			}),
		]);
		// Nothing runs: quiet, and still named in the observation, so SQL keeps it.
		mocked.guestStatus.mockResolvedValue({ commands: [] });
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.calls("qorpera_keep_coding_attachments").at(-1)).toMatchObject({
			p_observation: { busy: false, sessions: [{ workerId: f.claim.workerId, busy: false, running: [] }] },
		});
		// The guest agent answers it all: no helper runs, and no guest lease is renewed.
		expect(f.execs()).toEqual([]);
		expect(mocked.refresh).not.toHaveBeenCalled();
	});
	it("takes a released session off: its commands cancelled through the guest agent, the session quiet, its view ended, the session stopped", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const command = randomUUID();
		mocked.guestStatus.mockResolvedValue({ commands: [{ commandId: command, state: "running" }] });
		mocked.keptCommand.mockResolvedValue({ turn: 1, command: "npm run dev" });
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		f.call.mockClear();
		expect(await pass(f)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "detach",
				state: "done",
				code: "ARCHIVED",
			},
		]);
		expect(mocked.guestCancel.mock.calls).toEqual([
			[
				{ schema: "qorpera.coding-guest-cancel/v1", workerId: f.claim.workerId, commandId: command },
				expect.any(AbortSignal),
			],
		]);
		const request = { schema: "qorpera.coding-guest-session/v1", workerId: f.claim.workerId };
		expect(mocked.guestQuiesce.mock.calls).toEqual([[request, expect.any(AbortSignal)]]);
		expect(f.views.end.mock.calls).toEqual([[f.claim.workerId, expect.any(AbortSignal)]]);
		expect(mocked.guestStop.mock.calls).toEqual([[request, expect.any(AbortSignal)]]);
		// Its commands stop, and then nothing of it runs, before the view's final boundary saves what they left; the
		// session stops after that.
		expect(mocked.guestCancel.mock.invocationCallOrder[0]).toBeLessThan(
			mocked.guestQuiesce.mock.invocationCallOrder[0]!,
		);
		expect(mocked.guestQuiesce.mock.invocationCallOrder[0]).toBeLessThan(f.views.end.mock.invocationCallOrder[0]!);
		expect(f.views.end.mock.invocationCallOrder[0]).toBeLessThan(mocked.guestStop.mock.invocationCallOrder[0]!);
		expect(new Set(f.calls("qorpera_authorize_coding_machine_custody").map((args) => args.p_intent))).toEqual(
			new Set(["detach"]),
		);
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({
				p_worker_id: f.claim.workerId,
				p_reason: "ARCHIVED",
				p_stopped: [{ commandId: command, turn: 1, command: "npm run dev" }],
			}),
		]);
		expect(f.attachments.has(f.claim.workerId)).toBe(false);
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
	});
	it.each([
		["CODING_FOLDER_VIEW_UNSAVED", { saved: false, closed: true }],
		["CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED", { saved: true, closed: false }],
	])("fails a take-off whose view ended so (%s), the session stopped all the same", async (code, end) => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.views.end.mockResolvedValueOnce({ workerId: f.claim.workerId, viewId: f.viewId, ...end });
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		f.call.mockClear();
		expect(await pass(f)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "detach", state: "failed", code },
		]);
		expect(mocked.guestStop).toHaveBeenCalledTimes(1);
		// Still attached in SQL: a later pass takes it off again.
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([]);
	});
	it("keeps the view of a session the guest can't confirm quiet, its cancel failed or not, and fails the take-off", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		mocked.guestStatus.mockResolvedValue({ commands: [{ commandId: randomUUID(), state: "running" }] });
		mocked.keptCommand.mockResolvedValue({ turn: 1, command: "npm run dev" });
		mocked.guestCancel.mockRejectedValue(new Error("LXD exec stream failed"));
		mocked.guestQuiesce.mockRejectedValue(new Error("CODING_GUEST_SESSION_STILL_RUNNING"));
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		f.call.mockClear();
		expect(await pass(f)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "detach",
				state: "failed",
				code: "CODING_GUEST_SESSION_STILL_RUNNING",
			},
		]);
		expect(mocked.guestCancel).toHaveBeenCalledTimes(1);
		expect(mocked.guestQuiesce).toHaveBeenCalledTimes(1);
		// Its view stays mounted, and nothing of it is saved or removed while something of it may still write.
		expect(f.views.end).not.toHaveBeenCalled();
		expect(mocked.guestStop).not.toHaveBeenCalled();
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([]);
	});
	it("fails a take-off whose view's record can't be read, before the session stops", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.views.end.mockRejectedValueOnce(new Error("CODING_FOLDER_VIEW_RECORD_FAILED"));
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		f.call.mockClear();
		expect(await pass(f)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "detach",
				state: "failed",
				code: "CODING_FOLDER_VIEW_RECORD_FAILED",
			},
		]);
		// The session keeps its mount for the next pass, which ends its view by the record.
		expect(mocked.guestStop).not.toHaveBeenCalled();
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([]);
	});
	it("ends a released session's view after the executor restarted, by its record, before the session stops", async () => {
		const f = await folderFixture();
		const real = await realViews();
		// The executor before the restart attached the session and showed it its view.
		const before = f.executor(real);
		await before.prepareWorkspace(f.claim, f.turn(), f.signal);
		before.endTurn(f.claim);
		expect(real.opens).toHaveLength(1);
		expect(mocked.guestMount.mock.calls[0]?.[0]).toMatchObject({
			workerId: f.claim.workerId,
			view: { viewId: real.viewId, pass: real.pass },
		});
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		real.boundary.mockClear();
		expect(await pass({ ...f, host: f.executor(real) })).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "detach",
				state: "done",
				code: "ARCHIVED",
			},
		]);
		expect(real.boundary.mock.calls).toEqual([[f.machine.machineId, [real.viewId], expect.any(AbortSignal)]]);
		expect(real.closes).toEqual([{ p_view_id: real.viewId, p_pass: real.pass }]);
		expect(mocked.guestQuiesce.mock.invocationCallOrder[0]).toBeLessThan(real.boundary.mock.invocationCallOrder[0]!);
		expect(real.boundary.mock.invocationCallOrder[0]).toBeLessThan(mocked.guestStop.mock.invocationCallOrder[0]!);
		expect(await readdir(real.root)).toEqual([]);
	});
	it("only ends the view of a released session whose machine is not running", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		mocked.guestStatus.mockImplementation(async () => {
			// Stopped elsewhere between the keeper's look and the take-off.
			f.lxd.running = false;
			return { commands: [] };
		});
		expect(await pass(f)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: f.claim.workerId,
				step: "detach",
				state: "done",
				code: "ARCHIVED",
			},
		]);
		expect(f.views.end).toHaveBeenCalledTimes(1);
		expect(mocked.guestCancel).not.toHaveBeenCalled();
		expect(mocked.guestStop).not.toHaveBeenCalled();
	});
	it("puts a quiet machine to sleep: its commands cancelled, its views ended before the power-off, nothing unplugged", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		mocked.reconcile.mockClear();
		vi.mocked(f.client.execInstance).mockClear();
		f.call.mockClear();
		const command = randomUUID();
		mocked.guestStatus.mockResolvedValue({ commands: [{ commandId: command, state: "running" }] });
		mocked.keptCommand.mockResolvedValue({ turn: 1, command: "npm run dev" });
		f.views.endMachine.mockResolvedValue([
			{ workerId: f.claim.workerId, viewId: f.viewId, saved: true, closed: true },
		]);
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "done" },
		]);
		expect(mocked.guestCancel.mock.calls).toEqual([
			[
				{ schema: "qorpera.coding-guest-cancel/v1", workerId: f.claim.workerId, commandId: command },
				expect.any(AbortSignal),
			],
		]);
		// Then nothing of the session runs, its user manager included; the power-off ends the guest's session: nothing is
		// taken off in it.
		expect(mocked.guestQuiesce.mock.calls).toEqual([
			[{ schema: "qorpera.coding-guest-session/v1", workerId: f.claim.workerId }, expect.any(AbortSignal)],
		]);
		expect(mocked.guestCancel.mock.invocationCallOrder[0]).toBeLessThan(
			mocked.guestQuiesce.mock.invocationCallOrder[0]!,
		);
		expect(mocked.guestQuiesce.mock.invocationCallOrder[0]).toBeLessThan(
			f.views.endMachine.mock.invocationCallOrder[0]!,
		);
		expect(mocked.guestStop).not.toHaveBeenCalled();
		expect(f.execs()).toEqual([["/usr/bin/systemctl", "stop", "qorpera-coding.slice"], ["/usr/bin/sync"]]);
		expect(f.views.endMachine.mock.calls).toEqual([[f.machine.machineId, expect.any(AbortSignal)]]);
		expect(vi.mocked(f.client.execInstance).mock.invocationCallOrder.at(-1)).toBeLessThan(
			f.views.endMachine.mock.invocationCallOrder[0]!,
		);
		expect(f.views.endMachine.mock.invocationCallOrder[0]).toBeLessThan(
			mocked.reconcile.mock.invocationCallOrder[0]!,
		);
		expect(reconciled()).toEqual(["stopped"]);
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(f.calls("qorpera_suspend_coding_machine")).toHaveLength(1);
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({
				p_worker_id: f.claim.workerId,
				p_reason: "SLEEP",
				p_stopped: [{ commandId: command, turn: 1, command: "npm run dev" }],
			}),
		]);
	});
	it("puts the machine to sleep even when a view ends unsaved, and reports the step failed", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.call.mockClear();
		f.views.endMachine.mockResolvedValue([
			{ workerId: f.claim.workerId, viewId: f.viewId, saved: false, closed: true },
		]);
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "failed", code: "CODING_FOLDER_VIEW_UNSAVED" },
		]);
		expect(reconciled()).toEqual(["running", "stopped"]);
		expect(f.calls("qorpera_suspend_coding_machine")).toHaveLength(1);
		expect(f.calls("qorpera_record_coding_session_detached")).toHaveLength(1);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_stage: "sleep", p_code: "CODING_FOLDER_VIEW_UNSAVED" }),
		]);
	});
	it.each([
		[
			"a session the guest can't confirm quiet",
			"CODING_GUEST_SESSION_STILL_RUNNING",
			() => mocked.guestQuiesce.mockRejectedValue(new Error("CODING_GUEST_SESSION_STILL_RUNNING")),
		],
		[
			"views whose records can't be read",
			"CODING_FOLDER_VIEW_RECORD_FAILED",
			(f: Awaited<ReturnType<typeof folderFixture>>) =>
				f.views.endMachine.mockRejectedValue(new Error("CODING_FOLDER_VIEW_RECORD_FAILED")),
		],
	])("puts the machine to sleep with %s, and reports the step failed", async (_label, code, fail) => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.call.mockClear();
		fail(f);
		f.state.listed = [f.entry({ sleepDue: true })];
		expect(await f.host.housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "failed", code },
		]);
		expect(f.views.endMachine).toHaveBeenCalledTimes(1);
		expect(reconciled()).toEqual(["running", "stopped"]);
		expect(f.calls("qorpera_suspend_coding_machine")).toHaveLength(1);
		expect(f.calls("qorpera_record_coding_session_detached")).toHaveLength(1);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_stage: "sleep", p_code: code }),
		]);
	});
	it("ends a sleeping machine's views after the executor restarted, by their records, before the power-off", async () => {
		const f = await folderFixture();
		const real = await realViews();
		await f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(real.opens).toHaveLength(1);
		f.state.listed = [f.entry({ sleepDue: true })];
		real.boundary.mockClear();
		mocked.reconcile.mockClear();
		expect(await f.executor(real).housekeep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, step: "sleep", state: "done" },
		]);
		expect(real.boundary.mock.calls).toEqual([[f.machine.machineId, [real.viewId], expect.any(AbortSignal)]]);
		expect(real.closes).toEqual([{ p_view_id: real.viewId, p_pass: real.pass }]);
		expect(mocked.guestQuiesce.mock.invocationCallOrder[0]).toBeLessThan(real.boundary.mock.invocationCallOrder[0]!);
		expect(real.boundary.mock.invocationCallOrder[0]).toBeLessThan(mocked.reconcile.mock.invocationCallOrder[0]!);
		expect(reconciled()).toEqual(["stopped"]);
		expect(await readdir(real.root)).toEqual([]);
	});
});
