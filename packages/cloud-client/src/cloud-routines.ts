/** Cloud routines: standing work an agent does on a schedule or when a
 * Company File path changes. The cloud owns scheduling and delivery; a client
 * only states intent. Shared by every member client. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LISTENER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();

export const CLOUD_ROUTINE_WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
] as const;
export type CloudRoutineWeekday = (typeof CLOUD_ROUTINE_WEEKDAYS)[number];
/** Omitted means a final reply is required; `silent` is the only way to stay quiet. */
export type CloudRoutineReplyPolicy = "optional" | "required" | "silent";

interface TriggerBase {
	id: string;
	replyPolicy?: CloudRoutineReplyPolicy;
}
export interface CloudRoutineIntervalTrigger extends TriggerBase {
	kind: "schedule";
	intervalMinutes: number;
	startAt?: string;
}
export interface CloudRoutineWeeklyTrigger extends TriggerBase {
	kind: "schedule";
	intervalMinutes: number;
	weekdays: CloudRoutineWeekday[];
	localTime: string;
	timeZone: string;
	startAt?: string;
}
export interface CloudRoutineWindowTrigger extends TriggerBase {
	kind: "schedule";
	intervalMinutes: number;
	months?: number[];
	weekdays?: CloudRoutineWeekday[];
	windowStart: string;
	windowEnd: string;
	timeZone: string;
}
export interface CloudRoutineFileTrigger extends TriggerBase {
	kind: "listener";
	source: "company-file";
	path: string;
	match: "exact" | "subtree";
	timeZone: string;
}
export type CloudRoutineTrigger =
	| CloudRoutineIntervalTrigger
	| CloudRoutineWeeklyTrigger
	| CloudRoutineWindowTrigger
	| CloudRoutineFileTrigger;

export type CloudRoutineEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CloudRoutine {
	routineId: string;
	clientRoutineId: string;
	version: number;
	/** expired: a finite or time-bounded routine that has ended; it schedules nothing more. */
	status: "active" | "paused" | "expired" | "retired";
	staffAgentId: string;
	title: string;
	prompt: string;
	triggers: CloudRoutineTrigger[];
	effort: CloudRoutineEffort;
	sponsorBindingId: string;
	sponsorVersion: number;
	logicalComputerId: string | null;
	requiredCapability: "agent_turn" | "git_worktree" | "company_substrate";
	jobType: string;
	publicationMode: "automatic" | "review";
	reviewPolicyKey: string | null;
	reviewerStaffIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface CloudRoutineOccurrence {
	occurrenceId: string;
	/** Absent for wakes that do not come from a routine. */
	routineId: string | null;
	routineVersion: number | null;
	triggerId: string | null;
	scheduledFor: string | null;
	status: string;
	blockedReason: string | null;
	runId: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface CloudRoutineSaveInput {
	environmentId: string;
	/** Stable identity: the same id edits the routine. */
	clientRoutineId: string;
	/** One per distinct save; a retry of the same save reuses it. */
	clientVersionId: string;
	staffAgentId: string;
	title: string;
	prompt: string;
	triggers: CloudRoutineTrigger[];
	/** Every save states it: an edit passes the routine's own, so no save resets it. */
	effort: CloudRoutineEffort;
	sponsorBindingId: string;
	sponsorVersion: number;
	enabled: boolean;
}

export type CloudRoutineRpc = (
	name: "qorpera_list_cloud_routines" | "qorpera_list_wake_occurrences" | "qorpera_upsert_cloud_routine",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<unknown>;

function invalid(label: string): never {
	throw new Error(`Invalid ${label}`);
}
function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(label);
	return value as Record<string, unknown>;
}
function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID.test(value)) invalid(label);
	return value as string;
}
function optionalUuid(value: unknown, label: string): string | null {
	return value === null || value === undefined ? null : uuid(value, label);
}
function text(value: unknown, label: string, maximumBytes: number): string {
	if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > maximumBytes) invalid(label);
	return value as string;
}
function instant(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(label);
	return value as string;
}
function count(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(label);
	return value as number;
}
function only(input: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(input).some((key) => !keys.includes(key))) invalid(label);
}
function weekdays(value: unknown): CloudRoutineWeekday[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 7 ||
		new Set(value).size !== value.length ||
		value.some((day) => !CLOUD_ROUTINE_WEEKDAYS.includes(day))
	)
		invalid("routine weekdays");
	return value as CloudRoutineWeekday[];
}
function zone(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 128 || value === "auto") invalid("routine time zone");
	return value as string;
}

