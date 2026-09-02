import type { User } from "@supabase/supabase-js";
import type { HostedProfile, HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, companyLogo, h, icon, initials, replace } from "../../ui/dom.ts";
import { type AuthController, displayName } from "../auth.ts";
import type { CompanyController } from "../company.ts";
import type { CompanySection, Route } from "../router.ts";

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
	const realtime = company?.store.get().realtime;
	// Outside a company the bar is bare: no surface, no divider, no mark. The
	// hub needs nothing on the left; the account pages get a way back. Inside a
	// company the switcher leads and the chrome returns.
	container.classList.toggle("topbar-plain", !company);
	// Inside a company the rail's own switcher names it; outside, the account
	// pages get a way back.
	const lead =
		company || context.route.name === "hub" ? null : h("a", { class: "topbar-home", href: "#/" }, "← Companies");
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

/* The company rail, as Qorpera Base draws it (V24 product preview): a search
 * field, the Co-Founder as a low card with its figure standing on it, the rest
 * of the staff as rows, and the company's own menu at the foot. The pages that
 * are not agents — approvals, the Company File, the organization, the team —
 * live in that menu, which is where the desktop keeps a company's own things.
 *
 * There is no add-agent button: hiring an agent is machinery this client does
 * not have yet, and a button that writes nowhere is worse than none. */

/* The field outlives re-renders so typing never loses the caret. */
let railSearch: HTMLInputElement | undefined;
let railQuery = "";

function searchField(onInput: () => void): HTMLInputElement {
	if (!railSearch) {
		railSearch = h("input", {
			type: "search",
			placeholder: "Search",
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": "Search agents",
			oninput: () => {
				railQuery = (railSearch?.value ?? "").trim().toLowerCase();
				onInput();
			},
		});
	}
	return railSearch;
}

let switcherOpen = false;

function statusLine(company: CompanyController, agent: HostedStaffAgent | undefined): string {
	const activity = company.activityFor(agent?.id);
	if (activity?.activity === "needs_attention") return "Needs you";
	if (activity?.activity === "working") return "Working";
	return agent?.role ?? "";
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
	const section = route.name === "company" ? route.section : undefined;
	const redraw = () => renderRail(container, company, route);
	const search = searchField(redraw);
	const matches = (text: string) => !railQuery || text.toLowerCase().includes(railQuery);

	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const cofounder =
		(state.organization ? company.staffById(state.organization.cofounder.staffAgentId) : undefined) ??
		active.find((agent) => agent.templateId === "co-founder");

	const cofounderCard =
		cofounder && matches(`${cofounder.displayName} ${cofounder.role}`)
			? h(
					"a",
					{
						class: [
							"cofounder-pin",
							section === "home" ||
							(cofounderSessionId && activeSessionId === cofounderSessionId) ||
							isActive(cofounder.id)
								? "active"
								: "",
						].join(" "),
						href: `#/c/${profileId}`,
					},
					h(
						"span",
						{ class: "cofounder-stand" },
						agentFigure(cofounder, cofounder.displayName, { size: 64 }),
						company.activityFor(cofounder.id)?.activity === "working"
							? h("span", { class: "presence", title: "Working" })
							: null,
					),
					h("strong", null, cofounder.displayName),
					h("small", null, statusLine(company, cofounder)),
				)
			: null;

	const staffRow = (agent: HostedStaffAgent) =>
		h(
			"a",
			{
				class: ["rail-row", isActive(agent.id) ? "active" : ""].join(" "),
				href: `#/c/${profileId}/staff/${agent.id}`,
			},
			agentFigure(agent, agent.displayName, { size: 36 }),
			h(
				"span",
				{ class: "rail-row-copy" },
				h("strong", null, agent.displayName),
				h("small", null, statusLine(company, agent)),
			),
		);

	const staffRows = active
		.filter((agent) => agent.id !== cofounder?.id)
		.filter((agent) => matches(`${agent.displayName} ${agent.role}`))
		.map(staffRow);

	// Conversations that are not one agent's own thread: rooms and group work.
	const otherSessions = state.sessions.filter(
		(session) =>
			session.status === "open" &&
			matches(session.title) &&
			(!session.staffAgentId ||
				!active.some((agent) => agent.id === session.staffAgentId) ||
				(session.executionScope && ("roomId" in session.executionScope || "group" in session.executionScope))),
	);
	const sessionRows = otherSessions.map((session) =>
		h(
			"a",
			{
				class: ["rail-row", activeSessionId === session.sessionId ? "active" : ""].join(" "),
				href: `#/c/${profileId}/chat/${session.sessionId}`,
			},
			h("span", { class: "avatar small" }, session.title.slice(0, 1).toUpperCase()),
			h(
				"span",
				{ class: "rail-row-copy" },
				h("strong", null, session.title),
				h(
					"small",
					null,
					session.audience.kind === "member_private"
						? "private"
						: session.executionScope && "roomId" in session.executionScope
							? "room"
							: "company",
				),
			),
		),
	);

	const menuItem = (target: CompanySection, label: string) =>
		h(
			"a",
			{
				class: ["switcher-item", section === target ? "active" : ""].join(" "),
				role: "menuitem",
				href: `#/c/${profileId}/${target}`,
				onclick: () => {
					switcherOpen = false;
				},
			},
			label,
		);
	const switcher = h(
		"div",
		{ class: ["rail-switcher", switcherOpen ? "is-open" : ""].join(" ") },
		h(
			"button",
			{
				type: "button",
				class: "switcher-trigger",
				"aria-haspopup": "menu",
				"aria-expanded": String(switcherOpen),
				onclick: () => {
					switcherOpen = !switcherOpen;
					redraw();
				},
			},
			companyLogo(profileId, "switcher-mark"),
			h(
				"span",
				{ class: "switcher-copy" },
				h("strong", null, company.profile.profileName),
				state.team ? h("small", null, state.team.role) : null,
			),
		),
		h(
			"div",
			{ class: "switcher-menu", role: "menu", hidden: !switcherOpen },
			menuItem("approvals", "Approvals"),
			menuItem("file", "Company File"),
			menuItem("organization", "Organization"),
			menuItem("team", "Team"),
			h("div", { class: "switcher-separator", role: "separator" }),
			h(
				"a",
				{
					class: "switcher-item",
					role: "menuitem",
					href: "#/",
					onclick: () => {
						switcherOpen = false;
					},
				},
				"All companies",
			),
		),
	);

	const empty =
		!state.loading && !cofounderCard && !staffRows.length && !sessionRows.length
			? h("p", { class: "rail-empty" }, railQuery ? "No agent by that name." : "No agents yet.")
			: null;

	// Replacing the rail detaches the field, and a detached element loses
	// focus, so the caret is put back exactly where the typist left it.
	const typing = document.activeElement === search;
	const caret: [number, number] = [search.selectionStart ?? 0, search.selectionEnd ?? 0];
	replace(
		container,
		h("div", { class: "rail-top" }, h("label", { class: "rail-search" }, search)),
		h(
			"div",
			{ class: "rail-scroll" },
			cofounderCard,
			state.loading && !state.staff.length ? h("p", { class: "rail-empty" }, "Loading…") : null,
			staffRows.length || sessionRows.length ? h("div", { class: "rail-list" }, ...staffRows, ...sessionRows) : null,
			empty,
		),
		switcher,
	);
	if (typing) {
		search.focus();
		search.setSelectionRange(caret[0], caret[1]);
	}
}
