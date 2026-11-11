// @vitest-environment jsdom

import type { MemberAgentMachine } from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComputerPanel, ComputerPanels, KEEP_EVERY_MS, LOOK_EVERY_MS } from "../src/app/views/computer.ts";
import { DesktopHoldLedger } from "../src/app/views/desktop-holds.ts";
import { WebCompanyComputer } from "../src/cloud/computer.ts";
import type { RealtimeResource } from "../src/cloud/realtime.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { fixture, id, profileA, settle, staff, userA } from "./fixtures.ts";
import { Database, random } from "./take-over-model.ts";

/* Schedules explored through the real window (review r13 of #1661): a company's ComputerPanels and the agent's
 * ComputerPanel, driven as a member does (the window's button, the take-over card's Take over, Hand back, I'm done,
 * close, reopen, a switch of machine, pagehide, the page coming back, a list hint, input, time passing), over the
 * database model of desktop-holds-explorer.test.ts (take-over-model.ts). Another tab of the member and another member
 * act on the database too. Every list, take-over and hand-back request is held: its effect on the database and its
 * answer's delivery (or loss) are separate steps; looks, heartbeats and actions are answered at once. Each seed picks
 * its shape (one machine or two, some kinds of step left out) and holds some requests back several steps. After every
 * step, and after a last stretch that answers everything:
 * (I1) once an I'm done answered true, no lease of the member's holds the desktop that was taken before it was pressed,
 * by a take-over the page sent before it answered, or under an epoch at or below one the page owed then (a take-over
 * sent, a hold renewed, an own hold a list showed it after the press or on a machine it had released);
 * (I3) no take-over the page sent holds the desktop after a hand-back answer past its epoch reached the page;
 * (I4) a press of Take over that no release followed comes to something the member sees: the hold, the window's "could
 * not be taken over", a refusal for another member's hold, or the window showing that member;
 * (I5) a take-over request leaves the page only after a press that no release of that machine (Hand back, I'm done,
 * close, a switch away, pagehide) followed;
 * (I6) after a release of a machine, no heartbeat and no input for it leaves the page until such a press.
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
	kind: "list" | "take" | "back";
	machine?: string;
	epoch?: number;
	answer?: unknown;
	effect: boolean;
	settled: boolean;
	effectAt: number;
	deliverAt: number;
	resolve: (value: Response) => void;
	reject: (error: unknown) => void;
}

interface Done {
	pressed: number;
	answered: number;
	sent: Set<number>;
	upTo: Map<string, number>;
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

/** Where the ledger's calls are written down, for the steps printed. */
let ledgerLog: string[] = [];
/** The ledger's take-overs and releases, as the window asks them, written into the steps printed. */
function followLedger() {
	const take = DesktopHoldLedger.prototype.take;
	vi.spyOn(DesktopHoldLedger.prototype, "take").mockImplementation(function (this: DesktopHoldLedger, ...args) {
		const answer = take.apply(this, args);
		const [machine, , pressedAt] = args;
		void answer.then((value) =>
			ledgerLog.push(
				`   the ledger's take-over of ${machine.slice(-2)} (press ${pressedAt}) answers ${value.state}`,
			),
		);
		return answer;
	});
	const release = DesktopHoldLedger.prototype.release;
	vi.spyOn(DesktopHoldLedger.prototype, "release").mockImplementation(function (this: DesktopHoldLedger, ...args) {
		ledgerLog.push(`   the ledger releases ${args[0].slice(-2)}`);
		return release.apply(this, args);
	});
}

