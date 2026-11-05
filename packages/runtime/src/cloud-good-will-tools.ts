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
	"month is YYYY-MM; leave it out for last month. show is unsorted (the default) or all; a long list comes in pages: pass the answer's next as offset for the rest. Amounts are øre (100 øre = 1 kr). " +
	"The first line is the month: its status (open while it runs, sorting from the 1st, then final: closed to be charged, carried under 100 kr to next month, zero, charged or failed), what counted, the fee and how many wait to be sorted. Then one line per payment: its id, day, amount, who paid, the bank text and, once sorted, the reason and who decided. " +
	"A final month's payments can no longer change; a payment nobody sorted by the 5th counts as a sale.";

export const CLOUD_GOOD_WILL_MARK_DESCRIPTION =
	"Sort the company's payments for its good will, 1 to 100 at once, all or none. reason sale counts a payment; member_money (a member's loan or share capital), own_transfer (between the company's own accounts), refund, moms_back (moms from Skattestyrelsen), loan_or_grant and other do not. " +
	"For a sale, momsOre is the moms inside it in øre: leave it out for a Danish sale (a fifth of the amount, 25 % moms), 0 for a sale abroad or without moms. Only payments in kroner count. A note (1 to 200 characters) says why when it is not plain. " +
	"Sort only what you can tell from the payment, the company's files and what members said; when unsure, ask. A payment a member sorted is theirs: never mark it again. " +
	"The monthly sorting is the money owner's (the Co-Founder's until one is hired), not every agent's; another agent sorts only when a member asks it to. When you have sorted a month, show the members what counted once with ask_member (a question card: the month, what it will cost, what counted and what did not, options Looks right and Change something) and change what they say. " +
	"A refusal that the month is final can follow an earlier attempt of the same marks that went through: list the month to see.";

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

/** What the tool shows of a month: what counted, the fee, what is due and how many wait. */
function monthSummary(value: unknown): JsonValue {
	const month = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
	const keep = ["month", "status", "salesOre", "momsOre", "netOre", "feeOre", "carriedInOre", "dueOre", "unsorted"];
	return Object.fromEntries(
		keep.filter((key) => month[key] !== undefined).map((key) => [key, month[key] as JsonValue]),
	);
}

/** One payment in a line: only what sorting it needs. */
function paymentLine(value: unknown): string {
	const item = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
	const text = typeof item.text === "string" ? item.text.slice(0, 120) : undefined;
	return cloudToolJsonText({
		id: item.id as JsonValue,
		day: item.bookedOn as JsonValue,
		amountOre: item.amountOre as JsonValue,
		...(item.currency !== "DKK" ? { currency: item.currency as JsonValue } : {}),
		...(typeof item.counterparty === "string" ? { from: item.counterparty } : {}),
		...(text ? { text } : {}),
		...(item.reason ? { reason: item.reason as JsonValue, by: item.decidedBy as JsonValue } : {}),
		...(item.counted === true ? { momsOre: item.momsOre as JsonValue } : {}),
		...(typeof item.note === "string" ? { note: item.note } : {}),
	});
}

/** The tool result's room (8 KiB) less its envelope. */
const LIST_BYTES = 6000;

/** The month's line first, then the payments from `offset` that fit, and where the rest starts. */
export function goodWillMonthText(answer: Record<string, unknown>, show: "unsorted" | "all", offset: number): string {
	const items = (answer.items as unknown[]).filter(
		(item) => show === "all" || (item as Record<string, unknown> | null)?.counted === null,
	);
	const lines = [cloudToolJsonText({ month: monthSummary(answer.month), show, payments: items.length })];
	let bytes = Buffer.byteLength(lines[0]!);
	let next = offset;
	for (; next < items.length; next++) {
		const line = paymentLine(items[next]);
		if (bytes + Buffer.byteLength(line) + 1 > LIST_BYTES) break;
		lines.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	const shownTo = next;
	if (shownTo < items.length) lines.push(cloudToolJsonText({ shown: `${offset}-${shownTo}`, next: shownTo }));
	const total = typeof answer.itemCount === "number" ? answer.itemCount : items.length;
	const listed = Array.isArray(answer.items) ? answer.items.length : 0;
	if (total > listed)
		lines.push(cloudToolJsonText({ notListed: total - listed, why: "sort these and list again for the rest" }));
	return lines.join("\n");
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
			properties: {
				month: { type: "string", pattern: MONTH.source },
				show: { type: "string", enum: ["unsorted", "all"] },
				offset: { type: "integer", minimum: 0, maximum: 300 },
			},
		},
		parseArguments(value) {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid good will request");
			const a = value as Record<string, unknown>;
			if (
				Object.keys(a).some((key) => !["month", "show", "offset"].includes(key)) ||
				(a.month !== undefined && (typeof a.month !== "string" || !MONTH.test(a.month))) ||
				(a.show !== undefined && a.show !== "unsorted" && a.show !== "all") ||
				(a.offset !== undefined &&
					(typeof a.offset !== "number" || !Number.isSafeInteger(a.offset) || a.offset < 0 || a.offset > 300))
			)
				throw new Error("Invalid good will request");
			const request: JsonValue = {
				...(a.month === undefined ? {} : { month: a.month as string }),
				show: (a.show as string | undefined) ?? "unsorted",
				offset: (a.offset as number | undefined) ?? 0,
			};
			return request;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as { month?: string; show: "unsorted" | "all"; offset: number };
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
			if (!Array.isArray(r.items) || !r.month || typeof r.month !== "object" || Array.isArray(r.month))
				throw new Error("Good will receipt differs");
			return { kind: "text", value: goodWillMonthText(r, request.show, request.offset) };
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
			// Marking is idempotent, so a refusal of a retry is the tool's answer: what it refuses (a reason, a currency, a
			// member's payment) refuses the earlier attempt too, except a month that turned final between them, which the
			// description tells the agent to check with a list.
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
			// The months first and the marks counted, so the answer stays well inside the tool result's size.
			return {
				kind: "text",
				value: cloudToolJsonText({ marked: r.items.length, months: r.months.map((month) => monthSummary(month)) }),
			};
		},
	};
	return [list, mark];
}
