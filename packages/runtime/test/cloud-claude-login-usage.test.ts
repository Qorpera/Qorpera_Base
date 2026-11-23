import { readFileSync } from "node:fs";
import {
	ClaudeTerminal,
	claudeResetAnswer,
	claudeScreenDate,
	claudeUsageFromGetUsage,
	claudeUsageFromRateLimitInfo,
	readClaudeResetScreen,
} from "@qorpera/runtime/cloud-claude-login-usage";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-17T11:13:30.000Z");

function screen(lines: readonly string[], cols = 200): string[] {
	const terminal = new ClaudeTerminal(40, cols);
	terminal.feed(lines.join("\r\n"));
	return terminal.lines();
}

const CONFIRM = [
	"❯ /limit-reset",
	"────────────────",
	"  Use a full reset?",
	"",
	"  You still have 13% of your weekly limit left — use your full reset anyway?",
	"  Refills your 5-hour and weekly limits now · your weekly reset day stays Nov 20, 11:13am",
	"  3 full resets left · use by Dec 1, 11:13am",
	"",
	"  ❯ Yes, use my full reset",
	"    No, keep it",
	"",
	"  Enter to confirm · Esc to cancel",
];

describe("Claude Code's usage, as it reports it", () => {
	it("reads a run's rate_limit_event (2.1.325, utilization 0-1, epoch seconds)", () => {
		expect(
			claudeUsageFromRateLimitInfo(
				{
					status: "allowed",
					resetsAt: 1794921898,
					rateLimitType: "five_hour",
					isUsingOverage: false,
					unifiedWindows: {
						five_hour: { utilization: 0.28, resetsAt: 1794921898, status: "allowed" },
						seven_day: { utilization: 0.5, resetsAt: 1795272238, status: "allowed" },
					},
				},
				NOW,
			),
		).toEqual({
			observedAt: NOW.toISOString(),
			windows: [{ id: "seven_day", label: "Weekly", usedPercent: 50, resetAt: "2026-11-21T14:43:58.000Z" }],
		});
	});

	it("names the limit's end when Claude Code says the plan refuses, and reads nothing it cannot", () => {
		const info = {
			status: "rejected",
			resetsAt: 1794921898,
			unifiedWindows: {
				five_hour: { utilization: 1, resetsAt: 1794921898, status: "rejected" },
				seven_day: { utilization: 0.5, resetsAt: 1795272238, status: "allowed" },
			},
		};
		expect(claudeUsageFromRateLimitInfo({ ...info, rateLimitType: "five_hour" }, NOW)).toEqual({
			observedAt: NOW.toISOString(),
			windows: [{ id: "seven_day", label: "Weekly", usedPercent: 50, resetAt: "2026-11-21T14:43:58.000Z" }],
			limitResetAt: "2026-11-17T13:24:58.000Z",
			limitType: "five_hour",
		});
		expect(claudeUsageFromRateLimitInfo(info, NOW)?.limitResetAt).toBe("2026-11-17T13:24:58.000Z");
		expect(claudeUsageFromRateLimitInfo(info, NOW)).not.toHaveProperty("limitType");
		expect(claudeUsageFromRateLimitInfo({ ...info, rateLimitType: "seven_day_opus" }, NOW)).toMatchObject({
			limitResetAt: "2026-11-17T13:24:58.000Z",
			limitType: "seven_day_opus",
		});
		expect(
			claudeUsageFromRateLimitInfo({ ...info, status: "allowed", rateLimitType: "five_hour" }, NOW),
		).not.toHaveProperty("limitType");
		expect(claudeUsageFromRateLimitInfo({ ...info, rateLimitType: "Five Hour!" }, NOW)).not.toHaveProperty(
			"limitType",
		);
		expect(claudeUsageFromRateLimitInfo({ unifiedWindows: { seven_day: { utilization: 2 } } }, NOW)).toBeUndefined();
		expect(
			claudeUsageFromRateLimitInfo(
				{ unifiedWindows: { five_hour: { utilization: 0.28, resetsAt: 1794921898 } } },
				NOW,
			),
		).toBeUndefined();
		expect(claudeUsageFromRateLimitInfo({ status: "allowed" }, NOW)).toBeUndefined();
		expect(claudeUsageFromRateLimitInfo("nonsense", NOW)).toBeUndefined();
	});

	it("reads get_usage's plan windows and at most two per-model weekly ones", () => {
		const usage = claudeUsageFromGetUsage(
			{
				subscription_type: "max",
				rate_limits_available: true,
				rate_limits: {
					five_hour: { utilization: 28, resets_at: "2026-11-17T13:25:33+00:00" },
					seven_day: { utilization: 87, resets_at: "2026-11-21T14:44:33+00:00" },
					seven_day_opus: null,
					limits: [
						{
							kind: "weekly_scoped",
							percent: 9,
							resets_at: "2026-11-21T14:44:33+00:00",
							scope: { model: { display_name: "Fable" } },
						},
						{ kind: "weekly_scoped", percent: 1, resets_at: null, scope: { model: { display_name: "Fable" } } },
						{ kind: "session", percent: 50, scope: { model: { display_name: "Opus" } } },
						{
							kind: "weekly_scoped",
							percent: 3,
							resets_at: null,
							scope: { model: { display_name: "<b>x</b>" } },
						},
						{ kind: "weekly_scoped", percent: 4, resets_at: null, scope: { model: { display_name: "Opus" } } },
						{ kind: "weekly_scoped", percent: 5, resets_at: null, scope: { model: { display_name: "Sonnet" } } },
					],
				},
			},
			NOW,
		);
		expect(usage?.windows).toEqual([
			{ id: "seven_day", label: "Weekly", usedPercent: 87, resetAt: "2026-11-21T14:44:33.000Z" },
			{ id: "seven_day_model", label: "Weekly · Fable", usedPercent: 9, resetAt: "2026-11-21T14:44:33.000Z" },
			{ id: "seven_day_model", label: "Weekly · Opus", usedPercent: 4 },
		]);
		expect(claudeUsageFromGetUsage({ rate_limits: null }, NOW)).toBeUndefined();
		expect(claudeUsageFromGetUsage({ rate_limits: { five_hour: { utilization: 28 } } }, NOW)).toBeUndefined();
	});

	it("reads a real get_usage answer, five_hour null as Claude plans have no 5-hour limit, as weekly windows only", () => {
		const answer = JSON.parse(
			readFileSync(new URL("./fixtures/claude-get-usage-weekly-only.json", import.meta.url), "utf8"),
		) as Record<string, unknown>;
		expect(claudeUsageFromGetUsage(answer, NOW)).toEqual({
			observedAt: NOW.toISOString(),
			windows: [
				{ id: "seven_day", label: "Weekly", usedPercent: 4, resetAt: "2026-11-23T16:00:00.204Z" },
				{ id: "seven_day_model", label: "Weekly · Fable", usedPercent: 0, resetAt: "2026-11-23T16:00:00.000Z" },
			],
		});
	});

	it("projects Claude extra usage, spend, and promo credits when reported by get_usage", () => {
		const extra = claudeUsageFromGetUsage(
			{
				rate_limits: {
					seven_day: { utilization: 40, resets_at: "2026-11-23T16:00:00Z" },
					extra_usage: {
						is_enabled: true,
						monthly_limit: 5000,
						used_credits: 1250,
						currency: "usd",
						decimal_places: 2,
					},
				},
			},
			NOW,
		);
		expect(extra?.credits).toEqual({
			hasCredits: true,
			used: 12.5,
			limit: 50,
			balance: 37.5,
			currency: "USD",
		});

		const spend = claudeUsageFromGetUsage(
			{
				rate_limits: {
					seven_day: { utilization: 10 },
					spend: {
						enabled: true,
						used: { amount_minor: 2500, currency: "EUR", exponent: 2 },
						limit: { amount_minor: 10000, currency: "EUR", exponent: 2 },
						balance: { amount_minor: 7500, currency: "EUR", exponent: 2 },
					},
				},
			},
			NOW,
		);
		expect(spend?.credits).toEqual({
			hasCredits: true,
			used: 25,
			limit: 100,
			balance: 75,
			currency: "EUR",
		});

		const promo = claudeUsageFromGetUsage(
			{
				rate_limits: {
					seven_day: { utilization: 10 },
					promo_credits: { balance: 100, currency: "USD" },
				},
			},
			NOW,
		);
		expect(promo?.credits).toEqual({
			hasCredits: true,
			balance: 100,
			currency: "USD",
		});

		const disabled = claudeUsageFromGetUsage(
			{
				rate_limits: {
					seven_day: { utilization: 10 },
					extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
				},
			},
			NOW,
		);
		expect(disabled?.credits).toBeUndefined();
	});
});

