import { badge, creatureImage, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

/* Organization view (runtime contract §14.3–§14.5): the Co-Founder, the
 * responsibilities with exactly one accountable agent each, active projects,
 * and staff. Rendered from qorpera_company_organization_json; when the kernel
 * is not deployed or has not seeded a company, that state is shown as such. */

export function renderOrganization(company: CompanyController, container: HTMLElement): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const children: (HTMLElement | null)[] = [h("h1", null, "Organization")];
	if (state.organizationState === "loading") children.push(spinner("Loading organization"));
	if (state.organizationState === "not-deployed") {
		children.push(
			notice(
				"neutral",
				"The organization kernel (runtime Order 0: Co-Founder, responsibilities, projects) is not deployed on this cloud yet. Staff are listed below from the hosted staff roster.",
			),
		);
	}
	if (state.organizationState === "not-seeded") {
		children.push(
			notice(
				"neutral",
				"This company predates the organization kernel and has not been seeded with a Co-Founder yet. Nothing is invented here; the cloud seeds it.",
			),
		);
	}
	if (state.organizationState === "error")
		children.push(notice("danger", state.organizationError ?? "The organization could not be read."));
	const organization = state.organization;
	if (organization) {
		const cofounder = company.staffById(organization.cofounder.staffAgentId);
		children.push(
			h(
				"div",
				{ class: "card cofounder-card" },
				creatureImage(
					cofounder?.appearance.creature,
					cofounder?.displayName ?? "Co-Founder",
					cofounder?.appearance.color,
				),
				h(
					"div",
					{ class: "card-body" },
					h("strong", null, cofounder?.displayName ?? "Co-Founder"),
					h(
						"div",
						{ class: "muted small" },
						"Company Co-Founder · formation ",
						badge(organization.formation.state.replaceAll("_", " "), "accent"),
						" ",
						badge(organization.formation.status, organization.formation.status === "active" ? "ok" : "neutral"),
						` · revision ${organization.formation.revision}`,
					),
				),
				h("a", { class: "btn", href: `#/c/${profileId}` }, "Open home"),
			),
			h("h2", null, `Responsibilities (${organization.responsibilities.length})`),
			organization.responsibilities.length
				? h(
						"div",
						{ class: "card-list" },
						...organization.responsibilities.map((responsibility) => {
							const accountable = company.staffById(responsibility.accountableStaffAgentId);
							return h(
								"div",
								{ class: "card responsibility" },
								h(
									"div",
									{ class: "card-body" },
									h(
										"strong",
										null,
										responsibility.name,
										" ",
										badge(
											responsibility.status,
											responsibility.status === "active"
												? "ok"
												: responsibility.status === "degraded"
													? "warn"
													: "neutral",
										),
									),
									responsibility.outcome ? h("p", null, responsibility.outcome) : null,
									h(
										"div",
										{ class: "muted small" },
										"Accountable: ",
										accountable
											? h("a", { href: `#/c/${profileId}/staff/${accountable.id}` }, accountable.displayName)
											: "unknown agent",
										` · attention ${responsibility.attentionCadence}`,
										responsibility.escalationThreshold
											? ` · escalates when ${responsibility.escalationThreshold}`
											: "",
									),
									responsibility.measures.length
										? h(
												"ul",
												{ class: "measures" },
												...responsibility.measures.map((measure) =>
													h(
														"li",
														null,
														h("strong", null, measure.label),
														measure.target ? ` — target ${measure.target}` : "",
														measure.cadence ? ` · ${measure.cadence}` : "",
														" ",
														badge(measure.status, measure.status === "active" ? "ok" : "neutral"),
													),
												),
											)
										: null,
								),
							);
						}),
					)
				: h("div", { class: "empty" }, "No responsibilities yet. The Co-Founder proposes them during formation."),
			h("h2", null, `Projects (${organization.projects.length})`),
			organization.projects.length
				? h(
						"div",
						{ class: "card-list" },
						...organization.projects.map((project) => {
							const lead = company.staffById(project.leadStaffAgentId);
							const sponsor = organization.responsibilities.find(
								(item) => item.responsibilityId === project.sponsoringResponsibilityId,
							);
							return h(
								"div",
								{ class: "card project" },
								h(
									"div",
									{ class: "card-body" },
									h(
										"strong",
										null,
										project.name,
										" ",
										badge(
											project.status,
											project.status === "active" ? "ok" : project.status === "blocked" ? "warn" : "neutral",
										),
									),
									project.objective ? h("p", null, project.objective) : null,
									h(
										"div",
										{ class: "muted small" },
										`Lead: ${lead?.displayName ?? "unknown"}`,
										sponsor ? ` · for ${sponsor.name}` : "",
										project.roomId ? " · has a room" : "",
										project.staff.length
											? ` · ${project.staff.filter((member) => member.status === "active").length} staff`
											: "",
									),
								),
							);
						}),
					)
				: h("div", { class: "empty" }, "No projects yet."),
		);
	}
	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const archived = state.staff.filter((agent) => agent.employmentStatus !== "active");
	children.push(
		h("h2", null, `Staff (${active.length})`),
		active.length
			? h(
					"div",
					{ class: "staff-grid" },
					...active.map((agent) =>
						h(
							"a",
							{ class: "card staff-card", href: `#/c/${profileId}/staff/${agent.id}` },
							creatureImage(agent.appearance.creature, agent.displayName, agent.appearance.color),
							h(
								"div",
								{ class: "card-body" },
								h("strong", null, agent.displayName),
								h("div", { class: "muted small" }, agent.role),
								agent.lifecycleState === "setup" ? badge("setting up", "neutral") : null,
							),
						),
					),
				)
			: h("div", { class: "empty" }, "No staff yet."),
		archived.length
			? h(
					"details",
					null,
					h("summary", null, `${archived.length} archived staff`),
					h("ul", null, ...archived.map((agent) => h("li", null, `${agent.displayName} · ${agent.role}`))),
				)
			: null,
	);
	replace(container, h("section", { class: "page organization" }, ...children));
}
