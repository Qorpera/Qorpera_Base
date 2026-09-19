import { describeError } from "../../cloud/client.ts";
import type { GroupChatDetails, GroupChatDraft } from "../../cloud/group-details.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import type { CompanyController } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";

/** Canonical group identity and a governed, explicitly saved editing form. */
export class GroupDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #roomId: unknown;
	readonly #actions: WorkspaceActions;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#attempt = new AbortController();
	#details: GroupChatDetails | undefined;
	#draft: GroupChatDraft | undefined;
	#error: string | undefined;
	#saving = false;
	#saved = false;
	#fields: HTMLFieldSetElement | undefined;
	#saveStatus: HTMLElement | undefined;

	constructor(
		company: CompanyController,
		sessionId: string,
		onClose: () => void,
		anchor: HTMLElement,
		scope: AbortSignal,
		actions: WorkspaceActions = {},
	) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#actions = actions;
		this.#roomId = company.store.get().sessions.find((item) => item.sessionId === sessionId)?.executionScope?.roomId;
		this.dialog = new SurfaceDialog(
			"Group details",
			"agent-details group-details",
			() => {
				this.#lifetime.abort();
				this.#unsubscribe();
				onClose();
			},
			anchor,
		);
		this.dialog.el.dataset.page = "details";
		this.#unsubscribe = company.store.subscribe(() => {
			if (!this.#available()) this.dispose();
			else if (this.#draft) {
				// Company refreshes must not replace focused fields or drafts.
				if (!this.#canEdit()) {
					this.#attempt.abort();
					this.#draft = undefined;
					this.#render();
				}
			} else {
				const latest = typeof this.#roomId === "string" ? company.store.get().groups?.[this.#roomId] : undefined;
				if (this.#details && latest && latest.version > this.#details.version) this.#details = latest;
				this.#render();
			}
		});
		for (const signal of [company.signal, scope])
			signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#render();
		this.dialog.open();
		if (scope.aborted || !this.#available()) this.dispose();
		else void this.#load();
	}

	dispose(): void {
		this.dialog.close(false);
	}

	#available(): boolean {
		const state = this.#company.store.get();
		const session = state.sessions.find((item) => item.sessionId === this.#sessionId);
		return (
			!this.#lifetime.signal.aborted &&
			!this.#company.signal.aborted &&
			!state.accessLost &&
			Boolean(state.team?.capabilities.read) &&
			state.team?.profileId === this.#company.profile.profileId &&
			isGroupChat(session) &&
			session?.executionScope?.roomId === this.#roomId &&
			session?.profileId === this.#company.profile.profileId &&
			session?.environmentId === this.#company.profile.environmentId
		);
	}

	#canEdit(): boolean {
		const team = this.#company.store.get().team;
		return (
			this.#available() &&
			this.#details?.status === "active" &&
			Boolean(this.#actions.updateGroup) &&
			Boolean(team?.capabilities.authorize && team.capabilities.write && ["owner", "admin"].includes(team.role))
		);
	}

	async #load(): Promise<void> {
		this.#error = undefined;
		this.#render();
		try {
			const details = await this.#company.groupDetails(this.#sessionId, this.#lifetime.signal);
			if (!this.#available()) return;
			this.#details = details;
		} catch (error) {
			if (!this.#available()) return;
			this.#error = describeError(error);
		}
		this.#render();
	}

	#edit(): void {
		if (!this.#canEdit() || !this.#details) return;
		this.#saved = false;
		this.#draft = {
			name: this.#details.name,
			purpose: this.#details.purpose,
			members: this.#details.members.map((m) => ({ ...m })),
		};
		this.#render();
		this.dialog.content.querySelector<HTMLInputElement>("input[name=name]")?.focus();
	}

	async #save(): Promise<void> {
		if (this.#saving || !this.#draft || !this.#details || !this.#canEdit() || !this.#actions.updateGroup) return;
		this.#saving = true;
		this.#attempt = new AbortController();
		const signal = AbortSignal.any([this.#lifetime.signal, this.#attempt.signal]);
		if (this.#fields) this.#fields.disabled = true;
		replace(this.#saveStatus!, spinner("Saving…"));
		try {
			await this.#actions.updateGroup(this.#sessionId, this.#details, this.#draft, signal);
			signal.throwIfAborted();
			this.#draft = undefined;
			this.#details = undefined;
			this.#saved = true;
			await this.#company.refreshSessions();
			signal.throwIfAborted();
			await this.#load();
		} catch (error) {
			if (!signal.aborted && this.#available() && this.#saveStatus)
				replace(this.#saveStatus, notice("danger", describeError(error)));
		} finally {
			this.#saving = false;
			if (this.#fields) this.#fields.disabled = !this.#canEdit();
		}
	}

	#editor(): HTMLElement {
		const draft = this.#draft!;
		const state = this.#company.store.get();
		const name = h("input", {
			name: "name",
			value: draft.name,
			required: true,
			maxlength: 256,
			oninput: (e: Event) => {
				draft.name = (e.target as HTMLInputElement).value;
			},
		});
		const purpose = h(
			"textarea",
			{
				name: "purpose",
				rows: 3,
				required: true,
				maxlength: 32768,
				oninput: (e: Event) => {
					draft.purpose = (e.target as HTMLTextAreaElement).value;
				},
			},
			draft.purpose,
		);
		const known = [
			...state.staff
				.filter((agent) => agent.employmentStatus === "active")
				.map((agent) => ({ kind: "staff_agent" as const, id: agent.id })),
			...(state.team?.members ?? []).map((member) => ({ kind: "member" as const, id: member.userId })),
		];
		const candidates = [
			...known,
			...draft.members.filter((member) => !known.some((item) => item.kind === member.kind && item.id === member.id)),
		];
		const choices = candidates.map((member) => {
			const agent = member.kind === "staff_agent" ? this.#company.staffById(member.id) : undefined;
			const person =
				member.kind === "member" ? state.team?.members.find((item) => item.userId === member.id) : undefined;
			const label = agent?.displayName ?? person?.displayName ?? "Unavailable participant";
			return h(
				"label",
				{ class: "group-member-choice" },
				h("input", {
					type: "checkbox",
					checked: draft.members.some((item) => item.kind === member.kind && item.id === member.id),
					onchange: (e: Event) => {
						draft.members = draft.members.filter((item) => item.kind !== member.kind || item.id !== member.id);
						if ((e.target as HTMLInputElement).checked) draft.members.push(member);
					},
				}),
				agent ? agentFigure(agent, label, { size: 32 }) : personAvatar(label, member.id),
				h(
					"span",
					null,
					h("strong", null, label),
					h(
						"small",
						null,
						agent?.role ?? (member.kind === "staff_agent" ? "Unavailable agent — remove to save" : "Member"),
					),
				),
			);
		});
		this.#saveStatus = h("div", { class: "group-save-status" });
		this.#fields = h(
			"fieldset",
			{ class: "group-edit-fields" },
			h("label", null, "Group name", name),
			h("label", null, "Description", purpose),
			h(
				"fieldset",
				{ class: "group-member-options" },
				h("legend", null, "Participants"),
				h("p", null, "Choose at least two agents."),
				choices,
			),
			h(
				"div",
				{ class: "surface-actions" },
				button("Cancel", () => {
					this.#draft = undefined;
					this.#render();
				}),
				h("button", { type: "submit", class: "btn btn-primary" }, "Save changes"),
			),
		);
		return h(
			"form",
			{
				class: "group-edit-form",
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					void this.#save();
				},
			},
			this.#fields,
			this.#saveStatus,
		);
	}

	#render(): void {
		const details = this.#details;
		const state = this.#company.store.get();
		const title =
			details?.name ?? state.sessions.find((item) => item.sessionId === this.#sessionId)?.title ?? "Group chat";
		const hero = h(
			"header",
			{ class: "group-details-identity" },
			groupChatAvatar(this.#company.groupAgents(this.#sessionId), { width: 96, height: 88 }),
			h(
				"div",
				null,
				h("h2", null, title),
				h("p", null, details?.status === "archived" ? "Archived group chat" : "Group chat"),
			),
		);
		if (!details) {
			replace(
				this.dialog.content,
				hero,
				this.#saved ? notice("ok", "Changes saved. Refreshing details…") : null,
				this.#error
					? h(
							"div",
							null,
							notice("danger", this.#error),
							button("Retry", () => void this.#load()),
						)
					: spinner("Loading group details…"),
			);
			return;
		}
		if (this.#draft) {
			replace(this.dialog.content, hero, this.#editor());
			return;
		}
		const participants = details.members.map((participant) => {
			const agent = participant.kind === "staff_agent" ? this.#company.staffById(participant.id) : undefined;
			const member =
				participant.kind === "member"
					? state.team?.members.find((item) => item.userId === participant.id)
					: undefined;
			const name =
				agent?.displayName ??
				member?.displayName ??
				(participant.kind === "staff_agent" ? "Unavailable agent" : "Unavailable member");
			return h(
				"li",
				null,
				agent ? agentFigure(agent, name, { size: 40 }) : personAvatar(name, participant.id),
				h(
					"div",
					null,
					h(
						"strong",
						null,
						name,
						participant.kind === "member" && participant.id === this.#company.userId ? " (You)" : "",
					),
					h("span", null, agent?.role ?? (participant.kind === "staff_agent" ? "Agent" : "Member")),
				),
			);
		});
		replace(
			this.dialog.content,
			hero,
			this.#saved ? notice("ok", "Changes saved.") : null,
			details.purpose.trim() ? h("p", { class: "group-details-purpose" }, details.purpose) : null,
			h(
				"section",
				{ "aria-label": "Participants" },
				h("h3", null, `Participants (${details.members.length})`),
				participants.length
					? h("ul", { class: "group-details-participants" }, participants)
					: h("p", null, "No participants to display."),
			),
			this.#canEdit()
				? h(
						"div",
						{ class: "surface-actions" },
						button("Edit group", () => this.#edit()),
					)
				: h(
						"p",
						{ class: "muted" },
						details.status === "archived"
							? "Archived groups cannot be edited."
							: "Only an owner or admin can edit group details.",
					),
		);
	}
}
