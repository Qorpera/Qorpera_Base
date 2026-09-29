import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdCreateStorageVolumeRequest,
	LxdInstanceDeviceUpdateClient,
	LxdInstancePowerAction,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdOperationReference,
	LxdOperationState,
	LxdStorageVolumeRecord,
	LxdTrackedInstanceAction,
} from "../src/lxd-client.ts";
import { LxdExecutionHostIdentities } from "../src/lxd-execution-host-identity.ts";
import {
	HttpLxdNativeLoginGateway,
	LxdNativeLoginGateway,
	type LxdNativeLoginGatewayConfig,
} from "../src/lxd-login-gateway.ts";
import { LxdLoginJournal } from "../src/lxd-login-journal.ts";
import { readRuntimeNodeHost } from "../src/runtime-node-host.ts";

vi.mock("../src/runtime-node-host.ts", () => ({
	readRuntimeNodeHost: vi.fn(async () => ({
		machineIdSha256: "d".repeat(64),
		cpuMillis: 16000,
		memoryBytes: 64 * 1024 ** 3,
	})),
}));

const roots: string[] = [];
const loginId = "30000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000002";
const clientConnectionId = "30000000-0000-4000-8000-000000000003";
const computeIdentityId = "30000000-0000-4000-8000-000000000004";
const ownerUserId = "30000000-0000-4000-8000-000000000005";
const capability = "f".repeat(43);
const expiresAt = "2099-08-23T12:00:00.000Z";
const identityRecoveryCa = readFileSync(
	new URL("../../../deploy/cloud-secret-broker/supabase-prod-ca-2021.crt", import.meta.url),
	"utf-8",
);
const identityRecoveryCaSha256 = createHash("sha256").update(identityRecoveryCa).digest("hex");

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stateRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "qorpera-lxd-login-gateway-")));
	roots.push(root);
	return root;
}

class FakeLxd implements LxdClient {
	instance?: LxdInstanceRecord;
	volume?: LxdStorageVolumeRecord;
	createCalls: LxdCreateInstanceRequest[] = [];
	createVolumeCalls: LxdCreateStorageVolumeRequest[] = [];
	powerCalls: LxdInstancePowerAction[] = [];
	filePushes: Array<{ path: string; content: string; mode: number }> = [];
	execCalls: string[][] = [];
	deleteCalls = 0;
	lostSubmission?: LxdTrackedInstanceAction["action"];
	lostPolls = 0;
	restoreFailures = 0;
	pending = false;
	onSubmit?: (action: LxdTrackedInstanceAction) => void;

	async getInstance(_project: string, name: string): Promise<LxdInstanceRecord | undefined> {
		return this.instance?.name === name ? structuredClone(this.instance) : undefined;
	}
	async submitInstanceOperation(
		project: string,
		action: LxdTrackedInstanceAction,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		signal.throwIfAborted();
		if (action.action === "create") await this.createInstance(project, action.request);
		else if (action.action === "delete") await this.deleteInstance(project, action.name);
		else await this.setInstancePower(project, action.name, action.action);
		this.onSubmit?.(action);
		if (this.lostSubmission === action.action) throw new Error("lost accepted submission reply");
		return {
			project,
			instanceName: action.action === "create" ? action.request.name : action.name,
			operationId: randomUUID(),
		};
	}
	async inspectInstanceOperation(_reference: LxdOperationReference, signal: AbortSignal): Promise<LxdOperationState> {
		signal.throwIfAborted();
		if (this.lostPolls > 0) {
			this.lostPolls--;
			throw new Error("lost poll");
		}
		return this.pending ? "pending" : "succeeded";
	}

	async getInstanceState(): Promise<LxdInstanceStateRecord> {
		return {
			status: this.instance?.status ?? "Stopped",
			statusCode: this.instance?.statusCode ?? 102,
			network: {
				enp5s0: {
					hwaddr: "00:16:3e:b9:c4:8c",
					addresses: [{ family: "inet", address: "10.41.0.9", scope: "global" }],
				},
			},
		};
	}

	async getStorageVolume(): Promise<LxdStorageVolumeRecord | undefined> {
		return this.volume ? structuredClone(this.volume) : undefined;
	}

	volumeDeletes: string[] = [];
	async deleteStorageVolume(_project: string, _pool: string, name: string): Promise<boolean> {
		this.volumeDeletes.push(name);
		if (this.volume?.name !== name) return false;
		this.volume = undefined;
		return true;
	}

	async createStorageVolume(_project: string, _pool: string, request: LxdCreateStorageVolumeRequest): Promise<void> {
		this.createVolumeCalls.push(structuredClone(request));
		this.volume = {
			name: request.name,
			type: "custom",
			contentType: "filesystem",
			description: request.description,
			config: structuredClone(request.config),
		};
	}

	async createInstance(_project: string, request: LxdCreateInstanceRequest): Promise<void> {
		this.createCalls.push(structuredClone(request));
		this.instance = {
			name: request.name,
			type: "virtual-machine",
			status: "Stopped",
			statusCode: 102,
			config: { ...request.config, "volatile.eth0.hwaddr": "00:16:3e:b9:c4:8c" },
			profiles: [...request.profiles],
			devices: structuredClone(request.devices),
			expandedDevices: { ...request.devices, eth0: { type: "nic", name: "eth0", network: "qorpera0" } },
			expandedConfig: structuredClone(request.config),
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
		this.guestFiles.set(path, content);
	}

	guestFiles = new Map<string, string>();
	async execInstance(_project: string, _name: string, command: readonly string[]): Promise<void> {
		if (this.instance?.status !== "Running") throw new Error("fake VM agent is unavailable");
		this.execCalls.push([...command]);
		if (command[0] === "/usr/bin/test" && command[1] === "-f" && !this.guestFiles.has(command[2]!))
			throw new Error("LXD instance command failed");
		const script = command[0] === "/bin/bash" && command[1] === "-c" ? command[2]! : "";
		if (script.includes("generateKeyPairSync"))
			this.guestFiles.set("/var/lib/qorpera-recovery/recipient-public-key", `${"M".repeat(560)}\n`);
		if (script.includes("qorpera-identity-recovery-restore.mjs")) {
			if (this.restoreFailures-- > 0) throw new Error("restore quiet period has not elapsed");
			this.guestFiles.set(
				"/var/lib/qorpera-recovery/restore-result.json",
				`${JSON.stringify({ status: "completed", receiptId: "30000000-0000-4000-8000-000000000099", epoch: 2 })}\n`,
			);
		}
		if (command[0] === "/bin/rm")
			for (const key of [...this.guestFiles.keys()]) if (key.startsWith(command[2]!)) this.guestFiles.delete(key);
	}
	async readInstanceFile(_project: string, _name: string, path: string, maximumBytes: number) {
		const content = this.guestFiles.get(path);
		if (content === undefined) throw new Error("LXD instance file is missing");
		return { content: Buffer.from(content).subarray(0, maximumBytes), uid: 0, gid: 0, mode: 0o600 };
	}

	async deleteInstance(_project: string, _name: string): Promise<void> {
		this.deleteCalls++;
		this.instance = undefined;
	}
}

function config(root: string): LxdNativeLoginGatewayConfig {
	return {
		adapterId: "lxd",
		supabaseUrl: "https://example.supabase.co",
		supabaseServiceKey: "sb_secret_private",
		stateRoot: root,
		project: "qorpera-runners",
		loginProfile: "qorpera-login-v1",
		networkInterface: "eth0",
		imageServer: "local",
		imageFingerprint: "a".repeat(64),
		storagePool: "qorpera-vm",
		identityVolumePrefix: "identity-",
		identityVolumeSize: "32GiB",
		rootDiskSize: "80GiB",
		cpuLimit: 4,
		memoryLimit: "8GiB",
		nativeBridgePort: 8083,
		guestTrustedSource: "10.41.0.1",
		identityRecoveryCaCertificate: identityRecoveryCa,
		identityRecoveryCaSha256,
		guestReadyTimeoutMs: 10_000,
		codexPath: "/usr/local/bin/codex",
		claudePath: "/usr/local/bin/claude",
	};
}

function loginBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: "qorpera.native-provider-login/v1",
		login_id: loginId,
		client_connection_id: clientConnectionId,
		compute_identity_id: computeIdentityId,
		compute_identity_ownership_kind: "member",
		compute_identity_owner_user_id: ownerUserId,
		compute_identity_owner_scope_key: null,
		provider: "openai",
		native_harness: "codex-cli",
		login_capability: capability,
		expires_at: expiresAt,
		...overrides,
	};
}

