import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const BASE64URL_32_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export function isValidBase64UrlToken(value: string): boolean {
	if (!BASE64URL_32_TOKEN.test(value)) return false;
	const decoded = Buffer.from(value, "base64url");
	return decoded.length === 32 && decoded.toString("base64url") === value;
}

export function bearerTokenMatches(expected: string, authorization: string | undefined): boolean {
	if (!authorization?.startsWith("Bearer ")) return false;
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(authorization.slice("Bearer ".length), "utf8");
	try {
		return left.byteLength === right.byteLength && timingSafeEqual(left, right);
	} finally {
		left.fill(0);
		right.fill(0);
	}
}

export function parseTrustedOrigin(value: string, allowLoopback: boolean, errorMessage: string): string {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(errorMessage);
	return url.origin;
}

export async function readBoundedJsonBody(
	request: IncomingMessage,
	options: {
		maxBytes: number;
		signal?: AbortSignal;
		timeoutMs?: number;
		timeoutError?: string;
		tooLargeError?: string;
		checkContentLength?: boolean;
		zeroize?: boolean;
	},
): Promise<unknown> {
	const tooLarge = options.tooLargeError ?? "Request body is too large";
	if (options.checkContentLength) {
		const declared = request.headers["content-length"];
		if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > options.maxBytes))
			throw new Error(tooLarge);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	let body: Buffer | undefined;
	const signal = options.signal;
	const abort = (): void => {
		request.destroy();
	};
	signal?.addEventListener("abort", abort, { once: true });
	const timeout =
		options.timeoutMs !== undefined
			? setTimeout(() => request.destroy(new Error(options.timeoutError ?? "Request timed out")), options.timeoutMs)
			: undefined;
	try {
		for await (const chunkValue of request) {
			signal?.throwIfAborted();
			const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
			total += chunk.byteLength;
			if (total > options.maxBytes) {
				if (options.zeroize) chunk.fill(0);
				throw new Error(tooLarge);
			}
			chunks.push(chunk);
		}
		body = Buffer.concat(chunks, total);
		return JSON.parse(UTF8_FATAL.decode(body)) as unknown;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
		if (options.zeroize) {
			body?.fill(0);
			for (const chunk of chunks) chunk.fill(0);
		}
	}
}

export function writeJsonResponse(
	reply: ServerResponse,
	status: number,
	value: unknown,
	options?: {
		maxBytes?: number;
		maxBytesError?: string;
		headers?: Record<string, string>;
		closeUnread?: boolean;
		includeNoSniff?: boolean;
	},
): void {
	const body = JSON.stringify(value);
	const byteLength = Buffer.byteLength(body);
	if (options?.maxBytes !== undefined && byteLength > options.maxBytes) {
		throw new Error(options.maxBytesError ?? "Response body is too large");
	}
	let closeUnread = false;
	if (options?.closeUnread) {
		const contentLength = reply.req.headers["content-length"];
		const hasBody =
			(contentLength !== undefined && contentLength !== "0") || reply.req.headers["transfer-encoding"] !== undefined;
		closeUnread = hasBody && !reply.req.complete;
	}
	reply.writeHead(status, {
		"content-type": "application/json",
		"content-length": byteLength,
		"cache-control": "no-store",
		...(options?.includeNoSniff === false ? {} : { "x-content-type-options": "nosniff" }),
		...(closeUnread ? { connection: "close" } : {}),
		...options?.headers,
	});
	reply.end(body);
}
