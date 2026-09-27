import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lockedCompanyComputerControlChild } from "../src/cloud-company-computer-preparation-control-main.ts";

const mocks = vi.hoisted(() => ({ artifact: vi.fn(), lock: vi.fn(), close: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<object>()),
	spawn: mocks.spawn,
}));
vi.mock("../src/cloud-company-computer-linux-host.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	assertCompanyComputerImageArtifact: mocks.artifact,
}));
vi.mock("../src/cloud-company-computer-preparation-control.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	openCompanyComputerPreparationLock: mocks.lock,
}));

const command = {
	commandId: "11111111-1111-4111-8111-111111111111",
	requestSha256: "a".repeat(64),
	bootId: "22222222-2222-4222-8222-222222222222",
};
const inspectionId = "33333333-3333-4333-8333-333333333333";
const controls = [
	"preparation",
	"configuration",
	"boot-configuration",
	"boot-service-start",
	"boot-service-restart",
	"service-start",
	"service-stop",
	"service-restart",
	"reset-configuration",
	"reset-service-start",
	"reset-service-restart",
	"outage-termination",
	"outage-configuration",
	"outage-service-start",
] as const;
const inspections = [
	"service-start",
	"boot-service-start",
	"boot-service-restart",
	"service-stop",
	"service-restart",
	"reset-service-start",
	"reset-service-restart",
	"outage-service-start",
] as const;

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.lock.mockResolvedValue({ fd: 17, close: mocks.close });
	mocks.spawn.mockImplementation(() => {
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	});
});

describe("locked control child executables", () => {
	it.each([
		...controls.map((purpose) => ({ purpose, nonce: undefined })),
		...inspections.map((purpose) => ({ purpose, nonce: inspectionId })),
	])("launches only the locked $purpose child with nonce $nonce", async ({ purpose, nonce }) => {
		const executable = `/opt/qorpera-office/qorpera-company-computer-${purpose}-control.mjs`;
		await lockedCompanyComputerControlChild(command, new AbortController().signal, executable, nonce);
		expect(mocks.artifact.mock.calls).toEqual([[executable], ["/usr/bin/flock"], ["/usr/bin/node"]]);
		expect(mocks.lock).toHaveBeenCalledOnce();
		expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
			"/usr/bin/flock",
			[
				"--exclusive",
				"--nonblock",
				"--no-fork",
				"/proc/self/fd/3",
				"/usr/bin/node",
				executable,
				"--locked",
				command.commandId,
				command.requestSha256,
				command.bootId,
				...(nonce === undefined ? [] : [nonce]),
			],
			{ cwd: "/", env: {}, detached: true, stdio: ["ignore", "ignore", "ignore", 17] },
		);
		expect(mocks.close).toHaveBeenCalledOnce();
	});
	it("requires the measured artifact before opening the lock", async () => {
		const executable = "/opt/qorpera-office/qorpera-company-computer-outage-termination-control.mjs";
		mocks.artifact.mockRejectedValueOnce(new Error("artifact probe reached"));
		await expect(lockedCompanyComputerControlChild(command, AbortSignal.timeout(5000), executable)).rejects.toThrow(
			"artifact probe reached",
		);
		expect(mocks.artifact).toHaveBeenCalledWith(executable);
		expect(mocks.lock).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it.each([
		"/opt/qorpera-office/other.mjs",
		"/tmp/qorpera-company-computer-outage-termination-control.mjs",
		"/opt/qorpera-office/../qorpera-office/qorpera-company-computer-outage-configuration-control.mjs",
		"/opt/qorpera-office/qorpera-company-computer-outage-service-start-control.mjs --locked",
	])("refuses foreign or extended executable %s before opening the lock", async (executable) => {
		await expect(
			lockedCompanyComputerControlChild(command, new AbortController().signal, executable),
		).rejects.toThrow("OFFICE_CONTROL_EXECUTABLE_UNCONFIRMED");
		expect(mocks.artifact).not.toHaveBeenCalled();
		expect(mocks.lock).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it.each([
		"preparation",
		"configuration",
		"boot-configuration",
		"reset-configuration",
		"outage-configuration",
		"outage-termination",
	])("refuses an inspection nonce for %s before opening the lock", async (purpose) => {
		await expect(
			lockedCompanyComputerControlChild(
				command,
				new AbortController().signal,
				`/opt/qorpera-office/qorpera-company-computer-${purpose}-control.mjs`,
				inspectionId,
			),
		).rejects.toThrow("OFFICE_CONTROL_EXECUTABLE_UNCONFIRMED");
		expect(mocks.artifact).not.toHaveBeenCalled();
		expect(mocks.lock).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	for (const purpose of inspections)
		it.each([null, "", command.commandId, "../escape", "--locked", `${inspectionId}x`])(
			`refuses invalid ${purpose} inspection nonce %s before opening the lock`,
			async (nonce) => {
				await expect(
					lockedCompanyComputerControlChild(
						command,
						new AbortController().signal,
						`/opt/qorpera-office/qorpera-company-computer-${purpose}-control.mjs`,
						nonce as string,
					),
				).rejects.toThrow();
				expect(mocks.artifact).not.toHaveBeenCalled();
				expect(mocks.lock).not.toHaveBeenCalled();
				expect(mocks.spawn).not.toHaveBeenCalled();
			},
		);
	it("closes the inherited lock without spawning when already cancelled", async () => {
		await expect(
			lockedCompanyComputerControlChild(
				command,
				AbortSignal.abort(),
				"/opt/qorpera-office/qorpera-company-computer-outage-service-start-control.mjs",
				inspectionId,
			),
		).rejects.toThrow();
		expect(mocks.lock).toHaveBeenCalledOnce();
		expect(mocks.close).toHaveBeenCalledOnce();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
