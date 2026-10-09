import {
	CloudCompanyHeadConflict,
	type CloudCompanyPathControl,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import {
	CloudCompanyFolderRpcError,
	CloudCompanyPathRpcMissing,
	CloudCompanyPathRpcParentMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathRpcRefusal,
} from "./cloud-company-path-refusal.ts";
import { CloudControlRpcRefused, cloudControlRefusalCode, cloudPostgrestError } from "./cloud-control-errors.ts";
import { CLOUD_TOOL_REQUEST_MAX_MS, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

const FOLDER_RPCS: ReadonlySet<CloudCompanyPathRpc> = new Set([
	"qorpera_folder_read",
	"qorpera_folder_list",
	"qorpera_folder_commit",
	"qorpera_folder_memory_commit",
	"qorpera_folder_record_release",
	"qorpera_folder_run_view_open",
	"qorpera_folder_open_upload",
	"qorpera_folder_seal_upload",
	"qorpera_folder_renew_upload",
	"qorpera_folder_agent_todos",
	"qorpera_folder_record_review",
	"qorpera_folder_agent_routines",
	"qorpera_prepare_routine_login",
	"qorpera_folder_worker_commit",
	"qorpera_folder_agent_workers",
	"qorpera_folder_cancel_agent_worker",
	"qorpera_folder_agent_proposals",
	"qorpera_folder_apply_proposal",
	"qorpera_folder_close_proposal",
	"qorpera_folder_archive_coding_worker",
	"qorpera_folder_manage_hook",
]);

/** No end-user token, arbitrary URL, redirect, provider credential or retry. */
export class HttpCloudCompanyPathControl implements CloudCompanyPathControl {
	readonly #url: string;
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
			throw new Error("Invalid Company File control configuration");
		this.#url = url.origin;
		this.#serviceKey = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}

	call(method: CloudCompanyPathRpc, argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const permitted: readonly CloudCompanyPathRpc[] = [
			"qorpera_manage_agent_routine",
			"qorpera_decide_agent_routine",
			"qorpera_manage_agent_sidebar",
			"qorpera_manage_agent_todo",
			"qorpera_confirm_agent_todo_publication",
			"qorpera_manage_agent_worker",
			"qorpera_report_worker_result",
			"qorpera_describe_agent_open_work",
			"qorpera_record_runtime_observation_batch",
			"qorpera_record_provider_usage_signal",
			"qorpera_begin_native_company_execution_v2",
			"qorpera_describe_company_run_context",
			"qorpera_list_native_connector_tools",
			"qorpera_assert_native_connector_operation",
			"qorpera_read_company_run_context",
			"qorpera_read_company_path_v2",
			"qorpera_list_company_paths_v2",
			// Trusted notebook reads for memory composition (runtime Step 6).
			"qorpera_read_company_path",
			"qorpera_list_company_paths",
			"qorpera_confirm_company_path_read",
			"qorpera_record_native_context_view",
			"qorpera_fence_native_context",
			"qorpera_assert_company_path_reads",
			"qorpera_check_company_path_mutation",
			"qorpera_verify_company_path_file",
			"qorpera_verify_company_path_tree",
			"qorpera_prepare_company_path_mutation",
			"qorpera_commit_company_path_mutation",
			"qorpera_native_company_file_write_source",
			"qorpera_native_company_file_write",
			"qorpera_prepare_company_path_approval",
			"qorpera_apply_company_path_approval",
			"qorpera_apply_company_path_approval_v3",
			"qorpera_self_approve_organization_proposal",
			"qorpera_native_presence_register",
			"qorpera_company_presence_scope",
			"qorpera_native_presence_subject",
			"qorpera_native_presence_forget",
			"qorpera_read_native_wake",
			"qorpera_send_coworker_message",
			"qorpera_runtime_wake_policy",
			"qorpera_assert_wake_work_allowed",
			"qorpera_assert_wake_completion",
			// Auto-review (v130).
			"qorpera_begin_action_review",
			"qorpera_record_action_review",
			"qorpera_await_action_review",
			"qorpera_add_agent_review_rule",
			// Machines agents start (2026-09-28).
			"qorpera_native_machine_start",
			"qorpera_native_machine_manage",
			"qorpera_company_machines_available",
			// The folder core (core C3).
			"qorpera_folder_read",
			"qorpera_folder_list",
			"qorpera_folder_commit",
			// Dormant run-log persistence and trusted per-step protection (memory W1c-3).
			"qorpera_folder_memory_commit",
			"qorpera_memory_run_log_place",
			"qorpera_memory_step_narrow",
			"qorpera_memory_step_hashes",
			"qorpera_folder_record_release",
			// The run's own view, for the node's folder search (F3, 20260929999970).
			"qorpera_folder_run_view_open",
			// Staging a folder-v2 file's bytes (core C1d).
			"qorpera_folder_open_upload",
			"qorpera_folder_seal_upload",
			"qorpera_folder_renew_upload",
			// A folder-v2 run's own todos from the todo index (thin writers W1).
			"qorpera_folder_agent_todos",
			// An approved call's review of the change set it commits (C2 R1).
			"qorpera_folder_record_review",
			// A folder-v2 run's own routines, and the login a routine save pins (thin writers W4c).
			"qorpera_folder_agent_routines",
			"qorpera_prepare_routine_login",
			// A folder-v2 run's workers: their files under the worker tool's request, a todo's workers, and a cancel (F2-5b).
			"qorpera_folder_worker_commit",
			"qorpera_folder_agent_workers",
			"qorpera_folder_cancel_agent_worker",
			// Changes a view saved that wait for review (P40): a run's list, its apply and its close.
			"qorpera_folder_agent_proposals",
			"qorpera_folder_apply_proposal",
			"qorpera_folder_close_proposal",
			// A coding session's archive (C3b).
			"qorpera_folder_archive_coding_worker",
			// Event wakes (W2), and a folder-v2 agent's own hooks and mailboxes (E3a).
			"qorpera_list_agent_event_hooks",
			"qorpera_read_agent_event",
			"qorpera_folder_manage_hook",
			// Company mail (M2b), and finding received mail.
			"qorpera_send_agent_mail",
			"qorpera_find_agent_mail",
			// Company accounts (A1-4): the company's accounts and mailboxes, and the id of the agent's todo by key.
			"qorpera_find_company_accounts",
			// Summary trees (M1b-3): zoom, and the platform read of the tree blocks a zoom result or a view showed. The
			// primary view, its record and the branches (M1b-4a, M4).
			"qorpera_memory_zoom",
			"qorpera_memory_release",
			"qorpera_memory_view",
			"qorpera_memory_view_record",
			"qorpera_memory_branches",
		];
		if (!permitted.includes(method)) throw new Error("Unknown Company File control operation");
		const body = JSON.stringify(argumentsValue);
		if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new Error("Company File control request too large");
		return cloudToolRequest(
			async (requestSignal) => {
				const headers: Record<string, string> = { apikey: this.#serviceKey, "content-type": "application/json" };
				if (this.#serviceKey.startsWith("eyJ") && this.#serviceKey.split(".").length === 3)
					headers.authorization = `Bearer ${this.#serviceKey}`;
				const response = await this.#fetch(`${this.#url}/rest/v1/rpc/${method}`, {
					method: "POST",
					redirect: "error",
					signal: requestSignal,
					headers,
					body,
				}).catch(() => {
					throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company File authority unavailable");
				});
				requestSignal.throwIfAborted();
				// PostgREST returns no body for these void RPCs. A missing value
				// must still fail closed for admission, reads, receipts and commits.
				if (
					response.status === 204 &&
					(method === "qorpera_assert_company_path_reads" ||
						method === "qorpera_native_presence_forget" ||
						method === "qorpera_assert_native_connector_operation" ||
						method === "qorpera_verify_company_path_file")
				)
					return null;
				const maximum =
					response.ok &&
					(method === "qorpera_prepare_company_path_mutation" ||
						method === "qorpera_native_company_file_write" ||
						method === "qorpera_prepare_company_path_approval")
						? 16 * 1024 * 1024
						: response.ok && method === "qorpera_describe_company_run_context"
							? 1024 * 1024
							: // A listing page of 200 entries with 4096-byte paths (each character escaped at worst), and a
								// change set's outcomes.
								response.ok && method === "qorpera_folder_list"
								? 2 * 1024 * 1024
								: response.ok &&
										(method === "qorpera_folder_commit" ||
											method === "qorpera_folder_memory_commit" ||
											// A classification returns the restricted subset of up to 1,024 complete paths.
											method === "qorpera_memory_step_narrow" ||
											method === "qorpera_folder_worker_commit" ||
											// A proposal's apply is its commit; a page of proposals carries up to 200 units with their
											// structured files' whole parses, which SQL does not cut.
											method === "qorpera_folder_apply_proposal" ||
											method === "qorpera_folder_agent_proposals" ||
											// A zoom with no line reads the conversation's whole tree, every line up to
											// 2,048 bytes as stored; so do the view, and the branches for up to 8 trees.
											method === "qorpera_memory_zoom" ||
											method === "qorpera_memory_view" ||
											method === "qorpera_memory_branches")
									? 16 * 1024 * 1024
									: // One routine whole (32 KiB of instructions, each character escaped at worst), or a
										// page of 32 with theirs cut; a page of 16 workers with their outputs' paths.
										response.ok &&
											(method === "qorpera_folder_agent_routines" ||
												method === "qorpera_folder_agent_workers")
										? 1024 * 1024
										: response.ok
											? 256 * 1024
											: 4096;
				// A 5xx that is not PostgREST's own answer (a proxy's page, a cut body) is a lost answer: the transaction
				// may have committed. The folder client retries a folder call with the same key; a run's authority and
				// read-set checks ask again (control calls, 4 Oct 2026); nothing else retries.
				const unreadable = (message: string): CloudRuntimeDiagnosticError =>
					new CloudRuntimeDiagnosticError(
						response.status >= 500 ? "transport_unavailable" : "invalid_response",
						message,
					);
				const reader = response.body?.getReader();
				if (!reader)
					throw new CloudRuntimeDiagnosticError("invalid_response", "Company File authority unavailable");
				const cancel = (): void => {
					void reader.cancel().catch(() => undefined);
				};
				requestSignal.addEventListener("abort", cancel, { once: true });
				const chunks: Uint8Array[] = [];
				let count = 0;
				try {
					for (;;) {
						requestSignal.throwIfAborted();
						const chunk = await reader.read().catch(() => {
							throw new CloudRuntimeDiagnosticError(
								"transport_unavailable",
								"Company File authority unavailable",
							);
						});
						if (chunk.done) break;
						count += chunk.value.byteLength;
						if (count > maximum) throw unreadable("Company File control response too large");
						chunks.push(chunk.value);
					}
				} finally {
					requestSignal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
				requestSignal.throwIfAborted();
				let value: unknown;
				try {
					value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
				} catch {
					throw unreadable("Company File authority unavailable");
				}
				if (!response.ok) {
					// A complete PostgREST error body with exactly this SQLSTATE.
					const postgrestError = (code: string): boolean =>
						!!value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						Object.keys(value).sort().join() === "code,details,hint,message" &&
						(value as Record<string, unknown>).code === code &&
						typeof (value as Record<string, unknown>).message === "string" &&
						["details", "hint"].every(
							(key) =>
								(value as Record<string, unknown>)[key] === null ||
								typeof (value as Record<string, unknown>)[key] === "string",
						);
					// The folder core's errors keep their SQLSTATE and message: the folder client tells a stop, a
					// run that ended, a read no longer readable and a retryable change apart (core C3).
					const folderCode =
						FOLDER_RPCS.has(method) && value && typeof value === "object" && !Array.isArray(value)
							? (value as Record<string, unknown>).code
							: undefined;
					// A SQLSTATE, or PostgREST's own answer about the request (PGRST1nn a bad request, 2nn no such
					// function, 3nn the service key), which nothing ran. Its connection errors (PGRST0nn) stay lost
					// answers, which the folder client retries.
					if (
						typeof folderCode === "string" &&
						/^(?:[0-9A-Z]{5}|PGRST[1-9][0-9]{2})$/.test(folderCode) &&
						postgrestError(folderCode)
					)
						throw new CloudCompanyFolderRpcError(folderCode, (value as { message: string }).message);
					// PostgREST answers 42501 with 403, or with 401 for a request on the publishable key (G2-2).
					if ((response.status === 401 || response.status === 403) && postgrestError("42501"))
						throw new CloudCompanyPathRpcRefusal((value as { message: string }).message);
					if (response.status === 412 && postgrestError("PT412")) throw new CloudCompanyPathRpcPrecondition();
					if (response.status === 424 && postgrestError("PT424")) throw new CloudCompanyPathRpcParentMissing();
					// Only the one-call fence acts on a missing function; every other call keeps its category.
					if (method === "qorpera_fence_native_context" && response.status === 404 && postgrestError("PGRST202"))
						throw new CloudCompanyPathRpcMissing();
					if (
						response.status === 409 &&
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						Object.keys(value).every((key) => ["code", "message", "details", "hint"].includes(key)) &&
						(value as Record<string, unknown>).code === "PT409"
					)
						throw new CloudCompanyHeadConflict();
					// A refusal the database raised (55000, 0A000, P0001, a QRC code, an invalid argument): that transaction
					// rolled back whole and asking again changes nothing. Never a lost connection (control calls, 4 Oct 2026).
					const refused = cloudPostgrestError(value);
					if (refused && cloudControlRefusalCode(refused.code))
						throw new CloudControlRpcRefused(refused.code, refused.message, "Company File authority unavailable");
					throw new CloudRuntimeDiagnosticError(
						response.status === 401 || response.status === 403
							? "authority_unavailable"
							: response.status === 412
								? "stale_version"
								: response.status === 400 || response.status === 422
									? "invalid_arguments"
									: "transport_unavailable",
						"Company File authority unavailable",
					);
				}
				return value;
			},
			signal,
			// The one-call fence carries what four calls did before a model request. The run's retry decides how long
			// each attempt waits: 10 s at first, twice as long after one is cut (CloudNativeToolRun.assertActiveWith).
			method === "qorpera_fence_native_context" ? CLOUD_TOOL_REQUEST_MAX_MS : 3000,
		);
	}
}
