import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CloudRoutineScheduleReconciler, type CloudRunnerOrchestratorControlPlane } from "../src/orchestrator.ts";
import {
	compileRoutineTrigger,
	nextRoutineScheduleAt,
	parseRoutinePolicy,
	planRoutineSchedule,
	previewRoutineSchedule,
	type RoutinePolicy,
	type RoutineSchedule,
	type RoutineScheduleContext,
	resolveRoutineLocalMinute,
	routineAdmissionDecision,
	routineClockAllowed,
	routineInstant,
	routineOccurrenceIdentity,
} from "../src/routine-policy.ts";
import {
	createRoutinePolicyControl,
	deliverRoutineSuspensionNotification,
	reconcileRoutinePolicy,
} from "../src/routine-policy-adapters.ts";

const policy = parseRoutinePolicy(
	JSON.parse(readFileSync(new URL("./fixtures/routine-policy.json", import.meta.url), "utf8")),
);
interface TriggerValidationCase {
	name: string;
	patch: Record<string, unknown>;
	remove?: string[];
	valid: boolean;
}
const validation: {
	githubTrigger: Record<string, unknown>;
	githubCases: TriggerValidationCase[];
	companyFileTrigger: Record<string, unknown>;
	companyFileCases: TriggerValidationCase[];
	timeZones: { name: string; value: unknown; canonical: string | null }[];
	instants: { name: string; value: unknown; valid: boolean }[];
} = JSON.parse(readFileSync(new URL("./fixtures/routine-validation.json", import.meta.url), "utf8"));
const routineId = "80000000-0000-4000-8000-000000000001";
const interval: RoutineSchedule = { id: "tick", kind: "schedule", intervalMinutes: 5 };
const context: RoutineScheduleContext = {
	routineId,
	version: 1,
	epoch: 1,
	status: "active",
	suspended: false,
	activeSince: "2026-08-28T09:00:00.000Z",
	observedThrough: "2026-08-28T09:00:00.000Z",
	lastScheduledFor: null,
	trigger: interval,
	policy,
};
function zoned(zone: string, fold: RoutinePolicy["dst"]["fold"] = "earlier"): RoutinePolicy {
	return { ...policy, timeZone: zone, dst: { gap: "skip", fold } };
}

describe("shared TypeScript/PostgreSQL validation fixtures", () => {
	it.each(validation.githubCases)("GitHub: $name", ({ patch, remove = [], valid }) => {
		const trigger = { ...validation.githubTrigger, ...patch };
		for (const field of remove) delete trigger[field];
		if (valid) expect(compileRoutineTrigger([trigger], policy)).toEqual(trigger);
		else expect(() => compileRoutineTrigger([trigger], policy)).toThrow();
	});
	it.each(validation.companyFileCases)("Company File: $name", ({ patch, remove = [], valid }) => {
		const trigger = { ...validation.companyFileTrigger, ...patch };
		for (const field of remove) delete trigger[field];
		if (valid) expect(compileRoutineTrigger([trigger], policy)).toEqual(trigger);
		else expect(() => compileRoutineTrigger([trigger], policy)).toThrow();
	});
	it.each(validation.instants)("instant: $name", ({ value, valid }) => {
		if (valid) expect(new Date(routineInstant(value)).toISOString()).toBe(value);
		else expect(() => routineInstant(value)).toThrow();
	});
	it.each(validation.instants)("schedule anchor: $name", ({ value, valid }) => {
		for (const trigger of [
			{ ...interval, startAt: value },
			{ ...interval, startAt: value, localTime: "09:00", timeZone: "UTC" },
		]) {
			if (valid) expect(compileRoutineTrigger([trigger], policy)).toMatchObject({ startAt: value });
			else expect(() => compileRoutineTrigger([trigger], policy)).toThrow();
		}
	});
	it.each(validation.timeZones)("timezone: $name", ({ value, canonical }) => {
		if (canonical === null) {
			expect(() => parseRoutinePolicy({ ...policy, timeZone: value })).toThrow();
			return;
		}
		const parsed = parseRoutinePolicy({ ...policy, timeZone: value });
		expect(parsed.timeZone).toBe(canonical);
		expect(parseRoutinePolicy(parsed)).toEqual(parsed);
		for (const trigger of [
			{ ...interval, timeZone: value, localTime: "09:00" },
			{ id: "file", kind: "listener", source: "company-file", path: "", match: "subtree", timeZone: value },
			{ ...validation.githubTrigger, timeZone: value },
		]) {
			const compiled = compileRoutineTrigger([trigger], parsed);
			expect(compiled.timeZone).toBe(canonical);
			expect(compileRoutineTrigger([compiled], parsed)).toEqual(compiled);
		}
		const previews = previewRoutineSchedule(
			interval,
			parsed,
			"2026-08-28T09:00:00.000Z",
			"2026-08-28T09:05:00.000Z",
			String(value),
			1,
		);
		expect(previews).toHaveLength(1);
		expect(previews[0]).toMatchObject({ timeZone: canonical, viewerTimeZone: canonical });
	});
});

