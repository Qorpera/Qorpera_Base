import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerServiceSoftwareArtifact,
	type CompanyComputerServiceSoftwareInvocationChallenge,
	type CompanyComputerStartupIdentity,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";

export interface LxdOfficeSoftwareInvocationRegistry {
	call(
		method: "qorpera_check_office_software_invocation" | "qorpera_ack_office_software_invocation",
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** One provider-owned measurement transaction, nested in the successor's
 * original inspection deadline. No service start, activation or automatic
 * retry. The concrete physical port retains request/evidence under root custody
 * and supplies an independent process/code observation, never a guest report. */
export async function acknowledgeLxdOfficeSoftwareInvocation(
	options: {
		activationId: string;
		startup: CompanyComputerStartupIdentity;
		expectedRevision: number;
		expectedService: CompanyComputerServiceSoftwareArtifact;
		providerCapability: string;
		inspectionDeadline: number;
	},
	registry: LxdOfficeSoftwareInvocationRegistry,
	physical: (
		challenge: Readonly<CompanyComputerServiceSoftwareInvocationChallenge>,
		deadline: number,
		signal: AbortSignal,
	) => Promise<{ evidence: unknown; evidenceSha256: string }>,
	caller: AbortSignal,
) {
	try {
		const startup = parseCompanyComputerStartupIdentity(options.startup);
		const { activationId, providerCapability, inspectionDeadline } = options;
		const service = { ...options.expectedService },
			revision = options.expectedRevision;
		if (
			typeof activationId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(activationId) ||
			typeof providerCapability !== "string" ||
			!/^[0-9a-f]{64}$/.test(providerCapability) ||
			!Number.isFinite(inspectionDeadline) ||
			inspectionDeadline > performance.now() + 5000
		)
			throw new Error("authority");
		const bounded = (signal: AbortSignal, deadline: number) => {
			signal.throwIfAborted();
			const remaining = Math.floor(deadline - performance.now());
			if (remaining < 1) throw new Error("expired");
			return AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
		};
		const original = bounded(caller, inspectionDeadline),
			challengeId = randomUUID(),
			started = performance.now();
		const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge(
			await registry.call(
				"qorpera_check_office_software_invocation",
				{
					p_startup: structuredClone(startup),
					p_activation_id: activationId,
					p_challenge_id: challengeId,
					p_provider_capability: providerCapability,
				},
				original,
			),
		);
		if (
			challenge.challengeId !== challengeId ||
			challenge.activationId !== activationId ||
			!isDeepStrictEqual(challenge.startup, startup) ||
			challenge.revision !== revision ||
			!isDeepStrictEqual(challenge.service, service)
		)
			throw new Error("challenge differs");
		const deadline = Math.min(inspectionDeadline, started + challenge.validForMs),
			signal = bounded(original, deadline);
		const measured = await physical(challenge, deadline, signal);
		bounded(signal, deadline);
		const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(measured.evidence, challenge);
		const evidenceSha256 = createHash("sha256")
			.update(companyComputerServiceSoftwareMeasurementText(evidence))
			.digest("hex");
		if (evidenceSha256 !== officeSha(measured.evidenceSha256)) throw new Error("evidence differs");
		const result = officeRecord(
			await registry.call(
				"qorpera_ack_office_software_invocation",
				{
					p_startup: structuredClone(startup),
					p_activation_id: activationId,
					p_challenge_id: challengeId,
					p_measured_service: structuredClone(evidence.service),
					p_evidence_sha256: evidenceSha256,
					p_provider_capability: providerCapability,
				},
				signal,
			),
			["schema", "activationId", "revision", "state"],
		);
		bounded(signal, deadline);
		if (
			result.schema !== "qorpera.office-software-measurement/v1" ||
			result.activationId !== activationId ||
			result.revision !== revision ||
			result.state !== "measured"
		)
			throw new Error("acknowledgement differs");
		return Object.freeze({ evidence, evidenceSha256, deadline });
	} catch (error) {
		throw new Error("OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED", { cause: error });
	}
}
