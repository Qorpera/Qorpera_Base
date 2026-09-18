import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	type CompanyComputerLifecycleRequest,
	companyComputerBootDirectory,
} from "@qorpera/contracts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import type { readRecord } from "./lxd-office-journal-files.ts";
import {
	type LxdOfficeResetRetainedHistoryClient,
	readLxdOfficeResetRetainedHistory,
} from "./lxd-office-reset-restart-history.ts";
import { officeStopDecode, officeStopHash } from "./lxd-office-stop-evidence.ts";

/** Reset-specific installed evidence. A recreated root carries neither initial
 * credentials nor a retained-boot adoption receipt; never manufacture either. */
export async function readLxdOfficeResetStopEvidence(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	recovery: CompanyComputerLifecycleRequest,
	records: Record<string, string>,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeResetRetainedHistoryClient,
	signal: AbortSignal,
) {
	const history = await readLxdOfficeResetRetainedHistory(
		root,
		intentId,
		binding,
		recovery.activationId,
		readSource,
		client,
		signal,
	);
	const { origin, command, completion } = history;
	const installed: Record<string, string> = {};
	const guest = async (path: string, limit: number, mode: number, sha?: string) => {
		const file = await client.readInstanceFile(
			binding.project,
			lxdOfficeGuestPlan(binding).request.name,
			path,
			limit,
			signal,
		);
		try {
			signal.throwIfAborted();
			const digest = officeStopHash(file.content);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== mode ||
				file.content.length > limit ||
				(sha && digest !== sha)
			)
				throw new Error("reset guest evidence custody differs");
			installed[path] = digest;
			return officeStopDecode(file.content);
		} finally {
			file.content.fill(0);
		}
	};
	const run = "/run/qorpera-office-preparation",
		directory = companyComputerBootDirectory(command.bootId);
	const startPath =
		history.kind === "reset"
			? `${run}/reset-service-start-completion.json`
			: `${run}/reset-service-restart-completion-${completion.activationId}.json`;
	if (
		!isDeepStrictEqual(await guest(startPath, 8192, 0o600), completion) ||
		!isDeepStrictEqual(await guest(`${run}/reset-service-start-completion.json`, 8192, 0o600), origin.completion) ||
		!isDeepStrictEqual(
			await guest(
				`${run}/reset-service-start-incoming-${origin.command.requestSha256}.json`,
				65536,
				0o400,
				origin.command.requestSha256,
			),
			origin.request,
		) ||
		!isDeepStrictEqual(
			await guest(
				`${directory}/reset-configuration-completion.json`,
				16384,
				0o600,
				origin.configurationCompletionSha256,
			),
			origin.configuration,
		) ||
		!isDeepStrictEqual(await guest(`${directory}/reset-configuration-claim.json`, 4096, 0o600), {
			schema: "qorpera.office-reset-configuration-claim/v1",
			command: origin.configuration.command,
			resetId: origin.plan.resetId,
			rootIncarnationId: origin.plan.rootIncarnationId,
			activationId: origin.completion.activationId,
		}) ||
		!isDeepStrictEqual(await guest(`${run}/reset-service-start-claim.json`, 4096, 0o600), {
			schema: "qorpera.office-reset-service-start-claim/v1",
			command: origin.command,
			resetId: origin.plan.resetId,
			activationId: origin.completion.activationId,
			configurationCompletionSha256: origin.configurationCompletionSha256,
		})
	)
		throw new Error("reset root claims differ");
	await guest(
		`${directory}/credentials/config.json`,
		origin.configuration.files["config.json"].bytes,
		0o400,
		completion.configurationSha256,
	);
	const attestation =
		history.kind === "reset" ? history.request.request.attestation : history.request.successor.request.attestation;
	await guest(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444, attestation.adoptionReceiptSha256);
	if (history.kind === "reset_restart") {
		const request = history.request;
		if (
			!isDeepStrictEqual(
				await guest(
					`${run}/reset-service-restart-incoming-${command.requestSha256}.json`,
					65536,
					0o400,
					command.requestSha256,
				),
				request,
			) ||
			!isDeepStrictEqual(
				await guest(`${run}/service-successor-${request.stop.revocation.request.activationId}.json`, 8192, 0o600),
				{
					schema: "qorpera.office-reset-service-successor-claim/v1",
					command,
					resetId: origin.plan.resetId,
					rootIncarnationId: origin.plan.rootIncarnationId,
					originActivationId: origin.completion.activationId,
					activationId: completion.activationId,
					predecessorActivationId: request.stop.revocation.request.activationId,
					stopCompletionSha256: request.stopCompletionSha256,
				},
			)
		)
			throw new Error("reset successor root claims differ");
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
			instanceSha256: lxdOfficeGuestPlan(binding).instanceSha256,
			imageSha256: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			bootId: command.bootId,
			configurationSha256: completion.configurationSha256,
			serviceInvocationId: completion.serviceInvocationId,
		})
	)
		throw new Error("reset recovery activation differs");
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
