import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Prepare one governed code-package provision for an office root reset: the
 * signed provision statement over the enrolled base image (its package
 * manifest, installation receipt and mount template) and the target package
 * (a code-only revision of the same package), the provision plan bound to the
 * operator's protected reset plan, the lane trust record and the lane document
 * the provider reads through `codePackageLanePath`. The statement is signed with
 * the operator's ed25519 image key. Everything is verified with the
 * repository's own verifier before it is written; nothing here enrolls,
 * dispatches or touches a node. The private key is read once and never
 * written. */
const OPTIONS = {
	"--base-manifest": "baseManifest",
	"--target-package": "targetPackage",
	"--installation-receipt": "installationReceipt",
	"--mount-template": "mountTemplate",
	// Only for a base that carries the company folder's mount template (F3 4e-2).
	"--folder-mount-template": "folderMountTemplate",
	"--tools": "tools",
	"--reset-plan": "resetPlan",
	"--policy": "policy",
	"--private-key": "privateKey",
	"--base-source-commit": "baseSourceCommit",
	"--target-source-commit": "targetSourceCommit",
	"--runtime-bundle-version": "runtimeBundleVersion",
	"--runtime-bundle-sha256": "runtimeBundleSha256",
	"--expected-software-revision": "expectedSoftwareRevision",
	"--target-revision": "targetRevision",
	"--evidence-sha256": "evidenceSha256",
	"--tested-at": "testedAt",
	"--lane-root": "laneRoot",
	"--capability-sha256": "capabilitySha256",
	"--repository": "repository",
	"--out": "out",
};
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
	const key = OPTIONS[process.argv[i]];
	if (!key || process.argv[i + 1] === undefined || key in args) throw new Error(`Usage: ${Object.keys(OPTIONS).join(" ")}`);
	args[key] = process.argv[i + 1];
}
for (const key of Object.values(OPTIONS))
	if (!(key in args) && !["testedAt", "repository", "folderMountTemplate"].includes(key)) throw new Error(`Missing ${key}`);
const root = resolve(args.repository ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const SHA = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/;
const hash = (b) => createHash("sha256").update(b).digest("hex");
const readJson = async (path) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(path)));

