import { type AppManifest, OWED_APPS } from "@qorpera/cloud-client/interface-apps";
import type { User } from "@supabase/supabase-js";
import {
	APP_GROUP_NAME_LIMIT,
	type AppTile,
	type AppTreeNode,
	appColours,
	appsIn,
	arrangeAppsFully,
	colourApp,
	drawerKey,
	EMPTY_APP_LAYOUT,
	emblemApp,
	fileKey,
	flattenApps,
	groupIdOf,
	groupKey,
	groupsOf,
	isGroupKey,
	type MemberAppLayout,
	makeAppGroup,
	nodeKey,
	placeApp,
	renameAppGroup,
	suggestGroupName,
	ungroupApps,
	withoutRefused,
} from "../../cloud/app-groups.ts";
import type { InterfacePageName } from "../../cloud/interface-pages.ts";
import type { MemberContactPlacing } from "../../cloud/member-chats.ts";
import { UUID_PATTERN } from "../../cloud/parse.ts";
import {
	type CompanySidebar,
	containerOrder,
	PIN_LIMIT,
	SECTION_NAME_LIMIT,
	type SidebarOwnChanges,
	type SidebarRequest,
} from "../../cloud/sidebar.ts";
import type { CompanySite } from "../../cloud/sites.ts";
import type { HostedProfile, HostedSession, HostedStaffAgent } from "../../cloud/types.ts";
import { AGENT_LOOK, type AgentLook, stateLine } from "../../ui/agent-activity.ts";
import { AppGridDrag, orderApps } from "../../ui/app-grid-drag.ts";
import { appLookPanel } from "../../ui/app-look-picker.ts";
import { agentColor, agentFigure, colourNameHex, figureFor, playFigure } from "../../ui/avatar.ts";
import { companyDisplayName, companyInSentence, showCompanyName } from "../../ui/company-name.ts";
import { type MenuEntry, menuPoint, openContextMenu, openMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { badge, button, confirmDialog, h, icon, initials, notice, personAvatar, replace } from "../../ui/dom.ts";
import { friendsCount } from "../../ui/friends-count.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { appIconEmblem, type Emblem, interfaceEmblem } from "../../ui/interface-emblem.ts";
import { matchesKey } from "../../ui/keys.ts";
import { easing, playOnce, reducedMotion } from "../../ui/motion.ts";
import { nameDialog } from "../../ui/name-dialog.ts";
import { attachPersonPicture, personPicturesEpoch } from "../../ui/person-pictures.ts";
import { phrase, presentationLocale, t, uiText } from "../../ui/preferences.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { RAIL_ITEM, RailDrag, type RailDrop, railItemId } from "../../ui/rail-drag.ts";
import { glideRows, measureRows } from "../../ui/rail-flip.ts";
import { RailSelection } from "../../ui/rail-selection.ts";
import { railListSkeleton } from "../../ui/skeleton.ts";
import { type IdleLine, idleLine } from "../agent-line.ts";
import { type AuthController, displayName } from "../auth.ts";
import { type AgentState, agentWorks, type CompanyController, isAgentPairSession } from "../company.ts";
import { type CompanyApp, companyConcepts } from "../interface-apps.ts";
import { interfaceBadge } from "../interface-badge.ts";
import { type CompanyInterface, companyInterfaces, hiddenInterfaces } from "../interfaces.ts";
import { contactPlaces, MEMBERS_ZONE, type RailContact, railContacts, weave } from "../rail-contacts.ts";
import { appHash, conceptsHash, type Route, siteHash, surfaceHash } from "../router.ts";
import {
	activeTaskSessions,
	hasConflictedChange,
	isOpenChange,
	isRunningSession,
	openExplorations,
	surfacesOf,
} from "../surfaces-store.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import type { AgentCardActions } from "./agent-details.ts";
import type { CardFootActions } from "./card-foot.ts";
import { personFace } from "./friends.ts";
import { memberPresence } from "./member-chat.ts";
import type { SettingsTab } from "./settings.ts";
import { CrewFigures, crewWave } from "./surface-crew.ts";
import { openCreateSurfaceSheet, openScheduleAgentSheet } from "./surface-migration-sheet.ts";
import { isActionChange, SurfaceRail } from "./surface-rail.ts";

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
	/** Friends, a window of its own beside the account (friends-window.ts). */
	openFriends: () => void;
	navigation?: { open: boolean; toggle: () => void };
	sidebar?: { hidden: boolean; toggle: () => void };
	/** What the rail's agent and group chat menus can do beyond the sidebar itself. */
	agentActions?: Pick<WorkspaceActions, "updateAgent" | "deleteAgent" | "updateGroup" | "deleteGroup">;
	/** A right-click on an agent opens its card beside the row; the rail adds Hide and Delete. */
	openAgentCard?: (
		agent: HostedStaffAgent,
		anchor: HTMLElement,
		card: AgentCardActions,
		findAnchor: () => HTMLElement | null,
	) => void;
	/** A right-click on a group chat opens its card the same way. */
	openGroupCard?: (
		session: HostedSession,
		anchor: HTMLElement,
		card: CardFootActions,
		findAnchor: () => HTMLElement | null,
	) => void;
	/** Hides a page (Mailbox, Members, Bank) from the member's own rail, or shows it again: a right-click on it, as on
	 * an agent (Jonas, 9 Nov 2026: each member's own, not the company's). */
	hideInterfacePage?: (page: InterfacePageName, hidden: boolean) => Promise<void>;
	/** Reads the member's pages again: after Reset sidebar, or its Undo, a hidden page may show or hide again. */
	refreshInterfacePages?: () => void;
}

/* The account menu is one long-lived element: the shell re-renders on every
 * store change, and rebuilding the menu would close it under the pointer. */
let accountMenu: HTMLElement | undefined;
let accountMenuOpen = false;
let accountTrigger: HTMLButtonElement | undefined;
/** The friends button left of the account (Jonas's sketch, 9 Nov 2026); it opens the Friends window. */
let accountFriends: HTMLButtonElement | undefined;
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
		accountFriends = h(
			"button",
			{
				type: "button",
				class: "account-friends",
				onclick: (event: MouseEvent) => {
					event.stopPropagation();
					setAccountMenuOpen(false);
					accountContext?.openFriends();
				},
			},
			icon("friends"),
		);
		accountMenu = h("div", { class: "account-menu" }, accountFriends, accountTrigger, accountPopover);
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
	// Friends and the company invitations waiting for this account share the Friends window.
	const friendsLabel =
		context.invitations > 0
			? t("Friends: {count} company invitations waiting", { count: context.invitations })
			: t("Friends");
	accountFriends!.setAttribute("aria-label", friendsLabel);
	accountFriends!.title = friendsLabel;
	replace(accountFriends!, icon("friends"), context.invitations > 0 ? friendsCount(context.invitations) : null);
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
		h(
			"button",
			{
				type: "button",
				class: "account-item",
				role: "menuitem",
				"data-account-action": "friends",
				onclick: () => {
					setAccountMenuOpen(false);
					accountContext?.openFriends();
				},
			},
			icon("friends"),
			h("span", { class: "account-item-label" }, uiText(phrase("Friends"))),
			context.invitations > 0 ? h("span", { class: "account-count" }, String(context.invitations)) : null,
		),
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
 * pinned-agent tile. Under it stand the member's pinned agents and group chats as
 * square cards, then the company's sections (Grok Bot's rail, 2026-09-24), then
 * Unassigned. Group chats are placed like agents (2026-09-27), among them. A
 * right-click on an agent or a group chat opens its menu (pin, move to a section,
 * rename, copy the conversation id, hide, delete); on a section, rename or delete it;
 * on the rail, make a new section. Agents and group chats drag between sections and
 * into or out of the pinned row. The company's other members are contacts (2026-11-10):
 * rows of the same kind, in a Members group at the foot of the list until their member
 * drags them among the agents or pins them, and hidden like an agent; where a contact
 * stands is each member's own (app/rail-contacts.ts). Search and creation share the
 * toolbar, with the account menu at the foot. Company management lives in settings. */

/* The rail's parts are built once per company: the toolbar with its search field,
 * the scrolling list and the foot. A store update changes what they show in place,
 * so the field is never moved (a dead-key or IME composition and the caret survive),
 * the list keeps its scroll position, and a row is rebuilt only when what it shows
 * has changed. */
interface RailParts {
	/** The company's name at the start of the top row; it opens the menu of the member's companies (Jonas, 5 Nov 2026). */
	readonly company: HTMLButtonElement;
	readonly companyName: HTMLElement;
	/** The four-windows button: it opens the company's interfaces as icons under the top row, and stays open until
	 * pressed again (Jonas, 5 Nov 2026; it replaced the Agents | Interfaces tabs). */
	readonly apps: HTMLButtonElement;
	readonly appsDrawer: HTMLElement;
	/** The company's owed views, one row above everything else in the drawer (company views step 4): its websites, then
	 * its products, money and ads apps where they exist. The member's arrangement does not reach them. */
	readonly appsOwed: HTMLElement;
	/** The owed row's tiles by key, each with the model it was drawn from. */
	owedRows: Map<string, { shown: string; element: HTMLElement }>;
	readonly appsGrid: HTMLElement;
	appsOpen: boolean;
	/** The route the drawer was last opened for: an interface's page opens it once. */
	appsRoute: string;
	interfaceRows: Map<string, { shown: string; element: HTMLElement }>;
	/** The member's own order of the drawer's icons, by key, as last dragged on this device (empty: the default). */
	appsOrder: readonly string[];
	/** The drawer's apps as arranged last (cloud/app-groups.ts): the tree, its tiles in the grid, the groups open on this
	 * device, each group's tile, and the keys the grid showed, so a change of them glides. */
	appTree: AppTreeNode[];
	appTiles: AppTile[];
	newProgram: HTMLElement | undefined;
	/** The member's places the arrangement refused; the next change leaves them out. */
	appRefused: ReadonlySet<string>;
	/** Each of the agents' apps in the drawer as it is drawn there, by the app's name (`appLook`). */
	appLooks: ReadonlyMap<string, AppLook>;
	appGroupsOpen: Set<string>;
	groupRows: Map<string, { shown: string; element: HTMLElement }>;
	appKeysShown: string | undefined;
	/** The group folding as the drawer is drawn next (its drawer key): its apps go back into its tile. */
	appFolding: string | undefined;
	/** Dragging the drawer's icons to reorder them. */
	readonly appsDrag: AppGridDrag;
	readonly toolbar: HTMLElement;
	readonly close: HTMLButtonElement;
	readonly sidebarToggle: HTMLButtonElement;
	readonly add: HTMLAnchorElement;
	/** The search folds out of its button over the name, and folds back on Esc or its close button. */
	readonly search: HTMLElement;
	readonly searchToggle: HTMLButtonElement;
	readonly searchClose: HTMLButtonElement;
	searchOpen: boolean;
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
	/** The company's other members, each a contact (this member's chat with them): those the member has not put
	 * elsewhere in the rail, after everything the company arranges. */
	readonly members: SectionParts;
	/** Grok Bot's "Hidden Bots": this member's hidden agents and contacts, folded at the foot of the list. */
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
	/** The highlight that slides to the conversation opened (ui/rail-selection.ts). */
	readonly selection: RailSelection;
	/** Where every agent and conversation the company has listed leads: a row that comes back
	 * (a search cleared, Hidden opened, a pin) is not new, so only a link never seen arrives. */
	readonly known: Set<string>;
	/** The company has finished loading once: only changes after that are animated. */
	settled: boolean;
	/** Mentions had been read at the last draw, so a mention now is news. */
	mentionsRead: boolean;
	/** The latest draw's context: the menus and the drag act on it. */
	context?: ShellContext;
	readonly drag: RailDrag;
	redraw: () => void;
}
interface HiddenParts {
	readonly el: HTMLElement;
	readonly toggle: HTMLButtonElement;
	readonly label: HTMLElement;
	/** How many messages wait from contacts in the fold: a hidden contact is still heard. */
	readonly unread: HTMLElement;
	readonly count: HTMLElement;
	readonly chevron: HTMLElement;
	readonly list: HTMLElement;
	open: boolean;
}
const HIDDEN_OPEN_KEY = "qorpera.web.rail-hidden-open";
const APPS_OPEN_KEY = "qorpera.web.rail-apps-open";
/** The drawer's order is kept per company on this device, as whether it is open is (Jonas, 9 Nov 2026). */
const APPS_ORDER_KEY = "qorpera.web.rail-apps-order";
function storedAppsOrder(profileId: string): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(`${APPS_ORDER_KEY}:${profileId}`) ?? "[]");
		return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
	} catch {
		return [];
	}
}
/** Which of the drawer's groups are open is kept per company on this device (Jonas, 11 Nov 2026). */
const APP_GROUPS_OPEN_KEY = "qorpera.web.rail-app-groups-open";
function storedGroupsOpen(profileId: string): Set<string> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(`${APP_GROUPS_OPEN_KEY}:${profileId}`) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}
function storeGroupsOpen(profileId: string, open: ReadonlySet<string>): void {
	try {
		localStorage.setItem(`${APP_GROUPS_OPEN_KEY}:${profileId}`, JSON.stringify([...open]));
	} catch {
		/* The choice lasts this view. */
	}
}
function storeAppsOrder(profileId: string, order: readonly string[]): void {
	try {
		localStorage.setItem(`${APPS_ORDER_KEY}:${profileId}`, JSON.stringify(order));
	} catch {
		/* The order lasts this view. */
	}
}

