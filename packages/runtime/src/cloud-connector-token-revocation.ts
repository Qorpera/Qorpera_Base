import { createHash } from "node:crypto";
import { cloudConnector } from "./cloud-connector-catalog.ts";
import { GITHUB_API_VERSION } from "./cloud-connector-github.ts";
import type { GoogleOAuthClient } from "./cloud-connector-google.ts";
import { connectorRequest } from "./cloud-connector-http.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * Upstream revoke of connected-account tokens (company delete D6, migration 20260929500000). When a
 * Gmail, Drive or GitHub connection is disconnected or its company deleted, SQL queues each stored
 * version for the broker that sealed it. The broker claims its entries, opens each envelope, cancels the
 * token at the provider and records the outcome; an error is recorded and SQL offers the entry again
 * later. SQL has already skipped Google entries whose account is still connected in a living company
 * (Google withdraws the whole grant to our client), so every entry claimed here is revoked.
 *
 * - Google: `POST oauth2.googleapis.com/revoke` with the refresh token in the form body (never in the
 *   URL, so it stays out of logs); 200 revoked, 400 `invalid_token` already invalid.
 * - GitHub (one OAuth App): `DELETE api.github.com/applications/{client_id}/token` with the app's basic
 *   auth; 204 revoked, 404 already invalid. It revokes that one token, never the user's whole grant
 *   (`/grant` would disconnect the user's GitHub in every company). A typed personal token is not ours
 *   to revoke.
 *
 * Nothing here logs or records a token or a provider's answer text: errors are fixed phrases.
 */

export type ConnectorTokenOutcome = "revoked" | "already_invalid" | "not_ours";

export interface ConnectorTokenRevocationAuthority {
	claimConnectorTokenRevocations(limit: number, signal: AbortSignal): Promise<unknown>;
	completeConnectorTokenRevocation(
		answer: { secretId: string; version: number; outcome: ConnectorTokenOutcome | null; error: string | null },
		signal: AbortSignal,
	): Promise<unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CONNECTORS = new Set(["gmail", "google_drive", "github"]);
/** GitHub's OAuth App user tokens; anything else stored for GitHub is a typed personal token. */
const GITHUB_APP_TOKEN = /^gho_[A-Za-z0-9_]{16,251}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** Entries per claim (SQL allows 20) and claims per pass. */
const CLAIM_LIMIT = 20;
const CLAIMS_PER_PASS = 3;
const PASS_EVERY_MS = 60_000;
const DATABASE_DEADLINE_MS = 10_000;

/** A failure whose message is a fixed phrase, safe to record. */
export class ConnectorTokenRevocationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectorTokenRevocationError";
	}
}

interface Claim {
	readonly companyId: string;
	readonly environmentId: string;
	readonly secretId: string;
	readonly version: number;
	readonly keyId: string;
	readonly connectorId: "gmail" | "google_drive" | "github";
	readonly encryptedEnvelopeBase64: string;
	readonly envelopeSha256: string;
}

function parseClaims(value: unknown): Claim[] {
	if (!Array.isArray(value) || value.length > CLAIM_LIMIT) throw new Error("Token revocation claim is invalid");
	return value.map((item) => {
		const input = item as Record<string, unknown>;
		if (
			!input ||
			typeof input !== "object" ||
			Object.keys(input).sort().join() !==
				"companyId,connectorId,encryptedEnvelopeBase64,envelopeSha256,environmentId,keyId,schema,secretId,secretVersion" ||
			input.schema !== "qorpera.connector-token-revocation/v1" ||
			![input.companyId, input.environmentId, input.secretId].every(
				(id) => typeof id === "string" && UUID.test(id),
			) ||
			!Number.isSafeInteger(input.secretVersion) ||
			(input.secretVersion as number) < 1 ||
			typeof input.keyId !== "string" ||
			!KEY_ID.test(input.keyId) ||
			typeof input.connectorId !== "string" ||
			!CONNECTORS.has(input.connectorId) ||
			typeof input.encryptedEnvelopeBase64 !== "string" ||
			input.encryptedEnvelopeBase64.length > 180_000 ||
			!BASE64.test(input.encryptedEnvelopeBase64) ||
			typeof input.envelopeSha256 !== "string" ||
			!SHA.test(input.envelopeSha256)
		)
			throw new Error("Token revocation claim is invalid");
		return {
			companyId: input.companyId as string,
			environmentId: input.environmentId as string,
			secretId: input.secretId as string,
			version: input.secretVersion as number,
			keyId: input.keyId,
			connectorId: input.connectorId as Claim["connectorId"],
			encryptedEnvelopeBase64: input.encryptedEnvelopeBase64,
			envelopeSha256: input.envelopeSha256,
		};
	});
}

