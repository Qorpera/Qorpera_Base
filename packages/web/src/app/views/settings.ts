import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import { createWebConnectors } from "../../cloud/connectors.ts";
import { createWebNativeSubscription } from "../../cloud/native-subscription.ts";
import { createWebReviewRules } from "../../cloud/review-rules.ts";
import type { HostedCompanyFile, HostedProfile } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { button, h, icon, notice, replace } from "../../ui/dom.ts";
import { phrase, t, uiText } from "../../ui/preferences.ts";
import type { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { type AccountViewState, renderAccount } from "./account.ts";
import { FriendsController, renderFriends } from "./friends.ts";
import type { HubController } from "./hub.ts";
import { renderPlan } from "./plan.ts";
import { ConnectionsView, ProviderSignIns } from "./settings-connections.ts";
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
			"account appearance theme composer color colour blue green grey gray language region time zone timezone generelt konto udseende tema lys mørk skrivefelt farve blå grøn grå sprog dansk engelsk område tidszone",
	},
	{
		id: "company",
		label: phrase("Company"),
		icon: "company",
		keywords:
			"people team members invitations staff file delete leave virksomhed personer medlemmer invitationer agenter virksomhedsfilen roller slet forlad",
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
		id: "connections",
		label: phrase("Connections"),
		icon: "connections",
		keywords:
			"providers subscriptions openai codex anthropic claude secrets forbindelser udbydere modelkonti konti tjenester gmail google drive github hemmeligheder",
	},
	{
		id: "rules",
		label: phrase("Rules"),
		icon: "lock",
		keywords:
			"auto-review review approval approve ask first allow automatically safety agents actions permissions regler godkendelse godkend spørg først tillad automatisk sikkerhed agenter handlinger tilladelser",
	},
] as const;
export type SettingsTab = (typeof TABS)[number]["id"];

