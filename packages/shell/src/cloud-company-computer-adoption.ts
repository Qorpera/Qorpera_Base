import { isAbsolute, join, normalize } from "node:path";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
} from "./cloud-company-computer-contract.ts";
import {
	assertCompanyComputerGuestLayout,
	type CompanyComputerBrowserGrant,
	type CompanyComputerGuestLayout,
} from "./cloud-company-computer-guest.ts";

export interface CompanyComputerLegacyScreen extends CompanyComputerScope {
	readonly screenId: string;
	readonly screenOrdinal: number;
	readonly staffAgentId: string;
}

export interface CompanyComputerStateAdoptionInput {
	readonly scope: CompanyComputerScope;
	/** Actual configured roots from the old guest, never inferred from a model or a directory listing. */
	readonly legacyRoots: { readonly screenStateRoot: string; readonly browserProfilesRoot: string };
	readonly layout: CompanyComputerGuestLayout;
	readonly mappings: readonly {
		readonly legacy: CompanyComputerLegacyScreen;
		readonly binding: CompanyComputerScreenBinding;
		/** Explicit grant from the existing authority, or null to leave the old profile quarantined. */
		readonly browserProfile: CompanyComputerBrowserGrant | null;
	}[];
}

export interface CompanyComputerStateAdoptionEntry {
	readonly legacyOrdinal: number;
	readonly binding: CompanyComputerScreenBinding;
	readonly desktop: { readonly source: string; readonly destination: string };
	readonly browser:
		| { readonly disposition: "quarantine"; readonly source: string }
		| {
				readonly disposition: "adopt";
				readonly source: string;
				readonly destination: string;
				readonly grant: CompanyComputerBrowserGrant;
		  };
}

/**
 * Pure, non-executing adoption plan for the historical screen-N layout. This
 * neither grants access nor reads, copies, moves or deletes any bytes. The
 * existing authorized migration owner must validate the inventory, live grants,
 * stopped services, physical paths, contents and destination absence, then
 * record completion before guest admission. See the Step 4 handoff.
 */
export function planCompanyComputerStateAdoption(
	input: CompanyComputerStateAdoptionInput,
): readonly CompanyComputerStateAdoptionEntry[] {
	assertCompanyComputerScope(input.scope, input.scope);
	assertCompanyComputerGuestLayout(input.layout);
	const roots = [input.legacyRoots.screenStateRoot, input.legacyRoots.browserProfilesRoot];
	for (const root of roots) {
		if (
			typeof root !== "string" ||
			!isAbsolute(root) ||
			root === "/" ||
			root.endsWith("/") ||
			normalize(root) !== root ||
			/[\0\r\n]/.test(root) ||
			/(?:^|\/)(?:live|company-live|identity|credentials|\.codex|\.claude)(?:\/|$)/.test(root)
		)
			throw new Error("UNSAFE_LEGACY_STATE_ROOT");
	}
	if (roots[0] === roots[1] || roots[0].startsWith(`${roots[1]}/`) || roots[1].startsWith(`${roots[0]}/`))
		throw new Error("OVERLAPPING_LEGACY_STATE_ROOTS");
	const ordinals = new Set<number>();
	const targetOrdinals = new Set<number>();
	const screens = new Set<string>();
	const agents = new Set<string>();
	const profiles = new Set<string>();
	const entries = input.mappings.map(({ legacy, binding, browserProfile }): CompanyComputerStateAdoptionEntry => {
		assertCompanyComputerScope(legacy, input.scope);
		assertCompanyComputerScope(binding, input.scope);
		assertCompanyComputerScreenBinding(binding, binding);
		if (
			legacy.screenId !== binding.screenId ||
			legacy.staffAgentId !== binding.staffAgentId ||
			!Number.isSafeInteger(legacy.screenOrdinal) ||
			legacy.screenOrdinal < 1 ||
			legacy.screenOrdinal > 32
		)
			throw new Error("LEGACY_SCREEN_BINDING_MISMATCH");
		if (
			ordinals.has(legacy.screenOrdinal) ||
			targetOrdinals.has(binding.screenOrdinal) ||
			screens.has(binding.screenId) ||
			agents.has(binding.staffAgentId)
		)
			throw new Error("AMBIGUOUS_STATE_ADOPTION");
		ordinals.add(legacy.screenOrdinal);
		targetOrdinals.add(binding.screenOrdinal);
		screens.add(binding.screenId);
		agents.add(binding.staffAgentId);
		if (browserProfile !== null) {
			if (
				!browserProfile ||
				!COMPANY_COMPUTER_UUID.test(browserProfile.profileId) ||
				!COMPANY_COMPUTER_UUID.test(browserProfile.grantId) ||
				!Number.isSafeInteger(browserProfile.version) ||
				browserProfile.version < 1
			)
				throw new Error("EXPLICIT_BROWSER_PROFILE_DISPOSITION_REQUIRED");
			if (profiles.has(browserProfile.profileId)) throw new Error("AMBIGUOUS_STATE_ADOPTION");
			profiles.add(browserProfile.profileId);
		}
		const name = `screen-${legacy.screenOrdinal}`;
		const source = join(input.legacyRoots.browserProfilesRoot, name);
		return Object.freeze({
			legacyOrdinal: legacy.screenOrdinal,
			binding: Object.freeze({ ...binding }),
			desktop: Object.freeze({
				source: join(input.legacyRoots.screenStateRoot, name),
				destination: join(input.layout.screenStateRoot, binding.screenId),
			}),
			browser: Object.freeze(
				browserProfile === null
					? { disposition: "quarantine" as const, source }
					: {
							disposition: "adopt" as const,
							source,
							destination: join(input.layout.browserProfilesRoot, browserProfile.profileId),
							grant: Object.freeze({ ...browserProfile }),
						},
			),
		});
	});
	return Object.freeze(entries.sort((a, b) => a.legacyOrdinal - b.legacyOrdinal));
}
