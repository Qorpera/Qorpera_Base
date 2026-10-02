import { supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import { UUID_PATTERN } from "@qorpera/contracts";

/** G2-2: how the native host reaches the database inside a job. `off` sends every call with the service key, as
 * before. `on` sends the calls it makes inside a job through the entry points of migration 20260929999500, with the
 * publishable key and that job's lease token, so they act for that job's run only. The orchestrators do not pass
 * QORPERA_NATIVE_HOST_DISPATCH to the hosts they start, so the supported switch is this one line and a runtime
 * release; the setting serves a host started by hand. */
export const NATIVE_HOST_DISPATCH_DEFAULT: NativeHostDispatchMode = "off";

export type NativeHostDispatchMode = "off" | "on";

/** The native host's calls inside a job, and the entry point (statement budget) of each: qorpera_native_host_calls as
 * migrations 20260928409985, 20260929999920 (find_mail), 20260929999940 (save_attachment) and 20260929999965
 * (company_account) list them, without the two
 * identity calls, which the host makes between jobs (G2-3). */
export const NATIVE_HOST_CALLS: ReadonlyMap<string, "standard" | "long"> = new Map<string, "standard" | "long">([
	["qorpera_add_agent_review_rule", "standard"],
	["qorpera_append_native_interaction_request", "standard"],
	["qorpera_apply_company_path_approval", "standard"],
	["qorpera_apply_company_path_approval_v3", "standard"],
	["qorpera_assert_company_path_reads", "standard"],
	["qorpera_assert_native_connector_operation", "standard"],
	["qorpera_assert_native_office_captures", "standard"],
	["qorpera_authorize_coding_turn", "standard"],
	["qorpera_await_action_review", "standard"],
	["qorpera_begin_action_review", "standard"],
	["qorpera_begin_native_coding_execution", "standard"],
	["qorpera_begin_native_company_execution_v2", "standard"],
	["qorpera_begin_native_tool_operation", "standard"],
	["qorpera_check_company_path_mutation", "standard"],
	["qorpera_commit_company_path_mutation", "standard"],
	["qorpera_company_machines_available", "standard"],
	["qorpera_company_presence_scope", "standard"],
	["qorpera_complete_native_tool_operation", "standard"],
	["qorpera_confirm_agent_todo_publication", "standard"],
	["qorpera_confirm_company_path_read", "standard"],
	["qorpera_decide_agent_routine", "standard"],
	["qorpera_describe_agent_open_work", "standard"],
	["qorpera_describe_company_run_context", "standard"],
	["qorpera_describe_native_tool_authority", "standard"],
	["qorpera_fence_native_context", "standard"],
	["qorpera_find_agent_mail", "standard"],
	["qorpera_find_company_accounts", "standard"],
	["qorpera_folder_agent_routines", "standard"],
	["qorpera_folder_agent_todos", "standard"],
	["qorpera_folder_commit", "standard"],
	["qorpera_folder_complete_run_receipt", "standard"],
	["qorpera_folder_list", "standard"],
	["qorpera_folder_open_upload", "standard"],
	["qorpera_folder_read", "standard"],
	["qorpera_folder_record_release", "standard"],
	["qorpera_folder_record_review", "standard"],
	["qorpera_folder_renew_upload", "standard"],
	["qorpera_folder_seal_upload", "standard"],
	["qorpera_list_agent_event_hooks", "standard"],
	["qorpera_list_company_paths", "standard"],
	["qorpera_list_company_paths_v2", "standard"],
	["qorpera_list_native_connector_tools", "standard"],
	["qorpera_manage_agent_routine", "standard"],
	["qorpera_manage_agent_sidebar", "standard"],
	["qorpera_manage_agent_todo", "standard"],
	["qorpera_manage_agent_worker", "standard"],
	["qorpera_native_company_file_write", "standard"],
	["qorpera_native_company_file_write_source", "standard"],
	["qorpera_native_machine_manage", "standard"],
	["qorpera_native_machine_start", "standard"],
	["qorpera_native_mail_attachment", "standard"],
	["qorpera_native_office_capture", "standard"],
	["qorpera_native_office_descriptor", "standard"],
	["qorpera_native_office_operation", "standard"],
	["qorpera_native_office_screen", "standard"],
	["qorpera_native_office_start", "standard"],
	["qorpera_native_office_start_descriptor", "standard"],
	["qorpera_native_presence_forget", "standard"],
	["qorpera_native_presence_register", "standard"],
	["qorpera_native_presence_subject", "standard"],
	["qorpera_prepare_company_path_approval", "standard"],
	["qorpera_prepare_company_path_mutation", "standard"],
	["qorpera_prepare_routine_login", "standard"],
	["qorpera_read_agent_event", "standard"],
	["qorpera_read_coding_turn_context", "standard"],
	["qorpera_read_company_path", "standard"],
	["qorpera_read_company_path_v2", "standard"],
	["qorpera_read_company_run_context", "standard"],
	["qorpera_read_native_office_capture", "standard"],
	["qorpera_read_native_wake", "standard"],
	["qorpera_record_action_review", "standard"],
	["qorpera_record_coding_context_view", "standard"],
	["qorpera_record_native_context_view", "standard"],
	["qorpera_record_provider_usage_signal", "standard"],
	["qorpera_record_runtime_observation_batch", "standard"],
	["qorpera_report_worker_result", "standard"],
	["qorpera_self_approve_organization_proposal", "standard"],
	["qorpera_send_agent_mail", "standard"],
	["qorpera_send_coworker_message", "standard"],
	["qorpera_send_native_agent_message", "standard"],
	["qorpera_submit_coding_turn", "standard"],
	["qorpera_validate_native_provider_execution_lease", "long"],
	["qorpera_verify_company_path_file", "standard"],
	["qorpera_verify_company_path_tree", "standard"],
]);

/** The database calls the host makes between jobs (logins and account refresh), which keep the service key until an
 * identity credential replaces it (G2-3). With the switch on, every other database call is a listed call inside a job
 * or is refused: nothing new reaches the service key unnoticed. Storage and Realtime are not database calls (G2-4). */
export const NATIVE_HOST_KEY_CALLS: ReadonlySet<string> = new Set([
	"qorpera_complete_native_account_refresh",
	"qorpera_complete_native_provider_login",
	"qorpera_describe_native_account_refresh_route",
	"qorpera_describe_native_provider_login",
	"qorpera_list_native_provider_account_refreshes",
	"qorpera_record_native_provider_account_metadata",
]);

/** Why the host refused an execution's credential: a fixed code for the runner's failure (no token or key, or a
 * previous job still holding the host). */
export class NativeHostCredentialError extends Error {
	readonly code: "NATIVE_HOST_CREDENTIAL" | "NATIVE_HOST_BUSY";

	constructor(code: "NATIVE_HOST_CREDENTIAL" | "NATIVE_HOST_BUSY", message: string) {
		super(message);
		this.name = "NativeHostCredentialError";
		this.code = code;
	}
}

/** What a job brings for its calls: the runner job's lease token and the project's publishable key. */
export interface NativeHostJobCredential {
	readonly leaseToken: string;
	readonly publishableKey: string;
}

const RPC_PATH = /^\/rest\/v1\/rpc\/([a-z0-9_]{1,128})$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function nativeHostDispatchMode(value: string | undefined): NativeHostDispatchMode {
	const mode = value ?? NATIVE_HOST_DISPATCH_DEFAULT;
	if (mode !== "off" && mode !== "on") throw new Error("QORPERA_NATIVE_HOST_DISPATCH must be off or on");
	return mode;
}

/** A publishable key: a modern `sb_publishable_` key, or a legacy JWT whose role is anon. Never a secret key. */
export function isNativeHostPublishableKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 4096) return false;
	if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(value)) return true;
	const parts = value.split(".");
	if (parts.length !== 3 || !value.startsWith("eyJ") || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
		return false;
	try {
		const claims: unknown = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
		return typeof claims === "object" && claims !== null && (claims as { role?: unknown }).role === "anon";
	} catch {
		return false;
	}
}

