import { describeError } from "../../cloud/client.ts";
import type { GroupChatDetails, GroupChatDraft } from "../../cloud/group-details.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, icon, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import { matchesKey } from "../../ui/keys.ts";
import type { CompanyController } from "../company.ts";
import type { WorkspaceActions } from "../workspace-actions.ts";
import { type GroupEdits, groupEditsFor } from "./group-edits.ts";

type TextKey = "name" | "subtitle" | "purpose";
const LABELS: Record<TextKey, string> = {
	name: "Group title",
	subtitle: "Group subtitle",
	purpose: "Group description",
};

/** Group identity edits in place, with the same field behavior as agent details. */
export class GroupDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #roomId: unknown;
	readonly #actions: WorkspaceActions;
	readonly #scope: AbortSignal;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	readonly #fields = {} as Record<TextKey, HTMLInputElement | HTMLTextAreaElement>;
	readonly #status = h("p", { class: "agent-details-status", role: "status" });
	readonly #participants = h("section", { "aria-label": "Participants" });
	readonly #stage = h("span", { class: "group-details-stage" });
	#details: GroupChatDetails | undefined;
	#edits: GroupEdits | undefined;
	#unsubscribeEdits: (() => void) | undefined;
	#members: GroupChatDraft["members"] | undefined;
	#open: TextKey | undefined;
	#participantsKey = "";
	#figureKey = "";
	#statusKey = "";
	#built = false;
	#discarded = false;

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
		this.#scope = scope;
		this.#roomId = company.store.get().sessions.find((item) => item.sessionId === sessionId)?.executionScope?.roomId;
		this.dialog = new SurfaceDialog(
			"Group details",
			"agent-details group-details",
			() => {
				if (!this.#discarded && this.#open) this.#commit(this.#open);
				this.#lifetime.abort();
				this.#unsubscribe();
				this.#unsubscribeEdits?.();
				onClose();
			},
			anchor,
		);
		this.dialog.el.dataset.page = "details";
		this.#unsubscribe = company.store.subscribe(() => {
			if (!this.#available()) this.dispose();
			else {
				const latest = typeof this.#roomId === "string" ? company.store.get().groups?.[this.#roomId] : undefined;
				if (latest && this.#details && latest.version >= this.#details.version) {
					this.#details = latest;
					this.#edits?.reconcile(latest);
				}
				this.#sync();
			}
		});
		for (const signal of [company.signal, scope])
			signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.dialog.open();
		if (scope.aborted || !this.#available()) this.dispose();
		else void this.#load();
	}

	dispose(): void {
		this.#discarded = true;
		this.#edits?.dispose();
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

	async #load(): Promise<void> {
		replace(this.dialog.content, spinner("Loading group details…"));
		try {
			const details = await this.#company.groupDetails(this.#sessionId, this.#lifetime.signal);
			if (!this.#available()) return;
			this.#details = details;
			this.#edits = groupEditsFor(this.#company, details, this.#actions, this.#scope);
			this.#unsubscribeEdits = this.#edits.store.subscribe(() => this.#sync());
			this.#build();
			this.#sync();
		} catch (error) {
			if (this.#available())
				replace(
					this.dialog.content,
					notice("danger", describeError(error)),
					button("Retry", () => void this.#load()),
				);
		}
	}

	#build(): void {
		replace(
			this.dialog.content,
			h(
				"header",
				{ class: "agent-details-identity group-details-identity" },
				this.#stage,
				h("div", { class: "agent-details-names" }, this.#field("name"), this.#field("subtitle")),
			),
			this.#field("purpose"),
			this.#status,
			this.#participants,
		);
		this.#built = true;
	}

	#field(key: TextKey): HTMLElement {
		const multiline = key === "purpose";
		const events = {
			name: key,
			"aria-label": LABELS[key],
			maxlength: multiline ? 32768 : 256,
			oninput: () => this.#show(key, control.value),
			onfocus: () => {
				this.#open = key;
			},
			onblur: () => this.#commit(key),
			onkeydown: (event: KeyboardEvent) => {
				if (matchesKey(event, "dismiss")) {
					event.preventDefault();
					event.stopPropagation();
					this.#show(key, this.#value(key));
					control.blur();
					this.dialog.el.focus({ preventScroll: true });
				} else if (matchesKey(event, "accept") && (!multiline || event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					control.blur();
					this.dialog.el.focus({ preventScroll: true });
				}
			},
		};
		const control = multiline
			? h("textarea", { rows: 5, ...events })
			: h("input", { type: "text", size: 1, autocomplete: "off", ...events });
		this.#fields[key] = control;
		return h(
			"label",
			{ class: `agent-inline-field agent-inline-${multiline ? "description" : key === "name" ? "name" : "title"}` },
			h("span", { class: "agent-inline-size" }, control),
			icon("edit"),
		);
	}

	#value(key: TextKey): string {
		return this.#edits?.current()[key] ?? (key === "subtitle" ? "Group chat" : "");
	}

	#show(key: TextKey, value: string): void {
		const control = this.#fields[key];
		if (control.value !== value) control.value = value;
		control.parentElement!.dataset.value = value;
	}

	#commit(key: TextKey): void {
		if (this.#open === key) this.#open = undefined;
		if (this.#lifetime.signal.aborted || !this.#edits) return;
		const value = this.#fields[key].value.trim();
		if (!this.#edits.canWrite() || value === this.#value(key)) {
			this.#show(key, this.#value(key));
			return;
		}
		if (!value && key !== "subtitle") {
			this.#show(key, this.#value(key));
			this.#statusKey = "";
			replace(this.#status, `${LABELS[key]} cannot be empty.`);
			return;
		}
		this.#show(key, value);
		this.#edits.change({ [key]: value });
	}

	#sync(): void {
		if (!this.#built || this.#lifetime.signal.aborted || !this.#edits) return;
		const canEdit = this.#edits.canWrite();
		if (!canEdit) {
			this.#members = undefined;
			this.#open = undefined;
		}
		for (const key of Object.keys(this.#fields) as TextKey[]) {
			const control = this.#fields[key];
			control.readOnly = !canEdit;
			control.closest(".agent-inline-field")?.classList.toggle("is-editable", canEdit);
			if (key !== this.#open) this.#show(key, this.#value(key));
		}
		const { status, failed } = this.#edits.store.get();
		const canRecover = this.#edits.canRecover();
		const statusKey = JSON.stringify([status, failed, canRecover]);
		if (statusKey !== this.#statusKey) {
			this.#statusKey = statusKey;
			replace(
				this.#status,
				status,
				failed && canRecover ? button("Try again", () => void this.#edits?.save(), { small: true }) : null,
				failed && canRecover
					? button("Discard changes", () => void this.#edits?.discardChanges(), { small: true })
					: null,
			);
		}
		const agents = this.#company.groupAgents(this.#sessionId);
		const figureKey = JSON.stringify(agents);
		if (figureKey !== this.#figureKey) {
			this.#figureKey = figureKey;
			replace(this.#stage, groupChatAvatar(agents, { width: 120, height: 110 }));
		}
		const state = this.#company.store.get();
		const key = JSON.stringify([
			this.#edits.current().members,
			state.staff,
			state.team?.members,
			canEdit,
			this.#details?.status,
		]);
		if (!this.#members && key !== this.#participantsKey) {
			this.#participantsKey = key;
			this.#renderParticipants();
		}
	}

	#renderParticipants(): void {
		const state = this.#company.store.get();
		const members = this.#edits!.current().members;
		const participants = members.map((participant) => {
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
			this.#participants,
			h(
				"div",
				{ class: "group-participants-heading" },
				h("h3", null, `Participants (${members.length})`),
				this.#edits!.canWrite()
					? button(
							"Edit participants",
							() => {
								this.#members = this.#edits!.current().members.map((member) => ({ ...member }));
								replace(this.#participants, this.#memberEditor());
								this.#participants.querySelector<HTMLInputElement>("input")?.focus();
							},
							{ small: true },
						)
					: null,
			),
			participants.length
				? h("ul", { class: "group-details-participants" }, participants)
				: h("p", null, "No participants to display."),
			!this.#edits!.canWrite()
				? h(
						"p",
						{ class: "muted" },
						this.#details?.status === "archived"
							? "Archived groups cannot be edited."
							: "Only an owner or admin can edit group details.",
					)
				: null,
		);
	}

	#memberEditor(): HTMLElement {
		let members = this.#members!;
		const state = this.#company.store.get();
		const known = [
			...state.staff
				.filter((agent) => agent.employmentStatus === "active")
				.map((agent) => ({ kind: "staff_agent" as const, id: agent.id })),
			...(state.team?.members ?? []).map((member) => ({ kind: "member" as const, id: member.userId })),
		];
		const candidates = [
			...known,
			...members.filter((member) => !known.some((item) => item.kind === member.kind && item.id === member.id)),
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
					checked: members.some((item) => item.kind === member.kind && item.id === member.id),
					onchange: (e: Event) => {
						members = members.filter((item) => item.kind !== member.kind || item.id !== member.id);
						if ((e.target as HTMLInputElement).checked) members.push(member);
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

		return h(
			"form",
			{
				class: "group-edit-form",
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					if (!this.#edits?.canWrite()) return;
					if (members.filter((member) => member.kind === "staff_agent").length < 2) {
						this.#statusKey = "";
						replace(this.#status, "Choose at least two agents.");
						return;
					}
					this.#members = undefined;
					this.#edits.change({ members });
					this.#renderParticipants();
				},
			},
			h(
				"fieldset",
				{ class: "group-edit-fields" },
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
						this.#members = undefined;
						this.#renderParticipants();
					}),
					h("button", { type: "submit", class: "btn btn-primary" }, "Save participants"),
				),
			),
		);
	}
}
