import { createHash } from "node:crypto";

export const ROUTINE_POLICY_SCHEMA = "qorpera.routine-policy/v1";
export const ROUTINE_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type RoutineWeekday = (typeof ROUTINE_WEEKDAYS)[number];
export type RoutineReplyPolicy = "optional" | "required" | "silent";

export interface RoutinePolicy {
	schema: typeof ROUTINE_POLICY_SCHEMA;
	timeZone: string;
	defaultWeekdays: readonly RoutineWeekday[];
	expiresAt: string | null;
	quietWindows: readonly { weekdays: readonly RoutineWeekday[]; start: string; end: string }[];
	quietMode: "skip";
	dst: { gap: "skip"; fold: "earlier" | "later" | "both" };
	catchUp: { maxAgeSeconds: number; maxOccurrences: number };
	resume: "future-only";
	authFailures: {
		threshold: number;
		resetOn: "success" | "non-authentication";
		notifyMemberId: string;
		notificationSessionId: string;
	};
}

interface TriggerBase {
	id: string;
	replyPolicy?: RoutineReplyPolicy;
}
export interface RoutineSchedule extends TriggerBase {
	kind: "schedule";
	intervalMinutes: number;
	startAt?: string;
	weekdays?: readonly RoutineWeekday[];
	localTime?: string;
	timeZone?: string;
	months?: readonly number[];
	windowStart?: string;
	windowEnd?: string;
}
export interface CompanyFileRoutineListener extends TriggerBase {
	kind: "listener";
	source: "company-file";
	path: string;
	match: "exact" | "subtree";
	timeZone: string;
}
export const GITHUB_ROUTINE_EVENTS = [
	"pull_request.opened",
	"pull_request.updated",
	"pull_request.merged",
	"pull_request.review_requested",
] as const;
export type GitHubRoutineEvent = (typeof GITHUB_ROUTINE_EVENTS)[number];
export interface GitHubRoutineListener extends TriggerBase {
	kind: "listener";
	source: "github";
	timeZone: string;
	connectionId: string;
	installationId: string;
	repositoryId: string;
	events: readonly GitHubRoutineEvent[];
	actors: { mode: "any" } | { mode: "allowlist"; ids: readonly string[] };
	delivery: { maxAgeSeconds: number; maxFutureSkewSeconds: number; reordered: "accept" | "drop-older" };
}
export type RoutineTrigger = RoutineSchedule | CompanyFileRoutineListener | GitHubRoutineListener;

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
// Resource bounds, not silently chosen product policy.
export const MAX_SCHEDULE_SCAN_DAYS = 370;
export const MAX_SCHEDULE_CANDIDATES = 8192;

export function policyRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

export function policyKeys(
	input: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))
	) {
		throw new Error("Routine policy has missing or unsupported fields");
	}
}

export function policyInteger(value: unknown, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error("Routine policy integer is outside its bound");
	}
	return value;
}

export function routineInstant(value: unknown): number {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
		throw new Error("Routine time must be a canonical UTC instant");
	}
	const result = Date.parse(value);
	if (!Number.isFinite(result) || new Date(result).toISOString() !== value || result < 0)
		throw new Error("Invalid routine instant");
	return result;
}

export function routineUuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid routine UUID");
	return value;
}

export function providerNumericId(value: unknown): string {
	if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("Invalid provider identity");
	return value;
}

function timeZone(value: unknown): string {
	if (typeof value !== "string" || value.length > 128 || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/i.test(value)) {
		throw new Error("An explicit IANA timezone is required");
	}
	// Persist the compiler's canonical casing/alias in both policy and trigger;
	// the SQL projection and Step 3 validate exact installed timezone names.
	return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
}

function weekdays(value: unknown): readonly RoutineWeekday[] {
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > 7 ||
		new Set(value).size !== value.length ||
		!value.every((day) => ROUTINE_WEEKDAYS.includes(day))
	)
		throw new Error("Invalid routine weekdays");
	return [...value];
}

function clock(value: unknown): string {
	if (typeof value !== "string" || !CLOCK.test(value)) throw new Error("Invalid local clock time");
	return value;
}

