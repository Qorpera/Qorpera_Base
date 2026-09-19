import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";

type ComputerLayout = "floating" | "split" | "expanded";
const LAYOUT_KEY = "qorpera.web.computer-layout";

function savedLayout(): ComputerLayout {
	try {
		const value = localStorage.getItem(LAYOUT_KEY);
		return value === "split" || value === "expanded" ? value : "floating";
	} catch {
		return "floating";
	}
}

/** The waiting state occupies the same surface as the eventual live screen. */
class ComputerStage {
	readonly #stop = new AbortController();
	readonly #line = h("p", { role: "status" }, "Opening the computer…");
	readonly #el: HTMLElement;
	readonly #onClose: (restoreFocus: boolean) => void;
	constructor(agent: HostedStaffAgent, mount: HTMLElement, onClose: (restoreFocus: boolean) => void) {
		this.#onClose = onClose;
		this.#el = h(
			"div",
			{
				class: "computer-stage",
				role: "dialog",
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
		mount.append(this.#el);
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
		const restoreFocus = this.#el.contains(document.activeElement);
		this.#el.remove();
		this.#stop.abort();
		this.#onClose(restoreFocus);
	}
}

/** Opening the surface only reads. Starting/viewing still requires explicit intent. */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly #stop = new AbortController();
	readonly #status = h("p", { class: "muted", role: "status" });
	readonly #controls = h("div", { class: "stack" });
	readonly #views: ComputerViewHost;
	readonly #body = h("div", { class: "computer-panel-body" });
	readonly #preview: HTMLElement;
	#layout = savedLayout();
	#stage: ComputerStage | undefined;
	#busy = false;
	constructor(
		agent: HostedStaffAgent,
		close: () => void,
		computer?: WebCompanyComputer,
		parentSignal?: AbortSignal,
		layoutChanged: () => void = () => {},
	) {
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#views = new ComputerViewHost(signal);
		const layout = h(
			"select",
			{ class: "computer-layout", "aria-label": "Computer layout" },
			h("option", { value: "floating" }, "Floating"),
			h("option", { value: "split" }, "Split view"),
			h("option", { value: "expanded" }, "Expanded"),
		);
		layout.value = this.#layout;
		layout.addEventListener("change", () => {
			if (layout.value !== "floating" && layout.value !== "split" && layout.value !== "expanded") return;
			this.#layout = layout.value;
			this.el.dataset.layout = this.#layout;
			try {
				localStorage.setItem(LAYOUT_KEY, this.#layout);
			} catch {
				/* The layout still works without storage. */
			}
			layoutChanged();
		});
		this.#preview = h(
			"section",
			{ class: "computer-preview" },
			agentFigure(agent, agent.displayName, { size: 48 }),
			h("strong", null, computer ? "Company Computer" : "Computer unavailable"),
			this.#status,
			this.#controls,
		);
		this.#body.append(this.#preview);
		this.el = h(
			"aside",
			{ class: "computer-panel", "aria-label": "Agent computer", dataset: { layout: this.#layout } },
			h(
				"header",
				null,
				h("strong", { class: "computer-panel-title", title: `${agent.displayName} · Computer` }, agent.displayName),
				layout,
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close computer", onclick: close },
					icon("close"),
				),
			),
			this.#body,
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
				until.throwIfAborted();
				const cancel = () => {
					clearTimeout(timer);
					reject(new Error("closed"));
				};
				const timer = setTimeout(() => {
					until.removeEventListener("abort", cancel);
					resolve();
				}, ms);
				until.addEventListener("abort", cancel, { once: true });
			});
		let canManage = false;
		const startRequests = new Map<string, string>();
		let scope: Awaited<ReturnType<WebCompanyComputer["client"]["catalog"]>>["scope"];
		const draw = () => {
			replace(
				this.#controls,
				button("Open computer", () => void run(open), { primary: true, disabled: !scope }),
			);
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
		/** Start if needed, then show the screen inside the selected layout. */
		const open = async () => {
			if (!scope) return;
			const current = scope;
			this.#stage?.close();
			this.#preview.hidden = true;
			const stage = new ComputerStage(agent, this.#body, (restoreFocus) => {
				this.#preview.hidden = false;
				if (restoreFocus && !signal.aborted) this.focus();
			});
			this.#stage = stage;
			const until = AbortSignal.any([signal, stage.signal]);
			try {
				const startClient = computer.client.start(current);
				let requested = false;
				for (;;) {
					const start = await startClient.status(until);
					until.throwIfAborted();
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
					until.throwIfAborted();
					if (status.state === "active" && status.privacyState === "shared") {
						const screen = status.screens
							.filter((item) => item.binding.staffAgentId === agent.id && !item.drainPending)
							.sort((a, b) => a.binding.screenOrdinal - b.binding.screenOrdinal)[0];
						if (screen) {
							stage.say("Connecting…");
							await this.#views.open({
								mount: this.#body,
								autofocus: this.el.contains(document.activeElement),
								onClosed: () => {
									this.#preview.hidden = false;
									if (!signal.aborted) this.#controls.querySelector<HTMLButtonElement>("button")?.focus();
								},
								binding: screen.binding,
								title: `${agent.displayName} · Computer`,
								canControl: canManage,
								// The first view starts the agent's desktop, which can outlast one
								// connection attempt; the start continues, so a later attempt holds.
								requestConnection: async (input) => {
									for (let attempt = 0; ; attempt++) {
										try {
											return await views.connectScreen(input);
										} catch (error) {
											if (attempt >= 8 || input.signal.aborted) throw error;
											await wait(3000, input.signal);
										}
									}
								},
							});
							until.throwIfAborted();
							stage.close();
							this.#preview.hidden = true;
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
											? `${agent.displayName} does not have access to the computer.`
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
				if (stage.signal.aborted && !signal.aborted) {
					await this.#views.close();
					return;
				}
				throw error;
			} finally {
				if (this.#stage === stage && stage.signal.aborted) this.#stage = undefined;
			}
		};
		draw();
		void run(look);
	}
	get layout(): ComputerLayout {
		return this.#layout;
	}
	focus(): void {
		this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}
	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		this.#stage?.close();
		replace(this.el);
		this.el.remove();
	}
}
