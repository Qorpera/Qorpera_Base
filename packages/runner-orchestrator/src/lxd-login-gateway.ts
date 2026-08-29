import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import type {
	LxdClient,
	LxdCreateInstanceRequest,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
} from "./lxd-client.ts";

const LOGIN_SCHEMA = "qorpera.native-provider-login/v1";
const LOGIN_RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
const LOGIN_INSTANCE_SCHEMA = "qorpera.native-login-vm/v1";
const IDENTITY_VOLUME_SCHEMA = "qorpera.compute-identity-volume/v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const STORAGE_SIZE_PATTERN = /^[1-9][0-9]*(?:KiB|MiB|GiB|TiB)$/;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

type NativeComputeOwnershipKind = "member" | "company" | "department" | "security_boundary";

interface NativeLoginRequest {
	loginId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	computeIdentityOwnershipKind: NativeComputeOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	provider: "openai" | "anthropic";
	nativeHarness: "codex-cli" | "claude-code";
	capability: string;
	expiresAt: string;
	encoded: string;
}

interface NativeLoginDescription extends Omit<NativeLoginRequest, "capability" | "encoded"> {
	profileId: string;
	status: "pending" | "completed";
}

interface NativeLoginResult {
	schema: typeof LOGIN_RESULT_SCHEMA;
	login_id: string;
	status: "awaiting_member" | "completed";
	interaction_url: string | null;
	user_code: string | null;
}

interface LoginBootstrapFile {
	path: string;
	content: string;
}

