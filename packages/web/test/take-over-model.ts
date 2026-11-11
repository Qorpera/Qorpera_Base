import type {
	MemberAgentMachine,
	MemberAgentMachines,
	MemberDesktopHandBack,
	MemberDesktopHold,
} from "@qorpera/cloud-client/cloud-member-company-computer";

/* The database's take-over rules as migration 20260930713000 has them (one hand-back epoch per member and machine, a
 * lease taken under it; take / keep / hand-back / list as SQL answers them), for the schedule explorers of the ledger
 * (desktop-holds-explorer.test.ts) and of the window (computer-explorer.test.ts), reviews r10 and r13 of #1661. */

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
}

/** The database, as migration 20260930713000 has it. */
export class Database {
	readonly machines: readonly string[];
	constructor(machines: readonly string[]) {
		this.machines = machines;
	}
	readonly epochs = new Map<string, number>();
	readonly leases = new Map<string, Lease | undefined>();
	step = 0;
	epoch(member: string, machine: string): number {
		return this.epochs.get(`${member}:${machine}`) ?? 0;
	}
	take(member: string, machine: string, epoch: number, take: number): MemberDesktopHold {
		const current = this.epoch(member, machine);
		if (epoch !== current) return { state: "refused", reason: "TAKE_CALLED_OFF", memberName: null, epoch: current };
		const lease = this.leases.get(machine);
		if (lease?.live && lease.member !== member)
			return { state: "refused", reason: "DESKTOP_MEMBER_IN_CONTROL", memberName: "Ada", epoch: null };
		if (lease?.live) {
			lease.epoch = current;
			lease.takes.add(take);
		} else
			this.leases.set(machine, { member, epoch: current, live: true, takes: new Set([take]), takenStep: this.step });
		return { state: "ok", until: "2026-11-11T00:00:00Z" };
	}
	keep(member: string, machine: string, epoch: number): boolean {
		const lease = this.leases.get(machine);
		return lease?.live === true && lease.member === member && lease.epoch === epoch;
	}
	handBack(member: string, machine: string, epoch: number): MemberDesktopHandBack {
		const current = this.epoch(member, machine);
		let handedBack = false;
		if (epoch === current) {
			this.epochs.set(`${member}:${machine}`, current + 1);
			const lease = this.leases.get(machine);
			if (lease && lease.member === member && lease.epoch === epoch) {
				handedBack = lease.live;
				this.leases.set(machine, undefined);
			}
		}
		const now = this.leases.get(machine);
		return { handedBack, epoch: this.epoch(member, machine), holding: now?.live === true && now.member === member };
	}
	list(member: string): MemberAgentMachines {
		return {
			canWake: true,
			canTakeOver: true,
			machines: this.machines.map((machine): MemberAgentMachine => {
				const lease = this.leases.get(machine);
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
								mine: lease.member === member,
								name: lease.member,
								until: "2026-11-11T00:00:00Z",
								epoch: lease.member === member ? lease.epoch : null,
							}
						: null,
					epoch: this.epoch(member, machine),
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
	/** A member's action as qorpera_member_machine_desktop_act_begin takes it: from the member who holds the live lease,
	 * and (F24) only when that lease was taken under the epoch the action names (an action without one, from an earlier
	 * page, is not checked). */
	act(
		member: string,
		machine: string,
		epoch: number | undefined,
	): { ok: true; lease: Lease } | { ok: false; code: "DESKTOP_CONTROL_ENDED" | "DESKTOP_MEMBER_IN_CONTROL" } {
		const lease = this.leases.get(machine);
		if (!lease?.live) return { ok: false, code: "DESKTOP_CONTROL_ENDED" };
		if (lease.member !== member) return { ok: false, code: "DESKTOP_MEMBER_IN_CONTROL" };
		if (this.actEpochChecked && epoch !== undefined && epoch !== lease.epoch)
			return { ok: false, code: "DESKTOP_CONTROL_ENDED" };
		return { ok: true, lease };
	}
}
