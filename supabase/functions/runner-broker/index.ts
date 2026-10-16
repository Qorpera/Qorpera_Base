import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { parseRunnerBrokerAuthorization, readRunnerBrokerRequest, type RunnerBrokerRequest } from "./runner-broker.ts";

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
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function rpcStatus(error: { code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "22023") return 400;
	if (error.code === "23505" || error.code === "40001" || error.code === "55000") return 409;
	return 503;
}

Deno.serve(async (request) => {
	if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = configuredServiceKey();
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner broker is not configured" }, 503);
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	let action: RunnerBrokerRequest;
	let sessionToken: string;
	let leaseToken: string;
	try {
		action = await readRunnerBrokerRequest(request);
		({ sessionToken, leaseToken } = parseRunnerBrokerAuthorization(request.headers));
	} catch {
		return jsonResponse({ error: "Invalid runner broker request" }, 400);
	}
	const args: Record<string, unknown> = {
		p_runner_id: action.runnerId,
		p_session_token_sha256: await sha256(sessionToken),
		p_job_id: action.jobId,
		p_lease_token_sha256: await sha256(leaseToken),
	};
	if (action.action === "native_authority") {
		const { data, error } = await client.rpc("qorpera_acquire_native_provider_connection_lease", {
			p_run_id: action.runId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: args.p_session_token_sha256,
			p_assignment_id: action.assignmentId,
			p_lease_token_sha256: args.p_lease_token_sha256,
			p_lease_seconds: action.leaseSeconds,
		});
		if (error) return jsonResponse({ error: "Native provider authority was rejected" }, rpcStatus(error));
		const { data: modelData, error: modelError } = await client.rpc("qorpera_native_run_model_authority", {
			p_run_id: action.runId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: args.p_session_token_sha256,
			p_job_id: action.jobId,
			p_lease_token_sha256: args.p_lease_token_sha256,
		});
		if (modelError) {
			return jsonResponse({ error: "Native provider model authority was rejected" }, rpcStatus(modelError));
		}
		return jsonResponse({ value: { ...record(data, "native provider authority"), model: modelData } });
	}
	if (action.action === "renew_native_authority") {
		const { data, error } = await client.rpc("qorpera_renew_native_provider_connection_lease", {
			p_lease_id: action.leaseId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: args.p_session_token_sha256,
			p_job_id: action.jobId,
			p_lease_token_sha256: args.p_lease_token_sha256,
			p_lease_seconds: action.leaseSeconds,
		});
		if (error) return jsonResponse({ error: "Native provider authority renewal was rejected" }, rpcStatus(error));
		return jsonResponse({ value: data });
	}
	if (action.action === "release_native_authority") {
		const { data, error } = await client.rpc("qorpera_release_native_provider_connection_lease", {
			p_lease_id: action.leaseId,
			p_runner_id: action.runnerId,
			p_session_token_sha256: args.p_session_token_sha256,
			p_job_id: action.jobId,
			p_lease_token_sha256: args.p_lease_token_sha256,
			p_status: action.status,
		});
		if (error) return jsonResponse({ error: "Native provider authority release was rejected" }, rpcStatus(error));
		return jsonResponse({ value: data });
	}
	const { data, error } = await client.rpc("qorpera_runner_broker_describe", args);
	if (error) return jsonResponse({ error: "Runner broker request was rejected" }, rpcStatus(error));
	return jsonResponse({ value: data });
});