function storedAppsOpen(profileId: string): boolean {
	try {
		return localStorage.getItem(`${APPS_OPEN_KEY}:${profileId}`) === "1";
	} catch {
		return false;
	}
}
function hiddenParts(redraw: () => void): HiddenParts {
	let open = false;
	try {
		open = localStorage.getItem(HIDDEN_OPEN_KEY) === "1";
	} catch {
		/* Storage may be unavailable; the group starts folded. */
	}
	const label = h("span", { class: "rail-hidden-label" });
	const unread = h("span", { class: "rail-hidden-unread", "aria-hidden": "true", hidden: true });
	const count = h("span", { class: "rail-hidden-count" });
	const chevron = h("span", { class: "rail-hidden-chevron", "aria-hidden": "true" }, icon("chevron-down"));
	const list = h("div", { class: "rail-section-list rail-hidden-list", id: "rail-hidden-list" });
	const toggle = h(
		"button",
		{ type: "button", class: "rail-hidden-toggle", "aria-controls": "rail-hidden-list" },
		label,
		unread,
		count,
		chevron,
	);
	const parts: HiddenParts = {
		el: h("div", { class: "rail-hidden" }, toggle, list),
		toggle,
		label,
		unread,
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
/** A row built anew, once the company has loaded, says what changed (styles/motion.css): an
 * agent that starts work gets its dot and its line, a failed run folds the figure into a red
 * "!" (and unfolds it when the failure is dealt with), a mention's badge pops, finished work makes the figure cheer, and an agent the
 * company never listed before is placed like a card (a new chat drops in). */
function changedRow(
	before: string | undefined,
	after: string,
	element: HTMLElement,
	unseen: boolean,
	mentionsRead: boolean,
): void {
	if (before === undefined) {
		if (unseen) playOnce(element, element.dataset.agentId ? "is-hired" : "is-arriving");
		return;
	}
	const was = JSON.parse(before) as Partial<AgentModel>;
	const now = JSON.parse(after) as Partial<AgentModel>;
	if (was.state !== now.state)
		playOnce(
			element,
			now.state === "failed"
				? "state-failed"
				: was.state === "failed"
					? "state-recovered"
					: now.state === "working" || now.state === "computer"
						? "state-working"
						: "state-changed",
		);
	if (mentionsRead && !was.mentioned && now.mentioned) playOnce(element, "mention-arrived");
	// Its work is done: the figure cheers.
	if (was.state && agentWorks(was.state) && now.state === "idle")
		playFigure(element.querySelector(".figure"), "cheer");
}

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
		const input = h("input", { type: "search", autocomplete: "off", spellcheck: "false", id: "rail-search-input" });
		const searchToggle = h(
			"button",
			{ type: "button", class: "rail-search-toggle", "aria-controls": "rail-search-input" },
			icon("search"),
		);
		const searchClose = h("button", { type: "button", class: "rail-search-close" }, icon("close"));
		const search = h("div", { class: "rail-search" }, searchToggle, input, searchClose);
		const close = h("button", { type: "button", class: "icon-button rail-mobile-close" }, icon("close"));
		const sidebarToggle = h(
			"button",
			{
				type: "button",
				class: "icon-button rail-sidebar-toggle",
				"aria-controls": "company-navigation",
				"aria-expanded": "true",
				hidden: true,
			},
			icon("navigation"),
		);
		const add = h("a", { class: "rail-add icon-button", href: `#/c/${company.profile.profileId}/new` }, icon("plus"));
		const connection = h("div", { class: "rail-connection", role: "status", hidden: true });
		const list = h("div", { class: "rail-scroll", id: "rail-list-agents" });
		const companyName = h("span", { class: "rail-company-name" });
		const companyButton = h(
			"button",
			{ type: "button", class: "rail-company", "aria-haspopup": "menu", "aria-expanded": "false" },
			companyName,
			h("span", { class: "rail-company-chevron", "aria-hidden": "true" }, icon("chevron-down")),
		);
		const apps = h(
			"button",
			{
				type: "button",
				class: "rail-apps icon-button",
				"aria-controls": "rail-apps-drawer",
				"aria-expanded": "false",
			},
			icon("grid"),
			h("span", { class: "rail-apps-dot", "aria-hidden": "true" }),
		);
		const appsGrid = h("div", { class: "rail-apps-grid" });
		const appsOwed = h("div", { class: "rail-apps-owed", hidden: true });
		const appsDrawer = h(
			"div",
			{ class: "rail-apps-drawer", id: "rail-apps-drawer", role: "group" },
			h("div", null, appsOwed, appsGrid),
		);
		const created: RailParts = {
			company: companyButton,
			companyName,
			apps,
			appsDrawer,
			appsOwed,
			owedRows: new Map(),
			appsGrid,
			appsOpen: storedAppsOpen(company.profile.profileId),
			appsRoute: "",
			interfaceRows: new Map(),
			appsOrder: storedAppsOrder(company.profile.profileId),
			appTree: [],
			appTiles: [],
			newProgram: undefined,
			appRefused: new Set(),
			appLooks: new Map(),
			appGroupsOpen: storedGroupsOpen(company.profile.profileId),
			groupRows: new Map(),
			appKeysShown: undefined,
			appFolding: undefined,
			appsDrag: undefined as unknown as AppGridDrag,
			toolbar: h("div", { class: "rail-toolbar" }, close, companyButton, apps, search, add, sidebarToggle),
			close,
			sidebarToggle,
			add,
			search,
			searchToggle,
			searchClose,
			searchOpen: false,
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
			members: sectionParts(MEMBERS_ZONE),
			hiddenGroup: hiddenParts(() => created.redraw()),
			loading: undefined,
			empty: h("p", { class: "rail-empty" }),
			rows: new Map(),
			notices: new Map(),
			locale: "",
			connectionShown: "",
			collapsed: false,
			selection: new RailSelection(),
			known: new Set(),
			settled: false,
			mentionsRead: false,
			drag: undefined as unknown as RailDrag,
			redraw,
		};
		created.members.el.classList.add("rail-members");
		(created as { drag: RailDrag }).drag = new RailDrag(list, () => dragHooks(company, created), company.signal);
		// The drawer's icons reorder by dragging (or Alt with an arrow); the order is the member's own, on this device.
		(created as { appsDrag: AppGridDrag }).appsDrag = new AppGridDrag(
			appsGrid,
			() => {
				const arranges = appsArrangeable(company);
				return {
					// While a reset is on its way nothing moves: what it brings back decides the order.
					canDrag: () => created.appsOpen && !created.apps.inert && !company.resettingSidebar(),
					drop: (order: string[], moved: string) => {
						// Where the cloud keeps the member's own arrangement, a move is a change of it; before, the order
						// is kept on this device.
						if (arranges) {
							moveInDrawer(company, created, order, moved);
							return;
						}
						created.appsOrder = order;
						storeAppsOrder(company.profile.profileId, order);
					},
					// Whatever changed while an icon was lifted draws now, the order kept or not.
					end: () => created.redraw(),
					...(arranges
						? {
								canMerge: (dragged: string, onto: string) => canMergeApps(created, dragged, onto),
								merge: (dragged: string, onto: string) => mergeApps(company, created, dragged, onto),
							}
						: {}),
				};
			},
			company.signal,
		);
		// A group's tile opens it into the grid, or folds it again (a drag's release is no click: the drag eats it).
		appsGrid.addEventListener(
			"click",
			(event) => {
				const tile = (event.target as Element).closest<HTMLElement>(".rail-app-group[data-app-key]");
				if (!tile) return;
				event.preventDefault();
				toggleAppGroup(company, created, groupIdOf(tile.dataset.appKey!));
			},
			{ signal: company.signal },
		);
		// The four windows open or close the interfaces; the choice is kept for this company on this device.
		apps.addEventListener(
			"click",
			() => {
				setAppsOpen(created, company.profile.profileId, !created.appsOpen);
				created.redraw();
			},
			{ signal: company.signal },
		);
		// The name opens the member's companies, this one checked, and New company under them. A press on the name
		// while its menu is open only closes it: the menu shuts on the press, before the click, so the press is noted
		// first (this listener is older than the menu's) and its click skipped.
		let pressClosesMenu = false;
		document.addEventListener(
			"pointerdown",
			(event) => {
				pressClosesMenu =
					companyButton.getAttribute("aria-expanded") === "true" &&
					event.target instanceof Node &&
					companyButton.contains(event.target);
			},
			{ capture: true, signal: company.signal },
		);
		companyButton.addEventListener(
			"click",
			() => {
				if (pressClosesMenu) {
					pressClosesMenu = false;
					return;
				}
				if (openMenu()?.el.isConnected && companyButton.getAttribute("aria-expanded") === "true") return;
				const box = companyButton.getBoundingClientRect();
				const profiles = created.context?.profiles ?? [company.profile];
				companyButton.setAttribute("aria-expanded", "true");
				openContextMenu({
					label: t("Your companies"),
					x: box.left,
					y: box.bottom + 4,
					opener: companyButton,
					onClose: () => companyButton.setAttribute("aria-expanded", "false"),
					items: [
						...profiles.map(
							(profile): MenuEntry => ({
								label: companyDisplayName(profile.profileName),
								checked: profile.profileId === company.profile.profileId,
								select: () => {
									if (profile.profileId !== company.profile.profileId)
										location.hash = `#/c/${profile.profileId}`;
								},
							}),
						),
						{ kind: "separator" },
						{
							label: t("New company"),
							icon: "plus",
							select: () => {
								location.hash = "#/new";
							},
						},
					],
				});
			},
			{ signal: company.signal },
		);
		let pressClosesAdd = false;
		document.addEventListener(
			"pointerdown",
			(event) => {
				pressClosesAdd =
					add.getAttribute("aria-expanded") === "true" &&
					event.target instanceof Node &&
					add.contains(event.target);
			},
			{ capture: true, signal: company.signal },
		);
		add.addEventListener(
			"click",
			(event) => {
				const store = surfacesOf(company);
				if (!store) return;
				event.preventDefault();
				if (pressClosesAdd) {
					pressClosesAdd = false;
					return;
				}
				if (openMenu()?.el.isConnected && add.getAttribute("aria-expanded") === "true") return;
				const box = add.getBoundingClientRect();
				add.setAttribute("aria-expanded", "true");
				openContextMenu({
					label: t("Create"),
					x: box.left,
					y: box.bottom + 4,
					opener: add,
					onClose: () => add.setAttribute("aria-expanded", "false"),
					items: [
						{
							label: t("New surface"),
							icon: "grid",
							select: () => openCreateSurfaceSheet(store, company.profile.profileId),
						},
						{
							label: t("New scheduled agent"),
							icon: "clock",
							select: () => openScheduleAgentSheet(store),
						},
						{ kind: "separator" },
						{
							label: t("New conversation"),
							icon: "plus",
							select: () => {
								location.hash = `#/c/${company.profile.profileId}/new`;
							},
						},
					],
				});
			},
			{ signal: company.signal },
		);
		// The search button opens the field over the name. Esc or the close button folds it back, clears it and
		// hands focus back to the button; so does leaving it empty.
		const openSearch = () => {
			if (!created.searchOpen) {
				created.searchOpen = true;
				created.redraw();
			}
			input.focus();
		};
		const closeSearch = (refocus: boolean) => {
			if (!created.searchOpen) return;
			created.searchOpen = false;
			if (input.value) {
				input.value = "";
				created.list.scrollTop = 0;
			}
			created.redraw();
			if (refocus) searchToggle.focus();
		};
		searchToggle.addEventListener("click", openSearch, { signal: company.signal });
		searchClose.addEventListener("click", () => closeSearch(true), { signal: company.signal });
		// A press on either button keeps focus where it is (Safari and Firefox never focus a pressed button, so focus
		// would otherwise fall to the page as the field folds); the click does the rest.
		for (const button of [searchToggle, searchClose]) {
			button.addEventListener("mousedown", (event) => event.preventDefault(), { signal: company.signal });
		}
		// Esc folds the search from anywhere in it, never while a composition is open.
		search.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Escape" || event.isComposing || !created.searchOpen) return;
				event.preventDefault();
				event.stopPropagation();
				closeSearch(true);
			},
			{ signal: company.signal },
		);
		search.addEventListener(
			"focusout",
			(event) => {
				const next = event.relatedTarget;
				if ((next instanceof Node && search.contains(next)) || input.value.trim()) return;
				closeSearch(false);
			},
			{ signal: company.signal },
		);
		list.addEventListener("contextmenu", (event) => openRailMenu(company, created, event), {
			signal: company.signal,
		});
		pressToOpenMenu(list, company.signal, (event) => openRailMenu(company, created, event));
		// A right-click on a page in the drawer hides it, as on an agent.
		appsDrawer.addEventListener("contextmenu", (event) => openDrawerMenu(company, created, event), {
			signal: company.signal,
		});
		pressToOpenMenu(appsDrawer, company.signal, (event) => openDrawerMenu(company, created, event));
		// Dragging has a keyboard twin: Alt with an arrow moves the focused agent, group chat or contact one place.
		list.addEventListener(
			"keydown",
			(event) => {
				const delta = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
				const element = event.target as HTMLElement;
				const item = railItemOf(element);
				if (!event.altKey || !delta || !item) return;
				event.preventDefault();
				nudgeItem(company, created, element, item, delta);
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
		parts.company.title = t("Your companies");
		parts.apps.setAttribute("aria-label", t("Apps"));
		parts.apps.title = t("Apps");
		parts.appsDrawer.setAttribute("aria-label", t("Apps"));
		parts.interfaceRows = new Map();
		parts.pinnedGroup.setAttribute("aria-label", t("Pinned"));
		parts.members.title.textContent = t("Members");
		const slot = parts.pinnedGroup.querySelector<HTMLElement>(".rail-drop-slot");
		if (slot) slot.textContent = t("Drop here to pin");
		parts.unassigned.title.textContent = t("Unassigned");
		parts.hiddenGroup.label.textContent = t("Hidden");
		parts.searchClose.setAttribute("aria-label", t("Close search"));
		parts.searchClose.title = t("Close search");
		parts.close.setAttribute("aria-label", t("Close company navigation"));
		parts.sidebarToggle.setAttribute("aria-label", t("Hide sidebar"));
		parts.sidebarToggle.title = t("Hide sidebar");
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
	// A failed run: the figure gives way to a red "!" until the failure is dealt with (styles/motion.css).
	if (look.disc === "failed") return h("span", { class: "alert-mark", "aria-hidden": "true" });
	return h("span", { class: className, "aria-hidden": "true" });
}

/** The link's name. No tooltip: the row already shows the name, and a hover
 * popup over every row was noise (Jonas, 9 Nov 2026). Any state also goes into the name,
 * which the compact rail needs: it hides the text beside the figure and the disc says
 * nothing aloud. What the agent waits on the member for is said too, while it works as
 * well, since the symbol the figure becomes says nothing aloud either. */
function railLabel(
	agent: Pick<AgentModel, "displayName" | "state" | "waiting" | "decisions"> & { mentioned?: boolean },
	look: AgentLook,
	idle?: IdleLine,
): { "aria-label": string } {
	// AGENT_LOOK keeps the English words; they are translated where they are drawn. A row's idle line, already in the
	// member's words, says the rest.
	const words = look.note ?? look.line;
	// Stopped at the member: what for takes the place of "Needs you"; with no words, "Needs you" says it alone.
	const decision = agent.state === "decision";
	const what = agent.waiting?.what;
	const waiting = what
		? t("Waiting for you: {what}", { what })
		: agent.waiting && !decision
			? t("Waiting for you")
			: undefined;
	const state = decision && what ? undefined : words ? t(words) : idle?.text;
	const mention = agent.mentioned ? t("You were mentioned") : undefined;
	const decisions = !agent.decisions
		? undefined
		: agent.decisions === 1
			? t("1 decision waits for you")
			: t("{count} decisions wait for you", { count: String(agent.decisions) });
	return { "aria-label": [agent.displayName, state, waiting, decisions, mention].filter(Boolean).join(" · ") };
}

/** An agent's figure on its stand in the rail: alive (it blinks and moves when left alone; the pointer over its row
 * moves nothing: Jonas, 13 Nov 2026, "It shouldn't be doing anything"), and asking when its
 * work waits on this member. Stopped at them, the figure becomes a "?" for a question to answer and a "!" for
 * anything else (an approval, a secret, a takeover, a draft, a decision with no words); working on something
 * else meanwhile, it comes back as that symbol between its spells of work. Its words are in the link's name. */
function railFigure(model: AgentModel, size: number, look: AgentLook): HTMLElement {
	const ask = model.waiting ? (model.waiting.kind === "question" ? "question" : "bang") : undefined;
	return agentFigure(model, model.displayName, {
		size,
		activity: look.figure,
		alive: true,
		ask: ask ?? (model.state === "decision" ? "bang" : undefined),
	});
}

/** "@" on a conversation where someone mentioned this member and they have not looked yet. */
function mentionBadge(mentioned: boolean | undefined): HTMLElement | null {
	return mentioned ? h("span", { class: "rail-mention", "aria-hidden": "true" }, "@") : null;
}

/* Each rail row is built from its model alone, and the model is also what decides
 * whether the row is rebuilt: whatever a row shows is in its key by construction.
 * Which row is current is set in place instead, since it changes with every navigation. */
interface AgentModel extends Pick<HostedStaffAgent, "id" | "displayName" | "templateId" | "appearance"> {
	state: AgentState;
	/** Someone mentioned this member in the agent's thread and they have not looked yet. */
	mentioned: boolean;
	/** The row's line while the agent does not work and needs no one (app/agent-line.ts), in the member's words. */
	idle?: IdleLine;
	/** Its work waits on this member (CompanyController.waitingFor): the newest item in a few words and its kind,
	 * when the cloud says. */
	waiting?: { what?: string; kind?: string };
	decisions?: number;
}
interface SessionModel {
	title: string;
	subtitle: string;
	kind: "Group chat" | "company";
	agents: HostedStaffAgent[];
	selected: boolean;
	/** A group chat's room: its row has a menu and, where the cloud places group chats, drags. */
	roomId?: string;
	mentioned: boolean;
}
function cofounderCard(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	return h(
		"a",
		{
			class: "cofounder-home",
			href,
			draggable: "false",
			"data-cofounder-id": model.id,
			...railLabel(model, look),
		},
		h(
			"span",
			{ class: "cofounder-stand" },
			railFigure(model, 82, look),
			statusDisc(look, "cofounder-status"),
			mentionBadge(model.mentioned),
			model.decisions
				? h("span", { class: "rail-decisions", "aria-hidden": "true" }, String(model.decisions))
				: null,
		),
		h("strong", null, model.displayName),
	);
}

/** A pinned group chat: the same square card, with the group's figures. */
function groupPinCard(model: SessionModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-pin rail-pin-group",
			href,
			draggable: "false",
			"data-room-id": model.roomId,
			"aria-label": [model.title, model.subtitle, model.mentioned ? t("You were mentioned") : ""]
				.filter(Boolean)
				.join(" · "),
		},
		h(
			"span",
			{ class: "rail-pin-stand" },
			groupChatAvatar(model.agents, { width: 62, height: 57, selected: model.selected }),
			mentionBadge(model.mentioned),
		),
		h("strong", { class: "rail-pin-name" }, model.title),
	);
}

/** A pinned agent: a square card with the figure over the name, as in Grok Bot. */
function pinCard(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	return h(
		"a",
		{
			class: "rail-pin",
			href,
			draggable: "false",
			"data-agent-id": model.id,
			style: `--agent-color: ${agentColor(model)}`,
			...railLabel(model, look),
		},
		h(
			"span",
			{ class: "rail-pin-stand" },
			railFigure(model, 52, look),
			statusDisc(look, "rail-row-status"),
			mentionBadge(model.mentioned),
		),
		h("strong", { class: "rail-pin-name" }, model.displayName),
	);
}

function agentRow(model: AgentModel, href: string): HTMLElement {
	const look = AGENT_LOOK[model.state];
	// Stopped at this member: what for, in the warning colour. A decision with no words (a proposal, a stopped run)
	// keeps "Needs you", in the same colour.
	const decision = model.state === "decision";
	const what = decision ? model.waiting?.what : undefined;
	const live = what ? t("Stopped: {what}", { what }) : stateLine(look);
	const line = live ?? model.idle?.text;
	const tone = decision ? "waiting" : live ? undefined : model.idle?.tone;
	return h(
		"a",
		{
			class: "rail-row rail-row-agent",
			href,
			draggable: "false",
			"data-agent-id": model.id,
			style: `--agent-color: ${agentColor(model)}`,
			...railLabel(model, look, model.idle),
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			railFigure(model, 50, look),
			statusDisc(look, "rail-row-status"),
			mentionBadge(model.mentioned),
		),
		h(
			"span",
			{ class: "rail-row-copy" },
			h("strong", null, model.displayName),
			line ? h("small", tone ? { class: `rail-row-line is-${tone}` } : null, line) : null,
		),
	);
}

/** Another member of the company, as a contact: their face where an agent has a figure, green-dotted while they are
 * online, with how many of their messages wait. Under the name stands their newest unread message, else whether they
 * are online or when they last were. A row wherever an agent would be a row; in the pinned row a square card, the face
 * over the first name. */
interface MemberModel {
	userId: string;
	name: string;
	online: boolean;
	line: string;
	unread: number;
	/** Something waits: the count pops when it arrives, as a mention's badge does. */
	mentioned: boolean;
}
function memberRow(model: MemberModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-row rail-row-member",
			href,
			draggable: "false",
			"data-member-id": model.userId,
			"aria-label": memberLabel(model),
		},
		h(
			"span",
			{ class: "rail-row-stand" },
			personFace(model.name, model.userId, model.online),
			countBadge(model.unread),
		),
		h(
			"span",
			{ class: "rail-row-copy" },
			h("strong", null, model.name),
			model.line ? h("small", null, model.line) : null,
		),
	);
}

function memberLabel(model: MemberModel): string {
	return [model.name, model.line, model.unread ? t("Unread: {count}", { count: model.unread }) : ""]
		.filter(Boolean)
		.join(" · ");
}
function memberCard(model: MemberModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-pin rail-pin-member",
			href,
			draggable: "false",
			"data-member-id": model.userId,
			"aria-label": memberLabel(model),
		},
		h(
			"span",
			{ class: "rail-pin-stand" },
			personFace(model.name, model.userId, model.online),
			countBadge(model.unread),
		),
		h("strong", { class: "rail-pin-name" }, model.name.trim().split(/\s+/)[0] ?? model.name),
	);
}

