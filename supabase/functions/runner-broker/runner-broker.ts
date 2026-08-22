const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_MODEL_INPUT_BYTES = 256 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 512 * 1024;
export const MAX_RUNNER_BROKER_OBJECT_BYTES = 8 * 1024 * 1024;

interface RunnerBrokerRequestBase {
	runnerId: string;
	jobId: string;
}

export type RunnerBrokerRequest =
	| (RunnerBrokerRequestBase & { action: "describe" })
	| (RunnerBrokerRequestBase & { action: "inputs" })
	| (RunnerBrokerRequestBase & { action: "transcript"; afterSequence: number; limit: number })
	| (RunnerBrokerRequestBase & { action: "operations"; afterSequence: number; limit: number })
	| (RunnerBrokerRequestBase & { action: "artifacts"; afterOrdinal: number; limit: number })
	| (RunnerBrokerRequestBase & {
			action: "native_authority";
			runId: string;
			assignmentId: string;
			leaseSeconds: number;
	  })
	| (RunnerBrokerRequestBase & {
			action: "renew_native_authority";
			leaseId: string;
			leaseSeconds: number;
	  })
	| (RunnerBrokerRequestBase & {
			action: "release_native_authority";
			leaseId: string;
			status: "released" | "revoked" | "expired";
	  })
	| (RunnerBrokerRequestBase & {
			action: "model";
			requestId: string;
			provider: string;
			model: string;
			input: unknown;
			maxOutputTokens: number;
	  })
	| (RunnerBrokerRequestBase & {
			action: "register_artifact";
			clientArtifactId: string;
			artifactType: string;
			name: string;
			objectSha256: string;
			bytes: number;
			mediaType: string;
	  })
	| (RunnerBrokerRequestBase & {
			action: "begin_operation";
			assignmentId: string;
			receiptId: string;
			logicalOperationKey: string;
			operationKind: string;
			inputSha256: string;
			downstreamIdempotencyKey: string;
			requiresCompanyRevision: boolean;
	  })
	| (RunnerBrokerRequestBase & {
			action: "complete_operation";
			assignmentId: string;
			receiptId: string;
			inputSha256: string;
			result: unknown;
			outputSnapshotId?: string;
			proposalId?: string;
	  })
	| (RunnerBrokerRequestBase & {
			action: "bind_provider_session";
			providerSessionId: string;
			contextCheckpointObjectSha256?: string;
	  })
	| (RunnerBrokerRequestBase & {
			action: "prepare_company_revision";
			assignmentId: string;
			clientRevisionId: string;
			treeManifestSha256: string;
			treeManifestBytes: number;
			treeContractVersion: number;
			fileCount: number;
			totalBytes: number;
	  })
	| (RunnerBrokerRequestBase & {
			action: "begin_company_revision_graph";
			assignmentId: string;
			snapshotId: string;
			clientGraphId: string;
			rootObjectSha256: string;
			contentSha256: string;
			objectCount: number;
			storageBytes: number;
	  })
	| (RunnerBrokerRequestBase & {
			action: "append_company_revision_graph";
			assignmentId: string;
			graphId: string;
			entries: readonly { sha256: string; bytes: number }[];
	  })
	| (RunnerBrokerRequestBase & {
			action: "complete_company_revision_graph";
			assignmentId: string;
			graphId: string;
	  })
	| (RunnerBrokerRequestBase & {
			action: "verify_company_revision";
			assignmentId: string;
			snapshotId: string;
			graphId: string;
	  })
	| (RunnerBrokerRequestBase & {
			action: "append_transcript";
			assignmentId: string;
			eventId: string;
			eventType:
				| "message"
				| "run_receipt"
				| "artifact_receipt"
				| "authorization_request"
				| "authorization_decision";
			entry: unknown;
			expectedSequence?: number;
	  });

export interface RunnerBrokerAuthorization {
	sessionToken: string;
	leaseToken: string;
}

export interface RunnerBrokerObjectRequest extends RunnerBrokerAuthorization {
	runnerId: string;
	jobId: string;
	objectSha256: string;
	purpose: "artifact" | "company_file";
}

