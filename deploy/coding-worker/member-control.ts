import { readBoundedCloudResponse } from "../../packages/cloud-client/src/cloud-request.ts";
import {
	CloudMemberMachineActRefusal,
	type CloudMemberMachineActRefusalCode,
	CloudMemberMachinePointerRefusal,
	type CloudMemberMachinePointerRefusalCode,
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
	cloudMemberMachineOpenPathValid,
} from "../../packages/runtime/src/cloud-member-machine-screen-http.ts";
import { withTimeoutSignal } from "./timeout-signal.ts";

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
 * machine with no desktop, one member's actions too fast, and, for input made under a lease generation
 * (20260930738000), a private hold since it was made. */
const SHARE_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_ACTIONS_TOO_FAST",
	"DESKTOP_HELD_SINCE",
]);
/** What the begin of a pointer pass answers one it refuses (20260930744000): as a shared action's begin (no one types
 * privately, no one did since the window last knew it) or a private one's (the member's own hold under its epoch and
 * seat), and the machine's own refusals. */
const POINTER_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_MEMBER_IN_CONTROL",
	"DESKTOP_HELD_SINCE",
	"DESKTOP_CONTROL_ENDED",
]);
/** What the begin of a start answers one it refuses (20260930714000). */
const START_REFUSED = new Set([
	"MACHINE_NOT_RUNNING",
	"MACHINE_NEEDS_COMPANY_VIEW",
	"DESKTOP_MACHINE_TOO_SMALL",
	"DESKTOP_START_TOO_SOON",
	// A start that opens something (20260930758000).
	"DESKTOP_OPEN_PATH_INVALID",
	"DESKTOP_OPEN_NOT_FOUND",
	"DESKTOP_MEMBER_IN_CONTROL",
]);

/** The member's side of a look at a desktop (20260930712000), of an action on one they hold (20260930713000) or share
 * with the agent (20260930734000), of a start of one (20260930714000) and of a pointer pass (20260930744000): exactly
 * five calls, qorpera_member_machine_screen_begin, qorpera_member_machine_desktop_act_begin,
 * qorpera_member_machine_desktop_share_begin, qorpera_member_machine_desktop_start_begin and
 * qorpera_member_machine_desktop_pointer_begin, made as the member with
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
	 * they share with the agent, with no hold of theirs, recorded without any text (cloudMemberMachineActRecord). With the
	 * lease generation the input was made under (20260930738000) it goes to the begin that takes it (`p_generation`), which
	 * refuses it once someone held the desktop privately since (DESKTOP_HELD_SINCE); without one (a page before it) to the
	 * begin that takes none, as before. Its single-use id, or the refusal the window acts on (anyone's private hold among
	 * them). Sign-in and forbidden as for a look. */
	async share(
		token: string,
		share: { companyId: string; machineId: string; action: MachineScreenAction; generation?: number },
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (
			!UUID.test(share.companyId) ||
			!UUID.test(share.machineId) ||
			share.action.type === "open" ||
			(share.generation !== undefined && (!Number.isSafeInteger(share.generation) || share.generation < 0))
		)
			throw new Error("MEMBER_SHARE_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_share_begin",
			{
				p_profile_id: share.companyId,
				p_machine_id: share.machineId,
				p_action: cloudMemberMachineActRecord(share.action),
				...(share.generation === undefined ? {} : { p_generation: share.generation }),
			},
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
	/** Begins a pointer pass as the member (qorpera_member_machine_desktop_pointer_begin, 20260930744000): shared at the
	 * lease generation the window knows, or on the member's own private hold (its epoch and seat). Its id and its length
	 * in milliseconds (10 s), or the refusal the window acts on. Nothing is recorded but the member's newest pass. Sign-in
	 * and forbidden as for a look. */
	async pointer(
		token: string,
		begin: {
			companyId: string;
			machineId: string;
			hold: { generation: number } | { epoch: number; seat: number };
		},
		signal: AbortSignal,
	): Promise<string> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
		const hold = begin.hold as { generation?: unknown; epoch?: unknown; seat?: unknown };
		const shared = Object.keys(hold).sort().join() === "generation" && whole(hold.generation);
		const owned = Object.keys(hold).sort().join() === "epoch,seat" && whole(hold.epoch) && whole(hold.seat);
		if (!UUID.test(begin.companyId) || !UUID.test(begin.machineId) || !(shared || owned))
			throw new Error("MEMBER_POINTER_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_pointer_begin",
			{
				p_profile_id: begin.companyId,
				p_machine_id: begin.machineId,
				p_generation: shared ? hold.generation : null,
				p_epoch: owned ? hold.epoch : null,
				p_seat: owned ? hold.seat : null,
			},
			"MEMBER_POINTER_BEGIN",
			signal,
		);
		const keys = Object.keys(answer).sort().join();
		if (answer.schema === "qorpera.member-machine-desktop-pointer/v1" && keys === "passId,schema,seconds,state" &&
			answer.state === "ok" && typeof answer.passId === "string" && UUID.test(answer.passId) && answer.seconds === 10)
			return answer.passId;
		if (answer.schema === "qorpera.member-machine-desktop-pointer/v1" && keys === "reason,schema,state" &&
			answer.state === "refused" && typeof answer.reason === "string" && POINTER_REFUSED.has(answer.reason))
			throw new CloudMemberMachinePointerRefusal(answer.reason as CloudMemberMachinePointerRefusalCode);
		throw new Error("MEMBER_POINTER_BEGIN_INVALID");
	}
	/** Begins a start of the desktop as the member (qorpera_member_machine_desktop_start_begin, 20260930714000): its
	 * single-use id, or the refusal the window acts on. Sign-in and forbidden as for a look. A start that opens a path of
	 * the company folder (20260930758000) goes to the begin that takes it (`p_open`); a plain one to the begin that takes
	 * none, as before. */
	async start(
		token: string,
		start: { companyId: string; machineId: string; open?: string },
		signal: AbortSignal,
	): Promise<{ startId: string }> {
		if (!TOKEN.test(token)) throw new CloudMemberMachineScreenSignIn();
		if (
			!UUID.test(start.companyId) ||
			!UUID.test(start.machineId) ||
			(start.open !== undefined && !cloudMemberMachineOpenPathValid(start.open))
		)
			throw new Error("MEMBER_START_BEGIN_INVALID");
		const answer = await this.#call(
			token,
			"qorpera_member_machine_desktop_start_begin",
			{
				p_profile_id: start.companyId,
				p_machine_id: start.machineId,
				...(start.open === undefined ? {} : { p_open: start.open }),
			},
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
		return withTimeoutSignal(signal, 10000, async (checked) => {
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
		});
	}
}