function sessionRow(model: SessionModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: model.kind === "Group chat" ? "rail-row rail-row-group" : "rail-row",
			href,
			"aria-label": [model.title, model.subtitle, model.mentioned ? t("You were mentioned") : ""]
				.filter(Boolean)
				.join(" · "),
			...(model.roomId ? { draggable: "false", "data-room-id": model.roomId } : {}),
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
	// A lifted row keeps the rail still: the rows make way for it by hand (ui/rail-drag.ts), and what changed
	// meanwhile draws when it is let go.
	if (parts.drag.dragging) return;
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
	const interfacesShown = companyInterfaces(company);
	// The agents' apps that are posted for every member (RUNTIME-INTERFACE-APPS.md §4), after the platform's pages. The
	// concepts of the company's product are one Concepts entry instead, posted or not (Jonas, 8 November 2026).
	// While What's new shows, an agent's own app of that name stays out: two pages of one name (own code storage step 4).
	// The company's owed views stand first, in a row of their own (company views step 4): out of the rest.
	const owed = owedViews(state.siteList ?? [], state.apps ?? [], state.sitesTakenDown);
	const postedApps = (state.apps ?? []).filter(
		(app) =>
			app.manifest?.posted === true &&
			!app.manifest.concept &&
			!(state.whatsNew && app.name === "whats-new") &&
			!owed.apps.includes(app),
	);
	const concepts = companyConcepts(state.apps ?? []).length;
	// The websites the company's agents published: one Sites entry while there are any (Jonas, 9 Nov 2026).
	const sites = state.siteCount ?? 0;
	const hasApps =
		interfacesShown.length > 0 ||
		postedApps.length > 0 ||
		concepts > 0 ||
		sites > 0 ||
		state.whatsNew !== undefined ||
		owed.websites.length > 0 ||
		owed.apps.length > 0;
	// An interface's page opens the drawer once, so the page it shows stands lit; after that the member's press decides.
	const routeKey = route.name === "company" ? `${route.section}/${route.id ?? ""}` : "";
	if (routeKey !== parts.appsRoute) {
		parts.appsRoute = routeKey;
		if (
			(section === "interface" ||
				section === "app" ||
				section === "sites" ||
				section === "whats-new" ||
				section === "site" ||
				section === "new-program") &&
			!parts.appsOpen
		)
			setAppsOpen(parts, profileId, true);
	}
	const appsOpen = hasApps && parts.appsOpen;
	parts.apps.hidden = !hasApps;
	parts.apps.setAttribute("aria-expanded", String(appsOpen));
	parts.apps.classList.toggle("is-open", appsOpen);
	parts.appsDrawer.hidden = !hasApps;
	parts.appsDrawer.classList.toggle("is-open", appsOpen);
	// Closed, its icons can't be reached.
	parts.appsDrawer.inert = !appsOpen;
	// WHY: Surfaces lists Inbox, Money, Members and Databases in the rail itself; the old icon drawer above the
	// Co-Founder duplicated them, so a surface-first rail folds it (and its grid button) away visually.
	container.classList.toggle("has-surface-rail", surfacesOf(company) !== undefined);
	showCompanyName(parts.companyName, company.profile.profileName);
	// Text in the field keeps it open, so a query never filters from a folded field.
	if (parts.input.value) parts.searchOpen = true;
	parts.toolbar.classList.toggle("is-searching", parts.searchOpen);
	const searchLabel = t("Search agents");
	parts.input.placeholder = searchLabel;
	parts.input.setAttribute("aria-label", searchLabel);
	parts.input.tabIndex = parts.searchOpen ? 0 : -1;
	parts.searchToggle.setAttribute("aria-label", searchLabel);
	parts.searchToggle.title = searchLabel;
	parts.searchToggle.setAttribute("aria-expanded", String(parts.searchOpen));
	// Open, the button only points back at the field, so it leaves the Tab order.
	parts.searchToggle.tabIndex = parts.searchOpen ? -1 : 0;
	parts.searchClose.hidden = !parts.searchOpen;
	reconcile(container, [parts.toolbar, parts.appsDrawer, parts.list, parts.foot]);
	parts.selection.measure(parts.list);
	const places = measureRows(parts.list);
	parts.collapsed = isCollapsed(container);
	// The open field covers the name and the four windows, so they take no clicks or focus; the collapsed rail shows
	// the four windows, not the field.
	parts.company.inert = parts.searchOpen && !parts.collapsed;
	parts.apps.inert = parts.searchOpen && !parts.collapsed;
	const railQuery = parts.collapsed ? "" : parts.input.value.trim().toLowerCase();
	const matches = (text: string) => !railQuery || text.toLowerCase().includes(railQuery);
	parts.close.hidden = !context.navigation;
	parts.close.onclick = context.navigation?.toggle ?? null;
	parts.sidebarToggle.hidden = !context.sidebar;
	parts.sidebarToggle.setAttribute("aria-expanded", String(!context.sidebar?.hidden));
	parts.sidebarToggle.onclick = context.sidebar?.toggle ?? null;
	parts.add.hidden = state.team?.capabilities.write === false;
	if (section === "new") parts.add.setAttribute("aria-current", "page");
	else parts.add.removeAttribute("aria-current");

	drawInterfaces(parts, company, interfacesShown, postedApps, concepts, sites, route);
	drawOwed(parts, company, owed, route);
	parts.context = context;
	const active = state.staff.filter((agent) => agent.employmentStatus === "active");
	const cofounderId = company.cofounderId();
	const cofounder = cofounderId ? company.staffById(cofounderId) : undefined;
	// Keyboard focus in the list stays on its element. A rebuilt row hands it to the row
	// built in its place; an element that left hands it to whatever now stands where it stood.
	const focusables = () => [
		...parts.list.querySelectorAll<HTMLElement>("a[href], a[data-href], button, [tabindex='0']"),
	];
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
		if (entry !== kept && parts.settled)
			changedRow(kept?.shown, shown, entry.element, !parts.known.has(href), parts.mentionsRead);
		rows.set(key, entry);
		entry.element.classList.toggle("active", current);
		if (current) entry.element.setAttribute("aria-current", "page");
		else entry.element.removeAttribute("aria-current");
		return entry.element;
	};
	const mentionedIn = (sessionId: string | undefined) => Boolean(sessionId && state.mentions?.[sessionId]);
	const agentModel = (agent: HostedStaffAgent): AgentModel => {
		// A figure or colour just picked on the agent's card shows here before its save lands.
		const look = state.looks?.[agent.id];
		const shown = look
			? { ...agent, appearance: { ...agent.appearance, creature: look.figure, color: look.color } }
			: agent;
		const figure = figureFor(shown);
		const activity = company.agentState(agent.id);
		const waiting = company.waitingFor(agent.id);
		return {
			id: agent.id,
			displayName: agent.displayName,
			templateId: agent.templateId,
			// Resolved, so the pick and the roster's words for it once saved (a colour's name, no colour for the
			// figure's own shade) are one cache key, and the row is kept when the save lands.
			appearance: { color: agentColor(shown, figure), shape: "", creature: figure },
			// State is part of the cache key, including idle/failed transitions with the same figure.
			state: activity,
			...(activity === "idle" || activity === "failed"
				? {
						idle: idleLine({
							failed: activity === "failed",
							restingUntil: company.pausedRunFor(agent.id)?.paused?.until,
							note: state.agentNotes?.[agent.id],
							hiredAt: agent.createdAt,
						}),
					}
				: {}),
			mentioned: mentionedIn(
				agent.id === cofounder?.id && cofounderSessionId
					? cofounderSessionId
					: company.primarySessionFor(agent.id)?.sessionId,
			),
			...(waiting
				? {
						waiting: {
							...(waiting.what ? { what: waiting.what } : {}),
							...(waiting.kind ? { kind: waiting.kind } : {}),
						},
					}
				: {}),
			...(agent.id === cofounder?.id && state.openDecisions ? { decisions: state.openDecisions } : {}),
		};
	};
	const surfaceRail = surfaceRailFor(company);
	const cofounderElement =
		cofounder && matches(cofounder.displayName)
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
	// The sidebar: this member's pins and hidden agents and group chats, the company's
	// sections. A cloud without it shows every agent in one list, as before; one that
	// places agents only lists the group chats after them.
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	// The company's other members, each a contact that opens this member's chat with them (Jonas, 10 Nov 2026). None
	// alone in the company, on a cloud without member chats, or before the first read. A contact stands where its
	// member put it (app/rail-contacts.ts): in the Members group, in the order the members joined, until then.
	const activeMemberId = route.name === "company" && route.section === "member" ? route.id?.toLowerCase() : undefined;
	const memberChats = state.memberChatsUnavailable ? undefined : state.memberChats;
	const { others, contacts } = companyContacts(company);
	const contactOf = new Map(contacts.map((contact) => [contact.userId, contact]));
	const contactsIn = (zone: string) => contacts.filter((contact) => contact.zone === zone);
	const memberElement = (userId: string, keyPrefix = "", build = memberRow) => {
		const member = others.get(userId)!;
		const chat = memberChats![userId]!;
		const presence = memberPresence(state, userId);
		const href = `#/c/${profileId}/member/${userId}`;
		const waiting = chat.unread > 0 && chat.last?.authorUserId === userId ? chat.last.text : undefined;
		const model: MemberModel = {
			userId,
			name: member.displayName,
			online: presence?.online === true,
			line: waiting ?? presence?.text ?? "",
			unread: chat.unread,
			mentioned: chat.unread > 0,
		};
		return row(`${keyPrefix}${href}`, href, model, activeMemberId === userId, build);
	};
	const roster = company.sidebarRoster();
	const rooms = company.groupChatRooms();
	// Group chats the sidebar places; the others stand after the Unassigned agents.
	const placedRooms: ReadonlyMap<string, HostedSession> = sidebar?.groupChats ? rooms : new Map();
	const pinned = (sidebar?.pinned ?? []).filter((itemId) => roster.includes(itemId));
	const hidden = new Set(sidebar?.hidden ?? []);
	// A search that names a section lists everyone in it, pinned ones too; "Unassigned" names
	// what is in no section once there are sections to tell it from.
	const sectionNames = sidebar?.sections ?? [];
	const wholeSections = new Set(
		railQuery
			? sectionNames.filter((item) => matches(item.name)).map((item) => item.sectionId as string | undefined)
			: [],
	);
	if (railQuery && sectionNames.length && matches(t("Unassigned"))) wholeSections.add(undefined);
	const sectionOf = (itemId: string) => {
		const placed = sidebar?.placements[itemId]?.sectionId;
		return placed && sectionNames.some((item) => item.sectionId === placed) ? placed : undefined;
	};
	const inWholeSection = (itemId: string) => wholeSections.has(sectionOf(itemId));
	const surfacesStore = surfacesOf(company);
	const foldedAgents = surfacesStore?.state.foldedAgentIds ?? {};
	const shown = (agent: HostedStaffAgent | undefined): agent is HostedStaffAgent =>
		// A hidden agent is still found by searching for it.
		Boolean(agent) &&
		!foldedAgents[agent!.id] &&
		(matches(agent!.displayName) || inWholeSection(agent!.id)) &&
		(!hidden.has(agent!.id) || Boolean(railQuery));
	const roomShown = (roomId: string) =>
		(matches(placedRooms.get(roomId)?.title ?? "") || inWholeSection(roomId)) &&
		(!hidden.has(roomId) || Boolean(railQuery));
	// A contact shows as an agent does: where it stands unless hidden, and a search finds a hidden one too. A search
	// that names the section it stands in lists it with the section.
	const contactShown = (contact: RailContact) =>
		(matches(others.get(contact.userId)!.displayName) ||
			(contact.zone === "unassigned" && wholeSections.has(undefined)) ||
			(contact.zone.startsWith("section:") && wholeSections.has(contact.zone.slice("section:".length)))) &&
		(!contact.hidden || Boolean(railQuery));
	const agentElement = (agent: HostedStaffAgent) =>
		row(
			`#/c/${profileId}/staff/${agent.id}`,
			`#/c/${profileId}/staff/${agent.id}`,
			agentModel(agent),
			isActive(agent.id),
			agentRow,
		);
	const roomModel = (session: HostedSession, roomId: string): SessionModel => ({
		title: session.title,
		subtitle: state.groups?.[String(session.executionScope?.roomId)]?.subtitle ?? t("Group chat"),
		kind: "Group chat",
		agents: company.groupAgents(session.sessionId),
		selected: activeSessionId === session.sessionId,
		roomId,
		mentioned: mentionedIn(session.sessionId),
	});
	// A group chat is found by its room id, lower case as the sidebar names it.
	const roomElement = (roomId: string, keyPrefix = "", build = sessionRow) => {
		const session = placedRooms.get(roomId)!;
		const href = `#/c/${profileId}/chat/${session.sessionId}`;
		return row(`${keyPrefix}${href}`, href, roomModel(session, roomId), activeSessionId === session.sessionId, build);
	};
	// The member's pinned contacts stand among the pinned agents and group chats, each after the one it was put after.
	const pinnedElements = weave(pinned, contactsIn("pinned")).flatMap((itemId) => {
		const contact = contactOf.get(itemId);
		if (contact) return contactShown(contact) ? [memberElement(itemId, "pin:", memberCard)] : [];
		if (placedRooms.has(itemId)) return roomShown(itemId) ? [roomElement(itemId, "pin:", groupPinCard)] : [];
		const agent = company.staffById(itemId);
		return shown(agent)
			? [
					row(
						`pin:#/c/${profileId}/staff/${agent.id}`,
						`#/c/${profileId}/staff/${agent.id}`,
						agentModel(agent),
						isActive(agent.id),
						pinCard,
					),
				]
			: [];
	});
	// A container's rows: the company's order of its agents and group chats, with the member's contacts woven in
	// before the pinned and hidden ones are left out, so a contact keeps its place beside one that is pinned or hidden.
	const inContainer = (sectionId: string | undefined) =>
		weave(
			sidebar ? containerOrder(sidebar, sectionId, roster) : sectionId ? [] : roster,
			contactsIn(sectionId ? `section:${sectionId}` : "unassigned"),
		)
			.filter((itemId) => !pinned.includes(itemId))
			.flatMap((itemId) => {
				const contact = contactOf.get(itemId);
				if (contact) return contactShown(contact) ? [memberElement(itemId)] : [];
				if (placedRooms.has(itemId)) return roomShown(itemId) ? [roomElement(itemId)] : [];
				const agent = company.staffById(itemId);
				return shown(agent) ? [agentElement(agent)] : [];
			});
	// The Members group: the contacts their member has put nowhere else, the dragged ones first, then as they joined.
	const memberRows = weave([], contactsIn(MEMBERS_ZONE)).flatMap((userId) =>
		contactShown(contactOf.get(userId)!) ? [memberElement(userId)] : [],
	);
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
	// Hidden agents and group chats fold at the foot of the list, where they can be shown
	// again. A search already lists the matching ones in their places.
	const hiddenItems = railQuery ? [] : roster.filter((itemId) => hidden.has(itemId));
	// With them, the pages an owner or admin hid, for owners and admins: from here they show them again.
	const hiddenPages = railQuery ? [] : hiddenInterfaces(company);
	// And the contacts the member hid. A hidden contact can still write: how many of their messages wait stands on
	// the fold, so nothing a person sent goes unseen.
	const hiddenContacts = railQuery ? [] : contacts.filter((contact) => contact.hidden);
	const hiddenUnread = hiddenContacts.reduce((sum, contact) => sum + (memberChats?.[contact.userId]?.unread ?? 0), 0);
	const hiddenCount = hiddenItems.length + hiddenPages.length + hiddenContacts.length;
	const hiddenGroup = parts.hiddenGroup;
	hiddenGroup.count.textContent = String(hiddenCount);
	hiddenGroup.count.hidden = hiddenGroup.open;
	// Empty with nothing waiting, so the fold reads as its name and its count alone.
	hiddenGroup.unread.textContent = hiddenUnread === 0 ? "" : hiddenUnread > 99 ? "99+" : String(hiddenUnread);
	hiddenGroup.unread.hidden = hiddenUnread === 0 || hiddenGroup.open;
	hiddenGroup.chevron.hidden = !hiddenGroup.open;
	hiddenGroup.toggle.setAttribute("aria-expanded", String(hiddenGroup.open));
	hiddenGroup.toggle.setAttribute(
		"aria-label",
		[t("Hidden: {count}", { count: hiddenCount }), hiddenUnread ? t("Unread: {count}", { count: hiddenUnread }) : ""]
			.filter(Boolean)
			.join(" · "),
	);
	hiddenGroup.list.hidden = !hiddenGroup.open;
	reconcile(
		hiddenGroup.list,
		hiddenGroup.open
			? [
					...hiddenPages.map((entry) =>
						row(
							`hidden-page:${entry.name}`,
							"",
							{ name: entry.name, title: entry.file.name, emblem: entry.file.emblem },
							false,
							hiddenPageRow,
						),
					),
					...hiddenItems.flatMap((itemId) => {
						if (placedRooms.has(itemId)) return [roomElement(itemId, "hidden:")];
						const agent = company.staffById(itemId);
						return agent
							? [
									row(
										`hidden:#/c/${profileId}/staff/${agent.id}`,
										`#/c/${profileId}/staff/${agent.id}`,
										agentModel(agent),
										isActive(agent.id),
										agentRow,
									),
								]
							: [];
					}),
					...hiddenContacts.map((contact) => memberElement(contact.userId, "hidden:")),
				]
			: [],
	);
	const unassignedRows = [
		...inContainer(undefined),
		// Conversations that are not one agent's own thread and that the sidebar does not
		// place: group chats on a cloud that places agents only, and group work.
		...state.sessions
			.filter(
				(session) =>
					session.status === "open" &&
					(matches(session.title) || wholeSections.has(undefined)) &&
					// A pair transcript is reached from the chips in the agents' threads, never from the rail.
					!isAgentPairSession(session) &&
					!placedRooms.has(String(session.executionScope?.roomId).toLowerCase()) &&
					(!session.staffAgentId ||
						!active.some((agent) => agent.id === session.staffAgentId) ||
						(session.executionScope &&
							("group" in session.executionScope ||
								("roomId" in session.executionScope && session.executionScope.agentThread !== true)))),
			)
			.map((session) => {
				const roomId = isGroupChat(session) ? String(session.executionScope?.roomId).toLowerCase() : undefined;
				const href = `#/c/${profileId}/chat/${session.sessionId}`;
				return row(
					href,
					href,
					roomId && UUID_PATTERN.test(roomId)
						? roomModel(session, roomId)
						: {
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
				);
			}),
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
	const connectionNotice = () => {
		if (!state.connectionLost) return null;
		const text = t("Can't reach Qorpera. Trying again…");
		const kept = parts.notices.get("connection");
		const entry = kept?.text === text ? kept : { text, element: notice("neutral", text) };
		notices.set("connection", entry);
		return entry.element;
	};
	// After Reset sidebar: one line with Undo, until dismissed or the sidebar changes again.
	const resetNotice = () => {
		if (!state.sidebarReset) return null;
		const text = t("Sidebar reset to {company}'s.", { company: companyInSentence(company.profile.profileName) });
		const kept = parts.notices.get("reset");
		const entry =
			kept?.text === text
				? kept
				: {
						text,
						element: notice(
							"neutral",
							text,
							button(t("Undo"), () => void undoSidebarReset(company, parts), { small: true }),
							button(t("Dismiss"), () => company.store.set({ sidebarReset: undefined }), { small: true }),
						),
					};
		// Undo is pressed once: it waits while its request is on its way.
		const undo = entry.element.querySelector("button");
		if (undo) undo.disabled = state.sidebarReset.undoing === true;
		notices.set("reset", entry);
		return entry.element;
	};
	const anyRows =
		memberRows.length +
		pinnedElements.length +
		unassignedRows.length +
		hiddenCount +
		sectionGroups.reduce((n, g) => n + g.rows.length, 0);
	const waiting = (state.loading || state.connectionLost) && !state.staff.length;
	if (!waiting) parts.loading = undefined;
	else parts.loading ??= railListSkeleton();
	const empty =
		!state.loading && !state.connectionLost && !cofounderElement && !anyRows
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
	// With no one in it, Unassigned is not a category: its title shows only while an agent
	// is dragged, so it can still be dropped there (styles/app.css).
	parts.unassigned.el.classList.toggle("is-empty", !unassignedRows.length);
	// Without sections the list is not a group: nothing would name it but a hidden title.
	if (sectioned) {
		parts.unassigned.el.setAttribute("role", "group");
		parts.unassigned.el.setAttribute("aria-labelledby", parts.unassigned.title.id);
	} else {
		parts.unassigned.el.removeAttribute("role");
		parts.unassigned.el.removeAttribute("aria-labelledby");
	}
	reconcile(parts.unassigned.list, unassignedRows);
	// The Members group is a zone only contacts land in, where the cloud keeps their places. Its title parts it from
	// the sections above it, as Unassigned's does. With nobody in it, it shows only while a contact is dragged, so one
	// can be dropped back there (styles/app.css).
	const placing = state.memberContactPlacing === true && contacts.length > 0;
	const hasMembersSurface = Boolean(
		surfaceRail &&
			!railQuery &&
			surfacesStore?.state.surfaces.some((surface) => surface.status === "active" && surface.slug === "members"),
	);
	const memberUnread = contacts.reduce(
		(sum, contact) =>
			sum + (contact.zone === MEMBERS_ZONE && !contact.hidden ? (memberChats?.[contact.userId]?.unread ?? 0) : 0),
		0,
	);
	zone(parts.members.el, placing && !hasMembersSurface);
	parts.members.title.hidden = !sectioned;
	parts.members.el.classList.toggle("is-empty", !memberRows.length);
	reconcile(parts.members.list, hasMembersSurface ? [] : memberRows);
	surfaceRail?.update(
		route.name === "company" && route.section === "surface" ? route.id : undefined,
		false,
		hasMembersSurface ? { rows: memberRows, unread: memberUnread, active: Boolean(activeMemberId) } : undefined,
	);
	// Collapsed, where section titles hide, a short line parts each group of agents from the
	// group above it: never under the Co-Founder, never around a section with no one in it.
	let above = pinnedElements.length > 0;
	for (const [element, count] of [
		...sectionGroups.map(({ group, rows: sectionRows }) => [group.el, sectionRows.length] as const),
		[parts.unassigned.el, unassignedRows.length] as const,
		[parts.members.el, hasMembersSurface ? 0 : memberRows.length] as const,
	]) {
		element.classList.toggle("rail-divided", above && count > 0);
		above ||= count > 0;
	}
	reconcile(parts.cofounderGroup, cofounderElement ? [cofounderElement] : []);
	const legacyNodes = [
		sidebar && !railQuery ? parts.pinnedGroup : pinnedElements.length ? parts.pinnedGroup : null,
		...sectionGroups.filter(({ rows: r }) => r.length || !railQuery).map(({ group }) => group.el),
		unassignedRows.length || (sectioned && !railQuery) ? parts.unassigned.el : null,
	].filter((element) => element !== null);
	const companyAgents = active.filter(
		(agent) => agent.id !== cofounderId && !foldedAgents[agent.id] && !hidden.has(agent.id),
	);
	const workingStaff = companyAgents.filter((agent) => agentWorks(company.agentState(agent.id)));
	const scheduledStaff = companyAgents.filter(
		(agent) => !agentWorks(company.agentState(agent.id)) && Boolean(state.agentNotes?.[agent.id]?.next),
	);
	const idleStaff = companyAgents.filter(
		(agent) => !agentWorks(company.agentState(agent.id)) && !state.agentNotes?.[agent.id]?.next,
	);
	const activeAgentId =
		context.route.name === "company" && context.route.section === "staff" ? context.route.id : undefined;
	const agentsHub =
		surfaceRail && !railQuery
			? syncAgentsHub(company, {
					profileId,
					activeAgentId,
					workingStaff,
					scheduledStaff,
					idleStaff,
				})
			: null;
	reconcile(
		parts.list,
		[
			connectionNotice(),
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
			resetNotice(),
			cofounderElement ? parts.cofounderGroup : null,
			surfaceRail && !railQuery ? surfaceRail.el : null,
			parts.loading ?? null,
			...(agentsHub ? [agentsHub] : surfaceRail && !railQuery ? [] : legacyNodes),
			!hasMembersSurface && (memberRows.length || (placing && !railQuery)) ? parts.members.el : null,
			hiddenCount ? hiddenGroup.el : null,
			empty && !surfaceRail ? parts.empty : null,
			parts.selection.moving ?? null,
		].filter((element) => element !== null),
	);
	parts.selection.move(parts.list);
	glideRows(parts.list, places);
	parts.rows = rows;
	// Everything the company lists now is known from here on, drawn or not (hidden, filtered out).
	parts.known.add(`#/c/${profileId}`);
	for (const agent of state.staff) parts.known.add(`#/c/${profileId}/staff/${agent.id}`);
	for (const listed of state.sessions) parts.known.add(`#/c/${profileId}/chat/${listed.sessionId}`);
	for (const member of state.team?.members ?? []) parts.known.add(`#/c/${profileId}/member/${member.userId}`);
	if (!state.loading) parts.settled = true;
	parts.mentionsRead = parts.settled && state.mentions !== undefined;
	parts.notices = notices;
	// A row moved to a new place loses focus on the way, so it gets it back too.
	if (focused && document.activeElement !== focused) {
		const replacement = focused.isConnected ? focused : successor;
		if (replacement) replacement.focus({ preventScroll: true });
		else {
			const now = focusables();
			(
				now[Math.min(index, now.length - 1)] ?? (parts.input.tabIndex < 0 ? parts.searchToggle : parts.input)
			).focus();
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
	paintPresence(container, parts, company);
	restoreFocus();
}

interface AgentsHubParts {
	readonly el: HTMLElement;
	readonly title: HTMLElement;
	readonly workingWrap: HTMLElement;
	readonly workingTitle: HTMLElement;
	readonly workingList: HTMLElement;
	readonly scheduledWrap: HTMLElement;
	readonly scheduledTitle: HTMLElement;
	readonly scheduledList: HTMLElement;
	readonly idleWrap: HTMLElement;
	readonly idleTitle: HTMLElement;
	readonly idleList: HTMLElement;
	readonly workingCrew: CrewFigures;
	readonly scheduledCrew: CrewFigures;
	workingKey: string;
	scheduledKey: string;
	idleKey: string;
}

interface AgentsHubInput {
	readonly profileId: string;
	readonly activeAgentId: string | undefined;
	readonly workingStaff: readonly HostedStaffAgent[];
	readonly scheduledStaff: readonly HostedStaffAgent[];
	readonly idleStaff: readonly HostedStaffAgent[];
}

const agentsHubs = new WeakMap<CompanyController, AgentsHubParts>();
function syncAgentsHub(company: CompanyController, input: AgentsHubInput): HTMLElement | null {
	const store = surfacesOf(company);
	if (!store) return null;
	const state = store.state;
	const tasks = activeTaskSessions(state);
	const explorations = state.surfaces
		.filter((surface) => surface.status === "active")
		.flatMap((surface) => {
			const workspace = state.workspaces[surface.id];
			return openExplorations(workspace).map((exploration) => ({
				surface,
				exploration,
				variants: exploration.variantSessionIds
					.map((id) => workspace?.activeSessions.find((session) => session.id === id))
					.filter((session): session is NonNullable<typeof session> => Boolean(session)),
			}));
		});
	const automations = state.automations;
	const hasWorking = input.workingStaff.length > 0 || tasks.length > 0 || explorations.length > 0;
	const hasScheduled = automations.length > 0 || input.scheduledStaff.length > 0;
	const hasIdle = input.idleStaff.length > 0;
	if (!hasWorking && !hasScheduled && !hasIdle) return null;

	let hub = agentsHubs.get(company);
	if (!hub) {
		const title = h("span", null, t("Agents"));
		const workingTitle = h("div", { class: "rail-agents-subhead" }, t("Working"));
		const workingList = h("div", { class: "rail-agents-list" });
		const workingWrap = h("div", { class: "rail-agents-sub", hidden: true }, workingTitle, workingList);
		const scheduledTitle = h("div", { class: "rail-agents-subhead" }, t("Scheduled"));
		const scheduledList = h("div", { class: "rail-agents-list" });
		const scheduledWrap = h("div", { class: "rail-agents-sub", hidden: true }, scheduledTitle, scheduledList);
		const idleTitle = h("div", { class: "rail-agents-subhead" }, t("Ready"));
		const idleList = h("div", { class: "rail-agents-list" });
		const idleWrap = h("div", { class: "rail-agents-sub", hidden: true }, idleTitle, idleList);
		const el = h(
			"div",
			{ class: "rail-agents-hub", role: "group", "aria-label": t("Agents") },
			h("div", { class: "rail-section-title rail-agents-head" }, title),
			workingWrap,
			scheduledWrap,
			idleWrap,
		);
		hub = {
			el,
			title,
			workingWrap,
			workingTitle,
			workingList,
			scheduledWrap,
			scheduledTitle,
			scheduledList,
			idleWrap,
			idleTitle,
			idleList,
			workingCrew: new CrewFigures(),
			scheduledCrew: new CrewFigures(),
			workingKey: "",
			scheduledKey: "",
			idleKey: "",
		};
		agentsHubs.set(company, hub);
	}

	const locale = presentationLocale();
	hub.title.textContent = t("Agents");
	hub.el.setAttribute("aria-label", t("Agents"));

	hub.workingTitle.textContent = t("Working");
	hub.workingWrap.hidden = !hasWorking;
	const workingKey = JSON.stringify([
		locale,
		input.activeAgentId,
		input.workingStaff.map((agent) => [agent.id, agent.displayName, company.agentState(agent.id)]),
		explorations.map(({ surface, exploration, variants }) => [
			surface.slug,
			surface.title,
			exploration.id,
			exploration.title,
			variants.length,
			variants.some(isRunningSession),
		]),
		tasks.map(({ surface, session, running }) => [
			surface.slug,
			surface.title,
			session.id,
			session.title,
			session.state,
			running,
			session.openChangeCount,
			hasConflictedChange(session),
		]),
	]);
	if (workingKey !== hub.workingKey) {
		hub.workingKey = workingKey;
		const workingRows: HTMLElement[] = [
			...input.workingStaff.map((agent) => {
				const look = AGENT_LOOK[company.agentState(agent.id)];
				return h(
					"a",
					{
						class: `rail-agent-hub-row is-working${input.activeAgentId === agent.id ? " active" : ""}`,
						href: `#/c/${input.profileId}/staff/${agent.id}`,
						draggable: "false",
					},
					h(
						"span",
						{ class: "rail-agent-hub-fig" },
						agentFigure(agent, agent.displayName, { size: 32, activity: look.figure, alive: true }),
					),
					h(
						"span",
						{ class: "rail-agent-hub-copy" },
						h("strong", null, agent.displayName),
						h("small", null, stateLine(look) ?? t("Working")),
					),
				);
			}),
			...explorations.map(({ surface, exploration, variants }) => {
				const running = variants.some(isRunningSession);
				const status: HTMLElement | string = running
					? crewWave()
					: t("{count} options", { count: variants.length });
				return h(
					"button",
					{
						type: "button",
						class: `rail-agent-hub-row${running ? " is-working" : ""}`,
						"data-hub-exploration": exploration.id,
						onclick: () => {
							location.hash = surfaceHash(input.profileId, surface.slug);
							store.openExplorationDrawer(surface.id, exploration.id);
						},
					},
					hub!.workingCrew.takeExploration(exploration, variants, 32),
					h(
						"span",
						{ class: "rail-agent-hub-copy" },
						h("strong", null, exploration.title),
						h("small", null, status),
					),
					h("span", { class: "rail-agent-surface-tag" }, surface.title),
				);
			}),
			...tasks.map(({ surface, session, running }) => {
				const liveChanges = session.changes.filter((change) => change.status !== "discarded");
				const actions = liveChanges.length > 0 && liveChanges.every((change) => isActionChange(change, surface));
				const open = liveChanges.filter(isOpenChange).length;
				const status: HTMLElement | string = running
					? crewWave()
					: session.state === "needs_input"
						? t("Needs you")
						: hasConflictedChange(session)
							? t("Conflict")
							: actions
								? open > 1
									? t("{count} actions ready", { count: open })
									: t("Action ready")
								: open === 1
									? t("1 change ready")
									: open > 1
										? t("{count} changes ready", { count: open })
										: t("Ready");
				return h(
					"button",
					{
						type: "button",
						class: `rail-agent-hub-row${running ? " is-working" : ""}`,
						"data-hub-session": session.id,
						onclick: () => {
							location.hash = surfaceHash(input.profileId, surface.slug);
							store.openDrawer(surface.id, session.id);
						},
					},
					hub!.workingCrew.take(session, 32),
					h("span", { class: "rail-agent-hub-copy" }, h("strong", null, session.title), h("small", null, status)),
					h("span", { class: "rail-agent-surface-tag" }, surface.title),
				);
			}),
		];
		hub.workingList.replaceChildren(...workingRows);
		hub.workingCrew.settle();
	}

	hub.scheduledTitle.textContent = t("Scheduled");
	hub.scheduledWrap.hidden = !hasScheduled;
	const companyState = company.store.get();
	const surfaceTitleBySlug = new Map(state.surfaces.map((surface) => [surface.slug, surface.title]));
	const scheduledKey = JSON.stringify([
		locale,
		input.activeAgentId,
		automations.map((item) => [
			item.id,
			item.title,
			item.scheduleSummary,
			item.enabled,
			item.targetSurfaceSlug,
			Boolean(state.busy[`automation:${item.id}`]),
		]),
		input.scheduledStaff.map((agent) => [agent.id, agent.displayName, companyState.agentNotes?.[agent.id]?.next]),
	]);
	if (scheduledKey !== hub.scheduledKey) {
		hub.scheduledKey = scheduledKey;
		const scheduledRows: HTMLElement[] = [
			...automations.map((automation) => {
				const targetTitle = automation.targetSurfaceSlug
					? surfaceTitleBySlug.get(automation.targetSurfaceSlug)
					: undefined;
				const toggle = h("button", {
					type: "button",
					class: "surface-switch",
					role: "switch",
					"aria-checked": String(automation.enabled),
					"aria-label": t("Turn {name} on or off", { name: automation.title }),
					disabled: Boolean(state.busy[`automation:${automation.id}`]),
					onclick: (event: MouseEvent) => {
						event.stopPropagation();
						void store.toggleAutomation(automation.id, !automation.enabled);
					},
				});
				return h(
					"div",
					{
						class: `rail-agent-sched${automation.enabled ? "" : " is-paused"}`,
						"data-scheduled-agent": automation.id,
					},
					h(
						"button",
						{
							type: "button",
							class: "rail-agent-hub-row",
							onclick: () => openScheduleAgentSheet(store, automation),
						},
						hub!.scheduledCrew.takeScheduled(automation.id, automation.enabled, 32, automation.title),
						h(
							"span",
							{ class: "rail-agent-hub-copy" },
							h("strong", null, automation.title),
							h(
								"small",
								{ title: automation.scheduleSummary },
								targetTitle ? `${targetTitle} · ${automation.scheduleSummary}` : automation.scheduleSummary,
							),
						),
					),
					toggle,
				);
			}),
			...input.scheduledStaff.map((agent) => {
				const note = idleLine({
					failed: false,
					hiredAt: agent.createdAt,
					note: companyState.agentNotes?.[agent.id],
				});
				return h(
					"a",
					{
						class: `rail-agent-hub-row${input.activeAgentId === agent.id ? " active" : ""}`,
						href: `#/c/${input.profileId}/staff/${agent.id}`,
						draggable: "false",
						"data-agent-id": agent.id,
					},
					h(
						"span",
						{ class: "rail-agent-hub-fig" },
						agentFigure(agent, agent.displayName, { size: 32, activity: "Idle", alive: true }),
					),
					h(
						"span",
						{ class: "rail-agent-hub-copy" },
						h("strong", null, agent.displayName),
						note?.text ? h("small", null, note.text) : null,
					),
				);
			}),
		];
		hub.scheduledList.replaceChildren(...scheduledRows);
		hub.scheduledCrew.settle();
	}

	hub.idleTitle.textContent = t("Ready");
	hub.idleWrap.hidden = !hasIdle;
	const idleKey = JSON.stringify([
		locale,
		input.activeAgentId,
		input.idleStaff.map((agent) => [agent.id, agent.displayName, agent.role]),
	]);
	if (idleKey !== hub.idleKey) {
		hub.idleKey = idleKey;
		const idleRows = input.idleStaff.map((agent) =>
			h(
				"a",
				{
					class: `rail-agent-hub-row${input.activeAgentId === agent.id ? " active" : ""}`,
					href: `#/c/${input.profileId}/staff/${agent.id}`,
					draggable: "false",
					"data-agent-id": agent.id,
				},
				h(
					"span",
					{ class: "rail-agent-hub-fig" },
					agentFigure(agent, agent.displayName, { size: 32, activity: "Idle", alive: true }),
				),
				h(
					"span",
					{ class: "rail-agent-hub-copy" },
					h("strong", null, agent.displayName),
					agent.role ? h("small", null, agent.role) : null,
				),
			),
		);
		hub.idleList.replaceChildren(...idleRows);
	}

	return hub.el;
}

const surfaceRails = new WeakMap<CompanyController, SurfaceRail>();
function surfaceRailFor(company: CompanyController): SurfaceRail | undefined {
	const store = surfacesOf(company);
	if (!store) return undefined;
	let rail = surfaceRails.get(company);
	if (!rail) {
		rail = new SurfaceRail(store, company.profile.profileId, company.signal, () =>
			openCreateSurfaceSheet(store, company.profile.profileId),
		);
		surfaceRails.set(company, rail);
	}
	return rail;
}

/* ---- Who is where ---------------------------------------------------------------- */

function placeOf(element: HTMLElement): string | undefined {
	const { agentId, cofounderId, roomId, appKey, owedPlace, surfaceSlug } = element.dataset;
	if (surfaceSlug) return `surface:${surfaceSlug.toLowerCase()}`;
	if (agentId || cofounderId) return `agent:${(agentId ?? cofounderId)!.toLowerCase()}`;
	if (roomId) return `room:${roomId.toLowerCase()}`;
	if (owedPlace) return owedPlace;
	if (!appKey) return undefined;
	return appKey.startsWith("app:") || appKey === "concepts" || appKey === "sites" || appKey === "whats-new"
		? appKey
		: `page:${appKey}`;
}

function paintPresence(container: HTMLElement, parts: RailParts, company: CompanyController): void {
	const places = company.peopleByPlace();
	const inApps = new Map<string, { userId: string; name: string }>();
	for (const element of container.querySelectorAll<HTMLElement>(
		"[data-surface-slug], [data-agent-id], [data-cofounder-id], [data-room-id], [data-app-key], [data-owed-place]",
	)) {
		const place = placeOf(element);
		const people = (place && places.get(place)) || [];
		if (element.dataset.appKey || element.dataset.owedPlace)
			for (const person of people) inApps.set(person.userId, person);
		paintHere(element, people);
	}
	paintHere(parts.apps, parts.appsOpen ? [] : [...inApps.values()]);
}

function paintHere(element: HTMLElement, people: readonly { userId: string; name: string }[]): void {
	const kept = element.querySelector<HTMLElement>(":scope > .rail-here, :scope > * > .rail-here");
	// Who and by what name: a renamed member is drawn anew.
	const key = JSON.stringify(people.map((person) => [person.userId, person.name]));
	if (!people.length) {
		kept?.remove();
		element.removeAttribute("aria-description");
		element.style.removeProperty("--here-count");
		return;
	}
	if (kept?.dataset.people === key) return;
	const names = people.map((person) => person.name);
	const said =
		names.length === 1
			? t("{name} is here", { name: names[0]! })
			: t("{names} are here", { names: new Intl.ListFormat(presentationLocale()).format(names) });
	const marker = h(
		"span",
		{ class: "rail-here", "data-people": key, title: said, "aria-hidden": "true" },
		...people.slice(0, 3).map((person) => personAvatar(person.name, person.userId)),
		people.length > 3 ? h("span", { class: "rail-here-more" }, `+${people.length - 3}`) : null,
	);
	if (kept) kept.replaceWith(marker);
	else element.append(marker);
	// How many circles the marker draws (pictures and "+n"), so a row keeps its text clear of them.
	element.style.setProperty("--here-count", String(Math.min(people.length, 4)));
	// A card's marker sits against its figure (in the stand), not in the card's far corner.
	const stand = element.querySelector<HTMLElement>(":scope > .cofounder-stand, :scope > .rail-pin-stand");
	if (stand) stand.append(marker);
	element.setAttribute("aria-description", said);
}

/* ---- The apps drawer --------------------------------------------------------------- */

function setAppsOpen(parts: RailParts, profileId: string, open: boolean): void {
	parts.appsOpen = open;
	try {
		localStorage.setItem(`${APPS_OPEN_KEY}:${profileId}`, open ? "1" : "0");
	} catch {
		/* The choice lasts this view. */
	}
}

/** What the owed row shows: each live website Qorpera did not take down, then each owed app that is made (its app.toml
 * read), whether or not it is posted: a view that is not made yet shows nothing. A concept is never one. */
export function owedViews(
	sites: readonly CompanySite[],
	apps: readonly CompanyApp[],
	takenDown: ReadonlySet<string> = new Set(),
): { websites: readonly CompanySite[]; apps: readonly CompanyApp[] } {
	return {
		websites: sites.filter((site) => site.kind === "files" && site.state === "live" && !takenDown.has(site.id)),
		apps: OWED_APPS.flatMap((name) => {
			const app = apps.find((entry) => entry.name === name);
			return app?.manifest && !app.manifest.concept && app.manifest.kit !== "program" ? [app] : [];
		}),
	};
}

/** The owed row: one tile a website (its globe, its title), leading to the site's view, then the owed apps, each as the
 * drawer draws an agent's app. Not dragged, not grouped, no menu: the platform puts them there. A tile is rebuilt only
 * when what it shows changes. */
function drawOwed(
	parts: RailParts,
	company: CompanyController,
	owed: { websites: readonly CompanySite[]; apps: readonly CompanyApp[] },
	route: Route,
): void {
	const profileId = company.profile.profileId;
	const rows = new Map<string, { shown: string; element: HTMLElement }>();
	const lit = (element: HTMLElement, on: boolean) => {
		element.classList.toggle("active", on);
		if (on) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
	};
	const elements: HTMLElement[] = [];
	for (const site of owed.websites) {
		const key = `site:${site.slug}`;
		const name = site.title ?? site.slug;
		const model = JSON.stringify([site.slug, name]);
		const kept = parts.owedRows.get(key);
		const element = kept?.shown === model ? kept.element : websiteIcon(name, siteHash(profileId, site.slug));
		rows.set(key, { shown: model, element });
		element.dataset.owedPlace = key;
		element.style.setProperty("--app-colour", colourHex("blue")!);
		lit(element, route.name === "company" && route.section === "site" && route.id === site.slug);
		elements.push(element);
	}
	// An owed app in its own colour and emblem; what else shows the app (its card in a message) draws it the same way.
	const looks = new Map(parts.appLooks);
	for (const app of owed.apps) {
		const manifest = app.manifest!;
		const key = `app:${app.name}`;
		const colour = colourHex(manifest.colour ?? undefined);
		const model = JSON.stringify([app.name, manifest.name, manifest.about, manifest.emblem]);
		const kept = parts.owedRows.get(key);
		const element = kept?.shown === model ? kept.element : agentAppIcon(manifest, appHash(profileId, app.name));
		rows.set(key, { shown: model, element });
		element.dataset.owedPlace = key;
		if (colour) element.style.setProperty("--app-colour", colour);
		else element.style.removeProperty("--app-colour");
		lit(element, route.name === "company" && route.section === "app" && route.id === app.name);
		looks.set(app.name, {
			key: JSON.stringify([manifest.emblem, colour ?? ""]),
			colour,
			emblem: () => interfaceEmblem(manifest.emblem, 34),
		});
		elements.push(element);
	}
	parts.appLooks = looks;
	parts.owedRows = rows;
	for (const [index, element] of elements.entries()) element.style.setProperty("--i", String(index));
	reconcile(parts.appsOwed, elements);
	parts.appsOwed.hidden = elements.length === 0;
}

/** The drawer under the top row: the pages that are on (Mailbox, Members, Bank and the agents' pages) as icons,
 * four to a row. An icon is rebuilt only when what it shows changes. The four windows carry a dot while the drawer
 * is closed and a page has something waiting. */
function drawInterfaces(
	parts: RailParts,
	company: CompanyController,
	shown: readonly CompanyInterface[],
	apps: readonly CompanyApp[],
	concepts: number,
	sites: number,
	route: Route,
): void {
	const profileId = company.profile.profileId;
	const activeName = route.name === "company" && route.section === "interface" ? route.id : undefined;
	const rows = new Map<string, { shown: string; element: HTMLElement }>();
	let waiting = 0;
	// What waits in each entry and the colour of its emblem, by its key in the drawer.
	const counts = new Map<string, number>();
	const colours = new Map<string, string | undefined>();
	// The member's own icon for each entry (20260930732000), drawn in place of the entry's; part of each tile's model,
	// so a change draws the tile anew. One of the app's own icons is read when picked and not read yet.
	const own = company.store.get();
	const emblemChoice = (key: string): { model: string; draw?: () => SVGSVGElement } => {
		const chosen = own.appLayout?.layout.emblems?.[fileKey(key)];
		if (!chosen) return { model: "" };
		if (!chosen.startsWith("custom:")) return { model: chosen, draw: () => interfaceEmblem(chosen as Emblem, 34) };
		const app = key.startsWith("app:") ? key.slice("app:".length) : undefined;
		if (!app) return { model: "" };
		if (!own.appIcons?.[app]) void company.loadAppIcons(app);
		const drawn = own.appIcons?.[app]?.find((entry) => `custom:${entry.id}` === chosen);
		return drawn ? { model: `${chosen}@${drawn.seq}`, draw: () => appIconEmblem(drawn.icon, 34) } : { model: "" };
	};
	const withEmblem = (element: HTMLElement, choice: { draw?: () => SVGSVGElement }) => {
		if (choice.draw) element.querySelector(".rail-app-stand > svg.interface-emblem")?.replaceWith(choice.draw());
		return element;
	};
	const elements = shown.map((entry) => {
		const { name, file } = entry;
		const count = interfaceBadge(company, file);
		waiting += count;
		counts.set(name, count);
		colours.set(name, PAGE_COLOURS[name]);
		const choice = emblemChoice(name);
		const model = JSON.stringify([name, file.name, file.about, file.emblem, count, choice.model]);
		const kept = parts.interfaceRows.get(name);
		const element =
			kept?.shown === model ? kept.element : withEmblem(appIcon(entry, `#/c/${profileId}/i/${name}`, count), choice);
		rows.set(name, { shown: model, element });
		element.dataset.appKey = name;
		element.dataset.ownEmblem = pageEmblem(name, file.emblem) ?? "page";
		element.classList.toggle("active", name === activeName);
		if (name === activeName) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		return element;
	});
	// An agent's app opens as a page of its own, `#/c/{id}/a/{name}`, as the pages do.
	const activeApp = route.name === "company" && route.section === "app" ? route.id : undefined;
	for (const app of apps) {
		const manifest = app.manifest;
		if (!manifest) continue;
		const key = `app:${app.name}`;
		colours.set(key, manifest.colour ?? undefined);
		const choice = emblemChoice(key);
		const model = JSON.stringify([app.name, manifest.name, manifest.about, manifest.emblem, choice.model]);
		const kept = parts.interfaceRows.get(key);
		const element =
			kept?.shown === model
				? kept.element
				: withEmblem(agentAppIcon(manifest, appHash(profileId, app.name)), choice);
		// Its agent was asked for new icons: the tile breathes until they come (company.ts, requestAppIcons).
		element.classList.toggle("is-drawing", Boolean(own.appIconsDrawing?.[app.name]));
		rows.set(key, { shown: model, element });
		element.dataset.appKey = key;
		element.dataset.ownEmblem = manifest.emblem;
		element.classList.toggle("active", app.name === activeApp);
		if (app.name === activeApp) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	// The company's concepts: one entry for the Concepts viewer, which lists them all.
	if (concepts > 0) {
		const key = "concepts";
		colours.set(key, "gold");
		const choice = emblemChoice(key);
		const model = JSON.stringify([key, t("Concepts"), concepts, choice.model]);
		const kept = parts.interfaceRows.get(key);
		const element = kept?.shown === model ? kept.element : withEmblem(conceptsIcon(conceptsHash(profileId)), choice);
		rows.set(key, { shown: model, element });
		element.dataset.appKey = key;
		element.dataset.ownEmblem = "board";
		const open = route.name === "company" && route.section === "concepts";
		element.classList.toggle("active", open);
		if (open) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	// The company's websites: one entry for the Sites page, which lists them all.
	if (sites > 0) {
		const key = "sites";
		colours.set(key, "blue");
		const choice = emblemChoice(key);
		const model = JSON.stringify([key, t("Sites"), sites, choice.model]);
		const kept = parts.interfaceRows.get(key);
		const element = kept?.shown === model ? kept.element : withEmblem(sitesIcon(`#/c/${profileId}/sites`), choice);
		rows.set(key, { shown: model, element });
		// Its key, as every drawer entry has: the member's drag and Alt-arrow order it, and the order is kept.
		element.dataset.appKey = key;
		element.dataset.ownEmblem = "globe";
		const open = route.name === "company" && route.section === "sites";
		element.classList.toggle("active", open);
		if (open) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	// What's new (own code storage step 4): one entry while a project of the company makes a website, its badge the
	// changes ready to go live.
	const whatsNew = company.store.get().whatsNew;
	if (whatsNew) {
		const key = "whats-new";
		waiting += whatsNew.ready;
		// A group it stands in sums its count, as a page's; its spark is orange, beside the other platform pages' colours.
		counts.set(key, whatsNew.ready);
		colours.set(key, "orange");
		const choice = emblemChoice(key);
		const model = JSON.stringify([key, t("What's new"), whatsNew.ready, choice.model]);
		const kept = parts.interfaceRows.get(key);
		const element =
			kept?.shown === model
				? kept.element
				: withEmblem(whatsNewIcon(`#/c/${profileId}/whats-new`, whatsNew.ready), choice);
		rows.set(key, { shown: model, element });
		element.dataset.appKey = key;
		element.dataset.ownEmblem = "spark";
		const open = route.name === "company" && route.section === "whats-new";
		element.classList.toggle("active", open);
		if (open) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	parts.interfaceRows = rows;
	const ordered = orderApps(elements, (element) => element.dataset.appKey ?? "", parts.appsOrder);
	// Groups (Jonas, 11 Nov 2026): the company's, from apps/groups.md, and the member's own changes over them. What
	// neither names stands loose in the order above.
	const state = company.store.get();
	const byKey = new Map(ordered.map((element) => [fileKey(element.dataset.appKey ?? ""), element]));
	const { tree, refused } = arrangeAppsFully(state.appGroups ?? [], state.appLayout?.layout ?? EMPTY_APP_LAYOUT, [
		...byKey.keys(),
	]);
	parts.appRefused = refused;
	const tiles = flattenApps(tree, parts.appGroupsOpen);
	// Apps in a group take the group's colour; the member's own colours over the drawer's (Jonas, 12 Nov 2026).
	const resolved = appColours(tree, state.appLayout?.layout ?? EMPTY_APP_LAYOUT, (key) => colours.get(drawerKey(key)));
	const colourOf = (key: string) => colourHex(resolved.get(key));
	// Each agent's app as it is drawn here, for whatever else shows the app (`appLook`).
	parts.appLooks = new Map(
		apps.flatMap((app): [string, AppLook][] => {
			const manifest = app.manifest;
			if (!manifest) return [];
			const key = `app:${app.name}`;
			const choice = emblemChoice(key);
			const colour = colourOf(key);
			const emblem = choice.draw ?? (() => interfaceEmblem(manifest.emblem, 34));
			return [[app.name, { key: JSON.stringify([choice.model || manifest.emblem, colour ?? ""]), colour, emblem }]];
		}),
	);
	const groupRows = new Map<string, { shown: string; element: HTMLElement }>();
	const drawn = tiles.map((tile) => {
		let element: HTMLElement;
		if (tile.node.kind === "group") {
			const group = tile.node;
			const inside = appsIn(group);
			const count = inside.reduce((sum, key) => sum + (counts.get(drawerKey(key)) ?? 0), 0);
			const colour = colourOf(tile.key);
			// Its colour is set in place, not by drawing it anew: a colour picked from its menu keeps the focus on it
			// (review r2 F1 on #1694).
			const model = JSON.stringify([group.id, group.name, count]);
			const kept = parts.groupRows.get(group.id);
			element = kept?.shown === model ? kept.element : groupIcon(group.name, count, colour);
			if (colour) element.style.setProperty("--app-colour", colour);
			else element.style.removeProperty("--app-colour");
			groupRows.set(group.id, { shown: model, element });
			element.dataset.appKey = tile.key;
			element.classList.toggle("is-open", tile.open);
			element.setAttribute("aria-expanded", String(tile.open));
		} else {
			element = byKey.get(tile.key)!;
			const colour = colourOf(tile.key);
			if (colour) element.style.setProperty("--app-colour", colour);
			else element.style.removeProperty("--app-colour");
		}
		if (tile.chain.length) element.dataset.inGroup = tile.chain.join(" ");
		else delete element.dataset.inGroup;
		return element;
	});
	parts.groupRows = groupRows;
	parts.appTree = tree;
	parts.appTiles = tiles;
	// WHY: New program lives behind the Building section's + now, never as a drawer tile that cannot be removed.
	parts.newProgram = undefined;
	for (const [index, element] of drawn.entries()) element.style.setProperty("--i", String(index));
	// A lifted icon keeps the order the drag shows; the drag's end draws the drawer afresh.
	if (!parts.appsDrag.dragging) placeTiles(parts, drawn);
	const dot = waiting > 0 && !parts.appsOpen;
	parts.apps.classList.toggle("has-waiting", dot);
	const label = dot ? `${t("Apps")}, ${t("{count} waiting", { count: waiting })}` : t("Apps");
	if (parts.apps.getAttribute("aria-label") !== label) parts.apps.setAttribute("aria-label", label);
}

/** An interface's badge on its emblem (§3 `badge`): how many of its rows wait, said in its label too. */
function countBadge(count: number): HTMLElement | null {
	return count > 0
		? h("span", { class: "rail-mention rail-count", "aria-hidden": "true" }, count > 99 ? "99+" : String(count))
		: null;
}

/** How an agent's app is drawn: its emblem and the colour of it. `key` changes when either does. */
export interface AppLook {
	readonly key: string;
	/** The emblem's colour, or undefined for the text's own. */
	readonly colour: string | undefined;
	/** The emblem, drawn anew at each call. */
	readonly emblem: () => SVGSVGElement;
}

/** An agent's app as the drawer draws it, for its card in a message (app/application.ts): the member's own icon and
 * colour for it, or its group's colour (Jonas, 12 Nov 2026). An app that is not in the drawer (not posted, a concept,
 * or the rail not drawn yet) is drawn as its manifest says. Undefined for an app with no manifest. */
export function appLook(company: CompanyController, app: CompanyApp): AppLook | undefined {
	const manifest = app.manifest;
	if (!manifest) return undefined;
	const drawer = railParts.get(company)?.appLooks.get(app.name);
	if (drawer) return drawer;
	const colour = colourHex(manifest.colour ?? undefined);
	return {
		key: JSON.stringify([manifest.emblem, colour ?? ""]),
		colour,
		emblem: () => interfaceEmblem(manifest.emblem, 34),
	};
}

/** Each page's colour; an agent's app takes the colour its manifest names (Jonas, 11 Nov 2026: black only had
 * "little distinction and contrast"). Charcoal and none draw in the text's colour. */
const PAGE_COLOURS: Record<string, string> = { mailbox: "blue", members: "purple", bank: "green", data: "purple" };

function pageEmblem(name: string, emblem: Emblem | null): Emblem | null {
	return name === "bank" ? "bank" : name === "data" ? "drawers" : emblem;
}

export function pageLook(name: string): AppLook {
	const colour = colourHex(PAGE_COLOURS[name]);
	const emblem = pageEmblem(name, null);
	return { key: JSON.stringify([emblem, colour ?? ""]), colour, emblem: () => interfaceEmblem(emblem, 34) };
}
function colourHex(colour: string | undefined): string | undefined {
	return colour && colour !== "charcoal" ? colourNameHex(colour) : undefined;
}

/** A group's tile: two stacked cards in its first app's colour, its name under it, and what waits inside. Open, the
 * cards fan apart (styles/interfaces.css). */
function groupIcon(name: string, count: number, colour: string | undefined): HTMLElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "34");
	svg.setAttribute("height", "34");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "interface-emblem group-emblem");
	const card = (cls: string, x: number, y: number) => {
		const rect = document.createElementNS(ns, "rect");
		for (const [attr, value] of Object.entries({ class: cls, x, y, width: 14, height: 14, rx: 3.5 }))
			rect.setAttribute(attr, String(value));
		svg.append(rect);
	};
	card("group-card-back", 7.5, 2.5);
	card("group-card-front", 2.5, 7.5);
	const waiting = count > 0 ? t("{count} waiting", { count }) : null;
	const tile = h(
		"button",
		{
			type: "button",
			class: "rail-app rail-app-group",
			"aria-expanded": "false",
			"aria-label": waiting ? `${t("Group {name}", { name })}, ${waiting}` : t("Group {name}", { name }),
		},
		h("span", { class: "rail-app-stand" }, svg, countBadge(count)),
		h("span", { class: "rail-app-name" }, name),
	);
	if (colour) tile.style.setProperty("--app-colour", colour);
	return tile;
}

/** Each tile on its way out of the drawer, and its fold into a group if it has one. The drawer draws a tile it shows
 * again with the same element, so a tile that comes back, or goes at the end of its way out, loses its fold (`fill`
 * holds the fold's end, small and clear, until cancelled), and only the latest way out ends one (review F1 on #1729). */
const leavingTiles = new WeakMap<HTMLElement, { readonly fold?: Animation }>();

/** A tile out of its way out: whole again, in the grid's flow, its fold cancelled. */
function unleave(element: HTMLElement): void {
	leavingTiles.get(element)?.fold?.cancel();
	leavingTiles.delete(element);
	element.classList.remove("is-leaving", "is-folding");
	for (const property of ["left", "top", "width"]) element.style.removeProperty(property);
}

/** Puts the drawer's tiles in the grid. When which tiles it shows changed (a group opened or folded, an app moved),
 * the tiles that stay glide to their new places, new ones grow in after them, and those that go fade where they stood. */
function placeTiles(parts: RailParts, drawn: readonly HTMLElement[]): void {
	const grid = parts.appsGrid;
	const keys = drawn.map((element) => element.dataset.appKey ?? "").join("\n");
	const changed = parts.appKeysShown !== undefined && parts.appKeysShown !== keys;
	parts.appKeysShown = keys;
	const animate = changed && parts.appsOpen && !reducedMotion() && typeof grid.animate === "function";
	const before = animate
		? new Map([...grid.children].map((child) => [child as HTMLElement, child.getBoundingClientRect()]))
		: undefined;
	const box = animate ? grid.getBoundingClientRect() : undefined;
	// A tile that went and comes back is an ordinary tile again.
	for (const element of drawn) if (element.classList.contains("is-leaving")) unleave(element);
	// A tile already on its way out (a group folded a moment ago) keeps that way out, its fold included (review F1,
	// round 3, on #1729), and stands in the grid until it ends, whatever is drawn meanwhile (round 4): another group
	// opening, or a draw that changes no tile, as the answer to the write that made a group is (14 Nov 2026).
	const kept = new Set(drawn);
	const going = ([...grid.children] as HTMLElement[]).filter(
		(element) => !kept.has(element) && leavingTiles.has(element),
	);
	// They stay where they stand, after the drawn tiles, never taken out and put back: that would start a plain fade
	// (a CSS animation) again from whole (review F1 on #1795).
	reconcile(grid, [...drawn, ...going]);
	// The draw gave each its key again: out of the drawer's order while it goes, as when it first left.
	for (const element of going) element.removeAttribute("data-app-key");
	// Folding a group: its tile, where its apps go back into (Jonas, 13 Nov 2026: "missing an animation when a group is
	// collapsing").
	const folding = parts.appFolding;
	parts.appFolding = undefined;
	if (!before || !box) return;
	const groupTile = folding ? drawn.find((element) => element.dataset.appKey === folding) : undefined;
	const target = groupTile?.querySelector(".rail-app-stand")?.getBoundingClientRect();
	let entering = 0;
	for (const element of drawn) {
		const was = before.get(element);
		if (!was || element.classList.contains("is-leaving")) {
			element.style.setProperty("--enter-i", String(entering++));
			element.classList.remove("is-entering");
			void element.offsetWidth;
			element.classList.add("is-entering");
			element.addEventListener("animationend", () => element.classList.remove("is-entering"), { once: true });
			continue;
		}
		const now = element.getBoundingClientRect();
		const dx = was.left - now.left;
		const dy = was.top - now.top;
		if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1)
			element.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
				duration: 400,
				easing: easing("--ease-out"),
			});
	}
	const centre = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
	const leaving = [...before].filter(([element]) => !kept.has(element) && !leavingTiles.has(element));
	// Into the group's tile, the nearest first (review F3 on #1729: the drawer's order is not the distance once a row
	// wraps).
	const into = target ? centre(target) : undefined;
	const far = (rect: DOMRect) => (into ? Math.hypot(centre(rect).x - into.x, centre(rect).y - into.y) : 0);
	const turn = new Map(
		[...leaving].sort(([, a], [, b]) => far(a) - far(b)).map(([element], index) => [element, index] as const),
	);
	for (const [element, was] of leaving) {
		// Out of the drawer's order while it fades: no drag counts it (each draw gives a tile its key again).
		element.removeAttribute("data-app-key");
		element.classList.add("is-leaving");
		element.style.left = `${was.left - box.left}px`;
		element.style.top = `${was.top - box.top}px`;
		element.style.width = `${was.width}px`;
		grid.append(element);
		let ms = 240;
		let fold: Animation | undefined;
		if (into) {
			// Into the group's tile: each app shrinks and goes back behind it, a moment after the one nearer it.
			const from = centre(element.querySelector(".rail-app-stand")?.getBoundingClientRect() ?? was);
			const dx = into.x - from.x;
			const dy = into.y - from.y;
			const delay = Math.min(turn.get(element) ?? 0, 6) * 18;
			element.classList.add("is-folding");
			fold = element.animate(
				[
					{ translate: "0 0", scale: "1", opacity: 1 },
					{ opacity: 1, offset: 0.4 },
					{ translate: `${dx}px ${dy}px`, scale: "0.2", opacity: 0 },
				],
				{ duration: 340, delay, easing: easing("--ease-out"), fill: "both" },
			);
			ms = 340 + delay + 20;
		}
		const leave = { fold };
		leavingTiles.set(element, leave);
		setTimeout(() => {
			// Come back meanwhile, or gone again on a newer way out: not this one's to end.
			if (leavingTiles.get(element) !== leave) return;
			element.remove();
			unleave(element);
		}, ms);
	}
}

/** The member's document as the next change builds on it: without the places the drawer's arrangement refused. */
function ownAppLayout(company: CompanyController, parts: RailParts): MemberAppLayout | undefined {
	const layout = company.store.get().appLayout?.layout;
	return layout && withoutRefused(layout, parts.appRefused);
}

/** Whether the drawer's arrangement is the member's own to change (20260930728000). */
function appsArrangeable(company: CompanyController): boolean {
	const state = company.store.get();
	return Boolean(
		state.appLayout && !state.appLayoutUnavailable && company.ownSidebar() && !company.resettingSidebar(),
	);
}

function toggleAppGroup(company: CompanyController, parts: RailParts, id: string): void {
	if (parts.appGroupsOpen.has(id)) {
		parts.appGroupsOpen.delete(id);
		// A group inside folds with it.
		const group = parts.appTree.length
			? groupsOf(parts.appTree).find((entry) => entry.group.id === id)?.group
			: undefined;
		for (const inner of group ? groupsOf(group.items) : []) parts.appGroupsOpen.delete(inner.group.id);
		parts.appFolding = groupKey(id);
	} else parts.appGroupsOpen.add(id);
	storeGroupsOpen(company.profile.profileId, parts.appGroupsOpen);
	parts.redraw();
}

/** A drag or Alt-arrow move in the drawer: the moved tile joins the group of the tile before it (the group itself when
 * that tile is an open group's), standing after it. */
function moveInDrawer(company: CompanyController, parts: RailParts, order: readonly string[], moved: string): void {
	const layout = ownAppLayout(company, parts);
	if (!layout) return;
	const keys = order.map(fileKey);
	const key = fileKey(moved);
	const at = keys.indexOf(key);
	const previous = at > 0 ? parts.appTiles.find((tile) => tile.key === keys[at - 1]) : undefined;
	let group: string | null = null;
	let after: string | null = null;
	if (previous?.node.kind === "group" && previous.open) group = previous.node.id;
	else if (previous) {
		group = previous.chain.at(-1) ?? null;
		after = previous.key;
	}
	// A group never goes into itself; the drawer draws it back where it was.
	if (isGroupKey(key) && (group === groupIdOf(key) || previous?.chain.includes(groupIdOf(key)))) return;
	void company.changeAppLayout(placeApp(layout, parts.appTree, key, group, after));
}

/** An app held over another app makes a group of the two; over a group, goes into it. A group never goes into a group
 * this way, and no group stands deeper than one group in. */
function canMergeApps(parts: RailParts, dragged: string, onto: string): boolean {
	const from = parts.appTiles.find((tile) => tile.key === fileKey(dragged));
	const to = parts.appTiles.find((tile) => tile.key === fileKey(onto));
	if (!from || !to || from === to || from.node.kind === "group") return false;
	return to.node.kind === "group" || to.chain.length < 2;
}

function mergeApps(company: CompanyController, parts: RailParts, dragged: string, onto: string): void {
	const layout = ownAppLayout(company, parts);
	const to = parts.appTiles.find((tile) => tile.key === fileKey(onto));
	if (!layout || !to) return;
	const key = fileKey(dragged);
	if (to.node.kind === "group") {
		const last = to.node.items.at(-1);
		void company.changeAppLayout(placeApp(layout, parts.appTree, key, to.node.id, last ? nodeKey(last) : null));
		return;
	}
	const nameOf = (drawer: string) =>
		parts.appsGrid.querySelector(`[data-app-key="${drawer}"] .rail-app-name`)?.textContent ?? "";
	// Letting go makes the group at once, named from the two apps (Jonas, 12 Nov 2026: "if i drag interfaces over each
	// other and let go it should create a group"); Rename group in its menu changes the name. It starts folded, the two
	// apps going into its tile as a folding group's do (Jonas, 14 Nov 2026: "it should also start out collapsed").
	const name = suggestGroupName(nameOf(onto), nameOf(dragged), t("Group"));
	const id = `m-${crypto.randomUUID().slice(0, 8)}`;
	parts.appFolding = groupKey(id);
	void company.changeAppLayout(makeAppGroup(layout, parts.appTree, key, to.key, name, id));
}

/** A page's icon in the drawer: its emblem with its name under it. */
function appIcon(entry: CompanyInterface, href: string, count: number): HTMLElement {
	const file = entry.file;
	const waiting = count > 0 ? t("{count} waiting", { count }) : null;
	return h(
		"a",
		{
			class: "rail-app",
			href,
			draggable: "false",
			"data-interface-page": entry.name,
			...(waiting ? { "aria-label": `${file.name}, ${waiting}` } : {}),
		},
		h(
			"span",
			{ class: "rail-app-stand" },
			interfaceEmblem(pageEmblem(entry.name, file.emblem), 34),
			countBadge(count),
		),
		h("span", { class: "rail-app-name" }, file.name),
	);
}

/** An agent's posted app in the drawer: its emblem with its name under it, a link to the app's own page. A press on
 * the icon of the app that is already open reads the app again (application.ts follows a link to the open app's page
 * that way): the app's page has no Reload of its own. */
function agentAppIcon(manifest: AppManifest, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-app",
			href,
			draggable: "false",
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem(manifest.emblem, 34)),
		h("span", { class: "rail-app-name" }, manifest.name),
	);
}

