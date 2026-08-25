import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdInstanceSnapshotClient,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import {
	COMPANY_COMPUTER_GUEST_DATASET_PATH,
	type CompanyDatasetSnapshotClient,
	ExecCompanyDatasetSnapshotClient,
	type LxdCompanyComputerAuthority,
	type LxdCompanyComputerControlPlane,
	type LxdCompanyComputerLifecycleState,
	LxdCompanyComputerProviderBackend,
	type LxdCompanyComputerProviderConfig,
} from "../src/lxd-company-computer-provider.ts";
import type { LxdGuestTransport } from "../src/lxd-provider.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";

const logicalComputerId = "30000000-0000-4000-8000-000000000001";
const companyComputerId = "30000000-0000-4000-8000-000000000002";
const profileId = "30000000-0000-4000-8000-000000000003";
const environmentId = "30000000-0000-4000-8000-000000000004";
const computeIdentityId = "30000000-0000-4000-8000-000000000005";
const runnerId = "30000000-0000-4000-8000-000000000006";
const policySha256 = "e".repeat(64);
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stateRoot(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "qorpera-lxd-company-computer-"));
	roots.push(value);
	return value;
}

function work(runId: string): CloudRunnerWork {
	return {
		runId,
		jobId: "30000000-0000-4000-8000-000000000010",
		profileId,
		environmentId,
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: "30000000-0000-4000-8000-000000000011",
		substrateVersionId: "30000000-0000-4000-8000-000000000012",
		companySnapshotId: "30000000-0000-4000-8000-000000000013",
		staffAgentId: "30000000-0000-4000-8000-000000000014",
		staffVersion: 1,
		inputIds: ["30000000-0000-4000-8000-000000000015"],
		transcriptStartSequence: 1,
		deadlineAt: "2099-08-26T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		logicalComputerId,
		computeIdentityId,
		computeIdentityOwnershipKind: "company",
		computeTemplateKey: "qorpera-company-computer-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: policySha256,
		workerClass: "company_computer",
		requestedByUserId: "30000000-0000-4000-8000-000000000016",
		/* Step 2's work validator forbids member_connection sponsorship of a
		 * company-owned compute identity, so Company Computer work currently
		 * runs under company sponsorship; per-member native subscriptions on
		 * the shared machine are an open Step 3 contract decision. */
		sponsor: {
			bindingId: "30000000-0000-4000-8000-000000000017",
			version: 1,
			kind: "company_service_account",
			providerConnectionId: "30000000-0000-4000-8000-000000000018",
			providerConnectionVersion: 1,
			provider: "openai",
			authenticationMode: "cloud_service_account",
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

function config(root: string): LxdCompanyComputerProviderConfig {
	return {
		adapterId: "lxd-company-computer",
		nodeKey: "company41-node-01",
		supabaseUrl: "https://control.example.com",
		supabaseServiceKey: "service-key",
		supabasePublishableKey: "publishable-key",
		stateRoot: root,
		project: "qorpera",
		computerProfile: "qorpera-company-computer",
		networkInterface: "enp5s0",
		imageServer: "local",
		imageFingerprint: "a".repeat(64),
		storagePool: "default",
		identityVolumePrefix: "qorpera-identity-",
		identityVolumeSize: "1GiB",
		rootDiskSize: "32GiB",
		cpuLimit: 8,
		memoryLimit: "16GiB",
		nasDatasetRoot: "/srv/qorpera-nas",
		guestAssignmentPort: 8444,
		guestAssignmentSource: "10.41.0.1",
		nativeBridgePort: 8445,
		nativeExecutionGid: 990,
		guestReadyTimeoutMs: 2_000,
		runnerImage: `ghcr.io/qorpera/runner@sha256:${"b".repeat(64)}`,
		runnerPodmanPath: "/usr/bin/podman",
		runnerEntrypoint: "/usr/local/bin/qorpera-runner",
		runnerVersion: "v1",
		codexPath: "/usr/local/bin/codex",
		claudePath: "/usr/local/bin/claude",
	};
}

class FakeLxd implements LxdInstanceSnapshotClient {
	instance?: LxdInstanceRecord;
	volume?: LxdStorageVolumeRecord;
	createCalls: LxdCreateInstanceRequest[] = [];
	powerCalls: LxdInstancePowerAction[] = [];
	snapshotCalls: string[] = [];

	async getInstance(): Promise<LxdInstanceRecord | undefined> {
		return this.instance ? structuredClone(this.instance) : undefined;
	}

	async getInstanceState(): Promise<LxdInstanceStateRecord> {
		return {
			status: this.instance?.status ?? "Stopped",
			statusCode: 103,
			network: { enp5s0: { addresses: [{ family: "inet", address: "10.41.0.2", scope: "global" }] } },
		};
	}

	async getStorageVolume(): Promise<LxdStorageVolumeRecord | undefined> {
		return this.volume ? structuredClone(this.volume) : undefined;
	}

	async createStorageVolume(_project: string, _pool: string, request: LxdCreateStorageVolumeRequest): Promise<void> {
		this.volume = {
			name: request.name,
			type: request.type,
			contentType: request.content_type,
			description: request.description,
			config: structuredClone(request.config) as Record<string, string>,
		};
	}

	async createInstance(_project: string, request: LxdCreateInstanceRequest): Promise<void> {
		this.createCalls.push(structuredClone(request));
		this.instance = {
			name: request.name,
			type: request.type,
			status: "Stopped",
			statusCode: 102,
			config: structuredClone(request.config) as Record<string, string>,
			profiles: [...request.profiles],
			devices: structuredClone(request.devices) as Record<string, Record<string, string>>,
		};
	}

	async setInstancePower(_project: string, _name: string, action: LxdInstancePowerAction): Promise<void> {
		this.powerCalls.push(action);
		if (this.instance) this.instance = { ...this.instance, status: action === "start" ? "Running" : "Stopped" };
	}

	async pushInstanceFile(): Promise<void> {}

	async execInstance(): Promise<void> {}

	async createInstanceSnapshot(_project: string, _name: string, snapshotName: string): Promise<void> {
		this.snapshotCalls.push(snapshotName);
	}
}

class FakeControlPlane implements LxdCompanyComputerControlPlane {
	lifecycle: LxdCompanyComputerLifecycleState = "provisioning";
	nodeKey?: string;
	provisionCalls: Array<{ runId: string; clientRunnerId: string }> = [];
	transitions: Array<{ state: LxdCompanyComputerLifecycleState; nodeKey?: string }> = [];
	transitionDetails: Array<Record<string, unknown>> = [];

	async describeCompanyComputer(): Promise<LxdCompanyComputerAuthority> {
		return {
			companyComputerId,
			profileId,
			environmentId,
			logicalComputerId,
			lifecycleState: this.lifecycle,
			nasDataset: `companies/${environmentId}`,
			...(this.nodeKey === undefined ? {} : { nodeKey: this.nodeKey }),
			logicalComputerStatus: "active",
			computeIdentityId,
			templateKey: "qorpera-company-computer-linux",
			templateVersion: "v1",
			capabilities: ["agent_turn", "company_substrate"],
			computePolicySha256: policySha256,
		};
	}

	async provisionRunner(runId: string, clientRunnerId: string): Promise<unknown> {
		this.provisionCalls.push({ runId, clientRunnerId });
		return {
			runner_kind: "qorpera_computer",
			runner_id: runnerId,
			provider_adapter: "lxd-company-computer",
			status: "pending",
			worker_class: "company_computer",
			logical_computer_id: logicalComputerId,
			compute_identity_id: computeIdentityId,
			template_key: "qorpera-company-computer-linux",
			template_version: "v1",
			compute_policy_sha256: policySha256,
			capabilities: ["agent_turn", "company_substrate"],
		};
	}

	async transitionLifecycle(
		_companyComputerId: string,
		state: LxdCompanyComputerLifecycleState,
		nodeKey: string | undefined,
		detail: Record<string, unknown>,
	): Promise<void> {
		this.transitions.push({ state, ...(nodeKey === undefined ? {} : { nodeKey }) });
		this.transitionDetails.push(detail);
		this.lifecycle = state;
		if (state === "active" && nodeKey !== undefined) this.nodeKey = nodeKey;
	}
}

class FakeGuest implements LxdGuestTransport {
	deliveries: CloudRunnerAssignmentDelivery[] = [];

	async waitReady(): Promise<string> {
		return "10.41.0.2";
	}

	async deliver(
		_address: string,
		_port: number,
		_assignmentToken: string,
		delivery: CloudRunnerAssignmentDelivery,
	): Promise<void> {
		this.deliveries.push(delivery);
	}
}

function delivery(runId: string, assignmentId: string, expiresAt: string): CloudRunnerAssignmentDelivery {
	return {
		assignment: {
			assignmentId,
			claimId: "30000000-0000-4000-8000-000000000020",
			runId,
			jobId: "30000000-0000-4000-8000-000000000010",
			runnerId,
			capabilitySha256: "c".repeat(64),
			expiresAt,
		},
		capability: "A".repeat(43),
		work: work(runId),
	};
}

async function backend(datasetSnapshots?: CompanyDatasetSnapshotClient): Promise<{
	backend: LxdCompanyComputerProviderBackend;
	lxd: FakeLxd;
	controlPlane: FakeControlPlane;
	guest: FakeGuest;
}> {
	const lxd = new FakeLxd();
	const controlPlane = new FakeControlPlane();
	const guest = new FakeGuest();
	const provider = new LxdCompanyComputerProviderBackend(
		config(await stateRoot()),
		lxd,
		controlPlane,
		guest,
		datasetSnapshots,
	);
	return { backend: provider, lxd, controlPlane, guest };
}

describe("LxdCompanyComputerProviderBackend", () => {
	it("provisions the standing computer once and reuses it across runs", async () => {
		const { backend: provider, lxd, controlPlane } = await backend();
		const firstRun = "30000000-0000-4000-8000-000000000100";
		const secondRun = "30000000-0000-4000-8000-000000000101";
		const first = await provider.acquire(firstRun, work(firstRun), new AbortController().signal);
		expect(first.runnerId).toBe(runnerId);
		expect(first.workerClass).toBe("company_computer");
		expect(lxd.createCalls).toHaveLength(1);
		const request = lxd.createCalls[0];
		expect(request.name).toBe(`qorpera-cc-${logicalComputerId.replaceAll("-", "")}`);
		expect(request.devices["company-dataset"]).toEqual({
			type: "disk",
			path: COMPANY_COMPUTER_GUEST_DATASET_PATH,
			source: `/srv/qorpera-nas/companies/${environmentId}`,
		});
		expect(request.devices["compute-identity"]?.source).toBe(`qorpera-identity-${computeIdentityId}`);
		expect(controlPlane.transitions).toEqual([{ state: "active", nodeKey: "company41-node-01" }]);
		const second = await provider.acquire(secondRun, work(secondRun), new AbortController().signal);
		expect(second.runnerId).toBe(runnerId);
		expect(lxd.createCalls).toHaveLength(1);
		expect(controlPlane.transitions).toHaveLength(1);
		expect(controlPlane.provisionCalls).toEqual([
			{ runId: firstRun, clientRunnerId: logicalComputerId },
			{ runId: secondRun, clientRunnerId: logicalComputerId },
		]);
	});

	it("rejects managed sandbox work", async () => {
		const { backend: provider } = await backend();
		const runId = "30000000-0000-4000-8000-000000000102";
		const sandboxWork = { ...work(runId), workerClass: "managed_sandbox" as const };
		await expect(provider.acquire(runId, sandboxWork, new AbortController().signal)).rejects.toThrow(
			"only admits company_computer work",
		);
	});

	it("rejects work when the computer is placed on another node", async () => {
		const { backend: provider, controlPlane } = await backend();
		controlPlane.lifecycle = "active";
		controlPlane.nodeKey = "company41-node-02";
		const runId = "30000000-0000-4000-8000-000000000103";
		await expect(provider.acquire(runId, work(runId), new AbortController().signal)).rejects.toThrow(
			"placed on another node",
		);
	});

	it("rejects work while the computer is migrating", async () => {
		const { backend: provider, controlPlane } = await backend();
		controlPlane.lifecycle = "migrating";
		controlPlane.nodeKey = "company41-node-01";
		const runId = "30000000-0000-4000-8000-000000000104";
		await expect(provider.acquire(runId, work(runId), new AbortController().signal)).rejects.toThrow(
			"is migrating and cannot accept work",
		);
	});

	it("fences delivery to one live assignment and never powers off on stop", async () => {
		const { backend: provider, lxd, guest } = await backend();
		const runId = "30000000-0000-4000-8000-000000000105";
		const otherRun = "30000000-0000-4000-8000-000000000106";
		const runner = await provider.acquire(runId, work(runId), new AbortController().signal);
		const future = new Date(Date.now() + 300_000).toISOString();
		const first = delivery(runId, "30000000-0000-4000-8000-000000000110", future);
		await provider.deliver(runner, first);
		expect(guest.deliveries).toHaveLength(1);
		const competing = delivery(otherRun, "30000000-0000-4000-8000-000000000111", future);
		await expect(provider.deliver(runner, competing)).rejects.toThrow("fenced to another live assignment");
		await provider.stop(runner, "idle");
		expect(lxd.powerCalls.filter((action) => action === "stop")).toHaveLength(0);
		expect(lxd.instance?.status).toBe("Running");
		await provider.deliver(runner, competing);
		expect(guest.deliveries).toHaveLength(2);
	});

	it("snapshots through the control-plane lifecycle window", async () => {
		const { backend: provider, lxd, controlPlane } = await backend();
		const runId = "30000000-0000-4000-8000-000000000107";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		const snapshotName = await provider.snapshotComputer(logicalComputerId);
		expect(lxd.snapshotCalls).toEqual([snapshotName]);
		expect(controlPlane.transitions.slice(1)).toEqual([{ state: "snapshotting" }, { state: "active" }]);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.transitionDetails.at(-1)).toEqual({ snapshot: snapshotName, dataset_captured: false });
	});

	it("captures the NAS dataset inside the snapshotting window", async () => {
		const datasetCalls: Array<{ dataset: string; snapshot: string }> = [];
		const {
			backend: provider,
			lxd,
			controlPlane,
		} = await backend({
			async snapshotDataset(dataset, snapshot) {
				datasetCalls.push({ dataset, snapshot });
			},
		});
		const runId = "30000000-0000-4000-8000-000000000108";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		const snapshotName = await provider.snapshotComputer(logicalComputerId);
		expect(datasetCalls).toEqual([{ dataset: `companies/${environmentId}`, snapshot: snapshotName }]);
		expect(lxd.snapshotCalls).toEqual([snapshotName]);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.transitionDetails.at(-1)).toEqual({ snapshot: snapshotName, dataset_captured: true });
	});

	it("fails the snapshot closed when the working world cannot be captured", async () => {
		const {
			backend: provider,
			lxd,
			controlPlane,
		} = await backend({
			async snapshotDataset() {
				throw new Error("nas unreachable");
			},
		});
		const runId = "30000000-0000-4000-8000-000000000109";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		await expect(provider.snapshotComputer(logicalComputerId)).rejects.toThrow("nas unreachable");
		expect(lxd.snapshotCalls).toEqual([]);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.transitionDetails.at(-1)).toMatchObject({ dataset_captured: false });
	});

	it("substitutes the dataset and snapshot into the exec template without a shell", async () => {
		const invocations: Array<{ command: string; args: readonly string[] }> = [];
		const client = new ExecCompanyDatasetSnapshotClient(
			["ssh", "qorpera-nas", "zfs", "snapshot", "{dataset}@{snapshot}"],
			async (command, args) => {
				invocations.push({ command, args });
				return { code: 0, stderr: "" };
			},
		);
		await client.snapshotDataset(`companies/${environmentId}`, "qorpera-cc-2026-08-26");
		expect(invocations).toEqual([
			{
				command: "ssh",
				args: ["qorpera-nas", "zfs", "snapshot", `companies/${environmentId}@qorpera-cc-2026-08-26`],
			},
		]);
	});

	it("rejects exec templates and values outside the snapshot contract", async () => {
		expect(() => new ExecCompanyDatasetSnapshotClient(["zfs", "snapshot", "tank@{snapshot}"])).toThrow(
			"must reference {dataset} and {snapshot}",
		);
		const client = new ExecCompanyDatasetSnapshotClient(["zfs", "snapshot", "{dataset}@{snapshot}"], async () => ({
			code: 0,
			stderr: "",
		}));
		await expect(client.snapshotDataset("Bad Dataset", "qorpera-cc-1")).rejects.toThrow("dataset name is invalid");
		await expect(client.snapshotDataset("companies/a", "Bad Name!")).rejects.toThrow("snapshot name is invalid");
		const failing = new ExecCompanyDatasetSnapshotClient(["zfs", "snapshot", "{dataset}@{snapshot}"], async () => ({
			code: 1,
			stderr: "dataset does not exist",
		}));
		await expect(failing.snapshotDataset("companies/a", "qorpera-cc-1")).rejects.toThrow("dataset does not exist");
	});
});
