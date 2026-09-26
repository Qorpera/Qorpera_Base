import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerOutagePredecessor,
	parseCompanyComputerOutageRecovery,
	parseCompanyComputerOutageRecoveryRequest,
	parseCompanyComputerOutageResumeObservation,
} from "@qorpera/contracts";
import {
	isRuntimePaidComputerMachine,
	type PaidComputerGuardRecord,
	parsePaidComputerGuardRecord,
	parsePaidComputerPermit,
} from "./computer-paid-guard.ts";
import type { LxdTrackedClient } from "./lxd-client.ts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal, type LxdOfficeOperationPort } from "./lxd-office-operations.ts";
import type { LxdOfficeOutageVmOrigin } from "./lxd-office-vm-lineage.ts";

export async function readOptionalOutageRecord(root: string, name: string): Promise<unknown> {
	try {
		return (await readRecord(join(root, name), 131072)).value;
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
		return undefined;
	}
}
export async function retainOutageRecord(root: string, name: string, value: unknown): Promise<void> {
	const previous = await readOptionalOutageRecord(root, name);
	if (previous === undefined) await publish(root, name, Buffer.from(officeCanonical(value)));
	if (!isDeepStrictEqual(await readOptionalOutageRecord(root, name), value))
		throw new Error("OFFICE_OUTAGE_HISTORY_DIFFERS");
}

/** Follow immutable external-stop bridges. Each predecessor journal is frozen
 * at its genuine last start; the bridge never inserts a graceful stop or an
 * invented VM operation. Unlinked, forked, or changed history fails closed. */