/** The provider calls. Google's revoke needs no client; GitHub's needs the OAuth App's credentials. */
export class CloudConnectorTokenRevoker {
	readonly #fetch: typeof fetch;
	readonly #github: GoogleOAuthClient | undefined;

	constructor(options: { github?: GoogleOAuthClient; fetch?: typeof fetch } = {}) {
		this.#fetch = options.fetch ?? fetch;
		this.#github = options.github;
	}

	async revoke(
		connectorId: Claim["connectorId"],
		fields: Readonly<Record<string, string>>,
		signal: AbortSignal,
	): Promise<ConnectorTokenOutcome> {
		const name = cloudConnector(connectorId).credentialName;
		const token = Object.hasOwn(fields, name) ? fields[name] : undefined;
		if (typeof token !== "string" || !TOKEN.test(token))
			throw new ConnectorTokenRevocationError("the stored token is missing");
		return connectorId === "github" ? this.#revokeGitHub(token, signal) : this.#revokeGoogle(token, signal);
	}

	async #revokeGoogle(token: string, signal: AbortSignal): Promise<ConnectorTokenOutcome> {
		const response = await this.#request("Google", {
			origin: "https://oauth2.googleapis.com",
			path: "/revoke",
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }).toString(),
			signal,
		});
		if (response.status === 200) return "revoked";
		if (response.status === 400 && errorCode(response.bytes) === "invalid_token") return "already_invalid";
		throw new ConnectorTokenRevocationError(`Google answered ${response.status}`);
	}

	async #revokeGitHub(token: string, signal: AbortSignal): Promise<ConnectorTokenOutcome> {
		if (!GITHUB_APP_TOKEN.test(token)) return "not_ours";
		const client = this.#github;
		if (!client) throw new ConnectorTokenRevocationError("the GitHub client is not configured");
		const response = await this.#request("GitHub", {
			origin: "https://api.github.com",
			path: `/applications/${encodeURIComponent(client.clientId)}/token`,
			method: "DELETE",
			headers: {
				authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
				accept: "application/vnd.github+json",
				"content-type": "application/json",
				"x-github-api-version": GITHUB_API_VERSION,
				"user-agent": "qorpera-cloud-connector",
			},
			body: JSON.stringify({ access_token: token }),
			signal,
		});
		if (response.status === 204) return "revoked";
		if (response.status === 404) return "already_invalid";
		throw new ConnectorTokenRevocationError(`GitHub answered ${response.status}`);
	}

	async #request(provider: string, input: Omit<Parameters<typeof connectorRequest>[0], "fetch">) {
		try {
			return await connectorRequest({ ...input, fetch: this.#fetch, maximumBytes: 64 * 1024 });
		} catch {
			throw new ConnectorTokenRevocationError(`${provider} could not be reached`);
		}
	}
}

function errorCode(bytes: Uint8Array): string | undefined {
	try {
		const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
		const error = value && typeof value === "object" ? (value as Record<string, unknown>).error : undefined;
		return typeof error === "string" ? error : undefined;
	} catch {
		return undefined;
	}
}

/** One company authority's queue: claims, opens each envelope, revokes, records. */
export class CloudConnectorTokenRevocations {
	readonly #authority: ConnectorTokenRevocationAuthority;
	readonly #keyring: Pick<CloudSecretKeyring, "use">;
	readonly #revoker: Pick<CloudConnectorTokenRevoker, "revoke">;

	constructor(options: {
		authority: ConnectorTokenRevocationAuthority;
		keyring: Pick<CloudSecretKeyring, "use">;
		revoker: Pick<CloudConnectorTokenRevoker, "revoke">;
	}) {
		this.#authority = options.authority;
		this.#keyring = options.keyring;
		this.#revoker = options.revoker;
	}

