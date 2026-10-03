import { supabaseServiceHeaders } from "@qorpera/cloud-client/cloud-request";
import { UUID_PATTERN } from "@qorpera/contracts";

/** G2-2 and G2-3: the native host reaches the database without the service key. A call it makes inside a job goes
 * through the entry points of migration 20260928409985 with the publishable key and that job's lease token, so it acts
 * for that job's run only; a call it makes between jobs goes through qorpera_native_identity_call (migration
 * 20260930005000) with the holder's identity credential. Any other database call is refused here. Storage and
 * Realtime keep the service key until G2-4. */

/** The native host's calls inside a job, and the entry point (statement budget) of each: qorpera_native_host_calls as
 * migrations 20260928409985, 20260928429982 (find_mail), 20260928429984 (save_attachment), 20260929999965
 * (company_account) and 20260929999970 (the run's folder view) list them, without the two identity calls, which the
 * host makes between jobs (G2-3). */
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
	["qorpera_folder_run_view_open", "standard"],
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

/** The database calls the host makes between jobs (its identity's recovery state and vault custody, the account
 * metadata loop, a login guest's sign-in and account refresh), as qorpera_native_identity_calls lists them (migration
 * 20260930005000). They go through qorpera_native_identity_call with the holder's identity credential, which the node
 * host bound to the holder's machine; the entry point allows each holder kind only its own. */
