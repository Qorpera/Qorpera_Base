import type {
	NativeExecutionConnections,
	NativeMemberConnection,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { button, h, replace } from "../../ui/dom.ts";

type ConnectionsClient = Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor"> &
	Partial<Pick<WebNativeSubscription, "onboardingAvailable" | "beginProviderLogin">>;

type Provider = "openai" | "anthropic";
const PROVIDERS: ReadonlyArray<{ id: Provider; label: string; logo: string }> = [
	{ id: "openai", label: "ChatGPT / Codex", logo: "provider-openai.svg" },
	{ id: "anthropic", label: "Claude", logo: "provider-anthropic.svg" },
];
const WATCH_MS = 5000;

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

/** One card per provider: connect, finish the provider's own sign-in, done.
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
	#working: string | undefined;
	#error: string | undefined;
	#watch: ReturnType<typeof setTimeout> | undefined;
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
		this.#draw();
		void this.#refresh();
	}
	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#watch);
		this.#connections = undefined;
		this.el.replaceChildren();
		this.el.remove();
	}
	#current(provider: Provider): NativeMemberConnection | undefined {
		const mine = (this.#connections?.connections ?? []).filter(
			(item) => item.provider === provider && item.connectionStatus !== "revoked",
		);
		return mine.find(live) ?? mine[0];
	}
	async #refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return;
		clearTimeout(this.#watch);
		try {
			const connections = await this.#client.listConnections(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#connections = connections;
			this.#error = undefined;
			for (const [provider, attempt] of this.#attempts)
				if (
					attempt.login &&
					(connections.connections.some(
						(item) => item.connectionId === attempt.login?.connectionId && live(item),
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
			if (!this.#lifetime.signal.aborted) {
				this.#draw();
				// While a provider sign-in is open, watch for it to finish.
				if ([...this.#attempts.values()].some((attempt) => attempt.login))
					this.#watch = setTimeout(() => void this.#refresh(), WATCH_MS);
			}
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
				// Shown as "Connected"; the conversation says so if it still cannot send.
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
			attempts.get(provider)?.starting
		)
			return;
		const attempt: Attempt = { starting: true };
		attempts.set(provider, attempt);
		signIns.changed();
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
			this.#connections?.connections.some((item) => item.connectionId === connection.connectionId && live(item))
		) {
			this.#error = "The account could not be disconnected. Try again.";
			this.#draw();
		}
	}
	#card(provider: (typeof PROVIDERS)[number]): HTMLElement {
		const connection = this.#current(provider.id);
		const attempt = this.#attempts.get(provider.id);
		const canConnect = Boolean(this.#client.onboardingAvailable && this.#begin);
		const connected = connection && live(connection);
		const status = attempt?.starting
			? "Preparing sign-in. The first time can take a minute or two."
			: attempt?.login
				? "Waiting for you to finish signing in…"
				: (attempt?.error ??
					(this.#loading
						? "Checking…"
						: connected
							? `Connected${connection.providerAccountReference ? ` · ${connection.providerAccountReference}` : ""}`
							: connection
								? "Sign in again to keep using this account"
								: canConnect
									? "Not connected"
									: "Not available yet"));
		const action = connected
			? button(
					this.#working === connection.connectionId ? "Disconnecting…" : "Disconnect",
					() => void this.#disconnect(connection),
					{ disabled: Boolean(this.#working) },
				)
			: attempt?.login
				? button("Cancel", () => {
						this.#attempts.delete(provider.id);
						this.#signIns.changed();
					})
				: button(
						attempt?.starting ? "Connecting…" : connection ? "Sign in again" : "Connect",
						() => void this.#connect(provider.id),
						{
							disabled: !canConnect || this.#loading || attempt?.starting === true,
						},
					);
		const login = attempt?.login;
		return h(
			"article",
			{ class: "connection-card" },
			h("img", { class: "connection-logo", src: `./assets/${provider.logo}`, alt: "" }),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, provider.label),
				h("small", { role: "status" }, status),
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
		replace(
			this.el,
			h("h1", null, "Connections"),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, "Model accounts"),
				this.#error
					? h(
							"p",
							{ class: "muted", role: "status" },
							this.#error,
							" ",
							button("Try again", () => void this.#refresh(), { small: true }),
						)
					: null,
				h("div", { class: "connection-list" }, ...PROVIDERS.map((provider) => this.#card(provider))),
			),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, "Services"),
				h(
					"div",
					{ class: "settings-card" },
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, "Connect your tools"),
						h("small", null, "Not available yet"),
					),
					h("button", { type: "button", class: "btn", disabled: true }, "Add service"),
				),
			),
		);
	}
}
