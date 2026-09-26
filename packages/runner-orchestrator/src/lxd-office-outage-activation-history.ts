import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES,
	companyComputerOutageResumeObservationCanonical,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageResumeObservation,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageSuccessor,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import type { LxdOfficeOutageConfigurationClient, LxdOfficeOutageServiceStartClient } from "./lxd-client.ts";
import { readLxdOfficeInitialActivationHistory } from "./lxd-office-activation-history.ts";
import type { LxdOfficeRetainedActivationHistoryClient } from "./lxd-office-boot-restart-history.ts";
import { LxdOfficeControlJournal } from "./lxd-office-control-journal.ts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { readRecord } from "./lxd-office-journal-files.ts";
import { readLxdOfficeOutageVmLineage } from "./lxd-office-outage-history.ts";
import { officeStopHash } from "./lxd-office-stop-evidence.ts";

export type LxdOfficeOutageActivationHistoryClient = LxdOfficeRetainedActivationHistoryClient &
	Partial<LxdOfficeOutageConfigurationClient & LxdOfficeOutageServiceStartClient>;

/** Historical, bounded evidence for an already admitted outage successor.
 * The external stop remains its own immutable bridge; this reader cannot
 * create a graceful stop, renew funding, or dispatch a guest command. */
export async function readLxdOfficeOutageActivationHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeOutageActivationHistoryClient,
	signal: AbortSignal,
) {
	const read = async (name: string) => (await readSource(name)).value,
		{ allocationId } = binding,
		suffix = `${allocationId}-${activationId}`,
		packet = officeRecord(await read(`outage-service-start-request-${suffix}.json`), [
			"schema",
			"intentId",
			"binding",
			"command",
			"request",
		]),
		request = parseCompanyComputerOutageServiceStartRequest(packet.request),
		command = parseCompanyComputerPreparationCommand(packet.command),
		successor = request.successor.request,
		base = successor.recovery,
		{ attestation } = successor,
		configuration = request.configuration,
		configurationObservationSha256 = attestation.configurationObservationSha256;
	if (
		!isDeepStrictEqual(packet, {
			schema: "qorpera.lxd-office-outage-service-start-request/v1",
			intentId,
			binding,
			command,
			request,
		}) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request))) ||
		command.bootId !== attestation.bootId ||
		attestation.activationId !== activationId
	)
		throw new Error("outage activation packet differs");
	if (
		!isDeepStrictEqual(await read(`outage-successor-request-${suffix}.json`), {
			schema: "qorpera.lxd-office-outage-successor-request/v1",
			intentId,
			binding,
			request: successor,
			configurationObservationSha256,
		}) ||
		!isDeepStrictEqual(await read(`outage-successor-prepared-${suffix}.json`), request.successor)
	)
		throw new Error("outage successor preparation differs");
	const recoverySuffix = `${allocationId}-${base.recoveryId}`,
		recovery = parseCompanyComputerOutageRecovery(await read(`outage-prepared-${recoverySuffix}.json`), base),
		observation = parseCompanyComputerOutageResumeObservation(
			await read(`outage-observation-${recoverySuffix}.json`),
			recovery,
		),
		bootObservationSha256 = officeStopHash(
			Buffer.from(companyComputerOutageResumeObservationCanonical(observation, recovery)),
		);
	if (
		observation.intentId !== intentId ||
		observation.bootId !== command.bootId ||
		request.successor.officeRevision !== successor.termination.officeRevision ||
		request.successor.privacyVersion !== recovery.privacyVersion ||
		bootObservationSha256 !== configuration.bootObservationSha256 ||
		!isDeepStrictEqual(await read(`outage-termination-acknowledgement-${recoverySuffix}.json`), successor.termination)
	)
		throw new Error("outage termination acknowledgement differs");
	const creationValue = officeRecord(await read(`intent-${intentId}.json`), [
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
	if (!isDeepStrictEqual(creationValue, creation)) throw new Error("outage creation differs");
	const lineage = await readLxdOfficeOutageVmLineage(root, creation),
		segment = lineage.segments.find((item) => item.bridge?.request.recoveryId === base.recoveryId);
	if (
		!segment?.bridge ||
		!isDeepStrictEqual(segment.bridge.request, base) ||
		!isDeepStrictEqual(segment.bridge.predecessor, recovery.predecessor) ||
		officeDigest(segment.bridge.bridge) !== observation.requestSha256 ||
		segment.bridge.proof.stopReceipt.closedHostBootId !== observation.hostBootId ||
		segment.bridge.proof.physicalInstanceId !== observation.physicalInstanceId ||
		segment.history.events[2]?.operationId !== observation.operationId ||
		segment.history.events[2]?.state !== "succeeded"
	)
		throw new Error("outage VM lineage differs");
	const original = await readLxdOfficeInitialActivationHistory(root, intentId, binding, read, client, signal);
	if (original.request.configuration.preparation.requestSha256 !== configuration.originPreparationSha256)
		throw new Error("outage preparation origin differs");
	const index = officeRecord(await read(`outage-configuration-intent-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"recoveryId",
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
		configured = officeRecord(await read(`outage-configuration-observation-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"recoveryId",
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
		]),
		serviceBootstrapSha256 = officeSha(index.serviceBootstrapSha256);
	if (
		typeof index.serviceBootstrapPath !== "string" ||
		!index.serviceBootstrapPath.startsWith("/") ||
		!Number.isSafeInteger(index.requestBytes) ||
		(index.requestBytes as number) < 1 ||
		(index.requestBytes as number) > COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES ||
		!isDeepStrictEqual(index, {
			schema: "qorpera.lxd-office-outage-configuration-intent/v1",
			intentId,
			allocationId,
			recoveryId: base.recoveryId,
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
		!isDeepStrictEqual(configured, {
			schema: "qorpera.lxd-office-outage-configuration-observation/v1",
			intentId,
			allocationId,
			recoveryId: base.recoveryId,
			activationId,
			bootId: command.bootId,
			resumeStartCommandId: observation.startCommandId,
			bootObservationSha256,
			commandId: configuration.command.commandId,
			requestSha256: configuration.command.requestSha256,
			operationId: configured.operationId,
			serviceBootstrapSha256,
			completionSha256: request.configurationCompletionSha256,
			completion: configuration,
		}) ||
		officeDigest(configured) !== configurationObservationSha256 ||
		!isDeepStrictEqual(await read(`outage-configuration-completed-${suffix}.json`), {
			schema: "qorpera.lxd-office-outage-configuration-completion/v1",
			intentId,
			allocationId,
			recoveryId: base.recoveryId,
			activationId,
			commandId: configuration.command.commandId,
			observationSha256: configurationObservationSha256,
		})
	)
		throw new Error("outage configuration acknowledgement differs");
	parseCompanyComputerPreparationCommand({ ...command, commandId: configured.operationId });
	if (
		!client.submitOfficeOutageConfiguration ||
		!client.inspectOfficeOutageConfiguration ||
		!client.submitOfficeOutageServiceStart ||
		!client.inspectOfficeOutageServiceStart
	)
		throw new Error("outage history client unavailable");
	const configJournal = await LxdOfficeControlJournal.open(
		root,
		{
			intentId,
			binding,
			recoveryId: base.recoveryId,
			activationId,
			originPreparationSha256: configuration.originPreparationSha256,
			bootObservationSha256,
			command: configuration.command,
		},
		{
			submit: client.submitOfficeOutageConfiguration.bind(client),
			inspect: client.inspectOfficeOutageConfiguration.bind(client),
		},
		true,
		"outage-configuration",
	);
	if (
		!isDeepStrictEqual(await configJournal.observe(signal), {
			state: "succeeded",
			operationId: configured.operationId,
		})
	)
		throw new Error("outage configuration operation differs");
	const identity = {
		intentId,
		binding,
		bootObservationSha256,
		configurationObservationSha256,
		recoveryId: base.recoveryId,
		activationId,
		command,
	};
	if (
		!isDeepStrictEqual(await read(`outage-service-start-intent-${suffix}.json`), {
			schema: "qorpera.lxd-office-outage-service-start-intent/v1",
			requestSha256: officeDigest(packet),
			identity,
		})
	)
		throw new Error("outage start index differs");
	const operation = await (
		await LxdOfficeControlJournal.open(
			root,
			identity,
			{
				submit: client.submitOfficeOutageServiceStart.bind(client),
				inspect: client.inspectOfficeOutageServiceStart.bind(client),
			},
			true,
			"outage-service-start",
		)
	).observe(signal);
	if (operation.state === "not_dispatched") throw new Error("outage start not dispatched");
	const marker = officeRecord(await read(`outage-service-start-completed-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"activationId",
			"recoveryId",
			"bootId",
			"commandId",
			"configurationObservationSha256",
			"predecessorActivationId",
			"completion",
			"requestSha256",
			...(operation.operationId ? ["operationId"] : []),
		]),
		completion = parseCompanyComputerOutageServiceStartCompletion(marker.completion, command, request);
	if (
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-outage-service-start-completion/v1",
			intentId,
			allocationId,
			activationId,
			recoveryId: base.recoveryId,
			bootId: command.bootId,
			commandId: command.commandId,
			configurationObservationSha256,
			predecessorActivationId: recovery.predecessor.activationId,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
			completion,
			requestSha256: command.requestSha256,
		})
	)
		throw new Error("outage start acknowledgement differs");
	const activated = officeRecord(await read(`outage-activation-completed-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"recoveryId",
			"activationId",
			"startCommandId",
			"startObservationSha256",
			"activation",
		]),
		activation = parseCompanyComputerOutageSuccessor(activated.activation, successor);
	if (
		activation.state !== "active" ||
		activation.serviceInvocationId !== completion.serviceInvocationId ||
		!isDeepStrictEqual(activated, {
			schema: "qorpera.lxd-office-outage-activation-completion/v1",
			intentId,
			allocationId,
			recoveryId: base.recoveryId,
			activationId,
			startCommandId: command.commandId,
			startObservationSha256: officeDigest(marker),
			activation,
		})
	)
		throw new Error("outage admission acknowledgement differs");
	const configurationCommandIds = [
		configuration.command.commandId,
		original.request.configuration.preparation.commandId,
		observation.startCommandId,
		successor.termination.request.inspection.command.commandId,
	];
	if (configurationCommandIds.includes(command.commandId)) throw new Error("outage command identity reused");
	signal.throwIfAborted();
	return {
		kind: "outage" as const,
		initial: false as const,
		request,
		command,
		completion,
		marker,
		bootObservationSha256,
		hostBootId: observation.hostBootId,
		recovery,
		observation,
		configurationCommandIds,
	};
}