describe("closed routine policy and exactly one trigger", () => {
	it("requires explicit product policy instead of arbitrary host defaults", () => {
		expect(() => parseRoutinePolicy({ schema: policy.schema })).toThrow();
		for (const timeZone of ["auto", "", "+02:00", "PST", "Not/AZone"])
			expect(() => parseRoutinePolicy({ ...policy, timeZone })).toThrow();
		for (const expiresAt of ["2026-02-30T00:00:00.000Z", "2026-08-28T10:00:00+02:00", "infinity"])
			expect(() => parseRoutinePolicy({ ...policy, expiresAt })).toThrow();
		expect(() =>
			parseRoutinePolicy({ ...policy, quietWindows: [{ weekdays: ["monday"], start: "08:00", end: "08:00" }] }),
		).toThrow();
		expect(() => parseRoutinePolicy({ ...policy, catchUp: { maxAgeSeconds: 604801, maxOccurrences: 3 } })).toThrow();
		expect(() => parseRoutinePolicy({ ...policy, catchUp: { maxAgeSeconds: 1, maxOccurrences: 257 } })).toThrow();
	});
	it("rejects empty, mixed, and multiple schedule triggers", () => {
		for (const triggers of [
			[],
			[interval, interval],
			[{ ...interval, source: "github" }],
			[{ kind: "cron", id: "a" }],
		])
			expect(() => compileRoutineTrigger(triggers, policy)).toThrow();
	});
	it("keeps Step 3 company-file and reply-policy vocabulary", () => {
		const file = {
			id: "changes",
			kind: "listener",
			source: "company-file",
			path: "projects",
			match: "subtree",
			timeZone: "UTC",
			replyPolicy: "silent",
		};
		expect(compileRoutineTrigger([file], policy)).toEqual(file);
		expect(() => compileRoutineTrigger([file, interval], policy)).toThrow();
		expect(() => compileRoutineTrigger([{ ...file, intervalMinutes: 5 }], policy)).toThrow();
		for (const path of ["../secrets", "a//b", "a/", "C:\\x", "%2e%2e", "a:secret"])
			expect(() => compileRoutineTrigger([{ ...file, path }], policy)).toThrow();
		for (const replyPolicy of [null, "forbidden", "true", true])
			expect(() => compileRoutineTrigger([{ ...interval, replyPolicy }], policy)).toThrow();
		for (const replyPolicy of ["silent", "optional", "required"])
			expect(compileRoutineTrigger([{ ...interval, replyPolicy }], policy).replyPolicy).toBe(replyPolicy);
	});
	it("compiles configurable weekday defaults and respects explicit weekends", () => {
		const workdays: RoutinePolicy = {
			...policy,
			defaultWeekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
		};
		const weekly = { ...interval, timeZone: "UTC", localTime: "10:00" };
		expect(compileRoutineTrigger([weekly], workdays)).toMatchObject({ weekdays: workdays.defaultWeekdays });
		expect(
			nextRoutineScheduleAt(
				compileRoutineTrigger([weekly], workdays) as RoutineSchedule,
				workdays,
				"2026-08-28T10:00:00.000Z",
			),
		).toBe("2026-08-31T10:00:00.000Z");
		expect(nextRoutineScheduleAt({ ...weekly, weekdays: ["saturday"] }, workdays, "2026-08-28T10:00:00.000Z")).toBe(
			"2026-08-29T10:00:00.000Z",
		);
	});
});

