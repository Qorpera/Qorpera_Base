import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import { cloudGoodWillTools, goodWillMonthText } from "@qorpera/runtime/cloud-good-will-tools";
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
				items: [
					{
						id: ITEM,
						bookedOn: "2026-11-03",
						amountOre: 5_000_000,
						currency: "DKK",
						counterparty: "Customer ApS",
						counted: null,
					},
					{
						id: OTHER,
						bookedOn: "2026-11-10",
						amountOre: 2_000_000,
						currency: "DKK",
						counted: false,
						reason: "member_money",
						decidedBy: "member",
					},
				],
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
	it("pages a busy month inside the tool result's room, the month's line first", () => {
		const items = Array.from({ length: 60 }, (_, n) => ({
			id: `56600000-0000-4000-8000-${String(n).padStart(12, "0")}`,
			bookedOn: "2026-11-03",
			amountOre: 125_000 + n,
			currency: "DKK",
			counterparty: "A customer with a rather long name ApS",
			text: "Faktura 2026-11 ordre nummer 123456 tak for handlen ".repeat(4),
			counted: null,
		}));
		const answer = { month: { month: "2026-11", status: "sorting", unsorted: 60 }, items, itemCount: 60 };
		const first = goodWillMonthText(answer, "unsorted", 0);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(6000);
		expect(first.split("\n")[0]).toContain('"status":"sorting"');
		const next = JSON.parse(first.split("\n").at(-1)!).next as number;
		expect(next).toBeGreaterThan(5);
		const second = goodWillMonthText(answer, "unsorted", next);
		expect(second).toContain(items[next]!.id);
		expect(second).not.toContain(items[0]!.id);
	});

	it("lists a month's payments and sorts them through the run binding", async () => {
		const f = await fixture();
		try {
			const listed = await f.boundary.invoke("gw_1", "qorpera", "good_will_list", {});
			expect(listed.success, JSON.stringify(listed)).toBe(true);
			expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual([
				"qorpera_good_will_agent_list",
				{ p_binding: f.binding, p_month: null },
			]);
			// The month's line first, then only the unsorted payment, slim.
			const text = listed.contentItems[0]?.text ?? "";
			expect(text).toContain("sorting");
			expect(text).toContain(ITEM);
			expect(text).not.toContain(OTHER);
			const all = await f.boundary.invoke("gw_1b", "qorpera", "good_will_list", { show: "all" });
			expect(all.contentItems[0]?.text).toContain(OTHER);
			await f.boundary.invoke("gw_2", "qorpera", "good_will_list", { month: "2026-11" });
			expect(f.call.mock.calls[2]?.[1]).toEqual({ p_binding: f.binding, p_month: "2026-11" });
			const marked = await f.boundary.invoke("gw_3", "qorpera", "good_will_mark", {
				marks: [
					{ itemId: ITEM.toUpperCase(), reason: "sale", momsOre: 0 },
					{ itemId: OTHER, reason: "member_money", note: "  The owner's loan.  " },
				],
			});
			expect(marked.success, JSON.stringify(marked)).toBe(true);
			expect(f.call.mock.calls[3]?.slice(0, 2)).toEqual([
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
			expect(marked.contentItems[0]?.text).toContain("400000");
			expect(marked.contentItems[0]?.text).toContain("marked");
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
				["bad_2b", "good_will_list", { show: "sorted" }],
				["bad_2c", "good_will_list", { offset: -1 }],
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