/** The Concepts entry in the drawer: the concepts' emblem with "Concepts" under it, a link to the Concepts viewer. */
function conceptsIcon(href: string): HTMLElement {
	const label = t("Concepts");
	return h(
		"a",
		{
			class: "rail-app rail-concepts",
			href,
			draggable: "false",
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem("board", 34)),
		h("span", { class: "rail-app-name" }, label),
	);
}

/** The Sites entry in the drawer: a globe with "Sites" under it, a link to the Sites page. */
function sitesIcon(href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-app rail-sites",
			href,
			draggable: "false",
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem("globe", 34)),
		h("span", { class: "rail-app-name" }, t("Sites")),
	);
}

/** A website in the owed row: the Sites globe with the site's title under it, a link to the site's own view. */
function websiteIcon(name: string, href: string): HTMLElement {
	return h(
		"a",
		{ class: "rail-app rail-website", href, draggable: "false" },
		h("span", { class: "rail-app-stand" }, interfaceEmblem("globe", 34)),
		h("span", { class: "rail-app-name" }, name),
	);
}

/** The What's new entry in the drawer: its spark with "What's new" under it and how many changes are ready, a link to
 * the page. */
function whatsNewIcon(href: string, count: number): HTMLElement {
	const label = t("What's new");
	const waiting = count > 0 ? t("{count} waiting", { count }) : null;
	return h(
		"a",
		{
			class: "rail-app rail-whats-new",
			href,
			draggable: "false",
			...(waiting ? { "aria-label": `${label}, ${waiting}` } : {}),
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem("spark", 34), countBadge(count)),
		h("span", { class: "rail-app-name" }, label),
	);
}

