import { createHash } from "node:crypto";
import type { CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import { nativeProviderAccountIdentity } from "./native-provider-account.ts";

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
		release: { loginId: string; token: string; baseVersion: number; permanent: boolean; reason: string },
		signal: AbortSignal,
	): Promise<unknown>;
	/** Takes the renewal lock of this broker's most urgent idle login, with its current version. */
	takeIdleModelLoginRenewal(signal: AbortSignal): Promise<unknown>;
	/** This broker's logins with no recorded ChatGPT account yet, with their current versions. */
	listModelLoginsWithoutAccount(signal: AbortSignal): Promise<unknown>;
	recordModelLoginAccount(
		account: { loginId: string; accountIdentity: string },
		signal: AbortSignal,
	): Promise<unknown>;
	/** One pass switching off members' old node logins that a vault login of the same account replaced. */
	switchOffReplacedNodeLogins(signal: AbortSignal): Promise<unknown>;
}

/** What one switch-off pass did: old node logins switched off, still in use, or not movable yet. */
export interface ModelLoginSwitchOff {
	readonly switchedOff: number;
	readonly waiting: number;
	readonly refused: number;
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

/** A stored version's envelope, checked against its digest. */
function parseEnvelope(input: Record<string, unknown>): { keyId: string; bytes: Uint8Array } {
	if (
		typeof input.encryptedEnvelopeBase64 !== "string" ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.envelopeSha256 !== "string"
	)
		throw new Error("Model login issue is invalid");
	const bytes = Buffer.from(input.encryptedEnvelopeBase64, "base64");
	if (
		bytes.byteLength < 1 ||
		!SHA.test(input.envelopeSha256) ||
		createHash("sha256").update(bytes).digest("hex") !== input.envelopeSha256
	)
		throw new Error("Model login envelope is invalid");
	return { keyId: input.keyId, bytes };
}

/** The renewal lock a caller was handed, taken on exactly the version it names. */
function parseRenewal(value: unknown, versionNumber: number): NonNullable<IssueResult["renewal"]> {
	const renewal = record(value, "Model login renewal");
	if (typeof renewal.keyId !== "string" || !KEY_ID.test(renewal.keyId))
		throw new Error("Model login renewal is invalid");
	const result = {
		token: uuid(renewal.token, "Model login renewal"),
		baseVersion: version(renewal.baseVersion, "Model login renewal base"),
		keyId: renewal.keyId,
	};
	if (result.baseVersion !== versionNumber) throw new Error("Model login renewal is invalid");
	return result;
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
	if (input.unchanged !== false) throw new Error("Model login issue is invalid");
	result.envelope = parseEnvelope(input);
	if (input.renewal !== null && input.renewal !== undefined)
		result.renewal = parseRenewal(input.renewal, result.version);
	return result;
}

/** An idle login the vault took to renew, or null when none is due. */
function parseIdleRenewal(value: unknown): IssueResult | null {
	const input = record(value, "Model login idle renewal");
	if (input.schema !== "qorpera.model-login-idle-renewal/v1") throw new Error("Model login idle renewal is invalid");
	if (input.renewal === null) {
		if (Object.keys(input).length !== 2) throw new Error("Model login idle renewal is invalid");
		return null;
	}
	const result: IssueResult = {
		loginId: uuid(input.loginId, "Model login"),
		companyId: uuid(input.companyId, "Model login company"),
		computeIdentityId: uuid(input.computeIdentityId, "Model login compute identity"),
		version: version(input.version, "Model login version"),
		accessExpiresAt: timestamp(input.accessExpiresAt, "Model login pass end"),
		renewing: false,
	};
	result.envelope = parseEnvelope(input);
	result.renewal = parseRenewal(input.renewal, result.version);
	return result;
}

/** Whose login an envelope holds: its company, Compute Identity and login. */
type LoginOwner = Pick<IssueResult, "loginId" | "companyId" | "computeIdentityId">;

function envelopeIdentity(issue: LoginOwner, versionNumber: number, keyId: string): CloudSecretEnvelopeIdentity {
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
		const answer = await this.#authority.issueModelLogin(binding, knownVersion, this.#renewer !== undefined, signal);
		let issue: IssueResult;
		try {
			issue = parseIssue(answer, binding, knownVersion);
		} catch (error) {
			await this.#releaseUnread(answer);
			throw error;
		}
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
		const renewed = issue.renewal ? await this.#renew(issue, issue.renewal, current) : undefined;
		const login = renewed?.login ?? current;
		if (Date.parse(login.accessExpiresAt) <= Date.now()) throw new Error("Model login pass has ended");
		return {
			schema: "qorpera.model-login/v1",
			version: renewed?.version ?? issue.version,
			accessExpiresAt: login.accessExpiresAt,
			authJson: accessOnlyCodexLogin(login.text),
		};
	}

