import { isRecord, isUuidAnyCase, type JsonValue } from "@qorpera/contracts";

const randomUUID = (): string => globalThis.crypto.randomUUID();

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type NativeProviderHarness = "codex-cli" | "claude-code";
export type CloudWorkerClass = "managed_sandbox" | "company_computer";
export type SessionTurnSponsorMode = "member_connection" | "company_connection" | "sponsorship_request";
export type ComputeIdentityOwnershipKind = "member" | "company" | "department" | "security_boundary";

export interface NativeComputeIdentity {
	computeIdentityId: string;
	ownershipKind: ComputeIdentityOwnershipKind;
	ownerUserId?: string;
	ownerScopeKey?: string;
	displayName: string;
	templateKey: string;
	templateVersion: string;
	capabilities: readonly string[];
	policy: JsonValue;
	status: "active" | "disabled" | "retired";
	createdAt: string;
	updatedAt: string;
}

export type NativeMemberComputeIdentity = NativeComputeIdentity & {
	ownershipKind: "member";
	ownerUserId: string;
	ownerScopeKey?: never;
};

export interface NativeProviderAccountCredits {
	readonly hasCredits?: boolean;
	readonly unlimited?: boolean;
	readonly balance?: number;
	readonly used?: number;
	readonly limit?: number;
	readonly currency?: string;
}

export interface NativeProviderAccountUsage {
	observedAt: string;
	windows: readonly {
		id: "primary" | "secondary";
		label: string;
		usedPercent: number;
		resetAt?: string;
		windowSeconds?: number;
	}[];
	credits?: NativeProviderAccountCredits;
}

export interface NativeMemberConnection {
	connectionId: string;
	/** Correlates this server-owned connection with the member's sign-in attempt. */
	clientConnectionId: string;
	connectionVersion: number;
	provider: string;
	nativeHarness: NativeProviderHarness;
	authorizationState: "active" | "reauthentication_required" | "revoked";
	maxNativeConcurrency: number;
	providerAccountReference?: string;
	providerAccountEmail?: string;
	providerAccountUsage?: NativeProviderAccountUsage;
	usageLimitResetAt?: string;
	billingSource: string;
	consentVersion: string;
	consentedAt: string;
	connectionStatus: "active" | "disabled" | "revoked";
	sponsorBindingId?: string;
	sponsorVersion?: number;
	policy: {
		implementationStatus: "planned" | "supported" | "retired";
		enablementStatus: "disabled" | "enabled";
		policyVersion: number;
		disabledReason?: string;
	};
}

export interface NativeExecutionConnections {
	computeIdentity?: NativeMemberComputeIdentity;
	connections: readonly NativeMemberConnection[];
}

export interface NativeProviderLoginAuthorization {
	loginId: string;
	clientLoginId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	computeIdentityOwnershipKind: ComputeIdentityOwnershipKind;
	computeIdentityOwnerUserId?: string;
	computeIdentityOwnerScopeKey?: string;
	provider: string;
	nativeHarness: NativeProviderHarness;
	/** Job-scoped login capability. This is not a provider credential. */
	capability: string;
	expiresAt: string;
}

export interface SessionTurnRequestResult {
	turnRequestId: string;
	inputId: string;
	status: "pending_sponsorship" | "queued" | "materialized" | "cancelled" | "failed";
	sponsorMode: SessionTurnSponsorMode;
}

export interface CreateMemberComputeIdentityInput {
	profileId: string;
	clientIdentityId?: string;
	displayName: string;
	templateKey?: string;
	templateVersion?: string;
	capabilities?: readonly string[];
	policy?: JsonValue;
}

export interface BeginNativeProviderLoginInput {
	profileId: string;
	computeIdentityId: string;
	provider: string;
	nativeHarness: NativeProviderHarness;
	clientLoginId?: string;
	clientConnectionId?: string;
	loginSeconds?: number;
}

export interface CreateMemberSponsorInput {
	profileId: string;
	clientBindingId?: string;
	providerConnectionId: string;
	providerConnectionVersion: number;
	allowAutonomous?: boolean;
}

export interface RevokeNativeProviderConnectionInput {
	profileId: string;
	providerConnectionId: string;
}

export interface RequestSponsoredSessionTurnInput {
	sessionId: string;
	clientInputId?: string;
	clientRequestId?: string;
	body: JsonValue;
	sponsorMode: SessionTurnSponsorMode;
	sponsorBindingId?: string;
	sponsorVersion?: number;
	requestedSponsorUserId?: string;
	computeIdentityId?: string;
	logicalComputerId?: string;
	workerClass?: CloudWorkerClass;
	requiredCapability?: "agent_turn" | "git_worktree" | "company_substrate";
	jobType?: string;
	publicationMode?: "automatic" | "review";
	reviewPolicyKey?: string;
	reviewerStaffIds?: readonly string[];
}

