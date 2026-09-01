import type { TranscriptCard } from "../../cloud/transcript.ts";
import { projectTranscript } from "../../cloud/transcript.ts";
import type { HostedSession } from "../../cloud/types.ts";
import { fmtTime, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";
import { renderAuthorizationCard } from "./conversation.ts";

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
}

export class ApprovalsView {
	readonly el = h("section", { class: "page approvals" });
	readonly #company: CompanyController;
	#scanning = false;
	#scanned = new Set<string>();

	constructor(company: CompanyController) {
		this.#company = company;
		this.update();
		void this.#scan();
	}

	async #scan(): Promise<void> {
		if (this.#scanning) return;
		this.#scanning = true;
		try {
			const sessions = [...this.#company.store.get().sessions].sort((a, b) =>
				b.updatedAt.localeCompare(a.updatedAt),
			);
			for (const session of sessions) {
				if (this.#scanned.has(session.sessionId)) continue;
				this.#company.conversation(session.sessionId);
				await this.#company.loadConversation(session.sessionId);
				this.#scanned.add(session.sessionId);
				this.update();
			}
		} finally {
			this.#scanning = false;
			this.update();
		}
	}

	#entries(): { pending: InboxEntry[]; decided: InboxEntry[]; scannedCount: number; total: number } {
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
			const referenced = new Set<string>();
			for (const decision of decisions) {
				const body =
					decision.body && typeof decision.body === "object" && !Array.isArray(decision.body) ? decision.body : {};
				for (const key of [
					"requestEventId",
					"request_event_id",
					"requestId",
					"request_id",
					"authorizationRequestId",
				]) {
					const value = (body as Record<string, unknown>)[key];
					if (typeof value === "string") referenced.add(value.toLowerCase());
				}
			}
			for (const card of cards) {
				if (card.kind === "authorization_decision") {
					decided.push({ session, card, decided: true });
					continue;
				}
				const isDecided = referenced.has(card.id.toLowerCase());
				(isDecided ? decided : pending).push({ session, card, decided: isDecided });
			}
		}
		const byTime = (a: InboxEntry, b: InboxEntry) => b.card.createdAt.localeCompare(a.card.createdAt);
		return {
			pending: pending.sort(byTime),
			decided: decided.sort(byTime),
			scannedCount: this.#scanned.size,
			total: sessions.length,
		};
	}

	update(): void {
		const { pending, decided, scannedCount, total } = this.#entries();
		const renderEntry = (entry: InboxEntry) =>
			h(
				"div",
				{ class: "inbox-entry" },
				renderAuthorizationCard(
					entry.card.kind,
					entry.card.body,
					entry.card.createdAt,
					this.#company.memberName(entry.card.actorUserId),
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
			this.#scanning ? spinner(`Reading conversations (${scannedCount}/${total})`) : null,
			h("h2", null, `Waiting for a decision (${pending.length})`),
			pending.length
				? h("div", { class: "card-list" }, ...pending.map(renderEntry))
				: h("div", { class: "empty" }, this.#scanning ? "" : "Nothing is waiting for you."),
			decided.length ? h("h2", null, `Decided (${decided.length})`) : null,
			decided.length ? h("div", { class: "card-list" }, ...decided.slice(0, 50).map(renderEntry)) : null,
		);
	}
}