	/** Renews this broker's most urgent idle login: one past half its pass that no starting run
	 * renewed. It takes the same lock and saves the same way as a run's renewal. `none` when no
	 * login is due, or when this vault has no renewer. */
	async renewIdle(signal: AbortSignal): Promise<"renewed" | "failed" | "none"> {
		if (!this.#renewer) return "none";
		const answer = await this.#authority.takeIdleModelLoginRenewal(signal);
		let issue: IssueResult | null;
		try {
			issue = parseIdleRenewal(answer);
		} catch (error) {
			await this.#releaseUnread(answer);
			throw error;
		}
		if (!issue?.envelope || !issue.renewal) return "none";
		let current: CodexLogin;
		try {
			current = await this.#open(issue, issue.version, issue.envelope);
		} catch {
			await this.#release(issue, issue.renewal, false, "login_unreadable");
			return "failed";
		}
		const renewed = await this.#renew(issue, issue.renewal, current);
		return renewed && renewed.version > issue.version ? "renewed" : "failed";
	}

	/** Records the ChatGPT account of each login this broker keeps that has none yet, read from its
	 * current version (the digest nodes and the vault record for usage). Returns how many it recorded;
	 * a login it cannot read is tried again at the next pass. */
	async recordAccounts(signal: AbortSignal): Promise<number> {
		const input = record(await this.#authority.listModelLoginsWithoutAccount(signal), "Model login accounts");
		if (input.schema !== "qorpera.model-login-accounts/v1" || !Array.isArray(input.logins) || input.logins.length > 8)
			throw new Error("Model login accounts are invalid");
		let recorded = 0;
		for (const item of input.logins) {
			try {
				const entry = record(item, "Model login account");
				const login: LoginOwner = {
					loginId: uuid(entry.loginId, "Model login"),
					companyId: uuid(entry.companyId, "Model login company"),
					computeIdentityId: uuid(entry.computeIdentityId, "Model login compute identity"),
				};
				const opened = await this.#open(login, version(entry.version, "Model login version"), parseEnvelope(entry));
				const accountIdentity = nativeProviderAccountIdentity(opened.text);
				if (!accountIdentity) continue;
				await this.#authority.recordModelLoginAccount({ loginId: login.loginId, accountIdentity }, signal);
				recorded += 1;
			} catch {
				// This login is tried again at the next pass; the others go on.
			}
		}
		return recorded;
	}

	/** One pass switching off members' old node logins that a vault login of the same ChatGPT account
	 * replaced (the database moves their pins first and waits for their work to finish). */
	async switchOffReplacedNodeLogins(signal: AbortSignal): Promise<ModelLoginSwitchOff> {
		const input = record(await this.#authority.switchOffReplacedNodeLogins(signal), "Model login switch-off");
		const count = (value: unknown): number => {
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 4)
				throw new Error("Model login switch-off is invalid");
			return value;
		};
		if (input.schema !== "qorpera.model-login-switch-off/v1") throw new Error("Model login switch-off is invalid");
		return { switchedOff: count(input.switchedOff), waiting: count(input.waiting), refused: count(input.refused) };
	}

	#open(
		issue: LoginOwner,
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
	): Promise<{ login: CodexLogin; version: number } | undefined> {
		const renewer = this.#renewer;
		// A key the broker cannot seal with would strand a renewal the provider already made.
		if (!renewer || !this.#keys.has(renewal.keyId)) {
			await this.#release(issue, renewal, false, renewer ? "renewal_key_unavailable" : "renewer_unavailable");
			return undefined;
		}
		let result: ModelLoginRenewal;
		try {
			// Once asked, a renewal runs to its own budget whatever the caller does: the provider may
			// already have spent the old token, and only this call can save the new one.
			result = await renewer.renew(current.text, AbortSignal.timeout(RENEWAL_BUDGET_MS));
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

	/** An answer this vault could not read may still carry a renewal lock: give it back. */
	async #releaseUnread(answer: unknown): Promise<void> {
		const input =
			answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
		const renewal =
			input.renewal && typeof input.renewal === "object" && !Array.isArray(input.renewal)
				? (input.renewal as Record<string, unknown>)
				: undefined;
		if (
			!renewal ||
			typeof input.loginId !== "string" ||
			!UUID.test(input.loginId) ||
			typeof renewal.token !== "string" ||
			!UUID.test(renewal.token) ||
			typeof renewal.baseVersion !== "number" ||
			!Number.isSafeInteger(renewal.baseVersion) ||
			renewal.baseVersion < 1
		)
			return;
		await this.#authority
			.releaseModelLoginRenewal(
				{
					loginId: input.loginId,
					token: renewal.token,
					baseVersion: renewal.baseVersion,
					permanent: false,
					reason: "issue_unreadable",
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			)
			.catch(() => undefined);
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
					baseVersion: renewal.baseVersion,
					permanent,
					reason: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "renewal_failed",
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			)
			.catch(() => undefined);
	}
}
