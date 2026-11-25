import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	CODING_CHECK_CACHES,
	CODING_GUEST,
	CODING_GUEST_HELPER_MAX_BYTES,
	CODING_PACKAGE_CACHE_ENVIRONMENT,
	type CodingGuestCommandState,
	type CodingGuestRunRequest,
	type CodingGuestUsage,
	cloudCodingSessionLayout,
	parseCloudCodingNasPolicy,
	parseCodingGuestAnswer,
	parseCodingGuestRequest,
} from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CodeCheck, type CodeSiteRecipe, codeChecksTail } from "../src/code-checks.ts";
import { CODE_RESTORING } from "../src/code-host-repositories.ts";
import {
	CODE_CHECKS_DRILL,
	CODE_CHECKS_NEWER_RUN,
	CODE_SITE_COLLECT,
	CODE_SITE_DROP,
	type CodeSiteProblem,
	codeSiteRefusedSummary,
} from "../src/code-site.ts";
import {
	type CodingCommandSecrets,
	type CodingEnvironmentSource,
	CodingMachineCommandSecrets,
} from "../src/coding-command-secrets.ts";
import {
	CodingControlRefused,
	CodingMachineUnavailable,
	CodingPushRefused,
	CodingSaveRefused,
	type CodingSessionClaim,
	type CodingTurnState,
	CodingWorkspaceFailed,
} from "../src/coding-executor.ts";
import {
	CODING_BOOT_READY_COMMAND,
	CODING_FOLDER_GIT_ENVIRONMENT,
	CODING_HOST_RPCS,
	CODING_MACHINE_CHANNEL,
	codingFolderGitEnvironment,
	codingHostId,
	LxdCodingExecutorHost,
	type LxdCodingExecutorHostOptions,
} from "../src/coding-executor-host.ts";
import type {
	LxdCodingFolderCommandTransport,
	LxdCodingFolderCommandTransportOptions,
} from "../src/coding-folder-command-transport.ts";
import type {
	CodingFolderBoundary,
	CodingFolderBoundaryView,
	CodingFolderControl,
} from "../src/coding-folder-control.ts";
import type {
	CodeChangeReport,
	CodingFolderRepositories,
	CodingFolderRepositorySession,
} from "../src/coding-folder-repositories.ts";
import {
	CodingFolderRestartRequired,
	type CodingFolderViewEnd,
	type CodingFolderViewHeld,
	CodingFolderViews,
} from "../src/coding-folder-views.ts";
import { CodingGuestRefused, type LxdCodingGuestClient } from "../src/coding-guest-client.ts";
import { CodingHostLeases, judgeCodingHostLease } from "../src/coding-host-lease.ts";
import {
	type CodingMachineReconcileOptions,
	type LxdCodingMachineBinding,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
	lxdCodingSessionDevices,
	lxdCodingSessionStorage,
} from "../src/coding-machine.ts";
import type { CodingSecretMask } from "../src/coding-secret-mask.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import {
	type LxdExecPipeRequest,
	type LxdInstanceExecStreamClient,
	type LxdInstanceProgramClient,
	type LxdInstanceRecord,
	validExecPipe,
} from "../src/lxd-client.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";
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
	lastStart: vi.fn(),
	dropStart: vi.fn(),
	undropStart: vi.fn(),
	startDropped: vi.fn(),
	recordDisk: vi.fn(),
	disk: vi.fn(),
	keptCommand: vi.fn(),
	guestCancel: vi.fn(),
	guestRun: vi.fn(),
	guestOutput: vi.fn(),
	guestQuiesce: vi.fn(),
	guestStop: vi.fn(),
	guestStatus: vi.fn(),
	guestStatusAll: vi.fn(),
	guestMount: vi.fn(),
	folderTransports: [] as Record<string, unknown>[],
	/** The folder model's transports the host builds are the real ones, over the guest agent's client faked here. */
	realTransports: false,
	realReconcile: false,
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
// The tail's own rule is the words' (part C1): each test sees what it is handed.
vi.mock("../src/code-checks.ts", async (original) => {
	const real = await original<typeof import("../src/code-checks.ts")>();
	return { ...real, codeChecksTail: vi.fn(real.codeChecksTail) };
});
vi.mock("../src/coding-storage.ts", () => ({
	createCodingNasStorage: (policy: { rootPath: string }) => ({
		controlPath: `${policy.rootPath}/control`,
		prepareControl: mocked.storagePrepare,
		assertControl: mocked.storageAssert,
		prepare: mocked.storagePrepare,
		assert: mocked.storageAssert,
	}),
}));
vi.mock("../src/coding-folder-command-transport.ts", async (original) => {
	const real = await original<typeof import("../src/coding-folder-command-transport.ts")>();
	return {
		LxdCodingFolderCommandTransport: class {
			constructor(options: LxdCodingFolderCommandTransportOptions) {
				mocked.folderTransports.push(options as unknown as Record<string, unknown>);
				// biome-ignore lint/correctness/noConstructorReturn: a test that runs commands gets the real transport.
				if (mocked.realTransports) return new real.LxdCodingFolderCommandTransport(options);
			}
		},
		codingFolderKeptCommand: mocked.keptCommand,
	};
});
// The guest agent on the folder model, as its client answers.
vi.mock("../src/coding-guest-client.ts", () => ({
	LxdCodingGuestClient: class {
		run = mocked.guestRun;
		output = mocked.guestOutput;
		cancel = mocked.guestCancel;
		quiesce = mocked.guestQuiesce;
		stopSession = mocked.guestStop;
		status = mocked.guestStatus;
		statusAll = mocked.guestStatusAll;
		mount = mocked.guestMount;
	},
	CodingGuestRefused: class extends Error {
		readonly code: string;
		constructor(code: string) {
			super(`CODING_GUEST_REFUSED:${code}`);
			this.code = code;
		}
	},
}));
vi.mock("../src/coding-machine.ts", async (original) => {
	const real = await original<typeof import("../src/coding-machine.ts")>();
	return {
		...real,
		reconcileCodingMachine: (input: CodingMachineReconcileOptions) =>
			mocked.realReconcile ? real.reconcileCodingMachine(input) : mocked.reconcile(input),
		codingMachineStartOperation: (root: string, plan: Parameters<typeof real.codingMachineStartOperation>[1]) =>
			mocked.realReconcile ? real.codingMachineStartOperation(root, plan) : mocked.startOperation(root, plan),
		codingMachineLastStart: mocked.lastStart,
		dropCodingMachineStart: mocked.dropStart,
		undropCodingMachineStart: mocked.undropStart,
		codingMachineStartDropped: mocked.startDropped,
		recordCodingMachineDisk: mocked.recordDisk,
		codingMachineDisk: mocked.disk,
	};
});
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
	mocked.realTransports = false;
	mocked.realReconcile = false;
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
		/** The machine stopped from outside after its settled start: the next reconcile hands that stop over, until a start. */
		stoppedFromOutside: false,
		/** The LXD operation of the machine's latest start, which names a stop from outside after it. */
		startOperationId: "",
		/** SQL marked the machine to restart for the company folder: its next start's record clears it. */
		folderRestart: false,
		/** SQL marked the machine for a new disk (F3 5g-5), which marks it to restart too: its rebuild's record clears both. */
		newDisk: false,
		/** The machine's image is no longer in the node's store: a rebuild from it fails before anything goes out. */
		imageGone: false,
		/** The LXD operations of the machine's create, starts, stops and rebuilds, in order: a start follows the last. */
		effects: [] as string[],
		/** What each of those operations was. */
		kinds: new Map<string, "create" | "start" | "stop" | "rebuild">(),
		/** The rebuild that gave the machine the disk it has, as written down next to its journal: none for its first. */
		disk: null as string | null,
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
	// Stops from outside as SQL keeps them: the start each ended -> the attachments its record ended.
	const outsideStops = new Map<string, { workerId: string; attachmentToken: string }[]>();
	// Folder restarts' records as SQL keeps them: the effect each start followed -> what its record answered.
	const folderRestarts = new Map<string, Record<string, unknown>>();
	// New disks' records as SQL keeps them: the rebuild -> what its record answered.
	const newDisks = new Map<string, Record<string, unknown>>();
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
				// Only a machine marked for a new disk is rebuilt.
				if (args.p_intent === "rebuild" && !state.newDisk)
					return { state: "refused", reason: "MACHINE_NO_NEW_DISK" };
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
			case "qorpera_record_coding_machine_load": {
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				const sessions = (args.p_load as { sessions?: unknown[] } | undefined)?.sessions;
				return {
					schema: "qorpera.coding-machine-load-recorded/v1",
					machineId: args.p_machine_id,
					sessions: Array.isArray(sessions) ? sessions.length : 0,
				};
			}
			case "qorpera_record_coding_session_detached":
				if (attachments.get(String(args.p_worker_id)) === args.p_attachment_token)
					attachments.delete(String(args.p_worker_id));
				return { schema: "qorpera.coding-detached/v1", workerId: args.p_worker_id, state: "detached" };
			case "qorpera_record_coding_machine_stopped": {
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				// Every attachment on the machine ends as MACHINE_STOPPED, once per stop: the same stop recorded
				// again gets the first answer and ends nothing.
				const stop = String(args.p_start_operation_id);
				if (!outsideStops.has(stop)) {
					outsideStops.set(
						stop,
						[...attachments].map(([workerId, attachmentToken]) => ({ workerId, attachmentToken })),
					);
					attachments.clear();
				}
				return {
					schema: "qorpera.coding-machine-stopped/v1",
					machineId: args.p_machine_id,
					detached: outsideStops.get(stop),
				};
			}
			case "qorpera_mark_coding_machine_folder_restart":
			case "qorpera_mark_coding_machine_new_disk":
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				// A mark for a new disk marks the machine to restart too.
				if (method === "qorpera_mark_coding_machine_new_disk") state.newDisk = true;
				state.folderRestart = true;
				return {
					schema: "qorpera.coding-machine-folder-restart/v1",
					machineId: args.p_machine_id,
					state: "marked",
				};
			case "qorpera_record_coding_machine_folder_restart": {
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				if (typeof args.p_operation_id !== "string" || !args.p_operation_id)
					throw new Error("Coding machine input invalid");
				// A second record of the same start answers what the first did and changes nothing.
				const recorded = folderRestarts.get(args.p_operation_id);
				if (recorded) return recorded;
				// A marked machine's restart ends every attachment on it as FOLDER_RESTART and clears the mark; an
				// unmarked one's changes nothing. One marked for a new disk ends them as MACHINE_NEW_DISK and keeps both
				// marks: it is rebuilt before it starts.
				const detached = state.folderRestart
					? [...attachments].map(([workerId, attachmentToken]) => ({ workerId, attachmentToken }))
					: [];
				if (state.folderRestart) attachments.clear();
				const restarted = state.folderRestart;
				if (!state.newDisk) state.folderRestart = false;
				const answer = {
					schema: "qorpera.coding-machine-folder-restart/v1",
					machineId: args.p_machine_id,
					state: state.newDisk ? "new-disk" : restarted ? "restarted" : "unmarked",
					detached,
				};
				folderRestarts.set(args.p_operation_id, answer);
				return answer;
			}
			case "qorpera_record_coding_machine_new_disk": {
				if (args.p_owner !== "coding-host" || args.p_binding_text !== plan.text)
					throw new Error("Coding machine custody differs");
				if (typeof args.p_operation_id !== "string" || !args.p_operation_id)
					throw new Error("Coding machine input invalid");
				// A second record of the same rebuild answers what the first did.
				const recorded = newDisks.get(args.p_operation_id);
				if (recorded) return recorded;
				if (!state.newDisk) throw new Error("Coding machine is not marked for a new disk");
				// Every attachment still on it ends as MACHINE_NEW_DISK, and both marks are cleared.
				const answer = {
					schema: "qorpera.coding-machine-folder-restart/v1",
					machineId: args.p_machine_id,
					state: "replaced",
					detached: [...attachments].map(([workerId, attachmentToken]) => ({ workerId, attachmentToken })),
				};
				attachments.clear();
				state.newDisk = false;
				state.folderRestart = false;
				newDisks.set(args.p_operation_id, answer);
				return answer;
			}
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
		hasImage: vi.fn(async () => !state.imageGone),
		allowsAgentCard: vi.fn(async () => true),
		replaceInstanceDevices: vi.fn(async (_project, _name, devices) => {
			if (state.applyDevices) lxd.devices = structuredClone(devices) as Devices;
		}),
		readInstanceFile: vi.fn(async (_project, _name, path) => {
			const file = files.get(path);
			if (!file) throw new Error("Missing file");
			return file;
		}),
		readCodingMachineMemory: vi.fn(async (_project, _name, groups) => {
			const meminfo =
				files.get("/proc/meminfo")?.content.toString("utf8") ??
				"MemTotal:        8388608 kB\nMemAvailable:    6291456 kB\n";
			const stats = new Map<string, string>();
			for (const path of groups) {
				const content = files.get(path)?.content.toString("utf8").trim();
				if (content) stats.set(path, content);
			}
			return { meminfo, stats };
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
	/** A new LXD operation on the machine, of `kind`. */
	const effect = (kind: "create" | "start" | "stop" | "rebuild") => {
		const operationId = randomUUID();
		state.effects.push(operationId);
		state.kinds.set(operationId, kind);
		return operationId;
	};
	mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
		const intent = input.desiredState === "running" ? "run" : input.desiredState === "stopped" ? "stop" : "delete";
		await input.authorize(intent, input.signal);
		// As coding-machine.ts does: the outside stop goes to the executor before anything is done to the machine.
		if (state.stoppedFromOutside && lxd.exists && !lxd.running)
			await input.stoppedFromOutside?.(state.startOperationId, input.signal);
		if (input.desiredState === "running") {
			// Starting a stopped machine is a new LXD operation, which the executor hears of first, named by the effect
			// it follows (its create, the first time). If the executor answers that the machine gets a new disk first, its
			// image must still be on the node, a rebuild goes out under custody's authority, and the start after it is
			// heard of again, named by the rebuild.
			if (!lxd.running) {
				if (!state.effects.length) effect("create");
				const after = state.effects.at(-1) as string;
				if ((await input.starting?.(after, input.signal, state.kinds.get(after) ?? "create")) === "rebuild") {
					const fingerprint = input.plan.request?.source.fingerprint as string;
					if (!(await input.client.hasImage?.(input.plan.project, fingerprint, input.signal)))
						throw new Error("CODING_MACHINE_IMAGE_GONE");
					await input.authorize("rebuild", input.signal);
					const rebuilt = effect("rebuild");
					await input.authorize(intent, input.signal);
					await input.starting?.(rebuilt, input.signal, "rebuild");
				}
				state.startOperationId = effect("start");
			}
			lxd.exists = true;
			lxd.running = true;
			state.stoppedFromOutside = false;
		} else if (input.desiredState === "stopped") {
			if (lxd.running) effect("stop");
			lxd.running = false;
		} else lxd.exists = false;
		return { state: input.desiredState };
	});
	// The machine's journal, as coding-machine.ts reads it: the start it last ran under (none before its first), and
	// the marks of the boots whose reads were dropped (F3 5g-5), none until a test writes one.
	mocked.lastStart.mockImplementation(async () => state.startOperationId || null);
	mocked.dropStart.mockResolvedValue(true);
	mocked.undropStart.mockResolvedValue(undefined);
	mocked.startDropped.mockResolvedValue(false);
	mocked.recordDisk.mockImplementation(async (_root: string, _plan: unknown, operationId: string) => {
		state.disk = operationId;
	});
	mocked.disk.mockImplementation(async () => state.disk);
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
		/** The machine's boot, as its boot_id file names it. */
		bootId,
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
	it("ends every attachment of a machine stopped from outside and unplugs its folders before the next turn starts it", async () => {
		const f = await fixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		const token = f.attachments.get(f.claim.workerId);
		// A node restart: LXD shows the machine stopped after its settled start.
		const started = f.state.startOperationId;
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		const running: boolean[] = [];
		const apply = vi.mocked(f.client.replaceInstanceDevices).getMockImplementation()!;
		vi.mocked(f.client.replaceInstanceDevices).mockClear();
		vi.mocked(f.client.replaceInstanceDevices).mockImplementation(async (...args) => {
			running.push(f.lxd.running);
			await apply(...args);
		});
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// Both sessions' attachments ended in one record of that stop, before anything else was done to the machine.
		expect(f.calls("qorpera_record_coding_machine_stopped")).toEqual([
			{
				p_machine_id: f.machine.machineId,
				p_start_operation_id: started,
				p_owner: "coding-host",
				p_binding_text: f.plan.text,
				p_machine_id_sha256: "f".repeat(64),
			},
		]);
		const recorded =
			f.call.mock.invocationCallOrder[
				f.call.mock.calls.findIndex((c) => c[0] === "qorpera_record_coding_machine_stopped")
			]!;
		expect(recorded).toBeLessThan(vi.mocked(f.client.replaceInstanceDevices).mock.invocationCallOrder[0]!);
		// Their folders came off while it was stopped; once started, only this turn's session went back on, newly attached.
		expect(vi.mocked(f.client.replaceInstanceDevices).mock.calls.map((call) => call[2])).toEqual([
			f.base,
			{ ...f.base, ...f.sessionDevices(f.claim.workerId) },
		]);
		expect(running).toEqual([false, true]);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		expect([...f.attachments.keys()]).toEqual([f.claim.workerId]);
		expect(f.attachments.get(f.claim.workerId)).not.toBe(token);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
	});
	it("starts nothing while the outside stop is not recorded, and records it on the next try", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		const answer = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_record_coding_machine_stopped"
				? {
						schema: "qorpera.coding-machine-stopped/v1",
						machineId: args.p_machine_id,
						detached: [{ workerId: "x" }],
					}
				: answer(method, args, signal),
		);
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_MACHINE_STOPPED_UNCONFIRMED",
		);
		expect(f.lxd.running).toBe(false);
		expect(f.lxd.devices).toEqual({ ...f.base, ...f.sessionDevices(f.claim.workerId) });
		f.call.mockImplementation(answer);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.calls("qorpera_record_coding_machine_stopped")).toHaveLength(2);
		expect(f.lxd).toMatchObject({ running: true, devices: { ...f.base, ...f.sessionDevices(f.claim.workerId) } });
	});
	it("names each outside stop by the start it ended, so an abandoned record reaching SQL late ends nothing", async () => {
		const f = await fixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const token = f.attachments.get(f.claim.workerId)!;
		const started = f.state.startOperationId;
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		// The first try gives up on its record, which SQL has not run yet.
		const answer = f.call.getMockImplementation()!;
		let abandoned: Record<string, unknown> | undefined;
		f.call.mockImplementation(async (method, args, signal) => {
			if (method !== "qorpera_record_coding_machine_stopped" || abandoned) return answer(method, args, signal);
			abandoned = args;
			throw new Error("The record was abandoned");
		});
		const nextTurn = (sequence: number) => {
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		await expect(nextTurn(2)).rejects.toThrow("The record was abandoned");
		expect(f.lxd.running).toBe(false);
		// The next try records the same stop, then starts the machine and attaches the session anew.
		await nextTurn(2);
		const fresh = f.attachments.get(f.claim.workerId)!;
		expect(f.lxd.running).toBe(true);
		expect(fresh).not.toBe(token);
		expect(f.calls("qorpera_record_coding_machine_stopped").map((args) => args.p_start_operation_id)).toEqual([
			started,
			started,
		]);
		// The abandoned record reaches SQL now: it gets the first record's answer and the fresh attachment stays.
		expect(await answer("qorpera_record_coding_machine_stopped", abandoned!, f.signal)).toEqual({
			schema: "qorpera.coding-machine-stopped/v1",
			machineId: f.machine.machineId,
			detached: [{ workerId: f.claim.workerId, attachmentToken: token }],
		});
		expect(f.attachments.get(f.claim.workerId)).toBe(fresh);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		// The machine stops from outside again: that stop is named by the newer start and ends the fresh attachment.
		f.host.endTurn(f.claim);
		const restarted = f.state.startOperationId;
		expect(restarted).not.toBe(started);
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		await nextTurn(3);
		expect(f.calls("qorpera_record_coding_machine_stopped").map((args) => args.p_start_operation_id)).toEqual([
			started,
			started,
			restarted,
		]);
		expect(f.attachments.get(f.claim.workerId)).not.toBe(fresh);
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
	it("reads each helper whole within the helpers' bound: one past 64 KiB is taken when it is the pin, one past the bound is refused", async () => {
		// The LXD client's own rule: a read past its bound fails (LXD_INSTANCE_FILE_UNCONFIRMED).
		const bounded = (f: Awaited<ReturnType<typeof fixture>>) => {
			const read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!;
			vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
				const file = await read(project, name, path, limit, signal);
				if (file.content.length > limit) throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
				return file;
			});
		};
		const helper = "/opt/qorpera-coding/cloud-coding-command-guest.mjs";
		const large = Buffer.alloc(100_000, 0x61);
		const f = await fixture();
		f.files.get(helper)!.content = large;
		bounded(f);
		const host = new LxdCodingExecutorHost({
			...f.options,
			guest: { ...f.options.guest, commandHelperSha256: createHash("sha256").update(large).digest("hex") },
		});
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const helperReads = vi
			.mocked(f.client.readInstanceFile)
			.mock.calls.filter(([, , path]) => path.startsWith("/opt/qorpera-coding/"));
		expect(new Set(helperReads.map(([, , path]) => path))).toEqual(
			new Set([
				helper,
				"/opt/qorpera-coding/cloud-coding-git-guest.mjs",
				"/opt/qorpera-coding/cloud-coding-watchdog.mjs",
				"/opt/qorpera-coding/cloud-coding-storage-guest.mjs",
			]),
		);
		for (const [, , , limit] of helperReads) expect(limit).toBe(CODING_GUEST_HELPER_MAX_BYTES);
		const over = Buffer.alloc(CODING_GUEST_HELPER_MAX_BYTES + 1, 0x61);
		const g = await fixture();
		g.files.get(helper)!.content = over;
		bounded(g);
		const refusing = new LxdCodingExecutorHost({
			...g.options,
			guest: { ...g.options.guest, commandHelperSha256: createHash("sha256").update(over).digest("hex") },
		});
		await expect(refusing.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			"LXD_INSTANCE_FILE_UNCONFIRMED",
		);
	});
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
	it("takes a session off without hanging anything off the signal that lasts as long as its process (abort-scope.ts)", async () => {
		const f = await fixture();
		await released(f);
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await f.host.keep(lasting.signal);
			expect(await f.host.settled()).toEqual([takenOff(f)]);
			expect(watch.made()).toBeGreaterThan(0);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
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
	it("hangs nothing off the signal that lasts as long as its process, keeping or housekeeping (abort-scope.ts)", async () => {
		const f = await fixture();
		const lasting = new AbortController();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const watch = watchAbortSignalAny();
		try {
			expect(await f.host.keep(lasting.signal)).toEqual([
				{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			]);
			await f.host.housekeep(lasting.signal);
			expect(watch.made()).toBeGreaterThan(0);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});

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
	it("ends the attachments of a machine stopped from outside as MACHINE_STOPPED before it sleeps or goes", async () => {
		const f = await fixture();
		await awake(f);
		const token = f.attachments.get(f.claim.workerId);
		f.state.listed = [f.entry({ sleepDue: true })];
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		expect((await f.host.housekeep(f.signal))[0]?.state).toBe("done");
		expect(f.client.execInstance).not.toHaveBeenCalled();
		expect(f.calls("qorpera_record_coding_machine_stopped")).toHaveLength(1);
		// The sleep's own record comes after it, for an attachment already ended.
		const order = (method: string) =>
			f.call.mock.invocationCallOrder[f.call.mock.calls.findIndex((c) => c[0] === method)]!;
		expect(order("qorpera_record_coding_machine_stopped")).toBeLessThan(
			order("qorpera_record_coding_session_detached"),
		);
		expect(f.calls("qorpera_record_coding_session_detached")).toEqual([
			expect.objectContaining({ p_attachment_token: token, p_reason: "SLEEP", p_stopped: [] }),
		]);
		expect(f.attachments.size).toBe(0);
		expect(f.lxd).toMatchObject({ exists: true, running: false, devices: f.base });
		// A machine removed after such a stop: seen again by the delete, which finds nothing attached.
		const g = await fixture();
		await awake(g);
		g.state.listed = [g.entry({ removeDue: true, superseded: true })];
		g.lxd.running = false;
		g.state.stoppedFromOutside = true;
		expect((await g.host.housekeep(g.signal))[0]?.state).toBe("done");
		expect(reconciled()).toEqual(["stopped", "deleted"]);
		expect(g.calls("qorpera_record_coding_machine_stopped")).toHaveLength(2);
		expect(g.lxd.exists).toBe(false);
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
			repository: f.claim.repository!,
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

/** The folder model's wait for a machine's boot to finish. */
const SETTLED = [...CODING_BOOT_READY_COMMAND];
const isSettledCommand = (command: readonly string[]) => command.join("\0") === SETTLED.join("\0");

/** The fixture on the folder model: the session's views, the folder service's boundary, its repositories and the guest
 * agent, faked. `repositories` false leaves the executor's default: none, at /company. */
async function folderFixture(repositories = true) {
	const f = await fixture();
	const startOperationId = randomUUID(),
		viewId = randomUUID(),
		cwd = `/company/code/app/worktrees/${f.claim.workerId}`;
	mocked.startOperation.mockResolvedValue(startOperationId);
	/** The guest agent's status of a session: `commands`, and its usage so far on this boot, `usage` aside. */
	const status = (
		commands: readonly { commandId: string; state: string }[] = [],
		usage: Partial<CodingGuestUsage> = {},
	) => ({
		commands,
		usage: { bootId: f.bootId, uptimeMs: 600_000, cpuUsageUsec: 0, ioBytes: 0, ioComplete: true, ...usage },
	});
	mocked.guestStatus.mockResolvedValue(status());
	mocked.guestStatusAll.mockRejectedValue(new CodingGuestRefused("CODING_GUEST_ARGUMENTS_INVALID"));
	mocked.guestCancel.mockResolvedValue({});
	mocked.guestQuiesce.mockResolvedValue({});
	mocked.guestStop.mockResolvedValue({});
	/** The view each session holds, as its record names it: from its attach until its end. */
	const held = new Map<string, CodingFolderViewHeld>();
	/** What the machine's agent says of its package caches at the mount: a new agent that made them, unless a test says
	 * otherwise (an agent from before, or one that could not make them, says false). */
	const agent = { packageCaches: true };
	const views = {
		attach: vi.fn<CodingFolderViews["attach"]>(async (session) => {
			const { machineId } = session.machine;
			held.set(session.workerId, { machineId, bootId: session.bootId, attachmentToken: session.attachmentToken });
			return { viewId, packageCaches: agent.packageCaches };
		}),
		held: vi.fn<CodingFolderViews["held"]>(async (workerId) => held.get(workerId)),
		end: vi.fn<CodingFolderViews["end"]>(async (workerId) => {
			held.delete(workerId);
			return { workerId, viewId, saved: true, closed: true };
		}),
		endMachine: vi.fn<CodingFolderViews["endMachine"]>(async (machineId) => {
			for (const [workerId, view] of held) if (view.machineId === machineId) held.delete(workerId);
			return [];
		}),
	};
	const boundary = vi.fn<CodingFolderControl["boundary"]>(async (machine) => ({
		machine,
		reads: "released",
		views: [{ viewId, unsaved: 0 }],
	}));
	// Every read the machine was served before was released, unless a test says otherwise (F3 5g-5).
	const restarted = vi.fn<CodingFolderControl["restarted"]>(async () => false);
	// No secret values known here, unless a test says otherwise (5j-5 (a)).
	const secrets = vi.fn<CodingFolderControl["secrets"]>(async () => null);
	const sessionRepositories = {
		prepare: vi.fn<CodingFolderRepositories["prepare"]>(async () => ({ cwd })),
		export: vi.fn<CodingFolderRepositories["export"]>(async () => Buffer.from("bundle")),
	};
	const onMount = vi.fn();
	const folderExecStream = vi.fn<LxdInstanceExecStreamClient["execInstanceStream"]>(async () => ({
		exitCode: 0,
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
	}));
	const folder = {
		views,
		control: { boundary, restarted, secrets },
		client: { execInstanceStream: folderExecStream },
		...(repositories ? { repositories: sessionRepositories } : {}),
		onMount,
	};
	const host = new LxdCodingExecutorHost({ ...f.options, folder });
	/** An executor process whose views are real ones over `records`, as `real` makes them; each call is the next. */
	const executor = (real: Awaited<ReturnType<typeof realViews>>) =>
		new LxdCodingExecutorHost({
			...f.options,
			folder: { ...folder, views: real.views(), control: { boundary: real.boundary, restarted, secrets } },
		});
	return {
		...f,
		host,
		folder,
		folderExecStream,
		executor,
		views,
		boundary,
		restarted,
		secrets,
		repositories: sessionRepositories,
		onMount,
		startOperationId,
		viewId,
		cwd,
		status,
		agent,
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
					bootId: f.bootId,
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
			[{ workerId: f.claim.workerId, machineId: f.machine.machineId, viewId: f.viewId, packageCaches: true }],
		]);
		// The session's repositories made ready first, then attached in SQL, then mounted: the new view lists the worktree.
		const attached = f.call.mock.calls.findIndex((call) => call[0] === "qorpera_attach_coding_session");
		expect(f.repositories.prepare.mock.invocationCallOrder[0]).toBeLessThan(
			f.call.mock.invocationCallOrder[attached]!,
		);
		expect(f.call.mock.invocationCallOrder[attached]).toBeLessThan(f.views.attach.mock.invocationCallOrder[0]!);
		expect(f.repositories.prepare.mock.calls[0]?.[0]).toMatchObject({
			claim: f.claim,
			machine: f.machine,
			uid: 200000,
			baseSha: f.baseSha,
		});
		// The machine runs, its LXD agent answers and its boot has finished. The host plugs, configures, seeds and leases
		// nothing in the guest: the view (faked here) brings the guest agent and the folder program.
		expect(f.execs()).toEqual([["/usr/bin/true"], SETTLED]);
		expect(f.client.replaceInstanceDevices).not.toHaveBeenCalled();
		expect(f.client.pushInstanceFile).not.toHaveBeenCalled();
		expect(mocked.seedFetch).not.toHaveBeenCalled();
		expect(mocked.seedTransfer).not.toHaveBeenCalled();
		expect(mocked.refresh).not.toHaveBeenCalled();
		expect(mocked.leaseTransports).toEqual([]);
		// Its commands run as its user, at its worktree, with Git's settings for the company folder and the machine's
		// package caches, under this boot's start, and kept in the session's custody folder.
		const authorize = vi.fn(async () => undefined);
		await f.host.commandTransport(f.scope(), authorize, f.signal);
		expect(mocked.commandTransports).toEqual([]);
		expect(mocked.folderTransports).toEqual([
			expect.objectContaining({
				machine: f.machine,
				scope: f.scope(),
				currentStart: expect.any(Function),
				session: {
					uid: 200000,
					gid: 200000,
					cwd: f.cwd,
					environment: { ...codingFolderGitEnvironment(f.claim.workerId), ...CODING_PACKAGE_CACHE_ENVIRONMENT },
				},
				custody: lxdCodingSessionStorage(f.machine, f.placement, f.claim.workerId).custodySource,
				limitBytes: 67108864,
			}),
		]);
		// Its commits are by the session, named by its worker id, for author and committer alike.
		expect(codingFolderGitEnvironment(f.claim.workerId)).toEqual({
			...CODING_FOLDER_GIT_ENVIRONMENT,
			GIT_AUTHOR_NAME: "Qorpera coding session",
			GIT_AUTHOR_EMAIL: `${f.claim.workerId}@coding.qorpera.com`,
			GIT_COMMITTER_NAME: "Qorpera coding session",
			GIT_COMMITTER_EMAIL: `${f.claim.workerId}@coding.qorpera.com`,
		});
		expect(CODING_FOLDER_GIT_ENVIRONMENT).toMatchObject({
			GIT_CONFIG_COUNT: "13",
			GIT_CONFIG_KEY_2: "gc.auto",
			GIT_CONFIG_VALUE_2: "0",
			GIT_CONFIG_KEY_12: "protocol.ext.allow",
			GIT_CONFIG_VALUE_12: "never",
		});
		const transport = mocked.folderTransports[0] as {
			currentStart: () => string | undefined;
			authorize: (...args: unknown[]) => Promise<void>;
		};
		expect(transport.currentStart()).toBe(f.startOperationId);
		// Each of its steps asks the turn's own authority first.
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
	it("attaches and mounts nothing when the session's repositories are not made ready", async () => {
		const f = await folderFixture();
		f.repositories.prepare.mockRejectedValueOnce(new Error("CODE_HOST_SEED_BASE_GONE"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow("CODE_HOST_SEED_BASE_GONE");
		expect(f.repositories.prepare).toHaveBeenCalledTimes(1);
		expect(f.calls("qorpera_attach_coding_session")).toEqual([]);
		expect(f.views.attach).not.toHaveBeenCalled();
		expect(f.onMount).not.toHaveBeenCalled();
	});
	it("says at each mount whether the machine's agent said its package caches are ready (the log line a proof reads)", async () => {
		const f = await folderFixture();
		f.agent.packageCaches = false;
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.onMount.mock.calls).toEqual([
			[{ workerId: f.claim.workerId, machineId: f.machine.machineId, viewId: f.viewId, packageCaches: false }],
		]);
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
		expect(f.views.end).not.toHaveBeenCalled();
		// The machine restarted: nothing of the session is left in it. Its view ends first, while its attachment is the
		// live one, and a new generation is taken.
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		await next(3);
		expect(f.views.end.mock.calls).toEqual([[f.claim.workerId, f.signal]]);
		const attaches = f.call.mock.calls.flatMap(([method], index) =>
			method === "qorpera_attach_coding_session" ? [f.call.mock.invocationCallOrder[index]!] : [],
		);
		expect(attaches).toHaveLength(3);
		expect(f.views.end.mock.invocationCallOrder[0]).toBeGreaterThan(attaches[1]!);
		expect(f.views.end.mock.invocationCallOrder[0]).toBeLessThan(attaches[2]!);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: null });
		expect(f.attachments.get(f.claim.workerId)).not.toBe(token);
		expect(f.views.attach.mock.calls.at(-1)?.[0].attachmentToken).toBe(f.attachments.get(f.claim.workerId));
		expect(mocked.resolveBase).toHaveBeenCalledTimes(1);
	});
	/** The session's next turn on `host`. */
	const nextTurn = async (
		f: Awaited<ReturnType<typeof folderFixture>>,
		host: LxdCodingExecutorHost,
		sequence: number,
	) => {
		host.endTurn(f.claim);
		f.renew(f.claim);
		f.claim.sequence = sequence;
		f.sequences.set(f.claim.workerId, sequence);
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
	};
	it("attaches only once the machine's boot has finished, waited for once per boot", async () => {
		// Live 2026-10-16 (P3 phase A run 4): attached while its fresh machine was still booting, a session's first mount
		// ran out of its attachment's minute before the folder program started.
		const f = await folderFixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let finish!: () => void;
		const booted = new Promise<void>((done) => {
			finish = done;
		});
		const waited = vi.fn();
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (!isSettledCommand(command)) return fallback(project, name, command, signal);
			waited(command);
			await booted;
		});
		const prepared = f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await vi.waitFor(() => expect(waited).toHaveBeenCalledWith(SETTLED));
		expect(f.calls("qorpera_attach_coding_session")).toEqual([]);
		finish();
		await prepared;
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(1);
		expect(f.views.attach).toHaveBeenCalledTimes(1);
		await nextTurn(f, f.host, 2);
		expect(waited).toHaveBeenCalledTimes(1);
		let newBootAttempts = 0;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (!isSettledCommand(command)) return fallback(project, name, command, signal);
			waited(command);
			newBootAttempts += 1;
			if (newBootAttempts === 1) throw new Error("LXD instance command failed");
		});
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		await nextTurn(f, f.host, 3);
		expect(waited).toHaveBeenCalledTimes(3);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(3);
		await nextTurn(f, f.host, 4);
		expect(waited).toHaveBeenCalledTimes(3);
	});
	it("attaches anyway once a boot is still unfinished at the limit, and waits for it again on the next turn", async () => {
		const f = await folderFixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		const waited = vi.fn();
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (!isSettledCommand(command)) return fallback(project, name, command, signal);
			waited(command);
			await new Promise((_done, fail) =>
				signal!.addEventListener("abort", () => fail(signal!.reason), { once: true }),
			);
		});
		const impatient = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, bootSettleTimeoutMs: 50 });
		await impatient.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(waited).toHaveBeenCalledTimes(1);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(1);
		expect(f.views.attach).toHaveBeenCalledTimes(1);
		await nextTurn(f, impatient, 2);
		expect(waited).toHaveBeenCalledTimes(2);
		expect(f.views.attach).toHaveBeenCalledTimes(2);
	});
	it("waits for the boot again when a wait ends without an answer, and attaches once it has finished", async () => {
		// LXD's own wait for the exec ends at its operation limit (120 s by default), and an agent just up can fail an
		// exec before it runs.
		const f = await folderFixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		const unanswered = [new Error("LXD operation failed"), new Error("LXD instance agent not running")];
		const waited = vi.fn();
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (!isSettledCommand(command)) return fallback(project, name, command, signal);
			waited(command);
			const failure = unanswered.shift();
			if (failure) throw failure;
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(waited).toHaveBeenCalledTimes(3);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(1);
		expect(f.views.attach).toHaveBeenCalledTimes(1);
		await nextTurn(f, f.host, 2);
		expect(waited).toHaveBeenCalledTimes(3);
	});
	it("fails the turn before its attach when the wait for the boot fails otherwise", async () => {
		const f = await folderFixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (!isSettledCommand(command)) return fallback(project, name, command, signal);
			throw new Error("LXD: Instance is not running");
		});
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			/^LXD: Instance is not running$/,
		);
		expect(f.calls("qorpera_attach_coding_session")).toEqual([]);
		expect(f.views.attach).not.toHaveBeenCalled();
	});
	describe("a wake whose storage or machine fails", () => {
		/** A host whose steps on the NAS may take 100 ms each. */
		const impatient = (f: Awaited<ReturnType<typeof folderFixture>>) =>
			new LxdCodingExecutorHost({ ...f.options, folder: f.folder, storageStepTimeoutMs: 100 });
		it("tries a folder check the NAS was slow to answer again, and the wake goes on (C8 C4-1, 26 Oct 2026)", async () => {
			const f = await folderFixture();
			// The wake's first step, the check of the machines' folder, gets its answer only after its time ran out.
			mocked.storageAssert.mockImplementationOnce(() => new Promise((done) => globalThis.setTimeout(done, 250)));
			expect(await impatient(f).prepareWorkspace(f.claim, f.turn(), f.signal)).toEqual({
				vmId: f.machine.machineId,
				baseSha: f.baseSha,
			});
			expect(reconciled()).toEqual(["running"]);
			expect(f.views.attach).toHaveBeenCalledTimes(1);
		});
		it("fails the turn with the storage's own code once the NAS stays slow past the last try, sending it one request at a time", async () => {
			const f = await folderFixture();
			mocked.storageAssert.mockImplementationOnce(() => new Promise(() => {}));
			const started = performance.now();
			const failed = await impatient(f)
				.prepareWorkspace(f.claim, f.turn(), f.signal)
				.catch((error: unknown) => error);
			const took = performance.now() - started;
			expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
			expect(failed).toMatchObject({
				message: "CODING_HOST_STORAGE_TIMEOUT",
				summary:
					"The coding machine's storage did not answer in time, so the turn could not start. The workspace is kept; a follow-up tries again. [code=CODING_HOST_STORAGE_TIMEOUT]",
			});
			// Three tries of 100 ms with a pause of 250 ms and then 500 ms between them; each later try waited for the one
			// before it, which never answered, so the NAS was asked once.
			expect(took).toBeGreaterThanOrEqual(1000);
			expect(took).toBeLessThan(5000);
			expect(mocked.storageAssert).toHaveBeenCalledTimes(1);
			// The wake never reached the machine.
			expect(mocked.reconcile).not.toHaveBeenCalled();
			expect(f.views.attach).not.toHaveBeenCalled();
		});
		it("names no storage timeout for a caller that gave up, and tries nothing again", async () => {
			const f = await folderFixture();
			const gaveUp = new AbortController();
			// The turn's lease is lost while the wake's first check waits for the NAS, before that check's own time ran out.
			mocked.storageAssert.mockImplementationOnce(() => {
				globalThis.setTimeout(() => gaveUp.abort(new Error("CODING_EXECUTOR_LEASE_LOST")), 20);
				return new Promise(() => {});
			});
			await expect(impatient(f).prepareWorkspace(f.claim, f.turn(), gaveUp.signal)).rejects.toThrow(
				/^CODING_EXECUTOR_LEASE_LOST$/,
			);
			expect(mocked.storageAssert).toHaveBeenCalledTimes(1);
			expect(mocked.reconcile).not.toHaveBeenCalled();
		});
		it("fails a check that fails otherwise at once, without trying it again", async () => {
			const f = await folderFixture();
			mocked.storageAssert.mockRejectedValueOnce(new Error("CODING_NAS_CONTROL_INVALID"));
			const failed = await impatient(f)
				.prepareWorkspace(f.claim, f.turn(), f.signal)
				.catch((error: unknown) => error);
			expect(failed).not.toBeInstanceOf(CodingWorkspaceFailed);
			expect((failed as Error).message).toBe("CODING_NAS_CONTROL_INVALID");
			expect(mocked.storageAssert).toHaveBeenCalledTimes(1);
		});
		it("reads the machine's project before its create, and fails the turn with the project's own code when it refuses the agent card", async () => {
			const f = await folderFixture();
			vi.mocked(f.client.allowsAgentCard).mockResolvedValue(false);
			// As coding-machine.ts does before a create with the agent card.
			mocked.reconcile.mockImplementationOnce(async (input: CodingMachineReconcileOptions) => {
				await input.authorize("run", input.signal);
				if (!(await input.projectAllowsAgentCard?.(input.plan.project, input.signal)))
					throw new Error("CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD");
				throw new Error("created");
			});
			const failed = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
			expect(failed).toBeInstanceOf(CodingWorkspaceFailed);
			expect(failed).toMatchObject({
				message: "CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD",
				summary:
					"No computer could start for this session: its node does not allow the machine's network card yet, and an operator must allow it there. The workspace is kept; a follow-up tries again once that is done. [code=CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD]",
			});
			expect(f.client.allowsAgentCard).toHaveBeenCalledWith("coding", expect.any(AbortSignal));
			expect(f.views.attach).not.toHaveBeenCalled();
		});
		it("names LXD's status when an effect it refused leaves the machine to an operator, and keeps that outcome", async () => {
			for (const [lxdStatus, expected] of [
				[403, "CODING_HOST_VM_RECOVERY_REQUIRED:LXD_REFUSED_403"],
				[undefined, "CODING_HOST_VM_RECOVERY_REQUIRED"],
			] as const) {
				const f = await folderFixture();
				mocked.reconcile.mockImplementationOnce(async (input: CodingMachineReconcileOptions) => ({
					state: "recovery-required",
					machineId: input.plan.machineId,
					instanceName: input.plan.name,
					instanceSha256: input.plan.instanceSha256,
					...(lxdStatus ? { lxdStatus } : {}),
				}));
				const failed = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
				expect(failed).not.toBeInstanceOf(CodingWorkspaceFailed);
				expect((failed as Error).message).toBe(expected);
			}
		});
	});
	it("checks the machine's agent again when an exec's LXD operation failed before it ran, up to the limit", async () => {
		// Live 2026-10-16 (P3 phase A run 5): just after the guest's lxd-agent came up, LXD timed out connecting to it
		// ("Timed out waiting for websockets to connect") and the turn failed before its attach.
		const f = await folderFixture();
		const fallback = vi.mocked(f.client.execInstance).getMockImplementation()!;
		let failures = 1;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/true" && failures-- > 0) throw new Error("LXD operation failed");
			return fallback(project, name, command, signal);
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.execs()).toEqual([["/usr/bin/true"], ["/usr/bin/true"], SETTLED]);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(1);
		// One that keeps failing is given up at the limit.
		const g = await folderFixture();
		vi.mocked(g.client.execInstance).mockRejectedValue(new Error("LXD operation failed"));
		const impatient = new LxdCodingExecutorHost({ ...g.options, folder: g.folder, guestReadyTimeoutMs: 50 });
		const started = performance.now();
		await expect(impatient.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			/^CODING_HOST_GUEST_NOT_READY$/,
		);
		expect(performance.now() - started).toBeLessThan(5000);
		expect(g.calls("qorpera_attach_coding_session")).toEqual([]);
	});
	it("reads the machine's boot id again when the read went unconfirmed just after its agent answered, up to the limit", async () => {
		// Live 2026-10-16 (P3 phase B run 1): `/usr/bin/true` ran on an lxd-agent just up, and the boot id read right
		// after it failed while LXD was still advertising its vsock address to that agent.
		const f = await folderFixture();
		const read = vi.mocked(f.client.readInstanceFile).getMockImplementation()!;
		let failures = 1;
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			if (path === "/proc/sys/kernel/random/boot_id" && failures-- > 0)
				throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
			return read(project, name, path, limit, signal);
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.execs()).toEqual([["/usr/bin/true"], ["/usr/bin/true"], SETTLED]);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(1);
		// One that keeps going unconfirmed is given up at the limit.
		const g = await folderFixture();
		const readG = vi.mocked(g.client.readInstanceFile).getMockImplementation()!;
		vi.mocked(g.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			if (path === "/proc/sys/kernel/random/boot_id") throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
			return readG(project, name, path, limit, signal);
		});
		const impatient = new LxdCodingExecutorHost({ ...g.options, folder: g.folder, guestReadyTimeoutMs: 50 });
		await expect(impatient.prepareWorkspace(g.claim, g.turn(), g.signal)).rejects.toThrow(
			/^CODING_HOST_GUEST_NOT_READY$/,
		);
		expect(g.calls("qorpera_attach_coding_session")).toEqual([]);
	});
	it("attaches a session under its view's attachment after the executor restarted, while the machine's boot is the same", async () => {
		const f = await folderFixture();
		const real = await realViews();
		const before = f.executor(real);
		await before.prepareWorkspace(f.claim, f.turn(), f.signal);
		before.endTurn(f.claim);
		const token = f.attachments.get(f.claim.workerId)!;
		// The executor restarted before any keeper pass: the session's next turn, on its new process.
		const next = async (sequence: number) => {
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			return f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		await next(2);
		// The same view, with whatever the first turn's commands left running.
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: hash(token) });
		expect(f.attachments.get(f.claim.workerId)).toBe(token);
		expect(real.opens).toHaveLength(1);
		expect(real.closes).toEqual([]);
		expect(real.boundary).not.toHaveBeenCalledWith(f.machine.machineId, [real.viewId], expect.anything());
		expect(mocked.guestMount.mock.calls.map(([asked]) => asked.view)).toEqual([
			{ environmentId: f.claim.environmentId, viewId: real.viewId, pass: real.pass },
			{ environmentId: f.claim.environmentId, viewId: real.viewId, pass: real.pass },
		]);
	});
	it("ends a view of the machine's earlier boot after the executor restarted, before the session attaches anew", async () => {
		const f = await folderFixture();
		const real = await realViews();
		await f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal);
		const token = f.attachments.get(f.claim.workerId)!;
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		real.boundary.mockClear();
		await f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal);
		// Its final boundary and its close, while its attachment is the live one; then a new generation and a new view,
		// after a boundary for what the machine's views have pending.
		expect(real.boundary.mock.calls).toEqual([
			[f.machine.machineId, [real.viewId], expect.any(AbortSignal)],
			[f.machine.machineId, [], expect.any(AbortSignal)],
		]);
		expect(real.closes).toEqual([{ p_view_id: real.viewId, p_pass: real.pass }]);
		const attaches = f.call.mock.calls.flatMap(([method], index) =>
			method === "qorpera_attach_coding_session" ? [index] : [],
		);
		expect(f.call.mock.calls[attaches.at(-1)!]?.[1]).toMatchObject({ p_guest_generation: null });
		expect(real.boundary.mock.invocationCallOrder[0]).toBeLessThan(
			f.call.mock.invocationCallOrder[attaches.at(-1)!]!,
		);
		const renewed = f.attachments.get(f.claim.workerId);
		expect(renewed).not.toBe(token);
		expect(real.opens).toHaveLength(2);
		expect(real.opens[1]).toMatchObject({ p_anchor: { workerId: f.claim.workerId, attachmentToken: renewed } });
	});
	it("attaches nothing anew while a view of the machine's earlier boot could not save what it had pending", async () => {
		const f = await folderFixture();
		const real = await realViews();
		await f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal);
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		real.boundary.mockImplementationOnce(async (machine, final) => ({
			machine,
			reads: "released",
			views: final.map((id) => ({ viewId: id, unsaved: 2 })),
		}));
		const attaches = f.calls("qorpera_attach_coding_session").length;
		await expect(f.executor(real).prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_FOLDER_VIEW_UNSAVED",
		);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(attaches);
		expect(real.opens).toHaveLength(1);
	});
	it("leaves a view on another machine to SQL, and attaches anew", async () => {
		const f = await folderFixture();
		f.views.held.mockResolvedValueOnce({
			machineId: randomUUID(),
			bootId: f.bootId,
			attachmentToken: randomUUID(),
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.views.end).not.toHaveBeenCalled();
		expect(f.calls("qorpera_attach_coding_session")).toEqual([expect.objectContaining({ p_guest_generation: null })]);
	});
	it("ends every view of a machine stopped from outside, then every attachment on it, before the next turn starts it", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		const tokens = [f.attachments.get(f.claim.workerId), f.attachments.get(second.workerId)];
		// A node restart: LXD shows the machine stopped after its settled start, and it boots anew.
		const started = f.state.startOperationId;
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${randomUUID()}\n`),
		});
		// The machine's views end as their records name them: each saved and closed, and its record gone.
		const end = f.views.endMachine.getMockImplementation()!;
		f.views.endMachine.mockImplementation(async (machineId, signal) => {
			const ends: CodingFolderViewEnd[] = [];
			for (const { workerId } of [f.claim, second])
				if ((await f.views.held(workerId, signal))?.machineId === machineId)
					ends.push({ workerId, viewId: f.viewId, saved: true, closed: true });
			await end(machineId, signal);
			return ends;
		});
		// The first try gives up on its record of the stop.
		const answer = f.call.getMockImplementation()!;
		const recorded: { running: boolean; ended: number }[] = [];
		f.call.mockImplementation(async (method, args, signal) => {
			if (method !== "qorpera_record_coding_machine_stopped") return answer(method, args, signal);
			recorded.push({ running: f.lxd.running, ended: f.views.endMachine.mock.calls.length });
			if (recorded.length === 1) throw new Error("The record was abandoned");
			return answer(method, args, signal);
		});
		const nextTurn = () => {
			f.renew(f.claim);
			f.claim.sequence = 2;
			f.sequences.set(f.claim.workerId, 2);
			return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		await expect(nextTurn()).rejects.toThrow("The record was abandoned");
		// Both views ended while their attachments were the live ones; with the stop not recorded, nothing started and
		// SQL still holds both attachments.
		expect(f.views.endMachine.mock.calls).toEqual([[f.machine.machineId, expect.any(AbortSignal)]]);
		expect(await f.views.endMachine.mock.results[0]?.value).toEqual([
			{ workerId: f.claim.workerId, viewId: f.viewId, saved: true, closed: true },
			{ workerId: second.workerId, viewId: f.viewId, saved: true, closed: true },
		]);
		expect(f.lxd.running).toBe(false);
		expect([f.attachments.get(f.claim.workerId), f.attachments.get(second.workerId)]).toEqual(tokens);
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(2);
		// The next try records the same stop, which ends both attachments, and only then starts the machine.
		await nextTurn();
		expect(f.views.endMachine).toHaveBeenCalledTimes(2);
		expect(f.calls("qorpera_record_coding_machine_stopped").map((args) => args.p_start_operation_id)).toEqual([
			started,
			started,
		]);
		expect(recorded).toEqual([
			{ running: false, ended: 1 },
			{ running: false, ended: 2 },
		]);
		expect(f.lxd.running).toBe(true);
		// Only this turn's session is attached again, under a new generation, and its view is opened under it.
		expect([...f.attachments.keys()]).toEqual([f.claim.workerId]);
		const fresh = f.attachments.get(f.claim.workerId);
		expect(tokens).not.toContain(fresh);
		expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: null });
		expect(f.views.end).not.toHaveBeenCalled();
		expect(f.views.attach.mock.calls.at(-1)?.[0].attachmentToken).toBe(fresh);
	});
	it.each([
		["unsaved", { saved: false, closed: true }, "CODING_FOLDER_VIEW_UNSAVED"],
		["not confirmed closed", { saved: true, closed: false }, "CODING_FOLDER_VIEW_CLOSE_UNCONFIRMED"],
	])(
		"reports a view of a machine stopped from outside that ended %s once the stop is recorded, and starts it on the next try",
		async (_label, outcome, code) => {
			const f = await folderFixture();
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			f.host.endTurn(f.claim);
			const token = f.attachments.get(f.claim.workerId);
			f.lxd.running = false;
			f.state.stoppedFromOutside = true;
			// Its record goes whether it saved or not.
			const end = f.views.endMachine.getMockImplementation()!;
			f.views.endMachine.mockImplementationOnce(async (machineId, signal) => {
				await end(machineId, signal);
				return [{ workerId: f.claim.workerId, viewId: f.viewId, ...outcome }];
			});
			const nextTurn = () => {
				f.renew(f.claim);
				f.claim.sequence = 2;
				f.sequences.set(f.claim.workerId, 2);
				return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			};
			await expect(nextTurn()).rejects.toThrow(code);
			// The stop is recorded, so SQL ended the attachment, and the machine did not start on that try.
			expect(f.calls("qorpera_record_coding_machine_stopped")).toHaveLength(1);
			expect(f.attachments.has(f.claim.workerId)).toBe(false);
			expect(f.lxd.running).toBe(false);
			await nextTurn();
			expect(f.views.endMachine).toHaveBeenCalledTimes(2);
			expect(f.calls("qorpera_record_coding_machine_stopped")).toHaveLength(2);
			expect(f.lxd.running).toBe(true);
			expect(f.attachments.get(f.claim.workerId)).not.toBe(token);
			expect(f.calls("qorpera_attach_coding_session").at(-1)).toMatchObject({ p_guest_generation: null });
		},
	);
	it("says the machine restarted right before each start, after an outside stop is told, and starts it only once heard", async () => {
		const f = await folderFixture();
		// Whether the machine ran each time the folder service heard it restarted.
		const running: boolean[] = [];
		f.restarted.mockImplementation(async () => {
			running.push(f.lxd.running);
			return false;
		});
		const nextTurn = (sequence: number) => {
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		// Its first start is said too; a turn on the running machine says nothing.
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		await nextTurn(2);
		f.host.endTurn(f.claim);
		expect(f.restarted.mock.calls).toEqual([[f.machine.machineId, expect.any(AbortSignal)]]);
		// Stopped from outside: its views end and its stop is recorded first. Not heard, the machine stays stopped.
		f.lxd.running = false;
		f.state.stoppedFromOutside = true;
		f.restarted.mockRejectedValueOnce(new Error("CODING_FOLDER_CONTROL_UNAVAILABLE"));
		await expect(nextTurn(3)).rejects.toThrow("CODING_FOLDER_CONTROL_UNAVAILABLE");
		expect(f.lxd.running).toBe(false);
		expect(f.restarted).toHaveBeenCalledTimes(2);
		const recorded = () =>
			f.call.mock.calls.flatMap((call, index) =>
				call[0] === "qorpera_record_coding_machine_stopped" ? [f.call.mock.invocationCallOrder[index]!] : [],
			);
		expect(f.views.endMachine.mock.invocationCallOrder[0]).toBeLessThan(recorded()[0]!);
		expect(recorded()[0]).toBeLessThan(f.restarted.mock.invocationCallOrder[1]!);
		// The next try tells the same stop again, and once heard the machine starts.
		await nextTurn(3);
		expect(f.lxd.running).toBe(true);
		expect(f.restarted.mock.calls.map((call) => call[0])).toEqual(Array(3).fill(f.machine.machineId));
		expect(recorded()).toHaveLength(2);
		expect(recorded()[1]).toBeLessThan(f.restarted.mock.invocationCallOrder[2]!);
		expect(running).toEqual([false, false]);
	});
	it("writes down the boot before each start as dropped first, and takes that back only on the answer no (F3 5g-5)", async () => {
		const f = await folderFixture();
		const nextTurn = (sequence: number) => {
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		// Its first start follows no boot: nothing is written down.
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const { plan, journalRoot } = mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions;
		expect(mocked.lastStart.mock.calls).toEqual([[journalRoot, plan]]);
		expect(f.restarted).toHaveBeenCalledTimes(1);
		expect(mocked.dropStart).not.toHaveBeenCalled();
		// Each turn plans the machine's journal again: the same, but for its instance check's closure.
		const journal = { ...plan, assertInstance: expect.any(Function) };
		/** The boot each outside stop ended, by the start it ran under. */
		const boots: string[] = [];
		const stopFromOutside = () => {
			boots.push(f.state.startOperationId);
			f.lxd.running = false;
			f.state.stoppedFromOutside = true;
		};
		// The service answers no: the boot is written down before the call, and taken back after it.
		stopFromOutside();
		await nextTurn(2);
		f.host.endTurn(f.claim);
		expect(mocked.dropStart.mock.calls).toEqual([[journalRoot, journal, boots[0]]]);
		expect(mocked.dropStart.mock.invocationCallOrder[0]).toBeLessThan(f.restarted.mock.invocationCallOrder[1]!);
		expect(mocked.undropStart.mock.calls).toEqual([[journalRoot, journal, boots[0]]]);
		expect(f.restarted.mock.invocationCallOrder[1]).toBeLessThan(mocked.undropStart.mock.invocationCallOrder[0]!);
		// It answers yes: the boot stays written down.
		stopFromOutside();
		f.restarted.mockResolvedValueOnce(true);
		await nextTurn(3);
		f.host.endTurn(f.claim);
		expect(mocked.dropStart.mock.calls.at(-1)).toEqual([journalRoot, journal, boots[1]]);
		expect(mocked.undropStart).toHaveBeenCalledTimes(1);
		// Written down already (a call before was not answered, and its answer may have been yes): a no keeps it too.
		stopFromOutside();
		mocked.dropStart.mockResolvedValueOnce(false);
		await nextTurn(4);
		expect(mocked.dropStart.mock.calls.at(-1)).toEqual([journalRoot, journal, boots[2]]);
		expect(f.restarted).toHaveBeenCalledTimes(4);
		expect(mocked.undropStart).toHaveBeenCalledTimes(1);
		expect(new Set(boots).size).toBe(3);
		// The boot's commands read its mark from the same journal.
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const transport = mocked.folderTransports.at(-1) as {
			dropped: (startOperationId: string, signal: AbortSignal) => Promise<boolean>;
		};
		mocked.startDropped.mockResolvedValueOnce(true);
		expect(await transport.dropped(boots[1]!, f.signal)).toBe(true);
		expect(await transport.dropped(boots[2]!, f.signal)).toBe(false);
		expect(mocked.startDropped.mock.calls).toEqual([
			[journalRoot, journal, boots[1]],
			[journalRoot, journal, boots[2]],
		]);
	});
	/** The order of each control call of `method` (with `intent` for custody), as the fixture's calls were made. */
	const callOrder = (f: Fixture, method: string, intent?: string) =>
		f.call.mock.calls.flatMap((call, index) =>
			call[0] === method && (intent === undefined || call[1].p_intent === intent)
				? [f.call.mock.invocationCallOrder[index]!]
				: [],
		);
	/** What SQL answered each control call of `method`, in order ("lost" for one that failed). */
	const answersOf = async (f: Fixture, method: string) =>
		(await Promise.all(
			f.call.mock.results.flatMap((result, index) =>
				f.call.mock.calls[index]?.[0] === method ? [Promise.resolve(result.value).catch(() => "lost")] : [],
			),
		)) as { state: string; detached: unknown }[];
	/** Each custody SQL granted, as its intent and the order of its call. Before each view opens and each command starts
	 * or is read, the executor asks for rebuild custody to learn whether the machine is marked for a new disk: one SQL
	 * refused, the machine not so marked, is left out. */
	const granted = async (f: Fixture) => {
		const custody = "qorpera_authorize_coding_machine_custody";
		const answers = await answersOf(f, custody),
			asked = f.calls(custody);
		return callOrder(f, custody).flatMap((order, index) =>
			answers[index]?.state === "refused" ? [] : [{ intent: asked[index]?.p_intent, order }],
		);
	};
	/** The intents custody was granted for, in order. */
	const custodyIntents = async (f: Fixture) => (await granted(f)).map((custody) => custody.intent);
	/** Each start boots the machine anew: its boot_id file names a new boot once the folder service hears it restarted. */
	const bootsAnew = (f: Awaited<ReturnType<typeof folderFixture>>) =>
		f.restarted.mockImplementation(async () => {
			f.files.set("/proc/sys/kernel/random/boot_id", {
				uid: 0,
				gid: 0,
				mode: 0o444,
				content: Buffer.from(`${randomUUID()}\n`),
			});
			return false;
		});
	it.each([
		["the node closed the session's view under its mount", "VIEW_CLOSED"],
		["the boundary answered the machine's reads unproven", "READS_UNPROVEN"],
		["the core marked the machine", "MACHINE_RESTART_REQUIRED"],
	])(
		"restarts the machine for the folder when %s, and attaches the session again on the new boot",
		async (_case, code) => {
			const f = await folderFixture();
			bootsAnew(f);
			f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired(code));
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			// SQL marks it first, its views end, it stops under its custody, and before it starts again the folder service
			// hears it restarted and SQL records the restart, which ends the attachment the refused view was under.
			const [mark] = callOrder(f, "qorpera_mark_coding_machine_folder_restart");
			const [stop] = callOrder(f, "qorpera_authorize_coding_machine_custody", "stop");
			const records = callOrder(f, "qorpera_record_coding_machine_folder_restart");
			expect(callOrder(f, "qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
			expect(callOrder(f, "qorpera_authorize_coding_machine_custody", "stop")).toHaveLength(1);
			expect(f.views.endMachine).toHaveBeenCalledTimes(1);
			expect(f.restarted).toHaveBeenCalledTimes(2);
			expect(records).toHaveLength(2);
			expect(f.views.attach.mock.invocationCallOrder[0]).toBeLessThan(mark!);
			expect(mark).toBeLessThan(f.views.endMachine.mock.invocationCallOrder[0]!);
			expect(f.views.endMachine.mock.invocationCallOrder[0]).toBeLessThan(stop!);
			expect(stop).toBeLessThan(f.restarted.mock.invocationCallOrder[1]!);
			expect(f.restarted.mock.invocationCallOrder[1]).toBeLessThan(records[1]!);
			expect(records[1]).toBeLessThan(f.views.attach.mock.invocationCallOrder[1]!);
			const answers = (await Promise.all(
				f.call.mock.results.flatMap((result, index) =>
					f.call.mock.calls[index]?.[0] === "qorpera_record_coding_machine_folder_restart" ? [result.value] : [],
				),
			)) as { state: string; detached: unknown }[];
			const refused = f.views.attach.mock.calls[0]![0],
				attached = f.views.attach.mock.calls[1]![0];
			expect(answers.map((answer) => answer.state)).toEqual(["unmarked", "restarted"]);
			expect(answers[1]?.detached).toEqual([
				{ workerId: f.claim.workerId, attachmentToken: refused.attachmentToken },
			]);
			// Each record names its start by the effect that start follows: the create, then the restart's stop.
			expect(f.state.effects).toHaveLength(4);
			expect(f.calls("qorpera_record_coding_machine_folder_restart").map((args) => args.p_operation_id)).toEqual([
				f.state.effects[0],
				f.state.effects[2],
			]);
			expect(f.calls("qorpera_attach_coding_session")).toHaveLength(2);
			// The session attached anew, its view under the new attachment on the new boot.
			expect(f.lxd.running).toBe(true);
			expect(f.state.folderRestart).toBe(false);
			expect(f.attachments.get(f.claim.workerId)).toBe(attached.attachmentToken);
			expect(attached.attachmentToken).not.toBe(refused.attachmentToken);
			expect(attached.bootId).not.toBe(refused.bootId);
			expect(f.onMount).toHaveBeenCalledTimes(1);
		},
	);
	it("fails the turn when the view is refused again after the restart, and restarts only once", async () => {
		const f = await folderFixture();
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("VIEW_CLOSED"));
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("MACHINE_RESTART_REQUIRED"));
		const failed = f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await expect(failed).rejects.toBeInstanceOf(CodingFolderRestartRequired);
		await expect(failed).rejects.toMatchObject({ code: "MACHINE_RESTART_REQUIRED" });
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
		expect(await custodyIntents(f)).toEqual(["stop"]);
		expect(f.views.attach).toHaveBeenCalledTimes(2);
	});
	it.each([
		["mark", "qorpera_mark_coding_machine_folder_restart", true],
		["record", "qorpera_record_coding_machine_folder_restart", false],
	])("does not go on when SQL's %s of the restart is not confirmed", async (_case, method, running) => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const answer = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (called, args, signal) =>
			called === method
				? { schema: "qorpera.coding-machine-folder-restart/v1", machineId: f.machine.machineId }
				: answer(called, args, signal),
		);
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("READS_UNPROVEN"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_HOST_FOLDER_RESTART_UNCONFIRMED",
		);
		// Not marked, the machine is not stopped; stopped but its restart not recorded, it does not start.
		expect(f.lxd.running).toBe(running);
		expect(await custodyIntents(f)).toHaveLength(running ? 0 : 1);
		expect(f.views.attach).toHaveBeenCalledTimes(2);
	});
	it("records a restart whose answer was lost again under the same start, and goes on with what SQL answered first", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		// SQL records the restart, and its answer is lost.
		const answer = f.call.getMockImplementation()!;
		let lost = false;
		f.call.mockImplementation(async (called, args, signal) => {
			const value = await answer(called, args, signal);
			if (called === "qorpera_record_coding_machine_folder_restart" && !lost && f.state.effects.length > 2) {
				lost = true;
				throw new Error("CODING_HOST_CONTROL_TIMEOUT");
			}
			return value;
		});
		const nextTurn = (sequence: number) => {
			f.renew(f.claim);
			f.claim.sequence = sequence;
			f.sequences.set(f.claim.workerId, sequence);
			return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		};
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("VIEW_CLOSED"));
		await expect(nextTurn(2)).rejects.toThrow("CODING_HOST_CONTROL_TIMEOUT");
		expect(f.lxd.running).toBe(false);
		const refused = f.views.attach.mock.calls[1]![0];
		// The next turn records the same start again: SQL answers what it did, the machine starts, and the session
		// attaches anew.
		await nextTurn(3);
		const records = f.calls("qorpera_record_coding_machine_folder_restart");
		expect(records.map((args) => args.p_operation_id)).toEqual([
			f.state.effects[0],
			f.state.effects[2],
			f.state.effects[2],
		]);
		const answers = (await Promise.all(
			f.call.mock.results.flatMap((result, index) =>
				f.call.mock.calls[index]?.[0] === "qorpera_record_coding_machine_folder_restart"
					? [Promise.resolve(result.value).catch(() => "lost")]
					: [],
			),
		)) as unknown[];
		expect(answers.slice(1)).toEqual([
			"lost",
			{
				schema: "qorpera.coding-machine-folder-restart/v1",
				machineId: f.machine.machineId,
				state: "restarted",
				detached: [{ workerId: f.claim.workerId, attachmentToken: refused.attachmentToken }],
			},
		]);
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
		expect(f.lxd.running).toBe(true);
		expect(f.state.effects).toHaveLength(4);
		const attached = f.views.attach.mock.calls.at(-1)![0];
		expect(attached.attachmentToken).not.toBe(refused.attachmentToken);
		expect(f.attachments.get(f.claim.workerId)).toBe(attached.attachmentToken);
	});
	it("restarts the machine when the boundary before a publication answers its reads unproven, and publishes nothing", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.attachments.has(f.claim.workerId)).toBe(true);
		f.boundary.mockResolvedValueOnce({ machine: f.machine.machineId, reads: "unproven", views: [] });
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow(
			new Error("CODING_FOLDER_BOUNDARY_HELD:READS_UNPROVEN"),
		);
		const [mark] = callOrder(f, "qorpera_mark_coding_machine_folder_restart");
		const [stop] = callOrder(f, "qorpera_authorize_coding_machine_custody", "stop");
		const records = callOrder(f, "qorpera_record_coding_machine_folder_restart");
		expect(f.boundary.mock.invocationCallOrder[0]).toBeLessThan(mark!);
		expect(mark).toBeLessThan(f.views.endMachine.mock.invocationCallOrder[0]!);
		expect(f.views.endMachine.mock.invocationCallOrder[0]).toBeLessThan(stop!);
		expect(stop).toBeLessThan(f.restarted.mock.invocationCallOrder[1]!);
		expect(f.restarted.mock.invocationCallOrder[1]).toBeLessThan(records[1]!);
		// It runs again, the session no longer attached to it: its next turn attaches anew.
		expect(f.lxd.running).toBe(true);
		expect(f.state.folderRestart).toBe(false);
		expect(f.attachments.has(f.claim.workerId)).toBe(false);
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("does not restart the machine again for a turn when another turn restarted it since that turn's start", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// The second session's view is refused while the first one's publication finds the machine's reads unproven: the
		// publication's restart waits for the attach, and the second session's restart then finds it done.
		let heard!: () => void;
		const asked = new Promise<void>((resolve) => {
			heard = resolve;
		});
		f.boundary.mockImplementationOnce(async (machine) => {
			heard();
			return { machine, reads: "unproven", views: [] };
		});
		let published: Promise<unknown> | undefined;
		f.views.attach.mockImplementationOnce(async () => {
			published = f.host.publish(f.claim, f.submission, f.signal);
			// Its outcome is read once the second session attached.
			published.catch(() => undefined);
			await asked;
			await new Promise((resolve) => setImmediate(resolve));
			throw new CodingFolderRestartRequired("VIEW_CLOSED");
		});
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		await expect(published).rejects.toThrow(new Error("CODING_FOLDER_BOUNDARY_HELD:READS_UNPROVEN"));
		// One restart, the publication's: the second session attached after it, on the machine it left running.
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
		expect(await custodyIntents(f)).toEqual(["stop"]);
		expect(f.restarted).toHaveBeenCalledTimes(2);
		expect(f.restarted.mock.invocationCallOrder[1]).toBeLessThan(f.views.attach.mock.invocationCallOrder.at(-1)!);
		expect(f.lxd.running).toBe(true);
		expect([...f.attachments.keys()]).toEqual([second.workerId]);
		expect(f.views.attach.mock.calls.at(-1)?.[0].attachmentToken).toBe(f.attachments.get(second.workerId));
	});
	/** The session's turn `sequence`, under a renewed lease. */
	const turnAt = (f: Awaited<ReturnType<typeof folderFixture>>, sequence: number) => {
		f.renew(f.claim);
		f.claim.sequence = sequence;
		f.sequences.set(f.claim.workerId, sequence);
		return f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
	};
	it("gives the machine a new disk from its image when its view is refused for a read no longer readable, and attaches the session again (F3 5g-5)", async () => {
		const f = await folderFixture();
		bootsAnew(f);
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("READS_UNREADABLE"));
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// SQL marks it for a new disk, which marks it to restart too, its views end, and it stops under its custody. Before
		// it starts again, the folder service hears it restarted and SQL records the restart, which ends the refused view's
		// attachment and keeps both marks: it is rebuilt from its image, still on the node, under custody's rebuild. Before
		// the start after the rebuild, the folder service hears it restarted again and SQL records the new disk, which
		// clears both marks. Before each attach, SQL refuses the rebuild custody asked for: the machine is not marked then.
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toEqual([]);
		expect(await custodyIntents(f)).toEqual(["stop", "rebuild"]);
		// Rebuild custody three times: the rebuild's, between the two asked before each attach.
		const rebuilds = callOrder(f, "qorpera_authorize_coding_machine_custody", "rebuild");
		const marks = callOrder(f, "qorpera_mark_coding_machine_new_disk");
		const records = callOrder(f, "qorpera_record_coding_machine_folder_restart");
		const replaced = callOrder(f, "qorpera_record_coding_machine_new_disk");
		expect(rebuilds).toHaveLength(3);
		expect(marks).toHaveLength(1);
		expect(records).toHaveLength(2);
		expect(replaced).toHaveLength(1);
		expect(f.views.endMachine).toHaveBeenCalledTimes(1);
		expect(f.restarted).toHaveBeenCalledTimes(3);
		const order = [
			rebuilds[0],
			f.views.attach.mock.invocationCallOrder[0],
			marks[0],
			f.views.endMachine.mock.invocationCallOrder[0],
			callOrder(f, "qorpera_authorize_coding_machine_custody", "stop")[0],
			f.restarted.mock.invocationCallOrder[1],
			records[1],
			vi.mocked(f.client.hasImage).mock.invocationCallOrder[0],
			rebuilds[1],
			f.restarted.mock.invocationCallOrder[2],
			replaced[0],
			rebuilds[2],
			f.views.attach.mock.invocationCallOrder[1],
		];
		expect(order).not.toContain(undefined);
		expect(order).toEqual([...order].sort((a, b) => (a as number) - (b as number)));
		expect(f.client.hasImage).toHaveBeenCalledWith(
			f.machine.project,
			f.machine.imageFingerprint,
			expect.any(AbortSignal),
		);
		const refused = f.views.attach.mock.calls[0]![0],
			attached = f.views.attach.mock.calls[1]![0];
		const restarts = await answersOf(f, "qorpera_record_coding_machine_folder_restart"),
			disks = await answersOf(f, "qorpera_record_coding_machine_new_disk");
		expect([...restarts, ...disks].map((answer) => answer.state)).toEqual(["unmarked", "new-disk", "replaced"]);
		// The restart's record ended the refused view's attachment; the new disk's found none left.
		expect(restarts[1]?.detached).toEqual([{ workerId: f.claim.workerId, attachmentToken: refused.attachmentToken }]);
		expect(disks[0]?.detached).toEqual([]);
		// Each record names its start by the effect that start follows: the create, the restart's stop, then the rebuild.
		expect(f.state.effects.map((operationId) => f.state.kinds.get(operationId))).toEqual([
			"create",
			"start",
			"stop",
			"rebuild",
			"start",
		]);
		expect(f.calls("qorpera_record_coding_machine_folder_restart").map((args) => args.p_operation_id)).toEqual([
			f.state.effects[0],
			f.state.effects[2],
		]);
		expect(f.calls("qorpera_record_coding_machine_new_disk").map((args) => args.p_operation_id)).toEqual([
			f.state.effects[3],
		]);
		// The error an image gone from the node would have left is cleared.
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({ p_machine_id: f.machine.machineId, p_stage: "wake", p_code: null }),
		]);
		// The session attached anew, its view under the new attachment on the new boot.
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(false);
		expect(f.state.folderRestart).toBe(false);
		expect(f.attachments.get(f.claim.workerId)).toBe(attached.attachmentToken);
		expect(attached.attachmentToken).not.toBe(refused.attachmentToken);
		expect(attached.bootId).not.toBe(refused.bootId);
		expect(f.onMount).toHaveBeenCalledTimes(1);
	});
	it("gives a machine SQL marked at a turn's take-in its new disk before that turn's view opens, though the session's view of a turn before still answers mounted (F3 5g-5)", async () => {
		const f = await folderFixture();
		const real = await realViews();
		bootsAnew(f);
		const host = f.executor(real);
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		host.endTurn(f.claim);
		const token = f.attachments.get(f.claim.workerId)!;
		// The next turn's take-in, at its first run, finds a read on the machine that turn can no longer place, and marks
		// the machine for a new disk (20260930505000). The session's view, held since the turn before, still answers
		// mounted: it hears of the mark only at its next renewal.
		const answer = f.call.getMockImplementation()!;
		let takenIn = false;
		f.call.mockImplementation(async (called, args, signal) => {
			if (called === "qorpera_authorize_coding_machine_run" && !takenIn) {
				takenIn = true;
				f.state.newDisk = true;
				f.state.folderRestart = true;
			}
			return answer(called, args, signal);
		});
		f.renew(f.claim);
		f.claim.sequence = 2;
		f.sequences.set(f.claim.workerId, 2);
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// SQL grants rebuild custody, so the machine is marked: the held view is not mounted again. The machine is marked
		// for its new disk all the same, its views end (the held one's final boundary and close), it stops, is rebuilt and
		// starts on its new disk, and the session attaches anew, its new view mounted under the new attachment.
		expect(await custodyIntents(f)).toEqual(["rebuild", "stop", "rebuild"]);
		const [asked, stop, rebuild] = (await granted(f)).map((custody) => custody.order);
		const [mark] = callOrder(f, "qorpera_mark_coding_machine_new_disk");
		const [replaced] = callOrder(f, "qorpera_record_coding_machine_new_disk");
		const order = [asked, mark, stop, rebuild, replaced, mocked.guestMount.mock.invocationCallOrder.at(-1)];
		expect(order).not.toContain(undefined);
		expect(order).toEqual([...order].sort((a, b) => (a as number) - (b as number)));
		expect(mocked.guestMount).toHaveBeenCalledTimes(2);
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toEqual([]);
		expect(
			[
				...(await answersOf(f, "qorpera_record_coding_machine_folder_restart")),
				...(await answersOf(f, "qorpera_record_coding_machine_new_disk")),
			].map((answer) => answer.state),
		).toEqual(["unmarked", "new-disk", "replaced"]);
		expect(f.state.effects.map((operationId) => f.state.kinds.get(operationId))).toEqual([
			"create",
			"start",
			"stop",
			"rebuild",
			"start",
		]);
		expect(real.closes).toEqual([{ p_view_id: real.viewId, p_pass: real.pass }]);
		const renewed = f.attachments.get(f.claim.workerId);
		expect(renewed).not.toBe(token);
		expect(real.opens).toHaveLength(2);
		expect(real.opens[1]).toMatchObject({ p_anchor: { workerId: f.claim.workerId, attachmentToken: renewed } });
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(false);
		expect(f.state.folderRestart).toBe(false);
	});
	it.each<[string, Record<string, unknown>]>([
		["another schema", { schema: "qorpera.coding-machine-new-disk/v1" }],
		["another machine", { machineId: randomUUID() }],
		["another state", { state: "new-disk" }],
		["no sessions it detached", { detached: undefined }],
	])(
		"does not start a rebuilt machine while SQL's record of its new disk is not confirmed: %s (F3 5g-5)",
		async (_case, differs) => {
			const f = await folderFixture();
			bootsAnew(f);
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			f.host.endTurn(f.claim);
			// SQL records the new disk, and its first answer is not one.
			const answer = f.call.getMockImplementation()!;
			let answered = false;
			f.call.mockImplementation(async (called, args, signal) => {
				const value = await answer(called, args, signal);
				if (called !== "qorpera_record_coding_machine_new_disk" || answered) return value;
				answered = true;
				return { ...(value as Record<string, unknown>), ...differs };
			});
			f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("READS_UNREADABLE"));
			await expect(turnAt(f, 2)).rejects.toThrow("CODING_HOST_NEW_DISK_UNCONFIRMED");
			// Rebuilt, it does not start, and no view opens on it.
			expect(f.state.effects.map((operationId) => f.state.kinds.get(operationId))).toEqual([
				"create",
				"start",
				"stop",
				"rebuild",
			]);
			expect(f.lxd.running).toBe(false);
			expect(f.views.attach).toHaveBeenCalledTimes(2);
			// The next turn records the same rebuild again: SQL answers what it did, and the machine starts on its new disk.
			await turnAt(f, 3);
			expect(f.calls("qorpera_record_coding_machine_new_disk").map((args) => args.p_operation_id)).toEqual([
				f.state.effects[3],
				f.state.effects[3],
			]);
			expect(f.state.effects).toHaveLength(5);
			expect(f.state.kinds.get(f.state.effects[4]!)).toBe("start");
			expect(f.lxd.running).toBe(true);
			expect(f.state.newDisk).toBe(false);
			expect(f.attachments.get(f.claim.workerId)).toBe(f.views.attach.mock.calls.at(-1)![0].attachmentToken);
		},
	);
	it("leaves the machine stopped and marked, with its own error, while its image is gone from the node, and rebuilds it once the image is back (F3 5g-5)", async () => {
		const f = await folderFixture();
		bootsAnew(f);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.imageGone = true;
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("READS_UNREADABLE"));
		await expect(turnAt(f, 2)).rejects.toThrow("CODING_MACHINE_IMAGE_GONE");
		// No rebuild was asked for: the machine stays stopped, both marks on it, with the error recorded for it.
		expect(await custodyIntents(f)).toEqual(["stop"]);
		expect(f.lxd.running).toBe(false);
		expect(f.state.newDisk).toBe(true);
		expect(f.state.folderRestart).toBe(true);
		const errors = () => f.calls("qorpera_record_coding_machine_error").map((args) => [args.p_stage, args.p_code]);
		expect(f.calls("qorpera_record_coding_machine_error")).toEqual([
			expect.objectContaining({
				p_machine_id: f.machine.machineId,
				p_stage: "wake",
				p_code: "CODING_MACHINE_IMAGE_GONE",
			}),
		]);
		// Its next turn fails so too, before any rebuild: the restart's record answers what it did.
		await expect(turnAt(f, 3)).rejects.toThrow("CODING_MACHINE_IMAGE_GONE");
		expect(await custodyIntents(f)).toEqual(["stop"]);
		expect(f.lxd.running).toBe(false);
		expect(errors()).toEqual([
			["wake", "CODING_MACHINE_IMAGE_GONE"],
			["wake", "CODING_MACHINE_IMAGE_GONE"],
		]);
		// The image back, the next turn rebuilds the machine, the error is cleared, and the session attaches.
		f.state.imageGone = false;
		await turnAt(f, 4);
		expect(await custodyIntents(f)).toEqual(["stop", "rebuild"]);
		expect(f.client.hasImage).toHaveBeenCalledTimes(3);
		expect(f.calls("qorpera_record_coding_machine_folder_restart").map((args) => args.p_operation_id)).toEqual([
			f.state.effects[0],
			f.state.effects[2],
			f.state.effects[2],
			f.state.effects[2],
		]);
		expect(f.calls("qorpera_record_coding_machine_new_disk").map((args) => args.p_operation_id)).toEqual([
			f.state.effects[3],
		]);
		expect(errors()).toEqual([
			["wake", "CODING_MACHINE_IMAGE_GONE"],
			["wake", "CODING_MACHINE_IMAGE_GONE"],
			["wake", null],
		]);
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(false);
		expect(f.attachments.get(f.claim.workerId)).toBe(f.views.attach.mock.calls.at(-1)![0].attachmentToken);
	});
	it("gives the machine a new disk when the boundary before a publication says it holds a read no longer readable, and publishes nothing (F3 5g-5)", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.boundary.mockResolvedValueOnce({ machine: f.machine.machineId, reads: "unreadable", views: [] });
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow(
			new Error("CODING_FOLDER_BOUNDARY_HELD:READS_UNREADABLE"),
		);
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toEqual([]);
		expect(f.calls("qorpera_mark_coding_machine_new_disk")).toHaveLength(1);
		expect(await custodyIntents(f)).toEqual(["stop", "rebuild"]);
		expect(
			[
				...(await answersOf(f, "qorpera_record_coding_machine_folder_restart")),
				...(await answersOf(f, "qorpera_record_coding_machine_new_disk")),
			].map((answer) => answer.state),
		).toEqual(["unmarked", "new-disk", "replaced"]);
		// It runs again on its new disk, the session no longer attached to it: its next turn attaches anew.
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(false);
		expect(f.state.folderRestart).toBe(false);
		expect(f.attachments.has(f.claim.workerId)).toBe(false);
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("marks the machine for a new disk all the same when another turn restarted it since the publication's boundary was asked (F3 5g-5)", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// While the publication's boundary is asked, the second session's view is refused and it restarts the machine; the
		// boundary then says a view's change set was refused whole for a read no longer readable.
		f.boundary.mockImplementationOnce(async (machine) => {
			f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("VIEW_CLOSED"));
			await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
			return { machine, reads: "released", views: [{ viewId: f.viewId, unsaved: 0, refused: "unreadable" }] };
		});
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow(
			new Error("CODING_FOLDER_BOUNDARY_HELD:REFUSED_UNREADABLE"),
		);
		// One restart, the second session's, which gave the machine no new disk: the publication marks it for one, after
		// that restart's record, so its next start is a rebuild.
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
		expect(await custodyIntents(f)).toEqual(["stop"]);
		const [mark] = callOrder(f, "qorpera_mark_coding_machine_new_disk");
		expect(callOrder(f, "qorpera_mark_coding_machine_new_disk")).toHaveLength(1);
		expect(callOrder(f, "qorpera_record_coding_machine_folder_restart")[1]).toBeLessThan(mark!);
		expect(f.state.newDisk).toBe(true);
		expect(f.state.folderRestart).toBe(true);
		expect(f.lxd.running).toBe(true);
		expect([...f.attachments.keys()]).toEqual([second.workerId]);
		expect(f.repositories.export).not.toHaveBeenCalled();
	});
	it("marks the machine for a new disk once when a command's boundary says it holds a read no longer readable (F3 5g-5)", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const transport = mocked.folderTransports.at(-1) as { control: Pick<CodingFolderControl, "boundary"> };
		// A released boundary marks nothing.
		await transport.control.boundary(f.machine.machineId, [], f.signal);
		expect(f.calls("qorpera_mark_coding_machine_new_disk")).toEqual([]);
		// The first mark is not confirmed.
		const answer = f.call.getMockImplementation()!;
		let lost = false;
		f.call.mockImplementation(async (called, args, signal) => {
			if (called === "qorpera_mark_coding_machine_new_disk" && !lost) {
				lost = true;
				throw new Error("CODING_HOST_CONTROL_TIMEOUT");
			}
			return answer(called, args, signal);
		});
		const unreadable = { machine: f.machine.machineId, reads: "unreadable" as const, views: [] };
		f.boundary.mockResolvedValue(unreadable);
		// Each boundary's answer goes to the command as it was. The mark lost with the first is made by the second, and
		// the third makes none.
		for (let each = 0; each < 3; each++)
			expect(await transport.control.boundary(f.machine.machineId, [], f.signal)).toEqual(unreadable);
		expect(f.calls("qorpera_mark_coding_machine_new_disk")).toHaveLength(2);
		expect(f.state.newDisk).toBe(true);
		// Marked, it is not stopped here: no command of the turn starts or is read on it now, and its next turn gives it
		// its new disk before that turn's view opens.
		expect(f.lxd.running).toBe(true);
		expect(await custodyIntents(f)).toEqual([]);
	});
	it("starts and reads no command on a machine SQL marked for a new disk during the turn, and still cancels one (F3 5g-5)", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const authorize = vi.fn(async (_action: string) => undefined);
		await f.host.commandTransport(f.scope(), authorize, f.signal);
		const transport = mocked.folderTransports.at(-1) as { authorize: (...args: unknown[]) => Promise<void> };
		const step = (action: string) => transport.authorize(action, f.scope(), randomUUID(), "a".repeat(64), f.signal);
		await step("start");
		// The turn's take-in at its next run finds a read on the machine it can no longer place, and marks the machine for
		// a new disk (20260930505000): its disk may hold what it read, so no command starts on it or is read from it now.
		const answer = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (called, args, signal) => {
			if (called === "qorpera_authorize_coding_machine_run") {
				f.state.newDisk = true;
				f.state.folderRestart = true;
			}
			return answer(called, args, signal);
		});
		for (const action of ["start", "read"])
			await expect(step(action)).rejects.toThrow("CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK");
		await step("cancel");
		expect(authorize.mock.calls.map(([action]) => action)).toEqual(["start", "cancel"]);
		// Asking changed nothing: the machine still runs, marked, and the turn's next view gets it a new disk first.
		expect(await custodyIntents(f)).toEqual(["rebuild", "rebuild"]);
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(true);
	});
	it("keeps and shows none of what a command printed on a machine its cancel's last authorization marked for a new disk, and still cancels it, through the folder model's own command transport (F3 5g-5)", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const options = mocked.folderTransports.at(-1) as unknown as LxdCodingFolderCommandTransportOptions;
		const { LxdCodingFolderCommandTransport } = await vi.importActual<
			typeof import("../src/coding-folder-command-transport.ts")
		>("../src/coding-folder-command-transport.ts");
		await mkdir(options.custody, { recursive: true, mode: 0o700 });
		await chmod(options.custody, 0o700);
		// The guest agent's one command, answering as the real agent does.
		const { workerId } = f.scope();
		const command = { state: "running" as CodingGuestCommandState, printed: Buffer.from("before\n") };
		const stateOf = (commandId: string) => ({
			commandId,
			state: command.state,
			exit: null,
			end: command.printed.length,
		});
		const guest = {
			run: vi.fn<LxdCodingGuestClient["run"]>(async (request) => ({
				schema: "qorpera.coding-guest-command/v1",
				workerId,
				...stateOf(parseCodingGuestRequest("run", request).commandId),
			})),
			output: vi.fn<LxdCodingGuestClient["output"]>(async (request) => {
				const asked = parseCodingGuestRequest("output", request);
				const bytes = Buffer.from(command.printed.subarray(asked.offset, asked.offset + asked.maxBytes));
				const answer = parseCodingGuestAnswer("output", asked, {
					schema: "qorpera.coding-guest-output/v1",
					workerId,
					...stateOf(asked.commandId),
					offset: asked.offset,
					bytes: bytes.length,
					gap: 0,
				});
				return { answer, bytes };
			}),
			cancel: vi.fn<LxdCodingGuestClient["cancel"]>(async (request) => {
				command.state = "cancelled";
				return {
					schema: "qorpera.coding-guest-command/v1",
					workerId,
					...stateOf(parseCodingGuestRequest("cancel", request).commandId),
				};
			}),
		};
		const transport = new LxdCodingFolderCommandTransport({ ...options, guest });
		const input = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "make", timeoutMs: null };
		expect(await transport.start(f.scope(), input, f.signal)).toMatchObject({ state: "running", output: "before\n" });
		// The command prints more, and the turn cancels it. The take-in at the cancel's last authorization (its run) marks
		// the machine for a new disk without placing the read on it that the turn can no longer read (20260930505000),
		// after what the command printed was kept and while the guest still stops it; the machine's boundary still
		// releases every read it was served.
		const answer = f.call.getMockImplementation()!;
		let runs = 0;
		f.call.mockImplementation(async (called, args, signal) => {
			if (called === "qorpera_authorize_coding_machine_run" && ++runs === 2) {
				f.state.newDisk = true;
				f.state.folderRestart = true;
			}
			return answer(called, args, signal);
		});
		command.printed = Buffer.concat([command.printed, Buffer.from("old disk\n")]);
		guest.cancel.mockImplementationOnce(async (request) => ({
			schema: "qorpera.coding-guest-command/v1",
			workerId,
			...stateOf(parseCodingGuestRequest("cancel", request).commandId),
		}));
		const answered = (output: string) => ({
			schema: "qorpera.coding-command-result/v2",
			workerId,
			commandId: input.commandId,
			inputSha256: input.inputSha256,
			state: "running",
			exitCode: null,
			output,
			truncated: false,
			log: {
				offset: 0,
				nextOffset: Buffer.byteLength(output),
				totalBytes: Buffer.byteLength(output),
				limitBytes: options.limitBytes,
				limitReached: false,
			},
		});
		expect(await transport.cancel(f.scope(), input.commandId, f.signal)).toStrictEqual(
			answered("before\nold disk\n"),
		);
		expect(runs).toBe(2);
		// The command service asks what is shown after that authorization: not what the command printed, nor how much,
		// nor how it ended.
		await expect(transport.hidden(input.commandId, f.signal)).resolves.toBe("unconfirmed");
		// It prints more on the disk it is to lose, and the guest stops it: the next cancel still goes, and keeps nothing
		// more of it, nor how it ended.
		command.printed = Buffer.concat([command.printed, Buffer.from("after\n")]);
		expect(await transport.cancel(f.scope(), input.commandId, f.signal)).toStrictEqual(
			answered("before\nold disk\n"),
		);
		await expect(transport.hidden(input.commandId, f.signal)).resolves.toBe("unconfirmed");
		expect(guest.cancel).toHaveBeenCalledTimes(2);
		const kept = join(options.custody, "host-commands", input.commandId.replaceAll("-", ""));
		expect(await readFile(join(kept, "output.log"), "utf8")).toBe("before\nold disk\n");
		await expect(readFile(join(kept, "outcome.json"))).rejects.toMatchObject({ code: "ENOENT" });
		// Nor is the command read, until the machine has its new disk.
		await expect(transport.read(f.scope(), { commandId: input.commandId }, f.signal)).rejects.toThrow(
			"CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK",
		);
		expect(await readFile(join(kept, "output.log"), "utf8")).toBe("before\nold disk\n");
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(true);
	});
	it("has none of what a command printed on the disk a rebuild replaced shown, read or cancelled in a later turn, though it ended, through the folder model's own command transport (F3 5g-5)", async () => {
		const f = await folderFixture();
		// The machine's journal names the start it last ran under.
		mocked.startOperation.mockImplementation(async () => f.state.startOperationId);
		bootsAnew(f);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const options = mocked.folderTransports.at(-1) as unknown as LxdCodingFolderCommandTransportOptions;
		const { LxdCodingFolderCommandTransport } = await vi.importActual<
			typeof import("../src/coding-folder-command-transport.ts")
		>("../src/coding-folder-command-transport.ts");
		await mkdir(options.custody, { recursive: true, mode: 0o700 });
		await chmod(options.custody, 0o700);
		// The guest agent's commands on the machine's disk, answering as the real agent does.
		const { workerId } = f.scope();
		const commands = new Map<
			string,
			{
				state: CodingGuestCommandState;
				exit: { code: number | null; signal: string | null } | null;
				printed: Buffer;
			}
		>();
		const stateOf = (commandId: string) => {
			const found = commands.get(commandId);
			if (!found) throw new Error("FAKE_GUEST_COMMAND_UNKNOWN");
			return { commandId, state: found.state, exit: found.exit, end: found.printed.length };
		};
		const guest = {
			run: vi.fn<LxdCodingGuestClient["run"]>(async (request) => ({
				schema: "qorpera.coding-guest-command/v1",
				workerId,
				...stateOf(parseCodingGuestRequest("run", request).commandId),
			})),
			output: vi.fn<LxdCodingGuestClient["output"]>(async (request) => {
				const asked = parseCodingGuestRequest("output", request);
				const at = stateOf(asked.commandId);
				const bytes = Buffer.from(
					commands.get(asked.commandId)!.printed.subarray(asked.offset, asked.offset + asked.maxBytes),
				);
				const answer = parseCodingGuestAnswer("output", asked, {
					schema: "qorpera.coding-guest-output/v1",
					workerId,
					...at,
					offset: asked.offset,
					bytes: bytes.length,
					gap: 0,
				});
				return { answer, bytes };
			}),
			cancel: vi.fn<LxdCodingGuestClient["cancel"]>(async (request) => ({
				schema: "qorpera.coding-guest-command/v1",
				workerId,
				...stateOf(parseCodingGuestRequest("cancel", request).commandId),
			})),
		};
		const first = new LxdCodingFolderCommandTransport({ ...options, guest });
		const done = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "cat notes", timeoutMs: null };
		const running = { commandId: randomUUID(), inputSha256: "b".repeat(64), command: "make", timeoutMs: null };
		commands.set(done.commandId, {
			state: "exited",
			exit: { code: 0, signal: null },
			printed: Buffer.from("secret\n"),
		});
		commands.set(running.commandId, { state: "running", exit: null, printed: Buffer.from("before\n") });
		expect(await first.start(f.scope(), done, f.signal)).toMatchObject({ state: "succeeded", output: "secret\n" });
		expect(await first.start(f.scope(), running, f.signal)).toMatchObject({ state: "running", output: "before\n" });
		f.host.endTurn(f.claim);
		// The session's next view is refused for a read no longer readable: the machine is rebuilt, its commands going with
		// its old disk, and starts on its new disk, which is written down next to its journal before SQL records it and
		// clears the marks that withheld the old disk's commands until then.
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("READS_UNREADABLE"));
		await turnAt(f, 2);
		commands.clear();
		const outputs = guest.output.mock.calls.length;
		expect(f.state.kinds.get(f.state.effects[3]!)).toBe("rebuild");
		const { plan, journalRoot } = mocked.reconcile.mock.calls[0]?.[0] as CodingMachineReconcileOptions;
		expect(mocked.recordDisk.mock.calls).toEqual([
			[
				journalRoot,
				expect.objectContaining({ machineId: plan.machineId, journalName: plan.journalName }),
				f.state.effects[3],
			],
		]);
		const [replaced] = callOrder(f, "qorpera_record_coding_machine_new_disk");
		expect(mocked.recordDisk.mock.invocationCallOrder[0]).toBeLessThan(replaced!);
		expect(f.state.newDisk).toBe(false);
		expect(f.state.folderRestart).toBe(false);
		// The later turn reads and cancels both commands of the old disk: SQL lets it, every read is released and nothing
		// withholds, but nothing the custody kept of them is shown, and the guest is not asked.
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const later = mocked.folderTransports.at(-1) as unknown as LxdCodingFolderCommandTransportOptions;
		expect(later.custody).toBe(options.custody);
		const second = new LxdCodingFolderCommandTransport({ ...later, guest });
		// Each call answers what the custody kept, and the command service then shows neither what each printed, nor how
		// much, nor how it ended: both ended with the old disk.
		for (const [input, state, exitCode, output] of [
			[done, "succeeded", 0, "secret\n"],
			[running, "machine_stopped", null, "before\n"],
		] as const) {
			const answered = {
				schema: "qorpera.coding-command-result/v2",
				workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state,
				exitCode,
				output,
				truncated: false,
				log: {
					offset: 0,
					nextOffset: output.length,
					totalBytes: output.length,
					limitBytes: later.limitBytes,
					limitReached: false,
				},
			};
			expect(await second.read(f.scope(), { commandId: input.commandId }, f.signal)).toStrictEqual(answered);
			expect(await second.cancel(f.scope(), input.commandId, f.signal)).toStrictEqual(answered);
			await expect(second.hidden(input.commandId, f.signal)).resolves.toBe("machine_stopped");
		}
		expect(guest.output).toHaveBeenCalledTimes(outputs);
		expect(guest.cancel).not.toHaveBeenCalled();
		const kept = (commandId: string) => join(options.custody, "host-commands", commandId.replaceAll("-", ""));
		expect(await readFile(join(kept(done.commandId), "output.log"), "utf8")).toBe("secret\n");
		// A command on the new disk is shown.
		const fresh = { commandId: randomUUID(), inputSha256: "c".repeat(64), command: "echo new", timeoutMs: null };
		commands.set(fresh.commandId, {
			state: "exited",
			exit: { code: 0, signal: null },
			printed: Buffer.from("new\n"),
		});
		expect(await second.start(f.scope(), fresh, f.signal)).toMatchObject({ state: "succeeded", output: "new\n" });
		expect(await second.read(f.scope(), { commandId: fresh.commandId }, f.signal)).toMatchObject({ output: "new\n" });
		expect(JSON.parse(await readFile(join(kept(fresh.commandId), "request.json"), "utf8"))).toMatchObject({
			turn: 2,
			machineId: options.machine.machineId,
			startOperationId: f.state.startOperationId,
			diskOperationId: f.state.effects[3],
		});
	});
	it("gives the machine its new disk in the same turn when a view is refused for a read no longer readable after another turn started it since (F3 5g-5)", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// The second session's view is refused for a read no longer readable while the first one's publication restarts
		// the machine for its reads unproven: the second session's restart then finds it started since.
		let heard!: () => void;
		const asked = new Promise<void>((resolve) => {
			heard = resolve;
		});
		f.boundary.mockImplementationOnce(async (machine) => {
			heard();
			return { machine, reads: "unproven", views: [] };
		});
		let published: Promise<unknown> | undefined;
		f.views.attach.mockImplementationOnce(async () => {
			published = f.host.publish(f.claim, f.submission, f.signal);
			published.catch(() => undefined);
			await asked;
			await new Promise((resolve) => setImmediate(resolve));
			throw new CodingFolderRestartRequired("READS_UNREADABLE");
		});
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		await expect(published).rejects.toThrow(new Error("CODING_FOLDER_BOUNDARY_HELD:READS_UNPROVEN"));
		// That start gave it no new disk: it is marked for one, stops all the same and is rebuilt, and the second session
		// attaches on its new disk.
		expect(f.calls("qorpera_mark_coding_machine_folder_restart")).toHaveLength(1);
		expect(f.calls("qorpera_mark_coding_machine_new_disk")).toHaveLength(1);
		expect(await custodyIntents(f)).toEqual(["stop", "stop", "rebuild"]);
		expect(f.state.effects.map((operationId) => f.state.kinds.get(operationId))).toEqual([
			"create",
			"start",
			"stop",
			"start",
			"stop",
			"rebuild",
			"start",
		]);
		expect(f.lxd.running).toBe(true);
		expect(f.state.newDisk).toBe(false);
		expect([...f.attachments.keys()]).toEqual([second.workerId]);
		expect(f.views.attach.mock.calls.at(-1)?.[0].attachmentToken).toBe(f.attachments.get(second.workerId));
	});
	it("runs a session's commands under the start the machine runs now, after another session restarted it (F3 5g-5)", async () => {
		const f = await folderFixture();
		// The machine's journal names the start it last ran under.
		mocked.startOperation.mockImplementation(async () => f.state.startOperationId);
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const first = f.state.startOperationId;
		type Transport = { currentStart: () => string | undefined };
		await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const transport = mocked.folderTransports.at(-1) as Transport;
		expect(transport.currentStart()).toBe(first);
		// The second session's view is refused, so the machine restarts while the first session's turn goes on: from
		// right before it starts again, no command starts or is read under the boot before's start.
		let during: string | undefined | null = null;
		f.restarted.mockImplementationOnce(async () => {
			f.files.set("/proc/sys/kernel/random/boot_id", {
				uid: 0,
				gid: 0,
				mode: 0o444,
				content: Buffer.from(`${randomUUID()}\n`),
			});
			during = transport.currentStart();
			return false;
		});
		f.views.attach.mockRejectedValueOnce(new CodingFolderRestartRequired("VIEW_CLOSED"));
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		expect(during).toBeUndefined();
		expect(f.state.startOperationId).not.toBe(first);
		// The first session's transport was made under the start before: its commands now run under the new one, as every
		// session's do, so a command of the boot before is judged by its own start's mark.
		expect(transport.currentStart()).toBe(f.state.startOperationId);
		await f.host.commandTransport(
			f.scope(second),
			vi.fn(async () => undefined),
			f.signal,
		);
		expect((mocked.folderTransports.at(-1) as Transport).currentStart()).toBe(f.state.startOperationId);
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
		// No broker: nothing to check the push against.
		expect(mocked.push.mock.calls[0]?.[2]).not.toHaveProperty("secrets");
	});
	it("asks the boundary again while a path waits for a save check still running (5j-5), and publishes once it saved", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		// Another view's large pack is still being checked: the service answered in time, and goes on checking.
		f.boundary.mockResolvedValueOnce({
			machine: f.machine.machineId,
			reads: "released" as const,
			views: [
				{ viewId: randomUUID(), unsaved: 0 },
				{ viewId: randomUUID(), unsaved: 1, unsavedOutcome: "waiting", checking: 1 },
			],
		});
		expect(await f.host.publish(f.claim, f.submission, f.signal)).toEqual({
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(f.boundary.mock.calls).toEqual([
			[f.machine.machineId, [], f.signal],
			[f.machine.machineId, [], f.signal],
		]);
		expect(f.boundary.mock.invocationCallOrder[1]).toBeLessThan(f.repositories.export.mock.invocationCallOrder[0]!);
	});
	it("checks a publication against the session's values and its environment asked again, the pull request first", async () => {
		const f = await folderFixture();
		// Made-up values.
		const kept = "made-up-canary-5j5b-kept-value",
			fresh = "made-up-canary-5j5b-fresh-value";
		let values: Record<string, string> = { TOKEN: kept };
		const environment = vi.fn<CodingEnvironmentSource["environment"]>(async () => ({
			environment: values,
			mask: [],
		}));
		const host = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, commandEnvironment: { environment } });
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await host.commandTransport(f.scope(), async () => undefined, f.signal);
		// A command started with one value, and the session's environment holds another now.
		const { secrets } = mocked.folderTransports[0] as { secrets: CodingCommandSecrets };
		const request = {
			companyId: f.claim.profileId,
			workerId: f.claim.workerId,
			machineId: f.machine.machineId,
			commandId: randomUUID(),
			kind: "command" as const,
		};
		await secrets.resolve(request, f.signal);
		secrets.accepted(request);
		values = { TOKEN: fresh };
		const title = f.claim.title;
		for (const [claimTitle, summary] of [
			[title, `Tests passed with ${kept}`],
			[`${title} ${fresh}`, "Tests passed"],
		] as const) {
			f.claim.title = claimTitle;
			const error = await host.publish(f.claim, { ...f.submission, summary }, f.signal).then(
				() => null,
				(error: unknown) => error,
			);
			expect(error).toBeInstanceOf(CodingPushRefused);
			expect((error as CodingPushRefused).message).toBe("CODING_PUSH_CARRIES_SECRET");
			expect((error as CodingPushRefused).carrier).toEqual({ kind: "pull-request" });
			for (const value of [kept, fresh]) expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(value);
		}
		expect(mocked.push).not.toHaveBeenCalled();
		expect(mocked.publish).not.toHaveBeenCalled();
		// What the pull request does not get is not checked.
		f.claim.title = `${title.padEnd(200)}${fresh}`;
		expect(await host.publish(f.claim, f.submission, f.signal)).toEqual({
			pullRequest: f.pullRequest,
			noChange: false,
		});
		expect(mocked.publish.mock.calls[0]?.[0]).toMatchObject({ title: title.padEnd(200), body: "Tests passed" });
		// The push is checked against both values.
		const pushed = (mocked.push.mock.calls[0]?.[2] as { secrets: CodingSecretMask }).secrets;
		for (const value of [kept, fresh]) {
			const stream = pushed.stream();
			stream.push(Buffer.from(value));
			stream.end();
			expect(stream.matched).toBe(true);
		}
		// Asked at the session's attach (5j-5 (a)) and the command's start, then once for each publication, under the claim;
		// nothing a publication asked is kept.
		const scope = { companyId: f.claim.profileId, workerId: f.claim.workerId, leaseToken: f.claim.leaseToken };
		expect(environment.mock.calls.map((call) => call[0])).toEqual([scope, scope, scope, scope, scope]);
		const output = await secrets.output(request, f.signal);
		const stream = output!();
		expect(Buffer.from([...stream.push(Buffer.from(fresh)), ...stream.end()]).toString()).toBe(fresh);
		// A failed ask fails the publication.
		environment.mockRejectedValueOnce(new Error("CODING_SECRET_BROKER_UNAVAILABLE"));
		await expect(host.publish(f.claim, f.submission, f.signal)).rejects.toThrow("CODING_SECRET_BROKER_UNAVAILABLE");
		expect(mocked.push).toHaveBeenCalledTimes(1);
	});
	it.each([
		["holds the machine's reads", "READS_UNANSWERED", { reads: "unanswered" as const, views: [] }],
		[
			"did not save a view",
			"SAVE_FAILED",
			{ reads: "released" as const, views: [{ viewId: randomUUID(), error: "SAVE_FAILED" }] },
		],
		[
			"left a view's paths unsaved",
			"UNSAVED_WAITING",
			{
				reads: "released" as const,
				views: [
					{ viewId: randomUUID(), unsaved: 0 },
					{ viewId: randomUUID(), unsaved: 2, unsavedOutcome: "waiting" },
				],
			},
		],
		[
			"refused a view's save whole",
			"REFUSED_STOPPED",
			{ reads: "released" as const, views: [{ viewId: randomUUID(), unsaved: 0, refused: "stopped" }] },
		],
		[
			"answered a view without its report",
			"UNREPORTED",
			{ reads: "released" as const, views: [{ viewId: randomUUID() }] },
		],
		// Refusals that are not all the save check's (5j-5 a): the core's own beside them.
		[
			"refused a view's paths, none for a secret value",
			"UNSAVED_REFUSED",
			{ reads: "released" as const, views: [{ viewId: randomUUID(), unsaved: 1, unsavedOutcome: "refused" }] },
		],
		[
			"refused a view's paths, only some for a secret value",
			"UNSAVED_REFUSED",
			{
				reads: "released" as const,
				views: [{ viewId: randomUUID(), unsaved: 2, unsavedOutcome: "refused", secretRefused: 1 }],
			},
		],
		[
			"refused a view's paths, only some the check could not finish",
			"UNSAVED_REFUSED",
			{
				reads: "released" as const,
				views: [{ viewId: randomUUID(), unsaved: 2, unsavedOutcome: "refused", uncheckedRefused: 1 }],
			},
		],
		[
			"refused one view's paths for a secret value and left another's waiting",
			"UNSAVED_REFUSED",
			{
				reads: "released" as const,
				views: [
					{ viewId: randomUUID(), unsaved: 1, unsavedOutcome: "refused", secretRefused: 1 },
					{ viewId: randomUUID(), unsaved: 1, unsavedOutcome: "waiting" },
				],
			},
		],
	])("publishes nothing when the boundary %s, and says why", async (_case, held, answer) => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.boundary.mockResolvedValueOnce({ machine: f.machine.machineId, ...answer });
		await expect(f.host.publish(f.claim, f.submission, f.signal)).rejects.toThrow(
			new Error(`CODING_FOLDER_BOUNDARY_HELD:${held}`),
		);
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it.each([
		["for secret values", { secretRefused: 2 }, "CODING_FOLDER_SAVE_REFUSED"],
		[
			"for a secret value and a check not finished",
			{ secretRefused: 1, uncheckedRefused: 1 },
			"CODING_FOLDER_SAVE_REFUSED",
		],
		["for checks not finished (5j-5 c)", { uncheckedRefused: 2 }, "CODING_FOLDER_SAVE_UNCHECKED"],
	])(
		"throws a save the folder refused %s (5j-5 a) as one the turn fails with, naming no path, and publishes nothing",
		async (_case, counts, code) => {
			const f = await folderFixture();
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			f.boundary.mockResolvedValueOnce({
				machine: f.machine.machineId,
				reads: "released" as const,
				views: [
					{ viewId: randomUUID(), unsaved: 0 },
					{ viewId: randomUUID(), unsaved: 2, unsavedOutcome: "refused", ...counts },
				],
			});
			const error = await f.host.publish(f.claim, f.submission, f.signal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CodingSaveRefused);
			expect((error as CodingSaveRefused).message).toBe(code);
			expect((error as CodingSaveRefused).unchecked).toBe(code === "CODING_FOLDER_SAVE_UNCHECKED");
			expect(f.repositories.export).not.toHaveBeenCalled();
			expect(mocked.push).not.toHaveBeenCalled();
		},
	);
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
	it("lands a repository kept in Qorpera with the picture the session named, and its session reports the landing under the turn's lease (own code storage, step 2b)", async () => {
		const f = await folderFixture();
		f.claim.repository = { host: "qorpera", owner: "acme", name: "shop", baseBranch: "main" };
		const headSha = f.submission.headSha;
		const report: CodeChangeReport = {
			schema: "qorpera.code-change-report/v1",
			state: "landed",
			inLine: true,
			how: "fast-forward",
			headSha,
			mainBefore: f.baseSha,
			mainAfter: headSha,
			filesChanged: 2,
			paths: [
				{ path: "src/price.tsx", change: "changed" },
				{ path: "docs/changes/free-returns.png", change: "added" },
			],
			pathsMore: 0,
			picture: { state: "ok", blob: "c".repeat(40), bytes: 51_234, type: "png" },
			refusal: null,
		};
		// The repositories as the code hosts' are: the landing reports through the session it is given.
		const recorded: unknown[] = [];
		const start = vi.fn<NonNullable<CodingFolderRepositories["start"]>>(async () => ({ baseSha: f.baseSha }));
		const land = vi.fn<NonNullable<CodingFolderRepositories["land"]>>(async (session, _headSha, signal) => {
			recorded.push(await session.recordChange?.(report, signal).catch((error: unknown) => error));
			return { state: "fast-forward", mainSha: headSha, filesChanged: 2, change: 14 };
		});
		Object.assign(f.repositories, { start, land });
		const control = f.call.getMockImplementation()!;
		const reports: Record<string, unknown>[] = [];
		let answer: unknown = { schema: "qorpera.code-change-recorded/v1", state: "recorded", change: 14 };
		f.call.mockImplementation(async (method, args, signal) => {
			if (method !== "qorpera_record_code_change") return control(method, args, signal);
			reports.push(args);
			return answer;
		});
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const picture = "docs/changes/free-returns.png";
		expect(await f.host.publish(f.claim, { ...f.submission, picture }, f.signal)).toEqual({
			pullRequest: null,
			noChange: false,
			landed: { state: "fast-forward", mainSha: headSha, filesChanged: 2, change: 14 },
		});
		// The picture goes to the landing, which checks it in git; nothing is exported or pushed.
		expect(land.mock.calls[0]?.slice(1)).toEqual([headSha, f.signal, { picture }]);
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
		// The report carries the turn's worker and lease: the kernel takes it from the executor that holds the turn.
		expect(reports).toEqual([{ p_worker_id: f.claim.workerId, p_lease_token: f.claim.leaseToken, p_change: report }]);
		expect(recorded).toEqual([{ state: "recorded", change: 14 }]);
		expect(CODING_HOST_RPCS).toContain("qorpera_record_code_change");
		// No picture named: none handed on. The kernel may know the commit already, or have no row for it.
		for (const [given, heard] of [
			[
				{ schema: "qorpera.code-change-recorded/v1", state: "nothing", change: null },
				{ state: "nothing", change: null },
			],
			[
				{ schema: "qorpera.code-change-recorded/v1", state: "known", change: 3 },
				{ state: "known", change: 3 },
			],
		]) {
			answer = given;
			await f.host.publish(f.claim, f.submission, f.signal);
			expect(land.mock.calls.at(-1)?.[3]).toEqual({});
			expect(recorded.at(-1)).toEqual(heard);
		}
		// An answer that is not the kernel's confirms nothing.
		for (const odd of [
			null,
			{ state: "recorded", change: 14 },
			{ schema: "qorpera.code-change-recorded/v1", state: "saved", change: 14 },
			{ schema: "qorpera.code-change-recorded/v1", state: "recorded", change: 0 },
			{ schema: "qorpera.code-change-recorded/v1", state: "recorded" },
		]) {
			answer = odd;
			await f.host.publish(f.claim, f.submission, f.signal);
			expect(recorded.at(-1)).toBeInstanceOf(Error);
		}
	});
	it("returns noChange for a Qorpera repository when headSha equals baseSha without landing or pushing", async () => {
		const f = await folderFixture();
		f.claim.repository = { host: "qorpera", owner: "acme", name: "shop", baseBranch: "main" };
		const start = vi.fn<NonNullable<CodingFolderRepositories["start"]>>(async () => ({ baseSha: f.baseSha }));
		const land = vi.fn<NonNullable<CodingFolderRepositories["land"]>>();
		Object.assign(f.repositories, { start, land });
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(await f.host.publish(f.claim, { ...f.submission, headSha: f.baseSha }, f.signal)).toEqual({
			pullRequest: null,
			noChange: true,
		});
		expect(f.boundary).toHaveBeenCalledTimes(1);
		expect(land).not.toHaveBeenCalled();
		expect(f.repositories.export).not.toHaveBeenCalled();
		expect(mocked.push).not.toHaveBeenCalled();
	});
	it("reports a session busy by the one idle rule, a waiting command quiet, its commands as the host kept them, and renews no guest lease", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		vi.mocked(f.client.execInstance).mockClear();
		const running = randomUUID(),
			exited = randomUUID(),
			unkept = randomUUID();
		const commands = [
			{ commandId: running, state: "running" },
			{ commandId: exited, state: "exited" },
			{ commandId: unkept, state: "running" },
		];
		mocked.guestStatus.mockResolvedValue(f.status(commands, { cpuUsageUsec: 1000 }));
		// The host kept no start of the third: it is not reported.
		mocked.keptCommand.mockImplementation(async (_custody: string, _workerId: string, commandId: string) =>
			commandId === running ? { turn: 1, command: `npm run dev ${"é".repeat(200)}` } : undefined,
		);
		const kept = [{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" }];
		expect(await f.host.keep(f.signal)).toEqual(kept);
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
					// The first look has nothing to compare the processor time with.
					busy: false,
					sessions: [
						{
							workerId: f.claim.workerId,
							busy: false,
							// Clipped to 300 bytes, whole characters.
							running: [{ commandId: running, turn: 1, command: `npm run dev ${"é".repeat(144)}` }],
						},
					],
				},
			}),
		]);
		// The one idle rule's two signals, as on the NAS model: a command that waits stays quiet though it runs; a build
		// that works is busy, and so is a download that moves data with little processor.
		const look = async (now: readonly { commandId: string; state: string }[], usage: Partial<CodingGuestUsage>) => {
			mocked.guestStatus.mockResolvedValue(f.status(now, usage));
			expect(await f.host.keep(f.signal)).toEqual(kept);
			const keep = f.calls("qorpera_keep_coding_attachments").at(-1) as { p_observation: { busy: boolean } };
			return keep.p_observation.busy;
		};
		expect(await look(commands, { uptimeMs: 610_000, cpuUsageUsec: 1000 + 100_000, ioBytes: 1000 })).toBe(false);
		expect(await look(commands, { uptimeMs: 620_000, cpuUsageUsec: 1000 + 5_100_000, ioBytes: 2000 })).toBe(true);
		// 0.1 s of processor in 10 s (1%), but 200 KB moved (more than 512 KiB in 30 s): busy by its data.
		expect(await look(commands, { uptimeMs: 630_000, cpuUsageUsec: 1000 + 5_200_000, ioBytes: 202_000 })).toBe(true);
		// 100 KB in 10 s and as little processor: below both thresholds.
		expect(await look(commands, { uptimeMs: 640_000, cpuUsageUsec: 1000 + 5_300_000, ioBytes: 302_000 })).toBe(false);
		// Nothing runs: quiet, and still named in the observation, so SQL keeps it.
		expect(await look([], { uptimeMs: 650_000, cpuUsageUsec: 1000 + 5_300_000, ioBytes: 302_000 })).toBe(false);
		expect(f.calls("qorpera_keep_coding_attachments").at(-1)).toMatchObject({
			p_observation: { sessions: [{ workerId: f.claim.workerId, busy: false, running: [] }] },
		});
		// The guest read only some of the machine's processes: busy, though what it saw moved nothing.
		const partial = { uptimeMs: 660_000, cpuUsageUsec: 1000 + 5_300_000, ioBytes: 302_000, ioComplete: false };
		expect(await look([], partial)).toBe(true);
		// A usage read on another boot's clock compares with nothing: the observation is refused.
		mocked.guestStatus.mockResolvedValue(f.status([], { bootId: randomUUID(), uptimeMs: 1000 }));
		expect(await f.host.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_OBSERVATION_UNCONFIRMED",
			},
		]);
		// The guest agent answers it all: no helper runs, and no guest lease is renewed.
		expect(f.execs()).toEqual([]);
		expect(mocked.refresh).not.toHaveBeenCalled();
	});
	it("counts a session busy when the guest read only some of the machine's processes, on the first look too", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const busy = async (usage: Partial<CodingGuestUsage>) => {
			mocked.guestStatus.mockResolvedValue(f.status([], usage));
			expect(await f.host.keep(f.signal)).toEqual([
				{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			]);
			const keep = f.calls("qorpera_keep_coding_attachments").at(-1) as {
				p_observation: { busy: boolean; sessions: { busy: boolean }[] };
			};
			expect(keep.p_observation.sessions.map((session) => session.busy)).toEqual([keep.p_observation.busy]);
			return keep.p_observation.busy;
		};
		// Bytes it could not see may be the session's: the machine must not sleep on them.
		expect(await busy({ ioComplete: false })).toBe(true);
		// Read whole on the next look, it compares with the last by the idle rule.
		expect(await busy({ uptimeMs: 610_000 })).toBe(false);
	});
	it("takes a released session off: its commands cancelled through the guest agent, the session quiet, its view ended, the session stopped", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		const command = randomUUID();
		mocked.guestStatus.mockResolvedValue(f.status([{ commandId: command, state: "running" }]));
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
		mocked.guestStatus.mockResolvedValue(f.status([{ commandId: randomUUID(), state: "running" }]));
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
			return f.status();
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
		mocked.guestStatus.mockResolvedValue(f.status([{ commandId: command, state: "running" }]));
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

describe("a coding machine's secret values for the folder service's save check (5j-5 (a))", () => {
	const API_KEY = "env-value-api-key-CANARY";
	const ROTATED = "env-value-api-key-ROTATED";

	/** The folder fixture with a vault answering `answer`, and a folder service that is handed what the machine's values
	 * are each time it is given them. */
	async function secretsFixture(answer: { environment: Record<string, string>; mask?: string[] }) {
		const f = await folderFixture();
		const environment = vi.fn<CodingEnvironmentSource["environment"]>(async () => ({
			environment: { ...answer.environment },
			mask: [...(answer.mask ?? [])],
		}));
		const commandSecrets = new CodingMachineCommandSecrets({ environment });
		const given: (readonly string[] | undefined)[] = [];
		f.secrets.mockImplementation(async (machine) => {
			const values = commandSecrets.values(machine);
			given.push(values && [...values].sort());
			return values ? values.length : null;
		});
		const host = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, commandSecrets });
		return { ...f, host, commandSecrets, environment, given };
	}

	it.each([
		["none for a member with none", {}, [], []],
		["its values and the older ones", { API_KEY }, [ROTATED], [API_KEY, ROTATED].sort()],
	])(
		"gives the service the machine's values before the session's view attaches: %s",
		async (_case, environment, mask, given) => {
			const f = await secretsFixture({ environment, mask });
			await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
			// Asked under the session's claim at its attach, so they are known before a command starts.
			expect(f.environment.mock.calls).toEqual([
				[
					{ companyId: f.claim.profileId, workerId: f.claim.workerId, leaseToken: f.claim.leaseToken },
					expect.any(AbortSignal),
				],
			]);
			expect(f.given).toEqual([given]);
			expect(f.secrets.mock.calls).toEqual([[f.machine.machineId, expect.any(AbortSignal)]]);
			expect(f.environment.mock.invocationCallOrder[0]).toBeLessThan(f.secrets.mock.invocationCallOrder[0]!);
			expect(f.secrets.mock.invocationCallOrder[0]).toBeLessThan(f.views.attach.mock.invocationCallOrder[0]!);
		},
	);

	it("attaches no view when the values do not reach the service", async () => {
		const f = await secretsFixture({ environment: { API_KEY } });
		f.secrets.mockRejectedValueOnce(new Error("CODING_FOLDER_CONTROL_UNAVAILABLE"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_FOLDER_CONTROL_UNAVAILABLE",
		);
		expect(f.views.attach).not.toHaveBeenCalled();
	});

	it("attaches no view when the vault does not answer at the attach, and sends nothing", async () => {
		const f = await secretsFixture({ environment: { API_KEY } });
		f.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(f.host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toThrow(
			"CODING_ENVIRONMENT_UNAVAILABLE",
		);
		expect(f.secrets).not.toHaveBeenCalled();
		expect(f.views.attach).not.toHaveBeenCalled();
	});

	it("gives them again at each command's start, after the vault's answer and before the guest runs it", async () => {
		const answer = { environment: { API_KEY } };
		const f = await secretsFixture(answer);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.commandTransport(f.scope(), async () => undefined, f.signal);
		const secrets = (mocked.folderTransports.at(-1) as { secrets: CodingCommandSecrets }).secrets;
		const request = {
			companyId: f.claim.profileId,
			workerId: f.claim.workerId,
			machineId: f.machine.machineId,
			commandId: randomUUID(),
			kind: "command" as const,
		};
		// Rotated since the attach: the start's answer is in the set the service has before the command runs.
		answer.environment = { API_KEY: ROTATED };
		const resolved = await secrets.resolve(request, f.signal);
		expect(resolved.environment).toEqual({ API_KEY: ROTATED });
		expect(f.given).toEqual([[API_KEY], [API_KEY, ROTATED].sort()]);
		expect(f.environment.mock.invocationCallOrder[1]).toBeLessThan(f.secrets.mock.invocationCallOrder[1]!);
		// One that does not reach the service fails the start.
		f.secrets.mockRejectedValueOnce(new Error("CODING_FOLDER_CONTROL_UNAVAILABLE"));
		await expect(secrets.resolve({ ...request, commandId: randomUUID() }, f.signal)).rejects.toThrow(
			"CODING_FOLDER_CONTROL_UNAVAILABLE",
		);
	});

	it("gives them again on each keeper pass, and reports a failure or a service from before the check", async () => {
		const f = await secretsFixture({ environment: { API_KEY } });
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const kept = { machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" };
		expect(await f.host.keep(f.signal)).toEqual([kept]);
		expect(f.given).toEqual([[API_KEY], [API_KEY]]);
		f.secrets.mockRejectedValueOnce(new Error("CODING_FOLDER_CONTROL_UNAVAILABLE"));
		expect(await f.host.keep(f.signal)).toEqual([
			kept,
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "secrets",
				state: "failed",
				code: "CODING_FOLDER_CONTROL_UNAVAILABLE",
			},
		]);
		f.secrets.mockResolvedValueOnce("unsupported");
		expect(await f.host.keep(f.signal)).toEqual([
			kept,
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "secrets",
				state: "not-now",
				code: "CODING_FOLDER_SECRETS_UNSUPPORTED",
			},
		]);
	});

	it("releases cached machine secrets on sleep, machine removal, external stop, folder restart, new disk, and stale keeper prune", async () => {
		const extraScope = (f: Awaited<ReturnType<typeof secretsFixture>>) => ({
			companyId: f.claim.profileId,
			workerId: randomUUID(),
			leaseToken: randomUUID(),
		});

		const fSleep = await secretsFixture({ environment: { API_KEY } });
		await fSleep.host.prepareWorkspace(fSleep.claim, fSleep.turn(), fSleep.signal);
		await fSleep.commandSecrets.attached(fSleep.machine.machineId, extraScope(fSleep), fSleep.signal);
		expect(fSleep.commandSecrets.values(fSleep.machine.machineId)).toEqual([API_KEY]);
		fSleep.views.endMachine.mockResolvedValue([
			{ workerId: fSleep.claim.workerId, viewId: fSleep.viewId, saved: true, closed: true },
		]);
		fSleep.state.listed = [fSleep.entry({ sleepDue: true })];
		expect(await fSleep.host.housekeep(fSleep.signal)).toEqual([
			{ machineId: fSleep.machine.machineId, step: "sleep", state: "done" },
		]);
		expect(fSleep.commandSecrets.values(fSleep.machine.machineId)).toBeUndefined();

		const fRemove = await secretsFixture({ environment: { API_KEY } });
		await fRemove.host.prepareWorkspace(fRemove.claim, fRemove.turn(), fRemove.signal);
		await fRemove.commandSecrets.attached(fRemove.machine.machineId, extraScope(fRemove), fRemove.signal);
		expect(fRemove.commandSecrets.values(fRemove.machine.machineId)).toEqual([API_KEY]);
		fRemove.state.listed = [
			fRemove.entry({ removeDue: true, reserved: false, asleepSince: new Date().toISOString() }),
		];
		expect(await fRemove.host.housekeep(fRemove.signal)).toEqual([
			{ machineId: fRemove.machine.machineId, step: "delete", state: "done" },
		]);
		expect(fRemove.commandSecrets.values(fRemove.machine.machineId)).toBeUndefined();

		const fPrune = await secretsFixture({ environment: { API_KEY } });
		await fPrune.host.prepareWorkspace(fPrune.claim, fPrune.turn(), fPrune.signal);
		fPrune.host.endTurn(fPrune.claim);
		expect(fPrune.commandSecrets.values(fPrune.machine.machineId)).toEqual([API_KEY]);
		fPrune.state.listed = [];
		expect(await fPrune.host.keep(fPrune.signal)).toEqual([]);
		expect(fPrune.commandSecrets.values(fPrune.machine.machineId)).toBeUndefined();

		const fStop = await secretsFixture({ environment: { API_KEY } });
		await fStop.host.prepareWorkspace(fStop.claim, fStop.turn(), fStop.signal);
		await fStop.commandSecrets.attached(fStop.machine.machineId, extraScope(fStop), fStop.signal);
		fStop.host.endTurn(fStop.claim);
		expect(fStop.commandSecrets.values(fStop.machine.machineId)).toEqual([API_KEY]);
		fStop.state.stoppedFromOutside = true;
		fStop.lxd.running = false;
		fStop.views.endMachine.mockResolvedValue([
			{ workerId: fStop.claim.workerId, viewId: fStop.viewId, saved: false, closed: true },
		]);
		await expect(fStop.host.prepareWorkspace(fStop.claim, fStop.turn(), fStop.signal)).rejects.toThrow(
			"CODING_FOLDER_VIEW_UNSAVED",
		);
		expect(fStop.commandSecrets.values(fStop.machine.machineId)).toBeUndefined();

		const fRestart = await secretsFixture({ environment: { API_KEY } });
		await fRestart.host.prepareWorkspace(fRestart.claim, fRestart.turn(), fRestart.signal);
		await fRestart.commandSecrets.attached(fRestart.machine.machineId, extraScope(fRestart), fRestart.signal);
		fRestart.host.endTurn(fRestart.claim);
		fRestart.state.folderRestart = true;
		fRestart.lxd.running = false;
		fRestart.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(fRestart.host.prepareWorkspace(fRestart.claim, fRestart.turn(), fRestart.signal)).rejects.toThrow(
			"CODING_ENVIRONMENT_UNAVAILABLE",
		);
		expect(fRestart.commandSecrets.values(fRestart.machine.machineId)).toBeUndefined();

		const fNewDisk = await secretsFixture({ environment: { API_KEY } });
		await fNewDisk.host.prepareWorkspace(fNewDisk.claim, fNewDisk.turn(), fNewDisk.signal);
		fNewDisk.host.endTurn(fNewDisk.claim);
		fNewDisk.state.folderRestart = true;
		fNewDisk.state.newDisk = true;
		fNewDisk.lxd.running = false;
		const baseNewDiskCall = fNewDisk.call.getMockImplementation()!;
		let sawNewDiskRecord = false;
		fNewDisk.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_machine_new_disk") {
				sawNewDiskRecord = true;
				await fNewDisk.commandSecrets.attached(fNewDisk.machine.machineId, extraScope(fNewDisk), fNewDisk.signal);
				expect(fNewDisk.commandSecrets.values(fNewDisk.machine.machineId)).toEqual([API_KEY]);
			}
			return baseNewDiskCall(method, args, signal);
		});
		fNewDisk.environment.mockRejectedValueOnce(new Error("CODING_ENVIRONMENT_UNAVAILABLE"));
		await expect(fNewDisk.host.prepareWorkspace(fNewDisk.claim, fNewDisk.turn(), fNewDisk.signal)).rejects.toThrow(
			"CODING_ENVIRONMENT_UNAVAILABLE",
		);
		expect(sawNewDiskRecord).toBe(true);
		expect(fNewDisk.commandSecrets.values(fNewDisk.machine.machineId)).toBeUndefined();
	});

	it("releases secrets during take-off before detach SQL settles and even if detach SQL fails", async () => {
		const f = await secretsFixture({ environment: { API_KEY } });
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		expect(f.commandSecrets.values(f.machine.machineId)).toEqual([API_KEY]);

		let stopEntered!: () => void;
		let releaseStop!: () => void;
		const stopStarted = new Promise<void>((resolve) => {
			stopEntered = resolve;
		});
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		mocked.guestStop.mockImplementationOnce(async () => {
			stopEntered();
			await stopGate;
		});

		let detachEntered!: () => void;
		let failDetach!: (error: Error) => void;
		const detachStarted = new Promise<void>((resolve) => {
			detachEntered = resolve;
		});
		const detachGate = new Promise<void>((_resolve, reject) => {
			failDetach = reject;
		});
		let stopCustodySeen = false;
		let secretsAtStopCustody: readonly string[] | undefined = ["UNSET"];
		const baseCall = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_session_detached") {
				detachEntered();
				await detachGate;
			}
			if (method === "qorpera_authorize_coding_machine_custody" && args.p_intent === "stop") {
				stopCustodySeen = true;
				secretsAtStopCustody = f.commandSecrets.values(f.machine.machineId);
			}
			return baseCall(method, args, signal);
		});

		f.state.listed = [f.entry()];
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		await f.host.keep(f.signal);
		await stopStarted;
		expect(f.commandSecrets.values(f.machine.machineId)).toEqual([API_KEY]);

		f.state.listed = [f.entry({ sleepDue: true, reserved: false, attached: [] })];
		const sleeping = f.host.housekeep(f.signal);
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(stopCustodySeen).toBe(false);

		releaseStop();
		await detachStarted;
		expect(f.commandSecrets.values(f.machine.machineId)).toBeUndefined();
		expect(await sleeping).toEqual([{ machineId: f.machine.machineId, step: "sleep", state: "done" }]);
		expect(stopCustodySeen).toBe(true);
		expect(secretsAtStopCustody).toBeUndefined();

		failDetach(new Error("CODING_HOST_DETACH_UNAVAILABLE"));
		await f.host.settled();
		expect(f.commandSecrets.values(f.machine.machineId)).toBeUndefined();
	});

	it("preserves a re-attached session's secrets when a stale detach record for an older token finishes", async () => {
		const f = await secretsFixture({ environment: { API_KEY } });
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		let detachEntered!: () => void;
		let releaseDetach!: () => void;
		const detachStarted = new Promise<void>((resolve) => {
			detachEntered = resolve;
		});
		const detachGate = new Promise<void>((resolve) => {
			releaseDetach = resolve;
		});
		const baseCall = f.call.getMockImplementation()!;
		let heldDetach = false;
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_session_detached" && !heldDetach) {
				heldDetach = true;
				detachEntered();
				await detachGate;
			}
			return baseCall(method, args, signal);
		});
		f.state.listed = [f.entry()];
		f.state.release.set(f.claim.workerId, "ARCHIVED");
		await f.host.keep(f.signal);
		await detachStarted;
		f.state.release.delete(f.claim.workerId);
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(f.commandSecrets.values(f.machine.machineId)).toEqual([API_KEY]);
		releaseDetach();
		await f.host.settled();
		expect(f.commandSecrets.values(f.machine.machineId)).toEqual([API_KEY]);
	});

	it("aborts sibling observeFolder calls on first error and cancels directory retry pauses on caller abort", async () => {
		const f = await folderFixture();
		const workers = Array.from({ length: 4 }, () => ({ workerId: randomUUID(), attachmentToken: randomUUID() }));
		f.state.listed = [f.entry({ attached: workers })];
		const siblingSignals: AbortSignal[] = [];
		let count = 0;
		mocked.guestStatus.mockImplementation(async (_req, itemSignal) => {
			const idx = count++;
			if (idx === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, 15));
				throw new Error("CODING_GUEST_UNREACHABLE");
			}
			siblingSignals.push(itemSignal);
			await new Promise<void>((resolve) => {
				if (itemSignal.aborted) resolve();
				else itemSignal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw itemSignal.reason;
		});
		const outcomes = await f.host.keep(f.signal);
		expect(outcomes).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_GUEST_UNREACHABLE",
			},
		]);
		expect(siblingSignals).toHaveLength(3);
		expect(siblingSignals.every((sig) => sig.aborted)).toBe(true);

		const fDir = await folderFixture();
		const impatient = new LxdCodingExecutorHost({ ...fDir.options, folder: fDir.folder, storageStepTimeoutMs: 50 });
		await impatient.prepareWorkspace(fDir.claim, fDir.turn(), fDir.signal);
		mocked.storageAssert.mockImplementationOnce(() => new Promise(() => {}));
		const controller = new AbortController();
		const started = performance.now();
		globalThis.setTimeout(() => controller.abort(new Error("caller-cancelled")), 80);
		await expect(impatient.publish(fDir.claim, fDir.submission, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(performance.now() - started).toBeLessThan(300);
	});

	it("observes multiple attached sessions concurrently with bounded parallelism and runs housekeep steps concurrently in list order", async () => {
		const f = await folderFixture();
		const workers = Array.from({ length: 6 }, () => ({ workerId: randomUUID(), attachmentToken: randomUUID() }));
		f.state.listed = [f.entry({ attached: workers })];
		let activeStatus = 0;
		let peakStatus = 0;
		let gateStatus = true;
		const releaseStatus: (() => void)[] = [];
		mocked.guestStatus.mockImplementation(async () => {
			activeStatus++;
			peakStatus = Math.max(peakStatus, activeStatus);
			if (gateStatus) {
				await new Promise<void>((resolve) => {
					releaseStatus.push(resolve);
					if (releaseStatus.length >= 4) {
						gateStatus = false;
						while (releaseStatus.length > 0) releaseStatus.shift()?.();
					}
				});
			}
			activeStatus--;
			return f.status([]);
		});
		await f.host.keep(f.signal);
		expect(peakStatus).toBe(4);
		const observation = f.calls("qorpera_keep_coding_attachments")[0]?.p_observation as {
			sessions: { workerId: string }[];
		};
		expect(observation.sessions.map((item) => item.workerId)).toEqual(workers.map((w) => w.workerId));

		const fHouse = await folderFixture();
		const machines = Array.from({ length: 5 }, () => randomUUID());
		fHouse.state.listed = machines.map((machineId) => {
			const binding = { ...fHouse.machine, machineId };
			return fHouse.entry({
				machineId,
				binding,
				instanceSha256: lxdCodingMachinePlan(binding).instanceSha256,
				attached: [],
				removeDue: true,
				reserved: false,
				asleepSince: new Date().toISOString(),
			});
		});
		let activeDelete = 0;
		let peakDelete = 0;
		let gateDelete = true;
		const releaseDelete: (() => void)[] = [];
		const baseReconcile = mocked.reconcile.getMockImplementation()!;
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			if (input.desiredState === "deleted") {
				activeDelete++;
				peakDelete = Math.max(peakDelete, activeDelete);
				if (gateDelete) {
					await new Promise<void>((resolve) => {
						releaseDelete.push(resolve);
						if (releaseDelete.length >= 4) {
							gateDelete = false;
							while (releaseDelete.length > 0) releaseDelete.shift()?.();
						}
					});
				}
				activeDelete--;
			}
			return baseReconcile(input);
		});
		const outcomes = await fHouse.host.housekeep(fHouse.signal);
		expect(peakDelete).toBe(4);
		expect(outcomes).toEqual(machines.map((machineId) => ({ machineId, step: "delete", state: "done" })));

		const fAbort = await folderFixture();
		const abortMachines = Array.from({ length: 6 }, () => randomUUID());
		fAbort.state.listed = abortMachines.map((machineId) => {
			const binding = { ...fAbort.machine, machineId };
			return fAbort.entry({
				machineId,
				binding,
				instanceSha256: lxdCodingMachinePlan(binding).instanceSha256,
				attached: [],
				removeDue: true,
				reserved: false,
				asleepSince: new Date().toISOString(),
			});
		});
		const controller = new AbortController();
		const startedMachines = new Set<string>();
		const reconcileSignals: AbortSignal[] = [];
		mocked.reconcile.mockImplementation(async (input: CodingMachineReconcileOptions) => {
			startedMachines.add(input.plan.machineId);
			reconcileSignals.push(input.signal);
			if (startedMachines.size === 4) controller.abort(new Error("housekeep-cancelled"));
			await new Promise<void>((resolve) => {
				if (input.signal.aborted) resolve();
				else input.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			throw input.signal.reason;
		});
		try {
			await expect(fAbort.host.housekeep(controller.signal)).rejects.toThrow("housekeep-cancelled");
		} finally {
			mocked.reconcile.mockImplementation(baseReconcile);
		}
		expect(startedMachines.size).toBe(4);
		expect(reconcileSignals).toHaveLength(4);
		expect(reconcileSignals.every((sig) => sig.aborted)).toBe(true);
	});
});

describe("a run of a repository's checks in the session's machine (own code storage, step 3)", () => {
	const CHECKS: CodeCheck[] = [
		{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
		{ name: "test", run: "npm test", timeoutSeconds: 900, cwd: "web" },
		{ name: "build", run: "npm run build", timeoutSeconds: 300, cwd: "." },
	];
	const COMMIT = "c".repeat(40);
	const HOME = "/home/qorpera-200000";
	/** How the fake guest agent ends a command: at once unless `after` (ms of running first); `printed` is its output. */
	interface Ending {
		state?: CodingGuestCommandState;
		code?: number;
		printed?: string | Buffer;
		after?: number;
	}

	/** The folder fixture on a repository kept in Qorpera, prepared for a turn, whose host runs commands through the real
	 * folder command transport over a fake guest agent; the vault gives `secrets`. `ending` says how each command the
	 * guest is asked to run ends (by default it succeeds, printing nothing). */
	async function checksFixture(
		options: {
			secrets?: Record<string, string>;
			budgetMs?: number;
			stopMs?: number;
			boundaryMs?: number;
			pollMs?: number | null;
			/** What the machine's agent says of its package caches at the mount (true: a new agent that made them). */
			packageCaches?: boolean;
		} = {},
	) {
		const f = await folderFixture();
		f.agent.packageCaches = options.packageCaches ?? true;
		f.claim.repository = { host: "qorpera", owner: "acme", name: "shop", baseBranch: "main" };
		Object.assign(f.repositories, {
			start: vi.fn<NonNullable<CodingFolderRepositories["start"]>>(async () => ({ baseSha: f.baseSha })),
		});
		// The vault: each answer it gives, counted.
		const vault = vi.fn<CodingEnvironmentSource["environment"]>(async () => ({
			environment: { ...options.secrets },
			mask: [],
		}));
		const commandSecrets = options.secrets ? new CodingMachineCommandSecrets({ environment: vault }) : undefined;
		const logged: Record<string, unknown>[] = [];
		// A mock, so that the order of its lines can be read beside the guest's calls (invocationCallOrder).
		const report = vi.fn((event: Record<string, unknown>) => {
			logged.push(event);
		});
		const host = new LxdCodingExecutorHost({
			...f.options,
			folder: {
				...f.folder,
				report,
				...(options.pollMs === null ? {} : { checksPollMs: options.pollMs ?? 5 }),
				checksStopMs: options.stopMs ?? 300,
				...(options.budgetMs === undefined ? {} : { checksBudgetMs: options.budgetMs }),
				...(options.boundaryMs === undefined ? {} : { checksBoundaryMs: options.boundaryMs }),
			},
			...(commandSecrets ? { commandSecrets } : {}),
		});
		mocked.realTransports = true;
		// The tail as the words' rule cuts it (part C1's own tests hold its bounds): here it says what it was handed.
		vi.mocked(codeChecksTail)
			.mockReset()
			.mockImplementation((output) => `tail of: ${output}`);
		await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const session = f.repositories.prepare.mock.calls.at(-1)?.[0] as CodingFolderRepositorySession;
		const custody = lxdCodingSessionStorage(f.machine, f.placement, f.claim.workerId).custodySource;
		await mkdir(custody, { recursive: true, mode: 0o700 });
		await chmod(custody, 0o700);
		// The guest agent: each command it is asked to run, once, as `ending` says.
		const { workerId } = f.claim;
		const commands = new Map<
			string,
			{
				run: CodingGuestRunRequest;
				state: CodingGuestCommandState;
				exit: { code: number | null; signal: string | null } | null;
				printed: Buffer;
				ending: Ending;
				until: number;
			}
		>();
		let ending: (run: CodingGuestRunRequest, index: number) => Ending = () => ({});
		const stateOf = (commandId: string) => {
			const found = commands.get(commandId);
			// As the guest agent answers a command it has no record of (the faked class is given its code).
			if (!found)
				throw Object.assign(new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN"), {
					code: "CODING_GUEST_COMMAND_UNKNOWN",
				});
			// A command that ran its time ends as it was told to.
			if (found.state === "running" && Date.now() >= found.until && found.ending.state !== "running") {
				found.state = found.ending.state ?? "exited";
				found.exit = found.state === "exited" ? { code: found.ending.code ?? 0, signal: null } : null;
			}
			return { commandId, state: found.state, exit: found.exit, end: found.printed.length };
		};
		mocked.guestRun.mockImplementation(async (request: unknown) => {
			const run = parseCodingGuestRequest("run", request);
			if (!commands.has(run.commandId)) {
				const said = ending(run, commands.size);
				commands.set(run.commandId, {
					run,
					state: "running",
					exit: null,
					printed: Buffer.from(said.printed ?? ""),
					ending: said,
					until: Date.now() + (said.after ?? 0),
				});
			}
			return { schema: "qorpera.coding-guest-command/v1", workerId, ...stateOf(run.commandId) };
		});
		mocked.guestOutput.mockImplementation(async (request: unknown) => {
			const asked = parseCodingGuestRequest("output", request);
			const at = stateOf(asked.commandId);
			const bytes = Buffer.from(
				(commands.get(asked.commandId) as { printed: Buffer }).printed.subarray(
					asked.offset,
					asked.offset + asked.maxBytes,
				),
			);
			const answer = parseCodingGuestAnswer("output", asked, {
				schema: "qorpera.coding-guest-output/v1",
				workerId,
				...at,
				offset: asked.offset,
				bytes: bytes.length,
				gap: 0,
			});
			return { answer, bytes };
		});
		mocked.guestCancel.mockImplementation(async (request: unknown) => {
			const asked = parseCodingGuestRequest("cancel", request);
			const found = commands.get(asked.commandId);
			if (found?.state === "running") found.state = "cancelled";
			return { schema: "qorpera.coding-guest-command/v1", workerId, ...stateOf(asked.commandId) };
		});
		return {
			...f,
			host,
			session,
			vault,
			logged,
			/** When the log line of `step` for `commandId` was written, in the order of every mock's calls. */
			loggedAt: (step: string, commandId: string) =>
				report.mock.calls.flatMap(([event], at) =>
					event.step === step && event.commandId === commandId
						? [report.mock.invocationCallOrder[at] as number]
						: [],
				),
			custody,
			commands,
			/** The commands the guest was asked to run, in order. */
			ran: () => [...commands.values()].map(({ run }) => run),
			ending: (given: typeof ending) => {
				ending = given;
			},
			/** One run of `checks` on COMMIT, as the landing asks it; `site` is the recipe it is given (none by default), and
			 * `rootLinks` whether its links from the root go through (step 5; not said by default, as before). */
			run: (
				checks: readonly CodeCheck[] = CHECKS,
				attempt = 1,
				signal: AbortSignal = f.signal,
				site: CodeSiteRecipe | null = null,
				rootLinks?: boolean,
			) =>
				(session.runChecks as NonNullable<CodingFolderRepositorySession["runChecks"]>)(
					{ commit: COMMIT, checks, attempt, site, ...(rootLinks === undefined ? {} : { rootLinks }) },
					signal,
				),
		};
	}
	/** A run's folder name: its turn's sequence and its attempt, zero-padded, so that names sort by time. */
	const runName = (sequence: number, attempt: number) =>
		`${String(sequence).padStart(10, "0")}-${String(attempt).padStart(4, "0")}`;
	/** The check a command of a run is, by its environment: undefined for the copy. */
	const checkOf = (run: { environment: Readonly<Record<string, string>> }) => run.environment.QORPERA_CHECK_RUN;

	it("lands through a session that runs the checks: the switch under the turn's lease, then a run that passes", async () => {
		const f = await checksFixture();
		expect(CODING_HOST_RPCS).toContain("qorpera_code_checks_switch");
		const control = f.call.getMockImplementation()!;
		let switched: unknown = { schema: "qorpera.code-checks-switch/v1", enabled: true };
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_code_checks_switch" ? switched : control(method, args, signal),
		);
		const seen: unknown[] = [];
		const land = vi.fn<NonNullable<CodingFolderRepositories["land"]>>(async (session, headSha, signal) => {
			seen.push(await session.checksSwitch?.(signal));
			seen.push(
				await session.runChecks?.({ commit: headSha, checks: CHECKS.slice(0, 1), attempt: 1, site: null }, signal),
			);
			return { state: "fast-forward", mainSha: headSha, filesChanged: 1, change: 3 };
		});
		Object.assign(f.repositories, { land });
		await f.host.publish(f.claim, f.submission, f.signal);
		expect(f.calls("qorpera_code_checks_switch")).toEqual([
			{ p_worker_id: f.claim.workerId, p_lease_token: f.claim.leaseToken },
		]);
		expect(seen).toEqual([
			{ checks: true, site: true },
			{
				state: "passed",
				ms: expect.any(Number),
				copyMs: expect.any(Number),
				checks: [{ name: "install", run: "npm ci", ms: expect.any(Number) }],
				site: null,
			},
		]);
		// The copy of exactly the submitted commit, then the one check.
		expect(f.ran().map((run) => run.environment.QORPERA_CHECKS_COMMIT ?? checkOf(run))).toEqual([
			f.submission.headSha,
			"npm ci",
		]);
		// Off is off; an answer lost or not the switch's reads as on, the site's too; the kernel's refusal ends the
		// landing. Sites are off only when the kernel says so (step 4); a kernel from before them says nothing: on.
		const ask = () => f.session.checksSwitch?.(f.signal);
		const schema = "qorpera.code-checks-switch/v1";
		for (const [answer, read] of [
			[
				{ schema, enabled: false },
				{ checks: false, site: true },
			],
			[
				{ schema, enabled: true, site: false },
				{ checks: true, site: false },
			],
			[
				{ schema, enabled: false, site: false },
				{ checks: false, site: false },
			],
			[
				{ schema, enabled: true, site: true },
				{ checks: true, site: true },
			],
		] as const) {
			switched = answer;
			expect(await ask()).toEqual(read);
		}
		for (const odd of [
			null,
			{ enabled: false },
			{ schema, enabled: "no" },
			{ schema, enabled: false, site: "no" },
			{ schema, enabled: false, site: null },
		]) {
			switched = odd;
			expect(await ask()).toEqual({ checks: true, site: true });
		}
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_code_checks_switch") throw new Error("CODING_CONTROL_UNCONFIRMED");
			return control(method, args, signal);
		});
		expect(await ask()).toEqual({ checks: true, site: true });
		expect(f.logged.filter((event) => event.step === "switch").map((event) => event.event)).toEqual([
			"code-checks-error",
			"code-checks-error",
			"code-checks-error",
			"code-checks-error",
			"code-checks-error",
			"code-checks-error",
		]);
		const refusal = new CodingControlRefused(null);
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_code_checks_switch") throw refusal;
			return control(method, args, signal);
		});
		await expect(ask()).rejects.toBe(refusal);
	});

	it("reads the switch's links from the root and an operator's drill only when the kernel says them (own code storage, step 5)", async () => {
		const f = await checksFixture();
		const control = f.call.getMockImplementation()!;
		let switched: unknown;
		f.call.mockImplementation(async (method, args, signal) =>
			method === "qorpera_code_checks_switch" ? switched : control(method, args, signal),
		);
		const ask = () => f.session.checksSwitch?.(f.signal);
		const schema = "qorpera.code-checks-switch/v1";
		// Exactly the keys said: none of step 5's while the kernel says none (hosts off, no drill waiting, a kernel before
		// migration 20260930756000), so the landing's run is asked as before.
		for (const [answer, read] of [
			[
				{ schema, enabled: true, site: true },
				{ checks: true, site: true },
			],
			[
				{ schema, enabled: true, site: true, rootLinks: true },
				{ checks: true, site: true, rootLinks: true },
			],
			[
				{ schema, enabled: true, site: true, rootLinks: false },
				{ checks: true, site: true },
			],
			[
				{ schema, enabled: true, site: true, drill: "check" },
				{ checks: true, site: true, drill: "check" },
			],
			[
				{ schema, enabled: false, site: false, rootLinks: true, drill: "site" },
				{ checks: false, site: false, rootLinks: true, drill: "site" },
			],
			[
				{ schema, enabled: true, rootLinks: true, preview: true, later: { key: 1 } },
				{ checks: true, site: true, rootLinks: true },
			],
		] as const) {
			switched = answer;
			expect(await ask(), JSON.stringify(answer)).toStrictEqual(read);
		}
		for (const rootLinks of [undefined, true] as const)
			for (const drill of [undefined, "check", "site"] as const) {
				const said = { ...(rootLinks ? { rootLinks } : {}), ...(drill ? { drill } : {}) };
				switched = { schema, enabled: true, site: true, ...said };
				expect(await ask(), JSON.stringify(said)).toStrictEqual({ checks: true, site: true, ...said });
			}
		// A value of either that is not the kernel's: the answer is not the switch's, and reads as on (no drill, links
		// from the root refused), as a lost answer does.
		for (const odd of [
			{ schema, enabled: false, site: false, rootLinks: "yes" },
			{ schema, enabled: false, site: false, rootLinks: null },
			{ schema, enabled: false, site: false, rootLinks: 1 },
			{ schema, enabled: false, site: false, drill: "other" },
			{ schema, enabled: false, site: false, drill: null },
			{ schema, enabled: false, site: false, drill: "CHECK" },
			{ schema, enabled: false, site: false, drill: true },
		]) {
			switched = odd;
			expect(await ask(), JSON.stringify(odd)).toStrictEqual({ checks: true, site: true });
		}
		expect(f.logged.filter((event) => event.step === "switch" && event.event === "code-checks-error")).toHaveLength(
			7,
		);
	});

	it("gives a session command the machine's package caches over the company's values of their names, as every command of its runs, once its agent said they are ready (own code storage, step 6)", async () => {
		// Each tool's download cache in the machine's shared folder (the guest agent makes it).
		expect(CODING_PACKAGE_CACHE_ENVIRONMENT).toEqual({
			npm_config_cache: "/var/cache/qorpera-packages/npm",
			npm_config_store_dir: "/var/cache/qorpera-packages/pnpm",
			pnpm_config_store_dir: "/var/cache/qorpera-packages/pnpm",
			PIP_CACHE_DIR: "/var/cache/qorpera-packages/pip",
			UV_CACHE_DIR: "/var/cache/qorpera-packages/uv",
			PLAYWRIGHT_BROWSERS_PATH: "/var/cache/qorpera-packages/ms-playwright",
			// Playwright's own GC would remove another session's browsers, its install unreadable in that session's home.
			PLAYWRIGHT_SKIP_BROWSER_GC: "1",
			CARGO_HOME: "/var/cache/qorpera-packages/cargo",
			GOMODCACHE: "/var/cache/qorpera-packages/go-mod",
			GOCACHE: "/var/cache/qorpera-packages/go-build",
			BUN_INSTALL_CACHE_DIR: "/var/cache/qorpera-packages/bun",
			TURBO_CACHE_DIR: "/var/cache/qorpera-packages/turbo",
			SCCACHE_DIR: "/var/cache/qorpera-packages/sccache",
		});
		const company = Object.fromEntries(
			Object.keys(CODING_PACKAGE_CACHE_ENVIRONMENT).map((name) => [name, `/company/value/of/${name}`]),
		);
		const f = await checksFixture({ secrets: { ...company, API_KEY: "env-value-api-key-CANARY" } });
		// A command of the session's own, through the transport its model's commands take, as the guest is asked to run it.
		const transport = await f.host.commandTransport(
			f.scope(),
			vi.fn(async () => undefined),
			f.signal,
		);
		const input = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "npm ci", timeoutMs: null };
		expect(await transport.start(f.scope(), input, f.signal)).toMatchObject({ state: "succeeded" });
		const [session] = f.ran();
		expect(session).toMatchObject({ commandId: input.commandId, command: "npm ci", cwd: f.cwd });
		expect(session?.environment).toMatchObject({
			...codingFolderGitEnvironment(f.claim.workerId),
			...CODING_PACKAGE_CACHE_ENVIRONMENT,
			API_KEY: "env-value-api-key-CANARY",
		});
		// And the copy and each check of a run.
		expect(await f.run()).toMatchObject({ state: "passed" });
		expect(f.ran()).toHaveLength(1 + 1 + CHECKS.length);
		for (const ran of f.ran()) expect(ran.environment).toMatchObject(CODING_PACKAGE_CACHE_ENVIRONMENT);
	});

	it("copies the candidate in the session's home and runs each check from its folder of the copy, as the session's user, with CI=true", async () => {
		const f = await checksFixture({ secrets: { API_KEY: "env-value-api-key-CANARY", CI: "false-from-the-vault" } });
		const run = await f.run();
		expect(run).toEqual({
			state: "passed",
			ms: expect.any(Number),
			copyMs: expect.any(Number),
			checks: CHECKS.map(({ name, run }) => ({ name, run, ms: expect.any(Number) })),
			site: null,
		});
		const [copy, ...checks] = f.ran();
		// Every command as the session's user, with its own names, Git's settings, its secrets and the checks' marks;
		// the vault never turns CI off.
		const common = {
			...codingFolderGitEnvironment(f.claim.workerId),
			API_KEY: "env-value-api-key-CANARY",
			CI: "true",
			QORPERA_CHECKS: "1",
			// Every command knows its run: the root, and the run's own name, ordered by the turn and the attempt.
			QORPERA_CHECKS_ROOT: `${HOME}/.qorpera-checks`,
			QORPERA_CHECKS_NAME: runName(f.claim.sequence, 1),
			HOME,
			USER: "qorpera-200000",
		};
		for (const ran of f.ran()) {
			expect(ran).toMatchObject({ workerId: f.claim.workerId, uid: 200000, gid: 200000 });
			expect(ran.environment).toMatchObject(common);
		}
		// The copy: in the home, its values in the environment, the repository's storage by its place in the folder. The
		// run's own folder is named by its turn and its attempt.
		const dir = `${HOME}/.qorpera-checks/0000000001-0001`;
		expect(f.claim.sequence).toBe(1);
		expect(copy).toMatchObject({ cwd: HOME, timeoutMs: 300_000 });
		expect(copy?.environment).toMatchObject({
			QORPERA_CHECKS_REPOSITORY: "/company/code/acme/shop/repo.git",
			QORPERA_CHECKS_COMMIT: COMMIT,
		});
		expect(Object.keys(copy?.environment ?? {}).filter((name) => name.startsWith("QORPERA_CHECK_"))).toEqual([]);
		expect(copy?.command).toContain('d="$r/$n"');
		expect(copy?.command).toContain(
			'git clone --quiet --shared --no-checkout -- "$QORPERA_CHECKS_REPOSITORY" "$d/src"',
		);
		expect(copy?.command).toContain('checkout --quiet --detach "$QORPERA_CHECKS_COMMIT"');
		// Each check: from the copy, with its own limit, folder, command and log.
		expect(checks.map((ran) => [ran.cwd, ran.timeoutMs, ran.environment.QORPERA_CHECK_CWD, checkOf(ran)])).toEqual([
			[`${dir}/src`, 600_000, ".", "npm ci"],
			[`${dir}/src`, 900_000, "web", "npm test"],
			[`${dir}/src`, 300_000, ".", "npm run build"],
		]);
		expect(checks.map((ran) => ran.environment.QORPERA_CHECK_LOG)).toEqual([
			`${dir}/out/1-install.log`,
			`${dir}/out/2-test.log`,
			`${dir}/out/3-build.log`,
		]);
		for (const ran of checks) {
			// First the rule that a command of a run that is not the newest does nothing; then the check itself.
			expect(ran.command).toContain("then exit 91; fi");
			expect(
				ran.command.endsWith(
					[
						'cd -- "$QORPERA_CHECK_CWD" || exit 2',
						'bash --noprofile --norc -c "$QORPERA_CHECK_RUN" </dev/null 2>&1 | tee -- "$QORPERA_CHECK_LOG"',
						`exit "\${PIPESTATUS[0]}"`,
					].join("\n"),
				),
			).toBe(true);
			expect(ran.environment.QORPERA_CHECKS_COMMIT).toBeUndefined();
		}
		// Each command's id names the turn, the attempt and its place; its input hash names the commit and what it runs.
		expect(f.ran().map((ran) => ran.commandId)).toEqual(
			[0, 1, 2, 3].map((index) => codingHostId("checks", `${f.claim.workerId}:${f.claim.sequence}:1:${index}`)),
		);
		for (const [index, ran] of f.ran().entries()) {
			const kept = JSON.parse(
				await readFile(join(f.custody, "host-commands", ran.commandId.replaceAll("-", ""), "request.json"), "utf8"),
			);
			expect(kept).toMatchObject({ command: ran.command, timeoutMs: ran.timeoutMs, turn: f.claim.sequence });
			expect(kept.inputSha256).toBe(
				hash(
					JSON.stringify({
						schema: "qorpera.code-checks-command/v1",
						commit: COMMIT,
						index,
						run: index ? CHECKS[index - 1]?.run : copy?.command,
					}),
				),
			);
		}
		// The next attempt's commands are its own.
		await f.run(CHECKS.slice(0, 1), 2);
		expect(
			f
				.ran()
				.slice(4)
				.map((ran) => ran.commandId),
		).toEqual([0, 1].map((index) => codingHostId("checks", `${f.claim.workerId}:${f.claim.sequence}:2:${index}`)));
		// The log says each command's start and end, and the run's answer, and never what a check printed.
		expect(f.logged.filter((event) => event.step === "run")).toEqual([
			expect.objectContaining({ event: "code-checks", attempt: 1, commit: COMMIT, state: "passed" }),
			expect.objectContaining({ event: "code-checks", attempt: 2, state: "passed" }),
		]);
		expect(f.logged.filter((event) => event.step === "ended")[1]).toMatchObject({
			index: 1,
			check: "install",
			state: "succeeded",
			exitCode: 0,
			ms: expect.any(Number),
		});
	});

	it("asks the host's own authority for each call of a check, never the model's", async () => {
		const f = await checksFixture();
		// The model's commands ask the model's authority as well.
		const model = vi.fn(async () => undefined);
		const transport = await f.host.commandTransport(f.scope(), model, f.signal);
		const runs = f.calls("qorpera_authorize_coding_machine_run").length;
		await f.run(CHECKS.slice(0, 1));
		expect(model).not.toHaveBeenCalled();
		expect(f.calls("qorpera_authorize_coding_command")).toEqual([]);
		// Each call of the copy's and of the check's asks run authority, before its work and before its answer.
		expect(f.calls("qorpera_authorize_coding_machine_run").length).toBeGreaterThanOrEqual(runs + 4);
		expect(transport).toBeInstanceOf(Object);
		// A machine marked for a new disk runs no check: the run did not run, by the run authority.
		f.state.newDisk = true;
		expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
			state: "not_run",
			why: "authority",
			code: "CODING_HOST_MACHINE_REFUSED:MACHINE_NEW_DISK",
		});
		f.state.newDisk = false;
		// A run authority SQL refuses: the same.
		f.state.runRefusal = "SESSION_NOT_RUNNING";
		expect(await f.run(CHECKS.slice(0, 1), 3)).toEqual({
			state: "not_run",
			why: "authority",
			code: "CODING_HOST_MACHINE_REFUSED:SESSION_NOT_RUNNING",
		});
		f.state.runRefusal = null;
		// A turn that is no longer prepared runs nothing at all.
		f.host.endTurn(f.claim);
		const asked = f.ran().length;
		expect(await f.run(CHECKS.slice(0, 1), 4)).toEqual({
			state: "not_run",
			why: "authority",
			code: "CODING_HOST_TURN_NOT_PREPARED",
		});
		expect(f.ran()).toHaveLength(asked);
		expect(f.logged.filter((event) => event.event === "code-checks-error")).toHaveLength(3);
	});

	it("ends with the first check that fails: what passed before it, its exit and the end of its output, and the rest not run", async () => {
		const f = await checksFixture();
		f.ending((run) => (checkOf(run) === "npm test" ? { code: 1, printed: "> test\n\n  1 failing\n" } : {}));
		const run = await f.run();
		expect(run).toEqual({
			state: "failed",
			ms: expect.any(Number),
			passed: [{ name: "install", ms: expect.any(Number) }],
			failed: {
				name: "test",
				run: "npm test",
				ms: expect.any(Number),
				exitCode: 1,
				atLimit: false,
				tail: "tail of: > test\n\n  1 failing\n",
				log: "~/.qorpera-checks/0000000001-0001/out/2-test.log",
			},
			notRun: ["build"],
		});
		expect(
			f
				.ran()
				.filter((r) => !r.environment.QORPERA_CHECKS_PERSIST_DIR)
				.map(checkOf),
		).toEqual([undefined, "npm ci", "npm test"]);
		expect(f.ran().some((r) => Boolean(r.environment.QORPERA_CHECKS_PERSIST_DIR))).toBe(true);
		// Killed (often for memory): a failure of the code all the same.
		f.ending((run) => (checkOf(run) === "npm ci" ? { state: "exited", code: 137 } : {}));
		expect(await f.run(CHECKS, 2)).toMatchObject({
			state: "failed",
			passed: [],
			failed: { name: "install", exitCode: 137, atLimit: false, tail: "tail of: " },
			notRun: ["test", "build"],
		});
	});

	it("keeps a failure whose tail could not be read, without its tail", async () => {
		const f = await checksFixture();
		// The run authority is refused from the read of the failed check's tail on.
		const control = f.call.getMockImplementation()!;
		let since: number | undefined;
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_authorize_coding_machine_run" && since !== undefined && ++since >= 2)
				return { state: "refused", reason: "SESSION_NOT_RUNNING" };
			return control(method, args, signal);
		});
		f.ending((run) => {
			if (!checkOf(run)) return {};
			since = 0;
			return { code: 1, printed: "boom\n" };
		});
		expect(await f.run(CHECKS.slice(0, 1))).toMatchObject({
			state: "failed",
			failed: { name: "install", exitCode: 1, tail: "" },
		});
		expect(f.logged).toContainEqual(
			expect.objectContaining({ event: "code-checks-error", step: "tail", check: "install" }),
		);
	});

	it("says a check that the guest stopped at its own limit ended at its time limit", async () => {
		const f = await checksFixture();
		const quick: CodeCheck = { name: "slow", run: "sleep 600", timeoutSeconds: 1, cwd: "." };
		f.ending((run) => (checkOf(run) ? { after: 1_100, state: "timed_out", printed: "waiting\n" } : {}));
		expect(await f.run([quick])).toMatchObject({
			state: "failed",
			failed: { name: "slow", exitCode: 124, atLimit: true, tail: "tail of: waiting\n" },
		});
		// A command that exits 124 itself before its limit did not reach it.
		f.ending((run) => (checkOf(run) ? { code: 124 } : {}));
		expect(await f.run([quick], 2)).toMatchObject({ failed: { exitCode: 124, atLimit: false } });
	});

	it("cuts a failed check's tail from the end of its masked output, at a whole line", async () => {
		const SECRET = "env-value-api-key-CANARY";
		const f = await checksFixture({ secrets: { API_KEY: SECRET } });
		const handed = async (printed: string, attempt: number) => {
			f.ending((run) => (checkOf(run) ? { code: 2, printed } : {}));
			const run = await f.run(CHECKS.slice(0, 1), attempt);
			if (run.state !== "failed") throw new Error(`not failed: ${run.state}`);
			const given = vi.mocked(codeChecksTail).mock.calls.at(-1)?.[0] as string;
			// The answer's tail is the rule's.
			expect(run.failed.tail).toBe(`tail of: ${given}`);
			return given;
		};
		// 5,000 lines: the last 16 KiB the transport kept, from its first whole line on.
		const lines = Array.from({ length: 5000 }, (_, at) => `line ${at}`);
		const printed = `${lines.join("\n")}\n`;
		const end = await handed(printed, 1);
		expect(Buffer.byteLength(end)).toBeLessThanOrEqual(16384);
		expect(Buffer.byteLength(end)).toBeGreaterThan(16000);
		expect(printed.endsWith(end)).toBe(true);
		expect(end.startsWith("line ")).toBe(true);
		expect(printed.slice(0, -end.length).endsWith("\n")).toBe(true);
		// One line of 20,000 bytes: its end, whole characters only.
		const wide = `${"\u00e9".repeat(9_000)}${"z".repeat(2_000)}`;
		const one = await handed(wide, 2);
		expect(wide.endsWith(one)).toBe(true);
		expect(Buffer.byteLength(one)).toBeLessThanOrEqual(16384);
		expect(one.length).toBeGreaterThan(7000);
		// The session's secret value is masked as its commands' output is, before anything of it is kept or handed on.
		const masked = await handed(`key=${SECRET}\nbell\u0007\n`, 3);
		expect(masked).toBe("key=***\nbell\u0007\n");
		const id = f
			.ran()
			.filter((r) => checkOf(r) !== undefined)
			.at(-1)?.commandId as string;
		const kept = await readFile(join(f.custody, "host-commands", id.replaceAll("-", ""), "output.log"), "utf8");
		expect(kept).toBe("key=***\nbell\u0007\n");
		// The copy's output, and a check that passed, are never handed on.
		expect(codeChecksTail).toHaveBeenCalledTimes(3);
	});

	it.each([
		["the copy fails (the commit never reached the view)", 0, { code: 90 }, "copy", "CODE_CHECKS_COPY_EXIT_90"],
		["the copy is cancelled by nobody", 0, { state: "cancelled" }, "machine", "CODE_CHECKS_CANCELLED"],
		["a check is cancelled by nobody", 2, { state: "cancelled" }, "machine", "CODE_CHECKS_CANCELLED"],
		["the guest lost a check", 1, { state: "lost" }, "machine", "CODE_CHECKS_UNCONFIRMED"],
	] as const)(
		"does not run the checks when %s, which is no fault of the code",
		async (_case, index, said, why, code) => {
			const f = await checksFixture();
			f.ending((_run, at) => (at === index ? (said as Ending) : {}));
			expect(await f.run()).toEqual({ state: "not_run", why, code });
			// Nothing after it ran.
			expect(f.ran()).toHaveLength(index + 1);
			expect(f.logged.at(-1)).toMatchObject({ event: "code-checks", step: "run", state: "not_run", why, code });
		},
	);

	it("does not run the checks when the guest agent stays unanswered, and stops what it started", async () => {
		const f = await checksFixture();
		mocked.guestOutput.mockRejectedValue(new Error("LXD operation failed"));
		const run = await f.run(CHECKS.slice(0, 1));
		expect(run).toEqual({ state: "not_run", why: "transport", code: "UNCLASSIFIED" });
		expect(mocked.guestCancel).toHaveBeenCalled();
		expect(f.logged).toContainEqual(
			expect.objectContaining({ event: "code-checks-error", step: "command", index: 0 }),
		);
	});

	it("asks a call that failed once again at the next read, and goes on", async () => {
		const f = await checksFixture();
		f.ending((run) => (checkOf(run) ? { after: 200 } : {}));
		// The guest agent does not answer the first look at the check's output: the start is asked again, and is the same
		// command, which runs once.
		const output = mocked.guestOutput.getMockImplementation()!;
		let failures = 0;
		mocked.guestOutput.mockImplementation(async (request: unknown) => {
			const asked = parseCodingGuestRequest("output", request);
			if (checkOf(f.commands.get(asked.commandId)?.run ?? { environment: {} }) && !failures++)
				throw new Error("LXD operation failed");
			return output(request);
		});
		expect(await f.run(CHECKS.slice(0, 1))).toMatchObject({ state: "passed" });
		expect(failures).toBeGreaterThan(1);
		// The guest had the start already: it is not asked to run it again.
		expect(f.ran()).toHaveLength(2);
		expect(mocked.guestRun).toHaveBeenCalledTimes(2);
	});

	it("cancels a check that runs past the run's budget, and says it did not run", async () => {
		const f = await checksFixture({ budgetMs: 300 });
		f.ending((run) => (checkOf(run) ? { state: "running", printed: "still going\n" } : {}));
		const started = Date.now();
		expect(await f.run(CHECKS.slice(0, 1))).toEqual({ state: "not_run", why: "budget", code: "CODE_CHECKS_BUDGET" });
		expect(Date.now() - started).toBeLessThan(5_000);
		const check = f.ran()[1]?.commandId;
		expect(mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId)).toEqual([
			check,
		]);
		expect(f.commands.get(check as string)?.state).toBe("cancelled");
	});

	it("cancels the running check when the turn gives up, with time of its own, and throws the turn's reason on", async () => {
		const f = await checksFixture();
		f.ending((run) => (checkOf(run) ? { state: "running" } : {}));
		const stop = new AbortController();
		const reason = new Error("CODING_EXECUTOR_LEASE_LOST");
		const running = f.run(CHECKS.slice(0, 1), 1, stop.signal);
		await vi.waitFor(() => expect(f.ran()).toHaveLength(2));
		stop.abort(reason);
		await expect(running).rejects.toBe(reason);
		const check = f.ran()[1]?.commandId as string;
		expect(mocked.guestCancel).toHaveBeenCalledTimes(1);
		const [request, cancelled] = mocked.guestCancel.mock.calls[0] as [{ commandId: string }, AbortSignal];
		expect(request.commandId).toBe(check);
		expect(cancelled.aborted).toBe(false);
		expect(f.commands.get(check)?.state).toBe("cancelled");
		// Nothing is reported of an aborted run.
		expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
		// A turn already given up runs nothing.
		await expect(f.run(CHECKS.slice(0, 1), 2, stop.signal)).rejects.toBe(reason);
		expect(f.ran()).toHaveLength(2);
	});

	describe("a run whose command does not stop (release review r1, F1)", () => {
		/** A run whose one check never ends by itself, past a budget of 300 ms: its stop is what the test says. */
		const stuck = async (stopMs?: number) => {
			const f = await checksFixture({ budgetMs: 300, ...(stopMs === undefined ? {} : { stopMs }) });
			f.ending((run) => (checkOf(run) ? { state: "running", printed: "building\n" } : {}));
			return f;
		};
		const cancels = () =>
			mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId);
		const folderOf = (run: { environment: Readonly<Record<string, string>>; cwd: string }) =>
			checkOf(run) ? run.cwd : `${run.environment.QORPERA_CHECKS_ROOT}/${run.environment.QORPERA_CHECKS_NAME}`;

		it("asks a cancel that is rejected again, believes the end only once a read confirms it, and runs again in another folder", async () => {
			const f = await stuck();
			const cancel = mocked.guestCancel.getMockImplementation()!;
			mocked.guestCancel
				.mockRejectedValueOnce(new Error("LXD operation failed"))
				.mockRejectedValueOnce(new Error("LXD operation failed"))
				.mockImplementation(cancel);
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({
				state: "not_run",
				why: "budget",
				code: "CODE_CHECKS_BUDGET",
			});
			const check = f.ran()[1]?.commandId as string;
			expect(cancels()).toEqual([check, check, check]);
			expect(f.commands.get(check)?.state).toBe("cancelled");
			expect(f.logged).toContainEqual(
				expect.objectContaining({ event: "code-checks", step: "ended", index: 1, state: "not_run", stopped: true }),
			);
			// Its end confirmed, the next run starts at once, asks nothing more of it, and works in a folder of its own.
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			expect(cancels()).toHaveLength(3);
			const [first, , again, checked] = f.ran();
			const one = runName(f.claim.sequence, 1),
				two = runName(f.claim.sequence, 2);
			expect([first, again].map((run) => run?.environment.QORPERA_CHECKS_NAME)).toEqual([one, two]);
			expect(one).not.toBe(two);
			expect([f.ran()[1]?.cwd, checked?.cwd]).toEqual([
				`${HOME}/.qorpera-checks/${one}/src`,
				`${HOME}/.qorpera-checks/${two}/src`,
			]);
			expect(checked?.environment.QORPERA_CHECK_LOG).toBe(`${HOME}/.qorpera-checks/${two}/out/1-install.log`);
		});

		it("reads a cancel that answers running again until the command has ended", async () => {
			const f = await stuck();
			const cancel = mocked.guestCancel.getMockImplementation()!;
			// The guest takes the first cancel and the command still runs; it has ended by the second.
			mocked.guestCancel
				.mockImplementationOnce(async (request: unknown) => {
					const asked = parseCodingGuestRequest("cancel", request);
					const found = f.commands.get(asked.commandId);
					return {
						schema: "qorpera.coding-guest-command/v1",
						workerId: f.claim.workerId,
						commandId: asked.commandId,
						state: found?.state ?? "running",
						exit: null,
						end: found?.printed.length ?? 0,
					};
				})
				.mockImplementation(cancel);
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({
				state: "not_run",
				why: "budget",
				code: "CODE_CHECKS_BUDGET",
			});
			const check = f.ran()[1]?.commandId as string;
			expect(cancels()).toEqual([check, check]);
			expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", index: 1, stopped: true }));
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
		});

		it("starts no run, and touches no folder, while a command of an earlier run has not stopped", async () => {
			const f = await stuck();
			// The guest takes every cancel, and the command runs on.
			mocked.guestCancel.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("cancel", request);
				const found = f.commands.get(asked.commandId);
				return {
					schema: "qorpera.coding-guest-command/v1",
					workerId: f.claim.workerId,
					commandId: asked.commandId,
					state: found?.state ?? "running",
					exit: null,
					end: found?.printed.length ?? 0,
				};
			});
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({
				state: "not_run",
				why: "budget",
				code: "CODE_CHECKS_BUDGET",
			});
			const check = f.ran()[1]?.commandId as string;
			expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", index: 1, stopped: false }));
			// The retry: the earlier check is cancelled and read again within the bound, still runs, and no copy starts.
			const asked = cancels().length;
			const started = performance.now();
			expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
			});
			expect(performance.now() - started).toBeLessThan(5_000);
			expect(f.ran()).toHaveLength(2);
			expect(cancels().length).toBeGreaterThan(asked);
			expect(new Set(cancels())).toEqual(new Set([check]));
			expect(f.logged).toContainEqual(
				expect.objectContaining({
					event: "code-checks",
					step: "earlier",
					attempt: 2,
					commandId: check,
					end: "running",
				}),
			);
			// The turn's abort while it waits is thrown on, and starts nothing.
			const stop = new AbortController();
			const reason = new Error("CODING_EXECUTOR_LEASE_LOST");
			mocked.guestCancel.mockImplementationOnce(async () => {
				stop.abort(reason);
				throw new Error("LXD operation failed");
			});
			await expect(f.run(CHECKS.slice(0, 1), 3, stop.signal)).rejects.toBe(reason);
			expect(f.ran()).toHaveLength(2);
			// Once it has ended, the next run starts, in a folder of its own, and the earlier command is asked no more.
			(f.commands.get(check) as { state: CodingGuestCommandState }).state = "cancelled";
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 4)).toMatchObject({ state: "passed" });
			expect(f.ran().map(folderOf).slice(2)).toEqual([
				`${HOME}/.qorpera-checks/${runName(f.claim.sequence, 4)}`,
				`${HOME}/.qorpera-checks/${runName(f.claim.sequence, 4)}/src`,
			]);
			const after = cancels().length;
			expect(await f.run(CHECKS.slice(0, 1), 5)).toMatchObject({ state: "passed" });
			expect(cancels()).toHaveLength(after);
		});

		/** A run whose one check's start never reaches the guest while the host asks (every answer lost), so its cancel
		 * finds nothing there: `cancelled`, for now. Then the lost start lands, before the retry's folder exists: the guest
		 * runs it (`running`), as a test server would run on. `stops` says whether the guest's cancel of it ends it. */
		const landsLate = async (stops: boolean) => {
			const f = await checksFixture();
			const older = runName(f.claim.sequence, 1);
			const run = mocked.guestRun.getMockImplementation()!;
			const lost: CodingGuestRunRequest[] = [];
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("run", request);
				if (asked.environment.QORPERA_CHECKS_NAME !== older || !checkOf(asked)) return run(request);
				lost.push(asked);
				throw new Error("LXD operation failed");
			});
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({ state: "not_run", why: "transport", code: "UNCLASSIFIED" });
			const landed = lost[0] as CodingGuestRunRequest;
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", attempt: 1, index: 1, state: "not_run", stopped: true }),
			);
			// It lands now, before the retry made anything.
			f.commands.set(landed.commandId, {
				run: landed,
				state: "running",
				exit: null,
				printed: Buffer.from("listening on 3000\n"),
				ending: { state: "running" },
				until: Number.POSITIVE_INFINITY,
			});
			const cancel = mocked.guestCancel.getMockImplementation()!;
			if (!stops)
				mocked.guestCancel.mockImplementation(async (request: unknown) => {
					const asked = parseCodingGuestRequest("cancel", request);
					if (asked.commandId !== landed.commandId) return cancel(request);
					return {
						schema: "qorpera.coding-guest-command/v1",
						workerId: f.claim.workerId,
						commandId: asked.commandId,
						state: "running",
						exit: null,
						end: 0,
					};
				});
			return { f, landed, older, newer: runName(f.claim.sequence, 2) };
		};
		const orderOf = (mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, commandId: string) =>
			mock.mock.calls.flatMap(([request], at) =>
				(request as { commandId: string }).commandId === commandId
					? [mock.mock.invocationCallOrder[at] as number]
					: [],
			);

		it("stops a check whose lost start landed before the retry's folder, after the retry's copy and before its first check (review round 5, F1)", async () => {
			const { f, landed, newer } = await landsLate(true);
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			const [copy, check] = f.ran().filter((ran) => ran.environment.QORPERA_CHECKS_NAME === newer);
			// The retry's copy (the fence), then the landed check cancelled and read until it ended, then the first check.
			const copied = orderOf(mocked.guestRun, copy?.commandId as string)[0] as number,
				checked = orderOf(mocked.guestRun, check?.commandId as string)[0] as number;
			const looked = orderOf(mocked.guestCancel, landed.commandId).filter((at) => at > copied);
			expect(looked.length).toBeGreaterThan(0);
			expect(Math.max(...looked)).toBeLessThan(checked);
			expect(f.commands.get(landed.commandId)?.state).toBe("cancelled");
			expect(f.logged).toContainEqual(
				expect.objectContaining({
					event: "code-checks",
					step: "looked",
					attempt: 2,
					commandId: landed.commandId,
					end: "ended",
				}),
			);
			// Looked at once: the next run asks nothing more of it.
			const asked = mocked.guestCancel.mock.calls.length;
			expect(await f.run(CHECKS.slice(0, 1), 3)).toMatchObject({ state: "passed" });
			expect(mocked.guestCancel.mock.calls).toHaveLength(asked);
		});

		it("starts no check when a lost start that landed before the retry's folder cannot be stopped (review round 5, F1)", async () => {
			const { f, landed, newer } = await landsLate(false);
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
			});
			// The retry's copy ran (its fence stands); no check of it started.
			expect(
				f
					.ran()
					.filter((ran) => ran.environment.QORPERA_CHECKS_NAME === newer)
					.map(checkOf),
			).toEqual([undefined]);
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "looked", attempt: 2, commandId: landed.commandId, end: "running" }),
			);
			// It holds every later run before anything, until it has ended.
			const before = f.ran().length;
			expect(await f.run(CHECKS.slice(0, 1), 3)).toMatchObject({ code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED" });
			expect(f.ran()).toHaveLength(before);
			(f.commands.get(landed.commandId) as { state: CodingGuestCommandState }).state = "cancelled";
			expect(await f.run(CHECKS.slice(0, 1), 4)).toMatchObject({ state: "passed" });
		});

		/** Review round 6, F1, in its order: a check's start is never answered; its first stop passes its bound (the guest
		 * refuses every cancel); the retry's guard before the run then gets the provisional `cancelled`; the lost start lands
		 * before the retry's folder exists (at the retry's first guest call, the stand-in guest shows it `running`). `stops`
		 * says whether the guest's cancel of the landed command ends it. */
		const timesOut = async (stops: boolean) => {
			const f = await checksFixture();
			const older = runName(f.claim.sequence, 1),
				newer = runName(f.claim.sequence, 2);
			const run = mocked.guestRun.getMockImplementation()!,
				cancel = mocked.guestCancel.getMockImplementation()!;
			let lost: CodingGuestRunRequest | undefined;
			let refuse = true;
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("run", request);
				if (asked.environment.QORPERA_CHECKS_NAME === older && checkOf(asked)) {
					lost = asked;
					throw new Error("LXD operation failed");
				}
				// The lost start lands now, before the retry's copy runs.
				if (
					asked.environment.QORPERA_CHECKS_NAME === newer &&
					!checkOf(asked) &&
					lost &&
					!f.commands.has(lost.commandId)
				)
					f.commands.set(lost.commandId, {
						run: lost,
						state: "running",
						exit: null,
						printed: Buffer.from("listening on 3000\n"),
						ending: { state: "running" },
						until: Number.POSITIVE_INFINITY,
					});
				return run(request);
			});
			mocked.guestCancel.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("cancel", request);
				if (refuse && asked.commandId === lost?.commandId) throw new Error("LXD operation failed");
				if (!stops && f.commands.get(asked.commandId)?.state === "running" && asked.commandId === lost?.commandId)
					return {
						schema: "qorpera.coding-guest-command/v1",
						workerId: f.claim.workerId,
						commandId: asked.commandId,
						state: "running",
						exit: null,
						end: 0,
					};
				return cancel(request);
			});
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({ state: "not_run", why: "transport", code: "UNCLASSIFIED" });
			const checkId = (lost as CodingGuestRunRequest).commandId;
			// Its first stop could not be confirmed.
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", attempt: 1, index: 1, state: "not_run", stopped: false }),
			);
			refuse = false;
			f.ending(() => ({}));
			return { f, checkId, newer };
		};

		it("looks again after the retry's fence at a check whose start was never answered and whose first stop timed out (review round 6, F1)", async () => {
			const { f, checkId, newer } = await timesOut(true);
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			// The guard before the retry got the provisional `cancelled`: no longer held there.
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "earlier", attempt: 2, commandId: checkId, end: "ended" }),
			);
			// The start landed before the retry's folder; the retry's copy, then the landed check cancelled and read until it
			// ended, then the retry's first check.
			const [copy, check] = f.ran().filter((ran) => ran.environment.QORPERA_CHECKS_NAME === newer);
			const copied = orderOf(mocked.guestRun, copy?.commandId as string)[0] as number,
				checked = orderOf(mocked.guestRun, check?.commandId as string)[0] as number;
			const looked = orderOf(mocked.guestCancel, checkId).filter((at) => at > copied);
			expect(looked.length).toBeGreaterThan(0);
			expect(Math.max(...looked)).toBeLessThan(checked);
			expect(f.loggedAt("looked", checkId).every((at) => at > copied && at < checked)).toBe(true);
			expect(f.commands.get(checkId)?.state).toBe("cancelled");
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "looked", attempt: 2, commandId: checkId, end: "ended" }),
			);
		});

		it("starts no check of the retry when that landed check cannot be stopped (review round 6, F1)", async () => {
			const { f, checkId, newer } = await timesOut(false);
			expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
			});
			expect(
				f
					.ran()
					.filter((ran) => ran.environment.QORPERA_CHECKS_NAME === newer)
					.map(checkOf),
			).toEqual([undefined]);
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "looked", attempt: 2, commandId: checkId, end: "running" }),
			);
		});

		it("looks again after the next fence at a check whose receipt ended it as unconfirmed (review round 6, F1)", async () => {
			const f = await checksFixture();
			// The guest lost the check: its receipt says `unconfirmed`, with no word of how it ended.
			f.ending((run) => (checkOf(run) ? { state: "lost" } : {}));
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_UNCONFIRMED",
			});
			const lost = f.ran()[1]?.commandId as string;
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			const [, copy, , check] = f.ran();
			const copied = orderOf(mocked.guestRun, copy?.commandId as string)[0] as number,
				checked = orderOf(mocked.guestRun, check?.commandId as string)[0] as number;
			const looked = f.loggedAt("looked", lost);
			expect(looked).toHaveLength(1);
			expect([copied < (looked[0] as number), (looked[0] as number) < checked]).toEqual([true, true]);
		});

		it("looks again after the next fence at a check the machine showed nothing of when it ended (review round 6, F1)", async () => {
			const f = await checksFixture();
			// The check ends at once; then the machine's disk can no longer be said (`hidden`: `unconfirmed`), so nothing of
			// the command may be shown, and one may still run there.
			let armed: number | undefined;
			const disk = mocked.disk.getMockImplementation()!;
			mocked.disk.mockImplementation(async (...args: unknown[]) => {
				if (armed !== undefined && ++armed >= 2) return "not a rebuild";
				return disk(...args);
			});
			f.ending((run) => {
				if (!checkOf(run)) return {};
				armed = 0;
				return { code: 0 };
			});
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_UNCONFIRMED",
			});
			armed = undefined;
			const shown = f.ran()[1]?.commandId as string;
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			const [, copy, , check] = f.ran();
			const copied = orderOf(mocked.guestRun, copy?.commandId as string)[0] as number,
				checked = orderOf(mocked.guestRun, check?.commandId as string)[0] as number;
			const looked = f.loggedAt("looked", shown);
			expect(looked).toHaveLength(1);
			expect([copied < (looked[0] as number), (looked[0] as number) < checked]).toEqual([true, true]);
		});

		it("lets a copy whose start was never acknowledged land after the retry began: the retry is not held back, and the late copy does nothing (review round 4, F1)", async () => {
			const f = await checksFixture();
			const older = runName(f.claim.sequence, 1),
				newer = runName(f.claim.sequence, 2);
			// The first run's copy never reaches the guest while the host asks: every start's answer is lost.
			const run = mocked.guestRun.getMockImplementation()!;
			const lost: CodingGuestRunRequest[] = [];
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("run", request);
				if (asked.environment.QORPERA_CHECKS_NAME !== older || checkOf(asked)) return run(request);
				lost.push(asked);
				throw new Error("LXD operation failed");
			});
			expect(await f.run(CHECKS.slice(0, 1))).toEqual({ state: "not_run", why: "transport", code: "UNCLASSIFIED" });
			const copyId = lost[0]?.commandId as string;
			expect(new Set(lost.map((request) => request.commandId))).toEqual(new Set([copyId]));
			// Its cancel found nothing in the guest: `cancelled` for now, never acknowledged, with no outcome kept. The host
			// takes it as stopped.
			const kept = join(f.custody, "host-commands", copyId.replaceAll("-", ""));
			expect(JSON.parse(await readFile(join(kept, "progress.json"), "utf8"))).toMatchObject({
				acknowledged: false,
				cancelled: true,
			});
			await expect(readFile(join(kept, "outcome.json"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", attempt: 1, index: 0, state: "not_run", stopped: true }),
			);
			// The retry runs at once, held back by nothing, in its own folder with a higher name.
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			expect(f.logged.filter((event) => event.step === "earlier")).toEqual([]);
			const [retry] = f.ran();
			expect(retry?.environment.QORPERA_CHECKS_NAME).toBe(newer);
			expect(Buffer.compare(Buffer.from(newer), Buffer.from(older))).toBe(1);
			// The lost start lands now: the guest runs what it was asked, the copy under the older run's name, beside the
			// newer run's folder. On this machine, with bash: it exits 91 having removed and made nothing.
			const landed = lost.at(-1) as CodingGuestRunRequest;
			expect(landed.command).toBe(retry?.command);
			expect(landed.environment).toMatchObject({
				QORPERA_CHECKS_ROOT: retry?.environment.QORPERA_CHECKS_ROOT,
				QORPERA_CHECKS_NAME: older,
			});
			const m = await onTheMachine();
			const at = await m.home("landed");
			await mkdir(join(at.root, newer, "src"), { recursive: true });
			await writeFile(join(at.root, newer, "src", "result.txt"), "the retry's\n");
			const late = await m.bash(
				landed.command,
				{
					HOME: at.home,
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: landed.environment.QORPERA_CHECKS_NAME as string,
					QORPERA_CHECKS_REPOSITORY: landed.environment.QORPERA_CHECKS_REPOSITORY as string,
					QORPERA_CHECKS_COMMIT: landed.environment.QORPERA_CHECKS_COMMIT as string,
				},
				at.home,
			);
			expect(late.code).toBe(91);
			expect(await readdir(at.root)).toEqual([newer]);
			expect(await readFile(join(at.root, newer, "src", "result.txt"), "utf8")).toBe("the retry's\n");
		});

		it("believes an earlier command ended once the guest no longer has it, or the host never kept its start", async () => {
			const f = await stuck();
			// Every cancel the guest takes, and the command runs on.
			mocked.guestCancel.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("cancel", request);
				const found = f.commands.get(asked.commandId);
				return {
					schema: "qorpera.coding-guest-command/v1",
					workerId: f.claim.workerId,
					commandId: asked.commandId,
					state: found?.state ?? "running",
					exit: null,
					end: found?.printed.length ?? 0,
				};
			});
			await f.run(CHECKS.slice(0, 1));
			const first = f.ran()[1]?.commandId as string;
			// The guest no longer knows the command (its machine lost it): it ended with the machine, and the next run
			// starts; its own check does not stop either.
			// (The faked class keeps no code of its own: it is given one.)
			const unknown = () =>
				Object.assign(new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN"), {
					code: "CODING_GUEST_COMMAND_UNKNOWN",
				});
			mocked.guestCancel.mockRejectedValueOnce(unknown());
			mocked.guestOutput.mockRejectedValueOnce(unknown());
			expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
				state: "not_run",
				why: "budget",
				code: "CODE_CHECKS_BUDGET",
			});
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "earlier", attempt: 2, commandId: first, end: "lost" }),
			);
			const second = f.ran()[3]?.commandId as string;
			expect(f.ran()).toHaveLength(4);
			// The host kept no start of a command: nothing of it ever ran.
			await rm(join(f.custody, "host-commands", second.replaceAll("-", "")), { recursive: true });
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 3)).toMatchObject({ state: "passed" });
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "earlier", attempt: 3, commandId: second, end: "unkept" }),
			);
		});
	});

	describe("the site the checks leave: the collect, the boundary and the drop (own code storage, step 4)", () => {
		const RECIPE: CodeSiteRecipe = { folder: "dist", name: "shop", title: "The shop" };
		const TREE = "a".repeat(40);
		/** The collect's own ending: its three lines. */
		const LINES = `tree ${TREE}\nfiles 3\nbytes 4096\n`;
		const MADE = {
			state: "made",
			tree: TREE,
			files: 3,
			bytes: 4096,
			folder: "dist",
			name: "shop",
			title: "The shop",
		};
		const SECRET_HELD = { code: "SITE_HOLDS_SECRET", path: null, variable: null };
		/** The drop's lines when it ran and removed two objects. */
		const DROPPED = ["started:drop", "ended:drop", "dropped:2"];
		const DIR = `${HOME}/.qorpera-checks/0000000001-0001`;
		const PASSED = CHECKS.map(({ name, run }) => ({ name, run, ms: expect.any(Number) }));
		type Answer = (machine: string, signal: AbortSignal) => Promise<CodingFolderBoundary>;
		/** A boundary that answers `reads`, with one view of each report. */
		const boundaryOf =
			(reads: CodingFolderBoundary["reads"], ...views: Omit<CodingFolderBoundaryView, "viewId">[]): Answer =>
			async (machine) => ({ machine, reads, views: views.map((view) => ({ viewId: randomUUID(), ...view })) });
		const SAVED = boundaryOf("released", { unsaved: 0 });
		const CARRIES = boundaryOf("released", { unsaved: 2, unsavedOutcome: "refused", secretRefused: 2 });
		const UNCHECKED = boundaryOf("released", { unsaved: 1, unsavedOutcome: "refused", uncheckedRefused: 1 });
		const CHECKING = boundaryOf("released", { unsaved: 1, unsavedOutcome: "waiting", checking: 1 });
		/** A boundary that never answers: its call ends only with its signal. */
		const SILENT: Answer = (_machine, signal) =>
			new Promise((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		/** What a command of the run is, by its text. */
		const kindOf = (run: CodingGuestRunRequest) =>
			run.command === CODE_SITE_COLLECT
				? "collect"
				: run.command === CODE_SITE_DROP
					? "drop"
					: checkOf(run)
						? "check"
						: "copy";

		/** The checks' fixture, whose guest ends the collect as `collect` says (its three lines, by default), the drop as
		 * `drop` says (two objects dropped) and every other command at once; and whose folder service answers every
		 * boundary as released and saved but those after the latest collect ended: `boundaries` in turn (the last one
		 * again) until the drop starts, and `after` once the drop has ended. */
		async function siteFixture(
			options: Parameters<typeof checksFixture>[0] & {
				collect?: Ending;
				drop?: Ending;
				boundaries?: Answer[];
				after?: Answer;
			} = {},
		) {
			const f = await checksFixture({ boundaryMs: 300, ...options });
			f.ending((run) => {
				const kind = kindOf(run);
				if (kind === "collect") return options.collect ?? { printed: LINES };
				if (kind === "drop") return options.drop ?? { printed: "dropped 2\n" };
				return {};
			});
			/** The first line of the log at or after `from` of `step` for the site's `site` command. */
			const lineOf = (step: string, site: string, from: number) => {
				for (let at = Math.max(from, 0); at < f.logged.length; at++) {
					const event = f.logged[at];
					if (event?.event === "code-checks" && event.step === step && event.site === site) return at;
				}
				return -1;
			};
			let collectedAt = -1,
				asked = 0;
			f.boundary.mockImplementation(async (machine, _final, signal) => {
				let started = -1;
				for (let at = f.logged.length - 1; at >= 0 && started < 0; at--)
					if (f.logged[at]?.step === "started" && f.logged[at]?.site === "collect") started = at;
				const collected = started < 0 ? -1 : lineOf("ended", "collect", started);
				if (collected < 0) return SAVED(machine, signal);
				const dropping = lineOf("started", "drop", collected);
				if (dropping >= 0)
					return lineOf("ended", "drop", dropping) < 0
						? SAVED(machine, signal)
						: (options.after ?? SAVED)(machine, signal);
				if (collected !== collectedAt) {
					collectedAt = collected;
					asked = 0;
				}
				const answers = options.boundaries ?? [SAVED];
				return (answers[Math.min(asked++, answers.length - 1)] as Answer)(machine, signal);
			});
			return {
				...f,
				/** One run of `checks` that takes the recipe's site (its links from the root as `rootLinks` says, step 5). */
				site: (
					attempt = 1,
					signal: AbortSignal = f.signal,
					checks: readonly CodeCheck[] = CHECKS,
					rootLinks?: boolean,
				) => f.run(checks, attempt, signal, RECIPE, rootLinks),
				/** The commands the guest was asked to run, by what they are. */
				kinds: () => f.ran().map(kindOf),
				/** The command of `kind` the guest was asked to run last. */
				command: (kind: "collect" | "drop") =>
					f
						.ran()
						.filter((run) => kindOf(run) === kind)
						.at(-1) as CodingGuestRunRequest,
				/** The id of the site's `kind` of the run of `attempt`. */
				idOf: (kind: "collect" | "drop", attempt = 1) =>
					codingHostId(
						"checks",
						`${f.claim.workerId}:${f.claim.sequence}:${attempt}:${kind === "collect" ? "site" : "drop"}`,
					),
				/** The log of the site's commands and boundaries, in order, each line by what it says. */
				steps: () =>
					f.logged.flatMap((event) => {
						if (event.event !== "code-checks") return [];
						if (event.step === "boundary") return [`boundary:${event.answer}`];
						if (event.step === "dropped") return [`dropped:${event.dropped}`];
						return event.site === "collect" || event.site === "drop" ? [`${event.step}:${event.site}`] : [];
					}),
				/** What a command's start kept, as the host keeps it. */
				kept: async (run: CodingGuestRunRequest) =>
					JSON.parse(
						await readFile(
							join(f.custody, "host-commands", run.commandId.replaceAll("-", ""), "request.json"),
							"utf8",
						),
					),
			};
		}

		it("takes nothing without a recipe: no command after the checks, no boundary of its own, and no site", async () => {
			const f = await siteFixture();
			expect(await f.run()).toEqual({
				state: "passed",
				ms: expect.any(Number),
				copyMs: expect.any(Number),
				checks: PASSED,
				site: null,
			});
			expect(f.kinds()).toEqual(["copy", "check", "check", "check"]);
			expect(f.steps()).toEqual([]);
			expect(f.logged.at(-1)).not.toHaveProperty("site");
		});

		it("collects the site after the last check passed, as one more command of the run, and makes it once the boundary saved it", async () => {
			const f = await siteFixture();
			expect(await f.site()).toEqual({
				state: "passed",
				ms: expect.any(Number),
				copyMs: expect.any(Number),
				checks: PASSED,
				site: MADE,
			});
			expect(f.kinds()).toEqual(["copy", "check", "check", "check", "collect"]);
			const collect = f.command("collect");
			// At the copy's src, with its own limit, id and text, the run's guard first; asked of the guest once.
			expect(collect).toMatchObject({
				cwd: `${DIR}/src`,
				timeoutMs: 120_000,
				commandId: f.idOf("collect"),
				command: CODE_SITE_COLLECT,
			});
			expect(collect.command.startsWith(CODE_CHECKS_NEWER_RUN.join("\n"))).toBe(true);
			expect(
				mocked.guestRun.mock.calls.filter(
					([request]) => (request as { commandId: string }).commandId === collect.commandId,
				),
			).toHaveLength(1);
			expect((await f.kept(collect)).inputSha256).toBe(
				hash(JSON.stringify({ schema: "qorpera.code-site-command/v1", commit: COMMIT, folder: "dist" })),
			);
			// The run's environment, the repository's storage, the recipe's folder and the secrets' names (none here).
			expect(collect.environment).toMatchObject({
				...codingFolderGitEnvironment(f.claim.workerId),
				CI: "true",
				QORPERA_CHECKS: "1",
				QORPERA_CHECKS_ROOT: `${HOME}/.qorpera-checks`,
				QORPERA_CHECKS_NAME: runName(f.claim.sequence, 1),
				QORPERA_CHECKS_REPOSITORY: "/company/code/acme/shop/repo.git",
				QORPERA_SITE_FOLDER: "dist",
				QORPERA_SITE_SECRET_NAMES: "",
			});
			expect(
				Object.keys(collect.environment).filter(
					(name) => name.startsWith("QORPERA_CHECK_") || name === "QORPERA_CHECKS_COMMIT",
				),
			).toEqual([]);
			// After the last check ended; then one boundary, saved; no drop.
			const last = f.logged.findIndex((event) => event.step === "ended" && event.index === 3);
			const started = f.logged.findIndex((event) => event.step === "started" && event.site === "collect");
			expect(last).toBeGreaterThan(-1);
			expect(started).toBeGreaterThan(last);
			expect(f.steps()).toEqual(["started:collect", "ended:collect", "boundary:saved"]);
			expect(f.logged).toContainEqual(
				expect.objectContaining({
					event: "code-checks",
					step: "ended",
					site: "collect",
					index: 4,
					state: "succeeded",
					exitCode: 0,
					folder: runName(f.claim.sequence, 1),
				}),
			);
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "boundary", again: false, asked: 1, answer: "saved", attempt: 1 }),
			);
			expect(f.logged.at(-1)).toMatchObject({ event: "code-checks", step: "run", state: "passed", site: "made" });
		});

		it("gives the collect the names of the session's secrets its command gets with their own values, never a value, from one vault answer", async () => {
			const secrets = {
				STRIPE_SECRET: "stripe-secret-value-2",
				API_KEY: "value-of-the-api-key-1",
				CI: "vault-ci-value-3",
				HOME: "/vault/home/value-4",
				PATH: "/vault/path/value-5",
				DOCKER_HOST: "unix:///vault/docker-6",
				GIT_CONFIG_COUNT: "vault-git-count-7",
				GIT_AUTHOR_NAME: "vault-author-name-8",
				QORPERA_CHECKS_NAME: "vault-run-name-9",
				QORPERA_CHECKS_REPOSITORY: "/vault/repository-10",
				QORPERA_SITE_FOLDER: "vault-site-folder-11",
				QORPERA_SITE_SECRET_NAMES: "VAULT NAMES TWELVE",
				// The machine's package caches win over a company value of their names (own code storage, step 6).
				...Object.fromEntries(
					Object.keys(CODING_PACKAGE_CACHE_ENVIRONMENT).map((name, index) => [name, `/vault/cache-${13 + index}`]),
				),
			};
			const f = await siteFixture({ secrets });
			const asked = f.vault.mock.calls.length;
			expect(await f.site()).toMatchObject({ state: "passed", site: MADE });
			const collect = f.command("collect");
			const names = collect.environment.QORPERA_SITE_SECRET_NAMES as string;
			// Exactly the names whose own values the command gets, in C order: a name the host or the session sets wins in
			// the command, and is left out.
			expect(names).toBe(
				Object.entries(secrets)
					.filter(([name, value]) => collect.environment[name] === value)
					.map(([name]) => name)
					.sort()
					.join(" "),
			);
			expect(names).toBe("API_KEY STRIPE_SECRET");
			for (const value of Object.values(secrets)) expect(names).not.toContain(value);
			// The values reach the command only as every command of the session gets them.
			expect(collect.environment.API_KEY).toBe(secrets.API_KEY);
			// One vault answer per command: the collect's names and its start share its id's.
			expect(f.vault.mock.calls.length - asked).toBe(f.ran().length);
			// Every name the collect's command had, given by the vault too: still exactly those whose own values it gets.
			// (A name the transport comes to set beyond the host's copy of the session's names is passed, and fails here.)
			const every = Object.fromEntries(
				Object.keys(collect.environment).map((name) => [name, `vault-value-of-${name.toLowerCase()}`]),
			);
			f.vault.mockImplementation(async () => ({ environment: every, mask: [] }));
			expect(await f.site(2)).toMatchObject({ state: "passed", site: MADE });
			const again = f.command("collect");
			expect(again.environment.QORPERA_SITE_SECRET_NAMES).toBe(
				Object.entries(every)
					.filter(([name, value]) => again.environment[name] === value)
					.map(([name]) => name)
					.sort()
					.join(" "),
			);
			expect(again.environment.QORPERA_SITE_SECRET_NAMES).toBe("API_KEY STRIPE_SECRET");
		});

		it("tells the collect whether links from the root go through, always one of two values over a secret of that name, and says it in the command's input only when they do (step 5)", async () => {
			// A company secret of the variable's name: never the collect's value. (Its value is not `allowed` itself, which is
			// under the 8 bytes a secret needs to be masked, so no command can be given it; the host's own value wins over
			// any secret's all the same.)
			const SECRET = "allowed-by-a-company-secret";
			const f = await siteFixture({
				secrets: { QORPERA_SITE_ROOT_LINKS: SECRET, API_KEY: "value-of-the-api-key-1" },
			});
			const today = hash(JSON.stringify({ schema: "qorpera.code-site-command/v1", commit: COMMIT, folder: "dist" }));
			// Not said (a landing before step 5, hosts off, an answer lost) and said false: refused, the input as before.
			for (const [attempt, rootLinks] of [
				[1, undefined],
				[2, false],
			] as const) {
				expect(await f.site(attempt, f.signal, CHECKS, rootLinks)).toMatchObject({ state: "passed", site: MADE });
				const collect = f.command("collect");
				expect(collect.environment.QORPERA_SITE_ROOT_LINKS).toBe("refused");
				expect((await f.kept(collect)).inputSha256).toBe(today);
				expect(collect.environment.QORPERA_SITE_SECRET_NAMES).toBe("API_KEY");
			}
			expect(await f.site(3, f.signal, CHECKS, true)).toMatchObject({ state: "passed", site: MADE });
			const allowed = f.command("collect");
			expect(allowed.environment.QORPERA_SITE_ROOT_LINKS).toBe("allowed");
			expect((await f.kept(allowed)).inputSha256).toBe(
				hash(
					JSON.stringify({
						schema: "qorpera.code-site-command/v1",
						commit: COMMIT,
						folder: "dist",
						rootLinks: true,
					}),
				),
			);
			expect(allowed.environment.QORPERA_SITE_SECRET_NAMES).toBe("API_KEY");
			// The host tells only the collect: every other command of the runs gets the secret of that name, as it gets
			// every secret.
			for (const ran of f.ran().filter((run) => kindOf(run) !== "collect"))
				expect(ran.environment.QORPERA_SITE_ROOT_LINKS, kindOf(ran)).toBe(SECRET);
		});

		it("gives no command of a machine whose agent did not make the package caches (from before them, or they failed) any of their variables: a company value of such a name reaches them as before, and the collect looks for it (own code storage, step 6)", async () => {
			const company = Object.fromEntries(
				Object.keys(CODING_PACKAGE_CACHE_ENVIRONMENT).map((name) => [name, `/company/value/of/${name}`]),
			);
			const f = await siteFixture({
				secrets: { ...company, API_KEY: "value-of-the-api-key-1" },
				packageCaches: false,
			});
			// A session command first, through the transport its model's commands take.
			const transport = await f.host.commandTransport(
				f.scope(),
				vi.fn(async () => undefined),
				f.signal,
			);
			const input = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "npm ci", timeoutMs: null };
			expect(await transport.start(f.scope(), input, f.signal)).toMatchObject({ state: "succeeded" });
			expect(await f.site()).toMatchObject({ state: "passed", site: MADE });
			const [session, ...run] = f.ran();
			expect(session?.environment).toMatchObject({ ...codingFolderGitEnvironment(f.claim.workerId), ...company });
			expect(run.map(kindOf)).toEqual(["copy", "check", "check", "check", "collect"]);
			for (const ran of [session, ...run]) {
				expect(ran?.environment).toMatchObject(company);
				for (const [name, value] of Object.entries(CODING_PACKAGE_CACHE_ENVIRONMENT))
					expect(ran?.environment[name]).not.toBe(value);
			}
			expect(f.command("collect").environment.QORPERA_SITE_SECRET_NAMES).toBe(
				["API_KEY", ...Object.keys(company)].sort().join(" "),
			);
		});

		it("gives the collect and the drop the machine's package caches over the company's values of their names (own code storage, step 6)", async () => {
			const company = Object.fromEntries(
				Object.keys(CODING_PACKAGE_CACHE_ENVIRONMENT).map((name) => [name, `/company/value/of/${name}`]),
			);
			const f = await siteFixture({
				secrets: { ...company, API_KEY: "value-of-the-api-key-1" },
				collect: { code: 4 },
			});
			expect(await f.site()).toMatchObject({ state: "passed", site: { state: "missed" } });
			expect(f.kinds()).toEqual(["copy", "check", "check", "check", "collect", "drop"]);
			for (const ran of f.ran())
				expect(ran.environment).toMatchObject({
					...CODING_PACKAGE_CACHE_ENVIRONMENT,
					API_KEY: "value-of-the-api-key-1",
				});
			expect(f.command("collect").environment.QORPERA_SITE_SECRET_NAMES).toBe("API_KEY");
		});

		it.each([
			["SITE_FOLDER_MISSING", "SITE_FOLDER_MISSING\n", null, null, undefined],
			["SITE_NO_INDEX", "SITE_NO_INDEX\n", null, null, undefined],
			["SITE_TOO_MANY_FILES", "SITE_TOO_MANY_FILES\n", null, null, undefined],
			["SITE_TOO_MANY_FOLDERS", "SITE_TOO_MANY_FOLDERS\n", null, null, undefined],
			["SITE_TOO_LARGE", "SITE_TOO_LARGE\n", null, null, undefined],
			["SITE_FILE_TOO_LARGE", "SITE_FILE_TOO_LARGE video/intro.mp4\n", "video/intro.mp4", null, undefined],
			["SITE_FILE_NAME", "SITE_FILE_NAME img/caf\\xc3\\xa9 1.png\n", "img/café 1.png", null, undefined],
			["SITE_HOLDS_SECRET", "SITE_HOLDS_SECRET API_KEY assets/app.js\n", "assets/app.js", "API_KEY", undefined],
			// A page that loads its style from the top of the domain (the first live site, 11 November 2026).
			["SITE_LINKS_FROM_ROOT", "SITE_LINKS_FROM_ROOT index.html 2\n", "index.html", null, 2],
		] as const)(
			"refuses a site the code made wrong (%s): the drop after it, and no boundary of its own",
			async (code, printed, path, variable, links) => {
				const f = await siteFixture({ collect: { code: 3, printed } });
				expect(await f.site()).toEqual({
					state: "site_refused",
					ms: expect.any(Number),
					checks: PASSED,
					problem: { code, path, variable, ...(links === undefined ? {} : { links }) },
				});
				expect(f.kinds()).toEqual(["copy", "check", "check", "check", "collect", "drop"]);
				expect(f.steps()).toEqual(["started:collect", "ended:collect", ...DROPPED]);
				expect(f.logged.at(-1)).toMatchObject({ step: "run", state: "site_refused", problem: code, variable });
			},
		);

		it.each([
			["exits otherwise (a git command failed)", { code: 4 }, "CODE_SITE_COLLECT_EXIT_4", true],
			["is stopped at its own limit", { state: "timed_out" }, "CODE_SITE_COLLECT_EXIT_124", true],
			[
				"ends 0 with lines that are not its answer",
				{ printed: `tree x\nfiles 3\nbytes 1\n` },
				"CODE_SITE_COLLECT_ANSWER_INVALID",
				true,
			],
			["prints more than its answer", { printed: `warning: x\n${LINES}` }, "CODE_SITE_COLLECT_ANSWER_INVALID", true],
			[
				"ends 3 with a line that is not its answer",
				{ code: 3, printed: "SITE_ODD\n" },
				"CODE_SITE_COLLECT_ANSWER_INVALID",
				true,
			],
			[
				"is lost by the guest (unconfirmed: its unit is no longer live)",
				{ state: "lost" },
				"CODE_SITE_COLLECT_UNCONFIRMED",
				true,
			],
			["is cancelled by nobody", { state: "cancelled" }, "CODE_SITE_COLLECT_CANCELLED", true],
			// Its guard found a newer run's folder before it made or wrote anything; the drop would find the same.
			["exits 91 (a newer run's folder stands)", { code: 91 }, "CODE_SITE_COLLECT_EXIT_91", false],
		] as const)(
			"misses the site when the collect %s: the change lands without one, the drop after it (%s)",
			async (_case, collect, code, drops) => {
				const f = await siteFixture({ collect: collect as Ending });
				expect(await f.site()).toEqual({
					state: "passed",
					ms: expect.any(Number),
					copyMs: expect.any(Number),
					checks: PASSED,
					site: { state: "missed", code },
				});
				// Tried once. Ended, it is dropped (but after its 91), and no boundary is asked for the drop: none was asked
				// before it. Its lines are read from its receipt, never as a failed check's tail.
				expect(f.kinds()).toEqual(["copy", "check", "check", "check", "collect", ...(drops ? ["drop"] : [])]);
				expect(f.steps()).toEqual(["started:collect", "ended:collect", ...(drops ? DROPPED : [])]);
				expect(codeChecksTail).not.toHaveBeenCalled();
				expect(f.logged.at(-1)).toMatchObject({ step: "run", state: "passed", site: "missed", siteCode: code });
			},
		);

		it("misses the site when the machine stopped under the collect", async () => {
			const f = await siteFixture();
			f.ending((run) => {
				if (kindOf(run) === "drop") return { printed: "dropped 2\n" };
				if (kindOf(run) !== "collect") return {};
				// Rebuilt while it ran: the disk it started on is gone.
				f.state.disk = randomUUID();
				return { printed: LINES };
			});
			expect(await f.site()).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODE_CHECKS_MACHINE_STOPPED" },
			});
			// It ended with the disk it ran on: the drop runs all the same, on the machine as it is.
			expect(f.steps()).toEqual(["started:collect", "ended:collect", ...DROPPED]);
		});

		it("misses the site when the guest agent stays unanswered about the collect, and stops it", async () => {
			const f = await siteFixture();
			const output = mocked.guestOutput.getMockImplementation()!;
			mocked.guestOutput.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("output", request);
				const found = f.commands.get(asked.commandId);
				if (found && kindOf(found.run) === "collect") throw new Error("LXD operation failed");
				return output(request);
			});
			expect(await f.site()).toMatchObject({ state: "passed", site: { state: "missed", code: "UNCLASSIFIED" } });
			expect(
				mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId),
			).toContain(f.idOf("collect"));
			expect(f.logged).toContainEqual(
				expect.objectContaining({ event: "code-checks-error", step: "command", site: "collect", index: 4 }),
			);
			// Its stop could not be confirmed either (the guest stays unanswered): it may still write, so no drop.
			expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", site: "collect", stopped: false }));
			expect(f.steps()).toEqual(["started:collect", "ended:collect"]);
		});

		it.each(["cancelled", "lost"] as const)(
			"drops what a collect stopped once its calls went unanswered wrote, once its stop confirmed its end (%s)",
			async (end) => {
				const f = await siteFixture({ collect: { state: "running" } });
				if (end === "lost") {
					// The guest's unit is no longer live, with no word of how it ended: its cancel's receipt says unconfirmed.
					const cancel = mocked.guestCancel.getMockImplementation()!;
					mocked.guestCancel.mockImplementation(async (request: unknown) => {
						const found = f.commands.get(parseCodingGuestRequest("cancel", request).commandId);
						if (found && kindOf(found.run) === "collect") found.state = "lost";
						return cancel(request);
					});
				}
				const output = mocked.guestOutput.getMockImplementation()!;
				let answered = 0;
				mocked.guestOutput.mockImplementation(async (request: unknown) => {
					const asked = parseCodingGuestRequest("output", request);
					const found = f.commands.get(asked.commandId);
					// Its start is answered; then the guest goes quiet about it until it was cancelled.
					if (found && kindOf(found.run) === "collect" && found.state === "running" && answered++ > 0)
						throw new Error("LXD operation failed");
					return output(request);
				});
				expect(await f.site()).toMatchObject({ state: "passed", site: { state: "missed", code: "UNCLASSIFIED" } });
				expect(f.commands.get(f.idOf("collect"))?.state).toBe(end);
				expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", site: "collect", stopped: true }));
				expect(f.steps()).toEqual(["started:collect", "ended:collect", ...DROPPED]);
			},
		);

		it.each(["its start was never answered", "its stop is not confirmed"] as const)(
			"runs no drop beside a collect that may still write: %s",
			async (how) => {
				const f = await siteFixture({ budgetMs: 800, collect: { state: "running" } });
				const id = f.idOf("collect");
				let code = "UNCLASSIFIED";
				if (how === "its start was never answered") {
					const run = mocked.guestRun.getMockImplementation()!;
					mocked.guestRun.mockImplementation(async (request: unknown) => {
						if (parseCodingGuestRequest("run", request).commandId === id) throw new Error("LXD operation failed");
						return run(request);
					});
				} else if (how === "its stop is not confirmed") {
					code = "CODE_CHECKS_BUDGET";
					const cancel = mocked.guestCancel.getMockImplementation()!;
					mocked.guestCancel.mockImplementation(async (request: unknown) => {
						const asked = parseCodingGuestRequest("cancel", request);
						if (asked.commandId !== id) return cancel(request);
						return {
							schema: "qorpera.coding-guest-command/v1",
							workerId: f.claim.workerId,
							commandId: id,
							state: "running",
							exit: null,
							end: 0,
						};
					});
				}
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject({
					state: "passed",
					site: { state: "missed", code },
				});
				expect(f.steps()).toEqual(["started:collect", "ended:collect"]);
				// The memories have it: the next run looks at it again after its fence.
				expect(f.kinds()).not.toContain("drop");
			},
		);

		it("drops what a collect wrote that ended, though the machine then showed nothing of it, and keeps it uncertain (review, F2)", async () => {
			const f = await siteFixture();
			// The collect makes its site and ends; then the machine's disk cannot be said once (`hidden`: unconfirmed).
			let armed: number | undefined;
			const disk = mocked.disk.getMockImplementation()!;
			mocked.disk.mockImplementation(async (...args: unknown[]) => {
				if (armed !== undefined && ++armed === 2) {
					armed = undefined;
					return "not a rebuild";
				}
				return disk(...args);
			});
			f.ending((run) => {
				if (kindOf(run) === "drop") return { printed: "dropped 2\n" };
				if (kindOf(run) !== "collect") return {};
				armed = 0;
				return { printed: LINES };
			});
			expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODE_CHECKS_UNCONFIRMED" },
			});
			// Its receipt said it ended: the drop runs, and no boundary was asked, so none is asked for the drop.
			expect(f.steps()).toEqual(["started:collect", "ended:collect", ...DROPPED]);
			// Still not seen to end for certain: the next run looks at it again after its fence.
			f.ending(() => ({}));
			expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			expect(f.loggedAt("looked", f.idOf("collect"))).toHaveLength(1);
		});

		it.each(["collect", "drop"] as const)(
			"bounds the %s by its own limit and a minute more, within the run's budget, when the machine's reads are never released (review, F1)",
			async (kind) => {
				const f = await siteFixture({ boundaries: [CARRIES] });
				// Once the command starts, no boundary releases the machine's reads: it shows `running` though the guest has
				// ended it.
				const saved = f.boundary.getMockImplementation()!;
				f.boundary.mockImplementation(async (machine, final, signal) =>
					f.logged.some((event) => event.step === "started" && event.site === kind)
						? { machine, reads: "unproven", views: [] }
						: saved(machine, final, signal),
				);
				// Its own limit and a minute: 180 s for the collect, 120 s for the drop, made 400 ms here; nothing else of
				// the run asks for that time.
				const bound = kind === "collect" ? 180_000 : 120_000;
				const timeout = AbortSignal.timeout.bind(AbortSignal);
				const asked: number[] = [];
				const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
					asked.push(ms);
					return timeout(ms === bound ? 400 : ms);
				});
				try {
					const started = Date.now();
					const run = await f.site(1, f.signal, CHECKS.slice(0, 1));
					expect(Date.now() - started).toBeLessThan(5_000);
					expect(run).toMatchObject(
						kind === "collect"
							? { state: "passed", site: { state: "missed", code: "CODE_CHECKS_BUDGET" } }
							: { state: "site_refused", problem: SECRET_HELD },
					);
					// The run's own budget was 20 minutes: 300 s for the copy, the check's 600 s and 60 s, and 240 s.
					expect(asked).toContain(1_200_000);
					expect(asked).toContain(bound);
					// It could not be confirmed ended either: it holds the next run, and the collect is not dropped.
					expect(f.logged).toContainEqual(
						expect.objectContaining({ step: "ended", site: kind, state: "not_run", stopped: false }),
					);
					if (kind === "collect") expect(f.steps()).toEqual(["started:collect", "ended:collect"]);
				} finally {
					spy.mockRestore();
				}
			},
		);

		it.each([
			[
				"the collect failed",
				{ code: 4 },
				{ state: "passed", site: { state: "missed", code: "CODE_SITE_COLLECT_EXIT_4" } },
			],
			[
				"the code made the site wrong",
				{ code: 3, printed: "SITE_NO_INDEX\n" },
				{ state: "site_refused", problem: { code: "SITE_NO_INDEX", path: null, variable: null } },
			],
		] as const)(
			"keeps the site's outcome when the drop after it fails (%s), and asks no boundary",
			async (_case, collect, outcome) => {
				const f = await siteFixture({ collect: collect as Ending, drop: { code: 1 } });
				expect(await f.site()).toMatchObject(outcome);
				expect(f.steps()).toEqual([
					"started:collect",
					"ended:collect",
					"started:drop",
					"ended:drop",
					"dropped:null",
				]);
			},
		);

		it("misses the site when the collect runs past the run's budget, and stops it", async () => {
			const f = await siteFixture({ budgetMs: 600, collect: { state: "running" } });
			const started = Date.now();
			expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODE_CHECKS_BUDGET" },
			});
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(f.commands.get(f.idOf("collect"))?.state).toBe("cancelled");
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", site: "collect", state: "not_run", stopped: true }),
			);
			// Its end confirmed, the drop is asked; but it runs inside the run's budget, which has passed: its start is
			// refused before anything of it is kept, and nothing of it reaches the machine.
			expect(f.steps()).toEqual(["started:collect", "ended:collect", "started:drop", "ended:drop", "dropped:null"]);
			expect(f.kinds()).not.toContain("drop");
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", site: "drop", state: "not_run", stopped: true }),
			);
		});

		it("misses the site when the run's budget passes while the secrets' names are read, and starts no collect", async () => {
			const f = await siteFixture({ budgetMs: 600, secrets: { API_KEY: "value-of-the-api-key-1" } });
			const vault = f.vault.getMockImplementation()!;
			f.vault.mockImplementation(async (scope, signal) => {
				if (f.ran().length < 2) return vault(scope, signal);
				return await SILENT("", signal).then(() => vault(scope, signal));
			});
			expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODE_CHECKS_BUDGET" },
			});
			expect(f.kinds()).toEqual(["copy", "check"]);
		});

		it("says the checks' own time, the site's aside", async () => {
			const f = await siteFixture({ boundaries: [SILENT], after: SILENT });
			const started = performance.now();
			const run = await f.site();
			const all = performance.now() - started;
			// The boundary after the collect and the one after the drop each waited out their 300 ms.
			expect(all).toBeGreaterThan(600);
			expect(run.state === "passed" && run.ms).toBeLessThan(all - 500);
		});

		it("misses the site when the secrets' names cannot be read, and starts no collect", async () => {
			const f = await siteFixture({ secrets: { API_KEY: "value-of-the-api-key-1" } });
			const vault = f.vault.getMockImplementation()!;
			f.vault.mockImplementation(async (...given) => {
				// Once the copy and each check ran, the ask is the collect's.
				if (f.ran().length === 4) throw new Error("CODING_SECRETS_UNAVAILABLE");
				return vault(...given);
			});
			expect(await f.site()).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODING_SECRETS_UNAVAILABLE" },
			});
			expect(f.kinds()).toEqual(["copy", "check", "check", "check"]);
			expect(f.logged).toContainEqual(
				expect.objectContaining({ event: "code-checks-error", step: "secrets", attempt: 1 }),
			);
		});

		it("refuses the site when the boundary's save check found a secret value in what the collect wrote: the drop removes it, and the boundary is asked once more", async () => {
			const f = await siteFixture({ boundaries: [CARRIES] });
			expect(await f.site()).toEqual({
				state: "site_refused",
				ms: expect.any(Number),
				checks: PASSED,
				problem: SECRET_HELD,
			});
			expect(f.kinds()).toEqual(["copy", "check", "check", "check", "collect", "drop"]);
			expect(f.steps()).toEqual([
				"started:collect",
				"ended:collect",
				"boundary:carries",
				"started:drop",
				"ended:drop",
				"dropped:2",
				"boundary:saved",
			]);
			// The drop: a command of the run as the collect is, at the copy's src, its own id, limit and text, with the
			// run's environment and the repository's storage only.
			const drop = f.command("drop");
			expect(drop).toMatchObject({
				cwd: `${DIR}/src`,
				timeoutMs: 60_000,
				commandId: f.idOf("drop"),
				command: CODE_SITE_DROP,
			});
			expect(drop.environment).toMatchObject({
				QORPERA_CHECKS_ROOT: `${HOME}/.qorpera-checks`,
				QORPERA_CHECKS_NAME: runName(f.claim.sequence, 1),
				QORPERA_CHECKS_REPOSITORY: "/company/code/acme/shop/repo.git",
				CI: "true",
			});
			expect(drop.environment.QORPERA_SITE_FOLDER).toBeUndefined();
			expect(drop.environment.QORPERA_SITE_SECRET_NAMES).toBeUndefined();
			expect((await f.kept(drop)).inputSha256).toBe(
				hash(JSON.stringify({ schema: "qorpera.code-site-drop/v1", commit: COMMIT })),
			);
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", site: "drop", index: 5, state: "succeeded", exitCode: 0 }),
			);
			expect(f.logged).toContainEqual(expect.objectContaining({ step: "boundary", again: true, asked: 1 }));
			expect(f.logged.at(-1)).toMatchObject({ step: "run", state: "site_refused", problem: "SITE_HOLDS_SECRET" });
		});

		it.each([
			["refused only as not checked", [UNCHECKED], "CODE_SITE_BOUNDARY_UNCHECKED"],
			[
				"holding a path for a conflict",
				[boundaryOf("released", { unsaved: 1, unsavedOutcome: "conflict" })],
				"CODE_SITE_BOUNDARY_HELD:UNSAVED_CONFLICT",
			],
			[
				"with a view that had an error",
				[boundaryOf("released", { error: "VIEW_GONE" })],
				"CODE_SITE_BOUNDARY_HELD:VIEW_GONE",
			],
			[
				"with a change set refused whole",
				[boundaryOf("released", { unsaved: 0, refused: "denied" })],
				"CODE_SITE_BOUNDARY_HELD:REFUSED_DENIED",
			],
			["with the machine's reads unproven", [boundaryOf("unproven")], "CODE_SITE_BOUNDARY_HELD:READS_UNPROVEN"],
			[
				"holding a secret value and something else",
				[
					boundaryOf(
						"released",
						{ unsaved: 2, unsavedOutcome: "refused", secretRefused: 2 },
						{ unsaved: 1, unsavedOutcome: "conflict" },
					),
				],
				"CODE_SITE_BOUNDARY_HELD:UNSAVED_REFUSED",
			],
			["still checking when its time is up", [CHECKING], "CODE_SITE_BOUNDARY_CHECKING"],
			["never answering", [SILENT], "CODE_SITE_BOUNDARY_UNANSWERED"],
		] as const)(
			"misses the site when the boundary after the collect is %s: the drop, and the boundary once more",
			async (_case, boundaries, code) => {
				const f = await siteFixture({ boundaries: [...boundaries] });
				const started = Date.now();
				expect(await f.site()).toMatchObject({ state: "passed", site: { state: "missed", code } });
				expect(Date.now() - started).toBeLessThan(5_000);
				expect(f.steps()).toEqual([
					"started:collect",
					"ended:collect",
					`boundary:${code}`,
					"started:drop",
					"ended:drop",
					"dropped:2",
					"boundary:saved",
				]);
			},
		);

		it("asks the boundary again each time while it is checking, or did not answer, and makes the site once it saved", async () => {
			const f = await siteFixture({
				boundaries: [
					CHECKING,
					async () => {
						throw new Error("CODING_FOLDER_CONTROL_UNAVAILABLE");
					},
					CHECKING,
					SAVED,
				],
			});
			expect(await f.site()).toMatchObject({ state: "passed", site: MADE });
			expect(f.steps()).toEqual(["started:collect", "ended:collect", "boundary:saved"]);
			expect(f.logged).toContainEqual(expect.objectContaining({ step: "boundary", asked: 4, answer: "saved" }));
			expect(f.logged).toContainEqual(expect.objectContaining({ event: "code-checks-error", step: "boundary" }));
		});

		it("asks the boundary through the wrapper a command's transport has: one that holds a read no longer readable marks the machine for a new disk, once", async () => {
			const unreadable = boundaryOf("unreadable");
			const f = await siteFixture({ boundaries: [unreadable], after: unreadable });
			expect(await f.site()).toMatchObject({
				state: "passed",
				site: { state: "missed", code: "CODE_SITE_BOUNDARY_HELD:READS_UNREADABLE" },
			});
			expect(f.calls("qorpera_mark_coding_machine_new_disk")).toHaveLength(1);
			expect(f.state.newDisk).toBe(true);
			// Marked, the machine starts no command: the drop does not run, and the boundary is asked once more.
			expect(f.steps()).toEqual([
				"started:collect",
				"ended:collect",
				"boundary:CODE_SITE_BOUNDARY_HELD:READS_UNREADABLE",
				"started:drop",
				"ended:drop",
				"dropped:null",
				"boundary:CODE_SITE_BOUNDARY_HELD:READS_UNREADABLE",
			]);
			expect(f.kinds()).not.toContain("drop");
		});

		it.each([
			["carries", "exits 1", CARRIES, { code: 1 }, { state: "site_refused", problem: SECRET_HELD }],
			[
				"unchecked",
				"exits 1",
				UNCHECKED,
				{ code: 1 },
				{ state: "passed", site: { state: "missed", code: "CODE_SITE_BOUNDARY_UNCHECKED" } },
			],
			[
				"carries",
				"prints no answer",
				CARRIES,
				{ printed: "dropped many\n" },
				{ state: "site_refused", problem: SECRET_HELD },
			],
		] as const)(
			"keeps the site's outcome when the drop itself fails (boundary %s, the drop %s)",
			async (_case, _drop, boundary, drop, outcome) => {
				const f = await siteFixture({ boundaries: [boundary], drop: drop as Ending });
				expect(await f.site()).toMatchObject(outcome);
				expect(f.steps().slice(-3)).toEqual(["ended:drop", "dropped:null", "boundary:saved"]);
			},
		);

		it("keeps the site refused when the drop runs past the run's budget, stops it, and does not hang", async () => {
			const f = await siteFixture({ budgetMs: 800, boundaries: [CARRIES], drop: { state: "running" } });
			const started = Date.now();
			expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject({
				state: "site_refused",
				problem: SECRET_HELD,
			});
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(f.commands.get(f.idOf("drop"))?.state).toBe("cancelled");
			expect(f.logged).toContainEqual(
				expect.objectContaining({ step: "ended", site: "drop", state: "not_run", stopped: true }),
			);
			// The boundary is asked once more all the same (the folder service's own client answers at once once the
			// run's time is up).
			expect(f.steps().slice(-3, -1)).toEqual(["ended:drop", "dropped:null"]);
			expect(f.steps().at(-1)).toMatch(/^boundary:/);
		});

		it("keeps the site refused when the guest agent stays unanswered about the drop, and stops it", async () => {
			const f = await siteFixture({ boundaries: [CARRIES] });
			const output = mocked.guestOutput.getMockImplementation()!;
			mocked.guestOutput.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("output", request);
				const found = f.commands.get(asked.commandId);
				if (found && kindOf(found.run) === "drop") throw new Error("LXD operation failed");
				return output(request);
			});
			expect(await f.site()).toMatchObject({ state: "site_refused", problem: SECRET_HELD });
			expect(
				mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId),
			).toContain(f.idOf("drop"));
			expect(f.steps().slice(-2)).toEqual(["dropped:null", "boundary:saved"]);
		});

		it("collects again in a run made again (another attempt), in its own folder, under its own id", async () => {
			const f = await siteFixture();
			expect(await f.site(1)).toMatchObject({ state: "passed", site: MADE });
			expect(await f.site(2)).toMatchObject({ state: "passed", site: MADE });
			const collects = f.ran().filter((run) => kindOf(run) === "collect");
			expect(collects.map((run) => run.commandId)).toEqual([f.idOf("collect", 1), f.idOf("collect", 2)]);
			expect(collects.map((run) => run.cwd)).toEqual([
				`${HOME}/.qorpera-checks/${runName(f.claim.sequence, 1)}/src`,
				`${HOME}/.qorpera-checks/${runName(f.claim.sequence, 2)}/src`,
			]);
			expect(collects.map((run) => run.environment.QORPERA_CHECKS_NAME)).toEqual([
				runName(f.claim.sequence, 1),
				runName(f.claim.sequence, 2),
			]);
		});

		it("gives a run that takes a site 240 s more of wall budget, and one without none", async () => {
			const f = await siteFixture();
			// The copy's 300 s, and each check's limit and 60 s.
			const checks = 300_000 + (600 + 900 + 300) * 1000 + 3 * 60_000;
			const timeout = vi.spyOn(AbortSignal, "timeout");
			try {
				await f.run();
				expect(timeout.mock.calls.map(([ms]) => ms)).toContain(checks);
				expect(timeout.mock.calls.map(([ms]) => ms)).not.toContain(checks + 240_000);
				timeout.mockClear();
				expect(await f.site(2)).toMatchObject({ site: MADE });
				expect(timeout.mock.calls.map(([ms]) => ms)).toContain(checks + 240_000);
				expect(timeout.mock.calls.map(([ms]) => ms)).not.toContain(checks);
			} finally {
				timeout.mockRestore();
			}
		});

		describe("a refused site's words, log lines and answer hold no secret value in any spelling (release review, F1)", () => {
			/** Every string a value holds, as it is (an error's message too). */
			const strings = (value: unknown): string[] =>
				typeof value === "string"
					? [value]
					: value instanceof Error
						? [value.message]
						: value !== null && typeof value === "object"
							? Object.values(value).flatMap(strings)
							: [];
			const refused = (problem: CodeSiteProblem) => ({ state: "site_refused", problem });
			it.each([
				{
					case: "a value of the session's with a backslash, in a name a site cannot serve",
					secrets: { BACKSLASH_KEY: "live_key\\foo-1234" },
					older: [],
					files: { "assets/live_key\\foo-1234.js": "x" },
					outcome: refused({ code: "SITE_HOLDS_SECRET", path: null, variable: "BACKSLASH_KEY" }),
				},
				{
					case: "a value of the session's with bytes outside ASCII",
					secrets: { UNICODE_KEY: "clé-secrète-42" },
					older: [],
					files: { "clé-secrète-42.css": "x" },
					outcome: refused({ code: "SITE_HOLDS_SECRET", path: null, variable: "UNICODE_KEY" }),
				},
				{
					case: "an older value of the machine's with a backslash, which only the host's mask knows",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["old\\key-value-77"],
					files: { "old\\key-value-77.js": "x" },
					outcome: refused({ code: "SITE_FILE_NAME", path: "***.js", variable: null }),
				},
				{
					case: "an older value of the machine's outside ASCII, which only the host's mask knows",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["vieux-clé-8899"],
					files: { "img/vieux-clé-8899.png": "x" },
					outcome: refused({ code: "SITE_FILE_NAME", path: "img/***.png", variable: null }),
				},
				// Review round 3 of #1691: a link is never printed, so no value in one reaches anyone in any spelling: one only
				// the host's mask knows (with a backslash; at the end of a long link, where a cut would have carried its
				// start), the session's by character references, and the review's CSS escape of a parenthesis (the URL token
				// takes it whole; neither the file's bytes nor a mask hold the value as it is written).
				{
					case: "an older value of the machine's with a backslash, in a link from the root",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["old\\link-value-77"],
					files: { "index.html": '<a href="/old\\link-value-77/x.html">x</a>' },
					outcome: refused({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, links: 1 }),
				},
				{
					case: "a value of the session's spelled by character references, in a link from the root",
					secrets: { LINK_KEY: "link-secret-4242" },
					older: [],
					files: { "index.html": '<a href="/k/&#108;ink-secret-4242">x</a>' },
					outcome: refused({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, links: 1 }),
				},
				{
					case: "an older value of the machine's at the end of a long link",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["OLDsecret-0123456789abcdefghijKL"],
					files: { "index.html": `<a href="/${"é".repeat(120)}OLDsecret-0123456789abcdefghijKL">x</a>` },
					outcome: refused({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, links: 1 }),
				},
				{
					case: "the session's value in a style sheet's URL, a parenthesis escaped (the review's case)",
					secrets: { ESCAPED_KEY: "prefix-secret-1234)tail-5678" },
					older: [],
					files: { "a.css": "a{background:url(/prefix-secret-1234\\)tail-5678)}" },
					outcome: refused({ code: "SITE_LINKS_FROM_ROOT", path: "a.css", variable: null, links: 1 }),
				},
				{
					case: "an older value of the machine's in a style sheet's URL, a parenthesis escaped",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["prefix-secret-1234)tail-5678"],
					files: { "a.css": "a{background:url(/prefix-secret-1234\\)tail-5678)}" },
					outcome: refused({ code: "SITE_LINKS_FROM_ROOT", path: "a.css", variable: null, links: 1 }),
				},
				{
					// The same for a name a site cannot serve: cut, it would carry the value's first 15 bytes.
					case: "an older value of the machine's at the end of a name too long to name whole",
					secrets: { OTHER_KEY: "unrelated-value-1" },
					older: ["OLDname-0123456789abcdefghijKLMN"],
					files: { [`${"é".repeat(100)}/${"é".repeat(23)}OLDname-0123456789abcdefghijKLMN.js`]: "x" },
					outcome: refused({ code: "SITE_FILE_NAME", path: null, variable: null }),
				},
				{
					case: "a value spelled only by escapes the collect never writes (an answer not the collect's)",
					secrets: { API_KEY: "API-TOKEN-5678" },
					older: [],
					files: {},
					forged: "SITE_FILE_TOO_LARGE big/\\x41PI-TOKEN-5678.mp4\n",
					outcome: { state: "passed", site: { state: "missed", code: "CODE_SITE_COLLECT_ANSWER_INVALID" } },
				},
			] as {
				case: string;
				secrets: Record<string, string>;
				older: string[];
				files: Record<string, string>;
				forged?: string;
				outcome: Record<string, unknown>;
			}[])("$case", async ({ secrets, older, files, forged, outcome }) => {
				const f = await siteFixture({ secrets });
				// The vault names the machine's older values too: masked in its output, never in an environment.
				const vault = f.vault.getMockImplementation()!;
				f.vault.mockImplementation(async (...given) => ({ ...(await vault(...given)), mask: older }));
				// The site on the machine, and the real collect over it, with the environment the host gave the guest; its
				// answer is what the guest printed, which the transport masks before the host reads it.
				const top = await realpath(await mkdtemp(join(tmpdir(), "code-site-words-")));
				roots.push(top);
				const name = runName(f.claim.sequence, 1);
				for (const [path, content] of Object.entries({ "index.html": "<p>site</p>", ...files })) {
					const at = join(top, name, "src", "dist", path);
					await mkdir(dirname(at), { recursive: true });
					await writeFile(at, content);
				}
				f.ending((run) => {
					const kind = kindOf(run);
					if (kind === "drop") return { printed: "dropped 0\n" };
					if (kind !== "collect") return {};
					if (forged !== undefined) return { code: 3, printed: forged };
					const ran = spawnSync("bash", ["--noprofile", "--norc", "-c", run.command], {
						cwd: join(top, name, "src"),
						env: {
							...run.environment,
							QORPERA_CHECKS_ROOT: top,
							QORPERA_CHECKS_REPOSITORY: join(top, "repo.git"),
							HOME: top,
						},
					});
					return { code: ran.status ?? 1, printed: ran.stdout };
				});
				const run = await f.site(1, f.signal, CHECKS.slice(0, 1));
				expect(run).toMatchObject(outcome);
				// What reaches anyone: the turn's words (land's, of the problem and the recipe's folder), the run's answer
				// (the report's site, the completion's code) and every log line.
				const words = run.state === "site_refused" ? codeSiteRefusedSummary(run.problem, RECIPE.folder) : "";
				const carried = [words, ...strings(run), ...strings(f.logged)];
				// No value, and no 8 bytes of one (review of #1691, F1: a cut detail carried a value's start).
				for (const value of [...Object.values(secrets), ...older])
					for (let at = 0; at + 8 <= value.length; at++)
						for (const text of carried) expect(text, value).not.toContain(value.slice(at, at + 8));
			});
		});

		describe("the turn's abort at each step: the command running stopped, the abort thrown on, and nothing after it", () => {
			const reason = new Error("CODING_EXECUTOR_LEASE_LOST");

			it("while the secrets' names are read", async () => {
				const f = await siteFixture({ secrets: { API_KEY: "value-of-the-api-key-1" } });
				const stop = new AbortController();
				const vault = f.vault.getMockImplementation()!;
				f.vault.mockImplementation(async (scope, signal) => {
					if (f.ran().length < 4) return vault(scope, signal);
					stop.abort(reason);
					return await SILENT("", signal).then(() => vault(scope, signal));
				});
				await expect(f.site(1, stop.signal)).rejects.toBe(reason);
				expect(f.kinds()).not.toContain("collect");
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});

			it("while the collect runs", async () => {
				const f = await siteFixture({ collect: { state: "running" } });
				const stop = new AbortController();
				const running = f.site(1, stop.signal);
				await vi.waitFor(() => expect(f.kinds()).toContain("collect"));
				stop.abort(reason);
				await expect(running).rejects.toBe(reason);
				expect(f.commands.get(f.idOf("collect"))?.state).toBe("cancelled");
				expect(f.steps()).toEqual(["started:collect"]);
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});

			it("while the boundary after the collect is asked", async () => {
				const stop = new AbortController();
				const f = await siteFixture({
					boundaryMs: 60_000,
					boundaries: [
						async (machine, signal) => {
							stop.abort(reason);
							return await CHECKING(machine, signal);
						},
					],
				});
				await expect(f.site(1, stop.signal)).rejects.toBe(reason);
				expect(f.steps()).toEqual(["started:collect", "ended:collect"]);
				expect(f.kinds()).not.toContain("drop");
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});

			it("as the boundary after the collect answers it held a secret value: no drop is started", async () => {
				const stop = new AbortController();
				const f = await siteFixture({
					boundaries: [
						async (machine, signal) => {
							stop.abort(reason);
							return await CARRIES(machine, signal);
						},
					],
				});
				await expect(f.site(1, stop.signal)).rejects.toBe(reason);
				expect(f.steps()).toEqual(["started:collect", "ended:collect", "boundary:carries"]);
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});

			it("while the drop runs", async () => {
				const f = await siteFixture({ boundaries: [CARRIES], drop: { state: "running" } });
				const stop = new AbortController();
				const running = f.site(1, stop.signal);
				await vi.waitFor(() => expect(f.kinds()).toContain("drop"));
				stop.abort(reason);
				await expect(running).rejects.toBe(reason);
				expect(f.commands.get(f.idOf("drop"))?.state).toBe("cancelled");
				expect(f.steps()).toEqual(["started:collect", "ended:collect", "boundary:carries", "started:drop"]);
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});

			it("while the boundary after the drop is asked", async () => {
				const stop = new AbortController();
				const f = await siteFixture({
					boundaries: [CARRIES],
					after: async (machine, signal) => {
						stop.abort(reason);
						return await SILENT(machine, signal);
					},
				});
				await expect(f.site(1, stop.signal)).rejects.toBe(reason);
				expect(f.steps().at(-1)).toBe("dropped:2");
				expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
			});
		});

		/** Step 3's paths of a command the host did not see end for certain (release review r1 and review rounds 4 to 6,
		 * F1), for the collect and for the drop: each is a command of the run under the same memories and rules. */
		describe.each(["collect", "drop"] as const)("the %s, as every command of the run", (kind) => {
			/** The first run's answer when the `kind` did not end as itself. */
			const lost =
				kind === "collect"
					? (code: string) => ({ state: "passed", site: { state: "missed", code } })
					: (_code: string) => ({ state: "site_refused", problem: SECRET_HELD });
			/** ...and when its start was never answered. */
			const unanswered = lost("UNCLASSIFIED");
			/** A fixture whose `kind` never ends by itself, past a budget: its stop is what the test says. */
			const stuck = async () =>
				siteFixture({
					budgetMs: 800,
					boundaries: [CARRIES],
					...(kind === "collect" ? { collect: { state: "running" } } : { drop: { state: "running" } }),
				});
			const cancels = () =>
				mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId);
			/** The guest takes every cancel of `commandId`, and it runs on. */
			const runsOn = (f: Awaited<ReturnType<typeof siteFixture>>, commandId: string) => {
				const cancel = mocked.guestCancel.getMockImplementation()!;
				mocked.guestCancel.mockImplementation(async (request: unknown) => {
					const asked = parseCodingGuestRequest("cancel", request);
					if (asked.commandId !== commandId) return cancel(request);
					return {
						schema: "qorpera.coding-guest-command/v1",
						workerId: f.claim.workerId,
						commandId,
						state: f.commands.get(commandId)?.state ?? "running",
						exit: null,
						end: 0,
					};
				});
			};
			/** When each guest call of `commandId` came, in the order of every mock's calls. */
			const orderOf = (mock: { mock: { calls: unknown[][]; invocationCallOrder: number[] } }, commandId: string) =>
				mock.mock.calls.flatMap(([request], at) =>
					(request as { commandId: string }).commandId === commandId
						? [mock.mock.invocationCallOrder[at] as number]
						: [],
				);
			/** The next run's copy (the fence) and its first check, by when the guest was asked to run them. */
			const fenced = (f: Awaited<ReturnType<typeof siteFixture>>, attempt: number) => {
				const [copy, check] = f.ran().filter((run) => run.environment.QORPERA_CHECKS_NAME === runName(1, attempt));
				return {
					copied: orderOf(mocked.guestRun, copy?.commandId as string)[0] as number,
					checked: orderOf(mocked.guestRun, check?.commandId as string)[0] as number,
				};
			};

			it("asks a cancel that is rejected again, and runs again in another folder once a read confirms its end", async () => {
				const f = await stuck();
				const cancel = mocked.guestCancel.getMockImplementation()!;
				mocked.guestCancel
					.mockRejectedValueOnce(new Error("LXD operation failed"))
					.mockRejectedValueOnce(new Error("LXD operation failed"))
					.mockImplementation(cancel);
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(lost("CODE_CHECKS_BUDGET"));
				const id = f.idOf(kind);
				expect(cancels()).toEqual([id, id, id]);
				expect(f.commands.get(id)?.state).toBe("cancelled");
				expect(f.logged).toContainEqual(
					expect.objectContaining({ step: "ended", site: kind, state: "not_run", stopped: true }),
				);
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
				expect(cancels()).toHaveLength(3);
			});

			it("reads a cancel that answers running again until it has ended", async () => {
				const f = await stuck();
				const cancel = mocked.guestCancel.getMockImplementation()!;
				mocked.guestCancel
					.mockImplementationOnce(async (request: unknown) => {
						const asked = parseCodingGuestRequest("cancel", request);
						return {
							schema: "qorpera.coding-guest-command/v1",
							workerId: f.claim.workerId,
							commandId: asked.commandId,
							state: "running",
							exit: null,
							end: 0,
						};
					})
					.mockImplementation(cancel);
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(lost("CODE_CHECKS_BUDGET"));
				expect(cancels()).toEqual([f.idOf(kind), f.idOf(kind)]);
				expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", site: kind, stopped: true }));
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
			});

			it("holds every later run, which touches no folder, while it has not stopped; and lets the next one run once it has ended", async () => {
				const f = await stuck();
				const id = f.idOf(kind);
				runsOn(f, id);
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(lost("CODE_CHECKS_BUDGET"));
				expect(f.logged).toContainEqual(expect.objectContaining({ step: "ended", site: kind, stopped: false }));
				const ran = f.ran().length;
				expect(await f.run(CHECKS.slice(0, 1), 2)).toEqual({
					state: "not_run",
					why: "machine",
					code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
				});
				expect(f.ran()).toHaveLength(ran);
				expect(f.logged).toContainEqual(
					expect.objectContaining({ step: "earlier", attempt: 2, commandId: id, end: "running" }),
				);
				(f.commands.get(id) as { state: CodingGuestCommandState }).state = "cancelled";
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 3)).toMatchObject({ state: "passed" });
				expect(f.logged).toContainEqual(
					expect.objectContaining({ step: "earlier", attempt: 3, commandId: id, end: "ended" }),
				);
			});

			it.each([true, false])(
				"looks again after the next run's fence at a start never answered that landed before it (it stops: %s)",
				async (stops) => {
					const f = await siteFixture({ boundaries: [CARRIES] });
					const id = f.idOf(kind);
					const run = mocked.guestRun.getMockImplementation()!;
					let late: CodingGuestRunRequest | undefined;
					mocked.guestRun.mockImplementation(async (request: unknown) => {
						const asked = parseCodingGuestRequest("run", request);
						if (asked.commandId !== id) return run(request);
						late = asked;
						throw new Error("LXD operation failed");
					});
					expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(unanswered);
					expect(f.logged).toContainEqual(
						expect.objectContaining({ step: "ended", site: kind, state: "not_run", stopped: true }),
					);
					// It lands now, before the next run made anything, and runs on as a server would.
					f.commands.set(id, {
						run: late as CodingGuestRunRequest,
						state: "running",
						exit: null,
						printed: Buffer.from(""),
						ending: { state: "running" },
						until: Number.POSITIVE_INFINITY,
					});
					if (!stops) runsOn(f, id);
					f.ending(() => ({}));
					const next = await f.run(CHECKS.slice(0, 1), 2);
					if (stops) {
						expect(next).toMatchObject({ state: "passed" });
						const { copied, checked } = fenced(f, 2);
						const looked = orderOf(mocked.guestCancel, id).filter((at) => at > copied);
						expect(looked.length).toBeGreaterThan(0);
						expect(Math.max(...looked)).toBeLessThan(checked);
						expect(f.commands.get(id)?.state).toBe("cancelled");
						expect(f.logged).toContainEqual(
							expect.objectContaining({ step: "looked", attempt: 2, commandId: id, end: "ended" }),
						);
					} else {
						expect(next).toEqual({
							state: "not_run",
							why: "machine",
							code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
						});
						expect(f.logged).toContainEqual(
							expect.objectContaining({ step: "looked", attempt: 2, commandId: id, end: "running" }),
						);
					}
				},
			);

			it.each([true, false])(
				"looks again after the retry's fence at a start never answered whose first stop timed out (review round 6's order; it stops: %s)",
				async (stops) => {
					const f = await siteFixture({ boundaries: [CARRIES] });
					const id = f.idOf(kind);
					const newer = runName(f.claim.sequence, 2);
					const run = mocked.guestRun.getMockImplementation()!,
						cancel = mocked.guestCancel.getMockImplementation()!;
					let late: CodingGuestRunRequest | undefined;
					let refuse = true;
					mocked.guestRun.mockImplementation(async (request: unknown) => {
						const asked = parseCodingGuestRequest("run", request);
						if (asked.commandId === id) {
							late = asked;
							throw new Error("LXD operation failed");
						}
						// The lost start lands now, before the retry's copy runs.
						if (
							asked.environment.QORPERA_CHECKS_NAME === newer &&
							kindOf(asked) === "copy" &&
							late &&
							!f.commands.has(id)
						)
							f.commands.set(id, {
								run: late,
								state: "running",
								exit: null,
								printed: Buffer.from(""),
								ending: { state: "running" },
								until: Number.POSITIVE_INFINITY,
							});
						return run(request);
					});
					mocked.guestCancel.mockImplementation(async (request: unknown) => {
						const asked = parseCodingGuestRequest("cancel", request);
						if (refuse && asked.commandId === id) throw new Error("LXD operation failed");
						if (!stops && asked.commandId === id && f.commands.get(id)?.state === "running")
							return {
								schema: "qorpera.coding-guest-command/v1",
								workerId: f.claim.workerId,
								commandId: id,
								state: "running",
								exit: null,
								end: 0,
							};
						return cancel(request);
					});
					expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(unanswered);
					// Its first stop could not be confirmed.
					expect(f.logged).toContainEqual(
						expect.objectContaining({ step: "ended", site: kind, state: "not_run", stopped: false }),
					);
					refuse = false;
					f.ending(() => ({}));
					const next = await f.run(CHECKS.slice(0, 1), 2);
					// The guard before the retry got the provisional `cancelled`: no longer held there.
					expect(f.logged).toContainEqual(
						expect.objectContaining({ step: "earlier", attempt: 2, commandId: id, end: "ended" }),
					);
					if (stops) {
						expect(next).toMatchObject({ state: "passed" });
						const { copied, checked } = fenced(f, 2);
						expect(f.loggedAt("looked", id).every((at) => at > copied && at < checked)).toBe(true);
						expect(f.loggedAt("looked", id)).toHaveLength(1);
						expect(f.commands.get(id)?.state).toBe("cancelled");
					} else {
						expect(next).toEqual({
							state: "not_run",
							why: "machine",
							code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
						});
						expect(
							f
								.ran()
								.filter((ran) => ran.environment.QORPERA_CHECKS_NAME === newer)
								.map(kindOf),
						).toEqual(["copy"]);
					}
				},
			);

			it("looks again after the next run's fence at one whose receipt ended it as unconfirmed", async () => {
				const f = await siteFixture({
					boundaries: [CARRIES],
					...(kind === "collect" ? { collect: { state: "lost" } } : { drop: { state: "lost" } }),
				});
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(lost("CODE_SITE_COLLECT_UNCONFIRMED"));
				const id = f.idOf(kind);
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
				const { copied, checked } = fenced(f, 2);
				const looked = f.loggedAt("looked", id);
				expect(looked).toHaveLength(1);
				expect([copied < (looked[0] as number), (looked[0] as number) < checked]).toEqual([true, true]);
			});

			it("looks again after the next run's fence at one the machine showed nothing of when it ended", async () => {
				const f = await siteFixture({ boundaries: [CARRIES] });
				let armed: number | undefined;
				const disk = mocked.disk.getMockImplementation()!;
				mocked.disk.mockImplementation(async (...args: unknown[]) => {
					if (armed !== undefined && ++armed >= 2) return "not a rebuild";
					return disk(...args);
				});
				const ending = (run: CodingGuestRunRequest) => {
					const which = kindOf(run);
					if (which === kind) armed = 0;
					if (which === "collect") return { printed: LINES };
					return which === "drop" ? { printed: "dropped 2\n" } : {};
				};
				f.ending(ending);
				expect(await f.site(1, f.signal, CHECKS.slice(0, 1))).toMatchObject(lost("CODE_CHECKS_UNCONFIRMED"));
				armed = undefined;
				const id = f.idOf(kind);
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
				const { copied, checked } = fenced(f, 2);
				const looked = f.loggedAt("looked", id);
				expect(looked).toHaveLength(1);
				expect([copied < (looked[0] as number), (looked[0] as number) < checked]).toEqual([true, true]);
			});

			it("believes it ended once the guest no longer has it, and the next run goes on", async () => {
				const f = await stuck();
				const id = f.idOf(kind);
				runsOn(f, id);
				await f.site(1, f.signal, CHECKS.slice(0, 1));
				// The machine lost it: the guest no longer knows it (the faked class is given its code).
				const unknown = () =>
					Object.assign(new CodingGuestRefused("CODING_GUEST_COMMAND_UNKNOWN"), {
						code: "CODING_GUEST_COMMAND_UNKNOWN",
					});
				mocked.guestCancel.mockRejectedValueOnce(unknown());
				mocked.guestOutput.mockRejectedValueOnce(unknown());
				f.ending(() => ({}));
				expect(await f.run(CHECKS.slice(0, 1), 2)).toMatchObject({ state: "passed" });
				expect(f.logged).toContainEqual(
					expect.objectContaining({ step: "earlier", attempt: 2, commandId: id, end: "lost" }),
				);
			});
		});
	});

	/** The scripts as the host hands them to the guest (from a run through the fixture), run for real with bash and git
	 * on this machine, in homes of the test's own; a repository's storage with one commit. */
	async function onTheMachine() {
		const f = await checksFixture();
		await f.run(CHECKS.slice(0, 1));
		const [copyRun, checkRun] = f.ran();
		const exec = promisify(execFile);
		const top = await realpath(await mkdtemp(join(tmpdir(), "code-checks-scripts-")));
		roots.push(top);
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: top,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.invalid",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.invalid",
		};
		const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env })).stdout.trim();
		const source = join(top, "source"),
			repository = join(top, "repo.git");
		await mkdir(source);
		await git(source, "init", "--quiet", "--initial-branch=main", ".");
		await writeFile(join(source, "app.js"), "app\n");
		await git(source, "add", "app.js");
		await git(source, "commit", "--quiet", "-m", "app");
		const commit = await git(source, "rev-parse", "HEAD");
		await git(top, "clone", "--quiet", "--bare", source, repository);
		/** One script with bash as the guest runs it: its exit code and what it printed. */
		const bash = async (script: string, given: Record<string, string>, cwd: string) => {
			try {
				const { stdout } = await exec("bash", ["--noprofile", "--norc", "-c", script], {
					cwd,
					env: { ...env, ...given },
				});
				return { code: 0, output: stdout };
			} catch (error) {
				const failed = error as { code?: number; stdout?: string; stderr?: string };
				return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
			}
		};
		/** A home of its own, its checks' root, and the session's own files beside it. */
		const home = async (label: string) => {
			const at = join(top, label);
			await mkdir(join(at, "qorpera-check"), { recursive: true });
			await writeFile(join(at, "qorpera-check", "keep.js"), "keep\n");
			await writeFile(join(at, "notes.md"), "keep\n");
			return { home: at, root: join(at, ".qorpera-checks") };
		};
		const copy = (at: { home: string; root: string }, name: string, extra: Record<string, string> = {}) =>
			bash(
				copyRun?.command as string,
				{
					HOME: at.home,
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: name,
					QORPERA_CHECKS_REPOSITORY: repository,
					QORPERA_CHECKS_COMMIT: commit,
					...extra,
				},
				at.home,
			);
		const check = (at: { home: string; root: string }, name: string, run: string) =>
			bash(
				checkRun?.command as string,
				{
					HOME: at.home,
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: name,
					QORPERA_CHECK_CWD: ".",
					QORPERA_CHECK_RUN: run,
					QORPERA_CHECK_LOG: join(at.root, name, "out", "1-test.log"),
				},
				join(at.root, name, "src"),
			);
		const exists = (path: string) =>
			lstat(path).then(
				() => true,
				() => false,
			);
		return {
			f,
			top,
			commit,
			git,
			bash,
			home,
			copy,
			check,
			exists,
			copyScript: copyRun?.command as string,
			checkScript: checkRun?.command as string,
		};
	}

	describe("the scripts on the machine: a run's own folder, and a command of a run that is not the newest does nothing", () => {
		it("a copy removes the run folders with a lower name, and no other entry, and makes its own", async () => {
			const m = await onTheMachine();
			const at = await m.home("home");
			const name = runName(7, 2);
			// Earlier runs (an earlier turn, an earlier attempt of this turn), entries that are not run folders (the layouts
			// before, a stray file, a name of another shape), and this run's own name holding something already.
			const earlier = [runName(6, 1), runName(7, 1)];
			for (const folder of [
				`${earlier[0]}/src/node_modules`,
				`${earlier[1]}/out`,
				"src/lib",
				"out",
				randomUUID(),
				name,
			])
				await mkdir(join(at.root, folder), { recursive: true });
			await writeFile(join(at.root, "stray.log"), "old\n");
			await writeFile(join(at.root, "12345-1"), "not a run's name\n");
			await writeFile(join(at.root, name, "left.txt"), "old\n");
			const others = (await readdir(at.root)).filter((entry) => !earlier.includes(entry) && entry !== name).sort();
			expect(await m.copy(at, name)).toEqual({ code: 0, output: "" });
			expect((await readdir(at.root)).sort()).toEqual([...others, name].sort());
			expect((await readdir(join(at.root, name))).sort()).toEqual(["out", "src"]);
			expect(await readdir(join(at.root, name, "out"))).toEqual([]);
			expect(await m.git(join(at.root, name, "src"), "rev-parse", "HEAD")).toBe(m.commit);
			expect(await readFile(join(at.home, "qorpera-check", "keep.js"), "utf8")).toBe("keep\n");
			expect(await readFile(join(at.home, "notes.md"), "utf8")).toBe("keep\n");
			// The next turn's run removes this run's folder, and still nothing else.
			const next = runName(8, 1);
			expect((await m.copy(at, next)).code).toBe(0);
			expect((await readdir(at.root)).sort()).toEqual([...others, next].sort());
			expect((await readdir(at.home)).sort()).toEqual([".qorpera-checks", "notes.md", "qorpera-check"]);
		});

		it("a copy of a run that is not the newest exits 91 and removes or makes nothing", async () => {
			const m = await onTheMachine();
			const at = await m.home("home");
			const older = runName(7, 1),
				newer = runName(7, 2),
				oldest = runName(6, 4);
			// The newer run's folder stands, with a check's file in it; an older run's folder too.
			await mkdir(join(at.root, newer, "src"), { recursive: true });
			await writeFile(join(at.root, newer, "src", "result.txt"), "the newer run's\n");
			await mkdir(join(at.root, oldest, "out"), { recursive: true });
			const before = (await readdir(at.root)).sort();
			const late = await m.copy(at, older);
			expect(late.code).toBe(91);
			expect((await readdir(at.root)).sort()).toEqual(before);
			expect(await m.exists(join(at.root, older))).toBe(false);
			expect(await readFile(join(at.root, newer, "src", "result.txt"), "utf8")).toBe("the newer run's\n");
			expect(await readdir(join(at.root, oldest))).toEqual(["out"]);
			// A later turn's name is higher whatever its attempt: the sequence comes first, both padded.
			expect((await m.copy(at, runName(10, 1))).code).toBe(0);
			expect(await readdir(at.root)).toEqual([runName(10, 1)]);
			expect((await m.copy(at, runName(9, 9))).code).toBe(91);
			expect(await readdir(at.root)).toEqual([runName(10, 1)]);
		});

		it("a check of a run that is not the newest exits 91 and runs nothing, though its folder stands", async () => {
			const m = await onTheMachine();
			const at = await m.home("home");
			const older = runName(3, 1),
				newer = runName(3, 2);
			for (const name of [older, newer]) await mkdir(join(at.root, name, "src"), { recursive: true });
			await mkdir(join(at.root, older, "out"), { recursive: true });
			const late = await m.check(at, older, "touch ran.txt; echo ran");
			expect(late.code).toBe(91);
			expect(await m.exists(join(at.root, older, "src", "ran.txt"))).toBe(false);
			expect(await m.exists(join(at.root, older, "out", "1-test.log"))).toBe(false);
			// The newest run's check runs, keeps its whole output, and ends with its command's own code.
			await mkdir(join(at.root, newer, "out"), { recursive: true });
			expect(await m.check(at, newer, "touch ran.txt; echo ran; exit 3")).toEqual({ code: 3, output: "ran\n" });
			expect(await m.exists(join(at.root, newer, "src", "ran.txt"))).toBe(true);
			expect(await readFile(join(at.root, newer, "out", "1-test.log"), "utf8")).toBe("ran\n");
		});

		/** A process of this user, started by the test with its working folder at `cwd`: a shell whose child listens on a
		 * TCP port of its own, as a check's test server does; or, without `listen`, one that only waits. */
		const started: ChildProcess[] = [];
		afterEach(() => {
			// Each helper is the leader of a process group of its own: the whole group goes, its server child too, also when
			// an assertion failed.
			for (const child of started.splice(0))
				try {
					if (child.pid) process.kill(-child.pid, "SIGKILL");
				} catch {
					/* gone already */
				}
		});
		const stale = async (cwd: string, listen = false) => {
			const server = listen
				? "require('net').createServer().listen(0, '127.0.0.1', function () { process.stdout.write(this.address().port + '\\n'); }); setInterval(() => {}, 1000);"
				: "setInterval(() => {}, 1000); process.stdout.write('0\\n');";
			const child = spawn("bash", ["--noprofile", "--norc", "-c", `"${process.execPath}" -e "${server}" & wait`], {
				cwd,
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			});
			started.push(child);
			const [line] = (await once(child.stdout as NonNullable<typeof child.stdout>, "data")) as [Buffer];
			return { child, port: Number(line.toString().trim()) };
		};
		const free = (port: number) =>
			new Promise<boolean>((resolve) => {
				const server = createServer();
				server.once("error", () => resolve(false));
				server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
			});
		const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

		it("a copy ends every process left in an earlier run's folder before it goes on, and no other process", async () => {
			const m = await onTheMachine();
			const at = await m.home("home");
			const older = runName(4, 1),
				gone = runName(4, 2),
				newer = runName(5, 1);
			for (const folder of [`${older}/src`, `${gone}/src`, newer])
				await mkdir(join(at.root, folder), { recursive: true });
			// A stale check of an earlier run: its shell and its test server, holding a port, started before the newer copy.
			const server = await stale(join(at.root, older, "src"), true);
			expect(await free(server.port)).toBe(false);
			// One whose working folder is an earlier run's folder itself, already gone ("<folder> (deleted)").
			const orphan = await stale(join(at.root, gone));
			await rm(join(at.root, gone), { recursive: true, force: true });
			// One in the newer run's own folder, and one elsewhere in the home: never touched.
			const own = await stale(join(at.root, newer));
			const elsewhere = await stale(join(at.home, "qorpera-check"));
			const ended = Promise.all([once(server.child, "exit"), once(orphan.child, "exit")]);
			expect(await m.copy(at, newer)).toEqual({ code: 0, output: "" });
			await ended;
			expect(await free(server.port)).toBe(true);
			expect([alive(own.child), alive(elsewhere.child)]).toEqual([true, true]);
			expect(await m.git(join(at.root, newer, "src"), "rev-parse", "HEAD")).toBe(m.commit);
			expect((await readdir(at.root)).sort()).toEqual([newer]);
		});

		it("a copy's folder stands from its first step on and is never made again: an earlier run's start that lands after it does nothing", async () => {
			const m = await onTheMachine();
			const at = await m.home("home");
			const older = runName(6, 1),
				newer = runName(6, 2);
			// An earlier run's folder with a process in it, so the copy ends a process, waits and removes the folder.
			await mkdir(join(at.root, older, "src"), { recursive: true });
			await stale(join(at.root, older, "src"));
			// Each tool the copy calls after its first step lands a check of the earlier run once (its start, late), and
			// says whether the newer run's folder stood then and which it was.
			const shims = join(m.top, "shims"),
				state = join(m.top, "state");
			await mkdir(shims);
			await mkdir(state);
			await writeFile(join(m.top, "check.sh"), m.checkScript);
			await writeFile(
				join(m.top, "hook.sh"),
				[
					"#!/bin/bash",
					'mark="$SHIM_STATE/seen-$1"',
					'[ -e "$mark" ] && exit 0',
					': > "$mark"',
					'd="$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME"',
					'if [ -d "$d" ]; then i="$(PATH=/usr/bin:/bin stat -c %i "$d")"; else i=none; fi',
					"c=0",
					'( cd "$SHIM_HOME" && PATH=/usr/bin:/bin QORPERA_CHECKS_NAME="$SHIM_OLDER" QORPERA_CHECK_CWD=. \\',
					'\tQORPERA_CHECK_RUN="touch $SHIM_STATE/ran-$1" QORPERA_CHECK_LOG="$SHIM_STATE/log-$1" \\',
					'\t/bin/bash --noprofile --norc "$SHIM_CHECK" ) >/dev/null 2>&1 || c=$?',
					'echo "$1 $i $c" >> "$SHIM_STATE/steps"',
				].join("\n"),
				{ mode: 0o755 },
			);
			for (const tool of ["find", "rm", "sleep", "git"])
				await writeFile(
					join(shims, tool),
					`#!/bin/bash\n"${join(m.top, "hook.sh")}" ${tool} >/dev/null 2>&1\nPATH=/usr/bin:/bin exec ${tool} "$@"\n`,
					{ mode: 0o755 },
				);
			const copied = await m.copy(at, newer, {
				PATH: `${shims}:/usr/bin:/bin`,
				SHIM_STATE: state,
				SHIM_HOME: at.home,
				SHIM_OLDER: older,
				SHIM_CHECK: join(m.top, "check.sh"),
			});
			expect(copied).toEqual({ code: 0, output: "" });
			const inode = (await lstat(join(at.root, newer))).ino;
			const steps = (await readFile(join(state, "steps"), "utf8")).trim().split("\n");
			// The ending of processes (find), its wait (sleep), the removal of the earlier folder and the emptying of its own
			// (rm), the copy itself (git): at each, the folder stood, the same one, and the late check exited 91.
			expect(steps.map((line) => line.split(" ")[0]).sort()).toEqual(["find", "git", "rm", "sleep"]);
			for (const line of steps) expect(line.split(" ").slice(1)).toEqual([String(inode), "91"]);
			expect((await readdir(state)).filter((entry) => entry.startsWith("ran-") || entry.startsWith("log-"))).toEqual(
				[],
			);
			expect((await readdir(join(at.root, newer))).sort()).toEqual(["out", "src"]);
			expect((await readdir(at.root)).sort()).toEqual([newer]);
			// A run's folder that is there already, with something in it, is kept and emptied, never made again.
			const again = runName(7, 1);
			await mkdir(join(at.root, again), { recursive: true });
			await writeFile(join(at.root, again, "left.txt"), "old\n");
			const kept = (await lstat(join(at.root, again))).ino;
			expect((await m.copy(at, again)).code).toBe(0);
			expect((await lstat(join(at.root, again))).ino).toBe(kept);
			expect((await readdir(join(at.root, again))).sort()).toEqual(["out", "src"]);
		});

		it("a copy takes a root that is a link away and removes nothing through it, and a folder it cannot remove never stops it", async () => {
			const m = await onTheMachine();
			const linked = await m.home("linked"),
				elsewhere = join(linked.home, "..", "elsewhere"),
				name = runName(2, 1);
			await mkdir(join(elsewhere, runName(1, 1)), { recursive: true });
			await writeFile(join(elsewhere, runName(1, 1), "keep.js"), "keep\n");
			await symlink(elsewhere, linked.root);
			expect((await m.copy(linked, name)).code).toBe(0);
			expect(await readFile(join(elsewhere, runName(1, 1), "keep.js"), "utf8")).toBe("keep\n");
			expect((await lstat(linked.root)).isDirectory()).toBe(true);
			expect(await readdir(linked.root)).toEqual([name]);
			expect(await m.exists(join(linked.root, name, "src", "app.js"))).toBe(true);
			// What an earlier run left that the session's user cannot remove stays, and the copy is made all the same.
			const at = await m.home("home");
			const locked = join(at.root, runName(1, 1), "cache");
			await mkdir(locked, { recursive: true });
			await writeFile(join(locked, "owned-by-a-container"), "x\n");
			await chmod(locked, 0o555);
			try {
				expect((await m.copy(at, name)).code).toBe(0);
				expect(await m.git(join(at.root, name, "src"), "rev-parse", "HEAD")).toBe(m.commit);
				expect((await readdir(at.root)).sort()).toEqual([runName(1, 1), name]);
			} finally {
				await chmod(locked, 0o755);
			}
		});
	});

	describe("parallel check execution (needs)", () => {
		const checkEventOrder = (logged: readonly Record<string, unknown>[], step: string, name: string) =>
			logged.findIndex((event) => event.event === "code-checks" && event.step === step && event.check === name);

		it("keeps legacy checks without needs strictly sequential", async () => {
			const f = await checksFixture();
			let active = 0;
			let peak = 0;
			const baseRun = mocked.guestRun.getMockImplementation()!;
			const baseOutput = mocked.guestOutput.getMockImplementation()!;
			const activeIds = new Set<string>();
			f.ending((run) => (checkOf(run) ? { after: 30 } : {}));
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const parsed = parseCodingGuestRequest("run", request);
				if (checkOf(parsed) && !activeIds.has(parsed.commandId)) {
					activeIds.add(parsed.commandId);
					active++;
					peak = Math.max(peak, active);
				}
				return baseRun(request);
			});
			mocked.guestOutput.mockImplementation(async (request: unknown) => {
				const page = await baseOutput(request);
				if (page.answer.state !== "running" && activeIds.delete(page.answer.commandId)) active--;
				return page;
			});
			const run = await f.run(CHECKS);
			expect(run).toMatchObject({ state: "passed" });
			expect(peak).toBe(1);
		});

		it("runs ready DAG checks concurrently, enforces dependencies, preserves file order, and collects site only after all pass", async () => {
			const f = await checksFixture();
			const TREE = "d".repeat(40);
			const RECIPE: CodeSiteRecipe = { folder: "dist", name: "shop", title: "The shop" };
			const dag: CodeCheck[] = [
				{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{ name: "typecheck", run: "npm run typecheck", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{ name: "test", run: "npm test", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{
					name: "build",
					run: "npm run build",
					timeoutSeconds: 300,
					cwd: ".",
					needs: ["lint", "typecheck", "test"],
				},
			];
			const parallelCommands = new Set(["npm run lint", "npm run typecheck", "npm test"]);
			const runningParallel = new Map<string, string>();
			let peakParallel = 0;
			let barrierReleased = false;
			f.ending((run) => {
				if (run.command === CODE_SITE_COLLECT) return { printed: `tree ${TREE}\nfiles 2\nbytes 1024\n` };
				const cmd = checkOf(run);
				if (cmd && parallelCommands.has(cmd)) return { state: "running" };
				return {};
			});
			const baseRun = mocked.guestRun.getMockImplementation()!;
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				const cmd = checkOf(parsed);
				if (cmd && parallelCommands.has(cmd)) {
					runningParallel.set(cmd, parsed.commandId);
					peakParallel = Math.max(peakParallel, runningParallel.size);
					if (runningParallel.size === 3 && !barrierReleased) {
						barrierReleased = true;
						const releaseOrder = ["npm test", "npm run typecheck", "npm run lint"];
						for (const [offset, name] of releaseOrder.entries()) {
							const entry = f.commands.get(runningParallel.get(name) as string);
							if (entry) {
								entry.ending = { code: 0 };
								entry.until = Date.now() + offset * 20;
							}
						}
					}
				}
				return result;
			});

			const run = await f.run(dag, 1, f.signal, RECIPE);
			expect(barrierReleased).toBe(true);
			expect(peakParallel).toBe(3);
			expect(run).toEqual({
				state: "passed",
				ms: expect.any(Number),
				copyMs: expect.any(Number),
				checks: dag.map(({ name, run: command }) => ({ name, run: command, ms: expect.any(Number) })),
				site: { state: "made", tree: TREE, files: 2, bytes: 1024, folder: "dist", name: "shop", title: "The shop" },
			});
			const installEnded = checkEventOrder(f.logged, "ended", "install");
			const buildStarted = checkEventOrder(f.logged, "started", "build");
			const buildEnded = checkEventOrder(f.logged, "ended", "build");
			const collectStarted = f.logged.findIndex((event) => event.step === "started" && event.site === "collect");
			for (const name of ["lint", "typecheck", "test"]) {
				expect(checkEventOrder(f.logged, "started", name)).toBeGreaterThan(installEnded);
				expect(checkEventOrder(f.logged, "ended", name)).toBeLessThan(buildStarted);
			}
			expect(collectStarted).toBeGreaterThan(buildEnded);
		});

		it("caps concurrent checks at four when more checks are ready at once", async () => {
			const f = await checksFixture();
			const checks: CodeCheck[] = Array.from({ length: 6 }, (_, index) => ({
				name: `job${index}`,
				run: `run-${index}`,
				timeoutSeconds: 60,
				cwd: ".",
				needs: [],
			}));
			const active = new Set<string>();
			let peak = 0;
			let reachedCap = false;
			f.ending((run) => (checkOf(run) ? { state: "running" } : {}));
			const baseRun = mocked.guestRun.getMockImplementation()!;
			const baseOutput = mocked.guestOutput.getMockImplementation()!;
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				if (checkOf(parsed)) {
					active.add(parsed.commandId);
					peak = Math.max(peak, active.size);
					if (active.size === 4) {
						reachedCap = true;
						for (const id of active) {
							const entry = f.commands.get(id);
							if (entry && entry.ending.state === "running") {
								entry.ending = { code: 0 };
								entry.until = Date.now();
							}
						}
					} else if (reachedCap) {
						const entry = f.commands.get(parsed.commandId);
						if (entry) {
							entry.ending = { code: 0 };
							entry.until = Date.now() + 15;
						}
					}
				}
				return result;
			});
			mocked.guestOutput.mockImplementation(async (request: unknown) => {
				const page = await baseOutput(request);
				if (page.answer.state !== "running") active.delete(page.answer.commandId);
				return page;
			});

			const run = await f.run(checks);
			expect(reachedCap).toBe(true);
			expect(peak).toBe(4);
			expect(run).toMatchObject({
				state: "passed",
				checks: checks.map(({ name, run: command }) => ({ name, run: command, ms: expect.any(Number) })),
			});
		});

		it("cancels in-flight siblings immediately on first failure, skips dependents and site, and reports accurate passed/notRun", async () => {
			const f = await checksFixture();
			const RECIPE: CodeSiteRecipe = { folder: "dist", name: "shop", title: "The shop" };
			const dag: CodeCheck[] = [
				{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{ name: "test", run: "npm test", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{ name: "build", run: "npm run build", timeoutSeconds: 300, cwd: ".", needs: ["lint", "test"] },
			];
			let lintId: string | undefined;
			let testId: string | undefined;
			let markSiblingCancelled: (() => void) | undefined;
			const siblingCancelled = new Promise<void>((resolve) => {
				markSiblingCancelled = resolve;
			});
			let cancelledBeforeTailReadFinished = false;
			f.ending((run) => {
				const cmd = checkOf(run);
				if (cmd === "npm run lint" || cmd === "npm test") return { state: "running" };
				return {};
			});
			const baseRun = mocked.guestRun.getMockImplementation()!;
			const baseCancel = mocked.guestCancel.getMockImplementation()!;
			const { LxdCodingFolderCommandTransport: RealTransport } = await vi.importActual<{
				LxdCodingFolderCommandTransport: typeof LxdCodingFolderCommandTransport;
			}>("../src/coding-folder-command-transport.ts");
			const baseRead = RealTransport.prototype.read;
			const readSpy = vi.spyOn(RealTransport.prototype, "read").mockImplementation(async function (
				this: LxdCodingFolderCommandTransport,
				scope,
				input,
				signal,
			) {
				if (input.commandId === lintId && input.limit === 16384) {
					await siblingCancelled;
					cancelledBeforeTailReadFinished = true;
				}
				return baseRead.call(this, scope, input, signal);
			});
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				const cmd = checkOf(parsed);
				if (cmd === "npm run lint") lintId = parsed.commandId;
				if (cmd === "npm test") testId = parsed.commandId;
				if (lintId && testId) {
					const lintEntry = f.commands.get(lintId);
					if (lintEntry && lintEntry.ending.state === "running") {
						lintEntry.printed = Buffer.from("src/a.ts:1 error\n");
						lintEntry.ending = { code: 1 };
						lintEntry.until = Date.now();
					}
				}
				return result;
			});
			mocked.guestCancel.mockImplementation(async (request: unknown) => {
				const parsed = parseCodingGuestRequest("cancel", request);
				const result = await baseCancel(request);
				if (parsed.commandId === testId) markSiblingCancelled?.();
				return result;
			});

			let run: Awaited<ReturnType<typeof f.run>>;
			try {
				run = await f.run(dag, 1, f.signal, RECIPE);
			} finally {
				readSpy.mockRestore();
			}
			expect(cancelledBeforeTailReadFinished).toBe(true);
			expect(run).toEqual({
				state: "failed",
				ms: expect.any(Number),
				passed: [{ name: "install", ms: expect.any(Number) }],
				failed: {
					name: "lint",
					run: "npm run lint",
					ms: expect.any(Number),
					exitCode: 1,
					atLimit: false,
					tail: "tail of: src/a.ts:1 error\n",
					log: "~/.qorpera-checks/0000000001-0001/out/2-lint.log",
				},
				notRun: ["test", "build"],
			});
			expect(testId).toBeDefined();
			expect(f.commands.get(testId as string)?.state).toBe("cancelled");
			expect(mocked.guestCancel.mock.calls.map(([request]) => (request as { commandId: string }).commandId)).toEqual(
				[testId],
			);
			expect(f.ran().map(checkOf)).not.toContain("npm run build");
			expect(f.ran().some((ran) => ran.command === CODE_SITE_COLLECT)).toBe(false);
		});

		it("reports the first failing check with its tail when two checks fail in the same poll", async () => {
			const f = await checksFixture();
			const dag: CodeCheck[] = [
				{ name: "lint", run: "npm run lint", timeoutSeconds: 60, cwd: ".", needs: [] },
				{ name: "test", run: "npm test", timeoutSeconds: 60, cwd: ".", needs: [] },
			];
			let lintId: string | undefined;
			let testId: string | undefined;
			let releasePollStart: (() => void) | undefined;
			const bothPollsStarted = new Promise<void>((resolve) => {
				releasePollStart = resolve;
			});
			let releasePollEnd: (() => void) | undefined;
			const bothPollsDone = new Promise<void>((resolve) => {
				releasePollEnd = resolve;
			});
			let releaseTestPoll: (() => void) | undefined;
			const testPollAfterLint = new Promise<void>((resolve) => {
				releaseTestPoll = resolve;
			});
			let markTestFinished: (() => void) | undefined;
			const testFinished = new Promise<void>((resolve) => {
				markTestFinished = resolve;
			});
			const pollsEntered = new Set<string>();
			const pollsCompleted = new Set<string>();
			let tailReadWaitedForTest = false;
			f.ending((run) => (checkOf(run) ? { state: "running" } : {}));
			const baseRun = mocked.guestRun.getMockImplementation()!;
			const { LxdCodingFolderCommandTransport: RealTransport } = await vi.importActual<{
				LxdCodingFolderCommandTransport: typeof LxdCodingFolderCommandTransport;
			}>("../src/coding-folder-command-transport.ts");
			const baseRead = RealTransport.prototype.read;
			const baseHidden = RealTransport.prototype.hidden;
			const readSpy = vi.spyOn(RealTransport.prototype, "read").mockImplementation(async function (
				this: LxdCodingFolderCommandTransport,
				scope,
				input,
				signal,
			) {
				if (input.commandId === lintId && input.limit === 16384) {
					releaseTestPoll?.();
					await testFinished;
					tailReadWaitedForTest = true;
				}
				if (input.limit === 4096 && (input.commandId === lintId || input.commandId === testId)) {
					pollsEntered.add(input.commandId);
					if (pollsEntered.size === 2 && lintId && testId) {
						const lintEntry = f.commands.get(lintId)!;
						const testEntry = f.commands.get(testId)!;
						lintEntry.printed = Buffer.from("lint failed line\n");
						lintEntry.ending = { code: 1 };
						lintEntry.until = Date.now();
						testEntry.printed = Buffer.from("test failed line\n");
						testEntry.ending = { code: 2 };
						testEntry.until = Date.now();
						releasePollStart?.();
					}
					await bothPollsStarted;
					const receipt = await baseRead.call(this, scope, input, signal);
					pollsCompleted.add(input.commandId);
					if (pollsCompleted.size === 2) releasePollEnd?.();
					await bothPollsDone;
					if (input.commandId === testId) await testPollAfterLint;
					return receipt;
				}
				return baseRead.call(this, scope, input, signal);
			});
			const hiddenSpy = vi.spyOn(RealTransport.prototype, "hidden").mockImplementation(async function (
				this: LxdCodingFolderCommandTransport,
				commandId,
				signal,
			) {
				const hidden = await baseHidden.call(this, commandId, signal);
				if (commandId === testId) setImmediate(() => markTestFinished?.());
				return hidden;
			});
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				const cmd = checkOf(parsed);
				if (cmd === "npm run lint") lintId = parsed.commandId;
				if (cmd === "npm test") testId = parsed.commandId;
				return result;
			});

			let run: Awaited<ReturnType<typeof f.run>>;
			try {
				run = await f.run(dag);
			} finally {
				readSpy.mockRestore();
				hiddenSpy.mockRestore();
			}
			expect(tailReadWaitedForTest).toBe(true);
			expect(run).toEqual({
				state: "failed",
				ms: expect.any(Number),
				passed: [],
				failed: {
					name: "lint",
					run: "npm run lint",
					ms: expect.any(Number),
					exitCode: 1,
					atLimit: false,
					tail: "tail of: lint failed line\n",
					log: "~/.qorpera-checks/0000000001-0001/out/1-lint.log",
				},
				notRun: ["test"],
			});
		});

		it("tracks every sibling whose cancellation could not be confirmed before allowing a later run", async () => {
			const f = await checksFixture({ stopMs: 60 });
			const dag: CodeCheck[] = [
				{ name: "lint", run: "npm run lint", timeoutSeconds: 60, cwd: ".", needs: [] },
				{ name: "typecheck", run: "npm run typecheck", timeoutSeconds: 60, cwd: ".", needs: [] },
				{ name: "test", run: "npm test", timeoutSeconds: 60, cwd: ".", needs: [] },
			];
			const ids = new Map<string, string>();
			f.ending((run) => (checkOf(run) ? { state: "running" } : {}));
			const baseRun = mocked.guestRun.getMockImplementation()!;
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				const cmd = checkOf(parsed);
				if (cmd) {
					ids.set(cmd, parsed.commandId);
					if (ids.size === 3) {
						const lint = f.commands.get(ids.get("npm run lint") as string);
						if (lint) {
							lint.ending = { code: 1 };
							lint.until = Date.now();
						}
					}
				}
				return result;
			});
			const baseCancel = mocked.guestCancel.getMockImplementation()!;
			const stuckIds = new Set<string>();
			mocked.guestCancel.mockImplementation(async (request: unknown) => {
				const asked = parseCodingGuestRequest("cancel", request);
				if (stuckIds.has(asked.commandId)) {
					return {
						schema: "qorpera.coding-guest-command/v1",
						workerId: f.claim.workerId,
						commandId: asked.commandId,
						state: "running",
						exit: null,
						end: 0,
					};
				}
				return baseCancel(request);
			});
			const typecheckId = codingHostId("checks", `${f.claim.workerId}:${f.claim.sequence}:1:2`);
			const testId = codingHostId("checks", `${f.claim.workerId}:${f.claim.sequence}:1:3`);
			stuckIds.add(typecheckId);
			stuckIds.add(testId);

			expect(await f.run(dag, 1)).toMatchObject({ state: "failed", failed: { name: "lint" } });
			expect(await f.run(dag.slice(0, 1), 2)).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
			});

			stuckIds.delete(typecheckId);
			expect(await f.run(dag.slice(0, 1), 3)).toEqual({
				state: "not_run",
				why: "machine",
				code: "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED",
			});

			stuckIds.delete(testId);
			f.ending(() => ({}));
			expect(await f.run(dag.slice(0, 1), 4)).toMatchObject({ state: "passed" });
		});

		it("cancels all in-flight parallel checks when the turn aborts and throws the turn reason", async () => {
			const f = await checksFixture();
			const dag: CodeCheck[] = [
				{ name: "lint", run: "npm run lint", timeoutSeconds: 60, cwd: ".", needs: [] },
				{ name: "test", run: "npm test", timeoutSeconds: 60, cwd: ".", needs: [] },
			];
			f.ending((run) => (checkOf(run) ? { state: "running" } : {}));
			const stop = new AbortController();
			const reason = new Error("CODING_EXECUTOR_LEASE_LOST");
			const running = f.run(dag, 1, stop.signal);
			await vi.waitFor(() => expect(f.ran()).toHaveLength(3));
			stop.abort(reason);
			await expect(running).rejects.toBe(reason);
			const [, lint, test] = f.ran();
			expect(f.commands.get(lint?.commandId as string)?.state).toBe("cancelled");
			expect(f.commands.get(test?.commandId as string)?.state).toBe("cancelled");
			expect(f.logged.filter((event) => event.step === "run")).toEqual([]);
		});

		it("runs a trailing CODE_CHECKS_DRILL strictly after all parallel checks pass, and skips it on earlier failure", async () => {
			const f = await checksFixture();
			const dag: CodeCheck[] = [
				{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
				{ name: "lint", run: "npm run lint", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				{ name: "test", run: "npm test", timeoutSeconds: 300, cwd: ".", needs: ["install"] },
				CODE_CHECKS_DRILL,
			];
			const seenParallel = new Set<string>();
			f.ending((run) => {
				const cmd = checkOf(run);
				if (cmd === CODE_CHECKS_DRILL.run)
					return { code: 1, printed: "A drill by Qorpera's operator: this check fails on purpose, once.\n" };
				if (cmd === "npm run lint" || cmd === "npm test") return { state: "running" };
				return {};
			});
			const baseRun = mocked.guestRun.getMockImplementation()!;
			mocked.guestRun.mockImplementation(async (request: unknown) => {
				const result = await baseRun(request);
				const parsed = parseCodingGuestRequest("run", request);
				const cmd = checkOf(parsed);
				if (cmd === "npm run lint" || cmd === "npm test") {
					seenParallel.add(parsed.commandId);
					if (seenParallel.size === 2) {
						for (const id of seenParallel) {
							const entry = f.commands.get(id);
							if (entry) {
								entry.ending = { code: 0 };
								entry.until = Date.now();
							}
						}
					}
				}
				return result;
			});

			const drilled = await f.run(dag, 1);
			expect(drilled).toMatchObject({
				state: "failed",
				passed: [
					{ name: "install", ms: expect.any(Number) },
					{ name: "lint", ms: expect.any(Number) },
					{ name: "test", ms: expect.any(Number) },
				],
				failed: { name: CODE_CHECKS_DRILL.name, exitCode: 1 },
				notRun: [],
			});
			const drillStarted = checkEventOrder(f.logged, "started", CODE_CHECKS_DRILL.name);
			expect(drillStarted).toBeGreaterThan(checkEventOrder(f.logged, "ended", "lint"));
			expect(drillStarted).toBeGreaterThan(checkEventOrder(f.logged, "ended", "test"));

			mocked.guestRun.mockImplementation(baseRun);
			f.ending((run) => (checkOf(run) === "npm run lint" ? { code: 1, printed: "lint failed\n" } : {}));
			const ownFailed = await f.run(dag, 2);
			expect(ownFailed).toMatchObject({
				state: "failed",
				failed: { name: "lint", exitCode: 1 },
			});
			expect(ownFailed.state === "failed" && ownFailed.notRun).toContain(CODE_CHECKS_DRILL.name);
		});

		it("polls fast checks with short initial backoff instead of waiting 3 s per check", async () => {
			const f = await checksFixture({ pollMs: null });
			f.ending((run) => (checkOf(run) ? { after: 80 } : {}));
			const started = performance.now();
			expect(await f.run(CHECKS.slice(0, 1))).toMatchObject({ state: "passed" });
			expect(performance.now() - started).toBeLessThan(1_500);
			const copy = f.ran()[0];
			expect(copy?.command).toContain("b=(0.1 0.2 0.5 1 2)");
			expect(copy?.command).not.toContain("sleep 3");
			const waitValues = mocked.guestOutput.mock.calls.map((call) => (call[0] as { waitMs?: number })?.waitMs);
			expect(waitValues).toContain(5000);
		});

		it("enforces exclusive, retries, failFast: false, maxParallel, per-check env, and per-check secrets allow-list", async () => {
			const f = await checksFixture({
				secrets: { ALLOWED_SECRET: "secret-allowed-111111", OTHER_SECRET: "secret-other-222222" },
			});
			let flakyAttempts = 0;
			const activeNames = new Set<string>();
			let exclusiveOverlapped = false;
			f.ending((run) => {
				const cmd = checkOf(run);
				if (!cmd) return {};
				if (cmd === "run-exclusive") {
					if (activeNames.size > 0) exclusiveOverlapped = true;
					activeNames.add("exclusive");
					return { after: 30 };
				}
				if (cmd === "run-flaky") {
					flakyAttempts++;
					return flakyAttempts === 1 ? { code: 1, printed: "transient error\n" } : { code: 0 };
				}
				return { after: 20 };
			});
			const baseOutput = mocked.guestOutput.getMockImplementation()!;
			mocked.guestOutput.mockImplementation(async (request: unknown) => {
				const res = await baseOutput(request);
				const asked = parseCodingGuestRequest("output", request);
				const found = f.commands.get(asked.commandId);
				if (found && res.answer.state !== "running" && checkOf(found.run) === "run-exclusive") {
					activeNames.delete("exclusive");
				}
				return res;
			});
			const checks: readonly CodeCheck[] = [
				{
					name: "excl",
					run: "run-exclusive",
					timeoutSeconds: 60,
					cwd: ".",
					needs: [],
					exclusive: true,
					env: { CUSTOM_FLAG: "yes" },
					secrets: ["ALLOWED_SECRET"],
				},
				{
					name: "flaky",
					run: "run-flaky",
					timeoutSeconds: 60,
					cwd: ".",
					needs: [],
					retries: 1,
					secrets: [],
				},
			];
			const passed = await f.session.runChecks!(
				{ commit: COMMIT, checks, attempt: 1, site: null, maxParallel: 6 },
				f.signal,
			);
			expect(passed.state).toBe("passed");
			expect(exclusiveOverlapped).toBe(false);
			expect(flakyAttempts).toBe(2);
			const exclRun = f.ran().find((r) => checkOf(r) === "run-exclusive");
			expect(exclRun?.environment.CUSTOM_FLAG).toBe("yes");
			expect(exclRun?.environment.ALLOWED_SECRET).toBe("secret-allowed-111111");
			expect(exclRun?.environment.OTHER_SECRET).toBeUndefined();
			const flakyRun = f.ran().find((r) => checkOf(r) === "run-flaky");
			expect(flakyRun?.environment.ALLOWED_SECRET).toBeUndefined();
			expect(flakyRun?.environment.OTHER_SECRET).toBeUndefined();

			mocked.guestOutput.mockImplementation(baseOutput);
			f.ending((run) => (checkOf(run) === "fail-left" ? { code: 1, printed: "left failed\n" } : {}));
			const noFailFast = await f.session.runChecks!(
				{
					commit: COMMIT,
					attempt: 2,
					site: null,
					failFast: false,
					checks: [
						{ name: "left", run: "fail-left", timeoutSeconds: 60, cwd: ".", needs: [] },
						{ name: "left-child", run: "after-left", timeoutSeconds: 60, cwd: ".", needs: ["left"] },
						{ name: "right", run: "pass-right", timeoutSeconds: 60, cwd: ".", needs: [] },
					],
				},
				f.signal,
			);
			expect(noFailFast).toMatchObject({
				state: "failed",
				passed: [{ name: "right", ms: expect.any(Number) }],
				failed: { name: "left", exitCode: 1 },
				notRun: ["left-child"],
			});
		});

		it("builds a preview as one check without the session's secrets and fails it with the end of its output", async () => {
			const f = await checksFixture({ secrets: { SHOP_KEY: "secret-shop-333333" } });
			f.ending((run) =>
				checkOf(run) === "npm run build" ? { code: 2, printed: "src/main.tsx: Cannot find module './App'\n" } : {},
			);
			const result = await f.host.buildPreview(
				f.claim,
				{
					buildId: randomUUID(),
					commitSha: COMMIT,
					treeSha: "d".repeat(40),
					recipe: { run: "npm run build", cwd: "web", folder: "dist", timeoutSeconds: 120 },
					attempt: 1,
				},
				f.signal,
			);
			expect(result.outcome).toBe("failed");
			const detail = result.outcome === "failed" ? result.errorDetail : "";
			expect(detail.split("\n")[0]).toBe("PREVIEW_BUILD_FAILED");
			expect(detail).toContain('The build "npm run build" in "web" exited with code 2');
			expect(detail).toContain("Cannot find module './App'");
			expect([...detail].length).toBeLessThanOrEqual(1000);
			const builds = f.ran().filter((run) => checkOf(run) !== undefined);
			expect(builds.map((run) => checkOf(run))).toEqual(["npm run build"]);
			expect(builds[0]?.environment.QORPERA_CHECK_CWD).toBe("web");
			expect(builds[0]?.environment.SHOP_KEY).toBeUndefined();
			expect(Object.values(builds[0]?.environment ?? {})).not.toContain("secret-shop-333333");
			const copyRun = f.ran().find((run) => run.environment.QORPERA_CHECKS_COMMIT === COMMIT);
			expect(copyRun?.environment.QORPERA_CHECKS_BLESSED_CACHES_BRANCH).toBe(f.claim.repository!.baseBranch);
			expect(copyRun?.environment.QORPERA_CHECKS_CACHE_ROOT).toContain(CODING_CHECK_CACHES.root);
			expect(copyRun?.environment.QORPERA_CHECKS_CACHES).toBeUndefined();
			expect(f.folderExecStream).not.toHaveBeenCalled();
		});

		it("never saves shared check caches even when buildPreview succeeds", async () => {
			const f = await checksFixture();
			const builtTree = "e".repeat(40);
			f.ending((run) => {
				if (run.environment.QORPERA_SITE_FOLDER) {
					return { code: 0, printed: `tree ${builtTree}\nfiles 1\nbytes 12\n` };
				}
				return { code: 0 };
			});
			const result = await f.host.buildPreview(
				f.claim,
				{
					buildId: randomUUID(),
					commitSha: COMMIT,
					treeSha: "d".repeat(40),
					recipe: { run: "npm run build", cwd: ".", folder: "dist", timeoutSeconds: 120 },
					attempt: 1,
				},
				f.signal,
			);
			expect(result).toEqual({ outcome: "built", builtTreeSha: builtTree });
			const copyRun = f.ran().find((run) => run.environment.QORPERA_CHECKS_COMMIT === COMMIT);
			expect(copyRun?.environment.QORPERA_CHECKS_BLESSED_CACHES_BRANCH).toBe(f.claim.repository!.baseBranch);
			expect(copyRun?.environment.QORPERA_CHECKS_CACHE_ROOT).toContain(CODING_CHECK_CACHES.root);
			expect(copyRun?.environment.QORPERA_CHECKS_CACHES).toBeUndefined();
			expect(f.folderExecStream).not.toHaveBeenCalled();
		});

		it("applies incremental path filters, runs downstream checks whose needs were skipped, and bypasses when checks file changed", async () => {
			const f = await checksFixture();
			const checks: readonly CodeCheck[] = [
				{ name: "web-build", run: "build-web", timeoutSeconds: 60, cwd: ".", needs: [], paths: ["web/**"] },
				{
					name: "api-test",
					run: "test-api",
					timeoutSeconds: 60,
					cwd: ".",
					needs: ["web-build"],
					paths: ["api/**"],
				},
				{
					name: "always",
					run: "smoke",
					timeoutSeconds: 60,
					cwd: ".",
					needs: [],
					paths: ["web/**"],
					alwaysRun: true,
				},
			];
			const filtered = await f.session.runChecks!(
				{ commit: COMMIT, checks, attempt: 1, site: null, changedPaths: ["api/server.ts"], checksChanged: false },
				f.signal,
			);
			expect(filtered).toMatchObject({
				state: "passed",
				checks: [
					{ name: "web-build", ms: 0, skipped: "paths_unmatched" },
					{ name: "api-test", ms: expect.any(Number) },
					{ name: "always", ms: expect.any(Number) },
				],
			});
			expect(f.ran().map(checkOf)).not.toContain("build-web");
			expect(f.ran().map(checkOf)).toContain("test-api");
			expect(f.ran().map(checkOf)).toContain("smoke");

			const bypassed = await f.session.runChecks!(
				{ commit: COMMIT, checks, attempt: 2, site: null, changedPaths: ["api/server.ts"], checksChanged: true },
				f.signal,
			);
			expect(bypassed.state).toBe("passed");
			expect(f.ran().map(checkOf)).toContain("build-web");

			f.ending((run) => {
				if (run.environment.QORPERA_CHECKS_BASE_BRANCH) {
					return { code: 0, printed: 'QORPERA_DIFF_OK\nweb/a"b".html\0' };
				}
				return {};
			});
			const diffed = await f.session.runChecks!(
				{ commit: COMMIT, checks, attempt: 3, site: null, checksChanged: false },
				f.signal,
			);
			expect(diffed).toMatchObject({
				state: "passed",
				checks: [
					{ name: "web-build", ms: expect.any(Number) },
					{ name: "api-test", ms: 0, skipped: "paths_unmatched" },
					{ name: "always", ms: expect.any(Number) },
				],
			});

			f.ending((run) => {
				if (run.environment.QORPERA_CHECKS_BASE_BRANCH) {
					return { code: 0, printed: "QORPERA_DIFF_OK\ntruncated-without-nul" };
				}
				return {};
			});
			const truncatedDiff = await f.session.runChecks!(
				{ commit: COMMIT, checks, attempt: 4, site: null, checksChanged: false },
				f.signal,
			);
			expect(truncatedDiff).toMatchObject({
				state: "passed",
				checks: [
					{ name: "web-build", ms: expect.any(Number) },
					{ name: "api-test", ms: expect.any(Number) },
					{ name: "always", ms: expect.any(Number) },
				],
			});
		});

		it("persists caches only on passing landing runs via host-owned root exec and parses structured failure artifacts with boundary protection", async () => {
			const f = await checksFixture({ packageCaches: true });
			const caches = [
				{ key: `deps-\${hash('package-lock.json')}`, paths: ["node_modules"], restoreKeys: ["deps-"] },
			];
			const failingChecks: readonly CodeCheck[] = [
				{
					name: "unit",
					run: "vitest run",
					timeoutSeconds: 60,
					cwd: ".",
					artifacts: { paths: ["reports/junit.xml"], when: "on_failure", format: "junit" },
				},
			];
			f.ending((run) => {
				if (checkOf(run) === "vitest run") return { code: 1, printed: "1 failed\n" };
				if (run.environment.QORPERA_CHECKS_PERSIST_DIR) {
					const nonce = run.environment.QORPERA_CHECKS_ARTIFACT_NONCE;
					const rel = run.environment.QORPERA_CHECKS_PERSIST_REL;
					return {
						code: 0,
						printed: [
							`QORPERA_ARTIFACT_BEGIN:${nonce}:junit`,
							'<testsuite name="auth"><testcase name="rejects"><failure message="bad status"/></testcase></testsuite>',
							`QORPERA_ARTIFACT_END:${nonce}`,
							`QORPERA_PERSISTED:${nonce}:${JSON.stringify({ dir: rel, log: `${rel}/1-unit.log`, files: 2, bytes: 120 })}`,
						].join("\n"),
					};
				}
				return {};
			});
			const failed = await f.session.runChecks!(
				{ commit: COMMIT, checks: failingChecks, attempt: 1, site: null, caches },
				f.signal,
			);
			expect(failed).toMatchObject({
				state: "failed",
				failed: {
					name: "unit",
					persistedLog: expect.stringContaining("_check-runs/"),
					artifactsDir: expect.stringContaining("_check-runs/"),
					failedTests: [{ suite: "auth", name: "rejects", message: "bad status" }],
				},
			});
			const persistCall = f.ran().find((r) => Boolean(r.environment.QORPERA_CHECKS_PERSIST_DIR));
			expect(persistCall?.environment.QORPERA_CHECKS_PERSIST_KEEP_RUNS).toBe("20");
			expect(f.ran().some((r) => Boolean(r.environment.QORPERA_CHECKS_CACHE_GLOBAL_ROOT))).toBe(false);
			expect(f.folderExecStream).not.toHaveBeenCalled();

			f.ending((run) => {
				if (run.environment.QORPERA_CHECKS_TRACKED_NONCE) {
					return {
						code: 0,
						printed: `QORPERA_CACHE_UNTRACKED:${run.environment.QORPERA_CHECKS_TRACKED_NONCE}:["node_modules"]\n`,
					};
				}
				return { code: 0 };
			});
			const passed = await f.session.runChecks!(
				{ commit: COMMIT, checks: failingChecks, attempt: 2, site: null, caches },
				f.signal,
			);
			expect(passed.state).toBe("passed");
			expect(f.ran().some((r) => Boolean(r.environment.QORPERA_CHECKS_CACHE_GLOBAL_ROOT))).toBe(false);
			expect(f.folderExecStream).toHaveBeenCalledTimes(1);
			const saveCall = f.folderExecStream.mock.calls[0]?.[2];
			expect(saveCall?.command).toContain("QORPERA_CHECKS_CACHE_GLOBAL_ROOT=/var/cache/qorpera-check-caches");
			expect(saveCall?.command.some((arg) => /^QORPERA_CHECKS_UID=\d+$/.test(arg))).toBe(true);
			expect(saveCall?.command.some((arg) => /^QORPERA_CHECKS_GID=\d+$/.test(arg))).toBe(true);
			expect(saveCall?.stdin.toString("utf8")).toContain("QORPERA_CACHE_SAVE_EOF");
			const passCopy = f
				.ran()
				.find(
					(r) =>
						r.environment.QORPERA_CHECKS_NAME === runName(1, 2) && Boolean(r.environment.QORPERA_CHECKS_COMMIT),
				);
			expect(passCopy?.environment.QORPERA_CHECKS_CACHES).toBe(JSON.stringify(caches));
		});

		it("executes real diff, cache-tracked, cache-save, copy cache-restore, persist, and persist-drop scripts with bash, git, and python3 including hostile fsmonitor and symlink parent attacks", async () => {
			const m = await onTheMachine();
			const at = await m.home("v2");
			const f = await checksFixture({ packageCaches: true });
			const caches = [
				{
					key: `deps-\${hash('app.js')}`,
					paths: ["node_modules", "app.js", "badparent/secret.txt"],
					restoreKeys: ["deps-"],
				},
			];
			f.ending((run) => {
				if (run.environment.QORPERA_CHECKS_BASE_BRANCH) return { code: 0, printed: "QORPERA_DIFF_OK\napp.js\0" };
				if (checkOf(run) === "fail-cmd") return { code: 1, printed: "fail\n" };
				if (run.environment.QORPERA_CHECKS_PERSIST_DIR) {
					const nonce = run.environment.QORPERA_CHECKS_ARTIFACT_NONCE;
					const rel = run.environment.QORPERA_CHECKS_PERSIST_REL;
					return {
						code: 0,
						printed: `QORPERA_PERSISTED:${nonce}:${JSON.stringify({ dir: rel, log: `${rel}/1-u.log`, files: 1, bytes: 10 })}\n`,
					};
				}
				return {};
			});
			const defaultBoundary = f.boundary.getMockImplementation()!;
			f.boundary.mockResolvedValue({
				machine: f.machine.machineId,
				reads: "released",
				views: [{ viewId: f.viewId, unsaved: 1, refused: "carries" }],
			});
			await f.session.runChecks!(
				{
					commit: COMMIT,
					checks: [
						{
							name: "u",
							run: "fail-cmd",
							timeoutSeconds: 60,
							cwd: ".",
							paths: ["app.js"],
							artifacts: { paths: ["junit.xml"], when: "on_failure", format: "junit" },
						},
					],
					attempt: 1,
					site: null,
					checksChanged: false,
				},
				f.signal,
			);
			f.boundary.mockImplementation(defaultBoundary);
			const diffScript = f.ran().find((r) => Boolean(r.environment.QORPERA_CHECKS_BASE_BRANCH))?.command as string;
			const persistScript = f.ran().find((r) => Boolean(r.environment.QORPERA_CHECKS_PERSIST_SPEC))
				?.command as string;
			const persistDropScript = f
				.ran()
				.find(
					(r) => Boolean(r.environment.QORPERA_CHECKS_PERSIST_DIR) && !r.environment.QORPERA_CHECKS_PERSIST_SPEC,
				)?.command as string;
			expect(diffScript).toContain("QORPERA_DIFF_OK");
			expect(persistScript).toContain("QORPERA_PERSIST_EOF");
			expect(persistDropScript).toContain("QORPERA_CHECKS_PERSIST_DIR");
			f.ending((run) => {
				if (run.environment.QORPERA_CHECKS_TRACKED_NONCE) {
					return {
						code: 0,
						printed: `QORPERA_CACHE_UNTRACKED:${run.environment.QORPERA_CHECKS_TRACKED_NONCE}:["node_modules","badparent/secret.txt"]\n`,
					};
				}
				return { code: 0 };
			});
			await f.session.runChecks!(
				{
					commit: COMMIT,
					checks: [{ name: "u", run: "ok", timeoutSeconds: 60, cwd: "." }],
					attempt: 2,
					site: null,
					caches,
				},
				f.signal,
			);
			const cacheTrackedScript = f.ran().find((r) => Boolean(r.environment.QORPERA_CHECKS_TRACKED_NONCE))
				?.command as string;
			const cacheSaveScript = f.folderExecStream.mock.calls[0]?.[2].stdin.toString("utf8") as string;
			expect(cacheTrackedScript).toContain("QORPERA_CACHE_TRACKED_EOF");
			expect(cacheSaveScript).toContain("QORPERA_CACHE_SAVE_EOF");

			const source = join(m.top, "source");
			const repo = join(m.top, "repo.git");
			await mkdir(join(source, "web"), { recursive: true });
			await writeFile(join(source, 'web/a"b".html'), "<p>hi</p>\n");
			await m.git(source, "add", 'web/a"b".html');
			await m.git(source, "commit", "--quiet", "-m", "quoted file");
			const commit2 = await m.git(source, "rev-parse", "HEAD");
			await m.git(source, "push", "--quiet", repo, "HEAD:refs/heads/candidate");

			const run1 = runName(1, 1);
			expect(await m.copy(at, run1, { QORPERA_CHECKS_COMMIT: commit2 })).toEqual({ code: 0, output: "" });
			const diffOut = await m.bash(
				diffScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run1,
					QORPERA_CHECKS_REPOSITORY: repo,
					QORPERA_CHECKS_BASE_BRANCH: "main",
					QORPERA_CHECKS_COMMIT: commit2,
				},
				at.home,
			);
			expect(diffOut).toEqual({ code: 0, output: 'QORPERA_DIFF_OK\nweb/a"b".html\0' });

			const globalCache = join(m.top, "check-caches");
			const repoCache = join(globalCache, "repo-1");
			const outsideDir = join(m.top, "outside-secret");
			const fsmonitorSentinel = join(m.top, "fsmonitor-ran");
			await mkdir(globalCache, { recursive: true, mode: 0o755 });
			await mkdir(outsideDir, { recursive: true });
			await writeFile(join(outsideDir, "secret.txt"), "root-secret\n");
			const src1 = join(at.root, run1, "src");
			await mkdir(join(src1, "node_modules", ".bin"), { recursive: true });
			await writeFile(join(src1, "node_modules", "cached.txt"), "from-cache\n");
			await symlink("../cached.txt", join(src1, "node_modules", ".bin", "tool"));
			await symlink(join(outsideDir, "secret.txt"), join(src1, "node_modules", "escape"));
			await symlink(outsideDir, join(src1, "badparent"));
			await writeFile(join(src1, "app.js"), "tampered-working-copy\n");
			await m.git(src1, "config", "core.fsmonitor", `touch ${fsmonitorSentinel}`);

			const trackedNonce = "11223344556677889900aabb";
			const trackedRes = await m.bash(
				cacheTrackedScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run1,
					QORPERA_CHECKS_REPOSITORY: repo,
					QORPERA_CHECKS_COMMIT: commit2,
					QORPERA_CHECKS_CACHE_PATHS: JSON.stringify(["node_modules", "app.js", "badparent/secret.txt"]),
					QORPERA_CHECKS_TRACKED_NONCE: trackedNonce,
				},
				at.home,
			);
			expect(trackedRes.code).toBe(0);
			const trackedPrefix = `QORPERA_CACHE_UNTRACKED:${trackedNonce}:`;
			const untrackedList = JSON.parse(trackedRes.output.trim().slice(trackedPrefix.length)) as string[];
			expect(untrackedList).toEqual(["node_modules", "badparent/secret.txt"]);
			expect(await m.exists(fsmonitorSentinel)).toBe(false);

			const filteredCaches = [{ key: `deps-\${hash('app.js')}`, paths: untrackedList, restoreKeys: ["deps-"] }];
			const saveRes = await m.bash(
				cacheSaveScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run1,
					QORPERA_CHECKS_CACHES: JSON.stringify(filteredCaches),
					QORPERA_CHECKS_CACHE_ROOT: repoCache,
					QORPERA_CHECKS_CACHE_GLOBAL_ROOT: globalCache,
					QORPERA_CHECKS_CACHE_LIMIT_BYTES: String(100 * 1024 * 1024),
				},
				at.home,
			);
			expect(saveRes.code).toBe(0);
			expect(await m.exists(fsmonitorSentinel)).toBe(false);
			const savedKeys = await readdir(repoCache);
			expect(savedKeys).toHaveLength(1);
			const savedEntry = join(repoCache, savedKeys[0] as string);
			expect(await readFile(join(savedEntry, "data", "node_modules", "cached.txt"), "utf8")).toBe("from-cache\n");
			expect((await lstat(join(savedEntry, "data", "node_modules", ".bin", "tool"))).isSymbolicLink()).toBe(true);
			expect(await m.exists(join(savedEntry, "data", "node_modules", "escape"))).toBe(false);
			expect(await m.exists(join(savedEntry, "data", "badparent"))).toBe(false);
			expect(await m.exists(join(savedEntry, "data", "app.js"))).toBe(false);
			expect((await lstat(savedEntry)).mode & 0o777).toBe(0o755);
			expect((await lstat(join(savedEntry, "data", "node_modules", "cached.txt"))).mode & 0o777).toBe(0o644);

			await writeFile(join(savedEntry, "data", "app.js"), "poisoned-app\n");
			const run2 = runName(1, 2);
			expect(
				await m.copy(at, run2, {
					QORPERA_CHECKS_COMMIT: commit2,
					QORPERA_CHECKS_CACHES: JSON.stringify(caches),
					QORPERA_CHECKS_CACHE_ROOT: repoCache,
				}),
			).toEqual({ code: 0, output: "" });
			expect(await readFile(join(at.root, run2, "src", "node_modules", "cached.txt"), "utf8")).toBe("from-cache\n");
			expect(await readFile(join(at.root, run2, "src", "app.js"), "utf8")).toBe("app\n");
			expect(await m.exists(fsmonitorSentinel)).toBe(false);

			const oldRepoEntry = join(globalCache, "repo-old", "old-key");
			await mkdir(join(oldRepoEntry, "data"), { recursive: true });
			await writeFile(join(oldRepoEntry, "data", "big.bin"), Buffer.alloc(128 * 1024, 0x41));
			await writeFile(join(oldRepoEntry, ".complete"), "");
			await writeFile(join(oldRepoEntry, ".last-used"), "");
			const oldTime = new Date("2020-01-01T00:00:00Z");
			await utimes(join(oldRepoEntry, ".last-used"), oldTime, oldTime);
			const lruRes = await m.bash(
				cacheSaveScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run2,
					QORPERA_CHECKS_CACHES: JSON.stringify(filteredCaches),
					QORPERA_CHECKS_CACHE_ROOT: repoCache,
					QORPERA_CHECKS_CACHE_GLOBAL_ROOT: globalCache,
					QORPERA_CHECKS_CACHE_LIMIT_BYTES: "4096",
				},
				at.home,
			);
			expect(lruRes.code).toBe(0);
			expect(await m.exists(oldRepoEntry)).toBe(false);

			const runsRoot = join(m.top, "_check-runs");
			await mkdir(join(runsRoot, "0000000001-old"), { recursive: true });
			await mkdir(join(runsRoot, "0000000002-old"), { recursive: true });
			await utimes(join(runsRoot, "0000000001-old"), oldTime, oldTime);
			await utimes(
				join(runsRoot, "0000000002-old"),
				new Date("2021-01-01T00:00:00Z"),
				new Date("2021-01-01T00:00:00Z"),
			);
			const src2 = join(at.root, run2, "src");
			const log2 = join(at.root, run2, "out", "1-u.log");
			await writeFile(log2, "token=super-secret-value-9999\n");
			await writeFile(
				join(src2, "junit.xml"),
				'<testsuite name="api"><testcase name="works"><failure message="leak super-secret-value-9999"/></testcase></testsuite>\n',
			);
			const pdir = join(runsRoot, `${run2}-deadbeef`);
			const nonce = "a1b2c3d4e5f6a1b2c3d4e5f6";
			const persistOut = await m.bash(
				persistScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run2,
					QORPERA_CHECKS_PERSIST_DIR: pdir,
					QORPERA_CHECKS_PERSIST_REL: `code/acme/shop/_check-runs/${run2}-deadbeef`,
					QORPERA_CHECKS_PERSIST_SPEC: JSON.stringify({
						logs: [{ src: log2, name: "1-u.log" }],
						artifacts: [{ check: "u", format: "junit", paths: ["junit.xml"], extract: true }],
					}),
					QORPERA_CHECKS_PERSIST_KEEP_RUNS: "2",
					QORPERA_CHECKS_ARTIFACT_NONCE: nonce,
					QORPERA_CHECKS_SECRET_NAMES: "SECRET_VAL",
					SECRET_VAL: "super-secret-value-9999",
				},
				src2,
			);
			expect(persistOut.code).toBe(0);
			expect(persistOut.output).not.toContain("super-secret-value-9999");
			expect(persistOut.output).toContain(`QORPERA_ARTIFACT_BEGIN:${nonce}:junit`);
			expect(persistOut.output).toContain(`QORPERA_PERSISTED:${nonce}:`);
			expect(await readFile(join(pdir, "1-u.log"), "utf8")).toBe("token=***\n");
			expect(await readFile(join(pdir, "artifacts", "u", "junit.xml"), "utf8")).toContain("leak ***");
			expect((await readdir(runsRoot)).sort()).toEqual([`${run2}-deadbeef`, "0000000002-old"].sort());

			const dropOut = await m.bash(
				persistDropScript,
				{
					QORPERA_CHECKS_ROOT: at.root,
					QORPERA_CHECKS_NAME: run2,
					QORPERA_CHECKS_PERSIST_DIR: pdir,
				},
				src2,
			);
			expect(dropOut.code).toBe(0);
			expect(await m.exists(pdir)).toBe(false);
		});
	});
});

describe("coding machine load reporting and horizontal overflow (step 5k)", () => {
	it("includes qorpera_record_coding_machine_load in CODING_HOST_RPCS, excludes reclaimable file cache via memory.stat, and reports fullness hints on the folder model", async () => {
		expect(CODING_HOST_RPCS).toContain("qorpera_record_coding_machine_load");
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const worker32 = f.claim.workerId.replaceAll("-", "");
		const slicePath = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${worker32}.slice/memory.stat`;
		const folderServicePath = `/sys/fs/cgroup/system.slice/qorpera-folder-${worker32}.service/memory.stat`;
		const userPath = "/sys/fs/cgroup/user.slice/user-200000.slice/memory.stat";
		const setFile = (path: string, text: string) =>
			f.files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(text) });
		setFile(
			slicePath,
			[
				"anon 536870912",
				"file 6442450944",
				"kernel 8388608",
				"shmem 16777216",
				"inactive_file 6000000000",
				"active_file 442450944",
				"",
			].join("\n"),
		);
		setFile(folderServicePath, ["anon 67108864", "file 536870912", "kernel 2097152", "shmem 1048576", ""].join("\n"));
		setFile(
			userPath,
			["anon 134217728", "file 2147483648", "kernel 4194304", "shmem 0", "inactive_file 2147483648", ""].join("\n"),
		);
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   4194304 kB\n");
		const expectedWorkingSet =
			536_870_912 + 8_388_608 + 16_777_216 + 67_108_864 + 2_097_152 + 1_048_576 + 134_217_728 + 4_194_304;
		vi.mocked(f.client.readInstanceFile).mockClear();
		vi.mocked(f.client.readCodingMachineMemory).mockClear();
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 600_000, cpuUsageUsec: 1_000_000 }));
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.client.readCodingMachineMemory).toHaveBeenCalledTimes(1);
		expect(f.client.readCodingMachineMemory).toHaveBeenCalledWith(
			f.machine.project,
			f.plan.request.name,
			[
				slicePath,
				`/sys/fs/cgroup/qorpera-folder.slice/qorpera-folder-${worker32}.service/memory.stat`,
				folderServicePath,
				userPath,
			],
			expect.any(AbortSignal),
		);
		expect(
			vi
				.mocked(f.client.readInstanceFile)
				.mock.calls.some(([, , path]) => path === "/proc/meminfo" || path.startsWith("/sys/fs/cgroup/")),
		).toBe(false);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toEqual({
			p_machine_id: f.machine.machineId,
			p_owner: "coding-host",
			p_binding_text: f.plan.text,
			p_machine_id_sha256: "f".repeat(64),
			p_load: {
				schema: "qorpera.coding-machine-load/v1",
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: expectedWorkingSet }],
			},
		});
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 610_000, cpuUsageUsec: 1_000_000 + 35_000_000 }));
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				schema: "qorpera.coding-machine-load/v1",
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 3500, memoryBytes: expectedWorkingSet }],
			},
		});
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 620_000, cpuUsageUsec: 36_000_000 + 35_000_000 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 3500, memoryBytes: expectedWorkingSet }],
			},
		});
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 630_000, cpuUsageUsec: 71_000_000 + 35_000_000 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				schema: "qorpera.coding-machine-load/v1",
				full: true,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 3500, memoryBytes: expectedWorkingSet }],
			},
		});
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   800000 kB\n");
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 640_000, cpuUsageUsec: 106_000_000 }));
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: true,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: expectedWorkingSet }],
			},
		});
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   6000000 kB\n");
		setFile(slicePath, "anon 6871947674\nfile 1048576\nkernel 0\nshmem 0\n");
		setFile(folderServicePath, "anon 0\nfile 1048576\n");
		setFile(userPath, "anon 0\nfile 4294967296\n");
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 650_000, cpuUsageUsec: 106_000_000 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: true,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: 6_871_947_674 }],
			},
		});
		setFile(slicePath, "anon 1048576\nfile 6442450944\n");
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 660_000, cpuUsageUsec: 106_000_000 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: 1_048_576 }],
			},
		});
	});

	it("excludes released sessions from load reports and keeps renewing when memory read or load RPC fails", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		f.state.release.set(second.workerId, "ARCHIVED");
		f.state.listed = [f.entry()];
		const releasingSlice = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${second.workerId.replaceAll("-", "")}.slice/memory.stat`;
		f.files.set(releasingSlice, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from("anon 8000000000\n") });
		expect(await pass(f)).toEqual(
			expect.arrayContaining([
				{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
				{
					machineId: f.machine.machineId,
					workerId: second.workerId,
					step: "detach",
					state: "done",
					code: "ARCHIVED",
				},
			]),
		);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: 0 }],
			},
		});
		f.state.listed = [f.entry()];
		const loadCallsBefore = f.calls("qorpera_record_coding_machine_load").length;
		vi.mocked(f.client.readCodingMachineMemory).mockRejectedValueOnce(new Error("LXD_CODING_MEMORY_READ_FAILED"));
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "load",
				state: "failed",
				code: "LXD_CODING_MEMORY_READ_FAILED",
			},
		]);
		expect(f.calls("qorpera_record_coding_machine_load")).toHaveLength(loadCallsBefore);
		const control = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_machine_load") throw new Error("CODING_CONTROL_UNCONFIRMED");
			return control(method, args, signal);
		});
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "load",
				state: "failed",
				code: "CODING_CONTROL_UNCONFIRMED",
			},
		]);
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_record_coding_machine_load")
				return { schema: "wrong", machineId: f.machine.machineId, sessions: 1 };
			return control(method, args, signal);
		});
		expect(await f.host.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "load",
				state: "failed",
				code: "CODING_HOST_MACHINE_LOAD_INVALID",
			},
		]);
	});

	it("reports load on the NAS model and runs overflow sessions on a second machine for the same member", async () => {
		const f = await fixture();
		const overflow = f.another();
		const secondMachine: LxdCodingMachineBinding = { ...f.machine, machineId: randomUUID() };
		const secondPlan = lxdCodingMachinePlan(secondMachine);
		const secondNodeId = randomUUID();
		const secondBootId = randomUUID();
		const secondFiles = new Map(f.files);
		secondFiles.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${secondBootId}\n`),
		});
		const firstSlice = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${f.claim.workerId.replaceAll("-", "")}.slice/memory.stat`;
		const secondSlice = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${overflow.workerId.replaceAll("-", "")}.slice/memory.stat`;
		f.files.set(firstSlice, {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from("anon 268435456\nfile 3221225472\nkernel 4194304\n"),
		});
		secondFiles.set(secondSlice, {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from("anon 134217728\nfile 2147483648\nshmem 8388608\n"),
		});
		const control = f.call.getMockImplementation()!;
		const attachedByMachine = new Map<string, Map<string, string>>([
			[f.machine.machineId, new Map()],
			[secondMachine.machineId, new Map()],
		]);
		f.call.mockImplementation(async (method, args, signal) => {
			if (method === "qorpera_plan_coding_machine" && args.p_worker_id === overflow.workerId)
				return {
					schema: "qorpera.coding-machine-plan/v1",
					state: "planned",
					machineId: secondMachine.machineId,
					binding: secondMachine,
				};
			if (method === "qorpera_authorize_coding_machine_run" && args.p_binding_text === secondPlan.text)
				return {
					schema: "qorpera.coding-machine-admission/v1",
					machineId: secondMachine.machineId,
					workerId: args.p_worker_id,
					instanceSha256: secondPlan.instanceSha256,
					intent: "run",
					guestUid: 200001,
					validForMs: 5000,
					nodeId: secondNodeId,
					nodeVersion: 1,
				};
			if (method === "qorpera_attach_coding_session" && args.p_binding_text === secondPlan.text) {
				const workerId = String(args.p_worker_id);
				const token = randomUUID();
				attachedByMachine.get(secondMachine.machineId)!.set(workerId, token);
				return {
					schema: "qorpera.coding-attachment/v1",
					state: "attached",
					workerId,
					machineId: secondMachine.machineId,
					attachmentToken: token,
					validForMs: 59000,
					turn: { sequence: 1, turnId: codingHostId("turn", `${workerId}:1`), open: true },
				};
			}
			if (method === "qorpera_keep_coding_attachments" && args.p_machine_id === secondMachine.machineId) {
				const map = attachedByMachine.get(secondMachine.machineId)!;
				return {
					schema: "qorpera.coding-attachments/v1",
					machineId: secondMachine.machineId,
					sessions: [...map].map(([workerId, attachmentToken]) => ({
						workerId,
						state: "kept",
						attachmentToken,
						validForMs: 59000,
						turn: { sequence: 1, turnId: codingHostId("turn", `${workerId}:1`), open: false },
					})),
				};
			}
			if (method === "qorpera_record_coding_machine_load" && args.p_machine_id === secondMachine.machineId) {
				if (args.p_binding_text !== secondPlan.text) throw new Error("Coding machine custody differs");
				const sessions = (args.p_load as { sessions?: unknown[] } | undefined)?.sessions;
				return {
					schema: "qorpera.coding-machine-load-recorded/v1",
					machineId: secondMachine.machineId,
					sessions: Array.isArray(sessions) ? sessions.length : 0,
				};
			}
			return control(method, args, signal);
		});
		const devicesByName = new Map<string, Record<string, Record<string, string>>>([
			[f.plan.request.name, structuredClone(f.base)],
			[secondPlan.request.name, structuredClone(f.base)],
		]);
		const getInstance = vi.mocked(f.client.getInstance).getMockImplementation()!;
		vi.mocked(f.client.getInstance).mockImplementation(async (project, name, signal) => {
			if (name !== secondPlan.request.name) return getInstance(project, name, signal);
			return {
				name: secondPlan.request.name,
				type: "virtual-machine",
				status: "Running",
				statusCode: 103,
				profiles: [],
				config: { ...secondPlan.request.config, "volatile.base_image": secondMachine.imageFingerprint },
				expandedConfig: { ...secondPlan.request.config, "volatile.base_image": secondMachine.imageFingerprint },
				devices: structuredClone(devicesByName.get(name)!),
				expandedDevices: structuredClone(devicesByName.get(name)!),
			};
		});
		const replaceDevices = vi.mocked(f.client.replaceInstanceDevices).getMockImplementation()!;
		vi.mocked(f.client.replaceInstanceDevices).mockImplementation(async (project, name, devices, signal) => {
			devicesByName.set(name, structuredClone(devices) as Record<string, Record<string, string>>);
			if (name === f.plan.request.name) await replaceDevices(project, name, devices, signal);
		});
		const readInstanceFile = vi.mocked(f.client.readInstanceFile).getMockImplementation()!;
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			if (name !== secondPlan.request.name) return readInstanceFile(project, name, path, limit, signal);
			const file = secondFiles.get(path);
			if (!file) throw new Error("Missing file");
			return file;
		});
		const readCodingMachineMemory = vi.mocked(f.client.readCodingMachineMemory).getMockImplementation()!;
		vi.mocked(f.client.readCodingMachineMemory).mockImplementation(async (project, name, groups, signal) => {
			if (name !== secondPlan.request.name) return readCodingMachineMemory(project, name, groups, signal);
			const meminfo =
				secondFiles.get("/proc/meminfo")?.content.toString("utf8") ??
				"MemTotal:        8388608 kB\nMemAvailable:    6291456 kB\n";
			const stats = new Map<string, string>();
			for (const path of groups) {
				const content = secondFiles.get(path)?.content.toString("utf8").trim();
				if (content) stats.set(path, content);
			}
			return { meminfo, stats };
		});
		const pushInstanceFile = vi.mocked(f.client.pushInstanceFile).getMockImplementation()!;
		vi.mocked(f.client.pushInstanceFile).mockImplementation(async (project, name, path, content, mode, signal) => {
			if (name !== secondPlan.request.name) return pushInstanceFile(project, name, path, content, mode, signal);
			secondFiles.set(path, { uid: 0, gid: 0, mode, content: Buffer.from(content) });
		});
		const execInstance = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (name !== secondPlan.request.name) return execInstance(project, name, command, signal);
			if (command[0] === "/usr/bin/mountpoint") return;
			if (command[1] === "is-failed") throw new Error("LXD instance command failed");
			if (command[1] !== "/opt/qorpera-coding/cloud-coding-storage-guest.mjs") return;
			if (command[2] === "install") {
				const workerId = command[3]!;
				const inbox = secondFiles.get(f.configuration(workerId, "configuration-inbox.json"));
				if (!inbox) throw new Error("Missing configuration inbox");
				const packet = JSON.parse(inbox.content.toString());
				secondFiles.set(f.configuration(workerId, "storage.json"), {
					uid: 0,
					gid: 0,
					mode: 0o444,
					content: Buffer.from(JSON.stringify(packet.storage)),
				});
				secondFiles.set(f.configuration(workerId, "guest.json"), {
					uid: 0,
					gid: 0,
					mode: 0o444,
					content: Buffer.from(JSON.stringify(packet.guest)),
				});
			}
			if (command[2] === "observe") {
				const seen = f.state.observed.get(overflow.workerId) ?? { cpuUsageUsec: 0, running: [] };
				const lease = f.state.guestLeases.get(overflow.workerId);
				secondFiles.set("/run/qorpera-coding/observation.json", {
					uid: 0,
					gid: 0,
					mode: 0o444,
					content: Buffer.from(
						JSON.stringify({
							schema: "qorpera.coding-guest-observation/v3",
							bootId: secondBootId,
							uptimeMs: f.state.uptimeMs,
							sessions: [
								{
									workerId: overflow.workerId,
									cpuUsageUsec: seen.cpuUsageUsec,
									ioBytes: seen.ioBytes ?? 0,
									running: seen.running.length,
									lease: lease
										? {
												tokenSha256: lease.tokenSha256,
												expiresInMs: Math.max(0, lease.expiresAtMs - f.state.uptimeMs),
											}
										: null,
								},
							],
						}),
					),
				});
			}
		});
		const w1 = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const w2 = await f.host.prepareWorkspace(overflow, f.turnOf(overflow), f.signal);
		expect(w1.vmId).toBe(f.machine.machineId);
		expect(w2.vmId).toBe(secondMachine.machineId);
		expect(await f.hostLease(f.machine.machineId)).toBe("live");
		expect(await f.hostLease(secondMachine.machineId)).toBe("live");
		f.host.endTurn(f.claim);
		f.host.endTurn(overflow);
		const secondAttached = [...attachedByMachine.get(secondMachine.machineId)!].map(
			([workerId, attachmentToken]) => ({
				workerId,
				attachmentToken,
			}),
		);
		f.state.listed = [
			f.entry(),
			f.entry({
				machineId: secondMachine.machineId,
				binding: secondMachine,
				instanceSha256: secondPlan.instanceSha256,
				attached: secondAttached,
			}),
		];
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1_000_000, running: [] });
		f.state.observed.set(overflow.workerId, { cpuUsageUsec: 2_000_000, running: [] });
		const firstPass = await f.host.keep(f.signal);
		expect(firstPass).toEqual(
			expect.arrayContaining([
				{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
				{ machineId: secondMachine.machineId, workerId: overflow.workerId, step: "keep", state: "done" },
			]),
		);
		f.state.uptimeMs += 10_000;
		f.state.observed.set(f.claim.workerId, { cpuUsageUsec: 1_000_000 + 2_000_000, running: [] });
		f.state.observed.set(overflow.workerId, { cpuUsageUsec: 2_000_000 + 5_000_000, running: [] });
		await f.host.keep(f.signal);
		const loads = f.calls("qorpera_record_coding_machine_load").slice(-2);
		expect(loads).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					p_machine_id: f.machine.machineId,
					p_binding_text: f.plan.text,
					p_load: {
						schema: "qorpera.coding-machine-load/v1",
						full: false,
						sessions: [{ workerId: f.claim.workerId, cpuMillis: 200, memoryBytes: 268_435_456 + 4_194_304 }],
					},
				}),
				expect.objectContaining({
					p_machine_id: secondMachine.machineId,
					p_binding_text: secondPlan.text,
					p_load: {
						schema: "qorpera.coding-machine-load/v1",
						full: false,
						sessions: [{ workerId: overflow.workerId, cpuMillis: 500, memoryBytes: 134_217_728 + 8_388_608 }],
					},
				}),
			]),
		);
	});

	it("includes FUSE cgroup working-set memory and latches full immediately at 80% memory", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const worker32 = f.claim.workerId.replaceAll("-", "");
		const slicePath = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${worker32}.slice/memory.stat`;
		const folderServicePath = `/sys/fs/cgroup/system.slice/qorpera-folder-${worker32}.service/memory.stat`;
		const userPath = "/sys/fs/cgroup/user.slice/user-200000.slice/memory.stat";
		const setFile = (path: string, text: string) =>
			f.files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(text) });
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   6291456 kB\n");
		setFile(slicePath, "anon 6442450944\nfile 1073741824\nkernel 0\nshmem 0\n");
		setFile(folderServicePath, "anon 322122547\nfile 536870912\nkernel 0\nshmem 0\n");
		setFile(userPath, "anon 0\nfile 0\nkernel 0\nshmem 0\n");
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 600_000, cpuUsageUsec: 0 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [{ workerId: f.claim.workerId, cpuMillis: 0, memoryBytes: 6_442_450_944 + 322_122_547 }],
			},
		});
		setFile(folderServicePath, "anon 429496730\nfile 536870912\nkernel 4194304\nshmem 1048576\n");
		mocked.guestStatus.mockResolvedValue(f.status([], { uptimeMs: 610_000, cpuUsageUsec: 0 }));
		await f.host.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: true,
				sessions: [
					{
						workerId: f.claim.workerId,
						cpuMillis: 0,
						memoryBytes: 6_442_450_944 + 429_496_730 + 4_194_304 + 1_048_576,
					},
				],
			},
		});
	});

	it("recovers folder.uid on adopted attachments after restart via SQL guestUid and user.json fallback", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const worker32 = f.claim.workerId.replaceAll("-", "");
		const slicePath = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${worker32}.slice/memory.stat`;
		const folderServicePath = `/sys/fs/cgroup/system.slice/qorpera-folder-${worker32}.service/memory.stat`;
		const userPath = "/sys/fs/cgroup/user.slice/user-200000.slice/memory.stat";
		const setFile = (path: string, text: string) =>
			f.files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(text) });
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   6291456 kB\n");
		setFile(slicePath, "anon 10485760\n");
		setFile(folderServicePath, "anon 2097152\n");
		setFile(userPath, "anon 268435456\nkernel 4194304\n");
		const control = f.call.getMockImplementation()!;
		f.call.mockImplementation(async (method, args, signal) => {
			const res = (await control(method, args, signal)) as Record<string, unknown>;
			if (method === "qorpera_keep_coding_attachments" && Array.isArray(res.sessions)) {
				return {
					...res,
					sessions: res.sessions.map((s) =>
						typeof s === "object" && s !== null && (s as Record<string, unknown>).state === "kept"
							? { ...(s as Record<string, unknown>), guestUid: 200000 }
							: s,
					),
				};
			}
			return res;
		});
		const restartedFromSql = new LxdCodingExecutorHost({ ...f.options, folder: f.folder });
		vi.mocked(f.client.readCodingMachineMemory).mockClear();
		expect(await restartedFromSql.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.client.readCodingMachineMemory).toHaveBeenCalledWith(
			f.machine.project,
			f.plan.request.name,
			[
				slicePath,
				`/sys/fs/cgroup/qorpera-folder.slice/qorpera-folder-${worker32}.service/memory.stat`,
				folderServicePath,
				userPath,
			],
			expect.any(AbortSignal),
		);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [
					{
						workerId: f.claim.workerId,
						memoryBytes: 10_485_760 + 2_097_152 + 268_435_456 + 4_194_304,
					},
				],
			},
		});

		f.call.mockImplementation(control);
		setFile(
			`/var/lib/qorpera-guest/sessions/${worker32}/user.json`,
			JSON.stringify({ schema: "qorpera.coding-guest-session-user/v1", uid: 200000 }),
		);
		const restartedFromGuestFile = new LxdCodingExecutorHost({ ...f.options, folder: f.folder });
		vi.mocked(f.client.readCodingMachineMemory).mockClear();
		expect(await restartedFromGuestFile.keep(f.signal)).toEqual([
			{ machineId: f.machine.machineId, workerId: f.claim.workerId, step: "keep", state: "done" },
		]);
		expect(f.client.readCodingMachineMemory).toHaveBeenCalledWith(
			f.machine.project,
			f.plan.request.name,
			[
				slicePath,
				`/sys/fs/cgroup/qorpera-folder.slice/qorpera-folder-${worker32}.service/memory.stat`,
				folderServicePath,
				userPath,
			],
			expect.any(AbortSignal),
		);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_load: {
				full: false,
				sessions: [
					{
						workerId: f.claim.workerId,
						memoryBytes: 10_485_760 + 2_097_152 + 268_435_456 + 4_194_304,
					},
				],
			},
		});
	});

	it("applies 3-sample CPU hysteresis with reset on drop or reboot while memory pressure latches immediately", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const setFile = (path: string, text: string) =>
			f.files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(text) });
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   6291456 kB\n");
		const step = async (uptimeMs: number, cpuUsageUsec: number, bootId = f.bootId) => {
			setFile("/proc/sys/kernel/random/boot_id", `${bootId}\n`);
			mocked.guestStatus.mockResolvedValue(f.status([], { bootId, uptimeMs, cpuUsageUsec }));
			await f.host.keep(f.signal);
			return (f.calls("qorpera_record_coding_machine_load").at(-1) as { p_load: { full: boolean } }).p_load.full;
		};
		expect(await step(600_000, 1_000_000)).toBe(false);
		expect(await step(610_000, 36_000_000)).toBe(false);
		expect(await step(620_000, 71_000_000)).toBe(false);
		expect(await step(630_000, 72_000_000)).toBe(false);
		expect(await step(640_000, 107_000_000)).toBe(false);
		expect(await step(650_000, 142_000_000)).toBe(false);
		expect(await step(660_000, 177_000_000)).toBe(true);
		const rebooted = randomUUID();
		expect(await step(10_000, 1_000_000, rebooted)).toBe(false);
		expect(await step(20_000, 36_000_000, rebooted)).toBe(false);
		expect(await step(30_000, 71_000_000, rebooted)).toBe(false);
		expect(await step(40_000, 106_000_000, rebooted)).toBe(true);
	});

	it("decouples #recordMachineLoad from #keepMachine observation deadline aborts without erasing CPU", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		f.host.endTurn(f.claim);
		f.state.listed = [f.entry()];
		const worker32 = f.claim.workerId.replaceAll("-", "");
		const slicePath = `/sys/fs/cgroup/qorpera.slice/qorpera-coding.slice/qorpera-coding-${worker32}.slice/memory.stat`;
		const folderServicePath = `/sys/fs/cgroup/system.slice/qorpera-folder-${worker32}.service/memory.stat`;
		const userPath = "/sys/fs/cgroup/user.slice/user-200000.slice/memory.stat";
		const setFile = (path: string, text: string) =>
			f.files.set(path, { uid: 0, gid: 0, mode: 0o444, content: Buffer.from(text) });
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   800000 kB\n");
		setFile(slicePath, "anon 104857600\n");
		setFile(folderServicePath, "anon 20971520\n");
		setFile(userPath, "anon 314572800\n");
		setFile(
			`/var/lib/qorpera-guest/sessions/${worker32}/user.json`,
			JSON.stringify({ schema: "qorpera.coding-guest-session-user/v1", uid: 200000 }),
		);
		mocked.guestStatus.mockImplementation(() => new Promise(() => {}));
		const impatient = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, keepDeadlineMs: 50 });
		const loadCallsBefore = f.calls("qorpera_record_coding_machine_load").length;
		expect(await impatient.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_KEEP_DEADLINE",
			},
		]);
		expect(f.calls("qorpera_record_coding_machine_load")).toHaveLength(loadCallsBefore + 1);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_machine_id: f.machine.machineId,
			p_load: {
				schema: "qorpera.coding-machine-load/v1",
				full: true,
				sessions: [
					{
						workerId: f.claim.workerId,
						cpuMillis: null,
						memoryBytes: 104_857_600 + 20_971_520 + 314_572_800,
					},
				],
			},
		});
		setFile("/proc/meminfo", "MemTotal:       8388608 kB\nMemAvailable:   6291456 kB\n");
		expect(await impatient.keep(f.signal)).toEqual([
			{
				machineId: f.machine.machineId,
				workerId: null,
				step: "keep",
				state: "failed",
				code: "CODING_HOST_KEEP_DEADLINE",
			},
		]);
		expect(f.calls("qorpera_record_coding_machine_load").at(-1)).toMatchObject({
			p_machine_id: f.machine.machineId,
			p_load: {
				schema: "qorpera.coding-machine-load/v1",
				full: null,
				sessions: [
					{
						workerId: f.claim.workerId,
						cpuMillis: null,
						memoryBytes: 104_857_600 + 20_971_520 + 314_572_800,
					},
				],
			},
		});
	});

	it("bounds and parallelizes fallback uid lookups and negative-caches missing user.json per boot", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		f.state.listed = [f.entry()];
		const restarted = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, keepDeadlineMs: 120 });
		const readInstanceFile = vi.mocked(f.client.readInstanceFile).getMockImplementation()!;
		const userJsonReads: string[] = [];
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			if (path.endsWith("/user.json")) {
				userJsonReads.push(path);
				throw new Error("Missing file");
			}
			return readInstanceFile(project, name, path, limit, signal);
		});
		await restarted.keep(f.signal);
		expect(userJsonReads).toHaveLength(2);
		await restarted.keep(f.signal);
		expect(userJsonReads).toHaveLength(2);
		const rebooted = randomUUID();
		f.files.set("/proc/sys/kernel/random/boot_id", {
			uid: 0,
			gid: 0,
			mode: 0o444,
			content: Buffer.from(`${rebooted}\n`),
		});
		mocked.guestStatus.mockResolvedValue(f.status([], { bootId: rebooted, uptimeMs: 10_000 }));
		await restarted.keep(f.signal);
		expect(userJsonReads).toHaveLength(4);

		const stalledHost = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, keepDeadlineMs: 120 });
		mocked.guestStatus.mockImplementation(() => new Promise(() => {}));
		vi.mocked(f.client.readInstanceFile).mockImplementation(async (project, name, path, limit, signal) => {
			if (path.endsWith("/user.json")) return new Promise(() => {});
			return readInstanceFile(project, name, path, limit, signal);
		});
		const loadsBefore = f.calls("qorpera_record_coding_machine_load").length;
		await stalledHost.keep(f.signal);
		expect(f.calls("qorpera_record_coding_machine_load")).toHaveLength(loadsBefore + 1);
	});

	it("observes attached sessions via one batched statusAll exec and caches immutable kept command text", async () => {
		const f = await folderFixture();
		const second = f.another();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		await f.host.prepareWorkspace(second, f.turnOf(second), f.signal);
		f.host.endTurn(f.claim);
		f.host.endTurn(second);
		f.state.listed = [f.entry()];
		const cmd1 = randomUUID();
		const cmd2 = randomUUID();
		mocked.guestStatus.mockClear();
		mocked.guestStatusAll.mockResolvedValue({
			schema: "qorpera.coding-guest-status-all/v1",
			bootId: f.bootId,
			uptimeMs: 600_000,
			sessions: [
				{
					workerId: f.claim.workerId,
					commands: [{ commandId: cmd1, state: "running" }],
					usage: { bootId: f.bootId, uptimeMs: 600_000, cpuUsageUsec: 1000, ioBytes: 100, ioComplete: true },
				},
				{
					workerId: second.workerId,
					commands: [{ commandId: cmd2, state: "running" }],
					usage: { bootId: f.bootId, uptimeMs: 600_000, cpuUsageUsec: 2000, ioBytes: 200, ioComplete: true },
				},
			],
		});
		mocked.keptCommand.mockImplementation(async (_custody: string, _workerId: string, id: string) => ({
			turn: 1,
			command: `run ${id}`,
		}));
		mocked.keptCommand.mockClear();

		await f.host.keep(f.signal);
		expect(mocked.guestStatusAll).toHaveBeenCalledTimes(1);
		expect(mocked.guestStatus).not.toHaveBeenCalled();
		expect(mocked.keptCommand).toHaveBeenCalledTimes(2);

		await f.host.keep(f.signal);
		expect(mocked.guestStatusAll).toHaveBeenCalledTimes(2);
		expect(mocked.keptCommand).toHaveBeenCalledTimes(2);
	});

	it("overlaps VM boot with worktree prepare, runs prepare ahead of attach on turn 2, and refuses with CODE_RESTORING", async () => {
		const f = await folderFixture();
		const order: string[] = [];
		let releaseReconcile!: () => void;
		const reconcileGate = new Promise<void>((resolve) => {
			releaseReconcile = resolve;
		});
		const origReconcile = mocked.reconcile.getMockImplementation()!;
		mocked.reconcile.mockImplementationOnce(async (input) => {
			order.push("reconcile:start");
			await reconcileGate;
			order.push("reconcile:end");
			return origReconcile(input);
		});
		const origPrepare = f.repositories.prepare.getMockImplementation()!;
		f.repositories.prepare.mockImplementationOnce(async (session, signal) => {
			order.push("repo:start");
			releaseReconcile();
			const out = await origPrepare(session, signal);
			order.push("repo:end");
			return out;
		});

		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(order.indexOf("repo:start")).toBeGreaterThan(-1);
		expect(order.indexOf("repo:start")).toBeLessThan(order.indexOf("reconcile:end"));
		expect(f.calls("qorpera_record_coding_worktree_created")).toHaveLength(1);
		expect(f.repositories.prepare).toHaveBeenCalledTimes(1);

		const turn2Order: string[] = [];
		f.repositories.prepare.mockImplementationOnce(async (session, signal) => {
			turn2Order.push("prepare");
			return origPrepare(session, signal);
		});
		f.state.duringAttach = () => {
			turn2Order.push("attach");
		};
		const turn2Claim = { ...f.claim, sequence: 2, worktreeCreatedAt: new Date().toISOString() };
		f.sequences.set(f.claim.workerId, 2);
		f.host.endTurn(f.claim);
		await f.host.prepareWorkspace(
			turn2Claim,
			{ ...f.turn(), sequence: 2, turnId: codingHostId("turn", `${f.claim.workerId}:2`), baseSha: f.baseSha },
			f.signal,
		);
		expect(f.repositories.prepare).toHaveBeenCalledTimes(2);
		expect(turn2Order).toEqual(["prepare", "attach"]);
		expect(f.calls("qorpera_record_coding_worktree_created")).toHaveLength(1);

		const turn3Claim = { ...turn2Claim, sequence: 3 };
		f.sequences.set(f.claim.workerId, 3);
		f.host.endTurn(turn2Claim);
		const attachBeforeTurn3 = f.calls("qorpera_attach_coding_session").length;
		f.repositories.prepare.mockRejectedValueOnce(
			new CodingWorkspaceFailed("CODE_HOST_RESTORE_IN_PROGRESS", CODE_RESTORING),
		);
		await expect(
			f.host.prepareWorkspace(
				turn3Claim,
				{ ...f.turn(), sequence: 3, turnId: codingHostId("turn", `${f.claim.workerId}:3`), baseSha: f.baseSha },
				f.signal,
			),
		).rejects.toMatchObject({
			message: "CODE_HOST_RESTORE_IN_PROGRESS",
			summary: `${CODE_RESTORING} [code=CODE_HOST_RESTORE_IN_PROGRESS]`,
		});
		expect(f.calls("qorpera_attach_coding_session")).toHaveLength(attachBeforeTurn3);
	});

	it("serializes hard-NFS storage calls across two workers so at most one NAS call hangs at a time", async () => {
		const f = await folderFixture();
		const host = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, storageStepTimeoutMs: 60 });
		const second = f.another();
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let releaseHang!: () => void;
		const hang = new Promise<void>((resolve) => {
			releaseHang = resolve;
		});
		mocked.storagePrepare.mockImplementation(async () => {
			active++;
			started++;
			maxActive = Math.max(maxActive, active);
			try {
				await hang;
			} finally {
				active--;
			}
		});
		const firstWork = host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const secondWork = host.prepareWorkspace(second, f.turnOf(second), f.signal);
		const results = await Promise.allSettled([firstWork, secondWork]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("rejected");
		expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ message: "CODING_HOST_STORAGE_TIMEOUT" });
		expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ message: "CODING_HOST_STORAGE_TIMEOUT" });
		expect(maxActive).toBe(1);
		expect(started).toBe(1);
		releaseHang();
		await hang;
	});

	it("reuses pre-authorized CodingCommandTurnContext in commandTransport without duplicate run or list RPCs", async () => {
		const f = await folderFixture();
		await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const scope = {
			workerId: f.claim.workerId,
			vmId: f.machine.machineId,
			requestId: f.turn().turnId,
			turn: f.claim.sequence,
		};
		const localBinding = f.host.localRunBinding(scope);
		expect(localBinding).toMatchObject({
			workerId: f.claim.workerId,
			leaseToken: f.claim.leaseToken,
			machineIdSha256: f.options.machineIdSha256,
		});
		const plan = lxdCodingMachinePlan(f.machine);
		const runAuthority = {
			schema: "qorpera.coding-machine-admission/v1",
			machineId: f.machine.machineId,
			workerId: f.claim.workerId,
			instanceSha256: plan.instanceSha256,
			intent: "run",
			guestUid: 200001,
			validForMs: 5000,
			nodeId: randomUUID(),
			nodeVersion: 1,
		};
		const context = {
			inputSha256: "a".repeat(64),
			runAuthority,
			rebuildDue: false,
			diskEpoch: null,
			vaultEnvVersion: "b".repeat(64),
			startedAt: performance.now(),
			postAuthority: undefined as
				| {
						readonly inputSha256: string;
						readonly runAuthority?: unknown;
						readonly rebuildDue?: boolean;
						readonly diskEpoch?: string | null;
						readonly vaultEnvVersion?: string;
						readonly startedAt?: number;
				  }
				| undefined,
		};
		f.call.mockClear();
		const postAuthorize = vi.fn(async () => {
			context.postAuthority = {
				inputSha256: "a".repeat(64),
				runAuthority,
				rebuildDue: false,
				diskEpoch: null,
				vaultEnvVersion: "b".repeat(64),
				startedAt: performance.now(),
			};
		});
		await f.host.commandTransport(scope, postAuthorize, f.signal, context);
		const transportOpts = mocked.folderTransports.at(-1) as unknown as LxdCodingFolderCommandTransportOptions;
		expect(transportOpts.vaultEnvVersion).toBe("b".repeat(64));
		await transportOpts.authorize("start", scope, randomUUID(), "a".repeat(64), f.signal);
		expect(postAuthorize).not.toHaveBeenCalled();
		await transportOpts.authorize("start", scope, randomUUID(), "a".repeat(64), f.signal);
		expect(postAuthorize).toHaveBeenCalledTimes(1);
		expect(await transportOpts.withheld?.(f.signal)).toBe(false);
		expect(f.calls("qorpera_authorize_coding_machine_run")).toEqual([]);
		expect(f.calls("qorpera_list_coding_machines")).toEqual([]);
	});

	it("does not abort an in-flight start dispatch when overlapped repo prepare hits NODE_OBSERVATION_UNAVAILABLE and settles accepted ops before deferring", async () => {
		const f = await folderFixture();
		mocked.realReconcile = true;
		let startEntered!: () => void;
		const inStart = new Promise<void>((resolve) => {
			startEntered = resolve;
		});
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		const ops = new Map<string, "create" | "start">();
		let startSignalAborted = true;
		vi.mocked(f.client.submitInstanceOperation).mockImplementation(async (project, action, signal) => {
			const operationId = randomUUID();
			if (action.action === "create") {
				f.lxd.exists = true;
				f.lxd.running = false;
				f.lxd.devices = structuredClone(action.request.devices) as Devices;
				ops.set(operationId, "create");
				return { project, instanceName: action.request.name, operationId };
			}
			if (action.action === "start") {
				startEntered();
				await startGate;
				startSignalAborted = signal.aborted;
				signal.throwIfAborted();
				f.lxd.running = true;
				ops.set(operationId, "start");
				return { project, instanceName: action.name, operationId };
			}
			throw new Error(`unexpected action ${action.action}`);
		});
		vi.mocked(f.client.inspectInstanceOperation).mockImplementation(async ({ operationId }) => {
			if (!ops.has(operationId)) throw new Error("LXD_OPERATION_UNKNOWN");
			return "succeeded";
		});

		const origPrepare = f.repositories.prepare.getMockImplementation()!;
		f.repositories.prepare.mockImplementationOnce(async (session, signal) => {
			await inStart;
			f.state.runRefusal = "NODE_OBSERVATION_UNAVAILABLE";
			try {
				await session.assertAuthorized(signal);
			} finally {
				globalThis.setTimeout(releaseStart, 10);
			}
			return origPrepare(session, signal);
		});

		const firstError = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal).catch((error: unknown) => error);
		expect(firstError).toBeInstanceOf(CodingMachineUnavailable);
		expect((firstError as CodingMachineUnavailable).reason).toBe("NODE_OBSERVATION_UNAVAILABLE");
		expect(startSignalAborted).toBe(false);
		expect(vi.mocked(f.client.execInstance).mock.calls.filter((call) => call[2][0] === "/usr/bin/true")).toHaveLength(
			0,
		);

		const settled = JSON.parse(
			await readFile(
				join(f.options.storagePolicy.rootPath, "control", "machines", f.machine.machineId, "000005.json"),
				"utf8",
			),
		);
		expect(settled).toMatchObject({ action: "start", kind: "settled", state: "succeeded" });

		f.state.runRefusal = null;
		vi.mocked(f.client.inspectInstanceOperation).mockRejectedValue(new Error("LXD_OPERATION_UNKNOWN"));
		const prepared = await f.host.prepareWorkspace(f.claim, f.turn(), f.signal);
		expect(prepared).toEqual({ vmId: f.machine.machineId, baseSha: f.baseSha });
		expect(vi.mocked(f.client.submitInstanceOperation).mock.calls.map((call) => call[1].action)).toEqual([
			"create",
			"start",
		]);
	});

	it("aborts #folderReady promptly on overlapped repo failure while real turn aborts still abort in-flight LXD dispatch", async () => {
		const f = await folderFixture();
		const host = new LxdCodingExecutorHost({ ...f.options, folder: f.folder, guestReadyTimeoutMs: 10_000 });
		let inReady!: () => void;
		const readyEntered = new Promise<void>((resolve) => {
			inReady = resolve;
		});
		let readyAborted = false;
		const origExec = vi.mocked(f.client.execInstance).getMockImplementation()!;
		vi.mocked(f.client.execInstance).mockImplementation(async (project, name, command, signal) => {
			if (command[0] === "/usr/bin/true") {
				inReady();
				return new Promise<void>((_resolve, reject) => {
					if (!signal) return reject(new Error("missing signal"));
					signal.addEventListener(
						"abort",
						() => {
							readyAborted = true;
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			}
			return origExec(project, name, command, signal);
		});
		f.repositories.prepare.mockImplementationOnce(async () => {
			await readyEntered;
			throw new CodingWorkspaceFailed("CODE_HOST_RESTORE_IN_PROGRESS", CODE_RESTORING);
		});
		await expect(host.prepareWorkspace(f.claim, f.turn(), f.signal)).rejects.toMatchObject({
			message: "CODE_HOST_RESTORE_IN_PROGRESS",
		});
		expect(readyAborted).toBe(true);

		const g = await folderFixture();
		mocked.realReconcile = true;
		const turnAbort = new AbortController();
		let leaseAbortedDispatch = false;
		vi.mocked(g.client.submitInstanceOperation).mockImplementationOnce(async (_project, _action, signal) => {
			turnAbort.abort(new Error("CODING_EXECUTOR_LEASE_LOST"));
			leaseAbortedDispatch = signal.aborted;
			throw new Error("LXD_OPERATION_SUBMISSION_UNCONFIRMED");
		});
		await expect(g.host.prepareWorkspace(g.claim, g.turn(), turnAbort.signal)).rejects.toThrow(
			"CODING_EXECUTOR_LEASE_LOST",
		);
		expect(leaseAbortedDispatch).toBe(true);
		await vi.waitFor(async () => {
			await readFile(
				join(
					g.options.storagePolicy.rootPath,
					"control",
					"machines",
					g.machine.machineId,
					"dispatch-error-000000-000000.json",
				),
				"utf8",
			);
		});
	});

	it("opens pinned exec and sftp coding channels with vault secret masking, folder release gating, and endTurn cleanup", async () => {
		const secretValue = "vault-secret-coding-channel-98765";
		const f = await folderFixture();
		const host = new LxdCodingExecutorHost({
			...f.options,
			folder: f.folder,
			commandEnvironment: {
				environment: vi.fn(async () => ({
					environment: { APP_API_SECRET: secretValue },
					mask: [],
				})),
			},
		});
		let codexHash = `${CODING_MACHINE_CHANNEL.codexSha256}  ${CODING_MACHINE_CHANNEL.codex}\n`;
		let sftpExit = 0;
		let codexChecks = 0;
		let sftpChecks = 0;
		let lastChannelRequest: LxdExecPipeRequest | undefined;
		let lastChannelSignal: AbortSignal | undefined;
		const stdinWritten: string[] = [];
		const pipe = vi.fn(async (_project: string, _name: string, request: LxdExecPipeRequest, signal: AbortSignal) => {
			if (!validExecPipe(request)) throw new Error("LXD instance command is invalid");
			if (
				request.command.includes(CODING_MACHINE_CHANNEL.sftpServer) &&
				!request.command.includes("/usr/bin/systemd-run")
			) {
				sftpChecks += 1;
				return { exitCode: sftpExit, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) };
			}
			if (request.command.includes(CODING_MACHINE_CHANNEL.codex) && !request.command.includes("exec-server")) {
				codexChecks += 1;
				return { exitCode: 0, stdout: Buffer.from(codexHash), stderrTail: Buffer.alloc(0) };
			}
			lastChannelRequest = request;
			lastChannelSignal = signal;
			const drain = (async () => {
				if (!request.stdin) return;
				if (request.stdin instanceof Uint8Array) {
					stdinWritten.push(Buffer.from(request.stdin).toString("utf8"));
					return;
				}
				for await (const chunk of request.stdin) stdinWritten.push(Buffer.from(chunk).toString("utf8"));
			})();
			return await new Promise<{ exitCode: number; stdout: Buffer; stderrTail: Buffer }>((resolve) => {
				const finish = () => {
					void drain.finally(() => resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderrTail: Buffer.alloc(0) }));
				};
				if (signal.aborted) finish();
				else signal.addEventListener("abort", finish, { once: true });
			});
		});
		Object.assign(f.client, { execInstancePipe: pipe });

		const prepared = await host.prepareWorkspace(f.claim, f.turn(), f.signal);
		const scope = {
			workerId: f.claim.workerId,
			vmId: prepared.vmId,
			requestId: codingHostId("turn", `${f.claim.workerId}:${f.claim.sequence}`),
			turn: f.claim.sequence,
		};

		const execChannel = await host.openCodingChannel(scope, "exec", f.signal);
		expect(codexChecks).toBe(1);
		expect(lastChannelRequest?.command).toContain(CODING_MACHINE_CHANNEL.codex);
		expect(lastChannelRequest?.command.join(" ")).not.toContain(secretValue);

		execChannel.write(
			JSON.stringify({
				id: 1,
				method: "process/start",
				params: { processId: "p1", argv: ["/bin/bash", "-c", "echo hi"], env: { HOME: "/evil", CLAUDECODE: "1" } },
			}),
		);
		await vi.waitFor(() => expect(stdinWritten.join("")).toContain('"process/start"'));
		const forwarded = JSON.parse(stdinWritten.join("").trim()) as { params: { env: Record<string, string> } };
		expect(forwarded.params.env.APP_API_SECRET).toBe(secretValue);
		expect(forwarded.params.env.HOME).toMatch(/^\/home\/qorpera-2\d{5}$/);
		expect(forwarded.params.env.CLAUDECODE).toBe("1");
		expect(forwarded.params.env.GIT_CONFIG_COUNT).toBeDefined();
		expect(forwarded.params.env.GIT_AUTHOR_EMAIL).toBe(`${f.claim.workerId}@coding.qorpera.com`);
		expect(lastChannelRequest?.command.length).toBeLessThanOrEqual(64);

		const received: string[] = [];
		const reading = (async () => {
			for await (const line of execChannel.lines) received.push(line);
		})();
		lastChannelRequest?.stdout?.(
			Buffer.from(
				`${JSON.stringify({
					method: "process/output",
					params: {
						processId: "p1",
						stream: "stdout",
						chunk: Buffer.from(`val=${secretValue}`).toString("base64"),
					},
				})}\n${JSON.stringify({ method: "process/exited", params: { processId: "p1", exitCode: 0 } })}\n`,
				"utf8",
			),
		);
		await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
		const decoded = received
			.map((l) => JSON.parse(l) as { method?: string; params?: { chunk?: string } })
			.filter((m) => m.method === "process/output")
			.map((m) => Buffer.from(m.params?.chunk ?? "", "base64").toString("utf8"))
			.join("");
		expect(decoded).toBe("val=***");

		await execChannel.close();
		await reading;
		expect(f.boundary).toHaveBeenCalled();

		const secondExec = await host.openCodingChannel(scope, "exec", f.signal);
		expect(codexChecks).toBe(1);
		const secondSignal = lastChannelSignal;
		host.endTurn(f.claim);
		expect(secondSignal?.aborted).toBe(true);
		await secondExec.close();

		const g = await folderFixture();
		Object.assign(g.client, { execInstancePipe: pipe });
		const gPrepared = await g.host.prepareWorkspace(g.claim, g.turn(), g.signal);
		const gScope = {
			workerId: g.claim.workerId,
			vmId: gPrepared.vmId,
			requestId: codingHostId("turn", `${g.claim.workerId}:${g.claim.sequence}`),
			turn: g.claim.sequence,
		};
		codexHash = `${"0".repeat(64)}  ${CODING_MACHINE_CHANNEL.codex}\n`;
		await expect(g.host.openCodingChannel(gScope, "exec", g.signal)).rejects.toThrow("CODING_CODEX_NOT_PINNED");

		sftpExit = 98;
		await expect(g.host.openCodingChannel(gScope, "sftp", g.signal)).rejects.toThrow("CODING_SFTP_MISSING");

		sftpExit = 0;
		const sftpChannel = await g.host.openCodingChannel(gScope, "sftp", g.signal);
		expect(sftpChecks).toBe(2);
		await sftpChannel.close();
		const sftpAgain = await g.host.openCodingChannel(gScope, "sftp", g.signal);
		expect(sftpChecks).toBe(2);
		await sftpAgain.close();
	});

	it("prepares surface_folder and surface_ops workspaces on the folder model at /company without git setup, worktree, or snapshots, and refuses on the NAS model", async () => {
		const f = await folderFixture();
		const readSetup = vi.fn<NonNullable<CodingFolderRepositories["readSetup"]>>();
		const snapshotEnqueue = vi.fn();
		const host = new LxdCodingExecutorHost({
			...f.options,
			folder: {
				...f.folder,
				repositories: { ...f.repositories, readSetup },
			},
			snapshotBuilder: { enqueue: snapshotEnqueue } as unknown as NonNullable<
				LxdCodingExecutorHostOptions["snapshotBuilder"]
			>,
		});

		const surfaceFolderClaim: CodingSessionClaim = {
			...f.claim,
			harness: "claude-code",
			model: "claude-opus-5-5",
			workspaceKind: "surface_folder",
			repository: null,
			surfaceSession: {
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				slug: "brand-studio",
				title: "Brand Studio",
			},
		};
		const preparedFolder = await host.prepareWorkspace(surfaceFolderClaim, f.turnOf(surfaceFolderClaim), f.signal);
		expect(preparedFolder).toEqual({ vmId: f.machine.machineId, baseSha: null });
		expect(readSetup).not.toHaveBeenCalled();
		expect(f.repositories.prepare).not.toHaveBeenCalled();
		expect(mocked.resolveBase).not.toHaveBeenCalled();
		expect(f.calls("qorpera_record_coding_worktree_created")).toHaveLength(0);
		expect(snapshotEnqueue).not.toHaveBeenCalled();
		expect(f.views.attach).toHaveBeenCalledTimes(1);
		await host.commandTransport(f.scope(surfaceFolderClaim), async () => undefined, f.signal);
		expect((mocked.folderTransports.at(-1)?.session as { cwd?: string } | undefined)?.cwd).toBe("/company");
		host.endTurn(surfaceFolderClaim);

		const ops = await folderFixture();
		const opsReadSetup = vi.fn<NonNullable<CodingFolderRepositories["readSetup"]>>();
		const opsSnapshotEnqueue = vi.fn();
		const opsHost = new LxdCodingExecutorHost({
			...ops.options,
			folder: {
				...ops.folder,
				repositories: { ...ops.repositories, readSetup: opsReadSetup },
			},
			snapshotBuilder: { enqueue: opsSnapshotEnqueue } as unknown as NonNullable<
				LxdCodingExecutorHostOptions["snapshotBuilder"]
			>,
		});
		const opsClaim: CodingSessionClaim = {
			...ops.claim,
			harness: "codex",
			workspaceKind: "surface_ops",
			repository: null,
			surfaceSession: {
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				slug: "ops-desk",
				title: "Operations",
			},
		};
		const preparedOps = await opsHost.prepareWorkspace(opsClaim, ops.turnOf(opsClaim), ops.signal);
		expect(preparedOps).toEqual({ vmId: ops.machine.machineId, baseSha: null });
		expect(opsReadSetup).not.toHaveBeenCalled();
		expect(ops.repositories.prepare).not.toHaveBeenCalled();
		expect(ops.calls("qorpera_record_coding_worktree_created")).toHaveLength(0);
		expect(opsSnapshotEnqueue).not.toHaveBeenCalled();
		await opsHost.commandTransport(ops.scope(opsClaim), async () => undefined, ops.signal);
		expect((mocked.folderTransports.at(-1)?.session as { cwd?: string } | undefined)?.cwd).toBe("/company");
		opsHost.endTurn(opsClaim);

		const nas = await fixture();
		const nasHost = new LxdCodingExecutorHost(nas.options);
		const nasSurfaceClaim: CodingSessionClaim = {
			...nas.claim,
			workspaceKind: "surface_folder",
			repository: null,
		};
		await expect(
			nasHost.prepareWorkspace(nasSurfaceClaim, nas.turnOf(nasSurfaceClaim), nas.signal),
		).rejects.toMatchObject({
			name: "CodingWorkspaceFailed",
			message: "CODING_SURFACE_FOLDER_MODEL_REQUIRED",
		});
	});
});
