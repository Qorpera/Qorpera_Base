import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { type AgentRoutineAccess, AgentRoutines } from "./agent-routines.ts";
import { ComputerAccessPanel } from "./computer-access.ts";
import { ComputerBrowserPanel } from "./computer-browser.ts";

/** The full-screen place a member watches an agent's computer. It holds the
 * wait: the computer starting, or the agent not being on it yet. */
class ComputerStage {
	readonly #stop = new AbortController();
	readonly #line = h("p", { role: "status" }, "Opening the computer…");
	readonly #el: HTMLElement;
	constructor(agent: HostedStaffAgent, onClose: () => void) {
		this.#el = h(
			"div",
			{
				class: "computer-stage",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": `${agent.displayName} · Computer`,
			},
			h(
				"button",
				{
					type: "button",
					class: "icon-button computer-stage-close",
					"aria-label": "Close computer",
					onclick: () => this.close(),
				},
				icon("close"),
			),
			h("div", { class: "computer-stage-body" }, agentFigure(agent, agent.displayName, { size: 72 }), this.#line),
		);
		this.#el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				this.close();
			}
		});
		this.#stop.signal.addEventListener("abort", onClose, { once: true });
		document.body.append(this.#el);
		this.#el.querySelector<HTMLButtonElement>("button")?.focus();
	}
	get signal(): AbortSignal {
		return this.#stop.signal;
	}
	say(text: string): void {
		if (this.#line.textContent !== text) this.#line.textContent = text;
	}
	close(): void {
		if (this.#stop.signal.aborted) return;
		this.#el.remove();
		this.#stop.abort();
	}
}

/** Opening the panel only reads. One action opens the computer: it starts it
 * when needed and shows this agent's screen full screen. */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly #stop = new AbortController();
	readonly #status = h("p", { class: "muted", role: "status" });
	readonly #controls = h("div", { class: "stack" });
	readonly #views: ComputerViewHost;
	readonly #detailsRoot = h("div", { class: "stack computer-details" });
	#details: ComputerAccessPanel | ComputerBrowserPanel | undefined;
	#stage: ComputerStage | undefined;
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
					this.#status.textContent = "The computer could not be reached. Try again.";
					this.#stage?.close();
					draw();
				}
			} finally {
				this.#busy = false;
				this.#controls.inert = false;
			}
		};
		const wait = (ms: number, until: AbortSignal) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				until.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("closed"));
					},
					{ once: true },
				);
			});
		let canManage = false;
		const startRequests = new Map<string, string>();
		let scope: Awaited<ReturnType<WebCompanyComputer["client"]["catalog"]>>["scope"];
		const draw = () => {
			replace(
				this.#controls,
				button("Open computer", () => void run(open), { primary: true, disabled: !scope }),
				h(
					"div",
					{ class: "computer-more" },
					canManage && scope ? button("Permissions", () => void run(permissions), { small: true }) : null,
					scope ? button("Your browsers", () => void run(browsers), { small: true }) : null,
				),
			);
		};
		const permissions = async () => {
			if (!scope) return;
			this.#details?.dispose();
			this.#details = new ComputerAccessPanel(computer.client.access(scope, agent.id), agent.displayName, signal);
			replace(this.#detailsRoot, this.#details.el);
		};
		const browsers = async () => {
			if (!scope) return;
			await this.#views.close();
			signal.throwIfAborted();
			this.#details?.dispose();
			this.#details = new ComputerBrowserPanel(computer, scope, agent, this.#views, signal);
			replace(this.#detailsRoot, this.#details.el);
		};
		/** Reads what the panel needs to offer the one action; starts nothing. */
		const look = async () => {
			this.#status.textContent = "Checking the computer…";
			const catalog = await computer.client.catalog(signal);
			signal.throwIfAborted();
			scope = catalog.scope;
			canManage = catalog.canManage;
			if (!scope) {
				this.#status.textContent = "This company has no computer yet.";
				draw();
				return;
			}
			const start = await computer.client.start(scope).status(signal);
			signal.throwIfAborted();
			this.#status.textContent =
				start.officeState === "active"
					? "The computer is on."
					: start.officeState === "maintenance"
						? "The computer is restarting and comes back on its own."
						: "The computer is off.";
			draw();
		};
		/** One action: start the computer if it is off, then show this agent's
		 * screen full screen, waiting for it if the agent is not on the computer yet. */
		const open = async () => {
			if (!scope) return;
			const current = scope;
			const stage = new ComputerStage(agent, () => undefined);
			this.#stage = stage;
			const until = AbortSignal.any([signal, stage.signal]);
			try {
				const startClient = computer.client.start(current);
				let requested = false;
				for (;;) {
					const start = await startClient.status(until);
					if (start.officeState === "active") break;
					if (start.officeState === "maintenance")
						stage.say("The computer is restarting. It comes back on its own.");
					else if (start.officeState === "retired") {
						stage.say("This computer has been retired.");
						return;
					} else if (!canManage) {
						stage.say("The computer is off. An owner or admin can start it.");
					} else {
						if (!start.intent && !requested) {
							requested = true;
							// One identity per computer generation: a second click after an unclear
							// answer is the same request, not another start.
							const key = String(start.computerGeneration);
							let requestId = startRequests.get(key);
							if (!requestId) {
								requestId = crypto.randomUUID();
								startRequests.set(key, requestId);
							}
							await startClient.request(start.computerGeneration, requestId, until);
						}
						stage.say("Starting the computer…");
					}
					await wait(3000, until);
				}
				this.#status.textContent = "The computer is on.";
				let views: ReturnType<WebCompanyComputer["views"]>;
				try {
					views = computer.views(current);
				} catch {
					stage.say("Screen viewing is not set up here.");
					return;
				}
				stage.say(`Opening ${agent.displayName}'s computer…`);
				let asked = false;
				for (;;) {
					const status = await views.status(until);
					if (status.state === "active" && status.privacyState === "shared") {
						const screen = status.screens
							.filter((item) => item.binding.staffAgentId === agent.id && !item.drainPending)
							.sort((a, b) => a.binding.screenOrdinal - b.binding.screenOrdinal)[0];
						if (screen) {
							stage.say("Connecting…");
							await this.#views.open({
								binding: screen.binding,
								title: `${agent.displayName} · Computer`,
								canControl: canManage,
								requestConnection: async (input) => views.connectScreen(input),
							});
							stage.close();
							return;
						}
						if (!asked) {
							// The agent has no screen yet: open one. Its desktop starts when we connect.
							asked = true;
							const opened = await views.openScreen(agent.id, until);
							if (opened.state === "refused") {
								stage.say(
									opened.reason === "SCREEN_CAPACITY_EXHAUSTED"
										? "All screens on this computer are in use. Try again when one is free."
										: opened.reason === "AGENT_HAS_NO_COMPUTER_ACCESS"
											? `${agent.displayName} does not have access to the computer yet. An owner or admin can grant it under Permissions.`
											: opened.reason === "SCREEN_OCCUPIED"
												? `${agent.displayName}'s screen is being handed over. It opens here in a moment.`
												: "The computer is not ready yet.",
								);
								if (opened.reason !== "SCREEN_OCCUPIED" && opened.reason !== "COMPUTER_NOT_ACTIVE") return;
								asked = false;
							} else continue;
						}
					} else stage.say("The computer is private right now. Shared viewing returns when that ends.");
					await wait(3000, until);
				}
			} catch (error) {
				if (stage.signal.aborted && !signal.aborted) return;
				throw error;
			} finally {
				if (this.#stage === stage && stage.signal.aborted) this.#stage = undefined;
			}
		};
		draw();
		void run(look);
	}
	focus(): void {
		this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}
	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		this.#stage?.close();
		this.#details?.dispose();
		replace(this.el);
		this.el.remove();
	}
}
