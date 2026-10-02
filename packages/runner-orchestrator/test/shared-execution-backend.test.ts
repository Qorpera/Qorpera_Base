import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LxdNativeCompanyRuntimeConfig } from "../src/lxd-company-runtime.ts";
import type { CloudRunnerAssignmentDelivery, CloudRunnerWork } from "../src/orchestrator.ts";
import { ProviderAdmissionRefused } from "../src/provider-shared.ts";
import {
	parseUnitStates,
	SharedExecutionAdmissionRefused,
	SharedExecutionProviderBackend,
	type SharedExecutionProviderConfig,
	type SharedExecutionUnitControl,
	sharedExecutionAcquisitionId,
} from "../src/shared-execution-backend.ts";
import type { SharedExecutionIdentityState } from "../src/shared-execution-identity.ts";

const roots: string[] = [];
const runId = "30000000-0000-4000-8000-000000000001";
const runnerId = "30000000-0000-4000-8000-000000000002";
const computeIdentityId = "30000000-0000-4000-8000-000000000011";
const companyId = "30000000-0000-4000-8000-000000000004";
const secretBrokerCa = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf-8",
);
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "qorpera-shared-execution-"));
	roots.push(value);
	return value;
}

function work(overrides: Partial<CloudRunnerWork> = {}): CloudRunnerWork {
	return {
		runId,
		jobId: "30000000-0000-4000-8000-000000000003",
		profileId: companyId,
		environmentId: "30000000-0000-4000-8000-000000000005",
		sourceKind: "session_turn",
		sourceId: runId,
		sessionId: "30000000-0000-4000-8000-000000000006",
		substrateVersionId: "30000000-0000-4000-8000-000000000007",
		companySnapshotId: "30000000-0000-4000-8000-000000000008",
		staffAgentId: "30000000-0000-4000-8000-000000000009",
		staffVersion: 1,
		inputIds: ["30000000-0000-4000-8000-000000000010"],
		transcriptStartSequence: 1,
		deadlineAt: "2099-08-21T18:00:00.000Z",
		requiredCapability: "agent_turn",
		jobType: "agent_turn",
		payload: {},
		publicationMode: "automatic",
		reviewerStaffIds: [],
		computeIdentityId,
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: "30000000-0000-4000-8000-000000000012",
		computeTemplateKey: "qorpera-member-linux",
		computeTemplateVersion: "v1",
		computePolicySha256: "f".repeat(64),
		workerClass: "managed_sandbox",
		requestedByUserId: "30000000-0000-4000-8000-000000000012",
		sponsoredByUserId: "30000000-0000-4000-8000-000000000012",
		sponsor: {
			bindingId: "30000000-0000-4000-8000-000000000013",
			version: 1,
			kind: "member_connection",
			providerConnectionId: "30000000-0000-4000-8000-000000000014",
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
		...overrides,
	};
}

class FakeUnits implements SharedExecutionUnitControl {
	readonly activeUnits = new Set<string>();
	readonly log: string[] = [];
	/** Units that ignore stop, like a native host that never answers SIGTERM. */
	readonly stuck = new Set<string>();
	/** Units that survive even SIGKILL (a process stuck in the kernel). */
	readonly unkillable = new Set<string>();
	/** Running units whose health endpoint does not answer yet (still loading). */
	readonly loading = new Set<string>();
	async start(unit: string): Promise<void> {
		this.log.push(`start ${unit}`);
		this.activeUnits.add(unit);
	}
	async stop(unit: string): Promise<void> {
		this.log.push(`stop ${unit}`);
		if (!this.stuck.has(unit)) this.activeUnits.delete(unit);
	}
	async kill(unit: string): Promise<void> {
		this.log.push(`kill ${unit}`);
		if (!this.unkillable.has(unit)) this.activeUnits.delete(unit);
	}
	async active(unit: string): Promise<boolean> {
		return this.activeUnits.has(unit);
	}
	async activeSet(units: readonly string[]): Promise<Set<string>> {
		return new Set(units.filter((unit) => this.activeUnits.has(unit)));
	}
}

interface Fixture {
	backend: SharedExecutionProviderBackend;
	units: FakeUnits;
	rpc: Array<{ name: string; body: Record<string, unknown> }>;
	deliveries: Array<{ port: number; authorization: string | null; body: Record<string, unknown> }>;
	stateRoot: string;
	runRoot: string;
	identityRoot: string;
	masterKey: string;
	runtime: LxdNativeCompanyRuntimeConfig;
	reservation: { state: string; reason?: string };
	/** How the fake control plane answers a release: confirmed, an unconfirmed shape, or an HTTP error. */
	release: "released" | "unconfirmed" | "error";
	identityState: SharedExecutionIdentityState;
	/** Whether the identity's login is kept by the vault (Stateless Compute step 1). */
	loginInVault: boolean;
	provisioned: number;
	activations: Map<string, string>;
	clock: { now: number };
	/** Runner ids the control plane reports as ended; undefined: a database without the check. */
	endedRunners?: string[];
	/** F3 run boxes: how the next view opens are answered (then "ok"), the views opened and closed, and a gate the
	 * next open waits on. */
	viewAnswers: Array<"ok" | "run-unavailable" | "no-folder" | "not-yet">;
	views: Array<{ viewId: string; pass: string }>;
	closedViews: Array<{ viewId: string; pass: string }>;
	viewGate?: Promise<void>;
}

async function fixture(
	options: {
		slotCount?: number;
		epoch?: number;
		codingCommand?: { origin: string; token: string };
		mountInfoPath?: string;
		warmIdleMs?: number;
		runBox?: boolean;
	} = {},
): Promise<Fixture> {
	const stateRoot = join(await root(), "state");
	const runRoot = join(await root(), "run");
	const identityRoot = join(await root(), "identities");
	const masterKey = token();
	const keySha256 = sha256(Buffer.from(masterKey, "base64url"));
	const epoch = options.epoch ?? 1;
	const volume = join(identityRoot, computeIdentityId);
	await mkdir(volume, { recursive: true, mode: 0o700 });
	await writeFile(
		join(volume, "qorpera-compute-identity.json"),
		JSON.stringify({ schema: "qorpera.compute-identity-volume/v1", compute_identity_id: computeIdentityId }),
		{ mode: 0o600 },
	);
	await writeFile(join(volume, "qorpera-native-provider-master-key"), `${masterKey}\n`, { mode: 0o600 });
	if (epoch > 0) {
		await writeFile(
			join(volume, `qorpera-identity-recovery-${epoch}.json`),
			JSON.stringify({
				schema: "qorpera.compute-identity-recovery/v1",
				companyId,
				computeIdentityId,
				epoch,
				keySha256,
				recoveryId: "30000000-0000-4000-8000-000000000021",
				receiptId: "30000000-0000-4000-8000-000000000022",
				releaseSha256: "a".repeat(64),
			}),
			{ mode: 0o600 },
		);
	}
	const runtime: LxdNativeCompanyRuntimeConfig = {
		mode: "company-path-v1",
		codexPath: "/opt/qorpera-harnesses/native-company/codex",
		binarySha256: "b".repeat(64),
		objectGatewayUrl: "https://objects.example.test",
		objectGatewayToken: token(),
		secretBroker: {
			origin: "https://broker.example.test",
			runtimeToken: token(),
			caCertificate: secretBrokerCa,
			caSha256: sha256(secretBrokerCa),
		},
		network: "qorpera0",
		recoveryVolumePrefix: "phql-a1-recovery-",
		recoveryVolumeSize: "4GiB",
		...(options.codingCommand ? { codingCommand: options.codingCommand } : {}),
	};
	const state: Fixture = {
		backend: undefined as unknown as SharedExecutionProviderBackend,
		units: new FakeUnits(),
		rpc: [],
		deliveries: [],
		stateRoot,
		runRoot,
		identityRoot,
		masterKey,
		runtime,
		reservation: { state: "reserved" },
		release: "released",
		identityState: { companyId, computeIdentityId, epoch, blocked: false, keySha256, canInitialize: false },
		loginInVault: false,
		provisioned: 0,
		activations: new Map<string, string>(),
		clock: { now: Date.parse("2026-09-22T12:00:00Z") },
		viewAnswers: [],
		views: [],
		closedViews: [],
	};
	const config: SharedExecutionProviderConfig = {
		adapterId: "native26-test",
		hostId: "qorpera-exec-test",
		supabaseUrl: "https://project.supabase.test",
		supabaseServiceKey: "service-key",
		supabasePublishableKey: "publishable-key",
		stateRoot,
		runRoot,
		identityRoot,
		slotCount: options.slotCount ?? 4,
		portBase: 20_000,
		hostUnitPrefix: "qorpera-shared-run-host@",
		runnerUnitPrefix: "qorpera-shared-runner@",
		hostAccountPrefix: "qorpera-shared-host",
		runnerAccountPrefix: "qorpera-shared-runner",
		runnerImage: `localhost/qorpera/sandbox-probe:test@sha256:${"1".repeat(64)}`,
		runnerPodmanPath: "/usr/bin/podman",
		runnerEntrypoint: "/qorpera/bin/run-job",
		runnerVersion: "test",
		codexPath: "/opt/qorpera-harnesses/native-company/codex",
		claudePath: "/usr/local/bin/claude",
		nativeCompanyRuntime: runtime,
		startTimeoutMs: 5000,
		...(options.warmIdleMs === undefined ? {} : { warmIdleMs: options.warmIdleMs }),
		...(options.runBox
			? { runBox: { unitPrefix: "qorpera-shared-box@", folderUnitPrefix: "qorpera-shared-box-folder@" } }
			: {}),
	};
	const fakeFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname.startsWith("/rest/v1/rpc/")) {
			const name = url.pathname.slice("/rest/v1/rpc/".length);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			state.rpc.push({ name, body });
			if (name === "qorpera_compute_identity_login_in_vault") return Response.json(state.loginInVault);
			if (name === "qorpera_folder_view_open") {
				const gate = state.viewGate;
				state.viewGate = undefined;
				if (gate) await gate;
				const answer = state.viewAnswers.shift() ?? "ok";
				if (answer === "run-unavailable")
					return Response.json({ code: "42501", message: "Run is unavailable" }, { status: 403 });
				if (answer === "no-folder")
					return Response.json({ code: "42501", message: "Company folder is unavailable" }, { status: 403 });
				if (answer === "not-yet")
					return Response.json(
						{ code: "0A000", message: "Folder writes by this kind of run are not available yet" },
						{ status: 501 },
					);
				const view = { viewId: crypto.randomUUID(), pass: token() };
				state.views.push(view);
				return Response.json({ schema: "qorpera.folder-view/v1", ...view, leaseUntil: "2099-01-01T00:00:00Z" });
			}
			if (name === "qorpera_folder_view_close") {
				state.closedViews.push({ viewId: String(body.p_view_id), pass: String(body.p_pass) });
				return Response.json(null);
			}
			if (name === "qorpera_runtime_ended_runners")
				return state.endedRunners === undefined
					? Response.json({ code: "PGRST202" }, { status: 404 })
					: Response.json((body.p_runner_ids as string[]).filter((id) => state.endedRunners?.includes(id)));
			if (name === "qorpera_provision_execution_runner") {
				// The control plane binds the client runner id to its first activation
				// secret: a second, different secret for the same id is refused.
				const bound = state.activations.get(String(body.p_client_runner_id));
				if (bound !== undefined && bound !== body.p_activation_token_sha256)
					return Response.json({ code: "23505", message: "runner activation is bound" }, { status: 409 });
				state.activations.set(String(body.p_client_runner_id), String(body.p_activation_token_sha256));
				state.provisioned++;
				return Response.json({
					runner_id: runnerId,
					runner_kind: "qorpera_computer",
					provider_adapter: "native26-test",
					status: "provisioned",
					compute_identity_id: computeIdentityId,
					logical_computer_id: null,
					worker_class: "managed_sandbox",
					template_key: "qorpera-member-linux",
					template_version: "v1",
					compute_policy_sha256: "f".repeat(64),
					capabilities: ["agent_turn"],
				});
			}
			if (name === "qorpera_reserve_runtime_machine") {
				if (state.reservation.state !== "reserved") return Response.json(state.reservation);
				return Response.json({
					state: "reserved",
					allocationId: body.p_allocation_id,
					instanceSha256: body.p_instance_sha256,
				});
			}
			if (name === "qorpera_release_runtime_machine") {
				if (state.release === "error") return new Response("no allocation", { status: 404 });
				if (state.release === "unconfirmed") return Response.json({ state: "refused" });
				return Response.json({
					state: "released",
					allocationId: body.p_allocation_id,
					instanceSha256: body.p_instance_sha256,
				});
			}
			return new Response("unknown rpc", { status: 404 });
		}
		if (url.hostname === "127.0.0.1") {
			const port = Number(url.port);
			const slot = Math.floor((port - 20_000) / 2);
			const unit =
				port % 2 === 0 ? `qorpera-shared-run-host@${slot}.service` : `qorpera-shared-runner@${slot}.service`;
			if (url.pathname === "/healthz")
				return state.units.activeUnits.has(unit) && !state.units.loading.has(unit)
					? Response.json({ ok: true })
					: new Response("", { status: 503 });
			if (url.pathname === "/v1/assignment" && init?.method === "POST") {
				const headers = new Headers(init.headers);
				state.deliveries.push({
					port,
					authorization: headers.get("authorization"),
					body: JSON.parse(String(init.body)),
				});
				return new Response("", { status: 202 });
			}
		}
		return new Response("not found", { status: 404 });
	};
	state.backend = new SharedExecutionProviderBackend(config, {
		fetch: fakeFetch as typeof fetch,
		units: state.units,
		identityAuthority: async () => state.identityState,
		account: async () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }),
		...(options.mountInfoPath
			? { requireIdentityMount: true, mountInfoPath: options.mountInfoPath }
			: { requireIdentityMount: false }),
		identityOwnerUid: process.getuid?.() ?? 0,
		now: () => state.clock.now,
	});
	return state;
}

