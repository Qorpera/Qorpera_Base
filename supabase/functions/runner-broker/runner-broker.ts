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
