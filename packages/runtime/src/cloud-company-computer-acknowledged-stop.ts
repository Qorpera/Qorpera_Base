import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
	type CompanyComputerServiceRestartRequest,
	type CompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStopCompletion,
} from "@qorpera/contracts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import type { CompanyComputerProtectedEvidenceReader } from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
/** Historical acknowledged stop bound to the actual predecessor wire bytes.
 * Neither a SQL acknowledgement alone nor a stopped PID is a replacement. */
export async function readCompanyComputerAcknowledgedStop(
	request: Pick<CompanyComputerServiceRestartRequest, "stop" | "acknowledgement" | "stopCompletionSha256">,
	read: CompanyComputerProtectedEvidenceReader,
	prior: {
		bytes: Buffer;
		start: Pick<CompanyComputerServiceStartCompletion, "configurationSha256" | "configurationCompletionSha256">;
		stopPaths: { claim: string; completion: string };
	},
) {
	const predecessor = request.stop.revocation.request,
		paths = prior.stopPaths;
	const bytes = await read(paths.completion, 8192, 0o600);
	if (hash(bytes) !== request.stopCompletionSha256) throw new Error("predecessor stop changed");
	const expected = request.acknowledgement.inspection.stop;
	const completion = parseCompanyComputerServiceStopCompletion(json(bytes), expected.command, request.stop);
	if (!isDeepStrictEqual(completion, expected)) throw new Error("acknowledged stop differs");
	const stage = await read(
		`${root}/service-stop-incoming-${completion.command.requestSha256}.json`,
		COMPANY_COMPUTER_SERVICE_STOP_MAX_BYTES,
		0o400,
	);
	if (hash(stage) !== completion.command.requestSha256 || !isDeepStrictEqual(json(stage), request.stop))
		throw new Error("retained stop request differs");
	const claim = json(await read(paths.claim, 8192, 0o600)) as Record<string, unknown>;
	if (
		!claim ||
		Object.keys(claim).sort().join() !== "command,observedInvocationId,observedRestarts,schema,transitionId" ||
		claim.schema !== "qorpera.office-service-stop-claim/v1" ||
		!isDeepStrictEqual(claim.command, completion.command) ||
		claim.transitionId !== predecessor.transitionId ||
		claim.observedInvocationId !== completion.observedInvocationId ||
		!Number.isSafeInteger(claim.observedRestarts) ||
		(claim.observedRestarts as number) < 0 ||
		(claim.observedRestarts as number) > 2147483647
	)
		throw new Error("retained stop claim differs");
	const inspection = json(
		await read(
			`${root}/service-stop-inspection-${request.acknowledgement.inspection.inspectionId}.json`,
			16384,
			0o600,
		),
	);
	if (!isDeepStrictEqual(inspection, request.acknowledgement.inspection))
		throw new Error("acknowledged inspection differs");
	const priorBytes = prior.bytes;
	if (hash(priorBytes) !== request.stop.startCompletionSha256) throw new Error("predecessor start changed");
	const started = json(priorBytes) as Record<string, unknown>;
	if (
		started.activationId !== predecessor.activationId ||
		started.serviceInvocationId !== predecessor.startup.serviceInvocationId ||
		started.configurationSha256 !== prior.start.configurationSha256 ||
		started.configurationCompletionSha256 !== prior.start.configurationCompletionSha256
	)
		throw new Error("predecessor start differs");
	return completion;
}
