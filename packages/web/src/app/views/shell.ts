import type { User } from "@supabase/supabase-js";
import type { HostedProfile, HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, button, h, icon, initials, notice, replace } from "../../ui/dom.ts";
import { type AuthController, displayName } from "../auth.ts";
import type { CompanyController } from "../company.ts";
import type { CompanySection, Route } from "../router.ts";

/* The company shell: a rail with conversations and the account menu, and the
 * main pane. A compact toolbar keeps the rail accessible on small screens. */

export interface ShellContext {
	profiles: HostedProfile[];
	user: User | null;
	route: Route;
	auth: AuthController;
	/** Company invitations waiting for this account, for the menu's count. */
	invitations: number;
	navigation?: { open: boolean; toggle: () => void };
}

/* The account menu is one long-lived element: the shell re-renders on every
 * store change, and rebuilding the menu would close it under the pointer. */
let accountMenu: HTMLElement | undefined;
let accountMenuOpen = false;
let accountTrigger: HTMLButtonElement | undefined;
let accountPopover: HTMLElement | undefined;
let accountUserId: string | undefined;

function setAccountMenuOpen(open: boolean): void {
	accountMenuOpen = open;
	accountMenu?.classList.toggle("is-open", open);
	accountTrigger?.setAttribute("aria-expanded", String(open));
	if (accountPopover) accountPopover.hidden = !open;
}

function preserveAccountFocus(): () => void {
	const focused = document.activeElement;
	const scrollTop = accountPopover?.scrollTop ?? 0;
	const triggerFocused = focused === accountTrigger;
	const href = accountMenuOpen && accountPopover?.contains(focused) ? focused?.getAttribute("href") : undefined;
	const signoutFocused = accountMenuOpen && focused?.classList.contains("account-signout");
	return () => {
		if (accountMenuOpen && accountPopover) accountPopover.scrollTop = scrollTop;
		if (triggerFocused) accountTrigger?.focus({ preventScroll: true });
		else if (accountMenuOpen && (href || signoutFocused)) {
			const target = [...(accountPopover?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].find((item) =>
				href ? item.getAttribute("href") === href : item.classList.contains("account-signout"),
			);
			target?.focus({ preventScroll: true });
		}
	};
}

function accountMenuElement(context: ShellContext, company?: CompanyController): HTMLElement {
	if (accountUserId !== context.user?.id || !accountMenu?.isConnected) setAccountMenuOpen(false);
	accountUserId = context.user?.id;
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
				event.stopPropagation();
				setAccountMenuOpen(false);
				accountTrigger?.focus();
			}
		});
		window.addEventListener("hashchange", () => setAccountMenuOpen(false));
	}
	accountMenu.classList.toggle("account-menu-rail", Boolean(company));
	const name = displayName(context.user);
	const section = context.route.name === "company" ? context.route.section : undefined;
	const companyItem = (target: CompanySection, label: string) =>
		h(
			"a",
			{
				class: ["account-item", section === target ? "active" : ""].join(" "),
				role: "menuitem",
				href: `#/c/${company?.profile.profileId}/${target}`,
				onclick: () => setAccountMenuOpen(false),
			},
			label,
		);
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
		company
			? h(
					"div",
					{ role: "group", "aria-label": company.profile.profileName },
					h("div", { class: "account-company-name" }, company.profile.profileName),
					companyItem("approvals", "Approvals"),
					companyItem("file", "Company File"),
					companyItem("organization", "Organization"),
					companyItem("team", "Team"),
					h(
						"a",
						{ class: "account-item", role: "menuitem", href: "#/", onclick: () => setAccountMenuOpen(false) },
						"All companies",
					),
					h("div", { class: "account-separator", role: "separator" }),
				)
			: null,
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
	const restoreFocus = preserveAccountFocus();
	// Company pages put the account in the rail. Only the mobile navigation
	// button needs a toolbar; pages without a rail keep the account here.
	container.classList.toggle("topbar-plain", !company);
	container.classList.toggle("topbar-company", Boolean(company));
	const lead =
		company || context.route.name === "hub" ? null : h("a", { class: "topbar-home", href: "#/" }, "← Companies");
	replace(
		container,
		context.navigation
			? h(
					"button",
					{
						type: "button",
						class: "btn mobile-navigation-toggle",
						"aria-label": "Company navigation",
						"aria-controls": "company-navigation",
						"aria-expanded": String(context.navigation.open),
						onclick: context.navigation.toggle,
					},
					context.navigation.open ? "Close menu" : "Menu",
				)
			: null,
		lead,
		company ? null : h("span", { class: "spacer" }),
		company ? null : accountMenuElement(context),
	);
	if (!company) restoreFocus();
}

