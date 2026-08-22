import { describe, expect, it } from "vitest";
import { FREEMIUM_COMPANY_STORAGE_BYTES, productContext } from "../src/profile-product.ts";

describe("profile product model", () => {
	it("models the app as an interface to a cloud company", () => {
		expect(productContext()).toEqual({
			account: { defaultPlan: "freemium", entitlementAuthority: "cloud" },
			company: {
				authority: "cloud",
				defaultIncludedStorageBytes: FREEMIUM_COMPANY_STORAGE_BYTES,
			},
		});
	});
});