function delivery(assignmentToken?: string): CloudRunnerAssignmentDelivery {
	return {
		assignment: {
			assignmentId: "30000000-0000-4000-8000-000000000031",
			claimId: "30000000-0000-4000-8000-000000000032",
			runId,
			jobId: "30000000-0000-4000-8000-000000000003",
			runnerId,
			capabilitySha256: "c".repeat(64),
			expiresAt: "2099-08-21T18:00:00.000Z",
		},
		capability: assignmentToken ?? token(),
		work: work(),
	};
}

/** The live journal, or the newest archived one once the sandbox is terminal. */
async function journal(f: Fixture, acquisitionId = runId): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(f.stateRoot, "journals", `${acquisitionId}.json`), "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const archive = join(f.stateRoot, "journals", "archive");
	const names = (await readdir(archive)).filter((name) => name.startsWith(`${acquisitionId}.`)).sort();
	const newest = names.at(-1);
	if (!newest) throw new Error(`no journal for ${acquisitionId}`);
	return JSON.parse(await readFile(join(archive, newest), "utf-8"));
}

async function liveJournalNames(f: Fixture): Promise<string[]> {
	try {
		return (await readdir(join(f.stateRoot, "journals"))).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

describe("shared execution provider backend", () => {
	it("hands the sandbox the coding command gateway when the host is configured for it", async () => {
		const gateway = { origin: "https://coding.example.test:8789", token: token() };
		const f = await fixture({ codingCommand: gateway });
		await f.backend.acquire(runId, work(), new AbortController().signal);
		const slotRun = join(f.runRoot, "slots", "0");
		expect(await readFile(join(slotRun, "credentials", "qorpera-coding-command"), "utf-8")).toBe(
			`${gateway.token}\n`,
		);
		expect((await stat(join(slotRun, "credentials", "qorpera-coding-command"))).mode & 0o077).toBe(0);
		const environment = await readFile(join(slotRun, "native-provider.env"), "utf-8");
		expect(environment).toContain(`QORPERA_CODING_COMMAND_URL=${gateway.origin}\n`);
		expect(environment).not.toContain(gateway.token);
	});

	it("starts a sandbox pair on a free slot, delivers the assignment, and retires the slot when the runner exits", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		const runner = await f.backend.acquire(runId, work(), signal);
		expect(runner).toMatchObject({ runnerId, providerAdapter: "native26-test", computeIdentityId });
		expect(f.rpc.map((call) => call.name)).toEqual([
			"qorpera_provision_execution_runner",
			"qorpera_reserve_runtime_machine",
			// The host's material asks whether the identity's login is in the vault.
			"qorpera_compute_identity_login_in_vault",
		]);
		expect(f.rpc[1]?.body).toMatchObject({
			p_allocation_id: runId,
			p_provider_adapter: "native26-test",
			p_run_id: runId,
			p_runner_id: runnerId,
		});
		expect(f.units.log).toEqual(["start qorpera-shared-run-host@0.service", "start qorpera-shared-runner@0.service"]);
		const slotRun = join(f.runRoot, "slots", "0");
		const credentials = await readdir(join(slotRun, "credentials"));
		expect(credentials.sort()).toEqual([
			"qorpera-cloud-secret-ca",
			"qorpera-cloud-secret-runtime",
			"qorpera-coding-command",
			"qorpera-native-bridge",
			"qorpera-native-identity-epoch",
			"qorpera-native-object-token",
			"qorpera-native-provider-master-key",
			"qorpera-office-native",
			"qorpera-runner-activation",
			"qorpera-runner-assignment",
			"qorpera-supabase-service-key",
		]);
		for (const name of credentials) expect((await stat(join(slotRun, "credentials", name))).mode & 0o077).toBe(0);
		expect((await readFile(join(slotRun, "credentials", "qorpera-native-provider-master-key"), "utf-8")).trim()).toBe(
			f.masterKey,
		);
		expect(
			JSON.parse(await readFile(join(slotRun, "credentials", "qorpera-native-identity-epoch"), "utf-8")),
		).toEqual({
			computeIdentityId,
			companyId,
			epoch: 1,
			keySha256: sha256(Buffer.from(f.masterKey, "base64url")),
		});
		expect(await readFile(join(slotRun, "credentials", "qorpera-office-native"), "utf-8")).toBe("");
		expect(await readFile(join(slotRun, "credentials", "qorpera-coding-command"), "utf-8")).toBe("");
		const environment = await readFile(join(slotRun, "native-provider.env"), "utf-8");
		expect(environment).toContain("QORPERA_NATIVE_PROVIDER_PORT=20000\n");
		expect(environment).toContain(`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${computeIdentityId}\n`);
		expect(environment).toContain(
			`QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=${join(f.stateRoot, "slots", "0", "host")}\n`,
		);
		expect(environment).toContain("QORPERA_NATIVE_RUNTIME=company-path-v1\n");
		expect(environment).not.toContain("QORPERA_CODING_COMMAND_URL");
		expect(environment).not.toContain("TOKEN");
		const runnerConfigPath = join(f.stateRoot, "slots", "0", "runner", "config.json");
		expect((await stat(runnerConfigPath)).mode & 0o077).toBe(0);
		const runnerConfig = JSON.parse(await readFile(runnerConfigPath, "utf-8"));
		expect(runnerConfig).toMatchObject({
			schema: "qorpera.ephemeral-runner-service/v1",
			runner_id: runnerId,
			native_bridge_url: "http://127.0.0.1:20000/",
			native_bridge_boundary: "virtual_machine",
			assignment_host: "127.0.0.1",
			assignment_port: 20001,
			max_assignments: 1,
			environment: {},
			authority_state_path: join(f.stateRoot, "slots", "0", "runner", "state", "authority.json"),
			temporary_root: join(f.stateRoot, "slots", "0", "runner", "workspace"),
		});
		expect(await journal(f)).toMatchObject({
			physicalState: "registered",
			slot: 0,
			hostPort: 20000,
			inboxPort: 20001,
			capacityRegistered: true,
		});

		const assignmentToken = (
			await readFile(join(slotRun, "credentials", "qorpera-runner-assignment"), "utf-8")
		).trim();
		const capability = token();
		await f.backend.deliver(runner, delivery(capability));
		expect(f.deliveries).toEqual([
			{
				port: 20001,
				authorization: `Bearer ${assignmentToken}`,
				body: {
					schema: "qorpera.runner-assignment-delivery/v1",
					assignment_id: "30000000-0000-4000-8000-000000000031",
					job_id: "30000000-0000-4000-8000-000000000003",
					capability,
				},
			},
		]);
		expect(await journal(f)).toMatchObject({
			physicalState: "assigned",
			assignmentId: "30000000-0000-4000-8000-000000000031",
		});

		await f.backend.reconcile();
		expect(await journal(f)).toMatchObject({ physicalState: "assigned" });
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(0);

		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", stopReason: "idle", capacityReleased: true });
		expect(f.units.log.slice(2)).toEqual([
			"stop qorpera-shared-runner@0.service",
			"stop qorpera-shared-run-host@0.service",
		]);
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
		await expect(stat(slotRun)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(join(f.stateRoot, "slots", "0", "host"))).toEqual([]);
		await f.backend.reconcile();
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
		expect(await liveJournalNames(f)).toEqual([]);
	});

	it("replays an acquisition without provisioning again and refuses foreign work on the same id", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		const first = await f.backend.acquire(runId, work(), signal);
		const second = await f.backend.acquire(runId, work(), signal);
		expect(second).toEqual(first);
		expect(f.provisioned).toBe(1);
		expect(f.units.log).toHaveLength(2);
		await expect(
			f.backend.acquire(runId, work({ jobId: "30000000-0000-4000-8000-000000000099" }), signal),
		).rejects.toThrow("bound to another immutable work request");
	});

	it("defers a run when every slot is busy and reuses a retired slot with fresh credentials", async () => {
		const f = await fixture({ slotCount: 1 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		const firstAssignment = await readFile(
			join(f.runRoot, "slots", "0", "credentials", "qorpera-runner-assignment"),
			"utf-8",
		);
		const otherRun = "30000000-0000-4000-8000-000000000041";
		const error = await f.backend
			.acquire(otherRun, work({ runId: otherRun, sourceId: otherRun }), signal)
			.catch((value) => value);
		expect(error).toBeInstanceOf(SharedExecutionAdmissionRefused);
		expect(error).toMatchObject({
			category: "admission_refused",
			state: "deferred",
			reason: "SANDBOX_CAPACITY_EXHAUSTED",
		});
		expect(f.provisioned).toBe(1);
		await f.backend.stop({ ...(await f.backend.acquire(runId, work(), signal)) }, "revoked");
		expect(await journal(f)).toMatchObject({
			physicalState: "stopped",
			stopReason: "revoked",
			capacityReleased: true,
		});
		await f.backend.acquire(otherRun, work({ runId: otherRun, sourceId: otherRun }), signal);
		expect(await journal(f, otherRun)).toMatchObject({ physicalState: "registered", slot: 0 });
		const secondAssignment = await readFile(
			join(f.runRoot, "slots", "0", "credentials", "qorpera-runner-assignment"),
			"utf-8",
		);
		expect(secondAssignment).not.toBe(firstAssignment);
	});

	it("surfaces a company ceiling refusal as an admission refusal without starting units", async () => {
		const f = await fixture();
		f.reservation = { state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" };
		const error = await f.backend.acquire(runId, work(), new AbortController().signal).catch((value) => value);
		expect(error).toMatchObject({
			category: "admission_refused",
			state: "refused",
			reason: "MACHINE_CAPACITY_EXHAUSTED",
		});
		expect(f.units.log.filter((entry) => entry.startsWith("start "))).toEqual([]);
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", stopReason: "delivery_failed" });
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(0);
	});

	it("refuses an identity whose key or recovery generation differs from cloud authority and releases the reservation", async () => {
		const f = await fixture();
		f.identityState = { ...f.identityState, keySha256: "d".repeat(64) };
		await expect(f.backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow(
			"Local identity key differs from cloud recovery history",
		);
		expect(f.units.log.filter((entry) => entry.startsWith("start "))).toEqual([]);
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", capacityReleased: true });
		await expect(stat(join(f.runRoot, "slots", "0"))).rejects.toMatchObject({ code: "ENOENT" });

		const g = await fixture({ epoch: 2 });
		await rm(join(g.identityRoot, computeIdentityId, "qorpera-identity-recovery-2.json"));
		await expect(g.backend.acquire(runId, work(), new AbortController().signal)).rejects.toThrow();
		expect(g.units.log.filter((entry) => entry.startsWith("start "))).toEqual([]);
	});

	it("keeps concurrent runs on distinct slots and ports and derives a new acquisition for a later attempt", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		const otherRun = "30000000-0000-4000-8000-000000000051";
		await f.backend.acquire(runId, work(), signal);
		const firstMachine = ((await journal(f, runId)) as { instanceSha256: string }).instanceSha256;
		await f.backend.acquire(otherRun, work({ runId: otherRun, sourceId: otherRun }), signal);
		expect(await journal(f, otherRun)).toMatchObject({ slot: 1, hostPort: 20002, inboxPort: 20003 });
		expect(f.units.activeUnits).toEqual(
			new Set([
				"qorpera-shared-run-host@0.service",
				"qorpera-shared-runner@0.service",
				"qorpera-shared-run-host@1.service",
				"qorpera-shared-runner@1.service",
			]),
		);
		const retry = sharedExecutionAcquisitionId(runId, 2);
		expect(retry).not.toBe(runId);
		const retiring = await f.backend.acquire(runId, work({ attempt: 2 }), signal).catch((value) => value);
		expect(retiring).toBeInstanceOf(ProviderAdmissionRefused);
		expect(retiring).toMatchObject({ state: "deferred", reason: "SANDBOX_RETIRING" });
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		await f.backend.acquire(runId, work({ attempt: 2 }), signal);
		expect(await journal(f, retry)).toMatchObject({ physicalState: "registered", attempt: 2, slot: 0 });
		// Same slot, new attempt: its own machine key (the first attempt's stays taken by its allocation).
		expect(((await journal(f, retry)) as { instanceSha256: string }).instanceSha256).not.toBe(firstMachine);
	});

	it("refuses work outside the governed native runtime", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		const review = await f.backend
			.acquire(runId, work({ jobType: "proposal_review" }), signal)
			.catch((value) => value);
		expect(review).toBeInstanceOf(ProviderAdmissionRefused);
		expect(review).toMatchObject({ category: "admission_refused", state: "deferred", reason: "NODE_NOT_PREFERRED" });
		const harness = await f.backend
			.acquire(runId, work({ sponsor: { ...work().sponsor, nativeHarness: "claude-code" } }), signal)
			.catch((value) => value);
		expect(harness).toMatchObject({ category: "admission_refused", state: "deferred", reason: "NODE_NOT_PREFERRED" });
		expect(f.provisioned).toBe(0);
		expect(await liveJournalNames(f)).toEqual([]);
	});

	it("fails a same-attempt retry fast after its sandbox was retired, without a sandbox or a reservation", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		expect(await journal(f)).toMatchObject({ physicalState: "stopped" });
		await expect(f.backend.acquire(runId, work(), signal)).rejects.toThrow(
			"cannot be replayed after its sandbox retired",
		);
		expect(f.provisioned).toBe(1);
		expect(await liveJournalNames(f)).toEqual([]);
		expect(f.rpc.filter((call) => call.name === "qorpera_reserve_runtime_machine")).toHaveLength(1);
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
		expect(f.units.log.filter((entry) => entry.startsWith("start"))).toHaveLength(2);
	});

	it("defers a retry while the same acquisition is still retiring", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.units.stuck.add("qorpera-shared-run-host@0.service");
		f.units.unkillable.add("qorpera-shared-run-host@0.service");
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await expect(f.backend.reconcile()).rejects.toThrow("quarantined");
		expect(f.units.log).toContain("kill qorpera-shared-run-host@0.service");
		expect(await journal(f)).toMatchObject({ physicalState: "stopping", retireAttempts: 1 });
		const retry = await f.backend.acquire(runId, work(), signal).catch((value) => value);
		expect(retry).toMatchObject({ category: "admission_refused", state: "deferred", reason: "SANDBOX_RETIRING" });
		expect(f.provisioned).toBe(1);
	});

	it("defers a run whose identity volume is not attached yet, before any runner row or unit", async () => {
		const mountInfo = join(await root(), "mountinfo");
		await writeFile(mountInfo, "22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n");
		const f = await fixture({ mountInfoPath: mountInfo });
		const refused = await f.backend.acquire(runId, work(), new AbortController().signal).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(ProviderAdmissionRefused);
		expect(refused).toMatchObject({ reason: "NODE_IDENTITY_ELSEWHERE" });
		// Only the question whether the login is kept by the vault (it is not) comes before.
		expect(f.rpc.map((call) => call.name)).toEqual(["qorpera_compute_identity_login_in_vault"]);
		expect(f.units.log).toEqual([]);
		// The wait is bounded: after two minutes the start fails like any other, visibly.
		f.clock.now += 60_000;
		await expect(f.backend.acquire(runId, work(), new AbortController().signal)).rejects.toBeInstanceOf(
			ProviderAdmissionRefused,
		);
		f.clock.now += 60_000;
		const expired = await f.backend.acquire(runId, work(), new AbortController().signal).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(expired).toBeInstanceOf(Error);
		expect(expired).not.toBeInstanceOf(ProviderAdmissionRefused);
		expect(String(expired)).toContain("not attached to this execution host in time");
		expect(f.rpc.every((call) => call.name === "qorpera_compute_identity_login_in_vault")).toBe(true);
		const volume = join(f.identityRoot, computeIdentityId).replaceAll(" ", "\\040");
		await writeFile(mountInfo, `22 1 0:21 / / rw - ext4 /dev/sda1 rw\n90 22 0:50 / ${volume} rw - virtiofs id rw\n`);
		await expect(f.backend.acquire(runId, work(), new AbortController().signal)).resolves.toMatchObject({ runnerId });
	});

	it("starts the runner while the host is still loading and returns only once both answer", async () => {
		const f = await fixture();
		f.units.loading.add("qorpera-shared-run-host@0.service");
		let acquired = false;
		const acquisition = f.backend.acquire(runId, work(), new AbortController().signal).then((runner) => {
			acquired = true;
			return runner;
		});
		while (!f.units.log.includes("start qorpera-shared-runner@0.service")) await delay(5);
		await delay(60);
		expect(acquired).toBe(false);
		expect(f.deliveries).toHaveLength(0);
		f.units.loading.delete("qorpera-shared-run-host@0.service");
		await expect(acquisition).resolves.toMatchObject({ runnerId });
	});

	it("restarts the units when a journal left in 'starting' is replayed after a restart", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		// Simulate a process death after the journal was written but before the units came up.
		const path = join(f.stateRoot, "journals", `${runId}.json`);
		const current = JSON.parse(await readFile(path, "utf-8"));
		await writeFile(path, JSON.stringify({ ...current, physicalState: "starting" }));
		f.units.activeUnits.clear();
		f.units.log.length = 0;
		await f.backend.acquire(runId, work(), signal);
		expect(f.units.log).toEqual(["start qorpera-shared-run-host@0.service", "start qorpera-shared-runner@0.service"]);
		expect(await journal(f)).toMatchObject({ physicalState: "registered" });
		expect(f.provisioned).toBe(1);
	});

	it("retires a sandbox stuck in 'reserving' after ten minutes and still releases a reservation whose reply was lost", async () => {
		const f = await fixture();
		const path = join(f.stateRoot, "journals", `${runId}.json`);
		await mkdir(join(f.stateRoot, "journals"), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				schema: "qorpera.shared-execution-journal/v1",
				acquisitionId: runId,
				runId,
				attempt: 1,
				workSha256: "a".repeat(64),
				jobType: "agent_turn",
				profileId: companyId,
				computeIdentityId,
				slot: 2,
				hostPort: 20004,
				inboxPort: 20005,
				instanceSha256: "b".repeat(64),
				runner: {
					runnerId,
					workerClass: "managed_sandbox",
					providerAdapter: "native26-test",
					capabilities: ["agent_turn"],
					templateKey: "qorpera-member-linux",
					templateVersion: "v1",
					policySha256: "f".repeat(64),
					computeIdentityId,
				},
				physicalState: "reserving",
				credentials: {
					activationSha256: "c".repeat(64),
					assignmentSha256: "d".repeat(64),
					nativeBridgeSha256: "e".repeat(64),
				},
				capacityRequested: true,
				createdAt: new Date(f.clock.now).toISOString(),
				updatedAt: new Date(f.clock.now).toISOString(),
			}),
		);
		await f.backend.reconcile();
		expect(await journal(f)).toMatchObject({ physicalState: "reserving" });
		f.clock.now += 11 * 60_000;
		f.release = "error";
		await f.backend.reconcile();
		expect(await journal(f)).toMatchObject({
			physicalState: "stopped",
			stopReason: "delivery_failed",
			capacityReleased: true,
		});
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
		expect(await liveJournalNames(f)).toEqual([]);
	});

	it("retires a sandbox whose runner still waits two minutes after its job ended", async () => {
		// 29 Sep 2026 (company deletion): an unknown assign or delivery keeps the runner up for a
		// replay, but an ended job is never replayed; the runner waited on its inbox forever.
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.endedRunners = [];
		const asked = () => f.rpc.filter((call) => call.name === "qorpera_runtime_ended_runners");
		await f.backend.reconcile(signal);
		expect(asked()).toHaveLength(0);
		// Waiting two minutes, its job going on: asked, and the sandbox stays; asked again only a minute later.
		f.clock.now += 2 * 60_000 + 1_000;
		await f.backend.reconcile(signal);
		await f.backend.reconcile(signal);
		expect(asked().map((call) => call.body)).toEqual([{ p_runner_ids: [runnerId] }]);
		expect(await journal(f)).toMatchObject({ physicalState: "registered" });
		// Its job ended: the next check retires the sandbox and releases its allocation.
		f.endedRunners = [runnerId];
		f.clock.now += 60_000;
		await f.backend.reconcile(signal);
		expect(await journal(f)).toMatchObject({ physicalState: "stopped" });
		expect(f.units.log).toContain("stop qorpera-shared-runner@0.service");
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
	});

	it("keeps waiting sandboxes when the database has no ended-runner check yet", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.clock.now += 10 * 60_000;
		await f.backend.reconcile(signal);
		expect(f.rpc.filter((call) => call.name === "qorpera_runtime_ended_runners")).toHaveLength(1);
		expect(await journal(f)).toMatchObject({ physicalState: "registered" });
	});

	it("gives a sandbox up as lost after repeated unconfirmed releases, keeping the reason in the archive", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		f.release = "unconfirmed";
		for (let attempt = 1; attempt < 12; attempt++) {
			await expect(f.backend.reconcile()).rejects.toThrow("release was not confirmed");
			expect(await journal(f)).toMatchObject({ physicalState: "stopping", retireAttempts: attempt });
		}
		await f.backend.reconcile();
		const lost = await journal(f);
		expect(lost).toMatchObject({ physicalState: "lost", retireAttempts: 12 });
		expect(String(lost.stopReason)).toContain("release was not confirmed");
		expect(lost).toMatchObject({ capacityRegistered: true });
		expect(lost.capacityReleased).not.toBe(true);
		expect(await liveJournalNames(f)).toEqual([]);
		// The slot is clean and returns to service; the allocation stays owed until confirmed.
		f.release = "released";
		const releasesBefore = f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine").length;
		await f.backend.reconcile();
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(releasesBefore + 1);
		expect(await journal(f)).toMatchObject({ physicalState: "lost", capacityReleased: true });
		const otherRun = "30000000-0000-4000-8000-000000000042";
		await f.backend.acquire(otherRun, work({ runId: otherRun, sourceId: otherRun }), signal);
		expect(await journal(f, otherRun)).toMatchObject({ physicalState: "registered", slot: 0 });
	});

	it("kills a unit that ignores stop and quarantines the slot while anything still runs in it", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.units.stuck.add("qorpera-shared-run-host@0.service");
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		expect(f.units.log).toContain("kill qorpera-shared-run-host@0.service");
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", capacityReleased: true });
	});

	it("reads unit states strictly", () => {
		expect(parseUnitStates(["a", "b", "c"], "active\ninactive\nactivating\n")).toEqual(new Set(["a", "c"]));
		expect(parseUnitStates(["a", "b"], "reloading\nfailed\n")).toEqual(new Set(["a"]));
		expect(() => parseUnitStates(["a", "b"], "active\n")).toThrow("Unit state is unavailable");
		expect(() => parseUnitStates(["a"], "")).toThrow("Unit state is unavailable");
	});

	it("moves a terminal journal left in the live directory into the archive", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		const archived = await journal(f);
		// An older service wrote terminal journals in place; simulate one.
		await writeFile(join(f.stateRoot, "journals", `${runId}.json`), JSON.stringify(archived));
		expect(await liveJournalNames(f)).toEqual([`${runId}.json`]);
		await f.backend.reconcile();
		expect(await liveJournalNames(f)).toEqual([]);
		expect(f.rpc.filter((call) => call.name === "qorpera_release_runtime_machine")).toHaveLength(1);
	});

	it("starts a vault login's sandbox without any volume, key or epoch file", async () => {
		const mountInfo = join(await root(), "mountinfo");
		await writeFile(mountInfo, "22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n");
		const f = await fixture({ mountInfoPath: mountInfo });
		f.loginInVault = true;
		await expect(f.backend.acquire(runId, work(), new AbortController().signal)).resolves.toMatchObject({ runnerId });
		const credentials = join(f.runRoot, "slots", "0", "credentials");
		expect(await readFile(join(credentials, "qorpera-native-provider-master-key"), "utf8")).toBe("");
		expect(await readFile(join(credentials, "qorpera-native-identity-epoch"), "utf8")).toBe("");
		expect(await readFile(join(f.runRoot, "slots", "0", "native-provider.env"), "utf8")).toContain(
			"QORPERA_NATIVE_LOGIN_CUSTODY=vault",
		);
	});

	it("does not hold the service lock while units are stopping", async () => {
		const f = await fixture();
		const signal = new AbortController().signal;
		const runner = await f.backend.acquire(runId, work(), signal);
		let releaseStop: () => void = () => undefined;
		const blocked = new Promise<void>((resolveStop) => {
			releaseStop = resolveStop;
		});
		const slowStop = f.units.stop.bind(f.units);
		f.units.stop = async (unit: string) => {
			await blocked;
			await slowStop(unit);
		};
		const stopping = f.backend.stop(runner, "revoked");
		await new Promise((resolveTick) => setTimeout(resolveTick, 20));
		const otherRun = "30000000-0000-4000-8000-000000000061";
		const started = await Promise.race([
			f.backend.acquire(otherRun, work({ runId: otherRun, sourceId: otherRun }), signal).then(() => "acquired"),
			new Promise<string>((resolveWait) => setTimeout(() => resolveWait("blocked"), 500)),
		]);
		expect(started).toBe("acquired");
		releaseStop();
		await stopping;
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", stopReason: "revoked" });
	});
});

