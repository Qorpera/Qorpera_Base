import type { CompanyExecutionNotification, WebCompanyExecution } from "../../cloud/company-execution.ts";
import { fmtTime, h, replace } from "../../ui/dom.ts";

type Client = Pick<WebCompanyExecution, "listNotifications" | "acknowledgeNotification">;

function copy(item: CompanyExecutionNotification): { title: string; detail: string } {
	const subject = item.subject;
	switch (subject.schema) {
		case "qorpera.member-notification.provider-usage-limit/v1":
			return {
				title: "Model account usage limit reached",
				detail: `${subject.provider} reported a usage limit.${subject.resetsAt ? ` Reported reset: ${fmtTime(subject.resetsAt)}.` : ""}`,
			};
		case "qorpera.member-notification.company-ceiling-tripped/v1":
			return {
				title: "Company execution limit reached",
				detail: `Work reached the company's ${subject.dimension === "spend" ? "spending" : subject.dimension === "tokens" ? "token" : "hourly wake"} limit.`,
			};
		case "qorpera.member-notification.machine-capacity/v1":
			return {
				title: "Company computer limit reached",
				detail: `A computer could not start: ${subject.used} of ${subject.ceiling} computer allocations are in use.`,
			};
		case "qorpera.member-notification.company-execution-stop/v1":
			return {
				title: subject.paused ? "Company execution paused" : "Company execution resumed",
				detail: `${subject.paused ? "New work is paused." : "The company execution pause was removed."}${subject.reason ? ` ${subject.reason}` : ""}`,
			};
		case "qorpera.member-notification.sponsor-handoff/v1":
			return {
				title: "Execution sponsor changed",
				detail:
					"Work switched to another eligible model account after a usage limit. The same run continues with its conversation history.",
			};
	}
}

/** Member-addressed runtime notices stay in the company workspace until explicitly
 * acknowledged. Polling never acknowledges, replays a write or steals focus. */
export class ExecutionNotices {
	readonly el = h("section", { class: "execution-notices", "aria-label": "Company execution updates", hidden: true });
	readonly #client: Client;
	readonly #lifetime = new AbortController();
	readonly #settings: (() => void) | undefined;
	readonly #restoreFocus: (() => void) | undefined;
	#items: readonly CompanyExecutionNotification[] = [];
	#selected: string | undefined;
	#request: AbortController | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#acking = false;
	#refreshRequired = false;
	#error: string | undefined;
	#drawn = "";

	constructor(client: Client, signal: AbortSignal, settings?: () => void, restoreFocus?: () => void) {
		this.#client = client;
		this.#settings = settings;
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
		} catch {
			if (signal.aborted) return;
			this.#items = [];
			this.#refreshRequired = true;
			this.#error =
				"Company execution updates are unavailable. Refresh to check for usage limits or changes to running work.";
		} finally {
			if (this.#request === request) this.#request = undefined;
			if (!signal.aborted) this.#draw();
		}
	}

	async #acknowledge(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#acking || this.#refreshRequired) return;
		const item = this.#items.find((entry) => entry.notificationId === this.#selected);
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
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#refreshRequired = true;
			this.#error = "Acknowledgment could not be confirmed. Refresh before trying again.";
		} finally {
			this.#acking = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}

	#draw(): void {
		const item = this.#items.find((entry) => entry.notificationId === this.#selected) ?? this.#items[0];
		this.#selected = item?.notificationId;
		const key = JSON.stringify([this.#items, this.#selected, this.#acking, this.#refreshRequired, this.#error]);
		if (key === this.#drawn) return;
		const focused = this.el.contains(document.activeElement)
			? (document.activeElement as HTMLElement).dataset.action
			: undefined;
		const action = (label: string, name: string, run: () => void, unavailable = false) =>
			h(
				"button",
				{
					type: "button",
					class: "btn btn-small",
					"data-action": name,
					"aria-disabled": unavailable ? "true" : undefined,
					onclick: (event: MouseEvent) => {
						if (!unavailable && event.detail < 2) run();
					},
				},
				label,
			);
		const message = item ? copy(item) : undefined;
		const index = item ? this.#items.indexOf(item) : 0;
		const move = (offset: number) => {
			this.#selected = this.#items[(index + offset + this.#items.length) % this.#items.length]?.notificationId;
			this.#draw();
		};
		replace(
			this.el,
			message
				? h(
						"div",
						{ class: "execution-notice-copy", role: "status" },
						h("strong", null, message.title),
						h("span", null, message.detail),
						h(
							"small",
							{ class: "muted" },
							`${fmtTime(item!.createdAt)} · Update ${index + 1} of ${this.#items.length} pending in the latest 50`,
						),
					)
				: null,
			this.#error ? h("p", { class: "execution-notice-error", role: "alert" }, this.#error) : null,
			h(
				"div",
				{ class: "execution-notice-actions" },
				this.#items.length > 1 ? action("Previous update", "previous", () => move(-1), this.#acking) : null,
				this.#items.length > 1 ? action("Next update", "next", () => move(1), this.#acking) : null,
				item
					? action(
							this.#acking ? "Acknowledging…" : "Acknowledge",
							"acknowledge",
							() => void this.#acknowledge(),
							this.#acking || this.#refreshRequired,
						)
					: null,
				this.#error ? action("Refresh updates", "refresh", () => void this.refresh(), this.#acking) : null,
				this.#settings && item ? action("Company settings", "settings", this.#settings) : null,
			),
		);
		this.el.hidden = !item && !this.#error;
		if (focused && this.el.hidden) this.#restoreFocus?.();
		if (focused) this.el.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
		this.#drawn = key;
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		clearInterval(this.#timer);
		this.#items = [];
		this.el.replaceChildren();
		this.el.hidden = true;
	}
}
