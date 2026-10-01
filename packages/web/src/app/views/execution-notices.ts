import type { MemberNotification, WebMemberNotifications } from "../../cloud/member-notifications.ts";
import { planLogin, type WebMemberConnection, type WebNativeSubscription } from "../../cloud/native-subscription.ts";
import type { WebRoutine, WebRoutines } from "../../cloud/routines.ts";
import { button, h } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { t } from "../../ui/preferences.ts";

type Client = Pick<WebMemberNotifications, "listNotifications" | "acknowledgeNotification">;
/** What the band needs to ask a ChatGPT plan's member to turn on work while away (Sign in with ChatGPT). */
export interface PlanOffer {
	native: Pick<WebNativeSubscription, "listConnections"> &
		Required<Pick<WebNativeSubscription, "setWorkWhileAway" | "recordRoutineOffer" | "chatGptPlanAvailable">>;
	routines: Pick<WebRoutines, "list" | "setEnabled">;
	/** The signed-in member: the card restarts only routines that run for them. */
	memberId: string;
	/** Owners and admins save routines; for anyone else the card turns the plan on and says what is next. */
	canManage: () => boolean;
}
/** The card while it stands: the notices that raised it, the member's waiting routines, the plan. */
interface Offer {
	notices: readonly Waiting[];
	routines: readonly WebRoutine[];
	plan: WebMemberConnection;
}
/** A routine of this member that waits for a payer a plan can be: never a file-change or webhook routine. */
const waitsForPlan = (routine: WebRoutine, memberId: string) =>
	routine.status === "paused" &&
	routine.pauseReason === "needs_model_account" &&
	routine.runsForUserId === memberId &&
	!routine.triggers.some((trigger) => trigger.kind === "listener");
type Waiting = MemberNotification & {
	subject: { schema: "routine-needs-model-account"; routineId: string; title: string };
};
const waiting = (item: MemberNotification): item is Waiting => item.subject.schema === "routine-needs-model-account";
/** The member's ChatGPT plan that may be offered: signed in, not turned on, its card not shown
 * before (or shown, and not answered, in this window). Undefined for every member without a plan login. */
function offerable(
	connections: readonly WebMemberConnection[],
	offered: ReadonlySet<string>,
	answered: ReadonlySet<string>,
) {
	const newest = new Map<string, WebMemberConnection>();
	for (const item of connections) {
		const current = newest.get(item.connectionId);
		if (!current || current.connectionVersion < item.connectionVersion) newest.set(item.connectionId, item);
	}
	return [...newest.values()].find(
		(item) =>
			planLogin(item) &&
			item.connectionStatus === "active" &&
			item.authorizationState === "active" &&
			item.allowAutonomous !== true &&
			!answered.has(item.connectionId) &&
			(!item.routineOfferShownAt || offered.has(item.connectionId)),
	);
}

/** What a notice tells the member, in plain words; undefined when it gets no line.
 * A reached usage limit is told by the failed run's card in the thread. A changed
 * sponsor asks nothing of the member. */
function sentence(item: MemberNotification): string | undefined {
	const subject = item.subject;
	switch (subject.schema) {
		case "qorpera.member-notification.provider-usage-limit/v1":
		case "qorpera.member-notification.sponsor-handoff/v1":
			return undefined;
		case "qorpera.member-notification.machine-capacity/v1":
			return t("All {count} company computers are in use. Close one to open another.", { count: subject.ceiling });
		case "routine-needs-model-account":
			// Only a ChatGPT plan's member is asked, once, by the plan card below.
			return undefined;
	}
}

/** The unacknowledged notices that get a line. */
function told(items: readonly MemberNotification[]): MemberNotification[] {
	return items.filter((item) => !item.acknowledgedAt && sentence(item) !== undefined);
}

/** Member-addressed runtime notices are one quiet line above the composer, never a
 * popup, and stay until explicitly dismissed. Polling never acknowledges, replays a
 * write or steals focus. A failed read or an unconfirmed dismissal shows nothing: the
 * line returns with the next good read if the notice still stands. */