export function parseRoutinePolicy(value: unknown): RoutinePolicy {
	const input = policyRecord(value, "routine policy");
	policyKeys(input, [
		"schema",
		"timeZone",
		"defaultWeekdays",
		"expiresAt",
		"quietWindows",
		"quietMode",
		"dst",
		"catchUp",
		"resume",
		"authFailures",
	]);
	if (input.schema !== ROUTINE_POLICY_SCHEMA || input.quietMode !== "skip" || input.resume !== "future-only")
		throw new Error("Unsupported routine policy");
	const dst = policyRecord(input.dst, "DST policy");
	policyKeys(dst, ["gap", "fold"]);
	if (dst.gap !== "skip" || typeof dst.fold !== "string" || !["earlier", "later", "both"].includes(dst.fold))
		throw new Error("Unsupported DST policy");
	const catchUp = policyRecord(input.catchUp, "catch-up policy");
	policyKeys(catchUp, ["maxAgeSeconds", "maxOccurrences"]);
	const auth = policyRecord(input.authFailures, "authentication failure policy");
	policyKeys(auth, ["threshold", "resetOn", "notifyMemberId", "notificationSessionId"]);
	if (auth.resetOn !== "success" && auth.resetOn !== "non-authentication")
		throw new Error("Invalid authentication failure reset policy");
	if (input.expiresAt !== null) routineInstant(input.expiresAt);
	if (!Array.isArray(input.quietWindows) || input.quietWindows.length > 14) throw new Error("Invalid quiet windows");
	return {
		schema: ROUTINE_POLICY_SCHEMA,
		timeZone: timeZone(input.timeZone),
		defaultWeekdays: weekdays(input.defaultWeekdays),
		expiresAt: input.expiresAt as string | null,
		quietMode: "skip",
		quietWindows: input.quietWindows.map((value) => {
			const window = policyRecord(value, "quiet window");
			policyKeys(window, ["weekdays", "start", "end"]);
			const start = clock(window.start),
				end = clock(window.end);
			if (start === end) throw new Error("A quiet window must have distinct boundaries");
			return { weekdays: weekdays(window.weekdays), start, end };
		}),
		dst: { gap: "skip", fold: dst.fold as RoutinePolicy["dst"]["fold"] },
		catchUp: {
			maxAgeSeconds: policyInteger(catchUp.maxAgeSeconds, 0, 604_800),
			maxOccurrences: policyInteger(catchUp.maxOccurrences, 1, 256),
		},
		resume: "future-only",
		authFailures: {
			threshold: policyInteger(auth.threshold, 1, 100),
			resetOn: auth.resetOn,
			notifyMemberId: routineUuid(auth.notifyMemberId),
			notificationSessionId: routineUuid(auth.notificationSessionId),
		},
	};
}

