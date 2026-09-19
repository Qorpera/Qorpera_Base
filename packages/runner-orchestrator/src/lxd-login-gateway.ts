import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA,
	parseNativeAccountRefreshDescription,
	parseNativeAccountRefreshRequest,
	parseNativeAccountRefreshResult,
} from "@qorpera/cloud-client/native-account-refresh";
import {
	Headers as NodeHttpHeaders,
	Request as NodeHttpRequest,
	Response as NodeHttpResponse,
} from "@whatwg-node/node-fetch";
import type { ServiceHttpFetch, ServiceHttpRequest, ServiceHttpResponse } from "./http-transport.ts";
import type {
	LxdClient,
	LxdInspectableClient,
	LxdInstanceRecord,
	LxdStorageVolumeRecord,
	LxdTrackedClient,
} from "./lxd-client.ts";
import { lxdGuestIpv4 } from "./lxd-guest-network.ts";
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
	purpose?: "account_refresh";
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

const RECOVERY_ROOT = "/var/lib/qorpera-recovery";
const RECOVERY_CREDENTIALS_DIRECTORY = `${RECOVERY_ROOT}/credentials`;
const RECOVERY_PUBLIC_KEY_PATH = `${RECOVERY_ROOT}/recipient-public-key`;
const RECOVERY_RESULT_PATH = `${RECOVERY_ROOT}/restore-result.json`;
const RECOVERY_MASTER_KEY_PATH = "/var/lib/qorpera/identity/qorpera-native-provider-master-key";
/** RSA-3072 recipient key generated inside the pinned guest; only the public half is read back. */
const RECOVERY_KEYGEN_SCRIPT = [
	"set -e; umask 077",
	`rm -rf ${RECOVERY_ROOT}; mkdir -p ${RECOVERY_CREDENTIALS_DIRECTORY}`,
	`cd ${RECOVERY_CREDENTIALS_DIRECTORY}`,
	`/usr/bin/node -e 'const c=require("node:crypto"),fs=require("node:fs");const {publicKey,privateKey}=c.generateKeyPairSync("rsa",{modulusLength:3072,publicExponent:65537});fs.writeFileSync("qorpera-recovery-recipient-key",privateKey.export({type:"pkcs8",format:"der"}).toString("base64url"),{mode:0o600});fs.writeFileSync("${RECOVERY_PUBLIC_KEY_PATH}",publicKey.export({type:"spki",format:"der"}).toString("base64url")+"\\n",{mode:0o600});'`,
].join("; ");
/** The restore client keeps the identity volume private and service-owned; the
 * login bootstrap makes the mount 0700 too, but it has not run yet here. */
const RECOVERY_RESTORE_SCRIPT = `set -e; umask 077; chmod 0700 /var/lib/qorpera/identity; CREDENTIALS_DIRECTORY=${RECOVERY_CREDENTIALS_DIRECTORY} /usr/bin/node /opt/qorpera-runner/qorpera-identity-recovery-restore.mjs > ${RECOVERY_RESULT_PATH}`;

function preparing(loginId: string) {
	return {
		schema: "qorpera.native-provider-login-result/v1",
		login_id: loginId,
		status: "preparing",
		interaction_url: null,
		user_code: null,
	};
}
async function withBudget<T>(
	work: Promise<T>,
	budgetMs: number,
): Promise<{ state: "fulfilled"; value: T } | { state: "rejected"; error: unknown } | { state: "pending" }> {
	let timer: NodeJS.Timeout | undefined;
	const pending = new Promise<{ state: "pending" }>((resolve) => {
		timer = setTimeout(() => resolve({ state: "pending" }), budgetMs);
	});
	try {
		return await Promise.race([
			work.then(
				(value) => ({ state: "fulfilled" as const, value }),
				(error: unknown) => ({ state: "rejected" as const, error }),
			),
			pending,
		]);
	} finally {
		clearTimeout(timer);
	}
}

