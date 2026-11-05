import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import { cloudGoodWillTools } from "@qorpera/runtime/cloud-good-will-tools";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const ITEM = "56600000-0000-4000-8000-000000000001";
const OTHER = "56600000-0000-4000-8000-000000000002";

async function fixture(answer?: (method: string, args: Record<string, unknown>, runId: string) => unknown) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		const values = args as Record<string, unknown>;
		if (answer) return answer(method, values, binding.runId);
		if (method === "qorpera_good_will_agent_list")
			return {
				schema: "qorpera.good-will-month/v1",
				runId: binding.runId,
				month: { month: "2026-11", status: "sorting", netOre: 0, feeOre: 0, unsorted: 1 },
				items: [{ id: ITEM, amountOre: 5_000_000, currency: "DKK", counted: null }],
				itemCount: 1,
				shown: 1,
			};
		const marks = (values.p_request as { marks: { itemId: string; reason: string }[] }).marks;
		return {
			schema: "qorpera.good-will-marks/v1",
			runId: binding.runId,
			items: marks.map((mark) => ({ id: mark.itemId, reason: mark.reason, counted: mark.reason === "sale" })),
			months: [{ month: "2026-11", netOre: 4_000_000, feeOre: 400_000 }],
		};
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudGoodWillTools(binding, run.identity, { call }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
	});
	return { binding, run, call, boundary };
}

describe("good will tools", () => {
	it("lists a month's payments and sorts them through the run binding", async () => {
		const f = await fixture();
		try {
			const listed = await f.boundary.invoke("gw_1", "qorpera", "good_will_list", {});
			expect(listed.success, JSON.stringify(listed)).toBe(true);
			expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual([
				"qorpera_good_will_agent_list",
				{ p_binding: f.binding, p_month: null },
			]);
			await f.boundary.invoke("gw_2", "qorpera", "good_will_list", { month: "2026-11" });
			expect(f.call.mock.calls[1]?.[1]).toEqual({ p_binding: f.binding, p_month: "2026-11" });
			const marked = await f.boundary.invoke("gw_3", "qorpera", "good_will_mark", {
				marks: [
					{ itemId: ITEM.toUpperCase(), reason: "sale", momsOre: 0 },
					{ itemId: OTHER, reason: "member_money", note: "  The owner's loan.  " },
				],
			});
			expect(marked.success, JSON.stringify(marked)).toBe(true);
			expect(f.call.mock.calls[2]?.slice(0, 2)).toEqual([
				"qorpera_good_will_agent_mark",
				{
					p_binding: f.binding,
					p_request: {
						marks: [
							{ itemId: ITEM, reason: "sale", momsOre: 0 },
							{ itemId: OTHER, reason: "member_money", note: "The owner's loan." },
						],
					},
				},
			]);
			expect(marked.contentItems[0]?.text).toContain('"feeOre":400000');
			expect(JSON.stringify(marked)).not.toContain(f.binding.credentialCapsuleId);
		} finally {
			f.run.close();
		}
	});

	it("refuses a malformed request without calling the cloud", async () => {
		const f = await fixture();
		try {
			for (const [callId, tool, args] of [
				["bad_1", "good_will_list", { month: "2026-13" }],
				["bad_2", "good_will_list", { month: "2026-11", extra: true }],
				["bad_3", "good_will_mark", { marks: [] }],
				["bad_4", "good_will_mark", { marks: [{ itemId: ITEM, reason: "gift" }] }],
				["bad_5", "good_will_mark", { marks: [{ itemId: "not-a-uuid", reason: "sale" }] }],
				["bad_6", "good_will_mark", { marks: [{ itemId: ITEM, reason: "refund", momsOre: 10 }] }],
				["bad_7", "good_will_mark", { marks: [{ itemId: ITEM, reason: "sale", momsOre: 1.5 }] }],
				["bad_8", "good_will_mark", { marks: [{ itemId: ITEM, reason: "sale", note: "x".repeat(201) }] }],
				[
					"bad_9",
					"good_will_mark",
					{
						marks: [
							{ itemId: ITEM, reason: "sale" },
							{ itemId: ITEM, reason: "refund" },
						],
					},
				],
				[
					"bad_10",
					"good_will_mark",
					{ marks: Array.from({ length: 101 }, () => ({ itemId: ITEM, reason: "sale" })) },
				],
			] as const) {
				const refused = await f.boundary.invoke(callId, "qorpera", tool, args);
				expect(refused.success, callId).toBe(false);
			}
			expect(f.call).not.toHaveBeenCalled();
		} finally {
			f.run.close();
		}
	});

	it("hands the database's refusal to the model, and rejects a receipt for another run", async () => {
		const refusal = await fixture(() => {
			throw new CloudControlRpcRefused("55000", "Good will: 2026-11 is final; its payments can no longer change");
		});
		try {
			const refused = await refusal.boundary.invoke("gw_4", "qorpera", "good_will_mark", {
				marks: [{ itemId: ITEM, reason: "sale" }],
			});
			expect(JSON.stringify(refused)).toContain("2026-11 is final");
		} finally {
			refusal.run.close();
		}
		const other = await fixture(() => ({
			schema: "qorpera.good-will-month/v1",
			runId: "00000000-0000-4000-8000-000000000000",
			month: {},
			items: [],
		}));
		try {
			const differs = await other.boundary.invoke("gw_5", "qorpera", "good_will_list", {});
			expect(differs.success).toBe(false);
			expect(JSON.stringify(differs)).not.toContain('"items"');
		} finally {
			other.run.close();
		}
	});
});
