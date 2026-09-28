import { createHash, timingSafeEqual } from "node:crypto";
import {
	NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA,
	parseNativeAccountRefreshRequest,
} from "@qorpera/cloud-client/native-account-refresh";
import { MODEL_LOGIN_FIELD, parseCodexLogin } from "./cloud-model-login-vault.ts";
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
}

export interface ModelLoginUsageAnswer {
	readonly schema: typeof NATIVE_ACCOUNT_REFRESH_RESULT_SCHEMA;
	readonly request_id: string;
	readonly status: "preparing" | "completed";
}

interface RefreshLogin {
	loginId: string;
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

function parseLogin(item: unknown): RefreshLogin {
	const login = record(
		item,
		[
			"loginId",
			"version",
			"keyId",
			"encryptedEnvelopeBase64",
			"envelopeSha256",
			"connectionId",
			"connectionVersion",
			"credentialCapsuleId",
		],
		"Vault account refresh login",
	);
	if (
		typeof login.keyId !== "string" ||
		!KEY_ID.test(login.keyId) ||
		typeof login.encryptedEnvelopeBase64 !== "string" ||
		typeof login.envelopeSha256 !== "string" ||
		!SHA256.test(login.envelopeSha256)
	)
		throw new Error("Vault account refresh login is invalid");
	const envelope = Buffer.from(login.encryptedEnvelopeBase64, "base64");
	if (
		envelope.byteLength < 1 ||
		envelope.byteLength > 131_072 ||
		createHash("sha256").update(envelope).digest("hex") !== login.envelopeSha256
	) {
		envelope.fill(0);
		throw new Error("Vault account refresh login is invalid");
	}
	uuid(login.credentialCapsuleId, "Vault account refresh capsule");
	return {
		loginId: uuid(login.loginId, "Vault account refresh login id"),
		version: positive(login.version, "Vault account refresh login version"),
		keyId: login.keyId,
		envelope,
		connectionId: uuid(login.connectionId, "Vault account refresh connection"),
		connectionVersion: positive(login.connectionVersion, "Vault account refresh connection version"),
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

	constructor(options: { authority: ModelLoginUsageAuthority; keyring: CloudSecretKeyring; fetch?: typeof fetch }) {
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#fetch = options.fetch ?? fetch;
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
			// Every login is read at once, each on its own deadline inside the route's: one that
			// fails to open or answer is unknown usage, and the refresh still settles.
			await Promise.all(
				description.logins.map((login) => this.#read(description, refresh, capabilitySha256, login, signal)),
			);
		} finally {
			for (const login of description.logins) login.envelope.fill(0);
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
			const metadata = await this.#keys.use(
				login.envelope,
				{
					companyId: description.companyId,
					environmentId: description.computeIdentityId,
					secretId: login.loginId,
					version: login.version,
					keyId: login.keyId,
				},
				async (fields) => {
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
				},
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
