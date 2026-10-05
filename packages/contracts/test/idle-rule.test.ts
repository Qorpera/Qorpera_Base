import { describe, expect, it } from "vitest";
import {
	IDLE_RULE_BUSY_BYTES_PER_SAMPLE,
	IDLE_RULE_BUSY_CORE_SHARE,
	IDLE_RULE_SAMPLE_SECONDS,
	idleRuleBusy,
	idleRuleProcessIoBytes,
} from "../src/idle-rule.ts";

describe("the one idle rule's busy measure", () => {
	const before = { cpuSeconds: 10, ioBytes: 1_000_000, at: 0 };
	const later = (cpuSeconds: number, ioBytes: number, at = 30_000) => ({ cpuSeconds, ioBytes, at });

	it("states its thresholds: 5% of one core, 512 KiB in a 30-second sample", () => {
		expect(IDLE_RULE_BUSY_CORE_SHARE).toBe(0.05);
		expect(IDLE_RULE_BUSY_BYTES_PER_SAMPLE).toBe(512 * 1024);
		expect(IDLE_RULE_SAMPLE_SECONDS).toBe(30);
	});

	it("is busy by processor at 5% of one core over the sample", () => {
		expect(idleRuleBusy(before, later(11.5, 1_000_000))).toBe(true);
		expect(idleRuleBusy(before, later(11.49, 1_000_000))).toBe(false);
	});

	it("is busy by data moved at 512 KiB in 30 seconds, whatever the processor did", () => {
		expect(idleRuleBusy(before, later(10.01, 1_000_000 + 512 * 1024))).toBe(true);
		expect(idleRuleBusy(before, later(10.01, 1_000_000 + 512 * 1024 - 1))).toBe(false);
		// The rate counts, not the sample's length: 60 seconds need twice as much.
		expect(idleRuleBusy(before, later(10, 1_000_000 + 512 * 1024, 60_000))).toBe(false);
		expect(idleRuleBusy(before, later(10, 1_000_000 + 1024 * 1024, 60_000))).toBe(true);
	});

	it("never calls a waiting program busy, nor one whose samples cannot be compared", () => {
		expect(idleRuleBusy(before, later(10.02, 1_000_200))).toBe(false);
		expect(idleRuleBusy(before, later(99, 99_000_000, 0))).toBe(false);
		expect(idleRuleBusy(before, later(99, 99_000_000, -5))).toBe(false);
		expect(idleRuleBusy(before, later(1, 1))).toBe(false);
	});

	it("reads the bytes a process read and wrote, and nothing from what it cannot read", () => {
		expect(
			idleRuleProcessIoBytes(
				"rchar: 4096\nwchar: 1024\nsyscr: 7\nsyscw: 3\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n",
			),
		).toBe(5120);
		expect(idleRuleProcessIoBytes("")).toBe(0);
		expect(idleRuleProcessIoBytes("rchar: 12\n")).toBe(12);
		expect(idleRuleProcessIoBytes("rchar: 99999999999999999999\nwchar: 1\n")).toBe(0);
	});
});
