import { createHash } from "node:crypto";
import {
	type PaidComputerGuardPhysical,
	type PaidComputerHostClock,
	type PaidComputerMachine,
	paidComputerTarget,
} from "./computer-paid-guard.ts";
import type { PaidComputerUsageCapture } from "./computer-paid-usage-sampler.ts";
import type { LxdClockClient } from "./lxd-client.ts";

/** Fixed, unprivileged paired guest clocks. Physical identity is checked on
 * both sides; the complete sample retains the existing one-second budget. */
export class LxdPaidComputerUsageCapture implements PaidComputerUsageCapture {
	readonly #client: LxdClockClient;
	readonly #physical: PaidComputerGuardPhysical;
	readonly #clock: () => Promise<PaidComputerHostClock>;
	constructor(
		client: LxdClockClient,
		physical: PaidComputerGuardPhysical,
		clock: () => Promise<PaidComputerHostClock>,
	) {
		this.#client = client;
		this.#physical = physical;
		this.#clock = clock;
	}
	async capture(
		machine: PaidComputerMachine,
		signal: AbortSignal,
	): Promise<{
		host: PaidComputerHostClock;
		guestBootId: string;
		guestUptimeMs: number;
		evidenceSha256: string;
		observedAt: string;
	}> {
		signal.throwIfAborted();
		const before = await this.#clock();
		if (
			before.hostMachineIdSha256 !== machine.hostMachineIdSha256 ||
			before.hostBootId !== machine.hostBootId ||
			(await this.#physical.inspect(machine, signal)) !== "running"
		)
			throw new Error("PAID_USAGE_CLOCK_UNCONFIRMED");
		const target = paidComputerTarget(machine),
			guest = await this.#client.readInstanceClock(target.project, target.instanceName, signal);
		if ((await this.#physical.inspect(machine, signal)) !== "running")
			throw new Error("PAID_USAGE_CLOCK_UNCONFIRMED");
		const after = await this.#clock();
		const observedAt = new Date().toISOString();
		signal.throwIfAborted();
		if (
			after.hostMachineIdSha256 !== before.hostMachineIdSha256 ||
			after.hostBootId !== before.hostBootId ||
			after.uptimeMs < before.uptimeMs ||
			after.uptimeMs - before.uptimeMs > 1000
		)
			throw new Error("PAID_USAGE_CLOCK_UNCONFIRMED");
		return {
			host: after,
			observedAt,
			guestBootId: guest.bootId,
			guestUptimeMs: guest.uptimeMs,
			evidenceSha256: createHash("sha256")
				.update(
					JSON.stringify({
						schema: "qorpera.computer-guard-clock-evidence/v1",
						physicalInstanceId: machine.physicalInstanceId,
						target,
						before,
						guest,
						after,
					}),
				)
				.digest("hex"),
		};
	}
}
