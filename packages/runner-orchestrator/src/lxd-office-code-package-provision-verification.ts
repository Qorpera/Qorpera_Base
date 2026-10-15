import { createHash, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES,
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_MANIFEST_MAX_BYTES,
	COMPANY_COMPUTER_CODE_PACKAGE_MAX_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_TOTAL_MAX_BYTES,
	parseCompanyComputerCodePackageProvisionEnvelope,
	parseCompanyComputerCodePackageProvisionPlan,
	parseCompanyComputerCodePackageProvisionReceipt,
	parseCompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerResetPlan,
} from "@qorpera/contracts";
import {
	OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	parseOfficeImageInstallationSpec,
	parseOfficeImagePackage,
	renderOfficeImageMount,
} from "./lxd-office-image-installation.ts";
import {
	officeCanonical,
	officeDigest,
	officeImagePublicKey,
	officeRecord,
	officeSha,
} from "./lxd-office-image-provenance.ts";

export interface LxdOfficeCodePackageProvisionArtifact {
	readonly file: string;
	readonly path: string;
	readonly mode: number;
	readonly bytes: number;
	readonly sha256: string;
}
export interface LxdOfficeCodePackageProvisionTrust {
	readonly verificationKeySpki: string;
	readonly statementSha256: string;
	readonly planSha256: string;
	readonly baseInstallationReceiptSha256: string;
	readonly unchangedExternalDependenciesSha256: string;
}
export interface LxdOfficeCodePackageInstalledArtifact {
	readonly path: string;
	readonly mode: number;
	readonly bytes: number;
	readonly sha256: string;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const resets = new Set<string>(COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS);
const code = new Set<string>(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS);

/** Parse a complete inventory without changing the historical image parser's
 * requirements. Reset helpers are explicitly optional only in the base. */
function inventory(bytes: Buffer, expected: string) {
	if (
		!Buffer.isBuffer(bytes) ||
		bytes.length < 1 ||
		bytes.length > COMPANY_COMPUTER_CODE_PACKAGE_MANIFEST_MAX_BYTES ||
		hash(bytes) !== expected
	)
		throw new Error("package manifest differs");
	const raw = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
	const r = officeRecord(raw, ["schema", "platform", "minimumNode", "playwright", "artifacts", "imagePrerequisites"]);
	if (!Array.isArray(r.artifacts) || r.artifacts.length > COMPANY_COMPUTER_CODE_PACKAGE_MAX_ARTIFACTS)
		throw new Error("package inventory limit");
	const known = new Set<string>();
	const all = r.artifacts.map((value) => {
		const a = officeRecord(value, ["file", "bytes", "sha256"]);
		if (
			typeof a.file !== "string" ||
			known.has(a.file) ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 1 ||
			(a.bytes as number) > COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES
		)
			throw new Error("package artifact invalid");
		known.add(a.file);
		return { file: a.file, bytes: a.bytes as number, sha256: officeSha(a.sha256) };
	});
	if (all.reduce((total, a) => total + a.bytes, 0) > COMPANY_COMPUTER_CODE_PACKAGE_TOTAL_MAX_BYTES)
		throw new Error("package inventory total");
	const parsed = parseOfficeImagePackage({ ...r, artifacts: all.filter((a) => !resets.has(a.file)) });
	const artifacts = [
		...parsed.artifacts,
		...all
			.filter((a) => resets.has(a.file))
			.map((a) => ({ ...a, path: `/opt/qorpera-office/${a.file}`, mode: 0o444 })),
	]
		.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
		.map((a) => Object.freeze({ file: a.file, path: a.path, mode: a.mode, bytes: a.bytes, sha256: a.sha256 }));
	return { artifacts: Object.freeze(artifacts), playwright: parsed.playwright };
}

function installedInventory(
	base: readonly LxdOfficeCodePackageProvisionArtifact[],
	target: readonly LxdOfficeCodePackageProvisionArtifact[],
	receiptBytes: Buffer,
	mountBytes: Buffer,
	folderMountBytes: Buffer | undefined,
	statement: ReturnType<typeof parseCompanyComputerCodePackageProvisionEnvelope>["statement"],
) {
	if (
		!Buffer.isBuffer(receiptBytes) ||
		receiptBytes.length < 1 ||
		receiptBytes.length > COMPANY_COMPUTER_CODE_PACKAGE_MANIFEST_MAX_BYTES ||
		hash(receiptBytes) !== statement.compatibility.baseInstallationReceiptSha256
	)
		throw new Error("base installation receipt differs");
	const r = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(receiptBytes)), [
		"schema",
		"specSha256",
		"packageManifestSha256",
		"architecture",
		"uid",
		"gid",
		"dependencies",
		"files",
	]);
	if (
		r.schema !== "qorpera.office-image-installation-receipt/v1" ||
		r.packageManifestSha256 !== statement.base.packageManifestSha256 ||
		!Array.isArray(r.files)
	)
		throw new Error("base installation receipt invalid");
	officeSha(r.specSha256);
	const spec = parseOfficeImageInstallationSpec({
		schema: "qorpera.office-image-installation/v1",
		packageRoot: "/opt/qorpera-office",
		packageManifestSha256: r.packageManifestSha256,
		architecture: r.architecture,
		uid: r.uid,
		gid: r.gid,
		dependencies: r.dependencies,
	});
	if (officeDigest(spec.dependencies) !== statement.compatibility.unchangedExternalDependenciesSha256)
		throw new Error("base dependencies differ");
	// The installer renders each mount template with the office account's ids. Only newer packages carry the company
	// folder's, and its bytes come exactly when the base carries it.
	const rendered = new Map<string, Buffer>();
	for (const [file, bytes, required] of [
		["qorpera-office-private.mount.in", mountBytes, true],
		[`${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}.in`, folderMountBytes, false],
	] as const) {
		const template = base.find((a) => a.file === file);
		if (!required && !template && bytes === undefined) continue;
		if (!template || !Buffer.isBuffer(bytes) || bytes.length !== template.bytes || hash(bytes) !== template.sha256)
			throw new Error("base mount template differs");
		const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
		rendered.set(file, Buffer.from(renderOfficeImageMount(text, spec.uid, spec.gid)));
	}
	const expected: LxdOfficeCodePackageInstalledArtifact[] = base.map((a) => {
		const unit = rendered.get(a.file);
		return { path: a.path, mode: a.mode, bytes: unit?.length ?? a.bytes, sha256: unit ? hash(unit) : a.sha256 };
	});
	for (const file of ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"]) {
		const a = base.find((a) => a.file === file)!;
		expected.push({ path: `/opt/qorpera-office/${file}`, mode: 0o444, bytes: a.bytes, sha256: a.sha256 });
	}
	const files = r.files.map((value) => {
		const a = officeRecord(value, ["path", "bytes", "sha256", "mode"]);
		if (
			typeof a.path !== "string" ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 1 ||
			(a.bytes as number) > COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES ||
			!Number.isSafeInteger(a.mode)
		)
			throw new Error("base installed file invalid");
		return { path: a.path, mode: a.mode as number, bytes: a.bytes as number, sha256: officeSha(a.sha256) };
	});
	const bwrap = files.find((a) => a.path === "/usr/local/lib/qorpera/qorpera-browser-bwrap");
	if (!bwrap || bwrap.mode !== 0o555 || bwrap.sha256 !== spec.dependencies.executables["/usr/bin/bwrap"])
		throw new Error("base bwrap differs");
	expected.push(bwrap);
	const sort = <T extends { path: string }>(items: T[]) =>
		items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (!isDeepStrictEqual(sort(files), sort(expected)) || new Set(files.map((a) => a.path)).size !== files.length)
		throw new Error("base installed inventory differs");
	expected.push({
		path: "/opt/qorpera-office/installation.json",
		mode: 0o444,
		bytes: receiptBytes.length,
		sha256: hash(receiptBytes),
	});
	const baseInstalledArtifacts = Object.freeze(sort(expected).map((a) => Object.freeze(a)));
	const changedPaths = new Map(
		target
			.filter((a) => code.has(a.file))
			.map((a) => [a.path, { path: a.path, bytes: a.bytes, mode: a.mode, sha256: a.sha256 }]),
	);
	const targetFiles = baseInstalledArtifacts.map((a) => changedPaths.get(a.path) ?? a);
	for (const a of changedPaths.values())
		if (!baseInstalledArtifacts.some((before) => before.path === a.path)) targetFiles.push(a);
	const targetInstalledArtifacts = Object.freeze(sort(targetFiles).map((a) => Object.freeze(a)));
	return { baseInstalledArtifacts, targetInstalledArtifacts };
}

