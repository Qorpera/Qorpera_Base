export const PROFILE_PLACEMENTS = ["local", "hosted"] as const;
export type ProfilePlacement = (typeof PROFILE_PLACEMENTS)[number];

export const EXECUTION_TARGETS = ["local", "cloud", "computer"] as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];

export type AccountEntitlementStatus = "not-connected";
export type BillingSponsorStatus = "not-applicable" | "not-configured";

export interface ProductContext {
	account: {
		entitlement: AccountEntitlementStatus;
	};
	profile: {
		placement: ProfilePlacement;
		billingSponsor: BillingSponsorStatus;
	};
	execution: {
		target: ExecutionTarget;
	};
}

export function isProfilePlacement(value: unknown): value is ProfilePlacement {
	return PROFILE_PLACEMENTS.some((candidate) => candidate === value);
}

/**
 * Projects the product dimensions the current shell can prove. Placement is
 * profile-scoped; entitlement is account-scoped; execution is selected per
 * session; and hosted profile costs eventually belong to a billing sponsor.
 */
export function productContext(profileType: "local" | "cloud"): ProductContext {
	return {
		account: { entitlement: "not-connected" },
		profile: {
			placement: profileType === "cloud" ? "hosted" : "local",
			billingSponsor: profileType === "cloud" ? "not-configured" : "not-applicable",
		},
		execution: { target: "local" },
	};
}
