import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isUuid } from "@qorpera/contracts";
import {
	CHATGPT_PLAN_LOGIN_FIELD,
	type ChatGptPlanOAuth,
	chatGptPlanCodeChallenge,
	chatGptPlanFailure,
	serializeChatGptPlanLogin,
} from "./cloud-chatgpt-plan.ts";
import type { CloudSecretKeyring } from "./cloud-secret-crypto.ts";

/**
 * A member's "Continue with ChatGPT" to the vault (Sign in with ChatGPT, built switched off).
 *
 * The web client begins a plan sign-in like any vault sign-in (its edge function posts the member's
 * request with the sign-in's capability). The vault answers with OpenAI's authorization address, made
 * here with a fresh state (`<company>.<43 random characters>`, so the callback reaches this company's
 * vault), PKCE verifier and nonce, and the login's stable host id. OpenAI sends the member's browser
 * back to the callback Edge Function, which forwards the state and code here. Nothing is exchanged
 * then: the code is parked under a one-time confirmation id that only that browser learns. The web
 * client, which holds the sign-in's capability, confirms; only then is the code exchanged, the ID token
 * checked, and the login sealed and completed in one database transaction. A sign-in that another
 * person's browser came back from therefore never completes: that browser has no capability, and the
 * browser with the capability never sees the confirmation id.
 */

/** The random half of a state; the other half is the company's id. */
const STATE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const CONFIRMATION = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;
const STATE_TTL_MS = 10 * 60_000;
const CONFIRM_TTL_MS = 5 * 60_000;
/** Sign-ins in flight per served company (started, or back from OpenAI and waiting for the browser's
 * confirm). */
const MAX_FLOWS = 32;
/** The confirmation's budget inside the vault route's 30 s: the code exchange, then the save, then a read
 * when the save's answer was lost (27 s). The Edge Function forwarding it waits 40 s (its own 5 s lookup
 * first), the web client 45 s, the front 60 s. Ending a login that was not saved waits for nobody. */
export const CHATGPT_PLAN_CONFIRM_ROUTE_MS = 30_000;
const EXCHANGE_DEADLINE_MS = 15_000;
const SAVE_DEADLINE_MS = 8_000;
const CHECK_DEADLINE_MS = 4_000;

/** Why a callback or a confirmation ended without a login: what the member's page may show. */
export type ChatGptPlanSignInFailure = "state_unknown" | "expired" | "declined" | "provider_error" | "busy";

export class ChatGptPlanSignInError extends Error {
	readonly reason: ChatGptPlanSignInFailure;
	constructor(reason: ChatGptPlanSignInFailure) {
		super(`ChatGPT plan sign-in ${reason}`);
		this.name = "ChatGptPlanSignInError";
		this.reason = reason;
	}
}

/** The pending sign-in as the database describes it (its v2 read). */
export interface ChatGptPlanPendingSignIn {
	readonly loginId: string;
	readonly companyId: string;
	readonly computeIdentityId: string;
	readonly hostId: string;
	readonly expiresAt: string;
	readonly keyId: string;
	readonly capabilitySha256: string;
}

