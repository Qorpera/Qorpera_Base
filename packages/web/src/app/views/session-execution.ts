import type {
	NativeExecutionConnections,
	SessionTurnProvenance,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { selectSessionExecutionSponsor } from "../../cloud/session-input.ts";
import { button, fmtTime, h, notice, replace } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

/** A member explicitly selects their own observed sponsor. Runtime admission
 * remains in the shared SDK; no account is selected or enabled automatically. */
export class SessionExecutionView {
	readonly el = h("div", { class: "session-execution" });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #native: WebNativeSubscription;
	readonly #changed: () => void;
	readonly #lifetime = new AbortController();
	#request: AbortController | undefined;
	#observed: NativeExecutionConnections | undefined;
	#provenance: readonly SessionTurnProvenance[] = [];
	#started = false;
	#busy = false;
	#error: string | undefined;
	#historyError: string | undefined;
	#renderKey = "";
	#room = false;

	constructor(
		company: CompanyController,
		sessionId: string,
		native: WebNativeSubscription,
		changed: () => void,
		signal: AbortSignal,
	) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#native = native;
		this.#changed = changed;
		if (signal.aborted) this.dispose();
		else signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal, once: true });
		window.addEventListener("online", () => void this.refresh(), { signal: this.#lifetime.signal });
		window.addEventListener("focus", () => void this.refresh(), { signal: this.#lifetime.signal });
	}

	get canSend(): boolean {
		const conversation = this.#company.conversation(this.#sessionId).get();
		const retry = conversation.retrySend;
		const files = conversation.attachments ?? [];
		if (retry)
			return (
				retry.text === (conversation.draft ?? "").trim() &&
				retry.files.length === files.length &&
				retry.files.every((file, index) => file === files[index])
			);
		if (!conversation.executionSponsor || !this.#observed || this.#busy) return false;
		try {
			const current = selectSessionExecutionSponsor(
				this.#observed,
				conversation.executionSponsor.connectionId,
				this.#company.userId,
			);
			return JSON.stringify(current) === JSON.stringify(conversation.executionSponsor);
		} catch {
			return false;
		}
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const company = this.#company.store.get();
		const room =
			typeof company.sessions.find((s) => s.sessionId === this.#sessionId)?.executionScope?.roomId === "string";
		if (room !== this.#room) {
			this.#request?.abort();
			this.#request = undefined;
			this.#provenance = [];
			this.#historyError = undefined;
			this.#busy = false;
			this.#started = false;
			this.#room = room;
		}
		const canRead =
			!company.accessLost &&
			company.team?.capabilities.read &&
			company.sessions.some((s) => s.sessionId === this.#sessionId);
		if (!canRead) {
			this.#request?.abort();
			this.#request = undefined;
			this.#observed = undefined;
			this.#provenance = [];
			this.#started = false;
			this.#busy = false;
			this.el.replaceChildren();
			this.#renderKey = "";
			return;
		}
		if (!this.#started) {
			this.#started = true;
			void this.refresh();
		}
		this.#render();
	}

	async refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy) return;
		const company = this.#company.store.get();
		if (
			company.accessLost ||
			!company.team?.capabilities.read ||
			!company.sessions.some((s) => s.sessionId === this.#sessionId)
		)
			return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		this.#busy = true;
		this.#observed = undefined;
		this.#error = undefined;
		this.#historyError = undefined;
		this.#render();
		this.#changed();
		const [connections, provenance] = await Promise.allSettled([
			this.#native.listConnections(signal),
			this.#room ? Promise.resolve([]) : this.#native.listSessionTurnProvenance(this.#sessionId, signal),
		]);
		if (signal.aborted) return;
		if (connections.status === "fulfilled") this.#observed = connections.value;
		else this.#error = "Model accounts are unavailable. Refresh to try again.";
		if (provenance.status === "fulfilled") this.#provenance = provenance.value;
		else {
			this.#provenance = [];
			this.#historyError = "Execution history is unavailable.";
		}
		this.#busy = false;
		this.#request = undefined;
		this.#render();
		this.#changed();
	}

	#render(): void {
		const conversation = this.#company.conversation(this.#sessionId).get();
		const company = this.#company.store.get();
		const canWrite =
			company.team?.capabilities.write === true &&
			company.sessions.find((s) => s.sessionId === this.#sessionId)?.status === "open";
		const selected = conversation.retrySend?.executionSponsor ?? conversation.executionSponsor;
		const locked = this.#busy || conversation.sending || Boolean(conversation.retrySend) || !canWrite;
		const key = JSON.stringify([
			this.#room,
			this.#observed,
			this.#provenance,
			this.#error,
			this.#historyError,
			selected,
			locked,
			this.#busy,
			conversation.sending,
			Boolean(conversation.retrySend),
			this.canSend,
		]);
		if (key === this.#renderKey) return;
		this.#renderKey = key;
		const select = h(
			"select",
			{ "aria-label": "Model account for this conversation", disabled: locked },
			h("option", { value: "" }, "Choose your model account"),
		);
		for (const connection of this.#observed?.connections ?? []) {
			let available = true;
			try {
				selectSessionExecutionSponsor(this.#observed!, connection.connectionId, this.#company.userId);
			} catch {
				available = false;
			}
			select.append(
				h(
					"option",
					{ value: connection.connectionId, disabled: !available },
					`${connection.provider} · ${connection.providerAccountReference ?? connection.nativeHarness}${available ? "" : " (unavailable)"}`,
				),
			);
		}
		if (selected && ![...select.options].some((o) => o.value === selected.connectionId)) {
			select.append(
				h(
					"option",
					{ value: selected.connectionId, disabled: true },
					`${selected.provider} · saved selection (refresh required)`,
				),
			);
		}
		select.value = selected?.connectionId ?? "";
		select.addEventListener("change", () => {
			const state = this.#company.conversation(this.#sessionId).get();
			if (this.#lifetime.signal.aborted || this.#busy || state.sending || state.retrySend || !this.#observed) return;
			try {
				this.#company.setExecutionSponsor(this.#sessionId, this.#observed, select.value || undefined);
				this.#error = undefined;
			} catch {
				this.#error = "This model account is unavailable. Refresh and select an active account.";
			}
			this.#render();
			this.#changed();
		});
		replace(
			this.el,
			h("label", { class: "field" }, "Model account", select),
			button(this.#busy ? "Refreshing accounts…" : "Refresh model accounts", () => void this.refresh(), {
				small: true,
				disabled: this.#busy,
			}),
			this.#error ? notice("neutral", this.#error) : null,
			conversation.retrySend
				? h(
						"div",
						null,
						h(
							"p",
							{ class: "muted" },
							"Retry keeps the original model account and message request. The earlier message may already have been accepted. Starting a new request can send it again.",
						),
						button(
							"Start a new message request",
							() => {
								if (this.#lifetime.signal.aborted) return;
								try {
									this.#company.discardSendRetry(this.#sessionId);
									this.#error = undefined;
								} catch {
									this.#error = "This conversation is unavailable for a new request.";
								}
								this.#render();
								this.#changed();
							},
							{ small: true, disabled: conversation.sending || !canWrite },
						),
					)
				: !selected || !this.canSend
					? h(
							"p",
							{ class: "muted" },
							"Choose an active account enabled for your messages in Settings → Connections.",
						)
					: null,
			this.#room
				? null
				: h(
						"details",
						null,
						h("summary", null, "Execution history"),
						this.#historyError
							? notice("neutral", this.#historyError)
							: this.#provenance.length
								? this.#provenance
										.slice(0, 20)
										.map((turn) =>
											h(
												"p",
												{ class: "muted" },
												`${fmtTime(turn.createdAt)} · ${turn.provider ?? "Provider pending"} · ${turn.sponsoredByName ?? (turn.sponsorMode === "company_connection" ? "Company account" : turn.sponsorMode === "sponsorship_request" ? "Sponsorship requested" : "Member account")} · ${turn.runStatus ?? turn.status}${turn.failureReason ? ` · ${turn.failureReason}` : ""}`,
											),
										)
								: h(
										"p",
										{ class: "muted" },
										this.#busy ? "Loading execution history…" : "No execution requests yet.",
									),
					),
		);
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		this.#observed = undefined;
		this.#provenance = [];
		this.el.replaceChildren();
	}
}
