import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readScheduledJobs } from "@qorpera/pi-coding-agent/company-connections";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStaffRoutineOperation } from "../src/staff-routines.ts";

const STAFF_AGENT_ID = "6ba7b810-9dad-4d1d-80b4-00c04fd430c8";
let root: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-staff-routines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	previousAgentDir = process.env.QORPERA_CODING_AGENT_DIR;
	process.env.QORPERA_CODING_AGENT_DIR = join(root, "agent-home");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.QORPERA_CODING_AGENT_DIR;
	else process.env.QORPERA_CODING_AGENT_DIR = previousAgentDir;
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("staff routine operations", () => {
	it("upserts idempotently with high effort by default", () => {
		const first = applyStaffRoutineOperation(root, STAFF_AGENT_ID, {
			action: "upsert",
			routineKey: "morning-financial-review",
			title: "Morning financial review",
			instructions: "Refresh the financial-health artifact and report material changes.",
			intervalMinutes: 24 * 60,
		});
		const second = applyStaffRoutineOperation(root, STAFF_AGENT_ID, {
			action: "upsert",
			routineKey: "morning-financial-review",
			title: "Morning cash review",
			instructions: "Refresh cash, burn, and runway.",
			intervalMinutes: 12 * 60,
		});
		expect(first.action).toBe("upsert");
		expect(second.action).toBe("upsert");
		if (first.action !== "upsert" || second.action !== "upsert") throw new Error("expected upsert");
		expect(second.job.id).toBe(first.job.id);
		expect(second.job).toMatchObject({ title: "Morning cash review", effort: "high", enabled: true });
		expect(readScheduledJobs(root)).toHaveLength(1);
	});

	it("pauses, resumes, and removes only the agent-owned key", () => {
		const created = applyStaffRoutineOperation(root, STAFF_AGENT_ID, {
			action: "upsert",
			routineKey: "weekly-review",
			title: "Weekly review",
			instructions: "Review owned measures.",
			intervalMinutes: 7 * 24 * 60,
			startAt: "2026-08-24T07:00:00.000Z",
		});
		if (created.action !== "upsert") throw new Error("expected upsert");
		expect(created.job.triggers).toEqual([
			expect.objectContaining({
				kind: "schedule",
				intervalMinutes: 7 * 24 * 60,
				startAt: "2026-08-24T07:00:00.000Z",
			}),
		]);
		expect(
			applyStaffRoutineOperation(root, STAFF_AGENT_ID, { action: "pause", routineKey: "weekly-review" }),
		).toMatchObject({
			action: "pause",
			job: { enabled: false },
		});
		expect(
			applyStaffRoutineOperation(root, STAFF_AGENT_ID, { action: "resume", routineKey: "weekly-review" }),
		).toMatchObject({
			action: "resume",
			job: { enabled: true },
		});
		expect(() =>
			applyStaffRoutineOperation(
				root,
				STAFF_AGENT_ID,
				{ action: "remove", routineKey: "weekly-review" },
				created.job.id,
			),
		).toThrow("running routine");
		expect(
			applyStaffRoutineOperation(root, STAFF_AGENT_ID, { action: "remove", routineKey: "weekly-review" }),
		).toEqual({
			action: "remove",
			removedJobId: created.job.id,
		});
		expect(readScheduledJobs(root)).toEqual([]);
	});

	it("stores weekly wall-clock schedules with a portable automatic timezone", () => {
		const created = applyStaffRoutineOperation(root, STAFF_AGENT_ID, {
			action: "upsert_weekly",
			routineKey: "weekly-engineering-health",
			title: "Weekly engineering health",
			instructions: "Refresh engineering measures.",
			weekdays: ["monday"],
			localTime: "09:00",
			timeZone: "auto",
		});
		if (created.action !== "upsert") throw new Error("expected upsert");
		expect(created.job.triggers).toEqual([
			expect.objectContaining({
				kind: "schedule",
				weekdays: ["monday"],
				localTime: "09:00",
				timeZone: "auto",
			}),
		]);
	});
});
