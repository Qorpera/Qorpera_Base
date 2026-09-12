import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
} from "@qorpera/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measureCompanyComputerServiceSoftware } from "../src/cloud-company-computer-service-software-measurement.ts";
import { computerId as id } from "./fixtures/company-computer.ts";
import { screenStartup } from "./fixtures/screen-lifecycle.ts";

const mocks = vi.hoisted(() => ({
	lock: vi.fn(),
	read: vi.fn(),
	file: vi.fn(),
	verifyFile: vi.fn(),
	closeFile: vi.fn(),
	invocation: vi.fn(),
	material: vi.fn(),
	verifyMaterial: vi.fn(),
	bootMaterial: vi.fn(),
	resetMaterial: vi.fn(),
	closeBoot: vi.fn(),
	startInspect: vi.fn(),
	inspect: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	metadata: vi.fn(),
	lstat: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
vi.mock("../src/cloud-company-computer-service-software-file.ts", () => ({
	openCompanyComputerInstalledServiceSoftware: mocks.file,
}));
vi.mock("../src/cloud-company-computer-preparation-control.ts", () => ({
	assertCompanyComputerPreparationLockAndBoot: mocks.lock,
	readCompanyComputerPreparationProtected: mocks.read,
	OFFICE_PREPARATION_CONTROL_ROOT: "/run/qorpera-office-preparation",
}));
vi.mock("../src/cloud-company-computer-stop-invocation.ts", () => ({
	readCompanyComputerStopInvocation: mocks.invocation,
}));
vi.mock("../src/cloud-company-computer-service-start-evidence.ts", () => ({
	readCompanyComputerServiceStartEvidence: mocks.material,
}));
vi.mock("../src/cloud-company-computer-boot-service-start-evidence.ts", () => ({
	readCompanyComputerBootServiceStartEvidence: mocks.bootMaterial,
}));
vi.mock("../src/cloud-company-computer-reset-successor-evidence.ts", () => ({
	readCompanyComputerResetServiceStartEvidence: mocks.resetMaterial,
}));
vi.mock("../src/cloud-company-computer-service-start-systemd.ts", () => ({
	createCompanyComputerServiceStartSystemdManager: () => ({ inspect: mocks.startInspect, start: mocks.start }),
}));
vi.mock("../src/cloud-company-computer-service-stop-systemd.ts", () => ({
	createCompanyComputerServiceStopSystemdManager: () => ({ inspect: mocks.inspect, stop: mocks.stop }),
}));
vi.mock("../src/cloud-company-computer-linux-host.ts", () => ({ readCompanyComputerLinuxMetadata: mocks.metadata }));
// Synthetic parsed configuration isolates composition from the independently
// tested closed configuration parser. No credential or live endpoint is used.
vi.mock("../src/cloud-company-computer-service-config.ts", () => ({
	parseCompanyComputerServiceConfig: (text: string) => JSON.parse(text),
}));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
	const startup = { ...screenStartup() },
		{ scope, computerGeneration, configurationSha256: _config, serviceInvocationId: _inv, ...attestation } = startup;
	const config = Buffer.from(JSON.stringify({ scope, computerGeneration, linux: { attestation } }));
	startup.configurationSha256 = hash(config);
	const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge({
		schema: "qorpera.office-software-invocation-challenge/v1",
		challengeId: id(80),
		activationId: id(81),
		startup,
		revision: 1,
		capabilityRevision: 2,
		service: { path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: 20, sha256: "9".repeat(64) },
		validForMs: 4000,
	});
	const command = {
		commandId: id(82),
		bootId: startup.bootId,
		requestSha256: hash(companyComputerServiceSoftwareMeasurementText(challenge)),
	};
	const state = {
		invocationId: startup.serviceInvocationId,
		activeState: "active",
		subState: "running",
		result: "success",
		mainPid: 42,
		controlPid: 0,
		jobId: 0,
		execMainCode: 0,
		execMainStatus: 0,
		controlGroup: "/system.slice/qorpera-company-computer.service",
		restarts: 0,
	};
	const preparation = { invocationId: "b".repeat(32) },
		configCopies: Buffer[] = [];
	const invocation = {
		kind: "original",
		start: {
			command: { ...command, commandId: id(83) },
			serviceInvocationId: startup.serviceInvocationId,
			configurationSha256: startup.configurationSha256,
			configurationCompletionSha256: "1".repeat(64),
			mainPid: state.mainPid,
			controlGroup: state.controlGroup,
		},
		bytes: Buffer.from("public historical completion"),
		request: { attestation: {} },
		configurationPath: "/etc/qorpera-office/credentials/config.json",
		stopPaths: {
			claim: "/run/qorpera-office-preparation/claim-test",
			completion: "/run/qorpera-office-preparation/completion-test",
		},
	};
	mocks.lstat.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
	mocks.lock.mockResolvedValue(undefined);
	mocks.verifyFile.mockResolvedValue(undefined);
	mocks.verifyMaterial.mockResolvedValue(undefined);
	mocks.closeFile.mockResolvedValue(undefined);
	mocks.closeBoot.mockResolvedValue(undefined);
	mocks.file.mockResolvedValue({ service: challenge.service, verify: mocks.verifyFile, close: mocks.closeFile });
	mocks.invocation.mockImplementation(async (_activation, _boot, read) => {
		await read("/run/qorpera-office-preparation/public-history.json", 4096, 0o600);
		return invocation;
	});
	mocks.material.mockResolvedValue({ preparation, verify: mocks.verifyMaterial });
	mocks.bootMaterial.mockResolvedValue({ verify: mocks.verifyMaterial, close: mocks.closeBoot });
	mocks.resetMaterial.mockResolvedValue({ verify: mocks.verifyMaterial, close: mocks.closeBoot });
	mocks.startInspect.mockImplementation(async () => ({ preparation, service: { ...state } }));
	mocks.inspect.mockImplementation(async () => ({ service: { ...state }, cgroupState: "populated" }));
	mocks.read.mockImplementation(async (path: string) => {
		if (path === invocation.configurationPath) {
			const copy = Buffer.from(config);
			configCopies.push(copy);
			return copy;
		}
		return Buffer.from("public history");
	});
	mocks.metadata.mockImplementation(async (path: string) =>
		path.endsWith("/cgroup")
			? `0::${state.controlGroup}\n`
			: path.endsWith("/cmdline")
				? `/usr/bin/node\0${COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH}\0`
				: `42 (node) S ${Array(18).fill("0").join(" ")} 100\n`,
	);
	return {
		startup,
		challenge,
		command,
		state,
		invocation,
		configCopies,
		run: (signal = new AbortController().signal) => measureCompanyComputerServiceSoftware(command, challenge, signal),
	};
}
beforeEach(() => vi.resetAllMocks());
describe("independent installed software invocation measurement", () => {
	it("measures a recreated root using its reset evidence without requesting a nonexistent retained-boot origin", async () => {
		const f = fixture();
		mocks.invocation.mockResolvedValue({ ...f.invocation, kind: "reset" });
		mocks.startInspect.mockResolvedValue({
			preparation: {
				invocationId: "",
				activeState: "inactive",
				subState: "dead",
				result: "success",
				mainPid: 0,
				controlPid: 0,
				jobId: 0,
				execMainCode: 0,
				execMainStatus: 0,
			},
			service: f.state,
		});
		const result = await f.run();
		expect(result.evidence.startup).toEqual(f.startup);
		expect(mocks.resetMaterial).toHaveBeenCalledWith(f.command, f.invocation.request, expect.any(AbortSignal));
		expect(mocks.material).not.toHaveBeenCalled();
		expect(mocks.bootMaterial).not.toHaveBeenCalled();
		expect(mocks.closeBoot).toHaveBeenCalledOnce();
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("binds current target bytes to two fresh stable inspections and wipes configuration buffers", async () => {
		const f = fixture(),
			result = await f.run();
		expect(result.evidence).toMatchObject({
			challengeId: f.challenge.challengeId,
			capabilityRevision: 2,
			revision: 1,
			startup: f.startup,
			mainPid: 42,
		});
		expect(result.evidenceSha256).toBe(hash(companyComputerServiceSoftwareMeasurementText(result.evidence)));
		expect(mocks.inspect).toHaveBeenCalledTimes(4);
		expect(mocks.lock).toHaveBeenCalledTimes(5);
		expect(mocks.closeFile).toHaveBeenCalledOnce();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.stop).not.toHaveBeenCalled();
		expect(f.configCopies.length).toBe(2);
		expect(f.configCopies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});
	it.each([
		"no-lock",
		"target",
		"stale-invocation",
		"pid",
		"cgroup",
		"restart",
		"queued",
		"preparation",
		"credentials",
		"history",
		"file-changed",
		"stopping",
		"process-command",
		"process-reused",
		"inspection-changed",
		"cancelled",
		"challenge-hash",
	])("refuses %s without authority or secret output", async (fault) => {
		const f = fixture();
		if (fault === "no-lock") mocks.lock.mockRejectedValue(new Error("PRIVATE_CANARY"));
		if (fault === "target")
			mocks.file.mockResolvedValue({
				service: { ...f.challenge.service, sha256: "0".repeat(64) },
				verify: mocks.verifyFile,
				close: mocks.closeFile,
			});
		if (fault === "stale-invocation") f.state.invocationId = "a".repeat(32);
		if (fault === "pid") f.state.mainPid++;
		if (fault === "cgroup") mocks.inspect.mockResolvedValue({ service: f.state, cgroupState: "empty" });
		if (fault === "restart") f.state.restarts = 1;
		if (fault === "queued") f.state.jobId = 1;
		if (fault === "preparation") mocks.startInspect.mockResolvedValue({ preparation: {}, service: f.state });
		if (fault === "credentials") mocks.verifyMaterial.mockRejectedValue(new Error("PRIVATE_CANARY"));
		if (fault === "history") mocks.read.mockImplementationOnce(async () => Buffer.from("before"));
		if (fault === "file-changed") mocks.verifyFile.mockRejectedValue(new Error("PRIVATE_CANARY"));
		if (fault === "stopping") mocks.lstat.mockResolvedValue({});
		if (fault === "process-command") mocks.metadata.mockResolvedValue("wrong");
		if (fault === "process-reused") {
			let n = 0;
			mocks.metadata.mockImplementation(async (path: string) =>
				path.endsWith("/cgroup")
					? `0::${f.state.controlGroup}\n`
					: path.endsWith("/cmdline")
						? `/usr/bin/node\0${COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH}\0`
						: `42 (node) S ${Array(18).fill("0").join(" ")} ${100 + n++}\n`,
			);
		}
		if (fault === "inspection-changed")
			mocks.inspect
				.mockResolvedValueOnce({ service: { ...f.state }, cgroupState: "populated" })
				.mockResolvedValue({ service: { ...f.state, mainPid: 43 }, cgroupState: "populated" });
		if (fault === "challenge-hash") f.command.requestSha256 = "0".repeat(64);
		await expect(f.run(fault === "cancelled" ? AbortSignal.abort() : undefined)).rejects.toThrow(
			/^OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED$/,
		);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.stop).not.toHaveBeenCalled();
	});
	it("reuses the retained boot evidence helper and closes its held descriptors", async () => {
		const f = fixture();
		mocks.startInspect.mockResolvedValue({
			preparation: {
				invocationId: "",
				activeState: "inactive",
				subState: "dead",
				result: "success",
				mainPid: 0,
				controlPid: 0,
				jobId: 0,
				execMainCode: 0,
				execMainStatus: 0,
			},
			service: f.state,
		});
		mocks.invocation.mockResolvedValue({
			...f.invocation,
			kind: "boot_restart",
			origin: { request: { retained: true } },
		});
		await f.run();
		expect(mocks.bootMaterial).toHaveBeenCalledWith(f.command, { retained: true }, expect.any(AbortSignal));
		expect(mocks.material).not.toHaveBeenCalled();
		expect(mocks.closeBoot).toHaveBeenCalledOnce();
	});
	it("honors cancellation during inspection and releases measurement state for a fresh call", async () => {
		const f = fixture(),
			controller = new AbortController();
		mocks.verifyFile.mockImplementationOnce(async () => controller.abort());
		await expect(f.run(controller.signal)).rejects.toThrow(/^OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED$/);
		expect(mocks.closeFile).toHaveBeenCalledOnce();
		await f.run();
		expect(mocks.closeFile).toHaveBeenCalledTimes(2);
	});
});
