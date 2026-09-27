import {
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerOutageAdoptionReceipt,
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageResumeObservationCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerOutageConfigurationRequest,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageTerminationRequest,
	parseCompanyComputerResetAdoptionReceipt,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officeCanonical } from "../../runner-orchestrator/src/lxd-office-image-provenance.ts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./fixtures/company-computer-boot-configuration.ts";
import { appendBootServiceRestartFixture } from "./fixtures/company-computer-boot-service-restart.ts";
import { laterBootConfigurationFixture } from "./fixtures/company-computer-later-boot-configuration.ts";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	publish: vi.fn(),
	lock: vi.fn(),
	mount: vi.fn(),
	verifyMount: vi.fn(),
	closeMount: vi.fn(),
	credentials: vi.fn(),
	lstat: vi.fn(),
	history: vi.fn(),
}));
vi.mock("../src/cloud-company-computer-stop-history.ts", () => ({ readCompanyComputerStopHistory: mocks.history }));
vi.mock("node:tls", () => ({ createSecureContext: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	lstat: mocks.lstat,
}));
vi.mock("../src/cloud-company-computer-boot-credentials.ts", () => ({
	assertCompanyComputerBootCredentials: mocks.credentials,
}));
vi.mock("../src/cloud-company-computer-preparation-control.ts", () => ({
	OFFICE_PREPARATION_CONTROL_ROOT: "/run/qorpera-office-preparation",
	assertCompanyComputerPreparationLockAndBoot: mocks.lock,
	readCompanyComputerPreparationProtected: mocks.read,
	publishCompanyComputerPreparationProtected: mocks.publish,
}));
vi.mock("../src/cloud-company-computer-retained-workbench.ts", () => ({
	openCompanyComputerRetainedWorkbench: mocks.mount,
}));

