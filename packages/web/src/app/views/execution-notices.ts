import type { CompanyExecutionNotification, WebCompanyExecution } from "../../cloud/company-execution.ts";
import { button, h } from "../../ui/dom.ts";
import { notification, updateNotification } from "../../ui/notification.ts";

type Client = Pick<WebCompanyExecution, "listNotifications" | "acknowledgeNotification">;

function title(item: CompanyExecutionNotification): string {
	const subject = item.subject;
	switch (subject.schema) {
		case "qorpera.member-notification.provider-usage-limit/v1":
			return "Model account usage limit reached";
		case "qorpera.member-notification.company-ceiling-tripped/v1":
			return "Company execution limit reached";
		case "qorpera.member-notification.machine-capacity/v1":
			return "Company computer limit reached";
		case "qorpera.member-notification.company-execution-stop/v1":
			return subject.paused ? "Company execution paused" : "Company execution resumed";
		case "qorpera.member-notification.sponsor-handoff/v1":
			return "Execution sponsor changed";
	}
}

/** Member-addressed runtime notices stay in the company workspace until explicitly
 * acknowledged. Polling never acknowledges, replays a write or steals focus. */
export class ExecutionNotices {
	readonly el = h("section", { class: "execution-notices", "aria-label": "Company execution updates", hidden: true });
	readonly #client: Client;
	readonly #lifetime = new AbortController();
	readonly #restoreFocus: (() => void) | undefined;
	#items: readonly CompanyExecutionNotification[] = [];
	readonly #hidden = new Set<string>();
	#hiddenError: string | undefined;
	#request: AbortController | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#acking = false;
	#refreshRequired = false;
	#error: string | undefined;
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
			this.#items = items.filter((item) => !item.acknowledgedAt);
			this.#refreshRequired = false;
			this.#error = undefined;
			this.#hiddenError = undefined;
		} catch {
			if (signal.aborted) return;
			this.#items = [];
			this.#refreshRequired = true;
			this.#error = "Company updates are unavailable";
		} finally {
			if (this.#request === request) this.#request = undefined;
			if (!signal.aborted) this.#draw();
		}
	}

	async #acknowledge(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#acking || this.#refreshRequired) return;
		const item = this.#items.find((entry) => !this.#hidden.has(entry.notificationId));
		if (!item) return;
		this.#request?.abort();
		this.#request = undefined;
		this.#acking = true;
		this.#error = undefined;
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
			this.#items = this.#items.filter((entry) => entry.notificationId !== item.notificationId);
			this.#hidden.add(item.notificationId);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#refreshRequired = true;
			this.#error = "Dismissal could not be confirmed";
		} finally {
			this.#acking = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}

	#draw(): void {
		const item = this.#items.find((entry) => !this.#hidden.has(entry.notificationId));
		const error = this.#error && this.#error !== this.#hiddenError ? this.#error : undefined;
		const key = JSON.stringify([item?.notificationId, item?.subject, this.#acking, error]);
		if (key === this.#drawn) return;
		const focused = this.el.contains(document.activeElement)
			? (document.activeElement as HTMLElement).dataset.action
			: undefined;
		const refresh = error ? button("Refresh", () => void this.refresh(), { small: true }) : undefined;
		if (refresh) refresh.dataset.action = "refresh";
		const dismiss = () => {
			if (error || this.#refreshRequired) {
				this.#hiddenError = this.#error;
				if (item) this.#hidden.add(item.notificationId);
				this.#draw();
			} else void this.#acknowledge();
		};
		updateNotification(
			this.el,
			error || item
				? notification(error ?? title(item!), dismiss, {
						busy: this.#acking,
						action: refresh,
						error: Boolean(error),
					})
				: null,
			error ? `error:${error}` : item?.notificationId,
			this.#lifetime.signal,
		);
		if (focused) {
			const target = this.el.hidden
				? null
				: (this.el.querySelector<HTMLElement>(`[data-action="${focused}"]`) ??
					this.el.querySelector<HTMLElement>("button[data-action]:not([aria-disabled='true'])"));
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
