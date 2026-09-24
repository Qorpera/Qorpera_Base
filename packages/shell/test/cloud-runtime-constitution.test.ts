import {
	CLOUD_RUNTIME_CONSTITUTION,
	CLOUD_RUNTIME_CONSTITUTION_VERSION,
} from "@qorpera/runtime/cloud-runtime-constitution";
import { describe, expect, it } from "vitest";

describe("shared cloud runtime constitution", () => {
	it("has a stable version and remains short enough to read in one pass", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION_VERSION).toBe("qorpera-cloud-runtime-constitution-v2");
		expect(CLOUD_RUNTIME_CONSTITUTION.trim().split(/\s+/).length).toBeLessThanOrEqual(650);
		expect(CLOUD_RUNTIME_CONSTITUTION.match(/^\d+\. /gm)).toHaveLength(10);
	});

	it("keeps the shared laws separate from hire identity and tool protocols", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("given to you separately");
		expect(CLOUD_RUNTIME_CONSTITUTION).not.toMatch(/Co-Founder|formation workflow|vision_proposal/);
		expect(CLOUD_RUNTIME_CONSTITUTION).not.toMatch(/qorpera_[a-z_]+|mcp__|JSON schema/);
	});

	// Contract section 18: the ten topics the constitution covers.
	it("covers durable state, delivery, authority, and safe edge behavior", () => {
		for (const topic of [
			"one live Company File",
			"no-change result",
			"Only your sends are seen",
			"typed wake",
			"another audience",
			"the checks made at the moment of every action",
			"company-owned notebook",
			"secret and sign-in cards",
			"dismissed card",
			"end your turn and let the event wake you",
		]) {
			expect(CLOUD_RUNTIME_CONSTITUTION).toContain(topic);
		}
	});

	it("does not present later runtime capabilities as unconditional guarantees", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("to workers when you have them");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("only when one of your tools provides it");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("intentions in prose schedule nothing");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("Never approve your own gated action");
	});

	it("carries no runtime control that no longer exists", () => {
		// The founder stop and company ceilings were removed on 2026-09-24 (contract 7.4).
		expect(CLOUD_RUNTIME_CONSTITUTION).not.toMatch(/founder stop|runtime limits|listeners|retrieval indexes/);
	});
});
