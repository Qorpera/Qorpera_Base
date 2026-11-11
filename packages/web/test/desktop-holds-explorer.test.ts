import type {
	MemberAgentMachines,
	MemberDesktopHandBack,
	MemberDesktopHold,
} from "@qorpera/cloud-client/cloud-member-company-computer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopHoldLedger } from "../src/app/views/desktop-holds.ts";
import type { WebCompanyComputer } from "../src/cloud/computer.ts";
import { Database, type HoldName, random } from "./take-over-model.ts";

/* Schedules explored (review r10 of #1661): the ledger of desktop holds, as the window drives it, against a model of
 * the database's take-over rules (migration 20260930713000: one hand-back epoch per member and machine, a lease taken
 * under it, a seat for every seating and a hand-back that names its hold (F26), take / keep / hand-back / list exactly as
 * SQL answers them). Two pages of one member, another tab of theirs
 * and another member act on two machines of one agent; every request's effect on the database and its answer's delivery
 * (or loss) are separate steps. A seeded generator picks the steps; after every step three invariants are checked. Each
 * seed also picks its shape (one page or two, one machine or two, some kinds of step left out: swarm testing) and holds
 * some requests back for several steps before they reach the database or their answers come, so that deep orderings
 * are drawn often:
 * (I1) once an I'm done answered, no lease of the member on the agent's machines holds the desktop in a seat the page
 * was shown on a machine it had given back or after I'm done was pressed (a hold of another tab's that the page saw
 * before, and never owed, may end by itself; since review r19 what is owed is the seating, not the epoch: an EXACT
 * hand-back discharges a seat without moving the epoch); nor one taken before it was pressed, nor by a take-over the
 * page sent.
 * (I2) a page sends no input and no heartbeat for a machine after its release was asked (Hand back, I'm done and a close
 * ask all the agent's machines back), until a new take-over on purpose. (I3) no take-over a page sent holds the desktop
 * after a hand-back answer past its epoch reached that page. (I4, review r11) a take-over the page did not call off (no
 * release of that machine asked since the press) is never answered "called off", and after a TAKE_CALLED_OFF named an
 * epoch no take-over of that machine goes out below it; the ledger's calledOff, by which a window joins a press to a
 * take-over on its way (review r12), agrees with each answer. (I10, review r19) once a page released a machine (with no
 * take-over of it on purpose since), every request it sent reached the database and was answered or lost, and no
 * hand-back of it is unanswered, no lease that a take-over of that page's seated is live there. (I11, review r19) a page
 * that knows the end of every take-over it sent for a machine at an epoch hands it back EXACT, never VOID (a VOID asked
 * again until answered is the same hand-back). A failure
 * prints the seed, its shape and its steps. */

const MEMBER = "member";
const OTHER = "other";
const AGENT = "agent";
const MACHINES = ["11111111-1111-4111-8111-000000000041", "11111111-1111-4111-8111-000000000042"] as const;
type Machine = (typeof MACHINES)[number];

