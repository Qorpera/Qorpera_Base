import { companyComputerRequest } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { readBoundedCloudResponse, supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

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
	"qorpera_runtime_office_privacy_status",
	"qorpera_runtime_office_supervisor_status",
	"qorpera_report_runtime_office_shell_activity",
	"qorpera_redeem_runtime_office_viewer",
	"qorpera_check_runtime_office_viewer",
	"qorpera_admit_runtime_office_viewer_input_window",
	"qorpera_release_runtime_office_viewer",
] as const;
export type CompanyComputerRegistryMethod = (typeof methods)[number];

/**
 * The registry gave no answer: the network, a timeout, a server that could not
 * serve the request (5xx, 408, 425, 429 without a database error), a body cut
 * off or over its bound, or a
 * database error that says "try again" (connection, rollback, resources, lock
 * wait, cancelled statement). It is not a refusal. Both keep the code
 * OFFICE_REGISTRY_UNCONFIRMED.
 */
export class CompanyComputerRegistryUnansweredError extends Error {
	constructor(cause: unknown) {
		super("OFFICE_REGISTRY_UNCONFIRMED", { cause });
		this.name = "CompanyComputerRegistryUnansweredError";
	}
}

/** The registry answered and refused: SQL raised, or any other 4xx. */
class CompanyComputerRegistryRefusedError extends Error {
	constructor(cause: unknown) {
		super("OFFICE_REGISTRY_UNCONFIRMED", { cause });
		this.name = "CompanyComputerRegistryRefusedError";
	}
}

/** SQLSTATE classes (and codes) that report a passing condition, not a decision:
 * connection, rollback, resources, operator intervention, lock wait, and a
 * read-only transaction (seen during a database failover). */
const transientSqlState = /^(08|40|53|57)|^(55P03|25006)$/;

/** How long a desktop, or its browser, outlasts a registry that does not answer. */
export const COMPANY_COMPUTER_UNANSWERED_GRACE_MS = 30_000;
/** The largest request body the registry transport sends (its arguments as JSON, in bytes). */
export const COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES = 128 * 1024;

/**
 * Whether a failed authority check only lacked an answer: an unanswered
 * registry call, or a local deadline around one. A clear refusal, and anything
 * this cannot recognize, is not. Nothing is authorized by an unanswered check;
 * the caller only decides whether to wait for the next one before tearing down.
 */
export function companyComputerAuthorityUnanswered(error: unknown): boolean {
	const pending = [error];
	const seen = new Set<unknown>();
	let unanswered = false;
	for (let index = 0; pending.length && index < 32; index++) {
		const current = pending.shift();
		if (seen.has(current) || !(current instanceof Error)) continue;
		seen.add(current);
		// A refusal anywhere in the chain wins over a missing answer elsewhere.
		if (current instanceof CompanyComputerRegistryRefusedError) return false;
		if (
			current instanceof CompanyComputerRegistryUnansweredError ||
			(current instanceof CloudRuntimeDiagnosticError && current.category === "timeout") ||
			current.message === "COMPUTER_REQUEST_STOPPED"
		)
			unanswered = true;
		if (current.cause !== undefined) pending.push(current.cause);
		if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 16));
	}
	return unanswered;
}

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
		if (Buffer.byteLength(body) > COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES)
			throw new Error("OFFICE_REGISTRY_REQUEST_TOO_LARGE");
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
						// Only the SQLSTATE is kept from the body, never its message or details.
						let sqlState: string | undefined;
						try {
							const failure: unknown = JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							);
							const code =
								failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
							if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) sqlState = code;
						} catch {
							void response.body?.cancel().catch(() => undefined);
						}
						throw Object.assign(new Error("denied"), { status: response.status, sqlState });
					}
					const bytes = await readBoundedCloudResponse(response, 64 * 1024, requestSignal);
					requestSignal.throwIfAborted();
					// A complete body that is not an object is still the registry's answer.
					let value: unknown;
					try {
						value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
					} catch {
						value = undefined;
					}
					if (!value || typeof value !== "object" || Array.isArray(value))
						throw Object.assign(new Error("invalid response"), { answered: true });
					return value;
				},
				signal,
				3000,
			);
		} catch (error) {
			// Never disclose SQL diagnostics, profile/input content or credentials.
			const status = error instanceof Error && "status" in error ? error.status : undefined;
			const sqlState = error instanceof Error && "sqlState" in error ? error.sqlState : undefined;
			if (typeof sqlState === "string" && transientSqlState.test(sqlState))
				throw new CompanyComputerRegistryUnansweredError(error);
			if (
				(error instanceof Error && "answered" in error) ||
				typeof sqlState === "string" ||
				(typeof status === "number" && status >= 400 && status < 500 && ![408, 425, 429].includes(status))
			)
				throw new CompanyComputerRegistryRefusedError(error);
			throw new CompanyComputerRegistryUnansweredError(error);
		}
	}
}
