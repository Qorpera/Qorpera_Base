import type { User } from "@supabase/supabase-js";
import { type CompanySidebar, containerOrder, PIN_LIMIT, SECTION_NAME_LIMIT } from "../../cloud/sidebar.ts";
import type { HostedProfile, HostedStaffAgent } from "../../cloud/types.ts";
import { AGENT_LOOK, type AgentLook, stateLine } from "../../ui/agent-activity.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { type MenuEntry, menuPoint, openContextMenu } from "../../ui/context-menu.ts";
import { badge, button, confirmDialog, h, icon, initials, notice, replace } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { matchesKey } from "../../ui/keys.ts";
import { nameDialog } from "../../ui/name-dialog.ts";
import { attachPersonPicture, personPicturesEpoch } from "../../ui/person-pictures.ts";
import { phrase, presentationLocale, t, uiText } from "../../ui/preferences.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { RailDrag, type RailDrop } from "../../ui/rail-drag.ts";
import { railListSkeleton } from "../../ui/skeleton.ts";
import { type AuthController, displayName } from "../auth.ts";
import { type AgentState, type CompanyController, isAgentPairSession } from "../company.ts";
import type { Route } from "../router.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { savedAgentDraft } from "./agent-edits.ts";
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
	/** What the rail's agent menu can do beyond the sidebar itself. */
	agentActions?: Pick<WorkspaceActions, "updateAgent" | "deleteAgent">;
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
	const shown = JSON.stringify([
		name,
		context.user?.id,
		personPicturesEpoch(),
		context.invitations,
		Boolean(company),
		presentationLocale(),
	]);
	if (shown === accountShown) return accountMenu;
	accountTrigger!.setAttribute("aria-label", t("Profile: {name}", { name }));
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
	const chip = h("span", { class: "account-chip", "aria-hidden": "true" }, initials(name));
	if (context.user) attachPersonPicture(chip, context.user.id);
	replace(
		accountTrigger!,
		chip,
		h("span", { class: "account-trigger-name" }, name),
		company ? null : h("span", { class: "account-chevron", "aria-hidden": "true" }),
	);
	replace(
		accountPopover!,
		h("div", { class: "account-identity" }, h("strong", null, name)),
		settingsItem("general", "settings", phrase("Account and settings")),
		settingsItem("friends", "friends", phrase("Friends"), context.invitations),
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
	accountShown = shown;
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
		company || context.route.name === "hub" ? null : h("a", { class: "topbar-home", href: "#/" }, t("← Companies"));
	replace(
		container,
		context.navigation
			? h(
					"button",
					{
						type: "button",
						class: "icon-button mobile-navigation-toggle",
						"aria-label": t("Company navigation"),
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
 * pinned-agent tile. Under it stand the member's pinned agents as square cards,
 * then the company's sections (Grok Bot's rail, 2026-09-24), then Unassigned with
 * the group chats. A right-click on an agent opens its menu (pin, move to a
 * section, rename, copy the conversation id, hide, delete); on a section, rename
 * or delete it; on the rail, make a new section. Agents drag between sections and
 * into or out of the pinned row. Search and creation share the toolbar, with the
 * account menu at the foot. Company management lives in settings. */

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
	/** The list's own slots, kept so that nothing unchanged ever leaves the page. */
	readonly cofounderGroup: HTMLElement;
	readonly pinnedGroup: HTMLElement;
	/** The company's sections by id, and Unassigned, each built once and kept. */
	sections: Map<string, SectionParts>;
	readonly unassigned: SectionParts;
	/** Grok Bot's "Hidden Bots": this member's hidden agents, folded at the foot of the list. */
	readonly hiddenGroup: HiddenParts;
	/** The list's placeholder, built when first shown so it breathes with the page's. */
	loading: HTMLElement | undefined;
	readonly empty: HTMLElement;
	/** The rows by where they lead, each with the model it was built from. */
	rows: Map<string, { shown: string; element: HTMLElement }>;
	/** The error notices by what they are about, each with the text it shows. */
	notices: Map<string, { text: string; element: HTMLElement }>;
	/** The interface language the parts were last labelled in. */
	locale: string;
	/** What the connection status last said. */
	connectionShown: string;
	/** Whether the last draw found the rail collapsed, where the search field is hidden. */
	collapsed: boolean;
	/** The latest draw's context: the menus and the drag act on it. */
	context?: ShellContext;
	readonly drag: RailDrag;
	redraw: () => void;
}
interface HiddenParts {
	readonly el: HTMLElement;
	readonly toggle: HTMLButtonElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	readonly chevron: HTMLElement;
	readonly list: HTMLElement;
	open: boolean;
}
const HIDDEN_OPEN_KEY = "qorpera.web.rail-hidden-open";
function hiddenParts(redraw: () => void): HiddenParts {
	let open = false;
	try {
		open = localStorage.getItem(HIDDEN_OPEN_KEY) === "1";
	} catch {
		/* Storage may be unavailable; the group starts folded. */
	}
	const label = h("span", { class: "rail-hidden-label" });
	const count = h("span", { class: "rail-hidden-count" });
	const chevron = h("span", { class: "rail-hidden-chevron", "aria-hidden": "true" }, icon("chevron-down"));
	const list = h("div", { class: "rail-section-list rail-hidden-list", id: "rail-hidden-list" });
	const toggle = h(
		"button",
		{ type: "button", class: "rail-hidden-toggle", "aria-controls": "rail-hidden-list" },
		label,
		count,
		chevron,
	);
	const parts: HiddenParts = {
		el: h("div", { class: "rail-hidden" }, toggle, list),
		toggle,
		label,
		count,
		chevron,
		list,
		open,
	};
	toggle.addEventListener("click", () => {
		parts.open = !parts.open;
		try {
			localStorage.setItem(HIDDEN_OPEN_KEY, parts.open ? "1" : "0");
		} catch {
			/* The choice lasts this visit. */
		}
		redraw();
	});
	return parts;
}
interface SectionParts {
	readonly el: HTMLElement;
	readonly title: HTMLElement;
	readonly list: HTMLElement;
}
let sectionTitles = 0;
function sectionParts(zone: string, sectionId?: string): SectionParts {
	const titleId = `rail-section-title-${++sectionTitles}`;
	const title = h("div", {
		class: "rail-section-title",
		id: titleId,
		...(sectionId ? { "data-section-id": sectionId } : {}),
	});
	const list = h("div", { class: "rail-section-list" });
	return {
		el: h(
			"div",
			{ class: "rail-section", role: "group", "aria-labelledby": titleId, "data-zone": zone },
			title,
			list,
		),
		title,
		list,
	};
}
const railParts = new WeakMap<CompanyController, RailParts>();

/** The rail collapsed to its figure column (RailLayout, desktop only), where the search field is hidden. */
const isCollapsed = (element: Element) => element.closest(".rail-compact") !== null;

/** Makes a parent's children exactly these, removing first and then inserting only where
 * a child is out of place, so a child that keeps its place never leaves the page. */
function reconcile(parent: HTMLElement, children: readonly HTMLElement[]): void {
	const kept = new Set<Element>(children);
	for (const child of [...parent.children]) if (!kept.has(child)) child.remove();
	children.forEach((child, index) => {
		if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
	});
}

function partsFor(company: CompanyController, redraw: () => void): RailParts {
	let parts = railParts.get(company);
	if (!parts) {
		const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false" });
		const close = h("button", { type: "button", class: "icon-button rail-mobile-close" }, icon("close"));
		const add = h("a", { class: "rail-add icon-button", href: `#/c/${company.profile.profileId}/new` }, icon("plus"));
		const connection = h("div", { class: "rail-connection", role: "status", hidden: true });
		const list = h("div", { class: "rail-scroll" });
		const created: RailParts = {
			toolbar: h("div", { class: "rail-toolbar" }, close, h("label", { class: "rail-search" }, input), add),
			close,
			add,
			input,
			list,
			connection,
			foot: h("div", { class: "rail-footer" }, connection),
			cofounderGroup: h("div", { class: "rail-cofounder", role: "group", "aria-label": "Co-Founder" }),
			pinnedGroup: h(
				"div",
				{ class: "rail-pinned", role: "group", "data-zone": "pinned" },
				h("span", { class: "rail-drop-slot" }),
			),
			sections: new Map(),
			unassigned: sectionParts("unassigned"),
			hiddenGroup: hiddenParts(() => created.redraw()),
			loading: undefined,
			empty: h("p", { class: "rail-empty" }),
			rows: new Map(),
			notices: new Map(),
			locale: "",
			connectionShown: "",
			collapsed: false,
			drag: undefined as unknown as RailDrag,
			redraw,
		};
		(created as { drag: RailDrag }).drag = new RailDrag(list, () => dragHooks(company, created), company.signal);
		list.addEventListener("contextmenu", (event) => openRailMenu(company, created, event), {
			signal: company.signal,
		});
		pressToOpenMenu(list, company, created);
		// Dragging has a keyboard twin: Alt with an arrow moves the focused agent one place.
		list.addEventListener(
			"keydown",
			(event) => {
				const delta = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
				const agentId = (event.target as HTMLElement).dataset?.agentId;
				if (!event.altKey || !delta || !agentId) return;
				event.preventDefault();
				nudgeAgent(company, agentId, delta);
			},
			{ signal: company.signal },
		);
		// Every keystroke filters, composed text included; redrawing never moves the field.
		// Results start at the top of the list.
		quietScroll(created.list);
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
	// The parts outlive a language change: give them their words again and
	// build every row, notice and badge anew in the new language.
	const locale = presentationLocale();
	if (parts.locale !== locale) {
		parts.locale = locale;
		parts.input.placeholder = t("Search");
		parts.pinnedGroup.setAttribute("aria-label", t("Pinned agents"));
		const slot = parts.pinnedGroup.querySelector<HTMLElement>(".rail-drop-slot");
		if (slot) slot.textContent = t("Drop here to pin");
		parts.unassigned.title.textContent = t("Unassigned");
		parts.hiddenGroup.label.textContent = t("Hidden agents");
		parts.input.setAttribute("aria-label", t("Search agents"));
		parts.close.setAttribute("aria-label", t("Close company navigation"));
		parts.add.setAttribute("aria-label", t("New conversation or agent"));
		parts.add.title = t("New conversation or agent");
		parts.loading = undefined;
		parts.rows = new Map();
		parts.notices = new Map();
		parts.connectionShown = "";
	}
	return parts;
}

function statusDisc(look: AgentLook, className: string): HTMLElement | null {
	if (!look.disc) return null;
	return h("span", { class: look.disc === "failed" ? `${className} failed` : className, "aria-hidden": "true" });
}

/** The tooltip. Any state also goes into the link's name, which the compact rail
 * needs: it hides the text beside the figure and the disc says nothing aloud. */
function railLabel(
	agent: Pick<HostedStaffAgent, "displayName" | "role"> & { mentioned?: boolean },
	look: AgentLook,
): { title: string; "aria-label"?: string } {
	// AGENT_LOOK keeps the English words; they are translated where they are drawn.
	const words = look.note ?? look.line;
	const state = words ? t(words) : undefined;
	const mention = agent.mentioned ? t("You were mentioned") : undefined;
	const label = [agent.displayName, agent.role, state, mention].filter(Boolean).join(" · ");
	return state || mention ? { title: label, "aria-label": label } : { title: label };
}

/** "@" on a conversation where someone mentioned this member and they have not looked yet. */
function mentionBadge(mentioned: boolean | undefined): HTMLElement | null {
	return mentioned ? h("span", { class: "rail-mention", "aria-hidden": "true" }, "@") : null;
}

/* Each rail row is built from its model alone, and the model is also what decides
 * whether the row is rebuilt: whatever a row shows is in its key by construction.
 * Which row is current is set in place instead, since it changes with every navigation. */
interface AgentModel extends Pick<HostedStaffAgent, "id" | "displayName" | "role" | "templateId" | "appearance"> {
	state: AgentState;
	/** Someone mentioned this member in the agent's thread and they have not looked yet. */
	mentioned: boolean;
}
interface SessionModel {
	title: string;
	subtitle: string;
	kind: "Group chat" | "company";
	agents: HostedStaffAgent[];
	selected: boolean;
	mentioned: boolean;
}
function cofounderCard(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	return h(
		"a",
		{ class: "cofounder-home", href, draggable: "false", "data-cofounder-id": model.id, ...railLabel(model, look) },
		h(
			"span",
			{ class: "cofounder-stand" },
			agentFigure(model, model.displayName, { size: 82, activity: look.figure }),
			statusDisc(look, "cofounder-status"),
			mentionBadge(model.mentioned),
		),
		h("strong", null, model.displayName),
	);
}

/** A pinned agent: a square card with the figure over the name, as in Grok Bot. */
function pinCard(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	return h(
		"a",
		{ class: "rail-pin", href, draggable: "false", "data-agent-id": model.id, ...railLabel(model, look) },
		h(
			"span",
			{ class: "rail-pin-stand" },
			agentFigure(model, model.displayName, { size: 52, activity: look.figure }),
			statusDisc(look, "rail-row-status"),
			mentionBadge(model.mentioned),
		),
		h("strong", { class: "rail-pin-name" }, model.displayName),
	);
}

function agentRow(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	return h(
		"a",
		{
			class: "rail-row rail-row-agent",
			href,
			draggable: "false",
			"data-agent-id": model.id,
			...railLabel(model, look),
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			agentFigure(model, model.displayName, { size: 50, activity: look.figure }),
			statusDisc(look, "rail-row-status"),
			mentionBadge(model.mentioned),
		),
		h(
			"span",
			{ class: "rail-row-copy" },
			h("strong", null, model.displayName),
			h("small", null, stateLine(look, model.role)),
		),
	);
}

function sessionRow(model: SessionModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: model.kind === "Group chat" ? "rail-row rail-row-group" : "rail-row",
			href,
			title: [model.title, model.subtitle, model.mentioned ? t("You were mentioned") : ""]
				.filter(Boolean)
				.join(" · "),
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			model.kind === "Group chat"
				? groupChatAvatar(model.agents, { width: 60, height: 55, selected: model.selected })
				: h("span", { class: "avatar small" }, model.title.slice(0, 1).toUpperCase()),
			mentionBadge(model.mentioned),
		),
		h("span", { class: "rail-row-copy" }, h("strong", null, model.title), h("small", null, model.subtitle)),
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

	parts.context = context;
	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const cofounderId = company.cofounderId();
	const cofounder = cofounderId ? company.staffById(cofounderId) : undefined;
	// Keyboard focus in the list stays on its element. A rebuilt row hands it to the row
	// built in its place; an element that left hands it to whatever now stands where it stood.
	const focusables = () => [...parts.list.querySelectorAll<HTMLElement>("a[href], button, [tabindex='0']")];
	const focused =
		document.activeElement instanceof HTMLElement && parts.list.contains(document.activeElement)
			? document.activeElement
			: null;
	const index = focused ? focusables().indexOf(focused) : -1;
	let successor: HTMLElement | undefined;
	// A row whose model is unchanged keeps its element (and its figure); only changed rows are built.
	// A pinned card and a row lead to the same place, so the cache key says which one it is.
	const rows = new Map<string, { shown: string; element: HTMLElement }>();
	const row = <M>(
		key: string,
		href: string,
		model: M,
		current: boolean,
		build: (model: M, href: string) => HTMLElement,
	) => {
		const shown = JSON.stringify(model);
		const kept = parts.rows.get(key);
		// A figure that could not load is built again, so it gets another try.
		const entry =
			kept?.shown === shown && !kept.element.querySelector("[data-motion-unavailable]")
				? kept
				: { shown, element: build(model, href) };
		if (kept && entry !== kept && kept.element === focused) successor = entry.element;
		rows.set(key, entry);
		entry.element.classList.toggle("active", current);
		if (current) entry.element.setAttribute("aria-current", "page");
		else entry.element.removeAttribute("aria-current");
		return entry.element;
	};
	const mentionedIn = (sessionId: string | undefined) => Boolean(sessionId && state.mentions?.[sessionId]);
	const agentModel = (agent: HostedStaffAgent): AgentModel => {
		return {
			id: agent.id,
			displayName: agent.displayName,
			role: agent.role,
			templateId: agent.templateId,
			appearance: agent.appearance,
			// State is part of the cache key, including idle/failed transitions with the same figure and role.
			state: company.agentState(agent.id),
			mentioned: mentionedIn(
				agent.id === cofounder?.id && cofounderSessionId
					? cofounderSessionId
					: company.primarySessionFor(agent.id)?.sessionId,
			),
		};
	};
	const cofounderElement =
		cofounder && matches(`${cofounder.displayName} ${cofounder.role}`)
			? row(
					`#/c/${profileId}`,
					`#/c/${profileId}`,
					agentModel(cofounder),
					Boolean(
						section === "home" ||
							(cofounderSessionId && activeSessionId === cofounderSessionId) ||
							isActive(cofounder.id),
					),
					cofounderCard,
				)
			: null;
	// The sidebar: this member's pins and hidden agents, the company's sections. A cloud
	// without it shows every agent in one list, as before.
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const roster = company.sidebarRoster();
	const pinned = (sidebar?.pinned ?? []).filter((agentId) => roster.includes(agentId));
	const hidden = new Set(sidebar?.hidden ?? []);
	const shown = (agent: HostedStaffAgent | undefined): agent is HostedStaffAgent =>
		// A hidden agent is still found by searching for it.
		Boolean(agent) &&
		matches(`${agent!.displayName} ${agent!.role}`) &&
		(!hidden.has(agent!.id) || Boolean(railQuery));
	const agentElement = (agent: HostedStaffAgent) =>
		row(
			`#/c/${profileId}/staff/${agent.id}`,
			`#/c/${profileId}/staff/${agent.id}`,
			agentModel(agent),
			isActive(agent.id),
			agentRow,
		);
	const pinnedElements = pinned
		.map((agentId) => company.staffById(agentId))
		.filter(shown)
		.map((agent) =>
			row(
				`pin:#/c/${profileId}/staff/${agent.id}`,
				`#/c/${profileId}/staff/${agent.id}`,
				agentModel(agent),
				isActive(agent.id),
				pinCard,
			),
		);
	const inContainer = (sectionId: string | undefined) =>
		(sidebar ? containerOrder(sidebar, sectionId, roster) : sectionId ? [] : roster)
			.filter((agentId) => !pinned.includes(agentId))
			.map((agentId) => company.staffById(agentId))
			.filter(shown)
			.map(agentElement);
	const sectionGroups = (sidebar?.sections ?? []).map((item) => {
		let group = parts.sections.get(item.sectionId);
		if (!group) {
			group = sectionParts(`section:${item.sectionId}`, item.sectionId);
			parts.sections.set(item.sectionId, group);
		}
		if (group.title.textContent !== item.name) group.title.textContent = item.name;
		return { group, rows: inContainer(item.sectionId) };
	});
	for (const [sectionId] of parts.sections)
		if (!sidebar?.sections.some((item) => item.sectionId === sectionId)) parts.sections.delete(sectionId);
	// Hidden agents fold at the foot of the list, where they can be shown again. A search
	// already lists the matching ones in their places.
	const hiddenAgents = railQuery
		? []
		: roster
				.filter((agentId) => hidden.has(agentId))
				.map((agentId) => company.staffById(agentId))
				.filter((agent): agent is HostedStaffAgent => Boolean(agent));
	const hiddenGroup = parts.hiddenGroup;
	hiddenGroup.count.textContent = String(hiddenAgents.length);
	hiddenGroup.count.hidden = hiddenGroup.open;
	hiddenGroup.chevron.hidden = !hiddenGroup.open;
	hiddenGroup.toggle.setAttribute("aria-expanded", String(hiddenGroup.open));
	hiddenGroup.toggle.setAttribute("aria-label", t("Hidden agents: {count}", { count: hiddenAgents.length }));
	hiddenGroup.list.hidden = !hiddenGroup.open;
	reconcile(
		hiddenGroup.list,
		hiddenGroup.open
			? hiddenAgents.map((agent) =>
					row(
						`hidden:#/c/${profileId}/staff/${agent.id}`,
						`#/c/${profileId}/staff/${agent.id}`,
						agentModel(agent),
						isActive(agent.id),
						agentRow,
					),
				)
			: [],
	);
	const unassignedRows = [
		...inContainer(undefined),
		// Conversations that are not one agent's own thread: rooms and group work.
		...state.sessions
			.filter(
				(session) =>
					session.status === "open" &&
					matches(session.title) &&
					// A pair transcript is reached from the chips in the agents' threads, never from the rail.
					!isAgentPairSession(session) &&
					(!session.staffAgentId ||
						!active.some((agent) => agent.id === session.staffAgentId) ||
						(session.executionScope &&
							("group" in session.executionScope ||
								("roomId" in session.executionScope && session.executionScope.agentThread !== true)))),
			)
			.map((session) =>
				row(
					`#/c/${profileId}/chat/${session.sessionId}`,
					`#/c/${profileId}/chat/${session.sessionId}`,
					{
						title: session.title,
						subtitle: isGroupChat(session)
							? (state.groups?.[String(session.executionScope?.roomId)]?.subtitle ?? t("Group chat"))
							: t("company"),
						kind: isGroupChat(session) ? ("Group chat" as const) : ("company" as const),
						agents: company.groupAgents(session.sessionId),
						selected: activeSessionId === session.sessionId,
						mentioned: mentionedIn(session.sessionId),
					},
					activeSessionId === session.sessionId,
					sessionRow,
				),
			),
	];
	// An error notice is built again only when its text changes, so it is not announced again.
	const notices = new Map<string, { text: string; element: HTMLElement }>();
	const errorNotice = (about: string, text: string | undefined, retry: () => HTMLElement) => {
		if (!text) return null;
		const kept = parts.notices.get(about);
		const entry = kept?.text === text ? kept : { text, element: notice("danger", text, retry()) };
		notices.set(about, entry);
		return entry.element;
	};
	const anyRows =
		pinnedElements.length +
		unassignedRows.length +
		hiddenAgents.length +
		sectionGroups.reduce((n, g) => n + g.rows.length, 0);
	if (!state.loading || state.staff.length) parts.loading = undefined;
	else parts.loading ??= railListSkeleton();
	const empty =
		!state.loading && !cofounderElement && !anyRows
			? railQuery
				? t("No matching conversations.")
				: t("No agents yet.")
			: null;
	if (empty && parts.empty.textContent !== empty) parts.empty.textContent = empty;
	// Drop zones exist only where the sidebar does; while searching, only rows that match show.
	const zone = (element: HTMLElement, on: boolean) => {
		const value = element.dataset.zone ?? "";
		if (on) element.dataset.dropZone = value;
		else delete element.dataset.dropZone;
	};
	const sectioned = sectionGroups.length > 0;
	zone(parts.pinnedGroup, Boolean(sidebar));
	parts.pinnedGroup.classList.toggle("is-empty", !pinnedElements.length);
	reconcile(parts.pinnedGroup, [...pinnedElements, parts.pinnedGroup.querySelector<HTMLElement>(".rail-drop-slot")!]);
	// A section title opens its menu from the keyboard only for members who can change it;
	// for everyone else it is just a label, never a tab stop.
	const organize = canOrganize(company);
	for (const { group, rows: sectionRows } of sectionGroups) {
		zone(group.el, true);
		reconcile(group.list, sectionRows);
		if (organize) {
			group.title.tabIndex = 0;
			group.title.setAttribute("role", "button");
			group.title.setAttribute("aria-haspopup", "menu");
		} else {
			group.title.removeAttribute("tabindex");
			group.title.removeAttribute("role");
			group.title.removeAttribute("aria-haspopup");
		}
	}
	zone(parts.unassigned.el, Boolean(sidebar));
	parts.unassigned.title.hidden = !sectioned;
	// Without sections the list is not a group: nothing would name it but a hidden title.
	if (sectioned) {
		parts.unassigned.el.setAttribute("role", "group");
		parts.unassigned.el.setAttribute("aria-labelledby", parts.unassigned.title.id);
	} else {
		parts.unassigned.el.removeAttribute("role");
		parts.unassigned.el.removeAttribute("aria-labelledby");
	}
	reconcile(parts.unassigned.list, unassignedRows);
	// Collapsed, where section titles hide, a short line parts each group of agents from the
	// group above it: never under the Co-Founder, never around a section with no one in it.
	let above = pinnedElements.length > 0;
	for (const [element, count] of [
		...sectionGroups.map(({ group, rows: sectionRows }) => [group.el, sectionRows.length] as const),
		[parts.unassigned.el, unassignedRows.length] as const,
	]) {
		element.classList.toggle("rail-divided", above && count > 0);
		above ||= count > 0;
	}
	reconcile(parts.cofounderGroup, cofounderElement ? [cofounderElement] : []);
	reconcile(
		parts.list,
		[
			errorNotice("sessions", state.sessionsError, () =>
				button(t("Retry conversations"), () => void company.refreshSessions(), { small: true }),
			),
			// Group details are decoration (names and figures of a group chat) and are read
			// again with every conversation refresh. A failure never shows in the rail: the
			// text would name cloud machinery, and there is nothing for the member to do.
			errorNotice("company", state.error, () =>
				button(t("Retry company"), () => void company.refreshAll(), { small: true }),
			),
			errorNotice("rail", state.railError, () =>
				button(t("Dismiss"), () => company.reportRailError(undefined), { small: true }),
			),
			cofounderElement ? parts.cofounderGroup : null,
			// The pinned row stays in place while empty, hidden, so a drag can still reach it.
			sidebar && !railQuery ? parts.pinnedGroup : pinnedElements.length ? parts.pinnedGroup : null,
			parts.loading ?? null,
			// A section shows while it has rows, and always when nothing is being searched.
			...sectionGroups.filter(({ rows: r }) => r.length || !railQuery).map(({ group }) => group.el),
			unassignedRows.length || (sectioned && !railQuery) ? parts.unassigned.el : null,
			hiddenAgents.length ? hiddenGroup.el : null,
			empty ? parts.empty : null,
		].filter((element) => element !== null),
	);
	parts.rows = rows;
	parts.notices = notices;
	parts.drag.refresh();
	// A row moved to a new place loses focus on the way, so it gets it back too.
	if (focused && document.activeElement !== focused) {
		const replacement = focused.isConnected ? focused : successor;
		if (replacement) replacement.focus({ preventScroll: true });
		else {
			const now = focusables();
			(now[Math.min(index, now.length - 1)] ?? parts.input).focus();
		}
	}

	const connection = state.realtime === "connected" ? "" : JSON.stringify([state.realtime, state.realtimeError ?? ""]);
	if (connection !== parts.connectionShown) {
		parts.connection.hidden = !connection;
		replace(
			parts.connection,
			connection
				? badge(
						state.realtime === "connecting" ? t("connecting") : t("live updates degraded"),
						state.realtime === "connecting" ? "neutral" : "warn",
						state.realtimeError ?? "",
					)
				: null,
		);
		parts.connectionShown = connection;
	}
	// The account menu is shared with the top bar; it moves back only when it is not here.
	const menu = accountMenuElement(context, company);
	if (menu.parentElement !== parts.foot) parts.foot.append(menu);
	restoreFocus();
}

/* ---- The rail's menus and dragging --------------------------------------------------- */

const newSectionId = () => crypto.randomUUID();

function sameName(sidebar: CompanySidebar, name: string, except?: string) {
	return sidebar.sections.find(
		(section) => section.sectionId !== except && section.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
	);
}

/** Asks for a new section's name and makes it; with an agent, moves the agent into it
 * (a name that already exists moves the agent there instead). */
async function askSectionName(company: CompanyController, agentId?: string): Promise<void> {
	const name = await nameDialog({
		title: t("New section"),
		label: t("Section name"),
		confirm: t("Create"),
		maxLength: SECTION_NAME_LIMIT,
		signal: company.signal,
	});
	const sidebar = company.store.get().sidebar;
	if (!name || !sidebar) return;
	// A pinned agent leaves the pinned row for its section, as when it is dragged there;
	// a hidden one is shown again.
	const unpin = agentId && sidebar.pinned.includes(agentId) ? { unpin: true } : {};
	if (agentId && sidebar.hidden.includes(agentId))
		void company.changeSidebar({ action: "set_hidden", staffAgentId: agentId, hidden: false });
	const existing = sameName(sidebar, name);
	if (existing && agentId) {
		// Naming a section that exists moves the agent there.
		void company.changeSidebar({
			action: "move_agent",
			staffAgentId: agentId,
			sectionId: existing.sectionId,
			...unpin,
		});
		return;
	}
	if (existing) {
		company.reportRailError(t("A section called {name} already exists.", { name: `"${existing.name}"` }));
		return;
	}
	void company.changeSidebar({
		action: "create_section",
		sectionId: newSectionId(),
		name,
		...(agentId ? { staffAgentId: agentId, ...unpin } : {}),
	});
}

function canOrganize(company: CompanyController): boolean {
	const state = company.store.get();
	return Boolean(state.sidebar && !state.sidebarUnavailable && state.team?.capabilities.write);
}

function agentMenu(company: CompanyController, parts: RailParts, agent: HostedStaffAgent): MenuEntry[] {
	const state = company.store.get();
	const actions = parts.context?.agentActions;
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const isCofounder = agent.id === company.cofounderId();
	const canAuthorize = state.team?.capabilities.authorize === true;
	const groups: MenuEntry[][] = [];
	if (sidebar && !isCofounder) {
		const pinned = sidebar.pinned.includes(agent.id);
		// A pin list can still name an agent deleted since it was read; the cloud refuses those.
		const livePins = () => {
			const roster = company.sidebarRoster();
			return sidebar.pinned.filter((agentId) => roster.includes(agentId));
		};
		const first: MenuEntry[] = [];
		if (pinned)
			first.push({
				label: t("Unpin"),
				icon: "unpin",
				select: () =>
					void company.changeSidebar({
						action: "set_pins",
						order: livePins().filter((agentId) => agentId !== agent.id),
					}),
			});
		else if (sidebar.pinned.length < PIN_LIMIT)
			first.push({
				label: t("Pin"),
				icon: "pin",
				select: () => void company.changeSidebar({ action: "set_pins", order: [...livePins(), agent.id] }),
			});
		if (canOrganize(company)) {
			const known = new Set(sidebar.sections.map((section) => section.sectionId));
			const placed = sidebar.placements[agent.id]?.sectionId;
			const current = placed && known.has(placed) ? placed : undefined;
			// Choosing the section it is in keeps a row where it is; a pinned agent moves out
			// of the pinned row into the section it is given, as when it is dragged there.
			const isHidden = sidebar.hidden.includes(agent.id);
			const move = (sectionId: string | null) => () => {
				// A hidden agent given a section is shown again, where it was sent.
				if (isHidden) void company.changeSidebar({ action: "set_hidden", staffAgentId: agent.id, hidden: false });
				if (!pinned && (sectionId ?? undefined) === current) return;
				void company.changeSidebar({
					action: "move_agent",
					staffAgentId: agent.id,
					sectionId,
					...(pinned ? { unpin: true } : {}),
				});
			};
			first.push({
				kind: "submenu",
				label: t("Move to"),
				icon: "folder",
				items: [
					...sidebar.sections.map(
						(section): MenuEntry => ({
							label: section.name,
							icon: "folder",
							checked: section.sectionId === current,
							select: move(section.sectionId),
						}),
					),
					{ label: t("Unassigned"), icon: "folder", checked: current === undefined, select: move(null) },
					{ kind: "separator" },
					{ label: t("New section"), icon: "folder_plus", select: () => void askSectionName(company, agent.id) },
				],
			});
		}
		if (first.length) groups.push(first);
	}
	if (canAuthorize && actions?.updateAgent)
		groups.push([{ label: t("Rename"), icon: "edit", select: () => void renameAgent(company, parts, agent) }]);
	const sessionId = company.primarySessionFor(agent.id)?.sessionId;
	if (sessionId)
		groups.push([
			{
				label: t("Copy conversation ID"),
				icon: "copy",
				select: () => {
					const failed = () => company.reportRailError(t("The conversation ID could not be copied."));
					if (!navigator.clipboard) failed();
					else void navigator.clipboard.writeText(sessionId).catch(failed);
				},
			},
		]);
	const last: MenuEntry[] = [];
	if (sidebar && !isCofounder) {
		const isHidden = sidebar.hidden.includes(agent.id);
		last.push({
			label: isHidden ? t("Show in sidebar") : t("Hide from sidebar"),
			icon: isHidden ? "show" : "hide",
			select: () => void company.changeSidebar({ action: "set_hidden", staffAgentId: agent.id, hidden: !isHidden }),
		});
	}
	if (!isCofounder && canAuthorize && actions?.deleteAgent)
		last.push({
			label: t("Delete"),
			icon: "trash",
			danger: true,
			select: () => void deleteAgent(company, parts, agent),
		});
	if (last.length) groups.push(last);
	return groups.flatMap((group, index) => (index ? [{ kind: "separator" } as MenuEntry, ...group] : group));
}

async function renameAgent(company: CompanyController, parts: RailParts, agent: HostedStaffAgent): Promise<void> {
	const update = parts.context?.agentActions?.updateAgent;
	if (!update) return;
	const name = await nameDialog({
		title: t("Rename agent"),
		label: t("Agent name"),
		value: agent.displayName,
		confirm: t("Rename"),
		maxLength: 160,
		signal: company.signal,
	});
	const latest = company.staffById(agent.id);
	if (!name || !latest) return;
	try {
		await update(latest, { ...savedAgentDraft(latest), displayName: name }, company.signal);
		await company.refreshStaff();
	} catch {
		if (!company.signal.aborted)
			company.reportRailError(t("{name} could not be renamed.", { name: latest.displayName }));
	}
}

async function deleteAgent(company: CompanyController, parts: RailParts, agent: HostedStaffAgent): Promise<void> {
	const remove = parts.context?.agentActions?.deleteAgent;
	if (!remove) return;
	const confirmed = await confirmDialog(
		t(
			"Delete {name}? The agent leaves the company for everyone, with its conversations and routines. This cannot be undone.",
			{ name: agent.displayName },
		),
		t("Delete"),
		true,
		undefined,
		company.signal,
	);
	if (!confirmed) return;
	try {
		await remove(agent, company.signal);
		const route = parts.context?.route;
		// The deleted agent's page has nothing left to show.
		if (
			route?.name === "company" &&
			((route.section === "staff" && route.id === agent.id) ||
				(route.section === "chat" && route.id === company.primarySessionFor(agent.id)?.sessionId))
		)
			location.hash = `#/c/${company.profile.profileId}`;
		// The cloud closes the agent's conversations with it and drops it from every sidebar.
		await Promise.all([company.refreshStaff(), company.refreshSessions(), company.refreshSidebar()]);
	} catch (error) {
		if (company.signal.aborted) return;
		company.reportRailError(
			error instanceof Error && /projects this agent leads/i.test(error.message)
				? t("{name} could not be deleted. Hand over the projects it leads first.", { name: agent.displayName })
				: t("{name} could not be deleted.", { name: agent.displayName }),
		);
	}
}

function sectionMenu(company: CompanyController, sectionId: string): MenuEntry[] {
	const sidebar = company.store.get().sidebar;
	const section = sidebar?.sections.find((item) => item.sectionId === sectionId);
	if (!sidebar || !section || !canOrganize(company)) return [];
	return [
		{
			label: t("Rename section"),
			icon: "edit",
			select: async () => {
				const name = await nameDialog({
					title: t("Rename section"),
					label: t("Section name"),
					value: section.name,
					confirm: t("Rename"),
					maxLength: SECTION_NAME_LIMIT,
					signal: company.signal,
				});
				if (!name) return;
				const clash = sameName(company.store.get().sidebar ?? sidebar, name, sectionId);
				if (clash)
					company.reportRailError(t("A section called {name} already exists.", { name: `"${clash.name}"` }));
				else void company.changeSidebar({ action: "rename_section", sectionId, name });
			},
		},
		{ kind: "separator" },
		{
			label: t("Delete section"),
			icon: "trash",
			danger: true,
			select: async () => {
				if (
					await confirmDialog(
						t("Delete the section {name}? Its agents move to Unassigned, for everyone in the company.", {
							name: `"${section.name}"`,
						}),
						t("Delete section"),
						true,
						undefined,
						company.signal,
					)
				)
					void company.changeSidebar({ action: "delete_section", sectionId });
			},
		},
	];
}

/** Right-click anywhere in the rail list: an agent, a section's title, or the rail itself. */
function openRailMenu(company: CompanyController, parts: RailParts, event: MouseEvent): void {
	const target = event.target as Element;
	if (parts.drag.dragging) {
		event.preventDefault();
		return;
	}
	// Shift with a mouse right-click keeps the browser's own menu (Open in new tab, Copy link).
	// A menu opened from the keyboard carries no pointer position.
	if (event.shiftKey && (event.clientX || event.clientY)) return;
	const agentElement = target.closest<HTMLElement>("[data-agent-id], [data-cofounder-id]");
	const titleElement = target.closest<HTMLElement>(".rail-section-title[data-section-id]");
	let items: MenuEntry[] = [];
	let label = t("Sidebar");
	let opener: HTMLElement = parts.list;
	let findOpener: (() => HTMLElement | null) | undefined;
	if (agentElement) {
		const agent = company.staffById(agentElement.dataset.agentId ?? agentElement.dataset.cofounderId);
		if (agent) {
			items = agentMenu(company, parts, agent);
			label = t("{name} actions", { name: agent.displayName });
			opener = agentElement;
			// The row is rebuilt when the agent's state changes; focus goes back to the new one.
			findOpener = () =>
				parts.list.querySelector<HTMLElement>(`[data-agent-id="${agent.id}"], [data-cofounder-id="${agent.id}"]`);
		}
	} else if (titleElement?.dataset.sectionId) {
		const sectionId = titleElement.dataset.sectionId;
		items = sectionMenu(company, sectionId);
		label = t("{name} actions", { name: titleElement.textContent ?? t("Section") });
		opener = titleElement;
		findOpener = () => parts.list.querySelector<HTMLElement>(`.rail-section-title[data-section-id="${sectionId}"]`);
	} else if (!target.closest("a[href], button, input") && canOrganize(company)) {
		items = [{ label: t("New section"), icon: "folder_plus", select: () => void askSectionName(company) }];
	}
	// Nothing to offer: the browser's own menu stays.
	if (!items.length) return;
	event.preventDefault();
	const point = menuPoint(event, opener);
	openContextMenu({ label, x: point.x, y: point.y, items, opener, ...(findOpener ? { findOpener } : {}) });
}

/** A long press is the right-click of a touch screen (iOS Safari sends no contextmenu event). */
function pressToOpenMenu(list: HTMLElement, company: CompanyController, parts: RailParts): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let start: { x: number; y: number } | undefined;
	// When a press last opened a menu; never, at first, so the page's first 800 ms
	// (performance.now() counts from its start) do not swallow a right-click.
	let opened = Number.NEGATIVE_INFINITY;
	const clear = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	const signal = company.signal;
	list.addEventListener(
		"pointerdown",
		(event) => {
			if (event.pointerType !== "touch") return;
			clear();
			start = { x: event.clientX, y: event.clientY };
			const target = event.target as Element;
			timer = setTimeout(() => {
				timer = undefined;
				opened = performance.now();
				const synthetic = new MouseEvent("contextmenu", {
					clientX: start!.x,
					clientY: start!.y,
					bubbles: true,
					cancelable: true,
				});
				Object.defineProperty(synthetic, "target", { value: target });
				openRailMenu(company, parts, synthetic);
			}, 550);
		},
		{ signal },
	);
	list.addEventListener(
		"pointermove",
		(event) => {
			if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clear();
		},
		{ signal },
	);
	for (const type of ["pointerup", "pointercancel", "scroll"])
		list.addEventListener(type, clear, { signal, passive: true });
	// The browser's own long-press menu (Android) and the tap that ends the press do nothing more.
	list.addEventListener(
		"contextmenu",
		(event) => {
			if (performance.now() - opened < 800) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		},
		{ capture: true, signal },
	);
	list.addEventListener(
		"click",
		(event) => {
			if (performance.now() - opened < 800) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
		{ capture: true, signal },
	);
}

function dragHooks(company: CompanyController, parts: RailParts) {
	const sidebarOf = () => {
		const state = company.store.get();
		return state.sidebarUnavailable ? undefined : state.sidebar;
	};
	return {
		// The collapsed rail hides the search field and ignores its text.
		canDrag: (agentId: string) =>
			Boolean(sidebarOf()) &&
			(parts.collapsed || !parts.input.value.trim()) &&
			company.sidebarRoster().includes(agentId),
		accepts: (zone: string, agentId: string) => {
			const sidebar = sidebarOf();
			if (!sidebar) return false;
			if (zone === "pinned") return sidebar.pinned.includes(agentId) || sidebar.pinned.length < PIN_LIMIT;
			return canOrganize(company);
		},
		drop: ({ agentId, zone, order }: RailDrop) => {
			const sidebar = sidebarOf();
			if (!sidebar) return;
			const pinned = sidebar.pinned.includes(agentId);
			if (zone === "pinned") {
				if (order.join() !== sidebar.pinned.join()) void company.changeSidebar({ action: "set_pins", order });
				return;
			}
			const sectionId = zone === "unassigned" ? undefined : zone.slice("section:".length);
			// Dragged out of Hidden agents, the agent is shown again where it lands.
			const wasHidden = sidebar.hidden.includes(agentId);
			if (wasHidden) void company.changeSidebar({ action: "set_hidden", staffAgentId: agentId, hidden: false });
			// The rail shows no hidden or pinned agents; the new order keeps them where they stood.
			const roster = company.sidebarRoster();
			const before = containerOrder(sidebar, sectionId, roster);
			const next = before.filter((member) => member !== agentId);
			const following = order[order.indexOf(agentId) + 1];
			const at = following ? next.indexOf(following) : -1;
			next.splice(at < 0 ? next.length : at, 0, agentId);
			if (!pinned && !wasHidden && next.join() === before.join()) return;
			void company.changeSidebar({
				action: "move_agent",
				staffAgentId: agentId,
				sectionId: sectionId ?? null,
				order: next,
				...(pinned ? { unpin: true } : {}),
			});
		},
	};
}

/** Moves an agent one place up or down among what the member sees: in the pinned row
 * (the member's own order) or in its section (the company's; hidden and pinned agents
 * keep their places). */
function nudgeAgent(company: CompanyController, agentId: string, delta: number): void {
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	if (!sidebar) return;
	const roster = company.sidebarRoster();
	// Hidden agents keep no visible place to move from.
	if (sidebar.hidden.includes(agentId)) return;
	if (sidebar.pinned.includes(agentId)) {
		const order = sidebar.pinned.filter((pinned) => roster.includes(pinned));
		const from = order.indexOf(agentId);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= order.length) return;
		order.splice(from, 1);
		order.splice(to, 0, agentId);
		void company.changeSidebar({ action: "set_pins", order });
		return;
	}
	if (!canOrganize(company)) return;
	const known = new Set(sidebar.sections.map((section) => section.sectionId));
	const placed = sidebar.placements[agentId]?.sectionId;
	const sectionId = placed && known.has(placed) ? placed : undefined;
	const order = containerOrder(sidebar, sectionId, roster);
	const visible = order.filter((member) => !sidebar.pinned.includes(member) && !sidebar.hidden.includes(member));
	const neighbour = visible[visible.indexOf(agentId) + delta];
	if (!neighbour) return;
	order.splice(order.indexOf(agentId), 1);
	order.splice(order.indexOf(neighbour) + (delta > 0 ? 1 : 0), 0, agentId);
	void company.changeSidebar({ action: "move_agent", staffAgentId: agentId, sectionId: sectionId ?? null, order });
}
