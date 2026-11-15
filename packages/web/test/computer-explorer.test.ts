// @vitest-environment jsdom

import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComputerPanel, ComputerPanels, KEEP_EVERY_MS, LOOK_EVERY_MS } from "../src/app/views/computer.ts";
import { DesktopHoldLedger } from "../src/app/views/desktop-holds.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import type { RealtimeResource } from "../src/cloud/realtime.ts";
import { fixture, id, profileA, settle, staff, userA } from "./fixtures.ts";
import { Database, type HoldName, random, seating } from "./take-over-model.ts";

/* Schedules explored through the real window (review r13 of #1661): a company's ComputerPanels and the agent's
 * ComputerPanel, driven as a member does (the window's button, the take-over card's Take over, Hand back, I'm done,
 * close, reopen, a switch of machine, pagehide, the page coming back, a list hint, input, time passing), over the
 * database model of desktop-holds-explorer.test.ts (take-over-model.ts). Another tab of the member and another member
 * act on the database too. Every list, take-over and hand-back request is held: its effect on the database and its
 * answer's delivery (or loss) are separate steps; looks, heartbeats and actions are answered at once. Each seed picks
 * its shape (one machine or two, some kinds of step left out) and holds some requests back several steps. After every
 * step, and after a last stretch that answers everything:
 * (I1) once an I'm done answered true, no lease of the member's holds the desktop that was taken before it was pressed,
 * by a take-over the page sent before it answered, or in a seat the page owed then (an own hold a list or an answer
 * showed it after the press or on a machine it had released: since review r19 the seating, not the epoch);
 * (I3) no take-over the page sent holds the desktop after a hand-back answer past its epoch reached the page;
 * (I4) a press of Take over that no release followed comes to something the member sees: the hold, the window's "could
 * not be taken over", a refusal for another member's hold, or the window showing that member;
 * (I5) a take-over request leaves the page only after a press that no release of that machine (Hand back, I'm done,
 * close, a switch away, pagehide) followed;
 * (I7, reviews r17 and r18) an action takes effect, and a heartbeat renews the lease, only while the model's own seat
 * (it counts every seating itself: a new lease, one after a lease ran out, another tab's take-over of the member's own)
 * is the one the page hold it came from was given: the seat the page's own latest take-over got, as the model saw it
 * (each key is recorded with the page hold it was captured in); (I8) whatever an older hold's action answers changes
 * nothing of the window (its hold, its note); (I9) what is typed under a hold that no release followed leaves the page,
 * in the order it was typed, while that hold stands. Action requests are held as the others are, so their answers can
 * come after a hand-back, a lease that ran out, another tab's take-over and a new take-over.
 * (I10, review r19) once the page released a machine (a close, a switch away, pagehide, Hand back, I'm done) with no
 * press for it since, every request it sent reached the database and was answered or lost, and no hand-back of it is
 * unanswered, no lease that a take-over of the page's seated is live there; (I11) a page that knows the end of every
 * take-over it sent for a machine at an epoch hands it back EXACT, never VOID (a VOID asked again until answered is the
 * same hand-back).
 * (I6, review r14) a heartbeat or input for a machine leaves the page only after a press on this page for it that no
 * release followed: nothing is ever taken up from a list; and a note ("could not be taken over") never follows a
 * press that a release followed (F22's counterpart of I4); a Hand back pressed on a hold shown from another window
 * comes to a hand-back of that machine or to "could not be ended yet", never to nothing (review r15).
 * (I2 is the ledger's, checked by desktop-holds-explorer.test.ts; I6 is what it means for the window.) A failure prints
 * the seed, its shape and its steps. */

const gateway = "https://gateway.example.invalid";
const bridge = "https://fixture.invalid/functions/v1/member-company-gateway";
const MEMBER = "member";
const OTHER = "other";
const MACHINES = [id(41), id(42)] as const;
const TAG = `"${"1".repeat(64)}"`;
const SCHEMA = "qorpera.member-machine-desktop/v1";

const OPTIONAL = [
	"hand back",
	"I'm done",
	"switch",
	"pagehide",
	"input",
	"tab takes",
	"tab hands back",
	"member takes",
	"member hands back",
	"lease runs out",
	"answer lost",
] as const;
type Kind = (typeof OPTIONAL)[number] | "button" | "card" | "close" | "reopen" | "resume" | "hint" | "time" | "request";

interface Pending {
	id: number;
	kind: "list" | "take" | "back" | "act";
	machine?: string;
	epoch?: number;
	/** What the page named beside the epoch (F26): an action's seat, a take-over's press, the hold a hand-back names. */
	seat?: number;
	press?: string;
	name?: HoldName;
	/** An action's key press, as the explorer recorded it (review r17). */
	capture?: Capture;
	answer?: unknown;
	effect: boolean;
	settled: boolean;
	/** Its answer reached the page (not lost, not cut off): a take-over the page knows the end of (F27, F28). */
	delivered?: number;
	effectAt: number;
	deliverAt: number;
	resolve: (value: Response) => void;
	reject: (error: unknown) => void;
}

/** A key pressed on the picture while the page held the desktop: its key, the page hold it was captured under (the
 * page's hold count), the model's seat that hold was given (F26: none when the page's own latest take-over seated no one),
 * and whether an action of it left the page. */
interface Capture {
	name: string;
	step: number;
	machine: string;
	serial: number;
	given: number | undefined;
	sent: boolean;
}

/** Keys that go as themselves, one name each, so every action tells which key press it is. */
const KEYS = [
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
	"F10",
	"F11",
	"F12",
	"Home",
	"End",
	"Insert",
	"Delete",
];

interface Done {
	pressed: number;
	answered: number;
	sent: Set<number>;
	upTo: Map<string, Set<number>>;
}

