import { createHash, randomUUID } from "node:crypto";
import type { CodingComputerUsage } from "./coding-computer-usage.ts";
import type { CodingSessionClaim } from "./coding-executor.ts";
import {
	assertLxdCodingMachineInstance,
	type CodingMachineJournalPlan,
	type CodingMachineStorage,
	type LxdCodingMachineBinding,
	lxdCodingMachineName,
	lxdCodingMachinePlan,
} from "./coding-machine.ts";
import {
	isRuntimePaidComputerMachine,
	PAID_COMPUTER_STOP_RESERVE_MS,
	PAID_COMPUTER_WINDOW_MS,
	type PaidComputerArm,
	type PaidComputerGuardRecord,
	type PaidComputerHostClock,
	type PaidComputerPermit,
	parsePaidComputerPermit,
} from "./computer-paid-guard.ts";
import type { LxdInspectableClient, LxdOperationReference, LxdTrackedClient } from "./lxd-client.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";

export const CODING_COMPUTER_RPCS = [
	"qorpera_prepare_coding_computer_permit",
	"qorpera_describe_coding_computer_permit",
	"qorpera_bind_coding_computer_permit",
	"qorpera_checkpoint_coding_computer_permit",
	"qorpera_renew_coding_computer_permit",
	"qorpera_finish_coding_computer_permit",
] as const;

export interface CodingPaidGuardPort {
	list(signal: AbortSignal): Promise<PaidComputerGuardRecord[]>;
	latest(allocationId: string, signal: AbortSignal): Promise<PaidComputerGuardRecord | null>;
	arm(input: PaidComputerArm, signal: AbortSignal): Promise<PaidComputerGuardRecord>;
	start(permitId: string, generation: number, signal: AbortSignal): Promise<LxdOperationReference>;
	stop(permitId: string, signal: AbortSignal): Promise<PaidComputerGuardRecord>;
	status(permitId: string, signal: AbortSignal): Promise<PaidComputerGuardRecord>;
}
interface UsageSample {
	observationId: string;
	previousObservationId: string | null;
	hostBootId: string;
	hostUptimeMs: number;
	physicalId: string | null;
	guestBootId: string | null;
	guestUptimeMs: number | null;
	observedAt: string;
	state: "running" | "gap" | "stopped" | "absent";
	evidenceSha256: string;
}
interface ManagedComputer {
	machine: Readonly<LxdCodingMachineBinding>;
	permit: PaidComputerPermit;
	requestStartedUptimeMs: number;
	lastObservationId: string | null;
	continuity: boolean;
}
export interface CodingComputerControllerOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	guard: CodingPaidGuardPort;
	client: Pick<LxdTrackedClient, "getInstance"> & Pick<LxdInspectableClient, "readInstanceFile">;
	clock(): Promise<PaidComputerHostClock>;
	owner: string;
	storage: CodingMachineStorage;
	/** UTC is evidence only; expiry enforcement uses the independent host boot clock. */
	now?: () => number;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
	return value as Record<string, unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The control-plane half of paid coding computers. The guard independently
 * stops a VM if this entire process disappears. No network retry manufactures
 * a fresh reservation: describe recovers committed kernel state first. */