export interface RunnerModelGatewayResponse {
	output: unknown;
	usage: {
		inputTokens: number;
		outputTokens: number;
		costMicrousd: number;
	};
}

export interface RunnerModelGatewayAuthority {
	runId: string;
	jobId: string;
	sponsorBindingId: string;
	sponsorVersion: number;
	providerConnectionId: string;
	providerConnectionVersion: number;
	provider: string;
	authenticationMode: "native_subscription" | "enterprise_access_token" | "api_key" | "cloud_service_account";
	nativeHarness: string;
	maxCostMicrousd: number;
}

export interface RunnerModelGatewayFinalization {
	outcome: "completed" | "failed";
	usage: RunnerModelGatewayResponse["usage"];
	response: unknown;
	errorCode: string | null;
}

export type RunnerModelGatewayExecutionResult =
	| { status: "completed"; value: unknown }
	| { status: "failed" }
	| { status: "ambiguous"; errorCode: string };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		value.length < 1 ||
		value.length > maximum ||
		/[\0\r\n]/.test(value)
	) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function uuid(value: unknown, label: string): string {
	const checked = text(value, label, 64);
	if (!UUID_PATTERN.test(checked)) throw new Error(`Invalid ${label}`);
	return checked;
}

function optionalUuid(value: unknown, label: string): string | undefined {
	return value === null || value === undefined ? undefined : uuid(value, label);
}

function token(value: unknown, label: string): string {
	const checked = text(value, label, 64);
	if (!TOKEN_PATTERN.test(checked)) throw new Error(`Invalid ${label}`);
	return checked;
}

function parseRunnerBearer(value: string | null): string {
	if (!value?.startsWith("Bearer ")) throw new Error("Invalid runner authorization");
	return token(value.slice("Bearer ".length).trim(), "runner authorization");
}

function sha256(value: unknown, label: string): string {
	const checked = text(value, label, 64);
	if (!SHA256_PATTERN.test(checked)) throw new Error(`Invalid ${label}`);
	return checked;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

function json(value: unknown, label: string, maximumBytes: number): unknown {
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new Error(`Invalid ${label}`);
	}
	if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maximumBytes) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function objectJson(value: unknown, label: string, maximumBytes: number): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return json(value, label, maximumBytes);
}

function provider(value: unknown): string {
	const checked = text(value, "runner model provider", 64);
	if (!/^[a-z][a-z0-9_-]{0,63}$/.test(checked)) throw new Error("Invalid runner model provider");
	return checked;
}

function model(value: unknown): string {
	return text(value, "runner model id", 160);
}

export function runnerBrokerMediaType(value: unknown): string {
	const checked = text(value, "runner broker media type", 256).toLowerCase();
	if (!checked.includes("/")) throw new Error("Invalid runner broker media type");
	return checked;
}

export function parseRunnerBrokerAuthorization(headers: Headers): RunnerBrokerAuthorization {
	return {
		sessionToken: parseRunnerBearer(headers.get("authorization")),
		leaseToken: token(headers.get("x-qorpera-lease-token"), "runner lease token"),
	};
}

export function parseRunnerBrokerObjectRequest(headers: Headers): RunnerBrokerObjectRequest {
	const purpose = headers.get("x-qorpera-object-purpose") ?? "artifact";
	if (purpose !== "artifact" && purpose !== "company_file") throw new Error("Invalid runner object purpose");
	return {
		...parseRunnerBrokerAuthorization(headers),
		runnerId: uuid(headers.get("x-qorpera-runner-id"), "runner id"),
		jobId: uuid(headers.get("x-qorpera-job-id"), "runner job id"),
		objectSha256: sha256(headers.get("x-qorpera-object-sha256"), "runner object hash"),
		purpose,
	};
}