/* ---- The rail's menus and dragging --------------------------------------------------- */

const newSectionId = () => crypto.randomUUID();

function sameName(sidebar: CompanySidebar, name: string, except?: string) {
	return sidebar.sections.find(
		(section) => section.sectionId !== except && section.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
	);
}

/** What the rail places: an agent, a group chat or a member contact, known by the row it was picked from. */
interface RailItem {
	id: string;
	kind: "agent" | "room" | "member";
}
/** An agent or a group chat: what the company's sidebar itself places, pins and hides. A contact's place is its
 * member's own (app/rail-contacts.ts). */
interface SidebarItem {
	id: string;
	kind: "agent" | "room";
}

/** The item a rail element stands for, by its data attribute. */
function railItemOf(element: HTMLElement | undefined): RailItem | undefined {
	const agentId = element?.dataset.agentId;
	const roomId = element?.dataset.roomId;
	const memberId = element?.dataset.memberId;
	return agentId
		? { id: agentId, kind: "agent" }
		: roomId
			? { id: roomId, kind: "room" }
			: memberId
				? { id: memberId, kind: "member" }
				: undefined;
}

/** The company's other members this member has a chat with, in the order they joined, and each as a contact where
 * the rail draws it. */
function companyContacts(company: CompanyController) {
	const state = company.store.get();
	const chats = state.memberChatsUnavailable ? undefined : state.memberChats;
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const others = new Map(
		(state.team?.members ?? [])
			.filter((member) => member.userId !== company.userId && chats?.[member.userId])
			.map((member) => [member.userId, member]),
	);
	const contacts = railContacts(
		[...others.keys()],
		chats ?? {},
		sidebar ? new Set(sidebar.sections.map((item) => item.sectionId)) : undefined,
	);
	return { others, contacts };
}

