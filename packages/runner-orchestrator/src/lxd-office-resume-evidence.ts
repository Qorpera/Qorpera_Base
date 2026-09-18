import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerBootIntentRequest,
	parseCompanyComputerBootIntent,
	parseCompanyComputerResumeObservation,
} from "@qorpera/contracts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { officeDigest, officeSha } from "./lxd-office-image-provenance.ts";
import type { readRecord } from "./lxd-office-journal-files.ts";

/** Immutable resume acknowledgement, independent of current VM state and SQL
 * admission. The caller binds its shutdown digest to verified stop evidence
 * and checks the complete operation sequence before granting any effect. */
export async function readLxdOfficeResumeEvidence(
	creation: LxdOfficeCreationIdentity,
	request: CompanyComputerBootIntentRequest,
	read: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	signal: AbortSignal,
) {
	const { intentId, binding } = creation,
		{ allocationId } = binding,
		suffix = `${allocationId}-${request.predecessor.transitionId}`;
	signal.throwIfAborted();
	const seed = (await read(`resume-request-${suffix}.json`)).value as Record<string, unknown>,
		prepared = parseCompanyComputerBootIntent((await read(`resume-prepared-${suffix}.json`)).value, request),
		observation = parseCompanyComputerResumeObservation(
			(await read(`resume-observation-${suffix}.json`)).value,
			request,
		),
		powerOffRequestSha256 = officeSha(seed?.powerOffRequestSha256),
		bootObservationSha256 = officeDigest(observation);
	if (
		prepared.state !== "prepared" ||
		observation.intentId !== intentId ||
		observation.requestSha256 !== officeDigest(seed) ||
		!isDeepStrictEqual(seed, {
			schema: "qorpera.lxd-office-resume-request/v1",
			intentId,
			binding,
			request,
			powerOffRequestSha256,
			hostBootId: observation.hostBootId,
			startCommandId: observation.startCommandId,
		}) ||
		!isDeepStrictEqual((await read(`resume-completed-${suffix}.json`)).value, {
			schema: "qorpera.lxd-office-resume-completion/v1",
			intentId,
			allocationId,
			bootIntentId: request.bootIntentId,
			activationId: request.activationId,
			startCommandId: observation.startCommandId,
			bootObservationSha256,
		})
	)
		throw new Error("resume acknowledgement differs");
	signal.throwIfAborted();
	return { prepared, observation, powerOffRequestSha256, bootObservationSha256 };
}
