import type { HostedOrganizationProject } from "../../cloud/organization.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, h, icon, notice, replace, spinner } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";

/** Labels for the cloud's fixed codes. English shows the code itself. */
function projectStatusLabel(status: string): string {
	if (status === "proposed") return t("proposed");
	if (status === "active") return t("active");
	if (status === "blocked") return t("blocked");
	if (status === "completed") return t("completed");
	if (status === "cancelled") return t("cancelled");
	return status;
}

function formationStateLabel(state: string): string {
	if (state === "source_inventory") return t("source inventory");
	if (state === "discovery") return t("discovery");
	if (state === "research") return t("research");
	if (state === "vision_proposal") return t("vision proposal");
	if (state === "goals_ratified") return t("goals ratified");
	if (state === "responsibility_map") return t("responsibility map");
	if (state === "operating") return t("operating");
	return state.replaceAll("_", " ");
}

function formationStatusLabel(status: string): string {
	if (status === "active") return t("active");
	if (status === "completed") return t("completed");
	if (status === "paused") return t("paused");
	return status;
}

function projectCard(company: CompanyController, project: HostedOrganizationProject): HTMLElement {
	const lead = company.staffById(project.leadStaffAgentId);
	return h(
		"a",
		{ class: "project-node", href: `#/c/${company.profile.profileId}/project/${project.projectId}` },
		h(
			"div",
			{ class: "organization-node-head" },
			h("strong", null, project.name),
			badge(projectStatusLabel(project.status), project.status === "blocked" ? "warn" : "neutral"),
		),
		project.objective ? h("p", null, project.objective) : null,
		h(
			"div",
			{ class: "organization-node-owner" },
			agentFigure(lead, lead?.displayName ?? t("Project lead"), { size: 28 }),
			h("span", null, lead?.displayName ?? t("Lead unavailable")),
			icon("chevron"),
		),
	);
}

function projectDetail(company: CompanyController, item: HostedOrganizationProject): HTMLElement {
	const base = `#/c/${company.profile.profileId}`;
	const state = company.store.get();
	const room = item.roomId
		? state.sessions.find((session) => session.status === "open" && session.executionScope?.roomId === item.roomId)
		: undefined;
	const lead = company.staffById(item.leadStaffAgentId);
	const members = item.staff.filter((member) => member.status === "active");
	return h(
		"section",
		{ class: "organization-detail" },
		h(
			"header",
			{ class: "organization-heading" },
			h("div", null, h("p", { class: "eyebrow" }, t("Project")), h("h1", null, item.name)),
			badge(projectStatusLabel(item.status), item.status === "blocked" ? "warn" : "neutral"),
		),
		item.objective ? h("p", { class: "organization-lead" }, item.objective) : null,
		h(
			"div",
			{ class: "organization-relationships" },
			h(
				"section",
				null,
				h("h2", null, t("Accountable lead")),
				lead
					? h(
							"a",
							{ class: "organization-person", href: `${base}/staff/${lead.id}` },
							agentFigure(lead, lead.displayName, { size: 48 }),
							h("span", null, h("strong", null, lead.displayName), h("small", null, lead.role)),
						)
					: h("p", null, t("Lead unavailable")),
			),
			h(
				"section",
				null,
				h("h2", null, t("Team room")),
				room
					? h("a", { class: "btn", href: `${base}/chat/${room.sessionId}` }, t("Open room"))
					: h("p", { class: "muted" }, item.roomId ? t("Room conversation unavailable.") : t("No room attached.")),
			),
		),
		h("h2", null, t("Project team")),
		h(
			"div",
			{ class: "organization-projects" },
			...members.map((member) => {
				const agent = company.staffById(member.staffAgentId);
				return agent
					? h(
							"a",
							{ class: "organization-person", href: `${base}/staff/${agent.id}` },
							agentFigure(agent, agent.displayName, { size: 48 }),
							h("span", null, h("strong", null, agent.displayName), h("small", null, member.role)),
						)
					: h("p", { class: "muted" }, t("Team member unavailable"));
			}),
			members.length ? null : h("p", { class: "empty" }, t("No team members assigned.")),
		),
		h(
			"details",
			{ class: "advanced" },
			h("summary", null, t("Source details")),
			h("p", null, t("Version {version}", { version: item.version })),
			h("code", null, item.sourcePath || t("Source path unavailable")),
		),
	);
}

