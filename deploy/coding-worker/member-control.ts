import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import {
	CloudMemberMachineActRefusal,
	type CloudMemberMachineActRefusalCode,
	CloudMemberMachineScreenRefusal,
	type CloudMemberMachineScreenRefusalCode,
	CloudMemberMachineStartRefusal,
	type CloudMemberMachineStartRefusalCode,
	cloudMemberMachineActRecord,
} from "../../packages/runtime/src/cloud-machine-command-http.ts";
import type { MachineScreenAction } from "../../packages/runtime/src/cloud-machine-screen.ts";
import {
	CloudMemberMachineScreenForbidden,
	CloudMemberMachineScreenSignIn,
} from "../../packages/runtime/src/cloud-member-machine-screen-http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
/** What the begin answers a look it refuses, which the member's window acts on (another member's hold of the desktop,
 * 20260930713000, too). */
const REFUSED = new Set(["MACHINE_NOT_RUNNING", "MACHINE_NEEDS_COMPANY_VIEW", "SCREEN_TOO_SOON", "DESKTOP_MEMBER_IN_CONTROL"]);
/** What the begin of an action answers one it refuses (20260930713000). */
const ACT_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_CONTROL_ENDED",
]);
/** What the begin of a shared action answers one it refuses (20260930734000): anyone's private hold of the desktop, a
 * machine with no desktop, and one member's actions too fast. */
const SHARE_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_ACTIONS_TOO_FAST",
]);
/** What the begin of a start answers one it refuses (20260930714000). */
const START_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_START_TOO_SOON",
]);

