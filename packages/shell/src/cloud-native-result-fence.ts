import { chmod, lstat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudNativeResultInput, CloudNativeToolBoundary } from "./cloud-native-tool-boundary.ts";

export const CLOUD_NATIVE_RESULT_FENCE_SCHEMA = "qorpera.native-result-fence/v1";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTS = 256;
const DEADLINE_MS = 4_000;
const ID = /^[A-Za-z0-9_:.-]{1,160}$/;

export interface CloudNativeFenceRequest {
	schema: typeof CLOUD_NATIVE_RESULT_FENCE_SCHEMA;
	requestId: string;
	threadId: string;
	turnId: string | null;
	purpose: "turn" | "prewarm" | "compaction";
	outputs: CloudNativeResultInput[];
}

function closed(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid native result frame");
	return value as Record<string, unknown>;
}

function parseRequest(value: unknown): CloudNativeFenceRequest {
	const request = closed(value, "outputs,purpose,requestId,schema,threadId,turnId");
	if (
		request.schema !== CLOUD_NATIVE_RESULT_FENCE_SCHEMA ||
		typeof request.requestId !== "string" ||
		!ID.test(request.requestId) ||
		typeof request.threadId !== "string" ||
		!ID.test(request.threadId) ||
		(request.turnId !== null &&
			!(request.purpose === "prewarm" && request.turnId === "") &&
			(typeof request.turnId !== "string" || !ID.test(request.turnId))) ||
		!["turn", "prewarm", "compaction"].includes(String(request.purpose)) ||
		!Array.isArray(request.outputs) ||
		request.outputs.length > 128 ||
		(request.purpose === "prewarm" && request.outputs.length !== 0)
	)
		throw new Error("Invalid native result frame");
	const outputs = request.outputs.map((value): CloudNativeResultInput => {
		const item = closed(value, "callId,kind,output");
		if (
			(item.kind !== "function_call_output" && item.kind !== "custom_tool_call_output") ||
			typeof item.callId !== "string" ||
			!ID.test(item.callId)
		)
			throw new Error("Invalid native result frame");
		let output: JsonValue;
		if (typeof item.output === "string") output = item.output;
		else if (Array.isArray(item.output) && item.output.length <= 16)
			output = item.output.map((value): JsonValue => {
				const text = closed(value, "text,type");
				if (text.type !== "input_text" || typeof text.text !== "string")
					throw new Error("Unsupported native result content");
				return { type: "input_text", text: text.text };
			});
		else throw new Error("Unsupported native result content");
		return { kind: item.kind, callId: item.callId, output };
	});
	return {
		schema: CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
		requestId: request.requestId,
		threadId: request.threadId,
		turnId: request.turnId as string | null,
		purpose: request.purpose as CloudNativeFenceRequest["purpose"],
		outputs,
	};
}

/** One private Unix socket per native run; no provider URL, bearer, network listener or credential callback. */
export async function startCloudNativeResultFence(options: {
	root: string;
	boundary: CloudNativeToolBoundary;
	assertSession: (request: CloudNativeFenceRequest) => void;
	onFailure: () => void;
	signal: AbortSignal;
}): Promise<{ path: string; close: () => Promise<void> }> {
	const root = await lstat(options.root);
	const path = join(options.root, "result.sock");
	if (!isAbsolute(path) || !root.isDirectory() || (root.mode & 0o077) !== 0 || Buffer.byteLength(path) >= 104)
		throw new Error("Native result boundary requires a private Unix directory");
	options.signal.throwIfAborted();
	const sockets = new Set<Socket>();
	const requestIds = new Set<string>();
	let totalBytes = 0;
	let requests = 0;
	let stopped = false;
	const fail = (): void => {
		if (stopped) return;
		stopped = true;
		options.boundary.close();
		for (const socket of sockets) socket.destroy();
		options.onFailure();
	};
	const server = createServer((socket) => {
		if (stopped || sockets.size >= 4 || ++requests > MAX_REQUESTS) {
			socket.destroy();
			fail();
			return;
		}
		sockets.add(socket);
		const timer = setTimeout(fail, DEADLINE_MS);
		let headerBytes = 0;
		const header = Buffer.alloc(4);
		let frame: Buffer | undefined;
		let frameBytes = 0;
		let processing = false;
		socket.on("error", fail);
		socket.on("close", () => {
			clearTimeout(timer);
			sockets.delete(socket);
		});
		socket.on("data", (chunk: Buffer) => {
			try {
				totalBytes += chunk.length;
				if (stopped || processing || totalBytes > MAX_TOTAL_BYTES) throw new Error("Native result budget exceeded");
				let offset = 0;
				if (headerBytes < 4) {
					const copied = chunk.copy(header, headerBytes, 0, Math.min(chunk.length, 4 - headerBytes));
					headerBytes += copied;
					offset += copied;
					if (headerBytes < 4) return;
					const size = header.readUInt32BE();
					if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Native result frame too large");
					frame = Buffer.alloc(size);
				}
				if (!frame || chunk.length - offset > frame.length - frameBytes)
					throw new Error("Invalid native result framing");
				frameBytes += chunk.copy(frame, frameBytes, offset);
				if (frameBytes !== frame.length) return;
				processing = true;
				const request = parseRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)));
				if (requestIds.has(request.requestId)) throw new Error("Native result request replayed");
				requestIds.add(request.requestId);
				options.assertSession(request);
				void options.boundary
					.fenceNativeResults(request.outputs)
					.then((outputs) => {
						if (stopped || socket.destroyed || options.signal.aborted) return;
						options.assertSession(request);
						const wire = Buffer.from(
							JSON.stringify({
								schema: CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
								requestId: request.requestId,
								threadId: request.threadId,
								turnId: request.turnId,
								outputs,
							}),
						);
						totalBytes += wire.length + 4;
						if (wire.length > MAX_FRAME_BYTES || totalBytes > MAX_TOTAL_BYTES)
							throw new Error("Native result budget exceeded");
						const size = Buffer.alloc(4);
						size.writeUInt32BE(wire.length);
						socket.end(Buffer.concat([size, wire]));
					}, fail)
					.catch(fail);
			} catch {
				fail();
			}
		});
	});
	server.on("error", fail);
	options.signal.addEventListener("abort", fail, { once: true });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		options.signal.throwIfAborted();
		if (stopped) throw new Error("Native result boundary stopped");
	} catch {
		options.signal.removeEventListener("abort", fail);
		server.close();
		fail();
		throw new Error("Native result boundary unavailable");
	}
	return {
		path,
		async close() {
			stopped = true;
			options.signal.removeEventListener("abort", fail);
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