export async function readLxdOfficeOutageVmLineage(root: string, creation: LxdOfficeCreationIdentity) {
	await checkDirectory(root);
	const { binding, intentId } = creation,
		{ allocationId } = binding,
		plan = lxdOfficeGuestPlan(binding);
	const names = (await readdir(root)).filter(
		(name) => name.startsWith(`outage-recovery-${allocationId}-`) && name.endsWith(".json"),
	);
	if (names.length > 64) throw new Error("OFFICE_OUTAGE_LINEAGE_FULL");
	const bridges = await Promise.all(
		names.map(async (name) => {
			const bridge = officeRecord((await readRecord(join(root, name), 131072)).value, [
				"schema",
				"intentId",
				"binding",
				"request",
				"outageSha256",
				"predecessorJournalHeadSha256",
				"externalStop",
			]);
			const request = parseCompanyComputerOutageRecoveryRequest(bridge.request);
			const proof = officeRecord(bridge.externalStop, [
				"permit",
				"hostMachineIdSha256",
				"physicalInstanceId",
				"startOperationId",
				"startDispatched",
				"startSettled",
				"startSucceeded",
				"stopReceipt",
			]);
			const permit = parsePaidComputerPermit(proof.permit),
				suffix = `${allocationId}-${permit.permitId}`;
			const outage = officeRecord(
				(await readRecord(join(root, `paid-outage-receipt-${suffix}.json`), 131072)).value,
				["schema", "request", "state", "officeRevision", "registeredAtMs"],
			);
			const outageRequest = officeRecord(
				(await readRecord(join(root, `paid-outage-request-${suffix}.json`), 131072)).value,
				["schema", "requestId", "activation", "guard"],
			);
			const predecessor = parseCompanyComputerOutagePredecessor(outageRequest.activation);
			const stop = officeRecord(proof.stopReceipt, [
				"permitId",
				"generation",
				"allocationId",
				"instanceSha256",
				"physicalInstanceId",
				"hostBootId",
				"observedUptimeMs",
				"closedAtUptimeMs",
				"closedHostBootId",
				"state",
				"operationId",
			]);
			if (
				bridge.schema !== "qorpera.lxd-office-outage-history/v1" ||
				bridge.intentId !== intentId ||
				!isDeepStrictEqual(bridge.binding, binding) ||
				name !== `outage-recovery-${suffix}.json` ||
				outage.schema !== "qorpera.office-computer-outage/v1" ||
				outage.state !== "held" ||
				outageRequest.schema !== "qorpera.office-computer-outage-request/v1" ||
				request.outageRequestId !== outageRequest.requestId ||
				!isDeepStrictEqual(outage.request, outageRequest) ||
				!isDeepStrictEqual(outageRequest.guard, proof) ||
				bridge.outageSha256 !== officeDigest(outage) ||
				typeof bridge.predecessorJournalHeadSha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(bridge.predecessorJournalHeadSha256) ||
				permit.schema !== "qorpera.computer-usage-permit/v2" ||
				permit.allocationId !== allocationId ||
				permit.instanceSha256 !== plan.instanceSha256 ||
				proof.startDispatched !== true ||
				proof.startSettled !== true ||
				proof.startSucceeded !== true ||
				stop.permitId !== permit.permitId ||
				stop.generation !== permit.generation ||
				stop.allocationId !== allocationId ||
				stop.instanceSha256 !== plan.instanceSha256 ||
				stop.physicalInstanceId !== proof.physicalInstanceId ||
				stop.hostBootId !== permit.hostBootId ||
				stop.state !== "stopped" ||
				predecessor.providerId !== binding.providerId ||
				predecessor.providerPolicySha256 !== binding.providerPolicySha256 ||
				predecessor.startup.allocationId !== allocationId ||
				predecessor.startup.instanceSha256 !== plan.instanceSha256 ||
				predecessor.startup.computerGeneration !== binding.computerGeneration ||
				predecessor.startup.imageSha256 !== binding.imageFingerprint ||
				predecessor.startup.bootstrapSha256 !== binding.bootstrapSha256 ||
				!isDeepStrictEqual(predecessor.startup.scope, {
					companyId: binding.companyId,
					environmentId: binding.environmentId,
					companyComputerId: binding.companyComputerId,
					logicalComputerId: binding.logicalComputerId,
				}) ||
				(permit.guestBootId !== null && permit.guestBootId !== predecessor.startup.bootId)
			)
				throw new Error("OFFICE_OUTAGE_BRIDGE_DIFFERS");
			return {
				bridge,
				request,
				predecessor,
				permit,
				proof: {
					...proof,
					physicalInstanceId: proof.physicalInstanceId,
					startOperationId: proof.startOperationId,
					stopReceipt: stop,
				},
			};
		}),
	);
	let segmentRoot = root,
		history = await LxdOfficeOperationJournal.readHistory(root, allocationId),
		origin: LxdOfficeOutageVmOrigin | undefined;
	const segments: { root: string; history: typeof history; bridge: (typeof bridges)[number] | null }[] = [
		{ root, history, bridge: null },
	];
	const seen = new Set<string>();
	while (seen.size < bridges.length) {
		const next = bridges.filter(
			(item) =>
				!seen.has(item.request.recoveryId) &&
				item.bridge.predecessorJournalHeadSha256 === history.journalHeadSha256,
		);
		if (next.length !== 1) throw new Error("OFFICE_OUTAGE_LINEAGE_UNCONFIRMED");
		const item = next[0]!,
			tail = history.events.at(-1);
		if (
			history.intentId !== intentId ||
			!tail ||
			tail.commandId !== item.permit.permitId ||
			tail.action !== "start" ||
			tail.kind !== "settled" ||
			tail.state !== "succeeded" ||
			tail.operationId !== item.proof.startOperationId
		)
			throw new Error("OFFICE_OUTAGE_PREDECESSOR_JOURNAL_DIFFERS");
		seen.add(item.request.recoveryId);
		segmentRoot = join(root, `outage-vm-${item.request.recoveryId}`);
		origin = { kind: "outage", startCommandId: item.request.startCommandId, metadataRoot: root };
		history = await LxdOfficeOperationJournal.readHistory(segmentRoot, allocationId, origin);
		if (
			history.intentId !== intentId ||
			history.events
				.slice(0, 3)
				.some((event) => event.commandId !== item.request.startCommandId || event.action !== "start")
		)
			throw new Error("OFFICE_OUTAGE_SEGMENT_DIFFERS");
		segments.push({ root: segmentRoot, history, bridge: item });
	}
	return { segmentRoot, history, segments, origin };
}

