import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODING_EXECUTOR_RPCS, CodingControlBusy, CodingControlRefused } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { COMPANY_MACHINE_HOST_RPCS } from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import { CODE_HOST_RPCS } from "../../packages/runner-orchestrator/src/code-host-views.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...COMPANY_MACHINE_HOST_RPCS, ...CODE_HOST_RPCS,
	"qorpera_authorize_coding_command", "qorpera_route_coding_command", "qorpera_authorize_machine_command",
	"qorpera_native_binding_proven"]);

/** The core's refusals of a coding session's folder view, in its own words (F3 5g-4): SQL raised one of these, with
 * 42501 or 22023, and PostgREST answered 400 or 403. The executor fails the session's attach with them. Any other
 * text, and every other method's, is never kept. */
const VIEW_REFUSALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["qorpera_folder_view_open", new Set(["Folder core authority is required", "Company folder is unavailable",
		"Folder view is invalid", "Folder view opener is invalid", "Folder view anchor is invalid",
		"Folder view attachment is not current", "Folder view principals are unavailable"])],
	["qorpera_folder_view_close", new Set(["Folder core authority is required", "Folder view is unavailable"])],
]);

/** A complete PostgREST error body, or nothing. */
function postgrestError(body: Uint8Array): { code: string; message: string } | undefined {
	try {
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body)) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const error = value as Record<string, unknown>;
		return Object.keys(error).sort().join() === "code,details,hint,message" && typeof error.code === "string" &&
			typeof error.message === "string" && [error.details, error.hint].every((v) => v === null || typeof v === "string")
			? { code: error.code, message: error.message } : undefined;
	} catch {
		return undefined;
	}
}

/** Service-role custody lives only in this dedicated control process. All
 * requests use a fixed origin and closed RPC set, without mutation retries.
 * Only a busy row (CodingControlBusy, SQLSTATE 55P03 (lock_not_available),
 * which PostgREST answers with HTTP 500 and exactly its error body, its
 * transaction rolled back whole) and a folder view's refusal
 * (CodingControlRefused) are told apart from other failures; the executor
 * decides what to retry. */
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
		const refusals = VIEW_REFUSALS.get(method);
		let busy = false;
		let refused: string | undefined;
		try {
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST", redirect: "error", signal: checked,
				headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" }, body,
			});
			if (response.status !== 200) {
				// An error body that stalls is not worth waiting for: it stays unconfirmed.
				const read = () => readBoundedCloudResponse(response, 4096, AbortSignal.any([checked, AbortSignal.timeout(1000)]));
				if (response.status === 500) busy = postgrestError(await read())?.code === "55P03";
				else if (refusals && (response.status === 400 || response.status === 403)) {
					const error = postgrestError(await read());
					if (error && ["42501", "22023"].includes(error.code) && refusals.has(error.message)) refused = error.message;
				} else await response.body?.cancel().catch(() => undefined);
				throw new Error("unconfirmed");
			}
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked))) as unknown;
		} catch {
			throw refused !== undefined ? new CodingControlRefused(refused) : busy ? new CodingControlBusy() : new Error("CODING_CONTROL_UNCONFIRMED");
		}
	}
}
