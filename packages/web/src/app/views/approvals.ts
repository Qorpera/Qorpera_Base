import type { TranscriptCard } from "../../cloud/transcript.ts";
import { projectTranscript } from "../../cloud/transcript.ts";
import type { HostedSession, JsonValue } from "../../cloud/types.ts";
import { authorizationRequestId, renderAuthorizationCard } from "../../ui/authorization-card.ts";
import { button, fmtTime, h, notice, replace } from "../../ui/dom.ts";
import { cardsSkeleton } from "../../ui/skeleton.ts";
import type { CompanyController } from "../company.ts";

/* Approvals inbox (runtime contract §16.2): gated decisions wait durably in
 * the control plane. Today the canonical events are `authorization_request`
 * and `authorization_decision` on session transcripts; the inbox gathers them
 * across the company's conversations. Recording a decision from the web needs
 * the append RPC to enter the client contract — requested 2026-09-02 — so the
 * inbox is read-only until then. Typed interaction cards arrive with Order 2. */

interface InboxEntry {
	session: HostedSession;
	card: TranscriptCard;
	decided: boolean;
	resolution?: JsonValue;
}

export class ApprovalsView {
	readonly el = h("section", { class: "page approvals" });
	readonly #company: CompanyController;
	#scanning = false;
	readonly #scanned = new Map<string, string>();
	readonly #errors = new Map<string, string>();
	readonly #unsubscribe: (() => void)[];
	#disposed = false;
	#scanAgain = false;
	#hintVersion = 0;

	constructor(company: CompanyController) {
		this.#company = company;
		this.#unsubscribe = [
			company.store.subscribe(() => {
				this.update();
				void this.#scan();
			}),
			company.onInvalidate((resource) => {
				if (resource === "sessions") {
					this.#hintVersion++;
					void this.#scan();
				}
			}),
		];
		void this.#scan();
		this.update();
	}

	dispose(): void {
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
	}

	async #scan(): Promise<void> {
		if (this.#disposed || this.#company.store.get().loading) return;
		if (this.#scanning) {
			this.#scanAgain = true;
			return;
		}
		this.#scanning = true;
		this.update();
		try {
			do {
				this.#scanAgain = false;
				const hintVersion = this.#hintVersion;
				const sessions = [...this.#company.store.get().sessions].sort((a, b) =>
					b.updatedAt.localeCompare(a.updatedAt),
				);
				for (const session of sessions) {
					if (this.#disposed) return;
					const signature = `${session.updatedAt}:${hintVersion}`;
					if (this.#scanned.get(session.sessionId) === signature) continue;
					const conversation = this.#company.conversation(session.sessionId, false);
					await this.#company.loadConversation(session.sessionId);
					if (this.#disposed) return;
					this.#scanned.set(session.sessionId, signature);
					const state = conversation.get();
					if (state.error || !state.complete)
						this.#errors.set(session.sessionId, state.error ?? "Conversation could not be read");
					else this.#errors.delete(session.sessionId);
					this.update();
				}
			} while (this.#scanAgain && !this.#disposed);
		} finally {
			this.#scanning = false;
			this.update();
		}
	}

	#entries(): { pending: InboxEntry[]; decided: InboxEntry[] } {
		const { sessions } = this.#company.store.get();
		const pending: InboxEntry[] = [];
		const decided: InboxEntry[] = [];
		for (const session of sessions) {
			const conversation = this.#company.conversations.get(session.sessionId)?.get();
			if (!conversation) continue;
			const cards = projectTranscript(conversation.events).items.filter(
				(item): item is TranscriptCard =>
					item.kind === "authorization_request" || item.kind === "authorization_decision",
			);
			const decisions = cards.filter((card) => card.kind === "authorization_decision");
			const referenced = new Map<string, JsonValue>();
			for (const decision of decisions) {
				const requestId = authorizationRequestId(decision.body);
				if (requestId) referenced.set(requestId, decision.body);
			}
			for (const card of cards) {
				if (card.kind === "authorization_decision") {
					decided.push({ session, card, decided: true });
					continue;
				}
				const isDecided = referenced.has(card.id.toLowerCase());
				(isDecided ? decided : pending).push({
					session,
					card,
					decided: isDecided,
					resolution: referenced.get(card.id.toLowerCase()),
				});
			}
		}
		const byTime = (a: InboxEntry, b: InboxEntry) => b.card.createdAt.localeCompare(a.card.createdAt);
		return {
			pending: pending.sort(byTime),
			decided: decided.sort(byTime),
		};
	}

	update(): void {
		if (this.#disposed) return;
		const { pending, decided } = this.#entries();
		const loading = this.#scanning || this.#company.store.get().loading;
		const discoveryError = this.#company.store.get().sessionsError;
		const errors = this.#company.store.get().sessions.flatMap((session) => {
			const error = this.#errors.get(session.sessionId);
			return error ? [`${session.title}: ${error}`] : [];
		});
		const renderEntry = (entry: InboxEntry) =>
			h(
				"div",
				{ class: "inbox-entry" },
				renderAuthorizationCard(
					entry.card.kind,
					entry.card.body,
					entry.card.createdAt,
					this.#company.memberName(entry.card.actorUserId),
					entry.resolution,
				),
				h(
					"div",
					{ class: "muted small" },
					"In ",
					h(
						"a",
						{ href: `#/c/${this.#company.profile.profileId}/chat/${entry.session.sessionId}` },
						entry.session.title,
					),
					` · ${fmtTime(entry.card.createdAt)}`,
				),
			);
		replace(
			this.el,
			h("h1", null, "Approvals"),
			notice(
				"neutral",
				"Decisions wait in the cloud until an authorized member records one. Recording a decision from the web is not yet in the client contract, so this inbox is read-only; use the desktop for the decision itself for now.",
			),
			discoveryError
				? notice(
						"danger",
						`Approvals are incomplete. ${discoveryError}`,
						button("Retry conversation discovery", () => void this.#company.refreshSessions()),
					)
				: null,
			errors.length
				? notice(
						"danger",
						`Approvals are incomplete. ${errors.join("; ")}`,
						button("Retry unread conversations", () => {
							for (const id of this.#errors.keys()) this.#scanned.delete(id);
							void this.#scan();
						}),
					)
				: null,
			h("h2", null, `Waiting for a decision (${pending.length})`),
			pending.length
				? h("div", { class: "card-list" }, ...pending.map(renderEntry))
				: // Placeholders stand in until the first reading ends; a later rescan keeps the page.
					loading && !this.#scanned.size
					? cardsSkeleton("Reading conversations")
					: h(
							"div",
							{ class: "empty" },
							loading || errors.length || discoveryError ? "" : "Nothing is waiting for you.",
						),
			decided.length ? h("h2", null, `Decided (${decided.length})`) : null,
			decided.length ? h("div", { class: "card-list" }, ...decided.slice(0, 50).map(renderEntry)) : null,
		);
	}
}
