import type { CloudApi } from "../../cloud/api.ts";
import { WebCompanyFiles } from "../../cloud/company-files.ts";
import { createWebDefaultModels } from "../../cloud/default-models.ts";
import { createWebGeminiKey } from "../../cloud/gemini-key.ts";
import { createWebNativeSubscription } from "../../cloud/native-subscription.ts";
import { createWebReviewRules } from "../../cloud/review-rules.ts";
import type { HostedProfile, HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { companyLogos } from "../../ui/company-logos.ts";
import { h, icon, notice, replace } from "../../ui/dom.ts";
import { friendsCount } from "../../ui/friends-count.ts";
import { leave, reducedMotion } from "../../ui/motion.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";
import type { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { currentRoute } from "../router.ts";
import { type AccountViewState, renderAccount } from "./account.ts";
import { renderAppearance } from "./appearance.ts";
import { FriendsController } from "./friends.ts";
import type { HubController } from "./hub.ts";
import { LeaderboardView } from "./leaderboard.ts";
import { AccountSubscriptionsView } from "./settings-ai-subscriptions.ts";
import { CompanyBrandView } from "./settings-brand.ts";
import { ConnectionsView, memberPlanSignIn, memberProviderSignIns } from "./settings-connections.ts";
import { DefaultModelsView } from "./settings-default-models.ts";
import { GeminiKeyView } from "./settings-gemini-key.ts";
import { GoodWillView, goodWillName, MyGoodWillView } from "./settings-good-will.ts";
import { RulesView } from "./settings-rules.ts";
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
			"people team members invitations staff delete leave good will goodwill tax invoices card payment sales rules agent rules auto-review review approval approve ask first allow automatically safety agents actions permissions virksomhed personer medlemmer invitationer agenter roller slet forlad skat fakturaer kort betaling salg regler agentregler godkendelse godkend spørg først tillad automatisk sikkerhed handlinger tilladelser",
	},
	{
		id: "leaderboard",
		label: phrase("Leaderboard"),
		icon: "trophy",
		keywords:
			"friends compare ranking awards streak tasks agents companies sales leaderboard venner sammenlign rangliste priser stime opgaver agenter virksomheder salg",
	},
	{
		id: "ai-subscriptions",
		label: phrase("AI subscriptions"),
		icon: "key",
		keywords:
			"ai subscriptions default models conversational coding effort credits my connections model accounts providers sign in openai chatgpt codex anthropic claude google gemini neon api key usage ai-abonnementer standardmodeller mine forbindelser modelkonti udbydere abonnementer log ind forbrug kredit",
	},
] as const;
type SettingsCategory = (typeof TABS)[number]["id"];
/** "my-connections" is AI subscriptions' old name: Settings opened on it show AI subscriptions. "appearance" was a
 * tab of its own: it is part of General now. Sites, webhooks, mailboxes and Digital Post left Settings (Jonas, 9 Nov
 * 2026): Sites is a page of the apps drawer, webhooks are under an agent's routines, and the Mailbox makes its own
 * addresses and connects Digital Post. Company connections (Gmail, Google Drive, GitHub) left too (Jonas, 10 Nov 2026:
 * companies are fully Qorpera-hosted; back only if it is needed). */
export type SettingsTab = SettingsCategory | "my-connections" | "appearance";
const COMPANY_TABS: ReadonlySet<SettingsCategory> = new Set(["company"]);

export interface SettingsPlace {
	readonly tab: SettingsTab;
	readonly label: string;
	readonly area: string;
	readonly words: string;
	readonly mark?: string;
}