/** Mirrors the cloud's trigger rules so a member sees a refusal before the write. */
export function parseCloudRoutineTrigger(value: unknown): CloudRoutineTrigger {
	const input = record(value, "routine trigger");
	const reply = input.replyPolicy;
	if (reply !== undefined && reply !== "optional" && reply !== "required" && reply !== "silent")
		invalid("routine reply policy");
	const replyPolicy = reply === undefined ? {} : { replyPolicy: reply as CloudRoutineReplyPolicy };
	if (input.kind === "listener") {
		only(input, ["id", "kind", "source", "path", "match", "timeZone", "replyPolicy"], "routine listener");
		if (
			typeof input.id !== "string" ||
			!LISTENER_ID.test(input.id) ||
			input.source !== "company-file" ||
			(input.match !== "exact" && input.match !== "subtree") ||
			typeof input.path !== "string" ||
			!input.path ||
			input.path.startsWith("/") ||
			input.path.endsWith("/") ||
			input.path.split("/").some((part) => !part || part === "." || part === "..")
		)
			invalid("routine listener");
		return {
			id: input.id as string,
			kind: "listener",
			source: "company-file",
			path: input.path as string,
			match: input.match as "exact" | "subtree",
			timeZone: zone(input.timeZone),
			...replyPolicy,
		};
	}
	if (input.kind !== "schedule") invalid("routine trigger kind");
	const id = text(input.id, "routine trigger id", 160);
	if (id !== id.trim() || /[\r\n]/.test(id)) invalid("routine trigger id");
	const intervalMinutes = input.intervalMinutes;
	if (!Number.isSafeInteger(intervalMinutes) || (intervalMinutes as number) < 5 || (intervalMinutes as number) > 10080)
		invalid("routine interval");
	const base = { id, kind: "schedule" as const, intervalMinutes: intervalMinutes as number };
	const startAt = input.startAt;
	if (
		startAt !== undefined &&
		(typeof startAt !== "string" || !INSTANT.test(startAt) || !Number.isFinite(Date.parse(startAt)))
	)
		invalid("routine start");
	const start = startAt === undefined ? {} : { startAt: startAt as string };
	if ("months" in input || "windowStart" in input || "windowEnd" in input) {
		only(
			input,
			["id", "kind", "intervalMinutes", "months", "weekdays", "windowStart", "windowEnd", "timeZone", "replyPolicy"],
			"routine window",
		);
		const from = input.windowStart,
			to = input.windowEnd;
		if (
			typeof from !== "string" ||
			typeof to !== "string" ||
			!LOCAL_TIME.test(from) ||
			!LOCAL_TIME.test(to) ||
			from > to
		)
			invalid("routine window");
		const months = input.months;
		if (
			months !== undefined &&
			(!Array.isArray(months) ||
				months.length < 1 ||
				months.length > 12 ||
				new Set(months).size !== months.length ||
				months.some((month) => !Number.isSafeInteger(month) || month < 1 || month > 12))
		)
			invalid("routine months");
		return {
			...base,
			...(months === undefined ? {} : { months: months as number[] }),
			...(input.weekdays === undefined ? {} : { weekdays: weekdays(input.weekdays) }),
			windowStart: from as string,
			windowEnd: to as string,
			timeZone: zone(input.timeZone),
			...replyPolicy,
		};
	}
	if ("weekdays" in input || "localTime" in input || "timeZone" in input) {
		only(
			input,
			["id", "kind", "intervalMinutes", "startAt", "weekdays", "localTime", "timeZone", "replyPolicy"],
			"routine weekly schedule",
		);
		if (typeof input.localTime !== "string" || !LOCAL_TIME.test(input.localTime)) invalid("routine local time");
		return {
			...base,
			...start,
			weekdays: weekdays(input.weekdays),
			localTime: input.localTime as string,
			timeZone: zone(input.timeZone),
			...replyPolicy,
		};
	}
	only(input, ["id", "kind", "intervalMinutes", "startAt", "replyPolicy"], "routine interval schedule");
	return { ...base, ...start, ...replyPolicy };
}