/** Compiler input is a single trigger. Defaults are resolved into the File document, never from a host timezone. */
export function compileRoutineTrigger(values: unknown, policy: RoutinePolicy): RoutineTrigger {
	if (!Array.isArray(values) || values.length !== 1)
		throw new Error("A routine must have exactly one schedule OR listener");
	const input = policyRecord(values[0], "routine trigger");
	if (typeof input.id !== "string" || !TRIGGER_ID.test(input.id)) throw new Error("Invalid routine trigger id");
	if (
		input.replyPolicy !== undefined &&
		(typeof input.replyPolicy !== "string" || !["optional", "required", "silent"].includes(input.replyPolicy))
	)
		throw new Error("Invalid reply policy");
	const base: TriggerBase = {
		id: input.id,
		...(input.replyPolicy === undefined ? {} : { replyPolicy: input.replyPolicy as RoutineReplyPolicy }),
	};
	if (input.kind === "schedule") {
		policyKeys(
			input,
			["id", "kind", "intervalMinutes"],
			["startAt", "weekdays", "localTime", "timeZone", "months", "windowStart", "windowEnd", "replyPolicy"],
		);
		const intervalMinutes = policyInteger(input.intervalMinutes, 5, 10_080);
		if (input.startAt !== undefined) routineInstant(input.startAt);
		const advanced = input.windowStart !== undefined || input.windowEnd !== undefined || input.months !== undefined;
		const calendar =
			advanced || input.localTime !== undefined || input.weekdays !== undefined || input.timeZone !== undefined;
		if (!calendar)
			return {
				...base,
				kind: "schedule",
				intervalMinutes,
				...(input.startAt === undefined ? {} : { startAt: input.startAt as string }),
			};
		const zone = timeZone(input.timeZone);
		if (zone !== policy.timeZone) throw new Error("Trigger timezone must match its policy");
		const days = input.weekdays === undefined ? [...policy.defaultWeekdays] : weekdays(input.weekdays);
		if (!advanced)
			return {
				...base,
				kind: "schedule",
				intervalMinutes,
				timeZone: zone,
				weekdays: days,
				localTime: clock(input.localTime),
				...(input.startAt === undefined ? {} : { startAt: input.startAt as string }),
			};
		if (input.localTime !== undefined || input.startAt !== undefined)
			throw new Error("Calendar window and point schedule cannot be combined");
		const start = clock(input.windowStart),
			end = clock(input.windowEnd);
		if (start > end) throw new Error("Schedule windows cannot cross midnight");
		if (
			input.months !== undefined &&
			(!Array.isArray(input.months) ||
				input.months.length < 1 ||
				input.months.length > 12 ||
				new Set(input.months).size !== input.months.length)
		)
			throw new Error("Invalid schedule months");
		const months =
			input.months === undefined
				? undefined
				: (input.months as unknown[]).map((month) => policyInteger(month, 1, 12));
		return {
			...base,
			kind: "schedule",
			intervalMinutes,
			timeZone: zone,
			weekdays: days,
			windowStart: start,
			windowEnd: end,
			...(months ? { months } : {}),
		};
	}
	if (input.kind !== "listener") throw new Error("Unsupported routine trigger");
	const zone = timeZone(input.timeZone);
	if (zone !== policy.timeZone) throw new Error("Trigger timezone must match its policy");
	if (input.source === "company-file") {
		policyKeys(input, ["id", "kind", "source", "path", "match", "timeZone"], ["replyPolicy"]);
		const match = input.match;
		// The authoritative path parser and path ACL remain Step 3's responsibility.
		if (
			typeof input.path !== "string" ||
			Buffer.byteLength(input.path) > 4096 ||
			input.path !== input.path.normalize("NFC") ||
			/[\\%:\x00-\x1f\x7f]/.test(input.path) ||
			(match !== "exact" && match !== "subtree") ||
			(input.path === ""
				? match !== "subtree"
				: input.path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)))
		)
			throw new Error("Invalid Company File selector");
		return {
			...base,
			kind: "listener",
			source: "company-file",
			path: input.path,
			match,
			timeZone: zone,
		};
	}
	if (input.source !== "github") throw new Error("Unsupported listener source");
	policyKeys(
		input,
		[
			"id",
			"kind",
			"source",
			"timeZone",
			"connectionId",
			"installationId",
			"repositoryId",
			"events",
			"actors",
			"delivery",
		],
		["replyPolicy"],
	);
	if (
		!Array.isArray(input.events) ||
		input.events.length < 1 ||
		input.events.length > GITHUB_ROUTINE_EVENTS.length ||
		new Set(input.events).size !== input.events.length ||
		!input.events.every((event) => GITHUB_ROUTINE_EVENTS.includes(event))
	)
		throw new Error("Unsupported GitHub event set");
	const actors = policyRecord(input.actors, "GitHub actors");
	let actorPolicy: GitHubRoutineListener["actors"];
	if (actors.mode === "any") {
		policyKeys(actors, ["mode"]);
		actorPolicy = { mode: "any" };
	} else {
		policyKeys(actors, ["mode", "ids"]);
		if (
			actors.mode !== "allowlist" ||
			!Array.isArray(actors.ids) ||
			actors.ids.length < 1 ||
			actors.ids.length > 100 ||
			new Set(actors.ids).size !== actors.ids.length
		)
			throw new Error("Invalid GitHub actor policy");
		actorPolicy = { mode: "allowlist", ids: actors.ids.map(providerNumericId) };
	}
	const delivery = policyRecord(input.delivery, "GitHub delivery policy");
	policyKeys(delivery, ["maxAgeSeconds", "maxFutureSkewSeconds", "reordered"]);
	if (delivery.reordered !== "accept" && delivery.reordered !== "drop-older")
		throw new Error("Invalid delivery ordering policy");
	return {
		...base,
		kind: "listener",
		source: "github",
		timeZone: zone,
		connectionId: routineUuid(input.connectionId),
		installationId: providerNumericId(input.installationId),
		repositoryId: providerNumericId(input.repositoryId),
		events: [...input.events],
		actors: actorPolicy,
		delivery: {
			maxAgeSeconds: policyInteger(delivery.maxAgeSeconds, 1, 604_800),
			maxFutureSkewSeconds: policyInteger(delivery.maxFutureSkewSeconds, 0, 3600),
			reordered: delivery.reordered,
		},
	};
}

