/**
 * Child side of the kernel HTTP lane (Build 3 — generic connectivity).
 *
 * The sandboxed child has no network. Outbound HTTP requests travel as
 * frames over the existing kernel pipe: the child writes a
 * `qorpera_http_request` frame carrying the request WITH opaque
 * `secret://<name>` references intact; the kernel checks the destination
 * against founder-bound capabilities, dereferences the references at the
 * trusted boundary, executes, records the attempt in the trail, and
 * returns one `qorpera_http_response` frame. Raw secret values never
 * exist in this process.
 */

import { randomUUID } from "node:crypto";

const MAX_HTTP_REQUEST_BYTES = 2 * 1024 * 1024;

export interface HttpBrokerRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	/** Acting company-authored code, when the request comes from codified behavior. */
	behavior?: { path: string; contentHash: string };
}

export interface HttpBrokerResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	bodyBytes: number;
	bodyTruncated?: boolean;
}

interface PendingRequest {
	resolve: (response: HttpBrokerResponse) => void;
	reject: (error: Error) => void;
}

const pending = new Map<string, PendingRequest>();
let writeFrame: ((frame: object) => void) | undefined;

export function setHttpBrokerWriter(writer: (frame: object) => void): void {
	writeFrame = writer;
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
		const requestId = randomUUID();
		const frame = { type: "qorpera_http_request", requestId, ...request };
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
	});
	return true;
}
