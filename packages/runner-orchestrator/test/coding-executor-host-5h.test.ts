import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentPlug } from "../src/agent-plug.ts";
import { type CodingSessionClaim, type CodingTurnState, CodingWorkspaceFailed } from "../src/coding-executor.ts";
import {
	CODING_HOST_RPCS,
	codingTurnScope,
	LxdCodingExecutorHost,
	type LxdCodingExecutorHostOptions,
} from "../src/coding-executor-host.ts";
import type { CodingFolderRepositories } from "../src/coding-folder-repositories.ts";
import type { CodingHostLeases } from "../src/coding-host-lease.ts";
import { type LxdCodingMachineBinding, lxdCodingMachineName, lxdCodingMachinePlan } from "../src/coding-machine.ts";
import { parseCodingSetup } from "../src/coding-setup.ts";
import { CodingSetupLifecycle } from "../src/coding-setup-lifecycle.ts";
import type { CodingSnapshotBuilder, CodingSnapshotBuildRequest } from "../src/coding-snapshots.ts";
import type { LxdInstanceExecStreamClient, LxdInstanceRecord } from "../src/lxd-client.ts";

vi.mock("../src/coding-storage.ts", () => ({
	createCodingNasStorage: (policy: { rootPath: string }) => ({
		controlPath: `${policy.rootPath}/control`,
		prepareControl: async () => undefined,
		assertControl: async () => undefined,
		prepare: async (binding: { custodySource?: string; dataSource?: string }) => {
			if (binding?.custodySource) await mkdir(binding.custodySource, { recursive: true, mode: 0o700 });
			if (binding?.dataSource) await mkdir(binding.dataSource, { recursive: true, mode: 0o700 });
		},
		assert: async (binding: { custodySource?: string; dataSource?: string }) => {
			if (binding?.custodySource) await mkdir(binding.custodySource, { recursive: true, mode: 0o700 });
			if (binding?.dataSource) await mkdir(binding.dataSource, { recursive: true, mode: 0o700 });
		},
	}),
}));

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const BASE_FP = hash("base-image");
const SNAP_FP = hash("snapshot-image");
const UNCONFIRMED_FP = hash("unconfirmed-image");
const SNAPSHOT_ID = "88888888-8888-4888-8888-888888888888";
const BASE_SHA = "a".repeat(40);
const MACHINE_SHA = hash("node-5h");
const BOOT_ID = "99999999-9999-4999-8999-999999999999";
const NODE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TURN_ID = codingTurnScope(
	"11111111-1111-4111-8111-111111111111",
	"77777777-7777-4777-8777-777777777777",
	1,
).requestId;

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
		turnId: TURN_ID,
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

function makeInstance(binding: LxdCodingMachineBinding, running: boolean): LxdInstanceRecord {
	const plan = lxdCodingMachinePlan(binding);
	const plugged = withAgentPlug(plan.request, "network", "0e:51:0a:d2:01:02");
	return {
		name: lxdCodingMachineName(binding.machineId),
		type: "virtual-machine",
		status: running ? "Running" : "Stopped",
		statusCode: running ? 103 : 102,
		profiles: [],
		config: {
			...plugged.config,
			"volatile.base_image": binding.imageFingerprint,
		},
		expandedConfig: {
			...plugged.config,
			"volatile.base_image": binding.imageFingerprint,
		},
		devices: { ...plugged.devices },
		expandedDevices: { ...plugged.devices },
	};
}