export function parseRunnerBrokerRequest(value: unknown): RunnerBrokerRequest {
	const input = record(value, "runner broker request");
	const runnerId = uuid(input.runnerId, "runner id");
	const jobId = uuid(input.jobId, "runner job id");
	switch (input.action) {
		case "describe":
		case "inputs":
			return { action: input.action, runnerId, jobId };
		case "transcript":
			return {
				action: input.action,
				runnerId,
				jobId,
				afterSequence: integer(input.afterSequence, "runner transcript cursor", 0, Number.MAX_SAFE_INTEGER),
				limit: integer(input.limit, "runner transcript page size", 1, 500),
			};
		case "operations":
			return {
				action: input.action,
				runnerId,
				jobId,
				afterSequence: integer(input.afterSequence, "runner operation cursor", 0, Number.MAX_SAFE_INTEGER),
				limit: integer(input.limit, "runner operation page size", 1, 500),
			};
		case "artifacts":
			return {
				action: input.action,
				runnerId,
				jobId,
				afterOrdinal: integer(input.afterOrdinal, "runner artifact cursor", 0, 5000),
				limit: integer(input.limit, "runner artifact page size", 1, 500),
			};
		case "native_authority":
			return {
				action: input.action,
				runnerId,
				jobId,
				runId: uuid(input.runId, "native authority run id"),
				assignmentId: uuid(input.assignmentId, "native authority assignment id"),
				leaseSeconds: integer(input.leaseSeconds, "native authority lease seconds", 30, 900),
			};
		case "renew_native_authority":
			return {
				action: input.action,
				runnerId,
				jobId,
				leaseId: uuid(input.leaseId, "native authority lease id"),
				leaseSeconds: integer(input.leaseSeconds, "native authority lease seconds", 30, 900),
			};
		case "release_native_authority": {
			if (input.status !== "released" && input.status !== "revoked" && input.status !== "expired") {
				throw new Error("Invalid native authority release status");
			}
			return {
				action: input.action,
				runnerId,
				jobId,
				leaseId: uuid(input.leaseId, "native authority lease id"),
				status: input.status,
			};
		}
		case "model":
			return {
				action: input.action,
				runnerId,
				jobId,
				requestId: uuid(input.requestId, "runner model request id"),
				provider: provider(input.provider),
				model: model(input.model),
				input: json(input.input, "runner model input", MAX_MODEL_INPUT_BYTES),
				maxOutputTokens: integer(input.maxOutputTokens, "runner model output tokens", 1, 1_000_000),
			};
		case "register_artifact": {
			const artifactType = text(input.artifactType, "runner artifact type", 64);
			if (!TYPE_PATTERN.test(artifactType)) throw new Error("Invalid runner artifact type");
			return {
				action: input.action,
				runnerId,
				jobId,
				clientArtifactId: uuid(input.clientArtifactId, "runner client artifact id"),
				artifactType,
				name: text(input.name, "runner artifact name", 256),
				objectSha256: sha256(input.objectSha256, "runner artifact object hash"),
				bytes: integer(input.bytes, "runner artifact bytes", 0, MAX_RUNNER_BROKER_OBJECT_BYTES),
				mediaType: runnerBrokerMediaType(input.mediaType),
			};
		}
		case "begin_operation": {
			const operationKind = text(input.operationKind, "runner operation kind", 64);
			if (!TYPE_PATTERN.test(operationKind) || typeof input.requiresCompanyRevision !== "boolean") {
				throw new Error("Invalid runner operation");
			}
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				receiptId: uuid(input.receiptId, "runner receipt id"),
				logicalOperationKey: text(input.logicalOperationKey, "logical operation key", 256),
				operationKind,
				inputSha256: sha256(input.inputSha256, "runner operation input hash"),
				downstreamIdempotencyKey: text(
					input.downstreamIdempotencyKey,
					"downstream idempotency key",
					256,
				),
				requiresCompanyRevision: input.requiresCompanyRevision,
			};
		}
		case "complete_operation": {
			const outputSnapshotId = optionalUuid(input.outputSnapshotId, "runner output snapshot id");
			const proposalId = optionalUuid(input.proposalId, "runner proposal id");
			if (outputSnapshotId && proposalId) throw new Error("Invalid runner operation output");
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				receiptId: uuid(input.receiptId, "runner receipt id"),
				inputSha256: sha256(input.inputSha256, "runner operation input hash"),
				result: objectJson(input.result, "runner operation result", 64 * 1024),
				...(outputSnapshotId ? { outputSnapshotId } : {}),
				...(proposalId ? { proposalId } : {}),
			};
		}
		case "bind_provider_session": {
			const contextCheckpointObjectSha256 =
				input.contextCheckpointObjectSha256 === null || input.contextCheckpointObjectSha256 === undefined
					? undefined
					: sha256(input.contextCheckpointObjectSha256, "provider checkpoint hash");
			return {
				action: input.action,
				runnerId,
				jobId,
				providerSessionId: text(input.providerSessionId, "provider session id", 1024),
				...(contextCheckpointObjectSha256 ? { contextCheckpointObjectSha256 } : {}),
			};
		}
		case "prepare_company_revision":
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				clientRevisionId: uuid(input.clientRevisionId, "runner client revision id"),
				treeManifestSha256: sha256(input.treeManifestSha256, "runner tree manifest hash"),
				treeManifestBytes: integer(input.treeManifestBytes, "runner tree manifest bytes", 1, 8 * 1024 * 1024),
				treeContractVersion: integer(input.treeContractVersion, "runner tree contract version", 3, 3),
				fileCount: integer(input.fileCount, "runner tree file count", 0, 50_000),
				totalBytes: integer(input.totalBytes, "runner tree total bytes", 0, 1_099_511_627_776),
			};
		case "begin_company_revision_graph":
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				snapshotId: uuid(input.snapshotId, "runner Company File snapshot id"),
				clientGraphId: uuid(input.clientGraphId, "runner Company File client graph id"),
				rootObjectSha256: sha256(input.rootObjectSha256, "runner Company File graph root"),
				contentSha256: sha256(input.contentSha256, "runner Company File graph content"),
				objectCount: integer(input.objectCount, "runner Company File graph object count", 1, 400_000),
				storageBytes: integer(
					input.storageBytes,
					"runner Company File graph storage bytes",
					0,
					2_199_023_255_552,
				),
			};
		case "append_company_revision_graph": {
			if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 500) {
				throw new Error("Invalid runner Company File graph entries");
			}
			const entries = input.entries.map((value) => {
				const entry = record(value, "runner Company File graph entry");
				return {
					sha256: sha256(entry.sha256, "runner Company File graph entry hash"),
					bytes: integer(entry.bytes, "runner Company File graph entry bytes", 0, MAX_RUNNER_BROKER_OBJECT_BYTES),
				};
			});
			if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) {
				throw new Error("Invalid runner Company File graph entries");
			}
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				graphId: uuid(input.graphId, "runner Company File graph id"),
				entries,
			};
		}
		case "complete_company_revision_graph":
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				graphId: uuid(input.graphId, "runner Company File graph id"),
			};
		case "verify_company_revision":
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				snapshotId: uuid(input.snapshotId, "runner Company File snapshot id"),
				graphId: uuid(input.graphId, "runner Company File graph id"),
			};
		case "append_transcript": {
			if (
				input.eventType !== "message" &&
				input.eventType !== "run_receipt" &&
				input.eventType !== "artifact_receipt" &&
				input.eventType !== "authorization_request" &&
				input.eventType !== "authorization_decision"
			) {
				throw new Error("Invalid runner transcript event type");
			}
			return {
				action: input.action,
				runnerId,
				jobId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				eventId: uuid(input.eventId, "runner transcript event id"),
				eventType: input.eventType,
				entry: objectJson(input.entry, "runner transcript entry", 240 * 1024),
				...(input.expectedSequence === null || input.expectedSequence === undefined
					? {}
					: {
						expectedSequence: integer(
							input.expectedSequence,
							"runner transcript sequence",
							0,
							Number.MAX_SAFE_INTEGER,
						),
					  }),
			};
		}
		default:
			throw new Error("Invalid runner broker action");
	}
}

