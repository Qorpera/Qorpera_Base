import { performance } from "node:perf_hooks";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";

export interface CompanyComputerSharedSurfaceRegistry {
	call(
		method: "qorpera_check_runtime_office_shared_surface",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Current office authority for a persistent idle desktop. Native effects and
 * member input still require their separate receipts and viewer admissions. */
export class CloudCompanyComputerSharedSurfaceControl {
	readonly #scope: CompanyComputerScope;
	readonly #generation: number;
	readonly #control: CompanyComputerSharedSurfaceRegistry;
	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		control: CompanyComputerSharedSurfaceRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!Number.isSafeInteger(options.computerGeneration) || options.computerGeneration < 1)
			throw new Error("INVALID_OFFICE_GENERATION");
		this.#scope = Object.freeze({ ...options.scope });
		this.#generation = options.computerGeneration;
		this.#control = options.control;
	}
	async check(
		value: CompanyComputerScreenBinding,
		signal: AbortSignal,
	): Promise<{ privacyVersion: number; epoch: number }> {
		const binding = structuredClone(value);
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#scope);
		if (binding.computerGeneration !== this.#generation) throw new Error("OFFICE_GENERATION_MISMATCH");
		const started = performance.now();
		try {
			const result = await companyComputerRequest(
				(checked) =>
					this.#control.call("qorpera_check_runtime_office_shared_surface", { p_binding: binding }, checked),
				signal,
				3000,
			);
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				Object.keys(result).sort().join() !== "epoch,privacyVersion,state,validForMs" ||
				!("state" in result) ||
				result.state !== "authorized" ||
				!("privacyVersion" in result) ||
				!Number.isSafeInteger(result.privacyVersion) ||
				(result.privacyVersion as number) < 0 ||
				!("epoch" in result) ||
				!Number.isSafeInteger(result.epoch) ||
				(result.epoch as number) < 0 ||
				!("validForMs" in result) ||
				!Number.isSafeInteger(result.validForMs) ||
				(result.validForMs as number) < 1 ||
				(result.validForMs as number) > 5000 ||
				started + (result.validForMs as number) <= performance.now()
			)
				throw new Error("denied");
			signal.throwIfAborted();
			return { privacyVersion: result.privacyVersion as number, epoch: result.epoch as number };
		} catch (error) {
			throw new Error("SHARED_SURFACE_UNCONFIRMED", { cause: error });
		}
	}
}