/** The member's chats, where the cloud keeps contacts' places (20260930717000): what a contact's menu, drag and
 * Alt-arrow need. Undefined on a cloud that keeps none: contacts stay where the cloud lists them. */
function placedChats(company: CompanyController) {
	const state = company.store.get();
	return state.memberChatsUnavailable || state.memberContactPlacing !== true ? undefined : state.memberChats;
}

/** The pinned row or the Members group as the company holds it, whatever a search hides: the pinned agents and group
 * chats the company still has, with the member's contacts that show there among them. A menu's Pin and Unpin put a
 * contact after these. */
function keptOrder(company: CompanyController, zone: "pinned" | typeof MEMBERS_ZONE): string[] {
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const roster = company.sidebarRoster();
	return weave(
		zone === "pinned" ? (sidebar?.pinned ?? []).filter((itemId) => roster.includes(itemId)) : [],
		companyContacts(company).contacts.filter((contact) => contact.zone === zone && !contact.hidden),
	);
}

/** Whether the pinned row has room for one more card. It holds PIN_LIMIT of them, whatever they are: the pinned
 * agents and group chats and the member's pinned contacts count alike, by drag and from a menu or a card. */
const pinnedRowFull = (company: CompanyController) => keptOrder(company, "pinned").length >= PIN_LIMIT;

/** Keeps the member's contacts where a zone's rows stand after a drop or a step (`order`, as the member sees the
 * zone then): each after the agent or group chat before it. `show` names a contact that shows again there. */
function settleContacts(company: CompanyController, zone: string, order: readonly string[], show?: string): void {
	const chats = placedChats(company);
	if (!chats) return;
	const changes = contactPlaces(zone, order, chats, show);
	if (changes.length) placeContacts(company, changes);
}

/** Keeps places the member just made; what an earlier try said in the rail goes with the new one. */
function placeContacts(company: CompanyController, changes: readonly MemberContactPlacing[]): void {
	company.reportRailError(undefined);
	company.memberChats.place(changes);
}

/** A contact's menu: Pin or Unpin where the rail has a pinned row, and Hide from sidebar (Show in sidebar, for a
 * hidden one). It is the member's own rail, so any member may. Moving is a drag, or Alt with an arrow. Nothing to
 * offer on a cloud that keeps no places. */
