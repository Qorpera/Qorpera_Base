import type { HostedCompanyFile } from "../../cloud/types.ts";
import { button, fmtBytes, h, notice, replace } from "../../ui/dom.ts";
import { uiText } from "../../ui/preferences.ts";
import type { AccountViewState } from "./account.ts";

/** Storage of the company chosen in the settings menu, as the Company tab loads it. */
export interface PlanUsage {
	companyName: string;
	file?: HostedCompanyFile;
	loading: boolean;
	error?: string;
	retry: () => void;
}

/** The account's plan and what it is using. Nothing here is per browser: the
 * plan comes from the account, the storage from the chosen company. */
export function renderPlan(container: HTMLElement, account: AccountViewState, usage: PlanUsage | undefined): void {
	const entitlement = account.entitlement;
	const planName = entitlement
		? ({ internal: "Complimentary", freemium: "Freemium", pro: "Pro", team: "Team" }[entitlement.planKey] ??
			entitlement.planKey.replaceAll("_", " "))
		: account.loaded
			? "Plan unavailable"
			: "Loading…";
	const planDetail = entitlement
		? entitlement.storageAllocationBytes !== undefined
			? `${fmtBytes(entitlement.storageAllocationBytes)} company storage included`
			: entitlement.planKey === "internal"
				? "No active subscription"
				: "Storage allocation unavailable"
		: "";
	const file = usage?.file;
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
						h("strong", null, planName),
						planDetail ? h("small", null, planDetail) : null,
					),
				),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, uiText("Usage")),
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
									? h("progress", {
											max: file.storageLimitBytes,
											value: Math.min(file.storageUsedBytes, file.storageLimitBytes),
											"aria-label": "Company storage used",
										})
									: null,
							),
							usage.error ? button("Retry", usage.retry, { small: true, disabled: usage.loading }) : null,
						)
					: h("p", { class: "settings-help" }, uiText("Choose a company to see its storage.")),
			),
		),
	);
}
