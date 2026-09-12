import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import { LxdUnixClient } from "./lxd-client.ts";
import { LxdOfficeActivationWorker } from "./lxd-office-activation-worker.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { LxdOfficeAdoptionWorker } from "./lxd-office-adoption-worker.ts";
import { LxdOfficeBootActivationWorker } from "./lxd-office-boot-activation-worker.ts";
import { LxdOfficeBootConfigurationWorker } from "./lxd-office-boot-configuration-worker.ts";
import { LxdOfficeBootWorker } from "./lxd-office-boot-worker.ts";
import { LxdOfficeConfigurationWorker } from "./lxd-office-configuration-worker.ts";
import { observeLxdOfficeControlJournals } from "./lxd-office-control-observer.ts";
import { LxdOfficeCreationWorker } from "./lxd-office-creation-worker.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { LxdOfficeInventoryWorker } from "./lxd-office-inventory-worker.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";
import {
	LxdOfficeLifecycleJournal,
	type LxdOfficeLifecyclePhase,
	OFFICE_LIFECYCLE_PHASES,
	parseLxdOfficeLifecycleRequest,
} from "./lxd-office-lifecycle-journal.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import {
	lxdOfficePhysicalPolicySha256,
	officePhysicalPath,
	parseLxdOfficePhysicalPolicy,
} from "./lxd-office-physical-policy.ts";
import { LxdOfficePowerOffWorker } from "./lxd-office-power-off-worker.ts";
import { LxdOfficePreparationWorker } from "./lxd-office-preparation-worker.ts";
import { LxdOfficeProviderControl } from "./lxd-office-provider-control.ts";
import type { LxdOfficeLifecycleRegistry } from "./lxd-office-provider-registry.ts";
import { readLxdOfficeResetPlan } from "./lxd-office-reset-journal.ts";
import { LxdOfficeResetWorker } from "./lxd-office-reset-worker.ts";
import { LxdOfficeResumeWorker } from "./lxd-office-resume-worker.ts";
import { LxdOfficeServiceStopWorker } from "./lxd-office-service-stop-worker.ts";
import type { LxdOfficeSoftwareLaneOptions } from "./lxd-office-software-lane.ts";
import { createLxdOfficeInvocationMeasurement } from "./lxd-office-software-transport.ts";
import { type OfficeInventoryLimits, parseOfficeInventoryLimits } from "./lxd-office-storage-inventory.ts";
import { LxdOfficeSuccessorWorker } from "./lxd-office-successor-worker.ts";

interface Workers {
	creation: Pick<LxdOfficeCreationWorker, "reconcileSettled">;
	inventory: Pick<LxdOfficeInventoryWorker, "inspectSettled">;
	adoption: Pick<LxdOfficeAdoptionWorker, "copySettled">;
	boot: Pick<LxdOfficeBootWorker, "reconcileSettled">;
	preparation: Pick<LxdOfficePreparationWorker, "reconcileSettled">;
	configuration: Pick<LxdOfficeConfigurationWorker, "reconcileSettled">;
	activation: Pick<LxdOfficeActivationWorker, "reconcileSettled">;
}
interface Options {
	planPath: string;
	inventoryLimits: OfficeInventoryLimits;
	/** Enrolled software lane: successor and boot activations must measure the
	 * expected revision before activation; an optional signed plan reserves the
	 * pending update's successor identity. Absent for unenrolled offices. */
	software?: Readonly<LxdOfficeSoftwareLaneOptions>;
}
interface Ports {
	workers?: Workers;
	stopWorker?: Pick<LxdOfficeServiceStopWorker, "reconcileSettled">;
	successorWorker?: Pick<LxdOfficeSuccessorWorker, "reconcileSettled">;
	powerOffWorker?: Pick<LxdOfficePowerOffWorker, "reconcileSettled">;
	resumeWorker?: Pick<LxdOfficeResumeWorker, "reconcileSettled">;
	bootConfigurationWorker?: Pick<LxdOfficeBootConfigurationWorker, "reconcileSettled">;
	bootActivationWorker?: Pick<LxdOfficeBootActivationWorker, "reconcileSettled">;
	resetWorker?: Pick<LxdOfficeResetWorker, "reconcileSettled">;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	readProtected?: typeof readLxdOfficeProtectedFile;
	measureInvocation?: LxdOfficeInvocationMeasurement;
}
export interface LxdOfficeLifecycleResult {
	state:
		| "idle"
		| "held"
		| "progressed"
		| "awaiting_review"
		| "pending"
		| "unknown"
		| "failed"
		| "capacity_refused"
		| "awaiting_readiness"
		| "powered_off"
		| "awaiting_configuration"
		| "awaiting_boot_admission"
		| "active";
	phase?:
		| LxdOfficeLifecyclePhase
		| "service_stop"
		| "service_restart"
		| "power_off"
		| "resume"
		| "boot_configuration"
		| "boot_activation"
		| "reset";
	intentId?: string;
	observationSha256?: string;
	transitionId?: string;
	acknowledgedAtMs?: number;
	activationId?: string;
	resetId?: string;
	resetPhase?: string;
	reason?: string;
}
const pending = new Set<string>();

