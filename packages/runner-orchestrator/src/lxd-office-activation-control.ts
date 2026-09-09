import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerActivationAttestation,
	parseCompanyComputerActivationAttestation,
} from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { type LxdOfficeAdoptionMapping, lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

export interface LxdOfficeActivationRegistry {
	call(
		method:
			| "qorpera_prepare_runtime_office_activation"
			| "qorpera_runtime_office_activation_status"
			| "qorpera_activate_runtime_office",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}
export interface LxdOfficeActivationState {
	readonly state: "prepared" | "ready" | "active";
	readonly serviceInvocationId: string | null;
	/** Metadata only. Activation rechecks freshness transactionally in SQL. */
	readonly readinessFresh: boolean;
}

/** SQL half of the provider/guest handshake. The caller must persist the exact
 * attestation before prepare, and independently measure the running ordinary
 * unit, boot and installed configuration before activate. This adapter never
 * starts a guest or treats a readiness record as physical evidence. Unknown
 * replies require explicit reconciliation with the same retained identity. */
export class LxdOfficeActivationControl {
	readonly #registry: LxdOfficeActivationRegistry;
	readonly #identity;
	readonly #prepare;
	readonly #expected;
	constructor(
		intentId: string,
		value: LxdOfficeGuestBinding,
		attestation: CompanyComputerActivationAttestation,
		mappings: readonly LxdOfficeAdoptionMapping[],
		registry: LxdOfficeActivationRegistry,
	) {
		if (
			typeof intentId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intentId)
		)
			throw new Error("INVALID_OFFICE_START_INTENT");
		const { binding, instanceSha256 } = lxdOfficeGuestPlan(value);
		const evidence = parseCompanyComputerActivationAttestation(attestation);
		this.#registry = registry;
		this.#identity = {
			p_scope: {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			},
			p_computer_generation: binding.computerGeneration,
			p_intent_id: intentId,
			p_provider_id: binding.providerId,
			p_provider_policy_sha256: binding.providerPolicySha256,
		};
		this.#prepare = {
			p_allocation_id: binding.allocationId,
			p_instance_sha256: instanceSha256,
			p_provider_binding_sha256: lxdOfficeProviderBindingSha256(binding),
			p_mappings: structuredClone(mappings),
			p_attestation: evidence,
		};
		this.#expected = {
			schema: "qorpera.office-activation/v1",
			intentId,
			companyComputerId: binding.companyComputerId,
			computerGeneration: binding.computerGeneration,
			allocationId: binding.allocationId,
			attestation: evidence,
		};
	}
	async prepare(signal: AbortSignal): Promise<LxdOfficeActivationState> {
		return this.#call("qorpera_prepare_runtime_office_activation", this.#prepare, signal);
	}
	async status(signal: AbortSignal): Promise<LxdOfficeActivationState> {
		return this.#call(
			"qorpera_runtime_office_activation_status",
			{ p_activation_id: this.#expected.attestation.activationId },
			signal,
		);
	}
	async activate(serviceInvocationId: string, signal: AbortSignal): Promise<LxdOfficeActivationState> {
		if (typeof serviceInvocationId !== "string" || !/^(?!0{32}$)[0-9a-f]{32}$/.test(serviceInvocationId))
			throw new Error("INVALID_OFFICE_SERVICE_INVOCATION");
		return this.#call(
			"qorpera_activate_runtime_office",
			{ p_activation_id: this.#expected.attestation.activationId, p_service_invocation_id: serviceInvocationId },
			signal,
			serviceInvocationId,
		);
	}
	async #call(
		method: Parameters<LxdOfficeActivationRegistry["call"]>[0],
		args: Record<string, unknown>,
		caller: AbortSignal,
		expectedInvocation?: string,
	): Promise<LxdOfficeActivationState> {
		const signal = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
		signal.throwIfAborted();
		const started = performance.now();
		let abort = () => {};
		const stopped = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("OFFICE_ACTIVATION_REQUEST_ABORTED"));
			signal.addEventListener("abort", abort, { once: true });
		});
		let result: unknown;
		try {
			result = await Promise.race([
				Promise.resolve().then(() => {
					signal.throwIfAborted();
					return this.#registry.call(method, structuredClone({ ...this.#identity, ...args }), signal);
				}),
				stopped,
			]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
		signal.throwIfAborted();
		if (performance.now() - started >= 5000) throw new Error("OFFICE_ACTIVATION_RESPONSE_EXPIRED");
		if (!result || typeof result !== "object") throw new Error("OFFICE_ACTIVATION_UNCONFIRMED");
		const value = result as Record<string, unknown>;
		if (
			!["prepared", "ready", "active"].includes(value.state as string) ||
			(method === "qorpera_prepare_runtime_office_activation" && value.state === "active") ||
			typeof value.readinessFresh !== "boolean" ||
			(value.state === "prepared"
				? value.serviceInvocationId !== null || value.readinessFresh
				: typeof value.serviceInvocationId !== "string" ||
					!/^(?!0{32}$)[0-9a-f]{32}$/.test(value.serviceInvocationId)) ||
			(expectedInvocation !== undefined &&
				(value.state !== "active" || value.serviceInvocationId !== expectedInvocation)) ||
			!isDeepStrictEqual(result, {
				...this.#expected,
				state: value.state,
				serviceInvocationId: value.serviceInvocationId,
				readinessFresh: value.readinessFresh,
			})
		)
			throw new Error("OFFICE_ACTIVATION_UNCONFIRMED");
		return Object.freeze({
			state: value.state,
			serviceInvocationId: value.serviceInvocationId,
			readinessFresh: value.readinessFresh,
		}) as LxdOfficeActivationState;
	}
}
