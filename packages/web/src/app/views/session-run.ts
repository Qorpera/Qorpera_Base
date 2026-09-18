import type { CloudSessionRunState } from "@qorpera/cloud-client";
import type { WebSessionRunControl } from "../../cloud/session-run-control.ts";
import { h, replace } from "../../ui/dom.ts";

/** Observes cloud-owned work. Local lifetime cancellation never stops a run. */
export class SessionRunView {
	readonly el = h("div", { class: "session-run surface-status", "aria-label": "Cloud run" });
	readonly #control: WebSessionRunControl;
	readonly #sessionId: string;
	readonly #lifetime = new AbortController();
	#staffAgentId: string | undefined;
	#canCancel = false;
	#state: CloudSessionRunState | undefined;
	#request: AbortController | undefined;
	#poll: ReturnType<typeof setTimeout> | undefined;
	#busy = false;
	#uncertain = false;
	#message = "Cloud run status is unavailable.";
	#renderKey = "";

	readonly #changed: () => void;
	constructor(control: WebSessionRunControl, sessionId: string, signal: AbortSignal, changed: () => void = () => {}) {
		this.#changed = changed;
		this.#control = control;
		this.#sessionId = sessionId;
		if (signal.aborted) this.dispose();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		window.addEventListener("online", () => void this.refresh(), { signal: this.#lifetime.signal });
		window.addEventListener("focus", () => void this.refresh(), { signal: this.#lifetime.signal });
		this.#render();
	}

	update(staffAgentId: string | undefined, canCancel: boolean): void {
		if (this.#lifetime.signal.aborted) return;
		this.#canCancel = canCancel;
		if (this.#staffAgentId !== staffAgentId) {
			this.#request?.abort();
			clearTimeout(this.#poll);
			this.#request = undefined;
			this.#state = undefined;
			this.#busy = false;
			this.#uncertain = false;
			this.#staffAgentId = staffAgentId;
			this.#message = "Cloud run status is unavailable.";
			if (staffAgentId) void this.refresh();
		}
		this.#render();
	}

	async refresh(reads = 1): Promise<void> {
		if (this.#lifetime.signal.aborted || !this.#staffAgentId || this.#busy) return;
		clearTimeout(this.#poll);
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		this.#busy = true;
		this.#message = "Checking cloud run…";
		this.#render();
		try {
			const state = await this.#control.read(this.#sessionId, this.#staffAgentId, signal);
			if (signal.aborted) return;
			this.#state = state;
			this.#uncertain = false;
			this.#message = state.run
				? state.run.status === "queued"
					? "Cloud run queued."
					: "Cloud run in progress."
				: "No active cloud run.";
			if (reads > 1) this.#poll = setTimeout(() => void this.refresh(reads - 1), 1_000);
		} catch {
			if (signal.aborted) return;
			this.#message = this.#uncertain
				? "Stop could not be confirmed. Refresh run status before trying again."
				: "Cloud run status is unavailable. Refresh to try again.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				if (!signal.aborted) this.#render();
			}
		}
	}

	/** The member can stop the agent's current run from the composer. */
	get stoppable(): boolean {
		return Boolean(
			this.#canCancel && this.#state?.run?.canCancel && !this.#uncertain && !this.#lifetime.signal.aborted,
		);
	}
	get stopping(): boolean {
		return this.#uncertain && this.#busy;
	}
	stop(): void {
		const run = this.#state?.run;
		if (run) void this.#cancel(run.runId);
	}

	/** Refresh after admission without retrying the message or assuming a run exists. */
	messageSent(): void {
		if (this.#lifetime.signal.aborted || this.#uncertain) return;
		// A pre-admission read may still be in flight. Replace only that local read.
		if (this.#busy && !this.#state) {
			this.#request?.abort();
			this.#request = undefined;
			this.#busy = false;
		}
		void this.refresh(5);
	}

	async #cancel(runId: string): Promise<void> {
		if (
			this.#lifetime.signal.aborted ||
			this.#busy ||
			this.#uncertain ||
			!this.#canCancel ||
			!this.#state?.run?.canCancel ||
			this.#state.run.runId !== runId
		)
			return;
		clearTimeout(this.#poll);
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		this.#busy = true;
		this.#uncertain = true;
		this.#state = undefined;
		this.#message = "Stopping selected cloud run…";
		this.#render();
		let confirmed = false;
		try {
			await this.#control.cancel(this.#sessionId, runId, signal);
			if (signal.aborted) return;
			confirmed = true;
		} catch {
			if (signal.aborted) return;
			this.#message = "Stop could not be confirmed. Refresh run status before trying again.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				if (!signal.aborted) this.#render();
			}
		}
		if (confirmed) await this.refresh();
	}

	#render(): void {
		const run = this.#state?.run;
		// Quiet unless there is a run to watch or a stop to confirm.
		this.el.hidden = !this.#staffAgentId || this.#lifetime.signal.aborted || (!run && !this.#uncertain);
		const key = JSON.stringify([run, this.#message, this.#busy, this.#uncertain, this.#canCancel, this.el.hidden]);
		if (key === this.#renderKey) return;
		this.#renderKey = key;
		this.#changed();
		replace(
			this.el,
			h("span", { role: "status" }, this.#message),
			h(
				"button",
				{
					type: "button",
					class: "btn btn-small",
					"aria-label": "Refresh run status",
					disabled: this.#busy || !this.#staffAgentId,
					onclick: () => void this.refresh(),
				},
				"Refresh",
			),
			run?.canCancel && this.#canCancel
				? h(
						"button",
						{
							type: "button",
							class: "btn btn-small",
							"aria-label": "Stop cloud run",
							disabled: this.#busy || this.#uncertain,
							onclick: () => void this.#cancel(run.runId),
						},
						"Stop run",
					)
				: null,
		);
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		clearTimeout(this.#poll);
		this.#state = undefined;
		this.el.replaceChildren();
		this.el.hidden = true;
	}
}
