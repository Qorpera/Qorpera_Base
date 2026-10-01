import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import type { CloudObjectTransport } from "@qorpera/cloud-client/node/cloud-object-store";
import {
	type CloudNativeToolBinding,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 8 * 1024 * 1024;

/** A lock conflict is the object gateway's 409 or 503 with `code: "lock_conflict"`: the database rolled back on a
 * serialization failure, deadlock or lock timeout on this company's rows, and committed nothing.
 * Both requests are safe to send again. A GET only reads, and its two authority checks run again. A PUT is addressed
 * by its content: its checks are reads, the same bytes land on the same object ("exists" the second time), and the
 * catalog confirmation inserts the same row or leaves it as it is. So a lock conflict is sent again at most twice,
 * after a jittered pause. Nothing else is: not a denial, a stop (423), another 409, or a stalled or lost answer. */
const LOCK_CONFLICT_PAUSES_MS: ReadonlyArray<readonly [number, number]> = [
	[100, 300],
	[300, 700],
];
/** A retry starts only when its pause and an attempt as long as the last one, and never shorter than this, end
 * inside the budget. */
const LOCK_CONFLICT_ATTEMPT_MS = 500;
/** The tool call's own budget (`cloudToolRequest`'s default). Retries fit inside it and never add to it: a retry
 * that still runs longer than expected is cut when the budget ends. */
const LOCK_CONFLICT_BUDGET_MS = 5_000;
const LOCK_CONFLICT_BODY_BYTES = 1024;
const LOCK_CONFLICT_BODY_MS = 250;

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
		const started = performance.now();
		const budget = Math.min(this.#timeoutMs, LOCK_CONFLICT_BUDGET_MS);
		return cloudToolRequest(
			async (signal) => {
				for (let retry = 0; ; retry++) {
					const attemptStarted = performance.now();
					// A retry must end inside the budget: its own deadline is what the budget has left. The first
					// attempt keeps the transport's deadline, as before.
					const deadline =
						retry === 0
							? undefined
							: AbortSignal.timeout(Math.max(1, Math.floor(budget - (attemptStarted - started))));
					const attempt = deadline ? AbortSignal.any([signal, deadline]) : signal;
					let refused = 0;
					try {
						const response = await this.#fetch(`${this.#origin}/v1/native-company-objects/${path}`, {
							...init,
							redirect: "error",
							signal: attempt,
							headers: {
								...init.headers,
								authorization: `Bearer ${this.#token}`,
								"x-qorpera-native-binding": this.#binding,
							},
						});
						if (response.ok) return await this.#read(response, maximum, attempt);
						refused = response.status;
						const range = LOCK_CONFLICT_PAUSES_MS[retry];
						if (!range) void response.body?.cancel().catch(() => undefined);
						else if (await this.#lockConflict(response, attempt)) {
							const wait = Math.round(range[0] + Math.random() * (range[1] - range[0]));
							const now = performance.now();
							// The next attempt is expected to take as long as this one did: a lock timeout answers
							// only after the database's whole lock wait (2 s).
							const expected = Math.max(LOCK_CONFLICT_ATTEMPT_MS, now - attemptStarted);
							if (now - started + wait + expected <= budget) {
								await pause(wait, undefined, { signal });
								continue;
							}
						}
					} catch (error) {
						// A retry cut at the budget ends like the deadline it stands in for: its outcome is unknown.
						if (deadline?.aborted && !signal.aborted)
							throw new CloudRuntimeDiagnosticError("timeout", "Cloud tool authority unavailable");
						throw error;
					}
					throw new Error(`Native object authority unavailable (${refused})`);
				}
			},
			this.#signal,
			this.#timeoutMs,
		);
	}

	/** Whether a refusal is the gateway's lock conflict: 409 or 503 with `code: "lock_conflict"`, read from at most
	 * 1 KiB of body within 250 ms. Only those two statuses are read; a denial's body is never inspected. */
	async #lockConflict(response: Response, signal: AbortSignal): Promise<boolean> {
		if (response.status !== 409 && response.status !== 503) {
			void response.body?.cancel().catch(() => undefined);
			return false;
		}
		try {
			const { body } = await this.#read(
				response,
				LOCK_CONFLICT_BODY_BYTES,
				AbortSignal.any([signal, AbortSignal.timeout(LOCK_CONFLICT_BODY_MS)]),
			);
			const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
			return !!value && typeof value === "object" && (value as Record<string, unknown>).code === "lock_conflict";
		} catch {
			return false;
		}
	}

	async #read(
		response: Response,
		maximum: number,
		signal: AbortSignal,
	): Promise<{ status: number; body: Uint8Array }> {
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
			if (declared !== null && count !== Number(declared)) throw new Error("Native object response is incomplete");
			return { status: response.status, body: Buffer.concat(chunks, count) };
		} finally {
			signal.removeEventListener("abort", cancel);
			cancel();
			reader.releaseLock();
		}
	}
}