/** Provider sign-ins in progress, per member and company, for the life of the tab. */
const SIGN_INS = new Map<string, ProviderSignIns>();

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
		placeholder: t("Search settings"),
		"aria-label": t("Search settings"),
	});
	readonly #panels = new Map<SettingsTab, HTMLElement>();
	readonly #tabs = new Map<SettingsTab, HTMLButtonElement>();
	readonly #borrowedCompany: CompanyController | undefined;
	readonly #companyPicker = h("select", { class: "settings-company-picker", "aria-label": t("Company for settings") });
	readonly #companyLabel = h("label", { class: "settings-company-label" }, t("Company"), this.#companyPicker);
	#profiles: HostedProfile[] = [];
	#tab: SettingsTab = "general";
	#account: AccountViewState = { loading: true };
	#company: CompanyController | undefined;
	#ownsCompany = false;
	#unsubscribe: (() => void) | undefined;
	#companyLifetime = new AbortController();
	#connections: ConnectionsView | undefined;
	#services: ServicesView | undefined;
	#rules: RulesView | undefined;
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
		const search = this.#search;
		const empty = h("p", { class: "muted small", hidden: true }, t("No settings found."));
		const nav = h("nav", { class: "settings-nav", "aria-label": t("Settings sections") }, search);
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
		nav.append(tablist, empty);
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
				{ class: "settings-dialog", role: "dialog", "aria-modal": "true", "aria-label": t("Settings") },
				nav,
				this.#content,
				h(
					"button",
					{ type: "button", class: "settings-close", "aria-label": t("Close settings"), onclick: close },
					"×",
				),
			),
		);
		document.addEventListener("keydown", this.#onKey, { signal: this.#lifetime.signal });
		this.#companyPicker.onchange = () => this.#chooseCompany();
		nav.append(this.#companyLabel);
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
		this.#select(tab);
	}

	/** The open tab, so a language change can reopen Settings where it was. */
	get tab(): SettingsTab {
		return this.#tab;
	}

	focus(): void {
		this.#tabs.get(this.#tab)?.focus();
	}

	updateProfiles(profiles: HostedProfile[]): void {
		if (this.#lifetime.signal.aborted || profiles === this.#profiles) return;
		const selected =
			profiles.find((profile) => profile.profileId === this.#company?.profile.profileId) ??
			(!this.#company && this.#profiles.length === 0 && profiles.length === 1 ? profiles[0] : undefined);
		this.#profiles = profiles;
		replace(
			this.#companyPicker,
			h("option", { value: "" }, t("Choose a company")),
			...profiles.map((profile) => h("option", { value: profile.profileId }, profile.profileName)),
		);
		this.#companyPicker.value = selected?.profileId ?? "";
		this.#companyLabel.hidden = profiles.length <= 1 && Boolean(this.#borrowedCompany) && Boolean(selected);
		this.#chooseCompany();
	}

	#chooseCompany(): void {
		const profile = this.#profiles.find((item) => item.profileId === this.#companyPicker.value);
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
		this.#lifetime.abort();
		this.#companyLifetime.abort();
		this.#unsubscribe?.();
		this.#connections?.dispose();
		this.#services?.dispose();
		this.#rules?.dispose();
		this.#friends.dispose();
		if (this.#ownsCompany) this.#company?.stop();
		this.el.remove();
	}

	#onKey = (event: KeyboardEvent): void => {
		if (document.querySelector("[role=alertdialog]")) return;
		if (event.key === "Escape") {
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
				!field.closest("[hidden]") && field.tabIndex >= 0 && (!closed || field === closed.querySelector("summary"))
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

	#select(tab: SettingsTab): void {
		this.#tab = tab;
		for (const [id, button] of this.#tabs) {
			button.setAttribute("aria-selected", String(tab === id));
			button.tabIndex = tab === id ? 0 : -1;
		}
		if (tab === "general") this.#general();
		else if (tab === "plan") this.#plan();
		else if (tab === "friends") this.#drawFriends();
		else if (tab === "company") this.#drawCompany();
		else if (this.#company) {
			if (tab === "connections") {
				if (!this.#connections) {
					const company = this.#company;
					const memberId = this.#auth.userId!;
					const signal = AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]);
					const key = `${memberId}:${company.profile.profileId}`;
					let signIns = SIGN_INS.get(key);
					if (!signIns) {
						signIns = new ProviderSignIns();
						SIGN_INS.set(key, signIns);
					}
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
						createWebNativeSubscription(this.#api.cloud, company.profile.profileId, memberId, signal, () => {
							signal.throwIfAborted();
							if (this.#auth.userId !== memberId || this.#company !== company || company.store.get().accessLost)
								throw new Error("The account or company changed.");
						}),
						signal,
						signIns,
						(input) => signIn.beginProviderLogin(input),
					);
					// Step 7 connectors sit under the model accounts on the same page.
					// Company first: owners and admins manage them, everyone sees them.
					this.#services = new ServicesView(
						createWebConnectors(this.#api.cloud, {
							profileId: company.profile.profileId,
							environmentId: company.profile.environmentId,
						}),
						signal,
						{
							access: {
								canManage: () => {
									const role = company.store.get().team?.role;
									return role === "owner" || role === "admin";
								},
								memberName: (userId) =>
									company.store.get().team?.members.find((member) => member.userId === userId)?.displayName ||
									undefined,
							},
						},
					);
					this.#panels.set(tab, h("div", null, this.#connections.el, this.#services.el));
				}
			} else if (tab === "rules" && !this.#rules) {
				const company = this.#company;
				this.#rules = new RulesView(
					createWebReviewRules(this.#api.cloud, company.profile.profileId),
					AbortSignal.any([this.#companyLifetime.signal, this.#lifetime.signal, company.signal]),
				);
				this.#panels.set(tab, this.#rules.el);
			}
		}
		const panel =
			this.#panels.get(tab) ??
			h(
				"div",
				null,
				h("h1", null, t(TABS.find((item) => item.id === tab)!.label)),
				notice("neutral", t("Choose a company to view these settings.")),
			);
		this.#content.setAttribute("aria-labelledby", `settings-tab-${tab}`);
		replace(this.#content, panel);
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
		let panel = this.#panels.get("general");
		if (!panel) {
			panel = h("div");
			this.#panels.set("general", panel);
		}
		renderAccount(this.#auth, panel, this.#account, (next) => {
			if (this.#lifetime.signal.aborted) return;
			this.#account = { ...this.#account, ...next };
			this.#general();
		});
	}

	/** The plan is the account's; the usage shown is the chosen company's storage. */
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
					}
				: undefined,
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
		this.#companyLifetime.abort();
		this.#companyLifetime = new AbortController();
		this.#unsubscribe?.();
		this.#connections?.dispose();
		this.#connections = undefined;
		this.#services?.dispose();
		this.#services = undefined;
		this.#rules?.dispose();
		this.#rules = undefined;
		if (this.#ownsCompany) this.#company?.stop();
		this.#company = company;
		this.#ownsCompany = owned;
		this.#feedback = {};
		this.#file = undefined;
		this.#fileLoading = false;
		this.#fileError = undefined;
		for (const tab of ["company", "connections", "rules"] as const) this.#panels.delete(tab);
		if (company) {
			this.#unsubscribe = company.store.subscribe(() => {
				if (company.store.get().accessLost) {
					this.#close();
					return;
				}
				this.#services?.update();
				this.#drawCompany();
			});
			if (owned) void company.start();
		}
		this.#select(this.#tab);
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
				h("div", { class: "settings-file" }),
				h("div", { class: "settings-company-exit" }),
			);
		}
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
				"a",
				{ class: "settings-card settings-file-card", href: `#/c/${company.profile.profileId}/file` },
				icon("file"),
				h(
					"div",
					{ class: "settings-copy" },
					h("strong", null, uiText("Company File")),
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
