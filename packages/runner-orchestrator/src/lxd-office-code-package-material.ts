import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	type CompanyComputerResetPlan,
	parseCompanyComputerCodePackageProvisionEnvelope,
	parseCompanyComputerCodePackageProvisionPlan,
} from "@qorpera/contracts";
import {
	type LxdOfficeCodePackageLaneDocument,
	loadLxdOfficeCodePackageCapability,
	parseLxdOfficeCodePackageLaneDocument,
} from "./lxd-office-code-package-lane.ts";
import { verifyLxdOfficeCodePackageProvision } from "./lxd-office-code-package-provision-verification.ts";
import {
	readLxdOfficeCredentialFile,
	readLxdOfficeProtectedFile,
	readLxdOfficeProtectedImageManifestFile,
	readLxdOfficeProtectedPackageArtifactFile,
} from "./lxd-office-physical-host.ts";
import { type LxdOfficePhysicalPolicy, parseLxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
interface Ports {
	readProtected?: typeof readLxdOfficeProtectedFile;
	readManifest?: typeof readLxdOfficeProtectedImageManifestFile;
	readArtifact?: typeof readLxdOfficeProtectedPackageArtifactFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
}
/** Complete protected source preflight. No SQL, VM, staging or filesystem
 * mutation is performed here. Every staged code/tool byte is checked before a
 * new reset can enroll or cross its destructive boundary. */
export async function loadLxdOfficeCodePackageMaterial(
	documentValue: LxdOfficeCodePackageLaneDocument,
	policyValue: Readonly<LxdOfficePhysicalPolicy>,
	resetPlan: CompanyComputerResetPlan,
	signal: AbortSignal,
	ports: Ports = {},
) {
	const document = parseLxdOfficeCodePackageLaneDocument({
			schema: "qorpera.lxd-office-code-package-lane/v1",
			...documentValue,
		}),
		policy = parseLxdOfficePhysicalPolicy(policyValue);
	const read = ports.readProtected ?? readLxdOfficeProtectedFile,
		manifestRead = ports.readManifest ?? readLxdOfficeProtectedImageManifestFile,
		artifactRead = ports.readArtifact ?? readLxdOfficeProtectedPackageArtifactFile;
	const owned: Buffer[] = [];
	const retain = (bytes: Buffer) => {
		owned.push(bytes);
		signal.throwIfAborted();
		return bytes;
	};
	try {
		signal.throwIfAborted();
		const envelope = parseCompanyComputerCodePackageProvisionEnvelope(
			decode(retain(await read(document.envelopePath, 65536))),
		);
		const plan = parseCompanyComputerCodePackageProvisionPlan(decode(retain(await read(document.planPath, 65536))));
		const manifests = {
			base: retain(await manifestRead(document.baseManifestPath)),
			target: retain(await manifestRead(document.targetManifestPath)),
			baseInstallationReceipt: retain(await manifestRead(document.baseInstallationReceiptPath)),
			baseMountTemplate: retain(await read(document.baseMountTemplatePath, 65536)),
		};
		if (
			hash(manifests.base) !== policy.image.guestPackageManifestSha256 ||
			envelope.statement.base.imageSha256 !== policy.guest.imageFingerprint ||
			envelope.statement.base.bootstrapSha256 !== policy.guest.bootstrapSha256
		)
			throw new Error("base differs");
		const verified = verifyLxdOfficeCodePackageProvision(envelope, plan, document.trust, manifests, resetPlan);
		const artifacts = new Map<string, Buffer>();
		for (const file of COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS) {
			const expected = verified.targetArtifacts.find((a) => a.file === file);
			if (!expected) throw new Error("missing code");
			const bytes = retain(await artifactRead(join(document.artifactRoot, file), expected.bytes));
			if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error("code differs");
			artifacts.set(file, bytes);
		}
		const tools = {
			bootstrap: retain(await artifactRead(document.bootstrapToolPath, verified.statement.tools.bootstrap.bytes)),
			measure: retain(await artifactRead(document.measurementToolPath, verified.statement.tools.measure.bytes)),
		};
		for (const purpose of ["bootstrap", "measure"] as const)
			if (
				tools[purpose].length !== verified.statement.tools[purpose].bytes ||
				hash(tools[purpose]) !== verified.statement.tools[purpose].sha256
			)
				throw new Error("tool differs");
		const providerCapability = await loadLxdOfficeCodePackageCapability(
			document,
			ports.readCredential ?? readLxdOfficeCredentialFile,
		);
		signal.throwIfAborted();
		return {
			document,
			envelope,
			verified,
			manifests,
			artifacts,
			tools,
			providerCapability,
			dispose: () => {
				for (const bytes of owned) bytes.fill(0);
			},
		};
	} catch {
		for (const bytes of owned) bytes.fill(0);
		throw new Error("OFFICE_CODE_PACKAGE_MATERIAL_UNCONFIRMED");
	}
}
export type LxdOfficeCodePackageMaterial = Awaited<ReturnType<typeof loadLxdOfficeCodePackageMaterial>>;
