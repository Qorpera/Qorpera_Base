import { randomUUID } from "node:crypto";
import {
	cloudRoutineAgentOffsetMinutes,
	cloudRoutineSpreadInstant,
	cloudRoutineSpreadLocalTime,
} from "@qorpera/runtime/cloud-routine-pace";
import { describe, expect, it } from "vitest";

describe("spread start times", () => {
	it("gives each agent its own offset of 1 to 20 minutes, the same as the SQL follow-up's", () => {
		// The same ids and minutes as supabase/tests/570_routine_follow_ups.test.sql.
		expect(cloudRoutineAgentOffsetMinutes("63400000-0000-4000-8000-0000000000a1")).toBe(15);
		expect(cloudRoutineAgentOffsetMinutes("00000000-0000-4000-8000-000000000001")).toBe(10);
		expect(cloudRoutineAgentOffsetMinutes("0F1A2B3C-8888-4888-8888-000000000001")).toBe(18);
		const minutes = new Set(Array.from({ length: 400 }, () => cloudRoutineAgentOffsetMinutes(randomUUID())));
		expect([...minutes].every((minute) => minute >= 1 && minute <= 20)).toBe(true);
		expect(minutes.size).toBeGreaterThanOrEqual(15);
	});
	it("moves an instant ahead on the hour or half hour, and keeps any other", () => {
		const hour = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 86_400_000;
		const at = new Date(hour).toISOString();
		expect(cloudRoutineSpreadInstant(at, 15)).toBe(new Date(hour + 15 * 60_000).toISOString());
		expect(cloudRoutineSpreadInstant(new Date(hour + 1_800_000).toISOString(), 7)).toBe(
			new Date(hour + 37 * 60_000).toISOString(),
		);
		// Not round, already passed, or the move would reach the routine's end.
		const odd = new Date(hour + 10 * 60_000).toISOString();
		expect(cloudRoutineSpreadInstant(odd, 15)).toBe(odd);
		expect(cloudRoutineSpreadInstant("2026-01-01T09:00:00.000Z", 15)).toBe("2026-01-01T09:00:00.000Z");
		expect(cloudRoutineSpreadInstant(at, 15, new Date(hour + 15 * 60_000).toISOString())).toBe(at);
		expect(cloudRoutineSpreadInstant(at, 15, new Date(hour + 16 * 60_000).toISOString())).toBe(
			new Date(hour + 15 * 60_000).toISOString(),
		);
		expect(cloudRoutineSpreadInstant("soon", 15)).toBe("soon");
	});
	it("moves a time of day on the hour or half hour within its hour", () => {
		expect(cloudRoutineSpreadLocalTime("09:00", 15)).toBe("09:15");
		expect(cloudRoutineSpreadLocalTime("08:30", 1)).toBe("08:31");
		expect(cloudRoutineSpreadLocalTime("23:30", 20)).toBe("23:50");
		expect(cloudRoutineSpreadLocalTime("08:45", 15)).toBe("08:45");
		expect(cloudRoutineSpreadLocalTime("07:05", 15)).toBe("07:05");
	});
});
