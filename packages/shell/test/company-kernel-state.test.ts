import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	companyKernelStatePath,
	hasCompanyGateTrust,
	hasCompanyKernelState,
	reconcileCompanyProductStorage,
	rememberCompanyGateTrust,
	revokeCompanyGateTrust,
} from "../src/company-kernel-state.ts";

describe("desktop company kernel state", () => {
	let root: string;
	let userData: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-kernel-state-"));
		userData = join(root, "user-data");
		mkdirSync(userData);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("persists and revokes path-scoped gate trust outside company Git", () => {
		const company = join(root, "company");
		mkdirSync(company);
		const file = "gate-aaaaaaaa.md";
		const hash = "a".repeat(64);

		rememberCompanyGateTrust(userData, company, file, hash);
		expect(hasCompanyGateTrust(userData, company, file, hash)).toBe(true);
		expect(companyKernelStatePath(userData, company).startsWith(userData)).toBe(true);
		const copiedCompany = join(root, "copied-company");
		mkdirSync(copiedCompany);
		expect(hasCompanyGateTrust(userData, copiedCompany, file, hash)).toBe(false);
		revokeCompanyGateTrust(userData, company, file, hash);
		expect(hasCompanyGateTrust(userData, company, file, hash)).toBe(false);
		rmSync(company, { recursive: true });
		mkdirSync(company);
		expect(() => hasCompanyGateTrust(userData, company, file, hash)).toThrow("Company kernel state is invalid");
	});

	it("distinguishes initial clone hydration from disappearance of observed product Git", () => {
		const company = join(root, "company");
		const repository = join(company, "departments", "widget-development", "repository");
		mkdirSync(company);
		const expectations = [
			{
				path: "departments/widget-development/repository",
				kind: "repository" as const,
			},
		];

		reconcileCompanyProductStorage(userData, company, expectations, true);
		expect(hasCompanyKernelState(userData, company)).toBe(true);
		reconcileCompanyProductStorage(userData, company, expectations, false);

		mkdirSync(join(repository, ".git"), { recursive: true });
		reconcileCompanyProductStorage(userData, company, expectations, false);
		rmSync(repository, { recursive: true });
		expect(() => reconcileCompanyProductStorage(userData, company, expectations, false)).toThrow(
			"Previously hydrated product repository is missing",
		);
	});

	it("fails closed for a new missing product record after local state is bound", () => {
		const company = join(root, "company");
		mkdirSync(company);
		reconcileCompanyProductStorage(userData, company, [], true);

		expect(() =>
			reconcileCompanyProductStorage(
				userData,
				company,
				[{ path: "departments/widget-development/worktrees/task-a", kind: "worktree" }],
				false,
			),
		).toThrow("New product worktree record has no local storage");
	});
});
