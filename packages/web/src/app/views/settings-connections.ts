import type { NativeMemberConnection } from "@qorpera/cloud-client/cloud-native-subscription-control";
import {
	type ChatGptPlanReturn,
	forgetChatGptPlanSignIn,
	keepChatGptPlanSignIn,
} from "../../cloud/chatgpt-plan-sign-in.ts";
import {
	ChatGptPlanSignInError,
	PlanSwitchBusyError,
	planLogin,
	type WebAccountLogin,
	type WebExecutionConnections,
	type WebMemberConnection,
	type WebNativeProviderLogin,
	type WebNativeSubscription,
} from "../../cloud/native-subscription.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

export type ConnectionsClient = Pick<
	WebNativeSubscription,
	"listConnections" | "revokeConnection" | "createMemberSponsor"
> &
	Partial<
		Pick<
			WebNativeSubscription,
			| "onboardingAvailable"
			| "beginProviderLogin"
			| "refreshAccountMetadata"
			| "setWorkWhileAway"
			| "chatGptPlanAvailable"
			| "beginChatGptPlanSignIn"
			| "finishChatGptPlanSignIn"
			| "listAccountLogins"
			| "signOutEverywhere"
		>
	>;

export type Provider = "openai" | "anthropic";
const PROVIDERS: ReadonlyArray<{ id: Provider; label: string; logo: string }> = [
	{ id: "openai", label: "ChatGPT / Codex", logo: "provider-openai.svg" },
	{ id: "anthropic", label: "Claude", logo: "provider-claude.svg" },
];
const WATCH_MS = 2000;
const USAGE_FRESH_MS = 5 * 60_000;
const UPDATED_MS = 2000;

