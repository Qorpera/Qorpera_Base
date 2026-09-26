import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import type { LxdOfficeBootServiceRestartClient } from "./lxd-client.ts";
import { openLxdOfficeBootServiceRestartJournal } from "./lxd-office-boot-service-restart-journal.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, type readRecord } from "./lxd-office-journal-files.ts";
import {
	type LxdOfficeOutageActivationHistoryClient,
	readLxdOfficeOutageActivationHistory,
} from "./lxd-office-outage-activation-history.ts";
import { officeStopHash } from "./lxd-office-stop-evidence.ts";

export type LxdOfficeOutageRetainedHistoryClient = LxdOfficeOutageActivationHistoryClient &
	Partial<LxdOfficeBootServiceRestartClient>;
/** Ordinary same-boot service successors retain the exact outage origin.
 * No graceful boot intent or replacement configuration is invented. */
export async function readLxdOfficeOutageRetainedHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeOutageRetainedHistoryClient,
	signal: AbortSignal,
) {
	parseCompanyComputerPreparationCommand({ commandId: activationId, bootId: intentId, requestSha256: "0".repeat(64) });
	const read = async (name: string) => (await readSource(name)).value,
		suffix = `${binding.allocationId}-${activationId}`;
	let value: unknown;
	try {
		value = await read(`boot-service-restart-request-${suffix}.json`);
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		const origin = await readLxdOfficeOutageActivationHistory(
			root,
			intentId,
			binding,
			activationId,
			readSource,
			client,
			signal,
		);
		return { ...origin, origin };
	}
	const packet = officeRecord(value, ["schema", "intentId", "binding", "command", "request"]),
		request = parseCompanyComputerBootServiceRestartRequest(packet.request),
		command = parseCompanyComputerPreparationCommand(packet.command),
		origin = await readLxdOfficeOutageActivationHistory(
			root,
			intentId,
			binding,
			request.origin.successor.request.attestation.activationId,
			readSource,
			client,
			signal,
		);
	if (
		!isDeepStrictEqual(packet, {
			schema: "qorpera.lxd-office-boot-service-restart-request/v1",
			intentId,
			binding,
			command,
			request,
		}) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request))) ||
		command.bootId !== origin.command.bootId ||
		request.successor.request.attestation.activationId !== activationId ||
		request.origin.schema !== "qorpera.office-outage-service-start-request/v1" ||
		!isDeepStrictEqual(request.origin, origin.request)
	)
		throw new Error("boot restart packet differs");
	const predecessor = request.stop.revocation.request;
	const previousMarker =
		predecessor.activationId === origin.completion.activationId
			? origin.marker
			: await read(`successor-completed-${binding.allocationId}-${predecessor.activationId}.json`);
	if (
		!isDeepStrictEqual(await read(`successor-request-${binding.allocationId}-${predecessor.transitionId}.json`), {
			schema: "qorpera.lxd-office-successor-request/v1",
			intentId,
			binding,
			request: request.successor.request,
			startObservationSha256: officeDigest(previousMarker),
		}) ||
		!isDeepStrictEqual(
			await read(`successor-prepared-${binding.allocationId}-${predecessor.transitionId}.json`),
			request.successor,
		)
	)
		throw new Error("boot restart preparation differs");
	const stopEnvelope = await read(`service-stop-request-${binding.allocationId}-${predecessor.transitionId}.json`);
	if (
		!isDeepStrictEqual(stopEnvelope, {
			schema: "qorpera.lxd-office-stop-request/v1",
			request: request.stop,
			command: request.acknowledgement.inspection.stop.command,
		}) ||
		!isDeepStrictEqual(
			await read(`service-stop-completed-${binding.allocationId}-${predecessor.transitionId}.json`),
			{
				schema: "qorpera.lxd-office-stop-completion/v1",
				intentId,
				allocationId: binding.allocationId,
				transitionId: predecessor.transitionId,
				commandId: request.acknowledgement.inspection.stop.command.commandId,
				receipt: request.acknowledgement,
			},
		)
	)
		throw new Error("boot restart acknowledged stop differs");
	const identity = {
		intentId,
		binding,
		bootObservationSha256: origin.bootObservationSha256,
		command,
		activationId,
		transitionId: predecessor.transitionId,
		configurationObservationSha256: request.successor.request.attestation.configurationObservationSha256,
		stopObservationSha256: officeDigest(request.acknowledgement),
		recoveryId: origin.recovery.request.recoveryId,
		originActivationId: origin.completion.activationId,
	};
	if (
		!isDeepStrictEqual(await read(`boot-service-restart-intent-${suffix}.json`), {
			schema: "qorpera.lxd-office-boot-service-restart-intent/v1",
			requestSha256: officeDigest(packet),
			identity,
		})
	)
		throw new Error("boot restart index differs");
	if (!client.submitOfficeBootServiceRestart || !client.inspectOfficeBootServiceRestart)
		throw new Error("boot restart client unavailable");
	const operation = await (
		await openLxdOfficeBootServiceRestartJournal(root, identity, {
			submitOfficeBootServiceRestart: client.submitOfficeBootServiceRestart.bind(client),
			inspectOfficeBootServiceRestart: client.inspectOfficeBootServiceRestart.bind(client),
		})
	).observe(signal);
	if (operation.state === "not_dispatched") throw new Error("boot restart not dispatched");
	const marker = officeRecord(await read(`successor-completed-${suffix}.json`), [
			"schema",
			"intentId",
			"allocationId",
			"activationId",
			"commandId",
			"predecessorActivationId",
			"completion",
			"requestSha256",
			...(operation.operationId ? ["operationId"] : []),
		]),
		completion = parseCompanyComputerBootServiceRestartCompletion(marker.completion, command, request);
	if (
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-successor-completion/v1",
			intentId,
			allocationId: binding.allocationId,
			activationId,
			commandId: command.commandId,
			predecessorActivationId: predecessor.activationId,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
			completion,
			requestSha256: command.requestSha256,
		})
	)
		throw new Error("boot restart acknowledgement differs");
	return {
		...origin,
		kind: "outage" as const,
		request,
		command,
		completion,
		marker,
		origin,
		configurationCommandIds: [
			...origin.configurationCommandIds,
			origin.command.commandId,
			request.acknowledgement.inspection.stop.command.commandId,
		],
	};
}
