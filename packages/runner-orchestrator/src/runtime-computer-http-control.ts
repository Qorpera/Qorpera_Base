import type { ServiceHttpFetch } from "./http-transport.ts";
import { OFFICE_COMPUTER_OUTAGE_RPC } from "./lxd-office-computer-outage.ts";
import { OFFICE_OUTAGE_RECOVERY_RPCS } from "./lxd-office-outage-recovery-control.ts";
import { readLxdOfficeCredentialFile } from "./lxd-office-physical-host.ts";
import { nodeHttpFetch } from "./node-http-fetch.ts";
import { RUNTIME_COMPUTER_RPCS } from "./runtime-computer-controller.ts";

const METHODS = new Set<string>([
	...RUNTIME_COMPUTER_RPCS,
	"qorpera_paid_office_admission",
	OFFICE_COMPUTER_OUTAGE_RPC,
	...OFFICE_OUTAGE_RECOVERY_RPCS,
	"qorpera_prepare_runtime_office_outage_termination",
	"qorpera_ack_runtime_office_outage_termination",
	"qorpera_check_runtime_office_outage_configuration",
	"qorpera_prepare_runtime_office_outage_successor",
	"qorpera_runtime_office_outage_successor_status",
	"qorpera_check_runtime_office_outage_successor",
	"qorpera_activate_runtime_office_outage_successor",
]);
const LIMIT = 65536;

/** Host-local credential only. The existing protected reader validates root
 * custody, local filesystem, primary-group access and concurrent replacement. */
export async function readRuntimeComputerExecutorSecret(path: string): Promise<string> {
	const bytes = await readLxdOfficeCredentialFile(path, 256);
	try {
		const value = new TextDecoder("utf8", { fatal: true }).decode(bytes).trim();
		if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new Error("RUNTIME_COMPUTER_CREDENTIAL_INVALID");
		return value;
	} finally {
		bytes.fill(0);
	}
}

/** Narrow host-only capability transport. A service JWT alone cannot fund or
 * admit paid execution. Never route this object into a guest/bootstrap. */
export class RuntimeComputerHttpControl {
	readonly #origin: string;
	readonly #key: string;
	readonly #secret: string;
	readonly #fetch: ServiceHttpFetch;
	constructor(
		config: { supabaseUrl: string; supabaseServiceKey: string; executorSecret: string },
		fetchImplementation: ServiceHttpFetch = nodeHttpFetch,
	) {
		try {
			const url = new URL(config.supabaseUrl);
			if (
				url.protocol !== "https:" ||
				url.origin !== config.supabaseUrl ||
				config.executorSecret === config.supabaseServiceKey ||
				!/^[A-Za-z0-9_.-]{32,4096}$/.test(config.supabaseServiceKey) ||
				!/^[A-Za-z0-9_-]{43,128}$/.test(config.executorSecret)
			)
				throw new Error();
			this.#origin = url.origin;
			this.#key = config.supabaseServiceKey;
			this.#secret = config.executorSecret;
			this.#fetch = fetchImplementation;
		} catch {
			throw new Error("RUNTIME_COMPUTER_CONTROL_INVALID");
		}
	}
	async call(method: string, args: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
		caller.throwIfAborted();
		if (!METHODS.has(method)) throw new Error("RUNTIME_COMPUTER_RPC_FORBIDDEN");
		if (
			!args ||
			Object.keys(args).join() !== "p_request" ||
			!args.p_request ||
			typeof args.p_request !== "object" ||
			Array.isArray(args.p_request)
		)
			throw new Error("RUNTIME_COMPUTER_REQUEST_INVALID");
		try {
			const body = JSON.stringify({ p_request: args.p_request, p_executor_secret: this.#secret });
			if (Buffer.byteLength(body) > LIMIT) throw new Error();
			const signal = AbortSignal.any([caller, AbortSignal.timeout(15000)]);
			const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST",
				redirect: "error",
				signal,
				headers: {
					apikey: this.#key,
					authorization: `Bearer ${this.#key}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body,
			});
			signal.throwIfAborted();
			if (
				response.status !== 200 ||
				!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
			)
				throw new Error();
			const encoded = await response.arrayBuffer();
			signal.throwIfAborted();
			if (encoded.byteLength > LIMIT) throw new Error();
			const length = response.headers.get("content-length");
			if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) !== encoded.byteLength))
				throw new Error();
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(encoded));
		} catch {
			// Cloud errors can contain request bodies or secrets. Keep them out of
			// provider diagnostics; recover via describe with the retained identity.
			throw new Error("RUNTIME_COMPUTER_RPC_UNCONFIRMED");
		}
	}
}
