import { readBoundedCloudResponse, supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import {
	CloudControlRpcEnded,
	cloudControlEndedCode,
	cloudControlErrorBody,
	cloudControlTransientCode,
	cloudPostgrestError,
} from "./cloud-control-errors.ts";
import { CLOUD_CODING_NATIVE_RPCS, type CloudCodingNativeControl } from "./cloud-native-coding-runtime.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/** The two coding RPCs that only read the turn (its authority and its context). */
const CODING_READS: ReadonlySet<string> = new Set([
	"qorpera_authorize_coding_turn",
	"qorpera_read_coding_turn_context",
]);

/** The identity host's control for coding turns: a fixed origin, the closed set
 * of coding RPCs, no mutation retries. The ordinary tool authority and
 * operation receipts stay with the provider control plane.
 *
 * A read's lost or late answer is told apart, so its caller may ask it again (control calls, 4 Oct 2026; R2, 31 Oct
 * 2026): no answer at all, a 5xx, 408 or 429 with no PostgREST error, or a transient SQLSTATE (a lock or statement
 * timeout, PostgREST's pool wait: CloudControlRpcEnded). A refusal and anything else fail as before, and so does every
 * failure of a write (begin, context view, submit). The control itself sends each call once. */
export class HttpCloudCodingControl implements Pick<CloudCodingNativeControl, "call"> {
	readonly #origin: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;
	constructor(options: { supabaseUrl: string; serviceRoleKey: string; fetch?: typeof fetch }) {
		const url = new URL(options.supabaseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			!options.serviceRoleKey ||
			/[\r\n\0]/.test(options.serviceRoleKey)
		)
			throw new Error("Coding control configuration invalid");
		this.#origin = url.origin;
		this.#serviceKey = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}
	async call(
		method: (typeof CLOUD_CODING_NATIVE_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!(CLOUD_CODING_NATIVE_RPCS as readonly string[]).includes(method))
			throw new Error("Coding control method invalid");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 512 * 1024) throw new Error("Coding control request too large");
		const read = CODING_READS.has(method);
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
			method: "POST",
			redirect: "error",
			signal: checked,
			headers: { ...supabaseServiceHeaders(this.#serviceKey), "content-type": "application/json" },
			body,
		}).catch((error: unknown) => {
			// A read with no answer at all (a lost connection, or this control's own 30 s cut). The caller's
			// cancellation, and a write's failure, are thrown as they came.
			if (!read || signal.aborted) throw error;
			throw new CloudRuntimeDiagnosticError("transport_unavailable", `Coding control ${method} unconfirmed`);
		});
		if (response.status !== 200) {
			const failed = `Coding control ${method} unconfirmed (${response.status})`;
			if (!read) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error(failed);
			}
			const text = await cloudControlErrorBody(response);
			let error: { code: string; message: string } | undefined;
			try {
				error = text ? cloudPostgrestError(JSON.parse(text)) : undefined;
			} catch {
				error = undefined;
			}
			// A lost answer whose statement ended (a lock or statement timeout) or never began (PostgREST's pool wait).
			if (error && cloudControlTransientCode(error.code) && cloudControlEndedCode(error.code))
				throw new CloudControlRpcEnded(failed);
			if (
				(error && cloudControlTransientCode(error.code)) ||
				(!error && (response.status >= 500 || response.status === 408 || response.status === 429))
			)
				throw new CloudRuntimeDiagnosticError("transport_unavailable", failed);
			throw new Error(failed);
		}
		return JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked)),
		) as unknown;
	}
}