export async function readRunnerBrokerRequest(request: Request): Promise<RunnerBrokerRequest> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
		throw new Error("Invalid runner broker request size");
	}
	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
		throw new Error("Invalid runner broker request size");
	}
	return parseRunnerBrokerRequest(JSON.parse(body));
}

export async function readRunnerBrokerObjectBody(request: Request, expectedBytes: number): Promise<Uint8Array> {
	integer(expectedBytes, "runner output object bytes", 0, MAX_RUNNER_BROKER_OBJECT_BYTES);
	if (!request.body) {
		if (expectedBytes === 0) return new Uint8Array();
		throw new Error("Invalid runner output object body");
	}
	const output = new Uint8Array(expectedBytes);
	const reader = request.body.getReader();
	let offset = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (offset + chunk.value.byteLength > expectedBytes) {
				throw new Error("Invalid runner output object body");
			}
			output.set(chunk.value, offset);
			offset += chunk.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (offset !== expectedBytes) throw new Error("Invalid runner output object body");
	return output;
}

export function parseRunnerModelGatewayResponse(value: unknown): RunnerModelGatewayResponse {
	const input = record(value, "runner model gateway response");
	if (input.schema !== "qorpera.model-gateway-response/v1") {
		throw new Error("Invalid runner model gateway schema");
	}
	const usage = record(input.usage, "runner model gateway usage");
	return {
		output: json(input.output, "runner model gateway output", MAX_MODEL_OUTPUT_BYTES),
		usage: {
			inputTokens: integer(usage.input_tokens, "runner model input usage", 0, 100_000_000),
			outputTokens: integer(usage.output_tokens, "runner model output usage", 0, 100_000_000),
			costMicrousd: integer(usage.cost_microusd, "runner model cost usage", 0, Number.MAX_SAFE_INTEGER),
		},
	};
}

