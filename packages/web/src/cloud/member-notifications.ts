import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { TableValue } from "@qorpera/cloud-client/interfaces";
import { type Cloud, CloudRpcError } from "./client.ts";

export type MemberNotificationSubject =
	| {
			schema: "qorpera.member-notification.provider-usage-limit/v1";
			provider: string;
			resetsAt: string | null;
			runId: string;
			connectionId: string;
			/** The login's email, on a notice to the member whose own login it is (20260930575000); absent on older
			 * notices and on a company account's. */
			accountEmail?: string | null;
	  }
	| {
			schema: "qorpera.member-notification.machine-capacity/v1";
			dimension: "machines";
			ceiling: number;
			used: number;
			allocationId: string;
	  }
	| {
			/** A run with no progress for 15 minutes (session-buildup audit gap 4, migration 20260930002600). */
			schema: "qorpera.member-notification.run-no-progress/v1";
			runId: string;
			staffAgentId: string;
			sessionId: string | null;
			since: string;
			minutes: number;
			/** A worker's own run, which a member may stop from the notice (gap 4b, 20260930002800). */
			worker: boolean;
	  }
	| {
			/** The kernel writes this subject without a schema (20260920000000); the web names it. */
			schema: "routine-needs-model-account";
			staffAgentId: string;
			routineId: string;
			title: string;
	  }
	| {
			/** A routine that ran on this member's login moved to another by someone else's save or pick
			 * (20260930095000: a routine's payer never changes without permission). */
			schema: "qorpera.member-notification.routine-payer-changed/v1";
			routineId: string;
			routineVersion: number;
			staffAgentId: string;
			/** Who pays now: a member's own login (`payerUserId`), or a company account (no member). */
			payer: "member" | "company";
			payerUserId: string | null;
			/** The member whose save or pick moved it; null when the cloud names no one. */
			changedByUserId: string | null;
			reason: "save" | "pick";
			at: string;
	  }
	| {
			/** A member no longer supervises the agents of an area (Interfaces I9b, 20260930371000): they withdrew their
			 * consent, the area's `supervisor` names someone else or no one, the area is gone, or they left the company. */
			schema: "qorpera.member-notification.interface-supervision-ended/v1";
			supervisionId: string;
			/** The areas table's id. */
			tableId: string;
			/** The area's row key, as the client's table parse gives it; null when too long to carry. */
			key: readonly TableValue[] | null;
			supervisorUserId: string;
			reason: "withdrawn" | "released" | "gone" | "left";
			/** The member whose save or call ended it; null when no member did (a leaving, the platform's or an agent's save). */
			byUserId: string | null;
			at: string;
	  }
	| {
			/** The good will invoice of a month could not charge the company's card (20260930571000). Stripe tries again;
			 * the line goes once it is paid. */
			schema: "qorpera.member-notification.good-will-card-failed/v1";
			/** YYYY-MM. */
			month: string;
			dueOre: number;
			/** Stripe's invoice page, only on invoice.stripe.com. */
			invoiceUrl: string | null;
			/** The card is this member's. */
			mine: boolean;
	  };
export interface MemberNotification {
	notificationId: string;
	profileId: string;
	kind:
		| "provider_usage_limit"
		| "company_ceiling_tripped"
		| "routine_needs_model_account"
		| "run_no_progress"
		| "routine_payer_changed"
		| "interface_supervision_ended"
		| "good_will_card_failed";
	createdAt: string;
	acknowledgedAt: string | null;
	subject: MemberNotificationSubject;
}
export interface WebMemberNotifications {
	listNotifications(signal?: AbortSignal): Promise<readonly MemberNotification[]>;
	acknowledgeNotification(notificationId: string, signal?: AbortSignal): Promise<MemberNotification>;
}

/* Company spend, token and wake limits and the member pause are gone. Rows
 * written before that (a tripped limit, a pause or resume) can still be in a
 * member's list; they are skipped, never shown and never a failed read. Runtime
 * bundle v89 deletes those rows and stops writing them; remove this once it is
 * live. Each retired schema maps to the kinds it was written with. */
const RETIRED = new Map([
	["qorpera.member-notification.company-ceiling-tripped/v1", ["company_ceiling_tripped"]],
	["qorpera.member-notification.company-execution-stop/v1", ["company_execution_paused", "company_execution_resumed"]],
]);
/** A suspended routine's notice (20260920000000) carries no subject schema, and this band does
 * not show it: it is skipped, so it never empties the band. (A routine that waits for its member's
 * account is read: a ChatGPT plan's member is asked to turn on work while away.) */
