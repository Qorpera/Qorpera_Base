import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	HttpLxdGuestTransport,
	LxdCloudRunnerProviderBackend,
	type LxdCloudRunnerProviderConfig,
	type LxdGuestTransport,
} from "../src/lxd-provider.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";

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
	runnerExited = false;

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
		if (command[0] === "/bin/sh" && command[2]?.includes("journalctl") && !this.runnerExited)
			throw new Error("LXD instance command failed");
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

	it("retires a one-run guest as soon as its runner unit has exited, and leaves live guests alone", async () => {
		const { stateRoot, lxd, guest, fetchImplementation, request, runId, journalPath } = await acquiredFixture();
		const backend = new LxdCloudRunnerProviderBackend(config(stateRoot), lxd, guest, fetchImplementation);
		const before = lxd.execCalls.length;
		await backend.reconcile();
		expect(lxd.execCalls.slice(before)).toEqual([
			["/bin/sh", "-c", expect.stringContaining("qorpera-ephemeral-runner.service")],
		]);
		expect(lxd.execCalls.at(-1)?.[2]).toContain('grep -q "^Started "');
		expect(lxd.deleteCalls).toEqual([]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({ physicalState: "registered" });
		lxd.runnerExited = true;
		await backend.reconcile();
		expect(lxd.powerCalls.at(-1)).toBe("stop");
		expect(lxd.deleteCalls).toEqual([lxd.createCalls[0]?.name]);
		expect(JSON.parse(await readFile(journalPath, "utf-8"))).toMatchObject({
			physicalState: "stopped",
			stopReason: "idle",
		});
		await expect(backend.acquire(runId, request, new AbortController().signal)).rejects.toThrow("cannot be replayed");
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

	it("pins guest transport destinations, refuses redirects, and cancels unused response bodies", async () => {
		const lxd = new FakeLxd();
		vi.spyOn(lxd, "getInstanceState").mockResolvedValue({
			status: "Running",
			statusCode: 103,
			network: { enp5s0: { addresses: [{ family: "inet", address: "10.41.0.2", scope: "global" }] } },
		});
		const cancel = vi.fn();
		const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			return new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
		});
		const transport = new HttpLxdGuestTransport(lxd, fetcher);
		const address = await transport.waitReady("qorpera-runners", "guest", "enp5s0", 8082, 1_000);
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
