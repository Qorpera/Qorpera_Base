import {
	CloudCompanyHeadConflict,
	type CloudCompanyPathControl,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import {
	CloudCompanyPathRpcMissing,
	CloudCompanyPathRpcParentMissing,
	CloudCompanyPathRpcPrecondition,
	CloudCompanyPathRpcRefusal,
} from "./cloud-company-path-refusal.ts";
import { CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

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
			"qorpera_record_runtime_observation",
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
							: response.ok
								? 256 * 1024
								: 4096;
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
						if (count > maximum)
							throw new CloudRuntimeDiagnosticError(
								"invalid_response",
								"Company File control response too large",
							);
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
					throw new CloudRuntimeDiagnosticError("invalid_response", "Company File authority unavailable");
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
					if (response.status === 403 && postgrestError("42501")) throw new CloudCompanyPathRpcRefusal();
					if (response.status === 412 && postgrestError("PT412")) throw new CloudCompanyPathRpcPrecondition();
					if (response.status === 424 && postgrestError("PT424")) throw new CloudCompanyPathRpcParentMissing();
					if (response.status === 404 && postgrestError("PGRST202")) throw new CloudCompanyPathRpcMissing();
					if (
						response.status === 409 &&
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						Object.keys(value).every((key) => ["code", "message", "details", "hint"].includes(key)) &&
						(value as Record<string, unknown>).code === "PT409"
					)
						throw new CloudCompanyHeadConflict();
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
			// The one-call fence carries what four calls did before a model request, within the same 4 s budget.
			method === "qorpera_fence_native_context" ? CLOUD_NATIVE_FENCE_CALL_TIMEOUT_MS : 3000,
		);
	}
}
