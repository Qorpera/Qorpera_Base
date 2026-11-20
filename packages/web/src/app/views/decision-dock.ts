import { type InteractionOutcome, questionOptions, typedNote } from "../../cloud/interactions.ts";
import type { OpenQuestion } from "../../cloud/open-questions.ts";
import type { JsonValue } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, replace } from "../../ui/dom.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { OpenQuestions } from "../open-questions.ts";
import type { QuestionDockHost } from "./question-dock.ts";

const NARROW_BELOW = 620;
const FIGURE_BESIDE = 132;
const FIGURE_ABOVE = 58;
const MAX_TIMER_MS = 2 ** 31 - 1;
export const UNDO_MS = 5_000;

function expiry(question: OpenQuestion): number {
	const at = question.request.expiresAt ? Date.parse(question.request.expiresAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export function decisionOrder(a: OpenQuestion, b: OpenQuestion): number {
	if (expiry(a) !== expiry(b)) return expiry(a) < expiry(b) ? -1 : 1;
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.interactionId.localeCompare(b.interactionId);
}

export interface Decided {
	readonly question: OpenQuestion;
	readonly outcome: InteractionOutcome;
	readonly value: Record<string, JsonValue>;
	readonly at: number;
	state: "held" | "sending" | "sent";
}

interface Shared {
	readonly decided: Decided[];
	readonly errors: Map<string, string>;
	readonly docks: Set<() => void>;
}

const SHARED = new WeakMap<OpenQuestions, Shared>();

export class DecisionDock {
	readonly el: HTMLElement;
	readonly #host: QuestionDockHost;
	readonly #lifetime = new AbortController();
	readonly #decided: Decided[];
	readonly #holds = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #errors: Map<string, string>;
	readonly #docks: Set<() => void>;
	readonly #redraw = () => this.#draw();
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
	#told = "";
	#narrow = false;
	#expires: ReturnType<typeof setTimeout> | undefined;
	#cut: ResizeObserver | undefined;

	constructor(host: QuestionDockHost) {
		this.#host = host;
		let shared = SHARED.get(host.questions);
		if (!shared) {
			shared = { decided: [], errors: new Map(), docks: new Set() };
			SHARED.set(host.questions, shared);
		}
		this.#decided = shared.decided;
		this.#errors = shared.errors;
		this.#docks = shared.docks;
		this.#docks.add(this.#redraw);
		this.el = h("aside", { class: "decision-dock", "aria-label": t("Decisions for you"), hidden: true });
		this.#tabs.setAttribute("aria-label", t("Decisions for you"));
		this.#tabs.addEventListener("keydown", (event) => this.#step(event));
		this.el.append(this.#stage, this.#tabs);
		const unsubscribe = host.questions.store.subscribe(() => this.#draw());
		this.#stopWatch = host.questions.watch();
		this.#lifetime.signal.addEventListener("abort", unsubscribe, { once: true });
		if (typeof window !== "undefined") {
			const signal = this.#lifetime.signal;
			window.addEventListener("pagehide", () => this.#sendHeld(), { signal });
			document.addEventListener(
				"visibilitychange",
				() => {
					if (document.visibilityState === "hidden") this.#sendHeld();
				},
				{ signal },
			);
			window.addEventListener(
				"beforeunload",
				(event) => {
					if (!this.#decided.some((entry) => entry.state === "held")) return;
					event.preventDefault();
					this.#sendHeld();
				},
				{ signal },
			);
		}
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
		return this.waiting.split(" ").includes(interactionId.toLowerCase());
	}

	get waiting(): string {
		if (this.#dropUndelivered()) this.#waiting = this.#waitingNow(this.#cards());
		return this.#waiting;
	}

	get decided(): readonly Decided[] {
		this.#dropUndelivered();
		return this.#decided;
	}

	get decidedKey(): string {
		this.#dropUndelivered();
		return this.#decided.map((entry) => `${entry.question.interactionId}:${entry.state}`).join(" ");
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	undo(interactionId: string): void {
		const index = this.#decided.findIndex(
			(entry) => entry.question.interactionId === interactionId && entry.state === "held",
		);
		if (index < 0) return;
		clearTimeout(this.#holds.get(interactionId));
		this.#holds.delete(interactionId);
		this.#decided.splice(index, 1);
		this.#current = interactionId;
		this.#draw();
	}

	renderDecided(entry: Decided): HTMLElement {
		const { question, outcome } = entry;
		const agent = this.#host.agent(question.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const answer = { outcome, answer: entry.value };
		const note = typedNote(question.request, answer);
		const skipped = outcome !== "answered";
		const labels = new Map(questionOptions(question.request).map((option) => [option.value, option.label]));
		const values = Array.isArray(entry.value.values)
			? entry.value.values.filter((value): value is string => typeof value === "string")
			: [];
		const said = note !== undefined ? `“${note}”` : values.map((value) => labels.get(value) ?? value).join(", ");
		const word = skipped ? t("Skipped") : note !== undefined ? t("Your note") : t("Decided");
		const by =
			entry.state === "held"
				? t("Goes to {name} in a moment", { name })
				: entry.state === "sending"
					? t("Sending to {name}…", { name })
					: t("Sent to {name}", { name });
		const ring = h("span", { class: "decided-ring", "aria-hidden": "true" });
		ring.style.animationDuration = `${UNDO_MS}ms`;
		ring.style.animationDelay = `${Math.min(0, entry.at - Date.now())}ms`;
		return h(
			"section",
			{
				class: `decided is-${entry.state}`,
				dataset: { decided: question.interactionId },
				"aria-label": `${word}: ${question.request.title}`,
			},
			h("div", { class: "decided-rule" }, h("span", null, word)),
			h(
				"p",
				{ class: "decided-ask" },
				h("span", { class: "decided-figure" }, agentFigure(agent, name, { size: 22, still: true })),
				h("span", null, question.request.title),
			),
			skipped || !said ? null : h("p", { class: "decided-answer" }, said),
			h(
				"p",
				{ class: "decided-by" },
				h("span", { "aria-live": "polite" }, by),
				entry.state === "held"
					? h(
							"button",
							{ type: "button", class: "decided-undo", onclick: () => this.undo(question.interactionId) },
							ring,
							t("Undo"),
						)
					: null,
			),
		);
	}

	dispose(): void {
		this.#sendHeld();
		this.#lifetime.abort();
		this.#stopWatch();
		this.#sizes?.disconnect();
		this.#cut?.disconnect();
		this.#watched?.stop();
		this.#watched = undefined;
		if (this.#expires !== undefined) clearTimeout(this.#expires);
		this.#docks.delete(this.#redraw);
		this.#listeners.clear();
		this.el.remove();
	}

	#dropUndelivered(): boolean {
		const kept = this.#decided.filter((entry) => {
			if (entry.state !== "sent") return true;
			const id = entry.question.interactionId;
			const items = this.#host.conversation(entry.question.sessionId).get().projection?.items ?? [];
			return !items.some(
				(item) => item.kind === "interaction" && item.id.toLowerCase() === id && item.answerFailed === true,
			);
		});
		if (kept.length === this.#decided.length) return false;
		this.#decided.splice(0, this.#decided.length, ...kept);
		return true;
	}

	#waitingNow(cards: OpenQuestion[]): string {
		return [...cards.map((card) => card.interactionId), ...this.#decided.map((entry) => entry.question.interactionId)]
			.map((id) => id.toLowerCase())
			.join(" ");
	}

	#everyDock(): void {
		for (const redraw of [...this.#docks]) redraw();
	}

	#onItsWay(interactionId: string): boolean {
		return this.#decided.some((entry) => entry.question.interactionId === interactionId && entry.state !== "sent");
	}

	#cards(): OpenQuestion[] {
		const now = Date.now();
		return this.#host.questions.store
			.get()
			.questions.filter(
				(question) =>
					expiry(question) > now &&
					!this.#onItsWay(question.interactionId) &&
					!this.#host.conversation(question.sessionId).get().interactionAnswers?.[question.interactionId],
			)
			.sort(decisionOrder);
	}

	#untilNextExpiry(cards: OpenQuestion[]): void {
		if (this.#expires !== undefined) clearTimeout(this.#expires);
		this.#expires = undefined;
		const next = Math.min(...cards.map(expiry));
		if (!Number.isFinite(next)) return;
		this.#expires = setTimeout(
			() => {
				this.#expires = undefined;
				this.#draw();
			},
			Math.min(Math.max(next - Date.now(), 0) + 1, MAX_TIMER_MS),
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#dropUndelivered();
		const cards = this.#cards();
		this.#untilNextExpiry(cards);
		const current = cards.find((card) => card.interactionId === this.#current) ?? cards[0];
		this.#current = current?.interactionId;
		this.#watch(current?.sessionId);
		this.#waiting = this.#waitingNow(cards);
		this.el.hidden = !current;
		this.el.classList.toggle("is-narrow", this.#narrow);
		if (current) {
			this.#drawStage(current);
			this.#drawTabs(cards, current);
		} else {
			this.#stageKey = "";
			this.#tabsKey = "";
			this.#cut?.disconnect();
			this.#cut = undefined;
			replace(this.#stage);
			replace(this.#tabs);
		}
		const told = `${this.#waiting}|${this.#decided.map((entry) => `${entry.question.interactionId}:${entry.state}`).join(" ")}`;
		if (told === this.#told) return;
		this.#told = told;
		for (const listener of this.#listeners) listener();
	}

	#drawStage(current: OpenQuestion): void {
		const error = this.#errors.get(current.interactionId);
		const key = JSON.stringify([current.interactionId, error, this.#narrow, presentationLocale()]);
		if (key === this.#stageKey) return;
		this.#stageKey = key;
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const card = renderInteractionCard(
			{
				id: current.interactionId,
				actorUserId: current.actorUserId,
				request: current.request,
				createdAt: current.createdAt,
			},
			{
				agentName: name,
				memberName: (userId) => this.#host.memberName(userId),
				canAnswer: true,
				inThread: true,
				...(this.#host.image ? { image: this.#host.image } : {}),
				...(this.#host.app ? { app: this.#host.app } : {}),
				answer: async (outcome, value) => this.#decide(current, outcome, value),
			},
		);
		this.#markCut(card);
		replace(
			this.#stage,
			h(
				"div",
				{ class: "decision-card" },
				card,
				error ? h("p", { class: "decision-error", role: "alert" }, error) : null,
			),
			h(
				"div",
				{ class: "decision-figure" },
				agentFigure(agent, name, {
					size: this.#narrow ? FIGURE_ABOVE : FIGURE_BESIDE,
					activity: "Waiting",
					ask: "question",
				}),
			),
		);
	}

	#markCut(card: HTMLElement): void {
		this.#cut?.disconnect();
		this.#cut = undefined;
		const mark = () => card.classList.toggle("is-cut", card.scrollHeight - card.scrollTop - card.clientHeight > 4);
		card.addEventListener("scroll", mark, { passive: true });
		if (typeof ResizeObserver !== "function") return;
		this.#cut = new ResizeObserver(mark);
		this.#cut.observe(card);
		for (const part of card.children) this.#cut.observe(part);
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

	#decide(question: OpenQuestion, outcome: InteractionOutcome, value: Record<string, JsonValue>): void {
		const id = question.interactionId;
		if (this.#onItsWay(id)) return;
		this.#errors.delete(id);
		const entry: Decided = { question, outcome, value, at: Date.now(), state: "held" };
		this.#decided.push(entry);
		this.#holds.set(
			id,
			setTimeout(() => void this.#send(entry), UNDO_MS),
		);
		if (this.#current === id) this.#current = undefined;
		this.#draw();
	}

	#sendHeld(): void {
		for (const entry of [...this.#decided]) if (entry.state === "held") void this.#send(entry);
	}

	async #send(entry: Decided): Promise<void> {
		const { question } = entry;
		const id = question.interactionId;
		clearTimeout(this.#holds.get(id));
		this.#holds.delete(id);
		if (entry.state !== "held") return;
		entry.state = "sending";
		this.#everyDock();
		try {
			await this.#host.questions.answer(question, entry.outcome, entry.value);
		} catch (error) {
			const said = this.#host.conversation(question.sessionId).get().interactionError;
			this.#errors.set(
				id,
				said ??
					(error instanceof Error && error.message
						? error.message
						: t("Your answer could not be sent. Try again.")),
			);
			const index = this.#decided.indexOf(entry);
			if (index >= 0) this.#decided.splice(index, 1);
			this.#current = id;
			this.#everyDock();
			return;
		}
		entry.state = "sent";
		this.#host.questions.forget(id);
		void this.#host.questions.refresh();
		this.#everyDock();
	}

	#watch(sessionId: string | undefined): void {
		if (this.#watched?.sessionId === sessionId) return;
		this.#watched?.stop();
		this.#watched = sessionId
			? { sessionId, stop: this.#host.conversation(sessionId).subscribe(() => this.#draw()) }
			: undefined;
	}
}
