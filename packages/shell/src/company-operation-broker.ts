/** Desktop-host boundary for transactional agent-owned company operations. */

import { COMPANY_OPERATION_KINDS, type CompanyOperationKind } from "@qorpera/pi-coding-agent/company-operation-broker";
import type { KernelIntentCapability } from "@qorpera/pi-protocol";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MAX_OPERATIONS_PER_TURN = 32;

interface CompanyOperationRequestFrame {
	type: "qorpera_company_operation_request";
	requestId: string;
	kind: CompanyOperationKind;
	input: unknown;
	intent: KernelIntentCapability;
}

interface IntentState {
	capability: KernelIntentCapability;
	operations: number;
	status: "active" | "ended";
	expiryTimer: NodeJS.Timeout;
}

export interface CompanyOperationBroker {
	authorizeIntent: (capability: KernelIntentCapability) => boolean;
	handleFrame: (value: unknown, send: (frame: object) => void) => boolean;
	endTurn: () => void;
	release: () => void;
}

function validIntent(value: unknown): value is KernelIntentCapability {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const intent = value as Record<string, unknown>;
	return (
		typeof intent.nonce === "string" &&
		REQUEST_ID_PATTERN.test(intent.nonce) &&
		typeof intent.sessionId === "string" &&
		typeof intent.requestHash === "string" &&
		typeof intent.attended === "boolean" &&
		typeof intent.issuedAt === "string" &&
		typeof intent.expiresAt === "string" &&
		typeof intent.signature === "string" &&
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

export function createCompanyOperationBroker(options: {
	sessionId: string;
	apply: (kind: CompanyOperationKind, input: unknown) => Promise<{ message: string }>;
}): CompanyOperationBroker {
	const intents = new Map<string, IntentState>();
	const requestIds = new Set<string>();
	let released = false;

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
				capability: JSON.parse(JSON.stringify(capability)) as KernelIntentCapability,
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
			requestIds.add(frame.requestId);
			intent.operations++;
			void options
				.apply(frame.kind, frame.input)
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