interface CalendarParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function formatter(zone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function localParts(format: Intl.DateTimeFormat, instant: number): CalendarParts {
	const fields = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
	return {
		year: fields.year,
		month: fields.month,
		day: fields.day,
		hour: fields.hour,
		minute: fields.minute,
		second: fields.second,
	};
}

function localEpoch(parts: CalendarParts): number {
	return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function offsetsForDate(format: Intl.DateTimeFormat, localMidnight: number): readonly number[] {
	const offsets = new Set<number>();
	// Probe both sides of date-line and non-hour transitions, then verify every
	// inverse against Intl. No host-local Date parsing or fixed UTC offset.
	for (let hours = -48; hours <= 48; hours += 6) {
		const probe = localMidnight + hours * 3_600_000;
		offsets.add(localEpoch(localParts(format, probe)) - probe);
	}
	return [...offsets];
}

function resolveLocal(
	format: Intl.DateTimeFormat,
	target: number,
	offsets: readonly number[],
	fold: RoutinePolicy["dst"]["fold"],
): number[] {
	const candidates = offsets
		.map((offset) => target - offset)
		.filter((instant) => localEpoch(localParts(format, instant)) === target)
		.sort((a, b) => a - b);
	if (candidates.length < 2 || fold === "both") return candidates;
	return fold === "earlier" ? candidates.slice(0, 1) : candidates.slice(-1);
}

/** Invalid local minutes (spring gaps or skipped dates) have no canonical instant. */
export function resolveRoutineLocalMinute(local: string, policy: RoutinePolicy): readonly string[] {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Invalid local minute");
	const target = routineInstant(`${local}:00.000Z`);
	const format = formatter(policy.timeZone);
	return resolveLocal(
		format,
		target,
		offsetsForDate(format, Math.floor(target / DAY_MS) * DAY_MS),
		policy.dst.fold,
	).map((value) => new Date(value).toISOString());
}

export function routineClockAllowed(policy: RoutinePolicy, instant: string): boolean {
	const parts = localParts(formatter(policy.timeZone), routineInstant(instant));
	const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
	const minute = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
	return !policy.quietWindows.some((window) =>
		window.start < window.end
			? window.weekdays.includes(ROUTINE_WEEKDAYS[day]) && minute >= window.start && minute < window.end
			: (window.weekdays.includes(ROUTINE_WEEKDAYS[day]) && minute >= window.start) ||
				(window.weekdays.includes(ROUTINE_WEEKDAYS[(day + 6) % 7]) && minute < window.end),
	);
}

export function routineOccurrenceIdentity(
	routineId: string,
	version: number,
	triggerId: string,
	scheduledFor: string,
): { occurrenceKey: string; occurrenceId: string } {
	routineUuid(routineId);
	policyInteger(version, 1, Number.MAX_SAFE_INTEGER);
	routineInstant(scheduledFor);
	if (!TRIGGER_ID.test(triggerId)) throw new Error("Invalid routine trigger id");
	const occurrenceKey = ["routine", routineId, `v${version}`, triggerId, scheduledFor].join(":");
	// Exact existing orchestrator v1 seed and UUID bit layout. Never add policy,
	// receipt, resume epoch or delivery-attempt identity to this key.
	const digest = createHash("sha256").update(`qorpera.routine-occurrence/v1:${occurrenceKey}`).digest("hex");
	const variant = ((Number.parseInt(digest[16], 16) & 3) | 8).toString(16);
	return {
		occurrenceKey,
		occurrenceId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
	};
}

export interface RoutineScheduleContext {
	routineId: string;
	version: number;
	epoch: number;
	status: "active" | "paused" | "retired";
	suspended: boolean;
	activeSince: string;
	observedThrough: string;
	lastScheduledFor: string | null;
	trigger: RoutineSchedule;
	policy: RoutinePolicy;
}
export interface RoutineSchedulePlan {
	schema: "qorpera.routine-schedule-plan/v1";
	routineId: string;
	version: number;
	epoch: number;
	expectedObservedThrough: string;
	expectedLastScheduledFor: string | null;
	through: string;
	nextDueAt: string;
	truncatedBefore: string | null;
	occurrences: readonly { scheduledFor: string; occurrenceKey: string; occurrenceId: string }[];
}

function scheduleCandidates(
	trigger: RoutineSchedule,
	policy: RoutinePolicy,
	after: number,
	through: number,
): { values: number[]; examined: number } {
	if (through <= after) return { values: [], examined: 0 };
	if (through - after > MAX_SCHEDULE_SCAN_DAYS * DAY_MS) throw new Error("Schedule horizon exceeds its bound");
	const values: number[] = [],
		format = formatter(policy.timeZone);
	const startAt = trigger.startAt === undefined ? 0 : routineInstant(trigger.startAt);
	const days = trigger.weekdays ?? policy.defaultWeekdays;
	let examined = 0;
	if (!trigger.localTime && !trigger.windowStart) {
		const interval = trigger.intervalMinutes * MINUTE_MS;
		for (
			let next = startAt + Math.max(0, Math.floor((after - startAt) / interval) + 1) * interval;
			next <= through;
			next += interval
		) {
			if (++examined > MAX_SCHEDULE_CANDIDATES) throw new Error("Schedule candidate budget exceeded");
			const p = localParts(format, next);
			if (days.includes(ROUTINE_WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]))
				values.push(next);
		}
	} else {
		const first = localParts(format, after),
			last = localParts(format, through);
		// Padding also covers a local date moving backward at an offset change.
		for (
			let date = Date.UTC(first.year, first.month - 1, first.day) - DAY_MS;
			date <= Date.UTC(last.year, last.month - 1, last.day) + DAY_MS;
			date += DAY_MS
		) {
			const d = new Date(date);
			if (
				!days.includes(ROUTINE_WEEKDAYS[d.getUTCDay()]) ||
				(trigger.months && !trigger.months.includes(d.getUTCMonth() + 1))
			)
				continue;
			const from = trigger.localTime ?? trigger.windowStart!,
				to = trigger.localTime ?? trigger.windowEnd!;
			const start = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)),
				end = Number(to.slice(0, 2)) * 60 + Number(to.slice(3));
			const offsets = offsetsForDate(format, date);
			for (let minute = start; minute <= end; minute += trigger.intervalMinutes) {
				if (++examined > MAX_SCHEDULE_CANDIDATES) throw new Error("Schedule candidate budget exceeded");
				for (const instant of resolveLocal(format, date + minute * MINUTE_MS, offsets, policy.dst.fold))
					if (instant > after && instant <= through && instant >= startAt) values.push(instant);
			}
		}
	}
	values.sort((a, b) => a - b);
	return { values, examined };
}

