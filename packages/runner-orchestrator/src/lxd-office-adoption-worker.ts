import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type LxdTrackedClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock, executeLxdOfficeAdoptionFiles } from "./lxd-office-adoption-files.ts";
import { type LxdOfficeAdoptionPlan, planLxdOfficeAdoption } from "./lxd-office-adoption-plan.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficeStartControl, type LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";
import { type OfficeInventoryLimits, parseOfficeInventoryLimits } from "./lxd-office-storage-inventory.ts";
import { type LxdOfficeStorageReview, parseLxdOfficeStorageReview } from "./lxd-office-storage-review.ts";

/** An infrastructure operator installs this exact protected document only
 * after fencing every other writer of the reviewed export. Its presence is
 * the operator's maintenance handoff for this host boot and exact copy plan.
 * Removal revokes the handoff. This does not acquire a remote NAS lock or
 * measure export exclusivity; that remains the infrastructure trust boundary.
 * Pure validation is not authority: the worker uses the root-protected reader. */
export function assertOfficeStorageMaintenanceHandoff(
	bytes: Buffer,
	observation: LxdOfficeStorageObservation,
	plan: Readonly<LxdOfficeAdoptionPlan>,
	review: Readonly<LxdOfficeStorageReview>,
): void {
	if (
		createHash("sha256").update(bytes).digest("hex") !== review.writerFence.evidenceSha256 ||
		!isDeepStrictEqual(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), {
			schema: "qorpera.lxd-office-storage-maintenance/v1",
			state: "exclusive_writers_confirmed",
			hostBootId: observation.hostBootId,
			providerBindingSha256: observation.providerBindingSha256,
			observationSha256: officeDigest(observation),
			planSha256: officeDigest(plan),
		})
	)
		throw new Error("OFFICE_ADOPTION_MAINTENANCE_HANDOFF_REQUIRED");
}

type Gate = Pick<LxdOfficePhysicalGate, "policy" | "check">;
interface Ports {
	client?: LxdTrackedClient;
	readProtected?: typeof readLxdOfficeProtectedFile;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	copy?: typeof executeLxdOfficeAdoptionFiles;
}
interface Request {
	intentId: string;
	observationSha256: string;
	input: unknown;
	reviewPath: string;
	writerFencePath: string;
}

/** Provider copy phase for an existing stopped initial creation. open() uses
 * actual Linux/LXD/cloud IO; constructor ports are trusted in-process test
 * seams. Must run under the service-owned kernel flock. Never creates a new
 * identity, starts a VM, grants a profile, emits a guest receipt or activates.
 * A host supervisor must keep the maintenance handoff in force until the
 * copied state is either admitted or left quarantined after cancellation. */
export class LxdOfficeAdoptionWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeStartRegistry;
	readonly #limits;
	readonly #client: LxdTrackedClient;
	readonly #readProtected;
	readonly #kernelLock;
	readonly #copy;
	#busy = false;
	constructor(gate: Gate, registry: LxdOfficeStartRegistry, limits: OfficeInventoryLimits, ports: Ports = {}) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#limits = parseOfficeInventoryLimits(limits);
		this.#client = ports.client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#readProtected = ports.readProtected ?? readLxdOfficeProtectedFile;
		this.#kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock;
		this.#copy = ports.copy ?? executeLxdOfficeAdoptionFiles;
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeStartRegistry,
		limits: OfficeInventoryLimits,
		signal: AbortSignal,
	): Promise<LxdOfficeAdoptionWorker> {
		return new LxdOfficeAdoptionWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
			limits,
		);
	}
	async copy(request: Request, caller: AbortSignal) {
		return this.#copySettled(request, caller, false);
	}
	async copySettled(request: Request, caller: AbortSignal) {
		return this.#copySettled(request, caller, true);
	}
	async #copySettled(request: Request, caller: AbortSignal, settle: boolean) {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_ADOPTION_WORKER_PENDING");
		const input = structuredClone(request);
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(300000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_ADOPTION_WORKER_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#run(input, signal).finally(() => {
			this.#busy = false;
		});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #run(request: Request, signal: AbortSignal) {
		const policy = this.#policy;
		await this.#kernelLock(policy.journal.path);
		signal.throwIfAborted();
		const identity = await openLxdOfficeCreationIdentity(policy, request.intentId, true, this.#client, signal);
		const { binding, createCommandId } = identity;
		const path = join(policy.journal.path, `inventory-${officeSha(request.observationSha256)}.json`);
		const recorded = await readRecord(path, 16 * 1024 ** 2 + 4096);
		if (officeDigest(recorded.value) !== request.observationSha256)
			throw new Error("OFFICE_INVENTORY_EVIDENCE_CHANGED");
		const observation = recorded.value as LxdOfficeStorageObservation;
		if (observation.intentId !== request.intentId) throw new Error("OFFICE_ADOPTION_INTENT_MISMATCH");
		const plan = planLxdOfficeAdoption(request.input, binding, observation);
		const planSha256 = officeDigest(plan);
		const journal = await LxdOfficeOperationJournal.open(
			policy.journal.path,
			request.intentId,
			binding,
			this.#client,
			true,
		);
		const control = new LxdOfficeStartControl(request.intentId, binding, this.#registry);
		const mappings = plan.screens.map((screen) => ({
			binding: screen.binding,
			browserProfile: screen.browser.disposition === "adopt" ? screen.browser.grant : null,
		}));
		const guard = {
			assertWritable: async (
				candidate: Readonly<LxdOfficeAdoptionPlan>,
				review: Readonly<LxdOfficeStorageReview>,
				caller: AbortSignal,
			) => {
				caller.throwIfAborted();
				if (officeDigest(candidate) !== planSha256) throw new Error("OFFICE_ADOPTION_PLAN_CHANGED");
				parseLxdOfficeStorageReview(review, observation, planSha256);
				await this.#kernelLock(policy.journal.path);
				const physical = await this.#gate.check(binding, caller);
				if (physical.hostBootId !== observation.hostBootId) throw new Error("OFFICE_ADOPTION_HOST_CHANGED");
				const checked = AbortSignal.any([caller, physical.signal]);
				const current = await openLxdOfficeCreationIdentity(policy, request.intentId, true, this.#client, checked);
				if (!isDeepStrictEqual(current, identity)) throw new Error("OFFICE_ADOPTION_CREATION_CHANGED");
				await journal.assertInitialCreation(createCommandId, checked);
				const cloud = await control.checkAdoption(mappings, checked);
				const authorized = AbortSignal.any([checked, cloud.signal]);
				const instance = await this.#client.getInstance(
					binding.project,
					lxdOfficeGuestPlan(binding).request.name,
					authorized,
				);
				authorized.throwIfAborted();
				if (!instance || instance.status !== "Stopped" || instance.statusCode !== 102)
					throw new Error("OFFICE_ADOPTION_STOPPED_VM_UNCONFIRMED");
				assertLxdOfficeGuestInstance(binding, instance);
				assertOfficeStorageMaintenanceHandoff(
					await this.#readProtected(request.writerFencePath, 16384),
					observation,
					plan,
					review,
				);
				authorized.throwIfAborted();
			},
		};
		return this.#copy(
			{
				binding,
				observation,
				input: request.input,
				reviewPath: request.reviewPath,
				journalRoot: policy.journal.path,
				limits: this.#limits,
				source: {
					root: policy.workbench.mountPoint,
					mount: policy.workbench,
					uid: policy.workbench.uid,
					gid: policy.workbench.gid,
					serverAddress: policy.workbench.serverAddress,
				},
			},
			guard,
			signal,
			true,
		);
	}
}
