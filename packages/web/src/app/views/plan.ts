import type { ComputerPlan, ComputerPlanCatalog, ComputerUsage } from "../../cloud/computer-billing.ts";
import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { presentationLocale, t, uiText } from "../../ui/preferences.ts";
import type { AccountViewState } from "./account.ts";
import { meter, storageSummary } from "./storage-summary.ts";

export interface PlanUsage {
	companyName: string;
	file?: HostedCompanyFile;
	loading: boolean;
	error?: string;
	retry: () => void;
}
export interface PlanBilling {
	catalog?: ComputerPlanCatalog;
	usage?: ComputerUsage;
	loading?: boolean;
	busy?: boolean;
	error?: string;
	refresh?: () => void;
	checkout?: (offer: ComputerPlan) => void;
	portal?: () => void;
}
function locale(): string {
	return presentationLocale() === "da" ? "da-DK" : "en-GB";
}
function hours(value: string): string {
	return new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(Number(value) / 3_600_000_000);
}
let renders = 0;

/** Computer plans come from the paid catalog, never the legacy storage
 * entitlement. Company storage remains attached to the selected company. */
export function renderPlan(
	container: HTMLElement,
	_account: AccountViewState,
	company: PlanUsage | undefined,
	billing: PlanBilling = {},
	_options: { showError?: boolean } = {},
): void {
	const open = container.querySelector<HTMLElement>(".settings-plan-grid")?.hidden === false;
	const focused = container.contains(document.activeElement)
		? (document.activeElement as HTMLElement).dataset.focus
		: undefined;
	const usage = billing.usage;
	const plans = billing.catalog?.plans ?? [];
	const current = usage?.subscriptions.filter(
		(subscription) => !["canceled", "incomplete_expired"].includes(subscription.status),
	);
	const refresh = billing.refresh
		? button(uiText("Refresh plan status"), billing.refresh, { disabled: billing.loading || billing.busy })
		: null;
	if (refresh) refresh.dataset.focus = "refresh-plan";
	const grid = h(
		"div",
		{ class: "settings-plan-grid", id: `settings-plan-grid-${++renders}`, hidden: !open },
		...plans.map((offer) => {
			const subscribed = current?.some(
				(subscription) => subscription.planKey === offer.planKey && subscription.planVersion === offer.version,
			);
			const choose = button(
				subscribed
					? uiText("Current plan")
					: offer.activeForCheckout && usage?.checkoutAvailable
						? uiText("Choose plan")
						: uiText("Checkout unavailable"),
				() => billing.checkout?.(offer),
				{
					primary: !subscribed,
					disabled:
						subscribed ||
						Boolean(current?.length) ||
						!offer.activeForCheckout ||
						!usage?.checkoutAvailable ||
						billing.loading ||
						billing.busy ||
						!billing.checkout,
				},
			);
			choose.dataset.focus = `plan-${offer.planKey}-${offer.version}`;
			return h(
				"article",
				{ class: "settings-plan-offer", "data-plan": offer.planKey },
				h("h3", null, offer.name),
				h(
					"p",
					{ class: "settings-plan-price" },
					h(
						"strong",
						null,
						new Intl.NumberFormat(locale(), { style: "currency", currency: offer.currency }).format(
							offer.monthlyPriceMinor / 100,
						),
					),
					uiText("/month"),
				),
				h(
					"p",
					{ class: "settings-plan-tagline" },
					offer.advertisedHours !== null
						? uiText("{hours} standard computer hours per month", { hours: offer.advertisedHours })
						: uiText("One standard computer throughout your billing period"),
				),
				choose,
			);
		}),
	);
	const toggle = button(
		uiText("View computer plans"),
		() => {
			grid.hidden = !grid.hidden;
			toggle.setAttribute("aria-expanded", String(!grid.hidden));
		},
		{ disabled: !billing.catalog },
	);
	toggle.dataset.focus = "plans";
	toggle.setAttribute("aria-controls", grid.id);
	toggle.setAttribute("aria-expanded", String(open));
	const storage = company ? storageSummary(company.file, company.error) : undefined;
	const balance = usage?.balance;
	const standard = usage?.standardComputer;
	replace(
		container,
		h(
			"section",
			{ class: "page plan" },
			h("h1", null, uiText("Plan & usage")),
			billing.error ? notice("danger", billing.error) : null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Computer plan")),
				h(
					"div",
					{ class: "settings-card settings-plan" },
					h(
						"div",
						{ class: "settings-copy" },
						h("small", { class: "settings-eyebrow" }, uiText("Current plan")),
						h(
							"strong",
							null,
							usage
								? current?.length
									? current
											.map(
												(subscription) =>
													plans.find(
														(offer) =>
															offer.planKey === subscription.planKey &&
															offer.version === subscription.planVersion,
													)?.name ?? subscription.planKey,
											)
											.join(", ")
									: uiText("No active computer subscription")
								: billing.loading
									? uiText("Loading…")
									: uiText("Plan unavailable"),
						),
						...(current ?? []).map((subscription) =>
							h(
								"small",
								null,
								uiText("Subscription status: {status}. Period ends {date}.", {
									status: subscription.status,
									date: new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" }).format(
										new Date(subscription.periodEnd),
									),
								}),
							),
						),
					),
					toggle,
				),
				grid,
				h(
					"p",
					{ class: "settings-help" },
					uiText(
						"Computer plans pay for Qorpera computers. Your ChatGPT and Claude model accounts stay separate.",
					),
				),
				standard
					? h(
							"p",
							{ class: "settings-help" },
							uiText(
								"A standard computer has {cpu} vCPU and {memory} GiB RAM. Larger computers use hours in proportion to their reserved resources.",
								{ cpu: standard.cpuMillis / 1000, memory: standard.memoryBytes / 1024 ** 3 },
							),
						)
					: null,
				usage && !usage.checkoutAvailable
					? h("p", { class: "settings-help" }, uiText("Computer subscription checkout is not available yet."))
					: null,
				refresh,
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
						h("small", { class: "settings-eyebrow" }, uiText("Paid computer allowance")),
						h(
							"strong",
							null,
							balance
								? uiText("{hours} standard hours available", { hours: hours(balance.availableUs) })
								: uiText("Usage unavailable"),
						),
						balance
							? h(
									"small",
									null,
									uiText("{used} used · {reserved} reserved · {issued} issued this period", {
										used: hours(balance.debitedUs),
										reserved: hours(balance.reservedUs),
										issued: hours(balance.issuedUs),
									}),
								)
							: null,
						balance && usage?.runtimeAccountingReady && Number(balance.issuedUs) > 0
							? meter(Number(balance.debitedUs), Number(balance.issuedUs), t("Computer hours used"))
							: null,
						usage && !usage.runtimeAccountingReady
							? h("small", null, uiText("Usage accounting is not active yet."))
							: null,
						h("small", null, uiText("Your allowance is shared across the company pools you choose to join.")),
					),
				),
				company && storage
					? h(
							"div",
							{ class: "settings-card settings-usage" },
							h(
								"div",
								{ class: "settings-copy" },
								h("small", { class: "settings-eyebrow" }, uiText("Company storage")),
								h("strong", null, storage.text),
								h("small", null, company.companyName),
								storage.meter,
							),
							company.error
								? button(uiText("Retry"), company.retry, { small: true, disabled: company.loading })
								: null,
						)
					: h("p", { class: "settings-help" }, uiText("Choose a company to see its storage.")),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Payments")),
				h(
					"div",
					{ class: "settings-card settings-billing" },
					h("p", null, uiText("Manage payment details and invoices securely with Stripe.")),
					button(uiText("Manage payments"), () => billing.portal?.(), {
						disabled: !usage?.portalAvailable || !billing.portal || billing.loading || billing.busy,
					}),
				),
			),
		),
	);
	if (focused)
		[...container.querySelectorAll<HTMLElement>("[data-focus]")]
			.find((element) => element.dataset.focus === focused)
			?.focus({ preventScroll: true });
}