function contactMenu(company: CompanyController, userId: string): MenuEntry[] {
	const contact = companyContacts(company).contacts.find((item) => item.userId === userId);
	if (!contact || !placedChats(company)) return [];
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const items: MenuEntry[] = [];
	if (sidebar && !contact.hidden && contact.zone === "pinned")
		items.push({
			label: t("Unpin"),
			icon: "unpin",
			// Back to the Members group, after the contacts there.
			select: () => settleContacts(company, MEMBERS_ZONE, [...keptOrder(company, MEMBERS_ZONE), userId]),
		});
	else if (sidebar && !contact.hidden)
		items.push({
			label: t("Pin"),
			icon: "pin",
			select: () => {
				if (pinnedRowFull(company)) company.reportRailError(t("The pinned row is full. Unpin something first."));
				else settleContacts(company, "pinned", [...keptOrder(company, "pinned"), userId]);
			},
		});
	items.push({
		label: contact.hidden ? t("Show in sidebar") : t("Hide from sidebar"),
		icon: contact.hidden ? "show" : "hide",
		select: () => {
			// Hidden, a contact keeps its place: shown again, it stands where it stood. Not in the pinned row: a hidden
			// contact loses its pin, as a hidden agent does, so the row's cards are always the ones that show. (A
			// contact another page left hidden with its pin comes back to the row only while it has room.)
			const unpinned =
				contact.zone === "pinned" && (!contact.hidden || pinnedRowFull(company))
					? contactPlaces(MEMBERS_ZONE, [...keptOrder(company, MEMBERS_ZONE), userId], placedChats(company) ?? {})
					: undefined;
			placeContacts(
				company,
				unpinned
					? unpinned.map((change) => (change.userId === userId ? { ...change, hidden: !contact.hidden } : change))
					: [{ userId, place: contact.place, hidden: !contact.hidden }],
			);
		},
	});
	return items;
}

/** Moves an agent or a group chat: the sidebar names each by its own kind of id. */
function moveRequest(
	item: SidebarItem,
	sectionId: string | null,
	options: { order?: string[]; unpin?: boolean } = {},
): SidebarRequest {
	return item.kind === "room"
		? { action: "move_room", roomId: item.id, sectionId, ...options }
		: { action: "move_agent", staffAgentId: item.id, sectionId, ...options };
}

function hideRequest(item: SidebarItem, hidden: boolean): SidebarRequest {
	return item.kind === "room"
		? { action: "set_hidden", roomId: item.id, hidden }
		: { action: "set_hidden", staffAgentId: item.id, hidden };
}

/** Asks for a new section's name and makes it; with an agent or a group chat, moves it
 * into the section (a name that already exists moves it there instead). */
async function askSectionName(company: CompanyController, item?: SidebarItem): Promise<void> {
	const name = await nameDialog({
		title: t("New section"),
		label: t("Section name"),
		confirm: t("Create"),
		maxLength: SECTION_NAME_LIMIT,
		signal: company.signal,
	});
	const sidebar = company.store.get().sidebar;
	if (!name || !sidebar) return;
	// A pinned item leaves the pinned row for its section, as when it is dragged there;
	// a hidden one is shown again.
	const unpin = item && sidebar.pinned.includes(item.id) ? { unpin: true } : {};
	if (item && sidebar.hidden.includes(item.id)) void company.changeSidebar(hideRequest(item, false));
	const existing = sameName(sidebar, name);
	if (existing && item) {
		// Naming a section that exists moves the item there.
		void company.changeSidebar(moveRequest(item, existing.sectionId, unpin));
		return;
	}
	if (existing) {
		company.reportRailError(t("A section called {name} already exists.", { name: `"${existing.name}"` }));
		return;
	}
	const placed = !item
		? {}
		: item.kind === "room"
			? { roomId: item.id, ...unpin }
			: { staffAgentId: item.id, ...unpin };
	void company.changeSidebar({ action: "create_section", sectionId: newSectionId(), name, ...placed });
}

/** Whether the member may change sections and places: always in their own sidebar (20260930727000); on an older
 * cloud, where a change is the company's, with the right to write. */
function canOrganize(company: CompanyController): boolean {
	const state = company.store.get();
	return company.ownSidebar() || Boolean(state.sidebar && !state.sidebarUnavailable && state.team?.capabilities.write);
}

/** Reset sidebar (Jonas, 11 Nov 2026): back to the company's sidebar, from the menu of the rail's empty space and of a
 * section's title. With nothing of the member's own it shows greyed out and says why. */
function resetEntries(company: CompanyController, parts: RailParts): MenuEntry[] {
	const own = company.ownSidebar() ? company.store.get().sidebar?.own : undefined;
	if (!own) return [];
	const changes = own.changes + (storedAppsOrder(company.profile.profileId).length ? 1 : 0);
	return [
		{ kind: "separator" },
		changes
			? {
					label: t("Reset sidebar…"),
					icon: "reset",
					hint: changes === 1 ? t("1 change of yours") : t("{count} changes of yours", { count: changes }),
					select: () => void askResetSidebar(company, parts),
				}
			: {
					label: t("Reset sidebar"),
					icon: "reset",
					hint: t("You have {company}'s sidebar", { company: companyInSentence(company.profile.profileName) }),
					disabled: true,
					select: () => {},
				},
	];
}

/** What a reset takes away, one line each, in the member's words. */
function ownChangeLines(company: CompanyController, own: SidebarOwnChanges): string[] {
	const lines: string[] = [];
	const rooms = company.groupChatRooms();
	const names = own.moved
		.map((id) => company.staffById(id)?.displayName ?? rooms.get(id)?.title)
		.filter((name): name is string => Boolean(name));
	if (names.length === 1) lines.push(t("{name} where you put it", { name: names[0]! }));
	else if (names.length > 1)
		lines.push(
			names.length <= 3
				? t("{names} where you put them", { names: names.join(", ") })
				: t("{count} agents and group chats where you put them", { count: names.length }),
		);
	for (const section of own.sections) {
		if (section.change === "added") lines.push(t("Your section {name}", { name: `"${section.name}"` }));
		else if (section.change === "renamed")
			lines.push(t("{from} renamed {name}", { from: `"${section.from ?? ""}"`, name: `"${section.name}"` }));
		else lines.push(t("{name} removed from your sidebar", { name: `"${section.name}"` }));
	}
	if (own.pinned) lines.push(own.pinned === 1 ? t("1 pinned") : t("{count} pinned", { count: own.pinned }));
	if (own.hidden) lines.push(own.hidden === 1 ? t("1 hidden") : t("{count} hidden", { count: own.hidden }));
	if (own.contacts)
		lines.push(
			own.contacts === 1
				? t("1 member placed or hidden")
				: t("{count} members placed or hidden", { count: own.contacts }),
		);
	if (own.pages) lines.push(own.pages === 1 ? t("1 page hidden") : t("{count} pages hidden", { count: own.pages }));
	if (own.apps)
		lines.push(
			own.apps === 1 ? t("1 app or group arranged") : t("{count} apps or groups arranged", { count: own.apps }),
		);
	if (storedAppsOrder(company.profile.profileId).length) lines.push(t("The order of your apps"));
	return lines;
}

/** Asks first, listing what goes, then resets: the cloud takes the member's changes away and the apps drawer's order
 * on this device goes with them. The rail then offers Undo. */
async function askResetSidebar(company: CompanyController, parts: RailParts): Promise<void> {
	const own = company.store.get().sidebar?.own;
	if (!own) return;
	const sure = await confirmDialog(
		t("Reset your sidebar? These changes of yours go away, and you get {company}'s sidebar:", {
			company: companyInSentence(company.profile.profileName),
		}),
		t("Reset"),
		false,
		undefined,
		company.signal,
		ownChangeLines(company, own),
	);
	if (!sure) return;
	const profileId = company.profile.profileId;
	const appsOrder = storedAppsOrder(profileId);
	if (!(await company.resetSidebar())) return;
	storeAppsOrder(profileId, []);
	parts.appsOrder = [];
	parts.context?.refreshInterfacePages?.();
	company.store.set({ sidebarReset: { appsOrder } });
}

/** Undo of the reset just made: the member's changes come back, and the apps' order on this device too unless the
 * member ordered them again since. A failed Undo keeps its offer, to try again. */
async function undoSidebarReset(company: CompanyController, parts: RailParts): Promise<void> {
	const reset = company.store.get().sidebarReset;
	if (!reset || reset.undoing) return;
	const undoing = { ...reset, undoing: true };
	company.store.set({ sidebarReset: undoing });
	if (!(await company.resetSidebar(true))) {
		// Tried again from the same offer, unless a newer one (or nothing) took its place meanwhile.
		if (company.store.get().sidebarReset === undoing) company.store.set({ sidebarReset: reset });
		return;
	}
	const profileId = company.profile.profileId;
	if (!storedAppsOrder(profileId).length) {
		storeAppsOrder(profileId, reset.appsOrder);
		parts.appsOrder = reset.appsOrder;
	}
	parts.context?.refreshInterfacePages?.();
	company.store.set({ sidebarReset: undefined });
}

/** An agent's card from the rail: Pin or Unpin and Hide (or Show, for a hidden agent) where the member has a
 * sidebar, its conversation's id to copy, and Delete for owners and admins. Pinning and moving are drags; the name edits on the card. */
/** Pin or unpin from a card: this member's own pins, so no edit rights are needed, and a tap works where a drag
 * can't (a phone). Nothing to offer when the pinned row is full and the item is not in it. The click reads the
 * sidebar as it is then: a card stays open across refreshes, and another tab may have pinned meanwhile. */
function pinActions(company: CompanyController, sidebar: CompanySidebar, itemId: string): CardFootActions {
	const pinned = sidebar.pinned.includes(itemId);
	if (!pinned && pinnedRowFull(company)) return {};
	return {
		pinned,
		pin: () => {
			const now = company.store.get();
			const current = now.sidebarUnavailable ? undefined : now.sidebar;
			if (!current) return;
			// A pin list can still name an item deleted since it was read; the cloud refuses those.
			const roster = company.sidebarRoster();
			const pins = current.pinned.filter((pin) => roster.includes(pin));
			// What the card offered: already done elsewhere meanwhile is nothing to send.
			if (pinned !== pins.includes(itemId)) return;
			if (!pinned && pinnedRowFull(company)) {
				company.reportRailError(t("The pinned row is full. Unpin something first."));
				return;
			}
			void company.changeSidebar({
				action: "set_pins",
				order: pinned ? pins.filter((pin) => pin !== itemId) : [...pins, itemId],
			});
		},
	};
}

function agentCard(company: CompanyController, parts: RailParts, agent: HostedStaffAgent): AgentCardActions {
	const state = company.store.get();
	const actions = parts.context?.agentActions;
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const isCofounder = agent.id === company.cofounderId();
	const item: SidebarItem = { id: agent.id, kind: "agent" };
	const hidden = Boolean(sidebar?.hidden.includes(agent.id));
	const conversationId = company.primarySessionFor(agent.id)?.sessionId;
	return {
		...(conversationId ? { conversationId } : {}),
		...(sidebar && !isCofounder ? pinActions(company, sidebar, agent.id) : {}),
		...(sidebar && !isCofounder
			? { hidden, hide: () => void company.changeSidebar(hideRequest(item, !hidden)) }
			: {}),
		...(!isCofounder && state.team?.capabilities.authorize === true && actions?.deleteAgent
			? { remove: () => void deleteAgent(company, parts, agent) }
			: {}),
	};
}

/** A group chat's card from the rail: its conversation's id to copy, Pin or Unpin and Hide (or Show) where the
 * cloud places group chats, and Delete for owners and admins. Moving is a drag; the name edits on the card. */
function groupCard(
	company: CompanyController,
	parts: RailParts,
	session: HostedSession,
	roomId: string,
): CardFootActions {
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const placeable = Boolean(sidebar?.groupChats) && company.groupChatRooms().has(roomId);
	const canAuthorize = state.team?.capabilities.authorize === true && state.team.capabilities.write === true;
	const item: SidebarItem = { id: roomId, kind: "room" };
	const hidden = Boolean(sidebar?.hidden.includes(roomId));
	return {
		conversationId: session.sessionId,
		...(placeable ? pinActions(company, sidebar!, roomId) : {}),
		...(placeable ? { hidden, hide: () => void company.changeSidebar(hideRequest(item, !hidden)) } : {}),
		...(canAuthorize && parts.context?.agentActions?.deleteGroup
			? { remove: () => void deleteGroup(company, parts, session, roomId) }
			: {}),
	};
}

async function deleteGroup(
	company: CompanyController,
	parts: RailParts,
	session: HostedSession,
	roomId: string,
): Promise<void> {
	const remove = parts.context?.agentActions?.deleteGroup;
	if (!remove) return;
	const confirmed = await confirmDialog(
		t("Delete {name}? The group chat is removed for everyone. This cannot be undone.", { name: session.title }),
		t("Delete"),
		true,
		undefined,
		company.signal,
	);
	if (!confirmed) return;
	try {
		await remove(session.sessionId, roomId, company.signal);
		const route = parts.context?.route;
		// The deleted group chat has nothing left to show.
		if (route?.name === "company" && route.section === "chat" && route.id === session.sessionId)
			location.hash = `#/c/${company.profile.profileId}`;
		// The cloud closes the conversation and drops the group chat from every sidebar.
		await Promise.all([company.refreshSessions(), company.refreshSidebar()]);
	} catch {
		if (!company.signal.aborted) company.reportRailError(t("{name} could not be deleted.", { name: session.title }));
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

function sectionMenu(company: CompanyController, parts: RailParts, sectionId: string): MenuEntry[] {
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
				const name = `"${section.name}"`;
				// In the member's own sidebar (20260930727000) nobody else's changes.
				const question = !company.ownSidebar()
					? t(
							"Delete the section {name}? Its agents and group chats move to Unassigned, for everyone in the company.",
							{ name },
						)
					: section.mine
						? t(
								"Delete your section {name}? Its agents and group chats go back to where the company keeps them.",
								{ name },
							)
						: t(
								"Remove {name} from your sidebar? Its agents and group chats move to Unassigned. Nobody else's sidebar changes.",
								{ name },
							);
				if (await confirmDialog(question, t("Delete section"), true, undefined, company.signal))
					void company.changeSidebar({ action: "delete_section", sectionId });
			},
		},
		...resetEntries(company, parts),
	];
}

/** Right-click anywhere in the rail list: an agent, a group chat, a contact, a section's title, or the rail itself. */
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
	const roomElement = target.closest<HTMLElement>("[data-room-id]");
	const titleElement = target.closest<HTMLElement>(".rail-section-title[data-section-id]");
	const pageElement = target.closest<HTMLElement>("[data-interface-page]");
	const memberElement = target.closest<HTMLElement>("[data-member-id]");
	let items: MenuEntry[] = [];
	let label = t("Sidebar");
	let opener: HTMLElement = parts.list;
	let findOpener: (() => HTMLElement | null) | undefined;
	if (memberElement?.dataset.memberId) {
		const userId = memberElement.dataset.memberId;
		// The row is rebuilt when a message arrives; focus goes back to the new one, in the zone it was opened from.
		const prefix = memberElement.closest(".rail-hidden") ? ".rail-hidden " : "";
		items = contactMenu(company, userId);
		label = t("{name} actions", { name: memberElement.querySelector("strong")?.textContent ?? t("Members") });
		opener = memberElement;
		findOpener = () => parts.list.querySelector<HTMLElement>(`${prefix}[data-member-id="${userId}"]`);
	} else if (agentElement) {
		const agent = company.staffById(agentElement.dataset.agentId ?? agentElement.dataset.cofounderId);
		const open = parts.context?.openAgentCard;
		if (agent && open) {
			event.preventDefault();
			// The row is rebuilt when the agent's state changes; focus goes back to the new one.
			open(agent, agentElement, agentCard(company, parts, agent), () =>
				parts.list.querySelector<HTMLElement>(`[data-agent-id="${agent.id}"], [data-cofounder-id="${agent.id}"]`),
			);
		}
		return;
	} else if (roomElement?.dataset.roomId) {
		const roomId = roomElement.dataset.roomId;
		const session = company.store
			.get()
			.sessions.find((item) => isGroupChat(item) && String(item.executionScope?.roomId).toLowerCase() === roomId);
		const open = parts.context?.openGroupCard;
		if (session && open) {
			event.preventDefault();
			// The row is rebuilt when the group changes; focus goes back to the new one.
			open(session, roomElement, groupCard(company, parts, session, roomId), () =>
				parts.list.querySelector<HTMLElement>(`[data-room-id="${roomId}"]`),
			);
		}
		return;
	} else if (pageElement?.dataset.interfacePage) {
		// A hidden page, in Hidden.
		openPageMenu(company, parts, pageElement, event);
		return;
	} else if (titleElement?.dataset.sectionId) {
		const sectionId = titleElement.dataset.sectionId;
		items = sectionMenu(company, parts, sectionId);
		label = t("{name} actions", { name: titleElement.textContent ?? t("Section") });
		opener = titleElement;
		findOpener = () => parts.list.querySelector<HTMLElement>(`.rail-section-title[data-section-id="${sectionId}"]`);
	} else if (!target.closest("a[href], a[data-href], button, input") && canOrganize(company)) {
		items = [
			{ label: t("New section"), icon: "section_plus", select: () => void askSectionName(company) },
			...resetEntries(company, parts),
		];
	}
	// Nothing to offer: the browser's own menu stays.
	if (!items.length) return;
	event.preventDefault();
	const point = menuPoint(event, opener);
	openContextMenu({ label, x: point.x, y: point.y, items, opener, ...(findOpener ? { findOpener } : {}) });
}

/** Right-click in the apps drawer. Where the member arranges their own drawer (20260930728000): an app offers Move to
 * (each group, or loose) and a page also Hide; a group offers Rename and Ungroup; both end with Reset sidebar. Before
 * that, a page offers to hide it, and the agents' apps and Concepts offer nothing. */
function openDrawerMenu(company: CompanyController, parts: RailParts, event: MouseEvent): void {
	if (event.shiftKey && (event.clientX || event.clientY)) return;
	const tile = (event.target as Element).closest<HTMLElement>("[data-app-key]");
	if (!appsArrangeable(company) || !tile) {
		const element = (event.target as Element).closest<HTMLElement>("[data-interface-page]");
		if (element) openPageMenu(company, parts, element, event);
		return;
	}
	const key = fileKey(tile.dataset.appKey!);
	const name = tile.querySelector(".rail-app-name")?.textContent ?? key;
	// A group takes a colour of the member's own; an app its icon and colour in one panel (12 Nov 2026), where an app in a
	// group sets the group's colour.
	const items: MenuEntry[] = isGroupKey(key)
		? groupMenu(company, parts, groupIdOf(key))
		: [moveToMenu(company, parts, key), lookMenu(company, parts, key), ...pageMenuItems(company, parts, tile)];
	if (!items.length) return;
	event.preventDefault();
	const point = menuPoint(event, tile);
	const drawer = tile.dataset.appKey!;
	openContextMenu({
		label: t("{name} actions", { name }),
		x: point.x,
		y: point.y,
		opener: tile,
		findOpener: () => parts.appsGrid.querySelector<HTMLElement>(`[data-app-key="${drawer}"]`),
		items: [...items, ...resetEntries(company, parts)],
	});
}

