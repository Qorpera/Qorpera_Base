import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA,
	nativeAccountRefreshBody,
	parseNativeAccountRefreshDescription,
	parseNativeAccountRefreshRequest,
} from "@qorpera/cloud-client/native-account-refresh";
import type { ClaudeLoginReads } from "./cloud-claude-login-reader.ts";
import {
	CLAUDE_RESET_KINDS,
	type ClaudeLoginResets,
	type ClaudeLoginUsage,
	type ClaudeResetKind,
	type ClaudeResetOutcome,
} from "./cloud-claude-login-usage.ts";
import { MODEL_LOGIN_FIELD, parseCodexLogin } from "./cloud-model-login-vault.ts";
import { CLAUDE_LOGIN_FIELD, checkClaudeLoginFiles } from "./cloud-model-login-vault-sign-in.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";
import { nativeProviderAccountEmail, nativeProviderAccountIdentity } from "./native-provider-account.ts";
import { type NativeProviderAccountUsage, readNativeProviderAccountUsage } from "./native-provider-usage.ts";

/**
 * The vault reads the usage of the logins it keeps (Stateless Compute step 1, change 2C).
 *
 * The web client's account refresh is unchanged: its edge function posts
 * `qorpera.native-account-refresh/v1` to the base the account refresh chooser named, here the
 * company's vault, with the refresh's capability as bearer. The vault reads the database's record
 * of the refresh and the current version of each vault login of that identity, opens each one,
 * reads its usage with the pass (the same `wham/usage` call a node makes, no machine), records the
 * display metadata, and completes the refresh. The pass is never renewed here.
 *
 * The daily usage check (migration 20260930575000) is the same refresh, which the vault asks for itself: the database
 * names one login at its usage limit that is due a reading (once a day, and once a reset it named has passed) and makes
 * a refresh of its member's identity under a capability the vault made for that one refresh. A reading with room ends
 * the login's wall, and the refresh's completion brings the runs paused on it back.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_LOGINS = 8;
/** Each usage read gets this long; the whole refresh stays inside the edge function's 30 s. */
const USAGE_DEADLINE_MS = 8_000;
const SAVE_DEADLINE_MS = 5_000;

