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
		method: "qorpera_check_runtime_office_shared_surface" | "qorpera_runtime_office_screen_appearance",
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
	/**
	 * The screen agent's saved avatar fields, for the desktop backdrop only. The
	 * values are opaque here: the desktop preparation accepts a known avatar id
	 * or template and otherwise derives the figure from the agent id.
	 */
	async appearance(
		value: CompanyComputerScreenBinding,
		signal: AbortSignal,
	): Promise<{ creature?: string; templateId?: string }> {
		const binding = structuredClone(value);
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#scope);
		if (binding.computerGeneration !== this.#generation) throw new Error("OFFICE_GENERATION_MISMATCH");
		try {
			const result = await companyComputerRequest(
				(checked) =>
					this.#control.call("qorpera_runtime_office_screen_appearance", { p_binding: binding }, checked),
				signal,
				3000,
			);
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				Object.keys(result).sort().join() !== "creature,templateId"
			)
				throw new Error("denied");
			const field = (raw: unknown): string | undefined => {
				if (raw === null) return undefined;
				if (typeof raw !== "string" || raw.length < 1 || raw.length > 256) throw new Error("denied");
				return raw;
			};
			const fields = result as { creature: unknown; templateId: unknown };
			signal.throwIfAborted();
			return { creature: field(fields.creature), templateId: field(fields.templateId) };
		} catch (error) {
			throw new Error("SCREEN_APPEARANCE_UNCONFIRMED", { cause: error });
		}
	}
}