describe("warm conversations", () => {
	const secondRun = "30000000-0000-4000-8000-000000000021";
	const hostUnit = (slot: number) => `qorpera-shared-run-host@${slot}.service`;
	const runnerUnit = (slot: number) => `qorpera-shared-runner@${slot}.service`;

	async function finishRun(f: Fixture, slot = 0): Promise<void> {
		f.units.activeUnits.delete(runnerUnit(slot));
		await f.backend.reconcile();
	}

	it("parks the host of an attended run and serves the conversation's next run with it", async () => {
		const f = await fixture({ warmIdleMs: 300_000 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		const environment = await readFile(join(f.runRoot, "slots", "0", "native-provider.env"), "utf-8");
		expect(environment).toContain("QORPERA_NATIVE_WARM_IDLE_MS=300000\n");
		const bridge = await readFile(join(f.runRoot, "slots", "0", "credentials", "qorpera-native-bridge"), "utf-8");
		// The host keeps its opened capsule in its own scratch between runs.
		const kept = join(f.stateRoot, "slots", "0", "host", "kept-capsule-root");
		await writeFile(kept, "kept");
		await finishRun(f);
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(true);
		expect(f.rpc.map((call) => call.name)).toContain("qorpera_release_runtime_machine");
		f.units.log.length = 0;
		await f.backend.acquire(secondRun, work({ runId: secondRun, sourceId: secondRun }), signal);
		// Only the new run's runner starts; the host, its bridge and its scratch are the parked ones.
		expect(f.units.log).toEqual([`start ${runnerUnit(0)}`]);
		expect(await readFile(join(f.runRoot, "slots", "0", "credentials", "qorpera-native-bridge"), "utf-8")).toBe(
			bridge,
		);
		expect(await readFile(kept, "utf-8")).toBe("kept");
	});

	it("never gives a parked host to another conversation, and parks nothing for unattended work", async () => {
		const f = await fixture({ warmIdleMs: 300_000 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		f.units.log.length = 0;
		await f.backend.acquire(
			secondRun,
			work({ runId: secondRun, sourceId: secondRun, sessionId: "30000000-0000-4000-8000-000000000022" }),
			signal,
		);
		expect(f.units.log).toEqual([`start ${hostUnit(1)}`, `start ${runnerUnit(1)}`]);
		const cold = await fixture({ warmIdleMs: 300_000 });
		await cold.backend.acquire(
			runId,
			work({ sourceKind: "wake", inputIds: [], sponsor: { ...work().sponsor, allowAutonomous: true } }),
			signal,
		);
		await finishRun(cold);
		expect(cold.units.activeUnits.has(hostUnit(0))).toBe(false);
	});

	it("ends a parked host when its window passes or the login changed", async () => {
		const f = await fixture({ warmIdleMs: 60_000 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		f.clock.now += 61_000;
		await f.backend.reconcile();
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(false);
		const changed = await fixture({ warmIdleMs: 300_000 });
		await changed.backend.acquire(runId, work(), signal);
		await finishRun(changed);
		// A recovery moved the login to a new epoch: the parked host holds the old one.
		changed.identityState = { ...changed.identityState, epoch: changed.identityState.epoch + 1 };
		changed.units.log.length = 0;
		await changed.backend
			.acquire(secondRun, work({ runId: secondRun, sourceId: secondRun }), signal)
			.catch(() => undefined);
		expect(changed.units.log[0]).toBe(`kill ${hostUnit(0)}`);
	});

	it("parks a vault login's host and reuses it only while the identity's login stays in the vault", async () => {
		const mountInfo = join(await root(), "mountinfo");
		await writeFile(mountInfo, "22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n");
		const f = await fixture({ warmIdleMs: 300_000, mountInfoPath: mountInfo });
		f.loginInVault = true;
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(true);
		f.units.log.length = 0;
		await f.backend.acquire(secondRun, work({ runId: secondRun, sourceId: secondRun }), signal);
		expect(f.units.log).toEqual([`start ${runnerUnit(0)}`]);
		expect(
			await readFile(join(f.runRoot, "slots", "0", "credentials", "qorpera-native-provider-master-key"), "utf8"),
		).toBe("");
		await finishRun(f);
		// The member signed in on a node again: the parked host holds no key and must not serve.
		f.loginInVault = false;
		await writeFile(
			mountInfo,
			`22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n23 22 0:30 / ${join(f.identityRoot, computeIdentityId)} rw - ext4 /dev/sdb rw\n`,
		);
		f.units.log.length = 0;
		const thirdRun = "30000000-0000-4000-8000-000000000023";
		await f.backend.acquire(thirdRun, work({ runId: thirdRun, sourceId: thirdRun }), signal).catch(() => undefined);
		expect(f.units.log[0]).toBe(`kill ${hostUnit(0)}`);
	});

	it("keeps a slot parked when its claim fails before the run's journal holds it", async () => {
		const f = await fixture({ warmIdleMs: 300_000 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		// The control plane refuses the second run's runner row (bound to another activation).
		f.activations.set(sharedExecutionAcquisitionId(secondRun, 1), "a".repeat(64));
		await expect(
			f.backend.acquire(secondRun, work({ runId: secondRun, sourceId: secondRun }), signal),
		).rejects.toThrow();
		expect(await readdir(join(f.stateRoot, "warm"))).toEqual(["0.json"]);
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(true);
		await f.backend.reconcile();
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(true);
	});

	it("ends a conversation's parked host when its next run differs, and stops orphaned hosts", async () => {
		const f = await fixture({ warmIdleMs: 300_000 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		f.units.log.length = 0;
		// Same conversation and login, new agent version: the parked host must not linger.
		await f.backend.acquire(secondRun, work({ runId: secondRun, sourceId: secondRun, staffVersion: 2 }), signal);
		expect(f.units.log.slice(0, 1)).toEqual([`kill ${hostUnit(0)}`]);
		// The new version's run took slot 0 again. Another agent of the same room on the
		// same login leaves that run's parked host alone.
		await finishRun(f, 0);
		expect(await readdir(join(f.stateRoot, "warm"))).toEqual(["0.json"]);
		f.units.log.length = 0;
		const thirdRun = "30000000-0000-4000-8000-000000000023";
		await f.backend.acquire(
			thirdRun,
			work({ runId: thirdRun, sourceId: thirdRun, staffAgentId: "30000000-0000-4000-8000-000000000024" }),
			signal,
		);
		expect(f.units.log.some((entry) => entry === `kill ${hostUnit(0)}`)).toBe(false);
		expect(f.units.activeUnits.has(hostUnit(0))).toBe(true);
		// A host no journal or warm record tracks (a crash between the two) is stopped.
		f.units.activeUnits.add(hostUnit(3));
		await f.backend.reconcile();
		expect(f.units.activeUnits.has(hostUnit(3))).toBe(false);
	});

	it("gives a parked host way when every slot is taken", async () => {
		const f = await fixture({ warmIdleMs: 300_000, slotCount: 1 });
		const signal = new AbortController().signal;
		await f.backend.acquire(runId, work(), signal);
		await finishRun(f);
		f.units.log.length = 0;
		await f.backend.acquire(
			secondRun,
			work({ runId: secondRun, sourceId: secondRun, sessionId: "30000000-0000-4000-8000-000000000022" }),
			signal,
		);
		expect(f.units.log).toEqual([`kill ${hostUnit(0)}`, `start ${hostUnit(0)}`, `start ${runnerUnit(0)}`]);
	});
});

describe("run boxes (F3)", () => {
	const box = (slot: number) => [
		`qorpera-shared-box@${slot}.service`,
		`qorpera-shared-box@${slot}.socket`,
		`qorpera-shared-box-folder@${slot}.service`,
	];

	async function until(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
		const started = Date.now();
		while (!(await check())) {
			if (Date.now() - started > 5_000) throw new Error(`timed out: ${label}`);
			await delay(10);
		}
	}

	async function boxState(f: Fixture): Promise<unknown> {
		return ((await journal(f)).box as { state?: string } | undefined)?.state;
	}

	async function deliverRun(f: Fixture): Promise<void> {
		const signal = new AbortController().signal;
		const runner = await f.backend.acquire(runId, work(), signal);
		await f.backend.deliver(runner, delivery());
	}

	it("opens a folder-v2 run's view once the runner holds its job, starts its box, and stops both with the run", async () => {
		const f = await fixture({ runBox: true });
		f.viewAnswers.push("run-unavailable", "run-unavailable");
		await deliverRun(f);
		await until(async () => (await boxState(f)) === "open", "the box opens");
		const opens = f.rpc.filter((call) => call.name === "qorpera_folder_view_open");
		expect(opens).toHaveLength(3);
		expect(opens[2]?.body).toEqual({
			p_environment_id: work().environmentId,
			p_opener: {
				kind: "run",
				runId,
				jobId: "30000000-0000-4000-8000-000000000003",
				runnerId,
				assignmentId: "30000000-0000-4000-8000-000000000031",
			},
			p_kind: "run_box",
			p_anchor: {},
		});
		const [view] = f.views;
		const viewFile = join(f.runRoot, "slots", "0", "box-view.json");
		expect(JSON.parse(await readFile(viewFile, "utf-8"))).toEqual({
			environmentId: work().environmentId,
			viewId: view?.viewId,
			pass: view?.pass,
		});
		expect((await stat(viewFile)).mode & 0o077).toBe(0);
		// The journal names the view; its pass lives only in the view file.
		const recorded = await journal(f);
		expect(recorded.box).toMatchObject({ state: "open", viewId: view?.viewId });
		expect(JSON.stringify(recorded)).not.toContain(view?.pass as string);
		expect(f.units.log.at(-1)).toBe("start qorpera-shared-box@0.service");
		for (const unit of box(0)) f.units.activeUnits.add(unit);

		// The runner exits: the box stops first, then the run's units, then the view closes and its file goes.
		f.units.log.length = 0;
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		expect(f.units.log).toEqual([
			...box(0).map((unit) => `stop ${unit}`),
			"stop qorpera-shared-runner@0.service",
			"stop qorpera-shared-run-host@0.service",
		]);
		expect(f.closedViews).toEqual([view]);
		await expect(stat(viewFile)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await journal(f)).toMatchObject({ physicalState: "stopped", box: { state: "open" } });
	});

	it("gives no box to a company without a folder-v2 folder, to a run kind with no view, or when boxes are off", async () => {
		for (const answer of ["no-folder", "not-yet"] as const) {
			const f = await fixture({ runBox: true });
			f.viewAnswers.push(answer);
			await deliverRun(f);
			await until(async () => (await boxState(f)) === "none", "no box");
			expect(f.units.log.some((line) => line.includes("qorpera-shared-box"))).toBe(false);
			await expect(stat(join(f.runRoot, "slots", "0", "box-view.json"))).rejects.toMatchObject({ code: "ENOENT" });
			// The run's end stops nothing of a box that never ran.
			f.units.log.length = 0;
			f.units.activeUnits.delete("qorpera-shared-runner@0.service");
			await f.backend.reconcile();
			expect(f.units.log).toEqual([
				"stop qorpera-shared-runner@0.service",
				"stop qorpera-shared-run-host@0.service",
			]);
		}
		const off = await fixture();
		await deliverRun(off);
		await off.backend.reconcile();
		expect(off.rpc.some((call) => call.name.startsWith("qorpera_folder_view"))).toBe(false);
		expect((await journal(off)).box).toBeUndefined();
	});

	it("closes the view at once when the run ended while it opened, and never starts the box", async () => {
		const f = await fixture({ runBox: true });
		let release = (): void => undefined;
		f.viewGate = new Promise<void>((done) => {
			release = done;
		});
		const signal = new AbortController().signal;
		const runner = await f.backend.acquire(runId, work(), signal);
		await f.backend.deliver(runner, delivery());
		await until(() => f.rpc.some((call) => call.name === "qorpera_folder_view_open"), "the view is asked for");
		await f.backend.stop(runner, "revoked");
		expect(await journal(f)).toMatchObject({ physicalState: "stopped" });
		release();
		await until(() => f.closedViews.length === 1, "the view closes");
		expect(f.closedViews).toEqual(f.views);
		expect(f.units.log.some((line) => line.startsWith("start qorpera-shared-box"))).toBe(false);
		await expect(stat(join(f.runRoot, "slots", "0", "box-view.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("gives up on a view that stays refused, and stops a box no live run holds", async () => {
		const f = await fixture({ runBox: true });
		f.viewAnswers.push(...Array.from({ length: 1000 }, () => "run-unavailable" as const));
		await deliverRun(f);
		await until(() => f.rpc.filter((call) => call.name === "qorpera_folder_view_open").length >= 2, "retries");
		f.clock.now += 61_000;
		await until(async () => (await boxState(f)) === "failed", "the box gives up");
		expect(f.units.log.some((line) => line.startsWith("start qorpera-shared-box"))).toBe(false);

		// Slot 1 has no run, yet its box runs and its view file is there (a crash mid-retire).
		const orphanView = { viewId: "30000000-0000-4000-8000-000000000099", pass: token() };
		await mkdir(join(f.runRoot, "slots", "1"), { recursive: true, mode: 0o700 });
		await writeFile(
			join(f.runRoot, "slots", "1", "box-view.json"),
			JSON.stringify({ environmentId: work().environmentId, ...orphanView }),
			{ mode: 0o600 },
		);
		for (const unit of box(1)) f.units.activeUnits.add(unit);
		f.units.log.length = 0;
		await f.backend.reconcile();
		expect(f.units.log).toEqual(box(1).map((unit) => `stop ${unit}`));
		expect(f.closedViews).toEqual([orphanView]);
		await expect(stat(join(f.runRoot, "slots", "1", "box-view.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("stops the box when its run's native host parks", async () => {
		const f = await fixture({ runBox: true, warmIdleMs: 300_000 });
		await deliverRun(f);
		await until(async () => (await boxState(f)) === "open", "the box opens");
		for (const unit of box(0)) f.units.activeUnits.add(unit);
		f.units.log.length = 0;
		f.units.activeUnits.delete("qorpera-shared-runner@0.service");
		await f.backend.reconcile();
		expect(f.units.log).toEqual([...box(0).map((unit) => `stop ${unit}`), "stop qorpera-shared-runner@0.service"]);
		expect(f.units.activeUnits.has("qorpera-shared-run-host@0.service")).toBe(true);
		expect(f.closedViews).toEqual(f.views);
		await expect(stat(join(f.runRoot, "slots", "0", "box-view.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
