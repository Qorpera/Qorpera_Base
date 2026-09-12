import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetPhaseRecord,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerResetCustodyBinding,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetPhaseRecord,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetRestoreReceipt,
	parseCompanyComputerResetServiceStartCompletion,
	parseCompanyComputerResetServiceStartRequest,
} from "@qorpera/contracts";
import type { LxdOfficeResetSuccessorClient, LxdOfficeServiceStartClient } from "./lxd-client.ts";
import { readLxdOfficeInitialActivationHistory } from "./lxd-office-activation-history.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { LxdOfficeOperationJournal } from "./lxd-office-operations.ts";
import { parseLxdOfficeResetSeed } from "./lxd-office-reset-journal.ts";
import {
	openLxdOfficeResetConfigurationJournal,
	openLxdOfficeResetServiceStartJournal,
} from "./lxd-office-reset-successor-journal.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

export type LxdOfficeResetHistoryClient = LxdOfficeServiceStartClient & Partial<LxdOfficeResetSuccessorClient>;
/** Historical facts, keyed by the immutable reset activation. No current SQL
 * authority, credential material, mutable workbench or guest file is read.
 * Later controls separately check their current authority and exact root files.
 * The permanent initial preparation remains the origin across root recreation. */
export async function readLxdOfficeResetActivationHistory(
	root: string,
	intentId: string,
	binding: LxdOfficeGuestBinding,
	activationId: string,
	read: (name: string) => Promise<unknown>,
	client: LxdOfficeResetHistoryClient,
	signal: AbortSignal,
) {
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
		throw new Error("reset activation index differs");
	const suffix = `${binding.allocationId}-${plan.resetId}`;
	const seed = parseLxdOfficeResetSeed(await read(`reset-seed-${suffix}.json`));
	const original = await readLxdOfficeInitialActivationHistory(root, intentId, binding, read, client, signal);
	if (
		seed.intentId !== intentId ||
		seed.planSha256 !== officeDigest(plan) ||
		seed.originalBootId !== original.command.bootId ||
		seed.attestation.activationId !== plan.predecessor.activationId ||
		seed.attestation.bootId !== plan.predecessor.startup.bootId ||
		seed.attestation.preparationObservationSha256 !== plan.preparationObservationSha256 ||
		plan.preparationObservationSha256 !== original.request.attestation.preparationObservationSha256 ||
		seed.adoptionReceiptSha256 !== original.request.attestation.adoptionReceiptSha256
	)
		throw new Error("reset permanent origin differs");
	const phases: CompanyComputerResetPhaseRecord[] = [];
	for (const [n, phase] of COMPANY_COMPUTER_RESET_PHASES.entries()) {
		const record = parseCompanyComputerResetPhaseRecord(await read(`reset-phase-${suffix}-${n + 1}.json`), plan);
		if (record.phase !== phase || record.previousSha256 !== (n ? officeDigest(phases[n - 1]) : null))
			throw new Error("reset phase history differs");
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
		throw new Error("reset custody binding differs");
	if (officeSha(custodyRecord.manifestSha256) !== officeDigest(custody))
		throw new Error("reset custody manifest digest differs");
	const custodySha256 = evidence("custodied", custody);
	const restore = parseCompanyComputerResetRestoreReceipt(
		await read(`reset-restore-${suffix}.json`),
		custody,
		plan,
		custodySha256,
	);
	const bootObservationSha256 = evidence("restored", restore);
	if (
		phaseHash("fenced") !== seed.planSha256 ||
		phaseHash("custodied") !== custodySha256 ||
		phaseHash("restored") !== bootObservationSha256 ||
		custodyRecord.schema !== "qorpera.lxd-office-reset-custody/v1" ||
		restore.bootId === seed.originalBootId ||
		restore.bootId === plan.predecessor.startup.bootId
	)
		throw new Error("reset custody history differs");
	const configurationRecord = officeRecord(await read(`reset-configuration-${suffix}.json`), [
		"schema",
		"resetId",
		"bootId",
		"command",
		"serviceBootstrapSha256",
	]);
	const configured = officeRecord(await read(`reset-configured-${suffix}.json`), [
		"schema",
		"resetId",
		"bootId",
		"commandId",
		"files",
	]);
	const configurationCommand = parseCompanyComputerPreparationCommand(configurationRecord.command);
	const expected: CompanyComputerResetConfigurationCompletion = {
		schema: "qorpera.office-reset-configuration-completion/v1",
		command: configurationCommand,
		resetId: plan.resetId,
		rootIncarnationId: plan.rootIncarnationId,
		activationId,
		originPreparationSha256: original.request.configuration.preparation.requestSha256,
		adoptionReceiptSha256: seed.adoptionReceiptSha256,
		files: configured.files as CompanyComputerResetConfigurationCompletion["files"],
	};
	const configuration = parseCompanyComputerResetConfigurationCompletion(expected, expected);
	const serviceBootstrapSha256 = officeSha(configurationRecord.serviceBootstrapSha256);
	if (
		!isDeepStrictEqual(configurationRecord, {
			schema: "qorpera.lxd-office-reset-configuration/v1",
			resetId: plan.resetId,
			bootId: restore.bootId,
			command: configurationCommand,
			serviceBootstrapSha256,
		}) ||
		!isDeepStrictEqual(configured, {
			schema: "qorpera.lxd-office-reset-configured/v1",
			resetId: plan.resetId,
			bootId: restore.bootId,
			commandId: configurationCommand.commandId,
			files: configuration.files,
		}) ||
		configurationCommand.bootId !== restore.bootId
	)
		throw new Error("reset configuration history differs");
	const request = parseCompanyComputerResetServiceStartRequest(await read(`reset-successor-prepared-${suffix}.json`));
	const successor = request.request;
	if (
		!isDeepStrictEqual(await read(`reset-successor-request-${suffix}.json`), successor) ||
		request.state !== "prepared" ||
		phaseHash("prepared") !== officeDigest(request) ||
		successor.resetId !== plan.resetId ||
		successor.rootIncarnationId !== plan.rootIncarnationId ||
		!isDeepStrictEqual(successor.predecessor, plan.predecessor) ||
		successor.custodySha256 !== custodySha256 ||
		successor.restoreSha256 !== bootObservationSha256 ||
		successor.attestation.activationId !== activationId ||
		successor.attestation.bootId !== restore.bootId ||
		successor.attestation.preparationObservationSha256 !== plan.preparationObservationSha256 ||
		successor.attestation.adoptionReceiptSha256 !== seed.adoptionReceiptSha256 ||
		successor.attestation.configurationSha256 !== configuration.files["config.json"].sha256 ||
		successor.attestation.configurationObservationSha256 !==
			officeDigest({
				schema: "qorpera.lxd-office-reset-configuration-observation/v1",
				resetId: plan.resetId,
				bootId: restore.bootId,
				commandId: configurationCommand.commandId,
				files: configuration.files,
				serviceBootstrapSha256,
			})
	)
		throw new Error("reset successor history differs");
	const start = officeRecord(await read(`reset-service-start-${suffix}.json`), ["schema", "resetId", "command"]);
	const command = parseCompanyComputerPreparationCommand(start.command);
	if (
		!isDeepStrictEqual(start, {
			schema: "qorpera.lxd-office-reset-service-start/v1",
			resetId: plan.resetId,
			command,
		}) ||
		command.requestSha256 !== officeDigest(request) ||
		command.bootId !== restore.bootId ||
		command.commandId === configurationCommand.commandId
	)
		throw new Error("reset start history differs");
	const marker = officeRecord(await read(`reset-service-started-${suffix}.json`), [
		"schema",
		"resetId",
		"commandId",
		"completion",
	]);
	const completion = parseCompanyComputerResetServiceStartCompletion(marker.completion, command, request);
	if (
		!isDeepStrictEqual(marker, {
			schema: "qorpera.lxd-office-reset-service-started/v1",
			resetId: plan.resetId,
			commandId: command.commandId,
			completion,
		}) ||
		completion.serviceInvocationId === plan.predecessor.startup.serviceInvocationId
	)
		throw new Error("reset started history differs");
	const done = await read(`reset-completed-${suffix}.json`);
	if (
		!isDeepStrictEqual(done, {
			schema: "qorpera.lxd-office-reset-completion/v1",
			resetId: plan.resetId,
			activationId,
			serviceInvocationId: completion.serviceInvocationId,
		}) ||
		phaseHash("active") !== officeDigest(done)
	)
		throw new Error("reset completion history differs");
	if (
		!client.submitOfficeResetConfiguration ||
		!client.inspectOfficeResetConfiguration ||
		!client.submitOfficeResetServiceStart ||
		!client.inspectOfficeResetServiceStart
	)
		throw new Error("reset history client unavailable");
	const configurationJournal = await openLxdOfficeResetConfigurationJournal(
		root,
		{
			intentId,
			binding,
			bootObservationSha256,
			command: configurationCommand,
			activationId,
			resetId: plan.resetId,
			originPreparationSha256: configuration.originPreparationSha256,
		},
		{
			submitOfficeResetConfiguration: client.submitOfficeResetConfiguration.bind(client),
			inspectOfficeResetConfiguration: client.inspectOfficeResetConfiguration.bind(client),
		},
	);
	const configurationOperation = await configurationJournal.observe(signal);
	const startJournal = await openLxdOfficeResetServiceStartJournal(
		root,
		{
			intentId,
			binding,
			bootObservationSha256,
			command,
			activationId,
			resetId: plan.resetId,
			configurationObservationSha256: successor.attestation.configurationObservationSha256,
		},
		{
			submitOfficeResetServiceStart: client.submitOfficeResetServiceStart.bind(client),
			inspectOfficeResetServiceStart: client.inspectOfficeResetServiceStart.bind(client),
		},
	);
	const startOperation = await startJournal.observe(signal);
	if (configurationOperation.state !== "succeeded" || startOperation.state === "not_dispatched")
		throw new Error("reset dispatch history unconfirmed");
	const commands = [
		...seed.commands,
		{ commandId: plan.commands.stopCommandId, action: "stop" as const },
		{ commandId: plan.commands.deleteCommandId, action: "delete" as const },
		{ commandId: plan.commands.createCommandId, action: "create" as const },
		{ commandId: plan.commands.startCommandId, action: "start" as const },
	];
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
		new Set(commands.map((item) => item.commandId)).size !== commands.length ||
		vm.events.length < commands.length * 3
	)
		throw new Error("reset VM history differs");
	for (const [n, item] of commands.entries()) {
		const group = vm.events.slice(n * 3, n * 3 + 3);
		if (
			group.some((event) => event.commandId !== item.commandId || event.action !== item.action) ||
			group[2].kind !== "settled" ||
			group[2].state !== "succeeded"
		)
			throw new Error("reset VM history differs");
	}
	signal.throwIfAborted();
	return {
		kind: "reset" as const,
		initial: false,
		plan,
		seed,
		request,
		command,
		marker,
		completion,
		configuration,
		configurationCommandIds: [configurationCommand.commandId],
		bootObservationSha256,
		hostBootId: seed.hostBootId,
		originalBootId: seed.originalBootId,
		commands,
		restore,
		custody,
		configurationCompletionSha256: completion.configurationCompletionSha256,
	};
}
