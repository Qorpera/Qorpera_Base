import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudReviewRuleTools } from "@qorpera/runtime/cloud-review-rule-tools";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const member = "30000000-0000-4000-8000-000000000001";

async function fixture(result?: (request: Record<string, unknown>, runId: string) => unknown) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (_method, args) => {
		const request = (args as { p_request: Record<string, unknown> }).p_request;
		if (result) return result(request, binding.runId);
		return {
			schema: "qorpera.agent-review-rule/v1",
			runId: binding.runId,
			added: true,
			rule: {
				id: "52000000-0000-4000-8000-000000000001",
				scope: "member",
				memberUserId: member,
				when: request.when,
				outcome: "ask_first",
				createdVia: "agent",
			},
		};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudReviewRuleTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}

describe("agent review rule tool", () => {
	it("adds an Ask first rule for the run's member through the run binding", async () => {
		const f = await fixture();
		try {
			const added = await f.boundary.invoke("rule_1", "qorpera", "add_review_rule", {
				operationKey: "rule-email-customers",
				when: "  email a customer  ",
			});
			expect(added.success, JSON.stringify(added)).toBe(true);
			expect(f.call.mock.calls[0].slice(0, 2)).toEqual([
				"qorpera_add_agent_review_rule",
				{ p_binding: f.binding, p_request: { operationKey: "rule-email-customers", when: "email a customer" } },
			]);
			expect(added.contentItems[0].text).toContain("email a customer");
			expect(JSON.stringify(added)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("refuses an empty, long or extra-field request without calling the cloud", async () => {
		const f = await fixture();
		try {
			for (const [callId, args] of [
				["bad_1", { operationKey: "k", when: "   " }],
				["bad_2", { operationKey: "k", when: "x".repeat(281) }],
				["bad_3", { operationKey: "k", when: "email a customer", outcome: "allow_automatically" }],
				["bad_4", { when: "email a customer" }],
				["bad_5", { operationKey: "has space", when: "email a customer" }],
				["bad_6", { operationKey: "k", when: "line\nbreak" }],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", "add_review_rule", args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("hands a refusal to the model, and rejects a receipt that is not an Ask first rule for this run", async () => {
		const refusal = await fixture((_request, runId) => ({
			schema: "qorpera.agent-review-rule/v1",
			runId,
			added: false,
			rule: null,
			refused: "The member has too many rules to add another",
		}));
		try {
			const refused = await refusal.boundary.invoke("rule_2", "qorpera", "add_review_rule", {
				operationKey: "k",
				when: "email a customer",
			});
			expect(refused.success, JSON.stringify(refused)).toBe(true);
			expect(refused.contentItems[0].text).toContain("too many rules");
		} finally {
			refusal.run.close();
		}
		for (const receipt of [
			(runId: string) => ({
				schema: "qorpera.agent-review-rule/v1",
				runId,
				added: true,
				rule: { scope: "company", outcome: "ask_first", when: "x" },
			}),
			(runId: string) => ({
				schema: "qorpera.agent-review-rule/v1",
				runId,
				added: true,
				rule: { scope: "member", outcome: "allow_automatically", when: "x" },
			}),
			() => ({
				schema: "qorpera.agent-review-rule/v1",
				runId: "00000000-0000-4000-8000-000000000000",
				added: true,
				rule: { scope: "member", outcome: "ask_first", when: "x" },
			}),
			(runId: string) => ({ schema: "qorpera.agent-review-rule/v1", runId, added: true, rule: null, refused: "no" }),
		]) {
			const f = await fixture((_request, runId) => receipt(runId));
			try {
				const result = await f.boundary.invoke("rule_3", "qorpera", "add_review_rule", {
					operationKey: "k",
					when: "email a customer",
				});
				expect(result.success, JSON.stringify(result)).toBe(false);
			} finally {
				f.run.close();
			}
		}
	});
});
