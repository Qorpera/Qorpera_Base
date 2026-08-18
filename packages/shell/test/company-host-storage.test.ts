import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companyHostStorageFile } from "../src/company-host-storage.ts";

describe("company host storage migration", () => {
	let userData: string;
	const companyId = "a".repeat(64);

	beforeEach(() => {
		userData = mkdtempSync(join(tmpdir(), "qorpera-company-host-storage-"));
	});

	afterEach(() => {
		rmSync(userData, { recursive: true, force: true });
	});

	it("uses the host namespace for new state", () => {
		expect(companyHostStorageFile(userData, companyId, "wakes.json")).toBe(
			join(userData, "company-host-state", companyId, "wakes.json"),
		);
	});

	it("moves one retired state file without changing its bytes", () => {
		const legacy = join(userData, "company-kernel-state", companyId, "wakes.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		writeFileSync(legacy, "legacy-state\n", "utf-8");

		const current = companyHostStorageFile(userData, companyId, "wakes.json");
		expect(current).toBe(join(userData, "company-host-state", companyId, "wakes.json"));
		expect(readFileSync(current, "utf-8")).toBe("legacy-state\n");
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(join(userData, "company-kernel-state"))).toBe(false);
	});

	it("keeps newer host state authoritative when both files exist", () => {
		const legacy = join(userData, "company-kernel-state", companyId, "wakes.json");
		const current = join(userData, "company-host-state", companyId, "wakes.json");
		mkdirSync(join(legacy, ".."), { recursive: true });
		mkdirSync(join(current, ".."), { recursive: true });
		writeFileSync(legacy, "legacy\n", "utf-8");
		writeFileSync(current, "current\n", "utf-8");

		expect(companyHostStorageFile(userData, companyId, "wakes.json")).toBe(current);
		expect(readFileSync(current, "utf-8")).toBe("current\n");
		expect(readFileSync(legacy, "utf-8")).toBe("legacy\n");
	});

	it("rejects path-shaped storage identities", () => {
		expect(() => companyHostStorageFile(userData, "../company", "wakes.json")).toThrow("identity is invalid");
		expect(() => companyHostStorageFile(userData, companyId, "../wakes.json")).toThrow("identity is invalid");
	});
});
