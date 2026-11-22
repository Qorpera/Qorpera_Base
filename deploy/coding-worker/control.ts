import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODE_CHANGE_RPCS } from "../../packages/runner-orchestrator/src/code-change-records.ts";
import { CODE_HOST_DELETION_RPCS } from "../../packages/runner-orchestrator/src/code-host.ts";
import { CODE_CARE_RPCS } from "../../packages/runner-orchestrator/src/code-host-care.ts";
import { CODE_REQUEST_RPCS } from "../../packages/runner-orchestrator/src/code-host-requests.ts";
import { CODE_HOST_RPCS } from "../../packages/runner-orchestrator/src/code-host-views.ts";
import { CODE_SITE_RPCS } from "../../packages/runner-orchestrator/src/code-site-uploads.ts";
import { NATIVE_WEB_HOSTING_RPCS } from "../../packages/runner-orchestrator/src/native-webapp-deploy.ts";
import { CODING_EXECUTOR_RPCS, CodingControlBusy, CodingControlRefused } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CODING_SNAPSHOT_RPCS } from "../../packages/runner-orchestrator/src/coding-snapshots.ts";
import { COMPANY_MACHINE_HOST_RPCS } from "../../packages/runner-orchestrator/src/company-machine-host.ts";
import { withTimeoutSignal } from "./timeout-signal.ts";

/** The executor's closed RPC set (exported for the tests, which run the routes and the host against it: F33 of #1661). */
export const CODING_CONTROL_METHODS: ReadonlySet<string> = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...CODING_SNAPSHOT_RPCS, ...COMPANY_MACHINE_HOST_RPCS, ...CODE_HOST_RPCS,
	...CODE_HOST_DELETION_RPCS, ...CODE_CARE_RPCS, ...CODE_CHANGE_RPCS, ...CODE_REQUEST_RPCS, ...CODE_SITE_RPCS,
	...NATIVE_WEB_HOSTING_RPCS,
	"qorpera_authorize_coding_command", "qorpera_route_coding_command",
	"qorpera_authorize_machine_command", "qorpera_authorize_machine_coding_value", "qorpera_authorize_machine_account_fill",
	"qorpera_authorize_machine_screen",
	"qorpera_member_machine_screen_authority", "qorpera_member_machine_desktop_act_authority",
	// A member's start of a desktop (20260930714000; it was missing, as F33 of #1661 found for take-over's record).
	"qorpera_member_machine_desktop_start_authority", "qorpera_native_binding_proven",
	// The agent was told a member touched the shared screen (20260930734000, review r1 F4 of #1701).
	"qorpera_machine_desktop_shared_told",
	// A member's pointer pass, read once per pass (20260930744000).
	"qorpera_member_machine_desktop_pointer_authority",
	// A run's channel to its home, before a byte reaches the machine (20260930752000).
	"qorpera_authorize_home_session"]);

/** Calls whose refusal (SQLSTATE 42501) the caller acts on: a test machine's folder view open, which the executor
 * answers with a boot without /company, or with a move to a new disk when the open refused its disk (F3 6d), and a
 * run's take-in of a test machine's reads, whose refusal of a read no longer readable moves the machine to a new disk
 * (F3 6d-3b). The code host's open (F3 5e-3b) is the same call as the first; it fails on a refusal as on any other
 * failure (`CODE_HOST_VIEW_UNAVAILABLE`). A member's read check of a machine's reads (20260930712000), whose refusal
 * hides that member's picture and nothing else. A member's pointer pass SQL no longer holds (replaced by a newer one,
 * older than 10 s, a member made a viewer: 20260930744000), which the window begins again. */
const REFUSABLE = new Set<string>(["qorpera_folder_view_open", "qorpera_folder_test_machine_inherit_reads",
	"qorpera_folder_member_machine_reads", "qorpera_member_machine_desktop_pointer_authority",
	// A member's live picture's release cycle (20260930745000): its read check's refusal ends that member's stream alone.
	"qorpera_member_machine_stream_release"]);
const DETAIL = /^qorpera\.[a-z0-9./-]{1,120}$/;

/** A turn's lease renewal and describe (R2, 31 Oct 2026): the kernel's refusal says the lease is gone, and the executor
 * never asks it again. They are the SQLSTATEs the two raise on purpose, with the status PostgREST answers each with:
 * 42501 for a lapsed lease, another token or a turn no longer running, 55000 for a cancelled session, 22023 for invalid
 * seconds. Any other failure stays unconfirmed, and the executor asks it again within the lease. */
