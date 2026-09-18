import {
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
} from "@qorpera/contracts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";

export function bootServiceStartFixture(options: Parameters<typeof bootConfigurationFixture>[0] = {}) {
	return bootServiceStartFromConfiguration(bootConfigurationFixture(options));
}

export function bootServiceStartFromConfiguration(f: ReturnType<typeof bootConfigurationFixture>) {
	const prior = f.input.bootIntent,
		attestation = {
			schema: "qorpera.office-activation-attestation/v1",
			preparationObservationSha256: "6".repeat(64),
			configurationObservationSha256: "7".repeat(64),
			activationId: prior.request.activationId,
			bootId: f.command.bootId,
			configurationSha256: f.completion.files["config.json"].sha256,
			adoptionReceiptSha256: f.completion.adoptionReceiptSha256,
			nativePort: f.configuration.native.port,
			viewerPort: f.configuration.viewer.port,
		};
	const request = parseCompanyComputerBootServiceStartRequest({
		schema: "qorpera.office-boot-service-start-request/v1",
		configuration: f.completion,
		configurationCompletionSha256: hash(encode(f.completion)),
		successor: {
			schema: "qorpera.office-boot-successor/v1",
			request: {
				schema: "qorpera.office-boot-successor-request/v1",
				bootIntentId: prior.request.bootIntentId,
				predecessor: prior.request.predecessor,
				attestation,
				stopHistorySha256: prior.request.stopHistorySha256,
				powerOffCompletionSha256: prior.request.powerOffCompletionSha256,
				bootObservationSha256: f.completion.bootObservationSha256,
			},
			state: "prepared",
			serviceInvocationId: null,
			readinessFresh: false,
			stopAcknowledgedAtMs: prior.stopAcknowledgedAtMs,
			officeRevision: prior.officeRevision,
			privacyVersion: prior.privacyVersion,
			validForMs: 5000,
		},
	});
	const command = { commandId: id(201), requestSha256: hash(encode(request)), bootId: f.command.bootId };
	const completion = parseCompanyComputerBootServiceStartCompletion(
		{
			schema: "qorpera.office-boot-service-start-completion/v1",
			command,
			bootIntentId: prior.request.bootIntentId,
			activationId: attestation.activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
			configurationSha256: attestation.configurationSha256,
			serviceInvocationId: "b".repeat(32),
			mainPid: 42,
			controlGroup: "/system.slice/qorpera-company-computer.service",
		},
		command,
		request,
	);
	return { ...f, bootConfiguration: f, request, startCommand: command, startCompletion: completion };
}
