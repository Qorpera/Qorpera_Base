import { DEFAULT_RPC_TIMEOUT_MS, preferredServiceKey, withAbortSignal } from "../_shared/http-guards.ts";
import { createPostgrestClient, type PostgrestClient } from "../_shared/postgrest-rpc.ts";
import {
	acquireNativeAuthorityWithRollback,
	parseRunnerBrokerAuthorization,
	readRunnerBrokerRequest,
	runnerBrokerRpcStatus,
	type RunnerBrokerRequest,
} from "./runner-broker.ts";

const UTF8_ENCODER = new TextEncoder();
let cachedClient: { readonly key: string; readonly client: PostgrestClient } | undefined;

function getClient(supabaseUrl: string, serviceKey: string): PostgrestClient {
	const key = `${supabaseUrl}\0${serviceKey}`;
	if (cachedClient?.key === key) return cachedClient.client;
	const client = createPostgrestClient(supabaseUrl, serviceKey, { timeoutMs: DEFAULT_RPC_TIMEOUT_MS });
	cachedClient = { key, client };
	return client;
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = preferredServiceKey((name) => Deno.env.get(name));
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner broker is not configured" }, 503);
	const client = getClient(supabaseUrl, serviceKey);

	let action: RunnerBrokerRequest;
	let sessionToken: string;
	let leaseToken: string;
	try {
		// WHY: Reject missing or malformed credential headers before reading and parsing up to 512 KiB of request body.
		({ sessionToken, leaseToken } = parseRunnerBrokerAuthorization(request.headers));
		action = await readRunnerBrokerRequest(request);
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
	try {
		if (action.action === "native_authority") {
			const outcome = await acquireNativeAuthorityWithRollback(
				async (fn, rpcArgs) => await withAbortSignal(client.rpc(fn, rpcArgs), request.signal),
				action,
				{ sessionTokenSha256, leaseTokenSha256 },
				async (fn, rpcArgs) => await client.rpc(fn, rpcArgs),
			);
			if (!outcome.ok) return jsonResponse({ error: outcome.error }, outcome.status);
			return jsonResponse({ value: outcome.value });
		}
		if (action.action === "renew_native_authority") {
			const { data, error } = await withAbortSignal(
				client.rpc("qorpera_renew_native_provider_connection_lease", {
					p_lease_id: action.leaseId,
					p_runner_id: action.runnerId,
					p_session_token_sha256: sessionTokenSha256,
					p_job_id: action.jobId,
					p_lease_token_sha256: leaseTokenSha256,
					p_lease_seconds: action.leaseSeconds,
				}),
				request.signal,
			);
			if (error) {
				return jsonResponse({ error: "Native provider authority renewal was rejected" }, runnerBrokerRpcStatus(error));
			}
			return jsonResponse({ value: data });
		}
		if (action.action === "release_native_authority") {
			const { data, error } = await withAbortSignal(
				client.rpc("qorpera_release_native_provider_connection_lease", {
					p_lease_id: action.leaseId,
					p_runner_id: action.runnerId,
					p_session_token_sha256: sessionTokenSha256,
					p_job_id: action.jobId,
					p_lease_token_sha256: leaseTokenSha256,
					p_status: action.status,
				}),
				request.signal,
			);
			if (error) {
				return jsonResponse({ error: "Native provider authority release was rejected" }, runnerBrokerRpcStatus(error));
			}
			return jsonResponse({ value: data });
		}
		const { data, error } = await withAbortSignal(client.rpc("qorpera_runner_broker_describe", args), request.signal);
		if (error) return jsonResponse({ error: "Runner broker request was rejected" }, runnerBrokerRpcStatus(error));
		return jsonResponse({ value: data });
	} catch {
		return jsonResponse({ error: "Runner broker is unavailable" }, 503);
	}
});
