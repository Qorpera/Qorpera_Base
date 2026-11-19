import {
	type CreateMemberSponsorInput,
	type NativeExecutionConnections,
	type NativeMemberConnection,
	type NativeProviderLoginAuthorization,
	NativeSubscriptionControlPlane,
	type RequestSponsoredSessionTurnInput,
	type RevokeNativeProviderConnectionInput,
	type SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	type NativeAccountRefreshDescription,
	type NativeAccountRefreshRequest,
	nativeAccountRefreshBody,
	parseNativeAccountRefreshDescription,
	parseNativeAccountRefreshResult,
} from "@qorpera/cloud-client/native-account-refresh";
import { HttpNativeProviderIdentityBridge } from "@qorpera/cloud-client/native-provider-login";
import type { ChatGptPlanReturn, ChatGptPlanSignIn } from "./chatgpt-plan-sign-in.ts";
import { type Cloud, CloudRpcError } from "./client.ts";
import { parseCloudConfig } from "./deployment-config.ts";
import { UUID_PATTERN } from "./parse.ts";

export interface WebNativeProviderLoginInput {
	provider: "openai" | "anthropic";
	displayName: string;
	clientIdentityId: string;
	clientLoginId: string;
	clientConnectionId: string;
}

export interface WebNativeProviderLogin {
	loginId: string;
	clientConnectionId: string;
	status: "awaiting_member" | "completed" | "preparing";
	interactionUrl?: string;
	userCode?: string;
	expiresAt: string;
	/** A Claude sign-in (20260930564000): sends the code Anthropic showed the member, once. Resolves `completed` when
	 * the vault saved the login, `saving` when it is still saving it (the member's list shows it soon); throws
	 * `ClaudeCodeError` when Claude Code refused the code. */
	submitCode?: (code: string, signal?: AbortSignal) => Promise<"completed" | "saving">;
}

export interface WebClaudeLogin {
	loginId: string;
	providerAccountEmail?: string;
	createdAt: string;
	clientConnectionId: string;
	inUse?: boolean;
	usedUpUntil?: string;
	usage?: WebClaudeUsage;
	resets?: WebClaudeResets;
	lastReset?: WebClaudeLastReset;
}
export interface WebClaudeLogins {
	/** Whether this member may sign in with Claude in this company now. */
	signInOpen: boolean;
	readable?: boolean;
	logins: readonly WebClaudeLogin[];
}

export type WebClaudeResetKind = "session" | "weekly" | "fable" | "full";
export interface WebClaudeUsage {
	observedAt: string;
	windows: readonly {
		id: "five_hour" | "seven_day" | "seven_day_model";
		label: string;
		usedPercent: number;
		resetAt?: string;
	}[];
	limitResetAt?: string;
}
export interface WebClaudeResetEntry {
	kind: WebClaudeResetKind | null;
	left: number;
	refills: string | null;
	weekStays: string | null;
	useBy: string | null;
	usable: "now" | "at_limit";
}
export interface WebClaudeResets {
	observedAt: string;
	entries: readonly WebClaudeResetEntry[];
}
export interface WebClaudeLastReset {
	requestId: string;
	kind: WebClaudeResetKind;
	outcome: "reset" | "failed" | "unconfirmed";
	left: number | null;
	at: string;
}

const CLAUDE_RESET_KINDS: readonly WebClaudeResetKind[] = ["session", "weekly", "fable", "full"];
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const shortText = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 120;

function parseClaudeUsage(value: unknown): WebClaudeUsage | undefined {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== "object" || !instant(input.observedAt) || !Array.isArray(input.windows))
		return undefined;
	const windows: WebClaudeUsage["windows"][number][] = [];
	for (const item of input.windows.slice(0, 4)) {
		const window = item as Record<string, unknown> | null;
		if (
			!window ||
			!["five_hour", "seven_day", "seven_day_model"].includes(window.id as string) ||
			!shortText(window.label) ||
			typeof window.usedPercent !== "number" ||
			!(window.usedPercent >= 0 && window.usedPercent <= 100)
		)
			return undefined;
		windows.push({
			id: window.id as WebClaudeUsage["windows"][number]["id"],
			label: window.label,
			usedPercent: window.usedPercent,
			...(instant(window.resetAt) ? { resetAt: window.resetAt } : {}),
		});
	}
	return windows.length
		? {
				observedAt: input.observedAt,
				windows,
				...(instant(input.limitResetAt) ? { limitResetAt: input.limitResetAt } : {}),
			}
		: undefined;
}

function parseClaudeResets(value: unknown): WebClaudeResets | undefined {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== "object" || !instant(input.observedAt) || !Array.isArray(input.entries))
		return undefined;
	const entries: WebClaudeResetEntry[] = [];
	for (const item of input.entries.slice(0, 4)) {
		const entry = item as Record<string, unknown> | null;
		if (
			!entry ||
			(entry.kind !== null && !CLAUDE_RESET_KINDS.includes(entry.kind as WebClaudeResetKind)) ||
			!Number.isSafeInteger(entry.left) ||
			(entry.left as number) < 0 ||
			(entry.usable !== "now" && entry.usable !== "at_limit")
		)
			return undefined;
		entries.push({
			kind: entry.kind as WebClaudeResetKind | null,
			left: entry.left as number,
			refills: shortText(entry.refills) ? entry.refills : null,
			weekStays: instant(entry.weekStays) ? entry.weekStays : null,
			useBy: instant(entry.useBy) ? entry.useBy : null,
			usable: entry.usable,
		});
	}
	return { observedAt: input.observedAt, entries };
}

function parseClaudeLastReset(value: unknown): WebClaudeLastReset | undefined {
	const input = value as Record<string, unknown> | null;
	if (
		!input ||
		typeof input !== "object" ||
		typeof input.requestId !== "string" ||
		!UUID_PATTERN.test(input.requestId) ||
		!CLAUDE_RESET_KINDS.includes(input.kind as WebClaudeResetKind) ||
		!["reset", "failed", "unconfirmed"].includes(input.outcome as string) ||
		!(input.left === null || (Number.isSafeInteger(input.left) && (input.left as number) >= 0)) ||
		!instant(input.at)
	)
		return undefined;
	return {
		requestId: input.requestId,
		kind: input.kind as WebClaudeResetKind,
		outcome: input.outcome as WebClaudeLastReset["outcome"],
		left: input.left as number | null,
		at: input.at,
	};
}

