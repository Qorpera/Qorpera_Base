import { createHash } from "node:crypto";
import {
	CHATGPT_PLAN_LOGIN_FIELD,
	type ChatGptPlanLogin,
	type ChatGptPlanOAuth,
	parseChatGptPlanLogin,
	serializeChatGptPlanLogin,
} from "./cloud-chatgpt-plan.ts";
import type {
	CloudSecretEnvelopeIdentity,
	CloudSecretKeyring,
	CloudSecretMemberEnvelopeIdentity,
} from "./cloud-secret-crypto.ts";
import { chatGptPlanAccountIdentity, nativeProviderAccountIdentity } from "./native-provider-account.ts";

/**
 * Model logins in the vault (Stateless Compute step 1).
 *
 * The broker keeps each member's Codex login (`auth.json`) as immutable, envelope-encrypted
 * versions. A live run receives a copy without the renewal token: it can use the login but
 * never renew it, and it never writes a login back. Only the vault renews, one renewal at a
 * time per login (a lock row the database hands to one caller), through a renewer that runs
 * the official Codex. Refresh tokens are single use, so a second renewer could revoke the
 * login; the lock is what prevents that.
 *
 * A ChatGPT plan login (Sign in with ChatGPT, built switched off) is kept the same way under the same
 * lock. The vault renews it itself with OpenAI's token endpoint (no Codex), hands a run only its access
 * token, and ends it at OpenAI once nothing uses it.
 *
 * An account login (founder, 3 November 2026) is a member's Codex login kept once by the shared vault and used in
 * every company of the member that the vault serves: the run's answer names its member, the vault opens it with that
 * member's key, and only the shared vault's own calls (its principal) save or give back its renewal.
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

/** What a run's host receives for a Codex login. `authJson` is null when the host already holds
 * `version`. Exactly these keys: hosts parse them strictly. */
export interface ModelLoginCodexIssue {
	readonly schema: "qorpera.model-login/v1";
	readonly version: number;
	readonly accessExpiresAt: string;
	readonly authJson: string | null;
}

/** What a run's host receives for a ChatGPT plan login: the access token alone (null when the host
 * already holds `version`), never the refresh token. */
export interface ModelLoginPlanIssue {
	readonly schema: "qorpera.model-login/v1";
	readonly loginKind: "chatgpt_plan";
	readonly version: number;
	readonly accessExpiresAt: string;
	readonly accessToken: string | null;
}

export type ModelLoginIssue = ModelLoginCodexIssue | ModelLoginPlanIssue;

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
	commitChatGptPlanRenewal(
		renewal: Parameters<ModelLoginAuthority["commitModelLoginRenewal"]>[0] & { renewNotBefore: string | null },
		signal: AbortSignal,
	): Promise<unknown>;
	/** Takes, under its renewal lock, one plan login nothing uses any longer, with its current version. */
	takeChatGptPlanRevocation(signal: AbortSignal): Promise<unknown>;
	finishChatGptPlanRevocation(
		revocation: { loginId: string; token: string; baseVersion: number },
		signal: AbortSignal,
	): Promise<unknown>;
}

/** The shared vault's own side of account logins (its principal): their renewals, the idle pass, their accounts and
 * the switch-off of the logins they replaced. */
