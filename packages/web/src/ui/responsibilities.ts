import type { CompanyController } from "../app/company.ts";
import type { HostedOrganizationResponsibility } from "../cloud/organization.ts";
import { agentFigure } from "./avatar.ts";
import { badge, h, icon } from "./dom.ts";

export function responsibilityCard(
	company: CompanyController,
	responsibility: HostedOrganizationResponsibility,
): HTMLElement {
	const owner = company.staffById(responsibility.accountableStaffAgentId);
	return h(
		"a",
		{
			class: "responsibility-node",
			href: `#/c/${company.profile.profileId}/responsibility/${responsibility.responsibilityId}`,
		},
		h(
			"div",
			{ class: "responsibility-node-head" },
			h("strong", null, responsibility.name),
			badge(responsibility.status, responsibility.status === "degraded" ? "warn" : "neutral"),
		),
		responsibility.outcome ? h("p", null, responsibility.outcome) : null,
		h(
			"div",
			{ class: "responsibility-owner" },
			agentFigure(owner, owner?.displayName ?? "Accountable agent", { size: 28 }),
			h("span", null, owner?.displayName ?? "Agent unavailable"),
			icon("chevron"),
		),
	);
}