export function parseRunnerModelGatewayAuthority(value: unknown): RunnerModelGatewayAuthority {
	const input = record(value, "runner model gateway authority");
	if (input.schema !== "qorpera.model-gateway-authority/v1") {
		throw new Error("Invalid runner model gateway authority schema");
	}
	const allowedFields = new Set([
		"schema",
		"run_id",
		"job_id",
		"sponsor_binding_id",
		"sponsor_version",
		"provider_connection_id",
		"provider_connection_version",
		"provider",
		"authentication_mode",
		"native_harness",
		"max_cost_microusd",
	]);
	if (Object.keys(input).some((field) => !allowedFields.has(field))) {
		throw new Error("Invalid runner model gateway authority fields");
	}
	if (
		input.authentication_mode !== "native_subscription" &&
		input.authentication_mode !== "enterprise_access_token" &&
		input.authentication_mode !== "api_key" &&
		input.authentication_mode !== "cloud_service_account"
	) {
		throw new Error("Invalid runner model gateway authentication mode");
	}
	return {
		runId: uuid(input.run_id, "runner model run id"),
		jobId: uuid(input.job_id, "runner model job id"),
		sponsorBindingId: uuid(input.sponsor_binding_id, "runner model sponsor binding id"),
		sponsorVersion: integer(input.sponsor_version, "runner model sponsor version", 1, Number.MAX_SAFE_INTEGER),
		providerConnectionId: uuid(input.provider_connection_id, "runner model provider connection id"),
		providerConnectionVersion: integer(
			input.provider_connection_version,
			"runner model provider connection version",
			1,
			Number.MAX_SAFE_INTEGER,
		),
		provider: provider(input.provider),
		authenticationMode: input.authentication_mode,
		nativeHarness: text(input.native_harness, "runner model native harness", 120),
		maxCostMicrousd: integer(input.max_cost_microusd, "runner model cost authority", 1, Number.MAX_SAFE_INTEGER),
	};
}

export async function readRunnerModelGatewayResponse(response: Response): Promise<RunnerModelGatewayResponse> {
	const declaredBytes = Number(response.headers.get("content-length") ?? "-1");
	if (Number.isFinite(declaredBytes) && declaredBytes > MAX_MODEL_OUTPUT_BYTES) {
		throw new Error("Invalid runner model gateway response size");
	}
	if (!response.body) throw new Error("Invalid runner model gateway response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_MODEL_OUTPUT_BYTES) throw new Error("Invalid runner model gateway response size");
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(body));
	} catch {
		throw new Error("Invalid runner model gateway response");
	}
	return parseRunnerModelGatewayResponse(parsed);
}

