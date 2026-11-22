import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingSessionClaim, type CodingTurnState, CodingWorkspaceFailed } from "../src/coding-executor.ts";
import {
	CODING_HOST_RPCS,
	LxdCodingExecutorHost,
	type LxdCodingExecutorHostOptions,
} from "../src/coding-executor-host.ts";
import type { CodingFolderRepositories } from "../src/coding-folder-repositories.ts";
import type { CodingHostLeases } from "../src/coding-host-lease.ts";
import { type LxdCodingMachineBinding, lxdCodingMachinePlan } from "../src/coding-machine.ts";
import { parseCodingSetup } from "../src/coding-setup.ts";
import type { CodingSetupLifecycle } from "../src/coding-setup-lifecycle.ts";
import type { CodingSnapshotBuilder } from "../src/coding-snapshots.ts";
import type { LxdInstanceExecStreamClient, LxdInstanceRecord } from "../src/lxd-client.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const BASE_FP = hash("base-image");
const SNAP_FP = hash("snapshot-image");
const UNCONFIRMED_FP = hash("unconfirmed-image");
const SNAPSHOT_ID = "88888888-8888-4888-8888-888888888888";
const BASE_SHA = "a".repeat(40);
const MACHINE_SHA = hash("node-5h");

function makeClaim(baseSha: string | null = BASE_SHA): CodingSessionClaim {
	return {
		workerId: "11111111-1111-4111-8111-111111111111",
		leaseToken: "66666666-6666-4666-8666-666666666666",
		leaseUntil: new Date(Date.now() + 300_000).toISOString(),
		sequence: 1,
		profileId: "22222222-2222-4222-8222-222222222222",
		environmentId: "33333333-3333-4333-8333-333333333333",
		agentId: "55555555-5555-4555-8555-555555555555",
		ownerUserId: "44444444-4444-4444-8444-444444444444",
		harness: "codex",
		model: null,
		repository: { host: "qorpera", owner: "acme", name: "app", baseBranch: "main" },
		branch: "qorpera/coding/11111111-1111-4111-8111-111111111111",
		baseSha,
		harnessSessionRef: null,
		pullRequest: null,
		title: "Test",
		goal: "Goal",
		definitionOfDone: "Done",
		context: "",
		followUp: null,
	};
}

function makeTurn(claim: CodingSessionClaim): CodingTurnState {
	return {
		workerId: claim.workerId,
		sequence: claim.sequence,
		turnId: randomUUID(),
		phase: "preparing",
		workerState: "running",
		vmAllocationId: null,
		storageVolumeId: null,
		baseSha: claim.baseSha,
		occurrenceId: null,
		occurrenceStatus: null,
		runId: null,
		jobStatus: null,
		jobError: null,
		submission: null,
		pullRequest: null,
	};
}

function makeVmPolicy() {
	return {
		providerId: "native-node",
		providerPolicySha256: hash("policy"),
		project: "coding",
		imageFingerprint: BASE_FP,
		bootstrapSha256: hash("bootstrap"),
		storagePool: "coding-disks",
		network: "qagent0",
		cpus: 2,
		memoryBytes: 4096 * 1024 ** 2,
		rootDiskBytes: 64 * 1024 ** 3,
	};
}

function makeBinding(claim: CodingSessionClaim, imageFingerprint: string): LxdCodingMachineBinding {
	return {
		schema: "qorpera.lxd-coding-machine/v1",
		machineId: "77777777-7777-4777-8777-777777777777",
		companyId: claim.profileId,
		environmentId: claim.environmentId,
		memberUserId: claim.ownerUserId,
		...makeVmPolicy(),
		imageFingerprint,
	};
}

