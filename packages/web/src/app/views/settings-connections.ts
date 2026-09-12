import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeProviderLogin, WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";

type ConnectionsClient = Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor"> &
	Partial<Pick<WebNativeSubscription, "onboardingAvailable" | "beginProviderLogin">>;

/** Member connections and provider sign-in use the shared SDK through the configured browser gateway. */
export class ConnectionsView {
	readonly el = h("div");
	readonly #client: ConnectionsClient;
	readonly #lifetime = new AbortController();
	readonly #enableOperations = new Map<string, string>();
	#connections: NativeExecutionConnections | undefined;
	#busy = false;
	#refreshRequired = false;
	#error: string | undefined;
	#message: string | undefined;
	#login: WebNativeProviderLogin | undefined;
	#loginExpiry: ReturnType<typeof setTimeout> | undefined;
	constructor(client: ConnectionsClient, signal: AbortSignal) {
		this.#client = client;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.#refresh();
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#connections = undefined;
		this.#enableOperations.clear();
		this.#clearLogin();
		this.el.replaceChildren();
		this.el.remove();
	}
	async #refresh(): Promise<void> {
		if (this.#busy || this.#lifetime.signal.aborted) return;
		this.#busy = true;
		this.#error = undefined;
		this.#draw();
		try {
			const connections = await this.#client.listConnections(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#connections = connections;
			this.#refreshRequired = false;
			this.#message = undefined;
			if (
				this.#login &&
				connections.connections.some(
					(connection) =>
						connection.connectionId === this.#login?.connectionId &&
						connection.connectionStatus === "active" &&
						connection.authorizationState === "active",
				)
			) {
				this.#clearLogin();
				this.#message = "Model account connected. Enable it for your messages when ready.";
			}
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#connections = undefined;
			this.#refreshRequired = true;
			this.#error = "Model accounts are unavailable. Refresh to check your connections.";
		} finally {
			this.#busy = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	#clearLogin(): void {
		clearTimeout(this.#loginExpiry);
		this.#loginExpiry = undefined;
		this.#login = undefined;
	}
	async #beginLogin(provider: "openai" | "anthropic"): Promise<void> {
		if (
			this.#busy ||
			this.#refreshRequired ||
			this.#login ||
			this.#lifetime.signal.aborted ||
			!this.#client.onboardingAvailable ||
			!this.#client.beginProviderLogin
		)
			return;
		this.#busy = true;
		this.#error = undefined;
		this.#message = "Preparing provider sign-in…";
		this.#draw();
		try {
			const login = await this.#client.beginProviderLogin(
				{
					provider,
					displayName: "My model account",
					clientIdentityId: crypto.randomUUID(),
					clientLoginId: crypto.randomUUID(),
					clientConnectionId: crypto.randomUUID(),
				},
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#login = login;
			this.#message =
				login.status === "completed"
					? "Provider sign-in completed. Refresh model accounts to confirm the connection."
					: "Finish signing in with your provider, then refresh model accounts.";
			this.#loginExpiry = setTimeout(
				() => {
					if (this.#lifetime.signal.aborted) return;
					this.#clearLogin();
					this.#refreshRequired = true;
					this.#message = "Sign-in instructions expired. Refresh model accounts before starting another attempt.";
					this.#draw();
				},
				Math.max(0, Math.min(2_147_483_647, Date.parse(login.expiresAt) - Date.now())),
			);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#clearLogin();
			this.#message = undefined;
			this.#error = "Sign-in could not be confirmed. Refresh model accounts before starting a new sign-in attempt.";
		} finally {
			this.#busy = false;
			this.#refreshRequired = true;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	async #mutate(connectionId: string, action: "revoke" | "enable"): Promise<void> {
		if (this.#busy || this.#refreshRequired || this.#lifetime.signal.aborted) return;
		const connection = this.#connections?.connections.find((item) => item.connectionId === connectionId);
		if (!connection || connection.connectionStatus === "revoked") return;
		if (
			action === "enable" &&
			(connection.sponsorBindingId ||
				connection.connectionStatus !== "active" ||
				connection.authorizationState !== "active" ||
				connection.policy.implementationStatus !== "supported" ||
				connection.policy.enablementStatus !== "enabled" ||
				this.#connections?.computeIdentity?.status !== "active")
		)
			return;
		this.#busy = true;
		this.#message = undefined;
		this.#error = undefined;
		this.#draw();
		try {
			if (action === "revoke")
				await this.#client.revokeConnection({ providerConnectionId: connectionId }, this.#lifetime.signal);
			else {
				const key = `${connectionId}:${connection.connectionVersion}`;
				const operationId = this.#enableOperations.get(key) ?? crypto.randomUUID();
				this.#enableOperations.set(key, operationId);
				await this.#client.createMemberSponsor(
					{
						clientBindingId: operationId,
						providerConnectionId: connectionId,
						providerConnectionVersion: connection.connectionVersion,
						allowAutonomous: false,
					},
					this.#lifetime.signal,
				);
			}
			if (this.#lifetime.signal.aborted) return;
			this.#message =
				action === "revoke"
					? "Connection revoked. Refresh to read the current account state."
					: "Account enabled for your messages. Refresh to read its current state.";
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = "The account change could not be confirmed. Refresh before trying again.";
		} finally {
			this.#busy = false;
			this.#refreshRequired = true;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	#draw(): void {
		const connections = this.#connections?.connections ?? [];
		replace(
			this.el,
			h("h1", null, "Connections"),
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, "Model accounts"),
				h(
					"p",
					{ class: "muted" },
					"Select an enabled model account in a conversation to sponsor its work. Enabling here permits your messages; it does not enable autonomous work.",
				),
				button(this.#busy ? "Checking…" : "Refresh model accounts", () => void this.#refresh(), {
					disabled: this.#busy,
				}),
				this.#error ? notice("danger", this.#error) : null,
				this.#message ? notice("neutral", this.#message) : null,
				!this.#busy && !this.#error && !connections.length
					? notice("neutral", "No model accounts are connected for this company.")
					: null,
				h(
					"div",
					{ class: "connection-list" },
					...connections.map((connection) => {
						const usable =
							connection.connectionStatus === "active" &&
							connection.authorizationState === "active" &&
							connection.policy.implementationStatus === "supported" &&
							connection.policy.enablementStatus === "enabled";
						return h(
							"article",
							{ class: "connection-card" },
							h(
								"div",
								{ class: "settings-copy" },
								h("strong", null, connection.providerAccountReference ?? connection.provider),
								h(
									"small",
									null,
									`${connection.provider} · ${connection.connectionStatus} · ${connection.authorizationState}`,
								),
								h("small", null, usable ? "Execution enabled" : "Execution unavailable"),
							),
							!connection.sponsorBindingId
								? button("Enable for my messages", () => void this.#mutate(connection.connectionId, "enable"), {
										disabled:
											this.#busy ||
											this.#refreshRequired ||
											!usable ||
											this.#connections?.computeIdentity?.status !== "active",
									})
								: h(
										"small",
										null,
										usable && this.#connections?.computeIdentity?.status === "active"
											? "Available for your messages"
											: "Unavailable for your messages",
									),
							button("Revoke connection", () => void this.#mutate(connection.connectionId, "revoke"), {
								disabled: this.#busy || this.#refreshRequired || connection.connectionStatus === "revoked",
							}),
						);
					}),
				),
				this.#client.onboardingAvailable && this.#client.beginProviderLogin
					? h(
							"div",
							{ class: "provider-sign-in" },
							h(
								"div",
								{ class: "row" },
								button("Sign in with OpenAI", () => void this.#beginLogin("openai"), {
									disabled: this.#busy || this.#refreshRequired || Boolean(this.#login),
								}),
								button("Sign in with Anthropic", () => void this.#beginLogin("anthropic"), {
									disabled: this.#busy || this.#refreshRequired || Boolean(this.#login),
								}),
							),
							this.#login
								? h(
										"div",
										{ class: "provider-sign-in-prompt" },
										this.#login.interactionUrl
											? h(
													"p",
													null,
													h(
														"a",
														{
															href: this.#login.interactionUrl,
															target: "_blank",
															rel: "noopener noreferrer",
															referrerpolicy: "no-referrer",
														},
														"Open provider sign-in",
													),
												)
											: null,
										this.#login.userCode
											? h("p", null, "Device code: ", h("code", null, this.#login.userCode))
											: null,
										h(
											"p",
											{ class: "muted" },
											"Expires ",
											h(
												"time",
												{ datetime: this.#login.expiresAt },
												new Date(this.#login.expiresAt).toLocaleString(),
											),
										),
										button(
											"Close sign-in instructions",
											() => {
												if (this.#lifetime.signal.aborted) return;
												this.#clearLogin();
												this.#refreshRequired = true;
												this.#message =
													"Sign-in instructions closed. The sign-in may still complete; refresh model accounts before a new attempt.";
												this.#draw();
											},
											{ small: true, disabled: this.#busy },
										),
									)
								: null,
						)
					: notice("neutral", "Connecting a new model account from the browser is not available yet."),
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
