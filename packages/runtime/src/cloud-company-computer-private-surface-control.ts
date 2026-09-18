import { performance } from "node:perf_hooks";
import {
	assertCompanyComputerScope,
	type CompanyComputerScope,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";

export interface CompanyComputerPrivateSurfaceRegistry {
	call(
		method: "qorpera_check_runtime_office_private_surface",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Host-only authority for a private browser's lifetime and network relay.
 * Recovery/status metadata never suffices; member input has its own authority.
 * No cached grant: every launch and renewal checks the current owner, profile,
 * generation and physically drained office through the service-only RPC. */
export class CloudCompanyComputerPrivateSurfaceControl {
	readonly #scope: CompanyComputerScope;
	readonly #generation: number;
	readonly #control: CompanyComputerPrivateSurfaceRegistry;

	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		control: CompanyComputerPrivateSurfaceRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!Number.isSafeInteger(options.computerGeneration) || options.computerGeneration < 1)
			throw new Error("INVALID_OFFICE_GENERATION");
		this.#scope = Object.freeze({ ...options.scope });
		this.#generation = options.computerGeneration;
		this.#control = options.control;
	}

	async assertActive(value: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void> {
		const challenge = parseCompanyComputerPrivacyChallenge(value, this.#scope);
		if (challenge.state !== "entering" || challenge.computerGeneration !== this.#generation)
			throw new Error("PRIVATE_SURFACE_CHALLENGE_DIFFERS");
		const started = performance.now();
		try {
			const result = await companyComputerRequest(
				(s) =>
					this.#control.call(
						"qorpera_check_runtime_office_private_surface",
						{ p_challenge: structuredClone(challenge) },
						s,
					),
				signal,
				3000,
			);
			if (
				!result ||
				typeof result !== "object" ||
				Array.isArray(result) ||
				Object.keys(result).sort().join() !== "privacyState,state,validForMs,version" ||
				!("state" in result) ||
				result.state !== "authorized" ||
				!("privacyState" in result) ||
				(result.privacyState !== "entering" && result.privacyState !== "private") ||
				!("version" in result) ||
				result.version !== challenge.version ||
				!("validForMs" in result) ||
				!Number.isSafeInteger(result.validForMs) ||
				(result.validForMs as number) < 1 ||
				(result.validForMs as number) > 5000 ||
				started + (result.validForMs as number) <= performance.now()
			)
				throw new Error("denied");
			signal.throwIfAborted();
		} catch {
			throw new Error("PRIVATE_SURFACE_UNCONFIRMED");
		}
	}
}
