import { createHash } from "node:crypto";
import { join } from "node:path";
import { COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS, parseCompanyComputerResetPlan } from "@qorpera/contracts";
import { parseLxdOfficeCodePackageLaneDocument } from "../../src/lxd-office-code-package-lane.ts";
import type { LxdOfficeGuestBinding } from "../../src/lxd-office-guest.ts";
import type { LxdOfficePhysicalPolicy } from "../../src/lxd-office-physical-policy.ts";
import { lxdOfficePhysicalPolicySha256 } from "../../src/lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { officeCodePackageSignedFixture } from "./office-code-package-signed.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function officeCodePackageMaterialFixture(
	options: {
		configure?: (fixture: ReturnType<typeof officeCodePackageSignedFixture>) => void;
		policy?: LxdOfficePhysicalPolicy;
		binding?: LxdOfficeGuestBinding;
	} = {},
) {
	const f = officeCodePackageSignedFixture(),
		files = new Map<string, Buffer>(),
		readBuffers: Buffer[] = [],
		reads: string[] = [];
	options.configure?.(f);
	for (const file of COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS) {
		const b = Buffer.from(`reviewed synthetic ${file}`);
		files.set(`/protected/artifacts/${file}`, b);
		Object.assign(f.target.artifacts.find((a) => a.file === file)!, { bytes: b.length, sha256: hash(b) });
	}
	const service = f.target.artifacts.find((a) => a.file === "qorpera-company-computer-service.mjs")!;
	Object.assign(f.statement.target.service, { bytes: service.bytes, sha256: service.sha256 });
	for (const purpose of ["bootstrap", "measure"] as const) {
		const b = Buffer.from(`reviewed synthetic ${purpose}`);
		files.set(`/protected/${purpose}.cjs`, b);
		f.statement.tools[purpose] = { bytes: b.length, sha256: hash(b) };
	}
	let signed = f.signed();
	const capability = hash(Buffer.from("synthetic provider capability preimage")),
		physical = officePhysicalFixture();
	if (options.policy) physical.policy = options.policy;
	else {
		physical.policy.guest.imageFingerprint = f.statement.base.imageSha256;
		physical.policy.guest.bootstrapSha256 = f.statement.base.bootstrapSha256;
		physical.policy.image.guestPackageManifestSha256 = hash(signed.manifests.base);
	}
	const binding = options.binding ?? {
		...physical.binding,
		...physical.policy.guest,
		providerPolicySha256: lxdOfficePhysicalPolicySha256(physical.policy),
	};
	f.reset.providerBindingSha256 = lxdOfficeProviderBindingSha256(binding);
	f.plan.providerBindingSha256 = f.reset.providerBindingSha256;
	signed = f.signed();
	const document = parseLxdOfficeCodePackageLaneDocument({
		schema: "qorpera.lxd-office-code-package-lane/v1",
		envelopePath: "/protected/envelope.json",
		planPath: "/protected/plan.json",
		baseManifestPath: "/protected/base.json",
		targetManifestPath: "/protected/target.json",
		baseInstallationReceiptPath: "/protected/installation.json",
		baseMountTemplatePath: "/protected/mount.in",
		artifactRoot: "/protected/artifacts",
		bootstrapToolPath: "/protected/bootstrap.cjs",
		measurementToolPath: "/protected/measure.cjs",
		trust: signed.trust,
		providerCapabilityCredential: { path: "/protected/capability", bytes: 64, sha256: hash(Buffer.from(capability)) },
	});
	for (const [path, b] of [
		[document.envelopePath, Buffer.from(JSON.stringify(signed.envelope))],
		[document.planPath, Buffer.from(JSON.stringify(f.plan))],
		[document.baseManifestPath, signed.manifests.base],
		[document.targetManifestPath, signed.manifests.target],
		[document.baseInstallationReceiptPath, signed.manifests.baseInstallationReceipt],
		[document.baseMountTemplatePath, signed.manifests.baseMountTemplate],
		[document.providerCapabilityCredential.path, Buffer.from(capability)],
	] as const)
		files.set(path, b);
	const read = async (path: string, maximum = 1024 ** 2) => {
		reads.push(path);
		const b = files.get(path);
		if (!b || b.length > maximum) throw new Error("missing/large");
		const copy = Buffer.from(b);
		readBuffers.push(copy);
		return copy;
	};
	return {
		...f,
		...signed,
		policy: physical.policy,
		binding,
		resetPlan: parseCompanyComputerResetPlan(f.reset),
		document,
		files,
		reads,
		readBuffers,
		capability,
		ports: { readProtected: read, readManifest: read, readArtifact: read, readCredential: read },
		artifactPath: (file: string) => join(document.artifactRoot, file),
	};
}
