import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
	assertPaidComputerTerminalPermit,
	isRuntimePaidComputerMachine,
	PAID_COMPUTER_STOP_RESERVE_MS,
	PAID_COMPUTER_WINDOW_MS,
	type PaidComputerArm,
	type PaidComputerGuardRecord,
	type PaidComputerHostClock,
	type PaidComputerPermit,
	type PaidComputerPrestartIntent,
	type PaidComputerPrestartRecord,
	parsePaidComputerPermit,
} from "./computer-paid-guard.ts";
import {
	assertComputerAbandonmentReceipt,
	computerPrestartDigest,
	computerPrestartExpired,
	computerPrestartRequest,
} from "./computer-prestart-control.ts";
import type { LxdClockClient, LxdOperationReference, LxdTrackedClient } from "./lxd-client.ts";

export const CODING_COMPUTER_RPCS = [
	"qorpera_prepare_coding_computer_permit",
	"qorpera_describe_coding_computer_permit",
	"qorpera_bind_coding_computer_permit",
	"qorpera_checkpoint_coding_computer_permit",
	"qorpera_renew_coding_computer_permit",
	"qorpera_finish_coding_computer_permit",
	"qorpera_abandon_coding_computer_permit",
	"qorpera_describe_coding_computer_prestart",
] as const;

