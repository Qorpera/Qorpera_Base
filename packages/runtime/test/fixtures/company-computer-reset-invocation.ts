import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetServiceStartCompletion,
	companyComputerBootDirectory,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";

export function resetInvocationFixture() {
	const f = bootConfigurationFixture();
	const root = "/run/qorpera-office-preparation";
	const bootId = f.command.bootId,
		activationId = id(710),
		resetId = id(711),
		rootIncarnationId = id(712);
	const directory = companyComputerBootDirectory(bootId);
	const receiptBytes = encode(f.originReceipt);
	const request = parseCompanyComputerResetServiceStartRequest({
		schema: "qorpera.office-reset-successor/v1",
		request: {
			schema: "qorpera.office-reset-successor-request/v1",
			resetId,
			rootIncarnationId,
			predecessor: { ...f.input.bootIntent.request.predecessor, action: "replace" },
			attestation: {
				schema: "qorpera.office-activation-attestation/v1",
				activationId,
				bootId,
				preparationObservationSha256: "5".repeat(64),
				configurationObservationSha256: "6".repeat(64),
				configurationSha256: f.completion.files["config.json"].sha256,
				adoptionReceiptSha256: hash(receiptBytes),
				nativePort: 9443,
				viewerPort: 9444,
			},
			custodySha256: "7".repeat(64),
			restoreSha256: "8".repeat(64),
		},
		state: "prepared",
		serviceInvocationId: null,
		readinessFresh: false,
		stopAcknowledgedAtMs: 2000,
		officeRevision: 12,
		privacyVersion: 1,
		validForMs: 5000,
	});
	const configured: CompanyComputerResetConfigurationCompletion = {
		schema: "qorpera.office-reset-configuration-completion/v1",
		command: { ...f.command, commandId: id(713) },
		resetId,
		rootIncarnationId,
		activationId,
		originPreparationSha256: f.completion.originPreparationSha256,
		adoptionReceiptSha256: hash(receiptBytes),
		files: f.completion.files,
	};
	const command = { commandId: id(714), bootId, requestSha256: hash(encode(request)) };
	const start: CompanyComputerResetServiceStartCompletion = {
		schema: "qorpera.office-reset-service-start-completion/v1",
		command,
		resetId,
		activationId,
		configurationCompletionSha256: hash(encode(configured)),
		configurationSha256: request.request.attestation.configurationSha256,
		serviceInvocationId: "9".repeat(32),
		mainPid: 700,
		controlGroup: "/system.slice/qorpera-company-computer.service",
	};
	const paths = {
		completion: `${root}/reset-service-start-completion.json`,
		claim: `${root}/reset-service-start-claim.json`,
		packet: `${root}/reset-service-start-incoming-${command.requestSha256}.json`,
		configuration: `${directory}/reset-configuration-completion.json`,
		configurationClaim: `${directory}/reset-configuration-claim.json`,
		receipt: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	};
	const files = new Map<string, { bytes: Buffer; mode: number }>();
	const put = (path: string, value: unknown, mode = 0o600) => files.set(path, { bytes: encode(value), mode });
	put(paths.completion, start);
	put(paths.claim, {
		schema: "qorpera.office-reset-service-start-claim/v1",
		command,
		resetId,
		activationId,
		configurationCompletionSha256: start.configurationCompletionSha256,
	});
	put(paths.packet, request, 0o400);
	put(paths.configuration, configured);
	put(paths.configurationClaim, {
		schema: "qorpera.office-reset-configuration-claim/v1",
		command: configured.command,
		resetId,
		rootIncarnationId,
		activationId,
	});
	files.set(paths.receipt, { bytes: receiptBytes, mode: 0o444 });
	return { files, paths, put, start, command, configured, request, directory, bootId, activationId };
}
