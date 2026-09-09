import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "./cloud-company-computer-privacy.ts";

export type CloudCompanyComputerSignInRpc = (
	method:
		| "qorpera_request_runtime_office_privacy"
		| "qorpera_runtime_office_privacy_status"
		| "qorpera_check_runtime_office_private_access",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;

export interface CloudCompanyComputerPrivacyStatus {
	scope: CompanyComputerScope;
	computerGeneration: number;
	state: "shared" | "entering" | "private" | "leaving";
	version: number;
	challenge: CompanyComputerPrivacyChallenge | null;
}

/** Member-authenticated intent/status for BOTH clients. The server owns the
 * barrier. Closing a client or losing a response never resumes shared access.
 * This API never receives a password, keystroke, cookie or provider token. */
export class CloudCompanyComputerSignIn {
	readonly #scope: CompanyComputerScope;
	readonly #memberId: string;
	readonly #rpc: CloudCompanyComputerSignInRpc;

	constructor(options: { scope: CompanyComputerScope; memberId: string; rpc: CloudCompanyComputerSignInRpc }) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!COMPANY_COMPUTER_UUID.test(options.memberId)) throw new Error("INVALID_SIGN_IN_MEMBER");
		this.#scope = Object.freeze({ ...options.scope });
		this.#memberId = options.memberId;
		this.#rpc = options.rpc;
	}

	async #request(
		method: Parameters<CloudCompanyComputerSignInRpc>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		try {
			const response = await companyComputerRequest((s) => this.#rpc(method, structuredClone(args), s), signal);
			if (!response || response.error) throw new Error("unconfirmed");
			return response.data;
		} catch {
			throw new Error("OFFICE_SIGN_IN_UNCONFIRMED_REFRESH_STATUS");
		}
	}

	async request(
		profileId: string,
		screenId: string,
		expectedVersion: number,
		privateMode: boolean,
		signal: AbortSignal,
	): Promise<CompanyComputerPrivacyChallenge> {
		if (
			!COMPANY_COMPUTER_UUID.test(profileId) ||
			!COMPANY_COMPUTER_UUID.test(screenId) ||
			!Number.isSafeInteger(expectedVersion) ||
			expectedVersion < 0 ||
			expectedVersion >= Number.MAX_SAFE_INTEGER ||
			typeof privateMode !== "boolean"
		) {
			throw new Error("INVALID_OFFICE_SIGN_IN_REQUEST");
		}
		const challenge = parseCompanyComputerPrivacyChallenge(
			await this.#request(
				"qorpera_request_runtime_office_privacy",
				{
					p_scope: this.#scope,
					p_profile_id: profileId,
					p_screen_id: screenId,
					p_expected_version: expectedVersion,
					p_private: privateMode,
				},
				signal,
			),
			this.#scope,
		);
		if (
			challenge.memberId !== this.#memberId ||
			challenge.profileId !== profileId ||
			challenge.screenId !== screenId ||
			challenge.version !== expectedVersion + 1 ||
			challenge.state !== (privateMode ? "entering" : "leaving")
		) {
			throw new Error("OFFICE_SIGN_IN_RESPONSE_DIFFERS");
		}
		return challenge;
	}

	async status(signal: AbortSignal): Promise<CloudCompanyComputerPrivacyStatus> {
		const value = await this.#request("qorpera_runtime_office_privacy_status", { p_scope: this.#scope }, signal);
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== "challenge,computerGeneration,scope,state,version"
		) {
			throw new Error("INVALID_OFFICE_PRIVACY_STATUS");
		}
		const status = value as CloudCompanyComputerPrivacyStatus;
		assertCompanyComputerScope(status.scope, this.#scope);
		if (
			!Number.isSafeInteger(status.computerGeneration) ||
			status.computerGeneration < 1 ||
			!Number.isSafeInteger(status.version) ||
			status.version < 0 ||
			!["shared", "entering", "private", "leaving"].includes(status.state)
		) {
			throw new Error("INVALID_OFFICE_PRIVACY_STATUS");
		}
		const challenge =
			status.challenge === null ? null : parseCompanyComputerPrivacyChallenge(status.challenge, this.#scope);
		if (
			challenge &&
			(challenge.memberId !== this.#memberId ||
				challenge.version !== status.version ||
				challenge.computerGeneration !== status.computerGeneration ||
				(challenge.state === "entering"
					? !["entering", "private"].includes(status.state)
					: !["leaving", "shared"].includes(status.state)))
		) {
			throw new Error("OFFICE_SIGN_IN_RESPONSE_DIFFERS");
		}
		return {
			scope: { ...this.#scope },
			computerGeneration: status.computerGeneration,
			state: status.state,
			version: status.version,
			challenge,
		};
	}

	/** A check alone cannot open a channel or replay input. Private transport
	 * still requires authenticated owner binding and a fresh check per input. */
	async checkPrivateAccess(value: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void> {
		const challenge = parseCompanyComputerPrivacyChallenge(value, this.#scope);
		if (challenge.state !== "entering" || challenge.memberId !== this.#memberId)
			throw new Error("INVALID_PRIVATE_SIGN_IN_OWNER");
		const response = await this.#request(
			"qorpera_check_runtime_office_private_access",
			{ p_challenge: challenge },
			signal,
		);
		if (
			!response ||
			typeof response !== "object" ||
			Array.isArray(response) ||
			Object.keys(response).sort().join() !== "state,validForMs,version" ||
			!("state" in response) ||
			response.state !== "authorized" ||
			!("version" in response) ||
			response.version !== challenge.version ||
			!("validForMs" in response) ||
			response.validForMs !== 5000
		)
			throw new Error("OFFICE_PRIVATE_ACCESS_UNCONFIRMED");
	}
}
