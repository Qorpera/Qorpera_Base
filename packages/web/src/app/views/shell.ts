import type { User } from "@supabase/supabase-js";
import type { HierarchyNode } from "../../cloud/organization.ts";
import type { HostedProfile } from "../../cloud/types.ts";
import { badge, creatureImage, h, replace } from "../../ui/dom.ts";
import { displayName } from "../auth.ts";
import type { CompanyController } from "../company.ts";
import { navigate, type Route } from "../router.ts";

/* The company shell: top bar with company switcher and account, a rail that
 * renders the §14.5 hierarchy from canonical state, and the main pane. */

export interface ShellContext {
	profiles: HostedProfile[];
	user: User | null;
	route: Route;
}

export function renderTopbar(
	container: HTMLElement,
	context: ShellContext,
	company: CompanyController | undefined,
): void {
	const switcher = h(
		"select",
		{
			class: "company-switcher",
			"aria-label": "Switch company",
			onchange: () => {
				if (switcher.value === "__hub") navigate({ name: "hub" });
				else navigate({ name: "company", profileId: switcher.value, section: "home" });
			},
		},
		h("option", { value: "__hub", selected: !company }, "All companies"),
		...context.profiles.map((profile) =>
			h(
				"option",
				{ value: profile.profileId, selected: profile.profileId === company?.profile.profileId },
				profile.profileName,
			),
		),
	);
	const realtime = company?.store.get().realtime;
	replace(
		container,
		h(
			"a",
			{ class: "brand", href: "#/", "aria-label": "Qorpera home" },
			h("img", { src: "./assets/brand/qorpera-lockup-light-800.png", alt: "Qorpera", width: 800, height: 200 }),
		),
		switcher,
		company && realtime && realtime !== "connected"
			? badge(
					realtime === "connecting" ? "connecting" : "live updates degraded",
					realtime === "connecting" ? "neutral" : "warn",
					company.store.get().realtimeError ?? "",
				)
			: null,
		h("span", { class: "spacer" }),
		h("a", { class: "topbar-link", href: "#/cloud-check", title: "Verify the cloud surface" }, "Cloud check"),
		h(
			"a",
			{ class: "topbar-link account-link", href: "#/account", title: context.user?.email ?? "" },
			displayName(context.user),
		),
	);
}

