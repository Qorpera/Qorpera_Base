import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readStaffRuntimeState,
	recordStaffIntroPending,
	staffRuntimeStatePath,
	writeStaffRuntimeState,
} from "../src/staff-runtime-state.ts";

describe("staff intro runtime state", () => {
	const userData = join(tmpdir(), `qorpera-staff-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const root = join(userData, "company");
	let path: string;

	beforeEach(() => {
		mkdirSync(join(root, ".qorpera"), { recursive: true });
		writeFileSync(
			join(root, ".qorpera", "company.json"),
			`${JSON.stringify({ schema: "qorpera.company/v1", id: "66666666-6666-4666-8666-666666666666" })}\n`,
			"utf-8",
		);
		path = staffRuntimeStatePath(userData, root);
	});

	afterEach(() => {
		if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
	});

	it("records a pending intro once per trail and persists it durably", () => {
		const pending = recordStaffIntroPending(
			readStaffRuntimeState(path),
			"staff-1",
			"session-1.jsonl",
			Date.parse("2026-08-15T08:00:00Z"),
		);
		expect(pending.intros["staff-1"]).toMatchObject({ status: "pending", attempts: 0 });
		expect(recordStaffIntroPending(pending, "staff-1", "session-1.jsonl", Date.parse("2026-08-15T08:01:00Z"))).toBe(
			pending,
		);
		writeStaffRuntimeState(path, pending);
		expect(readStaffRuntimeState(path).intros["staff-1"]).toMatchObject({
			trailFile: "session-1.jsonl",
			status: "pending",
			attempts: 0,
		});
	});

	it("persists bounded service orientation for a queued initial team", () => {
		const pending = recordStaffIntroPending(
			readStaffRuntimeState(path),
			"staff-oriented",
			"session-oriented.jsonl",
			Date.parse("2026-08-15T08:00:00Z"),
			{
				services: ["calendar", "team-messaging"],
				otherService: "Nordea Corporate Netbank",
			},
		);
		writeStaffRuntimeState(path, pending);

		expect(readStaffRuntimeState(path).intros["staff-oriented"]?.orientation).toEqual({
			services: ["calendar", "team-messaging"],
			otherService: "Nordea Corporate Netbank",
		});
		expect(() =>
			recordStaffIntroPending({ version: 1, intros: {} }, "staff-invalid", "session-invalid.jsonl", Date.now(), {
				services: ["email", "email"],
			}),
		).toThrow("orientation");
	});

	it("still reads intros the removed local lane left in started, completed, or failed states", () => {
		const intro = (staffAgentId: string, status: "started" | "completed" | "failed", error?: string) => ({
			staffAgentId,
			trailFile: `${staffAgentId}.jsonl`,
			status,
			attempts: 1,
			createdAt: "2026-08-15T09:00:00.000Z",
			updatedAt: "2026-08-15T09:02:00.000Z",
			...(error ? { error } : {}),
		});
		writeStaffRuntimeState(path, {
			version: 1,
			intros: {
				"staff-started": intro("staff-started", "started"),
				"staff-completed": intro("staff-completed", "completed"),
				"staff-failed": intro("staff-failed", "failed", "provider unavailable"),
				"staff-oversized": intro("staff-oversized", "failed", "ø".repeat(2_048)),
			},
		});
		const reloaded = readStaffRuntimeState(path).intros;
		expect(reloaded["staff-started"]?.status).toBe("started");
		expect(reloaded["staff-completed"]?.status).toBe("completed");
		expect(reloaded["staff-failed"]).toMatchObject({ status: "failed", error: "provider unavailable" });
		// An error past the byte bound invalidates only that intro.
		expect(reloaded["staff-oversized"]).toBeUndefined();
	});

	it("fails safe on malformed state and refuses trail rebinding", () => {
		writeStaffRuntimeState(path, {
			version: 1,
			intros: {
				valid: {
					staffAgentId: "valid",
					trailFile: "valid.jsonl",
					status: "pending",
					attempts: 0,
					createdAt: "2026-08-15T10:00:00.000Z",
					updatedAt: "2026-08-15T10:00:00.000Z",
				},
			},
		});
		expect(readStaffRuntimeState(path).intros.valid?.trailFile).toBe("valid.jsonl");

		writeFileSync(path, "{broken", "utf-8");
		expect(readStaffRuntimeState(path)).toEqual({ version: 1, intros: {} });
		expect(() =>
			recordStaffIntroPending(
				{
					version: 1,
					intros: {
						valid: {
							staffAgentId: "valid",
							trailFile: "first.jsonl",
							status: "pending",
							attempts: 0,
							createdAt: "2026-08-15T10:00:00.000Z",
							updatedAt: "2026-08-15T10:00:00.000Z",
						},
					},
				},
				"valid",
				"second.jsonl",
				Date.now(),
			),
		).toThrow("already bound");
	});
});