export function parseCloudRoutine(value: unknown): CloudRoutine {
	const input = record(value, "routine");
	if (
		input.status !== "active" &&
		input.status !== "paused" &&
		input.status !== "expired" &&
		input.status !== "retired"
	)
		invalid("routine status");
	if (!["low", "medium", "high", "xhigh", "max"].includes(input.effort as string)) invalid("routine effort");
	if (!["agent_turn", "git_worktree", "company_substrate"].includes(input.required_capability as string))
		invalid("routine capability");
	if (input.publication_mode !== "automatic" && input.publication_mode !== "review") invalid("routine publication");
	if (!Array.isArray(input.triggers) || input.triggers.length < 1 || input.triggers.length > 12)
		invalid("routine triggers");
	if (!Array.isArray(input.reviewer_staff_ids)) invalid("routine reviewers");
	return {
		routineId: uuid(input.routine_id, "routine id"),
		clientRoutineId: uuid(input.client_routine_id, "routine client id"),
		version: count(input.version, "routine version"),
		status: input.status,
		staffAgentId: uuid(input.staff_agent_id, "routine agent"),
		title: text(input.title, "routine title", 640),
		prompt: text(input.prompt, "routine prompt", 32 * 1024),
		triggers: (input.triggers as unknown[]).map(parseCloudRoutineTrigger),
		effort: input.effort as CloudRoutineEffort,
		sponsorBindingId: uuid(input.sponsor_binding_id, "routine sponsor"),
		sponsorVersion: count(input.sponsor_version, "routine sponsor version"),
		logicalComputerId: optionalUuid(input.logical_computer_id, "routine computer"),
		requiredCapability: input.required_capability as CloudRoutine["requiredCapability"],
		jobType: text(input.job_type, "routine job type", 128),
		publicationMode: input.publication_mode,
		reviewPolicyKey: typeof input.review_policy_key === "string" ? input.review_policy_key : null,
		reviewerStaffIds: (input.reviewer_staff_ids as unknown[]).map((id) => uuid(id, "routine reviewer")),
		createdAt: instant(input.created_at, "routine creation time"),
		updatedAt: instant(input.updated_at, "routine update time"),
	};
}

export function parseCloudRoutineOccurrence(value: unknown): CloudRoutineOccurrence {
	const input = record(value, "routine occurrence");
	return {
		occurrenceId: uuid(input.occurrence_id, "occurrence id"),
		routineId: optionalUuid(input.routine_id, "occurrence routine"),
		routineVersion: input.routine_version == null ? null : count(input.routine_version, "occurrence routine version"),
		triggerId: typeof input.trigger_id === "string" ? input.trigger_id : null,
		scheduledFor: input.scheduled_for == null ? null : instant(input.scheduled_for, "occurrence time"),
		status: text(input.status, "occurrence status", 64),
		blockedReason: typeof input.blocked_reason === "string" ? input.blocked_reason : null,
		runId: optionalUuid(input.run_id, "occurrence run"),
		createdAt: instant(input.created_at, "occurrence creation time"),
		finishedAt: input.finished_at == null ? null : instant(input.finished_at, "occurrence finish time"),
	};
}

/** Interface text in the caller's language: the key is the English sentence,
 * `{name}` placeholders take the values. English when none is passed. */
export type CloudRoutineText = (source: string, values?: Record<string, string | number>) => string;

const english: CloudRoutineText = (source, values) =>
	values
		? source.replace(/\{(\w+)\}/g, (field, name: string) => (name in values ? String(values[name]) : field))
		: source;

/** A weekday's short name ("Mon"). */
export function cloudRoutineWeekdayName(day: CloudRoutineWeekday, t: CloudRoutineText = english): string {
	switch (day) {
		case "sunday":
			return t("Sun");
		case "monday":
			return t("Mon");
		case "tuesday":
			return t("Tue");
		case "wednesday":
			return t("Wed");
		case "thursday":
			return t("Thu");
		case "friday":
			return t("Fri");
		default:
			return t("Sat");
	}
}

function intervalWords(minutes: number, t: CloudRoutineText): string {
	if (minutes % 1440 === 0)
		return minutes === 1440 ? t("Every 1 day") : t("Every {count} days", { count: minutes / 1440 });
	if (minutes % 60 === 0)
		return minutes === 60 ? t("Every 1 hour") : t("Every {count} hours", { count: minutes / 60 });
	return t("Every {count} minutes", { count: minutes });
}

