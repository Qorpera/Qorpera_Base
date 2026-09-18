import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_RESET_SERVICE_START_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetServiceRestartRequest,
	companyComputerBootDirectory,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartRequest,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import { readCompanyComputerAcknowledgedStop } from "./cloud-company-computer-acknowledged-stop.ts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import {
	type CompanyComputerProtectedEvidenceReader,
	companyComputerSuccessorClaimPath,
} from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Public, immutable start/configuration evidence on a recreated root. The
 * caller supplies a protected reader and retains every observed byte. No
 * credential, preparation replay or mutable browser/workbench read is needed
 * to select an exact reset-born invocation for measurement or cleanup. */
export async function readCompanyComputerInitialResetServiceInvocation(
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
	const activationId = start.activationId;
	if (command.bootId !== bootId) throw new Error("reset activation differs");
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

export function companyComputerResetServiceRestartCompletionPath(activationId: string) {
	// Reuse the strict UUID validation without inventing a second identity form.
	companyComputerSuccessorClaimPath(activationId);
	return `${root}/reset-service-restart-completion-${activationId}.json`;
}
export function companyComputerResetSuccessorClaim(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerResetServiceRestartRequest,
) {
	return {
		schema: "qorpera.office-reset-service-successor-claim/v1",
		command,
		resetId: request.origin.request.resetId,
		rootIncarnationId: request.origin.request.rootIncarnationId,
		originActivationId: request.origin.request.attestation.activationId,
		activationId: request.successor.request.attestation.activationId,
		predecessorActivationId: request.stop.revocation.request.activationId,
		stopCompletionSha256: request.stopCompletionSha256,
	};
}
async function readResetInvocation(
	activationId: string,
	initial: Awaited<ReturnType<typeof readCompanyComputerInitialResetServiceInvocation>>,
	read: CompanyComputerProtectedEvidenceReader,
) {
	if (activationId === initial.start.activationId) return initial;
	const bytes = await read(companyComputerResetServiceRestartCompletionPath(activationId), 8192, 0o600),
		data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command),
		staged = await read(
			`${root}/reset-service-restart-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_RESET_SERVICE_RESTART_MAX_BYTES,
			0o400,
		);
	if (hash(staged) !== command.requestSha256) throw new Error("reset restart request changed");
	const request = parseCompanyComputerResetServiceRestartRequest(json(staged)),
		start = parseCompanyComputerResetServiceRestartCompletion(data, command, request);
	if (
		start.activationId !== activationId ||
		!isDeepStrictEqual(request.origin, initial.request) ||
		request.configurationCompletionSha256 !== initial.start.configurationCompletionSha256 ||
		start.serviceInvocationId === initial.start.serviceInvocationId ||
		command.commandId === initial.start.command.commandId
	)
		throw new Error("reset restart origin differs");
	const claim = json(
		await read(companyComputerSuccessorClaimPath(request.stop.revocation.request.activationId), 8192, 0o600),
	);
	if (!isDeepStrictEqual(claim, companyComputerResetSuccessorClaim(command, request)))
		throw new Error("reset successor claim differs");
	return {
		...initial,
		kind: "reset_restart" as const,
		bytes,
		start,
		request,
		attestation: request.successor.request.attestation,
		stopPaths: {
			claim: `${root}/service-stop-claim-${activationId}.json`,
			completion: `${root}/service-stop-completion-${activationId}.json`,
		},
	};
}
/** Each immutable root completion attests its earlier checked predecessor.
 * Revalidate this invocation's acknowledged stop and its predecessor's actual
 * typed packet/claim. Do not recursively copy the entire chain into each stop
 * archive or grow a mutable 'latest' record. */
export async function readCompanyComputerResetServiceInvocation(
	activationId: string,
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const origin = await readCompanyComputerInitialResetServiceInvocation(bootId, read),
		current = await readResetInvocation(activationId, origin, read);
	if (current.kind === "reset_restart") {
		const prior = await readResetInvocation(current.request.stop.revocation.request.activationId, origin, read);
		await readCompanyComputerAcknowledgedStop(current.request, read, prior);
		if (current.start.command.commandId === prior.start.command.commandId)
			throw new Error("predecessor command reused");
	}
	return { ...current, origin };
}
