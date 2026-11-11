import type { MemberAgentMachine, MemberAgentMachines } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type { MachineActAnswer, MachineDesktopAction, MachineScreenLook } from "../../cloud/machine-screens.ts";
import type { RealtimeResource } from "../../cloud/realtime.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { type MachineScreenPicture, MachineScreenView, TEXT_MAX } from "../../ui/machine-screen-view.ts";
import { leave, zoomFrom } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { DesktopHoldLedger, type DesktopRelease } from "./desktop-holds.ts";

/** The least time from one look's start to the next while the picture changes or the member acts on it: a look takes
 * about 0.2 s end to end (production p50 204 ms, 10 Nov 2026), and the database takes one look per 400 ms of a member. */
export const LOOK_EVERY_MS = 450;
/** After 3 unchanged pictures in a row the window looks every second, after 6 every 2 s, after 13 every 3 s; a changed
 * picture, a click in the window, the member's own action or a `machines` hint brings it back to LOOK_EVERY_MS. */
export const LOOK_UNCHANGED_MS: readonly (readonly [unchanged: number, every: number])[] = [
	[13, 3000],
	[6, 2000],
	[3, 1000],
];
/** How often the window renews the member's hold of a desktop while it shows it (the database's lease runs 5 min). */
export const KEEP_EVERY_MS = 60_000;
/** How long an action waits on a desktop another action is busy on (an agent's that began before the take-over may
 * hold it 11 s past an end that was not clean) before it is dropped. */
const BUSY_GIVE_UP_MS = 15_000;
const BUSY_RETRY_MS = 1000;
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
	/** What the member may hold of the company's desktops: the company's ledger (ComputerPanels), which outlives the
	 * window. A window opened on its own keeps one of its own. */
	readonly ledger?: DesktopHoldLedger;
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
	| "paused"
	// Another member holds the desktop (20260930713000).
	| "controlled";

