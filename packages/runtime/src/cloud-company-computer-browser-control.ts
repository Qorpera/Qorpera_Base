import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerBrowserAccess, CompanyComputerBrowserGrant } from "./cloud-company-computer-guest.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";

export interface CompanyComputerBrowserRegistry {
	call(
		method: "qorpera_native_office_browser_grant",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Browser authority comes from the actual native run and its current screen
 * lease. Subscription access, profile paths and cached consent are insufficient. */
export class CloudCompanyComputerBrowserControl implements CompanyComputerBrowserAccess {
	readonly #run: CloudNativeToolRun;
	readonly #scope: CompanyComputerScope;
	readonly #lease: () => CompanyComputerScreenLease;
	readonly #control: CompanyComputerBrowserRegistry;

	constructor(options: {
		run: CloudNativeToolRun;
		scope: CompanyComputerScope;
		lease: () => CompanyComputerScreenLease;
		control: CompanyComputerBrowserRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (
			options.scope.companyId !== options.run.identity.companyId ||
			options.scope.environmentId !== options.run.identity.environmentId
		) {
			throw new Error("COMPUTER_RUN_MISMATCH");
		}
		this.#run = options.run;
		this.#scope = Object.freeze({ ...options.scope });
		this.#lease = options.lease;
		this.#control = options.control;
	}

	async assertGranted(
		grant: CompanyComputerBrowserGrant,
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
	): Promise<void> {
		grant = structuredClone(grant);
		binding = structuredClone(binding);
		if (
			Object.keys(grant).sort().join() !== "grantId,profileId,version" ||
			!COMPANY_COMPUTER_UUID.test(grant.profileId) ||
			!COMPANY_COMPUTER_UUID.test(grant.grantId) ||
			!Number.isSafeInteger(grant.version) ||
			grant.version < 1
		)
			throw new Error("INVALID_BROWSER_GRANT");
		assertCompanyComputerScope(binding, this.#scope);
		const lease = structuredClone(this.#lease());
		assertCompanyComputerScreenBinding(binding, lease.binding);
		assertCompanyComputerLease(lease, binding, {
			kind: "agent",
			runId: this.#run.identity.runId,
			staffAgentId: this.#run.identity.staffAgentId,
		});
		const result = await cloudToolRequest(
			(requestSignal) =>
				this.#control.call(
					"qorpera_native_office_browser_grant",
					{
						p_binding: this.#run.binding,
						p_scope: this.#scope,
						p_lease: lease,
						p_grant: grant,
					},
					requestSignal,
				),
			AbortSignal.any([signal, this.#run.signal]),
		);
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			Object.keys(result).join() !== "state" ||
			!("state" in result) ||
			result.state !== "authorized"
		)
			throw new Error("BROWSER_GRANT_UNCONFIRMED");
	}
}
