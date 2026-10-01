import type { MemberNotification, WebMemberNotifications } from "../../cloud/member-notifications.ts";
import { planLogin, type WebMemberConnection, type WebNativeSubscription } from "../../cloud/native-subscription.ts";
import type { WebRoutines } from "../../cloud/routines.ts";
import { button, h } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { t } from "../../ui/preferences.ts";

type Client = Pick<WebMemberNotifications, "listNotifications" | "acknowledgeNotification">;
/** What the band needs to ask a ChatGPT plan's member to turn on work while away (Sign in with ChatGPT). */
export interface PlanOffer {
	native: Pick<WebNativeSubscription, "listConnections"> &
		Required<Pick<WebNativeSubscription, "setWorkWhileAway" | "recordRoutineOffer">>;
	routines: Pick<WebRoutines, "list" | "setEnabled">;
}
type Waiting = MemberNotification & {
	subject: { schema: "routine-needs-model-account"; routineId: string; title: string };
};
const waiting = (item: MemberNotification): item is Waiting => item.subject.schema === "routine-needs-model-account";
/** The member's ChatGPT plan that may be offered: signed in, not turned on, its card not shown
 * before (or shown in this window). Undefined for every member without a plan login. */
function offerable(connections: readonly WebMemberConnection[], offered: ReadonlySet<string>) {
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
	/** Routines waiting for this member's plan, and the plan, while its card stands. */
	#offer: { items: readonly Waiting[]; plan: WebMemberConnection } | undefined;
	/** Plans whose card this window showed (and recorded): it stays until answered here. */
	readonly #offered = new Set<string>();
	#offerError: string | undefined;
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
		if (this.#lifetime.signal.aborted || this.#request || this.#acking || document.visibilityState === "hidden")
			return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		try {
			const items = await this.#client.listNotifications(signal);
			if (signal.aborted) return;
			this.#items = told(items);
			this.#offer = await this.#readOffer(items, signal);
		} catch {
			if (signal.aborted) return;
			// Nothing stale is shown, and nothing can be dismissed, until a read succeeds.
			this.#items = [];
			this.#offer = undefined;
		} finally {
			if (this.#request === request) this.#request = undefined;
			if (!signal.aborted) this.#draw();
		}
	}

	/** A routine waits for its member's account, and the member has a ChatGPT plan they have not
	 * turned on: the card asks them once. Members without a plan login never get here. */
	async #readOffer(items: readonly MemberNotification[], signal: AbortSignal) {
		const routines = items.filter(
			(item): item is Waiting => !item.acknowledgedAt && waiting(item) && !this.#hidden.has(item.notificationId),
		);
		if (!this.#plan || !routines.length) return undefined;
		const plan = offerable((await this.#plan.native.listConnections(signal)).connections, this.#offered);
		return plan ? { items: routines, plan } : undefined;
	}

	/** Turns on work while away for the plan, then saves each waiting routine on it again. */
	async #turnOn(): Promise<void> {
		const offer = this.#offer;
		if (this.#lifetime.signal.aborted || this.#acking || !offer || !this.#plan) return;
		const signal = this.#lifetime.signal;
		this.#request?.abort();
		this.#request = undefined;
		this.#acking = true;
		this.#offerError = undefined;
		this.#draw();
		try {
			await this.#plan.native.setWorkWhileAway(offer.plan.connectionId, true, signal);
			const account = (await this.#plan.native.listConnections(signal)).connections
				.filter((item) => item.connectionId === offer.plan.connectionId && item.allowAutonomous === true)
				.sort((a, b) => b.connectionVersion - a.connectionVersion)[0];
			if (!account) throw new Error("The plan did not turn on");
			const routines = await this.#plan.routines.list();
			for (const item of offer.items) {
				const routine = routines.find((entry) => entry.routineId === item.subject.routineId);
				if (routine) await this.#plan.routines.setEnabled(routine, account, true, crypto.randomUUID());
				await this.#client.acknowledgeNotification(item.notificationId, signal).catch(() => undefined);
				this.#hidden.add(item.notificationId);
			}
			this.#offer = undefined;
		} catch {
			if (!signal.aborted) this.#offerError = t("“Work while you're away” could not be turned on. Try again.");
		} finally {
			if (!signal.aborted) {
				this.#acking = false;
				this.#draw();
			}
		}
	}

	/** "Not now": the routines keep waiting, and the card never comes back. */
	async #notNow(): Promise<void> {
		const offer = this.#offer;
		if (this.#lifetime.signal.aborted || this.#acking || !offer) return;
		this.#request?.abort();
		this.#request = undefined;
		this.#acking = true;
		this.#draw();
		for (const item of offer.items) {
			await this.#client.acknowledgeNotification(item.notificationId, this.#lifetime.signal).catch(() => undefined);
			this.#hidden.add(item.notificationId);
		}
		if (!this.#lifetime.signal.aborted) {
			this.#offer = undefined;
			this.#acking = false;
			this.#draw();
		}
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

	/** The plan card, in the notice's shape: what waits, and Turn on or Not now. Showing it records
	 * the showing, so it comes once per member. */
	#drawOffer(offer: { items: readonly Waiting[]; plan: WebMemberConnection }): void {
		const first = offer.items[0]!;
		const key = JSON.stringify([
			"plan",
			offer.plan.connectionId,
			first.notificationId,
			this.#acking,
			this.#offerError,
		]);
		if (key === this.#drawn) return;
		if (!this.#offered.has(offer.plan.connectionId)) {
			this.#offered.add(offer.plan.connectionId);
			void this.#plan?.native
				.recordRoutineOffer(offer.plan.connectionId, this.#lifetime.signal)
				.catch(() => undefined);
		}
		const focused = this.el.contains(document.activeElement);
		const turnOn = button(
			this.#acking ? t("Turning on…") : t("Turn on"),
			(event) => event.detail < 2 && void this.#turnOn(),
			{ small: true, primary: true },
		);
		turnOn.dataset.action = "turn-on-plan";
		const notNow = button(t("Not now"), (event) => event.detail < 2 && void this.#notNow(), { small: true });
		notNow.dataset.action = "not-now-plan";
		if (this.#acking) for (const item of [turnOn, notNow]) item.setAttribute("aria-disabled", "true");
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
						void this.#notNow();
					},
				},
				h(
					"p",
					null,
					offer.items.length > 1
						? t("{count} routines can run while you're away.", { count: offer.items.length })
						: t("{title} can run while you're away.", { title: first.subject.title }),
					" ",
					t("Turn on “Work while you're away” so your ChatGPT plan can run it."),
					this.#offerError ? " " : null,
					this.#offerError ? h("span", { role: "alert" }, this.#offerError) : null,
				),
				turnOn,
				notNow,
			),
		);
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
