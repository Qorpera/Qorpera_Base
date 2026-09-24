import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";

type ConnectionsClient = Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor"> &
	Partial<Pick<WebNativeSubscription, "onboardingAvailable" | "beginProviderLogin" | "refreshAccountMetadata">>;

type Provider = "openai" | "anthropic";
const PROVIDERS: ReadonlyArray<{ id: Provider; label: string; logo: string }> = [
	{ id: "openai", label: "ChatGPT / Codex", logo: "provider-openai.svg" },
	{ id: "anthropic", label: "Claude", logo: "provider-anthropic.svg" },
];
const WATCH_MS = 2000;
const USAGE_FRESH_MS = 5 * 60_000;
const UPDATED_MS = 2000;

function resetCountdown(milliseconds: number): string {
	const minutes = Math.ceil(milliseconds / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

interface Attempt {
	login?: WebNativeProviderLogin;
	error?: string;
	starting: boolean;
}

/** Sign-ins in progress outlive the page that started them: a node may spend a
 * minute building the member's runner, and the settings page can be rebuilt or
 * closed meanwhile. A rebuilt page picks the same attempt up again. */
export class ProviderSignIns {
	readonly attempts = new Map<Provider, Attempt>();
	readonly #listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

const live = (connection: NativeMemberConnection) =>
	connection.connectionStatus === "active" && connection.authorizationState === "active";
/** Cards with the same provider and email read the same. */
const lookalike = (connection: NativeMemberConnection) =>
	`${connection.provider}\n${connection.providerAccountEmail?.toLowerCase() ?? ""}`;

/** Accounts share one list; provider selection belongs to adding an account.
 * A connected account is enabled for the member's own messages right away. */
export class ConnectionsView {
	readonly el = h("div");
	readonly #client: ConnectionsClient;
	readonly #lifetime = new AbortController();
	readonly #begin: WebNativeSubscription["beginProviderLogin"] | undefined;
	readonly #signIns: ProviderSignIns;
	readonly #attempts: Map<Provider, Attempt>;
	readonly #enabling = new Set<string>();
	#connections: NativeExecutionConnections | undefined;
	#loading = true;
	#adding = false;
	#working: string | undefined;
	#error: string | undefined;
	#watch: ReturnType<typeof setTimeout> | undefined;
	#usageClock: ReturnType<typeof setTimeout> | undefined;
	#updatedClock: ReturnType<typeof setTimeout> | undefined;
	#updated = false;
	#refreshing: Promise<void> | undefined;
	#refreshAgain = false;
	#metadataRefresh: Promise<void> | undefined;
	#usageUpdating = false;
	#usageError: string | undefined;
	/** `signIns` and `begin` come from the application when sign-ins should
	 * outlive this page; alone, the page keeps its own. */
	constructor(
		client: ConnectionsClient,
		signal: AbortSignal,
		signIns = new ProviderSignIns(),
		begin: WebNativeSubscription["beginProviderLogin"] | undefined = client.beginProviderLogin?.bind(client),
	) {
		this.#client = client;
		this.#signIns = signIns;
		this.#attempts = signIns.attempts;
		this.#begin = begin;
		const stop = signIns.subscribe(() => {
			if (this.#lifetime.signal.aborted) return;
			this.#draw();
			if ([...this.#attempts.values()].some((attempt) => attempt.login)) void this.#refresh();
		});
		this.#lifetime.signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		const resume = () => {
			if (
				!document.hidden &&
				this.el.isConnected &&
				([...this.#attempts.values()].some((attempt) => attempt.login) || this.#connections?.connections.some(live))
			)
				void this.#refreshUsage();
		};
		window.addEventListener("focus", resume, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", resume, { signal: this.#lifetime.signal });
		this.#draw();
		void this.#refreshUsage();
	}
	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#watch);
		clearTimeout(this.#usageClock);
		clearTimeout(this.#updatedClock);
		this.#connections = undefined;
		this.el.replaceChildren();
		this.el.remove();
	}
	#refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		clearTimeout(this.#watch);
		this.#refreshAgain = true;
		this.#refreshing ??= this.#readUntilCurrent();
		return this.#refreshing;
	}
	/** `force` is the member's own Refresh: a new observation even while a
	 * recent one would otherwise answer. */
	#refreshUsage(force = false): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (!this.#client.refreshAccountMetadata) return this.#refresh();
		this.#metadataRefresh ??= this.#readUsage(force);
		return this.#metadataRefresh;
	}
	/** The member's Refresh reads "Updated" for a moment once the new reading is
	 * in; an unchanged reading would otherwise look as if nothing happened. */
	async #refreshNow(): Promise<void> {
		clearTimeout(this.#updatedClock);
		this.#updated = false;
		await this.#refreshUsage(true);
		if (this.#lifetime.signal.aborted || this.#error || this.#usageError) return;
		// A second click during the same read ends here too; keep one clock.
		clearTimeout(this.#updatedClock);
		this.#updated = true;
		this.#draw();
		this.#updatedClock = setTimeout(() => {
			this.#updated = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}, UPDATED_MS);
	}
	async #readUsage(force: boolean): Promise<void> {
		this.#usageUpdating = true;
		this.#usageError = undefined;
		try {
			// Show existing account identities while their isolated host refreshes
			// allowances. No sign-in or model message is started by this read.
			await this.#refresh();
			if (this.#lifetime.signal.aborted || !this.#connections?.connections.some(live)) return;
			await this.#client.refreshAccountMetadata!(this.#lifetime.signal, force);
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		} catch {
			if (!this.#lifetime.signal.aborted) this.#usageError = "Usage could not be refreshed. Try again.";
		} finally {
			this.#usageUpdating = false;
			this.#metadataRefresh = undefined;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	async #readUntilCurrent(): Promise<void> {
		try {
			// Changes during a read need one fresh read afterwards. Keep a single
			// request in flight so a slow response cannot overwrite newer accounts.
			do {
				this.#refreshAgain = false;
				await this.#readConnections();
			} while (this.#refreshAgain && !this.#lifetime.signal.aborted);
		} finally {
			this.#refreshing = undefined;
			if (!this.#lifetime.signal.aborted && [...this.#attempts.values()].some((attempt) => attempt.login))
				this.#watch = setTimeout(() => void this.#refresh(), WATCH_MS);
		}
	}
	async #readConnections(): Promise<void> {
		try {
			const observed = await this.#client.listConnections(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			// Historical credential versions are not separate accounts and must
			// not be enabled again when a newer version has replaced them.
			const latest = new Map<string, NativeMemberConnection>();
			for (const connection of observed.connections) {
				const current = latest.get(connection.connectionId);
				if (!current || connection.connectionVersion > current.connectionVersion)
					latest.set(connection.connectionId, connection);
			}
			const connections = { ...observed, connections: [...latest.values()] };
			this.#connections = connections;
			this.#error = undefined;
			for (const [provider, attempt] of this.#attempts)
				if (
					attempt.login &&
					(connections.connections.some(
						(item) =>
							item.provider === provider &&
							item.clientConnectionId === attempt.login?.clientConnectionId &&
							live(item),
					) ||
						Date.parse(attempt.login.expiresAt) <= Date.now())
				)
					this.#attempts.delete(provider);
			void this.#enable();
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = "Your model accounts could not be read.";
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	/** Connecting an account is the member's choice to use it for their messages. */
	async #enable(): Promise<void> {
		const connections = this.#connections;
		if (!connections || connections.computeIdentity?.status !== "active") return;
		for (const connection of connections.connections) {
			const key = `${connection.connectionId}:${connection.connectionVersion}`;
			if (
				connection.sponsorBindingId ||
				!live(connection) ||
				connection.policy.implementationStatus !== "supported" ||
				connection.policy.enablementStatus !== "enabled" ||
				this.#enabling.has(key)
			)
				continue;
			this.#enabling.add(key);
			try {
				await this.#client.createMemberSponsor(
					{
						providerConnectionId: connection.connectionId,
						providerConnectionVersion: connection.connectionVersion,
						allowAutonomous: false,
					},
					this.#lifetime.signal,
				);
				if (!this.#lifetime.signal.aborted) void this.#refresh();
			} catch {
				// The card still lists the account; the conversation says so if it still cannot send.
			}
		}
	}
	async #connect(provider: Provider): Promise<void> {
		const begin = this.#begin;
		const attempts = this.#attempts,
			signIns = this.#signIns;
		if (
			this.#lifetime.signal.aborted ||
			!this.#client.onboardingAvailable ||
			!begin ||
			attempts.get(provider)?.starting ||
			attempts.get(provider)?.login
		)
			return;
		const attempt: Attempt = { starting: true };
		this.#adding = false;
		attempts.set(provider, attempt);
		signIns.changed();
		this.el.querySelector<HTMLElement>(`[data-focus-key="status:${provider}"]`)?.focus();
		try {
			// Every start is a new sign-in with its own identity; a start is never replayed.
			attempt.login = await begin({
				provider,
				displayName: "My model account",
				clientIdentityId: crypto.randomUUID(),
				clientLoginId: crypto.randomUUID(),
				clientConnectionId: crypto.randomUUID(),
			});
		} catch {
			attempt.error =
				"Sign-in could not be started. If you started one a moment ago, give it a few minutes to clear.";
		} finally {
			attempt.starting = false;
		}
		// The page that started this may be gone; whichever page is open now redraws.
		if (attempts.get(provider) === attempt) signIns.changed();
	}
	async #disconnect(connection: NativeMemberConnection): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connection.connectionId;
		this.#draw();
		let failed = false;
		try {
			await this.#client.revokeConnection({ providerConnectionId: connection.connectionId }, this.#lifetime.signal);
		} catch {
			failed = true;
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
		// A successful re-read clears errors, so say it only after the read still shows the account.
		if (
			failed &&
			!this.#lifetime.signal.aborted &&
			!this.#error &&
			this.#connections?.connections.some(
				(item) => item.connectionId === connection.connectionId && item.connectionStatus !== "revoked",
			)
		) {
			this.#error = "The account could not be disconnected. Try again.";
			this.#draw();
		}
	}
	/** `lookalike`: another card reads the same, so this one says when it was added. */
	#account(connection: NativeMemberConnection, lookalike: boolean): HTMLElement {
		const provider = PROVIDERS.find((item) => item.id === connection.provider)!;
		const email = connection.providerAccountEmail;
		const signOut = button(
			this.#working === connection.connectionId ? "Signing out…" : "Sign out",
			() => void this.#disconnect(connection),
			{ disabled: Boolean(this.#working) },
		);
		signOut.dataset.focusKey = `signout:${connection.connectionId}`;
		return h(
			"article",
			{ class: "connection-card", dataset: { connectionId: connection.connectionId } },
			h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, provider.label),
				h("small", { class: "connection-email" }, email ?? "Email unavailable"),
				lookalike
					? h(
							"small",
							{ class: "connection-identity", title: `Connection ${connection.connectionId}` },
							`Added ${fmtTime(connection.consentedAt)} · ${connection.connectionId.slice(-8)}`,
						)
					: null,
				!live(connection)
					? h("small", { role: "status" }, "Sign out and add this account again to reconnect.")
					: null,
			),
			h("div", { class: "connection-actions" }, signOut),
			this.#usage(connection),
		);
	}
	#usage(connection: NativeMemberConnection): HTMLElement {
		const usage = connection.providerAccountUsage;
		const now = Date.now();
		const limitResetIn = connection.usageLimitResetAt ? Date.parse(connection.usageLimitResetAt) - now : 0;
		const limitReached = live(connection) && limitResetIn > 0;
		const limitNotice = limitReached
			? h(
					"span",
					{ class: "connection-usage-limit" },
					`Usage limit reached · resets in ${resetCountdown(limitResetIn)}`,
				)
			: null;
		if (!usage || !live(connection))
			return h("div", { class: "connection-usage muted" }, limitNotice ?? "Usage unavailable");
		const stale =
			limitReached || now - Date.parse(usage.observedAt) > USAGE_FRESH_MS || Date.parse(usage.observedAt) > now;
		const checked = fmtTime(usage.observedAt);
		// One bar needs no name; two (5 hours and Weekly) would look alike without one.
		const named = usage.windows.length > 1;
		return h(
			"div",
			{ class: "connection-usage" },
			limitNotice,
			...usage.windows.map((window) => {
				const resetIn = window.resetAt ? Date.parse(window.resetAt) - now : undefined;
				const expired = resetIn !== undefined && resetIn <= 0;
				const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
				const value = expired ? "Usage unavailable" : `${remaining}% left${stale ? ` as of ${checked}` : ""}`;
				const fill = h("span");
				// CSSOM property updates work with the release CSP; style attributes do not.
				fill.style.width = `${remaining}%`;
				return h(
					"div",
					{ class: "connection-usage-window" },
					named ? h("span", { class: "connection-usage-label" }, window.label) : null,
					h(
						"div",
						{ class: "connection-usage-heading" },
						h(
							"span",
							{ class: "connection-usage-reset", title: window.resetAt ? fmtTime(window.resetAt) : undefined },
							expired
								? "Reset passed · awaiting updated usage"
								: resetIn === undefined
									? "Reset time unavailable"
									: `Resets in ${resetCountdown(resetIn)}`,
						),
						h("span", { title: `Last checked ${checked}` }, value),
					),
					expired
						? null
						: h(
								"div",
								{
									class: `connection-usage-meter${remaining <= 20 ? " is-low" : ""}${stale ? " is-stale" : ""}`,
									role: "meter",
									"aria-label": `${window.label} remaining usage`,
									"aria-valuemin": 0,
									"aria-valuemax": 100,
									"aria-valuenow": remaining,
									"aria-valuetext": value,
								},
								fill,
							),
				);
			}),
		);
	}
	#attempt(provider: (typeof PROVIDERS)[number], attempt: Attempt): HTMLElement {
		const canConnect = Boolean(this.#client.onboardingAvailable && this.#begin);
		const status = attempt.starting
			? "Preparing sign-in. The first time can take a minute or two."
			: attempt.login
				? "Waiting for you to finish signing in…"
				: (attempt.error ?? "Sign-in has not finished.");
		const action = attempt.login
			? button("Cancel", () => {
					this.#attempts.delete(provider.id);
					this.#signIns.changed();
					this.el.querySelector<HTMLButtonElement>(".connection-add")?.focus();
				})
			: button(attempt.starting ? "Connecting…" : "Try again", () => void this.#connect(provider.id), {
					disabled: !canConnect || this.#loading || attempt.starting,
				});
		action.dataset.focusKey = `attempt:${provider.id}`;
		const login = attempt.login;
		return h(
			"article",
			{ class: "connection-card connection-attempt" },
			h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, provider.label),
				h("small", { role: "status", tabindex: -1, dataset: { focusKey: `status:${provider.id}` } }, status),
			),
			action,
			login && (login.interactionUrl || login.userCode)
				? h(
						"div",
						{ class: "connection-sign-in" },
						login.userCode ? h("p", null, "Your code: ", h("code", null, login.userCode)) : null,
						login.interactionUrl
							? h(
									"a",
									{
										class: "btn btn-primary",
										href: login.interactionUrl,
										target: "_blank",
										rel: "noopener noreferrer",
										referrerpolicy: "no-referrer",
										dataset: { focusKey: `login:${provider.id}` },
									},
									`Open ${provider.id === "openai" ? "OpenAI" : "Anthropic"} sign-in`,
								)
							: null,
						h("small", null, "This page updates by itself when you are done."),
					)
				: null,
		);
	}
	#draw(): void {
		clearTimeout(this.#usageClock);
		if (this.#connections?.connections.some(live))
			this.#usageClock = setTimeout(() => {
				if (document.hidden) this.#draw();
				else void this.#refreshUsage();
			}, 60_000);
		const focusKey = this.el.contains(document.activeElement)
			? (document.activeElement as HTMLElement).dataset.focusKey
			: undefined;
		const accounts = (this.#connections?.connections ?? []).filter(
			(connection) =>
				connection.connectionStatus !== "revoked" &&
				PROVIDERS.some((provider) => provider.id === connection.provider) &&
				![...this.#attempts.values()].some(
					(attempt) => attempt.login?.clientConnectionId === connection.clientConnectionId && !live(connection),
				),
		);
		const lookalikes = new Map<string, number>();
		for (const connection of accounts)
			lookalikes.set(lookalike(connection), (lookalikes.get(lookalike(connection)) ?? 0) + 1);
		const canConnect = Boolean(this.#client.onboardingAvailable && this.#begin);
		const refresh = button(
			this.#usageUpdating ? "Refreshing…" : this.#updated ? "Updated" : "Refresh",
			() => void this.#refreshNow(),
			{ small: true, disabled: this.#loading || this.#usageUpdating },
		);
		refresh.dataset.focusKey = "refresh";
		const add = button(
			"Add account",
			() => {
				this.#adding = !this.#adding;
				this.#draw();
				this.el
					.querySelector<HTMLButtonElement>(
						this.#adding ? ".connection-provider-picker button:not(:disabled)" : ".connection-add",
					)
					?.focus();
			},
			{ disabled: this.#loading || !canConnect },
		);
		add.classList.add("connection-add");
		add.dataset.focusKey = "add";
		add.setAttribute("aria-expanded", String(this.#adding));
		add.setAttribute("aria-controls", "connection-provider-picker");
		replace(
			this.el,
			h("h1", null, "Connections"),
			h(
				"section",
				{ class: "settings-group" },
				h("div", { class: "connection-section-heading" }, h("h2", null, "Model accounts"), refresh),
				this.#usageError ? h("p", { class: "muted", role: "status" }, this.#usageError) : null,
				this.#error
					? h(
							"p",
							{ class: "muted", role: "status" },
							this.#error,
							" ",
							button("Try again", () => void this.#refresh(), { small: true }),
						)
					: null,
				h(
					"div",
					{ class: "connection-list" },
					...accounts.map((connection) =>
						this.#account(connection, (lookalikes.get(lookalike(connection)) ?? 0) > 1),
					),
					...PROVIDERS.flatMap((provider) => {
						const attempt = this.#attempts.get(provider.id);
						return attempt ? [this.#attempt(provider, attempt)] : [];
					}),
					this.#loading
						? h("p", { class: "connection-empty muted", role: "status" }, "Checking…")
						: !accounts.length && !this.#attempts.size && !this.#error
							? h("p", { class: "connection-empty muted" }, "No model accounts connected.")
							: null,
					h(
						"div",
						{ class: "connection-add-area" },
						add,
						!canConnect ? h("small", { class: "muted" }, "Adding accounts is not available yet.") : null,
						h(
							"div",
							{ id: "connection-provider-picker", class: "connection-provider-picker", hidden: !this.#adding },
							h("p", null, "Choose a model provider"),
							...PROVIDERS.map((provider) => {
								const choice = button(
									[
										h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
										provider.label,
									],
									() => void this.#connect(provider.id),
									{
										disabled: Boolean(
											this.#attempts.get(provider.id)?.starting || this.#attempts.get(provider.id)?.login,
										),
									},
								);
								choice.dataset.focusKey = `provider:${provider.id}`;
								return choice;
							}),
						),
					),
				),
			),
		);
		if (focusKey) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === focusKey,
			);
			(target && !target.closest("[hidden]") && !target.matches(":disabled")
				? target
				: this.el.querySelector<HTMLButtonElement>(".connection-add")
			)?.focus();
		}
	}
}
