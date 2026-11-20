import type { InteractionAnswer, InteractionOutcome } from "../../cloud/interactions.ts";
import type { OpenQuestion } from "../../cloud/open-questions.ts";
import type { JsonValue } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, replace } from "../../ui/dom.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { ANSWERED_HOLD_MS } from "../open-questions.ts";
import type { QuestionDockHost } from "./question-dock.ts";

const NARROW_BELOW = 620;
const FIGURE_BESIDE = 132;
const FIGURE_ABOVE = 58;

function expiry(question: OpenQuestion): number {
	const at = question.request.expiresAt ? Date.parse(question.request.expiresAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export function decisionOrder(a: OpenQuestion, b: OpenQuestion): number {
	if (expiry(a) !== expiry(b)) return expiry(a) < expiry(b) ? -1 : 1;
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.interactionId.localeCompare(b.interactionId);
}

interface Held {
	readonly question: OpenQuestion;
	readonly answer: InteractionAnswer;
}

export class DecisionDock {
	readonly el: HTMLElement;
	readonly #host: QuestionDockHost;
	readonly #lifetime = new AbortController();
	readonly #held = new Map<string, Held>();
	readonly #timers = new Set<ReturnType<typeof setTimeout>>();
	readonly #errors = new Map<string, string>();
	readonly #listeners = new Set<() => void>();
	readonly #stage = h("div", { class: "decision-stage" });
	readonly #tabs = h("div", { class: "decision-tabs", role: "tablist" });
	readonly #stopWatch: () => void;
	readonly #sizes: ResizeObserver | undefined;
	#current: string | undefined;
	#watched: { sessionId: string; stop: () => void } | undefined;
	#stageKey = "";
	#tabsKey = "";
	#waiting = "";
	#narrow = false;

	constructor(host: QuestionDockHost) {
		this.#host = host;
		this.el = h("aside", { class: "decision-dock", "aria-label": t("Decisions for you"), hidden: true });
		this.#tabs.setAttribute("aria-label", t("Decisions for you"));
		this.#tabs.addEventListener("keydown", (event) => this.#step(event));
		this.el.append(this.#stage, this.#tabs);
		const unsubscribe = host.questions.store.subscribe(() => this.#draw());
		this.#stopWatch = host.questions.watch();
		this.#lifetime.signal.addEventListener("abort", unsubscribe, { once: true });
		if (typeof ResizeObserver === "function") {
			this.#sizes = new ResizeObserver(() => {
				const narrow = this.el.clientWidth > 0 && this.el.clientWidth < NARROW_BELOW;
				if (narrow === this.#narrow) return;
				this.#narrow = narrow;
				this.#draw();
			});
			this.#sizes.observe(this.el);
		}
		this.#draw();
	}

	shows(interactionId: string): boolean {
		return this.#waiting.split(" ").includes(interactionId.toLowerCase());
	}

	get waiting(): string {
		return this.#waiting;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#stopWatch();
		this.#sizes?.disconnect();
		this.#watched?.stop();
		this.#watched = undefined;
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#listeners.clear();
		this.el.remove();
	}

	#cards(): OpenQuestion[] {
		const listed = this.#host.questions.store.get().questions;
		const ids = new Set(listed.map((question) => question.interactionId));
		const held = [...this.#held.values()]
			.map((entry) => entry.question)
			.filter((question) => !ids.has(question.interactionId));
		return [...listed, ...held].sort(decisionOrder);
	}

	#answerOf(question: OpenQuestion): InteractionAnswer | undefined {
		return (
			this.#held.get(question.interactionId)?.answer ??
			this.#host.conversation(question.sessionId).get().interactionAnswers?.[question.interactionId]
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const cards = this.#cards();
		const current = cards.find((card) => card.interactionId === this.#current) ?? cards[0];
		this.#current = current?.interactionId;
		this.#watch(current?.sessionId);
		const waiting = cards
			.filter((card) => !this.#answerOf(card))
			.map((card) => card.interactionId.toLowerCase())
			.join(" ");
		const changed = waiting !== this.#waiting;
		this.#waiting = waiting;
		this.el.hidden = !current;
		this.el.classList.toggle("is-narrow", this.#narrow);
		if (current) {
			this.#drawStage(current);
			this.#drawTabs(cards, current);
		} else {
			this.#stageKey = "";
			this.#tabsKey = "";
			replace(this.#stage);
			replace(this.#tabs);
		}
		if (changed) for (const listener of this.#listeners) listener();
	}

	#drawStage(current: OpenQuestion): void {
		const answer = this.#answerOf(current);
		const error = this.#errors.get(current.interactionId);
		const sent = this.#held.has(current.interactionId);
		const key = JSON.stringify([
			current.interactionId,
			answer && [answer.outcome, answer.answer, answer.pending],
			error,
			sent,
			this.#narrow,
			presentationLocale(),
		]);
		if (key === this.#stageKey) return;
		this.#stageKey = key;
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const declined = answer !== undefined && ["declined", "dismissed", "discarded"].includes(answer.outcome);
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
				canAnswer: !answer,
				...(answer ? { inDock: true } : { inThread: true }),
				...(this.#host.image ? { image: this.#host.image } : {}),
				...(this.#host.app ? { app: this.#host.app } : {}),
				answer: (outcome, value) => this.#answer(current, outcome, value),
			},
		);
		this.#stage.classList.toggle("is-answered", Boolean(answer));
		replace(
			this.#stage,
			h(
				"div",
				{ class: "decision-card" },
				answer
					? h(
							"p",
							{ class: "decision-sent", "aria-live": "polite" },
							declined ? t("Skipped") : sent ? t("Sent to {name}", { name }) : t("Sending to {name}…", { name }),
						)
					: null,
				card,
				error ? h("p", { class: "decision-error", role: "alert" }, error) : null,
			),
			h(
				"div",
				{ class: "decision-figure" },
				agentFigure(agent, name, {
					size: this.#narrow ? FIGURE_ABOVE : FIGURE_BESIDE,
					activity: answer ? "Done" : "Waiting",
					...(answer ? {} : { ask: "question" as const }),
				}),
			),
		);
	}

	#drawTabs(cards: OpenQuestion[], current: OpenQuestion): void {
		this.#tabs.hidden = cards.length < 2;
		const key = JSON.stringify([cards.map((card) => card.interactionId), presentationLocale()]);
		if (key !== this.#tabsKey) {
			this.#tabsKey = key;
			replace(
				this.#tabs,
				...cards.map((card) => {
					const agent = this.#host.agent(card.staffAgentId);
					const name = agent?.displayName ?? t("The agent");
					return h(
						"button",
						{
							type: "button",
							role: "tab",
							class: "decision-tab",
							title: `${name}: ${card.request.title}`,
							dataset: { decision: card.interactionId },
							onclick: () => this.#select(card.interactionId),
						},
						h("span", { class: "decision-tab-figure" }, agentFigure(agent, name, { size: 28, still: true })),
						h("span", { class: "decision-tab-label" }, card.request.title),
					);
				}),
			);
		}
		for (const tab of this.#tabs.querySelectorAll<HTMLElement>(".decision-tab")) {
			const chosen = tab.dataset.decision === current.interactionId;
			tab.setAttribute("aria-selected", String(chosen));
			tab.tabIndex = chosen ? 0 : -1;
		}
	}

	#select(interactionId: string): void {
		this.#current = interactionId;
		this.#draw();
	}

	#step(event: KeyboardEvent): void {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const cards = this.#cards();
		const index = cards.findIndex((card) => card.interactionId === this.#current);
		const next = cards[(index + (event.key === "ArrowRight" ? 1 : -1) + cards.length) % cards.length];
		if (!next) return;
		event.preventDefault();
		this.#select(next.interactionId);
		this.#tabs.querySelector<HTMLElement>('.decision-tab[aria-selected="true"]')?.focus({ preventScroll: true });
	}

	async #answer(question: OpenQuestion, outcome: InteractionOutcome, value: Record<string, JsonValue>): Promise<void> {
		this.#errors.delete(question.interactionId);
		try {
			await this.#host.questions.answer(question, outcome, value);
		} catch (error) {
			const said = this.#host.conversation(question.sessionId).get().interactionError;
			this.#errors.set(
				question.interactionId,
				said ??
					(error instanceof Error && error.message
						? error.message
						: t("Your answer could not be sent. Try again.")),
			);
			this.#draw();
			throw error;
		}
		const answer = this.#host.conversation(question.sessionId).get().interactionAnswers?.[question.interactionId] ?? {
			outcome,
			answer: value,
			answeredAt: new Date().toISOString(),
		};
		this.#held.set(question.interactionId, { question, answer: { ...answer, pending: false } });
		this.#later(ANSWERED_HOLD_MS, () => {
			this.#held.delete(question.interactionId);
			this.#host.questions.forget(question.interactionId);
			if (this.#current === question.interactionId) this.#current = undefined;
			this.#draw();
		});
		this.#later(ANSWERED_HOLD_MS + 1_000, () => void this.#host.questions.refresh());
		this.#draw();
	}

	#later(ms: number, run: () => void): void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			if (!this.#lifetime.signal.aborted) run();
		}, ms);
		this.#timers.add(timer);
	}

	#watch(sessionId: string | undefined): void {
		if (this.#watched?.sessionId === sessionId) return;
		this.#watched?.stop();
		this.#watched = sessionId
			? { sessionId, stop: this.#host.conversation(sessionId).subscribe(() => this.#draw()) }
			: undefined;
	}
}
