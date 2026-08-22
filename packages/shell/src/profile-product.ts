export const INCLUDED_COMPANY_STORAGE_BYTES = 50 * 1024 * 1024 * 1024;

export interface ProductContext {
	account: {
		plan: "freemium";
	};
	company: {
		authority: "cloud";
		includedStorageBytes: number;
	};
}

/** A company is always cloud-authoritative. The desktop projects account and
 * company state without describing itself as a placement or execution host. */
export function productContext(): ProductContext {
	return {
		account: { plan: "freemium" },
		company: {
			authority: "cloud",
			includedStorageBytes: INCLUDED_COMPANY_STORAGE_BYTES,
		},
	};
}
