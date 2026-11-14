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
	MachinePointerAnswer,
	MachineScreenLook,
	MachineStartAnswer,
} from "../../cloud/machine-screens.ts";
import type { MachineStreamMessage } from "../../cloud/machine-stream.ts";
import type { RealtimeResource } from "../../cloud/realtime.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentColor, figureFor } from "../../ui/avatar.ts";
import { attachComputerDrag } from "../../ui/computer-drag.ts";
import { ComputerScene, type ScenePhase } from "../../ui/computer-scene.ts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import {
	type InputSpan,
	type InputTime,
	inputTime,
	joinInputs,
	type MachineScreenInput,
	type MachineScreenPicture,
	MachineScreenView,
	TEXT_MAX,
} from "../../ui/machine-screen-view.ts";
import { leave, zoomFrom } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { ComputerByItself } from "./computer-by-itself.ts";
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
/** The member's pointer (20260930744000): at most one move every this long (30 a second, the executor's bound), one in
 * flight, the newest position replacing one not sent yet. */
const POINTER_EVERY_MS = 34;
/** A pointer pass is begun again when less than this is left of it (it lasts 10 s). */
const POINTER_RENEW_MS = 2500;
/** At most one pass's begin this often on a hold or a sharing: a begin is SQL's (two calls and the pass's row), so one that
 * failed (no answer, a pass gone again at once) is asked again after this, never at the pointer's pace or in a loop. */
const POINTER_BEGIN_EVERY_MS = 1000;
/** While the member's pointer moved in the last POINTER_MOVING_MS, the window does not back off: it looks every
 * LOOK_EVERY_MS, the database's own least time between a member's looks (400 ms) and a margin, so a hover shows within
 * one look and none is refused SCREEN_TOO_SOON (review r1 F5 of #1733). */
const POINTER_MOVING_MS = 1000;
/** A pass the executor may still hold ends, on every node, by its answer's time plus its milliseconds and this. */
const POINTER_PASS_MARGIN_MS = 1000;
/** After a refusal that a desktop coming back ends (the screen off, a restart, the machine asleep), no new pass for this
 * long; the member's next move after it begins one (review r1 F4 of #1733). Never a loop: only a move asks again. */
const POINTER_PAUSE_MS = 3000;
/** The refusals POINTER_PAUSE_MS waits out; every other one ends that hold's or sharing's pointer. */
const POINTER_PASSING: ReadonlySet<string> = new Set([
	"DESKTOP_NOT_RUNNING",
	"MACHINE_BOOT_CHANGED",
	"MACHINE_NOT_RUNNING",
]);
/** The desktop's live picture in the large view (20260930745000): its pointer pass is begun again when less than
 * STREAM_RENEW_MS is left of it (before the pointer's own POINTER_RENEW_MS: one renewal serves both), and whether it may
 * go on is checked every STREAM_CHECK_MS; at most one stream opens a second. A stream that failed is tried again after
 * STREAM_RETRY_MS times the failures in a row (only a socket that drew pixels ends the run: its size alone does not);
 * STREAM_FAILURES of them turn it off for the page for STREAM_OFF_MS (the
 * looks go on); a refusal or the desktop's end waits STREAM_PAUSE_MS, and the looks say why meanwhile. A node that
 * watches as many desktops as it may (STREAM_BUSY) is asked again after STREAM_BUSY_MS, the looks going on as they were. */
const STREAM_RENEW_MS = 4000;
const STREAM_CHECK_MS = 1000;
const STREAM_OPEN_EVERY_MS = 1000;
const STREAM_RETRY_MS = 2000;
const STREAM_FAILURES = 3;
const STREAM_OFF_MS = 10 * 60_000;
const STREAM_PAUSE_MS = 3000;
const STREAM_BUSY_MS = 30_000;
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

/** How far the wall clock may fall behind the monotonic one, against an input's parts, before it counts as set back
 * (inputSpanTooOld): above the drift of the two clocks over INPUT_MAX_AGE_MS, below any set-back that matters. */
const CLOCK_SLACK_MS = 1000;

/** Whether an action made of the parts in `made` may no longer be sent (review r5 F1 of #1701): too old whenever ANY
 * of its parts is (inputTooOld of the oldest and of the newest by each clock), or the wall clock was set back since
 * any part was made, even if it came forward again since (the wall-minus-monotonic offset fell). Joining two inputs
 * never makes one that a part of it would not have been. */
export function inputSpanTooOld(made: InputSpan, now: InputTime): boolean {
	return (
		inputTooOld(made.oldest, now) ||
		inputTooOld(made.newest, now) ||
		now.wall - now.mono < made.offset - CLOCK_SLACK_MS
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
/** What a member's own click that opens an agent's computer starts by itself (COMPUTER-OPEN-BRIEF, 13 Nov 2026: "assume
 * that's what I did when clicking the agents computer"), by what the first list read after the click says of the
 * computer shown, for a member who may wake it: a computer asleep is woken; one already on its way up (another tab's
 * wake, another member's) is joined, never woken twice; one that runs with its screen off has its screen turned on.
 * "Start one" (no computer, or none with a screen) is never started by a click: it makes a computer. A window the page
 * opened by itself, or a machine that falls asleep under an open window, starts nothing. */
export const OPEN_STARTS: Readonly<Record<"asleep" | "starting" | "screenOff", boolean>> = Object.freeze({
	asleep: true,
	starting: true,
	screenOff: true,
});
/** How long a click's ask waits for a list read to answer before it lapses (a window that cannot reach the computer
 * says so, and Try again then starts nothing by itself). */
export const ASK_LASTS_MS = 60_000;
/** How long the first picture takes to settle in over the scene. */
const SETTLE_MS = 450;
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
	/** The company's time zone (the machine's clock and backdrop follow it; migration 20260930739000). */
	readonly timeZone?: () => string | null | undefined;
	/** The company's apps, as last read, that a member may open on the computer (20260930758000); none without it. */
	readonly apps?: () => readonly ComputerOpenApp[] | undefined;
}

/** The member's choice of something to open (20260930758000): which, on which computer, its generation, and whether a
 * request carrying it is out. */
interface OpenChoice {
	readonly gen: number;
	readonly machineId: string;
	readonly path: string;
	sent: boolean;
}

/** One of the company's apps as Open offers it (20260930758000): its name, and the path of the company folder that opens
 * it on the desktop. */
export interface ComputerOpenApp {
	readonly name: string;
	readonly path: string;
}

/** How a window is opened: `asked` when the member's own click just asked for it (the agent's card, the thread's
 * agent details, a take-over card); false, the default, when the page opens or shows it by itself. */
export interface ComputerOpen {
	readonly asked?: boolean;
}

/** What the window shows instead of a picture. */
export const COMPUTER_SHOWN = [
	"loading",
	"unavailable",
	"none",
	"headless",
	"asleep",
	"starting",
	"off",
	"hidden",
	"updating",
	"image",
	"error",
	"paused",
	// Another member holds the desktop (20260930713000).
	"controlled",
	// The member turns the screen on (20260930714000): on its way, refused as too small, or failed.
	"turning",
	"small",
	"startFailed",
	// The member starts a computer for an agent that has none (20260930730000): on its way, or made none.
	"making",
	"noStart",
] as const;
type Shown = (typeof COMPUTER_SHOWN)[number];
/** Where Open is offered without a picture (20260930758000, review r1 F6 of #1781): a computer asleep, on its way up,
 * with its screen off, turning on or failed to: the press is the wish "on, with this open". Not while someone else types
 * privately (controlled), the screen is hidden, too small, cannot show, loads, waits, pauses or fails to be reached, nor
 * where there is no computer. With a picture (null) it is offered. */
/** What a window says of an open that failed and may be tried again. Read where it is said (t() at that moment). */
const FAILED_OPEN_WORDS = "The computer could not open it. Try again.";
const OPEN_OFFERED: ReadonlySet<Shown> = new Set<Shown>(["asleep", "starting", "off", "turning", "startFailed"]);
export function computerOpenOffered(shown: Shown | null): boolean {
	return shown === null || OPEN_OFFERED.has(shown);
}

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
	/** The member's pointer under this hold (20260930744000): on a private pass of its own epoch and seat. */
	readonly pointer: PointerLane;
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
	/** The desktop's lease generation the list named when this sharing began (20260930738000; null from a database
	 * before it): every action of it carries it as the one its input was made under, and SQL refuses it once someone held
	 * the desktop privately since (DESKTOP_HELD_SINCE). Another one in the list ends the sharing (#sharingOf). */
	readonly generation: number | null;
	readonly queue: QueuedAction[];
	readonly stop: AbortController;
	sending: boolean;
	/** It ended without the member's doing (the predicate turned false: review r5 F2 of #1701), and whether they were told
	 * that input of it was dropped (once, from its queue or from the picture's buffer); an end they made (a switch, Back,
	 * Type privately, a close) says nothing. */
	endedLost: boolean;
	told: boolean;
	/** Where the picture gives the input it gathers while this computer is shared: to this computer alone, while this
	 * sharing lasts (review r2 F1 of #1701: what the picture still gathers when the member switches, leaves, starts
	 * typing privately or closes goes nowhere, never to another computer and never out as private). */
	readonly input: MachineScreenInput;
	/** The member's pointer while this computer is shared (20260930744000): on a shared pass of this sharing's generation. */
	readonly pointer: PointerLane;
}

/** The member's pointer under a hold or a sharing (20260930744000): the pass it moves on (from the executor, for 10 s:
 * when to begin another, and by when no node holds it any more), the newest position not sent yet (a newer one replaces
 * it: never a queue), whether a request is on its way, the move on its way (`moving`: an action waits for its answer),
 * until when an action waits for a move whose answer never came (`unsure`: its pass has ended everywhere by then, so it
 * can no longer land after the action), until when a desktop that went away is waited out (`paused`), when the last move
 * and the last begin went, and whether this hold's or sharing's pointer is done for (a refusal that a new pass would only
 * repeat). */
