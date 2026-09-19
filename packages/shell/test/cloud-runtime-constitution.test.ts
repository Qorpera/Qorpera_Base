import {
	CLOUD_RUNTIME_CONSTITUTION,
	CLOUD_RUNTIME_CONSTITUTION_VERSION,
} from "@qorpera/runtime/cloud-runtime-constitution";
import { describe, expect, it } from "vitest";

describe("shared cloud runtime constitution", () => {
	it("has a stable version and remains short enough to read in one pass", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION_VERSION).toBe("qorpera-cloud-runtime-constitution-v1");
		expect(CLOUD_RUNTIME_CONSTITUTION.trim().split(/\s+/).length).toBeLessThanOrEqual(650);
		expect(CLOUD_RUNTIME_CONSTITUTION.match(/^\d+\. /gm)).toHaveLength(10);
	});

	it("keeps the shared laws separate from hire identity and tool protocols", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("separate hire overlay");
		expect(CLOUD_RUNTIME_CONSTITUTION).not.toMatch(/Co-Founder|formation workflow|vision_proposal/);
		expect(CLOUD_RUNTIME_CONSTITUTION).not.toMatch(/qorpera_[a-z_]+|mcp__|JSON schema/);
	});

	it("covers durable state, delivery, authority, and safe edge behavior", () => {
		for (const topic of [
			"one live Company File",
			"no-change result",
			"successful Qorpera send",
			"typed wake",
			"founder stop",
			"another audience",
			"effect-time checks",
			"skills and scoped memory",
			"out-of-band custody",
			"dismissed interaction",
		]) {
			expect(CLOUD_RUNTIME_CONSTITUTION).toContain(topic);
		}
	});

	it("does not present later runtime capabilities as unconditional guarantees", () => {
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("only when worker capabilities are available");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("only when available and authorized");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("intentions in prose do not schedule work");
		expect(CLOUD_RUNTIME_CONSTITUTION).toContain("Never approve your own gated action");
	});
});
