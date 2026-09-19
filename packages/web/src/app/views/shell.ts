import type { User } from "@supabase/supabase-js";
import type { HostedProfile, HostedStaffAgent, HostedStaffExecutionActivity } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { badge, button, h, icon, initials, notice, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { uiText } from "../../ui/preferences.ts";
import { type AuthController, displayName } from "../auth.ts";
import type { CompanyController } from "../company.ts";
import type { Route } from "../router.ts";
import type { SettingsTab } from "./settings.ts";

/* The company shell: a rail with conversations and the account menu, and the
 * main pane. A compact toolbar keeps the rail accessible on small screens. */

export interface ShellContext {
	profiles: HostedProfile[];
	user: User | null;
	route: Route;
	auth: AuthController;
	/** Company invitations waiting for this account, for the menu's count. */
	invitations: number;
	openSettings: (tab?: SettingsTab) => void;
	openFeedback: () => void;
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
	const action = accountMenuOpen ? focused?.getAttribute("data-account-action") : undefined;
	return () => {
		if (accountMenuOpen && accountPopover) accountPopover.scrollTop = scrollTop;
		if (triggerFocused) accountTrigger?.focus({ preventScroll: true });
		else if (accountMenuOpen && action) {
			const target = [...(accountPopover?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])].find(
				(item) => item.getAttribute("data-account-action") === action,
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
		accountPopover.addEventListener("keydown", (event) => {
			const items = [...accountPopover!.querySelectorAll<HTMLElement>("[role=menuitem]")];
			const index = items.indexOf(document.activeElement as HTMLElement);
			const offset = matchesKey(event, "next") ? 1 : matchesKey(event, "previous") ? -1 : 0;
			const next = matchesKey(event, "first")
				? 0
				: matchesKey(event, "last")
					? items.length - 1
					: offset
						? (index + offset + items.length) % items.length
						: -1;
			if (next >= 0) {
				event.preventDefault();
				items[next]?.focus();
			}
		});
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
	accountTrigger!.setAttribute("aria-label", `Profile: ${name}`);
	accountTrigger!.title = name;
	// Friends and the company invitations waiting for this account share one settings tab.
	const settingsItem = (tab: SettingsTab, iconName: string, label: string, count = 0) =>
		h(
			"button",
			{
				type: "button",
				class: "account-item",
				role: "menuitem",
				"data-account-action": tab === "general" ? "settings" : tab,
				onclick: () => {
					setAccountMenuOpen(false);
					context.openSettings(tab);
				},
			},
			icon(iconName),
			h("span", { class: "account-item-label" }, uiText(label)),
			count > 0 ? h("span", { class: "account-count" }, String(count)) : null,
		);
	replace(
		accountTrigger!,
		h("span", { class: "account-chip", "aria-hidden": "true" }, initials(name)),
		h("span", { class: "account-trigger-name" }, name),
		company ? null : h("span", { class: "account-chevron", "aria-hidden": "true" }),
	);
	replace(
		accountPopover!,
		h("div", { class: "account-identity" }, h("strong", null, name)),
		settingsItem("general", "settings", "Account and settings"),
		settingsItem("friends", "friends", "Friends", context.invitations),
		h(
			"button",
			{
				type: "button",
				class: "account-item",
				role: "menuitem",
				"data-account-action": "feedback",
				onclick: () => {
					setAccountMenuOpen(false);
					context.openFeedback();
				},
			},
			icon("feedback"),
			h("span", { class: "account-item-label" }, uiText("Feedback")),
		),
		h("div", { class: "account-separator", role: "separator" }),
		h(
			"button",
			{
				type: "button",
				class: "account-item account-signout",
				"data-account-action": "signout",
				role: "menuitem",
				onclick: () => {
					setAccountMenuOpen(false);
					void context.auth.signOut();
				},
			},
			icon("signout"),
			h("span", { class: "account-item-label" }, uiText("Sign out")),
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
						class: "icon-button mobile-navigation-toggle",
						"aria-label": "Company navigation",
						"aria-controls": "company-navigation",
						"aria-expanded": String(context.navigation.open),
						onclick: context.navigation.toggle,
					},
					icon("navigation"),
				)
			: null,
		lead,
		company ? null : h("span", { class: "spacer" }),
		company ? null : accountMenuElement(context),
	);
	if (!company) restoreFocus();
}

/* The Co-Founder has its own full-width tier above other agents, never a
 * pinned-agent tile. Search and creation share the toolbar, with the account menu at the
 * foot. Company management lives in settings. The new-conversation screen can open existing agents;
 * new hires stay unavailable until a cloud creation port is supplied. */

/* The rail's parts are built once per company: the toolbar with its search field,
 * the scrolling list and the foot. A store update changes what they show in place,
 * so the field is never moved (a dead-key or IME composition and the caret survive),
 * the list keeps its scroll position, and rows are rebuilt only when what they show
 * has changed. */
interface RailParts {
	readonly toolbar: HTMLElement;
	readonly close: HTMLButtonElement;
	readonly add: HTMLAnchorElement;
	readonly input: HTMLInputElement;
	readonly list: HTMLElement;
	readonly foot: HTMLElement;
	query: string;
	/** What the list last showed; an update that changes none of it leaves the rows alone. */
	shown: string;
	/** Whether the last draw found the rail collapsed, where the search field is hidden. */
	collapsed: boolean;
	redraw: () => void;
	toggle?: () => void;
}
const railParts = new WeakMap<CompanyController, RailParts>();

/** The desktop rail collapsed to its figure column, where app.css hides the search field. */
const isCollapsed = (element: Element) => window.innerWidth > 760 && element.closest(".rail-compact") !== null;

/** Rebuilt rows are matched by where they lead, or by what a button says. */
const railItemKey = (element: Element) => element.getAttribute("href") ?? element.textContent;

function partsFor(company: CompanyController, redraw: () => void): RailParts {
	let parts = railParts.get(company);
	if (!parts) {
		const input = h("input", {
			type: "search",
			placeholder: "Search",
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": "Search agents",
		});
		const close = h(
			"button",
			{ type: "button", class: "icon-button rail-mobile-close", "aria-label": "Close company navigation" },
			icon("close"),
		);
		const add = h(
			"a",
			{
				class: "rail-add icon-button",
				href: `#/c/${company.profile.profileId}/new`,
				"aria-label": "New conversation or agent",
				title: "New conversation or agent",
			},
			icon("plus"),
		);
		const created: RailParts = {
			toolbar: h("div", { class: "rail-toolbar" }, close, h("label", { class: "rail-search" }, input), add),
			close,
			add,
			input,
			list: h("div", { class: "rail-scroll" }),
			foot: h("div", { class: "rail-footer" }),
			query: "",
			shown: "",
			collapsed: false,
			redraw,
		};
		close.addEventListener("click", () => created.toggle?.());
		// Every keystroke filters, composed text included; redrawing never moves the field.
		input.addEventListener("input", () => {
			const query = input.value.trim().toLowerCase();
			if (query === created.query) return;
			created.query = query;
			created.redraw();
		});
		// Collapsing hides the field, so its query stops filtering until the rail opens again.
		window.addEventListener(
			"qorpera-rail-resize",
			() => {
				if (isCollapsed(input) !== created.collapsed) created.redraw();
			},
			{ signal: company.signal },
		);
		parts = created;
		railParts.set(company, parts);
	}
	parts.redraw = redraw;
	return parts;
}

function statusLine(agent: HostedStaffAgent | undefined, activity: HostedStaffExecutionActivity | undefined): string {
	if (activity?.activity === "needs_attention") return "Needs you";
	if (activity) return "Working";
	return agent?.role ?? "";
}

/** A queued run is already the agent's work from the member's side of the screen. */
const isWorking = (activity: HostedStaffExecutionActivity | undefined) =>
	activity !== undefined && activity.activity !== "needs_attention";
const figureActivity = (activity: HostedStaffExecutionActivity | undefined) =>
	isWorking(activity) ? "Working" : activity ? "Waiting" : "Idle";

export function renderRail(container: HTMLElement, company: CompanyController, context: ShellContext): void {
	const parts = partsFor(company, () => renderRail(container, company, context));
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
	if (parts.toolbar.parentElement !== container) replace(container, parts.toolbar, parts.list, parts.foot);
	parts.collapsed = isCollapsed(container);
	const railQuery = parts.collapsed ? "" : parts.query;
	const matches = (text: string) => !railQuery || text.toLowerCase().includes(railQuery);
	parts.toggle = context.navigation?.toggle;
	parts.close.hidden = !context.navigation;
	if (section === "new") parts.add.setAttribute("aria-current", "page");
	else parts.add.removeAttribute("aria-current");

	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const cofounder =
		(state.organization ? company.staffById(state.organization.cofounder.staffAgentId) : undefined) ??
		active.find((agent) => agent.templateId === "co-founder");
	const shownCofounder = cofounder && matches(`${cofounder.displayName} ${cofounder.role}`) ? cofounder : undefined;
	const cofounderActivity = company.activityFor(shownCofounder?.id);
	const cofounderActive = Boolean(
		shownCofounder &&
			(section === "home" ||
				(cofounderSessionId && activeSessionId === cofounderSessionId) ||
				isActive(shownCofounder.id)),
	);
	const staff = active
		.filter((agent) => agent.id !== cofounder?.id)
		.filter((agent) => matches(`${agent.displayName} ${agent.role}`))
		.map((agent) => ({ agent, activity: company.activityFor(agent.id), active: isActive(agent.id) }));
	// Conversations that are not one agent's own thread: rooms and group work.
	const sessions = state.sessions
		.filter(
			(session) =>
				session.status === "open" &&
				matches(session.title) &&
				(!session.staffAgentId ||
					!active.some((agent) => agent.id === session.staffAgentId) ||
					(session.executionScope &&
						("group" in session.executionScope ||
							("roomId" in session.executionScope && session.executionScope.agentThread !== true)))),
		)
		.map((session) => ({
			session,
			active: activeSessionId === session.sessionId,
			kind:
				session.executionScope && "roomId" in session.executionScope && !session.staffAgentId ? "room" : "company",
		}));
	const loading = state.loading && !state.staff.length;
	const empty =
		!state.loading && !shownCofounder && !staff.length && !sessions.length
			? railQuery
				? "No matching conversations."
				: "No agents yet."
			: null;
	const agentShown = (agent: HostedStaffAgent, activity: HostedStaffExecutionActivity | undefined) => [
		agent.id,
		agent.displayName,
		agent.role,
		agent.templateId ?? "",
		agent.appearance,
		figureActivity(activity),
		statusLine(agent, activity),
	];
	const shown = JSON.stringify([
		state.sessionsError ?? "",
		state.error ?? "",
		loading,
		shownCofounder ? [...agentShown(shownCofounder, cofounderActivity), cofounderActive] : null,
		staff.map((row) => [...agentShown(row.agent, row.activity), row.active]),
		sessions.map((row) => [row.session.sessionId, row.session.title, row.kind, row.active]),
		empty,
	]);

	if (shown !== parts.shown) {
		parts.shown = shown;
		const cofounderCard = shownCofounder
			? h(
					"a",
					{
						class: ["cofounder-home", cofounderActive ? "active" : ""].join(" "),
						href: `#/c/${profileId}`,
						title: `${shownCofounder.displayName} · ${shownCofounder.role}`,
						"aria-current": cofounderActive ? "page" : undefined,
					},
					h(
						"span",
						{ class: "cofounder-stand" },
						agentFigure(shownCofounder, shownCofounder.displayName, {
							size: 82,
							activity: figureActivity(cofounderActivity),
						}),
						// The green disc means "working now", the one state the trailer's dot shows.
						isWorking(cofounderActivity) ? h("span", { class: "cofounder-status", "aria-hidden": "true" }) : null,
					),
					h("strong", null, shownCofounder.displayName),
					h("small", null, statusLine(shownCofounder, cofounderActivity)),
				)
			: null;
		const staffRows = staff.map(({ agent, activity, active: current }) =>
			h(
				"a",
				{
					class: ["rail-row", current ? "active" : ""].join(" "),
					href: `#/c/${profileId}/staff/${agent.id}`,
					title: `${agent.displayName} · ${agent.role}`,
					"aria-current": current ? "page" : undefined,
				},
				h(
					"span",
					{ class: "rail-row-stand" },
					agentFigure(agent, agent.displayName, { size: 40, activity: figureActivity(activity) }),
					isWorking(activity) ? h("span", { class: "rail-row-status", "aria-hidden": "true" }) : null,
				),
				h(
					"span",
					{ class: "rail-row-copy" },
					h("strong", null, agent.displayName),
					h("small", null, statusLine(agent, activity)),
				),
			),
		);
		const sessionRows = sessions.map(({ session, active: current, kind }) =>
			h(
				"a",
				{
					class: ["rail-row", current ? "active" : ""].join(" "),
					href: `#/c/${profileId}/chat/${session.sessionId}`,
					title: session.title,
					"aria-current": current ? "page" : undefined,
				},
				h(
					"span",
					{ class: "rail-row-stand" },
					h("span", { class: "avatar small" }, session.title.slice(0, 1).toUpperCase()),
				),
				h("span", { class: "rail-row-copy" }, h("strong", null, session.title), h("small", null, kind)),
			),
		);
		// Keyboard focus goes back to the rebuilt twin of the row or button it was on.
		const focused = document.activeElement;
		const focusKey = focused instanceof HTMLElement && parts.list.contains(focused) ? railItemKey(focused) : null;
		replace(
			parts.list,
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
			cofounderCard
				? h("div", { class: "rail-cofounder", role: "group", "aria-label": "Co-Founder" }, cofounderCard)
				: null,
			loading ? h("p", { class: "rail-empty" }, "Loading…") : null,
			staffRows.length || sessionRows.length ? h("div", { class: "rail-list" }, ...staffRows, ...sessionRows) : null,
			empty ? h("p", { class: "rail-empty" }, empty) : null,
		);
		if (focusKey)
			[...parts.list.querySelectorAll<HTMLElement>("a[href], button")]
				.find((element) => railItemKey(element) === focusKey)
				?.focus({ preventScroll: true });
	}

	const connection =
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
			: null;
	const menu = accountMenuElement(context, company);
	// The account menu moves only when the foot changes, so an open menu stays where it is.
	if (connection || parts.foot.childNodes.length !== 1 || parts.foot.firstChild !== menu)
		replace(parts.foot, connection, menu);
	restoreFocus();
}
