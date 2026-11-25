import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { withAbortScopes } from "../../cloud/abort-scope.ts";
import type {
	WebClaudeLogin,
	WebExecutionConnections,
	WebMemberConnection,
	WebNativeSubscription,
} from "../../cloud/native-subscription.ts";
import { selectSessionExecutionSponsor } from "../../cloud/session-input.ts";
import { withReply } from "../../cloud/wall-reply.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";
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

const refusedSignIn = (connection: NativeMemberConnection): boolean =>
	(connection as WebMemberConnection).loginStatus === "needs_sign_in";

function compareRanks(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < a.length; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
}

const SVG = "http://www.w3.org/2000/svg";

function usageRing(done: boolean): SVGSVGElement {
	const ring = document.createElementNS(SVG, "svg");
	ring.setAttribute("class", done ? "usage-wall-ring done" : "usage-wall-ring");
	ring.setAttribute("viewBox", "0 0 24 24");
	ring.setAttribute("aria-hidden", "true");
	const shapes: [string, Record<string, string>][] = [
		["circle", { cx: "12", cy: "12", r: "9", class: "track" }],
		done
			? ["path", { d: "m8 12.5 2.6 2.6L16 9.6", class: "tick" }]
			: ["circle", { cx: "12", cy: "12", r: "9", class: "fill" }],
	];
	for (const [tag, attributes] of shapes) {
		const shape = document.createElementNS(SVG, tag);
		for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
		ring.append(shape);
	}
	return ring;
}

function usageCard(
	title: string,
	detail: string | undefined,
	done: boolean,
	actions: readonly HTMLElement[],
): HTMLElement {
	return h(
		"div",
		{ class: "usage-wall" },
		usageRing(done),
		h(
			"div",
			{ class: "usage-wall-text" },
			h("p", { class: "usage-wall-title" }, title),
			detail ? h("p", { class: "usage-wall-sub" }, detail) : null,
		),
		actions.length ? h("div", { class: "usage-wall-actions" }, ...actions) : null,
	);
}

/** The waits before reading the accounts again after a read failed: 2 s, 5 s, 10 s, 30 s, then every minute. Coming
 * back to the window or online reads at once. (3 Nov 2026: the composer stayed locked on "Model accounts are
 * unavailable" until the page was reloaded.) */
export const ACCOUNT_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];

const CLAUDE_READ_EVERY_MS = 60_000;
const EXECUTION_CACHE_TTL_MS = 30_000;

interface ExecutionCache {
	connections?: { value: WebExecutionConnections; at: number };
	sessionAccounts: Map<string, { connectionId: string | undefined; at: number }>;
}

const executionCaches = new WeakMap<CompanyController, ExecutionCache>();

function executionCacheFor(company: CompanyController): ExecutionCache {
	let cache = executionCaches.get(company);
	if (!cache) {
		cache = { sessionAccounts: new Map() };
		executionCaches.set(company, cache);
		if (company.signal.aborted) executionCaches.delete(company);
		else company.signal.addEventListener("abort", () => executionCaches.delete(company), { once: true });
	}
	return cache;
}

function invalidateExecutionCache(company: CompanyController, sessionId?: string): void {
	const cache = executionCaches.get(company);
	if (!cache) return;
	cache.connections = undefined;
	if (sessionId) cache.sessionAccounts.delete(sessionId);
	else cache.sessionAccounts.clear();
}

/** One of the member's logins that can pay for a conversation, as the composer's Login page lists it. */
export interface SessionLogin {
	readonly connectionId: string;
	/** The account's email, else "Model account N". */
	readonly account: string;
	/** The login the conversation is bound to now. */
	readonly current: boolean;
}

/** A conversation keeps its own account, also at its usage limit, and only the member moves a
 * conversation to another account (founder decision 2026-10-04, migration 20260930059000). At
 * the limit a message may still be sent: it waits in the cloud and goes on by itself, on the
 * same account, once the limit resets (2026-11-05, migration 20260930575000). New conversations choose the member's account that
 * works and has the most room on one scale (loginRank, migration 20260930559000). */