/** Agents and the projects they move forward, from the canonical projection. What an agent is
 * responsible for is its own description, shown with the agent; there is no responsibility page. */
export function renderOrganization(
	company: CompanyController,
	container: HTMLElement,
	focus?: { kind: "project"; id: string },
): void {
	const state = company.store.get(),
		organization = state.organization,
		base = `#/c/${company.profile.profileId}`;
	const page = h("section", { class: "page organization" });
	if (focus)
		page.append(
			h("a", { class: "organization-back", href: `${base}/organization` }, icon("back"), t("Organization")),
		);
	if (state.organizationState === "loading") page.append(spinner(t("Loading organization")));
	else if (state.organizationState === "error")
		page.append(notice("danger", state.organizationError ?? t("The organization could not be read.")));
	else if (!organization)
		page.append(
			h("h1", null, t("Organization")),
			notice("neutral", t("The company organization is not available yet.")),
		);
	if (focus && organization) {
		const item = organization.projects.find((item) => item.projectId === focus.id);
		page.append(item ? projectDetail(company, item) : notice("neutral", t("This project is no longer available.")));
		replace(container, page);
		return;
	}
	if (organization) {
		const cofounder = company.staffById(organization.cofounder.staffAgentId);
		const projects = organization.projects.filter(
			(item) => item.status !== "completed" && item.status !== "cancelled",
		);
		page.append(
			h(
				"header",
				{ class: "organization-heading" },
				h(
					"div",
					null,
					h("h1", null, t("Organization")),
					h("p", { class: "organization-lead" }, t("Your agents and the projects they are moving forward.")),
				),
			),
			h(
				"a",
				{ class: "organization-home", href: base },
				agentFigure(cofounder, cofounder?.displayName ?? "Co-Founder", { size: 64 }),
				h(
					"span",
					null,
					h("strong", null, cofounder?.displayName ?? "Co-Founder"),
					h("small", null, t("Company direction")),
				),
				icon("chevron"),
			),
			h("h2", null, t("Active projects")),
			h(
				"div",
				{ class: "organization-projects" },
				...projects.map((item) => projectCard(company, item)),
				projects.length ? null : h("p", { class: "empty" }, t("No active projects.")),
			),
		);
		const completed = organization.projects.filter(
			(item) => item.status === "completed" || item.status === "cancelled",
		);
		if (completed.length)
			page.append(
				h(
					"details",
					{ class: "organization-history" },
					h("summary", null, t("Completed projects")),
					h("div", { class: "organization-projects" }, ...completed.map((item) => projectCard(company, item))),
				),
			);
		page.append(
			h(
				"details",
				{ class: "advanced" },
				h("summary", null, t("Formation details")),
				h(
					"p",
					null,
					t("{state} · {status} · revision {revision}", {
						state: formationStateLabel(organization.formation.state),
						status: formationStatusLabel(organization.formation.status),
						revision: organization.formation.revision,
					}),
				),
			),
		);
	}
	const staff = state.staff.filter((agent) => agent.employmentStatus === "active");
	page.append(
		h("h2", null, t("Staff")),
		h(
			"div",
			{ class: "staff-grid" },
			...staff.map((agent) =>
				h(
					"a",
					{ class: "organization-person", href: `${base}/staff/${agent.id}` },
					agentFigure(agent, agent.displayName, { size: 48 }),
					h("span", null, h("strong", null, agent.displayName), h("small", null, agent.role)),
				),
			),
			staff.length ? null : h("p", { class: "empty" }, t("No staff yet.")),
		),
	);
	const archived = state.staff.filter((agent) => agent.employmentStatus !== "active");
	if (archived.length)
		page.append(
			h(
				"details",
				{ class: "organization-history" },
				h("summary", null, t("Archived staff")),
				h("ul", null, ...archived.map((agent) => h("li", null, `${agent.displayName} · ${agent.role}`))),
			),
		);
	replace(container, page);
}
