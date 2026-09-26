import {
	companyComputerOutageAdoptionReceipt,
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageResumeObservationCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	parseCompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerOutageConfigurationRequest,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageSuccessor,
	parseCompanyComputerOutageTerminationAcknowledgement,
} from "@qorpera/contracts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";

export function companyComputerOutageFixture(options: { requestSha256?: string } = {}) {
	const f = bootConfigurationFixture();
	const { activationId, providerId, providerPolicySha256, startup } = f.input.bootIntent.request.predecessor;
	const request = {
		schema: "qorpera.office-outage-recovery-request/v1" as const,
		recoveryId: id(901),
		outageRequestId: id(902),
		activationId: id(903),
		startCommandId: id(904),
	};
	const recovery = parseCompanyComputerOutageRecovery(
		{
			schema: "qorpera.office-outage-recovery/v1",
			request,
			predecessor: { activationId, providerId, providerPolicySha256, startup },
			state: "prepared",
			officeRevision: 3,
			privacyState: "entering",
			privacyVersion: 2,
			privacyChallenge: { privateMarker: "must-remain-protected" },
			drains: [],
		},
		request,
	);
	const observation = {
		schema: "qorpera.lxd-office-outage-resume-observation/v1" as const,
		intentId: id(12),
		allocationId: startup.allocationId,
		recoveryId: request.recoveryId,
		activationId: request.activationId,
		startCommandId: request.startCommandId,
		requestSha256: options.requestSha256 ?? "a".repeat(64),
		hostBootId: id(905),
		bootId: id(906),
		instanceSha256: startup.instanceSha256,
		physicalInstanceId: id(907),
		operationId: id(908),
	};
	const inspection = {
		schema: "qorpera.office-outage-termination-inspection/v1",
		command: { commandId: id(909), requestSha256: "b".repeat(64), bootId: observation.bootId },
		inspectionId: id(910),
		recoveryId: request.recoveryId,
		startCommandId: request.startCommandId,
		bootId: observation.bootId,
		hostBootId: observation.hostBootId,
		physicalInstanceId: observation.physicalInstanceId,
		bootObservationSha256: hash(companyComputerOutageResumeObservationCanonical(observation, recovery)),
		originPreparationSha256: f.input.originPreparationSha256,
		originAdoptionReceiptSha256: hash(encode(f.originReceipt)),
		predecessorConfigurationSha256: startup.configurationSha256,
		predecessorAdoptionReceiptSha256: hash(encode(f.originReceipt)),
		cgroupState: "empty",
		preparationState: "unstarted",
		serviceState: "unstarted",
	};
	const termination = parseCompanyComputerOutageTerminationAcknowledgement({
		schema: "qorpera.office-outage-termination-acknowledgement/v1",
		request: { recovery: request, inspection },
		officeRevision: 4,
		acknowledgedAtMs: 2000,
	});
	const receipt = companyComputerOutageAdoptionReceipt(
		f.original,
		f.input.originPreparationSha256,
		inspection.originAdoptionReceiptSha256,
		recovery,
		observation,
		termination,
		inspection.bootObservationSha256,
		hash(companyComputerOutageTerminationAcknowledgementCanonical(termination)),
	);
	const configuration = parseCompanyComputerOutageConfigurationRequest({
		schema: "qorpera.office-outage-configuration-request/v1",
		originPreparationSha256: f.input.originPreparationSha256,
		recovery,
		observation,
		termination,
		material: f.input.material,
	});
	const completion = parseCompanyComputerOutageConfigurationCompletion({
		schema: "qorpera.office-outage-configuration-completion/v1",
		command: { commandId: id(911), requestSha256: hash(encode(configuration)), bootId: observation.bootId },
		recoveryId: request.recoveryId,
		activationId: request.activationId,
		originPreparationSha256: inspection.originPreparationSha256,
		adoptionReceiptSha256: hash(`${companyComputerOutageAdoptionReceiptCanonical(receipt)}\n`),
		bootObservationSha256: inspection.bootObservationSha256,
		files: f.completion.files,
	});
	const successorRequest = {
		schema: "qorpera.office-outage-successor-request/v1" as const,
		recovery: request,
		termination,
		attestation: {
			schema: "qorpera.office-activation-attestation/v1" as const,
			activationId: request.activationId,
			bootId: observation.bootId,
			preparationObservationSha256: inspection.bootObservationSha256,
			configurationObservationSha256: "2".repeat(64),
			configurationSha256: completion.files["config.json"].sha256,
			adoptionReceiptSha256: completion.adoptionReceiptSha256,
			nativePort: 9443,
			viewerPort: 9444,
		},
	};
	const successor = parseCompanyComputerOutageSuccessor(
		{
			schema: "qorpera.office-outage-successor/v1",
			request: successorRequest,
			state: "prepared",
			serviceInvocationId: null,
			readinessFresh: false,
			officeRevision: 4,
			privacyVersion: 2,
		},
		successorRequest,
	);
	const start = parseCompanyComputerOutageServiceStartRequest({
		schema: "qorpera.office-outage-service-start-request/v1",
		successor,
		configuration: completion,
		configurationCompletionSha256: hash(encode(completion)),
	});
	const startCommand = { commandId: id(912), requestSha256: hash(encode(start)), bootId: observation.bootId };
	const started = parseCompanyComputerOutageServiceStartCompletion(
		{
			schema: "qorpera.office-outage-service-start-completion/v1",
			command: startCommand,
			recoveryId: request.recoveryId,
			activationId: request.activationId,
			configurationCompletionSha256: start.configurationCompletionSha256,
			configurationSha256: successorRequest.attestation.configurationSha256,
			serviceInvocationId: "9".repeat(32),
			mainPid: 321,
			controlGroup: "/system.slice/qorpera-company-computer.service",
		},
		startCommand,
		start,
	);
	return {
		f,
		request,
		recovery,
		observation,
		termination,
		receipt,
		configuration,
		completion,
		successorRequest,
		successor,
		start,
		startCommand,
		started,
	};
}
