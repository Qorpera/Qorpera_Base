import {
	connectorTokenLooksValid,
	HOSTED_CONNECTORS,
	type HostedConnectorConnection,
	type HostedConnectorId,
	type HostedConnectorReturn,
	type WebConnectors,
} from "../../cloud/connectors.ts";
import { button, fmtTime, h, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";

type ServicesClient = Pick<
	WebConnectors,
	"list" | "beginSignIn" | "finishSignIn" | "captureToken" | "grantAllAgents" | "disconnect"
>;

export interface ServicesAccess {
	canManage(): boolean;
	memberName(userId: string): string | undefined;
}

const FULL_ACCESS: ServicesAccess = { canManage: () => true, memberName: () => undefined };

const CONNECTOR_TEXT: Record<HostedConnectorId, { summary: string; token?: { label: string; hint: string } }> = {
	gmail: { summary: phrase("Read and search the mailbox, send email.") },
	google_drive: { summary: phrase("Find, read, create and update documents.") },
	github: {
		summary: phrase("Repositories, issues, pull requests and files."),
		token: {
			label: phrase("Use a personal access token instead"),
			hint: phrase("A fine-grained token with the repositories the agents may use."),
		},
	},
};

const RETURN_REASONS: Readonly<Record<string, string>> = {
	declined: phrase("The sign-in was cancelled before access was granted."),
	expired: phrase("The sign-in took too long. Try again."),
	no_refresh_token: phrase("Google did not grant lasting access. Try again and allow all requested access."),
	provider_error: phrase("The service did not complete the sign-in. Try again."),
	state_unknown: phrase("This sign-in link is no longer valid. Try again."),
	browser_mismatch: phrase("The sign-in was finished in another browser. Start it again here."),
};

function returnReason(reason: unknown): string {
	const text =
		typeof reason === "string" && Object.hasOwn(RETURN_REASONS, reason) ? RETURN_REASONS[reason] : undefined;
	return text ? t(text) : t("Try again.");
}

type ServiceReturn = HostedConnectorReturn & { connector: HostedConnectorId };
const isServiceReturn = (outcome: HostedConnectorReturn | undefined): outcome is ServiceReturn =>
	outcome !== undefined && outcome.connector !== "bank";

let pendingReturn: ServiceReturn | undefined;
export function noteConnectorReturn(outcome: HostedConnectorReturn | undefined): void {
	pendingReturn = isServiceReturn(outcome) ? outcome : undefined;
}

export class ServicesView {
	readonly el = h("section", { class: "settings-group services" });
	readonly #client: ServicesClient;
	readonly #lifetime = new AbortController();
	readonly #navigate: (url: string) => void;
	readonly #access: ServicesAccess;
	#drawnAccess: string | undefined;
	#connections: HostedConnectorConnection[] | undefined;
	#pendingGrant: HostedConnectorId | undefined;
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
				text: `${t("{service} was not connected.", { service: label(outcome.connector) })} ${returnReason(outcome.reason)}`,
			};
		} else if (outcome?.connection === "confirm") {
			this.#working = outcome.connector;
			this.#outcome = {
				connector: outcome.connector,
				tone: "ok",
				text: t("Finishing the {service} connection…", { service: label(outcome.connector) }),
			};
		}
		this.#draw();
		if (outcome?.connection === "confirm") void this.#finish(outcome);
		else void this.#refresh();
	}

	async #finish(outcome: ServiceReturn): Promise<void> {
		const name = HOSTED_CONNECTORS.find((item) => item.id === outcome.connector)?.label ?? outcome.connector;
		let finished = false;
		try {
			await this.#client.finishSignIn(outcome, this.#lifetime.signal);
			finished = true;
			if (this.#lifetime.signal.aborted) return;
			this.#outcome = {
				connector: outcome.connector,
				tone: "ok",
				text: t("{service} is connected. The company's agents can use it from their next run.", { service: name }),
			};
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			const reason = (error as { reason?: unknown } | undefined)?.reason;
			this.#outcome = {
				connector: outcome.connector,
				tone: "error",
				text: `${t("{service} was not connected.", { service: name })} ${returnReason(reason)}`,
			};
		} finally {
			this.#working = undefined;
		}
		await this.#refresh(finished ? outcome.connector : undefined);
	}

	#accessState(): string {
		const names =
			this.#connections
				?.filter((item) => item.status === "active" && item.ownerKind === "company" && item.connectedByUserId)
				.map((item) => `${item.secretId}:${this.#access.memberName(item.connectedByUserId!) ?? ""}`)
				.sort()
				.join(",") ?? "";
		return `${this.#access.canManage()}|${names}`;
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		if (this.#pendingGrant && this.#access.canManage()) {
			const connector = this.#pendingGrant;
			this.#pendingGrant = undefined;
			void this.#refresh(connector);
		}
		if (this.#accessState() !== this.#drawnAccess) this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.el.replaceChildren();
		this.el.remove();
	}

	#refresh(grantAfter?: HostedConnectorId): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (grantAfter) this.#pendingGrant = grantAfter;
		this.#refreshing ??= this.#read().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #read(): Promise<void> {
		try {
			const connections = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#connections = connections;
			this.#error = undefined;
			const grantAfter = this.#pendingGrant;
			const fresh = grantAfter ? this.#current(grantAfter) : undefined;
			if (grantAfter && (!fresh || (fresh.availableToAllAgents && fresh.activeGrantCount > 0))) {
				this.#pendingGrant = undefined;
			} else if (grantAfter && fresh && this.#access.canManage()) {
				this.#pendingGrant = undefined;
				try {
					await this.#client.grantAllAgents(fresh.secretId, this.#lifetime.signal);
					if (!this.#lifetime.signal.aborted) this.#connections = await this.#client.list(this.#lifetime.signal);
				} catch {
					if (!this.#lifetime.signal.aborted)
						this.#outcome = {
							connector: grantAfter,
							tone: "error",
							text: t(
								"The account is connected, but the company's agents could not get it yet. Disconnect it and connect it again.",
							),
						};
				}
			}
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The company's services could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}

	#current(connectorId: HostedConnectorId): HostedConnectorConnection | undefined {
		return this.#connections
			?.filter(
				(item) => item.connectorId === connectorId && item.status === "active" && item.ownerKind === "company",
			)
			.sort((left, right) => right.version - left.version)[0];
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
				text: t("The sign-in could not be started. Try again."),
			};
			this.#draw();
		}
	}

	async #saveToken(connectorId: HostedConnectorId, token: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		if (!connectorTokenLooksValid(token)) {
			this.#outcome = {
				connector: connectorId,
				tone: "error",
				text: t("That does not look like a token."),
			};
			this.#draw(`service-token:${connectorId}`);
			return;
		}
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
				text: t("{service} is connected. The company's agents can use it from their next run.", { service: label }),
			};
			await this.#refresh(connectorId);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#outcome = {
				connector: connectorId,
				tone: "error",
				text: t("The token could not be saved. Try again."),
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
					text: t("The service could not be disconnected. Try again."),
				};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#refresh();
		}
	}

	#card(connector: (typeof HOSTED_CONNECTORS)[number]): HTMLElement {
		const current = this.#current(connector.id);
		const text = CONNECTOR_TEXT[connector.id];
		const busy = this.#working === connector.id;
		const manage = this.#access.canManage();
		const actions: HTMLElement[] = [];
		if (manage && current) {
			const disconnect = button(busy ? t("Working…") : t("Disconnect"), () => void this.#disconnect(current), {
				disabled: Boolean(this.#working),
			});
			disconnect.dataset.focusKey = `service-disconnect:${connector.id}`;
			actions.push(disconnect);
		} else if (manage) {
			const connect = button(busy ? t("Opening sign-in…") : t("Connect"), () => void this.#connect(connector.id), {
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
						current.accountLabel
							? connectedBy
								? t("Connected as {account} by {member}", {
										account: current.accountLabel,
										member: connectedBy,
									})
								: t("Connected as {account}", { account: current.accountLabel })
							: connectedBy
								? t("Connected by {member}", { member: connectedBy })
								: t("Connected"),
						current.createdAt ? ` · ${fmtTime(current.createdAt)}` : "",
					),
					h(
						"small",
						{ class: "service-agents" },
						t("Available to every agent in the company, including new hires."),
					),
				]
			: [h("strong", null, connector.label), h("small", null, t(text.summary))];
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
		if (text.token && !current && manage) {
			if (this.#tokenFor === connector.id) {
				const field = h("input", {
					type: "password",
					class: "service-token",
					autocomplete: "off",
					spellcheck: "false",
					placeholder: t("Paste the token"),
					"aria-label": t("{service} token", { service: connector.label }),
				});
				field.dataset.focusKey = `service-token:${connector.id}`;
				const save = button(t("Save token"), () => void this.#saveToken(connector.id, field.value), {
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
						h("small", null, t(text.token.hint)),
						h("div", { class: "service-token-row" }, field, save),
					),
				);
			} else {
				const alternative = button(
					t(text.token.label),
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
		this.#drawnAccess = this.#accessState();
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		replace(
			this.el,
			h(
				"div",
				{ class: "connection-section-heading" },
				h("h2", null, t("Services")),
				this.#access.canManage()
					? null
					: h("small", null, t("Only founders and admins can connect or disconnect them.")),
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