interface Request {
	id: number;
	page: number;
	kind: "take" | "back" | "list";
	machine?: Machine;
	epoch?: number;
	/** A take-over's press id, and the hold a hand-back names (F26, F27: a seat, or none for VOID). */
	press?: string;
	name?: HoldName;
	/** Its answer reached the page (not lost, not cut off): a take-over the page knows the end of (F27, F28). */
	delivered?: number;
	/** The database's answer, once its effect happened. */
	answer?: unknown;
	/** A read of the window's own (what it shows reaches the ledger only while the window is open). */
	window: boolean;
	effect: boolean;
	settled: boolean;
	/** The steps before which it does not reach the database, and its answer does not come. */
	effectAt: number;
	deliverAt: number;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface Done {
	page: number;
	pressed: number;
	answered: number;
	/** The take-over requests the page had sent when it answered. */
	sent: Set<number>;
	/** Per machine, the highest epoch the page owed by its answer: one it had sent a take-over under, or taken up a hold
	 * under, or been shown a hold of the member's under on a machine it had given back or after I'm done was pressed. */
	upTo: Map<Machine, Set<number>>;
}

/** What a page sent or was shown of the member's holds: a take-over it sent, a hold its window took up, or a hold a
 * list or a hand-back answer showed its ledger (and whether the page had given that machine back by then). */
interface Seen {
	step: number;
	machine: Machine;
	epoch: number;
	why: "sent" | "shown";
	/** The seat a hold was shown in (F26): what the page owes is that seating, not the epoch (F27, R5). */
	seat?: number;
	released: boolean;
}

interface Page {
	ledger: DesktopHoldLedger;
	stop: AbortController;
	open: boolean;
	/** Which window is open (a read of an earlier one's comes to nothing). */
	window: number;
	selected: Machine;
	/** Machines whose release this page asked, since its last take-over of each on purpose: Hand back, I'm done and a
	 * close ask all the agent's machines back; a switch those the page knows of but the one chosen. */
	released: Set<Machine>;
	/** Machines this page's ledger knows of: in a list it was given, or taken over. */
	known: Set<Machine>;
	sent: { id: number; machine: Machine; epoch: number }[];
	/** The highest epoch a hand-back answer for each machine reached this page with. */
	answered: Map<Machine, number>;
	/** How many releases of each machine this page asked: a take-over answered "called off" must follow one. */
	releases: Map<Machine, number>;
	/** The highest epoch a TAKE_CALLED_OFF named to this page for each machine: no later take-over goes out below it. */
	floor: Map<Machine, number>;
	/** I4 breaches seen as answers came. */
	silent: string[];
	/** Hand back and I'm done of this page's at work now, and how many began: their later rounds give back too. */
	finishing: number;
	finishes: number;
	seen: Seen[];
}

/** The kinds of step a seed may leave out (swarm testing); the others are always there. */
const OPTIONAL = [
	"hand back",
	"switch",
	"window read",
	"input",
	"time",
	"tab takes",
	"tab hands back",
	"member takes",
	"member hands back",
	"lease runs out",
	"answer lost",
] as const;
type Kind = (typeof OPTIONAL)[number] | "take over" | "I'm done" | "close" | "reopen";

/** What a request's answer said, for the steps printed. */
function told(one: Request): string {
	if (one.kind === "take") {
		const answer = one.answer as MemberDesktopHold;
		return answer.state === "ok" ? `ok, seat ${answer.seat}` : `${answer.reason}, epoch ${answer.epoch}`;
	}
	if (one.kind === "back") {
		const answer = one.answer as MemberDesktopHandBack;
		return `epoch ${answer.epoch}${answer.handedBack ? ", handed back" : ""}${answer.holding ? `, holding in seat ${answer.seat}` : ""}`;
	}
	return (one.answer as MemberAgentMachines).machines
		.map(
			(row) =>
				`${row.machineId.slice(-2)} epoch ${row.epoch}${row.control ? (row.control.mine ? ` mine at ${row.control.epoch} seat ${row.control.seat}` : " theirs") : ""}`,
		)
		.join("; ");
}

/** One explored schedule: the steps taken, and the first invariant broken, if any. */
async function explore(seed: number, steps: number): Promise<{ log: string[]; broken?: string }> {
	const next = random(seed);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
	// The seed's shape.
	const pageCount = next() < 0.4 ? 1 : 2;
	const machines: readonly Machine[] = next() < 0.4 ? [MACHINES[0]] : MACHINES;
	const off = new Set<Kind>(OPTIONAL.filter(() => next() < 1 / 3));
	/** A request held back for several steps, now and then. */
	const lag = () => (next() < 0.3 ? 2 + Math.floor(next() * 12) : 0);
	const db = new Database(machines);
	const requests: Request[] = [];
	const dones: Done[] = [];
	const log: string[] = [
		`${pageCount} page(s), ${machines.length} machine(s), without: ${[...off].join(", ") || "none"}`,
	];
	let ids = 0;
	const raise = (page: Page, machine: Machine, epoch: number, why: Seen["why"], seat?: number) =>
		page.seen.push({
			step: db.step,
			machine,
			epoch,
			why,
			released: page.released.has(machine),
			...(seat !== undefined ? { seat } : {}),
		});
	const shown = (page: Page, list: MemberAgentMachines) => {
		for (const row of list.machines)
			if (row.control?.mine && row.control.epoch !== null)
				raise(page, row.machineId as Machine, row.control.epoch, "shown", row.control.seat ?? undefined);
	};
	/** The seatings a page owed by its I'm done's answer (F26, F27): those shown it after the press, or on a machine it
	 * had given back. (What it sent is owed by request: `sent`.) */
	const owed = (page: Page, pressed: number) => {
		const seats = new Map<Machine, Set<number>>();
		for (const one of page.seen)
			if (one.why === "shown" && one.seat !== undefined && (one.released || one.step > pressed))
				seats.set(one.machine, (seats.get(one.machine) ?? new Set()).add(one.seat));
		return seats;
	};
	const flush = async () => {
		for (let n = 0; n < 30; n++) await Promise.resolve();
	};
	const request = (
		page: number,
		kind: Request["kind"],
		machine?: Machine,
		epoch?: number,
		window = false,
		extra: { press?: string; name?: HoldName } = {},
	) =>
		new Promise<unknown>((resolve, reject) => {
			requests.push({
				id: ++ids,
				page,
				kind,
				machine,
				epoch,
				...extra,
				window,
				effect: false,
				settled: false,
				effectAt: db.step + lag(),
				deliverAt: 0,
				resolve,
				reject,
			});
			const one = pages[page] as Page;
			if (kind === "take") {
				const floor = one.floor.get(machine as Machine);
				if (floor !== undefined && (epoch as number) < floor)
					one.silent.push(
						`p${page}'s take-over of ${machine?.slice(-2)} went out at ${epoch}, below the ${floor} a refusal named`,
					);
				one.sent.push({ id: ids, machine: machine as Machine, epoch: epoch as number });
				one.known.add(machine as Machine);
				raise(one, machine as Machine, epoch as number, "sent");
			}
		});
	const pages: Page[] = [];
	/** I11 (F27, F28), as a hand-back leaves a page: one that knows the end of every take-over it sent for the machine at
	 * that epoch is EXACT (it names a seat), never VOID, so it ends no hold but the seat it names. */
	const certain = (index: number, machine: Machine, epoch: number, seat: number | null) => {
		const known = requests.every(
			(one) =>
				one.page !== index ||
				one.kind !== "take" ||
				one.machine !== machine ||
				one.epoch !== epoch ||
				// Delivered at an earlier step: the page has read it by now.
				(one.delivered !== undefined && one.delivered < db.step),
		);
		// A VOID asked again (its call was VOID while a take-over was unanswered, and stays VOID until answered: its answer is
		// what fences an earlier copy of it) is not a new decision.
		const again = requests.some(
			(one) =>
				one.page === index &&
				one.kind === "back" &&
				one.machine === machine &&
				one.epoch === epoch &&
				one.name?.seat === null &&
				one.delivered === undefined,
		);
		if (known && !again && seat === null)
			(pages[index] as Page).silent.push(
				`I11: p${index} sent VOID for ${machine.slice(-2)} at ${epoch}, though every take-over it sent there was answered`,
			);
	};
	for (let index = 0; index < pageCount; index++) {
		const stop = new AbortController();
		const computer = {
			takeDesktop: (machine: string, epoch: number, press: string) =>
				request(index, "take", machine as Machine, epoch, false, { press }),
			handBackDesktop: (machine: string, _reason: string, epoch: number, seat: number | null) => {
				certain(index, machine as Machine, epoch, seat);
				return request(index, "back", machine as Machine, epoch, false, { name: { seat } });
			},
			agentMachines: () => request(index, "list"),
			// The keepalive as the page goes: best effort, its effect at once, nothing answered.
			handBackOnLeave: (machine: string, epoch: number, seat: number | null) => {
				certain(index, machine as Machine, epoch, seat);
				db.handBack(MEMBER, machine as Machine, epoch, { seat });
			},
		};
		pages.push({
			ledger: new DesktopHoldLedger(computer as unknown as WebCompanyComputer, stop.signal),
			stop,
			open: true,
			window: 0,
			selected: MACHINES[0],
			released: new Set(),
			known: new Set(),
			sent: [],
			answered: new Map(),
			releases: new Map(),
			floor: new Map(),
			silent: [],
			finishing: 0,
			finishes: 0,
			seen: [],
		});
	}
	const effect = (one: Request) => {
		one.effect = true;
		one.deliverAt = db.step + lag();
		if (one.kind === "take")
			one.answer = db.take(MEMBER, one.machine as Machine, one.epoch as number, one.id, one.press);
		else if (one.kind === "back")
			one.answer = db.handBack(MEMBER, one.machine as Machine, one.epoch as number, one.name);
		else one.answer = db.list(MEMBER);
	};
	const deliver = (one: Request) => {
		one.settled = true;
		one.delivered = db.step;
		const page = pages[one.page] as Page;
		if (one.kind === "take") {
			const answer = one.answer as MemberDesktopHold;
			const machine = one.machine as Machine;
			if (answer.state === "refused" && answer.reason === "TAKE_CALLED_OFF" && answer.epoch !== null)
				page.floor.set(machine, Math.max(page.floor.get(machine) ?? -1, answer.epoch));
		}
		if (one.kind === "back") {
			const answer = one.answer as MemberDesktopHandBack;
			const machine = one.machine as Machine;
			page.answered.set(machine, Math.max(page.answered.get(machine) ?? -1, answer.epoch));
			// Holding: the member's lease, which can only be under the epoch the answer names.
			if (answer.holding) raise(page, machine, answer.epoch, "shown", answer.seat ?? undefined);
		}
		if (one.kind === "list" && !one.window) {
			for (const machine of machines) page.known.add(machine);
			shown(page, one.answer as MemberAgentMachines);
		}
		one.resolve(one.answer);
	};
	// The window's own list read: what it shows, then a hold of the member's on the machine shown taken up.
	const windowRead = (index: number) => {
		const page = pages[index] as Page;
		const window = page.window;
		void request(index, "list", undefined, undefined, true).then(
			(list) => {
				if (!page.open || page.window !== window) return;
				for (const machine of machines) page.known.add(machine);
				shown(page, list as MemberAgentMachines);
				// The window takes nothing up from a list (review r14): it only tells the ledger.
				page.ledger.listed(list as MemberAgentMachines, AGENT);
			},
			() => undefined,
		);
	};
	/** The page asks this machine back (the explorer's own account, for I2 and I4). */
	const letGo = (page: Page, machine: Machine) => {
		page.released.add(machine);
		page.releases.set(machine, (page.releases.get(machine) ?? 0) + 1);
	};
	const check = (): string | undefined => {
		for (const [index, page] of pages.entries()) {
			// I4 (and I11, noted as hand-backs leave the page)
			if (page.silent.length) return page.silent[0]?.startsWith("I11") ? page.silent[0] : `I4: ${page.silent[0]}`;
			// I10 (F27, F28): a machine this page released, with no take-over of it on purpose since, once every request of
			// the page's reached the database and its answer came or was lost, and no hand-back of it is unanswered: no
			// lease seated by a take-over of this page's is live there.
			const settledAll = requests.every((one) => one.page !== index || (one.effect && one.settled));
			if (settledAll)
				for (const machine of page.released) {
					if (page.ledger.releasing(machine) !== undefined) continue;
					const lease = db.seatedByAny(
						machine,
						page.sent.map((sent) => sent.id),
					);
					if (lease)
						return `I10: p${index} released ${machine.slice(-2)}, everything it sent is settled, yet the lease its take-over #${lease.seatedBy} seated (seat ${lease.seat}, epoch ${lease.epoch}) is live`;
				}
			// I2
			for (const machine of page.released)
				if (page.ledger.holder(machine) !== undefined)
					return `I2: page ${index} may use ${machine.slice(-2)} after its release was asked`;
			// I3
			for (const sent of page.sent) {
				const past = page.answered.get(sent.machine);
				const lease = db.leases.get(sent.machine);
				if (past !== undefined && past > sent.epoch && lease?.live && lease.takes.has(sent.id))
					return `I3: page ${index}'s take-over ${sent.id} at ${sent.epoch} holds ${sent.machine.slice(-2)} after a hand-back answered ${past}`;
			}
		}
		// I1: once I'm done answered, no lease of the member's holds that was taken under an epoch at or below one the page
		// had sent a take-over under or been shown a hold under; nor one taken before it was pressed, nor by a take-over the
		// page had sent. (A lease another tab takes later, above all of those, is a new take-over, outside the answer.)
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
					return `I1: page ${done.page}'s I'm done answered at step ${done.answered} (seats owed ${[...(upTo ?? [])]}), yet ${machine.slice(-2)} is held by a lease under ${lease.epoch} taken at step ${lease.takenStep} (takes ${[...lease.takes]})`;
			}
		return undefined;
	};
	type Action = { kind: Kind; weight: number; name: string; run: () => boolean | undefined };
	for (let step = 1; step <= steps; step++) {
		db.step = step;
		// The page's clock moves on a little each step (an earlier ledger stamped list reads with it).
		vi.setSystemTime(Date.now() + 1);
		const index = pageCount === 1 || next() < 0.5 ? 0 : 1;
		const page = pages[index] as Page;
		// What may happen to a request now: it reaches the database (even after its answer was lost), or its answer comes.
		const due = requests.filter((one) => (one.effect ? !one.settled && step >= one.deliverAt : step >= one.effectAt));
		const every: Action[] = [
			{
				kind: "take over",
				weight: 4,
				name: `p${index} take over ${page.selected.slice(-2)}`,
				run: () => {
					if (!page.open) return false;
					const machine = page.selected;
					page.released.delete(machine);
					page.known.add(machine);
					const pressed = step;
					const before = page.releases.get(machine) ?? 0;
					const finishing = page.finishing > 0;
					const finishes = page.finishes;
					// As the window does: the press's stamp goes with it (review r13).
					const taking = page.ledger.take(machine, AGENT, page.ledger.stamp());
					void taking.then((answer) => {
						// A take-over the page did not call off (no release of the machine since the press, and no Hand back or
						// I'm done at work, whose later rounds give back what reads show) never comes to nothing unsaid (review
						// r11 F18).
						const calledOff =
							(page.releases.get(machine) ?? 0) !== before || finishing || page.finishes !== finishes;
						if (answer.state === "called-off" && !calledOff)
							page.silent.push(
								`p${index}'s take-over of ${machine.slice(-2)} pressed at step ${pressed} was called off, though the page asked no release of it`,
							);
						// What the window joins a press by (review r12 F19) agrees with the answer: called off when it says so, live
						// when it holds or tells the member why not (one not sent while a hand-back is unanswered may be either).
						if (answer.state !== "releasing" && (answer.state === "called-off") !== page.ledger.calledOff(taking))
							page.silent.push(
								`p${index}'s take-over of ${machine.slice(-2)} pressed at step ${pressed} was answered ${answer.state}, yet the ledger says it was${page.ledger.calledOff(taking) ? "" : " not"} called off`,
							);
						// The window: taken while another machine was chosen goes back as it comes.
						if (answer.state === "ok" && page.selected !== machine) {
							page.ledger.release(machine, AGENT);
							letGo(page, machine);
						}
					});
					return true;
				},
			},
			{
				kind: "hand back",
				weight: 2,
				name: `p${index} hand back`,
				run: () => {
					for (const machine of machines) letGo(page, machine);
					page.finishing++;
					page.finishes++;
					void page.ledger.releaseAgent(AGENT, "handed_back", true).finally(() => {
						page.finishing--;
					});
					return true;
				},
			},
			{
				kind: "I'm done",
				weight: 3,
				name: `p${index} I'm done`,
				run: () => {
					for (const machine of machines) letGo(page, machine);
					const pressed = step;
					page.finishing++;
					page.finishes++;
					void page.ledger
						.releaseAgent(AGENT, "handed_back", true)
						.then((done) => {
							if (done)
								dones.push({
									page: index,
									pressed,
									answered: db.step,
									sent: new Set(page.sent.map((sent) => sent.id)),
									upTo: owed(page, pressed),
								});
						})
						.finally(() => {
							page.finishing--;
						});
					return true;
				},
			},
			{
				kind: "close",
				weight: 2,
				name: `p${index} close`,
				run: () => {
					if (!page.open) return false;
					page.open = false;
					page.window++;
					for (const machine of machines) letGo(page, machine);
					void page.ledger.releaseAgent(AGENT, "closed");
					return true;
				},
			},
			{
				kind: "reopen",
				weight: 2,
				name: `p${index} reopen`,
				run: () => {
					if (page.open) return false;
					page.open = true;
					page.window++;
					windowRead(index);
					return true;
				},
			},
			{
				kind: "switch",
				weight: 2,
				name: `p${index} switch`,
				run: () => {
					if (!page.open || machines.length < 2) return false;
					page.selected = page.selected === MACHINES[0] ? MACHINES[1] : MACHINES[0];
					for (const machine of page.known) if (machine !== page.selected) letGo(page, machine);
					page.ledger.releaseOthers(AGENT, page.selected);
					return true;
				},
			},
			{
				kind: "window read",
				weight: 3,
				name: `p${index} window read`,
				run: () => {
					if (!page.open) return false;
					windowRead(index);
					return true;
				},
			},
			{
				kind: "input",
				weight: 2,
				name: `p${index} heartbeat and input`,
				run: () => {
					const held = page.ledger.holder(page.selected);
					if (!page.open || held === undefined) return false;
					if (!db.keep(MEMBER, page.selected, held.epoch, held.seat))
						page.ledger.ended(page.selected, held.epoch, held.seat);
					return true;
				},
			},
			{
				kind: "time",
				weight: 1,
				name: "time passes",
				run: () => {
					vi.advanceTimersByTime(20_000);
					return true;
				},
			},
			{
				kind: "tab takes",
				weight: 2,
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
					// Another tab hands back what it holds, by its seat.
					db.handBack(MEMBER, machine, db.epoch(MEMBER, machine), { seat: db.leases.get(machine)?.seat ?? null });
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
			const named = one.name ? (one.name.seat !== null ? ` seat ${one.name.seat}` : " VOID") : "";
			const label = `${one.kind} #${one.id} of p${one.page}${one.machine ? ` ${one.machine.slice(-2)}@${one.epoch}${named}` : ""}`;
			if (!one.effect)
				actions.push({
					kind: "take over",
					weight: 8,
					name: `reaches the database: ${label}`,
					run: () => {
						effect(one);
						return true;
					},
				});
			else
				actions.push({
					kind: "take over",
					weight: 8,
					name: `answer delivered: ${label} (${told(one)})`,
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
						one.reject(new Error("lost"));
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
		if (action.run() === false) continue;
		log.push(`${step}: ${action.name}`);
		await flush();
		const broken = check();
		if (broken) {
			for (const one of pages) one.stop.abort();
			return { log, broken };
		}
	}
	for (const one of pages) one.stop.abort();
	await flush();
	return { log };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
});
afterEach(() => {
	vi.useRealTimers();
});

/** Seeds that broke an earlier ledger of this PR (review r10; lanes/desktop-computers-20261110/TAKE-OVER-PROGRESS.md).
 * F12 to F16 broke I1 with I2 left out (every earlier ledger also has the two I2 gaps below); F17 and the I2 gaps break
 * the ledger of review r9 as it was, F18 that of review r10. They run first; each holds on this ledger. */
const FOUND: readonly { seed: number; finding: string }[] = [
	{
		seed: 3442,
		finding:
			"F27 (7a40f8242, I10, over a model with that commit's SQL): another tab took the desktop at epoch 0; the page's take-over at 0 lost its answer before it arrived; the page closed and its hand-back named that press, which ended nothing and moved no epoch; the take-over then arrived and seated the member over the other tab's hold",
	},
	{
		seed: 6087,
		finding:
			"F18 (r10, I4): another tab gave the machine back before the take-over at 0 arrived; its TAKE_CALLED_OFF (epoch 1) came back as called off, and the member was told nothing",
	},
	{
		seed: 3439,
		finding:
			"F17 (r9, I1): a hand-back's answer at epoch 1, taken before another tab took the desktop at 1, cleared the hold a list had shown at 1; an older read at 1 then let I'm done answer",
	},
	{
		seed: 324,
		finding: "F16 (r8, I1): I'm done answered on a read taken before another tab's hold that a newer read had shown",
	},
	{
		seed: 305,
		finding:
			"F15 (r7, I1): a read asked before a later take-over answer was set aside by the page's clock, though it showed a hold at the newer epoch",
	},
	{
		seed: 5912,
		finding:
			"F13 (r6, I1): a hand-back's answer that the member still held the desktop (another tab) was not owed; an older read then let I'm done answer",
	},
	{
		seed: 2144,
		finding:
			"F12 (r5, I1): a refusal (another member in control) cleared what was sent at epoch 0; nothing was handed back at 0 and I'm done answered",
	},
	{
		seed: 4,
		finding:
			"r9 and earlier (I2): a release with nothing owed did not mark the machine given back; after I'm done the window took up another tab's hold (taking up was removed in r14)",
	},
	{
		seed: 60,
		finding:
			"r9 and earlier (I2): a close and I'm done asked before the page knew the agent's machine; the window then took up another tab's hold there (taking up was removed in r14)",
	},
];

describe("the ledger of desktop holds, explored", () => {
	it("keeps I1, I2 and I3 over seeded schedules of take-overs, hand-backs, I'm done, closes, switches and lost answers", async () => {
		const seeds = [...FOUND.map((found) => found.seed), ...Array.from({ length: 8000 }, (_, n) => n + 1)];
		for (const seed of seeds) {
			const { log, broken } = await explore(seed, 60);
			if (broken) {
				const found = FOUND.find((one) => one.seed === seed);
				expect.fail(
					`seed ${seed}: ${broken}${found ? `\n(found earlier: ${found.finding})` : ""}\n${log.join("\n")}`,
				);
			}
		}
	});
});
