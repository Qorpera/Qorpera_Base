import type {
	MemberAgentMachine,
	MemberAgentMachines,
	MemberDesktopHandBack,
	MemberDesktopHold,
} from "@qorpera/cloud-client/cloud-member-company-computer";

/* The database's take-over rules as migration 20260930713000 has them (one hand-back epoch per member and machine, a
 * lease taken under it, a seat for every seating: F26; take / keep / hand-back / list as SQL answers them), for the
 * schedule explorers of the ledger (desktop-holds-explorer.test.ts) and of the window (computer-explorer.test.ts),
 * reviews r10, r13 and r18 of #1661. */

/** A small fast generator of the seed's choices (mulberry32). */
export function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface Lease {
	member: string;
	epoch: number;
	live: boolean;
	/** The take-overs that took or took it again (a page's request ids; -1 for another tab or member). */
	takes: Set<number>;
	takenStep: number;
	/** The model's own count of seatings (F26 of #1661): every take-over that seats a member, a new lease or the member's
	 * own taken again, is a new seat, whatever the product's fields say; and the press id that seated it. */
	seat: number;
	press: string;
	/** Who seated it (a page's request id; -1 for another tab or member), and whether that seating began this lease (no
	 * live lease of the member's was there: none, or one that had run out) or took the member's live lease over. */
	seatedBy: number;
	fresh: boolean;
}

/** How a lease's seat came, for the steps printed. */
export function seating(lease: Lease): string {
	return `seat ${lease.seat}, seated by ${lease.seatedBy >= 0 ? `the page's take-over #${lease.seatedBy}` : "another tab or member"}${lease.fresh ? " as a new lease" : " over the member's live lease"}`;
}

/** What a hand-back names: a seat (EXACT; F27, F28) or none (VOID). Round 18's hand-back (`rules = "r18"`) also took a
 * press. */
export interface HoldName {
	seat: number | null;
	press?: string | null;
}

/** Which database the model is: this one (the hand-back EXACT or VOID), round 18's (7a40f8242: a hand-back named by seat
 * or press, the epoch moving only with no live lease left unnamed) or round 17's (2ac5b3591: the epoch alone; no seat is
 * checked anywhere). */
export type Rules = "now" | "r18" | "r17";

