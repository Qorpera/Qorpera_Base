import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerBootConfigurationCompletion,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerBootConfigurationCompletion,
	parseCompanyComputerBootIntent,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResumeObservation,
} from "@qorpera/contracts";
import type { LxdOfficeBootConfigurationClient, LxdOfficePreparationClient } from "./lxd-client.ts";
import { openLxdOfficeBootConfigurationJournal } from "./lxd-office-boot-configuration-journal.ts";
import { createLxdOfficeBootConfigurationPayload } from "./lxd-office-boot-configuration-payload.ts";
import type { LxdOfficeBootConfigurationRequest } from "./lxd-office-boot-configuration-worker.ts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { readLxdOfficePowerOffEvidence } from "./lxd-office-power-off-evidence.ts";
import { LxdOfficePreparationJournal } from "./lxd-office-preparation-journal.ts";
import { readLxdOfficePreparationRecovery } from "./lxd-office-preparation-recovery.ts";
import { officeStopHash as hash } from "./lxd-office-stop-evidence.ts";

export type LxdOfficeBootActivationEvidenceClient = LxdOfficeBootConfigurationClient & LxdOfficePreparationClient;
/** Read acknowledged resume/configuration without any boot-intent authority
 * call, reconcile, publication or guest effect. This remains usable after SQL
 * admits the intent. Callers separately require current physical/SQL authority
 * and independent guest readback before service dispatch or activation. */