export function settingsPlaces(deletes: boolean): SettingsPlace[] {
	const general = phrase("General");
	const company = phrase("Company");
	const subscriptions = phrase("AI subscriptions");
	const place = (tab: SettingsTab, label: string, area: string, words: string, mark?: string): SettingsPlace => ({
		tab,
		label,
		area,
		words,
		...(mark ? { mark } : {}),
	});
	const exit = deletes ? t("Delete company") : t("Leave company");
	return [
		place(
			"general",
			t("Account"),
			general,
			"name email password picture konto navn adgangskode billede",
			t("Account"),
		),
		place(
			"general",
			t("Language & region"),
			general,
			"language region time zone timezone sprog dansk english tidszone område",
			t("Language & region"),
		),
		place(
			"general",
			t("Appearance"),
			general,
			"theme dark light mode colour color composer interface size tema mørk lys farve størrelse",
			t("Appearance"),
		),
		place("general", goodWillName(), general, "goodwill good will tax skat", goodWillName()),
		place(
			"company",
			t("Staff at work"),
			company,
			"members people team invitations invite staff medlemmer personer invitationer inviter",
			t("Staff at work"),
		),
		place(
			"company",
			t("Agent rules"),
			company,
			"rules approve approval ask first allow permissions safety regler godkend tilladelser",
			t("Agent rules"),
		),
		place("company", exit, company, "delete leave remove slet forlad", exit),
		place(
			"company",
			t("Invoices and card"),
			company,
			"invoices card payment billing good will tax fakturaer kort betaling skat",
			goodWillName(),
		),
		place(
			"leaderboard",
			phrase("Leaderboard"),
			t("Settings"),
			"friends compare ranking awards streak venner rangliste",
		),
		place(
			"ai-subscriptions",
			t("Model accounts"),
			subscriptions,
			"chatgpt openai codex claude anthropic gemini google sign in login log ind",
			t("Model accounts"),
		),
		place(
			"ai-subscriptions",
			t("Default models"),
			subscriptions,
			"model effort coding conversational standardmodeller",
			t("Default models"),
		),
		place("ai-subscriptions", t("Gemini API key"), subscriptions, "google gemini api key nøgle", t("Gemini API key")),
	];
}

