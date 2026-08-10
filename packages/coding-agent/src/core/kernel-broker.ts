import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";

export type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";

interface KernelGateResponse {
	type: "qorpera_kernel_response";
	requestId: string;
	file: string;
	hash: string;
	granted: boolean;
	signature: string;
}

interface KernelBindingResponse {
	type: "qorpera_kernel_binding";
	nonce: string;
	sessionId: string;
	signature: string;
}

interface PendingGateRequest {
	file: string;
	hash: string;
	resolve: (granted: boolean) => void;
	timer: NodeJS.Timeout;
}

const pendingGateRequests = new Map<string, PendingGateRequest>();
const trustedGateHashes = new Set<string>();
const consumedIntentNonces = new Set<string>();
const publicKeyDer = process.env.QORPERA_KERNEL_PUBLIC_KEY;
const kernelPublicKey = publicKeyDer
	? createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" })
	: undefined;
let kernelBindingNonce: string | undefined;
let kernelBindingSessionId: string | undefined;
let kernelBindingEstablished = false;
let kernelBindingTimer: NodeJS.Timeout | undefined;

type KernelPublicKey = NonNullable<typeof kernelPublicKey>;

function responsePayload(response: Omit<KernelGateResponse, "type" | "signature">): string {
	return JSON.stringify({
		requestId: response.requestId,
		file: response.file,
		hash: response.hash,
		granted: response.granted,
	});
}

function bindingPayload(response: Omit<KernelBindingResponse, "type" | "signature">): string {
	return JSON.stringify({ nonce: response.nonce, sessionId: response.sessionId });
}

export function beginKernelBinding(sessionId: string): void {
	if (process.env.QORPERA_KERNEL_REQUIRED !== "1" || kernelBindingEstablished || kernelBindingNonce) return;
	const token = process.env.QORPERA_TRAIL_BROKER_TOKEN;
	if (!token || !kernelPublicKey || !sessionId) return;
	kernelBindingNonce = randomUUID();
	kernelBindingSessionId = sessionId;
	process.stdout.write(
		`${JSON.stringify({
			type: "qorpera_kernel_challenge",
			token,
			nonce: kernelBindingNonce,
			sessionId,
		})}\n`,
	);
	kernelBindingTimer = setTimeout(() => {
		process.stderr.write("Qorpera Base kernel binding timed out\n");
		process.exit(1);
	}, 10_000);
}

export function isKernelBindingEstablished(): boolean {
	return process.env.QORPERA_KERNEL_REQUIRED !== "1" || kernelBindingEstablished;
}

function intentPayload(intent: Omit<KernelIntentCapability, "signature">): string {
	return JSON.stringify({
		nonce: intent.nonce,
		sessionId: intent.sessionId,
		requestHash: intent.requestHash,
		attended: intent.attended,
		issuedAt: intent.issuedAt,
		expiresAt: intent.expiresAt,
		budget: {
			maxCalls: intent.budget.maxCalls,
			maxInputTokens: intent.budget.maxInputTokens,
			maxOutputTokens: intent.budget.maxOutputTokens,
			maxCostUsd: intent.budget.maxCostUsd,
		},
	});
}

const MAX_MODEL_INTENT_LIFETIME_MS = 4 * 60 * 60 * 1000;

function validBudget(value: unknown): value is KernelModelIntentBudget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const budget = value as Partial<KernelModelIntentBudget>;
	return (
		Object.keys(value).length === 4 &&
		Number.isInteger(budget.maxCalls) &&
		budget.maxCalls! > 0 &&
		Number.isInteger(budget.maxInputTokens) &&
		budget.maxInputTokens! > 0 &&
		Number.isInteger(budget.maxOutputTokens) &&
		budget.maxOutputTokens! > 0 &&
		typeof budget.maxCostUsd === "number" &&
		Number.isFinite(budget.maxCostUsd) &&
		budget.maxCostUsd >= 0
	);
}

function verifyKernelIntent(
	frame: Record<string, unknown>,
	publicKey: KernelPublicKey,
	consumedNonces: Set<string>,
): KernelIntentCapability | undefined {
	const candidate = frame.kernelIntent;
	if (!candidate || typeof candidate !== "object") return undefined;
	const intent = candidate as Partial<KernelIntentCapability>;
	if (
		typeof intent.nonce !== "string" ||
		typeof intent.sessionId !== "string" ||
		intent.sessionId.length === 0 ||
		typeof intent.requestHash !== "string" ||
		typeof intent.attended !== "boolean" ||
		typeof intent.issuedAt !== "string" ||
		typeof intent.expiresAt !== "string" ||
		!validBudget(intent.budget) ||
		typeof intent.signature !== "string" ||
		consumedNonces.has(intent.nonce)
	)
		return undefined;
	const issuedAt = Date.parse(intent.issuedAt);
	const expiresAt = Date.parse(intent.expiresAt);
	const now = Date.now();
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(expiresAt) ||
		issuedAt > now + 5_000 ||
		expiresAt <= now ||
		expiresAt <= issuedAt ||
		expiresAt - issuedAt > MAX_MODEL_INTENT_LIFETIME_MS
	)
		return undefined;
	const unsignedFrame = { ...frame };
	delete unsignedFrame.kernelIntent;
	if (createHash("sha256").update(JSON.stringify(unsignedFrame)).digest("hex") !== intent.requestHash)
		return undefined;
	const valid = verify(
		null,
		Buffer.from(
			intentPayload({
				nonce: intent.nonce,
				sessionId: intent.sessionId,
				requestHash: intent.requestHash,
				attended: intent.attended,
				issuedAt: intent.issuedAt,
				expiresAt: intent.expiresAt,
				budget: intent.budget,
			}),
		),
		publicKey,
		Buffer.from(intent.signature, "base64"),
	);
	if (!valid) return undefined;
	consumedNonces.add(intent.nonce);
	return intent as KernelIntentCapability;
}