/** The member's side of a look at a desktop (20260930712000), of an action on one they hold (20260930713000) or share
 * with the agent (20260930734000) and of a start of one (20260930714000): exactly four calls,
 * qorpera_member_machine_screen_begin, qorpera_member_machine_desktop_act_begin,
 * qorpera_member_machine_desktop_share_begin and qorpera_member_machine_desktop_start_begin, made as the member with
 * their own bearer token and the project's publishable key, to the executor's fixed project origin. The database checks
 * the token (PostgREST, auth.uid()); this client only passes it on. The token is never logged, stored or put in an
 * error: every failure is a fixed code. A typed text never goes here: the action's begin carries its length alone. */
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
	 * running, a disk the member may not see, a look too soon after the last, another member's hold of the desktop). A
	 * token the database does not take is CloudMemberMachineScreenSignIn; a company or machine that is not the member's,
	 * CloudMemberMachineScreenForbidden. */
	async begin(
		token: string,
		look: { companyId: string; machineId: string; confirmed: boolean },
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (!UUID.test(look.companyId) || !UUID.test(look.machineId) || typeof look.confirmed !== "boolean")
			throw new Error("MEMBER_SCREEN_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_screen_begin",
			{ p_profile_id: look.companyId, p_machine_id: look.machineId, p_watch: { confirmed: look.confirmed } },
			"MEMBER_SCREEN_BEGIN",
			signal,
		);
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-screen/v1" && keys === "schema,state,useId" && answer.state === "ok" &&
			typeof answer.useId === "string" && UUID.test(answer.useId))
			return answer.useId;
		if (answer.schema === "qorpera.member-machine-screen/v1" && keys === "reason,schema,state" && answer.state === "refused" &&
			typeof answer.reason === "string" && REFUSED.has(answer.reason))
			throw new CloudMemberMachineScreenRefusal(answer.reason as CloudMemberMachineScreenRefusalCode);
		throw new Error("MEMBER_SCREEN_BEGIN_INVALID");
	}
	/** Begins one action as the member, recorded without any text (cloudMemberMachineActRecord), under the hold its input
	 * was captured in (`epoch` and `seat`, F24 and F26): its single-use id, or the refusal the window acts on (a machine
	 * that is not running, a disk the member may not see, another member's hold of the desktop, the member's own hold
	 * ended, or a newer hold of theirs: after a hand-back, after a lease ran out and was taken again, or another tab's).
	 * Sign-in and forbidden as for a look. */
	async act(
		token: string,
		act: { companyId: string; machineId: string; action: MachineScreenAction; epoch: number; seat: number },
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (
			!UUID.test(act.companyId) ||
			!UUID.test(act.machineId) ||
			act.action.type === "open" ||
			!Number.isSafeInteger(act.epoch) ||
			act.epoch < 0 ||
			!Number.isSafeInteger(act.seat) ||
			act.seat < 0
		)
			throw new Error("MEMBER_ACT_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_act_begin",
			{
				p_profile_id: act.companyId,
				p_machine_id: act.machineId,
				p_action: cloudMemberMachineActRecord(act.action),
				p_epoch: act.epoch,
				p_seat: act.seat,
			},
			"MEMBER_ACT_BEGIN",
			signal,
		);
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-desktop-act/v1" && keys === "actionId,schema,state" &&
			answer.state === "ok" && typeof answer.actionId === "string" && UUID.test(answer.actionId))
			return answer.actionId;
		if (answer.schema === "qorpera.member-machine-desktop-act/v1" && keys === "reason,schema,state" &&
			answer.state === "refused" && typeof answer.reason === "string" && ACT_REFUSED.has(answer.reason))
			throw new CloudMemberMachineActRefusal(answer.reason as CloudMemberMachineActRefusalCode);
		throw new Error("MEMBER_ACT_BEGIN_INVALID");
	}
	/** Begins one shared action as the member (qorpera_member_machine_desktop_share_begin, 20260930734000): on the desktop
	 * they share with the agent, with no hold of theirs, recorded without any text (cloudMemberMachineActRecord). Its
	 * single-use id, or the refusal the window acts on (anyone's private hold among them). Sign-in and forbidden as for a
	 * look. */
	async share(
		token: string,
		share: { companyId: string; machineId: string; action: MachineScreenAction },
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (!UUID.test(share.companyId) || !UUID.test(share.machineId) || share.action.type === "open")
			throw new Error("MEMBER_SHARE_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_share_begin",
			{ p_profile_id: share.companyId, p_machine_id: share.machineId, p_action: cloudMemberMachineActRecord(share.action) },
			"MEMBER_SHARE_BEGIN",
			signal,
		);
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-desktop-act/v1" && keys === "actionId,schema,state" &&
			answer.state === "ok" && typeof answer.actionId === "string" && UUID.test(answer.actionId))
			return answer.actionId;
		if (answer.schema === "qorpera.member-machine-desktop-act/v1" && keys === "reason,schema,state" &&
			answer.state === "refused" && typeof answer.reason === "string" && SHARE_REFUSED.has(answer.reason))
			throw new CloudMemberMachineActRefusal(answer.reason as CloudMemberMachineActRefusalCode);
		throw new Error("MEMBER_SHARE_BEGIN_INVALID");
	}
	/** Begins a start of the desktop as the member (qorpera_member_machine_desktop_start_begin, 20260930714000): its
	 * single-use id, or the refusal the window acts on. Sign-in and forbidden as for a look. */
	async start(
		token: string,
		start: { companyId: string; machineId: string },
		signal: AbortSignal,
	): Promise<{ startId: string }> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (!UUID.test(start.companyId) || !UUID.test(start.machineId)) throw new Error("MEMBER_START_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_start_begin",
			{ p_profile_id: start.companyId, p_machine_id: start.machineId },
			"MEMBER_START_BEGIN",
			signal,
		);
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-desktop-start/v1" && keys === "schema,startId,state" &&
			answer.state === "ok" && typeof answer.startId === "string" && UUID.test(answer.startId))
			return { startId: answer.startId };
		if (answer.schema === "qorpera.member-machine-desktop-start/v1" && keys === "reason,schema,state" &&
			answer.state === "refused" && typeof answer.reason === "string" && START_REFUSED.has(answer.reason))
			throw new CloudMemberMachineStartRefusal(answer.reason as CloudMemberMachineStartRefusalCode);
		throw new Error("MEMBER_START_BEGIN_INVALID");
	}
	/** One RPC as the member; its JSON object, or a fixed code (`word`_UNCONFIRMED, sign-in, forbidden). */
	async #call(
		token: string,
		method: string,
		args: Record<string, unknown>,
		word: string,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const checked = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
		let response: Response;
		try {
			response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
				method: "POST",
				redirect: "error",
				signal: checked,
				headers: {
					apikey: this.#publishableKey,
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(args),
			});
		} catch {
			throw new Error(`${word}_UNCONFIRMED`);
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => undefined);
			// PostgREST answers a token it does not take with 401, and the function's own refusal (42501) with 403.
			if (response.status === 401) throw new CloudMemberMachineScreenSignIn();
			if (response.status === 403) throw new CloudMemberMachineScreenForbidden();
			throw new Error(`${word}_UNCONFIRMED`);
		}
		try {
			const value = JSON.parse(
				new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 4096, checked)),
			) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			return value as Record<string, unknown>;
		} catch {
			throw new Error(`${word}_UNCONFIRMED`);
		}
	}
}
