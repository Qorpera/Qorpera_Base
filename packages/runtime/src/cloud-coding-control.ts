import { readBoundedCloudResponse, supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import { CLOUD_CODING_RPCS, type CloudCodingControl } from "./cloud-coding-tools.ts";
import { CLOUD_CODING_NATIVE_RPCS, type CloudCodingNativeControl } from "./cloud-native-coding-runtime.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

export const CLOUD_CODING_LISTENER_RPCS = [
	"qorpera_read_coding_completions",
	"qorpera_deliver_coding_completion",
] as const;
export interface CloudCodingListenerControl {
	call(
		method: (typeof CLOUD_CODING_LISTENER_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Trusted service transport. No retries, arbitrary destinations or model-held credentials. */
export class HttpCloudCodingControl
	implements CloudCodingControl, CloudCodingListenerControl, Pick<CloudCodingNativeControl, "call">
{
	readonly #origin: string;
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
			throw new Error("Invalid coding control configuration");
		this.#origin = url.origin;
		this.#serviceKey = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}
	call(
		method:
			| (typeof CLOUD_CODING_RPCS)[number]
			| (typeof CLOUD_CODING_LISTENER_RPCS)[number]
			| (typeof CLOUD_CODING_NATIVE_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (
			!(
				[...CLOUD_CODING_RPCS, ...CLOUD_CODING_LISTENER_RPCS, ...CLOUD_CODING_NATIVE_RPCS] as readonly string[]
			).includes(method)
		)
			throw new Error("Unknown coding operation");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 128 * 1024) throw new Error("Coding request too large");
		return cloudToolRequest(async (requestSignal) => {
			try {
				const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					redirect: "error",
					signal: requestSignal,
					headers: { ...supabaseServiceHeaders(this.#serviceKey), "content-type": "application/json" },
					body,
				});
				if (!response.ok) {
					void response.body?.cancel().catch(() => undefined);
					throw new Error("Coding operation unconfirmed");
				}
				const bytes = await readBoundedCloudResponse(
					response,
					method === "qorpera_read_coding_completions"
						? 1024 * 1024
						: method === "qorpera_authorize_native_coding_execution" ||
								method === "qorpera_resolve_native_coding_scope"
							? 128 * 1024
							: 32 * 1024,
					requestSignal,
				);
				return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
			} catch {
				// Neither upstream bodies nor transport error text may expose credentials.
				throw new Error("Coding operation unconfirmed");
			}
		}, signal);
	}
}