export interface LxdNativeLoginGatewayConfig {
	adapterId: string;
	supabaseUrl: string;
	supabaseServiceKey: string;
	stateRoot: string;
	project: string;
	loginProfile: string;
	networkInterface: string;
	imageServer: string;
	imageFingerprint: string;
	storagePool: string;
	identityVolumePrefix: string;
	identityVolumeSize: string;
	rootDiskSize: string;
	cpuLimit: number;
	memoryLimit: string;
	nativeBridgePort: number;
	guestTrustedSource: string;
	identityRecoveryCaCertificate: string;
	identityRecoveryCaSha256: string;
	guestReadyTimeoutMs?: number;
	codexPath: string;
	claudePath: string;
	loginBootstrapService?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const expected = new Set(allowed);
	if (Object.keys(input).some((key) => !expected.has(key))) throw new Error(`${label} has unknown fields`);
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function text(value: unknown, label: string, maximum = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function nullableUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

function nullableText(value: unknown, label: string, maximum = 512): string | undefined {
	return value === null || value === undefined ? undefined : text(value, label, maximum);
}

function provider(value: unknown): "openai" | "anthropic" {
	if (value !== "openai" && value !== "anthropic") throw new Error("Native login provider is invalid");
	return value;
}

function harness(value: unknown): "codex-cli" | "claude-code" {
	if (value !== "codex-cli" && value !== "claude-code") throw new Error("Native login harness is invalid");
	return value;
}

function ownership(
	kind: unknown,
	ownerUserId: unknown,
	ownerScopeKey: unknown,
): Pick<
	NativeLoginRequest,
	"computeIdentityOwnershipKind" | "computeIdentityOwnerUserId" | "computeIdentityOwnerScopeKey"
> {
	if (kind !== "member" && kind !== "company" && kind !== "department" && kind !== "security_boundary") {
		throw new Error("Native login ownership is invalid");
	}
	const userId = nullableUuid(ownerUserId, "Native login owner user id");
	const scopeKey = nullableText(ownerScopeKey, "Native login owner scope", 160);
	if (
		(kind === "member" && (!userId || scopeKey)) ||
		(kind === "company" && (userId || scopeKey)) ||
		((kind === "department" || kind === "security_boundary") && (userId || !scopeKey))
	) {
		throw new Error("Native login ownership is inconsistent");
	}
	return {
		computeIdentityOwnershipKind: kind,
		...(userId ? { computeIdentityOwnerUserId: userId } : {}),
		...(scopeKey ? { computeIdentityOwnerScopeKey: scopeKey } : {}),
	};
}

function tokenMatches(expected: string, received: string): boolean {
	const left = Buffer.from(expected, "utf-8");
	const right = Buffer.from(received, "utf-8");
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function bearer(request: Request): string {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) throw new Error("Native login capability is missing");
	const capability = authorization.slice("Bearer ".length);
	if (!TOKEN_PATTERN.test(capability)) throw new Error("Native login capability is invalid");
	return capability;
}

function parseLogin(encoded: string, capability: string): NativeLoginRequest {
	const input = record(JSON.parse(encoded) as unknown, "Native login request");
	exactKeys(
		input,
		[
			"schema",
			"login_id",
			"client_connection_id",
			"compute_identity_id",
			"compute_identity_ownership_kind",
			"compute_identity_owner_user_id",
			"compute_identity_owner_scope_key",
			"provider",
			"native_harness",
			"login_capability",
			"expires_at",
		],
		"Native login request",
	);
	if (input.schema !== LOGIN_SCHEMA || typeof input.login_capability !== "string") {
		throw new Error("Native login schema is invalid");
	}
	if (!TOKEN_PATTERN.test(input.login_capability) || !tokenMatches(capability, input.login_capability)) {
		throw new Error("Native login capability is inconsistent");
	}
	const expiresAt = new Date(text(input.expires_at, "Native login expiry", 64)).toISOString();
	if (Date.parse(expiresAt) <= Date.now()) throw new Error("Native login capability is expired");
	return {
		loginId: uuid(input.login_id, "Native login id"),
		clientConnectionId: uuid(input.client_connection_id, "Native login client connection id"),
		computeIdentityId: uuid(input.compute_identity_id, "Native login Compute Identity id"),
		...ownership(
			input.compute_identity_ownership_kind,
			input.compute_identity_owner_user_id,
			input.compute_identity_owner_scope_key,
		),
		provider: provider(input.provider),
		nativeHarness: harness(input.native_harness),
		capability,
		expiresAt,
		encoded,
	};
}

function description(value: unknown): NativeLoginDescription {
	const input = record(value, "Native login description");
	exactKeys(
		input,
		[
			"login_id",
			"profile_id",
			"client_connection_id",
			"compute_identity_id",
			"compute_identity_ownership_kind",
			"compute_identity_owner_user_id",
			"compute_identity_owner_scope_key",
			"provider",
			"native_harness",
			"expires_at",
			"status",
		],
		"Native login description",
	);
	if (input.status !== "pending" && input.status !== "completed") {
		throw new Error("Native login status is invalid");
	}
	return {
		loginId: uuid(input.login_id, "Native login id"),
		profileId: uuid(input.profile_id, "Native login profile id"),
		clientConnectionId: uuid(input.client_connection_id, "Native login client connection id"),
		computeIdentityId: uuid(input.compute_identity_id, "Native login Compute Identity id"),
		...ownership(
			input.compute_identity_ownership_kind,
			input.compute_identity_owner_user_id,
			input.compute_identity_owner_scope_key,
		),
		provider: provider(input.provider),
		nativeHarness: harness(input.native_harness),
		expiresAt: new Date(text(input.expires_at, "Native login expiry", 64)).toISOString(),
		status: input.status,
	};
}

function sameLogin(request: NativeLoginRequest, authority: NativeLoginDescription): boolean {
	return (
		request.loginId === authority.loginId &&
		request.clientConnectionId === authority.clientConnectionId &&
		request.computeIdentityId === authority.computeIdentityId &&
		request.computeIdentityOwnershipKind === authority.computeIdentityOwnershipKind &&
		request.computeIdentityOwnerUserId === authority.computeIdentityOwnerUserId &&
		request.computeIdentityOwnerScopeKey === authority.computeIdentityOwnerScopeKey &&
		request.provider === authority.provider &&
		request.nativeHarness === authority.nativeHarness &&
		Date.parse(request.expiresAt) === Date.parse(authority.expiresAt)
	);
}

function supabaseHeaders(serviceKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: serviceKey };
	if (serviceKey.startsWith("eyJ") && serviceKey.split(".").length === 3) {
		headers.authorization = `Bearer ${serviceKey}`;
	}
	return headers;
}

function json(value: unknown, status: number): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function bootstrapSha256(files: readonly LoginBootstrapFile[]): string {
	return sha256(
		JSON.stringify(
			files.map((file) => ({ path: file.path, contentSha256: sha256(file.content), mode: "0600", uid: 0, gid: 0 })),
		),
	);
}

function ipv4(state: LxdInstanceStateRecord, networkInterface: string): string | undefined {
	return state.network[networkInterface]?.addresses.find(
		(address) => address.family === "inet" && address.scope === "global" && !address.address.startsWith("169.254."),
	)?.address;
}

function parseResult(value: unknown, loginId: string): NativeLoginResult {
	const input = record(value, "Native login result");
	exactKeys(input, ["schema", "login_id", "status", "interaction_url", "user_code"], "Native login result");
	if (
		input.schema !== LOGIN_RESULT_SCHEMA ||
		input.login_id !== loginId ||
		(input.status !== "awaiting_member" && input.status !== "completed")
	) {
		throw new Error("Native login result crossed its authority boundary");
	}
	let interactionUrl: string | null = null;
	if (input.interaction_url !== null && input.interaction_url !== undefined) {
		const parsed = new URL(text(input.interaction_url, "Native login interaction URL", 4096));
		if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
			throw new Error("Native login interaction URL is invalid");
		}
		interactionUrl = parsed.href;
	}
	const userCode =
		input.user_code === null || input.user_code === undefined
			? null
			: text(input.user_code, "Native login user code", 128);
	return {
		schema: LOGIN_RESULT_SCHEMA,
		login_id: loginId,
		status: input.status,
		interaction_url: interactionUrl,
		user_code: userCode,
	};
}

