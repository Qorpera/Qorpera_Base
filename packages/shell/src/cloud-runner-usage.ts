import type { JsonValue } from "@qorpera/pi-protocol";

export const CLOUD_RUNNER_USAGE_SCHEMA = "qorpera.runner-usage/v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_WALL_TIME_MS = 24 * 60 * 60 * 1000;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

export interface CloudRunnerUsageLimits {
	wallTimeMs: number;
	memoryBytes: number;
	cpuMillis: number;
	maxPids: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	maxResultBytes: number;
}

export interface CloudRunnerExecutionUsage {
	executionMs: number;
	inputBytes: number;
	outputBytes: number;
	resultBytes: number;
	limits: CloudRunnerUsageLimits;
}

export interface CloudRunnerUsageObservation extends CloudRunnerExecutionUsage {
	observationId: number;
	profileId: string;
	environmentId: string;
	jobId: string;
	runnerId: string;
	actorUserId: string;
	reservedCpuMilliseconds: number;
	reservedMemoryMibMilliseconds: number;
	createdAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Runner usage contains invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`Runner usage contains invalid ${label}`);
	}
	return value as number;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new Error(`Runner usage contains invalid ${label}`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
		throw new Error(`Runner usage contains invalid ${label}`);
	}
	return new Date(value).toISOString();
}

export function parseCloudRunnerExecutionUsage(value: unknown): CloudRunnerExecutionUsage {
	const input = record(value, "observation");
	if (input.schema !== CLOUD_RUNNER_USAGE_SCHEMA) throw new Error("Runner usage has an invalid schema");
	const rawLimits = record(input.limits, "limits");
	const limits: CloudRunnerUsageLimits = {
		wallTimeMs: integer(rawLimits.wall_time_ms, "wall-time limit", 10, MAX_WALL_TIME_MS),
		memoryBytes: integer(rawLimits.memory_bytes, "memory limit", 64 * 1024 * 1024, MAX_MEMORY_BYTES),
		cpuMillis: integer(rawLimits.cpu_millis, "CPU limit", 100, 64_000),
		maxPids: integer(rawLimits.max_pids, "process limit", 1, 4096),
		maxInputBytes: integer(rawLimits.max_input_bytes, "input limit", 1, MAX_INPUT_BYTES),
		maxOutputBytes: integer(rawLimits.max_output_bytes, "output limit", 0, MAX_OUTPUT_BYTES),
		maxResultBytes: integer(rawLimits.max_result_bytes, "result limit", 2, MAX_RESULT_BYTES),
	};
	return {
		executionMs: integer(input.execution_ms, "execution time", 1, limits.wallTimeMs),
		inputBytes: integer(input.input_bytes, "input bytes", 0, limits.maxInputBytes),
		outputBytes: integer(input.output_bytes, "output bytes", 0, limits.maxOutputBytes),
		resultBytes: integer(input.result_bytes, "result bytes", 1, limits.maxResultBytes),
		limits,
	};
}

export function serializeCloudRunnerExecutionUsage(usage: CloudRunnerExecutionUsage): JsonValue {
	const parsed = parseCloudRunnerExecutionUsage({
		schema: CLOUD_RUNNER_USAGE_SCHEMA,
		execution_ms: usage.executionMs,
		input_bytes: usage.inputBytes,
		output_bytes: usage.outputBytes,
		result_bytes: usage.resultBytes,
		limits: {
			wall_time_ms: usage.limits.wallTimeMs,
			memory_bytes: usage.limits.memoryBytes,
			cpu_millis: usage.limits.cpuMillis,
			max_pids: usage.limits.maxPids,
			max_input_bytes: usage.limits.maxInputBytes,
			max_output_bytes: usage.limits.maxOutputBytes,
			max_result_bytes: usage.limits.maxResultBytes,
		},
	});
	return {
		schema: CLOUD_RUNNER_USAGE_SCHEMA,
		execution_ms: parsed.executionMs,
		input_bytes: parsed.inputBytes,
		output_bytes: parsed.outputBytes,
		result_bytes: parsed.resultBytes,
		limits: {
			wall_time_ms: parsed.limits.wallTimeMs,
			memory_bytes: parsed.limits.memoryBytes,
			cpu_millis: parsed.limits.cpuMillis,
			max_pids: parsed.limits.maxPids,
			max_input_bytes: parsed.limits.maxInputBytes,
			max_output_bytes: parsed.limits.maxOutputBytes,
			max_result_bytes: parsed.limits.maxResultBytes,
		},
	};
}

export function parseCloudRunnerUsageObservation(value: unknown): CloudRunnerUsageObservation {
	const input = record(value, "ledger record");
	const usage = parseCloudRunnerExecutionUsage(input.usage);
	const reservedCpuMilliseconds = integer(
		input.reserved_cpu_milliseconds,
		"reserved CPU milliseconds",
		1,
		64 * MAX_WALL_TIME_MS,
	);
	const reservedMemoryMibMilliseconds = integer(
		input.reserved_memory_mib_milliseconds,
		"reserved memory MiB-milliseconds",
		1,
		(MAX_MEMORY_BYTES / (1024 * 1024)) * MAX_WALL_TIME_MS,
	);
	if (
		reservedCpuMilliseconds !== Math.ceil((usage.executionMs * usage.limits.cpuMillis) / 1000) ||
		reservedMemoryMibMilliseconds !== Math.ceil(usage.limits.memoryBytes / (1024 * 1024)) * usage.executionMs
	) {
		throw new Error("Runner usage contains inconsistent reserved capacity");
	}
	return {
		...usage,
		observationId: integer(input.observation_id, "observation id", 1, Number.MAX_SAFE_INTEGER),
		profileId: uuid(input.profile_id, "profile id"),
		environmentId: uuid(input.environment_id, "environment id"),
		jobId: uuid(input.job_id, "job id"),
		runnerId: uuid(input.runner_id, "runner id"),
		actorUserId: uuid(input.actor_user_id, "actor id"),
		reservedCpuMilliseconds,
		reservedMemoryMibMilliseconds,
		createdAt: timestamp(input.created_at, "creation time"),
	};
}
