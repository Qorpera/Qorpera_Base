import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerScreenActionGate } from "./cloud-company-computer-leases.ts";

export interface CompanyComputerDrainChallenge {
	state: "draining";
	drainId: string;
	epoch: number;
	binding: CompanyComputerScreenBinding;
}

export interface CompanyComputerDrainRegistry {
	call(
		method: "qorpera_ack_runtime_office_drain",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** One instance per physical guest. Drain failures keep their rejected promise;
 * a retry/recreated endpoint cannot erase the registry's pending challenge.
 * Guest replacement must separately prove that the old VM/process tree is gone.
 */
export class CompanyComputerDrainSupervisor {
	readonly #scope: CompanyComputerScope;
	readonly #gate: CompanyComputerScreenActionGate;
	readonly #control: CompanyComputerDrainRegistry;
	readonly #stopResources: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;
	readonly #attempts = new Map<string, { challenge: string; result: Promise<void> }>();

	constructor(options: {
		scope: CompanyComputerScope;
		gate: CompanyComputerScreenActionGate;
		control: CompanyComputerDrainRegistry;
		/** Must await all shell/service process trees, browser channels and held
		 * input release, including idle channels. A timeout is never success. */
		stopResources: (binding: CompanyComputerScreenBinding, signal: AbortSignal) => Promise<void>;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		this.#scope = Object.freeze({ ...options.scope });
		this.#gate = options.gate;
		this.#control = options.control;
		this.#stopResources = options.stopResources;
	}

	async drain(challenge: CompanyComputerDrainChallenge, signal: AbortSignal): Promise<void> {
		challenge = structuredClone(challenge);
		assertCompanyComputerScope(challenge.binding, this.#scope);
		assertCompanyComputerScreenBinding(challenge.binding, challenge.binding);
		if (
			Object.keys(challenge).sort().join() !== "binding,drainId,epoch,state" ||
			challenge.state !== "draining" ||
			!COMPANY_COMPUTER_UUID.test(challenge.drainId) ||
			!Number.isSafeInteger(challenge.epoch) ||
			challenge.epoch < 1
		) {
			throw new Error("INVALID_OFFICE_DRAIN_CHALLENGE");
		}
		const key = `${challenge.binding.companyComputerId}:${challenge.binding.screenOrdinal}`;
		const serialized = JSON.stringify(challenge);
		const previous = this.#attempts.get(key);
		if (previous) {
			if (previous.challenge !== serialized) {
				// A completed challenge can be superseded. A failed or still-running
				// drain must settle successfully before another challenge is attempted.
				await companyComputerRequest(() => previous.result, signal);
			} else {
				return companyComputerRequest(() => previous.result, signal);
			}
		}
		const result = (async () => {
			await this.#gate.fence(challenge.binding, challenge.epoch, signal);
			await companyComputerRequest((requestSignal) => this.#stopResources(challenge.binding, requestSignal), signal);
			signal.throwIfAborted();
			const response = await companyComputerRequest(
				(requestSignal) =>
					this.#control.call(
						"qorpera_ack_runtime_office_drain",
						{
							p_scope: this.#scope,
							p_screen_id: challenge.binding.screenId,
							p_computer_generation: challenge.binding.computerGeneration,
							p_screen_generation: challenge.binding.screenGeneration,
							p_epoch: challenge.epoch,
							p_drain_id: challenge.drainId,
						},
						requestSignal,
					),
				signal,
			);
			if (
				!response ||
				typeof response !== "object" ||
				Array.isArray(response) ||
				Object.keys(response).sort().join() !== "drainId,epoch,state" ||
				!("state" in response) ||
				response.state !== "drained" ||
				!("drainId" in response) ||
				response.drainId !== challenge.drainId ||
				!("epoch" in response) ||
				response.epoch !== challenge.epoch
			) {
				throw new Error("OFFICE_DRAIN_UNCONFIRMED");
			}
		})();
		this.#attempts.set(key, { challenge: serialized, result });
		return result;
	}
}
