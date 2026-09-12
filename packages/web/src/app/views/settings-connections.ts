import type { NativeExecutionConnections } from "@qorpera/cloud-client/cloud-native-subscription-control";
import type { WebNativeSubscription } from "../../cloud/native-subscription.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";

/** Member connections use shared SDK intent; new sign-in needs an accepted browser gateway. */
export class ConnectionsView {
	readonly el = h("div");
	readonly #client: Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor">;
	readonly #lifetime = new AbortController();
	readonly #enableOperations = new Map<string, string>();
	#connections: NativeExecutionConnections | undefined;
	#busy = false;
	#refreshRequired = false;
	#error: string | undefined;
	#message: string | undefined;
	constructor(
		client: Pick<WebNativeSubscription, "listConnections" | "revokeConnection" | "createMemberSponsor">,
		signal: AbortSignal,
	) {
		this.#client = client;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		void this.#refresh();
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#connections = undefined;
		this.#enableOperations.clear();
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
				notice("neutral", "Connecting a new model account from the browser is not available yet."),
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
