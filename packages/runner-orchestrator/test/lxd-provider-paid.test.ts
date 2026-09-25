import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaidComputerGuardRecord, PaidComputerPermit } from "../src/computer-paid-guard.ts";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstanceRecord,
	LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import { LxdCloudRunnerProviderBackend, type LxdCloudRunnerProviderConfig } from "../src/lxd-provider.ts";
import type { CloudRunnerWork } from "../src/orchestrator.ts";
import type {
	RuntimeComputerContext,
	RuntimeComputerController,
	RuntimeComputerFunding,
} from "../src/runtime-computer-controller.ts";

vi.mock("../src/runtime-node-host.ts", () => ({
	readRuntimeNodeHost: async () => ({
		machineIdSha256: "e".repeat(64),
		cpuMillis: 16000,
		memoryBytes: 64 * 1024 ** 3,
	}),
}));
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "native-paid-"));
	roots.push(root);
	const runId = randomUUID(),
		userId = randomUUID(),
		runnerId = randomUUID();
	const work: CloudRunnerWork = {
		runId,
		jobId: randomUUID(),
		profileId: randomUUID(),
		environmentId: randomUUID(),
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: randomUUID(),
		substrateVersionId: randomUUID(),
		companySnapshotId: randomUUID(),
		staffAgentId: randomUUID(),
		staffVersion: 1,
		inputIds: [randomUUID()],
		transcriptStartSequence: 1,
		deadlineAt: "2099-09-25T12:00:00Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: userId,
		computeTemplateKey: "qorpera-member-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: "f".repeat(64),
		workerClass: "managed_sandbox",
		requestedByUserId: userId,
		sponsoredByUserId: userId,
		sponsor: {
			bindingId: randomUUID(),
			version: 1,
			kind: "member_connection",
			providerConnectionId: randomUUID(),
			providerConnectionVersion: 1,
			provider: "openai",
			authenticationMode: "native_subscription",
			nativeHarness: "codex-cli",
			allowAutonomous: false,
		},
		modelPolicy: {
			provider: "openai",
			model: "gpt-test",
			maxCalls: 1,
			maxInputTokens: 1000,
			maxOutputTokens: 100,
			maxCostMicrousd: 1,
		},
		attempt: 1,
	};
	const config: LxdCloudRunnerProviderConfig = {
		adapterId: "native",
		supabaseUrl: "https://example.supabase.co",
		supabaseServiceKey: "guest-service-key",
		supabasePublishableKey: "publishable-key",
		stateRoot: join(root, "state"),
		project: "native",
		jobProfile: "native-v1",
		networkInterface: "enp5s0",
		imageServer: "local",
		imageFingerprint: "a".repeat(64),
		storagePool: "native",
		identityVolumePrefix: "identity-",
		identityVolumeSize: "32GiB",
		rootDiskSize: "64GiB",
		cpuLimit: 4,
		memoryLimit: "8GiB",
		guestAssignmentPort: 8082,
		guestAssignmentSource: "10.41.0.1",
		nativeBridgePort: 8083,
		nativeExecutionGid: 42041,
		guestReadyTimeoutMs: 10000,
		runnerImage: `registry.example/qorpera@sha256:${"b".repeat(64)}`,
		runnerPodmanPath: "/usr/bin/podman",
		runnerEntrypoint: "/opt/qorpera/run-job",
		runnerVersion: "test",
		codexPath: "/usr/local/bin/codex",
		claudePath: "/usr/local/bin/claude",
	};
	const effects: string[] = [],
		volumes = new Map<string, LxdStorageVolumeRecord>();
	let instance: LxdInstanceRecord | undefined,
		managed = false,
		bound = false;
	const lxd = {
		getInstance: vi.fn(async () => (instance ? structuredClone(instance) : undefined)),
		getInstanceState: vi.fn(async () => ({
			status: instance?.status ?? "Stopped",
			statusCode: instance?.statusCode ?? 102,
			network: {},
		})),
		getStorageVolume: vi.fn(async (_project: string, _pool: string, name: string) => volumes.get(name)),
		createStorageVolume: vi.fn(async (_project: string, _pool: string, request: LxdCreateStorageVolumeRequest) => {
			volumes.set(request.name, {
				name: request.name,
				type: request.type,
				contentType: request.content_type,
				description: request.description,
				config: request.config,
			});
		}),
		createInstance: vi.fn(async (_project: string, request: LxdCreateInstanceRequest) => {
			effects.push("create");
			expect(managed).toBe(true);
			instance = {
				name: request.name,
				type: "virtual-machine",
				status: "Stopped",
				statusCode: 102,
				profiles: [...request.profiles],
				config: request.config,
				expandedConfig: request.config,
				devices: request.devices,
				expandedDevices: request.devices,
			};
		}),
		setInstancePower: vi.fn(async () => {
			throw new Error("paid path bypassed guard");
		}),
		pushInstanceFile: vi.fn(async () => undefined),
		execInstance: vi.fn(async () => undefined),
		deleteInstance: vi.fn(async () => {
			expect(instance?.status).toBe("Stopped");
			effects.push("delete");
			instance = undefined;
		}),
	} satisfies LxdClient;
	let permit: PaidComputerPermit | undefined;
	const usage = {
		ensure: vi.fn(async (context: RuntimeComputerContext): Promise<RuntimeComputerFunding> => {
			effects.push("fund");
			managed = true;
			permit ??= {
				schema: "qorpera.computer-usage-permit/v1",
				mode: "paid",
				permitId: randomUUID(),
				allocationId: context.allocationId,
				instanceSha256: context.instanceSha256,
				nodeId: randomUUID(),
				epoch: randomUUID(),
				generation: 1,
				reservationId: randomUUID(),
				hostBootId: randomUUID(),
				guestBootId: null,
				physicalId: null,
				issuedAt: "2026-09-25T12:00:00Z",
				deadline: "2026-09-25T12:05:30Z",
				validForMs: 330000,
				windowMs: 300000,
				stopReserveMs: 30000,
				tariffVersion: 1,
				cpuMillis: 4000,
				memoryBytes: 8 * 1024 ** 3,
				state: "prepared",
			};
			return { mode: "paid", permit };
		}),
		recover: vi.fn(async () => {
			managed = true;
			effects.push("recover");
			return "paid" as const;
		}),
		manages: vi.fn(() => managed),
		start: vi.fn(async () => {
			effects.push("guard-start");
			instance!.status = "Running";
			instance!.statusCode = 103;
			return { project: config.project, instanceName: instance!.name, operationId: randomUUID() };
		}),
		stop: vi.fn(async () => {
			effects.push("guard-stop");
			instance!.status = "Stopped";
			instance!.statusCode = 102;
			return { phase: "stopped", stopReceipt: { state: "stopped" } } as PaidComputerGuardRecord;
		}),
		observe: vi.fn(async () => {
			effects.push(instance ? "bind" : "settle");
			if (!instance) managed = false;
			else bound = true;
		}),
		assertRunning: vi.fn(async () => {
			if (!bound || instance?.status !== "Running") throw new Error("paid running proof missing");
		}),
		maintain: vi.fn(async () => undefined),
	} satisfies Pick<
		RuntimeComputerController,
		"ensure" | "recover" | "manages" | "start" | "stop" | "observe" | "maintain" | "assertRunning"
	>;
	const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const name = String(url),
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (name.endsWith("qorpera_provision_execution_runner"))
			return Response.json({
				runner_id: runnerId,
				runner_kind: "qorpera_computer",
				status: "pending",
				provider_adapter: config.adapterId,
				compute_identity_id: work.computeIdentityId,
				logical_computer_id: null,
				worker_class: work.workerClass,
				template_key: work.computeTemplateKey,
				template_version: work.computeTemplateVersion,
				compute_policy_sha256: work.computePolicySha256,
				capabilities: ["agent_turn"],
			});
		if (name.endsWith("qorpera_release_runtime_machine")) {
			effects.push("release");
			expect(managed).toBe(false);
			return Response.json({
				state: "released",
				allocationId: body.p_allocation_id,
				instanceSha256: body.p_instance_sha256,
			});
		}
		throw new Error(`unprotected admission ${name}`);
	}) as typeof fetch;
	const guest = { waitReady: vi.fn(async () => "10.41.0.2"), deliver: vi.fn(async () => undefined) };
	const backend = new LxdCloudRunnerProviderBackend(config, lxd, guest, fetcher, usage);
	return {
		config,
		work,
		usage,
		lxd,
		guest,
		backend,
		effects,
		fetcher,
		get instance() {
			return instance;
		},
		restart() {
			managed = false;
			return new LxdCloudRunnerProviderBackend(config, lxd, guest, fetcher, usage);
		},
	};
}
describe("native provider funded lifecycle", () => {
	it("funds before creation, binds before work delivery, then guarded-stop/delete/settlement precede capacity release", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const runner = await f.backend.acquire(f.work.runId, f.work, signal);
		expect(f.effects.indexOf("fund")).toBeLessThan(f.effects.indexOf("create"));
		expect(f.effects.indexOf("guard-start")).toBeLessThan(f.effects.indexOf("bind"));
		expect(f.lxd.setInstancePower).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(join(f.config.stateRoot, f.work.runId, "journal.json"), "utf8"))).toMatchObject({
			paidComputer: true,
			capacityRegistered: true,
		});
		await f.backend.stop(runner, "idle", signal);
		expect(f.effects.slice(-4)).toEqual(["guard-stop", "delete", "settle", "release"]);
	});
	it("does not create or start on funding refusal and never falls back to unprotected admission", async () => {
		const f = await fixture();
		f.usage.ensure.mockRejectedValue(new Error("allowance exhausted"));
		await expect(f.backend.acquire(f.work.runId, f.work, new AbortController().signal)).rejects.toThrow(
			"allowance exhausted",
		);
		expect(f.lxd.createInstance).not.toHaveBeenCalled();
		expect(f.usage.start).not.toHaveBeenCalled();
	});
	it("retains physical custody when settlement is unavailable after stop", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const runner = await f.backend.acquire(f.work.runId, f.work, signal);
		f.usage.observe.mockRejectedValueOnce(new Error("settlement down"));
		await expect(f.backend.stop(runner, "idle", signal)).rejects.toThrow("settlement down");
		expect(f.instance).toBeUndefined();
		expect(f.effects).toContain("guard-stop");
		expect(f.effects).not.toContain("release");
	});
	it("restores accounting from durable paid journals in the independent maintenance loop", async () => {
		const f = await fixture();
		await f.backend.acquire(f.work.runId, f.work, new AbortController().signal);
		await f.restart().maintainComputerUsage(new AbortController().signal);
		expect(f.usage.recover).toHaveBeenCalledOnce();
		expect(f.usage.maintain).toHaveBeenCalledOnce();
		expect(f.usage.start).toHaveBeenCalledOnce();
	});
	it("keeps managed renewal running when a retained journal cannot be read or recovered", async () => {
		const f = await fixture();
		await f.backend.acquire(f.work.runId, f.work, new AbortController().signal);
		const broken = join(f.config.stateRoot, randomUUID());
		await mkdir(broken);
		await writeFile(join(broken, "journal.json"), "invalid journal");
		await expect(f.backend.maintainComputerUsage(new AbortController().signal)).rejects.toThrow(
			"usage is unconfirmed",
		);
		expect(f.usage.maintain).toHaveBeenCalledOnce();
		f.usage.recover.mockRejectedValueOnce(new Error("retained enrollment unavailable"));
		await expect(f.restart().maintainComputerUsage(new AbortController().signal)).rejects.toThrow(
			"usage is unconfirmed",
		);
		expect(f.usage.maintain).toHaveBeenCalledTimes(2);
	});
});
