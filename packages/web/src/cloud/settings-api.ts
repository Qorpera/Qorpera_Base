import type { Cloud } from "./client.ts";
import { array, boundedInteger, nonEmptyString, oneOf, record, timestamp, uuid } from "./parse.ts";
import type { HostedProfile } from "./types.ts";

export interface NativeConnection {
	id: string;
	version: number;
	provider: "openai" | "anthropic";
	status: "active" | "disabled" | "revoked";
	authorization: "active" | "reauthentication_required" | "revoked";
	account?: string;
	sponsorId?: string;
	enabled: boolean;
	reason?: string;
}
export interface ServiceConnection {
	id: string;
	connector: string;
	name: string;
	purpose: string;
	owner: "member" | "company";
	ownerUserId?: string;
	status: "active" | "revoked";
}
export interface ProviderLogin {
	id: string;
	provider: "openai" | "anthropic";
	knownConnectionIds: string[];
	url?: string;
	code?: string;
	expiresAt: string;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

/** Bound every browser response before parsing it, including chunked responses. */
export async function boundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("The cloud returned an empty response.");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.length;
			if (size > maximum) throw new Error("The cloud response exceeds the size limit.");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

export class SettingsApi {
	readonly cloud: Cloud;
	readonly profile: HostedProfile;
	readonly userId: string;
	readonly signal: AbortSignal;
	constructor(cloud: Cloud, profile: HostedProfile, userId: string, signal: AbortSignal) {
		this.cloud = cloud;
		this.profile = profile;
		this.userId = userId;
		this.signal = signal;
	}
	async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
		this.signal.throwIfAborted();
		const value = await this.cloud.rpc(name, args);
		this.signal.throwIfAborted();
		return value;
	}
	async request(url: string, body?: unknown, capability?: string): Promise<unknown> {
		this.signal.throwIfAborted();
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.username || parsed.password)
			throw new Error("Invalid settings endpoint.");
		const session = capability ? undefined : (await this.cloud.supabase.auth.getSession()).data.session;
		this.signal.throwIfAborted();
		if (!capability && session?.user.id !== this.userId) throw new Error("Sign in again to continue.");
		const response = await fetch(url, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
			headers: {
				authorization: `Bearer ${capability ?? session!.access_token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				response.status === 409
					? "These settings changed. Reload before saving again."
					: response.status === 401 || response.status === 403
						? "Access denied. Check your membership or sign in again."
						: `The settings service is unavailable (${response.status}). Check the current state before retrying a change.`,
			);
		}
		const bytes = await boundedResponse(response, 256 * 1024);
		this.signal.throwIfAborted();
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	}
	async connections(): Promise<{ identityId?: string; connections: NativeConnection[] }> {
		const input = record(
			await this.rpc("qorpera_list_member_native_execution_connections", { p_profile_id: this.profile.profileId }),
			"connections",
		);
		let identityId: string | undefined;
		if (input.compute_identity) {
			const identity = record(input.compute_identity, "compute identity");
			if (identity.ownership_kind !== "member" || identity.owner_user_id !== this.userId)
				throw new Error("The cloud returned another member’s compute identity.");
			identityId = uuid(identity.compute_identity_id, "compute identity");
		}
		return {
			identityId,
			connections: array(input.connections, "connections").map((value) => {
				const connection = record(value, "connection"),
					policy = record(connection.policy, "provider policy");
				const provider = oneOf(connection.provider, ["openai", "anthropic"], "provider");
				if (connection.native_harness !== (provider === "openai" ? "codex-cli" : "claude-code"))
					throw new Error("Invalid provider harness.");
				return {
					id: uuid(connection.connection_id, "connection"),
					version: boundedInteger(connection.connection_version, "connection version", 1, Number.MAX_SAFE_INTEGER),
					provider,
					status: oneOf(connection.connection_status, ["active", "disabled", "revoked"], "connection status"),
					authorization: oneOf(
						connection.authorization_state,
						["active", "reauthentication_required", "revoked"],
						"connection authorization",
					),
					enabled:
						oneOf(
							policy.implementation_status,
							["supported", "planned", "retired"],
							"provider implementation",
						) === "supported" &&
						oneOf(policy.enablement_status, ["enabled", "disabled"], "provider enablement") === "enabled",
					account:
						connection.provider_account_reference == null
							? undefined
							: nonEmptyString(connection.provider_account_reference, "provider account", 512),
					sponsorId:
						connection.sponsor_binding_id == null ? undefined : uuid(connection.sponsor_binding_id, "sponsor"),
					reason:
						policy.disabled_reason == null
							? undefined
							: nonEmptyString(policy.disabled_reason, "provider availability", 1000),
				};
			}),
		};
	}
	async beginLogin(provider: "openai" | "anthropic"): Promise<ProviderLogin> {
		const existing = await this.connections();
		let { identityId } = existing;
		if (!identityId) {
			const identity = record(
				await this.rpc("qorpera_upsert_member_compute_identity", {
					p_profile_id: this.profile.profileId,
					p_client_identity_id: crypto.randomUUID(),
					p_display_name: "My cloud computer",
					p_template_key: "qorpera-member-linux",
					p_template_version: "v1",
					p_capabilities: ["agent_turn", "company_substrate"],
					p_policy: { credentialExport: false, operatorBlindnessClaimed: false },
				}),
				"compute identity",
			);
			if (identity.ownership_kind !== "member" || identity.owner_user_id !== this.userId)
				throw new Error("Invalid compute ownership.");
			identityId = uuid(identity.compute_identity_id, "compute identity");
		}
		const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		const connectionId = crypto.randomUUID();
		const harness = provider === "openai" ? "codex-cli" : "claude-code";
		const login = record(
			await this.rpc("qorpera_begin_native_provider_login", {
				p_profile_id: this.profile.profileId,
				p_client_login_id: crypto.randomUUID(),
				p_client_connection_id: connectionId,
				p_compute_identity_id: identityId,
				p_provider: provider,
				p_native_harness: harness,
				p_capability_sha256: await sha256(new TextEncoder().encode(capability)),
				p_login_seconds: 900,
			}),
			"provider login",
		);
		const id = uuid(login.login_id, "login"),
			expiresAt = timestamp(login.expires_at, "login expiry");
		if (
			login.compute_identity_id !== identityId ||
			login.compute_identity_ownership_kind !== "member" ||
			login.compute_identity_owner_user_id !== this.userId ||
			login.compute_identity_owner_scope_key != null ||
			login.provider !== provider ||
			login.native_harness !== harness ||
			Date.parse(expiresAt) <= Date.now()
		)
			throw new Error("Invalid provider login authorization.");
		const response = record(
			await this.request(
				`${this.cloud.config.projectUrl}/functions/v1/native-provider-login/`,
				{
					schema: "qorpera.native-provider-login/v1",
					login_id: id,
					client_connection_id: connectionId,
					compute_identity_id: identityId,
					compute_identity_ownership_kind: "member",
					compute_identity_owner_user_id: this.userId,
					compute_identity_owner_scope_key: null,
					provider,
					native_harness: harness,
					login_capability: capability,
					expires_at: expiresAt,
				},
				capability,
			),
			"provider login prompt",
		);
		if (
			response.schema !== "qorpera.native-provider-login-result/v1" ||
			response.login_id !== id ||
			!["awaiting_member", "completed"].includes(String(response.status)) ||
			Object.keys(response).some(
				(key) => !["schema", "login_id", "status", "interaction_url", "user_code"].includes(key),
			)
		)
			throw new Error("Invalid provider login response.");
		const url =
			response.interaction_url == null ? undefined : nonEmptyString(response.interaction_url, "login URL", 8192);
		if (url) {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password)
				throw new Error("Invalid provider login URL.");
		}
		const code = response.user_code == null ? undefined : nonEmptyString(response.user_code, "login code", 128);
		if (code && /[\0\r\n]/.test(code)) throw new Error("Invalid provider login code.");
		return {
			id,
			provider,
			knownConnectionIds: existing.connections.map((connection) => connection.id),
			url,
			code,
			expiresAt,
		};
	}
	async enable(connection: NativeConnection): Promise<void> {
		const value = record(
			await this.rpc("qorpera_create_member_execution_sponsor", {
				p_profile_id: this.profile.profileId,
				p_client_binding_id: connection.id,
				p_provider_connection_id: connection.id,
				p_provider_connection_version: connection.version,
				p_allow_autonomous: false,
			}),
			"subscription sponsor",
		);
		uuid(value.binding_id, "sponsor");
		boundedInteger(value.version, "sponsor version", 1, Number.MAX_SAFE_INTEGER);
	}
	async revoke(connection: NativeConnection): Promise<void> {
		const value = record(
			await this.rpc("qorpera_revoke_native_provider_connection", {
				p_profile_id: this.profile.profileId,
				p_connection_id: connection.id,
			}),
			"connection revocation",
		);
		if (value.connection_id !== connection.id || value.status !== "revoked")
			throw new Error("Connection revocation was not confirmed.");
	}
	async services(): Promise<ServiceConnection[]> {
		return array(
			await this.rpc("qorpera_list_cloud_secret_connections", {
				p_profile_id: this.profile.profileId,
				p_environment_id: this.profile.environmentId,
			}),
			"service connections",
		).map((value) => {
			const input = record(value, "service connection");
			if (input.schema !== "qorpera.cloud-secret-descriptor/v1") throw new Error("Invalid service connection.");
			return {
				id: uuid(input.secretId, "service connection"),
				connector: nonEmptyString(input.connectorId, "connector", 64),
				name: nonEmptyString(input.secretName, "connection name", 64),
				purpose: nonEmptyString(input.purpose, "connection purpose", 512),
				owner: oneOf(input.ownerKind, ["member", "company"], "connection owner"),
				ownerUserId: input.ownerUserId == null ? undefined : uuid(input.ownerUserId, "connection owner"),
				status: oneOf(input.status, ["active", "revoked"], "service connection status"),
			};
		});
	}
	async revokeService(connection: ServiceConnection): Promise<void> {
		const input = record(
			await this.rpc("qorpera_revoke_cloud_secret", {
				p_profile_id: this.profile.profileId,
				p_secret_id: connection.id,
			}),
			"service revocation",
		);
		if (input.secretId !== connection.id || input.status !== "revoked")
			throw new Error("Service revocation was not confirmed.");
	}
}