export class ExecutionNotices {
	readonly el = h("section", { class: "execution-notices", "aria-label": t("Company updates"), hidden: true });
	readonly #client: Client;
	readonly #lifetime = new AbortController();
	readonly #restoreFocus: (() => void) | undefined;
	readonly #plan: PlanOffer | undefined;
	#items: readonly MemberNotification[] = [];
	#offer: Offer | undefined;
	/** Plans whose card this window showed (and recorded): it stays until answered here. */
	readonly #offered = new Set<string>();
	/** Plans answered in this window (Turn on or Not now): their card never comes back. */
	readonly #answered = new Set<string>();
	/** Plans this window turned on: a retry after a failed routine save does not turn them on again. */
	readonly #turnedOn = new Set<string>();
	/** The waiting notices last read with nothing to offer: the next poll reads no more unless they change. */
	#offerChecked = "";
	#offerBusy: "on" | "not-now" | undefined;
	#offerError: string | undefined;
	/** After Turn on, for a member who does not save routines: what to do next. */
	#offerDone: string | undefined;
	readonly #hidden = new Set<string>();
	#request: AbortController | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#acking = false;
	#drawn = "";

	constructor(client: Client, signal: AbortSignal, restoreFocus?: () => void, plan?: PlanOffer) {
		this.#client = client;
		this.#restoreFocus = restoreFocus;
		this.#plan = plan;
		if (signal.aborted) {
			this.dispose();
			return;
		}
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		for (const event of ["focus", "online"])
			window.addEventListener(event, () => void this.refresh(), { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", () => void this.refresh(), { signal: this.#lifetime.signal });
		this.#timer = setInterval(() => void this.refresh(), 30_000);
		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (
			this.#lifetime.signal.aborted ||
			this.#request ||
			this.#acking ||
			this.#offerBusy ||
			document.visibilityState === "hidden"
		)
			return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		try {
			const items = await this.#client.listNotifications(signal);
			if (signal.aborted) return;
			this.#items = told(items);
			// The plan card has its own reads; a failed one hides only the card, and the next poll reads again.
			if (!this.#offerDone)
				this.#offer = await this.#readOffer(items, signal).catch((error: unknown) => {
					if (signal.aborted) throw error;
					this.#offerChecked = "";
					return undefined;
				});
		} catch {
			if (signal.aborted) return;
			// Nothing stale is shown, and nothing can be dismissed, until a read succeeds. A card shown
			// before comes back then: its plan is still offered in this window.
			this.#items = [];
			this.#offer = undefined;
			this.#offerChecked = "";
		} finally {
			if (this.#request === request) this.#request = undefined;
			if (!signal.aborted) this.#draw();
		}
	}

	/** An agent's routine waits for this member's account, and the member has a ChatGPT plan they have not
	 * turned on, while plans are on: the card asks them once. Members without a plan login never get here. */
	async #readOffer(items: readonly MemberNotification[], signal: AbortSignal): Promise<Offer | undefined> {
		const plan = this.#plan;
		const notices = items.filter(
			(item): item is Waiting => !item.acknowledgedAt && waiting(item) && !this.#hidden.has(item.notificationId),
		);
		if (!plan || !notices.length) return undefined;
		const key = notices
			.map((item) => item.notificationId)
			.sort()
			.join();
		if (this.#offer && key === this.#offerChecked) return this.#offer;
		if (key === this.#offerChecked) return undefined;
		this.#offerChecked = key;
		if (!(await plan.native.chatGptPlanAvailable(signal))) return undefined;
		const connection = offerable(
			(await plan.native.listConnections(signal)).connections,
			this.#offered,
			this.#answered,
		);
		if (!connection) return undefined;
		const routines = (await plan.routines.list()).filter((routine) => waitsForPlan(routine, plan.memberId));
		return routines.length ? { notices, routines, plan: connection } : undefined;
	}

	/** Turns on work while away for the plan, then (for an owner or admin) saves each waiting routine on it
	 * again; anyone else is told to ask the agent. */
	async #turnOn(): Promise<void> {
		const offer = this.#offer;
		const plan = this.#plan;
		if (this.#lifetime.signal.aborted || this.#acking || this.#offerBusy || !offer || !plan) return;
		const signal = this.#lifetime.signal;
		const id = offer.plan.connectionId;
		this.#request?.abort();
		this.#request = undefined;
		this.#offerBusy = "on";
		this.#offerError = undefined;
		this.#draw();
		try {
			if (!this.#turnedOn.has(id)) {
				await plan.native.setWorkWhileAway(id, true, signal);
				this.#turnedOn.add(id);
			}
			this.#answered.add(id);
			if (plan.canManage()) {
				const account = (await plan.native.listConnections(signal)).connections
					.filter((item) => item.connectionId === id && item.allowAutonomous === true)
					.sort((a, b) => b.connectionVersion - a.connectionVersion)[0];
				if (!account) throw new Error("The plan did not turn on");
				// Each routine that waits now, read again: one the agent paused, concluded or removed stays as it
				// is, and one set up while the card stood starts too.
				for (const routine of (await plan.routines.list()).filter((entry) => waitsForPlan(entry, plan.memberId)))
					await plan.routines.setEnabled(routine, account, true, crypto.randomUUID());
			} else
				this.#offerDone =
					offer.routines.length === 1
						? t("Your ChatGPT plan now works while you're away. Ask the agent to set {title} up again.", {
								title: offer.routines[0]!.title,
							})
						: new Set(offer.routines.map((routine) => routine.staffAgentId)).size > 1
							? t(
									"Your ChatGPT plan now works while you're away. Ask the agents to set those routines up again.",
								)
							: t(
									"Your ChatGPT plan now works while you're away. Ask the agent to set those routines up again.",
								);
			for (const item of offer.notices) {
				await this.#client.acknowledgeNotification(item.notificationId, signal).catch(() => undefined);
				this.#hidden.add(item.notificationId);
			}
			if (!this.#offerDone) this.#offer = undefined;
		} catch {
			if (!signal.aborted)
				this.#offerError = !this.#turnedOn.has(id)
					? t("“Work while you're away” could not be turned on. Try again.")
					: offer.routines.length > 1
						? t("“Work while you're away” is on, but the routines could not be started. Try again.")
						: t("“Work while you're away” is on, but the routine could not be started. Try again.");
		} finally {
			this.#offerBusy = undefined;
			if (!signal.aborted) this.#draw();
		}
	}

	/** "Not now": the routines keep waiting, and the card never comes back. */
	async #notNow(): Promise<void> {
		const offer = this.#offer;
		if (this.#lifetime.signal.aborted || this.#acking || this.#offerBusy || !offer) return;
		this.#request?.abort();
		this.#request = undefined;
		this.#offerBusy = "not-now";
		this.#answered.add(offer.plan.connectionId);
		this.#draw();
		for (const item of offer.notices) {
			await this.#client.acknowledgeNotification(item.notificationId, this.#lifetime.signal).catch(() => undefined);
			this.#hidden.add(item.notificationId);
		}
		this.#offerBusy = undefined;
		if (!this.#lifetime.signal.aborted) {
			this.#offer = undefined;
			this.#draw();
		}
	}

	/** Closes the line that says what to do next. */
	#closeDone(): void {
		this.#offerDone = undefined;
		this.#offer = undefined;
		this.#draw();
	}

	async #acknowledge(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#acking) return;
		const item = this.#items.find((entry) => !this.#hidden.has(entry.notificationId));
		if (!item) return;
		this.#request?.abort();
		this.#request = undefined;
		this.#acking = true;
		this.#draw();
		try {
			const receipt = await this.#client.acknowledgeNotification(item.notificationId, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			if (
				receipt.notificationId !== item.notificationId ||
				receipt.profileId !== item.profileId ||
				!receipt.acknowledgedAt
			)
				throw new Error("Notification receipt mismatch");
		} catch {
			// The write is never replayed. The line stays closed in this window either way.
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#hidden.add(item.notificationId);
				this.#acking = false;
				this.#draw();
			}
		}
	}

