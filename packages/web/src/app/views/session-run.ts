import type { CloudSessionRunState } from "@qorpera/cloud-client";
import type { WebSessionRunControl } from "../../cloud/session-run-control.ts";

/** Observes cloud-owned work. Local lifetime cancellation never stops a run. */
export class SessionRunView {
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
			if (staffAgentId) void this.refresh();
		}
		this.#render();
	}

	async refresh(reads = 1): Promise<void> {
		if (this.#lifetime.signal.aborted || !this.#staffAgentId || this.#busy) return;
		clearTimeout(this.#poll);
		const request = new AbortController();
		this.#request = request;
		const signal = request.signal;
		this.#busy = true;
		this.#render();
		try {
			const state = await this.#control.read(this.#sessionId, this.#staffAgentId, signal);
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			this.#state = state;
			this.#uncertain = false;
			if (reads > 1) this.#poll = setTimeout(() => void this.refresh(reads - 1), 1_000);
		} catch {
			if (signal.aborted || this.#lifetime.signal.aborted) return;
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				if (!signal.aborted && !this.#lifetime.signal.aborted) this.#render();
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
		const signal = request.signal;
		this.#busy = true;
		this.#uncertain = true;
		this.#state = undefined;
		this.#render();
		let confirmed = false;
		try {
			await this.#control.cancel(this.#sessionId, runId, signal);
			if (signal.aborted || this.#lifetime.signal.aborted) return;
			confirmed = true;
		} catch {
			if (signal.aborted || this.#lifetime.signal.aborted) return;
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				if (!signal.aborted && !this.#lifetime.signal.aborted) this.#render();
			}
		}
		if (confirmed) await this.refresh();
	}

	#render(): void {
		const run = this.#state?.run;
		const hidden = !this.#staffAgentId || this.#lifetime.signal.aborted || (!run && !this.#uncertain);
		const key = JSON.stringify([run, this.#busy, this.#uncertain, this.#canCancel, hidden]);
		if (key === this.#renderKey) return;
		this.#renderKey = key;
		this.#changed();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		clearTimeout(this.#poll);
		this.#state = undefined;
	}
}
