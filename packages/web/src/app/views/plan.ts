import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, uiText } from "../../ui/preferences.ts";
import type { AccountViewState } from "./account.ts";

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
	storageBytes: number;
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
		storageBytes: 100_000_000_000,
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
		storageBytes: 250_000_000_000,
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
		storageBytes: 500_000_000_000,
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

/** "185 kr" or "1.592 kr" as the interface language writes it. */
export function priceKr(kr: number): string {
	return `${new Intl.NumberFormat(presentationLocale() === "da" ? "da-DK" : "en-GB").format(kr)} kr`;
}

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

function meter(value: number, max: number, label: string): HTMLElement {
	return h("progress", { max, value: Math.min(value, max), "aria-label": label });
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
): void {
	const entitlement = account.entitlement;
	const planKey = entitlement?.planKey;
	const offer = PLAN_OFFERS.find((item) => item.key === planKey);
	const trial = planKey !== undefined && isTrial(planKey);
	const name = entitlement ? planName(entitlement.planKey) : account.loaded ? "Plan unavailable" : "Loading…";
	const detail = entitlement
		? entitlement.storageAllocationBytes !== undefined
			? `${fmtBytes(entitlement.storageAllocationBytes)} company storage included`
			: entitlement.planKey === "internal"
				? "No active subscription"
				: "Storage allocation unavailable"
		: "";
	// The plan grid stays open across re-renders (storage arriving, a retry).
	const plansOpen = container.querySelector<HTMLElement>(".settings-plan-grid")?.hidden === false;
	const grid = h(
		"div",
		{ class: "settings-plan-grid", hidden: !plansOpen },
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
					? h("p", { class: "settings-plan-discount" }, uiText(`About ${item.usageDiscount}% off usage`))
					: null,
				// Plan changes are not open yet: the button says so instead of doing nothing.
				button(uiText(item.key === planKey ? "Current plan" : "Coming soon"), () => {}, {
					primary: item.key !== planKey,
					disabled: true,
					title: "Plan changes are not open yet.",
				}),
			),
		),
	);
	const toggle = entitlement
		? button(uiText(trial || entitlement.planKey === "internal" ? "Upgrade" : "Change plan"), () => {
				grid.hidden = !grid.hidden;
				toggle?.setAttribute("aria-expanded", String(!grid.hidden));
				if (!grid.hidden) grid.querySelector<HTMLElement>("article")?.scrollIntoView?.({ block: "nearest" });
			})
		: null;
	toggle?.setAttribute("aria-expanded", String(plansOpen));
	const file = usage?.file;
	const hours = billing.computerHours;
	const hoursIncluded = hours?.included ?? offer?.includedHours;
	const hoursValue = hours
		? `${hours.used} h used${hoursIncluded ? ` of ${hoursIncluded} h` : ""}`
		: uiText("Not measured yet");
	const hoursDetail = trial
		? uiText("Included in your free trial")
		: offer && offer.includedHours === undefined
			? uiText("Your own computer, all month")
			: hoursIncluded
				? `${hoursIncluded} h a month${offer ? ` with ${offer.name}` : ""}`
				: "";
	const invoices = billing.invoices ?? [];
	replace(
		container,
		h(
			"section",
			{ class: "page plan" },
			h("h1", null, uiText("Plan & usage")),
			account.error ? notice("danger", account.error) : null,
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
				h(
					"p",
					{ class: "settings-help", hidden: !plansOpen },
					uiText("Every plan starts with a free trial, no card needed. Prices are ex. VAT."),
				),
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
						hoursIncluded ? meter(hours?.used ?? 0, hoursIncluded, "Computer hours used") : null,
					),
					hours?.periodEnd
						? h("small", { class: "settings-period" }, `Resets ${new Date(hours.periodEnd).toLocaleDateString()}`)
						: null,
				),
				usage
					? h(
							"div",
							{ class: "settings-card settings-usage" },
							h(
								"div",
								{ class: "settings-copy" },
								h("small", { class: "settings-eyebrow" }, uiText("Company storage")),
								h(
									"strong",
									null,
									file
										? `${fmtBytes(file.storageUsedBytes)} used${file.storageLimitBytes > 0 ? ` of ${fmtBytes(file.storageLimitBytes)}` : ""}`
										: usage.error
											? "Storage information unavailable"
											: "Loading storage…",
								),
								h("small", null, usage.companyName),
								file && file.storageLimitBytes > 0
									? meter(file.storageUsedBytes, file.storageLimitBytes, "Company storage used")
									: null,
							),
							usage.error ? button("Retry", usage.retry, { small: true, disabled: usage.loading }) : null,
						)
					: h("p", { class: "settings-help" }, uiText("Choose a company to see its storage.")),
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
							? new Date(billing.nextPaymentAt).toLocaleDateString()
							: uiText(trial ? "None during your free trial" : "Not scheduled yet"),
					),
					billingRow(
						"Payment method",
						billing.paymentMethod ?? uiText("No card on file"),
						button(uiText("Add card"), () => {}, { small: true, disabled: true, title: "Coming soon" }),
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
												? h("a", { href: invoice.href }, new Date(invoice.issuedAt).toLocaleDateString())
												: new Date(invoice.issuedAt).toLocaleDateString(),
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
}
