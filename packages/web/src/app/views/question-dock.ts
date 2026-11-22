import type { InteractionAnswer, InteractionOutcome } from "../../cloud/interactions.ts";
import type { OpenQuestion } from "../../cloud/open-questions.ts";
import type { HostedStaffAgent, JsonValue } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { type InteractionCardContext, renderInteractionCard } from "../../ui/interaction-card.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { ConversationState } from "../company.ts";
import { ANSWERED_HOLD_MS, type OpenQuestions, questionApps } from "../open-questions.ts";
import type { Store } from "../state.ts";

/* The questions dock on an app's page and in the Concepts viewer (app/open-questions.ts; Jonas, 10 November 2026:
 * agents engage the founder in their decisions where the work is, and it should be fun). Qorpera draws it, outside the
 * app's frame, over the stage's corner: the agent who asks (its figure waiting) and the card itself as the thread
 * draws it (ui/interaction-card.ts). One tap answers; the card shows the answer at once, the figure cheers, "Sent to
 * Bob" pops, and after a moment the card flies off and the next one comes up. The member can fold the dock to a pill
 * and look at the app first. Nothing in the app can reach it: the frame reads only.
 *
 * The dock's head is the card's only head (Jonas, 13 November 2026: "In the question box I would also simplify and
 * remove 'Open the chat, QUESTION, Co-Founder · 02:45 PM, Waiting for you'"): the figure, who asks, the way between
 * several questions and the fold. The card below is the question itself — title, body, links, options and Skip — with
 * its own label row kept for a screen reader (`inDock`). */

export interface QuestionDockHost {
	readonly questions: OpenQuestions;
	readonly agent: (agentId: string) => HostedStaffAgent | undefined;
	readonly memberName: (userId: string | undefined) => string;
	readonly image?: InteractionCardContext["image"];
	/** An app of the company by its name, for an option whose preview names one. */
	readonly app?: InteractionCardContext["app"];
	/** The thread's conversation, where an answer sent shows at once; never read in full for this. */
	readonly conversation: (sessionId: string) => Store<ConversationState>;
}

/** Which cards a dock shows, by the apps a card points at. */
export type QuestionMatch = (apps: ReadonlySet<string>) => boolean;

/** Whether the dock is folded, kept for the viewer in this browser. */
const FOLDED_KEY = "qorpera.web.question-dock-folded";

function storedFolded(): boolean {
	try {
		return localStorage.getItem(FOLDED_KEY) === "1";
	} catch {
		return false;
	}
}

