import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	advanceCompanyGateCreation,
	beginCompanyGateCreation,
	companyKernelStatePath,
	companyRootId,
	completeCompanyGateCreation,
	hasCompanyGateTrust,
	hasCompanyKernelState,
	listPendingCompanyGateCreations,
	type ProductStorageExpectation,
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

	it("derives one stable company identity per canonical root", () => {
		const company = join(root, "company");
		const sibling = join(root, "sibling");
		mkdirSync(company);
		mkdirSync(sibling);
		const id = companyRootId(company);
		expect(id).toMatch(/^[0-9a-f]{64}$/);
		// Deterministic, canonicalizing (trailing separators, Windows casing),
		// and shared with the kernel-state location for the same root.
		expect(companyRootId(join(company, "a", ".."))).toBe(id);
		if (process.platform === "win32") expect(companyRootId(company.toUpperCase())).toBe(id);
		expect(companyRootId(sibling)).not.toBe(id);
		expect(companyKernelStatePath(userData, company)).toContain(id);
		// A root that does not exist has no identity — callers canonicalize
		// (and thereby validate) the root before ever asking for one.
		expect(() => companyRootId(join(root, "missing"))).toThrow();
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
		const expectations: ProductStorageExpectation[] = [
			{
				path: "departments/widget-development/repository",
				kind: "repository" as const,
				remote: "https://example.invalid/widget.git",
			},
		];

		reconcileCompanyProductStorage(userData, company, expectations, true);
		expect(hasCompanyKernelState(userData, company)).toBe(true);
		reconcileCompanyProductStorage(userData, company, expectations, false);

		mkdirSync(repository, { recursive: true });
		expect(spawnSync("git", ["init"], { cwd: repository, stdio: "ignore" }).status).toBe(0);
		expect(
			spawnSync("git", ["remote", "add", "origin", expectations[0].remote], {
				cwd: repository,
				stdio: "ignore",
			}).status,
		).toBe(0);
		writeFileSync(join(repository, "README.md"), "identity\n", "utf-8");
		for (const args of [
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "identity"],
		]) {
			expect(spawnSync("git", args, { cwd: repository, stdio: "ignore" }).status).toBe(0);
		}
		expectations[0].head = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: repository,
			encoding: "utf-8",
		}).stdout.trim();
		reconcileCompanyProductStorage(userData, company, expectations, false);
		rmSync(repository, { recursive: true });
		mkdirSync(repository);
		expect(spawnSync("git", ["init"], { cwd: repository, stdio: "ignore" }).status).toBe(0);
		expect(
			spawnSync("git", ["remote", "add", "origin", expectations[0].remote], {
				cwd: repository,
				stdio: "ignore",
			}).status,
		).toBe(0);
		expect(() => reconcileCompanyProductStorage(userData, company, expectations, false)).toThrow(
			"Previously hydrated product repository is missing",
		);
	});

	it("persists and completes crash-recovery state for gate creation", () => {
		const company = join(root, "company");
		mkdirSync(company);
		const file = "gate-aaaaaaaa.md";
		const hash = "a".repeat(64);
		beginCompanyGateCreation(userData, company, file, hash, "session.jsonl");
		expect(listPendingCompanyGateCreations(userData, company)).toEqual([
			expect.objectContaining({ file, hash, trailFile: "session.jsonl", phase: "planned" }),
		]);
		advanceCompanyGateCreation(userData, company, file, hash, "session.jsonl", "started");
		advanceCompanyGateCreation(userData, company, file, hash, "recovery.jsonl", "finalizing-created");
		expect(listPendingCompanyGateCreations(userData, company)).toEqual([
			expect.objectContaining({ file, hash, trailFile: "recovery.jsonl", phase: "finalizing-created" }),
		]);
		completeCompanyGateCreation(userData, company, file, hash);
		expect(listPendingCompanyGateCreations(userData, company)).toEqual([]);
	});

	it("rejects a same-origin replacement of previously hydrated product storage", () => {
		const company = join(root, "company");
		const repository = join(company, "departments", "widget-development", "repository");
		const replacement = join(root, "replacement");
		mkdirSync(repository, { recursive: true });
		writeFileSync(join(repository, "README.md"), "identity\n", "utf-8");
		for (const args of [
			["init"],
			["add", "README.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "identity"],
			["remote", "add", "origin", "https://example.invalid/widget.git"],
		]) {
			expect(spawnSync("git", args, { cwd: repository, stdio: "ignore" }).status).toBe(0);
		}
		const expectation: ProductStorageExpectation = {
			path: "departments/widget-development/repository",
			kind: "repository",
			remote: "https://example.invalid/widget.git",
			head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf-8" }).stdout.trim(),
		};
		reconcileCompanyProductStorage(userData, company, [expectation], true);
		expect(spawnSync("git", ["clone", "--no-hardlinks", repository, replacement], { stdio: "ignore" }).status).toBe(
			0,
		);
		expect(
			spawnSync("git", ["remote", "set-url", "origin", expectation.remote], {
				cwd: replacement,
				stdio: "ignore",
			}).status,
		).toBe(0);
		rmSync(repository, { recursive: true });
		renameSync(replacement, repository);
		expect(() => reconcileCompanyProductStorage(userData, company, [expectation], false)).toThrow("identity changed");
	});

	it("fails closed for a new missing product record after local state is bound", () => {
		const company = join(root, "company");
		mkdirSync(company);
		reconcileCompanyProductStorage(userData, company, [], true);

		expect(() =>
			reconcileCompanyProductStorage(
				userData,
				company,
				[
					{
						path: "departments/widget-development/worktrees/task-a",
						kind: "worktree",
						remote: "https://example.invalid/widget.git",
					},
				],
				false,
			),
		).toThrow("New product worktree record has no local storage");
	});
});
