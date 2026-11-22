import type { EmailDraftAction, EmailDraftContent, EmailDraftState } from "../../cloud/email-drafts.ts";
import { type InteractionOutcome, questionInput, questionOptions, typedNote } from "../../cloud/interactions.ts";
import {
	decisionTitle,
	type OpenApproval,
	type OpenCard,
	type OpenDecision,
	type OpenDraft,
} from "../../cloud/open-decisions.ts";
import type { ActionReviewAnswer } from "../../cloud/review-rules.ts";
import type { JsonValue } from "../../cloud/types.ts";
import { type ActionReviewDraft, authorizationRequestId, renderActionReviewCard } from "../../ui/authorization-card.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, personAvatar, replace } from "../../ui/dom.ts";
import { renderInteractionCard } from "../../ui/interaction-card.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { OpenQuestions } from "../open-questions.ts";
import type { QuestionDockHost } from "./question-dock.ts";

const NARROW_BELOW = 620;
const FIGURE_BESIDE = 132;
const FIGURE_ABOVE = 58;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_SENT_DECIDED = 50;
export const UNDO_MS = 5_000;
export const SETTLE_MS = 600;

function expiry(decision: OpenDecision): number {
	const at =
		decision.kind !== "approval" && decision.request.expiresAt ? Date.parse(decision.request.expiresAt) : Number.NaN;
	return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export function decisionOrder(a: OpenDecision, b: OpenDecision): number {
	if (Boolean(a.othersAnswer) !== Boolean(b.othersAnswer)) return a.othersAnswer ? 1 : -1;
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
	readonly pickOf?: string;
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
	const { pickOf } = entry as DecidedCard;
	return {
		word: pickOf ? t("{name}'s pick", { name: pickOf }) : t("Decided"),
		said: values.map((picked) => labels.get(picked) ?? picked).join(", "),
	};
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
	#votesKey = "";
	#shown: string | undefined;
	#shownOthers = false;
	#shownVoting = false;
	#chose = false;
	#pickPainted = "";
	#shownNone = false;
	#staged: string | undefined;
	#byMember = false;
	#settlesAt = 0;
	readonly #voteCalls = new Map<string, number>();
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
		this.#stage.addEventListener(
			"click",
			(event) => {
				if (Date.now() >= this.#settlesAt) return;
				event.stopPropagation();
				event.preventDefault();
			},
			true,
		);
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
		this.#byMember = true;
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

	#settledInThread(entry: Decided): boolean {
		if (entry.state !== "sent") return false;
		const id = entry.decision.interactionId.toLowerCase();
		const thread = this.#host.conversation(entry.decision.sessionId).get();
		if (thread.interactionAnswers?.[id]) return false;
		const items = thread.projection?.items ?? [];
		if (entry.decision.kind === "approval")
			return items.some(
				(item) => item.kind === "authorization_decision" && authorizationRequestId(item.body)?.toLowerCase() === id,
			);
		return items.some(
			(item) =>
				item.kind === "interaction" &&
				item.id.toLowerCase() === id &&
				Boolean(item.answer) &&
				!item.answer?.pending &&
				!item.answerFailed,
		);
	}

	#dropUndelivered(): boolean {
		const filtered = this.#decided.filter((entry) => {
			if (entry.state !== "sent") return true;
			const id = entry.decision.interactionId;
			const thread = this.#host.questions.conversationState(entry.decision.sessionId);
			if (!thread) return true;
			if (thread.interactionAnswers?.[id]) return true;
			return !(thread.projection?.items ?? []).some(
				(item) =>
					(item.kind === "interaction" || item.kind === "authorization_request") &&
					item.id.toLowerCase() === id &&
					item.answerFailed === true,
			);
		});
		// WHY: Bound retained "sent" entries across long sessions so SHARED.decided cannot grow without limit.
		let sentCount = 0;
		for (const entry of filtered) if (entry.state === "sent") sentCount++;
		let dropSent = Math.max(0, sentCount - MAX_SENT_DECIDED);
		const kept =
			dropSent > 0
				? filtered.filter((entry) => {
						if (entry.state === "sent" && dropSent > 0) {
							dropSent--;
							return false;
						}
						return true;
					})
				: filtered;
		if (kept.length === this.#decided.length) return false;
		this.#decided.splice(0, this.#decided.length, ...kept);
		return true;
	}

	#watchDecided(): void {
		// WHY: Release thread store subscriptions once every sent decision for that thread is confirmed settled.
		const sessions = new Set(
			this.#decided.filter((entry) => !this.#settledInThread(entry)).map((entry) => entry.decision.sessionId),
		);
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
						!(decision.kind === "draft" && decision.othersAnswer) &&
						(expiry(decision) > now || (decision.kind === "draft" && questions.draftUnsettled(decision))) &&
						!this.#onItsWay(decision.interactionId) &&
						!this.#host.questions.conversationState(decision.sessionId)?.interactionAnswers?.[
							decision.interactionId
						],
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
		const current =
			cards.find((card) => card.interactionId === this.#current) ??
			(this.#shownOthers ? cards.find((card) => card.othersAnswer) : undefined) ??
			cards[0];
		if (
			current &&
			(current.interactionId !== this.#shown
				? this.#shown !== undefined || this.#shownNone
				: this.#shownVoting !== (current.othersAnswer === true || this.#picksOwn(current)))
		)
			this.#settlesAt = this.#byMember ? 0 : Date.now() + SETTLE_MS;
		this.#shownNone = !current && this.#host.questions.store.get().read;
		this.#chose = this.#byMember;
		this.#byMember = false;
		this.#shown = current?.interactionId;
		this.#shownOthers = current?.othersAnswer === true;
		this.#shownVoting = current !== undefined && (current.othersAnswer === true || this.#picksOwn(current));
		this.#current = current?.interactionId;
		this.#watch(current?.sessionId);
		this.#waiting = this.#waitingNow(cards);
		this.#watchDecided();
		this.el.hidden = !current;
		this.el.classList.toggle("is-narrow", this.#narrow);
		if (current) {
			this.#drawStage(current);
			this.#paintVotes(current);
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
		const others = current.othersAnswer === true;
		const mayVote = this.#host.questions.mayVote();
		const ownPick = this.#picksOwn(current);
		const key = JSON.stringify([
			current.interactionId,
			error,
			this.#narrow,
			presentationLocale(),
			others,
			mayVote,
			ownPick,
		]);
		if (key === this.#stageKey) return;
		this.#stageKey = key;
		this.#votesKey = "";
		const agent = this.#host.agent(current.staffAgentId);
		const name = agent?.displayName ?? t("The agent");
		const id = current.interactionId;
		const card =
			current.kind === "draft"
				? this.#draftCard(current, name)
				: current.kind === "approval"
					? renderActionReviewCard(current.review, undefined, {
							memberName: (userId) => this.#host.memberName(userId),
							draft: this.#ruleDrafts.get(current.interactionId),
							onDraft: (draft) => this.#ruleDrafts.set(current.interactionId, draft),
							...(others
								? {}
								: {
										answer: (answer: ActionReviewAnswer, ruleText?: string) =>
											this.#hold({
												decision: current,
												answer,
												...(ruleText === undefined ? {} : { ruleText }),
												at: Date.now(),
												state: "held",
											}),
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
								canAnswer: !others && !ownPick,
								inThread: true,
								viewerId: this.#host.questions.viewerId,
								...(current.kind === "question" && current.round ? { round: current.round } : {}),
								...(others || ownPick
									? {
											vote: {
												answerer: this.#host.memberName(current.actorUserId),
												...(ownPick ? { own: true as const } : {}),
												...(mayVote ? { pick: (value: string) => this.#pick(id, value) } : {}),
											},
										}
									: {}),
								...(this.#host.image ? { image: this.#host.image } : {}),
								...(this.#host.app ? { app: this.#host.app } : {}),
								answer: async (outcome, value) =>
									this.#hold({ decision: current, outcome, value, at: Date.now(), state: "held" }),
							},
						);
		this.#markCut(card);
		const mine = (current.votes ?? []).find((vote) => vote.userId === this.#host.questions.viewerId);
		const typed = this.#staged === id ? this.#stage.querySelector<HTMLInputElement>(".decision-note") : null;
		const typing = typed !== null && typed === document.activeElement;
		this.#staged = id;
		const note =
			others && mayVote
				? (h("input", {
						type: "text",
						class: "decision-note",
						maxlength: 500,
						value: typed?.value ?? mine?.note ?? "",
						placeholder: t("Add a note…"),
						"aria-label": t("Your note on this decision"),
						onkeydown: (event: KeyboardEvent) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							this.#say(id, (event.currentTarget as HTMLInputElement).value);
						},
					}) as HTMLInputElement)
				: null;
		replace(
			this.#stage,
			h(
				"div",
				{ class: "decision-card" },
				card,
				h(
					"div",
					{ class: "decision-votes" },
					h("ul", { class: "vote-notes" }),
					note,
					h("div", { class: "decision-pick" }),
				),
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
		if (typing) note?.focus({ preventScroll: true });
	}

	#listed(id: string): OpenDecision | undefined {
		return this.#host.questions.store.get().decisions.find((decision) => decision.interactionId === id);
	}

	#mine(decision: OpenDecision) {
		return (decision.votes ?? []).find((vote) => vote.userId === this.#host.questions.viewerId);
	}

	#pick(id: string, value: string): void {
		const decision = this.#listed(id);
		if (!decision) return;
		const mine = this.#mine(decision);
		this.#vote(decision, mine?.choice === value ? undefined : value, mine?.note);
	}

	#say(id: string, words: string): void {
		const decision = this.#listed(id);
		if (decision) this.#vote(decision, this.#mine(decision)?.choice, words.trim() || undefined);
	}

	#vote(decision: OpenDecision, choice: string | undefined, note: string | undefined): void {
		const id = decision.interactionId;
		const call = (this.#voteCalls.get(id) ?? 0) + 1;
		this.#voteCalls.set(id, call);
		this.#errors.delete(id);
		void this.#host.questions.vote(decision, choice, note).catch((error: unknown) => {
			if (this.#voteCalls.get(id) !== call) return;
			this.#errors.set(
				id,
				error instanceof Error && error.message ? error.message : t("Your vote could not be saved. Try again."),
			);
			this.#everyDock();
		});
	}

	#paintVotes(current: OpenDecision): void {
		const votes = current.votes ?? [];
		const others = current.othersAnswer === true || this.#picksOwn(current);
		const hasLogin = this.#host.questions.store.get().hasLogin === true;
		const key = JSON.stringify([current.interactionId, votes, others, hasLogin, presentationLocale()]);
		if (key === this.#votesKey) return;
		this.#votesKey = key;
		this.#paintPick(current, hasLogin);
		const mine = this.#mine(current);
		const face = (userId: string) => {
			const avatar = personAvatar(this.#host.memberName(userId), userId);
			avatar.title = this.#host.memberName(userId);
			return avatar;
		};
		for (const option of this.#stage.querySelectorAll<HTMLElement>("[data-option-value]")) {
			option.querySelector(":scope > .vote-faces")?.remove();
			const voters = votes.filter((vote) => vote.choice === option.dataset.optionValue);
			if (voters.length)
				option.append(
					h(
						"span",
						{ class: "vote-faces" },
						...voters.map((vote) => face(vote.userId)),
						h(
							"span",
							{ class: "visually-hidden" },
							t("Voted for by {names}", {
								names: voters.map((vote) => this.#host.memberName(vote.userId)).join(", "),
							}),
						),
					),
				);
			if (!others) continue;
			const voted = mine?.choice === option.dataset.optionValue;
			option.classList.toggle("is-voted", voted);
			option.setAttribute("aria-pressed", String(voted));
		}
		const notes = this.#stage.querySelector<HTMLElement>(".vote-notes");
		if (notes)
			replace(
				notes,
				...votes
					.filter((vote) => vote.note)
					.map((vote) =>
						h(
							"li",
							null,
							face(vote.userId),
							h("b", null, this.#host.memberName(vote.userId)),
							h("span", null, vote.note ?? ""),
						),
					),
			);
	}

	#picksOwn(current: OpenDecision): boolean {
		return (
			current.kind === "question" &&
			!current.othersAnswer &&
			questionInput(current.request) === undefined &&
			questionOptions(current.request).length > 0 &&
			current.votes !== undefined &&
			this.#host.questions.store.get().hasLogin === false &&
			this.#host.questions.mayVote()
		);
	}

	#paintPick(current: OpenDecision, hasLogin: boolean): void {
		const place = this.#stage.querySelector<HTMLElement>(".decision-pick");
		if (!place) return;
		const pick =
			current.kind === "question" && current.othersAnswer && hasLogin && this.#host.questions.mayVote()
				? (current.votes ?? []).find((vote) => vote.userId === current.actorUserId)?.choice
				: undefined;
		const option =
			current.kind === "question" && pick !== undefined
				? questionOptions(current.request).find((candidate) => candidate.value === pick)
				: undefined;
		const painted = option ? `${current.interactionId} ${option.value}` : "";
		if (painted && painted !== this.#pickPainted && !this.#chose) this.#settlesAt = Date.now() + SETTLE_MS;
		this.#pickPainted = painted;
		if (this.#picksOwn(current)) {
			replace(
				place,
				h(
					"p",
					{ class: "decision-pick-words" },
					t(
						"You have no login here that can answer, so a tap is your pick, not an answer. A member who has one can then send your pick; tap it again to take it back.",
					),
				),
			);
			return;
		}
		const standing = current.kind === "question" && !current.othersAnswer ? this.#mine(current) : undefined;
		if (standing?.choice !== undefined) {
			replace(
				place,
				h(
					"p",
					{ class: "decision-pick-words" },
					t("Your pick stands: a member with a login can send it. Answer here yourself, or take it back."),
				),
				h(
					"button",
					{
						type: "button",
						class: "decision-pick-back",
						onclick: () => this.#vote(current, undefined, standing.note),
					},
					t("Take my pick back"),
				),
			);
			return;
		}
		if (current.kind !== "question" || !option) {
			replace(place);
			return;
		}
		const name = this.#host.memberName(current.actorUserId);
		replace(
			place,
			h(
				"p",
				{ class: "decision-pick-words" },
				t(
					"The work then runs on your login. The agent's next questions about this will come to you, and your approval rules apply.",
				),
			),
			h(
				"button",
				{
					type: "button",
					class: "decision-pick-send",
					onclick: () =>
						this.#hold({
							decision: current,
							outcome: "answered",
							value: { values: [option.value] },
							pickOf: name,
							at: Date.now(),
							state: "held",
						}),
				},
				t("Send {name}'s pick: {option}", { name, option: option.label }),
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
		const key = JSON.stringify([
			cards.map((card) => [card.interactionId, card.othersAnswer === true]),
			presentationLocale(),
		]);
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
							class: card.othersAnswer ? "decision-tab is-others" : "decision-tab",
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
		this.#byMember = true;
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
			const said = this.#host.questions.conversationState(decision.sessionId)?.interactionError;
			const pickOf = entry.decision.kind === "question" ? (entry as DecidedCard).pickOf : undefined;
			const stale =
				pickOf !== undefined &&
				error instanceof Error &&
				/Only the member this card was raised for can answer it/.test(error.message);
			const fresh = pickOf !== undefined && (await this.#host.questions.refreshAfter());
			const sent = pickOf === undefined ? undefined : (entry as DecidedCard).value.values;
			const listed = fresh ? this.#listed(id) : undefined;
			const unchanged =
				listed?.kind === "question" &&
				Array.isArray(sent) &&
				(listed.votes ?? []).find((vote) => vote.userId === listed.actorUserId)?.choice === sent[0];
			this.#errors.set(
				id,
				stale && !unchanged
					? t("Nothing was sent. {name}'s pick is not that option now. Look at their vote again.", {
							name: pickOf,
						})
					: (said ??
							(error instanceof Error && error.message
								? error.message
								: t("Your answer could not be sent. Try again."))),
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
