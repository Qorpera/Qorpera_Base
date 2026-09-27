import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerOutageServiceStartRequest,
	type CompanyComputerPreparationCommand,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerOutageTerminationAcknowledgementCanonical,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerOutageAdoptionReceipt,
	parseCompanyComputerOutageConfigurationCompletion,
	parseCompanyComputerOutageTerminationInspection,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { companyComputerLinuxServiceSection } from "./cloud-company-computer-boot-configuration-control.ts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import { readCompanyComputerOutagePredecessor } from "./cloud-company-computer-outage-predecessor.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	readCompanyComputerPreparationProtected as read,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Root-local configuration and termination proof remain mandatory after SQL
 * has prepared the successor. SQL metadata never substitutes for these files. */
export async function readCompanyComputerOutageServiceStartEvidence(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerOutageServiceStartRequest,
	signal: AbortSignal,
) {
	await assertCompanyComputerPreparationLockAndBoot(command);
	const directory = companyComputerBootDirectory(command.bootId),
		successor = request.successor.request,
		attestation = successor.attestation,
		evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	let workbench: Awaited<ReturnType<typeof openCompanyComputerRetainedWorkbench>> | undefined;
	let predecessor: Awaited<ReturnType<typeof readCompanyComputerOutagePredecessor>> | undefined;
	const retain = async (path: string, limit: number, mode: number) => {
		signal.throwIfAborted();
		const bytes = await read(path, limit, mode);
		evidence.push({ path, bytes, mode });
		return bytes;
	};
	const close = async () => {
		try {
			await workbench?.close();
		} finally {
			predecessor?.close();
			for (const file of evidence) file.bytes.fill(0);
		}
	};
	try {
		const configuredBytes = await retain(`${directory}/configuration-completion.json`, 16384, 0o600);
		if (hash(configuredBytes) !== request.configurationCompletionSha256)
			throw new Error("outage configuration differs");
		const configured = parseCompanyComputerOutageConfigurationCompletion(
				json(configuredBytes),
				request.configuration,
			),
			originalBytes = await retain(
				"/etc/qorpera-office/preparation.json",
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
				0o444,
			),
			original = parseCompanyComputerPreparationRequest(json(originalBytes)),
			originBytes = await retain("/etc/qorpera-office/adoption.json", 16384, 0o444),
			receiptBytes = await retain(companyComputerBootAdoptionReceiptPath(command.bootId), 16384, 0o444),
			receipt = parseCompanyComputerOutageAdoptionReceipt(json(receiptBytes));
		if (
			hash(originalBytes) !== configured.originPreparationSha256 ||
			!originBytes.equals(encode(companyComputerPreparationAdoptionReceipt(original))) ||
			hash(receiptBytes) !== attestation.adoptionReceiptSha256 ||
			!isDeepStrictEqual(receipt.recovery.request, successor.recovery) ||
			receipt.terminationSha256 !==
				hash(Buffer.from(companyComputerOutageTerminationAcknowledgementCanonical(successor.termination))) ||
			receipt.bootId !== command.bootId ||
			!isDeepStrictEqual(receipt.origin, {
				bootId: original.bootId,
				preparationSha256: hash(originalBytes),
				adoptionReceiptSha256: hash(originBytes),
			}) ||
			!isDeepStrictEqual(receipt.layout, companyComputerPreparationAdoptionReceipt(original).layout) ||
			!isDeepStrictEqual(receipt.workbenchMount, original.workbenchMount)
		)
			throw new Error("outage retained receipt differs");
		const claim = await retain(`${directory}/configuration-claim.json`, 4096, 0o600);
		if (
			!claim.equals(
				encode({
					schema: "qorpera.office-outage-configuration-claim/v1",
					command: configured.command,
					recoveryId: successor.recovery.recoveryId,
					activationId: attestation.activationId,
				}),
			)
		)
			throw new Error("outage configuration claim differs");
		const inspection = successor.termination.request.inspection,
			inspectionBytes = await retain(
				`${root}/outage-termination-inspection-${inspection.inspectionId}.json`,
				16384,
				0o600,
			);
		if (
			!isDeepStrictEqual(parseCompanyComputerOutageTerminationInspection(json(inspectionBytes)), inspection) ||
			inspection.bootObservationSha256 !== configured.bootObservationSha256
		)
			throw new Error("outage termination proof differs");
		predecessor = await readCompanyComputerOutagePredecessor(
			{
				startup: receipt.recovery.predecessor.startup,
				bootId: command.bootId,
				originPreparationSha256: configured.originPreparationSha256,
			},
			read,
			signal,
		);
		if (
			predecessor.predecessorConfigurationSha256 !== inspection.predecessorConfigurationSha256 ||
			predecessor.predecessorAdoptionReceiptSha256 !== inspection.predecessorAdoptionReceiptSha256 ||
			predecessor.originAdoptionReceiptSha256 !== inspection.originAdoptionReceiptSha256
		)
			throw new Error("outage predecessor differs");
		workbench = await openCompanyComputerRetainedWorkbench(original, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			const credentialsRoot = await assertCompanyComputerBootCredentials(command);
			for (const file of evidence) {
				const bytes = await read(file.path, file.bytes.length, file.mode);
				try {
					if (!bytes.equals(file.bytes)) throw new Error("outage retained proof changed");
				} finally {
					bytes.fill(0);
				}
			}
			await predecessor!.verify();
			await workbench!.verify();
			for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
				const bytes = await read(
					`${credentialsRoot}/${file}`,
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
					0o400,
				);
				try {
					if (bytes.length !== configured.files[file].bytes || hash(bytes) !== configured.files[file].sha256)
						throw new Error("outage credentials differ");
					if (key === "configuration") {
						const config = parseCompanyComputerServiceConfig(bytes.toString("utf8"));
						if (
							config.native.port !== attestation.nativePort ||
							config.viewer.port !== attestation.viewerPort ||
							!isDeepStrictEqual(config.scope, original.scope) ||
							config.computerGeneration !== original.computerGeneration ||
							!isDeepStrictEqual(
								companyComputerLinuxBinding(config.linux),
								companyComputerLinuxServiceSection(
									original,
									command.bootId,
									companyComputerBootAdoptionReceiptPath(command.bootId),
									hash(receiptBytes),
								),
							)
						)
							throw new Error("outage configuration binding differs");
					}
				} finally {
					bytes.fill(0);
				}
			}
			await workbench!.verify();
			signal.throwIfAborted();
		};
		await verify();
		return { verify, close };
	} catch (error) {
		await close();
		throw error;
	}
}