import { verifyCompanyComputerBootPredecessor } from "../src/cloud-company-computer-boot-predecessor.ts";
import { controlCompanyComputerOutageConfiguration } from "../src/cloud-company-computer-outage-configuration-control.ts";
import { readCompanyComputerOutagePredecessor } from "../src/cloud-company-computer-outage-predecessor.ts";
import { controlCompanyComputerOutageServiceStart } from "../src/cloud-company-computer-outage-service-start-control.ts";
import { controlCompanyComputerOutageTermination } from "../src/cloud-company-computer-outage-termination-control.ts";
import { readCompanyComputerStopInvocation } from "../src/cloud-company-computer-stop-invocation.ts";

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
function fixture(later = false) {
	const f = later ? laterBootConfigurationFixture({ restarts: 2 }) : bootConfigurationFixture(),
		{ activationId, providerId, providerPolicySha256, startup } = f.input.bootIntent.request.predecessor,
		base = {
			schema: "qorpera.office-outage-recovery-request/v1" as const,
			recoveryId: id(901),
			outageRequestId: id(902),
			activationId: id(903),
			startCommandId: id(904),
		},
		recovery = parseCompanyComputerOutageRecovery(
			{
				schema: "qorpera.office-outage-recovery/v1",
				request: base,
				predecessor: { activationId, providerId, providerPolicySha256, startup },
				state: "prepared",
				officeRevision: 3,
				privacyState: "private",
				privacyVersion: 2,
				privacyChallenge: { challengeId: id(905) },
				drains: [],
			},
			base,
		),
		observation = {
			schema: "qorpera.lxd-office-outage-resume-observation/v1" as const,
			intentId: id(12),
			allocationId: startup.allocationId,
			recoveryId: base.recoveryId,
			activationId: base.activationId,
			startCommandId: base.startCommandId,
			requestSha256: "a".repeat(64),
			hostBootId: id(906),
			bootId: id(907),
			instanceSha256: startup.instanceSha256,
			physicalInstanceId: id(908),
			operationId: id(909),
		},
		packet = parseCompanyComputerOutageTerminationRequest({
			schema: "qorpera.office-outage-termination-request/v1",
			originPreparationSha256: f.input.originPreparationSha256,
			challenge: {
				schema: "qorpera.office-outage-termination-challenge/v1",
				request: {
					recovery: base,
					inspectionId: id(910),
					observation,
					bootObservationSha256: hash(companyComputerOutageResumeObservationCanonical(observation, recovery)),
				},
				recovery,
				validForMs: 5000,
			},
		}),
		command = { commandId: id(911), requestSha256: hash(encode(packet)), bootId: observation.bootId },
		files = new Map(f.originFiles);
	files.set(`/run/qorpera-office-preparation/outage-termination-incoming-${command.requestSha256}.json`, {
		bytes: encode(packet),
		mode: 0o400,
	});
	const read = async (path: string, limit: number, mode: number) => {
		const file = files.get(path);
		if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		if (file.mode !== mode || file.bytes.length > limit) throw new Error("custody");
		return Buffer.from(file.bytes);
	};
	mocks.read.mockImplementation(read);
	mocks.lock.mockResolvedValue(undefined);
	mocks.publish.mockResolvedValue(undefined);
	mocks.credentials.mockResolvedValue(`${companyComputerBootDirectory(command.bootId)}/credentials`);
	mocks.lstat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
	mocks.mount.mockResolvedValue({ verify: mocks.verifyMount, close: mocks.closeMount });
	const inspect = vi.fn().mockResolvedValue({
			preparation: { ...inactive },
			service: { ...inactive, controlGroup: "", restarts: 0 },
			cgroupState: "empty",
		}),
		run = () => controlCompanyComputerOutageTermination(command, { inspect }, new AbortController().signal);
	return { f, files, read, packet, command, inspect, run };
}
afterEach(() => vi.resetAllMocks());
function resetPredecessorFixture() {
	const f = fixture(),
		old = f.packet.challenge.recovery.predecessor.startup,
		bootId = id(930),
		config = JSON.parse(f.files.get("/etc/qorpera-office/credentials/config.json")!.bytes.toString());
	config.linux.attestation.bootId = bootId;
	const configBytes = Buffer.from(JSON.stringify(config)),
		receipt = parseCompanyComputerResetAdoptionReceipt({
			schema: "qorpera.office-state-reset-retained/v1",
			state: "complete",
			scope: old.scope,
			computerGeneration: old.computerGeneration,
			allocationId: old.allocationId,
			instanceSha256: old.instanceSha256,
			imageSha256: old.imageSha256,
			bootstrapSha256: old.bootstrapSha256,
			bootId,
			layout: f.f.originReceipt.layout,
			workbenchMount: f.f.original.workbenchMount,
			origin: {
				bootId: f.f.original.bootId,
				preparationSha256: f.packet.originPreparationSha256,
				adoptionReceiptSha256: hash(encode(f.f.originReceipt)),
			},
			reset: {
				resetId: id(931),
				rootIncarnationId: id(932),
				activationId: id(933),
				predecessor: { transitionId: id(934), activationId: id(935), bootId: old.bootId },
			},
		});
	f.files.delete("/etc/qorpera-office/credentials/config.json");
	f.files.set(`${companyComputerBootDirectory(bootId)}/credentials/config.json`, { bytes: configBytes, mode: 0o400 });
	f.files.set(companyComputerResetAdoptionReceiptPath(bootId), { bytes: encode(receipt), mode: 0o444 });
	const packet = parseCompanyComputerOutageTerminationRequest({
			...f.packet,
			challenge: {
				...f.packet.challenge,
				recovery: {
					...f.packet.challenge.recovery,
					predecessor: {
						...f.packet.challenge.recovery.predecessor,
						startup: { ...old, bootId, configurationSha256: hash(configBytes) },
					},
				},
			},
		}),
		command = { ...f.command, requestSha256: hash(encode(packet)) };
	f.files.set(`/run/qorpera-office-preparation/outage-termination-incoming-${command.requestSha256}.json`, {
		bytes: encode(packet),
		mode: 0o400,
	});
	return {
		...f,
		packet,
		command,
		run: () => controlCompanyComputerOutageTermination(command, { inspect: f.inspect }, new AbortController().signal),
	};
}
describe("forced office shutdown fresh-boot termination", () => {
	it.each([false, true])(
		"verifies retained identity after later boot=%s without clean-stop or old /run evidence",
		async (later) => {
			const f = fixture(later),
				result = await f.run();
			expect(result.predecessorConfigurationSha256).toBe(
				f.packet.challenge.recovery.predecessor.startup.configurationSha256,
			);
			expect(result.bootId).toBe(f.command.bootId);
			expect(result.preparationState).toBe("unstarted");
			expect(
				mocks.read.mock.calls.every(
					([path]) => !String(path).includes("service-stop") && !String(path).includes("boot-service-start"),
				),
			).toBe(true);
			expect(mocks.publish).toHaveBeenCalledTimes(1);
			expect(mocks.closeMount).toHaveBeenCalledOnce();
			expect(mocks.publish.mock.calls[0][0]).toContain(`outage-termination-inspection-${id(910)}.json`);
		},
	);
	it.each([
		"active",
		"invocation",
		"pid",
		"restart",
		"populated",
		"preparation",
		"mount",
		"lock",
		"configuration",
		"adoption",
		"staged",
	])("refuses %s before publishing proof", async (fault) => {
		const f = fixture(),
			state = {
				preparation: { ...inactive },
				service: { ...inactive, controlGroup: "", restarts: 0 },
				cgroupState: "empty",
			};
		if (fault === "active") state.service.activeState = "active";
		if (fault === "invocation") state.service.invocationId = "1".repeat(32);
		if (fault === "pid") state.service.mainPid = 123;
		if (fault === "restart") state.service.restarts = 1;
		if (fault === "populated") state.cgroupState = "populated";
		if (fault === "preparation") state.preparation.invocationId = "1".repeat(32);
		if (fault === "mount") mocks.verifyMount.mockRejectedValue(new Error("mount changed"));
		if (fault === "lock") mocks.lock.mockRejectedValue(new Error("lock absent"));
		if (fault === "configuration") f.files.get("/etc/qorpera-office/credentials/config.json")!.bytes = encode({});
		if (fault === "adoption") f.files.get("/etc/qorpera-office/adoption.json")!.bytes = encode({});
		if (fault === "staged")
			f.files.get(
				`/run/qorpera-office-preparation/outage-termination-incoming-${f.command.requestSha256}.json`,
			)!.bytes = encode({});
		f.inspect.mockResolvedValue(state);
		await expect(f.run()).rejects.toThrow("OFFICE_OUTAGE_TERMINATION_UNCONFIRMED");
		expect(mocks.publish).not.toHaveBeenCalled();
	});
	it("retained predecessor verification detects changed root files after reading", async () => {
		const f = fixture(true),
			proof = await readCompanyComputerOutagePredecessor(
				{
					startup: f.packet.challenge.recovery.predecessor.startup,
					bootId: f.command.bootId,
					originPreparationSha256: f.packet.originPreparationSha256,
				},
				f.read,
				new AbortController().signal,
			);
		try {
			f.files.get("/etc/qorpera-office/preparation.json")!.bytes = encode({});
			await expect(proof.verify()).rejects.toThrow();
		} finally {
			proof.close();
		}
	});
	it("never permits the predecessor boot as a fresh recovery", async () => {
		const f = fixture();
		await expect(
			readCompanyComputerOutagePredecessor(
				{
					startup: f.packet.challenge.recovery.predecessor.startup,
					bootId: f.packet.challenge.recovery.predecessor.startup.bootId,
					originPreparationSha256: f.packet.originPreparationSha256,
				},
				f.read,
				new AbortController().signal,
			),
		).rejects.toThrow();
	});
	it("rechecks never-started state immediately before proof publication", async () => {
		const f = fixture();
		f.inspect
			.mockResolvedValueOnce({
				preparation: { ...inactive },
				service: { ...inactive, controlGroup: "", restarts: 0 },
				cgroupState: "empty",
			})
			.mockResolvedValue({
				preparation: { ...inactive },
				service: { ...inactive, controlGroup: "", restarts: 1 },
				cgroupState: "empty",
			});
		await expect(f.run()).rejects.toThrow();
		expect(mocks.publish).not.toHaveBeenCalled();
	});
});