const UNSHOWN = new Set(["routine_suspended"]);

const invalid = () => new Error("Company notices returned an invalid response.");
const invalidFlag = (): never => {
	throw invalid();
};
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
		throw invalid();
	return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
	return value;
}
/** A login's email as the cloud recorded it, or null: it is only shown, so one that can't be shown is left out. */
function email(value: unknown): string | null {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 320 ||
		[...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	)
		return null;
	return value;
}
function date(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 64 ||
		!/^\d{4}-\d{2}-\d{2}T/.test(value) ||
		!Number.isFinite(Date.parse(value))
	)
		throw invalid();
	return value;
}
/** A table row's typed key: at least one value, each text, a number, a yes/no, empty, or a list of text. */
function keyValues(value: unknown): TableValue[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw invalid();
	return value.map((item: unknown) => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) return item as string[];
		throw invalid();
	});
}
/** A retired record is skipped only when its envelope is otherwise sound; anything
 * else falls through to full validation and fails the read like any bad record. */
function retired(value: unknown, profileId: string): boolean {
	const v = record(value);
	if (
		typeof v.kind === "string" &&
		UNSHOWN.has(v.kind) &&
		v.schema === "qorpera.member-notification/v1" &&
		v.profile_id === profileId
	) {
		record(v.subject);
		return true;
	}
	const kinds = RETIRED.get(record(v.subject).schema as string);
	return (
		kinds !== undefined &&
		v.schema === "qorpera.member-notification/v1" &&
		v.profile_id === profileId &&
		typeof v.kind === "string" &&
		kinds.includes(v.kind)
	);
}
function notification(value: unknown, profileId: string): MemberNotification {
	const v = record(value),
		s = record(v.subject);
	if (v.schema !== "qorpera.member-notification/v1" || v.profile_id !== profileId) throw invalid();
	let subject: MemberNotificationSubject;
	const kind = v.kind;
	if (kind === "provider_usage_limit" && s.schema === "qorpera.member-notification.provider-usage-limit/v1") {
		if (typeof s.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(s.provider)) throw invalid();
		subject = {
			schema: s.schema,
			provider: s.provider,
			resetsAt: s.resetsAt === null ? null : date(s.resetsAt),
			runId: uuid(s.runId),
			connectionId: uuid(s.connectionId),
			...(s.accountEmail === undefined ? {} : { accountEmail: email(s.accountEmail) }),
		};
	} else if (kind === "company_ceiling_tripped" && s.schema === "qorpera.member-notification.machine-capacity/v1") {
		if (s.dimension !== "machines") throw invalid();
		subject = {
			schema: s.schema,
			dimension: s.dimension,
			ceiling: integer(s.ceiling, 1),
			used: integer(s.used),
			allocationId: uuid(s.allocationId),
		};
	} else if (kind === "routine_needs_model_account" && s.schema === undefined) {
		if (typeof s.title !== "string" || s.title.length > 200) throw invalid();
		subject = {
			schema: "routine-needs-model-account",
			staffAgentId: uuid(s.staffAgentId),
			routineId: uuid(s.routineId),
			title: s.title,
		};
	} else if (kind === "run_no_progress" && s.schema === "qorpera.member-notification.run-no-progress/v1") {
		subject = {
			schema: s.schema,
			runId: uuid(s.runId),
			staffAgentId: uuid(s.staffAgentId),
			sessionId: s.sessionId === null ? null : uuid(s.sessionId),
			since: date(s.since),
			minutes: integer(s.minutes, 1, 1440),
			worker: s.worker === undefined ? false : s.worker === true ? true : s.worker === false ? false : invalidFlag(),
		};
	} else if (kind === "routine_payer_changed" && s.schema === "qorpera.member-notification.routine-payer-changed/v1") {
		const payer = s.payer,
			reason = s.reason;
		if ((payer !== "member" && payer !== "company") || (reason !== "save" && reason !== "pick")) throw invalid();
		subject = {
			schema: s.schema,
			routineId: uuid(s.routineId),
			routineVersion: integer(s.routineVersion, 1),
			staffAgentId: uuid(s.staffAgentId),
			payer,
			// A member's login names its member; a company account none.
			payerUserId: payer === "member" ? uuid(s.payerUserId) : s.payerUserId === null ? null : invalidFlag(),
			changedByUserId: s.changedByUserId === null ? null : uuid(s.changedByUserId),
			reason,
			at: date(s.at),
		};
	} else if (
		kind === "interface_supervision_ended" &&
		s.schema === "qorpera.member-notification.interface-supervision-ended/v1"
	) {
		const reason = s.reason;
		if (reason !== "withdrawn" && reason !== "released" && reason !== "gone" && reason !== "left") throw invalid();
		subject = {
			schema: s.schema,
			supervisionId: uuid(s.supervisionId),
			tableId: uuid(s.tableId),
			key: s.key === null ? null : keyValues(s.key),
			supervisorUserId: uuid(s.supervisorUserId),
			reason,
			byUserId: s.byUserId === null ? null : uuid(s.byUserId),
			at: date(s.at),
		};
	} else if (kind === "good_will_card_failed" && s.schema === "qorpera.member-notification.good-will-card-failed/v1") {
		if (typeof s.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s.month) || typeof s.mine !== "boolean")
			throw invalid();
		let invoiceUrl: string | null = null;
		if (typeof s.invoiceUrl === "string") {
			try {
				if (new URL(s.invoiceUrl).origin === "https://invoice.stripe.com") invoiceUrl = s.invoiceUrl;
			} catch {
				invoiceUrl = null;
			}
		} else if (s.invoiceUrl !== null) throw invalid();
		subject = {
			schema: s.schema,
			month: s.month,
			dueOre: integer(s.dueOre),
			invoiceUrl,
			mine: s.mine,
		};
	} else throw invalid();
	return {
		notificationId: uuid(v.notification_id),
		profileId,
		kind,
		subject,
		createdAt: date(v.created_at),
		acknowledgedAt: v.acknowledged_at === null ? null : date(v.acknowledged_at),
	};
}

