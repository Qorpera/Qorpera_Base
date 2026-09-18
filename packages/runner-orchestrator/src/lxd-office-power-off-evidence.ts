import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerBootIntentRequest,
	companyComputerBootDirectory,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { readLxdOfficeResetVmHistory } from "./lxd-office-reset-vm-history.ts";
import { readLxdOfficeResumeEvidence } from "./lxd-office-resume-evidence.ts";
import { officeStopHash } from "./lxd-office-stop-evidence.ts";
import type { LxdOfficeVmLineageCommand } from "./lxd-office-vm-lineage.ts";

/** Historical custody and byte binding only. Callers separately require the
 * exact successful VM operation chain and current SQL/physical authority. */
async function readShutdown(
	root: string,
	creation: LxdOfficeCreationIdentity,
	request: CompanyComputerBootIntentRequest,
	signal: AbortSignal,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord> = (name, limit = 65536) =>
		readRecord(join(root, name), limit),
) {
	const { intentId, binding } = creation,
		{ allocationId } = binding,
		predecessor = request.predecessor,
		suffix = `${allocationId}-${predecessor.transitionId}`;
	const seedName = `power-off-request-${suffix}.json`,
		doneName = `power-off-completed-${suffix}.json`,
		historyName = `power-off-history-${suffix}.json`,
		stopName = `service-stop-request-${suffix}.json`,
		stopDoneName = `service-stop-completed-${suffix}.json`,
		bootName = `boot-observation-${allocationId}.json`;
	const read = async (name: string) => {
		signal.throwIfAborted();
		return readSource(name, 65536);
	};
	const seedFile = await read(seedName),
		resetRoot = (seedFile.value as { schema?: unknown } | null)?.schema === "qorpera.lxd-office-power-off-request/v4",
		later = (seedFile.value as { schema?: unknown } | null)?.schema === "qorpera.lxd-office-power-off-request/v3",
		seed = officeRecord(seedFile.value, [
			...(later ? ["bootIntent"] : resetRoot ? ["resetOriginActivationId"] : []),
			"schema",
			"intentId",
			"binding",
			"request",
			"commandId",
			"startCommandId",
			"hostBootId",
			"stopCompletionSha256",
			"stopHistorySha256",
			"records",
		]);
	const command = parseCompanyComputerPreparationCommand({
		commandId: seed.commandId,
		bootId: seed.hostBootId,
		requestSha256: seed.stopCompletionSha256,
	});
	parseCompanyComputerPreparationCommand({ ...command, commandId: seed.startCommandId });
	if (
		seed.schema !==
			(resetRoot
				? "qorpera.lxd-office-power-off-request/v4"
				: later
					? "qorpera.lxd-office-power-off-request/v3"
					: "qorpera.lxd-office-power-off-request/v2") ||
		seed.intentId !== intentId ||
		!isDeepStrictEqual(seed.binding, binding) ||
		!isDeepStrictEqual(seed.request, predecessor) ||
		seed.stopHistorySha256 !== request.stopHistorySha256 ||
		!seed.records ||
		typeof seed.records !== "object" ||
		Array.isArray(seed.records)
	)
		throw new Error("shutdown identity differs");
	const bootIntent = later ? parseCompanyComputerBootIntentRequest(seed.bootIntent) : undefined;
	const resumeNames = resetRoot
		? [`reset-activation-${allocationId}-${seed.resetOriginActivationId}.json`]
		: bootIntent
			? ["request", "prepared", "observation", "completed"].map(
					(kind) => `resume-${kind}-${allocationId}-${bootIntent.predecessor.transitionId}.json`,
				)
			: [bootName];
	const records = seed.records as Record<string, unknown>,
		entries = Object.entries(records);
	if (
		entries.length < 4 ||
		entries.length > 256 ||
		![historyName, stopName, stopDoneName, ...resumeNames].every((name) => Object.hasOwn(records, name)) ||
		entries.some(
			([name, sha]) => !/^[a-z0-9-]+\.json$/.test(name) || typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha),
		)
	)
		throw new Error("shutdown history invalid");
	for (const [name, sha] of entries)
		if (officeStopHash((await read(name)).bytes) !== sha) throw new Error("shutdown history changed");
	const stopEnvelope = officeRecord((await read(stopName)).value, ["schema", "request", "command"]),
		stop = parseCompanyComputerServiceStopRequest(stopEnvelope.request),
		stopCommand = parseCompanyComputerPreparationCommand(stopEnvelope.command);
	if (
		stopEnvelope.schema !== "qorpera.lxd-office-stop-request/v1" ||
		!isDeepStrictEqual(stop.revocation.request, predecessor) ||
		stopCommand.bootId !== predecessor.startup.bootId ||
		stopCommand.requestSha256 !== officeDigest(stop)
	)
		throw new Error("shutdown stop differs");
	const marker = officeRecord((await read(stopDoneName)).value, [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"receipt",
		]),
		receipt = parseCompanyComputerServiceStopAcknowledgement(marker.receipt, stop, stopCommand);
	if (
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-stop-completion/v1",
			intentId,
			allocationId,
			transitionId: predecessor.transitionId,
			commandId: stopCommand.commandId,
			receipt,
		})
	)
		throw new Error("shutdown acknowledgement differs");
	const historyFile = await read(historyName),
		history = parseCompanyComputerStopHistoryManifest(
			historyFile.value,
			predecessor.startup.bootId,
			predecessor.activationId,
		);
	if (
		records[historyName] !== request.stopHistorySha256 ||
		officeStopHash(historyFile.bytes) !== request.stopHistorySha256 ||
		!isDeepStrictEqual(history.command, stopCommand) ||
		!history.entries.some(
			(entry) => entry.path === history.completionPath && entry.sha256 === seed.stopCompletionSha256,
		) ||
		!history.entries.some(
			(entry) =>
				entry.path ===
					(later || resetRoot
						? `${companyComputerBootDirectory(predecessor.startup.bootId)}/credentials/config.json`
						: "/etc/qorpera-office/credentials/config.json") &&
				entry.sha256 === predecessor.startup.configurationSha256,
		)
	)
		throw new Error("shutdown archive differs");
	const bootResume = bootIntent ? await readLxdOfficeResumeEvidence(creation, bootIntent, read, signal) : undefined;
	const reset = resetRoot
		? await readLxdOfficeResetVmHistory(
				root,
				creation,
				seed.resetOriginActivationId as string,
				async (name) => {
					if (!Object.hasOwn(records, name)) throw new Error("reset shutdown record unpinned");
					return (await read(name)).value;
				},
				signal,
			)
		: undefined;
	const boot = reset
		? reset.observation
		: bootResume
			? { ...bootResume.observation, createCommandId: creation.createCommandId }
			: ((await read(bootName)).value as Record<string, unknown>);
	if (
		boot.createCommandId !== creation.createCommandId ||
		boot.startCommandId !== seed.startCommandId ||
		boot.bootId !== predecessor.startup.bootId ||
		boot.hostBootId !== seed.hostBootId
	)
		throw new Error("shutdown boot differs");
	const doneFile = await read(doneName),
		done = officeRecord(doneFile.value, [
			"schema",
			"intentId",
			"allocationId",
			"transitionId",
			"commandId",
			"requestSha256",
			"operationId",
			"instanceSha256",
			"hostBootId",
		]);
	parseCompanyComputerPreparationCommand({ ...command, commandId: done.operationId });
	const { instanceSha256 } = lxdOfficeGuestPlan(binding);
	if (
		officeStopHash(doneFile.bytes) !== request.powerOffCompletionSha256 ||
		!isDeepStrictEqual(done, {
			schema: "qorpera.lxd-office-power-off-completion/v1",
			intentId,
			allocationId,
			transitionId: predecessor.transitionId,
			commandId: command.commandId,
			requestSha256: officeDigest(seed),
			operationId: done.operationId,
			instanceSha256,
			hostBootId: seed.hostBootId,
		})
	)
		throw new Error("shutdown completion differs");
	signal.throwIfAborted();
	return {
		bootIntent,
		bootResume,
		reset,
		predecessorBootId: predecessor.startup.bootId,
		hostBootId: command.bootId,
		startCommandId: seed.startCommandId as string,
		stopCommandId: command.commandId,
		stopOperationId: done.operationId as string,
		seedSha256: officeStopHash(seedFile.bytes),
		completionSha256: officeStopHash(doneFile.bytes),
		stopHistorySha256: request.stopHistorySha256,
		history,
	};
}

