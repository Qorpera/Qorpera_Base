import type { MemberNotification, WebMemberNotifications } from "../../cloud/member-notifications.ts";
import { button, h } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { t } from "../../ui/preferences.ts";

type Client = Pick<WebMemberNotifications, "listNotifications" | "acknowledgeNotification">;

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
	#items: readonly MemberNotification[] = [];
	readonly #hidden = new Set<string>();
	#request: AbortController | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#acking = false;
	#drawn = "";

	constructor(client: Client, signal: AbortSignal, restoreFocus?: () => void) {
		this.#client = client;
		this.#restoreFocus = restoreFocus;
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
		} catch {
			if (signal.aborted) return;
			// Nothing stale is shown, and nothing can be dismissed, until a read succeeds.
			this.#items = [];
		} finally {
			if (this.#request === request) this.#request = undefined;
			if (!signal.aborted) this.#draw();
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
