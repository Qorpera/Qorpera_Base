import { appLinkName, appPath } from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { CloudRpcError } from "../cloud/client.ts";
import type { EmailDraftAction, EmailDraftContent, EmailDraftEditor, EmailDraftState } from "../cloud/email-drafts.ts";
import type { InteractionOutcome, InteractionRequest } from "../cloud/interactions.ts";
import { questionOptions } from "../cloud/interactions.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import {
	asOpenCards,
	type OpenApproval,
	type OpenCard,
	type OpenDecision,
	type OpenDraft,
} from "../cloud/open-decisions.ts";
import type { OpenQuestion } from "../cloud/open-questions.ts";
import type { ActionReviewAnswer } from "../cloud/review-rules.ts";
import { selectSessionExecutionSponsor } from "../cloud/session-input.ts";
import type { JsonValue } from "../cloud/types.ts";
import type { CompanyController, ConversationState } from "./company.ts";
import { Store, throttle } from "./state.ts";

/* An agent's open questions on the interface app they are about (Jonas, 10 November 2026: agents show their work in
 * apps and engage the founder in its decisions there). The question cards waiting for the member in the company's
 * agent threads (migration 20260930706000) are read while an app page or the Concepts viewer is open, and the dock on
 * that page (views/question-dock.ts) shows the ones that point at what is on screen. An answer goes the way it goes
 * in the thread (CompanyController.answerInteraction, qorpera_answer_interaction with its checks), on the member's own
 * model account for that thread. The app itself never answers: it reads only (ui/app-frame.ts).
 *
 * Which app a card points at (questionApps): an option whose preview is `app:<name>` or a picture inside
 * `apps/<name>/`, or a link `app:<name>` in the card's body. A card may point at several apps (two concepts to pick
 * from): it shows on each of their pages, and in the Concepts viewer once. */

/** The apps a question card points at. */
export function questionApps(request: InteractionRequest): ReadonlySet<string> {
	const apps = new Set<string>();
	if (request.surface !== "question") return apps;
	for (const option of questionOptions(request)) {
		if (!option.preview) continue;
		const named = /^app:(.+)$/.exec(option.preview)?.[1];
		if (named !== undefined) {
			if (isInterfaceName(named)) apps.add(named);
			continue;
		}
		const inside = appPath(option.preview);
		if (inside) apps.add(inside.name);
	}
	// A Markdown link in the body: `[the concepts](app:concepts)`.
	for (const match of (request.body ?? "").matchAll(/\]\(\s*<?([^\s)>]+)>?\s*\)/g)) {
		const name = appLinkName(match[1] ?? "");
		if (name !== undefined) apps.add(name);
	}
	return apps;
}

export interface OpenQuestionsState {
	/** Newest first, as the cloud lists them, without the ones answered here. */
	readonly questions: readonly OpenQuestion[];
	readonly decisions: readonly OpenDecision[];
	/** The first read is in. */
	readonly read: boolean;
	/** The cloud has no such read yet (before 20260930706000): nothing is asked again. */
	readonly unavailable: boolean;
	readonly hasLogin?: boolean;
}

function unsettled(editor: EmailDraftEditor): boolean {
	const status = editor.state?.status;
	return (
		(editor.busy !== undefined && editor.busy !== "load") ||
		editor.unconfirmedAction !== undefined ||
		status === "sending" ||
		status === "unconfirmed" ||
		((status === "sent" || status === "discarded") && editor.state?.notificationPending === true)
	);
}

export type QuestionAccounts = Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount">;

/** A hint in the company's conversations reads again at most this often; with none, the clock does. */
const HINT_MS = 4_000;
const HEARTBEAT_MS = 30_000;
const LOGIN_MISSING_AGAIN_MS = 10_000;
const LOGIN_AGAIN_MS = 300_000;
/** An answered card stays on screen this long, answered, before it goes (views/question-dock.ts plays it out). */
export const ANSWERED_HOLD_MS = 2_200;