const LEASED = new Set<string>(["qorpera_heartbeat_coding_session", "qorpera_describe_coding_turn"]);
const LEASE_REFUSALS: ReadonlyMap<string, readonly number[]> = new Map([
	["42501", [401, 403]], ["55000", [500]], ["22023", [400]],
]);

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
 * with HTTP 500, 57014 (query_canceled: the statement ran out of its time) with 500 or 504, 42501
 * (insufficient_privilege) with 403 (401 without a role), and 22023 (invalid_parameter_value) with 400. */
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

/** An unconfirmed call, with what is known of why as its cause (10 Nov 2026: a turn that died on one said only
 * CODING_CONTROL_UNCONFIRMED, so nobody could tell a refusal from a lost answer): the call, the HTTP status, and the
 * kernel's SQLSTATE and message when it answered with a whole PostgREST error. For the executor's log only, which
 * redacts and bounds it (codingErrorDetail); the message stays the fixed code, and nothing of the cause reaches an
 * agent or a member. An error's details and hint, where PostgreSQL puts a row's values, are never kept. */
function unconfirmed(method: string, why: string): Error {
	return new Error("CODING_CONTROL_UNCONFIRMED", { cause: new Error(`${method}: ${why.replace(/\s+/g, " ").slice(0, 300)}`) });
}

/** Service-role custody lives only in this dedicated control process. All
 * requests use a fixed origin and closed RPC set, without mutation retries.
 * Only a call the kernel rolled back whole for a busy row or a statement out of
 * time (CodingControlBusy), and a refusal where the caller acts on one
 * (CodingControlRefused), are told apart from other failures; the executor
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
		if (!CODING_CONTROL_METHODS.has(method)) throw new Error("CODING_CONTROL_METHOD_INVALID");
		const body = JSON.stringify(args);
		const maxRequestBytes =
			method === "qorpera_web_code_deployment_register"
				? 4 * 1024 * 1024
				: method === "qorpera_code_request_finish"
					? 512 * 1024
					: 128 * 1024;
		if (Buffer.byteLength(body) > maxRequestBytes) throw new Error("CODING_CONTROL_REQUEST_TOO_LARGE");
		const refusals = VIEW_REFUSALS.get(method);
		let failure: Error = unconfirmed(method, "no answer");
		try {
			return await withTimeoutSignal(signal, 30000, async (checked) => {
				const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					redirect: "error",
					signal: checked,
					headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" },
					body,
				});
				if (response.status !== 200) {
					failure = unconfirmed(method, `HTTP ${response.status}`);
					const refusable = REFUSABLE.has(method) && (response.status === 401 || response.status === 403);
					const kept = refusals !== undefined && [400, 401, 403].includes(response.status);
					const leased = LEASED.has(method) && [400, 401, 403].includes(response.status);
					// An error body that stalls is not worth waiting for: it stays unconfirmed.
					const error = postgrestError(
						await withTimeoutSignal(checked, 1000, (errorSignal) =>
							readBoundedCloudResponse(response, 4096, errorSignal),
						),
					);
					if (error) failure = unconfirmed(method, `HTTP ${response.status} ${error.code} ${error.message}`);
					if (response.status === 500 || response.status === 504 || refusable || kept || leased) {
						const reason =
							kept && error && ["42501", "22023"].includes(error.code) && refusals?.has(error.message)
								? error.message
								: null;
						const leaseGone =
							LEASED.has(method) && error !== undefined && LEASE_REFUSALS.get(error.code)?.includes(response.status) === true;
						// 55P03 with 500; 57014 (a statement out of time) with 500, or 504 from a PostgREST that answers it so.
						if (
							(response.status === 500 && error?.code === "55P03") ||
							([500, 504].includes(response.status) && error?.code === "57014")
						)
							failure = new CodingControlBusy();
						else if (error && ((refusable && error.code === "42501") || reason !== null || leaseGone))
							failure = new CodingControlRefused(
								error.details !== null && DETAIL.test(error.details) ? error.details : null,
								reason,
							);
					}
					throw new Error("unconfirmed");
				}
				failure = unconfirmed(method, "answer not read");
				return JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked)),
				) as unknown;
			});
		} catch {
			throw failure;
		}
	}
}