/** One bounded pure plan; commit its watermark and admissions in one DB transaction. */
export function planRoutineSchedule(context: RoutineScheduleContext, now: string): RoutineSchedulePlan {
	const through = routineInstant(now),
		observed = routineInstant(context.observedThrough),
		active = routineInstant(context.activeSince);
	const policy = parseRoutinePolicy(context.policy);
	const trigger = compileRoutineTrigger([context.trigger], policy);
	if (trigger.kind !== "schedule") throw new Error("Schedule plan needs a schedule");
	routineUuid(context.routineId);
	policyInteger(context.version, 1, Number.MAX_SAFE_INTEGER);
	policyInteger(context.epoch, 1, Number.MAX_SAFE_INTEGER);
	if (context.lastScheduledFor !== null) routineInstant(context.lastScheduledFor);
	if (active > observed) throw new Error("Routine activation is beyond its durable watermark");
	const cutoff = Math.max(observed, active, through - policy.catchUp.maxAgeSeconds * 1000 - 1);
	const expired = policy.expiresAt !== null && routineInstant(policy.expiresAt) <= through;
	const candidates =
		context.status !== "active" ||
		context.suspended ||
		expired ||
		through <= observed ||
		!routineClockAllowed(policy, now)
			? []
			: scheduleCandidates(trigger, policy, cutoff, through).values;
	const allowed = candidates.filter((value) => routineClockAllowed(policy, new Date(value).toISOString()));
	// Keep the newest bounded set. Older missed slots are explicitly skipped,
	// never relabeled as a single synthetic occurrence or counted as exact.
	const selected = allowed.slice(-policy.catchUp.maxOccurrences);
	return {
		schema: "qorpera.routine-schedule-plan/v1",
		routineId: context.routineId,
		version: context.version,
		epoch: context.epoch,
		expectedObservedThrough: context.observedThrough,
		expectedLastScheduledFor: context.lastScheduledFor,
		through: new Date(Math.max(through, observed)).toISOString(),
		nextDueAt: nextRoutineScheduleAt(trigger, policy, new Date(Math.max(through, observed)).toISOString()),
		truncatedBefore:
			cutoff > observed || allowed.length > selected.length ? new Date(selected[0] ?? cutoff).toISOString() : null,
		occurrences: selected.map((value) => {
			const scheduledFor = new Date(value).toISOString();
			return {
				scheduledFor,
				...routineOccurrenceIdentity(context.routineId, context.version, trigger.id, scheduledFor),
			};
		}),
	};
}

