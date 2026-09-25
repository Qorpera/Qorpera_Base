import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CodingPaidGuardPort } from "./coding-computer-controller.ts";
import {
	isRuntimePaidComputerMachine,
	PAID_COMPUTER_STOP_RESERVE_MS,
	PAID_COMPUTER_WINDOW_MS,
	type PaidComputerGuardRecord,
	type PaidComputerHostClock,
	type PaidComputerPermit,
	type PaidComputerPrestartRecord,
	parsePaidComputerPermit,
} from "./computer-paid-guard.ts";
import {
	assertComputerAbandonmentReceipt,
	computerPrestartDigest,
	computerPrestartExpired,
	computerPrestartRequest,
} from "./computer-prestart-control.ts";
import type { LxdInspectableClient, LxdOperationReference, LxdTrackedClient } from "./lxd-client.ts";
import { parseLxdProcUptime } from "./lxd-proc-uptime.ts";
import { assertRuntimePaidComputerInstance, type RuntimePaidComputerMachine } from "./runtime-paid-machine.ts";

export type PaidComputerGuardPort = CodingPaidGuardPort;
export interface RuntimeComputerContext {
	allocationId: string;
	providerKind: "native" | "office";
	providerId: string;
	policySha256: string;
	instanceSha256: string;
	bootstrapSha256: string;
	runId: string | null;
	runnerId: string | null;
	officeId: string | null;
	computerGeneration: number | null;
	officeIntent?: Record<string, unknown>;
}
export type RuntimeComputerFunding = { mode: "shadow" } | { mode: "paid"; permit: PaidComputerPermit };
interface ManagedRuntimeComputer {
	context: RuntimeComputerContext;
	permit: PaidComputerPermit;
	requestStartedUptimeMs: number;
	lastObservationId: string | null;
	continuity: boolean;
}
interface RuntimeSample {
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
export interface RuntimeComputerControllerOptions {
	/** This port adds the separately enrolled host secret. Never use the guest's
	 * service JWT alone and never include the secret in a journal/bootstrap. */
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	guard: PaidComputerGuardPort;
	client: Pick<LxdTrackedClient, "getInstance"> & Pick<LxdInspectableClient, "readInstanceFile">;
	clock(): Promise<PaidComputerHostClock>;
	now?: () => number;
}
export const RUNTIME_COMPUTER_RPCS = [
	"qorpera_describe_runtime_computer_permit",
	"qorpera_prepare_runtime_computer_permit",
	"qorpera_bind_runtime_computer_permit",
	"qorpera_checkpoint_runtime_computer_permit",
	"qorpera_renew_runtime_computer_permit",
	"qorpera_finish_runtime_computer_permit",
	"qorpera_abandon_runtime_computer_permit",
	"qorpera_describe_runtime_computer_prestart",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RUNTIME_COMPUTER_RECEIPT_INVALID");
	return value as Record<string, unknown>;
}
/** Network accounting never owns physical expiry. The independent guard keeps
 * stopping the exact VM while this controller or the control plane is absent. */
export class RuntimeComputerController {
	readonly #options: RuntimeComputerControllerOptions;
	readonly #computers = new Map<string, ManagedRuntimeComputer>();
	readonly #work = new Map<string, Promise<unknown>>();
	readonly #abandoned = new Set<string>();
	readonly #terminal = new Set<string>();
	constructor(options: RuntimeComputerControllerOptions) {
		this.#options = options;
	}
	#exclusive<T>(allocationId: string, use: () => Promise<T>): Promise<T> {
		const work = (this.#work.get(allocationId) ?? Promise.resolve()).catch(() => undefined).then(use);
		this.#work.set(allocationId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this.#work.get(allocationId) === work) this.#work.delete(allocationId);
			});
		return work;
	}
	async #call(
		method: (typeof RUNTIME_COMPUTER_RPCS)[number],
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
			!/^[0-9a-f]{64}$/.test(clock.hostMachineIdSha256) ||
			!UUID.test(clock.hostBootId) ||
			!Number.isSafeInteger(clock.uptimeMs) ||
			clock.uptimeMs < 0
		)
			throw new Error("RUNTIME_COMPUTER_CLOCK_INVALID");
		return clock;
	}
	#permit(
		value: unknown,
		context: RuntimeComputerContext,
		clock: PaidComputerHostClock,
		terminal: boolean,
	): PaidComputerPermit {
		const permit = parsePaidComputerPermit(value);
		if (
			permit.allocationId !== context.allocationId ||
			permit.instanceSha256 !== context.instanceSha256 ||
			(!terminal && permit.hostBootId !== clock.hostBootId)
		)
			throw new Error("RUNTIME_COMPUTER_PERMIT_DIFFERS");
		return permit;
	}
	async #describe(
		context: RuntimeComputerContext,
		signal: AbortSignal,
		terminal = false,
	): Promise<{ mode: "shadow" | "paid"; current: ManagedRuntimeComputer | null }> {
		const clock = await this.#clock();
		const data = object(
			await this.#call(
				"qorpera_describe_runtime_computer_permit",
				{
					...context,
					machineIdSha256: clock.hostMachineIdSha256,
					hostBootId: clock.hostBootId,
				},
				signal,
			),
		);
		if (data.mode !== "shadow" && data.mode !== "paid") throw new Error("RUNTIME_COMPUTER_MODE_UNCONFIRMED");
		if (data.permit === null) return { mode: data.mode, current: null };
		if (data.mode !== "paid") throw new Error("RUNTIME_COMPUTER_MODE_UNCONFIRMED");
		const permit = this.#permit(data.permit, context, clock, terminal);
		if (permit.state === "closed") return { mode: "paid", current: null };
		const lastSample = data.lastSample === null ? null : object(data.lastSample);
		if (lastSample && (typeof lastSample.observationId !== "string" || !UUID.test(lastSample.observationId)))
			throw new Error("RUNTIME_COMPUTER_RECEIPT_INVALID");
		return {
			mode: "paid",
			current: {
				context,
				permit,
				requestStartedUptimeMs: clock.uptimeMs,
				lastObservationId: (lastSample?.observationId as string | null) ?? null,
				continuity: false,
			},
		};
	}
	prestartStatus(requestId: string, signal: AbortSignal): Promise<PaidComputerPrestartRecord | null> {
		return this.#options.guard.prestartStatus(requestId, signal);
	}
	#context(entry: PaidComputerPrestartRecord): RuntimeComputerContext {
		const request = computerPrestartRequest(entry);
		if (request.schema !== "qorpera.runtime-computer-prepare/v2")
			throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
		const {
			schema: _schema,
			requestId: _requestId,
			machineIdSha256: _machine,
			hostBootId: _boot,
			windowMs: _window,
			stopReserveMs: _reserve,
			...context
		} = request;
		return context as unknown as RuntimeComputerContext;
	}
	async #abandon(entry: PaidComputerPrestartRecord, signal: AbortSignal): Promise<void> {
		if (this.#abandoned.has(entry.intent.permitId)) return;
		const terminal = await this.#options.guard.abandonPrestart(entry.intent, signal);
		const receipt = await this.#call(
			"qorpera_abandon_runtime_computer_permit",
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
		this.#abandoned.add(entry.intent.permitId);
		if (this.#computers.get(entry.intent.allocationId)?.permit.permitId === entry.intent.permitId)
			this.#computers.delete(entry.intent.allocationId);
	}
	async abandonUndispatched(context: RuntimeComputerContext, requestId: string, signal: AbortSignal): Promise<void> {
		await this.#exclusive(context.allocationId, async () => {
			const entry = await this.#options.guard.prestartStatus(requestId, signal);
			if (!entry || !isDeepStrictEqual(this.#context(entry), context))
				throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
			await this.#abandon(entry, signal);
		});
	}
	async #recoverPrestarts(entries: PaidComputerPrestartRecord[], signal: AbortSignal): Promise<void> {
		const results = await Promise.allSettled(
			entries
				.filter((entry) => computerPrestartRequest(entry).schema === "qorpera.runtime-computer-prepare/v2")
				.map((entry) =>
					this.#exclusive(entry.intent.allocationId, async () => {
						if (this.#terminal.has(entry.intent.permitId)) return;
						const started = await this.#clock();
						const retained = object(
							await this.#call(
								"qorpera_describe_runtime_computer_prestart",
								{
									...computerPrestartRequest(entry),
									prepareRequestText: entry.intent.prepareRequestText,
									prestart: {
										guardIncarnationId: entry.guardIncarnationId,
										prepareSha256: entry.intent.prepareSha256,
									},
								},
								signal,
							),
						);
						if (retained.state === "closed" || retained.state === "abandoned") {
							if (retained.permit !== null || retained.state === "closed") {
								const permit = this.#permit(retained.permit, this.#context(entry), started, true);
								if (
									permit.state !== "closed" ||
									permit.permitId !== entry.intent.permitId ||
									permit.hostBootId !== entry.intent.hostBootId ||
									permit.schema !== "qorpera.computer-usage-permit/v2" ||
									permit.prestart?.guardIncarnationId !== entry.guardIncarnationId ||
									permit.prestart.prepareSha256 !== entry.intent.prepareSha256
								)
									throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
							}
							if (retained.state === "abandoned") {
								const tombstone = await this.#options.guard.prestartStatus(entry.intent.permitId, signal);
								if (
									!tombstone ||
									tombstone.state !== "abandoned" ||
									!isDeepStrictEqual(tombstone.intent, entry.intent) ||
									tombstone.guardIncarnationId !== entry.guardIncarnationId
								)
									throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
								assertComputerAbandonmentReceipt(retained.closure, tombstone);
							}
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
						if (this.#computers.has(entry.intent.allocationId)) return;
						if (retained.state === "absent" && retained.permit === null) return;
						if (retained.state !== "prepared" && retained.state !== "bound")
							throw new Error("RUNTIME_COMPUTER_RECEIPT_INVALID");
						const context = this.#context(entry),
							permit = this.#permit(retained.permit, context, started, true);
						if (permit.permitId !== entry.intent.permitId) throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
						const sample = retained.lastSample === null ? null : object(retained.lastSample);
						if (sample && (typeof sample.observationId !== "string" || !UUID.test(sample.observationId)))
							throw new Error("RUNTIME_COMPUTER_RECEIPT_INVALID");
						this.#computers.set(entry.intent.allocationId, {
							context,
							permit,
							requestStartedUptimeMs: started.uptimeMs,
							lastObservationId: (sample?.observationId as string | null) ?? null,
							continuity: false,
						});
					}),
				),
		);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("RUNTIME_COMPUTER_PRESTART_RECOVERY_UNCONFIRMED");
	}
	/** requestId is a durable launch/resume command identity, retained by the
	 * provider. Recovery describes the committed hold before ever preparing. */
	async ensure(
		context: RuntimeComputerContext,
		requestId: string,
		signal: AbortSignal,
	): Promise<RuntimeComputerFunding> {
		return this.#exclusive(context.allocationId, async () => {
			let intent = await this.#options.guard.prestartStatus(requestId, signal);
			if (intent && !isDeepStrictEqual(this.#context(intent), context))
				throw new Error("RUNTIME_COMPUTER_PRESTART_DIFFERS");
			if (
				intent?.state === "abandoned" ||
				(intent?.state === "registered" && computerPrestartExpired(intent, await this.#clock()))
			) {
				await this.#abandon(intent, signal);
				throw new Error("COMPUTER_START_ABANDONED");
			}
			const guarded = await this.#options.guard.latest(context.allocationId, signal);
			const result = await this.#describe(context, signal, guarded?.phase === "stopped");
			if (result.mode === "shadow") {
				if (intent || (guarded && guarded.phase !== "stopped")) throw new Error("RUNTIME_COMPUTER_MODE_DIFFERS");
				return { mode: "shadow" };
			}
			let current = result.current;
			if (!current) {
				if (guarded && guarded.phase !== "stopped") throw new Error("RUNTIME_COMPUTER_GUARD_UNSETTLED");
				const clock = await this.#clock();
				if (!intent) {
					const prepareRequestText = JSON.stringify({
						...context,
						schema: "qorpera.runtime-computer-prepare/v2",
						requestId,
						machineIdSha256: clock.hostMachineIdSha256,
						hostBootId: clock.hostBootId,
						windowMs: PAID_COMPUTER_WINDOW_MS,
						stopReserveMs: PAID_COMPUTER_STOP_RESERVE_MS,
					});
					intent = await this.#options.guard.registerPrestart(
						{
							schema: "qorpera.computer-prestart-intent/v1",
							permitId: requestId,
							allocationId: context.allocationId,
							instanceSha256: context.instanceSha256,
							hostMachineIdSha256: clock.hostMachineIdSha256,
							hostBootId: clock.hostBootId,
							prepareRequestText,
							prepareSha256: computerPrestartDigest(prepareRequestText),
						},
						signal,
					);
				}
				const receipt = await this.#call(
					"qorpera_prepare_runtime_computer_permit",
					{
						...computerPrestartRequest(intent),
						prepareRequestText: intent.intent.prepareRequestText,
						prestart: {
							guardIncarnationId: intent.guardIncarnationId,
							prepareSha256: intent.intent.prepareSha256,
						},
					},
					signal,
				);
				current = {
					context,
					permit: this.#permit(receipt, context, clock, false),
					requestStartedUptimeMs: clock.uptimeMs,
					lastObservationId: null,
					continuity: false,
				};
			}
			if (current.permit.state === "prepared") {
				if (!intent || current.permit.permitId !== requestId) throw new Error("RUNTIME_COMPUTER_PRESTART_REQUIRED");
			}
			const old = this.#computers.get(context.allocationId);
			current.continuity =
				old?.continuity === true &&
				old.permit.permitId === current.permit.permitId &&
				old.permit.generation === current.permit.generation &&
				old.lastObservationId === current.lastObservationId;
			this.#computers.set(context.allocationId, current);
			return { mode: "paid", permit: current.permit };
		});
	}
	manages(allocationId: string): boolean {
		return this.#computers.has(allocationId);
	}
	async guardRecord(allocationId: string, signal: AbortSignal): Promise<PaidComputerGuardRecord | null> {
		return this.#options.guard.latest(allocationId, signal);
	}
	async assertRunning(allocationId: string, signal: AbortSignal): Promise<void> {
		const current = this.#required(allocationId),
			guarded = await this.#options.guard.latest(allocationId, signal),
			clock = await this.#clock();
		if (
			current.permit.state !== "bound" ||
			!guarded ||
			guarded.permit.permitId !== current.permit.permitId ||
			guarded.phase !== "running" ||
			clock.hostBootId !== current.permit.hostBootId ||
			clock.uptimeMs >= guarded.stopAtUptimeMs
		)
			throw new Error("RUNTIME_COMPUTER_RUNNING_PERMIT_REQUIRED");
	}
	async recover(context: RuntimeComputerContext, signal: AbortSignal): Promise<"shadow" | "paid"> {
		return this.#exclusive(context.allocationId, async () => {
			const guarded = await this.#options.guard.latest(context.allocationId, signal);
			const { current, mode } = await this.#describe(context, signal, guarded?.phase === "stopped");
			if (current) {
				const old = this.#computers.get(context.allocationId);
				current.continuity =
					old?.continuity === true &&
					old.permit.permitId === current.permit.permitId &&
					old.permit.generation === current.permit.generation &&
					old.lastObservationId === current.lastObservationId;
				this.#computers.set(context.allocationId, current);
			} else this.#computers.delete(context.allocationId);
			return mode;
		});
	}
	#required(allocationId: string): ManagedRuntimeComputer {
		const current = this.#computers.get(allocationId);
		if (!current) throw new Error("RUNTIME_COMPUTER_PERMIT_REQUIRED");
		return current;
	}
	async #arm(
		current: ManagedRuntimeComputer,
		target: RuntimePaidComputerMachine["physicalTarget"],
		signal: AbortSignal,
	): Promise<PaidComputerGuardRecord> {
		const clock = await this.#clock();
		const instance = await this.#options.client.getInstance(target.project, target.instanceName, signal);
		if (!instance || !UUID.test(instance.config["volatile.uuid"] ?? ""))
			throw new Error("RUNTIME_COMPUTER_PHYSICAL_ID_INVALID");
		const machine: RuntimePaidComputerMachine = {
			kind: "runtime",
			allocationId: current.context.allocationId,
			nodeId: current.permit.nodeId,
			instanceSha256: current.permit.instanceSha256,
			providerKind: current.context.providerKind,
			physicalTarget: target,
			cpuMillis: current.permit.cpuMillis,
			memoryBytes: current.permit.memoryBytes,
			physicalInstanceId: instance.config["volatile.uuid"],
			hostMachineIdSha256: clock.hostMachineIdSha256,
			hostBootId: current.permit.hostBootId,
		};
		assertRuntimePaidComputerInstance(machine, instance);
		return this.#options.guard.arm(
			{ machine, permit: current.permit, requestStartedUptimeMs: current.requestStartedUptimeMs },
			signal,
		);
	}
	async start(
		allocationId: string,
		target: RuntimePaidComputerMachine["physicalTarget"],
		signal: AbortSignal,
	): Promise<LxdOperationReference> {
		return this.#exclusive(allocationId, async () => {
			const current = this.#required(allocationId),
				armed = await this.#arm(current, target, signal);
			if (
				armed.phase !== "armed" &&
				!((armed.phase === "starting" || armed.phase === "running") && armed.startReference)
			)
				throw new Error("RUNTIME_COMPUTER_START_REQUIRES_RECOVERY");
			return this.#options.guard.start(current.permit.permitId, current.permit.generation, signal);
		});
	}
	async stop(
		allocationId: string,
		signal: AbortSignal,
		target?: RuntimePaidComputerMachine["physicalTarget"],
	): Promise<PaidComputerGuardRecord> {
		let guard = await this.#options.guard.latest(allocationId, signal);
		if (!guard && target) guard = await this.#arm(this.#required(allocationId), target, signal);
		if (!guard || !isRuntimePaidComputerMachine(guard.machine)) throw new Error("RUNTIME_COMPUTER_GUARD_REQUIRED");
		return this.#options.guard.stop(guard.permit.permitId, signal);
	}
	/** Used only at a real stopped/delete boundary, never when replaying a
	 * historical stop event that could precede a newer running generation. */
	async settleStopped(allocationId: string, signal: AbortSignal): Promise<void> {
		await this.#exclusive(allocationId, async () => {
			const current = this.#required(allocationId),
				guarded = await this.#options.guard.latest(allocationId, signal);
			if (
				!guarded ||
				!isRuntimePaidComputerMachine(guarded.machine) ||
				guarded.permit.permitId !== current.permit.permitId
			)
				throw new Error("RUNTIME_COMPUTER_GUARD_DIFFERS");
			const target = guarded.machine.physicalTarget;
			const instance = await this.#options.client.getInstance(target.project, target.instanceName, signal);
			if (instance) {
				assertRuntimePaidComputerInstance(guarded.machine, instance);
				if (instance.status !== "Stopped" || instance.statusCode !== 102)
					throw new Error("RUNTIME_COMPUTER_STOPPED_REQUIRED");
			}
			const closed = await this.#options.guard.stop(guarded.permit.permitId, signal);
			if (closed.phase !== "stopped" || !closed.stopReceipt) throw new Error("RUNTIME_COMPUTER_STOP_UNCONFIRMED");
			await this.#observe(current, signal);
		});
	}
	async #sample(
		current: ManagedRuntimeComputer,
		guarded: PaidComputerGuardRecord,
		signal: AbortSignal,
	): Promise<RuntimeSample> {
		const clock = await this.#clock();
		if (!isRuntimePaidComputerMachine(guarded.machine)) throw new Error("RUNTIME_COMPUTER_GUARD_DIFFERS");
		const sample: RuntimeSample = {
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
		if (guarded.phase === "stopped" && guarded.stopReceipt)
			return { ...sample, physicalId: guarded.machine.physicalInstanceId, state: guarded.stopReceipt.state };
		if (clock.hostBootId !== current.permit.hostBootId) throw new Error("RUNTIME_COMPUTER_HOST_BOOT_CHANGED");
		if (current.permit.state === "bound" && !current.continuity) return sample;
		const machine = guarded.machine,
			target = machine.physicalTarget,
			client = this.#options.client;
		const before = await client.getInstance(target.project, target.instanceName, signal);
		if (!before || before.status !== "Running" || before.statusCode !== 103) return sample;
		assertRuntimePaidComputerInstance(machine, before);
		const boot = await client.readInstanceFile(
			target.project,
			target.instanceName,
			"/proc/sys/kernel/random/boot_id",
			64,
			signal,
		);
		const uptime = await client.readInstanceFile(target.project, target.instanceName, "/proc/uptime", 128, signal);
		const bootAfter = await client.readInstanceFile(
			target.project,
			target.instanceName,
			"/proc/sys/kernel/random/boot_id",
			64,
			signal,
		);
		const after = await client.getInstance(target.project, target.instanceName, signal),
			completed = await this.#clock();
		const guestBootId = boot.content.toString("utf8").trim();
		if (
			[boot, uptime, bootAfter].some((file) => file.uid !== 0 || file.gid !== 0 || file.mode !== 0o444) ||
			!UUID.test(guestBootId) ||
			bootAfter.content.toString("utf8").trim() !== guestBootId ||
			!after ||
			after.status !== "Running" ||
			after.statusCode !== 103 ||
			completed.hostBootId !== clock.hostBootId ||
			completed.uptimeMs < clock.uptimeMs ||
			completed.uptimeMs - clock.uptimeMs > 1000
		)
			throw new Error("RUNTIME_COMPUTER_OBSERVATION_UNCONFIRMED");
		assertRuntimePaidComputerInstance(machine, after);
		return {
			...sample,
			physicalId: machine.physicalInstanceId,
			guestBootId,
			guestUptimeMs: parseLxdProcUptime(uptime.content),
			state: "running",
		};
	}
	async #observe(current: ManagedRuntimeComputer, signal: AbortSignal): Promise<void> {
		let guarded = await this.#options.guard.latest(current.context.allocationId, signal);
		if (!guarded || guarded.permit.permitId !== current.permit.permitId) return;
		if (
			guarded.phase !== "stopped" &&
			guarded.startSettled &&
			guarded.startSucceeded === true &&
			isRuntimePaidComputerMachine(guarded.machine)
		) {
			const target = guarded.machine.physicalTarget;
			const physical = await this.#options.client.getInstance(target.project, target.instanceName, signal);
			if (physical) assertRuntimePaidComputerInstance(guarded.machine, physical);
			if (!physical || (physical.status === "Stopped" && physical.statusCode === 102))
				guarded = await this.#options.guard.stop(guarded.permit.permitId, signal);
		}
		const sample = await this.#sample(current, guarded, signal),
			{ evidenceSha256: _evidence, ...facts } = sample;
		sample.evidenceSha256 = createHash("sha256")
			.update(JSON.stringify({ sample: facts, stopReceipt: guarded.stopReceipt }))
			.digest("hex");
		if (guarded.phase === "stopped") {
			await this.#call(
				"qorpera_finish_runtime_computer_permit",
				{
					permitId: current.permit.permitId,
					generation: current.permit.generation,
					requestId: sample.observationId,
					sample,
					guardClosed: true,
				},
				signal,
			);
			this.#computers.delete(current.context.allocationId);
			this.#terminal.add(current.permit.permitId);
			return;
		}
		if (current.permit.state === "prepared" && sample.state !== "running") return;
		const clock = await this.#clock(),
			renew =
				current.permit.state === "bound" &&
				sample.state === "running" &&
				guarded.stopAtUptimeMs - clock.uptimeMs < 60000;
		await this.#call(
			current.permit.state === "prepared"
				? "qorpera_bind_runtime_computer_permit"
				: renew
					? "qorpera_renew_runtime_computer_permit"
					: "qorpera_checkpoint_runtime_computer_permit",
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
		const refreshed = (await this.#describe(current.context, signal)).current;
		if (!refreshed) throw new Error("RUNTIME_COMPUTER_PERMIT_DISAPPEARED");
		refreshed.continuity = refreshed.lastObservationId === sample.observationId;
		this.#computers.set(current.context.allocationId, refreshed);
		if (renew && isRuntimePaidComputerMachine(guarded.machine))
			await this.#arm(refreshed, guarded.machine.physicalTarget, signal);
	}
	async observe(allocationId: string, signal: AbortSignal): Promise<void> {
		await this.#exclusive(allocationId, async () => {
			try {
				await this.#observe(this.#required(allocationId), signal);
			} catch (error) {
				const current = this.#computers.get(allocationId);
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
		const results = await Promise.allSettled(
			[...this.#computers.values()].map((entry) =>
				this.#exclusive(entry.context.allocationId, async () => {
					try {
						const managed = this.#computers.get(entry.context.allocationId);
						if (!managed || this.#terminal.has(managed.permit.permitId)) return;
						const guarded = await this.#options.guard.latest(entry.context.allocationId, signal);
						const current = (await this.#describe(managed.context, signal, guarded?.phase === "stopped")).current;
						if (!current) {
							this.#computers.delete(entry.context.allocationId);
							return;
						}
						const old = this.#computers.get(entry.context.allocationId);
						current.continuity =
							old?.continuity === true &&
							old.permit.permitId === current.permit.permitId &&
							old.permit.generation === current.permit.generation &&
							old.lastObservationId === current.lastObservationId;
						this.#computers.set(entry.context.allocationId, current);
						if (
							guarded &&
							isRuntimePaidComputerMachine(guarded.machine) &&
							guarded.phase !== "stopped" &&
							guarded.phase !== "stopping" &&
							current.permit.generation > guarded.permit.generation
						)
							await this.#arm(current, guarded.machine.physicalTarget, signal);
						await this.#observe(current, signal);
					} catch (error) {
						const current = this.#computers.get(entry.context.allocationId);
						if (current) current.continuity = false;
						throw error;
					}
				}),
			),
		);
		const recoveryError = await recovery;
		if (recoveryError) throw recoveryError;
		if (results.some((result) => result.status === "rejected")) throw new Error("RUNTIME_COMPUTER_USAGE_UNCONFIRMED");
	}
}
