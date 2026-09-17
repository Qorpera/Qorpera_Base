/** Portable data-only state mapping shared by provider preparation and guest
 * runtime. No filesystem, authority lookup, client or provider implementation. */
const COMPANY_COMPUTER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface OfficeStateScope {
	readonly companyId: string;
	readonly environmentId: string;
	readonly companyComputerId: string;
	readonly logicalComputerId: string;
}
interface OfficeStateScreenBinding extends OfficeStateScope {
	readonly computerGeneration: number;
	readonly screenId: string;
	readonly screenOrdinal: number;
	readonly screenGeneration: number;
	readonly staffAgentId: string;
}
interface OfficeStateBrowserGrant {
	readonly profileId: string;
	readonly grantId: string;
	readonly version: number;
}
export interface CompanyComputerGuestLayout {
	workbenchRoot: string;
	desktopHome: string;
	screenStateRoot: string;
	/** Broker-only; never mounted into arbitrary agent shell/file-manager surfaces. */
	browserProfilesRoot: string;
	/** Layout version 2: company-owned kept state (shared browser sign-ins), service-only. */
	companyRoot?: string;
}
function isOfficeStatePath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		path.startsWith("/") &&
		path !== "/" &&
		path.length <= 4096 &&
		!/[\x00-\x1f\x7f\\]/.test(path) &&
		path
			.slice(1)
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}
export function assertCompanyComputerGuestLayout(layout: CompanyComputerGuestLayout): void {
	const paths = Object.values(layout);
	const keys = Object.keys(layout).sort().join();
	if (
		(keys !== "browserProfilesRoot,desktopHome,screenStateRoot,workbenchRoot" &&
			keys !== "browserProfilesRoot,companyRoot,desktopHome,screenStateRoot,workbenchRoot") ||
		paths.some(
			(path) =>
				!isOfficeStatePath(path) ||
				/(?:^|\/)(?:live|company-live|identity|credentials|\.codex|\.claude)(?:\/|$)/.test(path),
		)
	)
		throw new Error("UNSAFE_COMPUTER_LAYOUT");
	for (let i = 0; i < paths.length; i++)
		for (let j = i + 1; j < paths.length; j++)
			if (paths[i] === paths[j] || paths[i].startsWith(`${paths[j]}/`) || paths[j].startsWith(`${paths[i]}/`))
				throw new Error("OVERLAPPING_COMPUTER_LAYOUT");
}
function assertScope(actual: OfficeStateScope, expected: OfficeStateScope): void {
	for (const key of ["companyId", "environmentId", "companyComputerId", "logicalComputerId"] as const)
		if (typeof actual[key] !== "string" || !COMPANY_COMPUTER_UUID.test(actual[key]) || actual[key] !== expected[key])
			throw new Error("COMPUTER_BINDING_MISMATCH");
}
function assertBinding(actual: OfficeStateScreenBinding, expected: OfficeStateScreenBinding): void {
	assertScope(actual, expected);
	for (const key of ["screenId", "staffAgentId"] as const)
		if (typeof actual[key] !== "string" || !COMPANY_COMPUTER_UUID.test(actual[key]) || actual[key] !== expected[key])
			throw new Error("SCREEN_BINDING_MISMATCH");
	for (const key of ["computerGeneration", "screenGeneration", "screenOrdinal"] as const)
		if (!Number.isSafeInteger(actual[key]) || actual[key] < 1 || actual[key] !== expected[key])
			throw new Error("SCREEN_BINDING_MISMATCH");
	if (actual.screenOrdinal > 32) throw new Error("SCREEN_BINDING_MISMATCH");
}

export interface CompanyComputerLegacyScreen extends OfficeStateScope {
	readonly screenId: string;
	readonly screenOrdinal: number;
	readonly staffAgentId: string;
}

export interface CompanyComputerStateAdoptionInput {
	readonly scope: OfficeStateScope;
	/** Actual configured roots from the old guest, never inferred from a model or a directory listing. */
	readonly legacyRoots: { readonly screenStateRoot: string; readonly browserProfilesRoot: string };
	readonly layout: CompanyComputerGuestLayout;
	readonly mappings: readonly {
		readonly legacy: CompanyComputerLegacyScreen;
		readonly binding: OfficeStateScreenBinding;
		/** Explicit grant from the existing authority, or null to leave the old profile quarantined. */
		readonly browserProfile: OfficeStateBrowserGrant | null;
	}[];
}

export interface CompanyComputerStateAdoptionEntry {
	readonly legacyOrdinal: number;
	readonly binding: OfficeStateScreenBinding;
	readonly desktop: { readonly source: string; readonly destination: string };
	readonly browser:
		| { readonly disposition: "quarantine"; readonly source: string }
		| {
				readonly disposition: "adopt";
				readonly source: string;
				readonly destination: string;
				readonly grant: OfficeStateBrowserGrant;
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
	assertScope(input.scope, input.scope);
	assertCompanyComputerGuestLayout(input.layout);
	const roots = [input.legacyRoots.screenStateRoot, input.legacyRoots.browserProfilesRoot];
	for (const root of roots) {
		if (
			typeof root !== "string" ||
			!isOfficeStatePath(root) ||
			root === "/" ||
			root.endsWith("/") ||
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
		assertScope(legacy, input.scope);
		assertScope(binding, input.scope);
		assertBinding(binding, binding);
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
		const source = `${input.legacyRoots.browserProfilesRoot}/${name}`;
		return Object.freeze({
			legacyOrdinal: legacy.screenOrdinal,
			binding: Object.freeze({ ...binding }),
			desktop: Object.freeze({
				source: `${input.legacyRoots.screenStateRoot}/${name}`,
				destination: `${input.layout.screenStateRoot}/${binding.screenId}`,
			}),
			browser: Object.freeze(
				browserProfile === null
					? { disposition: "quarantine" as const, source }
					: {
							disposition: "adopt" as const,
							source,
							destination: `${input.layout.browserProfilesRoot}/${browserProfile.profileId}`,
							grant: Object.freeze({ ...browserProfile }),
						},
			),
		});
	});
	return Object.freeze(entries.sort((a, b) => a.legacyOrdinal - b.legacyOrdinal));
}
