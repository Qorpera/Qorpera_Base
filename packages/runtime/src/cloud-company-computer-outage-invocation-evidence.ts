import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerOutageTerminationAcknowledgementCanonical,
	parseCompanyComputerOutageAdoptionReceipt,
	parseCompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerOutageServiceStartCompletion,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import type { CompanyComputerProtectedEvidenceReader } from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Exact outage-born invocation evidence for a later ordinary stop/history.
 * Its origin remains explicitly forced termination, never a fabricated clean
 * predecessor. The reader can operate on a sealed public stop archive. */
export async function readCompanyComputerInitialOutageServiceInvocation(
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const directory = companyComputerBootDirectory(bootId),
		adoptionPath = companyComputerBootAdoptionReceiptPath(bootId),
		bytes = await read(`${root}/outage-service-start-completion.json`, 8192, 0o600),
		data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command),
		staged = await read(
			`${root}/outage-service-start-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_OUTAGE_SERVICE_START_MAX_BYTES,
			0o400,
		);
	if (hash(staged) !== command.requestSha256 || command.bootId !== bootId)
		throw new Error("outage invocation command differs");
	const request = parseCompanyComputerOutageServiceStartRequest(json(staged)),
		start = parseCompanyComputerOutageServiceStartCompletion(data, command, request),
		successor = request.successor.request,
		activationId = start.activationId,
		attestation = successor.attestation;
	if (
		!isDeepStrictEqual(json(await read(`${root}/outage-service-start-claim.json`, 4096, 0o600)), {
			schema: "qorpera.office-outage-service-start-claim/v1",
			command,
			recoveryId: successor.recovery.recoveryId,
			activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
		})
	)
		throw new Error("outage invocation claim differs");
	const configuredBytes = await read(`${directory}/configuration-completion.json`, 16384, 0o600);
	if (hash(configuredBytes) !== request.configurationCompletionSha256) throw new Error("outage configuration differs");
	const configured = parseCompanyComputerOutageConfigurationCompletion(json(configuredBytes), request.configuration);
	if (
		!isDeepStrictEqual(json(await read(`${directory}/configuration-claim.json`, 4096, 0o600)), {
			schema: "qorpera.office-outage-configuration-claim/v1",
			command: configured.command,
			recoveryId: successor.recovery.recoveryId,
			activationId,
		})
	)
		throw new Error("outage configuration claim differs");
	const receiptBytes = await read(adoptionPath, 65536, 0o444),
		receipt = parseCompanyComputerOutageAdoptionReceipt(json(receiptBytes));
	if (
		hash(receiptBytes) !== attestation.adoptionReceiptSha256 ||
		receipt.bootId !== bootId ||
		receipt.origin.preparationSha256 !== configured.originPreparationSha256 ||
		!isDeepStrictEqual(receipt.recovery.request, successor.recovery) ||
		receipt.terminationSha256 !==
			hash(Buffer.from(companyComputerOutageTerminationAcknowledgementCanonical(successor.termination))) ||
		receipt.bootObservationSha256 !== configured.bootObservationSha256
	)
		throw new Error("outage adoption receipt differs");
	const inspection = successor.termination.request.inspection;
	if (
		!isDeepStrictEqual(
			json(await read(`${root}/outage-termination-inspection-${inspection.inspectionId}.json`, 16384, 0o600)),
			inspection,
		)
	)
		throw new Error("outage termination inspection differs");
	return {
		kind: "outage" as const,
		bytes,
		start,
		request,
		attestation,
		configurationCommands: [configured.command],
		configurationPath: `${directory}/credentials/config.json`,
		adoptionPath,
		stopPaths: {
			claim: `${root}/service-stop-claim-${activationId}.json`,
			completion: `${root}/service-stop-completion-${activationId}.json`,
		},
	};
}
