import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LxdClient,
	type LxdCreateInstanceRequest,
	type LxdCreateStorageVolumeRequest,
	type LxdInstancePowerAction,
	type LxdInstanceRecord,
	type LxdInstanceStateRecord,
	LxdOperationFailed,
	type LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import { lxdNativeNodePolicy, lxdResourceBytes } from "../src/lxd-native-node-policy.ts";
import {
	HttpLxdGuestTransport,
	LxdCloudRunnerProviderBackend,
	type LxdCloudRunnerProviderConfig,
	type LxdGuestTransport,
} from "../src/lxd-provider.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerInstance, CloudRunnerWork } from "../src/orchestrator.ts";
import { canonical, runAttemptAcquisitionId } from "../src/provider-shared.ts";
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
	/** Set to make the next create fail as this error, with no guest. */
	createFailure?: Error;

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

	async deleteStorageVolume(_project: string, _pool: string, name: string): Promise<boolean> {
		const existed = this.volumes.delete(name) || this.volume?.name === name;
		if (this.volume?.name === name) this.volume = undefined;
		return existed;
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
		const failure = this.createFailure;
		if (failure) {
			this.createFailure = undefined;
			throw failure;
		}
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
	loginInVault: boolean | "missing" = false,
	binds: Array<Record<string, unknown>> = [],
): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		expect(init?.redirect).toBe("error");
		const url = String(input);
		if (url.includes("qorpera_compute_identity_login_in_vault")) {
			expect(JSON.parse(String(init?.body))).toEqual({ p_compute_identity_id: expectedWork.computeIdentityId });
			// A database before migration 20260928180600 has no such function.
			if (loginInVault === "missing") return Response.json({ code: "PGRST202" }, { status: 404 });
			return Response.json(loginInVault);
		}
		if (url.includes("qorpera_reserve_runtime_node_machine"))
			return Response.json(nodeAdmissionFixture(JSON.parse(String(init?.body))));
		if (url.includes("qorpera_bind_native_identity_credential")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			binds.push(body);
			return Response.json({
				allocationId: body.p_allocation_id,
				computeIdentityId: expectedWork.computeIdentityId,
				holderKind: body.p_holder_kind,
			});
		}
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

