import { randomUUID } from "node:crypto";
import { requestCloudRunnerModelSocket } from "@qorpera/runtime/cloud-runner-model-socket";
import { describe, expect, it } from "vitest";

const requestId = "34343434-3434-4434-8434-343434343434";
const request = {
	requestId,
	provider: "openai",
	model: "gpt-test",
	input: { prompt: "bounded" },
	maxOutputTokens: 128,
} as const;

describe("cloud runner model socket", () => {
	it("rejects Windows named pipes as an unauthenticated runner boundary", async () => {
		const socketPath = `\\\\.\\pipe\\qorpera-runner-model-${randomUUID()}`;
		await expect(requestCloudRunnerModelSocket(socketPath, request)).rejects.toThrow(
			"Windows named pipes are not an accepted runner model boundary",
		);
	});
});