async function loadVerifier() {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-code-package-"));
	const outfile = join(temporary, "verifier.mjs");
	await build({
		absWorkingDir: root,
		stdin: {
			contents: [
				'export { verifyLxdOfficeCodePackageProvision } from "./packages/runner-orchestrator/src/lxd-office-code-package-provision-verification.ts";',
				'export { officeCanonical, officeDigest } from "./packages/runner-orchestrator/src/lxd-office-image-provenance.ts";',
				'export { parseLxdOfficeCodePackageLaneDocument } from "./packages/runner-orchestrator/src/lxd-office-code-package-lane.ts";',
				'export { parseCompanyComputerResetPlan } from "./packages/contracts/src/company-computer-reset.ts";',
				'export { COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS, COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES, parseCompanyComputerCodePackageProvisionEnvelope, parseCompanyComputerCodePackageProvisionPlan } from "./packages/contracts/src/company-computer-code-package-provision.ts";',
			].join("\n"),
			resolveDir: root,
			loader: "ts",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		legalComments: "none",
		logLevel: "silent",
	});
	return { module: await import(pathToFileURL(outfile).href), dispose: () => rm(temporary, { recursive: true, force: true }) };
}

const verifier = await loadVerifier();
try {
	const v = verifier.module;
	for (const [key, pattern] of [
		["baseSourceCommit", COMMIT],
		["targetSourceCommit", COMMIT],
		["runtimeBundleSha256", SHA],
		["evidenceSha256", SHA],
		["capabilitySha256", SHA],
	])
		if (!pattern.test(args[key])) throw new Error(`Invalid ${key}`);
	const runtimeBundleVersion = Number(args.runtimeBundleVersion), targetRevision = Number(args.targetRevision);
	const expectedSoftwareRevision = args.expectedSoftwareRevision === "null" ? null : Number(args.expectedSoftwareRevision);
	if (!Number.isSafeInteger(runtimeBundleVersion) || runtimeBundleVersion < 1 || !Number.isSafeInteger(targetRevision) || targetRevision < 1)
		throw new Error("Invalid revision or bundle version");
	if (expectedSoftwareRevision !== null && (!Number.isSafeInteger(expectedSoftwareRevision) || expectedSoftwareRevision < 0))
		throw new Error("Invalid expected software revision");
	const testedAt = args.testedAt ?? new Date().toISOString();
	if (Number.isNaN(Date.parse(testedAt))) throw new Error("Invalid tested-at");
	if (!args.laneRoot.startsWith("/") || resolve(args.laneRoot) !== args.laneRoot) throw new Error("Lane root must be an absolute normalized node path");

	const manifests = {
		base: await readFile(args.baseManifest),
		target: await readFile(join(args.targetPackage, "manifest.json")),
		baseInstallationReceipt: await readFile(args.installationReceipt),
		baseMountTemplate: await readFile(args.mountTemplate),
		...(args.folderMountTemplate && { baseFolderMountTemplate: await readFile(args.folderMountTemplate) }),
	};
	const policy = await readJson(args.policy);
	if (hash(manifests.base) !== policy.image.guestPackageManifestSha256) throw new Error("Base manifest is not the policy's enrolled image package");
	const reset = v.parseCompanyComputerResetPlan(await readJson(args.resetPlan));
	if (reset.predecessor.startup.imageSha256 !== policy.guest.imageFingerprint || reset.predecessor.startup.bootstrapSha256 !== policy.guest.bootstrapSha256)
		throw new Error("Reset plan predecessor is not the policy's guest image");
	const receipt = JSON.parse(manifests.baseInstallationReceipt.toString("utf8"));
	if (receipt.schema !== "qorpera.office-image-installation-receipt/v1" || receipt.packageManifestSha256 !== hash(manifests.base))
		throw new Error("Installation receipt does not describe the base package");
	if (hash(manifests.baseInstallationReceipt) !== reset.predecessor.startup.bootstrapSha256)
		throw new Error("Installation receipt digest differs from the predecessor's bootstrap digest");
	const target = JSON.parse(manifests.target.toString("utf8"));
	// Package manifests list file/bytes/sha256; the verifier derives the installed path.
	const SERVICE_PATH = "/opt/qorpera-office/qorpera-company-computer-service.mjs";
	const service = target.artifacts.find((a) => a.file === "qorpera-company-computer-service.mjs");
	if (!service) throw new Error("Target package has no service artifact");
	for (const file of v.COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS) {
		const a = target.artifacts.find((x) => x.file === file);
		if (!a) throw new Error(`Target package misses ${file}`);
		const bytes = await readFile(join(args.targetPackage, file));
		if (bytes.length !== a.bytes || hash(bytes) !== a.sha256) throw new Error(`Target artifact differs from its manifest: ${file}`);
	}
	const toolsManifest = await readJson(join(args.tools, "manifest.json"));
	if (toolsManifest.schema !== "qorpera.office-code-package-tools/v1") throw new Error("Tools manifest schema differs");
	const tools = {};
	for (const purpose of ["bootstrap", "measure"]) {
		const a = toolsManifest.artifacts.find((x) => x.purpose === purpose);
		const bytes = await readFile(join(args.tools, a.file));
		if (bytes.length !== a.bytes || hash(bytes) !== a.sha256) throw new Error(`Tool differs from its manifest: ${purpose}`);
		tools[purpose] = { file: a.file, bytes: a.bytes, sha256: a.sha256 };
	}
	const privateKey = createPrivateKey(await readFile(args.privateKey));
	const verificationKeySpki = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
	if (verificationKeySpki !== policy.image.verificationKeySpki) throw new Error("Signing key is not the policy's image verification key");

	const statement = {
		schema: "qorpera.office-code-package-provision-statement/v1",
		base: {
			imageSha256: reset.predecessor.startup.imageSha256,
			bootstrapSha256: reset.predecessor.startup.bootstrapSha256,
			packageManifestSha256: hash(manifests.base),
			sourceCommit: args.baseSourceCommit,
		},
		target: {
			packageManifestSha256: hash(manifests.target),
			sourceCommit: args.targetSourceCommit,
			runtimeBundle: { id: "qorpera.cloud-runtime", version: runtimeBundleVersion, sha256: args.runtimeBundleSha256 },
			service: { path: SERVICE_PATH, bytes: service.bytes, sha256: service.sha256 },
			capabilities: [...v.COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES],
		},
		tools: {
			bootstrap: { bytes: tools.bootstrap.bytes, sha256: tools.bootstrap.sha256 },
			measure: { bytes: tools.measure.bytes, sha256: tools.measure.sha256 },
		},
		compatibility: {
			baseInstallationReceiptSha256: hash(manifests.baseInstallationReceipt),
			unchangedExternalDependenciesSha256: v.officeDigest(receipt.dependencies),
		},
		acceptance: { testedAt, evidenceSha256: args.evidenceSha256, change: "code-only-package" },
	};
	const statementText = v.officeCanonical(statement);
	const envelope = {
		schema: "qorpera.office-code-package-provision-envelope/v1",
		statement,
		signature: { algorithm: "ed25519", value: sign(null, Buffer.from(statementText), privateKey).toString("base64") },
	};
	const plan = {
		schema: "qorpera.lxd-office-code-package-provision-plan/v1",
		provisionId: randomUUID(),
		resetId: reset.resetId,
		resetPlanSha256: v.officeDigest(reset),
		providerBindingSha256: reset.providerBindingSha256,
		rootIncarnationId: reset.rootIncarnationId,
		successorActivationId: reset.successorActivationId,
		statementSha256: v.officeDigest(statement),
		expectedSoftwareRevision,
		targetRevision,
		installCommandId: randomUUID(),
	};
	const trust = {
		verificationKeySpki,
		statementSha256: plan.statementSha256,
		planSha256: v.officeDigest(plan),
		...statement.compatibility,
	};
	const verified = v.verifyLxdOfficeCodePackageProvision(
		v.parseCompanyComputerCodePackageProvisionEnvelope(JSON.parse(JSON.stringify(envelope))),
		v.parseCompanyComputerCodePackageProvisionPlan(JSON.parse(JSON.stringify(plan))),
		trust,
		manifests,
		reset,
	);
	const laneRoot = args.laneRoot;
	const laneDocument = {
		schema: "qorpera.lxd-office-code-package-lane/v1",
		envelopePath: `${laneRoot}/envelope.json`,
		planPath: `${laneRoot}/plan.json`,
		baseManifestPath: `${laneRoot}/base-manifest.json`,
		targetManifestPath: `${laneRoot}/target-manifest.json`,
		artifactRoot: `${laneRoot}/artifacts`,
		baseInstallationReceiptPath: `${laneRoot}/base-installation-receipt.json`,
		baseMountTemplatePath: `${laneRoot}/base-mount-template`,
		...(args.folderMountTemplate && { baseFolderMountTemplatePath: `${laneRoot}/base-folder-mount-template` }),
		bootstrapToolPath: `${laneRoot}/tools/${tools.bootstrap.file}`,
		measurementToolPath: `${laneRoot}/tools/${tools.measure.file}`,
		trust,
		providerCapabilityCredential: { path: `${laneRoot}/package.capability`, bytes: 64, sha256: args.capabilitySha256 },
	};
	v.parseLxdOfficeCodePackageLaneDocument(laneDocument);
	const out = resolve(args.out);
	await mkdir(out, { recursive: false, mode: 0o700 });
	const write = async (name, bytes) => writeFile(join(out, name), bytes, { mode: 0o400 });
	await write("statement.canonical.json", statementText);
	await write("envelope.json", `${JSON.stringify(envelope, null, 2)}\n`);
	await write("plan.json", `${JSON.stringify(plan, null, 2)}\n`);
	await write("trust.json", `${JSON.stringify(trust, null, 2)}\n`);
	await write("lane-document.json", `${JSON.stringify(laneDocument, null, 2)}\n`);
	await write("reset-plan.json", `${JSON.stringify(reset, null, 2)}\n`);
	const summary = {
		schema: "qorpera.office-code-package-provision-preparation/v1",
		out,
		provisionId: plan.provisionId,
		installCommandId: plan.installCommandId,
		resetId: plan.resetId,
		resetPlanSha256: plan.resetPlanSha256,
		statementSha256: plan.statementSha256,
		planSha256: trust.planSha256,
		inventorySha256: verified.inventorySha256,
		changedArtifacts: verified.changedArtifacts.map((a) => a.file),
		base: statement.base,
		target: { packageManifestSha256: statement.target.packageManifestSha256, sourceCommit: statement.target.sourceCommit, service: statement.target.service },
		tools,
		laneRoot,
	};
	await write("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
	console.log(JSON.stringify(summary));
} finally {
	await verifier.dispose();
}
