import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES,
	parseCompanyComputerBootIntent,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResumeObservation,
} from "@qorpera/contracts";
import type {
	LxdOfficeBootConfigurationClient,
	LxdOfficeBootServiceStartClient,
	LxdOfficeServiceRestartClient,
	LxdOfficeServiceStartClient,
} from "./lxd-client.ts";
import {
	readLxdOfficeActivationHistory,
	readLxdOfficeInitialActivationHistory,
} from "./lxd-office-activation-history.ts";
import { openLxdOfficeBootConfigurationJournal } from "./lxd-office-boot-configuration-journal.ts";
import { openLxdOfficeBootServiceStartJournal } from "./lxd-office-boot-service-start-journal.ts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { readLxdOfficePowerOffEvidence } from "./lxd-office-power-off-evidence.ts";
import { officeStopHash } from "./lxd-office-stop-evidence.ts";

export type LxdOfficeBootActivationHistoryClient = LxdOfficeServiceStartClient &
	Partial<LxdOfficeBootConfigurationClient & LxdOfficeBootServiceStartClient & LxdOfficeServiceRestartClient>;
/** Historical acknowledgements only, after boot activation. This deliberately
 * does not resolve bootstrap credentials, inspect the mutable workbench or
 * re-enter boot intent/configuration/activation authority. The caller checks
 * current guest records and current lifecycle authority before stop effects. */
export async function readLxdOfficeBootActivationHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeBootActivationHistoryClient,
	signal: AbortSignal,
) {
	const read = async (name: string) => (await readSource(name)).value,
		{ allocationId } = binding,
		suffix = `${allocationId}-${activationId}`;
	parseCompanyComputerPreparationCommand({ commandId: activationId, bootId: intentId, requestSha256: "0".repeat(64) });
	const packet = officeRecord(await read(`boot-service-start-request-${suffix}.json`), [
			"schema",
			"intentId",
			"binding",
			"command",
			"request",
		]),
		request = parseCompanyComputerBootServiceStartRequest(packet.request),
		command = parseCompanyComputerPreparationCommand(packet.command),
		successor = request.successor.request,
		{ attestation } = successor,
		configuration = request.configuration,
		configurationObservationSha256 = attestation.configurationObservationSha256;
	if (
		!isDeepStrictEqual(packet, {
			schema: "qorpera.lxd-office-boot-service-start-request/v1",
			intentId,
			binding,
			command,
			request,
		}) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request))) ||
		command.bootId !== attestation.bootId ||
		attestation.activationId !== activationId
	)
		throw new Error("boot activation packet differs");
	if (
		!isDeepStrictEqual(await read(`boot-successor-request-${suffix}.json`), {
			schema: "qorpera.lxd-office-boot-successor-request/v1",
			intentId,
			binding,
			request: successor,
			configurationObservationSha256,
		}) ||
		!isDeepStrictEqual(await read(`boot-successor-prepared-${suffix}.json`), request.successor)
	)
		throw new Error("boot successor preparation differs");
	const bootIntent = parseCompanyComputerBootIntentRequest({
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: successor.bootIntentId,
			activationId,
			predecessor: successor.predecessor,
			stopHistorySha256: successor.stopHistorySha256,
			powerOffCompletionSha256: successor.powerOffCompletionSha256,
		}),
		previousSuffix = `${allocationId}-${bootIntent.predecessor.transitionId}`,
		prepared = parseCompanyComputerBootIntent(await read(`resume-prepared-${previousSuffix}.json`), bootIntent),
		resume = parseCompanyComputerResumeObservation(
			await read(`resume-observation-${previousSuffix}.json`),
			bootIntent,
		),
		creationValue = officeRecord(await read(`intent-${intentId}.json`), [
			"schema",
			"intentId",
			"binding",
			"createCommandId",
		]);
	parseCompanyComputerPreparationCommand({ ...command, commandId: creationValue.createCommandId });
	const creation: LxdOfficeCreationIdentity = {
		schema: "qorpera.lxd-office-creation/v1",
		intentId,
		binding,
		createCommandId: creationValue.createCommandId as string,
	};
	if (!isDeepStrictEqual(creationValue, creation)) throw new Error("boot creation differs");
	// Pin the immediate shutdown link; audit its transitive closure separately
	// so each new shutdown does not copy every older boot record into its seed.
	await read(`power-off-request-${previousSuffix}.json`);
	await read(`power-off-completed-${previousSuffix}.json`);
	const shutdown = await readLxdOfficePowerOffEvidence(root, creation, bootIntent, signal),
		resumeSeed = await read(`resume-request-${previousSuffix}.json`),
		bootObservationSha256 = officeDigest(resume);
	if (
		prepared.state !== "prepared" ||
		prepared.stopAcknowledgedAtMs !== request.successor.stopAcknowledgedAtMs ||
		prepared.officeRevision !== request.successor.officeRevision ||
		prepared.privacyVersion !== request.successor.privacyVersion ||
		resume.intentId !== intentId ||
		shutdown.bootIds.includes(resume.bootId) ||
		resume.bootId !== command.bootId ||
		resume.hostBootId !== shutdown.hostBootId ||
		bootObservationSha256 !== successor.bootObservationSha256 ||
		resume.requestSha256 !== officeDigest(resumeSeed) ||
		!isDeepStrictEqual(resumeSeed, {
			schema: "qorpera.lxd-office-resume-request/v1",
			intentId,
			binding,
			request: bootIntent,
			powerOffRequestSha256: shutdown.seedSha256,
			hostBootId: shutdown.hostBootId,
			startCommandId: resume.startCommandId,
		}) ||
		!isDeepStrictEqual(await read(`resume-completed-${previousSuffix}.json`), {
			schema: "qorpera.lxd-office-resume-completion/v1",
			intentId,
			allocationId,
			bootIntentId: bootIntent.bootIntentId,
			activationId,
			startCommandId: resume.startCommandId,
			bootObservationSha256,
		})
	)
		throw new Error("boot resume acknowledgement differs");

	const original = await readLxdOfficeInitialActivationHistory(root, intentId, binding, read, client, signal);
	if (
		original.command.bootId !== shutdown.originalBootId ||
		original.request.attestation.preparationObservationSha256 !== attestation.preparationObservationSha256 ||
		original.request.configuration.preparation.requestSha256 !== configuration.originPreparationSha256
	)
		throw new Error("boot origin differs");
	if (successor.predecessor.startup.bootId === original.command.bootId) {
		const predecessor = await readLxdOfficeActivationHistory(
			root,
			intentId,
			binding,
			successor.predecessor.activationId,
			read,
			client,
			signal,
		);
		if (
			predecessor.completion.serviceInvocationId !== successor.predecessor.startup.serviceInvocationId ||
			predecessor.command.bootId !== successor.predecessor.startup.bootId ||
			predecessor.completion.configurationSha256 !== successor.predecessor.startup.configurationSha256
		)
			throw new Error("boot predecessor differs");
	}
	const vm = await LxdOfficeOperationJournal.open(root, intentId, binding, client, true);
	await vm.assertRetainedLifecycleSequence(
		[...shutdown.commands, { commandId: resume.startCommandId, action: "start" }],
		signal,
	);
	if (
		!isDeepStrictEqual(await vm.observe(shutdown.stopCommandId, "stop", signal), {
			state: "succeeded",
			operationId: shutdown.stopOperationId,
		}) ||
		!isDeepStrictEqual(await vm.observe(resume.startCommandId, "start", signal), {
			state: "succeeded",
			operationId: resume.operationId,
		})
	)
		throw new Error("boot VM operation differs");
	const index = officeRecord(await read(`boot-configuration-intent-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"bootIntentId",
			"activationId",
			"bootId",
			"bootObservationSha256",
			"originPreparationSha256",
			"serviceBootstrapSha256",
			"serviceBootstrapPath",
			"requestSha256",
			"requestBytes",
			"commandId",
		]),
		observation = officeRecord(await read(`boot-configuration-observation-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"bootIntentId",
			"activationId",
			"bootId",
			"resumeStartCommandId",
			"bootObservationSha256",
			"commandId",
			"requestSha256",
			"operationId",
			"serviceBootstrapSha256",
			"completionSha256",
			"completion",
		]);
	const serviceBootstrapSha256 = officeSha(index.serviceBootstrapSha256);
	if (
		typeof index.serviceBootstrapPath !== "string" ||
		!index.serviceBootstrapPath.startsWith("/") ||
		!Number.isSafeInteger(index.requestBytes) ||
		(index.requestBytes as number) < 1 ||
		(index.requestBytes as number) > COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES ||
		!isDeepStrictEqual(index, {
			schema: "qorpera.lxd-office-boot-configuration-intent/v1",
			intentId,
			allocationId,
			bootIntentId: bootIntent.bootIntentId,
			activationId,
			bootId: command.bootId,
			bootObservationSha256,
			originPreparationSha256: configuration.originPreparationSha256,
			serviceBootstrapSha256,
			serviceBootstrapPath: index.serviceBootstrapPath,
			requestSha256: configuration.command.requestSha256,
			requestBytes: index.requestBytes,
			commandId: configuration.command.commandId,
		}) ||
		!isDeepStrictEqual(observation, {
			schema: "qorpera.lxd-office-boot-configuration-observation/v1",
			intentId,
			allocationId,
			bootIntentId: bootIntent.bootIntentId,
			activationId,
			bootId: command.bootId,
			resumeStartCommandId: resume.startCommandId,
			bootObservationSha256,
			commandId: configuration.command.commandId,
			requestSha256: configuration.command.requestSha256,
			operationId: observation.operationId,
			serviceBootstrapSha256,
			completionSha256: request.configurationCompletionSha256,
			completion: configuration,
		}) ||
		officeDigest(observation) !== configurationObservationSha256 ||
		!isDeepStrictEqual(await read(`boot-configuration-completed-${suffix}.json`), {
			schema: "qorpera.lxd-office-boot-configuration-completion/v1",
			intentId,
			allocationId,
			bootIntentId: bootIntent.bootIntentId,
			activationId,
			commandId: configuration.command.commandId,
			observationSha256: configurationObservationSha256,
		})
	)
		throw new Error("boot configuration acknowledgement differs");
	parseCompanyComputerPreparationCommand({ ...command, commandId: observation.operationId });
	if (
		!client.submitOfficeBootConfiguration ||
		!client.inspectOfficeBootConfiguration ||
		!client.submitOfficeBootServiceStart ||
		!client.inspectOfficeBootServiceStart
	)
		throw new Error("boot observation client unavailable");
	const configured = await openLxdOfficeBootConfigurationJournal(
		root,
		{
			intentId,
			binding,
			bootIntentId: bootIntent.bootIntentId,
			activationId,
			originPreparationSha256: configuration.originPreparationSha256,
			bootObservationSha256,
			command: configuration.command,
		},
		{
			submitOfficeBootConfiguration: client.submitOfficeBootConfiguration.bind(client),
			inspectOfficeBootConfiguration: client.inspectOfficeBootConfiguration.bind(client),
		},
	);
	if (
		!isDeepStrictEqual(await configured.observe(signal), { state: "succeeded", operationId: observation.operationId })
	)
		throw new Error("boot configuration operation differs");
	const identity = {
		intentId,
		binding,
		bootObservationSha256,
		configurationObservationSha256,
		bootIntentId: bootIntent.bootIntentId,
		activationId,
		command,
	};
	if (
		!isDeepStrictEqual(await read(`boot-service-start-intent-${suffix}.json`), {
			schema: "qorpera.lxd-office-boot-service-start-intent/v1",
			requestSha256: officeDigest(packet),
			identity,
		})
	)
		throw new Error("boot start index differs");
	const journal = await openLxdOfficeBootServiceStartJournal(root, identity, {
			submitOfficeBootServiceStart: client.submitOfficeBootServiceStart.bind(client),
			inspectOfficeBootServiceStart: client.inspectOfficeBootServiceStart.bind(client),
		}),
		operation = await journal.observe(signal);
	if (operation.state === "not_dispatched") throw new Error("boot start not dispatched");
	const marker = officeRecord(await read(`boot-successor-completed-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"activationId",
			"bootIntentId",
			"bootId",
			"commandId",
			"configurationObservationSha256",
			"predecessorActivationId",
			"completion",
			"requestSha256",
			...(operation.operationId ? ["operationId"] : []),
		]),
		completion = parseCompanyComputerBootServiceStartCompletion(marker.completion, command, request),
		configurationCommandIds = [
			configuration.command.commandId,
			original.request.configuration.preparation.commandId,
			resume.startCommandId,
			shutdown.stopCommandId,
			shutdown.history.command.commandId,
		];
	if (
		configurationCommandIds.includes(command.commandId) ||
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-boot-successor-completion/v1",
			intentId,
			allocationId,
			activationId,
			bootIntentId: bootIntent.bootIntentId,
			bootId: command.bootId,
			commandId: command.commandId,
			configurationObservationSha256,
			predecessorActivationId: successor.predecessor.activationId,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
			completion,
			requestSha256: command.requestSha256,
		})
	)
		throw new Error("boot activation acknowledgement differs");
	signal.throwIfAborted();
	return {
		kind: "boot" as const,
		initial: false,
		request,
		command,
		completion,
		marker,
		bootObservationSha256,
		hostBootId: resume.hostBootId,
		bootIntent,
		configurationCommandIds,
	};
}
