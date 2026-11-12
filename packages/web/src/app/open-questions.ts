import { appLinkName, appPath } from "@qorpera/cloud-client/interface-apps";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { CloudRpcError } from "../cloud/client.ts";
import type { InteractionOutcome, InteractionRequest } from "../cloud/interactions.ts";
import { questionOptions } from "../cloud/interactions.ts";
import type { WebNativeSubscription } from "../cloud/native-subscription.ts";
import type { OpenQuestion } from "../cloud/open-questions.ts";
import type { JsonValue } from "../cloud/types.ts";
import type { CompanyController } from "./company.ts";
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
	/** The first read is in. */
	readonly read: boolean;
	/** The cloud has no such read yet (before 20260930706000): nothing is asked again. */
	readonly unavailable: boolean;
}

export type QuestionAccounts = Pick<WebNativeSubscription, "listConnections" | "selectSessionAccount">;

/** A hint in the company's conversations reads again at most this often; with none, the clock does. */
const HINT_MS = 4_000;
const HEARTBEAT_MS = 30_000;
/** An answered card stays on screen this long, answered, before it goes (views/question-dock.ts plays it out). */
export const ANSWERED_HOLD_MS = 2_200;

export class OpenQuestions {
	readonly store = new Store<OpenQuestionsState>({ questions: [], read: false, unavailable: false });
	readonly #company: CompanyController;
	readonly #accounts: QuestionAccounts;
	/** Cards answered from here: a read on its way when the answer went keeps them off the list. */
	readonly #answered = new Set<string>();
	#watchers = 0;
	#stopWatching: (() => void) | undefined;
	#reads = 0;
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
		this.#reading = this.#company
			.listOpenQuestions()
			.then(
				(questions) => {
					if (version !== this.#reads) return;
					this.store.set({
						questions: questions.filter((question) => !this.#answered.has(question.interactionId)),
						read: true,
					});
				},
				(error: unknown) => {
					if (error instanceof CloudRpcError && error.missing)
						this.store.set({ unavailable: true, questions: [], read: true });
					// Otherwise what was shown stands; the next hint or the clock reads again.
					else this.store.set({ read: true });
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

	/** An answered card leaves the list (after the dock showed it answered). */
	forget(interactionId: string): void {
		this.#answered.add(interactionId);
		const { questions } = this.store.get();
		if (questions.some((question) => question.interactionId === interactionId))
			this.store.set({ questions: questions.filter((question) => question.interactionId !== interactionId) });
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
		const clock = setInterval(() => {
			if (typeof document === "undefined" || document.visibilityState !== "hidden") void this.refresh();
		}, HEARTBEAT_MS);
		this.#stopWatching = () => {
			stopHints();
			clearInterval(clock);
		};
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