function loginRequest(body = loginBody(), bearerCapability = capability): Request {
	return new Request("http://127.0.0.1/login", {
		method: "POST",
		headers: {
			authorization: `Bearer ${bearerCapability}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function fetchBoundary(logins: NativeLoginResponse[], statuses: Array<"pending" | "completed"> = [], id = loginId) {
	const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
	const control = {
		companyRefusal: null as string | null,
		nodeRefusal: null as string | null,
		nodeSequence: [] as Array<string | null>,
		loseCompany: 0,
		releasing: 0,
		orphaned: false,
		loseNode: 0,
		loseRelease: 0,
		cleanupRequired: false,
		releasedAt: null as string | null,
		status: "pending" as "pending" | "completed" | "expired" | "cancelled",
		committed: false,
		recovery: "new" as "new" | "established" | "blocked",
		recoveryEpochKnown: true,
		recoveryApproval: "approved" as string,
		recoveryRequests: [] as Record<string, unknown>[],
		targetRegistrations: [] as Record<string, unknown>[],
		repins: [] as Record<string, unknown>[],
		/** A deleted company's identities this node is to retire (D4), and the confirmations it sent. */
		retirementsDue: [] as unknown[],
		retirementsDueAnswer: undefined as unknown,
		retirements: [] as Record<string, unknown>[],
		retirementReceipts: new Map<string, Record<string, unknown>>(),
		loseRetirement: 0,
	};
	const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
		const originalUrl = String(input);
		const url = originalUrl.replaceAll("account_refresh", "login");
		const authorization = new Headers(init?.headers).get("authorization");
		const body = String(init?.body ?? "");
		requests.push({ url: originalUrl, authorization, body });
		const args = body ? JSON.parse(body) : {};
		if (args.p_request_id) args.p_login_id = args.p_request_id;
		if (originalUrl.endsWith("qorpera_describe_native_account_refresh_route"))
			return Response.json({
				request_id: id,
				profile_id: profileId,
				compute_identity_id: computeIdentityId,
				requested_by_user_id: ownerUserId,
				expires_at: expiresAt,
				status: control.status,
			});
		if (url.endsWith("/account-refresh")) {
			control.status = "completed";
			return Response.json({
				schema: "qorpera.native-account-refresh-result/v1",
				request_id: id,
				status: "completed",
			});
		}
		if (url.includes("qorpera_describe_native_provider_login")) {
			control.status = statuses.shift() ?? control.status;
			return Response.json({
				login_id: id,
				profile_id: profileId,
				client_connection_id: clientConnectionId,
				compute_identity_id: computeIdentityId,
				compute_identity_ownership_kind: "member",
				compute_identity_owner_user_id: ownerUserId,
				compute_identity_owner_scope_key: null,
				provider: "openai",
				native_harness: "codex-cli",
				expires_at: expiresAt,
				status: control.status,
			});
		}
		if (url.endsWith("qorpera_reserve_runtime_login_machine")) {
			control.committed = true;
			if (control.loseCompany-- > 0) throw new Error("lost company reply");
			if (control.releasing-- > 0) return Response.json({ state: "refused", reason: "COMPUTE_IDENTITY_RELEASING" });
			if (control.companyRefusal) return Response.json({ state: "refused", reason: control.companyRefusal });
			return Response.json({
				state: "reserved",
				allocationId: args.p_allocation_id,
				instanceSha256: args.p_instance_sha256,
			});
		}
		if (url.endsWith("qorpera_reserve_runtime_node_machine")) {
			if (control.loseNode-- > 0) throw new Error("lost node reply");
			const reason = control.nodeSequence.length ? control.nodeSequence.shift() : control.nodeRefusal;
			if (reason) return Response.json({ state: "refused", reason });
			return Response.json({
				state: "reserved",
				allocationId: args.p_allocation_id,
				instanceSha256: args.p_instance_sha256,
				nodeId: "30000000-0000-4000-8000-000000000010",
				nodeVersion: 1,
				cpuMillis: args.p_cpu_millis,
				memoryBytes: args.p_memory_bytes,
				validForMs: 5000,
			});
		}
		if (url.endsWith("qorpera_release_runtime_login_machine")) {
			control.releasedAt = "2026-09-08T00:00:00.000Z";
			if (control.loseRelease-- > 0) throw new Error("lost release reply");
			return Response.json({
				state: "released",
				allocationId: args.p_allocation_id,
				instanceSha256: args.p_instance_sha256,
			});
		}
		if (url.endsWith("qorpera_runtime_login_journal_orphaned")) return Response.json(control.orphaned);
		if (url.endsWith("qorpera_describe_runtime_login_machine")) {
			if (!control.committed) return Response.json({ error: "absent" }, { status: 403 });
			return Response.json({
				allocationId: args.p_allocation_id,
				loginId: id,
				profileId,
				computeIdentityId,
				expiresAt,
				status: control.status,
				cleanupRequired: control.cleanupRequired || control.status !== "pending" || control.releasedAt !== null,
				releasedAt: control.releasedAt,
			});
		}
		if (url.endsWith("qorpera_identity_recovery_runtime_state")) {
			return Response.json({
				companyId: profileId,
				computeIdentityId,
				epoch: control.recoveryEpochKnown ? (control.recovery === "established" ? 1 : 0) : undefined,
				blocked: control.recovery === "blocked",
				canInitialize: control.recovery === "new",
				recoveryConfiguration: {
					authorityId: "30000000-0000-4000-8000-000000000030",
					serviceOrigin: "https://recovery.example.test:10000",
					signingPublicKey: "S".repeat(60),
					wrappingPublicKey: "W".repeat(550),
				},
			});
		}
		if (url.endsWith("qorpera_request_login_identity_recovery")) {
			control.recoveryRequests.push(args);
			return Response.json({
				recoveryId: "30000000-0000-4000-8000-000000000098",
				companyId: profileId,
				computeIdentityId,
				targetId: args.p_target_id,
				backupRevision: 1,
				storageSource: "nas",
				status: control.recoveryApproval,
				epoch: 2,
				notBefore: new Date(Date.now() + 100).toISOString(),
				expiresAt,
				receiptId: null,
				loginId: id,
				requestedByUserId: ownerUserId,
				backupSha256: "b".repeat(64),
				authorityId: "30000000-0000-4000-8000-000000000030",
				serviceOrigin: "https://recovery.example.test:10000",
				signingPublicKey: "S".repeat(60),
			});
		}
		if (url.endsWith("qorpera_repin_login_recovery_epoch")) {
			control.repins.push(args);
			return Response.json({ loginId: args.p_login_id, epoch: 2, repinned: true });
		}
		if (url === "https://recovery.example.test:10000/v1/provider-target") {
			control.targetRegistrations.push(args);
			return Response.json({ targetId: args.targetId, computeIdentityId, registrarNodeId: args.registrarNodeId });
		}
		if (url.endsWith("qorpera_runtime_identity_retirements_due"))
			return Response.json(
				control.retirementsDueAnswer ?? {
					schema: "qorpera.identity-retirements-due/v1",
					nodeId: "30000000-0000-4000-8000-000000000010",
					computeIdentityIds: control.retirementsDue,
				},
			);
		if (url.endsWith("qorpera_confirm_runtime_identity_retirement")) {
			control.retirements.push(args);
			// The ledger keeps the first receipt; a replay answers it.
			const receipt = control.retirementReceipts.get(args.p_compute_identity_id) ?? {
				schema: "qorpera.identity-retirement/v1",
				nodeId: "30000000-0000-4000-8000-000000000010",
				computeIdentityId: args.p_compute_identity_id,
				volume: args.p_evidence.volume,
				device: args.p_evidence.device,
				retiredAt: "2026-09-29T10:00:00.000000+00:00",
			};
			control.retirementReceipts.set(args.p_compute_identity_id, receipt);
			if (control.loseRetirement-- > 0) throw new Error("lost retirement reply");
			return Response.json(receipt);
		}
		if (url.endsWith("/healthz")) return Response.json({ ok: true });
		if (url.endsWith("/login")) {
			const response = logins.shift();
			if (!response) throw new Error("unexpected login forwarding call");
			return Response.json({
				schema: "qorpera.native-provider-login-result/v1",
				login_id: id,
				status: response.status,
				interaction_url: response.interactionUrl,
				user_code: response.userCode,
			});
		}
		return Response.json({ error: "unexpected test URL" }, { status: 404 });
	}) as typeof fetch;
	return { fetchImplementation, requests, control };
}

interface NativeLoginResponse {
	status: "awaiting_member" | "completed";
	interactionUrl: string | null;
	userCode: string | null;
}

describe("LXD native login gateway", () => {
	it("hydrates accounts in a bounded identity guest without provider login or model work, then cleans it up", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-identity-recovery-1.json", "present");
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		const body = {
			schema: "qorpera.native-account-refresh/v1",
			request_id: loginId,
			compute_identity_id: computeIdentityId,
			requested_by_user_id: ownerUserId,
			expires_at: expiresAt,
			refresh_capability: capability,
		};
		const request = () =>
			new Request("http://127.0.0.1/account-refresh", {
				method: "POST",
				headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const response = await gateway.handle(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schema: "qorpera.native-account-refresh-result/v1",
			request_id: loginId,
			status: "completed",
		});
		expect(lxd.createCalls[0]?.name).toMatch(/^qorpera-refresh-/);
		expect(lxd.createCalls[0]?.config["user.qorpera.purpose"]).toBe("account_refresh");
		expect(lxd.powerCalls).toEqual(["start", "stop"]);
		expect(lxd.deleteCalls).toBe(1);
		expect(boundary.control.releasedAt).not.toBeNull();
		expect(
			boundary.requests.some(
				(r) =>
					r.url.endsWith("/login") ||
					r.url.endsWith("/execute") ||
					r.url.includes("runtime_login") ||
					r.url.includes("provider_login"),
			),
		).toBe(false);
		expect(boundary.requests.filter((r) => r.url.endsWith("/account-refresh"))).toHaveLength(1);
		expect((await gateway.handle(request())).status).toBe(200);
		expect(lxd.createCalls).toHaveLength(1);
	});
	it("rejects a refresh identity mismatch before machine allocation", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		const response = await gateway.handle(
			new Request("http://127.0.0.1/account-refresh", {
				method: "POST",
				headers: { authorization: `Bearer ${capability}` },
				body: JSON.stringify({
					schema: "qorpera.native-account-refresh/v1",
					request_id: loginId,
					compute_identity_id: randomUUID(),
					requested_by_user_id: ownerUserId,
					expires_at: expiresAt,
					refresh_capability: capability,
				}),
			}),
		);
		expect(response.status).toBe(403);
		expect(lxd.createCalls).toHaveLength(0);
	});
	it("answers `preparing` when a post outlasts its budget and hands the prompt to a later post of the same login", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "SLOW-CODE" },
			]);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const transport: typeof fetch = async (input, init) => {
			if (String(input) === "http://10.41.0.9:8083/login") {
				entered();
				await gate;
			}
			return boundary.fetchImplementation(input, init);
		};
		const gateway = new LxdNativeLoginGateway({ ...config(root), loginPreparingAfterMs: 200 }, lxd, transport);
		const first = await gateway.handle(loginRequest());
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			schema: "qorpera.native-provider-login-result/v1",
			login_id: loginId,
			status: "preparing",
			interaction_url: null,
			user_code: null,
		});
		// The work continued: one VM was created and started while the member was told to come back.
		await reached;
		expect(lxd.createCalls).toHaveLength(1);
		const pending = gateway.handle(loginRequest());
		await vi.waitFor(() =>
			expect(
				boundary.requests.filter((request) => request.url.endsWith("qorpera_describe_native_provider_login_route")),
			).toHaveLength(2),
		);
		release();
		const second = await pending;
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({ status: "awaiting_member", user_code: "SLOW-CODE" });
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.filePushes).toHaveLength(5);
		expect(boundary.requests.filter((request) => request.url.endsWith("/login"))).toHaveLength(1);
	});
	it("shares one pending route across authorized callers with independent response bodies", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "SHARED-CODE" },
			]);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const transport: typeof fetch = async (input, init) => {
			if (String(input) === "http://10.41.0.9:8083/login") {
				entered();
				await gate;
			}
			return boundary.fetchImplementation(input, init);
		};
		const gateway = new LxdNativeLoginGateway(config(root), lxd, transport);
		const first = gateway.handle(loginRequest());
		await reached;
		const rejected = await gateway.handle(loginRequest(loginBody({ client_connection_id: randomUUID() })));
		expect(rejected.status).toBe(403);
		const second = gateway.handle(loginRequest());
		await vi.waitFor(() =>
			expect(
				boundary.requests.filter((request) => request.url.endsWith("qorpera_describe_native_provider_login_route")),
			).toHaveLength(3),
		);
		release();
		const [left, right] = await Promise.all([first, second]);
		expect(left.status).toBe(200);
		expect(right.status).toBe(200);
		expect(left).not.toBe(right);
		left.headers.set("x-test-caller", "first");
		expect(right.headers.has("x-test-caller")).toBe(false);
		const bodies = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
		for (const body of bodies) {
			expect(JSON.parse(new TextDecoder().decode(body))).toMatchObject({
				status: "awaiting_member",
				user_code: "SHARED-CODE",
			});
		}
		expect(lxd.filePushes).toHaveLength(5);
		expect(boundary.requests.filter((request) => request.url.endsWith("/login"))).toHaveLength(1);
	});
	it("restores an established identity on a fresh volume before the bootstrap (2026-09-17 amendment)", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "ABCD-EFGH" },
			]);
		boundary.control.recovery = "established";
		const gateway = new LxdNativeLoginGateway(
			{
				...config(root),
				identityRecoveryRegistrarCapability: "r".repeat(43),
				guestManifestSha256: "m".repeat(64),
				recoveryWaitMs: 5000,
			},
			lxd,
			boundary.fetchImplementation,
		);
		const response = await gateway.handle(loginRequest());
		expect(response.status).toBe(200);
		expect(boundary.control.targetRegistrations).toHaveLength(1);
		const registration = boundary.control.targetRegistrations[0]!;
		expect(registration).toMatchObject({
			registrarNodeId: "30000000-0000-4000-8000-000000000010",
			nodeId: "30000000-0000-4000-8000-000000000010",
			registrarCapability: "r".repeat(43),
			computeIdentityId,
			imageSha256: "a".repeat(64),
			guestManifestSha256: "m".repeat(64),
			recipientPublicKey: "M".repeat(560),
		});
		expect(boundary.control.recoveryRequests).toEqual([
			expect.objectContaining({ p_login_id: loginId, p_target_id: registration.targetId, p_storage_source: "nas" }),
		]);
		const pushed = lxd.filePushes.map((file) => file.path);
		expect(pushed).toContain("/var/lib/qorpera-recovery/credentials/qorpera-recovery-target");
		// The capability file is the bare capability (the restore client refuses a trailing newline),
		// and the restore makes the identity mount private before the client runs.
		expect(lxd.filePushes.find((f) => f.path.endsWith("qorpera-recovery-target"))!.content).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
		expect(lxd.execCalls.some((c) => c.join(" ").includes("chmod 0700 /var/lib/qorpera/identity"))).toBe(true);
		expect(pushed).toContain("/var/lib/qorpera-recovery/credentials/qorpera-recovery-restore");
		const restore = JSON.parse(lxd.filePushes.find((f) => f.path.endsWith("qorpera-recovery-restore"))!.content);
		expect(restore).toMatchObject({
			schema: "qorpera.identity-recovery-restore/v1",
			companyId: profileId,
			computeIdentityId,
			recoveryId: "30000000-0000-4000-8000-000000000098",
			targetId: registration.targetId,
			epoch: 2,
			serviceOrigin: "https://recovery.example.test:10000",
		});
		// The restore ran before the bootstrap, and the recovery scratch was removed afterwards.
		const scripts = lxd.execCalls.map((c) => c.join(" "));
		const restoreIndex = scripts.findIndex((s) => s.includes("qorpera-identity-recovery-restore.mjs")),
			bootstrapIndex = scripts.findIndex((s) => s.includes("systemctl restart"));
		expect(restoreIndex).toBeGreaterThan(-1);
		expect(bootstrapIndex).toBeGreaterThan(restoreIndex);
		expect(scripts.some((s) => s.startsWith("/bin/rm -rf /var/lib/qorpera-recovery"))).toBe(true);
		// The login is re-pinned to the restored generation before its bootstrap runs.
		expect(boundary.control.repins).toEqual([{ p_login_id: loginId }]);
		expect(lxd.guestFiles.has("/var/lib/qorpera-recovery/recipient-public-key")).toBe(false);
	});
	it.each(["quiet-period", "interrupted-restore"] as const)(
		"keeps the same login preparing after an approved %s recovery, then resumes its retained restore",
		async (fault) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([
					{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "RESUMED" },
				]);
			boundary.control.recovery = "established";
			lxd.restoreFailures = fault === "interrupted-restore" ? 1 : 0;
			let approved = false;
			const transport: typeof fetch = async (input, init) => {
				if (String(input).endsWith("qorpera_identity_recovery_runtime_state") && approved) {
					return Response.json({ canInitialize: false, blocked: true, epoch: 2 });
				}
				const response = await boundary.fetchImplementation(input, init);
				if (String(input).endsWith("qorpera_request_login_identity_recovery")) approved = true;
				return response;
			};
			const gateway = new LxdNativeLoginGateway(
				{
					...config(root),
					identityRecoveryRegistrarCapability: "r".repeat(43),
					guestManifestSha256: "m".repeat(64),
					recoveryWaitMs: fault === "quiet-period" ? 0 : 5000,
				},
				lxd,
				transport,
			);
			const first = await gateway.handle(loginRequest());
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({
				schema: "qorpera.native-provider-login-result/v1",
				login_id: loginId,
				status: "preparing",
				interaction_url: null,
				user_code: null,
			});
			expect(lxd.execCalls.some((command) => command[0] === "/usr/bin/systemctl")).toBe(false);
			expect(boundary.requests.some((request) => request.url.endsWith("/login"))).toBe(false);
			expect(lxd.guestFiles.has("/var/lib/qorpera-recovery/credentials/qorpera-recovery-restore")).toBe(true);

			const second = await gateway.handle(loginRequest());
			expect(second.status).toBe(200);
			expect(await second.json()).toMatchObject({ status: "awaiting_member", user_code: "RESUMED" });
			expect(lxd.createCalls).toHaveLength(1);
			expect(lxd.powerCalls).toEqual(["start"]);
			expect(boundary.control.targetRegistrations).toHaveLength(1);
			expect(boundary.control.recoveryRequests).toHaveLength(1);
			expect(boundary.control.repins).toEqual([{ p_login_id: loginId }]);
			expect(boundary.requests.filter((request) => request.url.endsWith("/login"))).toHaveLength(1);
		},
	);
	it.each(["cancelled", "epoch-changed", "missing-restore", "foreign-restore"] as const)(
		"does not resume a preparing login after %s invalidates its retained recovery authority",
		async (fault) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([]);
			boundary.control.recovery = "established";
			let approved = false;
			const transport: typeof fetch = async (input, init) => {
				if (String(input).endsWith("qorpera_identity_recovery_runtime_state") && approved)
					return Response.json({ canInitialize: false, blocked: true, epoch: fault === "epoch-changed" ? 3 : 2 });
				const response = await boundary.fetchImplementation(input, init);
				if (String(input).endsWith("qorpera_request_login_identity_recovery")) approved = true;
				return response;
			};
			const gateway = new LxdNativeLoginGateway(
				{
					...config(root),
					identityRecoveryRegistrarCapability: "r".repeat(43),
					guestManifestSha256: "m".repeat(64),
					recoveryWaitMs: 0,
				},
				lxd,
				transport,
			);
			expect(await (await gateway.handle(loginRequest())).json()).toMatchObject({ status: "preparing" });
			const restorePath = "/var/lib/qorpera-recovery/credentials/qorpera-recovery-restore";
			if (fault === "cancelled") boundary.control.status = "cancelled";
			if (fault === "missing-restore") lxd.guestFiles.delete(restorePath);
			if (fault === "foreign-restore") {
				const restore = JSON.parse(lxd.guestFiles.get(restorePath)!);
				lxd.guestFiles.set(restorePath, JSON.stringify({ ...restore, companyId: randomUUID() }));
			}
			const second = await gateway.handle(loginRequest());
			expect(second.status).toBe(fault === "cancelled" ? 403 : 503);
			expect(lxd.createCalls).toHaveLength(1);
			expect(lxd.powerCalls).toEqual(["start"]);
			expect(boundary.control.targetRegistrations).toHaveLength(1);
			expect(boundary.control.recoveryRequests).toHaveLength(1);
			expect(boundary.control.repins).toHaveLength(0);
			expect(
				lxd.execCalls.some((command) => command.join(" ").includes("qorpera-identity-recovery-restore.mjs")),
			).toBe(false);
			expect(lxd.execCalls.some((command) => command[0] === "/usr/bin/systemctl")).toBe(false);
			expect(boundary.requests.some((request) => request.url.endsWith("/login"))).toBe(false);
		},
	);
	it("refuses an established identity on a fresh volume when the node has no registrar, and a fenced identity always", async () => {
		for (const [recovery, extra] of [
			["established", {}],
			["blocked", { identityRecoveryRegistrarCapability: "r".repeat(43), guestManifestSha256: "m".repeat(64) }],
		] as const) {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([]);
			boundary.control.recovery = recovery;
			const gateway = new LxdNativeLoginGateway({ ...config(root), ...extra }, lxd, boundary.fetchImplementation);
			expect((await gateway.handle(loginRequest())).status).toBe(503);
			expect(boundary.control.targetRegistrations).toHaveLength(0);
			expect(boundary.control.recoveryRequests).toHaveLength(0);
			expect(lxd.execCalls.some((c) => c.join(" ").includes("systemctl restart"))).toBe(false);
		}
	});
	it("skips recovery when this node's volume holds the identity at its current recovery epoch", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-identity-recovery-1.json", "present");
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway.handle(loginRequest())).status).toBe(200);
		expect(boundary.control.targetRegistrations).toHaveLength(0);
	});
	it("lets the key alone decide when the recovery state names no epoch: no marker is asked for", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control.recovery = "established";
		boundary.control.recoveryEpochKnown = false;
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		// No registrar is configured, so a recovery attempt here would answer 503.
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway.handle(loginRequest())).status).toBe(200);
		expect(boundary.control.targetRegistrations).toHaveLength(0);
		expect(boundary.control.recoveryRequests).toHaveLength(0);
	});
	it("continues a pending login after another request restored the node's current identity epoch", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "CURRENT-EPOCH" },
			]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-identity-recovery-3.json", "present");
		let loginEpoch = 2;
		const transport: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("qorpera_identity_recovery_runtime_state")) {
				const response = await boundary.fetchImplementation(input, init);
				const state = (await response.json()) as Record<string, unknown>;
				return Response.json({ ...state, epoch: 3 });
			}
			if (url.endsWith("qorpera_repin_login_recovery_epoch")) {
				// The SQL contract permits re-pinning a pending login after any
				// completed recovery at the identity's current generation.
				loginEpoch = 3;
				return Response.json({ loginId, epoch: loginEpoch, repinned: true });
			}
			if (url.endsWith("/login") && loginEpoch !== 3)
				return Response.json({ error: "native login generation is fenced for recovery" }, { status: 403 });
			return boundary.fetchImplementation(input, init);
		};
		const gateway = new LxdNativeLoginGateway(config(root), lxd, transport);
		const response = await gateway.handle(loginRequest());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "awaiting_member", user_code: "CURRENT-EPOCH" });
		expect(loginEpoch).toBe(3);
		expect(boundary.control.targetRegistrations).toHaveLength(0);
		expect(boundary.control.recoveryRequests).toHaveLength(0);
		expect(lxd.execCalls.some((command) => command.join(" ").includes("qorpera-identity-recovery-restore.mjs"))).toBe(
			false,
		);
	});
	it("does not bootstrap a current local identity when its login epoch cannot be re-pinned", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-identity-recovery-1.json", "present");
		const transport: typeof fetch = async (input, init) => {
			if (String(input).endsWith("qorpera_repin_login_recovery_epoch"))
				return Response.json({ error: "login re-pin requires a restored identity" }, { status: 403 });
			return boundary.fetchImplementation(input, init);
		};
		const gateway = new LxdNativeLoginGateway(config(root), lxd, transport);
		expect((await gateway.handle(loginRequest())).status).toBe(503);
		expect(lxd.filePushes).toHaveLength(0);
		expect(lxd.execCalls.some((command) => command[0] === "/usr/bin/systemctl")).toBe(false);
		expect(boundary.requests.some((request) => request.url.endsWith("/login"))).toBe(false);
		expect(boundary.control.recoveryRequests).toHaveLength(0);
	});
	it("recovers a copy left behind by a recovery on another node: the key is here, the current epoch's marker is not", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		const gateway = new LxdNativeLoginGateway(
			{
				...config(root),
				identityRecoveryRegistrarCapability: "r".repeat(43),
				guestManifestSha256: "m".repeat(64),
				recoveryWaitMs: 5000,
			},
			lxd,
			boundary.fetchImplementation,
		);
		expect((await gateway.handle(loginRequest())).status).toBe(200);
		expect(boundary.control.targetRegistrations).toHaveLength(1);
		const scripts = lxd.execCalls.map((c) => c.join(" "));
		const restoreIndex = scripts.findIndex((s) => s.includes("qorpera-identity-recovery-restore.mjs")),
			bootstrapIndex = scripts.findIndex((s) => s.includes("systemctl restart"));
		expect(restoreIndex).toBeGreaterThan(-1);
		expect(bootstrapIndex).toBeGreaterThan(restoreIndex);
		expect(boundary.control.repins).toEqual([{ p_login_id: loginId }]);
		// The key that was already here is never removed or replaced by the gateway.
		expect(lxd.guestFiles.get("/var/lib/qorpera/identity/qorpera-native-provider-master-key")).toBe("present");
	});
	it("refuses a left-behind copy on a node without a registrar instead of mounting it for the bootstrap", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		boundary.control.recovery = "established";
		lxd.guestFiles.set("/var/lib/qorpera/identity/qorpera-native-provider-master-key", "present");
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway.handle(loginRequest())).status).toBe(503);
		expect(lxd.execCalls.some((c) => c.join(" ").includes("systemctl restart"))).toBe(false);
	});
	it("service shutdown aborts an in-flight member request and retains its VM allocation for background cleanup", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		let entered = () => {};
		const reached = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const transport: typeof fetch = async (input, init) => {
			if (String(input) === "http://10.41.0.9:8083/login") {
				entered();
				await new Promise<void>((_resolve, reject) => {
					init!.signal!.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
				});
			}
			return boundary.fetchImplementation(input, init);
		};
		const service = new HttpLxdNativeLoginGateway(new LxdNativeLoginGateway(config(root), lxd, transport));
		const port = await service.start();
		const pending = fetch(`http://127.0.0.1:${port}/login`, {
			method: "POST",
			headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
			body: JSON.stringify(loginBody()),
		}).catch(() => undefined);
		try {
			await reached;
			await service.close();
			await pending;
		} finally {
			await service.close();
		}
		expect(lxd.instance?.status).toBe("Running");
		expect(boundary.control.releasedAt).toBeNull();
		boundary.control.cleanupRequired = true;
		expect(
			(
				await new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation).reconcile(
					new AbortController().signal,
				)
			).unconfirmed,
		).toBe(0);
		expect(lxd.deleteCalls).toBe(1);
	});
	it.each(["COMPANY_PAUSED", "MACHINE_CAPACITY_EXHAUSTED", "COMPUTE_IDENTITY_OCCUPIED"])(
		"refuses %s before storage or VM effects",
		async (reason) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([]);
			boundary.control.companyRefusal = reason;
			const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
			expect((await gateway.handle(loginRequest())).status).toBe(503);
			expect(lxd.createVolumeCalls).toHaveLength(0);
			expect(lxd.createCalls).toHaveLength(0);
			expect(boundary.requests.some((r) => r.url.endsWith("qorpera_reserve_runtime_node_machine"))).toBe(false);
		},
	);
	it.each([
		"NODE_PROVIDER_UNCONFIGURED",
		"NODE_DISABLED",
		"NODE_OBSERVATION_UNAVAILABLE",
		"NODE_HARDWARE_CHANGED",
		"NODE_CAPACITY_EXHAUSTED",
	])("retains company allocation on %s without physical effects", async (reason) => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		boundary.control.nodeRefusal = reason;
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway.handle(loginRequest())).status).toBe(503);
		expect(boundary.control.committed).toBe(true);
		expect(boundary.control.releasedAt).toBeNull();
		expect(lxd.createVolumeCalls).toHaveLength(0);
		expect(lxd.createCalls).toHaveLength(0);
	});
	it.each(["loseCompany", "loseNode"] as const)("reconstructs exact allocation after %s", async (fault) => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control[fault] = 1;
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		expect(lxd.createCalls).toHaveLength(0);
		expect((await gateway().handle(loginRequest())).status).toBe(200);
		expect(lxd.createCalls).toHaveLength(1);
		const attempts = boundary.requests.filter((r) => r.url.endsWith("qorpera_reserve_runtime_login_machine"));
		expect(new Set(attempts.map((r) => JSON.parse(r.body).p_allocation_id)).size).toBe(1);
	});
	it("retires a journal that never reserved a machine, and only when the backend agrees", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([]);
		boundary.control.companyRefusal = "COMPUTE_IDENTITY_OCCUPIED";
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		expect(lxd.createCalls).toHaveLength(0);
		boundary.control.committed = false;
		expect(await gateway().reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 1 });
		boundary.control.orphaned = true;
		expect(await gateway().reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
		expect(await gateway().reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
		expect(lxd.createCalls).toHaveLength(0);
	});
	it("waits while a replaced sign-in gives its machine back, and refuses a real occupant at once", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control.releasing = 2;
		const waiting = new LxdNativeLoginGateway(
			{ ...config(root), identityReleaseWaitMs: 60_000 },
			lxd,
			boundary.fetchImplementation,
		);
		expect((await waiting.handle(loginRequest())).status).toBe(200);
		expect(lxd.createCalls).toHaveLength(1);
		const reservations = boundary.requests.filter((r) => r.url.endsWith("qorpera_reserve_runtime_login_machine"));
		expect(reservations.length).toBeGreaterThanOrEqual(3);
		expect(new Set(reservations.map((r) => JSON.parse(r.body).p_allocation_id)).size).toBe(1);

		const otherRoot = await stateRoot(),
			otherLxd = new FakeLxd(),
			occupied = fetchBoundary([]);
		occupied.control.companyRefusal = "COMPUTE_IDENTITY_OCCUPIED";
		const refused = new LxdNativeLoginGateway(config(otherRoot), otherLxd, occupied.fetchImplementation);
		expect((await refused.handle(loginRequest())).status).toBe(503);
		expect(otherLxd.createCalls).toHaveLength(0);
		expect(occupied.requests.filter((r) => r.url.endsWith("qorpera_reserve_runtime_login_machine"))).toHaveLength(1);
	}, 20_000);
	it("retains a stopped created VM when fresh pre-start admission is refused", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		boundary.control.nodeSequence.push(null, null, "NODE_OBSERVATION_UNAVAILABLE");
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		expect(lxd.instance?.status).toBe("Stopped");
		expect(lxd.powerCalls).toHaveLength(0);
		expect((await gateway().handle(loginRequest())).status).toBe(200);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
	});
	it.each(["create", "start"] as const)(
		"keeps lost %s submission charged and never recreates or releases",
		async (action) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([]);
			lxd.lostSubmission = action;
			const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
			expect((await gateway().handle(loginRequest())).status).toBe(503);
			lxd.instance = undefined; // Absence is deliberately not submission settlement.
			expect((await gateway().handle(loginRequest())).status).toBe(503);
			boundary.control.cleanupRequired = true;
			expect(await gateway().reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 1 });
			expect(lxd.createCalls).toHaveLength(1);
			expect(boundary.control.releasedAt).toBeNull();
			expect(lxd.deleteCalls).toBe(0);
		},
	);
	it("recovers accepted creation after a lost poll without resubmitting", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		lxd.lostPolls = 1;
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		expect((await gateway().handle(loginRequest())).status).toBe(200);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
	});
	it.each(["expired", "cancelled", "completed"] as const)(
		"cleans %s logins with no member polling, fresh node health or old service credential",
		async (status) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([
					{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
				]);
			await new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation).handle(loginRequest());
			boundary.control.status = status;
			boundary.control.nodeRefusal = "NODE_OBSERVATION_UNAVAILABLE";
			const retained = structuredClone(lxd.volume);
			const replacement = new LxdNativeLoginGateway(
				{ ...config(root), supabaseServiceKey: "rotated-private-key" },
				lxd,
				boundary.fetchImplementation,
			);
			expect(await replacement.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(lxd.instance).toBeUndefined();
			expect(lxd.volume).toEqual(retained);
			expect(boundary.control.releasedAt).not.toBeNull();
		},
	);
	it.each(["stop", "delete"] as const)(
		"settles accepted %s after a lost poll before releasing capacity",
		async (action) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([
					{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
				]);
			await new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation).handle(loginRequest());
			boundary.control.cleanupRequired = true;
			lxd.onSubmit = (submitted) => {
				if (submitted.action === action) lxd.lostPolls = 1;
			};
			const replacement = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
			expect((await replacement().reconcile(new AbortController().signal)).unconfirmed).toBe(1);
			expect(boundary.control.releasedAt).toBeNull();
			expect((await replacement().reconcile(new AbortController().signal)).unconfirmed).toBe(0);
			expect(lxd.deleteCalls).toBe(1);
			expect(lxd.powerCalls).toEqual(["start", "stop"]);
			expect(boundary.control.releasedAt).not.toBeNull();
		},
	);
	it("recovers a lost committed release without deleting the identity disk or repeating VM deletion", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		await new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation).handle(loginRequest());
		boundary.control.cleanupRequired = true;
		boundary.control.loseRelease = 1;
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		expect((await gateway().reconcile(new AbortController().signal)).unconfirmed).toBe(1);
		expect((await gateway().reconcile(new AbortController().signal)).unconfirmed).toBe(0);
		expect(lxd.deleteCalls).toBe(1);
		expect(lxd.volume).toBeDefined();
	});
	it("the HTTP service cleans retained logins after restart without another member request", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		await new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation).handle(loginRequest());
		boundary.control.cleanupRequired = true;
		const service = new HttpLxdNativeLoginGateway(
			new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation),
		);
		try {
			await service.start();
			await vi.waitFor(() => expect(boundary.control.releasedAt).not.toBeNull());
		} finally {
			await service.close();
		}
		expect(lxd.deleteCalls).toBe(1);
	});
	it("reads a released journal once per process, not on every cleanup pass or sign-in", async () => {
		const root = await stateRoot(),
			kept = { ...config(root), releasedJournalRetentionMs: Number.MAX_SAFE_INTEGER },
			lxd = new FakeLxd(),
			released = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		await new LxdNativeLoginGateway(kept, lxd, released.fetchImplementation).handle(loginRequest());
		released.control.cleanupRequired = true;
		await new LxdNativeLoginGateway(kept, lxd, released.fetchImplementation).reconcile(new AbortController().signal);
		expect(released.control.releasedAt).not.toBeNull();

		const nextLoginId = "30000000-0000-4000-8000-000000000011",
			next = fetchBoundary(
				[{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null }],
				[],
				nextLoginId,
			);
		let boundary = released;
		const opens = vi.spyOn(LxdLoginJournal, "open");
		const reads = (id: string) => opens.mock.calls.filter(([, name]) => name === id).length;
		try {
			// A restarted process verifies the retained journal once, then skips it.
			const gateway = new LxdNativeLoginGateway(kept, lxd, (input, init) =>
				boundary.fetchImplementation(input, init),
			);
			for (let pass = 0; pass < 3; pass++)
				expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(reads(loginId)).toBe(1);
			// A later sign-in of the same identity scans for replaced logins without reopening it.
			boundary = next;
			expect((await gateway.handle(loginRequest(loginBody({ login_id: nextLoginId })))).status).toBe(200);
			expect(reads(nextLoginId)).toBeGreaterThan(0);
			expect(reads(loginId)).toBe(1);
			expect(lxd.createCalls).toHaveLength(2);
			expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 2, unconfirmed: 0 });
			expect(reads(loginId)).toBe(1);
		} finally {
			opens.mockRestore();
		}
	});
	it("archives a released journal after a day and refuses a later request for its login", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]),
			kept = { ...config(root), releasedJournalRetentionMs: Number.MAX_SAFE_INTEGER };
		await new LxdNativeLoginGateway(kept, lxd, boundary.fetchImplementation).handle(loginRequest());
		boundary.control.cleanupRequired = true;
		await new LxdNativeLoginGateway(kept, lxd, boundary.fetchImplementation).reconcile(new AbortController().signal);
		expect(boundary.control.releasedAt).toBe("2026-09-08T00:00:00.000Z");

		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		const opens = vi.spyOn(LxdLoginJournal, "open");
		const now = vi.spyOn(Date, "now");
		try {
			now.mockReturnValue(Date.parse("2026-09-08T12:00:00.000Z"));
			expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(await readdir(root)).toEqual([loginId]);
			// A day after its release it moves to the archive without being read again.
			now.mockReturnValue(Date.parse("2026-09-09T00:00:00.000Z"));
			expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(opens.mock.calls.filter(([, name]) => name === loginId)).toHaveLength(1);
		} finally {
			now.mockRestore();
			opens.mockRestore();
		}
		expect(await readdir(root)).toEqual(["archive"]);
		expect(await readdir(join(root, "archive", loginId))).not.toContain("bridge.json");
		const archived = await LxdLoginJournal.open(join(root, "archive"), loginId, lxd);
		expect((await archived.state()).releasedAt).toBe("2026-09-08T00:00:00.000Z");
		expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 0, unconfirmed: 0 });

		// Its login is over: a later post neither allocates a machine nor a new journal.
		expect((await gateway.handle(loginRequest())).status).toBe(503);
		expect(lxd.createCalls).toHaveLength(1);
		expect(await readdir(root)).toEqual(["archive"]);
		boundary.control.status = "completed";
		expect(await (await gateway.handle(loginRequest())).json()).toMatchObject({ status: "completed" });
	});
	it("fails closed on protected host changes and missing retained authority", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		await gateway().handle(loginRequest());
		vi.mocked(readRuntimeNodeHost).mockResolvedValueOnce({
			machineIdSha256: "e".repeat(64),
			cpuMillis: 16000,
			memoryBytes: 64 * 1024 ** 3,
		});
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		await unlink(join(root, loginId, "authority.json"));
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start"]);
	});
	it("refuses expanded memory drift and preserves capacity for investigation", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]);
		const gateway = () => new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		await gateway().handle(loginRequest());
		lxd.instance!.expandedConfig = { ...lxd.instance!.expandedConfig, "limits.memory": "64GiB" };
		expect((await gateway().handle(loginRequest())).status).toBe(503);
		boundary.control.cleanupRequired = true;
		expect((await gateway().reconcile(new AbortController().signal)).unconfirmed).toBe(1);
		expect(boundary.control.releasedAt).toBeNull();
	});
	it("admits one login allocation, then deletes its VM while preserving the identity disk", async () => {
		const root = await stateRoot();
		const lxd = new FakeLxd();
		const boundary = fetchBoundary(
			[
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: "ABCD-EFGH" },
				{ status: "completed", interactionUrl: null, userCode: null },
			],
			["pending", "completed"],
		);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);

		await expect(gateway.handle(loginRequest()).then((response) => response.json())).resolves.toMatchObject({
			status: "awaiting_member",
			interaction_url: "https://provider.example/device",
		});
		expect(lxd.createVolumeCalls).toHaveLength(1);
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.createCalls[0]).toMatchObject({
			name: expect.stringMatching(/^qorpera-login-[0-9a-f]{32}$/),
			type: "virtual-machine",
			profiles: ["qorpera-login-v1"],
			config: {
				"boot.mode": "uefi-secureboot",
				"user.qorpera.schema": "qorpera.native-login-vm/v2",
				"user.qorpera.login_id": loginId,
				"user.qorpera.compute_identity_id": computeIdentityId,
				"user.qorpera.bootstrap_sha256": expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			devices: {
				root: { pool: "qorpera-vm", size: "80GiB" },
				"compute-identity": {
					source: `identity-${computeIdentityId}`,
					path: "/var/lib/qorpera/identity",
				},
			},
			source: { type: "image", fingerprint: "a".repeat(64) },
		});
		expect(JSON.stringify(lxd.createCalls[0])).not.toContain("sb_secret_private");
		expect(lxd.filePushes.map((file) => file.path)).toEqual([
			"/var/lib/qorpera-bootstrap/login-bootstrap.json",
			"/var/lib/qorpera-bootstrap/native-provider.env",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-identity-recovery-ca",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-native-bridge",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-supabase-service-key",
		]);
		expect(lxd.filePushes.every((file) => file.mode === 0o600)).toBe(true);
		expect(lxd.filePushes.find((file) => file.path.endsWith("qorpera-identity-recovery-ca"))?.content).toBe(
			identityRecoveryCa,
		);
		expect(
			JSON.parse(lxd.filePushes.find((file) => file.path.endsWith("login-bootstrap.json"))?.content ?? "{}"),
		).toMatchObject({ identity_recovery_ca_sha256: identityRecoveryCaSha256 });
		expect(lxd.powerCalls).toEqual(["start"]);

		await expect(gateway.handle(loginRequest()).then((response) => response.json())).resolves.toMatchObject({
			status: "completed",
		});
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.createVolumeCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start", "stop"]);
		expect(lxd.deleteCalls).toBe(1);
		expect(lxd.instance).toBeUndefined();
		expect(lxd.volume?.name).toBe(`identity-${computeIdentityId}`);
		expect(boundary.control.releasedAt).not.toBeNull();
		const company = boundary.requests.filter((r) => r.url.endsWith("qorpera_reserve_runtime_login_machine"));
		const node = boundary.requests.filter((r) => r.url.endsWith("qorpera_reserve_runtime_node_machine"));
		expect(company).toHaveLength(3);
		expect(node).toHaveLength(3);
		expect(new Set(company.map((r) => JSON.parse(r.body).p_allocation_id)).size).toBe(1);
		expect(JSON.parse(node[0].body)).toMatchObject({
			p_provider_kind: "login",
			p_cpu_millis: 4000,
			p_memory_bytes: 8 * 1024 ** 3,
		});
		expect(lxd.execCalls).toContainEqual([
			"/usr/bin/systemctl",
			"restart",
			"qorpera-lxd-native-login-bootstrap.service",
		]);
		const forwarded = boundary.requests.filter((request) => request.url.endsWith("/login"));
		expect(forwarded).toHaveLength(1);
		expect(forwarded.every((request) => request.authorization === `Bearer ${capability}`)).toBe(true);
	});

	it("rejects a mismatched bearer capability before contacting Supabase or LXD", async () => {
		const root = await stateRoot();
		const lxd = new FakeLxd();
		const boundary = fetchBoundary([]);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);

		const response = await gateway.handle(loginRequest(loginBody(), "g".repeat(43)));
		expect(response.status).toBe(400);
		expect(boundary.requests).toHaveLength(0);
		expect(lxd.createCalls).toHaveLength(0);
	});

	it("rejects an unpinned recovery-authority CA before creating login state", async () => {
		const root = await stateRoot();
		const lxd = new FakeLxd();
		const boundary = fetchBoundary([]);
		expect(
			() =>
				new LxdNativeLoginGateway(
					{ ...config(root), identityRecoveryCaSha256: "0".repeat(64) },
					lxd,
					boundary.fetchImplementation,
				),
		).toThrow("recovery-authority CA is invalid");
		expect(lxd.createCalls).toHaveLength(0);
	});

	it("fails closed when an existing login VM drifts from its pinned identity", async () => {
		const root = await stateRoot();
		const lxd = new FakeLxd();
		const boundary = fetchBoundary([
			{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
		]);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation);
		await gateway.handle(loginRequest());
		if (!lxd.instance) throw new Error("expected fake login instance");
		lxd.instance = { ...lxd.instance, profiles: ["foreign-profile"] };

		const response = await gateway.handle(loginRequest());
		expect(response.status).toBe(503);
		expect(lxd.createCalls).toHaveLength(1);
		expect(boundary.requests.filter((request) => request.url.endsWith("/login"))).toHaveLength(1);
	});
});

