import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { assertLxdCodingMachineInstance } from "./coding-machine.ts";
import {
	isRuntimePaidComputerMachine,
	type PaidComputerGuardPhysical,
	type PaidComputerHostClock,
	type PaidComputerMachine,
	paidComputerTarget,
} from "./computer-paid-guard.ts";
import type { LxdInstanceRecord, LxdOperationReference, LxdTrackedClient } from "./lxd-client.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";
import { readRuntimeNodeHost } from "./runtime-node-host.ts";
import { assertRuntimePaidComputerInstance } from "./runtime-paid-machine.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function kernel(path: "/proc/uptime" | "/proc/sys/kernel/random/boot_id"): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o444)
			throw new Error("PAID_GUARD_CLOCK_UNCONFIRMED");
		const buffer = Buffer.alloc(129);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead < 1 || bytesRead > 128) throw new Error("PAID_GUARD_CLOCK_UNCONFIRMED");
		return buffer.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}
/** Host boot uptime includes suspend and survives a daemon restart. Wall-clock
 * adjustment never extends a permit. Deployment must use the real host /proc. */
export async function readPaidComputerHostClock(): Promise<PaidComputerHostClock> {
	if (process.platform !== "linux") throw new Error("PAID_GUARD_LINUX_REQUIRED");
	const host = await readRuntimeNodeHost(AbortSignal.timeout(5000));
	const boot = (await kernel("/proc/sys/kernel/random/boot_id")).toString("utf8").trim();
	const uptimeMs = parseLxdProcUptime(await kernel("/proc/uptime"));
	if (!UUID.test(boot) || (await kernel("/proc/sys/kernel/random/boot_id")).toString("utf8").trim() !== boot)
		throw new Error("PAID_GUARD_CLOCK_UNCONFIRMED");
	return { hostMachineIdSha256: host.machineIdSha256, hostBootId: boot, uptimeMs };
}

/** Separate stop-capable local custody. This does not use observer credentials,
 * database access, guest execution, NAS I/O, shell commands or remote endpoints.
 * Only the exact configured coding VM and physical UUID may be powered off. */
export class LxdPaidComputerGuardPhysical implements PaidComputerGuardPhysical {
	readonly #client: Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation">;
	readonly #clock: () => Promise<PaidComputerHostClock>;
	constructor(
		client: Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation">,
		clock: () => Promise<PaidComputerHostClock> = readPaidComputerHostClock,
	) {
		this.#client = client;
		this.#clock = clock;
	}
	async #instance(machine: PaidComputerMachine, signal: AbortSignal): Promise<LxdInstanceRecord | undefined> {
		signal.throwIfAborted();
		const target = paidComputerTarget(machine);
		const instance = await this.#client.getInstance(target.project, target.instanceName, signal);
		signal.throwIfAborted();
		if (instance) {
			if (isRuntimePaidComputerMachine(machine)) assertRuntimePaidComputerInstance(machine, instance);
			else assertLxdCodingMachineInstance(machine.binding, machine.storage, instance);
			if (
				instance.config["volatile.uuid"] !== machine.physicalInstanceId ||
				instance.expandedConfig["volatile.uuid"] !== machine.physicalInstanceId
			)
				throw new Error("PAID_GUARD_PHYSICAL_INSTANCE_DIFFERS");
		}
		return instance;
	}
	async inspect(
		machine: PaidComputerMachine,
		signal: AbortSignal,
	): Promise<"running" | "stopped" | "absent" | "other"> {
		const instance = await this.#instance(machine, signal);
		if (!instance) return "absent";
		if (instance.status === "Running" && instance.statusCode === 103) return "running";
		if (instance.status === "Stopped" && instance.statusCode === 102) return "stopped";
		return "other";
	}
	async start(
		machine: PaidComputerMachine,
		stopAtUptimeMs: number,
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		if ((await this.inspect(machine, signal)) !== "stopped") throw new Error("PAID_GUARD_STOPPED_MACHINE_REQUIRED");
		const clock = await this.#clock();
		if (
			clock.hostMachineIdSha256 !== machine.hostMachineIdSha256 ||
			clock.hostBootId !== machine.hostBootId ||
			!Number.isSafeInteger(stopAtUptimeMs) ||
			clock.uptimeMs + 5000 >= stopAtUptimeMs
		)
			throw new Error("PAID_GUARD_START_EXPIRED");
		signal.throwIfAborted();
		const target = paidComputerTarget(machine);
		return this.#client.submitInstanceOperation(
			target.project,
			{ action: "start", name: target.instanceName },
			AbortSignal.any([signal, AbortSignal.timeout(5000)]),
		);
	}
	async startSettled(
		reference: LxdOperationReference,
		signal: AbortSignal,
	): Promise<"pending" | "succeeded" | "failed"> {
		// A forgotten operation cannot prove no start remains in flight. Retain
		// stopping custody for operator reconciliation rather than invent proof.
		return this.#client.inspectInstanceOperation(reference, signal);
	}
	async stop(machine: PaidComputerMachine, signal: AbortSignal): Promise<LxdOperationReference> {
		const instance = await this.#instance(machine, signal);
		if (!instance) throw new Error("PAID_GUARD_PHYSICAL_INSTANCE_ABSENT");
		signal.throwIfAborted();
		return this.#client.submitInstanceOperation(
			paidComputerTarget(machine).project,
			{ action: "stop", name: instance.name, force: true },
			signal,
		);
	}
}