async function flush(rounds = 3) {
	for (let n = 0; n < rounds; n++) {
		await settle();
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function key(target: HTMLElement, value: string) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

/** Where the ledger's calls are written down, for the steps printed, and the ledger the window uses (I10 asks it whether
 * a hand-back of a machine is unanswered). */
let ledgerLog: string[] = [];
let followed: DesktopHoldLedger | undefined;
/** The ledger's take-overs and releases, as the window asks them, written into the steps printed. */
function followLedger(): () => void {
	// Wrapped by hand, not with vi.spyOn: a spy keeps every call (and so every page) it saw.
	const ledger = DesktopHoldLedger.prototype;
	const { take, release } = ledger;
	ledger.take = function (this: DesktopHoldLedger, ...args: Parameters<typeof take>) {
		followed = this;
		const answer = take.apply(this, args);
		const [machine, , pressedAt] = args;
		const log = ledgerLog;
		void answer.then((value) =>
			log.push(`   the ledger's take-over of ${machine.slice(-2)} (press ${pressedAt}) answers ${value.state}`),
		);
		return answer;
	};
	ledger.release = function (this: DesktopHoldLedger, ...args: Parameters<typeof release>) {
		followed = this;
		ledgerLog.push(`   the ledger releases ${args[0].slice(-2)}`);
		return release.apply(this, args);
	};
	return () => {
		ledger.take = take;
		ledger.release = release;
	};
}

/** One explored schedule. `typing` (review r17) weighs typing on the picture and short moments of time far more, so a
 * hold's input meets hand-backs and new take-overs often; without it the steps are drawn as before. */
async function explore(seed: number, steps: number, typing = false): Promise<{ log: string[]; broken?: string }> {
	followed = undefined;
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const machines: readonly string[] = next() < 0.4 ? [MACHINES[0]] : MACHINES;
	const off = new Set<Kind>(OPTIONAL.filter(() => next() < 1 / 3));
	const lag = () => (next() < 0.3 ? 2 + Math.floor(next() * 10) : 0);
	/** Action requests (review r17) go on their own stream of choices, beside the steps (so the steps the explorer drew
	 * before them stay as they were): most are held 1 to 12 steps before they reach the database, and again before
	 * their answers come; one in ten answers is lost. */
	const nextAct = random(seed ^ 0x9e3779b9);
	const actLag = () => (nextAct() < 0.7 ? 1 + Math.floor(nextAct() * 12) : 0);
	/** Requests answered beside the steps: actions, and in typing schedules list reads too (each at the next step, so
	 * the window's loop gets its machines and its picture, and the steps go to holds, typing and hand-backs). */
	const beside = (kind: Pending["kind"]) => kind === "act" || (typing && kind === "list");
	const db = new Database(machines);
	const log: string[] = [`${machines.length} machine(s), without: ${[...off].join(", ") || "none"}`];
	ledgerLog = log;
	const requests: Pending[] = [];
	let ids = 0;
	let step = 0;
	/** What the page sent: take-overs (id, machine, epoch, step), heartbeats and actions (machine, step). */
	const takes: { id: number; machine: string; epoch: number; step: number }[] = [];
	const used: { machine: string; step: number; what: string }[] = [];
	const owedSeen: { machine: string; epoch: number; seat: number | null; step: number; released: boolean }[] = [];
	const answeredBack = new Map<string, number>();
	const refusedFor: { step: number; reason: string }[] = [];
	const dones: Done[] = [];
	/** The explorer's own account of releases (per machine, the last step) and presses (the last step). */
	const releasedAt = new Map<string, number>();
	let pressedAt = -1;
	let press: { step: number; outcome: boolean; finishing: boolean; finishes: number } | undefined;
	/** Hand back and I'm done at work now, and how many began: their later rounds give back what reads show, and a
	 * press meanwhile may be dropped by them (a release after it). */
	let finishing = 0;
	let finishes = 0;
	const finishingOn = (run: Promise<boolean>) => {
		finishing++;
		finishes++;
		void run.finally(() => {
			finishing--;
		});
		return run;
	};
	const violations: string[] = [];
	/** I6 (review r14), as a heartbeat or an action leaves the page: only after a press on this page for that machine
	 * that no release of it followed (a press made before the window knew its machine counts for the one it shows). */
	const use = (machine: string, what: string) => {
		used.push({ machine, step, what });
		const at = releasedAt.get(machine) ?? -1;
		if (!presses.some((one) => one.step > at && (one.machine ?? machine) === machine))
			violations.push(
				`I6: a ${what} for ${machine.slice(-2)} left the page at step ${step} with no press on this page for it since its release at step ${at}`,
			);
	};
	const release = (which: readonly string[]) => {
		for (const machine of which) releasedAt.set(machine, step);
		lastRelease = step;
		press = undefined;
	};
	let lastRelease = -1;
	/** Keys pressed on the picture (review r17), the page's holds counted as they begin, the model's seat each was given
	 * (F26: the seat the page's own latest take-over of the machine got, as the model saw it), and an older hold's action
	 * answer to look after. */
	const captures: Capture[] = [];
	let serial = 0;
	let wasHolding = false;
	const given = new Map<number, number | undefined>();
	let older: { holding: boolean; note: string; name: string } | undefined;
	/** The model's seat the page's own latest take-over of this machine got, if it seated anyone. */
	const seatGiven = (machine: string | undefined) => {
		const latest = takes.filter((take) => take.machine === machine).at(-1);
		return latest === undefined ? undefined : db.seatedBy.get(latest.id);
	};
	/** Hand-back requests the page sent, and presses of the window's Hand back on a hold shown from another window. */
	const backs: { machine: string; step: number }[] = [];
	const handBacks: { step: number; machine: string | undefined; met: boolean }[] = [];
	let lastNote = "";
	/** Every press, with the machine the window showed at it (none yet: whichever it then shows). */
	const presses: { step: number; machine: string | undefined }[] = [];
	const until = () => new Date(Date.now() + 120_000).toISOString();
	const rows = (): MemberAgentMachine[] =>
		machines.map((machineId, n) => {
			const lease = db.leases.get(machineId);
			const mine = lease?.live === true && lease.member === MEMBER;
			return {
				machineId,
				name: `desk-${n + 1}`,
				purpose: "Explored.",
				state: "running",
				lifetime: "task",
				desktopCapable: true,
				startedByAgent: true,
				screenUsedAt: "2026-11-10T14:25:45Z",
				screenAgentName: staff.displayName,
				waitingFor: null,
				control: lease?.live
					? {
							mine,
							name: mine ? "Owner" : "Ada",
							until: until(),
							epoch: mine ? lease.epoch : null,
							seat: mine ? lease.seat : null,
							press: mine ? lease.press : null,
						}
					: null,
				epoch: db.epoch(MEMBER, machineId),
				others: [],
				generation: null,
				memberSleepSeconds: null,
			};
		});
	const effect = (one: Pending) => {
		one.effect = true;
		one.deliverAt = step + (one.kind === "act" ? actLag() : beside(one.kind) ? 0 : lag());
		if (one.kind === "act") {
			const done = db.act(MEMBER, one.machine as string, one.epoch, one.seat);
			// I7 (reviews r17, r18): an action takes effect only while the model's seat is the one its page hold was given.
			if (done.ok && one.capture && one.capture.given !== done.lease.seat)
				violations.push(
					`I7: the action of ${one.capture.name}, captured at step ${one.capture.step} under the page's hold ${one.capture.serial} (given seat ${one.capture.given ?? "none"}), took effect at step ${step} in ${seating(done.lease)}`,
				);
			one.answer = done.ok ? { exitCode: 0 } : { code: done.code };
		} else if (one.kind === "list") one.answer = rows();
		else if (one.kind === "take") {
			const answer = db.take(MEMBER, one.machine as string, one.epoch as number, one.id, one.press);
			// As SQL answers: `memberName` only for another member's hold, `epoch` only for TAKE_CALLED_OFF (found in round
			// 19: the model's nulls made every other refusal look lost to the page).
			one.answer =
				answer.state === "ok"
					? { state: "ok", until: until(), seat: answer.seat }
					: {
							state: "refused",
							reason: answer.reason,
							...(answer.reason === "DESKTOP_MEMBER_IN_CONTROL" ? { memberName: answer.memberName } : {}),
							...(answer.reason === "TAKE_CALLED_OFF" ? { epoch: answer.epoch } : {}),
						};
		} else one.answer = db.handBack(MEMBER, one.machine as string, one.epoch as number, one.name);
	};
	const deliver = (one: Pending) => {
		one.settled = true;
		one.delivered = step;
		if (one.kind === "act") {
			const answer = one.answer as { exitCode?: number; code?: string };
			one.resolve(
				answer.code
					? Response.json({ code: answer.code }, { status: 409 })
					: Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: answer.exitCode }),
			);
			return;
		}
		if (one.kind === "list") {
			const listed = one.answer as MemberAgentMachine[];
			for (const row of listed)
				if (row.control?.mine && row.control.epoch !== null)
					owedSeen.push({
						machine: row.machineId,
						epoch: row.control.epoch,
						seat: row.control.seat,
						step,
						released: (releasedAt.get(row.machineId) ?? -1) > pressedAt,
					});
			one.resolve(
				Response.json({
					schema: "qorpera.agent-machines/v1",
					profileId: profileA.profileId,
					staffAgentId: staff.id,
					canWake: true,
					canTakeOver: true,
					machines: listed,
				}),
			);
		} else if (one.kind === "take") {
			const answer = one.answer as { state: string; reason?: string };
			if (answer.state === "refused" && answer.reason !== "TAKE_CALLED_OFF")
				refusedFor.push({
					step: takes.find((take) => take.id === one.id)?.step ?? -1,
					reason: String(answer.reason),
				});
			one.resolve(Response.json({ schema: SCHEMA, ...answer }));
		} else {
			const answer = one.answer as { epoch: number; holding: boolean; seat: number | null };
			const machine = one.machine as string;
			answeredBack.set(machine, Math.max(answeredBack.get(machine) ?? -1, answer.epoch));
			if (answer.holding)
				owedSeen.push({
					machine,
					epoch: answer.epoch,
					seat: answer.seat,
					step,
					released: (releasedAt.get(machine) ?? -1) > pressedAt,
				});
			one.resolve(Response.json({ schema: SCHEMA, state: "ok", ...answer }));
		}
	};
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url.startsWith(`${bridge}/v1/member-machine-screens/`)) {
			const machine = url.slice(bridge.length).split("/")[4] as string;
			if (url.endsWith("/act")) {
				use(machine, "input");
				const sent = JSON.parse(String(init?.body)) as {
					action: { keys?: string[] };
					epoch?: number;
					seat?: number;
				};
				const name = sent.action.keys?.[0] ?? "";
				const capture = captures.find((one) => !one.sent && one.name === name && one.machine === machine);
				if (capture) {
					// I9 (review r17): a hold's input goes in the order it was captured.
					if (captures.some((one) => one.serial === capture.serial && !one.sent && one.step < capture.step))
						violations.push(`I9: the action of ${name} left the page before an earlier key of its hold`);
					capture.sent = true;
				}
				return held("act", machine, sent.epoch, init, capture, { seat: sent.seat });
			}
			if (new Headers(init?.headers).get("if-none-match") === TAG)
				return new Response(null, { status: 304, headers: { etag: TAG } });
			return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), {
				status: 200,
				headers: { "content-type": "image/png", etag: TAG },
			});
		}
		const method = url.split("/").at(-1);
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		const machine = String(body.p_machine_id ?? "");
		const epoch = Number(body.p_epoch);
		const name: HoldName = {
			seat: (body.p_seat ?? null) as number | null,
			...(body.p_press !== undefined ? { press: body.p_press as string | null } : {}),
		};
		const named =
			name.seat !== null
				? ` seat ${name.seat}`
				: name.press
					? ` press ${name.press.slice(0, 4)}`
					: method === "qorpera_member_hand_back_machine_desktop"
						? " VOID"
						: "";
		if (method === "qorpera_member_hand_back_machine_desktop") {
			// I11 (review r19), as a hand-back leaves the page: one that knows the end of every take-over it sent for the
			// machine at that epoch is EXACT, never VOID.
			const known = requests.every(
				// Delivered at an earlier step: the page has read it by now.
				(one) =>
					one.kind !== "take" ||
					one.machine !== machine ||
					one.epoch !== epoch ||
					(one.delivered !== undefined && one.delivered < step),
			);
			// A VOID asked again (its call was VOID while a take-over was unanswered, and stays VOID until answered: its answer
			// is what fences an earlier copy of it) is not a new decision.
			const again = requests.some(
				(one) =>
					one.kind === "back" &&
					one.machine === machine &&
					one.epoch === epoch &&
					one.name?.seat === null &&
					one.delivered === undefined,
			);
			if (known && !again && name.seat === null && !name.press)
				violations.push(
					`I11: the page sent VOID for ${machine.slice(-2)} at ${epoch} at step ${step}, though every take-over it sent there was answered`,
				);
		}
		if (method === "qorpera_member_keep_machine_desktop") {
			use(machine, "heartbeat");
			log.push(`   the page renews ${machine.slice(-2)}@${epoch}${named}`);
			const renewed = db.keep(MEMBER, machine, epoch, Number(body.p_seat));
			// I7 (review r18): a heartbeat renews the lease only while the model's seat is the one its page hold was given.
			const lease = db.leases.get(machine);
			if (renewed && lease && given.get(serial) !== lease.seat)
				violations.push(
					`I7: a heartbeat of the page's hold ${serial} (given seat ${given.get(serial) ?? "none"}) renewed ${machine.slice(-2)} in ${seating(lease)} at step ${step}`,
				);
			return Response.json(
				renewed ? { schema: SCHEMA, state: "ok", until: until() } : { schema: SCHEMA, state: "ended" },
			);
		}
		if (method === "qorpera_member_hand_back_machine_desktop" && init?.keepalive) {
			log.push(`   the page hands back as it goes: ${machine.slice(-2)}@${epoch}${named}`);
			const answer = db.handBack(MEMBER, machine, epoch, name);
			return Response.json({ schema: SCHEMA, state: "ok", ...answer });
		}
		const kind =
			method === "qorpera_list_agent_machines"
				? "list"
				: method === "qorpera_member_take_machine_desktop"
					? "take"
					: method === "qorpera_member_hand_back_machine_desktop"
						? "back"
						: undefined;
		if (!kind) throw new Error(`Unexpected request ${url}`);
		return held(
			kind,
			machine,
			epoch,
			init,
			undefined,
			kind === "take" ? { press: String(body.p_press) } : kind === "back" ? { name } : {},
		);
	};
	/** A request held until the explorer lets it reach the database and lets its answer come (or be lost). */
	const held = (
		kind: Pending["kind"],
		machine: string,
		epoch: number | undefined,
		init?: RequestInit,
		capture?: Capture,
		extra: { seat?: number; press?: string; name?: HoldName } = {},
	): Promise<Response> => {
		return new Promise<Response>((resolve, reject) => {
			const one: Pending = {
				id: ++ids,
				kind,
				...(kind === "list" ? {} : { machine, epoch }),
				...extra,
				...(capture ? { capture } : {}),
				effect: false,
				settled: false,
				effectAt: step + (kind === "act" ? actLag() : beside(kind) ? 0 : lag()),
				deliverAt: 0,
				resolve,
				reject,
			};
			requests.push(one);
			if (kind === "back") backs.push({ machine, step });
			const named =
				extra.seat !== undefined
					? ` seat ${extra.seat}`
					: extra.name?.seat != null
						? ` seat ${extra.name.seat}`
						: extra.name?.press != null
							? ` press ${extra.name.press.slice(0, 4)}`
							: "";
			log.push(
				`   the page asks: ${kind} #${one.id}${kind === "list" ? "" : ` ${machine.slice(-2)}@${epoch}${named}`}${capture ? ` (${capture.name})` : ""}`,
			);
			if (kind === "take" && epoch !== undefined) {
				takes.push({ id: one.id, machine, epoch, step });
				// I5: only after a press that no release of that machine followed.
				if (pressedAt < 0 || (releasedAt.get(machine) ?? -1) >= pressedAt)
					violations.push(
						`I5: a take-over of ${machine.slice(-2)} at ${epoch} left the page at step ${step}, after a release and with no press since`,
					);
			}
			init?.signal?.addEventListener(
				"abort",
				() => {
					if (one.settled) return;
					one.settled = true;
					reject(new DOMException("The operation was aborted.", "AbortError"));
				},
				{ once: true },
			);
		});
	};
	vi.stubGlobal("fetch", fetch);
	const f = fixture();
	const stop = new AbortController();
	Object.assign(f.cloud.config, { objectGatewayUrl: gateway, memberCompanyGatewayUrl: bridge });
	const computer = new WebCompanyComputer(f.cloud, profileA, userA.id, stop.signal, () => {});
	let hint: ((resource: RealtimeResource) => void) | undefined;
	const decode = async () => ({ width: 1600, height: 1000, close() {} }) as unknown as ImageBitmap;
	const panels = new ComputerPanels(computer, stop.signal, {
		hints: (listener) => {
			hint = listener;
			return () => {
				hint = undefined;
			};
		},
		decode,
	});
	let p: ComputerPanel | undefined;
	let chosen: string | undefined;
	let lastHandBack: Promise<boolean> | undefined;
	const open = () => {
		p = panels.open(staff);
		chosen = undefined;
		if (!p) return;
		// The window's Hand back (its button, the card's I'm done through the panels) is followed while at work.
		const handBack = p.handBack.bind(p);
		p.handBack = () => {
			lastHandBack = finishingOn(handBack());
			return lastHandBack;
		};
		p.attach(document.body, () => panels.close(staff.id));
	};
	open();
	const control = () => {
		const value = p?.el.querySelector<HTMLElement>(".machine-screen-control");
		return value?.hidden ? null : value;
	};
	const button = () => {
		const value = control()?.querySelector<HTMLButtonElement>(".machine-screen-control-button");
		return value && !value.hidden ? value : null;
	};
	const noted = () => p?.el.querySelector(".machine-screen-control-note")?.textContent ?? "";
	/** The machine the window shows: the one it was moved to (ComputerPanel.choose, the tests' own way since the window's
	 * switcher went), else its first (as #pick does), once its list came (the window has a machine then); the window's
	 * own may lag while its loop waits on a request. */
	const shownMachine = (): string | undefined => {
		if (machines.length === 1) return machines[0];
		if (p?.machineId === undefined) return undefined;
		return chosen ?? machines[0];
	};
	const pressed = () => {
		pressedAt = step;
		presses.push({ step, machine: shownMachine() });
		press = { step, outcome: false, finishing: finishing > 0, finishes };
	};
	const check = (): string | undefined => {
		if (violations.length) return violations[0];
		// The page's holds, counted as they begin (review r17), each with the model's seat it was given (F26).
		if (p?.holding && !wasHolding) {
			serial++;
			given.set(serial, seatGiven(shownMachine()));
		}
		wasHolding = p?.holding === true;
		// I8 (review r17): an older hold's action answered; the current hold is as it was.
		if (older) {
			const before = older;
			older = undefined;
			if (before.holding !== (p?.holding === true) || before.note !== noted())
				return `I8: the answer to ${before.name}, an action of an older hold, changed the window (${before.holding ? "held" : "not held"} to ${p?.holding ? "held" : "not held"}; note "${before.note}" to "${noted()}")`;
		}
		// A Hand back pressed on a hold shown from another window comes to a hand-back of that machine, or to the words
		// that it could not be given back yet; never to nothing (review r15 F23).
		for (const one of handBacks)
			if (
				!one.met &&
				(backs.some((back) => back.step >= one.step && (one.machine ?? back.machine) === back.machine) ||
					(control()?.textContent ?? "").includes("could not be ended"))
			)
				one.met = true;
		// F22's counterpart (review r14): the note says nothing of a press that a release followed.
		const note = noted();
		if (note !== lastNote && note !== "" && (lastRelease >= pressedAt || pressedAt < 0))
			return `I4: the window says "${note}" at step ${step}, though a release (step ${lastRelease}) followed the last press (step ${pressedAt})`;
		lastNote = note;
		// I10 (review r19): a machine the page released (a close, a switch away, pagehide, Hand back, I'm done) with no
		// press for it since, once every request the page sent reached the database and was answered or lost, and no
		// hand-back of it is unanswered: no lease that a take-over of the page's seated is live there.
		if (requests.every((one) => one.effect && one.settled))
			for (const machine of machines) {
				const at = releasedAt.get(machine);
				if (at === undefined || presses.some((one) => one.step > at && (one.machine ?? machine) === machine))
					continue;
				if (followed?.releasing(machine) !== undefined) continue;
				const lease = db.seatedByAny(
					machine,
					takes.map((take) => take.id),
				);
				if (lease)
					return `I10: the page released ${machine.slice(-2)} at step ${at}, everything it sent is settled, yet the lease its take-over #${lease.seatedBy} seated (seat ${lease.seat}, epoch ${lease.epoch}) is live at step ${step}`;
			}
		// I3
		for (const take of takes) {
			const past = answeredBack.get(take.machine);
			const lease = db.leases.get(take.machine);
			if (past !== undefined && past > take.epoch && lease?.live && lease.takes.has(take.id))
				return `I3: take-over #${take.id} at ${take.epoch} holds ${take.machine.slice(-2)} after a hand-back answered ${past}`;
		}
		// I1
		for (const done of dones)
			for (const machine of machines) {
				const lease = db.leases.get(machine);
				if (!lease?.live || lease.member !== MEMBER) continue;
				const upTo = done.upTo.get(machine);
				if (
					upTo?.has(lease.seat) ||
					lease.takenStep < done.pressed ||
					[...lease.takes].some((take) => done.sent.has(take))
				)
					return `I1: I'm done answered at step ${done.answered} (seats owed ${[...(upTo ?? [])]}), yet ${machine.slice(-2)} is held by a lease under ${lease.epoch} taken at step ${lease.takenStep}`;
			}
		// I4: what the member sees of a press.
		if (press && !press.outcome) {
			const since = press.step;
			if (
				p?.holding ||
				noted() !== "" ||
				refusedFor.some((one) => one.step >= since) ||
				p?.el.textContent?.includes("is typing privately")
			)
				press.outcome = true;
		}
		return undefined;
	};
	/** The seatings the page owed by I'm done's answer (F26, F27): those shown it after the press, or on a machine it had
	 * released. (What it sent is owed by request: `sent`.) */
	const owed = (pressedStep: number, answered: number) => {
		const seats = new Map<string, Set<number>>();
		for (const one of owedSeen)
			if (one.seat !== null && one.step <= answered && (one.released || one.step > pressedStep))
				seats.set(one.machine, (seats.get(one.machine) ?? new Set()).add(one.seat));
		return seats;
	};
	type Action = { kind: Kind; weight: number; name: string; run: () => boolean | Promise<boolean> };
	const finish = async () => {
		stop.abort();
		panels.dispose();
		await flush(1);
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	};
	try {
		await flush();
		for (step = 1; step <= steps; step++) {
			db.step = step;
			// Action requests reach the database and are answered (or lost) by their own lags, beside the step.
			for (const one of requests.filter((request) => beside(request.kind))) {
				const label =
					one.kind === "act"
						? `${one.machine?.slice(-2)}@${one.epoch} (${one.capture?.name ?? "?"})`
						: `list #${one.id}`;
				if (!one.effect && step >= one.effectAt) {
					effect(one);
					log.push(
						`${step}: ${one.kind === "act" ? "the action " : ""}${label} reaches the database${one.kind === "act" ? `: ${JSON.stringify(one.answer)}` : ""}`,
					);
				} else if (one.effect && !one.settled && step >= one.deliverAt) {
					if (one.kind === "act" && nextAct() < 0.1) {
						one.settled = true;
						one.reject(new TypeError("Failed to fetch"));
						log.push(`${step}: the answer of the action ${label} is lost`);
					} else {
						// I8 (review r17): what an older hold's action answers changes nothing of the window. What the
						// window had still to do settles first, so the answer alone is looked at.
						if (one.kind === "act" && one.capture && (one.capture.serial !== serial || !p?.holding)) {
							await flush();
							older = { holding: p?.holding === true, note: noted(), name: one.capture.name };
						}
						deliver(one);
						log.push(`${step}: the answer of ${one.kind === "act" ? "the action " : ""}${label} comes`);
					}
					await flush();
					const broken = check();
					if (broken) return { log, broken };
				}
			}
			const due = requests.filter(
				(one) => !beside(one.kind) && (one.effect ? !one.settled && step >= one.deliverAt : step >= one.effectAt),
			);
			const every: Action[] = [
				{
					kind: "button",
					weight: 4,
					name: `the window's button (${button()?.textContent ?? "none"})`,
					run: () => {
						// The window's button is Done or Try again alone: nothing in the web begins private typing any more
						// (Jonas, 14 Nov 2026).
						const value = button();
						if (!value || value.disabled) return false;
						release(machines);
						value.click();
						return true;
					},
				},
				{
					kind: "button",
					weight: 2,
					name: "the window's Hand back (a hold from another window)",
					run: () => {
						const value = control()?.querySelector<HTMLButtonElement>(".machine-screen-control-hand-back");
						if (!value || value.hidden || value.disabled) return false;
						const machine = shownMachine();
						// A hand-back of it already on its way counts (the press joins it).
						const entry = {
							step,
							machine,
							met: requests.some(
								(one) => one.kind === "back" && !one.settled && (machine ?? one.machine) === one.machine,
							),
						};
						handBacks.push(entry);
						release(machines);
						lastHandBack = undefined;
						value.click();
						// Confirmed comes to something too: the hold shown was fenced already (its epoch handed back).
						// (the click set it: TypeScript cannot see that)
						const run = lastHandBack as Promise<boolean> | undefined;
						void run?.then((done) => {
							if (done) entry.met = true;
						});
						return true;
					},
				},
				{
					kind: "card",
					weight: 3,
					name: "a private hold begun (the take-over kept for the tests; no button or card has it)",
					run: () => {
						if (!p) open();
						pressed();
						p?.takeOver();
						return true;
					},
				},
				{
					kind: "hand back",
					weight: typing ? 3 : 1,
					name: "Hand back",
					run: () => {
						if (!p) return false;
						release(machines);
						void p.handBack();
						return true;
					},
				},
				{
					kind: "I'm done",
					weight: 2,
					name: "I'm done",
					run: () => {
						release(machines);
						const at = step;
						void finishingOn(panels.releaseAgent(staff.id)).then((done) => {
							if (done)
								dones.push({
									pressed: at,
									answered: step,
									sent: new Set(takes.map((take) => take.id)),
									upTo: owed(at, step),
								});
						});
						return true;
					},
				},
				{
					kind: "close",
					weight: 2,
					name: "close",
					run: () => {
						if (!p) return false;
						release(machines);
						panels.close(staff.id);
						p = undefined;
						return true;
					},
				},
				{
					kind: "reopen",
					weight: 2,
					name: "reopen",
					run: () => {
						if (p) return false;
						open();
						return true;
					},
				},
				{
					kind: "switch",
					weight: 2,
					name: "switch",
					run: () => {
						// No control moves the window any more (Jonas, 14 Nov 2026): the kept method does, at once, as the
						// switcher's menu did.
						const shown = shownMachine();
						if (!p || machines.length < 2 || !shown) return false;
						const other = machines.find((machine) => machine !== shown) as string;
						release([shown]);
						p.choose(other);
						chosen = other;
						return true;
					},
				},
				{
					kind: "pagehide",
					weight: 1,
					name: "pagehide",
					run: () => {
						release(machines);
						window.dispatchEvent(new Event("pagehide"));
						return true;
					},
				},
				{
					kind: "resume",
					weight: 2,
					name: "the page comes back",
					run: () => {
						window.dispatchEvent(new Event("pageshow"));
						document.dispatchEvent(new Event("visibilitychange"));
						return true;
					},
				},
				{
					kind: "hint",
					weight: 2,
					name: "a machines hint",
					run: () => {
						hint?.("machines");
						return true;
					},
				},
				{
					kind: "input",
					weight: typing ? 10 : 2,
					name: `a key on the picture (${KEYS[captures.length % KEYS.length]})`,
					run: () => {
						const canvas = p?.el.querySelector<HTMLCanvasElement>(".machine-screen-canvas");
						const machine = shownMachine();
						// Only while the picture takes input (the page holds the desktop it shows).
						if (!canvas || !p?.holding || !machine || !canvas.hasAttribute("tabindex")) return false;
						const name = KEYS[captures.length % KEYS.length] as string;
						captures.push({ name, step, machine, serial, given: given.get(serial), sent: false });
						key(canvas, name);
						return true;
					},
				},
				{
					kind: "time",
					weight: typing ? 4 : 0,
					name: "a moment passes",
					run: async () => {
						await vi.advanceTimersByTimeAsync(LOOK_EVERY_MS);
						return true;
					},
				},
				{
					kind: "time",
					// Typing schedules come to the hold's heartbeat often, so a lease that ran out, or another tab's take-over, is
					// learned while an action of the hold is still on its way (F26).
					weight: typing ? 3 : 0,
					name: "a minute passes",
					run: async () => {
						await vi.advanceTimersByTimeAsync(KEEP_EVERY_MS);
						return true;
					},
				},
				{
					kind: "time",
					weight: 3,
					name: "time passes",
					run: async () => {
						await vi.advanceTimersByTimeAsync(pick([LOOK_EVERY_MS, KEEP_EVERY_MS, 20_000]));
						return true;
					},
				},
				{
					kind: "tab takes",
					// Typing schedules meet another tab's take-over of the member's own hold often (F26).
					weight: typing ? 3 : 1,
					name: "another tab takes over",
					run: () => {
						const machine = pick(machines);
						db.take(MEMBER, machine, db.epoch(MEMBER, machine), -1);
						return true;
					},
				},
				{
					kind: "tab hands back",
					weight: 1,
					name: "another tab hands back",
					run: () => {
						const machine = pick(machines);
						// Another tab's Hand back on the hold its window shows: by that hold's seat.
						db.handBack(MEMBER, machine, db.epoch(MEMBER, machine), {
							seat: db.leases.get(machine)?.seat ?? null,
						});
						return true;
					},
				},
				{
					kind: "member takes",
					weight: 1,
					name: "another member takes over",
					run: () => {
						const machine = pick(machines);
						db.take(OTHER, machine, db.epoch(OTHER, machine), -1);
						return true;
					},
				},
				{
					kind: "member hands back",
					weight: 1,
					name: "another member hands back",
					run: () => {
						const machine = pick(machines);
						db.handBack(OTHER, machine, db.epoch(OTHER, machine), { seat: db.leases.get(machine)?.seat ?? null });
						return true;
					},
				},
				{
					kind: "lease runs out",
					// Typing schedules meet a lease that ran out and was taken again often (F26).
					weight: typing ? 3 : 1,
					name: "a lease runs out",
					run: () => {
						db.expire(pick(machines));
						return true;
					},
				},
			];
			const actions = every.filter((action) => action.weight > 0 && !off.has(action.kind));
			if (due.length) {
				const one = pick(due);
				const label = `${one.kind} #${one.id}${one.machine ? ` ${one.machine.slice(-2)}@${one.epoch}` : ""}`;
				if (!one.effect)
					actions.push({
						kind: "request",
						weight: 8,
						name: `reaches the database: ${label}`,
						run: () => {
							effect(one);
							return true;
						},
					});
				else
					actions.push({
						kind: "request",
						weight: 8,
						name: `answer delivered: ${label}`,
						run: () => {
							deliver(one);
							return true;
						},
					});
				if (!one.settled && !off.has("answer lost"))
					actions.push({
						kind: "answer lost",
						weight: 2,
						name: `answer lost: ${label}`,
						run: () => {
							one.settled = true;
							one.reject(new TypeError("Failed to fetch"));
							return true;
						},
					});
			}
			const total = actions.reduce((sum, action) => sum + action.weight, 0);
			let roll = next() * total;
			let action = actions.at(-1) as Action;
			for (const one of actions) {
				roll -= one.weight;
				if (roll < 0) {
					action = one;
					break;
				}
			}
			if (!(await action.run())) continue;
			log.push(`${step}: ${action.name}`);
			await flush();
			log.push(
				`   (shows ${shownMachine()?.slice(-2) ?? "nothing yet"}${p?.holding ? ", held" : ""}${p?.el.querySelector(".machine-screen-canvas")?.hasAttribute("tabindex") ? ", takes input" : ""}${noted() ? `, says "${noted()}"` : ""})`,
			);
			const broken = check();
			if (broken) return { log, broken };
		}
		// The last stretch: another member's holds end, and every request reaches the database and is answered, while time
		// passes; a press that no release followed must have come to something by then.
		log.push("then: everything is answered");
		for (const machine of machines) if (db.leases.get(machine)?.member === OTHER) db.expire(machine);
		for (let round = 0; round < 10; round++) {
			step++;
			log.push(
				`then ${round + 1}: everything answered${p?.holding ? ", held" : ""}${noted() ? `, "${noted()}"` : ""}`,
			);
			for (const one of requests.filter((request) => !request.effect)) effect(one);
			for (const one of requests.filter((request) => !request.settled)) deliver(one);
			hint?.("machines");
			await flush(4);
			// Short enough that what was asked is answered before its own deadline.
			await vi.advanceTimersByTimeAsync(3000);
			await flush(2);
			const broken = check();
			if (broken) return { log, broken };
		}
		// I9 (review r17): what was typed under the hold that still stands, with no release since, left the page.
		if (p?.holding) {
			const lost = captures.find(
				(one) => one.serial === serial && !one.sent && (releasedAt.get(one.machine) ?? -1) < one.step,
			);
			if (lost)
				return {
					log,
					broken: `I9: ${lost.name}, pressed at step ${lost.step} under the hold that still stands, never left the page`,
				};
		}
		const unmet = handBacks.find((one) => !one.met);
		if (unmet)
			return {
				log,
				broken: `I4: the window's Hand back at step ${unmet.step}, on a hold shown from another window, came to nothing`,
			};
		if (press && !press.outcome && !press.finishing && press.finishes === finishes)
			return {
				log,
				broken: `I4: the press at step ${press.step}, which no release followed, came to nothing (take-overs since: ${takes
					.filter((take) => take.step >= (press?.step ?? 0))
					.map((take) => `${take.machine.slice(-2)}@${take.epoch}`)
					.join(
						", ",
					)}; shown ${shownMachine()?.slice(-2)}; button ${button()?.textContent}; ${p ? "open" : "closed"})`,
			};
		return { log };
	} finally {
		await finish();
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	document.body.replaceChildren();
});

