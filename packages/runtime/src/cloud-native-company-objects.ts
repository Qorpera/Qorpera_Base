import { createHash } from "node:crypto";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudNativeToolBinding,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 8 * 1024 * 1024;

/** Host-only immutable transport. The model sees logical path tools, not this
 * object route, its binding, or its independently provisioned credential. */
export class HttpNativeCompanyObjectTransport implements CloudObjectTransport {
	readonly #origin: string;
	readonly #token: string;
	readonly #companyId: string;
	readonly #binding: string;
	readonly #signal: AbortSignal;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: {
		baseUrl: string;
		token: string;
		companyId: string;
		binding: CloudNativeToolBinding;
		signal: AbortSignal;
		fetch?: typeof fetch;
		timeoutMs?: number;
	}) {
		const url = new URL(options.baseUrl);
		if (
			(url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!UUID.test(options.companyId) ||
			!/^[A-Za-z0-9_-]{43}$/.test(options.token)
		)
			throw new Error("Invalid native Company File object transport");
		this.#origin = url.origin;
		this.#token = options.token;
		this.#companyId = options.companyId;
		this.#binding = Buffer.from(JSON.stringify(parseCloudNativeToolBinding(options.binding))).toString("base64url");
		this.#signal = options.signal;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 8000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 30_000)
			throw new Error("Invalid native object deadline");
	}

	async put(path: string, bytes: Uint8Array, mediaType: string): Promise<"stored" | "exists"> {
		const hash = this.#hash(path);
		if (
			bytes.byteLength > MAX_BYTES ||
			createHash("sha256").update(bytes).digest("hex") !== hash ||
			!mediaType ||
			mediaType.length > 256 ||
			/[\0\r\n]/.test(mediaType)
		)
			throw new Error("Invalid native immutable object");
		const { status, body } = await this.#request(
			path,
			{
				method: "PUT",
				body: Uint8Array.from(bytes),
				headers: { "content-type": mediaType, "content-length": String(bytes.byteLength) },
			},
			4096,
		);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		} catch {
			throw new Error("Invalid native object receipt");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native object receipt");
		const receipt = value as Record<string, unknown>;
		if (
			Object.keys(receipt).some((key) => !["status", "sha256", "bytes", "replication"].includes(key)) ||
			receipt.sha256 !== hash ||
			receipt.bytes !== bytes.byteLength ||
			receipt.replication !== "pending" ||
			!((status === 201 && receipt.status === "stored") || (status === 200 && receipt.status === "exists"))
		)
			throw new Error("Invalid native object receipt");
		return receipt.status as "stored" | "exists";
	}

	async get(path: string): Promise<Uint8Array> {
		const hash = this.#hash(path);
		const { status, body } = await this.#request(path, { method: "GET" }, MAX_BYTES);
		if (status !== 200 || createHash("sha256").update(body).digest("hex") !== hash)
			throw new Error("Native object failed integrity verification");
		return body;
	}

	#hash(path: string): string {
		const parts = path.split("/");
		if (parts.length !== 2 || parts[0] !== this.#companyId || !/^[0-9a-f]{64}$/.test(parts[1]!))
			throw new Error("Native object is outside the admitted company");
		return parts[1]!;
	}

	#request(path: string, init: RequestInit, maximum: number): Promise<{ status: number; body: Uint8Array }> {
		return cloudToolRequest(
			async (signal) => {
				const response = await this.#fetch(`${this.#origin}/v1/native-company-objects/${path}`, {
					...init,
					redirect: "error",
					signal,
					headers: {
						...init.headers,
						authorization: `Bearer ${this.#token}`,
						"x-qorpera-native-binding": this.#binding,
					},
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error(`Native object authority unavailable (${response.status})`);
				}
				const declared = response.headers.get("content-length");
				if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Native object response exceeds its limit");
				}
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Native object response is missing");
				const cancel = (): void => {
					void reader.cancel().catch(() => undefined);
				};
				signal.addEventListener("abort", cancel, { once: true });
				const chunks: Uint8Array[] = [];
				let count = 0;
				try {
					for (;;) {
						signal.throwIfAborted();
						const next = await reader.read();
						if (next.done) break;
						count += next.value.byteLength;
						if (count > maximum) throw new Error("Native object response exceeds its limit");
						chunks.push(next.value);
					}
					signal.throwIfAborted();
					if (declared !== null && count !== Number(declared))
						throw new Error("Native object response is incomplete");
					return { status: response.status, body: Buffer.concat(chunks, count) };
				} finally {
					signal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
			},
			this.#signal,
			this.#timeoutMs,
		);
	}
}
