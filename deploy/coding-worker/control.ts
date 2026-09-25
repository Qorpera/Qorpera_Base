import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import { CODING_EXECUTOR_RPCS } from "../../packages/runner-orchestrator/src/coding-executor.ts";
import { CODING_HOST_RPCS } from "../../packages/runner-orchestrator/src/coding-executor-host.ts";
import { CODING_COMPUTER_RPCS } from "../../packages/runner-orchestrator/src/coding-computer-controller.ts";

const METHODS = new Set<string>([...CODING_EXECUTOR_RPCS, ...CODING_HOST_RPCS, ...CODING_COMPUTER_RPCS, "qorpera_authorize_coding_command"]);
const PAID_METHODS = new Set<string>(CODING_COMPUTER_RPCS);

/** Service-role custody lives only in this dedicated control process. All
 * requests use a fixed origin and closed RPC set, without mutation retries. */
export class CodingExecutorHttpControl {
	readonly #origin: string;
	readonly #key: string;
	readonly #fetch: typeof fetch;
	readonly #computerExecutorSecret: string | undefined;
	constructor(options: { supabaseUrl: string; serviceRoleKey: string; computerExecutorSecret?: string; fetch?: typeof fetch }) {
		const url = new URL(options.supabaseUrl);
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
			!options.serviceRoleKey || /[\r\n\0]/.test(options.serviceRoleKey)) throw new Error("CODING_CONTROL_CONFIG_INVALID");
		this.#origin = url.origin;
		this.#key = options.serviceRoleKey;
		this.#fetch = options.fetch ?? fetch;
		if (options.computerExecutorSecret !== undefined && !/^[A-Za-z0-9_-]{43,128}$/.test(options.computerExecutorSecret))
			throw new Error("CODING_CONTROL_COMPUTER_KEY_INVALID");
		this.#computerExecutorSecret = options.computerExecutorSecret;
	}
	async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (!METHODS.has(method)) throw new Error("CODING_CONTROL_METHOD_INVALID");
		if (PAID_METHODS.has(method) && !this.#computerExecutorSecret) throw new Error("CODING_CONTROL_COMPUTER_KEY_REQUIRED");
		const body = JSON.stringify(PAID_METHODS.has(method) ? { ...args, p_executor_secret: this.#computerExecutorSecret } : args);
		if (Buffer.byteLength(body) > 128 * 1024) throw new Error("CODING_CONTROL_REQUEST_TOO_LARGE");
		const checked = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
		try {
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST", redirect: "error", signal: checked,
				headers: { ...supabaseServiceHeaders(this.#key), "content-type": "application/json" }, body,
			});
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				throw new Error("unconfirmed");
			}
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 256 * 1024, checked))) as unknown;
		} catch {
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		}
	}
}
