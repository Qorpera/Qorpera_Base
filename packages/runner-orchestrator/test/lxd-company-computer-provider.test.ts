import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdPersistentInstanceClient,
	LxdStorageVolumeRecord,
} from "../src/lxd-client.ts";
import {
	COMPANY_COMPUTER_GUEST_DATASET_PATH,
	type CompanyDatasetSnapshotClient,
	type CompanyDatasetSourceVerifier,
	ExecCompanyDatasetSnapshotClient,
	LinuxNfsCompanyDatasetSourceVerifier,
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
const availableDatasetSource: CompanyDatasetSourceVerifier = {
	async verifyDatasetSource() {},
};

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
		nasSharedGid: 100,
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
		datasetSnapshotIntervalSeconds: 0,
	};
}

class FakeLxd implements LxdPersistentInstanceClient {
	instance?: LxdInstanceRecord;
	volume?: LxdStorageVolumeRecord;
	availableImages = new Set(["a".repeat(64)]);
	createCalls: LxdCreateInstanceRequest[] = [];
	powerCalls: LxdInstancePowerAction[] = [];
	snapshotCalls: string[] = [];
	deleteCalls: string[] = [];

	async getInstance(): Promise<LxdInstanceRecord | undefined> {
		return this.instance ? structuredClone(this.instance) : undefined;
	}

	async hasImage(_project: string, fingerprint: string): Promise<boolean> {
		return this.availableImages.has(fingerprint);
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
			config: {
				...(structuredClone(request.config) as Record<string, string>),
				"volatile.base_image": request.source.fingerprint,
			},
			profiles: [...request.profiles],
			devices: structuredClone(request.devices) as Record<string, Record<string, string>>,
		};
	}

	async setInstancePower(_project: string, _name: string, action: LxdInstancePowerAction): Promise<void> {
		this.powerCalls.push(action);
		if (this.instance) this.instance = { ...this.instance, status: action === "start" ? "Running" : "Stopped" };
	}

	pushedFiles: Array<{ path: string; content: string }> = [];

	async pushInstanceFile(_project: string, _name: string, path: string, content: string): Promise<void> {
		this.pushedFiles.push({ path, content });
	}

	async execInstance(): Promise<void> {}

	async createInstanceSnapshot(_project: string, _name: string, snapshotName: string): Promise<void> {
		this.snapshotCalls.push(snapshotName);
	}

	async deleteInstance(_project: string, name: string): Promise<void> {
		this.deleteCalls.push(name);
		this.instance = undefined;
	}
}

class FakeControlPlane implements LxdCompanyComputerControlPlane {
	lifecycle: LxdCompanyComputerLifecycleState = "provisioning";
	nodeKey?: string;
	openScreens = 1;
	openScreenReads = 0;
	provisionCalls: Array<{ runId: string; clientRunnerId: string }> = [];
	transitions: Array<{ state: LxdCompanyComputerLifecycleState; nodeKey?: string }> = [];
	transitionDetails: Array<Record<string, unknown>> = [];
	transitionErrorState?: LxdCompanyComputerLifecycleState;
	prepareImageRefreshCalls: Array<{ from: string; to: string }> = [];
	prepareImageRefreshError?: Error;
	nasDataset = "company41";
	relocateCalls: Array<{ dataset: string; detail: Record<string, unknown> }> = [];
	relocateError?: Error;

	async countOpenScreens(): Promise<number> {
		this.openScreenReads += 1;
		return this.openScreens;
	}

