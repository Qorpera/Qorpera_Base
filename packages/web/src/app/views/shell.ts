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
/** What the menu last showed; a redraw that changes none of it leaves the menu alone. */
let accountShown: string | undefined;
/** The latest context: the menu's items act on it, not on the one they were built with. */
let accountContext: ShellContext | undefined;

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
	accountContext = context;
	const name = displayName(context.user);
	const shown = JSON.stringify([name, context.invitations, Boolean(company)]);
	if (shown === accountShown) return accountMenu;
	accountShown = shown;
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
					accountContext?.openSettings(tab);
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
					accountContext?.openFeedback();
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
					void accountContext?.auth.signOut();
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
 * the list keeps its scroll position, and a row is rebuilt only when what it shows
 * has changed. */
interface RailParts {
	readonly toolbar: HTMLElement;
	readonly close: HTMLButtonElement;
	readonly add: HTMLAnchorElement;
	readonly input: HTMLInputElement;
	readonly list: HTMLElement;
	readonly connection: HTMLElement;
	readonly foot: HTMLElement;
	/** What the list last showed; an update that changes none of it leaves the list alone. */
	shown: string;
	/** The rows last shown, by where they lead, each with what it showed. */
	rows: Map<string, { shown: string; element: HTMLElement }>;
	/** What the connection status last said. */
	connectionShown: string;
	/** Whether the last draw found the rail collapsed, where the search field is hidden. */
	collapsed: boolean;
	redraw: () => void;
}
const railParts = new WeakMap<CompanyController, RailParts>();

/** The rail collapsed to its figure column (RailLayout, desktop only), where the search field is hidden. */
const isCollapsed = (element: Element) => element.closest(".rail-compact") !== null;

/** Rebuilt rows are matched by where they lead, or by what a button is called or says. */
const railItemKey = (element: Element) =>
	element.getAttribute("href") ?? element.getAttribute("aria-label") ?? element.textContent;

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
		const connection = h("div", { class: "rail-connection", role: "status", hidden: true });
		const created: RailParts = {
			toolbar: h("div", { class: "rail-toolbar" }, close, h("label", { class: "rail-search" }, input), add),
			close,
			add,
			input,
			list: h("div", { class: "rail-scroll" }),
			connection,
			foot: h("div", { class: "rail-footer" }, connection),
			shown: "",
			rows: new Map(),
			connectionShown: "",
			collapsed: false,
			redraw,
		};
		// Every keystroke filters, composed text included; redrawing never moves the field.
		// Results start at the top of the list.
		input.addEventListener("input", () => {
			created.list.scrollTop = 0;
			created.redraw();
		});
		// Collapsing hides the field, so its text stops filtering until the rail opens again.
		// A hidden rail (another page is showing) is drawn afresh when it returns.
		window.addEventListener(
			"qorpera-rail-resize",
			() => {
				const rail = created.toolbar.parentElement;
				if (!rail || rail.hidden || isCollapsed(rail) === created.collapsed) return;
				created.redraw();
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

/* Each rail row is built from its model alone, and the model is also what decides
 * whether the row is rebuilt: whatever a row shows is in its key by construction. */
interface AgentModel extends Pick<HostedStaffAgent, "id" | "displayName" | "role" | "templateId" | "appearance"> {
	figure: ReturnType<typeof figureActivity>;
	status: string;
	current: boolean;
}
interface SessionModel {
	title: string;
	kind: "room" | "company";
	current: boolean;
}
interface RailItem {
	href: string;
	shown: string;
	build: () => HTMLElement;
}
function railItem<M>(href: string, model: M, build: (model: M, href: string) => HTMLElement): RailItem {
	return { href, shown: JSON.stringify(model), build: () => build(model, href) };
}

function cofounderCard(model: AgentModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: ["cofounder-home", model.current ? "active" : ""].join(" "),
			href,
			title: `${model.displayName} · ${model.role}`,
			"aria-current": model.current ? "page" : undefined,
		},
		h(
			"span",
			{ class: "cofounder-stand" },
			agentFigure(model, model.displayName, { size: 82, activity: model.figure }),
			// The green disc means "working now", the one state the trailer's dot shows.
			model.figure === "Working" ? h("span", { class: "cofounder-status", "aria-hidden": "true" }) : null,
		),
		h("strong", null, model.displayName),
		h("small", null, model.status),
	);
}

function agentRow(model: AgentModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: ["rail-row", model.current ? "active" : ""].join(" "),
			href,
			title: `${model.displayName} · ${model.role}`,
			"aria-current": model.current ? "page" : undefined,
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			agentFigure(model, model.displayName, { size: 40, activity: model.figure }),
			model.figure === "Working" ? h("span", { class: "rail-row-status", "aria-hidden": "true" }) : null,
		),
		h("span", { class: "rail-row-copy" }, h("strong", null, model.displayName), h("small", null, model.status)),
	);
}

