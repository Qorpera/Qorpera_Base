import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	ModelsSimpleStreamOptions,
} from "@qorpera/pi-ai";
import { createAssistantMessageEventStream } from "@qorpera/pi-ai";
import type { KernelIntentCapability } from "./kernel-broker.ts";

const MAX_MODEL_REQUEST_BYTES = 64 * 1024 * 1024;

interface BrokerRequestFrame {
	type: "qorpera_model_request";
	requestId: string;
	handle: string;
	intent: KernelIntentCapability;
	model: { provider: string; id: string };
	context: Context;
	options: Record<string, unknown>;
}

const turnContext = new AsyncLocalStorage<KernelIntentCapability>();
const pending = new Map<string, AssistantMessageEventStream>();
let handles = new Map<string, string>();
let installed = false;
let writeFrame: ((frame: object) => void) | undefined;

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function failedStream(model: Model<Api>, message: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const error = errorMessage(model, message);
	stream.push({ type: "error", reason: "error", error });
	stream.end(error);
	return stream;
}

function brokerOptions(options: ModelsSimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return { transport: "sse" };
	return {
		...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
		...(options.samplingParams ? { samplingParams: options.samplingParams } : {}),
		...(typeof options.maxTokens === "number" ? { maxTokens: options.maxTokens } : {}),
		transport: "sse",
		...(options.cacheRetention ? { cacheRetention: options.cacheRetention } : {}),
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
		...(typeof options.websocketConnectTimeoutMs === "number"
			? { websocketConnectTimeoutMs: options.websocketConnectTimeoutMs }
			: {}),
		...(typeof options.maxRetries === "number" ? { maxRetries: options.maxRetries } : {}),
		...(typeof options.maxRetryDelayMs === "number" ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
		...(options.metadata ? { metadata: options.metadata } : {}),
		...(options.reasoning ? { reasoning: options.reasoning } : {}),
		...(options.thinkingBudgets ? { thinkingBudgets: options.thinkingBudgets } : {}),
		...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
	};
}

/** Install the kernel IPC model lane and deny every ordinary child fetch. */
export function installModelBrokerFetch(): void {
	if (installed) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(process.env.QORPERA_MODEL_BROKER_HANDLES ?? "{}");
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const entries = Object.entries(parsed);
	if (!entries.every(([provider, handle]) => provider && typeof handle === "string" && handle)) return;
	handles = new Map(entries as Array<[string, string]>);
	globalThis.fetch = () => Promise.reject(new Error("all child HTTP requests are disabled by the kernel"));
	installed = true;
}

export function isModelBrokerInstalled(): boolean {
	return installed;
}

export function setModelBrokerWriter(writer: (frame: object) => void): void {
	writeFrame = writer;
}

/** Scope a verified founder/kernel intent to the core agent's model stream call. */
export function withModelBrokerTurn<T>(intent: KernelIntentCapability | undefined, action: () => T): T {
	if (!installed) return action();
	if (!intent) throw new Error("kernel model request has no verified causal intent");
	return turnContext.run(intent, action);
}

/**
 * The child sends structured model context over its existing kernel pipe.
 * Provider request construction, credentials, network, and paid execution all
 * remain in the desktop process; no mutable child code receives those powers.
 */
export function brokeredStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: ModelsSimpleStreamOptions,
): AssistantMessageEventStream | undefined {
	if (!installed) return undefined;
	const intent = turnContext.getStore();
	const handle = handles.get(model.provider);
	if (!intent || !handle) return failedStream(model, "kernel model request is not authorized for this turn/provider");
	const requestId = randomUUID();
	const stream = createAssistantMessageEventStream();
	const frame: BrokerRequestFrame = {
		type: "qorpera_model_request",
		requestId,
		handle,
		intent,
		model: { provider: model.provider, id: model.id },
		context,
		options: brokerOptions(options),
	};
	let serialized: string;
	try {
		serialized = JSON.stringify(frame);
	} catch {
		return failedStream(model, "kernel model request is not serializable");
	}
	if (Buffer.byteLength(serialized, "utf-8") > MAX_MODEL_REQUEST_BYTES) {
		return failedStream(model, "kernel model request exceeds 64 MiB");
	}
	if (!writeFrame) return failedStream(model, "kernel model pipe is unavailable");
	pending.set(requestId, stream);
	writeFrame(frame);
	if (options?.signal) {
		const abort = () => writeFrame?.({ type: "qorpera_model_abort", requestId });
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });
	}
	return stream;
}

/** Consume only kernel-originated model stream frames from RPC stdin. */
export function handleModelBrokerFrame(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as {
		type?: unknown;
		requestId?: unknown;
		event?: unknown;
		error?: unknown;
	};
	if (frame.type !== "qorpera_model_event" && frame.type !== "qorpera_model_end") return false;
	if (typeof frame.requestId !== "string") return true;
	const stream = pending.get(frame.requestId);
	if (!stream) return true;
	if (frame.type === "qorpera_model_event") {
		if (frame.event && typeof frame.event === "object") stream.push(frame.event as AssistantMessageEvent);
		return true;
	}
	pending.delete(frame.requestId);
	if (typeof frame.error === "string") {
		const fallback = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "kernel",
			model: "broker",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: frame.error,
			timestamp: Date.now(),
		} as AssistantMessage;
		stream.push({ type: "error", reason: "error", error: fallback });
		stream.end(fallback);
	} else {
		stream.end();
	}
	return true;
}
