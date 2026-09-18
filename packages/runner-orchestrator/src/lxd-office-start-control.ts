import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CompanyComputerStateAdoptionEntry } from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";

export interface LxdOfficeStartRegistry {
	call(
		method:
			| "qorpera_reserve_runtime_node_machine"
			| "qorpera_reserve_runtime_office_start"
			| "qorpera_check_runtime_office_start"
			| "qorpera_check_runtime_office_adoption",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface LxdOfficeAdoptionMapping {
	readonly binding: CompanyComputerStateAdoptionEntry["binding"];
	readonly browserProfile: { readonly profileId: string; readonly grantId: string; readonly version: number } | null;
}

/** Canonical digest of every provider setting, including mount/network/limits.
 * Input ordering has no effect. The SQL reservation pins this digest for the
 * generation; it does not prove that these settings have been provisioned. */
export function lxdOfficeProviderBindingSha256(value: LxdOfficeGuestBinding): string {
	const { binding } = lxdOfficeGuestPlan(value);
	return createHash("sha256")
		.update(
			JSON.stringify(Object.fromEntries(Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
		)
		.digest("hex");
}

/** Cloud admission for one immutable, provider-resolved intent/binding. This
 * never creates a guest, activates it or releases capacity. Opening the local
 * operation journal must precede reserve(), so an uncertain reservation can
 * only be reconciled with the same allocation and complete binding.
 *
 * Each physical preparation needs a fresh check(). Its signal bounds the
 * authority window, including registry latency. Cancellation cannot establish
 * physical cleanup; the caller must retain the operation journal and capacity. */
export class LxdOfficeStartControl {
	readonly #registry: LxdOfficeStartRegistry;
	readonly #identity: Record<string, unknown>;
	readonly #reservation: Record<string, unknown>;
	readonly #intentId: string;
	readonly #generation: number;
	readonly #expectedReservation: Record<string, unknown>;

	constructor(intentId: string, value: LxdOfficeGuestBinding, registry: LxdOfficeStartRegistry) {
		if (
			typeof intentId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intentId)
		)
			throw new Error("INVALID_OFFICE_START_INTENT");
		const { binding, instanceSha256 } = lxdOfficeGuestPlan(value);
		const providerBindingSha256 = lxdOfficeProviderBindingSha256(binding);
		this.#registry = registry;
		this.#intentId = intentId;
		this.#generation = binding.computerGeneration;
		this.#identity = {
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
			p_instance_sha256: instanceSha256,
			p_provider_binding_sha256: providerBindingSha256,
		};
		this.#reservation = {
			...this.#identity,
			p_image_sha256: binding.imageFingerprint,
			p_bootstrap_sha256: binding.bootstrapSha256,
		};
		this.#expectedReservation = {
			schema: "qorpera.office-start-intent/v1",
			intentId,
			companyComputerId: binding.companyComputerId,
			computerGeneration: binding.computerGeneration,
			state: "reserved",
			allocationId: binding.allocationId,
			instanceSha256,
			providerBindingSha256,
		};
	}

	async reserve(
		signal: AbortSignal,
	): Promise<{ state: "reserved" } | { state: "refused"; reason: "MACHINE_CAPACITY_EXHAUSTED" }> {
		signal.throwIfAborted();
		const result = await this.#registry.call(
			"qorpera_reserve_runtime_office_start",
			structuredClone(this.#reservation),
			signal,
		);
		signal.throwIfAborted();
		if (isDeepStrictEqual(result, { state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" }))
			return { state: "refused", reason: "MACHINE_CAPACITY_EXHAUSTED" };
		if (!isDeepStrictEqual(result, this.#expectedReservation))
			throw new Error("OFFICE_START_RESERVATION_UNCONFIRMED");
		return { state: "reserved" };
	}

	async check(signal: AbortSignal): Promise<{ signal: AbortSignal; validForMs: number }> {
		return this.#check("qorpera_check_runtime_office_start", {}, {}, signal);
	}

	/** Revalidate every restored screen and browser grant in the same SQL
	 * transaction as provider enrollment, cancellation and allocation checks. */
	async checkAdoption(
		mappings: readonly LxdOfficeAdoptionMapping[],
		signal: AbortSignal,
	): Promise<{ signal: AbortSignal; validForMs: number }> {
		const frozen = structuredClone(mappings);
		return this.#check("qorpera_check_runtime_office_adoption", { p_mappings: frozen }, { mappings: frozen }, signal);
	}

	async #check(
		method: "qorpera_check_runtime_office_start" | "qorpera_check_runtime_office_adoption",
		args: Record<string, unknown>,
		expected: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<{ signal: AbortSignal; validForMs: number }> {
		signal.throwIfAborted();
		const started = performance.now();
		const result = await this.#registry.call(method, structuredClone({ ...this.#identity, ...args }), signal);
		signal.throwIfAborted();
		if (
			!isDeepStrictEqual(result, {
				state: "authorized",
				intentId: this.#intentId,
				computerGeneration: this.#generation,
				validForMs: 5000,
				...expected,
			})
		)
			throw new Error("OFFICE_START_AUTHORITY_UNCONFIRMED");
		const validForMs = Math.floor(5000 - (performance.now() - started));
		if (validForMs < 1) throw new Error("OFFICE_START_AUTHORITY_EXPIRED");
		return { signal: AbortSignal.any([signal, AbortSignal.timeout(validForMs)]), validForMs };
	}
}
