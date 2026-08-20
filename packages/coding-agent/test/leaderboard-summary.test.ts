/**
 * Leaderboard activity is derived from the durable trail only: host-stamped
 * founder inputs, agent work entries, and verified autonomous completions.
 * Idle gaps, private groups, and unattributed trails must never inflate a rank.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldCompany } from "../src/core/company.ts";
import { readCompanyLeaderboardActivity } from "../src/core/leaderboard-summary.ts";

let root: string;

const WINDOW = { sinceDay: "2026-08-10", untilDay: "2026-08-16", timeZone: "UTC" };

function at(minuteOffset: number, day = "2026-08-12"): string {
	const base = Date.parse(`${day}T09:00:00.000Z`);
	return new Date(base + minuteOffset * 60_000).toISOString();
}

function sessionHeader(id: string, authority: Record<string, unknown>, timestamp = at(0)): string {
	return JSON.stringify({
		type: "session",
		version: 5,
		id,
		timestamp,
		cwd: root,
		qorpera: { actor: "company-agent", ...authority },
	});
}

function founderInput(timestamp: string, attended = true): string {
	return JSON.stringify({
		type: "custom",
		id: `input-${timestamp}`,
		customType: "qorpera_kernel_input",
		timestamp,
		data: { frameType: "prompt", message: "do the thing", attended, origin: "kernel", images: [] },
	});
}

function assistantTurn(timestamp: string, stopReason = "stop"): string {
	return JSON.stringify({
		type: "message",
		id: `assistant-${timestamp}`,
		timestamp,
		message: { role: "assistant", provider: "anthropic", model: "claude", stopReason },
	});
}

function toolResult(timestamp: string): string {
	return JSON.stringify({
		type: "message",
		id: `tool-${timestamp}`,
		timestamp,
		message: { role: "toolResult", toolName: "Read", isError: false },
	});
}

function completedIntent(timestamp: string, status = "completed"): string {
	return JSON.stringify({
		type: "custom",
		id: `intent-${timestamp}`,
		customType: "qorpera_kernel_model_request",
		timestamp,
		data: { event: "intent", status, usage: { calls: 2 } },
	});
}

function writeTrail(file: string, lines: string[]): void {
	writeFileSync(join(root, "trail", file), `${lines.join("\n")}\n`, "utf-8");
}

beforeEach(() => {
	root = join(tmpdir(), `qorpera-leaderboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	scaffoldCompany(root);
	mkdirSync(join(root, "trail"), { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("company leaderboard activity", () => {
	it("attributes working time, requests, and sessions to each staff agent", async () => {
		writeTrail("a.jsonl", [
			sessionHeader("a", { staffAgentId: "agent-research", attended: true }),
			founderInput(at(0)),
			assistantTurn(at(2)),
			toolResult(at(4)),
			assistantTurn(at(5)),
		]);
		writeTrail("b.jsonl", [
			sessionHeader("b", { staffAgentId: "agent-legal", attended: true }),
			founderInput(at(0)),
			assistantTurn(at(1)),
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		const research = activity.staff.find((entry) => entry.staffAgentId === "agent-research");
		const legal = activity.staff.find((entry) => entry.staffAgentId === "agent-legal");

		// 0→2 (request→work), 2→4, 4→5 all fall inside the burst window.
		expect(research?.activeMs).toBe(5 * 60_000);
		expect(research?.requests).toBe(1);
		expect(research?.sessions).toBe(1);
		expect(legal?.activeMs).toBe(60_000);
		expect(activity.staff[0].staffAgentId).toBe("agent-research");
		expect(activity.totals.activeMs).toBe(6 * 60_000);
		expect(activity.totals.requests).toBe(2);
	});

	it("never bills the idle gap between two bursts of work", async () => {
		writeTrail("idle.jsonl", [
			sessionHeader("idle", { staffAgentId: "agent-ops", attended: true }),
			founderInput(at(0)),
			assistantTurn(at(1)),
			// Four hours later the founder comes back: that gap is not work.
			founderInput(at(240)),
			assistantTurn(at(242)),
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		expect(activity.staff[0].activeMs).toBe(3 * 60_000);
	});

	it("counts a task only when an autonomous run verifiably completed", async () => {
		writeTrail("done.jsonl", [
			sessionHeader("done", { staffAgentId: "agent-ops", autonomous: true, label: "autonomous — wake" }),
			assistantTurn(at(1)),
			completedIntent(at(2)),
		]);
		writeTrail("failed.jsonl", [
			sessionHeader("failed", { staffAgentId: "agent-ops", autonomous: true, label: "autonomous — wake" }),
			assistantTurn(at(1), "error"),
			completedIntent(at(2), "failed"),
		]);
		writeTrail("chat.jsonl", [
			sessionHeader("chat", { staffAgentId: "agent-ops", attended: true }),
			founderInput(at(1)),
			assistantTurn(at(2)),
			completedIntent(at(3)),
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		// Only the successful autonomous run counts: a failed run and an
		// attended chat turn are not finished assignments.
		expect(activity.staff[0].tasksDone).toBe(1);
		expect(activity.totals.tasksDone).toBe(1);
	});

	it("excludes infrastructure groups, unattended inputs, and out-of-window work", async () => {
		writeTrail("infra.jsonl", [
			sessionHeader("infra", { staffAgentId: "agent-ops", group: "infrastructure:merge" }),
			founderInput(at(0)),
			assistantTurn(at(1)),
		]);
		writeTrail("intro.jsonl", [
			sessionHeader("intro", { staffAgentId: "agent-ops", attended: false }),
			founderInput(at(0), false),
			assistantTurn(at(1)),
			toolResult(at(3)),
		]);
		writeTrail("old.jsonl", [
			sessionHeader("old", { staffAgentId: "agent-ops", attended: true }, at(0, "2026-07-01")),
			founderInput(at(0, "2026-07-01")),
			assistantTurn(at(1, "2026-07-01")),
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		const ops = activity.staff.find((entry) => entry.staffAgentId === "agent-ops");
		// The staff-intro trail did real work, so its two minutes count — but its
		// unattended kernel frame is not a founder request, and the infrastructure
		// and out-of-window trails contribute nothing at all.
		expect(ops?.requests).toBe(0);
		expect(ops?.activeMs).toBe(2 * 60_000);
		expect(ops?.sessions).toBe(1);
		expect(activity.totals.requests).toBe(0);
	});

	it("reports trails that worked without a staff identity instead of dropping them silently", async () => {
		writeTrail("orphan.jsonl", [
			sessionHeader("orphan", { attended: true }),
			founderInput(at(0)),
			assistantTurn(at(1)),
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		expect(activity.staff).toHaveLength(0);
		expect(activity.coverage.unattributedSessions).toBe(1);
		expect(activity.coverage.scannedSessions).toBe(1);
	});

	it("survives unreadable and malformed trails", async () => {
		writeTrail("torn.jsonl", [
			sessionHeader("torn", { staffAgentId: "agent-ops", attended: true }),
			"not-json",
			assistantTurn(at(1)),
			'{"type":"message"',
		]);

		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		expect(activity.staff[0].staffAgentId).toBe("agent-ops");
		expect(activity.coverage.unreadableSessions).toBe(0);
	});

	it("rejects an invalid window rather than guessing one", async () => {
		await expect(
			readCompanyLeaderboardActivity(root, { sinceDay: "2026-08-16", untilDay: "2026-08-10", timeZone: "UTC" }),
		).rejects.toThrow(/invalid day range/);
		await expect(readCompanyLeaderboardActivity(root, { ...WINDOW, timeZone: "Not/AZone" })).rejects.toThrow(
			/invalid time zone/,
		);
	});

	it("serves an empty board for a company that has never run anything", async () => {
		const activity = await readCompanyLeaderboardActivity(root, WINDOW);
		expect(activity.staff).toEqual([]);
		expect(activity.totals).toEqual({ activeMs: 0, tasksDone: 0, requests: 0 });
	});
});
