import {
	parseCloudRunnerExecutionUsage,
	serializeCloudRunnerExecutionUsage,
} from "@qorpera/cloud-client/cloud-runner-usage";
import { describe, expect, it } from "vitest";

const usage = {
	executionMs: 250,
	inputBytes: 1024,
	outputBytes: 512,
	resultBytes: 64,
	limits: {
		wallTimeMs: 30_000,
		memoryBytes: 512 * 1024 * 1024,
		cpuMillis: 2000,
		maxPids: 64,
		maxInputBytes: 2048,
		maxOutputBytes: 1024,
		maxResultBytes: 1024,
	},
};

describe("cloud runner usage", () => {
	it("serializes one bounded observation in the stored wire format", () => {
		const serialized = serializeCloudRunnerExecutionUsage(usage);
		expect(serialized).toEqual({
			schema: "qorpera.runner-usage/v1",
			execution_ms: 250,
			input_bytes: 1024,
			output_bytes: 512,
			result_bytes: 64,
			limits: {
				wall_time_ms: 30_000,
				memory_bytes: 512 * 1024 * 1024,
				cpu_millis: 2000,
				max_pids: 64,
				max_input_bytes: 2048,
				max_output_bytes: 1024,
				max_result_bytes: 1024,
			},
		});
		expect(parseCloudRunnerExecutionUsage(serialized)).toEqual(usage);
	});

	it("rejects over-limit metrics", () => {
		expect(() => serializeCloudRunnerExecutionUsage({ ...usage, outputBytes: 1025 })).toThrow("output bytes");
		const serialized = serializeCloudRunnerExecutionUsage(usage);
		if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)) {
			throw new Error("Serialized usage must be an object");
		}
		expect(() =>
			parseCloudRunnerExecutionUsage({
				...serialized,
				output_bytes: 1025,
			}),
		).toThrow("output bytes");
	});
});
