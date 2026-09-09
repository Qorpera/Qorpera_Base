import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
	parseCompanyComputerServiceStartCompletion,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeServiceRestartClient, LxdOfficeServiceStartClient } from "./lxd-client.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { LxdOfficeServiceRestartJournal } from "./lxd-office-service-restart-journal.ts";
import { LxdOfficeServiceStartJournal } from "./lxd-office-service-start-journal.ts";

const officeStopHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function readLxdOfficeInitialActivationHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	read: (name: string) => Promise<unknown>,
	client: LxdOfficeServiceStartClient,
	signal: AbortSignal,
) {
	const seed = officeRecord(await read(`activation-request-${binding.allocationId}.json`), [
		"schema",
		"intentId",
		"binding",
		"command",
		"request",
	]);
	const request = parseCompanyComputerServiceStartRequest(seed.request),
		command = parseCompanyComputerPreparationCommand(seed.command);
	if (
		seed.schema !== "qorpera.lxd-office-activation-request/v1" ||
		seed.intentId !== intentId ||
		!isDeepStrictEqual(seed.binding, binding) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request)))
	)
		throw new Error("activation seed changed");
	const index = officeRecord(await read(`activation-intent-${binding.allocationId}.json`), [
		"schema",
		"requestSha256",
		"identity",
	]);
	const identity = officeRecord(index.identity, [
		"intentId",
		"binding",
		"bootObservationSha256",
		"configurationObservationSha256",
		"command",
	]);
	const bootObservationSha256 = officeSha(identity.bootObservationSha256);
	const expectedIdentity = {
		intentId,
		binding,
		bootObservationSha256,
		configurationObservationSha256: request.attestation.configurationObservationSha256,
		command,
	};
	if (
		index.schema !== "qorpera.lxd-office-activation-intent/v1" ||
		index.requestSha256 !== officeDigest(seed) ||
		!isDeepStrictEqual(identity, expectedIdentity)
	)
		throw new Error("activation index changed");
	const journal = await LxdOfficeServiceStartJournal.open(root, expectedIdentity, client);
	const operation = await journal.observe(signal);
	if (operation.state === "not_dispatched") throw new Error("activation not dispatched");
	const marker = officeRecord(await read(`activation-completed-${binding.allocationId}.json`), [
		"schema",
		"intentId",
		"allocationId",
		"activationId",
		"commandId",
		"completion",
		"requestSha256",
		...(operation.operationId ? ["operationId"] : []),
	]);
	const completion = parseCompanyComputerServiceStartCompletion(marker.completion, command, request);
	if (
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-activation-completion/v1",
			intentId,
			allocationId: binding.allocationId,
			activationId: request.attestation.activationId,
			commandId: command.commandId,
			...(operation.operationId ? { operationId: operation.operationId } : {}),
			completion,
			requestSha256: command.requestSha256,
		})
	)
		throw new Error("activation acknowledgement changed");
	return { request, command, bootObservationSha256, marker, completion };
}

/** Read historical provider acknowledgements by immutable activation. Root
 * controls independently verify their retained physical history. No mutable
 * current pointer, copied workbench or renewed authority is inferred here. */
export async function readLxdOfficeActivationHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	read: (name: string) => Promise<unknown>,
	client: LxdOfficeServiceStartClient & Partial<LxdOfficeServiceRestartClient>,
	signal: AbortSignal,
) {
	const original = await readLxdOfficeInitialActivationHistory(root, intentId, binding, read, client, signal);
	if (activationId === original.completion.activationId) return { ...original, initial: true };
	parseCompanyComputerPreparationCommand({ ...original.command, commandId: activationId });
	const suffix = `${binding.allocationId}-${activationId}`;
	const packet = officeRecord(await read(`service-restart-request-${suffix}.json`), [
		"schema",
		"intentId",
		"binding",
		"command",
		"request",
	]);
	const request = parseCompanyComputerServiceRestartRequest(packet.request),
		command = parseCompanyComputerPreparationCommand(packet.command);
	if (
		packet.schema !== "qorpera.lxd-office-restart-request/v1" ||
		packet.intentId !== intentId ||
		!isDeepStrictEqual(packet.binding, binding) ||
		command.requestSha256 !== officeStopHash(Buffer.from(officeCanonical(request))) ||
		request.start.attestation.activationId !== activationId ||
		!isDeepStrictEqual(
			{
				...request.start,
				attestation: { ...request.start.attestation, activationId: original.request.attestation.activationId },
			},
			original.request,
		)
	)
		throw new Error("restart packet differs");
	const predecessor = request.stop.revocation.request;
	const previousMarker =
		predecessor.activationId === original.completion.activationId
			? original.marker
			: await read(`successor-completed-${binding.allocationId}-${predecessor.activationId}.json`);
	const seed = await read(`successor-request-${binding.allocationId}-${predecessor.transitionId}.json`);
	if (
		!isDeepStrictEqual(seed, {
			schema: "qorpera.lxd-office-successor-request/v1",
			intentId,
			binding,
			request: request.successor.request,
			startObservationSha256: officeDigest(previousMarker),
		})
	)
		throw new Error("successor seed differs");
	if (
		!isDeepStrictEqual(
			await read(`successor-prepared-${binding.allocationId}-${predecessor.transitionId}.json`),
			request.successor,
		)
	)
		throw new Error("successor preparation differs");
	const identity = {
		intentId,
		binding,
		bootObservationSha256: original.bootObservationSha256,
		command,
		activationId,
		transitionId: predecessor.transitionId,
		configurationObservationSha256: request.start.attestation.configurationObservationSha256,
		stopObservationSha256: officeDigest(request.acknowledgement),
	};
	if (
		!isDeepStrictEqual(await read(`service-restart-intent-${suffix}.json`), {
			schema: "qorpera.lxd-office-restart-intent/v1",
			requestSha256: officeDigest(packet),
			identity,
		})
	)
		throw new Error("successor index differs");
	if (!client.submitOfficeServiceRestart || !client.inspectOfficeServiceRestart)
		throw new Error("restart client unavailable");
	const journal = await LxdOfficeServiceRestartJournal.open(root, identity, {
		submitOfficeServiceRestart: client.submitOfficeServiceRestart.bind(client),
		inspectOfficeServiceRestart: client.inspectOfficeServiceRestart.bind(client),
	});
	const operation = await journal.observe(signal);
	if (operation.state === "not_dispatched") throw new Error("successor not dispatched");
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
	]);
	const completion = parseCompanyComputerServiceRestartCompletion(marker.completion, command, request);
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
		throw new Error("successor acknowledgement differs");
	return {
		request: request.start,
		command,
		bootObservationSha256: original.bootObservationSha256,
		marker,
		completion,
		initial: false,
	};
}
