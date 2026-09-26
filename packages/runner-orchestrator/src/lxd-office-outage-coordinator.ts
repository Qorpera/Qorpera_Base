import { isDeepStrictEqual } from "node:util";
import { parseCompanyComputerOutagePredecessor } from "@qorpera/contracts";
import { parsePaidComputerGuardRecord } from "./computer-paid-guard.ts";
import type { PaidComputerGuardClient } from "./computer-paid-guard-ipc.ts";
import type { LxdUnixClient } from "./lxd-client.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { inspectLxdOfficeGuestBoot, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeRecord } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeLifecycleResult } from "./lxd-office-lifecycle.ts";
import type { LxdOfficeOutageAdmissionWorker } from "./lxd-office-outage-admission-worker.ts";
import { readLxdOfficeOutageVmLineage, readOptionalOutageRecord } from "./lxd-office-outage-history.ts";
import type { LxdOfficeOutageRecoveryRegistry } from "./lxd-office-outage-recovery-control.ts";
import type { LxdOfficeLifecycleRegistry } from "./lxd-office-provider-registry.ts";
import { readLxdOfficeStopEvidence } from "./lxd-office-stop-evidence.ts";

export interface LxdOfficeOutageOptions {
	guard: Pick<PaidComputerGuardClient, "status" | "latest">;
	control: LxdOfficeOutageRecoveryRegistry;
	imagePackageManifest: Buffer;
}

/** Select recovery from retained VM lineage, never from whichever permit is
 * newest. A failed successor start must not be mistaken for a second outage
 * of an office that has not yet been readmitted. */
