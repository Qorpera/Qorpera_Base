import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isChatGptPlanHostId } from "./cloud-chatgpt-plan.ts";
import type { ChatGptPlanSignInAuthority, ChatGptPlanSignIns } from "./cloud-chatgpt-plan-sign-in.ts";
import {
	CLAUDE_LOGIN_FILES,
	CLAUDE_LOGIN_FILES_SCHEMA,
	type ModelLoginSignInHelper,
	type ModelLoginSignInState,
} from "./cloud-model-login-sign-in.ts";
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
 *
 * A ChatGPT plan sign-in (Sign in with ChatGPT, built switched off) arrives the same way; the database's
 * v2 read names its kind, and the plan flow answers with OpenAI's authorization address instead of a
 * link and code (cloud-chatgpt-plan-sign-in.ts).
 *
 * An account sign-in (20260930548000; the v2 read names "scope": "account") is a member's Codex sign-in in a company
 * the shared vault serves: the vault seals it under the member's own key and completes it as the member's account
 * login, which the database links into every company of the member that this vault serves.
 *
 * A Claude sign-in (20260930564000; loginKind "claude", always an account sign-in in the shared vault) runs the
 * official Claude Code in the helper. Its poll answers with Anthropic's sign-in page; the member then pastes the code
 * Anthropic shows them, which the web client posts once to `claude/code` with the same capability. The helper writes it
 * to Claude Code, and once Claude Code has its login the vault seals its login files, unread, under the member's key and
 * completes the sign-in as the member's Claude login (coding sessions only; nothing that runs agents reads it).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGN_IN_SCHEMA = "qorpera.native-provider-login/v1";
const RESULT_SCHEMA = "qorpera.native-provider-login-result/v1";
const CLAUDE_CODE_SCHEMA = "qorpera.claude-sign-in-code/v1";
/** The sealed field of a Claude login: Claude Code's login files (`qorpera.claude-login-files/v1`). */
export const CLAUDE_LOGIN_FIELD = "claude_login_files";
const CLAUDE_CODE = /^[\x21-\x7e]{8,512}$/;
const SAVE_DEADLINE_MS = 15_000;
/** Refused lookups in a row (about 6 s of collections) before a finished login is dropped. */
const REFUSALS_BEFORE_END = 3;
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
	"hostId",
	"keyId",
	"loginId",
	"loginKind",
	"modelLoginId",
	"profileId",
	"schema",
	"status",
];

/** The sign-in side of the vault's database authority. */
export interface ModelLoginSignInAuthority extends ChatGptPlanSignInAuthority {
	/** The v2 read of a pending sign-in of either kind. */
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
	/** Completes a Claude sign-in (the shared vault only): Claude Code's login files, sealed under the member's key. */
	completeClaudeLoginSignIn?(
		completion: {
			loginId: string;
			capabilitySha256: string;
			claudeLoginId: string;
			keyId: string;
			encryptedEnvelope: Uint8Array;
			envelopeSha256: string;
			providerAccountReference: string | null;
			providerAccountEmail: string | null;
		},
		signal: AbortSignal,
	): Promise<unknown>;
	/** Completes an account sign-in (the shared vault only): the same fields, sealed under the member's key. */
	completeAccountModelLoginSignIn?(
		completion: Parameters<ModelLoginSignInAuthority["completeModelLoginSignIn"]>[0],
		signal: AbortSignal,
	): Promise<unknown>;
	/** The company this broker serves (its authority's company). */
	modelLoginBrokerCompany(signal: AbortSignal): Promise<unknown>;
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
	claude: boolean;
	clientConnectionId: string;
	computeIdentityId: string;
	expiresAt: number;
}