export async function executeRunnerModelGateway(options: {
	url: string;
	token: string;
	request: {
		requestId: string;
		provider: string;
		model: string;
		input: unknown;
		maxOutputTokens: number;
		authority: RunnerModelGatewayAuthority;
	};
	finalize: (input: RunnerModelGatewayFinalization) => Promise<unknown>;
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
}): Promise<RunnerModelGatewayExecutionResult> {
	const timeoutMs = integer(options.timeoutMs ?? 120_000, "runner model gateway timeout", 1, 300_000);
	if (options.request.authority.authenticationMode === "native_subscription") {
		throw new Error("Native subscription traffic must use the provider-native harness");
	}
	if (options.request.provider !== options.request.authority.provider) {
		throw new Error("Runner model provider does not match its gateway authority");
	}
	const requestProjection = {
		request_id: options.request.requestId,
		provider: options.request.provider,
		model: options.request.model,
		input: options.request.input,
		max_output_tokens: options.request.maxOutputTokens,
		authority: {
			schema: "qorpera.model-gateway-authority/v1",
			run_id: options.request.authority.runId,
			job_id: options.request.authority.jobId,
			sponsor_binding_id: options.request.authority.sponsorBindingId,
			sponsor_version: options.request.authority.sponsorVersion,
			provider_connection_id: options.request.authority.providerConnectionId,
			provider_connection_version: options.request.authority.providerConnectionVersion,
			provider: options.request.authority.provider,
			authentication_mode: options.request.authority.authenticationMode,
			native_harness: options.request.authority.nativeHarness,
			max_cost_microusd: options.request.authority.maxCostMicrousd,
		},
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let gatewayResponse: RunnerModelGatewayResponse | undefined;
	let gatewayFailure = "gateway_unavailable";
	let deterministicRejection = false;
	try {
		const response = await (options.fetchImplementation ?? fetch)(options.url, {
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${options.token}`,
				"content-type": "application/json",
				"idempotency-key": options.request.requestId,
				"x-qorpera-request-id": options.request.requestId,
			},
			body: JSON.stringify(requestProjection),
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			gatewayFailure = "gateway_rejected";
			// A non-transient 4xx means the gateway refused the request before
			// any provider charge could occur. 408/429 stay ambiguous so the
			// payload-pinned request UUID can retry the same reservation later.
			deterministicRejection =
				response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
		} else {
			gatewayResponse = await readRunnerModelGatewayResponse(response);
		}
	} catch {
		gatewayFailure = controller.signal.aborted ? "gateway_timeout" : "gateway_invalid";
	} finally {
		clearTimeout(timer);
	}
	if (!gatewayResponse) {
		if (deterministicRejection) {
			// Settle the reservation so the job's completion path is not blocked
			// forever by a request the gateway will reject identically on every
			// replay. No provider call happened, so zero usage is truthful.
			await options.finalize({
				outcome: "failed",
				usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0 },
				response: null,
				errorCode: "gateway_rejected",
			});
			return { status: "failed" };
		}
		return { status: "ambiguous", errorCode: gatewayFailure };
	}
	if (gatewayResponse.usage.outputTokens > options.request.maxOutputTokens) {
		await options.finalize({
			outcome: "failed",
			usage: gatewayResponse.usage,
			response: null,
			errorCode: "gateway_usage_exceeded",
		});
		return { status: "failed" };
	}
	if (gatewayResponse.usage.costMicrousd > options.request.authority.maxCostMicrousd) {
		await options.finalize({
			outcome: "failed",
			usage: gatewayResponse.usage,
			response: null,
			errorCode: "gateway_cost_exceeded",
		});
		return { status: "failed" };
	}
	return {
		status: "completed",
		value: await options.finalize({
			outcome: "completed",
			usage: gatewayResponse.usage,
			response: gatewayResponse.output,
			errorCode: null,
		}),
	};
}
