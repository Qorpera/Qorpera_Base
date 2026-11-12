import type {
	MemberAgentComputerRefusal,
	MemberAgentComputerStart,
	MemberAgentMachine,
	MemberAgentMachines,
} from "@qorpera/cloud-client/cloud-member-company-computer";
import type { WebCompanyComputer } from "../../cloud/computer.ts";
import type {
	MachineActAnswer,
	MachineDesktopAction,
	MachineScreenLook,
	MachineStartAnswer,
} from "../../cloud/machine-screens.ts";
import type { RealtimeResource } from "../../cloud/realtime.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import {
	type InputTime,
	inputTime,
	type MachineScreenInput,
	type MachineScreenPicture,
	MachineScreenView,
	TEXT_MAX,
} from "../../ui/machine-screen-view.ts";
import { leave, zoomFrom } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { DesktopHoldLedger, type DesktopRelease, type DesktopTake } from "./desktop-holds.ts";

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
/** Shared input that waited (a busy desktop's retry, or behind an action that took longer than BUSY_RETRY_MS) is sent
 * only after a list read begun after the wait answered (review r4 F1 of #1701): a private hold taken and given back
 * meanwhile shows there as a higher epoch even when no hint came. No such read within this, and the input is dropped. */
const FRESH_LIST_MS = 3000;
/** No input older than this is ever sent (review r3 of #1701): the window waits at most BUSY_GIVE_UP_MS (15 s) on a
 * desktop busy with another step, itself past the host's 11 s grace after an action that did not end cleanly, plus one
 * retry (1 s) and the few seconds a send takes. Anything older was kept by a path that should have dropped it: it is
 * dropped, never replayed, and the window says so. Its age is from the member's own event (the widget carries it
 * through its buffers, review r4 F2), by both clocks (inputTooOld). */
export const INPUT_MAX_AGE_MS = 20_000;

/** Whether an input made at `madeAt` may no longer be sent (review r4 F2 of #1701): too old by the wall clock, OR by the
 * monotonic clock, OR the wall clock went back since it was made. A suspended tab moves both clocks; a sleeping laptop
 * moves the wall clock while some browsers stop the monotonic one there; a clock set back would make an old input look
 * new by the wall clock alone. Either clock alone saying too old is enough, and a clock that went back is never trusted:
 * the input is dropped, never sent. */
export function inputTooOld(madeAt: InputTime, now: InputTime): boolean {
	return (
		now.wall < madeAt.wall ||
		now.mono < madeAt.mono ||
		now.wall - madeAt.wall > INPUT_MAX_AGE_MS ||
		now.mono - madeAt.mono > INPUT_MAX_AGE_MS
	);
}
/** How often the window reads its agent's machines again while it is shown (the `machines` hint reads them at once). */
export const MACHINES_EVERY_MS = 15_000;
/** How often a screen that is off, or hidden, is looked at again. */
export const SCREEN_OFF_EVERY_MS = 5000;
/** How long a member's wish that the desktop be on lasts (20260930714000): Turn it on, or Wake it, which turns the
 * screen on too once the machine runs. */
export const WANT_ON_MS = 3 * 60_000;
/** The least time between two starts of the desktop from one page: the database takes one per machine per 5 s. */
export const START_AGAIN_MS = 5500;
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
	| "controlled"
	// The member turns the screen on (20260930714000): on its way, refused as too small, or failed.
	| "turning"
	| "small"
	| "startFailed"
	// The member starts a computer for an agent that has none (20260930730000): on its way, or made none.
	| "making"
	| "noStart";

/** One hold of a desktop on the page (release review r1 of #1667, F25 of #1661): its machine, the hand-back epoch it was
 * taken under and its seat (every heartbeat and every action captured under it goes with both, and SQL runs it only
 * under this hold: F24, F26), the input captured under it, sent one at a time in order, and a signal that ends with it
 * (an action on its way is cut off on the page at once). A new hold is a new object; whatever an older one's requests
 * answer touches nothing of it. */
interface PageHold {
	readonly machineId: string;
	readonly epoch: number;
	readonly seat: number;
	readonly queue: QueuedAction[];
	readonly stop: AbortController;
	sending: boolean;
	/** Where the picture gives the input it gathers under this hold: to this hold alone, while it is the page's (review r2
	 * F1 of #1701: what the picture still gathers when the hold ends goes nowhere, never out shared). */
	readonly input: MachineScreenInput;
}

/** The member's input on the desktop they share with the agent (20260930734000): its machine, the input not answered yet,
 * sent one at a time in order with no hold (SQL runs it only while no one holds the desktop privately), and a signal
 * that ends with it. A new object per machine; gone when this page types privately, the machine shown changes, someone
 * types privately, or the window goes. */
interface SharedInput {
	readonly machineId: string;
	/** The member's hand-back epoch for the machine when this sharing began, the highest the window knew (the list's, the
	 * ledger's): a higher one seen later (a private hold of the member's taken and given back in any window, even one
	 * the window never saw held) ends the sharing and its queue (review r4 F1 of #1701). */
	readonly epoch: number;
	readonly queue: QueuedAction[];
	readonly stop: AbortController;
	sending: boolean;
	/** Where the picture gives the input it gathers while this computer is shared: to this computer alone, while this
	 * sharing lasts (review r2 F1 of #1701: what the picture still gathers when the member switches, leaves, starts
	 * typing privately or closes goes nowhere, never to another computer and never out as private). */
	readonly input: MachineScreenInput;
}

/** One input on its way, and when the member made it (INPUT_MAX_AGE_MS: from their event, through every buffer). */
interface QueuedAction {
	readonly action: MachineDesktopAction;
	readonly madeAt: InputTime;
}

/** Whether this browser was told once that a member and the agent share a computer (20260930734000). */
const SHARED_SEEN_KEY = "qorpera.web.computer-shared-seen";

function sharedSeen(): boolean {
	try {
		return localStorage.getItem(SHARED_SEEN_KEY) === "1";
	} catch {
		return false;
	}
}

function storeSharedSeen(): void {
	try {
		localStorage.setItem(SHARED_SEEN_KEY, "1");
	} catch {
		/* Told again in the next window. */
	}
}

/** Who else uses the shared desktop, in one quiet line: "Ada is using it too." */
function togetherWords(names: readonly string[]): string {
	if (names.length === 0) return "";
	if (names.length === 1) return t("{member} is using it too.", { member: names[0] as string });
	return t("{members} are using it too.", {
		members: t("{names} and {last}", { names: names.slice(0, -1).join(", "), last: names.at(-1) as string }),
	});
}

/** A press of Take over (the window's button or the agent's take-over card): the machine chosen at it, and the ledger's
 * answer it waits for (review r12 F19). */
interface TakeAttempt {
	readonly machineId: string | undefined;
	/** The press's stamp in the ledger (review r13 F20). */
	readonly pressedAt: number;
	answer?: Promise<DesktopTake>;
}

