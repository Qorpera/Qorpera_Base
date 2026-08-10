import { createHash } from "node:crypto";
import { ModelRuntime } from "@qorpera/pi-coding-agent";
import type { KernelIntentCapability } from "./agent-runtime.ts";
import { brokerCredentialProjection } from "./model-request-scope.ts";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ModelRequestFrame {
	type: "qorpera_model_request";
	requestId: string;
	handle: string;
	intent: KernelIntentCapability;
	model: { provider: string; id: string };
	context: Parameters<ModelRuntime["streamSimple"]>[1];
	options: Record<string, unknown>;
}

interface ModelAbortFrame {
	type: "qorpera_model_abort";
	requestId: string;
}

interface BrokerSession {
	handles: Map<string, string>;
	intents: Map<string, KernelIntentCapability>;
	observe?: (event: {
		intentNonce: string;
		requestHash: string;
		provider: string;
		model: string;
		requestSha256: string;
		status: "started" | "completed" | "failed" | "aborted";
	}) => void;
}

interface InFlightRequest {
	controller: AbortController;
	session: BrokerSession;
}

export interface BrokeredCredentials {
	handles: Record<string, string>;
	credentials: Record<string, unknown>;
	authorizeIntent: (intent: KernelIntentCapability) => void;
	release: () => void;
}

export interface ModelRequestBroker {
	registerChild: (
		sourceCredentials: Record<string, unknown>,
		ambientProviders: string[],
		observe?: BrokerSession["observe"],
	) => BrokeredCredentials;
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	close: () => void;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function validIntent(value: unknown): value is KernelIntentCapability {
	return (
		exactObject(value, ["nonce", "requestHash", "attended", "expiresAt", "signature"]) &&
		typeof value.nonce === "string" &&
		REQUEST_ID_PATTERN.test(value.nonce) &&
		typeof value.requestHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.requestHash) &&
		typeof value.attended === "boolean" &&
		typeof value.expiresAt === "string" &&
		typeof value.signature === "string" &&
		value.signature.length > 0
	);
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
		? value
		: undefined;
}

