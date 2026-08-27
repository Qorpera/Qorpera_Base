import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import {
	LxdCloudRunnerProviderBackend,
	type LxdCloudRunnerProviderConfig,
	type LxdGuestTransport,
} from "../src/lxd-provider.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";

const roots: string[] = [];
const runId = "20000000-0000-4000-8000-000000000001";
const runnerId = "20000000-0000-4000-8000-000000000002";

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

class FakeLxd implements LxdClient {
	instance?: LxdInstanceRecord;
	volume?: LxdStorageVolumeRecord;
	createCalls: LxdCreateInstanceRequest[] = [];
	createVolumeCalls: LxdCreateStorageVolumeRequest[] = [];
	powerCalls: LxdInstancePowerAction[] = [];
	filePushes: Array<{ path: string; content: string; mode: number }> = [];
	execCalls: string[][] = [];

	async getInstance(_project: string, _name: string): Promise<LxdInstanceRecord | undefined> {
		return this.instance ? structuredClone(this.instance) : undefined;
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

	async getStorageVolume(): Promise<LxdStorageVolumeRecord | undefined> {
		return this.volume ? structuredClone(this.volume) : undefined;
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

function fetchProvisioner(requests: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		return new Response(
			JSON.stringify({
				runner_id: runnerId,
				runner_kind: "qorpera_computer",
				status: "pending",
				provider_adapter: "lxd",
				compute_identity_id: work().computeIdentityId,
				logical_computer_id: null,
				worker_class: "managed_sandbox",
				template_key: "qorpera-member-linux",
				template_version: "v1",
				compute_policy_sha256: "f".repeat(64),
				capabilities: ["agent_turn"],
			}),
			{ status: url.includes("qorpera_provision_execution_runner") ? 200 : 404 },
		);
	}) as typeof fetch;
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

describe("LXD cloud runner provider", () => {
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
		expect(lxd.filePushes).toHaveLength(14);

		await restarted.deliver(runner, delivery(request));
		expect(guest.deliveries).toHaveLength(1);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "assigned",
			assignmentId: delivery(request).assignment.assignmentId,
		});
		await restarted.stop(runner, "idle");
		expect(lxd.powerCalls).toEqual(["start", "stop"]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "idle",
		});
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

	it("rejects Step 3 long-lived computer work", async () => {
		const directory = await root();
		const request = {
			...work(),
			workerClass: "company_computer" as const,
			logicalComputerId: "20000000-0000-4000-8000-000000000017",
		};
		const backend = new LxdCloudRunnerProviderBackend(
			config(join(directory, "state")),
			new FakeLxd(),
			new FakeGuest(),
			fetchProvisioner([]),
		);
		await expect(backend.acquire(runId, request, new AbortController().signal)).rejects.toThrow(
			"does not admit long-lived company computers",
		);
	});
});