export interface AccountModelLoginAuthority {
	commitAccountModelLoginRenewal(
		renewal: Parameters<ModelLoginAuthority["commitModelLoginRenewal"]>[0],
		signal: AbortSignal,
	): Promise<unknown>;
	releaseAccountModelLoginRenewal(
		release: Parameters<ModelLoginAuthority["releaseModelLoginRenewal"]>[0],
		signal: AbortSignal,
	): Promise<unknown>;
	/** Takes the renewal lock of the vault's most urgent idle account login that is still used somewhere. */
	takeIdleAccountModelLoginRenewal(signal: AbortSignal): Promise<unknown>;
	listAccountModelLoginsWithoutAccount(signal: AbortSignal): Promise<unknown>;
	recordAccountModelLoginAccount(
		account: { loginId: string; accountIdentity: string },
		signal: AbortSignal,
	): Promise<unknown>;
	/** One pass switching off members' older logins of the same account in the companies an account login is linked into. */
	switchOffReplacedByAccountLogins(signal: AbortSignal): Promise<unknown>;
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
	loginKind: "codex" | "chatgpt_plan";
	/** A company login's company and identity; a run's account login names the run's company and identity too. */
	companyId?: string;
	computeIdentityId?: string;
	/** An account login's member: the vault opens it with that member's key. */
	ownerUserId?: string;
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

/** A stored login opened: the envelope's one field says which kind it is. */
type OpenedLogin =
	| { readonly kind: "codex"; readonly codex: CodexLogin }
	| { readonly kind: "chatgpt_plan"; readonly plan: ChatGptPlanLogin };

function loginKind(value: unknown): "codex" | "chatgpt_plan" {
	// A database before plan logins names no kind: every login was a Codex login.
	if (value === undefined || value === "codex") return "codex";
	if (value === "chatgpt_plan") return value;
	throw new Error("Model login kind is invalid");
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
		loginKind: loginKind(input.loginKind),
		companyId: uuid(input.companyId, "Model login company"),
		computeIdentityId: uuid(input.computeIdentityId, "Model login compute identity"),
		version: version(input.version, "Model login version"),
		accessExpiresAt: timestamp(input.accessExpiresAt, "Model login pass end"),
		renewing: input.renewing,
	};
	if (result.computeIdentityId !== binding.computeIdentityId) throw new Error("Model login names another identity");
	if (input.scope !== undefined) {
		// An account login (20260930548000): a Codex login of one member, opened with that member's key.
		if (input.scope !== "account" || result.loginKind !== "codex") throw new Error("Model login issue is invalid");
		result.ownerUserId = uuid(input.ownerUserId, "Model login member");
	} else if (input.ownerUserId !== undefined) throw new Error("Model login issue is invalid");
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
		loginKind: loginKind(input.loginKind),
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

/** The shared vault's idle account login, or null when none is due. */
function parseIdleAccountRenewal(value: unknown): IssueResult | null {
	const input = record(value, "Account model login idle renewal");
	if (input.schema !== "qorpera.account-model-login-idle-renewal/v1")
		throw new Error("Account model login idle renewal is invalid");
	if (input.renewal === null) {
		if (Object.keys(input).length !== 2) throw new Error("Account model login idle renewal is invalid");
		return null;
	}
	const result: IssueResult = {
		loginId: uuid(input.loginId, "Model login"),
		loginKind: loginKind(input.loginKind),
		ownerUserId: uuid(input.ownerUserId, "Model login member"),
		version: version(input.version, "Model login version"),
		accessExpiresAt: timestamp(input.accessExpiresAt, "Model login pass end"),
		renewing: false,
	};
	if (result.loginKind !== "codex") throw new Error("Account model login idle renewal is invalid");
	result.envelope = parseEnvelope(input);
	result.renewal = parseRenewal(input.renewal, result.version);
	return result;
}

/** Whose login an envelope holds: a company login's company, Compute Identity and login, or an account login's
 * member and login. */
type LoginOwner = Pick<IssueResult, "loginId" | "companyId" | "computeIdentityId" | "ownerUserId">;

/** The envelope identity of a company login; an account login has a member identity instead. */
function sealedIdentity(
	owner: LoginOwner,
	versionNumber: number,
	keyId: string,
): { readonly member: CloudSecretMemberEnvelopeIdentity } | { readonly company: CloudSecretEnvelopeIdentity } {
	if (owner.ownerUserId !== undefined)
		return { member: { memberId: owner.ownerUserId, loginId: owner.loginId, version: versionNumber, keyId } };
	if (owner.companyId === undefined || owner.computeIdentityId === undefined)
		throw new Error("Model login owner is invalid");
	return {
		company: {
			companyId: owner.companyId,
			environmentId: owner.computeIdentityId,
			secretId: owner.loginId,
			version: versionNumber,
			keyId,
		},
	};
}

export class CloudModelLoginVault {
	readonly #authority: ModelLoginAuthority | undefined;
	/** The shared vault's own calls for account logins; absent, an account login is never handed out here. */
	readonly #account: AccountModelLoginAuthority | undefined;
	readonly #keys: CloudSecretKeyring;
	readonly #renewer: ModelLoginRenewer | undefined;

	/** OpenAI's side of ChatGPT plan logins; absent (no plan client configured), none is renewed or ended. */
	readonly #plan: ChatGptPlanOAuth | undefined;

