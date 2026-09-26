import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	type CompanyComputerLifecycleRequest,
	companyComputerBootDirectory,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import type { LxdOfficeServiceRestartClient } from "./lxd-client.ts";
import {
	readLxdOfficeActivationHistory,
	readLxdOfficeInitialActivationHistory,
} from "./lxd-office-activation-history.ts";
import {
	type LxdOfficeRetainedActivationHistoryClient,
	readLxdOfficeRetainedActivationHistory,
} from "./lxd-office-boot-restart-history.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, readRecord } from "./lxd-office-journal-files.ts";
import type { LxdOfficeOutageRetainedHistoryClient } from "./lxd-office-outage-restart-history.ts";
import { readLxdOfficeOutageStopEvidence } from "./lxd-office-outage-stop-evidence.ts";

import type { LxdOfficeResetRetainedHistoryClient } from "./lxd-office-reset-restart-history.ts";
import { readLxdOfficeResetStopEvidence } from "./lxd-office-reset-stop-evidence.ts";

export const officeStopHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const officeStopDecode = (bytes: Buffer): unknown =>
	JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Historical activation and installed public metadata only. The root stop
 * helper independently checks the start claim and configured startup identity.
 * No workbench copy, browser profile, writer handoff or credential secret is
 * read here. A lost activation acknowledgement is recovered by activation
 * before an explicit recovery plan can be accepted. */