export class ClaudeReadNotStarted extends Error {
	constructor() {
		super("The Claude read was not started.");
	}
}

/** Claude Code did not take the code (or it was not one): the member signs in again. */
export class ClaudeCodeError extends Error {
	constructor() {
		super("The code was not accepted.");
	}
}

/** The pages Claude Code's own sign-in sends a member to. */
const CLAUDE_SIGN_IN_HOSTS = new Set(["claude.com", "claude.ai", "platform.claude.com"]);

function parseClaudeLogins(value: unknown): WebClaudeLogins {
	const input = value as Record<string, unknown> | null;
	if (!input || input.schema !== "qorpera.claude-logins/v1" || !Array.isArray(input.logins))
		throw new Error("Invalid cloud response");
	const logins: WebClaudeLogin[] = [];
	for (const item of input.logins) {
		const entry = item as Record<string, unknown> | null;
		if (
			!entry ||
			typeof entry.loginId !== "string" ||
			!UUID_PATTERN.test(entry.loginId) ||
			typeof entry.clientConnectionId !== "string" ||
			!UUID_PATTERN.test(entry.clientConnectionId) ||
			typeof entry.createdAt !== "string" ||
			(entry.providerAccountEmail !== null && typeof entry.providerAccountEmail !== "string") ||
			(entry.usedUpUntil !== undefined &&
				entry.usedUpUntil !== null &&
				(typeof entry.usedUpUntil !== "string" || !Number.isFinite(Date.parse(entry.usedUpUntil))))
		)
			throw new Error("Invalid cloud response");
		const usage = parseClaudeUsage(entry.usage);
		const resets = parseClaudeResets(entry.resets);
		const lastReset = parseClaudeLastReset(entry.lastReset);
		logins.push({
			loginId: entry.loginId,
			clientConnectionId: entry.clientConnectionId,
			createdAt: entry.createdAt,
			...(typeof entry.providerAccountEmail === "string"
				? { providerAccountEmail: entry.providerAccountEmail }
				: {}),
			...(usage ? { usage } : {}),
			...(resets ? { resets } : {}),
			...(lastReset ? { lastReset } : {}),
			...(entry.inUse === true ? { inUse: true } : {}),
			...(typeof entry.usedUpUntil === "string" ? { usedUpUntil: entry.usedUpUntil } : {}),
		});
	}
	return { signInOpen: input.signInOpen === true, readable: input.readable === true, logins };
}

/** A member's connection with what the web reads beside the SDK's fields (migration
 * 20260929970000): the login's kind (absent for a node login), whether its member turned
 * on work while away for this version, and when the member's first-routine card was shown;
 * and (migration 20260930559000) its recent turns: whether the provider refused its last three
 * runs (the newest in six hours) and whether it completed a run this week, which order a first choice. */
export type WebMemberConnection = NativeMemberConnection & {
	loginKind?: "codex" | "chatgpt_plan";
	allowAutonomous?: boolean;
	routineOfferShownAt?: string;
	recentTurns?: { refused: boolean; completed: boolean };
};
export interface WebExecutionConnections extends NativeExecutionConnections {
	connections: readonly WebMemberConnection[];
}
/** A member's account model login (20260930548000): one sign-in, used in every company of theirs that the shared
 * vault serves. `connectionIds` are its connections in this company. */
export interface WebAccountLogin {
	loginId: string;
	status: "active" | "needs_sign_in";
	providerAccountEmail?: string;
	/** How many companies use it now. */
	companies: number;
	connectionIds: readonly string[];
}
export interface WebAccountLogins {
	/** Whether sign-ins here are account sign-ins (the switch is on, the shared vault serves this company and the
	 * company takes sign-ins in the vault: 20260930554000). */
	enabled: boolean;
	logins: readonly WebAccountLogin[];
}

/** The member's account logins from the cloud's answer; anything malformed reads as none. */
export function parseAccountLogins(value: unknown): WebAccountLogins {
	const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	if (input.schema !== "qorpera.account-model-logins/v1" || !Array.isArray(input.logins))
		throw new Error("Invalid cloud response");
	const logins: WebAccountLogin[] = [];
	for (const item of input.logins) {
		const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
		if (
			typeof entry.loginId !== "string" ||
			!UUID_PATTERN.test(entry.loginId) ||
			(entry.status !== "active" && entry.status !== "needs_sign_in") ||
			typeof entry.companies !== "number" ||
			!Number.isSafeInteger(entry.companies) ||
			!Array.isArray(entry.connectionIds) ||
			!entry.connectionIds.every((connection) => typeof connection === "string" && UUID_PATTERN.test(connection))
		)
			throw new Error("Invalid cloud response");
		logins.push({
			loginId: entry.loginId,
			status: entry.status,
			...(typeof entry.providerAccountEmail === "string"
				? { providerAccountEmail: entry.providerAccountEmail }
				: {}),
			companies: entry.companies,
			connectionIds: entry.connectionIds as string[],
		});
	}
	return { enabled: input.enabled === true, logins };
}

function sessionCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid conversation account response.");
	return value;
}

/** A ChatGPT plan login: its member alone turns on work while away (Sign in with ChatGPT). */
export const planLogin = (connection: WebMemberConnection): boolean => connection.loginKind === "chatgpt_plan";

