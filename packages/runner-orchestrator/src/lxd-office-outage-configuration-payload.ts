import { createHash } from "node:crypto";
import {
	type CompanyComputerOutageRecovery,
	type CompanyComputerOutageResumeObservation,
	type CompanyComputerOutageTerminationAcknowledgement,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	companyComputerBootAdoptionReceiptPath,
	companyComputerOutageAdoptionReceipt,
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageResumeObservationCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerOutageConfigurationRequest,
} from "@qorpera/contracts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical } from "./lxd-office-image-provenance.ts";
import { createLxdOfficeConfigurationPayload } from "./lxd-office-service-bootstrap.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** Same protected credential loader as first boot, with an explicitly typed
 * abrupt-termination origin. Caller must wipe confidential returned buffers. */
export async function createLxdOfficeOutageConfigurationPayload(
	path: string,
	binding: LxdOfficeGuestBinding,
	original: CompanyComputerPreparationRequest,
	preparation: CompanyComputerPreparationCommand,
	recovery: CompanyComputerOutageRecovery,
	observation: CompanyComputerOutageResumeObservation,
	termination: CompanyComputerOutageTerminationAcknowledgement,
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
		const bootObservationSha256 = hash(companyComputerOutageResumeObservationCanonical(observation, recovery));
		const receipt = companyComputerOutageAdoptionReceipt(
			original,
			preparation.requestSha256,
			hash(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
			recovery,
			observation,
			termination,
			bootObservationSha256,
			hash(companyComputerOutageTerminationAcknowledgementCanonical(termination)),
		);
		const receiptBytes = Buffer.from(`${companyComputerOutageAdoptionReceiptCanonical(receipt)}\n`),
			adoptionReceiptSha256 = hash(receiptBytes);
		const configuration = JSON.parse(material.configuration);
		Object.assign(configuration.linux.attestation, {
			bootId: observation.bootId,
			adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(observation.bootId),
			adoptionReceiptSha256,
		});
		const body = parseCompanyComputerOutageConfigurationRequest({
			schema: "qorpera.office-outage-configuration-request/v1",
			originPreparationSha256: preparation.requestSha256,
			recovery,
			observation,
			termination,
			material: { ...material, configuration: JSON.stringify(configuration) },
		});
		signal.throwIfAborted();
		return {
			body,
			bytes: Buffer.from(officeCanonical(body)),
			receiptBytes,
			adoptionReceiptSha256,
			bootObservationSha256,
			serviceBootstrapSha256: source.planBytesSha256,
		};
	} finally {
		source.bytes.fill(0);
	}
}