export async function readLxdOfficeStopEvidence(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	recovery: Pick<CompanyComputerLifecycleRequest, "activationId" | "providerId" | "providerPolicySha256" | "startup">,
	client: LxdOfficeRetainedActivationHistoryClient &
		Partial<LxdOfficeServiceRestartClient> &
		LxdOfficeResetRetainedHistoryClient &
		LxdOfficeOutageRetainedHistoryClient,
	signal: AbortSignal,
) {
	const records: Record<string, string> = {};
	const readSource = async (name: string, limit = 65536) => {
		signal.throwIfAborted();
		const file = await readRecord(join(root, name), limit);
		records[name] = officeStopHash(file.bytes);
		return file;
	};
	const read = async (name: string) => (await readSource(name)).value;
	let outage = false;
	try {
		await readSource(`outage-service-start-request-${binding.allocationId}-${recovery.activationId}.json`);
		outage = true;
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
	}
	if (!outage) {
		let restart: unknown;
		try {
			restart = await read(`boot-service-restart-request-${binding.allocationId}-${recovery.activationId}.json`);
		} catch (error) {
			if (!code(error, "ENOENT")) throw error;
		}
		if (restart !== undefined) {
			const packet = officeRecord(restart, ["schema", "intentId", "binding", "command", "request"]);
			outage =
				parseCompanyComputerBootServiceRestartRequest(packet.request).origin.schema ===
				"qorpera.office-outage-service-start-request/v1";
		}
	}
	if (outage)
		return readLxdOfficeOutageStopEvidence(root, intentId, binding, recovery, records, readSource, client, signal);
	for (const prefix of ["reset-activation", "reset-service-restart-request"]) {
		try {
			await readSource(`${prefix}-${binding.allocationId}-${recovery.activationId}.json`);
		} catch (error) {
			if (code(error, "ENOENT")) continue;
			throw error;
		}
		return readLxdOfficeResetStopEvidence(root, intentId, binding, recovery, records, readSource, client, signal);
	}
	const original = await readLxdOfficeInitialActivationHistory(root, intentId, binding, read, client, signal);
	const history =
		original.command.bootId === recovery.startup.bootId
			? {
					...(await readLxdOfficeActivationHistory(
						root,
						intentId,
						binding,
						recovery.activationId,
						read,
						client,
						signal,
					)),
					kind: "original" as const,
				}
			: await readLxdOfficeRetainedActivationHistory(
					root,
					intentId,
					binding,
					recovery.activationId,
					readSource,
					client,
					signal,
				);
	const { command, bootObservationSha256, marker, completion, initial } = history;
	const request = history.kind === "original" ? history.request : history.origin.request;
	const name = lxdOfficeGuestPlan(binding).request.name;
	const installed: Record<string, string> = {};
	const guest = async (path: string, limit: number, mode: number, expectedSha?: string) => {
		signal.throwIfAborted();
		const file = await client.readInstanceFile(binding.project, name, path, limit, signal);
		try {
			const sha = officeStopHash(file.content);
			if (
				file.uid !== 0 ||
				file.gid !== 0 ||
				file.mode !== mode ||
				file.content.length > limit ||
				(expectedSha && sha !== expectedSha)
			)
				throw new Error("guest evidence custody");
			installed[path] = sha;
			return officeStopDecode(file.content);
		} finally {
			file.content.fill(0);
		}
	};
	const startPath =
		history.kind === "boot_restart"
			? `/run/qorpera-office-preparation/boot-service-restart-completion-${completion.activationId}.json`
			: history.kind === "boot"
				? "/run/qorpera-office-preparation/boot-service-start-completion.json"
				: initial
					? "/run/qorpera-office-preparation/service-start-completion.json"
					: `/run/qorpera-office-preparation/service-restart-completion-${completion.activationId}.json`;
	if (!isDeepStrictEqual(await guest(startPath, 8192, 0o600), completion))
		throw new Error("original completion changed");
	const directory = companyComputerBootDirectory(command.bootId),
		attestation =
			history.kind === "original" ? history.request.attestation : history.request.successor.request.attestation,
		adoptionPath =
			history.kind !== "original" ? `${directory}/adoption.json` : COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH;
	await guest(
		history.kind !== "original"
			? `${directory}/configuration-completion.json`
			: "/run/qorpera-office-preparation/configuration-completion.json",
		16384,
		0o600,
		request.configurationCompletionSha256,
	);
	await guest(
		history.kind !== "original"
			? `${directory}/credentials/config.json`
			: "/etc/qorpera-office/credentials/config.json",
		request.configuration.files["config.json"].bytes,
		0o400,
		completion.configurationSha256,
	);
	const adoption = await guest(adoptionPath, 65536, 0o444, attestation.adoptionReceiptSha256);
	if (history.kind !== "original") {
		const origin = history.origin;
		const receipt = parseCompanyComputerBootAdoptionReceipt(adoption);
		if (
			receipt.bootId !== command.bootId ||
			!isDeepStrictEqual(receipt.bootIntent, history.bootIntent) ||
			receipt.origin.preparationSha256 !== origin.request.configuration.originPreparationSha256 ||
			receipt.bootObservationSha256 !== bootObservationSha256
		)
			throw new Error("boot adoption differs");
		if (
			!isDeepStrictEqual(await guest(`${directory}/configuration-claim.json`, 4096, 0o600), {
				schema: "qorpera.office-boot-configuration-claim/v1",
				command: request.configuration.command,
				bootIntentId: history.bootIntent.bootIntentId,
				activationId: origin.completion.activationId,
			}) ||
			!isDeepStrictEqual(await guest("/run/qorpera-office-preparation/boot-service-start-claim.json", 4096, 0o600), {
				schema: "qorpera.office-boot-service-start-claim/v1",
				command: origin.command,
				bootIntentId: history.bootIntent.bootIntentId,
				activationId: origin.completion.activationId,
				configurationCompletionSha256: request.configurationCompletionSha256,
			}) ||
			!isDeepStrictEqual(
				await guest(
					`/run/qorpera-office-preparation/boot-service-start-incoming-${origin.command.requestSha256}.json`,
					65536,
					0o400,
					origin.command.requestSha256,
				),
				request,
			)
		)
			throw new Error("boot root claims differ");
		if (history.kind === "boot_restart") {
			const restart = history.request;
			if (
				!isDeepStrictEqual(
					await guest("/run/qorpera-office-preparation/boot-service-start-completion.json", 8192, 0o600),
					origin.completion,
				) ||
				!isDeepStrictEqual(
					await guest(
						`/run/qorpera-office-preparation/boot-service-restart-incoming-${command.requestSha256}.json`,
						65536,
						0o400,
						command.requestSha256,
					),
					restart,
				) ||
				!isDeepStrictEqual(
					await guest(
						`/run/qorpera-office-preparation/service-successor-${restart.stop.revocation.request.activationId}.json`,
						8192,
						0o600,
					),
					{
						schema: "qorpera.office-boot-service-successor-claim/v1",
						command,
						bootIntentId: origin.bootIntent.bootIntentId,
						originActivationId: origin.completion.activationId,
						activationId: completion.activationId,
						predecessorActivationId: restart.stop.revocation.request.activationId,
						stopCompletionSha256: restart.stopCompletionSha256,
					},
				)
			)
				throw new Error("boot restart root claims differ");
		}
	}
	const boot =
		history.kind !== "original"
			? {
					instanceSha256: history.bootIntent.predecessor.startup.instanceSha256,
					bootId: command.bootId,
					hostBootId: history.hostBootId,
				}
			: officeRecord(await read(`boot-observation-${binding.allocationId}.json`), [
					"schema",
					"intentId",
					"allocationId",
					"createCommandId",
					"startCommandId",
					"observationSha256",
					"planSha256",
					"copySha256",
					"reviewSha256",
					"bootId",
					"instanceSha256",
					"hostBootId",
				]);
	if (history.kind === "original" && officeDigest(boot) !== bootObservationSha256)
		throw new Error("boot evidence changed");
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
			instanceSha256: boot.instanceSha256,
			imageSha256: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			bootId: command.bootId,
			configurationSha256: completion.configurationSha256,
			serviceInvocationId: completion.serviceInvocationId,
		})
	)
		throw new Error("recovery activation differs");
	if (boot.bootId !== command.bootId) throw new Error("activation boot changed");
	parseCompanyComputerPreparationCommand({ ...command, commandId: boot.hostBootId });
	signal.throwIfAborted();
	const result = {
		initial,
		attestation,
		records,
		installed,
		command,
		completion,
		startCompletionSha256: installed[startPath]!,
		startObservationSha256: officeDigest(marker),
		bootObservationSha256,
		hostBootId: boot.hostBootId as string,
	};
	return history.kind !== "original"
		? {
				...result,
				kind: history.kind,
				origin: history.origin,
				request: history.request,
				forbiddenCommandIds: [command.commandId, ...history.configurationCommandIds],
			}
		: {
				...result,
				kind: "original" as const,
				request: history.request,
				forbiddenCommandIds: [
					command.commandId,
					history.request.configuration.command.commandId,
					history.request.configuration.preparation.commandId,
				],
			};
}