describe("LxdCodingExecutorHost 5h snapshot planning and setup discovery", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function createHost(options: {
		planResponse: (args: Record<string, unknown>) => Record<string, unknown>;
		fallbackResponse?: () => Record<string, unknown>;
		hasImage?: (fingerprint: string) => boolean;
		existingInstance?: LxdInstanceRecord;
		repositories?: CodingFolderRepositories;
		snapshotBuilder?: CodingSnapshotBuilder;
		setupLifecycle?: CodingSetupLifecycle;
	}) {
		const root = await mkdtemp(join(tmpdir(), "qorpera-host-5h-"));
		tempDirs.push(root);
		const controlPath = join(root, "control");
		await mkdir(join(controlPath, "machines"), { recursive: true });
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const claim = makeClaim();
		const storagePolicy = {
			schema: "qorpera.coding-nas-policy/v1" as const,
			mountPoint: root,
			rootPath: root,
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		};
		const client = {
			getInstance: vi.fn(async () => options.existingInstance),
			getInstanceState: vi.fn(async () => ({ status: "Running", statusCode: 103, network: {} })),
			getStorageVolume: vi.fn(async () => undefined),
			createStorageVolume: vi.fn(async () => undefined),
			deleteStorageVolume: vi.fn(async () => true),
			createInstance: vi.fn(async () => undefined),
			setInstancePower: vi.fn(async () => undefined),
			pushInstanceFile: vi.fn(async () => undefined),
			execInstance: vi.fn(async () => undefined),
			deleteInstance: vi.fn(async () => undefined),
			readInstanceFile: vi.fn(async () => ({ content: Buffer.alloc(0), uid: 0, gid: 0, mode: 0o644 })),
			submitInstanceOperation: vi.fn(async () => {
				throw new Error("STOP_AFTER_PLAN");
			}),
			inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
			replaceInstanceDevices: vi.fn(async () => undefined),
			hasImage: vi.fn(async (_project: string, fp: string) => options.hasImage?.(fp) ?? fp === BASE_FP),
			allowsAgentCard: vi.fn(async () => true),
		};
		const control = {
			call: vi.fn(async (method: string, args: Record<string, unknown>) => {
				calls.push({ method, args });
				if (method === "qorpera_plan_coding_machine") return options.planResponse(args);
				if (method === "qorpera_fallback_coding_machine_base_image") {
					return options.fallbackResponse ? options.fallbackResponse() : options.planResponse(args);
				}
				if (method === "qorpera_authorize_coding_machine_run") {
					throw new Error("REACHED_RUN_AFTER_PLAN");
				}
				return {};
			}),
		};
		const hostOptions: LxdCodingExecutorHostOptions = {
			control,
			owner: "coding-host",
			machineIdSha256: MACHINE_SHA,
			journalRoot: controlPath,
			storagePolicy,
			vmPolicy: makeVmPolicy(),
			client: client as unknown as LxdCodingExecutorHostOptions["client"],
			guest: {
				uid: 1100,
				gid: 1100,
				storageHelperSha256: hash("storage"),
				resourceProfile: { maxLogBytes: 67108864 },
				commandHelperSha256: hash("command"),
				gitHelperSha256: hash("git"),
				watchdogHelperSha256: hash("watchdog"),
			},
			repositoryCredentials: {
				withRepositoryToken: vi.fn(async (_scope, _repo, use) => use("tok")),
			},
			hostLeases: {
				renew: vi.fn(async () => undefined),
				drop: vi.fn(async () => undefined),
			} as unknown as CodingHostLeases,
			folder: {
				views: {
					attach: vi.fn(async () => ({ viewId: randomUUID(), packageCaches: true })),
					held: vi.fn(async () => undefined),
					end: vi.fn(async () => ({ workerId: claim.workerId, viewId: randomUUID(), saved: true, closed: true })),
					endMachine: vi.fn(async () => []),
				},
				control: {
					boundary: vi.fn(async (machine: string) => ({ machine, reads: "released" as const, views: [] })),
					restarted: vi.fn(async () => false),
					secrets: vi.fn(async () => null),
				},
				client: {} as LxdInstanceExecStreamClient,
				repositories: options.repositories,
			},
			snapshotBuilder: options.snapshotBuilder,
			setupLifecycle: options.setupLifecycle,
		};
		const host = new LxdCodingExecutorHost(hostOptions);
		return { host, claim, calls, client };
	}

	it("includes qorpera_fallback_coding_machine_base_image in CODING_HOST_RPCS", () => {
		expect(CODING_HOST_RPCS).toContain("qorpera_fallback_coding_machine_base_image");
	});

	it("discovers .qorpera/environment.json, sends p_setup_digest to #plan, and accepts a local ready snapshot image", async () => {
		const parsed = await parseCodingSetup({
			async read(path) {
				if (path === ".qorpera/environment.json") {
					return { kind: "file", bytes: Buffer.from(JSON.stringify({ install: "npm ci" })) };
				}
				return { kind: "missing" };
			},
		});
		const claim = makeClaim();
		const snapBinding = makeBinding(claim, SNAP_FP);
		const snapText = lxdCodingMachinePlan(snapBinding).text;

		const { host, calls, client } = await createHost({
			hasImage: (fp) => fp === BASE_FP || fp === SNAP_FP,
			repositories: {
				prepare: vi.fn(async () => ({ cwd: "/company/code/acme/app/worktrees/w" })),
				export: vi.fn(async () => null),
				readSetup: vi.fn(async () => parsed),
			},
			planResponse: () => ({
				schema: "qorpera.coding-machine-plan/v1",
				state: "planned",
				machineId: snapBinding.machineId,
				binding: snapBinding,
				bindingText: snapText,
				snapshotId: SNAPSHOT_ID,
				snapshotImageFingerprint: SNAP_FP,
				snapshotBuildNeeded: false,
			}),
		});

		await expect(host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000))).rejects.toThrow(
			"REACHED_RUN_AFTER_PLAN",
		);

		const planCall = calls.find((c) => c.method === "qorpera_plan_coding_machine");
		expect(planCall?.args.p_setup_digest).toBe(parsed.setupDigest);
		expect(client.hasImage).toHaveBeenCalledWith("coding", SNAP_FP, expect.any(AbortSignal));
		const runCall = calls.find((c) => c.method === "qorpera_authorize_coding_machine_run");
		expect(runCall?.args.p_binding_text).toBe(snapText);
	});

	it("fails closed to base image via fallback RPC when SQL-selected snapshot image is missing from local LXD", async () => {
		const claim = makeClaim();
		const snapBinding = makeBinding(claim, SNAP_FP);
		const baseBinding = makeBinding(claim, BASE_FP);
		const baseText = lxdCodingMachinePlan(baseBinding).text;

		const { host, calls } = await createHost({
			hasImage: (fp) => fp === BASE_FP,
			planResponse: () => ({
				schema: "qorpera.coding-machine-plan/v1",
				state: "planned",
				machineId: snapBinding.machineId,
				binding: snapBinding,
				bindingText: lxdCodingMachinePlan(snapBinding).text,
				snapshotId: SNAPSHOT_ID,
				snapshotImageFingerprint: SNAP_FP,
				snapshotBuildNeeded: false,
			}),
			fallbackResponse: () => ({
				schema: "qorpera.coding-machine-plan/v1",
				state: "planned",
				machineId: baseBinding.machineId,
				binding: baseBinding,
				bindingText: baseText,
				snapshotBuildNeeded: true,
			}),
		});

		await expect(host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000))).rejects.toThrow(
			"REACHED_RUN_AFTER_PLAN",
		);

		expect(calls.map((c) => c.method)).toEqual([
			"qorpera_plan_coding_machine",
			"qorpera_fallback_coding_machine_base_image",
			"qorpera_authorize_coding_machine_run",
		]);
		const runCall = calls.find((c) => c.method === "qorpera_authorize_coding_machine_run");
		expect(runCall?.args.p_binding_text).toBe(baseText);
	});

	it("rejects an arbitrary unconfirmed snapshot imageFingerprint in #plan", async () => {
		const claim = makeClaim();
		const bogusBinding = makeBinding(claim, UNCONFIRMED_FP);

		const { host } = await createHost({
			hasImage: () => true,
			planResponse: () => ({
				schema: "qorpera.coding-machine-plan/v1",
				state: "planned",
				machineId: bogusBinding.machineId,
				binding: bogusBinding,
				bindingText: lxdCodingMachinePlan(bogusBinding).text,
			}),
		});

		await expect(host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000))).rejects.toThrow(
			"CODING_HOST_MACHINE_POLICY_DIFFERS",
		);
	});

	it("fails with structured CodingWorkspaceFailed when repository setup file is invalid", async () => {
		const refused = await parseCodingSetup({
			async read(path) {
				if (path === ".qorpera/environment.json") {
					return { kind: "file", bytes: Buffer.from('{"unknownKey": true}') };
				}
				return { kind: "missing" };
			},
		});
		const claim = makeClaim();
		const { host, calls } = await createHost({
			repositories: {
				prepare: vi.fn(async () => ({ cwd: "/company/code/acme/app/worktrees/w" })),
				export: vi.fn(async () => null),
				readSetup: vi.fn(async () => refused),
			},
			planResponse: () => ({}),
		});

		await expect(host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000))).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof CodingWorkspaceFailed &&
				error.message === "CODING_SETUP_REFUSED" &&
				error.summary.includes(".qorpera/environment.json"),
		);
		expect(calls).toHaveLength(0);
	});
});
