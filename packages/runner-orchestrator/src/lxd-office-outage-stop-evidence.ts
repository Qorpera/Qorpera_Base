import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerLifecycleRequest,
	companyComputerBootDirectory,
	companyComputerOutageTerminationAcknowledgementCanonical,
	parseCompanyComputerOutageAdoptionReceipt,
} from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import type { readRecord } from "./lxd-office-journal-files.ts";
import {
	type LxdOfficeOutageRetainedHistoryClient,
	readLxdOfficeOutageRetainedHistory,
} from "./lxd-office-outage-restart-history.ts";
import { officeStopDecode, officeStopHash } from "./lxd-office-stop-evidence.ts";

/** Installed custody and immutable provider history for an ordinary stop of
 * an outage-born service. The retained forced termination remains explicit. */
export async function readLxdOfficeOutageStopEvidence(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	recovery: Pick<CompanyComputerLifecycleRequest, "activationId" | "providerId" | "providerPolicySha256" | "startup">,
	records: Record<string, string>,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeOutageRetainedHistoryClient,
	signal: AbortSignal,
) {
	const history = await readLxdOfficeOutageRetainedHistory(
			root,
			intentId,
			binding,
			recovery.activationId,
			readSource,
			client,
			signal,
		),
		{ origin, command, completion } = history,
		installed: Record<string, string> = {};
	const guest = async (path: string, limit: number, mode: number, expectedSha?: string) => {
		signal.throwIfAborted();
		const file = await client.readInstanceFile(
			binding.project,
			lxdOfficeGuestPlan(binding).request.name,
			path,
			limit,
			signal,
		);
		try {
			const sha = officeStopHash(file.content);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== mode ||
				file.content.length > limit ||
				(expectedSha && sha !== expectedSha)
			)
				throw new Error("outage guest evidence custody differs");
			installed[path] = sha;
			return officeStopDecode(file.content);
		} finally {
			file.content.fill(0);
		}
	};
	const run = "/run/qorpera-office-preparation",
		directory = companyComputerBootDirectory(command.bootId),
		request = origin.request,
		configuration = request.configuration,
		base = origin.recovery.request,
		startPath =
			history.request.schema === "qorpera.office-outage-service-start-request/v1"
				? `${run}/outage-service-start-completion.json`
				: `${run}/boot-service-restart-completion-${completion.activationId}.json`;
	if (
		!isDeepStrictEqual(await guest(startPath, 8192, 0o600), completion) ||
		!isDeepStrictEqual(await guest(`${run}/outage-service-start-completion.json`, 8192, 0o600), origin.completion) ||
		!isDeepStrictEqual(
			await guest(
				`${run}/outage-service-start-incoming-${origin.command.requestSha256}.json`,
				65536,
				0o400,
				origin.command.requestSha256,
			),
			request,
		) ||
		!isDeepStrictEqual(
			await guest(`${directory}/configuration-completion.json`, 16384, 0o600, request.configurationCompletionSha256),
			configuration,
		) ||
		!isDeepStrictEqual(await guest(`${directory}/configuration-claim.json`, 4096, 0o600), {
			schema: "qorpera.office-outage-configuration-claim/v1",
			command: configuration.command,
			recoveryId: base.recoveryId,
			activationId: origin.completion.activationId,
		}) ||
		!isDeepStrictEqual(await guest(`${run}/outage-service-start-claim.json`, 4096, 0o600), {
			schema: "qorpera.office-outage-service-start-claim/v1",
			command: origin.command,
			recoveryId: base.recoveryId,
			activationId: origin.completion.activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
		})
	)
		throw new Error("outage root claims differ");
	await guest(
		`${directory}/credentials/config.json`,
		configuration.files["config.json"].bytes,
		0o400,
		completion.configurationSha256,
	);
	const attestation = history.request.successor.request.attestation,
		receipt = parseCompanyComputerOutageAdoptionReceipt(
			await guest(`${directory}/adoption.json`, 16384, 0o444, attestation.adoptionReceiptSha256),
		),
		termination = request.successor.request.termination,
		inspection = termination.request.inspection;
	if (
		receipt.bootId !== command.bootId ||
		receipt.origin.preparationSha256 !== configuration.originPreparationSha256 ||
		!isDeepStrictEqual(receipt.recovery, { request: base, predecessor: origin.recovery.predecessor }) ||
		receipt.origin.adoptionReceiptSha256 !== inspection.originAdoptionReceiptSha256 ||
		receipt.bootObservationSha256 !== history.bootObservationSha256 ||
		receipt.terminationSha256 !==
			officeStopHash(Buffer.from(companyComputerOutageTerminationAcknowledgementCanonical(termination))) ||
		!isDeepStrictEqual(
			await guest(`${run}/outage-termination-inspection-${inspection.inspectionId}.json`, 16384, 0o600),
			inspection,
		)
	)
		throw new Error("outage public adoption differs");
	if (history.request.schema === "qorpera.office-boot-service-restart-request/v1") {
		const restart = history.request;
		if (
			!isDeepStrictEqual(
				await guest(
					`${run}/boot-service-restart-incoming-${command.requestSha256}.json`,
					65536,
					0o400,
					command.requestSha256,
				),
				restart,
			) ||
			!isDeepStrictEqual(
				await guest(`${run}/service-successor-${restart.stop.revocation.request.activationId}.json`, 8192, 0o600),
				{
					schema: "qorpera.office-boot-service-successor-claim/v1",
					command,
					recoveryId: base.recoveryId,
					originActivationId: origin.completion.activationId,
					activationId: completion.activationId,
					predecessorActivationId: restart.stop.revocation.request.activationId,
					stopCompletionSha256: restart.stopCompletionSha256,
				},
			)
		)
			throw new Error("outage ordinary successor root claims differ");
	}
	if (
		recovery.providerId !== binding.providerId ||
		recovery.providerPolicySha256 !== binding.providerPolicySha256 ||
		recovery.activationId !== completion.activationId ||
		!isDeepStrictEqual(recovery.startup, {
			scope: {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			},
			computerGeneration: binding.computerGeneration,
			allocationId: binding.allocationId,
			instanceSha256: origin.observation.instanceSha256,
			imageSha256: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			bootId: command.bootId,
			configurationSha256: completion.configurationSha256,
			serviceInvocationId: completion.serviceInvocationId,
		})
	)
		throw new Error("outage recovery activation differs");
	signal.throwIfAborted();
	return {
		...history,
		initial: false as const,
		attestation,
		records,
		installed,
		startCompletionSha256: installed[startPath]!,
		startObservationSha256: officeDigest(history.marker),
		forbiddenCommandIds: [command.commandId, origin.command.commandId, ...history.configurationCommandIds],
	};
}
