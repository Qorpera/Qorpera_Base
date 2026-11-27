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
import {
	CloudControlRpcEnded,
	CloudControlRpcRefused,
	cloudControlEndedCode,
	cloudControlRefusalCode,
	cloudPostgrestError,
} from "./cloud-control-errors.ts";
import { NativeHostCallUnknown } from "./cloud-native-host-dispatch.ts";
import { CLOUD_TOOL_REQUEST_MAX_MS, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

const FOLDER_RPCS: ReadonlySet<CloudCompanyPathRpc> = new Set([
	"qorpera_folder_read",
	"qorpera_folder_list",
	"qorpera_folder_commit",
	"qorpera_folder_follow_up_run_commit",
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
	"qorpera_folder_note_interface_changes",
	"qorpera_folder_emit_data_change_wakes",
	"qorpera_folder_request_code_undo",
	"qorpera_folder_request_code_undo_v2",
	"qorpera_folder_code_request",
	"qorpera_folder_code_request_v2",
	"qorpera_folder_code_status",
	"qorpera_folder_code_claim_overlaps",
	"qorpera_folder_code_history",
	"qorpera_folder_code_query",
	"qorpera_folder_code_lifecycle",
	"qorpera_folder_code_github_sync",
	"qorpera_folder_describe_code_change",
	"qorpera_folder_request_code_import",
	"qorpera_folder_code_import",
	"qorpera_run_data_pass",
	"qorpera_run_data_pass_approved",
	"qorpera_run_company_numbers",
]);

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

const PERMITTED_RPCS: ReadonlySet<CloudCompanyPathRpc> = new Set([
	"qorpera_describe_agent_open_work",
	"qorpera_record_runtime_observation_batch",
	"qorpera_record_provider_usage_signal",
	"qorpera_begin_native_company_execution_v2",
	"qorpera_begin_native_company_execution_v3",
	"qorpera_bind_native_company_context",
	"qorpera_claude_worker_run_facts",
	"qorpera_claude_worker_fall_back",
	"qorpera_record_claude_run_usage",
	"qorpera_record_gemini_run_usage",
	"qorpera_record_gemini_voice_usage",
	"qorpera_record_gemini_image_usage",
	"qorpera_record_gemini_cap_reached",
	"qorpera_record_gemini_key_error",
	"qorpera_describe_company_run_context",
	"qorpera_list_native_connector_tools",
	"qorpera_assert_native_connector_operation",
	"qorpera_read_company_run_context",
	"qorpera_read_company_run_card",
	"qorpera_record_native_context_view",
	"qorpera_fence_native_context",
	"qorpera_assert_company_path_reads",
	"qorpera_check_native_run",
	"qorpera_native_presence_register",
	"qorpera_company_presence_scope",
	"qorpera_native_presence_subject",
	"qorpera_native_presence_forget",
	"qorpera_read_native_wake",
	"qorpera_send_coworker_message",
	"qorpera_runtime_wake_policy",
	"qorpera_assert_wake_work_allowed",
	"qorpera_assert_wake_completion",
	"qorpera_begin_action_review",
	"qorpera_record_action_review",
	"qorpera_await_action_review",
	"qorpera_add_agent_review_rule",
	"qorpera_good_will_agent_list",
	"qorpera_good_will_agent_mark",
	"qorpera_cofounder_crew",
	"qorpera_offer_agents_to_member",
	"qorpera_describe_company_senses",
	"qorpera_folder_run_receipt_exists",
	"qorpera_native_machine_start",
	"qorpera_native_machine_manage",
	"qorpera_company_machines_available",
	"qorpera_company_home_available",
	"qorpera_close_home_session",
	"qorpera_folder_read",
	"qorpera_folder_list",
	"qorpera_folder_commit",
	"qorpera_folder_follow_up_run_commit",
	"qorpera_folder_memory_commit",
	"qorpera_memory_run_log_place",
	"qorpera_memory_run_resume",
	"qorpera_memory_run_resume_receipts",
	"qorpera_memory_run_resume_record",
	"qorpera_memory_step_narrow",
	"qorpera_memory_step_hashes",
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
	"qorpera_folder_request_code_undo",
	"qorpera_folder_request_code_undo_v2",
	"qorpera_folder_code_request",
	"qorpera_folder_code_request_v2",
	"qorpera_folder_code_status",
	"qorpera_folder_code_claim_overlaps",
	"qorpera_folder_code_history",
	"qorpera_folder_code_query",
	"qorpera_folder_code_lifecycle",
	"qorpera_folder_code_github_sync",
	"qorpera_folder_describe_code_change",
	"qorpera_folder_request_code_import",
	"qorpera_folder_code_import",
	"qorpera_run_data_pass",
	"qorpera_run_data_pass_approved",
	"qorpera_run_company_numbers",
	"qorpera_folder_note_interface_changes",
	"qorpera_folder_emit_data_change_wakes",
	"qorpera_list_agent_event_hooks",
	"qorpera_read_agent_event",
	"qorpera_folder_manage_hook",
	"qorpera_send_agent_mail",
	"qorpera_find_agent_mail",
	"qorpera_manage_agent_mail",
	"qorpera_find_company_accounts",
	"qorpera_memory_zoom",
	"qorpera_memory_release",
	"qorpera_memory_view",
	"qorpera_memory_view_record",
	"qorpera_memory_branches",
	"qorpera_memory_events_run",
	"qorpera_memory_compaction_record",
	"qorpera_site_publish_check",
	"qorpera_site_publish_begin",
	"qorpera_site_publish_put",
	"qorpera_site_publish_finish",
	"qorpera_site_unpublish",
	"qorpera_site_share_check",
	"qorpera_site_share_app",
	"qorpera_site_agent_list_versions",
	"qorpera_site_agent_activate_version",
	"qorpera_native_surface_describe_senses",
	"qorpera_native_surface_propose",
	"qorpera_native_surface_start_session",
	"qorpera_native_surface_steer_session",
	"qorpera_native_surface_manage_automation",
	"qorpera_native_surface_record_change",
	"qorpera_native_surface_upsert_artifact",
	"qorpera_native_surface_report_progress",
	"qorpera_native_surface_read_session_turn",
	"qorpera_native_surface_session_images",
	"qorpera_native_list_company_interfaces",
	"qorpera_native_surface_complete_turn",
	"qorpera_native_surface_renew_lease",
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

	call(
		method: CloudCompanyPathRpc,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs?: number,
	): Promise<unknown> {
		if (!PERMITTED_RPCS.has(method)) throw new Error("Unknown Company File control operation");
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
				}).catch((error: unknown) => {
					// A call the native host's lists do not name was never sent: the host's own fault, not a lost answer.
					if (error instanceof NativeHostCallUnknown) throw error;
					throw new CloudRuntimeDiagnosticError("transport_unavailable", "Company File authority unavailable");
				});
				if (requestSignal.aborted) {
					void response.body?.cancel().catch(() => undefined);
					requestSignal.throwIfAborted();
				}
				// PostgREST returns no body for these void RPCs. A missing value
				// must still fail closed for admission, reads, receipts and commits.
				if (
					response.status === 204 &&
					(method === "qorpera_assert_company_path_reads" ||
						method === "qorpera_native_presence_forget" ||
						method === "qorpera_assert_native_connector_operation")
				) {
					void response.body?.cancel().catch(() => undefined);
					return null;
				}
				const maximum =
					response.ok && method === "qorpera_describe_company_run_context"
						? 1024 * 1024
						: // A listing page of 200 entries, each with a 4096-byte path (each character escaped at worst,
							// twice the bytes) and a link's 4095-byte target (control characters escaped as `\u00XX`,
							// six times).
							response.ok && method === "qorpera_folder_list"
							? 8 * 1024 * 1024
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
										method === "qorpera_memory_branches" ||
										// A page of up to 128 raw events, each a whole message.
										method === "qorpera_memory_events_run")
								? 16 * 1024 * 1024
								: // One routine whole (32 KiB of instructions, each character escaped at worst), or a
									// page of 32 with theirs cut; a page of 16 workers with their outputs' paths.
									response.ok &&
										(method === "qorpera_folder_agent_routines" ||
											method === "qorpera_folder_agent_workers" ||
											method === "qorpera_folder_code_request_v2" ||
											method === "qorpera_folder_code_history" ||
											method === "qorpera_folder_code_status")
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
					const payload = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
					value = JSON.parse(UTF8_FATAL.decode(payload));
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
					// Only the one-call fence and run check act on a missing function; every other call keeps its category.
					if (
						(method === "qorpera_fence_native_context" || method === "qorpera_check_native_run") &&
						response.status === 404 &&
						postgrestError("PGRST202")
					)
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
					// So is a resumed attempt's record that differs from the one its run and assignment already stored
					// (23505, W5b-2, 20260930340000): the stored record never changes, so the same request fails again.
					const refused = cloudPostgrestError(value);
					if (
						refused &&
						(cloudControlRefusalCode(refused.code) ||
							(method === "qorpera_memory_run_resume_record" && refused.code === "23505"))
					)
						throw new CloudControlRpcRefused(refused.code, refused.message, "Company File authority unavailable");
					const category =
						response.status === 401 || response.status === 403
							? "authority_unavailable"
							: response.status === 412
								? "stale_version"
								: response.status === 400 || response.status === 422
									? "invalid_arguments"
									: "transport_unavailable";
					// A lost answer PostgREST gave whose statement ended (a lock or statement timeout) or never began (its pool
					// wait): a read of the run's row may be asked again without waiting out the copy (R1, 28 Oct 2026).
					if (category === "transport_unavailable" && refused && cloudControlEndedCode(refused.code))
						throw new CloudControlRpcEnded("Company File authority unavailable", refused.code);
					throw new CloudRuntimeDiagnosticError(category, "Company File authority unavailable");
				}
				return value;
			},
			signal,
			// A caller's own budget wins: a shorter stop here would cut the call first, so that budget never applied.
			// The run-start reads wait in line for the run's job row, up to 4 s (two TESTCO runs, 16 Oct 2026).
			// Without one, a call stops at 3 s, except the one-call fence, which carries what four calls did before a
			// model request. The run's retry decides how long each attempt waits: 10 s at first, twice as long after
			// one is cut (CloudNativeToolRun.assertActiveWith).
			timeoutMs ?? (method === "qorpera_fence_native_context" ? CLOUD_TOOL_REQUEST_MAX_MS : 3000),
		);
	}
}
