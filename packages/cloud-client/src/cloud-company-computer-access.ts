import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";

/** Browser-profile consent is a separate authority and cannot be configured here. */
export type CompanyComputerAccessCapabilities = ["shell"] | ["desktop"] | ["desktop", "shell"];
export interface CompanyComputerAccessStatus {
	schema: "qorpera.office-access-status/v1";
	scope: CompanyComputerScope;
	staffAgentId: string;
	grant: {
		grantId: string;
		version: number;
		state: "active" | "revoked";
		capabilities: CompanyComputerAccessCapabilities;
	} | null;
}
export type CompanyComputerAccessRpc = (
	method: "qorpera_runtime_office_access_status" | "qorpera_configure_runtime_office_access",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;

function record(value: unknown, keys: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_OFFICE_ACCESS_RESPONSE");
}
function capabilities(value: unknown): asserts value is CompanyComputerAccessCapabilities {
	if (!Array.isArray(value) || !['["shell"]', '["desktop"]', '["desktop","shell"]'].includes(JSON.stringify(value)))
		throw new Error("INVALID_OFFICE_ACCESS_CAPABILITIES");
}

/** Shared member-authenticated administration. Each write uses an observed
 * grant version; response loss requires status recovery, never automatic replay.
 * Revocation acknowledgement does not establish physical resource drain. */
export class CloudCompanyComputerAccess {
	readonly #scope: CompanyComputerScope;
	readonly #staffAgentId: string;
	readonly #rpc: CompanyComputerAccessRpc;
	constructor(scope: CompanyComputerScope, staffAgentId: string, rpc: CompanyComputerAccessRpc) {
		assertCompanyComputerScope(scope, scope);
		if (typeof staffAgentId !== "string" || !COMPANY_COMPUTER_UUID.test(staffAgentId))
			throw new Error("INVALID_OFFICE_ACCESS_STAFF");
		this.#scope = Object.freeze({ ...scope });
		this.#staffAgentId = staffAgentId;
		this.#rpc = rpc;
	}
	#parse(value: unknown): CompanyComputerAccessStatus {
		record(value, "grant,schema,scope,staffAgentId");
		record(value.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(value.scope as unknown as CompanyComputerScope, this.#scope);
		if (value.schema !== "qorpera.office-access-status/v1" || value.staffAgentId !== this.#staffAgentId)
			throw new Error("INVALID_OFFICE_ACCESS_RESPONSE");
		if (value.grant !== null) {
			record(value.grant, "capabilities,grantId,state,version");
			const grant = value.grant;
			if (
				typeof grant.grantId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(grant.grantId) ||
				!Number.isSafeInteger(grant.version) ||
				(grant.version as number) < 1 ||
				!["active", "revoked"].includes(grant.state as string)
			)
				throw new Error("INVALID_OFFICE_ACCESS_RESPONSE");
			capabilities(grant.capabilities);
		}
		return structuredClone(value) as unknown as CompanyComputerAccessStatus;
	}
	async #request(method: Parameters<CompanyComputerAccessRpc>[0], args: Record<string, unknown>, signal: AbortSignal) {
		let response: Awaited<ReturnType<CompanyComputerAccessRpc>>;
		try {
			response = await companyComputerRequest(
				(s) =>
					this.#rpc(
						method,
						structuredClone({
							p_scope: this.#scope,
							p_staff_agent_id: this.#staffAgentId,
							...args,
						}),
						s,
					),
				signal,
			);
			if (!response || response.error) throw new Error("unconfirmed");
		} catch {
			throw new Error("OFFICE_ACCESS_UNCONFIRMED_REFRESH_STATUS");
		}
		return this.#parse(response.data);
	}
	async status(signal: AbortSignal): Promise<CompanyComputerAccessStatus> {
		return this.#request("qorpera_runtime_office_access_status", {}, signal);
	}
	async configure(
		options: { expectedVersion: number; enabled: boolean; capabilities: CompanyComputerAccessCapabilities },
		signal: AbortSignal,
	): Promise<CompanyComputerAccessStatus> {
		if (
			!Number.isSafeInteger(options.expectedVersion) ||
			options.expectedVersion < 0 ||
			options.expectedVersion >= Number.MAX_SAFE_INTEGER ||
			typeof options.enabled !== "boolean"
		)
			throw new Error("INVALID_OFFICE_ACCESS_REQUEST");
		capabilities(options.capabilities);
		const requested = structuredClone(options);
		const result = await this.#request(
			"qorpera_configure_runtime_office_access",
			{
				p_expected_version: requested.expectedVersion,
				p_enabled: requested.enabled,
				p_capabilities: requested.capabilities,
			},
			signal,
		);
		if (
			!result.grant ||
			result.grant.version !== requested.expectedVersion + 1 ||
			result.grant.state !== (requested.enabled ? "active" : "revoked") ||
			JSON.stringify(result.grant.capabilities) !== JSON.stringify(requested.capabilities)
		)
			throw new Error("INVALID_OFFICE_ACCESS_RESPONSE");
		return result;
	}
}
