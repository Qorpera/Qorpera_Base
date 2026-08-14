import { describe, expect, it } from "vitest";
import { KERNEL_PROMPT } from "../src/core/company.ts";

describe("company kernel host access", () => {
	it("teaches controllers to use host commands, credentials, network, and browser login", () => {
		expect(KERNEL_PROMPT).toMatch(/same host\s+permissions and environment as their terminal/);
		expect(KERNEL_PROMPT).toMatch(/existing Git and cloud credential\s+helpers/);
		expect(KERNEL_PROMPT).toContain("start normal browser-based login flows");
		expect(KERNEL_PROMPT).toContain("never claim that you are\noffline, sandboxed");
	});
});
