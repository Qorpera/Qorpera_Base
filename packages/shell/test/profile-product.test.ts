import { describe, expect, it } from "vitest";
import { isProfilePlacement, productContext } from "../src/profile-product.ts";

describe("profile product model", () => {
	it("keeps local placement independent from account entitlement and execution", () => {
		expect(productContext("local")).toEqual({
			account: { entitlement: "not-connected" },
			profile: { placement: "local", billingSponsor: "not-applicable" },
			execution: { target: "local" },
		});
	});

	it("does not imply hosted execution or a payer from hosted placement", () => {
		expect(productContext("cloud")).toEqual({
			account: { entitlement: "not-connected" },
			profile: { placement: "hosted", billingSponsor: "not-configured" },
			execution: { target: "local" },
		});
	});

	it("accepts only persisted setup placement choices", () => {
		expect(isProfilePlacement("local")).toBe(true);
		expect(isProfilePlacement("hosted")).toBe(true);
		expect(isProfilePlacement("cloud")).toBe(false);
		expect(isProfilePlacement("computer")).toBe(false);
	});
});
