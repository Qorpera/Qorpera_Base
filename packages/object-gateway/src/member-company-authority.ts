import {
	companyStateFailure,
	ObjectDependency,
	ObjectDependencyError,
	postgrestErrorCode,
	readBoundedObjectResponse,
} from "./dependency.ts";
import { supabaseRequestHeaders } from "./supabase-headers.ts";

export type MemberCompanyRpc =
	| "qorpera_company_presence_scope"
	| "qorpera_member_file_export_source"
	| "qorpera_begin_member_company_file_upload"
	| "qorpera_begin_member_company_path_command"
	| "qorpera_get_member_company_path_command"
	| "qorpera_review_member_company_path_command"
	| "qorpera_describe_member_company_path_proposal"
	| "qorpera_review_company_path_proposal"
	| "qorpera_authorize_member_company_command_object"
	| "qorpera_authorize_member_company_proposal_object"
	| "qorpera_begin_member_session_attachment_upload"
	| "qorpera_authorize_member_session_attachment"
	// The member commit route's writer check (folder core C4, P34a): the member's own actor, from their token.
	| "qorpera_member_folder_writer";

export type MemberCompanyPublisherRpc =
	| "qorpera_native_presence_subject"
	| "qorpera_claim_company_bootstrap"
	| "qorpera_stage_company_bootstrap_object"
	| "qorpera_finalize_company_bootstrap"
	| "qorpera_prepare_member_company_path_command"
	| "qorpera_apply_member_company_path_command_v3"
	| "qorpera_stage_member_company_path_object"
	| "qorpera_prepare_company_path_approval"
	| "qorpera_apply_company_path_approval_v3"
	| "qorpera_stage_company_path_approval_object"
	| "qorpera_verify_company_path_file"
	| "qorpera_verify_company_path_tree"
	| "qorpera_stage_member_session_attachment"
	// The vault's connection-file writer (connection-files.ts, P22b): its claim and finish, and the folder core's
	// platform staging, read and commit.
	| "qorpera_claim_connection_file"
	| "qorpera_finish_connection_file"
	| "qorpera_folder_authorize_object_download"
	| "qorpera_folder_open_upload"
	| "qorpera_folder_authorize_object_upload"
	| "qorpera_folder_confirm_object"
	| "qorpera_folder_seal_upload"
	| "qorpera_folder_commit"
	// The member commit route's follow-up after a saved commit (F2's P15): a hire's or an archive's work at once.
	| "qorpera_folder_follow_up_commit"
	// Company creation's worker (company-folder-creation.ts, P14b): its claim, create, release and fail.
	| "qorpera_folder_company_creation_claim"
	| "qorpera_folder_company_create"
	| "qorpera_folder_company_creation_release"
	| "qorpera_folder_company_creation_fail";

export interface MemberCompanyAuthority {
	member(
		method: MemberCompanyRpc,
		token: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
	publisher(method: MemberCompanyPublisherRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Only an explicit, rolled-back SQL head conflict permits rebuilding a tree. */
export class MemberCompanyHeadConflict extends ObjectDependencyError {
	constructor() {
		super(409);
	}
}

export class SupabaseMemberCompanyAuthority implements MemberCompanyAuthority {
	readonly #url: string;
	readonly #publishable: string;
	readonly #secret: string;
	readonly #fetch: typeof fetch;
	readonly #dependency: ObjectDependency;

	constructor(options: {
		projectUrl: string;
		publishableKey: string;
		secretKey: string;
		fetch?: typeof fetch;
		requestTimeoutMs?: number;
	}) {
		const url = new URL(options.projectUrl);
		if (
			url.protocol !== "https:" ||
			![url.origin, `${url.origin}/`].includes(options.projectUrl) ||
			[options.publishableKey, options.secretKey].some((key) => !key || key.length > 8192 || /[\0\r\n]/.test(key))
		)
			throw new Error("Invalid Company File authority configuration");
		this.#url = url.origin;
		this.#publishable = options.publishableKey;
		this.#secret = options.secretKey;
		this.#fetch = options.fetch ?? fetch;
		this.#dependency = new ObjectDependency(options.requestTimeoutMs);
	}

	member(
		method: MemberCompanyRpc,
		token: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(token)) throw new ObjectDependencyError(401);
		return this.#rpc(method, args, this.#publishable, token, signal);
	}

	publisher(method: MemberCompanyPublisherRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return this.#rpc(method, args, this.#secret, undefined, signal);
	}

	async #rpc(
		method: MemberCompanyRpc | MemberCompanyPublisherRpc,
		args: Record<string, unknown>,
		apiKey: string,
		token: string | undefined,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		return this.#dependency.run(async (deadline) => {
			const combined = AbortSignal.any([signal, deadline]);
			const response = await this.#fetch(`${this.#url}/rest/v1/rpc/${method}`, {
				method: "POST",
				redirect: "error",
				headers: {
					...supabaseRequestHeaders(apiKey, token),
					"content-type": "application/json",
				},
				body: JSON.stringify(args),
				signal: combined,
			});
			if (!response.ok) {
				// Never inspect a denial body. A very short, bounded error-code read distinguishes an atomic head
				// conflict from a stale path, and one company's state or lock conflict from the database's health.
				// A missing or unreadable body cannot authorize a rebuild and stays a dependency failure.
				if (response.status === 500) throw companyStateFailure(await postgrestErrorCode(response, combined));
				if (response.status !== 409) void response.body?.cancel().catch(() => undefined);
				else if ((await postgrestErrorCode(response, combined)) === "PT409") throw new MemberCompanyHeadConflict();
				throw new ObjectDependencyError(response.status);
			}
			if (response.status === 204) return null;
			const bytes = await readBoundedObjectResponse(response, 8 * 1024 * 1024, combined);
			combined.throwIfAborted();
			return bytes.length ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown) : null;
		}, signal);
	}
}
