import type { HostedOrganizationProject, HostedOrganizationResponsibility } from "../../cloud/organization.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, h, icon, notice, replace, spinner } from "../../ui/dom.ts";
import { responsibilityCard } from "../../ui/responsibilities.ts";
import type { CompanyController } from "../company.ts";

function projectCard(company: CompanyController, project: HostedOrganizationProject): HTMLElement {
	const lead = company.staffById(project.leadStaffAgentId);
	return h(
		"a",
		{ class: "project-node", href: `#/c/${company.profile.profileId}/project/${project.projectId}` },
		h(
			"div",
			{ class: "responsibility-node-head" },
			h("strong", null, project.name),
			badge(project.status, project.status === "blocked" ? "warn" : "neutral"),
		),
		project.objective ? h("p", null, project.objective) : null,
		h(
			"div",
			{ class: "responsibility-owner" },
			agentFigure(lead, lead?.displayName ?? "Project lead", { size: 28 }),
			h("span", null, lead?.displayName ?? "Lead unavailable"),
			icon("chevron"),
		),
	);
}

function responsibilityDetail(company: CompanyController, item: HostedOrganizationResponsibility): HTMLElement {
	const owner = company.staffById(item.accountableStaffAgentId);
	const projects =
		company.store
			.get()
			.organization?.projects.filter((project) => project.sponsoringResponsibilityId === item.responsibilityId) ??
		[];
	const base = `#/c/${company.profile.profileId}`;
	return h(
		"section",
		{ class: "organization-detail" },
		h(
			"header",
			{ class: "organization-heading" },
			h("div", null, h("p", { class: "eyebrow" }, "Responsibility"), h("h1", null, item.name)),
			badge(item.status, item.status === "degraded" ? "warn" : "neutral"),
		),
		item.outcome ? h("p", { class: "organization-lead" }, item.outcome) : null,
		h(
			"div",
			{ class: "responsibility-relationships" },
			h(
				"section",
				null,
				h("h2", null, "Accountable owner"),
				owner
					? h(
							"a",
							{ class: "organization-person", href: `${base}/staff/${owner.id}` },
							agentFigure(owner, owner.displayName, { size: 48 }),
							h("span", null, h("strong", null, owner.displayName), h("small", null, owner.role)),
						)
					: h("p", { class: "muted" }, "Agent unavailable"),
			),
			h("section", null, h("h2", null, "Attention"), h("p", null, item.attentionCadence)),
			h(
				"section",
				null,
				h("h2", null, "Escalation"),
				h("p", null, item.escalationThreshold ?? "No threshold provided."),
				item.accountableUserId
					? h("p", { class: "muted" }, `To ${company.memberName(item.accountableUserId)}`)
					: null,
			),
		),
		h("h2", null, "Measures and sources"),
		h(
			"div",
			{ class: "measure-grid" },
			...item.measures.map((measure) =>
				h(
					"article",
					{ class: "measure-card" },
					h("header", null, h("h3", null, measure.label), badge(measure.status)),
					measure.definition ? h("p", null, measure.definition) : null,
					h(
						"dl",
						null,
						h("dt", null, "Target"),
						h("dd", null, measure.target ?? "Not specified"),
						h("dt", null, "Review cadence"),
						h("dd", null, measure.cadence ?? item.attentionCadence),
					),
					measure.sourcePaths.length
						? h(
								"div",
								{ class: "measure-sources" },
								h("h4", null, "Source paths"),
								...measure.sourcePaths.map((path) => h("code", null, path)),
							)
						: h("p", { class: "muted small" }, "No sources provided."),
				),
			),
			item.measures.length ? null : h("p", { class: "empty" }, "No measures provided."),
		),
		h("h2", null, "Projects"),
		h(
			"div",
			{ class: "organization-projects" },
			...projects.map((project) => projectCard(company, project)),
			projects.length ? null : h("p", { class: "empty" }, "No projects for this responsibility."),
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

function projectDetail(company: CompanyController, item: HostedOrganizationProject): HTMLElement {
	const base = `#/c/${company.profile.profileId}`;
	const state = company.store.get();
	const sponsor = state.organization?.responsibilities.find(
		(responsibility) => responsibility.responsibilityId === item.sponsoringResponsibilityId,
	);
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
			{ class: "responsibility-relationships" },
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
				h("h2", null, "Sponsoring responsibility"),
				sponsor
					? h("a", { href: `${base}/responsibility/${sponsor.responsibilityId}` }, sponsor.name)
					: h("p", null, item.sponsoringResponsibilityId ? "Responsibility unavailable" : "Company scope"),
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

/** Every map edge comes from the canonical projection: ownership, project
 * sponsorship, or membership. No sample responsibilities enter product state. */
export function renderOrganization(
	company: CompanyController,
	container: HTMLElement,
	focus?: { kind: "responsibility" | "project"; id: string },
): void {
	const state = company.store.get(),
		organization = state.organization,
		base = `#/c/${company.profile.profileId}`;
	const page = h("section", { class: "page organization" });
	if (focus)
		page.append(h("a", { class: "organization-back", href: `${base}/organization` }, icon("back"), "Organization"));
	if (state.organizationState === "loading") page.append(spinner("Loading organization"));
	else if (state.organizationState === "error")
		page.append(notice("danger", state.organizationError ?? "The organization could not be read."));
	else if (!organization)
		page.append(
			h("h1", null, "Organization"),
			notice("neutral", "The company responsibility map is not available yet."),
		);
	if (focus && organization) {
		if (focus.kind === "responsibility") {
			const item = organization.responsibilities.find((item) => item.responsibilityId === focus.id);
			page.append(
				item
					? responsibilityDetail(company, item)
					: notice("neutral", "This responsibility is no longer available."),
			);
		} else {
			const item = organization.projects.find((item) => item.projectId === focus.id);
			page.append(item ? projectDetail(company, item) : notice("neutral", "This project is no longer available."));
		}
		replace(container, page);
		return;
	}
	if (organization) {
		const cofounder = company.staffById(organization.cofounder.staffAgentId);
		const active = organization.responsibilities.filter((item) => item.status !== "retired");
		const owners = [...new Set(active.map((item) => item.accountableStaffAgentId))];
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
					h(
						"p",
						{ class: "organization-lead" },
						"Responsibilities, their owners, and the projects moving them forward.",
					),
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
					h("small", null, "Company direction and the responsibility map"),
				),
				icon("chevron"),
			),
			h("h2", null, "Responsibility map"),
			h(
				"div",
				{ class: "responsibility-map" },
				...owners.map((id) => {
					const agent = company.staffById(id);
					return h(
						"section",
						{ class: "responsibility-branch" },
						h(
							"div",
							{ class: "map-owner" },
							agentFigure(agent, agent?.displayName ?? "Accountable owner", { size: 42 }),
							h("strong", null, agent?.displayName ?? "Agent unavailable"),
						),
						h(
							"div",
							{ class: "map-outcomes" },
							...active
								.filter((item) => item.accountableStaffAgentId === id)
								.map((item) => responsibilityCard(company, item)),
						),
					);
				}),
				active.length ? null : h("p", { class: "empty" }, "No responsibilities assigned yet."),
			),
			h("h2", null, "Active projects"),
			h(
				"div",
				{ class: "organization-projects" },
				...projects.map((item) => projectCard(company, item)),
				projects.length ? null : h("p", { class: "empty" }, "No active projects."),
			),
		);
		const retired = organization.responsibilities.filter((item) => item.status === "retired");
		const completed = organization.projects.filter(
			(item) => item.status === "completed" || item.status === "cancelled",
		);
		if (retired.length || completed.length)
			page.append(
				h(
					"details",
					{ class: "organization-history" },
					h("summary", null, "Completed and retired"),
					h(
						"div",
						{ class: "organization-projects" },
						...completed.map((item) => projectCard(company, item)),
						...retired.map((item) => responsibilityCard(company, item)),
					),
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
			staff.length ? null : h("p", { class: "empty" }, "No staff yet."),
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
