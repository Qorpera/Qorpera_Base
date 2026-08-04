import { describe, expect, it } from "vitest";
import { resolveModelSelection } from "../src/pi-harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model over environment defaults", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ QORPERA_PROVIDER: "openai-codex", QORPERA_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults when the harness has no explicit model", () => {
		expect(
			resolveModelSelection(undefined, { QORPERA_PROVIDER: " openai-codex ", QORPERA_MODEL: " gpt-5.6-sol " }),
		).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([
		[undefined, {}],
		[undefined, { QORPERA_PROVIDER: "openai-codex" }],
		[undefined, { QORPERA_MODEL: "gpt-5.6-sol" }],
		[
			{ provider: "", id: "gpt-5.6-sol" },
			{ QORPERA_PROVIDER: "openai-codex", QORPERA_MODEL: "gpt-5.6-sol" },
		],
	] as const)("rejects an incomplete model selection", (explicitModel, environment) => {
		expect(() => resolveModelSelection(explicitModel, environment)).toThrow(
			"Select a harness model explicitly or set both QORPERA_PROVIDER and QORPERA_MODEL as defaults.",
		);
	});
});