interface SignInDescription extends Ownership {
	loginId: string;
	loginKind: "codex" | "chatgpt_plan" | "claude";
	/** An account sign-in: the member's own login, kept once for every company of theirs this vault serves. */
	account: boolean;
	hostId: string | null;
	companyId: string;
	clientConnectionId: string;
	computeIdentityId: string;
	status: "pending" | "completed" | "cancelled" | "expired";
	expiresAt: string;
	keyId: string;
	/** The login a completed sign-in made, if any. */
	modelLoginId: string | null;
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
	const claude = input.provider === "anthropic" && input.native_harness === "claude-code";
	if (
		input.schema !== SIGN_IN_SCHEMA ||
		!(claude || (input.provider === "openai" && input.native_harness === "codex-cli")) ||
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
		claude,
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
	const account =
		Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value as object, "scope");
	const input = record(
		value,
		account ? [...DESCRIPTION_KEYS, "scope"] : DESCRIPTION_KEYS,
		"Vault sign-in description",
	);
	if (
		account &&
		(input.scope !== "account" ||
			(input.loginKind !== "codex" && input.loginKind !== "claude") ||
			input.computeIdentityOwnershipKind !== "member" ||
			input.computeIdentityOwnerUserId === null)
	)
		throw new Error("Vault sign-in description is invalid");
	// A Claude sign-in is always a member's account sign-in.
	if (input.loginKind === "claude" && !account) throw new Error("Vault sign-in description is invalid");
	if (
		input.schema !== "qorpera.model-login-sign-in/v2" ||
		(input.loginKind !== "codex" && input.loginKind !== "chatgpt_plan" && input.loginKind !== "claude") ||
		(input.loginKind === "chatgpt_plan" ? !isChatGptPlanHostId(input.hostId) : input.hostId !== null) ||
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
		loginKind: input.loginKind,
		account,
		hostId: input.hostId as string | null,
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
		modelLoginId: input.modelLoginId as string | null,
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

/** A Claude code the helper did not take, or that Claude Code refused: the member starts again. */
export class ClaudeCodeRefused extends Error {
	constructor() {
		super("Claude sign-in code was not accepted");
	}
}

/** Claude Code's login files as the helper read them: their shape only, never their contents. */
function checkClaudeLoginFiles(text: string): void {
	const value: unknown = JSON.parse(text);
	const input = record(value, ["schema", "files"], "Claude login files");
	const files = input.files;
	if (input.schema !== CLAUDE_LOGIN_FILES_SCHEMA || !files || typeof files !== "object" || Array.isArray(files))
		throw new Error("Claude login files are invalid");
	const names = Object.keys(files);
	if (
		!names.includes(".credentials.json") ||
		names.some(
			(name) =>
				!(CLAUDE_LOGIN_FILES as readonly string[]).includes(name) ||
				typeof (files as Record<string, unknown>)[name] !== "string" ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test((files as Record<string, string>)[name] as string),
		)
	)
		throw new Error("Claude login files are invalid");
}

/** The database answered, and it was not a sign-in this broker may complete. */
class SignInRefused extends Error {
	constructor() {
		super("Vault sign-in description is invalid");
	}
}

/** A definite refusal (not an outage): the database's authority or request errors, or an answer
 * the broker cannot read. */
function refused(error: unknown): boolean {
	if (error instanceof SignInRefused) return true;
	const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
	return code === "42501" || code === "22023";
}

export class CloudModelLoginSignIns {
	readonly #authority: ModelLoginSignInAuthority;
	readonly #keys: CloudSecretKeyring;
	/** Runs Codex sign-ins; absent, a Codex sign-in is refused. */
	readonly #helper: ModelLoginSignInHelper | undefined;
	/** Runs ChatGPT plan sign-ins; absent (no plan client configured), a plan sign-in is refused. */
	readonly #plan: ChatGptPlanSignIns | undefined;
	readonly #collectEveryMs: number;
	readonly #inFlight = new Set<string>();
	/** Collections the database refused in a row, per sign-in: after a few the helper's copy ends. */
	readonly #refusals = new Map<string, number>();
	#company: string | undefined;
	#collector: ReturnType<typeof setTimeout> | undefined;
	#collecting: Promise<void> | undefined;
	#stopped = true;

	constructor(options: {
		authority: ModelLoginSignInAuthority;
		keyring: CloudSecretKeyring;
		helper?: ModelLoginSignInHelper;
		plan?: ChatGptPlanSignIns;
		/** How often finished sign-ins are collected from the helper. */
		collectEveryMs?: number;
	}) {
		if (!options.helper && !options.plan) throw new Error("Vault sign-ins need a helper or a ChatGPT plan client");
		this.#authority = options.authority;
		this.#keys = options.keyring;
		this.#helper = options.helper;
		this.#plan = options.plan;
		this.#collectEveryMs = options.collectEveryMs ?? 2000;
	}

	/** Collects finished sign-ins in the background: the web client stops asking once it shows
	 * the link and code, and a broker that restarted still finds the sign-ins its helper holds. */
	start(): void {
		if (!this.#stopped) return;
		this.#stopped = false;
		const loop = (): void => {
			if (this.#stopped) return;
			this.#collecting = this.collect().finally(() => {
				this.#collecting = undefined;
				if (!this.#stopped) this.#collector = setTimeout(loop, this.#collectEveryMs);
			});
		};
		loop();
	}

	async close(): Promise<void> {
		this.#stopped = true;
		clearTimeout(this.#collector);
		await this.#collecting;
	}

	/** One collection pass: completes every finished Codex sign-in of this broker's company. */
	async collect(): Promise<void> {
		const helper = this.#helper;
		if (!helper) return;
		try {
			this.#company ??= uuid(
				await this.#authority.modelLoginBrokerCompany(AbortSignal.timeout(SAVE_DEADLINE_MS)),
				"Vault broker company",
			);
			const finished = await helper.listCompletedSignIns(
				{ companyId: this.#company },
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			);
			for (const signIn of finished)
				await this.#complete(this.#company, signIn.signInId, signIn.capabilitySha256).catch(() => false);
		} catch {
			// The next pass tries again.
		}
	}

	/** One poll of a member's sign-in: its state while the member is signing in. */
	async signIn(
		request: { companyId: string; capability: string; body: unknown },
		signal: AbortSignal,
	): Promise<ModelLoginSignInAnswer> {
		if (!TOKEN.test(request.capability)) throw new Error("Vault sign-in capability is invalid");
		const login = parseRequest(request.body, request.capability);
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const description = parseDescription(
			await this.#authority.describeModelLoginSignIn({ loginId: login.loginId, capabilitySha256 }, signal),
		);
		if (
			description.loginId !== login.loginId ||
			description.companyId !== request.companyId.toLowerCase() ||
			description.clientConnectionId !== login.clientConnectionId ||
			description.computeIdentityId !== login.computeIdentityId ||
			description.kind !== login.kind ||
			description.userId !== login.userId ||
			description.scopeKey !== login.scopeKey ||
			Date.parse(description.expiresAt) !== login.expiresAt ||
			(description.loginKind === "claude") !== login.claude
		)
			throw new Error("Vault sign-in request crossed its authority");
		if (description.loginKind === "chatgpt_plan") return this.#planSignIn(description, capabilitySha256, signal);
		const helper = this.#helper;
		if (!helper) throw new Error("Vault Codex sign-ins are not served here");
		const target = { signInId: login.loginId, companyId: description.companyId };
		if (description.status !== "pending") {
			await helper.finishSignIn(target, AbortSignal.timeout(10_000)).catch(() => undefined);
			if (description.status === "completed") return answer(login.loginId, "completed");
			throw new Error("Vault sign-in has ended");
		}
		let state: ModelLoginSignInState;
		try {
			state = await helper.beginSignIn(
				{
					signInId: login.loginId,
					companyId: description.companyId,
					computeIdentityId: description.computeIdentityId,
					capabilitySha256,
					expiresAt: description.expiresAt,
					...(description.loginKind === "claude" ? { harness: "claude-code" as const } : {}),
				},
				signal,
			);
		} catch {
			// A slow or restarting helper: the web client asks again, as with a node that is starting.
			return answer(login.loginId, "preparing");
		}
		if (state.status === "preparing") return answer(login.loginId, "preparing");
		if (state.status === "awaiting_member") return answer(login.loginId, "awaiting_member", state);
		if (state.status === "failed") {
			await helper.finishSignIn(target, AbortSignal.timeout(10_000)).catch(() => undefined);
			throw new Error("Vault sign-in failed");
		}
		// Codex has the login already: complete it now rather than at the next collection.
		return answer(
			login.loginId,
			(await this.#complete(description.companyId, login.loginId, capabilitySha256)) ? "completed" : "preparing",
		);
	}

	/** The code Anthropic showed the member for a Claude sign-in, posted once by the web client with the sign-in's
	 * capability: the helper gives it to Claude Code, and the vault keeps the login Claude Code ends with. */
	async submitClaudeCode(
		request: { companyId: string; capability: string; body: unknown },
		signal: AbortSignal,
	): Promise<ModelLoginSignInAnswer> {
		const helper = this.#helper;
		if (!helper?.submitCode) throw new Error("Vault Claude sign-ins are not served here");
		if (!TOKEN.test(request.capability)) throw new Error("Vault sign-in capability is invalid");
		const body = record(request.body, ["schema", "login_id", "code"], "Claude sign-in code");
		if (body.schema !== CLAUDE_CODE_SCHEMA || typeof body.code !== "string")
			throw new Error("Claude sign-in code is invalid");
		// Pasted text may carry spaces or a line end around the code; nothing else is changed.
		const code = body.code.trim();
		if (!CLAUDE_CODE.test(code)) throw new ClaudeCodeRefused();
		const loginId = uuid(body.login_id, "Claude sign-in id");
		const capabilitySha256 = createHash("sha256").update(request.capability).digest("hex");
		const description = parseDescription(
			await this.#authority.describeModelLoginSignIn({ loginId, capabilitySha256 }, signal),
		);
		if (
			description.loginId !== loginId ||
			description.companyId !== request.companyId.toLowerCase() ||
			description.loginKind !== "claude"
		)
			throw new Error("Claude sign-in code crossed its authority");
		if (description.status === "completed") return answer(loginId, "completed");
		if (description.status !== "pending") throw new Error("Vault sign-in has ended");
		const target = { signInId: loginId, companyId: description.companyId };
		let state: Awaited<ReturnType<NonNullable<ModelLoginSignInHelper["submitCode"]>>>;
		try {
			state = await helper.submitCode({ ...target, code }, signal);
		} catch {
			// The helper takes a code once, while Claude Code waits for it.
			throw new ClaudeCodeRefused();
		}
		if (state.status === "failed") {
			await helper.finishSignIn(target, AbortSignal.timeout(10_000)).catch(() => undefined);
			throw new ClaudeCodeRefused();
		}
		if (state.status === "completed")
			return answer(
				loginId,
				(await this.#complete(description.companyId, loginId, capabilitySha256)) ? "completed" : "preparing",
			);
		// Claude Code is still exchanging the code: the collection completes it, and the web client's next read sees it.
		if (state.status === "awaiting_member") return answer(loginId, "preparing");
		throw new Error("Vault sign-in has ended");
	}

	/** A plan sign-in's poll: OpenAI's authorization address while it waits for the member. */
	async #planSignIn(
		description: SignInDescription,
		capabilitySha256: string,
		signal: AbortSignal,
	): Promise<ModelLoginSignInAnswer> {
		const plan = this.#plan;
		if (!plan) throw new Error("Vault ChatGPT plan sign-ins are not served here");
		if (description.status === "completed") return answer(description.loginId, "completed");
		if (description.status !== "pending") throw new Error("Vault sign-in has ended");
		// A plan login is always a member's own.
		if (description.kind !== "member" || description.userId === null) throw new Error("Vault sign-in is invalid");
		const interactionUrl = await plan.begin(
			{
				loginId: description.loginId,
				companyId: description.companyId,
				computeIdentityId: description.computeIdentityId,
				hostId: description.hostId as string,
				expiresAt: description.expiresAt,
				keyId: description.keyId,
				capabilitySha256,
			},
			signal,
		);
		return answer(description.loginId, "awaiting_member", { interactionUrl });
	}

	/** OpenAI's callback for a plan sign-in, forwarded by the callback Edge Function: a one-time
	 * confirmation id for the returning browser. */
	receiveChatGptPlan(input: { companyId: string; state: unknown; code: unknown; error: unknown; clientId: unknown }): {
		confirmation: string;
	} {
		const plan = this.#plan;
		if (!plan) throw new Error("Vault ChatGPT plan sign-ins are not served here");
		return plan.receive(input);
	}

	/** The web client's confirmation of a plan sign-in, under the sign-in's capability. */
	async confirmChatGptPlan(
		input: { companyId: string; capability: string; body: unknown },
		signal: AbortSignal,
	): Promise<ModelLoginSignInAnswer> {
		const plan = this.#plan;
		if (!plan) throw new Error("Vault ChatGPT plan sign-ins are not served here");
		if (!TOKEN.test(input.capability)) throw new Error("Vault sign-in capability is invalid");
		const body = record(input.body, ["schema", "login_id", "confirmation"], "ChatGPT plan confirmation");
		if (body.schema !== "qorpera.chatgpt-plan-confirm/v1") throw new Error("ChatGPT plan confirmation is invalid");
		const loginId = uuid(body.login_id, "ChatGPT plan sign-in id");
		await plan.confirm(
			{ companyId: input.companyId, loginId, capability: input.capability, confirmation: body.confirmation },
			signal,
		);
		return answer(loginId, "completed");
	}

	/** Seals a finished Claude sign-in's login files under the member's key and completes it as their Claude login. */
	async #completeClaude(
		description: SignInDescription,
		capabilitySha256: string,
		state: Extract<ModelLoginSignInState, { status: "completed" }>,
		finish: () => Promise<void>,
		describe: () => Promise<SignInDescription>,
	): Promise<boolean> {
		try {
			checkClaudeLoginFiles(state.authJson);
		} catch (error) {
			await finish();
			throw error;
		}
		const completeClaude = this.#authority.completeClaudeLoginSignIn?.bind(this.#authority);
		if (!completeClaude || description.userId === null || !this.#keys.hasMemberKey(description.keyId)) {
			await finish();
			throw new Error("The vault does not keep Claude logins");
		}
		const claudeLoginId = description.modelLoginId ?? randomUUID();
		const envelope = this.#keys.sealMember(
			{ [CLAUDE_LOGIN_FIELD]: state.authJson },
			{ memberId: description.userId, loginId: claudeLoginId, version: 1, keyId: description.keyId },
		);
		try {
			await completeClaude(
				{
					loginId: description.loginId,
					capabilitySha256,
					claudeLoginId,
					keyId: description.keyId,
					encryptedEnvelope: envelope,
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
					providerAccountReference: state.providerAccountReference ?? null,
					providerAccountEmail: state.providerAccountEmail ?? null,
				},
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			);
		} catch {
			// As for Codex: the database decides whether a lost answer saved it.
			if ((await describe().catch(() => undefined))?.status !== "completed") return false;
		} finally {
			envelope.fill(0);
		}
		await finish();
		return true;
	}

	/** Seals a finished sign-in's login as version 1 and completes it in the database. True when
	 * the sign-in is complete; the helper's copy is ended once the sign-in is settled either way. */
	async #complete(companyId: string, signInId: string, capabilitySha256: string): Promise<boolean> {
		const helper = this.#helper;
		if (!helper || this.#inFlight.has(signInId)) return false;
		this.#inFlight.add(signInId);
		const target = { signInId, companyId };
		const finish = () => helper.finishSignIn(target, AbortSignal.timeout(10_000)).catch(() => undefined);
		const describe = async (): Promise<SignInDescription> => {
			const answer = await this.#authority.describeModelLoginSignIn(
				{ loginId: signInId, capabilitySha256 },
				AbortSignal.timeout(SAVE_DEADLINE_MS),
			);
			try {
				return parseDescription(answer);
			} catch {
				throw new SignInRefused();
			}
		};
		try {
			let description: SignInDescription;
			try {
				description = await describe();
				this.#refusals.delete(signInId);
			} catch (error) {
				// Only a refusal counts: the company was switched back or its broker authority
				// changed while the member finished, and the helper must not keep the login until its
				// own timer ends. An outage or a timeout keeps it for the next collection.
				if (!refused(error)) throw error;
				const refusals = (this.#refusals.get(signInId) ?? 0) + 1;
				if (refusals >= REFUSALS_BEFORE_END) {
					this.#refusals.delete(signInId);
					await finish();
				} else this.#refusals.set(signInId, refusals);
				throw error;
			}
			if (description.companyId !== companyId || description.loginId !== signInId) return false;
			// A plan sign-in never completes through the Codex helper.
			if (description.loginKind === "chatgpt_plan") {
				await finish();
				return false;
			}
			if (description.status !== "pending") {
				await finish();
				return description.status === "completed";
			}
			const state = await helper.readSignIn(target, AbortSignal.timeout(10_000));
			if (state.status === "failed") await finish();
			if (state.status !== "completed") return false;
			if (description.loginKind === "claude")
				return await this.#completeClaude(description, capabilitySha256, state, finish, describe);
			let codex: ReturnType<typeof parseCodexLogin>;
			try {
				codex = parseCodexLogin(state.authJson);
			} catch (error) {
				// Not a login the vault can keep: nothing holds it any longer.
				await finish();
				throw error;
			}
			// An account sign-in is sealed under its member's key, which only the shared vault's master key derives.
			const completeAccount = this.#authority.completeAccountModelLoginSignIn?.bind(this.#authority);
			if (
				description.account
					? !completeAccount || description.userId === null || !this.#keys.hasMemberKey(description.keyId)
					: !this.#keys.has(description.keyId)
			) {
				await finish();
				throw new Error("The vault does not hold the company's key");
			}
			const modelLoginId = randomUUID();
			const fields = { [MODEL_LOGIN_FIELD]: codex.text };
			const envelope =
				description.account && description.userId !== null
					? this.#keys.sealMember(fields, {
							memberId: description.userId,
							loginId: modelLoginId,
							version: 1,
							keyId: description.keyId,
						})
					: this.#keys.seal(fields, {
							companyId: description.companyId,
							environmentId: description.computeIdentityId,
							secretId: modelLoginId,
							version: 1,
							keyId: description.keyId,
						});
			try {
				const completion = {
					loginId: signInId,
					capabilitySha256,
					modelLoginId,
					keyId: description.keyId,
					encryptedEnvelope: envelope,
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
					accessIssuedAt: codex.accessIssuedAt,
					accessExpiresAt: codex.accessExpiresAt,
					providerAccountReference: state.providerAccountReference ?? null,
					providerAccountEmail: state.providerAccountEmail ?? null,
				};
				const signal = AbortSignal.timeout(SAVE_DEADLINE_MS);
				if (description.account && completeAccount) await completeAccount(completion, signal);
				else await this.#authority.completeModelLoginSignIn(completion, signal);
			} catch {
				// The answer may have been lost after the save: the database decides. Otherwise the
				// helper keeps the login and the next collection tries again.
				if ((await describe().catch(() => undefined))?.status !== "completed") return false;
			} finally {
				envelope.fill(0);
			}
			await finish();
			return true;
		} finally {
			this.#inFlight.delete(signInId);
		}
	}
}
