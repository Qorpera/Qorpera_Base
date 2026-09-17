import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { type AgentRoutineAccess, AgentRoutines } from "./agent-routines.ts";
import { ComputerAccessPanel } from "./computer-access.ts";
import { ComputerBrowserPanel } from "./computer-browser.ts";

/** Opening reads authority. Starts and viewers require explicit member intent. */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly #stop = new AbortController();
	readonly #status = h("p", { class: "muted", role: "status" });
	readonly #controls = h("div", { class: "stack" });
	readonly #screenControls = h("div", { class: "stack" });
	readonly #views: ComputerViewHost;
	readonly #detailsRoot = h("div", { class: "stack computer-details" });
	#details: ComputerAccessPanel | ComputerBrowserPanel | undefined;
	#busy = false;
	constructor(
		agent: HostedStaffAgent,
		close: () => void,
		computer?: WebCompanyComputer,
		parentSignal?: AbortSignal,
		routines?: AgentRoutineAccess,
	) {
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#views = new ComputerViewHost(signal);
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
					this.#screenControls,
					this.#detailsRoot,
				),
				new AgentRoutines(agent, routines, signal).el,
			),
		);
		this.el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		});
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
			this.#details?.dispose();
			this.#details = undefined;
			this.#status.textContent = "Checking computer access…";
			replace(this.#controls);
			replace(this.#screenControls);
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
			this.#status.textContent =
				start.officeState === "maintenance" && start.maintenance?.reason === "host_reboot"
					? `Computer in maintenance: its host is rebooting (${start.maintenance.state}). It comes back on its own; work that needs it waits and is retried.`
					: `Computer ${start.officeState}. Closing this panel leaves cloud work running.`;
			this.#controls.append(button("Refresh computer", () => void run(refresh)));
			if (catalog.canManage)
				this.#controls.append(
					button(
						"Manage computer permissions",
						() =>
							void run(async () => {
								this.#details?.dispose();
								this.#details = new ComputerAccessPanel(
									computer.client.access(scope, agent.id),
									agent.displayName,
									signal,
								);
								replace(this.#detailsRoot, this.#details.el);
							}),
					),
				);
			this.#controls.append(
				button(
					"Manage your browsers",
					() =>
						void run(async () => {
							replace(this.#screenControls);
							await this.#views.close();
							signal.throwIfAborted();
							this.#details?.dispose();
							this.#details = new ComputerBrowserPanel(computer, scope, agent, this.#views, signal);
							replace(this.#detailsRoot, this.#details.el);
						}),
				),
			);
			const canManageStart =
				catalog.canManage && (start.officeState === "provisioning" || start.officeState === "recovering");
			if (canManageStart && !start.intent) {
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
			if (canManageStart && start.intent && start.intent.state !== "cancelled") {
				const intent = start.intent;
				this.#controls.append(
					button(
						"Cancel pending start",
						() =>
							void run(async () => {
								await startClient.cancel(intent, signal);
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
				this.#screenControls.append(
					button(
						`Watch screen ${screen.binding.screenOrdinal}`,
						() =>
							void run(async () => {
								await this.#views.open({
									binding: screen.binding,
									title: `${agent.displayName} · Computer`,
									canControl: catalog.canManage,
									requestConnection: async (input) => {
										return views.connectScreen(input);
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
		this.#details?.dispose();
		replace(this.el);
		this.el.remove();
	}
}
