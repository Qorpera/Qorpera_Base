import { UUID_PATTERN } from "./parse.ts";

/** A "Continue with ChatGPT" sign-in this tab started (Sign in with ChatGPT), kept in session
 * storage while the member is at OpenAI. The capability never leaves this tab except to the
 * company's vault in the confirm request; OpenAI's callback never carries it. */
export interface ChatGptPlanSignIn {
	companyId: string;
	/** The server's sign-in id (the begin's `login_id`). */
	loginId: string;
	clientConnectionId: string;
	capability: string;
	expiresAt: string;
	startedAt: number;
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

export function keepChatGptPlanSignIn(signIn: ChatGptPlanSignIn): void {
	try {
		sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify(signIn));
	} catch {
		// Without storage the return cannot be finished here; the member signs in again.
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
			typeof value.loginId !== "string" ||
			!UUID_PATTERN.test(value.loginId) ||
			typeof value.clientConnectionId !== "string" ||
			!UUID_PATTERN.test(value.clientConnectionId) ||
			typeof value.capability !== "string" ||
			!TOKEN.test(value.capability) ||
			typeof value.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(value.expiresAt)) ||
			typeof value.startedAt !== "number" ||
			!Number.isFinite(value.startedAt)
		)
			return undefined;
		return value as unknown as ChatGptPlanSignIn;
	} catch {
		return undefined;
	}
}

/** Reads and strips the outcome the callback appended to the page hash
 * (`#?chatgpt_plan=confirm&confirmation=…` or `…=failed&reason=…`). It counts only for a sign-in
 * this tab started; a crafted link without one is stripped and does nothing. The page then goes
 * to the sign-in's company, where Settings finishes it. */
export function takeChatGptPlanReturn(): ChatGptPlanReturn | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const params = new URLSearchParams(hash.slice(at + 1));
	const outcome = params.get("chatgpt_plan");
	if (outcome !== "confirm" && outcome !== "failed") return undefined;
	const route = hash.slice(0, at);
	const signIn = readSignIn();
	if (!signIn || Date.now() - signIn.startedAt > SIGN_IN_TTL_MS) {
		forgetChatGptPlanSignIn();
		history.replaceState(null, "", route.length > 1 ? route : "#/");
		return undefined;
	}
	history.replaceState(null, "", route.startsWith("#/c/") ? route : `#/c/${signIn.companyId}`);
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
