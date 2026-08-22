import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPANY_POLICY,
	formatCompanyPolicyInstructions,
	parseCompanyPolicy,
	updateCompanyPolicySource,
} from "../src/core/company-policy.ts";

describe("company policy instructions", () => {
	it("defaults every category to ask", () => {
		expect(parseCompanyPolicy('[money]\nmode = "gate"\n')).toEqual(DEFAULT_COMPANY_POLICY);
	});

	it("formats ask, act, and auto as behavioral guidance rather than permissions", () => {
		const instructions = formatCompanyPolicyInstructions({
			spending: "ask",
			external_communication: "act",
			hard_to_reverse_changes: "auto",
			information_sharing: "ask",
		});

		expect(instructions).toContain("behavioral instructions, not technical permissions");
		expect(instructions).toContain(
			"Spending, purchases, subscriptions, or other financial commitments: Ask the user",
		);
		expect(instructions).toContain("External communication sent or published as the company: Take this action when");
		expect(instructions).toContain("hard-to-reverse changes: Take this action without asking");
		expect(instructions).toContain("They never expand access or bypass safeguards.");
	});

	it("updates only the policy keys while preserving comments and technical authority sections", () => {
		const source = `# Founder policy\n[irreversible]\nmode = "gate"\n\n# Keep the tool mapping\n[tools]\ndeploy = "irreversible"\n`;
		const updated = updateCompanyPolicySource(source, {
			spending: "act",
			external_communication: "auto",
			hard_to_reverse_changes: "ask",
			information_sharing: "act",
		});

		expect(updated).toContain("# Founder policy");
		expect(updated).toContain("# Keep the tool mapping");
		expect(updated).toContain('[tools]\ndeploy = "irreversible"');
		expect(parseCompanyPolicy(updated)).toEqual({
			spending: "act",
			external_communication: "auto",
			hard_to_reverse_changes: "ask",
			information_sharing: "act",
		});
	});

	it("preserves comments and unknown fields inside an existing policy section", () => {
		const source = `[policy]\n# Deliberate choice\nspending = "ask" # Ask by default\nfuture_option = "keep"\n\n[tools]\ndeploy = "irreversible"\n`;
		const updated = updateCompanyPolicySource(source, {
			spending: "auto",
			external_communication: "act",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		});

		expect(updated).toContain("# Deliberate choice");
		expect(updated).toContain('future_option = "keep"');
		expect(updated).toContain('spending = "auto" # Ask by default');
		expect(updated).toContain('[tools]\ndeploy = "irreversible"');
	});

	it("updates quoted policy tables and keys without creating duplicate TOML fields", () => {
		const source = `["policy"]\n"spending" = "ask"\n'external_communication' = "ask"\n`;
		const updated = updateCompanyPolicySource(source, {
			spending: "auto",
			external_communication: "act",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		});

		expect(parseCompanyPolicy(updated)).toEqual({
			spending: "auto",
			external_communication: "act",
			hard_to_reverse_changes: "ask",
			information_sharing: "ask",
		});
		expect(updated.match(/"spending"\s*=/g)).toHaveLength(1);
		expect(updated.match(/external_communication'\s*=/g)).toHaveLength(1);
	});

	it("refuses valid TOML shapes that cannot be updated without redefining the policy table", () => {
		const source = `policy = { spending = "ask" }\n`;
		expect(() => updateCompanyPolicySource(source, DEFAULT_COMPANY_POLICY)).toThrow();
	});

	it("refuses to overwrite malformed TOML", () => {
		expect(() => updateCompanyPolicySource("not [valid toml", DEFAULT_COMPANY_POLICY)).toThrow();
	});
});
