import { describe, expect, it } from "vitest";
import { runFailureInterrupted, runFailureReason } from "../src/ui/run-failure.ts";

describe("why a run stopped, in the member's words", () => {
	it.each([
		[
			"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			"failed",
			/No computer could be started/,
		],
		["Native provider bridge request failed (422)", "failed", /one of its steps was refused/],
		[
			"Runner lease expired before durable completion; durable attempt output requires review",
			"failed",
			/took too long/,
		],
		["You have hit your usage limit. Try again later.", "failed", /usage limit/],
		["Provider credential is invalid", "failed", /connected again/],
		[undefined, "cancelled", /stopped before it finished/],
		["something nobody has seen before", "failed", /internal error/],
	] as const)("%s", (error, status, expected) => {
		const reason = runFailureReason(error, status);
		expect(reason).toMatch(expected);
		// Plain words only: no status codes, no machinery names.
		expect(reason).not.toMatch(/\d{3}|runner|provider|bridge|lease|dispatch/i);
	});
});

describe("whether a stopped run is worth trying again as it is", () => {
	it.each([
		["Runner lease expired before durable completion; durable attempt output requires review", "failed", true],
		[
			"Runner dispatch failed after the final infrastructure attempt: Runner provider request failed (422)",
			"failed",
			true,
		],
		[undefined, "cancelled", true],
		["You have hit your usage limit. Try again later.", "failed", false],
		["Provider credential is invalid", "failed", false],
		["Native provider bridge request failed (422)", "failed", false],
		["something nobody has seen before", "failed", false],
	] as const)("%s → %s", (error, status, expected) => {
		expect(runFailureInterrupted(error, status)).toBe(expected);
	});
});
