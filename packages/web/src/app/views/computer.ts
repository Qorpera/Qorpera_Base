import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerWait } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { ComputerViewHost } from "../../ui/computer-view-host.ts";
import { ComputerViewerUnavailable, loadComputerViewer, reloadPage } from "../../ui/computer-viewer.ts";
import { h, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { leave, zoomFrom } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";

/** Thrown inside the open flow when the agent's screen belongs on another computer. */
const MOVED = Symbol("moved");

/**
 * Opening the thread's computer is the explicit intent to start and watch it.
 * The panel belongs to the company's `ComputerPanels`, not to the thread it
 * was opened in: a thread attaches it while the member is there and hands it
 * back on the way out, and the screen stays connected in between. Only the
 * member closing it, or leaving the company, ends the connection.
 */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly agentId: string;
	readonly #stop = new AbortController();
	readonly #status = h("p", { role: "status" }, t("Connecting…"));
	readonly #spinner = h("span", { class: "computer-loading-spinner", "aria-hidden": "true" });
	readonly #retry = h("button", { type: "button", class: "computer-retry", hidden: true }, t("Try again"));
	/** Offered instead of Try again when this page cannot load the screen renderer. */
	readonly #reload = h("button", { type: "button", class: "computer-retry", hidden: true }, t("Reload page"));
	readonly #loading = h("div", { class: "computer-loading" }, this.#spinner, this.#status, this.#retry, this.#reload);
	readonly #body = h("div", { class: "computer-panel-body" }, this.#loading);
	/** The preview's own way out, top right; the entered frame has its compress button instead. */
	readonly #closeButton = h("button", {
		type: "button",
		class: "computer-close",
		"aria-label": t("Close computer"),
		title: t("Close"),
	});
	readonly #views: ComputerViewHost;
	readonly #fitPreview: () => void;
	readonly #setExpanded: (expanded: boolean) => void;
	/** The attached thread's way of putting the panel away for good. */
	#close: () => void = () => {};
	/** Takes back the idle wakes this panel asked for and never used. */
	#withdrawWakes: () => void = () => {};
	#title: string;
	#name: string;
	/** Which of the company's computers shows the screen, once the company has more than one. */
	#number: number | undefined;
	#busy = false;

	constructor(agent: HostedStaffAgent, computer?: WebCompanyComputer, parentSignal?: AbortSignal) {
		this.agentId = agent.id;
		this.#name = agent.displayName;
		this.#title = this.#titleText();
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#views = new ComputerViewHost(signal);
		this.el = h(
			"aside",
			{
				class: "computer-panel",
				"aria-label": t("Agent computer"),
				"aria-description": t(
					"Drag to move, drag an edge to resize. When focused, arrow keys move it and plus or minus resize it.",
				),
				tabindex: "0",
			},
			this.#body,
			this.#closeButton,
		);
		this.#closeButton.addEventListener("click", () => this.#close(), { signal });
		// The drag also marks pointer focus on the panel, which keeps the hover controls down after a press.
		this.#fitPreview = attachComputerDrag(this.el, signal);
		const covered = new Map<HTMLElement, boolean>();
		this.#setExpanded = (expanded: boolean) => {
			// Going full size and back is one zoom from the box it had (styles/motion.css has the open).
			const from =
				this.el.isConnected && expanded !== this.el.classList.contains("is-entered")
					? this.el.getBoundingClientRect()
					: undefined;
			this.el.classList.toggle("is-entered", expanded);
			zoomFrom(this.el, from);
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
				this.#fitPreview();
			}
		};
		signal.addEventListener("abort", () => this.#setExpanded(false), { once: true });
		this.el.addEventListener(
			"keydown",
			(event) => {
				if (matchesKey(event, "dismiss")) {
					if (document.fullscreenElement && this.el.contains(document.fullscreenElement)) return;
					event.preventDefault();
					event.stopPropagation();
					if (this.el.classList.contains("is-entered")) {
						this.el.querySelector<HTMLButtonElement>(".screen-viewer-back")?.click();
						return;
					}
					this.#close();
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
			unavailable(t("Computer access is not available yet."));
			return;
		}
		// Fetch the screen renderer beside the first read, so a screen that is up
		// never waits for it. Its failure is handled where openOn waits for it.
		void loadComputerViewer().catch(() => undefined);
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
		// Idle wakes asked for here, by the same keys; a connected screen used them.
		// `sent` settles once every request for that wake has, so none lands after its withdrawal.
		const wakes = new Map<string, { sent: Promise<unknown>; withdraw: () => Promise<unknown> }>();
		this.#withdrawWakes = () => {
			for (const wake of wakes.values()) void wake.sent.then(wake.withdraw).catch(() => undefined);
			wakes.clear();
		};
		/** A state the member can only wait out: it stays on screen with a way to ask again. */
		const blocked = (text: string) => {
			unavailable(text);
			this.#retry.hidden = false;
		};
		/** A backend that predates several computers per company answered once: stop asking. */
		let single = false;
		/** The computer that shows this agent's screen. A company can run several; a
		 * backend that predates that has one, the catalog's. */
		const locate = async () => {
			const placed = single ? undefined : await computer.client.agentComputer(agent.id, signal);
			signal.throwIfAborted();
			if (placed === undefined) {
				single = true;
				const catalog = await computer.client.catalog(signal);
				signal.throwIfAborted();
				if (!catalog.scope) {
					unavailable(t("This company has no machine yet."));
					return undefined;
				}
				return { scope: catalog.scope, canManage: catalog.canManage, number: 1, computers: 1 };
			}
			if (!placed.computer) {
				if (placed.computers === 0) unavailable(t("This company has no machine yet."));
				else if (placed.placement === "denied")
					unavailable(t("{name} does not have access to the computer.", { name: agent.displayName }));
				else if (placed.placement === "new")
					blocked(t("All computers are in use. An owner or admin can start another machine."));
				else blocked(t("The machine is not ready yet."));
				return undefined;
			}
			return {
				scope: placed.computer.scope,
				canManage: placed.canManage,
				number: placed.computer.number,
				computers: placed.computers,
				waiting: placed.computer.waiting,
			};
		};
		const waitingLine = (waiting: CompanyComputerWait | null | undefined, number: number) =>
			waiting === "hours"
				? t("Out of computer hours. The machine starts by itself once hours are added.")
				: waiting === "setup"
					? number > 1
						? t("Setting up another machine. This can take a while.")
						: t("Setting up the machine. This can take a while.")
					: waiting === "room"
						? t("Waiting for room on our servers. It starts as soon as there is room.")
						: undefined;
		/** While a computer starts: why it is not up yet, or that the agent now has
		 * room on another computer (then the panel moves there). */
		const recheck = async (scope: CompanyComputerScope, number: number, until: AbortSignal) => {
			if (single) return undefined;
			const placed = await computer.client.agentComputer(agent.id, until).catch(() => undefined);
			until.throwIfAborted();
			if (!placed?.computer) return undefined;
			if (placed.computer.scope.companyComputerId !== scope.companyComputerId)
				return placed.placement === "screen" || placed.placement === "room" ? MOVED : undefined;
			return waitingLine(placed.computer.waiting, number);
		};
		/** Resolves to "moved" when the agent's screen is (or should now be) on another computer. */
		const open = async (): Promise<"moved" | undefined> => {
			const located = await locate();
			if (!located) return;
			const { scope, canManage } = located;
			try {
				return await openOn(located, scope, canManage);
			} catch (error) {
				if (error !== MOVED) throw error;
				return "moved";
			}
		};
		const openOn = async (
			located: NonNullable<Awaited<ReturnType<typeof locate>>>,
			scope: CompanyComputerScope,
			canManage: boolean,
		): Promise<"moved" | undefined> => {
			// A page that cannot show the screen asks nothing to start, wake or open:
			// a renderer that failed to load stays failed until the page is reloaded.
			await loadComputerViewer();
			signal.throwIfAborted();
			this.#number = located.computers > 1 ? located.number : undefined;
			this.#title = this.#titleText();
			this.#applyTitle();
			const startClient = computer.client.start(scope);
			const ensureActive = async (until: AbortSignal, expectedGeneration?: number): Promise<boolean> => {
				let requestedKey: string | undefined;
				for (let pass = 0; ; pass++) {
					const start = await startClient.status(until);
					until.throwIfAborted();
					if (expectedGeneration !== undefined && start.computerGeneration !== expectedGeneration)
						throw new Error("OFFICE_SCREEN_CHANGED");
					if (start.officeState === "active") return true;
					const idle = start.maintenance?.reason === "idle";
					const cycle = idle ? `idle:${start.maintenance!.transitionId}` : "start";
					const key = `${scope.companyId}:${scope.environmentId}:${scope.companyComputerId}:${scope.logicalComputerId}:${start.computerGeneration}:${cycle}`;
					if (start.officeState === "maintenance" && !idle) {
						this.#status.textContent = t("The machine is restarting. It comes back on its own.");
					} else if (start.officeState === "retired") {
						unavailable(t("This machine has been retired."));
						return false;
					} else if (!canManage && !idle) {
						// Not ours to start; the agent may still get room on another machine meanwhile.
						if (pass > 0 && pass % 4 === 0 && (await recheck(scope, located.number, until)) === MOVED)
							throw MOVED;
						this.#status.textContent = t("The machine is off. An owner or admin can start it.");
					} else if (idle && !computer.canRequestWake) {
						this.#status.textContent = t(
							"You have read-only access. A company member with write access can wake the machine.",
						);
					} else {
						if ((!start.intent || idle) && requestedKey !== key) {
							requestedKey = key;
							// An unclear reply retains the exact computer generation and idle cycle's identity.
							const requestId = startRequests.get(key) ?? crypto.randomUUID();
							startRequests.set(key, requestId);
							// The request finishes even if the panel closes, so a withdrawal lands after it.
							const sent = startClient.request(
								start.computerGeneration,
								requestId,
								new AbortController().signal,
							);
							if (idle)
								wakes.set(key, {
									sent: Promise.allSettled([wakes.get(key)?.sent, sent]),
									withdraw: () =>
										startClient.withdraw(start.computerGeneration, requestId, new AbortController().signal),
								});
							await new Promise<unknown>((resolve, reject) => {
								const cancel = () => reject(new Error("closed"));
								until.addEventListener("abort", cancel, { once: true });
								sent.then(resolve, reject).finally(() => until.removeEventListener("abort", cancel));
								if (until.aborted) cancel();
							});
							until.throwIfAborted();
						}
						// A new computer can wait for its server first, and a new or sleeping one for computer
						// hours; say so instead of "starting" for minutes.
						const reason =
							start.officeState !== "provisioning" && !idle
								? undefined
								: pass === 0
									? waitingLine(located.waiting, located.number)
									: pass % 4 === 0
										? await recheck(scope, located.number, until)
										: this.#status.textContent;
						if (reason === MOVED) throw MOVED;
						this.#status.textContent = reason ?? t("Starting the machine…");
					}
					await wait(3000, until);
				}
			};
			if (!(await ensureActive(signal))) return;
			let views: ReturnType<WebCompanyComputer["views"]>;
			try {
				views = computer.views(scope);
			} catch {
				unavailable(t("Computer viewing is not set up here."));
				return;
			}
			this.#status.textContent = t("Connecting…");
			let asked = false;
			for (;;) {
				const status = await views.status(signal);
				signal.throwIfAborted();
				if (status.state === "retired") {
					unavailable(t("This machine has been retired."));
					return;
				}
				if (status.state !== "active") {
					if (!(await ensureActive(signal))) return;
					asked = false;
					this.#status.textContent = t("Connecting…");
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
							onExpandedChange: this.#setExpanded,
							onClosed: () => this.#close(),
							binding: screen.binding,
							title: this.#title,
							canControl: canManage,
							sharedControl: true,
							// Guest startup can outlast a connection attempt; reconnect to the same binding.
							requestConnection: async (input) => {
								for (let attempt = 0; ; attempt++) {
									try {
										const connection = await views.connectScreen(input);
										wakes.clear();
										return connection;
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
						// A rename that landed while the viewer was opening reaches its heading too.
						this.#applyTitle();
						this.#loading.hidden = true;
						return;
					}
					if (!asked) {
						asked = true;
						const opened = await views.openScreen(agent.id, signal);
						signal.throwIfAborted();
						if (opened.state === "refused") {
							if (opened.reason === "AGENT_ON_OTHER_COMPUTER") throw MOVED;
							const text =
								opened.reason === "SCREEN_CAPACITY_EXHAUSTED"
									? t("All computers on this machine are in use. Try again when one is free.")
									: opened.reason === "AGENT_HAS_NO_COMPUTER_ACCESS"
										? t("{name} does not have access to the computer.", { name: agent.displayName })
										: opened.reason === "SCREEN_OCCUPIED"
											? t("{name}'s computer is being handed over. It opens here in a moment.", {
													name: agent.displayName,
												})
											: t("The machine is not ready yet.");
							if (opened.reason !== "SCREEN_OCCUPIED" && opened.reason !== "COMPUTER_NOT_ACTIVE") {
								unavailable(text);
								return;
							}
							this.#status.textContent = text;
							asked = false;
						} else continue;
					}
				} else {
					this.#status.textContent = t("The machine is private right now. Shared viewing returns when that ends.");
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
			this.#status.textContent = t("Connecting…");
			try {
				// An agent that moved between computers is followed a few times, never in a loop.
				for (let moves = 0; ; moves++) {
					if ((await open()) !== "moved") break;
					// The computer it left needs no wake from this panel any more.
					this.#withdrawWakes();
					if (moves >= 2) {
						unavailable(t("The machine is not ready yet."));
						this.#retry.hidden = false;
						break;
					}
					this.#status.textContent = t("Connecting…");
					await wait(1000, signal);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof ComputerViewerUnavailable) {
					unavailable(t("The computer screen could not be loaded in this tab. Reload the page to open it."));
					this.#reload.hidden = false;
				} else {
					unavailable(t("The computer could not be reached. Try again."));
					this.#retry.hidden = false;
				}
			} finally {
				this.#busy = false;
			}
		};
		this.#retry.addEventListener("click", () => void run());
		this.#reload.addEventListener("click", () => reloadPage(), { signal });
		void run();
	}

	/** Whether a thread holds the panel right now (the thread itself may not be in the page yet). */
	get attached(): boolean {
		return this.el.parentElement !== null;
	}

	/** The agent was renamed: the viewer keeps its connection and only its title follows. */
	retitle(displayName: string): void {
		this.#name = displayName;
		const title = this.#titleText();
		if (title === this.#title) return;
		this.#title = title;
		this.#applyTitle();
	}

	#titleText(): string {
		return this.#number === undefined
			? t("{name} · Computer", { name: this.#name })
			: t("{name} · Computer · Machine {number}", { name: this.#name, number: String(this.#number) });
	}

	#applyTitle(): void {
		this.#body.querySelector(".screen-viewer-overlay")?.setAttribute("aria-label", this.#title);
		const heading = this.#body.querySelector(".screen-viewer-heading > span");
		if (heading) heading.textContent = this.#title;
	}

	/** Show the panel in a thread. `close` is that thread's request to end it for good. */
	attach(body: HTMLElement, close: () => void): void {
		if (this.#stop.signal.aborted) return;
		this.#close = close;
		body.append(this.el);
		this.#fitPreview();
	}

	/** Leave the thread, keeping the connection for the next thread that attaches it. */
	detach(): void {
		this.#close = () => {};
		// A member who left mid-screen returns to a preview; the thread it covered is gone.
		if (this.el.classList.contains("is-entered")) {
			const back = this.el.querySelector<HTMLButtonElement>(".screen-viewer-back");
			if (back) back.click();
			else this.#setExpanded(false);
		}
		this.el.remove();
		// Removal takes focus without a focusout in every browser; the next focus in the panel starts clean.
		this.el.classList.remove("is-pointer-focus");
		// Lets the thread that was left be collected: nothing of it is watched any more.
		this.#fitPreview();
		// It slid in once; coming back to a thread it is simply there, as after a drag.
		this.el.style.animation = "none";
	}

	focus(): void {
		this.el.focus();
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		this.#stop.abort();
		// Closed before its screen came up: the wake is no longer wanted from here.
		// Leaving the company sends nothing; its transport refuses after teardown.
		this.#withdrawWakes();
		this.#close = () => {};
		// The viewer already closed with the abort above.
		this.el.style.removeProperty("animation");
		leave(this.el, "is-closing", () => {
			replace(this.el);
			this.el.remove();
		});
	}
}

/**
 * The company's open computer panels, one per agent. A panel opened in any of
 * an agent's threads stays open, screen connected, until a member closes it or
 * leaves the company; the threads that show it come and go.
 */
export class ComputerPanels {
	readonly #panels = new Map<string, ComputerPanel>();
	readonly #computer: WebCompanyComputer | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #onAbort = () => this.dispose();

	constructor(computer?: WebCompanyComputer, signal?: AbortSignal) {
		this.#computer = computer;
		this.#signal = signal;
		signal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	/** The panel a thread left open for this agent, if any. */
	get(agentId: string): ComputerPanel | undefined {
		return this.#panels.get(agentId);
	}

	/** The agent's panel, started now unless a thread already opened it; none once the company is left. */
	open(agent: HostedStaffAgent): ComputerPanel | undefined {
		if (this.#signal?.aborted) return undefined;
		let panel = this.#panels.get(agent.id);
		if (panel) {
			// The agent may have been renamed while no thread showed the panel.
			panel.retitle(agent.displayName);
			return panel;
		}
		panel = new ComputerPanel(agent, this.#computer, this.#signal);
		this.#panels.set(agent.id, panel);
		return panel;
	}

	/** End the agent's panel and its connection. */
	close(agentId: string): void {
		const panel = this.#panels.get(agentId);
		this.#panels.delete(agentId);
		panel?.dispose();
	}

	dispose(): void {
		this.#signal?.removeEventListener("abort", this.#onAbort);
		for (const agentId of [...this.#panels.keys()]) this.close(agentId);
	}
}
