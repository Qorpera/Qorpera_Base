import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

describe("OpenAI Codex thinking levels", () => {
	// The Codex backend always reasons — there is no effort "none" on the
	// subscription lane. An unmapped "off" used to fall through
	// getSupportedThinkingLevels' default-include and painted a dead "Off"
	// stop on the desktop effort slider (observed on GPT-5.6 Sol, shell
	// 0.18.7).
	it("never offers 'off' on a codex reasoning model", () => {
		for (const id of [
			"gpt-5.3-codex-spark",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.5",
			"gpt-5.6-luna",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		] as const) {
			const model = getModel("openai-codex", id);
			expect(model?.reasoning, id).toBe(true);
			expect(getSupportedThinkingLevels(model!), id).not.toContain("off");
		}
	});

	it("keeps the deliberate minimal→low alias on xhigh-capable codex models", () => {
		const sol = getModel("openai-codex", "gpt-5.6-sol");
		const levels = getSupportedThinkingLevels(sol!);
		expect(levels).toContain("minimal");
		expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(sol?.thinkingLevelMap?.minimal).toBe("low");
	});
});
