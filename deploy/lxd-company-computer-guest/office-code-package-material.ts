import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResetRestorablePath,
	companyComputerStopHistoryDirectory,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetCustodyManifest,
	parseCompanyComputerResetPlan,
	parseCompanyComputerResetRestoreReceipt,
	parseCompanyComputerStopHistoryManifest,
} from "../../packages/contracts/src/index.ts";
import { officeCodePackageStage } from "../../packages/runner-orchestrator/src/lxd-office-code-package-loader.ts";
import {
	type LxdOfficeCodePackageInstalledArtifact,
	type LxdOfficeCodePackageProvisionTrust,
	verifyLxdOfficeCodePackageProvision,
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "../../packages/runner-orchestrator/src/lxd-office-code-package-provision-verification.ts";
import { inspectOfficeImageDependencies } from "../../packages/runner-orchestrator/src/lxd-office-image-installation-host.ts";
import {
	officeCanonical,
	officeDigest,
	officeRecord,
	officeSha,
} from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import { createCompanyComputerBootConfigurationSystemdManager } from "../../packages/runtime/src/cloud-company-computer-boot-configuration-control.ts";
import { assertCompanyComputerPreparationLockAndBoot } from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";
import {
	assertCompanyComputerResetRootClean,
	verifyCompanyComputerResetPredecessorHistory,
} from "../../packages/runtime/src/cloud-company-computer-reset-successor-evidence.ts";
import { openCompanyComputerRetainedWorkbench } from "../../packages/runtime/src/cloud-company-computer-retained-workbench.ts";
import {
	assertPackageInventoryStamps,
	packageDirectory,
	packageHash,
	readPackageFile,
	readPackageInventory,
} from "./office-code-package-files.ts";

export const packageDecode = (bytes: Buffer): unknown =>
	JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
export const packageEncode = (v: unknown): Buffer => Buffer.from(officeCanonical(v));
export const packageJournal = (id: string) =>
	`/etc/qorpera-office/code-packages/${officeCodePackageStage(id).split("code-package-")[1]}`;
export const packageCommand = (m: OfficeCodePackageMaterial, bootId = m.request.bootId) => ({
	commandId: m.request.plan.installCommandId,
	requestSha256: officeDigest(m.request),
	bootId,
});
/** Exact protected public material, with independently supplied packet/trust
 * pins. Contains no current or historical registry/provider credential. */
export async function loadOfficeCodePackageMaterial(id: string, packetSha: string, trustSha: string) {
	const root = officeCodePackageStage(id);
	await packageDirectory(root, 0o700);
	const retained: Array<{ path: string; stamp: Record<string, string> }> = [];
	const read = async (name: string, limit: number) => {
		const path = `${root}/${name}`,
			result = await readPackageFile(path, limit, 0o400);
		retained.push({ path, stamp: result.stamp });
		return result.bytes;
	};
	const packetBytes = await read("packet.json", 4 * 1024 ** 2),
		trustBytes = await read("trust.json", 4096);
	if (packageHash(packetBytes) !== officeSha(packetSha) || packageHash(trustBytes) !== officeSha(trustSha))
		throw new Error("CODE_PACKAGE_MATERIAL_PIN");
	const packet = officeRecord(packageDecode(packetBytes), [
		"schema",
		"request",
		"resetPlan",
		"custody",
		"restore",
		"originPreparationSha256",
		"envelope",
	]);
	if (packet.schema !== "qorpera.office-code-package-control/v1") throw new Error("CODE_PACKAGE_PACKET");
	const trust = officeRecord(packageDecode(trustBytes), [
		"verificationKeySpki",
		"statementSha256",
		"planSha256",
		"baseInstallationReceiptSha256",
		"unchangedExternalDependenciesSha256",
	]);
	if (typeof trust.verificationKeySpki !== "string") throw new Error("CODE_PACKAGE_TRUST");
	const trusted: LxdOfficeCodePackageProvisionTrust = {
		verificationKeySpki: trust.verificationKeySpki,
		statementSha256: officeSha(trust.statementSha256),
		planSha256: officeSha(trust.planSha256),
		baseInstallationReceiptSha256: officeSha(trust.baseInstallationReceiptSha256),
		unchangedExternalDependenciesSha256: officeSha(trust.unchangedExternalDependenciesSha256),
	};
	const reset = parseCompanyComputerResetPlan(packet.resetPlan);
	const req = officeRecord(packet.request, [
		"schema",
		"plan",
		"planSha256",
		"bootId",
		"restoreSha256",
		"challengeId",
		"targetRevision",
		"capabilityRevision",
		"targetManifestSha256",
	]);
	const verified = verifyLxdOfficeCodePackageProvision(
		packet.envelope,
		req.plan,
		trusted,
		{
			base: await read("base-manifest.json", 1024 ** 2),
			target: await read("target-manifest.json", 1024 ** 2),
			baseInstallationReceipt: await read("base-installation.json", 1024 ** 2),
			baseMountTemplate: await read("base-mount-template", 65536),
		},
		reset,
	);
	const request = verifyLxdOfficeCodePackageProvisionRequest(packet.request, verified);
	const custody = parseCompanyComputerResetCustodyManifest(packet.custody, reset);
	const phaseDigest = (phase: "custodied" | "restored", observation: unknown) =>
		officeDigest({ schema: "qorpera.office-reset-phase-evidence/v1", resetId: reset.resetId, phase, observation });
	const restore = parseCompanyComputerResetRestoreReceipt(
		packet.restore,
		custody,
		reset,
		phaseDigest("custodied", custody),
	);
	const originalBytes = await read("original-preparation.json", COMPANY_COMPUTER_PREPARATION_MAX_BYTES),
		original = parseCompanyComputerPreparationRequest(packageDecode(originalBytes));
	if (packageHash(originalBytes) !== officeSha(packet.originPreparationSha256))
		throw new Error("CODE_PACKAGE_PREPARATION_PIN");
	const adoptionBytes = Buffer.from(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`);
	if (
		id !== request.plan.provisionId ||
		request.bootId !== restore.bootId ||
		request.restoreSha256 !== phaseDigest("restored", restore) ||
		custody.nas.adoptionId !== original.copy.adoptionId ||
		original.bootId === request.bootId ||
		original.allocationId !== reset.predecessor.startup.allocationId ||
		original.imageSha256 !== verified.statement.base.imageSha256 ||
		original.bootstrapSha256 !== verified.statement.base.bootstrapSha256 ||
		original.instanceSha256 !== reset.predecessor.startup.instanceSha256 ||
		!isDeepStrictEqual(original.scope, reset.predecessor.startup.scope) ||
		original.computerGeneration !== reset.predecessor.startup.computerGeneration
	)
		throw new Error("CODE_PACKAGE_RESET_BINDING");
	for (const name of ["bootstrap", "measure"] as const) {
		const bytes = await read(`${name}.cjs`, 16 * 1024 ** 2),
			expected = verified.statement.tools[name];
		if (bytes.length !== expected.bytes || packageHash(bytes) !== expected.sha256)
			throw new Error("CODE_PACKAGE_TOOL_BINDING");
	}
	return {
		root,
		packetSha,
		trustSha,
		verified,
		request,
		reset,
		custody,
		restore,
		original,
		originalBytes,
		adoptionBytes,
		verifyMaterial: () => assertPackageInventoryStamps(retained),
	};
}
export type OfficeCodePackageMaterial = Awaited<ReturnType<typeof loadOfficeCodePackageMaterial>>;

/** One deterministic receipt for normal publication and observation-only
 * recovery after every signed target byte has been independently measured. */
export function officeCodePackageReceipt(m: OfficeCodePackageMaterial) {
	return verifyLxdOfficeCodePackageProvisionReceipt(
		{
			schema: "qorpera.office-code-package-provision-receipt/v1",
			planSha256: m.verified.planSha256,
			provisionId: m.request.plan.provisionId,
			resetId: m.request.plan.resetId,
			rootIncarnationId: m.request.plan.rootIncarnationId,
			bootId: m.request.bootId,
			commandId: m.request.plan.installCommandId,
			requestSha256: officeDigest(m.request),
			restoreSha256: m.request.restoreSha256,
			state: "installed",
			targetRevision: m.request.targetRevision,
			packageManifestSha256: m.verified.statement.target.packageManifestSha256,
			installedInventorySha256: m.verified.inventorySha256,
			sourceCommit: m.verified.statement.target.sourceCommit,
			runtimeBundle: m.verified.statement.target.runtimeBundle,
			service: m.verified.statement.target.service,
		},
		m.request,
		m.verified,
	);
}
const inactive = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
/** Fresh-root predicates remain in force until installation has been measured.
 * This function restores nothing, reads no credential and starts no unit. */
export async function openOfficeCodePackageFreshRoot(m: OfficeCodePackageMaterial, signal: AbortSignal) {
	const command = packageCommand(m);
	await assertCompanyComputerPreparationLockAndBoot(command);
	const workbench = await openCompanyComputerRetainedWorkbench(m.original, signal);
	const manager = createCompanyComputerBootConfigurationSystemdManager();
	try {
		const immutable = new Map<string, { path: string; bytes: number; sha256: string; mode: number }>(
			m.custody.history.files.filter((f) => companyComputerResetRestorablePath(f.path)).map((f) => [f.path, f]),
		);
		const historyRoot = companyComputerStopHistoryDirectory(
			m.reset.predecessor.startup.bootId,
			m.reset.predecessor.activationId,
		);
		const manifestBytes = (await readPackageFile(`${historyRoot}/manifest.json`, 65536, 0o600)).bytes;
		if (packageHash(manifestBytes) !== m.custody.history.manifestSha256)
			throw new Error("CODE_PACKAGE_RESTORED_HISTORY");
		const manifest = parseCompanyComputerStopHistoryManifest(
			packageDecode(manifestBytes),
			m.reset.predecessor.startup.bootId,
			m.reset.predecessor.activationId,
		);
		// Capture every actual archive file even if the custody list omits a blob.
		// The semantic check below proves the exact predecessor stop once; held
		// flock plus these immutable stamps fence changes before every effect.
		for (const file of [
			{
				path: `${historyRoot}/manifest.json`,
				bytes: manifestBytes.length,
				sha256: m.custody.history.manifestSha256,
				mode: 0o600,
			},
			{
				path: `${historyRoot}/claim.json`,
				bytes: manifestBytes.length,
				sha256: m.custody.history.manifestSha256,
				mode: 0o600,
			},
			...manifest.entries.map((entry) => ({
				path: `${historyRoot}/${entry.sha256}.json`,
				bytes: entry.bytes,
				sha256: entry.sha256,
				mode: 0o600,
			})),
			{
				path: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
				bytes: m.adoptionBytes.length,
				sha256: packageHash(m.adoptionBytes),
				mode: 0o444,
			},
		]) {
			const prior = immutable.get(file.path);
			if (prior && (prior.bytes !== file.bytes || prior.sha256 !== file.sha256 || prior.mode !== file.mode))
				throw new Error("CODE_PACKAGE_RESTORED_HISTORY");
			immutable.set(file.path, file);
		}
		const stamps = await readPackageInventory([...immutable.values()], signal);
		if (
			(await verifyCompanyComputerResetPredecessorHistory(m.reset.predecessor, command, signal)) !==
			m.custody.history.manifestSha256
		)
			throw new Error("CODE_PACKAGE_RESTORED_HISTORY");
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await assertCompanyComputerResetRootClean(m.reset.successorActivationId, command.bootId);
			await m.verifyMaterial();
			await workbench.verify();
			await assertPackageInventoryStamps(stamps);
			const state = await manager.inspect(signal);
			if (
				!isDeepStrictEqual(state.preparation, inactive) ||
				!isDeepStrictEqual(state.service, { ...inactive, controlGroup: "", restarts: 0 }) ||
				!["absent", "empty"].includes(state.cgroupState)
			)
				throw new Error("CODE_PACKAGE_ROOT_STARTED");
			signal.throwIfAborted();
		};
		await verify();
		return { verify, close: workbench.close };
	} catch (e) {
		await workbench.close();
		throw e;
	}
}
export async function measureOfficeCodePackageInventory(
	artifacts: readonly LxdOfficeCodePackageInstalledArtifact[],
	signal: AbortSignal,
) {
	return readPackageInventory(artifacts, signal);
}
export async function measureOfficeCodePackageExternal(m: OfficeCodePackageMaterial) {
	if (
		officeDigest(await inspectOfficeImageDependencies()) !==
		m.verified.statement.compatibility.unchangedExternalDependenciesSha256
	)
		throw new Error("CODE_PACKAGE_EXTERNAL_DEPENDENCIES");
}
