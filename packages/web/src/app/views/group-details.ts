import { describeError } from "../../cloud/client.ts";
import type { GroupChatDetails } from "../../cloud/group-details.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, notice, personAvatar, replace, spinner } from "../../ui/dom.ts";
import { groupChatAvatar, isGroupChat } from "../../ui/group-chat.ts";
import type { CompanyController } from "../company.ts";

/** A read-only view of the group's canonical participants, refreshed on open. */
export class GroupDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #roomId: unknown;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#details: GroupChatDetails | undefined;
	#error: string | undefined;

	constructor(
		company: CompanyController,
		sessionId: string,
		onClose: () => void,
		anchor: HTMLElement,
		scope: AbortSignal,
	) {
		this.#company = company;
		this.#sessionId = sessionId;
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
			else this.#render();
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

	#render(): void {
		const details = this.#details;
		const state = this.#company.store.get();
		const title =
			details?.name ?? state.sessions.find((item) => item.sessionId === this.#sessionId)?.title ?? "Group chat";
		const hero = h(
			"header",
			{ class: "group-details-identity" },
			groupChatAvatar(),
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
				this.#error
					? h(
							"div",
							null,
							notice("danger", this.#error),
							button("Retry", () => void this.#load()),
						)
					: h("div", { class: "group-details-loading" }, spinner("Loading group details…")),
			);
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
			details.purpose.trim() ? h("p", { class: "group-details-purpose" }, details.purpose) : null,
			h(
				"section",
				{ "aria-label": "Participants" },
				h("h3", null, `Participants (${details.members.length})`),
				participants.length
					? h("ul", { class: "group-details-participants" }, participants)
					: h("p", null, "No participants to display."),
			),
		);
	}
}
