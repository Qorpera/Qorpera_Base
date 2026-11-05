import type {
	NativeExecutionConnections,
	NativeMemberConnection,
	SessionTurnProvenance,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import type {
	WebExecutionConnections,
	WebMemberConnection,
	WebNativeSubscription,
} from "../../cloud/native-subscription.ts";
import { selectSessionExecutionSponsor } from "../../cloud/session-input.ts";
import { button, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { RunPayer } from "../../ui/run-failure.ts";
import type { CompanyController } from "../company.ts";

/** The usage windows that count now: "limit" while a usage-limit signal is open, undefined
 * while the reading is unknown or stale. Expired windows no longer establish exhaustion; the
 * provider supplies the next observation. */
function currentWindows(
	connection: NativeMemberConnection,
	now: number,
): NonNullable<NativeMemberConnection["providerAccountUsage"]>["windows"] | "limit" | undefined {
	if (connection.usageLimitResetAt && Date.parse(connection.usageLimitResetAt) > now) return "limit";
	const observedAt = Date.parse(connection.providerAccountUsage?.observedAt ?? "");
	if (!Number.isFinite(observedAt) || observedAt < now - 5 * 60_000 || observedAt > now + 60_000) return undefined;
	const windows =
		connection.providerAccountUsage?.windows.filter(
			(window) => !window.resetAt || Date.parse(window.resetAt) > now,
		) ?? [];
	return windows.length ? windows : undefined;
}

/** The least room left of the login's windows, in percent. Unknown windows sort after measured allowance. */
function remainingAllowance(connection: NativeMemberConnection, now: number): number | undefined {
	const windows = currentWindows(connection, now);
	if (windows === "limit") return 0;
	return windows ? Math.min(...windows.map((window) => 100 - window.usedPercent)) : undefined;
}

/** The login's room on one scale (migration 20260930559000, qorpera_native_account_paced_room): each
 * window's remaining percent divided by the share of that window still to run (5% to all of it; all
 * of it when the reading has no length or reset), the tightest window deciding. 50% left of a week
 * that resets in a day is 350; 97% left of a 30-day window with 27 days to go is about 108. */
function pacedRoom(connection: NativeMemberConnection, now: number): number | undefined {
	const windows = currentWindows(connection, now);
	if (windows === "limit") return 0;
	if (!windows) return undefined;
	return Math.min(
		...windows.map((window) => {
			const reset = Date.parse(window.resetAt ?? "");
			const share =
				window.windowSeconds && window.windowSeconds > 0 && Number.isFinite(reset)
					? (reset - now) / (window.windowSeconds * 1000)
					: 1;
			return (100 - window.usedPercent) / Math.max(0.05, Math.min(1, share));
		}),
	);
}

/** How a first choice orders a login, best first, as the cloud's qorpera_native_account_rank does
 * (migration 20260930559000): a login whose provider refused its last three runs last; then one at
 * its limit; then one that completed a run this week with at least 20% left (or unknown usage) first;
 * then the most room on one scale, unknown usage after measured room. */
function loginRank(connection: WebMemberConnection, now: number): readonly number[] {
	const remaining = remainingAllowance(connection, now);
	return [
		connection.recentTurns?.refused === true ? 1 : 0,
		remaining === 0 ? 1 : 0,
		(remaining === undefined || remaining >= 20) && connection.recentTurns?.completed === true ? 0 : 1,
		-(pacedRoom(connection, now) ?? -1),
	];
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < a.length; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

/** The waits before reading the accounts again after a read failed: 2 s, 5 s, 10 s, 30 s, then every minute. Coming
 * back to the window or online reads at once. (3 Nov 2026: the composer stayed locked on "Model accounts are
 * unavailable" until the page was reloaded.) */
export const ACCOUNT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];

/** One of the member's logins that can pay for a conversation, as the composer's Login page lists it. */
export interface SessionLogin {
	readonly connectionId: string;
	/** The account's email, else "Model account N". */
	readonly account: string;
	/** The login the conversation is bound to now. */
	readonly current: boolean;
}

/** A conversation keeps its own account while it has room, so its prompt cache stays warm. At its
 * usage limit, or when it can't pay now, the conversation moves to the member's own account with the
 * most room, by itself (founder decision 2026-11-05, migration 20260930575000; the cloud's choice where
 * the cloud chooses). With none that has room it keeps its account, and sending waits until one has room
 * again. New conversations choose the member's account that works and has the most room on one scale
 * (loginRank, migration 20260930559000). The member's own pick stays as an override. */
export class SessionExecutionView {
	readonly el = h("div", { class: "session-execution" });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #native: WebNativeSubscription;
	readonly #changed: () => void;
	readonly #lifetime = new AbortController();
	#request: AbortController | undefined;
	#observed: WebExecutionConnections | undefined;
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
	#usageRequest: AbortController | undefined;
	#refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** Account reads that failed in a row; the next read waits by ACCOUNT_RETRY_DELAYS_MS. */
	#failures = 0;

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
		// A tab the browser froze in the background runs no timer: its first moment back reads the accounts.
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState === "visible") void this.refresh();
			},
			{ signal: this.#lifetime.signal },
		);
		window.addEventListener("pageshow", () => void this.refresh(), { signal: this.#lifetime.signal });
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
			this.#usageRequest?.abort();
			this.#usageRequest = undefined;
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
		// The line that says the accounts are unavailable stays while they are read again, instead of blinking.
		if (!this.#failures) this.#error = undefined;
		this.#historyError = undefined;
		this.#render();
		this.#changed();
		const conversation = this.#company.conversation(this.#sessionId).get();
		this.#serverSelection = Boolean(
			this.#native.selectSessionAccount && !conversation.retrySend && !conversation.sending,
		);
		// The cloud's last answer stands until this read lands, so the composer's Login page keeps its
		// tick through a read; sending, the choice and the reasons wait for #busy to clear anyway.
		let serverConnectionId: string | undefined;
		const readConnections = async (): Promise<WebExecutionConnections> => {
			if (this.#serverSelection) {
				serverConnectionId = await this.#native.selectSessionAccount!(this.#sessionId, signal);
				signal.throwIfAborted();
			}
			return this.#native.listConnections(signal);
		};
		const [connections, provenance] = await Promise.allSettled([
			readConnections(),
			this.#room ? Promise.resolve([]) : this.#native.listSessionTurnProvenance(this.#sessionId, signal),
		]);
		if (signal.aborted) return;
		this.#serverConnectionId = serverConnectionId;
		if (connections.status === "fulfilled") {
			this.#observed = connections.value;
			if (this.#failures) this.#error = undefined;
			this.#failures = 0;
		} else {
			this.#observed = undefined;
			this.#failures++;
			this.#error = t("Model accounts are unavailable. Trying again…");
		}
		if (provenance.status === "fulfilled") this.#provenance = provenance.value;
		else {
			this.#provenance = [];
			this.#historyError = t("Execution history is unavailable.");
		}
		this.#busy = false;
		this.#request = undefined;
		this.#choose();
		this.#render();
		this.#changed();
		this.#scheduleRefresh(
			this.#failures
				? ACCOUNT_RETRY_DELAYS_MS[Math.min(this.#failures, ACCOUNT_RETRY_DELAYS_MS.length) - 1]
				: undefined,
		);
		void this.#hydrateUsage();
	}

	async #hydrateUsage(): Promise<void> {
		const company = this.#company.store.get();
		const conversation = this.#company.conversation(this.#sessionId).get();
		if (
			!this.#native.refreshAccountMetadata ||
			!this.#serverSelection ||
			!this.#observed ||
			this.#usageRequest ||
			this.#lifetime.signal.aborted ||
			company.accessLost ||
			!company.team?.capabilities.read ||
			company.sessions.find((session) => session.sessionId === this.#sessionId)?.status !== "open" ||
			conversation.sending ||
			conversation.retrySend ||
			!this.#usageDue(Date.now())
		)
			return;
		const request = new AbortController();
		this.#usageRequest = request;
		const signal = AbortSignal.any([request.signal, this.#lifetime.signal]);
		let refreshed = false;
		try {
			// Usage improves account ranking, but an unavailable refresh host must
			// not prevent the cloud from selecting an already eligible account.
			await this.#native.refreshAccountMetadata(signal);
			signal.throwIfAborted();
			refreshed = true;
		} catch {
			// Eligibility and known usage walls remain enforced by the account read.
		} finally {
			if (this.#usageRequest === request) {
				this.#usageRequest = undefined;
				this.#usageHydratedAt = Date.now();
			}
		}
		if (signal.aborted || !refreshed) return;
		const current = this.#company.conversation(this.#sessionId).get();
		// Let a submission awaiting its account check start before another read.
		// The timer also preserves the sponsor if that send becomes uncertain.
		if (!this.#busy && !current.sending && !current.retrySend) this.#scheduleRefresh(1000);
	}

	/** Usage is asked for once per opened thread and again only once a known
	 * reset has passed since: an idle thread never asks on a clock. Sends in
	 * between keep the account the conversation already has. */
	#usageDue(now: number): boolean {
		const hydratedAt = this.#usageHydratedAt;
		if (hydratedAt === undefined) return true;
		return this.#resets().some((reset) => reset > hydratedAt && reset <= now);
	}

	#resets(): number[] {
		return (this.#observed?.connections ?? [])
			.flatMap((connection) => [
				connection.usageLimitResetAt,
				...(connection.providerAccountUsage?.windows.map((window) => window.resetAt) ?? []),
			])
			.map((reset) => Date.parse(reset ?? ""))
			.filter((reset) => Number.isFinite(reset));
	}

	#scheduleRefresh(maxDelay = 30_000): void {
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
		const nextReset = Math.min(...this.#resets().filter((reset) => reset > now));
		const delay = Math.max(1000, Math.min(maxDelay, nextReset - now + 250));
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = undefined;
			const conversation = this.#company.conversation(this.#sessionId).get();
			// Never replace the account while a write or its exact replay is outstanding.
			if (conversation.sending || conversation.retrySend) {
				this.#scheduleRefresh();
				return;
			}
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
					compareRanks(loginRank(a, now), loginRank(b, now)) || a.connectionId.localeCompare(b.connectionId),
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
		// A conversation keeps an account with room. One at its usage limit, or one that can't
		// pay now (disabled, a new sign-in, disconnected), gives way to the member's own account
		// with the most room (20260930575000); with none, it keeps its account and waits.
		const keeps = kept !== undefined && this.#keeps(kept.connectionId);
		// Follow the conversation's binding to the member's new connection after they
		// sign in again; never to another account. A retry still keeps its exact
		// original request authority.
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
				(kept && keeps && available.includes(kept.connectionId) ? kept.connectionId : available[0]));
		if (!next) return;
		try {
			this.#company.setExecutionSponsor(this.#sessionId, this.#observed, next);
			this.#error = undefined;
		} catch {
			// Sending stays off until the member has a usable account and authority.
		}
	}

	/** What this member's own logins tell of the login behind a sponsor binding (a failed run's payer): whether it is
	 * one of theirs, and when its usage limit resets, from the provider's own usage reading: the latest reset still
	 * ahead of its full windows, as the agent reads it (qorpera_worker_usage_limit_text, 20260930549300). Nothing for
	 * another member's login, which this member's list does not hold, or before the list is read; and never the cloud's
	 * estimate for a limit with no known reset (usageLimitResetAt may be the signal's time plus six hours). */
	payer(sponsorBindingId: string | undefined, now = Date.now()): RunPayer {
		let own = false;
		let resetsAt: string | undefined;
		for (const connection of this.#observed?.connections ?? []) {
			if (!sponsorBindingId || connection.sponsorBindingId !== sponsorBindingId) continue;
			own = true;
			for (const window of connection.providerAccountUsage?.windows ?? []) {
				const at = Date.parse(window.resetAt ?? "");
				if (window.usedPercent >= 100 && at > now && (resetsAt === undefined || at > Date.parse(resetsAt)))
					resetsAt = window.resetAt;
			}
		}
		return own ? { own, ...(resetsAt ? { resetsAt } : {}) } : {};
	}

	/** The member still has this login: listed, and not disconnected (revoked). */
	#keeps(connectionId: string): boolean {
		return (this.#observed?.connections ?? []).some(
			(connection) => connection.connectionId === connectionId && connection.connectionStatus !== "revoked",
		);
	}

	/** The conversation lost its login to a disconnect and waits for the member's own
	 * pick: the cloud answered no account although a login could pay, or (without the
	 * cloud's choice) the kept account is gone. */
	#unchosen(available: readonly string[]): boolean {
		if (!available.length) return false;
		if (this.#serverSelection) return Boolean(this.#native.chooseSessionAccount) && !this.#serverConnectionId;
		const kept = this.#company.conversation(this.#sessionId).get().executionSponsor;
		return kept !== undefined && !this.#keeps(kept.connectionId);
	}

	/** The member's own logins that can pay for this conversation now, in the order and with the names
	 * "Choose a login to continue" gives them, the conversation's own marked: what the composer's Login
	 * page lists. None where the member's pick would not reach the cloud: where the cloud chooses, also
	 * after a read made while a message was on its way, which has no answer from the cloud to move. */
	get logins(): readonly SessionLogin[] {
		const observed = this.#observed;
		if (
			!observed ||
			(this.#native.selectSessionAccount && (!this.#serverSelection || !this.#native.chooseSessionAccount))
		)
			return [];
		const available = this.#available();
		const own = this.#own();
		return available.map((connectionId) => ({
			connectionId,
			account: this.#account(observed, connectionId, available),
			current: connectionId === own,
		}));
	}

	/** No login is picked while a message is on its way, an uncertain retry waits (it keeps its original
	 * login), a pick or a read is outstanding, or the member can't write here. */
	get locked(): boolean {
		const conversation = this.#company.conversation(this.#sessionId).get();
		return this.#busy || conversation.sending || Boolean(conversation.retrySend) || !this.#canWrite();
	}

	/** Why the last read or pick failed, as the line above the composer says it. */
	get error(): string | undefined {
		return this.#error;
	}

	/** The member's pick from the composer's Login page: one of the logins listed there, never while locked. */
	async pick(connectionId: string): Promise<void> {
		if (this.locked || !this.logins.some((login) => login.connectionId === connectionId)) return;
		await this.#pick(connectionId);
	}

	/** The conversation's own login: the cloud's choice where the cloud chooses, else the one it keeps. */
	#own(): string | undefined {
		return this.#serverSelection
			? this.#serverConnectionId
			: this.#company.conversation(this.#sessionId).get().executionSponsor?.connectionId;
	}

	/** A login's name: its account's email, else its number among the logins that can pay. */
	#account(observed: NativeExecutionConnections, connectionId: string, available: readonly string[]): string {
		return (
			observed.connections.find((candidate) => candidate.connectionId === connectionId)?.providerAccountEmail ??
			t("Model account {number}", { number: available.indexOf(connectionId) + 1 })
		);
	}

	#canWrite(): boolean {
		const company = this.#company.store.get();
		return (
			company.team?.capabilities.write === true &&
			company.sessions.find((s) => s.sessionId === this.#sessionId)?.status === "open"
		);
	}

	/** The member's own pick of a login for this conversation: their permission to pay with it. */
	async #pick(connectionId: string): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy || !this.#observed) return;
		if (!this.#serverSelection) {
			try {
				this.#company.setExecutionSponsor(this.#sessionId, this.#observed, connectionId);
				this.#error = undefined;
			} catch {
				this.#error = t("The login could not be chosen. Try again.");
			}
			this.#render();
			this.#changed();
			return;
		}
		this.#busy = true;
		this.#render();
		this.#changed();
		let picked = false;
		try {
			await this.#native.chooseSessionAccount!(this.#sessionId, connectionId, this.#lifetime.signal);
			picked = true;
		} catch {
			this.#error = t("The login could not be chosen. Try again.");
		} finally {
			this.#busy = false;
		}
		if (this.#lifetime.signal.aborted) return;
		if (picked) void this.refresh();
		else {
			this.#render();
			this.#changed();
		}
	}

	#render(): void {
		const conversation = this.#company.conversation(this.#sessionId).get();
		const canWrite = this.#canWrite();
		const selected = conversation.retrySend?.executionSponsor ?? conversation.executionSponsor;
		const locked = this.locked;
		const key = JSON.stringify([
			this.#room,
			this.#observed,
			this.#provenance,
			this.#error,
			this.#historyError,
			selected,
			this.#serverConnectionId,
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
							t(
								"Retry keeps the original model account and message request. The earlier message may already have been accepted. Starting a new request can send it again.",
							),
						),
						button(
							t("Start a new message request"),
							() => {
								if (this.#lifetime.signal.aborted) return;
								try {
									this.#company.discardSendRetry(this.#sessionId);
									if (this.#native.selectSessionAccount) void this.refresh();
									else this.#choose();
									this.#error = undefined;
								} catch {
									this.#error = t("This conversation is unavailable for a new request.");
								}
								this.#render();
								this.#changed();
							},
							{ small: true, disabled: conversation.sending || !canWrite },
						),
					)
				: this.#observed && !this.#error && !this.canSend && !this.#busy
					? this.#unchosen(this.#available())
						? this.#choice(this.#observed, !canWrite)
						: h(
								"div",
								null,
								h("p", { class: "muted" }, this.#unavailableReason(this.#observed)),
								this.#otherLogins(this.#observed, locked),
							)
					: null,
		);
	}

	/** "Choose a login to continue": one button per login of the member's that can pay now. */
	#choice(observed: NativeExecutionConnections, disabled: boolean): HTMLElement {
		const available = this.#available();
		return h(
			"div",
			{ class: "session-execution-choice" },
			h("p", { class: "muted" }, t("Choose a login to continue.")),
			...available.map((connectionId) =>
				button(
					t("Use {account}", { account: this.#account(observed, connectionId, available) }),
					() => void this.#pick(connectionId),
					{ small: true, disabled },
				),
			),
		);
	}

	/** The conversation's own login can't pay now (its usage limit, or disabled) and it was not moved: the
	 * member may still move it to another of their logins that can, by hand (an override; a move to a login
	 * with room happens by itself, 20260930575000). */
	#otherLogins(observed: NativeExecutionConnections, disabled: boolean): HTMLElement | null {
		const own = this.#own();
		// Only under the conversation's own account's reason, and only where the member's pick reaches the cloud.
		if (!own || !observed.connections.some((connection) => connection.connectionId === own)) return null;
		if (this.#serverSelection && !this.#native.chooseSessionAccount) return null;
		const available = this.#available();
		const others = available.filter((connectionId) => connectionId !== own);
		if (!others.length) return null;
		return h(
			"div",
			{ class: "session-execution-choice" },
			h("p", { class: "muted" }, t("Or continue with another of your logins.")),
			// Numbered as "Choose a login to continue" numbers them.
			...others.map((connectionId) =>
				button(
					t("Use {account}", { account: this.#account(observed, connectionId, available) }),
					() => void this.#pick(connectionId),
					{ small: true, disabled },
				),
			),
		);
	}

	/** Why sending is off. A conversation's own account at its limit is named first: none of the
	 * member's other accounts has room either, so the conversation waits until one has. */
	#unavailableReason(observed: NativeExecutionConnections): string {
		const now = Date.now();
		const own = this.#own();
		const atLimit = observed.connections.filter((connection) => remainingAllowance(connection, now) === 0);
		if (own && atLimit.some((connection) => connection.connectionId === own))
			return t(
				"This conversation's model account has reached its usage limit, and your other accounts have no room either. Sending resumes by itself when one has room again.",
			);
		// Kept although it cannot pay now (disabled, a new sign-in, its computer recovering).
		if (own && this.#keeps(own))
			return t(
				"This conversation's model account can't be used right now. Check it in Settings → AI subscriptions.",
			);
		if (atLimit.length)
			return t(
				"Your model accounts have reached their usage limits. Sending resumes by itself when one has room again.",
			);
		return t("Connect a model account in Settings → AI subscriptions to send messages.");
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		this.#request?.abort();
		this.#usageRequest?.abort();
		this.#usageRequest = undefined;
		this.#observed = undefined;
		this.#provenance = [];
		this.el.replaceChildren();
	}
}
