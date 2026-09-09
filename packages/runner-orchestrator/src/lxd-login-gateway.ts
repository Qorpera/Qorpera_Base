import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Headers as NodeHttpHeaders,
	Request as NodeHttpRequest,
	Response as NodeHttpResponse,
} from "@whatwg-node/node-fetch";
import type { ServiceHttpFetch, ServiceHttpRequest, ServiceHttpResponse } from "./http-transport.ts";
import type {
	LxdClient,
	LxdInstanceRecord,
	LxdInstanceStateRecord,
	LxdStorageVolumeRecord,
	LxdTrackedClient,
} from "./lxd-client.ts";
import { LxdLoginJournal } from "./lxd-login-journal.ts";
import { LOGIN_UUID, type LxdLoginBinding, lxdLoginNodePolicy, lxdLoginPlan } from "./lxd-login-plan.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { reserveRuntimeNodeMachine } from "./runtime-node-admission.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";

const LOGIN_SCHEMA = "qorpera.native-provider-login/v1";
const LOGIN_RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
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

function bearer(request: ServiceHttpRequest): string {
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

function json(value: unknown, status: number): ServiceHttpResponse {
	return NodeHttpResponse.json(value, { status, headers: { "cache-control": "no-store" } });
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
	readonly #lxd: LxdClient & Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">;
	readonly #fetch: ServiceHttpFetch;
	readonly #serial = new Map<string, Promise<void>>();

	constructor(
		config: LxdNativeLoginGatewayConfig,
		lxd: LxdClient & Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
		fetchImplementation: ServiceHttpFetch = fetch,
	) {
		validateConfig(config);
		this.#config = { ...config, stateRoot: resolve(config.stateRoot) };
		this.#lxd = lxd;
		this.#fetch = fetchImplementation;
	}

	async handle(request: ServiceHttpRequest): Promise<ServiceHttpResponse> {
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
			return await this.#exclusive(login.computeIdentityId, () => this.#route(login, authority, request.signal));
		} catch (error) {
			console.error(error instanceof Error ? error.message : "LXD native login route failed");
			return json({ error: "Native provider login is unavailable" }, 503);
		}
	}

	async #describe(login: NativeLoginRequest, signal?: AbortSignal): Promise<NativeLoginDescription> {
		return description(
			await this.#rpc(
				"qorpera_describe_native_provider_login_route",
				{
					p_login_id: login.loginId,
					p_capability_sha256: sha256(login.capability),
				},
				signal ?? new AbortController().signal,
			),
		);
	}

	async #route(
		login: NativeLoginRequest,
		authority: NativeLoginDescription,
		signal: AbortSignal,
	): Promise<ServiceHttpResponse> {
		await this.#prepareRoot();
		let journal: LxdLoginJournal;
		try {
			journal = await LxdLoginJournal.open(this.#config.stateRoot, login.loginId, this.#lxd);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
			const retained = await lstat(join(this.#config.stateRoot, login.loginId)).catch((error) => {
				if (!code(error, "ENOENT")) throw error;
				return undefined;
			});
			if (retained) throw new Error("LOGIN_JOURNAL_UNCONFIRMED");
			if (authority.status === "completed") return this.#completed(login.loginId);
			// Legacy identity-keyed VMs have no trustworthy physical allocation.
			// Preserve them and refuse another attachment until explicitly reconciled.
			if (
				await this.#lxd.getInstance(
					this.#config.project,
					`qorpera-login-${login.computeIdentityId.replaceAll("-", "")}`,
					signal,
				)
			)
				throw new Error("LOGIN_LEGACY_INSTANCE_UNRECONCILED");
			const host = await readRuntimeNodeHost(signal);
			const bridge = await this.#bridgeToken(login.loginId);
			journal = await LxdLoginJournal.open(this.#config.stateRoot, login.loginId, this.#lxd, {
				schema: "qorpera.lxd-login-allocation/v1",
				allocationId: randomUUID(),
				loginId: login.loginId,
				profileId: authority.profileId,
				computeIdentityId: login.computeIdentityId,
				capabilitySha256: sha256(login.capability),
				bootstrapSha256: bootstrapSha256(this.#bootstrapFiles(login.computeIdentityId, bridge)),
				policy: lxdLoginNodePolicy(this.#config, host.machineIdSha256).policy,
			});
		}
		const binding = journal.binding,
			plan = lxdLoginPlan(binding);
		if (
			binding.loginId !== login.loginId ||
			binding.profileId !== authority.profileId ||
			binding.computeIdentityId !== login.computeIdentityId ||
			binding.capabilitySha256 !== sha256(login.capability)
		)
			throw new Error("LOGIN_JOURNAL_BINDING_CONFLICT");
		if (authority.status === "completed" || (await journal.state()).closing) {
			await this.#cleanup(journal, signal);
			if (authority.status === "completed") return this.#completed(login.loginId);
			throw new Error("LOGIN_ALLOCATION_CLOSED");
		}
		const bridge = await this.#bridgeToken(login.loginId, true);
		const files = this.#bootstrapFiles(login.computeIdentityId, bridge);
		if (bootstrapSha256(files) !== binding.bootstrapSha256) throw new Error("LOGIN_BOOTSTRAP_CHANGED");
		// Registration precedes identity storage; each physical dispatch has an
		// additional fresh gate after any intervening storage/inspection work.
		await this.#admit(journal, signal);
		await this.#ensureIdentityVolume(login.computeIdentityId, signal);
		let instance = await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal);
		const created = await journal.observe("create", signal);
		if (created.state === "not_dispatched") {
			if (instance) throw new Error("LOGIN_INSTANCE_WITHOUT_CREATION_HISTORY");
			await this.#operation(journal, "create", signal, () => this.#admit(journal, signal));
		} else if (created.state !== "succeeded") await this.#operation(journal, "create", signal);
		instance = await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal);
		if (!instance) throw new Error("LOGIN_INSTANCE_MISSING");
		this.#assertInstanceAuthority(instance, binding);
		const started = await journal.observe("start", signal);
		if (started.state === "not_dispatched") {
			if (instance.status !== "Stopped") throw new Error("LOGIN_INSTANCE_WITHOUT_BOOT_HISTORY");
			await this.#operation(journal, "start", signal, () => this.#admit(journal, signal));
		} else if (started.state !== "succeeded") await this.#operation(journal, "start", signal);
		instance = await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal);
		if (!instance || instance.status !== "Running" || (await journal.state()).closing)
			throw new Error("LOGIN_INSTANCE_NOT_RUNNING");
		this.#assertInstanceAuthority(instance, binding);
		await this.#installBootstrap(plan.request.name, files, signal);
		const address = await this.#waitReady(plan.request.name, signal);
		const result = await this.#forward(address, login, signal);
		if (result.status === "completed") await this.#cleanup(journal, signal);
		return json(result, 200);
	}

	#completed(loginId: string): ServiceHttpResponse {
		return json(
			{
				schema: LOGIN_RESULT_SCHEMA,
				login_id: loginId,
				status: "completed",
				interaction_url: null,
				user_code: null,
			},
			200,
		);
	}
	async #prepareRoot(): Promise<void> {
		await mkdir(this.#config.stateRoot, { recursive: true, mode: 0o700 });
		await checkDirectory(this.#config.stateRoot);
	}
	#machineIdentity(binding: LxdLoginBinding): Record<string, string> {
		return {
			p_allocation_id: binding.allocationId,
			p_provider_adapter: binding.policy.providerId,
			p_instance_sha256: lxdLoginPlan(binding).instanceSha256,
		};
	}
	async #rpc(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		const response = await this.#fetch(new URL(`/rest/v1/rpc/${method}`, this.#config.supabaseUrl), {
			method: "POST",
			redirect: "error",
			headers: { ...supabaseHeaders(this.#config.supabaseServiceKey), "content-type": "application/json" },
			body: JSON.stringify(args),
			signal: checked,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("LOGIN_REGISTRY_UNCONFIRMED");
		}
		const value = await response.text();
		checked.throwIfAborted();
		if (Buffer.byteLength(value) > MAX_RESPONSE_BYTES) throw new Error("LOGIN_REGISTRY_UNCONFIRMED");
		return JSON.parse(value) as unknown;
	}
	async #admit(journal: LxdLoginJournal, signal: AbortSignal): Promise<AbortSignal> {
		const binding = journal.binding,
			plan = lxdLoginPlan(binding);
		if ((await journal.state()).closing) throw new Error("LOGIN_ALLOCATION_CLOSED");
		const host = await readRuntimeNodeHost(signal);
		if (!isDeepStrictEqual(lxdLoginNodePolicy(this.#config, host.machineIdSha256).policy, binding.policy))
			throw new Error("LOGIN_PHYSICAL_POLICY_CHANGED");
		const result = await this.#rpc(
			"qorpera_reserve_runtime_login_machine",
			{
				...this.#machineIdentity(binding),
				p_login_id: binding.loginId,
				p_capability_sha256: binding.capabilitySha256,
			},
			signal,
		);
		if (
			!isDeepStrictEqual(result, {
				state: "reserved",
				allocationId: binding.allocationId,
				instanceSha256: plan.instanceSha256,
			})
		)
			throw new Error("LOGIN_COMPANY_ADMISSION_REFUSED");
		const admission = await reserveRuntimeNodeMachine(
			{
				allocationId: binding.allocationId,
				providerKind: "login",
				providerId: binding.policy.providerId,
				policySha256: plan.policySha256,
				instanceSha256: plan.instanceSha256,
				machineIdSha256: host.machineIdSha256,
				cpuMillis: plan.cpuMillis,
				memoryBytes: plan.memoryBytes,
			},
			{ call: (method, args, checked) => this.#rpc(method, args, checked) },
			signal,
		);
		if (admission.state === "refused") throw new Error(admission.reason);
		await journal.place(admission.nodeId);
		admission.signal.throwIfAborted();
		return admission.signal;
	}
	async #operation(
		journal: LxdLoginJournal,
		action: "create" | "start" | "stop" | "delete",
		signal: AbortSignal,
		authorize?: () => Promise<AbortSignal>,
	): Promise<void> {
		let result = await journal.run(action, signal, authorize);
		while (result.state === "pending") {
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
			signal.throwIfAborted();
			result = await journal.observe(action, signal);
		}
		if (result.state !== "succeeded") throw new Error("LOGIN_PHYSICAL_OPERATION_UNCONFIRMED");
	}
	async #machineDescription(binding: LxdLoginBinding, signal: AbortSignal) {
		const value = record(
			await this.#rpc("qorpera_describe_runtime_login_machine", this.#machineIdentity(binding), signal),
			"Login machine description",
		);
		if (
			Object.keys(value).sort().join() !==
				"allocationId,cleanupRequired,computeIdentityId,expiresAt,loginId,profileId,releasedAt,status" ||
			value.allocationId !== binding.allocationId ||
			value.loginId !== binding.loginId ||
			value.profileId !== binding.profileId ||
			value.computeIdentityId !== binding.computeIdentityId ||
			typeof value.cleanupRequired !== "boolean" ||
			!["pending", "completed", "cancelled", "expired"].includes(String(value.status)) ||
			typeof value.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(value.expiresAt)) ||
			(value.releasedAt !== null &&
				(typeof value.releasedAt !== "string" || !Number.isFinite(Date.parse(value.releasedAt))))
		)
			throw new Error("LOGIN_DESCRIPTION_UNCONFIRMED");
		return value as typeof value & { cleanupRequired: boolean; releasedAt: string | null };
	}
	async #cleanup(journal: LxdLoginJournal, signal: AbortSignal): Promise<void> {
		if ((await journal.state()).releasedAt) return;
		if (!(await journal.close(signal))) throw new Error("LOGIN_CLEANUP_AWAITS_PHYSICAL_OPERATION");
		for (const action of ["stop", "delete"] as const) {
			const outcome = await journal.observe(action, signal);
			if (outcome.state === "pending") await this.#operation(journal, action, signal);
			else if (outcome.state === "unknown") throw new Error("LOGIN_CLEANUP_AWAITS_PHYSICAL_OPERATION");
		}
		const binding = journal.binding,
			plan = lxdLoginPlan(binding);
		let instance = await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal);
		if (instance) {
			if (!(await journal.state()).operations.create) throw new Error("LOGIN_INSTANCE_WITHOUT_CREATION_HISTORY");
			this.#assertInstanceAuthority(instance, binding);
			if (instance.status === "Running") await this.#operation(journal, "stop", signal);
			instance = await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal);
			if (instance) {
				this.#assertInstanceAuthority(instance, binding);
				if (instance.status !== "Stopped") throw new Error("LOGIN_STOP_UNCONFIRMED");
				await this.#operation(journal, "delete", signal);
			}
		}
		// A cleanup from another process may still have accepted stop/delete IO.
		for (const action of ["stop", "delete"] as const) {
			const outcome = await journal.observe(action, signal);
			if (outcome.state !== "not_dispatched" && outcome.state !== "succeeded" && outcome.state !== "failed")
				throw new Error("LOGIN_CLEANUP_AWAITS_PHYSICAL_OPERATION");
		}
		if (await this.#lxd.getInstance(binding.policy.project, plan.request.name, signal))
			throw new Error("LOGIN_DELETION_UNCONFIRMED");
		const result = await this.#rpc(
			"qorpera_release_runtime_login_machine",
			{ ...this.#machineIdentity(binding), p_login_id: binding.loginId },
			signal,
		);
		if (
			!isDeepStrictEqual(result, {
				state: "released",
				allocationId: binding.allocationId,
				instanceSha256: plan.instanceSha256,
			})
		)
			throw new Error("LOGIN_RELEASE_UNCONFIRMED");
		const description = await this.#machineDescription(binding, signal);
		if (!description.cleanupRequired || !description.releasedAt) throw new Error("LOGIN_RELEASE_UNCONFIRMED");
		await journal.release(description.releasedAt);
	}
	/** Bounded scan owned by the headless service, independent of member polls.
	 * Revoked/expired/completed logins retain capacity until exact VM deletion.
	 * One corrupt or uncertain allocation does not prevent other cleanup. */
	async reconcile(signal: AbortSignal): Promise<{ scanned: number; unconfirmed: number }> {
		await this.#prepareRoot();
		let scanned = 0,
			unconfirmed = 0;
		for (const name of (await readdir(this.#config.stateRoot)).sort()) {
			signal.throwIfAborted();
			if (!LOGIN_UUID.test(name)) {
				unconfirmed++;
				continue;
			}
			scanned++;
			try {
				const journal = await LxdLoginJournal.open(this.#config.stateRoot, name, this.#lxd);
				await this.#exclusive(journal.binding.computeIdentityId, async () => {
					const state = await journal.state();
					if (state.releasedAt) return;
					const description = await this.#machineDescription(journal.binding, signal);
					if (state.closing || description.cleanupRequired) await this.#cleanup(journal, signal);
				});
			} catch {
				signal.throwIfAborted();
				unconfirmed++;
			}
		}
		return { scanned, unconfirmed };
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

	#assertInstanceAuthority(instance: LxdInstanceRecord, binding: LxdLoginBinding): void {
		const { request } = lxdLoginPlan(binding);
		if (
			instance.name !== request.name ||
			instance.type !== request.type ||
			!isDeepStrictEqual(instance.profiles, request.profiles) ||
			!isDeepStrictEqual(instance.devices, request.devices) ||
			instance.config["cloud-init.user-data"] !== undefined ||
			Object.entries(request.config).some(([key, value]) => instance.config[key] !== value) ||
			["limits.cpu", "limits.memory", "boot.mode"].some(
				(key) => instance.expandedConfig?.[key] !== request.config[key],
			) ||
			Object.entries(request.devices).some(
				([key, value]) => !isDeepStrictEqual(instance.expandedDevices?.[key], value),
			) ||
			Object.entries(instance.expandedDevices).some(
				([key, value]) => !Object.hasOwn(request.devices, key) && value.type !== "nic",
			)
		)
			throw new Error("LOGIN_INSTANCE_AUTHORITY_CHANGED");
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
						redirect: "error",
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
			redirect: "error",
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

	async #bridgeToken(loginId: string, existing = false): Promise<string> {
		const root = join(this.#config.stateRoot, loginId);
		if (!existing) {
			try {
				await mkdir(root, { mode: 0o700 });
				await syncDirectory(this.#config.stateRoot);
			} catch (error) {
				if (!code(error, "EEXIST")) throw error;
			}
		}
		await checkDirectory(root);
		if (!existing)
			await publish(
				root,
				"bridge.json",
				Buffer.from(`${JSON.stringify({ token: randomBytes(32).toString("base64url") })}\n`),
			);
		const { value } = await readRecord(join(root, "bridge.json"));
		const input = record(value, "Login bridge token");
		if (Object.keys(input).join() !== "token" || typeof input.token !== "string" || !TOKEN_PATTERN.test(input.token))
			throw new Error("LOGIN_BRIDGE_UNCONFIRMED");
		return input.token;
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
	#cleanup?: Promise<void>;
	#shutdown?: AbortController;
	readonly #requests = new Set<AbortController>();

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
		const shutdown = new AbortController();
		this.#shutdown = shutdown;
		this.#cleanup = this.#reconcileLoop(shutdown.signal);
		return address.port;
	}

	async #reconcileLoop(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			try {
				const result = await this.#gateway.reconcile(AbortSignal.any([signal, AbortSignal.timeout(30000)]));
				if (result.unconfirmed)
					console.error(`Native login cleanup has ${result.unconfirmed} unconfirmed allocations`);
			} catch {
				if (!signal.aborted) console.error("Native login cleanup is unconfirmed");
			}
			if (!signal.aborted)
				await new Promise<void>((resolveWait) => {
					const done = () => {
						clearTimeout(timer);
						signal.removeEventListener("abort", done);
						resolveWait();
					};
					const timer = setTimeout(done, 5000);
					signal.addEventListener("abort", done, { once: true });
				});
		}
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		const closed = server
			? new Promise<void>((resolveClose, reject) =>
					server.close((error) => (error ? reject(error) : resolveClose())),
				)
			: Promise.resolve();
		this.#shutdown?.abort();
		for (const request of this.#requests) request.abort(new Error("Native login gateway is stopping"));
		server?.closeAllConnections();
		await Promise.all([this.#cleanup, closed]);
		this.#cleanup = undefined;
		this.#shutdown = undefined;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const controller = new AbortController();
		this.#requests.add(controller);
		const abort = (): void => controller.abort(new Error("Native login gateway request disconnected"));
		request.once("aborted", abort);
		response.once("close", abort);
		try {
			let encoded = "";
			for await (const chunk of request) {
				encoded += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
				if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) break;
			}
			const headers = new NodeHttpHeaders();
			for (const [name, rawValue] of Object.entries(request.headers)) {
				if (typeof rawValue === "string") headers.set(name, rawValue);
				else if (rawValue) for (const value of rawValue) headers.append(name, value);
			}
			const result = await this.#gateway.handle(
				new NodeHttpRequest(`http://${this.#host}${request.url ?? "/"}`, {
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
			this.#requests.delete(controller);
			request.off("aborted", abort);
			response.off("close", abort);
		}
	}
}
