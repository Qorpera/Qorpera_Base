import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	readCompanyComputerResetRetainedEvidence,
	readCompanyComputerResetServiceStartEvidence,
} from "../src/cloud-company-computer-reset-successor-evidence.ts";
import { resetInvocationFixture } from "./fixtures/company-computer-reset-invocation.ts";

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), read: vi.fn(), lock: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
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
		if (path === only) return {};
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
});
