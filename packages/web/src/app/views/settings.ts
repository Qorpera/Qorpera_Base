import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import { WebCompanyFiles } from "../../cloud/company-files.ts";
import { createWebConnectors } from "../../cloud/connectors.ts";
import { createWebNativeSubscription } from "../../cloud/native-subscription.ts";
import { createWebReviewRules } from "../../cloud/review-rules.ts";
import type { HostedCompanyFile, HostedProfile } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, h, icon, notice, replace } from "../../ui/dom.ts";
import { leave } from "../../ui/motion.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";
import type { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { currentRoute } from "../router.ts";
import { type AccountViewState, renderAccount } from "./account.ts";
import { renderAppearance } from "./appearance.ts";
import { CompanyFolderBrowser } from "./company-folder.ts";
import { FriendsController, renderFriends } from "./friends.ts";
import type { HubController } from "./hub.ts";
import { AccountSubscriptionsView } from "./settings-ai-subscriptions.ts";
import { ConnectionsView, memberPlanSignIn, memberProviderSignIns } from "./settings-connections.ts";
import { GoodWillView, MyGoodWillView } from "./settings-good-will.ts";
import { MemoryView } from "./settings-memory.ts";
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
			"account language region time zone timezone good will goodwill appearance theme light dark composer color colour blue green grey gray interface size big small generelt konto sprog dansk engelsk område tidszone udseende tema lys mørk skrivefelt farve blå grøn grå grænseflade størrelse stor lille",
	},
	{
		id: "company",
		label: phrase("Company"),
		icon: "company",
		keywords:
			"people team members invitations staff memory notebooks shared context beta delete leave good will goodwill tax invoices card payment sales rules agent rules auto-review review approval approve ask first allow automatically safety agents actions permissions virksomhed personer medlemmer invitationer agenter hukommelse notesbøger delt kontekst roller slet forlad skat fakturaer kort betaling salg regler agentregler godkendelse godkend spørg først tillad automatisk sikkerhed handlinger tilladelser",
	},
	{
		id: "friends",
		label: phrase("Friends"),
		icon: "friends",
		keywords:
			"people contacts requests add email invitations invites join accept decline venner personer kontakter anmodninger tilføj e-mail invitationer inviter accepter afvis",
	},
	{
		id: "ai-subscriptions",
		label: phrase("AI subscriptions"),
		icon: "key",
		keywords:
			"ai subscriptions my connections model accounts providers sign in openai chatgpt codex anthropic claude usage ai-abonnementer mine forbindelser modelkonti udbydere abonnementer log ind forbrug",
	},
	{
		id: "company-connections",
		label: phrase("Company connections"),
		icon: "connections",
		keywords:
			"services accounts gmail google drive github token secrets agents virksomhedens forbindelser tjenester konti hemmeligheder agenter",
	},
] as const;
type SettingsCategory = (typeof TABS)[number]["id"];
/** "my-connections" is AI subscriptions' old name: Settings opened on it show AI subscriptions. "appearance" was a
 * tab of its own: it is part of General now. Sites, webhooks, mailboxes and Digital Post left Settings (Jonas, 9 Nov
 * 2026): Sites is a page of the apps drawer, webhooks are under an agent's routines, and the Mailbox makes its own
 * addresses and connects Digital Post. */
export type SettingsTab = SettingsCategory | "storage" | "recents" | "my-connections" | "appearance";
/** Pages of the open company. Settings with no company open (from the company list with several) show only the
 * account's pages: these are hidden, and one asked for shows General until a company is open. Storage too. */
const COMPANY_TABS: ReadonlySet<SettingsCategory> = new Set(["company", "company-connections"]);

/** AI subscriptions' lead, with or without a company open. */
const subscriptionsLead = () =>
	t("Your own AI subscriptions. They pay for the work you start, including your routines, and they leave with you.");

