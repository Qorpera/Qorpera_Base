import type { AppManifest } from "@qorpera/cloud-client/interface-apps";
import type { User } from "@supabase/supabase-js";
import { UUID_PATTERN } from "../../cloud/parse.ts";
import {
	type CompanySidebar,
	containerOrder,
	PIN_LIMIT,
	SECTION_NAME_LIMIT,
	type SidebarRequest,
} from "../../cloud/sidebar.ts";
import type { HostedProfile, HostedSession, HostedStaffAgent } from "../../cloud/types.ts";
import { AGENT_LOOK, type AgentLook, stateLine } from "../../ui/agent-activity.ts";
import { agentColor, agentFigure, figureFor } from "../../ui/avatar.ts";
import { type MenuEntry, menuPoint, openContextMenu, openMenu } from "../../ui/context-menu.ts";
import { badge, button, confirmDialog, h, icon, initials, notice, replace } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { matchesKey } from "../../ui/keys.ts";
import { playOnce } from "../../ui/motion.ts";
import { nameDialog } from "../../ui/name-dialog.ts";
import { attachPersonPicture, personPicturesEpoch } from "../../ui/person-pictures.ts";
import { phrase, presentationLocale, t, uiText } from "../../ui/preferences.ts";
import { quietScroll } from "../../ui/quiet-scroll.ts";
import { RailDrag, type RailDrop } from "../../ui/rail-drag.ts";
import { glideRows, measureRows } from "../../ui/rail-flip.ts";
import { RailSelection } from "../../ui/rail-selection.ts";
import { railListSkeleton } from "../../ui/skeleton.ts";
import { type AuthController, displayName } from "../auth.ts";
import { type AgentState, type CompanyController, isAgentPairSession } from "../company.ts";
import { type CompanyApp, companyConcepts } from "../interface-apps.ts";
import { interfaceBadge } from "../interface-badge.ts";
import { type CompanyInterface, companyInterfaces } from "../interfaces.ts";
import { appHash, conceptsHash, type Route } from "../router.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import type { AgentCardActions } from "./agent-details.ts";
import type { CardFootActions } from "./card-foot.ts";
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
	/** Friends, a window of its own beside the account (friends-window.ts). */
	openFriends: () => void;
	navigation?: { open: boolean; toggle: () => void };
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
	replace(
		accountFriends!,
		icon("friends"),
		context.invitations > 0 ? h("span", { class: "account-friends-dot", "aria-hidden": "true" }) : null,
	);
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
 * into or out of the pinned row. Search and creation share the toolbar, with the
 * account menu at the foot. Company management lives in settings. */

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
	readonly appsGrid: HTMLElement;
	appsOpen: boolean;
	/** The route the drawer was last opened for: an interface's page opens it once. */
	appsRoute: string;
	interfaceRows: Map<string, { shown: string; element: HTMLElement }>;
	readonly toolbar: HTMLElement;
	readonly close: HTMLButtonElement;
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
	readonly count: HTMLElement;
	readonly chevron: HTMLElement;
	readonly list: HTMLElement;
	open: boolean;
}
const HIDDEN_OPEN_KEY = "qorpera.web.rail-hidden-open";
const APPS_OPEN_KEY = "qorpera.web.rail-apps-open";
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
/** A row built anew, once the company has loaded, says what changed (styles/motion.css): an
 * agent that starts work gets its dot and its line, a failed run folds the figure into a red
 * "!" (and unfolds it when the failure is dealt with), a mention's badge pops, and an agent the
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
					: now.state === "working"
						? "state-working"
						: "state-changed",
		);
	if (mentionsRead && !was.mentioned && now.mentioned) playOnce(element, "mention-arrived");
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
		const appsDrawer = h(
			"div",
			{ class: "rail-apps-drawer", id: "rail-apps-drawer", role: "group" },
			h("div", null, appsGrid),
		);
		const created: RailParts = {
			company: companyButton,
			companyName,
			apps,
			appsDrawer,
			appsGrid,
			appsOpen: storedAppsOpen(company.profile.profileId),
			appsRoute: "",
			interfaceRows: new Map(),
			toolbar: h("div", { class: "rail-toolbar" }, close, companyButton, apps, search, add),
			close,
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
		(created as { drag: RailDrag }).drag = new RailDrag(list, () => dragHooks(company, created), company.signal);
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
								label: profile.profileName,
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
		pressToOpenMenu(list, company, created);
		// Dragging has a keyboard twin: Alt with an arrow moves the focused agent or group chat one place.
		list.addEventListener(
			"keydown",
			(event) => {
				const delta = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
				const item = railItemOf(event.target as HTMLElement);
				if (!event.altKey || !delta || !item) return;
				event.preventDefault();
				nudgeItem(company, item, delta);
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
		const slot = parts.pinnedGroup.querySelector<HTMLElement>(".rail-drop-slot");
		if (slot) slot.textContent = t("Drop here to pin");
		parts.unassigned.title.textContent = t("Unassigned");
		parts.hiddenGroup.label.textContent = t("Hidden");
		parts.searchClose.setAttribute("aria-label", t("Close search"));
		parts.searchClose.title = t("Close search");
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
	// A failed run: the figure gives way to a red "!" until the failure is dealt with (styles/motion.css).
	if (look.disc === "failed") return h("span", { class: "alert-mark", "aria-hidden": "true" });
	return h("span", { class: className, "aria-hidden": "true" });
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
	/** A group chat's room: its row has a menu and, where the cloud places group chats, drags. */
	roomId?: string;
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