/** Node 2's shared execution host as its login gateway sees it: devices changed under one read. */
class FakeExecHost implements LxdInstanceDeviceUpdateClient {
	devices: Record<string, Record<string, string>> = { root: { type: "disk", path: "/", pool: "qorpera-vm" } };
	volumes: LxdStorageVolumeRecord[] = [];
	failures = 0;
	attaches: Array<{ volumesCreated: number; loginMachines: number; devices: string[] }> = [];
	readonly lxd: FakeLxd;
	constructor(lxd: FakeLxd) {
		this.lxd = lxd;
	}
	instance(): LxdInstanceRecord {
		return {
			name: "qorpera-exec-node02",
			type: "virtual-machine",
			status: "Running",
			statusCode: 103,
			config: {},
			profiles: ["native25-job-a1"],
			devices: structuredClone(this.devices),
			expandedDevices: { ...structuredClone(this.devices), eth0: { type: "nic", network: "qorpera0" } },
			expandedConfig: {},
		};
	}
	async getInstance() {
		return this.instance();
	}
	async updateInstanceDevices(
		project: string,
		_name: string,
		update: (instance: LxdInstanceRecord) => Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
	): Promise<boolean> {
		expect(project).toBe("qorpera-runners");
		const devices = update(this.instance());
		if (!devices) return false;
		if (this.failures-- > 0) throw new Error("LXD: instance is busy");
		this.devices = structuredClone(devices) as Record<string, Record<string, string>>;
		this.attaches.push({
			volumesCreated: this.lxd.createVolumeCalls.length,
			loginMachines: this.lxd.createCalls.length,
			devices: Object.keys(devices).sort(),
		});
		return true;
	}
	async listCustomStorageVolumes(project: string, pool: string) {
		expect([project, pool]).toEqual(["qorpera-runners", "qorpera-vm"]);
		return structuredClone([...(this.lxd.volume ? [this.lxd.volume] : []), ...this.volumes]);
	}
}

