import { createHash } from "node:crypto";
import {
	type CompanyComputerBootIntent,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	type CompanyComputerResumeObservation,
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResumeObservationCanonical,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerConfigurationRequest,
} from "@qorpera/contracts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { createLxdOfficeConfigurationPayload } from "./lxd-office-service-bootstrap.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Resolve protected sources through the original configuration loader, then
 * derive only the new boot attestation. The actual historical preparation
 * command and receipt remain unchanged. Caller must wipe returned bytes. */
export async function createLxdOfficeBootConfigurationPayload(
	path: string,
	binding: LxdOfficeGuestBinding,
	original: CompanyComputerPreparationRequest,
	preparation: CompanyComputerPreparationCommand,
	bootIntent: CompanyComputerBootIntent,
	observation: CompanyComputerResumeObservation,
	powerOffCompletion: string,
	signal: AbortSignal,
	ports: Parameters<typeof createLxdOfficeConfigurationPayload>[5] = {},
) {
	const source = await createLxdOfficeConfigurationPayload(path, binding, original, preparation, signal, ports);
	try {
		const {
			schema: _schema,
			preparation: _preparation,
			...material
		} = parseCompanyComputerConfigurationRequest(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(source.bytes)),
		);
		if (hash(powerOffCompletion) !== bootIntent.request.powerOffCompletionSha256) throw new Error("shutdown changed");
		const bootObservationSha256 = hash(companyComputerResumeObservationCanonical(observation, bootIntent.request)),
			receipt = companyComputerBootAdoptionReceipt(
				original,
				preparation.requestSha256,
				hash(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
				bootIntent.request,
				observation,
				bootObservationSha256,
			),
			receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`),
			adoptionReceiptSha256 = hash(receiptBytes);
		const configuration = JSON.parse(material.configuration);
		Object.assign(configuration.linux.attestation, {
			bootId: observation.bootId,
			adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(observation.bootId),
			adoptionReceiptSha256,
		});
		const body = parseCompanyComputerBootConfigurationRequest({
			schema: "qorpera.office-boot-configuration-request/v1",
			originPreparationSha256: preparation.requestSha256,
			bootIntent,
			observation,
			powerOffCompletion,
			material: { ...material, configuration: JSON.stringify(configuration) },
		});
		signal.throwIfAborted();
		return {
			body,
			bytes: Buffer.from(JSON.stringify(body)),
			receiptBytes,
			adoptionReceiptSha256,
			bootObservationSha256,
			serviceBootstrapSha256: source.planBytesSha256,
		};
	} finally {
		source.bytes.fill(0);
	}
}
