import { createHash, randomUUID, sign } from "node:crypto";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
	COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS,
} from "@qorpera/contracts";
import { verifyLxdOfficeCodePackageProvision } from "../../src/lxd-office-code-package-provision-verification.ts";
import {
	OFFICE_IMAGE_EXECUTABLES,
	OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	OFFICE_IMAGE_FOLDER_PACKAGE_FILES,
	officeImageDestination,
	renderOfficeImageMount,
} from "../../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import { officeSoftwareFixture } from "./office-software.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function officeCodePackageSignedFixture(options: { folder?: boolean } = {}) {
	const old = officeSoftwareFixture();
	const base = structuredClone(old.previous),
		target = structuredClone(old.previous);
	const mountBytes = Buffer.from("[Mount]\nOptions=uid=@OFFICE_UID@,gid=@OFFICE_GID@\n");
	for (const manifest of [base, target])
		Object.assign(manifest.artifacts.find((a) => a.file === "qorpera-office-private.mount.in")!, {
			bytes: mountBytes.length,
			sha256: hash(mountBytes),
		});
	// Newer bases carry the company folder's group (F3 4e-2). A code package keeps it as it is.
	const folderMountFile = `${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}.in`;
	const folderMountBytes = Buffer.from(
		"[Service]\nExecStart=qorpera-folder mount --owner-uid @OFFICE_UID@ --owner-gid @OFFICE_GID@\n",
	);
	if (options.folder)
		for (const manifest of [base, target])
			for (const file of OFFICE_IMAGE_FOLDER_PACKAGE_FILES) {
				const bytes = file === folderMountFile ? folderMountBytes : Buffer.from(`folder:${file}`);
				manifest.artifacts.push({ file, bytes: bytes.length, sha256: hash(bytes) });
			}
	for (const file of COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS) {
		const artifact = { file, bytes: 456, sha256: hash(`next:${file}`) };
		const index = target.artifacts.findIndex((a) => a.file === file);
		if (index < 0) target.artifacts.push(artifact);
		else target.artifacts[index] = artifact;
	}
	const reset = {
		schema: "qorpera.lxd-office-reset-plan/v1",
		resetId: randomUUID(),
		intentId: randomUUID(),
		predecessor: { ...old.plan.predecessor, action: "replace" },
		predecessorRootIncarnationId: null,
		rootIncarnationId: randomUUID(),
		successorActivationId: randomUUID(),
		providerBindingSha256: hash("binding"),
		preparationObservationSha256: hash("preparation"),
		nodeId: null,
		commands: {
			stopCommandId: randomUUID(),
			deleteCommandId: randomUUID(),
			createCommandId: randomUUID(),
			startCommandId: randomUUID(),
		},
		custody: { archiveRoot: "/srv/qorpera/reset-archive" },
	};
	const targetService = target.artifacts.find((a) => a.file === "qorpera-company-computer-service.mjs")!;
	const statement = {
		schema: "qorpera.office-code-package-provision-statement/v1",
		base: { ...old.statement.base },
		target: {
			packageManifestSha256: "",
			sourceCommit: "b".repeat(40),
			runtimeBundle: { id: "qorpera.cloud-runtime", version: 24, sha256: hash("bundle") },
			service: {
				path: "/opt/qorpera-office/qorpera-company-computer-service.mjs",
				bytes: targetService.bytes,
				sha256: targetService.sha256,
			},
			capabilities: [...COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES],
		},
		tools: {
			bootstrap: { bytes: 500, sha256: hash("bootstrap tool") },
			measure: { bytes: 400, sha256: hash("measure tool") },
		},
		compatibility: {
			baseInstallationReceiptSha256: hash("installation"),
			unchangedExternalDependenciesSha256: hash("dependencies"),
		},
		acceptance: { testedAt: "2026-09-12T00:00:00.000Z", evidenceSha256: hash("proof"), change: "code-only-package" },
	};
	const plan = {
		schema: "qorpera.lxd-office-code-package-provision-plan/v1",
		provisionId: randomUUID(),
		resetId: reset.resetId,
		resetPlanSha256: "",
		providerBindingSha256: reset.providerBindingSha256,
		rootIncarnationId: reset.rootIncarnationId,
		successorActivationId: reset.successorActivationId,
		statementSha256: "",
		expectedSoftwareRevision: null,
		targetRevision: 1,
		installCommandId: randomUUID(),
	};
	function signed() {
		const dependencies = {
			osReleaseSha256: hash("os"),
			dpkgManifestSha256: hash("dpkg"),
			browserTreeSha256: hash("browser"),
			executables: Object.fromEntries(OFFICE_IMAGE_EXECUTABLES.map((p) => [p, hash(p)])),
		};
		const rendered = new Map<string, Buffer>();
		for (const [file, bytes] of [
			["qorpera-office-private.mount.in", mountBytes],
			[folderMountFile, folderMountBytes],
		] as const)
			rendered.set(file, Buffer.from(renderOfficeImageMount(bytes.toString(), 1000, 1000)));
		const files = base.artifacts.map((a) => ({
			...((COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS as readonly string[]).includes(a.file)
				? { path: `/opt/qorpera-office/${a.file}`, mode: 0o444 }
				: officeImageDestination(a.file)),
			bytes: rendered.get(a.file)?.length ?? a.bytes,
			sha256: rendered.has(a.file) ? hash(rendered.get(a.file)!) : a.sha256,
		}));
		for (const file of ["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"]) {
			const a = base.artifacts.find((a) => a.file === file)!;
			files.push({ path: `/opt/qorpera-office/${file}`, mode: 0o444, bytes: a.bytes, sha256: a.sha256 });
		}
		files.push({
			path: "/usr/local/lib/qorpera/qorpera-browser-bwrap",
			mode: 0o555,
			bytes: 100,
			sha256: dependencies.executables["/usr/bin/bwrap"],
		});
		const baseBytes = Buffer.from(JSON.stringify(base));
		const baseReceipt = {
			schema: "qorpera.office-image-installation-receipt/v1",
			specSha256: hash("spec"),
			packageManifestSha256: hash(baseBytes),
			architecture: "x64",
			uid: 1000,
			gid: 1000,
			dependencies,
			files,
		};
		const manifests: Parameters<typeof verifyLxdOfficeCodePackageProvision>[3] = {
			base: baseBytes,
			target: Buffer.from(JSON.stringify(target)),
			baseInstallationReceipt: Buffer.from(JSON.stringify(baseReceipt)),
			baseMountTemplate: mountBytes,
			...(options.folder ? { baseFolderMountTemplate: folderMountBytes } : {}),
		};
		statement.compatibility = {
			baseInstallationReceiptSha256: hash(manifests.baseInstallationReceipt),
			unchangedExternalDependenciesSha256: officeDigest(dependencies),
		};
		statement.base.packageManifestSha256 = hash(manifests.base);
		statement.target.packageManifestSha256 = hash(manifests.target);
		plan.statementSha256 = officeDigest(statement);
		plan.resetPlanSha256 = officeDigest(reset);
		const envelope = {
			schema: "qorpera.office-code-package-provision-envelope/v1",
			statement,
			signature: {
				algorithm: "ed25519",
				value: sign(null, Buffer.from(officeCanonical(statement)), old.keys.privateKey).toString("base64"),
			},
		};
		const trust = {
			verificationKeySpki: old.trust.verificationKeySpki,
			statementSha256: plan.statementSha256,
			planSha256: officeDigest(plan),
			...statement.compatibility,
		};
		return { envelope, trust, manifests };
	}
	const run = () => {
		const f = signed();
		return verifyLxdOfficeCodePackageProvision(f.envelope, plan, f.trust, f.manifests, reset);
	};
	return { old, base, target, statement, plan, reset, signed, run };
}
