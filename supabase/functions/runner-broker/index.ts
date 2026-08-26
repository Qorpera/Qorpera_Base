import { createClient } from "npm:@supabase/supabase-js@2.112.3";
import { createRunnerBrokerObjectLoader } from "./object-loader.ts";
import {
	executeRunnerModelGateway,
	MAX_RUNNER_BROKER_OBJECT_BYTES,
	parseRunnerBrokerAuthorization,
	parseRunnerBrokerObjectRequest,
	parseRunnerModelGatewayAuthority,
	readRunnerBrokerObjectBody,
	readRunnerBrokerRequest,
	runnerBrokerMediaType,
	type RunnerBrokerRequest,
} from "./runner-broker.ts";

const OBJECT_BUCKET = "qorpera-profile-objects";
const MODEL_GATEWAY_INPUT_TOKEN_OVERHEAD = 16_384;

function internalServiceHeaders(serviceKey: string): Record<string, string> {
	/* The verifier authenticates internal calls by comparing the bearer token
	 * against its own service key, so the Authorization header must be sent
	 * for every key format. Sending it only for legacy JWTs left new-format
	 * keys with a bare apikey and turned every internal verification into a
	 * 401 before the verifier did any work. */
	return { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
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

function configuredObjectStoragePrimary(): "nas" | "supabase" {
	const value = Deno.env.get("QORPERA_OBJECT_STORAGE_PRIMARY")?.trim();
	if (value === "nas" || value === "supabase") return value;
	throw new Error("Runner broker object storage primary is not configured");
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
		case "inputs":
			return "qorpera_runner_broker_list_inputs";
		case "transcript":
			return "qorpera_runner_broker_list_transcript";
		case "operations":
			return "qorpera_runner_broker_list_operations";
		case "artifacts":
			return "qorpera_runner_broker_list_artifacts";
		case "native_authority":
		case "renew_native_authority":
		case "release_native_authority":
			throw new Error("Native authority uses the credential capsule boundary");
		case "register_artifact":
			return "qorpera_runner_broker_register_artifact";
		case "begin_operation":
			return "qorpera_begin_run_operation_receipt";
		case "complete_operation":
			return "qorpera_complete_run_operation_receipt";
		case "bind_provider_session":
			return "qorpera_bind_execution_provider_session";
		case "prepare_company_revision":
			return "qorpera_runner_prepare_company_revision";
		case "begin_company_revision_graph":
			return "qorpera_runner_begin_company_revision_graph";
		case "append_company_revision_graph":
			return "qorpera_runner_append_company_revision_graph";
		case "complete_company_revision_graph":
			return "qorpera_runner_complete_company_revision_graph";
		case "verify_company_revision":
			throw new Error("Runner Company File verification uses the trusted verifier boundary");
		case "append_transcript":
			return "qorpera_append_runner_transcript_event";
		case "model":
			throw new Error("Runner model requests use the model gateway boundary");
	}
}

function modelGatewayConfiguration(): { url: string; token: string } | undefined {
	const rawUrl = Deno.env.get("QORPERA_RUNNER_MODEL_GATEWAY_URL");
	const token = Deno.env.get("QORPERA_RUNNER_MODEL_GATEWAY_TOKEN");
	if (!rawUrl || !token || token.length < 32 || /[\0\r\n]/.test(token)) return undefined;
	try {
		const url = new URL(rawUrl);
		if (
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) ||
			url.username ||
			url.password ||
			url.hash
		) {
			return undefined;
		}
		return { url: url.href, token };
	} catch {
		return undefined;
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
		if (action.action === "model") {
			const { data: descriptionData, error: descriptionError } = await client.rpc(
				"qorpera_runner_broker_describe",
				args,
			);
			if (descriptionError) {
				return jsonResponse({ error: "Runner model authority was rejected" }, rpcStatus(descriptionError));
			}
			try {
				const description = record(descriptionData, "runner description");
				const sponsor = record(description.sponsor, "runner sponsor");
				if (sponsor.authentication_mode === "native_subscription") {
					return jsonResponse({ error: "Native subscriptions require the provider-native harness" }, 409);
				}
			} catch {
				return jsonResponse({ error: "Runner model authority is invalid" }, 503);
			}
			const gateway = modelGatewayConfiguration();
			if (!gateway) return jsonResponse({ error: "Runner model gateway is not configured" }, 503);
			const requestProjection = {
				request_id: action.requestId,
				provider: action.provider,
				model: action.model,
				input: action.input,
				max_output_tokens: action.maxOutputTokens,
			};
			const encodedProjection = JSON.stringify(requestProjection);
			const inputBytes = new TextEncoder().encode(JSON.stringify(action.input)).byteLength;
			const inputTokenReservation = inputBytes + MODEL_GATEWAY_INPUT_TOKEN_OVERHEAD;
			const requestSha256 = await sha256(encodedProjection);
			const { data: reservationData, error: reservationError } = await client.rpc(
				"qorpera_runner_broker_reserve_model_request",
				{
					...args,
					p_request_id: action.requestId,
					p_provider: action.provider,
					p_model: action.model,
					p_request_sha256: requestSha256,
					p_input_token_reservation: inputTokenReservation,
					p_output_token_reservation: action.maxOutputTokens,
				},
			);
			if (reservationError) {
				return jsonResponse({ error: "Runner model request was rejected" }, rpcStatus(reservationError));
			}
			let reservation: Record<string, unknown>;
			try {
				reservation = record(reservationData, "runner model reservation");
			} catch {
				return jsonResponse({ error: "Runner model broker returned invalid authority" }, 503);
			}
			if (reservation.state === "completed") {
				return jsonResponse({ value: reservation.response });
			}
			if (reservation.state !== "reserved") {
				return jsonResponse({ error: "Runner model request is unavailable" }, 409);
			}
			let authority: ReturnType<typeof parseRunnerModelGatewayAuthority>;
			try {
				authority = parseRunnerModelGatewayAuthority(reservation.authority);
				if (
					authority.jobId !== action.jobId ||
					authority.provider !== action.provider
				) {
					throw new Error("Runner model authority does not match the request");
				}
			} catch {
				return jsonResponse({ error: "Runner model broker returned invalid authority" }, 503);
			}

			try {
				const result = await executeRunnerModelGateway({
					url: gateway.url,
					token: gateway.token,
					request: { ...action, authority },
					finalize: async (finalization) => {
						const { data, error } = await client.rpc("qorpera_runner_broker_finalize_model_request", {
							...args,
							p_request_id: action.requestId,
							p_request_sha256: requestSha256,
							p_outcome: finalization.outcome,
							p_input_tokens: finalization.usage.inputTokens,
							p_output_tokens: finalization.usage.outputTokens,
							p_cost_microusd: finalization.usage.costMicrousd,
							p_response: finalization.response,
							p_error_code: finalization.errorCode,
						});
						if (error) throw error;
						return data;
					},
				});
				return result.status === "completed"
					? jsonResponse({ value: result.value })
					: jsonResponse({ error: "Runner model gateway request failed" }, 503);
			} catch (error) {
				const rpcError = error && typeof error === "object" && "code" in error ? error : {};
				return jsonResponse({ error: "Runner model result was rejected" }, rpcStatus(rpcError));
			}
		}
		if (action.action === "verify_company_revision") {
			const verifierArgs = {
				...args,
				p_assignment_id: action.assignmentId,
				p_snapshot_id: action.snapshotId,
				p_graph_id: action.graphId,
			};
			const { data: authorizationData, error: authorizationError } = await client.rpc(
				"qorpera_runner_authorize_company_revision_verification",
				verifierArgs,
			);
			if (authorizationError) {
				return jsonResponse({ error: "Runner Company File verification was rejected" }, rpcStatus(authorizationError));
			}
			let verifiedUserId: string;
			try {
				const authorization = record(authorizationData, "runner Company File verification authority");
				if (
					authorization.snapshot_id !== action.snapshotId ||
					authorization.graph_id !== action.graphId ||
					typeof authorization.verified_user_id !== "string"
				) {
					throw new Error("Invalid runner Company File verification authority");
				}
				verifiedUserId = authorization.verified_user_id;
			} catch {
				return jsonResponse({ error: "Runner Company File verification authority is invalid" }, 503);
			}
			let verification: Response;
			try {
				verification = await fetch(`${supabaseUrl}/functions/v1/company-file-verifier`, {
					method: "POST",
					headers: {
						accept: "application/json",
						...internalServiceHeaders(serviceKey),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						snapshotId: action.snapshotId,
						graphId: action.graphId,
						verifiedUserId,
					}),
				});
			} catch {
				return jsonResponse({ error: "Trusted Company File verifier is unavailable" }, 503);
			}
			if (verification.status === 202) {
				return jsonResponse({ value: { verified: false, pending: true } });
			}
			if (!verification.ok) {
				return jsonResponse({ error: "Trusted Company File verification failed" }, 503);
			}
			const { error: finalizationError } = await client.rpc(
				"qorpera_runner_finalize_company_revision_verification",
				verifierArgs,
			);
			if (finalizationError) {
				return jsonResponse({ error: "Runner Company File verification finalization failed" }, rpcStatus(finalizationError));
			}
			return jsonResponse({ value: { verified: true, pending: false } });
		}
		if (action.action === "transcript") {
			args.p_after_sequence = action.afterSequence;
			args.p_limit = action.limit;
		} else if (action.action === "operations") {
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
		} else if (action.action === "begin_operation") {
			args.p_assignment_id = action.assignmentId;
			args.p_receipt_id = action.receiptId;
			args.p_logical_operation_key = action.logicalOperationKey;
			args.p_operation_kind = action.operationKind;
			args.p_input_sha256 = action.inputSha256;
			args.p_downstream_idempotency_sha256 = await sha256(action.downstreamIdempotencyKey);
			args.p_requires_company_revision = action.requiresCompanyRevision;
		} else if (action.action === "complete_operation") {
			args.p_assignment_id = action.assignmentId;
			args.p_receipt_id = action.receiptId;
			args.p_input_sha256 = action.inputSha256;
			args.p_result = action.result;
			args.p_output_snapshot_id = action.outputSnapshotId ?? null;
			args.p_proposal_id = action.proposalId ?? null;
		} else if (action.action === "bind_provider_session") {
			args.p_provider_session_id = action.providerSessionId;
			args.p_context_checkpoint_object_sha256 = action.contextCheckpointObjectSha256 ?? null;
		} else if (action.action === "prepare_company_revision") {
			args.p_assignment_id = action.assignmentId;
			args.p_client_revision_id = action.clientRevisionId;
			args.p_tree_manifest_sha256 = action.treeManifestSha256;
			args.p_tree_manifest_bytes = action.treeManifestBytes;
			args.p_tree_contract_version = action.treeContractVersion;
			args.p_file_count = action.fileCount;
			args.p_total_bytes = action.totalBytes;
		} else if (action.action === "begin_company_revision_graph") {
			args.p_assignment_id = action.assignmentId;
			args.p_snapshot_id = action.snapshotId;
			args.p_client_graph_id = action.clientGraphId;
			args.p_root_object_sha256 = action.rootObjectSha256;
			args.p_content_sha256 = action.contentSha256;
			args.p_object_count = action.objectCount;
			args.p_storage_bytes = action.storageBytes;
		} else if (action.action === "append_company_revision_graph") {
			args.p_assignment_id = action.assignmentId;
			args.p_graph_id = action.graphId;
			args.p_entries = action.entries;
		} else if (action.action === "complete_company_revision_graph") {
			args.p_assignment_id = action.assignmentId;
			args.p_graph_id = action.graphId;
		} else if (action.action === "append_transcript") {
			args.p_assignment_id = action.assignmentId;
			args.p_event_id = action.eventId;
			args.p_event_type = action.eventType;
			args.p_body = { schema: "qorpera.runner-transcript-entry/v1", entry: action.entry };
			args.p_expected_sequence = action.expectedSequence ?? null;
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
		/* Proxying object bytes through this function multiplies a company
		 * materialization into hundreds of full-size responses on the
		 * project's shared compute. When the caller opts in and the primary
		 * store can sign URLs, hand back a short-lived signed URL instead;
		 * the client verifies the content hash it addressed, so the bytes
		 * need no trusted channel. */
		if (
			request.headers.get("x-qorpera-object-transport") === "signed-url" &&
			configuredObjectStoragePrimary() === "supabase"
		) {
			const { data: signed, error: signError } = await client.storage
				.from(OBJECT_BUCKET)
				.createSignedUrl(`${profileId}/${objectRequest.objectSha256}`, 300);
			if (!signError && signed && typeof signed.signedUrl === "string" && signed.signedUrl) {
				return jsonResponse({
					value: {
						transport: "signed-url",
						signedUrl: signed.signedUrl,
						bytes: expectedBytes,
						sha256: objectRequest.objectSha256,
					},
				});
			}
		}
		let bytes: Uint8Array;
		try {
			const loadObject = createRunnerBrokerObjectLoader({
				primary: configuredObjectStoragePrimary(),
				gatewayUrl: Deno.env.get("QORPERA_OBJECT_GATEWAY_URL"),
				verifierToken: Deno.env.get("QORPERA_OBJECT_GATEWAY_VERIFIER_TOKEN"),
				storageDownload: async (profileId, sha256) => {
					const { data: blob, error: storageError } = await client.storage
						.from(OBJECT_BUCKET)
						.download(`${profileId}/${sha256}`);
					if (storageError) throw new Error("Runner input object is unavailable");
					return new Uint8Array(await blob.arrayBuffer());
				},
			});
			bytes = await loadObject(profileId, objectRequest.objectSha256);
		} catch {
			return jsonResponse({ error: "Runner input object is unavailable" }, 503);
		}
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
		objectRequest.purpose === "company_file"
			? "qorpera_runner_broker_authorize_company_file_object"
			: "qorpera_runner_broker_authorize_output_object",
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