/** One enrolled office, serialized under a process-owned kernel lock. Each
 * call runs at most one phase and awaits its actual worker settlement. The
 * immutable forward journal is a dispatch fence, not physical/cloud proof.
 * Existing component journals without that fence fail closed. No client
 * connection, timer expiry, error or shutdown releases capacity or deletes VM
 * or company bytes. open() wires concrete workers; ports are trusted tests. */
export class LxdOfficeLifecycle {
	readonly observationIdentity: Readonly<{
		companyId: string;
		environmentId: string;
		companyComputerId: string;
		logicalComputerId: string;
		computerGeneration: number;
		providerId: string;
		providerPolicySha256: string;
		machineIdSha256: string;
		guestPackageManifestSha256: string;
	}>;
	readonly #root: string;
	readonly #operationClient: LxdUnixClient;
	readonly #configSha: string;
	readonly #planPath: string;
	readonly #provider: LxdOfficeProviderControl;
	readonly #workers: Workers;
	readonly #stopWorker: Pick<LxdOfficeServiceStopWorker, "reconcileSettled">;
	readonly #successorWorker: Pick<LxdOfficeSuccessorWorker, "reconcileSettled">;
	readonly #powerOffWorker: Pick<LxdOfficePowerOffWorker, "reconcileSettled">;
	readonly #resumeWorker: Pick<LxdOfficeResumeWorker, "reconcileSettled">;
	readonly #bootConfigurationWorker: Pick<LxdOfficeBootConfigurationWorker, "reconcileSettled">;
	readonly #bootActivationWorker: Pick<LxdOfficeBootActivationWorker, "reconcileSettled">;
	readonly #resetWorker: Pick<LxdOfficeResetWorker, "reconcileSettled">;
	readonly #kernelLock;
	readonly #readProtected;
	#activeIntent: string | undefined;
	#activeRecovery: { intentId: string; transitionId: string; activationId: string } | undefined;
	#activeBoot: { intentId: string; transitionId: string; activationId: string; stageSha256: string } | undefined;
	#activeReset: { intentId: string; transitionId: string; resetId: string; activationId: string } | undefined;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check" | "inspect">,
		registry: LxdOfficeLifecycleRegistry,
		options: Options,
		ports: Ports = {},
	) {
		const policy = parseLxdOfficePhysicalPolicy(gate.policy),
			g = policy.guest;
		const limits = parseOfficeInventoryLimits(options.inventoryLimits);
		this.#root = policy.journal.path;
		this.#operationClient = new LxdUnixClient(policy.host.socketPath);
		this.#planPath = officePhysicalPath(options.planPath);
		const providerPolicySha256 = lxdOfficePhysicalPolicySha256(policy);
		this.observationIdentity = Object.freeze({
			companyId: g.companyId,
			environmentId: g.environmentId,
			companyComputerId: g.companyComputerId,
			logicalComputerId: g.logicalComputerId,
			computerGeneration: g.computerGeneration,
			providerId: g.providerId,
			providerPolicySha256,
			machineIdSha256: policy.host.machineIdSha256,
			guestPackageManifestSha256: policy.image.guestPackageManifestSha256,
		});
		const software = options.software;
		// Identity only: the plan digest and public pins, never the capability.
		// The software lane is not part of the lifecycle journal's configuration
		// identity: its plan, revision and pins are bound by SQL and the signed
		// documents, and a retained journal must stay readable when a lane is
		// added or a revision advances.
		this.#configSha = officeDigest({ providerPolicySha256, inventoryLimits: limits, planPath: this.#planPath });
		this.#provider = new LxdOfficeProviderControl(
			{
				companyId: g.companyId,
				environmentId: g.environmentId,
				companyComputerId: g.companyComputerId,
				logicalComputerId: g.logicalComputerId,
				computerGeneration: g.computerGeneration,
				providerId: g.providerId,
				providerPolicySha256,
				imageFingerprint: g.imageFingerprint,
				bootstrapSha256: g.bootstrapSha256,
			},
			registry,
		);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#readProtected = ports.readProtected ?? readLxdOfficeProtectedFile;
		this.#stopWorker = ports.stopWorker ?? new LxdOfficeServiceStopWorker(gate, registry);
		const measureInvocation =
			ports.measureInvocation ??
			(software
				? createLxdOfficeInvocationMeasurement({
						root: this.#root,
						client: this.#operationClient,
						registry,
						binding: (allocationId) => ({
							schema: "qorpera.lxd-office-guest/v2",
							...g,
							allocationId,
							providerPolicySha256,
						}),
						providerCapability: software.providerCapability,
						expectedRevision: software.expectedRevision,
						expectedService: software.expectedService,
						measurementToolSha256: software.measurementToolSha256,
					})
				: undefined);
		this.#successorWorker =
			ports.successorWorker ??
			new LxdOfficeSuccessorWorker(gate, registry, { softwarePlan: software?.plan, measureInvocation });
		this.#powerOffWorker = ports.powerOffWorker ?? new LxdOfficePowerOffWorker(gate, registry);
		this.#resumeWorker = ports.resumeWorker ?? new LxdOfficeResumeWorker(gate, registry);
		this.#bootConfigurationWorker =
			ports.bootConfigurationWorker ?? new LxdOfficeBootConfigurationWorker(gate, registry);
		this.#bootActivationWorker =
			ports.bootActivationWorker ?? new LxdOfficeBootActivationWorker(gate, registry, { measureInvocation });
		// The reset worker composes its guest successor lane on its own client;
		// only the enrolled software measurement is shared with the other lanes.
		this.#resetWorker = ports.resetWorker ?? new LxdOfficeResetWorker(gate, registry, { measureInvocation });
		this.#workers = ports.workers ?? {
			creation: new LxdOfficeCreationWorker(gate, registry),
			inventory: new LxdOfficeInventoryWorker(gate, registry, limits),
			adoption: new LxdOfficeAdoptionWorker(gate, registry, limits),
			boot: new LxdOfficeBootWorker(gate, registry),
			preparation: new LxdOfficePreparationWorker(gate, registry),
			configuration: new LxdOfficeConfigurationWorker(gate, registry),
			activation: new LxdOfficeActivationWorker(gate, registry, registry),
		};
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeLifecycleRegistry,
		options: Options,
		signal: AbortSignal,
	) {
		return new LxdOfficeLifecycle(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
			options,
		);
	}
	async observeControlOperations(signal: AbortSignal): Promise<void> {
		await this.#kernelLock(this.#root);
		await observeLxdOfficeControlJournals(this.#root, this.#operationClient, signal);
	}
	async reconcile(caller: AbortSignal): Promise<LxdOfficeLifecycleResult> {
		caller.throwIfAborted();
		if (pending.has(this.#root)) throw new Error("OFFICE_LIFECYCLE_PENDING");
		pending.add(this.#root);
		try {
			return await this.#run(AbortSignal.any([caller, AbortSignal.timeout(300000)]));
		} catch (error) {
			this.#activeIntent = undefined;
			this.#activeRecovery = undefined;
			this.#activeBoot = undefined;
			this.#activeReset = undefined;
			throw new Error("OFFICE_LIFECYCLE_UNCONFIRMED", { cause: error });
		} finally {
			pending.delete(this.#root);
		}
	}
	async #run(signal: AbortSignal): Promise<LxdOfficeLifecycleResult> {
		await this.#kernelLock(this.#root);
		signal.throwIfAborted();
		const status = await this.#provider.status(signal);
		if (status.officeState !== "active") {
			this.#activeIntent = undefined;
			this.#activeRecovery = undefined;
			this.#activeBoot = undefined;
			this.#activeReset = undefined;
		}
		if (!status.intent) return { state: "idle" };
		const intentId = status.intent.intentId;
		if (status.intent.state === "cancelled" || status.officeState === "retired") return { state: "held", intentId };
		// Fixed sibling of the protected installation plan. Its explicit retained
		// request binds explicit recovery. Stop stays available after preparation
		// disable; same-boot restart requires fresh enabled SQL authority. Retain
		// this plan for process recovery; deleting it cannot undo maintenance.
		let recovery: ReturnType<typeof parseCompanyComputerLifecycleRequest> | undefined;
		try {
			const envelope = officeRecord(
				JSON.parse(
					new TextDecoder("utf8", { fatal: true }).decode(
						await this.#readProtected(`${this.#planPath}.recovery`, 65536),
					),
				),
				["schema", "request"],
			);
			if (envelope.schema !== "qorpera.lxd-office-recovery-plan/v1") throw new Error("recovery plan");
			recovery = parseCompanyComputerLifecycleRequest(envelope.request);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (!recovery && status.officeState === "maintenance") return { state: "held", intentId };
		// Disabled preparation permits only checking a previously active office.
		if (!recovery && !status.preparationEnabled && status.officeState !== "active")
			return { state: "held", intentId };
		const journal = await LxdOfficeLifecycleJournal.open(
			this.#root,
			intentId,
			this.#configSha,
			status.reservation !== null,
		);
		const { phase, context } = journal;
		if (
			(context.allocationId !== null && context.allocationId !== status.reservation?.allocationId) ||
			(status.officeState === "active" && phase !== "activation")
		)
			throw new Error("phase authority");
		if (recovery) {
			this.#activeIntent = undefined;
			if (
				phase !== "activation" ||
				!context.request ||
				!status.reservation ||
				!["active", "maintenance"].includes(status.officeState) ||
				recovery.startup.allocationId !== status.reservation.allocationId
			)
				throw new Error("recovery phase authority");
			const stageName = `recovery-stage-${status.reservation.allocationId}-${recovery.transitionId}.json`;
			let stage: unknown;
			try {
				stage = (await readRecord(join(this.#root, stageName))).value;
			} catch (error) {
				if (!code(error, "ENOENT")) throw error;
			}
			if (stage !== undefined) {
				const retained = officeRecord(stage, [
					"schema",
					"intentId",
					"allocationId",
					"request",
					"stopCommandId",
					"acknowledgedAtMs",
				]);
				if (
					retained.schema !== "qorpera.lxd-office-recovery-stage/v1" ||
					retained.intentId !== intentId ||
					retained.allocationId !== status.reservation.allocationId ||
					!isDeepStrictEqual(retained.request, recovery) ||
					typeof retained.stopCommandId !== "string" ||
					!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
						retained.stopCommandId,
					) ||
					!Number.isSafeInteger(retained.acknowledgedAtMs) ||
					(retained.acknowledgedAtMs as number) < 1
				)
					throw new Error("recovery stage changed");
				if (recovery.action === "replace") {
					// Root replacement only under an explicit protected reset plan that
					// binds this exact retained replace request. Without it the stopped
					// office remains held; the plan grants no dispatch by itself.
					this.#activeRecovery = undefined;
					this.#activeBoot = undefined;
					const reset = await readLxdOfficeResetPlan(this.#readProtected, this.#planPath, recovery);
					if (!reset)
						return { state: "held", phase: "service_stop", intentId, transitionId: recovery.transitionId };
					const active = this.#activeReset;
					if (
						active?.intentId === intentId &&
						active.transitionId === recovery.transitionId &&
						active.resetId === reset.plan.resetId &&
						status.officeState === "active"
					)
						return {
							state: "active",
							phase: "reset",
							intentId,
							transitionId: recovery.transitionId,
							activationId: active.activationId,
							resetId: active.resetId,
							resetPhase: "active",
						};
					this.#activeReset = undefined;
					const result = await this.#resetWorker.reconcileSettled(
						{
							intentId,
							plan: reset.plan,
							planSha256: reset.planSha256,
							serviceBootstrapPath: context.request.serviceBootstrapPath,
						},
						signal,
					);
					signal.throwIfAborted();
					if (
						result.intentId !== intentId ||
						result.transitionId !== recovery.transitionId ||
						result.allocationId !== status.reservation.allocationId ||
						result.resetId !== reset.plan.resetId ||
						result.activationId !== reset.plan.successorActivationId
					)
						throw new Error("reset result differs");
					if (result.state === "active")
						this.#activeReset = {
							intentId,
							transitionId: recovery.transitionId,
							resetId: result.resetId,
							activationId: result.activationId,
						};
					return {
						state: result.state,
						phase: "reset",
						intentId,
						transitionId: recovery.transitionId,
						activationId: result.activationId,
						resetId: result.resetId,
						resetPhase: result.phase,
						...(result.reason === undefined ? {} : { reason: result.reason }),
					};
				}
				if (["power_off", "reboot"].includes(recovery.action)) {
					this.#activeRecovery = undefined;
					const suffix = `${status.reservation.allocationId}-${recovery.transitionId}`,
						bootStageName = `recovery-boot-stage-${suffix}.json`;
					let bootStage: unknown, resume: ReturnType<typeof parseCompanyComputerBootIntentRequest> | undefined;
					try {
						bootStage = (await readRecord(join(this.#root, bootStageName), 65536)).value;
					} catch (error) {
						if (!code(error, "ENOENT")) throw error;
					}
					try {
						const plan = officeRecord(
							JSON.parse(
								new TextDecoder("utf8", { fatal: true }).decode(
									await this.#readProtected(`${this.#planPath}.resume`, 65536),
								),
							),
							["schema", "request"],
						);
						if (plan.schema !== "qorpera.lxd-office-resume-plan/v1") throw new Error("resume plan invalid");
						resume = parseCompanyComputerBootIntentRequest(plan.request);
						if (!isDeepStrictEqual(resume.predecessor, recovery)) throw new Error("resume plan differs");
					} catch (error) {
						if (!code(error, "ENOENT")) throw error;
					}
					if (bootStage !== undefined) {
						const saved = officeRecord(bootStage, [
							"schema",
							"intentId",
							"allocationId",
							"request",
							"powerOffCommandId",
						]);
						if (
							!resume ||
							!isDeepStrictEqual(saved, {
								schema: "qorpera.lxd-office-recovery-boot-stage/v1",
								intentId,
								allocationId: status.reservation.allocationId,
								request: resume,
								powerOffCommandId: saved.powerOffCommandId,
							}) ||
							typeof saved.powerOffCommandId !== "string" ||
							!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
								saved.powerOffCommandId,
							)
						)
							throw new Error("resume stage differs");
						const configurationStageName = `recovery-configuration-stage-${suffix}.json`,
							activationStageName = `recovery-boot-activation-stage-${suffix}.json`,
							activationSuffix = `${status.reservation.allocationId}-${resume.activationId}`,
							activationPaths = [
								activationStageName,
								`boot-service-start-${activationSuffix}`,
								...["request", "prepared", "completed"].map(
									(kind) => `boot-successor-${kind}-${activationSuffix}.json`,
								),
								...["request", "intent"].map((kind) => `boot-service-start-${kind}-${activationSuffix}.json`),
							];
						let configurationStage: unknown;
						try {
							configurationStage = (await readRecord(join(this.#root, configurationStageName), 65536)).value;
						} catch (error) {
							if (!code(error, "ENOENT")) throw error;
						}
						const configurationRequest = {
							intentId,
							request: resume,
							serviceBootstrapPath: context.request.serviceBootstrapPath,
						};
						if (configurationStage !== undefined) {
							const next = officeRecord(configurationStage, [
								"schema",
								"input",
								"startCommandId",
								"bootId",
								"bootObservationSha256",
							]);
							const command = parseCompanyComputerPreparationCommand({
								commandId: next.startCommandId,
								bootId: next.bootId,
								requestSha256: next.bootObservationSha256,
							});
							if (
								next.schema !== "qorpera.lxd-office-recovery-configuration-stage/v1" ||
								!isDeepStrictEqual(next.input, configurationRequest) ||
								command.bootId === recovery.startup.bootId
							)
								throw new Error("configuration stage differs");
							let activationStage: unknown;
							try {
								activationStage = (await readRecord(join(this.#root, activationStageName), 65536)).value;
							} catch (error) {
								if (!code(error, "ENOENT")) throw error;
							}
							if (activationStage !== undefined) {
								const admitted = officeRecord(activationStage, [
									"schema",
									"input",
									"bootId",
									"configurationCommandId",
									"configurationRequestSha256",
									"configurationObservationSha256",
									"bootObservationSha256",
								]);
								const configured = parseCompanyComputerPreparationCommand({
									commandId: admitted.configurationCommandId,
									bootId: admitted.bootId,
									requestSha256: admitted.configurationRequestSha256,
								});
								const observationSha256 = officeSha(admitted.configurationObservationSha256);
								if (
									admitted.schema !== "qorpera.lxd-office-recovery-boot-activation-stage/v1" ||
									!isDeepStrictEqual(admitted.input, configurationRequest) ||
									configured.bootId !== command.bootId ||
									admitted.bootObservationSha256 !== command.requestSha256
								)
									throw new Error("boot activation stage differs");
								const stageSha256 = officeDigest(admitted),
									active = this.#activeBoot;
								if (
									active?.intentId === intentId &&
									active.transitionId === recovery.transitionId &&
									active.activationId === resume.activationId &&
									active.stageSha256 === stageSha256 &&
									status.officeState === "active"
								)
									return {
										state: "active",
										phase: "boot_activation",
										intentId,
										transitionId: recovery.transitionId,
										activationId: resume.activationId,
									};
								this.#activeBoot = undefined;
								const result = await this.#bootActivationWorker.reconcileSettled(configurationRequest, signal);
								signal.throwIfAborted();
								if (
									result.intentId !== intentId ||
									result.allocationId !== status.reservation.allocationId ||
									result.bootIntentId !== resume.bootIntentId ||
									result.activationId !== resume.activationId ||
									result.bootId !== configured.bootId ||
									result.configurationObservationSha256 !== observationSha256
								)
									throw new Error("boot activation result differs");
								if (result.state === "active")
									this.#activeBoot = {
										intentId,
										transitionId: recovery.transitionId,
										activationId: resume.activationId,
										stageSha256,
									};
								return {
									state: result.state,
									phase: "boot_activation",
									intentId,
									transitionId: recovery.transitionId,
									activationId: resume.activationId,
								};
							}
							for (const path of activationPaths.slice(1)) {
								try {
									await lstat(join(this.#root, path));
									throw new Error("boot activation stage lost");
								} catch (error) {
									if (!code(error, "ENOENT")) throw error;
								}
							}
							const result = await this.#bootConfigurationWorker.reconcileSettled(configurationRequest, signal);
							signal.throwIfAborted();
							if (
								result.intentId !== intentId ||
								result.allocationId !== status.reservation.allocationId ||
								result.bootIntentId !== resume.bootIntentId ||
								result.activationId !== resume.activationId ||
								result.bootId !== command.bootId ||
								result.resumeStartCommandId !== command.commandId ||
								result.bootObservationSha256 !== command.requestSha256
							)
								throw new Error("configuration result differs");
							if (result.state === "awaiting_boot_admission") {
								const configured = parseCompanyComputerPreparationCommand({
									commandId: result.commandId,
									bootId: result.bootId,
									requestSha256: result.requestSha256,
								});
								const admitted = {
									schema: "qorpera.lxd-office-recovery-boot-activation-stage/v1",
									input: configurationRequest,
									bootId: configured.bootId,
									configurationCommandId: configured.commandId,
									configurationRequestSha256: configured.requestSha256,
									configurationObservationSha256: officeSha(result.observationSha256),
									bootObservationSha256: command.requestSha256,
								};
								await this.#kernelLock(this.#root);
								signal.throwIfAborted();
								await publish(this.#root, activationStageName, Buffer.from(JSON.stringify(admitted)));
								if (
									!isDeepStrictEqual(
										(await readRecord(join(this.#root, activationStageName), 65536)).value,
										admitted,
									)
								)
									throw new Error("boot activation stage conflict");
								return {
									state: "progressed",
									phase: "boot_configuration",
									intentId,
									transitionId: recovery.transitionId,
									activationId: resume.activationId,
								};
							}
							return {
								state: result.state,
								phase: "boot_configuration",
								intentId,
								transitionId: recovery.transitionId,
								activationId: result.activationId,
							};
						}
						for (const path of [
							...activationPaths,
							`boot-configuration-${status.reservation.allocationId}-${resume.activationId}`,
							...["intent", "observation", "completed"].map(
								(kind) =>
									`boot-configuration-${kind}-${recovery.startup.allocationId}-${resume.activationId}.json`,
							),
						]) {
							try {
								await lstat(join(this.#root, path));
								throw new Error("configuration stage lost");
							} catch (error) {
								if (!code(error, "ENOENT")) throw error;
							}
						}
						const result = await this.#resumeWorker.reconcileSettled(intentId, resume, signal);
						signal.throwIfAborted();
						if (
							result.intentId !== intentId ||
							result.allocationId !== status.reservation.allocationId ||
							result.bootIntentId !== resume.bootIntentId ||
							result.activationId !== resume.activationId
						)
							throw new Error("resume result differs");
						if (result.state === "awaiting_configuration") {
							const command = parseCompanyComputerPreparationCommand({
								commandId: result.startCommandId,
								bootId: result.bootId,
								requestSha256: officeSha(result.bootObservationSha256),
							});
							if (command.bootId === recovery.startup.bootId) throw new Error("resume boot differs");
							const next = {
								schema: "qorpera.lxd-office-recovery-configuration-stage/v1",
								input: configurationRequest,
								startCommandId: command.commandId,
								bootId: command.bootId,
								bootObservationSha256: command.requestSha256,
							};
							await this.#kernelLock(this.#root);
							signal.throwIfAborted();
							await publish(this.#root, configurationStageName, Buffer.from(JSON.stringify(next)));
							if (
								!isDeepStrictEqual(
									(await readRecord(join(this.#root, configurationStageName), 65536)).value,
									next,
								)
							)
								throw new Error("configuration stage conflict");
							return {
								state: "progressed",
								phase: "resume",
								intentId,
								transitionId: recovery.transitionId,
								activationId: result.activationId,
							};
						}
						return {
							state: result.state,
							phase: "resume",
							intentId,
							transitionId: recovery.transitionId,
							activationId: result.activationId,
						};
					}
					for (const prefix of ["resume-request", "resume-prepared", "resume-observation", "resume-completed"]) {
						try {
							await lstat(join(this.#root, `${prefix}-${suffix}.json`));
							throw new Error("resume stage lost");
						} catch (error) {
							if (!code(error, "ENOENT")) throw error;
						}
					}
					const result = await this.#powerOffWorker.reconcileSettled(intentId, recovery, signal);
					signal.throwIfAborted();
					if (
						result.intentId !== intentId ||
						result.transitionId !== recovery.transitionId ||
						result.allocationId !== status.reservation.allocationId
					)
						throw new Error("power-off result differs");
					if (resume && result.state === "powered_off") {
						const next = {
							schema: "qorpera.lxd-office-recovery-boot-stage/v1",
							intentId,
							allocationId: result.allocationId,
							request: resume,
							powerOffCommandId: result.commandId,
						};
						await this.#kernelLock(this.#root);
						signal.throwIfAborted();
						await publish(this.#root, bootStageName, Buffer.from(JSON.stringify(next)));
						if (!isDeepStrictEqual((await readRecord(join(this.#root, bootStageName), 65536)).value, next))
							throw new Error("resume stage conflict");
						return { state: "progressed", phase: "power_off", intentId, transitionId: result.transitionId };
					}
					return { state: result.state, phase: "power_off", intentId, transitionId: result.transitionId };
				}
				if (
					this.#activeRecovery?.intentId === intentId &&
					this.#activeRecovery.transitionId === recovery.transitionId &&
					status.officeState === "active"
				)
					return { state: "active", phase: "service_restart", ...this.#activeRecovery };
				this.#activeRecovery = undefined;
				const result = await this.#successorWorker.reconcileSettled(intentId, recovery, signal);
				signal.throwIfAborted();
				if (
					result.intentId !== intentId ||
					result.transitionId !== recovery.transitionId ||
					result.allocationId !== status.reservation.allocationId
				)
					throw new Error("successor result differs");
				if (result.state === "active")
					this.#activeRecovery = {
						intentId,
						transitionId: recovery.transitionId,
						activationId: result.activationId,
					};
				return {
					state: result.state,
					phase: "service_restart",
					intentId,
					transitionId: result.transitionId,
					activationId: result.activationId,
				};
			}
			this.#activeRecovery = undefined;
			// A lost forward fence cannot call stop against a predecessor that SQL
			// may already have superseded. The successor worker owns its evidence.
			for (const name of [
				`successor-request-${status.reservation.allocationId}-${recovery.transitionId}.json`,
				`successor-prepared-${status.reservation.allocationId}-${recovery.transitionId}.json`,
				`power-off-request-${status.reservation.allocationId}-${recovery.transitionId}.json`,
				`power-off-completed-${status.reservation.allocationId}-${recovery.transitionId}.json`,
				`recovery-boot-stage-${status.reservation.allocationId}-${recovery.transitionId}.json`,
				`resume-request-${status.reservation.allocationId}-${recovery.transitionId}.json`,
			]) {
				try {
					await lstat(join(this.#root, name));
					throw new Error("recovery stage missing");
				} catch (error) {
					if (!code(error, "ENOENT")) throw error;
				}
			}
			const result = await this.#stopWorker.reconcileSettled(intentId, recovery, signal);
			signal.throwIfAborted();
			// A replace stop advances to the reset stage only under an explicit
			// protected reset plan; otherwise it stays held after the stop.
			const forward =
				["service_restart", "power_off", "reboot"].includes(recovery.action) ||
				(recovery.action === "replace" &&
					(await readLxdOfficeResetPlan(this.#readProtected, this.#planPath, recovery)) !== undefined);
			if (result.state === "stopped" && forward) {
				if (
					result.intentId !== intentId ||
					result.transitionId !== recovery.transitionId ||
					result.allocationId !== status.reservation.allocationId ||
					result.acknowledgedAtMs === undefined
				)
					throw new Error("stop result differs");
				const next = {
					schema: "qorpera.lxd-office-recovery-stage/v1",
					intentId,
					allocationId: result.allocationId,
					request: recovery,
					stopCommandId: result.commandId,
					acknowledgedAtMs: result.acknowledgedAtMs,
				};
				await this.#kernelLock(this.#root);
				signal.throwIfAborted();
				await publish(this.#root, stageName, Buffer.from(JSON.stringify(next)));
				if (!isDeepStrictEqual((await readRecord(join(this.#root, stageName))).value, next))
					throw new Error("recovery stage conflict");
				return {
					state: "progressed",
					phase: "service_stop",
					intentId,
					transitionId: result.transitionId,
					acknowledgedAtMs: result.acknowledgedAtMs,
				};
			}
			return {
				state: result.state === "stopped" ? "held" : result.state,
				phase: "service_stop",
				intentId,
				transitionId: result.transitionId,
				...(result.acknowledgedAtMs === undefined ? {} : { acknowledgedAtMs: result.acknowledgedAtMs }),
			};
		}
		// A lost suffix cannot roll back across a physical dispatch whose reply
		// (or SQL activation) was lost. Presence only fences earlier phases; the
		// selected worker still validates every byte of its own evidence.
		if (status.reservation) {
			const id = status.reservation.allocationId;
			const hints: [LxdOfficeLifecyclePhase, string[]][] = [
				["boot", [`boot-intent-${id}.json`, `boot-completed-${id}.json`]],
				[
					"preparation",
					[
						`preparation-intent-${id}.json`,
						`preparation-request-${id}.json`,
						`preparation-${id}`,
						`preparation-completed-${id}.json`,
					],
				],
				[
					"configuration",
					[`configuration-intent-${id}.json`, `configuration-${id}`, `configuration-completed-${id}.json`],
				],
				[
					"activation",
					[
						`activation-request-${id}.json`,
						`activation-intent-${id}.json`,
						`service-start-${id}`,
						`activation-completed-${id}.json`,
					],
				],
			];
			for (const [later, paths] of hints) {
				if (OFFICE_LIFECYCLE_PHASES.indexOf(later) <= OFFICE_LIFECYCLE_PHASES.indexOf(phase)) continue;
				for (const path of paths) {
					try {
						await lstat(join(this.#root, path));
						throw new Error("physical phase exceeds journal");
					} catch (error) {
						if (!code(error, "ENOENT")) throw error;
					}
				}
			}
		}
		const output = { phase, intentId };
		const advance = async (next = context): Promise<LxdOfficeLifecycleResult> => {
			signal.throwIfAborted();
			await this.#kernelLock(this.#root);
			signal.throwIfAborted();
			await journal.advance(next);
			return { ...output, state: "progressed" };
		};
		if (phase === "creation") {
			const result = await this.#workers.creation.reconcileSettled(signal);
			if (result.state === "awaiting_adoption") return advance({ ...context, allocationId: result.allocationId });
			return { ...output, state: result.state };
		}
		if (phase === "inventory") {
			const result = await this.#workers.inventory.inspectSettled(intentId, signal);
			if (
				result.observation.intentId !== intentId ||
				result.observation.allocationId !== context.allocationId ||
				officeDigest(result.observation) !== result.observationSha256
			)
				throw new Error("inventory binding");
			return advance({ ...context, observationSha256: result.observationSha256 });
		}
		if (phase === "review" || context.request) {
			let bytes: Buffer;
			try {
				bytes = await this.#readProtected(this.#planPath, 65536);
			} catch (error) {
				if (phase === "review" && code(error, "ENOENT"))
					return { ...output, state: "awaiting_review", observationSha256: context.observationSha256! };
				throw error;
			}
			const envelope = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
				"schema",
				"request",
			]);
			if (envelope.schema !== "qorpera.lxd-office-lifecycle-plan/v1") throw new Error("plan");
			const request = parseLxdOfficeLifecycleRequest(envelope.request);
			if (
				request.intentId !== intentId ||
				request.observationSha256 !== context.observationSha256 ||
				(context.request && !isDeepStrictEqual(context.request, request))
			)
				throw new Error("plan changed");
			if (phase === "review") {
				const observation = await readRecord(
					join(this.#root, `inventory-${context.observationSha256}.json`),
					16 * 1024 ** 2 + 4096,
				);
				if (officeDigest(observation.value) !== context.observationSha256) throw new Error("observation changed");
				return advance({ ...context, request });
			}
		}
		const request = context.request!;
		signal.throwIfAborted();
		if (phase === "adoption") {
			const result = await this.#workers.adoption.copySettled(request, signal);
			if (result.state !== "copied") throw new Error("copy incomplete");
			return advance();
		}
		if (phase === "activation" && this.#activeIntent === intentId && status.officeState === "active")
			return { ...output, state: "active" };
		if (phase === "boot" || phase === "preparation" || phase === "configuration" || phase === "activation") {
			const result = await this.#workers[phase].reconcileSettled(request, signal);
			signal.throwIfAborted();
			if (result.state === "awaiting_preparation" || result.state === "awaiting_activation") return advance();
			if (result.state === "active") this.#activeIntent = intentId;
			return { ...output, state: result.state === "not_dispatched" ? "unknown" : result.state };
		}
		throw new Error("unknown phase");
	}
}

/** Delay after settlement; no catch-up queue or overlapping timer callbacks.
 * Active service health/admission remains the runtime's responsibility. A new
 * provider process rechecks activation once, without repeating preparation. */
export async function runLxdOfficeLifecycle(
	lifecycle: Pick<LxdOfficeLifecycle, "reconcile">,
	signal: AbortSignal,
	onResult: (result: LxdOfficeLifecycleResult) => void,
	onError: (error?: unknown) => void,
	pollIntervalMs = 2000,
): Promise<void> {
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 60000)
		throw new Error("INVALID_OFFICE_LIFECYCLE_INTERVAL");
	while (!signal.aborted) {
		let result: LxdOfficeLifecycleResult | undefined;
		try {
			result = await lifecycle.reconcile(signal);
		} catch (error) {
			// Diagnostic observers have no authority over reconciliation.
			if (!signal.aborted) {
				try {
					void Promise.resolve(onError(error)).catch(() => {});
				} catch {}
			}
		}
		if (result && !signal.aborted) {
			try {
				void Promise.resolve(onResult(result)).catch(() => {});
			} catch {}
		}
		if (signal.aborted) break;
		await delay(pollIntervalMs, undefined, { signal }).catch(() => {});
	}
}
