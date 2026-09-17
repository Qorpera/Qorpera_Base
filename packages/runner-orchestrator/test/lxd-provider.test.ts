import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import { lxdNativeNodePolicy, lxdResourceBytes } from "../src/lxd-native-node-policy.ts";
import {
	HttpLxdGuestTransport,
	LxdCloudRunnerProviderBackend,
	type LxdCloudRunnerProviderConfig,
	type LxdGuestTransport,
} from "../src/lxd-provider.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";
import { readRuntimeNodeHost } from "../src/runtime-node-host.ts";
import { nodeAdmissionFixture } from "./fixtures/node-admission.ts";

vi.mock("../src/runtime-node-host.ts", () => ({ readRuntimeNodeHost: vi.fn() }));
const nodeHost = { machineIdSha256: "e".repeat(64), cpuMillis: 16000, memoryBytes: 64 * 1024 ** 3 };
beforeEach(() => {
	vi.mocked(readRuntimeNodeHost)
		.mockReset()
		.mockResolvedValue({ ...nodeHost });
});

const roots: string[] = [];
const runId = "20000000-0000-4000-8000-000000000001";
const runnerId = "20000000-0000-4000-8000-000000000002";
const secretBrokerCa = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf-8",
);
const secretBrokerCaSha256 = createHash("sha256").update(secretBrokerCa).digest("hex");

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "qorpera-lxd-provider-"));
	roots.push(value);
	return value;
}

function work(): CloudRunnerWork {
	return {
		runId,
		jobId: "20000000-0000-4000-8000-000000000003",
		profileId: "20000000-0000-4000-8000-000000000004",
		environmentId: "20000000-0000-4000-8000-000000000005",
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: "20000000-0000-4000-8000-000000000006",
		substrateVersionId: "20000000-0000-4000-8000-000000000007",
		companySnapshotId: "20000000-0000-4000-8000-000000000008",
		staffAgentId: "20000000-0000-4000-8000-000000000009",
		staffVersion: 1,
		inputIds: ["20000000-0000-4000-8000-000000000010"],
		transcriptStartSequence: 1,
		deadlineAt: "2099-08-21T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		computeIdentityId: "20000000-0000-4000-8000-000000000011",
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: "20000000-0000-4000-8000-000000000012",
		computeTemplateKey: "qorpera-member-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: "f".repeat(64),
		workerClass: "managed_sandbox",
		requestedByUserId: "20000000-0000-4000-8000-000000000012",
		sponsoredByUserId: "20000000-0000-4000-8000-000000000012",
		sponsor: {
			bindingId: "20000000-0000-4000-8000-000000000013",
			version: 1,
			kind: "member_connection",
			providerConnectionId: "20000000-0000-4000-8000-000000000014",
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
			maxInputTokens: 1_000_000,
			maxOutputTokens: 100_000,
			maxCostMicrousd: 1,
		},
		attempt: 1,
	};
}

function companyWork(): CloudRunnerWork {
	return {
		...work(),
		workerClass: "company_computer",
		logicalComputerId: "20000000-0000-4000-8000-000000000017",
	};
}

class FakeLxd implements LxdClient {
	instance?: LxdInstanceRecord;
	volume?: LxdStorageVolumeRecord;
	volumes = new Map<string, LxdStorageVolumeRecord>();
	profileDevices: Record<string, Record<string, string>> = {};
	profileConfig: Record<string, string> = {};
	createCalls: LxdCreateInstanceRequest[] = [];
	createVolumeCalls: LxdCreateStorageVolumeRequest[] = [];
	powerCalls: LxdInstancePowerAction[] = [];
	filePushes: Array<{ path: string; content: string; mode: number }> = [];
	execCalls: string[][] = [];
	deleteCalls: string[] = [];

	async getInstance(_project: string, name: string): Promise<LxdInstanceRecord | undefined> {
		return this.instance?.name === name ? structuredClone(this.instance) : undefined;
	}

	async getInstanceState(): Promise<LxdInstanceStateRecord> {
		return {
			status: this.instance?.status ?? "Stopped",
			statusCode: this.instance?.statusCode ?? 102,
			network: {
				enp5s0: { addresses: [{ family: "inet", address: "10.41.0.2", scope: "global" }] },
			},
		};
	}

	async getStorageVolume(_project: string, _pool: string, name: string): Promise<LxdStorageVolumeRecord | undefined> {
		const volume = this.volumes.get(name) ?? (this.volume?.name === name ? this.volume : undefined);
		return volume ? structuredClone(volume) : undefined;
	}

	async createStorageVolume(_project: string, _pool: string, request: LxdCreateStorageVolumeRequest): Promise<void> {
		this.createVolumeCalls.push(structuredClone(request));
		this.volume = {
			name: request.name,
			type: request.type,
			contentType: request.content_type,
			description: request.description,
			config: structuredClone(request.config),
		};
		this.volumes.set(request.name, structuredClone(this.volume));
	}

	async createInstance(_project: string, request: LxdCreateInstanceRequest): Promise<void> {
		this.createCalls.push(structuredClone(request));
		this.instance = {
			name: request.name,
			type: request.type,
			status: "Stopped",
			statusCode: 102,
			config: structuredClone(request.config),
			profiles: [...request.profiles],
			devices: structuredClone(request.devices),
			expandedDevices: structuredClone({ ...this.profileDevices, ...request.devices }),
			expandedConfig: structuredClone({ ...this.profileConfig, ...request.config }),
		};
	}

	async setInstancePower(_project: string, _name: string, action: LxdInstancePowerAction): Promise<void> {
		this.powerCalls.push(action);
		if (!this.instance) throw new Error("missing fake instance");
		this.instance = {
			...this.instance,
			status: action === "start" ? "Running" : "Stopped",
			statusCode: action === "start" ? 103 : 102,
		};
	}

	async pushInstanceFile(_project: string, _name: string, path: string, content: string, mode: number): Promise<void> {
		if (this.instance?.status !== "Running") throw new Error("fake VM agent is unavailable");
		this.filePushes.push({ path, content, mode });
	}

	async execInstance(_project: string, _name: string, command: readonly string[]): Promise<void> {
		if (this.instance?.status !== "Running") throw new Error("fake VM agent is unavailable");
		this.execCalls.push([...command]);
	}

	async deleteInstance(_project: string, name: string): Promise<void> {
		if (!this.instance || this.instance.name !== name) throw new Error("missing fake instance");
		if (this.instance.status !== "Stopped") throw new Error("fake guest is still running");
		this.deleteCalls.push(name);
		this.instance = undefined;
	}
}

class FakeGuest implements LxdGuestTransport {
	readyCalls = 0;
	deliveries: CloudRunnerAssignmentDelivery[] = [];

	async waitReady(): Promise<string> {
		this.readyCalls++;
		return "10.41.0.2";
	}

	async deliver(
		_address: string,
		_port: number,
		_assignmentToken: string,
		delivery: CloudRunnerAssignmentDelivery,
	): Promise<void> {
		this.deliveries.push(structuredClone(delivery));
	}
}

function config(stateRoot: string): LxdCloudRunnerProviderConfig {
	return {
		adapterId: "lxd",
		supabaseUrl: "https://example.supabase.co",
		supabaseServiceKey: "sb_secret_private",
		supabasePublishableKey: "publishable-key",
		stateRoot,
		project: "qorpera-runners",
		jobProfile: "qorpera-job-v1",
		networkInterface: "enp5s0",
		imageServer: "https://images.example.com/",
		imageFingerprint: "a".repeat(64),
		storagePool: "qorpera-vm",
		identityVolumePrefix: "identity-",
		identityVolumeSize: "32GiB",
		rootDiskSize: "64GiB",
		cpuLimit: 4,
		memoryLimit: "8GiB",
		guestAssignmentPort: 8082,
		guestAssignmentSource: "10.41.0.1",
		nativeBridgePort: 8083,
		nativeExecutionGid: 42041,
		guestReadyTimeoutMs: 10_000,
		runnerImage: `registry.example/qorpera@sha256:${"b".repeat(64)}`,
		runnerPodmanPath: "/usr/bin/podman",
		runnerEntrypoint: "/opt/qorpera/run-job",
		runnerVersion: "test",
		codexPath: "/usr/local/bin/codex",
		claudePath: "/usr/local/bin/claude",
	};
}