export async function readLxdOfficeOutageBootEvidence(
	root: string,
	creation: LxdOfficeCreationIdentity,
	recoveryId: string,
) {
	const lineage = await readLxdOfficeOutageVmLineage(root, creation),
		segment = lineage.segments.find((item) => item.bridge?.request.recoveryId === recoveryId);
	if (!segment?.bridge) throw new Error("OFFICE_OUTAGE_ORIGIN_UNCONFIRMED");
	const { request } = segment.bridge,
		suffix = `${creation.binding.allocationId}-${recoveryId}`;
	const recovery = parseCompanyComputerOutageRecovery(
		(await readRecord(join(root, `outage-prepared-${suffix}.json`), 131072)).value,
		request,
	);
	const observation = parseCompanyComputerOutageResumeObservation(
		(await readRecord(join(root, `outage-observation-${suffix}.json`), 131072)).value,
		recovery,
	);
	if (
		observation.requestSha256 !== officeDigest(segment.bridge.bridge) ||
		observation.intentId !== creation.intentId ||
		!isDeepStrictEqual(recovery.predecessor, segment.bridge.predecessor) ||
		segment.history.events[2]?.state !== "succeeded" ||
		segment.history.events[2]?.operationId !== observation.operationId
	)
		throw new Error("OFFICE_OUTAGE_BOOT_HISTORY_DIFFERS");
	return {
		recovery,
		observation,
		segmentRoot: segment.root,
		origin: { kind: "outage" as const, startCommandId: request.startCommandId, metadataRoot: root },
		commands: [{ commandId: request.startCommandId, action: "start" as const }],
	};
}

/** No SQL authority is granted here. Effects still need their ordinary
 * lifecycle checks and the exact command sequence in this selected segment. */
export async function openLxdOfficeCurrentOperationJournal(
	root: string,
	creation: LxdOfficeCreationIdentity,
	client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
	paid?: LxdOfficeOperationPort,
) {
	const lineage = await readLxdOfficeOutageVmLineage(root, creation);
	const journal = await LxdOfficeOperationJournal.open(
		lineage.segmentRoot,
		creation.intentId,
		creation.binding,
		client,
		true,
		undefined,
		paid,
		lineage.origin,
	);
	return {
		...lineage,
		journal,
		assertCurrent: async () => {
			const current = await readLxdOfficeOutageVmLineage(root, creation);
			if (current.segmentRoot !== lineage.segmentRoot || !isDeepStrictEqual(current.origin, lineage.origin))
				throw new Error("OFFICE_VM_SEGMENT_SUPERSEDED");
		},
	};
}

/** The external stop is a separate bridge, never an invented LXD operation
 * or graceful guest acknowledgement. Its original VM journal stays frozen. */
