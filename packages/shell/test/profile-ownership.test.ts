import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimProfile, claimUnownedProfiles, forgetProfile, profileOwnedBy } from "../src/profile-ownership.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-profile-owner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("profile ownership", () => {
	const founder = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
	const other = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

	it("claims legacy profiles once and never transfers them implicitly", () => {
		const userData = temporaryRoot();
		const first = join(userData, "company-a");
		const second = join(userData, "company-b");
		claimUnownedProfiles(userData, founder, [first, second]);
		expect(profileOwnedBy(userData, founder, first)).toBe(true);
		expect(profileOwnedBy(userData, other, first)).toBe(false);
		claimUnownedProfiles(userData, other, [first]);
		expect(profileOwnedBy(userData, founder, first)).toBe(true);
	});

	it("binds and removes an explicitly created profile", () => {
		const userData = temporaryRoot();
		const root = join(userData, "company-a");
		claimProfile(userData, founder, root);
		expect(profileOwnedBy(userData, founder, root)).toBe(true);
		expect(() => claimProfile(userData, other, root)).toThrow("another Qorpera account");
		forgetProfile(userData, founder, root);
		expect(profileOwnedBy(userData, founder, root)).toBe(false);
	});
});
