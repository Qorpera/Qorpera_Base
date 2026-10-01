/**
 * Sign in with ChatGPT's callback (built switched off). OpenAI sends the member's browser here, the
 * one address registered with OpenAI, with `code` and `state` (or `error`). The state's prefix names the
 * company; the database names that company's vault (`qorpera_chatgpt_plan_callback_target`), and this
 * function forwards the state and code there, server to server. The vault parks the code under a one-time
 * confirmation id; nothing is exchanged here and no token ever passes through. The browser is sent back to
 * the web app with the confirmation id, or the failure, in the page fragment (never the query, so no
 * server log keeps it), where the page that started the sign-in confirms it with its own capability.
 */

const STATE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;
const SHORT = /^[\x21-\x7e]{1,256}$/;
const CONFIRMATION = /^[A-Za-z0-9_-]{43}$/;
const REASONS = new Set(["state_unknown", "expired", "declined", "provider_error", "busy"]);
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface ChatGptPlanCallbackOptions {
	/** The page the member returns to: an HTTPS page of an allowed web origin. */
	readonly returnUrl: string;
	/** The company's vault callback address for a state, or undefined (the database's answer). */
	readonly resolveTarget: (state: string) => Promise<string | undefined>;
	readonly fetchImplementation?: typeof fetch;
	readonly timeoutMs?: number;
}

/** The return page with the outcome after its fragment, as the connector callback does. */
export function chatGptPlanReturnLocation(
	returnUrl: string,
	outcome: { readonly confirmation: string } | { readonly reason: string },
): string {
	const url = new URL(returnUrl);
	const fragment = new URLSearchParams(
		"confirmation" in outcome
			? { chatgpt_plan: "confirm", confirmation: outcome.confirmation }
			: { chatgpt_plan: "failed", reason: outcome.reason },
	);
	url.hash = url.hash ? `${url.hash}?${fragment.toString()}` : `#?${fragment.toString()}`;
	return url.href;
}

/** Reads the deployment's return page: HTTPS, an allowed web origin, no query, no credentials, and no `?`
 * in its fragment (the web client reads the outcome from the fragment's first `?`). Unset or empty means
 * the first allowed origin's root. */
export function chatGptPlanReturnUrl(value: string | undefined, allowedOrigins: readonly string[]): string {
	const origins = allowedOrigins.length > 0 ? allowedOrigins : ["https://app.qorpera.com"];
	const url = new URL(value ? value : `${origins[0]}/`);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash.includes("?") ||
		!origins.includes(url.origin)
	)
		throw new Error("The ChatGPT plan return page is invalid");
	return url.href;
}

function back(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" },
	});
}

function optional(value: string | null, pattern: RegExp): string | null | undefined {
	if (value === null) return null;
	return pattern.test(value) ? value : undefined;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_RESPONSE_BYTES) throw new Error("The vault's answer is too large");
			chunks.push(next.value);
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function handleChatGptPlanCallback(request: Request, options: ChatGptPlanCallbackOptions): Promise<Response> {
	if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
	const failed = (reason: string) => back(chatGptPlanReturnLocation(options.returnUrl, { reason }));
	const query = new URL(request.url).searchParams;
	const state = query.get("state");
	if (state === null || !STATE.test(state)) return failed("state_unknown");
	const code = optional(query.get("code"), CODE);
	const error = optional(query.get("error"), SHORT);
	const clientId = optional(query.get("client_id"), SHORT);
	if (code === undefined || error === undefined || clientId === undefined || (code === null && error === null))
		return failed("provider_error");
	try {
		const timeoutMs = options.timeoutMs ?? 20_000;
		const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
		const target = await options.resolveTarget(state);
		if (!target) return failed("state_unknown");
		const url = new URL(target);
		// The database names the vault; it must also be the state's own company's callback route.
		const company = state.slice(0, state.indexOf("."));
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!url.pathname.endsWith(`/v1/model-logins/${company}/chatgpt-plan/callback`)
		)
			return failed("provider_error");
		const answer = await (options.fetchImplementation ?? fetch)(url.href, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ schema: "qorpera.chatgpt-plan-callback/v1", state, code, error, clientId }),
			redirect: "error",
			signal,
		});
		if (answer.status !== 200) {
			await answer.body?.cancel();
			return failed("provider_error");
		}
		const result = (await boundedJson(answer, signal)) as Record<string, unknown> | null;
		if (
			result?.schema === "qorpera.chatgpt-plan-callback-result/v1" &&
			result.status === "confirm" &&
			typeof result.confirmation === "string" &&
			CONFIRMATION.test(result.confirmation)
		)
			return back(chatGptPlanReturnLocation(options.returnUrl, { confirmation: result.confirmation }));
		return failed(
			result?.status === "failed" && typeof result.reason === "string" && REASONS.has(result.reason)
				? result.reason
				: "provider_error",
		);
	} catch {
		// The vault's detail stays private: the member sees a generic failure and starts again.
		return failed("provider_error");
	}
}
