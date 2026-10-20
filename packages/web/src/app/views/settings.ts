import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import { createWebCodingEnvironment } from "../../cloud/coding-environment.ts";
import { WebCompanyFiles } from "../../cloud/company-files.ts";
import type { CompanyComputerHours } from "../../cloud/computer-hours.ts";
import { createWebConnectors } from "../../cloud/connectors.ts";
import { createWebEventHooks } from "../../cloud/event-hooks.ts";
import { interfacePageCalls } from "../../cloud/interface-pages.ts";
import { createWebNativeSubscription } from "../../cloud/native-subscription.ts";
import { createWebReviewRules } from "../../cloud/review-rules.ts";
import type { HostedCompanyFile, HostedProfile } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, h, icon, notice, replace } from "../../ui/dom.ts";
import { leave } from "../../ui/motion.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";
import type { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { PlanPayments } from "../plan-payments.ts";
import { currentRoute } from "../router.ts";
import { type AccountViewState, renderAccount } from "./account.ts";
import { renderAppearance } from "./appearance.ts";
import { CompanyFolderBrowser } from "./company-folder.ts";
import { FriendsController, renderFriends } from "./friends.ts";
import type { HubController } from "./hub.ts";
import { renderPlan } from "./plan.ts";
import { CodingEnvironmentView } from "./settings-coding-environment.ts";
import { ConnectionsView, memberPlanSignIn, memberProviderSignIns } from "./settings-connections.ts";
import { HooksView } from "./settings-hooks.ts";
import { MemoryView } from "./settings-memory.ts";
import { PagesView } from "./settings-pages.ts";
import { RulesView } from "./settings-rules.ts";
import { ServicesView } from "./settings-services.ts";
import { storageSummary } from "./storage-summary.ts";
import { renderTeam, type TeamFeedback } from "./team.ts";

const TABS = [
	{
		id: "general",
		label: phrase("General"),
		icon: "settings",
		keywords:
			"account language region time zone timezone rules auto-review review approval approve ask first allow automatically safety agents actions permissions generelt konto sprog dansk engelsk område tidszone regler godkendelse godkend spørg først tillad automatisk sikkerhed agenter handlinger tilladelser",
	},
	{
		id: "appearance",
		label: phrase("Appearance"),
		icon: "appearance",
		keywords:
			"theme composer color colour blue green grey gray interface size big small udseende tema lys mørk skrivefelt farve blå grøn grå grænseflade størrelse stor lille",
	},
	{
		id: "company",
		label: phrase("Company"),
		icon: "company",
		keywords:
			"people team members invitations staff memory notebooks shared context beta file delete leave pages mailbox interfaces virksomhed personer medlemmer invitationer agenter hukommelse notesbøger delt kontekst virksomhedsfilen roller slet forlad sider postkasse grænseflader",
	},
	{
		id: "friends",
		label: phrase("Friends"),
		icon: "friends",
		keywords:
			"people contacts requests add email invitations invites join accept decline venner personer kontakter anmodninger tilføj e-mail invitationer inviter accepter afvis",
	},
	{
		id: "plan",
		label: phrase("Plan & usage"),
		icon: "plan",
		keywords:
			"plan billing subscription usage storage trial upgrade price payment card invoices computer hours basis standard dedicated abonnement forbrug betaling lager lagerplads prøveperiode opgrader pris kort fakturaer computertimer dedikeret",
	},
	{
		id: "my-connections",
		label: phrase("My connections"),
		icon: "key",
		keywords:
			"model accounts providers subscriptions sign in openai chatgpt codex anthropic claude usage environment variables mine forbindelser modelkonti udbydere abonnementer log ind forbrug miljøvariabler",
	},
	{
		id: "company-connections",
		label: phrase("Company connections"),
		icon: "connections",
		keywords:
			"services accounts gmail google drive github token secrets agents environment variables webhooks hooks mailboxes mail email events virksomhedens forbindelser tjenester konti hemmeligheder agenter miljøvariabler postkasser hændelser",
	},
] as const;
type SettingsCategory = (typeof TABS)[number]["id"];
export type SettingsTab = SettingsCategory | "storage" | "recents";

/** A connections tab: its title, the rule that sorts a connection into it, then its lists. */
function connectionsPage(title: string, rule: string, ...content: HTMLElement[]): HTMLElement {
	return h("div", null, h("h1", null, title), h("p", { class: "settings-lead" }, rule), ...content);
}

/** Founders (owners) pay a company's computer hours; undefined until the member's role is known. */
function founderOf(company: CompanyController): boolean | undefined {
	const role = company.store.get().team?.role;
	return role === undefined ? undefined : role === "owner";
}

/** A settings session owns its async work; the conversation stays mounted below it. */
export class SettingsView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #auth: AuthController;
	readonly #hub: HubController;
	readonly #friends: FriendsController;
	/** Company invitations waiting on the Friends tab, as the profile menu counts them. */
	readonly #invitationCount = h("span", { class: "settings-tab-count", hidden: true });
	readonly #close: () => void;
	readonly #companyRemoved: (profileId: string) => void;
	/** Told after a page was switched on or off, with the company's environment. */
	readonly #pagesChanged: (environmentId: string) => void;
	readonly #lifetime = new AbortController();
	readonly #content = h("div", { class: "settings-content", id: "settings-content", role: "tabpanel", tabindex: "0" });
	readonly #search = h("input", {
		type: "search",
		class: "settings-search-input",
		placeholder: t("Search settings"),
		"aria-label": t("Search settings"),
	});
	readonly #storageSearch = h("input", {
		type: "search",
		class: "settings-search-input",
		placeholder: t("Search this folder"),
		"aria-label": t("Search this folder"),
		autocomplete: "off",
		spellcheck: "false",
		hidden: true,
	});
	readonly #nav = h("nav", { class: "settings-nav", "aria-label": t("Settings sections") });
	readonly #storageNav = h("nav", {
		class: "settings-nav settings-storage-nav",
		"aria-label": t("Storage"),
		hidden: true,
	});
	readonly #storageCompany = h("div", { class: "settings-nav-heading" });
	readonly #storageContent = h("div", {
		class: "settings-storage-content",
		id: "settings-storage-content",
		role: "tabpanel",
		tabindex: "0",
		hidden: true,
	});
	readonly #modeButtons = new Map<"settings" | "storage", HTMLButtonElement>();
	readonly #storageTabs = new Map<"documents" | "recents", HTMLButtonElement>();
	readonly #panels = new Map<SettingsCategory, HTMLElement>();
	readonly #tabs = new Map<SettingsCategory, HTMLButtonElement>();
	readonly #borrowedCompany: CompanyController | undefined;
	/** Opened on a company's page, even one whose company is not available. */
	readonly #overCompany: boolean;
	#profiles: HostedProfile[] = [];
	#tab: SettingsCategory = "general";
	#mode: "settings" | "storage" = "settings";
	#storageSection: "documents" | "recents" = "documents";
	#folder: CompanyFolderBrowser | undefined;
	#folderStop = new AbortController();
	#folderAuthority: string | undefined;
	#account: AccountViewState = { loading: true };
	#company: CompanyController | undefined;
	#ownsCompany = false;
	#unsubscribe: (() => void) | undefined;
	#companyLifetime = new AbortController();
	#connections: ConnectionsView | undefined;
	/** The member's own coding environment variables, on My connections. */
	#memberEnvironment: CodingEnvironmentView | undefined;
	#services: ServicesView | undefined;
	/** The company's coding environment variables, on Company connections. */
	#companyEnvironment: CodingEnvironmentView | undefined;
	#hooks: HooksView | undefined;
	#rules: RulesView | undefined;
	/** Company: the company's memory, Agent notebooks or the Shared context beta. */
	#memory: MemoryView | undefined;
	/** The company's pages, on the Company tab. */
	#pages: PagesView | undefined;
	/** General: the account's settings, then the rules of the company Settings show. */
	readonly #accountPanel = h("div");
	readonly #rulesSlot = h("div");
	/** In the rules' place when Settings show no company (opened from the company list with several,
	 * or over a company page whose company is not available). */
	readonly #noCompanyRules = h(
		"section",
		{ class: "settings-group settings-rules", "aria-label": t("Rules") },
		h("p", { class: "settings-rule-note" }, t("Open a company to see its rules.")),
	);
	#feedback: TeamFeedback = {};
	#file: HostedCompanyFile | undefined;
	#fileLoading = false;
	#fileError: string | undefined;
	#hours: CompanyComputerHours | undefined;
	#hoursLoading = false;
	#hoursMissing = false;
	/** Set once a lookup failed: the hours are not asked again until the company changes. */
	#hoursFailed = false;
	/** Offers, the member's own plan, and Stripe's pages; loaded when Plan & usage first shows. */
	readonly #payments: PlanPayments;
	#planFounder: boolean | undefined;

	constructor(
		api: CloudApi,
		auth: AuthController,
		hub: HubController,
		profiles: HostedProfile[],
		company: CompanyController | undefined,
		close: () => void,
		companyRemoved: (profileId: string) => void,
		tab: SettingsTab = "general",
		pagesChanged: (environmentId: string) => void = () => {},
	) {
		this.#api = api;
		this.#auth = auth;
		this.#hub = hub;
		this.#friends = new FriendsController(api);
		this.#close = close;
		this.#companyRemoved = companyRemoved;
		this.#pagesChanged = pagesChanged;
		this.#borrowedCompany = company;
		this.#payments = new PlanPayments(api, () => {
			if (!this.#lifetime.signal.aborted && this.#panels.has("plan")) this.#plan();
		});
		const route = currentRoute();
		this.#overCompany = Boolean(company) || route.name === "company";
		const search = this.#search;
		const empty = h("p", { class: "muted small", hidden: true }, t("No settings found."));
		const nav = this.#nav;
		nav.append(h("div", { class: "settings-nav-heading" }, uiText("Settings")));
		const tablist = h("div", {
			role: "tablist",
			"aria-label": t("Settings sections"),
			"aria-orientation": "vertical",
		});
		for (const tab of TABS) {
			const button = h(
				"button",
				{
					type: "button",
					role: "tab",
					id: `settings-tab-${tab.id}`,
					"aria-controls": "settings-content",
					onclick: () => this.#select(tab.id),
				},
				icon(tab.icon),
				uiText(tab.label),
				tab.id === "friends" ? this.#invitationCount : null,
			);
			this.#tabs.set(tab.id, button);
			tablist.append(button);
		}
		tablist.onkeydown = (event: KeyboardEvent) => {
			if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			const tabs = [...this.#tabs.entries()].filter(([, button]) => !button.hidden);
			const index = tabs.findIndex(([id]) => id === this.#tab);
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? tabs.length - 1
						: (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
							tabs.length;
			const target = tabs[next];
			if (target) {
				event.preventDefault();
				this.#select(target[0]);
				target[1].focus();
			}
		};
		search.oninput = () => {
			// Every word must match, so "delete company" finds the tab its button is on.
			const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
			for (const tab of TABS) {
				const text = `${tab.label} ${tab.keywords}`.toLowerCase();
				this.#tabs.get(tab.id)!.hidden = !words.every((word) => text.includes(word));
			}
			const first = [...this.#tabs.entries()].find(([, button]) => !button.hidden);
			empty.hidden = Boolean(first);
			if (first && this.#tabs.get(this.#tab)?.hidden) this.#select(first[0]);
		};
		// The rail's way out of a company. The company list itself needs none;
		// following the link closes Settings like any other in-app link.
		const back = h(
			"a",
			{ class: "settings-back", href: "#/", hidden: route.name === "hub" },
			icon("back"),
			uiText("Back to companies"),
		);
		nav.append(tablist, empty, back);
		const modes = h("div", { class: "settings-modes", role: "group", "aria-label": t("Settings and storage") });
		for (const [mode, label] of [
			["settings", phrase("Settings")],
			["storage", phrase("Storage")],
		] as const) {
			const control = h(
				"button",
				{
					type: "button",
					class: "settings-mode",
					"data-mode": mode,
					"aria-pressed": String(mode === "settings"),
					onclick: () => this.#switchMode(mode),
				},
				uiText(label),
			);
			this.#modeButtons.set(mode, control);
			modes.append(control);
		}
		const storageTabs = h("div", { role: "tablist", "aria-label": t("Storage"), "aria-orientation": "vertical" });
		for (const [section, label, glyph] of [
			["documents", phrase("Documents"), "folder"],
			["recents", phrase("Recents"), "clock"],
		] as const) {
			const control = h(
				"button",
				{
					type: "button",
					role: "tab",
					id: `settings-storage-${section}`,
					"aria-controls": "settings-storage-content",
					onclick: () => this.#selectStorage(section),
				},
				icon(glyph),
				uiText(label),
			);
			this.#storageTabs.set(section, control);
			storageTabs.append(control);
		}
		storageTabs.onkeydown = (event: KeyboardEvent) => {
			if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const section =
				event.key === "Home"
					? "documents"
					: event.key === "End"
						? "recents"
						: this.#storageSection === "documents"
							? "recents"
							: "documents";
			this.#selectStorage(section);
			this.#storageTabs.get(section)?.focus();
		};
		this.#storageNav.append(this.#storageCompany, storageTabs);
		this.el = h(
			"div",
			{
				class: "settings-overlay",
				onclick: (event: MouseEvent) => {
					if (event.target === this.el) close();
					else if (event.target instanceof Element && event.target.closest("a[href^='#/']")) close();
				},
			},
			h(
				"section",
				{
					class: "settings-dialog settings-unified",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("Settings"),
				},
				h(
					"header",
					{ class: "settings-header" },
					h("div", { class: "settings-search", role: "search" }, icon("search"), search, this.#storageSearch),
					modes,
					h(
						"button",
						{ type: "button", class: "settings-close", "aria-label": t("Close settings"), onclick: close },
						icon("close"),
					),
				),
				h("div", { class: "settings-body" }, nav, this.#storageNav, this.#content, this.#storageContent),
				h(
					"footer",
					{ class: "settings-footer" },
					h("span", null, h("kbd", null, uiText("Esc")), " ", uiText("to close")),
				),
			),
		);
		document.addEventListener("keydown", this.#onKey, { signal: this.#lifetime.signal });
		// The tab asked for is drawn first: General's rules load only if Settings opens on General.
		this.#tab = tab === "storage" || tab === "recents" ? "general" : tab;
		this.#mode = tab === "storage" || tab === "recents" ? "storage" : "settings";
		this.#storageSection = tab === "recents" ? "recents" : "documents";
		this.#setCompany(company, false);
		this.updateProfiles(profiles);
		void api
			.getAccountEntitlement()
			.then((entitlement) => this.#loadedAccount({ loaded: true, entitlement }))
			.catch((error) => this.#loadedAccount({ loaded: true, error: describeError(error) }));
		// The friends list also feeds the Company tab's invitation picker.
		this.#friends.store.subscribe(() => {
			if (this.#tab === "friends") this.#drawFriends();
			else if (this.#tab === "company") this.#drawCompany();
		});
		void this.#friends.refresh();
		this.#lifetime.signal.addEventListener(
			"abort",
			hub.store.subscribe(() => {
				this.#countInvitations();
				if (this.#tab === "friends") this.#drawFriends();
			}),
		);
		this.#countInvitations();
		this.#switchMode(this.#mode);
	}

	/** The open tab, so a language change can reopen Settings where it was. */
	get tab(): SettingsTab {
		return this.#mode === "storage" ? (this.#storageSection === "recents" ? "recents" : "storage") : this.#tab;
	}

	focus(): void {
		(this.#mode === "storage" ? this.#storageTabs.get(this.#storageSection) : this.#tabs.get(this.#tab))?.focus();
	}

	/** Settings opened on a company's page show the company that page has open
	 * and no other, while the account lists it; none when the page has no
	 * company to lend (access lost, not available). Opened elsewhere, they keep
	 * the company they show while it is listed, else show the account's only
	 * company, and none when it has several. */
	updateProfiles(profiles: HostedProfile[]): void {
		if (this.#lifetime.signal.aborted || profiles === this.#profiles) return;
		const profile = this.#overCompany
			? profiles.find((item) => item.profileId === this.#borrowedCompany?.profile.profileId)
			: (profiles.find((item) => item.profileId === this.#company?.profile.profileId) ??
				(profiles.length === 1 ? profiles[0] : undefined));
		this.#profiles = profiles;
		if (profile?.profileId === this.#company?.profile.profileId) return;
		if (
			profile &&
			profile.profileId === this.#borrowedCompany?.profile.profileId &&
			!this.#borrowedCompany.signal.aborted
		)
			this.#setCompany(this.#borrowedCompany, false);
		else
			this.#setCompany(
				profile ? new CompanyController(this.#api, profile, this.#auth.userId!) : undefined,
				Boolean(profile),
			);
	}

	dispose(): void {
		this.#folderStop.abort();
		this.#folder?.dispose();
		this.#lifetime.abort();
		this.#companyLifetime.abort();
		this.#unsubscribe?.();
		this.#connections?.dispose();
		this.#memberEnvironment?.dispose();
		this.#services?.dispose();
		this.#companyEnvironment?.dispose();
		this.#hooks?.dispose();
		this.#rules?.dispose();
		this.#memory?.dispose();
		this.#pages?.dispose();
		this.#friends.dispose();
		this.#payments.dispose();
		if (this.#ownsCompany) this.#company?.stop();
		leave(this.el, "is-leaving", () => this.el.remove());
	}

	#onKey = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.isComposing) return;
		if (document.querySelector("[role=alertdialog]:not([data-leaving], [data-leaving] *)")) return;
		if (event.key === "Escape") {
			if (document.activeElement === this.#search && this.#search.value) {
				this.#search.value = "";
				this.#search.dispatchEvent(new Event("input"));
				event.preventDefault();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			this.#close();
			return;
		}
		if (event.key !== "Tab") return;
		const fields = [
			...this.el.querySelectorAll<HTMLElement>(
				"button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex='0']",
			),
		].filter((field) => {
			const closed = field.closest("details:not([open])");
			return (
				!field.closest("[hidden], [inert]") &&
				field.tabIndex >= 0 &&
				(!closed || field === closed.querySelector("summary"))
			);
		});
		if (
			!this.el.contains(document.activeElement) ||
			document.activeElement === (event.shiftKey ? fields[0] : fields.at(-1))
		) {
			event.preventDefault();
			(event.shiftKey ? fields.at(-1) : fields[0])?.focus();
		}
	};

	#switchMode(mode: "settings" | "storage"): void {
		this.#mode = mode;
		const storage = mode === "storage";
		this.#nav.hidden = storage;
		this.#content.hidden = storage;
		this.#search.hidden = storage;
		this.#storageNav.hidden = !storage;
		this.#storageContent.hidden = !storage;
		this.#storageSearch.hidden = !storage;
		for (const [value, control] of this.#modeButtons) control.setAttribute("aria-pressed", String(mode === value));
		if (storage) this.#drawStorage();
		else this.#select(this.#tab);
	}

	#selectStorage(section: "documents" | "recents"): void {
		this.#storageSection = section;
		this.#markStorageSection(section);
		if (section === "documents") this.#folder?.showDocuments();
		else this.#folder?.showRecents();
	}

	#markStorageSection(section: "documents" | "recents"): void {
		this.#storageSection = section;
		for (const [value, control] of this.#storageTabs) {
			control.setAttribute("aria-selected", String(value === section));
			control.tabIndex = value === section ? 0 : -1;
		}
		this.#storageContent.setAttribute("aria-labelledby", `settings-storage-${section}`);
	}

	/** The modal owns the browser, but company membership remains its authority. A role or capability change
	 * tears down in-flight reads and downloads before a browser with the new authority is opened. */
	#drawStorage(): void {
		if (this.#lifetime.signal.aborted) return;
		const company = this.#company;
		const state = company?.store.get();
		const team = state?.team;
		const authority =
			company && team?.capabilities.read && !state?.accessLost
				? JSON.stringify([company.profile.profileId, team.role, team.capabilities.read, team.capabilities.write])
				: undefined;
		if (authority !== this.#folderAuthority || !authority) {
			this.#folderStop.abort();
			this.#folder?.dispose();
			this.#folder = undefined;
			this.#folderAuthority = undefined;
			this.#folderStop = new AbortController();
			replace(this.#storageContent);
		}
		if (this.#mode !== "storage") return;
		this.#storageCompany.textContent = company?.profile.profileName ?? t("Storage");
		this.#markStorageSection(this.#storageSection);
		if (!company) {
			replace(this.#storageContent, notice("neutral", t("Open a company to see its storage.")));
			return;
		}
		if (!authority || !team) {
			replace(
				this.#storageContent,
				state?.loading
					? notice("neutral", t("Opening Company File"))
					: h(
							"div",
							null,
							notice("danger", state?.error ?? t("Your membership in this company could not be read.")),
							button(t("Retry company"), () => {
								if (!company.store.get().loading) void company.refreshAll();
							}),
						),
			);
			return;
		}
		if (this.#folder) return;
		const signal = AbortSignal.any([
			this.#lifetime.signal,
			this.#companyLifetime.signal,
			this.#folderStop.signal,
			company.signal,
		]);
		const source = new WebCompanyFiles(
			this.#api.cloud,
			company.profile,
			company.userId,
			team.role,
			signal,
			() => {
				const current = company.store.get();
				const membership = current.team;
				if (
					this.#company !== company ||
					this.#auth.userId !== company.userId ||
					current.accessLost ||
					!membership?.capabilities.read ||
					JSON.stringify([
						company.profile.profileId,
						membership.role,
						membership.capabilities.read,
						membership.capabilities.write,
					]) !== authority
				)
					throw new Error(t("Company File access changed."));
			},
			team.capabilities.write,
		);
		const host = h("section", { class: "settings-storage-browser" });
		replace(this.#storageContent, host);
		const section = this.#storageSection;
		const browser = new CompanyFolderBrowser(
			host,
			source,
			() => ({
				me: company.userId,
				members: company.store.get().team?.members ?? [],
				staff: company.store.get().staff,
			}),
			{
				search: this.#storageSearch,
				embedded: true,
				onSectionChange: (value) => this.#markStorageSection(value),
			},
		);
		this.#folder = browser;
		this.#folderAuthority = authority;
		void browser.open().catch(() => {
			if (signal.aborted || this.#folder !== browser) return;
			browser.dispose();
			this.#folder = undefined;
			replace(
				this.#storageContent,
				notice("danger", t("The Company File could not be read just now.")),
				button(t("Retry opening Company File"), () => this.#drawStorage()),
			);
		});
		if (section === "recents") browser.showRecents();
	}

	#select(tab: SettingsCategory): void {
		this.#tab = tab;
		for (const [id, button] of this.#tabs) {
			button.setAttribute("aria-selected", String(tab === id));
			button.tabIndex = tab === id ? 0 : -1;
		}
		if (tab === "general") this.#general();
		else if (tab === "appearance") this.#panels.set(tab, renderAppearance());
		else if (tab === "plan") this.#plan();
		else if (tab === "friends") this.#drawFriends();
		else if (tab === "company") this.#drawCompany();
		else if (this.#company) {
			const company = this.#company;
			const memberId = this.#auth.userId!;
			const signal = () => AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]);
			const environment = {
				profileId: company.profile.profileId,
				environmentId: company.profile.environmentId,
			};
			if (tab === "my-connections" && !this.#connections) {
				const lifetime = signal();
				const signIns = memberProviderSignIns(memberId, company.profile.profileId);
				// A sign-in belongs to the member, not to this page: it continues while
				// the page is rebuilt or closed, and stops only if the account changes.
				const auth = this.#auth;
				const signIn = createWebNativeSubscription(
					this.#api.cloud,
					company.profile.profileId,
					memberId,
					new AbortController().signal,
					() => {
						if (auth.userId !== memberId) throw new Error("The account changed.");
					},
				);
				this.#connections = new ConnectionsView(
					createWebNativeSubscription(this.#api.cloud, company.profile.profileId, memberId, lifetime, () => {
						lifetime.throwIfAborted();
						if (this.#auth.userId !== memberId || this.#company !== company || company.store.get().accessLost)
							throw new Error("The account or company changed.");
					}),
					lifetime,
					signIns,
					(input) => signIn.beginProviderLogin(input),
					undefined,
					undefined,
					memberPlanSignIn(memberId, company.profile.profileId),
				);
				// The member's own coding environment variables: anyone who may write sets their own.
				this.#memberEnvironment = new CodingEnvironmentView(
					createWebCodingEnvironment(this.#api.cloud, environment, memberId),
					lifetime,
					{ owner: "member", access: { canManage: () => company.store.get().team?.capabilities.write === true } },
				);
				this.#panels.set(
					tab,
					connectionsPage(
						t("My connections"),
						t(
							"Your own AI subscriptions. They pay for the work you start, including your routines, and they leave with you.",
						),
						this.#connections.el,
						this.#memberEnvironment.el,
					),
				);
			} else if (tab === "company-connections" && !this.#services) {
				// Step 7 connectors, the company's coding environment variables, then its webhooks and
				// mailboxes. Company first: owners and admins manage them, everyone sees them.
				const canManage = () => {
					const role = company.store.get().team?.role;
					return role === "owner" || role === "admin";
				};
				this.#services = new ServicesView(createWebConnectors(this.#api.cloud, environment), signal(), {
					access: {
						canManage,
						memberName: (userId) =>
							company.store.get().team?.members.find((member) => member.userId === userId)?.displayName ||
							undefined,
					},
				});
				// Where a company variable is given decides where a member's own of that name is used, so My
				// connections reads its list again after each change here (opened later, it reads one anyway).
				this.#companyEnvironment = new CodingEnvironmentView(
					createWebCodingEnvironment(this.#api.cloud, environment, memberId),
					signal(),
					{ owner: "company", access: { canManage }, onChange: () => this.#memberEnvironment?.reload() },
				);
				this.#hooks = new HooksView(createWebEventHooks(this.#api.cloud, environment), signal(), {
					access: { canManage },
				});
				this.#panels.set(
					tab,
					connectionsPage(
						t("Company connections"),
						t(
							"The company's own accounts, webhooks and mailboxes. Every agent can use them, and they stay when someone leaves.",
						),
						this.#services.el,
						this.#companyEnvironment.el,
						this.#hooks.el,
					),
				);
			}
		}
		const panel =
			this.#panels.get(tab) ??
			h(
				"div",
				null,
				h("h1", null, t(TABS.find((item) => item.id === tab)!.label)),
				notice("neutral", t("Open a company to see these settings.")),
			);
		this.#content.setAttribute("aria-labelledby", `settings-tab-${tab}`);
		// A company change selects the open tab again; its panel, and a field being typed in, stay put.
		if (panel.parentElement !== this.#content) replace(this.#content, panel);
	}

	/** General shows only the account's error and message, so it is redrawn only
	 * when those change: a control in use keeps focus when the plan arrives. */
	#loadedAccount(next: AccountViewState): void {
		const redraw = next.error !== this.#account.error || next.message !== this.#account.message;
		this.#account = next;
		if (redraw) this.#general();
		if (this.#panels.has("plan")) this.#plan();
	}

	#general(): void {
		if (this.#lifetime.signal.aborted) return;
		if (!this.#panels.has("general"))
			this.#panels.set("general", h("div", null, this.#accountPanel, this.#rulesSlot));
		renderAccount(this.#auth, this.#accountPanel, this.#account, (next) => {
			if (this.#lifetime.signal.aborted) return;
			this.#account = { ...this.#account, ...next };
			this.#general();
		});
		// The open company's rules sit under the account's settings, loaded once General is shown.
		const company = this.#company;
		if (company && !this.#rules && this.#tab === "general")
			this.#rules = new RulesView(
				createWebReviewRules(this.#api.cloud, company.profile.profileId),
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				() => company.store.get().team?.role,
			);
		// Moved only when it changes: moving it would take the focus out of a field in use.
		const rules = company ? this.#rules?.el : this.#noCompanyRules;
		if (this.#rulesSlot.firstChild !== (rules ?? null)) {
			const focused = this.#rulesSlot.contains(document.activeElement);
			replace(this.#rulesSlot, rules);
			// A field in the old company's rules had the keyboard: keep it in Settings.
			if (focused) this.#content.focus({ preventScroll: true });
		}
	}

	/** The plan is the account's; the usage shown is the open company's computer hours and storage. */
	#plan(): void {
		if (this.#lifetime.signal.aborted) return;
		let panel = this.#panels.get("plan");
		if (!panel) {
			panel = h("div");
			this.#panels.set("plan", panel);
		}
		const company = this.#company;
		if (this.#tab === "plan" && company && !this.#file && !this.#fileLoading && !this.#fileError)
			void this.#loadFile();
		if (this.#tab === "plan") this.#payments.load();
		this.#planFounder = company ? founderOf(company) : undefined;
		if (
			this.#tab === "plan" &&
			company &&
			!this.#hours &&
			!this.#hoursLoading &&
			!this.#hoursMissing &&
			!this.#hoursFailed
		)
			void this.#loadHours();
		renderPlan(
			panel,
			this.#account,
			company
				? {
						companyName: company.profile.profileName,
						file: this.#file,
						loading: this.#fileLoading,
						error: this.#fileError,
						retry: () => void this.#loadFile(true),
						hours: {
							value: this.#hours,
							loading: this.#hoursLoading || (!this.#hours && !this.#hoursMissing && !this.#hoursFailed),
							missing: this.#hoursMissing,
							failed: this.#hoursFailed,
						},
						profileId: company.profile.profileId,
						founder: this.#planFounder,
						memberName: (userId) =>
							company.store.get().team?.members.find((member) => member.userId === userId)?.displayName,
					}
				: undefined,
			{
				payments: {
					state: this.#payments.state,
					checkout: (itemKey, profileId) => this.#payments.checkout(itemKey, profileId),
					portal: () => this.#payments.portal(),
					companyName: (profileId) => this.#profiles.find((item) => item.profileId === profileId)?.profileName,
				},
			},
		);
	}

	#drawFriends(): void {
		if (this.#lifetime.signal.aborted) return;
		let panel = this.#panels.get("friends");
		if (!panel) {
			panel = h("div");
			this.#panels.set("friends", panel);
		}
		renderFriends(this.#friends, this.#hub, panel);
	}

	#countInvitations(): void {
		const count = this.#hub.store.get().invitations.length;
		this.#invitationCount.textContent = count ? String(count) : "";
		this.#invitationCount.hidden = count === 0;
	}

	#setCompany(company: CompanyController | undefined, owned: boolean): void {
		this.#folderStop.abort();
		this.#folder?.dispose();
		this.#folder = undefined;
		this.#folderAuthority = undefined;
		this.#storageSearch.value = "";
		this.#companyLifetime.abort();
		this.#companyLifetime = new AbortController();
		this.#unsubscribe?.();
		this.#connections?.dispose();
		this.#connections = undefined;
		this.#memberEnvironment?.dispose();
		this.#memberEnvironment = undefined;
		this.#services?.dispose();
		this.#services = undefined;
		this.#companyEnvironment?.dispose();
		this.#companyEnvironment = undefined;
		this.#hooks?.dispose();
		this.#hooks = undefined;
		this.#rules?.dispose();
		this.#rules = undefined;
		this.#memory?.dispose();
		this.#memory = undefined;
		this.#pages?.dispose();
		this.#pages = undefined;
		if (this.#ownsCompany) this.#company?.stop();
		this.#company = company;
		this.#ownsCompany = owned;
		this.#feedback = {};
		this.#file = undefined;
		this.#fileLoading = false;
		this.#fileError = undefined;
		this.#hours = undefined;
		this.#hoursLoading = false;
		this.#hoursMissing = false;
		this.#hoursFailed = false;
		for (const tab of ["company", "my-connections", "company-connections"] as const) this.#panels.delete(tab);
		if (company) {
			this.#unsubscribe = company.store.subscribe(() => {
				if (company.store.get().accessLost) {
					this.#close();
					return;
				}
				this.#memberEnvironment?.update();
				this.#services?.update();
				this.#companyEnvironment?.update();
				this.#hooks?.update();
				this.#rules?.update();
				this.#memory?.update();
				this.#pages?.update();
				this.#drawCompany();
				if (this.#folder || this.#mode === "storage") this.#drawStorage();
				// "Buy hours" is for founders: the plan tab follows the member's role once the team loads.
				if (this.#panels.has("plan") && founderOf(company) !== this.#planFounder) this.#plan();
			});
			if (owned) void company.start();
		}
		if (this.#mode === "storage") this.#drawStorage();
		else this.#select(this.#tab);
	}

	#drawCompany(): void {
		if (this.#lifetime.signal.aborted || !this.#company) return;
		const company = this.#company;
		if (this.#tab === "company" && !this.#file && !this.#fileLoading && !this.#fileError) void this.#loadFile();
		let panel = this.#panels.get("company");
		if (!panel) {
			panel = h("div");
			this.#panels.set("company", panel);
		}
		let team = panel.querySelector<HTMLElement>(".settings-team");
		if (!team) {
			team = h("div", { class: "settings-team" });
			replace(
				panel,
				team,
				h(
					"section",
					{ class: "settings-group settings-staff-group" },
					h("h2", null, uiText("Staff at work")),
					h("div", { class: "settings-staff" }),
				),
				h("div", { class: "settings-memory-slot" }),
				h("div", { class: "settings-pages-slot" }),
				h("div", { class: "settings-file" }),
				h("div", { class: "settings-company-exit" }),
			);
		}
		if (this.#tab === "company" && !this.#memory) {
			const profileId = company.profile.profileId;
			this.#memory = new MemoryView(
				{
					read: () => this.#api.getCompanyMemory(profileId),
					choose: (mode) => this.#api.setCompanyMemory(profileId, mode),
				},
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				() => company.store.get().team?.role,
			);
		}
		const memorySlot = panel.querySelector<HTMLElement>(".settings-memory-slot")!;
		if (this.#memory && memorySlot.firstChild !== this.#memory.el) replace(memorySlot, this.#memory.el);
		// The pages are read once the Company tab shows, and kept until the company changes.
		if (!this.#pages && this.#tab === "company") {
			const environmentId = company.profile.environmentId;
			this.#pages = new PagesView(
				interfacePageCalls(this.#api.cloud, environmentId),
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				() => company.store.get().team?.role,
				() => this.#pagesChanged(environmentId),
			);
		}
		const pagesSlot = panel.querySelector<HTMLElement>(".settings-pages-slot")!;
		if (this.#pages && pagesSlot.firstChild !== this.#pages.el) replace(pagesSlot, this.#pages.el);
		const staffList = panel.querySelector<HTMLElement>(".settings-staff")!;
		const staffFocus = staffList.contains(document.activeElement)
			? document.activeElement?.closest("a")?.getAttribute("href")
			: undefined;
		replace(
			staffList,
			...company.store
				.get()
				.staff.filter((agent) => agent.employmentStatus === "active")
				.map((agent) =>
					h(
						"a",
						{ href: `#/c/${company.profile.profileId}/staff/${agent.id}`, title: agent.displayName },
						agentFigure(agent, agent.displayName, { size: 46 }),
						h("small", null, agent.displayName),
					),
				),
		);
		const storage = storageSummary(this.#file, this.#fileError);
		replace(
			panel.querySelector(".settings-file")!,
			h(
				"button",
				{
					type: "button",
					class: "settings-card settings-file-card",
					"data-profile-id": company.profile.profileId,
					onclick: () => this.#switchMode("storage"),
				},
				icon("folder"),
				h(
					"div",
					{ class: "settings-copy" },
					h("strong", null, uiText("Storage")),
					h("small", null, storage.text),
					storage.meter,
				),
				icon("chevron"),
			),
			this.#fileError
				? button(uiText("Retry"), () => void this.#loadFile(true), { small: true, disabled: this.#fileLoading })
				: null,
		);
		if (staffFocus)
			[...staffList.querySelectorAll("a")]
				.find((link) => link.getAttribute("href") === staffFocus)
				?.focus({ preventScroll: true });
		renderTeam(
			this.#api,
			company,
			team,
			this.#feedback,
			(next) => {
				if (this.#lifetime.signal.aborted || this.#company !== company) return;
				this.#feedback = next;
				this.#drawCompany();
			},
			{
				friends: this.#friends.store.get().loaded ? this.#friends.store.get().friends : undefined,
				signal: this.#companyLifetime.signal,
				embedded: true,
				exit: panel.querySelector<HTMLElement>(".settings-company-exit")!,
				addFriend: () => {
					// A settings search can hide the Friends tab; clear it so the open tab shows in the menu.
					if (this.#tabs.get("friends")?.hidden) {
						this.#search.value = "";
						this.#search.dispatchEvent(new Event("input"));
					}
					this.#select("friends");
					this.#panels.get("friends")?.querySelector<HTMLInputElement>(".panel-search input")?.focus();
				},
				onCompanyRemoved: (profileId) => {
					if (!this.#lifetime.signal.aborted && this.#company === company) this.#close();
					this.#companyRemoved(profileId);
				},
			},
		);
	}

	/** This month's computer hours of the open company. A cloud without the meter shows "Not measured yet". */
	async #loadHours(): Promise<void> {
		const company = this.#company;
		if (!company || this.#hoursLoading) return;
		const signal = this.#companyLifetime.signal;
		this.#hoursLoading = true;
		try {
			const hours = await this.#api.getCompanyComputerHours(company.profile.profileId);
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			this.#hours = hours;
		} catch (error) {
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			if (error instanceof CloudRpcError && error.missing) this.#hoursMissing = true;
			else this.#hoursFailed = true;
		} finally {
			if (!signal.aborted && !this.#lifetime.signal.aborted) {
				this.#hoursLoading = false;
				if (this.#panels.has("plan")) this.#plan();
			}
		}
	}

	/** `redraw` (a retry) repaints at once so the Retry button disables while the load runs. */
	async #loadFile(redraw = false): Promise<void> {
		const company = this.#company;
		if (!company || this.#fileLoading) return;
		const signal = this.#companyLifetime.signal;
		this.#fileLoading = true;
		if (redraw) {
			this.#drawCompany();
			if (this.#panels.has("plan")) this.#plan();
		}
		try {
			const file = await this.#api.getCompanyFile(company.profile.environmentId);
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			this.#file = file;
			this.#fileError = undefined;
		} catch (error) {
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			this.#fileError = describeError(error);
		} finally {
			if (!signal.aborted && !this.#lifetime.signal.aborted) {
				this.#fileLoading = false;
				this.#drawCompany();
				if (this.#panels.has("plan")) this.#plan();
			}
		}
	}
}