/**
 * An agent's computer window (migration 20260930712000; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a):
 * the screen of the desktop computer the agent uses, as a picture that refreshes about once a second, with a switcher
 * in its corner when the agent has more than one. Every member who reads the company may watch; owners, admins and
 * contributors may wake a sleeping machine. It looks only while a thread shows it and its tab is visible, slows down
 * while nothing changes, and stops after 30 minutes without a touch on the page until the member says they still watch.
 *
 * Owners, admins and contributors take the desktop over (migration 20260930713000, stage 1b): Take over, here or on the
 * agent's take-over card, gives them its mouse and keyboard (the picture takes their clicks, drags, wheel, keys and
 * text, one action at a time) while the agent gets no pictures of it and waits; Hand back, the card's I'm done, closing
 * the window or leaving the page gives it back. The hold is the database's, renewed every minute while the window
 * shows it; other members see who holds it, not the screen. While the picture changes or the member acts, the window
 * looks every 450 ms. What the member may hold, and every hand-back until it is confirmed, is the company's ledger's
 * (DesktopHoldLedger), not the window's: closing the window forgets nothing (review r2 of #1661).
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
	/** Whether the company's page is gone (the panel's own close is not that). */
	#parentGone: () => boolean = () => false;

	// What the loop knows. The machines as last read, the member's own choice, and the picture the member has.
	#listed: MemberAgentMachines | undefined;
	#listedAt = Number.NEGATIVE_INFINITY;
	#listStale = true;
	#chosen: string | undefined;
	#machineId: string | undefined;
	#etag: string | null = null;
	/** The machine whose picture is up. */
	#pictureOf: string | undefined;
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
	// The member's hold of the desktop (20260930713000): the machine this window holds (its input and its renewals),
	// whether a take-over waits for the list, the one on its way, when the hold last changed (a list asked before then
	// says nothing of it), the company's ledger of what the member may hold (review r2), the hand-back of the machine
	// shown as the window last saw it, and the actions on their way.
	#computer: WebCompanyComputer | undefined;
	#holding: string | undefined;
	#wantTakeOver = false;
	#taking: Promise<void> | undefined;
	#holdChangedAt = Number.NEGATIVE_INFINITY;
	readonly #ledger: DesktopHoldLedger;
	#releaseShown: DesktopRelease | undefined;
	#queue: MachineDesktopAction[] = [];
	#sending = false;
	#keepTimer: ReturnType<typeof setTimeout> | undefined;
	/** Where the picture sends the member's input while they hold the desktop: one, so the picture keeps what it gathers. */
	readonly #input = { act: (action: MachineDesktopAction) => this.#enqueue(action) };
	readonly #controlText = h("span", { class: "machine-screen-control-text" });
	readonly #controlNote = h("span", { class: "machine-screen-control-note", role: "status", "aria-live": "polite" });
	readonly #controlButton = h("button", { type: "button", class: "machine-screen-control-button" });
	readonly #controls = h(
		"div",
		{ class: "machine-screen-control", hidden: true },
		h("span", { class: "machine-screen-control-words" }, this.#controlText, this.#controlNote),
		this.#controlButton,
	);

	constructor(
		agent: HostedStaffAgent,
		computer?: WebCompanyComputer,
		parentSignal?: AbortSignal,
		options: ComputerPanelOptions = {},
	) {
		this.agentId = agent.id;
		this.#name = agent.displayName;
		this.#parentGone = () => parentSignal?.aborted === true;
		this.#ledger = options.ledger ?? new DesktopHoldLedger(computer, parentSignal);
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
				// The member holds the desktop and the picture has the keyboard: Escape is the computer's.
				if (this.#view?.takesKeysFrom(event.target)) return;
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
		this.#computer = computer;
		this.#view = new MachineScreenView({
			mount: this.#body,
			title: this.#titleText(),
			onExpandedChange: this.#setExpanded,
			...(options.decode ? { decode: options.decode } : {}),
		});
		this.#view.setSwitcher(this.#frameSwitcher);
		this.#view.setControls(this.#controls);
		// The controls are the member's, not the start of a panel drag.
		this.#controls.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
		this.#controlButton.addEventListener(
			"click",
			() =>
				void (this.#holding || (this.#machineId && this.#ledger.releasing(this.#machineId))
					? this.handBack()
					: this.takeOver()),
			{ signal },
		);
		// The ledger's word goes first: a hold given back (here, on the card, as the page goes) takes no more input and is
		// never renewed. The ledger itself gives everything back as the page goes.
		const unsubscribeHolds = this.#ledger.subscribe(() => this.#holdsChanged());
		signal.addEventListener("abort", unsubscribeHolds, { once: true });
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
		// Coming back to a hold: renewed now, as the window shows it again.
		if (this.#holding) this.#scheduleKeep(0);
		this.#poke();
	}

	/** Take the desktop over (the window's Take over, or the agent's take-over card): at once when the window shows a
	 * running desktop, or as soon as it does. */
	takeOver(): void {
		if (this.#stop.signal.aborted || !this.#computer) return;
		this.#wantTakeOver = true;
		this.#touched();
		this.#poke();
		this.#startTake();
	}

	/** Starts a take-over unless one is on its way or the desktop is held: it is the window's until it settles. It takes
	 * the machine chosen now, at the click (review r4 F8). */
	#startTake(): void {
		if (this.#taking || this.#holding) return;
		const taking = this.#take(this.#pick()).finally(() => {
			if (this.#taking === taking) this.#taking = undefined;
			this.#syncControls();
		});
		this.#taking = taking;
	}

	/** Give back every desktop of this agent's the member may hold (the window's Hand back, the card's I'm done before it
	 * answers, a switch to another machine), through the company's ledger. A take-over still on its way is answered
	 * first, and a hold it gets is given back as it comes. True once the database confirmed it and a list read after
	 * that shows no hold of the member's; false while not: the window then says so, and the ledger asks again with
	 * growing waits, never renews the hold and never takes it up again from the list (review r1 F4, F5; r2). A hold never
	 * given back ends by itself in 5 minutes. */
	handBack(): Promise<boolean> {
		this.#wantTakeOver = false;
		this.#released();
		return this.#ledger.releaseAgent(this.agentId, "handed_back", true);
	}

	/** Whether the member holds the desktop the window shows. */
	get holding(): boolean {
		return this.#holding !== undefined;
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
		// The window closes: what the member may hold of the agent's desktops goes back through the company's ledger, which
		// outlives the window, asks again until the database confirms, and keeps the take-over card waiting till then
		// (review r2 F4). A take-over still on its way is answered first; what it gets goes back as it comes. As the
		// company's page goes, the ledger gives everything back itself.
		this.#wantTakeOver = false;
		this.#released();
		if (!this.#parentGone()) void this.#ledger.releaseAgent(this.agentId, "closed");
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
				const asked = Date.now();
				// A hint that comes while this read is on its way asks for another after it.
				this.#listStale = false;
				try {
					this.#listed = await computer.agentMachines(this.agentId, signal);
					this.#listedAt = Date.now();
					this.#failures = 0;
					this.#heldPerList(asked);
				} catch {
					signal.throwIfAborted();
					this.#listStale = true;
					this.#failed();
					await this.#wait(this.#backoff(), signal);
					continue;
				}
			}
			const machine = this.#pick();
			if (machine?.machineId !== this.#machineId) {
				// The window's machine changed: every machine of this agent's the ledger has but the one shown now goes back,
				// held, may be held (a lost answer), on its way or queued; the window's own state does not decide it (review r1
				// F6, r3 F8, r4 F8).
				this.#ledger.releaseOthers(this.agentId, machine?.machineId);
				this.#machineId = machine?.machineId;
				this.#etag = null;
				this.#lastLook = Number.NEGATIVE_INFINITY;
				// The last machine's picture stays, marked, until the next one's comes (or the next one says why there is
				// none): a member who switches full screen stays full screen.
				this.#view?.updating();
				// The member's word is per machine: the next machine's first look says it again, so its desktop stays on
				// while they watch it (review r1 F2).
				this.#confirm = true;
				this.#confirmedAt = Number.NEGATIVE_INFINITY;
			}
			this.#syncSwitchers();
			if (!machine || machine.state !== "running") {
				this.#view?.clear();
				this.#etag = null;
				this.#showMachine(machine);
				this.#syncControls();
				await this.#wait(this.#listedAt + MACHINES_EVERY_MS - Date.now(), signal);
				continue;
			}
			// Another member holds the desktop: who, and no picture, until they give it back (a hint) or their hold runs
			// out (its time: no hint comes then).
			if (machine.control && !machine.control.mine) {
				this.#unpicture("controlled", machine.control.name);
				const until = Date.parse(machine.control.until);
				const end = Number.isFinite(until) ? until + 500 : Number.POSITIVE_INFINITY;
				await this.#wait(Math.min(this.#listedAt + MACHINES_EVERY_MS, end) - Date.now(), signal);
				if (Date.now() >= end) this.#listStale = true;
				continue;
			}
			if (this.#wantTakeOver && !this.#holding && !this.#taking) this.#startTake();
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
					this.#pictureOf = machine.machineId;
					this.#unchanged = 0;
					// The picture is up: the state text under it goes (a screen reader reads it no more), and the take-over
					// controls show.
					this.#loading.hidden = true;
					this.#syncControls();
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
					// The company folder has not let the next picture out yet: the last one stays, marked; another
					// machine's goes.
					if (this.#picturing()) this.#view?.updating();
					else this.#unpicture("updating");
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
				case "DESKTOP_MEMBER_IN_CONTROL":
					// Another member took it: the list says who.
					this.#listStale = true;
					this.#unpicture("controlled");
					this.#delay = LOOK_EVERY_MS;
					break;
			}
		}
	}

	/** What the list says of the member's own holds, each by its machine's own id, never by the machine shown (review r1
	 * F6), with the member's hand-back epoch per machine and the epoch each hold of theirs was taken under (review r5).
	 * The ledger hears it first: a lost answer whose epoch holds is held; a held lease the list no longer shows ended; an
	 * epoch moved on by another tab ends what the page had under the older one. The hold the window has ends when the list
	 * no longer shows it. One of theirs on the machine shown that the window does not know (the page was loaded again) is
	 * taken up at its epoch, unless this page gave that machine back. A list asked before the hold last changed says
	 * nothing of it. */
	#heldPerList(asked: number): void {
		const machines = this.#listed?.machines ?? [];
		if (this.#listed) this.#ledger.listed(this.#listed, asked);
		const mine = (machineId: string | undefined) =>
			machines.find((row) => row.machineId === machineId && row.control?.mine === true && row.state === "running");
		if (asked >= this.#holdChangedAt) {
			if (this.#holding && !mine(this.#holding)) this.#released();
			const shown = this.#pick();
			const held = shown ? mine(shown.machineId) : undefined;
			if (
				!this.#holding &&
				!this.#taking &&
				shown &&
				held &&
				this.#ledger.adopt(shown.machineId, this.agentId, held.control?.epoch ?? null)
			)
				this.#held(shown.machineId);
		}
		this.#syncControls();
	}

	/** The ledger changed: a hold it no longer lets this window keep (given back here, on the card, as the page goes, or
	 * ended) takes no more input and is never renewed; a hand-back of the machine shown that was confirmed reads the list
	 * again. */
	#holdsChanged(): void {
		if (this.#stop.signal.aborted) return;
		if (this.#holding && this.#ledger.holder(this.#holding) === undefined) this.#released();
		const release = this.#machineId ? this.#ledger.releasing(this.#machineId) : undefined;
		if (this.#releaseShown && !release) {
			this.#listStale = true;
			this.#poke();
		}
		this.#releaseShown = release;
		this.#syncControls();
	}

	/** Takes the machine chosen at the click over, once, through the company's ledger, at the member's hand-back epoch:
	 * its hold, or why not. Called off meanwhile (a hand-back, the window's close, a switch to another machine), what it
	 * got is covered by the hand-back at its epoch and never renewed (review r1 F5, r5); so is one of a machine no longer
	 * shown. A lost answer stays in the ledger as "may be held" until a hand-back covers it or the list says it holds. */
	async #take(machine: MemberAgentMachine | undefined): Promise<void> {
		const computer = this.#computer;
		if (!computer || this.#holding) return;
		// A viewer never takes over; a machine not running yet waits for the list to say it runs.
		if (this.#listed && !this.#listed.canTakeOver) this.#wantTakeOver = false;
		if (!machine || machine.state !== "running" || !this.#listed?.canTakeOver) return;
		this.#syncControls();
		const hold = await this.#ledger.take(machine.machineId, this.agentId);
		this.#wantTakeOver = false;
		if (this.#stop.signal.aborted) return;
		if (hold.state === "ok" && machine.machineId !== this.#pick()?.machineId)
			// The member chose another machine meanwhile: the hold goes back as it comes.
			this.#ledger.release(machine.machineId, this.agentId);
		else if (hold.state === "ok") {
			this.#controlNote.textContent = "";
			this.#held(machine.machineId);
			this.#quicken();
		} else if (hold.state === "uncertain" || (hold.state === "refused" && hold.reason === "TAKE_CALLED_OFF"))
			// Said under the picture; the member may try again (at the epoch the refusal said, when it was a stale one).
			this.#controlNote.textContent = t("The computer could not be taken over. Try again.");
		if (hold.state === "refused") this.#listStale = true;
		this.#syncControls();
		this.#poke();
	}

	/** The member holds the machine's desktop now: the picture takes their input, and the window renews the hold. */
	#held(machineId: string): void {
		this.#holding = machineId;
		this.#holdChangedAt = Date.now();
		this.#queue = [];
		this.#scheduleKeep(KEEP_EVERY_MS);
		this.#syncControls();
		this.#view?.focusScreen();
	}

	/** The member holds it no more (handed back, run out, or the window goes): input stops, and so does the renewal. */
	#released(): void {
		if (!this.#holding) return;
		this.#holding = undefined;
		this.#holdChangedAt = Date.now();
		this.#queue = [];
		clearTimeout(this.#keepTimer);
		this.#keepTimer = undefined;
		this.#controlNote.textContent = "";
		this.#syncControls();
	}

	/** The next renewal of the hold, after `ms`; it is asked only while a thread shows the window. */
	#scheduleKeep(ms: number): void {
		clearTimeout(this.#keepTimer);
		this.#keepTimer = setTimeout(() => void this.#keep(), ms);
	}

	async #keep(): Promise<void> {
		const machineId = this.#holding;
		const computer = this.#computer;
		if (!machineId || !computer || this.#stop.signal.aborted) return;
		// A hold the ledger no longer lets the window keep (a release was asked) is never renewed; the heartbeat names the
		// epoch it was taken under, and renews only a lease taken under it (review r5).
		const epoch = this.#ledger.holder(machineId);
		if (epoch === undefined) {
			this.#released();
			return;
		}
		if (!this.attached) {
			// Not shown: no renewal; the hold runs out in 5 minutes unless the window is shown again first.
			this.#keepTimer = undefined;
			return;
		}
		let until: string | null | undefined;
		try {
			until = await computer.keepDesktop(machineId, epoch, this.#stop.signal);
		} catch {
			until = undefined;
		}
		if (this.#stop.signal.aborted || this.#holding !== machineId || this.#ledger.holder(machineId) !== epoch) return;
		if (until === null) {
			// It ended (handed back elsewhere, run out after 30 minutes without input, or another member's now).
			this.#released();
			this.#ledger.ended(machineId, epoch);
			this.#listStale = true;
			this.#poke();
			return;
		}
		// Renewed, or not reached this time: again in a minute (the hold has 5), or sooner after a miss.
		this.#scheduleKeep(until === undefined ? KEEP_EVERY_MS / 4 : KEEP_EVERY_MS);
	}

	/** One of the member's actions, after those on their way; texts typed one after another go as one. */
	#enqueue(action: MachineDesktopAction): void {
		if (!this.#holding) return;
		const last = this.#queue.at(-1);
		if (
			last?.type === "type" &&
			action.type === "type" &&
			this.#queue.length > (this.#sending ? 1 : 0) &&
			[...last.text].length + [...action.text].length <= TEXT_MAX
		)
			this.#queue[this.#queue.length - 1] = { type: "type", text: last.text + action.text };
		else this.#queue.push(action);
		this.#touched();
		void this.#drain();
	}

	/** Sends the member's actions one at a time: an answer before the next goes. A desktop busy with another action
	 * (an agent's that began before the take-over) is waited for, then the action is dropped. */
	async #drain(): Promise<void> {
		const computer = this.#computer;
		if (this.#sending || !computer) return;
		this.#sending = true;
		try {
			let busySince: number | undefined;
			while (this.#queue.length && this.#holding && !this.#stop.signal.aborted) {
				const machineId = this.#holding;
				const epoch = this.#ledger.holder(machineId);
				const action = this.#queue[0] as MachineDesktopAction;
				let answer: MachineActAnswer | undefined;
				try {
					answer = await computer.screens.act(machineId, action, this.#stop.signal);
				} catch {
					answer = undefined;
				}
				if (this.#stop.signal.aborted || this.#holding !== machineId) return;
				if (answer?.kind === "refused" && answer.code === "DESKTOP_BUSY") {
					busySince ??= Date.now();
					if (Date.now() - busySince < BUSY_GIVE_UP_MS) {
						this.#controlNote.textContent = t("Waiting for {name} to finish a step…", { name: this.#name });
						await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
						continue;
					}
				}
				busySince = undefined;
				this.#controlNote.textContent = "";
				this.#queue.shift();
				if (
					answer?.kind === "refused" &&
					(answer.code === "DESKTOP_CONTROL_ENDED" || answer.code === "DESKTOP_MEMBER_IN_CONTROL")
				) {
					// The hold ended under the action (handed back elsewhere, or it ran out): the list says where it stands.
					this.#released();
					if (epoch !== undefined) this.#ledger.ended(machineId, epoch);
					this.#listStale = true;
				}
				// The screen changed (or may have): look again soon.
				this.#quicken();
			}
		} finally {
			this.#sending = false;
		}
	}

	/** The take-over controls under the picture: Take over for a member who may, while there is a picture; what holding
	 * means and Hand back while they hold it; nothing for a viewer. The picture takes input only while held. */
	#syncControls(): void {
		const picture = this.#view?.shown === true && this.#picturing();
		const holding = this.#holding !== undefined && this.#holding === this.#machineId;
		const release = this.#machineId ? this.#ledger.releasing(this.#machineId) : undefined;
		const offer = !holding && !release && picture && this.#listed?.canTakeOver === true;
		this.#controls.hidden = !(picture && (holding || release || offer));
		this.#controls.classList.toggle("is-holding", holding || release !== undefined);
		const text = holding
			? t("You are using the computer. {name} gets no pictures of the screen while you use it.", {
					name: this.#name,
				})
			: release === "failed"
				? t("The computer could not be given back yet. It goes back by itself within 5 minutes.")
				: release
					? t("Giving the computer back…")
					: "";
		if (this.#controlText.textContent !== text) this.#controlText.textContent = text;
		const label = holding
			? t("Hand back")
			: release === "failed"
				? t("Try again")
				: release
					? t("Hand back")
					: t("Take over");
		if (this.#controlButton.textContent !== label) this.#controlButton.textContent = label;
		this.#controlButton.disabled = this.#taking !== undefined || release === "asking";
		this.#view?.capture(holding && picture ? this.#input : null);
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
		if (this.#picturing()) this.#view?.updating();
		else this.#unpicture(this.#failures >= FAILURES_SHOWN ? "error" : "loading");
	}

	/** Whether the picture up is of the machine chosen now (after a switch it is the last one's until the next comes). */
	#picturing(): boolean {
		return this.#view?.shown === true && this.#pictureOf === this.#machineId;
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
	#unpicture(shown: Shown, member: string | null = null): void {
		this.#etag = null;
		this.#view?.clear();
		this.#show(shown, null, member);
		this.#syncControls();
	}

	#show(shown: Shown, waitingFor: "hours" | "room" | null = null, member: string | null = null): void {
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
														: shown === "controlled"
															? [
																	member
																		? t(
																				"{member} is using the computer. The screen is hidden meanwhile.",
																				{ member },
																			)
																		: t(
																				"Someone is using the computer. The screen is hidden meanwhile.",
																			),
																	null,
																	null,
																]
															: [t("Paused to save power. Still watching?"), null, t("Keep watching")];
		this.#loading.dataset.state = shown;
		// The state text shows only while there is no picture over it (a screen reader would read it under one).
		this.#loading.hidden = this.#view?.shown === true;
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

	/** Looks come every LOOK_EVERY_MS again, from now. */
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
				// Full screen, the browser shows only the full-screen element: the menu goes inside it (review r1 F3).
				const full = document.fullscreenElement;
				openContextMenu({
					label: t("Choose a computer"),
					x: rect.left,
					y: rect.bottom + 4,
					opener: button,
					...(full instanceof HTMLElement && full.contains(button) ? { container: full } : {}),
					items: desktops.map((machine) => ({
						label: machine.name,
						hint: machine.purpose.length > 60 ? `${machine.purpose.slice(0, 59)}…` : machine.purpose,
						checked: machine.machineId === this.#machineId,
						select: () => {
							const before = this.#pick()?.machineId;
							this.#chosen = machine.machineId;
							// At the choice, not when the loop next sees it (it may be waiting on a request): every machine of this
							// agent's in the ledger but this one goes back (review r4 F8). A take-over asked before is not carried
							// over to the machine chosen now.
							if (machine.machineId !== before) this.#wantTakeOver = false;
							this.#ledger.releaseOthers(this.agentId, machine.machineId);
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
 * member closes it or leaves the company; the threads that show it come and go. It keeps the company's one ledger of
 * the desktops the member may hold (DesktopHoldLedger), which outlives every panel (review r2 of #1661).
 */
export class ComputerPanels {
	readonly #panels = new Map<string, ComputerPanel>();
	readonly #computer: WebCompanyComputer | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #options: ComputerPanelOptions;
	readonly #holds: DesktopHoldLedger;
	readonly #onAbort = () => this.dispose();

	constructor(computer?: WebCompanyComputer, signal?: AbortSignal, options: ComputerPanelOptions = {}) {
		this.#computer = computer;
		this.#signal = signal;
		this.#holds = options.ledger ?? new DesktopHoldLedger(computer, signal);
		this.#options = { ...options, ledger: this.#holds };
		signal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	/** The take-over card's I'm done: every desktop of this agent's the member may hold, given back and confirmed, window
	 * or not (a closed window's hand-back is still the ledger's). True once nothing of the agent's is held; false while
	 * something is not confirmed (asked again meanwhile; the lease ends by itself in 5 minutes). */
	releaseAgent(agentId: string): Promise<boolean> {
		return this.#panels.get(agentId)?.handBack() ?? this.#holds.releaseAgent(agentId, "handed_back", true);
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

	/** The company is left (or its access is gone): every desktop the member may hold is asked back once, best effort,
	 * in requests the browser finishes after the page; then the panels end. */
	dispose(): void {
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.#holds.leave();
		for (const agentId of [...this.#panels.keys()]) this.close(agentId);
	}
}