/**
 * An agent's computer window (migration 20260930712000; lanes/desktop-computers-20261110/LIVE-VIEW-PLAN.md, stage 1a):
 * the screen of the desktop computer the agent uses, as a picture that refreshes about once a second, with a switcher
 * in its corner when the agent has more than one. Every member who reads the company may watch; owners, admins and
 * contributors may wake a sleeping machine. It looks only while a thread shows it and its tab is visible, slows down
 * while nothing changes, and stops after 30 minutes without a touch on the page until the member says they still watch.
 *
 * Owners, admins and contributors share the desktop with the agent (migration 20260930734000; Jonas, 12 Nov 2026: "Yes,
 * shared control"): in the large view the picture takes their clicks, drags, wheel, keys and text at once, one action at
 * a time, while the agent goes on working on the same screen; a click on the preview's picture opens the large view.
 * More than one member may act; the window names the others who did in the last minute. Viewers watch.
 *
 * Typing privately is the take-over of migration 20260930713000 (stage 1b), for passwords: Type privately, here or the
 * agent's take-over card, holds the desktop for this member alone while the agent gets no pictures of it and waits, and
 * everyone else's shared input is refused; Done, the card's I'm done, closing the window or leaving the page ends it.
 * The hold is the database's, renewed every minute while the window shows it; other members see who types privately,
 * not the screen. While the picture changes or the member acts, the window looks every 450 ms. What the member may
 * hold, and every hand-back until it is confirmed, is the company's ledger's (DesktopHoldLedger), not the window's:
 * closing the window forgets nothing (review r2 of #1661). The picture takes the member's input only in the large view
 * (entered in the thread, or full screen; v234 in production: in the preview a press drags the window, and a desktop
 * cannot be driven at that size): a private hold of this page's enters the frame in the thread by itself once a picture
 * shows, and back in the preview the picture is watched only and the words say how to use it.
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
	/** While no picture shows (the controls under the picture are gone then; review r1 and r2 of #1681), the controls'
	 * words and button stand in the state's place for this page's own private hold and its end: what typing privately
	 * means and Done (beside Turn it on when the screen is off), "Ending private typing…" with Done disabled, or "could not
	 * be ended yet" with Try again. #syncControls gives both places the same words, label and state. */
	readonly #loadingControlText = h("p", { class: "computer-loading-control", "aria-live": "polite", hidden: true });
	readonly #loadingHandBack = h(
		"button",
		{ type: "button", class: "computer-retry computer-loading-hand-back", hidden: true },
		t("Done"),
	);
	readonly #loading = h(
		"div",
		{ class: "computer-loading" },
		this.#spinner,
		this.#status,
		this.#detail,
		this.#loadingControlText,
		this.#action,
		this.#loadingHandBack,
	);
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
	/** List reads begun so far, and the shared senders waiting for one begun after a moment (#freshList). */
	#listReads = 0;
	#listWaiters: { readonly after: number; readonly done: () => void }[] = [];
	#chosen: string | undefined;
	#machineId: string | undefined;
	#etag: string | null = null;
	/** The machine whose picture is up. */
	#pictureOf: string | undefined;
	/** The screen of the machine shown answered with a picture since it was chosen, and no look since was refused (off,
	 * asleep, restarted, hidden, held, typed on privately): shared input goes only while it stands (review r3 of #1701). */
	#screenSeen = false;
	#lastLook = Number.NEGATIVE_INFINITY;
	#delay = LOOK_EVERY_MS;
	#unchanged = 0;
	#failures = 0;
	#waking = false;
	/** The member's wish that the desktop be on (20260930714000): this page's, for one machine, until its picture shows,
	 * the member chooses another machine or closes the window, a refusal comes, or WANT_ON_MS pass. While it stands a
	 * screen that is off is turned on by itself (after Wake it too), without a second press. */
	#wantOn: { readonly machineId: string; readonly until: number } | undefined;
	/** A start of the desktop on its way, and when this page last asked for one. */
	#turningOn = false;
	#startedAt = Number.NEGATIVE_INFINITY;
	/** The last start that answered the desktop runs, and when: while it stands for the machine, no second start goes
	 * (review r1 F3 of #1681); a look begun after it that finds the screen off means the start failed, one begun before it
	 * tells nothing yet. */
	#startAnswered: { readonly machineId: string; readonly at: number } | undefined;
	/** A start that ended the wish (too small, or failed): what the window says of that machine's screen that is off
	 * until it shows a picture, sleeps, or the member presses again or chooses another machine. */
	#startEnded: { readonly machineId: string; readonly shown: "small" | "startFailed" } | undefined;
	/** Start one (20260930730000): a computer for the agent on its way, or why none was made (said until the member presses
	 * again or the agent has a computer with a screen). */
	#making = false;
	#startRefused: MemberAgentComputerRefusal | "failed" | undefined;
	// The member's attention: their last touch on the page, whether they still watch, and when they last said so.
	#lastTouch = Date.now();
	#paused = false;
	#confirm = true;
	#confirmedAt = Number.NEGATIVE_INFINITY;
	// The member's hold of the desktop (20260930713000): the machine this window holds (its input and its renewals),
	// whether a take-over waits for the list, the one on its way, the company's ledger of what the member may hold (review
	// r2; the window's hold follows it), the hand-back of the machine shown as the window last saw it, and the actions on
	// their way.
	#computer: WebCompanyComputer | undefined;
	/** The hold of the desktop on this page, while there is one (review r17 F25): a new object at every take-over that
	 * succeeds, gone at every release. */
	#hold: PageHold | undefined;
	/** A press of Take over waiting for the machine to run (its stamp in the ledger): dropped, silently, once any release
	 * came after it (review r13 F20). */
	#wantTakeOver: number | undefined;
	/** The window's last Hand back (or the card's I'm done through it) was not confirmed: said until one is (review r15). */
	#handBackFailed = false;
	/** A take-over of this page's (its button, the agent's take-over card) enters the large view once a picture shows: the
	 * picture takes input there only. Once: back in the preview it stays there until the member presses Enter. Only in a
	 * thread: leaving it cancels the entry, and a take-over answered out of one enters nothing (review r1 F1 of #1685);
	 * back in the thread the member has the preview, the hold and the words that say how to use it. */
	#enterOnHold = false;
	/** The window's take-over: the latest press's attempt, of the machine chosen at it, and the ledger's answer it waits
	 * for (review r12 F19). An older attempt's answer is not the window's. */
	#taking: TakeAttempt | undefined;
	readonly #ledger: DesktopHoldLedger;
	#releaseShown: DesktopRelease | undefined;
	#keepTimer: ReturnType<typeof setTimeout> | undefined;
	/** The member's sharing of the computer shown (20260930734000): its input on its way, and the picture's input for it
	 * (each hold has its own too, PageHold.input). A new one each time sharing begins; gone when it ends. The picture is
	 * given another input object at every change of computer or of mode, so it hands what it gathered (a text not sent
	 * yet, a click waiting for its second, a wheel turn, a press) to the input it gathered it for, which takes it only
	 * while that is still the window's (review r2 F1 of #1701). */
	#shared: SharedInput | undefined;
	/** The first time this browser shares a computer, the large view says so in one quiet line, until it goes back. */
	#introduce = !sharedSeen();
	#introShown = false;
	/** The note says an input was dropped on a desktop busy too long: said until the member's next input. */
	#lostShown = false;
	readonly #controlText = h("span", { class: "machine-screen-control-text" });
	/** Who else uses the shared desktop (20260930734000). */
	readonly #controlWho = h("span", { class: "machine-screen-control-who" });
	readonly #controlNote = h("span", { class: "machine-screen-control-note", role: "status", "aria-live": "polite" });
	readonly #controlButton = h("button", { type: "button", class: "machine-screen-control-button" });
	/** Done, beside Type privately, while the member types privately in another window (review r14). */
	readonly #controlHandBack = h(
		"button",
		{ type: "button", class: "machine-screen-control-hand-back", hidden: true },
		t("Done"),
	);
	readonly #controls = h(
		"div",
		{ class: "machine-screen-control", hidden: true },
		h("span", { class: "machine-screen-control-words" }, this.#controlText, this.#controlWho, this.#controlNote),
		this.#controlButton,
		this.#controlHandBack,
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
			onExpandedChange: (expanded) => {
				this.#setExpanded(expanded);
				// The line that says the computer is shared was said: once is enough (20260930734000).
				if (!expanded && this.#introShown) this.#introduce = false;
				// Input follows the view: the picture takes it only while entered.
				this.#syncControls();
				// Shared input typed in the large view goes no further once it is left (review r1 F1 of #1701).
				if (!expanded) this.#endShared();
			},
			...(options.decode ? { decode: options.decode } : {}),
		});
		this.#view.setSwitcher(this.#frameSwitcher);
		this.#view.setControls(this.#controls);
		// The controls are the member's, not the start of a panel drag.
		this.#controls.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
		// The controls' button and its stand-in without a picture do one thing: Done (a hand-back; or Try again) while the
		// member types privately or the end of it is asking or failed, else Type privately (a take-over).
		const press = () =>
			void (this.#holding || this.#handBackFailed || (this.#machineId && this.#ledger.releasing(this.#machineId))
				? this.handBack()
				: this.takeOver());
		this.#controlButton.addEventListener("click", press, { signal });
		this.#loadingHandBack.addEventListener("click", press, { signal });
		this.#controlHandBack.addEventListener("click", () => void this.handBack(), { signal });
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
		// A click on the preview's picture opens the large view, where the member uses the computer (20260930734000); a
		// press that moves drags the window, as before (computer-drag.ts, which sees the same press first).
		let tap: { readonly id: number; readonly x: number; readonly y: number } | undefined;
		this.el.addEventListener(
			"pointerdown",
			(event) => {
				const view = this.#view;
				tap =
					view?.shown &&
					!view.entered &&
					event.button === 0 &&
					event.target instanceof Element &&
					view.el.contains(event.target) &&
					!event.target.closest("button, a, input, textarea, select")
						? { id: event.pointerId, x: event.clientX, y: event.clientY }
						: undefined;
			},
			{ capture: true, signal },
		);
		this.el.addEventListener(
			"pointerup",
			(event) => {
				const at = tap;
				tap = undefined;
				if (!at || event.pointerId !== at.id || Math.hypot(event.clientX - at.x, event.clientY - at.y) >= 4) return;
				this.#view?.enterFrame();
			},
			{ capture: true, signal },
		);
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
		// A window that comes back entered covers this thread as entering does, whoever entered it (review r1 F1 of
		// #1685): the covered conversation is never left reachable under it.
		if (this.el.classList.contains("is-entered")) this.#setExpanded(true);
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
		// Shared input on its way goes no further: what comes next is private (review r1 F1 of #1701).
		this.#endShared();
		this.#wantTakeOver = this.#ledger.stamp();
		this.#handBackFailed = false;
		this.#touched();
		this.#poke();
		this.#startTake();
		// The picture hands what it gathered for sharing to that sharing, now gone (review r2 F1 of #1701).
		this.#syncControls();
	}

	/** Starts a take-over of the machine chosen now, at the click (review r4 F8), as its own attempt (review r12 F19): it
	 * is the window's until it settles or a newer press starts another. A press joins the attempt on its way only when it
	 * is of the same machine and no release called it off; otherwise it starts a new one (the ledger queues it behind a
	 * hand-back that must be answered first). The window's button and the agent's take-over card both come here. */
	#startTake(): void {
		const pressedAt = this.#wantTakeOver;
		if (this.#holding || pressedAt === undefined) return;
		const machine = this.#pick();
		// Nothing the window remembers from before a release takes the desktop over after it; only a new press does
		// (review r13 F20).
		if (this.#ledger.releasedSince(machine?.machineId, this.agentId, pressedAt)) {
			this.#wantTakeOver = undefined;
			this.#syncControls();
			return;
		}
		if (this.#takingLive(machine?.machineId)) return;
		const attempt: TakeAttempt = { machineId: machine?.machineId, pressedAt };
		this.#taking = attempt;
		void this.#take(machine, attempt).finally(() => {
			if (this.#taking === attempt) this.#taking = undefined;
			this.#syncControls();
		});
	}

	/** Whether the window's take-over of this machine is on its way and no release called it off or came after its press. */
	#takingLive(machineId: string | undefined): boolean {
		const attempt = this.#taking;
		if (!attempt || attempt.machineId !== machineId) return false;
		if (this.#ledger.releasedSince(machineId, this.agentId, attempt.pressedAt)) return false;
		return !attempt.answer || !this.#ledger.calledOff(attempt.answer);
	}

	/** Give back every desktop of this agent's the member may hold (the window's Hand back, the card's I'm done before it
	 * answers, a switch to another machine), through the company's ledger. A take-over still on its way is answered
	 * first, and a hold it gets is given back as it comes. True once the database confirmed it and a list read after
	 * that shows no hold of the member's; false while not: the window then says so, and the ledger asks again with
	 * growing waits, never renews the hold and never takes it up again from the list (review r1 F4, F5; r2). A hold never
	 * given back ends by itself in 5 minutes. */
	handBack(): Promise<boolean> {
		this.#wantTakeOver = undefined;
		this.#released();
		// A hold of the member's the window shows from elsewhere is owed from this click, at the epoch the list gave: its
		// hand-back goes at once, before the confirming list read (review r15 F23).
		// It names the seat the list gave (F26): the hold shown, whichever tab's.
		const shown = this.#pick();
		if (shown?.control?.mine === true && shown.control.epoch !== null && shown.control.seat !== null)
			this.#ledger.owe(shown.machineId, this.agentId, shown.control.epoch, shown.control.seat);
		this.#handBackFailed = false;
		const done = this.#ledger.releaseAgent(this.agentId, "handed_back", true);
		// Not confirmed though no hand-back is left on its way (the list read after them failed, or kept showing a hold):
		// said, with Try again, until a Hand back or a list read shows nothing of the member's held. A hand-back not
		// answered says so itself (the ledger asks it again), and nothing owed is ever dropped.
		void done.then((value) => {
			if (this.#stop.signal.aborted) return;
			this.#handBackFailed = !value && !(this.#machineId && this.#ledger.releasing(this.#machineId));
			this.#syncControls();
		});
		this.#syncControls();
		return done;
	}

	/** The machine of the window's hold, while it has one. */
	get #holding(): string | undefined {
		return this.#hold?.machineId;
	}

	/** Whether the member holds the desktop the window shows. */
	get holding(): boolean {
		return this.#holding !== undefined;
	}

	/** Leave the thread; the window stops looking until a thread shows it again. */
	detach(): void {
		this.#close = () => {};
		// A member who left mid-screen returns to a preview; the thread it covered is gone. An entry still pending is
		// cancelled: nothing enters out of a thread (review r1 F1 of #1685).
		this.#enterOnHold = false;
		this.#view?.back();
		this.el.remove();
		// Removal takes focus without a focusout in every browser; the next focus in the panel starts clean.
		this.el.classList.remove("is-pointer-focus");
		// Lets the thread that was left be collected: nothing of it is watched any more.
		this.#fitPreview();
		// It slid in once; coming back to a thread it is simply there, as after a drag.
		this.el.style.animation = "none";
		// Out of a thread nothing is shared (review r3 of #1701).
		this.#syncControls();
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
		this.#wantTakeOver = undefined;
		this.#released();
		this.#endShared();
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
				// The picture goes, and with it any sharing (review r3 of #1701).
				this.#unpicture("paused");
				await this.#wait(Number.POSITIVE_INFINITY, signal);
				continue;
			}
			const listDue = this.#listedAt + MACHINES_EVERY_MS;
			if (this.#listStale || Date.now() >= listDue) {
				// A hint that comes while this read is on its way asks for another after it.
				this.#listStale = false;
				const read = ++this.#listReads;
				try {
					this.#listed = await computer.agentMachines(this.agentId, signal);
					this.#listedAt = Date.now();
					this.#failures = 0;
					this.#heldPerList();
					// Senders waiting for a read begun after they asked: this is one (it has been applied above).
					const waiting = this.#listWaiters;
					this.#listWaiters = waiting.filter((waiter) => waiter.after >= read);
					for (const waiter of waiting) if (waiter.after < read) waiter.done();
				} catch {
					signal.throwIfAborted();
					this.#listStale = true;
					this.#failed();
					await this.#wait(this.#backoff(), signal);
					continue;
				}
			}
			const machine = this.#pick();
			// The agent has a computer with a screen now: why none was made is told no more.
			if (machine) this.#startRefused = undefined;
			if (machine?.machineId !== this.#machineId) {
				// The wish that a desktop be on is for the machine it was made for alone (20260930714000).
				if (this.#wantOn && this.#wantOn.machineId !== machine?.machineId) this.#wantOn = undefined;
				this.#startEnded = undefined;
				// The window's machine changed: every machine of this agent's the ledger has but the one shown now goes back,
				// held, may be held (a lost answer), on its way or queued; the window's own state does not decide it (review r1
				// F6, r3 F8, r4 F8).
				this.#ledger.releaseOthers(this.agentId, machine?.machineId);
				// Shared input of the last machine's goes no further (20260930734000); the next machine's screen is not seen yet.
				this.#screenSeen = false;
				this.#endShared();
				this.#controlNote.textContent = "";
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
				// A machine that sleeps may wake larger: what a start said of it is gone.
				this.#startEnded = undefined;
				this.#screenSeen = false;
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
				// Their private typing: no shared input either until it ends (20260930734000).
				this.#endShared();
				this.#unpicture("controlled", machine.control.name);
				const until = Date.parse(machine.control.until);
				const end = Number.isFinite(until) ? until + 500 : Number.POSITIVE_INFINITY;
				await this.#wait(Math.min(this.#listedAt + MACHINES_EVERY_MS, end) - Date.now(), signal);
				if (Date.now() >= end) this.#listStale = true;
				continue;
			}
			if (this.#wantTakeOver !== undefined && !this.#holding) this.#startTake();
			const due = this.#lastLook + this.#delay;
			if (Date.now() < due) {
				await this.#wait(Math.min(due, this.#listedAt + MACHINES_EVERY_MS) - Date.now(), signal);
				continue;
			}
			const begun = Date.now();
			this.#lastLook = begun;
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
			// The answer is the machine's the window shows now, or nothing (a switch made while the look was on its way:
			// release review r1 of #1667, the requests' audit).
			if (machine.machineId !== this.#machineId || this.#pick()?.machineId !== machine.machineId) continue;
			if (look.kind === "picture") {
				if (await this.#view?.show(look.png)) {
					this.#etag = look.etag;
					this.#pictureOf = machine.machineId;
					this.#screenSeen = true;
					this.#unchanged = 0;
					// The desktop is on: the member's wish is met.
					if (this.#wantOn?.machineId === machine.machineId) this.#wantOn = undefined;
					if (this.#startEnded?.machineId === machine.machineId) this.#startEnded = undefined;
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
				// The picture up is the screen as it is (the etag is its picture's): after a refusal that kept it, shared input
				// may go again.
				if (!this.#screenSeen && this.#picturing()) {
					this.#screenSeen = true;
					this.#syncControls();
				}
				this.#delay = LOOK_UNCHANGED_MS.find(([after]) => this.#unchanged >= after)?.[1] ?? LOOK_EVERY_MS;
				continue;
			}
			// Every refusal but a look too soon says the screen is not as the member saw it: no shared input until a look shows
			// it again (review r3 of #1701).
			if (look.code !== "SCREEN_TOO_SOON" && this.#screenSeen) {
				this.#screenSeen = false;
				this.#syncControls();
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
					// The member wants it on (Turn it on, or Wake it a moment ago): it is turned on, without a second press;
					// a start on its way, or one a moment ago, is waited for.
					if (this.#wishFor(machine.machineId)) {
						// A start answered that the desktop runs: a look begun after it that finds the screen off means it
						// failed; one begun before it tells nothing yet, and no second start goes (review r1 F3 of #1681).
						if (this.#startAnswered?.machineId === machine.machineId) {
							if (begun >= this.#startAnswered.at) {
								this.#endStart(machine.machineId, "startFailed");
								this.#delay = SCREEN_OFF_EVERY_MS;
							} else {
								this.#unpicture("turning");
								this.#delay = BUSY_RETRY_MS;
							}
							break;
						}
						if (!this.#turningOn && Date.now() >= this.#startedAt + START_AGAIN_MS)
							void this.#turnOn(computer, machine.machineId, signal);
						else this.#unpicture("turning");
						this.#delay = BUSY_RETRY_MS;
						break;
					}
					// A start that ended the wish is said until the member presses again.
					this.#unpicture(this.#startEnded?.machineId === machine.machineId ? this.#startEnded.shown : "off");
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
					// Another member types privately: the list says who.
					this.#listStale = true;
					this.#endShared();
					this.#unpicture("controlled");
					this.#delay = LOOK_EVERY_MS;
					break;
			}
		}
	}

	/** What the list says of the member's own holds, each by its machine's own id, never by the machine shown (review r1
	 * F6), ordered by the member's hand-back epoch per machine, never by the page's clock (review r8): the ledger hears it
	 * and decides (a list below the epoch it knows says nothing; an epoch above ends what the page had under the older
	 * one; a lost answer of this page's take-over that the list shows is held), and the window's hold follows the
	 * ledger. A hold of the member's from elsewhere (another window, or this page before it was loaded again) is never
	 * taken up (review r14): the window shows it, with Take over and Hand back. */
	#heldPerList(): void {
		const list = this.#listed;
		if (!list) return;
		this.#ledger.listed(list, this.agentId);
		// A read that shows nothing of the member's held, with nothing owed, confirms an unconfirmed Hand back.
		if (
			this.#handBackFailed &&
			!list.machines.some((machine) => machine.control?.mine === true) &&
			!this.#ledger.has(this.agentId)
		)
			this.#handBackFailed = false;
		// A take-over of this page's whose answer was lost, which the list now shows held (the ledger's own word): the
		// press was this page's, so the window uses it.
		const shown = this.#pick();
		if (shown && !this.#holding && this.#ledger.holder(shown.machineId) !== undefined) {
			this.#controlNote.textContent = "";
			this.#held(shown.machineId);
		}
		this.#syncControls();
	}

	/** The ledger changed: a hold it no longer lets this window keep (given back here, on the card, as the page goes, or
	 * ended) takes no more input and is never renewed; a hand-back of the machine shown that was confirmed reads the list
	 * again. */
	#holdsChanged(): void {
		if (this.#stop.signal.aborted) return;
		if (this.#hold && !this.#current(this.#hold)) this.#released();
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
	async #take(machine: MemberAgentMachine | undefined, attempt: TakeAttempt): Promise<void> {
		const computer = this.#computer;
		if (!computer || this.#holding) return;
		// A viewer never takes over; a machine not running yet waits for the list to say it runs.
		if (this.#listed && !this.#listed.canTakeOver) this.#wantTakeOver = undefined;
		if (!machine || machine.state !== "running" || !this.#listed?.canTakeOver) return;
		attempt.answer = this.#ledger.take(machine.machineId, this.agentId, attempt.pressedAt);
		this.#syncControls();
		const hold = await attempt.answer;
		if (this.#stop.signal.aborted) return;
		if (this.#taking !== attempt) {
			// An older attempt (a newer press started another, review r12 F19): nothing of the window's is its own, neither
			// the wish to take over, nor the newer attempt, nor the note. What it got, should it get anything, goes back
			// unless a newer attempt of that machine is on its way.
			if (
				hold.state === "ok" &&
				this.#holding !== machine.machineId &&
				this.#taking?.machineId !== machine.machineId
			)
				this.#ledger.release(machine.machineId, this.agentId);
			return;
		}
		this.#wantTakeOver = undefined;
		if (hold.state === "ok" && machine.machineId !== this.#pick()?.machineId)
			// The member chose another machine meanwhile: the hold goes back as it comes.
			this.#ledger.release(machine.machineId, this.agentId);
		else if (hold.state === "ok") {
			this.#controlNote.textContent = "";
			this.#held(machine.machineId);
			this.#quicken();
		} else if (
			hold.state === "uncertain" ||
			// Not sent: the machine's earlier hand-back is still not answered (review r13, found by the window explorer).
			hold.state === "releasing" ||
			(hold.state === "refused" && hold.reason === "TAKE_CALLED_OFF")
		)
			// Said under the picture; the member may try again (at the epoch the refusal said, when it was a stale one).
			this.#controlNote.textContent = t("Private typing could not start. Try again.");
		if (hold.state === "refused") this.#listStale = true;
		this.#syncControls();
		this.#poke();
	}

	/** The member holds the machine's desktop now: the picture takes their input, and the window renews the hold. A new
	 * hold of the page's, at the epoch the ledger holds it under (F25). */
	#held(machineId: string): void {
		const held = this.#ledger.holder(machineId);
		if (held === undefined) return;
		this.#hold?.stop.abort();
		// Typing privately: no shared input of this page's goes after it (SQL would refuse it anyway).
		this.#endShared();
		const hold: PageHold = {
			machineId,
			epoch: held.epoch,
			seat: held.seat,
			queue: [],
			stop: new AbortController(),
			sending: false,
			input: { act: (action, madeAt) => this.#enqueue(hold, action, madeAt) },
		};
		this.#hold = hold;
		this.#scheduleKeep(KEEP_EVERY_MS);
		// Out of a thread (a take-over answered after the member left it) nothing is entered (review r1 F1 of #1685).
		this.#enterOnHold = this.el.parentElement !== null;
		this.#syncControls();
		this.#view?.focusScreen();
	}

	/** The member holds it no more (handed back, run out, or the window goes): input stops, and so does the renewal. */
	#released(): void {
		const hold = this.#hold;
		if (!hold) return;
		// Its input is dropped and an action of it on its way is cut off on the page; nothing it answers is acted on (F25).
		hold.stop.abort();
		hold.queue.length = 0;
		this.#hold = undefined;
		this.#enterOnHold = false;
		clearTimeout(this.#keepTimer);
		this.#keepTimer = undefined;
		this.#controlNote.textContent = "";
		this.#lostShown = false;
		this.#syncControls();
	}

	/** Whether the ledger still lets the window use this hold: the same epoch and the same seat (F26). */
	#current(hold: PageHold): boolean {
		const held = this.#ledger.holder(hold.machineId);
		return held !== undefined && held.epoch === hold.epoch && held.seat === hold.seat;
	}

	/** The next renewal of the hold, after `ms`; it is asked only while a thread shows the window. */
	#scheduleKeep(ms: number): void {
		clearTimeout(this.#keepTimer);
		this.#keepTimer = setTimeout(() => void this.#keep(), ms);
	}

	async #keep(): Promise<void> {
		const hold = this.#hold;
		const computer = this.#computer;
		if (!hold || !computer || this.#stop.signal.aborted) return;
		const { machineId, epoch, seat } = hold;
		// A hold the ledger no longer lets the window keep (a release was asked) is never renewed; the heartbeat names the
		// epoch it was taken under and its seat, and renews only that lease (review r5, F26): never another tab's.
		if (!this.#current(hold)) {
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
			until = await computer.keepDesktop(machineId, epoch, seat, hold.stop.signal);
		} catch {
			until = undefined;
		}
		// The answer of an older hold's heartbeat touches nothing (F25).
		if (this.#stop.signal.aborted || this.#hold !== hold || !this.#current(hold)) return;
		if (until === null) {
			// It ended (handed back elsewhere, run out after 30 minutes without input, another tab of the member's took it
			// over, or another member's now): the list shows where it stands.
			this.#released();
			this.#ledger.ended(machineId, epoch, seat);
			this.#listStale = true;
			this.#poke();
			return;
		}
		// Renewed, or not reached this time: again in a minute (the hold has 5), or sooner after a miss.
		this.#scheduleKeep(until === undefined ? KEEP_EVERY_MS / 4 : KEEP_EVERY_MS);
	}

	/** One of the member's actions, captured under `hold`, after those of it on their way: only while that hold is the
	 * window's, of the computer chosen now (review r2 F1 of #1701). */
	#enqueue(hold: PageHold, action: MachineDesktopAction, madeAt: InputTime): void {
		if (
			this.#hold !== hold ||
			hold.stop.signal.aborted ||
			!this.#current(hold) ||
			this.#pick()?.machineId !== hold.machineId
		)
			return;
		this.#queue(hold, action, madeAt);
		void this.#drain(hold);
	}

	/** One of the member's actions on the desktop they share with the agent (20260930734000), after those on their way:
	 * only while that sharing is the window's, of the computer chosen now (the input of a computer or a mode gone is
	 * dropped, never sent to another or in another: review r2 F1 of #1701). */
	#share(shared: SharedInput, action: MachineDesktopAction, madeAt: InputTime): void {
		if (this.#shared !== shared || shared.stop.signal.aborted || !this.#sharingOf(shared)) {
			// The predicate is false: the sharing and its queue go now, never to be used again (review r3 of #1701).
			if (this.#shared === shared) this.#endShared(true);
			return;
		}
		this.#queue(shared, action, madeAt);
		void this.#drain(shared);
	}

	/** The sharing of `machineId`, begun now unless it is on (its picture input is new then). */
	#sharedFor(machineId: string): SharedInput {
		if (this.#shared?.machineId === machineId && !this.#shared.stop.signal.aborted && this.#sharingOf(this.#shared))
			return this.#shared;
		this.#endShared();
		const shared: SharedInput = {
			machineId,
			epoch: this.#epochOf(machineId),
			queue: [],
			stop: new AbortController(),
			sending: false,
			input: { act: (action, madeAt) => this.#share(shared, action, madeAt) },
		};
		this.#shared = shared;
		return shared;
	}

	/** The action joins its queue; texts typed one after another, not sent yet, go as one. A new input ends the word that
	 * an earlier one did not go through. */
	#queue(sender: PageHold | SharedInput, action: MachineDesktopAction, madeAt: InputTime): void {
		const last = sender.queue.at(-1);
		if (
			last?.action.type === "type" &&
			action.type === "type" &&
			sender.queue.length > (sender.sending ? 1 : 0) &&
			[...last.action.text].length + [...action.text].length <= TEXT_MAX
		)
			// The joined text is as old as its oldest part, by each clock.
			sender.queue[sender.queue.length - 1] = {
				action: { type: "type", text: last.action.text + action.text },
				madeAt: {
					wall: Math.min(last.madeAt.wall, madeAt.wall),
					mono: Math.min(last.madeAt.mono, madeAt.mono),
				},
			};
		else sender.queue.push({ action, madeAt });
		if (this.#lostShown) {
			this.#lostShown = false;
			this.#controlNote.textContent = "";
		}
		this.#touched();
	}

	/** The shared input ends: its queue is emptied, an action of it on its way is cut off on the page, and it is never
	 * used again (a new sharing is made when the predicate holds again: review r3 of #1701). Ended because the predicate
	 * turned false (`lost`), input that was waiting is said lost; the member's own switch or press says nothing. */
	#endShared(lost = false): void {
		const shared = this.#shared;
		this.#shared = undefined;
		if (!shared) return;
		if (lost && shared.queue.length > 0) {
			this.#lostShown = true;
			this.#controlNote.textContent = t("Your last input did not go through. Try again.");
		}
		shared.stop.abort();
		shared.queue.length = 0;
	}

	/** THE predicate of shared input (20260930734000, review r3 of #1701), in this one place: the shared sender exists,
	 * and anything of it is sent, only while ALL of these hold: this window open, in a thread, in the large view; the
	 * member may act (not a viewer); the computer chosen now is in the agent's list, is the one the window shows, runs,
	 * and its screen answered with a picture since it was chosen (no look refused since: off, asleep, restarted, hidden,
	 * held); and NO private hold is known of it: none in the list (another member's, or the member's own in another
	 * window), none of this page's (held, on its way, being given back, or a give-back not confirmed), none in the
	 * company's ledger. Whatever makes it false (a list read, a look's answer, an action's refusal, the member's own
	 * press) ends the sharing and its queue at once (#syncControls, #share, #drain), and a sharing is never used again
	 * once it was false. */
	#sharing(): boolean {
		const shown = this.#pick();
		return (
			!this.#stop.signal.aborted &&
			this.attached &&
			this.#view?.entered === true &&
			this.#listed?.canTakeOver === true &&
			shown !== undefined &&
			shown.machineId === this.#machineId &&
			shown.state === "running" &&
			shown.desktopCapable &&
			this.#picturing() &&
			this.#screenSeen &&
			!shown.control &&
			this.#hold === undefined &&
			!this.#ledger.mayHold(shown.machineId) &&
			!this.#takingLive(shown.machineId) &&
			this.#wantTakeOver === undefined &&
			!this.#handBackFailed
		);
	}

	/** Waits for a list read begun after now to answer and be applied: true then; false when none answered within
	 * FRESH_LIST_MS or `stop` ended first. */
	#freshList(stop: AbortSignal): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const end = (fresh: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				stop.removeEventListener("abort", aborted);
				this.#listWaiters = this.#listWaiters.filter((waiter) => waiter !== entry);
				resolve(fresh);
			};
			const aborted = () => end(false);
			const timer = setTimeout(() => end(false), FRESH_LIST_MS);
			const entry = { after: this.#listReads, done: () => end(true) };
			if (stop.aborted) {
				end(false);
				return;
			}
			stop.addEventListener("abort", aborted, { once: true });
			this.#listWaiters.push(entry);
			this.#listStale = true;
			this.#poke();
		});
	}

	/** The predicate, for this sharing: it is the window's, of the computer it was made for, and no hand-back of the
	 * member's came since it began (an epoch above its own, from the list or the ledger: review r4 F1 of #1701). */
	#sharingOf(shared: SharedInput): boolean {
		return (
			this.#shared === shared &&
			this.#pick()?.machineId === shared.machineId &&
			this.#epochOf(shared.machineId) <= shared.epoch &&
			this.#sharing()
		);
	}

	/** The member's hand-back epoch for a machine, the highest the window knows: the list's (as last read) or the
	 * ledger's (a hand-back's answer, TAKE_CALLED_OFF, a list). It only moves up. Looks and actions answer no epoch. */
	#epochOf(machineId: string): number {
		const listed = this.#listed?.machines.find((machine) => machine.machineId === machineId)?.epoch ?? 0;
		return Math.max(listed, this.#ledger.epochOf(machineId) ?? 0);
	}

	/** Sends a hold's actions, or the shared ones, one at a time: an answer before the next goes. A private hold's go with
	 * its epoch and seat; shared ones with none. A desktop busy with another action (the agent's, another member's), or
	 * one member's actions too fast, is waited for; after BUSY_GIVE_UP_MS the input is dropped and the window says so.
	 * Every other refusal, and an answer that never came, drops the whole queue at once, never tried again (review r3 of
	 * #1701): what follows was made for a screen that is not there now. No input older than INPUT_MAX_AGE_MS is sent.
	 * The loop is its sender's (F25): before every send and after every wait it checks the sender is still the window's
	 * (for shared input: the predicate, #sharingOf), and when it is not, a shared sender is ended with its queue; a newer
	 * one has its own queue and its own loop, which starts at once. */
	async #drain(sender: PageHold | SharedInput): Promise<void> {
		const computer = this.#computer;
		if (sender.sending || !computer) return;
		sender.sending = true;
		const hold = "seat" in sender ? sender : undefined;
		const shared = hold ? undefined : (sender as SharedInput);
		const current = () =>
			(hold
				? this.#hold === hold && this.#pick()?.machineId === hold.machineId
				: this.#sharingOf(sender as SharedInput)) &&
			!sender.stop.signal.aborted &&
			!this.#stop.signal.aborted;
		/** The whole queue goes; the window says so when it was not the screen's own state that ended it. */
		const drop = (said: string | null) => {
			sender.queue.length = 0;
			if (said !== null) {
				this.#lostShown = true;
				this.#controlNote.textContent = said;
			}
			if (shared && this.#shared === shared) this.#endShared();
			this.#syncControls();
		};
		try {
			let busySince: number | undefined;
			/** The input a fresh list read was waited for, for its next send alone. */
			let observed: QueuedAction | undefined;
			while (sender.queue.length) {
				if (!current()) {
					// The predicate went false: a shared sender and its queue end now, never to be used again.
					if (shared && this.#shared === shared) this.#endShared(true);
					else sender.queue.length = 0;
					return;
				}
				const item = sender.queue[0] as QueuedAction;
				const now = inputTime();
				if (inputTooOld(item.madeAt, now)) {
					drop(t("Your last input did not go through. Try again."));
					return;
				}
				// Shared input that waited is sent only once a list read begun after the wait answered: what happened
				// meanwhile (a private hold taken and given back, in any window of the member's) is seen first (review r4 F1).
				const waited =
					busySince !== undefined ||
					now.wall - item.madeAt.wall > BUSY_RETRY_MS ||
					now.mono - item.madeAt.mono > BUSY_RETRY_MS;
				if (shared && waited && observed !== item) {
					const fresh = await this.#freshList(sender.stop.signal);
					if (!current()) continue;
					if (!fresh) {
						drop(t("Your last input did not go through. Try again."));
						return;
					}
					observed = item;
					continue;
				}
				observed = undefined;
				let answer: MachineActAnswer | undefined;
				try {
					answer = await computer.screens.act(
						sender.machineId,
						item.action,
						hold ? { epoch: hold.epoch, seat: hold.seat } : null,
						sender.stop.signal,
					);
				} catch {
					answer = undefined;
				}
				if (!current()) continue;
				if (answer?.kind === "done") {
					busySince = undefined;
					sender.queue.shift();
					if (!this.#lostShown) this.#controlNote.textContent = "";
					this.#syncControls();
					// The screen changed (or may have): look again soon.
					this.#quicken();
					continue;
				}
				const busy =
					answer?.kind === "refused" &&
					(answer.code === "DESKTOP_BUSY" || answer.code === "DESKTOP_ACTIONS_TOO_FAST");
				if (busy) {
					busySince ??= Date.now();
					if (Date.now() - busySince < BUSY_GIVE_UP_MS) {
						this.#controlNote.textContent = t("Waiting for {name} to finish a step…", { name: this.#name });
						this.#syncControls();
						await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
						continue;
					}
					// Busy all that time: this input and what came after it are dropped, and the window says so (20260930734000:
					// nothing is lost without a word).
					drop(t("The computer was busy, so your last input did not go through. Try again."));
					return;
				}
				// Any other refusal, or no answer: the queue goes, never tried again (review r3 of #1701).
				const code = answer?.kind === "refused" ? answer.code : undefined;
				if (code === "DESKTOP_CONTROL_ENDED" || code === "DESKTOP_MEMBER_IN_CONTROL") {
					// The hold ended under the action (handed back elsewhere, it ran out, or another tab took it over), or
					// someone types privately now: the list says where it stands, and nothing is shared before a look shows the
					// screen again.
					this.#listStale = true;
					if (code === "DESKTOP_MEMBER_IN_CONTROL") this.#screenSeen = false;
					drop(null);
					if (hold) {
						this.#released();
						this.#ledger.ended(hold.machineId, hold.epoch, hold.seat);
					}
				} else if (
					code === "MACHINE_NOT_RUNNING" ||
					code === "MACHINE_BOOT_CHANGED" ||
					code === "DESKTOP_NOT_RUNNING" ||
					code === "MACHINE_IMAGE_WITHOUT_SCREEN" ||
					code === "MACHINE_NEEDS_COMPANY_VIEW" ||
					code === "DESKTOP_MACHINE_TOO_SMALL" ||
					code === "DESKTOP_DID_NOT_START"
				) {
					// The screen is not as the member saw it: no sharing until a look shows it again.
					this.#screenSeen = false;
					this.#listStale = true;
					drop(null);
				} else drop(t("Your last input did not go through. Try again."));
				this.#quicken();
				return;
			}
		} finally {
			sender.sending = false;
		}
	}

	/** The controls under the picture (20260930734000). Shared, in the large view: the computer takes the member's input at
	 * once, the first time a quiet line says that they share it with the agent, and Type privately (a lock) starts the
	 * private mode; in the preview nothing but who else uses it (a click on the picture opens the large view). Typing
	 * privately: what it means and Done, in both. A viewer is told they watch. Who else used the shared desktop in the
	 * last minute is said in every case. The picture takes input only in the large view; a private hold of this page's
	 * enters the frame in the thread once a picture shows. Without a picture, the same words, label and state stand in
	 * the state's place for a private hold or its end (review r2 F1 of #1681). */
	#syncControls(): void {
		// The predicate is checked at every change the window draws: once false, the sharing and its queue are gone, and a
		// new one is made only when it holds again (review r3 of #1701). Input that was waiting is said lost.
		if (this.#shared && !this.#sharingOf(this.#shared)) this.#endShared(true);
		const picture = this.#view?.shown === true && this.#picturing();
		const holding = this.#holding !== undefined && this.#holding === this.#machineId;
		// Never full screen here: only the member's own press on Enter asks for that.
		const entering = this.#enterOnHold && holding && picture && this.el.parentElement !== null;
		if (entering) {
			this.#enterOnHold = false;
			this.#view?.enterFrame();
		}
		const entered = this.#view?.entered === true;
		const release =
			(this.#machineId ? this.#ledger.releasing(this.#machineId) : undefined) ??
			(this.#handBackFailed ? "failed" : undefined);
		const shown = this.#pick();
		const mayAct = this.#listed?.canTakeOver === true;
		// The member types privately from elsewhere (another window, or this page before it was loaded again): shown,
		// never used here; Type privately makes it this window's, Done ends it (review r14).
		const elsewhere = !holding && !release && picture && mayAct && shown?.control?.mine === true;
		// No one types privately: the member shares the computer with the agent, and may start typing privately.
		const open = !holding && !release && !elsewhere && picture && mayAct && !shown?.control;
		const sharing = open && this.#sharing();
		const who = picture && !holding && !release ? togetherWords(shown?.others ?? []) : "";
		let text = "";
		if (holding)
			text =
				picture && !entered
					? t("Typing privately. Choose Enter to click and type.")
					: t("Typing privately. {name} gets no pictures of the screen until you're done.", { name: this.#name });
		else if (release === "failed")
			text = t("Private typing could not be ended yet. It ends by itself within 5 minutes.");
		else if (release) text = t("Ending private typing…");
		else if (elsewhere) text = t("You are typing privately in another window.");
		else if (open && entered && this.#introduce) {
			text = t("You and {name} share this computer: you can both click and type.", { name: this.#name });
			if (!this.#introShown) storeSharedSeen();
			this.#introShown = true;
		} else if (picture && entered && !mayAct)
			text = t("You can watch. Someone with edit access can use the computer.");
		// The button: Done while typing privately (Try again for an end that failed), Type privately where the member may
		// start it (the large view) or holds it elsewhere.
		const button = holding || release !== undefined || elsewhere || (open && entered);
		// A note (private typing could not start, an input did not go through) shows in the preview too.
		const note = this.#controlNote.textContent !== "";
		this.#controls.hidden = !(picture && (button || text !== "" || who !== "" || note));
		// Without a picture the controls are gone: this page's own private hold and its end keep their words and button in
		// the state's place (review r2 F1 of #1681: an end that is asking or failed says so there too).
		const standIn = !picture && (holding || release !== undefined);
		this.#loadingControlText.hidden = !standIn;
		this.#loadingHandBack.hidden = !standIn;
		this.#controls.classList.toggle("is-holding", text !== "" || who !== "");
		this.#controls.classList.toggle("is-elsewhere", elsewhere);
		this.#controls.classList.toggle("is-private", holding);
		this.#controlHandBack.hidden = !elsewhere;
		for (const words of [this.#controlText, this.#loadingControlText])
			if (words.textContent !== text) words.textContent = text;
		if (this.#controlWho.textContent !== who) this.#controlWho.textContent = who;
		const lock = !holding && release === undefined;
		const label = holding
			? t("Done")
			: release === "failed"
				? t("Try again")
				: release
					? t("Done")
					: t("Type privately");
		const disabled = this.#takingLive(this.#machineId) || release === "asking";
		this.#controlButton.hidden = !button;
		this.#controlButton.classList.toggle("is-secondary", open);
		this.#label(this.#controlButton, label, lock);
		this.#label(this.#loadingHandBack, label, false);
		const tip = lock
			? t("For passwords: {name} gets no pictures of the screen until you're done.", { name: this.#name })
			: "";
		if (this.#controlButton.title !== tip) this.#controlButton.title = tip;
		for (const each of [this.#controlButton, this.#loadingHandBack]) each.disabled = disabled;
		// Each hold and each sharing has an input of its own: at every change the picture hands what it gathered to the input
		// it gathered it for (review r2 F1 of #1701).
		const hold = holding ? this.#hold : undefined;
		this.#view?.capture(
			picture && entered
				? hold
					? hold.input
					: sharing && this.#machineId
						? this.#sharedFor(this.#machineId).input
						: null
				: null,
		);
		if (entering) this.#view?.focusScreen();
	}

	/** A control's label, with the lock of private typing before it where it starts it; drawn again only when it changes. */
	#label(button: HTMLButtonElement, label: string, lock: boolean): void {
		const key = `${lock ? "lock:" : ""}${label}`;
		if (button.dataset.label === key) return;
		button.dataset.label = key;
		if (lock) replace(button, icon("lock"), h("span", null, label));
		else button.textContent = label;
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
			this.#show(
				this.#making
					? "making"
					: this.#startRefused
						? "noStart"
						: this.#listed.machines.length
							? "headless"
							: "none",
			);
			return;
		}
		// Wake it was pressed: the machine is on its way up, and its screen comes on with it.
		if ((machine.state === "stopped" || machine.state === "stopping") && !this.#wishFor(machine.machineId))
			this.#show("asleep");
		else this.#show("starting", machine.waitingFor);
	}

	/** The picture goes, and the window says why. */
	#unpicture(shown: Shown, member: string | null = null): void {
		this.#etag = null;
		this.#screenSeen = false;
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
						? this.#listed?.canWake
							? [t("{name} has no computer yet.", name), null, t("Start one")]
							: [
									t("{name} is not using a computer right now.", name),
									`${t("{name} gets one when a task needs a screen.", name)} ${t("Someone with edit access can start one.")}`,
									null,
								]
						: shown === "headless"
							? this.#listed?.canWake
								? [t("{name} is working on a machine without a screen.", name), null, t("Start one")]
								: [
										t("{name} is working on a machine without a screen.", name),
										t("Someone with edit access can start one."),
										null,
									]
							: shown === "making"
								? [t("The computer is starting…"), null, null]
								: shown === "noStart"
									? this.#startRefusedWords()
									: shown === "asleep"
										? this.#listed?.canWake
											? [t("The computer is asleep."), null, this.#waking ? null : t("Wake it")]
											: [t("The computer is asleep."), t("Someone with edit access can wake it."), null]
										: shown === "starting"
											? [
													t("The computer is starting…"),
													waitingFor === "hours"
														? t(
																"Out of computer hours. The machine starts by itself once hours are added.",
															)
														: waitingFor === "room"
															? t("Waiting for room on our servers. It starts as soon as there is room.")
															: null,
													null,
												]
											: shown === "off"
												? this.#listed?.canWake
													? [t("The computer is on, but its screen is off."), null, t("Turn it on")]
													: [
															t("The computer is on, but its screen is off."),
															t("Someone with edit access can turn it on."),
															null,
														]
												: shown === "turning"
													? [t("The screen is turning on…"), null, null]
													: shown === "small"
														? [t("This computer is too small for a screen."), null, null]
														: shown === "startFailed"
															? [
																	t("The screen could not be turned on. Try again."),
																	null,
																	t("Try again"),
																]
															: shown === "hidden"
																? [
																		t(
																			"The screen is hidden because it may show files you can't open.",
																		),
																		null,
																		null,
																	]
																: shown === "updating"
																	? [t("Updating…"), null, null]
																	: shown === "image"
																		? [
																				t(
																					"This computer cannot show its screen yet. It can after it has slept.",
																				),
																				null,
																				null,
																			]
																		: shown === "error"
																			? [
																					t("The computer could not be reached. Try again."),
																					null,
																					t("Try again"),
																				]
																			: shown === "controlled"
																				? [
																						member
																							? t(
																									"{member} is typing privately. The screen is hidden until they're done.",
																									{ member },
																								)
																							: t(
																									"Someone is typing privately. The screen is hidden until they're done.",
																								),
																						null,
																						null,
																					]
																				: [
																						t("Paused to save power. Still watching?"),
																						null,
																						t("Keep watching"),
																					];
		this.#loading.dataset.state = shown;
		// The state text shows only while there is no picture over it (a screen reader would read it under one).
		this.#loading.hidden = this.#view?.shown === true;
		this.#spinner.hidden = !(
			shown === "loading" ||
			shown === "starting" ||
			shown === "updating" ||
			shown === "turning" ||
			shown === "making" ||
			this.#waking
		);
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
		} else if ((state === "off" || state === "startFailed") && this.#machineId && this.#listed?.canWake) {
			// Turn it on (20260930714000): the wish, and a start at once.
			this.#wantOn = { machineId: this.#machineId, until: Date.now() + WANT_ON_MS };
			this.#startEnded = undefined;
			this.#startAnswered = undefined;
			if (!this.#turningOn) void this.#turnOn(computer, this.#machineId, signal);
		} else if (
			(state === "none" || state === "headless" || state === "noStart") &&
			this.#listed?.canWake &&
			!this.#making
		) {
			await this.#startComputer(computer, signal);
			if (signal.aborted) return;
		} else if (state === "asleep" && this.#machineId && !this.#waking) {
			const machineId = this.#machineId;
			// One press: the machine wakes, and its screen comes on when it runs (20260930714000).
			this.#wantOn = { machineId, until: Date.now() + WANT_ON_MS };
			this.#startEnded = undefined;
			this.#startAnswered = undefined;
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

	/** Start one (20260930730000): one desktop computer for the agent, made as its own machine_start with desktop true and
	 * its defaults makes it, or the agent's own one big enough for a desktop. Then the press carries the wish through to a
	 * picture, as Wake it's does: once the list shows the computer running, the window turns its screen on (20260930714000).
	 * The wish is this page's, for that computer: it ends at its picture, a refusal, a close, a switch, or WANT_ON_MS. Never
	 * on open: a computer costs hours, so it takes a press. */
	async #startComputer(computer: WebCompanyComputer, signal: AbortSignal): Promise<void> {
		const chosen = this.#chosen;
		this.#making = true;
		this.#startRefused = undefined;
		this.#show("making");
		let answer: MemberAgentComputerStart | undefined;
		try {
			answer = await computer.startAgentComputer(this.agentId, signal);
		} catch {
			answer = undefined;
		} finally {
			this.#making = false;
		}
		if (signal.aborted) return;
		this.#listStale = true;
		if (answer === undefined || answer.kind === "refused") {
			this.#startRefused = answer?.reason ?? "failed";
			if (!this.#pick()) this.#show("noStart");
			return;
		}
		// The member chose a machine meanwhile: the wish was theirs to drop (the computer is made all the same).
		if (this.#chosen !== chosen) return;
		this.#chosen = answer.machineId;
		this.#wantOn = { machineId: answer.machineId, until: Date.now() + WANT_ON_MS };
		this.#startEnded = undefined;
		this.#startAnswered = undefined;
		// The agent's own computer, asleep: woken, as Wake it does.
		if (answer.state === "stopped" || answer.state === "stopping") {
			try {
				await computer.wakeMachine(answer.machineId, signal);
			} catch {
				// The list says where it stands now.
			}
			if (signal.aborted) return;
		}
		if (!this.#pick()) this.#show("starting");
	}

	/** What the window says when Start one made no computer: in plain words, with Try again where trying again can help. */
	#startRefusedWords(): [string, string | null, string | null] {
		const name = { name: this.#name };
		switch (this.#startRefused) {
			case "MACHINES_UNAVAILABLE":
				return [t("No server can run a computer right now. Try again later."), null, t("Try again")];
			case "MACHINE_TOO_LARGE":
				return [t("No server is large enough for a computer with a screen."), null, null];
			case "START_TOO_SOON":
				return [
					t("A computer was started for {name} a moment ago. Try again in a minute.", name),
					null,
					t("Try again"),
				];
			case "AGENT_UNAVAILABLE":
				return [t("{name} is no longer on the team, so it gets no computer.", name), null, null];
			default:
				return [t("The computer could not be started. Try again."), null, t("Try again")];
		}
	}

	/** Whether the member's wish that this machine's desktop be on stands (it ends after WANT_ON_MS). */
	#wishFor(machineId: string): boolean {
		if (this.#wantOn && Date.now() >= this.#wantOn.until) this.#wantOn = undefined;
		return this.#wantOn?.machineId === machineId;
	}

	/** Turns the machine's desktop on (20260930714000) and looks at once. A refusal ends the wish and is said (too small, a
	 * screen it may not show, or a start that failed: Try again); a start of another page's a moment ago, or a machine on
	 * its way up, keeps it, and the next look tells. Nothing of it touches the window once the member chose another
	 * machine or closed it. */
	async #turnOn(computer: WebCompanyComputer, machineId: string, signal: AbortSignal): Promise<void> {
		if (this.#turningOn) return;
		this.#turningOn = true;
		this.#startedAt = Date.now();
		this.#unpicture("turning");
		let answer: MachineStartAnswer | undefined;
		try {
			answer = await computer.screens.start(machineId, signal);
		} catch {
			answer = undefined;
		} finally {
			this.#turningOn = false;
		}
		if (signal.aborted || this.#wantOn?.machineId !== machineId || this.#machineId !== machineId) return;
		if (answer?.kind === "refused") {
			if (answer.code === "DESKTOP_MACHINE_TOO_SMALL") {
				this.#endStart(machineId, "small");
				return;
			}
			if (answer.code === "MACHINE_NEEDS_COMPANY_VIEW") {
				this.#wantOn = undefined;
				this.#unpicture("hidden");
				return;
			}
			if (answer.code === "MACHINE_NOT_RUNNING" || answer.code === "MACHINE_BOOT_CHANGED") this.#listStale = true;
			else if (answer.code !== "DESKTOP_START_TOO_SOON") {
				this.#endStart(machineId, "startFailed");
				return;
			}
		} else if (answer === undefined) {
			this.#endStart(machineId, "startFailed");
			return;
		} else this.#startAnswered = { machineId, at: Date.now() };
		// Started, running already, or another start on its way: look at once (the helper waited until it was drawn).
		this.#etag = null;
		this.#lastLook = Number.NEGATIVE_INFINITY;
		this.#quicken();
	}

	/** A start that ends the member's wish: what it says stays until they press again. */
	#endStart(machineId: string, shown: "small" | "startFailed"): void {
		this.#wantOn = undefined;
		this.#startAnswered = undefined;
		this.#startEnded = { machineId, shown };
		this.#unpicture(shown);
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
							// over to the machine chosen now, nor a wish that its desktop be on (20260930714000).
							if (machine.machineId !== before) {
								this.#wantTakeOver = undefined;
								if (this.#wantOn?.machineId !== machine.machineId) this.#wantOn = undefined;
								// Shared input of the last computer goes no further, even while the loop waits on a request
								// (review r1 F1 of #1701); the next one's screen is not seen yet (review r3).
								this.#screenSeen = false;
								this.#endShared();
								this.#lostShown = false;
								this.#controlNote.textContent = "";
								// The picture takes nothing more for the last computer, at once (review r2 F1 of #1701).
								this.#syncControls();
							}
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
