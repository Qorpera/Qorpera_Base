import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, uiText } from "../../ui/preferences.ts";
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
		name: "Basis",
		monthlyKr: 185,
		tagline: "For the daily work.",
		includes: [
			"100 GB storage included",
			"A worker computer for every agent, 74 hours",
			"Connect from computer and phone",
			"Work in the cloud while your computer is off",
		],
		includedHours: 74,
	},
	{
		key: "standard",
		name: "Standard",
		monthlyKr: 630,
		usageDiscount: 37,
		tagline: "More storage and extra computer use.",
		includesLabel: "Everything in Basis, plus",
		includes: ["250 GB storage included", "More than 3.5× extra computer use", "Priority access at peak hours"],
		includedHours: 286,
	},
	{
		key: "dedicated",
		name: "Dedicated computer",
		monthlyKr: 1592,
		usageDiscount: 43,
		tagline: "Your own computer all month.",
		includesLabel: "Everything in Standard, plus",
		includes: ["500 GB storage included", "A dedicated computer all month", "Early access to new features"],
	},
];

const PLAN_NAMES: Record<string, string> = {
	internal: "Complimentary",
	freemium: "Free trial",
	trial: "Free trial",
	basis: "Basis",
	standard: "Standard",
	dedicated: "Dedicated computer",
	pro: "Pro",
	team: "Team",
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
function hoursText(hours: number): HTMLElement {
	return h(
		"span",
		null,
		`${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(hours)} `,
		uiText("h"),
	);
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

/** Storage of the company chosen in the settings menu, as the Company tab loads it. */
export interface PlanUsage {
	companyName: string;
	file?: HostedCompanyFile;
	loading: boolean;
	error?: string;
	retry: () => void;
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

function billingRow(label: string, value: Node | string, action?: Node | null): HTMLElement {
	return h(
		"div",
		{ class: "billing-row" },
		h("span", { class: "billing-label" }, uiText(label)),
		h("span", { class: "billing-value" }, value),
		action ?? null,
	);
}

/** The account's plan and what it is using. Nothing here is per browser: the
 * plan comes from the account, the storage from the chosen company. */
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
	const name = uiText(entitlement ? planName(entitlement.planKey) : account.loaded ? "Plan unavailable" : "Loading…");
	const detail = entitlement
		? entitlement.storageAllocationBytes !== undefined
			? h("span", null, `${fmtBytes(entitlement.storageAllocationBytes)} `, uiText("company storage included"))
			: uiText(entitlement.planKey === "internal" ? "No active subscription" : "Storage allocation unavailable")
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
							uiText("About"),
							` ${item.usageDiscount}% `,
							uiText("off usage"),
						)
					: null,
				// Plan changes are not open yet: the button says so, the help line explains.
				button(uiText(item.key === planKey ? "Current plan" : "Coming soon"), () => {}, {
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
		? button(uiText(trial || entitlement.planKey === "internal" ? "Upgrade" : "Change plan"), () => {
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
		? h(
				"span",
				null,
				hoursText(hours.used),
				" ",
				uiText("used"),
				hoursIncluded ? [" ", uiText("of"), " ", hoursText(hoursIncluded)] : null,
			)
		: uiText("Not measured yet");
	const hoursDetail = trial
		? uiText("Included in your free trial")
		: offer && offer.includedHours === undefined
			? uiText("Your own computer, all month")
			: hoursIncluded
				? h(
						"span",
						null,
						hoursText(hoursIncluded),
						" ",
						uiText("a month"),
						offer ? [" ", uiText("with"), ` ${offer.name}`] : null,
					)
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
						h("small", { class: "settings-eyebrow" }, uiText("Computer hours")),
						h("strong", null, hoursValue),
						hoursDetail ? h("small", null, hoursDetail) : null,
						// No bar until there is a measurement: an empty bar would read as zero use.
						hours && hoursIncluded ? meter(hours.used, hoursIncluded, "Computer hours used") : null,
					),
					hours?.periodEnd
						? h("small", { class: "settings-period" }, uiText("Resets"), ` ${dateText(hours.periodEnd)}`)
						: null,
				),
				usage && storage
					? h(
							"div",
							{ class: "settings-card settings-usage" },
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
						"Price",
						entitlement
							? trial || entitlement.planKey === "internal"
								? uiText("Free")
								: offer
									? h("span", null, priceKr(offer.monthlyKr), uiText("/month"), " · ", uiText("ex. VAT"))
									: uiText("Not available yet")
							: "",
					),
					billingRow(
						"Next payment",
						billing.nextPaymentAt
							? dateText(billing.nextPaymentAt)
							: uiText(trial ? "None during your free trial" : "Not scheduled yet"),
					),
					billingRow(
						"Payment method",
						billing.paymentMethod ?? uiText("No card on file"),
						button(uiText("Coming soon"), () => {}, { small: true, disabled: true }),
					),
					billingRow(
						"Invoices",
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
