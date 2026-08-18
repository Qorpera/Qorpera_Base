import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	backgroundCompanyRegistryPath,
	readBackgroundCompanyRoots,
	setBackgroundCompanyEnabled,
} from "../src/background-companies.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "qorpera-background-companies-"));
	roots.push(root);
	return root;
}

describe("background company registry", () => {
	it("enables and disables independent company roots", () => {
		const userData = fixture();
		const first = join(userData, "first");
		const second = join(userData, "second");

		expect(setBackgroundCompanyEnabled(userData, first, true)).toEqual([first]);
		expect(setBackgroundCompanyEnabled(userData, second, true)).toEqual([first, second]);
		expect(setBackgroundCompanyEnabled(userData, first, false)).toEqual([second]);
		expect(readBackgroundCompanyRoots(userData)).toEqual([second]);
	});

	it("fails closed for malformed persisted state", () => {
		const userData = fixture();
		writeFileSync(backgroundCompanyRegistryPath(userData), "not-json", "utf-8");
		expect(readBackgroundCompanyRoots(userData)).toEqual([]);
	});
});
