import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
	COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceRestartRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
	parseCompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import { readCompanyComputerAcknowledgedStop } from "./cloud-company-computer-acknowledged-stop.ts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";

export type CompanyComputerProtectedEvidenceReader = (path: string, limit: number, mode: number) => Promise<Buffer>;
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value));
const id = (value: string) => {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
		throw new Error("activation identity");
	return value;
};
export function companyComputerSuccessorClaim(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerServiceRestartRequest,
) {
	return {
		schema: "qorpera.office-service-successor-claim/v1",
		command,
		activationId: request.start.attestation.activationId,
		predecessorActivationId: request.stop.revocation.request.activationId,
		stopCompletionSha256: request.stopCompletionSha256,
	};
}
export function companyComputerSuccessorClaimPath(predecessorActivationId: string): string {
	return `${root}/service-successor-${id(predecessorActivationId)}.json`;
}
export function companyComputerServiceRestartCompletionPath(activationId: string): string {
	return `${root}/service-restart-completion-${id(activationId)}.json`;
}
function stopPaths(activationId: string, initial: boolean) {
	const suffix = initial ? "" : `-${id(activationId)}`;
	return {
		claim: `${root}/service-stop-claim${suffix}.json`,
		completion: `${root}/service-stop-completion${suffix}.json`,
	};
}
export async function readCompanyComputerInitialServiceInvocation(read: CompanyComputerProtectedEvidenceReader) {
	const bytes = await read(`${root}/service-start-completion.json`, 8192, 0o600);
	const data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command);
	const staged = await read(
		`${root}/service-start-incoming-${command.requestSha256}.json`,
		COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
		0o400,
	);
	if (hash(staged) !== command.requestSha256) throw new Error("initial start changed");
	const request = parseCompanyComputerServiceStartRequest(json(staged));
	const start = parseCompanyComputerServiceStartCompletion(data, command, request);
	const claim = json(await read(`${root}/service-start-claim.json`, 4096, 0o600));
	if (
		!isDeepStrictEqual(claim, {
			schema: "qorpera.office-service-start-claim/v1",
			command,
			activationId: start.activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
		})
	)
		throw new Error("initial claim differs");
	// The provider's stop evidence requires the original boot's configuration
	// completion in the sealed history, exactly as later boots retain theirs.
	// Retaining it here (through the caller's reader) seals it with the stop.
	const configured = await read(`${root}/configuration-completion.json`, 16384, 0o600);
	if (hash(configured) !== request.configurationCompletionSha256) throw new Error("initial configuration differs");
	return { bytes, start, request, stopPaths: stopPaths(start.activationId, true) };
}

/** Retains the protected predecessor facts without replaying physical stop or
 * adopting its old grants. An immutable completed root record is historical
 * evidence; callers separately measure the current unit and kernel cgroup. */
export async function readCompanyComputerRestartPredecessor(
	request: CompanyComputerServiceRestartRequest,
	read: CompanyComputerProtectedEvidenceReader,
	initial: Awaited<ReturnType<typeof readCompanyComputerInitialServiceInvocation>>,
) {
	const predecessor = request.stop.revocation.request;
	if (
		request.start.attestation.activationId === initial.start.activationId ||
		!isDeepStrictEqual(
			{
				...request.start,
				attestation: { ...request.start.attestation, activationId: initial.request.attestation.activationId },
			},
			initial.request,
		)
	)
		throw new Error("restart configuration differs");
	const priorBytes =
		predecessor.activationId === initial.start.activationId
			? initial.bytes
			: await read(companyComputerServiceRestartCompletionPath(predecessor.activationId), 8192, 0o600);
	return readCompanyComputerAcknowledgedStop(request, read, {
		bytes: priorBytes,
		start: {
			configurationSha256: request.start.attestation.configurationSha256,
			configurationCompletionSha256: request.start.configurationCompletionSha256,
		},
		stopPaths: stopPaths(predecessor.activationId, predecessor.activationId === initial.start.activationId),
	});
}

/** Select by immutable activation, never by a mutable latest alias. Initial
 * records stay in their original locations. Each successor has its own start
 * completion and stop paths, while its predecessor permits one child claim. */
export async function readCompanyComputerServiceInvocation(
	activationId: string,
	read: CompanyComputerProtectedEvidenceReader,
) {
	id(activationId);
	const initial = await readCompanyComputerInitialServiceInvocation(read);
	if (initial.start.activationId === activationId) return initial;
	const bytes = await read(companyComputerServiceRestartCompletionPath(activationId), 8192, 0o600);
	const data = json(bytes) as Record<string, unknown>,
		command = parseCompanyComputerPreparationCommand(data.command);
	const staged = await read(
		`${root}/service-restart-incoming-${command.requestSha256}.json`,
		COMPANY_COMPUTER_SERVICE_RESTART_MAX_BYTES,
		0o400,
	);
	if (hash(staged) !== command.requestSha256) throw new Error("restart request changed");
	const request = parseCompanyComputerServiceRestartRequest(json(staged));
	const start = parseCompanyComputerServiceRestartCompletion(data, command, request);
	if (start.activationId !== activationId) throw new Error("activation differs");
	const claim = json(
		await read(companyComputerSuccessorClaimPath(request.stop.revocation.request.activationId), 8192, 0o600),
	);
	if (!isDeepStrictEqual(claim, companyComputerSuccessorClaim(command, request)))
		throw new Error("successor claim differs");
	await readCompanyComputerRestartPredecessor(request, read, initial);
	return { bytes, start, request: request.start, stopPaths: stopPaths(activationId, false) };
}
