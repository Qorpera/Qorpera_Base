import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, oneOf, record, timestamp, uuid } from "./parse.ts";

/* Good will (migration 20260930566000; design good-will-tax-design.md): a company pays a falling-step share of each
 * month's customer sales, 10 % of the first 100,000 kr down to 0.2 % over 1 million. Members read the Company tab's
 * good will (qorpera_company_good_will) and each member their companies' (qorpera_my_good_will); a founder saves the
 * company's card on Stripe's own page through the computer-billing function. Amounts are øre. */

export const GOOD_WILL_MONTH_STATUSES = ["open", "sorting", "closed", "carried", "zero", "charged", "failed"] as const;
export type GoodWillMonthStatus = (typeof GOOD_WILL_MONTH_STATUSES)[number];

export interface GoodWillMonth {
	/** YYYY-MM. */
	month: string;
	status: GoodWillMonthStatus;
	/** Sales without moms, what the steps apply to. */
	netOre: number;
	feeOre: number;
	/** The fee plus what earlier months rolled over, without the invoice's moms. */
	dueOre: number;
	chargedAt: string | null;
	invoiceUrl: string | null;
}

export interface GoodWillCard {
	mine: boolean;
	payerName: string | null;
	brand: string | null;
	last4: string | null;
}

export interface CompanyGoodWill {
	profileId: string;
	companyName: string;
	/** Founders save the company's card. */
	canAddCard: boolean;
	card: GoodWillCard | null;
	/** Newest first: this month so far, then the last twelve. */
	months: GoodWillMonth[];
	steps: { fromOre: number; toOre: number | null; rateBp: number }[];
	/** Null when no steps apply yet. */
	minChargeOre: number | null;
}

export interface MyGoodWillCompany {
	profileId: string;
	name: string;
	netOre: number;
	feeOre: number;
	/** The rate of the first step: what a small company pays. */
	rateBp: number | null;
	payer: "me" | "other" | "none";
	brand: string | null;
	last4: string | null;
}

export interface MyGoodWill {
	year: number;
	paidByMeOre: number;
	companies: MyGoodWillCompany[];
}

const MAX_ORE = Number.MAX_SAFE_INTEGER;
const ore = (value: unknown, label: string) => boundedInteger(value, label, 0, MAX_ORE);

function text(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new CloudShapeError(label);
	return value;
}

function flag(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new CloudShapeError(label);
	return value;
}

/** Only Stripe's own invoice pages are linked. */
function invoiceUrl(value: unknown): string | null {
	const url = text(value, "good will invoice");
	if (url === null) return null;
	try {
		return new URL(url).origin === "https://invoice.stripe.com" ? url : null;
	} catch {
		return null;
	}
}

function parseMonth(value: unknown): GoodWillMonth {
	const input = record(value, "good will month");
	if (typeof input.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month))
		throw new CloudShapeError("good will month");
	return {
		month: input.month,
		status: oneOf(input.status, GOOD_WILL_MONTH_STATUSES, "good will month status"),
		netOre: ore(input.netOre, "good will sales"),
		feeOre: ore(input.feeOre, "good will fee"),
		dueOre: ore(input.dueOre, "good will due"),
		chargedAt: input.chargedAt === null ? null : timestamp(input.chargedAt, "good will charged at"),
		invoiceUrl: invoiceUrl(input.invoiceUrl),
	};
}

