import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	claimCompanyRuntimeLock,
	companyRuntimeLockPath,
	releaseCompanyRuntimeLock,
} from "../src/company-runtime-lock.ts";

const roots: string[] = [];

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "qorpera-company-runtime-lock-"));
	roots.push(root);
	const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf-8", shell: false });
	if (result.status !== 0) throw new Error(result.stderr || "git init failed");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("company runtime lock", () => {
	it("serializes the physical company root and releases atomically", () => {
		const root = repository();
		const first = claimCompanyRuntimeLock(root);
		expect(first.path).toBe(companyRuntimeLockPath(root));
		expect(() => claimCompanyRuntimeLock(root)).toThrow("already owned by another process");
		releaseCompanyRuntimeLock(first);
		expect(existsSync(first.path)).toBe(false);

		const second = claimCompanyRuntimeLock(root);
		releaseCompanyRuntimeLock(second);
	});

	it("refuses to release a lock whose ownership token changed", () => {
		const root = repository();
		const lock = claimCompanyRuntimeLock(root);
		const record = JSON.parse(readFileSync(lock.path, "utf-8")) as Record<string, unknown>;
		writeFileSync(lock.path, `${JSON.stringify({ ...record, token: crypto.randomUUID() })}\n`, "utf-8");

		expect(() => releaseCompanyRuntimeLock(lock)).toThrow("ownership changed before release");
		rmSync(lock.path, { force: true });
	});

	it("keeps shared lock state accessible across NAS-mapped guest uids", () => {
		const root = repository();
		const previousUmask = process.umask(0o077);
		try {
			const lock = claimCompanyRuntimeLock(root);
			expect(statSync(dirname(lock.path)).mode & 0o777).toBe(0o777);
			expect(statSync(lock.path).mode & 0o777).toBe(0o666);
			expect(process.umask()).toBe(0o077);
			releaseCompanyRuntimeLock(lock);
		} finally {
			process.umask(previousUmask);
		}
	});
});