function storeFolded(folded: boolean): void {
	try {
		localStorage.setItem(FOLDED_KEY, folded ? "1" : "0");
	} catch {
		/* The choice lasts this view. */
	}
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A card answered here, kept on screen answered until it goes. */
interface Held {
	readonly question: OpenQuestion;
	readonly answer: InteractionAnswer;
}

export class QuestionDock {
	readonly el: HTMLElement;
	readonly #host: QuestionDockHost;
	readonly #lifetime = new AbortController();
	#match: QuestionMatch;
	#folded = storedFolded();
	/** The card on screen, by its id: it stays while others come and go. */
	#current: string | undefined;
	readonly #held = new Map<string, Held>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Why an answer sent from here did not go, by card. */
	readonly #errors = new Map<string, string>();
	/** The conversation the card on screen is in, watched for its answer. */
	#watched: { sessionId: string; stop: () => void } | undefined;
	#shownKey = "";
	#count = 0;
	#stopWatch: () => void;

	constructor(host: QuestionDockHost, match: QuestionMatch) {
		this.#host = host;
		this.#match = match;
		this.el = h("aside", { class: "question-dock", "aria-label": t("Questions for you"), hidden: true });
		const unsubscribe = host.questions.store.subscribe(() => this.#draw());
		this.#stopWatch = host.questions.watch();
		this.#lifetime.signal.addEventListener("abort", unsubscribe, { once: true });
		this.#draw();
	}

	/** Shows other cards: the Concepts viewer's concepts changed. */
	setMatch(match: QuestionMatch): void {
		this.#match = match;
		this.#shownKey = "";
		this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#stopWatch();
		this.#watched?.stop();
		this.#watched = undefined;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		this.el.remove();
	}

	/** The cards this dock shows, newest first: the open ones that point here and those answered here, still held. A
	 * held card points here too, or it is not shown: the Concepts viewer's dock follows the concept that is open, and a
	 * card answered on another concept's page stays off this one while it is held (review r1 of #1763, F3). */
	#cards(): OpenQuestion[] {
		const here = (question: OpenQuestion) => this.#match(questionApps(question.request));
		const listed = this.#host.questions.store.get().questions.filter(here);
		const ids = new Set(listed.map((question) => question.interactionId));
		const held = [...this.#held.values()]
			.map((entry) => entry.question)
			.filter((question) => !ids.has(question.interactionId) && here(question));
		return [...listed, ...held].sort((a, b) =>
			a.createdAt === b.createdAt
				? a.interactionId.localeCompare(b.interactionId)
				: a.createdAt < b.createdAt
					? 1
					: -1,
		);
	}

	#peek(sessionId: string): ConversationState | undefined {
		if (typeof this.#host.questions.conversationState === "function")
			return this.#host.questions.conversationState(sessionId);
		return this.#host.conversation(sessionId).get();
	}

	#answerOf(question: OpenQuestion): InteractionAnswer | undefined {
		return (
			this.#held.get(question.interactionId)?.answer ??
			this.#peek(question.sessionId)?.interactionAnswers?.[question.interactionId]
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const cards = this.#cards();
		const current = cards.find((card) => card.interactionId === this.#current) ?? cards[0];
		this.#current = current?.interactionId;
		this.#watch(current?.sessionId);
		const arriving = cards.length > this.#count;
		this.#count = cards.length;
		if (!current) {
			this.#shownKey = "";
			if (!this.el.hidden) this.#leave();
			return;
		}
		// An answer shows the moment it is sent (the conversation's own); once the cloud took it, it is held (#answer).
		const answer = this.#answerOf(current);
		const index = cards.indexOf(current);
		const key = JSON.stringify([
			current.interactionId,
			answer && [answer.outcome, answer.answer, answer.pending],
			this.#errors.get(current.interactionId),
			index,
			cards.length,
			this.#folded,
			this.#held.has(current.interactionId),
			presentationLocale(),
		]);
		if (key === this.#shownKey && !this.el.hidden) return;
		const fresh =
			this.el.hidden || this.#shownKey === "" || !this.#shownKey.startsWith(`["${current.interactionId}"`);
		this.#shownKey = key;
		this.el.hidden = false;
		// Another card comes up while the last one flies off (the member went to another concept): it does not fly.
		if (fresh) this.el.classList.remove("is-flying");
		this.el.classList.toggle("is-folded", this.#folded);
		this.el.classList.toggle("is-answered", Boolean(answer));
		replace(
			this.el,
			...(this.#folded ? [this.#pill(current, cards.length)] : this.#open(current, answer, index, cards)),
		);
		if (fresh) this.#play("is-arriving");
		else if (arriving && this.#folded) this.#play("is-nudging");
	}

	#open(current: OpenQuestion, answer: InteractionAnswer | undefined, index: number, cards: OpenQuestion[]) {
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const answered = Boolean(answer);
		const declined = answer !== undefined && ["declined", "dismissed", "discarded"].includes(answer.outcome);
		// Taken by the cloud: it is on its way to the agent.
		const sent = this.#held.has(current.interactionId);
		const control = (iconName: string, label: string, onclick: () => void, extra = "") =>
			h(
				"button",
				{
					type: "button",
					class: `question-dock-button ${extra}`.trim(),
					title: label,
					"aria-label": label,
					onclick,
				},
				icon(iconName),
			);
		const step = (delta: number) => {
			const next = cards[(index + delta + cards.length) % cards.length];
			if (!next) return;
			this.#current = next.interactionId;
			this.#draw();
		};
		const head = h(
			"header",
			{ class: "question-dock-head" },
			h(
				"span",
				{ class: "question-dock-figure" },
				agentFigure(agent, name, { size: 34, activity: answered ? "Done" : "Waiting", ask: "question" }),
			),
			h(
				"span",
				{ class: "question-dock-copy" },
				h(
					"strong",
					{ class: "question-dock-title", "aria-live": "polite" },
					!answered
						? t("{name} asks you", { name })
						: declined
							? t("Skipped")
							: sent
								? t("Sent to {name}", { name })
								: t("Sending to {name}…", { name }),
				),
				// Nothing stands under who asks while the question waits: the question itself is right below it.
				sent && !declined ? h("small", { class: "question-dock-note" }, t("{name} is on it", { name })) : null,
			),
			cards.length > 1
				? h(
						"span",
						{ class: "question-dock-steps" },
						control("back", t("Previous question"), () => step(-1)),
						h(
							"span",
							{ class: "question-dock-count" },
							t("{index} of {count}", { index: String(index + 1), count: String(cards.length) }),
						),
						control("back", t("Next question"), () => step(1), "is-next"),
					)
				: null,
			control("chevron-down", t("Hide the question"), () => this.#setFolded(true)),
		);
		const card = renderInteractionCard(
			{
				id: current.interactionId,
				actorUserId: current.actorUserId,
				request: current.request,
				createdAt: current.createdAt,
				...(answer ? { answer } : {}),
			},
			{
				agentName: name,
				memberName: (userId) => this.#host.memberName(userId),
				canAnswer: !answered,
				inDock: true,
				...(this.#host.image ? { image: this.#host.image } : {}),
				...(this.#host.app ? { app: this.#host.app } : {}),
				answer: (outcome, value) => this.#answer(current, outcome, value),
			},
		);
		const error = this.#errors.get(current.interactionId);
		return [
			head,
			h("div", { class: "question-dock-card" }, card),
			error ? h("p", { class: "question-dock-error", role: "alert" }, error) : null,
			sent && !declined ? h("span", { class: "question-dock-burst", "aria-hidden": "true" }, icon("check")) : null,
		];
	}

	#pill(current: OpenQuestion, count: number): HTMLElement {
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const label =
			count > 1 ? t("{count} questions for you", { count: String(count) }) : t("{name} asks you", { name });
		return h(
			"button",
			{
				type: "button",
				class: "question-dock-pill",
				"aria-expanded": "false",
				onclick: () => this.#setFolded(false),
			},
			h(
				"span",
				{ class: "question-dock-figure" },
				agentFigure(agent, name, { size: 26, activity: "Waiting", ask: "question" }),
			),
			h("span", { class: "question-dock-pill-label" }, label),
			count > 1 ? h("span", { class: "question-dock-badge" }, String(count)) : null,
		);
	}

	async #answer(question: OpenQuestion, outcome: InteractionOutcome, value: Record<string, JsonValue>): Promise<void> {
		this.#errors.delete(question.interactionId);
		try {
			await this.#host.questions.answer(question, outcome, value);
		} catch (error) {
			const said = this.#peek(question.sessionId)?.interactionError;
			this.#errors.set(
				question.interactionId,
				said ??
					(error instanceof Error && error.message
						? error.message
						: t("Your answer could not be sent. Try again.")),
			);
			this.#shownKey = "";
			this.#draw();
			throw error;
		}
		// Taken: held on screen answered, as sent, then it goes. The thread's own copy may already be settled and gone.
		const answer = this.#peek(question.sessionId)?.interactionAnswers?.[question.interactionId] ?? {
			outcome,
			answer: value,
			answeredAt: new Date().toISOString(),
		};
		this.#hold(question, { ...answer, pending: false });
		this.#shownKey = "";
		this.#draw();
	}

	/** A card answered here stays answered on screen a moment, then flies off and the next comes up. Only the card on
	 * screen flies: one held while the member went to another concept just goes, and the card there stays put. */
	#hold(question: OpenQuestion, answer: InteractionAnswer): void {
		this.#held.set(question.interactionId, { question, answer });
		this.#timers.set(
			question.interactionId,
			setTimeout(() => {
				this.#timers.delete(question.interactionId);
				const go = () => {
					this.#held.delete(question.interactionId);
					this.#host.questions.forget(question.interactionId);
					if (this.#current === question.interactionId) this.#current = undefined;
					this.#shownKey = "";
					this.#draw();
				};
				if (reducedMotion() || this.el.hidden || this.#current !== question.interactionId) return go();
				this.el.classList.add("is-flying");
				setTimeout(() => {
					this.el.classList.remove("is-flying");
					go();
				}, 260);
			}, ANSWERED_HOLD_MS),
		);
		// The list reads again soon: the agent may already ask the next thing.
		this.#timers.set(
			`${question.interactionId}:read`,
			setTimeout(() => void this.#host.questions.refresh(), ANSWERED_HOLD_MS + 1_000),
		);
	}

	/** Watches the conversation of the card on screen, so its answer (and a refusal) shows the moment it is set. */
	#watch(sessionId: string | undefined): void {
		if (this.#watched?.sessionId === sessionId) return;
		this.#watched?.stop();
		this.#watched = sessionId
			? { sessionId, stop: this.#host.conversation(sessionId).subscribe(() => this.#draw()) }
			: undefined;
	}

	#setFolded(folded: boolean): void {
		this.#folded = folded;
		storeFolded(folded);
		this.#shownKey = "";
		this.#draw();
		// Keep the keyboard where the member is: on the pill once folded, on the card once open.
		const target = folded
			? this.el.querySelector<HTMLElement>(".question-dock-pill")
			: this.el.querySelector<HTMLElement>(".question-dock-card button:not([aria-disabled='true'])");
		target?.focus({ preventScroll: true });
	}

	#play(name: string): void {
		if (reducedMotion()) return;
		this.el.classList.remove(name);
		// A reflow restarts the animation when the same class plays again.
		void this.el.offsetWidth;
		this.el.classList.add(name);
		this.el.addEventListener("animationend", () => this.el.classList.remove(name), { once: true });
	}

	#leave(): void {
		if (reducedMotion()) {
			this.el.hidden = true;
			replace(this.el);
			return;
		}
		this.el.classList.add("is-leaving");
		setTimeout(() => {
			this.el.classList.remove("is-leaving");
			if (this.#cards().length === 0) {
				this.el.hidden = true;
				replace(this.el);
			}
		}, 220);
	}
}
