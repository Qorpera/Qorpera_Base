import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import { readCompanyComputerBootServiceInvocation } from "./cloud-company-computer-boot-invocation-evidence.ts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import { readCompanyComputerResetServiceInvocation } from "./cloud-company-computer-reset-invocation-evidence.ts";
import {
	type CompanyComputerProtectedEvidenceReader,
	readCompanyComputerServiceInvocation,
} from "./cloud-company-computer-service-invocation-evidence.ts";

/** Select public stop evidence by the current kernel boot and immutable
 * activation. Keep each wire schema intact. Stopping needs neither secrets
 * nor a replay of preparation, retained workbench inspection or SQL grants. */
export async function readCompanyComputerStopInvocation(
	activationId: string,
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const adoptionPath = companyComputerBootAdoptionReceiptPath(bootId);
	parseCompanyComputerPreparationCommand({ commandId: activationId, bootId, requestSha256: "0".repeat(64) });
	const optional = async (path: string, limit: number, mode: number) => {
		try {
			return await read(path, limit, mode);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	};
	const bytes = await optional(`${root}/boot-service-start-completion.json`, 8192, 0o600),
		receiptBytes = await optional(adoptionPath, 16384, 0o444),
		claimBytes = await optional(`${root}/boot-service-start-claim.json`, 4096, 0o600);
	const resetPaths = [
		`${root}/reset-service-start-completion.json`,
		`${root}/reset-service-start-claim.json`,
		`${companyComputerBootDirectory(bootId)}/${COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION}`,
		`${companyComputerBootDirectory(bootId)}/${COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM}`,
	];
	const resetEvidence = [];
	for (const path of resetPaths) resetEvidence.push(await optional(path, 16384, 0o600));
	if (resetEvidence.some(Boolean)) {
		if (
			!resetEvidence.every(Boolean) ||
			bytes ||
			receiptBytes ||
			claimBytes ||
			(await optional(`${root}/service-start-completion.json`, 8192, 0o600)) ||
			(await optional(`${root}/service-start-claim.json`, 4096, 0o600))
		)
			throw new Error("ambiguous reset start evidence");
		return readCompanyComputerResetServiceInvocation(activationId, bootId, read);
	}
	if (!bytes && !receiptBytes && !claimBytes) {
		const prior = await readCompanyComputerServiceInvocation(activationId, read);
		if (prior.start.command.bootId !== bootId) throw new Error("prior boot differs");
		return {
			...prior,
			kind: "original" as const,
			attestation: prior.request.attestation,
			configurationCommands: [prior.request.configuration.command, prior.request.configuration.preparation],
			configurationPath: "/etc/qorpera-office/credentials/config.json",
			adoptionPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
		};
	}
	if (!bytes || !receiptBytes || !claimBytes) throw new Error("retained boot evidence missing");
	if (await optional(`${root}/service-start-completion.json`, 8192, 0o600))
		throw new Error("ambiguous boot start evidence");
	return readCompanyComputerBootServiceInvocation(activationId, bootId, read);
}