	#draw(): void {
		if (this.#offer) {
			this.#drawOffer(this.#offer);
			return;
		}
		const item = this.#items.find((entry) => !this.#hidden.has(entry.notificationId));
		const text = item && sentence(item);
		const key = JSON.stringify([item?.notificationId, text, this.#acking]);
		if (key === this.#drawn) return;
		const focused = this.el.contains(document.activeElement);
		if (text) {
			const dismiss = button(t("Dismiss"), (event) => event.detail < 2 && void this.#acknowledge(), {
				small: true,
			});
			dismiss.dataset.action = "dismiss-notification";
			if (this.#acking) dismiss.setAttribute("aria-disabled", "true");
			this.el.replaceChildren(
				h(
					"div",
					{
						class: "company-notice",
						role: "status",
						onkeydown: (event: KeyboardEvent) => {
							if (!matchesKey(event, "dismiss")) return;
							event.preventDefault();
							event.stopPropagation();
							void this.#acknowledge();
						},
					},
					h("p", null, text),
					dismiss,
				),
			);
		} else this.el.replaceChildren();
		this.el.hidden = !text;
		if (focused) {
			const target = this.el.querySelector<HTMLElement>("button[data-action]");
			if (target) target.focus({ preventScroll: true });
			else this.#restoreFocus?.();
		}
		this.#drawn = key;
	}

	/** The plan card, in the notice's shape: what waits, and Turn on or Not now. Showing it, on a page
	 * the member can see, records the showing, so it comes once per member. */
	#drawOffer(offer: Offer): void {
		const first = offer.routines[0]!;
		const key = JSON.stringify([
			"plan",
			offer.plan.connectionId,
			offer.routines.map((routine) => routine.routineId),
			this.#offerBusy,
			this.#offerError,
			this.#offerDone,
		]);
		if (
			!this.#offered.has(offer.plan.connectionId) &&
			this.el.isConnected &&
			document.visibilityState === "visible"
		) {
			this.#offered.add(offer.plan.connectionId);
			void this.#plan?.native
				.recordRoutineOffer(offer.plan.connectionId, this.#lifetime.signal)
				.catch(() => undefined);
		}
		if (key === this.#drawn) return;
		const focused = this.el.contains(document.activeElement);
		const card = (text: (Node | string | null)[], ...actions: HTMLElement[]) =>
			h(
				"div",
				{
					class: "company-notice",
					role: "status",
					onkeydown: (event: KeyboardEvent) => {
						if (!matchesKey(event, "dismiss")) return;
						event.preventDefault();
						event.stopPropagation();
						if (this.#offerDone) this.#closeDone();
						else void this.#notNow();
					},
				},
				h("p", null, ...text),
				...actions,
			);
		if (this.#offerDone) {
			const close = button(t("Dismiss"), (event) => event.detail < 2 && this.#closeDone(), { small: true });
			close.dataset.action = "dismiss-plan";
			this.el.replaceChildren(card([this.#offerDone], close));
		} else {
			const turnOn = button(
				this.#offerBusy === "on" ? t("Turning on…") : t("Turn on"),
				(event) => event.detail < 2 && void this.#turnOn(),
				{ small: true, primary: true },
			);
			turnOn.dataset.action = "turn-on-plan";
			const notNow = button(t("Not now"), (event) => event.detail < 2 && void this.#notNow(), { small: true });
			notNow.dataset.action = "not-now-plan";
			if (this.#offerBusy) for (const item of [turnOn, notNow]) item.setAttribute("aria-disabled", "true");
			this.el.replaceChildren(
				card(
					[
						offer.routines.length > 1
							? t("{count} routines can run while you're away.", { count: offer.routines.length })
							: t("{title} can run while you're away.", { title: first.title }),
						" ",
						offer.routines.length > 1
							? t("Turn on “Work while you're away” so your ChatGPT plan can run them.")
							: t("Turn on “Work while you're away” so your ChatGPT plan can run it."),
						this.#offerError ? " " : null,
						this.#offerError ? h("span", { role: "alert" }, this.#offerError) : null,
					],
					turnOn,
					notNow,
				),
			);
		}
		this.el.hidden = false;
		if (focused) this.el.querySelector<HTMLElement>("button[data-action]")?.focus({ preventScroll: true });
		this.#drawn = key;
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		clearInterval(this.#timer);
		this.#items = [];
		this.el.replaceChildren();
		this.el.hidden = true;
		this.el.remove();
	}
}
