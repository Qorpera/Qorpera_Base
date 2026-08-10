/**
 * Wake scheduling (Build 4): due decisions, missed-wake coalescing,
 * failure-streak suspension, and run-state persistence.
 */
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decideScheduledWake,
	readWakeRunState,
	recordWakeOutcome,
	recordWakeStart,
	WAKE_FAILURE_SUSPENSION_THRESHOLD,
	wakeRunStatePath,
	writeWakeRunState,
} from "../src/wake-scheduler.ts";

const MINUTE = 60_000;
const schedule = (intervalMinutes: number, extra?: object) => ({ intervalMinutes, enabled: true, ...extra });

describe("decideScheduledWake", () => {
	it("fires immediately on first wake, then on the interval", () => {
		const now = Date.parse("2026-08-10T12:00:00Z");
		const fresh = { version: 1 as const, failureStreak: 0 };
		expect(decideScheduledWake(schedule(30), fresh, now)).toEqual({ due: true, coalesced: 0 });

		const started = recordWakeStart(fresh, now);
		expect(decideScheduledWake(schedule(30), started, now + 29 * MINUTE).due).toBe(false);
		expect(decideScheduledWake(schedule(30), started, now + 30 * MINUTE)).toEqual({ due: true, coalesced: 0 });
	});

	it("coalesces missed intervals into one wake and reports the count", () => {
		const now = Date.parse("2026-08-10T12:00:00Z");
		const started = recordWakeStart({ version: 1, failureStreak: 0 }, now);
		// Host slept through 5 intervals: one wake, 4 coalesced.
		expect(decideScheduledWake(schedule(30), started, now + 150 * MINUTE)).toEqual({ due: true, coalesced: 4 });
	});

	it("never fires when disabled, suspended, or unbound", () => {
		const state = { version: 1 as const, failureStreak: 0 };
		expect(decideScheduledWake(undefined, state, Date.parse("2026-08-10T12:00:00Z")).due).toBe(false);
		expect(
			decideScheduledWake({ intervalMinutes: 30, enabled: false }, state, Date.parse("2026-08-10T12:00:00Z")).due,
		).toBe(false);
		expect(
			decideScheduledWake(schedule(30, { suspendedReason: "3 consecutive wake failures" }), state, Date.now()).due,
		).toBe(false);
	});
});

describe("failure streak", () => {
	it("suspends at the threshold and resets on success", () => {
		let state = { version: 1 as const, failureStreak: 0 };
		for (let failure = 1; failure < WAKE_FAILURE_SUSPENSION_THRESHOLD; failure++) {
			const outcome = recordWakeOutcome(state, false);
			state = outcome.state;
			expect(outcome.suspend).toBe(false);
		}
		const suspended = recordWakeOutcome(state, false);
		expect(suspended.suspend).toBe(true);
		expect(suspended.state.failureStreak).toBe(WAKE_FAILURE_SUSPENSION_THRESHOLD);

		const recovered = recordWakeOutcome(suspended.state, true);
		expect(recovered.suspend).toBe(false);
		expect(recovered.state.failureStreak).toBe(0);
	});
});

describe("run state persistence", () => {
	const userData = join(tmpdir(), `qorpera-wake-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	afterEach(() => {
		if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
	});

	it("round-trips and fails safe on missing or invalid files", () => {
		const path = wakeRunStatePath(userData, join(userData, "company"));
		expect(readWakeRunState(path)).toEqual({ version: 1, failureStreak: 0 });
		const state = recordWakeStart({ version: 1, failureStreak: 2 }, Date.parse("2026-08-10T12:00:00Z"));
		writeWakeRunState(path, state);
		expect(readWakeRunState(path)).toEqual(state);
		// Different roots never share run state.
		expect(wakeRunStatePath(userData, join(userData, "other"))).not.toBe(path);
	});
});