/** A pinned group chat: the same square card, with the group's figures. */
function groupPinCard(model: SessionModel, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-pin rail-pin-group",
			href,
			draggable: "false",
			"data-room-id": model.roomId,
			title: [model.title, model.subtitle, model.mentioned ? t("You were mentioned") : ""]
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
			style: `--agent-color: ${agentColor(model)}`,
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
	const postedApps = (state.apps ?? []).filter((app) => app.manifest?.posted === true && !app.manifest.concept);
	const concepts = companyConcepts(state.apps ?? []).length;
	const hasApps = interfacesShown.length > 0 || postedApps.length > 0 || concepts > 0;
	// An interface's page opens the drawer once, so the page it shows stands lit; after that the member's press decides.
	const routeKey = route.name === "company" ? `${route.section}/${route.id ?? ""}` : "";
	if (routeKey !== parts.appsRoute) {
		parts.appsRoute = routeKey;
		if ((section === "interface" || section === "app") && !parts.appsOpen) setAppsOpen(parts, profileId, true);
	}
	const appsOpen = hasApps && parts.appsOpen;
	parts.apps.hidden = !hasApps;
	parts.apps.setAttribute("aria-expanded", String(appsOpen));
	parts.apps.classList.toggle("is-open", appsOpen);
	parts.appsDrawer.hidden = !hasApps;
	parts.appsDrawer.classList.toggle("is-open", appsOpen);
	// Closed, its icons can't be reached.
	parts.appsDrawer.inert = !appsOpen;
	if (parts.companyName.textContent !== company.profile.profileName)
		parts.companyName.textContent = company.profile.profileName;
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
	if (section === "new") parts.add.setAttribute("aria-current", "page");
	else parts.add.removeAttribute("aria-current");

	drawInterfaces(parts, company, interfacesShown, postedApps, concepts, route);
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
		return {
			id: agent.id,
			displayName: agent.displayName,
			role: agent.role,
			templateId: agent.templateId,
			// Resolved, so the pick and the roster's words for it once saved (a colour's name, no colour for the
			// figure's own shade) are one cache key, and the row is kept when the save lands.
			appearance: { color: agentColor(shown, figure), shape: "", creature: figure },
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
	// The sidebar: this member's pins and hidden agents and group chats, the company's
	// sections. A cloud without it shows every agent in one list, as before; one that
	// places agents only lists the group chats after them.
	const sidebar = state.sidebarUnavailable ? undefined : state.sidebar;
	const roster = company.sidebarRoster();
	const rooms = company.groupChatRooms();
	// Group chats the sidebar places; the others stand after the Unassigned agents.
	const placedRooms: ReadonlyMap<string, HostedSession> = sidebar?.groupChats ? rooms : new Map();
	const pinned = (sidebar?.pinned ?? []).filter((itemId) => roster.includes(itemId));
	const hidden = new Set(sidebar?.hidden ?? []);
	const shown = (agent: HostedStaffAgent | undefined): agent is HostedStaffAgent =>
		// A hidden agent is still found by searching for it.
		Boolean(agent) &&
		matches(`${agent!.displayName} ${agent!.role}`) &&
		(!hidden.has(agent!.id) || Boolean(railQuery));
	const roomShown = (roomId: string) =>
		matches(placedRooms.get(roomId)?.title ?? "") && (!hidden.has(roomId) || Boolean(railQuery));
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
	const pinnedElements = pinned.flatMap((itemId) => {
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
	const inContainer = (sectionId: string | undefined) =>
		(sidebar ? containerOrder(sidebar, sectionId, roster) : sectionId ? [] : roster)
			.filter((itemId) => !pinned.includes(itemId))
			.flatMap((itemId) => {
				if (placedRooms.has(itemId)) return roomShown(itemId) ? [roomElement(itemId)] : [];
				const agent = company.staffById(itemId);
				return shown(agent) ? [agentElement(agent)] : [];
			});
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
	const hiddenGroup = parts.hiddenGroup;
	hiddenGroup.count.textContent = String(hiddenItems.length);
	hiddenGroup.count.hidden = hiddenGroup.open;
	hiddenGroup.chevron.hidden = !hiddenGroup.open;
	hiddenGroup.toggle.setAttribute("aria-expanded", String(hiddenGroup.open));
	hiddenGroup.toggle.setAttribute("aria-label", t("Hidden: {count}", { count: hiddenItems.length }));
	hiddenGroup.list.hidden = !hiddenGroup.open;
	reconcile(
		hiddenGroup.list,
		hiddenGroup.open
			? hiddenItems.flatMap((itemId) => {
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
				})
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
					matches(session.title) &&
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
	const anyRows =
		pinnedElements.length +
		unassignedRows.length +
		hiddenItems.length +
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
			hiddenItems.length ? hiddenGroup.el : null,
			empty ? parts.empty : null,
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
	if (!state.loading) parts.settled = true;
	parts.mentionsRead = parts.settled && state.mentions !== undefined;
	parts.notices = notices;
	parts.drag.refresh();
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
	restoreFocus();
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

/** The drawer under the top row: the pages that are on (Mailbox, Members, Bank and the agents' pages) as icons,
 * four to a row. An icon is rebuilt only when what it shows changes. The four windows carry a dot while the drawer
 * is closed and a page has something waiting. */
function drawInterfaces(
	parts: RailParts,
	company: CompanyController,
	shown: readonly CompanyInterface[],
	apps: readonly CompanyApp[],
	concepts: number,
	route: Route,
): void {
	const profileId = company.profile.profileId;
	const activeName = route.name === "company" && route.section === "interface" ? route.id : undefined;
	const rows = new Map<string, { shown: string; element: HTMLElement }>();
	let waiting = 0;
	const elements = shown.map((entry, index) => {
		const { name, file } = entry;
		const count = interfaceBadge(company, file);
		waiting += count;
		const model = JSON.stringify([name, file.name, file.about, file.emblem, file.colour, count]);
		const kept = parts.interfaceRows.get(name);
		const element = kept?.shown === model ? kept.element : appIcon(entry, `#/c/${profileId}/i/${name}`, count);
		rows.set(name, { shown: model, element });
		element.style.setProperty("--i", String(index));
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
		const model = JSON.stringify([app.name, manifest.name, manifest.about, manifest.emblem, manifest.colour]);
		const kept = parts.interfaceRows.get(key);
		const element = kept?.shown === model ? kept.element : agentAppIcon(manifest, appHash(profileId, app.name));
		rows.set(key, { shown: model, element });
		element.style.setProperty("--i", String(elements.length));
		element.classList.toggle("active", app.name === activeApp);
		if (app.name === activeApp) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	// The company's concepts: one entry for the Concepts viewer, which lists them all.
	if (concepts > 0) {
		const key = "concepts";
		const model = JSON.stringify([key, t("Concepts"), concepts]);
		const kept = parts.interfaceRows.get(key);
		const element = kept?.shown === model ? kept.element : conceptsIcon(conceptsHash(profileId), concepts);
		rows.set(key, { shown: model, element });
		element.style.setProperty("--i", String(elements.length));
		const open = route.name === "company" && route.section === "concepts";
		element.classList.toggle("active", open);
		if (open) element.setAttribute("aria-current", "page");
		else element.removeAttribute("aria-current");
		elements.push(element);
	}
	parts.interfaceRows = rows;
	reconcile(parts.appsGrid, elements);
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
			title: file.about ? `${file.name} · ${file.about}` : file.name,
			...(waiting ? { "aria-label": `${file.name}, ${waiting}` } : {}),
		},
		h(
			"span",
			{ class: "rail-app-stand" },
			interfaceEmblem(entry.name === "bank" ? "bank" : file.emblem, file.colour, 34),
			countBadge(count),
		),
		h("span", { class: "rail-app-name" }, file.name),
	);
}

/** An agent's posted app in the drawer: its emblem with its name under it, a link to the app's own page. */
function agentAppIcon(manifest: AppManifest, href: string): HTMLElement {
	return h(
		"a",
		{
			class: "rail-app",
			href,
			draggable: "false",
			title: manifest.about ? `${manifest.name} · ${manifest.about}` : manifest.name,
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem(manifest.emblem, manifest.colour, 34)),
		h("span", { class: "rail-app-name" }, manifest.name),
	);
}

/** The Concepts entry in the drawer: the concepts' emblem with "Concepts" under it, a link to the Concepts viewer. */
function conceptsIcon(href: string, count: number): HTMLElement {
	const label = t("Concepts");
	return h(
		"a",
		{
			class: "rail-app rail-concepts",
			href,
			draggable: "false",
			title: count === 1 ? t("1 concept") : t("{count} concepts", { count }),
		},
		h("span", { class: "rail-app-stand" }, interfaceEmblem("board", "purple", 34)),
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

/** What the rail places: an agent or a group chat, known by the row it was picked from. */
interface RailItem {
	id: string;
	kind: "agent" | "room";
}

/** The item a rail element stands for, by its data attribute. */
function railItemOf(element: HTMLElement | undefined): RailItem | undefined {
	const agentId = element?.dataset.agentId;
	const roomId = element?.dataset.roomId;
	return agentId ? { id: agentId, kind: "agent" } : roomId ? { id: roomId, kind: "room" } : undefined;
}

/** Moves an agent or a group chat: the sidebar names each by its own kind of id. */
function moveRequest(
	item: RailItem,
	sectionId: string | null,
	options: { order?: string[]; unpin?: boolean } = {},
): SidebarRequest {
	return item.kind === "room"
		? { action: "move_room", roomId: item.id, sectionId, ...options }
		: { action: "move_agent", staffAgentId: item.id, sectionId, ...options };
}

function hideRequest(item: RailItem, hidden: boolean): SidebarRequest {
	return item.kind === "room"
		? { action: "set_hidden", roomId: item.id, hidden }
		: { action: "set_hidden", staffAgentId: item.id, hidden };
}

/** Asks for a new section's name and makes it; with an agent or a group chat, moves it
 * into the section (a name that already exists moves it there instead). */
async function askSectionName(company: CompanyController, item?: RailItem): Promise<void> {
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

function canOrganize(company: CompanyController): boolean {
	const state = company.store.get();
	return Boolean(state.sidebar && !state.sidebarUnavailable && state.team?.capabilities.write);
}

/** An agent's card from the rail: Pin or Unpin and Hide (or Show, for a hidden agent) where the member has a
 * sidebar, its conversation's id to copy, and Delete for owners and admins. Pinning and moving are drags; the name edits on the card. */
/** Pin or unpin from a card: this member's own pins, so no edit rights are needed, and a tap works where a drag
 * can't (a phone). Nothing to offer when the pinned row is full and the item is not in it. The click reads the
 * sidebar as it is then: a card stays open across refreshes, and another tab may have pinned meanwhile. */
function pinActions(company: CompanyController, sidebar: CompanySidebar, itemId: string): CardFootActions {
	const pinned = sidebar.pinned.includes(itemId);
	if (!pinned && sidebar.pinned.length >= PIN_LIMIT) return {};
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
			if (!pinned && pins.length >= PIN_LIMIT) {
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
	const item: RailItem = { id: agent.id, kind: "agent" };
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
	const item: RailItem = { id: roomId, kind: "room" };
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
						t(
							"Delete the section {name}? Its agents and group chats move to Unassigned, for everyone in the company.",
							{
								name: `"${section.name}"`,
							},
						),
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

/** Right-click anywhere in the rail list: an agent, a group chat, a section's title, or the rail itself. */
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
	let items: MenuEntry[] = [];
	let label = t("Sidebar");
	let opener: HTMLElement = parts.list;
	let findOpener: (() => HTMLElement | null) | undefined;
	if (agentElement) {
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
		// The collapsed rail hides the search field and ignores its text.
		canDrag: (itemId: string) =>
			Boolean(sidebarOf()) &&
			(parts.collapsed || !parts.input.value.trim()) &&
			company.sidebarRoster().includes(itemId),
		accepts: (zone: string, itemId: string) => {
			const sidebar = sidebarOf();
			if (!sidebar) return false;
			if (zone === "pinned") return sidebar.pinned.includes(itemId) || sidebar.pinned.length < PIN_LIMIT;
			return canOrganize(company);
		},
		drop: ({ itemId, kind, zone, order }: RailDrop) => {
			const item: RailItem = { id: itemId, kind };
			const sidebar = sidebarOf();
			if (!sidebar) return;
			const pinned = sidebar.pinned.includes(itemId);
			if (zone === "pinned") {
				if (order.join() !== sidebar.pinned.join()) void company.changeSidebar({ action: "set_pins", order });
				return;
			}
			const sectionId = zone === "unassigned" ? undefined : zone.slice("section:".length);
			// Dragged out of Hidden, the item is shown again where it lands.
			const wasHidden = sidebar.hidden.includes(itemId);
			// The rail shows no hidden or pinned items; the new order keeps them where they stood.
			const roster = company.sidebarRoster();
			const before = containerOrder(sidebar, sectionId, roster);
			const next = before.filter((member) => member !== itemId);
			const following = order[order.indexOf(itemId) + 1];
			const at = following ? next.indexOf(following) : -1;
			next.splice(at < 0 ? next.length : at, 0, itemId);
			if (!pinned && !wasHidden && next.join() === before.join()) return;
			if (!sectionId && !pinned && !wasHidden && !homeSection(sidebar, itemId) && company.unassignedOrderLost()) {
				company.reportRailError(unassignedOrder());
				return;
			}
			if (wasHidden) void company.changeSidebar(hideRequest(item, false));
			void company.changeSidebar(
				moveRequest(item, sectionId ?? null, { order: next, ...(pinned ? { unpin: true } : {}) }),
			);
		},
	};
}

/** Moves an agent or a group chat one place up or down among what the member sees: in
 * the pinned row (the member's own order) or in its section (the company's; hidden and
 * pinned items keep their places). */
function nudgeItem(company: CompanyController, item: RailItem, delta: number): void {
	const itemId = item.id;
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
	void company.changeSidebar(moveRequest(item, sectionId ?? null, { order }));
}