/** The usage side of the vault's database authority. */
export interface ModelLoginUsageAuthority {
	describeModelLoginAccountRefresh(
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	recordModelLoginAccountMetadata(
		record: {
			requestId: string;
			capabilitySha256: string;
			loginId: string;
			connectionId: string;
			connectionVersion: number;
			providerAccountEmail: string | null;
			providerAccountUsage: NativeProviderAccountUsage | null;
			providerAccountIdentity: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	completeModelLoginAccountRefresh(
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	/** The daily usage check's refresh, if a login is due one (qorpera_begin_model_login_usage_recheck). */
	beginModelLoginUsageRecheck?(request: { capabilitySha256: string }, signal: AbortSignal): Promise<unknown>;
	describeClaudeLoginRead?(
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	claimClaudeLoginReset?(
		request: { requestId: string; capabilitySha256: string; claim: string },
		signal: AbortSignal,
	): Promise<unknown>;
	recordClaudeLoginRead?(
		record: {
			requestId: string;
			capabilitySha256: string;
			usage: ClaudeLoginUsage | null;
			resets: ClaudeLoginResets | null;
			reset: ClaudeResetOutcome | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

const CLAUDE_READ_SCHEMA = "qorpera.claude-login-read-description/v1";
const CLAUDE_READ_MS = 23_000;
const CLAUDE_RESET_MS = 80_000;
const CLAUDE_SAVE_ATTEMPTS = 6;
const CLAUDE_SAVE_RETRY_MS = 2_000;
const CLAUDE_CLAIM_RETRY_MS = 300;

type ClaudeReadDescription =
	| { readonly state: "none" | "completed" }
	| {
			readonly state: "open";
			readonly claudeLoginId: string;
			readonly ownerUserId: string;
			readonly keyId: string;
			readonly version: number;
			readonly envelope: Uint8Array;
			readonly usage: boolean;
			readonly resets: boolean;
			readonly reset: ClaudeResetKind | null;
			readonly resetState: "asked" | "using" | "reset" | "failed" | "unconfirmed" | null;
	  };

function parseClaudeRead(value: unknown): ClaudeReadDescription {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== "object" || input.schema !== CLAUDE_READ_SCHEMA)
		throw new Error("Vault Claude read is invalid");
	if (input.state === "none" || input.state === "completed") {
		record(input, ["schema", "state"], "Vault Claude read");
		return { state: input.state };
	}
	record(
		input,
		[
			"schema",
			"state",
			"claudeLoginId",
			"ownerUserId",
			"keyId",
			"version",
			"envelopeSha256",
			"encryptedEnvelopeBase64",
			"usage",
			"resets",
			"reset",
			"resetState",
		],
		"Vault Claude read",
	);
	if (
		input.state !== "open" ||
		typeof input.keyId !== "string" ||
		!KEY_ID.test(input.keyId) ||
		typeof input.envelopeSha256 !== "string" ||
		!SHA256.test(input.envelopeSha256) ||
		typeof input.encryptedEnvelopeBase64 !== "string" ||
		typeof input.usage !== "boolean" ||
		typeof input.resets !== "boolean" ||
		(input.reset !== null && !CLAUDE_RESET_KINDS.includes(input.reset as ClaudeResetKind)) ||
		(input.resetState !== null &&
			!["asked", "using", "reset", "failed", "unconfirmed"].includes(input.resetState as string)) ||
		(input.reset === null) !== (input.resetState === null)
	)
		throw new Error("Vault Claude read is invalid");
	const claudeLoginId = uuid(input.claudeLoginId, "Vault Claude read login");
	const ownerUserId = uuid(input.ownerUserId, "Vault Claude read member");
	const version = positive(input.version, "Vault Claude read version");
	const envelope = Buffer.from(input.encryptedEnvelopeBase64, "base64");
	if (
		envelope.byteLength < 1 ||
		envelope.byteLength > 131_072 ||
		createHash("sha256").update(envelope).digest("hex") !== input.envelopeSha256
	) {
		envelope.fill(0);
		throw new Error("Vault Claude read is invalid");
	}
	return {
		state: "open",
		claudeLoginId,
		ownerUserId,
		keyId: input.keyId,
		version,
		envelope,
		usage: input.usage,
		resets: input.resets,
		reset: input.reset as ClaudeResetKind | null,
		resetState: input.resetState as Extract<ClaudeReadDescription, { state: "open" }>["resetState"],
	};
}

const RECHECK_SCHEMA = "qorpera.model-login-usage-recheck/v1";

export interface ModelLoginUsageAnswer {
	readonly schema: typeof NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA;
	readonly request_id: string;
	readonly status: "preparing" | "completed";
}

interface RefreshLogin {
	loginId: string;
	/** An account login's member (20260930548000): its member's key opens it. */
	ownerUserId?: string;
	version: number;
	keyId: string;
	envelope: Uint8Array;
	connectionId: string;
	connectionVersion: number;
}

interface RefreshDescription {
	requestId: string;
	companyId: string;
	computeIdentityId: string;
	requestedByUserId: string;
	status: "pending" | "completed" | "expired";
	expiresAt: string;
	logins: RefreshLogin[];
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

function positive(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`);
	return value as number;
}

const LOGIN_KEYS = [
	"loginId",
	"version",
	"keyId",
	"encryptedEnvelopeBase64",
	"envelopeSha256",
	"connectionId",
	"connectionVersion",
	"credentialCapsuleId",
];

function parseLogin(item: unknown): RefreshLogin {
	const account =
		Boolean(item) && typeof item === "object" && !Array.isArray(item) && Object.hasOwn(item as object, "ownerUserId");
	const login = record(item, account ? [...LOGIN_KEYS, "ownerUserId"] : LOGIN_KEYS, "Vault account refresh login");
	if (
		typeof login.keyId !== "string" ||
		!KEY_ID.test(login.keyId) ||
		typeof login.encryptedEnvelopeBase64 !== "string" ||
		typeof login.envelopeSha256 !== "string" ||
		!SHA256.test(login.envelopeSha256)
	)
		throw new Error("Vault account refresh login is invalid");
	// Every other field first: an envelope is decoded only for an otherwise valid login.
	uuid(login.credentialCapsuleId, "Vault account refresh capsule");
	const loginId = uuid(login.loginId, "Vault account refresh login id");
	const ownerUserId = account ? uuid(login.ownerUserId, "Vault account refresh login member") : undefined;
	const version = positive(login.version, "Vault account refresh login version");
	const connectionId = uuid(login.connectionId, "Vault account refresh connection");
	const connectionVersion = positive(login.connectionVersion, "Vault account refresh connection version");
	const envelope = Buffer.from(login.encryptedEnvelopeBase64, "base64");
	if (
		envelope.byteLength < 1 ||
		envelope.byteLength > 131_072 ||
		createHash("sha256").update(envelope).digest("hex") !== login.envelopeSha256
	) {
		envelope.fill(0);
		throw new Error("Vault account refresh login is invalid");
	}
	return {
		loginId,
		...(ownerUserId === undefined ? {} : { ownerUserId }),
		version,
		keyId: login.keyId,
		envelope,
		connectionId,
		connectionVersion,
	};
}

function parseDescription(value: unknown): RefreshDescription {
	const input = record(
		value,
		["schema", "requestId", "profileId", "computeIdentityId", "requestedByUserId", "status", "expiresAt", "logins"],
		"Vault account refresh",
	);
	if (
		input.schema !== "qorpera.model-login-account-refresh/v1" ||
		!["pending", "completed", "expired", "cancelled"].includes(String(input.status)) ||
		typeof input.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(input.expiresAt)) ||
		!Array.isArray(input.logins)
	)
		throw new Error("Vault account refresh is invalid");
	// The header first: no envelope is decoded for an answer that fails it.
	const requestId = uuid(input.requestId, "Vault account refresh id");
	const companyId = uuid(input.profileId, "Vault account refresh company");
	const computeIdentityId = uuid(input.computeIdentityId, "Vault account refresh identity");
	const requestedByUserId = uuid(input.requestedByUserId, "Vault account refresh member");
	// Every envelope read so far is wiped if a later login is unreadable.
	const read: RefreshLogin[] = [];
	try {
		for (const item of input.logins.slice(0, MAX_LOGINS)) read.push(parseLogin(item));
	} catch (error) {
		for (const login of read) login.envelope.fill(0);
		throw error;
	}
	return {
		requestId,
		companyId,
		computeIdentityId,
		requestedByUserId,
		status: input.status === "pending" || input.status === "completed" ? input.status : "expired",
		expiresAt: input.expiresAt,
		// The database hands out at most this many; any more would wait for the next refresh.
		logins: read,
	};
}

export class CloudModelLoginUsage {
	readonly #authority: ModelLoginUsageAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #fetch: typeof fetch;
	readonly #claude: ClaudeLoginReads | undefined;
	readonly #resetting = new Map<string, Promise<void>>();

	constructor(options: {
		authority: ModelLoginUsageAuthority;
		keyring: CloudSecretKeyring;
		fetch?: typeof fetch;
		claude?: ClaudeLoginReads;
	}) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#fetch = options.fetch ?? fetch;
		this.#claude = options.claude;
	}

	async #claudeDescription(
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<ClaudeReadDescription> {
		if (!this.#claude || !this.#authority.describeClaudeLoginRead) return { state: "none" };
		try {
			return parseClaudeRead(await this.#authority.describeClaudeLoginRead(request, signal));
		} catch {
			signal.throwIfAborted();
			return { state: "none" };
		}
	}

	async #claudeCredentials(claude: Extract<ClaudeReadDescription, { state: "open" }>): Promise<string> {
		if (!this.#keys.hasMemberKey(claude.keyId)) throw new Error("The vault does not keep Claude logins");
		return await this.#keys.useMember(
			claude.envelope,
			{ memberId: claude.ownerUserId, loginId: claude.claudeLoginId, version: claude.version, keyId: claude.keyId },
			async (fields) => {
				const text = fields[CLAUDE_LOGIN_FIELD];
				if (Object.keys(fields).length !== 1 || typeof text !== "string")
					throw new Error("Claude login envelope is another kind of login");
				checkClaudeLoginFiles(text);
				const credentials = (JSON.parse(text) as { files: Record<string, unknown> }).files[".credentials.json"];
				if (typeof credentials !== "string") throw new Error("Claude login envelope is invalid");
				return credentials;
			},
		);
	}

	async #claudeRead(
		claude: Extract<ClaudeReadDescription, { state: "open" }>,
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<void> {
		const reads = this.#claude;
		const recordRead = this.#authority.recordClaudeLoginRead;
		if (!reads || !recordRead || (!claude.usage && !claude.resets)) return;
		try {
			const read = await reads.readClaudeLogin(
				{ credentials: await this.#claudeCredentials(claude), usage: claude.usage, resets: claude.resets },
				AbortSignal.any([signal, AbortSignal.timeout(CLAUDE_READ_MS)]),
			);
			const usage = claude.usage ? read.usage : null;
			const resets = claude.resets ? read.resets : null;
			if (!usage && !resets) return;
			await recordRead.call(
				this.#authority,
				{ ...request, usage, resets, reset: null },
				AbortSignal.any([signal, AbortSignal.timeout(SAVE_DEADLINE_MS)]),
			);
		} catch {
			return;
		}
	}

	async #claudeReset(
		claude: Extract<ClaudeReadDescription, { state: "open" }>,
		request: { requestId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<"preparing" | "completed"> {
		const reads = this.#claude;
		const authority = this.#authority;
		if (!reads || !authority.claimClaudeLoginReset || !authority.recordClaudeLoginRead) return "preparing";
		if (claude.resetState !== "asked" && claude.resetState !== "using") {
			await this.#authority.completeModelLoginAccountRefresh(
				request,
				AbortSignal.any([signal, AbortSignal.timeout(SAVE_DEADLINE_MS)]),
			);
			return "completed";
		}
		if (claude.resetState === "using" || this.#resetting.has(request.requestId)) return "preparing";
		const claim = randomUUID();
		let claimed = false;
		for (let attempt = 0; attempt < CLAUDE_SAVE_ATTEMPTS && !claimed; attempt++) {
			try {
				claimed = (await authority.claimClaudeLoginReset({ ...request, claim }, signal)) === true;
				if (!claimed) return "preparing";
			} catch {
				signal.throwIfAborted();
				await new Promise((resolveWait) => setTimeout(resolveWait, CLAUDE_CLAIM_RETRY_MS));
			}
		}
		if (!claimed) return "preparing";
		const kind = claude.reset as ClaudeResetKind;
		const envelope = Buffer.from(claude.envelope);
		const job = (async () => {
			let outcome: ClaudeResetOutcome = { outcome: "failed" };
			try {
				const credentials = await this.#claudeCredentials({ ...claude, envelope });
				outcome = { outcome: "unconfirmed" };
				outcome = await reads.useClaudeReset({ credentials, kind }, AbortSignal.timeout(CLAUDE_RESET_MS));
			} catch {
				outcome = outcome.outcome === "failed" ? outcome : { outcome: "unconfirmed" };
			} finally {
				envelope.fill(0);
			}
			for (let attempt = 0; attempt < CLAUDE_SAVE_ATTEMPTS; attempt++) {
				try {
					await authority.recordClaudeLoginRead?.(
						{ ...request, usage: null, resets: null, reset: outcome },
						AbortSignal.timeout(SAVE_DEADLINE_MS),
					);
					await authority.completeModelLoginAccountRefresh(request, AbortSignal.timeout(SAVE_DEADLINE_MS));
					return;
				} catch {
					await new Promise((resolveWait) => setTimeout(resolveWait, CLAUDE_SAVE_RETRY_MS));
				}
			}
		})()
			.catch(() => undefined)
			.finally(() => this.#resetting.delete(request.requestId));
		this.#resetting.set(request.requestId, job);
		return "preparing";
	}

	/** The daily usage check: the refresh of a login at its usage limit that is due a reading, run as a member's refresh
	 * is. "none" when nothing is due, or the database has no such call. */
	async recheck(signal: AbortSignal, companyId?: string): Promise<"read" | "none"> {
		if (!this.#authority.beginModelLoginUsageRecheck) return "none";
		// A capability for this one refresh; only its digest reaches the database.
		const capability = randomBytes(32).toString("base64url");
		const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
		const answer = record(
			await this.#authority.beginModelLoginUsageRecheck({ capabilitySha256 }, signal),
			["schema", "request"],
			"Vault usage recheck",
		);
		if (answer.schema !== RECHECK_SCHEMA) throw new Error("Vault usage recheck is invalid");
		if (answer.request === null) return "none";
		const due = parseNativeAccountRefreshDescription(answer.request);
		// The database names the broker's own company (a single-company broker has no other); a shared vault checks it.
		if ((companyId !== undefined && due.profileId !== companyId.toLowerCase()) || due.status !== "pending")
			throw new Error("Vault usage recheck crossed its authority");
		await this.refresh(
			{
				companyId: due.profileId,
				capability,
				body: nativeAccountRefreshBody({
					requestId: due.requestId,
					computeIdentityId: due.computeIdentityId,
					requestedByUserId: due.requestedByUserId,
					expiresAt: due.expiresAt,
					capability,
				}),
			},
			signal,
		);
		return "read";
	}

	/** One account refresh: reads and records each vault login's usage, then completes. */
	async refresh(
		request: { companyId: string; capability: string; body: unknown },
		signal: AbortSignal,
	): Promise<ModelLoginUsageAnswer> {
		if (!TOKEN.test(request.capability)) throw new Error("Vault account refresh capability is invalid");
		const refresh = parseNativeAccountRefreshRequest(request.body);
		if (!timingSafeEqual(Buffer.from(refresh.capability), Buffer.from(request.capability)))
			throw new Error("Vault account refresh capability is inconsistent");
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const description = parseDescription(
			await this.#authority.describeModelLoginAccountRefresh(
				{ requestId: refresh.requestId, capabilitySha256 },
				signal,
			),
		);
		const answer = (status: ModelLoginUsageAnswer["status"]): ModelLoginUsageAnswer => ({
			schema: NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA,
			request_id: refresh.requestId,
			status,
		});
		let claude: ClaudeReadDescription = { state: "none" };
		try {
			if (
				description.requestId !== refresh.requestId ||
				description.companyId !== request.companyId.toLowerCase() ||
				description.computeIdentityId !== refresh.computeIdentityId ||
				description.requestedByUserId !== refresh.requestedByUserId ||
				Date.parse(description.expiresAt) !== Date.parse(refresh.expiresAt)
			)
				throw new Error("Vault account refresh crossed its authority");
			if (description.status === "completed") return answer("completed");
			if (description.status !== "pending") throw new Error("Vault account refresh has ended");
			const claudeRequest = { requestId: refresh.requestId, capabilitySha256 };
			claude = await this.#claudeDescription(claudeRequest, signal);
			if (claude.state === "open" && claude.reset !== null)
				return answer(await this.#claudeReset(claude, claudeRequest, signal));
			// Every login is read at once, each on its own deadline inside the route's: one that
			// fails to open or answer is unknown usage, and the refresh still settles.
			await Promise.all([
				...description.logins.map((login) => this.#read(description, refresh, capabilitySha256, login, signal)),
				...(claude.state === "open" ? [this.#claudeRead(claude, claudeRequest, signal)] : []),
			]);
		} finally {
			for (const login of description.logins) login.envelope.fill(0);
			if (claude.state === "open") claude.envelope.fill(0);
		}
		await this.#authority.completeModelLoginAccountRefresh(
			{ requestId: refresh.requestId, capabilitySha256 },
			AbortSignal.any([signal, AbortSignal.timeout(SAVE_DEADLINE_MS)]),
		);
		return answer("completed");
	}

	async #read(
		description: RefreshDescription,
		refresh: { requestId: string },
		capabilitySha256: string,
		login: RefreshLogin,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const read = async (fields: Readonly<Record<string, string>>) => {
				const text = fields[MODEL_LOGIN_FIELD];
				if (typeof text !== "string" || Object.keys(fields).length !== 1)
					throw new Error("Model login envelope is invalid");
				const codex = parseCodexLogin(text);
				return {
					email: nativeProviderAccountEmail("codex-cli", codex.text) ?? null,
					identity: nativeProviderAccountIdentity(codex.text) ?? null,
					usage:
						(await readNativeProviderAccountUsage(
							codex.text,
							AbortSignal.any([signal, AbortSignal.timeout(USAGE_DEADLINE_MS)]),
							this.#fetch,
						)) ?? null,
				};
			};
			// An account login is the refresh's own member's (the database lists no other): its member's key opens it.
			if (login.ownerUserId !== undefined && login.ownerUserId !== description.requestedByUserId) return;
			const metadata =
				login.ownerUserId !== undefined
					? await this.#keys.useMember(
							login.envelope,
							{
								memberId: login.ownerUserId,
								loginId: login.loginId,
								version: login.version,
								keyId: login.keyId,
							},
							read,
						)
					: await this.#keys.use(
							login.envelope,
							{
								companyId: description.companyId,
								environmentId: description.computeIdentityId,
								secretId: login.loginId,
								version: login.version,
								keyId: login.keyId,
							},
							read,
						);
			if (!metadata.email && !metadata.identity && !metadata.usage) return;
			await this.#authority.recordModelLoginAccountMetadata(
				{
					requestId: refresh.requestId,
					capabilitySha256,
					loginId: login.loginId,
					connectionId: login.connectionId,
					connectionVersion: login.connectionVersion,
					providerAccountEmail: metadata.email,
					providerAccountUsage: metadata.usage,
					providerAccountIdentity: metadata.identity,
				},
				AbortSignal.any([signal, AbortSignal.timeout(SAVE_DEADLINE_MS)]),
			);
		} catch {
			// Unknown usage for this login.
		}
	}
}
