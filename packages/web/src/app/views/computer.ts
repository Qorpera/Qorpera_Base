import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { h, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";

/** Opening the thread's computer is the explicit intent to start and watch it. */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly #stop = new AbortController();
	readonly #status = h("p", { role: "status" }, "Connecting…");
	readonly #spinner = h("span", { class: "computer-loading-spinner", "aria-hidden": "true" });
	readonly #retry = h("button", { type: "button", class: "computer-retry", hidden: true }, "Try again");
	readonly #loading = h("div", { class: "computer-loading" }, this.#spinner, this.#status, this.#retry);
	readonly #body = h("div", { class: "computer-panel-body" }, this.#loading);
	readonly #views: ComputerViewHost;
	#busy = false;

	constructor(agent: HostedStaffAgent, close: () => void, computer?: WebCompanyComputer, parentSignal?: AbortSignal) {
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#views = new ComputerViewHost(signal);
		this.el = h(
			"aside",
			{
				class: "computer-panel",
				"aria-label": "Agent computer",
				"aria-description":
					"Drag to move, drag an edge to resize. When focused, arrow keys move it and plus or minus resize it.",
				tabindex: "0",
			},
			this.#body,
		);
		const fitPreview = attachComputerDrag(this.el, signal);
		const covered = new Map<HTMLElement, boolean>();
		const setExpanded = (expanded: boolean) => {
			this.el.classList.toggle("is-entered", expanded);
			if (expanded) {
				for (const child of this.el.parentElement?.querySelector(".thread-conversation")?.children ?? []) {
					if (!(child instanceof HTMLElement) || child.classList.contains("thread-header") || covered.has(child))
						continue;
					covered.set(child, child.inert);
					child.inert = true;
				}
			} else {
				for (const [element, inert] of covered) element.inert = inert;
				covered.clear();
				fitPreview();
			}
		};
		signal.addEventListener("abort", () => setExpanded(false), { once: true });
		this.el.addEventListener(
			"keydown",
			(event) => {
				if (matchesKey(event, "dismiss")) {
					event.preventDefault();
					event.stopPropagation();
					if (this.el.classList.contains("is-entered")) {
						this.el.querySelector<HTMLButtonElement>(".screen-viewer-back")?.click();
						return;
					}
					close();
				}
			},
			// noVNC consumes canvas key events before they can bubble to the panel.
			{ capture: true, signal },
		);
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (signal.aborted) {
			this.dispose();
			return;
		}
		const unavailable = (text: string) => {
			this.#status.textContent = text;
			this.#spinner.hidden = true;
		};
		if (!computer) {
			unavailable("Computer access is not available yet.");
			return;
		}
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
		const startRequests = new Map<string, string>();
		const open = async () => {
			const catalog = await computer.client.catalog(signal);
			signal.throwIfAborted();
			const { scope, canManage } = catalog;
			if (!scope) {
				unavailable("This company has no computer yet.");
				return;
			}
			const startClient = computer.client.start(scope);
			const ensureActive = async (until: AbortSignal, expectedGeneration?: number): Promise<boolean> => {
				let requestedKey: string | undefined;
				for (;;) {
					const start = await startClient.status(until);
					until.throwIfAborted();
					if (expectedGeneration !== undefined && start.computerGeneration !== expectedGeneration)
						throw new Error("OFFICE_SCREEN_CHANGED");
					if (start.officeState === "active") return true;
					const idle = start.maintenance?.reason === "idle";
					const cycle = idle ? `idle:${start.maintenance!.transitionId}` : "start";
					const key = `${scope.companyId}:${scope.environmentId}:${scope.companyComputerId}:${scope.logicalComputerId}:${start.computerGeneration}:${cycle}`;
					if (start.officeState === "maintenance" && !idle) {
						this.#status.textContent = "The computer is restarting. It comes back on its own.";
					} else if (start.officeState === "retired") {
						unavailable("This computer has been retired.");
						return false;
					} else if (!canManage && !idle) {
						this.#status.textContent = "The computer is off. An owner or admin can start it.";
					} else if (idle && !computer.canRequestWake) {
						this.#status.textContent =
							"You have read-only access. A company member with write access can wake the computer.";
					} else {
						if ((!start.intent || idle) && requestedKey !== key) {
							requestedKey = key;
							// An unclear reply retains the exact computer generation and idle cycle's identity.
							let requestId = startRequests.get(key);
							if (!requestId) {
								requestId = crypto.randomUUID();
								startRequests.set(key, requestId);
							}
							await startClient.request(start.computerGeneration, requestId, until);
							until.throwIfAborted();
						}
						this.#status.textContent = "Starting the computer…";
					}
					await wait(3000, until);
				}
			};
			if (!(await ensureActive(signal))) return;
			let views: ReturnType<WebCompanyComputer["views"]>;
			try {
				views = computer.views(scope);
			} catch {
				unavailable("Screen viewing is not set up here.");
				return;
			}
			this.#status.textContent = "Connecting…";
			let asked = false;
			for (;;) {
				const status = await views.status(signal);
				signal.throwIfAborted();
				if (status.state === "retired") {
					unavailable("This computer has been retired.");
					return;
				}
				if (status.state !== "active") {
					if (!(await ensureActive(signal))) return;
					asked = false;
					this.#status.textContent = "Connecting…";
					await wait(3000, signal);
					continue;
				}
				if (status.state === "active" && status.privacyState === "shared") {
					const screen = status.screens
						.filter((item) => item.binding.staffAgentId === agent.id && !item.drainPending)
						.sort((a, b) => a.binding.screenOrdinal - b.binding.screenOrdinal)[0];
					if (screen) {
						await this.#views.open({
							mount: this.#body,
							autofocus: false,
							onExpandedChange: setExpanded,
							onClosed: close,
							binding: screen.binding,
							title: `${agent.displayName} · Computer`,
							canControl: canManage,
							sharedControl: true,
							// Guest startup can outlast a connection attempt; reconnect to the same binding.
							requestConnection: async (input) => {
								for (let attempt = 0; ; attempt++) {
									try {
										return await views.connectScreen(input);
									} catch (error) {
										if (attempt >= 8 || input.signal.aborted) throw error;
										const state = await startClient.status(input.signal);
										input.signal.throwIfAborted();
										if (state.computerGeneration !== input.binding.computerGeneration)
											throw new Error("OFFICE_SCREEN_CHANGED");
										if (state.maintenance?.reason === "idle") {
											if (!(await ensureActive(input.signal, input.binding.computerGeneration))) throw error;
										}
										await wait(3000, input.signal);
									}
								}
							},
						});
						signal.throwIfAborted();
						this.#loading.hidden = true;
						return;
					}
					if (!asked) {
						asked = true;
						const opened = await views.openScreen(agent.id, signal);
						signal.throwIfAborted();
						if (opened.state === "refused") {
							const text =
								opened.reason === "SCREEN_CAPACITY_EXHAUSTED"
									? "All screens on this computer are in use. Try again when one is free."
									: opened.reason === "AGENT_HAS_NO_COMPUTER_ACCESS"
										? `${agent.displayName} does not have access to the computer.`
										: opened.reason === "SCREEN_OCCUPIED"
											? `${agent.displayName}'s screen is being handed over. It opens here in a moment.`
											: "The computer is not ready yet.";
							if (opened.reason !== "SCREEN_OCCUPIED" && opened.reason !== "COMPUTER_NOT_ACTIVE") {
								unavailable(text);
								return;
							}
							this.#status.textContent = text;
							asked = false;
						} else continue;
					}
				} else {
					this.#status.textContent = "The computer is private right now. Shared viewing returns when that ends.";
				}
				await wait(3000, signal);
			}
		};
		const run = async () => {
			if (this.#busy || signal.aborted) return;
			this.#busy = true;
			if (document.activeElement === this.#retry) this.focus();
			this.#retry.hidden = true;
			this.#spinner.hidden = false;
			this.#status.textContent = "Connecting…";
			try {
				await open();
			} catch {
				if (!signal.aborted) {
					unavailable("The computer could not be reached. Try again.");
					this.#retry.hidden = false;
				}
			} finally {
				this.#busy = false;
			}
		};
		this.#retry.addEventListener("click", () => void run());
		void run();
	}

	focus(): void {
		this.el.focus();
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		replace(this.el);
		this.el.remove();
	}
}
