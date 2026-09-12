import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetServiceRestartCompletion,
	parseCompanyComputerResetServiceRestartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetServiceRestartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, type readRecord } from "./lxd-office-journal-files.ts";
import {
	type LxdOfficeResetHistoryClient,
	readLxdOfficeResetActivationHistory,
} from "./lxd-office-reset-activation-history.ts";
import { openLxdOfficeResetServiceRestartJournal } from "./lxd-office-reset-service-restart-journal.ts";
import { officeStopHash } from "./lxd-office-stop-evidence.ts";

export type LxdOfficeResetRetainedHistoryClient = LxdOfficeResetHistoryClient &
	Partial<LxdOfficeResetServiceRestartClient>;
/** Historical provider acknowledgements retain the reset root's planned
 * activation. Service successors reference it; they never re-enter reset SQL
 * preparation or manufacture a replacement receipt/configuration. */
export async function readLxdOfficeResetRetainedHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord>,
	client: LxdOfficeResetRetainedHistoryClient,
	signal: AbortSignal,
) {
	parseCompanyComputerPreparationCommand({ commandId: activationId, bootId: intentId, requestSha256: "0".repeat(64) });
	const read = async (name: string) => (await readSource(name)).value,
		suffix = `${binding.allocationId}-${activationId}`;
	let value: unknown;
	try {
		value = await read(`reset-service-restart-request-${suffix}.json`);
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		const origin = await readLxdOfficeResetActivationHistory(
			root,
			intentId,
			binding,
			activationId,
			read,
			client,
			signal,
		);
		return { ...origin, origin };
	}
	const packet = officeRecord(value, ["schema", "intentId", "binding", "command", "request"]),
		request = parseCompanyComputerResetServiceRestartRequest(packet.request),
		command = parseCompanyComputerPreparationCommand(packet.command),
		origin = await readLxdOfficeResetActivationHistory(
			root,
			intentId,
			binding,
			request.origin.request.attestation.activationId,
			read,
			client,
			signal,
		);
	if (
		!isDeepStrictEqual(packet, {
			schema: "qorpera.lxd-office-reset-service-restart-request/v1",
			intentId,
			binding,
			command,
			request,
		}) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request))) ||
		command.bootId !== origin.command.bootId ||
		request.successor.request.attestation.activationId !== activationId ||
		!isDeepStrictEqual(request.origin, origin.request) ||
		request.configurationCompletionSha256 !== origin.configurationCompletionSha256
	)
		throw new Error("reset restart packet differs");
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
		throw new Error("reset restart preparation differs");
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
		throw new Error("reset restart acknowledged stop differs");
	const identity = {
		intentId,
		binding,
		bootObservationSha256: origin.bootObservationSha256,
		command,
		activationId,
		transitionId: predecessor.transitionId,
		configurationObservationSha256: request.successor.request.attestation.configurationObservationSha256,
		stopObservationSha256: officeDigest(request.acknowledgement),
		resetId: origin.plan.resetId,
		rootIncarnationId: origin.plan.rootIncarnationId,
		originActivationId: origin.completion.activationId,
	};
	if (
		!isDeepStrictEqual(await read(`reset-service-restart-intent-${suffix}.json`), {
			schema: "qorpera.lxd-office-reset-service-restart-intent/v1",
			requestSha256: officeDigest(packet),
			identity,
		})
	)
		throw new Error("reset restart index differs");
	if (!client.submitOfficeResetServiceRestart || !client.inspectOfficeResetServiceRestart)
		throw new Error("reset restart client unavailable");
	const operation = await (
		await openLxdOfficeResetServiceRestartJournal(root, identity, {
			submitOfficeResetServiceRestart: client.submitOfficeResetServiceRestart.bind(client),
			inspectOfficeResetServiceRestart: client.inspectOfficeResetServiceRestart.bind(client),
		})
	).observe(signal);
	if (operation.state === "not_dispatched") throw new Error("reset restart not dispatched");
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
		completion = parseCompanyComputerResetServiceRestartCompletion(marker.completion, command, request);
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
		throw new Error("reset restart acknowledgement differs");
	return {
		...origin,
		kind: "reset_restart" as const,
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