function fetchProvisioner(
	requests: Array<{ url: string; body: Record<string, unknown> }>,
	expectedWork: CloudRunnerWork = work(),
): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		expect(init?.redirect).toBe("error");
		const url = String(input);
		if (url.includes("qorpera_reserve_runtime_node_machine"))
			return Response.json(nodeAdmissionFixture(JSON.parse(String(init?.body))));
		if (url.includes("qorpera_reserve_runtime_machine") || url.includes("qorpera_release_runtime_machine")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({
				state: url.includes("qorpera_reserve_runtime_machine") ? "reserved" : "released",
				allocationId: body.p_allocation_id,
				instanceSha256: body.p_instance_sha256,
			});
		}
		requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		return new Response(
			JSON.stringify({
				runner_id: runnerId,
				runner_kind: "qorpera_computer",
				status: "pending",
				provider_adapter: "lxd",
				compute_identity_id: expectedWork.computeIdentityId,
				logical_computer_id: expectedWork.logicalComputerId ?? null,
				worker_class: expectedWork.workerClass,
				template_key: expectedWork.computeTemplateKey,
				template_version: expectedWork.computeTemplateVersion,
				compute_policy_sha256: expectedWork.computePolicySha256,
				capabilities: ["agent_turn"],
			}),
			{ status: url.includes("qorpera_provision_execution_runner") ? 200 : 404 },
		);
	}) as typeof fetch;
}

function governedConfig(stateRoot: string): LxdCloudRunnerProviderConfig {
	return {
		...config(stateRoot),
		nativeCompanyRuntime: {
			mode: "company-path-v1",
			codexPath: "/opt/qorpera-harnesses/native-company/codex",
			binarySha256: "a".repeat(64),
			objectGatewayUrl: "https://objects.example.test",
			objectGatewayToken: "q".repeat(43),
			secretBroker: {
				origin: "https://secrets.example.test",
				runtimeToken: "s".repeat(43),
				caCertificate: secretBrokerCa,
				caSha256: secretBrokerCaSha256,
			},
			network: "qorpera0",
			recoveryVolumePrefix: "native-recovery-",
			recoveryVolumeSize: "1GiB",
		},
	};
}

function delivery(request: CloudRunnerWork): CloudRunnerAssignmentDelivery {
	return {
		assignment: {
			assignmentId: "20000000-0000-4000-8000-000000000015",
			claimId: "20000000-0000-4000-8000-000000000016",
			runId,
			jobId: request.jobId,
			runnerId,
			capabilitySha256: "c".repeat(64),
			expiresAt: "2099-08-21T18:00:00.000Z",
		},
		capability: "d".repeat(43),
		work: request,
	};
}

async function acquiredFixture() {
	const directory = await root();
	const stateRoot = join(directory, "state");
	const lxd = new FakeLxd();
	const guest = new FakeGuest();
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchImplementation = fetchProvisioner(requests);
	const request = work();
	const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);
	await backend.acquire(runId, request, new AbortController().signal);
	return {
		stateRoot,
		lxd,
		guest,
		fetchImplementation,
		request,
		runId,
		journalPath: join(stateRoot, runId, "journal.json"),
	};
}

describe("native physical node policy", () => {
	it("pins public resource and host policy independently of credential rotation", () => {
		const original = governedConfig("/provider-state");
		const before = lxdNativeNodePolicy(original, nodeHost.machineIdSha256);
		const changedSecrets = {
			...original,
			supabaseServiceKey: "rotated-service-key",
			nativeCompanyRuntime: {
				...original.nativeCompanyRuntime!,
				objectGatewayToken: "rotated-object-token",
				secretBroker: { ...original.nativeCompanyRuntime!.secretBroker, runtimeToken: "rotated-broker-token" },
			},
		};
		expect(lxdNativeNodePolicy(changedSecrets, nodeHost.machineIdSha256)).toEqual(before);
		const encoded = JSON.stringify(before.policy);
		for (const secret of [
			original.supabaseServiceKey,
			original.nativeCompanyRuntime!.objectGatewayToken,
			original.nativeCompanyRuntime!.secretBroker.runtimeToken,
		])
			expect(encoded).not.toContain(secret);
		expect(before.policy).toMatchObject({ cpuMillis: 4000, memoryBytes: 8589934592, rootDiskBytes: 68719476736 });
		for (const change of [
			{ cpuLimit: 8 },
			{ memoryLimit: "16GiB" },
			{ imageFingerprint: "b".repeat(64) },
			{ project: "other-project" },
		])
			expect(lxdNativeNodePolicy({ ...original, ...change }, nodeHost.machineIdSha256).policySha256).not.toBe(
				before.policySha256,
			);
		expect(lxdNativeNodePolicy(original, "b".repeat(64)).policySha256).not.toBe(before.policySha256);
	});
	it.each(["0GiB", "1.5GiB", "8GB", "-1GiB", "1GiB\n", "99999999999999999999999999TiB", "1025TiB"])(
		"rejects invalid resource amount %j",
		(value) => {
			expect(() => lxdResourceBytes(value)).toThrow("INVALID_LXD_RESOURCE_BYTES");
		},
	);
	it("uses exact binary units without rounding", () => {
		expect(["1KiB", "1MiB", "1GiB", "1TiB", "1024TiB"].map(lxdResourceBytes)).toEqual([
			1024, 1048576, 1073741824, 1099511627776, 1125899906842624,
		]);
	});
});

