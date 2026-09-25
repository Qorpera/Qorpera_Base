import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	PaidComputerGuardRecord,
	PaidComputerPermit,
	PaidComputerPrestartRecord,
} from "../src/computer-paid-guard.ts";
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
		setInstancePower: vi.fn(async (): Promise<void> => {
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
	let prestart: PaidComputerPrestartRecord | null = null;
	const usage = {
		prestartStatus: vi.fn(async () => prestart),
		abandonUndispatched: vi.fn(async () => {
			if (!prestart || prestart.state === "dispatched") throw new Error("cannot abandon");
			prestart.state = "abandoned";
			managed = false;
			effects.push("abandon");
		}),
		ensure: vi.fn(async (context: RuntimeComputerContext): Promise<RuntimeComputerFunding> => {
			if (prestart?.state === "abandoned") throw new Error("COMPUTER_START_ABANDONED");
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
			prestart ??= {
				schema: "qorpera.computer-prestart-record/v1",
				guardIncarnationId: randomUUID(),
				requestStartedUptimeMs: 1000,
				state: "registered",
				abandonment: null,
				intent: {
					schema: "qorpera.computer-prestart-intent/v1",
					permitId: context.allocationId,
					allocationId: context.allocationId,
					instanceSha256: context.instanceSha256,
					hostMachineIdSha256: "e".repeat(64),
					hostBootId: permit.hostBootId,
					prepareSha256: "a".repeat(64),
					prepareRequestText: JSON.stringify(context),
				},
			};
			return { mode: "paid", permit };
		}),
		recover: vi.fn(async () => {
			managed = prestart?.state !== "abandoned";
			effects.push("recover");
			return "paid" as const;
		}),
		manages: vi.fn(() => managed),
		start: vi.fn(async () => {
			if (!prestart || prestart.state === "abandoned") throw new Error("COMPUTER_START_ABANDONED");
			prestart.state = "dispatched";
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
		| "ensure"
		| "recover"
		| "manages"
		| "start"
		| "stop"
		| "observe"
		| "maintain"
		| "assertRunning"
		| "prestartStatus"
		| "abandonUndispatched"
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
		disappear() {
			instance = undefined;
		},
		removeAutostart() {
			if (!instance) throw new Error("fixture instance missing");
			const config = { ...instance.config },
				expandedConfig = { ...instance.expandedConfig };
			delete config["boot.autostart"];
			delete expandedConfig["boot.autostart"];
			instance = { ...instance, config, expandedConfig };
		},
		appear(request: LxdCreateInstanceRequest) {
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
		},
		restart() {
			managed = false;
			return new LxdCloudRunnerProviderBackend(config, lxd, guest, fetcher, usage);
		},
	};
}
describe("native provider funded lifecycle", () => {
	it("allows legacy shadow cleanup without an explicit autostart setting", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const runner = await f.backend.acquire(f.work.runId, f.work, signal);
		const path = join(f.config.stateRoot, f.work.runId, "journal.json"),
			journal = JSON.parse(await readFile(path, "utf8"));
		delete journal.paidComputer;
		delete journal.createDispatched;
		await writeFile(path, JSON.stringify(journal));
		f.removeAutostart();
		f.lxd.setInstancePower.mockImplementation(async () => {
			f.instance!.status = "Stopped";
			f.instance!.statusCode = 102;
		});
		f.restart();
		const legacy = new LxdCloudRunnerProviderBackend(f.config, f.lxd, f.guest, f.fetcher);
		await legacy.stop(runner, "idle", signal);
		expect(f.lxd.setInstancePower).toHaveBeenCalledOnce();
		expect(f.lxd.deleteInstance).toHaveBeenCalledOnce();
		expect(f.effects).toContain("release");
		expect(f.usage.abandonUndispatched).not.toHaveBeenCalled();
	});
	it("holds legacy ambiguous creates without redispatch or automatic allowance cancellation", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const path = join(f.config.stateRoot, f.work.runId, "journal.json");
		let crashJournal: Record<string, unknown> | undefined;
		f.lxd.createInstance.mockImplementationOnce(async () => {
			crashJournal = JSON.parse(await readFile(path, "utf8"));
			throw new Error("process died");
		});
		f.usage.abandonUndispatched.mockRejectedValueOnce(new Error("process gone"));
		await expect(f.backend.acquire(f.work.runId, f.work, signal)).rejects.toThrow();
		delete crashJournal!.createDispatched;
		await writeFile(path, JSON.stringify(crashJournal));
		f.usage.abandonUndispatched.mockClear();
		const restarted = f.restart();
		await expect(restarted.acquire(f.work.runId, f.work, signal)).rejects.toThrow("prestart recovery is unconfirmed");
		await expect(restarted.reconcile(signal)).rejects.toThrow("Legacy native create requires custody recovery");
		expect(f.lxd.createInstance).toHaveBeenCalledOnce();
		expect(f.usage.abandonUndispatched).not.toHaveBeenCalled();
		expect(f.usage.start).not.toHaveBeenCalled();
		expect(f.effects).not.toContain("release");
	});
	it("never redispatches an unresolved create on direct acquire replay after process replacement", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const path = join(f.config.stateRoot, f.work.runId, "journal.json");
		let crashJournal: Buffer | undefined, delayed: LxdCreateInstanceRequest | undefined;
		f.lxd.createInstance.mockImplementationOnce(async (_project, request) => {
			crashJournal = await readFile(path);
			delayed = request;
			throw new Error("process died during create");
		});
		f.usage.abandonUndispatched.mockRejectedValueOnce(new Error("process gone before cancellation"));
		await expect(f.backend.acquire(f.work.runId, f.work, signal)).rejects.toThrow("prestart recovery is unconfirmed");
		// Restore exactly the durable boundary at process death, before cleanup
		// could publish a cancellation marker or receive the delayed VM.
		await writeFile(path, crashJournal!);
		f.usage.abandonUndispatched.mockClear();
		const restarted = f.restart();
		await expect(restarted.acquire(f.work.runId, f.work, signal)).rejects.toThrow(
			"create custody remains unresolved",
		);
		expect(f.lxd.createInstance).toHaveBeenCalledOnce();
		expect(f.usage.start).not.toHaveBeenCalled();
		await restarted.reconcile(signal);
		expect(f.effects).not.toContain("release");
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			createDispatched: true,
			paidStartAbandoned: true,
		});
		expect(JSON.parse(await readFile(path, "utf8")).deletionConfirmed).toBeUndefined();
		f.appear(delayed!);
		await f.restart().reconcile(signal);
		expect(f.effects.indexOf("delete")).toBeLessThan(f.effects.indexOf("release"));
		expect(f.effects).toContain("release");
		expect(f.lxd.createInstance).toHaveBeenCalledOnce();
		expect(f.usage.start).not.toHaveBeenCalled();
	});
	it.each(["acquire", "reconcile"])(
		"releases known completed creation custody after a registered guest disappears during %s recovery",
		async (action) => {
			const f = await fixture(),
				signal = new AbortController().signal;
			await f.backend.acquire(f.work.runId, f.work, signal);
			f.disappear();
			const restarted = f.restart();
			if (action === "acquire")
				await expect(restarted.acquire(f.work.runId, f.work, signal)).rejects.toThrow(
					"Journaled LXD guest is missing",
				);
			else await restarted.reconcile(signal);
			expect(
				JSON.parse(await readFile(join(f.config.stateRoot, f.work.runId, "journal.json"), "utf8")),
			).toMatchObject({
				physicalState: "lost",
				createDispatched: true,
				deletionConfirmed: true,
				capacityReleased: true,
			});
			expect(f.effects.slice(-2)).toEqual(["settle", "release"]);
			expect(f.lxd.createInstance).toHaveBeenCalledOnce();
			expect(f.usage.start).toHaveBeenCalledOnce();
			await restarted.reconcile(signal);
			expect(f.effects.filter((effect) => effect === "release")).toHaveLength(1);
		},
	);
	it("releases secretly committed capacity before settling a stale reserving journal with a lost prepare response", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const path = join(f.config.stateRoot, f.work.runId, "journal.json");
		const prepare = f.usage.ensure.getMockImplementation()!;
		let crashJournal: Record<string, unknown> | undefined;
		f.usage.ensure.mockImplementationOnce(async (context) => {
			await prepare(context);
			crashJournal = JSON.parse(await readFile(path, "utf8"));
			throw new Error("process died after prepare committed");
		});
		f.usage.abandonUndispatched.mockRejectedValueOnce(new Error("process gone before cancellation"));
		await expect(f.backend.acquire(f.work.runId, f.work, signal)).rejects.toThrow("prestart recovery is unconfirmed");
		expect(crashJournal).toMatchObject({ physicalState: "reserving" });
		expect(crashJournal?.capacityRegistered).toBeUndefined();
		expect(crashJournal?.paidComputer).toBeUndefined();
		await writeFile(
			path,
			JSON.stringify({ ...crashJournal, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() }),
		);
		await f.restart().reconcile(signal);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			physicalState: "lost",
			paidStartAbandoned: true,
			deletionConfirmed: true,
			capacityReleased: true,
		});
		expect(f.effects.slice(-2)).toEqual(["abandon", "release"]);
		expect(f.lxd.createInstance).not.toHaveBeenCalled();
		await f.restart().reconcile(signal);
		expect(f.effects.filter((effect) => effect === "release")).toHaveLength(1);
	});
	it("cancels a lost prepare reply before any VM creation and keeps the acquisition unreplayable", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const prepare = f.usage.ensure.getMockImplementation()!;
		f.usage.ensure.mockImplementationOnce(async (context) => {
			await prepare(context);
			throw new Error("prepare reply lost");
		});
		await expect(f.backend.acquire(f.work.runId, f.work, signal)).rejects.toThrow("prepare reply lost");
		expect(f.lxd.createInstance).not.toHaveBeenCalled();
		expect(f.usage.abandonUndispatched).toHaveBeenCalledOnce();
		const journal = JSON.parse(await readFile(join(f.config.stateRoot, f.work.runId, "journal.json"), "utf8"));
		expect(journal).toMatchObject({
			physicalState: "stopping",
			paidStartCancellation: true,
			paidStartAbandoned: true,
		});
		expect(journal.deletionConfirmed).toBeUndefined();
		const restarted = f.restart();
		await restarted.reconcile(signal);
		await expect(restarted.acquire(f.work.runId, f.work, signal)).rejects.toThrow("cannot be replayed");
		expect(f.effects).toContain("release");
	});
	it("returns an unused hold but retains unknown create custody until a late stopped VM is deleted", async () => {
		const f = await fixture(),
			signal = new AbortController().signal;
		const create = f.lxd.createInstance.getMockImplementation()!;
		let delayed: Parameters<typeof create> | undefined;
		f.lxd.createInstance.mockImplementationOnce(async (...args) => {
			delayed = args;
			throw new Error("create reply lost");
		});
		await expect(f.backend.acquire(f.work.runId, f.work, signal)).rejects.toThrow("create reply lost");
		expect(f.usage.abandonUndispatched).toHaveBeenCalledOnce();
		await f.restart().reconcile(signal);
		expect(f.effects).not.toContain("release");
		expect(f.usage.start).not.toHaveBeenCalled();
		// A request already dispatched before cancellation can appear later.
		expect(delayed?.[1].config["boot.autostart"]).toBe("false");
		f.appear(delayed![1]);
		await f.restart().reconcile(signal);
		expect(f.effects).toContain("delete");
		expect(f.effects).toContain("release");
		expect(f.usage.start).not.toHaveBeenCalled();
	});
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
