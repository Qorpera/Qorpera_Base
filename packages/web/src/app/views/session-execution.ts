import type {
	NativeExecutionConnections,
	NativeMemberConnection,
	SessionTurnProvenance,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { selectSessionExecutionSponsor } from "../../cloud/session-input.ts";
import { button, h, replace } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

/** Unknown windows sort after measured allowance. Expired windows no longer
 * establish exhaustion; the provider supplies the next observation. */
function remainingAllowance(connection: NativeMemberConnection, now: number): number | undefined {
	if (connection.usageLimitResetAt && Date.parse(connection.usageLimitResetAt) > now) return 0;
	const observedAt = Date.parse(connection.providerAccountUsage?.observedAt ?? "");
	if (!Number.isFinite(observedAt) || observedAt < now - 5 * 60_000 || observedAt > now + 60_000) return undefined;
	const windows =
		connection.providerAccountUsage?.windows.filter(
			(window) => !window.resetAt || Date.parse(window.resetAt) > now,
		) ?? [];
	return windows.length ? Math.min(...windows.map((window) => 100 - window.usedPercent)) : undefined;
}

/** A conversation keeps its own account until that account becomes unavailable.
 * New conversations choose the member's account with the most remaining allowance. */
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
	#serverSelection = false;
	#serverConnectionId: string | undefined;
	#usageHydratedAt: number | undefined;
	#refreshTimer: ReturnType<typeof setTimeout> | undefined;

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
		if (this.#serverSelection && conversation.executionSponsor.connectionId !== this.#serverConnectionId)
			return false;
		if (!this.#available().includes(conversation.executionSponsor.connectionId)) return false;
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
			clearTimeout(this.#refreshTimer);
			this.#refreshTimer = undefined;
			this.#request?.abort();
			this.#request = undefined;
			this.#observed = undefined;
			this.#provenance = [];
			this.#started = false;
			this.#busy = false;
			this.#usageHydratedAt = undefined;
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
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		this.#busy = true;
		this.#observed = undefined;
		this.#error = undefined;
		this.#historyError = undefined;
		this.#render();
		this.#changed();
		const conversation = this.#company.conversation(this.#sessionId).get();
		this.#serverSelection = Boolean(
			this.#native.selectSessionAccount && !conversation.retrySend && !conversation.sending,
		);
		this.#serverConnectionId = undefined;
		const readConnections = async (): Promise<NativeExecutionConnections> => {
			if (this.#serverSelection) {
				if (
					this.#native.refreshAccountMetadata &&
					(this.#usageHydratedAt === undefined || Date.now() - this.#usageHydratedAt >= 60_000)
				) {
					await this.#native.refreshAccountMetadata(signal);
					signal.throwIfAborted();
					this.#usageHydratedAt = Date.now();
				}
				const connectionId = await this.#native.selectSessionAccount!(this.#sessionId, signal);
				signal.throwIfAborted();
				this.#serverConnectionId = connectionId;
			}
			return this.#native.listConnections(signal);
		};
		const [connections, provenance] = await Promise.allSettled([
			readConnections(),
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
		this.#choose();
		this.#render();
		this.#changed();
		this.#scheduleRefresh();
	}

	#scheduleRefresh(): void {
		clearTimeout(this.#refreshTimer);
		const company = this.#company.store.get();
		if (
			this.#lifetime.signal.aborted ||
			company.accessLost ||
			!company.team?.capabilities.read ||
			company.sessions.find((session) => session.sessionId === this.#sessionId)?.status !== "open"
		)
			return;
		const now = Date.now();
		const resets = (this.#observed?.connections ?? []).flatMap((connection) => [
			connection.usageLimitResetAt,
			...(connection.providerAccountUsage?.windows.map((window) => window.resetAt) ?? []),
		]);
		const nextReset = Math.min(...resets.map((reset) => Date.parse(reset ?? "")).filter((reset) => reset > now));
		const delay = Math.max(1000, Math.min(30_000, nextReset - now + 250));
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = undefined;
			const conversation = this.#company.conversation(this.#sessionId).get();
			// Never replace the account while a write or its exact replay is outstanding.
			if (conversation.sending || conversation.retrySend) {
				this.#scheduleRefresh();
				return;
			}
			if (nextReset <= Date.now()) this.#usageHydratedAt = undefined;
			void this.refresh();
		}, delay);
	}

	#available(): string[] {
		const observed = this.#observed;
		if (!observed) return [];
		const now = Date.now();
		const seen = new Set<string>();
		return observed.connections
			.filter((connection) => {
				if (seen.has(connection.connectionId)) return false;
				seen.add(connection.connectionId);
				if (remainingAllowance(connection, now) === 0) return false;
				try {
					selectSessionExecutionSponsor(observed, connection.connectionId, this.#company.userId);
					return true;
				} catch {
					return false;
				}
			})
			.sort(
				(a, b) =>
					(remainingAllowance(b, now) ?? -1) - (remainingAllowance(a, now) ?? -1) ||
					a.connectionId.localeCompare(b.connectionId),
			)
			.map((connection) => connection.connectionId);
	}

	#choose(): void {
		const conversation = this.#company.conversation(this.#sessionId).get();
		if (!this.#observed || conversation.sending || conversation.retrySend) return;
		if (
			this.canSend &&
			(!this.#serverSelection || conversation.executionSponsor?.connectionId === this.#serverConnectionId)
		)
			return;
		const available = this.#available();
		const kept = conversation.executionSponsor;
		// Follow a runtime handoff on the same durable binding before selecting
		// another account. A retry still keeps its exact original request authority.
		const handedOff =
			kept &&
			this.#observed.connections
				.filter(
					(connection) =>
						connection.sponsorBindingId === kept.sponsorBindingId &&
						(connection.sponsorVersion ?? 0) > kept.sponsorVersion &&
						available.includes(connection.connectionId),
				)
				.sort((a, b) => (b.sponsorVersion ?? 0) - (a.sponsorVersion ?? 0))[0];
		const next = this.#serverSelection
			? this.#serverConnectionId && available.includes(this.#serverConnectionId)
				? this.#serverConnectionId
				: undefined
			: (handedOff?.connectionId ??
				(kept && available.includes(kept.connectionId) ? kept.connectionId : available[0]));
		if (!next) return;
		try {
			this.#company.setExecutionSponsor(this.#sessionId, this.#observed, next);
			this.#error = undefined;
		} catch {
			// Sending stays off until the member has a usable account and authority.
		}
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

		replace(
			this.el,
			this.#error ? h("p", { class: "muted" }, this.#error) : null,
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
									if (this.#native.selectSessionAccount) void this.refresh();
									else this.#choose();
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
				: this.#observed && !this.#error && !this.canSend && !this.#busy
					? h(
							"p",
							{ class: "muted" },
							this.#observed.connections.some((connection) => remainingAllowance(connection, Date.now()) === 0)
								? "Your model accounts have reached their usage limits. Sending resumes when an account resets."
								: "Connect a model account in Settings → Connections to send messages.",
						)
					: null,
		);
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		this.#request?.abort();
		this.#observed = undefined;
		this.#provenance = [];
		this.el.replaceChildren();
	}
}
