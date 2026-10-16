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
	// The chat image route (20260930260000): a member's begin of one image, and the read of a posted one.
	| "qorpera_room_image_begin"
	| "qorpera_room_image_download"
	// The member commit route's writer check (folder core C4, P34a): the member's own actor, from their token.
	| "qorpera_member_folder_writer";

export type MemberCompanyPublisherRpc =
	| "qorpera_native_presence_subject"
	// The chat image route's save of an image it staged as the platform.
	| "qorpera_room_image_commit"
	// The vault's connection-file writer (connection-files.ts, P22b): its claim and finish, and the folder core's
	// platform staging, read and commit.
	| "qorpera_claim_connection_file"
	| "qorpera_finish_connection_file"
	// A coding turn's results.md writer (coding-results-files.ts, C3d): its claim and finish.
	| "qorpera_claim_coding_results_file"
	| "qorpera_finish_coding_results_file"
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
	| "qorpera_folder_company_creation_fail"
	// Its kick of the follow-up queue for the new Co-Founder (P15).
	| "qorpera_folder_follow_up_now"
	// The memory message eraser (memory-message-eraser.ts, M3): its queue and its take, its four steps and step 2's plan.
	| "qorpera_memory_message_erase_due"
	| "qorpera_memory_message_erase_take"
	| "qorpera_memory_message_erase_open"
	| "qorpera_memory_message_erase_plan"
	| "qorpera_memory_message_erase_rewrite"
	| "qorpera_memory_message_erase_ask"
	| "qorpera_memory_message_erase_scrub";

export interface MemberCompanyAuthority {
	member(
		method: MemberCompanyRpc,
		token: string,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
	publisher(method: MemberCompanyPublisherRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
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
				// Never inspect a denial body. A very short, bounded error-code read distinguishes one company's
				// state or lock conflict from the database's health; a missing or unreadable body stays a
				// dependency failure. One of the company's limits (54000: an input's images, its hooks) refuses this
				// request only, as 413.
				if (response.status === 500) {
					const code = await postgrestErrorCode(response, combined);
					throw code === "54000" ? new ObjectDependencyError(413) : companyStateFailure(code);
				}
				void response.body?.cancel().catch(() => undefined);
				throw new ObjectDependencyError(response.status);
			}
			if (response.status === 204) return null;
			const bytes = await readBoundedObjectResponse(response, 8 * 1024 * 1024, combined);
			combined.throwIfAborted();
			return bytes.length ? (JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown) : null;
		}, signal);
	}
}
