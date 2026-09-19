import {
	CloudCompanyHeadConflict,
	type CloudCompanyPathControl,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import { CloudCompanyPathRpcRefusal } from "./cloud-company-path-refusal.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";
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
			"qorpera_escalate_responsibility",
			"qorpera_manage_agent_routine",
			"qorpera_list_responsibility_escalations",
			"qorpera_resolve_responsibility_escalation",
			"qorpera_record_runtime_observation",
			"qorpera_record_provider_usage_signal",
			"qorpera_begin_native_company_execution_v2",
			"qorpera_describe_company_run_context",
			"qorpera_list_native_connector_tools",
			"qorpera_assert_native_connector_operation",
			"qorpera_read_company_run_context",
			"qorpera_read_company_path_v2",
			"qorpera_list_company_paths_v2",
			"qorpera_confirm_company_path_read",
			"qorpera_record_native_context_view",
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
			"qorpera_native_presence_register",
			"qorpera_company_presence_scope",
			"qorpera_native_presence_subject",
			"qorpera_native_presence_forget",
			"qorpera_read_native_wake",
			"qorpera_send_coworker_message",
			"qorpera_runtime_wake_policy",
			"qorpera_assert_wake_work_allowed",
			"qorpera_assert_wake_completion",
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
					if (
						response.status === 403 &&
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						Object.keys(value).sort().join() === "code,details,hint,message" &&
						(value as Record<string, unknown>).code === "42501" &&
						typeof (value as Record<string, unknown>).message === "string" &&
						["details", "hint"].every(
							(key) =>
								(value as Record<string, unknown>)[key] === null ||
								typeof (value as Record<string, unknown>)[key] === "string",
						)
					)
						throw new CloudCompanyPathRpcRefusal();
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
			3000,
		);
	}
}