export function verifyKernelIntentCapability(
	frame: Record<string, unknown>,
	publicKey: string,
	consumedNonces: Set<string>,
): KernelIntentCapability | undefined {
	return verifyKernelIntent(
		frame,
		createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
		consumedNonces,
	);
}

export function consumeKernelIntent(frame: Record<string, unknown>): KernelIntentCapability | undefined {
	return kernelPublicKey ? verifyKernelIntent(frame, kernelPublicKey, consumedIntentNonces) : undefined;
}

export function requestKernelGateConsumption(file: string, hash: string): Promise<boolean> {
	const token = process.env.QORPERA_TRAIL_BROKER_TOKEN;
	if (!token || !kernelPublicKey) return Promise.resolve(false);
	const requestId = randomUUID();
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => {
			pendingGateRequests.delete(requestId);
			resolvePromise(false);
		}, 30_000);
		pendingGateRequests.set(requestId, { file, hash, resolve: resolvePromise, timer });
		process.stdout.write(
			`${JSON.stringify({
				type: "qorpera_kernel_write",
				token,
				operation: "consume_gate",
				requestId,
				file,
				hash,
				status: "consumed",
			})}\n`,
		);
	});
}

export function hasKernelGateTrust(hash: string): boolean {
	return trustedGateHashes.has(hash);
}

/** Establish process-local durable trust through a kernel-consumed approval. */
export async function requestKernelGateTrust(file: string, hash: string): Promise<boolean> {
	if (trustedGateHashes.has(hash)) return true;
	const granted = await requestKernelGateConsumption(file, hash);
	if (granted) trustedGateHashes.add(hash);
	return granted;
}

export function requestKernelMessageCreation(file: string, content: string): Promise<boolean> {
	const token = process.env.QORPERA_TRAIL_BROKER_TOKEN;
	if (!token || !kernelPublicKey) return Promise.resolve(false);
	const requestId = randomUUID();
	const hash = createHash("sha256").update(content).digest("hex");
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => {
			pendingGateRequests.delete(requestId);
			resolvePromise(false);
		}, 30_000);
		pendingGateRequests.set(requestId, { file, hash, resolve: resolvePromise, timer });
		process.stdout.write(
			`${JSON.stringify({
				type: "qorpera_kernel_write",
				token,
				operation: "create_message",
				requestId,
				file,
				hash,
				content,
			})}\n`,
		);
	});
}

export function handleKernelBrokerResponse(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return false;
	}
	if (value.type === "qorpera_kernel_binding") {
		const response = value as Partial<KernelBindingResponse>;
		if (
			kernelPublicKey &&
			typeof response.nonce === "string" &&
			typeof response.sessionId === "string" &&
			response.nonce === kernelBindingNonce &&
			response.sessionId === kernelBindingSessionId &&
			typeof response.signature === "string" &&
			verify(
				null,
				Buffer.from(bindingPayload({ nonce: response.nonce, sessionId: response.sessionId })),
				kernelPublicKey,
				Buffer.from(response.signature, "base64"),
			)
		) {
			kernelBindingEstablished = true;
			kernelBindingNonce = undefined;
			kernelBindingSessionId = undefined;
			if (kernelBindingTimer) clearTimeout(kernelBindingTimer);
			kernelBindingTimer = undefined;
		}
		return true;
	}
	if (value.type !== "qorpera_kernel_response") return false;
	const response = value as Partial<KernelGateResponse>;
	if (
		!kernelPublicKey ||
		typeof response.requestId !== "string" ||
		typeof response.file !== "string" ||
		typeof response.hash !== "string" ||
		typeof response.granted !== "boolean" ||
		typeof response.signature !== "string"
	) {
		return true;
	}
	const pending = pendingGateRequests.get(response.requestId);
	if (!pending || pending.file !== response.file || pending.hash !== response.hash) return true;
	const valid = verify(
		null,
		Buffer.from(
			responsePayload({
				requestId: response.requestId,
				file: response.file,
				hash: response.hash,
				granted: response.granted,
			}),
		),
		kernelPublicKey,
		Buffer.from(response.signature, "base64"),
	);
	if (!valid) return true;
	clearTimeout(pending.timer);
	pendingGateRequests.delete(response.requestId);
	pending.resolve(response.granted);
	return true;
}
