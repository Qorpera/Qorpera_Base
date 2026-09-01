import { mkdtemp, rm } from "node:fs/promises";
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
import { LxdNativeLoginGateway, type LxdNativeLoginGatewayConfig } from "../src/lxd-login-gateway.ts";

const roots: string[] = [];
const loginId = "30000000-0000-4000-8000-000000000001";
const profileId = "30000000-0000-4000-8000-000000000002";
const clientConnectionId = "30000000-0000-4000-8000-000000000003";
const computeIdentityId = "30000000-0000-4000-8000-000000000004";
const ownerUserId = "30000000-0000-4000-8000-000000000005";
const capability = "f".repeat(43);
const expiresAt = "2099-08-23T12:00:00.000Z";

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function stateRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-lxd-login-gateway-"));
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

	async getInstance(): Promise<LxdInstanceRecord | undefined> {
		return this.instance ? structuredClone(this.instance) : undefined;
	}

	async getInstanceState(): Promise<LxdInstanceStateRecord> {
		return {
			status: this.instance?.status ?? "Stopped",
			statusCode: this.instance?.statusCode ?? 102,
			network: {
				enp5s0: { addresses: [{ family: "inet", address: "10.41.0.9", scope: "global" }] },
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
			config: structuredClone(request.config),
			profiles: [...request.profiles],
			devices: structuredClone(request.devices),
			expandedDevices: structuredClone(request.devices),
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
	}

	async execInstance(_project: string, _name: string, command: readonly string[]): Promise<void> {
		if (this.instance?.status !== "Running") throw new Error("fake VM agent is unavailable");
		this.execCalls.push([...command]);
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
		networkInterface: "enp5s0",
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

function fetchBoundary(
	logins: NativeLoginResponse[],
	statuses: Array<"pending" | "completed"> = [],
): {
	fetchImplementation: typeof fetch;
	requests: Array<{ url: string; authorization: string | null; body: string }>;
} {
	const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
	const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		const authorization = new Headers(init?.headers).get("authorization");
		const body = String(init?.body ?? "");
		requests.push({ url, authorization, body });
		if (url.includes("qorpera_describe_native_provider_login")) {
			return Response.json({
				login_id: loginId,
				profile_id: profileId,
				client_connection_id: clientConnectionId,
				compute_identity_id: computeIdentityId,
				compute_identity_ownership_kind: "member",
				compute_identity_owner_user_id: ownerUserId,
				compute_identity_owner_scope_key: null,
				provider: "openai",
				native_harness: "codex-cli",
				expires_at: expiresAt,
				status: statuses.shift() ?? "pending",
			});
		}
		if (url.endsWith("/healthz")) return Response.json({ ok: true });
		if (url.endsWith("/login")) {
			const response = logins.shift();
			if (!response) throw new Error("unexpected login forwarding call");
			return Response.json({
				schema: "qorpera.native-provider-login-result/v1",
				login_id: loginId,
				status: response.status,
				interaction_url: response.interactionUrl,
				user_code: response.userCode,
			});
		}
		return Response.json({ error: "unexpected test URL" }, { status: 404 });
	}) as typeof fetch;
	return { fetchImplementation, requests };
}

interface NativeLoginResponse {
	status: "awaiting_member" | "completed";
	interactionUrl: string | null;
	userCode: string | null;
}

describe("LXD native login gateway", () => {
	it("validates durable authority, routes through one identity-pinned VM and stops it after completion", async () => {
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
			name: `qorpera-login-${computeIdentityId.replaceAll("-", "")}`,
			type: "virtual-machine",
			profiles: ["qorpera-login-v1"],
			config: {
				"boot.mode": "uefi-secureboot",
				"user.qorpera.schema": "qorpera.native-login-vm/v1",
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
			"/var/lib/qorpera-bootstrap/credentials/qorpera-native-bridge",
			"/var/lib/qorpera-bootstrap/credentials/qorpera-supabase-service-key",
		]);
		expect(lxd.filePushes.every((file) => file.mode === 0o600)).toBe(true);
		expect(lxd.powerCalls).toEqual(["start"]);

		await expect(gateway.handle(loginRequest()).then((response) => response.json())).resolves.toMatchObject({
			status: "completed",
		});
		expect(lxd.createCalls).toHaveLength(1);
		expect(lxd.createVolumeCalls).toHaveLength(1);
		expect(lxd.powerCalls).toEqual(["start", "stop"]);
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
