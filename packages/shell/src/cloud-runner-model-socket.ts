import { chmod, lstat, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";

import type { JsonValue } from "@qorpera/contracts";

import {
	type CloudRunnerModelRequest,
	type CloudRunnerModelResponse,
	parseCloudRunnerModelResponse,
	validateCloudRunnerModelRequest,
} from "./cloud-runner-model.ts";

export const CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA = "qorpera.runner-model-socket-request/v1";
export const CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA = "qorpera.runner-model-socket-response/v1";

const MAX_REQUEST_BYTES = 300 * 1024;
const MAX_RESPONSE_BYTES = 600 * 1024;
const DEFAULT_MAX_REQUESTS = 128;
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface CloudRunnerModelBroker {
	requestModel(input: CloudRunnerModelRequest): Promise<CloudRunnerModelResponse>;
}

export interface CloudRunnerModelSocketServer {
	readonly socketPath: string;
	close(): Promise<void>;
}

export interface StartCloudRunnerModelSocketServerOptions {
	socketPath: string;
	broker: CloudRunnerModelBroker;
	maxRequests?: number;
	maxConnections?: number;
}

export type CloudRunnerModelSocketFactory = (
	options: StartCloudRunnerModelSocketServerOptions,
) => Promise<CloudRunnerModelSocketServer>;

interface ModelSocketRequestFrame {
	requestId: string;
	provider: string;
	model: string;
	input: JsonValue;
	maxOutputTokens: number;
}

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

function parseRequestFrame(value: unknown): ModelSocketRequestFrame {
	const frame = record(value);
	exactKeys(frame, ["schema", "request_id", "provider", "model", "input", "max_output_tokens"]);
	if (frame.schema !== CLOUD_RUNNER_MODEL_SOCKET_REQUEST_SCHEMA) {
		throw new Error("Runner model socket contains an unsupported request schema");
	}
	return validateCloudRunnerModelRequest({
		requestId: frame.request_id as string,
		provider: frame.provider as string,
		model: frame.model as string,
		input: frame.input as JsonValue,
		maxOutputTokens: frame.max_output_tokens as number,
	});
}

function responseValue(response: CloudRunnerModelResponse): Record<string, unknown> {
	return {
		request_id: response.requestId,
		provider: response.provider,
		model: response.model,
		output: response.output,
		usage: {
			input_tokens: response.usage.inputTokens,
			output_tokens: response.usage.outputTokens,
			cost_microusd: response.usage.costMicrousd,
		},
	};
}

function responseLine(response: CloudRunnerModelResponse): string {
	return `${JSON.stringify({
		schema: CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA,
		ok: true,
		response: responseValue(response),
	})}\n`;
}

function errorLine(): string {
	return `${JSON.stringify({
		schema: CLOUD_RUNNER_MODEL_SOCKET_RESPONSE_SCHEMA,
		ok: false,
		error: "model_request_rejected",
	})}\n`;
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

async function assertSocketPathAvailable(socketPath: string): Promise<void> {
	try {
		await lstat(socketPath);
		throw new Error("Runner model socket path already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
			else resolve();
		});
	});
}

export async function startCloudRunnerModelSocketServer(
	options: StartCloudRunnerModelSocketServerOptions,
): Promise<CloudRunnerModelSocketServer> {
	if (isWindowsPipe(options.socketPath)) {
		throw new Error("Windows named pipes are not an accepted runner model boundary");
	}
	const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
	const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > DEFAULT_MAX_REQUESTS) {
		throw new Error("Runner model socket contains an invalid request limit");
	}
	if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 16) {
		throw new Error("Runner model socket contains an invalid connection limit");
	}
	if (/\0|\r|\n/.test(options.socketPath) || !isAbsolute(options.socketPath)) {
		throw new Error("Runner model socket path is invalid");
	}
	if (Buffer.byteLength(options.socketPath) > 100) {
		throw new Error("Runner model socket path exceeds the portable Unix socket limit");
	}

	let acceptedRequests = 0;
	let activeConnections = 0;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		activeConnections += 1;
		let buffered = Buffer.alloc(0);
		let handled = false;
		const reject = () => {
			if (!socket.destroyed) socket.end(errorLine());
		};
		const handle = async (line: Buffer) => {
			try {
				const request = parseRequestFrame(JSON.parse(line.toString("utf8")));
				if (closing || acceptedRequests >= maxRequests) {
					reject();
					return;
				}
				acceptedRequests += 1;
				const response = parseCloudRunnerModelResponse(responseValue(await options.broker.requestModel(request)));
				if (
					response.requestId !== request.requestId ||
					response.provider !== request.provider ||
					response.model !== request.model ||
					response.usage.outputTokens > request.maxOutputTokens
				) {
					throw new Error("Runner model broker returned a mismatched response");
				}
				const encoded = responseLine(response);
				if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
					throw new Error("Runner model broker returned an oversized response");
				}
				if (!socket.destroyed) socket.end(encoded);
			} catch {
				reject();
			}
		};

		if (closing || activeConnections > maxConnections) {
			reject();
			handled = true;
		}
		socket.on("data", (chunk: Buffer) => {
			if (handled) return;
			buffered = Buffer.concat([buffered, chunk]);
			if (buffered.byteLength > MAX_REQUEST_BYTES) {
				handled = true;
				reject();
				return;
			}
			const newline = buffered.indexOf(0x0a);
			if (newline < 0) return;
			handled = true;
			const trailing = buffered
				.subarray(newline + 1)
				.toString("utf8")
				.trim();
			if (trailing.length > 0) {
				reject();
				return;
			}
			socket.pause();
			void handle(buffered.subarray(0, newline));
		});
		socket.on("end", () => {
			if (!handled) reject();
		});
		socket.on("error", () => undefined);
		socket.on("close", () => {
			sockets.delete(socket);
			activeConnections -= 1;
		});
	});
	server.on("error", () => undefined);

	await assertSocketPathAvailable(options.socketPath);
	let listening = false;
	try {
		await listen(server, options.socketPath);
		listening = true;
		await chmod(options.socketPath, 0o600);
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		await closeServer(server).catch(() => undefined);
		if (listening) await rm(options.socketPath, { force: true });
		throw error;
	}

	return {
		socketPath: options.socketPath,
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				for (const socket of sockets) socket.destroy();
				await closeServer(server).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") throw error;
				});
				await rm(options.socketPath, { force: true });
			})();
			return closePromise;
		},
	};
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
