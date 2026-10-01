import { UUID_PATTERN } from "./parse.ts";

/** A "Continue with ChatGPT" sign-in this tab started (Sign in with ChatGPT), kept in session
 * storage while the member is at OpenAI. The capability never leaves this tab except to the
 * company's vault in the confirm request; OpenAI's callback never carries it. */
export interface ChatGptPlanSignIn {
	companyId: string;
	/** The member who started it; another account signed in on this tab never finishes it. */
	memberId: string;
	/** The server's sign-in id (the begin's `login_id`). */
	loginId: string;
	clientConnectionId: string;
	capability: string;
	expiresAt: string;
	startedAt: number;
	/** The company page the sign-in began on, where the return goes back to. */
	returnRoute: string;
}

/** What the callback appended to the return page's hash: a one-time confirmation id, or why
 * the sign-in failed (chatgpt-plan-callback: state_unknown, expired, declined, provider_error,
 * busy). */
export interface ChatGptPlanReturn {
	outcome: "confirm" | "failed";
	confirmation?: string;
	reason?: string;
	signIn: ChatGptPlanSignIn;
}

const SIGN_IN_KEY = "qorpera.chatgpt-plan-sign-in.v1";
const SIGN_IN_TTL_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A route of this company's pages, or its home: the return never goes to another company or
 * carries a query of its own. */
function companyRoute(route: string, companyId: string): string {
	return route.startsWith(`#/c/${companyId}`) && /^#\/c\/[0-9a-f-]{36}(?:\/[A-Za-z0-9._~-]+)*$/i.test(route)
		? route
		: `#/c/${companyId}`;
}

/** Keeps the sign-in with the page it began on (`route`). False when this tab cannot keep it:
 * then the return could not be finished, so the member is not sent to OpenAI. */
export function keepChatGptPlanSignIn(signIn: Omit<ChatGptPlanSignIn, "returnRoute">, route: string): boolean {
	try {
		const kept: ChatGptPlanSignIn = { ...signIn, returnRoute: companyRoute(route, signIn.companyId) };
		sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(kept));
		return sessionStorage.getItem(SIGN_IN_KEY) !== null;
	} catch {
		return false;
	}
}

export function forgetChatGptPlanSignIn(): void {
	try {
		sessionStorage.removeItem(SIGN_IN_KEY);
	} catch {
		// Nothing was kept.
	}
}

function readSignIn(): ChatGptPlanSignIn | undefined {
	try {
		const text = sessionStorage.getItem(SIGN_IN_KEY);
		if (!text) return undefined;
		const value = JSON.parse(text) as Record<string, unknown>;
		if (
			typeof value.companyId !== "string" ||
			!UUID_PATTERN.test(value.companyId) ||
			typeof value.memberId !== "string" ||
			!UUID_PATTERN.test(value.memberId) ||
			typeof value.loginId !== "string" ||
			!UUID_PATTERN.test(value.loginId) ||
			typeof value.clientConnectionId !== "string" ||
			!UUID_PATTERN.test(value.clientConnectionId) ||
			typeof value.capability !== "string" ||
			!TOKEN.test(value.capability) ||
			typeof value.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(value.expiresAt)) ||
			typeof value.startedAt !== "number" ||
			!Number.isFinite(value.startedAt) ||
			typeof value.returnRoute !== "string" ||
			companyRoute(value.returnRoute, value.companyId) !== value.returnRoute
		)
			return undefined;
		return value as unknown as ChatGptPlanSignIn;
	} catch {
		return undefined;
	}
}

/** Reads and strips the outcome the callback appended to the page hash
 * (`#?chatgpt_plan=confirm&confirmation=…` or `…=failed&reason=…`). It counts only for a sign-in
 * this tab started; a crafted link without one is stripped and does nothing. The page goes back
 * to where the sign-in began, and the application finishes it there. A return after 15 minutes
 * reads as too slow. Without an outcome, a sign-in kept too long is dropped. */
export function takeChatGptPlanReturn(): ChatGptPlanReturn | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	const params = new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
	const outcome = params.get("chatgpt_plan");
	const signIn = readSignIn();
	const late = signIn !== undefined && Date.now() - signIn.startedAt > SIGN_IN_TTL_MS;
	if (outcome !== "confirm" && outcome !== "failed") {
		if (late) forgetChatGptPlanSignIn();
		return undefined;
	}
	const route = hash.slice(0, at);
	if (!signIn) {
		forgetChatGptPlanSignIn();
		history.replaceState(null, "", route.length > 1 ? route : "#/");
		return undefined;
	}
	history.replaceState(null, "", route.startsWith(`#/c/${signIn.companyId}`) ? route : signIn.returnRoute);
	if (late) {
		forgetChatGptPlanSignIn();
		return { outcome: "failed", reason: "expired", signIn };
	}
	const confirmation = params.get("confirmation") ?? "";
	if (outcome === "confirm" && !TOKEN.test(confirmation)) {
		forgetChatGptPlanSignIn();
		return undefined;
	}
	if (outcome === "failed") forgetChatGptPlanSignIn();
	const reason = params.get("reason") ?? undefined;
	return {
		outcome,
		...(outcome === "confirm" ? { confirmation } : {}),
		...(reason && /^[a-z_]{1,32}$/.test(reason) ? { reason } : {}),
		signIn,
	};
}