/** The database, as migration 20260930713000 has it. */
export class Database {
	readonly machines: readonly string[];
	constructor(machines: readonly string[]) {
		this.machines = machines;
	}
	readonly epochs = new Map<string, number>();
	readonly leases = new Map<string, Lease | undefined>();
	/** Seatings so far, per machine: the model's own count, which the product's seat (the lease generation) must follow. */
	readonly seatings = new Map<string, number>();
	/** The seat each take-over request was seated at (a page's request id), when it seated anyone. */
	readonly seatedBy = new Map<number, number>();
	step = 0;
	/** The rules (Rules); the model counts seatings under each. */
	rules: Rules = "now";
	epoch(member: string, machine: string): number {
		return this.epochs.get(`${member}:${machine}`) ?? 0;
	}
	#seatAnew(machine: string): number {
		const seat = (this.seatings.get(machine) ?? 0) + 1;
		this.seatings.set(machine, seat);
		return seat;
	}
	/** Presses of another tab's or member's take-overs: ids of their own. */
	#presses = 0;
	take(member: string, machine: string, epoch: number, take: number, given?: string): MemberDesktopHold {
		const press = given ?? `00000000-0000-4000-8000-${String(++this.#presses).padStart(12, "0")}`;
		const current = this.epoch(member, machine);
		if (epoch !== current) return { state: "refused", reason: "TAKE_CALLED_OFF", memberName: null, epoch: current };
		const lease = this.leases.get(machine);
		if (lease?.live && lease.member !== member)
			return { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada", epoch: null };
		const seat = this.#seatAnew(machine);
		if (take >= 0) this.seatedBy.set(take, seat);
		if (lease?.live) {
			lease.epoch = current;
			lease.takes.add(take);
			lease.seat = seat;
			lease.press = press;
			lease.seatedBy = take;
			lease.fresh = false;
		} else
			this.leases.set(machine, {
				member,
				epoch: current,
				live: true,
				takes: new Set([take]),
				takenStep: this.step,
				seat,
				press,
				seatedBy: take,
				fresh: true,
			});
		return { state: "ok", until: "2026-11-11T00:00:00Z", seat };
	}
	keep(member: string, machine: string, epoch: number, seat?: number): boolean {
		const lease = this.leases.get(machine);
		return (
			lease?.live === true &&
			lease.member === member &&
			lease.epoch === epoch &&
			(this.rules === "r17" || seat === undefined || lease.seat === seat)
		);
	}
	handBack(member: string, machine: string, epoch: number, name: HoldName = { seat: null }): MemberDesktopHandBack {
		const current = this.epoch(member, machine);
		const lease = this.leases.get(machine);
		const mine = lease !== undefined && lease.member === member;
		let handedBack = false;
		const end = () => {
			handedBack = lease?.live === true;
			this.leases.set(machine, undefined);
			this.#seatAnew(machine);
		};
		const under = mine && lease.epoch === epoch;
		if (this.rules === "r17" || (this.rules === "now" && name.seat === null)) {
			// VOID (and round 17's only hand-back): at the current epoch it moves, and the member's lease under it ends.
			if (epoch === current) {
				this.epochs.set(`${member}:${machine}`, current + 1);
				if (under) end();
			}
		} else if (this.rules === "now") {
			// EXACT: that seat, if it is the lease; the epoch moves only when nothing of the member's is left live.
			const named = under && lease.seat === name.seat;
			const moves = epoch === current && !(mine && lease.live && !named);
			if (named || (moves && under)) end();
			if (moves) this.epochs.set(`${member}:${machine}`, current + 1);
		} else {
			const live = mine && lease.live;
			const named =
				mine &&
				lease.epoch === epoch &&
				(name.seat == null || lease.seat === name.seat) &&
				(name.press == null || lease.press === name.press);
			const moves = epoch === current && !(live && !named);
			if (named || (moves && mine && lease.epoch === epoch)) end();
			if (moves) this.epochs.set(`${member}:${machine}`, current + 1);
		}
		const now = this.leases.get(machine);
		const holding = now?.live === true && now.member === member;
		return { handedBack, epoch: this.epoch(member, machine), holding, seat: holding ? now.seat : null };
	}
	list(member: string): MemberAgentMachines {
		return {
			canWake: true,
			canTakeOver: true,
			machines: this.machines.map((machine): MemberAgentMachine => {
				const lease = this.leases.get(machine);
				const mine = lease?.member === member;
				return {
					machineId: machine,
					name: machine.slice(-2),
					purpose: "Explored.",
					state: "running",
					lifetime: "task",
					desktopCapable: true,
					startedByAgent: true,
					screenUsedAt: null,
					screenAgentName: null,
					waitingFor: null,
					control: lease?.live
						? {
								mine,
								name: lease.member,
								until: "2026-11-11T00:00:00Z",
								epoch: mine ? lease.epoch : null,
								seat: mine ? lease.seat : null,
								press: mine ? lease.press : null,
							}
						: null,
					epoch: this.epoch(member, machine),
					others: [],
					generation: null,
				};
			}),
		};
	}
	expire(machine: string): void {
		const lease = this.leases.get(machine);
		if (lease) lease.live = false;
	}
	/** Whether a member's action is checked against the epoch it names (F24 of #1661; off only to show what the check
	 * catches). */
	actEpochChecked = true;
	/** Whether a lease seated by one of these take-over requests is live on the machine now. */
	seatedByAny(machine: string, requests: Iterable<number>): Lease | undefined {
		const lease = this.leases.get(machine);
		if (!lease?.live || lease.seatedBy < 0) return undefined;
		for (const one of requests) if (one === lease.seatedBy) return lease;
		return undefined;
	}
	/** A member's action as qorpera_member_machine_desktop_act_begin takes it: from the member who holds the live lease,
	 * and only when that lease was taken under the epoch the action names (F24) and is the seat it names (F26; an action
	 * without one, from an earlier page, is not checked). */
	act(
		member: string,
		machine: string,
		epoch: number | undefined,
		seat?: number,
	): { ok: true; lease: Lease } | { ok: false; code: "DESKTOP_CONTROL_ENDED" | "DESKTOP_MEMBER_IN_CONTROL" } {
		const lease = this.leases.get(machine);
		if (!lease?.live) return { ok: false, code: "DESKTOP_CONTROL_ENDED" };
		if (lease.member !== member) return { ok: false, code: "DESKTOP_MEMBER_IN_CONTROL" };
		if (this.actEpochChecked && epoch !== undefined && epoch !== lease.epoch)
			return { ok: false, code: "DESKTOP_CONTROL_ENDED" };
		if (this.rules !== "r17" && seat !== undefined && seat !== lease.seat)
			return { ok: false, code: "DESKTOP_CONTROL_ENDED" };
		return { ok: true, lease };
	}
}
