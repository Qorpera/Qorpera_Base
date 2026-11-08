import { describe, expect, it } from "vitest";
import { appHash, conceptsHash, parseRoute, routeHash } from "../src/app/router.ts";
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

	it.each([
		"approvals",
		"organization",
		`project/00000000-0000-4000-8000-000000000001`,
		`snapshot/00000000-0000-4000-8000-000000000002`,
		`proposal/00000000-0000-4000-8000-000000000003`,
	])("opens the company home for the removed %s page", (section) => {
		// Settings no longer links to Approvals or Organization, and every company is a folder now, with no
		// snapshot or proposal pages; old links land on the company home.
		expect(parseRoute(`#/c/${profileA.profileId}/${section}`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "home",
		});
	});

	it("opens an agent's app as a page of its own, by its folder's name", () => {
		const route = parseRoute(`#/c/${profileA.profileId}/a/sales-board`);
		expect(route).toEqual({ name: "company", profileId: profileA.profileId, section: "app", id: "sales-board" });
		expect(routeHash(route)).toBe(`#/c/${profileA.profileId}/a/sales-board`);
		expect(appHash(profileA.profileId, "sales-board")).toBe(`#/c/${profileA.profileId}/a/sales-board`);
		// An app's folder is named as a page's: anything else, or no name, is the company home.
		for (const bad of ["Sales", "sales_board", "-sales", "", "x".repeat(65)])
			expect(parseRoute(`#/c/${profileA.profileId}/a/${bad}`)).toEqual({
				name: "company",
				profileId: profileA.profileId,
				section: "home",
			});
	});

	it("opens the Concepts viewer at its newest concept, or at the concept it names", () => {
		const newest = parseRoute(`#/c/${profileA.profileId}/concepts`);
		expect(newest).toEqual({ name: "company", profileId: profileA.profileId, section: "concepts" });
		expect(routeHash(newest)).toBe(`#/c/${profileA.profileId}/concepts`);
		const named = parseRoute(`#/c/${profileA.profileId}/concepts/shop-a`);
		expect(named).toEqual({ name: "company", profileId: profileA.profileId, section: "concepts", id: "shop-a" });
		expect(routeHash(named)).toBe(`#/c/${profileA.profileId}/concepts/shop-a`);
		expect(conceptsHash(profileA.profileId)).toBe(`#/c/${profileA.profileId}/concepts`);
		expect(conceptsHash(profileA.profileId, "shop-a")).toBe(`#/c/${profileA.profileId}/concepts/shop-a`);
		// A name no app folder has opens the newest concept.
		for (const bad of ["Shop", "shop_a", "-shop", "x".repeat(65)])
			expect(parseRoute(`#/c/${profileA.profileId}/concepts/${bad}`)).toEqual({
				name: "company",
				profileId: profileA.profileId,
				section: "concepts",
			});
	});

	it("opens the Company File for its removed history page", () => {
		expect(parseRoute(`#/c/${profileA.profileId}/file/history`)).toEqual({
			name: "company",
			profileId: profileA.profileId,
			section: "file",
		});
	});
});

describe("account routes", () => {
	it("opens the companies page for the removed cloud check", () => {
		expect(parseRoute("#/cloud-check")).toEqual({ name: "hub" });
	});
});
