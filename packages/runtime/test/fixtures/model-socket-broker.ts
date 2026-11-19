import { rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import {
	type CloudRunnerModelRequest,
	type CloudRunnerModelResponse,
	validateCloudRunnerModelRequest,
} from "@qorpera/cloud-client/cloud-runner-model";
import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA,
	CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA,
} from "@qorpera/runtime/cloud-runner-model-socket";

const REQUEST_KEYS = ["input", "max_output_tokens", "model", "provider", "request_id", "schema"].join();

export async function startCloudRunnerModelSocketServer(options: {
	socketPath: string;
	broker: { requestModel(input: CloudRunnerModelRequest): Promise<CloudRunnerModelResponse> };
}): Promise<{ close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
		let buffered = Buffer.alloc(0);
		const answer = async (line: Buffer): Promise<string> => {
			try {
				const frame = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
				if (
					Object.keys(frame).sort().join() !== REQUEST_KEYS ||
					frame.schema !== CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA
				)
					throw new Error("Invalid model socket request");
				const request = validateCloudRunnerModelRequest({
					requestId: frame.request_id as string,
					provider: frame.provider as string,
					model: frame.model as string,
					input: frame.input as JsonValue,
					maxOutputTokens: frame.max_output_tokens as number,
				});
				const response = await options.broker.requestModel(request);
				return JSON.stringify({
					schema: CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA,
					ok: true,
					response: {
						request_id: response.requestId,
						provider: response.provider,
						model: response.model,
						output: response.output,
						usage: {
							input_tokens: response.usage.inputTokens,
							output_tokens: response.usage.outputTokens,
							cost_microusd: response.usage.costMicrousd,
						},
					},
				});
			} catch {
				return JSON.stringify({
					schema: CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA,
					ok: false,
					error: "model_request_rejected",
				});
			}
		};
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			const newline = buffered.indexOf(0x0a);
			if (newline < 0) return;
			socket.pause();
			void answer(buffered.subarray(0, newline)).then((line) => {
				if (!socket.destroyed) socket.end(`${line}\n`);
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(options.socketPath, { force: true });
		},
	};
}
