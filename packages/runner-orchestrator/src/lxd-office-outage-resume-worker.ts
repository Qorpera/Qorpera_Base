import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	companyComputerOutageResumeObservationCanonical,
	parseCompanyComputerOutageResumeObservation,
} from "@qorpera/contracts";
import type { PaidComputerGuardRecord } from "./computer-paid-guard.ts";
import { type LxdOfficeOutageTerminationClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { assertOfficeImageOutageCapability, parseOfficeImagePackage } from "./lxd-office-image-installation.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import {
	openLxdOfficeOutageHistory,
	readOptionalOutageRecord,
	retainOutageRecord,
} from "./lxd-office-outage-history.ts";
import {
	LxdOfficeOutageRecoveryControl,
	type LxdOfficeOutageRecoveryRegistry,
	trackLxdOfficeOutageRegistry,
} from "./lxd-office-outage-recovery-control.ts";
import type { LxdOfficePaidComputerPort } from "./lxd-office-paid-computer.ts";
import type { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";

const pending = new Set<string>();
export type LxdOfficeOutageResumeClient = Pick<
	LxdOfficeOutageTerminationClient,
	"getInstance" | "getInstanceState" | "readInstanceFile" | "submitInstanceOperation" | "inspectInstanceOperation"
>;
interface Ports {
	paidComputer: LxdOfficePaidComputerPort;
	imagePackageManifest: Buffer;
	client?: LxdOfficeOutageResumeClient;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
}
/** Cold-boot stage for the explicitly configured outage lifecycle lane.
 * It preserves the original external stop and funds exactly one fresh start;
 * callers must compose termination, configuration and successor admission. */
export class LxdOfficeOutageResumeWorker {
	readonly gate: Pick<LxdOfficePhysicalGate, "policy" | "check">;
	readonly registry: LxdOfficeOutageRecoveryRegistry;
	readonly ports: Ports;
	readonly #policy;
	readonly #client;
	readonly #kernelLock;
	readonly #imagePackage: Buffer;
	constructor(
		gate: Pick<LxdOfficePhysicalGate, "policy" | "check">,
		registry: LxdOfficeOutageRecoveryRegistry,
		ports: Ports,
	) {
		this.gate = gate;
		this.registry = registry;
		this.ports = ports;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#imagePackage = Buffer.from(ports.imagePackageManifest);
	}
	async reconcile(intentId: string, guard: PaidComputerGuardRecord, caller: AbortSignal) {
		const root = this.#policy.journal.path;
		caller.throwIfAborted();
		if (pending.has(root)) throw new Error("OFFICE_OUTAGE_RESUME_PENDING");
		pending.add(root);
		const tracked = trackLxdOfficeOutageRegistry(this.registry);
		try {
			return await this.#run(
				intentId,
				guard,
				AbortSignal.any([caller, AbortSignal.timeout(30000)]),
				tracked.registry,
			);
		} finally {
			await tracked.settle();
			pending.delete(root);
		}
	}
	async #run(
		intentId: string,
		guard: PaidComputerGuardRecord,
		signal: AbortSignal,
		registry: LxdOfficeOutageRecoveryRegistry,
	) {
		const root = this.#policy.journal.path;
		await this.#kernelLock(root);
		if (
			createHash("sha256").update(this.#imagePackage).digest("hex") !== this.#policy.image.guestPackageManifestSha256
		)
			throw new Error("OFFICE_OUTAGE_IMAGE_PACKAGE_DIFFERS");
		assertOfficeImageOutageCapability(
			parseOfficeImagePackage(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(this.#imagePackage))),
		);
		const creation = await openLxdOfficeCreationIdentity(this.#policy, intentId, true, this.#client, signal),
			{ binding } = creation,
			plan = lxdOfficeGuestPlan(binding),
			paid = this.ports.paidComputer;
		if (guard.machine.hostMachineIdSha256 !== this.#policy.host.machineIdSha256)
			throw new Error("OFFICE_OUTAGE_HOST_DIFFERS");
		const history = await openLxdOfficeOutageHistory(
				root,
				creation,
				guard,
				this.#client,
				paid.operations(binding),
				signal,
			),
			{ request, journal } = history,
			control = new LxdOfficeOutageRecoveryControl(request, registry),
			suffix = `${binding.allocationId}-${request.recoveryId}`,
			preparedName = `outage-prepared-${suffix}.json`,
			observationName = `outage-observation-${suffix}.json`;
		const retained = async () => {
			await this.#kernelLock(root);
			const current = await openLxdOfficeOutageHistory(
				root,
				creation,
				guard,
				this.#client,
				paid.operations(binding),
				signal,
			);
			if (!isDeepStrictEqual(current.bridge, history.bridge)) throw new Error("OFFICE_OUTAGE_BRIDGE_CHANGED");
		};
		const physical = async () => {
			await retained();
			const sample = await this.gate.check(binding, signal);
			if (sample.hostBootId !== guard.stopReceipt!.closedHostBootId)
				throw new Error("OFFICE_OUTAGE_HOST_BOOT_CHANGED");
			const checked = AbortSignal.any([signal, sample.signal]),
				instance = await this.#client.getInstance(binding.project, plan.request.name, checked);
			if (
				!instance ||
				instance.config["volatile.uuid"] !== guard.machine.physicalInstanceId ||
				instance.expandedConfig["volatile.uuid"] !== guard.machine.physicalInstanceId
			)
				throw new Error("OFFICE_OUTAGE_PHYSICAL_INSTANCE_CHANGED");
			assertLxdOfficeGuestInstance(binding, instance);
			checked.throwIfAborted();
			return { checked, instance };
		};
		let operation = await journal.observe(request.startCommandId, "start", signal);
		// Settlement is independent of funding/source authority. Never settle the
		// newly started successor on restart just because the old proof is stopped.
		const settledName = `outage-settled-${suffix}.json`,
			settled = { permitId: guard.permit.permitId, outageRequestId: request.outageRequestId };
		if ((await readOptionalOutageRecord(root, settledName)) === undefined) {
			if (operation.state !== "not_dispatched") throw new Error("OFFICE_OUTAGE_SETTLEMENT_PREFIX_LOST");
			await paid.maintain(signal);
			await paid.settleStopped(binding, signal);
			await retainOutageRecord(root, settledName, settled);
		} else if (!isDeepStrictEqual(await readOptionalOutageRecord(root, settledName), settled))
			throw new Error("OFFICE_OUTAGE_SETTLEMENT_DIFFERS");
		const recovery = await control.prepare(signal);
		if (!isDeepStrictEqual(recovery.predecessor, history.predecessor))
			throw new Error("OFFICE_OUTAGE_PREDECESSOR_CHANGED");
		if ((await readOptionalOutageRecord(root, preparedName)) === undefined && operation.state !== "not_dispatched")
			throw new Error("OFFICE_OUTAGE_PREPARATION_LOST");
		await retainOutageRecord(root, preparedName, recovery);
		const authorize = async (caller: AbortSignal) => {
			const cloud = await control.check(caller);
			await retained();
			if (!isDeepStrictEqual(cloud.recovery, await readOptionalOutageRecord(root, preparedName)))
				throw new Error("OFFICE_OUTAGE_SNAPSHOT_CHANGED");
			cloud.signal.throwIfAborted();
			return cloud.signal;
		};
		if (operation.state === "not_dispatched") {
			if ((await readOptionalOutageRecord(root, observationName)) !== undefined)
				throw new Error("OFFICE_OUTAGE_DISPATCH_LOST");
			const { checked, instance } = await physical();
			const state = await this.#client.getInstanceState(binding.project, plan.request.name, checked);
			if (
				instance.status !== "Stopped" ||
				instance.statusCode !== 102 ||
				state.status !== "Stopped" ||
				state.statusCode !== 102
			)
				throw new Error("OFFICE_OUTAGE_VM_NOT_STOPPED");
			const authorized = await authorize(checked);
			if (
				!(await paid.prepareStart(
					binding,
					request.startCommandId,
					{ kind: "outage_recovery", request },
					authorized,
				))
			)
				throw new Error("OFFICE_OUTAGE_PAID_START_REQUIRED");
			// Refresh cloud/physical authority after funding; preparation may have
			// consumed the previous window. No raw node/start fallback exists.
			const current = await physical();
			operation = await journal.reconcile(request.startCommandId, "start", await authorize(current.checked));
		}
		if (operation.state !== "succeeded") return { request, state: operation.state };
		if (!operation.operationId) throw new Error("OFFICE_OUTAGE_START_UNCONFIRMED");
		const { checked } = await physical();
		await paid.assertActive(binding, checked);
		const boot = await inspectLxdOfficeGuestBoot(this.#client, binding, checked);
		const observation = parseCompanyComputerOutageResumeObservation(
			{
				schema: "qorpera.lxd-office-outage-resume-observation/v1",
				intentId,
				allocationId: binding.allocationId,
				recoveryId: request.recoveryId,
				activationId: request.activationId,
				startCommandId: request.startCommandId,
				requestSha256: officeDigest(history.bridge),
				hostBootId: guard.stopReceipt!.closedHostBootId,
				bootId: boot.bootId,
				instanceSha256: boot.instanceSha256,
				physicalInstanceId: guard.machine.physicalInstanceId,
				operationId: operation.operationId,
			},
			recovery,
		);
		const previousObservation = await readOptionalOutageRecord(root, observationName);
		if (previousObservation !== undefined) {
			if (!isDeepStrictEqual(previousObservation, observation)) throw new Error("OFFICE_OUTAGE_OBSERVATION_CHANGED");
			if (!isDeepStrictEqual(await control.status(checked), recovery))
				throw new Error("OFFICE_OUTAGE_RECOVERY_CHANGED");
		} else {
			const authorized = await authorize(checked);
			if (!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, authorized), boot))
				throw new Error("OFFICE_OUTAGE_BOOT_CHANGED");
			await retainOutageRecord(root, observationName, observation);
		}
		return {
			request,
			recovery,
			observation,
			state: "awaiting_termination" as const,
			bootObservationSha256: createHash("sha256")
				.update(companyComputerOutageResumeObservationCanonical(observation, recovery))
				.digest("hex"),
		};
	}
}