export const NATIVE_HOST_IDENTITY_CALLS: ReadonlySet<string> = new Set([
	"qorpera_complete_native_account_refresh",
	"qorpera_complete_native_provider_login",
	"qorpera_compute_identity_login_in_vault",
	"qorpera_describe_native_account_refresh_route",
	"qorpera_describe_native_provider_login",
	"qorpera_identity_recovery_runtime_state",
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

/** What a job brings for its calls: the runner job's lease token and the project's publishable key, and on an
 * execution host's slot the identity credential of this run's machine (a warm host's next run is a new machine). */
export interface NativeHostJobCredential {
	readonly leaseToken: string;
	readonly publishableKey: string;
	readonly identityCredential?: string;
}

/** The holder's identity credential (G2-3): its identity, the credential the node host bound to its machine, and the
 * project's publishable key. */
export interface NativeHostIdentityCredential {
	readonly computeIdentityId: string;
	readonly credential: string;
	readonly publishableKey: string;
}

const RPC_PATH = /^\/rest\/v1\/rpc\/([a-z0-9_]{1,128})$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

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
	readonly fetch: typeof fetch;
	readonly #origin: string;
	readonly #serviceKey: string;
	readonly #fetch: typeof fetch;
	#identity: NativeHostIdentityCredential;
	#job: { jobId: string; leaseToken: string; publishableKey: string } | undefined;

	constructor(options: {
		supabaseUrl: string;
		serviceKey: string;
		identity: NativeHostIdentityCredential;
		fetch?: typeof fetch;
	}) {
		this.#origin = new URL(options.supabaseUrl).origin;
		this.#serviceKey = options.serviceKey;
		this.#identity = checkedIdentity(options.identity, options.serviceKey);
		this.#fetch = options.fetch ?? fetch;
		this.fetch = (input, init) => this.#dispatch(input, init);
	}

	/** Holds the job's credential while the job runs. The returned release drops it, also on a warm host whose next
	 * job brings its own. A job that brings its machine's identity credential (an execution host's slot) replaces the
	 * host's: the previous run's machine is released, so its credential no longer works. */
	begin(jobId: string, credential: NativeHostJobCredential | undefined): () => void {
		if (!UUID_PATTERN.test(jobId) || !credential || !LEASE_TOKEN.test(credential.leaseToken))
			throw new NativeHostCredentialError("NATIVE_HOST_CREDENTIAL", "Native host calls need the job's lease token");
		if (!isNativeHostPublishableKey(credential.publishableKey) || credential.publishableKey === this.#serviceKey)
			throw new NativeHostCredentialError(
				"NATIVE_HOST_CREDENTIAL",
				"Native host calls need the project's publishable key",
			);
		if (credential.identityCredential !== undefined && !LEASE_TOKEN.test(credential.identityCredential))
			throw new NativeHostCredentialError("NATIVE_HOST_CREDENTIAL", "Native host identity credential is invalid");
		if (this.#job)
			throw new NativeHostCredentialError("NATIVE_HOST_BUSY", "Native host calls already serve another job");
		if (credential.identityCredential !== undefined)
			this.#identity = { ...this.#identity, credential: credential.identityCredential };
		const held = { jobId, leaseToken: credential.leaseToken, publishableKey: credential.publishableKey };
		this.#job = held;
		return () => {
			if (this.#job === held) this.#job = undefined;
		};
	}

	async #dispatch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const url = new URL(input instanceof Request ? input.url : input);
		// Another origin, or not a database call (Storage and Realtime, until G2-4): sent as before.
		if (url.origin !== this.#origin || !url.pathname.startsWith("/rest/")) return this.#fetch(input, init);
		const name = RPC_PATH.exec(url.pathname)?.[1];
		const identityCall = name !== undefined && NATIVE_HOST_IDENTITY_CALLS.has(name);
		const budget = name === undefined || identityCall ? undefined : NATIVE_HOST_CALLS.get(name);
		// Any other database call is a listed call through an entry point, or refused: never the service key.
		if (name === undefined || (!identityCall && budget === undefined)) throw new Error("Not a native host call");
		if (input instanceof Request || init?.method !== "POST" || typeof init.body !== "string" || url.search)
			throw new Error("Native host call is malformed");
		const headers = new Headers(init.headers);
		headers.delete("apikey");
		headers.delete("authorization");
		headers.set("content-type", "application/json");
		if (identityCall) {
			const identity = this.#identity;
			for (const [header, value] of Object.entries(supabaseServiceHeaders(identity.publishableKey)))
				headers.set(header, value);
			// The original arguments are spliced in as sent, so no value is re-encoded on the way.
			const body = `{"p_compute_identity_id":${JSON.stringify(identity.computeIdentityId)},"p_credential":${JSON.stringify(identity.credential)},"p_name":${JSON.stringify(name)},"p_args":${init.body}}`;
			return this.#fetch(`${this.#origin}/rest/v1/rpc/qorpera_native_identity_call`, {
				...init,
				redirect: "error",
				headers,
				body,
			});
		}
		const job = this.#job;
		if (!job) throw new Error("Native host call outside a job");
		for (const [header, value] of Object.entries(supabaseServiceHeaders(job.publishableKey)))
			headers.set(header, value);
		const entry = budget === "long" ? "qorpera_native_host_call_long" : "qorpera_native_host_call";
		// The original arguments are spliced in as sent, so no value is re-encoded on the way.
		const body = `{"p_job_id":${JSON.stringify(job.jobId)},"p_job_lease_token":${JSON.stringify(job.leaseToken)},"p_name":${JSON.stringify(name)},"p_args":${init.body}}`;
		return this.#fetch(`${this.#origin}/rest/v1/rpc/${entry}`, { ...init, redirect: "error", headers, body });
	}
}

/** The holder's identity credential, checked once: a uuid identity, a 43-character credential and the project's
 * publishable key, never the service key. */
function checkedIdentity(identity: NativeHostIdentityCredential, serviceKey: string): NativeHostIdentityCredential {
	if (
		!UUID_PATTERN.test(identity.computeIdentityId) ||
		!LEASE_TOKEN.test(identity.credential) ||
		!isNativeHostPublishableKey(identity.publishableKey) ||
		identity.publishableKey === serviceKey
	)
		throw new NativeHostCredentialError("NATIVE_HOST_CREDENTIAL", "Native host identity credential is invalid");
	return { ...identity };
}
