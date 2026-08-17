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
	| (RunnerBrokerRequestBase & { action: "operations"; afterSequence: number; limit: number })
	| (RunnerBrokerRequestBase & { action: "artifacts"; afterOrdinal: number; limit: number })
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
	  });

export interface RunnerBrokerAuthorization {
	sessionToken: string;
	leaseToken: string;
}

export interface RunnerBrokerObjectRequest extends RunnerBrokerAuthorization {
	runnerId: string;
	jobId: string;
	objectSha256: string;
}

export interface RunnerModelGatewayResponse {
	output: unknown;
	usage: {
		inputTokens: number;
		outputTokens: number;
		costMicrousd: number;
	};
}

export interface RunnerModelGatewayFinalization {
	outcome: "completed" | "failed";
	usage: RunnerModelGatewayResponse["usage"];
	response: unknown;
	errorCode: string | null;
}

export type RunnerModelGatewayExecutionResult =
	| { status: "completed"; value: unknown }
	| { status: "failed" };

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
	return {
		...parseRunnerBrokerAuthorization(headers),
		runnerId: uuid(headers.get("x-qorpera-runner-id"), "runner id"),
		jobId: uuid(headers.get("x-qorpera-job-id"), "runner job id"),
		objectSha256: sha256(headers.get("x-qorpera-object-sha256"), "runner object hash"),
	};
}

export function parseRunnerBrokerRequest(value: unknown): RunnerBrokerRequest {
	const input = record(value, "runner broker request");
	const runnerId = uuid(input.runnerId, "runner id");
	const jobId = uuid(input.jobId, "runner job id");
	switch (input.action) {
		case "describe":
			return { action: input.action, runnerId, jobId };
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
	};
	inputTokenReservation: number;
	finalize: (input: RunnerModelGatewayFinalization) => Promise<unknown>;
	fetchImplementation?: typeof fetch;
	timeoutMs?: number;
}): Promise<RunnerModelGatewayExecutionResult> {
	const timeoutMs = integer(options.timeoutMs ?? 120_000, "runner model gateway timeout", 1, 300_000);
	const requestProjection = {
		request_id: options.request.requestId,
		provider: options.request.provider,
		model: options.request.model,
		input: options.request.input,
		max_output_tokens: options.request.maxOutputTokens,
	};
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let gatewayResponse: RunnerModelGatewayResponse | undefined;
	let gatewayFailure = "gateway_unavailable";
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
		if (!response.ok) gatewayFailure = "gateway_rejected";
		else {
			gatewayResponse = await readRunnerModelGatewayResponse(response);
			if (
				gatewayResponse.usage.inputTokens > options.inputTokenReservation ||
				gatewayResponse.usage.outputTokens > options.request.maxOutputTokens
			) {
				gatewayResponse = undefined;
				gatewayFailure = "gateway_usage_invalid";
			}
		}
	} catch {
		gatewayFailure = controller.signal.aborted ? "gateway_timeout" : "gateway_invalid";
	} finally {
		clearTimeout(timer);
	}
	if (!gatewayResponse) {
		await options.finalize({
			outcome: "failed",
			usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0 },
			response: null,
			errorCode: gatewayFailure,
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
