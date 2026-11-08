import { describe, expect, it } from "vitest";
import { COMPANY_COLORS, companyColor, companyFigure } from "../src/ui/dom.ts";

/* The placeholder logo is derived, not stored, so it has to be stable for a
 * given profile id and spread over the figures it can use. */

describe("company logo", () => {
	it("is stable for the same profile id", () => {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		expect(companyFigure(id)).toBe(companyFigure(id));
	});

	it("never hands a company the Co-Founder's Crown", () => {
		for (let index = 0; index < 200; index++) expect(companyFigure(`company-${index}`)).not.toBe("crown");
	});

	it("uses every available figure across a spread of ids", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 400; index++) seen.add(companyFigure(`company-${index}`));
		expect(seen.size).toBe(6);
	});
});

describe("company colour", () => {
	it("is stable for the same profile id", () => {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		expect(companyColor(id)).toBe(companyColor(id));
	});

	it("is never charcoal or gray, and uses every bright colour", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 400; index++) seen.add(companyColor(`company-${index}`));
		expect(seen.has("#312f2d")).toBe(false);
		expect(seen.has("#7c7c7a")).toBe(false);
		expect(seen.size).toBe(COMPANY_COLORS.length);
	});

	it("does not follow the figure", () => {
		const pairs = new Set<string>();
		for (let index = 0; index < 600; index++)
			pairs.add(`${companyFigure(`company-${index}`)} ${companyColor(`company-${index}`)}`);
		expect(pairs.size).toBeGreaterThan(40);
	});
});
