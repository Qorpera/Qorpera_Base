import { createHash } from "node:crypto";
import { ModelRuntime } from "@qorpera/pi-coding-agent";
import type {
	KernelIntentCapability,
	KernelModelIntentBudget,
	ModelIntentEndFrame,
	ModelIntentTerminalStatus,
} from "@qorpera/pi-protocol";
import { brokerCredentialProjection } from "./model-request-scope.ts";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;
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

interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

interface ModelBudgetUsage extends ModelUsage {
	calls: number;
}

interface ModelRequestObservation {
	event: "request" | "intent";
	intentNonce: string;
	requestHash: string;
	provider?: string;
	model?: string;
	requestSha256?: string;
	status: "started" | "completed" | "failed" | "aborted" | ModelIntentTerminalStatus;
	reservation?: ModelUsage;
	usage?: ModelUsage & { calls?: number };
}

interface RequestReservation extends ModelUsage {}

interface IntentState {
	capability: KernelIntentCapability;
	status: "active" | ModelIntentTerminalStatus;
	usage: ModelBudgetUsage;
	reserved: ModelUsage;
	requestDigests: Set<string>;
	expiryTimer: NodeJS.Timeout;
}

interface BrokerSession {
	sessionId: string;
	handles: Map<string, string>;
	intents: Map<string, IntentState>;
	seenRequestIds: Set<string>;
	observe?: (event: ModelRequestObservation) => void;
}

interface InFlightRequest {
	controller: AbortController;
	session: BrokerSession;
	intent: IntentState;
	reservation: RequestReservation;
	expiryTimer: NodeJS.Timeout;
}

export interface BrokeredCredentials {
	handles: Record<string, string>;
	credentials: Record<string, unknown>;
	authorizeIntent: (intent: KernelIntentCapability) => boolean;
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	endTurn: (status: "completed" | "aborted" | "failed") => void;
	release: () => void;
}

/**
 * The broker owns authority and provider execution. BrokeredCredentials is a
 * transport-neutral channel: stdin/stdout, HTTPS, or WebSocket adapters only
 * need to carry parsed frames and return parsed frames.
 */
export interface ModelRequestBroker {
	registerChild: (
		sessionId: string,
		sourceCredentials: Record<string, unknown>,
		ambientProviders: string[],
		observe?: BrokerSession["observe"],
	) => BrokeredCredentials;
	close: () => void;
}

export interface ModelRequestRuntime {
	getModel: ModelRuntime["getModel"];
	streamSimple: ModelRuntime["streamSimple"];
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function validBudget(value: unknown): value is KernelModelIntentBudget {
	if (!exactObject(value, ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxCostUsd"])) return false;
	return (
		Number.isInteger(value.maxCalls) &&
		(value.maxCalls as number) > 0 &&
		Number.isInteger(value.maxInputTokens) &&
		(value.maxInputTokens as number) > 0 &&
		Number.isInteger(value.maxOutputTokens) &&
		(value.maxOutputTokens as number) > 0 &&
		typeof value.maxCostUsd === "number" &&
		Number.isFinite(value.maxCostUsd) &&
		value.maxCostUsd >= 0
	);
}

function validIntent(value: unknown): value is KernelIntentCapability {
	return (
		exactObject(value, [
			"nonce",
			"sessionId",
			"requestHash",
			"attended",
			"issuedAt",
			"expiresAt",
			"budget",
			"signature",
		]) &&
		typeof value.nonce === "string" &&
		REQUEST_ID_PATTERN.test(value.nonce) &&
		typeof value.sessionId === "string" &&
		value.sessionId.length > 0 &&
		typeof value.requestHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.requestHash) &&
		typeof value.attended === "boolean" &&
		typeof value.issuedAt === "string" &&
		typeof value.expiresAt === "string" &&
		validBudget(value.budget) &&
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

function serializedBytes(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return undefined;
	}
}

function parsedRequest(value: unknown): ModelRequestFrame | undefined {
	if (!exactObject(value, ["type", "requestId", "handle", "intent", "model", "context", "options"])) return undefined;
	const bytes = serializedBytes(value);
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
		bytes === undefined ||
		bytes > MAX_REQUEST_BYTES ||
		!requestOptions(value.options)
	)
		return undefined;
	return value as unknown as ModelRequestFrame;
}

function requestDigest(frame: ModelRequestFrame): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				handle: frame.handle,
				intent: frame.intent,
				model: frame.model,
				context: frame.context,
				options: frame.options,
			}),
		)
		.digest("hex");
}

