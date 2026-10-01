import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { type Cloud, CloudRpcError } from "./client.ts";

export type MemberNotificationSubject =
	| {
			schema: "qorpera.member-notification.provider-usage-limit/v1";
			provider: string;
			resetsAt: string | null;
			runId: string;
			connectionId: string;
	  }
	| {
			schema: "qorpera.member-notification.machine-capacity/v1";
			dimension: "machines";
			ceiling: number;
			used: number;
			allocationId: string;
	  }
	| {
			schema: "qorpera.member-notification.sponsor-handoff/v1";
			runId: string;
			fromConnectionId: string;
			toConnectionId: string;
			reason: "usage_limit";
			at: string;
	  }
	| {
			/** The kernel writes this subject without a schema (20260920000000); the web names it. */
			schema: "routine-needs-model-account";
			staffAgentId: string;
			routineId: string;
			title: string;
	  };
export interface MemberNotification {
	notificationId: string;
	profileId: string;
	kind: "provider_usage_limit" | "company_ceiling_tripped" | "sponsor_handoff" | "routine_needs_model_account";
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
	} else if (kind === "sponsor_handoff" && s.schema === "qorpera.member-notification.sponsor-handoff/v1") {
		if (s.reason !== "usage_limit") throw invalid();
		subject = {
			schema: s.schema,
			runId: uuid(s.runId),
			fromConnectionId: uuid(s.fromConnectionId),
			toConnectionId: uuid(s.toConnectionId),
			reason: s.reason,
			at: date(s.at),
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

/** Public member RPC wire contracts: migrations 20260828019980 (list, acknowledge),
 * 20260828024000 (sponsor handoff) and 20260908000300 (machine capacity). The cloud
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