/** Pure signature/inventory verification only. It grants neither dispatch nor
 * activation authority and does not claim that any guest bytes were measured. */
export function verifyLxdOfficeCodePackageProvision(
	envelopeValue: unknown,
	planValue: unknown,
	trust: LxdOfficeCodePackageProvisionTrust,
	manifests: {
		base: Buffer;
		target: Buffer;
		baseInstallationReceipt: Buffer;
		baseMountTemplate: Buffer;
		baseFolderMountTemplate?: Buffer;
	},
	resetPlanValue: unknown,
) {
	try {
		const envelope = parseCompanyComputerCodePackageProvisionEnvelope(envelopeValue);
		const statement = envelope.statement;
		const plan = parseCompanyComputerCodePackageProvisionPlan(planValue);
		const reset = parseCompanyComputerResetPlan(resetPlanValue);
		const signature = Buffer.from(envelope.signature.value, "base64");
		if (
			signature.length !== 64 ||
			signature.toString("base64") !== envelope.signature.value ||
			officeDigest(statement) !== officeSha(trust.statementSha256) ||
			officeDigest(plan) !== officeSha(trust.planSha256) ||
			plan.statementSha256 !== trust.statementSha256 ||
			plan.resetPlanSha256 !== officeDigest(reset) ||
			plan.resetId !== reset.resetId ||
			plan.rootIncarnationId !== reset.rootIncarnationId ||
			plan.successorActivationId !== reset.successorActivationId ||
			plan.providerBindingSha256 !== reset.providerBindingSha256 ||
			statement.base.imageSha256 !== reset.predecessor.startup.imageSha256 ||
			statement.base.bootstrapSha256 !== reset.predecessor.startup.bootstrapSha256 ||
			statement.compatibility.baseInstallationReceiptSha256 !== officeSha(trust.baseInstallationReceiptSha256) ||
			statement.compatibility.unchangedExternalDependenciesSha256 !==
				officeSha(trust.unchangedExternalDependenciesSha256) ||
			!verify(
				null,
				Buffer.from(officeCanonical(statement)),
				officeImagePublicKey(trust.verificationKeySpki),
				signature,
			)
		)
			throw new Error("package trust differs");
		const reserved = [
			reset.intentId,
			reset.predecessor.transitionId,
			reset.predecessor.activationId,
			reset.predecessor.startup.allocationId,
			reset.predecessor.startup.bootId,
			...Object.values(reset.commands),
		];
		if (reserved.includes(plan.provisionId) || reserved.includes(plan.installCommandId))
			throw new Error("package command reused");
		const base = inventory(manifests.base, statement.base.packageManifestSha256);
		const target = inventory(manifests.target, statement.target.packageManifestSha256);
		if (base.playwright !== target.playwright) throw new Error("package dependency changed");
		const before = new Map(base.artifacts.map((a) => [a.file, a]));
		const after = new Map(target.artifacts.map((a) => [a.file, a]));
		if (
			COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS.some((file) => !after.has(file)) ||
			base.artifacts.some((a) => !after.has(a.file))
		)
			throw new Error("package artifact removed or missing");
		const changedArtifacts: Readonly<LxdOfficeCodePackageProvisionArtifact>[] = [];
		for (const a of target.artifacts) {
			const previous = before.get(a.file);
			if (!previous && !resets.has(a.file)) throw new Error("package addition outside reset helpers");
			if (isDeepStrictEqual(previous, a)) continue;
			if (!code.has(a.file) || a.path !== `/opt/qorpera-office/${a.file}` || a.mode !== 0o444)
				throw new Error("non-code package artifact changed");
			changedArtifacts.push(a);
		}
		const service = after.get("qorpera-company-computer-service.mjs");
		if (
			!service ||
			!isDeepStrictEqual(statement.target.service, {
				path: service.path,
				bytes: service.bytes,
				sha256: service.sha256,
			})
		)
			throw new Error("package service differs");
		const installed = installedInventory(
			base.artifacts,
			target.artifacts,
			manifests.baseInstallationReceipt,
			manifests.baseMountTemplate,
			manifests.baseFolderMountTemplate,
			statement,
		);
		return Object.freeze({
			statement,
			plan,
			planSha256: trust.planSha256,
			baseArtifacts: base.artifacts,
			targetArtifacts: target.artifacts,
			changedArtifacts: Object.freeze(changedArtifacts),
			...installed,
			inventorySha256: officeDigest(installed.targetInstalledArtifacts),
		});
	} catch {
		throw new Error("OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED");
	}
}
export type LxdOfficeVerifiedCodePackageProvision = ReturnType<typeof verifyLxdOfficeCodePackageProvision>;