describe("timezone and DST are canonical", () => {
	it.each([
		["Europe/Copenhagen", "2026-03-29T02:30"],
		["America/New_York", "2026-03-08T02:30"],
		["Pacific/Apia", "2011-12-30T12:00"],
	])("skips nonexistent local time %s %s", (zone, local) =>
		expect(resolveRoutineLocalMinute(local, zoned(zone, "both"))).toEqual([]),
	);
	it.each([
		["Europe/Copenhagen", "2026-10-25T02:30", "2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"],
		["America/New_York", "2026-11-01T01:30", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"],
		["Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"],
	])("chooses both/earlier/later explicitly for %s", (zone, local, earlier, later) => {
		expect(resolveRoutineLocalMinute(local, zoned(zone, "earlier"))).toEqual([earlier]);
		expect(resolveRoutineLocalMinute(local, zoned(zone, "later"))).toEqual([later]);
		expect(resolveRoutineLocalMinute(local, zoned(zone, "both"))).toEqual([earlier, later]);
	});
	it("previews with an explicit viewer timezone and stable ordering across a fold", () => {
		const p = zoned("Europe/Copenhagen", "both");
		const t: RoutineSchedule = { ...interval, localTime: "02:30", weekdays: ["sunday"], timeZone: p.timeZone };
		const args = [t, p, "2026-10-24T23:59:59.999Z", "2026-10-25T03:00:00.000Z", "America/New_York", 5] as const;
		const first = previewRoutineSchedule(...args);
		expect(first).toEqual(previewRoutineSchedule(...args));
		expect(first.map((row) => row.scheduledFor)).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
		expect(first.map((row) => row.localTime)).toEqual(["2026-10-25T02:30", "2026-10-25T02:30"]);
		expect(first.map((row) => row.viewerTime)).toEqual(["2026-10-24T20:30", "2026-10-24T21:30"]);
	});
	it("treats interval schedules as elapsed UTC intervals across DST", () => {
		const rows = previewRoutineSchedule(
			interval,
			zoned("Europe/Copenhagen"),
			"2026-03-29T00:55:00.000Z",
			"2026-03-29T01:10:00.000Z",
			"UTC",
			3,
		);
		expect(rows.map((row) => row.localTime)).toEqual(["2026-03-29T03:00", "2026-03-29T03:05", "2026-03-29T03:10"]);
	});
	it("preserves historical second-level offsets when resolving a local minute", () => {
		expect(resolveRoutineLocalMinute("1971-01-02T00:00", zoned("Africa/Monrovia"))).toEqual([
			"1971-01-02T00:44:30.000Z",
		]);
	});
});

describe("quiet windows, expiry and bounded recovery", () => {
	const quiet: RoutinePolicy = { ...policy, quietWindows: [{ weekdays: ["monday"], start: "22:00", end: "08:00" }] };
	it.each([
		["2026-08-24T21:59:59.999Z", true],
		["2026-08-24T22:00:00.000Z", false],
		["2026-08-25T07:59:59.999Z", false],
		["2026-08-25T08:00:00.000Z", true],
		["2026-08-24T07:00:00.000Z", true],
		["2026-08-25T22:00:00.000Z", true],
	])("uses weekday-of-start and [start,end) at %s", (instant, allowed) =>
		expect(routineClockAllowed(quiet, instant)).toBe(allowed),
	);
	it("suppresses both occurrences of a quiet local minute during fall-back", () => {
		const p: RoutinePolicy = {
			...zoned("America/New_York", "both"),
			quietWindows: [{ weekdays: ["sunday"], start: "01:00", end: "02:00" }],
		};
		for (const at of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"])
			expect(routineClockAllowed(p, at)).toBe(false);
	});
	it("bounds a decades-long outage by time and newest occurrence count", () => {
		const plan = planRoutineSchedule(
			{ ...context, activeSince: "2000-01-01T00:00:00.000Z", observedThrough: "2000-01-01T00:00:00.000Z" },
			"2026-08-28T10:00:00.000Z",
		);
		expect(plan.occurrences.map((item) => item.scheduledFor)).toEqual([
			"2026-08-28T09:50:00.000Z",
			"2026-08-28T09:55:00.000Z",
			"2026-08-28T10:00:00.000Z",
		]);
		expect(plan.truncatedBefore).toBe("2026-08-28T09:50:00.000Z");
		expect(plan.nextDueAt).toBe("2026-08-28T10:05:00.000Z");
	});
	it("advances a durable watermark over quiet and paused slots without manufacturing wakes", () => {
		const p: RoutinePolicy = { ...policy, quietWindows: [{ weekdays: ["friday"], start: "09:00", end: "10:00" }] };
		const quietPlan = planRoutineSchedule({ ...context, policy: p }, "2026-08-28T09:55:00.000Z");
		expect(quietPlan.occurrences).toEqual([]);
		expect(quietPlan.through).toBe("2026-08-28T09:55:00.000Z");
		const resumed = {
			...context,
			policy: p,
			epoch: 2,
			activeSince: "2026-08-28T09:58:00.000Z",
			observedThrough: "2026-08-28T09:58:00.000Z",
		};
		expect(planRoutineSchedule(resumed, "2026-08-28T10:00:00.000Z").occurrences.map((o) => o.scheduledFor)).toEqual([
			"2026-08-28T10:00:00.000Z",
		]);
		expect(planRoutineSchedule({ ...context, status: "paused" }, "2026-08-28T10:00:00.000Z").occurrences).toEqual([]);
	});
	it("does not rewind on a backward clock correction or catch up after expiry", () => {
		const backwards = planRoutineSchedule(context, "2026-08-28T08:00:00.000Z");
		expect(backwards.through).toBe(context.observedThrough);
		expect(backwards.occurrences).toEqual([]);
		for (const now of ["2026-08-28T10:00:00.000Z", "2026-08-28T10:00:00.001Z"])
			expect(
				planRoutineSchedule({ ...context, policy: { ...policy, expiresAt: "2026-08-28T10:00:00.000Z" } }, now)
					.occurrences,
			).toEqual([]);
	});
	it("allows zero missed-age tolerance only at the exact slot", () => {
		const c = { ...context, policy: { ...policy, catchUp: { maxAgeSeconds: 0, maxOccurrences: 1 } } };
		expect(planRoutineSchedule(c, "2026-08-28T10:00:00.000Z").occurrences).toHaveLength(1);
		expect(planRoutineSchedule(c, "2026-08-28T10:00:00.001Z").occurrences).toHaveLength(0);
	});
	it("bounds previews rather than iterating an arbitrary interval history", () => {
		expect(() =>
			previewRoutineSchedule(interval, policy, "2000-01-01T00:00:00.000Z", "2026-08-28T10:00:00.000Z", "UTC", 3),
		).toThrow("horizon");
		expect(() =>
			previewRoutineSchedule(interval, policy, "2026-01-01T00:00:00.000Z", "2026-04-01T10:00:00.000Z", "UTC", 3),
		).toThrow("budget");
	});
	it("rechecks queued occurrence version, resume epoch, pause, expiry and quiet policy", () => {
		const occurrence = { version: 1, epoch: 1, scheduledFor: "2026-08-28T09:05:00.000Z" };
		expect(routineAdmissionDecision(context, occurrence, occurrence.scheduledFor)).toBe("allow");
		expect(routineAdmissionDecision(context, occurrence, "2026-08-28T09:04:59.999Z")).toBe("not-due");
		expect(routineAdmissionDecision({ ...context, version: 2 }, occurrence, occurrence.scheduledFor)).toBe(
			"stale-version",
		);
		expect(routineAdmissionDecision({ ...context, epoch: 2 }, occurrence, occurrence.scheduledFor)).toBe(
			"stale-version",
		);
		expect(routineAdmissionDecision({ ...context, suspended: true }, occurrence, occurrence.scheduledFor)).toBe(
			"inactive",
		);
		expect(
			routineAdmissionDecision(
				{ ...context, policy: { ...policy, expiresAt: "2026-08-28T10:00:00.000Z" } },
				occurrence,
				"2026-08-28T10:00:00.000Z",
			),
		).toBe("expired");
	});
});

describe("existing scheduler identity and explicit integration adapters", () => {
	it("matches the existing orchestrator identity byte for byte", async () => {
		const enqueue = vi.fn(async () => ({ occurrenceId: "", status: "queued", scheduledFor: "" }));
		const control = {
			listRoutineScheduleHeads: vi.fn(async () => ({
				items: [
					{
						routineId,
						profileId: routineId,
						environmentId: routineId,
						staffAgentId: routineId,
						version: 1,
						triggers: [interval],
						scheduleCursors: [{ triggerId: "tick" }],
						contentSha256: "a".repeat(64),
						effectiveAt: context.activeSince,
						updatedAt: context.activeSince,
					},
				],
				hasMore: false,
			})),
			enqueueRoutineWake: enqueue,
		} as unknown as CloudRunnerOrchestratorControlPlane;
		await new CloudRoutineScheduleReconciler({ now: () => new Date("2026-08-28T10:00:00.000Z") }).reconcile(control);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining(routineOccurrenceIdentity(routineId, 1, "tick", "2026-08-28T10:00:00.000Z")),
		);
	});
	it("never silently falls back if an integration is absent or stale", async () => {
		await expect(reconcileRoutinePolicy(undefined, routineId, "2026-08-28T10:00:00.000Z")).rejects.toThrow(
			"unavailable",
		);
		const control = {
			readScheduleContext: vi.fn(async () => context),
			commitSchedulePlan: vi.fn(async () => {
				throw new Error("40001 stale");
			}),
		};
		await expect(reconcileRoutinePolicy(control, routineId, "2026-08-28T10:00:00.000Z")).rejects.toThrow("stale");
		expect(control.commitSchedulePlan).toHaveBeenCalledTimes(1);
	});
	it("uses the existing authenticated RPC transport with closed context parsing", async () => {
		const rpc = vi.fn(
			async (name: string): Promise<unknown> =>
				name === "qorpera_step8_read_schedule_context" ? context : { status: "committed", occurrences: [] },
		);
		const control = createRoutinePolicyControl(rpc);
		const plan = await reconcileRoutinePolicy(control, routineId, "2026-08-28T10:00:00.000Z");
		expect(rpc).toHaveBeenNthCalledWith(
			1,
			"qorpera_step8_read_schedule_context",
			{ p_routine_id: routineId },
			undefined,
		);
		expect(rpc).toHaveBeenNthCalledWith(2, "qorpera_step8_commit_schedule", { p_plan: plan }, undefined);
		rpc.mockResolvedValueOnce({ ...context, routineId: "80000000-0000-4000-8000-000000000009" });
		await expect(control.readScheduleContext(routineId)).rejects.toThrow("binding");
		rpc.mockResolvedValueOnce({ status: "unavailable" });
		await expect(control.commitSchedulePlan(plan)).rejects.toThrow("acknowledged");
		expect(() => createRoutinePolicyControl(undefined)).toThrow("unavailable");
	});
	it("retries the same authorized notification key after a lost acknowledgement", async () => {
		const intent = {
			id: routineId,
			routineId,
			routineVersion: 1,
			memberId: policy.authFailures.notifyMemberId,
			sessionId: policy.authFailures.notificationSessionId,
		};
		await expect(deliverRoutineSuspensionNotification(intent, undefined)).rejects.toThrow("unavailable");
		const send = vi.fn(async () => ({ messageId: routineId })),
			acknowledge = vi.fn().mockRejectedValueOnce(new Error("lost reply")).mockResolvedValue(undefined);
		await expect(deliverRoutineSuspensionNotification(intent, { send, acknowledge })).rejects.toThrow("lost reply");
		await deliverRoutineSuspensionNotification(intent, { send, acknowledge });
		expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: `routine-auth:${intent.id}` }),
			undefined,
		);
	});
});
