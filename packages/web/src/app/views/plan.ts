import type { CompanyComputerHours } from "../../cloud/computer-hours.ts";
import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { phrase, presentationLocale, t, uiText } from "../../ui/preferences.ts";
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
	error?: string;
}

/** Storage and computer hours of the company Settings show, as the Company tab loads them. */
export interface PlanUsage {
	companyName: string;
	file?: HostedCompanyFile;
	loading: boolean;
	error?: string;
	retry: () => void;
	hours?: CompanyHoursState;
}

const HOURS_BY_KIND = [
	["companyMachines", phrase("Company machines")],
	["runs", phrase("Agent runs")],
	["codingMachines", phrase("Coding machines")],
	["agentMachines", phrase("Agents' machines")],
] as const;

/** The company's hours card: this month's use, and what it was used on. */
function companyHoursCard(companyName: string, state: CompanyHoursState | undefined): HTMLElement | null {
	if (!state) return null;
	const value = state.value;
	const used = value
		? uiText("{used} used", { used: hoursText(value.usedSeconds / 3600) })
		: state.loading
			? uiText("Loading…")
			: state.missing
				? uiText("Not measured yet")
				: (state.error ?? uiText("Not measured yet"));
	const kinds = value
		? HOURS_BY_KIND.filter(([key]) => value.byKind[key] > 0).map(
				([key, label]) => `${t(label)} ${hoursText(value.byKind[key] / 3600)}`,
			)
		: [];
	return h(
		"div",
		{ class: "settings-card settings-usage settings-company-hours" },
		h(
			"div",
			{ class: "settings-copy" },
			h("small", { class: "settings-eyebrow" }, uiText("Computer hours this month")),
			h("strong", null, used),
			h("small", null, companyName, " · ", uiText("Measured, not charged yet")),
			kinds.length ? h("small", { class: "settings-hours-kinds" }, kinds.join(" · ")) : null,
		),
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
	const planKey = entitlement?.planKey;
	const offer = PLAN_OFFERS.find((item) => item.key === planKey);
	const trial = planKey !== undefined && isTrial(planKey);
	// A plan key this client does not know is shown as sent, untranslated.
	const name = entitlement
		? Object.hasOwn(PLAN_NAMES, entitlement.planKey)
			? uiText(planName(entitlement.planKey))
			: planName(entitlement.planKey)
		: account.loaded
			? uiText("Plan unavailable")
			: uiText("Loading…");
	const detail = entitlement
		? entitlement.storageAllocationBytes !== undefined
			? uiText("{size} company storage included", { size: fmtBytes(entitlement.storageAllocationBytes) })
			: entitlement.planKey === "internal"
				? uiText("No active subscription")
				: uiText("Storage allocation unavailable")
		: null;
	// The plan grid stays open across re-renders (storage arriving, a retry),
	// and the control that had focus keeps it.
	const plansOpen = container.querySelector<HTMLElement>(".settings-plan-grid")?.hidden === false;
	const focused = container.contains(document.activeElement)
		? (document.activeElement as HTMLElement).dataset.focus
		: undefined;
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
				// Plan changes are not open yet: the button says so, the help line explains.
				button(item.key === planKey ? uiText("Current plan") : uiText("Coming soon"), () => {}, {
					primary: item.key !== planKey,
					disabled: true,
				}),
			),
		),
	);
	const help = h(
		"p",
		{ class: "settings-help", hidden: !plansOpen },
		uiText("Plan changes are not open yet."),
		" ",
		uiText("Every plan starts with a free trial, no card needed. Prices are ex. VAT."),
	);
	const toggle = entitlement
		? button(trial || entitlement.planKey === "internal" ? uiText("Upgrade") : uiText("Change plan"), () => {
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
	const hours = billing.computerHours;
	const hoursIncluded = hours?.included ?? offer?.includedHours;
	const hoursValue = hours
		? hoursIncluded
			? uiText("{used} used of {total}", { used: hoursText(hours.used), total: hoursText(hoursIncluded) })
			: uiText("{used} used", { used: hoursText(hours.used) })
		: uiText("Not measured yet");
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
	replace(
		container,
		h(
			"section",
			{ class: "page plan" },
			h("h1", null, uiText("Plan & usage")),
			account.error && options.showError !== false ? notice("danger", account.error) : null,
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
				usage ? companyHoursCard(usage.companyName, usage.hours) : null,
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
						entitlement
							? trial || entitlement.planKey === "internal"
								? uiText("Free")
								: offer
									? h("span", null, priceKr(offer.monthlyKr), uiText("/month"), " · ", uiText("ex. VAT"))
									: uiText("Not available yet")
							: "",
					),
					billingRow(
						uiText("Next payment"),
						billing.nextPaymentAt
							? dateText(billing.nextPaymentAt)
							: trial
								? uiText("None during your free trial")
								: uiText("Not scheduled yet"),
					),
					billingRow(
						uiText("Payment method"),
						billing.paymentMethod ?? uiText("No card on file"),
						button(uiText("Coming soon"), () => {}, { small: true, disabled: true }),
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
							: uiText("No invoices yet"),
					),
				),
			),
		),
	);
	if (focused) container.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
}