function recoveryRuntimeState(value: unknown): {
	canInitialize: boolean;
	blocked: boolean;
	epoch: number | null;
	recoveryConfiguration: { authorityId: string; serviceOrigin: string; signingPublicKey: string } | null;
} {
	const r = record(value, "Identity recovery state");
	if (typeof r.canInitialize !== "boolean" || typeof r.blocked !== "boolean")
		throw new Error("Identity recovery state is invalid");
	const epoch = Number.isSafeInteger(r.epoch) ? (r.epoch as number) : null;
	let recoveryConfiguration: { authorityId: string; serviceOrigin: string; signingPublicKey: string } | null = null;
	if (r.recoveryConfiguration !== null && r.recoveryConfiguration !== undefined) {
		const c = record(r.recoveryConfiguration, "Identity recovery configuration");
		recoveryConfiguration = {
			authorityId: uuid(c.authorityId, "Identity recovery authority"),
			serviceOrigin: text(c.serviceOrigin, "Identity recovery service origin"),
			signingPublicKey: text(c.signingPublicKey, "Identity recovery signing key", 1024),
		};
		if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(recoveryConfiguration.serviceOrigin))
			throw new Error("Identity recovery service origin is invalid");
	}
	return { canInitialize: r.canInitialize, blocked: r.blocked, epoch, recoveryConfiguration };
}
function loginRecoveryRequest(value: unknown, targetId: string) {
	const r = record(value, "Login recovery");
	const epoch = r.epoch;
	if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) throw new Error("Login recovery epoch is invalid");
	if (r.targetId !== targetId) throw new Error("Login recovery target differs");
	return {
		recoveryId: uuid(r.recoveryId, "Login recovery id"),
		status: text(r.status, "Login recovery status", 32),
		epoch: epoch as number,
		notBefore:
			r.notBefore === null || r.notBefore === undefined
				? null
				: text(r.notBefore, "Login recovery quiet period", 64),
		backupSha256: text(r.backupSha256, "Login recovery backup", 64),
		authorityId: uuid(r.authorityId, "Login recovery authority"),
		serviceOrigin: text(r.serviceOrigin, "Login recovery service origin"),
		signingPublicKey: text(r.signingPublicKey, "Login recovery signing key", 1024),
	};
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
	/** 2026-09-17 amendment: node registrar for identity recovery targets (operator-enrolled capability) and the
	 * login image's guest manifest digest. Without both, an established identity on a fresh volume is refused. */
	identityRecoveryRegistrarCapability?: string;
	guestManifestSha256?: string;
	/** Bound on waiting for the recovery's quiet period before the restore (default 180 s). */
	recoveryWaitMs?: number;
	/** A member post that outlasts this budget answers `preparing` (default 20 s); the work continues. */
	/** How long a new sign-in waits for the member's replaced sign-in to give its machine back (default 120 s). */
	identityReleaseWaitMs?: number;
	loginPreparingAfterMs?: number;
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
		const refresh = new URL(request.url).pathname === "/account-refresh";
		if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true }, 200);
		if (request.method !== "POST" || (!refresh && new URL(request.url).pathname !== "/login")) {
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
			if (refresh) {
				const input = parseNativeAccountRefreshRequest(JSON.parse(encoded));
				if (!tokenMatches(input.capability, bearer(request))) throw new Error("Refresh capability mismatch");
				login = {
					purpose: "account_refresh",
					loginId: input.requestId,
					clientConnectionId: input.requestId,
					computeIdentityId: input.computeIdentityId,
					computeIdentityOwnershipKind: "member",
					computeIdentityOwnerUserId: input.requestedByUserId,
					provider: "openai",
					nativeHarness: "codex-cli",
					capability: input.capability,
					expiresAt: input.expiresAt,
					encoded,
				};
			} else login = parseLogin(encoded, bearer(request));
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

		// The login machine's boot or identity recovery outlives any single member
		// post (edge deadline 30 s): the route runs under the service lifetime,
		// a post that outlasts its budget answers `preparing`, and a later post of
		// the same login joins the running work or reads the guest's prompt.
		const budgetMs = this.#config.loginPreparingAfterMs ?? 20_000;
		const running = this.#routes.get(login.loginId);
		const settled = await (running
			? withBudget(running, budgetMs)
			: withBudget(this.#startRoute(login, authority), budgetMs));
		if (settled.state === "pending")
			return json(
				refresh
					? { schema: NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA, request_id: login.loginId, status: "preparing" }
					: preparing(login.loginId),
				200,
			);
		if (settled.state === "rejected") {
			console.error(settled.error instanceof Error ? settled.error.message : "LXD native login route failed");
			return json({ error: "Native provider login is unavailable" }, 503);
		}
		// Joined callers share the result, never a consumable response body. Reusing
		// this freshly completed route also keeps the post within one wait budget.
		return json(
			refresh
				? { schema: NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA, request_id: login.loginId, status: "completed" }
				: settled.value,
			200,
		);
	}

	readonly #routes = new Map<string, Promise<NativeLoginResult>>();
	#startRoute(login: NativeLoginRequest, authority: NativeLoginDescription): Promise<NativeLoginResult> {
		const work = this.#exclusive(login.computeIdentityId, () =>
			this.#route(login, authority, this.#lifetime.signal),
		).finally(() => {
			if (this.#routes.get(login.loginId) === work) this.#routes.delete(login.loginId);
		});
		this.#routes.set(login.loginId, work);
		return work;
	}

	async #describe(login: NativeLoginRequest, signal?: AbortSignal): Promise<NativeLoginDescription> {
		if (login.purpose === "account_refresh") {
			const value = parseNativeAccountRefreshDescription(
				await this.#rpc(
					"qorpera_describe_native_account_refresh_route",
					{
						p_request_id: login.loginId,
						p_capability_sha256: sha256(login.capability),
					},
					signal ?? this.#lifetime.signal,
				),
			);
			return {
				purpose: "account_refresh",
				loginId: value.requestId,
				clientConnectionId: value.requestId,
				profileId: value.profileId,
				computeIdentityId: value.computeIdentityId,
				computeIdentityOwnershipKind: "member",
				computeIdentityOwnerUserId: value.requestedByUserId,
				provider: "openai",
				nativeHarness: "codex-cli",
				expiresAt: value.expiresAt,
				status: value.status,
			};
		}
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
	): Promise<NativeLoginResult> {
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
				...(login.purpose ? { purpose: login.purpose } : {}),
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
			binding.purpose !== login.purpose ||
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
		// This route holds the identity's lock, so the reconcile loop cannot delete a
		// replaced sign-in's machine on this node meanwhile: do it here, first.
		await this.#releaseReplaced(login, signal);
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
		// 2026-09-17 amendment: an established identity on a node without its
		// volume is restored before the login bootstrap runs (no operator).
		await this.#recoveryFor(journal, binding, plan.request.name);
		signal.throwIfAborted();
		await this.#installBootstrap(plan.request.name, files, signal);
		const address = await this.#waitReady(instance, signal);
		const result = await this.#forward(address, login, signal);
		if (result.status === "completed") await this.#cleanup(journal, signal);
		return result;
	}

	#completed(loginId: string): NativeLoginResult {
		return {
			schema: LOGIN_RESULT_SCHEMA,
			login_id: loginId,
			status: "completed",
			interaction_url: null,
			user_code: null,
		};
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
		// A member's new sign-in replaces their unfinished one. Its node deletes that
		// machine on its next reconcile; until then the reservation answers
		// COMPUTE_IDENTITY_RELEASING, which is a wait, not a refusal.
		const releasingUntil = Date.now() + (this.#config.identityReleaseWaitMs ?? 120_000);
		let result: unknown;
		for (;;) {
			result = await this.#allocationRpc(
				binding,
				"qorpera_reserve_runtime_login_machine",
				{
					...this.#machineIdentity(binding),
					p_login_id: binding.loginId,
					p_capability_sha256: binding.capabilitySha256,
				},
				signal,
			);
			const refusal = result && typeof result === "object" ? (result as { reason?: unknown }).reason : undefined;
			if (refusal !== "COMPUTE_IDENTITY_RELEASING" || Date.now() >= releasingUntil) break;
			await delay(2000, undefined, { signal });
		}
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
			await this.#allocationRpc(
				binding,
				"qorpera_describe_runtime_login_machine",
				this.#machineIdentity(binding),
				signal,
			),
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
		const result = await this.#allocationRpc(
			binding,
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
	/** A journal that never reserved a machine has nothing to release: no physical
	 * operation was dispatched, no instance exists, and the backend knows no request
	 * for it while the login is over or holds its machine elsewhere. */
	async #retireOrphan(journal: LxdLoginJournal, signal: AbortSignal): Promise<boolean> {
		const state = await journal.state();
		if (Object.keys(state.operations).length) return false;
		const binding = journal.binding;
		if (await this.#lxd.getInstance(binding.policy.project, lxdLoginPlan(binding).request.name, signal)) return false;
		const orphaned = await this.#allocationRpc(
			binding,
			"qorpera_runtime_login_journal_orphaned",
			{ p_allocation_id: binding.allocationId, p_login_id: binding.loginId },
			signal,
		);
		if (orphaned !== true) return false;
		if (!state.closing && !(await journal.close(signal))) return false;
		await journal.release(new Date().toISOString());
		return true;
	}
	/** Deletes this node's machines of the same identity whose login can no longer
	 * be used (cancelled by a newer sign-in, expired, completed). Uncertain ones are
	 * left to the reconcile loop; the reservation then decides. */
	async #releaseReplaced(login: NativeLoginRequest, signal: AbortSignal): Promise<void> {
		for (const name of (await readdir(this.#config.stateRoot)).sort()) {
			signal.throwIfAborted();
			if (!LOGIN_UUID.test(name) || name === login.loginId) continue;
			try {
				const journal = await LxdLoginJournal.open(this.#config.stateRoot, name, this.#lxd);
				if (journal.binding.computeIdentityId !== login.computeIdentityId) continue;
				const state = await journal.state();
				if (state.releasedAt) continue;
				const description = await this.#machineDescription(journal.binding, signal);
				if (state.closing || description.cleanupRequired) await this.#cleanup(journal, signal);
			} catch {
				signal.throwIfAborted();
			}
		}
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
					if (await this.#retireOrphan(journal, signal)) return;
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

	async #ensureIdentityVolume(computeIdentityId: string, signal?: AbortSignal): Promise<boolean> {
		const name = `${this.#config.identityVolumePrefix}${computeIdentityId}`;
		let volume = await this.#lxd.getStorageVolume(this.#config.project, this.#config.storagePool, name, signal);
		const created = !volume;
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
		return created;
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

	/** Identity recovery for a login of an established identity whose volume is
	 * new on this node: keys generated inside the pinned guest, the target
	 * registered through the node registrar, the recovery requested on the
	 * login's behalf, and the shipped restore client run in the guest. The
	 * master key never leaves the guest; the gateway holds only the target
	 * capability it minted, the identity's public key and backend ids. */
	async #recoverEstablishedIdentity(
		journal: LxdLoginJournal,
		binding: LxdLoginBinding,
		instanceName: string,
		signal: AbortSignal,
	): Promise<void> {
		const state = recoveryRuntimeState(
			await this.#rpc(
				"qorpera_identity_recovery_runtime_state",
				{ p_compute_identity_id: binding.computeIdentityId },
				signal,
			),
		);
		if (state.canInitialize) return;
		if (state.blocked) {
			// A recovery this guest already holds the credentials for (an earlier
			// post of the same login was cut off after approval): finish it.
			const pending = await this.#pendingRestore(instanceName, binding, state.epoch, signal);
			if (!pending) throw new Error("LOGIN_IDENTITY_RECOVERY_PENDING");
			await this.#restoreInGuest(instanceName, pending.recoveryId, pending.epoch, signal);
			await this.#repinLogin(binding, signal);
			return;
		}
		// The key lives on the identity volume inside the guest. Asking before the
		// guest agent answers reads as "no key" and would recover an identity that
		// is already here, on every sign-in.
		await this.#waitForGuestAgent(instanceName, signal);
		await this.#waitForIdentityMount(instanceName, signal);
		if (await this.#guestFileExists(instanceName, RECOVERY_MASTER_KEY_PATH, signal)) return;
		const registrar = this.#config.identityRecoveryRegistrarCapability,
			guestManifestSha256 = this.#config.guestManifestSha256,
			configuration = state.recoveryConfiguration;
		if (!registrar || !guestManifestSha256) throw new Error("LOGIN_IDENTITY_RECOVERY_REQUIRED");
		if (!configuration) throw new Error("LOGIN_IDENTITY_RECOVERY_AUTHORITY_MISSING");
		const nodeId = (await journal.state()).nodeId;
		if (!nodeId) throw new Error("LOGIN_IDENTITY_RECOVERY_NODE_UNKNOWN");
		await this.#waitForGuestAgent(instanceName, signal);
		// 1. Recipient key inside the guest; the target capability is minted here and pushed.
		const targetId = randomUUID(),
			targetCapability = randomBytes(32).toString("base64url");
		await this.#lxd.execInstance(
			this.#config.project,
			instanceName,
			["/bin/bash", "-c", RECOVERY_KEYGEN_SCRIPT],
			signal,
		);
		await this.#lxd.pushInstanceFile(
			this.#config.project,
			instanceName,
			`${RECOVERY_CREDENTIALS_DIRECTORY}/qorpera-recovery-target`,
			targetCapability,
			0o600,
			signal,
		);
		const recipientPublicKey = (
			await this.#readGuestText(instanceName, RECOVERY_PUBLIC_KEY_PATH, 4096, signal)
		).trim();
		if (!/^[A-Za-z0-9_-]{400,1024}$/.test(recipientPublicKey)) throw new Error("LOGIN_IDENTITY_RECOVERY_KEY_INVALID");
		// 2. Register the target through the node registrar.
		const registration = await this.#fetch(new URL("/v1/provider-target", configuration.serviceOrigin).href, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				registrarNodeId: nodeId,
				registrarCapability: registrar,
				targetId,
				computeIdentityId: binding.computeIdentityId,
				nodeId,
				imageSha256: this.#config.imageFingerprint,
				guestManifestSha256,
				recipientPublicKey,
				targetCapability,
			}),
			redirect: "error",
			signal,
		});
		const registered = (await registration.json().catch(() => undefined)) as { targetId?: unknown } | undefined;
		if (!registration.ok || registered?.targetId !== targetId)
			throw new Error("LOGIN_IDENTITY_RECOVERY_TARGET_REFUSED");
		// 3. The login is the consent: request the recovery on its behalf.
		const recovery = loginRecoveryRequest(
			await this.#allocationRpc(
				binding,
				"qorpera_request_login_identity_recovery",
				{
					p_login_id: binding.loginId,
					p_target_id: targetId,
					p_client_request_id: randomUUID(),
					p_storage_source: "nas",
				},
				signal,
			),
			targetId,
		);
		if (recovery.status !== "approved") throw new Error("LOGIN_IDENTITY_RECOVERY_NOT_APPROVED");
		// 4. Restore inside the guest with the shipped client, after the quiet period.
		await this.#lxd.pushInstanceFile(
			this.#config.project,
			instanceName,
			`${RECOVERY_CREDENTIALS_DIRECTORY}/qorpera-recovery-restore`,
			`${JSON.stringify({
				schema: "qorpera.identity-recovery-restore/v1",
				companyId: binding.profileId,
				computeIdentityId: binding.computeIdentityId,
				authorityId: recovery.authorityId,
				recoveryId: recovery.recoveryId,
				targetId,
				epoch: recovery.epoch,
				backupSha256: recovery.backupSha256,
				serviceOrigin: recovery.serviceOrigin,
				signingPublicKey: recovery.signingPublicKey,
			})}\n`,
			0o600,
			signal,
		);
		const waitMs = this.#config.recoveryWaitMs ?? 180_000;
		const notBefore = recovery.notBefore ? Date.parse(recovery.notBefore) : Number.NaN;
		if (Number.isFinite(notBefore)) {
			const delayMs = notBefore + 2000 - Date.now();
			if (delayMs > waitMs) throw new Error("LOGIN_IDENTITY_RECOVERY_DEFERRED");
			if (delayMs > 0) await delay(delayMs, undefined, { signal });
		}
		await this.#restoreInGuest(instanceName, recovery.recoveryId, recovery.epoch, signal);
		await this.#repinLogin(binding, signal);
		console.error(`LXD native login identity recovered (login ${binding.loginId}, node ${nodeId})`);
	}

	/** The login's own recovery advanced the identity's generation past the one
	 * the session was pinned to; the backend re-pins it so the login's backup
	 * stage and completion run on the restored generation. */
	async #repinLogin(binding: LxdLoginBinding, signal: AbortSignal): Promise<void> {
		const r = record(
			await this.#allocationRpc(
				binding,
				"qorpera_repin_login_recovery_epoch",
				{ p_login_id: binding.loginId },
				signal,
			),
			"Login re-pin",
		);
		if (r.loginId !== binding.loginId || !Number.isSafeInteger(r.epoch))
			throw new Error("LOGIN_IDENTITY_RECOVERY_REPIN_FAILED");
	}

	/** The restore config an earlier, cut-off post left in the guest, if it belongs to the pending generation. */
	async #pendingRestore(
		instanceName: string,
		binding: LxdLoginBinding,
		epoch: number | null,
		signal: AbortSignal,
	): Promise<{ recoveryId: string; epoch: number } | undefined> {
		let text: string;
		try {
			text = await this.#readGuestText(
				instanceName,
				`${RECOVERY_CREDENTIALS_DIRECTORY}/qorpera-recovery-restore`,
				4096,
				signal,
			);
		} catch (error) {
			if (signal.aborted) throw error;
			return undefined;
		}
		try {
			const r = record(JSON.parse(text), "Pending restore");
			if (
				r.schema !== "qorpera.identity-recovery-restore/v1" ||
				r.computeIdentityId !== binding.computeIdentityId ||
				r.companyId !== binding.profileId ||
				!Number.isSafeInteger(r.epoch) ||
				(epoch !== null && r.epoch !== epoch)
			)
				return undefined;
			return { recoveryId: uuid(r.recoveryId, "Pending restore recovery"), epoch: r.epoch as number };
		} catch {
			return undefined;
		}
	}

	/** Runs the shipped restore client in the guest; the recovery scratch is
	 * removed only after a completed restore, so a refused (too early) attempt
	 * can be repeated by the next post. */
	async #restoreInGuest(instanceName: string, recoveryId: string, epoch: number, signal: AbortSignal): Promise<void> {
		let result: { status?: unknown; receiptId?: unknown; epoch?: unknown } | undefined;
		try {
			await this.#lxd.execInstance(
				this.#config.project,
				instanceName,
				["/bin/bash", "-c", RECOVERY_RESTORE_SCRIPT],
				signal,
			);
			const text = await this.#readGuestText(instanceName, RECOVERY_RESULT_PATH, 4096, signal);
			const line = text.trim().split("\n").pop() ?? "";
			result = JSON.parse(line) as typeof result;
		} catch (error) {
			if (signal.aborted) throw error;
			console.error(
				`LXD native login identity restore did not complete (recovery ${recoveryId}); the next post retries`,
			);
			throw new Error("LOGIN_IDENTITY_RECOVERY_PENDING");
		}
		if (result?.status !== "completed" || result.epoch !== epoch) throw new Error("LOGIN_IDENTITY_RECOVERY_FAILED");
		await this.#lxd
			.execInstance(this.#config.project, instanceName, ["/bin/rm", "-rf", RECOVERY_ROOT], signal)
			.catch(() => undefined);
		console.error(`LXD native login identity restore completed (recovery ${recoveryId}, epoch ${epoch})`);
	}

	/** The guest agent mounts the identity volume shortly after it starts answering. */
	async #waitForIdentityMount(instanceName: string, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				await this.#lxd.execInstance(
					this.#config.project,
					instanceName,
					["/usr/bin/mountpoint", "-q", "/var/lib/qorpera/identity"],
					signal,
				);
				return;
			} catch (error) {
				if (signal.aborted) throw error;
				if (Date.now() >= deadline) throw new Error("LOGIN_IDENTITY_VOLUME_UNMOUNTED");
			}
			await delay(250, undefined, { signal });
		}
	}
	async #guestFileExists(instanceName: string, path: string, signal: AbortSignal): Promise<boolean> {
		try {
			await this.#lxd.execInstance(this.#config.project, instanceName, ["/usr/bin/test", "-f", path], signal);
			return true;
		} catch (error) {
			if (signal.aborted) throw error;
			return false;
		}
	}

	async #readGuestText(instanceName: string, path: string, limit: number, signal: AbortSignal): Promise<string> {
		const reader = (this.#lxd as Partial<Pick<LxdInspectableClient, "readInstanceFile">>).readInstanceFile;
		if (!reader) throw new Error("LOGIN_IDENTITY_RECOVERY_READBACK_UNAVAILABLE");
		const file = await reader.call(this.#lxd, this.#config.project, instanceName, path, limit, signal);
		return new TextDecoder("utf8", { fatal: true }).decode(file.content);
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

	async #waitReady(instance: LxdInstanceRecord, signal?: AbortSignal): Promise<string> {
		const deadline = Date.now() + (this.#config.guestReadyTimeoutMs ?? 300_000);
		while (Date.now() < deadline) {
			if (signal?.aborted) throw signal.reason;
			try {
				const state = await this.#lxd.getInstanceState(this.#config.project, instance.name, signal);
				const address = lxdGuestIpv4(instance, state, this.#config.networkInterface);
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
		const response = await this.#fetch(
			`http://${address}:${this.#config.nativeBridgePort}/${login.purpose === "account_refresh" ? "account-refresh" : "login"}`,
			{
				method: "POST",
				redirect: "error",
				headers: { authorization: `Bearer ${login.capability}`, "content-type": "application/json" },
				body: login.encoded,
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
			},
		);
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
			throw new Error("Native login response is too large");
		}
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) throw new Error("Native login response is too large");
		if (!response.ok) throw new Error(`Native login guest rejected the request (${response.status})`);
		if (login.purpose === "account_refresh") {
			if (parseNativeAccountRefreshResult(JSON.parse(encoded), login.loginId) !== "completed")
				throw new Error("Account refresh did not complete");
			return this.#completed(login.loginId);
		}
		return parseResult(JSON.parse(encoded) as unknown, login.loginId);
	}

	/** Refreshes share the fenced VM journal and capacity class, but never login authority. */
	async #allocationRpc(
		binding: LxdLoginBinding,
		method: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (binding.purpose !== "account_refresh") return this.#rpc(method, args, signal);
		const { p_login_id, ...rest } = args;
		const value = await this.#rpc(
			method.replace("login", "account_refresh"),
			{
				...rest,
				...(p_login_id === undefined ? {} : { p_request_id: p_login_id }),
			},
			signal,
		);
		// The reusable journal names its opaque authority key loginId internally.
		if (value && typeof value === "object" && !Array.isArray(value) && "requestId" in value) {
			const { requestId, ...fields } = value as Record<string, unknown>;
			return { ...fields, loginId: requestId };
		}
		return value;
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

	/** Identity recoveries run under the service lifetime, not the member's
	 * connection: an edge timeout must not abandon a registered target and an
	 * approved recovery half-way. A re-post of the same login joins the run. */
	readonly #recoveries = new Map<string, Promise<void>>();
	readonly #lifetime = new AbortController();
	/** Stops in-flight recoveries at service shutdown. */
	shutdown(): void {
		this.#lifetime.abort(new Error("LXD native login gateway shutdown"));
	}
	#recoveryFor(journal: LxdLoginJournal, binding: LxdLoginBinding, instanceName: string): Promise<void> {
		const running = this.#recoveries.get(binding.loginId);
		if (running) return running;
		const work = this.#recoverEstablishedIdentity(journal, binding, instanceName, this.#lifetime.signal).finally(
			() => {
				if (this.#recoveries.get(binding.loginId) === work) this.#recoveries.delete(binding.loginId);
			},
		);
		this.#recoveries.set(binding.loginId, work);
		return work;
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
		this.#gateway.shutdown();
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
