import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import {
	MAX_RUNNER_BROKER_OBJECT_BYTES,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerObjectRequest,
	readRunnerBrokerObjectBody,
	readRunnerBrokerRequest,
	runnerBrokerMediaType,
	type RunnerBrokerRequest,
} from "./runner-broker.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function configuredServiceKey(): string | undefined {
	const legacyServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	try {
		const parsed: unknown = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const key = Object.values(parsed).find((value): value is string => typeof value === "string" && value.length > 20);
			if (key) return key;
		}
	} catch {
		// Fall through to the legacy project secret when configured.
	}
	return legacyServiceRoleKey || undefined;
}

async function sha256(value: string | Uint8Array): Promise<string> {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
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

function rpcName(action: RunnerBrokerRequest["action"]): string {
	switch (action) {
		case "describe":
			return "qorpera_runner_broker_describe";
		case "operations":
			return "qorpera_runner_broker_list_operations";
		case "artifacts":
			return "qorpera_runner_broker_list_artifacts";
		case "register_artifact":
			return "qorpera_runner_broker_register_artifact";
	}
}

function existingObjectError(error: { code?: unknown; status?: number; statusCode?: string }): boolean {
	return (
		error.status === 409 ||
		error.statusCode === "409" ||
		error.code === "ResourceAlreadyExists" ||
		error.code === "KeyAlreadyExists"
	);
}

Deno.serve(async (request) => {
	if (request.method !== "POST" && request.method !== "GET" && request.method !== "PUT") {
		return jsonResponse({ error: "Method not allowed" }, 405);
	}
	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const serviceKey = configuredServiceKey();
	if (!supabaseUrl || !serviceKey) return jsonResponse({ error: "Runner broker is not configured" }, 503);
	const client = createClient(supabaseUrl, serviceKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	if (request.method === "POST") {
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
		if (action.action === "operations") {
			args.p_after_sequence = action.afterSequence;
			args.p_limit = action.limit;
		} else if (action.action === "artifacts") {
			args.p_after_ordinal = action.afterOrdinal;
			args.p_limit = action.limit;
		} else if (action.action === "register_artifact") {
			args.p_client_artifact_id = action.clientArtifactId;
			args.p_artifact_type = action.artifactType;
			args.p_name = action.name;
			args.p_object_sha256 = action.objectSha256;
			args.p_bytes = action.bytes;
			args.p_media_type = action.mediaType;
		}
		const { data, error } = await client.rpc(rpcName(action.action), args);
		if (error) return jsonResponse({ error: "Runner broker request was rejected" }, rpcStatus(error));
		return jsonResponse({ value: data });
	}

	let objectRequest: ReturnType<typeof parseRunnerBrokerObjectRequest>;
	try {
		objectRequest = parseRunnerBrokerObjectRequest(request.headers);
	} catch {
		return jsonResponse({ error: "Invalid runner broker request" }, 400);
	}
	const baseArgs = {
		p_runner_id: objectRequest.runnerId,
		p_session_token_sha256: await sha256(objectRequest.sessionToken),
		p_job_id: objectRequest.jobId,
		p_lease_token_sha256: await sha256(objectRequest.leaseToken),
		p_object_sha256: objectRequest.objectSha256,
	};

	if (request.method === "GET") {
		const { data, error } = await client.rpc("qorpera_runner_broker_authorize_input_object", baseArgs);
		if (error) return jsonResponse({ error: "Runner broker request was rejected" }, rpcStatus(error));
		let authorization: Record<string, unknown>;
		try {
			authorization = record(data, "runner input authorization");
		} catch {
			return jsonResponse({ error: "Runner broker returned invalid authority" }, 503);
		}
		const expectedBytes = authorization.bytes;
		const profileId = authorization.profile_id;
		if (!Number.isSafeInteger(expectedBytes) || (expectedBytes as number) < 0 || typeof profileId !== "string") {
			return jsonResponse({ error: "Runner broker returned invalid authority" }, 503);
		}
		const { data: blob, error: storageError } = await client.storage
			.from(OBJECT_BUCKET)
			.download(`${profileId}/${objectRequest.objectSha256}`);
		if (storageError) return jsonResponse({ error: "Runner input object is unavailable" }, 503);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (bytes.byteLength !== expectedBytes || (await sha256(bytes)) !== objectRequest.objectSha256) {
			return jsonResponse({ error: "Runner input object failed integrity verification" }, 503);
		}
		return new Response(bytes, {
			status: 200,
			headers: {
				"cache-control": "no-store",
				"content-length": String(bytes.byteLength),
				"content-type": "application/octet-stream",
				"x-qorpera-object-sha256": objectRequest.objectSha256,
			},
		});
	}

	const contentLength = Number(request.headers.get("content-length") ?? "-1");
	let mediaType: string;
	try {
		if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_RUNNER_BROKER_OBJECT_BYTES) {
			throw new Error("Invalid runner output object size");
		}
		mediaType = runnerBrokerMediaType(request.headers.get("content-type"));
	} catch {
		return jsonResponse({ error: "Invalid runner output object" }, 400);
	}
	const { data: authorizationData, error: authorizationError } = await client.rpc(
		"qorpera_runner_broker_authorize_output_object",
		{ ...baseArgs, p_bytes: contentLength, p_media_type: mediaType },
	);
	if (authorizationError) {
		return jsonResponse({ error: "Runner broker request was rejected" }, rpcStatus(authorizationError));
	}
	let authorization: Record<string, unknown>;
	try {
		authorization = record(authorizationData, "runner output authorization");
	} catch {
		return jsonResponse({ error: "Runner broker returned invalid authority" }, 503);
	}
	const profileId = authorization.profile_id;
	if (typeof profileId !== "string") return jsonResponse({ error: "Runner broker returned invalid authority" }, 503);
	let bytes: Uint8Array;
	try {
		bytes = await readRunnerBrokerObjectBody(request, contentLength);
	} catch {
		return jsonResponse({ error: "Invalid runner output object" }, 400);
	}
	if (bytes.byteLength !== contentLength || (await sha256(bytes)) !== objectRequest.objectSha256) {
		return jsonResponse({ error: "Runner output object failed integrity verification" }, 400);
	}
	const path = `${profileId}/${objectRequest.objectSha256}`;
	let stored: "exists" | "stored" = "stored";
	if (authorization.uploaded !== true) {
		const { error: uploadError } = await client.storage.from(OBJECT_BUCKET).upload(path, bytes.buffer, {
			cacheControl: "31536000",
			contentType: mediaType,
			upsert: false,
		});
		if (uploadError && !existingObjectError(uploadError)) {
			return jsonResponse({ error: "Runner output object upload failed" }, 503);
		}
		if (uploadError) stored = "exists";
	}
	if (stored === "exists" || authorization.uploaded === true) {
		const { data: blob, error: downloadError } = await client.storage.from(OBJECT_BUCKET).download(path);
		if (downloadError) return jsonResponse({ error: "Runner output object is unavailable" }, 503);
		const existing = new Uint8Array(await blob.arrayBuffer());
		if (existing.byteLength !== bytes.byteLength || (await sha256(existing)) !== objectRequest.objectSha256) {
			return jsonResponse({ error: "Existing runner output object failed integrity verification" }, 503);
		}
	}
	const { error: confirmationError } = await client.rpc("qorpera_runner_broker_confirm_output_object", baseArgs);
	if (confirmationError) {
		return jsonResponse({ error: "Runner output object confirmation failed" }, rpcStatus(confirmationError));
	}
	return jsonResponse({ value: { status: stored, sha256: objectRequest.objectSha256, bytes: bytes.byteLength } });
});