type NativeControlRpc =
	| "qorpera_upsert_member_compute_identity"
	| "qorpera_begin_native_provider_login"
	| "qorpera_create_member_execution_sponsor"
	| "qorpera_request_session_turn_v2"
	| "qorpera_list_member_native_execution_connections"
	| "qorpera_revoke_native_provider_connection";

export interface NativeSubscriptionControlTransport {
	rpc(name: NativeControlRpc, args: Readonly<Record<string, JsonValue>>): Promise<unknown>;
}

function controlRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`Native subscription control returned invalid ${label}`);
	}
	return value;
}

function controlUuid(value: unknown, label: string): string {
	if (!isUuidAnyCase(value)) {
		throw new Error(`Native subscription control returned invalid ${label}`);
	}
	return value;
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`Native subscription control returned invalid ${label}`);
	}
	return value as number;
}

function text(value: unknown, label: string, maximum = 512): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`Native subscription control returned invalid ${label}`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Native subscription control returned invalid ${label}`);
	}
	return new Date(value).toISOString();
}

function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : controlUuid(value, label);
}

function optionalText(value: unknown, label: string, maximum = 512): string | undefined {
	return value === null || value === undefined ? undefined : text(value, label, maximum);
}

function parseAccountCredits(value: unknown): NativeProviderAccountCredits | undefined {
	if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const amount = (raw: unknown): number | undefined =>
		typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000_000 ? raw : undefined;
	const hasCredits = typeof input.hasCredits === "boolean" ? input.hasCredits : undefined;
	const unlimited = typeof input.unlimited === "boolean" ? input.unlimited : undefined;
	const balance = amount(input.balance);
	const used = amount(input.used);
	const limit = amount(input.limit);
	const currency =
		typeof input.currency === "string" && /^[A-Z]{3}$/.test(input.currency) ? input.currency : undefined;
	if (unlimited === undefined && balance === undefined && used === undefined && limit === undefined) return undefined;
	return {
		...(hasCredits !== undefined ? { hasCredits } : {}),
		...(unlimited !== undefined ? { unlimited } : {}),
		...(balance !== undefined ? { balance } : {}),
		...(used !== undefined ? { used } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(currency !== undefined ? { currency } : {}),
	};
}

/** Display telemetry is optional and never changes connection authority. */
function parseAccountUsage(value: unknown): NativeProviderAccountUsage | undefined {
	if (value === null || value === undefined) return undefined;
	try {
		const usage = controlRecord(value, "account usage");
		if (!Array.isArray(usage.windows) || usage.windows.length < 1 || usage.windows.length > 2) return undefined;
		const ids = new Set<string>();
		const windows = usage.windows.map((entry) => {
			const window = controlRecord(entry, "usage window");
			if (
				(window.id !== "primary" && window.id !== "secondary") ||
				ids.has(window.id) ||
				typeof window.usedPercent !== "number" ||
				!Number.isFinite(window.usedPercent) ||
				window.usedPercent < 0 ||
				window.usedPercent > 100
			)
				throw new Error("Invalid account usage window");
			ids.add(window.id);
			return {
				id: window.id,
				label: text(window.label, "usage window label", 80),
				usedPercent: window.usedPercent,
				...(window.resetAt === undefined ? {} : { resetAt: timestamp(window.resetAt, "usage reset time") }),
				...(window.windowSeconds === undefined
					? {}
					: { windowSeconds: integer(window.windowSeconds, "usage window duration") }),
			} satisfies NativeProviderAccountUsage["windows"][number];
		});
		const credits = parseAccountCredits(usage.credits);
		return {
			observedAt: timestamp(usage.observedAt, "usage observation time"),
			windows,
			...(credits ? { credits } : {}),
		};
	} catch {
		return undefined;
	}
}

function parseSponsorMode(value: unknown): SessionTurnSponsorMode {
	if (value !== "member_connection" && value !== "company_connection" && value !== "sponsorship_request") {
		throw new Error("Native subscription control returned invalid sponsor mode");
	}
	return value;
}

function parseTurnStatus(value: unknown): SessionTurnRequestResult["status"] {
	if (
		value !== "pending_sponsorship" &&
		value !== "queued" &&
		value !== "materialized" &&
		value !== "cancelled" &&
		value !== "failed"
	) {
		throw new Error("Native subscription control returned invalid turn status");
	}
	return value;
}

function parseHarness(value: unknown): NativeProviderHarness {
	if (value !== "codex-cli" && value !== "claude-code") {
		throw new Error("Native subscription control returned unsupported native harness");
	}
	return value;
}

function parseOwnershipKind(value: unknown): ComputeIdentityOwnershipKind {
	if (value !== "member" && value !== "company" && value !== "department" && value !== "security_boundary") {
		throw new Error("Native subscription control returned invalid compute identity ownership");
	}
	return value;
}

function parseComputeIdentity(value: unknown): NativeComputeIdentity {
	const identity = controlRecord(value, "compute identity");
	if (!Array.isArray(identity.capabilities)) {
		throw new Error("Native subscription control returned invalid compute capabilities");
	}
	if (identity.status !== "active" && identity.status !== "disabled" && identity.status !== "retired") {
		throw new Error("Native subscription control returned invalid compute identity status");
	}
	const ownershipKind = parseOwnershipKind(identity.ownership_kind);
	const ownerUserId = optionalUuid(identity.owner_user_id, "compute identity owner user id");
	const ownerScopeKey = optionalText(identity.owner_scope_key, "compute identity owner scope", 160);
	if (
		(ownershipKind === "member" && (!ownerUserId || ownerScopeKey)) ||
		(ownershipKind === "company" && (ownerUserId || ownerScopeKey)) ||
		((ownershipKind === "department" || ownershipKind === "security_boundary") && (ownerUserId || !ownerScopeKey))
	) {
		throw new Error("Native subscription control returned inconsistent compute identity ownership");
	}
	return {
		computeIdentityId: controlUuid(identity.compute_identity_id, "compute identity id"),
		ownershipKind,
		...(ownerUserId ? { ownerUserId } : {}),
		...(ownerScopeKey ? { ownerScopeKey } : {}),
		displayName: text(identity.display_name, "compute identity name", 120),
		templateKey: text(identity.template_key, "compute template key", 120),
		templateVersion: text(identity.template_version, "compute template version", 120),
		capabilities: identity.capabilities.map((capability) => text(capability, "compute capability", 64)),
		policy: identity.policy as JsonValue,
		status: identity.status,
		createdAt: timestamp(identity.created_at, "compute identity creation time"),
		updatedAt: timestamp(identity.updated_at, "compute identity update time"),
	};
}

function parseMemberComputeIdentity(value: unknown): NativeMemberComputeIdentity {
	const identity = parseComputeIdentity(value);
	if (identity.ownershipKind !== "member" || !identity.ownerUserId || identity.ownerScopeKey !== undefined) {
		throw new Error("Native subscription control returned a non-member compute identity");
	}
	return {
		computeIdentityId: identity.computeIdentityId,
		ownershipKind: "member",
		ownerUserId: identity.ownerUserId,
		displayName: identity.displayName,
		templateKey: identity.templateKey,
		templateVersion: identity.templateVersion,
		capabilities: identity.capabilities,
		policy: identity.policy,
		status: identity.status,
		createdAt: identity.createdAt,
		updatedAt: identity.updatedAt,
	};
}

function nullable(value: string | number | readonly string[] | JsonValue | undefined): JsonValue {
	if (value === undefined) return null;
	if (Array.isArray(value)) return [...value];
	return value as JsonValue;
}

/** Product-facing client for native provider login, explicit sponsorship and
 * per-turn execution. It never accepts or returns provider OAuth material. */
export class NativeSubscriptionControlPlane {
	readonly #transport: NativeSubscriptionControlTransport;

	constructor(transport: NativeSubscriptionControlTransport) {
		this.#transport = transport;
	}

	async createMemberComputeIdentity(input: CreateMemberComputeIdentityInput): Promise<NativeMemberComputeIdentity> {
		const value = controlRecord(
			await this.#transport.rpc("qorpera_upsert_member_compute_identity", {
				p_profile_id: input.profileId,
				p_client_identity_id: input.clientIdentityId ?? randomUUID(),
				p_display_name: input.displayName,
				p_template_key: input.templateKey ?? "qorpera-member-linux",
				p_template_version: input.templateVersion ?? "v1",
				p_capabilities: [...(input.capabilities ?? ["agent_turn", "company_substrate"])],
				p_policy: input.policy ?? {},
			}),
			"compute identity",
		);
		return parseMemberComputeIdentity(value);
	}

	async beginNativeProviderLogin(input: BeginNativeProviderLoginInput): Promise<NativeProviderLoginAuthorization> {
		if (!PROVIDER_PATTERN.test(input.provider)) throw new Error("Native provider id is invalid");
		const capability = btoa(String.fromCharCode(...globalThis.crypto.getRandomValues(new Uint8Array(32))))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		const digest = new Uint8Array(
			await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)),
		);
		const capabilitySha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		const clientLoginId = input.clientLoginId ?? randomUUID();
		const clientConnectionId = input.clientConnectionId ?? randomUUID();
		const value = controlRecord(
			await this.#transport.rpc("qorpera_begin_native_provider_login", {
				p_profile_id: input.profileId,
				p_client_login_id: clientLoginId,
				p_client_connection_id: clientConnectionId,
				p_compute_identity_id: input.computeIdentityId,
				p_provider: input.provider,
				p_native_harness: input.nativeHarness,
				p_capability_sha256: capabilitySha256,
				p_login_seconds: input.loginSeconds ?? 900,
			}),
			"native login",
		);
		const ownershipKind = parseOwnershipKind(value.compute_identity_ownership_kind);
		const ownerUserId = optionalUuid(value.compute_identity_owner_user_id, "native login owner user id");
		const ownerScopeKey = optionalText(value.compute_identity_owner_scope_key, "native login owner scope", 160);
		if (
			(ownershipKind === "member" && (!ownerUserId || ownerScopeKey)) ||
			(ownershipKind === "company" && (ownerUserId || ownerScopeKey)) ||
			((ownershipKind === "department" || ownershipKind === "security_boundary") && (ownerUserId || !ownerScopeKey))
		) {
			throw new Error("Native subscription control returned inconsistent native login ownership");
		}
		return {
			loginId: controlUuid(value.login_id, "native login id"),
			clientLoginId,
			clientConnectionId,
			computeIdentityId: controlUuid(value.compute_identity_id, "native login compute identity id"),
			computeIdentityOwnershipKind: ownershipKind,
			...(ownerUserId ? { computeIdentityOwnerUserId: ownerUserId } : {}),
			...(ownerScopeKey ? { computeIdentityOwnerScopeKey: ownerScopeKey } : {}),
			provider: text(value.provider, "native login provider", 64),
			nativeHarness: parseHarness(value.native_harness),
			capability,
			expiresAt: timestamp(value.expires_at, "native login expiry"),
		};
	}

	async createMemberSponsor(input: CreateMemberSponsorInput): Promise<{ bindingId: string; version: number }> {
		const value = controlRecord(
			await this.#transport.rpc("qorpera_create_member_execution_sponsor", {
				p_profile_id: input.profileId,
				p_client_binding_id: input.clientBindingId ?? randomUUID(),
				p_provider_connection_id: input.providerConnectionId,
				p_provider_connection_version: input.providerConnectionVersion,
				p_allow_autonomous: input.allowAutonomous ?? false,
			}),
			"member sponsor",
		);
		return {
			bindingId: controlUuid(value.binding_id, "member sponsor binding id"),
			version: integer(value.version, "member sponsor version"),
		};
	}

	async revokeConnection(
		input: RevokeNativeProviderConnectionInput,
	): Promise<{ connectionId: string; status: "revoked" }> {
		const value = controlRecord(
			await this.#transport.rpc("qorpera_revoke_native_provider_connection", {
				p_profile_id: input.profileId,
				p_connection_id: input.providerConnectionId,
			}),
			"native connection revocation",
		);
		if (value.status !== "revoked") {
			throw new Error("Native subscription control returned invalid revocation status");
		}
		return {
			connectionId: controlUuid(value.connection_id, "revoked connection id"),
			status: "revoked",
		};
	}

	async requestSessionTurn(input: RequestSponsoredSessionTurnInput): Promise<SessionTurnRequestResult> {
		// A member's login pays only for that member's own work (2026-09-28): nobody is asked to pay.
		if (input.sponsorMode === "sponsorship_request")
			throw new Error("A turn is paid by the member who sends it or by a company account");
		const value = controlRecord(
			await this.#transport.rpc("qorpera_request_session_turn_v2", {
				p_session_id: input.sessionId,
				p_client_input_id: input.clientInputId ?? randomUUID(),
				p_client_request_id: input.clientRequestId ?? randomUUID(),
				p_body: input.body,
				p_sponsor_mode: input.sponsorMode,
				p_sponsor_binding_id: nullable(input.sponsorBindingId),
				p_sponsor_version: nullable(input.sponsorVersion),
				p_requested_sponsor_user_id: nullable(input.requestedSponsorUserId),
				p_compute_identity_id: nullable(input.computeIdentityId),
				p_logical_computer_id: nullable(input.logicalComputerId),
				p_worker_class: input.workerClass ?? "managed_sandbox",
				p_required_capability: input.requiredCapability ?? "agent_turn",
				p_job_type: input.jobType ?? "agent_turn",
				p_publication_mode: input.publicationMode ?? "automatic",
				p_review_policy_key: nullable(input.reviewPolicyKey),
				p_reviewer_staff_ids: [...(input.reviewerStaffIds ?? [])],
			}),
			"session turn request",
		);
		return {
			turnRequestId: controlUuid(value.turn_request_id, "turn request id"),
			inputId: controlUuid(value.input_id, "turn input id"),
			status: parseTurnStatus(value.status),
			sponsorMode: parseSponsorMode(value.sponsor_mode),
		};
	}

	async listConnections(profileId: string): Promise<NativeExecutionConnections> {
		const value = controlRecord(
			await this.#transport.rpc("qorpera_list_member_native_execution_connections", {
				p_profile_id: profileId,
			}),
			"native execution connections",
		);
		const identityValue = value.compute_identity;
		const computeIdentity =
			identityValue === null || identityValue === undefined ? undefined : parseMemberComputeIdentity(identityValue);
		if (!Array.isArray(value.connections)) {
			throw new Error("Native subscription control returned invalid connection list");
		}
		return {
			...(computeIdentity ? { computeIdentity } : {}),
			connections: value.connections.map((entry) => {
				const connection = controlRecord(entry, "native connection");
				const policy = controlRecord(connection.policy, "native provider policy");
				const usage = parseAccountUsage(connection.provider_account_usage);
				if (
					(connection.authorization_state !== "active" &&
						connection.authorization_state !== "reauthentication_required" &&
						connection.authorization_state !== "revoked") ||
					(connection.connection_status !== "active" &&
						connection.connection_status !== "disabled" &&
						connection.connection_status !== "revoked") ||
					(policy.implementation_status !== "planned" &&
						policy.implementation_status !== "supported" &&
						policy.implementation_status !== "retired") ||
					(policy.enablement_status !== "disabled" && policy.enablement_status !== "enabled")
				) {
					throw new Error("Native subscription control returned invalid connection authority");
				}
				return {
					connectionId: controlUuid(connection.connection_id, "native connection id"),
					clientConnectionId: controlUuid(connection.client_connection_id, "native client connection id"),
					connectionVersion: integer(connection.connection_version, "native connection version"),
					provider: text(connection.provider, "native connection provider", 64),
					nativeHarness: parseHarness(connection.native_harness),
					authorizationState: connection.authorization_state,
					...(usage ? { providerAccountUsage: usage } : {}),
					...(connection.usage_limit_reset_at === null || connection.usage_limit_reset_at === undefined
						? {}
						: { usageLimitResetAt: timestamp(connection.usage_limit_reset_at, "usage limit reset time") }),
					maxNativeConcurrency: integer(connection.max_native_concurrency, "native concurrency"),
					...(optionalText(connection.provider_account_reference, "provider account reference")
						? {
								providerAccountReference: optionalText(
									connection.provider_account_reference,
									"provider account reference",
								),
							}
						: {}),
					billingSource: text(connection.billing_source, "native billing source", 120),
					...(optionalText(connection.provider_account_email, "provider account email", 254)
						? {
								providerAccountEmail: optionalText(
									connection.provider_account_email,
									"provider account email",
									254,
								),
							}
						: {}),
					consentVersion: text(connection.consent_version, "native consent version", 120),
					consentedAt: timestamp(connection.consented_at, "native consent time"),
					connectionStatus: connection.connection_status,
					...(optionalUuid(connection.sponsor_binding_id, "member sponsor binding id")
						? { sponsorBindingId: controlUuid(connection.sponsor_binding_id, "member sponsor binding id") }
						: {}),
					...(connection.sponsor_version === null || connection.sponsor_version === undefined
						? {}
						: { sponsorVersion: integer(connection.sponsor_version, "member sponsor version") }),
					policy: {
						implementationStatus: policy.implementation_status,
						enablementStatus: policy.enablement_status,
						policyVersion: integer(policy.policy_version, "provider policy version"),
						...(optionalText(policy.disabled_reason, "provider disabled reason", 1000)
							? { disabledReason: optionalText(policy.disabled_reason, "provider disabled reason", 1000) }
							: {}),
					},
				} satisfies NativeMemberConnection;
			}),
		};
	}
}