	constructor(options: {
		/** A company's broker authority; absent for the shared vault's own account pass. */
		authority?: ModelLoginAuthority;
		accountAuthority?: AccountModelLoginAuthority;
		keyring: CloudSecretKeyring;
		renewer?: ModelLoginRenewer;
		chatGptPlan?: ChatGptPlanOAuth;
	}) {
		if (!options.authority && !options.accountAuthority) throw new Error("Model login vault needs an authority");
		this.#authority = options.authority;
		this.#account = options.accountAuthority;
		this.#keys = options.keyring;
		this.#renewer = options.renewer;
		this.#plan = options.chatGptPlan;
	}

	get #company(): ModelLoginAuthority {
		if (!this.#authority) throw new Error("Model login vault serves no company");
		return this.#authority;
	}

	/** Hands a live run its login: the current version, renewed first when it is due and this call
	 * wins the renewal lock. Never the renewal token. */
	async issue(request: ModelLoginIssueRequest, signal: AbortSignal): Promise<ModelLoginIssue> {
		const binding = parseModelLoginRunBinding(request.binding);
		const knownVersion = request.knownVersion === null ? null : version(request.knownVersion, "Known login version");
		// The database decides whether the login is due; a lock this vault cannot use for the login's kind
		// is given back at once.
		const canRenew = this.#renewer !== undefined || this.#plan !== undefined;
		const answer = await this.#company.issueModelLogin(binding, knownVersion, canRenew, signal);
		let issue: IssueResult;
		try {
			issue = parseIssue(answer, binding, knownVersion);
			if (issue.ownerUserId !== undefined && !this.#account)
				throw new Error("Account model logins are not served here");
		} catch (error) {
			await this.#releaseUnread(answer);
			throw error;
		}
		if (!issue.envelope) {
			return issue.loginKind === "chatgpt_plan"
				? {
						schema: "qorpera.model-login/v1",
						loginKind: "chatgpt_plan",
						version: issue.version,
						accessExpiresAt: issue.accessExpiresAt,
						accessToken: null,
					}
				: {
						schema: "qorpera.model-login/v1",
						version: issue.version,
						accessExpiresAt: issue.accessExpiresAt,
						authJson: null,
					};
		}
		let current: OpenedLogin;
		try {
			current = await this.#open(issue, issue.version, issue.envelope);
			if (current.kind !== issue.loginKind) throw new Error("Model login envelope is another kind of login");
		} catch (error) {
			if (issue.renewal) await this.#release(issue, issue.renewal, false, "login_unreadable");
			throw error;
		}
		if (current.kind === "chatgpt_plan") {
			const renewed = issue.renewal ? await this.#renewPlan(issue, issue.renewal, current.plan) : undefined;
			const login = renewed?.login ?? current.plan;
			if (Date.parse(login.accessExpiresAt) <= Date.now()) throw new Error("Model login pass has ended");
			return {
				schema: "qorpera.model-login/v1",
				loginKind: "chatgpt_plan",
				version: renewed?.version ?? issue.version,
				accessExpiresAt: login.accessExpiresAt,
				accessToken: login.accessToken,
			};
		}
		const renewed = issue.renewal ? await this.#renew(issue, issue.renewal, current.codex) : undefined;
		const login = renewed?.login ?? current.codex;
		if (Date.parse(login.accessExpiresAt) <= Date.now()) throw new Error("Model login pass has ended");
		return {
			schema: "qorpera.model-login/v1",
			version: renewed?.version ?? issue.version,
			accessExpiresAt: login.accessExpiresAt,
			authJson: accessOnlyCodexLogin(login.text),
		};
	}

	/** Renews this broker's most urgent idle login: a Codex login past half its pass that no starting
	 * run renewed, or a plan login whose tokens are a week old. It takes the same lock and saves the same
	 * way as a run's renewal. `none` when no login is due, or when this vault renews nothing. */
	async renewIdle(signal: AbortSignal): Promise<"renewed" | "failed" | "none"> {
		if (!this.#renewer && !this.#plan) return "none";
		return this.#renewTaken(await this.#company.takeIdleModelLoginRenewal(signal), parseIdleRenewal);
	}

	/** The shared vault's one idle pass over its account logins: renews the most urgent idle account login still used
	 * in some company, under the same lock a run's renewal takes. `none` when none is due or nothing renews here. */
	async renewIdleAccount(signal: AbortSignal): Promise<"renewed" | "failed" | "none"> {
		const account = this.#account;
		if (!account || !this.#renewer) return "none";
		return this.#renewTaken(await account.takeIdleAccountModelLoginRenewal(signal), parseIdleAccountRenewal);
	}

	async #renewTaken(
		answer: unknown,
		parse: (value: unknown) => IssueResult | null,
	): Promise<"renewed" | "failed" | "none"> {
		let issue: IssueResult | null;
		try {
			issue = parse(answer);
		} catch (error) {
			await this.#releaseUnread(answer);
			throw error;
		}
		if (!issue?.envelope || !issue.renewal) return "none";
		let current: OpenedLogin;
		try {
			current = await this.#open(issue, issue.version, issue.envelope);
			if (current.kind !== issue.loginKind) throw new Error("Model login envelope is another kind of login");
		} catch {
			await this.#release(issue, issue.renewal, false, "login_unreadable");
			return "failed";
		}
		const renewed =
			current.kind === "chatgpt_plan"
				? await this.#renewPlan(issue, issue.renewal, current.plan)
				: await this.#renew(issue, issue.renewal, current.codex);
		return renewed && renewed.version > issue.version ? "renewed" : "failed";
	}

	/** Ends one plan login nothing uses any longer (its member disconnected or left) at OpenAI, then marks
	 * it revoked. `none` when there is none, or when this vault has no plan client; `failed` leaves the
	 * login to a later pass (its lock lapses). */
	async revokeUnused(signal: AbortSignal): Promise<"revoked" | "failed" | "none"> {
		const plan = this.#plan;
		if (!plan) return "none";
		const input = record(await this.#company.takeChatGptPlanRevocation(signal), "ChatGPT plan revocation");
		if (input.schema !== "qorpera.chatgpt-plan-revocation/v1") throw new Error("ChatGPT plan revocation is invalid");
		if (input.revocation === null) return "none";
		const revocation = record(input.revocation, "ChatGPT plan revocation");
		const owner: LoginOwner = {
			loginId: uuid(input.loginId, "Model login"),
			companyId: uuid(input.companyId, "Model login company"),
			computeIdentityId: uuid(input.computeIdentityId, "Model login compute identity"),
		};
		const baseVersion = version(input.version, "Model login version");
		const token = uuid(revocation.token, "ChatGPT plan revocation");
		if (version(revocation.baseVersion, "ChatGPT plan revocation base") !== baseVersion)
			throw new Error("ChatGPT plan revocation is invalid");
		let opened: OpenedLogin;
		try {
			opened = await this.#open(owner, baseVersion, parseEnvelope(input));
		} catch {
			return "failed";
		}
		if (opened.kind !== "chatgpt_plan") return "failed";
		if ((await plan.revoke(opened.plan.refreshToken, AbortSignal.timeout(RENEWAL_BUDGET_MS))) !== "revoked")
			return "failed";
		const finished = record(
			await this.#company.finishChatGptPlanRevocation(
				{ loginId: owner.loginId, token, baseVersion },
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			),
			"ChatGPT plan revocation",
		);
		if (finished.schema !== "qorpera.chatgpt-plan-revocation-finished/v1")
			throw new Error("ChatGPT plan revocation is invalid");
		return "revoked";
	}

	/** Records the ChatGPT account of each login this broker keeps that has none yet, read from its
	 * current version: a Codex login's account (the digest nodes and the vault record for usage), a plan
	 * login's verified OpenAI subject (20260930059000), so a member who signs in again with the same one
	 * keeps what they started. Returns how many it recorded; a login it cannot read is tried again at the
	 * next pass. */
	async recordAccounts(signal: AbortSignal): Promise<number> {
		const input = record(await this.#company.listModelLoginsWithoutAccount(signal), "Model login accounts");
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
				const accountIdentity =
					opened.kind === "codex"
						? nativeProviderAccountIdentity(opened.codex.text)
						: chatGptPlanAccountIdentity(opened.plan.subject);
				if (!accountIdentity) continue;
				await this.#company.recordModelLoginAccount({ loginId: login.loginId, accountIdentity }, signal);
				recorded += 1;
			} catch {
				// This login is tried again at the next pass; the others go on.
			}
		}
		return recorded;
	}

	/** The shared vault's account logins with no recorded ChatGPT account yet, as recordAccounts does for a company's
	 * logins: the switch-off pass pairs a member's older logins of the same account with them. */
	async recordAccountLogins(signal: AbortSignal): Promise<number> {
		const account = this.#account;
		if (!account) return 0;
		const input = record(await account.listAccountModelLoginsWithoutAccount(signal), "Account model login accounts");
		if (
			input.schema !== "qorpera.account-model-login-accounts/v1" ||
			!Array.isArray(input.logins) ||
			input.logins.length > 8
		)
			throw new Error("Account model login accounts are invalid");
		let recorded = 0;
		for (const item of input.logins) {
			try {
				const entry = record(item, "Account model login account");
				const login: LoginOwner = {
					loginId: uuid(entry.loginId, "Model login"),
					ownerUserId: uuid(entry.ownerUserId, "Model login member"),
				};
				const opened = await this.#open(login, version(entry.version, "Model login version"), parseEnvelope(entry));
				if (opened.kind !== "codex") continue;
				const accountIdentity = nativeProviderAccountIdentity(opened.codex.text);
				if (!accountIdentity) continue;
				await account.recordAccountModelLoginAccount({ loginId: login.loginId, accountIdentity }, signal);
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
		return parseSwitchOff(await this.#company.switchOffReplacedNodeLogins(signal));
	}

	/** The same pass for account logins, across the companies the shared vault serves. */
	async switchOffReplacedByAccountLogins(signal: AbortSignal): Promise<ModelLoginSwitchOff> {
		const account = this.#account;
		if (!account) return { switchedOff: 0, waiting: 0, refused: 0 };
		return parseSwitchOff(await account.switchOffReplacedByAccountLogins(signal));
	}

	#open(
		owner: LoginOwner,
		versionNumber: number,
		envelope: { keyId: string; bytes: Uint8Array },
	): Promise<OpenedLogin> {
		const read = async (fields: Readonly<Record<string, string>>): Promise<OpenedLogin> => {
			if (Object.keys(fields).length !== 1) throw new Error("Model login envelope is invalid");
			const codex = fields[MODEL_LOGIN_FIELD];
			if (typeof codex === "string") return { kind: "codex", codex: parseCodexLogin(codex) };
			const plan = fields[CHATGPT_PLAN_LOGIN_FIELD];
			if (typeof plan === "string") return { kind: "chatgpt_plan", plan: parseChatGptPlanLogin(plan) };
			throw new Error("Model login envelope is invalid");
		};
		const identity = sealedIdentity(owner, versionNumber, envelope.keyId);
		return "member" in identity
			? this.#keys.useMember(envelope.bytes, identity.member, read)
			: this.#keys.use(envelope.bytes, identity.company, read);
	}

	#seal(
		owner: LoginOwner,
		fields: Readonly<Record<string, string>>,
		versionNumber: number,
		keyId: string,
	): Uint8Array {
		const identity = sealedIdentity(owner, versionNumber, keyId);
		return "member" in identity
			? this.#keys.sealMember(fields, identity.member)
			: this.#keys.seal(fields, identity.company);
	}

	/** Whether this vault can seal the login's next version under the lock's key: an account login needs the shared
	 * vault's master key (its member's key is derived from it). */
	#canSeal(owner: LoginOwner, keyId: string): boolean {
		return owner.ownerUserId !== undefined ? this.#keys.hasMemberKey(keyId) : this.#keys.has(keyId);
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
		if (!renewer || !this.#canSeal(issue, renewal.keyId)) {
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
			const envelope = this.#seal(issue, { [MODEL_LOGIN_FIELD]: renewed.text }, next, renewal.keyId);
			const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
			const commit = {
				loginId: issue.loginId,
				token: renewal.token,
				baseVersion: renewal.baseVersion,
				keyId: renewal.keyId,
				encryptedEnvelope: envelope,
				envelopeSha256,
				accessIssuedAt: renewed.accessIssuedAt,
				accessExpiresAt: renewed.accessExpiresAt,
			};
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const signal = AbortSignal.timeout(SAVE_DEADLINE_MS);
					const saved = record(
						issue.ownerUserId !== undefined
							? await this.#accountAuthority.commitAccountModelLoginRenewal(commit, signal)
							: await this.#company.commitModelLoginRenewal(commit, signal),
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

	get #accountAuthority(): AccountModelLoginAuthority {
		if (!this.#account) throw new Error("Account model logins are not served here");
		return this.#account;
	}

	/** Renews a plan login under the lock this call holds, with OpenAI's token endpoint. As with a Codex
	 * login, every way out gives the lock back, and a renewal OpenAI made but the vault could not save (the
	 * old refresh token is spent) marks the login for a new sign-in; this run keeps the newest pass. */
	async #renewPlan(
		issue: IssueResult,
		renewal: NonNullable<IssueResult["renewal"]>,
		current: ChatGptPlanLogin,
	): Promise<{ login: ChatGptPlanLogin; version: number } | undefined> {
		const plan = this.#plan;
		// A plan login is a company login only.
		if (!plan || issue.ownerUserId !== undefined || !this.#keys.has(renewal.keyId)) {
			await this.#release(issue, renewal, false, plan ? "renewal_key_unavailable" : "renewer_unavailable");
			return undefined;
		}
		// Once asked, a renewal runs to its own budget whatever the caller does.
		const result = await plan.refresh(current, AbortSignal.timeout(RENEWAL_BUDGET_MS));
		if (result.outcome !== "renewed") {
			await this.#release(issue, renewal, result.outcome === "refused", result.reason);
			return undefined;
		}
		const renewed = result.login;
		// OpenAI already spent the old refresh token: a pass the database would refuse (not later than the one
		// it holds) cannot be saved, so the login asks for a new sign-in and the new token is ended.
		if (Date.parse(renewed.accessExpiresAt) <= Date.parse(current.accessExpiresAt)) {
			await plan.revoke(renewed.refreshToken, AbortSignal.timeout(SAVE_DEADLINE_MS)).catch(() => undefined);
			await this.#release(issue, renewal, true, "renewal_invalid");
			return undefined;
		}
		const next = renewal.baseVersion + 1;
		try {
			const envelope = this.#seal(
				issue,
				{ [CHATGPT_PLAN_LOGIN_FIELD]: serializeChatGptPlanLogin(renewed) },
				next,
				renewal.keyId,
			);
			const envelopeSha256 = createHash("sha256").update(envelope).digest("hex");
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const saved = record(
						await this.#company.commitChatGptPlanRenewal(
							{
								loginId: issue.loginId,
								token: renewal.token,
								baseVersion: renewal.baseVersion,
								keyId: renewal.keyId,
								encryptedEnvelope: envelope,
								envelopeSha256,
								accessIssuedAt: renewed.accessIssuedAt,
								accessExpiresAt: renewed.accessExpiresAt,
								renewNotBefore: renewed.renewNotBefore,
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

	/** An answer this vault could not read may still carry a renewal lock: give it back, to the shared vault for an
	 * account login. */
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
		const release = {
			loginId: input.loginId,
			token: renewal.token,
			baseVersion: renewal.baseVersion,
			permanent: false,
			reason: "issue_unreadable",
		};
		const account = input.scope === "account" || input.ownerUserId !== undefined;
		if (account && !this.#account) return;
		await (account
			? this.#accountAuthority.releaseAccountModelLoginRenewal(release, AbortSignal.timeout(SAVE_DEADLINE_MS))
			: this.#company.releaseModelLoginRenewal(release, AbortSignal.timeout(SAVE_DEADLINE_MS))
		).catch(() => undefined);
	}

	async #release(
		issue: IssueResult,
		renewal: NonNullable<IssueResult["renewal"]>,
		permanent: boolean,
		reason: string,
	): Promise<void> {
		const release = {
			loginId: issue.loginId,
			token: renewal.token,
			baseVersion: renewal.baseVersion,
			permanent,
			reason: /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "renewal_failed",
		};
		try {
			await (issue.ownerUserId !== undefined
				? this.#accountAuthority.releaseAccountModelLoginRenewal(release, AbortSignal.timeout(SAVE_DEADLINE_MS))
				: this.#company.releaseModelLoginRenewal(release, AbortSignal.timeout(SAVE_DEADLINE_MS)));
		} catch {
			// The lock lapses by itself after 5 minutes.
		}
	}
}

function parseSwitchOff(value: unknown): ModelLoginSwitchOff {
	const input = record(value, "Model login switch-off");
	const count = (item: unknown): number => {
		if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0 || item > 4)
			throw new Error("Model login switch-off is invalid");
		return item;
	};
	if (input.schema !== "qorpera.model-login-switch-off/v1") throw new Error("Model login switch-off is invalid");
	return { switchedOff: count(input.switchedOff), waiting: count(input.waiting), refused: count(input.refused) };
}
