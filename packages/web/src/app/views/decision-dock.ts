import type { EmailDraftAction, EmailDraftContent, EmailDraftState } from "../../cloud/email-drafts.ts";
import { type InteractionOutcome, questionOptions, typedNote } from "../../cloud/interactions.ts";
import {
	decisionTitle,
	type OpenApproval,
	type OpenCard,
	type OpenDecision,
	type OpenDraft,
} from "../../cloud/open-decisions.ts";
import type { ActionReviewAnswer } from "../../cloud/review-rules.ts";
import type { JsonValue } from "../../cloud/types.ts";
import { type ActionReviewDraft, renderActionReviewCard } from "../../ui/authorization-card.ts";
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

function expiry(decision: OpenDecision): number {
	const at =
		decision.kind !== "approval" && decision.request.expiresAt ? Date.parse(decision.request.expiresAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export function decisionOrder(a: OpenDecision, b: OpenDecision): number {
	if (expiry(a) !== expiry(b)) return expiry(a) < expiry(b) ? -1 : 1;
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	return a.interactionId.localeCompare(b.interactionId);
}

interface DecidedState {
	readonly at: number;
	state: "held" | "sending" | "sent";
}

interface DecidedCard extends DecidedState {
	readonly decision: OpenCard;
	readonly outcome: InteractionOutcome;
	readonly value: Record<string, JsonValue>;
}

interface DecidedApproval extends DecidedState {
	readonly decision: OpenApproval;
	readonly answer: ActionReviewAnswer;
	readonly ruleText?: string;
}

interface DecidedDraft extends DecidedState {
	readonly decision: OpenDraft;
	readonly action: "send" | "discard";
	readonly content: EmailDraftContent;
}

export type Decided = DecidedCard | DecidedApproval | DecidedDraft;

interface Shared {
	readonly decided: Decided[];
	readonly errors: Map<string, string>;
	readonly docks: Set<() => void>;
}

const SHARED = new WeakMap<OpenQuestions, Shared>();

function decidedWords(entry: Decided): { word: string; said: string } {
	if (entry.decision.kind === "draft") {
		const { action, content } = entry as DecidedDraft;
		return { word: action === "send" ? t("Email sent") : t("Discarded"), said: content.subject };
	}
	if (entry.decision.kind === "approval") {
		const { answer, ruleText } = entry as DecidedApproval;
		return {
			word: answer === "deny" ? t("Denied") : answer === "always_allow" ? t("Always allowed") : t("Allowed once"),
			said: answer === "always_allow" && ruleText ? ruleText : "",
		};
	}
	const { outcome, value } = entry as DecidedCard;
	if (outcome !== "answered") return { word: t("Skipped"), said: "" };
	const note = typedNote(entry.decision.request, { outcome, answer: value });
	if (note !== undefined) return { word: t("Your note"), said: `“${note}”` };
	const labels = new Map(questionOptions(entry.decision.request).map((option) => [option.value, option.label]));
	const values = Array.isArray(value.values)
		? value.values.filter((picked): picked is string => typeof picked === "string")
		: [];
	return { word: t("Decided"), said: values.map((picked) => labels.get(picked) ?? picked).join(", ") };
}

function draftOutcome({ action, content }: DecidedDraft): string {
	return action === "send" ? `${t("To")} ${[...content.to, ...content.cc].join(", ")}` : t("Nothing was sent");
}

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
	readonly #decidedThreads = new Map<string, () => void>();
	readonly #ruleDrafts = new Map<string, ActionReviewDraft>();
	#stageKey = "";
	#tabsKey = "";
	#waiting = "";
	#told = "";
	#narrow = false;
	#expires: ReturnType<typeof setTimeout> | undefined;
	#cut: { disconnect: () => void } | undefined;

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
		return this.#decided.map((entry) => `${entry.decision.interactionId}:${entry.state}`).join(" ");
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	undo(interactionId: string): void {
		const index = this.#decided.findIndex(
			(entry) => entry.decision.interactionId === interactionId && entry.state === "held",
		);
		if (index < 0) return;
		clearTimeout(this.#holds.get(interactionId));
		this.#holds.delete(interactionId);
		this.#decided.splice(index, 1);
		this.#host.questions.release(interactionId);
		this.#current = interactionId;
		this.#draw();
	}

	renderDecided(entry: Decided): HTMLElement {
		const { decision } = entry;
		const agent = this.#host.agent(decision.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const title = decisionTitle(decision);
		const { word, said } = decidedWords(entry);
		const by =
			decision.kind === "draft"
				? draftOutcome(entry as DecidedDraft)
				: entry.state === "held"
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
				dataset: { decided: decision.interactionId },
				"aria-label": `${word}: ${title}`,
			},
			h("div", { class: "decided-rule" }, h("span", null, word)),
			h(
				"p",
				{ class: "decided-ask" },
				h("span", { class: "decided-figure" }, agentFigure(agent, name, { size: 22, still: true })),
				h("span", null, title),
			),
			said ? h("p", { class: "decided-answer" }, said) : null,
			h(
				"p",
				{ class: "decided-by" },
				h("span", { "aria-live": "polite" }, by),
				entry.state === "held"
					? h(
							"button",
							{ type: "button", class: "decided-undo", onclick: () => this.undo(decision.interactionId) },
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
		for (const stop of this.#decidedThreads.values()) stop();
		this.#decidedThreads.clear();
		this.#listeners.clear();
		this.el.remove();
	}

	#dropUndelivered(): boolean {
		const kept = this.#decided.filter((entry) => {
			if (entry.state !== "sent") return true;
			const id = entry.decision.interactionId;
			const thread = this.#host.conversation(entry.decision.sessionId).get();
			if (thread.interactionAnswers?.[id]) return true;
			return !(thread.projection?.items ?? []).some(
				(item) =>
					(item.kind === "interaction" || item.kind === "authorization_request") &&
					item.id.toLowerCase() === id &&
					item.answerFailed === true,
			);
		});
		if (kept.length === this.#decided.length) return false;
		this.#decided.splice(0, this.#decided.length, ...kept);
		return true;
	}

	#watchDecided(): void {
		const sessions = new Set(this.#decided.map((entry) => entry.decision.sessionId));
		for (const [sessionId, stop] of this.#decidedThreads) {
			if (sessions.has(sessionId)) continue;
			stop();
			this.#decidedThreads.delete(sessionId);
		}
		for (const sessionId of sessions)
			if (!this.#decidedThreads.has(sessionId))
				this.#decidedThreads.set(sessionId, this.#host.conversation(sessionId).subscribe(this.#redraw));
	}

	#waitingNow(cards: OpenDecision[]): string {
		return [...cards.map((card) => card.interactionId), ...this.#decided.map((entry) => entry.decision.interactionId)]
			.map((id) => id.toLowerCase())
			.join(" ");
	}

	#everyDock(): void {
		for (const redraw of [...this.#docks]) redraw();
	}

	#onItsWay(interactionId: string): boolean {
		return this.#decided.some((entry) => entry.decision.interactionId === interactionId && entry.state !== "sent");
	}

	#cards(): OpenDecision[] {
		const now = Date.now();
		const { questions } = this.#host;
		return [
			...questions.store
				.get()
				.decisions.filter(
					(decision) =>
						(expiry(decision) > now || (decision.kind === "draft" && questions.draftUnsettled(decision))) &&
						!this.#onItsWay(decision.interactionId) &&
						!this.#host.conversation(decision.sessionId).get().interactionAnswers?.[decision.interactionId],
				),
			...questions.unsettledDrafts(),
		].sort(decisionOrder);
	}

	#untilNextExpiry(cards: OpenDecision[]): void {
		if (this.#expires !== undefined) clearTimeout(this.#expires);
		this.#expires = undefined;
		const now = Date.now();
		const next = Math.min(...cards.map(expiry).filter((at) => at > now));
		if (!Number.isFinite(next)) return;
		this.#expires = setTimeout(
			() => {
				this.#expires = undefined;
				this.#draw();
			},
			Math.min(next - now + 1, MAX_TIMER_MS),
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
		this.#watchDecided();
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
		const told = `${this.#waiting}|${this.#decided.map((entry) => `${entry.decision.interactionId}:${entry.state}`).join(" ")}`;
		if (told === this.#told) return;
		this.#told = told;
		for (const listener of this.#listeners) listener();
	}

	#drawStage(current: OpenDecision): void {
		const error = this.#errors.get(current.interactionId);
		const key = JSON.stringify([current.interactionId, error, this.#narrow, presentationLocale()]);
		if (key === this.#stageKey) return;
		this.#stageKey = key;
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const card =
			current.kind === "draft"
				? this.#draftCard(current, name)
				: current.kind === "approval"
					? renderActionReviewCard(current.review, undefined, {
							memberName: (userId) => this.#host.memberName(userId),
							draft: this.#ruleDrafts.get(current.interactionId),
							onDraft: (draft) => this.#ruleDrafts.set(current.interactionId, draft),
							answer: (answer, ruleText) =>
								this.#hold({
									decision: current,
									answer,
									...(ruleText === undefined ? {} : { ruleText }),
									at: Date.now(),
									state: "held",
								}),
						})
					: renderInteractionCard(
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
								answer: async (outcome, value) =>
									this.#hold({ decision: current, outcome, value, at: Date.now(), state: "held" }),
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
					ask: current.kind === "question" ? "question" : "bang",
				}),
			),
		);
	}

	#draftCard(draft: OpenDraft, name: string): HTMLElement {
		const { questions } = this.#host;
		return renderInteractionCard(
			{
				id: draft.interactionId,
				actorUserId: draft.actorUserId,
				request: draft.request,
				createdAt: draft.createdAt,
			},
			{
				agentName: name,
				memberName: (userId) => this.#host.memberName(userId),
				canAnswer: true,
				inThread: true,
				answer: async () => {},
				emailDraft: questions.draftEditor(draft),
				loadEmailDraft: () => this.#draftStep(draft, questions.loadDraft(draft)),
				actEmailDraft: (action: EmailDraftAction, content: EmailDraftContent) =>
					this.#draftStep(draft, questions.actDraft(draft, action, content)),
			},
		);
	}

	async #draftStep(draft: OpenDraft, step: Promise<EmailDraftState>): Promise<EmailDraftState> {
		const state = await step;
		const id = draft.interactionId;
		if (
			(state.status !== "sent" && state.status !== "discarded") ||
			state.notificationPending ||
			this.#decided.some((entry) => entry.decision.interactionId === id)
		)
			return state;
		this.#decided.push({
			decision: draft,
			action: state.status === "sent" ? "send" : "discard",
			content: state.content,
			at: Date.now(),
			state: "sent",
		});
		this.#host.questions.forget(id);
		void this.#host.questions.refresh();
		if (this.#current === id) this.#current = undefined;
		this.#everyDock();
		return state;
	}

	#markCut(card: HTMLElement): void {
		this.#cut?.disconnect();
		this.#cut = undefined;
		const mark = () => card.classList.toggle("is-cut", card.scrollHeight - card.scrollTop - card.clientHeight > 4);
		card.addEventListener("scroll", mark, { passive: true });
		if (typeof ResizeObserver !== "function") return;
		const sizes = new ResizeObserver(mark);
		sizes.observe(card);
		for (const part of card.children) sizes.observe(part);
		const redrawn = new MutationObserver(() => {
			for (const part of card.children) sizes.observe(part);
			mark();
		});
		redrawn.observe(card, { childList: true });
		this.#cut = {
			disconnect: () => {
				sizes.disconnect();
				redrawn.disconnect();
			},
		};
	}

	#drawTabs(cards: OpenDecision[], current: OpenDecision): void {
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
							title: `${name}: ${decisionTitle(card)}`,
							dataset: { decision: card.interactionId },
							onclick: () => this.#select(card.interactionId),
						},
						h("span", { class: "decision-tab-figure" }, agentFigure(agent, name, { size: 28, still: true })),
						h("span", { class: "decision-tab-label" }, decisionTitle(card)),
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

	#hold(entry: Decided): void {
		const id = entry.decision.interactionId;
		if (this.#onItsWay(id)) return;
		this.#errors.delete(id);
		this.#decided.push(entry);
		this.#host.questions.hold(id);
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
		const { decision } = entry;
		const id = decision.interactionId;
		clearTimeout(this.#holds.get(id));
		this.#holds.delete(id);
		if (entry.state !== "held") return;
		entry.state = "sending";
		this.#everyDock();
		try {
			if (entry.decision.kind === "approval") {
				const { answer, ruleText } = entry as DecidedApproval;
				await this.#host.questions.answerApproval(entry.decision, answer, ruleText);
			} else {
				const { outcome, value } = entry as DecidedCard;
				await this.#host.questions.answer(entry.decision, outcome, value);
			}
		} catch (error) {
			const said = this.#host.conversation(decision.sessionId).get().interactionError;
			this.#errors.set(
				id,
				said ??
					(error instanceof Error && error.message
						? error.message
						: t("Your answer could not be sent. Try again.")),
			);
			const index = this.#decided.indexOf(entry);
			if (index >= 0) this.#decided.splice(index, 1);
			this.#host.questions.release(id);
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