interface PointerLane {
	pass: { readonly id: string; readonly until: number; readonly endsBy: number } | null;
	pending: { readonly x: number; readonly y: number } | null;
	inFlight: boolean;
	moving: Promise<void> | null;
	unsure: number;
	paused: number;
	sentAt: number;
	begunAt: number;
	done: boolean;
}

function pointerLane(): PointerLane {
	return {
		pass: null,
		pending: null,
		inFlight: false,
		moving: null,
		unsure: Number.NEGATIVE_INFINITY,
		paused: Number.NEGATIVE_INFINITY,
		sentAt: Number.NEGATIVE_INFINITY,
		begunAt: Number.NEGATIVE_INFINITY,
		done: false,
	};
}

/** The desktop's live picture (20260930745000), for one hold or one sharing alone: it ends with it (its stop), and
 * `live` while its messages show the screen (the window's looks pause then). */
interface PageStream {
	readonly sender: PageHold | SharedInput;
	readonly stop: AbortController;
	live: boolean;
	/** Whether the socket now open drew pixels of the screen (a size alone is not a picture): only that ends a run of
	 * failures (the v245 release review F3). */
	drew: boolean;
}

/** One input on its way, and when the member made its parts (INPUT_MAX_AGE_MS: from their events, through every buffer). */
interface QueuedAction {
	readonly action: MachineDesktopAction;
	readonly made: InputSpan;
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
	/** The desktop about to be seen, while the computer sleeps or starts (ui/computer-scene.ts). */
	readonly #scene: ComputerScene;
	readonly #body: HTMLDivElement;
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
	/** The member's pointer (20260930744000): the last time a move went through (the window looks sooner while it moves),
	 * and whether the page has no pointer route (a bridge or an executor from before it: today's way, quietly). */
	#movedAt = Number.NEGATIVE_INFINITY;
	#pointerOff = false;
	/** The desktop's live picture in the large view (20260930745000), while there is one; no new one before
	 * `#streamAfter`, and none on this page once the way has no stream route (`#streamOff`). */
	#stream: PageStream | undefined;
	#streamAfter = Number.NEGATIVE_INFINITY;
	#streamOff = false;
	/** A shared action was refused DESKTOP_HELD_SINCE (20260930738000) when this many list reads had begun: no sharing
	 * until one begun after it has answered, with the generation that stands now. */
	#heldSince: number | undefined;
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
	/** A wake of this page's that failed, for the machine named: the asleep state says so, with Try again. */
	#wakeFailed: string | undefined;
	/** The member's click that opened (or showed again) the window: the list reads begun before it, and when. The first
	 * read begun after it decides what starts (OPEN_STARTS). */
	#ask: { readonly before: number; readonly at: number } | undefined;
	/** The agent the window is for, as last opened (its figure and colour for the scene). */
	#agent: HostedStaffAgent;
	readonly #timeZone: () => string | null | undefined;
	/** The state of the machine the window says something of now (the scene's steps follow the list alone). */
	#machineState: MemberAgentMachine["state"] | undefined;
	#settleTimer: ReturnType<typeof setTimeout> | undefined;
	/** The member's wish that the desktop be on (20260930714000): this page's, for one machine, until its picture shows,
	 * the member chooses another machine or closes the window, a refusal comes, or WANT_ON_MS pass. While it stands a
	 * screen that is off is turned on by itself (after Wake it too), without a second press. */
	#wantOn: { readonly machineId: string; readonly until: number } | undefined;
	/**
	 * Open (20260930758000). THE INVARIANT (review r3 of #1781): A CHOICE THE MEMBER MADE ENDS IN EXACTLY ONE OF THREE
	 * WAYS: IT WAS SENT AND ANSWERED (and the answer handled by #openAnswered), A NEWER CHOICE OR THE MEMBER'S OWN MOVE
	 * REPLACED IT (another choice, a switch of machine, the window closed, a plain press), OR THE WINDOW SAID WHY IT DID
	 * NOT OPEN, WITH TRY AGAIN WHERE TRYING AGAIN CAN HELP. IT IS NEVER DROPPED SILENTLY.
	 *
	 * By construction: the choice (its path, its generation, its machine) has ONE home, `#choice`, apart from the wish
	 * that the desktop be on: nothing that ends or clears the wish takes the choice with it. It ends only in
	 * #endChoice, with the way it ended; it is sent only by #turnOn (the start that turns an off screen on carries it)
	 * and #openNow (a screen that runs), each marking it sent, and one request at a time; and while it waits, #pumpChoice
	 * (after every answer, at a picture) sends it, or arms the wish that turns the screen on with it. An answer to a
	 * choice no longer the one standing changes nothing but what a confirmed success tells (the desktop runs).
	 */
	#choice: OpenChoice | undefined;
	#choiceGen = 0;
	/** Every choice and how it ended, read by the tests alone (the invariant, step by step); the newest 64. */
	readonly #choiceLog: {
		gen: number;
		path: string;
		sends: number;
		out: number;
		retries: number;
		ended?: "answered" | "replaced" | "said";
		said?: string;
	}[] = [];
	/** The company's apps as last read; a request carrying a choice on its way while the picture shows; the large view to
	 * enter at the first picture after Open was chosen in the small window; and what the last open that did not go
	 * through says (with the path to try again, where trying again can help). */
	readonly #apps: () => readonly ComputerOpenApp[];
	readonly #opener: HTMLButtonElement;
	readonly #frameOpener: HTMLButtonElement;
	#opening = false;
	#enterOnOpen = false;
	#openNote: { readonly machineId: string; readonly words: string } | undefined;
	#openRetry: { readonly machineId: string; readonly path: string; readonly words: string } | undefined;
	readonly #openAgain = h(
		"button",
		{ type: "button", class: "machine-screen-control-hand-back machine-screen-open-again", hidden: true },
		t("Try again"),
	);
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
	/** The member acted on this window (claim): it is theirs, never the rule's (20260930742000). */
	#members = false;
	/** The window is closing by the rule's own close (closeByRule): nothing is given back. */
	#quiet = false;
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
		this.#openAgain,
	);

	constructor(
		agent: HostedStaffAgent,
		computer?: WebCompanyComputer,
		parentSignal?: AbortSignal,
		options: ComputerPanelOptions = {},
		open: ComputerOpen = {},
	) {
		this.agentId = agent.id;
		this.#name = agent.displayName;
		this.#agent = agent;
		this.#timeZone = options.timeZone ?? (() => undefined);
		this.#scene = new ComputerScene(this.#sceneLook(undefined));
		this.#body = h("div", { class: "computer-panel-body" }, this.#scene.el, this.#loading);
		this.#parentGone = () => parentSignal?.aborted === true;
		this.#ledger = options.ledger ?? new DesktopHoldLedger(computer, parentSignal);
		const signal = AbortSignal.any([this.#stop.signal, ...(parentSignal ? [parentSignal] : [])]);
		this.#switcher = this.#switcherButton(signal);
		this.#frameSwitcher = this.#switcherButton(signal);
		this.#apps = () => options.apps?.() ?? [];
		this.#opener = this.#openerButton(signal);
		this.#frameOpener = this.#openerButton(signal);
		this.#openAgain.addEventListener(
			"click",
			() => {
				const again = this.#openRetry;
				if (again && this.#openSaid(again)) this.#choose(again.path, signal);
			},
			{ signal },
		);
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
			this.#opener,
			this.#closeButton,
		);
		this.#closeButton.addEventListener("click", () => this.#close(), { signal });
		// Any touch of the window is the member's act on it (20260930742000), seen before the window's own handlers.
		for (const event of ["pointerdown", "keydown", "wheel", "click", "focusin"] as const)
			this.el.addEventListener(event, () => this.claim(), { capture: true, passive: true, signal });
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
				if (expanded) this.claim();
				this.#setExpanded(expanded);
				// The line that says the computer is shared was said: once is enough (20260930734000).
				if (!expanded && this.#introShown) this.#introduce = false;
				// Shared input typed in the large view goes no further once it is left (review r1 F1 of #1701): the member's own
				// doing, so nothing is said (review r5 F2), and before the redraw, which would take it for one without it.
				if (!expanded) this.#endShared();
				// Input follows the view: the picture takes it only while entered.
				this.#syncControls();
			},
			...(options.decode ? { decode: options.decode } : {}),
		});
		this.#view.setSwitcher(h("span", { class: "computer-pickers" }, this.#frameSwitcher, this.#frameOpener));
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
		// The member's click opened it: the first list read decides what starts (OPEN_STARTS). It is theirs.
		if (open.asked) {
			this.claim();
			this.#ask = { before: this.#listReads, at: Date.now() };
		}
		void this.#loop(computer, signal).catch(() => undefined);
	}

	/** The member's own click asked for this computer again (the window stands open, or shows again in a thread): the
	 * first list read begun after it decides what starts (OPEN_STARTS), as at a first open. */
	ask(): void {
		this.claim();
		if (this.#stop.signal.aborted || !this.#computer) return;
		this.#ask = { before: this.#listReads, at: Date.now() };
		this.#wakeFailed = undefined;
		this.#listStale = true;
		// The click is the member's word that they watch, as showing the window again is (attach; review r1 F2 of #1734).
		if (this.#paused) {
			this.#paused = false;
			this.#confirm = true;
		}
		this.#touched();
		this.#poke();
	}

	/** The agent as last opened: its figure and colour, for the scene. */
	know(agent: HostedStaffAgent): void {
		this.#agent = agent;
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
		this.claim();
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
		this.claim();
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
		this.claim();
		this.el.focus();
	}

	/** The member's act on this window (20260930742000), from inside it (a press, a key, a wheel, an input, a button) or
	 * from outside (the agent's card's Computer, Take over and I'm done, the take-over card): set at the act, before any
	 * request goes, and never cleared. A window the rule opened by itself (computer-by-itself.ts) is the member's from
	 * then on: the rule never closes it, whatever answer comes, or none. */
	claim(): void {
		this.#members = true;
	}

	/** Whether the rule that opened this window by itself may close it now: nothing of the member's is alive in it (no
	 * act of theirs ever, so no request of theirs in flight; no hold; no large view). */
	get closableByRule(): boolean {
		return !this.#members && !this.holding && !this.el.classList.contains("is-entered") && !this.#stop.signal.aborted;
	}

	/** The rule's own close (20260930742000): only takes the window away. It does nothing unless closableByRule, and it
	 * never gives a desktop back or calls off a request (there is none of the member's): the ledger is not asked. */
	closeByRule(): boolean {
		if (!this.closableByRule) return false;
		this.#quiet = true;
		this.dispose();
		return true;
	}

	dispose(): void {
		if (this.#stop.signal.aborted) return;
		// The window closes (the member's or the rule's): a choice standing ends with it, replaced.
		this.#endChoice("replaced");
		// The rule's close (closeByRule): nothing of the member's is here to give back or end; only the window goes.
		if (this.#quiet) {
			this.#teardown();
			return;
		}
		// The window closes: what the member may hold of the agent's desktops goes back through the company's ledger, which
		// outlives the window, asks again until the database confirms, and keeps the take-over card waiting till then
		// (review r2 F4). A take-over still on its way is answered first; what it gets goes back as it comes. As the
		// company's page goes, the ledger gives everything back itself.
		this.#wantTakeOver = undefined;
		// The member closes it: shared input goes, unsaid (review r5 F2), before anything redraws.
		this.#endShared();
		this.#released();
		if (this.#stream) this.#endStream(this.#stream);
		if (!this.#parentGone()) void this.#ledger.releaseAgent(this.agentId, "closed");
		this.#teardown();
	}

	/** Everything the window runs ends, on both of its closes (the member's and the rule's): its signal (every listener,
	 * the loop and its waits, the hints, the holds' subscription, the drag), its timers, the picture's view and the
	 * scene. Never the release ledger: the member's close asks that first, the rule's never needs it. */
	#teardown(): void {
		this.#stop.abort();
		this.#poke();
		this.#close = () => {};
		this.#view?.dispose();
		clearTimeout(this.#settleTimer);
		this.#settleTimer = undefined;
		clearTimeout(this.#keepTimer);
		this.#keepTimer = undefined;
		this.#scene.dispose();
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
			if (this.#ask && Date.now() - this.#ask.at >= ASK_LASTS_MS) this.#ask = undefined;
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
					// A read begun after a DESKTOP_HELD_SINCE names the generation that stands now: sharing may go on under it.
					if (this.#heldSince !== undefined && read > this.#heldSince) this.#heldSince = undefined;
					this.#heldPerList();
					// Senders waiting for a read begun after they asked: this is one (it has been applied above).
					const waiting = this.#listWaiters;
					this.#listWaiters = waiting.filter((waiter) => waiter.after >= read);
					for (const waiter of waiting) if (waiter.after < read) waiter.done();
					// The member's click: the first read begun after it decides what starts, while the click still stands (review
					// r1 F1 of #1734: a read begun before the ask lapsed may answer after it).
					const ask = this.#ask;
					if (ask && read > ask.before) {
						this.#ask = undefined;
						if (Date.now() - ask.at < ASK_LASTS_MS) this.#askedOpen(computer, signal);
					}
				} catch {
					signal.throwIfAborted();
					this.#listStale = true;
					this.#failed();
					await this.#wait(this.#backoff(), signal);
					continue;
				}
			}
			const machine = this.#pick();
			// The wish's time limit is kept at every turn of the loop, whatever the machine does (a choice standing in it is
			// then said: review r3 of #1781).
			if (this.#wantOn) this.#wishFor(this.#wantOn.machineId);
			// The agent has a computer with a screen now: why none was made is told no more.
			if (machine) this.#startRefused = undefined;
			if (machine?.machineId !== this.#machineId) {
				// The wish that a desktop be on is for the machine it was made for alone (20260930714000), and so is a choice
				// of what to open on it: the window moved on (a switch, by the member or the list).
				if (this.#wantOn && this.#wantOn.machineId !== machine?.machineId) this.#wantOn = undefined;
				if (this.#choice && this.#choice.machineId !== machine?.machineId) this.#endChoice("replaced");
				this.#startEnded = undefined;
				this.#wakeFailed = undefined;
				// The window's machine changed: every machine of this agent's the ledger has but the one shown now goes back,
				// held, may be held (a lost answer), on its way or queued; the window's own state does not decide it (review r1
				// F6, r3 F8, r4 F8).
				this.#ledger.releaseOthers(this.agentId, machine?.machineId);
				// Shared input of the last machine's goes no further (20260930734000); the next machine's screen is not seen yet.
				// A switch of the member's ended it already; a machine gone from the list ends it here, and says so (review r5
				// F2), as does a word that input was lost before.
				this.#screenSeen = false;
				this.#endShared(true);
				if (!this.#lostShown) this.#controlNote.textContent = "";
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
			this.#syncOpeners();
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
			// The live picture shows the screen (20260930745000): no looks while it does; the list is read as before, and the
			// looks come back the moment it ends.
			if (this.#streamShows(machine.machineId)) {
				await this.#wait(this.#listedAt + MACHINES_EVERY_MS - Date.now(), signal);
				continue;
			}
			// While the member's pointer moves, the window does not back off, so a hover shows within a look (20260930744000).
			const delay =
				Date.now() - this.#movedAt < POINTER_MOVING_MS ? Math.min(this.#delay, LOOK_EVERY_MS) : this.#delay;
			const due = this.#lastLook + delay;
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
			// The live picture began while the look was on its way: its picture is newer than the look's.
			if (this.#streamShows(machine.machineId)) continue;
			if (look.kind === "picture") {
				if (await this.#view?.show(look.png)) {
					// The first picture settles in over the scene it was waited on.
					if (!this.#scene.el.hidden) this.#settle();
					this.#etag = look.etag;
					this.#pictureOf = machine.machineId;
					this.#screenSeen = true;
					this.#unchanged = 0;
					// The desktop is on: the member's wish is met. What it was to open and has not been sent goes now
					// (20260930758000: the screen came on by another's start).
					if (this.#wantOn?.machineId === machine.machineId) this.#wantOn = undefined;
					// A choice that waits goes now, the desktop running (it does not live in the wish).
					this.#pumpChoice(computer, signal);
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
			input: {
				act: (action, made) => this.#enqueue(hold, action, made),
				point: (at) => this.#point(hold, at),
			},
			pointer: pointerLane(),
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
		// Its live picture ends with it, at once.
		if (this.#stream?.sender === hold) this.#endStream(this.#stream);
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
	#enqueue(hold: PageHold, action: MachineDesktopAction, made: InputSpan): void {
		this.claim();
		if (
			this.#hold !== hold ||
			hold.stop.signal.aborted ||
			!this.#current(hold) ||
			this.#pick()?.machineId !== hold.machineId
		)
			return;
		this.#queue(hold, action, made);
		void this.#drain(hold);
	}

	/** One of the member's actions on the desktop they share with the agent (20260930734000), after those on their way:
	 * only while that sharing is the window's, of the computer chosen now (the input of a computer or a mode gone is
	 * dropped, never sent to another or in another: review r2 F1 of #1701). */
	#share(shared: SharedInput, action: MachineDesktopAction, made: InputSpan): void {
		this.claim();
		if (this.#shared !== shared || shared.stop.signal.aborted || !this.#sharingOf(shared)) {
			// The predicate is false: the sharing and its queue go now, never to be used again (review r3 of #1701). This
			// input is dropped with it: said when the member did not end it (review r5 F2).
			if (this.#shared === shared) this.#endShared(true);
			this.#toldLost(shared);
			return;
		}
		this.#queue(shared, action, made);
		void this.#drain(shared);
	}

	/** Input of a sharing that ended without the member's doing was dropped: they are told, once (review r5 F2 of #1701). */
	#toldLost(shared: SharedInput): void {
		if (!shared.endedLost || shared.told) return;
		shared.told = true;
		this.#lostShown = true;
		this.#controlNote.textContent = t("Your last input did not go through. Try again.");
	}

	/** The sharing of `machineId`, begun now unless it is on (its picture input is new then). */
	#sharedFor(machineId: string): SharedInput {
		if (this.#shared?.machineId === machineId && !this.#shared.stop.signal.aborted && this.#sharingOf(this.#shared))
			return this.#shared;
		this.#endShared();
		const shared: SharedInput = {
			machineId,
			epoch: this.#epochOf(machineId),
			generation: this.#generationOf(machineId),
			queue: [],
			stop: new AbortController(),
			sending: false,
			endedLost: false,
			told: false,
			input: {
				act: (action, made) => this.#share(shared, action, made),
				// A press the picture dropped unfinished as this sharing ended.
				lost: () => this.#toldLost(shared),
				point: (at) => this.#point(shared, at),
			},
			pointer: pointerLane(),
		};
		this.#shared = shared;
		return shared;
	}

	/** The action joins its queue; texts typed one after another, not sent yet, go as one. A new input ends the word that
	 * an earlier one did not go through. */
	#queue(sender: PageHold | SharedInput, action: MachineDesktopAction, made: InputSpan): void {
		const last = sender.queue.at(-1);
		if (
			last?.action.type === "type" &&
			action.type === "type" &&
			sender.queue.length > (sender.sending ? 1 : 0) &&
			[...last.action.text].length + [...action.text].length <= TEXT_MAX
		)
			// The joined text keeps every part's verdict (review r5 F1 of #1701): too old whenever any part is.
			sender.queue[sender.queue.length - 1] = {
				action: { type: "type", text: last.action.text + action.text },
				made: joinInputs(last.made, made),
			};
		else sender.queue.push({ action, made });
		// An action moves the pointer where it acts: a move not sent yet goes nowhere (20260930744000).
		sender.pointer.pending = null;
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
		shared.endedLost = lost;
		// Input waiting in its queue is said lost now; input the picture still holds for it, when the picture hands it over.
		if (shared.queue.length > 0) this.#toldLost(shared);
		shared.stop.abort();
		shared.queue.length = 0;
		// Its live picture ends with it, at once.
		if (this.#stream?.sender === shared) this.#endStream(this.#stream);
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
			this.#heldSince === undefined &&
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
			// 20260930738000: the lease generation it was made under still the list's (a private hold seen since ends it).
			this.#generationOf(shared.machineId) === shared.generation &&
			this.#sharing()
		);
	}

	/** The desktop's lease generation as the list last named it (20260930738000); null before it, or unknown. */
	#generationOf(machineId: string): number | null {
		return this.#listed?.machines.find((machine) => machine.machineId === machineId)?.generation ?? null;
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
				if (inputSpanTooOld(item.made, now)) {
					drop(t("Your last input did not go through. Try again."));
					return;
				}
				// Shared input that waited is sent only once a list read begun after the wait answered: what happened
				// meanwhile (a private hold taken and given back, in any window of the member's) is seen first (review r4 F1).
				const waited =
					busySince !== undefined ||
					now.wall - item.made.oldest.wall > BUSY_RETRY_MS ||
					now.mono - item.made.oldest.mono > BUSY_RETRY_MS;
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
				// A move of this hold's or sharing's on its way goes first (review r1 F1 of #1733); after a wait, everything above
				// is checked again.
				if (!(await this.#pointerSettled(sender))) continue;
				let answer: MachineActAnswer | undefined;
				try {
					answer = await computer.screens.act(
						sender.machineId,
						item.action,
						hold
							? { epoch: hold.epoch, seat: hold.seat }
							: shared?.generation !== null && shared?.generation !== undefined
								? { generation: shared.generation }
								: null,
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
				if (code === "DESKTOP_HELD_SINCE") {
					// Someone held the desktop privately since this input was made, unseen by the window (20260930738000): it and
					// what came after it go, said; sharing waits for a list read begun now, then goes on under its generation.
					this.#heldSince = this.#listReads;
					this.#listStale = true;
					drop(t("Your last input did not go through. Try again."));
				} else if (code === "DESKTOP_CONTROL_ENDED" || code === "DESKTOP_MEMBER_IN_CONTROL") {
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
			// Moves wait while actions go (20260930744000): once the queue is empty, the newest position goes.
			void this.#pumpPointer(sender);
		}
	}

	/** Where the member's own pointer is over the picture (20260930744000), for the hold or the sharing it was gathered
	 * for, while that is the window's: the newest position replaces one not sent yet. Null (it left the picture) sends
	 * nothing more. */
	#point(sender: PageHold | SharedInput, at: { readonly x: number; readonly y: number } | null): void {
		const lane = sender.pointer;
		if (!at || lane.done || this.#pointerOff || sender.stop.signal.aborted || !this.#pointerCurrent(sender)) {
			lane.pending = null;
			return;
		}
		lane.pending = { x: at.x, y: at.y };
		void this.#pumpPointer(sender);
	}

	/** Whether this hold or sharing is the window's own now, as for its actions. */
	#pointerCurrent(sender: PageHold | SharedInput): boolean {
		return "seat" in sender
			? this.#hold === sender && this.#current(sender) && this.#pick()?.machineId === sender.machineId
			: this.#sharingOf(sender);
	}

	/**
	 * Sends the member's pointer (20260930744000): one request at a time, at most one move every POINTER_EVERY_MS, the
	 * newest position only, never while an action of the same hold or sharing waits or goes (an action moves the pointer
	 * where it acts). It begins a pass first (shared: the sharing's generation; private: the hold's epoch and seat) and
	 * again before it runs out. A route that is not there (a bridge or an executor from before 20260930744000) turns the
	 * pointer off for the page, quietly: the window keeps today's way, the desktop's pointer drawn in its pictures. A
	 * refusal is told as an action's would be where it means the same; the pointer of that hold or sharing is then done.
	 */
	async #pumpPointer(sender: PageHold | SharedInput): Promise<void> {
		const lane = sender.pointer;
		const computer = this.#computer;
		if (!computer || lane.inFlight || !lane.pending || lane.done || this.#pointerOff) return;
		if (sender.queue.length > 0 || sender.sending || !this.#pointerCurrent(sender)) return;
		// A desktop that went away is waited out: the position goes nowhere, and a move after the pause asks again.
		if (Date.now() < lane.paused) {
			lane.pending = null;
			return;
		}
		const hold = "seat" in sender ? sender : undefined;
		const begins = !lane.pass || lane.pass.until - Date.now() < POINTER_RENEW_MS;
		const wait = begins
			? lane.begunAt + POINTER_BEGIN_EVERY_MS - Date.now()
			: lane.sentAt + POINTER_EVERY_MS - Date.now();
		if (wait > 0) {
			lane.inFlight = true;
			await new Promise((resolve) => setTimeout(resolve, wait));
			lane.inFlight = false;
			void this.#pumpPointer(sender);
			return;
		}
		lane.inFlight = true;
		try {
			if (begins || !lane.pass) {
				const shared = hold ? undefined : (sender as SharedInput);
				const begin = hold
					? { epoch: hold.epoch, seat: hold.seat }
					: shared?.generation !== null && shared?.generation !== undefined
						? { generation: shared.generation }
						: null;
				// A database before 20260930738000 names no generation: no pass for this sharing.
				if (!begin) {
					lane.done = true;
					return;
				}
				const began = Date.now();
				lane.begunAt = began;
				const answer = await computer.screens.pointer(sender.machineId, { begin }, sender.stop.signal);
				if (answer.kind === "pass")
					lane.pass = {
						id: answer.pass,
						until: began + answer.milliseconds,
						endsBy: Date.now() + answer.milliseconds + POINTER_PASS_MARGIN_MS,
					};
				else {
					// No pass: the position waits for none; the member's next move brings the next one.
					lane.pending = null;
					this.#pointerRefused(sender, answer);
				}
				return;
			}
			const at = lane.pending;
			const pass = lane.pass;
			lane.pending = null;
			lane.sentAt = Date.now();
			// An action of this hold or sharing waits for this move's answer (review r1 F1 of #1733): what the executor
			// answered it took in that order, so the action comes after it.
			let moved: () => void = () => {};
			lane.moving = new Promise<void>((resolve) => {
				moved = resolve;
			});
			// The company's ledger keeps it by machine too: a hold or sharing made anew for this desktop, or another window,
			// waits for it as this one does (v242 release review r1 F1).
			this.#ledger.moveGoing(sender.machineId, lane.moving);
			try {
				const answer = await computer.screens.pointer(
					sender.machineId,
					{ pass: pass.id, x: at.x, y: at.y },
					sender.stop.signal,
				);
				if (answer.kind === "moved") {
					// The window does not back off while the pointer moves, so a hover shows within a look.
					this.#movedAt = Date.now();
					if (this.#delay > LOOK_EVERY_MS) this.#quicken();
				} else this.#pointerRefused(sender, answer);
			} catch (error) {
				// No answer: the move may still land. Its pass is not used again, and an action waits until that pass has
				// ended on every node, so the move can no longer come after it.
				lane.unsure = Math.max(lane.unsure, pass.endsBy);
				this.#ledger.moveUnsure(sender.machineId, pass.endsBy);
				if (lane.pass === pass) lane.pass = null;
				throw error;
			} finally {
				lane.moving = null;
				moved();
			}
		} catch {
			// No answer (the network, a slow bridge): the newest position goes with the next move. After a begin that got
			// none, nothing is asked again until the member's next move (and then at most once a second): never in a loop.
			if (begins) lane.pending = null;
		} finally {
			lane.inFlight = false;
			if (lane.pending && !lane.done) void this.#pumpPointer(sender);
		}
	}

	/** Whether the hold's or sharing's pointer let its next action go at once: a move on its way is waited for (its answer
	 * puts it before the action), and a move whose answer never came until its pass has ended everywhere; so is any such
	 * move of this page's on the same desktop under an earlier hold or sharing, or in another window (the company's
	 * ledger, by machine: v242 release review r1 F1). False when it waited (the caller checks again what may have changed
	 * meanwhile). */
	async #pointerSettled(sender: PageHold | SharedInput): Promise<boolean> {
		const lane = sender.pointer;
		let settled = true;
		while (lane.moving) {
			settled = false;
			await lane.moving;
		}
		const unsure = lane.unsure - Date.now();
		if (unsure > 0) {
			settled = false;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, unsure);
				sender.stop.signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
		}
		if (!(await this.#ledger.movesSettled(sender.machineId, sender.stop.signal))) settled = false;
		return settled;
	}

	/** A pointer request that did not move the pointer. */
	#pointerRefused(sender: PageHold | SharedInput, answer: MachinePointerAnswer): void {
		const lane = sender.pointer;
		lane.pass = null;
		if (answer.kind === "unavailable") {
			// No pointer route anywhere on the way: the page keeps today's way, quietly.
			this.#pointerOff = true;
			lane.pending = null;
			return;
		}
		if (answer.kind !== "refused" || answer.code === "POINTER_PASS_ENDED") return;
		lane.pending = null;
		// The desktop went away for now (off, restarting, asleep): its pointer comes back with it, after a pause.
		if (POINTER_PASSING.has(answer.code)) {
			lane.paused = Date.now() + POINTER_PAUSE_MS;
			this.#quicken();
			return;
		}
		lane.done = true;
		// Someone took the desktop since this sharing's generation, unseen: as an action's refusal, no sharing until a list
		// read begun now names the generation that stands (20260930738000).
		if (answer.code === "DESKTOP_HELD_SINCE" && !("seat" in sender)) this.#heldSince = this.#listReads;
		this.#listStale = true;
		this.#quicken();
	}

	/**
	 * Whether the desktop's live picture may go on for this hold or sharing (20260930745000): the build names a stream
	 * address and the way has the route; the window is open, in a thread, in a visible tab, watched (no pause, a touch in
	 * the last 30 minutes), in the large view with this computer's picture up; no run of failures or refusal waits; and the
	 * hold or sharing is the window's own and its pointer goes (as for a move: #pointerCurrent). Checked at every change the
	 * window draws and every STREAM_CHECK_MS: false ends the stream.
	 */
	#streamWanted(sender: PageHold | SharedInput): boolean {
		return (
			this.#computer?.screens.stream !== undefined &&
			!this.#stop.signal.aborted &&
			this.attached &&
			document.visibilityState !== "hidden" &&
			!this.#paused &&
			Date.now() - this.#lastTouch < PAUSE_AFTER_MS &&
			this.#view?.entered === true &&
			this.#picturing() &&
			!this.#pointerOff &&
			!this.#streamOff &&
			Date.now() >= this.#streamAfter &&
			!sender.stop.signal.aborted &&
			!sender.pointer.done &&
			this.#pointerCurrent(sender)
		);
	}

	/** Whether the live picture shows this machine's screen now: the looks pause. */
	#streamShows(machineId: string): boolean {
		return this.#stream?.live === true && this.#stream.sender.machineId === machineId;
	}

	/** The live picture is of `sender` (the input the picture takes in the large view), or of nothing: another one's ends,
	 * and one begins when it may. */
	#syncStream(sender: PageHold | SharedInput | undefined): void {
		const stream = this.#stream;
		if (stream && (stream.sender !== sender || !this.#streamWanted(stream.sender))) this.#endStream(stream);
		if (!sender || this.#stream || !this.#streamWanted(sender)) return;
		const next: PageStream = { sender, stop: new AbortController(), live: false, drew: false };
		this.#stream = next;
		void this.#keepStream(next);
	}

	/** The live picture ends: its socket, its renewals and its checks with it; the looks come back at once, with a whole
	 * picture (the one up is the stream's, newer than any etag the window has). */
	#endStream(stream: PageStream): void {
		stream.stop.abort();
		if (this.#stream !== stream) return;
		this.#stream = undefined;
		this.#view?.streamEnded();
		this.#streamLive(stream, false);
	}

	#streamLive(stream: PageStream, live: boolean): void {
		if (stream.live === live) return;
		stream.live = live;
		if (live) return;
		this.#etag = null;
		this.#quicken();
	}

	/** The hold a pass of this hold or sharing is under, as the executor's ticket asks it; null for a database before
	 * lease generations (no pass then). */
	#streamHold(sender: PageHold | SharedInput): { generation: number } | { epoch: number; seat: number } | null {
		if ("seat" in sender) return { epoch: sender.epoch, seat: sender.seat };
		return sender.generation === null ? null : { generation: sender.generation };
	}

	/** Waits `ms`, or until `signal` aborts; leaves no timer. */
	#streamPause(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal.aborted || ms <= 0) {
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener("abort", done, { once: true });
		});
	}

	/**
	 * The pointer pass of this hold or sharing, begun again when less than STREAM_RENEW_MS is left of it, as the pointer's
	 * own begin is (one request of the lane at a time, at most one begin a second, the same refusals): true while a pass
	 * lasts. A begin of the pointer's own on its way is waited for.
	 */
	async #renewPass(sender: PageHold | SharedInput, signal: AbortSignal): Promise<boolean> {
		const lane = sender.pointer;
		const computer = this.#computer;
		for (let waited = 0; lane.inFlight && waited < POINTER_RENEW_MS * 2 && !signal.aborted; waited += 50)
			await this.#streamPause(50, signal);
		const lasts = () => lane.pass !== null && lane.pass.until > Date.now();
		if (!computer || signal.aborted || lane.inFlight || lane.done || this.#pointerOff) return false;
		if (lane.pass && lane.pass.until - Date.now() >= STREAM_RENEW_MS) return true;
		if (Date.now() < lane.paused || Date.now() < lane.begunAt + POINTER_BEGIN_EVERY_MS) return lasts();
		const begin = this.#streamHold(sender);
		if (!begin) {
			lane.done = true;
			return false;
		}
		lane.inFlight = true;
		try {
			const began = Date.now();
			lane.begunAt = began;
			const answer = await computer.screens.pointer(sender.machineId, { begin }, sender.stop.signal);
			if (answer.kind === "pass") {
				lane.pass = {
					id: answer.pass,
					until: began + answer.milliseconds,
					endsBy: Date.now() + answer.milliseconds + POINTER_PASS_MARGIN_MS,
				};
				return true;
			}
			this.#pointerRefused(sender, answer);
			return false;
		} catch {
			// No answer: the pass that lasts still serves; the next check asks again.
			return lasts();
		} finally {
			lane.inFlight = false;
			if (lane.pending && !lane.done) void this.#pumpPointer(sender);
		}
	}

	/**
	 * Keeps the desktop's live picture of this hold or sharing (20260930745000) while it may go on: a pass, a ticket on
	 * it, one stream, its messages drawn; the pass renewed and the stream's right checked every STREAM_CHECK_MS. A stream
	 * that ends is followed by another only for a renewal (the pass ran out, or it was long), or after a failure with a
	 * wait (STREAM_RETRY_MS times the failures; STREAM_FAILURES in a row: off for STREAM_OFF_MS). A refusal or the
	 * desktop's end leaves it to the looks, which say why. Everything it began ends with it: its timer, its socket (the
	 * stream's signal), and its turn as the window's stream.
	 */
	async #keepStream(stream: PageStream): Promise<void> {
		const { sender } = stream;
		const signal = stream.stop.signal;
		const open = this.#computer?.screens.stream;
		let tick: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			if (signal.aborted) return;
			if (!this.#streamWanted(sender)) {
				this.#endStream(stream);
				return;
			}
			void this.#renewPass(sender, signal);
			tick = setTimeout(check, STREAM_CHECK_MS);
		};
		tick = setTimeout(check, STREAM_CHECK_MS);
		signal.addEventListener("abort", () => clearTimeout(tick), { once: true });
		let failures = 0;
		let openedAt = Number.NEGATIVE_INFINITY;
		try {
			while (open && !signal.aborted) {
				if (!(await this.#renewPass(sender, signal)) || !sender.pointer.pass) {
					if (signal.aborted || sender.pointer.done || this.#pointerOff) return;
					if (++failures >= STREAM_FAILURES) {
						this.#streamAfter = Date.now() + STREAM_OFF_MS;
						return;
					}
					await this.#streamPause(STREAM_RETRY_MS * failures, signal);
					continue;
				}
				const hold = this.#streamHold(sender);
				if (!hold) return;
				await this.#streamPause(openedAt + STREAM_OPEN_EVERY_MS - Date.now(), signal);
				// The pass as it is after the wait (a renewal may have replaced it, a refusal ended it).
				const pass = sender.pointer.pass;
				if (signal.aborted || !pass) continue;
				openedAt = Date.now();
				stream.drew = false;
				const end = await open(
					sender.machineId,
					{ pass: pass.id, hold },
					(message) => this.#streamMessage(stream, message),
					signal,
				).catch(() => ({ kind: "failed", delivered: false }) as const);
				if (signal.aborted) return;
				// Only pixels drawn count as this socket having worked: a stream that sends its size and then fails, again and
				// again, never showed the member anything, so it must reach the cutoff (the v245 release review F3).
				const drew = stream.drew;
				// Whatever comes next, the looks show the screen until another stream does.
				this.#view?.streamEnded();
				this.#streamLive(stream, false);
				if (end.kind === "closed") return;
				if (end.kind === "unavailable") {
					// No stream route on the way (an executor before it): the page keeps its looks, quietly.
					this.#streamOff = true;
					return;
				}
				if (end.kind === "refused" && end.code === "POINTER_PASS_ENDED" && !end.delivered) {
					// The ticket's pass is not held where it was asked (it ran out, or the executor restarted): another pass, as
					// after a failure.
					if (sender.pointer.pass?.id === pass.id) sender.pointer.pass = null;
				} else if (end.kind === "refused" && end.code === "STREAM_BUSY") {
					// The node watches as many desktops as it may (review r11 of #1746): nothing of this screen or its sharing
					// changed, so the looks go on as they were, and the live picture is asked for again a while later.
					this.#streamAfter = Date.now() + STREAM_BUSY_MS;
					// Asked again when the wait is over: a still screen's looks slow down, so no draw of the window may come
					// sooner to ask.
					const cancel = () => clearTimeout(again);
					const again = setTimeout(() => {
						this.#stop.signal.removeEventListener("abort", cancel);
						this.#syncControls();
					}, STREAM_BUSY_MS);
					this.#stop.signal.addEventListener("abort", cancel, { once: true });
					return;
				} else if (end.kind === "refused" || end.kind === "desktop") {
					this.#streamRefused(sender, end.code);
					return;
				}
				if (end.kind === "renew" && drew) {
					failures = 0;
					continue;
				}
				failures = drew ? 1 : failures + 1;
				if (failures >= STREAM_FAILURES) {
					this.#streamAfter = Date.now() + STREAM_OFF_MS;
					return;
				}
				await this.#streamPause(STREAM_RETRY_MS * failures, signal);
			}
		} finally {
			clearTimeout(tick);
			this.#endStream(stream);
		}
	}

	/** One message of the live picture, drawn in order while it is the window's stream; the first pauses the looks. One
	 * that cannot be drawn ends the stream (the looks go on). */
	#streamMessage(stream: PageStream, message: MachineStreamMessage): void {
		const view = this.#view;
		if (!view || this.#stream !== stream || stream.stop.signal.aborted) return;
		void view.stream(message).then((drawn) => {
			if (this.#stream !== stream) return;
			// The looks stop only once PIXELS of this stream are on the canvas, never at its size message: a stream that
			// opens and then draws nothing must leave the member the pictures they had (review r4 F1 of #1746).
			if (drawn === "drawn" && message.kind === "rects") {
				stream.drew = true;
				this.#streamLive(stream, true);
			}
			// Work the picture discarded (it was cleared, or this stream ended while the area decoded) is no fault of the
			// stream: a renewal reuses this PageStream, so taking it for a failure would end the socket that replaced it
			// (review r2 F4 of #1746). A picture that could not be drawn ends it, and so does more waiting to be decoded
			// than the stream may hold (review r3 F1): the looks come back either way, so the member still sees the screen.
			if (drawn !== "failed" && drawn !== "overflow") return;
			this.#streamAfter = Date.now() + STREAM_PAUSE_MS;
			this.#endStream(stream);
		});
	}

	/** A stream refused by a release cycle, or ended with the desktop: as a look's refusal, the screen is not as the member
	 * saw it (no shared input until a look shows it again), the list is read again, and someone's private hold since the
	 * sharing's generation waits for a list read begun now (20260930738000). The looks say why. */
	#streamRefused(sender: PageHold | SharedInput, code: string): void {
		this.#streamAfter = Date.now() + STREAM_PAUSE_MS;
		if (code === "DESKTOP_HELD_SINCE" && !("seat" in sender)) this.#heldSince = this.#listReads;
		this.#screenSeen = false;
		this.#listStale = true;
		this.#syncControls();
		this.#quicken();
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
		// Open chosen in the small window: the large view, in the thread (never full screen), at the first picture.
		if (this.#enterOnOpen && picture && this.el.parentElement !== null) {
			this.#enterOnOpen = false;
			if (!this.#view?.entered) this.#view?.enterFrame();
		}
		this.#openAgain.hidden = !(
			this.#openRetry !== undefined &&
			this.#openRetry.machineId === this.#machineId &&
			this.#controlNote.textContent === this.#openRetry.words
		);
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
		// Handing the picture another input can drop input it held for a sharing that ended without the member's doing, which
		// says so (review r5 F2 of #1701): the note shows at once.
		if (!note && this.#controlNote.textContent !== "") this.#controls.hidden = !picture;
		if (entering) this.#view?.focusScreen();
		// The live picture follows the input the picture takes (20260930745000): of that hold or that sharing, or none.
		this.#syncStream(picture && entered ? (hold ?? (sharing ? this.#shared : undefined)) : undefined);
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
		this.#machineState = machine.state;
		const asleep = machine.state === "stopped" || machine.state === "stopping";
		// A failed wake is said until the machine moves or the member asks again.
		if (!asleep) this.#wakeFailed = undefined;
		// Wake it was pressed (or the click that opened the window): the machine is on its way up, and its screen comes on
		// with it.
		if (asleep && !this.#wishFor(machine.machineId) && !this.#waking) this.#show("asleep");
		else this.#show("starting", machine.waitingFor);
	}

	/** The member's click that opened the window, against the first list read after it (OPEN_STARTS). */
	#askedOpen(computer: WebCompanyComputer, signal: AbortSignal): void {
		const machine = this.#pick();
		if (!machine || !this.#listed?.canWake) return;
		const machineId = machine.machineId;
		if (machine.state === "stopped" || machine.state === "stopping") {
			if (OPEN_STARTS.asleep) void this.#wake(computer, machineId, signal);
			return;
		}
		if (machine.state === "starting" || machine.state === "waiting") {
			if (!OPEN_STARTS.starting || this.#wishFor(machineId)) return;
		} else if (!OPEN_STARTS.screenOff || this.#wishFor(machineId) || (this.#picturing() && this.#screenSeen)) return;
		// Joined, not woken again: the wish carries it through to a picture, as Wake it's does (20260930714000).
		this.#wantOn = { machineId, until: Date.now() + WANT_ON_MS };
		this.#startEnded = undefined;
		this.#startAnswered = undefined;
	}

	/** Wakes a sleeping machine (Wake it, or the click that opened the window): one call, joined while it is on its way;
	 * its screen comes on when it runs (20260930714000). A wake that fails ends the wish at once and says so, with Try
	 * again; the list says where it stands. */
	async #wake(computer: WebCompanyComputer, machineId: string, signal: AbortSignal): Promise<void> {
		this.claim();
		if (this.#waking) return;
		this.#wantOn = { machineId, until: Date.now() + WANT_ON_MS };
		this.#startEnded = undefined;
		this.#startAnswered = undefined;
		this.#wakeFailed = undefined;
		this.#waking = true;
		this.#show("starting");
		try {
			await computer.wakeMachine(machineId, signal);
		} catch {
			if (!signal.aborted && this.#wantOn?.machineId === machineId) {
				this.#wantOn = undefined;
				this.#wakeFailed = machineId;
				// A choice that waited for it: said, with Try again (which wakes it again, with the same open).
				if (this.#choice?.machineId === machineId && !this.#choice.sent)
					this.#endChoice("said", t(FAILED_OPEN_WORDS), true);
			}
		} finally {
			this.#waking = false;
		}
		if (signal.aborted) return;
		this.#listStale = true;
		this.#poke();
	}

	/** The scene the window draws for a state, or none (the plain words). Its steps follow what the list said alone. */
	#scenePhase(shown: Shown): ScenePhase | undefined {
		if (shown === "asleep") return "asleep";
		if (shown === "starting") return this.#machineState === "starting" ? "starting" : "waking";
		if (shown === "making") return "waking";
		if (shown === "turning") return "screen";
		if (shown === "loading" && !this.#view?.shown) return this.#scene.el.hidden ? "off" : this.#scene.phase;
		return undefined;
	}

	/** The first picture settles in over the scene; then the scene goes. */
	#settle(): void {
		const view = this.#view;
		this.#scene.set("settled");
		this.#loading.classList.remove("is-scene");
		view?.el.classList.add("is-arriving");
		clearTimeout(this.#settleTimer);
		this.#settleTimer = setTimeout(() => {
			view?.el.classList.remove("is-arriving");
			if (this.#view?.shown) this.#scene.hide();
		}, SETTLE_MS);
	}

	/** What the scene says of the machine shown, and the figure it draws: the agent's own on a computer the agent started,
	 * else the neutral one (its backdrop names the agent that started it, #1708). */
	#sceneLook(machine: MemberAgentMachine | undefined): {
		figure: ReturnType<typeof figureFor> | "neutral";
		color: string;
		timeZone: string | null | undefined;
	} {
		const figure = machine && !machine.startedByAgent ? "neutral" : figureFor(this.#agent);
		return {
			figure,
			color: figure === "neutral" ? agentColor(this.#agent) : agentColor(this.#agent, figure),
			timeZone: this.#timeZone(),
		};
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
											? this.#wakeFailed !== undefined && this.#wakeFailed === this.#machineId
												? [t("The computer could not be started. Try again."), null, t("Try again")]
												: [t("The computer is asleep."), null, this.#waking ? null : t("Wake it")]
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
		// Asleep and on its way up the window draws the desktop about to be seen; the words stay here for screen readers.
		const phase = this.#scenePhase(shown);
		if (phase) {
			this.#scene.look(this.#sceneLook(this.#pick()));
			this.#scene.set(phase);
			this.#scene.say(
				status,
				waitingFor === "room"
					? t("Waiting for room on our servers…")
					: waitingFor === "hours"
						? t("Out of computer hours…")
						: "",
				phase === "waking" ? (detail ?? "") : "",
			);
			this.#loading.classList.add("is-scene");
			this.#loading.dataset.scene = phase;
		} else if (!this.#view?.shown || this.#scene.phase !== "settled") {
			clearTimeout(this.#settleTimer);
			this.#scene.hide();
			this.#loading.classList.remove("is-scene");
			delete this.#loading.dataset.scene;
		}
		this.#spinner.hidden =
			phase !== undefined ||
			!(
				shown === "loading" ||
				shown === "starting" ||
				shown === "updating" ||
				shown === "turning" ||
				shown === "making" ||
				this.#waking
			);
		if (this.#status.textContent !== status) this.#status.textContent = status;
		// An open that did not go through says why under the state, until the member presses or opens again.
		const note = this.#openNote;
		const said = note !== undefined && this.#openSaid(note) ? note.words : detail;
		this.#detail.hidden = said === null;
		this.#detail.textContent = said ?? "";
		// An open that failed and may be tried again: the state's own button asks for that same open again (review r1 F5 of
		// #1781), not a plain start.
		const again = this.#openAgainHere(shown);
		this.#syncOpeners();
		this.#action.hidden = action === null && !again;
		this.#action.textContent = again ? t("Try again") : (action ?? "");
	}

	/** Whether what an open's answer said still stands: on this computer, and not yet cleared by the member's next input or
	 * press (one text, the control note's, said under the picture and under the state alike). */
	#openSaid(said: { readonly machineId: string; readonly words: string }): boolean {
		return said.machineId === this.#machineId && this.#lostShown && this.#controlNote.textContent === said.words;
	}

	/** The open the state's own button asks for again, where it does: one that failed and may be tried again, on this
	 * computer, in a state Open is offered in. */
	#openAgainHere(shown: Shown): { readonly path: string } | undefined {
		const retry = this.#openRetry;
		return retry !== undefined && this.#openSaid(retry) && computerOpenOffered(shown) ? retry : undefined;
	}

	/** The state's own button: wake the machine, keep watching, or try again. */
	async #act(computer: WebCompanyComputer, signal: AbortSignal): Promise<void> {
		this.claim();
		const state = this.#loading.dataset.state;
		this.#touched();
		// Try again after an open that failed: that same open (start and open), as the member chose it.
		const again = state === undefined ? undefined : this.#openAgainHere(state as Shown);
		if (again) {
			this.#choose(again.path, signal);
			return;
		}
		// Any other press is a plain one: the member's own move. A choice standing, or an open's words, end with it.
		this.#endChoice("replaced");
		this.#clearOpenWords();
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
			// One press (Wake it, or Try again after a wake that failed): the machine wakes, and its screen comes on when
			// it runs (20260930714000).
			await this.#wake(computer, this.#machineId, signal);
			if (signal.aborted) return;
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
		this.claim();
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
		if (this.#wantOn && Date.now() >= this.#wantOn.until) {
			const ended = this.#wantOn.machineId;
			this.#wantOn = undefined;
			// The wish ran out with a choice still waiting for the screen: said, with Try again.
			if (this.#choice?.machineId === ended && !this.#choice.sent)
				this.#endChoice("said", t(FAILED_OPEN_WORDS), true);
		}
		return this.#wantOn?.machineId === machineId;
	}

	/** Turns the machine's desktop on (20260930714000) and looks at once. A refusal ends the wish and is said (too small, a
	 * screen it may not show, or a start that failed: Try again); a start of another page's a moment ago, or a machine on
	 * its way up, keeps it, and the next look tells. Nothing of it touches the window once the member chose another
	 * machine or closed it. */
	async #turnOn(computer: WebCompanyComputer, machineId: string, signal: AbortSignal): Promise<void> {
		this.claim();
		if (this.#turningOn) return;
		this.#turningOn = true;
		this.#startedAt = Date.now();
		this.#unpicture("turning");
		// A choice that waits goes with this start (20260930758000).
		const choice = this.#choice?.machineId === machineId && !this.#choice.sent ? this.#choice : undefined;
		if (choice) this.#sent(choice);
		let answer: MachineStartAnswer | undefined;
		try {
			answer = await computer.screens.start(machineId, signal, choice?.path);
		} catch {
			answer = undefined;
		} finally {
			this.#turningOn = false;
			if (choice) this.#back(choice);
		}
		if (signal.aborted || this.#machineId !== machineId) return;
		if (choice) {
			// Every answer to a start that carried a choice is the one handler's, while it is the choice standing; one a
			// newer choice replaced tells only what a confirmed success tells.
			if (this.#choice === choice) this.#openAnswered(choice, answer, "turnOn");
			else this.#replacedAnswer(machineId, answer);
			this.#pumpChoice(computer, signal);
			return;
		}
		if (this.#wantOn?.machineId !== machineId) {
			// A plain start whose wish is gone (a picture met it): a success lets a choice made meanwhile go.
			if (ComputerPanel.#ran(answer)) this.#pumpChoice(computer, signal);
			return;
		}
		if (answer?.kind === "refused") {
			if (answer.code === "DESKTOP_MACHINE_TOO_SMALL") {
				this.#endStart(machineId, "small");
				return;
			}
			if (answer.code === "MACHINE_NEEDS_COMPANY_VIEW") {
				this.#wantOn = undefined;
				this.#unpicture("hidden");
				// A choice made while this start was out: the state says why it cannot open.
				if (this.#choice?.machineId === machineId && !this.#choice.sent)
					this.#endChoice(
						"said",
						t("The screen is hidden because it may show files you can't open."),
						false,
						false,
					);
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
		} else {
			this.#startAnswered = { machineId, at: Date.now() };
			// A choice made while this start was out goes now, the desktop running.
			this.#pumpChoice(computer, signal);
		}
		// Started, running already, or another start on its way: look at once (the helper waited until it was drawn).
		this.#lookNow();
	}

	/** A start that ends the member's wish: what it says stays until they press again. */
	#endStart(machineId: string, shown: "small" | "startFailed"): void {
		this.#wantOn = undefined;
		// A choice that waited for this start: said (too small: the state says why; failed: with Try again).
		if (this.#choice?.machineId === machineId && !this.#choice.sent) {
			// The state says it (its own words), so no note is added.
			if (shown === "small") this.#endChoice("said", t("This computer is too small for a screen."), false, false);
			else this.#endChoice("said", t(FAILED_OPEN_WORDS), true);
		}
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
								this.#enterOnOpen = false;
								this.#endChoice("replaced");
								this.#clearOpenWords();
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

	/** Open (20260930758000): a button that lists the company's apps; choosing one is the ask. */
	#openerButton(signal: AbortSignal): HTMLButtonElement {
		const button = h(
			"button",
			{ type: "button", class: "computer-opener", hidden: true, "aria-haspopup": "menu" },
			h("span", null, t("Open")),
			icon("chevron-down"),
		);
		button.addEventListener(
			"click",
			(event) => {
				event.stopPropagation();
				const rect = button.getBoundingClientRect();
				// Full screen, the browser shows only the full-screen element: the menu goes inside it, as the switcher's.
				const full = document.fullscreenElement;
				openContextMenu({
					label: t("Open on this computer"),
					x: rect.left,
					y: rect.bottom + 4,
					opener: button,
					...(full instanceof HTMLElement && full.contains(button) ? { container: full } : {}),
					items: this.#apps().map((app) => ({ label: app.name, select: () => this.#choose(app.path, signal) })),
				});
			},
			{ signal },
		);
		// A press on it is not the start of a drag.
		button.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
		return button;
	}

	/** Open shows for a member who may act on the computer shown, when it can have a screen and the company has an app,
	 * whatever it does now (asleep and off too: the press is the wish "on, with this open"); not while its screen is
	 * someone's private typing, or hidden. */
	#syncOpeners(): void {
		const machine = this.#pick();
		const state = this.#loading.hidden ? null : ((this.#loading.dataset.state ?? "loading") as Shown);
		const offered =
			machine?.desktopCapable === true &&
			this.#listed?.canTakeOver === true &&
			this.#apps().length > 0 &&
			computerOpenOffered(state);
		for (const button of [this.#opener, this.#frameOpener]) {
			if (button.hidden === offered) button.hidden = !offered;
			if (button.title !== t("Open on this computer")) button.title = t("Open on this computer");
		}
	}

	/** The member chose something to open (20260930758000): that is the ask, with no second press. The choice standing
	 * before ends as replaced, and the new one is THE choice. A computer asleep is woken, one on its way up or with its
	 * screen off is turned on with the choice going along; on a screen the member sees, it opens at once. From the small
	 * window the large view comes at the first picture, as Take over's does. */
	#choose(path: string, signal: AbortSignal): void {
		const computer = this.#computer;
		const machine = this.#pick();
		if (!computer || !machine || this.#listed?.canTakeOver !== true || signal.aborted) return;
		this.claim();
		this.#touched();
		const machineId = machine.machineId;
		this.#endChoice("replaced");
		this.#clearOpenWords();
		const choice = { gen: ++this.#choiceGen, machineId, path, sent: false };
		this.#choice = choice;
		this.#choiceLog.push({ gen: choice.gen, path, sends: 0, out: 0, retries: 0 });
		if (this.#choiceLog.length > 64) this.#choiceLog.shift();
		if (!this.#view?.entered) this.#enterOnOpen = this.el.parentElement !== null;
		if (machine.state === "stopped" || machine.state === "stopping") void this.#wake(computer, machineId, signal);
		else {
			this.#startEnded = undefined;
			if (machine.state !== "running" || !(this.#picturing() && this.#screenSeen)) {
				this.#wantOn = { machineId, until: Date.now() + WANT_ON_MS };
				this.#startAnswered = undefined;
			}
			this.#pumpChoice(computer, signal);
		}
		this.#syncControls();
		this.#poke();
	}

	/** The choice that waits goes when it can, one request at a time: on a screen the member sees, at once (#openNow); on
	 * a running computer whose screen is off, with the start that turns it on (#turnOn: the wish is armed for it);
	 * otherwise the wish carries the computer to that point and the next look or answer sends it. */
	#pumpChoice(computer: WebCompanyComputer, signal: AbortSignal): void {
		const choice = this.#choice;
		if (!choice || choice.sent || signal.aborted || choice.machineId !== this.#machineId) return;
		if (this.#opening || this.#turningOn) return;
		// The desktop runs: a screen the member sees, or a start that answered so (a confirmed success).
		if ((this.#picturing() && this.#screenSeen) || this.#startAnswered?.machineId === choice.machineId) {
			void this.#openNow(computer, choice, signal);
			return;
		}
		if (this.#wantOn?.machineId !== choice.machineId)
			this.#wantOn = { machineId: choice.machineId, until: Date.now() + WANT_ON_MS };
		const machine = this.#pick();
		if (
			machine?.machineId === choice.machineId &&
			machine.state === "running" &&
			Date.now() >= this.#startedAt + START_AGAIN_MS
		)
			void this.#turnOn(computer, choice.machineId, signal);
		else this.#poke();
	}

	/** A request carrying the choice goes out; and comes back. */
	#sent(choice: OpenChoice): void {
		choice.sent = true;
		const entry = this.#choiceLog.find((one) => one.gen === choice.gen);
		if (entry) {
			entry.sends++;
			entry.out++;
		}
	}
	#back(choice: OpenChoice): void {
		const entry = this.#choiceLog.find((one) => one.gen === choice.gen);
		if (entry) entry.out--;
	}

	/** THE one way a choice ends (the invariant above): answered (its answer handled by #openAnswered), replaced (a newer
	 * choice or the member's own move), or said (the window says why it did not open: `words`, with Try again where
	 * `retry`). Ending none is nothing. */
	#endChoice(how: "answered" | "replaced" | "said", words?: string, retry = false, shown = true): void {
		const choice = this.#choice;
		if (!choice) return;
		this.#choice = undefined;
		const entry = this.#choiceLog.find((one) => one.gen === choice.gen);
		if (entry && !entry.ended) {
			entry.ended = how;
			if (words !== undefined) entry.said = words;
		}
		if (words !== undefined && shown) this.#sayOpen(choice, words, retry);
	}

	/** An open's words, under the picture or under the state (one text, until the member's next input or press). */
	#sayOpen(choice: { readonly machineId: string; readonly path: string }, words: string, retry: boolean): void {
		this.#openNote = { machineId: choice.machineId, words };
		this.#openRetry = retry ? { machineId: choice.machineId, path: choice.path, words } : undefined;
		this.#lostShown = true;
		this.#controlNote.textContent = words;
		this.#syncControls();
	}

	/** An open's words go (a new choice, a switch, a plain press): wherever they showed. */
	#clearOpenWords(): void {
		const said = this.#openNote;
		this.#openNote = undefined;
		this.#openRetry = undefined;
		if (said && this.#controlNote.textContent === said.words) {
			this.#lostShown = false;
			this.#controlNote.textContent = "";
		}
	}

	/** Every choice and how it ended (the tests' own window on the invariant): read by the tests and nothing else. */
	get choices(): readonly {
		readonly gen: number;
		readonly path: string;
		readonly sends: number;
		readonly out: number;
		readonly retries: number;
		readonly ended?: "answered" | "replaced" | "said";
		readonly said?: string;
	}[] {
		return this.#choiceLog;
	}

	/** Opens the choice on a desktop that runs (the start route turns its screen on first when it is off). A start of
	 * another page's a moment ago is waited out once. */
	async #openNow(computer: WebCompanyComputer, choice: OpenChoice, signal: AbortSignal, again = true): Promise<void> {
		if (this.#opening || this.#turningOn || choice.sent) return;
		this.#opening = true;
		this.#sent(choice);
		let answer: MachineStartAnswer | undefined;
		try {
			answer = await computer.screens.start(choice.machineId, signal, choice.path);
		} catch {
			answer = undefined;
		} finally {
			this.#opening = false;
			this.#back(choice);
		}
		if (signal.aborted) return;
		if (this.#choice === choice && choice.machineId === this.#machineId) {
			if (again && answer?.kind === "refused" && answer.code === "DESKTOP_START_TOO_SOON") {
				this.#retried(choice);
				await new Promise((resolve) => setTimeout(resolve, START_AGAIN_MS));
				if (this.#choice === choice && !signal.aborted) await this.#openNow(computer, choice, signal, false);
				else this.#pumpChoice(computer, signal);
				return;
			}
			this.#openAnswered(choice, answer, "openNow");
		} else if (choice.machineId === this.#machineId) this.#replacedAnswer(choice.machineId, answer);
		// A newer choice that waited while this one was under way goes now.
		this.#pumpChoice(computer, signal);
	}

	/** A choice answered with a code that asks for it again: it waits once more (and may be sent once more). */
	#retried(choice: OpenChoice): void {
		choice.sent = false;
		const entry = this.#choiceLog.find((one) => one.gen === choice.gen);
		if (entry) entry.retries++;
	}

	/** Whether an answer confirms the desktop runs: started, running, or opened. A refusal or a request that failed (no
	 * answer) does not. */
	static #ran(answer: MachineStartAnswer | undefined): boolean {
		return answer !== undefined && answer.kind !== "refused";
	}

	/** An answer to a choice no longer the one standing (review r2 F1 of #1781): it changes nothing the member sees, and
	 * tells only what a confirmed success tells, that the desktop runs. */
	#replacedAnswer(machineId: string, answer: MachineStartAnswer | undefined): void {
		if (!ComputerPanel.#ran(answer)) return;
		this.#startAnswered = { machineId, at: Date.now() };
		this.#lookNow();
	}

	/** Looks at once. */
	#lookNow(): void {
		this.#etag = null;
		this.#lastLook = Number.NEGATIVE_INFINITY;
		this.#quicken();
	}

	/**
	 * Every answer the start route can give a request that carries the choice standing, from either caller (review r2
	 * of #1781: one table, so no code falls through): `turnOn` (the screen was off: the start turns it on, then opens)
	 * and `openNow` (a screen the member sees). The client turns `started` or `running` for an open into a failed
	 * request (no answer), as it does a throw. Each ends the choice as answered, except those that ask for it again.
	 * - opened: the desktop runs and it is open; look at once.
	 * - someone else types privately (DESKTOP_MEMBER_IN_CONTROL): as a click's refusal: the list says who; nothing kept.
	 * - not in the company folder (DESKTOP_OPEN_NOT_FOUND, DESKTOP_OPEN_PATH_INVALID), no company folder on that computer
	 *   (DESKTOP_OPEN_NO_FOLDER): said in plain words; nothing to try again.
	 * - asked for again (the choice waits once more, sent by #pumpChoice): from turnOn, a start a moment ago, the machine
	 *   not running yet, or restarted; from openNow, a start a moment ago is waited out once in #openNow itself.
	 * - turnOn only, the start's own answers that are no failure of this open: too small (the state says so), a disk it
	 *   may not show (hidden).
	 * - anything else, the open's own failures (DESKTOP_DID_NOT_OPEN, DESKTOP_BUSY: the host's hold), a screen that did
	 *   not turn on, and a request that failed: "The computer could not open it. Try again.", with the path kept for Try
	 *   again (under the picture, or the state's own button without one).
	 */
	#openAnswered(choice: OpenChoice, answer: MachineStartAnswer | undefined, caller: "turnOn" | "openNow"): void {
		const machineId = choice.machineId;
		const code = answer?.kind === "refused" ? answer.code : undefined;
		if (answer?.kind === "opened") {
			this.#endChoice("answered");
			this.#startAnswered = { machineId, at: Date.now() };
			this.#lookNow();
			return;
		}
		if (code === "DESKTOP_MEMBER_IN_CONTROL") {
			this.#endChoice("answered");
			if (this.#wantOn?.machineId === machineId) this.#wantOn = undefined;
			this.#screenSeen = false;
			this.#listStale = true;
			this.#quicken();
			return;
		}
		if (caller === "turnOn") {
			if (code === "DESKTOP_START_TOO_SOON" || code === "MACHINE_NOT_RUNNING" || code === "MACHINE_BOOT_CHANGED") {
				// Asked for again: the choice waits once more, and the wish that carries it stands (re-armed if a picture
				// met it meanwhile).
				this.#retried(choice);
				if (this.#wantOn?.machineId !== machineId) this.#wantOn = { machineId, until: Date.now() + WANT_ON_MS };
				if (code !== "DESKTOP_START_TOO_SOON") this.#listStale = true;
				this.#lookNow();
				return;
			}
			if (code === "DESKTOP_MACHINE_TOO_SMALL") {
				this.#endChoice("answered");
				this.#endStart(machineId, "small");
				return;
			}
			if (code === "MACHINE_NEEDS_COMPANY_VIEW") {
				this.#endChoice("answered");
				this.#wantOn = undefined;
				this.#unpicture("hidden");
				return;
			}
		}
		let words: string;
		let retry = false;
		if (code === "DESKTOP_OPEN_NOT_FOUND" || code === "DESKTOP_OPEN_PATH_INVALID")
			words = t("That is not in the company folder any more.");
		else if (code === "DESKTOP_OPEN_NO_FOLDER")
			words = t("This computer cannot see the company folder yet. It can after it has slept and woken.");
		else {
			words = t(FAILED_OPEN_WORDS);
			retry = true;
		}
		if (this.#wantOn?.machineId === machineId) this.#wantOn = undefined;
		this.#endChoice("answered");
		this.#sayOpen(choice, words, retry);
		this.#lookNow();
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
	/** When a window shows by itself in its agent's thread, and goes again (20260930742000). */
	readonly byItself = new ComputerByItself({
		current: (agentId) => {
			const panel = this.#panels.get(agentId);
			return panel ? { el: panel.el, theirs: !panel.closableByRule } : undefined;
		},
		close: (agentId) => this.closeByRule(agentId),
	});
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
		// The take-over card's I'm done: the member's act on the agent's window (20260930742000).
		this.#panels.get(agentId)?.claim();
		return this.#panels.get(agentId)?.handBack() ?? this.#holds.releaseAgent(agentId, "handed_back", true);
	}

	/** Whether the member has a computer's large view open, or types privately on one (holds its desktop), in any of
	 * the company's windows: no window shows by itself then (20260930742000). */
	busy(): boolean {
		return [...this.#panels.values()].some((panel) => panel.el.classList.contains("is-entered") || panel.holding);
	}

	/** The panel a thread left open for this agent, if any. */
	get(agentId: string): ComputerPanel | undefined {
		return this.#panels.get(agentId);
	}

	/** The agent's panel, started now unless a thread already opened it; none once the company is left. `asked`: the
	 * member's own click asked for it just now, so a sleeping computer wakes (OPEN_STARTS); the page's own opens leave
	 * it as it is. */
	open(agent: HostedStaffAgent, open: ComputerOpen = {}): ComputerPanel | undefined {
		if (this.#signal?.aborted) return undefined;
		let panel = this.#panels.get(agent.id);
		if (panel) {
			// The agent may have been renamed (or drawn anew) while no thread showed the panel.
			panel.retitle(agent.displayName);
			panel.know(agent);
			if (open.asked) panel.ask();
			return panel;
		}
		panel = new ComputerPanel(agent, this.#computer, this.#signal, this.#options, open);
		this.#panels.set(agent.id, panel);
		return panel;
	}

	/** The rule's close of a window it opened by itself (computer-by-itself.ts): only when the window says nothing of the
	 * member's is alive in it; never gives anything back. Whether it closed. */
	closeByRule(agentId: string): boolean {
		const panel = this.#panels.get(agentId);
		if (!panel?.closeByRule()) return false;
		this.byItself.released(agentId);
		this.#panels.delete(agentId);
		return true;
	}

	/** End the agent's panel. */
	close(agentId: string): void {
		const panel = this.#panels.get(agentId);
		// Whatever closes it, the window that showed by itself is no longer the rule's (20260930742000).
		this.byItself.released(agentId);
		this.#panels.delete(agentId);
		panel?.dispose();
	}

	/** The company is left (or its access is gone): every desktop the member may hold is asked back once, best effort,
	 * in requests the browser finishes after the page; then the panels end. */
	dispose(): void {
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.#holds.leave();
		this.byItself.dispose();
		for (const agentId of [...this.#panels.keys()]) this.close(agentId);
	}
}
