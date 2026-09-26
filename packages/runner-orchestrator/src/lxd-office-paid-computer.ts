import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { reconcileLxdOfficeComputerOutage } from "./lxd-office-computer-outage.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import type { LxdOfficeHostRebootRegistry } from "./lxd-office-host-reboot.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficeAbandonedStart, LxdOfficeOperationPort } from "./lxd-office-operations.ts";
import { assertLxdOfficePhysicalBinding, type LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import type { LxdOfficeAdoptionMapping, LxdOfficeStartRegistry } from "./lxd-office-start-control.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";
import type { RuntimeComputerContext, RuntimeComputerController } from "./runtime-computer-controller.ts";

type OfficeController = Pick<
	RuntimeComputerController,
	| "ensure"
	| "recover"
	| "start"
	| "guardRecord"
	| "manages"
	| "settleStopped"
	| "maintain"
	| "assertRunning"
	| "prestartStatus"
	| "abandonUndispatched"
>;

export interface LxdOfficePaidComputerPort {
	creationRegistry(
		binding: LxdOfficeGuestBinding,
		intentId: string,
		registry: LxdOfficeStartRegistry,
	): LxdOfficeStartRegistry;
	prepareStart(
		binding: LxdOfficeGuestBinding,
		commandId: string,
		officeIntent: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<boolean>;
	operations(binding: LxdOfficeGuestBinding): LxdOfficeOperationPort;
	recover(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void>;
	assertActive(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void>;
	reconcileStopped(
		binding: LxdOfficeGuestBinding,
		registry: Pick<LxdOfficeHostRebootRegistry, "call">,
		signal: AbortSignal,
	): Promise<boolean>;
	settleStopped(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void>;
	maintain(signal: AbortSignal): Promise<void>;
}
export function lxdOfficeInitialPaidIntent(
	binding: LxdOfficeGuestBinding,
	intentId: string,
	mappings: readonly LxdOfficeAdoptionMapping[],
): Record<string, unknown> {
	return { kind: "initial", intentId, providerBindingSha256: lxdOfficeProviderBindingSha256(binding), mappings };
}

/** Only the generic controller owns funding, physical guard custody, sampling,
 * and renewal. This adapter retains the office command's exact start authority.
 * A forced funding stop never becomes an acknowledged office lifecycle stop. */
export class LxdOfficePaidComputer implements LxdOfficePaidComputerPort {
	readonly #policy: LxdOfficePhysicalPolicy;
	readonly #controller: OfficeController;
	readonly #control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	constructor(
		policy: LxdOfficePhysicalPolicy,
		controller: OfficeController,
		control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> },
	) {
		this.#policy = policy;
		this.#controller = controller;
		this.#control = control;
	}
	#context(binding: LxdOfficeGuestBinding): RuntimeComputerContext {
		assertLxdOfficePhysicalBinding(this.#policy, binding);
		return {
			allocationId: binding.allocationId,
			providerKind: "office",
			providerId: binding.providerId,
			policySha256: binding.providerPolicySha256,
			instanceSha256: lxdOfficeGuestPlan(binding).instanceSha256,
			bootstrapSha256: binding.bootstrapSha256,
			runId: null,
			runnerId: null,
			officeId: binding.companyComputerId,
			computerGeneration: binding.computerGeneration,
		};
	}
	creationRegistry(
		binding: LxdOfficeGuestBinding,
		intentId: string,
		registry: LxdOfficeStartRegistry,
	): LxdOfficeStartRegistry {
		const context = this.#context(binding);
		const start = {
			p_provider_id: binding.providerId,
			p_provider_policy_sha256: binding.providerPolicySha256,
			p_scope: {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			},
			p_computer_generation: binding.computerGeneration,
			p_intent_id: intentId,
			p_allocation_id: binding.allocationId,
			p_instance_sha256: context.instanceSha256,
			p_provider_binding_sha256: lxdOfficeProviderBindingSha256(binding),
			p_image_sha256: binding.imageFingerprint,
			p_bootstrap_sha256: binding.bootstrapSha256,
		};
		return {
			call: async (method, args, signal) => {
				if (method !== "qorpera_reserve_runtime_office_start" && method !== "qorpera_reserve_runtime_node_machine")
					return registry.call(method, args, signal);
				if (method === "qorpera_reserve_runtime_office_start" && !isDeepStrictEqual(args, start))
					throw new Error("OFFICE_PAID_RESERVATION_DIFFERS");
				const value = await this.#control.call(
					"qorpera_paid_office_admission",
					{
						p_request: {
							...context,
							machineIdSha256: this.#policy.host.machineIdSha256,
							action: method === "qorpera_reserve_runtime_office_start" ? "reserve" : "node",
							start,
						},
					},
					signal,
				);
				if (isDeepStrictEqual(value, { mode: "shadow" })) return registry.call(method, args, signal);
				if (
					!value ||
					typeof value !== "object" ||
					Array.isArray(value) ||
					Object.keys(value).sort().join() !== "mode,result" ||
					(value as { mode: unknown }).mode !== "paid"
				)
					throw new Error("OFFICE_PAID_ADMISSION_UNCONFIRMED");
				return (value as { result: unknown }).result;
			},
		};
	}
	async prepareStart(
		binding: LxdOfficeGuestBinding,
		commandId: string,
		officeIntent: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<boolean> {
		const context = { ...this.#context(binding), officeIntent: structuredClone(officeIntent) };
		const root = this.#policy.journal.path,
			name = this.#name(binding.allocationId, commandId);
		const value = { schema: "qorpera.office-paid-start/v1", commandId, context };
		await publish(root, name, Buffer.from(`${JSON.stringify(value)}\n`));
		if (!isDeepStrictEqual((await readRecord(join(root, name), 131072)).value, value))
			throw new Error("OFFICE_PAID_START_IDENTITY_CHANGED");
		// A cancelled command still belongs to the protected paid path. Let the
		// operation journal retain its explicit terminal outcome; never route it
		// through the public admission or raw start fallback.
		if ((await this.#controller.prestartStatus(commandId, signal))?.state === "abandoned") {
			await this.#controller.abandonUndispatched(context, commandId, signal);
			return true;
		}
		try {
			return (await this.#controller.ensure(context, commandId, signal)).mode === "paid";
		} catch (error) {
			if ((await this.#controller.prestartStatus(commandId, signal))?.state !== "abandoned") throw error;
			await this.#controller.abandonUndispatched(context, commandId, signal);
			return true;
		}
	}
	#name(allocationId: string, commandId: string): string {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(commandId))
			throw new Error("OFFICE_PAID_COMMAND_INVALID");
		return `paid-start-${allocationId}-${commandId}.json`;
	}
	async #retained(binding: LxdOfficeGuestBinding, commandId: string): Promise<RuntimeComputerContext> {
		const value = (
			await readRecord(join(this.#policy.journal.path, this.#name(binding.allocationId, commandId)), 131072)
		).value;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OFFICE_PAID_START_UNCONFIRMED");
		const record = value as {
			schema: unknown;
			commandId: unknown;
			context: RuntimeComputerContext & { officeIntent?: unknown };
		};
		if (
			record.schema !== "qorpera.office-paid-start/v1" ||
			record.commandId !== commandId ||
			!record.context ||
			!isDeepStrictEqual(
				{ ...record.context, officeIntent: undefined },
				{ ...this.#context(binding), officeIntent: undefined },
			)
		)
			throw new Error("OFFICE_PAID_START_UNCONFIRMED");
		return record.context;
	}
	operations(binding: LxdOfficeGuestBinding): LxdOfficeOperationPort {
		const plan = lxdOfficeGuestPlan(binding);
		const abandoned = async (
			context: RuntimeComputerContext,
			commandId: string,
			signal: AbortSignal,
		): Promise<LxdOfficeAbandonedStart> => {
			await this.#controller.abandonUndispatched(context, commandId, signal);
			return { state: "abandoned_before_dispatch", commandId };
		};
		return {
			submitStart: async (commandId, signal) => {
				const context = await this.#retained(binding, commandId);
				if ((await this.#controller.prestartStatus(commandId, signal))?.state === "abandoned")
					return abandoned(context, commandId, signal);
				let funded: Awaited<ReturnType<OfficeController["ensure"]>>;
				try {
					funded = await this.#controller.ensure(context, commandId, signal);
				} catch (error) {
					if ((await this.#controller.prestartStatus(commandId, signal))?.state === "abandoned")
						return abandoned(context, commandId, signal);
					throw error;
				}
				if (funded.mode === "shadow") return null;
				if (funded.permit.permitId !== commandId) throw new Error("OFFICE_PAID_COMMAND_DIFFERS");
				return this.#controller.start(
					binding.allocationId,
					{
						kind: "lxd",
						project: binding.project,
						instanceName: plan.request.name,
						profiles: plan.request.profiles,
						config: plan.request.config,
						devices: plan.request.devices,
					},
					signal,
				);
			},
			recoverStart: async (commandId, signal) => {
				const context = await this.#retained(binding, commandId);
				const prestart = await this.#controller.prestartStatus(commandId, signal);
				// The operation journal has a dispatch intent, but the guard has not
				// physically dispatched. Atomically race cancellation against start;
				// a dispatched winner refuses cancellation and remains recoverable.
				if (prestart?.state === "registered" || prestart?.state === "abandoned")
					return abandoned(context, commandId, signal);
				await this.#controller.recover(context, signal);
				const guard = await this.#controller.guardRecord(binding.allocationId, signal);
				if (!guard || guard.permit.permitId !== commandId) return null;
				return guard.startReference;
			},
			inspectStart: async (commandId, reference, signal) => {
				await this.#retained(binding, commandId);
				const guard = await this.#controller.guardRecord(binding.allocationId, signal);
				if (
					!guard ||
					guard.permit.permitId !== commandId ||
					!isDeepStrictEqual(guard.startReference, reference) ||
					!guard.startSettled
				)
					return null;
				if (guard.startSucceeded === true) return "succeeded";
				if (guard.startSucceeded === false) return "failed";
				return null;
			},
		};
	}
	async recover(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void> {
		const guard = await this.#controller.guardRecord(binding.allocationId, signal);
		await this.#controller.recover(
			guard ? await this.#retained(binding, guard.permit.permitId) : this.#context(binding),
			signal,
		);
	}
	async assertActive(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void> {
		const guard = await this.#controller.guardRecord(binding.allocationId, signal);
		if (
			(await this.#controller.recover(
				guard ? await this.#retained(binding, guard.permit.permitId) : this.#context(binding),
				signal,
			)) === "paid"
		)
			await this.#controller.assertRunning(binding.allocationId, signal);
	}
	reconcileStopped(
		binding: LxdOfficeGuestBinding,
		registry: Pick<LxdOfficeHostRebootRegistry, "call">,
		signal: AbortSignal,
	): Promise<boolean> {
		return reconcileLxdOfficeComputerOutage(this.#policy, binding, this.#controller, this.#control, registry, signal);
	}
	async settleStopped(binding: LxdOfficeGuestBinding, signal: AbortSignal): Promise<void> {
		await this.recover(binding, signal);
		if (this.#controller.manages(binding.allocationId))
			await this.#controller.settleStopped(binding.allocationId, signal);
	}
	maintain(signal: AbortSignal): Promise<void> {
		return this.#controller.maintain(signal);
	}
}
