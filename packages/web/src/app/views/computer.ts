import type { MemberAgentMachine, MemberAgentMachines } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { MachineScreenLook } from "../../cloud/machine-screens.ts";
import type { RealtimeResource } from "../../cloud/realtime.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { type MachineScreenPicture, MachineScreenView } from "../../ui/machine-screen-view.ts";
import { leave, zoomFrom } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";

/** The least time from one look's start to the next: about a picture a second while it changes. */
export const LOOK_EVERY_MS = 1000;
/** After 3 unchanged pictures in a row the window looks every 2 s, after 10 every 3 s; a changed picture, a click in
 * the window or a `machines` hint brings it back to every second. */
export const LOOK_UNCHANGED_MS: readonly (readonly [unchanged: number, every: number])[] = [
	[10, 3000],
	[3, 2000],
];
/** How often the window reads its agent's machines again while it is shown (the `machines` hint reads them at once). */
export const MACHINES_EVERY_MS = 15_000;
/** How often a screen that is off, or hidden, is looked at again. */
export const SCREEN_OFF_EVERY_MS = 5000;
/** With no touch on the page for this long the window stops looking and asks whether the member still watches. */
export const PAUSE_AFTER_MS = 30 * 60_000;
/** How often a member who touches the page says again that they watch (the database keeps the desktop on 30 min). */
const CONFIRM_EVERY_MS = 5 * 60_000;
/** The waits after failed looks or reads: 2, 4, 8, then 15 s. */
const BACKOFF_MS = [2000, 4000, 8000, 15_000];
/** Failed reads in a row before the window says it cannot reach the computer. */
const FAILURES_SHOWN = 2;

/** The company's change hints, by the resource that changed (CompanyController.onInvalidate). */
export type MachineHints = (listener: (resource: RealtimeResource) => void) => () => void;

export interface ComputerPanelOptions {
	/** `machines` hints read the agent's machines at once. */
	readonly hints?: MachineHints;
	/** How a picture is decoded (the tests' own). */
	readonly decode?: (png: Blob) => Promise<MachineScreenPicture>;
}

/** What the window shows instead of a picture. */
type Shown =
	| "loading"
	| "unavailable"
	| "none"
	| "headless"
	| "asleep"
	| "starting"
	| "off"
	| "hidden"
	| "updating"
	| "image"
	| "error"
	| "paused";

/**
 * An agent's computer window (migration 20260930712000; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a):
 * the screen of the desktop computer the agent uses, as a picture that refreshes about once a second, with a switcher
 * in its corner when the agent has more than one. Every member who reads the company may watch; owners, admins and
 * contributors may wake a sleeping machine. It looks only while a thread shows it and its tab is visible, slows down
 * while nothing changes, and stops after 30 minutes without a touch on the page until the member says they still watch.
 * There is no take-over yet (stage 1b adds a member's control of the desktop beside the picture).
 *
 * The panel belongs to the company's `ComputerPanels`, not to the thread it was opened in: a thread attaches it while
 * the member is there and hands it back on the way out. Only the member closing it, or leaving the company, ends it.
 */