function sessionRow(model: SessionModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: ["rail-row", model.current ? "active" : ""].join(" "),
			href,
			title: model.title,
			"aria-current": model.current ? "page" : undefined,
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			h("span", { class: "avatar small" }, model.title.slice(0, 1).toUpperCase()),
		),
		h("span", { class: "rail-row-copy" }, h("strong", null, model.title), h("small", null, model.kind)),
	);
}

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
	const railQuery = parts.collapsed ? "" : parts.input.value.trim().toLowerCase();
	const matches = (text: string) => !railQuery || text.toLowerCase().includes(railQuery);
	parts.close.hidden = !context.navigation;
	parts.close.onclick = context.navigation?.toggle ?? null;
	if (section === "new") parts.add.setAttribute("aria-current", "page");
	else parts.add.removeAttribute("aria-current");

	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const cofounder =
		(state.organization ? company.staffById(state.organization.cofounder.staffAgentId) : undefined) ??
		active.find((agent) => agent.templateId === "co-founder");
	const agentModel = (agent: HostedStaffAgent, current: boolean): AgentModel => {
		const activity = company.activityFor(agent.id);
		return {
			id: agent.id,
			displayName: agent.displayName,
			role: agent.role,
			templateId: agent.templateId,
			appearance: agent.appearance,
			figure: figureActivity(activity),
			status: statusLine(agent, activity),
			current,
		};
	};
	const cofounderItem =
		cofounder && matches(`${cofounder.displayName} ${cofounder.role}`)
			? railItem(
					`#/c/${profileId}`,
					agentModel(
						cofounder,
						Boolean(
							section === "home" ||
								(cofounderSessionId && activeSessionId === cofounderSessionId) ||
								isActive(cofounder.id),
						),
					),
					cofounderCard,
				)
			: undefined;
	const rowItems = [
		...active
			.filter((agent) => agent.id !== cofounder?.id)
			.filter((agent) => matches(`${agent.displayName} ${agent.role}`))
			.map((agent) =>
				railItem(`#/c/${profileId}/staff/${agent.id}`, agentModel(agent, isActive(agent.id)), agentRow),
			),
		// Conversations that are not one agent's own thread: rooms and group work.
		...state.sessions
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
			.map((session) =>
				railItem(
					`#/c/${profileId}/chat/${session.sessionId}`,
					{
						title: session.title,
						kind:
							session.executionScope && "roomId" in session.executionScope && !session.staffAgentId
								? ("room" as const)
								: ("company" as const),
						current: activeSessionId === session.sessionId,
					},
					sessionRow,
				),
			),
	];
	const loading = state.loading && !state.staff.length;
	const empty =
		!state.loading && !cofounderItem && !rowItems.length
			? railQuery
				? "No matching conversations."
				: "No agents yet."
			: null;
	const shown = JSON.stringify([
		state.sessionsError ?? "",
		state.error ?? "",
		loading,
		empty,
		[cofounderItem, ...rowItems].map((item) => item && [item.href, item.shown]),
	]);

	if (shown !== parts.shown) {
		parts.shown = shown;
		// A row whose model is unchanged keeps its element (and its figure); only changed rows are built.
		const rows = new Map<string, { shown: string; element: HTMLElement }>();
		const element = (item: RailItem) => {
			const kept = parts.rows.get(item.href);
			const entry = kept?.shown === item.shown ? kept : { shown: item.shown, element: item.build() };
			rows.set(item.href, entry);
			return entry.element;
		};
		const cofounderElement = cofounderItem ? element(cofounderItem) : null;
		const rowElements = rowItems.map(element);
		parts.rows = rows;
		// Keyboard focus goes back to the row or button it was on, or to the nearest thing left.
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
			cofounderElement
				? h("div", { class: "rail-cofounder", role: "group", "aria-label": "Co-Founder" }, cofounderElement)
				: null,
			loading ? h("p", { class: "rail-empty" }, "Loading…") : null,
			rowElements.length ? h("div", { class: "rail-list" }, ...rowElements) : null,
			empty ? h("p", { class: "rail-empty" }, empty) : null,
		);
		if (focusKey) {
			const focusable = [...parts.list.querySelectorAll<HTMLElement>("a[href], button")];
			const same = focusable.find((candidate) => railItemKey(candidate) === focusKey);
			if (same) same.focus({ preventScroll: true });
			else (focusable[0] ?? parts.input).focus();
		}
	}

	const connection = state.realtime === "connected" ? "" : JSON.stringify([state.realtime, state.realtimeError ?? ""]);
	if (connection !== parts.connectionShown) {
		parts.connectionShown = connection;
		parts.connection.hidden = !connection;
		replace(
			parts.connection,
			connection
				? badge(
						state.realtime === "connecting" ? "connecting" : "live updates degraded",
						state.realtime === "connecting" ? "neutral" : "warn",
						state.realtimeError ?? "",
					)
				: null,
		);
	}
	// The account menu is shared with the top bar; it moves back only when it is not here.
	const menu = accountMenuElement(context, company);
	if (menu.parentElement !== parts.foot) parts.foot.append(menu);
	restoreFocus();
}
