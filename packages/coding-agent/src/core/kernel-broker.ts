import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";

interface KernelGateResponse {
	type: "qorpera_kernel_response";
	requestId: string;
	file: string;
	hash: string;
	granted: boolean;
	signature: string;
}

interface PendingGateRequest {
	file: string;
	hash: string;
	resolve: (granted: boolean) => void;
	timer: NodeJS.Timeout;
}

export interface KernelIntentCapability {
	nonce: string;
	requestHash: string;
	attended: boolean;
	expiresAt: string;
	signature: string;
}

const pendingGateRequests = new Map<string, PendingGateRequest>();
const consumedIntentNonces = new Set<string>();
const publicKeyDer = process.env.QORPERA_KERNEL_PUBLIC_KEY;
const kernelPublicKey = publicKeyDer
	? createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" })
	: undefined;

type KernelPublicKey = NonNullable<typeof kernelPublicKey>;

function responsePayload(response: Omit<KernelGateResponse, "type" | "signature">): string {
	return JSON.stringify({
		requestId: response.requestId,
		file: response.file,
		hash: response.hash,
		granted: response.granted,
	});
}

function intentPayload(intent: Omit<KernelIntentCapability, "signature">): string {
	return JSON.stringify({
		nonce: intent.nonce,
		requestHash: intent.requestHash,
		attended: intent.attended,
		expiresAt: intent.expiresAt,
	});
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
		typeof intent.requestHash !== "string" ||
		typeof intent.attended !== "boolean" ||
		typeof intent.expiresAt !== "string" ||
		typeof intent.signature !== "string" ||
		consumedNonces.has(intent.nonce)
	)
		return undefined;
	const expiresAt = Date.parse(intent.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || expiresAt > Date.now() + 60_000) return undefined;
	const unsignedFrame = { ...frame };
	delete unsignedFrame.kernelIntent;
	if (createHash("sha256").update(JSON.stringify(unsignedFrame)).digest("hex") !== intent.requestHash)
		return undefined;
	const valid = verify(
		null,
		Buffer.from(
			intentPayload({
				nonce: intent.nonce,
				requestHash: intent.requestHash,
				attended: intent.attended,
				expiresAt: intent.expiresAt,
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

export function handleKernelBrokerResponse(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("type" in value) || value.type !== "qorpera_kernel_response") {
		return false;
	}
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
