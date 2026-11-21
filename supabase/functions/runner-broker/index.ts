import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	acquireNativeAuthorityWithRollback,
	parseRunnerBrokerAuthorization,
	readRunnerBrokerRequest,
	runnerBrokerRpcStatus,
	type RunnerBrokerRequest,
} from "./runner-broker.ts";

const RPC_TIMEOUT_MS = 25_000;
const UTF8_ENCODER = new TextEncoder();
let cachedClient: { readonly key: string; readonly client: SupabaseClient } | undefined;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const parent = init?.signal;
	const onAbort = (): void => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
		RPC_TIMEOUT_MS,
	);
	return fetch(input, { ...init, signal: controller.signal }).finally(() => {
		clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	});
}

function getClient(supabaseUrl: string, serviceKey: string): SupabaseClient {
	const key = `${supabaseUrl}\0${serviceKey}`;
	if (cachedClient?.key === key) return cachedClient.client;
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
		global: { fetch: timedFetch },
	});
	cachedClient = { key, client };
	return client;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredServiceKey(): string | undefined {
	/* Prefer the legacy service-role JWT: it is verified locally at the
	 * gateway, while new-format secret keys resolve through the platform's
	 * key-management service — a dependency that has shed requests for
	 * minutes at a time during platform incidents and turned every broker
	 * action into a 503. Both keys address the same hosted project. */
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (legacyServiceRoleKey) return legacyServiceRoleKey;
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20);
			if (key) return key;
		}
	} catch {
		// No configured service credential.
	}
	return undefined;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = configuredServiceKey();
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner broker is not configured" }, 503);
	const client = getClient(supabaseUrl, serviceKey);

	let action: RunnerBrokerRequest;
	let sessionToken: string;
	let leaseToken: string;
	try {
		action = await readRunnerBrokerRequest(request);
		({ sessionToken, leaseToken } = parseRunnerBrokerAuthorization(request.headers));
	} catch {
		return jsonResponse({ error: "Invalid runner broker request" }, 400);
	}
	const sessionTokenSha256 = await sha256(sessionToken);
	const leaseTokenSha256 = await sha256(leaseToken);
	const args: Record<string, unknown> = {
		p_runner_id: action.runnerId,
		p_session_token_sha256: sessionTokenSha256,
		p_job_id: action.jobId,
		p_lease_token_sha256: leaseTokenSha256,
	};
	if (action.action === "native_authority") {
		const outcome = await acquireNativeAuthorityWithRollback(
			(fn, rpcArgs) => client.rpc(fn, rpcArgs),
			action,
			{ sessionTokenSha256, leaseTokenSha256 },
		);
		if (!outcome.ok) return jsonResponse({ error: outcome.error }, outcome.status);
		return jsonResponse({ value: outcome.value });
	}
	if (action.action === "renew_native_authority") {
		const { data, error } = await client.rpc("qorpera_renew_native_provider_connection_lease", {
			p_lease_id: action.leaseId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: sessionTokenSha256,
			p_job_id: action.jobId,
			p_lease_token_sha256: leaseTokenSha256,
			p_lease_seconds: action.leaseSeconds,
		});
		if (error) {
			return jsonResponse({ error: "Native provider authority renewal was rejected" }, runnerBrokerRpcStatus(error));
		}
		return jsonResponse({ value: data });
	}
	if (action.action === "release_native_authority") {
		const { data, error } = await client.rpc("qorpera_release_native_provider_connection_lease", {
			p_lease_id: action.leaseId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: sessionTokenSha256,
			p_job_id: action.jobId,
			p_lease_token_sha256: leaseTokenSha256,
			p_status: action.status,
		});
		if (error) {
			return jsonResponse({ error: "Native provider authority release was rejected" }, runnerBrokerRpcStatus(error));
		}
		return jsonResponse({ value: data });
	}
	const { data, error } = await client.rpc("qorpera_runner_broker_describe", args);
	if (error) return jsonResponse({ error: "Runner broker request was rejected" }, runnerBrokerRpcStatus(error));
	return jsonResponse({ value: data });
});