export interface WebNativeSubscription {
	readonly onboardingAvailable: boolean;
	beginProviderLogin(input: WebNativeProviderLoginInput, signal?: AbortSignal): Promise<WebNativeProviderLogin>;
	listConnections(signal?: AbortSignal): Promise<WebExecutionConnections>;
	/** Resolves once account usage is current. `force` asks for a new observation
	 * even inside the window of a completed attempt: the member pressed Refresh.
	 * `known`: the accounts as the caller read them just now, so they are not read again. */
	refreshAccountMetadata?(signal?: AbortSignal, force?: boolean, known?: NativeExecutionConnections): Promise<void>;
	selectSessionAccount?(sessionId: string, signal?: AbortSignal): Promise<string | undefined>;
	/** The member picks a conversation's login by hand (20260930059000): the only way a
	 * conversation moves to another login, offered once its own login was disconnected. */
	chooseSessionAccount?(sessionId: string, connectionId: string, signal?: AbortSignal): Promise<string>;
	countSessionsOnAccount?(connectionId: string, signal?: AbortSignal): Promise<number>;
	chooseSessionsAccount?(fromConnectionId: string, connectionId: string, signal?: AbortSignal): Promise<number>;
	requestSessionTurn(input: RequestSponsoredSessionTurnInput, signal?: AbortSignal): Promise<SessionTurnRequestResult>;
	createMemberSponsor(
		input: Omit<CreateMemberSponsorInput, "profileId"> & { planLogin?: boolean },
		signal?: AbortSignal,
	): Promise<{ bindingId: string; version: number }>;
	/** The member's own choice for their ChatGPT plan: work while they are away, or not. */
	setWorkWhileAway?(connectionId: string, on: boolean, signal?: AbortSignal): Promise<void>;
	/** Records that the member was shown the first-routine card (once per member and company). */
	recordRoutineOffer?(connectionId: string, signal?: AbortSignal): Promise<string>;
	/** Whether the company may use ChatGPT plan logins now (both switches on). */
	chatGptPlanAvailable?(signal?: AbortSignal): Promise<boolean>;
	/** The member's Claude login and whether they may sign in with Claude here (20260930564000). */
	listClaudeLogins?(signal?: AbortSignal): Promise<WebClaudeLogins>;
	/** Ends the member's Claude login; its sealed files are wiped. */
	signOutClaude?(loginId: string, signal?: AbortSignal, nextLoginId?: string): Promise<void>;
	useClaude?(loginId: string, signal?: AbortSignal): Promise<void>;
	readClaude?(
		options: { loginId: string; force?: boolean; reset?: WebClaudeResetKind },
		signal?: AbortSignal,
	): Promise<string>;
	/** Begins "Continue with ChatGPT": OpenAI's address to send the browser to, and what this tab keeps. */
	beginChatGptPlanSignIn?(
		displayName: string,
		signal?: AbortSignal,
	): Promise<{ url: string; signIn: Omit<ChatGptPlanSignIn, "returnRoute"> }>;
	/** Finishes it with the callback's one-time confirmation id. */
	finishChatGptPlanSignIn?(outcome: ChatGptPlanReturn, signal?: AbortSignal): Promise<void>;
	revokeConnection(
		input: Omit<RevokeNativeProviderConnectionInput, "profileId">,
		signal?: AbortSignal,
	): Promise<{ connectionId: string; status: "revoked" }>;
	/** The member's account logins, and which of this company's connections use them. */
	listAccountLogins?(signal?: AbortSignal): Promise<WebAccountLogins>;
	/** Ends an account login in every company (the per-company Disconnect only stops using it here). */
	signOutEverywhere?(loginId: string, signal?: AbortSignal): Promise<void>;
}

/** The same rule as the server's admission: usage observed within the last
 * minute whose windows have not reset needs no new observation. Requesting one
 * anyway records an attempt, and a stale one boots a login guest. Inside the
 * window of an attempt that already completed (`held`), only a reset that has
 * passed since justifies another: usage that attempt could not observe, or
 * that has merely aged, would not be observed by asking again. */
function usageStale(account: NativeMemberConnection, now: number, held: boolean): boolean {
	const usage = account.providerAccountUsage;
	if (!usage) return !held;
	if (!held) {
		const observedAt = Date.parse(usage.observedAt);
		if (!(observedAt > now - 60_000) || observedAt > now + 30_000) return true;
	}
	return usage.windows.some((window) => window.resetAt !== undefined && Date.parse(window.resetAt) <= now);
}

/** Why a ChatGPT plan sign-in did not start or finish: the switches are off, the member has a
 * usable plan already, or the callback's reason (state_unknown, expired, declined, provider_error,
 * busy). */
export class ChatGptPlanSignInError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super("ChatGPT plan sign-in did not go through.");
		this.reason = reason;
	}
}
const CONFIRM_DEADLINE_MS = 45_000;

/** The plan's switch waited too long for a lock, or lost a deadlock (55P03, 20260929985000): nothing changed,
 * and the member can press it again. */
export class PlanSwitchBusyError extends Error {
	constructor() {
		super("The ChatGPT plan switch is busy.");
	}
}

/** The plan fields of one connection version, from the list's own answer; anything malformed
 * reads as absent (a Codex or node login). */
function withPlanFields(connection: NativeMemberConnection, answer: unknown): WebMemberConnection {
	const entries =
		answer && typeof answer === "object" && Array.isArray((answer as { connections?: unknown }).connections)
			? ((answer as { connections: unknown[] }).connections as unknown[])
			: [];
	const entry = entries.find(
		(item): item is Record<string, unknown> =>
			Boolean(item) &&
			typeof item === "object" &&
			(item as Record<string, unknown>).connection_id === connection.connectionId &&
			(item as Record<string, unknown>).connection_version === connection.connectionVersion,
	);
	if (!entry) return connection;
	const kind = entry.login_kind;
	const shown = entry.routine_offer_shown_at;
	const turns = entry.recent_turns;
	const refused = turns && typeof turns === "object" ? (turns as Record<string, unknown>).refused : undefined;
	const completed = turns && typeof turns === "object" ? (turns as Record<string, unknown>).completed : undefined;
	return {
		...connection,
		...(kind === "codex" || kind === "chatgpt_plan" ? { loginKind: kind } : {}),
		...(typeof entry.allow_autonomous === "boolean" ? { allowAutonomous: entry.allow_autonomous } : {}),
		...(typeof shown === "string" && Number.isFinite(Date.parse(shown)) ? { routineOfferShownAt: shown } : {}),
		...(typeof refused === "boolean" && typeof completed === "boolean"
			? { recentTurns: { refused, completed } }
			: {}),
	};
}

/** The SDK owns admission and provenance contracts. This host only supplies
 * member authentication, profile selection and cancellable browser transport.
 * Callers retain mutation request IDs before submission for explicit recovery. */
