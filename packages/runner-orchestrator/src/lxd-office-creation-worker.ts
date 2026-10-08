import { isDeepStrictEqual } from "node:util";
import { type AgentPlug, runAgentPlug } from "./agent-plug.ts";
import { type LxdTrackedClient, LxdUnixClient } from "./lxd-client.ts";
import { openLxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { assertLxdOfficeGuestInstance, lxdOfficeAgentPlugClaim, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { reserveLxdOfficeNodeMachine } from "./lxd-office-node-admission.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { lxdOfficePhysicalPolicySha256, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderControl, type LxdOfficeProviderRegistry } from "./lxd-office-provider-control.ts";
import {
	LxdOfficeStartControl,
	type LxdOfficeStartRegistry,
	lxdOfficeProviderBindingSha256,
} from "./lxd-office-start-control.ts";
import type { RuntimeNodeCapacityRefusal } from "./runtime-node-admission.ts";

export interface LxdOfficeCreationRegistry {
	call(
		method: Parameters<LxdOfficeProviderRegistry["call"]>[0] | Parameters<LxdOfficeStartRegistry["call"]>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
type Gate = Pick<LxdOfficePhysicalGate, "policy" | "inspect">;
export type LxdOfficeCreationResult =
	| { state: "idle" }
	| { state: "held"; reason: "office_state" | "cancelled" | "preparation_disabled" }
	| { state: "capacity_refused"; intentId: string; allocationId: string; reason?: RuntimeNodeCapacityRefusal }
	| {
			state: "pending" | "unknown" | "failed" | "awaiting_adoption";
			intentId: string;
			allocationId: string;
			instanceSha256: string;
			operationId?: string;
	  };

/** Headless initial-creation reconciler. It consumes durable demand and never
 * powers on a guest, installs an adoption receipt, activates an office, or
 * releases capacity. Unknown provider outcomes retain their original command.
 * The trusted ports permit offline fixtures; open() wires the real gate/LXD. */
export class LxdOfficeCreationWorker {
	readonly #gate: Gate;
	readonly #policy;
	readonly #registry: LxdOfficeCreationRegistry;
	readonly #provider: LxdOfficeProviderControl;
	readonly #client: LxdTrackedClient;
	readonly #plug: AgentPlug;
	#busy = false;
	constructor(gate: Gate, registry: LxdOfficeCreationRegistry, client?: LxdTrackedClient, plug?: AgentPlug) {
		this.#gate = gate;
		this.#policy = parseLxdOfficePhysicalPolicy(gate.policy);
		this.#registry = registry;
		this.#client = client ?? new LxdUnixClient(this.#policy.host.socketPath);
		this.#plug = plug ?? runAgentPlug;
		const g = this.#policy.guest;
		this.#provider = new LxdOfficeProviderControl(
			{
				companyId: g.companyId,
				environmentId: g.environmentId,
				companyComputerId: g.companyComputerId,
				logicalComputerId: g.logicalComputerId,
				computerGeneration: g.computerGeneration,
				providerId: g.providerId,
				providerPolicySha256: lxdOfficePhysicalPolicySha256(this.#policy),
				imageFingerprint: g.imageFingerprint,
				bootstrapSha256: g.bootstrapSha256,
			},
			registry,
		);
	}
	static async open(
		policyPath: string,
		provenancePath: string,
		registry: LxdOfficeCreationRegistry,
		signal: AbortSignal,
	): Promise<LxdOfficeCreationWorker> {
		return new LxdOfficeCreationWorker(
			await LxdOfficePhysicalGate.open(policyPath, provenancePath, signal),
			registry,
		);
	}
	async reconcile(caller: AbortSignal): Promise<LxdOfficeCreationResult> {
		return this.#settledReconcile(caller, false);
	}
	async reconcileSettled(caller: AbortSignal): Promise<LxdOfficeCreationResult> {
		return this.#settledReconcile(caller, true);
	}
	async #settledReconcile(caller: AbortSignal, settle: boolean): Promise<LxdOfficeCreationResult> {
		caller.throwIfAborted();
		if (this.#busy) throw new Error("OFFICE_CREATION_RECONCILIATION_PENDING");
		this.#busy = true;
		const signal = AbortSignal.any([caller, AbortSignal.timeout(30000)]);
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_CREATION_RECONCILIATION_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const operation = this.#reconcile(signal).finally(() => {
			this.#busy = false;
		});
		try {
			return await Promise.race([operation, stopped]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (settle) await operation.catch(() => {});
		}
	}
	async #reconcile(signal: AbortSignal): Promise<LxdOfficeCreationResult> {
		const status = await this.#provider.status(signal);
		if (!status.intent) return { state: "idle" };
		if (status.intent.state === "cancelled") return { state: "held", reason: "cancelled" };
		if (!status.preparationEnabled) return { state: "held", reason: "preparation_disabled" };
		if (!["provisioning", "recovering"].includes(status.officeState))
			return { state: "held", reason: "office_state" };
		const physical = await this.#gate.inspect(signal);
		const checked = AbortSignal.any([signal, physical.signal]);
		checked.throwIfAborted();
		const identity = await openLxdOfficeCreationIdentity(
			this.#policy,
			status.intent.intentId,
			status.reservation !== null,
			this.#client,
			checked,
		);
		const { binding, createCommandId, intentId } = identity;
		const { request, instanceSha256 } = lxdOfficeGuestPlan(binding);
		if (
			status.reservation &&
			!isDeepStrictEqual(status.reservation, {
				allocationId: binding.allocationId,
				instanceSha256,
				providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
			})
		)
			throw new Error("OFFICE_CREATION_RESERVATION_MISMATCH");
		const journal = await LxdOfficeOperationJournal.open(
			this.#policy.journal.path,
			intentId,
			binding,
			this.#client,
			true,
		);
		checked.throwIfAborted();
		const control = new LxdOfficeStartControl(intentId, binding, this.#registry);
		if (!status.reservation && (await control.reserve(checked)).state === "refused")
			return { state: "capacity_refused", intentId, allocationId: binding.allocationId };
		let operation = await journal.observe(createCommandId, "create", checked);
		if (operation.state === "not_dispatched") {
			// The computer's agent card is plugged in right before its create, before the fresh authority so the
			// plug's time costs none of it. A plug never followed by a create is the same entry again next time.
			const hwaddr = await this.#plug(lxdOfficeAgentPlugClaim(binding), checked);
			checked.throwIfAborted();
			const authority = await control.check(checked);
			const node = await reserveLxdOfficeNodeMachine(this.#policy, binding, this.#registry, authority.signal);
			if (node.state === "refused")
				return { state: "capacity_refused", intentId, allocationId: binding.allocationId, reason: node.reason };
			const authorized = AbortSignal.any([checked, authority.signal, node.signal]);
			// An existing VM is never adopted as evidence of an unrecorded create.
			if (await this.#client.getInstance(binding.project, request.name, authorized))
				throw new Error("OFFICE_CREATION_INSTANCE_ALREADY_EXISTS");
			authorized.throwIfAborted();
			operation = await journal.reconcile(createCommandId, "create", authorized, hwaddr);
		}
		const result = {
			intentId,
			allocationId: binding.allocationId,
			instanceSha256,
			...("operationId" in operation && operation.operationId ? { operationId: operation.operationId } : {}),
		};
		if (operation.state !== "succeeded") return { ...result, state: operation.state };
		const instance = await this.#client.getInstance(binding.project, request.name, checked);
		checked.throwIfAborted();
		if (!instance || instance.status !== "Stopped" || instance.statusCode !== 102)
			throw new Error("OFFICE_CREATION_STOPPED_VM_UNCONFIRMED");
		assertLxdOfficeGuestInstance(binding, instance);
		await control.check(checked);
		return { ...result, state: "awaiting_adoption" };
	}
}
