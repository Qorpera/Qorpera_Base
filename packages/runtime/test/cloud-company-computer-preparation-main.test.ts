import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompanyComputerPreparationMain } from "../src/cloud-company-computer-preparation-main.ts";

const mocked = vi.hoisted(() => ({ imageCheck: vi.fn(), artifact: vi.fn(), prepare: vi.fn() }));
vi.mock("../src/lxd-guest-image-updates.ts", async (original) => ({
	...(await original<typeof import("../src/lxd-guest-image-updates.ts")>()),
	assertGuestImageSelfUpdateMasked: mocked.imageCheck,
}));
vi.mock("../src/cloud-company-computer-linux-host.ts", async (original) => ({
	...(await original<typeof import("../src/cloud-company-computer-linux-host.ts")>()),
	assertCompanyComputerImageArtifact: mocked.artifact,
}));
vi.mock("../src/cloud-company-computer-preparation.ts", () => ({ prepareCompanyComputerGuest: mocked.prepare }));

const platform = process.platform;
const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "linux" });
	vi.spyOn(process, "getuid").mockReturnValue(1000);
	vi.spyOn(process, "geteuid").mockReturnValue(1000);
	vi.stubEnv("INVOCATION_ID", "b".repeat(32));
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const mock of Object.values(mocked)) mock.mockReset();
	for (const signal of ["SIGINT", "SIGTERM"] as const) expect(process.listenerCount(signal)).toBe(listeners[signal]);
});

describe("office preparation on an image that can update itself", () => {
	it("refuses before reading the provider's request or copying any company state", async () => {
		mocked.imageCheck.mockRejectedValue(new Error("RUNNER_IMAGE_SELF_UPDATE_ENABLED:UNATTENDED_UPGRADES_SERVICE"));
		await expect(runCompanyComputerPreparationMain()).rejects.toThrow(
			/^RUNNER_IMAGE_SELF_UPDATE_ENABLED:UNATTENDED_UPGRADES_SERVICE$/,
		);
		expect(mocked.imageCheck).toHaveBeenCalledWith();
		expect(mocked.artifact).not.toHaveBeenCalled();
		expect(mocked.prepare).not.toHaveBeenCalled();
	});

	it("checks the image first, then reads the request, on a masked image", async () => {
		mocked.imageCheck.mockResolvedValue(undefined);
		mocked.artifact.mockRejectedValue(new Error("OFFICE_PREPARATION_REQUEST_UNPROTECTED"));
		await expect(runCompanyComputerPreparationMain()).rejects.toThrow("OFFICE_PREPARATION_REQUEST_UNPROTECTED");
		expect(mocked.imageCheck.mock.invocationCallOrder[0]).toBeLessThan(mocked.artifact.mock.invocationCallOrder[0]!);
		expect(mocked.prepare).not.toHaveBeenCalled();
	});
});
