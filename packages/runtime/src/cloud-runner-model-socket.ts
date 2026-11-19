import { createConnection } from "node:net";
import {
	type CloudRunnerModelRequest,
	type CloudRunnerModelResponse,
	parseCloudRunnerModelResponse,
	validateCloudRunnerModelRequest,
} from "@qorpera/cloud-client/cloud-runner-model";

export const CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA = "qorpera.runner-model-socket-request/v1";
export const CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA = "qorpera.runner-model-socket-response/v1";

const MAX_REQUEST_BYTES = 300 * 1024;
const MAX_RESPONSE_BYTES = 600 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Runner model socket contains an invalid frame");
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
		throw new Error("Runner model socket contains an invalid frame");
	}
}

function parseResponseFrame(value: unknown, request: CloudRunnerModelRequest): CloudRunnerModelResponse {
	const frame = record(value);
	if (frame.schema !== CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA) {
		throw new Error("Runner model socket returned an unsupported response schema");
	}
	if (frame.ok === false) {
		exactKeys(frame, ["schema", "ok", "error"]);
		if (frame.error !== "model_request_rejected") {
			throw new Error("Runner model socket returned an invalid rejection");
		}
		throw new Error("Runner model socket rejected the model request");
	}
	exactKeys(frame, ["schema", "ok", "response"]);
	if (frame.ok !== true) throw new Error("Runner model socket returned an invalid response");
	const response = parseCloudRunnerModelResponse(frame.response);
	if (
		response.requestId !== request.requestId ||
		response.provider !== request.provider ||
		response.model !== request.model ||
		response.usage.outputTokens > request.maxOutputTokens
	) {
		throw new Error("Runner model socket returned a mismatched response");
	}
	return response;
}

function isWindowsPipe(socketPath: string): boolean {
	return socketPath.startsWith("\\\\.\\pipe\\");
}

export async function requestCloudRunnerModelSocket(
	socketPath: string,
	input: CloudRunnerModelRequest,
	timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<CloudRunnerModelResponse> {
	if (isWindowsPipe(socketPath)) {
		throw new Error("Windows named pipes are not an accepted runner model boundary");
	}
	const request = validateCloudRunnerModelRequest(input);
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
		throw new Error("Runner model socket contains an invalid timeout");
	}
	const encoded = `${JSON.stringify({
		schema: CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA,
		request_id: request.requestId,
		provider: request.provider,
		model: request.model,
		input: request.input,
		max_output_tokens: request.maxOutputTokens,
	})}\n`;
	if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) {
		throw new Error("Runner model socket request exceeds the frame limit");
	}

	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffered = Buffer.alloc(0);
		let settled = false;
		const settle = (error?: Error, response?: CloudRunnerModelResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else if (response) resolve(response);
			else reject(new Error("Runner model socket closed without a response"));
		};
		const timer = setTimeout(() => settle(new Error("Runner model socket request timed out")), timeoutMs);
		socket.on("connect", () => socket.write(encoded));
		socket.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.byteLength > MAX_RESPONSE_BYTES) {
				settle(new Error("Runner model socket response exceeds the frame limit"));
				return;
			}
			const newline = buffered.indexOf(0x0a);
			if (newline < 0) return;
			try {
				const trailing = buffered
					.subarray(newline + 1)
					.toString("utf8")
					.trim();
				if (trailing.length > 0) throw new Error("Runner model socket returned multiple frames");
				settle(undefined, parseResponseFrame(JSON.parse(buffered.subarray(0, newline).toString("utf8")), request));
			} catch (error) {
				settle(error instanceof Error ? error : new Error("Runner model socket returned an invalid response"));
			}
		});
		socket.on("error", () => settle(new Error("Runner model socket connection failed")));
		socket.on("close", () => settle());
	});
}
