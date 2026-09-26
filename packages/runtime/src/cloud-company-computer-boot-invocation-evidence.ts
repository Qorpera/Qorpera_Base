import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES,
	type CompanyComputerBootServiceRestartRequest,
	type CompanyComputerPreparationCommand,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerBootConfigurationCompletion,
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import { readCompanyComputerAcknowledgedStop } from "./cloud-company-computer-acknowledged-stop.ts";
import { readCompanyComputerInitialOutageServiceInvocation } from "./cloud-company-computer-outage-invocation-evidence.ts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import {
	type CompanyComputerProtectedEvidenceReader,
	companyComputerSuccessorClaimPath,
} from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

export async function readCompanyComputerInitialBootServiceInvocation(
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const directory = companyComputerBootDirectory(bootId),
		adoptionPath = companyComputerBootAdoptionReceiptPath(bootId);
	const adoptionBytes = await read(adoptionPath, 16384, 0o444),
		adoption = json(adoptionBytes);
	if (
		adoption &&
		typeof adoption === "object" &&
		"schema" in adoption &&
		adoption.schema === "qorpera.office-state-outage-retained/v1"
	)
		return readCompanyComputerInitialOutageServiceInvocation(bootId, read);
	const bytes = await read(`${root}/boot-service-start-completion.json`, 8192, 0o600),
		receiptBytes = adoptionBytes,
		claimBytes = await read(`${root}/boot-service-start-claim.json`, 4096, 0o600);
	const data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command),
		staged = await read(
			`${root}/boot-service-start-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_BOOT_SERVICE_START_MAX_BYTES,
			0o400,
		);
	if (hash(staged) !== command.requestSha256) throw new Error("boot start request changed");
	const request = parseCompanyComputerBootServiceStartRequest(json(staged)),
		start = parseCompanyComputerBootServiceStartCompletion(data, command, request),
		successor = request.successor.request,
		attestation = successor.attestation;
	const activationId = start.activationId;
	if (command.bootId !== bootId) throw new Error("boot activation differs");
	if (
		!isDeepStrictEqual(json(claimBytes), {
			schema: "qorpera.office-boot-service-start-claim/v1",
			command,
			bootIntentId: successor.bootIntentId,
			activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
		})
	)
		throw new Error("boot start claim differs");
	const configuredBytes = await read(`${directory}/configuration-completion.json`, 16384, 0o600);
	if (hash(configuredBytes) !== request.configurationCompletionSha256) throw new Error("boot configuration changed");
	const configured = parseCompanyComputerBootConfigurationCompletion(json(configuredBytes), request.configuration);
	if (
		!isDeepStrictEqual(json(await read(`${directory}/configuration-claim.json`, 4096, 0o600)), {
			schema: "qorpera.office-boot-configuration-claim/v1",
			command: configured.command,
			bootIntentId: successor.bootIntentId,
			activationId,
		})
	)
		throw new Error("boot configuration claim differs");
	const receipt = parseCompanyComputerBootAdoptionReceipt(json(receiptBytes));
	if (
		hash(receiptBytes) !== attestation.adoptionReceiptSha256 ||
		receipt.bootId !== bootId ||
		receipt.origin.preparationSha256 !== configured.originPreparationSha256 ||
		receipt.bootObservationSha256 !== successor.bootObservationSha256 ||
		!isDeepStrictEqual(receipt.bootIntent, {
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: successor.bootIntentId,
			activationId,
			predecessor: successor.predecessor,
			stopHistorySha256: successor.stopHistorySha256,
			powerOffCompletionSha256: successor.powerOffCompletionSha256,
		})
	)
		throw new Error("retained boot receipt differs");
	return {
		kind: "boot" as const,
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

export function companyComputerBootServiceRestartCompletionPath(activationId: string) {
	// Reuse the strict UUID validation without inventing a second identity form.
	companyComputerSuccessorClaimPath(activationId);
	return `${root}/boot-service-restart-completion-${activationId}.json`;
}
export function companyComputerBootSuccessorClaim(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerBootServiceRestartRequest,
) {
	return {
		schema: "qorpera.office-boot-service-successor-claim/v1",
		command,
		...(request.origin.schema === "qorpera.office-outage-service-start-request/v1"
			? { recoveryId: request.origin.successor.request.recovery.recoveryId }
			: { bootIntentId: request.origin.successor.request.bootIntentId }),
		originActivationId: request.origin.successor.request.attestation.activationId,
		activationId: request.successor.request.attestation.activationId,
		predecessorActivationId: request.stop.revocation.request.activationId,
		stopCompletionSha256: request.stopCompletionSha256,
	};
}
async function readBootInvocation(
	activationId: string,
	initial: Awaited<ReturnType<typeof readCompanyComputerInitialBootServiceInvocation>>,
	read: CompanyComputerProtectedEvidenceReader,
) {
	if (activationId === initial.start.activationId) return initial;
	const bytes = await read(companyComputerBootServiceRestartCompletionPath(activationId), 8192, 0o600),
		data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command),
		staged = await read(
			`${root}/boot-service-restart-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_BOOT_SERVICE_RESTART_MAX_BYTES,
			0o400,
		);
	if (hash(staged) !== command.requestSha256) throw new Error("boot restart request changed");
	const request = parseCompanyComputerBootServiceRestartRequest(json(staged)),
		start = parseCompanyComputerBootServiceRestartCompletion(data, command, request);
	if (
		start.activationId !== activationId ||
		!isDeepStrictEqual(request.origin, initial.request) ||
		start.serviceInvocationId === initial.start.serviceInvocationId ||
		command.commandId === initial.start.command.commandId
	)
		throw new Error("boot restart origin differs");
	const claim = json(
		await read(companyComputerSuccessorClaimPath(request.stop.revocation.request.activationId), 8192, 0o600),
	);
	if (!isDeepStrictEqual(claim, companyComputerBootSuccessorClaim(command, request)))
		throw new Error("boot successor claim differs");
	return {
		...initial,
		kind: "boot_restart" as const,
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
export async function readCompanyComputerBootServiceInvocation(
	activationId: string,
	bootId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	const origin = await readCompanyComputerInitialBootServiceInvocation(bootId, read),
		current = await readBootInvocation(activationId, origin, read);
	if (current.kind === "boot_restart") {
		const prior = await readBootInvocation(current.request.stop.revocation.request.activationId, origin, read);
		await readCompanyComputerAcknowledgedStop(current.request, read, prior);
		if (current.start.command.commandId === prior.start.command.commandId)
			throw new Error("predecessor command reused");
	}
	return { ...current, origin };
}
