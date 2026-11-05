import { type JsonValue, normalizeUuid } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CloudControlRefusalRelay,
	type CloudNativeTool,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/* Good will (migration 20260930566000; design good-will-tax-design.md): the company pays Qorpera a falling-step share
 * of each month's customer sales, counted from the payments its bank shows. The finance agent (the Co-Founder until
 * one is hired) sorts last month's payments in the first days of a month: what was a sale counts, money from members,
 * moves between the company's own accounts, refunds, moms back, loans and grants do not. On the 5th the month is final
 * and a payment nobody sorted counts as a sale. */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const GOOD_WILL_REASONS = [
	"sale",
	"member_money",
	"own_transfer",
	"refund",
	"moms_back",
	"loan_or_grant",
	"other",
] as const;

export const CLOUD_GOOD_WILL_LIST_DESCRIPTION =
	"List a month's payments into the company's bank and what counted for the company's good will (what it pays Qorpera: 10 % of the month's first 100,000 kr of sales without moms, then less). " +
	"month is YYYY-MM; leave it out for last month. Amounts are øre (100 øre = 1 kr). Each payment has its id, day, amount, who paid and the bank text; counted is null until sorted. " +
	"The month's status is open while it runs, sorting from the 1st until the 5th, then final: closed (to be charged), carried (under 100 kr, added to next month), zero, charged or failed. " +
	"A final month's payments can no longer change; a payment nobody sorted by the 5th counts as a sale.";

export const CLOUD_GOOD_WILL_MARK_DESCRIPTION =
	"Sort the company's payments for its good will, 1 to 100 at once, all or none. reason sale counts a payment; member_money (a member's loan or share capital), own_transfer (between the company's own accounts), refund, moms_back (moms from Skattestyrelsen), loan_or_grant and other do not. " +
	"For a sale, momsOre is the moms inside it in øre: leave it out for a Danish sale (a fifth of the amount, 25 % moms), 0 for a sale abroad or without moms. Only payments in kroner count. A note (1 to 200 characters) says why when it is not plain. " +
	"Sort only what you can tell from the payment, the company's files and what members said; when unsure, ask. A member can change any payment. " +
	"In the first days of each month, list last month, sort what is unsorted, then show the members what counted with ask_member (a question card: the month, what it will cost, what counted and what did not, options Looks right and Change something), and change what they say.";

/** One mark: the payment, its reason, and maybe the moms in a sale and a note. */
type GoodWillMark = { itemId: string; reason: string; momsOre?: number; note?: string };

function parseMark(value: unknown): { [key: string]: JsonValue } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid good will mark");
	const a = value as Record<string, unknown>;
	if (
		Object.keys(a).some((key) => !["itemId", "reason", "momsOre", "note"].includes(key)) ||
		!normalizeUuid(a.itemId) ||
		typeof a.reason !== "string" ||
		!(GOOD_WILL_REASONS as readonly string[]).includes(a.reason) ||
		(a.momsOre !== undefined &&
			(typeof a.momsOre !== "number" || !Number.isSafeInteger(a.momsOre) || a.momsOre < 0 || a.reason !== "sale")) ||
		(a.note !== undefined &&
			(typeof a.note !== "string" || !a.note.trim() || [...a.note.trim()].length > 200 || /\p{Cc}/u.test(a.note)))
	)
		throw new Error("Invalid good will mark");
	return {
		itemId: normalizeUuid(a.itemId)!,
		reason: a.reason as string,
		...(a.momsOre !== undefined ? { momsOre: a.momsOre as number } : {}),
		...(a.note !== undefined ? { note: (a.note as string).trim() } : {}),
	};
}

/** The agent tools good_will_list and good_will_mark: a company agent reads and sorts the company's payments. The
 * cloud derives the company and the agent from the run; marking the same way again changes nothing. */
export function cloudGoodWillTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	const refusals = new CloudControlRefusalRelay();
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Good will binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Good will tool identity differs");
		context.signal.throwIfAborted();
	};
	const answered = (result: unknown, schema: string): Record<string, unknown> => {
		const r = result as Record<string, unknown> | null;
		if (!r || typeof r !== "object" || r.schema !== schema || r.runId !== admitted.runId)
			throw new Error("Good will receipt differs");
		return r;
	};
	const list: CloudNativeTool = {
		name: "good_will_list" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_GOOD_WILL_LIST_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			properties: { month: { type: "string", pattern: MONTH.source } },
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid good will request");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => key !== "month") ||
				(a.month !== undefined && (typeof a.month !== "string" || !MONTH.test(a.month)))
			)
				throw new Error("Invalid good will request");
			const request: JsonValue = a.month === undefined ? {} : { month: a.month as string };
			return request;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as { month?: string };
			// A read: a refusal (a month before good will began, say) is the tool's answer.
			const result = await refusals.call(undefined, () =>
				cloudToolRequest(
					(requestSignal) =>
						control.call(
							"qorpera_good_will_agent_list",
							{ p_binding: admitted, p_month: request.month ?? null },
							requestSignal,
						),
					context.signal,
				),
			);
			const r = answered(result, "qorpera.good-will-month/v1");
			if (!Array.isArray(r.items) || !r.month || typeof r.month !== "object")
				throw new Error("Good will receipt differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	const mark: CloudNativeTool = {
		name: "good_will_mark" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_GOOD_WILL_MARK_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["marks"],
			properties: {
				marks: {
					type: "array",
					minItems: 1,
					maxItems: 100,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["itemId", "reason"],
						properties: {
							itemId: { type: "string", format: "uuid" },
							reason: { type: "string", enum: [...GOOD_WILL_REASONS] },
							momsOre: { type: "integer", minimum: 0 },
							note: { type: "string", minLength: 1, maxLength: 200 },
						},
					},
				},
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid good will request");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => key !== "marks") ||
				!Array.isArray(a.marks) ||
				a.marks.length < 1 ||
				a.marks.length > 100
			)
				throw new Error("Invalid good will request");
			const marks = a.marks.map(parseMark);
			if (new Set(marks.map((each) => each.itemId as string)).size !== marks.length)
				throw new Error("Each payment is marked once a call");
			return { marks };
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as unknown as { marks: GoodWillMark[] };
			// Marking is the same whatever came before, so a refusal of a retry says nothing of an earlier attempt that
			// is not true of this one: it is the tool's answer.
			const result = await refusals.call(undefined, () =>
				cloudToolRequest(
					(requestSignal) =>
						control.call(
							"qorpera_good_will_agent_mark",
							{ p_binding: admitted, p_request: request },
							requestSignal,
						),
					context.signal,
				),
			);
			const r = answered(result, "qorpera.good-will-marks/v1");
			if (!Array.isArray(r.items) || r.items.length !== request.marks.length || !Array.isArray(r.months))
				throw new Error("Good will receipt differs");
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	return [list, mark];
}
