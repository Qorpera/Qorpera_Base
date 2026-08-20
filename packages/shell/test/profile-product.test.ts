import { describe, expect, it } from "vitest";
import { INCLUDED_COMPANY_STORAGE_BYTES, productContext } from "../src/profile-product.ts";

describe("profile product model", () => {
	it("models the app as an interface to a cloud company", () => {
		expect(productContext()).toEqual({
			account: { plan: "freemium" },
			company: {
				authority: "cloud",
				includedStorageBytes: INCLUDED_COMPANY_STORAGE_BYTES,
			},
		});
	});
});