export type LxdOfficeVmCommand = LxdOfficeVmLineageCommand;

/** Walk immutable shutdown/resume links, never a mutable latest pointer.
 * Each v3 shutdown names the boot intent that produced its stopped boot.
 * Old v2 shutdowns terminate at the permanent original boot. The operation
 * journal holds at most 128 commands, so at most 63 shutdowns can be proven.
 * No recursion or historical-prefix authorization is used here. */
export async function readLxdOfficePowerOffEvidence(
	root: string,
	creation: LxdOfficeCreationIdentity,
	request: CompanyComputerBootIntentRequest,
	signal: AbortSignal,
	readSource: (name: string, limit?: number) => ReturnType<typeof readRecord> = (name, limit = 65536) =>
		readRecord(join(root, name), limit),
) {
	const current = await readShutdown(root, creation, request, signal, readSource);
	let selected = current;
	const commands: LxdOfficeVmCommand[] = [],
		boots = new Set<string>();
	for (let depth = 0; ; depth++) {
		if (depth >= 63 || boots.has(selected.predecessorBootId)) throw new Error("shutdown lineage cyclic or full");
		boots.add(selected.predecessorBootId);
		commands.unshift(
			{ commandId: selected.startCommandId, action: "start" },
			{ commandId: selected.stopCommandId, action: "stop" },
		);
		if (!selected.bootIntent) break;
		const previous = await readShutdown(root, creation, selected.bootIntent, signal, readSource);
		if (
			selected.bootResume?.powerOffRequestSha256 !== previous.seedSha256 ||
			selected.hostBootId !== previous.hostBootId
		)
			throw new Error("shutdown predecessor differs");
		selected = previous;
	}
	if (selected.reset) commands.unshift(...selected.reset.commands.slice(0, -1));
	else commands.unshift({ commandId: creation.createCommandId, action: "create" });
	if (new Set(commands.map((command) => command.commandId)).size !== commands.length)
		throw new Error("shutdown command reused");
	signal.throwIfAborted();
	const {
		bootIntent: _bootIntent,
		bootResume: _bootResume,
		predecessorBootId: _predecessorBootId,
		...evidence
	} = current;
	return {
		...evidence,
		commands,
		bootIds: [...boots],
		originalBootId: selected.reset?.originalBootId ?? selected.predecessorBootId,
	};
}