export async function readLxdOfficeBootActivationEvidence(
	root: string,
	input: LxdOfficeBootConfigurationRequest,
	creation: LxdOfficeCreationIdentity,
	client: LxdOfficeBootActivationEvidenceClient,
	signal: AbortSignal,
	ports: Parameters<typeof createLxdOfficeBootConfigurationPayload>[8] = {},
) {
	const request = parseCompanyComputerBootIntentRequest(input.request),
		{ intentId, binding } = creation,
		{ allocationId } = binding,
		suffix = `${allocationId}-${request.predecessor.transitionId}`;
	if (input.intentId !== intentId) throw new Error("creation differs");
	const records: Record<string, string> = {};
	const read = async (name: string, limit = 65536) => {
		signal.throwIfAborted();
		const file = await readRecord(join(root, name), limit);
		records[name] = hash(file.bytes);
		return file;
	};
	const resumeMarker = await read(`resume-completed-${suffix}.json`),
		resumeSeed = await read(`resume-request-${suffix}.json`),
		bootIntent = parseCompanyComputerBootIntent((await read(`resume-prepared-${suffix}.json`)).value, request),
		resume = parseCompanyComputerResumeObservation((await read(`resume-observation-${suffix}.json`)).value, request),
		shutdown = await readLxdOfficePowerOffEvidence(root, creation, request, signal);
	if (
		bootIntent.state !== "prepared" ||
		!isDeepStrictEqual(resumeSeed.value, {
			schema: "qorpera.lxd-office-resume-request/v1",
			intentId,
			binding,
			request,
			powerOffRequestSha256: shutdown.seedSha256,
			hostBootId: shutdown.hostBootId,
			startCommandId: resume.startCommandId,
		}) ||
		resume.intentId !== intentId ||
		shutdown.bootIds.includes(resume.bootId) ||
		resume.hostBootId !== shutdown.hostBootId ||
		resume.requestSha256 !== officeDigest(resumeSeed.value) ||
		!isDeepStrictEqual(resumeMarker.value, {
			schema: "qorpera.lxd-office-resume-completion/v1",
			intentId,
			allocationId,
			bootIntentId: request.bootIntentId,
			activationId: request.activationId,
			startCommandId: resume.startCommandId,
			bootObservationSha256: officeDigest(resume),
		})
	)
		throw new Error("resume acknowledgement differs");
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
		throw new Error("VM sequence unconfirmed");
	const originalFile = await read(`preparation-request-${allocationId}.json`, COMPANY_COMPUTER_PREPARATION_MAX_BYTES),
		original = parseCompanyComputerPreparationRequest(originalFile.value),
		prep = officeRecord((await read(`preparation-observation-${allocationId}.json`)).value, [
			"schema",
			"intentId",
			"allocationId",
			"commandId",
			"bootId",
			"requestSha256",
			"operationId",
			"bootObservationSha256",
			"copySha256",
			"completionSha256",
			"adoptionReceiptPath",
			"adoptionReceiptSha256",
			"completion",
		]),
		preparation = parseCompanyComputerPreparationCommand({
			commandId: prep.commandId,
			bootId: prep.bootId,
			requestSha256: prep.requestSha256,
		}),
		preparationObservationSha256 = officeDigest(prep),
		originalReceiptSha256 = hash(
			Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
		);
	if (
		prep.schema !== "qorpera.lxd-office-preparation-observation/v1" ||
		prep.intentId !== intentId ||
		prep.allocationId !== allocationId ||
		preparation.requestSha256 !== hash(originalFile.bytes) ||
		original.bootId !== preparation.bootId ||
		original.bootId !== shutdown.originalBootId ||
		prep.adoptionReceiptPath !== "/etc/qorpera-office/adoption.json" ||
		prep.adoptionReceiptSha256 !== originalReceiptSha256 ||
		prep.bootObservationSha256 !== officeDigest((await read(`boot-observation-${allocationId}.json`)).value) ||
		!isDeepStrictEqual((await read(`preparation-completed-${allocationId}.json`)).value, {
			schema: "qorpera.lxd-office-preparation-completion/v1",
			allocationId,
			commandId: preparation.commandId,
			observationSha256: preparationObservationSha256,
		})
	)
		throw new Error("original preparation differs");
	const complete = officeRecord(prep.completion, [
		"schema",
		"command",
		"invocationId",
		"reportSha256",
		"adoptionReceiptSha256",
		"report",
	]);
	parseCompanyComputerPreparationCompletion(complete, original, {
		commandId: preparation.commandId,
		requestSha256: preparation.requestSha256,
		contentSha256: hash(Buffer.from(JSON.stringify(original.entries))),
		reportSha256: officeSha(complete.reportSha256),
		adoptionReceiptSha256: originalReceiptSha256,
	});
	const preparedJournal = await LxdOfficePreparationJournal.open(
		root,
		{ intentId, binding, bootObservationSha256: officeSha(prep.bootObservationSha256), command: preparation },
		client,
	);
	const recovery = await readLxdOfficePreparationRecovery(
		root,
		{ intentId, binding, bootObservationSha256: officeSha(prep.bootObservationSha256), command: preparation },
		client,
		signal,
		await preparedJournal.observe(signal),
		undefined,
		ports.readProtected,
	);
	if (!isDeepStrictEqual(recovery.operation, { state: "succeeded", operationId: prep.operationId }))
		throw new Error("preparation operation unconfirmed");
	const power = await read(`power-off-completed-${suffix}.json`),
		payload = await createLxdOfficeBootConfigurationPayload(
			input.serviceBootstrapPath,
			binding,
			original,
			preparation,
			bootIntent,
			resume,
			new TextDecoder("utf8", { fatal: true }).decode(power.bytes),
			signal,
			ports,
		);
	try {
		const name = `${allocationId}-${request.activationId}`,
			index = officeRecord((await read(`boot-configuration-intent-${name}.json`)).value, [
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
			command = parseCompanyComputerPreparationCommand({
				commandId: index.commandId,
				bootId: resume.bootId,
				requestSha256: hash(payload.bytes),
			});
		if (
			!isDeepStrictEqual(index, {
				schema: "qorpera.lxd-office-boot-configuration-intent/v1",
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				bootId: resume.bootId,
				bootObservationSha256: payload.bootObservationSha256,
				originPreparationSha256: preparation.requestSha256,
				serviceBootstrapSha256: payload.serviceBootstrapSha256,
				serviceBootstrapPath: input.serviceBootstrapPath,
				requestSha256: command.requestSha256,
				requestBytes: payload.bytes.length,
				commandId: command.commandId,
			}) ||
			[
				preparation.commandId,
				resume.startCommandId,
				shutdown.stopCommandId,
				shutdown.history.command.commandId,
			].includes(command.commandId)
		)
			throw new Error("boot configuration identity differs");
		const observation = officeRecord((await read(`boot-configuration-observation-${name}.json`)).value, [
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
		const files = Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
				const bytes = Buffer.from(payload.body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
				try {
					return [file, { bytes: bytes.length, sha256: hash(bytes) }];
				} finally {
					bytes.fill(0);
				}
			}),
		) as CompanyComputerBootConfigurationCompletion["files"];
		const configuration = parseCompanyComputerBootConfigurationCompletion(observation.completion, {
				schema: "qorpera.office-boot-configuration-completion/v1",
				command,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				originPreparationSha256: preparation.requestSha256,
				adoptionReceiptSha256: payload.adoptionReceiptSha256,
				bootObservationSha256: payload.bootObservationSha256,
				files,
			}),
			configurationCompletionSha256 = officeSha(observation.completionSha256),
			configurationObservationSha256 = officeDigest(observation);
		parseCompanyComputerPreparationCommand({ ...command, commandId: observation.operationId });
		if (
			!isDeepStrictEqual(observation, {
				schema: "qorpera.lxd-office-boot-configuration-observation/v1",
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				bootId: resume.bootId,
				resumeStartCommandId: resume.startCommandId,
				bootObservationSha256: payload.bootObservationSha256,
				commandId: command.commandId,
				requestSha256: command.requestSha256,
				operationId: observation.operationId,
				serviceBootstrapSha256: payload.serviceBootstrapSha256,
				completionSha256: configurationCompletionSha256,
				completion: configuration,
			}) ||
			!isDeepStrictEqual((await read(`boot-configuration-completed-${name}.json`)).value, {
				schema: "qorpera.lxd-office-boot-configuration-completion/v1",
				intentId,
				allocationId,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				commandId: command.commandId,
				observationSha256: configurationObservationSha256,
			})
		)
			throw new Error("configuration acknowledgement differs");
		const journal = await openLxdOfficeBootConfigurationJournal(
			root,
			{
				intentId,
				binding,
				bootIntentId: request.bootIntentId,
				activationId: request.activationId,
				originPreparationSha256: preparation.requestSha256,
				bootObservationSha256: payload.bootObservationSha256,
				command,
			},
			client,
		);
		if (
			!isDeepStrictEqual(await journal.observe(signal), { state: "succeeded", operationId: observation.operationId })
		)
			throw new Error("configuration operation unconfirmed");
		const config = JSON.parse(payload.body.material.configuration);
		signal.throwIfAborted();
		return {
			records,
			preparationRecoverySha256: recovery.recoveryBytes ? hash(recovery.recoveryBytes) : null,
			configuration,
			configurationCompletionSha256,
			preparationObservationSha256,
			configurationObservationSha256,
			bootObservationSha256: payload.bootObservationSha256,
			hostBootId: resume.hostBootId,
			bootId: resume.bootId,
			resumeStartCommandId: resume.startCommandId,
			preparationCommandId: preparation.commandId,
			shutdown,
			stopAcknowledgedAtMs: bootIntent.stopAcknowledgedAtMs,
			officeRevision: bootIntent.officeRevision,
			privacyVersion: bootIntent.privacyVersion,
			receiptBytes: payload.receiptBytes,
			nativePort: config.native.port as number,
			viewerPort: config.viewer.port as number,
		};
	} finally {
		payload.bytes.fill(0);
	}
}