export function createWebNativeSubscription(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId?: string) => void,
): WebNativeSubscription {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid cloud execution configuration.");
	const loginBase =
		cloud.config.nativeProviderLoginUrl === undefined
			? undefined
			: parseCloudConfig(cloud.config).nativeProviderLoginUrl;
	const rpc = (method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, sessionId?: string) => {
		// Snapshot SDK arguments before authentication can yield to another UI action.
		const body = JSON.stringify(args);
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current(sessionId);
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to manage cloud execution.");
				// No `cache` option: no browser stores the answer to a POST, and "no-store" would only make Chrome send the CORS preflight again on every call, one more round trip each time.
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body,
					signal: deadline,
					redirect: "error",
					credentials: "omit",
				});
				cloud.noticeResponse?.(`${origin.origin}/rest/v1/rpc/${method}`, data.session.access_token, response);
				try {
					check();
					if (response.status === 401 || response.status === 403)
						throw new CloudRpcError(
							method,
							{ message: "You do not have permission to manage this cloud execution.", code: "42501" },
							response.status,
						);
					if (response.status !== 200) {
						if (method === "qorpera_begin_native_account_refresh") {
							const failure: unknown = JSON.parse(
								new TextDecoder().decode(await readBoundedCloudResponse(response, 64 * 1024, deadline)),
							);
							if (failure && typeof failure === "object" && "code" in failure && failure.code === "55000")
								throw new CloudRpcError(
									method,
									{ message: "Account refresh is in progress", code: "55000" },
									response.status,
								);
						}
						if (method === "qorpera_begin_claude_login_read") {
							const failure = JSON.parse(
								new TextDecoder().decode(await readBoundedCloudResponse(response, 64 * 1024, deadline)),
							) as { code?: unknown; message?: unknown } | null;
							if (typeof failure?.code === "string" && /^[0-9A-Z]{5}$/.test(failure.code))
								throw new CloudRpcError(
									method,
									{
										message: typeof failure.message === "string" ? failure.message.slice(0, 200) : "",
										code: failure.code,
									},
									response.status,
								);
						}
						throw new Error("Cloud execution response was unavailable.");
					}
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, deadline),
						),
					);
					check();
					return value;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			10000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		).catch((error: unknown) => {
			if (
				error instanceof CloudRpcError &&
				(error.denied ||
					(method === "qorpera_begin_native_account_refresh" && error.code === "55000") ||
					method === "qorpera_begin_claude_login_read")
			)
				throw error;
			throw new Error("Cloud execution could not be confirmed. Refresh its status before trying again.");
		});
	};
	const client = (signal?: AbortSignal, sessionId?: string) =>
		new NativeSubscriptionControlPlane({ rpc: (method, args) => rpc(method, args, signal, sessionId) });
	/** A Codex login's consent, or (`plan`) a ChatGPT plan's through its member's own switch, which the
	 * kernel requires for a plan (20260929980000). */
	const consent = async (connectionId: string, allow: boolean, plan = false): Promise<number> => {
		const value = (
			plan
				? await cloud
						.rpc("qorpera_set_chatgpt_plan_work_while_away", {
							p_profile_id: profileId,
							p_connection_id: connectionId,
							p_on: allow,
						})
						.catch((error: unknown) => {
							if (error instanceof CloudRpcError && error.code === "55P03") throw new PlanSwitchBusyError();
							throw error;
						})
				: await cloud.rpc("qorpera_consent_provider_connection_autonomous", {
						p_profile_id: profileId,
						p_connection_id: connectionId,
						p_allow_autonomous: allow,
					})
		) as { connection_id?: unknown; version?: unknown; allow_autonomous?: unknown } | null;
		if (
			value?.connection_id !== connectionId ||
			value.allow_autonomous !== allow ||
			!Number.isSafeInteger(value.version)
		)
			throw new Error("Invalid cloud response");
		return value.version as number;
	};
	let pendingMetadataRefresh: Promise<void> | undefined;
	let metadataAdmission:
		| { clientRequestId: string; capability: string; expiresAt: number; completed: boolean; requestId?: string }
		| undefined;
	const admit = () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const capability = btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		metadataAdmission = {
			clientRequestId: crypto.randomUUID(),
			capability,
			expiresAt: Date.now() + 300_000,
			completed: false,
		};
		return metadataAdmission;
	};
	return {
		onboardingAvailable: loginBase !== undefined,
		beginProviderLogin: (input, signal) => {
			// Admission creates its capability inside the SDK. Calling admission again
			// with the same IDs would create different authority, so never retry it.
			const request = { ...input };
			return withCloudDeadline(
				async (deadline) => {
					const check = () => {
						deadline.throwIfAborted();
						current();
					};
					check();
					if (!loginBase) throw new Error("Native provider login is not configured.");
					if (
						(request.provider !== "openai" && request.provider !== "anthropic") ||
						!request.displayName.trim() ||
						request.displayName.length > 120 ||
						/[\0\r\n]/.test(request.displayName) ||
						![request.clientIdentityId, request.clientLoginId, request.clientConnectionId].every((value) =>
							/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
						)
					)
						throw new Error("Native provider login input is invalid.");
					const control = client(deadline);
					const existing = await control.listConnections(profileId);
					check();
					const identity =
						existing.computeIdentity ??
						(await control.createMemberComputeIdentity({
							profileId,
							clientIdentityId: request.clientIdentityId,
							displayName: request.displayName,
							policy: { credentialExport: false, operatorBlindnessClaimed: false },
						}));
					check();
					if (
						identity.ownerUserId !== memberId ||
						identity.ownershipKind !== "member" ||
						identity.status !== "active"
					)
						throw new Error("Native provider login identity does not match this member.");
					const harness = request.provider === "openai" ? "codex-cli" : "claude-code";
					const authorization = await control.beginNativeProviderLogin({
						profileId,
						computeIdentityId: identity.computeIdentityId,
						provider: request.provider,
						nativeHarness: harness,
						clientLoginId: request.clientLoginId,
						clientConnectionId: request.clientConnectionId,
					});
					check();
					if (
						authorization.computeIdentityId !== identity.computeIdentityId ||
						authorization.computeIdentityOwnershipKind !== "member" ||
						authorization.computeIdentityOwnerUserId !== memberId ||
						authorization.provider !== request.provider ||
						authorization.nativeHarness !== harness ||
						authorization.clientLoginId !== request.clientLoginId ||
						authorization.clientConnectionId !== request.clientConnectionId
					)
						throw new Error("Native provider login authority does not match this request.");
					const endpoint = new URL("login", loginBase).href;
					const bridge = new HttpNativeProviderIdentityBridge(
						loginBase,
						async (url, init) => {
							const checkBridge = () => {
								check();
								init?.signal?.throwIfAborted();
							};
							checkBridge();
							if (String(url) !== endpoint || init?.method !== "POST")
								throw new Error("Unexpected native login destination.");
							const { data, error } = await cloud.supabase.auth.getSession();
							checkBridge();
							if (error || data.session?.user.id !== memberId) throw new Error("Native login account changed.");
							// The bridge supplies only the scoped capability, never the member JWT.
							const response = await fetch(endpoint, {
								...init,
								credentials: "omit",
								cache: "no-store",
								redirect: "error",
							});
							try {
								checkBridge();
								if (response.status === 401 || response.status === 403)
									throw new CloudRpcError(
										"native-provider-login",
										{ message: "You do not have permission to start this provider login.", code: "42501" },
										response.status,
									);
								return response;
							} catch (error) {
								if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
								throw error;
							}
						},
						{ signal: deadline },
					);
					let prompt = await bridge.beginLogin(authorization);
					check();
					// The node answers `preparing` while it boots or recovers the login
					// machine (up to a few minutes); the same login is posted again.
					while (prompt.status === "preparing") {
						await new Promise<void>((resolve, reject) => {
							const interrupted = () => {
								clearTimeout(timer);
								reject(new Error("Provider login preparation was interrupted."));
							};
							const timer = setTimeout(() => {
								deadline.removeEventListener("abort", interrupted);
								resolve();
							}, 1000);
							deadline.addEventListener("abort", interrupted, { once: true });
						});
						check();
						prompt = await bridge.beginLogin(authorization);
						check();
					}
					if (request.provider !== "anthropic")
						return {
							...prompt,
							clientConnectionId: request.clientConnectionId,
							expiresAt: authorization.expiresAt,
						};
					// Claude: Anthropic's own sign-in page, then the code it shows the member, sent once to the vault with the
					// sign-in's capability (never the member's token, never kept).
					if (
						prompt.status === "awaiting_member" &&
						(!prompt.interactionUrl || !CLAUDE_SIGN_IN_HOSTS.has(new URL(prompt.interactionUrl).hostname))
					)
						throw new Error("Claude sign-in did not answer with Anthropic's address.");
					const capability = authorization.capability;
					let sent = false;
					const submitCode = async (code: string, codeSignal?: AbortSignal): Promise<"completed" | "saving"> => {
						if (sent) throw new ClaudeCodeError();
						sent = true;
						const checked = AbortSignal.any([
							AbortSignal.timeout(CONFIRM_DEADLINE_MS),
							companySignal,
							...(codeSignal ? [codeSignal] : []),
						]);
						current();
						const response = await fetch(new URL("claude-code", loginBase).href, {
							method: "POST",
							headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
							body: JSON.stringify({
								schema: "qorpera.claude-sign-in-code/v1",
								login_id: authorization.loginId,
								code,
							}),
							signal: checked,
							credentials: "omit",
							cache: "no-store",
							redirect: "error",
						});
						let value: Record<string, unknown> = {};
						try {
							const read: unknown = JSON.parse(
								new TextDecoder().decode(await readBoundedCloudResponse(response, 64 * 1024, checked)),
							);
							if (read && typeof read === "object") value = read as Record<string, unknown>;
						} catch {
							// An unreadable answer is a failed code.
						}
						current();
						if (response.status === 403 && value.schema === "qorpera.claude-sign-in-code-failed/v1")
							throw new ClaudeCodeError();
						// `preparing`: Claude Code is still saving the login; the page sees it in the member's list.
						if (
							response.status !== 200 ||
							value.login_id !== authorization.loginId ||
							(value.status !== "completed" && value.status !== "preparing")
						)
							throw new Error("The Claude sign-in could not be finished.");
						return value.status === "completed" ? "completed" : "saving";
					};
					return {
						...prompt,
						clientConnectionId: request.clientConnectionId,
						expiresAt: authorization.expiresAt,
						...(prompt.status === "awaiting_member" ? { submitCode } : {}),
					};
				},
				120000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			)
				.then((result) => {
					companySignal.throwIfAborted();
					signal?.throwIfAborted();
					current();
					return result;
				})
				.catch((error: unknown) => {
					if (error instanceof CloudRpcError && error.denied) throw error;
					throw new Error(
						"Provider login could not be confirmed. Refresh connections before starting a new sign-in attempt.",
					);
				});
		},
		listConnections: async (signal) => {
			// The SDK reads the fields it knows; the plan fields come from the same answer.
			let answer: unknown;
			const listed = await new NativeSubscriptionControlPlane({
				rpc: async (method, args) => {
					const value = await rpc(method, args, signal);
					if (method === "qorpera_list_member_native_execution_connections") answer = value;
					return value;
				},
			}).listConnections(profileId);
			return { ...listed, connections: listed.connections.map((connection) => withPlanFields(connection, answer)) };
		},
		refreshAccountMetadata: async (signal, force = false, known) => {
			const checked = AbortSignal.any([companySignal, ...(signal ? [signal] : [])]);
			checked.throwIfAborted();
			current();
			if (!pendingMetadataRefresh) {
				const work = withCloudDeadline(
					async (deadline) => {
						const accounts = known ?? (await client(deadline).listConnections(profileId));
						const eligible = accounts.connections.filter(
							(account) =>
								account.provider === "openai" &&
								account.nativeHarness === "codex-cli" &&
								account.connectionStatus === "active" &&
								account.authorizationState === "active",
						);
						if (!accounts.computeIdentity || !eligible.length) return;
						// A completed attempt keeps its authority until it expires: at most one
						// attempt per expiry window, however often views ask, unless a reset
						// passed in the meantime or the member asked.
						const held = metadataAdmission?.completed === true && metadataAdmission.expiresAt > Date.now();
						if (!force) {
							const now = Date.now();
							if (!eligible.some((account) => usageStale(account, now, held))) return;
						}
						// An attempt that did not complete keeps its authority for a retry.
						const admission =
							!metadataAdmission || held || metadataAdmission.expiresAt <= Date.now()
								? admit()
								: metadataAdmission;
						const settle = (expiresAt: string) => {
							admission.expiresAt = Date.parse(expiresAt);
							admission.completed = true;
						};
						if (!loginBase) throw new Error("Account refresh is not configured");
						const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(admission.capability));
						const pause = (milliseconds: number) =>
							new Promise<void>((resolve, reject) => {
								deadline.throwIfAborted();
								const stop = () => {
									clearTimeout(timer);
									reject(new Error("Account refresh interrupted"));
								};
								const timer = setTimeout(() => {
									deadline.removeEventListener("abort", stop);
									resolve();
								}, milliseconds);
								deadline.addEventListener("abort", stop, { once: true });
							});
						const args = {
							p_profile_id: profileId,
							p_client_request_id: admission.clientRequestId,
							p_capability_sha256: Array.from(new Uint8Array(digest), (byte) =>
								byte.toString(16).padStart(2, "0"),
							).join(""),
						};
						let authority: NativeAccountRefreshDescription;
						// Another attempt of this member may be pending (another tab, or one an earlier page left
						// behind), and begin answers 55000 until it settles or expires: a server error in the browser's
						// console at each company open. So the read goes first: a pending attempt is watched with the
						// read, and begin is asked only when none is pending. If begin still answers busy (two pages
						// asked at once), it is asked again only after a pause: a steady retry is an error storm.
						let wait = 2000;
						let watched = false;
						let busy = false;
						for (;;) {
							const receipt = await rpc(
								"qorpera_get_native_account_refresh",
								{ p_profile_id: profileId },
								deadline,
							);
							let pending = false;
							if (receipt !== null) {
								const observed = parseNativeAccountRefreshDescription(receipt);
								if (
									observed.profileId !== profileId ||
									observed.requestedByUserId !== memberId ||
									observed.computeIdentityId !== accounts.computeIdentity.computeIdentityId
								)
									throw new Error("Account refresh authority changed");
								if (Date.parse(observed.expiresAt) > Date.now()) {
									// The attempt this page waited for has completed. One that had completed before
									// this page looked is admission's to judge: it knows whether it is still fresh.
									if (observed.status === "completed" && watched) {
										settle(observed.expiresAt);
										return;
									}
									// A pending attempt that is this page's own (an uncertain guest answer left it so) is
									// admission's to answer again: it answers the same request, never busy, and the page
									// asks the guest again. Only another's pending attempt is watched.
									pending = observed.status !== "completed" && observed.requestId !== admission.requestId;
								}
							}
							if (pending || busy) {
								watched = true;
								busy = false;
								await pause(wait);
								wait = Math.min(Math.round(wait * 1.5), 10_000);
								if (pending) continue;
							}
							try {
								authority = parseNativeAccountRefreshDescription(
									await rpc("qorpera_begin_native_account_refresh", args, deadline),
								);
								break;
							} catch (error) {
								if (!(error instanceof CloudRpcError) || error.code !== "55000") throw error;
								// Busy means an attempt is pending: the next read may already show it completed.
								watched = true;
								busy = true;
							}
						}
						if (
							authority.profileId !== profileId ||
							authority.computeIdentityId !== accounts.computeIdentity.computeIdentityId ||
							authority.requestedByUserId !== memberId ||
							Date.parse(authority.expiresAt) <= Date.now()
						)
							throw new Error("Account refresh authority changed");
						admission.expiresAt = Date.parse(authority.expiresAt);
						admission.requestId = authority.requestId;
						if (authority.status === "completed") {
							settle(authority.expiresAt);
							return;
						}
						const request: NativeAccountRefreshRequest = { ...authority, capability: admission.capability };
						const body = JSON.stringify(nativeAccountRefreshBody(request));
						// The host answers "preparing" while the refresh machine boots; ask less often as it takes longer.
						let poll = 1000;
						for (;;) {
							deadline.throwIfAborted();
							current();
							const { data, error } = await cloud.supabase.auth.getSession();
							deadline.throwIfAborted();
							current();
							if (error || data.session?.user.id !== memberId) throw new Error("Account refresh member changed");
							const response = await fetch(new URL("account-refresh", loginBase).href, {
								method: "POST",
								headers: {
									authorization: `Bearer ${admission.capability}`,
									"content-type": "application/json",
								},
								body,
								signal: deadline,
								redirect: "error",
								cache: "no-store",
								credentials: "omit",
							});
							try {
								if (!response.ok) throw new Error("Account refresh unavailable");
								const value: unknown = JSON.parse(
									new TextDecoder("utf-8", { fatal: true }).decode(
										await readBoundedCloudResponse(response, 64 * 1024, deadline),
									),
								);
								deadline.throwIfAborted();
								current();
								if (parseNativeAccountRefreshResult(value, authority.requestId) === "completed") {
									settle(authority.expiresAt);
									return;
								}
							} finally {
								if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
							}
							await pause(poll);
							poll = Math.min(Math.round(poll * 1.5), 4000);
						}
					},
					120_000,
					companySignal,
				).catch(() => {
					throw new Error("Account usage could not be refreshed. Try again shortly.");
				});
				pendingMetadataRefresh = work;
				void work
					.finally(() => {
						if (pendingMetadataRefresh === work) pendingMetadataRefresh = undefined;
					})
					.catch(() => undefined);
			}
			await withCloudDeadline(() => pendingMetadataRefresh!, 120_000, checked);
			checked.throwIfAborted();
			current();
		},
		selectSessionAccount: async (sessionId, signal) => {
			if (!UUID_PATTERN.test(sessionId)) throw new Error("Invalid conversation account request.");
			const value = await rpc(
				"qorpera_select_member_session_account",
				{
					p_profile_id: profileId,
					p_session_id: sessionId,
				},
				signal,
				sessionId,
			);
			if (value === null) return undefined;
			if (typeof value !== "string" || !UUID_PATTERN.test(value))
				throw new Error("Invalid conversation account response.");
			return value;
		},
		chooseSessionAccount: async (sessionId, connectionId, signal) => {
			if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(connectionId))
				throw new Error("Invalid conversation account request.");
			const value = await rpc(
				"qorpera_choose_member_session_account",
				{ p_profile_id: profileId, p_session_id: sessionId, p_connection_id: connectionId },
				signal,
				sessionId,
			);
			if (value !== connectionId) throw new Error("Invalid conversation account response.");
			return value;
		},
		countSessionsOnAccount: async (connectionId, signal) => {
			if (!UUID_PATTERN.test(connectionId)) throw new Error("Invalid conversation account request.");
			return sessionCount(
				await rpc(
					"qorpera_count_member_sessions_on_account",
					{ p_profile_id: profileId, p_connection_id: connectionId },
					signal,
				),
			);
		},
		chooseSessionsAccount: async (fromConnectionId, connectionId, signal) => {
			if (!UUID_PATTERN.test(fromConnectionId) || !UUID_PATTERN.test(connectionId))
				throw new Error("Invalid conversation account request.");
			return sessionCount(
				await rpc(
					"qorpera_choose_member_sessions_account",
					{ p_profile_id: profileId, p_from_connection_id: fromConnectionId, p_connection_id: connectionId },
					signal,
				),
			);
		},
		requestSessionTurn: (input, signal) => client(signal, input.sessionId).requestSessionTurn(input),
		// Unattended use is the default (founder decision 2026-09-20), not a setting: binding an account
		// records its owner's consent first and binds the consented version, so routines, coworker wakes
		// and first runs can use the account while nobody is online. A ChatGPT plan is the exception
		// (founder decision 2026-10-01): it is bound for the member's own messages only, and works while
		// they are away once they turn that on themselves.
		createMemberSponsor: async ({ planLogin: plan, ...input }, signal) => {
			signal?.throwIfAborted();
			if (plan) return client(signal).createMemberSponsor({ ...input, allowAutonomous: false, profileId });
			const version = await consent(input.providerConnectionId, true);
			return client(signal).createMemberSponsor({
				...input,
				providerConnectionVersion: version,
				allowAutonomous: true,
				profileId,
			});
		},
		setWorkWhileAway: async (connectionId, on, signal) => {
			signal?.throwIfAborted();
			const version = await consent(connectionId, on, true);
			// The new version is bound at once: turned on, for work while away; turned off, for the
			// member's own messages only (they never wait for a later read).
			await client(signal).createMemberSponsor({
				providerConnectionId: connectionId,
				providerConnectionVersion: version,
				allowAutonomous: on,
				profileId,
			});
		},
		chatGptPlanAvailable: async (signal) => {
			signal?.throwIfAborted();
			try {
				return (await cloud.rpc("qorpera_chatgpt_plan_available", { p_profile_id: profileId })) === true;
			} catch (error) {
				// A deployment without plan logins has no such function: they are off.
				if (error instanceof CloudRpcError && error.missing) return false;
				throw error;
			}
		},
		recordRoutineOffer: async (connectionId, signal) => {
			signal?.throwIfAborted();
			const value = (await cloud.rpc("qorpera_record_chatgpt_plan_routine_offer", {
				p_profile_id: profileId,
				p_connection_id: connectionId,
			})) as { connection_id?: unknown; shown_at?: unknown } | null;
			if (
				value?.connection_id !== connectionId ||
				typeof value.shown_at !== "string" ||
				!Number.isFinite(Date.parse(value.shown_at))
			)
				throw new Error("Invalid cloud response");
			return value.shown_at;
		},
		beginChatGptPlanSignIn: (displayName, signal) =>
			withCloudDeadline(
				async (deadline) => {
					const check = () => {
						deadline.throwIfAborted();
						current();
					};
					check();
					if (!loginBase) throw new Error("Native provider login is not configured.");
					const control = client(deadline);
					const existing = await control.listConnections(profileId);
					check();
					const identity =
						existing.computeIdentity ??
						(await control.createMemberComputeIdentity({
							profileId,
							clientIdentityId: crypto.randomUUID(),
							displayName,
							policy: { credentialExport: false, operatorBlindnessClaimed: false },
						}));
					check();
					if (
						identity.ownerUserId !== memberId ||
						identity.ownershipKind !== "member" ||
						identity.status !== "active"
					)
						throw new Error("Native provider login identity does not match this member.");
					const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
						.replaceAll("+", "-")
						.replaceAll("/", "_")
						.replace(/=+$/, "");
					const digest = new Uint8Array(
						await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)),
					);
					const clientLoginId = crypto.randomUUID();
					const clientConnectionId = crypto.randomUUID();
					let begun: Record<string, unknown> | null;
					try {
						begun = (await cloud.rpc("qorpera_begin_chatgpt_plan_sign_in", {
							p_profile_id: profileId,
							p_client_login_id: clientLoginId,
							p_client_connection_id: clientConnectionId,
							p_compute_identity_id: identity.computeIdentityId,
							p_capability_sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
						})) as Record<string, unknown> | null;
					} catch (error) {
						if (error instanceof CloudRpcError && error.code === "55000")
							throw new ChatGptPlanSignInError(
								/other ChatGPT plan/.test(error.message) ? "other_plan" : "unavailable",
							);
						throw error;
					}
					check();
					if (
						typeof begun?.login_id !== "string" ||
						!UUID_PATTERN.test(begun.login_id) ||
						begun.compute_identity_id !== identity.computeIdentityId ||
						begun.compute_identity_owner_user_id !== memberId ||
						begun.model_login_kind !== "chatgpt_plan" ||
						typeof begun.expires_at !== "string" ||
						!Number.isFinite(Date.parse(begun.expires_at))
					)
						throw new Error("ChatGPT plan sign-in authority does not match this request.");
					const authorization: NativeProviderLoginAuthorization = {
						loginId: begun.login_id,
						clientLoginId,
						clientConnectionId,
						computeIdentityId: identity.computeIdentityId,
						computeIdentityOwnershipKind: "member",
						computeIdentityOwnerUserId: memberId,
						provider: "openai",
						nativeHarness: "codex-cli",
						capability,
						expiresAt: begun.expires_at,
					};
					const endpoint = new URL("login", loginBase).href;
					// The vault answers OpenAI's address for the capability alone; no member token goes there.
					const prompt = await new HttpNativeProviderIdentityBridge(
						loginBase,
						async (url, init) => {
							check();
							if (String(url) !== endpoint || init?.method !== "POST")
								throw new Error("Unexpected native login destination.");
							return fetch(endpoint, { ...init, credentials: "omit", cache: "no-store", redirect: "error" });
						},
						{ signal: deadline },
					).beginLogin(authorization);
					check();
					const url = prompt.status === "awaiting_member" ? prompt.interactionUrl : undefined;
					if (!url || new URL(url).origin !== "https://auth.openai.com")
						throw new Error("ChatGPT sign-in did not answer with OpenAI's address.");
					return {
						url,
						signIn: {
							companyId: profileId,
							memberId,
							loginId: begun.login_id,
							clientConnectionId,
							capability,
							expiresAt: begun.expires_at,
							startedAt: Date.now(),
						},
					};
				},
				120000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			),
		finishChatGptPlanSignIn: async (outcome, signal) => {
			const signIn = outcome.signIn;
			if (outcome.outcome !== "confirm") throw new ChatGptPlanSignInError(outcome.reason ?? "provider_error");
			if (!loginBase || !outcome.confirmation || signIn.companyId !== profileId)
				throw new Error("This sign-in cannot be finished here.");
			const checked = AbortSignal.any([
				AbortSignal.timeout(CONFIRM_DEADLINE_MS),
				companySignal,
				...(signal ? [signal] : []),
			]);
			// The capability is the bearer; the confirmation id works once.
			const response = await fetch(new URL("chatgpt-plan-confirm", loginBase).href, {
				method: "POST",
				headers: { authorization: `Bearer ${signIn.capability}`, "content-type": "application/json" },
				body: JSON.stringify({
					schema: "qorpera.chatgpt-plan-confirm/v1",
					login_id: signIn.loginId,
					confirmation: outcome.confirmation,
				}),
				signal: checked,
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
			});
			let value: Record<string, unknown> = {};
			try {
				const read: unknown = JSON.parse(
					new TextDecoder().decode(await readBoundedCloudResponse(response, 64 * 1024, checked)),
				);
				if (read && typeof read === "object") value = read as Record<string, unknown>;
			} catch {
				// An unreadable answer is a failed confirm.
			}
			current();
			if (response.status === 200 && value.status === "completed" && value.login_id === signIn.loginId) return;
			throw new ChatGptPlanSignInError(
				value.schema === "qorpera.chatgpt-plan-confirm-failed/v1" && typeof value.reason === "string"
					? value.reason
					: "provider_error",
			);
		},
		revokeConnection: (input, signal) => client(signal).revokeConnection({ ...input, profileId }),
		listClaudeLogins: async (signal) =>
			parseClaudeLogins(await rpc("qorpera_list_claude_logins", { p_profile_id: profileId }, signal)),
		readClaude: async ({ loginId, force = false, reset }, signal) =>
			withCloudDeadline(
				async (deadline) => {
					current();
					if (!loginBase) throw new Error("Account refresh is not configured");
					if (!UUID_PATTERN.test(loginId)) throw new Error("Invalid Claude login.");
					const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
						.replaceAll("+", "-")
						.replaceAll("/", "_")
						.replace(/=+$/, "");
					const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
					const args = {
						p_profile_id: profileId,
						p_claude_login_id: loginId,
						p_client_request_id: crypto.randomUUID(),
						p_capability_sha256: Array.from(new Uint8Array(digest), (byte) =>
							byte.toString(16).padStart(2, "0"),
						).join(""),
						p_force: force,
						p_reset_kind: reset ?? null,
					};
					const pause = (milliseconds: number) =>
						new Promise<void>((resolve, reject) => {
							const stop = () => {
								clearTimeout(timer);
								reject(new Error("Claude read interrupted"));
							};
							const timer = setTimeout(() => {
								deadline.removeEventListener("abort", stop);
								resolve();
							}, milliseconds);
							deadline.addEventListener("abort", stop, { once: true });
						});
					let authority: NativeAccountRefreshDescription | undefined;
					for (let wait = 1500; !authority; wait = Math.min(Math.round(wait * 1.5), 8000)) {
						try {
							authority = parseNativeAccountRefreshDescription(
								await rpc("qorpera_begin_claude_login_read", args, deadline),
							);
						} catch (error) {
							const busy =
								error instanceof CloudRpcError &&
								error.code === "55000" &&
								(!reset || error.message === "Account refresh already in progress");
							if (!busy) throw reset ? new ClaudeReadNotStarted() : error;
							await pause(wait).catch(() => {
								throw reset ? new ClaudeReadNotStarted() : new Error("Claude read interrupted");
							});
						}
					}
					if (authority.profileId !== profileId || authority.requestedByUserId !== memberId)
						throw new Error("Account refresh authority changed");
					if (authority.status === "completed") return authority.requestId;
					const body = JSON.stringify(nativeAccountRefreshBody({ ...authority, capability }));
					for (let poll = 1000; ; poll = Math.min(Math.round(poll * 1.5), 4000)) {
						current();
						const response = await fetch(new URL("account-refresh", loginBase).href, {
							method: "POST",
							headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
							body,
							signal: deadline,
							redirect: "error",
							cache: "no-store",
							credentials: "omit",
						});
						try {
							if (response.ok) {
								const value: unknown = JSON.parse(
									new TextDecoder("utf-8", { fatal: true }).decode(
										await readBoundedCloudResponse(response, 64 * 1024, deadline),
									),
								);
								if (parseNativeAccountRefreshResult(value, authority.requestId) === "completed")
									return authority.requestId;
							}
						} finally {
							if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
						}
						await pause(poll);
					}
				},
				reset ? 120_000 : 60_000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			),
		useClaude: async (loginId, signal) => {
			if (!UUID_PATTERN.test(loginId)) throw new Error("Invalid Claude login.");
			const value = (await rpc("qorpera_use_claude_login", { p_login_id: loginId }, signal)) as {
				loginId?: unknown;
			} | null;
			if (value?.loginId !== loginId) throw new Error("Invalid cloud response");
		},
		signOutClaude: async (loginId, signal, nextLoginId) => {
			if (!UUID_PATTERN.test(loginId) || (nextLoginId !== undefined && !UUID_PATTERN.test(nextLoginId)))
				throw new Error("Invalid Claude login.");
			const value = (await rpc(
				"qorpera_sign_out_claude_login",
				{ p_login_id: loginId, ...(nextLoginId ? { p_next_login_id: nextLoginId } : {}) },
				signal,
			)) as {
				loginId?: unknown;
				status?: unknown;
			} | null;
			if (value?.loginId !== loginId || value.status !== "revoked") throw new Error("Invalid cloud response");
		},
		// Account logins are the member's own: read and ended through the member's own calls, like the connections.
		listAccountLogins: async (signal) =>
			parseAccountLogins(await rpc("qorpera_list_account_model_logins", { p_profile_id: profileId }, signal)),
		signOutEverywhere: async (loginId, signal) => {
			if (!UUID_PATTERN.test(loginId)) throw new Error("Invalid account login.");
			const value = (await rpc("qorpera_sign_out_account_model_login", { p_login_id: loginId }, signal)) as {
				loginId?: unknown;
				status?: unknown;
			} | null;
			if (value?.loginId !== loginId || value.status !== "revoked") throw new Error("Invalid cloud response");
		},
	};
}