	async describeCompanyComputer(): Promise<LxdCompanyComputerAuthority> {
		return {
			companyComputerId,
			profileId,
			environmentId,
			logicalComputerId,
			lifecycleState: this.lifecycle,
			nasDataset: this.nasDataset,
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
		if (this.transitionErrorState === state) throw new Error(`transition ${state} unavailable`);
		this.transitions.push({ state, ...(nodeKey === undefined ? {} : { nodeKey }) });
		this.transitionDetails.push(detail);
		this.lifecycle = state;
		if (state === "active" && nodeKey !== undefined) this.nodeKey = nodeKey;
	}

	async prepareImageRefresh(
		_companyComputerId: string,
		fromImageFingerprint: string,
		toImageFingerprint: string,
	): Promise<LxdCompanyComputerAuthority> {
		if (this.prepareImageRefreshError) throw this.prepareImageRefreshError;
		if (this.openScreens > 0) throw new Error("company computer image refresh requires an idle computer");
		this.prepareImageRefreshCalls.push({ from: fromImageFingerprint, to: toImageFingerprint });
		this.transitions.push({ state: "recovering" });
		this.transitionDetails.push({
			reason: "signed_image_refresh",
			dataset: this.nasDataset,
			from_image_fingerprint: fromImageFingerprint,
			to_image_fingerprint: toImageFingerprint,
		});
		this.lifecycle = "recovering";
		return this.describeCompanyComputer();
	}

	async relocateDataset(
		_companyComputerId: string,
		nasDataset: string,
		detail: Record<string, unknown>,
	): Promise<LxdCompanyComputerAuthority> {
		if (this.relocateError) throw this.relocateError;
		this.relocateCalls.push({ dataset: nasDataset, detail });
		this.nasDataset = nasDataset;
		this.lifecycle = "recovering";
		return this.describeCompanyComputer();
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

async function backend(
	datasetSnapshots?: CompanyDatasetSnapshotClient,
	configOverrides: Partial<LxdCompanyComputerProviderConfig> = {},
): Promise<{
	backend: LxdCompanyComputerProviderBackend;
	lxd: FakeLxd;
	controlPlane: FakeControlPlane;
	guest: FakeGuest;
	root: string;
}> {
	const lxd = new FakeLxd();
	const controlPlane = new FakeControlPlane();
	const guest = new FakeGuest();
	const root = await stateRoot();
	const provider = new LxdCompanyComputerProviderBackend(
		{ ...config(root), ...configOverrides },
		lxd,
		controlPlane,
		guest,
		datasetSnapshots,
		availableDatasetSource,
	);
	return { backend: provider, lxd, controlPlane, guest, root };
}

async function ageScreensIdleObservation(root: string, computerId: string, milliseconds: number): Promise<void> {
	const journalPath = join(root, "computers", computerId, "journal.json");
	const journal = JSON.parse(await readFile(journalPath, "utf-8")) as Record<string, unknown>;
	if (typeof journal.screensIdleSince !== "string") throw new Error("journal holds no idle observation");
	journal.screensIdleSince = new Date(Date.now() - milliseconds).toISOString();
	await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

async function ageDatasetSnapshotObservation(root: string, computerId: string, milliseconds: number): Promise<void> {
	const journalPath = join(root, "computers", computerId, "journal.json");
	const journal = JSON.parse(await readFile(journalPath, "utf-8")) as Record<string, unknown>;
	journal.createdAt = new Date(Date.now() - milliseconds).toISOString();
	delete journal.lastDatasetSnapshotAt;
	delete journal.lastDatasetSnapshotName;
	await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
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
			source: "/srv/qorpera-nas/company41",
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

	it("provisions the standing machine for the operator without any work", async () => {
		const { backend: provider, lxd, controlPlane } = await backend();
		await provider.provisionComputer(logicalComputerId);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.instance?.status).toBe("Running");
		expect(controlPlane.provisionCalls).toHaveLength(0);
		expect(controlPlane.transitions).toEqual([{ state: "active", nodeKey: "company41-node-01" }]);
		expect(controlPlane.transitionDetails).toEqual([{ reason: "operator_provision" }]);
		/* Idempotent: a second provision re-ensures instead of recreating. */
		await provider.provisionComputer(logicalComputerId);
		expect(lxd.createCalls).toHaveLength(1);
		expect(controlPlane.transitions).toHaveLength(1);
	});

	it("powers the machine off after the screens go idle and back on when one opens", async () => {
		const { backend: provider, lxd, controlPlane, root } = await backend();
		const runId = "30000000-0000-4000-8000-000000000112";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		controlPlane.openScreens = 1;
		await provider.reconcile();
		expect(lxd.powerCalls.filter((action) => action === "stop")).toHaveLength(0);
		controlPlane.openScreens = 0;
		await provider.reconcile();
		/* First idle observation only starts the clock. */
		expect(lxd.powerCalls.filter((action) => action === "stop")).toHaveLength(0);
		await ageScreensIdleObservation(root, logicalComputerId, 10 * 60_000);
		await provider.reconcile();
		expect(lxd.powerCalls.filter((action) => action === "stop")).toHaveLength(1);
		expect(lxd.instance?.status).toBe("Stopped");
		/* A screen opening while the machine sleeps powers it back on. */
		controlPlane.openScreens = 1;
		await provider.reconcile();
		expect(lxd.instance?.status).toBe("Running");
	});

	it("keeps a maintenance stop down even when screens open", async () => {
		const { backend: provider, lxd, controlPlane } = await backend();
		const runId = "30000000-0000-4000-8000-000000000113";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		await provider.stopComputer(logicalComputerId);
		expect(lxd.instance?.status).toBe("Stopped");
		controlPlane.openScreens = 1;
		await provider.reconcile();
		expect(lxd.instance?.status).toBe("Stopped");
	});

	it("refuses a root-only rollback point when NAS snapshot tooling is absent", async () => {
		const { backend: provider, lxd, controlPlane } = await backend();
		const runId = "30000000-0000-4000-8000-000000000107";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		await expect(provider.snapshotComputer(logicalComputerId)).rejects.toThrow("tooling is not configured");
		expect(lxd.snapshotCalls).toEqual([]);
		expect(controlPlane.transitions).toEqual([{ state: "active", nodeKey: "company41-node-01" }]);
		expect(controlPlane.lifecycle).toBe("active");
	});

	it("bootstraps the screen agent config block and its viewer credential", async () => {
		const { backend: provider, lxd } = await backend();
		const runId = "30000000-0000-4000-8000-000000000112";
		await provider.acquire(runId, work(runId), new AbortController().signal);
		const bootstrap = lxd.pushedFiles.find(
			(file) => file.path === "/var/lib/qorpera-bootstrap/company-computer.json",
		);
		expect(bootstrap).toBeDefined();
		const parsed = JSON.parse((bootstrap as { content: string }).content) as {
			schema: string;
			nas_shared_gid: number;
			dataset_layout: Record<string, unknown>;
			screens: Record<string, unknown>;
		};
		expect(parsed.schema).toBe("qorpera.company-computer-bootstrap/v2");
		expect(parsed.nas_shared_gid).toBe(100);
		expect(parsed.dataset_layout).toEqual({
			liveDirectory: "live",
			profilesDirectory: "profiles",
			stateDirectory: ".qorpera-computer",
		});
		expect(parsed.screens).toEqual({
			viewer_host: "0.0.0.0",
			viewer_port: 8446,
			viewer_trusted_source: "10.41.0.1",
			poll_seconds: 30,
		});
		const viewerCredential = lxd.pushedFiles.find(
			(file) => file.path === "/var/lib/qorpera-bootstrap/credentials/qorpera-screen-viewer",
		);
		expect(viewerCredential).toBeDefined();
		expect((viewerCredential as { content: string }).content.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const runnerConfig = lxd.pushedFiles.find(
			(file) => file.path === "/var/lib/qorpera-bootstrap/runner-config.json",
		);
		expect(runnerConfig).toBeDefined();
		const runner = JSON.parse((runnerConfig as { content: string }).content) as Record<string, unknown>;
		expect(runner.schema).toBe("qorpera.company-computer-service/v2");
		expect(runner.temporary_root).toBe("/srv/qorpera/dataset/.qorpera-computer/runner");
		expect(runner.environment).toEqual({
			QORPERA_LIVE_COMPANY_ROOT: "/srv/qorpera/dataset/live",
			QORPERA_LIVE_COMPANY_PROFILE_ID: profileId,
		});
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
		expect(datasetCalls).toEqual([{ dataset: "company41", snapshot: snapshotName }]);
		expect(lxd.snapshotCalls).toEqual([]);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.transitionDetails.at(-1)).toEqual({ snapshot: snapshotName, dataset_captured: true });
	});

	it("takes occasional NAS rollback snapshots without a publication pass", async () => {
		const datasetCalls: Array<{ dataset: string; snapshot: string }> = [];
		const {
			backend: provider,
			lxd,
			controlPlane,
			root,
		} = await backend(
			{
				async snapshotDataset(dataset, snapshot) {
					datasetCalls.push({ dataset, snapshot });
				},
			},
			{ datasetSnapshotIntervalSeconds: 900 },
		);
		await provider.provisionComputer(logicalComputerId);
		await ageDatasetSnapshotObservation(root, logicalComputerId, 901_000);
		await provider.reconcile();
		expect(datasetCalls).toHaveLength(1);
		expect(datasetCalls[0]?.dataset).toBe("company41");
		expect(datasetCalls[0]?.snapshot).toMatch(/^qorpera-data-/);
		expect(lxd.snapshotCalls).toEqual([]);
		expect(controlPlane.transitionDetails.slice(-2)).toEqual([
			{ snapshot: datasetCalls[0]?.snapshot, reason: "scheduled_rollback" },
			{
				snapshot: datasetCalls[0]?.snapshot,
				dataset_captured: true,
				reason: "scheduled_rollback",
			},
		]);
	});

	it("relocates a stopped machine onto the existing live company root and preserves identity", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		controlPlane.nasDataset = `companies/${environmentId}`;
		await provider.provisionComputer(logicalComputerId);
		const identityVolume = lxd.createCalls[0]?.devices["compute-identity"]?.source;
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		const relocatedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), nasDatasetRoot: "/mnt/qorpera-companies" },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);
		await relocatedProvider.relocateComputerDataset(logicalComputerId, "company41");
		expect(controlPlane.relocateCalls).toEqual([
			{
				dataset: "company41",
				detail: { reason: "adopt_existing_company_root", from: `companies/${environmentId}` },
			},
		]);
		expect(lxd.deleteCalls).toEqual([`qorpera-cc-${logicalComputerId.replaceAll("-", "")}`]);
		expect(lxd.createCalls).toHaveLength(2);
		expect(lxd.createCalls[1]?.devices["company-dataset"]?.source).toBe("/mnt/qorpera-companies/company41");
		expect(lxd.createCalls[1]?.devices["compute-identity"]?.source).toBe(identityVolume);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.nasDataset).toBe("company41");
		expect(controlPlane.transitions.at(-1)).toEqual({ state: "active", nodeKey: "company41-node-01" });
		expect(controlPlane.transitions).not.toContainEqual({ state: "recovering" });
	});

	it("leaves the active machine untouched when atomic dataset relocation is rejected", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		controlPlane.nasDataset = `companies/${environmentId}`;
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		controlPlane.relocateError = new Error("leased job raced relocation");
		const relocatedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), nasDatasetRoot: "/mnt/qorpera-companies" },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);
		await expect(relocatedProvider.relocateComputerDataset(logicalComputerId, "company41")).rejects.toThrow(
			"leased job raced relocation",
		);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.nasDataset).toBe(`companies/${environmentId}`);
		expect(lxd.deleteCalls).toEqual([]);
		expect(lxd.createCalls).toHaveLength(1);
	});

	it("refreshes only the disposable root to a new signed image without relocating the NAS dataset", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		await provider.provisionComputer(logicalComputerId);
		const identityVolume = lxd.createCalls[0]?.devices["compute-identity"]?.source;
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		const nextFingerprint = "d".repeat(64);
		lxd.availableImages.add(nextFingerprint);
		const refreshedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), imageFingerprint: nextFingerprint },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);

		await refreshedProvider.refreshComputerImage(logicalComputerId);

		expect(controlPlane.relocateCalls).toEqual([]);
		expect(lxd.deleteCalls).toEqual([`qorpera-cc-${logicalComputerId.replaceAll("-", "")}`]);
		expect(lxd.createCalls).toHaveLength(2);
		expect(lxd.createCalls[1]?.source.fingerprint).toBe(nextFingerprint);
		expect(lxd.createCalls[1]?.devices["company-dataset"]?.source).toBe("/srv/qorpera-nas/company41");
		expect(lxd.createCalls[1]?.devices["compute-identity"]?.source).toBe(identityVolume);
		expect(controlPlane.transitions.slice(-2)).toEqual([
			{ state: "recovering" },
			{ state: "active", nodeKey: "company41-node-01" },
		]);
		expect(controlPlane.prepareImageRefreshCalls).toEqual([{ from: "a".repeat(64), to: nextFingerprint }]);
		expect(controlPlane.transitionDetails.at(-2)).toEqual({
			reason: "signed_image_refresh",
			dataset: "company41",
			from_image_fingerprint: "a".repeat(64),
			to_image_fingerprint: nextFingerprint,
		});
		expect(controlPlane.lifecycle).toBe("active");

		/* The accepted target is idempotent and does not replace the root twice. */
		await refreshedProvider.refreshComputerImage(logicalComputerId);
		expect(lxd.deleteCalls).toHaveLength(1);
		expect(lxd.createCalls).toHaveLength(2);
	});

	it("rejects an unavailable refresh image before changing lifecycle or deleting the current root", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		const refreshedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), imageFingerprint: "d".repeat(64) },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);

		await expect(refreshedProvider.refreshComputerImage(logicalComputerId)).rejects.toThrow(
			"signed Company Computer image is not available",
		);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.transitions).not.toContainEqual({ state: "recovering" });
		expect(lxd.deleteCalls).toEqual([]);
		expect(lxd.createCalls).toHaveLength(1);
	});

	it("leaves the current root untouched when atomic image-refresh admission rejects raced work", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		controlPlane.prepareImageRefreshError = new Error("runner lease raced image refresh");
		const nextFingerprint = "d".repeat(64);
		lxd.availableImages.add(nextFingerprint);
		const refreshedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), imageFingerprint: nextFingerprint },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);

		await expect(refreshedProvider.refreshComputerImage(logicalComputerId)).rejects.toThrow(
			"runner lease raced image refresh",
		);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.prepareImageRefreshCalls).toEqual([]);
		expect(lxd.deleteCalls).toEqual([]);
		expect(lxd.createCalls).toHaveLength(1);
	});

	it("rejects an image refresh while a screen is open", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		const nextFingerprint = "d".repeat(64);
		lxd.availableImages.add(nextFingerprint);
		const refreshedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), imageFingerprint: nextFingerprint },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);

		await expect(refreshedProvider.refreshComputerImage(logicalComputerId)).rejects.toThrow(
			"requires no live assignment or open screen",
		);
		expect(controlPlane.lifecycle).toBe("active");
		expect(lxd.deleteCalls).toEqual([]);
		expect(lxd.createCalls).toHaveLength(1);
	});

	it("resumes an already-created replacement when only the final lifecycle transition failed", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		controlPlane.nasDataset = `companies/${environmentId}`;
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		controlPlane.transitionErrorState = "active";
		const relocatedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), nasDatasetRoot: "/mnt/qorpera-companies" },
			lxd,
			controlPlane,
			guest,
			undefined,
			availableDatasetSource,
		);
		await expect(relocatedProvider.relocateComputerDataset(logicalComputerId, "company41")).rejects.toThrow(
			"transition active unavailable",
		);
		expect(controlPlane.lifecycle).toBe("recovering");
		expect(lxd.deleteCalls).toHaveLength(1);
		expect(lxd.createCalls).toHaveLength(2);

		controlPlane.transitionErrorState = undefined;
		await relocatedProvider.recoverComputer(logicalComputerId);
		expect(controlPlane.lifecycle).toBe("active");
		expect(lxd.deleteCalls).toHaveLength(1);
		expect(lxd.createCalls).toHaveLength(2);
	});

	it("rejects dataset relocation before changing authority when the NAS target is unavailable", async () => {
		const { backend: provider, lxd, controlPlane, guest, root } = await backend();
		controlPlane.nasDataset = `companies/${environmentId}`;
		await provider.provisionComputer(logicalComputerId);
		await provider.stopComputer(logicalComputerId);
		controlPlane.openScreens = 0;
		const unavailableDatasetSource: CompanyDatasetSourceVerifier = {
			async verifyDatasetSource() {
				throw new Error("NAS mount unavailable");
			},
		};
		const relocatedProvider = new LxdCompanyComputerProviderBackend(
			{ ...config(root), nasDatasetRoot: "/mnt/qorpera-companies" },
			lxd,
			controlPlane,
			guest,
			undefined,
			unavailableDatasetSource,
		);
		await expect(relocatedProvider.relocateComputerDataset(logicalComputerId, "company41")).rejects.toThrow(
			"NAS mount unavailable",
		);
		expect(controlPlane.relocateCalls).toEqual([]);
		expect(controlPlane.lifecycle).toBe("active");
		expect(controlPlane.nasDataset).toBe(`companies/${environmentId}`);
		expect(lxd.deleteCalls).toEqual([]);
		expect(lxd.createCalls).toHaveLength(1);
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

	it("proves the dataset source is a writable NFS mount instead of a local fallback directory", async () => {
		const root = await stateRoot();
		const nasRoot = join(root, "nas share");
		const datasetSource = join(nasRoot, "company41");
		const mountInfoPath = join(root, "mountinfo");
		await mkdir(datasetSource, { recursive: true });
		const encodedMountPoint = (await realpath(nasRoot)).replaceAll("\\", "\\134").replaceAll(" ", "\\040");
		const verifier = new LinuxNfsCompanyDatasetSourceVerifier(mountInfoPath);
		await writeFile(
			mountInfoPath,
			`36 25 0:32 / ${encodedMountPoint} rw,relatime - nfs4 192.0.2.1:/volume1/qorpera rw\n`,
			"utf-8",
		);
		await expect(verifier.verifyDatasetSource(nasRoot, datasetSource)).resolves.toBeUndefined();

		await writeFile(mountInfoPath, `36 25 0:32 / ${encodedMountPoint} rw,relatime - ext4 /dev/sda1 rw\n`, "utf-8");
		await expect(verifier.verifyDatasetSource(nasRoot, datasetSource)).rejects.toThrow("not backed by NFS");

		await writeFile(
			mountInfoPath,
			`36 25 0:32 / ${encodedMountPoint} ro,relatime - nfs4 192.0.2.1:/volume1/qorpera ro\n`,
			"utf-8",
		);
		await expect(verifier.verifyDatasetSource(nasRoot, datasetSource)).rejects.toThrow("not mounted read-write");
	});
});
