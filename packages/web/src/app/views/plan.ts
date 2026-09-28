import type { ComputerHourOffer } from "../../cloud/computer-billing.ts";
import type { CompanyComputerHours } from "../../cloud/computer-hours.ts";
import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { phrase, presentationLocale, t, uiText } from "../../ui/preferences.ts";
import type { PlanPaymentsState } from "../plan-payments.ts";
import type { AccountViewState } from "./account.ts";
import { meter, storageSummary } from "./storage-summary.ts";

/** The plans qorpera.com sells (2026-09-22): a monthly price that buys
 * computer hours and storage. Computer hours are the price divided by the
 * plan's hourly rate (Basis 2.50 kr, Standard 2.20 kr, Dedicated 1.99 kr). */
export interface PlanOffer {
	key: string;
	name: string;
	monthlyKr: number;
	/** Rounded usage discount against the metered rate, as the site shows it. */
	usageDiscount?: number;
	tagline: string;
	includesLabel?: string;
	includes: string[];
	/** Computer hours a month; undefined means a computer all month. */
	includedHours?: number;
}

export const PLAN_OFFERS: PlanOffer[] = [
	{
		key: "basis",
		name: phrase("Basis"),
		monthlyKr: 185,
		tagline: phrase("For the daily work."),
		includes: [
			phrase("100 GB storage included"),
			phrase("74 computer hours a month"),
			phrase("Connect from computer and phone"),
			phrase("Work in the cloud while your computer is off"),
		],
		includedHours: 74,
	},
	{
		key: "standard",
		name: phrase("Standard"),
		monthlyKr: 630,
		usageDiscount: 37,
		tagline: phrase("More storage and extra computer use."),
		includesLabel: phrase("Everything in Basis, plus"),
		includes: [
			phrase("250 GB storage included"),
			phrase("More than 3.5× extra computer use"),
			phrase("Priority access at peak hours"),
		],
		includedHours: 286,
	},
	{
		key: "dedicated",
		name: phrase("Dedicated computer"),
		monthlyKr: 1592,
		usageDiscount: 43,
		tagline: phrase("Your own computer all month."),
		includesLabel: phrase("Everything in Standard, plus"),
		includes: [
			phrase("500 GB storage included"),
			phrase("A dedicated computer all month"),
			phrase("Early access to new features"),
		],
	},
];

const PLAN_NAMES: Record<string, string> = {
	internal: phrase("Complimentary"),
	freemium: phrase("Free trial"),
	trial: phrase("Free trial"),
	basis: phrase("Basis"),
	standard: phrase("Standard"),
	dedicated: phrase("Dedicated computer"),
	pro: phrase("Pro"),
	team: phrase("Team"),
};

export function planName(planKey: string): string {
	return PLAN_NAMES[planKey] ?? planKey.replaceAll("_", " ");
}

function isTrial(planKey: string): boolean {
	return planKey === "freemium" || planKey === "trial";
}

function locale(): string {
	return presentationLocale() === "da" ? "da-DK" : "en-GB";
}

/** "185 kr" or "1.592 kr" as the interface language writes it. */
export function priceKr(kr: number): string {
	return `${new Intl.NumberFormat(locale()).format(kr)} kr`;
}

/** "20 h" / "20 t"; fractions of an hour round to one decimal. */
function hoursText(hours: number): string {
	return t("{hours} h", { hours: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(hours) });
}

/** A billing date in the interface language. Billing dates are calendar
 * days, so they are read in UTC: a period ending at midnight UTC on the 1st
 * must not show as the 30th west of Greenwich. An unreadable value is shown
 * as sent. */
