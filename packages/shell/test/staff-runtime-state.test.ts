import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimStaffIntro,
	finishStaffIntro,
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

	it("claims an automatic intro at most once and completes it durably", () => {
		const pending = recordStaffIntroPending(
			readStaffRuntimeState(path),
			"staff-1",
			"session-1.jsonl",
			Date.parse("2026-08-15T08:00:00Z"),
		);
		const first = claimStaffIntro(pending, "staff-1", "session-1.jsonl", Date.parse("2026-08-15T08:01:00Z"), false);
		expect(first.claimed).toBe(true);
		expect(first.state.intros["staff-1"]).toMatchObject({ status: "started", attempts: 1 });
		expect(
			claimStaffIntro(first.state, "staff-1", "session-1.jsonl", Date.parse("2026-08-15T08:02:00Z"), false).claimed,
		).toBe(false);

		const completed = finishStaffIntro(
			first.state,
			"staff-1",
			"session-1.jsonl",
			true,
			Date.parse("2026-08-15T08:03:00Z"),
		);
		writeStaffRuntimeState(path, completed);
		expect(readStaffRuntimeState(path).intros["staff-1"]).toMatchObject({
			status: "completed",
			attempts: 1,
		});
		expect(
			claimStaffIntro(completed, "staff-1", "session-1.jsonl", Date.parse("2026-08-15T08:04:00Z"), true).claimed,
		).toBe(false);
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

	it("permits only an explicit retry after failure", () => {
		const pending = recordStaffIntroPending(
			{ version: 1, intros: {} },
			"staff-2",
			"session-2.jsonl",
			Date.parse("2026-08-15T09:00:00Z"),
		);
		const started = claimStaffIntro(
			pending,
			"staff-2",
			"session-2.jsonl",
			Date.parse("2026-08-15T09:01:00Z"),
			false,
		).state;
		const failed = finishStaffIntro(
			started,
			"staff-2",
			"session-2.jsonl",
			false,
			Date.parse("2026-08-15T09:02:00Z"),
			"provider unavailable",
		);
		expect(failed.intros["staff-2"]).toMatchObject({ status: "failed", error: "provider unavailable" });
		expect(
			claimStaffIntro(failed, "staff-2", "session-2.jsonl", Date.parse("2026-08-15T09:03:00Z"), false).claimed,
		).toBe(false);
		const retry = claimStaffIntro(failed, "staff-2", "session-2.jsonl", Date.parse("2026-08-15T09:04:00Z"), true);
		expect(retry.claimed).toBe(true);
		expect(retry.state.intros["staff-2"]).toMatchObject({ status: "started", attempts: 2 });
	});

	it("byte-bounds a durable failure without dropping the intro on reload", () => {
		const pending = recordStaffIntroPending(
			{ version: 1, intros: {} },
			"staff-unicode",
			"session-unicode.jsonl",
			Date.parse("2026-08-15T09:00:00Z"),
		);
		const started = claimStaffIntro(
			pending,
			"staff-unicode",
			"session-unicode.jsonl",
			Date.parse("2026-08-15T09:01:00Z"),
			false,
		).state;
		const failed = finishStaffIntro(
			started,
			"staff-unicode",
			"session-unicode.jsonl",
			false,
			Date.parse("2026-08-15T09:02:00Z"),
			"ø".repeat(2_048),
		);
		writeStaffRuntimeState(path, failed);
		const reloaded = readStaffRuntimeState(path).intros["staff-unicode"];
		expect(reloaded?.status).toBe("failed");
		expect(Buffer.byteLength(reloaded?.error ?? "", "utf-8")).toBeLessThanOrEqual(2_048);
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
