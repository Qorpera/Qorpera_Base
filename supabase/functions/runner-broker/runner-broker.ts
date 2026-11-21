const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_BODY_BYTES = 512 * 1024;

interface RunnerBrokerRequestBase {
	runnerId: string;
	jobId: string;
}

export type RunnerBrokerRequest =
	| (RunnerBrokerRequestBase & { action: "describe" })
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
	  });

export interface RunnerBrokerAuthorization {
	sessionToken: string;
	leaseToken: string;
}

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

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Invalid ${label}`);
	}
	return value as number;
}

export function parseRunnerBrokerAuthorization(headers: Headers): RunnerBrokerAuthorization {
	return {
		sessionToken: parseRunnerBearer(headers.get("authorization")),
		leaseToken: token(headers.get("x-qorpera-lease-token"), "runner lease token"),
	};
}

export function parseRunnerBrokerRequest(value: unknown): RunnerBrokerRequest {
	const input = record(value, "runner broker request");
	const runnerId = uuid(input.runnerId, "runner id");
	const jobId = uuid(input.jobId, "runner job id");
	switch (input.action) {
		case "describe":
			return { action: input.action, runnerId, jobId };
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
		default:
			throw new Error("Invalid runner broker action");
	}
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function readRunnerBrokerRequest(request: Request): Promise<RunnerBrokerRequest> {
	const rawLength = request.headers.get("content-length");
	if (rawLength !== null) {
		const contentLength = Number(rawLength);
		if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
			throw new Error("Invalid runner broker request size");
		}
	}
	const reader = request.body?.getReader();
	if (!reader) return parseRunnerBrokerRequest(JSON.parse(""));
	const chunks: Uint8Array[] = [];
	let total = 0;
	let overflow = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) {
				overflow = true;
				throw new Error("Invalid runner broker request size");
			}
			chunks.push(value);
		}
	} finally {
		if (overflow) void reader.cancel().catch(() => undefined);
	}
	let body = "";
	if (chunks.length === 1) {
		body = UTF8_DECODER.decode(chunks[0]!);
	} else if (chunks.length > 1) {
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		body = UTF8_DECODER.decode(merged);
	}
	return parseRunnerBrokerRequest(JSON.parse(body));
}

export type RunnerBrokerRpc = (
	fn: string,
	args: Record<string, unknown>,
) => Promise<{ readonly data: unknown; readonly error: { readonly code?: string } | null }>;

export function runnerBrokerRpcStatus(error: { readonly code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "22023") return 400;
	if (error.code === "23505" || error.code === "40001" || error.code === "55000") return 409;
	return 503;
}

export async function acquireNativeAuthorityWithRollback(
	rpc: RunnerBrokerRpc,
	action: Extract<RunnerBrokerRequest, { readonly action: "native_authority" }>,
	hashes: { readonly sessionTokenSha256: string; readonly leaseTokenSha256: string },
): Promise<
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly status: number; readonly error: string }
> {
	const { data, error } = await rpc("qorpera_acquire_native_provider_connection_lease", {
		p_run_id: action.runId,
		p_runner_id: action.runnerId,
		p_session_token_sha256: hashes.sessionTokenSha256,
		p_assignment_id: action.assignmentId,
		p_lease_token_sha256: hashes.leaseTokenSha256,
		p_lease_seconds: action.leaseSeconds,
	});
	if (error) return { ok: false, status: runnerBrokerRpcStatus(error), error: "Native provider authority was rejected" };
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return { ok: false, status: 503, error: "Native provider authority was invalid" };
	}
	const acquired = data as Record<string, unknown>;
	const leaseId = typeof acquired.lease_id === "string" && UUID_PATTERN.test(acquired.lease_id) ? acquired.lease_id : null;
	const { data: modelData, error: modelError } = await rpc("qorpera_native_run_model_authority", {
		p_run_id: action.runId,
		p_runner_id: action.runnerId,
		p_session_token_sha256: hashes.sessionTokenSha256,
		p_job_id: action.jobId,
		p_lease_token_sha256: hashes.leaseTokenSha256,
	});
	if (modelError) {
		if (leaseId) {
			await rpc("qorpera_release_native_provider_connection_lease", {
				p_lease_id: leaseId,
				p_runner_id: action.runnerId,
				p_session_token_sha256: hashes.sessionTokenSha256,
				p_job_id: action.jobId,
				p_lease_token_sha256: hashes.leaseTokenSha256,
				p_status: "released",
			}).catch(() => undefined);
		}
		return {
			ok: false,
			status: runnerBrokerRpcStatus(modelError),
			error: "Native provider model authority was rejected",
		};
	}
	return { ok: true, value: { ...acquired, model: modelData } };
}
