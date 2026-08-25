import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The kernel's Windows sandbox pre-writes agent/trust.json and auth.json and
// grants the agent READ-ONLY access: proper-lockfile's `mkdir <file>.lock`
// fails with EPERM, which used to crash every sandboxed agent at boot
// (rpc "agent exited (1)") and silently blank auth reloads. When locking is
// forbidden — as opposed to contended — the stores must read lock-free.
const lockSync = vi.hoisted(() => vi.fn());
const lockAsync = vi.hoisted(() => vi.fn());
vi.mock("proper-lockfile", () => ({ default: { lockSync, lock: lockAsync } }));

const { ProjectTrustStore } = await import("../src/core/trust-manager.ts");
const { FileAuthStorageBackend } = await import("../src/core/auth-storage.ts");
const { FileSettingsStorage } = await import("../src/core/settings-manager.ts");

function denied(code: string): Error {
	const error = new Error(`${code}: operation not permitted, mkdir`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

let tempDir: string;

beforeEach(() => {
	lockSync.mockReset();
	lockAsync.mockReset();
	tempDir = join(realpathSync(tmpdir()), `readonly-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("ProjectTrustStore on a read-only (kernel-managed) store", () => {
	let agentDir: string;
	let companyRoot: string;

	beforeEach(() => {
		agentDir = join(tempDir, "agent");
		companyRoot = join(tempDir, "company");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(companyRoot, { recursive: true });
		writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [resolve(companyRoot)]: true })}\n`, "utf-8");
	});

	for (const code of ["EPERM", "EACCES", "EROFS"]) {
		it(`reads trust lock-free when lock creation is denied with ${code}`, () => {
			lockSync.mockImplementation(() => {
				throw denied(code);
			});
			const store = new ProjectTrustStore(agentDir);
			expect(store.get(companyRoot)).toBe(true);
			expect(store.get(join(companyRoot, "nested"))).toBe(true);
		});
	}

	it("still surfaces contention (ELOCKED) after retries instead of going lock-free", () => {
		lockSync.mockImplementation(() => {
			throw denied("ELOCKED");
		});
		const store = new ProjectTrustStore(agentDir);
		expect(() => store.get(companyRoot)).toThrow();
		expect(lockSync.mock.calls.length).toBeGreaterThan(1);
	});

	it("uses the lock normally when locking is available", () => {
		const release = vi.fn();
		lockSync.mockReturnValue(release);
		const store = new ProjectTrustStore(agentDir);
		expect(store.get(companyRoot)).toBe(true);
		expect(lockSync).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});
});

describe("FileAuthStorageBackend on a read-only store", () => {
	it("reads lock-free when lock creation is denied", () => {
		const authPath = join(tempDir, "auth.json");
		writeFileSync(authPath, '{"anthropic":{"type":"api_key","key":"k"}}', "utf-8");
		lockSync.mockImplementation(() => {
			throw denied("EPERM");
		});
		const backend = new FileAuthStorageBackend(authPath);
		const content = backend.withLock((current) => ({ result: current }));
		expect(content).toContain("anthropic");
	});
});

describe("FileSettingsStorage on a read-only store", () => {
	it("reads lock-free when lock creation is denied", () => {
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), '{"theme":"dark"}', "utf-8");
		lockSync.mockImplementation(() => {
			throw denied("EACCES");
		});
		const storage = new FileSettingsStorage(tempDir, agentDir);
		let read: string | undefined;
		storage.withLock("global", (current) => {
			read = current;
			return undefined;
		});
		expect(read).toContain("dark");
	});
});
