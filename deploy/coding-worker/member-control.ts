import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import {
	CloudMemberMachineScreenRefusal,
	type CloudMemberMachineScreenRefusalCode,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import {
	CloudMemberMachineScreenForbidden,
	CloudMemberMachineScreenSignIn,
} from "../../packages/runtime/src/cloud-member-machine-screen-http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
/** What the begin answers a look it refuses, which the member's window acts on. */
const REFUSED = new Set(["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW", "SCREEN_TOO_SOON"]);

/** The member's side of a look at a desktop (20260930712000): exactly one call, qorpera_member_machine_screen_begin, made
 * as the member with their own bearer token and the project's publishable key, to the executor's fixed project origin.
 * The database checks the token (PostgREST, auth.uid()); this client only passes it on. The token is never logged,
 * stored or put in an error: every failure is a fixed code. */
export class MemberMachineScreenControl {
	readonly #origin: string;
	readonly #publishableKey: string;
	readonly #fetch: typeof fetch;
	constructor(options: { supabaseUrl: string; publishableKey: string; fetch?: typeof fetch }) {
		const url = new URL(options.supabaseUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!/^[A-Za-z0-9._-]{8,8192}$/.test(options.publishableKey)
		)
			throw new Error("MEMBER_SCREEN_CONTROL_CONFIG_INVALID");
		this.#origin = url.origin;
		this.#publishableKey = options.publishableKey;
		this.#fetch = options.fetch ?? fetch;
	}
	/** Begins one look as the member: its single-use id, or the refusal the window acts on (a machine that is not
	 * running, a disk the member may not see, a look too soon after the last). A token the database does not take is
	 * CloudMemberMachineScreenSignIn; a company or machine that is not the member's, CloudMemberMachineScreenForbidden. */
	async begin(
		token: string,
		look: { companyId: string; machineId: string; confirmed: boolean },
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (!UUID.test(look.companyId) || !UUID.test(look.machineId) || typeof look.confirmed !== "boolean")
			throw new Error("MEMBER_SCREEN_BEGIN_INVALID");
		const checked = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
		let response: Response;
		try {
			response = await this.#fetch(`${this.#origin}/rest/v1/rpc/qorpera_member_machine_screen_begin`, {
				method: "POST",
				redirect: "error",
				signal: checked,
				headers: {
					apikey: this.#publishableKey,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					p_profile_id: look.companyId,
					p_machine_id: look.machineId,
					p_watch: { confirmed: look.confirmed },
				}),
			});
		} catch {
			throw new Error("MEMBER_SCREEN_BEGIN_UNCONFIRMED");
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => undefined);
			// PostgREST answers a token it does not take with 401, and the function's own refusal (42501) with 403.
			if (response.status === 401) throw new CloudMemberMachineScreenSignIn();
			if (response.status === 403) throw new CloudMemberMachineScreenForbidden();
			throw new Error("MEMBER_SCREEN_BEGIN_UNCONFIRMED");
		}
		let answer: Record<string, unknown>;
		try {
			const value = JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 4096, checked)),
			) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			answer = value as Record<string, unknown>;
		} catch {
			throw new Error("MEMBER_SCREEN_BEGIN_UNCONFIRMED");
		}
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-screen/v1" && keys === "schema,state,useId" && answer.state === "ok" &&
			typeof answer.useId === "string" && UUID.test(answer.useId))
			return answer.useId;
		if (answer.schema === "qorpera.member-machine-screen/v1" && keys === "reason,schema,state" && answer.state === "refused" &&
			typeof answer.reason === "string" && REFUSED.has(answer.reason))
			throw new CloudMemberMachineScreenRefusal(answer.reason as CloudMemberMachineScreenRefusalCode);
		throw new Error("MEMBER_SCREEN_BEGIN_INVALID");
	}
}
