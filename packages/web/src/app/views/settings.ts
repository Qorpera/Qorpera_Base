import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import type { HostedFriend, HostedProfile } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, notice, replace } from "../../ui/dom.ts";
import type { AuthController } from "../auth.ts";
import { CompanyController } from "../company.ts";
import { type AccountViewState, renderAccount } from "./account.ts";
import { ConnectionsView } from "./settings-connections.ts";
import { PolicyView } from "./settings-policy.ts";
import { renderTeam } from "./team.ts";

const TABS = [
	{ id: "general", label: "General", keywords: "account plan billing feedback companies" },
	{ id: "company", label: "Company", keywords: "people team members invitations staff file organization approvals" },
	{
		id: "connections",
		label: "Connections",
		keywords: "providers subscriptions openai codex anthropic claude secrets",
	},
	{ id: "policy", label: "Policy", keywords: "spending communication changes sharing ask act auto" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** A settings session owns its async work; the conversation stays mounted below it. */
export class SettingsView {
	readonly el: HTMLElement;
	readonly #api: CloudApi;
	readonly #auth: AuthController;
	readonly #close: () => void;
	readonly #lifetime = new AbortController();
	readonly #content = h("div", { class: "settings-content", id: "settings-content", role: "tabpanel", tabindex: "0" });
	readonly #panels = new Map<Tab, HTMLElement>();
	readonly #tabs = new Map<Tab, HTMLButtonElement>();
	readonly #borrowedCompany: CompanyController | undefined;
	readonly #companyPicker = h("select", { class: "settings-company-picker", "aria-label": "Company for settings" });
	readonly #companyLabel = h("label", { class: "settings-company-label" }, "Company", this.#companyPicker);
	#profiles: HostedProfile[] = [];
	#tab: Tab = "general";
	#account: AccountViewState = { loading: true };
	#company: CompanyController | undefined;
	#ownsCompany = false;
	#unsubscribe: (() => void) | undefined;
	#companyLifetime = new AbortController();
	#connections: ConnectionsView | undefined;
	#policy: PolicyView | undefined;
	#friends: HostedFriend[] | undefined;
	#feedback: { message?: string; error?: string } = {};

	constructor(
		api: CloudApi,
		auth: AuthController,
		profiles: HostedProfile[],
		company: CompanyController | undefined,
		close: () => void,
	) {
		this.#api = api;
		this.#auth = auth;
		this.#close = close;
		this.#borrowedCompany = company;
		const search = h("input", { type: "search", placeholder: "Search settings", "aria-label": "Search settings" });
		const empty = h("p", { class: "muted small", hidden: true }, "No settings found.");
		const nav = h("nav", { class: "settings-nav", "aria-label": "Settings sections" }, search);
		const tablist = h("div", { role: "tablist", "aria-label": "Settings sections", "aria-orientation": "vertical" });
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
				tab.label,
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
			const query = search.value.trim().toLowerCase();
			for (const tab of TABS)
				this.#tabs.get(tab.id)!.hidden = !`${tab.label} ${tab.keywords}`.toLowerCase().includes(query);
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
				{ class: "settings-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Settings" },
				nav,
				this.#content,
				h(
					"button",
					{ type: "button", class: "settings-close", "aria-label": "Close settings", onclick: close },
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
			.then((entitlement) => {
				this.#account = { loaded: true, entitlement };
				this.#general();
			})
			.catch((error) => {
				this.#account = { loaded: true, error: describeError(error) };
				this.#general();
			});
		void api
			.listFriends()
			.then((friends) => {
				if (this.#lifetime.signal.aborted) return;
				this.#friends = friends;
				this.#drawCompany();
			})
			.catch((error) => {
				if (this.#lifetime.signal.aborted) return;
				this.#feedback = { error: describeError(error) };
				this.#drawCompany();
			});
		this.#select("general");
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
			h("option", { value: "" }, "Choose a company"),
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
		this.#policy?.dispose();
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

	#select(tab: Tab): void {
		this.#tab = tab;
		for (const [id, button] of this.#tabs) {
			button.setAttribute("aria-selected", String(tab === id));
			button.tabIndex = tab === id ? 0 : -1;
		}
		if (tab === "general") this.#general();
		else if (tab === "company") this.#drawCompany();
		else if (this.#company) {
			if (tab === "connections") {
				this.#connections ??= new ConnectionsView();
				this.#panels.set(tab, this.#connections.el);
			} else {
				this.#policy ??= new PolicyView();
				this.#panels.set(tab, this.#policy.el);
			}
		}
		const panel =
			this.#panels.get(tab) ??
			h(
				"div",
				null,
				h("h1", null, TABS.find((item) => item.id === tab)!.label),
				notice("neutral", "Choose a company to view these settings."),
			);
		this.#content.setAttribute("aria-labelledby", `settings-tab-${tab}`);
		replace(this.#content, panel);
	}

	#general(): void {
		if (this.#lifetime.signal.aborted) return;
		let panel = this.#panels.get("general");
		if (!panel) {
			panel = h("div");
			this.#panels.set("general", panel);
		}
		renderAccount(this.#auth, this.#api, panel, this.#account, (next) => {
			if (this.#lifetime.signal.aborted) return;
			this.#account = { ...this.#account, ...next };
			this.#general();
		});
	}

	#setCompany(company: CompanyController | undefined, owned: boolean): void {
		this.#companyLifetime.abort();
		this.#companyLifetime = new AbortController();
		this.#unsubscribe?.();
		this.#connections?.dispose();
		this.#connections = undefined;
		this.#policy?.dispose();
		this.#policy = undefined;
		if (this.#ownsCompany) this.#company?.stop();
		this.#company = company;
		this.#ownsCompany = owned;
		this.#feedback = {};
		for (const tab of ["company", "connections", "policy"] as const) this.#panels.delete(tab);
		if (company) {
			this.#unsubscribe = company.store.subscribe(() => {
				if (company.store.get().accessLost) {
					this.#close();
					return;
				}
				this.#drawCompany();
			});
			if (owned) void company.start();
		}
		this.#select(this.#tab);
	}

	#drawCompany(): void {
		if (this.#lifetime.signal.aborted || !this.#company) return;
		const company = this.#company;
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
				h("h1", null, company.profile.profileName),
				team,
				h(
					"section",
					{ class: "settings-group" },
					h("h2", null, "Staff at work"),
					h("div", { class: "settings-staff" }),
				),
				...(
					[
						["file", "Company File", "Browse files, snapshots and proposals"],
						["organization", "Organization", "Responsibilities, projects and staff"],
						["approvals", "Approvals", "Review requests that need your decision"],
					] as const
				).map(([path, title, detail]) =>
					h(
						"a",
						{ class: "settings-card settings-link", href: `#/c/${company.profile.profileId}/${path}` },
						h("span", { class: "settings-copy" }, h("strong", null, title), h("small", null, detail)),
						h("span", { "aria-hidden": "true" }, "›"),
					),
				),
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
						agentFigure(agent, agent.displayName, { size: 42 }),
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
			{ friends: this.#friends, signal: this.#companyLifetime.signal, embedded: true },
		);
	}
}