/** Typing seeds (explore's `typing`) that broke the window of ac5d378fc (release review r1 of #1667: F25) or a model
 * without SQL's action epoch (F24), with the typing steps of review r17; and the window and SQL of 2ac5b3591 (review r18:
 * F26, the hold named by its epoch alone), with the steps as they are now. They run first; each holds now. */
const FOUND_TYPING: readonly { seed: number; finding: string }[] = [
	{
		seed: 1479,
		finding:
			"F26 (2ac5b3591, I7): a key went under the page's hold in seat 1; the lease ran out, the heartbeat said so, and the same page took the desktop over again at the same epoch (seat 2); the key then ran in seat 2",
	},
	{
		seed: 667,
		finding:
			"F26 (2ac5b3591, I7): a key went under the page's hold in seat 2; the lease ran out, and a late take-over of the page's from long before seated anew at the same epoch (seat 3); the key then ran in seat 3",
	},
	{
		seed: 4023,
		finding:
			"F26 (2ac5b3591, I7): the lease ran out and another tab of the member's took the desktop at the same epoch (a new lease, seat 4); a key the page sent under seat 3 ran in it",
	},
	{
		seed: 1548,
		finding:
			"F26 (2ac5b3591, I7): another tab of the member's took their live lease over at the same epoch (seat 2); a key the page then sent under seat 1 ran in it",
	},
	{
		seed: 294,
		finding:
			"F26 (2ac5b3591, I7): another tab of the member's took their live lease over at the same epoch (seat 2); the page's heartbeat of seat 1 renewed it",
	},
	{
		seed: 15811,
		finding:
			"F25 (ac5d378fc, I8): an action of a hold that had ended answered DESKTOP_CONTROL_ENDED after the same machine was taken over again; the window ended the new hold for it (and the new hold's typing had waited behind it)",
	},
	{
		seed: 1406,
		finding:
			"F24 (I7, with the model's action epoch taken out, as SQL had it): a key captured under the hold taken at 0 ran under the lease taken at 2",
	},
];