	/** Up to three claims of twenty; stops early when a claim comes back short or the pass is closed. */
	async pass(signal: AbortSignal): Promise<{ completed: number; failed: number }> {
		let completed = 0,
			failed = 0;
		for (let round = 0; round < CLAIMS_PER_PASS && !signal.aborted; round += 1) {
			const claims = parseClaims(
				await this.#authority.claimConnectorTokenRevocations(
					CLAIM_LIMIT,
					AbortSignal.any([signal, AbortSignal.timeout(DATABASE_DEADLINE_MS)]),
				),
			);
			for (const claim of claims) {
				const answer = await this.#revoke(claim, signal);
				if (answer.outcome) completed += 1;
				else failed += 1;
				// Recorded even when the pass is closing: the revoke has happened.
				await this.#authority.completeConnectorTokenRevocation(
					{ secretId: claim.secretId, version: claim.version, ...answer },
					AbortSignal.timeout(DATABASE_DEADLINE_MS),
				);
			}
			if (claims.length < CLAIM_LIMIT) break;
		}
		return { completed, failed };
	}

	async #revoke(
		claim: Claim,
		signal: AbortSignal,
	): Promise<{ outcome: ConnectorTokenOutcome; error: null } | { outcome: null; error: string }> {
		const envelope = Buffer.from(claim.encryptedEnvelopeBase64, "base64");
		try {
			if (createHash("sha256").update(envelope).digest("hex") !== claim.envelopeSha256)
				return { outcome: null, error: "the envelope digest differs" };
			// The keyring hides any error thrown inside: the revoke's own answer is returned instead.
			return await this.#keyring.use(
				envelope,
				{
					companyId: claim.companyId,
					environmentId: claim.environmentId,
					secretId: claim.secretId,
					version: claim.version,
					keyId: claim.keyId,
				},
				async (fields) => {
					try {
						return { outcome: await this.#revoker.revoke(claim.connectorId, fields, signal), error: null };
					} catch (error) {
						return {
							outcome: null,
							error: error instanceof ConnectorTokenRevocationError ? error.message : "the revoke failed",
						};
					}
				},
			);
		} catch {
			return { outcome: null, error: "the envelope could not be opened" };
		} finally {
			envelope.fill(0);
		}
	}
}

/** A single-company broker's loop: one pass a minute, so a Disconnect reaches the provider promptly. */
export class CloudConnectorTokenRevocationUpkeep {
	readonly #revocations: Pick<CloudConnectorTokenRevocations, "pass">;
	readonly #passEveryMs: number;
	readonly #firstPassMs: number;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	readonly #closing = new AbortController();
	#started = false;

	constructor(options: {
		revocations: Pick<CloudConnectorTokenRevocations, "pass">;
		passEveryMs?: number;
		firstPassMs?: number;
	}) {
		this.#revocations = options.revocations;
		this.#passEveryMs = options.passEveryMs ?? PASS_EVERY_MS;
		this.#firstPassMs = options.firstPassMs ?? 15_000 + Math.floor(Math.random() * this.#passEveryMs);
	}

	start(): void {
		if (this.#started || this.#closing.signal.aborted) return;
		this.#started = true;
		const loop = (): void => {
			if (this.#closing.signal.aborted) return;
			this.#running = this.pass().finally(() => {
				this.#running = undefined;
				if (!this.#closing.signal.aborted) this.#timer = setTimeout(loop, this.#passEveryMs);
			});
		};
		this.#timer = setTimeout(loop, this.#firstPassMs);
	}

	async close(): Promise<void> {
		this.#closing.abort();
		clearTimeout(this.#timer);
		await this.#running;
	}

	/** One pass; its failure is logged by fact only. */
	async pass(): Promise<void> {
		await logConnectorTokenRevocationPass(this.#revocations, this.#closing.signal);
	}
}

/** Runs one pass and logs what happened, by count and never by token or account. */
export async function logConnectorTokenRevocationPass(
	revocations: Pick<CloudConnectorTokenRevocations, "pass">,
	signal: AbortSignal,
): Promise<void> {
	try {
		const { completed, failed } = await revocations.pass(signal);
		if (completed > 0 || failed > 0)
			console.error(`Connector token revocation: ${completed} completed, ${failed} failed (offered again later).`);
	} catch {
		console.error("Connector token revocation: a pass stopped on an error; the next pass tries again.");
	}
}
