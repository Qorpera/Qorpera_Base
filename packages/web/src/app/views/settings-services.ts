import {
	HOSTED_CONNECTORS,
	type HostedConnectorConnection,
	type HostedConnectorId,
	type HostedConnectorReturn,
	type WebConnectors,
} from "../../cloud/connectors.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";

/**
 * Settings → Connections → Services: the Runtime Step 7 connectors (Gmail,
 * Google Drive, GitHub). Company first: each card shows the company's one
 * connection for that service. An owner or admin connects it by signing in
 * with the provider (the browser leaves for the provider and comes back here),
 * reconnects or disconnects it; everyone else sees it read-only. A connected
 * account is made available to every agent of the company right away (the
 * agents' tools appear on their next run); the member who connected it is
 * shown for attribution only.
 */

type ServicesClient = Pick<
	WebConnectors,
	"list" | "beginSignIn" | "finishSignIn" | "captureToken" | "grantAllAgents" | "stopSharing" | "disconnect"
>;

export interface ServicesAccess {
	/** Whether the signed-in member may connect, share or disconnect company
	 * services (owner or admin; the kernel enforces the same rule). */
	canManage(): boolean;
	/** A member's display name for the "connected by" line, if known. */
	memberName(userId: string): string | undefined;
}

const FULL_ACCESS: ServicesAccess = { canManage: () => true, memberName: () => undefined };

/** Shared means marked for all agents AND holding live grants. The list counts
 * only live grants (issuer still an owner or admin), so a share whose issuer
 * left reads as not shared and Share with all agents repairs it. */
function sharedWithAgents(connection: HostedConnectorConnection): boolean {
	return connection.availableToAllAgents && connection.activeGrantCount > 0;
}

const RETURN_REASONS: Readonly<Record<string, string>> = {
	declined: "The sign-in was cancelled before access was granted.",
	expired: "The sign-in took too long. Try again.",
	no_refresh_token: "Google did not grant lasting access. Try again and allow all requested access.",
	provider_error: "The service did not complete the sign-in. Try again.",
	state_unknown: "This sign-in link is no longer valid. Try again.",
	browser_mismatch: "The sign-in was finished in another browser. Start it again here.",
};

/** A sign-in outcome the broker sent back in the page hash, kept until the
 * services panel is drawn once, even if that happens after a company loads. */
let pendingReturn: HostedConnectorReturn | undefined;
export function noteConnectorReturn(outcome: HostedConnectorReturn | undefined): void {
	pendingReturn = outcome;
}

export class ServicesView {
	readonly el = h("section", { class: "settings-group services" });
	readonly #client: ServicesClient;
	readonly #lifetime = new AbortController();
	readonly #navigate: (url: string) => void;
	readonly #access: ServicesAccess;
	#drawnManage: boolean | undefined;
	#connections: HostedConnectorConnection[] | undefined;
	#loading = true;
	#error: string | undefined;
	#working: string | undefined;
	#tokenFor: HostedConnectorId | undefined;
	#outcome: { connector: HostedConnectorId; tone: "ok" | "error"; text: string } | undefined;
	#refreshing: Promise<void> | undefined;

