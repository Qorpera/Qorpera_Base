import type { JsonValue } from "@qorpera/contracts";
import type { NativeProviderLoginAuthorization } from "./cloud-native-subscription-control.ts";
import { readBoundedCloudResponse } from "./cloud-request.ts";

const BRIDGE_LOGIN_REQUEST_SCHEMA = "qorpera.native-provider-login/v1";
const BRIDGE_LOGIN_RESPONSE_SCHEMA = "qorpera.native-provider-login-result/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BRIDGE_RESPONSE_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NativeProviderLoginPrompt {
	loginId: string;
	status: "awaiting_member" | "completed";
	interactionUrl?: string;
	userCode?: string;
}

export interface NativeProviderIdentityBridge {
	beginLogin(authorization: NativeProviderLoginAuthorization): Promise<NativeProviderLoginPrompt>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function bridgeUrl(value: string): URL {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Native provider bridge URL must use HTTPS or loopback transport");
	}
	return url;
}
export class HttpNativeProviderIdentityBridge implements NativeProviderIdentityBridge {
	readonly #loginUrl: string;
	readonly #fetch: typeof fetch;
	readonly #signal?: AbortSignal;
	constructor(baseUrl: string, fetchImplementation: typeof fetch = fetch, options: { signal?: AbortSignal } = {}) {
		this.#loginUrl = new URL("login", bridgeUrl(baseUrl)).href;
		this.#fetch = fetchImplementation;
		this.#signal = options.signal;
	}

	async beginLogin(authorization: NativeProviderLoginAuthorization): Promise<NativeProviderLoginPrompt> {
		const ownershipIsValid =
			authorization.computeIdentityOwnershipKind === "member"
				? authorization.computeIdentityOwnerUserId !== undefined &&
					UUID_PATTERN.test(authorization.computeIdentityOwnerUserId) &&
					authorization.computeIdentityOwnerScopeKey === undefined
				: authorization.computeIdentityOwnershipKind === "company"
					? authorization.computeIdentityOwnerUserId === undefined &&
						authorization.computeIdentityOwnerScopeKey === undefined
					: (authorization.computeIdentityOwnershipKind === "department" ||
							authorization.computeIdentityOwnershipKind === "security_boundary") &&
						authorization.computeIdentityOwnerUserId === undefined &&
						typeof authorization.computeIdentityOwnerScopeKey === "string" &&
						authorization.computeIdentityOwnerScopeKey.length > 0 &&
						authorization.computeIdentityOwnerScopeKey.length <= 160 &&
						!/\0|\r|\n/.test(authorization.computeIdentityOwnerScopeKey);
		if (
			!TOKEN_PATTERN.test(authorization.capability) ||
			!Number.isFinite(Date.parse(authorization.expiresAt)) ||
			Date.parse(authorization.expiresAt) <= Date.now() ||
			!UUID_PATTERN.test(authorization.loginId) ||
			!UUID_PATTERN.test(authorization.computeIdentityId) ||
			(authorization.nativeHarness !== "codex-cli" && authorization.nativeHarness !== "claude-code") ||
			!ownershipIsValid
		) {
			throw new Error("Native provider login authority is invalid");
		}
		const value = record(
			await this.#request(
				this.#loginUrl,
				{
					schema: BRIDGE_LOGIN_REQUEST_SCHEMA,
					login_id: authorization.loginId,
					client_connection_id: authorization.clientConnectionId,
					compute_identity_id: authorization.computeIdentityId,
					compute_identity_ownership_kind: authorization.computeIdentityOwnershipKind,
					compute_identity_owner_user_id: authorization.computeIdentityOwnerUserId ?? null,
					compute_identity_owner_scope_key: authorization.computeIdentityOwnerScopeKey ?? null,
					provider: authorization.provider,
					native_harness: authorization.nativeHarness,
					login_capability: authorization.capability,
					expires_at: authorization.expiresAt,
				},
				AbortSignal.any([AbortSignal.timeout(30_000), ...(this.#signal ? [this.#signal] : [])]),
				authorization.capability,
			),
			"Native provider login response",
		);
		if (
			value.schema !== BRIDGE_LOGIN_RESPONSE_SCHEMA ||
			value.login_id !== authorization.loginId ||
			(value.status !== "awaiting_member" && value.status !== "completed") ||
			Object.keys(value).some(
				(key) => !["schema", "login_id", "status", "interaction_url", "user_code"].includes(key),
			)
		) {
			throw new Error("Native provider login response crossed the credential boundary");
		}
		const interactionUrl = value.interaction_url;
		if (interactionUrl !== null && interactionUrl !== undefined) {
			if (typeof interactionUrl !== "string") throw new Error("Native provider login URL is invalid");
			const parsed = new URL(interactionUrl);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
				throw new Error("Native provider login URL is invalid");
			}
		}
		const userCode = value.user_code;
		if (
			userCode !== null &&
			userCode !== undefined &&
			(typeof userCode !== "string" || !userCode.trim() || userCode.length > 128 || /[\0\r\n]/.test(userCode))
		) {
			throw new Error("Native provider login code is invalid");
		}
		return {
			loginId: authorization.loginId,
			status: value.status,
			...(typeof interactionUrl === "string" ? { interactionUrl } : {}),
			...(typeof userCode === "string" ? { userCode } : {}),
		};
	}

	async #request(url: string, body: JsonValue, signal: AbortSignal, bearerToken: string): Promise<unknown> {
		if (!bearerToken) throw new Error("Native provider bridge capability is not configured");
		signal.throwIfAborted();
		let abort = (): void => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("Native provider bridge request stopped"));
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([
				cancelled,
				Promise.resolve().then(async () => {
					signal.throwIfAborted();
					const response = await this.#fetch(url, {
						method: "POST",
						headers: {
							accept: "application/json",
							authorization: `Bearer ${bearerToken}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
						redirect: "error",
						signal,
					});
					if (!response.ok) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error(`Native provider bridge request failed (${response.status})`);
					}
					const bytes = await readBoundedCloudResponse(response, MAX_BRIDGE_RESPONSE_BYTES, signal);
					try {
						return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
					} catch {
						throw new Error("Native provider bridge returned invalid JSON");
					}
				}),
			]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}
}
