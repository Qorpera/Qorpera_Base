import {
	parseCloudRunnerExecutionUsage,
	parseCloudRunnerUsageObservation,
	serializeCloudRunnerExecutionUsage,
} from "@qorpera/cloud-client/cloud-runner-usage";
import { describe, expect, it } from "vitest";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const environmentId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const jobId = "9a8796b5-1394-4f20-a708-5eeb82849e53";
const runnerId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const actorUserId = "c98d600e-654a-40da-a07f-f1d54f93cc6c";

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
	it("serializes one bounded observation and verifies server-derived capacity", () => {
		const serialized = serializeCloudRunnerExecutionUsage(usage);
		expect(parseCloudRunnerExecutionUsage(serialized)).toEqual(usage);
		expect(
			parseCloudRunnerUsageObservation({
				observation_id: 17,
				profile_id: profileId,
				environment_id: environmentId,
				job_id: jobId,
				runner_id: runnerId,
				actor_user_id: actorUserId,
				usage: serialized,
				reserved_cpu_milliseconds: 500,
				reserved_memory_mib_milliseconds: 128_000,
				created_at: "2026-08-17T02:00:00.000Z",
			}),
		).toMatchObject({
			observationId: 17,
			profileId,
			jobId,
			actorUserId,
			executionMs: 250,
			reservedCpuMilliseconds: 500,
			reservedMemoryMibMilliseconds: 128_000,
		});
	});

	it("rejects over-limit metrics and altered server-derived quantities", () => {
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
		expect(() =>
			parseCloudRunnerUsageObservation({
				observation_id: 17,
				profile_id: profileId,
				environment_id: environmentId,
				job_id: jobId,
				runner_id: runnerId,
				actor_user_id: actorUserId,
				usage: serialized,
				reserved_cpu_milliseconds: 499,
				reserved_memory_mib_milliseconds: 128_000,
				created_at: "2026-08-17T02:00:00.000Z",
			}),
		).toThrow("reserved capacity");
	});
});