export class CodingComputerController implements CodingComputerUsage {
	readonly #options: CodingComputerControllerOptions;
	readonly #computers = new Map<string, ManagedComputer>();
	readonly #work = new Map<string, Promise<unknown>>();
	constructor(options: CodingComputerControllerOptions) {
		this.#options = options;
	}
	#exclusive<T>(machineId: string, use: () => Promise<T>): Promise<T> {
		const previous = this.#work.get(machineId) ?? Promise.resolve();
		const work = previous.catch(() => undefined).then(use);
		this.#work.set(machineId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this.#work.get(machineId) === work) this.#work.delete(machineId);
			});
		return work;
	}
	async #call(
		method: (typeof CODING_COMPUTER_RPCS)[number],
		request: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		return this.#options.control.call(
			method,
			{ p_request: request },
			AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		);
	}
	async #clock(): Promise<PaidComputerHostClock> {
		const clock = await this.#options.clock();
		if (
			clock.hostMachineIdSha256 !== this.#options.storage.machineIdSha256 ||
			!UUID.test(clock.hostBootId) ||
			!Number.isSafeInteger(clock.uptimeMs) ||
			clock.uptimeMs < 0
		)
			throw new Error("CODING_COMPUTER_HOST_DIFFERS");
		return clock;
	}
	#checkedPermit(
		value: unknown,
		machine: Readonly<LxdCodingMachineBinding>,
		clock: PaidComputerHostClock,
		stopped = false,
	): PaidComputerPermit {
		const permit = parsePaidComputerPermit(value),
			plan = lxdCodingMachinePlan(machine);
		if (
			permit.allocationId !== machine.machineId ||
			permit.instanceSha256 !== plan.instanceSha256 ||
			(!stopped && permit.hostBootId !== clock.hostBootId) ||
			permit.cpuMillis !== machine.cpus * 1000 ||
			permit.memoryBytes !== machine.memoryBytes
		)
			throw new Error("CODING_COMPUTER_PERMIT_DIFFERS");
		return permit;
	}
	async #describe(
		machine: Readonly<LxdCodingMachineBinding>,
		signal: AbortSignal,
		stopped = false,
	): Promise<ManagedComputer | null> {
		const clock = await this.#clock();
		const value = await this.#call(
			"qorpera_describe_coding_computer_permit",
			{
				machineId: machine.machineId,
				owner: this.#options.owner,
				machineIdSha256: clock.hostMachineIdSha256,
				hostBootId: clock.hostBootId,
			},
			signal,
		);
		if (value === null) return null;
		const data = object(value);
		if (data.permit === null) return null;
		const permit = this.#checkedPermit(data.permit, machine, clock, stopped);
		if (permit.state === "closed") return null;
		const lastSample = data.lastSample === null ? null : object(data.lastSample);
		if (lastSample && (typeof lastSample.observationId !== "string" || !UUID.test(lastSample.observationId)))
			throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
		return {
			machine,
			permit,
			requestStartedUptimeMs: clock.uptimeMs,
			lastObservationId: lastSample ? (lastSample.observationId as string) : null,
			continuity: false,
		};
	}
	async initialize(signal: AbortSignal): Promise<void> {
		const latest = new Map<string, PaidComputerGuardRecord>();
		for (const entry of await this.#options.guard.list(signal)) {
			const prior = latest.get(entry.machine.allocationId);
			if (!prior || Date.parse(entry.permit.issuedAt) > Date.parse(prior.permit.issuedAt))
				latest.set(entry.machine.allocationId, entry);
		}
		for (const entry of latest.values()) {
			if (isRuntimePaidComputerMachine(entry.machine)) continue;
			if (entry.machine.hostMachineIdSha256 !== this.#options.storage.machineIdSha256)
				throw new Error("CODING_COMPUTER_HOST_DIFFERS");
			const current = await this.#describe(entry.machine.binding, signal, entry.phase === "stopped");
			if (current) this.#computers.set(current.machine.machineId, current);
		}
	}
	manages(machineId: string): boolean {
		return this.#computers.has(machineId);
	}
	async ensure(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		signal: AbortSignal,
	): Promise<void> {
		await this.#exclusive(machine.machineId, async () => {
			signal.throwIfAborted();
			const existing = this.#computers.get(machine.machineId);
			if (existing) {
				const clock = await this.#clock(),
					guard = await this.#options.guard.latest(machine.machineId, signal);
				if (
					clock.hostBootId !== existing.permit.hostBootId ||
					clock.uptimeMs >=
						existing.requestStartedUptimeMs + existing.permit.validForMs - existing.permit.stopReserveMs ||
					(guard &&
						(guard.permit.permitId !== existing.permit.permitId ||
							guard.phase === "stopped" ||
							guard.phase === "stopping" ||
							clock.uptimeMs >= guard.stopAtUptimeMs))
				)
					throw new Error("CODING_COMPUTER_PERMIT_EXPIRED");
				return;
			}
			let current = await this.#describe(machine, signal);
			if (!current) {
				const clock = await this.#clock();
				// Prepare is recovered through describe after a lost reply. One server
				// allocation can have only one active permit, even across executors.
				const value = await this.#call(
					"qorpera_prepare_coding_computer_permit",
					{
						schema: "qorpera.coding-computer-prepare/v1",
						requestId: randomUUID(),
						workerId: claim.workerId,
						leaseToken: claim.leaseToken,
						machineId: machine.machineId,
						owner: this.#options.owner,
						bindingText: lxdCodingMachinePlan(machine).text,
						machineIdSha256: clock.hostMachineIdSha256,
						hostBootId: clock.hostBootId,
						windowMs: PAID_COMPUTER_WINDOW_MS,
						stopReserveMs: PAID_COMPUTER_STOP_RESERVE_MS,
					},
					signal,
				);
				current = {
					machine,
					permit: this.#checkedPermit(value, machine, clock),
					requestStartedUptimeMs: clock.uptimeMs,
					lastObservationId: null,
					continuity: false,
				};
			}
			this.#computers.set(machine.machineId, current);
		});
	}
	async #arm(current: ManagedComputer, signal: AbortSignal): Promise<PaidComputerGuardRecord> {
		const machine = current.machine;
		const instance = await this.#options.client.getInstance(
			machine.project,
			lxdCodingMachineName(machine.machineId),
			signal,
		);
		if (!instance) throw new Error("CODING_COMPUTER_INSTANCE_MISSING");
		assertLxdCodingMachineInstance(machine, this.#options.storage, instance);
		const physicalId = instance.config["volatile.uuid"];
		if (!UUID.test(physicalId ?? "") || instance.expandedConfig["volatile.uuid"] !== physicalId)
			throw new Error("CODING_COMPUTER_PHYSICAL_ID_INVALID");
		return this.#options.guard.arm(
			{
				machine: {
					allocationId: current.permit.allocationId,
					nodeId: current.permit.nodeId,
					binding: machine,
					storage: this.#options.storage,
					physicalInstanceId: physicalId,
					hostMachineIdSha256: this.#options.storage.machineIdSha256,
					hostBootId: current.permit.hostBootId,
				},
				permit: current.permit,
				requestStartedUptimeMs: current.requestStartedUptimeMs,
			},
			signal,
		);
	}
	async start(machineId: string, signal: AbortSignal): Promise<LxdOperationReference> {
		return this.#exclusive(machineId, async () => {
			const current = this.#required(machineId);
			const armed = await this.#arm(current, signal);
			if (
				armed.phase !== "armed" &&
				!((armed.phase === "starting" || armed.phase === "running") && armed.startReference)
			)
				throw new Error("CODING_COMPUTER_START_REQUIRES_RECOVERY");
			return this.#options.guard.start(current.permit.permitId, current.permit.generation, signal);
		});
	}
	#required(machineId: string): ManagedComputer {
		const current = this.#computers.get(machineId);
		if (!current) throw new Error("CODING_COMPUTER_PERMIT_REQUIRED");
		return current;
	}
	async stop(machineId: string, signal: AbortSignal): Promise<LxdOperationReference> {
		const current = this.#required(machineId);
		const stopped = await this.#options.guard.stop(current.permit.permitId, signal);
		const reference = stopped.stopReference;
		if (!reference) throw new Error("CODING_COMPUTER_STOP_REQUIRES_RECOVERY");
		return reference;
	}
	async externalStop(journal: CodingMachineJournalPlan, signal: AbortSignal): Promise<LxdOperationReference | null> {
		const stopped = await this.#options.guard.latest(journal.machineId, signal);
		if (
			!stopped ||
			stopped.phase !== "stopped" ||
			stopped.permit.instanceSha256 !== journal.instanceSha256 ||
			!stopped.stopReceipt ||
			stopped.stopReceipt.state !== "stopped"
		)
			return null;
		const physical = await this.#options.client.getInstance(journal.project, journal.name, signal);
		if (
			!physical ||
			physical.status !== "Stopped" ||
			physical.statusCode !== 102 ||
			physical.config["volatile.uuid"] !== stopped.machine.physicalInstanceId ||
			physical.expandedConfig["volatile.uuid"] !== stopped.machine.physicalInstanceId
		)
			return null;
		journal.assertInstance(physical);
		return stopped.stopReference;
	}
	async externalStart(
		journal: CodingMachineJournalPlan,
		signal: AbortSignal,
	): Promise<{
		reference: LxdOperationReference;
		settled: boolean;
		stopReference: LxdOperationReference | null;
	} | null> {
		const guarded = await this.#options.guard.latest(journal.machineId, signal);
		if (
			!guarded ||
			!guarded.startDispatched ||
			!guarded.startReference ||
			guarded.permit.instanceSha256 !== journal.instanceSha256
		)
			return null;
		const physical = await this.#options.client.getInstance(journal.project, journal.name, signal);
		if (
			!physical ||
			physical.config["volatile.uuid"] !== guarded.machine.physicalInstanceId ||
			physical.expandedConfig["volatile.uuid"] !== guarded.machine.physicalInstanceId
		)
			return null;
		journal.assertInstance(physical);
		return {
			reference: guarded.startReference,
			settled: guarded.startSettled && guarded.startSucceeded === true,
			stopReference: guarded.stopReference,
		};
	}
	async #sample(
		current: ManagedComputer,
		signal: AbortSignal,
		terminal?: PaidComputerGuardRecord,
	): Promise<UsageSample> {
		const clock = await this.#clock();
		if (!terminal?.stopReceipt && clock.hostBootId !== current.permit.hostBootId)
			throw new Error("CODING_COMPUTER_BOOT_CHANGED");
		const sample: UsageSample = {
			observationId: randomUUID(),
			previousObservationId: current.lastObservationId,
			hostBootId: clock.hostBootId,
			hostUptimeMs: clock.uptimeMs,
			physicalId: current.permit.physicalId,
			guestBootId: current.permit.guestBootId,
			guestUptimeMs: null,
			observedAt: new Date((this.#options.now ?? Date.now)()).toISOString(),
			state: "gap",
			evidenceSha256: current.permit.instanceSha256,
		};
		if (terminal?.stopReceipt) {
			sample.state = terminal.stopReceipt.state;
			sample.physicalId = terminal.machine.physicalInstanceId;
			return sample;
		}
		// Restart and uncertain RPC/physical reads break continuity. Preserve the
		// server predecessor, but insert a real gap before another running sample.
		if (current.permit.state === "bound" && !current.continuity) return sample;
		const machine = current.machine,
			name = lxdCodingMachineName(machine.machineId),
			client = this.#options.client;
		const before = await client.getInstance(machine.project, name, signal);
		if (!before || before.status !== "Running" || before.statusCode !== 103) return sample;
		assertLxdCodingMachineInstance(machine, this.#options.storage, before);
		const physicalId = before.config["volatile.uuid"];
		if (!UUID.test(physicalId ?? "") || (current.permit.physicalId && current.permit.physicalId !== physicalId))
			throw new Error("CODING_COMPUTER_PHYSICAL_ID_CHANGED");
		const boot = await client.readInstanceFile(machine.project, name, "/proc/sys/kernel/random/boot_id", 64, signal);
		const uptime = await client.readInstanceFile(machine.project, name, "/proc/uptime", 128, signal);
		const bootAfter = await client.readInstanceFile(
			machine.project,
			name,
			"/proc/sys/kernel/random/boot_id",
			64,
			signal,
		);
		const after = await client.getInstance(machine.project, name, signal);
		const guestBootId = boot.content.toString("utf8").trim();
		if (
			[boot, uptime, bootAfter].some((file) => file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444) ||
			!UUID.test(guestBootId) ||
			bootAfter.content.toString("utf8").trim() !== guestBootId ||
			!after ||
			after.status !== "Running" ||
			after.statusCode !== 103 ||
			after.config["volatile.uuid"] !== physicalId
		)
			throw new Error("CODING_COMPUTER_OBSERVATION_UNCONFIRMED");
		assertLxdCodingMachineInstance(machine, this.#options.storage, after);
		const guestUptimeMs = parseLxdProcUptime(uptime.content);
		const completed = await this.#clock();
		if (
			!Number.isSafeInteger(guestUptimeMs) ||
			guestUptimeMs < 0 ||
			completed.hostBootId !== clock.hostBootId ||
			completed.uptimeMs - clock.uptimeMs > 1000
		)
			throw new Error("CODING_COMPUTER_OBSERVATION_UNCONFIRMED");
		return { ...sample, physicalId, guestBootId, guestUptimeMs, state: "running" };
	}
	async #observe(current: ManagedComputer, signal: AbortSignal): Promise<void> {
		const guarded = await this.#options.guard.latest(current.machine.machineId, signal);
		if (!guarded || guarded.permit.permitId !== current.permit.permitId) return;
		const sample = await this.#sample(current, signal, guarded.phase === "stopped" ? guarded : undefined);
		const { evidenceSha256: _evidence, ...facts } = sample;
		sample.evidenceSha256 = createHash("sha256")
			.update(JSON.stringify({ sample: facts, stopReceipt: guarded.stopReceipt }))
			.digest("hex");
		if (guarded.phase === "stopped") {
			await this.#call(
				"qorpera_finish_coding_computer_permit",
				{
					requestId: sample.observationId,
					permitId: current.permit.permitId,
					generation: current.permit.generation,
					sample,
					guardClosed: true,
				},
				signal,
			);
			this.#computers.delete(current.machine.machineId);
			return;
		}
		if (current.permit.state === "prepared" && sample.state !== "running") return;
		const clock = await this.#clock();
		const renew =
			current.permit.state === "bound" &&
			sample.state === "running" &&
			guarded.stopAtUptimeMs - clock.uptimeMs < 60000;
		const method =
			current.permit.state === "prepared"
				? "qorpera_bind_coding_computer_permit"
				: renew
					? "qorpera_renew_coding_computer_permit"
					: "qorpera_checkpoint_coding_computer_permit";
		await this.#call(
			method,
			{
				permitId: current.permit.permitId,
				generation: current.permit.generation,
				sample,
				...(renew
					? {
							requestId: sample.observationId,
							windowMs: PAID_COMPUTER_WINDOW_MS,
							stopReserveMs: PAID_COMPUTER_STOP_RESERVE_MS,
						}
					: {}),
			},
			signal,
		);
		const refreshed = await this.#describe(current.machine, signal);
		if (!refreshed) throw new Error("CODING_COMPUTER_PERMIT_DISAPPEARED");
		refreshed.continuity = refreshed.lastObservationId === sample.observationId;
		this.#computers.set(current.machine.machineId, refreshed);
		if (renew) await this.#arm(refreshed, signal);
	}
	async observe(machineId: string, signal: AbortSignal): Promise<void> {
		await this.#exclusive(machineId, async () => {
			try {
				await this.#observe(this.#required(machineId), signal);
			} catch (error) {
				const current = this.#computers.get(machineId);
				if (current) current.continuity = false;
				throw error;
			}
		});
	}
	async maintain(signal: AbortSignal): Promise<void> {
		// Independent machines progress even when one has a failed observation.
		const results = await Promise.allSettled(
			[...this.#computers.values()].map((entry) =>
				this.#exclusive(entry.machine.machineId, async () => {
					try {
						const guarded = await this.#options.guard.latest(entry.machine.machineId, signal);
						const current = await this.#describe(entry.machine, signal, guarded?.phase === "stopped");
						if (!current) {
							this.#computers.delete(entry.machine.machineId);
							return;
						}
						const prior = this.#computers.get(entry.machine.machineId);
						current.continuity =
							prior?.continuity === true &&
							prior.permit.permitId === current.permit.permitId &&
							prior.permit.generation === current.permit.generation &&
							prior.lastObservationId === current.lastObservationId;
						this.#computers.set(entry.machine.machineId, current);
						if (
							guarded &&
							guarded.phase !== "stopping" &&
							guarded.phase !== "stopped" &&
							current.permit.generation > guarded.permit.generation
						)
							await this.#arm(current, signal);
						await this.#observe(current, signal);
					} catch (error) {
						const current = this.#computers.get(entry.machine.machineId);
						if (current) current.continuity = false;
						throw error;
					}
				}),
			),
		);
		if (results.some((result) => result.status === "rejected")) throw new Error("CODING_COMPUTER_USAGE_UNCONFIRMED");
	}
}
