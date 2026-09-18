import {
	CloudCompanyComputerBrowserProfiles,
	type CloudCompanyComputerBrowserProfilesRpc,
} from "./cloud-company-computer-browser-profiles.ts";
import {
	assertCompanyComputerScope,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import { CloudCompanyComputerSignIn, type CloudCompanyComputerSignInRpc } from "./cloud-company-computer-sign-in.ts";

export interface MemberBrowserRecoveryCatalog {
	memberId: string;
	offices: { scope: CompanyComputerScope; ownsPrivacy: boolean }[];
	nextAfter: string | null;
}
export type MemberBrowserRecoveryRpc = (
	method:
		| "qorpera_member_browser_recovery"
		| Parameters<CloudCompanyComputerBrowserProfilesRpc>[0]
		| Parameters<CloudCompanyComputerSignInRpc>[0],
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
function record(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("INVALID_BROWSER_RECOVERY_RESPONSE");
	return value as Record<string, unknown>;
}
/** Account-bound metadata recovery, independent of any open Company File.
 * Discovery never authorizes private input or resumes an office. */
export class CloudMemberBrowserRecovery {
	readonly #memberId: string;
	readonly #rpc: MemberBrowserRecoveryRpc;
	constructor(options: { memberId: string; rpc: MemberBrowserRecoveryRpc }) {
		if (!COMPANY_COMPUTER_UUID.test(options.memberId)) throw new Error("INVALID_BROWSER_RECOVERY_MEMBER");
		this.#memberId = options.memberId;
		this.#rpc = options.rpc;
	}
	async catalog(signal: AbortSignal, after: string | null = null): Promise<MemberBrowserRecoveryCatalog> {
		if (after !== null && !COMPANY_COMPUTER_UUID.test(after)) throw new Error("INVALID_BROWSER_RECOVERY_CURSOR");
		let response: { data: unknown; error: unknown };
		try {
			response = await companyComputerRequest(
				(s) => this.#rpc("qorpera_member_browser_recovery", { p_after: after }, s),
				signal,
			);
		} catch {
			throw new Error("BROWSER_RECOVERY_UNCONFIRMED_REFRESH_STATUS");
		}
		if (!response || response.error) throw new Error("BROWSER_RECOVERY_UNCONFIRMED_REFRESH_STATUS");
		const value = record(response.data, "memberId,nextAfter,offices");
		if (value.memberId !== this.#memberId || !Array.isArray(value.offices) || value.offices.length > 50)
			throw new Error("INVALID_BROWSER_RECOVERY_RESPONSE");
		let previous = after;
		const offices = value.offices.map((input) => {
			const row = record(input, "ownsPrivacy,scope");
			record(row.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
			const scope = row.scope as CompanyComputerScope;
			assertCompanyComputerScope(scope, scope);
			if (typeof row.ownsPrivacy !== "boolean" || (previous !== null && scope.companyComputerId <= previous))
				throw new Error("INVALID_BROWSER_RECOVERY_RESPONSE");
			previous = scope.companyComputerId;
			return { scope: { ...scope }, ownsPrivacy: row.ownsPrivacy };
		});
		if (value.nextAfter !== null && (offices.length !== 50 || value.nextAfter !== previous))
			throw new Error("INVALID_BROWSER_RECOVERY_CURSOR");
		return { memberId: this.#memberId, offices, nextAfter: value.nextAfter as string | null };
	}
	profiles(scope: CompanyComputerScope): CloudCompanyComputerBrowserProfiles {
		return new CloudCompanyComputerBrowserProfiles({ scope, memberId: this.#memberId, rpc: this.#rpc });
	}
	signIn(scope: CompanyComputerScope): CloudCompanyComputerSignIn {
		return new CloudCompanyComputerSignIn({ scope, memberId: this.#memberId, rpc: this.#rpc });
	}
}
