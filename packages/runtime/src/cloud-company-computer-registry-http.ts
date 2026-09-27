import { companyComputerRequest } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { readBoundedCloudResponse, supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";

const methods = [
	"qorpera_describe_native_tool_authority",
	"qorpera_native_office_screen",
	"qorpera_native_office_descriptor",
	"qorpera_native_office_start_descriptor",
	"qorpera_native_office_start",
	"qorpera_reserve_runtime_office_start",
	"qorpera_check_runtime_office_start",
	"qorpera_check_runtime_office_adoption",
	"qorpera_runtime_office_provider_status",
	"qorpera_check_runtime_office_startup",
	"qorpera_report_runtime_office_ready",
	"qorpera_record_runtime_screen_event",
	"qorpera_retain_runtime_screen_observation",
	"qorpera_native_office_operation",
	"qorpera_native_office_capture",
	"qorpera_native_office_file_export",
	"qorpera_native_office_file_import",
	"qorpera_read_native_office_capture",
	"qorpera_assert_native_office_captures",
	"qorpera_native_office_browser_grant",
	"qorpera_office_screen_browser_grant",
	"qorpera_ack_runtime_office_drain",
	"qorpera_ack_runtime_office_privacy",
	"qorpera_check_runtime_office_private_surface",
	"qorpera_check_runtime_office_shared_surface",
	"qorpera_runtime_office_screen_appearance",
	"qorpera_check_runtime_office_guest_binding",
	"qorpera_check_runtime_office_work_binding",
	"qorpera_runtime_office_privacy_status",
	"qorpera_runtime_office_supervisor_status",
	"qorpera_redeem_runtime_office_viewer",
	"qorpera_check_runtime_office_viewer",
	"qorpera_admit_runtime_office_viewer_input_window",
	"qorpera_release_runtime_office_viewer",
] as const;
export type CompanyComputerRegistryMethod = (typeof methods)[number];

/** Host-only Supabase transport. Closed RPC names, finite bodies, no redirects
 * or retries; a lost effect/ticket response remains an unknown outcome. */
export class HttpCloudCompanyComputerRegistry {
	readonly #url: string;
	readonly #key: string;
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
			throw new Error("INVALID_OFFICE_REGISTRY_CONFIGURATION");
		this.#url = url.origin;
		this.#key = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}

	async call(
		method: CompanyComputerRegistryMethod,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!methods.includes(method)) throw new Error("UNKNOWN_OFFICE_REGISTRY_METHOD");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 128 * 1024) throw new Error("OFFICE_REGISTRY_REQUEST_TOO_LARGE");
		try {
			return await companyComputerRequest(
				async (requestSignal) => {
					const response = await this.#fetch(`${this.#url}/rest/v1/rpc/${method}`, {
						method: "POST",
						redirect: "error",
						signal: requestSignal,
						headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" },
						body,
					});
					if (!response.ok) {
						void response.body?.cancel().catch(() => undefined);
						throw new Error("denied");
					}
					const bytes = await readBoundedCloudResponse(response, 64 * 1024, requestSignal);
					requestSignal.throwIfAborted();
					const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
					if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
					return value;
				},
				signal,
				3000,
			);
		} catch (error) {
			// Never disclose SQL diagnostics, profile/input content or credentials.
			throw new Error("OFFICE_REGISTRY_UNCONFIRMED", { cause: error });
		}
	}
}