describe("LxdCodingExecutorHost 5h snapshot planning, authority, and setup lifecycle", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function createHost(options: {
		planResponse: (args: Record<string, unknown>) => Record<string, unknown>;
		fallbackResponse?: () => Record<string, unknown>;
		heartbeatError?: Error;
		hasImage?: (fingerprint: string) => boolean;
		existingInstance?: LxdInstanceRecord;
		repositories?: CodingFolderRepositories;
		snapshotBuilder?: CodingSnapshotBuilder;
		setupLifecycle?: CodingSetupLifecycle;
		fullFolderLifecycle?: { binding: LxdCodingMachineBinding };
	}) {
		const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-host-5h-")));
		tempDirs.push(root);
		const controlPath = join(root, "control");
		await mkdir(join(controlPath, "machines"), { recursive: true, mode: 0o700 });
		await mkdir(join(controlPath, "guests"), { recursive: true, mode: 0o700 });
		await chmod(controlPath, 0o700);
		await chmod(join(controlPath, "machines"), 0o700);
		await chmod(join(controlPath, "guests"), 0o700);
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const guestCommands: string[] = [];
		const guestEvents: string[] = [];
		const guestCommandOutputs = new Map<string, Buffer>();
		const claim = makeClaim();
		const storagePolicy = {
			schema: "qorpera.coding-nas-policy/v1" as const,
			mountPoint: root,
			rootPath: root,
			source: "192.168.1.40:/coding",
			serverAddress: "192.168.1.40",
		};
		let liveInstance = options.existingInstance;
		const client = {
			getInstance: vi.fn(async () => liveInstance),
			getInstanceState: vi.fn(async () => ({ status: "Running", statusCode: 103, network: {} })),
			getStorageVolume: vi.fn(async () => undefined),
			createStorageVolume: vi.fn(async () => undefined),
			deleteStorageVolume: vi.fn(async () => true),
			createInstance: vi.fn(async () => undefined),
			setInstancePower: vi.fn(async () => undefined),
			pushInstanceFile: vi.fn(async () => undefined),
			execInstance: vi.fn(async () => undefined),
			deleteInstance: vi.fn(async () => undefined),
			readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) => {
				if (path === "/proc/sys/kernel/random/boot_id") {
					return { content: Buffer.from(`${BOOT_ID}\n`), uid: 0, gid: 0, mode: 0o444 };
				}
				return { content: Buffer.alloc(0), uid: 0, gid: 0, mode: 0o644 };
			}),
			submitInstanceOperation: vi.fn(async (_project: string, action: { action: string }) => {
				if (options.fullFolderLifecycle) {
					if (action.action === "create") {
						liveInstance = makeInstance(options.fullFolderLifecycle.binding, false);
					} else if (action.action === "start") {
						liveInstance = makeInstance(options.fullFolderLifecycle.binding, true);
					}
					return {
						project: "coding",
						instanceName: lxdCodingMachineName(options.fullFolderLifecycle.binding.machineId),
						operationId: randomUUID(),
					};
				}
				throw new Error("STOP_AFTER_PLAN");
			}),
			inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
			replaceInstanceDevices: vi.fn(async () => undefined),
			hasImage: vi.fn(async (_project: string, fp: string) => options.hasImage?.(fp) ?? fp === BASE_FP),
			allowsAgentCard: vi.fn(async () => true),
		};
		const fullBinding = options.fullFolderLifecycle?.binding;
		const fullPlan = fullBinding ? lxdCodingMachinePlan(fullBinding) : null;
		const attachmentToken = randomUUID();
		const control = {
			call: vi.fn(async (method: string, args: Record<string, unknown>) => {
				calls.push({ method, args });
				if (method === "qorpera_heartbeat_coding_session") {
					if (options.heartbeatError) throw options.heartbeatError;
					return { ok: true };
				}
				if (method === "qorpera_plan_coding_machine") return options.planResponse(args);
				if (method === "qorpera_fallback_coding_machine_base_image") {
					return options.fallbackResponse ? options.fallbackResponse() : options.planResponse(args);
				}
				if (method === "qorpera_authorize_coding_machine_run") {
					if (fullBinding && fullPlan) {
						return {
							schema: "qorpera.coding-machine-admission/v1",
							machineId: fullBinding.machineId,
							instanceSha256: fullPlan.instanceSha256,
							intent: "run",
							workerId: claim.workerId,
							guestUid: 200000,
							validForMs: 5_000,
							nodeId: NODE_ID,
							nodeVersion: 1,
						};
					}
					throw new Error("REACHED_RUN_AFTER_PLAN");
				}
				if (method === "qorpera_authorize_coding_machine_custody" && fullBinding && fullPlan) {
					const intent = String(args.p_intent ?? "detach");
					if (intent === "rebuild") {
						return { state: "refused", reason: "MACHINE_NO_NEW_DISK" };
					}
					return {
						schema: "qorpera.coding-machine-admission/v1",
						machineId: fullBinding.machineId,
						instanceSha256: fullPlan.instanceSha256,
						intent,
						workerId: claim.workerId,
						guestUid: 200000,
						validForMs: 5_000,
						nodeId: NODE_ID,
						nodeVersion: 1,
					};
				}
				if (method === "qorpera_attach_coding_session") {
					return {
						schema: "qorpera.coding-attachment/v1",
						state: "attached",
						workerId: claim.workerId,
						machineId: fullBinding?.machineId,
						attachmentToken,
						validForMs: 60_000,
						turn: { sequence: claim.sequence, turnId: TURN_ID, open: true },
					};
				}
				if (method === "qorpera_authorize_coding_command") {
					return {
						schema: "qorpera.coding-command-authority/v1",
						state: "authorized",
						commandId: args.p_command_id,
						validForMs: 30_000,
					};
				}
				if (method === "qorpera_record_coding_machine_folder_restart") {
					return {
						schema: "qorpera.coding-machine-folder-restart/v1",
						machineId: fullBinding?.machineId,
						state: "unmarked",
						detached: [],
					};
				}
				if (method === "qorpera_list_coding_machines" && fullBinding && fullPlan) {
					return [
						{
							schema: "qorpera.coding-machine-state/v1",
							machineId: fullBinding.machineId,
							kind: "member",
							binding: fullBinding,
							instanceSha256: fullPlan.instanceSha256,
							asleepSince: null,
							live: true,
							reserved: true,
							released: false,
							sleepDue: false,
							removeDue: false,
							superseded: false,
							removing: false,
							lastError: null,
							attached: [{ workerId: claim.workerId, attachmentToken }],
						},
					];
				}
				if (method === "qorpera_keep_coding_attachments" && fullBinding) {
					return {
						schema: "qorpera.coding-attachments/v1",
						machineId: fullBinding.machineId,
						sessions: [
							{
								workerId: claim.workerId,
								attachmentToken,
								state: "release",
								reason: "IDLE",
							},
						],
					};
				}
				if (method === "qorpera_record_coding_session_detached") {
					return {
						schema: "qorpera.coding-detached/v1",
						workerId: claim.workerId,
						state: "detached",
					};
				}
				return {};
			}),
		};
		const folderClient: LxdInstanceExecStreamClient = {
			async execInstanceStream(_project, _name, request) {
				const verb = request.command[2];
				const payload = JSON.parse(Buffer.from(request.stdin ?? []).toString("utf8")) as Record<string, unknown>;
				if (verb === "run") {
					const cmd = String(payload.command ?? "");
					guestCommands.push(cmd);
					guestEvents.push(`run:${cmd}`);
					const out =
						cmd.includes("setsid") || cmd.includes("nohup") ? Buffer.from("7777\n") : Buffer.from("ok\n");
					guestCommandOutputs.set(String(payload.commandId), out);
					const header = JSON.stringify({
						schema: "qorpera.coding-guest-command/v1",
						workerId: payload.workerId,
						commandId: payload.commandId,
						state: "exited",
						exit: { code: 0, signal: null },
						end: out.byteLength,
					});
					return { exitCode: 0, stdout: Buffer.from(`${header}\n`), stderr: Buffer.alloc(0) };
				}
				if (verb === "output") {
					const out = guestCommandOutputs.get(String(payload.commandId)) ?? Buffer.alloc(0);
					const offset = Number(payload.offset ?? 0);
					const slice = out.subarray(offset);
					const header = JSON.stringify({
						schema: "qorpera.coding-guest-output/v1",
						workerId: payload.workerId,
						commandId: payload.commandId,
						state: "exited",
						exit: { code: 0, signal: null },
						end: out.byteLength,
						offset,
						bytes: slice.byteLength,
						gap: 0,
					});
					return {
						exitCode: 0,
						stdout: Buffer.concat([Buffer.from(`${header}\n`), slice]),
						stderr: Buffer.alloc(0),
					};
				}
				if (verb === "quiesce") {
					guestEvents.push("quiesce");
					return {
						exitCode: 0,
						stdout: Buffer.from(
							`${JSON.stringify({ schema: "qorpera.coding-guest-session-quiesced/v1", workerId: payload.workerId })}\n`,
						),
						stderr: Buffer.alloc(0),
					};
				}
				if (verb === "stop-session") {
					guestEvents.push("stop-session");
					return {
						exitCode: 0,
						stdout: Buffer.from(
							`${JSON.stringify({ schema: "qorpera.coding-guest-session-stopped/v1", workerId: payload.workerId })}\n`,
						),
						stderr: Buffer.alloc(0),
					};
				}
				return {
					exitCode: 0,
					stdout: Buffer.from(
						`${JSON.stringify({
							schema: "qorpera.coding-guest-status/v2",
							workerId: payload.workerId,
							commands: [],
							usage: { bootId: BOOT_ID, cpuUsageUsec: 0, ioBytes: 0, ioComplete: true, uptimeMs: 1000 },
						})}\n`,
					),
					stderr: Buffer.alloc(0),
				};
			},
		};
		const hostOptions: LxdCodingExecutorHostOptions = {
			control,
			owner: "coding-host",
			machineIdSha256: MACHINE_SHA,
			journalRoot: controlPath,
			storagePolicy,
			vmPolicy: makeVmPolicy(),
			client: client as unknown as LxdCodingExecutorHostOptions["client"],
			agentPlug: async () => "0e:51:0a:d2:01:02",
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
				hold: vi.fn(async () => []),
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
				client: folderClient,
				repositories: options.repositories,
			},
			snapshotBuilder: options.snapshotBuilder,
			setupLifecycle: options.setupLifecycle,
		};
		const host = new LxdCodingExecutorHost(hostOptions);
		return { host, claim, calls, client, guestCommands, guestEvents };
	}

	it("includes qorpera_fallback_coding_machine_base_image in CODING_HOST_RPCS", () => {
		expect(CODING_HOST_RPCS).toContain("qorpera_fallback_coding_machine_base_image");
	});

	it("checks live session authority via heartbeat before reading setup and sends p_setup_digest to #plan (F8)", async () => {
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
				start: vi.fn(async () => ({ baseSha: BASE_SHA, cwd: "/company/code/acme/app/worktrees/w" })),
				prepare: vi.fn(async () => ({ cwd: "/company/code/acme/app/worktrees/w" })),
				export: vi.fn(async () => null),
				readSetup: vi.fn(async (session, _sha, signal) => {
					await session.assertAuthorized(signal);
					return parsed;
				}),
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

		expect(calls.map((c) => c.method).slice(0, 2)).toEqual([
			"qorpera_heartbeat_coding_session",
			"qorpera_plan_coding_machine",
		]);
		const planCall = calls.find((c) => c.method === "qorpera_plan_coding_machine");
		expect(planCall?.args.p_setup_digest).toBe(parsed.setupDigest);
		expect(client.hasImage).toHaveBeenCalledWith("coding", SNAP_FP, expect.any(AbortSignal));
		const runCall = calls.find((c) => c.method === "qorpera_authorize_coding_machine_run");
		expect(runCall?.args.p_binding_text).toBe(snapText);
	});

	it("aborts readSetup before #plan when session heartbeat authority is rejected (F8)", async () => {
		const claim = makeClaim();
		const { host, calls } = await createHost({
			heartbeatError: new Error("SESSION_LEASE_ENDED"),
			repositories: {
				start: vi.fn(async () => ({ baseSha: BASE_SHA, cwd: "/company/code/acme/app/worktrees/w" })),
				prepare: vi.fn(async () => ({ cwd: "/company/code/acme/app/worktrees/w" })),
				export: vi.fn(async () => null),
				readSetup: vi.fn(async (session, _sha, signal) => {
					await session.assertAuthorized(signal);
					throw new Error("SHOULD_NOT_REACH");
				}),
			},
			planResponse: () => ({}),
		});

		await expect(host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000))).rejects.toThrow(
			"SESSION_LEASE_ENDED",
		);
		expect(calls.map((c) => c.method)).toEqual(["qorpera_heartbeat_coding_session"]);
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
				start: vi.fn(async () => ({ baseSha: BASE_SHA, cwd: "/company/code/acme/app/worktrees/w" })),
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

	it("runs worktree install on a snapshot machine, authenticates archiveCommit, and stops setup terminals on detach (F3, F5, F8)", async () => {
		const parsed = await parseCodingSetup({
			async read(path) {
				if (path === ".qorpera/environment.json") {
					return {
						kind: "file",
						bytes: Buffer.from(
							JSON.stringify({
								install: "npm ci",
								start: "npm run codegen",
								terminals: [{ name: "dev", command: "npm run dev" }],
							}),
						),
					};
				}
				return { kind: "missing" };
			},
		});
		const claim = makeClaim();
		const snapBinding = makeBinding(claim, SNAP_FP);
		const snapText = lxdCodingMachinePlan(snapBinding).text;
		const enqueued: CodingSnapshotBuildRequest[] = [];
		const lifecycle = new CodingSetupLifecycle();
		let archiveAuthCalled = false;

		const { host, calls, guestCommands, guestEvents } = await createHost({
			hasImage: (fp) => fp === BASE_FP || fp === SNAP_FP,
			fullFolderLifecycle: { binding: snapBinding },
			setupLifecycle: lifecycle,
			snapshotBuilder: {
				enqueue: (req: CodingSnapshotBuildRequest) => {
					enqueued.push(req);
					return true;
				},
			} as unknown as CodingSnapshotBuilder,
			repositories: {
				start: vi.fn(async () => ({ baseSha: BASE_SHA, cwd: "/company/code/acme/app/worktrees/w" })),
				prepare: vi.fn(async () => ({ cwd: "/company/code/acme/app/worktrees/w" })),
				export: vi.fn(async () => null),
				readSetup: vi.fn(async (session, _sha, signal) => {
					await session.assertAuthorized(signal);
					return parsed;
				}),
				archiveCommit: vi.fn(async (session, _sha, signal) => {
					await session.assertAuthorized(signal);
					archiveAuthCalled = true;
					return Buffer.from("tar-bytes");
				}),
			},
			planResponse: () => ({
				schema: "qorpera.coding-machine-plan/v1",
				state: "planned",
				machineId: snapBinding.machineId,
				binding: snapBinding,
				bindingText: snapText,
				snapshotId: SNAPSHOT_ID,
				snapshotImageFingerprint: SNAP_FP,
				snapshotBuildNeeded: true,
			}),
		});

		const workspace = await host.prepareWorkspace(claim, makeTurn(claim), AbortSignal.timeout(5_000));
		expect(workspace.vmId).toBe(snapBinding.machineId);

		expect(guestCommands.some((cmd) => cmd.includes("npm ci"))).toBe(true);
		expect(guestCommands.some((cmd) => cmd.includes("npm run codegen"))).toBe(true);
		expect(guestCommands.some((cmd) => cmd.includes("npm run dev"))).toBe(true);
		expect(lifecycle.trackedTerminals(snapBinding.machineId, claim.workerId)).toHaveLength(1);
		expect(lifecycle.trackedTerminals(snapBinding.machineId, claim.workerId)[0].pid).toBe(7777);

		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].profileId).toBe(claim.profileId);
		const runAuthBeforeArchive = calls.filter((c) => c.method === "qorpera_authorize_coding_machine_run").length;
		const archive = await enqueued[0].readArchive?.(AbortSignal.timeout(5_000));
		expect(archive?.toString("utf8")).toBe("tar-bytes");
		expect(archiveAuthCalled).toBe(true);
		expect(calls.filter((c) => c.method === "qorpera_authorize_coding_machine_run").length).toBeGreaterThan(
			runAuthBeforeArchive,
		);

		host.endTurn(claim);
		await host.keep(AbortSignal.timeout(5_000));
		const settled = await host.settled();
		expect(settled).toContainEqual({
			machineId: snapBinding.machineId,
			workerId: claim.workerId,
			step: "detach",
			state: "done",
			code: "IDLE",
		});
		const killIdx = guestEvents.findIndex((event) => event.includes("kill -TERM -7777 7777"));
		const quiesceIdx = guestEvents.indexOf("quiesce");
		const stopIdx = guestEvents.indexOf("stop-session");
		expect(killIdx).toBeGreaterThanOrEqual(0);
		expect(quiesceIdx).toBeGreaterThan(killIdx);
		expect(stopIdx).toBeGreaterThan(quiesceIdx);
		expect(lifecycle.trackedTerminals(snapBinding.machineId, claim.workerId)).toHaveLength(0);
	});
});
