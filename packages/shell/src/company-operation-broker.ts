/** Desktop-host boundary for transactional agent-owned company operations. */

import { createHash } from "node:crypto";
import {
	COMPANY_OPERATION_KINDS,
	type CompanyOperationKind,
	type ExecutionIdentity,
	type ExecutionIntentCapability,
} from "@qorpera/contracts";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_OPERATIONS_PER_TURN = 32;

interface CompanyOperationRequestFrame {
	type: "qorpera_company_operation_request";
	requestId: string;
	kind: CompanyOperationKind;
	input: unknown;
	intent: ExecutionIntentCapability;
}

interface IntentState {
	capability: ExecutionIntentCapability;
	operations: number;
	status: "active" | "ended";
	expiryTimer: NodeJS.Timeout;
}

export interface CompanyOperationBroker {
	authorizeIntent: (capability: ExecutionIntentCapability) => boolean;
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	endTurn: () => void;
	release: () => void;
}

export type CompanyOperationReceiptBegin =
	| { started: true; status: "executing" }
	| { started: false; status: "executing" }
	| { started: false; status: "completed"; result: { message: string } };

function validIntent(value: unknown): value is ExecutionIntentCapability {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const intent = value as Record<string, unknown>;
	const execution = intent.execution;
	return (
		typeof intent.nonce === "string" &&
		REQUEST_ID_PATTERN.test(intent.nonce) &&
		typeof intent.sessionId === "string" &&
		typeof intent.requestHash === "string" &&
		typeof intent.attended === "boolean" &&
		typeof intent.issuedAt === "string" &&
		typeof intent.expiresAt === "string" &&
		typeof intent.signature === "string" &&
		(execution === undefined ||
			(!!execution &&
				typeof execution === "object" &&
				!Array.isArray(execution) &&
				((execution as { kind?: unknown }).kind === "turn" || (execution as { kind?: unknown }).kind === "wake") &&
				typeof (execution as { id?: unknown }).id === "string" &&
				REQUEST_ID_PATTERN.test((execution as { id: string }).id) &&
				typeof (execution as { claimantId?: unknown }).claimantId === "string" &&
				REQUEST_ID_PATTERN.test((execution as { claimantId: string }).claimantId))) &&
		!!intent.budget &&
		typeof intent.budget === "object"
	);
}

function requestFrame(value: unknown): CompanyOperationRequestFrame | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const frame = value as Record<string, unknown>;
	if (
		Object.keys(frame).some((key) => !["type", "requestId", "kind", "input", "intent"].includes(key)) ||
		frame.type !== "qorpera_company_operation_request" ||
		typeof frame.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(frame.requestId) ||
		typeof frame.kind !== "string" ||
		!COMPANY_OPERATION_KINDS.includes(frame.kind as CompanyOperationKind) ||
		!validIntent(frame.intent)
	) {
		return undefined;
	}
	return frame as unknown as CompanyOperationRequestFrame;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return "null";
}

function inputSha256(kind: CompanyOperationKind, input: unknown): string {
	return createHash("sha256")
		.update(`${kind}\0${canonicalJson(input)}`)
		.digest("hex");
}

