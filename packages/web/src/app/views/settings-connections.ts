import { type Cloud, describeError } from "../../cloud/client.ts";
import {
	type NativeConnection,
	type ProviderLogin,
	type ServiceConnection,
	SettingsApi,
} from "../../cloud/settings-api.ts";
import { button, confirmDialog, h, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

export class ConnectionsView {
	readonly el = h("div");
	readonly #api: SettingsApi;
	readonly #company: CompanyController;
	readonly #lifetime = new AbortController();
	readonly #unsubscribe: () => void;
	#connections: NativeConnection[] = [];
	#services: ServiceConnection[] = [];
	#login?: ProviderLogin;
	#busy = false;
	#loaded = false;
	#error?: string;
	#serviceError?: string;
	#message?: string;
	#poll?: ReturnType<typeof setTimeout>;
	constructor(cloud: Cloud, company: CompanyController, signal: AbortSignal) {
		this.#company = company;
		this.#api = new SettingsApi(
			cloud,
			company.profile,
			company.userId,
			AbortSignal.any([signal, company.signal, this.#lifetime.signal]),
		);
		let capabilities = company.store.get().team?.capabilities;
		this.#unsubscribe = company.store.subscribe(() => {
			const next = company.store.get().team?.capabilities;
			if (next?.write === capabilities?.write && next?.authorize === capabilities?.authorize) return;
			capabilities = next;
			this.#draw();
		});
		void this.#run(() => this.#load());
	}
	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#poll);
		this.#unsubscribe();
	}
	async #load(): Promise<void> {
		const [native, services] = await Promise.allSettled([this.#api.connections(), this.#api.services()]);
		this.#api.signal.throwIfAborted();
		if (native.status === "fulfilled") {
			this.#connections = native.value.connections;
			this.#error = undefined;
		} else {
			this.#connections = [];
			this.#error = describeError(native.reason);
		}
		if (services.status === "fulfilled") {
			this.#services = services.value;
			this.#serviceError = undefined;
		} else {
			this.#services = [];
			this.#serviceError = describeError(services.reason);
		}
		this.#loaded = true;
		if (
			this.#login &&
			this.#connections.some(
				(connection) =>
					connection.provider === this.#login?.provider &&
					!this.#login.knownConnectionIds.includes(connection.id) &&
					connection.authorization === "active" &&
					connection.status === "active",
			)
		) {
			this.#login = undefined;
			clearTimeout(this.#poll);
			this.#message = "Account connected.";
		}
	}
	async #run(action: () => Promise<void>): Promise<void> {
		if (this.#busy || this.#api.signal.aborted) return;
		this.#busy = true;
		this.#error = undefined;
		this.#message = undefined;
		this.#draw();
		try {
			await action();
		} catch (error) {
			this.#error = describeError(error);
		} finally {
			this.#busy = false;
			if (!this.#api.signal.aborted) this.#draw();
		}
	}
	#schedulePoll(): void {
		clearTimeout(this.#poll);
		if (!this.#login || this.#api.signal.aborted) return;
		if (Date.parse(this.#login.expiresAt) <= Date.now()) {
			this.#login = undefined;
			this.#error = "The login expired. Connect again to start a new login.";
			this.#draw();
			return;
		}
		this.#poll = setTimeout(() => {
			void this.#run(() => this.#load()).finally(() => this.#schedulePoll());
		}, 5000);
	}
	#draw(): void {
		if (this.#api.signal.aborted) return;
		const canWrite = this.#company.store.get().team?.capabilities.write === true;
		const canManage = this.#company.store.get().team?.capabilities.authorize === true;
		replace(
			this.el,
			h("h1", null, "Connections"),
			this.#error ? notice("danger", this.#error) : null,
			this.#message ? notice("ok", this.#message) : null,
			!this.#loaded ? spinner("Loading connections") : null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, "Model accounts"),
				h(
					"div",
					{ class: "connection-list" },
					...(
						[
							["openai", "ChatGPT / Codex", "provider-openai.svg"],
							["anthropic", "Claude", "provider-anthropic.svg"],
						] as const
					).map(([provider, label, logo]) => {
						const accounts = this.#connections.filter(
							(connection) => connection.provider === provider && connection.status !== "revoked",
						);
						return h(
							"article",
							{ class: "connection-card" },
							h("img", { class: "connection-logo", src: `./assets/${logo}`, alt: "" }),
							h(
								"div",
								{ class: "settings-copy" },
								h("strong", null, label),
								h("small", null, "Use your subscription for cloud work"),
							),
							button(
								accounts.length ? "Add account" : "Connect",
								() =>
									void this.#run(async () => {
										this.#login = await this.#api.beginLogin(provider);
										this.#schedulePoll();
									}),
								{ disabled: this.#busy || !canWrite || Boolean(this.#login) },
							),
							accounts.length
								? h(
										"div",
										{ class: "connection-accounts" },
										...accounts.map((connection) =>
											h(
												"div",
												{ class: "connection-account" },
												h(
													"div",
													{ class: "settings-copy" },
													h("strong", null, connection.account ?? label),
													h(
														"small",
														null,
														connection.authorization === "reauthentication_required"
															? "Sign in again"
															: connection.status === "disabled"
																? "Disabled"
																: !connection.enabled
																	? (connection.reason ?? "Unavailable for cloud execution")
																	: connection.sponsorId
																		? "Enabled for requested work"
																		: "Connected",
													),
												),
												h(
													"div",
													{ class: "row" },
													connection.status === "active" &&
														connection.authorization === "active" &&
														connection.enabled &&
														!connection.sponsorId
														? button(
																"Enable for work",
																() =>
																	void this.#run(async () => {
																		await this.#api.enable(connection);
																		await this.#load();
																	}),
																{ disabled: this.#busy || !canWrite },
															)
														: null,
													button(
														"Disconnect",
														() =>
															void (async () => {
																if (
																	await confirmDialog(
																		"Disconnect this provider account and stop its active cloud work?",
																		"Disconnect",
																		true,
																		undefined,
																		this.#api.signal,
																	)
																)
																	await this.#run(async () => {
																		await this.#api.revoke(connection);
																		await this.#load();
																	});
															})(),
														{ disabled: this.#busy, small: true },
													),
												),
											),
										),
									)
								: null,
						);
					}),
				),
			),
			this.#login
				? notice(
						"neutral",
						h("strong", null, "Complete your provider login"),
						this.#login.code ? h("p", null, "Enter code ", h("code", null, this.#login.code)) : null,
						this.#login.url
							? h(
									"a",
									{ href: this.#login.url, target: "_blank", rel: "noopener noreferrer" },
									"Open provider login",
								)
							: h("p", null, "Waiting for the provider to complete sign-in…"),
						h("p", { class: "small" }, "This page refreshes the connection status automatically."),
						button("Dismiss login", () => {
							this.#login = undefined;
							clearTimeout(this.#poll);
							this.#draw();
						}),
					)
				: null,
			h(
				"section",
				{ class: "settings-group" },
				h("h2", null, "Services"),
				this.#serviceError
					? notice("danger", this.#serviceError)
					: this.#services.filter((service) => service.status === "active").length
						? h(
								"div",
								{ class: "connection-list" },
								...this.#services
									.filter((service) => service.status === "active")
									.map((service) =>
										h(
											"article",
											{ class: "settings-card" },
											h(
												"div",
												{ class: "settings-copy" },
												h("strong", null, `${service.connector} · ${service.name}`),
												h("small", null, service.purpose),
											),
											(
												service.owner === "company"
													? canManage
													: service.ownerUserId === this.#company.userId
											)
												? button(
														"Disconnect",
														() =>
															void (async () => {
																if (
																	await confirmDialog(
																		"Disconnect this service from the company?",
																		"Disconnect",
																		true,
																		undefined,
																		this.#api.signal,
																	)
																)
																	await this.#run(async () => {
																		await this.#api.revokeService(service);
																		await this.#load();
																	});
															})(),
														{ disabled: this.#busy, small: true },
													)
												: null,
										),
									),
							)
						: h("p", { class: "muted small" }, "No connected services."),
			),
			button("Refresh connections", () => void this.#run(() => this.#load()), { disabled: this.#busy }),
		);
	}
}