/* The company rail, as Qorpera Base draws it (V24 product preview): a search
 * field, the Co-Founder as a low card with its figure standing on it, the rest
 * of the staff as rows, and the account menu at the foot. The pages that
 * are not agents — approvals, the Company File, the organization, the team —
 * live in that menu alongside account settings and company navigation.
 *
 * There is no add-agent button: hiring an agent is machinery this client does
 * not have yet, and a button that writes nowhere is worse than none. */

/* The field outlives re-renders so typing never loses the caret. */
const railFields = new WeakMap<CompanyController, { input: HTMLInputElement; query: string; redraw: () => void }>();

function searchField(company: CompanyController, onInput: () => void) {
	let field = railFields.get(company);
	if (!field) {
		const input = h("input", {
			type: "search",
			placeholder: "Search",
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": "Search agents",
		});
		field = { input, query: "", redraw: onInput };
		railFields.set(company, field);
	}
	const current = field;
	current.redraw = onInput;
	current.input.oninput = () => {
		current.query = current.input.value.trim().toLowerCase();
		current.redraw();
	};
	return current;
}

function statusLine(company: CompanyController, agent: HostedStaffAgent | undefined): string {
	const activity = company.activityFor(agent?.id);
	if (activity?.activity === "needs_attention") return "Needs you";
	if (activity?.activity === "working") return "Working";
	return agent?.role ?? "";
}

export function renderRail(container: HTMLElement, company: CompanyController, context: ShellContext): void {
	const restoreFocus = preserveAccountFocus();
	const route = context.route;
	const state = company.store.get();
	const profileId = company.profile.profileId;
	const activeSessionId = route.name === "company" && route.section === "chat" ? route.id : undefined;
	const activeStaffId = route.name === "company" && route.section === "staff" ? route.id : undefined;
	const sessionOf = (staffId: string) => company.primarySessionFor(staffId);
	const isActive = (staffId: string) =>
		activeStaffId === staffId || (activeSessionId !== undefined && sessionOf(staffId)?.sessionId === activeSessionId);
	const cofounderSessionId = state.organization?.cofounder.memberSessionId;
	const section = route.name === "company" ? route.section : undefined;
	const redraw = () => renderRail(container, company, context);
	const field = searchField(company, redraw);
	const search = field.input;
	const railQuery = field.query;
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
			state.sessionsError
				? notice(
						"danger",
						state.sessionsError,
						button("Retry conversations", () => void company.refreshSessions(), { small: true }),
					)
				: null,
			state.error
				? notice(
						"danger",
						state.error,
						button("Retry company", () => void company.refreshAll(), { small: true }),
					)
				: null,
			cofounderCard,
			state.loading && !state.staff.length ? h("p", { class: "rail-empty" }, "Loading…") : null,
			staffRows.length || sessionRows.length ? h("div", { class: "rail-list" }, ...staffRows, ...sessionRows) : null,
			empty,
		),
		h(
			"div",
			{ class: "rail-footer" },
			state.realtime !== "connected"
				? h(
						"div",
						{ class: "rail-connection", role: "status" },
						badge(
							state.realtime === "connecting" ? "connecting" : "live updates degraded",
							state.realtime === "connecting" ? "neutral" : "warn",
							state.realtimeError ?? "",
						),
					)
				: null,
			accountMenuElement(context, company),
		),
	);
	if (typing) {
		search.focus();
		search.setSelectionRange(caret[0], caret[1]);
	}
	restoreFocus();
}
