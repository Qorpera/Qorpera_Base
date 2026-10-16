import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODE_HOST_RPCS } from "../../packages/runner-orchestrator/src/code-host.ts";
import { CODING_EXECUTOR_RPCS, CodingControlBusy } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CODING_SNAPSHOT_RPCS } from "../../packages/runner-orchestrator/src/coding-snapshots.ts";
import { COMPANY_MACHINE_HOST_RPCS } from "../../packages/runner-orchestrator/src/company-machine-host.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...CODING_SNAPSHOT_RPCS, ...COMPANY_MACHINE_HOST_RPCS, ...CODE_HOST_RPCS,
	"qorpera_authorize_coding_command", "qorpera_route_coding_command", "qorpera_authorize_machine_command",
	"qorpera_native_binding_proven"]);

/** PostgREST answers SQLSTATE 55P03 (lock_not_available) with HTTP 500 and
 * exactly this error body; its transaction rolled back whole. */
function lockNotAvailable(body: Uint8Array): boolean {
	try {
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body)) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const error = value as Record<string, unknown>;
		return Object.keys(error).sort().join() === "code,details,hint,message" && error.code === "55P03" &&
			typeof error.message === "string" && [error.details, error.hint].every((v) => v === null || typeof v === "string");
	} catch {
		return false;
	}
}

/** Service-role custody lives only in this dedicated control process. All
 * requests use a fixed origin and closed RPC set, without mutation retries.
 * Only a busy row (CodingControlBusy) is told apart from other failures; the
 * executor decides what to retry. */
export class CodingExecutorHttpControl {
	readonly #origin: string;
	readonly #key: string;
	readonly #fetch: typeof fetch;
	constructor(options: { supabaseUrl: string; serviceRoleKey: string; fetch?: typeof fetch }) {
		const url = new URL(options.supabaseUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
			!options.serviceRoleKey || /[\r\n\0]/.test(options.serviceRoleKey)) throw new Error("CODING_CONTROL_CONFIG_INVALID");
		this.#origin = url.origin;
		this.#key = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}
	async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (!METHODS.has(method)) throw new Error("CODING_CONTROL_METHOD_INVALID");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 128 * 1024) throw new Error("CODING_CONTROL_REQUEST_TOO_LARGE");
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		let busy = false;
		try {
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST", redirect: "error", signal: checked,
				headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" }, body,
			});
			if (response.status !== 200) {
				// An error body that stalls is not worth waiting for: it stays unconfirmed.
				if (response.status === 500)
					busy = lockNotAvailable(await readBoundedCloudResponse(response, 4096, AbortSignal.any([checked, AbortSignal.timeout(1000)])));
				else await response.body?.cancel().catch(() => undefined);
				throw new Error("unconfirmed");
			}
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked))) as unknown;
		} catch {
			throw busy ? new CodingControlBusy() : new Error("CODING_CONTROL_UNCONFIRMED");
		}
	}
}
