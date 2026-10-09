import { chmod, lstat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextComposition,
	type CloudNativeContextRequest,
	cloudNativeContextIdentity,
	cloudNativeContextReply,
	parseCloudNativeContextRequest,
} from "./cloud-native-context-composition.ts";
import {
	CLOUD_NATIVE_FENCE_FRAME_BYTES,
	type CloudNativeFencedResult,
	type CloudNativeResultInput,
	type CloudNativeToolBoundary,
} from "./cloud-native-tool-boundary.ts";
import { JOBS } from "./memory-tree/tree.ts";

export const CLOUD_NATIVE_RESULT_FENCE_SCHEMA = "qorpera.native-result-fence/v1";
// One model request carries any number of tool outputs (runtime v104; the pinned
// Codex refused 128). The frame, the same on both sides, bounds only its size.
const MAX_FRAME_BYTES = CLOUD_NATIVE_FENCE_FRAME_BYTES;
// A run is not capped by its number of model requests or their total size
// (founder, 2026-09-24); replayed request ids are tracked in a rolling window.
const TRACKED_REQUESTS = 16_384;
// Connections open at once: a model request makes two, its context composition and then its fence, and the
// agent, one reviewer and JOBS compactor threads (RUNTIME-AGENT-MEMORY-TREE.md §7.1) may each have a prewarm and a
// turn's request open together. More is a flood, not a run.
export const CLOUD_NATIVE_FENCE_MAX_CONNECTIONS = 2 * 2 * (2 + JOBS);
// No stopwatch from a request's connection to its reply (5 Oct 2026; 4 s here and 5 s in Codex until then): the
// checks before release take as long as the database does, and only the run's end stops them (`signal`: its
// authority or lease gone, a refusal, a stop). The pinned Codex keeps a 10-minute backstop against a host that is
// alive but hung (0001-cloud-result-fence.patch), and a host that dies closes the socket at once.
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
		// No count cap on the outputs a request carries (founder, 2026-09-24).
		!Array.isArray(request.outputs) ||
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
				if (value && typeof value === "object" && "type" in value && value.type === "input_image") {
					const image = closed(value, "sha256,type");
					if (typeof image.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(image.sha256))
						throw new Error("Unsupported native result content");
					return { type: "input_image", sha256: image.sha256 };
				}
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
	/** The run's boundary, or a forwarder to it when the process starts before its run. */
	boundary: Pick<CloudNativeToolBoundary, "close" | "fenceNativeResults">;
	assertSession: (request: CloudNativeFenceRequest) => void;
	/** Auto-review (v130): a reviewer thread's request is answered with the host's own
	 * verdict acknowledgements, never the agent's tool results, and is not the agent's
	 * context. A memory compactor thread's has no tools: each output is answered as
	 * unavailable, and it is not the agent's context either. Returns undefined for every
	 * other request. */
	releaseReviewOutputs?: (request: CloudNativeFenceRequest) => CloudNativeFencedResult[] | undefined;
	/** Cloud runtime records exact released evidence before a provider request can leave. */
	recordContextView?: (
		request: CloudNativeFenceRequest,
		outputs: readonly CloudNativeFencedResult[],
		signal: AbortSignal,
	) => Promise<void>;
	/** True when recordContextView checks run authority and the read set in the same call that
	 * records the view: the boundary then leaves its own first check to that call. Asked per
	 * request, because a spare process is bound to its run later. */
	recordChecksAuthority?: () => boolean;
	/** Context composition (`qorpera.native-context-composition/v1`, cloud-native-context-composition.ts): before
	 * every provider request Codex asks on this socket what to send of its items. Without it such a request fails
	 * the fence. */
	context?: {
		/** The request's thread and turn are the run's (or a reviewer's), as for its fence request. */
		assertRequest: (request: CloudNativeContextRequest) => void;
		/** Every item kept, unchanged, when absent or when it returns undefined. */
		compose?: (
			request: CloudNativeContextRequest,
			signal: AbortSignal,
		) => CloudNativeContextComposition | undefined | Promise<CloudNativeContextComposition | undefined>;
	};
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
	let stopped = false;
	const fail = (): void => {
		if (stopped) return;
		stopped = true;
		options.boundary.close();
		for (const socket of sockets) socket.destroy();
		options.onFailure();
	};
	// One identity per request, composition or fence, in a rolling window.
	const track = (requestId: string): void => {
		if (requestIds.has(requestId)) throw new Error("Native result request replayed");
		requestIds.add(requestId);
		if (requestIds.size > TRACKED_REQUESTS) requestIds.delete(requestIds.values().next().value as string);
	};
	const reply = (socket: Socket, value: unknown): void => {
		const wire = Buffer.from(JSON.stringify(value));
		if (wire.length > MAX_FRAME_BYTES) throw new Error("Native result frame too large");
		const size = Buffer.alloc(4);
		size.writeUInt32BE(wire.length);
		socket.end(Buffer.concat([size, wire]));
	};
	const compose = (socket: Socket, request: CloudNativeContextRequest): void => {
		const context = options.context;
		if (!context) throw new Error("Native context composition unavailable");
		track(request.requestId);
		context.assertRequest(request);
		void Promise.resolve(context.compose?.(request, options.signal))
			.then((composition) => {
				if (stopped || socket.destroyed || options.signal.aborted) return;
				context.assertRequest(request);
				reply(socket, cloudNativeContextReply(request, composition ?? cloudNativeContextIdentity(request)));
			}, fail)
			.catch(fail);
	};
	const server = createServer((socket) => {
		if (stopped || sockets.size >= CLOUD_NATIVE_FENCE_MAX_CONNECTIONS) {
			socket.destroy();
			fail();
			return;
		}
		sockets.add(socket);
		let headerBytes = 0;
		const header = Buffer.alloc(4);
		let frame: Buffer | undefined;
		let frameBytes = 0;
		let processing = false;
		socket.on("error", fail);
		socket.on("close", () => {
			sockets.delete(socket);
		});
		socket.on("data", (chunk: Buffer) => {
			try {
				if (stopped || processing) throw new Error("Native result frame after its request");
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
				const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
				if (
					value &&
					typeof value === "object" &&
					(value as { schema?: unknown }).schema === CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA
				) {
					compose(socket, parseCloudNativeContextRequest(value));
					return;
				}
				const request = parseRequest(value);
				track(request.requestId);
				options.assertSession(request);
				const review = options.releaseReviewOutputs?.(request);
				// Nothing below reaches the socket before recordContextView has returned, so when that
				// call checks authority itself the boundary need not check first.
				const checkedByRecord =
					!review && !!options.recordContextView && options.recordChecksAuthority?.() === true;
				void (
					review
						? Promise.resolve(review)
						: options.boundary.fenceNativeResults(request.outputs, {
								authority: checkedByRecord ? "with-record" : "here",
							})
				)
					.then(async (outputs) => {
						if (stopped || socket.destroyed || options.signal.aborted) return;
						options.assertSession(request);
						if (!review) await options.recordContextView?.(request, outputs, options.signal);
						if (stopped || socket.destroyed || options.signal.aborted) return;
						options.assertSession(request);
						reply(socket, {
							schema: CLOUD_NATIVE_RESULT_FENCE_SCHEMA,
							requestId: request.requestId,
							threadId: request.threadId,
							turnId: request.turnId,
							outputs: outputs.map(({ capture: _capture, ...output }) => output),
						});
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