function validateConfig(config: LxdNativeLoginGatewayConfig): void {
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(config.adapterId)) throw new Error("Provider adapter id is invalid");
	if (!isAbsolute(config.stateRoot)) throw new Error("LXD login state root must be absolute");
	for (const [label, value] of [
		["LXD project", config.project],
		["LXD login profile", config.loginProfile],
		["LXD network interface", config.networkInterface],
		["LXD storage pool", config.storagePool],
	] as const) {
		if (!PROFILE_PATTERN.test(value)) throw new Error(`${label} is invalid`);
	}
	if (
		config.imageServer !== "local" &&
		(!/^https:\/\//.test(config.imageServer) || /[\0\r\n]/.test(config.imageServer))
	) {
		throw new Error("LXD image source must be local or use HTTPS");
	}
	if (!SHA256_PATTERN.test(config.imageFingerprint)) throw new Error("LXD image fingerprint is invalid");
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.identityVolumePrefix)) {
		throw new Error("LXD identity-volume prefix is invalid");
	}
	if (
		!STORAGE_SIZE_PATTERN.test(config.identityVolumeSize) ||
		!STORAGE_SIZE_PATTERN.test(config.rootDiskSize) ||
		!STORAGE_SIZE_PATTERN.test(config.memoryLimit)
	) {
		throw new Error("LXD login storage or memory limit is invalid");
	}
	if (!Number.isSafeInteger(config.cpuLimit) || config.cpuLimit < 1 || config.cpuLimit > 256) {
		throw new Error("LXD login CPU limit is invalid");
	}
	if (
		!Number.isSafeInteger(config.nativeBridgePort) ||
		config.nativeBridgePort < 1024 ||
		config.nativeBridgePort > 65_535 ||
		isIP(config.guestTrustedSource) !== 4
	) {
		throw new Error("LXD login guest network boundary is invalid");
	}
	if (
		!SHA256_PATTERN.test(config.identityRecoveryCaSha256) ||
		Buffer.byteLength(config.identityRecoveryCaCertificate) < 1 ||
		Buffer.byteLength(config.identityRecoveryCaCertificate) > 16 * 1024 ||
		sha256(config.identityRecoveryCaCertificate) !== config.identityRecoveryCaSha256
	) {
		throw new Error("LXD login recovery-authority CA is invalid");
	}
	let recoveryAuthorityCertificate: X509Certificate;
	try {
		recoveryAuthorityCertificate = new X509Certificate(config.identityRecoveryCaCertificate);
	} catch {
		throw new Error("LXD login recovery-authority CA certificate is invalid");
	}
	if (!recoveryAuthorityCertificate.ca) {
		throw new Error("LXD login recovery-authority CA certificate is not a certificate authority");
	}
	const readyTimeout = config.guestReadyTimeoutMs ?? 300_000;
	if (!Number.isSafeInteger(readyTimeout) || readyTimeout < 1_000 || readyTimeout > 900_000) {
		throw new Error("LXD login guest readiness timeout is invalid");
	}
	const url = new URL(config.supabaseUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!config.supabaseServiceKey.trim() ||
		/[\0\r\n]/.test(config.supabaseServiceKey) ||
		!config.codexPath.startsWith("/") ||
		!config.claudePath.startsWith("/")
	) {
		throw new Error("LXD login guest configuration is invalid");
	}
	const service = config.loginBootstrapService ?? "qorpera-lxd-native-login-bootstrap.service";
	if (!/^[A-Za-z0-9@_.-]+\.service$/.test(service)) throw new Error("LXD login bootstrap service is invalid");
}