/** One process-level holder: a native host serves one job at a time, and a warm Codex spare started in one job is
 * used by the next, so the credential is the current job's, never carried in an async context. */
export class NativeHostDispatch {
	readonly mode: NativeHostDispatchMode;
	readonly fetch: typeof fetch;
	readonly #origin: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;
	#job: { jobId: string; leaseToken: string; publishableKey: string } | undefined;

	constructor(options: {
		supabaseUrl: string;
		serviceKey: string;
		mode: NativeHostDispatchMode;
		fetch?: typeof fetch;
	}) {
		this.mode = options.mode;
		this.#origin = new URL(options.supabaseUrl).origin;
		this.#serviceKey = options.serviceKey;
		this.#fetch = options.fetch ?? fetch;
		this.fetch = (input, init) => this.#dispatch(input, init);
	}

	/** Holds the job's credential while the job runs. The returned release drops it, also on a warm host whose next
	 * job brings its own. With the switch off nothing is held. */
	begin(jobId: string, credential: NativeHostJobCredential | undefined): () => void {
		if (this.mode === "off") return () => {};
		if (!UUID_PATTERN.test(jobId) || !credential || !LEASE_TOKEN.test(credential.leaseToken))
			throw new NativeHostCredentialError("NATIVE_HOST_CREDENTIAL", "Native host calls need the job's lease token");
		if (!isNativeHostPublishableKey(credential.publishableKey) || credential.publishableKey === this.#serviceKey)
			throw new NativeHostCredentialError(
				"NATIVE_HOST_CREDENTIAL",
				"Native host calls need the project's publishable key",
			);
		if (this.#job)
			throw new NativeHostCredentialError("NATIVE_HOST_BUSY", "Native host calls already serve another job");
		const held = { jobId, leaseToken: credential.leaseToken, publishableKey: credential.publishableKey };
		this.#job = held;
		return () => {
			if (this.#job === held) this.#job = undefined;
		};
	}

	async #dispatch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const url = new URL(input instanceof Request ? input.url : input);
		// Off, another origin, or not a database call (Storage): sent as before.
		if (this.mode === "off" || url.origin !== this.#origin || !url.pathname.startsWith("/rest/"))
			return this.#fetch(input, init);
		const name = RPC_PATH.exec(url.pathname)?.[1];
		if (name !== undefined && NATIVE_HOST_KEY_CALLS.has(name)) return this.#fetch(input, init);
		const budget = name === undefined ? undefined : NATIVE_HOST_CALLS.get(name);
		// Any other database call is a listed call through the entry point, or refused: never the service key.
		if (name === undefined || budget === undefined) throw new Error("Not a native host call");
		const job = this.#job;
		if (!job) throw new Error("Native host call outside a job");
		if (input instanceof Request || init?.method !== "POST" || typeof init.body !== "string" || url.search)
			throw new Error("Native host call is malformed");
		const headers = new Headers(init.headers);
		headers.delete("apikey");
		headers.delete("authorization");
		for (const [header, value] of Object.entries(supabaseServiceHeaders(job.publishableKey)))
			headers.set(header, value);
		headers.set("content-type", "application/json");
		const entry = budget === "long" ? "qorpera_native_host_call_long" : "qorpera_native_host_call";
		// The original arguments are spliced in as sent, so no value is re-encoded on the way.
		const body = `{"p_job_id":${JSON.stringify(job.jobId)},"p_job_lease_token":${JSON.stringify(job.leaseToken)},"p_name":${JSON.stringify(name)},"p_args":${init.body}}`;
		return this.#fetch(`${this.#origin}/rest/v1/rpc/${entry}`, { ...init, headers, body });
	}
}
