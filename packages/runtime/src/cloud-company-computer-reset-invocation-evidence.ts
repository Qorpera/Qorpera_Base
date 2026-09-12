import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
	type CompanyComputerResetConfigurationCompletion,
	companyComputerBootDirectory,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import type { CompanyComputerProtectedEvidenceReader } from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Public, immutable start/configuration evidence on a recreated root. The
 * caller supplies a protected reader and retains every observed byte. No
 * credential, preparation replay or mutable browser/workbench read is needed
 * to select an exact reset-born invocation for measurement or cleanup. */
export async function readCompanyComputerResetServiceInvocation(
	activationId: string,
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const directory = companyComputerBootDirectory(bootId);
	const bytes = await read(`${root}/reset-service-start-completion.json`, 16384, 0o600);
	const data = json(bytes) as Record<string, unknown>;
	const command = parseCompanyComputerPreparationCommand(data.command);
	const staged = await read(
		`${root}/reset-service-start-incoming-${command.requestSha256}.json`,
		COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
		0o400,
	);
	if (hash(staged) !== command.requestSha256) throw new Error("reset start request changed");
	const request = parseCompanyComputerResetServiceStartRequest(json(staged));
	const start = parseCompanyComputerResetServiceStartCompletion(data, command, request);
	const { attestation } = request.request;
	if (command.bootId !== bootId || start.activationId !== activationId) throw new Error("reset activation differs");
	const configuredBytes = await read(`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION}`, 16384, 0o600);
	if (hash(configuredBytes) !== start.configurationCompletionSha256) throw new Error("reset configuration changed");
	const configuredValue = json(configuredBytes) as CompanyComputerResetConfigurationCompletion;
	const configured = parseCompanyComputerResetConfigurationCompletion(configuredValue, {
		...configuredValue,
		resetId: request.request.resetId,
		rootIncarnationId: request.request.rootIncarnationId,
		activationId,
		adoptionReceiptSha256: attestation.adoptionReceiptSha256,
	});
	if (
		configured.command.bootId !== bootId ||
		configured.command.commandId === command.commandId ||
		configured.files["config.json"].sha256 !== attestation.configurationSha256
	)
		throw new Error("reset configuration binding differs");
	const claim = json(await read(`${root}/reset-service-start-claim.json`, 4096, 0o600));
	if (
		!isDeepStrictEqual(claim, {
			schema: "qorpera.office-reset-service-start-claim/v1",
			command,
			resetId: request.request.resetId,
			activationId,
			configurationCompletionSha256: start.configurationCompletionSha256,
		})
	)
		throw new Error("reset start claim differs");
	const configurationClaim = json(
		await read(`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM}`, 4096, 0o600),
	);
	if (
		!isDeepStrictEqual(configurationClaim, {
			schema: "qorpera.office-reset-configuration-claim/v1",
			command: configured.command,
			resetId: configured.resetId,
			rootIncarnationId: configured.rootIncarnationId,
			activationId,
		})
	)
		throw new Error("reset configuration claim differs");
	const receipt = await read(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444);
	if (hash(receipt) !== attestation.adoptionReceiptSha256) throw new Error("reset adoption receipt differs");
	return {
		kind: "reset" as const,
		bytes,
		start,
		request,
		attestation,
		configurationCommands: [configured.command],
		configurationPath: `${directory}/credentials/config.json`,
		adoptionPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
		stopPaths: {
			claim: `${root}/service-stop-claim-${activationId}.json`,
			completion: `${root}/service-stop-completion-${activationId}.json`,
		},
	};
}
