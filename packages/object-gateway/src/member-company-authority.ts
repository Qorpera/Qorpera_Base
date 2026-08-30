import {
	boundedObjectOperation,
	ObjectDependency,
	ObjectDependencyError,
	readBoundedObjectResponse,
} from "./dependency.ts";
import { supabaseRequestHeaders } from "./supabase-headers.ts";

export type MemberCompanyRpc =
	| "qorpera_begin_member_company_path_command"
	| "qorpera_get_member_company_path_command"
	| "qorpera_review_member_company_path_command"
	| "qorpera_describe_member_company_path_proposal"
	| "qorpera_review_company_path_proposal"
	| "qorpera_authorize_member_company_command_object"
	| "qorpera_authorize_member_company_proposal_object"
	| "qorpera_begin_member_session_attachment_upload"
	| "qorpera_authorize_member_session_attachment";

export type MemberCompanyPublisherRpc =
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
	| "qorpera_stage_member_session_attachment";

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
				// Never inspect a denial body. A very short, bounded error-code
				// read distinguishes an atomic head conflict from a stale path.
				let code: unknown;
				if (response.status === 409 || response.status === 500) {
					const errorBody = new AbortController();
					try {
						const body: unknown = JSON.parse(
							new TextDecoder().decode(
								await boundedObjectOperation(
									() =>
										readBoundedObjectResponse(response, 4096, AbortSignal.any([combined, errorBody.signal])),
									250,
								),
							),
						);
						if (body && typeof body === "object" && "code" in body) code = body.code;
					} catch {
						// A missing/error body cannot authorize a rebuild.
					} finally {
						errorBody.abort();
					}
				} else void response.body?.cancel().catch(() => undefined);
				if (response.status === 409 && code === "PT409") throw new MemberCompanyHeadConflict();
				if (response.status === 500 && code === "40001") throw new ObjectDependencyError(409);
				throw new ObjectDependencyError(response.status);
			}
			if (response.status === 204) return null;
			const bytes = await readBoundedObjectResponse(response, 8 * 1024 * 1024, combined);
			combined.throwIfAborted();
			return bytes.length ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown) : null;
		});
	}
}
