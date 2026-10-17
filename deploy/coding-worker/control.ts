import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODE_HOST_DELETION_RPCS } from "../../packages/runner-orchestrator/src/code-host.ts";
import { CODE_HOST_RPCS } from "../../packages/runner-orchestrator/src/code-host-views.ts";
import { CODING_EXECUTOR_RPCS, CodingControlBusy, CodingControlRefused } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CODING_SNAPSHOT_RPCS } from "../../packages/runner-orchestrator/src/coding-snapshots.ts";
import { COMPANY_MACHINE_HOST_RPCS } from "../../packages/runner-orchestrator/src/company-machine-host.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...CODING_SNAPSHOT_RPCS, ...COMPANY_MACHINE_HOST_RPCS, ...CODE_HOST_RPCS,
	...CODE_HOST_DELETION_RPCS, "qorpera_authorize_coding_command", "qorpera_route_coding_command",
	"qorpera_authorize_machine_command", "qorpera_native_binding_proven"]);

/** Calls whose refusal (SQLSTATE 42501) the caller acts on: a test machine's folder view open, which the executor
 * answers with a boot without /company, or with a move to a new disk when the open refused its disk (F3 6d), and a
 * run's take-in of a test machine's reads, whose refusal of a read no longer readable moves the machine to a new disk
 * (F3 6d-3b). The code host's open (F3 5e-3b) is the same call as the first; it fails on a refusal as on any other
 * failure (`CODE_HOST_VIEW_UNAVAILABLE`). */
const REFUSABLE = new Set<string>(["qorpera_folder_view_open", "qorpera_folder_test_machine_inherit_reads"]);
const DETAIL = /^qorpera\.[a-z0-9./-]{1,120}$/;

/** The core's refusals of a folder view, in their own words: SQL raised one of these, with 42501 or 22023. The
 * executor fails a coding session's attach with them (F3 5g-4), or, for a machine SQL marked to restart for the
 * folder (5g-5), restarts it first; a test machine's command receipts say why its boot has no /company (F3 6e-2a).
 * Any other text, and every other method's, is never kept. */
const VIEW_REFUSALS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["qorpera_folder_view_open", new Set(["Folder core authority is required", "Company folder is unavailable",
		"Folder view is invalid", "Folder view opener is invalid", "Folder view anchor is invalid",
		"Folder view attachment is not current", "Folder view principals are unavailable",
		"Coding machine must restart first", "Folder view machine is not current"])],
	["qorpera_folder_view_close", new Set(["Folder core authority is required", "Folder view is unavailable"])],
]);

/** PostgREST's error body, exactly: its transaction rolled back whole. It answers SQLSTATE 55P03 (lock_not_available)
 * with HTTP 500, 42501 (insufficient_privilege) with 403 (401 without a role), and 22023 (invalid_parameter_value)
 * with 400. */
function postgrestError(body: Uint8Array): { code: string; message: string; details: string | null } | undefined {
	try {
		const value = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(body)) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const error = value as Record<string, unknown>;
		return Object.keys(error).sort().join() === "code,details,hint,message" && typeof error.code === "string" &&
			typeof error.message === "string" && [error.details, error.hint].every((v) => v === null || typeof v === "string")
			? { code: error.code, message: error.message, details: error.details as string | null } : undefined;
	} catch {
		return undefined;
	}
}

/** Service-role custody lives only in this dedicated control process. All
 * requests use a fixed origin and closed RPC set, without mutation retries.
 * Only a busy row (CodingControlBusy), and a refusal where the caller acts on
 * one (CodingControlRefused), are told apart from other failures; the executor
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
		let failure: Error = new Error("CODING_CONTROL_UNCONFIRMED");
		try {
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST", redirect: "error", signal: checked,
				headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" }, body,
			});
			if (response.status !== 200) {
				const refusable = REFUSABLE.has(method) && (response.status === 401 || response.status === 403);
				const kept = refusals !== undefined && [400, 401, 403].includes(response.status);
				// An error body that stalls is not worth waiting for: it stays unconfirmed.
				if (response.status === 500 || refusable || kept) {
					const error = postgrestError(await readBoundedCloudResponse(response, 4096, AbortSignal.any([checked, AbortSignal.timeout(1000)])));
					const reason = kept && error && ["42501", "22023"].includes(error.code) && refusals?.has(error.message) ? error.message : null;
					if (response.status === 500 && error?.code === "55P03") failure = new CodingControlBusy();
					else if (error && ((refusable && error.code === "42501") || reason !== null))
						failure = new CodingControlRefused(error.details !== null && DETAIL.test(error.details) ? error.details : null, reason);
				} else await response.body?.cancel().catch(() => undefined);
				throw new Error("unconfirmed");
			}
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked))) as unknown;
		} catch {
			throw failure;
		}
	}
}
