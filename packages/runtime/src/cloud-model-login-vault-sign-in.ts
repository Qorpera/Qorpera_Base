import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ModelLoginSignInHelper } from "./cloud-model-login-sign-in.ts";
import { MODEL_LOGIN_FIELD, parseCodexLogin } from "./cloud-model-login-vault.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * A member signs in to the vault (Stateless Compute step 1, change 2B).
 *
 * The web client's sign-in protocol is unchanged: its edge function posts the member's
 * `qorpera.native-provider-login/v1` request, with the sign-in's capability as bearer, to the
 * base the login gateway chooser named, here the company's vault. The vault checks the request
 * against the database's record of the pending sign-in, has its helper run the official Codex
 * sign-in, and answers with the link and code while the member finishes in the browser. Once
 * Codex has the login, the vault seals it under the company's broker key as version 1 and
 * completes the sign-in in one database transaction. No node is involved.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGN_IN_SCHEMA = "qorpera.native-provider-login/v1";
const RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
const SAVE_DEADLINE_MS = 15_000;
const REQUEST_KEYS = [
	"client_connection_id",
	"compute_identity_id",
	"compute_identity_owner_scope_key",
	"compute_identity_owner_user_id",
	"compute_identity_ownership_kind",
	"expires_at",
	"login_capability",
	"login_id",
	"native_harness",
	"provider",
	"schema",
];
const DESCRIPTION_KEYS = [
	"clientConnectionId",
	"computeIdentityId",
	"computeIdentityOwnerScopeKey",
	"computeIdentityOwnerUserId",
	"computeIdentityOwnershipKind",
	"expiresAt",
	"keyId",
	"loginId",
	"modelLoginId",
	"profileId",
	"schema",
	"status",
];