/** Seeds that broke an earlier window of this PR, each on the window and ledger of the commit named (review r13;
 * lanes/desktop-computers-20261110/TAKE-OVER-PROGRESS.md; F27 and F28 over a model with that commit's SQL). They run
 * first; each holds on this window. */
const FOUND: readonly { seed: number; finding: string }[] = [
	{
		seed: 397,
		finding:
			"F27 (7a40f8242, I10): another tab took the desktop at epoch 0 while the window's take-over at 0 was on its way; the window closed and its hand-back named that take-over's press, which ended nothing and left the epoch at 0; the take-over then arrived and seated the member over the other tab's hold, its window gone",
	},
	{
		seed: 87,
		finding: "F27 (7a40f8242, I10): the same at epoch 1, after an earlier hand-back's lost answer was asked again",
	},
	{
		seed: 1739,
		finding:
			"F28 (7a40f8242, I10): take-over #8's answer was lost, the next press sent take-over #10 at the same epoch, and the close named #10's press only; the lease #8 had seated stayed live after the window closed",
	},
	{
		seed: 759,
		finding: "F28 (7a40f8242, I10): the same, with a switch between, and the hand-back named the later press only",
	},
	{
		seed: 6014,
		finding:
			"F23 (6cc57c999, I4): Hand back on a hold shown from another window owed nothing, so no hand-back went; its list read failed, and nothing more came of it",
	},
	{
		seed: 1592,
		finding:
			"F21 (9f7a4af31, I6): the window's first list was on its way while another tab took the desktop; pagehide; the list came and the window took that hold up and renewed it, with no press",
	},
	{
		seed: 1815,
		finding:
			"9f7a4af31 and earlier (I6): the window took up another tab's hold a list showed and sent input, with no press on this page at all",
	},
	{
		seed: 271,
		finding:
			"F22 (9f7a4af31, I4): Take over queued behind a hand-back, then Hand back called it off; the hand-back timed out and the window said the take-over could not be done",
	},
	{
		seed: 7,
		finding:
			"F20 (0278e6e4d, I5): after pagehide the loop replaced the take-over the ledger had called off and sent a new one, for a press made before the release",
	},
	{
		seed: 275,
		finding:
			"0278e6e4d and earlier (I5): a press made before the first list read stood through pagehide; when the list came, the take-over was sent",
	},
	{
		seed: 1548,
		finding:
			"F19's kind (2face94a1, I4): presses after pagehide were skipped while the called-off take-over was on its way, and its answer cleared them",
	},
	{
		seed: 1403,
		finding:
			"F18 (8e68f4dcd, I4): another tab gave the machine back first; the TAKE_CALLED_OFF came back as called off, and nothing was said",
	},
	{
		seed: 218,
		finding:
			"r10's given-back gap (10e81245b, I6): after pagehide with nothing owed, the window took up another tab's hold and sent input",
	},
	{
		seed: 512,
		finding:
			"0278e6e4d and earlier (I4): a take-over not sent because the earlier hand-back was still unanswered ('releasing') was said to no one",
	},
];

