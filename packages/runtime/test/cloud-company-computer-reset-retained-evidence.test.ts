import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	readCompanyComputerResetRetainedEvidence,
	readCompanyComputerResetServiceStartEvidence,
} from "../src/cloud-company-computer-reset-successor-evidence.ts";
import { resetInvocationFixture } from "./fixtures/company-computer-reset-invocation.ts";

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), readdir: vi.fn(), read: vi.fn(), lock: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, readdir: mocks.readdir }));
vi.mock("../src/cloud-company-computer-preparation-control.ts", () => ({
	assertCompanyComputerPreparationLockAndBoot: mocks.lock,
	readCompanyComputerPreparationProtected: mocks.read,
	OFFICE_PREPARATION_CONTROL_ROOT: "/run/qorpera-office-preparation",
}));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.lock.mockResolvedValue(undefined);
	mocks.read.mockRejectedValue(new Error("configuration evidence unavailable"));
});
const root = "/run/qorpera-office-preparation";
function exists(only: string) {
	mocks.lstat.mockImplementation(async (path: string) => {
		if (path === only)
			return { isDirectory: () => false, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o100400 };
		throw Object.assign(new Error("absent"), { code: "ENOENT" });
	});
}
describe("reset material lifecycle separation", () => {
	it("initial start refuses a stopped origin while retained verification continues to require configuration evidence", async () => {
		const f = resetInvocationFixture();
		exists(`${root}/service-stop-claim-${f.activationId}.json`);
		await expect(
			readCompanyComputerResetServiceStartEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("stale root authority present");
		expect(mocks.read).not.toHaveBeenCalled();
		await expect(
			readCompanyComputerResetRetainedEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("configuration evidence unavailable");
		expect(mocks.read).toHaveBeenCalledWith(f.paths.configuration, 16384, 0o600);
	});
	it.each([
		"/etc/qorpera-office/credentials",
		`${root}/claim.json`,
		`${root}/service-start-claim.json`,
		`${root}/boot-service-start-completion.json`,
	])("retained verification still rejects foreign root authority at %s", async (path) => {
		const f = resetInvocationFixture();
		exists(path);
		await expect(
			readCompanyComputerResetRetainedEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("stale root authority present");
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("accepts the image's empty root-only credential directory and still requires configuration evidence", async () => {
		const f = resetInvocationFixture();
		mocks.lstat.mockImplementation(async (path: string) => {
			if (path === "/etc/qorpera-office/credentials")
				return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o40700 };
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		});
		mocks.readdir.mockResolvedValue([]);
		await expect(
			readCompanyComputerResetRetainedEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("configuration evidence unavailable");
		expect(mocks.readdir).toHaveBeenCalledWith("/etc/qorpera-office/credentials");
		expect(mocks.read).toHaveBeenCalledWith(f.paths.configuration, 16384, 0o600);
	});
	it.each([
		[
			"a credential file",
			{ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o40700 },
			["config.json"],
		],
		[
			"a group-readable directory",
			{ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o40750 },
			[],
		],
		[
			"a foreign owner",
			{ isDirectory: () => true, isSymbolicLink: () => false, uid: 20044, gid: 20044, mode: 0o40700 },
			[],
		],
	])("rejects a credential directory holding %s", async (_label, stat, entries) => {
		const f = resetInvocationFixture();
		mocks.lstat.mockImplementation(async (path: string) => {
			if (path === "/etc/qorpera-office/credentials") return stat;
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		});
		mocks.readdir.mockResolvedValue(entries);
		await expect(
			readCompanyComputerResetRetainedEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("stale root authority present");
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
