import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyComputerBootServiceStartManager } from "../src/cloud-company-computer-boot-service-start-control.ts";
import { controlCompanyComputerResetServiceRestart } from "../src/cloud-company-computer-reset-service-restart-control.ts";
import {
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./fixtures/company-computer-boot-configuration.ts";
import { resetServiceRestartFixture } from "./fixtures/company-computer-reset-service-restart.ts";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	publish: vi.fn(),
	lock: vi.fn(),
	lstat: vi.fn(),
	material: vi.fn(),
	history: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
vi.mock("../src/cloud-company-computer-preparation-control.ts", () => ({
	readCompanyComputerPreparationProtected: mocks.read,
	publishCompanyComputerPreparationProtected: mocks.publish,
	assertCompanyComputerPreparationLockAndBoot: mocks.lock,
	OFFICE_PREPARATION_CONTROL_ROOT: "/run/qorpera-office-preparation",
}));
vi.mock("../src/cloud-company-computer-reset-successor-evidence.ts", () => ({
	readCompanyComputerResetRetainedEvidence: mocks.material,
}));
vi.mock("../src/cloud-company-computer-stop-history.ts", () => ({ readCompanyComputerStopHistory: mocks.history }));
const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
const inactive = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
function fixture() {
	const f = resetServiceRestartFixture(),
		r = f.restart;
	f.files.delete(r.claimPath);
	f.files.delete(r.completionPath);
	const verify = vi.fn(async () => {}),
		close = vi.fn(async () => {});
	let observed: Awaited<ReturnType<CompanyComputerBootServiceStartManager["inspect"]>> = {
		preparation: inactive,
		service: { ...inactive, invocationId: f.startCompletion.serviceInvocationId, controlGroup: "", restarts: 0 },
		cgroupState: "absent",
	};
	mocks.lock.mockResolvedValue(undefined);
	mocks.read.mockImplementation(async (path: string, limit: number, mode: number) => {
		const file = f.files.get(path);
		if (!file) throw missing();
		if (file.mode !== mode || file.bytes.length > limit) throw new Error("custody");
		return Buffer.from(file.bytes);
	});
	mocks.publish.mockImplementation(async (path: string, bytes: Buffer, mode: number) => {
		const prior = f.files.get(path);
		if (prior && !prior.bytes.equals(bytes)) throw new Error("exclusive");
		f.files.set(path, { bytes: Buffer.from(bytes), mode });
	});
	mocks.lstat.mockImplementation(async (path: string) => {
		if (f.files.has(path)) return {};
		throw missing();
	});
	mocks.material.mockResolvedValue({ verify, close });
	mocks.history.mockResolvedValue({
		manifest: { command: r.stopCommand, completionPath: r.stopCompletionPath },
		manifestSha256: "8".repeat(64),
		files: new Map([[r.stopCompletionPath, encode(r.stopped)]]),
	});
	const running = () => {
		observed = {
			preparation: inactive,
			service: {
				...inactive,
				invocationId: r.completion.serviceInvocationId,
				mainPid: r.completion.mainPid,
				activeState: "active",
				subState: "running",
				controlGroup: r.completion.controlGroup,
				restarts: 0,
			},
			cgroupState: "populated",
		};
	};
	const manager = {
		inspect: vi.fn(async () => structuredClone(observed)),
		start: vi.fn(async () => {
			running();
		}),
	};
	return {
		...f,
		manager,
		verify,
		close,
		running,
		execute: (nonce?: string, signal = AbortSignal.timeout(10000)) =>
			controlCompanyComputerResetServiceRestart(r.command, manager, signal, nonce),
	};
}
beforeEach(() => vi.resetAllMocks());
describe("reset-born root restart dispatch", () => {
	it("claims once before starting, preserves reset origin, and observes exact completion without re-execution", async () => {
		const f = fixture(),
			before = encode(f.request);
		f.manager.start.mockImplementationOnce(async () => {
			expect(f.files.has(f.restart.claimPath)).toBe(true);
			expect(f.files.has(f.restart.completionPath)).toBe(false);
			f.running();
		});
		expect(await f.execute()).toEqual(f.restart.completion);
		expect(await f.execute()).toEqual(f.restart.completion);
		const result = await f.execute(id(980));
		expect(result).toMatchObject({ inspectionId: id(980), start: f.restart.completion });
		expect(f.manager.start).toHaveBeenCalledOnce();
		expect(encode(f.request)).toEqual(before);
		expect(f.close).toHaveBeenCalledTimes(3);
		expect(mocks.material).toHaveBeenCalledWith(f.restart.command, f.request, expect.any(AbortSignal));
	});
	it("does not replay an uncertain dispatch that never reached a running invocation", async () => {
		const f = fixture();
		f.manager.start.mockRejectedValueOnce(new Error("private detail"));
		await expect(f.execute()).rejects.toThrow("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
		await expect(f.execute()).rejects.toThrow("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
		expect(f.manager.start).toHaveBeenCalledOnce();
		expect(f.files.has(f.restart.claimPath)).toBe(true);
		expect(f.files.has(f.restart.completionPath)).toBe(false);
	});
	it("recovers a lost reply by observing the already running exact invocation", async () => {
		const f = fixture();
		f.manager.start.mockImplementationOnce(async () => {
			f.running();
			throw new Error("lost reply");
		});
		await expect(f.execute()).rejects.toThrow("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
		expect(await f.execute()).toEqual(f.restart.completion);
		expect(f.manager.start).toHaveBeenCalledOnce();
	});
	it.each([
		"other-child",
		"history",
		"configuration",
		"old-start",
		"material",
		"cancelled",
		"nonce-before-completion",
		"stage-custody",
	])("rejects %s before starting", async (fault) => {
		const f = fixture();
		if (fault === "other-child") f.files.set(f.restart.claimPath, { bytes: encode({ other: true }), mode: 0o600 });
		if (fault === "history") mocks.history.mockResolvedValue({ manifest: {}, files: new Map() });
		if (fault === "configuration") {
			const file = f.files.get(f.paths.configuration)!;
			file.bytes = encode({});
		}
		if (fault === "old-start")
			f.files.set("/run/qorpera-office-preparation/service-start-claim.json", { bytes: encode({}), mode: 0o600 });
		if (fault === "material") f.verify.mockRejectedValue(new Error("private material"));
		if (fault === "stage-custody") f.files.get(f.restart.stagePath)!.mode = 0o644;
		await expect(
			f.execute(
				fault === "nonce-before-completion" ? id(980) : undefined,
				fault === "cancelled" ? AbortSignal.abort() : AbortSignal.timeout(10000),
			),
		).rejects.toThrow("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
		expect(f.manager.start).not.toHaveBeenCalled();
	});
	it("refuses a configuration-completion substitution even with a self-consistent staged command", async () => {
		const f = fixture(),
			request = { ...f.restart.request, configurationCompletionSha256: "a".repeat(64) },
			bytes = encode(request),
			command = { ...f.restart.command, requestSha256: hash(bytes) };
		f.files.set(`/run/qorpera-office-preparation/reset-service-restart-incoming-${command.requestSha256}.json`, {
			bytes,
			mode: 0o400,
		});
		await expect(
			controlCompanyComputerResetServiceRestart(command, f.manager, AbortSignal.timeout(10000)),
		).rejects.toThrow("OFFICE_RESET_SERVICE_RESTART_UNCONFIRMED");
		expect(f.manager.start).not.toHaveBeenCalled();
	});
});
