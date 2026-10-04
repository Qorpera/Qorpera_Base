import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/**
 * Control calls: refusals are refusals, slowness is not failure (Q1's live onboarding test, 4 Oct 2026).
 *
 * A control call (a PostgREST RPC from a runtime host) ends one of three ways besides success:
 * - **refused:** the database answered with a SQLSTATE that says no: the transaction rolled back whole, and asking
 *   again changes nothing. Such a call is never retried and never reported as a lost connection.
 * - **transient:** the answer was lost or late (a timeout, a connection or gateway error, a 5xx with no SQLSTATE,
 *   PostgREST's own connection errors, a serialization failure, a deadlock, a lock or statement timeout, too many
 *   connections). An idempotent read may be asked again.
 * - anything else: unknown, as before.
 */

/** SQLSTATEs (and the folder core's own codes) that refuse a request. */
export function cloudControlRefusalCode(code: string): boolean {
	return (
		code === "42501" ||
		code === "55000" ||
		code === "0A000" ||
		code === "P0001" ||
		code.startsWith("22") ||
		/^QRC[0-9]{2}$/.test(code)
	);
}

/** SQLSTATEs that say the answer was late or the transaction lost a race, never that it was refused. */
const TRANSIENT_CODES = new Set(["40001", "40P01", "55P03", "57014", "57P01", "57P03", "53300", "53400"]);

export function cloudControlTransientCode(code: string): boolean {
	return TRANSIENT_CODES.has(code) || code.startsWith("08") || /^PGRST0[0-9]{2}$/.test(code);
}

/** A complete PostgREST error body: exactly code, details, hint and message. */
export function cloudPostgrestError(value: unknown): { code: string; message: string } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const body = value as Record<string, unknown>;
	if (
		Object.keys(body).sort().join() !== "code,details,hint,message" ||
		typeof body.code !== "string" ||
		typeof body.message !== "string" ||
		!["details", "hint"].every((key) => body[key] === null || typeof body[key] === "string")
	)
		return undefined;
	return { code: body.code, message: body.message };
}

/**
 * A control call the database refused, with its SQLSTATE and message. The message is the database's own words for a
 * refusal it raised on purpose; a tool adapter may relay it to the model only when this call was the tool's first
 * effect (nothing before it began), as `CloudToolRefusal`.
 */
export class CloudControlRpcRefused extends CloudRuntimeDiagnosticError {
	readonly code: string;
	readonly #detail: string;

	constructor(code: string, message: string, safeMessage = "Cloud control call refused") {
		super(code.startsWith("22") ? "invalid_arguments" : "authority_unavailable", safeMessage);
		this.code = code;
		this.#detail = message.slice(0, 500);
	}

	/** The database's message, kept off the error's text and out of its serialization. */
	get detail(): string {
		return this.#detail;
	}
}

/** Whether a failed control call may be asked again: its answer was lost or late, it was not refused. */
export function cloudControlRetryable(error: unknown): boolean {
	if (!(error instanceof CloudRuntimeDiagnosticError)) return false;
	const code = (error as { code?: unknown }).code;
	if (typeof code === "string") return cloudControlTransientCode(code);
	return error.category === "timeout" || error.category === "transport_unavailable";
}

/** The pause before attempt `attempt + 1` (from 0): 250 ms doubling to 2 s. */
export function cloudControlBackoffMs(attempt: number): number {
	return Math.min(2_000, 250 * 2 ** Math.min(attempt, 8));
}

/** An error response's body, if it is small enough to be a PostgREST error (4 KiB) and arrives within 500 ms; else
 * empty. A stalled body is cancelled, never waited for. Never throws. */
export async function cloudControlErrorBody(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stalled = new Promise<"stalled">((resolve) => {
		timer = setTimeout(() => resolve("stalled"), 500);
	});
	try {
		for (;;) {
			const next = await Promise.race([reader.read(), stalled]);
			if (next === "stalled") return "";
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 4096) return "";
			chunks.push(next.value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => undefined);
	}
}

/** Waits `ms`, or rejects when `signal` aborts first. */
export function cloudControlPause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}
