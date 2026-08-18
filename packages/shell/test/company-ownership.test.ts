import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimCompany, claimUnownedCompanies, companyOwnedBy, forgetCompany } from "../src/company-ownership.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-company-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("company ownership", () => {
	const founder = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
	const other = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

	it("claims unowned companies once and never transfers them implicitly", () => {
		const userData = temporaryRoot();
		const first = join(userData, "company-a");
		const second = join(userData, "company-b");
		claimUnownedCompanies(userData, founder, [first, second]);
		expect(companyOwnedBy(userData, founder, first)).toBe(true);
		expect(companyOwnedBy(userData, other, first)).toBe(false);
		claimUnownedCompanies(userData, other, [first]);
		expect(companyOwnedBy(userData, founder, first)).toBe(true);
	});

	it("binds and removes an explicitly created company", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimCompany(userData, founder, root);
		expect(companyOwnedBy(userData, founder, root)).toBe(true);
		expect(() => claimCompany(userData, other, root)).toThrow("another Qorpera account");
		forgetCompany(userData, founder, root);
		expect(companyOwnedBy(userData, founder, root)).toBe(false);
	});

	it("reads legacy profile ownership until the company record is next written", () => {
		const userData = temporaryRoot();
		const company = join(userData, "company-a");
		mkdirSync(userData, { recursive: true });
		writeFileSync(
			join(userData, "profile-owners.json"),
			JSON.stringify({
				schema: "qorpera.profile-owners/v1",
				profiles: { [process.platform === "win32" ? resolve(company).toLowerCase() : resolve(company)]: founder },
			}),
			"utf-8",
		);
		expect(companyOwnedBy(userData, founder, company)).toBe(true);
		claimCompany(userData, founder, company);
		expect(companyOwnedBy(userData, founder, company)).toBe(true);
	});
});
