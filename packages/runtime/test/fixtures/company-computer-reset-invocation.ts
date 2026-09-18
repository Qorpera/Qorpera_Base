import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetServiceStartCompletion,
	companyComputerBootDirectory,
	parseCompanyComputerResetConfigurationRequest,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";

export function resetInvocationFixture(options: Parameters<typeof bootConfigurationFixture>[0] = {}) {
	const f = bootConfigurationFixture(options);
	const root = "/run/qorpera-office-preparation";
	const bootId = f.command.bootId,
		activationId = id(710),
		resetId = id(711),
		rootIncarnationId = id(712);
	const directory = companyComputerBootDirectory(bootId);
	const receiptBytes = encode(f.originReceipt);
	const configuration = {
		...f.configuration,
		linux: {
			...f.configuration.linux,
			attestation: {
				...f.configuration.linux.attestation,
				bootId,
				adoptionReceiptPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
				adoptionReceiptSha256: hash(receiptBytes),
			},
		},
	};
	const input = parseCompanyComputerResetConfigurationRequest({
		schema: "qorpera.office-reset-configuration-request/v1",
		resetId,
		rootIncarnationId,
		activationId,
		predecessor: { ...f.input.bootIntent.request.predecessor, action: "replace" },
		originPreparation: encode(f.original).toString("utf8"),
		originPreparationSha256: f.completion.originPreparationSha256,
		adoptionReceiptSha256: hash(receiptBytes),
		material: { ...f.input.material, configuration: JSON.stringify(configuration) },
	});
	const configurationFiles = Object.fromEntries(
		Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
			const bytes = Buffer.from(input.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
			return [file, { bytes: bytes.length, sha256: hash(bytes) }];
		}),
	) as CompanyComputerResetConfigurationCompletion["files"];
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
				configurationSha256: configurationFiles["config.json"].sha256,
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
		command: { ...f.command, commandId: id(713), requestSha256: hash(encode(input)) },
		resetId,
		rootIncarnationId,
		activationId,
		originPreparationSha256: f.completion.originPreparationSha256,
		adoptionReceiptSha256: hash(receiptBytes),
		files: configurationFiles,
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
	// Adapt only the synthetic predecessor archive to an acknowledged replace.
	// Original preparation/receipt bytes remain pinned and no old credential
	// directory is recreated on the reset root.
	const manifest = JSON.parse(f.archiveFiles.get(`${f.historyDirectory}/manifest.json`)!.toString());
	const oldStopPath = `${root}/service-stop-incoming-${manifest.command.requestSha256}.json`;
	const stopEntry = manifest.entries.find((entry: { path: string }) => entry.path === oldStopPath);
	const oldStop = JSON.parse(f.archiveFiles.get(`${f.historyDirectory}/${stopEntry.sha256}.json`)!.toString());
	const stop = { ...oldStop, revocation: { ...oldStop.revocation, request: input.predecessor } };
	const stopCommand = { ...manifest.command, requestSha256: hash(encode(stop)) };
	const archiveFiles = new Map<string, Buffer>();
	manifest.command = stopCommand;
	for (const entry of manifest.entries) {
		let bytes = f.archiveFiles.get(`${f.historyDirectory}/${entry.sha256}.json`)!;
		if (entry.path === oldStopPath) {
			bytes = encode(stop);
			entry.path = `${root}/service-stop-incoming-${stopCommand.requestSha256}.json`;
		}
		if (entry.path === manifest.completionPath)
			bytes = encode({ ...JSON.parse(bytes.toString()), command: stopCommand });
		entry.bytes = bytes.length;
		entry.sha256 = hash(bytes);
		archiveFiles.set(`${f.historyDirectory}/${entry.sha256}.json`, bytes);
	}
	manifest.entries.sort((a: { path: string }, b: { path: string }) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	archiveFiles.set(`${f.historyDirectory}/manifest.json`, encode(manifest));
	archiveFiles.set(`${f.historyDirectory}/claim.json`, encode(manifest));
	const originFiles = new Map([[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, { bytes: receiptBytes, mode: 0o444 }]]);
	return {
		files,
		paths,
		put,
		start,
		command,
		configured,
		request,
		directory,
		bootId,
		activationId,
		input,
		configurationCommand: configured.command,
		originFiles,
		archiveFiles,
		historyDirectory: f.historyDirectory,
		original: f.original,
		receipt: f.originReceipt,
	};
}
