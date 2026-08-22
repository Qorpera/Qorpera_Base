export const FREEMIUM_COMPANY_STORAGE_BYTES = 50 * 1024 * 1024 * 1024;

export interface ProductContext {
	account: {
		defaultPlan: "freemium";
		entitlementAuthority: "cloud";
	};
	company: {
		authority: "cloud";
		defaultIncludedStorageBytes: number;
	};
}

/** A company is always cloud-authoritative. The desktop projects account and
 * company state without describing itself as a placement or execution host. */
export function productContext(): ProductContext {
	return {
		account: { defaultPlan: "freemium", entitlementAuthority: "cloud" },
		company: {
			authority: "cloud",
			defaultIncludedStorageBytes: FREEMIUM_COMPANY_STORAGE_BYTES,
		},
	};
}
