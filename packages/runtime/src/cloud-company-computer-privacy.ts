import {
	assertCompanyComputerScope,
	type CompanyComputerScope,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";
import type { CompanyComputerDrainSupervisor } from "./cloud-company-computer-drain.ts";

export interface CompanyComputerPrivacyRegistry {
	call(
		method: "qorpera_ack_runtime_office_privacy",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

export interface CompanyComputerPrivacyBoundary {
	/** Install a monotonic, office-wide barrier and await all viewer/capture
	 * channels closing, including the owner's previous connection. Block new
	 * channels, guest dispatch and launches. Retain this barrier after failure.
	 * A matching SQL acknowledgement is NOT permission to clear a newer barrier. */
	fence(challenge: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void>;
	/** The registry confirms the office is shared at this privacy version with no
	 * retained challenge. Never lowers a version the boundary already holds. */
	shared?(privacyVersion: number): void;
	/** After every screen has physically drained: on entry prove broker-only
	 * profile disposition and an unobserved sign-in surface; on exit close the
	 * private browser, release held input, clear clipboard, discard private
	 * captures and replace secret-bearing framebuffers. Never record input.
	 * Admission of subsequent channels remains separately authorized by SQL. */
	secureSurface(challenge: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void>;
}

/** Trusted supervisor protocol; concrete guest containment/viewer shutdown
 * implementations are mandatory. No optimistic timeout or model attestation. */
export class CompanyComputerPrivacySupervisor {
	readonly #scope: CompanyComputerScope;
	readonly #drains: Pick<CompanyComputerDrainSupervisor, "drain">;
	readonly #boundary: CompanyComputerPrivacyBoundary;
	readonly #control: CompanyComputerPrivacyRegistry;
	#attempt: { version: number; serialized: string; result: Promise<void> } | undefined;

	constructor(options: {
		scope: CompanyComputerScope;
		drains: Pick<CompanyComputerDrainSupervisor, "drain">;
		boundary: CompanyComputerPrivacyBoundary;
		control: CompanyComputerPrivacyRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		this.#scope = Object.freeze({ ...options.scope });
		this.#drains = options.drains;
		this.#boundary = options.boundary;
		this.#control = options.control;
	}

	transition(value: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void> {
		const challenge = parseCompanyComputerPrivacyChallenge(value, this.#scope);
		const serialized = JSON.stringify(challenge);
		const previous = this.#attempt;
		if (previous && challenge.version <= previous.version) {
			if (serialized !== previous.serialized) return Promise.reject(new Error("OFFICE_PRIVACY_CHALLENGE_CHANGED"));
			return companyComputerRequest(() => previous.result, signal);
		}
		// Publish the attempt before awaiting an earlier transition so concurrent
		// requests cannot both enter the physical supervisor.
		const result = (async () => {
			if (previous) await companyComputerRequest(() => previous.result, signal);
			await companyComputerRequest((s) => this.#boundary.fence(structuredClone(challenge), s), signal);
			for (const drain of challenge.drains) await this.#drains.drain(structuredClone(drain), signal);
			await companyComputerRequest((s) => this.#boundary.secureSurface(structuredClone(challenge), s), signal);
			const response = await companyComputerRequest(
				(s) =>
					this.#control.call("qorpera_ack_runtime_office_privacy", { p_challenge: structuredClone(challenge) }, s),
				signal,
			);
			if (
				!response ||
				typeof response !== "object" ||
				Array.isArray(response) ||
				Object.keys(response).sort().join() !== "challengeId,state,version" ||
				!("state" in response) ||
				response.state !== (challenge.state === "entering" ? "private" : "shared") ||
				!("version" in response) ||
				response.version !== challenge.version ||
				!("challengeId" in response) ||
				response.challengeId !== challenge.challengeId
			) {
				throw new Error("OFFICE_PRIVACY_UNCONFIRMED");
			}
		})();
		this.#attempt = { version: challenge.version, serialized, result };
		return result;
	}
}