export function parseCompanyGoodWill(value: unknown, profileId: string): CompanyGoodWill {
	const input = record(value, "company good will");
	if (input.schema !== "qorpera.company-good-will/v1") throw new CloudShapeError("company good will");
	const company = uuid(input.profileId, "company good will company");
	if (company !== profileId.toLowerCase()) throw new CloudShapeError("company good will company");
	const card = input.card === null ? null : record(input.card, "good will card");
	return {
		profileId: company,
		companyName: text(input.companyName, "good will company name") ?? "",
		canAddCard: flag(input.canAddCard, "good will card founder"),
		card: card
			? {
					mine: flag(card.mine, "good will card owner"),
					payerName: text(card.payerName, "good will card payer"),
					brand: text(card.brand, "good will card brand"),
					last4: text(card.last4, "good will card digits"),
				}
			: null,
		months: array(input.months, "good will months").map(parseMonth),
		steps: array(input.steps, "good will steps").map((item) => {
			const step = record(item, "good will step");
			return {
				fromOre: ore(step.fromOre, "good will step"),
				toOre: step.toOre === null ? null : ore(step.toOre, "good will step"),
				rateBp: boundedInteger(step.rateBp, "good will rate", 0, 10_000),
			};
		}),
		minChargeOre: input.minChargeOre === null ? null : ore(input.minChargeOre, "good will least charge"),
	};
}

export function parseMyGoodWill(value: unknown): MyGoodWill {
	const input = record(value, "my good will");
	if (input.schema !== "qorpera.my-good-will/v1") throw new CloudShapeError("my good will");
	return {
		year: boundedInteger(input.year, "good will year", 2000, 9999),
		paidByMeOre: ore(input.paidByMeOre, "good will paid"),
		companies: array(input.companies, "good will companies").map((item) => {
			const company = record(item, "good will company");
			return {
				profileId: uuid(company.profileId, "good will company"),
				name: text(company.name, "good will company name") ?? "",
				netOre: ore(company.netOre, "good will sales"),
				feeOre: ore(company.feeOre, "good will fee"),
				rateBp: company.rateBp === null ? null : boundedInteger(company.rateBp, "good will rate", 0, 10_000),
				payer: oneOf(company.payer, ["me", "other", "none"] as const, "good will payer"),
				brand: text(company.brand, "good will card brand"),
				last4: text(company.last4, "good will card digits"),
			};
		}),
	};
}

export async function readCompanyGoodWill(cloud: Pick<Cloud, "rpc">, profileId: string): Promise<CompanyGoodWill> {
	return parseCompanyGoodWill(await cloud.rpc("qorpera_company_good_will", { p_profile_id: profileId }), profileId);
}

export async function readMyGoodWill(cloud: Pick<Cloud, "rpc">): Promise<MyGoodWill> {
	return parseMyGoodWill(await cloud.rpc("qorpera_my_good_will", {}));
}

/** Why the billing function turned a card page down. */
export type GoodWillCardRefusal = "not_a_founder" | "not_open" | "unavailable";

export class GoodWillCardError extends Error {
	readonly refusal: GoodWillCardRefusal;
	constructor(refusal: GoodWillCardRefusal) {
		super(`Good will card refused: ${refusal}`);
		this.name = "GoodWillCardError";
		this.refusal = refusal;
	}
}

/** Stripe's own page (checkout.stripe.com) where a founder saves the card that pays the company's good will. */
export async function startGoodWillCard(cloud: Cloud, profileId: string): Promise<string> {
	const { data } = await cloud.supabase.auth.getSession();
	const token = data.session?.access_token;
	if (!token) throw new GoodWillCardError("unavailable");
	const address = `${cloud.config.projectUrl}/functions/v1/computer-billing/good-will-card`;
	let response: Response;
	try {
		response = await fetch(address, {
			method: "POST",
			headers: {
				apikey: cloud.config.publishableKey,
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ profileId }),
			redirect: "error",
			credentials: "omit",
		});
	} catch {
		throw new GoodWillCardError("unavailable");
	}
	cloud.noticeResponse?.(address, token, response);
	const answer: unknown = await response.json().catch(() => null);
	const fields =
		answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
	if (response.status === 409)
		throw new GoodWillCardError(
			fields.refused === "not_a_founder" || fields.refused === "not_open" ? fields.refused : "unavailable",
		);
	if (!response.ok || typeof fields.url !== "string") throw new GoodWillCardError("unavailable");
	const url = new URL(fields.url);
	if (url.origin !== "https://checkout.stripe.com") throw new GoodWillCardError("unavailable");
	return url.href;
}