export class LxdNativeLoginGateway {
	readonly #config: LxdNativeLoginGatewayConfig;
	readonly #lxd: LxdClient;
	readonly #fetch: typeof fetch;
	readonly #serial = new Map<string, Promise<void>>();

	constructor(config: LxdNativeLoginGatewayConfig, lxd: LxdClient, fetchImplementation: typeof fetch = fetch) {
		validateConfig(config);
		this.#config = { ...config, stateRoot: resolve(config.stateRoot) };
		this.#lxd = lxd;
		this.#fetch = fetchImplementation;
	}

	async handle(request: Request): Promise<Response> {
		if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true }, 200);
		if (request.method !== "POST" || new URL(request.url).pathname !== "/login") {
			return json({ error: "Not found" }, 404);
		}
		let login: NativeLoginRequest;
		try {
			const declared = Number(request.headers.get("content-length") ?? "0");
			if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
				return json({ error: "Native login request is too large" }, 413);
			}
			const encoded = await request.text();
			if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
				return json({ error: "Native login request is too large" }, 413);
			}
			login = parseLogin(encoded, bearer(request));
		} catch {
			return json({ error: "Invalid native login request" }, 400);
		}

		let authority: NativeLoginDescription;
		try {
			authority = await this.#describe(login, request.signal);
			if (!sameLogin(login, authority)) throw new Error("Native login request does not match durable authority");
		} catch {
			return json({ error: "Native login is unavailable" }, 403);
		}

		try {
			return await this.#exclusive(login.computeIdentityId, () =>
				this.#route(login, authority.status, request.signal),
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : "LXD native login route failed");
			return json({ error: "Native provider login is unavailable" }, 503);
		}
	}

	async #describe(login: NativeLoginRequest, signal?: AbortSignal): Promise<NativeLoginDescription> {
		const response = await this.#fetch(
			new URL("/rest/v1/rpc/qorpera_describe_native_provider_login_route", this.#config.supabaseUrl),
			{
				method: "POST",
				headers: { ...supabaseHeaders(this.#config.supabaseServiceKey), "content-type": "application/json" },
				body: JSON.stringify({
					p_login_id: login.loginId,
					p_capability_sha256: sha256(login.capability),
				}),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`Native login authority RPC failed (${response.status})`);
		return description(await response.json());
	}

	async #route(
		login: NativeLoginRequest,
		loginStatus: NativeLoginDescription["status"],
		signal?: AbortSignal,
	): Promise<Response> {
		let stage = "bridge-token";
		try {
			const bridgeToken = await this.#bridgeToken(login.computeIdentityId);
			const files = this.#bootstrapFiles(login.computeIdentityId, bridgeToken);
			const bootstrapDigest = bootstrapSha256(files);
			const instanceName = this.#instanceName(login.computeIdentityId);
			if (loginStatus === "completed") {
				stage = "instance-read";
				const completedInstance = await this.#lxd.getInstance(this.#config.project, instanceName, signal);
				if (completedInstance) {
					stage = "instance-authority";
					this.#assertInstanceAuthority(completedInstance, login.computeIdentityId, bootstrapDigest);
					if (completedInstance.status === "Running") {
						stage = "instance-stop";
						await this.#lxd.setInstancePower(this.#config.project, instanceName, "stop", signal);
					}
				}
				return json(
					{
						schema: LOGIN_RESULT_SCHEMA,
						login_id: login.loginId,
						status: "completed",
						interaction_url: null,
						user_code: null,
					},
					200,
				);
			}
			stage = "identity-volume";
			await this.#ensureIdentityVolume(login.computeIdentityId, signal);
			stage = "instance-read";
			let instance = await this.#lxd.getInstance(this.#config.project, instanceName, signal);
			if (!instance) {
				stage = "instance-create";
				await this.#lxd.createInstance(
					this.#config.project,
					this.#createRequest(login.computeIdentityId, bootstrapDigest),
					signal,
				);
				stage = "instance-reread";
				instance = await this.#lxd.getInstance(this.#config.project, instanceName, signal);
				if (!instance) throw new Error("LXD did not persist the native login guest");
			}
			stage = "instance-authority";
			this.#assertInstanceAuthority(instance, login.computeIdentityId, bootstrapDigest);
			if (instance.status !== "Running") {
				stage = "instance-start";
				await this.#lxd.setInstancePower(this.#config.project, instanceName, "start", signal);
			}
			stage = "guest-bootstrap";
			await this.#installBootstrap(instanceName, files, signal);
			stage = "guest-readiness";
			const address = await this.#waitReady(instanceName, signal);
			stage = "guest-forward";
			const result = await this.#forward(address, login, signal);
			if (result.status === "completed") {
				stage = "instance-stop";
				await this.#lxd.setInstancePower(this.#config.project, instanceName, "stop", signal);
			}
			return json(result, 200);
		} catch (error) {
			throw new Error(`LXD native login ${stage} stage failed`, { cause: error });
		}
	}

	async #ensureIdentityVolume(computeIdentityId: string, signal?: AbortSignal): Promise<void> {
		const name = `${this.#config.identityVolumePrefix}${computeIdentityId}`;
		let volume = await this.#lxd.getStorageVolume(this.#config.project, this.#config.storagePool, name, signal);
		if (!volume) {
			await this.#lxd.createStorageVolume(
				this.#config.project,
				this.#config.storagePool,
				{
					name,
					type: "custom",
					content_type: "filesystem",
					description: `Qorpera Compute Identity ${computeIdentityId}`,
					config: {
						size: this.#config.identityVolumeSize,
						"user.qorpera.schema": IDENTITY_VOLUME_SCHEMA,
						"user.qorpera.compute_identity_id": computeIdentityId,
						"user.qorpera.provider_adapter": this.#config.adapterId,
					},
				},
				signal,
			);
			volume = await this.#lxd.getStorageVolume(this.#config.project, this.#config.storagePool, name, signal);
		}
		if (!volume) throw new Error("LXD did not persist the Compute Identity volume");
		this.#assertIdentityVolumeAuthority(volume, computeIdentityId);
	}

	#assertIdentityVolumeAuthority(volume: LxdStorageVolumeRecord, computeIdentityId: string): void {
		if (
			volume.name !== `${this.#config.identityVolumePrefix}${computeIdentityId}` ||
			volume.type !== "custom" ||
			volume.contentType !== "filesystem" ||
			volume.config.size !== this.#config.identityVolumeSize ||
			volume.config["user.qorpera.schema"] !== IDENTITY_VOLUME_SCHEMA ||
			volume.config["user.qorpera.compute_identity_id"] !== computeIdentityId ||
			volume.config["user.qorpera.provider_adapter"] !== this.#config.adapterId
		) {
			throw new Error("LXD Compute Identity volume drifted from immutable login authority");
		}
	}

	#createRequest(computeIdentityId: string, bootstrapDigest: string): LxdCreateInstanceRequest {
		return {
			name: this.#instanceName(computeIdentityId),
			type: "virtual-machine",
			profiles: [this.#config.loginProfile],
			config: {
				"boot.mode": "uefi-secureboot",
				"limits.cpu": String(this.#config.cpuLimit),
				"limits.memory": this.#config.memoryLimit,
				"user.qorpera.schema": LOGIN_INSTANCE_SCHEMA,
				"user.qorpera.compute_identity_id": computeIdentityId,
				"user.qorpera.bootstrap_sha256": bootstrapDigest,
				"user.qorpera.image_fingerprint": this.#config.imageFingerprint,
			},
			devices: {
				root: {
					type: "disk",
					path: "/",
					pool: this.#config.storagePool,
					size: this.#config.rootDiskSize,
				},
				"compute-identity": {
					type: "disk",
					path: "/var/lib/qorpera/identity",
					pool: this.#config.storagePool,
					source: `${this.#config.identityVolumePrefix}${computeIdentityId}`,
				},
			},
			source:
				this.#config.imageServer === "local"
					? { type: "image", fingerprint: this.#config.imageFingerprint }
					: {
							type: "image",
							mode: "pull",
							protocol: "simplestreams",
							server: this.#config.imageServer,
							fingerprint: this.#config.imageFingerprint,
						},
		};
	}

	#assertInstanceAuthority(instance: LxdInstanceRecord, computeIdentityId: string, bootstrapDigest: string): void {
		const root = instance.devices.root;
		const identity = instance.devices["compute-identity"];
		if (
			instance.name !== this.#instanceName(computeIdentityId) ||
			instance.type !== "virtual-machine" ||
			JSON.stringify(instance.profiles) !== JSON.stringify([this.#config.loginProfile]) ||
			instance.config["boot.mode"] !== "uefi-secureboot" ||
			instance.config["limits.cpu"] !== String(this.#config.cpuLimit) ||
			instance.config["limits.memory"] !== this.#config.memoryLimit ||
			instance.config["cloud-init.user-data"] !== undefined ||
			instance.config["user.qorpera.schema"] !== LOGIN_INSTANCE_SCHEMA ||
			instance.config["user.qorpera.compute_identity_id"] !== computeIdentityId ||
			instance.config["user.qorpera.bootstrap_sha256"] !== bootstrapDigest ||
			instance.config["user.qorpera.image_fingerprint"] !== this.#config.imageFingerprint ||
			root?.type !== "disk" ||
			root.path !== "/" ||
			root.pool !== this.#config.storagePool ||
			root.size !== this.#config.rootDiskSize ||
			identity?.type !== "disk" ||
			identity.path !== "/var/lib/qorpera/identity" ||
			identity.pool !== this.#config.storagePool ||
			identity.source !== `${this.#config.identityVolumePrefix}${computeIdentityId}`
		) {
			throw new Error("LXD native login guest drifted from immutable authority");
		}
	}

	#bootstrapFiles(computeIdentityId: string, bridgeToken: string): LoginBootstrapFile[] {
		const bootstrap = JSON.stringify(
			{
				schema: "qorpera.lxd-native-login-bootstrap/v1",
				compute_identity_id: computeIdentityId,
				supabase_url: new URL(this.#config.supabaseUrl).origin,
				native_bridge_url: `http://127.0.0.1:${this.#config.nativeBridgePort}/`,
				trusted_source: this.#config.guestTrustedSource,
				identity_recovery_ca_sha256: this.#config.identityRecoveryCaSha256,
				native_provider_environment_path: "/var/lib/qorpera-bootstrap/native-provider.env",
				credential_source: "/var/lib/qorpera-bootstrap/credentials",
				identity_volume_path: "/var/lib/qorpera/identity",
			},
			null,
			2,
		);
		const environment = [
			`QORPERA_SUPABASE_URL=${new URL(this.#config.supabaseUrl).origin}`,
			"QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine",
			`QORPERA_NATIVE_PROVIDER_COMPUTE_IDENTITY_ID=${computeIdentityId}`,
			"QORPERA_NATIVE_PROVIDER_HOST=0.0.0.0",
			`QORPERA_NATIVE_PROVIDER_TRUSTED_SOURCE=${this.#config.guestTrustedSource}`,
			`QORPERA_NATIVE_PROVIDER_PORT=${this.#config.nativeBridgePort}`,
			"QORPERA_NATIVE_PROVIDER_TEMPORARY_ROOT=/var/lib/qorpera-native-provider/tmp",
			`QORPERA_CODEX_PATH=${this.#config.codexPath}`,
			`QORPERA_CLAUDE_PATH=${this.#config.claudePath}`,
			"",
		].join("\n");
		return [
			{ path: "/var/lib/qorpera-bootstrap/login-bootstrap.json", content: `${bootstrap}\n` },
			{ path: "/var/lib/qorpera-bootstrap/native-provider.env", content: environment },
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-identity-recovery-ca",
				content: this.#config.identityRecoveryCaCertificate,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-native-bridge",
				content: `${bridgeToken}\n`,
			},
			{
				path: "/var/lib/qorpera-bootstrap/credentials/qorpera-supabase-service-key",
				content: `${this.#config.supabaseServiceKey}\n`,
			},
		];
	}

	async #installBootstrap(instanceName: string, files: readonly LoginBootstrapFile[], signal?: AbortSignal) {
		try {
			await this.#waitForGuestAgent(instanceName, signal);
		} catch (error) {
			console.error("LXD native login bootstrap guest-agent probe failed");
			throw error;
		}
		for (const [index, file] of files.entries()) {
			try {
				await this.#lxd.pushInstanceFile(
					this.#config.project,
					instanceName,
					file.path,
					file.content,
					0o600,
					signal,
				);
			} catch (error) {
				console.error(`LXD native login bootstrap file ${index + 1} write failed`);
				throw error;
			}
		}
		try {
			await this.#lxd.execInstance(
				this.#config.project,
				instanceName,
				[
					"/usr/bin/systemctl",
					"restart",
					this.#config.loginBootstrapService ?? "qorpera-lxd-native-login-bootstrap.service",
				],
				signal,
			);
		} catch (error) {
			console.error(
				`LXD native login bootstrap service restart failed (${signal?.aborted ? "request-cancelled" : "request-active"}; ${error instanceof Error ? error.message : "unknown error"})`,
			);
			throw error;
		}
	}

	async #waitForGuestAgent(instanceName: string, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + (this.#config.guestReadyTimeoutMs ?? 300_000);
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			try {
				await this.#lxd.execInstance(
					this.#config.project,
					instanceName,
					["/usr/bin/test", "-d", "/var/lib/qorpera-bootstrap/credentials"],
					signal,
				);
				return;
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		throw new Error("LXD native login guest agent did not become ready", { cause: lastError });
	}

	async #waitReady(instanceName: string, signal?: AbortSignal): Promise<string> {
		const deadline = Date.now() + (this.#config.guestReadyTimeoutMs ?? 300_000);
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			try {
				const state = await this.#lxd.getInstanceState(this.#config.project, instanceName, signal);
				const address = ipv4(state, this.#config.networkInterface);
				if (state.status === "Running" && address) {
					const response = await this.#fetch(`http://${address}:${this.#config.nativeBridgePort}/healthz`, {
						signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000),
					});
					if (response.ok) return address;
				}
			} catch (error) {
				if (signal?.aborted) throw signal.reason;
				if (!(error instanceof Error)) throw error;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 250));
		}
		throw new Error("LXD native login guest did not activate its private listener");
	}

	async #forward(address: string, login: NativeLoginRequest, signal?: AbortSignal): Promise<NativeLoginResult> {
		const response = await this.#fetch(`http://${address}:${this.#config.nativeBridgePort}/login`, {
			method: "POST",
			headers: { authorization: `Bearer ${login.capability}`, "content-type": "application/json" },
			body: login.encoded,
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
		});
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
			throw new Error("Native login response is too large");
		}
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw new Error("Native login response is too large");
		if (!response.ok) throw new Error(`Native login guest rejected the request (${response.status})`);
		return parseResult(JSON.parse(encoded) as unknown, login.loginId);
	}

	async #bridgeToken(computeIdentityId: string): Promise<string> {
		const root = join(this.#config.stateRoot, computeIdentityId);
		await mkdir(root, { recursive: true, mode: 0o700 });
		await chmod(root, 0o700);
		const path = join(root, "qorpera-native-bridge");
		try {
			const existing = (await readFile(path, "utf-8")).trim();
			if (!TOKEN_PATTERN.test(existing)) throw new Error("Stored native login bridge token is invalid");
			return existing;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			const value = randomBytes(32).toString("base64url");
			await writeFile(path, `${value}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
			return value;
		}
	}

	#instanceName(computeIdentityId: string): string {
		return `qorpera-login-${computeIdentityId.replaceAll("-", "")}`;
	}

	async #exclusive<T>(computeIdentityId: string, action: () => Promise<T>): Promise<T> {
		const previous = this.#serial.get(computeIdentityId) ?? Promise.resolve();
		let release = (): void => undefined;
		const current = new Promise<void>((resolveWait) => {
			release = resolveWait;
		});
		this.#serial.set(computeIdentityId, current);
		await previous;
		try {
			return await action();
		} finally {
			release();
			if (this.#serial.get(computeIdentityId) === current) this.#serial.delete(computeIdentityId);
		}
	}
}

export class HttpLxdNativeLoginGateway {
	readonly #gateway: LxdNativeLoginGateway;
	readonly #host: string;
	readonly #port: number;
	#server?: Server;

	constructor(gateway: LxdNativeLoginGateway, host = "127.0.0.1", port = 0) {
		if (host !== "127.0.0.1") throw new Error("Native login gateway must bind to IPv4 loopback");
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
			throw new Error("Native login gateway port is invalid");
		this.#gateway = gateway;
		this.#host = host;
		this.#port = port;
	}

	async start(): Promise<number> {
		if (this.#server) throw new Error("Native login gateway is already started");
		const server = createServer((request, response) => void this.#handle(request, response));
		this.#server = server;
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(this.#port, this.#host, () => {
				server.off("error", reject);
				resolveListen();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Native login gateway address is unavailable");
		return address.port;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const controller = new AbortController();
		const abort = (): void => controller.abort(new Error("Native login gateway request disconnected"));
		request.once("aborted", abort);
		response.once("close", abort);
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) break;
			}
			const headers = new Headers();
			for (const [name, rawValue] of Object.entries(request.headers)) {
				if (typeof rawValue === "string") headers.set(name, rawValue);
				else if (rawValue) for (const value of rawValue) headers.append(name, value);
			}
			const result = await this.#gateway.handle(
				new Request(`http://${this.#host}${request.url ?? "/"}`, {
					method: request.method ?? "GET",
					headers,
					...(request.method === "GET" || request.method === "HEAD" ? {} : { body: encoded }),
					signal: controller.signal,
				}),
			);
			response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
			response.end(Buffer.from(await result.arrayBuffer()));
		} catch {
			if (!controller.signal.aborted) {
				response.writeHead(503, { "cache-control": "no-store", "content-type": "application/json" });
				response.end('{"error":"Native provider login is unavailable"}\n');
			}
		} finally {
			request.off("aborted", abort);
			response.off("close", abort);
		}
	}
}