describe("the computer window's take-overs, explored", () => {
	it("keeps I1, I3, I4, I5 and I6 over seeded schedules driven through the real window", async () => {
		const seeds = [...FOUND.map((found) => found.seed), ...Array.from({ length: 200 }, (_, n) => n + 1)];
		const unfollow = followLedger();
		try {
			for (const seed of seeds) {
				vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
				const { log, broken } = await explore(seed, 30);
				if (broken) {
					const found = FOUND.find((one) => one.seed === seed);
					expect.fail(
						`seed ${seed}: ${broken}${found ? `\n(found earlier: ${found.finding})` : ""}\n${log.join("\n")}`,
					);
				}
			}
		} finally {
			unfollow();
		}
	}, 60_000);

	it("keeps them all, I7 to I9 above all, over schedules that type on the picture across hand-backs and take-overs", async () => {
		const seeds = [...FOUND_TYPING.map((found) => found.seed), ...Array.from({ length: 100 }, (_, n) => n + 1)];
		const unfollow = followLedger();
		try {
			for (const seed of seeds) {
				vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
				const { log, broken } = await explore(seed, 40, true);
				if (broken) {
					const found = FOUND_TYPING.find((one) => one.seed === seed);
					expect.fail(
						`typing seed ${seed}: ${broken}${found ? `\n(found earlier: ${found.finding})` : ""}\n${log.join("\n")}`,
					);
				}
			}
		} finally {
			unfollow();
		}
	}, 60_000);
});
