import { describe, expect, it } from "vitest";
import { companyCharacter } from "../src/ui/dom.ts";

/* The picture is derived, not stored, so it has to be stable for a given
 * profile id and spread over the four characters. */

describe("company picture", () => {
	it("is stable for the same profile id", () => {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		expect(companyCharacter(id)).toBe(companyCharacter(id));
	});

	it("uses every character across a spread of ids", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 200; index++) seen.add(companyCharacter(`company-${index}`));
		expect(seen.size).toBe(4);
	});
});