export class ComputerPanel {
	readonly el: HTMLElement;
	readonly agentId: string;
	readonly #stop = new AbortController();
	readonly #spinner = h("span", { class: "computer-loading-spinner", "aria-hidden": "true" });
	readonly #status = h("p", { role: "status" }, t("Connecting…"));
	/** A second, quieter line under the status (a waiting computer's reason, a sleeping one's note for viewers). */
	readonly #detail = h("p", { class: "computer-loading-detail", hidden: true });
	/** Wake it, Keep watching or Try again, as the state asks. */
	readonly #action = h("button", { type: "button", class: "computer-retry", hidden: true });
	readonly #loading = h("div", { class: "computer-loading" }, this.#spinner, this.#status, this.#detail, this.#action);
	readonly #body = h("div", { class: "computer-panel-body" }, this.#loading);
	/** The preview's own way out, top right; the entered frame has its Back button instead. */
	readonly #closeButton = h("button", {
		type: "button",
		class: "computer-close",
		"aria-label": t("Close computer"),
		title: t("Close"),
	});
	/** The machine switcher on the preview, top left; the entered frame shows its own beside the title. */
	readonly #switcher: HTMLButtonElement;
	readonly #frameSwitcher: HTMLButtonElement;
	readonly #fitPreview: () => void;
	readonly #setExpanded: (expanded: boolean) => void;
	#view: MachineScreenView | undefined;
	/** The attached thread's way of putting the panel away for good. */
	#close: () => void = () => {};
	#name: string;
	/** Wakes the look loop before its wait ends (attached, shown again, a hint, a touch, a choice). */
	#poke: () => void = () => {};

	// What the loop knows. The machines as last read, the member's own choice, and the picture the member has.
	#listed: MemberAgentMachines | undefined;
	#listedAt = Number.NEGATIVE_INFINITY;
	#listStale = true;
	#chosen: string | undefined;
	#machineId: string | undefined;
	#etag: string | null = null;
	#lastLook = Number.NEGATIVE_INFINITY;
	#delay = LOOK_EVERY_MS;
	#unchanged = 0;
	#failures = 0;
	#waking = false;
	// The member's attention: their last touch on the page, whether they still watch, and when they last said so.
	#lastTouch = Date.now();
	#paused = false;
	#confirm = true;
	#confirmedAt = Number.NEGATIVE_INFINITY;

	constructor(
		agent: HostedStaffAgent,
		computer?: WebCompanyComputer,
		parentSignal?: AbortSignal,
		options: ComputerPanelOptions = {},
	) {
		this.agentId = agent.id;
		this.#name = agent.displayName;
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#switcher = this.#switcherButton(signal);
		this.#frameSwitcher = this.#switcherButton(signal);
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
			this.#switcher,
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
				if (!matchesKey(event, "dismiss")) return;
				if (document.fullscreenElement && this.el.contains(document.fullscreenElement)) return;
				event.preventDefault();
				event.stopPropagation();
				if (this.#view?.entered) this.#view.back();
				else this.#close();
			},
			{ capture: true, signal },
		);
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (signal.aborted) {
			this.dispose();
			return;
		}
		if (!computer) {
			this.#show("unavailable");
			return;
		}
		this.#view = new MachineScreenView({
			mount: this.#body,
			title: this.#titleText(),
			onExpandedChange: this.#setExpanded,
			...(options.decode ? { decode: options.decode } : {}),
		});
		this.#view.setSwitcher(this.#frameSwitcher);
		// The member's attention: any touch on the page; coming back to the tab counts as one.
		const touched = () => this.#touched();
		for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"])
			document.addEventListener(type, touched, { capture: true, passive: true, signal });
		document.addEventListener(
			"visibilitychange",
			() => {
				if (document.visibilityState !== "visible") return;
				this.#touched();
				this.#poke();
			},
			{ signal },
		);
		// A click in the window brings the looks back to every second.
		this.el.addEventListener("pointerdown", () => this.#quicken(), { signal });
		this.#action.addEventListener("click", () => void this.#act(computer, signal), { signal });
		const unsubscribe = options.hints?.((resource) => {
			if (resource !== "machines") return;
			this.#listStale = true;
			this.#quicken();
		});
		if (unsubscribe) signal.addEventListener("abort", unsubscribe, { once: true });
		void this.#loop(computer, signal).catch(() => undefined);
	}

	/** Whether a thread holds the panel right now (the thread itself may not be in the page yet). */
	get attached(): boolean {
		return this.el.parentElement !== null;
	}

	/** The agent was renamed: only the title follows. */
	retitle(displayName: string): void {
		this.#name = displayName;
		this.#view?.setTitle(this.#titleText());
		// Texts that name the agent follow at the next look.
		this.#poke();
	}

	/** Show the panel in a thread. `close` is that thread's request to end it for good. */
	attach(body: HTMLElement, close: () => void): void {
		if (this.#stop.signal.aborted) return;
		this.#close = close;
		body.append(this.el);
		this.#fitPreview();
		// Showing the window again is the member's word that they watch.
		if (this.#paused) {
			this.#paused = false;
			this.#confirm = true;
		}
		this.#touched();
		this.#poke();
	}

	/** Leave the thread; the window stops looking until a thread shows it again. */
	detach(): void {
		this.#close = () => {};
		// A member who left mid-screen returns to a preview; the thread it covered is gone.
		this.#view?.back();
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
		this.#poke();
		this.#close = () => {};
		this.#view?.dispose();
		this.el.style.removeProperty("animation");
		leave(this.el, "is-closing", () => {
			replace(this.el);
			this.el.remove();
		});
	}

	#titleText(): string {
		return t("{name} · Computer", { name: this.#name });
	}

	/** The loop: the agent's machines, then looks at the chosen one while the window is shown and the member watches. */
	async #loop(computer: WebCompanyComputer, signal: AbortSignal): Promise<void> {
		for (;;) {
			signal.throwIfAborted();
			if (!this.attached || document.visibilityState === "hidden") {
				await this.#wait(Number.POSITIVE_INFINITY, signal);
				continue;
			}
			if (this.#paused || Date.now() - this.#lastTouch >= PAUSE_AFTER_MS) {
				this.#paused = true;
				this.#etag = null;
				this.#view?.clear();
				this.#show("paused");
				await this.#wait(Number.POSITIVE_INFINITY, signal);
				continue;
			}
			const listDue = this.#listedAt + MACHINES_EVERY_MS;
			if (this.#listStale || Date.now() >= listDue) {
				try {
					this.#listed = await computer.agentMachines(this.agentId, signal);
					this.#listedAt = Date.now();
					this.#listStale = false;
					this.#failures = 0;
				} catch {
					signal.throwIfAborted();
					this.#failed();
					await this.#wait(this.#backoff(), signal);
					continue;
				}
			}
			const machine = this.#pick();
			if (machine?.machineId !== this.#machineId) {
				this.#machineId = machine?.machineId;
				this.#etag = null;
				this.#lastLook = Number.NEGATIVE_INFINITY;
				this.#view?.clear();
			}
			this.#syncSwitchers();
			if (!machine || machine.state !== "running") {
				this.#view?.clear();
				this.#etag = null;
				this.#showMachine(machine);
				await this.#wait(this.#listedAt + MACHINES_EVERY_MS - Date.now(), signal);
				continue;
			}
			const due = this.#lastLook + this.#delay;
			if (Date.now() < due) {
				await this.#wait(Math.min(due, this.#listedAt + MACHINES_EVERY_MS) - Date.now(), signal);
				continue;
			}
			this.#lastLook = Date.now();
			const watching = this.#confirm;
			let look: MachineScreenLook;
			try {
				look = await computer.screens.look(machine.machineId, { etag: this.#etag, watching }, signal);
			} catch {
				signal.throwIfAborted();
				this.#failed();
				this.#delay = this.#backoff();
				continue;
			}
			signal.throwIfAborted();
			// The member's word reached the database: the desktop stays on for 30 minutes from now.
			if (watching) {
				this.#confirm = false;
				this.#confirmedAt = Date.now();
			}
			this.#failures = 0;
			if (machine.machineId !== this.#machineId) continue;
			if (look.kind === "picture") {
				if (await this.#view?.show(look.png)) {
					this.#etag = look.etag;
					this.#unchanged = 0;
				}
				this.#delay = LOOK_EVERY_MS;
				continue;
			}
			if (look.kind === "unchanged") {
				this.#unchanged++;
				this.#view?.live();
				this.#delay = LOOK_UNCHANGED_MS.find(([after]) => this.#unchanged >= after)?.[1] ?? LOOK_EVERY_MS;
				continue;
			}
			switch (look.code) {
				case "MACHINE_NOT_RUNNING":
				case "MACHINE_BOOT_CHANGED":
					// The machine changed: read its state again, then look.
					this.#listStale = true;
					this.#delay = LOOK_EVERY_MS;
					break;
				case "SCREEN_TOO_SOON":
					this.#delay = LOOK_EVERY_MS;
					break;
				case "SCREEN_HELD":
					// The company folder has not let the next picture out yet: the last one stays, marked.
					if (this.#view?.shown) this.#view.updating();
					else this.#show("updating");
					this.#delay = 2000;
					break;
				case "DESKTOP_NOT_RUNNING":
					this.#unpicture("off");
					this.#delay = SCREEN_OFF_EVERY_MS;
					break;
				case "SCREEN_HIDDEN":
				case "MACHINE_NEEDS_COMPANY_VIEW":
					this.#unpicture("hidden");
					this.#delay = SCREEN_OFF_EVERY_MS;
					break;
				case "MACHINE_IMAGE_WITHOUT_SCREEN":
					this.#unpicture("image");
					this.#delay = MACHINES_EVERY_MS;
					break;
			}
		}
	}

	/** Waits `ms` (at most until the next machines read is due), or until something pokes the loop. */
	#wait(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				if (this.#poke === done) this.#poke = () => {};
				resolve();
			};
			const timer = Number.isFinite(ms) ? setTimeout(done, Math.max(0, ms)) : undefined;
			this.#poke = done;
			signal.addEventListener("abort", done, { once: true });
		});
	}

	#backoff(): number {
		return BACKOFF_MS[Math.min(Math.max(this.#failures, 1), BACKOFF_MS.length) - 1] as number;
	}

	/** A failed read or look: the last picture stays, marked, while there is one; otherwise, after a second failure in a
	 * row, the window says it cannot reach the computer. */
	#failed(): void {
		this.#failures++;
		if (this.#view?.shown) this.#view.updating();
		else if (this.#failures >= FAILURES_SHOWN) this.#show("error");
	}

	/** The chosen machine while the agent has it and it has a screen, else the first with a screen: running ones come
	 * first, the one the agent drove last before the others. */
	#pick(): MemberAgentMachine | undefined {
		const desktops = this.#listed?.machines.filter((machine) => machine.desktopCapable) ?? [];
		return desktops.find((machine) => machine.machineId === this.#chosen) ?? desktops[0];
	}

	/** What the window says of a machine that shows no picture: none, none with a screen, asleep or on its way up. */
	#showMachine(machine: MemberAgentMachine | undefined): void {
		if (!this.#listed) {
			this.#show("loading");
			return;
		}
		if (!machine) {
			this.#show(this.#listed.machines.length ? "headless" : "none");
			return;
		}
		if (machine.state === "stopped" || machine.state === "stopping") this.#show("asleep");
		else this.#show("starting", machine.waitingFor);
	}

	/** The picture goes, and the window says why. */
	#unpicture(shown: Shown): void {
		this.#etag = null;
		this.#view?.clear();
		this.#show(shown);
	}

	#show(shown: Shown, waitingFor: "hours" | "room" | null = null): void {
		const name = { name: this.#name };
		const [status, detail, action]: [string, string | null, string | null] =
			shown === "loading"
				? [t("Connecting…"), null, null]
				: shown === "unavailable"
					? [t("Computer access is not available yet."), null, null]
					: shown === "none"
						? [
								t("{name} is not using a computer right now.", name),
								t("{name} gets one when a task needs a screen.", name),
								null,
							]
						: shown === "headless"
							? [t("{name} is working on a machine without a screen.", name), null, null]
							: shown === "asleep"
								? this.#listed?.canWake
									? [t("The computer is asleep."), null, this.#waking ? null : t("Wake it")]
									: [t("The computer is asleep."), t("Someone with edit access can wake it."), null]
								: shown === "starting"
									? [
											t("The computer is starting…"),
											waitingFor === "hours"
												? t("Out of computer hours. The machine starts by itself once hours are added.")
												: waitingFor === "room"
													? t("Waiting for room on our servers. It starts as soon as there is room.")
													: null,
											null,
										]
									: shown === "off"
										? [
												t(
													"The computer is on, but its screen is off. It turns on when {name} uses it.",
													name,
												),
												null,
												null,
											]
										: shown === "hidden"
											? [t("The screen is hidden because it may show files you can't open."), null, null]
											: shown === "updating"
												? [t("Updating…"), null, null]
												: shown === "image"
													? [
															t("This computer cannot show its screen yet. It can after it has slept."),
															null,
															null,
														]
													: shown === "error"
														? [t("The computer could not be reached. Try again."), null, t("Try again")]
														: [t("Paused to save power. Still watching?"), null, t("Keep watching")];
		this.#loading.dataset.state = shown;
		this.#spinner.hidden = !(shown === "loading" || shown === "starting" || shown === "updating" || this.#waking);
		if (this.#status.textContent !== status) this.#status.textContent = status;
		this.#detail.hidden = detail === null;
		this.#detail.textContent = detail ?? "";
		this.#action.hidden = action === null;
		this.#action.textContent = action ?? "";
	}

	/** The state's own button: wake the machine, keep watching, or try again. */
	async #act(computer: WebCompanyComputer, signal: AbortSignal): Promise<void> {
		const state = this.#loading.dataset.state;
		this.#touched();
		if (state === "paused") {
			this.#paused = false;
			this.#confirm = true;
			this.#lastLook = Number.NEGATIVE_INFINITY;
			this.#show("loading");
		} else if (state === "error") {
			this.#failures = 0;
			this.#listStale = true;
			this.#show("loading");
		} else if (state === "asleep" && this.#machineId && !this.#waking) {
			const machineId = this.#machineId;
			this.#waking = true;
			this.#show("asleep");
			try {
				await computer.wakeMachine(machineId, signal);
			} catch {
				// The list says where it stands now.
			} finally {
				this.#waking = false;
			}
			if (signal.aborted) return;
			this.#listStale = true;
		}
		if (document.activeElement === this.#action) this.focus();
		this.#poke();
	}

	/** A touch on the page: the member is there. Every few minutes it says again that they still watch. */
	#touched(): void {
		this.#lastTouch = Date.now();
		if (Date.now() - this.#confirmedAt >= CONFIRM_EVERY_MS) this.#confirm = true;
	}

	/** Looks come every second again, from now. */
	#quicken(): void {
		this.#unchanged = 0;
		if (this.#delay > LOOK_EVERY_MS && this.#failures === 0) this.#delay = LOOK_EVERY_MS;
		this.#poke();
	}

	#switcherButton(signal: AbortSignal): HTMLButtonElement {
		const button = h(
			"button",
			{
				type: "button",
				class: "computer-switcher",
				hidden: true,
				"aria-haspopup": "menu",
				title: t("Choose a computer"),
			},
			h("span", { class: "computer-switcher-name" }),
			icon("chevron-down"),
		);
		button.addEventListener(
			"click",
			(event) => {
				event.stopPropagation();
				const rect = button.getBoundingClientRect();
				const desktops = this.#listed?.machines.filter((machine) => machine.desktopCapable) ?? [];
				openContextMenu({
					label: t("Choose a computer"),
					x: rect.left,
					y: rect.bottom + 4,
					opener: button,
					items: desktops.map((machine) => ({
						label: machine.name,
						hint: machine.purpose.length > 60 ? `${machine.purpose.slice(0, 59)}…` : machine.purpose,
						checked: machine.machineId === this.#machineId,
						select: () => {
							this.#chosen = machine.machineId;
							this.#quicken();
						},
					})),
				});
			},
			{ signal },
		);
		// A press on the switcher is not the start of a drag.
		button.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
		return button;
	}

	/** The switchers name the machine shown, and show only while the agent has more than one with a screen. */
	#syncSwitchers(): void {
		const desktops = this.#listed?.machines.filter((machine) => machine.desktopCapable) ?? [];
		const current = desktops.find((machine) => machine.machineId === this.#machineId);
		for (const button of [this.#switcher, this.#frameSwitcher]) {
			button.hidden = desktops.length < 2 || !current;
			const label = button.querySelector(".computer-switcher-name");
			if (label && label.textContent !== (current?.name ?? "")) label.textContent = current?.name ?? "";
			button.setAttribute("aria-label", t("Choose a computer"));
		}
	}
}

/**
 * The company's open computer panels, one per agent. A panel opened in any of an agent's threads stays open until a
 * member closes it or leaves the company; the threads that show it come and go.
 */
export class ComputerPanels {
	readonly #panels = new Map<string, ComputerPanel>();
	readonly #computer: WebCompanyComputer | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #options: ComputerPanelOptions;
	readonly #onAbort = () => this.dispose();

	constructor(computer?: WebCompanyComputer, signal?: AbortSignal, options: ComputerPanelOptions = {}) {
		this.#computer = computer;
		this.#signal = signal;
		this.#options = options;
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
		panel = new ComputerPanel(agent, this.#computer, this.#signal, this.#options);
		this.#panels.set(agent.id, panel);
		return panel;
	}

	/** End the agent's panel. */
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
