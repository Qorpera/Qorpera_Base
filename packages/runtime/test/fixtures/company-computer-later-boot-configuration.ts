import {
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerResumeObservationCanonical,
	companyComputerStopHistoryDirectory,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import {
	bootConfigurationFixture,
	bootFixtureEncode as encode,
	bootFixtureHash as hash,
	bootFixtureId as id,
} from "./company-computer-boot-configuration.ts";
import { appendBootServiceRestartFixture } from "./company-computer-boot-service-restart.ts";
import { bootServiceStopFixture } from "./company-computer-boot-service-stop.ts";

/** Synthetic completed prior boot, optionally followed by service successors.
 * The current root helper sees only persistent public files and sealed history. */
export function laterBootConfigurationFixture(
	options: Parameters<typeof bootConfigurationFixture>[0] & { restarts?: number } = {},
) {
	const base = bootConfigurationFixture({ ...options, bootId: options.bootId ?? id(900) }),
		previous = bootServiceStopFixture({ ...options, bootId: id(19) });
	let selected: typeof previous.startCompletion | ReturnType<typeof appendBootServiceRestartFixture>["completion"] =
		previous.startCompletion;
	for (let n = 1; n <= (options.restarts ?? 2); n++)
		selected = appendBootServiceRestartFixture(previous, selected, n).completion;
	const stop = parseCompanyComputerServiceStopRequest({
			...previous.stopRequest,
			startCompletionSha256: hash(encode(selected)),
			revocation: {
				...previous.stopRequest.revocation,
				request: {
					...previous.stopRequest.revocation.request,
					action: "reboot",
					transitionId: id(901),
					activationId: selected.activationId,
					startup: {
						...previous.stopRequest.revocation.request.startup,
						serviceInvocationId: selected.serviceInvocationId,
					},
				},
			},
		}),
		stopCommand = { commandId: id(902), bootId: selected.command.bootId, requestSha256: hash(encode(stop)) },
		stopped = parseCompanyComputerServiceStopCompletion(
			{
				schema: "qorpera.office-service-stop-completion/v1",
				command: stopCommand,
				transitionId: stop.revocation.request.transitionId,
				activationId: selected.activationId,
				revocationRevision: stop.revocation.revocationRevision,
				configurationSha256: selected.configurationSha256,
				startCompletionSha256: stop.startCompletionSha256,
				fromServiceInvocationId: selected.serviceInvocationId,
				observedInvocationId: selected.serviceInvocationId,
				stoppedInvocationId: selected.serviceInvocationId,
				controlGroup: selected.controlGroup,
				cgroupState: "absent",
			},
			stopCommand,
			stop,
		);
	const root = "/run/qorpera-office-preparation",
		completionPath = `${root}/service-stop-completion-${selected.activationId}.json`,
		sources = new Map(previous.files);
	sources.set(`${root}/service-stop-incoming-${stopCommand.requestSha256}.json`, { bytes: encode(stop), mode: 0o400 });
	sources.set(completionPath, { bytes: encode(stopped), mode: 0o600 });
	const manifest = parseCompanyComputerStopHistoryManifest(
			{
				schema: "qorpera.office-stop-history/v1",
				command: stopCommand,
				activationId: selected.activationId,
				completionPath,
				entries: [...sources]
					.map(([path, file]) => ({ path, bytes: file.bytes.length, sha256: hash(file.bytes), mode: file.mode }))
					.sort((a, b) => (a.path < b.path ? -1 : 1)),
			},
			selected.command.bootId,
			selected.activationId,
		),
		historyDirectory = companyComputerStopHistoryDirectory(selected.command.bootId, selected.activationId),
		archiveFiles = new Map([
			...previous.archiveFiles,
			[`${historyDirectory}/manifest.json`, encode(manifest)],
			[`${historyDirectory}/claim.json`, encode(manifest)],
			...[...sources.values()].map((file): [string, Buffer] => [
				`${historyDirectory}/${hash(file.bytes)}.json`,
				Buffer.from(file.bytes),
			]),
		]);
	const powerOffCompletion = encode({
			...JSON.parse(base.input.powerOffCompletion),
			transitionId: stop.revocation.request.transitionId,
			commandId: id(903),
			operationId: id(904),
		}).toString(),
		intent = parseCompanyComputerBootIntentRequest({
			...base.input.bootIntent.request,
			bootIntentId: id(905),
			activationId: id(906),
			predecessor: stop.revocation.request,
			stopHistorySha256: hash(encode(manifest)),
			powerOffCompletionSha256: hash(powerOffCompletion),
		}),
		observation = {
			...base.input.observation,
			bootIntentId: intent.bootIntentId,
			activationId: intent.activationId,
			startCommandId: id(907),
			operationId: id(908),
			stopHistorySha256: intent.stopHistorySha256,
			powerOffCompletionSha256: intent.powerOffCompletionSha256,
		},
		bootObservationSha256 = hash(companyComputerResumeObservationCanonical(observation, intent)),
		receipt = companyComputerBootAdoptionReceipt(
			base.original,
			base.input.originPreparationSha256,
			hash(encode(base.originReceipt)),
			intent,
			observation,
			bootObservationSha256,
		),
		configuration = {
			...base.configuration,
			linux: {
				...base.configuration.linux,
				attestation: {
					...base.configuration.linux.attestation,
					adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(observation.bootId),
					adoptionReceiptSha256: hash(encode(receipt)),
				},
			},
		},
		input = parseCompanyComputerBootConfigurationRequest({
			...base.input,
			bootIntent: { ...base.input.bootIntent, request: intent },
			observation,
			powerOffCompletion,
			material: { ...base.input.material, configuration: JSON.stringify(configuration) },
		}),
		command = { ...base.command, commandId: id(909), requestSha256: hash(encode(input)) },
		completion = {
			...base.completion,
			command,
			bootIntentId: intent.bootIntentId,
			activationId: intent.activationId,
			adoptionReceiptSha256: hash(encode(receipt)),
			bootObservationSha256,
			files: {
				...base.completion.files,
				"config.json": {
					bytes: Buffer.byteLength(input.material.configuration),
					sha256: hash(input.material.configuration),
				},
			},
		};
	const originFiles = new Map(
		[...base.originFiles, ...[...previous.files].filter(([path]) => path.startsWith("/etc/"))].map(([path, file]) => [
			path,
			{ bytes: Buffer.from(file.bytes), mode: file.mode },
		]),
	);
	return {
		...base,
		input,
		command,
		completion,
		receipt,
		configuration,
		originFiles,
		archiveFiles,
		historyDirectory,
		sources,
		manifest,
		previous,
		selected,
		stop,
	};
}
