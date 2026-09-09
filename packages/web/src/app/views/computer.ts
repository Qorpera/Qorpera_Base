import type { CompanyComputerMemberView } from "@qorpera/cloud-client/cloud-company-computer-views";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { type ComputerViewer, openComputerViewer } from "../../ui/computer-viewer.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";

/** Opening reads authority. Starts and viewers require explicit member intent. */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly #stop = new AbortController();
	readonly #status = h("p", { class: "muted", role: "status" });
	readonly #controls = h("div", { class: "stack" });
	#viewer: ComputerViewer | undefined;
	readonly #connections = new Map<string, CompanyComputerMemberView>();
	#busy = false;
	constructor(agent: HostedStaffAgent, close: () => void, computer?: WebCompanyComputer, parentSignal?: AbortSignal) {
		this.el = h(
			"aside",
			{ class: "computer-panel", "aria-label": "Agent computer" },
			h(
				"header",
				null,
				h("strong", null, "Computer"),
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close computer", onclick: close },
					icon("close"),
				),
			),
			h(
				"div",
				{ class: "computer-panel-body" },
				h(
					"section",
					{ class: "computer-preview" },
					h(
						"div",
						{ class: "computer-preview-screen" },
						agentFigure(agent, agent.displayName, { size: 38 }),
						h("span", null, computer ? "Company Computer" : "Computer unavailable"),
					),
					h("strong", null, agent.displayName),
					this.#status,
					this.#controls,
				),
				h(
					"section",
					{ class: "computer-routines" },
					h(
						"header",
						null,
						h("h2", null, "Routines"),
						h(
							"button",
							{
								type: "button",
								class: "icon-button",
								disabled: true,
								"aria-label": "Create routine",
								title: "Create routine",
							},
							icon("plus"),
						),
					),
					h("p", { class: "muted" }, "Recurring work, on a schedule or when something happens."),
					h("div", { class: "routine-empty" }, icon("clock"), h("p", null, "Routines will appear here.")),
				),
			),
		);
		this.el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		});
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (signal.aborted) {
			this.dispose();
			return;
		}
		if (!computer) {
			this.#status.textContent = "Computer access is not available yet.";
			return;
		}
		const run = async (work: () => Promise<void>) => {
			if (this.#busy || signal.aborted) return;
			this.#busy = true;
			this.#controls.inert = true;
			try {
				await work();
			} catch {
				if (!signal.aborted) {
					this.#status.textContent = "Computer access could not be confirmed. Refresh to check again.";
					replace(
						this.#controls,
						button("Refresh computer", () => void run(refresh)),
					);
				}
			} finally {
				this.#busy = false;
				this.#controls.inert = false;
			}
		};
		const refresh = async () => {
			this.#status.textContent = "Checking computer access…";
			replace(this.#controls);
			const catalog = await computer.client.catalog(signal);
			signal.throwIfAborted();
			const scope = catalog.scope;
			if (!scope) {
				this.#status.textContent = "A computer has not been provisioned for this company.";
				return;
			}
			const startClient = computer.client.start(scope);
			const start = await startClient.status(signal);
			signal.throwIfAborted();
			this.#status.textContent = `Computer ${start.officeState}. Closing this panel leaves cloud work running.`;
			this.#controls.append(button("Refresh computer", () => void run(refresh)));
			if (catalog.canManage && start.officeState === "provisioning" && !start.intent) {
				const requestId = crypto.randomUUID();
				this.#controls.append(
					button(
						"Start computer",
						() =>
							void run(async () => {
								await startClient.request(start.computerGeneration, requestId, signal);
								signal.throwIfAborted();
								await refresh();
							}),
					),
				);
			}
			if (start.officeState !== "active") return;
			let views: ReturnType<WebCompanyComputer["views"]>;
			try {
				views = computer.views(scope);
			} catch {
				this.#controls.append(h("p", { class: "muted" }, "Screen viewing is not configured."));
				return;
			}
			const status = await views.status(signal);
			signal.throwIfAborted();
			if (status.state !== "active" || status.privacyState !== "shared") {
				this.#controls.append(
					h("p", null, "Shared viewing is unavailable while the computer is private or changing state."),
				);
				return;
			}
			const screens = status.screens.filter((screen) => screen.binding.staffAgentId === agent.id);
			if (!screens.length) this.#controls.append(h("p", { class: "muted" }, "This agent has no screen yet."));
			for (const screen of screens)
				this.#controls.append(
					button(
						`Watch screen ${screen.binding.screenOrdinal}`,
						() =>
							void run(async () => {
								if (this.#viewer) return;
								this.#viewer = openComputerViewer({
									binding: screen.binding,
									title: `${agent.displayName} · Computer`,
									canControl: catalog.canManage,
									requestConnection: async (input) => {
										const requestSignal = AbortSignal.any([signal, input.signal]);
										const connection = await views.connectScreen({ ...input, signal: requestSignal });
										if (requestSignal.aborted) {
											await connection.close();
											requestSignal.throwIfAborted();
										}
										this.#connections.set(connection.connectionId, connection);
										return connection;
									},
									releaseConnection: async ({ connectionId }) => {
										const connection = this.#connections.get(connectionId);
										await connection?.close();
										this.#connections.delete(connectionId);
									},
									onClosed: () => {
										this.#viewer = undefined;
									},
								});
							}),
						{ disabled: screen.drainPending },
					),
				);
		};
		void run(refresh);
	}
	focus(): void {
		this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}
	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		void this.#viewer?.close().catch(() => undefined);
		for (const connection of this.#connections.values()) void connection.close().catch(() => undefined);
		this.#connections.clear();
		replace(this.el);
		this.el.remove();
	}
}
