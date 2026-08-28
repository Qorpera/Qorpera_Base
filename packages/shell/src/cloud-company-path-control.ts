import {
	CloudCompanyHeadConflict,
	type CloudCompanyPathControl,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

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
			"qorpera_begin_native_company_execution",
			"qorpera_describe_company_run_context",
			"qorpera_read_company_run_context",
			"qorpera_read_company_path",
			"qorpera_list_company_paths",
			"qorpera_assert_company_path_reads",
			"qorpera_check_company_path_mutation",
			"qorpera_verify_company_path_file",
			"qorpera_verify_company_path_tree",
			"qorpera_prepare_company_path_mutation",
			"qorpera_commit_company_path_mutation",
			"qorpera_prepare_company_path_approval",
			"qorpera_apply_company_path_approval",
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
				});
				const maximum =
					response.ok &&
					(method === "qorpera_prepare_company_path_mutation" ||
						method === "qorpera_prepare_company_path_approval")
						? 16 * 1024 * 1024
						: response.ok && method === "qorpera_describe_company_run_context"
							? 1024 * 1024
							: response.ok
								? 256 * 1024
								: 4096;
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Company File authority unavailable");
				const cancel = (): void => {
					void reader.cancel().catch(() => undefined);
				};
				requestSignal.addEventListener("abort", cancel, { once: true });
				const chunks: Uint8Array[] = [];
				let count = 0;
				try {
					for (;;) {
						requestSignal.throwIfAborted();
						const chunk = await reader.read();
						if (chunk.done) break;
						count += chunk.value.byteLength;
						if (count > maximum) throw new Error("Company File control response too large");
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
					throw new Error("Company File authority unavailable");
				}
				if (!response.ok) {
					if (
						response.status === 409 &&
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						Object.keys(value).every((key) => ["code", "message", "details", "hint"].includes(key)) &&
						(value as Record<string, unknown>).code === "PT409"
					)
						throw new CloudCompanyHeadConflict();
					throw new Error("Company File authority unavailable");
				}
				return value;
			},
			signal,
			3000,
		);
	}
}
