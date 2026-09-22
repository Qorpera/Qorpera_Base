import { readBoundedCloudResponse, supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import { CLOUD_CODING_NATIVE_RPCS, type CloudCodingNativeControl } from "./cloud-native-coding-runtime.ts";

/** The identity host's control for coding turns: a fixed origin, the closed set
 * of coding RPCs, no mutation retries. The ordinary tool authority and
 * operation receipts stay with the provider control plane. */
export class HttpCloudCodingControl implements Pick<CloudCodingNativeControl, "call"> {
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
			throw new Error("Coding control configuration invalid");
		this.#origin = url.origin;
		this.#serviceKey = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
	}
	async call(
		method: (typeof CLOUD_CODING_NATIVE_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!(CLOUD_CODING_NATIVE_RPCS as readonly string[]).includes(method))
			throw new Error("Coding control method invalid");
		const body = JSON.stringify(args);
		if (Buffer.byteLength(body) > 512 * 1024) throw new Error("Coding control request too large");
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
			method: "POST",
			redirect: "error",
			signal: checked,
			headers: { ...supabaseServiceHeaders(this.#serviceKey), "content-type": "application/json" },
			body,
		});
		if (response.status !== 200) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`Coding control ${method} unconfirmed (${response.status})`);
		}
		return JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked)),
		) as unknown;
	}
}