/** A connections tab: its title, the rule that sorts a connection into it, then its lists. */
function connectionsPage(title: string, rule: string, ...content: HTMLElement[]): HTMLElement {
	return h("div", null, h("h1", null, title), h("p", { class: "settings-lead" }, rule), ...content);
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
	readonly #empty = h("p", { class: "muted small", hidden: true }, t("No settings found."));
	readonly #modes = h("div", { class: "settings-modes", role: "group", "aria-label": t("Settings and storage") });
	readonly #storageNav = h("nav", {
		class: "settings-nav settings-storage-nav",
		"aria-label": t("Storage"),
		hidden: true,
	});
	readonly #storageCompany = h("div", { class: "settings-nav-heading" });
	readonly #storageUsage = h("div", { class: "settings-storage-usage" });
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
	/** A folder link's path, shown once Storage has its browser (openFolderPath). */
	#folderPath: string | undefined;
	#folderStop = new AbortController();
	#folderAuthority: string | undefined;
	#account: AccountViewState = { loading: true };
	#company: CompanyController | undefined;
	#ownsCompany = false;
	#unsubscribe: (() => void) | undefined;
	#companyLifetime = new AbortController();
	#connections: ConnectionsView | undefined;
	/** AI subscriptions with no company open: the member's account logins. */
	#accountSubscriptions: AccountSubscriptionsView | undefined;
	#services: ServicesView | undefined;
	#rules: RulesView | undefined;
	/** Company: the company's memory, Agent notebooks or the Shared context beta. */
	#memory: MemoryView | undefined;
	/** The company's good will, on the Company tab. */
	#goodWill: GoodWillView | undefined;
	/** General with no company open: the good will of the member's companies. */
	#myGoodWill: MyGoodWillView | undefined;
	/** General: the account's settings, then how the app looks. */
	readonly #accountPanel = h("div");
	readonly #myGoodWillSlot = h("div");
	#feedback: TeamFeedback = {};
	#file: HostedCompanyFile | undefined;
	#fileLoading = false;
	#fileError: string | undefined;

	constructor(
		api: CloudApi,
		auth: AuthController,
		hub: HubController,
		profiles: HostedProfile[],
		company: CompanyController | undefined,
		close: () => void,
		companyRemoved: (profileId: string) => void,
		tab: SettingsTab = "general",
	) {
		this.#api = api;
		this.#auth = auth;
		this.#hub = hub;
		this.#friends = new FriendsController(api);
		this.#close = close;
		this.#companyRemoved = companyRemoved;
		this.#borrowedCompany = company;
		const route = currentRoute();
		this.#overCompany = Boolean(company) || route.name === "company";
		const search = this.#search;
		const empty = this.#empty;
		const nav = this.#nav;
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
					onclick: () => {
						this.#mode = "settings";
						this.#select(tab.id);
					},
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
			const index = tabs.findIndex(([id]) => id === this.#shownTab());
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
			const first = this.#filterTabs();
			if (first && this.#tabs.get(this.#shownTab())?.hidden) this.#select(first);
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
		const modes = this.#modes;
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
		this.#storageNav.append(this.#storageCompany, storageTabs, this.#storageUsage);
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
			),
		);
		document.addEventListener("keydown", this.#onKey, { signal: this.#lifetime.signal });
		// The tab asked for is drawn first: the Company tab's rules load only if Settings opens on it.
		this.#tab =
			tab === "storage" || tab === "recents" || tab === "appearance"
				? "general"
				: tab === "my-connections"
					? "ai-subscriptions"
					: tab;
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
		(this.#storageShown() ? this.#storageTabs.get(this.#storageSection) : this.#tabs.get(this.#shownTab()))?.focus();
	}

	/** A folder link (ui/folder-links.ts): Storage shows what it names, a folder in the list or a file in the preview,
	 * once the company's folder is open. */
	openFolderPath(path: string): void {
		if (this.#lifetime.signal.aborted) return;
		this.#folderPath = path;
		this.#storageSection = "documents";
		if (this.#mode === "storage") this.#drawStorage();
		else this.#switchMode("storage");
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
		const companies = (list: HostedProfile[]) =>
			list
				.map((item) => item.profileId)
				.sort()
				.join();
		const joined = companies(profiles) !== companies(this.#profiles);
		this.#profiles = profiles;
		if (profile?.profileId === this.#company?.profile.profileId) {
			// No company open: AI subscriptions sign in through one of the member's companies, so a company joined or
			// left reads them again.
			if (!this.#company && joined && this.#accountSubscriptions) {
				this.#accountSubscriptions.dispose();
				this.#accountSubscriptions = undefined;
				this.#panels.delete("ai-subscriptions");
				if (!this.#storageShown() && this.#shownTab() === "ai-subscriptions") this.#select(this.#tab);
			}
			return;
		}
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
		this.#accountSubscriptions?.dispose();
		this.#services?.dispose();
		this.#rules?.dispose();
		this.#memory?.dispose();
		this.#goodWill?.dispose();
		this.#myGoodWill?.dispose();
		this.#friends.dispose();
		if (this.#ownsCompany) this.#company?.stop();
		leave(this.el, "is-leaving", () => this.el.remove());
	}

	#onKey = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.isComposing) return;
		if (document.querySelector("[role=alertdialog]:not([data-leaving], [data-leaving] *)")) return;
		// A dialog opened over Settings (a page shown across the window) keeps its own keys.
		if (event.target instanceof Element && !this.el.contains(event.target) && event.target.closest("dialog")?.open)
			return;
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

	/** Storage is the open company's: with none open, Settings show their pages instead and offer no Storage. */
	#storageShown(): boolean {
		return this.#mode === "storage" && Boolean(this.#company);
	}

	/** The tab Settings show: the one chosen, or General while a company page is chosen and no company is open. */
	#shownTab(): SettingsCategory {
		return this.#company || !COMPANY_TABS.has(this.#tab) ? this.#tab : "general";
	}

	/** Hides the company's pages while no company is open, and the pages the search does not match. Returns the first
	 * page left. Every word must match, so "delete company" finds the tab its button is on. */
	#filterTabs(): SettingsCategory | undefined {
		const words = this.#search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		for (const tab of TABS) {
			const text = `${tab.label} ${tab.keywords}`.toLowerCase();
			this.#tabs.get(tab.id)!.hidden =
				(!this.#company && COMPANY_TABS.has(tab.id)) || !words.every((word) => text.includes(word));
		}
		const first = [...this.#tabs.entries()].find(([, button]) => !button.hidden);
		this.#empty.hidden = Boolean(first);
		return first?.[0];
	}

	#switchMode(mode: "settings" | "storage"): void {
		this.#mode = mode;
		const storage = this.#storageShown();
		this.#modes.hidden = !this.#company;
		this.#nav.hidden = storage;
		this.#content.hidden = storage;
		this.#search.hidden = storage;
		this.#storageNav.hidden = !storage;
		this.#storageContent.hidden = !storage;
		this.#storageSearch.hidden = !storage;
		for (const [value, control] of this.#modeButtons)
			control.setAttribute("aria-pressed", String((storage ? "storage" : "settings") === value));
		if (storage) this.#drawStorage(true);
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
	 * tears down in-flight reads and downloads before a browser with the new authority is opened. `shown`: Storage is
	 * being shown again, so its dates are drawn again in the time zone chosen meanwhile; a company update alone redraws
	 * nothing in an open browser, so a focused file row keeps its focus. */
	#drawStorage(shown = false): void {
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
		this.#drawStorageUsage();
		// Shown again after a failed read, Storage reads its usage again.
		if (shown && this.#fileError && !this.#fileLoading) this.#fileError = undefined;
		if (company && !this.#file && !this.#fileLoading && !this.#fileError) void this.#loadFile();
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
		if (this.#folder) {
			// Settings may have changed the time zone while Storage was hidden.
			if (shown) this.#folder.redraw();
			this.#revealFolderPath(this.#folder);
			return;
		}
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
		void browser.open().then(
			() => {
				// The browser has taken the link's path: it shows it from here, or says why it can't.
				if (this.#folder === browser) this.#folderPath = undefined;
			},
			() => {
				if (signal.aborted || this.#folder !== browser) return;
				browser.dispose();
				this.#folder = undefined;
				replace(
					this.#storageContent,
					notice("danger", t("The Company File could not be read just now.")),
					button(t("Retry opening Company File"), () => this.#drawStorage()),
				);
			},
		);
		if (section === "recents") browser.showRecents();
		this.#revealFolderPath(browser);
	}

	/** Hands a folder link's path to the browser. It is kept until a browser has opened, so Retry after a failed open
	 * still shows what the link names. */
	#revealFolderPath(browser: CompanyFolderBrowser): void {
		const path = this.#folderPath;
		if (path === undefined) return;
		browser.reveal(path);
		if (browser.opened) this.#folderPath = undefined;
	}

	/** The company's storage under Storage's navigation: what is used of what it may hold. */
	#drawStorageUsage(): void {
		if (!this.#company) {
			replace(this.#storageUsage);
			return;
		}
		const storage = storageSummary(this.#file, this.#fileError);
		replace(
			this.#storageUsage,
			storage.meter,
			h("small", null, storage.text),
			this.#fileError
				? button(
						uiText("Retry"),
						() => {
							this.#fileError = undefined;
							void this.#loadFile();
							this.#drawStorageUsage();
						},
						{ small: true },
					)
				: null,
		);
	}

	#select(choice: SettingsCategory): void {
		this.#tab = choice;
		const tab = this.#shownTab();
		for (const [id, button] of this.#tabs) {
			button.setAttribute("aria-selected", String(tab === id));
			button.tabIndex = tab === id ? 0 : -1;
		}
		if (tab === "general") this.#general();
		else if (tab === "friends") this.#drawFriends();
		else if (tab === "company") this.#drawCompany();
		else if (tab === "ai-subscriptions" && !this.#company) this.#drawAccountSubscriptions();
		else if (this.#company) {
			const company = this.#company;
			const memberId = this.#auth.userId!;
			const signal = () => AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]);
			const environment = {
				profileId: company.profile.profileId,
				environmentId: company.profile.environmentId,
			};
			if (tab === "ai-subscriptions" && !this.#connections) {
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
				// Coding values (environment variables a coding session gets) are no longer drawn here (Jonas, 9 Nov 2026:
				// not something to show founders); the cloud keeps them.
				this.#panels.set(tab, connectionsPage(t("AI subscriptions"), subscriptionsLead(), this.#connections.el));
			} else if (tab === "company-connections" && !this.#services) {
				// Step 7 connectors. Owners and admins manage them, everyone sees them. The company's coding values are no
				// longer drawn here (Jonas, 9 Nov 2026); the cloud keeps them.
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
				this.#panels.set(
					tab,
					connectionsPage(
						t("Company connections"),
						t("The company's own accounts. Every agent can use them, and they stay when someone leaves."),
						this.#services.el,
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

	/** AI subscriptions with no company open: the member's account logins, signed in through one of their companies
	 * (settings-ai-subscriptions.ts). */
	#drawAccountSubscriptions(): void {
		if (this.#accountSubscriptions) return;
		const memberId = this.#auth.userId!;
		const auth = this.#auth;
		const cloud = this.#api.cloud;
		const lifetime = AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal]);
		this.#accountSubscriptions = new AccountSubscriptionsView(
			this.#profiles,
			(profile) => {
				const profileId = profile.profileId;
				// As on a company's page, a sign-in belongs to the member, not to this page.
				const signIn = createWebNativeSubscription(cloud, profileId, memberId, new AbortController().signal, () => {
					if (auth.userId !== memberId) throw new Error("The account changed.");
				});
				return {
					client: createWebNativeSubscription(cloud, profileId, memberId, lifetime, () => {
						lifetime.throwIfAborted();
						if (
							auth.userId !== memberId ||
							this.#company ||
							!this.#profiles.some((item) => item.profileId === profileId)
						)
							throw new Error("The account or company changed.");
					}),
					signIns: memberProviderSignIns(memberId, profileId),
					begin: (input) => signIn.beginProviderLogin(input),
				};
			},
			lifetime,
		);
		this.#panels.set(
			"ai-subscriptions",
			connectionsPage(t("AI subscriptions"), subscriptionsLead(), this.#accountSubscriptions.el),
		);
	}

	/** General shows only the account's error and message, so it is redrawn only
	 * when those change: a control in use keeps focus when the entitlement arrives. */
	#loadedAccount(next: AccountViewState): void {
		const redraw = next.error !== this.#account.error || next.message !== this.#account.message;
		this.#account = next;
		if (redraw) this.#general();
	}

	#general(): void {
		if (this.#lifetime.signal.aborted) return;
		if (!this.#panels.has("general"))
			this.#panels.set("general", h("div", null, this.#accountPanel, renderAppearance(), this.#myGoodWillSlot));
		renderAccount(this.#auth, this.#accountPanel, this.#account, (next) => {
			if (this.#lifetime.signal.aborted) return;
			this.#account = { ...this.#account, ...next };
			this.#general();
		});
		const company = this.#company;
		// With no company open, the good will of the member's companies, read once General shows.
		if (!company && !this.#myGoodWill && this.#tab === "general")
			this.#myGoodWill = new MyGoodWillView(
				() => this.#api.getMyGoodWill(),
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal]),
			);
		const mine = company ? undefined : this.#myGoodWill?.el;
		if (this.#myGoodWillSlot.firstChild !== (mine ?? null)) replace(this.#myGoodWillSlot, mine);
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
		// A folder link names a path in the company Settings showed when it was followed.
		if (company !== this.#company) this.#folderPath = undefined;
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
		this.#accountSubscriptions?.dispose();
		this.#accountSubscriptions = undefined;
		this.#services?.dispose();
		this.#services = undefined;
		this.#rules?.dispose();
		this.#rules = undefined;
		this.#memory?.dispose();
		this.#memory = undefined;
		this.#goodWill?.dispose();
		this.#goodWill = undefined;
		this.#myGoodWill?.dispose();
		this.#myGoodWill = undefined;
		if (this.#ownsCompany) this.#company?.stop();
		this.#company = company;
		this.#ownsCompany = owned;
		this.#feedback = {};
		this.#file = undefined;
		this.#fileLoading = false;
		this.#fileError = undefined;
		for (const tab of ["company", "ai-subscriptions", "company-connections"] as const) this.#panels.delete(tab);
		if (company) {
			this.#unsubscribe = company.store.subscribe(() => {
				if (company.store.get().accessLost) {
					this.#close();
					return;
				}
				this.#services?.update();
				this.#rules?.update();
				this.#memory?.update();
				this.#drawCompany();
				if (this.#folder || this.#mode === "storage") this.#drawStorage();
			});
			if (owned) void company.start();
		}
		this.#filterTabs();
		this.#switchMode(this.#mode);
	}

	#drawCompany(): void {
		if (this.#lifetime.signal.aborted || !this.#company) return;
		const company = this.#company;
		let panel = this.#panels.get("company");
		if (!panel) {
			panel = h("div", { class: "settings-company", "data-profile-id": company.profile.profileId });
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
				h("div", { class: "settings-good-will-slot" }),
				h("div", { class: "settings-rules-slot" }),
				h("div", { class: "settings-memory-slot" }),
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
		// Good will, under Staff at work (design A): read once the Company tab shows, kept until the company changes.
		if (this.#tab === "company" && !this.#goodWill) {
			const profileId = company.profile.profileId;
			this.#goodWill = new GoodWillView(
				{
					read: () => this.#api.getCompanyGoodWill(profileId),
					cardPage: () => this.#api.startGoodWillCard(profileId),
					open: (url) => window.location.assign(url),
				},
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				() => company.profile.profileName,
			);
		}
		const goodWillSlot = panel.querySelector<HTMLElement>(".settings-good-will-slot")!;
		if (this.#goodWill && goodWillSlot.firstChild !== this.#goodWill.el) replace(goodWillSlot, this.#goodWill.el);
		// The agent rules, under good will: read once the Company tab shows, kept until the company changes.
		if (this.#tab === "company" && !this.#rules)
			this.#rules = new RulesView(
				createWebReviewRules(this.#api.cloud, company.profile.profileId),
				AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				() => company.store.get().team?.role,
			);
		const rulesSlot = panel.querySelector<HTMLElement>(".settings-rules-slot")!;
		if (this.#rules && rulesSlot.firstChild !== this.#rules.el) replace(rulesSlot, this.#rules.el);
		const memorySlot = panel.querySelector<HTMLElement>(".settings-memory-slot")!;
		if (this.#memory && memorySlot.firstChild !== this.#memory.el) replace(memorySlot, this.#memory.el);
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

	/** The company's file, for the storage it uses under Storage's navigation. */
	async #loadFile(): Promise<void> {
		const company = this.#company;
		if (!company || this.#fileLoading) return;
		const signal = this.#companyLifetime.signal;
		this.#fileLoading = true;
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
				if (this.#mode === "storage") this.#drawStorageUsage();
			}
		}
	}
}