async function configuredFixture(f = fixture(), canonicalPayload = false) {
	mocks.publish.mockImplementation(async (path: string, bytes: Buffer, mode: number) => {
		const prior = f.files.get(path);
		if (prior && (!prior.bytes.equals(bytes) || prior.mode !== mode)) throw new Error("immutable file changed");
		f.files.set(path, { bytes: Buffer.from(bytes), mode });
	});
	const inspection = await f.run(),
		recovery = f.packet.challenge.recovery,
		observation = f.packet.challenge.request.observation,
		termination = {
			schema: "qorpera.office-outage-termination-acknowledgement/v1" as const,
			request: { recovery: recovery.request, inspection },
			officeRevision: 4,
			acknowledgedAtMs: 2000,
		},
		receipt = companyComputerOutageAdoptionReceipt(
			f.f.original,
			f.packet.originPreparationSha256,
			hash(encode(f.f.originReceipt)),
			recovery,
			observation,
			termination,
			inspection.bootObservationSha256,
			hash(companyComputerOutageTerminationAcknowledgementCanonical(termination)),
		),
		configuration = structuredClone(f.f.configuration);
	configuration.linux.attestation = {
		...configuration.linux.attestation,
		bootId: observation.bootId,
		adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(observation.bootId),
		adoptionReceiptSha256: hash(`${companyComputerOutageAdoptionReceiptCanonical(receipt)}\n`),
	};
	const packet = parseCompanyComputerOutageConfigurationRequest({
			schema: "qorpera.office-outage-configuration-request/v1",
			originPreparationSha256: f.packet.originPreparationSha256,
			recovery,
			observation,
			termination,
			material: { ...f.f.input.material, configuration: JSON.stringify(configuration) },
		}),
		packetBytes = canonicalPayload ? Buffer.from(officeCanonical(packet)) : encode(packet),
		command = { commandId: id(912), requestSha256: hash(packetBytes), bootId: observation.bootId };
	f.files.set(`/run/qorpera-office-preparation/outage-configuration-incoming-${command.requestSha256}.json`, {
		bytes: packetBytes,
		mode: 0o400,
	});
	const configure = () =>
			controlCompanyComputerOutageConfiguration(command, { inspect: f.inspect }, new AbortController().signal),
		completion = await configure();
	const attestation = {
			schema: "qorpera.office-activation-attestation/v1",
			activationId: recovery.request.activationId,
			bootId: observation.bootId,
			preparationObservationSha256: inspection.bootObservationSha256,
			configurationObservationSha256: "b".repeat(64),
			configurationSha256: completion.files["config.json"].sha256,
			adoptionReceiptSha256: completion.adoptionReceiptSha256,
			nativePort: configuration.native.port,
			viewerPort: configuration.viewer.port,
		},
		successorRequest = {
			schema: "qorpera.office-outage-successor-request/v1",
			recovery: recovery.request,
			attestation,
			termination,
		},
		startRequest = parseCompanyComputerOutageServiceStartRequest({
			schema: "qorpera.office-outage-service-start-request/v1",
			successor: {
				schema: "qorpera.office-outage-successor/v1",
				request: successorRequest,
				state: "prepared",
				serviceInvocationId: null,
				readinessFresh: false,
				officeRevision: 4,
				privacyVersion: 2,
			},
			configuration: completion,
			configurationCompletionSha256: hash(encode(completion)),
		}),
		startBytes = canonicalPayload ? Buffer.from(officeCanonical(startRequest)) : encode(startRequest),
		startCommand = { commandId: id(913), requestSha256: hash(startBytes), bootId: observation.bootId };
	f.files.set(`/run/qorpera-office-preparation/outage-service-start-incoming-${startCommand.requestSha256}.json`, {
		bytes: startBytes,
		mode: 0o400,
	});
	const start = vi.fn().mockImplementation(async () =>
		f.inspect.mockResolvedValue({
			preparation: { ...inactive },
			service: {
				...inactive,
				invocationId: "9".repeat(32),
				activeState: "active",
				subState: "running",
				mainPid: 321,
				controlGroup: "/system.slice/qorpera-company-computer.service",
				restarts: 0,
			},
			cgroupState: "populated",
		}),
	);
	return {
		...f,
		configure,
		completion,
		receipt,
		startRequest,
		startCommand,
		start,
		startService: (inspectionId?: string) =>
			controlCompanyComputerOutageServiceStart(
				startCommand,
				{ inspect: f.inspect, start },
				new AbortController().signal,
				inspectionId,
			),
	};
}
describe("outage retained configuration and first service invocation", () => {
	it("starts from production canonical successor packet ordering and observes exact retries", async () => {
		const f = await configuredFixture(fixture(), true),
			path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`,
			original = Buffer.from(f.files.get(path)!.bytes),
			started = await f.startService();
		expect(await f.startService()).toEqual(started);
		expect(await f.startService(id(914))).toMatchObject({ inspectionId: id(914), start: started });
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.files.get(path)!.bytes).toEqual(original);
	});
	it.each(["malformed", "extra", "missing", "configuration", "command", "cgroup"])(
		"refuses a %s retained inspection before canonical successor dispatch",
		async (fault) => {
			const f = await configuredFixture(fixture(), true),
				path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`,
				file = f.files.get(path)!,
				inspection = JSON.parse(file.bytes.toString());
			if (fault === "extra") inspection.untrusted = "not part of the acknowledged inspection";
			if (fault === "missing") delete inspection.physicalInstanceId;
			if (fault === "configuration") inspection.predecessorConfigurationSha256 = "f".repeat(64);
			if (fault === "command") inspection.command.commandId = id(999);
			if (fault === "cgroup") inspection.cgroupState = "absent";
			file.bytes = fault === "malformed" ? Buffer.from("not JSON") : encode(inspection);
			mocks.publish.mockClear();
			await expect(f.startService()).rejects.toThrow("OFFICE_OUTAGE_SERVICE_START_UNCONFIRMED");
			expect(f.start).not.toHaveBeenCalled();
			expect(mocks.publish).not.toHaveBeenCalled();
		},
	);
	it("refuses a formatting-only inspection change between successor evidence read and dispatch", async () => {
		const f = await configuredFixture(fixture(), true),
			path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`;
		let reads = 0;
		mocks.read.mockImplementation(async (name: string, limit: number, mode: number) => {
			const bytes = await f.read(name, limit, mode);
			if (name === path && ++reads === 1)
				f.files.get(path)!.bytes = Buffer.concat([bytes.subarray(0, -1), Buffer.from(" ")]);
			return bytes;
		});
		mocks.publish.mockClear();
		await expect(f.startService()).rejects.toThrow("OFFICE_OUTAGE_SERVICE_START_UNCONFIRMED");
		expect(reads).toBe(2);
		expect(f.start).not.toHaveBeenCalled();
		expect(mocks.publish).not.toHaveBeenCalled();
	});
	it("accepts production canonical packet ordering while preserving the guest inspection bytes", async () => {
		const f = await configuredFixture(fixture(), true),
			path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`,
			original = Buffer.from(f.files.get(path)!.bytes);
		expect(original).not.toEqual(Buffer.from(`${officeCanonical(JSON.parse(original.toString()))}\n`));
		expect(await f.configure()).toEqual(f.completion);
		expect(f.files.get(path)!.bytes).toEqual(original);
	});
	it.each(["malformed", "extra", "missing", "configuration", "command", "cgroup"])(
		"refuses a %s retained inspection even with canonical provider ordering",
		async (fault) => {
			const f = await configuredFixture(fixture(), true),
				path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`,
				file = f.files.get(path)!,
				inspection = JSON.parse(file.bytes.toString());
			if (fault === "extra") inspection.untrusted = "not part of the acknowledged inspection";
			if (fault === "missing") delete inspection.physicalInstanceId;
			if (fault === "configuration") inspection.predecessorConfigurationSha256 = "f".repeat(64);
			if (fault === "command") inspection.command.commandId = id(999);
			if (fault === "cgroup") inspection.cgroupState = "absent";
			file.bytes = fault === "malformed" ? Buffer.from("not JSON") : encode(inspection);
			mocks.publish.mockClear();
			await expect(f.configure()).rejects.toThrow("OFFICE_OUTAGE_CONFIGURATION_UNCONFIRMED");
			expect(mocks.publish).not.toHaveBeenCalled();
		},
	);
	it("refuses even a formatting-only change after retaining the validated guest inspection", async () => {
		const f = await configuredFixture(fixture(), true),
			path = `/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`;
		let reads = 0;
		mocks.read.mockImplementation(async (name: string, limit: number, mode: number) => {
			const bytes = await f.read(name, limit, mode);
			if (name === path && ++reads === 1)
				f.files.get(path)!.bytes = Buffer.concat([bytes.subarray(0, -1), Buffer.from(" ")]);
			return bytes;
		});
		mocks.publish.mockClear();
		await expect(f.configure()).rejects.toThrow("OFFICE_OUTAGE_CONFIGURATION_UNCONFIRMED");
		expect(reads).toBe(2);
		expect(mocks.publish).not.toHaveBeenCalled();
	});
	it("recovers a reset-born predecessor without restoring historical credentials", async () => {
		const base = resetPredecessorFixture(),
			f = await configuredFixture(base);
		expect(f.files.has("/etc/qorpera-office/credentials/config.json")).toBe(false);
		const started = await f.startService();
		expect(started).toMatchObject({ schema: "qorpera.office-outage-service-start-completion/v1" });
		expect(f.start).toHaveBeenCalledOnce();
		expect(f.files.has("/etc/qorpera-office/credentials/config.json")).toBe(false);
	});
	it("refuses a reset-origin receipt rebound to a different physical identity", async () => {
		const f = resetPredecessorFixture(),
			path = companyComputerResetAdoptionReceiptPath(f.packet.challenge.recovery.predecessor.startup.bootId),
			receipt = JSON.parse(f.files.get(path)!.bytes.toString());
		receipt.instanceSha256 = "f".repeat(64);
		f.files.get(path)!.bytes = encode(receipt);
		await expect(f.run()).rejects.toThrow();
		expect(mocks.publish).not.toHaveBeenCalled();
	});
	it("an ordinary power-off after outage recovery supplies valid history for the next fresh boot", async () => {
		const f = await configuredFixture(),
			started = await f.startService();
		if (!("command" in started)) throw new Error("expected start completion");
		const predecessor = f.packet.challenge.recovery.predecessor,
			stop = parseCompanyComputerServiceStopRequest({
				schema: "qorpera.office-service-stop-request/v1",
				startCompletionSha256: hash(encode(started)),
				revocation: {
					schema: "qorpera.office-lifecycle-transition/v1",
					state: "draining",
					revocationRevision: 6,
					requestedAtMs: 2500,
					drains: [],
					request: {
						schema: "qorpera.office-lifecycle-request/v1",
						action: "power_off",
						transitionId: id(920),
						activationId: started.activationId,
						providerId: predecessor.providerId,
						providerPolicySha256: predecessor.providerPolicySha256,
						startup: {
							...predecessor.startup,
							bootId: started.command.bootId,
							configurationSha256: started.configurationSha256,
							serviceInvocationId: started.serviceInvocationId,
						},
					},
				},
			}),
			stopCommand = { commandId: id(921), requestSha256: hash(encode(stop)), bootId: started.command.bootId },
			stopped = parseCompanyComputerServiceStopCompletion(
				{
					schema: "qorpera.office-service-stop-completion/v1",
					command: stopCommand,
					transitionId: stop.revocation.request.transitionId,
					activationId: started.activationId,
					revocationRevision: 6,
					configurationSha256: started.configurationSha256,
					startCompletionSha256: hash(encode(started)),
					fromServiceInvocationId: started.serviceInvocationId,
					observedInvocationId: started.serviceInvocationId,
					stoppedInvocationId: started.serviceInvocationId,
					controlGroup: started.controlGroup,
					cgroupState: "empty",
				},
				stopCommand,
				stop,
			),
			completionPath = `/run/qorpera-office-preparation/service-stop-completion-${started.activationId}.json`;
		f.files.set(`/run/qorpera-office-preparation/service-stop-incoming-${stopCommand.requestSha256}.json`, {
			bytes: encode(stop),
			mode: 0o400,
		});
		f.files.set(completionPath, { bytes: encode(stopped), mode: 0o600 });
		const directory = companyComputerBootDirectory(started.command.bootId),
			sources = new Map(
				[...f.files].filter(
					([path]) =>
						path === "/etc/qorpera-office/adoption.json" ||
						path === "/etc/qorpera-office/credentials/config.json" ||
						(path.startsWith(`${directory}/`) &&
							(!path.includes("/credentials/") || path.endsWith("/config.json"))) ||
						(path.startsWith("/run/") &&
							!path.includes("outage-configuration-incoming") &&
							!path.includes("outage-termination-incoming")),
				),
			),
			manifest = parseCompanyComputerStopHistoryManifest(
				{
					schema: "qorpera.office-stop-history/v1",
					command: stopCommand,
					activationId: started.activationId,
					completionPath,
					entries: [...sources]
						.map(([path, file]) => ({
							path,
							bytes: file.bytes.length,
							sha256: hash(file.bytes),
							mode: file.mode,
						}))
						.sort((a, b) => (a.path < b.path ? -1 : 1)),
				},
				started.command.bootId,
				started.activationId,
			),
			intent = parseCompanyComputerBootIntentRequest({
				schema: "qorpera.office-boot-intent-request/v1",
				bootIntentId: id(922),
				activationId: id(923),
				predecessor: stop.revocation.request,
				stopHistorySha256: hash(encode(manifest)),
				powerOffCompletionSha256: "a".repeat(64),
			});
		mocks.history.mockImplementation(async () => ({
			manifest,
			manifestSha256: hash(encode(manifest)),
			files: new Map([...sources].map(([path, file]) => [path, Buffer.from(file.bytes)])),
		}));
		const input = {
			command: { commandId: id(924), requestSha256: "b".repeat(64), bootId: id(925) },
			intent,
			original: f.f.original,
			originPreparationSha256: f.packet.originPreparationSha256,
			originReceipt: encode(f.f.originReceipt),
			originalConfiguration: f.f.originFiles.get("/etc/qorpera-office/credentials/config.json")!.bytes,
		};
		await verifyCompanyComputerBootPredecessor(input, f.read, new AbortController().signal);
		f.files.get(`${directory}/adoption.json`)!.bytes = encode({});
		await expect(verifyCompanyComputerBootPredecessor(input, f.read, new AbortController().signal)).rejects.toThrow();
	});
	it("retains explicit outage origin through two ordinary service restarts and rejects corrupted history", async () => {
		const f = await configuredFixture(),
			started = await f.startService();
		if (!("command" in started)) throw new Error("expected start completion");
		const first = await readCompanyComputerStopInvocation(started.activationId, started.command.bootId, f.read);
		expect(first.kind).toBe("outage");
		expect(f.receipt).not.toHaveProperty("privacyChallenge");
		expect(f.receipt.recovery).not.toHaveProperty("drains");
		expect(f.receipt).not.toHaveProperty("termination");
		const predecessor = f.packet.challenge.recovery.predecessor,
			stopRequest = parseCompanyComputerServiceStopRequest({
				schema: "qorpera.office-service-stop-request/v1",
				startCompletionSha256: hash(encode(started)),
				revocation: {
					schema: "qorpera.office-lifecycle-transition/v1",
					state: "draining",
					revocationRevision: 6,
					requestedAtMs: 2500,
					drains: [],
					request: {
						schema: "qorpera.office-lifecycle-request/v1",
						action: "service_restart",
						transitionId: id(920),
						activationId: started.activationId,
						providerId: predecessor.providerId,
						providerPolicySha256: predecessor.providerPolicySha256,
						startup: {
							...predecessor.startup,
							bootId: started.command.bootId,
							configurationSha256: started.configurationSha256,
							serviceInvocationId: started.serviceInvocationId,
						},
					},
				},
			}),
			fixture = { files: f.files, request: f.startRequest, startCompletion: started, stopRequest },
			restart = appendBootServiceRestartFixture(fixture),
			next = appendBootServiceRestartFixture(fixture, restart.completion, 2),
			selected = await readCompanyComputerStopInvocation(
				next.completion.activationId,
				started.command.bootId,
				f.read,
			);
		expect(selected.kind).toBe("boot_restart");
		expect(selected.start).toEqual(next.completion);
		if (!("origin" in selected)) throw new Error("missing origin");
		expect(selected.origin.request.schema).toBe("qorpera.office-outage-service-start-request/v1");
		expect(selected.start).toHaveProperty("recoveryId", f.packet.challenge.recovery.request.recoveryId);
		expect(selected.start).not.toHaveProperty("bootIntentId");
		f.files.get(restart.completionPath)!.bytes = encode({});
		await expect(
			readCompanyComputerStopInvocation(next.completion.activationId, started.command.bootId, f.read),
		).rejects.toThrow();
	});
	it("writes fresh credentials once then starts once and only observes on exact retries", async () => {
		const f = await configuredFixture();
		expect(await f.configure()).toEqual(f.completion);
		const started = await f.startService();
		expect(await f.startService()).toEqual(started);
		expect(f.start).toHaveBeenCalledOnce();
		const inspected = await f.startService(id(914));
		expect(inspected).toMatchObject({ inspectionId: id(914), start: started });
		expect(f.files.get("/etc/qorpera-office/credentials/config.json")!.bytes).toEqual(
			f.f.originFiles.get("/etc/qorpera-office/credentials/config.json")!.bytes,
		);
	});
	it.each(["credential", "adoption", "termination", "mount", "priorClaim"])(
		"refuses changed %s before dispatch",
		async (fault) => {
			const f = await configuredFixture(),
				directory = companyComputerBootDirectory(f.startCommand.bootId);
			if (fault === "credential") f.files.get(`${directory}/credentials/registry`)?.bytes.fill(0);
			if (fault === "credential") f.files.get(`${directory}/credentials/config.json`)!.bytes = encode({});
			if (fault === "adoption") f.files.get(`${directory}/adoption.json`)!.bytes = encode({});
			if (fault === "termination")
				f.files.get(`/run/qorpera-office-preparation/outage-termination-inspection-${id(910)}.json`)!.bytes =
					encode({});
			if (fault === "mount") mocks.verifyMount.mockRejectedValue(new Error("mount changed"));
			if (fault === "priorClaim") mocks.lstat.mockResolvedValue({});
			await expect(f.startService()).rejects.toThrow("OFFICE_OUTAGE_SERVICE_START_UNCONFIRMED");
			expect(f.start).not.toHaveBeenCalled();
		},
	);
	it("does not dispatch again when the start command outcome is lost", async () => {
		const f = await configuredFixture();
		f.start.mockRejectedValue(new Error("lost response"));
		await expect(f.startService()).rejects.toThrow();
		await expect(f.startService()).rejects.toThrow();
		expect(f.start).toHaveBeenCalledOnce();
	});
});
