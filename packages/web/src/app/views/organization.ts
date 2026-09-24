import type { HostedOrganizationProject } from "../../cloud/organization.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, h, icon, notice, replace } from "../../ui/dom.ts";
import { listSkeleton, pageSkeleton } from "../../ui/skeleton.ts";
import type { CompanyController } from "../company.ts";

function projectCard(company: CompanyController, project: HostedOrganizationProject): HTMLElement {
	const lead = company.staffById(project.leadStaffAgentId);
	return h(
		"a",
		{ class: "project-node", href: `#/c/${company.profile.profileId}/project/${project.projectId}` },
		h(
			"div",
			{ class: "organization-node-head" },
			h("strong", null, project.name),
			badge(project.status, project.status === "blocked" ? "warn" : "neutral"),
		),
		project.objective ? h("p", null, project.objective) : null,
		h(
			"div",
			{ class: "organization-node-owner" },
			agentFigure(lead, lead?.displayName ?? "Project lead", { size: 28 }),
			h("span", null, lead?.displayName ?? "Lead unavailable"),
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
			h("div", null, h("p", { class: "eyebrow" }, "Project"), h("h1", null, item.name)),
			badge(item.status, item.status === "blocked" ? "warn" : "neutral"),
		),
		item.objective ? h("p", { class: "organization-lead" }, item.objective) : null,
		h(
			"div",
			{ class: "organization-relationships" },
			h(
				"section",
				null,
				h("h2", null, "Accountable lead"),
				lead
					? h(
							"a",
							{ class: "organization-person", href: `${base}/staff/${lead.id}` },
							agentFigure(lead, lead.displayName, { size: 48 }),
							h("span", null, h("strong", null, lead.displayName), h("small", null, lead.role)),
						)
					: h("p", null, "Lead unavailable"),
			),
			h(
				"section",
				null,
				h("h2", null, "Team room"),
				room
					? h("a", { class: "btn", href: `${base}/chat/${room.sessionId}` }, "Open room")
					: h("p", { class: "muted" }, item.roomId ? "Room conversation unavailable." : "No room attached."),
			),
		),
		h("h2", null, "Project team"),
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
					: h("p", { class: "muted" }, "Team member unavailable");
			}),
			members.length ? null : h("p", { class: "empty" }, "No team members assigned."),
		),
		h(
			"details",
			{ class: "advanced" },
			h("summary", null, "Source details"),
			h("p", null, `Version ${item.version}`),
			h("code", null, item.sourcePath || "Source path unavailable"),
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
		page.append(h("a", { class: "organization-back", href: `${base}/organization` }, icon("back"), "Organization"));
	if (state.organizationState === "loading") {
		// The placeholder stands in for the whole page, staff included.
		page.append(pageSkeleton("Loading organization"));
		replace(container, page);
		return;
	}
	if (state.organizationState === "error")
		page.append(notice("danger", state.organizationError ?? "The organization could not be read."));
	else if (!organization)
		page.append(h("h1", null, "Organization"), notice("neutral", "The company organization is not available yet."));
	if (focus && organization) {
		const item = organization.projects.find((item) => item.projectId === focus.id);
		page.append(item ? projectDetail(company, item) : notice("neutral", "This project is no longer available."));
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
					h("h1", null, "Organization"),
					h("p", { class: "organization-lead" }, "Your agents and the projects they are moving forward."),
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
					h("small", null, "Company direction"),
				),
				icon("chevron"),
			),
			h("h2", null, "Active projects"),
			h(
				"div",
				{ class: "organization-projects" },
				...projects.map((item) => projectCard(company, item)),
				projects.length ? null : h("p", { class: "empty" }, "No active projects."),
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
					h("summary", null, "Completed projects"),
					h("div", { class: "organization-projects" }, ...completed.map((item) => projectCard(company, item))),
				),
			);
		page.append(
			h(
				"details",
				{ class: "advanced" },
				h("summary", null, "Formation details"),
				h(
					"p",
					null,
					organization.formation.state.replaceAll("_", " ") +
						" · " +
						organization.formation.status +
						" · revision " +
						organization.formation.revision,
				),
			),
		);
	}
	const staff = state.staff.filter((agent) => agent.employmentStatus === "active");
	page.append(
		h("h2", null, "Staff"),
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
			staff.length
				? null
				: state.loading
					? listSkeleton("Loading staff")
					: h("p", { class: "empty" }, "No staff yet."),
		),
	);
	const archived = state.staff.filter((agent) => agent.employmentStatus !== "active");
	if (archived.length)
		page.append(
			h(
				"details",
				{ class: "organization-history" },
				h("summary", null, "Archived staff"),
				h("ul", null, ...archived.map((agent) => h("li", null, `${agent.displayName} · ${agent.role}`))),
			),
		);
	replace(container, page);
}
