import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/app/router.ts";
import { profileA } from "./fixtures.ts";

describe("company routes", () => {
	it("opens the company home for a section that no longer exists", () => {
		// The notification inbox was removed; old links land on the company home.
		expect(parseRoute(`#/c/${profileA.profileId}/notifications`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "home",
		});
	});
});

describe("account routes", () => {
	it("opens the companies page for the removed cloud check", () => {
		expect(parseRoute("#/cloud-check")).toEqual({ name: "hub" });
	});
});