/** The sign-in side of the vault's database authority. */
export interface ModelLoginSignInAuthority {
	describeModelLoginSignIn(
		request: { loginId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	completeModelLoginSignIn(
		completion: {
			loginId: string;
			capabilitySha256: string;
			modelLoginId: string;
			keyId: string;
			encryptedEnvelope: Uint8Array;
			envelopeSha256: string;
			accessIssuedAt: string;
			accessExpiresAt: string;
			providerAccountReference: string | null;
			providerAccountEmail: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

/** The answer the web client reads, exactly as a node's login gateway gives it. */
export interface ModelLoginSignInAnswer {
	readonly schema: typeof RESULT_SCHEMA;
	readonly login_id: string;
	readonly status: "preparing" | "awaiting_member" | "completed";
	readonly interaction_url: string | null;
	readonly user_code: string | null;
}

interface Ownership {
	kind: string;
	userId: string | null;
	scopeKey: string | null;
}

interface SignInRequest extends Ownership {
	loginId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	expiresAt: number;
}

interface SignInDescription extends Ownership {
	loginId: string;
	companyId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	status: "pending" | "completed" | "cancelled" | "expired";
	expiresAt: string;
	keyId: string;
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
	return input;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
	return value;
}

function nullableText(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length < 1 || value.length > 160 || /[\0\r\n]/.test(value))
		throw new Error(`${label} is invalid`);
	return value;
}

function parseRequest(value: unknown, capability: string): SignInRequest {
	const input = record(value, REQUEST_KEYS, "Vault sign-in request");
	if (
		input.schema !== SIGN_IN_SCHEMA ||
		input.provider !== "openai" ||
		input.native_harness !== "codex-cli" ||
		typeof input.login_capability !== "string" ||
		!TOKEN.test(input.login_capability) ||
		!timingSafeEqual(Buffer.from(input.login_capability), Buffer.from(capability)) ||
		typeof input.expires_at !== "string"
	)
		throw new Error("Vault sign-in request is invalid");
	const expiresAt = Date.parse(input.expires_at);
	if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("Vault sign-in request has expired");
	return {
		loginId: uuid(input.login_id, "Vault sign-in id"),
		clientConnectionId: uuid(input.client_connection_id, "Vault sign-in connection id"),
		computeIdentityId: uuid(input.compute_identity_id, "Vault sign-in Compute Identity id"),
		kind: nullableText(input.compute_identity_ownership_kind, "Vault sign-in ownership") ?? "",
		userId:
			input.compute_identity_owner_user_id === null
				? null
				: uuid(input.compute_identity_owner_user_id, "Vault sign-in owner"),
		scopeKey: nullableText(input.compute_identity_owner_scope_key, "Vault sign-in owner scope"),
		expiresAt,
	};
}

function parseDescription(value: unknown): SignInDescription {
	const input = record(value, DESCRIPTION_KEYS, "Vault sign-in description");
	if (
		input.schema !== "qorpera.model-login-sign-in/v1" ||
		!["pending", "completed", "cancelled", "expired"].includes(String(input.status)) ||
		typeof input.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.expiresAt)) ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		(input.modelLoginId !== null && (typeof input.modelLoginId !== "string" || !UUID.test(input.modelLoginId)))
	)
		throw new Error("Vault sign-in description is invalid");
	return {
		loginId: uuid(input.loginId, "Vault sign-in id"),
		companyId: uuid(input.profileId, "Vault sign-in company"),
		clientConnectionId: uuid(input.clientConnectionId, "Vault sign-in connection id"),
		computeIdentityId: uuid(input.computeIdentityId, "Vault sign-in Compute Identity id"),
		kind: nullableText(input.computeIdentityOwnershipKind, "Vault sign-in ownership") ?? "",
		userId:
			input.computeIdentityOwnerUserId === null
				? null
				: uuid(input.computeIdentityOwnerUserId, "Vault sign-in owner"),
		scopeKey: nullableText(input.computeIdentityOwnerScopeKey, "Vault sign-in owner scope"),
		status: input.status as SignInDescription["status"],
		expiresAt: input.expiresAt,
		keyId: input.keyId,
	};
}

function answer(
	loginId: string,
	status: ModelLoginSignInAnswer["status"],
	prompt: { interactionUrl?: string; userCode?: string } = {},
): ModelLoginSignInAnswer {
	return {
		schema: RESULT_SCHEMA,
		login_id: loginId,
		status,
		interaction_url: prompt.interactionUrl ?? null,
		user_code: prompt.userCode ?? null,
	};
}

export class CloudModelLoginSignIns {
	readonly #authority: ModelLoginSignInAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #helper: ModelLoginSignInHelper;

	constructor(options: {
		authority: ModelLoginSignInAuthority;
		keyring: CloudSecretKeyring;
		helper: ModelLoginSignInHelper;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#helper = options.helper;
	}

	/** One poll of a member's sign-in: its state, and its completion once Codex has the login. */
	async signIn(
		request: { companyId: string; capability: string; body: unknown },
		signal: AbortSignal,
	): Promise<ModelLoginSignInAnswer> {
		if (!TOKEN.test(request.capability)) throw new Error("Vault sign-in capability is invalid");
		const login = parseRequest(request.body, request.capability);
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const describe = async (): Promise<SignInDescription> =>
			parseDescription(
				await this.#authority.describeModelLoginSignIn({ loginId: login.loginId, capabilitySha256 }, signal),
			);
		const description = await describe();
		if (
			description.loginId !== login.loginId ||
			description.companyId !== request.companyId.toLowerCase() ||
			description.clientConnectionId !== login.clientConnectionId ||
			description.computeIdentityId !== login.computeIdentityId ||
			description.kind !== login.kind ||
			description.userId !== login.userId ||
			description.scopeKey !== login.scopeKey ||
			Date.parse(description.expiresAt) !== login.expiresAt
		)
			throw new Error("Vault sign-in request crossed its authority");
		if (description.status === "completed") return answer(login.loginId, "completed");
		if (description.status !== "pending") throw new Error("Vault sign-in has ended");
		const state = await this.#helper.beginSignIn(
			{ signInId: login.loginId, expiresAt: description.expiresAt },
			signal,
		);
		if (state.status === "preparing") return answer(login.loginId, "preparing");
		if (state.status === "awaiting_member") return answer(login.loginId, "awaiting_member", state);
		if (state.status === "failed") {
			await this.#helper.finishSignIn(login.loginId, AbortSignal.timeout(10_000)).catch(() => undefined);
			throw new Error("Vault sign-in failed");
		}
		// Codex has the login: seal it as version 1 and complete the sign-in.
		const codex = parseCodexLogin(state.authJson);
		if (!this.#keys.has(description.keyId)) throw new Error("The vault does not hold the company's key");
		const modelLoginId = randomUUID();
		const envelope = this.#keys.seal(
			{ [MODEL_LOGIN_FIELD]: codex.text },
			{
				companyId: description.companyId,
				environmentId: description.computeIdentityId,
				secretId: modelLoginId,
				version: 1,
				keyId: description.keyId,
			},
		);
		try {
			await this.#authority.completeModelLoginSignIn(
				{
					loginId: login.loginId,
					capabilitySha256,
					modelLoginId,
					keyId: description.keyId,
					encryptedEnvelope: envelope,
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
					accessIssuedAt: codex.accessIssuedAt,
					accessExpiresAt: codex.accessExpiresAt,
					providerAccountReference: state.providerAccountReference ?? null,
					providerAccountEmail: state.providerAccountEmail ?? null,
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			);
		} catch (error) {
			// Another poll completed it first, or this completion's answer was lost.
			if ((await describe().catch(() => undefined))?.status !== "completed") throw error;
		} finally {
			envelope.fill(0);
		}
		await this.#helper.finishSignIn(login.loginId, AbortSignal.timeout(10_000)).catch(() => undefined);
		return answer(login.loginId, "completed");
	}
}
