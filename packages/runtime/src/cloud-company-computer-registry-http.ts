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
	// G2-6c: the office receiver's lease proof (migration 20260930152000); it answers a plain true.
	"qorpera_native_binding_proven",
	// F3 4d: a desktop's folder view (migration 20260928259230), opened for whoever holds its screen.
	"qorpera_folder_view_open",
	"qorpera_folder_view_close",
	// F3 4f-2b: a desktop view's commits for its report (migration 20260930495000).
	"qorpera_folder_view_commits",
	// E3c-3: where a vault_capture's box goes, read by the office itself (migration 20260930344000); it writes nothing.
	"qorpera_native_office_hook_capture",
	// F3 4d-4e: a run's take-in of a command's view reads, before its output reaches that run (migration 20260930491000).
	"qorpera_folder_office_inherit_command_reads",
] as const;
export type CompanyComputerRegistryMethod = (typeof methods)[number];

/**
 * Why the core refused a desktop's or a shell command's folder view, in its own words, when they are one of these: the
 * office passes them on to the run or member it gives the screen back to, or to the run whose command did not start
 * (RUNTIME-FOLDER-COMPANY-MACHINES.md, "A desktop's mount").
 */
const FOLDER_VIEW_REFUSALS = new Set([
	"Folder core authority is required",
	"Company folder is unavailable",
	"Folder view holder is not current",
	"Folder view command is not current",
	"Folder view computer is unavailable",
	"Folder view principals are unavailable",
	"Folder view needs the company-wide view",
	"Folder views open at read committed",
	"Folder view is invalid",
	"Folder view opener is invalid",
	"Folder view anchor is invalid",
]);

/**
 * Why the core refused a run's take-in of a command's view reads, in its own words, when they are one of these: the
 * office tells that run why the command's output is held back from it (RUNTIME-FOLDER-COMPANY-MACHINES.md, "A command
 * that outlived its run").
 */
const FOLDER_INHERIT_REFUSALS = new Set([
	"Folder core authority is required",
	"Company folder is unavailable",
	"Folder releases run at read committed",
	"Folder inheritance is invalid",
	"Folder inheritance read is not current",
	"Folder actor is invalid",
	"Run is unavailable",
	"Company execution is paused",
	"Inherit id was used for another view",
	"A run inherits only its own agent's and member's views",
	"A released read is no longer readable",
]);

/** The methods whose refusals keep their reason, and the reasons kept. Any other text, and every other method's, is never kept. */
const KEPT_REFUSALS: Partial<Record<CompanyComputerRegistryMethod, ReadonlySet<string>>> = {
	qorpera_folder_view_open: FOLDER_VIEW_REFUSALS,
	qorpera_folder_office_inherit_command_reads: FOLDER_INHERIT_REFUSALS,
};

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
	/** The core's reason for refusing a folder view or a take-in, from KEPT_REFUSALS. */
	readonly reason: string | undefined;
	constructor(cause: unknown, reason?: string) {
		super("OFFICE_REGISTRY_UNCONFIRMED", { cause });
		this.name = "CompanyComputerRegistryRefusedError";
		this.reason = reason;
	}
}

/** Whether the registry answered a call and refused it; none of a refusal's text but `reason`. */
export function companyComputerRegistryRefusal(error: unknown): { readonly reason?: string } | undefined {
	if (!(error instanceof CompanyComputerRegistryRefusedError)) return undefined;
	return error.reason === undefined ? {} : { reason: error.reason };
}

/** SQLSTATE classes (and codes) that report a passing condition, not a decision:
 * connection, rollback, resources, operator intervention, lock wait, and a
 * read-only transaction (seen during a database failover). */
const transientSqlState = /^(08|40|53|57)|^(55P03|25006)$/;

/** The largest answer the registry transport reads, in bytes. A page of a view's commits lists every unit of each
 * commit in it, and one commit holds up to 1000. */
const answerBytes = (method: CompanyComputerRegistryMethod): number =>
	method === "qorpera_folder_view_commits" ? 8 * 1024 * 1024 : 64 * 1024;

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
						// Only the SQLSTATE is kept from the body, never its details, and its message only when it is
						// one of its method's known refusals.
						let sqlState: string | undefined;
						let reason: string | undefined;
						try {
							const failure: unknown = JSON.parse(
								new TextDecoder("utf-8", { fatal: true }).decode(
									await readBoundedCloudResponse(response, 4096, requestSignal),
								),
							);
							const code =
								failure && typeof failure === "object" && "code" in failure ? failure.code : undefined;
							if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) sqlState = code;
							const message =
								failure && typeof failure === "object" && "message" in failure ? failure.message : undefined;
							if (sqlState && typeof message === "string" && KEPT_REFUSALS[method]?.has(message))
								reason = message;
						} catch {
							void response.body?.cancel().catch(() => undefined);
						}
						throw Object.assign(new Error("denied"), { status: response.status, sqlState, reason });
					}
					const bytes = await readBoundedCloudResponse(response, answerBytes(method), requestSignal);
					requestSignal.throwIfAborted();
					// A complete body that is not an object is still the registry's answer.
					let value: unknown;
					try {
						value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
					} catch {
						value = undefined;
					}
					if (
						!(value && typeof value === "object" && !Array.isArray(value)) &&
						!(method === "qorpera_native_binding_proven" && value === true)
					)
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
			const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
			if (typeof sqlState === "string" && transientSqlState.test(sqlState))
				throw new CompanyComputerRegistryUnansweredError(error);
			if (
				(error instanceof Error && "answered" in error) ||
				typeof sqlState === "string" ||
				(typeof status === "number" && status >= 400 && status < 500 && ![408, 425, 429].includes(status))
			)
				throw new CompanyComputerRegistryRefusedError(error, typeof reason === "string" ? reason : undefined);
			throw new CompanyComputerRegistryUnansweredError(error);
		}
	}
}