describe("canonical device comparison (2026-09-28)", () => {
	it("keeps a device named __proto__ in the comparison, and every other key as before", () => {
		// As LXD's JSON carries it: an own key. Assigned into a copy, it became
		// the copy's prototype, and the drift check compared equal without it.
		const live = JSON.parse(
			'{"root":{"type":"disk","path":"/"},"__proto__":{"type":"disk","source":"/","path":"/host"}}',
		);
		const expected = { root: { type: "disk", path: "/" } };
		expect(JSON.stringify(canonical(live))).not.toBe(JSON.stringify(canonical(expected)));
		expect(JSON.stringify(canonical(live))).toBe(
			'{"__proto__":{"path":"/host","source":"/","type":"disk"},"root":{"path":"/","type":"disk"}}',
		);
		expect(JSON.stringify(canonical({ b: [{ z: 1, a: undefined }], a: "x", c: undefined }))).toBe(
			'{"a":"x","b":[{"z":1}]}',
		);
	});
});
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
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toMatchObject({
			name: "LxdMachineAdmissionRefused",
			category: "admission_refused",
			state: "refused",
			reason: "NODE_OBSERVATION_UNAVAILABLE",
		});
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

	it("sends a confirmed capacity release once, however often the retained journal is reconciled", async () => {
		// Live defect (19 Sep 2026): journals of finished runs are retained, and every pass released
		// each of them again (79 stopped journals, eight release calls a second on one node).
		const f = await acquiredFixture();
		const releases = () =>
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		const journal = async () => JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		const runner = await backend.acquire(runId, f.request, new AbortController().signal);
		await backend.stop(runner, "idle");
		expect(f.lxd.instance).toBeUndefined();
		expect(await journal()).toMatchObject({ physicalState: "stopped", capacityReleased: true });
		for (let pass = 0; pass < 3; pass++) await backend.reconcile();
		expect(releases()).toHaveLength(1);
		// The mark is durable: a restarted provider over the same state root does not release again.
		const restarted = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		for (let pass = 0; pass < 3; pass++) await restarted.reconcile();
		expect(releases()).toHaveLength(1);
		expect(await journal()).toMatchObject({ physicalState: "stopped", capacityReleased: true });
		await expect(restarted.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"cannot be replayed",
		);
	});

	it("settles a stopped journal after a restart once a deleted company's identity volume is retired", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(runner, delivery(work()));
		await backend.stop(runner, "idle");
		await backend.reconcile();
		const journal = JSON.parse(await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8"));
		expect(journal.physicalState).toBe("stopped");
		// Company delete D4: the node's login gateway deletes the identity volume.
		expect(await lxd.deleteStorageVolume(settings.project, settings.storagePool, journal.lxd.identityVolume)).toBe(
			true,
		);
		const volumes = lxd.createVolumeCalls.length;
		// A provider restart reconciles the retained journal again: it neither fails nor makes the volume again.
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		await restarted.reconcile();
		await restarted.reconcile();
		expect(lxd.createVolumeCalls).toHaveLength(volumes);
		expect(
			await lxd.getStorageVolume(settings.project, settings.storagePool, journal.lxd.identityVolume),
		).toBeUndefined();
	});
	it.each([
		// A crash between the release call's reply and its journal write.
		[
			"a stopping journal whose guest deletion is recorded",
			{ physicalState: "stopping", deletionConfirmed: true },
			false,
		],
		// A crash after the release was recorded, before the guest's absence was written.
		["an assigned journal whose capacity release is recorded", { physicalState: "assigned" }, true],
	] as const)("settles %s after a crash, once its identity volume is retired", async (_label, crashed, released) => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(runner, delivery(work()));
		await backend.stop(runner, "idle");
		const path = join(settings.stateRoot, runId, "journal.json");
		const { capacityReleased: _released, ...journal } = JSON.parse(await readFile(path, "utf-8"));
		await writeFile(
			path,
			JSON.stringify({ ...journal, ...crashed, ...(released ? { capacityReleased: true } : {}) }),
			{
				mode: 0o600,
			},
		);
		expect(await lxd.deleteStorageVolume(settings.project, settings.storagePool, journal.lxd.identityVolume)).toBe(
			true,
		);
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		await restarted.reconcile();
		await restarted.reconcile();
		// It settles (as a run whose guest is gone) instead of throwing on every pass.
		expect(JSON.parse(await readFile(path, "utf-8")).physicalState).toBe("lost");
		expect(
			await lxd.getStorageVolume(settings.project, settings.storagePool, journal.lxd.identityVolume),
		).toBeUndefined();
	});
	it("stops reconciling a settled journal, archives it a day later and refuses its replay", async () => {
		// Live cost (23 Sep 2026): node 1 re-read 76 finished run journals, three LXD calls each, on every pass.
		const f = await acquiredFixture();
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		const runner = await backend.acquire(runId, f.request, new AbortController().signal);
		await backend.stop(runner, "idle");
		const lxdCalls = [vi.spyOn(f.lxd, "getInstance"), vi.spyOn(f.lxd, "getStorageVolume")];
		const calls = () => lxdCalls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
		await backend.reconcile();
		const settledCalls = calls();
		expect(settledCalls).toBeGreaterThan(0);
		for (let pass = 0; pass < 3; pass++) await backend.reconcile();
		expect(calls()).toBe(settledCalls);
		expect((await readdir(f.stateRoot)).sort()).toEqual([runId]);

		// A day after its last change a restarted provider moves it, with its credentials, to the archive.
		const old = JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			f.journalPath,
			JSON.stringify({ ...old, updatedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }),
			{ mode: 0o600 },
		);
		const restarted = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await restarted.reconcile();
		expect(await readdir(f.stateRoot)).toEqual(["archive"]);
		// The run is over: its tokens are dead and only their hashes stay, in the journal.
		expect(await readdir(join(f.stateRoot, "archive", runId))).toEqual(["journal.json"]);
		expect((await stat(join(f.stateRoot, "archive"))).mode & 0o777).toBe(0o700);
		const archivedCalls = calls();
		await restarted.reconcile();
		expect(calls()).toBe(archivedCalls);

		// Its run is over: a replayed acquire allocates nothing and leaves no journal behind.
		await expect(restarted.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"archived and cannot be replayed",
		);
		await restarted.stop(runner, "idle");
		expect(f.lxd.createCalls).toHaveLength(1);
		expect(await readdir(f.stateRoot)).toEqual(["archive"]);
	});

	it("deletes a settled run's recovery volume when its journal is archived, and only that volume", async () => {
		// Session-buildup audit gap 7 (3 Oct 2026): every overflow run left its recovery volume on its node.
		const stateRoot = join(await root(), "state");
		const settings = governedConfig(stateRoot);
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(runner, delivery(work()));
		await backend.stop(runner, "idle");
		await backend.reconcile();
		const recovery = `native-recovery-${runId}`;
		const others = [...lxd.volumes.keys()].filter((name) => name !== recovery);
		const journalPath = join(stateRoot, runId, "journal.json");
		const age = async () => {
			const old = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
			const updatedAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
			await writeFile(journalPath, JSON.stringify({ ...old, updatedAt }), { mode: 0o600 });
		};
		// Kept for the day the journal is kept.
		expect(lxd.volumes.has(recovery)).toBe(true);
		expect(await readdir(stateRoot)).toEqual([runId]);

		// A drifted volume is not this run's: it stays, and so does the journal. The pass goes on (a failed pass stops
		// the node's claims), and the log names the journal once an hour.
		const volume = lxd.volumes.get(recovery)!;
		lxd.volumes.set(recovery, { ...volume, config: { ...volume.config, "user.qorpera.profile_id": "foreign" } });
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60_000);
		try {
			await backend.reconcile();
			await backend.reconcile();
		} finally {
			clock.mockRestore();
		}
		const kept = log.mock.calls.filter(([line]) => String(line).startsWith("recovery volume kept"));
		expect(kept).toHaveLength(1);
		// The line names the step by its fixed name, never the error's own text.
		expect(String(kept[0]?.[0])).toBe(`recovery volume kept: acquisition=${runId} stage=recovery_authority`);
		log.mockRestore();
		expect(await readdir(stateRoot)).toEqual([runId]);
		expect(JSON.parse(await readFile(journalPath, "utf8"))).not.toHaveProperty("recoveryVolumeRetired");
		lxd.volumes.set(recovery, volume);

		// The journal records the retirement before the delete: a provider that stopped in between keeps the volume's
		// authority check while it still exists, and does not demand it back once it is gone.
		await age();
		const interrupted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const remove = vi.spyOn(lxd, "deleteStorageVolume").mockRejectedValueOnce(new Error("provider stopped"));
		const stopped = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await interrupted.reconcile();
		expect(stopped).toHaveBeenCalledWith(`recovery volume kept: acquisition=${runId} stage=retire`);
		expect(stopped).not.toHaveBeenCalledWith(expect.stringContaining("provider stopped"));
		stopped.mockRestore();
		expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ recoveryVolumeRetired: true });
		expect(lxd.volumes.has(recovery)).toBe(true);
		await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).reconcile();
		// Gone, as the interrupted delete would have left it (the fake also remembers its last created volume).
		lxd.volumes.delete(recovery);
		if (lxd.volume?.name === recovery) lxd.volume = undefined;
		await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).reconcile();
		expect(await readdir(stateRoot)).toEqual([runId]);

		// A day after it settled, the archive takes the journal; the volume was already gone, so nothing is deleted.
		await age();
		remove.mockClear();
		await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).reconcile();
		expect(remove).not.toHaveBeenCalled();
		expect(await readdir(stateRoot)).toEqual(["archive"]);
		expect(JSON.parse(await readFile(join(stateRoot, "archive", runId, "journal.json"), "utf8"))).toMatchObject({
			recoveryVolumeRetired: true,
		});
		expect([...lxd.volumes.keys()].sort()).toEqual(others.sort());
	});

	it("keeps the journal when LXD does not confirm the delete, and reads a marked journal caught stopping", async () => {
		const stateRoot = join(await root(), "state");
		const settings = governedConfig(stateRoot);
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(runner, delivery(work()));
		await backend.stop(runner, "idle");
		await backend.reconcile();
		const recovery = `native-recovery-${runId}`;
		const journalPath = join(stateRoot, runId, "journal.json");
		const settled = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			journalPath,
			JSON.stringify({ ...settled, updatedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }),
			{ mode: 0o600 },
		);
		// LXD answers the delete but the volume is still there: the journal stays, and the log says why.
		const remove = vi.spyOn(lxd, "deleteStorageVolume").mockResolvedValue(true);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).reconcile();
		expect(await readdir(stateRoot)).toEqual([runId]);
		expect(lxd.volumes.has(recovery)).toBe(true);
		expect(log).toHaveBeenCalledWith(`recovery volume kept: acquisition=${runId} stage=retire_confirm`);
		expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ recoveryVolumeRetired: true });
		remove.mockRestore();
		log.mockRestore();
		// A marked journal caught stopping (a guest that came back was being removed when the provider stopped) still
		// reads, and its next pass settles it again without demanding the volume back.
		lxd.volumes.delete(recovery);
		if (lxd.volume?.name === recovery) lxd.volume = undefined;
		const marked = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(journalPath, JSON.stringify({ ...marked, physicalState: "stopping" }), { mode: 0o600 });
		await new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([])).reconcile();
		expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
			physicalState: "lost",
			recoveryVolumeRetired: true,
		});
	});

	it("archives a settled run with its recovery volume deleted, and waits while its guest exists again", async () => {
		const stateRoot = join(await root(), "state");
		const settings = governedConfig(stateRoot);
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.deliver(runner, delivery(work()));
		const leftBehind = { ...structuredClone(lxd.instance!), status: "Stopped" as const, statusCode: 102 };
		await backend.stop(runner, "idle");
		await backend.reconcile();
		const recovery = `native-recovery-${runId}`;
		const others = [...lxd.volumes.keys()].filter((name) => name !== recovery);
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now + 25 * 60 * 60_000);
		try {
			// The settled journal's guest is back: neither the volume nor the journal goes on this pass.
			lxd.instance = structuredClone(leftBehind);
			await backend.reconcile();
			expect(lxd.volumes.has(recovery)).toBe(true);
			expect(await readdir(stateRoot)).toEqual([runId]);
			// The next pass reconciles the journal again (the guest is removed on sight) and archives it.
			await backend.reconcile();
			expect(lxd.instance).toBeUndefined();
			expect(await readdir(stateRoot)).toEqual(["archive"]);
			expect([...lxd.volumes.keys()].sort()).toEqual(others.sort());
			expect(lxd.createVolumeCalls.filter((call) => call.name === recovery)).toHaveLength(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("releases a stopped journal from an older build once more and then marks it", async () => {
		const f = await acquiredFixture();
		const releases = () =>
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		const first = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await first.stop(await first.acquire(runId, f.request, new AbortController().signal), "idle");
		const old = JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		delete old.capacityReleased;
		await writeFile(f.journalPath, JSON.stringify(old), { mode: 0o600 });
		expect(releases()).toHaveLength(1);
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		for (let pass = 0; pass < 3; pass++) await backend.reconcile();
		expect(releases()).toHaveLength(2);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toEqual({
			...old,
			capacityReleased: true,
			updatedAt: expect.any(String),
		});
		const restarted = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await restarted.reconcile();
		expect(releases()).toHaveLength(2);
	});

	it("retries a lost or unconfirmed capacity release on the next pass and marks only a confirmed one", async () => {
		const f = await acquiredFixture();
		const first = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await first.stop(await first.acquire(runId, f.request, new AbortController().signal), "idle");
		const old = JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		delete old.capacityReleased;
		await writeFile(f.journalPath, JSON.stringify(old), { mode: 0o600 });
		let attempts = 0;
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_release_runtime_machine")) {
				attempts++;
				if (attempts === 1) throw new Error("release response lost");
				if (attempts === 2) {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return Response.json({
						state: "released",
						allocationId: body.p_allocation_id,
						instanceSha256: "0".repeat(64),
					});
				}
			}
			return f.fetchImplementation(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		// The stopped run's guest is gone, so a failed release never fails the pass (a failed pass stops the node's
		// claims): the log names it, at most once an hour, and the next pass tries again.
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).not.toHaveProperty("capacityReleased");
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).not.toHaveProperty("capacityReleased");
		await backend.reconcile();
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({ capacityReleased: true });
		await backend.reconcile();
		expect(attempts).toBe(3);
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`dead journal kept: acquisition=${runId} stage=release`,
		]);
		log.mockRestore();
	});

	it("never marks capacity released while the journaled guest still exists", async () => {
		const f = await acquiredFixture();
		const releases = () =>
			vi
				.mocked(f.fetchImplementation)
				.mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		for (let pass = 0; pass < 3; pass++) await backend.reconcile();
		expect(releases()).toHaveLength(0);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).not.toHaveProperty("capacityReleased");
		// A guest that survives its deletion keeps the capacity, and the journal stays unmarked.
		const runner = await backend.acquire(runId, f.request, new AbortController().signal);
		const deletion = vi.spyOn(f.lxd, "deleteInstance").mockResolvedValue(undefined);
		await expect(backend.stop(runner, "idle")).rejects.toThrow("physical deletion is confirmed");
		await expect(backend.reconcile()).rejects.toThrow("physical deletion is confirmed");
		expect(releases()).toHaveLength(0);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).not.toHaveProperty("capacityReleased");
		deletion.mockRestore();
		await backend.reconcile();
		expect(releases()).toHaveLength(1);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({
			physicalState: "stopped",
			capacityReleased: true,
		});
	});

	it("releases the capacity of a create LXD reports as failed, at once and once", async () => {
		// A start that failed before its guest existed kept its allocation reserved for good, so the run's
		// attempt could never move on (2026-09-29). LXD's own Failure is proof no guest will appear.
		const directory = await root();
		const stateRoot = join(directory, "state");
		const lxd = new FakeLxd();
		lxd.createFailure = new LxdOperationFailed("LXD operation failed");
		const fetcher = fetchProvisioner([]);
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"LXD operation failed",
		);
		const releases = () =>
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		expect(releases()).toHaveLength(1);
		expect(JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "lost",
			stopReason: "delivery_failed",
			deletionConfirmed: true,
			capacityReleased: true,
		});
		await backend.reconcile();
		expect(releases()).toHaveLength(1);
	});

	it("keeps the capacity of a create whose outcome is unknown", async () => {
		// A wait that timed out, or a lost reply: the guest may still appear, so nothing is released.
		const directory = await root();
		const stateRoot = join(directory, "state");
		const lxd = new FakeLxd();
		lxd.createFailure = new Error("LXD operation failed");
		const fetcher = fetchProvisioner([]);
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"LXD operation failed",
		);
		expect(
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine")),
		).toHaveLength(0);
		expect(JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "creating",
			capacityRegistered: true,
			createRequested: true,
		});
	});

	it.each([
		["the database fails its second reservation", "reservation"],
		["the node refuses its re-admission", "node"],
	] as const)(
		"releases a run's machine whose guest was never asked for when %s (29 Oct 2026)",
		async (_label, failure) => {
			// Node 1, 29 Oct 2026: both acquisitions failed in their create step after their machine and node demand were
			// reserved, before LXD was asked for a guest (one second reservation answered 525, one re-admission
			// NODE_OBSERVATION_UNAVAILABLE). The next pass marked each journal lost and released nothing; both allocations
			// stayed reserved until an operator released them on 3 Nov, and held the node's drain.
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const provision = fetchProvisioner([]);
			let reservations = 0;
			let admissions = 0;
			let databaseDown = true;
			const releases: unknown[] = [];
			const fetcher: typeof fetch = async (input, init) => {
				const url = String(input);
				if (url.includes("qorpera_reserve_runtime_machine") && failure === "reservation" && ++reservations === 2)
					return new Response("<html>origin unreachable</html>", { status: 525 });
				if (url.includes("qorpera_reserve_runtime_node_machine") && failure === "node" && ++admissions === 2)
					return Response.json({ state: "refused", reason: "NODE_OBSERVATION_UNAVAILABLE" });
				if (url.includes("qorpera_release_runtime_machine")) {
					releases.push(JSON.parse(String(init?.body)));
					if (databaseDown) return Response.json({ code: "57014", message: "statement timeout" }, { status: 503 });
				}
				return provision(input, init);
			};
			const settings = governedConfig(stateRoot);
			const backend = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
			const failed = await backend
				.acquire(runId, work(), new AbortController().signal)
				.catch((error: unknown) => error);
			expect(failed).toMatchObject(
				failure === "reservation"
					? { stage: "create", rpc: "qorpera_reserve_runtime_machine", rpcStatus: 525 }
					: { name: "LxdMachineAdmissionRefused", reason: "NODE_OBSERVATION_UNAVAILABLE" },
			);
			const path = join(stateRoot, runId, "journal.json");
			const journal = async () => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			expect(lxd.createCalls).toHaveLength(0);
			expect(await journal()).toMatchObject({
				physicalState: "creating",
				createRequested: false,
				capacityRegistered: true,
				nodeCapacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
			});
			// The next pass finds no guest, and none was ever asked for: the machine is released at once. The database does
			// not answer yet, so the journal is a dead one the log names, and the pass goes on (a failed pass stops claims).
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			await expect(backend.reconcile()).resolves.toBeUndefined();
			expect(log.mock.calls.map(([line]) => String(line))).toEqual([
				`dead journal kept: acquisition=${runId} stage=release rpc=qorpera_release_runtime_machine status=503 code=57014`,
			]);
			log.mockRestore();
			expect(await journal()).toMatchObject({ physicalState: "lost", deletionConfirmed: true });
			expect(await journal()).not.toHaveProperty("capacityReleased");
			// It is tried again on every pass until the release is confirmed, then never again. A restarted provider
			// reads the same from the journal.
			databaseDown = false;
			const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
			await restarted.reconcile();
			await restarted.reconcile();
			expect(releases).toHaveLength(2);
			expect(releases[1]).toMatchObject({ p_allocation_id: runId, p_provider_adapter: "lxd" });
			expect(await journal()).toMatchObject({ physicalState: "lost", capacityReleased: true });
			await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
				"cannot be replayed",
			);
			expect(lxd.createCalls).toHaveLength(0);
		},
	);

	it.each([
		["whose create may have been sent", false],
		["an older build wrote", true],
	] as const)(
		"releases a lost journal %s once LXD has not shown its guest for fifteen minutes",
		async (_label, older) => {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			lxd.createFailure = new Error("remote operation response lost");
			const fetcher = fetchProvisioner([]);
			await expect(
				new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher).acquire(
					runId,
					work(),
					new AbortController().signal,
				),
			).rejects.toThrow("remote operation response lost");
			const path = join(stateRoot, runId, "journal.json");
			const journal = async () => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			const age = async (ms: number) =>
				writeFile(
					path,
					JSON.stringify({ ...(await journal()), updatedAt: new Date(Date.now() - ms).toISOString() }),
					{
						mode: 0o600,
					},
				);
			const releases = () =>
				vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
			expect(await journal()).toMatchObject({ physicalState: "creating", createRequested: true });
			if (older) {
				const { createRequested: _requested, ...written } = await journal();
				await writeFile(path, JSON.stringify(written), { mode: 0o600 });
			}
			const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
			// The create may still be pending in LXD: the journal is lost, its capacity kept.
			await backend.reconcile();
			expect(await journal()).toMatchObject({ physicalState: "lost" });
			expect(await journal()).not.toHaveProperty("deletionConfirmed");
			await age(14 * 60_000);
			await backend.reconcile();
			expect(releases()).toHaveLength(0);
			// Fifteen minutes on, an LXD that does not answer is still not a missing guest.
			await age(16 * 60_000);
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			const unreachable = vi.spyOn(lxd, "getInstance").mockRejectedValue(new Error("LXD unavailable"));
			await expect(backend.reconcile()).rejects.toThrow("LXD unavailable");
			unreachable.mockRestore();
			log.mockRestore();
			expect(releases()).toHaveLength(0);
			// LXD answers that the guest is missing: the machine is released, once.
			await backend.reconcile();
			await backend.reconcile();
			expect(releases()).toHaveLength(1);
			expect(await journal()).toMatchObject({ physicalState: "lost", capacityReleased: true });
		},
	);

	it("releases at a stop a run's machine whose guest was never asked for, and keeps one whose create may be pending", async () => {
		const releases = (fetcher: typeof fetch) =>
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		for (const asked of [false, true]) {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const provision = fetchProvisioner([]);
			let reservations = 0;
			const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
				!asked && String(input).includes("qorpera_reserve_runtime_machine") && ++reservations === 2
					? new Response("<html>origin unreachable</html>", { status: 525 })
					: provision(input, init),
			) as typeof fetch;
			if (asked) lxd.createFailure = new Error("remote operation response lost");
			const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
			await expect(backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow();
			const path = join(stateRoot, runId, "journal.json");
			const journal = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
			expect(journal).toMatchObject({ physicalState: "creating", createRequested: asked });
			expect(lxd.createCalls).toHaveLength(asked ? 1 : 0);
			await backend.stop(journal.runner as CloudRunnerInstance, "delivery_failed");
			expect(releases(fetcher)).toHaveLength(asked ? 0 : 1);
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
				physicalState: "lost",
				...(asked ? {} : { capacityReleased: true }),
			});
		}
	});

	it("never fails the pass over a stale reservation whose release the database does not answer", async () => {
		const f = await acquiredFixture();
		const reservingId = "10000000-0000-4000-8000-000000000012";
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		const stale = new Date(Date.now() - 11 * 60_000).toISOString();
		const reserving = {
			...journal,
			acquisitionId: reservingId,
			...(journal.runId === undefined ? {} : { runId: reservingId }),
			instanceName: `qorpera-${reservingId.replaceAll("-", "")}`,
			physicalState: "reserving",
			createRequested: false,
			createdAt: stale,
			updatedAt: stale,
		};
		for (const key of ["nodeCapacity", "capacityRegistered", "guestAddress", "assignmentId"]) delete reserving[key];
		await mkdir(join(f.stateRoot, reservingId), { recursive: true, mode: 0o700 });
		const path = join(f.stateRoot, reservingId, "journal.json");
		await writeFile(path, JSON.stringify(reserving), { mode: 0o600 });
		let databaseDown = true;
		const releases: unknown[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_release_runtime_machine") && String(init?.body).includes(reservingId)) {
				releases.push(JSON.parse(String(init?.body)));
				if (databaseDown) return Response.json({ code: "57014", message: "statement timeout" }, { status: 503 });
			}
			return f.fetchImplementation(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		// The journal is marked lost before the release, so the failed release is a dead journal the log names.
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`dead journal kept: acquisition=${reservingId} stage=release rpc=qorpera_release_runtime_machine status=503 code=57014`,
		]);
		log.mockRestore();
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			physicalState: "lost",
			stopReason: "idle",
			deletionConfirmed: true,
		});
		expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("capacityReleased");
		// The next pass tries again; once the database answers, the release is recorded and never sent again.
		databaseDown = false;
		await backend.reconcile();
		await backend.reconcile();
		expect(releases).toHaveLength(2);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ physicalState: "lost", capacityReleased: true });
	});

	it("never reserves capacity again for an allocation whose release is confirmed", async () => {
		// A crash between the release mark and the terminal state leaves a registered, released journal.
		const f = await acquiredFixture();
		const journal = JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(f.journalPath, JSON.stringify({ ...journal, capacityReleased: true }), { mode: 0o600 });
		f.lxd.instance = undefined;
		const calls = (name: string) =>
			vi.mocked(f.fetchImplementation).mock.calls.filter(([url]) => String(url).includes(name)).length;
		const reserved = calls("qorpera_reserve_runtime_machine");
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await expect(backend.acquire(runId, f.request, new AbortController().signal)).rejects.toThrow(
			"Released machine capacity cannot be reserved again",
		);
		await backend.reconcile();
		expect(calls("qorpera_reserve_runtime_machine")).toBe(reserved);
		expect(calls("qorpera_release_runtime_machine")).toBe(0);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toMatchObject({
			physicalState: "lost",
			capacityReleased: true,
		});
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
	it.each([false, true])("allows new work after retiring a stale reservation (registered: %s)", async (registered) => {
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
		if (!registered) delete reserving.capacityRegistered;
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
		// Released either way (3 Nov 2026): a reservation whose answer was lost may have committed unrecorded.
		expect(releases).toHaveLength(1);
		expect(JSON.parse(await readFile(join(f.stateRoot, reservingId, "journal.json"), "utf8"))).toMatchObject({
			capacityReleased: true,
		});
		// A provider restart must not let the retired reservation block unrelated work.
		f.lxd.instance = { ...f.lxd.instance!, status: "Stopped", statusCode: 102 };
		await backend.reconcile();
		const nextId = "30000000-0000-4000-8000-000000000001";
		const restarted = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		await restarted.acquire(nextId, { ...work(), runId: nextId }, new AbortController().signal);
		expect(f.lxd.createCalls).toHaveLength(2);
		expect(f.lxd.powerCalls).toEqual(["start", "start"]);
	});
	it.each(["present", "unknown"])("blocks new work when a lost guest is %s", async (presence) => {
		const f = await acquiredFixture();
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		journal.physicalState = "lost";
		delete journal.nodeCapacity;
		delete journal.capacityRegistered;
		await writeFile(f.journalPath, JSON.stringify(journal));
		if (presence === "unknown") vi.spyOn(f.lxd, "getInstance").mockRejectedValue(new Error("LXD unavailable"));
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, f.fetchImplementation);
		const nextId = "30000000-0000-4000-8000-000000000001";
		await expect(backend.acquire(nextId, { ...work(), runId: nextId }, new AbortController().signal)).rejects.toThrow(
			presence === "present" ? "machine-capacity inventory" : "LXD unavailable",
		);
		expect(f.lxd.createCalls).toHaveLength(1);
		expect(f.lxd.powerCalls).toEqual(["start"]);
		expect(JSON.parse(await readFile(f.journalPath, "utf8"))).toEqual(journal);
	});
	it("reconciles a lost or stopped journal whose guest and recovery volume are gone, not one that may start again", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const fetcher = fetchProvisioner([]);
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetcher);
		await backend.acquire(runId, work(), new AbortController().signal);
		const journal = JSON.parse(await readFile(join(settings.stateRoot, runId, "journal.json"), "utf8"));
		const variant = (id: string, physicalState: string) => {
			const copy = {
				...journal,
				acquisitionId: id,
				runId: id,
				instanceName: `qorpera-${id.replaceAll("-", "")}`,
				physicalState,
				lxd: {
					...journal.lxd,
					companyRuntime: { ...journal.lxd.companyRuntime, recoveryVolume: `native-recovery-${id}` },
				},
			};
			for (const key of ["nodeCapacity", "capacityRegistered", "guestAddress", "assignmentId"]) delete copy[key];
			return copy;
		};
		const lostId = "10000000-0000-4000-8000-000000000003";
		await mkdir(join(settings.stateRoot, lostId), { recursive: true, mode: 0o700 });
		await writeFile(join(settings.stateRoot, lostId, "journal.json"), JSON.stringify(variant(lostId, "lost")), {
			mode: 0o600,
		});
		await backend.reconcile();
		expect(JSON.parse(await readFile(join(settings.stateRoot, lostId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "lost",
		});
		expect(lxd.volumes.has(`native-recovery-${lostId}`)).toBe(false);
		// Nor does a stopped one: it never starts again, and nothing mounts its volume once its guest is gone.
		const stoppedId = "10000000-0000-4000-8000-000000000004";
		await mkdir(join(settings.stateRoot, stoppedId), { recursive: true, mode: 0o700 });
		await writeFile(
			join(settings.stateRoot, stoppedId, "journal.json"),
			JSON.stringify(variant(stoppedId, "stopped")),
			{ mode: 0o600 },
		);
		await backend.reconcile();
		expect(JSON.parse(await readFile(join(settings.stateRoot, stoppedId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "stopped",
		});
		expect(lxd.volumes.has(`native-recovery-${stoppedId}`)).toBe(false);
		// A journal that may start again still has to name its retained recovery volume.
		const startingId = "10000000-0000-4000-8000-000000000005";
		await mkdir(join(settings.stateRoot, startingId), { recursive: true, mode: 0o700 });
		await writeFile(
			join(settings.stateRoot, startingId, "journal.json"),
			JSON.stringify(variant(startingId, "starting")),
			{ mode: 0o600 },
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(backend.reconcile()).rejects.toThrow("Native recovery volume is missing");
		expect(log).toHaveBeenCalledWith(`reconcile failed: acquisition=${startingId} stage=recovery_volume`);
		log.mockRestore();
		expect(lxd.createVolumeCalls.map((call) => call.name)).not.toContain(`native-recovery-${startingId}`);
	});
	it("settles a stopped journal once its guest and recovery volume are gone, and checks the volume while the guest exists", async () => {
		// 4–6 Oct 2026: node 1 claimed no run for two and a half days. Two stopped journals from before the 3 Oct wipe,
		// their guests and recovery volumes gone, failed every pass over the missing volume, and a failed pass stops the
		// node's claims.
		const settings = governedConfig(join(await root(), "state"));
		const lxd = new FakeLxd();
		const fetcher = fetchProvisioner([], work(), true);
		await new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher).acquire(
			runId,
			work(),
			new AbortController().signal,
		);
		const path = join(settings.stateRoot, runId, "journal.json");
		const journal = JSON.parse(await readFile(path, "utf8"));
		expect(journal).toMatchObject({
			capacityRegistered: true,
			nodeCapacity: expect.any(Object),
			lxd: { loginCustody: "vault" },
		});
		expect(journal).not.toHaveProperty("capacityReleased");
		await writeFile(path, JSON.stringify({ ...journal, physicalState: "stopped", stopReason: "idle" }), {
			mode: 0o600,
		});
		lxd.volumes.clear();
		lxd.volume = undefined;
		lxd.instance = { ...lxd.instance!, status: "Stopped", statusCode: 102 };
		const releases = () =>
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_release_runtime_machine"));
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		// While its guest exists the run still has to name its recovery volume: the pass fails, and the log says where.
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
		await expect(backend.reconcile()).rejects.toThrow("Native recovery volume is missing");
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`reconcile failed: acquisition=${runId} stage=recovery_volume`,
		]);
		expect(lxd.instance).toBeDefined();
		expect(releases()).toHaveLength(0);
		// Once the guest is gone nothing mounts the volume again: the capacity is released and the journal settles.
		lxd.instance = undefined;
		log.mockClear();
		await backend.reconcile();
		await backend.reconcile();
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
		expect(releases()).toHaveLength(1);
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			physicalState: "stopped",
			capacityReleased: true,
		});
		// A day later it is archived, with no volume to retire and none created.
		const settled = JSON.parse(await readFile(path, "utf8"));
		await writeFile(
			path,
			JSON.stringify({ ...settled, updatedAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() }),
			{ mode: 0o600 },
		);
		await new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher).reconcile();
		expect(await readdir(settings.stateRoot)).toEqual(["archive"]);
		expect(lxd.createVolumeCalls).toHaveLength(1);
		expect(releases()).toHaveLength(1);
	});
	it("never lets a lost journal this build cannot read stop the node's work (node 2, 6 Oct 2026)", async () => {
		// Node 2's kept journal, field for field: lost after an idle stop with its capacity registered, no node placement
		// and no login custody (both came later), and its guest gone.
		const templateRoot = join(await root(), "state");
		await new LxdCloudRunnerProviderBackend(
			governedConfig(templateRoot),
			new FakeLxd(),
			new FakeGuest(),
			fetchProvisioner([]),
		).acquire(runId, work(), new AbortController().signal);
		const template = JSON.parse(await readFile(join(templateRoot, runId, "journal.json"), "utf8"));
		const pick = (source: Record<string, unknown>, keys: readonly string[]) =>
			Object.fromEntries(keys.map((key) => [key, source[key]]));
		const shaped = (id: string, credentials: Record<string, unknown>) => ({
			...pick(template, ["createdAt", "jobType", "schema", "updatedAt", "workSha256"]),
			acquisitionId: id,
			runId: id,
			attempt: 1,
			instanceName: `qorpera-${id.replaceAll("-", "")}`,
			runner: { ...template.runner, runnerId: "10000000-0000-4000-8000-000000000008" },
			physicalState: "lost",
			stopReason: "idle",
			capacityRegistered: true,
			credentials,
			lxd: {
				...pick(template.lxd, [
					"bootstrapSha256",
					"identityVolume",
					"identityVolumeSize",
					"imageFingerprint",
					"imageServer",
					"policySha256",
					"profiles",
					"rootDiskSize",
					"storagePool",
					"type",
				]),
				project: "qn25b2",
				companyRuntime: { ...template.lxd.companyRuntime, recoveryVolume: `native-recovery-${id}` },
			},
		});
		// It has no digest of the identity credential G2-3bc added (v171), so this build cannot read it.
		const { nativeIdentitySha256: _identity, ...credentials } = template.credentials;
		const id = "10000000-0000-4000-8000-000000000006";
		const written = `${JSON.stringify(shaped(id, credentials), null, 2)}\n`;
		const journal = JSON.parse(written);
		expect(Object.keys(journal).sort()).toEqual([
			"acquisitionId",
			"attempt",
			"capacityRegistered",
			"createdAt",
			"credentials",
			"instanceName",
			"jobType",
			"lxd",
			"physicalState",
			"runId",
			"runner",
			"schema",
			"stopReason",
			"updatedAt",
			"workSha256",
		]);
		expect(Object.keys(journal.lxd).sort()).toEqual([
			"bootstrapSha256",
			"companyRuntime",
			"identityVolume",
			"identityVolumeSize",
			"imageFingerprint",
			"imageServer",
			"policySha256",
			"profiles",
			"project",
			"rootDiskSize",
			"storagePool",
			"type",
		]);
		expect(journal.runner.computeIdentityId).toBe(work().computeIdentityId);
		expect(journal.credentials).not.toHaveProperty("nativeIdentitySha256");
		// The same journal with the digest reads and passes: the digest is all this build misses.
		const controlId = "10000000-0000-4000-8000-000000000007";
		const stateRoot = join(await root(), "state");
		for (const [acquisitionId, content] of [
			[id, written],
			[controlId, JSON.stringify(shaped(controlId, template.credentials))],
		] as const) {
			await mkdir(join(stateRoot, acquisitionId), { recursive: true, mode: 0o700 });
			await writeFile(join(stateRoot, acquisitionId, "journal.json"), content, { mode: 0o600 });
		}
		const backend = new LxdCloudRunnerProviderBackend(
			governedConfig(stateRoot),
			new FakeLxd(),
			new FakeGuest(),
			fetchProvisioner([]),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`dead journal kept: acquisition=${id} stage=journal`,
		]);
		// Nor does it hold up a start or a stop's runner lookup, and the log names it at most once an hour.
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		await backend.stop({ ...runner, runnerId: "20000000-0000-4000-8000-000000000099" }, "idle");
		await backend.stop(runner, "idle");
		expect(JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf8"))).toMatchObject({
			physicalState: "stopped",
		});
		await backend.reconcile();
		expect(log).toHaveBeenCalledTimes(1);
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
		try {
			await backend.reconcile();
		} finally {
			clock.mockRestore();
		}
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`dead journal kept: acquisition=${id} stage=journal`,
			`dead journal kept: acquisition=${id} stage=journal`,
		]);
		log.mockRestore();
		expect(await readFile(join(stateRoot, id, "journal.json"), "utf8")).toBe(written);
	});
	it("passes over a dead first attempt it cannot read when the run's next attempt starts, in attempt order", async () => {
		const stateRoot = join(await root(), "state");
		const settings = governedConfig(stateRoot);
		const lxd = new FakeLxd();
		const fetcher = fetchProvisioner([]);
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
		await backend.stop(await backend.acquire(runId, work(), new AbortController().signal), "idle");
		// The first attempt's journal has no identity credential digest (before G2-3bc), and its guest is gone.
		const path = join(stateRoot, runId, "journal.json");
		const old = JSON.parse(await readFile(path, "utf8"));
		delete old.credentials.nativeIdentitySha256;
		await writeFile(path, JSON.stringify(old), { mode: 0o600 });
		// A dead journal of a later attempt still refuses an earlier one.
		const laterId = runAttemptAcquisitionId(runId, 3);
		await mkdir(join(stateRoot, laterId), { recursive: true, mode: 0o700 });
		await writeFile(
			join(stateRoot, laterId, "journal.json"),
			JSON.stringify({
				...old,
				acquisitionId: laterId,
				attempt: 3,
				instanceName: `qorpera-${laterId.replaceAll("-", "")}`,
				lxd: {
					...old.lxd,
					companyRuntime: { ...old.lxd.companyRuntime, recoveryVolume: `native-recovery-${laterId}` },
				},
			}),
			{ mode: 0o600 },
		);
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, new FakeGuest(), fetcher);
		await expect(restarted.acquire(runId, { ...work(), attempt: 2 }, new AbortController().signal)).rejects.toThrow(
			"refuses an older run attempt",
		);
		expect(lxd.createCalls).toHaveLength(1);
		await rm(join(stateRoot, laterId), { recursive: true });
		await restarted.acquire(runId, { ...work(), attempt: 2 }, new AbortController().signal);
		expect(lxd.createCalls).toHaveLength(2);
		expect(lxd.createCalls[1]?.name).toBe(`qorpera-${runAttemptAcquisitionId(runId, 2).replaceAll("-", "")}`);
	});
	it("names each journal that fails a pass by its step and fixed codes, never by the error's text", async () => {
		const f = await acquiredFixture();
		const secret = `sb_secret_${"z".repeat(40)}`;
		// One journal's machine reservation fails with a database answer, another's guest lookup with raw LXD text.
		const journal = JSON.parse(await readFile(f.journalPath, "utf8"));
		delete journal.capacityRegistered;
		await writeFile(f.journalPath, JSON.stringify(journal), { mode: 0o600 });
		const otherId = "10000000-0000-4000-8000-000000000009";
		const otherInstance = `qorpera-${otherId.replaceAll("-", "")}`;
		await mkdir(join(f.stateRoot, otherId), { recursive: true, mode: 0o700 });
		await writeFile(
			join(f.stateRoot, otherId, "journal.json"),
			JSON.stringify({
				...journal,
				acquisitionId: otherId,
				...(journal.runId === undefined ? {} : { runId: otherId }),
				instanceName: otherInstance,
			}),
			{ mode: 0o600 },
		);
		const getInstance = f.lxd.getInstance.bind(f.lxd);
		vi.spyOn(f.lxd, "getInstance").mockImplementation(async (project, name) => {
			if (name === otherInstance) throw new Error(`LXD: Get "/1.0/instances/${name}?project=${project}": ${secret}`);
			return getInstance(project, name);
		});
		const fetcher: typeof fetch = async (input, init) =>
			String(input).includes("qorpera_reserve_runtime_machine")
				? Response.json({ code: "PGRST301", message: `JWT ${secret} expired` }, { status: 503 })
				: f.fetchImplementation(input, init);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		const failure = await backend.reconcile().then(
			() => undefined,
			(error: unknown) => error,
		);
		const lines = log.mock.calls.map(([line]) => String(line));
		log.mockRestore();
		expect(failure).toBeInstanceOf(AggregateError);
		expect(lines.sort()).toEqual([
			`reconcile failed: acquisition=${otherId} stage=instance`,
			`reconcile failed: acquisition=${runId} stage=reserve rpc=qorpera_reserve_runtime_machine status=503 code=PGRST301`,
		]);
		expect(lines.join("\n")).not.toContain(secret);
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
	it("names the step, and a failed database call's function, status and code, when acquire fails", async () => {
		const stateRoot = join(await root(), "state");
		const lxd = new FakeLxd();
		const base = fetchProvisioner([]);
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_reserve_runtime_machine"))
				return Response.json({ code: "42501", message: "PRIVATE detail" }, { status: 403 });
			return base(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
		const failure = await backend
			.acquire(runId, work(), new AbortController().signal)
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			name: "ProviderStepFailed",
			category: "provider_step",
			stage: "reserve",
			rpc: "qorpera_reserve_runtime_machine",
			rpcStatus: 403,
			rpcCode: "42501",
			message: "Runner provisioning failed (403)",
		});
		expect(lxd.createCalls).toHaveLength(0);

		// A failure that is no database call names only its step; a body without a code names none.
		const other = join(await root(), "state");
		const unreadable: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_compute_identity_login_in_vault"))
				return new Response("<html>gateway</html>", { status: 502 });
			return base(input, init);
		};
		const custody = await new LxdCloudRunnerProviderBackend(
			governedConfig(other),
			new FakeLxd(),
			new FakeGuest(),
			unreadable,
		)
			.acquire(runId, work(), new AbortController().signal)
			.catch((error: unknown) => error);
		expect(custody).toMatchObject({
			category: "provider_step",
			stage: "login_custody",
			rpc: "qorpera_compute_identity_login_in_vault",
			rpcStatus: 502,
			rpcCode: undefined,
		});
		const lxdFailure = new FakeLxd();
		vi.spyOn(lxdFailure, "createInstance").mockRejectedValue(new Error("PRIVATE /var/lib host path"));
		const created = await new LxdCloudRunnerProviderBackend(
			config(join(await root(), "state")),
			lxdFailure,
			new FakeGuest(),
			fetchProvisioner([]),
		)
			.acquire(runId, work(), new AbortController().signal)
			.catch((error: unknown) => error);
		expect(created).toMatchObject({ category: "provider_step", stage: "create", rpc: undefined });
	});
	it.each(["NODE_CAPACITY_EXHAUSTED", "NODE_OBSERVATION_UNAVAILABLE", "NODE_DISABLED"])(
		"reports a node refusal %s as a typed admission refusal",
		async (reason) => {
			const stateRoot = join(await root(), "state");
			const lxd = new FakeLxd();
			const base = fetchProvisioner([]);
			const fetcher: typeof fetch = async (input, init) => {
				if (String(input).includes("qorpera_reserve_runtime_node_machine"))
					return Response.json({ state: "refused", reason });
				return base(input, init);
			};
			const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, new FakeGuest(), fetcher);
			const failure = await backend
				.acquire(runId, work(), new AbortController().signal)
				.catch((error: unknown) => error);
			expect(failure).toMatchObject({
				name: "LxdMachineAdmissionRefused",
				category: "admission_refused",
				state: "refused",
				reason,
			});
			expect(lxd.createCalls).toHaveLength(0);
			const journal = JSON.parse(await readFile(join(stateRoot, runId, "journal.json"), "utf8"));
			expect(journal).toMatchObject({ physicalState: "reserving", capacityRegistered: true });
		},
	);
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
		const binds: Array<Record<string, unknown>> = [];
		const request = work();
		const fetchImplementation = fetchProvisioner(requests, request, false, binds);
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
		const nativeIdentity = (
			await readFile(join(stateRoot, runId, "credentials", "qorpera-native-identity"), "utf-8")
		).trim();
		// G2-3: the guest's identity credential, bound by its hash to the machine allocation as a job guest, the same
		// bind again with each re-reservation.
		expect(binds.length).toBeGreaterThan(0);
		for (const bind of binds)
			expect(bind).toEqual({
				p_allocation_id: runId,
				p_provider_adapter: "lxd",
				p_instance_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				p_holder_kind: "job_guest",
				p_credential_sha256: createHash("sha256").update(nativeIdentity).digest("hex"),
			});
		expect(new Set(binds.map((bind) => bind.p_instance_sha256)).size).toBe(1);
		expect(JSON.parse(journalText)).toMatchObject({
			credentials: { nativeIdentitySha256: createHash("sha256").update(nativeIdentity).digest("hex") },
		});
		expect(journalText).not.toContain(nativeIdentity);
		const createRequestText = JSON.stringify(lxd.createCalls[0]);
		expect(createRequestText).not.toContain(nativeIdentity);
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
			"/var/lib/qorpera-bootstrap/credentials/qorpera-native-identity",
		]);
		// G2-5: the guest gets no service key, in any file.
		for (const file of lxd.filePushes) expect(file.content).not.toContain(config(stateRoot).supabaseServiceKey);
		expect(
			JSON.parse(lxd.filePushes.find((file) => file.path.endsWith("qorpera-native-identity"))?.content ?? "{}"),
		).toEqual({
			schema: "qorpera.native-identity-credential/v1",
			compute_identity_id: request.computeIdentityId,
			credential: nativeIdentity,
			publishable_key: "publishable-key",
		});
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

	it("retires a guest still waiting two minutes after its job ended, and keeps one whose job goes on", async () => {
		// 29 Sep 2026 (company deletion): an unknown assign or delivery leaves the guest up for a replay,
		// but an ended job is never replayed, so the guest waited on its inbox forever with its machine.
		const f = await acquiredFixture();
		const asked: string[][] = [];
		let ended = false;
		const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).includes("qorpera_runtime_ended_runners")) {
				const body = JSON.parse(String(init?.body)) as { p_runner_ids: string[] };
				asked.push(body.p_runner_ids);
				return Response.json(ended ? body.p_runner_ids : []);
			}
			return f.fetchImplementation(input, init);
		}) as typeof fetch;
		const journal = async () => JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		const age = async (ms: number) =>
			writeFile(
				f.journalPath,
				JSON.stringify({ ...(await journal()), updatedAt: new Date(Date.now() - ms).toISOString() }),
			);
		// A fresh guest is not asked about.
		await new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher).reconcile();
		expect(asked).toEqual([]);
		// Waiting two minutes: asked once per minute; while the job goes on the guest stays.
		await age(2 * 60_000 + 1_000);
		const backend = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		await backend.reconcile();
		await backend.reconcile();
		expect(asked).toEqual([[runnerId]]);
		expect(f.lxd.deleteCalls).toEqual([]);
		expect(await journal()).toMatchObject({ physicalState: "registered" });
		// Its job ended: a later pass retires the guest and releases its machine.
		ended = true;
		const later = new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher);
		await later.reconcile();
		expect(f.lxd.deleteCalls).toEqual([f.lxd.createCalls[0]?.name]);
		expect(await journal()).toMatchObject({
			physicalState: "stopped",
			stopReason: "revoked",
			capacityReleased: true,
		});
	});

	it("keeps waiting guests when the database has no ended-runner check yet", async () => {
		const f = await acquiredFixture();
		const journal = async () => JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			f.journalPath,
			JSON.stringify({ ...(await journal()), updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
		);
		const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
			String(input).includes("qorpera_runtime_ended_runners")
				? Response.json({ code: "PGRST202" }, { status: 404 })
				: f.fetchImplementation(input, init),
		) as typeof fetch;
		await new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher).reconcile();
		expect(
			vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes("qorpera_runtime_ended_runners")),
		).toHaveLength(1);
		expect(f.lxd.deleteCalls).toEqual([]);
		expect(await journal()).toMatchObject({ physicalState: "registered" });
	});

	it("names a failed ended-runner check by its fixed codes only, and fails the pass", async () => {
		const f = await acquiredFixture();
		const journal = async () => JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			f.journalPath,
			JSON.stringify({ ...(await journal()), updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
		);
		const secret = `sb_secret_${"y".repeat(40)}`;
		const fetcher: typeof fetch = async (input, init) =>
			String(input).includes("qorpera_runtime_ended_runners")
				? Response.json({ code: "PGRST301", message: `JWT ${secret} expired` }, { status: 503 })
				: f.fetchImplementation(input, init);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(
			new LxdCloudRunnerProviderBackend(config(f.stateRoot), f.lxd, f.guest, fetcher).reconcile(),
		).rejects.toThrow("Ended runners are unavailable (503)");
		const lines = log.mock.calls.map(([line]) => String(line));
		log.mockRestore();
		expect(lines).toEqual([
			"reconcile failed: stage=ended_runners rpc=qorpera_runtime_ended_runners status=503 code=PGRST301",
		]);
		expect(lines.join("\n")).not.toContain(secret);
		expect(f.lxd.deleteCalls).toEqual([]);
		expect(await journal()).toMatchObject({ physicalState: "registered" });
	});

	it("keeps an ended runner whose guest is gone out of the pass's failures, but not one whose guest stays", async () => {
		// A waiting guest whose job ended; the database answers that every runner asked about has ended.
		const ended = async () => {
			const f = await acquiredFixture();
			const journal = async () => JSON.parse(await readFile(f.journalPath, "utf8")) as Record<string, unknown>;
			await writeFile(
				f.journalPath,
				JSON.stringify({ ...(await journal()), updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
			);
			const fetcher: typeof fetch = async (input, init) =>
				String(input).includes("qorpera_runtime_ended_runners")
					? Response.json((JSON.parse(String(init?.body)) as { p_runner_ids: string[] }).p_runner_ids)
					: f.fetchImplementation(input, init);
			return { ...f, journal, fetcher };
		};
		const secret = `sb_secret_${"x".repeat(40)}`;
		// The guest is deleted, but its machine release fails: the journal is dead, logged once, and the pass goes on.
		const gone = await ended();
		let releaseFails = true;
		const releases: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).includes("qorpera_release_runtime_machine")) {
				releases.push(String(input));
				if (releaseFails) return Response.json({ code: "XX000", message: secret }, { status: 500 });
			}
			return gone.fetcher(input, init);
		};
		const backend = new LxdCloudRunnerProviderBackend(config(gone.stateRoot), gone.lxd, gone.guest, fetcher);
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(gone.lxd.deleteCalls).toEqual([gone.lxd.createCalls[0]?.name]);
		expect(log.mock.calls.map(([line]) => String(line))).toEqual([
			`dead journal kept: acquisition=${runId} stage=ended_runner rpc=qorpera_release_runtime_machine status=500 code=XX000`,
		]);
		expect(await gone.journal()).toMatchObject({ physicalState: "stopping", deletionConfirmed: true });
		expect((await gone.journal()).capacityReleased).toBeUndefined();
		// The next pass tries the release again; once it is answered the journal is released.
		releaseFails = false;
		await expect(backend.reconcile()).resolves.toBeUndefined();
		expect(releases).toHaveLength(2);
		expect(await gone.journal()).toMatchObject({ capacityReleased: true });
		// The guest cannot be deleted: the journal is live, so the log names it and the pass fails.
		const stays = await ended();
		const remove = vi.spyOn(stays.lxd, "deleteInstance").mockRejectedValue(new Error(`LXD answered ${secret}`));
		log.mockClear();
		await expect(
			new LxdCloudRunnerProviderBackend(config(stays.stateRoot), stays.lxd, stays.guest, stays.fetcher).reconcile(),
		).rejects.toThrow(secret);
		const lines = log.mock.calls.map(([line]) => String(line));
		log.mockRestore();
		remove.mockRestore();
		expect(lines).toEqual([`reconcile failed: acquisition=${runId} stage=ended_runner`]);
		expect(stays.lxd.instance).toBeDefined();
		expect(await stays.journal()).toMatchObject({ physicalState: "stopping", stopReason: "revoked" });
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

	it("gives a vault login guest no identity volume and tells its host to ask the vault", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([], work(), true));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		expect(lxd.createVolumeCalls.map((call) => call.name)).toEqual([`native-recovery-${runId}`]);
		expect(Object.keys(lxd.createCalls[0]?.devices ?? {}).sort()).toEqual(["enp5s0", "root", "runner-recovery"]);
		const files = new Map(lxd.filePushes.map((file) => [file.path, file.content]));
		const bootstrap = JSON.parse(files.get("/var/lib/qorpera-bootstrap/bootstrap.json") ?? "null");
		expect(bootstrap.company_runtime.login_custody).toBe("vault");
		expect(files.get("/var/lib/qorpera-bootstrap/native-provider.env")).toContain(
			"QORPERA_NATIVE_LOGIN_CUSTODY=vault\n",
		);
		const journal = JSON.parse(await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8"));
		expect(journal.lxd.loginCustody).toBe("vault");
		// The custody is sealed into the journal: a restart neither asks again nor adds a volume.
		const recheck = fetchProvisioner([], work(), false);
		const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, recheck);
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).resolves.toEqual(runner);
		expect(
			vi.mocked(recheck).mock.calls.some(([url]) => String(url).includes("qorpera_compute_identity_login_in_vault")),
		).toBe(false);
		expect(lxd.createVolumeCalls).toHaveLength(1);
		await restarted.deliver(runner, delivery(work()));
		await restarted.stop(runner, "idle");
	});

	it("keeps the node login path when the database has no vault custody check yet", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const backend = new LxdCloudRunnerProviderBackend(
			settings,
			lxd,
			new FakeGuest(),
			fetchProvisioner([], work(), "missing"),
		);
		await backend.acquire(runId, work(), new AbortController().signal);
		expect(Object.keys(lxd.createCalls[0]?.devices ?? {})).toContain("compute-identity");
		const journal = JSON.parse(await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8"));
		expect(journal.lxd.loginCustody).toBeUndefined();
	});

	it("refuses a vault login guest that gained an identity device", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([], work(), true));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		const instance = lxd.instance;
		expect(instance).toBeDefined();
		const identity = {
			type: "disk",
			path: "/var/lib/qorpera/identity",
			pool: "qorpera-vm",
			source: `${settings.identityVolumePrefix}${work().computeIdentityId}`,
		};
		lxd.instance = {
			...instance!,
			devices: { ...instance!.devices, "compute-identity": identity },
			expandedDevices: { ...instance!.expandedDevices, "compute-identity": identity },
		};
		await expect(backend.deliver(runner, delivery(work()))).rejects.toThrow("drifted");
	});

	it("rejects an unknown login custody in a retained journal", async () => {
		const directory = await root();
		const settings = governedConfig(join(directory, "state"));
		const lxd = new FakeLxd();
		const backend = new LxdCloudRunnerProviderBackend(
			settings,
			lxd,
			new FakeGuest(),
			fetchProvisioner([], work(), true),
		);
		await backend.acquire(runId, work(), new AbortController().signal);
		const path = join(settings.stateRoot, runId, "journal.json");
		const journal = JSON.parse(await readFile(path, "utf-8"));
		journal.lxd.loginCustody = "node";
		await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
		const restarted = new LxdCloudRunnerProviderBackend(
			settings,
			lxd,
			new FakeGuest(),
			fetchProvisioner([], work(), true),
		);
		await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow("login custody");
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

	it.each(["configured", "unconfigured"])(
		"hands the guest the coding command gateway only when configured (%s)",
		async (scope) => {
			const settings = governedConfig(join(await root(), "state"));
			const gateway = { origin: "https://coding.example.test:8789", token: "k".repeat(43) };
			if (scope === "configured") settings.nativeCompanyRuntime!.codingCommand = gateway;
			const lxd = new FakeLxd(),
				guest = new FakeGuest();
			const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
			const runner = await backend.acquire(runId, work(), new AbortController().signal);
			const files = new Map(lxd.filePushes.map((file) => [file.path, file.content]));
			const credential = "/var/lib/qorpera-bootstrap/credentials/qorpera-coding-command";
			expect(files.get(credential)).toBe(scope === "configured" ? `${gateway.token}\n` : "");
			expect(lxd.filePushes.find((file) => file.path === credential)?.mode).toBe(0o600);
			const bootstrap = JSON.parse(files.get("/var/lib/qorpera-bootstrap/bootstrap.json")!);
			const journalText = await readFile(join(settings.stateRoot, runId, "journal.json"), "utf-8");
			const journal = JSON.parse(journalText);
			const environment = files.get("/var/lib/qorpera-bootstrap/native-provider.env")!;
			if (scope === "configured") {
				const tokenSha256 = createHash("sha256").update(gateway.token).digest("hex");
				expect(bootstrap.company_runtime.coding_command).toEqual({
					url: gateway.origin,
					token_sha256: tokenSha256,
				});
				expect(journal.lxd.companyRuntime.codingCommand).toEqual({ url: gateway.origin, tokenSha256 });
				expect(environment).toContain(`QORPERA_CODING_COMMAND_URL=${gateway.origin}\n`);
			} else {
				expect(bootstrap.company_runtime.coding_command).toBeUndefined();
				expect(journal.lxd.companyRuntime.codingCommand).toBeUndefined();
				expect(environment).not.toContain("QORPERA_CODING_COMMAND_URL");
			}
			expect(journalText).not.toContain(gateway.token);
			expect(JSON.stringify(lxd.createCalls)).not.toContain(gateway.token);
			expect(JSON.stringify(lxd.filePushes.filter((file) => file.path !== credential))).not.toContain(gateway.token);
			const pushed = lxd.filePushes.length;
			const restarted = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
			await expect(restarted.acquire(runId, work(), new AbortController().signal)).resolves.toEqual(runner);
			expect(lxd.filePushes).toHaveLength(pushed);
		},
	);

	it("refuses a coding command token shared with another guest credential", async () => {
		const settings = governedConfig(join(await root(), "state"));
		settings.nativeCompanyRuntime!.codingCommand = {
			origin: "https://coding.example.test:8789",
			token: "q".repeat(43),
		};
		expect(
			() => new LxdCloudRunnerProviderBackend(settings, new FakeLxd(), new FakeGuest(), fetchProvisioner([])),
		).toThrow();
	});

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
			const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
			if (scope === "live") await expect(restarted.reconcile()).rejects.toThrow("journal");
			// A moved route leaves a stopped journal this build cannot read; its guest is gone, so it never fails the pass.
			else await expect(restarted.reconcile()).resolves.toBeUndefined();
			expect(log.mock.calls.map(([line]) => String(line))).toEqual(
				scope === "retired"
					? []
					: [`${scope === "live" ? "reconcile failed" : "dead journal kept"}: acquisition=${runId} stage=journal`],
			);
			log.mockRestore();
			if (scope === "retired-moved")
				await expect(restarted.acquire(runId, work(), new AbortController().signal)).rejects.toThrow("journal");
			// The journal keeps the digest of the credential its guest was given.
			expect(await readFile(path, "utf-8")).toBe(before);
		},
	);

	it.each([
		["retired", "added"],
		["retired", "removed"],
		["retired", "moved"],
		["live", "added"],
	])("keeps a %s journal %s-coding-route readable only when retired", async (scope, change) => {
		const settings = governedConfig(join(await root(), "state"));
		const gateway = { origin: "https://coding.example.test:8789", token: "c".repeat(43) };
		if (change !== "added") settings.nativeCompanyRuntime!.codingCommand = gateway;
		const lxd = new FakeLxd(),
			guest = new FakeGuest();
		const backend = new LxdCloudRunnerProviderBackend(settings, lxd, guest, fetchProvisioner([]));
		const runner = await backend.acquire(runId, work(), new AbortController().signal);
		if (scope === "retired") {
			await backend.stop(runner, "idle");
			await backend.reconcile();
		}
		const path = join(settings.stateRoot, runId, "journal.json");
		const before = await readFile(path, "utf-8");
		const later = governedConfig(settings.stateRoot);
		if (change === "added") later.nativeCompanyRuntime!.codingCommand = gateway;
		if (change === "moved")
			later.nativeCompanyRuntime!.codingCommand = {
				origin: "https://coding-2.example.test:8789",
				token: "d".repeat(43),
			};
		const restarted = new LxdCloudRunnerProviderBackend(later, lxd, guest, fetchProvisioner([]));
		// A node turning coding on (or off, or moving its gateway) must not strand the journals it kept.
		if (scope === "retired") await expect(restarted.reconcile()).resolves.toBeUndefined();
		else await expect(restarted.reconcile()).rejects.toThrow("journal");
		expect(await readFile(path, "utf-8")).toBe(before);
	});

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
