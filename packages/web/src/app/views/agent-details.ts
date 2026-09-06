import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure, colorFor, figureElement, figureFor } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { FigurePicker } from "../../ui/figure-picker.ts";
import type { CompanyController } from "../company.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";

export class AgentDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #agent: HostedStaffAgent;
	readonly #actions: WorkspaceActions;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#pending = false;
	#syncControls: () => void = () => {};
	constructor(company: CompanyController, agent: HostedStaffAgent, actions: WorkspaceActions, onClose: () => void) {
		this.#company = company;
		this.#agent = agent;
		this.#actions = actions;
		this.dialog = new SurfaceDialog("Agent details", "agent-details", () => {
			this.#lifetime.abort();
			this.#unsubscribe();
			onClose();
		});
		this.#unsubscribe = company.store.subscribe(() => {
			if (company.signal.aborted || !company.store.get().team?.capabilities.read) this.dispose();
			else this.#syncControls();
		});
		company.signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		this.#show();
		this.dialog.open();
	}
	dispose(): void {
		this.dialog.close(false);
	}
	#show(): void {
		const agent = this.#company.staffById(this.#agent.id) ?? this.#agent;
		const canEdit = this.#company.store.get().team?.capabilities.write === true;
		const edit = button([icon("edit"), "Edit agent"], () => this.#edit(agent), { disabled: !canEdit });
		this.#syncControls = () => {
			edit.disabled = !this.#company.store.get().team?.capabilities.write;
		};
		const responsibilities =
			this.#company.store
				.get()
				.organization?.responsibilities.filter(
					(item) => item.accountableStaffAgentId === agent.id && item.status !== "retired",
				) ?? [];
		replace(
			this.dialog.content,
			h(
				"div",
				{ class: "agent-details-identity" },
				agentFigure(agent, agent.displayName, { size: 84 }),
				h("div", null, h("h2", null, agent.displayName), h("p", { class: "muted" }, agent.role)),
			),
			agent.charter ? h("p", { class: "agent-details-description" }, agent.charter) : null,
			h(
				"a",
				{
					class: "responsibility-link",
					href: `#/c/${this.#company.profile.profileId}/organization`,
					onclick: () => this.dialog.close(false),
				},
				icon("map"),
				h(
					"span",
					null,
					h("strong", null, "Responsibilities"),
					h(
						"small",
						null,
						responsibilities.length
							? responsibilities.map((item) => item.name).join(" · ")
							: "View the company responsibility map",
					),
				),
				icon("chevron"),
			),
			h("div", { class: "agent-details-footer" }, h("small", { class: "muted" }, "Agent details"), edit),
		);
	}
	#edit(agent: HostedStaffAgent): void {
		if (!this.#company.store.get().team?.capabilities.write) return;
		let draft: AgentDraft = {
			displayName: agent.displayName,
			role: agent.role,
			charter: agent.charter,
			figure: figureFor(agent),
			color: colorFor(agent),
		};
		const stage = h("div", { class: "agent-edit-stage" }, figureElement(draft.figure, draft.color, { size: 84 }));
		const name = h("input", {
			value: draft.displayName,
			required: true,
			maxlength: "64",
			autocomplete: "off",
			"aria-label": "Agent name",
		});
		const role = h("input", { value: draft.role, required: true, maxlength: "160", "aria-label": "Agent title" });
		const description = h("textarea", {
			value: draft.charter,
			rows: 3,
			maxlength: "10000",
			"aria-label": "Agent description",
		});
		const status = h(
			"p",
			{ class: "surface-status", role: "status" },
			this.#actions.updateAgent ? "" : "Saving agent changes is not available yet.",
		);
		const save = h(
			"button",
			{ type: "submit", class: "btn btn-primary", disabled: !this.#actions.updateAgent },
			"Save changes",
		);
		const picker = new FigurePicker(draft, (choice) => {
			draft = { ...draft, ...choice };
			replace(stage, figureElement(draft.figure, draft.color, { size: 84 }));
		});
		const fields = h(
			"fieldset",
			{ class: "agent-edit-fields" },
			stage,
			picker.el,
			h("label", null, "Name", name),
			h("label", null, "Title", role),
			h("label", null, "Description", description),
		);
		const cancel = button("Cancel", () => {
			if (!this.#pending) this.#show();
		});
		const form = h(
			"form",
			{ class: "agent-edit-form" },
			h("h2", null, "Edit agent"),
			fields,
			status,
			h("div", { class: "surface-actions" }, cancel, save),
		);
		this.#syncControls = () => {
			const canWrite = this.#company.store.get().team?.capabilities.write === true;
			fields.disabled = this.#pending || !canWrite;
			save.disabled = this.#pending || !canWrite || !this.#actions.updateAgent;
			cancel.disabled = this.#pending;
		};
		form.onsubmit = async (event) => {
			event.preventDefault();
			if (
				this.#pending ||
				!this.#actions.updateAgent ||
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
			save.disabled = true;
			cancel.disabled = true;
			status.textContent = "Saving…";
			try {
				await this.#actions.updateAgent(
					agent,
					{ ...draft, displayName: name.value.trim(), role: role.value.trim(), charter: description.value.trim() },
					this.#lifetime.signal,
				);
				if (this.#lifetime.signal.aborted) return;
				await this.#company.refreshStaff();
				if (!this.#lifetime.signal.aborted) this.#show();
			} catch {
				if (!this.#lifetime.signal.aborted)
					status.textContent = "Changes could not be saved. Your draft is still here.";
			} finally {
				this.#pending = false;
				this.#syncControls();
			}
		};
		replace(this.dialog.content, form);
		name.focus();
	}
}
