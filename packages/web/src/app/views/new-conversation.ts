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
	#query = "";
	#editing = false;
	#pending = false;
	#syncControls: () => void = () => {};
	#draft: AgentDraft = { displayName: "", role: "", charter: "", figure: "rocket", color: nativeColorOf("rocket") };
	constructor(company: CompanyController, actions: WorkspaceActions, close: () => void) {
		this.#company = company;
		this.#actions = actions;
		this.#close = close;
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
		replace(
			this.el,
			h(
				"header",
				{ class: "new-conversation-header" },
				h("label", null, "To:", search),
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close new conversation", onclick: this.#close },
					icon("close"),
				),
			),
			h(
				"div",
				{ class: "new-conversation-body" },
				h("h1", null, "New conversation"),
				h("p", { class: "muted" }, "Pick an agent to talk to, or create someone new."),
				button(
					[
						icon("plus"),
						h(
							"span",
							null,
							h("strong", null, "New agent"),
							h("small", null, "Choose a name, figure and responsibility"),
						),
					],
					() => this.#configure(),
					{ disabled: !this.#company.store.get().team?.capabilities.write },
				),
				this.#results,
			),
		);
		this.el.querySelector(".new-conversation-body > button")?.classList.add("new-agent-card");
		this.#drawResults();
	}
	#drawResults(): void {
		const create = this.el.querySelector<HTMLButtonElement>(".new-agent-card");
		if (create) create.disabled = !this.#company.store.get().team?.capabilities.write;
		const agents = this.#company.store
			.get()
			.staff.filter(
				(agent) =>
					agent.employmentStatus === "active" &&
					`${agent.displayName} ${agent.role}`.toLowerCase().includes(this.#query.trim().toLowerCase()),
			);
		replace(
			this.#results,
			h("h2", null, "Your agents"),
			...agents.map((agent) =>
				h(
					"a",
					{
						class: "recipient-row",
						href:
							agent.templateId === "co-founder" ||
							agent.id === this.#company.store.get().organization?.cofounder.staffAgentId
								? `#/c/${this.#company.profile.profileId}`
								: `#/c/${this.#company.profile.profileId}/staff/${agent.id}`,
					},
					agentFigure(agent, agent.displayName, { size: 42 }),
					h("span", null, h("strong", null, agent.displayName), h("small", null, agent.role)),
					icon("chevron"),
				),
			),
			agents.length
				? null
				: h("p", { class: "empty" }, this.#query ? "No matching agents." : "No agents available."),
		);
	}
	#configure(): void {
		if (!this.#company.store.get().team?.capabilities.write) return;
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
			const canWrite = this.#company.store.get().team?.capabilities.write === true;
			fields.disabled = this.#pending || !canWrite;
			create.disabled = this.#pending || !canWrite || !this.#actions.createAgent;
			back.disabled = this.#pending;
		};
		form.onsubmit = async (event) => {
			event.preventDefault();
			if (
				this.#pending ||
				!this.#actions.createAgent ||
				!this.#company.store.get().team?.capabilities.write ||
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
			h("header", { class: "new-conversation-header" }, back),
			h("div", { class: "new-conversation-body" }, form),
		);
		name.focus();
	}
}