/** The plan side of the vault's database authority. */
export interface ChatGptPlanSignInAuthority {
	/** The v2 read of a pending sign-in (any kind); the caller checks it is a plan sign-in. */
	describeModelLoginSignIn(
		request: { loginId: string; capabilitySha256: string },
		signal: AbortSignal,
	): Promise<unknown>;
	completeChatGptPlanSignIn(
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
			renewNotBefore: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
}

interface Started {
	readonly stateSha256: string;
	readonly authorizationUrl: string;
	readonly signIn: ChatGptPlanPendingSignIn;
	readonly codeVerifier: string;
	readonly nonce: string;
	readonly expiresAt: number;
}

interface Parked {
	readonly confirmationSha256: string;
	readonly signIn: ChatGptPlanPendingSignIn;
	readonly code: string;
	readonly codeVerifier: string;
	readonly nonce: string;
	readonly expiresAt: number;
}

/** `<company id>.<43 random characters>`, the company id in lower case as the vault writes it. */
function parseState(value: unknown): { state: string; companyId: string } | null {
	if (typeof value !== "string" || value.length !== 80) return null;
	const companyId = value.slice(0, 36);
	return value[36] === "." &&
		isUuid(companyId) &&
		companyId === companyId.toLowerCase() &&
		STATE_SECRET.test(value.slice(37))
		? { state: value, companyId }
		: null;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function same(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export class ChatGptPlanSignIns {
	readonly #oauth: ChatGptPlanOAuth;
	readonly #authority: ChatGptPlanSignInAuthority;
	readonly #keys: CloudSecretKeyring;
	readonly #now: () => number;
	readonly #random: (bytes: number) => Uint8Array;
	/** Started sign-ins by the state's digest, and the same entries by sign-in id. */
	readonly #started = new Map<string, Started>();
	readonly #bySignIn = new Map<string, Started>();
	readonly #parked = new Map<string, Parked>();

	constructor(options: {
		oauth: ChatGptPlanOAuth;
		authority: ChatGptPlanSignInAuthority;
		keyring: CloudSecretKeyring;
		now?: () => number;
		random?: (bytes: number) => Uint8Array;
	}) {
		this.#oauth = options.oauth;
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? ((bytes) => randomBytes(bytes));
	}

	/** OpenAI's authorization address for a pending plan sign-in. The web client polls: while the sign-in
	 * waits for the member, every poll gets the same address (one state per sign-in). */
	async begin(signIn: ChatGptPlanPendingSignIn, signal: AbortSignal): Promise<string> {
		this.#sweep();
		const known = this.#bySignIn.get(signIn.loginId);
		if (known && known.signIn.capabilitySha256 === signIn.capabilitySha256) return known.authorizationUrl;
		if (this.#started.size + this.#parked.size >= MAX_FLOWS) throw new ChatGptPlanSignInError("busy");
		const random = (bytes: number) => Buffer.from(this.#random(bytes)).toString("base64url");
		const state = `${signIn.companyId}.${random(32)}`;
		const codeVerifier = random(48);
		const nonce = random(32);
		const authorizationUrl = await this.#oauth.authorizationUrl(
			{ state, nonce, codeChallenge: chatGptPlanCodeChallenge(codeVerifier), hostId: signIn.hostId },
			signal,
		);
		const started: Started = {
			stateSha256: digest(state),
			authorizationUrl,
			signIn,
			codeVerifier,
			nonce,
			expiresAt: Math.min(this.#now() + STATE_TTL_MS, Date.parse(signIn.expiresAt)),
		};
		this.#started.set(started.stateSha256, started);
		this.#bySignIn.set(signIn.loginId, started);
		return authorizationUrl;
	}

	/** The callback's state and code (forwarded by the callback Edge Function). The state is consumed
	 * first, so a replayed callback finds nothing; the code is parked under a fresh confirmation id. */
	receive(input: {
		readonly companyId: string;
		readonly state: unknown;
		readonly code: unknown;
		readonly error: unknown;
		readonly clientId: unknown;
	}): { confirmation: string } {
		const state = parseState(input.state);
		if (!state || state.companyId !== input.companyId.toLowerCase())
			throw new ChatGptPlanSignInError("state_unknown");
		const key = digest(state.state);
		const started = this.#started.get(key);
		if (!started || !same(started.stateSha256, key) || started.signIn.companyId !== state.companyId)
			throw new ChatGptPlanSignInError("state_unknown");
		this.#started.delete(key);
		if (this.#bySignIn.get(started.signIn.loginId) === started) this.#bySignIn.delete(started.signIn.loginId);
		this.#sweep();
		if (started.expiresAt <= this.#now()) throw new ChatGptPlanSignInError("expired");
		if (input.error !== null && input.error !== undefined)
			throw new ChatGptPlanSignInError(input.error === "access_denied" ? "declined" : "provider_error");
		// A callback naming another client is someone else's registration: never this sign-in's.
		if (input.clientId !== null && input.clientId !== undefined && input.clientId !== this.#oauth.clientId)
			throw new ChatGptPlanSignInError("provider_error");
		if (typeof input.code !== "string" || !CODE.test(input.code)) throw new ChatGptPlanSignInError("provider_error");
		const confirmation = Buffer.from(this.#random(32)).toString("base64url");
		this.#parked.set(digest(confirmation), {
			confirmationSha256: digest(confirmation),
			signIn: started.signIn,
			code: input.code,
			codeVerifier: started.codeVerifier,
			nonce: started.nonce,
			expiresAt: this.#now() + CONFIRM_TTL_MS,
		});
		return { confirmation };
	}

	/** The web client confirms with the sign-in's capability. The parked code is removed before anything
	 * else (one attempt per confirmation id); then it is exchanged, the login sealed as version 1 and the
	 * sign-in completed. */
	async confirm(
		input: {
			readonly companyId: string;
			readonly loginId: string;
			readonly capability: string;
			readonly confirmation: unknown;
		},
		signal: AbortSignal,
	): Promise<void> {
		if (typeof input.confirmation !== "string" || !CONFIRMATION.test(input.confirmation) || !isUuid(input.loginId))
			throw new ChatGptPlanSignInError("state_unknown");
		const key = digest(input.confirmation);
		const parked = this.#parked.get(key);
		if (!parked || !same(parked.confirmationSha256, key)) throw new ChatGptPlanSignInError("state_unknown");
		this.#parked.delete(key);
		this.#sweep();
		if (
			parked.signIn.loginId !== input.loginId ||
			parked.signIn.companyId !== input.companyId.toLowerCase() ||
			!same(parked.signIn.capabilitySha256, digest(input.capability))
		)
			throw new ChatGptPlanSignInError("state_unknown");
		if (parked.expiresAt <= this.#now()) throw new ChatGptPlanSignInError("expired");
		if (!this.#keys.has(parked.signIn.keyId)) throw new ChatGptPlanSignInError("provider_error");
		let login: Awaited<ReturnType<ChatGptPlanOAuth["exchange"]>>;
		try {
			login = await this.#oauth.exchange(
				{ code: parked.code, codeVerifier: parked.codeVerifier, nonce: parked.nonce, hostId: parked.signIn.hostId },
				AbortSignal.any([signal, AbortSignal.timeout(EXCHANGE_DEADLINE_MS)]),
			);
		} catch (error) {
			// Only the status and OpenAI's error code: never the code, a token or the secret.
			console.error(`ChatGPT plan sign-in: the code exchange failed (${chatGptPlanFailure(error)}).`);
			throw new ChatGptPlanSignInError("provider_error");
		}
		const modelLoginId = randomUUID();
		const envelope = this.#keys.seal(
			{ [CHATGPT_PLAN_LOGIN_FIELD]: serializeChatGptPlanLogin(login) },
			{
				companyId: parked.signIn.companyId,
				environmentId: parked.signIn.computeIdentityId,
				secretId: modelLoginId,
				version: 1,
				keyId: parked.signIn.keyId,
			},
		);
		try {
			await this.#authority.completeChatGptPlanSignIn(
				{
					loginId: parked.signIn.loginId,
					capabilitySha256: parked.signIn.capabilitySha256,
					modelLoginId,
					keyId: parked.signIn.keyId,
					encryptedEnvelope: envelope,
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
					accessIssuedAt: login.accessIssuedAt,
					accessExpiresAt: login.accessExpiresAt,
					// One ChatGPT account, pseudonymously: the same account connected by two members can be seen.
					providerAccountReference: `openai-subject:${digest(login.subject)}`,
					providerAccountEmail: login.email,
					renewNotBefore: login.renewNotBefore,
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			);
		} catch {
			// The answer may have been lost after the save: the database decides. A login that was not
			// saved is ended at OpenAI, since nothing else holds it now.
			if (!(await this.#completed(parked.signIn, modelLoginId))) {
				void this.#oauth.revoke(login.refreshToken, AbortSignal.timeout(15_000)).catch(() => undefined);
				throw new ChatGptPlanSignInError("provider_error");
			}
		} finally {
			envelope.fill(0);
		}
	}

	/** Whether the database completed the sign-in with this login (another flow's login is not this one's). */
	async #completed(signIn: ChatGptPlanPendingSignIn, modelLoginId: string): Promise<boolean> {
		try {
			const answer = await this.#authority.describeModelLoginSignIn(
				{ loginId: signIn.loginId, capabilitySha256: signIn.capabilitySha256 },
				AbortSignal.timeout(CHECK_DEADLINE_MS),
			);
			const read = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
			return read.status === "completed" && read.modelLoginId === modelLoginId;
		} catch {
			return false;
		}
	}

	/** Drops ended entries: nothing was exchanged for them, so there is nothing to end at OpenAI. */
	#sweep(): void {
		const now = this.#now();
		for (const [key, started] of this.#started) {
			if (started.expiresAt > now) continue;
			this.#started.delete(key);
			if (this.#bySignIn.get(started.signIn.loginId) === started) this.#bySignIn.delete(started.signIn.loginId);
		}
		for (const [key, parked] of this.#parked) if (parked.expiresAt <= now) this.#parked.delete(key);
	}
}
