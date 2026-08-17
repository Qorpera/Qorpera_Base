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
	| { action: "claim"; runnerId: string; clientLeaseId: string; leaseToken: string }
	| { action: "renew"; runnerId: string; jobId: string; leaseToken: string }
	| {
			action: "complete";
			runnerId: string;
			jobId: string;
			leaseToken: string;
			clientArtifactIndexId: string;
			clientSubstrateVersionId: string;
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
		case "claim":
			return {
				action,
				runnerId,
				clientLeaseId: uuid(input.clientLeaseId, "runner client lease id"),
				leaseToken: token(input.leaseToken, "runner lease token"),
			};
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