export interface CodingPaidGuardPort {
	archive(permitId: string, closure: unknown, signal: AbortSignal): Promise<void>;
	hasHistory(allocationId: string, signal: AbortSignal): Promise<boolean>;
	registerPrestart(input: PaidComputerPrestartIntent, signal: AbortSignal): Promise<PaidComputerPrestartRecord>;
	prestartStatus(permitId: string, signal: AbortSignal): Promise<PaidComputerPrestartRecord | null>;
	listPrestarts(signal: AbortSignal): Promise<PaidComputerPrestartRecord[]>;
	abandonPrestart(input: PaidComputerPrestartIntent, signal: AbortSignal): Promise<PaidComputerPrestartRecord>;
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
	client: Pick<LxdTrackedClient, "getInstance"> & LxdClockClient;
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
	readonly #abandoned = new Set<string>();
	readonly #terminal = new Set<string>();
	// An archive may commit while its IPC reply is lost. Retrying this exact
	// receipt avoids reauthenticating a live machine that has already moved.
	readonly #pendingArchives = new Map<string, { allocationId: string; closure: unknown }>();
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
	async #archive(allocationId: string, permitId: string, closure: unknown, signal: AbortSignal): Promise<void> {
		this.#pendingArchives.set(permitId, { allocationId, closure });
		if (object(closure).schema === "qorpera.computer-abandonment-receipt/v1") {
			const guarded = await this.#options.guard.status(permitId, signal).catch((error: unknown) => {
				if (error instanceof Error && error.message === "PAID_GUARD_PERMIT_MISSING") return null;
				throw error;
			});
			if (guarded && guarded.phase !== "stopped") await this.#options.guard.stop(permitId, signal);
		}
		await this.#options.guard.archive(permitId, closure, signal);
		this.#pendingArchives.delete(permitId);
		this.#terminal.add(permitId);
		if (this.#computers.get(allocationId)?.permit.permitId === permitId) this.#computers.delete(allocationId);
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
		if (permit.state === "closed") {
			if (permit.schema === "qorpera.computer-usage-permit/v2")
				await this.#archive(machine.machineId, permit.permitId, data.permit, signal);
			return null;
		}
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
		await this.#recoverPrestarts(await this.#options.guard.listPrestarts(signal), signal);
		const latest = new Map<string, PaidComputerGuardRecord>();
		for (const entry of await this.#options.guard.list(signal)) {
			const prior = latest.get(entry.machine.allocationId);
			if (!prior || Date.parse(entry.permit.issuedAt) > Date.parse(prior.permit.issuedAt))
				latest.set(entry.machine.allocationId, entry);
		}
		for (const entry of latest.values()) {
			if (isRuntimePaidComputerMachine(entry.machine)) continue;
			if (this.#terminal.has(entry.permit.permitId)) continue;
			if (this.#computers.has(entry.machine.allocationId)) continue;
			if (entry.machine.hostMachineIdSha256 !== this.#options.storage.machineIdSha256)
				throw new Error("CODING_COMPUTER_HOST_DIFFERS");
			const current = await this.#describe(entry.machine.binding, signal, entry.phase === "stopped");
			if (current) this.#computers.set(current.machine.machineId, current);
		}
	}
	#prestartMachine(entry: PaidComputerPrestartRecord): Readonly<LxdCodingMachineBinding> {
		const request = computerPrestartRequest(entry);
		if (
			request.schema !== "qorpera.coding-computer-prepare/v2" ||
			request.owner !== this.#options.owner ||
			typeof request.bindingText !== "string"
		)
			throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
		const plan = lxdCodingMachinePlan(JSON.parse(request.bindingText) as LxdCodingMachineBinding);
		if (plan.instanceSha256 !== entry.intent.instanceSha256 || plan.binding.machineId !== entry.intent.allocationId)
			throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
		return plan.binding;
	}
	async #history(entry: PaidComputerPrestartRecord, signal: AbortSignal): Promise<Record<string, unknown>> {
		return object(
			await this.#call(
				"qorpera_describe_coding_computer_prestart",
				{
					...computerPrestartRequest(entry),
					prepareRequestText: entry.intent.prepareRequestText,
					prestart: { guardIncarnationId: entry.guardIncarnationId, prepareSha256: entry.intent.prepareSha256 },
				},
				signal,
			),
		);
	}
	async #abandon(entry: PaidComputerPrestartRecord, signal: AbortSignal): Promise<void> {
		if (this.#abandoned.has(entry.intent.permitId)) return;
		this.#prestartMachine(entry);
		const terminal = await this.#options.guard.abandonPrestart(entry.intent, signal);
		const receipt = await this.#call(
			"qorpera_abandon_coding_computer_permit",
			{
				schema: "qorpera.computer-abandon/v1",
				requestId: entry.intent.permitId,
				permitId: entry.intent.permitId,
				generation: 1,
				prepareRequestText: entry.intent.prepareRequestText,
				abandonment: terminal.abandonment,
			},
			signal,
		);
		assertComputerAbandonmentReceipt(receipt, terminal);
		await this.#archive(entry.intent.allocationId, entry.intent.permitId, receipt, signal);
		this.#abandoned.add(entry.intent.permitId);
		if (this.#computers.get(entry.intent.allocationId)?.permit.permitId === entry.intent.permitId)
			this.#computers.delete(entry.intent.allocationId);
	}
	async #recoverPrestarts(entries: PaidComputerPrestartRecord[], signal: AbortSignal): Promise<void> {
		const results = await Promise.allSettled([
			...[...this.#pendingArchives].map(([permitId, pending]) =>
				this.#exclusive(pending.allocationId, () =>
					this.#archive(pending.allocationId, permitId, pending.closure, signal),
				),
			),
			...entries
				.filter((entry) => computerPrestartRequest(entry).schema === "qorpera.coding-computer-prepare/v2")
				.map((entry) =>
					this.#exclusive(entry.intent.allocationId, async () => {
						if (this.#terminal.has(entry.intent.permitId)) return;
						const machine = this.#prestartMachine(entry);
						const started = await this.#clock();
						const retained = await this.#history(entry, signal);
						if (retained.state === "closed" || retained.state === "abandoned") {
							if (retained.permit !== null || retained.state === "closed") {
								const permit = this.#checkedPermit(retained.permit, machine, started, true);
								if (
									permit.state !== "closed" ||
									permit.permitId !== entry.intent.permitId ||
									permit.hostBootId !== entry.intent.hostBootId ||
									permit.schema !== "qorpera.computer-usage-permit/v2" ||
									permit.prestart?.guardIncarnationId !== entry.guardIncarnationId ||
									permit.prestart.prepareSha256 !== entry.intent.prepareSha256
								)
									throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
							}
							if (retained.state === "abandoned") {
								const tombstone = await this.#options.guard.prestartStatus(entry.intent.permitId, signal);
								if (
									!tombstone ||
									tombstone.state !== "abandoned" ||
									!isDeepStrictEqual(tombstone.intent, entry.intent) ||
									tombstone.guardIncarnationId !== entry.guardIncarnationId
								)
									throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
								assertComputerAbandonmentReceipt(retained.closure, tombstone);
							}
							await this.#archive(
								entry.intent.allocationId,
								entry.intent.permitId,
								retained.state === "abandoned" ? retained.closure : retained.permit,
								signal,
							);
							this.#terminal.add(entry.intent.permitId);
							if (this.#computers.get(entry.intent.allocationId)?.permit.permitId === entry.intent.permitId)
								this.#computers.delete(entry.intent.allocationId);
							return;
						}
						if (
							entry.state === "abandoned" ||
							(entry.state === "registered" && computerPrestartExpired(entry, started))
						) {
							await this.#abandon(entry, signal);
							return;
						}
						if (retained.state === "absent" && retained.permit === null) return;
						if (retained.state !== "prepared" && retained.state !== "bound")
							throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
						const permit = this.#checkedPermit(retained.permit, machine, started, true);
						if (permit.permitId !== entry.intent.permitId) throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
						const sample = retained.lastSample === null ? null : object(retained.lastSample);
						if (sample && (typeof sample.observationId !== "string" || !UUID.test(sample.observationId)))
							throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
						const current: ManagedComputer = {
							machine,
							permit,
							requestStartedUptimeMs: started.uptimeMs,
							lastObservationId: (sample?.observationId as string | null) ?? null,
							continuity: false,
						};
						const guarded = await this.#options.guard.status(permit.permitId, signal).catch((error: unknown) => {
							if (error instanceof Error && error.message === "PAID_GUARD_PERMIT_MISSING") return null;
							throw error;
						});
						if (guarded?.phase === "stopped") {
							await this.#observe(current, signal, retained);
							return;
						}
						if (!this.#computers.has(machine.machineId)) this.#computers.set(machine.machineId, current);
					}),
				),
		]);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("CODING_COMPUTER_PRESTART_RECOVERY_UNCONFIRMED");
	}
	manages(machineId: string): boolean {
		return this.#computers.has(machineId);
	}
	async ownsStart(machineId: string, signal: AbortSignal): Promise<boolean> {
		return this.manages(machineId) || (await this.#options.guard.hasHistory(machineId, signal));
	}
	#claimId(claim: CodingSessionClaim, machineId: string): string {
		const hash = computerPrestartDigest(JSON.stringify([machineId, claim.workerId, claim.leaseToken]));
		return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	}
	async abandonClaim(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		signal: AbortSignal,
	): Promise<void> {
		await this.#exclusive(machine.machineId, async () => {
			const entry = await this.#options.guard.prestartStatus(this.#claimId(claim, machine.machineId), signal);
			if (!entry || (entry.state !== "registered" && entry.state !== "abandoned")) return;
			await this.#abandon(entry, signal);
		});
	}
	async ensure(
		claim: CodingSessionClaim,
		machine: Readonly<LxdCodingMachineBinding>,
		signal: AbortSignal,
	): Promise<void> {
		await this.#exclusive(machine.machineId, async () => {
			signal.throwIfAborted();
			// The same live claim cannot evade a cancelled attempt with a random ID.
			// The high-entropy lease credential itself never enters retained state.
			const requestId = this.#claimId(claim, machine.machineId);
			let intent = await this.#options.guard.prestartStatus(requestId, signal);
			if (
				intent?.state === "abandoned" ||
				(intent?.state === "registered" && computerPrestartExpired(intent, await this.#clock()))
			) {
				await this.#abandon(intent, signal);
				throw new Error("COMPUTER_START_ABANDONED");
			}
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
				if (!intent) {
					const prepareRequestText = JSON.stringify({
						schema: "qorpera.coding-computer-prepare/v2",
						requestId,
						workerId: claim.workerId,
						machineId: machine.machineId,
						owner: this.#options.owner,
						bindingText: lxdCodingMachinePlan(machine).text,
						machineIdSha256: clock.hostMachineIdSha256,
						hostBootId: clock.hostBootId,
						windowMs: PAID_COMPUTER_WINDOW_MS,
						stopReserveMs: PAID_COMPUTER_STOP_RESERVE_MS,
					});
					intent = await this.#options.guard.registerPrestart(
						{
							schema: "qorpera.computer-prestart-intent/v1",
							permitId: requestId,
							allocationId: machine.machineId,
							instanceSha256: lxdCodingMachinePlan(machine).instanceSha256,
							hostMachineIdSha256: clock.hostMachineIdSha256,
							hostBootId: clock.hostBootId,
							prepareRequestText,
							prepareSha256: computerPrestartDigest(prepareRequestText),
						},
						signal,
					);
				}
				// Prepare is recovered through describe after a lost reply. One server
				// allocation can have only one active permit, even across executors.
				const value = await this.#call(
					"qorpera_prepare_coding_computer_permit",
					{
						...computerPrestartRequest(intent),
						leaseToken: claim.leaseToken,
						prepareRequestText: intent.intent.prepareRequestText,
						prestart: {
							guardIncarnationId: intent.guardIncarnationId,
							prepareSha256: intent.intent.prepareSha256,
						},
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
			if (current.permit.state === "prepared") {
				const retained = await this.#options.guard.prestartStatus(current.permit.permitId, signal);
				if (!retained || retained.state !== "registered") throw new Error("CODING_COMPUTER_PRESTART_REQUIRED");
				if (computerPrestartExpired(retained, await this.#clock())) {
					await this.#abandon(retained, signal);
					throw new Error("COMPUTER_START_ABANDONED");
				}
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
		const guest = await client.readInstanceClock(machine.project, name, signal);
		const after = await client.getInstance(machine.project, name, signal);
		const guestBootId = guest.bootId;
		if (
			!UUID.test(guestBootId) ||
			!after ||
			after.status !== "Running" ||
			after.statusCode !== 103 ||
			after.config["volatile.uuid"] !== physicalId
		)
			throw new Error("CODING_COMPUTER_OBSERVATION_UNCONFIRMED");
		assertLxdCodingMachineInstance(machine, this.#options.storage, after);
		const guestUptimeMs = guest.uptimeMs;
		const completed = await this.#clock();
		if (
			!Number.isSafeInteger(guestUptimeMs) ||
			guestUptimeMs < 0 ||
			completed.hostBootId !== clock.hostBootId ||
			completed.uptimeMs < clock.uptimeMs ||
			completed.uptimeMs - clock.uptimeMs > 1000
		)
			throw new Error("CODING_COMPUTER_OBSERVATION_UNCONFIRMED");
		return { ...sample, physicalId, guestBootId, guestUptimeMs, state: "running" };
	}
	async #observe(current: ManagedComputer, signal: AbortSignal, history?: Record<string, unknown>): Promise<void> {
		const guarded = history
			? await this.#options.guard.status(current.permit.permitId, signal)
			: await this.#options.guard.latest(current.machine.machineId, signal);
		if (!guarded || guarded.permit.permitId !== current.permit.permitId) return;
		if (guarded.phase === "stopping") throw new Error("CODING_COMPUTER_STOP_UNCONFIRMED");
		if (guarded.phase === "stopped" && guarded.permit.schema === "qorpera.computer-usage-permit/v2") {
			const entry = await this.#options.guard.prestartStatus(guarded.permit.permitId, signal);
			if (!entry || !isDeepStrictEqual(this.#prestartMachine(entry), current.machine))
				throw new Error("CODING_COMPUTER_PRESTART_DIFFERS");
			const retained = history ?? (await this.#history(entry, signal));
			const permit = this.#checkedPermit(retained.permit, current.machine, await this.#clock(), true);
			if (retained.state !== permit.state || !["prepared", "bound", "closed"].includes(permit.state))
				throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
			assertPaidComputerTerminalPermit(guarded, permit);
			if (permit.state === "closed") {
				await this.#archive(current.machine.machineId, permit.permitId, retained.permit, signal);
				return;
			}
			const lastSample = retained.lastSample === null ? null : object(retained.lastSample);
			if (lastSample && (typeof lastSample.observationId !== "string" || !UUID.test(lastSample.observationId)))
				throw new Error("CODING_COMPUTER_RECEIPT_INVALID");
			current = {
				...current,
				permit,
				lastObservationId: (lastSample?.observationId as string | null) ?? null,
				continuity: false,
			};
			const managed = this.#computers.get(current.machine.machineId);
			if (!managed || managed.permit.permitId === current.permit.permitId)
				this.#computers.set(current.machine.machineId, current);
		} else if (guarded.phase !== "stopped" && current.permit.generation !== guarded.permit.generation) {
			throw new Error("CODING_COMPUTER_GUARD_GENERATION_DIFFERS");
		}
		const sample = await this.#sample(current, signal, guarded.phase === "stopped" ? guarded : undefined);
		const { evidenceSha256: _evidence, ...facts } = sample;
		sample.evidenceSha256 = createHash("sha256")
			.update(JSON.stringify({ sample: facts, stopReceipt: guarded.stopReceipt }))
			.digest("hex");
		if (guarded.phase === "stopped") {
			const receipt = await this.#call(
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
			const closed = this.#checkedPermit(receipt, current.machine, await this.#clock(), true);
			if (
				closed.state !== "closed" ||
				closed.schema !== current.permit.schema ||
				closed.permitId !== current.permit.permitId ||
				closed.generation !== current.permit.generation ||
				closed.reservationId !== current.permit.reservationId ||
				closed.hostBootId !== current.permit.hostBootId ||
				!isDeepStrictEqual(closed.prestart, current.permit.prestart)
			)
				throw new Error("CODING_COMPUTER_CLOSURE_DIFFERS");
			if (closed.schema === "qorpera.computer-usage-permit/v2")
				await this.#archive(current.machine.machineId, closed.permitId, receipt, signal);
			if (this.#computers.get(current.machine.machineId)?.permit.permitId === current.permit.permitId)
				this.#computers.delete(current.machine.machineId);
			this.#terminal.add(current.permit.permitId);
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
		// Queue history recovery before live-source reads for the same machine.
		// Unrelated allocations still progress independently.
		const recovery = this.#recoverPrestarts(await this.#options.guard.listPrestarts(signal), signal).then(
			() => null,
			(error: unknown) => error,
		);
		// Independent machines progress even when one has a failed observation.
		const results = await Promise.allSettled(
			[...this.#computers.values()].map((entry) =>
				this.#exclusive(entry.machine.machineId, async () => {
					try {
						const managed = this.#computers.get(entry.machine.machineId);
						if (!managed || this.#terminal.has(managed.permit.permitId)) return;
						if (this.#pendingArchives.has(managed.permit.permitId)) return;
						const guarded = await this.#options.guard.latest(entry.machine.machineId, signal);
						const current = await this.#describe(managed.machine, signal, guarded?.phase === "stopped");
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
		const recoveryError = await recovery;
		if (recoveryError) throw recoveryError;
		if (results.some((result) => result.status === "rejected")) throw new Error("CODING_COMPUTER_USAGE_UNCONFIRMED");
	}
}
