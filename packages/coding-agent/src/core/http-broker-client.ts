/**
 * Child side of the kernel HTTP lane (Build 3 — generic connectivity).
 *
 * This optional auditable lane carries outbound HTTP requests as frames over
 * the existing kernel pipe: the host-capable child writes a
 * `qorpera_http_request` frame carrying the request WITH opaque
 * `secret://<name>` references intact; the kernel checks the destination
 * against founder-bound capabilities, dereferences the references at the
 * trusted boundary, executes, records the attempt in the trail, and
 * returns one `qorpera_http_response` frame. Raw secret values used through
 * this lane never exist in the child process.
 */

import { randomUUID } from "node:crypto";
import type { KernelIntentCapability } from "@qorpera/pi-protocol";
import { isModelBrokerInstalled } from "./model-broker-client.ts";

const MAX_HTTP_REQUEST_BYTES = 2 * 1024 * 1024;

export interface HttpBrokerRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	/** Acting company-authored code, when the request comes from codified behavior. */
	behavior?: { path: string; contentHash: string };
	/** File mode: stream the 2xx response into this company-relative path. */
	saveTo?: string;
	/** File mode: stream this company-relative file out as the request body. */
	sendFile?: string;
}

export interface HttpBrokerResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	bodyBytes: number;
	bodyTruncated?: boolean;
	/** File mode: where the kernel streamed the response, with its digest. */
	savedTo?: string;
	sha256?: string;
}

interface PendingRequest {
	resolve: (response: HttpBrokerResponse) => void;
	reject: (error: Error) => void;
}

const pending = new Map<string, PendingRequest>();
let writeFrame: ((frame: object) => void) | undefined;
let activeIntent: KernelIntentCapability | undefined;

export function setHttpBrokerWriter(writer: (frame: object) => void): void {
	writeFrame = writer;
}

/**
 * Scope the verified founder/kernel causal intent to the current turn —
 * the same capability the model lane rides. Outbound requests without an
 * active intent are refused under the kernel (parity with the model lane).
 */
export function setHttpBrokerIntent(intent: KernelIntentCapability | undefined): void {
	activeIntent = intent;
}

export function isHttpBrokerAvailable(): boolean {
	return writeFrame !== undefined;
}

/** Send one outbound request through the kernel; resolves with the kernel's single response frame. */
export function brokeredHttpRequest(request: HttpBrokerRequest, signal?: AbortSignal): Promise<HttpBrokerResponse> {
	return new Promise((resolve, reject) => {
		if (!writeFrame) {
			reject(new Error("http_request requires the kernel broker (company sessions under the desktop kernel)"));
			return;
		}
		if (isModelBrokerInstalled() && !activeIntent) {
			reject(new Error("kernel http request has no verified causal intent for this turn"));
			return;
		}
		const requestId = randomUUID();
		const frame = { type: "qorpera_http_request", requestId, ...request, intent: activeIntent };
		let serialized: string;
		try {
			serialized = JSON.stringify(frame);
		} catch {
			reject(new Error("kernel http request is not serializable"));
			return;
		}
		if (Buffer.byteLength(serialized, "utf-8") > MAX_HTTP_REQUEST_BYTES) {
			reject(new Error("kernel http request exceeds 2 MiB"));
			return;
		}
		const settle = (action: () => void): void => {
			pending.delete(requestId);
			action();
		};
		pending.set(requestId, {
			resolve: (response) => settle(() => resolve(response)),
			reject: (error) => settle(() => reject(error)),
		});
		if (signal) {
			const onAbort = (): void => {
				const entry = pending.get(requestId);
				entry?.reject(new Error("Operation aborted"));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		writeFrame(frame);
	});
}

/** Consume kernel-originated http response frames from RPC stdin. */
export function handleHttpBrokerFrame(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const frame = value as {
		type?: unknown;
		requestId?: unknown;
		status?: unknown;
		headers?: unknown;
		body?: unknown;
		bodyBytes?: unknown;
		bodyTruncated?: unknown;
		savedTo?: unknown;
		sha256?: unknown;
		error?: unknown;
	};
	if (frame.type !== "qorpera_http_response") return false;
	if (typeof frame.requestId !== "string") return true;
	const entry = pending.get(frame.requestId);
	if (!entry) return true;
	if (typeof frame.error === "string") {
		entry.reject(new Error(frame.error));
		return true;
	}
	if (
		typeof frame.status !== "number" ||
		typeof frame.body !== "string" ||
		!frame.headers ||
		typeof frame.headers !== "object"
	) {
		entry.reject(new Error("kernel http response frame is invalid"));
		return true;
	}
	entry.resolve({
		status: frame.status,
		headers: frame.headers as Record<string, string>,
		body: frame.body,
		bodyBytes: typeof frame.bodyBytes === "number" ? frame.bodyBytes : Buffer.byteLength(frame.body, "utf-8"),
		...(frame.bodyTruncated === true ? { bodyTruncated: true } : {}),
		...(typeof frame.savedTo === "string" ? { savedTo: frame.savedTo } : {}),
		...(typeof frame.sha256 === "string" ? { sha256: frame.sha256 } : {}),
	});
	return true;
}