export class SessionExecutionView {
	readonly el = h("div", { class: "session-execution" });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #native: WebNativeSubscription;
	readonly #changed: () => void;
	readonly #lifetime = new AbortController();
	#request: AbortController | undefined;
	#observed: WebExecutionConnections | undefined;
	#started = false;
	#busy = false;
	#inFlight: "blocking" | "background" | undefined;
	#error: string | undefined;
	#renderKey = "";
	#room = false;
	#serverSelection = false;
	#serverConnectionId: string | undefined;
	#usageHydratedAt: number | undefined;
	#usageRequest: AbortController | undefined;
	#refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** Account reads that failed in a row; the next read waits by ACCOUNT_RETRY_DELAYS_MS. */
	#failures = 0;
	#sameLogin: { connectionId: string; count: number } | undefined;
	#countedFor: string | undefined;
	#countRequest: AbortController | undefined;
	#moved: { login: string | undefined; stuck: boolean; done: boolean; title: string; detail?: string } | undefined;
	#claudeOut: { login: WebClaudeLogin; until: string; next: WebClaudeLogin } | undefined;
	#claudeMoved: { loginId: string; account: string } | undefined;
	#claudeSwitching = false;
	#claudeReadAt: number | undefined;

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
				retry.text === withReply(conversation.answering, (conversation.draft ?? "").trim(), files.length) &&
				retry.files.length === files.length &&
				retry.files.every((file, index) => file === files[index])
			);
		if (!conversation.executionSponsor || !this.#observed || this.#busy) return false;
		if (this.#serverSelection && conversation.executionSponsor.connectionId !== this.#serverConnectionId)
			return false;
		if (!this.#sendable().includes(conversation.executionSponsor.connectionId)) return false;
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
			this.#busy = false;
			this.#inFlight = undefined;
			this.#started = false;
			this.#room = room;
			executionCaches.get(this.#company)?.sessionAccounts.delete(this.#sessionId);
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
			this.#started = false;
			this.#busy = false;
			this.#inFlight = undefined;
			if (company.accessLost) executionCaches.delete(this.#company);
			this.#usageHydratedAt = undefined;
			this.#usageRequest?.abort();
			this.#usageRequest = undefined;
			this.el.replaceChildren();
			this.#renderKey = "";
			return;
		}
		if (!this.#started) {
			this.#started = true;
			const cache = executionCacheFor(this.#company);
			const now = Date.now();
			const cachedConnections =
				cache.connections && now - cache.connections.at < EXECUTION_CACHE_TTL_MS
					? cache.connections.value
					: undefined;
			const conversation = this.#company.conversation(this.#sessionId).get();
			const serverSelection = Boolean(
				this.#native.selectSessionAccount && !conversation.retrySend && !conversation.sending,
			);
			const cachedAccount = cache.sessionAccounts.get(this.#sessionId);
			const freshAccount = cachedAccount !== undefined && now - cachedAccount.at < EXECUTION_CACHE_TTL_MS;
			if (cachedConnections && (!serverSelection || freshAccount)) {
				// WHY: Hydrate synchronously from the company cache so switching back to a thread unlocks Send at 0 ms.
				this.#observed = cachedConnections;
				this.#serverSelection = serverSelection;
				this.#serverConnectionId = serverSelection ? cachedAccount?.connectionId : undefined;
				this.#choose();
				void this.refresh({ background: true, useCachedConnections: true });
			} else if (cachedConnections) {
				void this.refresh({ useCachedConnections: true });
			} else {
				void this.refresh();
			}
		}
		this.#render();
	}

	async refresh(options?: { background?: boolean; useCachedConnections?: boolean }): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy) return;
		if (this.#inFlight === "background") {
			if (options?.background) return;
			this.#request?.abort();
			this.#request = undefined;
			this.#inFlight = undefined;
		}
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
		const background = options?.background === true && this.#observed !== undefined;
		let readClaude = false;
		await withAbortScopes([request.signal, this.#lifetime.signal], async (signal) => {
			this.#inFlight = background ? "background" : "blocking";
			if (!background) {
				this.#busy = true;
				// The line that says the accounts are unavailable stays while they are read again, instead of blinking.
				if (!this.#failures) this.#error = undefined;
				this.#render();
				this.#changed();
			}
			const conversation = this.#company.conversation(this.#sessionId).get();
			this.#serverSelection = Boolean(
				this.#native.selectSessionAccount && !conversation.retrySend && !conversation.sending,
			);
			const cache = executionCacheFor(this.#company);
			const cachedConnections =
				options?.useCachedConnections &&
				cache.connections &&
				Date.now() - cache.connections.at < EXECUTION_CACHE_TTL_MS
					? cache.connections.value
					: undefined;
			// The cloud's last answer stands until this read lands, so the composer's Login page keeps its
			// tick through a read; sending, the choice and the reasons wait for #busy to clear anyway.
			let serverConnectionId: string | undefined;
			let fetchedConnections = false;
			const readConnections = async (): Promise<WebExecutionConnections> => {
				if (!this.#serverSelection) {
					if (cachedConnections) return cachedConnections;
					fetchedConnections = true;
					return this.#native.listConnections(signal);
				}
				if (cachedConnections) {
					serverConnectionId = await this.#native.selectSessionAccount!(this.#sessionId, signal);
					signal.throwIfAborted();
					if (
						!serverConnectionId ||
						cachedConnections.connections.some((connection) => connection.connectionId === serverConnectionId)
					)
						return cachedConnections;
					fetchedConnections = true;
					return this.#native.listConnections(signal);
				}
				// WHY: selectSessionAccount only reads bindings on steady state, so fetch selection and connections in parallel.
				fetchedConnections = true;
				const [selected, connections] = await Promise.all([
					this.#native.selectSessionAccount!(this.#sessionId, signal),
					this.#native.listConnections(signal),
				]);
				signal.throwIfAborted();
				serverConnectionId = selected;
				return connections;
			};
			const connections = await readConnections().catch(() => undefined);
			if (signal.aborted) {
				if (this.#request === request) {
					this.#busy = false;
					this.#inFlight = undefined;
					this.#request = undefined;
				}
				return;
			}
			this.#serverConnectionId = serverConnectionId;
			const observedAt = Date.now();
			if (connections) {
				this.#observed = connections;
				if (fetchedConnections) cache.connections = { value: connections, at: observedAt };
				if (this.#serverSelection)
					cache.sessionAccounts.set(this.#sessionId, { connectionId: serverConnectionId, at: observedAt });
				if (this.#failures) this.#error = undefined;
				this.#failures = 0;
			} else {
				this.#observed = undefined;
				invalidateExecutionCache(this.#company, this.#sessionId);
				this.#failures++;
				this.#error = t("Model accounts are unavailable. Trying again…");
			}
			this.#busy = false;
			this.#inFlight = undefined;
			this.#request = undefined;
			this.#choose();
			this.#settleMoved();
			void this.#countSameLogin();
			this.#render();
			this.#changed();
			this.#scheduleRefresh(
				this.#failures
					? ACCOUNT_RETRY_DELAYS_MS[Math.min(this.#failures, ACCOUNT_RETRY_DELAYS_MS.length) - 1]
					: undefined,
			);
			void this.#hydrateUsage();
			readClaude = this.#claudeReadAt === undefined || Date.now() - this.#claudeReadAt >= CLAUDE_READ_EVERY_MS;
		});
		if (readClaude && !request.signal.aborted && !this.#lifetime.signal.aborted)
			void this.#readClaude(request.signal);
	}

	async #readClaude(requestSignal: AbortSignal): Promise<void> {
		if (!this.#native.listClaudeLogins) return;
		this.#claudeReadAt = Date.now();
		await withAbortScopes([requestSignal, this.#lifetime.signal], async (signal) => {
			let logins: readonly WebClaudeLogin[];
			try {
				logins = (await this.#native.listClaudeLogins!(signal)).logins;
			} catch {
				return;
			}
			if (signal.aborted) return;
			const now = Date.now();
			const usedUp = (login: WebClaudeLogin) =>
				login.usedUpUntil !== undefined && Date.parse(login.usedUpUntil) > now;
			const inUse = logins.find((login) => login.inUse);
			const next = inUse && usedUp(inUse) ? logins.find((login) => login !== inUse && !usedUp(login)) : undefined;
			this.#claudeOut = inUse?.usedUpUntil && next ? { login: inUse, until: inUse.usedUpUntil, next } : undefined;
			if (this.#claudeMoved && (inUse?.loginId !== this.#claudeMoved.loginId || usedUp(inUse)))
				this.#claudeMoved = undefined;
			this.#render();
		});
	}

	async #useClaude(next: WebClaudeLogin): Promise<void> {
		if (!this.#native.useClaude || this.#claudeSwitching || this.#lifetime.signal.aborted) return;
		this.#claudeSwitching = true;
		this.#render();
		try {
			await this.#native.useClaude(next.loginId, this.#lifetime.signal);
			this.#claudeMoved = {
				loginId: next.loginId,
				account: next.providerAccountEmail ?? t("your other Claude login"),
			};
			this.#claudeOut = undefined;
		} catch {
			this.#error = t("The Claude login could not be switched. Try again.");
		} finally {
			this.#claudeSwitching = false;
		}
		if (!this.#lifetime.signal.aborted) this.#render();
	}

	#claudeCard(): HTMLElement | null {
		if (this.#claudeMoved) {
			const card = usageCard(
				t("New Claude work now uses {account}", { account: this.#claudeMoved.account }),
				undefined,
				true,
				[],
			);
			card.setAttribute("role", "status");
			return card;
		}
		const out = this.#claudeOut;
		if (!out) return null;
		const other = out.next.providerAccountEmail ?? t("your other Claude login");
		return usageCard(
			t("Claude is out of usage until {time}", { time: fmtTime(out.until) }),
			t("{account} is used up. Keep going with {other}", {
				account: out.login.providerAccountEmail ?? t("Your Claude login"),
				other,
			}),
			false,
			[
				button(t("Continue"), () => void this.#useClaude(out.next), {
					small: true,
					primary: true,
					disabled: this.#claudeSwitching,
					title: t("Use {account}", { account: other }),
				}),
			],
		);
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
		await withAbortScopes([request.signal, this.#lifetime.signal], async (signal) => {
			let refreshed = false;
			try {
				// Usage improves account ranking, but an unavailable refresh host must
				// not prevent the cloud from selecting an already eligible account.
				// The accounts were read just now: the refresh asks about those, not the cloud again.
				await this.#native.refreshAccountMetadata!(signal, false, this.#observed);
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
		});
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
			// A hidden tab asks on no clock (a tab left open asked twice a minute all night): nothing is on screen to send
			// from, and its first moment back reads the accounts (the constructor's listeners). The timer stays armed, for
			// a return no event told of.
			if (document.visibilityState === "hidden") {
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
				if (remainingAllowance(connection, now) === 0 || refusedSignIn(connection)) return false;
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

	/** The conversation's own login while it is at its usage limit, still the member's and able to pay otherwise: a
	 * message sent on it waits in the cloud and goes on by itself, on the same login, once the limit resets
	 * (20260930575000). Undefined otherwise. */
	#waiting(): string | undefined {
		const observed = this.#observed;
		const own = this.#own();
		if (!observed || !own || !this.#keeps(own)) return undefined;
		const connection = observed.connections.find((candidate) => candidate.connectionId === own);
		if (!connection || refusedSignIn(connection) || remainingAllowance(connection, Date.now()) !== 0)
			return undefined;
		try {
			selectSessionExecutionSponsor(observed, own, this.#company.userId);
			return own;
		} catch {
			return undefined;
		}
	}

	/** The logins a message may be sent on: those that can pay now, and the conversation's own at its usage limit. */
	#sendable(): string[] {
		const available = this.#available();
		const waiting = this.#waiting();
		return waiting && !available.includes(waiting) ? [...available, waiting] : available;
	}

	#choose(): void {
		const conversation = this.#company.conversation(this.#sessionId).get();
		if (!this.#observed || conversation.sending || conversation.retrySend) return;
		// A conversation waiting at its limit still follows its binding to the member's new connection (below).
		if (
			this.canSend &&
			(!this.#serverSelection || conversation.executionSponsor?.connectionId === this.#serverConnectionId) &&
			(this.#serverSelection || this.#waiting() === undefined)
		)
			return;
		const available = this.#available();
		const sendable = this.#sendable();
		const kept = conversation.executionSponsor;
		// A conversation keeps its account even when it cannot pay now (also while an
		// owner or admin has it disabled). One the member disconnected leaves it with no
		// account until the member picks another by hand (#unchosen); only a new
		// conversation takes a first choice.
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
			? this.#serverConnectionId && sendable.includes(this.#serverConnectionId)
				? this.#serverConnectionId
				: undefined
			: (handedOff?.connectionId ??
				(kept ? (keeps && sendable.includes(kept.connectionId) ? kept.connectionId : undefined) : available[0]));
		// A conversation waiting at its limit on the login it already has keeps everything as it is.
		if (!next || (next === kept?.connectionId && !handedOff && this.canSend)) return;
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

	/** The logins a run that stopped at its usage limit may go on with, from its card ("Continue with …"): those the
	 * Login page lists, less the login that paid for the run, and only those `accepts` takes (a move of a waiting run has
	 * rules of its own). None unless that login is this member's own: only the member whose login paid chooses where the
	 * work goes on, and only with their own logins that can pay now. */
	continueLogins(
		sponsorBindingId: string | undefined,
		accepts: (connection: WebMemberConnection) => boolean = () => true,
	): readonly SessionLogin[] {
		const connections = this.#observed?.connections ?? [];
		const paid = new Set(
			connections
				.filter((connection) => sponsorBindingId !== undefined && connection.sponsorBindingId === sponsorBindingId)
				.map((connection) => connection.connectionId),
		);
		if (!paid.size) return [];
		return this.logins.filter((login) => {
			const connection = connections.find((candidate) => candidate.connectionId === login.connectionId);
			return !paid.has(login.connectionId) && connection !== undefined && accepts(connection);
		});
	}

	/** The member's pick of one of the logins `continueLogins` offers, for this conversation, as the Login page picks
	 * it. Answers whether the conversation now pays with that login, once the cloud's choice is read again: the
	 * member's next message here runs on it. */
	async continueWith(connectionId: string): Promise<boolean> {
		if (this.locked || !this.logins.some((login) => login.connectionId === connectionId)) return false;
		if (this.#own() !== connectionId && !(await this.#pick(connectionId))) return false;
		return !this.#lifetime.signal.aborted && this.#own() === connectionId && this.canSend;
	}

	#stuckLogin(): string | undefined {
		const own = this.#own();
		const available = this.#available();
		if (
			!own ||
			!this.#serverSelection ||
			!this.#native.chooseSessionAccount ||
			!this.#native.countSessionsOnAccount ||
			!this.#native.chooseSessionsAccount ||
			!this.#observed?.connections.some((connection) => connection.connectionId === own) ||
			available.includes(own) ||
			!available.length
		)
			return undefined;
		return own;
	}

	async #countSameLogin(): Promise<void> {
		const own = this.#stuckLogin();
		if (own === this.#countedFor) return;
		this.#countRequest?.abort();
		this.#countRequest = undefined;
		this.#countedFor = own;
		this.#sameLogin = undefined;
		if (!own || !this.#native.countSessionsOnAccount) return;
		const request = new AbortController();
		this.#countRequest = request;
		await withAbortScopes([request.signal, this.#lifetime.signal], async (signal) => {
			let count: number | undefined;
			try {
				count = await this.#native.countSessionsOnAccount!(own, signal);
			} catch {
				count = undefined;
			}
			if (signal.aborted) return;
			this.#countRequest = undefined;
			if (count === undefined) this.#countedFor = undefined;
			else this.#sameLogin = { connectionId: own, count };
			this.#render();
		});
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

	/** The member's own pick of a login for this conversation: their permission to pay with it. Answers whether it was
	 * taken; the cloud's choice has been read again by then. */
	async #pick(connectionId: string): Promise<boolean> {
		if (this.#lifetime.signal.aborted || this.#busy || !this.#observed) return false;
		this.#moved = undefined;
		if (!this.#serverSelection) {
			let picked = false;
			try {
				this.#company.setExecutionSponsor(this.#sessionId, this.#observed, connectionId);
				this.#error = undefined;
				picked = true;
			} catch {
				this.#error = t("The login could not be chosen. Try again.");
			}
			this.#render();
			this.#changed();
			return picked;
		}
		this.#busy = true;
		this.#render();
		this.#changed();
		let picked = false;
		try {
			await this.#native.chooseSessionAccount!(this.#sessionId, connectionId, this.#lifetime.signal);
			invalidateExecutionCache(this.#company, this.#sessionId);
			picked = true;
		} catch {
			this.#error = t("The login could not be chosen. Try again.");
		} finally {
			this.#busy = false;
		}
		if (this.#lifetime.signal.aborted) return false;
		if (picked) await this.refresh();
		else {
			this.#render();
			this.#changed();
		}
		return picked;
	}

	async #pickAll(fromConnectionId: string, connectionId: string, account: string): Promise<void> {
		if (this.locked || this.#lifetime.signal.aborted || !this.#native.chooseSessionsAccount) return;
		this.#busy = true;
		this.#moved = undefined;
		this.#render();
		this.#changed();
		let moved: number | undefined;
		try {
			moved = await this.#native.chooseSessionsAccount(fromConnectionId, connectionId, this.#lifetime.signal);
			invalidateExecutionCache(this.#company);
		} catch {
			this.#error = t("The chats could not be moved. Try again.");
		} finally {
			this.#busy = false;
		}
		if (this.#lifetime.signal.aborted) return;
		if (moved === undefined) {
			this.#render();
			this.#changed();
			return;
		}
		this.#sameLogin = undefined;
		this.#countedFor = undefined;
		await this.refresh();
		if (this.#lifetime.signal.aborted) return;
		const login = this.#own();
		const stuck = login === fromConnectionId;
		const title =
			moved === 0
				? stuck
					? this.#outOfUsage(fromConnectionId)
					: t("No chats were waiting on that login any more.")
				: stuck
					? moved === 1
						? t("{count} other chat moved to {account}", { count: moved, account })
						: t("{count} other chats moved to {account}", { count: moved, account })
					: moved === 1
						? t("{count} chat moved to {account}", { count: moved, account })
						: t("{count} chats moved to {account}", { count: moved, account });
		this.#moved = {
			login,
			stuck,
			done: moved > 0 || !stuck,
			title,
			...(stuck
				? {
						detail: t("This chat stays on its login: the work waiting in it can't move to {account}.", {
							account,
						}),
					}
				: {}),
		};
		this.#render();
	}

	#render(): void {
		if (this.#company.store.get().team?.role === "viewer") {
			if (this.#renderKey !== "spectator") replace(this.el);
			this.#renderKey = "spectator";
			return;
		}
		const conversation = this.#company.conversation(this.#sessionId).get();
		const canWrite = this.#canWrite();
		const selected = conversation.retrySend?.executionSponsor ?? conversation.executionSponsor;
		const locked = this.locked;
		const key = JSON.stringify([
			this.#room,
			this.#observed,
			this.#error,
			selected,
			this.#serverConnectionId,
			locked,
			this.#busy,
			conversation.sending,
			Boolean(conversation.retrySend),
			this.canSend,
			this.#sameLogin,
			this.#moved,
			this.#claudeOut,
			this.#claudeMoved,
			this.#claudeSwitching,
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
				: (this.#movedCard() ??
						(this.#observed && !this.#error && this.canSend && !this.#busy && this.#waiting() !== undefined
							? this.#usageWall(this.#observed, locked, true)
							: this.#observed && !this.#error && !this.canSend && !this.#busy
								? this.#unchosen(this.#available())
									? this.#choice(this.#observed, !canWrite)
									: (this.#usageWall(this.#observed, locked, false) ??
										h("p", { class: "muted" }, this.#unavailableReason(this.#observed)))
								: this.#claudeCard())),
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

	#outOfUsage(connectionId: string): string {
		const connection = this.#observed?.connections.find((candidate) => candidate.connectionId === connectionId);
		const reset = connection ? this.payer(connection.sponsorBindingId).resetsAt : undefined;
		return reset ? t("Out of usage until {time}", { time: fmtTime(reset) }) : t("Out of usage");
	}

	#usageWall(observed: NativeExecutionConnections, disabled: boolean, waiting: boolean): HTMLElement[] | null {
		const own = this.#own();
		const connection = observed.connections.find((candidate) => candidate.connectionId === own);
		if (!own || !connection || !this.#keeps(own)) return null;
		const atLimit = !refusedSignIn(connection) && remainingAllowance(connection, Date.now()) === 0;
		const available = this.#available();
		const name = (connectionId: string) => this.#account(observed, connectionId, available);
		const [first, ...rest] =
			this.#serverSelection && !this.#native.chooseSessionAccount
				? []
				: available.filter((connectionId) => connectionId !== own);
		const count = this.#sameLogin?.connectionId === own ? this.#sameLogin.count : 0;
		const actions = !first
			? []
			: count > 1 && this.#stuckLogin() === own
				? [
						button(t("All {count} chats", { count }), () => void this.#pickAll(own, first, name(first)), {
							small: true,
							primary: true,
							disabled,
							title: t("Use {account} for all {count} chats waiting on this login", {
								account: name(first),
								count,
							}),
						}),
						button(t("Just this one"), () => void this.#pick(first), {
							small: true,
							disabled,
							title: t("Use {account}", { account: name(first) }),
						}),
					]
				: [
						button(t("Continue"), () => void this.#pick(first), {
							small: true,
							primary: true,
							disabled,
							title: t("Use {account}", { account: name(first) }),
						}),
					];
		const detail = first
			? t("Keep going with {account}", { account: name(first) })
			: atLimit
				? waiting
					? t("A message you send now goes on when it resets.")
					: t("Sending resumes when it resets.")
				: undefined;
		const [before = "", after = ""] = t("Or use {accounts}").split("{accounts}");
		return [
			usageCard(atLimit ? this.#outOfUsage(own) : this.#unavailableReason(observed), detail, false, actions),
			rest.length
				? h(
						"p",
						{ class: "usage-wall-more" },
						before,
						...rest.flatMap((connectionId, index) => [
							index ? ", " : null,
							h(
								"button",
								{
									type: "button",
									class: "usage-wall-link",
									disabled,
									onclick: () => void this.#pick(connectionId),
								},
								name(connectionId),
							),
						]),
						after,
					)
				: null,
		].filter((element): element is HTMLElement => element !== null);
	}

	#settleMoved(): void {
		const moved = this.#moved;
		if (!moved) return;
		const stuck = this.#stuckLogin();
		if (
			moved.login !== this.#own() ||
			(moved.stuck ? stuck !== moved.login : stuck !== undefined || !this.canSend || this.#waiting() !== undefined)
		)
			this.#moved = undefined;
	}

	#movedCard(): HTMLElement | null {
		const moved = this.#moved;
		if (
			!moved ||
			moved.login !== this.#own() ||
			(moved.stuck ? this.#stuckLogin() !== moved.login : !this.canSend || this.#waiting() !== undefined)
		)
			return null;
		const card = usageCard(moved.title, moved.detail, moved.done, []);
		card.setAttribute("role", "status");
		return card;
	}

	#unavailableReason(observed: NativeExecutionConnections): string {
		const now = Date.now();
		const own = this.#own();
		const atLimit = observed.connections.filter((connection) => remainingAllowance(connection, now) === 0);
		const refused = observed.connections.filter(
			(connection) => connection.connectionStatus !== "revoked" && refusedSignIn(connection),
		);
		const signIn = refused.find((connection) => connection.connectionId === own) ?? refused[0];
		const signInAgain = signIn?.providerAccountEmail
			? t("ChatGPT no longer accepts the sign-in for {email}. Sign in again in Settings → AI subscriptions.", {
					email: signIn.providerAccountEmail,
				})
			: t("ChatGPT no longer accepts this login's sign-in. Sign in again in Settings → AI subscriptions.");
		if (signIn && signIn.connectionId === own) return signInAgain;
		// Kept although it cannot pay now (disabled, a new sign-in, its computer recovering).
		if (own && this.#keeps(own))
			return t(
				"This conversation's model account can't be used right now. Check it in Settings → AI subscriptions.",
			);
		if (signIn) return signInAgain;
		if (atLimit.length)
			return t("Your model accounts have reached their usage limits. Sending resumes when an account resets.");
		return t("Connect a model account in Settings → AI subscriptions to send messages.");
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#refreshTimer);
		this.#refreshTimer = undefined;
		this.#request?.abort();
		this.#inFlight = undefined;
		this.#usageRequest?.abort();
		this.#usageRequest = undefined;
		this.#observed = undefined;
		this.el.replaceChildren();
	}
}