export function renderRail(container: HTMLElement, company: CompanyController, route: Route): void {
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const activeSessionId = route.name === "company" && route.section === "chat" ? route.id : undefined;
	const activeStaffId = route.name === "company" && route.section === "staff" ? route.id : undefined;
	const sessionOf = (staffId: string) => company.primarySessionFor(staffId);
	const isActive = (staffId: string) =>
		activeStaffId === staffId || (activeSessionId !== undefined && sessionOf(staffId)?.sessionId === activeSessionId);
	const cofounderSessionId = state.organization?.cofounder.memberSessionId;

	const nodeEl = (node: HierarchyNode, depth: number): HTMLElement => {
		const agent = company.staffById(node.canonicalId);
		const activity = company.activityFor(
			node.kind === "agent" || node.kind === "cofounder" ? node.canonicalId : undefined,
		);
		const dot =
			activity?.activity === "working"
				? h("span", { class: "dot dot-ok", title: "Working" })
				: activity?.activity === "needs_attention"
					? h("span", { class: "dot dot-warn", title: "Needs attention" })
					: null;
		if (node.kind === "cofounder") {
			return h(
				"a",
				{
					class: [
						"rail-item",
						"rail-cofounder",
						(route.name === "company" && route.section === "home") ||
						(cofounderSessionId && activeSessionId === cofounderSessionId)
							? "active"
							: "",
					].join(" "),
					href: `#/c/${profileId}`,
				},
				creatureImage(agent?.appearance.creature, node.label, agent?.appearance.color),
				h("span", { class: "rail-label" }, node.label, h("span", { class: "muted small" }, "Co-Founder · home")),
				dot,
			);
		}
		if (node.kind === "agent") {
			return h(
				"a",
				{
					class: ["rail-item", isActive(node.canonicalId) ? "active" : ""].join(" "),
					href: `#/c/${profileId}/staff/${node.canonicalId}`,
					dataset: { depth: String(depth) },
				},
				creatureImage(agent?.appearance.creature, node.label, agent?.appearance.color),
				h(
					"span",
					{ class: "rail-label" },
					node.label,
					h("span", { class: "muted small" }, node.role ?? agent?.role ?? ""),
				),
				dot,
			);
		}
		const kindLabel =
			node.kind === "responsibility" ? "Responsibility" : node.kind === "project" ? "Project" : "Room";
		return h(
			"div",
			{ class: `rail-group rail-${node.kind}`, dataset: { depth: String(depth) } },
			h(
				"div",
				{ class: "rail-group-title" },
				h("span", { class: "muted small" }, kindLabel),
				h("span", null, node.label),
				node.status !== "active" ? badge(node.status, "neutral") : null,
			),
			...node.children.map((child) => nodeEl(child, depth + 1)),
		);
	};

	const hierarchyAgentIds = new Set<string>();
	const collect = (nodes: HierarchyNode[]) => {
		for (const node of nodes) {
			if (node.kind === "agent" || node.kind === "cofounder") hierarchyAgentIds.add(node.canonicalId);
			collect(node.children);
		}
	};
	collect(state.hierarchy.primary);
	collect(state.hierarchy.inactive);
	const otherSessions = state.sessions.filter(
		(session) =>
			session.status === "open" &&
			(!session.staffAgentId ||
				!hierarchyAgentIds.has(session.staffAgentId) ||
				(session.executionScope && ("roomId" in session.executionScope || "group" in session.executionScope))),
	);

	const navLink = (section: "approvals" | "file" | "organization" | "team", label: string) =>
		h(
			"a",
			{
				class: [
					"rail-nav",
					route.name === "company" &&
					(route.section === section ||
						(section === "file" && (route.section === "snapshot" || route.section === "proposal")))
						? "active"
						: "",
				].join(" "),
				href: `#/c/${profileId}/${section}`,
			},
			label,
		);

	replace(
		container,
		h(
			"div",
			{ class: "rail-company" },
			h("strong", null, company.profile.profileName),
			state.team ? badge(state.team.role, "neutral") : null,
		),
		h(
			"nav",
			{ class: "rail-section", "aria-label": "Company" },
			navLink("approvals", "Approvals"),
			navLink("file", "Company File"),
			navLink("organization", "Organization"),
			navLink("team", "Team"),
		),
		h(
			"div",
			{ class: "rail-section" },
			h("div", { class: "rail-heading" }, "Attention"),
			...state.hierarchy.primary.map((node) => nodeEl(node, 0)),
		),
		otherSessions.length
			? h(
					"div",
					{ class: "rail-section" },
					h("div", { class: "rail-heading" }, "Other conversations"),
					...otherSessions.map((session) =>
						h(
							"a",
							{
								class: ["rail-item", activeSessionId === session.sessionId ? "active" : ""].join(" "),
								href: `#/c/${profileId}/chat/${session.sessionId}`,
							},
							h("span", { class: "avatar small" }, session.title.slice(0, 1).toUpperCase()),
							h(
								"span",
								{ class: "rail-label" },
								session.title,
								h(
									"span",
									{ class: "muted small" },
									session.audience.kind === "member_private"
										? "private"
										: session.executionScope && "roomId" in session.executionScope
											? "room"
											: "company",
								),
							),
						),
					),
				)
			: null,
		state.hierarchy.inactive.length
			? h(
					"details",
					{ class: "rail-section rail-inactive" },
					h("summary", { class: "rail-heading" }, `Inactive (${state.hierarchy.inactive.length})`),
					...state.hierarchy.inactive.map((node) => nodeEl(node, 0)),
				)
			: null,
	);
}
