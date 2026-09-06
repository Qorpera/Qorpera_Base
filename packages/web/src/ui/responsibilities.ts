import type { CompanyController } from "../app/company.ts";
import type { HostedOrganizationResponsibility } from "../cloud/organization.ts";
import { h } from "./dom.ts";

export function responsibilityCard(
	company: CompanyController,
	responsibility: HostedOrganizationResponsibility,
): HTMLElement {
	return h(
		"a",
		{
			class: "responsibility-node",
			href: `#/c/${company.profile.profileId}/responsibility/${responsibility.responsibilityId}`,
		},
		h("strong", null, responsibility.name),
	);
}
