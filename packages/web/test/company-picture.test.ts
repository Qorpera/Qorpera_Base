import { describe, expect, it } from "vitest";
import { companyFigure } from "../src/ui/dom.ts";

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
