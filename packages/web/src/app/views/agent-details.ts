import type { HostedStaffAgent } from "../../cloud/types.ts";
import { colorFor, figureElement, figureFor } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { FigurePicker } from "../../ui/figure-picker.ts";
import { responsibilityCard } from "../../ui/responsibilities.ts";
import type { CompanyController } from "../company.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";

export class AgentDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #agent: HostedStaffAgent;
	readonly #actions: WorkspaceActions;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#editing = false;
	#renderedKey = "";
	#pending = false;
	#syncControls: () => void = () => {};
	constructor(
		company: CompanyController,
		agent: HostedStaffAgent,
		actions: WorkspaceActions,
		onClose: () => void,
		anchor?: HTMLElement,
	) {
		this.#company = company;
		this.#agent = agent;
		this.#actions = actions;
		this.dialog = new SurfaceDialog(
			"Agent details",
			"agent-details",
			() => {
				this.#lifetime.abort();
				this.#unsubscribe();
				onClose();
			},
			anchor,
		);
		this.#unsubscribe = company.store.subscribe(() => {
			if (company.signal.aborted || !company.store.get().team?.capabilities.read || !company.staffById(agent.id))
				this.dispose();
			else if (this.#editing) this.#syncControls();
			else this.#show();
		});
		company.signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		this.#show();
		this.dialog.open();
	}
	dispose(): void {
		this.dialog.close(false);
	}
	#show(): void {
		const wasEditing = this.#editing;
		this.#editing = false;
		const agent = this.#company.staffById(this.#agent.id) ?? this.#agent;
		const key = JSON.stringify([
			agent.displayName,
			agent.role,
			agent.charter,
			agent.appearance,
			this.#company.store.get().organization?.responsibilities,
		]);
		if (!wasEditing && key === this.#renderedKey) {
			this.#syncControls();
			return;
		}
		this.#renderedKey = key;
		let draft: AgentDraft = {
			displayName: agent.displayName,
			role: agent.role,
			charter: agent.charter,
			figure: figureFor(agent),
			color: colorFor(agent),
		};
		const stage = h("div", { class: "agent-edit-stage" }, figureElement(draft.figure, draft.color, { size: 100 }));
		const name = h("input", {
			class: "agent-inline-name",
			value: draft.displayName,
			required: true,
			maxlength: "64",
			autocomplete: "off",
			"aria-label": "Agent name",
		});
		const role = h("input", {
			class: "agent-inline-role",
			value: draft.role,
			required: true,
			maxlength: "160",
			"aria-label": "Agent title",
		});
		const description = h(
			"textarea",
			{
				class: "agent-inline-description",
				value: draft.charter,
				rows: 3,
				maxlength: "10000",
				"aria-label": "Agent description",
			},
			draft.charter,
		);
		const picker = new FigurePicker(draft, (choice) => {
			draft = { ...draft, ...choice };
			replace(stage, figureElement(draft.figure, draft.color, { size: 100 }));
		});
		const appearance = h(
			"details",
			{ class: "agent-appearance", hidden: true },
			h("summary", null, icon("edit"), "Change figure and color"),
			picker.el,
		);
		const fields = h(
			"fieldset",
			{ class: "agent-edit-fields" },
			h("div", { class: "agent-details-identity" }, stage, h("div", { class: "agent-inline-copy" }, name, role)),
			description,
			appearance,
		);
		const status = h("p", { class: "surface-status", role: "status" });
		const save = h("button", { type: "submit", class: "btn btn-primary", hidden: true }, "Save changes");
		const edit = button([icon("edit"), "Edit agent"], () => {
			if (!this.#company.store.get().team?.capabilities.write) return;
			this.#editing = true;
			this.#syncControls();
			name.focus();
		});
		const cancel = button("Cancel", () => {
			if (!this.#pending) this.#show();
		});
		const responsibilities =
			this.#company.store
				.get()
				.organization?.responsibilities.filter(
					(item) => item.accountableStaffAgentId === agent.id && item.status !== "retired",
				) ?? [];
		const base = `#/c/${this.#company.profile.profileId}`;
		const form = h(
			"form",
			{ class: "agent-edit-form" },
			fields,
			h(
				"section",
				{ class: "agent-responsibilities" },
				h(
					"header",
					null,
					h("h2", null, "Responsibilities"),
					h("a", { href: `${base}/organization`, onclick: () => this.dialog.close(false) }, "View map"),
				),
				h(
					"div",
					{ class: "responsibility-preview" },
					...responsibilities.map((item) => responsibilityCard(this.#company, item)),
					responsibilities.length ? null : h("p", { class: "empty" }, "No responsibilities assigned yet."),
				),
			),
			h(
				"label",
				{ class: "agent-notifications" },
				icon("bell"),
				h("span", null, "Notifications", h("small", null, "Notification preferences are not available yet.")),
				h("input", { type: "checkbox", role: "switch", "aria-label": "Agent notifications", disabled: true }),
			),
			status,
			h("div", { class: "agent-details-footer" }, edit, h("div", { class: "surface-actions" }, cancel, save)),
		);
		this.#syncControls = () => {
			const canWrite = this.#company.store.get().team?.capabilities.write === true;
			for (const field of [name, role, description]) field.readOnly = !this.#editing || !canWrite || this.#pending;
			fields.disabled = this.#pending || (this.#editing && !canWrite);
			appearance.hidden = !this.#editing;
			save.hidden = cancel.hidden = !this.#editing;
			edit.hidden = this.#editing;
			edit.disabled = !canWrite;
			save.disabled = this.#pending || !canWrite || !this.#actions.updateAgent;
			cancel.disabled = this.#pending;
			if (!this.#pending)
				status.textContent =
					this.#editing && !this.#actions.updateAgent
						? "Saving agent changes is not available yet. These edits stay in this panel."
						: "";
		};
		form.onsubmit = async (event) => {
			event.preventDefault();
			if (
				this.#pending ||
				!this.#editing ||
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
			this.#syncControls();
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
				if (!this.#lifetime.signal.aborted) {
					const message = status.textContent;
					this.#syncControls();
					if (this.#editing) status.textContent = message;
				}
			}
		};
		this.#syncControls();
		replace(this.dialog.content, form);
	}
}