describe("LXD native login gateway and the node's shared execution host", () => {
	const identityDevice = (id: string) => ({
		type: "disk",
		pool: "qorpera-vm",
		source: `identity-${id}`,
		path: `/var/lib/qorpera/identities/${id}`,
	});
	const execHost = (lxd: FakeLxd) => {
		const fake = new FakeExecHost(lxd);
		return {
			fake,
			identities: new LxdExecutionHostIdentities(
				{ project: "qorpera-runners", instance: "qorpera-exec-node02" },
				{ pool: "qorpera-vm", sourcePrefix: "identity-" },
				fake,
			),
		};
	};
	it("attaches a new login's identity volume right after creating it, before the login machine", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = fetchBoundary([
				{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null },
			]),
			{ fake, identities } = execHost(lxd);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation, identities);
		const response = await gateway.handle(loginRequest());
		expect(await response.json()).toMatchObject({ status: "awaiting_member" });
		expect(fake.attaches).toEqual([
			{ volumesCreated: 1, loginMachines: 0, devices: [`identity-${computeIdentityId}`, "root"] },
		]);
		expect(fake.devices[`identity-${computeIdentityId}`]).toEqual(identityDevice(computeIdentityId));
		// The same member's next post, a refresh or the sweep finds it attached and writes nothing.
		await gateway.handle(loginRequest());
		await gateway.reconcile(new AbortController().signal);
		expect(fake.attaches).toHaveLength(1);
	});
	const marked = (name: string, id: string, extra: Record<string, string> = {}): LxdStorageVolumeRecord => ({
		name,
		type: "custom",
		contentType: "filesystem",
		description: `Qorpera Compute Identity ${id}`,
		config: {
			size: "32GiB",
			"user.qorpera.schema": "qorpera.compute-identity-volume/v1",
			"user.qorpera.compute_identity_id": id,
			"user.qorpera.provider_adapter": "lxd",
			...extra,
		},
	});
	const awaitingMember = () =>
		fetchBoundary([{ status: "awaiting_member", interactionUrl: "https://provider.example/device", userCode: null }]);
	it("never fails a login over the attach; the sweep attaches only volumes of logins this node placed", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = awaitingMember(),
			{ fake, identities } = execHost(lxd);
		fake.failures = 3;
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation, identities);
			const response = await gateway.handle(loginRequest());
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ status: "awaiting_member" });
			expect(fake.attaches).toHaveLength(0);
			expect(errors.mock.calls.flat().join("\n")).toContain(
				`could not attach Compute Identity ${computeIdentityId}`,
			);
			// Well-formed identity volumes of logins this node never placed stay off the host,
			// as do volumes that are not exactly an identity volume.
			fake.volumes = [
				marked("identity-30000000-0000-4000-8000-0000000000aa", "30000000-0000-4000-8000-0000000000aa"),
				marked("identity-../../etc", "../../etc"),
				marked("recovery-30000000-0000-4000-8000-0000000000ab", "30000000-0000-4000-8000-0000000000ab"),
			];
			expect((await gateway.reconcile(new AbortController().signal)).unconfirmed).toBe(0);
			expect(fake.attaches).toHaveLength(1);
			expect(Object.keys(fake.devices).sort()).toEqual([`identity-${computeIdentityId}`, "root"]);
			expect(fake.devices[`identity-${computeIdentityId}`]).toEqual(identityDevice(computeIdentityId));
		} finally {
			errors.mockRestore();
		}
	});
	it.each([
		["another adapter", { "user.qorpera.provider_adapter": "other-node" }],
		["another identity marker", { "user.qorpera.compute_identity_id": "30000000-0000-4000-8000-0000000000dd" }],
		["another size", { size: "1TiB" }],
		["a block volume", null],
	])("the sweep leaves a placed login's volume with %s off the host", async (_label, drift) => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			{ fake, identities } = execHost(lxd);
		fake.failures = 3;
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const gateway = new LxdNativeLoginGateway(config(root), lxd, awaitingMember().fetchImplementation, identities);
			expect((await gateway.handle(loginRequest())).status).toBe(200);
			if (!lxd.volume) throw new Error("expected the login's volume");
			lxd.volume =
				drift === null
					? { ...lxd.volume, contentType: "block" }
					: { ...lxd.volume, config: { ...lxd.volume.config, ...drift } };
			await gateway.reconcile(new AbortController().signal);
			expect(fake.attaches).toHaveLength(0);
		} finally {
			errors.mockRestore();
		}
	});
	it("the sweep leaves an identity's volume off the host when its login here was never placed", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			boundary = awaitingMember(),
			{ fake, identities } = execHost(lxd);
		boundary.control.nodeRefusal = "NODE_CAPACITY_EXHAUSTED";
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation, identities);
			expect((await gateway.handle(loginRequest())).status).toBe(503);
			expect(lxd.createVolumeCalls).toHaveLength(0);
			fake.volumes = [marked(`identity-${computeIdentityId}`, computeIdentityId)];
			await gateway.reconcile(new AbortController().signal);
			expect(fake.attaches).toHaveLength(0);
		} finally {
			errors.mockRestore();
		}
	});
	it("logs a sweep that cannot list volumes once a minute and keeps the reconcile going", async () => {
		const root = await stateRoot(),
			lxd = new FakeLxd(),
			{ fake, identities } = execHost(lxd);
		const gateway = new LxdNativeLoginGateway(config(root), lxd, awaitingMember().fetchImplementation, identities);
		await gateway.handle(loginRequest());
		fake.listCustomStorageVolumes = async () => {
			throw new Error("LXD: not found");
		};
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(await gateway.reconcile(new AbortController().signal)).toEqual({ scanned: 1, unconfirmed: 0 });
			expect(
				errors.mock.calls.flat().filter((line) => String(line).includes("could not list identity volumes")),
			).toHaveLength(1);
		} finally {
			errors.mockRestore();
		}
	});
	it.each([
		[
			"another project",
			{ project: "qn25b2", instance: "qorpera-exec-node02" },
			{ pool: "qorpera-vm", sourcePrefix: "identity-" },
		],
		["another pool", { project: "qorpera-runners", instance: "x" }, { pool: "default", sourcePrefix: "identity-" }],
		[
			"another prefix",
			{ project: "qorpera-runners", instance: "x" },
			{ pool: "qorpera-vm", sourcePrefix: "phql-a1-identity-" },
		],
	])("refuses an execution host that would mount volumes from %s", async (_label, host, volumes) => {
		const root = await stateRoot(),
			lxd = new FakeLxd();
		expect(
			() =>
				new LxdNativeLoginGateway(
					config(root),
					lxd,
					fetchBoundary([]).fetchImplementation,
					new LxdExecutionHostIdentities(host, volumes, new FakeExecHost(lxd)),
				),
		).toThrow("Execution host must mount this gateway's own identity volumes");
	});

	describe("a deleted company's identities (RUNTIME-COMPANY-DELETE.md D4)", () => {
		const deleted = "30000000-0000-4000-8000-0000000000d4";
		const retireSetup = async (withHost = true) => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = fetchBoundary([]),
				host = execHost(lxd);
			lxd.volume = marked(`identity-${deleted}`, deleted);
			host.fake.devices[`identity-${deleted}`] = identityDevice(deleted);
			boundary.control.retirementsDue = [deleted];
			const gateway = new LxdNativeLoginGateway(
				config(root),
				lxd,
				boundary.fetchImplementation,
				withHost ? host.identities : undefined,
			);
			const dueCalls = () =>
				boundary.requests.filter((request) => request.url.endsWith("qorpera_runtime_identity_retirements_due"));
			return { root, lxd, boundary, fake: host.fake, gateway, dueCalls };
		};
		const evidence = (volume: string, device: string) => ({
			schema: "qorpera.identity-retirement-evidence/v1",
			volume,
			device,
		});
		afterEach(() => {
			vi.useRealTimers();
		});
		it("detaches it from the execution host, deletes its volume, confirms, and asks again only a minute later", async () => {
			const { lxd, boundary, fake, gateway, dueCalls } = await retireSetup();
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[`identity-${deleted}`]).toBeUndefined();
				expect(fake.devices.root).toBeDefined();
				expect(lxd.volume).toBeUndefined();
				expect(lxd.volumeDeletes).toEqual([`identity-${deleted}`]);
				expect(boundary.control.retirements).toEqual([
					{
						p_provider_id: "lxd",
						p_machine_id_sha256: "d".repeat(64),
						p_compute_identity_id: deleted,
						p_evidence: evidence("deleted", "detached"),
					},
				]);
				expect(JSON.parse(dueCalls()[0]!.body)).toEqual({
					p_provider_id: "lxd",
					p_machine_id_sha256: "d".repeat(64),
				});
				await gateway.reconcile(new AbortController().signal);
				expect(dueCalls()).toHaveLength(1);
				expect(
					errors.mock.calls.flat().some((line) => String(line).includes(`retired Compute Identity ${deleted}`)),
				).toBe(true);
			} finally {
				errors.mockRestore();
			}
		});
		it("confirms a node without an execution host, and a volume already gone", async () => {
			const { lxd, boundary, gateway } = await retireSetup(false);
			lxd.volume = undefined;
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				await gateway.reconcile(new AbortController().signal);
				expect(lxd.volumeDeletes).toEqual([]);
				expect(boundary.control.retirements.map((call) => call.p_evidence)).toEqual([evidence("absent", "none")]);
			} finally {
				errors.mockRestore();
			}
		});
		it("keeps an identity whose sign-in machine here is not released yet", async () => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = awaitingMember(),
				{ fake, identities } = execHost(lxd);
			const gateway = new LxdNativeLoginGateway(config(root), lxd, boundary.fetchImplementation, identities);
			expect((await gateway.handle(loginRequest())).status).toBe(200);
			boundary.control.retirementsDue = [computeIdentityId];
			await gateway.reconcile(new AbortController().signal);
			expect(fake.devices[`identity-${computeIdentityId}`]).toEqual(identityDevice(computeIdentityId));
			expect(lxd.volume).toBeDefined();
			expect(boundary.control.retirements).toEqual([]);
		});
		it("leaves a volume that is not exactly this identity's, device and all, and confirms nothing", async () => {
			const { lxd, boundary, fake, gateway } = await retireSetup();
			lxd.volume = marked(`identity-${deleted}`, deleted, { "user.qorpera.provider_adapter": "other" });
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[`identity-${deleted}`]).toEqual(identityDevice(deleted));
				expect(lxd.volumeDeletes).toEqual([]);
				expect(boundary.control.retirements).toEqual([]);
				expect(
					errors.mock.calls
						.flat()
						.some((line) => String(line).includes(`could not retire Compute Identity ${deleted}`)),
				).toBe(true);
			} finally {
				errors.mockRestore();
			}
		});
		it("never attaches a detached identity again while its volume delete fails, and finishes a minute later", async () => {
			const root = await stateRoot(),
				lxd = new FakeLxd(),
				boundary = awaitingMember(),
				{ fake, identities } = execHost(lxd);
			vi.useFakeTimers({ toFake: ["Date"] });
			const gateway = new LxdNativeLoginGateway(
				{ ...config(root), releasedJournalRetentionMs: Number.MAX_SAFE_INTEGER },
				lxd,
				boundary.fetchImplementation,
				identities,
			);
			const device = `identity-${computeIdentityId}`;
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				// A sign-in placed on this node, then ended: the sweep keeps its volume attached.
				expect((await gateway.handle(loginRequest())).status).toBe(200);
				boundary.control.status = "expired";
				for (let pass = 0; pass < 3; pass++) await gateway.reconcile(new AbortController().signal);
				expect(lxd.instance).toBeUndefined();
				delete fake.devices[device];
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[device]).toEqual(identityDevice(computeIdentityId));
				// Its company is deleted; LXD refuses the volume delete for now.
				boundary.control.retirementsDue = [computeIdentityId];
				const remove = lxd.deleteStorageVolume.bind(lxd);
				lxd.deleteStorageVolume = async () => {
					throw new Error("LXD: storage volume is still in use");
				};
				vi.setSystemTime(Date.now() + 61_000);
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[device]).toBeUndefined();
				expect(lxd.volume).toBeDefined();
				expect(boundary.control.retirements).toEqual([]);
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[device]).toBeUndefined();
				lxd.deleteStorageVolume = remove;
				vi.setSystemTime(Date.now() + 61_000);
				await gateway.reconcile(new AbortController().signal);
				expect(lxd.volume).toBeUndefined();
				expect(fake.devices[device]).toBeUndefined();
				expect(boundary.control.retirements.map((call) => call.p_evidence)).toEqual([
					evidence("deleted", "absent"),
				]);
			} finally {
				errors.mockRestore();
			}
		});
		it("answers a lost confirmation from the receipt on the next pass, with nothing left to remove", async () => {
			const { lxd, boundary, fake, gateway } = await retireSetup();
			vi.useFakeTimers({ toFake: ["Date"] });
			boundary.control.loseRetirement = 1;
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				await gateway.reconcile(new AbortController().signal);
				expect(lxd.volume).toBeUndefined();
				expect(fake.devices[`identity-${deleted}`]).toBeUndefined();
				vi.setSystemTime(Date.now() + 61_000);
				await gateway.reconcile(new AbortController().signal);
				expect(boundary.control.retirements.map((call) => call.p_evidence)).toEqual([
					evidence("deleted", "detached"),
					evidence("absent", "absent"),
				]);
				expect(
					errors.mock.calls.flat().some((line) => String(line).includes(`retired Compute Identity ${deleted}`)),
				).toBe(true);
			} finally {
				errors.mockRestore();
			}
		});
		it("detaches only an identity device of exactly its shape set on the host itself", async () => {
			const lxd = new FakeLxd(),
				{ fake, identities } = execHost(lxd);
			await expect(identities.detach(deleted, new AbortController().signal)).resolves.toBe("absent");
			fake.devices[`identity-${deleted}`] = { ...identityDevice(deleted), readonly: "true" };
			await expect(identities.detach(deleted, new AbortController().signal)).rejects.toThrow("is not this volume");
			fake.devices[`identity-${deleted}`] = identityDevice(deleted);
			const instance = fake.instance.bind(fake);
			// Set by a profile, it is not the gateway's to remove.
			fake.instance = () => {
				const current = instance();
				const { [`identity-${deleted}`]: _own, ...devices } = current.devices;
				return { ...current, devices };
			};
			await expect(identities.detach(deleted, new AbortController().signal)).rejects.toThrow("is not this volume");
			fake.instance = instance;
			await expect(identities.detach(deleted, new AbortController().signal)).resolves.toBe("detached");
			expect(Object.keys(fake.devices)).toEqual(["root"]);
		});
		it.each([
			["another schema", { schema: "x", nodeId: "30000000-0000-4000-8000-000000000010", computeIdentityIds: [] }],
			[
				"a malformed id",
				{
					schema: "qorpera.identity-retirements-due/v1",
					nodeId: "30000000-0000-4000-8000-000000000010",
					computeIdentityIds: ["X"],
				},
			],
			[
				"an extra key",
				{
					schema: "qorpera.identity-retirements-due/v1",
					nodeId: "30000000-0000-4000-8000-000000000010",
					computeIdentityIds: [],
					more: 1,
				},
			],
		])("does nothing on a due answer with %s", async (_label, answer) => {
			const { lxd, boundary, fake, gateway } = await retireSetup();
			boundary.control.retirementsDueAnswer = answer;
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				await gateway.reconcile(new AbortController().signal);
				expect(fake.devices[`identity-${deleted}`]).toEqual(identityDevice(deleted));
				expect(lxd.volume).toBeDefined();
				expect(boundary.control.retirements).toEqual([]);
			} finally {
				errors.mockRestore();
			}
		});
	});
});