export class OpenQuestions {
	readonly store = new Store<OpenQuestionsState>({ questions: [], decisions: [], read: false, unavailable: false });
	readonly #company: CompanyController;
	readonly #accounts: QuestionAccounts;
	/** Cards answered from here: a read on its way when the answer went keeps them off the list. */
	readonly #answered = new Set<string>();
	#watchers = 0;
	#stopWatching: (() => void) | undefined;
	#reads = 0;
	#source: "company" | "member" | "questions" = "company";
	#applied = 0;
	#loginReading = false;
	#loginReadAt: number | undefined;
	readonly #onTheirWay = new Set<string>();
	readonly #drafts = new Map<string, OpenDraft>();
	readonly #myVotes = new Map<
		string,
		{ choice?: string; note?: string; at: string; calls: number; sent: Promise<void>; settledAt?: number }
	>();
	#reading: Promise<void> | undefined;
	#again = false;
	/** A hint's read, at most once an interval; one still queued when the last watcher left is not made. */
	readonly #readSoon = throttle(() => {
		if (this.#watchers > 0) void this.refresh();
	}, HINT_MS);

	constructor(company: CompanyController, accounts: QuestionAccounts) {
		this.#company = company;
		this.#accounts = accounts;
	}

	/** Reads while someone looks: the first watcher starts the reads, the last one's stop ends them. */
	watch(): () => void {
		this.#watchers++;
		if (this.#watchers === 1) this.#start();
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			if (--this.#watchers === 0) {
				this.#stopWatching?.();
				this.#stopWatching = undefined;
			}
		};
	}

	/** Reads the list again: one read at a time, and one more after it when asked meanwhile. */
	refresh(): Promise<void> {
		if (this.store.get().unavailable || this.#company.signal.aborted) return Promise.resolve();
		if (this.#reading) {
			this.#again = true;
			return this.#reading;
		}
		const version = ++this.#reads;
		this.#reading = this.#list()
			.then(
				(listed) => {
					if (version !== this.#reads) return;
					this.#applied++;
					for (const [id, mine] of this.#myVotes)
						if (mine.settledAt !== undefined && version > mine.settledAt) this.#myVotes.delete(id);
					const decisions = listed
						.filter((decision) => !this.#answered.has(decision.interactionId))
						.map((decision) => this.#withMyVote(decision));
					if (decisions.some((decision) => decision.kind === "question" && decision.votes !== undefined))
						void this.readLogin();
					for (const decision of decisions)
						if (decision.kind === "draft" && !decision.othersAnswer)
							this.#drafts.set(decision.interactionId, decision);
					const current = this.store.get();
					if (!current.read || JSON.stringify(current.decisions) !== JSON.stringify(decisions)) {
						this.store.set({
							decisions,
							questions: decisions.filter(
								(decision): decision is OpenCard => decision.kind === "question" && !decision.othersAnswer,
							),
							read: true,
						});
					}
					this.#count();
				},
				(error: unknown) => {
					if (error instanceof CloudRpcError && error.missing) {
						this.store.set({ unavailable: true, questions: [], decisions: [], read: true });
						this.#count();
					}
					// Otherwise what was shown stands; the next hint or the clock reads again.
					else if (!this.store.get().read) this.store.set({ read: true });
				},
			)
			.finally(() => {
				this.#reading = undefined;
				if (this.#again && this.#watchers > 0) {
					this.#again = false;
					void this.refresh();
				}
			});
		return this.#reading;
	}

	/** Answers a card as its thread does. The card shows the answer at once (the conversation's own optimistic answer,
	 * CompanyController.answerInteraction); a refusal opens it again and says why there. */
	async answer(question: OpenQuestion, outcome: InteractionOutcome, value: Record<string, JsonValue>): Promise<void> {
		await this.#chooseAccount(question.sessionId);
		await this.#company.answerInteraction(question.sessionId, question.interactionId, outcome, value);
		this.#answered.add(question.interactionId);
	}

	async answerApproval(approval: OpenApproval, answer: ActionReviewAnswer, ruleText?: string): Promise<void> {
		await this.#chooseAccount(approval.sessionId);
		await this.#company.answerActionReview(approval.sessionId, approval.interactionId, answer, ruleText);
		this.#answered.add(approval.interactionId);
	}

	draftEditor(draft: OpenDraft): EmailDraftEditor {
		return this.#company.emailDraftEditor(draft.interactionId);
	}

	draftUnsettled(draft: OpenDraft): boolean {
		return unsettled(this.draftEditor(draft));
	}

	unsettledDrafts(): OpenDraft[] {
		const listed = new Set(this.store.get().decisions.map((decision) => decision.interactionId));
		const kept: OpenDraft[] = [];
		for (const [id, draft] of this.#drafts) {
			if (listed.has(id)) continue;
			if (this.draftUnsettled(draft)) kept.push(draft);
			else this.#drafts.delete(id);
		}
		return kept;
	}

	async loadDraft(draft: OpenDraft): Promise<EmailDraftState> {
		const state = await this.#company.loadEmailDraft(draft.sessionId, draft.interactionId);
		if (!state.notificationPending) return state;
		await this.#chooseAccount(draft.sessionId);
		return this.#company.loadEmailDraft(draft.sessionId, draft.interactionId);
	}

	async actDraft(draft: OpenDraft, action: EmailDraftAction, content: EmailDraftContent): Promise<EmailDraftState> {
		await this.#chooseAccount(draft.sessionId);
		return this.#company.actEmailDraft(draft.sessionId, draft.interactionId, action, content);
	}

	async refreshAfter(): Promise<boolean> {
		if (this.#reading) await this.#reading;
		const before = this.#applied;
		await this.refresh();
		return this.#applied > before;
	}

	async readLogin(): Promise<void> {
		const wait = this.store.get().hasLogin === true ? LOGIN_AGAIN_MS : LOGIN_MISSING_AGAIN_MS;
		if (this.#loginReading || !this.#accounts.listConnections) return;
		if (this.#loginReadAt !== undefined && Date.now() - this.#loginReadAt < wait) return;
		this.#loginReading = true;
		try {
			const observed = await this.#accounts.listConnections(this.#company.signal);
			const userId = this.#company.userId;
			this.store.set({
				hasLogin: observed.connections.some((connection) => {
					try {
						selectSessionExecutionSponsor(observed, connection.connectionId, userId);
						return true;
					} catch {
						return false;
					}
				}),
			});
			this.#loginReadAt = Date.now();
		} catch {
			this.#loginReadAt = undefined;
		} finally {
			this.#loginReading = false;
		}
	}

	get viewerId(): string {
		return this.#company.userId;
	}

	mayVote(): boolean {
		return this.#company.store.get().team?.capabilities.write === true;
	}

	async vote(decision: OpenDecision, choice: string | undefined, note: string | undefined): Promise<void> {
		const id = decision.interactionId;
		const before = this.#myVotes.get(id);
		const calls = (before?.calls ?? 0) + 1;
		const sent = (before?.sent ?? Promise.resolve()).then(() => this.#company.castDecisionVote(id, choice, note));
		this.#myVotes.set(id, {
			...(choice === undefined ? {} : { choice }),
			...(note === undefined ? {} : { note }),
			at: new Date().toISOString(),
			calls,
			sent: sent.then(
				() => {},
				() => {},
			),
		});
		this.store.set({ decisions: this.store.get().decisions.map((listed) => this.#withMyVote(listed)) });
		try {
			await sent;
		} catch (error) {
			if (this.#myVotes.get(id)?.calls === calls) this.#myVotes.delete(id);
			void this.refresh();
			throw error;
		}
		const mine = this.#myVotes.get(id);
		if (mine?.calls === calls) this.#myVotes.set(id, { ...mine, settledAt: this.#reads });
		void this.refresh();
	}

	#withMyVote(decision: OpenDecision): OpenDecision {
		const mine = this.#myVotes.get(decision.interactionId);
		if (!mine) return decision;
		const userId = this.#company.userId;
		return {
			...decision,
			votes: [
				...(decision.votes ?? []).filter((vote) => vote.userId !== userId),
				...(mine.choice === undefined && mine.note === undefined
					? []
					: [
							{
								userId,
								...(mine.choice === undefined ? {} : { choice: mine.choice }),
								...(mine.note === undefined ? {} : { note: mine.note }),
								updatedAt: mine.at,
							},
						]),
			],
		};
	}

	forget(interactionId: string): void {
		this.#answered.add(interactionId);
		const { questions, decisions } = this.store.get();
		if (this.#drafts.delete(interactionId)) this.#count();
		if (!decisions.some((decision) => decision.interactionId === interactionId)) return;
		const left = decisions.filter((decision) => decision.interactionId !== interactionId);
		this.store.set({
			questions: questions.filter((question) => question.interactionId !== interactionId),
			decisions: left,
		});
		this.#onTheirWay.delete(interactionId);
		this.#count();
	}

	hold(interactionId: string): void {
		this.#onTheirWay.add(interactionId);
		this.#count();
	}

	release(interactionId: string): void {
		this.#onTheirWay.delete(interactionId);
		this.#count();
	}

	#count(): void {
		this.#company.setOpenDecisions(
			this.store
				.get()
				.decisions.filter((decision) => !decision.othersAnswer && !this.#onTheirWay.has(decision.interactionId))
				.length + this.unsettledDrafts().length,
		);
	}

	async #list(): Promise<OpenDecision[]> {
		if (this.#source === "company") {
			try {
				return await this.#company.listCompanyOpenDecisions();
			} catch (error) {
				if (!(error instanceof CloudRpcError && error.missing)) throw error;
				this.#source = "member";
			}
		}
		if (this.#source === "member") {
			try {
				return await this.#company.listOpenDecisions();
			} catch (error) {
				if (!(error instanceof CloudRpcError && error.missing)) throw error;
				this.#source = "questions";
			}
		}
		return asOpenCards(await this.#company.listOpenQuestions());
	}

	dispose(): void {
		this.#stopWatching?.();
		this.#stopWatching = undefined;
		this.#watchers = 0;
		this.store.dispose();
	}

	#start(): void {
		void this.refresh();
		const stopHints = this.#company.onInvalidate((resource) => {
			if (resource === "sessions") this.#readSoon();
		});
		let connectedTick = 0;
		const clock = setInterval(() => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			// WHY: Sessions Realtime hints drive live updates; back off connected fallback polls from 30s to 2m.
			if (this.#company.store.get().realtime === "connected") {
				if (++connectedTick % 4 !== 0) return;
			} else {
				connectedTick = 0;
			}
			void this.refresh();
		}, HEARTBEAT_MS);
		const mayWrite = () => {
			const capabilities = this.#company.store.get().team?.capabilities;
			return `${capabilities?.read === true} ${capabilities?.write === true}`;
		};
		let could = mayWrite();
		const stopTeam = this.#company.store.subscribe(() => {
			const can = mayWrite();
			if (can === could) return;
			could = can;
			void this.refresh();
		});
		this.#stopWatching = () => {
			stopHints();
			stopTeam();
			clearInterval(clock);
		};
	}

	/** WHY: peeks an already-cached thread without creating or loading a new store so docks do not churn LRU. */
	conversationState(sessionId: string): ConversationState | undefined {
		return this.#company.conversations.get(sessionId)?.get();
	}

	/** Gives the thread the model account the cloud chooses for it now, as the thread does when it opens and as Mailbox
	 * does (app/company-mail.ts): the conversation's own account, never another, read afresh each time so a change made
	 * elsewhere (another tab, a replaced login) is followed. A message on its way keeps the account it carries. */
	async #chooseAccount(sessionId: string): Promise<void> {
		const conversation = this.#company.conversation(sessionId, false).get();
		if (conversation.sending || conversation.retrySend || !this.#accounts.selectSessionAccount) return;
		const signal = this.#company.signal;
		try {
			const connectionId = await this.#accounts.selectSessionAccount(sessionId, signal);
			if (!connectionId) return;
			const observed = await this.#accounts.listConnections(signal);
			const now = this.#company.conversation(sessionId, false).get();
			if (now.sending || now.retrySend) return;
			this.#company.setExecutionSponsor(sessionId, observed, connectionId);
		} catch {
			// The answer says what is missing (no account for this thread).
		}
	}
}