export function markSettingsPlace(text: string): void {
	const until = performance.now() + 2500;
	const look = () => {
		const content = document.querySelector<HTMLElement>(".settings-content:not([hidden])");
		const found = [...(content?.querySelectorAll<HTMLElement>("h2, button, summary") ?? [])].find(
			(element) => element.textContent?.trim() === text && !element.closest("[hidden]"),
		);
		if (!found) {
			if (performance.now() < until) requestAnimationFrame(look);
			return;
		}
		const target = found.closest<HTMLElement>(".settings-group") ?? found;
		target.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
		target.classList.remove("is-found");
		void target.offsetWidth;
		target.classList.add("is-found");
		target.addEventListener("animationend", () => target.classList.remove("is-found"), { once: true });
	};
	requestAnimationFrame(look);
}

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
	readonly #hub: HubController;
	readonly #auth: AuthController;
	/** The account's friends, for the Company tab's invitation picker; the list itself is the Friends window's. */
	readonly #friends: FriendsController;
	readonly #close: () => void;
	/** Opens the Friends window over Settings. */
	readonly #openFriends: () => void;
	/** Leaderboard, read once its tab shows. */
	#leaderboard: LeaderboardView | undefined;
	readonly #companyRemoved: (profileId: string) => void;
	readonly #lifetime = new AbortController();
	readonly #content = h("div", { class: "settings-content", id: "settings-content", role: "tabpanel", tabindex: "0" });
	readonly #search = h("input", {
		type: "search",
		class: "settings-search-input",
		placeholder: t("Search settings"),
		"aria-label": t("Search settings"),
	});
	readonly #nav = h("nav", { class: "settings-nav", "aria-label": t("Settings sections") });
	readonly #empty = h("p", { class: "muted small", hidden: true }, t("No settings found."));
	readonly #panels = new Map<SettingsCategory, HTMLElement>();
	readonly #tabs = new Map<SettingsCategory, HTMLButtonElement>();
	readonly #borrowedCompany: CompanyController | undefined;
	/** Opened on a company's page, even one whose company is not available. */
	readonly #overCompany: boolean;
	#profiles: HostedProfile[] = [];
	#tab: SettingsCategory = "general";
	#account: AccountViewState = {};
	#company: CompanyController | undefined;
	#ownsCompany = false;
	#unsubscribe: (() => void) | undefined;
	#companyLifetime = new AbortController();
	#unlinkCompanyLifetime: (() => void) | undefined;
	#staffRef: readonly HostedStaffAgent[] | undefined;
	#staffSnap: string | undefined;
	#teamSnap:
		| {
				profileId: string;
				profileName: string;
				team: unknown;
				error: string | undefined;
				accessLost: boolean | undefined;
				loading: boolean;
				feedback: TeamFeedback;
				friends: unknown;
				hash: string;
		  }
		| undefined;
	#defaultModels: DefaultModelsView | undefined;
	#connections: ConnectionsView | undefined;
	#geminiKey: GeminiKeyView | undefined;
	/** AI subscriptions with no company open: the member's account logins. */
	#accountSubscriptions: AccountSubscriptionsView | undefined;
	#rules: RulesView | undefined;
	#brand: CompanyBrandView | undefined;
	/** The company's good will, on the Company tab. */
	#goodWill: GoodWillView | undefined;
	/** General with no company open: the good will of the member's companies. */
	#myGoodWill: MyGoodWillView | undefined;
	/** General: the account's settings, then how the app looks. */
	readonly #accountPanel = h("div");
	readonly #myGoodWillSlot = h("div");
	#feedback: TeamFeedback = {};

	constructor(
		api: CloudApi,
		auth: AuthController,
		hub: HubController,
		profiles: HostedProfile[],
		company: CompanyController | undefined,
		close: () => void,
		companyRemoved: (profileId: string) => void,
		tab: SettingsTab = "general",
		openFriends: () => void = () => {},
	) {
		this.#api = api;
		this.#hub = hub;
		this.#auth = auth;
		this.#friends = new FriendsController(api);
		this.#close = close;
		this.#companyRemoved = companyRemoved;
		this.#openFriends = openFriends;
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
					onclick: () => this.#select(tab.id),
				},
				icon(tab.icon),
				uiText(tab.label),
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
		const friendsCountSlot = h("span", { class: "settings-friends-count" });
		const friendsButton = h(
			"button",
			{ type: "button", class: "settings-friends", onclick: () => this.#openFriends() },
			icon("friends"),
			uiText(phrase("Friends")),
			friendsCountSlot,
		);
		const countInvitations = () => {
			const waiting = hub.store.get().invitations.length;
			friendsCountSlot.replaceChildren(...(waiting > 0 ? [friendsCount(waiting)] : []));
			const label =
				waiting > 0 ? t("Friends: {count} company invitations waiting", { count: waiting }) : t("Friends");
			friendsButton.setAttribute("aria-label", label);
			friendsButton.title = label;
		};
		countInvitations();
		this.#lifetime.signal.addEventListener("abort", hub.store.subscribe(countInvitations));
		this.el = h(
			"div",
			{
				class: "settings-overlay",
				onclick: (event: MouseEvent) => {
					if (event.target === this.el) close();
					else if (event.target instanceof Element && event.target.closest("a[data-href^='#/']")) close();
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
					h("div", { class: "settings-search", role: "search" }, icon("search"), search),
					friendsButton,
					h(
						"button",
						{ type: "button", class: "settings-close", "aria-label": t("Close settings"), onclick: close },
						icon("close"),
					),
				),
				h("div", { class: "settings-body" }, nav, this.#content),
			),
		);
		document.addEventListener("keydown", this.#onKey, { signal: this.#lifetime.signal });
		// The tab asked for is drawn first: the Company tab's rules load only if Settings opens on it.
		this.#tab = tab === "appearance" ? "general" : tab === "my-connections" ? "ai-subscriptions" : tab;
		this.#setCompany(company, false);
		this.updateProfiles(profiles);
		// The friends list feeds the Company tab's invitation picker.
		this.#friends.store.subscribe(() => {
			if (this.#tab === "company") this.#drawCompany();
		});
		void this.#friends.refresh();
	}

	/** The account's friends: the Friends window opened over Settings shares this list with the invitation picker. */
	get friends(): FriendsController {
		return this.#friends;
	}

	/** The open tab, so a language change can reopen Settings where it was. */
	get tab(): SettingsTab {
		return this.#tab;
	}

	focus(): void {
		this.#tabs.get(this.#shownTab())?.focus();
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
				if (this.#shownTab() === "ai-subscriptions") this.#select(this.#tab);
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
		this.#unlinkCompanyLifetime?.();
		this.#unlinkCompanyLifetime = undefined;
		this.#lifetime.abort();
		this.#companyLifetime.abort();
		this.#unsubscribe?.();
		this.#defaultModels?.dispose();
		this.#connections?.dispose();
		this.#geminiKey?.dispose();
		this.#accountSubscriptions?.dispose();
		this.#rules?.dispose();
		this.#goodWill?.dispose();
		this.#myGoodWill?.dispose();
		this.#friends.dispose();
		if (this.#ownsCompany) this.#company?.stop();
		leave(this.el, "is-leaving", () => this.el.remove());
	}

	#onKey = (event: KeyboardEvent): void => {
		if (event.defaultPrevented || event.isComposing) return;
		if (document.querySelector("[role=alertdialog]:not([data-leaving], [data-leaving] *)")) return;
		if (event.target instanceof Element && event.target.closest("dialog")?.open) return;
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
				"button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],a[data-href],summary,[tabindex='0']",
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

	#select(choice: SettingsCategory): void {
		this.#tab = choice;
		const tab = this.#shownTab();
		for (const [id, button] of this.#tabs) {
			button.setAttribute("aria-selected", String(tab === id));
			button.tabIndex = tab === id ? 0 : -1;
		}
		if (tab === "general") this.#general();
		else if (tab === "leaderboard") this.#drawLeaderboard();
		else if (tab === "company") this.#drawCompany();
		else if (tab === "ai-subscriptions" && !this.#company) this.#drawAccountSubscriptions();
		else if (this.#company) {
			const company = this.#company;
			const memberId = this.#auth.userId!;
			if (tab === "ai-subscriptions" && !this.#connections) {
				const lifetime = this.#companyLifetime.signal;
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
				const checkCurrent = () => {
					lifetime.throwIfAborted();
					if (this.#auth.userId !== memberId || this.#company !== company || company.store.get().accessLost)
						throw new Error("The account or company changed.");
				};
				this.#defaultModels = new DefaultModelsView(
					createWebDefaultModels(this.#api.cloud, company.profile.profileId, memberId, lifetime, checkCurrent),
					lifetime,
				);
				const refreshDefaults = () => void this.#defaultModels?.refresh();
				this.#connections = new ConnectionsView(
					createWebNativeSubscription(
						this.#api.cloud,
						company.profile.profileId,
						memberId,
						lifetime,
						checkCurrent,
					),
					lifetime,
					signIns,
					(input) => signIn.beginProviderLogin(input),
					undefined,
					undefined,
					memberPlanSignIn(memberId, company.profile.profileId),
					undefined,
					refreshDefaults,
				);
				this.#geminiKey = new GeminiKeyView(
					createWebGeminiKey(this.#api.cloud, company.profile.profileId, memberId, lifetime, checkCurrent),
					lifetime,
					refreshDefaults,
				);
				this.#panels.set(
					tab,
					connectionsPage(
						t("AI subscriptions"),
						subscriptionsLead(),
						this.#defaultModels.el,
						this.#connections.el,
						this.#geminiKey.el,
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
		const lifetime = this.#companyLifetime.signal;
		this.#accountSubscriptions = new AccountSubscriptionsView(
			this.#profiles,
			(profile) => {
				const profileId = profile.profileId;
				// As on a company's page, a sign-in belongs to the member, not to this page.
				const signIn = createWebNativeSubscription(cloud, profileId, memberId, new AbortController().signal, () => {
					if (auth.userId !== memberId) throw new Error("The account changed.");
				});
				const checkCurrent = () => {
					lifetime.throwIfAborted();
					if (
						auth.userId !== memberId ||
						this.#company ||
						!this.#profiles.some((item) => item.profileId === profileId)
					)
						throw new Error("The account or company changed.");
				};
				return {
					client: createWebNativeSubscription(cloud, profileId, memberId, lifetime, checkCurrent),
					signIns: memberProviderSignIns(memberId, profileId),
					begin: (input) => signIn.beginProviderLogin(input),
					defaultModels: createWebDefaultModels(cloud, profileId, memberId, lifetime, checkCurrent),
					gemini: createWebGeminiKey(cloud, profileId, memberId, lifetime, checkCurrent),
				};
			},
			lifetime,
		);
		this.#panels.set(
			"ai-subscriptions",
			connectionsPage(t("AI subscriptions"), subscriptionsLead(), this.#accountSubscriptions.el),
		);
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
			this.#myGoodWill = new MyGoodWillView(() => this.#api.getMyGoodWill(), this.#companyLifetime.signal);
		const mine = company ? undefined : this.#myGoodWill?.el;
		if (this.#myGoodWillSlot.firstChild !== (mine ?? null)) replace(this.#myGoodWillSlot, mine);
	}

	#drawLeaderboard(): void {
		if (this.#lifetime.signal.aborted) return;
		if (!this.#leaderboard) {
			this.#leaderboard = new LeaderboardView(this.#api, this.#lifetime.signal, () => this.#openFriends());
			this.#panels.set("leaderboard", this.#leaderboard.el);
		} else if (!this.#leaderboard.el.isConnected) void this.#leaderboard.load();
	}

	#setCompany(company: CompanyController | undefined, owned: boolean): void {
		this.#unlinkCompanyLifetime?.();
		this.#unlinkCompanyLifetime = undefined;
		this.#companyLifetime.abort();
		const companyLifetime = new AbortController();
		this.#companyLifetime = companyLifetime;
		const stopCompany = () => companyLifetime.abort();
		if (this.#lifetime.signal.aborted || company?.signal.aborted) {
			companyLifetime.abort();
		} else {
			this.#lifetime.signal.addEventListener("abort", stopCompany, { once: true });
			company?.signal.addEventListener("abort", stopCompany, { once: true });
			this.#unlinkCompanyLifetime = () => {
				this.#lifetime.signal.removeEventListener("abort", stopCompany);
				company?.signal.removeEventListener("abort", stopCompany);
			};
		}
		this.#unsubscribe?.();
		this.#defaultModels?.dispose();
		this.#defaultModels = undefined;
		this.#connections?.dispose();
		this.#connections = undefined;
		this.#geminiKey?.dispose();
		this.#geminiKey = undefined;
		this.#accountSubscriptions?.dispose();
		this.#accountSubscriptions = undefined;
		this.#rules?.dispose();
		this.#rules = undefined;
		this.#brand = undefined;
		this.#goodWill?.dispose();
		this.#goodWill = undefined;
		this.#myGoodWill?.dispose();
		this.#myGoodWill = undefined;
		if (this.#ownsCompany) this.#company?.stop();
		this.#company = company;
		this.#ownsCompany = owned;
		this.#feedback = {};
		this.#staffRef = undefined;
		this.#staffSnap = undefined;
		this.#teamSnap = undefined;
		for (const tab of ["company", "ai-subscriptions"] as const) this.#panels.delete(tab);
		if (company) {
			this.#unsubscribe = company.store.subscribe(() => {
				if (company.store.get().accessLost) {
					this.#close();
					return;
				}
				this.#rules?.update();
				if (this.#tab === "company") this.#drawCompany();
			});
			if (owned) void company.start();
		}
		this.#filterTabs();
		this.#select(this.#tab);
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
				h("div", { class: "settings-brand-slot" }),
				team,
				h(
					"section",
					{ class: "settings-group settings-staff-group" },
					h("h2", null, uiText("Staff at work")),
					h("div", { class: "settings-staff" }),
				),
				h("div", { class: "settings-good-will-slot" }),
				h("div", { class: "settings-rules-slot" }),
				h("div", { class: "settings-company-exit" }),
			);
		}
		// The name and the logo, built once the Company tab shows; opening it also brings the logo everyone sees in step
		// with the company folder's logo.svg (the Branding & Identity agent may have drawn a new one).
		if (this.#tab === "company" && !this.#brand) {
			const lifetime = this.#companyLifetime.signal;
			const folder = () => {
				const team = company.store.get().team;
				if (!team || company.store.get().accessLost) throw new Error(t("Company access changed."));
				return new WebCompanyFiles(this.#api.cloud, company.profile, company.userId, team.role, lifetime, () => {
					if (this.#company !== company || company.store.get().accessLost)
						throw new Error(t("Company access changed."));
				}).folder();
			};
			this.#brand = new CompanyBrandView({
				profileId: company.profile.profileId,
				name: () => company.profile.profileName,
				canManage: () => {
					const role = company.store.get().team?.role;
					return role === "owner" || role === "admin";
				},
				folder,
				signal: lifetime,
				renamed: (name) => {
					company.store.set(({ profile }) => ({ profile: { ...profile, profileName: name } }));
					this.#hub.renamed(company.profile.profileId, name);
				},
			});
			if (company.store.get().team?.capabilities.write)
				void companyLogos()
					?.sync(company.profile.profileId, folder, lifetime)
					.then(() => this.#brand?.update())
					.catch(() => undefined);
		}
		const brandSlot = panel.querySelector<HTMLElement>(".settings-brand-slot")!;
		if (this.#brand) {
			if (brandSlot.firstChild !== this.#brand.el) replace(brandSlot, this.#brand.el);
			this.#brand.update();
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
				this.#companyLifetime.signal,
				() => company.profile.profileName,
			);
		}
		const goodWillSlot = panel.querySelector<HTMLElement>(".settings-good-will-slot")!;
		if (this.#goodWill && goodWillSlot.firstChild !== this.#goodWill.el) replace(goodWillSlot, this.#goodWill.el);
		// The agent rules, under good will: read once the Company tab shows, kept until the company changes.
		if (this.#tab === "company" && !this.#rules)
			this.#rules = new RulesView(
				createWebReviewRules(this.#api.cloud, company.profile.profileId),
				this.#companyLifetime.signal,
				() => company.store.get().team?.role,
			);
		const rulesSlot = panel.querySelector<HTMLElement>(".settings-rules-slot")!;
		if (this.#rules && rulesSlot.firstChild !== this.#rules.el) replace(rulesSlot, this.#rules.el);
		const state = company.store.get();
		if (state.staff !== this.#staffRef || this.#staffSnap === undefined) {
			const activeStaff = state.staff.filter((agent) => agent.employmentStatus === "active");
			const staffSnap = JSON.stringify([
				company.profile.profileId,
				activeStaff.map((agent) => [
					agent.id,
					agent.displayName,
					agent.templateId,
					agent.appearance?.color ?? "",
					agent.appearance?.shape ?? "",
					agent.appearance?.creature ?? "",
				]),
			]);
			this.#staffRef = state.staff;
			if (staffSnap !== this.#staffSnap) {
				this.#staffSnap = staffSnap;
				const staffList = panel.querySelector<HTMLElement>(".settings-staff")!;
				const staffFocus = staffList.contains(document.activeElement)
					? document.activeElement?.closest("a")?.getAttribute("data-href")
					: undefined;
				replace(
					staffList,
					...activeStaff.map((agent) =>
						h(
							"a",
							{ href: `#/c/${company.profile.profileId}/staff/${agent.id}` },
							agentFigure(agent, agent.displayName, { size: 46 }),
							h("small", null, agent.displayName),
						),
					),
				);
				if (staffFocus)
					[...staffList.querySelectorAll("a")]
						.find((link) => link.getAttribute("data-href") === staffFocus)
						?.focus({ preventScroll: true });
			}
		}
		const friendsState = this.#friends.store.get();
		const friends = friendsState.loaded ? friendsState.friends : undefined;
		const teamSnap = {
			profileId: company.profile.profileId,
			profileName: company.profile.profileName,
			team: state.team,
			error: state.error,
			accessLost: state.accessLost,
			loading: state.loading,
			feedback: this.#feedback,
			friends,
			hash: location.hash,
		};
		const sameTeam =
			this.#teamSnap !== undefined &&
			this.#teamSnap.profileId === teamSnap.profileId &&
			this.#teamSnap.profileName === teamSnap.profileName &&
			this.#teamSnap.team === teamSnap.team &&
			this.#teamSnap.error === teamSnap.error &&
			this.#teamSnap.accessLost === teamSnap.accessLost &&
			this.#teamSnap.loading === teamSnap.loading &&
			this.#teamSnap.feedback === teamSnap.feedback &&
			this.#teamSnap.friends === teamSnap.friends &&
			this.#teamSnap.hash === teamSnap.hash;
		if (!sameTeam) {
			this.#teamSnap = teamSnap;
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
					friends,
					signal: this.#companyLifetime.signal,
					embedded: true,
					exit: panel.querySelector<HTMLElement>(".settings-company-exit")!,
					// Friends are a window of their own: it opens over Settings, on its search field.
					addFriend: () => this.#openFriends(),
					onCompanyRemoved: (profileId) => {
						if (!this.#lifetime.signal.aborted && this.#company === company) this.#close();
						this.#companyRemoved(profileId);
					},
				},
			);
		}
	}
}