function resetCountdown(milliseconds: number): string {
	const minutes = Math.ceil(milliseconds / 60_000);
	if (minutes < 60) return t("{minutes}m", { minutes });
	const hours = Math.floor(minutes / 60);
	return hours < 24
		? t("{hours}h {minutes}m", { hours, minutes: minutes % 60 })
		: t("{days}d {hours}h", { days: Math.floor(hours / 24), hours: hours % 24 });
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

/** Provider sign-ins in progress, per member and company, for the life of the tab: Settings and a
 * founding table show the same attempt. */
const SIGN_INS = new Map<string, ProviderSignIns>();
export function memberProviderSignIns(memberId: string, profileId: string): ProviderSignIns {
	const key = `${memberId}:${profileId}`;
	let signIns = SIGN_INS.get(key);
	if (!signIns) {
		signIns = new ProviderSignIns();
		SIGN_INS.set(key, signIns);
	}
	return signIns;
}

/** A "Continue with ChatGPT" return being finished, per member and company. Like a provider
 * sign-in it belongs to the member, not to a page: the confirm (up to 45 s) goes on while Settings
 * closes or the route changes, and its outcome waits until a model accounts page of that company
 * shows it. */
export class PlanSignIn {
	finishing = false;
	result: { connected: true } | { connected: false; reason?: string } | undefined;
	readonly #listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	changed(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}
const PLAN_SIGN_INS = new Map<string, PlanSignIn>();
export function memberPlanSignIn(memberId: string, profileId: string): PlanSignIn {
	const key = `${memberId}:${profileId}`;
	let plan = PLAN_SIGN_INS.get(key);
	if (!plan) {
		plan = new PlanSignIn();
		PLAN_SIGN_INS.set(key, plan);
	}
	return plan;
}

/** Finishes a returned sign-in once (cloud/chatgpt-plan-sign-in.ts). The capability is dropped
 * before the confirm, whatever the vault answers. */
export async function finishPlanSignIn(
	plan: PlanSignIn,
	client: Pick<WebNativeSubscription, "finishChatGptPlanSignIn">,
	outcome: ChatGptPlanReturn,
): Promise<void> {
	forgetChatGptPlanSignIn();
	if (plan.finishing || !client.finishChatGptPlanSignIn) return;
	plan.finishing = true;
	plan.result = undefined;
	plan.changed();
	try {
		await client.finishChatGptPlanSignIn(outcome);
		plan.result = { connected: true };
	} catch (error) {
		plan.result = {
			connected: false,
			...(error instanceof ChatGptPlanSignInError ? { reason: error.reason } : {}),
		};
	} finally {
		plan.finishing = false;
		plan.changed();
	}
}
/** What a ChatGPT plan sign-in's reason means to the member. */
function planReason(reason: string | undefined): string {
	switch (reason) {
		case "other_plan":
			return t("Disconnect your other ChatGPT plan first.");
		case "unavailable":
			return t("Signing in with ChatGPT is not available right now.");
		case "declined":
			return t("The ChatGPT sign-in was cancelled.");
		case "expired":
		case "state_unknown":
			return t("The ChatGPT sign-in took too long. Start it again.");
		case "busy":
			return t("Too many sign-ins are under way. Try again in a few minutes.");
		default:
			return t("The ChatGPT sign-in did not finish. Try again.");
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
	/** The providers "Add account" offers; every connected account is still listed. */
	readonly #offered: ReadonlyArray<(typeof PROVIDERS)[number]>;
	readonly #enabling = new Set<string>();
	#connections: WebExecutionConnections | undefined;
	/** The member's account logins by this company's connection: one sign-in used in all their companies. */
	#accountLogins = new Map<string, WebAccountLogin>();
	/** All of the member's account logins, also those this company does not use. */
	#logins: readonly WebAccountLogin[] = [];
	/** Settings with no company open: only the member's account logins, signed in through `companyName`. */
	readonly #accountWide: { companyName: string } | undefined;
	/** With no company open: how the last ChatGPT sign-in ended when it was not an account login. */
	#outcome: string | undefined;
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
	#metadataForced = false;
	#usageUpdating = false;
	#usageError: string | undefined;
	/** "Continue with ChatGPT": offered while the company may use plan logins, asked when the
	 * member opens Add account (nobody else makes the request). */
	#planChecked = false;
	#planAvailable = false;
	#planStarting = false;
	#planMessage: string | undefined;
	/** The member's plan sign-in for this company; only Settings passes it, so a page without it
	 * (the founding table) never offers "Continue with ChatGPT". */
	readonly #plan: PlanSignIn | undefined;
	readonly #navigate: (url: string) => void;
	/** `signIns` and `begin` come from the application when sign-ins should
	 * outlive this page; alone, the page keeps its own. */
	constructor(
		client: ConnectionsClient,
		signal: AbortSignal,
		signIns = new ProviderSignIns(),
		begin: WebNativeSubscription["beginProviderLogin"] | undefined = client.beginProviderLogin?.bind(client),
		offered: readonly Provider[] = PROVIDERS.map((provider) => provider.id),
		navigate: (url: string) => void = (url) => location.assign(url),
		plan?: PlanSignIn,
		accountWide?: { companyName: string },
	) {
		this.#client = client;
		this.#accountWide = accountWide;
		this.#navigate = navigate;
		this.#plan = offered.includes("openai") ? plan : undefined;
		this.#offered = PROVIDERS.filter((provider) => offered.includes(provider.id));
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
				([...this.#attempts.values()].some((attempt) => attempt.login) || this.#shown().some(live))
			)
				void this.#refreshUsage();
		};
		window.addEventListener("focus", resume, { signal: this.#lifetime.signal });
		document.addEventListener("visibilitychange", resume, { signal: this.#lifetime.signal });
		if (plan) {
			const stopPlan = plan.subscribe(() => {
				if (!this.#lifetime.signal.aborted) this.#takePlanResult();
			});
			this.#lifetime.signal.addEventListener("abort", stopPlan, { once: true });
			// Back from OpenAI through the browser's page cache: the page did not leave after all.
			window.addEventListener(
				"pageshow",
				(event) => {
					if (!event.persisted || !this.#planStarting) return;
					this.#planStarting = false;
					this.#draw();
				},
				{ signal: this.#lifetime.signal },
			);
		}
		// The first usage read lists the accounts, so a result shown now needs no read of its own.
		this.#takePlanResult(false);
		void this.#refreshUsage();
	}
	/** Shows a finished sign-in's outcome here, once, and reads the accounts again. */
	#takePlanResult(read = true): void {
		const plan = this.#plan;
		const result = plan?.finishing ? undefined : plan?.result;
		if (plan && result) {
			plan.result = undefined;
			this.#planMessage = result.connected ? t("Your ChatGPT plan is connected.") : planReason(result.reason);
		}
		this.#draw();
		if (result && read) void this.#refresh();
	}
	async #checkPlan(): Promise<void> {
		if (this.#planChecked || !this.#plan) return;
		this.#planChecked = true;
		try {
			this.#planAvailable = (await this.#client.chatGptPlanAvailable?.(this.#lifetime.signal)) === true;
		} catch {
			this.#planAvailable = false;
		}
		if (!this.#lifetime.signal.aborted && this.#planAvailable) this.#draw();
	}
	/** Sends the browser to OpenAI; it comes back to the page the sign-in began on. */
	async #connectPlan(): Promise<void> {
		if (this.#planStarting || this.#plan?.finishing || this.#lifetime.signal.aborted) return;
		if (!this.#client.beginChatGptPlanSignIn) return;
		this.#planStarting = true;
		this.#planMessage = undefined;
		this.#adding = false;
		this.#draw();
		try {
			const { url, signIn } = await this.#client.beginChatGptPlanSignIn("My model account", this.#lifetime.signal);
			if (keepChatGptPlanSignIn(signIn, location.hash)) {
				this.#navigate(url);
				return;
			}
			// Without the kept sign-in the return could not be finished.
			this.#planMessage = t("The ChatGPT sign-in could not be started. Try again.");
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#planMessage =
				error instanceof ChatGptPlanSignInError
					? planReason(error.reason)
					: t("The ChatGPT sign-in could not be started. Try again.");
		}
		this.#planStarting = false;
		this.#draw();
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
	 * recent one would otherwise answer. A Refresh that joins a background read
	 * makes it forced; it can only join before that read asks for usage, since
	 * the button is greyed out from the read's first redraw. */
	#refreshUsage(force = false): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (!this.#client.refreshAccountMetadata) return this.#refresh();
		this.#metadataForced = (this.#metadataRefresh !== undefined && this.#metadataForced) || force;
		this.#metadataRefresh ??= this.#readUsage();
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
	async #readUsage(): Promise<void> {
		this.#usageUpdating = true;
		this.#usageError = undefined;
		// A read the member did not ask for ends an "Updated" still showing.
		clearTimeout(this.#updatedClock);
		if (this.#updated) {
			this.#updated = false;
			this.#draw();
		}
		try {
			// Show existing account identities while their isolated host refreshes
			// allowances. No sign-in or model message is started by this read.
			await this.#refresh();
			if (this.#lifetime.signal.aborted || !this.#shown().some(live)) return;
			await this.#client.refreshAccountMetadata!(this.#lifetime.signal, this.#metadataForced);
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		} catch {
			if (!this.#lifetime.signal.aborted) this.#usageError = t("Usage could not be refreshed. Try again.");
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
			const latest = new Map<string, WebMemberConnection>();
			for (const connection of observed.connections) {
				const current = latest.get(connection.connectionId);
				if (!current || connection.connectionVersion > current.connectionVersion)
					latest.set(connection.connectionId, connection);
			}
			const connections = { ...observed, connections: [...latest.values()] };
			let accountRead = false;
			if (this.#client.listAccountLogins) {
				try {
					const account = await this.#client.listAccountLogins(this.#lifetime.signal);
					if (this.#lifetime.signal.aborted) return;
					this.#accountLogins = new Map(
						account.logins.flatMap((login) => login.connectionIds.map((id) => [id, login] as const)),
					);
					// A login that was not listed before ends what an earlier sign-in's outcome said.
					const listed = new Set(this.#logins.map((login) => login.loginId));
					if (account.logins.some((login) => !listed.has(login.loginId))) this.#outcome = undefined;
					this.#logins = account.logins;
					accountRead = true;
				} catch {
					// The cards read as this company's own logins until the next read.
					if (this.#lifetime.signal.aborted) return;
				}
			}
			this.#connections = connections;
			this.#error = undefined;
			for (const [provider, attempt] of this.#attempts) {
				const finished = connections.connections.find(
					(item) =>
						item.provider === provider &&
						item.clientConnectionId === attempt.login?.clientConnectionId &&
						live(item),
				);
				if (attempt.login && (finished || Date.parse(attempt.login.expiresAt) <= Date.now())) {
					this.#attempts.delete(provider);
					// With no company open only account logins are listed: say where a company login went, and that a
					// sign-in ended without one.
					if (this.#accountWide && provider === "openai" && !finished)
						this.#outcome = t("The ChatGPT sign-in did not finish. Try again.");
					else if (
						this.#accountWide &&
						provider === "openai" &&
						finished &&
						accountRead &&
						!this.#accountLogins.has(finished.connectionId)
					)
						this.#outcome = t("This subscription was added to {company} only. Open that company to see it.", {
							company: this.#accountWide.companyName,
						});
				}
			}
			void this.#enable();
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("Your model accounts could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	/** Connecting an account is the member's choice to use it for their messages. With no company open nothing is
	 * enabled: an account login comes with its own sponsor in each company, and the company's own logins are not this
	 * page's. */
	async #enable(): Promise<void> {
		const connections = this.#connections;
		if (this.#accountWide || !connections || connections.computeIdentity?.status !== "active") return;
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
						// A Codex login's call is as before; a plan's is never consented.
						...(planLogin(connection) ? { planLogin: true } : {}),
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
		this.#outcome = undefined;
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
			attempt.error = t(
				"Sign-in could not be started. If you started one a moment ago, give it a few minutes to clear.",
			);
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
			this.#error = t("The account could not be disconnected. Try again.");
			this.#draw();
		}
	}
	/** Ends an account login in every company; Disconnect on its card only stops using it here. */
	async #signOutEverywhere(login: WebAccountLogin): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted || !this.#client.signOutEverywhere) return;
		this.#working = `everywhere:${login.loginId}`;
		this.#error = undefined;
		this.#draw();
		let failed = false;
		try {
			await this.#client.signOutEverywhere(login.loginId, this.#lifetime.signal);
		} catch {
			failed = true;
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
		if (failed && !this.#lifetime.signal.aborted && !this.#error) {
			this.#error = t("You could not be signed out everywhere. Try again.");
			this.#draw();
		}
	}
	/** The member's own choice for their ChatGPT plan; nothing else turns it on. */
	async #setAway(connection: WebMemberConnection): Promise<void> {
		if (this.#working || !this.#client.setWorkWhileAway) return;
		this.#working = connection.connectionId;
		this.#error = undefined;
		this.#draw();
		let failed = false;
		let busy = false;
		try {
			await this.#client.setWorkWhileAway(
				connection.connectionId,
				connection.allowAutonomous !== true,
				this.#lifetime.signal,
			);
		} catch (error) {
			failed = true;
			busy = error instanceof PlanSwitchBusyError;
		}
		if (this.#lifetime.signal.aborted) return;
		// The switch stays busy until the cloud's state is read back: part of a failed change may
		// have landed, and a second press must not repeat the first.
		await this.#refresh();
		if (this.#lifetime.signal.aborted) return;
		this.#working = undefined;
		if (failed)
			this.#error = busy
				? t("Busy right now. Try again in a moment.")
				: t("“Work while you're away” could not be changed. Try again.");
		this.#draw();
	}
	/** A ChatGPT plan's switch: off until its member turns it on. */
	#away(connection: WebMemberConnection): HTMLElement | null {
		if (!planLogin(connection) || !live(connection) || !this.#client.setWorkWhileAway) return null;
		const on = connection.allowAutonomous === true;
		const lever = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-checked": String(on),
			"aria-label": t("Work while you're away"),
			onclick: () => void this.#setAway(connection),
		});
		if (this.#working) lever.setAttribute("aria-disabled", "true");
		if (this.#working === connection.connectionId) lever.setAttribute("aria-busy", "true");
		lever.dataset.focusKey = `away:${connection.connectionId}`;
		return h(
			"div",
			{ class: "connection-away" },
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, t("Work while you're away")),
				h(
					"small",
					null,
					t(
						"Your agents may use this plan for routines while you're away. Routines that start on a webhook or a file change never use it.",
					),
				),
			),
			lever,
		);
	}
	/** `showAdded`: another card reads the same, so this one says when it was added. */
	#account(connection: WebMemberConnection, showAdded: boolean): HTMLElement {
		const provider = PROVIDERS.find((item) => item.id === connection.provider)!;
		const email = connection.providerAccountEmail;
		// An account login is used in all the member's companies: Disconnect here only stops using it here.
		const account = this.#accountLogins.get(connection.connectionId);
		const signOut = button(
			this.#working === connection.connectionId
				? account
					? t("Stopping…")
					: t("Signing out…")
				: account
					? t("Stop using here")
					: t("Sign out"),
			() => void this.#disconnect(connection),
			{ disabled: Boolean(this.#working) },
		);
		signOut.dataset.focusKey = `signout:${connection.connectionId}`;
		const everywhere =
			account && this.#client.signOutEverywhere
				? button(
						this.#working === `everywhere:${account.loginId}`
							? t("Signing out everywhere…")
							: t("Sign out everywhere"),
						() => void this.#signOutEverywhere(account),
						{ disabled: Boolean(this.#working) },
					)
				: null;
		if (everywhere) everywhere.dataset.focusKey = `everywhere:${account?.loginId}`;
		return h(
			"article",
			{ class: "connection-card", dataset: { connectionId: connection.connectionId } },
			h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, planLogin(connection) ? t("ChatGPT plan") : provider.label),
				h("small", { class: "connection-email" }, email ?? t("Email unavailable")),
				showAdded
					? h(
							"small",
							{ class: "connection-identity", title: t("Connection {id}", { id: connection.connectionId }) },
							t("Added {time} · {id}", {
								time: fmtTime(connection.consentedAt),
								id: connection.connectionId.slice(-8),
							}),
						)
					: null,
				account ? h("small", { class: "connection-scope" }, t("Used in all your companies")) : null,
				!live(connection)
					? h("small", { role: "status" }, t("Sign out and add this account again to reconnect."))
					: null,
			),
			h("div", { class: "connection-actions" }, signOut, everywhere),
			this.#usage(connection),
			this.#away(connection),
		);
	}
	/** With no company open: an account login, its usage read through the sign-in company's link when that company
	 * uses it. Only Sign out everywhere; "Stop using here" needs a company. */
	#login(login: WebAccountLogin): HTMLElement {
		const connection = this.#connections?.connections.find(
			(item) => login.connectionIds.includes(item.connectionId) && item.connectionStatus !== "revoked",
		);
		const working = this.#working === `everywhere:${login.loginId}`;
		const everywhere = button(
			working ? t("Signing out everywhere…") : t("Sign out everywhere"),
			() => void this.#signOutEverywhere(login),
			{ disabled: Boolean(this.#working) || !this.#client.signOutEverywhere },
		);
		everywhere.dataset.focusKey = `everywhere:${login.loginId}`;
		const usable = login.status === "active" && (!connection || live(connection));
		return h(
			"article",
			{ class: "connection-card", dataset: { loginId: login.loginId } },
			h("img", { class: "connection-logo", src: "./assets/provider-openai.svg", alt: "" }),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, PROVIDERS[0]!.label),
				h("small", { class: "connection-email" }, login.providerAccountEmail ?? t("Email unavailable")),
				h("small", { class: "connection-scope" }, t("Used in all your companies")),
				usable ? null : h("small", { role: "status" }, t("Sign out and add this account again to reconnect.")),
			),
			h("div", { class: "connection-actions" }, everywhere),
			connection ? this.#usage(connection) : h("div", { class: "connection-usage muted" }, t("Usage unavailable")),
		);
	}
	/** The connections whose usage this page shows: with no company open, only the account logins' links. */
	#shown(): readonly WebMemberConnection[] {
		const connections = this.#connections?.connections ?? [];
		return this.#accountWide
			? connections.filter((connection) => this.#accountLogins.has(connection.connectionId))
			: connections;
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
					t("Usage limit reached · resets in {time}", { time: resetCountdown(limitResetIn) }),
				)
			: null;
		if (!usage || !live(connection))
			return h("div", { class: "connection-usage muted" }, limitNotice ?? t("Usage unavailable"));
		const stale =
			limitReached || now - Date.parse(usage.observedAt) > USAGE_FRESH_MS || Date.parse(usage.observedAt) > now;
		const checked = fmtTime(usage.observedAt);
		// An old reading never says "left" (the limit may be reached since) but says
		// when it was taken, unless the host's clock ran ahead of this one.
		const dated = Date.parse(usage.observedAt) <= now;
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
				const value = expired
					? t("Usage unavailable")
					: stale
						? dated
							? t("{percent}% at last check · {time}", { percent: remaining, time: checked })
							: t("{percent}% at last check", { percent: remaining })
						: t("{percent}% left", { percent: remaining });
				const fill = h("span");
				// CSSOM property updates work with the release CSP; style attributes do not.
				fill.style.width = `${remaining}%`;
				return h(
					"div",
					{ class: "connection-usage-window" },
					// The meter's own label names it for screen readers.
					named ? h("span", { class: "connection-usage-label", "aria-hidden": "true" }, window.label) : null,
					h(
						"div",
						{ class: "connection-usage-heading" },
						h(
							"span",
							{ class: "connection-usage-reset", title: window.resetAt ? fmtTime(window.resetAt) : undefined },
							expired
								? t("Reset passed · awaiting updated usage")
								: resetIn === undefined
									? t("Reset time unavailable")
									: t("Resets in {time}", { time: resetCountdown(resetIn) }),
						),
						h("span", { title: t("Last checked {time}", { time: checked }) }, value),
					),
					expired
						? null
						: h(
								"div",
								{
									class: `connection-usage-meter${remaining <= 20 ? " is-low" : ""}${stale ? " is-stale" : ""}`,
									role: "meter",
									"aria-label": t("{label} remaining usage", { label: window.label }),
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
			? t("Preparing sign-in. The first time can take a minute or two.")
			: attempt.login
				? t("Waiting for you to finish signing in…")
				: (attempt.error ?? t("Sign-in has not finished."));
		const action = attempt.login
			? button(t("Cancel"), () => {
					this.#attempts.delete(provider.id);
					this.#signIns.changed();
					this.el.querySelector<HTMLButtonElement>(".connection-add")?.focus();
				})
			: button(attempt.starting ? t("Connecting…") : t("Try again"), () => void this.#connect(provider.id), {
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
						login.userCode ? h("p", null, `${t("Your code:")} `, h("code", null, login.userCode)) : null,
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
									t("Open {provider} sign-in", {
										provider: provider.id === "openai" ? "OpenAI" : "Anthropic",
									}),
								)
							: null,
						h("small", null, t("This page updates by itself when you are done.")),
					)
				: null,
		);
	}
	#draw(): void {
		clearTimeout(this.#usageClock);
		if (this.#shown().some(live))
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
		for (const key of accounts.map(lookalike)) lookalikes.set(key, (lookalikes.get(key) ?? 0) + 1);
		const canConnect = Boolean(this.#client.onboardingAvailable && this.#begin);
		const accountWide = Boolean(this.#accountWide);
		// With no company open the cards are the member's account logins, whichever companies use them.
		const cards = accountWide
			? this.#logins.map((login) => this.#login(login))
			: accounts.map((connection) => this.#account(connection, (lookalikes.get(lookalike(connection)) ?? 0) > 1));
		// Greyed out, not disabled: a disabled button would drop keyboard focus
		// to "Add account" at the read's first redraw. A press checks the state
		// the button was drawn in, so one before a background read's first
		// redraw still joins that read and makes it forced.
		const busy = this.#loading || this.#usageUpdating;
		const refresh = button(
			this.#usageUpdating ? t("Refreshing…") : this.#updated ? t("Updated") : t("Refresh"),
			() => {
				if (!busy) void this.#refreshNow();
			},
			{ small: true },
		);
		if (busy) refresh.setAttribute("aria-disabled", "true");
		refresh.dataset.focusKey = "refresh";
		// With no company open there is one choice: a ChatGPT subscription, signed in at once (no Claude for chat).
		const openai = this.#attempts.get("openai");
		const add = accountWide
			? button(t("Add ChatGPT subscription"), () => void this.#connect("openai"), {
					disabled: this.#loading || !canConnect || Boolean(openai?.starting || openai?.login),
				})
			: button(
					t("Add account"),
					() => {
						this.#adding = !this.#adding;
						if (this.#adding) void this.#checkPlan();
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
		if (!accountWide) {
			add.setAttribute("aria-expanded", String(this.#adding));
			add.setAttribute("aria-controls", "connection-provider-picker");
		}
		replace(
			this.el,
			h(
				"section",
				{ class: "settings-group" },
				h("div", { class: "connection-section-heading" }, h("h2", null, t("Model accounts")), refresh),
				accountWide
					? h(
							"p",
							{ class: "connection-note muted" },
							t("A ChatGPT subscription you add here is used in all your companies."),
						)
					: null,
				this.#usageError ? h("p", { class: "muted", role: "status" }, this.#usageError) : null,
				this.#outcome ? h("p", { class: "muted", role: "status" }, this.#outcome) : null,
				this.#error
					? h(
							"p",
							{ class: "muted", role: "status" },
							this.#error,
							" ",
							button(t("Try again"), () => void this.#refresh(), { small: true }),
						)
					: null,
				h(
					"div",
					{ class: "connection-list" },
					...cards,
					// With no company open, only a ChatGPT sign-in (one begun on the company's own page may be Claude's).
					...PROVIDERS.flatMap((provider) => {
						const attempt = this.#attempts.get(provider.id);
						return attempt && (!accountWide || provider.id === "openai")
							? [this.#attempt(provider, attempt)]
							: [];
					}),
					this.#planStarting || this.#plan?.finishing || this.#planMessage
						? h(
								"p",
								{ class: "connection-plan muted", role: "status" },
								this.#planStarting
									? t("Opening ChatGPT…")
									: this.#plan?.finishing
										? t("Finishing your ChatGPT sign-in…")
										: this.#planMessage,
							)
						: null,
					this.#loading
						? h("p", { class: "connection-empty muted", role: "status" }, t("Checking…"))
						: !cards.length && !(accountWide ? openai : this.#attempts.size) && !this.#error
							? h("p", { class: "connection-empty muted" }, t("No model accounts connected."))
							: null,
					h(
						"div",
						{ class: "connection-add-area" },
						add,
						!canConnect ? h("small", { class: "muted" }, t("Adding accounts is not available yet.")) : null,
						accountWide
							? null
							: h(
									"div",
									{
										id: "connection-provider-picker",
										class: "connection-provider-picker",
										hidden: !this.#adding,
									},
									h("p", null, t("Choose a model provider")),
									...this.#offered.map((provider) => {
										const choice = button(
											[
												h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
												provider.label,
											],
											() => void this.#connect(provider.id),
											{
												disabled: Boolean(
													this.#attempts.get(provider.id)?.starting ||
														this.#attempts.get(provider.id)?.login,
												),
											},
										);
										choice.dataset.focusKey = `provider:${provider.id}`;
										return choice;
									}),
									// A member has one ChatGPT plan; with a signed-in one, it is not offered again.
									this.#planAvailable &&
										!accounts.some((connection) => planLogin(connection) && live(connection))
										? (() => {
												const choice = button(
													[
														h("img", {
															class: "connection-logo",
															src: "./assets/provider-openai.svg",
															alt: "",
														}),
														t("Continue with ChatGPT"),
													],
													() => void this.#connectPlan(),
													{ disabled: this.#planStarting || this.#plan?.finishing === true },
												);
												choice.dataset.focusKey = "provider:chatgpt-plan";
												return choice;
											})()
										: null,
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
