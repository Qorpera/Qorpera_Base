import type { ServiceHttpFetch } from "./http-transport.ts";

/** G2-3e: the shared execution service's own database calls, and the entry point (statement budget) of each, as
 * qorpera_execution_host_calls (migration 20260930011000) lists them. The release sets 25 s itself. */
export const EXECUTION_HOST_CALLS: ReadonlyMap<string, "standard" | "long"> = new Map<string, "standard" | "long">([
	["qorpera_provision_execution_runner", "standard"],
	["qorpera_reserve_runtime_machine", "standard"],
	["qorpera_release_runtime_machine", "long"],
	["qorpera_runtime_ended_runners", "standard"],
	["qorpera_identity_recovery_runtime_state", "standard"],
	["qorpera_compute_identity_login_in_vault", "standard"],
	["qorpera_bind_native_identity_credential", "standard"],
]);

/** The execution host's own credential: its host id, the credential the node host bound to it, and the project's
 * publishable key. */
export interface ExecutionHostCredential {
	readonly hostId: string;
	readonly credential: string;
	readonly publishableKey: string;
}

const HOST_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RPC_PATH = /^\/rest\/v1\/rpc\/([a-z0-9_]{1,128})$/;

/** Whether the arguments are exactly one JSON object, so splicing them keeps the envelope's own keys. */
function isJsonObject(text: string): boolean {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value);
	} catch {
		return false;
	}
}

function publishableHeaders(publishableKey: string): Record<string, string> {
	const headers: Record<string, string> = { apikey: publishableKey, "content-type": "application/json" };
	if (publishableKey.startsWith("eyJ") && publishableKey.split(".").length === 3)
		headers.authorization = `Bearer ${publishableKey}`;
	return headers;
}

/** The service's fetch with its own credential: each listed call goes through the execution host's entry point of
 * its budget, with the publishable key, the host id and the credential, never the service key; any other request to
 * the database origin is refused here. Requests to other origins (the slots' loopback ports) go out unchanged. */
export function executionHostFetch(
	supabaseUrl: string,
	host: ExecutionHostCredential,
	fetchImplementation: ServiceHttpFetch,
): ServiceHttpFetch {
	const origin = new URL(supabaseUrl).origin;
	if (!HOST_PATTERN.test(host.hostId)) throw new Error("Execution host id is invalid");
	if (!TOKEN_PATTERN.test(host.credential)) throw new Error("Execution host credential is invalid");
	if (!host.publishableKey || /[\0\r\n]/.test(host.publishableKey))
		throw new Error("Execution host calls need the project's publishable key");
	return async (input, init) => {
		const url = new URL(input);
		if (url.origin !== origin) return fetchImplementation(input, init);
		const name = RPC_PATH.exec(url.pathname)?.[1];
		const budget = name === undefined ? undefined : EXECUTION_HOST_CALLS.get(name);
		if (name === undefined || budget === undefined) throw new Error("Not an execution host call");
		if (init?.method !== "POST" || typeof init.body !== "string" || url.search || !isJsonObject(init.body))
			throw new Error("Execution host call is malformed");
		const entry = budget === "long" ? "qorpera_execution_host_call_long" : "qorpera_execution_host_call";
		// The original arguments are spliced in as sent, so no value is re-encoded on the way.
		const body = `{"p_host_id":${JSON.stringify(host.hostId)},"p_credential":${JSON.stringify(host.credential)},"p_name":${JSON.stringify(name)},"p_args":${init.body}}`;
		// The credential is in the body: never re-sent to wherever a redirect points.
		return fetchImplementation(`${origin}/rest/v1/rpc/${entry}`, {
			...init,
			redirect: "error",
			headers: publishableHeaders(host.publishableKey),
			body,
		});
	};
}