export class LxdOfficeOutageCoordinator {
	readonly #worker: LxdOfficeOutageAdmissionWorker;
	readonly #guard: Pick<PaidComputerGuardClient, "status" | "latest">;
	readonly #client: LxdUnixClient;
	readonly #registry: LxdOfficeLifecycleRegistry;
	constructor(
		worker: LxdOfficeOutageAdmissionWorker,
		guard: Pick<PaidComputerGuardClient, "status" | "latest">,
		client: LxdUnixClient,
		registry: LxdOfficeLifecycleRegistry,
	) {
		this.#worker = worker;
		this.#guard = guard;
		this.#client = client;
		this.#registry = registry;
	}
	async #lineage(intentId: string, signal: AbortSignal) {
		const resume = this.#worker.configuration.termination.resume;
		const creation = await openLxdOfficeCreationIdentity(resume.gate.policy, intentId, true, this.#client, signal);
		return { creation, ...(await readLxdOfficeOutageVmLineage(resume.gate.policy.journal.path, creation)) };
	}
	async pendingGuard(intentId: string, signal: AbortSignal) {
		const lineage = await this.#lineage(intentId, signal),
			bridge = lineage.segments.at(-1)!.bridge;
		if (!bridge) return null;
		const root = this.#worker.configuration.termination.resume.gate.policy.journal.path;
		if (
			(await readOptionalOutageRecord(
				root,
				`outage-activation-completed-${lineage.creation.binding.allocationId}-${bridge.request.activationId}.json`,
			)) !== undefined
		)
			return null;
		const guard = parsePaidComputerGuardRecord(await this.#guard.status(bridge.permit.permitId, signal));
		if (
			guard.phase !== "stopped" ||
			!isDeepStrictEqual(guard.permit, bridge.permit) ||
			!isDeepStrictEqual(guard.stopReceipt, bridge.proof.stopReceipt)
		)
			throw new Error("OFFICE_OUTAGE_ORIGINAL_GUARD_CHANGED");
		return guard;
	}
	async latestStopped(allocationId: string, signal: AbortSignal) {
		const value = await this.#guard.latest(allocationId, signal);
		if (!value) throw new Error("OFFICE_OUTAGE_GUARD_MISSING");
		const guard = parsePaidComputerGuardRecord(value);
		if (guard.phase !== "stopped" || guard.permit.allocationId !== allocationId)
			throw new Error("OFFICE_OUTAGE_GUARD_CHANGED");
		return guard;
	}
	async recover(...args: Parameters<LxdOfficeOutageAdmissionWorker["reconcile"]>): Promise<LxdOfficeLifecycleResult> {
		const result = await this.#worker.reconcile(...args);
		return {
			state:
				result.state === "not_dispatched"
					? "unknown"
					: result.state === "abandoned_before_dispatch"
						? "held"
						: result.state,
			phase: "outage_recovery",
			intentId: args[0],
			activationId: "activationId" in result ? result.activationId : result.request.activationId,
			...(result.state === "abandoned_before_dispatch" ? { reason: "OFFICE_PAID_START_ABANDONED" } : {}),
		};
	}
	/** Completed outage lineage prevents replay of first-install activation.
	 * Read the current SQL identity and installed evidence, including ordinary
	 * successors of the outage boot. This is observation, not admission. */
	async active(intentId: string, signal: AbortSignal): Promise<LxdOfficeLifecycleResult | null> {
		const lineage = await this.#lineage(intentId, signal);
		if (lineage.segments.length === 1) return null;
		const resume = this.#worker.configuration.termination.resume,
			{ binding } = lineage.creation;
		const readActivation = async (checked: AbortSignal) =>
			officeRecord(
				await this.#registry.call(
					"qorpera_runtime_office_provider_activation",
					{
						p_scope: {
							companyId: binding.companyId,
							environmentId: binding.environmentId,
							companyComputerId: binding.companyComputerId,
							logicalComputerId: binding.logicalComputerId,
						},
						p_computer_generation: binding.computerGeneration,
						p_provider_id: binding.providerId,
						p_provider_policy_sha256: binding.providerPolicySha256,
					},
					checked,
				),
				["schema", "officeState", "activation"],
			);
		const current = await readActivation(signal);
		if (current.schema !== "qorpera.office-provider-activation/v1")
			throw new Error("OFFICE_OUTAGE_ACTIVATION_UNCONFIRMED");
		if (current.officeState !== "active" || current.activation === null)
			return { state: "held", phase: "outage_recovery", intentId };
		const activation = parseCompanyComputerOutagePredecessor(current.activation);
		const evidence = await readLxdOfficeStopEvidence(
			resume.gate.policy.journal.path,
			intentId,
			binding,
			activation,
			this.#client,
			signal,
		);
		const physical = await resume.gate.check(binding, signal),
			checked = AbortSignal.any([signal, physical.signal]);
		if (physical.hostBootId !== evidence.hostBootId) throw new Error("OFFICE_OUTAGE_HOST_CHANGED");
		await resume.ports.paidComputer.assertActive(binding, checked);
		if (
			!isDeepStrictEqual(await inspectLxdOfficeGuestBoot(this.#client, binding, checked), {
				bootId: activation.startup.bootId,
				instanceSha256: activation.startup.instanceSha256,
			})
		)
			throw new Error("OFFICE_OUTAGE_BOOT_CHANGED");
		const instance = await this.#client.getInstance(
			binding.project,
			lxdOfficeGuestPlan(binding).request.name,
			checked,
		);
		if (instance?.status !== "Running" || instance.statusCode !== 103)
			throw new Error("OFFICE_OUTAGE_VM_NOT_RUNNING");
		// Recheck selection after the reads so a changed journal cannot bless a
		// different physical segment in the same observation.
		if ((await this.#lineage(intentId, checked)).segmentRoot !== lineage.segmentRoot)
			throw new Error("OFFICE_VM_SEGMENT_SUPERSEDED");
		if (!isDeepStrictEqual(await readActivation(checked), current))
			throw new Error("OFFICE_OUTAGE_ACTIVATION_CHANGED");
		checked.throwIfAborted();
		return { state: "active", phase: "outage_recovery", intentId, activationId: activation.activationId };
	}
}