/** Move to: loose in the drawer, or any group, the one it is in checked. */
function moveToMenu(company: CompanyController, parts: RailParts, key: string): MenuEntry {
	const here = parts.appTiles.find((tile) => tile.key === key)?.chain.at(-1) ?? null;
	const move = (group: string | null) => () => {
		const layout = ownAppLayout(company, parts);
		if (!layout || group === here) return;
		const target = group ? groupsOf(parts.appTree).find((entry) => entry.group.id === group)?.group : undefined;
		const last = target ? target.items.at(-1) : parts.appTree.at(-1);
		void company.changeAppLayout(placeApp(layout, parts.appTree, key, group, last ? nodeKey(last) : null));
	};
	return {
		kind: "submenu",
		label: t("Move to"),
		icon: "section_plus",
		items: [
			{ label: t("No group"), checked: here === null, select: move(null) },
			...groupsOf(parts.appTree).map(({ group, depth }) => ({
				label: depth ? `${"\u2002".repeat(depth * 2)}${group.name}` : group.name,
				checked: here === group.id,
				select: move(group.id),
			})),
		],
	};
}

/** Colour for a group: the member's own colour for it and so for everything in it (Jonas, 12 Nov 2026), from the
 * palette row the apps' Icon and colour panel has; Default takes the member's choice away. */
function groupColourMenu(company: CompanyController, parts: RailParts, id: string): MenuEntry {
	const key = groupKey(id);
	return {
		kind: "panel",
		label: t("Colour"),
		icon: "palette",
		panel: () =>
			appLookPanel(
				() => ({
					ink:
						parts.appsGrid
							.querySelector<HTMLElement>(`[data-app-key="${key}"]`)
							?.style.getPropertyValue("--app-colour") || undefined,
					colour: {
						chosen: company.store.get().appLayout?.layout.colours?.[key] ?? null,
						choose: (colour) => {
							const mine = ownAppLayout(company, parts);
							if (mine && (mine.colours?.[key] ?? null) !== colour)
								void company.changeAppLayout(colourApp(mine, key, colour));
						},
					},
				}),
				(redraw) => company.store.subscribe(redraw),
			),
	};
}

/** Icon and colour (12 Nov 2026; ui/app-look-picker.ts): the member's own colour (an app in a group: the group's) and
 * icon for an entry of the drawer, and for an agent's app its own icons and Generate icon. Each choice is written to
 * the member's own layout at once; the panel follows the store while it is open. */
function lookMenu(company: CompanyController, parts: RailParts, key: string): MenuEntry {
	const appName = key.startsWith("app:") ? key.slice("app:".length) : undefined;
	const tileOf = () => parts.appsGrid.querySelector<HTMLElement>(`[data-app-key="${drawerKey(key)}"]`);
	return {
		kind: "panel",
		label: t("Icon and colour"),
		icon: "palette",
		panel: () => {
			if (appName) void company.loadAppIcons(appName);
			return appLookPanel(
				() => {
					const state = company.store.get();
					const layout = state.appLayout?.layout;
					const groupId = parts.appTiles.find((entry) => entry.key === key)?.chain.at(-1);
					const group = groupId
						? groupsOf(parts.appTree).find((entry) => entry.group.id === groupId)?.group
						: undefined;
					const colourKey = group ? groupKey(group.id) : key;
					const app = appName ? state.apps?.find((entry) => entry.name === appName) : undefined;
					const owner = app?.manifest?.owner
						? state.staff.find((agent) => agent.id === app.manifest?.owner && agent.employmentStatus === "active")
						: undefined;
					return {
						ink: tileOf()?.style.getPropertyValue("--app-colour") || undefined,
						colour: {
							chosen: layout?.colours?.[colourKey] ?? null,
							...(group ? { group: group.name } : {}),
							choose: (colour) => {
								const mine = ownAppLayout(company, parts);
								if (mine && (mine.colours?.[colourKey] ?? null) !== colour)
									void company.changeAppLayout(colourApp(mine, colourKey, colour));
							},
						},
						emblem: {
							own: (tileOf()?.dataset.ownEmblem ?? "page") as Emblem,
							chosen: layout?.emblems?.[key] ?? null,
							choose: (choice) => {
								const mine = ownAppLayout(company, parts);
								if (mine && (mine.emblems?.[key] ?? null) !== choice)
									void company.changeAppLayout(emblemApp(mine, key, choice));
							},
						},
						...(app?.manifest
							? {
									made: {
										icons: state.appIcons?.[app.name] ?? [],
										drawing: Boolean(state.appIconsDrawing?.[app.name]),
										agent: owner?.displayName ?? t("The Co-Founder"),
										generate: async () => {
											const asked = await company.requestAppIcons(app);
											return asked.ok ? null : asked.reason;
										},
									},
								}
							: {}),
					};
				},
				(redraw) => company.store.subscribe(redraw),
			);
		},
	};
}

/** A group's menu: Rename group, Colour and Ungroup, in the member's own drawer. */
function groupMenu(company: CompanyController, parts: RailParts, id: string): MenuEntry[] {
	const group = groupsOf(parts.appTree).find((entry) => entry.group.id === id)?.group;
	if (!group) return [];
	const companyTree = (company.store.get().appGroups ?? []) as AppTreeNode[];
	const companyName = groupsOf(companyTree).find((entry) => entry.group.id === id)?.group.name;
	return [
		{
			label: t("Rename group"),
			icon: "edit",
			select: async () => {
				const name = await nameDialog({
					title: t("Rename group"),
					label: t("Group name"),
					value: group.name,
					confirm: t("Rename"),
					maxLength: APP_GROUP_NAME_LIMIT,
					signal: company.signal,
				});
				const layout = ownAppLayout(company, parts);
				if (name && layout) void company.changeAppLayout(renameAppGroup(layout, id, name, companyName));
			},
		},
		groupColourMenu(company, parts, id),
		{
			label: t("Ungroup"),
			icon: "grid",
			select: () => {
				const layout = ownAppLayout(company, parts);
				if (!layout) return;
				parts.appGroupsOpen.delete(id);
				storeGroupsOpen(company.profile.profileId, parts.appGroupsOpen);
				void company.changeAppLayout(ungroupApps(layout, parts.appTree, id));
			},
		},
	];
}

/** A page's menu: Hide from sidebar in the drawer, Show in sidebar in Hidden. It changes the member's own rail only;
 * nothing the page showed is removed. On a cloud from before each member's own choice, the browser's own menu. */
function openPageMenu(company: CompanyController, parts: RailParts, element: HTMLElement, event: MouseEvent): void {
	const items = pageMenuItems(company, parts, element);
	if (!items.length) return;
	event.preventDefault();
	const page = element.dataset.interfacePage as InterfacePageName;
	const shown = parts.appsDrawer.contains(element);
	const name = element.dataset.pageName ?? element.querySelector(".rail-app-name")?.textContent ?? page;
	const point = menuPoint(event, element);
	openContextMenu({
		label: t("{name} actions", { name }),
		x: point.x,
		y: point.y,
		opener: element,
		findOpener: () =>
			(shown ? parts.appsDrawer : parts.list).querySelector<HTMLElement>(`[data-interface-page="${page}"]`),
		items,
	});
}

/** Hide from sidebar (or Show in sidebar, in Hidden) for a page; nothing for anything else. */
function pageMenuItems(company: CompanyController, parts: RailParts, element: HTMLElement): MenuEntry[] {
	const page = element.dataset.interfacePage as InterfacePageName | undefined;
	const hide = parts.context?.hideInterfacePage;
	const pages = company.store.get().interfacePages;
	if (!page || !hide || !pages?.personal || !pages.pages.some((entry) => entry.page === page)) return [];
	const shown = parts.appsDrawer.contains(element);
	const name = element.dataset.pageName ?? element.querySelector(".rail-app-name")?.textContent ?? page;
	return [
		{
			label: shown ? t("Hide from sidebar") : t("Show in sidebar"),
			icon: shown ? "hide" : "show",
			select: () => {
				company.reportRailError(undefined);
				hide(page, shown).catch(() =>
					company.reportRailError(t("{page} could not be changed. Try again.", { page: name })),
				);
			},
		},
	];
}

/** A page hidden from the rail, in Hidden: its emblem and name. A press, like a right-click, offers to show it. */
function hiddenPageRow(model: {
	name: string;
	title: string;
	emblem: CompanyInterface["file"]["emblem"];
}): HTMLElement {
	const row = h(
		"button",
		{
			type: "button",
			class: "rail-row rail-row-page",
			"data-interface-page": model.name,
			"data-page-name": model.title,
			"aria-haspopup": "menu",
		},
		h("span", { class: "rail-row-stand" }, interfaceEmblem(pageEmblem(model.name, model.emblem), 34)),
		h("span", { class: "rail-row-copy" }, h("strong", null, model.title), h("small", null, t("Hidden for you"))),
	);
	row.addEventListener("click", (event) => {
		row.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: event.clientX,
				clientY: event.clientY,
			}),
		);
	});
	return row;
}

/** The section an item stands in, or undefined for Unassigned (a placement in a section that is gone included). */
function homeSection(sidebar: CompanySidebar, itemId: string): string | undefined {
	const placed = sidebar.placements[itemId]?.sectionId;
	return placed && sidebar.sections.some((section) => section.sectionId === placed) ? placed : undefined;
}

/** A cloud before 20260930519000 keeps no order for what is in no section: it stands in the order it joined. */
const unassignedOrder = () =>
	t("Agents outside a section stay in the order they joined. Put them in a section to order them.");

function dragHooks(company: CompanyController, parts: RailParts) {
	const sidebarOf = () => {
		const state = company.store.get();
		return state.sidebarUnavailable ? undefined : state.sidebar;
	};
	return {
		// The collapsed rail hides the search field and ignores its text. A contact drags wherever the cloud keeps
		// its place; an agent or a group chat, where the company has a sidebar.
		canDrag: (itemId: string) =>
			(parts.collapsed || !parts.input.value.trim()) &&
			(placedChats(company)?.[itemId] ? true : Boolean(sidebarOf()) && company.sidebarRoster().includes(itemId)),
		accepts: (zone: string, itemId: string) => {
			// The pinned row holds so many cards, whatever is dragged: one that is in it already moves within it.
			const pinnable = () => keptOrder(company, "pinned").includes(itemId) || !pinnedRowFull(company);
			// A contact lands in any zone: where it stands is its member's own.
			if (placedChats(company)?.[itemId]) return zone !== "pinned" || pinnable();
			const sidebar = sidebarOf();
			// The Members group takes contacts only.
			if (!sidebar || zone === MEMBERS_ZONE) return false;
			if (zone === "pinned") return pinnable();
			return canOrganize(company);
		},
		drop: ({ itemId, kind, zone, order }: RailDrop) => {
			// A contact: only where it stands changes. Dragged out of Hidden, it shows again where it lands.
			if (kind === "member") {
				settleContacts(company, zone, dropInto(heldOrder(company, zone), itemId, order), itemId);
				return;
			}
			const item: SidebarItem = { id: itemId, kind };
			const sidebar = sidebarOf();
			if (!sidebar) return;
			// The member's contacts stand among a zone's rows, and the sidebar orders agents and group chats only: its
			// requests name those, and the contacts are then kept where the rows stand, here and in the zone the item
			// left (as the member saw it, before anything is drawn anew).
			const chats = placedChats(company);
			const placed = chats ? order.filter((member) => !chats[member]) : order;
			const from = parts.list
				.querySelector<HTMLElement>(
					`[data-drop-zone] [data-agent-id="${itemId}"], [data-drop-zone] [data-room-id="${itemId}"]`,
				)
				?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
			// Both zones' rows as the company holds them now, read before the sidebar change below moves the item (a
			// contact placed after it would move with it): only the item goes in or out, and contacts moved meanwhile
			// stay moved.
			const landed = dropInto(heldOrder(company, zone), itemId, order);
			const left =
				from && from !== zone ? heldOrder(company, from).filter((member) => member !== itemId) : undefined;
			const settle = () => {
				settleContacts(company, zone, landed);
				if (from && left) settleContacts(company, from, left);
			};
			const pinned = sidebar.pinned.includes(itemId);
			const into = (now: readonly string[]) => dropInto(now, itemId, placed);
			if (zone === "pinned") {
				// A pin list can still name an item deleted since it was read; the cloud refuses those.
				const roster = company.sidebarRoster();
				const pins = into(sidebar.pinned.filter((pin) => roster.includes(pin)));
				if (pins.join() !== sidebar.pinned.join()) void company.changeSidebar({ action: "set_pins", order: pins });
				settle();
				return;
			}
			const sectionId = zone === "unassigned" ? undefined : zone.slice("section:".length);
			// Dragged out of Hidden, the item is shown again where it lands.
			const wasHidden = sidebar.hidden.includes(itemId);
			// The rail shows no hidden or pinned items; the new order keeps them where they stood.
			const roster = company.sidebarRoster();
			const before = containerOrder(sidebar, sectionId, roster);
			const next = into(before);
			// Dropped where it stood among the agents, it may still have stepped over a contact: then only that moves.
			if (pinned || wasHidden || next.join() !== before.join()) {
				if (!sectionId && !pinned && !wasHidden && !homeSection(sidebar, itemId) && company.unassignedOrderLost()) {
					company.reportRailError(unassignedOrder());
					return;
				}
				if (wasHidden) void company.changeSidebar(hideRequest(item, false));
				void company.changeSidebar(
					moveRequest(item, sectionId ?? null, { order: next, ...(pinned ? { unpin: true } : {}) }),
				);
			}
			settle();
		},
		end: () => parts.redraw(),
	};
}

/** `itemId` put into `now` (a zone's rows as the company holds them now) where it was dropped among `dropped` (the
 * rows a lifted rail showed): before the first row that followed it there and is still in `now`, else last. The rail
 * is not drawn afresh while a row is lifted, so the rows it showed may be older than the company's: a pin made or a
 * contact moved meanwhile (on another device) stays so. */
function dropInto(now: readonly string[], itemId: string, dropped: readonly string[]): string[] {
	const next = now.filter((member) => member !== itemId);
	const following = dropped.slice(dropped.indexOf(itemId) + 1).find((member) => next.includes(member));
	next.splice(following ? next.indexOf(following) : next.length, 0, itemId);
	return next;
}

/** A zone's rows as the company holds them now, as the rail draws them with no search running: its agents and group
 * chats in their order with the member's contacts woven in, and nothing hidden, or pinned outside the pinned row. */
function heldOrder(company: CompanyController, zone: string): string[] {
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const roster = company.sidebarRoster();
	const pinned = (sidebar?.pinned ?? []).filter((itemId) => roster.includes(itemId));
	const hidden = new Set(sidebar?.hidden ?? []);
	const contacts = companyContacts(company).contacts.filter((contact) => contact.zone === zone);
	for (const contact of contacts) if (contact.hidden) hidden.add(contact.userId);
	const sectionId = zone.startsWith("section:") ? zone.slice("section:".length) : undefined;
	const items =
		zone === "pinned"
			? pinned
			: zone === MEMBERS_ZONE
				? []
				: sidebar
					? containerOrder(sidebar, sectionId, roster)
					: sectionId
						? []
						: roster;
	return weave(items, contacts).filter(
		(itemId) => !hidden.has(itemId) && (zone === "pinned" || !pinned.includes(itemId)),
	);
}

/** Moves an agent, a group chat or a contact one place up or down among what the member sees in its zone: the
 * pinned row (the member's own order) or a section (the company's order of agents and group chats; hidden and pinned
 * ones keep their places). A contact's step, and a step over a contact, change only where the contact stands, which
 * is its member's own. */
function nudgeItem(
	company: CompanyController,
	parts: RailParts,
	element: HTMLElement,
	item: RailItem,
	delta: number,
): void {
	const itemId = item.id;
	// What the member sees in the row's zone. A row in Hidden stands in no zone: it has no place to move from.
	const zoneElement = element.closest<HTMLElement>("[data-drop-zone]");
	const zone = zoneElement?.dataset.dropZone;
	if (!zoneElement || !zone) return;
	const seen = [...zoneElement.querySelectorAll<HTMLElement>(RAIL_ITEM)].map((row) => railItemId(row)!);
	const at = seen.indexOf(itemId);
	const beside = seen[at + delta];
	if (at < 0 || !beside) return;
	const stepped = [...seen];
	stepped.splice(at, 1);
	stepped.splice(at + delta, 0, itemId);
	// A contact's place is read off the rows the member sees. While a search hides some of them none is made, as none
	// is dragged then: an agent that steps then moves in the company's order alone, and every contact keeps standing
	// after the agent it stood after.
	const settle = () => {
		if (parts.collapsed || !parts.input.value.trim()) settleContacts(company, zone, stepped);
	};
	if (item.kind === "member" || placedChats(company)?.[beside]) {
		settle();
		return;
	}
	const moved: SidebarItem = { id: itemId, kind: item.kind };
	const state = company.store.get();
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	if (!sidebar) return;
	const roster = company.sidebarRoster();
	// Hidden items keep no visible place to move from; the sidebar may not place this one.
	if (sidebar.hidden.includes(itemId) || !roster.includes(itemId)) return;
	if (sidebar.pinned.includes(itemId)) {
		const order = sidebar.pinned.filter((pinned) => roster.includes(pinned));
		const from = order.indexOf(itemId);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= order.length) return;
		order.splice(from, 1);
		order.splice(to, 0, itemId);
		void company.changeSidebar({ action: "set_pins", order });
		settle();
		return;
	}
	if (!canOrganize(company)) return;
	const sectionId = homeSection(sidebar, itemId);
	const order = containerOrder(sidebar, sectionId, roster);
	const visible = order.filter((member) => !sidebar.pinned.includes(member) && !sidebar.hidden.includes(member));
	const neighbour = visible[visible.indexOf(itemId) + delta];
	if (!neighbour) return;
	if (!sectionId && company.unassignedOrderLost()) {
		company.reportRailError(unassignedOrder());
		return;
	}
	order.splice(order.indexOf(itemId), 1);
	order.splice(order.indexOf(neighbour) + (delta > 0 ? 1 : 0), 0, itemId);
	void company.changeSidebar(moveRequest(moved, sectionId ?? null, { order }));
	settle();
}
