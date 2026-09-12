import type { CompanyExecutionNotification, WebCompanyExecution } from "../../cloud/company-execution.ts";
import { button, fmtTime, h, notice, replace } from "../../ui/dom.ts";

type NotificationReader = Pick<WebCompanyExecution, "listNotifications">;
type NotificationClient = Pick<WebCompanyExecution, "listNotifications" | "acknowledgeNotification">;

function notificationCopy(item: CompanyExecutionNotification): { title: string; detail: string } {
	const subject = item.subject;
	switch (item.kind) {
		case "provider_usage_limit": {
			const provider =
				subject.schema === "qorpera.member-notification.provider-usage-limit/v1"
					? subject.provider === "openai"
						? "OpenAI"
						: subject.provider === "anthropic"
							? "Anthropic"
							: "Your model provider"
					: "Your model provider";
			const resetsAt =
				subject.schema === "qorpera.member-notification.provider-usage-limit/v1" ? subject.resetsAt : null;
			return {
				title: "Model account usage limit reached",
				detail: `${provider} reported a usage limit.${resetsAt ? ` Reported reset: ${fmtTime(resetsAt)}.` : ""}`,
			};
		}
		case "company_ceiling_tripped": {
			const dimension = "dimension" in subject ? subject.dimension : undefined;
			const label =
				dimension === "spend"
					? "spending"
					: dimension === "tokens"
						? "token"
						: dimension === "wakes"
							? "wake"
							: dimension === "machines"
								? "machine"
								: "execution";
			return {
				title: "Company execution limit reached",
				detail: `Work reached the company's ${label} limit. Review company execution settings before changing limits.`,
			};
		}
		case "company_execution_paused":
			return { title: "Company execution paused", detail: "New execution admissions are paused for this company." };
		case "company_execution_resumed":
			return { title: "Company execution resumed", detail: "The company execution pause was removed." };
		case "sponsor_handoff":
			return {
				title: "Execution sponsor changed",
				detail: "The runtime moved work to another eligible sponsor after a usage limit.",
			};
	}
}

/** Read-only company badge. SQL returns at most the 50 most recent records;
 * this count is deliberately scoped to that window, not an invented total. */
export class MemberNotificationStatus {
	readonly #client: NotificationReader;
	readonly #changed: (count: number | undefined, phase: "loading" | "ready" | "unavailable") => void;
	readonly #lifetime = new AbortController();
	#request: AbortController | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	constructor(
		client: NotificationReader,
		signal: AbortSignal,
		changed: (count: number | undefined, phase: "loading" | "ready" | "unavailable") => void,
	) {
		this.#client = client;
		this.#changed = changed;
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
	observe(items: readonly CompanyExecutionNotification[]): void {
		if (this.#lifetime.signal.aborted) return;
		this.#request?.abort();
		this.#request = undefined;
		this.#changed(items.filter((item) => !item.acknowledgedAt).length, "ready");
	}
	async refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#request || document.visibilityState === "hidden") return;
		const request = new AbortController();
		this.#request = request;
		this.#changed(undefined, "loading");
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		try {
			const items = await this.#client.listNotifications(signal);
			if (!signal.aborted) this.#changed(items.filter((item) => !item.acknowledgedAt).length, "ready");
		} catch {
			if (!signal.aborted) this.#changed(undefined, "unavailable");
		} finally {
			if (this.#request === request) this.#request = undefined;
		}
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		this.#request = undefined;
		clearInterval(this.#timer);
	}
}

/** Member-addressed control-plane metadata. Reading never acknowledges it. */
export class MemberNotificationsView {
	readonly el = h("section", { class: "page member-notifications", "aria-label": "Company notifications" });
	readonly #client: NotificationClient;
	readonly #changed: (items: readonly CompanyExecutionNotification[]) => void;
	readonly #lifetime = new AbortController();
	#items: readonly CompanyExecutionNotification[] = [];
	#busy = false;
	#loaded = false;
	#refreshRequired = false;
	#error: string | undefined;
	constructor(
		client: NotificationClient,
		signal: AbortSignal,
		changed: (items: readonly CompanyExecutionNotification[]) => void = () => {},
	) {
		this.#client = client;
		this.#changed = changed;
		if (signal.aborted) {
			this.dispose();
			return;
		}
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		for (const event of ["focus", "online"])
			window.addEventListener(event, () => void this.refresh(), { signal: this.#lifetime.signal });
		void this.refresh();
	}
	async refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy) return;
		this.#busy = true;
		this.#error = undefined;
		this.#items = [];
		this.#draw();
		try {
			const items = await this.#client.listNotifications(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#items = items;
			this.#loaded = true;
			this.#refreshRequired = false;
			this.#changed(items);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#loaded = false;
			this.#refreshRequired = true;
			this.#error = "Notifications are unavailable. Refresh to check for updates.";
		} finally {
			this.#busy = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	async #acknowledge(notificationId: string): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy || this.#refreshRequired) return;
		const item = this.#items.find((entry) => entry.notificationId === notificationId);
		if (!item || item.acknowledgedAt) return;
		this.#busy = true;
		this.#error = undefined;
		this.#draw();
		try {
			const receipt = await this.#client.acknowledgeNotification(notificationId, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			if (
				receipt.notificationId !== item.notificationId ||
				receipt.profileId !== item.profileId ||
				!receipt.acknowledgedAt
			)
				throw new Error("Notification receipt mismatch");
			this.#items = this.#items.map((entry) => (entry.notificationId === notificationId ? receipt : entry));
			this.#changed(this.#items);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#refreshRequired = true;
			this.#error = "Acknowledgment could not be confirmed. Refresh before trying again.";
		} finally {
			this.#busy = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	#draw(): void {
		replace(
			this.el,
			h("h1", null, "Notifications"),
			h(
				"p",
				{ class: "muted" },
				"Execution updates addressed to your account in this company. Up to 50 recent notifications are shown.",
			),
			button(this.#busy ? "Checking notifications…" : "Refresh notifications", () => void this.refresh(), {
				disabled: this.#busy,
			}),
			this.#error ? notice("neutral", this.#error) : null,
			this.#loaded && !this.#busy && !this.#error && !this.#items.length
				? h("p", { class: "empty" }, "No recent notifications.")
				: null,
			h(
				"div",
				{ class: "stack", role: "list" },
				...this.#items.map((item) => {
					const copy = notificationCopy(item);
					return h(
						"article",
						{ class: "settings-card", role: "listitem" },
						h(
							"div",
							{ class: "settings-copy" },
							h("strong", null, copy.title),
							h("p", null, copy.detail),
							h("small", null, fmtTime(item.createdAt)),
						),
						item.acknowledgedAt
							? h("span", { class: "muted" }, "Acknowledged")
							: button("Acknowledge", () => void this.#acknowledge(item.notificationId), {
									disabled: this.#busy || this.#refreshRequired,
								}),
					);
				}),
			),
		);
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#items = [];
		this.el.replaceChildren();
	}
}
