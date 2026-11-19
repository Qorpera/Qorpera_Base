import type { JsonValue } from "@qorpera/contracts";

export const CLOUD_RUNNER_USAGE_SCHEMA = "qorpera.runner-usage/v1";

/** A run with no wall-clock limit reports this as its limit (founder, 2026-09-24:
 * company runs have no deadline). Usage records it as is. */
export const CLOUD_RUNNER_NO_WALL_TIME_MS = Number.MAX_SAFE_INTEGER;
const MAX_WALL_TIME_MS = CLOUD_RUNNER_NO_WALL_TIME_MS;
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
