/**
 * Wake scheduling (Build 4): due decisions, missed-wake coalescing,
 * failure-streak suspension, and run-state persistence.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decideScheduledWake,
	readWakeRunState,
	recordRemoteWakeConsumption,
	recordWakeOutcome,
	recordWakeStart,
	removeScheduledJobRunState,
	scheduledJobRunInterrupted,
	scheduledJobRunState,
	scheduledWakeOccurrenceKey,
	WAKE_FAILURE_SUSPENSION_THRESHOLD,
	wakeFrameFailed,
	wakeRunStatePath,
	writeWakeRunState,
} from "../src/wake-scheduler.ts";

const MINUTE = 60_000;
const schedule = (intervalMinutes: number, extra?: object, startAt?: string) => ({
	id: "job-1",
	title: "Company orchestration",
	prompt: "Run the company",
	triggers: [{ id: "schedule-1", kind: "schedule" as const, intervalMinutes, ...(startAt ? { startAt } : {}) }],
	enabled: true,
	effort: "high" as const,
	placement: "local" as const,
	createdAt: "2026-08-10T10:00:00Z",
	updatedAt: "2026-08-10T10:00:00Z",
	...extra,
});

describe("decideScheduledWake", () => {
	it("fires immediately on first wake, then on the interval", () => {
		const now = Date.parse("2026-08-10T12:00:00Z");
		const fresh = { failureStreak: 0 };
		expect(decideScheduledWake(schedule(30), fresh, now)).toEqual({ due: true, coalesced: 0 });

		const state = recordWakeStart({ version: 2, jobs: {} }, "job-1", now);
		const started = scheduledJobRunState(state, "job-1");
		expect(decideScheduledWake(schedule(30), started, now + 29 * MINUTE).due).toBe(false);
		expect(decideScheduledWake(schedule(30), started, now + 30 * MINUTE)).toEqual({ due: true, coalesced: 0 });
	});

	it("coalesces missed intervals into one wake and reports the count", () => {
		const now = Date.parse("2026-08-10T12:00:00Z");
		const started = scheduledJobRunState(recordWakeStart({ version: 2, jobs: {} }, "job-1", now), "job-1");
		// Host slept through 5 intervals: one wake, 4 coalesced.
		expect(decideScheduledWake(schedule(30), started, now + 150 * MINUTE)).toEqual({ due: true, coalesced: 4 });
	});

	it("waits for an anchored first run and keeps later runs on that anchor", () => {
		const start = Date.parse("2026-08-24T07:00:00.000Z");
		const job = schedule(7 * 24 * 60, undefined, "2026-08-24T07:00:00.000Z");
		expect(decideScheduledWake(job, { failureStreak: 0 }, start - MINUTE)).toEqual({
			due: false,
			coalesced: 0,
		});
		expect(decideScheduledWake(job, { failureStreak: 0 }, start)).toEqual({ due: true, coalesced: 0 });

		const delayedFirstRun = recordWakeStart({ version: 2, jobs: {} }, "job-1", start + 30 * MINUTE);
		const delayedState = scheduledJobRunState(delayedFirstRun, "job-1");
		expect(decideScheduledWake(job, delayedState, start + 7 * 24 * 60 * MINUTE - MINUTE).due).toBe(false);
		expect(decideScheduledWake(job, delayedState, start + 7 * 24 * 60 * MINUTE)).toEqual({
			due: true,
			coalesced: 0,
		});
	});

	it("keeps weekly wall-clock time across daylight-saving changes", () => {
		const job = schedule(7 * 24 * 60, {
			createdAt: "2026-10-19T06:50:00.000Z",
			triggers: [
				{
					id: "weekly-1",
					kind: "schedule" as const,
					intervalMinutes: 7 * 24 * 60,
					weekdays: ["monday" as const],
					localTime: "09:00",
					timeZone: "Europe/Copenhagen",
				},
			],
		});
		const first = Date.parse("2026-10-19T07:00:00.000Z");
		expect(decideScheduledWake(job, { failureStreak: 0 }, first - MINUTE).due).toBe(false);
		expect(decideScheduledWake(job, { failureStreak: 0 }, first)).toEqual({ due: true, coalesced: 0 });

		const state = scheduledJobRunState(recordWakeStart({ version: 2, jobs: {} }, "job-1", first), "job-1");
		const afterDstBeforeNine = Date.parse("2026-10-26T07:30:00.000Z");
		const afterDstAtNine = Date.parse("2026-10-26T08:00:00.000Z");
		expect(decideScheduledWake(job, state, afterDstBeforeNine).due).toBe(false);
		expect(decideScheduledWake(job, state, afterDstAtNine)).toEqual({ due: true, coalesced: 0 });
	});

	it("never fires when disabled, suspended, or unbound", () => {
		const state = { failureStreak: 0 };
		expect(decideScheduledWake(undefined, state, Date.parse("2026-08-10T12:00:00Z")).due).toBe(false);
		expect(decideScheduledWake(schedule(30, { enabled: false }), state, Date.parse("2026-08-10T12:00:00Z")).due).toBe(
			false,
		);
		expect(
			decideScheduledWake(schedule(30, { suspendedReason: "3 consecutive wake failures" }), state, Date.now()).due,
		).toBe(false);
	});
});

describe("failure streak", () => {
	it("suspends at the threshold and resets on success", () => {
		let state = { version: 2 as const, jobs: {} };
		for (let failure = 1; failure < WAKE_FAILURE_SUSPENSION_THRESHOLD; failure++) {
			const outcome = recordWakeOutcome(state, "job-1", false, Date.now());
			state = outcome.state;
			expect(outcome.suspend).toBe(false);
		}
		const suspended = recordWakeOutcome(state, "job-1", false, Date.now());
		expect(suspended.suspend).toBe(true);
		expect(scheduledJobRunState(suspended.state, "job-1").failureStreak).toBe(WAKE_FAILURE_SUSPENSION_THRESHOLD);

		const recovered = recordWakeOutcome(suspended.state, "job-1", true, Date.now(), "trail/run.jsonl");
		expect(recovered.suspend).toBe(false);
		expect(scheduledJobRunState(recovered.state, "job-1")).toMatchObject({
			failureStreak: 0,
			lastOutcome: "succeeded",
			lastTrailFile: "trail/run.jsonl",
		});
	});

	it("marks an unfinished run interrupted and clears its active trail on outcome", () => {
		const started = recordWakeStart(
			{ version: 2, jobs: {} },
			"job-1",
			Date.parse("2026-08-10T12:00:00Z"),
			"trail/active.jsonl",
		);
		expect(scheduledJobRunInterrupted(scheduledJobRunState(started, "job-1"))).toBe(true);

		const failed = recordWakeOutcome(started, "job-1", false, Date.parse("2026-08-10T12:05:00Z"));
		expect(scheduledJobRunState(failed.state, "job-1")).toEqual({
			failureStreak: 1,
			lastWakeAt: "2026-08-10T12:00:00.000Z",
			lastOutcome: "failed",
			lastFinishedAt: "2026-08-10T12:05:00.000Z",
		});
		expect(scheduledJobRunInterrupted(scheduledJobRunState(failed.state, "job-1"))).toBe(false);
	});
});

describe("wake outcome events", () => {
	it("treats an assistant model error as a failed wake", () => {
		expect(
			wakeFrameFailed({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "expired credential" },
			}),
		).toBe(true);
		expect(wakeFrameFailed({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })).toBe(false);
		expect(wakeFrameFailed({ type: "agent_settled" })).toBe(false);
	});
});

describe("run state persistence", () => {
	const userData = join(tmpdir(), `qorpera-wake-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	afterEach(() => {
		if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
	});

	it("round-trips and fails safe on missing or invalid files", () => {
		const path = wakeRunStatePath(userData, join(userData, "company"));
		expect(readWakeRunState(path)).toEqual({ version: 2, jobs: {} });
		const state = recordWakeStart(
			{ version: 2, jobs: { "job-1": { failureStreak: 2 } } },
			"job-1",
			Date.parse("2026-08-10T12:00:00Z"),
		);
		writeWakeRunState(path, state);
		expect(readWakeRunState(path)).toEqual(state);
		// Different roots never share run state.
		expect(wakeRunStatePath(userData, join(userData, "other"))).not.toBe(path);
		writeFileSync(
			path,
			JSON.stringify({
				version: 2,
				jobs: {
					valid: { failureStreak: 1, lastOutcome: "failed", ignored: "value" },
					negative: { failureStreak: -1 },
					malformed: { failureStreak: "1" },
				},
			}),
			"utf-8",
		);
		expect(readWakeRunState(path)).toEqual({
			version: 2,
			jobs: { valid: { failureStreak: 1, lastOutcome: "failed" } },
		});
	});

	it("migrates the single legacy wake state into the default job", () => {
		const path = wakeRunStatePath(userData, join(userData, "legacy-company"));
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ version: 1, lastWakeAt: "2026-08-10T12:00:00.000Z", failureStreak: 2 }),
			"utf-8",
		);
		expect(scheduledJobRunState(readWakeRunState(path), "company-orchestration")).toEqual({
			lastWakeAt: "2026-08-10T12:00:00.000Z",
			failureStreak: 2,
		});
	});

	it("removes deleted job state without disturbing other jobs", () => {
		const state = {
			version: 2 as const,
			jobs: { first: { failureStreak: 2 }, second: { failureStreak: 0 } },
		};
		expect(removeScheduledJobRunState(state, "first")).toEqual({
			version: 2,
			jobs: { second: { failureStreak: 0 } },
		});
		expect(removeScheduledJobRunState(state, "missing")).toBe(state);
	});
});

describe("scheduledWakeOccurrenceKey", () => {
	it("derives the same anchored key on machines with divergent run state", () => {
		const job = schedule(60, undefined, "2026-08-24T07:00:00.000Z");
		const anchor = Date.parse("2026-08-24T07:00:00.000Z");
		// Machine A fires exactly on the slot; machine B's ticker lands 40
		// minutes late. Both derive slot 3.
		expect(scheduledWakeOccurrenceKey(job, anchor + 3 * 60 * MINUTE)).toBe("slot:3");
		expect(scheduledWakeOccurrenceKey(job, anchor + 3 * 60 * MINUTE + 40 * MINUTE)).toBe("slot:3");
		expect(scheduledWakeOccurrenceKey(job, anchor + 4 * 60 * MINUTE)).toBe("slot:4");
		expect(scheduledWakeOccurrenceKey(job, anchor - MINUTE)).toBeUndefined();
	});

	it("derives the weekly occurrence instant regardless of the tick's lateness", () => {
		const job = schedule(7 * 24 * 60, {
			triggers: [
				{
					id: "weekly-1",
					kind: "schedule" as const,
					intervalMinutes: 7 * 24 * 60,
					weekdays: ["monday" as const],
					localTime: "09:00",
					timeZone: "Europe/Copenhagen",
				},
			],
		});
		const monday = Date.parse("2026-08-17T07:00:00.000Z");
		const key = scheduledWakeOccurrenceKey(job, monday);
		expect(key).toBe(`weekly:${monday}`);
		expect(scheduledWakeOccurrenceKey(job, monday + 3 * 60 * MINUTE)).toBe(key);
		expect(scheduledWakeOccurrenceKey(job, monday + 7 * 24 * 60 * MINUTE)).toBe(
			`weekly:${monday + 7 * 24 * 60 * MINUTE}`,
		);
	});

	it("quantizes unanchored intervals onto the epoch grid", () => {
		const now = Date.parse("2026-08-10T12:00:00Z");
		const key = scheduledWakeOccurrenceKey(schedule(30), now);
		expect(key).toBe(`grid:${Math.floor(now / (30 * MINUTE))}`);
		expect(scheduledWakeOccurrenceKey(schedule(30), now + 29 * MINUTE)).toBe(key);
		expect(scheduledWakeOccurrenceKey(schedule(30), now + 30 * MINUTE)).not.toBe(key);
		expect(scheduledWakeOccurrenceKey(schedule(30, { triggers: [] }), now)).toBeUndefined();
	});
});

describe("recordRemoteWakeConsumption", () => {
	it("consumes the occurrence without inventing an outcome", () => {
		const started = recordWakeStart(
			{ version: 2, jobs: { "job-1": { failureStreak: 2, lastOutcome: "failed" } } },
			"job-1",
			Date.parse("2026-08-10T11:00:00Z"),
			"trail/active.jsonl",
		);
		const consumed = recordRemoteWakeConsumption(started, "job-1", Date.parse("2026-08-10T12:00:00Z"));
		expect(scheduledJobRunState(consumed, "job-1")).toEqual({
			failureStreak: 2,
			lastOutcome: "failed",
			lastWakeAt: "2026-08-10T12:00:00.000Z",
			lastFinishedAt: "2026-08-10T12:00:00.000Z",
		});
		// Consumed = not interrupted and not due until the next occurrence.
		expect(scheduledJobRunInterrupted(scheduledJobRunState(consumed, "job-1"))).toBe(false);
		expect(
			decideScheduledWake(schedule(30), scheduledJobRunState(consumed, "job-1"), Date.parse("2026-08-10T12:29:00Z"))
				.due,
		).toBe(false);
	});
});