export function verifyLxdOfficeCodePackageProvisionRequest(
	value: unknown,
	verified: LxdOfficeVerifiedCodePackageProvision,
) {
	const request = parseCompanyComputerCodePackageProvisionRequest(value);
	if (
		!isDeepStrictEqual(request.plan, verified.plan) ||
		request.planSha256 !== verified.planSha256 ||
		request.targetManifestSha256 !== verified.statement.target.packageManifestSha256
	)
		throw new Error("OFFICE_CODE_PACKAGE_REQUEST_UNCONFIRMED");
	return request;
}

/** Historical receipt binding only; provider measurement and current SQL
 * observation/activation challenges remain mandatory separate boundaries. */
export function verifyLxdOfficeCodePackageProvisionReceipt(
	value: unknown,
	requestValue: unknown,
	verified: LxdOfficeVerifiedCodePackageProvision,
) {
	const request = verifyLxdOfficeCodePackageProvisionRequest(requestValue, verified);
	const receipt = parseCompanyComputerCodePackageProvisionReceipt(value);
	if (
		!isDeepStrictEqual(receipt, {
			schema: "qorpera.office-code-package-provision-receipt/v1",
			planSha256: verified.planSha256,
			provisionId: request.plan.provisionId,
			resetId: request.plan.resetId,
			rootIncarnationId: request.plan.rootIncarnationId,
			bootId: request.bootId,
			commandId: request.plan.installCommandId,
			requestSha256: officeDigest(request),
			restoreSha256: request.restoreSha256,
			state: "installed",
			targetRevision: request.targetRevision,
			packageManifestSha256: verified.statement.target.packageManifestSha256,
			installedInventorySha256: verified.inventorySha256,
			sourceCommit: verified.statement.target.sourceCommit,
			runtimeBundle: verified.statement.target.runtimeBundle,
			service: verified.statement.target.service,
		})
	)
		throw new Error("OFFICE_CODE_PACKAGE_RECEIPT_UNCONFIRMED");
	return receipt;
}
