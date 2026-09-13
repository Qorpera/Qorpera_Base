import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerResetPhaseRecord,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetCustodyBinding,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetPhaseRecord,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetRestoreReceipt,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeCreationIdentity } from "./lxd-office-creation-journal.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { parseLxdOfficeResetSeed } from "./lxd-office-reset-journal.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";
import { assertLxdOfficeVmLineageCommands } from "./lxd-office-vm-lineage.ts";

/** A completed reset is a terminal for the root's current VM boot, retaining
 * the permanent original preparation and the full succeeded command prefix.
 * This local history read cannot authorize effects or infer a mutable latest
 * reset; callers name the immutable reset origin activation and separately
 * compare the complete current operation journal before each new effect. */
export async function readLxdOfficeResetVmHistory(
	root: string,
	creation: LxdOfficeCreationIdentity,
	activationId: string,
	read: (name: string) => Promise<unknown>,
	signal: AbortSignal,
) {
	const { intentId, binding } = creation;
	parseCompanyComputerPreparationCommand({ commandId: activationId, bootId: intentId, requestSha256: "0".repeat(64) });
	const index = officeRecord(await read(`reset-activation-${binding.allocationId}-${activationId}.json`), [
		"schema",
		"intentId",
		"binding",
		"plan",
	]);
	const plan = parseCompanyComputerResetPlan(index.plan);
	if (
		!isDeepStrictEqual(index, { schema: "qorpera.lxd-office-reset-activation-index/v1", intentId, binding, plan }) ||
		plan.intentId !== intentId ||
		plan.successorActivationId !== activationId ||
		plan.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding)
	)
		throw new Error("reset VM index differs");
	const suffix = `${binding.allocationId}-${plan.resetId}`;
	const seed = parseLxdOfficeResetSeed(await read(`reset-seed-${suffix}.json`));
	const originalPacket = officeRecord(await read(`activation-request-${binding.allocationId}.json`), [
		"schema",
		"intentId",
		"binding",
		"command",
		"request",
	]);
	const original = parseCompanyComputerServiceStartRequest(originalPacket.request);
	const originalCommand = parseCompanyComputerPreparationCommand(originalPacket.command);
	if (
		!isDeepStrictEqual(originalPacket, {
			schema: "qorpera.lxd-office-activation-request/v1",
			intentId,
			binding,
			command: originalCommand,
			request: original,
		}) ||
		originalCommand.requestSha256 !== officeDigest(original) ||
		seed.originalBootId !== originalCommand.bootId ||
		seed.intentId !== intentId ||
		seed.planSha256 !== officeDigest(plan) ||
		seed.commands[0]?.commandId !== creation.createCommandId ||
		seed.attestation.activationId !== plan.predecessor.activationId ||
		seed.attestation.bootId !== plan.predecessor.startup.bootId ||
		seed.attestation.preparationObservationSha256 !== plan.preparationObservationSha256 ||
		plan.preparationObservationSha256 !== original.attestation.preparationObservationSha256 ||
		seed.adoptionReceiptSha256 !== original.attestation.adoptionReceiptSha256
	)
		throw new Error("reset VM origin differs");
	const phases: CompanyComputerResetPhaseRecord[] = [];
	for (const [n, phase] of COMPANY_COMPUTER_RESET_PHASES.entries()) {
		const record = parseCompanyComputerResetPhaseRecord(await read(`reset-phase-${suffix}-${n + 1}.json`), plan);
		if (record.phase !== phase || record.previousSha256 !== (n ? officeDigest(phases[n - 1]) : null))
			throw new Error("reset VM phase chain differs");
		phases.push(record);
	}
	const phaseHash = (phase: (typeof COMPANY_COMPUTER_RESET_PHASES)[number]) =>
		phases.find((record) => record.phase === phase)!.evidenceSha256;
	const evidence = (phase: string, observation: object) =>
		officeDigest({ schema: "qorpera.office-reset-phase-evidence/v1", resetId: plan.resetId, phase, observation });
	const custodyRecord = officeRecord(await read(`reset-custody-${suffix}.json`), [
		"schema",
		"binding",
		"custody",
		"manifestSha256",
	]);
	const custody = parseCompanyComputerResetCustodyManifest(custodyRecord.custody, plan);
	const custodyBinding = parseCompanyComputerResetCustodyBinding(custodyRecord.binding);
	if (
		!isDeepStrictEqual(custodyBinding, {
			schema: "qorpera.office-reset-custody-binding/v1",
			resetId: plan.resetId,
			transitionId: plan.predecessor.transitionId,
			predecessorActivationId: plan.predecessor.activationId,
			successorActivationId: activationId,
			rootIncarnationId: plan.rootIncarnationId,
			predecessor: plan.predecessor.startup,
			outboxUid: custodyBinding.outboxUid,
			outboxGid: custodyBinding.outboxGid,
		})
	)
		throw new Error("reset VM custody binding differs");
	if (officeSha(custodyRecord.manifestSha256) !== officeDigest(custody))
		throw new Error("reset custody manifest digest differs");

	const custodySha256 = evidence("custodied", custody);
	const restore = parseCompanyComputerResetRestoreReceipt(
		await read(`reset-restore-${suffix}.json`),
		custody,
		plan,
		custodySha256,
	);
	if (
		phaseHash("fenced") !== seed.planSha256 ||
		phaseHash("custodied") !== custodySha256 ||
		phaseHash("restored") !== evidence("restored", restore) ||
		custodyRecord.schema !== "qorpera.lxd-office-reset-custody/v1" ||
		restore.bootId === seed.originalBootId ||
		restore.bootId === plan.predecessor.startup.bootId
	)
		throw new Error("reset VM custody differs");
	const done = officeRecord(await read(`reset-completed-${suffix}.json`), [
		"schema",
		"resetId",
		"activationId",
		"serviceInvocationId",
	]);
	if (
		done.schema !== "qorpera.lxd-office-reset-completion/v1" ||
		done.resetId !== plan.resetId ||
		done.activationId !== activationId ||
		typeof done.serviceInvocationId !== "string" ||
		!/^[0-9a-f]{32}$/.test(done.serviceInvocationId) ||
		phaseHash("active") !== officeDigest(done)
	)
		throw new Error("reset VM activation differs");
	const commands = [
		...seed.commands,
		{ commandId: plan.commands.stopCommandId, action: "stop" as const },
		{ commandId: plan.commands.deleteCommandId, action: "delete" as const },
		{ commandId: plan.commands.createCommandId, action: "create" as const },
		{ commandId: plan.commands.startCommandId, action: "start" as const },
	];
	assertLxdOfficeVmLineageCommands(commands, true);
	const vm = await LxdOfficeOperationJournal.readHistory(root, binding.allocationId);
	if (
		vm.intentId !== intentId ||
		vm.companyId !== binding.companyId ||
		vm.environmentId !== binding.environmentId ||
		vm.companyComputerId !== binding.companyComputerId ||
		vm.logicalComputerId !== binding.logicalComputerId ||
		vm.computerGeneration !== binding.computerGeneration ||
		vm.providerId !== binding.providerId ||
		vm.providerPolicySha256 !== binding.providerPolicySha256 ||
		vm.imageFingerprint !== binding.imageFingerprint ||
		vm.bootstrapSha256 !== binding.bootstrapSha256 ||
		vm.events.length < commands.length * 3
	)
		throw new Error("reset VM journal differs");
	const administrativeDispositions = await LxdOfficeOperationJournal.assertCompletedHistory(
		root,
		binding.allocationId,
		commands,
	);
	for (const disposition of administrativeDispositions)
		if (
			(disposition.plan.resetId === plan.resetId ||
				disposition.document.deleteCommandId === plan.commands.deleteCommandId) &&
			!isDeepStrictEqual(disposition.plan, plan)
		)
			throw new Error("reset VM administrative plan differs");
	signal.throwIfAborted();
	return {
		plan,
		seed,
		commands,
		administrativeDispositions,
		cleanResetAcceptance: !administrativeDispositions.some(
			(disposition) => disposition.plan.resetId === plan.resetId,
		),
		originalBootId: seed.originalBootId,
		observation: {
			createCommandId: creation.createCommandId,
			startCommandId: plan.commands.startCommandId,
			bootId: restore.bootId,
			hostBootId: seed.hostBootId,
			instanceSha256: plan.predecessor.startup.instanceSha256,
		},
	};
}