/** Public member RPC wire contracts: migrations 20260828019980 (list, acknowledge)
 * and 20260908000300 (machine capacity). A run that reaches its login's usage
 * limit stops on that login (20260928349910), so no sponsor hand-off notice
 * (20260828024000) is written any more. The cloud
 * alone enforces notification authority. The SDK supplies bounded transport; this
 * browser host validates display records only. */
export function createWebMemberNotifications(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: () => void,
): WebMemberNotifications {
	uuid(profileId);
	uuid(memberId);
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid cloud notices configuration.");
	let observedNotifications = new Set<string>();
	const rpc = (method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		const body = JSON.stringify(args);
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current();
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to read company notices.");
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body,
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
				cloud.noticeResponse?.(`${origin.origin}/rest/v1/rpc/${method}`, data.session.access_token, response);
				try {
					check();
					if (response.status === 401 || response.status === 403)
						throw new CloudRpcError(
							method,
							{ message: "You do not have permission to read this company's notices.", code: "42501" },
							response.status,
						);
					if (response.status !== 200) throw new Error("Company notices response was unavailable.");
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, deadline),
						),
					);
					check();
					return value;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			10000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		).catch((error: unknown) => {
			if (error instanceof CloudRpcError && error.denied) throw error;
			throw new Error("Company notices could not be confirmed.");
		});
	};
	const confirm = <T>(value: T, signal?: AbortSignal): T => {
		try {
			companySignal.throwIfAborted();
			signal?.throwIfAborted();
			current();
			return value;
		} catch {
			throw new Error("Company notices could not be confirmed.");
		}
	};
	return {
		listNotifications: async (signal) => {
			const value = await rpc("qorpera_list_member_notifications", { p_profile_id: profileId, p_limit: 50 }, signal);
			if (!Array.isArray(value) || value.length > 50) throw invalid();
			const notifications = value
				.filter((v: unknown) => !retired(v, profileId))
				.map((v: unknown) => notification(v, profileId));
			const ids = new Set(notifications.map((v) => v.notificationId));
			if (ids.size !== notifications.length) throw invalid();
			confirm(notifications, signal);
			observedNotifications = ids;
			return notifications;
		},
		acknowledgeNotification: async (notificationId, signal) => {
			if (!observedNotifications.has(uuid(notificationId)))
				throw new Error("Refresh notifications before acknowledging this item.");
			const result = notification(
				await rpc("qorpera_acknowledge_member_notification", { p_notification_id: notificationId }, signal),
				profileId,
			);
			if (result.notificationId !== notificationId || result.acknowledgedAt === null) throw invalid();
			return confirm(result, signal);
		},
	};
}