	constructor(
		client: ServicesClient,
		signal: AbortSignal,
		options: { navigate?: (url: string) => void; access?: ServicesAccess } = {},
	) {
		this.#client = client;
		this.#navigate = options.navigate ?? ((url) => location.assign(url));
		this.#access = options.access ?? FULL_ACCESS;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		const outcome = pendingReturn;
		pendingReturn = undefined;
		const label = (connector: string) => HOSTED_CONNECTORS.find((item) => item.id === connector)?.label ?? connector;
		if (outcome?.connection === "failed") {
			this.#outcome = {
				connector: outcome.connector,
				tone: "error",
				text: `${label(outcome.connector)} was not connected. ${RETURN_REASONS[outcome.reason ?? ""] ?? "Try again."}`,
			};
		} else if (outcome?.connection === "confirm") {
			this.#working = outcome.connector;
			this.#outcome = {
				connector: outcome.connector,
				tone: "ok",
				text: `Finishing the ${label(outcome.connector)} connection…`,
			};
		}
		this.#draw();
		if (outcome?.connection === "confirm") void this.#finish(outcome);
		else void this.#refresh();
	}

	/** A sign-in this tab started came back: the broker seals the account only
	 * for this tab's proof, then the fresh connection is shared with every agent
	 * (an owner or admin started it). */
	async #finish(outcome: HostedConnectorReturn): Promise<void> {
		const name = HOSTED_CONNECTORS.find((item) => item.id === outcome.connector)?.label ?? outcome.connector;
		let finished = false;
		try {
			await this.#client.finishSignIn(outcome, this.#lifetime.signal);
			finished = true;
			if (this.#lifetime.signal.aborted) return;
			this.#outcome = {
				connector: outcome.connector,
				tone: "ok",
				text: `${name} is connected. The company's agents can use it from their next run.`,
			};
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			const reason = (error as { reason?: unknown } | undefined)?.reason;
			this.#outcome = {
				connector: outcome.connector,
				tone: "error",
				text: `${name} was not connected. ${RETURN_REASONS[typeof reason === "string" ? reason : ""] ?? "Try again."}`,
			};
		} finally {
			this.#working = undefined;
		}
		await this.#refresh(finished ? outcome.connector : undefined);
	}

	/** Redraws when the member's authority over company services changed (the
	 * team loads after the page, or a role changes while it is open). */
	update(): void {
		if (!this.#lifetime.signal.aborted && this.#access.canManage() !== this.#drawnManage) this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.el.replaceChildren();
		this.el.remove();
	}

	#refresh(grantAfter?: HostedConnectorId): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		this.#refreshing ??= this.#read(grantAfter).finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #read(grantAfter?: HostedConnectorId): Promise<void> {
		try {
			const connections = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#connections = connections;
			this.#error = undefined;
			// A connection that just arrived from a provider sign-in has no agent
			// grants yet: hand it to every agent now, once.
			const fresh = grantAfter ? this.#current(grantAfter) : undefined;
			if (fresh && !sharedWithAgents(fresh) && this.#access.canManage()) {
				try {
					await this.#client.grantAllAgents(fresh.secretId, this.#lifetime.signal);
					if (!this.#lifetime.signal.aborted) this.#connections = await this.#client.list(this.#lifetime.signal);
				} catch {
					if (!this.#lifetime.signal.aborted)
						this.#error = "The account is connected but could not be shared with your agents yet. Try again.";
				}
			}
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = "Your connected services could not be read.";
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}

	/** The company's connection for a service. A member's own secret (the
	 * kernel's member mode) is never shown or shared here. */
	#current(connectorId: HostedConnectorId): HostedConnectorConnection | undefined {
		return this.#connections
			?.filter(
				(item) => item.connectorId === connectorId && item.status === "active" && item.ownerKind === "company",
			)
			.sort((left, right) => right.version - left.version)[0];
	}

	async #stopSharing(connection: HostedConnectorConnection): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connection.connectorId;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.stopSharing(connection.secretId, this.#lifetime.signal);
		} catch {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = {
					connector: connection.connectorId as HostedConnectorId,
					tone: "error",
					text: "The service could not be taken away from the company's agents. Try again.",
				};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
	}

	async #share(connection: HostedConnectorConnection): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connection.connectorId;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.grantAllAgents(connection.secretId, this.#lifetime.signal);
		} catch {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = {
					connector: connection.connectorId as HostedConnectorId,
					tone: "error",
					text: "The service could not be shared with the company's agents. Try again.",
				};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
	}

	async #connect(connectorId: HostedConnectorId): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connectorId;
		this.#outcome = undefined;
		this.#draw();
		try {
			const url = await this.#client.beginSignIn(
				connectorId,
				this.#current(connectorId)?.secretId,
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#navigate(url);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#outcome = {
				connector: connectorId,
				tone: "error",
				text: "The sign-in could not be started. Try again.",
			};
			this.#draw();
		}
	}

	async #saveToken(connectorId: HostedConnectorId, token: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connectorId;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.captureToken(
				connectorId,
				token,
				this.#current(connectorId)?.secretId,
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#tokenFor = undefined;
			this.#working = undefined;
			const label = HOSTED_CONNECTORS.find((item) => item.id === connectorId)?.label ?? connectorId;
			this.#outcome = {
				connector: connectorId,
				tone: "ok",
				text: `${label} is connected. The company's agents can use it from their next run.`,
			};
			await this.#refresh(connectorId);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#outcome = {
				connector: connectorId,
				tone: "error",
				text: error instanceof Error && error.message ? error.message : "The token could not be saved. Try again.",
			};
			this.#draw();
		}
	}

	async #disconnect(connection: HostedConnectorConnection): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = connection.connectorId;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.disconnect(connection.secretId, this.#lifetime.signal);
		} catch {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = {
					connector: connection.connectorId as HostedConnectorId,
					tone: "error",
					text: "The service could not be disconnected. Try again.",
				};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
	}

	#card(connector: (typeof HOSTED_CONNECTORS)[number]): HTMLElement {
		const current = this.#current(connector.id);
		const busy = this.#working === connector.id;
		const manage = this.#access.canManage();
		// Members who are not owners or admins see the card read-only.
		const actions: HTMLElement[] = [];
		if (manage && current) {
			if (!sharedWithAgents(current)) {
				const share = button("Share with all agents", () => void this.#share(current), {
					disabled: Boolean(this.#working),
				});
				share.dataset.focusKey = `service-share:${connector.id}`;
				actions.push(share);
			}
			if (current.availableToAllAgents || current.activeGrantCount > 0) {
				const stop = button("Stop sharing with agents", () => void this.#stopSharing(current), {
					disabled: Boolean(this.#working),
				});
				stop.dataset.focusKey = `service-unshare:${connector.id}`;
				actions.push(stop);
			}
			const disconnect = button(busy ? "Working…" : "Disconnect", () => void this.#disconnect(current), {
				disabled: Boolean(this.#working),
			});
			disconnect.dataset.focusKey = `service-disconnect:${connector.id}`;
			const reconnect = button("Reconnect", () => void this.#connect(connector.id), {
				disabled: Boolean(this.#working),
			});
			reconnect.dataset.focusKey = `service-reconnect:${connector.id}`;
			actions.push(reconnect, disconnect);
		} else if (manage) {
			const connect = button(busy ? "Opening sign-in…" : "Connect", () => void this.#connect(connector.id), {
				primary: true,
				disabled: Boolean(this.#working) || this.#loading,
			});
			connect.dataset.focusKey = `service-connect:${connector.id}`;
			actions.push(connect);
		}
		const connectedBy = current?.connectedByUserId ? this.#access.memberName(current.connectedByUserId) : undefined;
		const status = current
			? [
					h("strong", null, connector.label),
					h(
						"small",
						null,
						current.accountLabel ? `Connected as ${current.accountLabel}` : "Connected",
						connectedBy ? ` by ${connectedBy}` : "",
						current.createdAt ? ` · ${fmtTime(current.createdAt)}` : "",
					),
					h(
						"small",
						{ class: "service-agents" },
						sharedWithAgents(current)
							? "Available to every agent in the company, including new hires."
							: current.activeGrantCount > 0
								? `Available to ${current.activeGrantCount} agent operation${current.activeGrantCount === 1 ? "" : "s"}.`
								: "Not yet available to the company's agents.",
					),
				]
			: [h("strong", null, connector.label), h("small", null, connector.summary)];
		const children: (HTMLElement | string)[] = [
			h("img", { class: "connection-logo", src: `./assets/${connector.logo}`, alt: "" }),
			h("div", { class: "settings-copy" }, ...status),
			h("div", { class: "connection-actions" }, ...actions),
		];
		if (this.#outcome?.connector === connector.id) {
			children.push(
				h(
					"p",
					{ class: `service-outcome ${this.#outcome.tone === "ok" ? "is-ok" : "is-error"}`, role: "status" },
					this.#outcome.text,
				),
			);
		}
		if (connector.token && !current && manage) {
			if (this.#tokenFor === connector.id) {
				const field = h("input", {
					type: "password",
					class: "service-token",
					autocomplete: "off",
					spellcheck: "false",
					placeholder: "Paste the token",
					"aria-label": `${connector.label} token`,
				});
				field.dataset.focusKey = `service-token:${connector.id}`;
				const save = button("Save token", () => void this.#saveToken(connector.id, field.value), {
					primary: true,
					disabled: Boolean(this.#working),
				});
				save.dataset.focusKey = `service-token-save:${connector.id}`;
				children.push(
					h(
						"form",
						{
							class: "service-token-form",
							onsubmit: (event: Event) => {
								event.preventDefault();
								void this.#saveToken(connector.id, field.value);
							},
						},
						h("small", null, connector.token.hint),
						h("div", { class: "service-token-row" }, field, save),
					),
				);
			} else {
				const alternative = button(
					connector.token.label,
					() => {
						this.#tokenFor = connector.id;
						this.#draw(`service-token:${connector.id}`);
					},
					{ small: true, disabled: Boolean(this.#working) },
				);
				alternative.dataset.focusKey = `service-token-toggle:${connector.id}`;
				children.push(h("div", { class: "service-alternative" }, alternative));
			}
		}
		return h("article", { class: "service-card", dataset: { connector: connector.id } }, ...children);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		this.#drawnManage = this.#access.canManage();
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		replace(
			this.el,
			h(
				"div",
				{ class: "connection-section-heading" },
				h("h2", null, "Services"),
				h(
					"small",
					null,
					this.#access.canManage()
						? "Connected for the company; its agents use them through the company's secret broker."
						: "Connected for the company by an owner or admin; its agents use them through the company's secret broker.",
				),
			),
			this.#error ? h("p", { class: "connection-empty service-error", role: "alert" }, this.#error) : "",
			h("div", { class: "connection-list" }, ...HOSTED_CONNECTORS.map((connector) => this.#card(connector))),
		);
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
