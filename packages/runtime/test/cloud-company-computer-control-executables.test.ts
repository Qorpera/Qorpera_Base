import { describe, expect, it, vi } from "vitest";
import { lockedCompanyComputerControlChild } from "../src/cloud-company-computer-preparation-control-main.ts";

const mocks = vi.hoisted(() => ({ artifact: vi.fn() }));
vi.mock("../src/cloud-company-computer-linux-host.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	assertCompanyComputerImageArtifact: mocks.artifact,
}));

const command = {
	commandId: "11111111-1111-4111-8111-111111111111",
	requestSha256: "a".repeat(64),
	bootId: "22222222-2222-4222-8222-222222222222",
};

describe("locked control child executables", () => {
	it.each([
		"/opt/qorpera-office/qorpera-company-computer-reset-configuration-control.mjs",
		"/opt/qorpera-office/qorpera-company-computer-reset-service-start-control.mjs",
		"/opt/qorpera-office/qorpera-company-computer-reset-service-restart-control.mjs",
	])("accepts the reset control %s before opening the lock", async (executable) => {
		mocks.artifact.mockRejectedValueOnce(new Error("artifact probe reached"));
		await expect(lockedCompanyComputerControlChild(command, AbortSignal.timeout(5000), executable)).rejects.toThrow(
			"artifact probe reached",
		);
		expect(mocks.artifact).toHaveBeenCalledWith(executable);
	});
	it("still refuses a foreign executable", async () => {
		await expect(
			lockedCompanyComputerControlChild(command, AbortSignal.timeout(5000), "/opt/qorpera-office/other.mjs"),
		).rejects.toThrow("OFFICE_CONTROL_EXECUTABLE_UNCONFIRMED");
	});
});
