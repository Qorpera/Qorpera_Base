import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerConfigurationCompletion,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerConfigurationCompletion,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import type { LxdOfficeConfigurationClient } from "./lxd-client.ts";
import { planLxdOfficeAdoption } from "./lxd-office-adoption-plan.ts";
import { LxdOfficeConfigurationJournal } from "./lxd-office-configuration-journal.ts";
import type { LxdOfficeConfigurationRequest } from "./lxd-office-configuration-worker.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import type { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { LxdOfficePreparationJournal } from "./lxd-office-preparation-journal.ts";
import { readLxdOfficePreparationRecovery } from "./lxd-office-preparation-recovery.ts";
import { createLxdOfficeConfigurationPayload } from "./lxd-office-service-bootstrap.ts";
import type { LxdOfficeAdoptionMapping } from "./lxd-office-start-control.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Reads acknowledged historical evidence and derives exact configuration from
 * protected provider sources. It never reconciles preparation, inspects copied
 * working files or invokes any guest effect, so active work may change those
 * files. The worker separately checks live physical/cloud/boot/file authority. */
export async function readLxdOfficeActivationEvidence(
	root: string,
	input: LxdOfficeConfigurationRequest,
	binding: LxdOfficeGuestBinding,
	client: LxdOfficeConfigurationClient,
	signal: AbortSignal,
	ports: {
		readProtected?: typeof readLxdOfficeProtectedFile;
		readCredential?: typeof readLxdOfficeCredentialFile;
	} = {},
) {
	const allocationId = binding.allocationId;
	const records: Record<string, string> = {};
	const read = async (name: string, limit = 16384) => {
		signal.throwIfAborted();
		const file = await readRecord(join(root, name), limit);
		records[name] = hash(file.bytes);
		return file;
	};
	const prepObservation = officeRecord((await read(`preparation-observation-${allocationId}.json`, 65536)).value, [
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
	]);
	const preparationObservationSha256 = officeDigest(prepObservation);
	const preparation = parseCompanyComputerPreparationCommand({
		commandId: prepObservation.commandId,
		requestSha256: prepObservation.requestSha256,
		bootId: prepObservation.bootId,
	});
	if (
		prepObservation.schema !== "qorpera.lxd-office-preparation-observation/v1" ||
		prepObservation.intentId !== input.intentId ||
		prepObservation.allocationId !== allocationId ||
		!isDeepStrictEqual((await read(`preparation-completed-${allocationId}.json`)).value, {
			schema: "qorpera.lxd-office-preparation-completion/v1",
			allocationId,
			commandId: preparation.commandId,
			observationSha256: preparationObservationSha256,
		})
	)
		throw new Error("preparation acknowledgement");
	const requestFile = await read(`preparation-request-${allocationId}.json`, COMPANY_COMPUTER_PREPARATION_MAX_BYTES);
	if (hash(requestFile.bytes) !== preparation.requestSha256) throw new Error("request changed");
	const preparedRequest = parseCompanyComputerPreparationRequest(requestFile.value);
	const bootObservationSha256 = officeSha(prepObservation.bootObservationSha256);
	const prepJournal = await LxdOfficePreparationJournal.open(
		root,
		{ intentId: input.intentId, binding, bootObservationSha256, command: preparation },
		client,
	);
	const recovery = await readLxdOfficePreparationRecovery(
		root,
		{ intentId: input.intentId, binding, bootObservationSha256, command: preparation },
		client,
		signal,
		await prepJournal.observe(signal),
		input.reviewPath,
		ports.readProtected,
	);
	if (!isDeepStrictEqual(recovery.operation, { state: "succeeded", operationId: prepObservation.operationId }))
		throw new Error("preparation operation");
	const receipt = companyComputerPreparationAdoptionReceipt(preparedRequest);
	const receiptSha256 = hash(`${JSON.stringify(receipt)}\n`);
	const completePrep = officeRecord(prepObservation.completion, [
		"schema",
		"command",
		"invocationId",
		"reportSha256",
		"adoptionReceiptSha256",
		"report",
	]);
	parseCompanyComputerPreparationCompletion(completePrep, preparedRequest, {
		commandId: preparation.commandId,
		requestSha256: preparation.requestSha256,
		contentSha256: hash(JSON.stringify(preparedRequest.entries)),
		reportSha256: officeSha(completePrep.reportSha256),
		adoptionReceiptSha256: receiptSha256,
	});
	if (
		prepObservation.adoptionReceiptSha256 !== receiptSha256 ||
		prepObservation.adoptionReceiptPath !== COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH
	)
		throw new Error("adoption receipt");
	const inventory = (
		await read(`inventory-${officeSha(input.observationSha256)}.json`, COMPANY_COMPUTER_PREPARATION_MAX_BYTES + 4096)
	).value as LxdOfficeStorageObservation;
	if (officeDigest(inventory) !== input.observationSha256 || inventory.intentId !== input.intentId)
		throw new Error("inventory changed");
	const plan = planLxdOfficeAdoption(input.input, binding, inventory);
	if (preparedRequest.copy.planSha256 !== officeDigest(plan)) throw new Error("adoption plan changed");
	const mappings: LxdOfficeAdoptionMapping[] = plan.screens.map((screen) => ({
		binding: screen.binding,
		browserProfile: screen.browser.disposition === "adopt" ? screen.browser.grant : null,
	}));
	const observation = officeRecord((await read(`configuration-observation-${allocationId}.json`)).value, [
		"schema",
		"intentId",
		"allocationId",
		"commandId",
		"bootId",
		"requestSha256",
		"operationId",
		"bootObservationSha256",
		"preparationObservationSha256",
		"serviceBootstrapSha256",
		"completionSha256",
		"completion",
	]);
	const configurationObservationSha256 = officeDigest(observation);
	const command = parseCompanyComputerPreparationCommand({
		commandId: observation.commandId,
		bootId: observation.bootId,
		requestSha256: observation.requestSha256,
	});
	if (
		observation.schema !== "qorpera.lxd-office-configuration-observation/v1" ||
		observation.intentId !== input.intentId ||
		observation.allocationId !== allocationId ||
		observation.bootObservationSha256 !== bootObservationSha256 ||
		observation.preparationObservationSha256 !== preparationObservationSha256 ||
		!isDeepStrictEqual((await read(`configuration-completed-${allocationId}.json`)).value, {
			schema: "qorpera.lxd-office-configuration-completion/v1",
			allocationId,
			commandId: command.commandId,
			observationSha256: configurationObservationSha256,
		})
	)
		throw new Error("configuration acknowledgement");
	const journal = await LxdOfficeConfigurationJournal.open(
		root,
		{ intentId: input.intentId, binding, bootObservationSha256, preparationObservationSha256, command },
		client,
	);
	if (!isDeepStrictEqual(await journal.observe(signal), { state: "succeeded", operationId: observation.operationId }))
		throw new Error("configuration operation");
	const payload = await createLxdOfficeConfigurationPayload(
		input.serviceBootstrapPath,
		binding,
		preparedRequest,
		preparation,
		signal,
		ports,
	);
	try {
		if (
			hash(payload.bytes) !== command.requestSha256 ||
			payload.planBytesSha256 !== observation.serviceBootstrapSha256
		)
			throw new Error("configuration source changed");
		const body = parseCompanyComputerConfigurationRequest(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(payload.bytes)),
		);
		const files = Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
				const bytes = body[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES];
				return [file, { bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }];
			}),
		) as CompanyComputerConfigurationCompletion["files"];
		const configuration = parseCompanyComputerConfigurationCompletion(observation.completion, {
			schema: "qorpera.office-configuration-completion/v1",
			command,
			preparation,
			preparationCompletionSha256: officeSha(prepObservation.completionSha256),
			adoptionReceiptSha256: receiptSha256,
			files,
		});
		if (
			!isDeepStrictEqual((await read(`configuration-intent-${allocationId}.json`)).value, {
				schema: "qorpera.lxd-office-configuration-intent/v1",
				intentId: input.intentId,
				allocationId,
				bootId: preparation.bootId,
				bootObservationSha256,
				preparationObservationSha256,
				serviceBootstrapSha256: payload.planBytesSha256,
				requestSha256: command.requestSha256,
				requestBytes: payload.bytes.length,
				commandId: command.commandId,
			})
		)
			throw new Error("configuration identity");
		signal.throwIfAborted();
		return {
			records,
			preparationRecoverySha256: recovery.recoveryBytes ? hash(recovery.recoveryBytes) : null,
			configuration,
			configurationCompletionSha256: officeSha(observation.completionSha256),
			preparationObservationSha256,
			configurationObservationSha256,
			bootObservationSha256,
			hostBootId: inventory.hostBootId,
			mappings,
			preparedRequest,
			nativePort: payload.plan.native.port,
			viewerPort: payload.plan.viewer.port,
		};
	} finally {
		payload.bytes.fill(0);
	}
}
