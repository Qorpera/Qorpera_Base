import { createHash } from "node:crypto";
import type { CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * Model logins in the vault (Stateless Compute step 1).
 *
 * The broker keeps each member's Codex login (`auth.json`) as immutable, envelope-encrypted
 * versions. A live run receives a copy without the renewal token: it can use the login but
 * never renew it, and it never writes a login back. Only the vault renews, one renewal at a
 * time per login (a lock row the database hands to one caller), through a renewer that runs
 * the official Codex. Refresh tokens are single use, so a second renewer could revoke the
 * login; the lock is what prevents that.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JWT = /^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$/;
const MAX_AUTH_JSON_BYTES = 32 * 1024;
/** The renewer gets at most this long, inside the broker route's minute. */
const RENEWAL_BUDGET_MS = 35_000;
/** Saving a renewed version or giving the lock back gets its own deadline. */
const SAVE_DEADLINE_MS = 15_000;
/** The one envelope field that holds a login. */
export const MODEL_LOGIN_FIELD = "codex_auth_json";
const BINDING_KEYS = [
	"assignmentId",
	"computeIdentityId",
	"credentialCapsuleId",
	"jobId",
	"leaseId",
	"runId",
	"runnerId",
] as const;

/** A live run's exact native lease, as the host received it. */
export interface ModelLoginRunBinding {
	readonly leaseId: string;
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
	readonly credentialCapsuleId: string;
	readonly computeIdentityId: string;
}

export interface ModelLoginIssueRequest {
	readonly binding: ModelLoginRunBinding;
	/** The version the host already holds; null at run start. */
	readonly knownVersion: number | null;
}

/** What a run's host receives. `authJson` is null when the host already holds `version`. */
export interface ModelLoginIssue {
	readonly schema: "qorpera.model-login/v1";
	readonly version: number;
	readonly accessExpiresAt: string;
	readonly authJson: string | null;
}

export interface ModelLoginAuthority {
	issueModelLogin(
		binding: ModelLoginRunBinding,
		knownVersion: number | null,
		allowRenewal: boolean,
		signal: AbortSignal,
	): Promise<unknown>;
	commitModelLoginRenewal(
		renewal: {
			loginId: string;
			token: string;
			baseVersion: number;
			keyId: string;
			encryptedEnvelope: Uint8Array;
			envelopeSha256: string;
			accessIssuedAt: string;
			accessExpiresAt: string;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	releaseModelLoginRenewal(
		release: { loginId: string; token: string; permanent: boolean; reason: string },
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Runs the official Codex against a full login to renew it. `refused` means the provider
 * rejected the renewal token (the member must sign in again); `transient` may be retried. */
export type ModelLoginRenewal =
	| { readonly outcome: "renewed"; readonly authJson: string }
	| { readonly outcome: "refused" | "transient"; readonly reason: string };

export interface ModelLoginRenewer {
	renew(authJson: string, signal: AbortSignal): Promise<ModelLoginRenewal>;
}

interface IssueResult {
	loginId: string;
	companyId: string;
	computeIdentityId: string;
	version: number;
	accessExpiresAt: string;
	renewing: boolean;
	envelope?: { keyId: string; bytes: Uint8Array };
	renewal?: { token: string; baseVersion: number; keyId: string };
}

interface CodexLogin {
	/** The whole login, renewal token included. Never leaves the vault. */
	readonly text: string;
	readonly accountId: string;
	readonly accessIssuedAt: string;
	readonly accessExpiresAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
	return value.toLowerCase();
}

function version(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} is invalid`);
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
	return new Date(Date.parse(value)).toISOString();
}

export function parseModelLoginRunBinding(value: unknown): ModelLoginRunBinding {
	const input = record(value, "Model login run binding");
	if (Object.keys(input).sort().join() !== [...BINDING_KEYS].join())
		throw new Error("Model login run binding is invalid");
	return Object.freeze({
		leaseId: uuid(input.leaseId, "Model login lease"),
		runId: uuid(input.runId, "Model login run"),
		jobId: uuid(input.jobId, "Model login job"),
		runnerId: uuid(input.runnerId, "Model login runner"),
		assignmentId: uuid(input.assignmentId, "Model login assignment"),
		credentialCapsuleId: uuid(input.credentialCapsuleId, "Model login capsule"),
		computeIdentityId: uuid(input.computeIdentityId, "Model login compute identity"),
	});
}

function jwtClaims(token: string): Record<string, unknown> {
	const matched = JWT.exec(token);
	if (!matched) throw new Error("Codex access token is invalid");
	return record(JSON.parse(Buffer.from(matched[1] as string, "base64url").toString("utf8")), "Codex access token");
}

/** The only fields a stored login may carry (Codex 0.155.1 `auth.json` for a ChatGPT login);
 * anything else, such as an agent identity record, is refused rather than handed on. */
const LOGIN_FIELDS = new Set(["auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh"]);
const TOKEN_FIELDS = new Set(["id_token", "access_token", "refresh_token", "account_id"]);

/** Reads a stored Codex ChatGPT login. Its pass times come from the access token itself. */
export function parseCodexLogin(text: string): CodexLogin {
	if (Buffer.byteLength(text, "utf8") > MAX_AUTH_JSON_BYTES) throw new Error("Codex login is too large");
	const login = record(JSON.parse(text), "Codex login");
	const tokens = record(login.tokens, "Codex login tokens");
	if (
		Object.keys(login).some((key) => !LOGIN_FIELDS.has(key)) ||
		Object.keys(tokens).some((key) => !TOKEN_FIELDS.has(key)) ||
		(login.auth_mode !== undefined && login.auth_mode !== "chatgpt") ||
		(login.last_refresh !== undefined && typeof login.last_refresh !== "string") ||
		typeof tokens.access_token !== "string" ||
		typeof tokens.refresh_token !== "string" ||
		tokens.refresh_token.length < 1 ||
		typeof tokens.id_token !== "string" ||
		typeof tokens.account_id !== "string" ||
		tokens.account_id.length < 1 ||
		(login.OPENAI_API_KEY !== undefined && login.OPENAI_API_KEY !== null)
	)
		throw new Error("Codex login is not a ChatGPT login");
	const claims = jwtClaims(tokens.access_token);
	if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error("Codex access token has no end");
	const expiresAt = claims.exp * 1000;
	const issuedAt =
		typeof claims.iat === "number" && Number.isFinite(claims.iat) && claims.iat * 1000 < expiresAt
			? claims.iat * 1000
			: Math.min(Date.now(), expiresAt - 1000);
	return Object.freeze({
		text,
		accountId: tokens.account_id,
		accessIssuedAt: new Date(issuedAt).toISOString(),
		accessExpiresAt: new Date(expiresAt).toISOString(),
	});
}

/** The copy a run receives: the login's known fields with an empty renewal token. Codex then
 * uses the pass and, near its end, re-reads the file (which the host keeps fresh) instead of
 * renewing. */
export function accessOnlyCodexLogin(text: string): string {
	parseCodexLogin(text);
	const login = JSON.parse(text) as {
		auth_mode?: string;
		tokens: { id_token: string; access_token: string; account_id: string };
		last_refresh?: string;
	};
	return `${JSON.stringify(
		{
			...(login.auth_mode === undefined ? {} : { auth_mode: login.auth_mode }),
			OPENAI_API_KEY: null,
			tokens: {
				id_token: login.tokens.id_token,
				access_token: login.tokens.access_token,
				refresh_token: "",
				account_id: login.tokens.account_id,
			},
			...(login.last_refresh === undefined ? {} : { last_refresh: login.last_refresh }),
		},
		null,
		2,
	)}\n`;
}

function parseIssue(value: unknown, binding: ModelLoginRunBinding, knownVersion: number | null): IssueResult {
	const input = record(value, "Model login issue");
	if (input.schema !== "qorpera.model-login-issue/v1" || typeof input.renewing !== "boolean")
		throw new Error("Model login issue is invalid");
	const result: IssueResult = {
		loginId: uuid(input.loginId, "Model login"),
		companyId: uuid(input.companyId, "Model login company"),
		computeIdentityId: uuid(input.computeIdentityId, "Model login compute identity"),
		version: version(input.version, "Model login version"),
		accessExpiresAt: timestamp(input.accessExpiresAt, "Model login pass end"),
		renewing: input.renewing,
	};
	if (result.computeIdentityId !== binding.computeIdentityId) throw new Error("Model login names another identity");
	if (input.unchanged === true) {
		if (knownVersion !== result.version || input.renewal !== undefined)
			throw new Error("Model login issue is invalid");
		return result;
	}
	if (input.unchanged !== false || typeof input.encryptedEnvelopeBase64 !== "string") {
		throw new Error("Model login issue is invalid");
	}
	if (typeof input.keyId !== "string" || !KEY_ID.test(input.keyId) || typeof input.envelopeSha256 !== "string")
		throw new Error("Model login issue is invalid");
	const bytes = Buffer.from(input.encryptedEnvelopeBase64, "base64");
	if (
		bytes.byteLength < 1 ||
		!SHA.test(input.envelopeSha256) ||
		createHash("sha256").update(bytes).digest("hex") !== input.envelopeSha256
	)
		throw new Error("Model login envelope is invalid");
	result.envelope = { keyId: input.keyId, bytes };
	if (input.renewal !== null && input.renewal !== undefined) {
		const renewal = record(input.renewal, "Model login renewal");
		if (typeof renewal.keyId !== "string" || !KEY_ID.test(renewal.keyId))
			throw new Error("Model login renewal is invalid");
		result.renewal = {
			token: uuid(renewal.token, "Model login renewal"),
			baseVersion: version(renewal.baseVersion, "Model login renewal base"),
			keyId: renewal.keyId,
		};
		if (result.renewal.baseVersion !== result.version) throw new Error("Model login renewal is invalid");
	}
	return result;
}

function envelopeIdentity(issue: IssueResult, versionNumber: number, keyId: string): CloudSecretEnvelopeIdentity {
	return {
		companyId: issue.companyId,
		environmentId: issue.computeIdentityId,
		secretId: issue.loginId,
		version: versionNumber,
		keyId,
	};
}

export class CloudModelLoginVault {
	readonly #authority: ModelLoginAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #renewer: ModelLoginRenewer | undefined;

	constructor(options: { authority: ModelLoginAuthority; keyring: CloudSecretKeyring; renewer?: ModelLoginRenewer }) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#renewer = options.renewer;
	}

	/** Hands a live run its login: the current version, renewed first when it is past half its
	 * pass life and this call wins the renewal lock. Never the renewal token. */
	async issue(request: ModelLoginIssueRequest, signal: AbortSignal): Promise<ModelLoginIssue> {
		const binding = parseModelLoginRunBinding(request.binding);
		const knownVersion = request.knownVersion === null ? null : version(request.knownVersion, "Known login version");
		const issue = parseIssue(
			await this.#authority.issueModelLogin(binding, knownVersion, this.#renewer !== undefined, signal),
			binding,
			knownVersion,
		);
		if (!issue.envelope) {
			return {
				schema: "qorpera.model-login/v1",
				version: issue.version,
				accessExpiresAt: issue.accessExpiresAt,
				authJson: null,
			};
		}
		let current: CodexLogin;
		try {
			current = await this.#open(issue, issue.version, issue.envelope);
		} catch (error) {
			if (issue.renewal) await this.#release(issue, issue.renewal, false, "login_unreadable");
			throw error;
		}
		const renewed = issue.renewal ? await this.#renew(issue, issue.renewal, current, signal) : undefined;
		const login = renewed?.login ?? current;
		if (Date.parse(login.accessExpiresAt) <= Date.now()) throw new Error("Model login pass has ended");
		return {
			schema: "qorpera.model-login/v1",
			version: renewed?.version ?? issue.version,
			accessExpiresAt: login.accessExpiresAt,
			authJson: accessOnlyCodexLogin(login.text),
		};
	}

	#open(
		issue: IssueResult,
		versionNumber: number,
		envelope: { keyId: string; bytes: Uint8Array },
	): Promise<CodexLogin> {
		return this.#keys.use(envelope.bytes, envelopeIdentity(issue, versionNumber, envelope.keyId), async (fields) => {
			const text = fields[MODEL_LOGIN_FIELD];
			if (typeof text !== "string" || Object.keys(fields).length !== 1)
				throw new Error("Model login envelope is invalid");
			return parseCodexLogin(text);
		});
	}

	/** Renews under the lock this call holds. Every way out gives the lock back: a refused
	 * renewal, or one the provider made but the vault could not save (its old renewal token is
	 * spent), also marks the login for a new sign-in. This run keeps the newest pass it has. */
	async #renew(
		issue: IssueResult,
		renewal: NonNullable<IssueResult["renewal"]>,
		current: CodexLogin,
		signal: AbortSignal,
	): Promise<{ login: CodexLogin; version: number } | undefined> {
		const renewer = this.#renewer;
		// A key the broker cannot seal with would strand a renewal the provider already made.
		if (!renewer || !this.#keys.has(renewal.keyId)) {
			await this.#release(issue, renewal, false, renewer ? "renewal_key_unavailable" : "renewer_unavailable");
			return undefined;
		}
		let result: ModelLoginRenewal;
		try {
			// The renewer's budget leaves room to save within the caller's minute.
			result = await renewer.renew(current.text, AbortSignal.any([signal, AbortSignal.timeout(RENEWAL_BUDGET_MS)]));
		} catch {
			result = { outcome: "transient", reason: "renewer_failed" };
		}
		if (result.outcome !== "renewed") {
			await this.#release(issue, renewal, result.outcome === "refused", result.reason);
			return undefined;
		}
		let renewed: CodexLogin;
		try {
			renewed = parseCodexLogin(result.authJson);
			if (
				renewed.accountId !== current.accountId ||
				Date.parse(renewed.accessExpiresAt) <= Date.parse(current.accessExpiresAt)
			)
				throw new Error("Renewed login is not a newer pass of the same account");
		} catch {
			await this.#release(issue, renewal, false, "renewal_invalid");
			return undefined;
		}
		const next = renewal.baseVersion + 1;
		// The provider has already spent the old renewal token: this version is the only copy of
		// the new one. Saving has its own deadline, apart from the caller's, and a repeated save
		// after a lost answer finds its version saved. If it is still not saved, this run keeps
		// the new pass and the login asks for a new sign-in.
		try {
			const envelope = this.#keys.seal(
				{ [MODEL_LOGIN_FIELD]: renewed.text },
				envelopeIdentity(issue, next, renewal.keyId),
			);
			const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const saved = record(
						await this.#authority.commitModelLoginRenewal(
							{
								loginId: issue.loginId,
								token: renewal.token,
								baseVersion: renewal.baseVersion,
								keyId: renewal.keyId,
								encryptedEnvelope: envelope,
								envelopeSha256,
								accessIssuedAt: renewed.accessIssuedAt,
								accessExpiresAt: renewed.accessExpiresAt,
							},
							AbortSignal.timeout(SAVE_DEADLINE_MS),
						),
						"Model login renewal",
					);
					if (saved.schema !== "qorpera.model-login-renewal/v1" || saved.version !== next)
						throw new Error("Model login renewal was not saved");
					return { login: renewed, version: next };
				} catch {
					// Try again: the database answer may have been lost after the save.
				}
			}
		} catch {
			// Sealing failed: fall through to give the lock back.
		}
		await this.#release(issue, renewal, true, "renewal_unsaved");
		return { login: renewed, version: renewal.baseVersion };
	}

	async #release(
		issue: IssueResult,
		renewal: NonNullable<IssueResult["renewal"]>,
		permanent: boolean,
		reason: string,
	): Promise<void> {
		await this.#authority
			.releaseModelLoginRenewal(
				{
					loginId: issue.loginId,
					token: renewal.token,
					permanent,
					reason: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "renewal_failed",
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			)
			.catch(() => undefined);
	}
}