export function nextRoutineScheduleAt(trigger: RoutineSchedule, policy: RoutinePolicy, after: string): string {
	const at = routineInstant(after);
	for (let day = 0; day < MAX_SCHEDULE_SCAN_DAYS; day++) {
		const values = scheduleCandidates(trigger, policy, at + day * DAY_MS, at + (day + 1) * DAY_MS).values;
		if (values.length) return new Date(values[0]).toISOString();
	}
	throw new Error("No schedule occurrence within the supported horizon");
}

export interface RoutinePreview {
	scheduledFor: string;
	localTime: string;
	timeZone: string;
	viewerTime: string;
	viewerTimeZone: string;
	allowed: boolean;
	reason: "eligible" | "quiet-window" | "expired";
}

/** A fixed UTC range is mandatory. No hidden Date.now(), device timezone or open-ended search. */
export function previewRoutineSchedule(
	trigger: RoutineSchedule,
	policyValue: RoutinePolicy,
	after: string,
	through: string,
	viewerTimeZone: string,
	limit: number,
): readonly RoutinePreview[] {
	const policy = parseRoutinePolicy(policyValue),
		compiled = compileRoutineTrigger([trigger], policy);
	if (compiled.kind !== "schedule") throw new Error("Cannot preview a listener as a schedule");
	const viewerZone = timeZone(viewerTimeZone),
		viewer = formatter(viewerZone),
		local = formatter(policy.timeZone);
	policyInteger(limit, 1, 256);
	return scheduleCandidates(compiled, policy, routineInstant(after), routineInstant(through))
		.values.slice(0, limit)
		.map((value) => {
			const scheduledFor = new Date(value).toISOString();
			const reason =
				policy.expiresAt !== null && value >= routineInstant(policy.expiresAt)
					? "expired"
					: routineClockAllowed(policy, scheduledFor)
						? "eligible"
						: "quiet-window";
			return {
				scheduledFor,
				localTime: new Date(localEpoch(localParts(local, value))).toISOString().slice(0, 16),
				timeZone: policy.timeZone,
				viewerTime: new Date(localEpoch(localParts(viewer, value))).toISOString().slice(0, 16),
				viewerTimeZone: viewerZone,
				allowed: reason === "eligible",
				reason,
			};
		});
}

export type RoutineAdmissionDecision =
	| "allow"
	| "stale-version"
	| "inactive"
	| "expired"
	| "not-due"
	| "before-activation"
	| "quiet-window";

/** Recheck at materialization AND immediately before effects; policy is not authority. */
export function routineAdmissionDecision(
	context: Pick<RoutineScheduleContext, "version" | "epoch" | "status" | "suspended" | "activeSince" | "policy">,
	occurrence: { version: number; epoch: number; scheduledFor: string },
	now: string,
): RoutineAdmissionDecision {
	if (occurrence.version !== context.version || occurrence.epoch !== context.epoch) return "stale-version";
	if (context.status !== "active" || context.suspended) return "inactive";
	const at = routineInstant(now),
		scheduled = routineInstant(occurrence.scheduledFor);
	if (context.policy.expiresAt !== null && Math.max(at, scheduled) >= routineInstant(context.policy.expiresAt))
		return "expired";
	if (scheduled > at) return "not-due";
	if (scheduled <= routineInstant(context.activeSince)) return "before-activation";
	if (!routineClockAllowed(context.policy, now) || !routineClockAllowed(context.policy, occurrence.scheduledFor))
		return "quiet-window";
	return "allow";
}
