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

export interface CompanyComputerScreenBrowserRegistry {
	call(
		method: "qorpera_office_screen_browser_grant",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** Who asked the office service to start the browser process; recorded, never trusted as authority. */
export type CompanyComputerScreenBrowserOpener = "agent" | "desktop";

/**
 * Browser authority of a screen rather than of one run. The browser window
 * belongs to the shared desktop: a member with input permission opens it from
 * the dock and the agent's next run uses the same window. SQL decides, each
 * time, that the screen agent's grant is current and that somebody entitled to
 * use the screen is present: an agent holding the screen lease, or a live
 * shared/control viewer whose member still has input permission. Without an
 * agent lease only a company-owned profile qualifies, and the dock only ever
 * opens a company-owned profile. With nobody present SQL tolerates a check (never
 * an open) for at most a minute since the last unfenced presence, so a viewer's
 * network blip does not close a member's browser; after that the relay's next
 * check is refused and the browser closes.
 *
 * This adds no path around the existing checks. An agent action still passes
 * the run's own `CloudCompanyComputerBrowserControl`, member input still passes
 * the viewer input admission, and the egress relay asks here per connection.
 */
export class CloudCompanyComputerScreenBrowserControl implements CompanyComputerBrowserAccess {
	readonly #scope: CompanyComputerScope;
	readonly #generation: number;
	readonly #control: CompanyComputerScreenBrowserRegistry;

	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		control: CompanyComputerScreenBrowserRegistry;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!Number.isSafeInteger(options.computerGeneration) || options.computerGeneration < 1)
			throw new Error("INVALID_OFFICE_GENERATION");
		this.#scope = Object.freeze({ ...options.scope });
		this.#generation = options.computerGeneration;
		this.#control = options.control;
	}

	async #grant(
		value: CompanyComputerScreenBinding,
		opener: CompanyComputerScreenBrowserOpener | null,
		signal: AbortSignal,
	): Promise<CompanyComputerBrowserGrant> {
		const binding = structuredClone(value);
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#scope);
		if (binding.computerGeneration !== this.#generation) throw new Error("OFFICE_GENERATION_MISMATCH");
		if (opener !== null && opener !== "agent" && opener !== "desktop") throw new Error("INVALID_BROWSER_OPENER");
		let result: unknown;
		try {
			result = await cloudToolRequest(
				(checked) =>
					this.#control.call(
						"qorpera_office_screen_browser_grant",
						{ p_binding: binding, p_opener: opener },
						checked,
					),
				signal,
				3000,
			);
		} catch (error) {
			throw new Error("BROWSER_GRANT_UNCONFIRMED", { cause: error });
		}
		signal.throwIfAborted();
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			Object.keys(result).sort().join() !== "grant,state,validForMs" ||
			!("state" in result) ||
			result.state !== "authorized" ||
			!("validForMs" in result) ||
			!Number.isSafeInteger(result.validForMs) ||
			(result.validForMs as number) < 1 ||
			(result.validForMs as number) > 5000 ||
			!("grant" in result) ||
			!result.grant ||
			typeof result.grant !== "object" ||
			Array.isArray(result.grant) ||
			Object.keys(result.grant).sort().join() !== "grantId,profileId,version"
		)
			throw new Error("BROWSER_GRANT_UNCONFIRMED");
		const grant = result.grant as CompanyComputerBrowserGrant;
		if (
			typeof grant.profileId !== "string" ||
			typeof grant.grantId !== "string" ||
			!COMPANY_COMPUTER_UUID.test(grant.profileId) ||
			!COMPANY_COMPUTER_UUID.test(grant.grantId) ||
			!Number.isSafeInteger(grant.version) ||
			grant.version < 1
		)
			throw new Error("BROWSER_GRANT_UNCONFIRMED");
		return Object.freeze({ profileId: grant.profileId, grantId: grant.grantId, version: grant.version });
	}

	/** The grant to start the browser process with. SQL records who was present. */
	open(
		binding: CompanyComputerScreenBinding,
		opener: CompanyComputerScreenBrowserOpener,
		signal: AbortSignal,
	): Promise<CompanyComputerBrowserGrant> {
		return this.#grant(binding, opener, signal);
	}

	async assertGranted(
		grant: CompanyComputerBrowserGrant,
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
	): Promise<void> {
		grant = structuredClone(grant);
		if (
			Object.keys(grant).sort().join() !== "grantId,profileId,version" ||
			!COMPANY_COMPUTER_UUID.test(grant.profileId) ||
			!COMPANY_COMPUTER_UUID.test(grant.grantId) ||
			!Number.isSafeInteger(grant.version) ||
			grant.version < 1
		)
			throw new Error("INVALID_BROWSER_GRANT");
		const current = await this.#grant(binding, null, signal);
		if (
			current.profileId !== grant.profileId ||
			current.grantId !== grant.grantId ||
			current.version !== grant.version
		)
			throw new Error("BROWSER_GRANT_UNCONFIRMED");
	}
}

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
