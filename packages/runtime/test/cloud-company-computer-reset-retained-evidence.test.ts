import { basename } from "node:path";
import { COMPANY_COMPUTER_BOOTS_ROOT, companyComputerBootDirectory } from "@qorpera/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertCompanyComputerResetRootClean,
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
	// The image's tmpfiles fragment creates the boots root empty.
	mocks.readdir.mockResolvedValue([]);
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
describe("per-boot credential directories on a recreated root", () => {
	const privateDirectory = { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o40700 };
	const credentialFile = { isDirectory: () => false, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o100400 };
	/** The boots root lists `boots`; only `present` has a credentials entry. */
	function bootsRoot(boots: readonly string[], present: Record<string, object>) {
		mocks.readdir.mockImplementation(async (path: string) => {
			if (path === COMPANY_COMPUTER_BOOTS_ROOT) return boots.map((directory) => basename(directory));
			return [];
		});
		mocks.lstat.mockImplementation(async (path: string) => {
			if (path in present) return present[path];
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		});
	}
	it.each([
		["an empty private directory", privateDirectory],
		["a credential file", credentialFile],
	])("rejects another boot's credential entry holding %s", async (_label, stat) => {
		const f = resetInvocationFixture(),
			current = companyComputerBootDirectory(f.command.bootId),
			predecessor = companyComputerBootDirectory(f.request.request.predecessor.startup.bootId);
		bootsRoot([predecessor, current], { [`${predecessor}/credentials`]: stat });
		for (const reader of [readCompanyComputerResetServiceStartEvidence, readCompanyComputerResetRetainedEvidence])
			await expect(reader(f.command, f.request, AbortSignal.timeout(5000))).rejects.toThrow(
				"stale root authority present",
			);
		await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).rejects.toThrow(
			"stale root authority present",
		);
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("accepts the current boot's credential directory and still requires configuration evidence", async () => {
		const f = resetInvocationFixture(),
			current = companyComputerBootDirectory(f.command.bootId);
		bootsRoot([current], { [current]: privateDirectory, [`${current}/credentials`]: privateDirectory });
		await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).resolves.toBeUndefined();
		await expect(
			readCompanyComputerResetRetainedEvidence(f.command, f.request, AbortSignal.timeout(5000)),
		).rejects.toThrow("configuration evidence unavailable");
		expect(mocks.readdir).toHaveBeenCalledWith(COMPANY_COMPUTER_BOOTS_ROOT);
		expect(mocks.lstat).not.toHaveBeenCalledWith(`${current}/credentials`);
		expect(mocks.read).toHaveBeenCalledWith(f.paths.configuration, 16384, 0o600);
	});
	it("the same credential directory is refused once the caller names a different boot", async () => {
		const f = resetInvocationFixture(),
			current = companyComputerBootDirectory(f.command.bootId);
		bootsRoot([current], { [`${current}/credentials`]: privateDirectory });
		await expect(
			assertCompanyComputerResetRootClean(f.activationId, f.request.request.predecessor.startup.bootId),
		).rejects.toThrow("stale root authority present");
	});
	it("another boot's directory without credentials is not authority", async () => {
		const f = resetInvocationFixture(),
			predecessor = companyComputerBootDirectory(f.request.request.predecessor.startup.bootId);
		bootsRoot([predecessor], {});
		await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).resolves.toBeUndefined();
		expect(mocks.lstat).toHaveBeenCalledWith(`${predecessor}/credentials`);
	});
	it("passes without a boots root", async () => {
		const f = resetInvocationFixture();
		mocks.lstat.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
		mocks.readdir.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
		await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).resolves.toBeUndefined();
		expect(mocks.readdir).toHaveBeenCalledWith(COMPANY_COMPUTER_BOOTS_ROOT);
	});
	it("refuses a non-directory boot entry as stale authority and surfaces other lstat errors", async () => {
		const f = resetInvocationFixture(),
			predecessor = companyComputerBootDirectory(f.request.request.predecessor.startup.bootId);
		for (const [code, message] of [
			["ENOTDIR", "stale root authority present"],
			["EIO", "unreadable"],
		] as const) {
			mocks.readdir.mockImplementation(async (path: string) =>
				path === COMPANY_COMPUTER_BOOTS_ROOT ? [basename(predecessor)] : [],
			);
			mocks.lstat.mockImplementation(async (path: string) => {
				if (path === `${predecessor}/credentials`) throw Object.assign(new Error("unreadable"), { code });
				throw Object.assign(new Error("absent"), { code: "ENOENT" });
			});
			await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).rejects.toThrow(message);
		}
	});
	it("refuses when the boots root cannot be listed", async () => {
		const f = resetInvocationFixture();
		mocks.lstat.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
		mocks.readdir.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
		await expect(assertCompanyComputerResetRootClean(f.activationId, f.command.bootId)).rejects.toThrow("denied");
	});
});