function jsonRecord(value: unknown, maximumBytes: number): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8") <= maximumBytes
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function requestOptions(value: unknown): Parameters<ModelRuntime["streamSimple"]>[2] | undefined {
	if (
		!exactObject(value, [
			"temperature",
			"samplingParams",
			"maxTokens",
			"transport",
			"cacheRetention",
			"sessionId",
			"timeoutMs",
			"websocketConnectTimeoutMs",
			"maxRetries",
			"maxRetryDelayMs",
			"metadata",
			"reasoning",
			"thinkingBudgets",
			"serviceTier",
		])
	)
		return undefined;
	const temperature = value.temperature === undefined ? undefined : finiteNumber(value.temperature, 0, 2);
	const maxTokens = value.maxTokens === undefined ? undefined : finiteNumber(value.maxTokens, 1, 10_000_000);
	const timeoutMs = value.timeoutMs === undefined ? undefined : finiteNumber(value.timeoutMs, 1, 2_147_483_647);
	const websocketConnectTimeoutMs =
		value.websocketConnectTimeoutMs === undefined
			? undefined
			: finiteNumber(value.websocketConnectTimeoutMs, 1, 2_147_483_647);
	const maxRetries = value.maxRetries === undefined ? undefined : finiteNumber(value.maxRetries, 0, 20);
	const maxRetryDelayMs =
		value.maxRetryDelayMs === undefined ? undefined : finiteNumber(value.maxRetryDelayMs, 0, 3_600_000);
	if (
		(value.temperature !== undefined && temperature === undefined) ||
		(value.maxTokens !== undefined && maxTokens === undefined) ||
		(value.timeoutMs !== undefined && timeoutMs === undefined) ||
		(value.websocketConnectTimeoutMs !== undefined && websocketConnectTimeoutMs === undefined) ||
		(value.maxRetries !== undefined && maxRetries === undefined) ||
		(value.maxRetryDelayMs !== undefined && maxRetryDelayMs === undefined) ||
		value.transport !== "sse" ||
		(value.cacheRetention !== undefined && !["none", "short", "long"].includes(String(value.cacheRetention))) ||
		(value.reasoning !== undefined &&
			!["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.reasoning))) ||
		(value.serviceTier !== undefined && !["default", "flex", "priority"].includes(String(value.serviceTier))) ||
		(value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 256))
	)
		return undefined;
	const samplingParams = value.samplingParams === undefined ? undefined : jsonRecord(value.samplingParams, 64 * 1024);
	const metadata = value.metadata === undefined ? undefined : jsonRecord(value.metadata, 64 * 1024);
	const thinkingBudgets =
		value.thinkingBudgets === undefined ? undefined : jsonRecord(value.thinkingBudgets, 64 * 1024);
	if (
		(value.samplingParams !== undefined && !samplingParams) ||
		(value.metadata !== undefined && !metadata) ||
		(value.thinkingBudgets !== undefined && !thinkingBudgets)
	)
		return undefined;
	return {
		...(temperature !== undefined ? { temperature } : {}),
		...(samplingParams ? { samplingParams } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		transport: "sse",
		...(value.cacheRetention ? { cacheRetention: value.cacheRetention as "none" | "short" | "long" } : {}),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(websocketConnectTimeoutMs !== undefined ? { websocketConnectTimeoutMs } : {}),
		...(maxRetries !== undefined ? { maxRetries } : {}),
		...(maxRetryDelayMs !== undefined ? { maxRetryDelayMs } : {}),
		...(metadata ? { metadata } : {}),
		...(value.reasoning
			? { reasoning: value.reasoning as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
			: {}),
		...(thinkingBudgets ? { thinkingBudgets } : {}),
		...(value.serviceTier ? { serviceTier: value.serviceTier as "default" | "flex" | "priority" } : {}),
	};
}

function parsedRequest(value: unknown): ModelRequestFrame | undefined {
	if (!exactObject(value, ["type", "requestId", "handle", "intent", "model", "context", "options"])) return undefined;
	if (
		value.type !== "qorpera_model_request" ||
		typeof value.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(value.requestId) ||
		typeof value.handle !== "string" ||
		!validIntent(value.intent) ||
		!exactObject(value.model, ["provider", "id"]) ||
		typeof value.model.provider !== "string" ||
		typeof value.model.id !== "string" ||
		!exactObject(value.context, ["systemPrompt", "messages", "tools"]) ||
		!Array.isArray(value.context.messages) ||
		(value.context.systemPrompt !== undefined && typeof value.context.systemPrompt !== "string") ||
		(value.context.tools !== undefined && !Array.isArray(value.context.tools)) ||
		Buffer.byteLength(JSON.stringify(value), "utf-8") > MAX_REQUEST_BYTES ||
		!requestOptions(value.options)
	)
		return undefined;
	return value as unknown as ModelRequestFrame;
}

export async function startModelRequestBroker(options: {
	authPath: string;
	modelsPath: string;
	allowedProviders: ReadonlySet<string>;
}): Promise<ModelRequestBroker> {
	const runtime = await ModelRuntime.create({
		authPath: options.authPath,
		modelsPath: options.modelsPath,
		allowModelNetwork: false,
	});
	const sessions = new Set<BrokerSession>();
	const handleSessions = new Map<string, BrokerSession>();
	const inFlight = new Map<string, InFlightRequest>();
	const sendRequest = async (frame: ModelRequestFrame, send: (frame: object) => void): Promise<void> => {
		const session = handleSessions.get(frame.handle);
		const provider = session?.handles.get(frame.handle);
		const authorized = session?.intents.get(frame.intent.nonce);
		const model = provider ? runtime.getModel(provider, frame.model.id) : undefined;
		const options = requestOptions(frame.options);
		if (
			!session ||
			!provider ||
			provider !== frame.model.provider ||
			!authorized ||
			JSON.stringify(authorized) !== JSON.stringify(frame.intent) ||
			!model ||
			!options ||
			inFlight.has(frame.requestId)
		) {
			send({ type: "qorpera_model_end", requestId: frame.requestId, error: "kernel model request denied" });
			return;
		}
		const requestSha256 = createHash("sha256").update(JSON.stringify(frame)).digest("hex");
		const controller = new AbortController();
		inFlight.set(frame.requestId, { controller, session });
		session.observe?.({
			intentNonce: frame.intent.nonce,
			requestHash: frame.intent.requestHash,
			provider,
			model: model.id,
			requestSha256,
			status: "started",
		});
		try {
			const stream = runtime.streamSimple(model, frame.context, { ...options, signal: controller.signal });
			for await (const event of stream) send({ type: "qorpera_model_event", requestId: frame.requestId, event });
			session.observe?.({
				intentNonce: frame.intent.nonce,
				requestHash: frame.intent.requestHash,
				provider,
				model: model.id,
				requestSha256,
				status: controller.signal.aborted ? "aborted" : "completed",
			});
			send({ type: "qorpera_model_end", requestId: frame.requestId });
		} catch {
			session.observe?.({
				intentNonce: frame.intent.nonce,
				requestHash: frame.intent.requestHash,
				provider,
				model: model.id,
				requestSha256,
				status: controller.signal.aborted ? "aborted" : "failed",
			});
			send({ type: "qorpera_model_end", requestId: frame.requestId, error: "kernel model execution failed" });
		} finally {
			inFlight.delete(frame.requestId);
		}
	};
	return {
		registerChild: (sourceCredentials, ambientProviders, observe) => {
			const projection = brokerCredentialProjection(sourceCredentials, ambientProviders, options.allowedProviders);
			const session: BrokerSession = { handles: projection.handles, intents: new Map(), observe };
			sessions.add(session);
			for (const handle of session.handles.keys()) handleSessions.set(handle, session);
			return {
				handles: Object.fromEntries([...projection.handles].map(([handle, provider]) => [provider, handle])),
				credentials: projection.credentials,
				authorizeIntent: (intent) => session.intents.set(intent.nonce, { ...intent }),
				release: () => {
					for (const [requestId, request] of inFlight) {
						if (request.session === session) {
							request.controller.abort();
							inFlight.delete(requestId);
						}
					}
					for (const handle of session.handles.keys()) handleSessions.delete(handle);
					session.intents.clear();
					sessions.delete(session);
				},
			};
		},
		handleFrame: (value, send) => {
			const request = parsedRequest(value);
			if (request) {
				void sendRequest(request, send);
				return true;
			}
			if (!exactObject(value, ["type", "requestId"]) || value.type !== "qorpera_model_abort") return false;
			const abort = value as unknown as ModelAbortFrame;
			if (typeof abort.requestId === "string") inFlight.get(abort.requestId)?.controller.abort();
			return true;
		},
		close: () => {
			for (const request of inFlight.values()) request.controller.abort();
			inFlight.clear();
			handleSessions.clear();
			for (const session of sessions) session.intents.clear();
			sessions.clear();
		},
	};
}
