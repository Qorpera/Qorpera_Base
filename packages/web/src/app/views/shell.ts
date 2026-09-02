import type { User } from "@supabase/supabase-js";
import type { HierarchyNode } from "../../cloud/organization.ts";
import type { HostedProfile } from "../../cloud/types.ts";
import { badge, creatureImage, h, icon, initials, replace } from "../../ui/dom.ts";
import { type AuthController, displayName } from "../auth.ts";
import type { CompanyController } from "../company.ts";
import { navigate, type Route } from "../router.ts";

/* The company shell: top bar with company switcher and account, a rail that
 * renders the §14.5 hierarchy from canonical state, and the main pane. */

export interface ShellContext {
	profiles: HostedProfile[];
	user: User | null;
	route: Route;
	auth: AuthController;
	/** Company invitations waiting for this account, for the menu's count. */
	invitations: number;
}

/* The account menu is one long-lived element: the top bar re-renders on every
 * store change, and rebuilding the menu would close it under the pointer. */
let accountMenu: HTMLElement | undefined;
let accountMenuOpen = false;
let accountTrigger: HTMLButtonElement | undefined;
let accountPopover: HTMLElement | undefined;

function setAccountMenuOpen(open: boolean): void {
	accountMenuOpen = open;
	accountMenu?.classList.toggle("is-open", open);
	accountTrigger?.setAttribute("aria-expanded", String(open));
	if (accountPopover) accountPopover.hidden = !open;
}

function accountMenuElement(context: ShellContext): HTMLElement {
	if (!accountMenu) {
		accountTrigger = h("button", {
			type: "button",
			class: "account-trigger",
			"aria-haspopup": "menu",
			"aria-expanded": "false",
			onclick: (event: MouseEvent) => {
				event.stopPropagation();
				setAccountMenuOpen(!accountMenuOpen);
				if (accountMenuOpen) accountPopover?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
			},
		});
		accountPopover = h("div", { class: "account-popover", role: "menu", hidden: true });
		accountMenu = h("div", { class: "account-menu" }, accountTrigger, accountPopover);
		document.addEventListener("click", (event) => {
			if (accountMenuOpen && !accountMenu?.contains(event.target as Node)) setAccountMenuOpen(false);
		});
		document.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Escape" && accountMenuOpen) {
				setAccountMenuOpen(false);
				accountTrigger?.focus();
			}
		});
		window.addEventListener("hashchange", () => setAccountMenuOpen(false));
	}
	const name = displayName(context.user);
	const item = (target: "account" | "friends" | "invitations", iconName: string, label: string, count = 0) =>
		h(
			"a",
			{
				class: ["account-item", context.route.name === target ? "active" : ""].join(" "),
				role: "menuitem",
				href: `#/${target}`,
				onclick: () => setAccountMenuOpen(false),
			},
			icon(iconName),
			h("span", { class: "account-item-label" }, label),
			count > 0 ? h("span", { class: "account-count" }, String(count)) : null,
		);
	replace(
		accountTrigger!,
		h("span", { class: "account-chip", "aria-hidden": "true" }, initials(name)),
		h("span", { class: "account-trigger-name" }, name),
		h("span", { class: "account-chevron", "aria-hidden": "true" }),
	);
	replace(
		accountPopover!,
		h("div", { class: "account-identity" }, h("strong", null, name)),
		item("account", "settings", "Account and settings"),
		item("friends", "friends", "Friends"),
		item("invitations", "invitations", "Invitations", context.invitations),
		h("div", { class: "account-separator", role: "separator" }),
		h(
			"button",
			{
				type: "button",
				class: "account-item account-signout",
				role: "menuitem",
				onclick: () => {
					setAccountMenuOpen(false);
					void context.auth.signOut();
				},
			},
			icon("signout"),
			h("span", { class: "account-item-label" }, "Sign out"),
		),
	);
	return accountMenu;
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
	// Outside a company the bar is bare: no surface, no divider, no mark. The
	// hub needs nothing on the left; the account pages get a way back. Inside a
	// company the switcher leads and the chrome returns.
	container.classList.toggle("topbar-plain", !company);
	const lead = company
		? switcher
		: context.route.name === "hub"
			? null
			: h("a", { class: "topbar-home", href: "#/" }, "← Companies");
	replace(
		container,
		lead,
		company && realtime && realtime !== "connected"
			? badge(
					realtime === "connecting" ? "connecting" : "live updates degraded",
					realtime === "connecting" ? "neutral" : "warn",
					company.store.get().realtimeError ?? "",
				)
			: null,
		h("span", { class: "spacer" }),
		accountMenuElement(context),
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
