import { agentFigure, figureElement, nativeColorOf } from "../../ui/avatar.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { FigurePicker } from "../../ui/figure-picker.ts";
import type { CompanyController } from "../company.ts";
import { navigate } from "../router.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";

export class NewConversationView {
	readonly el = h("section", { class: "new-conversation" });
	readonly #company: CompanyController;
	readonly #actions: WorkspaceActions;
	readonly #close: () => void;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	readonly #results = h("div", { class: "recipient-results" });
	readonly #chips = h("div", { class: "recipient-chips", "aria-label": "Selected recipients" });
	readonly #selected = new Set<string>();
	readonly #open = h("button", { type: "button", class: "btn btn-primary" }, "Open");
	readonly #selectionStatus = h("p", { class: "surface-status", role: "status" });
	readonly #navigation: HTMLButtonElement;
	#query = "";
	#editing = false;
	#pending = false;
	#syncControls: () => void = () => {};
	#draft: AgentDraft = { displayName: "", role: "", charter: "", figure: "rocket", color: nativeColorOf("rocket") };
	constructor(
		company: CompanyController,
		actions: WorkspaceActions,
		close: () => void,
		toggleNavigation?: () => void,
	) {
		this.#company = company;
		this.#actions = actions;
		this.#close = close;
		this.#navigation = h(
			"button",
			{
				type: "button",
				class: "mobile-navigation-toggle icon-button",
				"aria-label": "Company navigation",
				"aria-controls": "company-navigation",
				"aria-expanded": "false",
				hidden: !toggleNavigation,
				onclick: toggleNavigation,
			},
			icon("navigation"),
		);
		this.#open.onclick = () => this.#openSelection();
		this.#unsubscribe = company.store.subscribe(() => {
			if (!this.#editing) this.#drawResults();
			else this.#syncControls();
		});
		company.signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		this.#picker();
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#unsubscribe();
	}
	focus(): void {
		this.el.querySelector<HTMLInputElement>("input")?.focus();
	}
	setNavigationOpen(open: boolean): void {
		this.#navigation.setAttribute("aria-expanded", String(open));
	}
	#picker(): void {
		this.#editing = false;
		const search = h("input", {
			type: "search",
			value: this.#query,
			placeholder: "Search agents",
			"aria-label": "Search conversation recipients",
			autocomplete: "off",
			oninput: () => {
				this.#query = search.value;
				this.#drawResults();
			},
		});
		const create = button(
			[
				icon("plus"),
				h(
					"span",
					null,
					h("strong", null, "New agent"),
					h("small", null, "Give someone a name and a responsibility"),
				),
			],
			() => this.#configure(),
			{ disabled: !this.#company.store.get().team?.capabilities.authorize },
		);
		create.classList.add("new-agent-card");
		create.setAttribute("aria-label", "New agent");
		replace(
			this.el,
			h(
				"header",
				{ class: "new-conversation-header" },
				this.#navigation,
				h("label", null, "To:", search),
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close new conversation", onclick: this.#close },
					icon("close"),
				),
			),
			this.#chips,
			h(
				"div",
				{ class: "new-conversation-body" },
				h("h1", null, "New conversation"),
				h("p", { class: "muted" }, "Select one agent for a direct conversation, or several for a group chat."),
				this.#results,
				create,
			),
			h("footer", { class: "recipient-footer" }, this.#selectionStatus, button("Cancel", this.#close), this.#open),
		);
		this.#drawResults();
	}
	#drawResults(): void {
		const focused = document.activeElement?.getAttribute("data-agent-id");
		const active = this.#company.store.get().staff.filter((agent) => agent.employmentStatus === "active");
		for (const id of this.#selected) if (!active.some((agent) => agent.id === id)) this.#selected.delete(id);
		const create = this.el.querySelector<HTMLButtonElement>(".new-agent-card");
		if (create) create.disabled = !this.#company.store.get().team?.capabilities.authorize;
		const agents = active.filter((agent) =>
			`${agent.displayName} ${agent.role}`.toLowerCase().includes(this.#query.trim().toLowerCase()),
		);
		replace(
			this.#results,
			h("h2", null, this.#query ? "Matching agents" : "Suggested agents"),
			h(
				"div",
				{ class: "recipient-grid" },
				...agents.map((agent) =>
					h(
						"button",
						{
							type: "button",
							class: "recipient-card",
							"data-agent-id": agent.id,
							"aria-pressed": String(this.#selected.has(agent.id)),
							onclick: () => {
								if (this.#selected.has(agent.id)) this.#selected.delete(agent.id);
								else this.#selected.add(agent.id);
								this.#drawResults();
							},
						},
						agentFigure(agent, agent.displayName, { size: 48 }),
						h("span", null, h("strong", null, agent.displayName), h("small", null, agent.role)),
						this.#selected.has(agent.id) ? icon("check") : null,
					),
				),
			),
			agents.length
				? null
				: h("p", { class: "empty" }, this.#query ? "No matching agents." : "No agents available."),
		);
		const chipFocus = document.activeElement?.getAttribute("data-remove-recipient");
		replace(
			this.#chips,
			...active
				.filter((agent) => this.#selected.has(agent.id))
				.map((agent) =>
					h(
						"button",
						{
							type: "button",
							class: "recipient-chip",
							"aria-label": `Remove ${agent.displayName}`,
							"data-remove-recipient": agent.id,
							onclick: () => {
								this.#selected.delete(agent.id);
								this.#drawResults();
								this.focus();
							},
						},
						agentFigure(agent, agent.displayName, { size: 22 }),
						agent.displayName,
						icon("close"),
					),
				),
		);
		this.#chips.hidden = !this.#selected.size;
		this.#open.disabled = this.#selected.size !== 1;
		this.#selectionStatus.textContent =
			this.#selected.size > 1
				? "Group conversations are not available yet. Your selection stays here."
				: this.#selected.size === 1
					? "Open a conversation with this agent."
					: "Choose a recipient.";
		if (focused || chipFocus) {
			const target = focused
				? [...this.#results.querySelectorAll<HTMLButtonElement>("[data-agent-id]")].find(
						(button) => button.dataset.agentId === focused,
					)
				: [...this.#chips.querySelectorAll<HTMLButtonElement>("button")].find(
						(button) => button.dataset.removeRecipient === chipFocus,
					);
			if (target) target.focus({ preventScroll: true });
			else this.focus();
		}
	}
	#openSelection(): void {
		if (this.#selected.size !== 1) return;
		const agent = this.#company.staffById([...this.#selected][0]);
		if (!agent || agent.employmentStatus !== "active") return;
		const cofounder =
			agent.templateId === "co-founder" ||
			agent.id === this.#company.store.get().organization?.cofounder.staffAgentId;
		navigate(
			cofounder
				? { name: "company", profileId: this.#company.profile.profileId, section: "home" }
				: { name: "company", profileId: this.#company.profile.profileId, section: "staff", id: agent.id },
		);
	}
	#configure(): void {
		if (!this.#company.store.get().team?.capabilities.authorize) return;
		this.#editing = true;
		const stage = h(
			"div",
			{ class: "new-agent-stage" },
			figureElement(this.#draft.figure, this.#draft.color, { size: 112 }),
		);
		const name = h("input", {
			value: this.#draft.displayName,
			maxlength: "64",
			required: true,
			placeholder: "Agent name",
			"aria-label": "Agent name",
			autocomplete: "off",
			oninput: () => {
				this.#draft.displayName = name.value;
			},
		});
		const role = h("input", {
			value: this.#draft.role,
			maxlength: "160",
			required: true,
			placeholder: "For example, Research",
			"aria-label": "Agent title",
			oninput: () => {
				this.#draft.role = role.value;
			},
		});
		const charter = h("textarea", {
			value: this.#draft.charter,
			rows: 3,
			maxlength: "10000",
			placeholder: "What should this agent be responsible for?",
			"aria-label": "Agent responsibility",
			oninput: () => {
				this.#draft.charter = charter.value;
			},
		});
		const picker = new FigurePicker(this.#draft, (choice) => {
			this.#draft = { ...this.#draft, ...choice };
			replace(stage, figureElement(choice.figure, choice.color, { size: 112 }));
		});
		const fields = h(
			"fieldset",
			{ class: "agent-edit-fields" },
			stage,
			picker.el,
			h("label", null, "Name", name),
			h("label", null, "Title", role),
			h("label", null, "Responsibility", charter),
		);
		const status = h(
			"p",
			{ class: "surface-status", role: "status" },
			this.#actions.createAgent ? "" : "Agent creation is not available yet.",
		);
		const create = h(
			"button",
			{ class: "btn btn-primary", type: "submit", disabled: !this.#actions.createAgent },
			"Create agent",
		);
		const back = button([icon("back"), "Back"], () => {
			if (!this.#pending) {
				this.#picker();
				this.focus();
			}
		});
		const form = h(
			"form",
			{ class: "new-agent-form" },
			h("h1", null, "Create an agent"),
			fields,
			status,
			h("div", { class: "surface-actions" }, button("Cancel", this.#close), create),
		);
		this.#syncControls = () => {
			const canWrite = this.#company.store.get().team?.capabilities.authorize === true;
			fields.disabled = this.#pending || !canWrite;
			create.disabled = this.#pending || !canWrite || !this.#actions.createAgent;
			back.disabled = this.#pending;
		};
		form.onsubmit = async (event) => {
			event.preventDefault();
			if (
				this.#pending ||
				!this.#actions.createAgent ||
				!this.#company.store.get().team?.capabilities.authorize ||
				!form.reportValidity()
			)
				return;
			if (!name.value.trim() || !role.value.trim()) {
				status.textContent = "Enter a name and title.";
				return;
			}
			this.#pending = true;
			fields.disabled = true;
			create.disabled = true;
			back.disabled = true;
			status.textContent = "Creating agent…";
			try {
				const id = await this.#actions.createAgent(
					this.#company.profile.profileId,
					{
						...this.#draft,
						displayName: name.value.trim(),
						role: role.value.trim(),
						charter: charter.value.trim(),
					},
					this.#lifetime.signal,
				);
				if (this.#lifetime.signal.aborted || this.#company.signal.aborted) return;
				await this.#company.refreshStaff();
				if (!this.#lifetime.signal.aborted && !this.#company.signal.aborted)
					navigate({ name: "company", profileId: this.#company.profile.profileId, section: "staff", id });
			} catch {
				if (!this.#lifetime.signal.aborted)
					status.textContent = "The agent could not be created. Your draft is still here.";
			} finally {
				this.#pending = false;
				this.#syncControls();
			}
		};
		replace(
			this.el,
			h("header", { class: "new-conversation-header" }, this.#navigation, back),
			h("div", { class: "new-conversation-body" }, form),
		);
		name.focus();
	}
}
