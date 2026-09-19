import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure, figureElement, nativeColorOf } from "../../ui/avatar.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { FigurePicker } from "../../ui/figure-picker.ts";
import { matchesKey } from "../../ui/keys.ts";
import type { CompanyController } from "../company.ts";
import { navigate } from "../router.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";

/* A "To:" field with one short list under it. The list starts a new agent,
 * gathers recipients for the first message of a conversation. Focus
 * stays in the field and the arrow keys move through the list (the ARIA
 * combobox pattern), so refreshes never take the caret away. */
interface Choice {
	/** "create", "group", or an agent id. */
	key: string;
	label: string;
	lead: HTMLElement;
	disabled: boolean;
	/** Shown on the highlighted row, or always when it is a status. */
	hint?: { text: string; status: boolean };
	/** Membership of a group chat being put together. */
	member?: boolean;
	run: () => void;
}

let instances = 0;

function mark(name: string): HTMLElement {
	return h("span", { class: "recipient-mark", "aria-hidden": "true" }, icon(name));
}

export class NewConversationView {
	readonly el = h("section", { class: "new-conversation" });
	readonly #company: CompanyController;
	readonly #actions: WorkspaceActions;
	readonly #close: () => void;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	readonly #id = `new-conversation-${++instances}`;
	readonly #chips = h("span", {
		class: "recipient-chips",
		role: "group",
		"aria-label": "Selected recipients",
		hidden: true,
	});
	readonly #list = h("div", {
		id: `${this.#id}-list`,
		class: "recipient-list",
		role: "listbox",
		"aria-label": "Agents",
	});
	readonly #empty = h("p", { class: "recipient-empty", hidden: true });
	readonly #menu = h(
		"div",
		{
			class: "recipient-menu",
			hidden: true,
			// Keep focus in the field while the pointer picks a row.
			onmousedown: (event: MouseEvent) => event.preventDefault(),
		},
		this.#list,
		this.#empty,
	);
	readonly #search: HTMLInputElement;
	readonly #field: HTMLDivElement;
	readonly #selected = new Set<string>();
	readonly #navigation: HTMLButtonElement;
	readonly #message = h("textarea", {
		class: "composer-input",
		rows: 1,
		placeholder: "Message…",
		"aria-label": "Message",
		oninput: () => {
			this.#message.style.height = "auto";
			this.#message.style.height = `${Math.min(this.#message.scrollHeight, 112)}px`;
			this.#syncComposer();
		},
		onkeydown: (event: KeyboardEvent) => {
			if (matchesKey(event, "accept") && !event.shiftKey) {
				event.preventDefault();
				void this.#submit();
			}
		},
	});
	readonly #send = h(
		"button",
		{
			type: "button",
			class: "composer-send",
			"aria-label": "Send message",
			onclick: () => void this.#submit(),
		},
		icon("send"),
	);
	readonly #status = h("p", { class: "attachment-status", role: "status" });
	readonly #composer = h(
		"footer",
		{ class: "composer new-conversation-composer" },
		h("div", { class: "composer-shell" }, this.#message, this.#send),
		this.#status,
	);
	#sending = false;
	#choices: Choice[] = [];
	#signature = "";
	#query = "";
	#group = false;
	#listOpen = false;
	#active: string | undefined;
	#prefilled: string | undefined;
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
		this.#search = h("input", {
			id: `${this.#id}-to`,
			type: "text",
			role: "combobox",
			placeholder: "Search or create agents",
			"aria-label": "Search conversation recipients",
			"aria-autocomplete": "list",
			"aria-controls": this.#list.id,
			"aria-expanded": "false",
			autocomplete: "off",
			spellcheck: "false",
			enterkeyhint: "go",
			oninput: () => {
				this.#query = this.#search.value;
				this.#active = undefined;
				this.#listOpen = true;
				this.#render();
			},
			onkeydown: (event: KeyboardEvent) => this.#key(event),
			onfocus: () => this.#setListOpen(true),
			onclick: () => this.#setListOpen(true),
		});
		this.#field = h(
			"div",
			{ class: "recipient-field" },
			h("label", { class: "recipient-to", for: this.#search.id }, "To:"),
			h("div", { class: "recipient-entry" }, this.#chips, this.#search, this.#menu),
		);
		// A press anywhere else closes the list. Blur alone cannot: a tap on a
		// row may blur the field before the row's click arrives.
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (!(event.target instanceof Node) || !this.#field.contains(event.target)) this.#setListOpen(false);
			},
			{ signal: this.#lifetime.signal },
		);
		this.#search.addEventListener("focusout", (event) => {
			if (event.relatedTarget instanceof Node && !this.#field.contains(event.relatedTarget))
				this.#setListOpen(false);
		});
		this.#unsubscribe = company.store.subscribe(() => {
			if (!this.#editing) this.#render();
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
		(this.#editing ? this.el.querySelector<HTMLInputElement>("input") : this.#search)?.focus();
	}
	setNavigationOpen(open: boolean): void {
		this.#navigation.setAttribute("aria-expanded", String(open));
	}
	#picker(): void {
		this.#editing = false;
		replace(
			this.el,
			h(
				"header",
				{ class: "new-conversation-header" },
				this.#navigation,
				this.#field,
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close new conversation", onclick: this.#close },
					icon("close"),
				),
			),
			h("div", { class: "new-conversation-space" }),
			this.#composer,
		);
		this.#signature = "";
		this.#render();
	}
	#setListOpen(open: boolean): void {
		if (this.#editing || this.#listOpen === open) return;
		this.#listOpen = open;
		this.#render();
	}
	#render(): void {
		if (this.#editing) return;
		const state = this.#company.store.get();
		const active = state.staff.filter((agent) => agent.employmentStatus === "active");
		for (const id of this.#selected) if (!active.some((agent) => agent.id === id)) this.#selected.delete(id);
		const canCreate = state.team?.capabilities.authorize === true;
		const query = this.#query.trim();
		// The rows show names only, so the search matches names only.
		const agents = active.filter((agent) => agent.displayName.toLowerCase().includes(query.toLowerCase()));
		// Activity refreshes arrive often; rebuild rows only when what they show changed.
		const signature = JSON.stringify([
			this.#group,
			query,
			canCreate,
			[...this.#selected],
			agents.map((agent) => [agent.id, agent.displayName, agent.templateId, agent.appearance]),
		]);
		if (signature !== this.#signature) {
			this.#signature = signature;
			// Chips keep the order the agents were added in, as a "To:" line does.
			const members = [...this.#selected].flatMap((id) => active.filter((agent) => agent.id === id));
			this.#build(agents, members, canCreate, query);
		}
		this.#menu.hidden = !this.#listOpen;
		this.#search.setAttribute("aria-expanded", String(this.#listOpen));
		if (!this.#choices.some((choice) => choice.key === this.#active))
			this.#active = query ? (agents[0]?.id ?? (canCreate && !this.#group ? "create" : undefined)) : undefined;
		this.#highlight(false);
		this.#syncComposer();
	}
	#build(agents: HostedStaffAgent[], members: HostedStaffAgent[], canCreate: boolean, query: string): void {
		const choices: Choice[] = [
			{
				key: "create",
				label: query ? `New agent “${query}”` : "New agent",
				lead: mark("plus"),
				disabled: !canCreate,
				run: () => this.#configure(),
			},
		];
		if (!this.#group)
			choices.push({
				key: "group",
				label: "New group chat",
				lead: mark("friends"),
				disabled: false,
				run: () => this.#setGroup(true),
			});
		for (const agent of agents)
			choices.push({
				key: agent.id,
				label: agent.displayName,
				lead: agentFigure(agent, agent.displayName, { size: 28 }),
				disabled: false,
				member: this.#selected.has(agent.id),
				run: () => this.#toggle(agent.id),
			});
		this.#choices = choices;
		this.#search.placeholder = this.#selected.size || this.#group ? "Add agents" : "Search or create agents";
		this.#list.setAttribute("aria-multiselectable", "true");
		replace(
			this.#list,
			...choices.map((choice) =>
				h(
					"div",
					{
						id: `${this.#id}-${choice.key}`,
						class: "recipient-option",
						role: "option",
						"data-choice": choice.key,
						"aria-disabled": choice.disabled ? "true" : undefined,
						"aria-selected": choice.member === undefined ? undefined : String(choice.member),
						onclick: (event: MouseEvent) => {
							// Rows rebuild on a pick, so a double-click's second click
							// would land on whatever row moved under the pointer.
							if (!this.#sending && !choice.disabled && event.detail < 2) choice.run();
						},
						onmousemove: () => {
							if (this.#active !== choice.key) {
								this.#active = choice.key;
								this.#highlight(false);
							}
						},
					},
					choice.lead,
					h("span", { class: "recipient-option-label" }, choice.label),
					choice.hint
						? h(
								"span",
								{
									class: choice.hint.status ? "recipient-option-hint status" : "recipient-option-hint",
									"aria-hidden": choice.hint.status ? undefined : "true",
								},
								choice.hint.text,
							)
						: null,
					choice.member === undefined
						? null
						: h(
								"span",
								{ class: "recipient-check", "aria-hidden": "true" },
								choice.member ? icon("check") : null,
							),
				),
			),
		);
		this.#empty.hidden = agents.length > 0;
		this.#empty.textContent = query ? "No agents match." : "No agents yet.";
		const chipFocus = document.activeElement?.getAttribute("data-remove-recipient");
		replace(
			this.#chips,
			...members.map((agent) =>
				h(
					"button",
					{
						type: "button",
						class: "recipient-chip",
						"aria-label": `Remove ${agent.displayName}`,
						"data-remove-recipient": agent.id,
						onmousedown: (event: MouseEvent) => event.preventDefault(),
						onclick: (event: MouseEvent) => {
							// The next chip slides under the pointer; one double-click removes one.
							if (this.#sending || event.detail > 1) return;
							this.#selected.delete(agent.id);
							this.#render();
							this.#search.focus();
						},
					},
					agentFigure(agent, agent.displayName, { size: 20 }),
					h("span", { class: "recipient-chip-name" }, agent.displayName),
					icon("close"),
				),
			),
		);
		this.#chips.hidden = !members.length;
		if (chipFocus) {
			const chip = [...this.#chips.querySelectorAll<HTMLButtonElement>("button")].find(
				(item) => item.dataset.removeRecipient === chipFocus,
			);
			(chip ?? this.#search).focus({ preventScroll: true });
		}
	}
	#highlight(reveal: boolean): void {
		let current: HTMLElement | undefined;
		for (const row of this.#list.querySelectorAll<HTMLElement>("[role=option]")) {
			const on = row.dataset.choice === this.#active;
			row.classList.toggle("active", on);

			if (on) current = row;
		}
		if (current && this.#listOpen) {
			this.#search.setAttribute("aria-activedescendant", current.id);
			if (reveal) current.scrollIntoView?.({ block: "nearest" });
		} else this.#search.removeAttribute("aria-activedescendant");
	}
	#key(event: KeyboardEvent): void {
		if (event.isComposing || this.#sending) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			this.#setListOpen(true);
			const count = this.#choices.length;
			if (!count) return;
			const index = this.#choices.findIndex((choice) => choice.key === this.#active);
			const step = event.key === "ArrowDown" ? 1 : -1;
			const next = index < 0 ? (step > 0 ? 0 : count - 1) : (index + step + count) % count;
			this.#active = this.#choices[next]!.key;
			this.#highlight(true);
		} else if (event.key === "Enter") {
			if (!this.#listOpen) return;
			event.preventDefault();
			const choice = this.#choices.find((item) => item.key === this.#active);
			if (choice && !choice.disabled) choice.run();
		} else if (event.key === "Escape") {
			// First the list closes, then a group chat in progress is put away.
			if (this.#listOpen) {
				event.preventDefault();
				this.#setListOpen(false);
			} else if (this.#group) {
				event.preventDefault();
				this.#setGroup(false);
			}
		} else if (event.key === "Backspace" && !this.#search.value) {
			const last = [...this.#selected].at(-1);
			if (last) {
				event.preventDefault();
				this.#selected.delete(last);
				this.#render();
			}
		}
	}
	#setGroup(group: boolean): void {
		this.#group = group;
		this.#query = "";
		this.#search.value = "";
		this.#active = undefined;
		this.#render();
	}
	#toggle(id: string): void {
		if (this.#selected.has(id)) this.#selected.delete(id);
		else this.#selected.add(id);
		if (this.#query) {
			this.#query = "";
			this.#search.value = "";
		}
		this.#active = id;
		this.#render();
	}
	#syncComposer(): void {
		const canWrite = this.#company.store.get().team?.capabilities.write === true;
		this.#message.disabled = this.#sending || !canWrite;
		this.#field.inert = this.#sending;
		this.#send.disabled =
			this.#sending ||
			!canWrite ||
			!this.#actions.startConversation ||
			this.#selected.size < (this.#group ? 2 : 1) ||
			!this.#message.value.trim();
	}
	async #submit(): Promise<void> {
		this.#render();
		if (this.#send.disabled || !this.#actions.startConversation) return;
		this.#sending = true;
		this.#setListOpen(false);
		this.#syncComposer();
		this.#status.textContent = "Starting conversation…";
		try {
			const sessionId = await this.#actions.startConversation(
				[...this.#selected],
				this.#message.value,
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted || this.#company.signal.aborted) return;
			navigate({ name: "company", profileId: this.#company.profile.profileId, section: "chat", id: sessionId });
		} catch (error) {
			if (!this.#lifetime.signal.aborted)
				this.#status.textContent =
					error instanceof Error
						? error.message
						: "The conversation could not be started. Your draft is still here.";
		} finally {
			this.#sending = false;
			if (!this.#lifetime.signal.aborted) this.#syncComposer();
		}
	}
	#configure(): void {
		if (!this.#company.store.get().team?.capabilities.authorize) return;
		// "Search or create": what was typed names the agent, unless the draft
		// already carries a name of the member's own.
		const typed = this.#query.trim().slice(0, 64);
		if (typed && (!this.#draft.displayName || this.#draft.displayName === this.#prefilled)) {
			this.#draft.displayName = typed;
			this.#prefilled = typed;
		}
		this.#listOpen = false;
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
			{ class: "new-agent-fields" },
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
		let createdId: string | undefined;
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
			h(
				"div",
				{ class: "surface-actions" },
				button("Cancel", () => back.click()),
				create,
			),
		);
		this.#syncControls = () => {
			const canWrite = this.#company.store.get().team?.capabilities.authorize === true;
			fields.disabled = this.#pending || !canWrite || !!createdId;
			create.disabled = this.#pending || !canWrite || !this.#actions.createAgent;
			back.disabled = this.#pending;
		};
		form.onsubmit = async (event) => {
			event.preventDefault();
			if (
				this.#pending ||
				!this.#actions.createAgent ||
				!this.#company.store.get().team?.capabilities.authorize ||
				(!createdId && !form.reportValidity())
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
				createdId ??= await this.#actions.createAgent(
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
				if (!this.#lifetime.signal.aborted && !this.#company.signal.aborted) {
					if (!this.#company.staffById(createdId)) throw new Error("Agent roster is still refreshing.");
					this.#selected.add(createdId);
					this.#query = "";
					this.#search.value = "";
					this.#draft = {
						displayName: "",
						role: "",
						charter: "",
						figure: "rocket",
						color: nativeColorOf("rocket"),
					};
					this.#prefilled = undefined;
					this.#picker();
					this.#message.focus();
				}
			} catch {
				if (!this.#lifetime.signal.aborted) {
					status.textContent = createdId
						? "The agent was created. Retry adding it once the agent list is available."
						: "The agent could not be created. Your draft is still here.";
					if (createdId) create.textContent = "Add created agent";
				}
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