export async function openLxdOfficeOutageHistory(
	root: string,
	creation: LxdOfficeCreationIdentity,
	value: PaidComputerGuardRecord,
	client: Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">,
	paid: LxdOfficeOperationPort,
	signal: AbortSignal,
) {
	const guard = parsePaidComputerGuardRecord(value),
		{ binding, intentId } = creation,
		plan = lxdOfficeGuestPlan(binding);
	if (
		guard.phase !== "stopped" ||
		!guard.stopReceipt ||
		guard.stopReceipt.state !== "stopped" ||
		guard.permit.schema !== "qorpera.computer-usage-permit/v2" ||
		!guard.startDispatched ||
		!guard.startSettled ||
		!guard.startSucceeded ||
		!guard.startReference ||
		!isRuntimePaidComputerMachine(guard.machine) ||
		guard.machine.providerKind !== "office" ||
		guard.machine.allocationId !== binding.allocationId ||
		guard.machine.instanceSha256 !== plan.instanceSha256 ||
		!isDeepStrictEqual(guard.machine.physicalTarget, {
			kind: "lxd",
			project: binding.project,
			instanceName: plan.request.name,
			profiles: plan.request.profiles,
			config: plan.request.config,
			devices: plan.request.devices,
		})
	)
		throw new Error("OFFICE_OUTAGE_STOP_PROOF_UNCONFIRMED");
	const suffix = `${binding.allocationId}-${guard.permit.permitId}`;
	const outageRequest = officeRecord(await readOptionalOutageRecord(root, `paid-outage-request-${suffix}.json`), [
		"schema",
		"requestId",
		"activation",
		"guard",
	]);
	const predecessor = parseCompanyComputerOutagePredecessor(outageRequest.activation);
	const proof = {
		permit: guard.permit,
		hostMachineIdSha256: guard.machine.hostMachineIdSha256,
		physicalInstanceId: guard.machine.physicalInstanceId,
		startOperationId: guard.startReference.operationId,
		startDispatched: true,
		startSettled: true,
		startSucceeded: true,
		stopReceipt: guard.stopReceipt,
	};
	const outage = officeRecord(await readOptionalOutageRecord(root, `paid-outage-receipt-${suffix}.json`), [
		"schema",
		"request",
		"state",
		"officeRevision",
		"registeredAtMs",
	]);
	if (
		outageRequest.schema !== "qorpera.office-computer-outage-request/v1" ||
		outage.schema !== "qorpera.office-computer-outage/v1" ||
		outage.state !== "held" ||
		!isDeepStrictEqual(outage.request, outageRequest) ||
		!isDeepStrictEqual(outageRequest.guard, proof) ||
		predecessor.providerId !== binding.providerId ||
		predecessor.providerPolicySha256 !== binding.providerPolicySha256 ||
		predecessor.startup.allocationId !== binding.allocationId ||
		predecessor.startup.instanceSha256 !== plan.instanceSha256 ||
		(guard.permit.guestBootId !== null && guard.permit.guestBootId !== predecessor.startup.bootId)
	)
		throw new Error("OFFICE_OUTAGE_RECEIPT_DIFFERS");
	const name = `outage-recovery-${suffix}.json`;
	let retained = await readOptionalOutageRecord(root, name);
	const lineage = await readLxdOfficeOutageVmLineage(root, creation);
	const previousSegment =
		retained === undefined
			? lineage.segments.at(-1)!
			: lineage.segments.find(
					(segment) =>
						segment.history.journalHeadSha256 ===
						officeRecord(retained, [
							"schema",
							"intentId",
							"binding",
							"request",
							"outageSha256",
							"predecessorJournalHeadSha256",
							"externalStop",
						]).predecessorJournalHeadSha256,
				);
	const main = previousSegment?.history,
		last = main?.events.at(-1);
	if (
		!main ||
		main.intentId !== intentId ||
		last?.commandId !== guard.permit.permitId ||
		last.action !== "start" ||
		last.kind !== "settled" ||
		last.state !== "succeeded" ||
		last.operationId !== guard.startReference.operationId
	)
		throw new Error("OFFICE_OUTAGE_PREDECESSOR_JOURNAL_DIFFERS");
	if (retained === undefined) {
		const request = parseCompanyComputerOutageRecoveryRequest({
			schema: "qorpera.office-outage-recovery-request/v1",
			recoveryId: randomUUID(),
			outageRequestId: outageRequest.requestId,
			activationId: randomUUID(),
			startCommandId: randomUUID(),
		});
		const segmentRoot = join(root, `outage-vm-${request.recoveryId}`);
		await mkdir(segmentRoot, { mode: 0o700 });
		await syncDirectory(root);
		await LxdOfficeOperationJournal.open(segmentRoot, intentId, binding, client, false, undefined, paid);
		await retainOutageRecord(root, name, {
			schema: "qorpera.lxd-office-outage-history/v1",
			intentId,
			binding,
			request,
			outageSha256: officeDigest(outage),
			predecessorJournalHeadSha256: main.journalHeadSha256,
			externalStop: proof,
		});
		retained = await readOptionalOutageRecord(root, name);
	}
	const bridge = officeRecord(retained, [
		"schema",
		"intentId",
		"binding",
		"request",
		"outageSha256",
		"predecessorJournalHeadSha256",
		"externalStop",
	]);
	const request = parseCompanyComputerOutageRecoveryRequest(bridge.request);
	if (
		request.outageRequestId !== outageRequest.requestId ||
		!isDeepStrictEqual(bridge, {
			schema: "qorpera.lxd-office-outage-history/v1",
			intentId,
			binding,
			request,
			outageSha256: officeDigest(outage),
			predecessorJournalHeadSha256: main.journalHeadSha256,
			externalStop: proof,
		})
	)
		throw new Error("OFFICE_OUTAGE_BRIDGE_DIFFERS");
	const segmentRoot = join(root, `outage-vm-${request.recoveryId}`);
	if (
		retained !== undefined &&
		lineage.segments.some((segment) => segment.root === segmentRoot) &&
		lineage.segmentRoot !== segmentRoot
	)
		throw new Error("OFFICE_OUTAGE_RECOVERY_SUPERSEDED");
	await checkDirectory(segmentRoot);
	const journal = await LxdOfficeOperationJournal.open(segmentRoot, intentId, binding, client, true, undefined, paid, {
		kind: "outage",
		startCommandId: request.startCommandId,
		metadataRoot: root,
	});
	const segment = await journal.history();
	if (
		segment.events.slice(0, 3).some((event) => event.commandId !== request.startCommandId || event.action !== "start")
	)
		throw new Error("OFFICE_OUTAGE_SEGMENT_DIFFERS");
	signal.throwIfAborted();
	return { request, bridge, predecessor, journal, segmentRoot, guard };
}