function usageFromEvent(value: unknown): ModelUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const event = value as { type?: unknown; message?: unknown; error?: unknown };
	if (event.type !== "done" && event.type !== "error") return undefined;
	const message = event.type === "done" ? event.message : event.error;
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const record = usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: unknown;
	};
	const cost = record.cost;
	if (!cost || typeof cost !== "object") return undefined;
	const totalCost = (cost as { total?: unknown }).total;
	if (
		![record.input, record.output, record.cacheRead, record.cacheWrite, totalCost].every(
			(number) => typeof number === "number" && Number.isFinite(number) && number >= 0,
		)
	)
		return undefined;
	return {
		inputTokens: (record.input as number) + (record.cacheRead as number) + (record.cacheWrite as number),
		outputTokens: record.output as number,
		costUsd: totalCost as number,
	};
}

function costUpperBound(
	model: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
	inputTokens: number,
	outputTokens: number,
	serviceTier: "default" | "flex" | "priority" | undefined,
): number {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	const inputRate = Math.max(...rates.map((rate) => Math.max(rate.input, rate.cacheRead, rate.cacheWrite)));
	const outputRate = Math.max(...rates.map((rate) => rate.output));
	const multiplier =
		serviceTier === "priority" ? (model.id === "gpt-5.5" ? 2.5 : 2) : serviceTier === "flex" ? 0.5 : 1;
	return ((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000) * multiplier;
}

export async function startModelRequestBroker(options: {
	authPath: string;
	modelsPath: string;
	allowedProviders: ReadonlySet<string>;
	/** Explicit transport seam for integration tests; production always uses the kernel-owned ModelRuntime. */
	runtime?: ModelRequestRuntime;
}): Promise<ModelRequestBroker> {
	const runtime =
		options.runtime ??
		(await ModelRuntime.create({
			authPath: options.authPath,
			modelsPath: options.modelsPath,
			allowModelNetwork: false,
		}));
	const sessions = new Set<BrokerSession>();
	const inFlight = new Map<string, InFlightRequest>();

	const revokeIntent = (session: BrokerSession, intent: IntentState, status: ModelIntentTerminalStatus): void => {
		if (intent.status !== "active") return;
		intent.status = status;
		clearTimeout(intent.expiryTimer);
		session.observe?.({
			event: "intent",
			intentNonce: intent.capability.nonce,
			requestHash: intent.capability.requestHash,
			status,
			usage: { ...intent.usage },
		});
		for (const request of inFlight.values()) {
			if (request.session === session && request.intent === intent) request.controller.abort();
		}
	};

	const deny = (send: (frame: object) => void, requestId: string): void => {
		send({ type: "qorpera_model_end", requestId, error: "kernel model request denied" });
	};

	const sendRequest = async (
		session: BrokerSession,
		frame: ModelRequestFrame,
		send: (frame: object) => void,
	): Promise<void> => {
		const provider = session.handles.get(frame.handle);
		const intent = session.intents.get(frame.intent.nonce);
		const model = provider ? runtime.getModel(provider, frame.model.id) : undefined;
		const parsedOptions = requestOptions(frame.options);
		const now = Date.now();
		const issuedAt = Date.parse(frame.intent.issuedAt);
		const expiresAt = Date.parse(frame.intent.expiresAt);
		const digest = requestDigest(frame);
		if (
			!provider ||
			provider !== frame.model.provider ||
			!intent ||
			intent.status !== "active" ||
			JSON.stringify(intent.capability) !== JSON.stringify(frame.intent) ||
			frame.intent.sessionId !== session.sessionId ||
			!Number.isFinite(issuedAt) ||
			!Number.isFinite(expiresAt) ||
			issuedAt > now + 5_000 ||
			expiresAt <= now ||
			expiresAt <= issuedAt ||
			expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS ||
			!model ||
			!parsedOptions ||
			inFlight.has(frame.requestId) ||
			session.seenRequestIds.has(frame.requestId) ||
			intent.requestDigests.has(digest)
		) {
			deny(send, frame.requestId);
			return;
		}
		session.seenRequestIds.add(frame.requestId);

		const inputTokens = serializedBytes(frame.context);
		const outputRemaining =
			intent.capability.budget.maxOutputTokens - intent.usage.outputTokens - intent.reserved.outputTokens;
		const requestedOutputTokens = parsedOptions.maxTokens ?? model.maxTokens;
		const outputTokens = Math.min(requestedOutputTokens, model.maxTokens, outputRemaining);
		const costUsd =
			inputTokens === undefined
				? Number.POSITIVE_INFINITY
				: costUpperBound(model, inputTokens, outputTokens, parsedOptions.serviceTier);
		if (
			intent.usage.calls >= intent.capability.budget.maxCalls ||
			inputTokens === undefined ||
			inputTokens >
				intent.capability.budget.maxInputTokens - intent.usage.inputTokens - intent.reserved.inputTokens ||
			outputTokens < 1 ||
			costUsd > intent.capability.budget.maxCostUsd - intent.usage.costUsd - intent.reserved.costUsd
		) {
			deny(send, frame.requestId);
			return;
		}

		const reservation = { inputTokens, outputTokens, costUsd };
		intent.usage.calls++;
		intent.reserved.inputTokens += reservation.inputTokens;
		intent.reserved.outputTokens += reservation.outputTokens;
		intent.reserved.costUsd += reservation.costUsd;
		intent.requestDigests.add(digest);
		const controller = new AbortController();
		const expiryTimer = setTimeout(() => revokeIntent(session, intent, "expired"), Math.max(1, expiresAt - now));
		inFlight.set(frame.requestId, { controller, session, intent, reservation, expiryTimer });
		session.observe?.({
			event: "request",
			intentNonce: frame.intent.nonce,
			requestHash: frame.intent.requestHash,
			provider,
			model: model.id,
			requestSha256: digest,
			status: "started",
			reservation: { ...reservation },
		});
		let terminalUsage: ModelUsage | undefined;
		let terminalStatus: ModelRequestObservation["status"] | undefined;
		let requestStatus: "completed" | "failed" | "aborted" = "failed";
		try {
			const stream = runtime.streamSimple(model, frame.context, {
				...parsedOptions,
				maxTokens: outputTokens,
				signal: controller.signal,
			});
			for await (const event of stream) {
				terminalUsage = usageFromEvent(event) ?? terminalUsage;
				if (event.type === "done") terminalStatus = "completed";
				if (event.type === "error") terminalStatus = event.reason === "aborted" ? "aborted" : "failed";
				send({ type: "qorpera_model_event", requestId: frame.requestId, event });
			}
			requestStatus = controller.signal.aborted
				? "aborted"
				: terminalStatus === "completed"
					? "completed"
					: "failed";
			send({
				type: "qorpera_model_end",
				requestId: frame.requestId,
				...(terminalStatus ? {} : { error: "kernel model execution ended without a terminal event" }),
			});
		} catch {
			requestStatus = controller.signal.aborted ? "aborted" : "failed";
			send({ type: "qorpera_model_end", requestId: frame.requestId, error: "kernel model execution failed" });
		} finally {
			clearTimeout(expiryTimer);
			inFlight.delete(frame.requestId);
			intent.reserved.inputTokens -= reservation.inputTokens;
			intent.reserved.outputTokens -= reservation.outputTokens;
			intent.reserved.costUsd -= reservation.costUsd;
			const charged =
				terminalStatus === "completed" && !controller.signal.aborted && terminalUsage ? terminalUsage : reservation;
			intent.usage.inputTokens += charged.inputTokens;
			intent.usage.outputTokens += charged.outputTokens;
			intent.usage.costUsd += charged.costUsd;
			session.observe?.({
				event: "request",
				intentNonce: frame.intent.nonce,
				requestHash: frame.intent.requestHash,
				provider,
				model: model.id,
				requestSha256: digest,
				status: requestStatus,
				reservation: { ...reservation },
				usage: { ...charged },
			});
			if (
				intent.usage.inputTokens > intent.capability.budget.maxInputTokens ||
				intent.usage.outputTokens > intent.capability.budget.maxOutputTokens ||
				intent.usage.costUsd > intent.capability.budget.maxCostUsd
			) {
				revokeIntent(session, intent, "budget_exhausted");
			}
			if (intent.status !== "active") {
				session.observe?.({
					event: "intent",
					intentNonce: intent.capability.nonce,
					requestHash: intent.capability.requestHash,
					status: intent.status,
					usage: { ...intent.usage },
				});
			}
		}
	};

	return {
		registerChild: (sessionId, sourceCredentials, ambientProviders, observe) => {
			if (!sessionId) throw new Error("model broker child requires a session id");
			const projection = brokerCredentialProjection(sourceCredentials, ambientProviders, options.allowedProviders);
			const session: BrokerSession = {
				sessionId,
				handles: projection.handles,
				intents: new Map(),
				seenRequestIds: new Set(),
				observe,
			};
			sessions.add(session);
			const handleFrame = (value: unknown, send: (frame: object) => void): boolean => {
				if (!value || typeof value !== "object") return false;
				const type = (value as { type?: unknown }).type;
				if (type === "qorpera_model_request") {
					const request = parsedRequest(value);
					if (request) void sendRequest(session, request, send);
					else {
						const requestId = (value as { requestId?: unknown }).requestId;
						if (typeof requestId === "string") deny(send, requestId);
					}
					return true;
				}
				if (type === "qorpera_model_abort") {
					const abort = value as Partial<ModelAbortFrame>;
					if (typeof abort.requestId === "string") {
						const request = inFlight.get(abort.requestId);
						if (request?.session === session) revokeIntent(session, request.intent, "aborted");
					}
					return true;
				}
				if (type === "qorpera_model_intent_end") {
					const end = value as Partial<ModelIntentEndFrame>;
					if (
						end.sessionId === session.sessionId &&
						typeof end.intentNonce === "string" &&
						end.status &&
						["completed", "aborted", "failed", "expired", "budget_exhausted"].includes(end.status)
					) {
						const intent = session.intents.get(end.intentNonce);
						if (intent) revokeIntent(session, intent, end.status);
					}
					return true;
				}
				return false;
			};
			return {
				handles: Object.fromEntries([...projection.handles].map(([handle, provider]) => [provider, handle])),
				credentials: projection.credentials,
				authorizeIntent: (capability) => {
					const issuedAt = Date.parse(capability.issuedAt);
					const expiresAt = Date.parse(capability.expiresAt);
					const now = Date.now();
					if (
						!validIntent(capability) ||
						capability.sessionId !== session.sessionId ||
						session.intents.has(capability.nonce) ||
						!Number.isFinite(issuedAt) ||
						!Number.isFinite(expiresAt) ||
						issuedAt > now + 5_000 ||
						expiresAt <= now ||
						expiresAt <= issuedAt ||
						expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS
					)
						return false;
					let intent: IntentState | undefined;
					const expiryTimer = setTimeout(
						() => {
							if (intent) revokeIntent(session, intent, "expired");
						},
						Math.max(1, expiresAt - now),
					);
					intent = {
						capability: { ...capability, budget: { ...capability.budget } },
						status: "active" as const,
						usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
						reserved: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
						requestDigests: new Set<string>(),
						expiryTimer,
					};
					session.intents.set(capability.nonce, intent);
					return true;
				},
				handleFrame,
				endTurn: (status) => {
					for (const intent of session.intents.values()) revokeIntent(session, intent, status);
				},
				release: () => {
					for (const intent of session.intents.values()) revokeIntent(session, intent, "aborted");
					for (const [requestId, request] of inFlight) {
						if (request.session === session) {
							request.controller.abort();
							clearTimeout(request.expiryTimer);
							inFlight.delete(requestId);
						}
					}
					session.intents.clear();
					session.seenRequestIds.clear();
					sessions.delete(session);
				},
			};
		},
		close: () => {
			for (const request of inFlight.values()) {
				request.controller.abort();
				clearTimeout(request.expiryTimer);
			}
			inFlight.clear();
			for (const session of sessions) {
				for (const intent of session.intents.values()) {
					clearTimeout(intent.expiryTimer);
					intent.status = "aborted";
				}
				session.intents.clear();
			}
			sessions.clear();
		},
	};
}