function weekdayWords(days: readonly CloudRoutineWeekday[], t: CloudRoutineText): string {
	return days.length === 7
		? t("every day")
		: CLOUD_ROUTINE_WEEKDAYS.filter((day) => days.includes(day))
				.map((day) => cloudRoutineWeekdayName(day, t))
				.join(", ");
}

/** Plain words for a trigger, in the viewer's language of days and clocks;
 * pass the interface's translation to have them in its language. */
export function describeCloudRoutineTrigger(trigger: CloudRoutineTrigger, t: CloudRoutineText = english): string {
	if (trigger.kind === "listener")
		return trigger.match === "subtree"
			? t("When {path} or anything under it changes", { path: trigger.path })
			: t("When {path} changes", { path: trigger.path });
	if ("localTime" in trigger)
		return t("{days} at {time} ({zone})", {
			days: weekdayWords(trigger.weekdays, t),
			time: trigger.localTime,
			zone: trigger.timeZone,
		});
	if ("windowStart" in trigger) {
		const window = {
			every: intervalWords(trigger.intervalMinutes, t),
			start: trigger.windowStart,
			end: trigger.windowEnd,
			zone: trigger.timeZone,
		};
		return trigger.weekdays
			? t("{every} between {start} and {end}, {days} ({zone})", {
					...window,
					days: weekdayWords(trigger.weekdays, t),
				})
			: t("{every} between {start} and {end} ({zone})", window);
	}
	return intervalWords(trigger.intervalMinutes, t);
}

export class CloudRoutineClient {
	readonly #rpc: CloudRoutineRpc;
	constructor(rpc: CloudRoutineRpc) {
		this.#rpc = rpc;
	}
	async list(environmentId: string, signal: AbortSignal): Promise<CloudRoutine[]> {
		const value = await this.#rpc(
			"qorpera_list_cloud_routines",
			{ p_environment_id: uuid(environmentId, "environment") },
			signal,
		);
		if (!Array.isArray(value) || value.length > 4096) invalid("routine list");
		return (value as unknown[]).map(parseCloudRoutine);
	}
	async occurrences(environmentId: string, signal: AbortSignal, limit = 100): Promise<CloudRoutineOccurrence[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid("occurrence limit");
		const value = await this.#rpc(
			"qorpera_list_wake_occurrences",
			{ p_environment_id: uuid(environmentId, "environment"), p_limit: limit },
			signal,
		);
		if (!Array.isArray(value) || value.length > limit) invalid("occurrence list");
		return (value as unknown[]).map(parseCloudRoutineOccurrence);
	}
	/** Create and edit are one call: the client routine id is the identity and
	 * each distinct save carries its own version id. Pausing is `enabled: false`;
	 * the cloud has no member delete. */
	async save(
		input: CloudRoutineSaveInput,
		signal: AbortSignal,
	): Promise<{ routineId: string; version: number; status: "active" | "paused" }> {
		const title = text(input.title, "routine title", 640).trim();
		if (title.length > 160) invalid("routine title");
		if (input.triggers.length < 1 || input.triggers.length > 12) invalid("routine triggers");
		const triggers = input.triggers.map(parseCloudRoutineTrigger);
		if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) invalid("routine triggers");
		const value = record(
			await this.#rpc(
				"qorpera_upsert_cloud_routine",
				{
					p_environment_id: uuid(input.environmentId, "environment"),
					p_client_routine_id: uuid(input.clientRoutineId, "routine client id"),
					p_client_version_id: uuid(input.clientVersionId, "routine version id"),
					p_staff_agent_id: uuid(input.staffAgentId, "routine agent"),
					p_title: title,
					p_prompt: text(input.prompt, "routine prompt", 32 * 1024).trim(),
					p_triggers: triggers,
					p_effort: input.effort,
					p_sponsor_binding_id: uuid(input.sponsorBindingId, "routine sponsor"),
					p_sponsor_version: count(input.sponsorVersion, "routine sponsor version"),
					p_logical_computer_id: null,
					p_required_capability: "agent_turn",
					p_job_type: "agent_turn",
					p_enabled: input.enabled === true,
					p_publication_mode: "automatic",
					p_review_policy_key: null,
					p_reviewer_staff_ids: [],
				},
				signal,
			),
			"routine save",
		);
		if (value.client_routine_id !== input.clientRoutineId || (value.status !== "active" && value.status !== "paused"))
			invalid("routine save");
		return {
			routineId: uuid(value.routine_id, "routine id"),
			version: count(value.version, "routine version"),
			status: value.status,
		};
	}
}