async function explore(seed: number, steps: number): Promise<{ log: string[]; broken?: string }> {
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	const machines: readonly string[] = next() < 0.4 ? [MACHINES[0]] : MACHINES;
	const off = new Set<Kind>(OPTIONAL.filter(() => next() < 1 / 3));
	const lag = () => (next() < 0.3 ? 2 + Math.floor(next() * 10) : 0);
	const db = new Database(machines);
	const log: string[] = [`${machines.length} machine(s), without: ${[...off].join(", ") || "none"}`];
	ledgerLog = log;
	const requests: Pending[] = [];
	let ids = 0;
	let step = 0;
	/** What the page sent: take-overs (id, machine, epoch, step), heartbeats and actions (machine, step). */
	const takes: { id: number; machine: string; epoch: number; step: number }[] = [];
	const used: { machine: string; step: number; what: string }[] = [];
	const owedSeen: { machine: string; epoch: number; step: number; released: boolean }[] = [];
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
	const release = (which: readonly string[]) => {
		for (const machine of which) releasedAt.set(machine, step);
		press = undefined;
	};
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
					? { mine, name: mine ? "Owner" : "Ada", until: until(), epoch: mine ? lease.epoch : null }
					: null,
				epoch: db.epoch(MEMBER, machineId),
			};
		});
	const effect = (one: Pending) => {
		one.effect = true;
		one.deliverAt = step + lag();
		if (one.kind === "list") one.answer = rows();
		else if (one.kind === "take") {
			const answer = db.take(MEMBER, one.machine as string, one.epoch as number, one.id);
			one.answer = answer.state === "ok" ? { state: "ok", until: until() } : answer;
		} else one.answer = db.handBack(MEMBER, one.machine as string, one.epoch as number);
	};
	const deliver = (one: Pending) => {
		one.settled = true;
		if (one.kind === "list") {
			const listed = one.answer as MemberAgentMachine[];
			for (const row of listed)
				if (row.control?.mine && row.control.epoch !== null)
					owedSeen.push({
						machine: row.machineId,
						epoch: row.control.epoch,
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
			const answer = one.answer as { epoch: number; holding: boolean };
			const machine = one.machine as string;
			answeredBack.set(machine, Math.max(answeredBack.get(machine) ?? -1, answer.epoch));
			if (answer.holding)
				owedSeen.push({
					machine,
					epoch: answer.epoch,
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
				used.push({ machine, step, what: "input" });
				return Response.json({ schema: "qorpera.member-machine-act/v1", exitCode: 0 });
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
		if (method === "qorpera_member_keep_machine_desktop") {
			used.push({ machine, step, what: "heartbeat" });
			log.push(`   the page renews ${machine.slice(-2)}@${epoch}`);
			return Response.json(
				db.keep(MEMBER, machine, epoch)
					? { schema: SCHEMA, state: "ok", until: until() }
					: { schema: SCHEMA, state: "ended" },
			);
		}
		if (method === "qorpera_member_hand_back_machine_desktop" && init?.keepalive) {
			log.push(`   the page hands back as it goes: ${machine.slice(-2)}@${epoch}`);
			const answer = db.handBack(MEMBER, machine, epoch);
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
		return new Promise<Response>((resolve, reject) => {
			const one: Pending = {
				id: ++ids,
				kind,
				...(kind === "list" ? {} : { machine, epoch }),
				effect: false,
				settled: false,
				effectAt: step + lag(),
				deliverAt: 0,
				resolve,
				reject,
			};
			requests.push(one);
			log.push(`   the page asks: ${kind} #${one.id}${kind === "list" ? "" : ` ${machine.slice(-2)}@${epoch}`}`);
			if (kind === "take") {
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
	const open = () => {
		p = panels.open(staff);
		if (!p) return;
		// The window's Hand back (its button, the card's I'm done through the panels) is followed while at work.
		const handBack = p.handBack.bind(p);
		p.handBack = () => finishingOn(handBack());
		p.attach(document.body, () => panels.close(staff.id));
	};
	open();
	const control = () => {
		const value = p?.el.querySelector<HTMLElement>(".machine-screen-control");
		return value?.hidden ? null : value;
	};
	const button = () => control()?.querySelector<HTMLButtonElement>(".machine-screen-control-button") ?? null;
	const noted = () => p?.el.querySelector(".machine-screen-control-note")?.textContent ?? "";
	const shownMachine = (): string | undefined => {
		const switcher = p?.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher");
		if (switcher && !switcher.hidden) return machines[Number(switcher.textContent?.slice(5)) - 1];
		return machines.length === 1 ? machines[0] : undefined;
	};
	const pressed = () => {
		pressedAt = step;
		press = { step, outcome: false, finishing: finishing > 0, finishes };
	};
	const check = (): string | undefined => {
		if (violations.length) return violations[0];
		// I6
		for (const one of used) {
			const at = releasedAt.get(one.machine);
			if (at !== undefined && at >= pressedAt && one.step > at)
				return `I6: a ${one.what} for ${one.machine.slice(-2)} left the page at step ${one.step}, after its release at step ${at} and no press since`;
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
					(upTo !== undefined && lease.epoch <= upTo) ||
					lease.takenStep < done.pressed ||
					[...lease.takes].some((take) => done.sent.has(take))
				)
					return `I1: I'm done answered at step ${done.answered} (up to ${upTo}), yet ${machine.slice(-2)} is held by a lease under ${lease.epoch} taken at step ${lease.takenStep}`;
			}
		// I4: what the member sees of a press.
		if (press && !press.outcome) {
			const since = press.step;
			if (
				p?.holding ||
				noted() !== "" ||
				refusedFor.some((one) => one.step >= since) ||
				p?.el.textContent?.includes("is using the computer")
			)
				press.outcome = true;
		}
		return undefined;
	};
	const owed = (pressedStep: number, answered: number) => {
		const upTo = new Map<string, number>();
		const raise = (machine: string, epoch: number) => upTo.set(machine, Math.max(upTo.get(machine) ?? -1, epoch));
		for (const take of takes) if (take.step <= answered) raise(take.machine, take.epoch);
		for (const one of owedSeen)
			if (one.step <= answered && (one.released || one.step > pressedStep)) raise(one.machine, one.epoch);
		return upTo;
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
			const due = requests.filter((one) =>
				one.effect ? !one.settled && step >= one.deliverAt : step >= one.effectAt,
			);
			const every: Action[] = [
				{
					kind: "button",
					weight: 4,
					name: `the window's button (${button()?.textContent ?? "none"})`,
					run: () => {
						const value = button();
						if (!value || value.disabled) return false;
						if (value.textContent === "Take over") pressed();
						else release(machines);
						value.click();
						return true;
					},
				},
				{
					kind: "card",
					weight: 3,
					name: "the card's Take over",
					run: () => {
						if (!p) open();
						pressed();
						p?.takeOver();
						return true;
					},
				},
				{
					kind: "hand back",
					weight: 1,
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
						const switcher = p?.el.querySelector<HTMLButtonElement>(":scope > .computer-switcher");
						const shown = shownMachine();
						if (!p || !switcher || switcher.hidden || machines.length < 2 || !shown) return false;
						const other = machines.find((machine) => machine !== shown) as string;
						switcher.click();
						const items = [...(openMenu()?.el.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
						const item = items[machines.indexOf(other)];
						if (!item) return false;
						release([shown]);
						item.click();
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
					weight: 2,
					name: "a key on the picture",
					run: () => {
						const canvas = p?.el.querySelector<HTMLCanvasElement>(".machine-screen-canvas");
						if (!canvas || !p?.holding) return false;
						key(canvas, "Enter");
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
					weight: 1,
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
						db.handBack(MEMBER, machine, db.epoch(MEMBER, machine));
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
						db.handBack(OTHER, machine, db.epoch(OTHER, machine));
						return true;
					},
				},
				{
					kind: "lease runs out",
					weight: 1,
					name: "a lease runs out",
					run: () => {
						db.expire(pick(machines));
						return true;
					},
				},
			];
			const actions = every.filter((action) => !off.has(action.kind));
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

/** Seeds that broke an earlier window of this PR, each on the window and ledger of the commit named (review r13;
 * lanes/desktop-computers-20261110/TAKE-OVER-PROGRESS.md). They run first; each holds on this window. */
const FOUND: readonly { seed: number; finding: string }[] = [
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
		followLedger();
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
	}, 60_000);
});