function dateText(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? iso
		: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/** Ids must stay unique while the account page and the dialog both show a plan panel. */
let renders = 0;

/** The company's computer hours this month, as measured (nothing is charged yet). */
export interface CompanyHoursState {
	value?: CompanyComputerHours;
	loading: boolean;
	/** The cloud does not measure computer hours yet. */
	missing?: boolean;
	/** The lookup failed; the card says so instead of showing the raw error. */
	failed?: boolean;
}

/** Storage and computer hours of the company Settings show, as the Company tab loads them. */
export interface PlanUsage {
	companyName: string;
	file?: HostedCompanyFile;
	loading: boolean;
	error?: string;
	retry: () => void;
	hours?: CompanyHoursState;
	/** The company, for buying hours for it. */
	profileId?: string;
	/** Founders pay the company's hours; undefined while the member's role is unknown. */
	founder?: boolean;
}

/** Payments on Plan & usage: what can be bought, the member's plan, and the two Stripe pages. */
export interface PlanPaymentsView {
	readonly state: PlanPaymentsState;
	checkout(itemKey: string, profileId?: string): void;
	portal(): void;
	/** A company's name for "hours used per company"; undefined for one this page does not know. */
	companyName?(profileId: string): string | undefined;
}

const HOURS_BY_KIND = [
	["companyMachines", phrase("Company machines")],
	["runs", phrase("Agent runs")],
	["codingMachines", phrase("Coding machines")],
	["agentMachines", phrase("Agents' machines")],
] as const;

/** "20 h · 70 kr" for a pack of hours (prices in øre, ex. VAT). */
function packText(offer: ComputerHourOffer): string {
	return `${hoursText(offer.hours)} · ${priceKr(offer.priceMinor / 100)}`;
}

/** The company's hours card: this month's use, what it was used on, and (for
 * founders, once payments are open) packs of hours to buy for the company. */
function companyHoursCard(
	usage: PlanUsage,
	payments: PlanPaymentsView | undefined,
	packsOpen: boolean,
): HTMLElement | null {
	const state = usage.hours;
	if (!state) return null;
	const value = state.value;
	const used = value
		? uiText("{used} used", { used: hoursText(value.usedSeconds / 3600) })
		: state.loading
			? uiText("Loading…")
			: state.failed
				? uiText("Computer hours unavailable")
				: uiText("Not measured yet");
	// A kind under three minutes would read "0 h": left out, like a kind with none.
	const kinds = value
		? HOURS_BY_KIND.filter(([key]) => value.byKind[key] >= 180).map(
				([key, label]) => `${t(label)} ${hoursText(value.byKind[key] / 3600)}`,
			)
		: [];
	const packs =
		usage.founder && usage.profileId
			? (payments?.state.offers ?? []).filter((offer) => offer.kind === "credits" && offer.available)
			: [];
	const opening = payments?.state.opening;
	renders += 1;
	const packList = packs.length
		? h(
				"div",
				{ class: "settings-hours-packs", id: `settings-hours-packs-${renders}`, hidden: !packsOpen },
				...packs.map((offer) => {
					const pack = button(
						opening === offer.itemKey ? uiText("Opening…") : packText(offer),
						() => payments?.checkout(offer.itemKey, usage.profileId),
						{ small: true, disabled: opening !== undefined },
					);
					pack.dataset.focus = `pack-${offer.itemKey}`;
					return pack;
				}),
				h(
					"small",
					null,
					uiText("For {company}, valid for 12 months. Prices are ex. VAT.", { company: usage.companyName }),
				),
			)
		: null;
	const buy = packList
		? button(
				uiText("Buy hours"),
				() => {
					packList.hidden = !packList.hidden;
					buy?.setAttribute("aria-expanded", String(!packList.hidden));
				},
				{ small: true },
			)
		: null;
	if (buy && packList) {
		buy.setAttribute("aria-expanded", String(packsOpen));
		buy.setAttribute("aria-controls", packList.id);
		buy.dataset.focus = "buy-hours";
	}
	return h(
		"div",
		{ class: "settings-card settings-usage settings-company-hours" },
		h(
			"div",
			{ class: "settings-copy" },
			h("small", { class: "settings-eyebrow" }, uiText("Computer hours this month")),
			h("strong", null, used),
			h("small", null, usage.companyName, " · ", uiText("Measured, not charged yet")),
			kinds.length ? h("small", { class: "settings-hours-kinds" }, kinds.join(" · ")) : null,
			usage.founder === false
				? h("small", null, uiText("Computer hours are paid by the founders. You are never charged."))
				: null,
			packList,
		),
		buy,
	);
}

/** Account-wide figures the cloud does not report yet. Every field is optional:
 * the tab shows a placeholder for whatever is missing, and fills in as the
 * billing work lands. */
export interface PlanBilling {
	computerHours?: { used: number; included?: number; periodEnd?: string };
	nextPaymentAt?: string;
	paymentMethod?: string;
	invoices?: { id: string; issuedAt: string; totalKr: number; href?: string }[];
	payments?: PlanPaymentsView;
}

type PaidPlan = NonNullable<NonNullable<PlanPaymentsState["plan"]>["plan"]>;

/** The line under a paid plan's name: when it renews or ends, or what is wrong with its payment. */
function paidPlanDetail(plan: PaidPlan): Node {
	if (plan.status === "past_due" || plan.status === "unpaid")
		return uiText("Payment failed. Update your card under Payments and invoices.");
	if (plan.status === "incomplete") return uiText("Waiting for the first payment");
	if (!plan.periodEnd) return uiText("Paid through Stripe");
	return plan.cancelAtPeriodEnd
		? uiText("Ends {date}", { date: dateText(plan.periodEnd) })
		: uiText("Renews {date}", { date: dateText(plan.periodEnd) });
}

function billingRow(label: Node, value: Node | string, action?: Node | null): HTMLElement {
	return h(
		"div",
		{ class: "billing-row" },
		h("span", { class: "billing-label" }, label),
		h("span", { class: "billing-value" }, value),
		action ?? null,
	);
}

/** "Company A 10 h · Other companies 0.5 h": this period's hours by company, largest first;
 * companies this page cannot name are summed, and left out under three minutes. */
function hoursPerCompany(
	companies: { profileId: string; seconds: number }[],
	companyName: ((profileId: string) => string | undefined) | undefined,
): string {
	let others = 0;
	const named: string[] = [];
	for (const item of companies) {
		const company = companyName?.(item.profileId);
		if (company) named.push(`${company} ${hoursText(item.seconds / 3600)}`);
		else others += item.seconds;
	}
	if (others >= 180) named.push(`${t("Other companies")} ${hoursText(others / 3600)}`);
	return named.join(" · ");
}

/** The account's plan and what it is using. Nothing here is per browser: the
 * plan comes from the account, the storage from the company Settings show. */
export function renderPlan(
	container: HTMLElement,
	account: AccountViewState,
	usage: PlanUsage | undefined,
	billing: PlanBilling = {},
	options: { showError?: boolean } = {},
): void {
	const entitlement = account.entitlement;
	const payments = billing.payments;
	const opening = payments?.state.opening;
	// A plan paid through Stripe; otherwise the account's entitlement, as before payments.
	const paid = payments?.state.plan?.plan ?? undefined;
	const planKey = paid?.itemKey ?? entitlement?.planKey;
	const offer = PLAN_OFFERS.find((item) => item.key === planKey);
	const trial = !paid && planKey !== undefined && isTrial(planKey);
	const forSale = (key: string) =>
		payments?.state.offers.find((item) => item.itemKey === key && item.kind === "plan" && item.available);
	const selling = PLAN_OFFERS.some((item) => forSale(item.key));
	// A plan key this client does not know is shown as sent, untranslated.
	const name =
		planKey !== undefined
			? Object.hasOwn(PLAN_NAMES, planKey)
				? uiText(planName(planKey))
				: planName(planKey)
			: account.loaded
				? uiText("Plan unavailable")
				: uiText("Loading…");
	const detail = paid
		? paidPlanDetail(paid)
		: entitlement
			? entitlement.storageAllocationBytes !== undefined
				? uiText("{size} company storage included", { size: fmtBytes(entitlement.storageAllocationBytes) })
				: entitlement.planKey === "internal"
					? uiText("No active subscription")
					: uiText("Storage allocation unavailable")
			: null;
	// The plan grid stays open across re-renders (storage arriving, a retry),
	// and the control that had focus keeps it.
	const plansOpen = container.querySelector<HTMLElement>(".settings-plan-grid")?.hidden === false;
	const packsOpen = container.querySelector<HTMLElement>(".settings-hours-packs")?.hidden === false;
	const focused = container.contains(document.activeElement)
		? (document.activeElement as HTMLElement).dataset.focus
		: undefined;
	// A plan for sale starts Stripe's checkout; a member who pays already switches on
	// Stripe's billing page. Anything not for sale says "Coming soon".
	const planButton = (item: PlanOffer): HTMLButtonElement => {
		if (item.key === planKey) return button(uiText("Current plan"), () => {}, { disabled: true });
		if (payments && forSale(item.key)) {
			const choose = paid
				? button(opening === "portal" ? uiText("Opening…") : uiText("Switch plan"), () => payments.portal(), {
						primary: true,
						disabled: opening !== undefined,
					})
				: button(
						opening === item.key ? uiText("Opening…") : uiText("Choose {plan}", { plan: t(item.name) }),
						() => payments.checkout(item.key),
						{ primary: true, disabled: opening !== undefined },
					);
			choose.dataset.focus = `plan-${item.key}`;
			return choose;
		}
		return button(uiText("Coming soon"), () => {}, { primary: true, disabled: true });
	};
	renders += 1;
	const grid = h(
		"div",
		{ class: "settings-plan-grid", id: `settings-plan-grid-${renders}`, hidden: !plansOpen },
		...PLAN_OFFERS.map((item) =>
			h(
				"article",
				{ class: "settings-plan-offer", "data-plan": item.key },
				h(
					"div",
					{ class: "settings-plan-offer-head" },
					h("h3", null, uiText(item.name)),
					item.key === planKey ? h("span", { class: "settings-plan-current" }, uiText("Current plan")) : null,
				),
				h("p", { class: "settings-plan-price" }, h("strong", null, priceKr(item.monthlyKr)), uiText("/month")),
				h("p", { class: "settings-plan-tagline" }, uiText(item.tagline)),
				item.includesLabel ? h("p", { class: "settings-plan-includes-label" }, uiText(item.includesLabel)) : null,
				h("ul", { class: "settings-plan-includes" }, ...item.includes.map((line) => h("li", null, uiText(line)))),
				item.usageDiscount
					? h(
							"p",
							{ class: "settings-plan-discount" },
							uiText("About {percent}% off usage", { percent: item.usageDiscount }),
						)
					: null,
				planButton(item),
			),
		),
	);
	const help = h(
		"p",
		{ class: "settings-help", hidden: !plansOpen },
		...(selling
			? [
					uiText("Prices are ex. VAT. You pay on Stripe's secure page."),
					payments?.state.plan?.mode === "dry_run" ? [" ", uiText("Test mode: nothing is charged.")] : [],
				]
			: [
					uiText("Plan changes are not open yet."),
					" ",
					uiText("Every plan starts with a free trial, no card needed. Prices are ex. VAT."),
				]),
	);
	const toggle =
		entitlement || paid
			? button(trial || planKey === "internal" ? uiText("Upgrade") : uiText("Change plan"), () => {
					grid.hidden = !grid.hidden;
					help.hidden = grid.hidden;
					toggle?.setAttribute("aria-expanded", String(!grid.hidden));
					if (!grid.hidden) grid.querySelector<HTMLElement>("article")?.scrollIntoView?.({ block: "nearest" });
				})
			: null;
	if (toggle) {
		toggle.setAttribute("aria-expanded", String(plansOpen));
		toggle.setAttribute("aria-controls", grid.id);
		toggle.dataset.focus = "plans";
	}
	// A paid plan's hours, once members see them (live payments); before that, as before payments.
	const mine = paid ? payments?.state.plan?.hours : undefined;
	const hours = mine
		? {
				used: mine.companies.reduce((sum, item) => sum + item.seconds, 0) / 3600,
				included: mine.grantedSeconds / 3600 || undefined,
				periodEnd: paid?.periodEnd,
			}
		: billing.computerHours;
	const perCompany = mine ? hoursPerCompany(mine.companies, payments?.companyName) : "";
	const hoursIncluded = hours?.included ?? offer?.includedHours;
	const hoursValue = hours
		? hoursIncluded
			? uiText("{used} used of {total}", { used: hoursText(hours.used), total: hoursText(hoursIncluded) })
			: uiText("{used} used", { used: hoursText(hours.used) })
		: uiText("Counted once plans open");
	const hoursDetail = trial
		? uiText("Included in your free trial")
		: offer && offer.includedHours === undefined
			? uiText("Your own computer, all month")
			: hoursIncluded
				? offer
					? uiText("{hours} a month with {plan}", { hours: hoursText(hoursIncluded), plan: t(offer.name) })
					: uiText("{hours} a month", { hours: hoursText(hoursIncluded) })
				: null;
	const storage = usage ? storageSummary(usage.file, usage.error) : undefined;
	const retry = usage?.error ? button(uiText("Retry"), usage.retry, { small: true, disabled: usage.loading }) : null;
	if (retry) retry.dataset.focus = "retry";
	const invoices = billing.invoices ?? [];
	// Stripe's billing page holds the card, the invoices and plan changes of a member who has paid.
	const portal =
		payments && (paid || selling)
			? button(
					opening === "portal" ? uiText("Opening…") : uiText("Payments and invoices"),
					() => payments.portal(),
					{
						small: true,
						disabled: opening !== undefined,
					},
				)
			: button(uiText("Coming soon"), () => {}, { small: true, disabled: true });
	if (payments && (paid || selling)) portal.dataset.focus = "portal";
	const nextPayment = paid
		? paid.cancelAtPeriodEnd || !paid.periodEnd || (paid.status !== "active" && paid.status !== "trialing")
			? uiText("None scheduled")
			: dateText(paid.periodEnd)
		: undefined;
	replace(
		container,
		h(
			"section",
			{ class: "page plan" },
			h("h1", null, uiText("Plan & usage")),
			account.error && options.showError !== false ? notice("danger", account.error) : null,
			payments?.state.returned
				? notice("ok", uiText("Thank you. Your hours are added as soon as Stripe confirms the payment."))
				: null,
			payments?.state.error ? notice("danger", payments.state.error) : null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Plan")),
				h(
					"div",
					{ class: "settings-card settings-plan" },
					h(
						"div",
						{ class: "settings-copy" },
						h("small", { class: "settings-eyebrow" }, uiText("Current plan")),
						h("strong", null, name),
						detail ? h("small", null, detail) : null,
					),
					toggle,
				),
				grid,
				help,
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Usage")),
				h(
					"div",
					{ class: "settings-card settings-usage settings-hours" },
					h(
						"div",
						{ class: "settings-copy" },
						h("small", { class: "settings-eyebrow" }, uiText("Computer hours in your plan")),
						h("strong", null, hoursValue),
						hoursDetail ? h("small", null, hoursDetail) : null,
						perCompany ? h("small", { class: "settings-hours-kinds" }, perCompany) : null,
						// No bar until there is a measurement: an empty bar would read as zero use.
						hours && hoursIncluded ? meter(hours.used, hoursIncluded, t("Computer hours used")) : null,
					),
					hours?.periodEnd
						? h(
								"small",
								{ class: "settings-period" },
								uiText("Resets {date}", { date: dateText(hours.periodEnd) }),
							)
						: null,
				),
				usage ? companyHoursCard(usage, payments, packsOpen) : null,
				usage && storage
					? h(
							"div",
							{ class: "settings-card settings-usage settings-storage" },
							h(
								"div",
								{ class: "settings-copy" },
								h("small", { class: "settings-eyebrow" }, uiText("Company storage")),
								h("strong", null, storage.text),
								h("small", null, usage.companyName),
								storage.meter,
							),
							retry,
						)
					: h("p", { class: "settings-help" }, uiText("Open a company to see its storage.")),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Billing")),
				h(
					"div",
					{ class: "settings-card settings-billing" },
					billingRow(
						uiText("Price"),
						paid || entitlement
							? trial || planKey === "internal"
								? uiText("Free")
								: offer
									? h("span", null, priceKr(offer.monthlyKr), uiText("/month"), " · ", uiText("ex. VAT"))
									: uiText("Not available yet")
							: "",
					),
					billingRow(
						uiText("Next payment"),
						nextPayment
							? nextPayment
							: billing.nextPaymentAt
								? dateText(billing.nextPaymentAt)
								: trial
									? uiText("None during your free trial")
									: uiText("Not scheduled yet"),
					),
					billingRow(
						uiText("Payment method"),
						paid ? uiText("On Stripe's billing page") : (billing.paymentMethod ?? uiText("No card on file")),
						portal,
					),
					billingRow(
						uiText("Invoices"),
						invoices.length
							? h(
									"ul",
									{ class: "settings-invoices" },
									...invoices.map((invoice) =>
										h(
											"li",
											null,
											invoice.href
												? h("a", { href: invoice.href }, dateText(invoice.issuedAt))
												: dateText(invoice.issuedAt),
											` · ${priceKr(invoice.totalKr)}`,
										),
									),
								)
							: paid
								? uiText("On Stripe's billing page")
								: uiText("No invoices yet"),
					),
				),
			),
		),
	);
	if (focused) container.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
}