describe("the reset screen, read off Claude Code's terminal", () => {
	it("draws cursor moves, erases and wraps as a terminal does", () => {
		const terminal = new ClaudeTerminal(4, 10);
		terminal.feed("hello\r\n\x1b[2Cab\x1b[1Ax\x1b[8Gyy\r\n\r\nzz\x1b[2K\x1b[1;1Hq\x1b]0;title\x07");
		expect(terminal.lines()).toEqual(["qellx  yy", "  ab", "", ""]);
		const wrap = new ClaudeTerminal(2, 4);
		wrap.feed("abcdefghij");
		expect(wrap.lines()).toEqual(["efgh", "ij"]);
	});

	it("reads one kind's confirm, with Yes under the cursor", () => {
		expect(readClaudeResetScreen(screen(CONFIRM), NOW)).toEqual({
			kind: "confirm",
			reset: "full",
			left: 3,
			refills: "5-hour and weekly limits",
			weekStays: "2026-11-20T11:13:00.000Z",
			useBy: "2026-12-01T11:13:00.000Z",
			yesFocused: true,
		});
		const noFocused = CONFIRM.map((line) =>
			line === "  ❯ Yes, use my full reset"
				? "    Yes, use my full reset"
				: line === "    No, keep it"
					? "  ❯ No, keep it"
					: line,
		);
		expect(readClaudeResetScreen(screen(noFocused), NOW)).toMatchObject({ kind: "confirm", yesFocused: false });
	});

	it("refuses a confirm whose words it does not know", () => {
		const changed = CONFIRM.map((line) => line.replace("Yes, use my full reset", "Yes, refill now"));
		expect(readClaudeResetScreen(screen(changed), NOW)).toBeUndefined();
		const otherKind = CONFIRM.map((line) => line.replace("Use a full reset?", "Use a lunar reset?"));
		expect(readClaudeResetScreen(screen(otherKind), NOW)).toBeUndefined();
		const noCount = CONFIRM.filter((line) => !line.includes("resets left"));
		expect(readClaudeResetScreen(screen(noCount), NOW)).toBeUndefined();
	});

	it("reads a five-hour reset's count words and a chooser of two kinds", () => {
		const session = CONFIRM.map((line) =>
			line
				.replace("Use a full reset?", "Use a 5-hour reset?")
				.replace("3 full resets left", "1 five-hour reset left")
				.replace("use my full reset", "use my 5-hour reset"),
		);
		expect(readClaudeResetScreen(screen(session), NOW)).toMatchObject({ kind: "confirm", reset: "session", left: 1 });
		const chooser = [
			"❯ /limit-reset",
			"  Which reset do you want to use?",
			"",
			"  ❯ Use a 5-hour reset (2 left, until Dec 1)",
			"    Use a weekly reset (1 left, until Dec 1)",
			"",
			"  Enter to confirm · Esc to cancel",
		];
		expect(readClaudeResetScreen(screen(chooser), NOW)).toEqual({
			kind: "choose",
			offers: [
				{ reset: "session", left: 2, until: "2026-12-01T00:00:00.000Z" },
				{ reset: "weekly", left: 1, until: "2026-12-01T00:00:00.000Z" },
			],
		});
		const unknown = chooser.map((line) => line.replace("weekly reset", "moon reset"));
		expect(readClaudeResetScreen(screen(unknown), NOW)).toBeUndefined();
	});

	it("reads the answer line Claude Code leaves, joined across its wrap", () => {
		const lines = screen(
			[
				"❯ /limit-reset full",
				"  ⎿  Couldn't confirm the reset went through · check /usage in a moment · if your limits weren't",
				"     refilled, run /limit-reset again",
				"",
				"❯ ",
			],
			100,
		);
		const read = readClaudeResetScreen(lines, NOW);
		expect(read).toEqual({
			kind: "answer",
			line: "Couldn't confirm the reset went through · check /usage in a moment · if your limits weren't refilled, run /limit-reset again",
		});
		expect(readClaudeResetScreen(screen(["❯ /limit-reset", "  · Checking…"]), NOW)).toBeUndefined();
	});

	it("knows each answer Claude Code 2.1.325 gives, and no other", () => {
		expect(claudeResetAnswer("No reset to use · you're not at a usage limit right now", NOW)).toEqual({
			kind: "none",
		});
		expect(
			claudeResetAnswer(
				"You have a reset saved for when you reach a usage limit · run /limit-reset when you do · 1 reset left · use by Dec 1",
				NOW,
			),
		).toEqual({ kind: "saved", left: 1, useBy: "2026-12-01T00:00:00.000Z" });
		expect(claudeResetAnswer("Limits reset · 2 full resets left", NOW)).toEqual({ kind: "reset", left: 2 });
		expect(
			claudeResetAnswer("5-hour limit reset · your weekly reset day stays Nov 20 · no five-hour resets left", NOW),
		).toEqual({ kind: "reset", left: 0 });
		expect(claudeResetAnswer("Weekly limits reset · 1 weekly reset left", NOW)).toEqual({ kind: "reset", left: 1 });
		expect(claudeResetAnswer("Fable reset used · what Fable used is back in your weekly limit", NOW)).toEqual({
			kind: "reset",
			left: null,
		});
		expect(claudeResetAnswer("Couldn't reset your limits · nothing was used · try again in a moment", NOW)).toEqual({
			kind: "failed",
		});
		expect(claudeResetAnswer("No weekly reset to use · you can use a full reset", NOW)).toEqual({ kind: "failed" });
		expect(
			claudeResetAnswer(
				"Couldn't confirm the reset went through · if you're still at the limit in a moment, try again",
				NOW,
			),
		).toEqual({ kind: "unconfirmed" });
		expect(claudeResetAnswer("Still couldn't confirm your reset · nothing more was used", NOW)).toEqual({
			kind: "unconfirmed",
		});
		expect(claudeResetAnswer("Full reset kept · run /limit-reset whenever you want to use it", NOW)).toBeUndefined();
		expect(claudeResetAnswer("Something new", NOW)).toBeUndefined();
	});

	it("dates the screen's day and time near now, in UTC as the read runs", () => {
		expect(claudeScreenDate("Dec 1, 10:51am", NOW)).toBe("2026-12-01T10:51:00.000Z");
		expect(claudeScreenDate("Jan 3, 12:05pm", NOW)).toBe("2027-01-03T12:05:00.000Z");
		expect(claudeScreenDate("Nov 16", NOW)).toBe("2026-11-16T00:00:00.000Z");
		expect(claudeScreenDate("Feb 30", NOW)).toBeNull();
		expect(claudeScreenDate("tomorrow", NOW)).toBeNull();
	});
});
