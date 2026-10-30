const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_BODY_BYTES = 128 * 1024;

export type RunnerControlRequest =
	| {
			action: "activate";
			runnerId: string;
			nextSessionToken: string;
			platform: string;
			runnerVersion: string;
	  }
	| { action: "heartbeat"; runnerId: string; nextSessionToken: string; renewalId: string }
	| {
			action: "accept";
			runnerId: string;
			assignmentId: string;
			jobId: string;
			assignmentCapability: string;
	  }
	| {
			/** Accept, describe and (when asked) native authority in one transaction. */
			action: "start";
			runnerId: string;
			assignmentId: string;
			jobId: string;
			assignmentCapability: string;
			nativeLeaseSeconds?: number;
	  }
	| { action: "renew"; runnerId: string; jobId: string; leaseToken: string }
	| {
			action: "complete";
			runnerId: string;
			jobId: string;
			leaseToken: string;
			clientArtifactIndexId: string;
			clientSubstrateVersionId: string;
			outputSnapshotId?: string;
			result: Record<string, unknown>;
	  }
	| {
			action: "fail";
			runnerId: string;
			jobId: string;
			leaseToken: string;
			error: string;
			retryable: boolean;
	  };

export function runnerControlRpcName(action: RunnerControlRequest["action"]): string {
	switch (action) {
		case "activate":
			return "qorpera_activate_runner";
		case "heartbeat":
			return "qorpera_heartbeat_runner";
		case "accept":
			return "qorpera_accept_runner_assignment";
		case "start":
			return "qorpera_start_runner_assignment";
		case "renew":
			return "qorpera_renew_runner_job";
		case "complete":
			return "qorpera_complete_runner_job_v6";
		case "fail":
			return "qorpera_fail_runner_job";
	}
}

export function runnerControlRpcStatus(error: { code?: string }): number {
	if (error.code === "42501") return 401;
	if (error.code === "40001") return 409;
	// Unique violations are replay-divergence rejections: retrying the same
	// request can never succeed, so surface them as terminal conflicts rather
	// than a retryable 503.
	if (error.code === "23505") return 409;
	if (error.code === "55000") return 423;
	return 503;
}

/** A start that a database without qorpera_start_runner_assignment refused before running
 * anything (PostgREST PGRST202) answers 501, so the runner makes the separate calls instead. */
export function runnerStartRpcStatus(error: { code?: string }): number {
	return error.code === "PGRST202" ? 501 : runnerControlRpcStatus(error);
}

/** The one line a rejected call logs: the function's name and its SQLSTATE (or PostgREST code), so a refused
 * completion is seen where it happens (30 October 2026). Never the error's message, details or hint, which can name
 * the run's work, and never an argument or token. A code of any other shape is logged as "other". */
export function runnerControlRejectionLog(action: RunnerControlRequest["action"], error: { code?: string }): string {
	const code = error.code
		? /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(error.code)
			? error.code
			: "other"
		: "none";
	return `runner-control rejected rpc=${runnerControlRpcName(action)} sqlstate=${code}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function token(value: unknown, label: string): string {
	if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function objectPayload(value: unknown, label: string): Record<string, unknown> {
	const payload = record(value, label);
	if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 64 * 1024) {
		throw new Error(`Invalid ${label}`);
	}
	return payload;
}

export function parseRunnerBearer(value: string | null): string {
	if (!value?.startsWith("Bearer ")) throw new Error("Invalid runner authorization");
	return token(value.slice("Bearer ".length).trim(), "runner authorization");
}

export function parseRunnerControlRequest(value: unknown): RunnerControlRequest {
	const input = record(value, "runner request");
	const action = input.action;
	const runnerId = uuid(input.runnerId, "runner id");
	switch (action) {
		case "activate": {
			if (typeof input.platform !== "string" || !PLATFORM_PATTERN.test(input.platform)) {
				throw new Error("Invalid runner platform");
			}
			if (
				typeof input.runnerVersion !== "string" ||
				input.runnerVersion !== input.runnerVersion.trim() ||
				input.runnerVersion.length < 1 ||
				input.runnerVersion.length > 80
			) {
				throw new Error("Invalid runner version");
			}
			return {
				action,
				runnerId,
				nextSessionToken: token(input.nextSessionToken, "next runner session token"),
				platform: input.platform,
				runnerVersion: input.runnerVersion,
			};
		}
		case "heartbeat":
			return {
				action,
				runnerId,
				nextSessionToken: token(input.nextSessionToken, "next runner session token"),
				renewalId: uuid(input.renewalId, "runner renewal id"),
			};
		case "accept":
			return {
				action,
				runnerId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				jobId: uuid(input.jobId, "runner job id"),
				assignmentCapability: token(input.assignmentCapability, "runner assignment capability"),
			};
		case "start": {
			const nativeLeaseSeconds = input.nativeLeaseSeconds;
			if (
				nativeLeaseSeconds !== undefined &&
				(!Number.isSafeInteger(nativeLeaseSeconds) ||
					(nativeLeaseSeconds as number) < 30 ||
					(nativeLeaseSeconds as number) > 900)
			) {
				throw new Error("Invalid native authority lease seconds");
			}
			return {
				action,
				runnerId,
				assignmentId: uuid(input.assignmentId, "runner assignment id"),
				jobId: uuid(input.jobId, "runner job id"),
				assignmentCapability: token(input.assignmentCapability, "runner assignment capability"),
				...(nativeLeaseSeconds === undefined ? {} : { nativeLeaseSeconds: nativeLeaseSeconds as number }),
			};
		}
		case "renew":
			return {
				action,
				runnerId,
				jobId: uuid(input.jobId, "runner job id"),
				leaseToken: token(input.leaseToken, "runner lease token"),
			};
		case "complete":
			return {
				action,
				runnerId,
				jobId: uuid(input.jobId, "runner job id"),
				leaseToken: token(input.leaseToken, "runner lease token"),
				clientArtifactIndexId: uuid(input.clientArtifactIndexId, "runner output artifact index id"),
				clientSubstrateVersionId: uuid(input.clientSubstrateVersionId, "runner output substrate version id"),
				...(input.outputSnapshotId === null || input.outputSnapshotId === undefined
					? {}
					: { outputSnapshotId: uuid(input.outputSnapshotId, "runner output Company File snapshot id") }),
				result: objectPayload(input.result, "runner job result"),
			};
		case "fail": {
			if (
				typeof input.error !== "string" ||
				input.error !== input.error.trim() ||
				input.error.length < 1 ||
				input.error.length > 1000 ||
				typeof input.retryable !== "boolean"
			) {
				throw new Error("Invalid runner job failure");
			}
			return {
				action,
				runnerId,
				jobId: uuid(input.jobId, "runner job id"),
				leaseToken: token(input.leaseToken, "runner lease token"),
				error: input.error,
				retryable: input.retryable,
			};
		}
		default:
			throw new Error("Invalid runner action");
	}
}

export async function readRunnerControlRequest(request: Request): Promise<RunnerControlRequest> {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_BODY_BYTES) {
		throw new Error("Invalid runner request size");
	}
	const text = await request.text();
	if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
		throw new Error("Invalid runner request size");
	}
	return parseRunnerControlRequest(JSON.parse(text));
}