describe("LXD cloud runner provider", () => {
	it.each([
		"NODE_CAPACITY_EXHAUSTED",
		"NODE_OBSERVATION_UNAVAILABLE",
		"NODE_PROVIDER_UNCONFIGURED",
		"lost",
		"wrong-cost",
	])("retains the exact allocation without physical creation after node refusal %s", async (reason) => {
		const stateRoot = join(await root(), "state");
		const lxd = new FakeLxd();
		const provision = fetchProvisioner([]);
		const demands: Record<string, unknown>[] = [];
		let refused = true;
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_node_machine")) {
				const args = JSON.parse(String(init?.body));
				demands.push(args);
				if (refused) {
					if (reason === "lost") throw new Error("node reply lost after commit");
					return Response.json(
						reason === "wrong-cost"
							? { ...nodeAdmissionFixture(args), cpuMillis: 1000 }
							: { state: "refused", reason },
					);
				}
			}
			return provision(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow();
		expect(lxd.createVolumeCalls).toHaveLength(0);
		expect(lxd.createCalls).toHaveLength(0);
		expect(lxd.powerCalls).toHaveLength(0);
		const journal = JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf8"));
		expect(journal).toMatchObject({ physicalState: "reserving", capacityRegistered: true });
		expect(journal.nodeCapacity).toBeUndefined();
		refused = false;
		const restarted = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await restarted.acquire(runId, work(), new AbortController().signal);
		expect(demands).toHaveLength(4);
		for (const demand of demands) expect(demand).toEqual(demands[0]);
		expect(demands[0]).toMatchObject({
			p_allocation_id: runId,
			p_provider_kind: "native",
			p_provider_id: "lxd",
			p_machine_id_sha256: nodeHost.machineIdSha256,
			p_cpu_millis: 4000,
			p_memory_bytes: 8 * 1024 ** 3,
		});
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
	});

	it("keeps pre-start node refusal retryable across restart with one charged physical identity", async () => {
		const stateRoot = join(await root(), "state");
		const lxd = new FakeLxd(),
			provision = fetchProvisioner([]);
		let nodeCalls = 0;
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_node_machine") && ++nodeCalls === 3)
				return Response.json({ state: "refused", reason: "NODE_OBSERVATION_UNAVAILABLE" });
			return provision(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"NODE_OBSERVATION_UNAVAILABLE",
		);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toHaveLength(0);
		const journalPath = join(stateRoot, runId, "journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8"));
		expect(journal).toMatchObject({
			physicalState: "creating",
			nodeCapacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
		});
		await new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher).acquire(
			runId,
			work(),
			new AbortController().signal,
		);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
		expect(JSON.parse(await readFile(journalPath, "utf8")).nodeCapacity).toEqual(journal.nodeCapacity);
	});

	it("does not dispatch when host evidence is unavailable or admission arrives after cancellation", async () => {
		const stateRoot = join(await root(), "state"),
			lxd = new FakeLxd();
		const provision = fetchProvisioner([]),
			stop = new AbortController();
		vi.mocked(readRuntimeNodeHost).mockRejectedValueOnce(new Error("RUNTIME_NODE_HOST_UNCONFIRMED"));
		const fetcher: typeof fetch = async (input, init) => {
			const response = await provision(input, init);
			if (String(input).includes("qorpera_reserve_runtime_node_machine")) stop.abort();
			return response;
		};
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), stop.signal)).rejects.toThrow("RUNTIME_NODE_HOST_UNCONFIRMED");
		await expect(backend.acquire(runId, work(), stop.signal)).rejects.toThrow();
		expect(lxd.createCalls).toHaveLength(0);
		expect(lxd.createVolumeCalls).toHaveLength(0);
		expect(lxd.powerCalls).toHaveLength(0);
		expect(
			vi.mocked(provision).mock.calls.some(([url]) => String(url).includes("qorpera_release_runtime_machine")),
		).toBe(false);
	});

	it("requires node accounting for retained legacy guests and rejects cheaper resource enrollment", async () => {
		const f = await acquiredFixture();
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		delete journal.nodeCapacity;
		await writeFile(f.journalPath, JSON.stringify(journal));
		const cheaper = new LxdCloudRunnerProviderBackend(
			{ ...config(f.stateRoot), cpuLimit: 2 },
			f.lxd,
			f.guest,
			f.fetchImplementation,
		);
		await expect(cheaper.reconcile()).rejects.toThrow("immutable provider authority");
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await expect(backend.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"machine-capacity inventory",
		);
		await backend.reconcile();
		expect(JSON.parse(await readFile(f.journalPath, "utf8")).nodeCapacity).toMatchObject({
			cpuMillis: 4000,
			memoryBytes: 8 * 1024 ** 3,
		});
		await backend.acquire(runId, f.request, new AbortController().signal);
		expect(f.lxd.createCalls).toHaveLength(1);
	});

	it.each(["host", "cpu", "node"])("refuses changed %s placement on restart", async (changed) => {
		const f = await acquiredFixture();
		if (changed === "host")
			vi.mocked(readRuntimeNodeHost).mockResolvedValue({ ...nodeHost, machineIdSha256: "a".repeat(64) });
		const fetcher: typeof fetch = async (input, init) => {
			if (changed === "node" && String(input).includes("qorpera_reserve_runtime_node_machine"))
				return Response.json({
					...nodeAdmissionFixture(JSON.parse(String(init?.body))),
					nodeId: "36000000-0000-4000-8000-000000000011",
				});
			return f.fetchImplementation(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(
			{ ...config(f.stateRoot), ...(changed === "cpu" ? { cpuLimit: 2 } : {}) },
			f.lxd,
			f.guest,
			fetcher,
		);
		await expect(backend.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"node placement cannot be changed",
		);
		expect(f.lxd.createCalls).toHaveLength(1);
		expect(f.lxd.powerCalls).toEqual(["start"]);
	});

	it("cleans up an admitted VM while node health and enrollment are unavailable", async () => {
		const f = await acquiredFixture();
		const runner = await new LxdCloudRunnerProviderBackend(
			config(f.stateRoot),
			f.lxd,
			f.guest,
			f.fetchImplementation,
		).acquire(runId, f.request, new AbortController().signal);
		vi.mocked(readRuntimeNodeHost).mockRejectedValue(new Error("host unavailable"));
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_node_machine")) throw new Error("node offline");
			return f.fetchImplementation(input, init);
		};
		await new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher).stop(runner, "idle");
		expect(f.lxd.instance).toBeUndefined();
		expect(f.lxd.powerCalls).toEqual(["start", "stop"]);
	});
	it("refuses physical creation on a capacity denial or lost reservation response", async () => {
		for (const lost of [false, true]) {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const provision = fetchProvisioner([]);
			let refused = true;
			const fetcher: typeof fetch = async (input, init) => {
				if (String(input).includes("qorpera_reserve_runtime_machine") && refused) {
					if (lost) throw new Error("reservation response lost");
					return Response.json({ state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" });
				}
				return provision(input, init);
			};
			const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
			await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow();
			expect(lxd.createCalls).toHaveLength(0);
			expect(lxd.powerCalls).toHaveLength(0);
			refused = false;
			await backend.acquire(runId, work(), new AbortController().signal);
			expect(lxd.createCalls).toHaveLength(1);
		}
	});

	it("does not free capacity until deletion actually removes the VM", async () => {
		const f = await acquiredFixture();
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		const runner = await backend.acquire(runId, f.request, new AbortController().signal);
		const deletion = vi.spyOn(f.lxd, "deleteInstance").mockResolvedValue(undefined);
		await expect(backend.stop(runner, "idle")).rejects.toThrow("physical deletion is confirmed");
		const releases = () =>
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		expect(releases()).toHaveLength(0);
		deletion.mockRestore();
		await backend.stop(runner, "idle");
		expect(releases()).toHaveLength(1);
		expect(f.lxd.instance).toBeUndefined();
	});

	it("retains capacity when a timed-out creation may still be pending remotely", async () => {
		const stateRoot = join(await root(), "state");
		const lxd = new FakeLxd();
		vi.spyOn(lxd, "createInstance").mockRejectedValue(new Error("remote operation response lost"));
		const fetcher = fetchProvisioner([]);
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow();
		await backend.reconcile(new AbortController().signal);
		expect(
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine")),
		).toHaveLength(0);
	});

	it("retries lost capacity cleanup after restart using persisted deletion proof", async () => {
		const f = await acquiredFixture();
		let loseRelease = true;
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_release_runtime_machine") && loseRelease)
				throw new Error("release response lost");
			return f.fetchImplementation(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		const runner = await backend.acquire(runId, f.request, new AbortController().signal);
		await expect(backend.stop(runner, "idle")).rejects.toThrow("release response lost");
		expect(f.lxd.instance).toBeUndefined();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({
			physicalState: "stopping",
			deletionConfirmed: true,
		});
		loseRelease = false;
		const restarted = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		await restarted.reconcile();
		expect(
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine")),
		).toHaveLength(1);
		expect(f.lxd.createCalls).toHaveLength(1);
	});

	it("retires a finished guest even when an earlier reserving journal is refused by the ceiling", async () => {
		// Live defect (14 Sep 2026, one-slot node): two room wakes materialized together; the second
		// acquisition was journaled "reserving" and refused by the ceiling on every pass, and because it
		// sorted first the finished first guest was never retired, so the slot never freed.
		const f = await acquiredFixture();
		const reservingId = "10000000-0000-4000-8000-000000000001";
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		const reserving = {
			...journal,
			acquisitionId: reservingId,
			...(journal.runId === undefined ? {} : { runId: reservingId }),
			instanceName: `qorpera-${reservingId.replaceAll("-", "")}`,
			physicalState: "reserving",
		};
		delete reserving.nodeCapacity;
		delete reserving.guestAddress;
		delete reserving.assignmentId;
		await mkdir(join(f.stateRoot, reservingId), { recursive: true, mode: 0o700 });
		await writeFile(join(f.stateRoot, reservingId, "journal.json"), JSON.stringify(reserving), { mode: 0o600 });
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_machine")) {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				if (body.p_allocation_id === reservingId)
					return Response.json({ state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" });
			}
			return f.fetchImplementation(input, init);
		};
		if (!f.lxd.instance) throw new Error("fixture guest missing");
		f.lxd.instance = { ...f.lxd.instance, status: "Stopped", statusCode: 102 };
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		// 16 Sep 2026: reconcile no longer re-runs a refused reservation at all; the reserving
		// journal waits for the orchestrator's acquire, and the finished guest is retired cleanly.
		await backend.reconcile();
		expect(f.lxd.instance).toBeUndefined();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({ physicalState: "stopped" });
		expect(
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine")),
		).toHaveLength(1);
		expect(JSON.parse(await readFile(join(f.stateRoot, reservingId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "reserving",
		});
	});
	it("retires a reserving journal that made no progress for ten minutes", async () => {
		const f = await acquiredFixture();
		const reservingId = "10000000-0000-4000-8000-000000000002";
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		const stale = new Date(Date.now() - 11 * 60_000).toISOString();
		const reserving = {
			...journal,
			acquisitionId: reservingId,
			...(journal.runId === undefined ? {} : { runId: reservingId }),
			instanceName: `qorpera-${reservingId.replaceAll("-", "")}`,
			physicalState: "reserving",
			createdAt: stale,
			updatedAt: stale,
		};
		delete reserving.nodeCapacity;
		delete reserving.guestAddress;
		delete reserving.assignmentId;
		await mkdir(join(f.stateRoot, reservingId), { recursive: true, mode: 0o700 });
		await writeFile(join(f.stateRoot, reservingId, "journal.json"), JSON.stringify(reserving), { mode: 0o600 });
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await backend.reconcile();
		expect(JSON.parse(await readFile(join(f.stateRoot, reservingId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "lost",
		});
		const releases = vi
			.mocked(f.fetchImplementation)
			.mock.calls.filter(
				([url, init]) =>
					String(url).includes("qorpera_release_runtime_machine") && String(init?.body).includes(reservingId),
			);
		expect(releases).toHaveLength(reserving.capacityRegistered ? 1 : 0);
	});
	it("reports a typed admission refusal from the reservation", async () => {
		const directory = await root();
		const stateRoot = join(directory, "state");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const base = fetchProvisioner(requests);
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_machine"))
				return Response.json({
					state: "refused",
					reason: "NODE_NOT_PREFERRED",
					preferredNodeId: "36000000-0000-4000-8000-000000000010",
				});
			return base(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetcher);
		const failure = await backend
			.acquire(runId, work(), new AbortController().signal)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			name: "LxdMachineAdmissionRefused",
			category: "admission_refused",
			state: "refused",
			reason: "NODE_NOT_PREFERRED",
		});
		expect(lxd.createCalls).toHaveLength(0);
	});
	it("blocks new starts until retained live guests have a capacity record", async () => {
		const f = await acquiredFixture();
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		delete journal.capacityRegistered;
		await writeFile(f.journalPath, JSON.stringify(journal));
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await expect(backend.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"machine-capacity inventory",
		);
		await backend.reconcile();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({ capacityRegistered: true });
		await backend.acquire(runId, f.request, new AbortController().signal);
		expect(f.lxd.createCalls).toHaveLength(1);
	});
	it("journals a full VM before creation and safely adopts it after provider restart", async () => {
		const directory = await root();
		const stateRoot = join(directory, "state");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchImplementation = fetchProvisioner(requests);
		const request = work();
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);

		const runner = await backend.acquire(runId, request, new AbortController().signal);
		expect(runner).toMatchObject({ runnerId, workerClass: "managed_sandbox" });
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.createVolumeCalls).toEqual([
			expect.objectContaining({
				name: `identity-${request.computeIdentityId}`,
				type: "custom",
				content_type: "filesystem",
				config: {
					size: "32GiB",
					"user.qorpera.schema": "qorpera.compute-identity-volume/v1",
					"user.qorpera.compute_identity_id": request.computeIdentityId,
					"user.qorpera.provider_adapter": "lxd",
				},
			}),
		]);
		expect(lxd.createCalls[0]).toMatchObject({
			type: "virtual-machine",
			profiles: ["qorpera-job-v1"],
			config: {
				"boot.mode": "uefi-secureboot",
				"user.qorpera.bootstrap_sha256": expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			source: { fingerprint: "a".repeat(64) },
			devices: {
				root: { pool: "qorpera-vm", size: "64GiB" },
				"compute-identity": {
					source: `identity-${request.computeIdentityId}`,
					path: "/var/lib/qorpera/identity",
				},
			},
		});
		expect(lxd.createCalls[0]?.config["cloud-init.user-data"]).toBeUndefined();
		expect(lxd.powerCalls).toEqual(["start"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.body).toMatchObject({
			p_run_id: runId,
			p_client_runner_id: runId,
			p_provider_adapter: "lxd",
		});

		const journalPath = join(stateRoot, runId, "journal.json");
		const journalText = await readFile(journalPath, "utf-8");
		const activation = await readFile(join(stateRoot, runId, "credentials", "qorpera-runner-activation"), "utf-8");
		const assignment = await readFile(join(stateRoot, runId, "credentials", "qorpera-runner-assignment"), "utf-8");
		const nativeBridge = await readFile(join(stateRoot, runId, "credentials", "qorpera-native-bridge"), "utf-8");
		const createRequestText = JSON.stringify(lxd.createCalls[0]);
		expect(createRequestText).not.toContain(config(stateRoot).supabaseServiceKey);
		expect(createRequestText).not.toContain(activation.trim());
		expect(createRequestText).not.toContain(assignment.trim());
		expect(createRequestText).not.toContain(nativeBridge.trim());
		expect(journalText).not.toContain(activation.trim());
		expect(journalText).not.toContain(assignment.trim());
		expect(journalText).not.toContain(nativeBridge.trim());
		expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(journalText)).toMatchObject({
			schema: "qorpera.lxd-provider-journal/v2",
			physicalState: "registered",
			guestAddress: "10.41.0.2",
			jobType: "agent_turn",
			lxd: {
				type: "virtual-machine",
				identityVolumeSize: "32GiB",
				policySha256: "f".repeat(64),
				bootstrapSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});
		expect(lxd.filePushes).toHaveLength(7);
		expect(lxd.filePushes.every((file) => file.mode === 0o600)).toBe(true);
		expect(lxd.filePushes.map((file) => file.path)).toEqual([
			"/var/lib/qorpera-bootstrap/bootstrap.json",
			"/var/lib/qorpera-bootstrap/runner-config.json",
			"/var/lib/qorpera-bootstrap/native-provider.env",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-runner-activation",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-runner-assignment",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-native-bridge",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-supabase-service-key",
		]);
		expect(lxd.execCalls).toEqual([
			["/usr/bin/test", "-d", "/var/lib/qorpera-bootstrap/credentials"],
			["/usr/bin/systemctl", "enable", "--now", "qorpera-lxd-runner-bootstrap.service"],
		]);

		const restarted = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);
		expect(await restarted.acquire(runId, request, new AbortController().signal)).toEqual(runner);
		expect(lxd.createCalls).toHaveLength(1);
		expect(requests).toHaveLength(1);
		expect(lxd.createVolumeCalls).toHaveLength(1);
		expect(lxd.filePushes).toHaveLength(7);
		expect(lxd.execCalls).toHaveLength(2);

		await restarted.deliver(runner, delivery(request));
		expect(guest.deliveries).toHaveLength(1);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "assigned",
			assignmentId: delivery(request).assignment.assignmentId,
		});
		await restarted.stop(runner, "idle");
		expect(lxd.powerCalls).toEqual(["start", "stop"]);
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(await lxd.getInstance("qorpera-runners", lxd.createCalls[0]?.name ?? "")).toBeUndefined();
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "idle",
		});
		// The stopped journal with no guest is left alone on later reconciles.
		await restarted.reconcile();
		expect(lxd.deleteCalls).toHaveLength(1);
	});

	it("retires a one-run guest once it has powered itself off, and leaves a running guest alone", async () => {
		const { stateRoot, lxd, guest, fetchImplementation, request, runId, journalPath } = await acquiredFixture();
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);
		const before = lxd.execCalls.length;
		await backend.reconcile();
		expect(lxd.execCalls).toHaveLength(before);
		expect(lxd.deleteCalls).toEqual([]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "registered" });
		// The runner unit's ExecStopPost powers the guest off after the run.
		lxd.instance = { ...lxd.instance!, status: "Stopped", statusCode: 102 };
		await backend.reconcile();
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "idle",
		});
		await expect(backend.acquire(runId, request, new AbortController().signal)).rejects.toThrow("cannot be replayed");
	});

	it("continues a sponsor handoff in a fresh attempt while preserving the retired guest and recovery history", async () => {
		const stateRoot = join(await root(), "state");
		const settings = governedConfig(stateRoot);
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const provision = fetchProvisioner(requests);
		const nextRunnerId = "20000000-0000-4000-8000-000000000099";
		const fetcher: typeof fetch = async (input, init) => {
			const response = await provision(input, init);
			if (!String(input).includes("qorpera_provision_execution_runner")) return response;
			const value = (await response.json()) as Record<string, unknown>;
			return Response.json({
				...value,
				runner_id: requests.at(-1)?.body.p_client_runner_id === runId ? runnerId : nextRunnerId,
			});
		};
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetcher);
		const first = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(first, delivery(work()));
		await backend.stop(first, "idle");
		const firstJournalPath = join(stateRoot, runId, "journal.json");
		// Retained pre-change records have no separate attempt or run metadata.
		const firstJournal = JSON.parse(await readFile(firstJournalPath, "utf-8"));
		delete firstJournal.runId;
		delete firstJournal.attempt;
		await writeFile(firstJournalPath, JSON.stringify(firstJournal));
		const history = await readFile(firstJournalPath, "utf-8");
		const oldRecovery = structuredClone(lxd.volumes.get(`native-recovery-${runId}`));
		const resumedWork = {
			...work(),
			attempt: 2,
			sponsor: {
				...work().sponsor,
				version: 2,
				providerConnectionId: "20000000-0000-4000-8000-000000000098",
			},
		};
		const second = await backend.acquire(runId, resumedWork, new AbortController().signal);
		expect(second.runnerId).toBe(nextRunnerId);
		expect(lxd.createCalls).toHaveLength(2);
		expect(lxd.createCalls[1]?.name).not.toBe(lxd.createCalls[0]?.name);
		const acquisitionId = String(requests[1]?.body.p_client_runner_id);
		expect(acquisitionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(acquisitionId).not.toBe(runId);
		expect(requests[1]?.body.p_run_id).toBe(runId);
		expect(lxd.createVolumeCalls).toHaveLength(3);
		expect(lxd.volumes.get(`native-recovery-${runId}`)).toEqual(oldRecovery);
		expect(lxd.volumes.get(`native-recovery-${acquisitionId}`)?.config).toMatchObject({
			"user.qorpera.run_id": runId,
			"user.qorpera.runner_id": nextRunnerId,
		});
		expect(await readFile(join(stateRoot, acquisitionId, "credentials/qorpera-runner-activation"), "utf-8")).not.toBe(
			await readFile(join(stateRoot, runId, "credentials/qorpera-runner-activation"), "utf-8"),
		);
		const bootstrap = lxd.filePushes.filter((file) => file.path.endsWith("/bootstrap.json")).at(-1);
		expect(JSON.parse(bootstrap?.content ?? "null").company_runtime).toMatchObject({
			run_id: runId,
			runner_id: nextRunnerId,
		});
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetcher);
		await restarted.reconcile();
		expect(await restarted.acquire(runId, resumedWork, new AbortController().signal)).toEqual(second);
		expect(lxd.createCalls).toHaveLength(2);
		expect(requests).toHaveLength(2);
		const secondDelivery = delivery(resumedWork);
		secondDelivery.assignment.runnerId = nextRunnerId;
		secondDelivery.assignment.assignmentId = "20000000-0000-4000-8000-000000000097";
		await restarted.deliver(second, secondDelivery);
		expect(guest.deliveries.at(-1)?.work).toEqual(resumedWork);
		await expect(
			restarted.acquire(runId, { ...resumedWork, payload: { changed: true } }, new AbortController().signal),
		).rejects.toThrow("immutable work request");
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"cannot be replayed",
		);
		await restarted.stop(second, "idle");
		await restarted.reconcile();
		expect(lxd.deleteCalls).toHaveLength(2);
		expect(lxd.instance).toBeUndefined();
		expect(await readFile(firstJournalPath, "utf-8")).toBe(history);
		expect(lxd.volumes.get(`native-recovery-${runId}`)).toEqual(oldRecovery);
	});

	it.each(["shutdown", "cancel", "timeout", "drift", "missing-recovery"])(
		"waits for the preceding guest during a sponsor handoff (%s)",
		async (outcome) => {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
			const settings = governedConfig(stateRoot);
			const fetcher = fetchProvisioner(requests);
			const backend = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
			const first = await backend.acquire(runId, work(), new AbortController().signal);
			await backend.deliver(first, delivery(work()));
			const journalPath = join(stateRoot, runId, "journal.json");
			const history = await readFile(journalPath, "utf-8");
			const recovery = structuredClone(lxd.volumes.get(`native-recovery-${runId}`));
			const caller = new AbortController(),
				retirementTimeout = new AbortController();
			const getInstance = lxd.getInstance.bind(lxd);
			let observations = 0;
			const observation = vi.spyOn(lxd, "getInstance").mockImplementation(async (project, name) => {
				if (++observations === 2) {
					expect(requests).toHaveLength(1);
					expect(lxd.createCalls).toHaveLength(1);
					expect(lxd.deleteCalls).toHaveLength(0);
					expect(lxd.powerCalls).toEqual(["start"]);
					if (outcome === "shutdown") lxd.instance = { ...lxd.instance!, status: "Stopped", statusCode: 102 };
					if (outcome === "cancel") caller.abort(new Error("handoff cancelled"));
					if (outcome === "timeout")
						retirementTimeout.abort(new DOMException("Retirement timeout", "TimeoutError"));
					if (outcome === "drift") lxd.instance!.type = "container";
					if (outcome === "missing-recovery") {
						lxd.volumes.delete(`native-recovery-${runId}`);
						lxd.volume = undefined;
					}
				}
				return getInstance(project, name);
			});
			const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
			const timeout = vi
				.spyOn(AbortSignal, "timeout")
				.mockImplementation((ms) =>
					outcome === "timeout" && ms === 120_000 ? retirementTimeout.signal : originalTimeout(ms),
				);
			try {
				const pending = backend.acquire(runId, { ...work(), attempt: 2 }, caller.signal);
				if (outcome === "shutdown") {
					await pending;
					expect(observations).toBeGreaterThan(2);
					expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]!.name]);
					expect(lxd.createCalls).toHaveLength(2);
					expect(lxd.powerCalls).toEqual(["start", "start"]);
					expect(lxd.volumes.get(`native-recovery-${runId}`)).toEqual(recovery);
					expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
						physicalState: "stopped",
						assignmentId: delivery(work()).assignment.assignmentId,
					});
				} else {
					await expect(pending).rejects.toThrow(
						outcome === "cancel"
							? "handoff cancelled"
							: outcome === "drift"
								? "authority"
								: outcome === "missing-recovery"
									? "recovery volume"
									: /aborted|timeout/i,
					);
					expect(requests).toHaveLength(1);
					expect(lxd.createCalls).toHaveLength(1);
					expect(lxd.createVolumeCalls).toHaveLength(2);
					expect(lxd.powerCalls).toEqual(["start"]);
					expect(lxd.deleteCalls).toHaveLength(0);
					expect(await readFile(journalPath, "utf-8")).toBe(history);
					if (outcome === "cancel" || outcome === "timeout") {
						observation.mockRestore();
						timeout.mockRestore();
						lxd.instance = { ...lxd.instance!, status: "Stopped", statusCode: 102 };
						await new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher).acquire(
							runId,
							{ ...work(), attempt: 2 },
							new AbortController().signal,
						);
						expect(lxd.createCalls).toHaveLength(2);
						expect(lxd.volumes.get(`native-recovery-${runId}`)).toEqual(recovery);
					}
				}
			} finally {
				observation.mockRestore();
				timeout.mockRestore();
			}
		},
	);

	it.each(["run", "attempt", "missing-attempt"])(
		"rejects altered %s authority in a governed attempt journal",
		async (field) => {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const backend = new LxdCloudRunnerProviderBackend(
				governedConfig(stateRoot),
				lxd,
				new FakeGuest(),
				fetchProvisioner([]),
			);
			await backend.acquire(runId, work(), new AbortController().signal);
			const path = join(stateRoot, runId, "journal.json");
			const journal = JSON.parse(await readFile(path, "utf-8"));
			if (field === "run") journal.runId = "20000000-0000-4000-8000-000000000098";
			else if (field === "attempt") journal.attempt = 2;
			else delete journal.attempt;
			await writeFile(path, JSON.stringify(journal));
			await expect(backend.reconcile()).rejects.toThrow("journal run attempt is invalid");
			expect(lxd.createCalls).toHaveLength(1);
			expect(lxd.powerCalls).toEqual(["start"]);
		},
	);

	it("retires a guest that exits during startup without restarting its runner", async () => {
		const stateRoot = join(await root(), "state");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchImplementation = fetchProvisioner(requests);
		const providerConfig = governedConfig(stateRoot);
		const backend = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);
		vi.spyOn(guest, "waitReady").mockImplementationOnce(async () => {
			if (!lxd.instance) throw new Error("expected starting guest");
			lxd.instance = { ...lxd.instance, status: "Stopped", statusCode: 102 };
			throw new Error("runner exited during startup");
		});

		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"runner exited during startup",
		);
		const restarted = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);
		await restarted.reconcile();

		expect(lxd.powerCalls).toEqual(["start"]);
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(lxd.instance).toBeUndefined();
		expect(lxd.volumes.size).toBe(2);
		expect(JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "delivery_failed",
		});
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"cannot be replayed",
		);
		expect(requests).toHaveLength(1);
	});

	it("removes a guest an earlier build left behind under a stopped journal", async () => {
		const { stateRoot, lxd, guest, fetchImplementation, journalPath } = await acquiredFixture();
		await lxd.setInstancePower("qorpera-runners", lxd.createCalls[0]?.name ?? "", "stop");
		const journal = JSON.parse(await readFile(journalPath, "utf-8"));
		await writeFile(journalPath, JSON.stringify({ ...journal, physicalState: "stopped", stopReason: "idle" }));
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);
		await backend.reconcile();
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(await lxd.getInstance("qorpera-runners", lxd.createCalls[0]?.name ?? "")).toBeUndefined();
	});

	it.each(["starting", "bootstrapping"])("retires a stopped guest after interruption in %s", async (physicalState) => {
		const { stateRoot, lxd, guest, fetchImplementation, journalPath } = await acquiredFixture();
		const journal = JSON.parse(await readFile(journalPath, "utf-8"));
		await writeFile(journalPath, JSON.stringify({ ...journal, physicalState, guestAddress: undefined }));
		if (!lxd.instance) throw new Error("expected interrupted guest");
		lxd.instance = { ...lxd.instance, status: "Stopped", statusCode: 102 };
		const restarted = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);

		await restarted.reconcile();

		expect(lxd.powerCalls).toEqual(["start"]);
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "delivery_failed",
		});
	});

	it("observes an interrupted bootstrap without invoking the runner unit a second time", async () => {
		const stateRoot = join(await root(), "state");
		const journalPath = join(stateRoot, runId, "journal.json");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const fetchImplementation = fetchProvisioner([]);
		const providerConfig = governedConfig(stateRoot);
		const backend = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);
		let interruptedJournal = "";
		vi.spyOn(guest, "waitReady").mockImplementationOnce(async () => {
			interruptedJournal = await readFile(journalPath, "utf-8");
			throw new Error("simulated provider interruption");
		});
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"simulated provider interruption",
		);
		expect(JSON.parse(interruptedJournal)).toMatchObject({ physicalState: "bootstrapping" });
		// Restore the durable snapshot a killed provider would leave before its
		// rejection handler could persist cleanup. The running guest is unchanged.
		await writeFile(journalPath, interruptedJournal);
		const commandsBefore = structuredClone(lxd.execCalls);
		const restarted = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);

		await restarted.reconcile();

		expect(lxd.execCalls).toEqual(commandsBefore);
		expect(lxd.powerCalls).toEqual(["start"]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "registered" });
	});

	it.each(["starting", "bootstrapping"])(
		"does not recreate a missing guest after its %s intent",
		async (physicalState) => {
			const { stateRoot, lxd, guest, fetchImplementation, request, journalPath } = await acquiredFixture();
			const journal = JSON.parse(await readFile(journalPath, "utf-8"));
			await writeFile(journalPath, JSON.stringify({ ...journal, physicalState }));
			lxd.instance = undefined;
			const restarted = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);

			await expect(restarted.acquire(runId, request, new AbortController().signal)).rejects.toThrow(
				"Journaled LXD guest is missing",
			);

			expect(lxd.createCalls).toHaveLength(1);
			expect(lxd.powerCalls).toEqual(["start"]);
			expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "lost" });
		},
	);

	it("resumes a newly created guest that has no start intent", async () => {
		const stateRoot = join(await root(), "state");
		const journalPath = join(stateRoot, runId, "journal.json");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const fetchImplementation = fetchProvisioner([]);
		const providerConfig = governedConfig(stateRoot);
		const backend = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);
		// A crash after LXD persists creation but before its response reaches the
		// provider leaves a creating journal and a guest that has never started.
		const createInstance = lxd.createInstance.bind(lxd);
		vi.spyOn(lxd, "createInstance").mockImplementationOnce(async (project, request) => {
			await createInstance(project, request);
			throw new Error("creation response lost");
		});
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"creation response lost",
		);
		expect(lxd.powerCalls).toEqual([]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "creating" });
		const restarted = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);

		await restarted.reconcile();

		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "registered" });
	});

	it("finishes cancelled startup cleanup after a deletion failure and refuses acquisition replay", async () => {
		const stateRoot = join(await root(), "state");
		const journalPath = join(stateRoot, runId, "journal.json");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const fetchImplementation = fetchProvisioner([]);
		const providerConfig = governedConfig(stateRoot);
		const backend = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);
		const controller = new AbortController();
		vi.spyOn(guest, "waitReady").mockImplementationOnce(async () => {
			controller.abort(new Error("acquisition cancelled"));
			throw controller.signal.reason;
		});
		await expect(backend.acquire(runId, work(), controller.signal)).rejects.toThrow("acquisition cancelled");
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "stopping" });
		vi.spyOn(lxd, "deleteInstance").mockRejectedValueOnce(new Error("deletion response failed"));
		await expect(backend.reconcile()).rejects.toThrow("deletion response failed");
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow("cannot be replayed");
		const restarted = new LxdCloudRunnerProviderBackend(providerConfig, lxd, guest, fetchImplementation);

		await restarted.reconcile();

		expect(lxd.powerCalls).toEqual(["start", "stop"]);
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(lxd.volumes.size).toBe(2);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "delivery_failed",
		});
	});

	it("does not revive a registered guest when acquisition is retried after poweroff", async () => {
		const { stateRoot, lxd, guest, fetchImplementation, request } = await acquiredFixture();
		if (!lxd.instance) throw new Error("expected registered guest");
		lxd.instance = { ...lxd.instance, status: "Stopped", statusCode: 102 };
		const restarted = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);

		await expect(restarted.acquire(runId, request, new AbortController().signal)).rejects.toThrow(
			"cannot be replayed",
		);

		expect(lxd.powerCalls).toEqual(["start"]);
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
	});

	it("keeps proposal reviews isolated from the live Company File device", async () => {
		const directory = await root();
		const liveCompanyRoot = "/srv/qorpera/company-live";
		const request = work();
		const liveConfig: LxdCloudRunnerProviderConfig = {
			...config(join(directory, "live-state")),
			liveCompanyRoot,
			liveCompanyProfileId: request.profileId,
		};
		const liveLxd = new FakeLxd();
		const liveBackend = new LxdCloudRunnerProviderBackend(liveConfig, liveLxd, new FakeGuest(), fetchProvisioner([]));

		await liveBackend.acquire(runId, request, new AbortController().signal);

		expect(liveLxd.createCalls[0]?.devices["company-live"]).toEqual({
			type: "disk",
			source: liveCompanyRoot,
			path: "/qorpera/company-live",
		});
		const liveRunnerConfig = liveLxd.filePushes.find(
			(file) => file.path === "/var/lib/qorpera-bootstrap/runner-config.json",
		);
		if (!liveRunnerConfig) throw new Error("expected live runner config");
		expect(JSON.parse(liveRunnerConfig.content)).toMatchObject({
			environment: {
				QORPERA_LIVE_COMPANY_ROOT: "/qorpera/company-live",
				QORPERA_LIVE_COMPANY_PROFILE_ID: request.profileId,
			},
		});
		if (!liveLxd.instance) throw new Error("expected live fake instance");
		const liveCompanyDevice = liveLxd.instance.devices["company-live"];
		if (!liveCompanyDevice) throw new Error("expected live Company File device");
		liveLxd.instance = {
			...liveLxd.instance,
			devices: {
				...liveLxd.instance.devices,
				"company-live": {
					...liveCompanyDevice,
					readonly: "true",
				},
			},
		};
		await expect(liveBackend.reconcile()).rejects.toThrow("drifted from immutable provider authority");

		const { sessionId: _sessionId, ...proposalBase } = work();
		const proposalRequest: CloudRunnerWork = {
			...proposalBase,
			sourceKind: "proposal_review",
			inputIds: [],
			transcriptStartSequence: 0,
			jobType: "proposal_review",
			sponsor: { ...proposalBase.sponsor, allowAutonomous: true },
		};
		const proposalLxd = new FakeLxd();
		const proposalBackend = new LxdCloudRunnerProviderBackend(
			{
				...config(join(directory, "proposal-state")),
				liveCompanyRoot,
				liveCompanyProfileId: proposalRequest.profileId,
			},
			proposalLxd,
			new FakeGuest(),
			fetchProvisioner([]),
		);

		await proposalBackend.acquire(runId, proposalRequest, new AbortController().signal);

		expect(proposalLxd.createCalls[0]?.devices["company-live"]).toBeUndefined();
		const proposalRunnerConfig = proposalLxd.filePushes.find(
			(file) => file.path === "/var/lib/qorpera-bootstrap/runner-config.json",
		);
		if (!proposalRunnerConfig) throw new Error("expected proposal-review runner config");
		expect(JSON.parse(proposalRunnerConfig.content)).toMatchObject({ environment: {} });
		if (!proposalLxd.instance) throw new Error("expected proposal-review fake instance");
		proposalLxd.instance = {
			...proposalLxd.instance,
			devices: {
				...proposalLxd.instance.devices,
				"company-live": {
					type: "disk",
					source: liveCompanyRoot,
					path: "/qorpera/company-live",
				},
			},
		};
		await expect(proposalBackend.reconcile()).rejects.toThrow("drifted from immutable provider authority");
	});

	it("uses a pinned local image without a mutable remote image source", async () => {
		const directory = await root();
		const lxd = new FakeLxd();
		const localConfig = { ...config(join(directory, "state")), imageServer: "local" };
		const backend = new LxdCloudRunnerProviderBackend(localConfig, lxd, new FakeGuest(), fetchProvisioner([]));

		await backend.acquire(runId, work(), new AbortController().signal);

		expect(lxd.createCalls[0]?.source).toEqual({ type: "image", fingerprint: "a".repeat(64) });
	});

	it("fails closed when a Compute Identity volume belongs to another identity", async () => {
		const directory = await root();
		const request = work();
		const lxd = new FakeLxd();
		lxd.volume = {
			name: `identity-${request.computeIdentityId}`,
			type: "custom",
			contentType: "filesystem",
			description: "foreign volume",
			config: {
				size: "32GiB",
				"user.qorpera.schema": "qorpera.compute-identity-volume/v1",
				"user.qorpera.compute_identity_id": "20000000-0000-4000-8000-000000000099",
				"user.qorpera.provider_adapter": "lxd",
			},
		};
		const backend = new LxdCloudRunnerProviderBackend(
			config(join(directory, "state")),
			lxd,
			new FakeGuest(),
			fetchProvisioner([]),
		);

		await expect(backend.acquire(runId, request, new AbortController().signal)).rejects.toThrow(
			"volume drifted from immutable provider authority",
		);
		expect(lxd.createCalls).toHaveLength(0);
	});

	it("fails closed when a journaled guest drifts away from full-VM authority", async () => {
		const directory = await root();
		const stateRoot = join(directory, "state");
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const request = work();
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchProvisioner([]));
		await backend.acquire(runId, request, new AbortController().signal);
		if (!lxd.instance) throw new Error("expected fake instance");
		lxd.instance = { ...lxd.instance, type: "container" };

		await expect(backend.reconcile()).rejects.toThrow("drifted from immutable provider authority");
	});

	it("keeps ungoverned long-lived computer work closed", async () => {
		const directory = await root();
		const request = companyWork();
		const backend = new LxdCloudRunnerProviderBackend(
			config(join(directory, "state")),
			new FakeLxd(),
			new FakeGuest(),
			fetchProvisioner([]),
		);
		await expect(backend.acquire(runId, request, new AbortController().signal)).rejects.toThrow(
			"admits company computers only through company-path-v1",
		);
	});

	it("admits the shared logical Company Computer only as a governed one-run VM", async () => {
		const directory = await root();
		const request = companyWork();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([], request));

		const runner = await backend.acquire(runId, request, new AbortController().signal);

		expect(runner).toMatchObject({
			runnerId,
			workerClass: "company_computer",
			logicalComputerId: request.logicalComputerId,
		});
		expect(lxd.createCalls[0]?.config).toMatchObject({
			"user.qorpera.logical_computer_id": request.logicalComputerId,
		});
		expect(lxd.createCalls[0]?.devices["company-live"]).toBeUndefined();
		expect(lxd.createVolumeCalls[1]?.config).toMatchObject({
			"user.qorpera.logical_computer_id": request.logicalComputerId,
			"user.qorpera.schema": "qorpera.native-company-recovery-volume/v1",
		});
		const bootstrapFile = lxd.filePushes.find((file) => file.path === "/var/lib/qorpera-bootstrap/bootstrap.json");
		if (!bootstrapFile) throw new Error("expected governed bootstrap");
		expect(JSON.parse(bootstrapFile.content)).toMatchObject({
			schema: "qorpera.lxd-company-runner-bootstrap/v1",
			logical_computer_id: request.logicalComputerId,
			company_runtime: { mode: "company-path-v1" },
		});
		await backend.deliver(runner, delivery(request));
		expect(guest.deliveries).toEqual([delivery(request)]);
	});

	it("pins a governed lane with independent retained recovery and no canonical mount or shared workspace", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		expect(lxd.createVolumeCalls).toHaveLength(2);
		expect(lxd.createVolumeCalls[1]).toMatchObject({
			name: `native-recovery-${runId}`,
			config: {
				"user.qorpera.schema": "qorpera.native-company-recovery-volume/v1",
				"user.qorpera.run_id": runId,
				"user.qorpera.profile_id": work().profileId,
				"user.qorpera.runner_id": runnerId,
			},
		});
		expect(Object.keys(lxd.createCalls[0]?.devices ?? {}).sort()).toEqual([
			"compute-identity",
			"enp5s0",
			"root",
			"runner-recovery",
		]);
		expect(lxd.createCalls[0]?.devices["runner-recovery"]).toEqual({
			type: "disk",
			pool: "qorpera-vm",
			path: "/var/lib/qorpera-runner",
			source: `native-recovery-${runId}`,
		});
		const files = new Map(lxd.filePushes.map((file) => [file.path, file.content]));
		const bootstrap = JSON.parse(files.get("/var/lib/qorpera-bootstrap/bootstrap.json") ?? "null");
		expect(bootstrap).toMatchObject({
			schema: "qorpera.lxd-company-runner-bootstrap/v1",
			company_runtime: {
				mode: "company-path-v1",
				run_id: runId,
				profile_id: work().profileId,
				runner_id: runnerId,
				binary_sha256: "a".repeat(64),
				secret_broker_ca_sha256: secretBrokerCaSha256,
				recovery_volume_path: "/var/lib/qorpera-runner",
			},
		});
		const runnerConfig = JSON.parse(files.get("/var/lib/qorpera-bootstrap/runner-config.json") ?? "null");
		expect(runnerConfig.native_bridge_shared_gid).toBeUndefined();
		expect(runnerConfig.environment).toEqual({});
		const environment = files.get("/var/lib/qorpera-bootstrap/native-provider.env");
		expect(environment).toContain("QORPERA_NATIVE_RUNTIME=company-path-v1\n");
		expect(environment).toContain("QORPERA_CLOUD_SECRET_BROKER_URL=https://secrets.example.test\n");
		expect(environment).not.toContain("q".repeat(43));
		expect(environment).not.toContain("s".repeat(43));
		expect(files.get("/var/lib/qorpera-bootstrap/credentials/qorpera-native-object-token")).toBe(
			`${"q".repeat(43)}\n`,
		);
		expect(files.get("/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-runtime")).toBe(
			`${"s".repeat(43)}\n`,
		);
		expect(files.get("/var/lib/qorpera-bootstrap/credentials/qorpera-cloud-secret-ca")).toBe(secretBrokerCa);
		const journal = await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8");
		expect(journal).not.toContain("q".repeat(43));
		expect(journal).not.toContain("s".repeat(43));
		expect(JSON.parse(journal)).toMatchObject({ schema: "qorpera.lxd-company-provider-journal/v1" });
		expect(JSON.stringify(lxd.createCalls)).not.toContain("q".repeat(43));
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).resolves.toEqual(runner);
		expect(lxd.createVolumeCalls).toHaveLength(2);
		await restarted.deliver(runner, delivery(work()));
		await restarted.stop(runner, "idle");
		expect(lxd.volumes.has(`native-recovery-${runId}`)).toBe(true);
	});

	it.each(["matching", "foreign-company", "foreign-environment"])(
		"injects only the exact company and environment office route (%s)",
		async (scope) => {
			const settings = governedConfig(join(await root(), "state"));
			const route = {
				companyId: work().profileId,
				environmentId: work().environmentId,
				url: "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
				token: "o".repeat(43),
			};
			if (scope === "foreign-company") route.companyId = "20000000-0000-4000-8000-000000000098";
			if (scope === "foreign-environment") route.environmentId = "20000000-0000-4000-8000-000000000098";
			const foreign = {
				...route,
				companyId: "20000000-0000-4000-8000-000000000097",
				url: route.url.replace("0099", "0097"),
				token: "p".repeat(43),
			};
			settings.nativeCompanyRuntime!.offices = [route, foreign];
			const lxd = new FakeLxd(),
				guest = new FakeGuest();
			const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
			const runner = await backend.acquire(runId, work(), new AbortController().signal);
			const files = new Map(lxd.filePushes.map((file) => [file.path, file.content]));
			const officeCredential = "/var/lib/qorpera-bootstrap/credentials/qorpera-office-native";
			expect(files.get(officeCredential)).toBe(scope === "matching" ? `${route.token}\n` : "");
			expect(lxd.filePushes.find((file) => file.path === officeCredential)?.mode).toBe(0o600);
			const bootstrap = JSON.parse(files.get("/var/lib/qorpera-bootstrap/bootstrap.json")!);
			const journalText = await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8");
			const journal = JSON.parse(journalText);
			if (scope === "matching") {
				expect(bootstrap.company_runtime.office).toEqual({
					environment_id: route.environmentId,
					url: route.url,
					token_sha256: createHash("sha256").update(route.token).digest("hex"),
				});
				expect(journal.lxd.companyRuntime.office).toEqual({
					environmentId: route.environmentId,
					url: route.url,
					tokenSha256: createHash("sha256").update(route.token).digest("hex"),
				});
				expect(files.get("/var/lib/qorpera-bootstrap/native-provider.env")).toContain(
					`QORPERA_COMPANY_COMPUTER_URL=${route.url}\n`,
				);
			} else {
				expect(bootstrap.company_runtime.office).toBeUndefined();
				expect(journal.lxd.companyRuntime.office).toBeUndefined();
				expect(files.get("/var/lib/qorpera-bootstrap/native-provider.env")).not.toContain(
					"QORPERA_COMPANY_COMPUTER_URL",
				);
			}
			for (const secret of [route.token, foreign.token]) {
				expect(journalText).not.toContain(secret);
				expect(JSON.stringify(lxd.createCalls)).not.toContain(secret);
				expect(JSON.stringify(lxd.filePushes.filter((file) => file.path !== officeCredential))).not.toContain(
					secret,
				);
			}
			expect(JSON.stringify(lxd.filePushes)).not.toContain(foreign.token);
			const pushed = lxd.filePushes.length;
			const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
			await expect(restarted.acquire(runId, work(), new AbortController().signal)).resolves.toEqual(runner);
			expect(lxd.filePushes).toHaveLength(pushed);
			expect(lxd.createCalls).toHaveLength(1);
		},
	);

	it("freezes route credentials at construction and refuses changed restart authority", async () => {
		const settings = governedConfig(join(await root(), "state"));
		const route = {
			companyId: work().profileId,
			environmentId: work().environmentId,
			url: "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
			token: "o".repeat(43),
		};
		settings.nativeCompanyRuntime!.offices = [route];
		const lxd = new FakeLxd(),
			guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		route.token = "p".repeat(43);
		await backend.acquire(runId, work(), new AbortController().signal);
		expect(lxd.filePushes.find((file) => file.path.endsWith("/qorpera-office-native"))?.content).toBe(
			`${"o".repeat(43)}\n`,
		);
		const count = lxd.filePushes.length;
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow("journal");
		expect(lxd.filePushes).toHaveLength(count);
	});

	it.each(["retired", "live", "retired-moved"])(
		"keeps only a retired journal readable after an office credential rotation (%s)",
		async (scope) => {
			const settings = governedConfig(join(await root(), "state"));
			const route = {
				companyId: work().profileId,
				environmentId: work().environmentId,
				url: "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
				token: "o".repeat(43),
			};
			settings.nativeCompanyRuntime!.offices = [route];
			const lxd = new FakeLxd(),
				guest = new FakeGuest();
			const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
			const runner = await backend.acquire(runId, work(), new AbortController().signal);
			if (scope !== "live") {
				await backend.stop(runner, "idle");
				await backend.reconcile();
			}
			const path = join(settings.stateRoot, runId, "journal.json");
			const before = await readFile(path, "utf-8");
			expect(JSON.parse(before).physicalState).toBe(scope === "live" ? "registered" : "stopped");
			const rotated = governedConfig(settings.stateRoot);
			rotated.nativeCompanyRuntime!.offices = [
				{
					...route,
					token: "p".repeat(43),
					...(scope === "retired-moved"
						? { url: "https://other.example.test/office/20000000-0000-4000-8000-000000000099/native" }
						: {}),
				},
			];
			const restarted = new LxdCloudRunnerProviderBackend(rotated, lxd, guest, fetchProvisioner([]));
			if (scope === "retired") await expect(restarted.reconcile()).resolves.toBeUndefined();
			else await expect(restarted.reconcile()).rejects.toThrow("journal");
			// The journal keeps the digest of the credential its guest was given.
			expect(await readFile(path, "utf-8")).toBe(before);
		},
	);

	it.each(["environmentId", "url", "tokenSha256", "unknown"])(
		"refuses altered journal office authority (%s)",
		async (kind) => {
			const settings = governedConfig(join(await root(), "state"));
			settings.nativeCompanyRuntime!.offices = [
				{
					companyId: work().profileId,
					environmentId: work().environmentId,
					url: "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
					token: "o".repeat(43),
				},
			];
			const lxd = new FakeLxd(),
				guest = new FakeGuest();
			await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).acquire(
				runId,
				work(),
				new AbortController().signal,
			);
			const path = join(settings.stateRoot, runId, "journal.json");
			const journal = JSON.parse(await readFile(path, "utf-8"));
			journal.lxd.companyRuntime.office[kind] =
				kind === "environmentId"
					? "20000000-0000-4000-8000-000000000098"
					: kind === "url"
						? "https://other.example.test/office/20000000-0000-4000-8000-000000000099/native"
						: "f".repeat(64);
			await writeFile(path, JSON.stringify(journal));
			const count = lxd.filePushes.length;
			await expect(
				new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).acquire(
					runId,
					work(),
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(lxd.filePushes).toHaveLength(count);
			expect(lxd.createCalls).toHaveLength(1);
		},
	);

	it.each(["foreign-disk", "foreign-network", "cloud-init", "raw-qemu", "prototype-key"])(
		"refuses inherited %s before startup or secret injection",
		async (drift) => {
			const directory = await root();
			const lxd = new FakeLxd();
			if (drift === "foreign-disk")
				lxd.profileDevices.hidden = { type: "disk", source: "/srv/company", path: "/company" };
			if (drift === "foreign-network")
				lxd.profileDevices.hidden = { type: "nic", network: "host-network", name: "eth1" };
			if (drift === "cloud-init") lxd.profileConfig["cloud-init.user-data"] = "untrusted init";
			if (drift === "raw-qemu") lxd.profileConfig["raw.qemu"] = "unexpected mount";
			if (drift === "prototype-key")
				lxd.profileConfig = { ...lxd.profileConfig, constructor: "unexpected configuration" };
			const backend = new LxdCloudRunnerProviderBackend(
				governedConfig(join(directory, "state")),
				lxd,
				new FakeGuest(),
				fetchProvisioner([]),
			);
			await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
				"expanded configuration",
			);
			expect(lxd.powerCalls).toEqual([]);
			expect(lxd.filePushes).toEqual([]);
		},
	);

	it("rechecks inherited devices before each assignment delivery", async () => {
		const directory = await root();
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(
			governedConfig(join(directory, "state")),
			lxd,
			guest,
			fetchProvisioner([]),
		);
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		if (!lxd.instance) throw new Error("missing fake guest");
		lxd.instance.expandedDevices = {
			...lxd.instance.expandedDevices,
			bypass: { type: "disk", path: "/company", source: "/srv/company" },
		};
		await expect(backend.deliver(runner, delivery(work()))).rejects.toThrow("expanded configuration");
		expect(guest.deliveries).toEqual([]);
	});

	it.each(["missing", "foreign"])(
		"quarantines %s recovery storage without creating an empty replacement",
		async (kind) => {
			const directory = await root();
			const lxd = new FakeLxd();
			const backend = new LxdCloudRunnerProviderBackend(
				governedConfig(join(directory, "state")),
				lxd,
				new FakeGuest(),
				fetchProvisioner([]),
			);
			await backend.acquire(runId, work(), new AbortController().signal);
			const name = `native-recovery-${runId}`;
			const volume = lxd.volumes.get(name);
			if (!volume) throw new Error("missing recovery fixture");
			if (kind === "missing") {
				lxd.volumes.delete(name);
				lxd.volume = undefined;
			} else volume.config = { ...volume.config, "user.qorpera.profile_id": "foreign-company" };
			await expect(backend.reconcile()).rejects.toThrow(/recovery volume/i);
			expect(lxd.createVolumeCalls).toHaveLength(2);
		},
	);

	it("refuses runtime downgrades and changed pins on journal replay", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		await new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetchProvisioner([])).acquire(
			runId,
			work(),
			new AbortController().signal,
		);
		const downgraded = new LxdCloudRunnerProviderBackend(
			config(settings.stateRoot),
			lxd,
			new FakeGuest(),
			fetchProvisioner([]),
		);
		await expect(downgraded.reconcile()).rejects.toThrow("cannot switch runtime");
		if (!settings.nativeCompanyRuntime) throw new Error("missing governed settings");
		settings.nativeCompanyRuntime.binarySha256 = "b".repeat(64);
		const changed = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetchProvisioner([]));
		await expect(changed.reconcile()).rejects.toThrow("cannot switch runtime");
		expect(lxd.createCalls).toHaveLength(1);
	});

	it("rejects mixed direct-mount and governed runtime configurations", async () => {
		const settings = governedConfig(join(await root(), "state"));
		expect(
			() =>
				new LxdCloudRunnerProviderBackend(
					{ ...settings, liveCompanyRoot: "/srv/company", liveCompanyProfileId: work().profileId },
					new FakeLxd(),
					new FakeGuest(),
					fetchProvisioner([]),
				),
		).toThrow("cannot mount a live Company File");
	});

	it.each([
		"http://example.supabase.co",
		"https://secret@example.supabase.co",
		"https://example.supabase.co/api",
		"https://example.supabase.co/?token=secret",
		"https://example.supabase.co/#other",
		"invalid",
	])("refuses ambiguous or insecure governed control-plane origins (%#)", async (supabaseUrl) => {
		const settings = governedConfig(join(await root(), "state"));
		expect(() => new LxdCloudRunnerProviderBackend({ ...settings, supabaseUrl }, new FakeLxd())).toThrow(
			"exact HTTPS control-plane origin",
		);
	});

	it("reports a powered-off startup guest without waiting for the readiness deadline", async () => {
		const lxd = new FakeLxd();
		const state = vi.spyOn(lxd, "getInstanceState");
		const fetcher = vi.fn<typeof fetch>();
		const transport = new HttpLxdGuestTransport(lxd, fetcher);

		await expect(transport.waitReady("qorpera-runners", "guest", "enp5s0", 8082, 300_000)).rejects.toThrow(
			"powered off before activating",
		);

		expect(state).toHaveBeenCalledTimes(1);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("pins guest transport destinations, refuses redirects, and cancels unused response bodies", async () => {
		const lxd = new FakeLxd();
		vi.spyOn(lxd, "getInstanceState").mockResolvedValue({
			status: "Running",
			statusCode: 103,
			network: {
				enp5s0: {
					hwaddr: "00:16:3e:b9:c4:8c",
					addresses: [{ family: "inet", address: "10.41.0.2", scope: "global" }],
				},
			},
		});
		vi.spyOn(lxd, "getInstance").mockResolvedValue({
			name: "guest",
			type: "virtual-machine",
			status: "Running",
			statusCode: 103,
			config: { "volatile.eth0.hwaddr": "00:16:3e:b9:c4:8c" },
			profiles: [],
			devices: {},
			expandedConfig: {},
			expandedDevices: { eth0: { type: "nic", name: "eth0" } },
		});
		const cancel = vi.fn();
		const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
		});
		const transport = new HttpLxdGuestTransport(lxd, fetcher);
		const address = await transport.waitReady("qorpera-runners", "guest", "eth0", 8082, 1_000);
		expect(address).toBe("10.41.0.2");
		await transport.deliver(address, 8082, "q".repeat(43), delivery(work()));
		expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
			"http://10.41.0.2:8082/healthz",
			"http://10.41.0.2:8082/v1/assignment",
		]);
		expect(cancel).toHaveBeenCalledTimes(2);
		await expect(
			transport.deliver("127.0.0.1@untrusted.test", 8082, "q".repeat(43), delivery(work())),
		).rejects.toThrow("destination or token is invalid");
		await expect(transport.deliver(address, 8082, "invalid", delivery(work()))).rejects.toThrow(
			"destination or token is invalid",
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
