import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type CloudRunnerModelSocketServer,
	requestCloudRunnerModelSocket,
	startCloudRunnerModelSocketServer,
} from "../src/cloud-runner-model-socket.ts";

const requestId = "34343434-3434-4434-8434-343434343434";
const request = {
	requestId,
	provider: "openai",
	model: "gpt-test",
	input: { prompt: "bounded" },
	maxOutputTokens: 128,
} as const;

function portableSocketPath(root: string): string {
	return join(root, "model.sock");
}

describe("cloud runner model socket", () => {
	const servers: CloudRunnerModelSocketServer[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it.runIf(process.platform !== "win32")(
		"carries one bounded request through the host broker without credentials",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "qorpera-model-socket-"));
			const broker = {
				requestModel: vi.fn(async (input: typeof request) => ({
					requestId: input.requestId,
					provider: input.provider,
					model: input.model,
					output: { text: "brokered" },
					usage: { inputTokens: 2, outputTokens: 1, costMicrousd: 9 },
				})),
			};
			const server = await startCloudRunnerModelSocketServer({
				socketPath: portableSocketPath(root),
				broker,
			});
			servers.push(server);

			await expect(requestCloudRunnerModelSocket(server.socketPath, request)).resolves.toEqual({
				requestId,
				provider: "openai",
				model: "gpt-test",
				output: { text: "brokered" },
				usage: { inputTokens: 2, outputTokens: 1, costMicrousd: 9 },
			});
			expect(broker.requestModel).toHaveBeenCalledWith(request);
			expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
		},
	);

	it.runIf(process.platform !== "win32")(
		"enforces the job request limit and returns only a generic rejection",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "qorpera-model-socket-"));
			const broker = {
				requestModel: vi.fn(async (input: typeof request) => ({
					requestId: input.requestId,
					provider: input.provider,
					model: input.model,
					output: null,
					usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0 },
				})),
			};
			const server = await startCloudRunnerModelSocketServer({
				socketPath: portableSocketPath(root),
				broker,
				maxRequests: 1,
			});
			servers.push(server);

			await requestCloudRunnerModelSocket(server.socketPath, request);
			await expect(
				requestCloudRunnerModelSocket(server.socketPath, { ...request, requestId: randomUUID() }),
			).rejects.toThrow("rejected the model request");
			expect(broker.requestModel).toHaveBeenCalledTimes(1);
		},
	);

	it.runIf(process.platform !== "win32")("does not expose broker failures to the sandbox client", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-model-socket-"));
		const server = await startCloudRunnerModelSocketServer({
			socketPath: portableSocketPath(root),
			broker: {
				requestModel: async () => {
					throw new Error("provider secret and host credential");
				},
			},
		});
		servers.push(server);

		const failure = await requestCloudRunnerModelSocket(server.socketPath, request).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("Runner model socket rejected the model request");
		expect((failure as Error).message).not.toContain("secret");
	});

	it.runIf(process.platform !== "win32")("closes idempotently and removes a Unix socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-model-socket-"));
		const server = await startCloudRunnerModelSocketServer({
			socketPath: portableSocketPath(root),
			broker: {
				requestModel: async () => {
					throw new Error("unused");
				},
			},
		});
		servers.push(server);

		await Promise.all([server.close(), server.close()]);
		await expect(stat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.runIf(process.platform !== "win32")("refuses to replace an existing filesystem entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-model-socket-"));
		const socketPath = join(root, "model.sock");
		await writeFile(socketPath, "keep me", "utf-8");

		await expect(
			startCloudRunnerModelSocketServer({
				socketPath,
				broker: {
					requestModel: async () => {
						throw new Error("unused");
					},
				},
			}),
		).rejects.toThrow("already exists");
		await expect(readFile(socketPath, "utf-8")).resolves.toBe("keep me");
	});

	it("rejects Windows named pipes as an unauthenticated runner boundary", async () => {
		const socketPath = `\\\\.\\pipe\\qorpera-runner-model-${randomUUID()}`;
		await expect(
			startCloudRunnerModelSocketServer({
				socketPath,
				broker: {
					requestModel: async () => {
						throw new Error("unused");
					},
				},
			}),
		).rejects.toThrow("Windows named pipes are not an accepted runner model boundary");
		await expect(requestCloudRunnerModelSocket(socketPath, request)).rejects.toThrow(
			"Windows named pipes are not an accepted runner model boundary",
		);
	});
});