export function createCompanyOperationBroker(options: {
	sessionId: string;
	requireDurableExecution?: boolean;
	execution: () => ExecutionIdentity | undefined;
	beginReceipt: (
		execution: ExecutionIdentity,
		operationId: string,
		operationKind: CompanyOperationKind,
		inputSha256: string,
	) => Promise<CompanyOperationReceiptBegin>;
	completeReceipt: (
		execution: ExecutionIdentity,
		operationId: string,
		result: { message: string },
	) => Promise<{ message: string }>;
	apply: (kind: CompanyOperationKind, input: unknown) => Promise<{ message: string }>;
}): CompanyOperationBroker {
	const intents = new Map<string, IntentState>();
	const requestIds = new Set<string>();
	let released = false;
	const retryReceipt = async <T>(operation: () => Promise<T>, phase: string): Promise<T> => {
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			if (released) throw new Error(`durable company operation ${phase} stopped with the host`);
			try {
				return await operation();
			} catch (error) {
				lastError = error;
				if (attempt < 4) {
					await new Promise<void>((resolvePromise) => {
						setTimeout(resolvePromise, 100 * 2 ** attempt);
					});
				}
			}
		}
		throw new Error(
			`durable company operation ${phase} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	};

	const endIntent = (intent: IntentState): void => {
		if (intent.status !== "active") return;
		intent.status = "ended";
		clearTimeout(intent.expiryTimer);
	};

	return {
		authorizeIntent: (capability) => {
			if (released || !validIntent(capability)) return false;
			const now = Date.now();
			const issuedAt = Date.parse(capability.issuedAt);
			const expiresAt = Date.parse(capability.expiresAt);
			if (
				capability.sessionId !== options.sessionId ||
				intents.has(capability.nonce) ||
				!Number.isFinite(issuedAt) ||
				!Number.isFinite(expiresAt) ||
				issuedAt > now + 5_000 ||
				expiresAt <= now ||
				expiresAt <= issuedAt ||
				expiresAt - issuedAt > MAX_INTENT_LIFETIME_MS
			) {
				return false;
			}
			const state: IntentState = {
				capability: JSON.parse(JSON.stringify(capability)) as ExecutionIntentCapability,
				operations: 0,
				status: "active",
				expiryTimer: setTimeout(() => endIntent(state), Math.max(1, expiresAt - now)),
			};
			state.expiryTimer.unref?.();
			intents.set(capability.nonce, state);
			return true;
		},
		handleFrame: (value, send) => {
			if (!value || typeof value !== "object") return false;
			if ((value as { type?: unknown }).type !== "qorpera_company_operation_request") return false;
			if (released) return true;
			const frame = requestFrame(value);
			if (!frame) {
				const requestId = (value as { requestId?: unknown }).requestId;
				if (typeof requestId === "string") {
					send({ type: "qorpera_company_operation_response", requestId, error: "invalid company operation" });
				}
				return true;
			}
			const intent = intents.get(frame.intent.nonce);
			if (
				requestIds.has(frame.requestId) ||
				!intent ||
				intent.status !== "active" ||
				JSON.stringify(intent.capability) !== JSON.stringify(frame.intent) ||
				frame.intent.sessionId !== options.sessionId ||
				Date.parse(frame.intent.expiresAt) <= Date.now() ||
				intent.operations >= MAX_OPERATIONS_PER_TURN
			) {
				send({
					type: "qorpera_company_operation_response",
					requestId: frame.requestId,
					error: "company operation denied: no verified causal intent for this turn",
				});
				return true;
			}
			const liveExecution = options.execution();
			const intentExecution = intent.capability.execution;
			if (options.requireDurableExecution && !intentExecution) {
				send({
					type: "qorpera_company_operation_response",
					requestId: frame.requestId,
					error: "company operation denied: cloud execution has no durable lease",
				});
				return true;
			}
			if (
				(liveExecution && !intentExecution) ||
				(intentExecution && JSON.stringify(intentExecution) !== JSON.stringify(liveExecution))
			) {
				send({
					type: "qorpera_company_operation_response",
					requestId: frame.requestId,
					error: "company operation denied: durable execution ownership changed",
				});
				return true;
			}
			requestIds.add(frame.requestId);
			intent.operations++;
			void (async () => {
				if (!intentExecution) return options.apply(frame.kind, frame.input);
				const receipt = await retryReceipt(
					() =>
						options.beginReceipt(
							intentExecution,
							frame.requestId,
							frame.kind,
							inputSha256(frame.kind, frame.input),
						),
					"reservation",
				);
				if (receipt.status === "completed") return receipt.result;
				if (!receipt.started) {
					throw new Error("company operation has an ambiguous prior outcome and requires review");
				}
				const result = await options.apply(frame.kind, frame.input);
				return retryReceipt(
					() => options.completeReceipt(intentExecution, frame.requestId, result),
					"acknowledgement",
				);
			})()
				.then((result) =>
					send({
						type: "qorpera_company_operation_response",
						requestId: frame.requestId,
						message: result.message,
					}),
				)
				.catch((error) =>
					send({
						type: "qorpera_company_operation_response",
						requestId: frame.requestId,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			return true;
		},
		endTurn: () => {
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
		},
		release: () => {
			released = true;
			for (const intent of intents.values()) endIntent(intent);
			intents.clear();
		},
	};
}
