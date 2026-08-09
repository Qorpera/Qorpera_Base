import { createPublicKey, randomUUID, verify } from "node:crypto";

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

const pendingGateRequests = new Map<string, PendingGateRequest>();
const publicKeyDer = process.env.QORPERA_KERNEL_PUBLIC_KEY;
const kernelPublicKey = publicKeyDer
	? createPublicKey({ key: Buffer.from(publicKeyDer, "base64"), format: "der", type: "spki" })
	: undefined;

function responsePayload(response: Omit<KernelGateResponse, "type" | "signature">): string {
	return JSON.stringify({
		requestId: response.requestId,
		file: response.file,
		hash: response.hash,
		granted: response.granted,
	});
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
