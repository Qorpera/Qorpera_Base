import { createHash, randomUUID, sign } from "node:crypto";
import {
	COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS,
	COMPANY_COMPUTER_CODE_PACKAGE_CAPABILITIES,
	COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS,
} from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import {
	verifyLxdOfficeCodePackageProvision,
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "../src/lxd-office-code-package-provision-verification.ts";
import {
	OFFICE_IMAGE_EXECUTABLES,
	officeImageDestination,
	renderOfficeImageMount,
} from "../src/lxd-office-image-installation.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import { verifyLxdOfficeServiceSoftware } from "../src/lxd-office-service-software.ts";
import { officeSoftwareFixture } from "./fixtures/office-software.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
	const old = officeSoftwareFixture();
	const base = structuredClone(old.previous),
		target = structuredClone(old.previous);
	const mountBytes = Buffer.from("[Mount]\nOptions=uid=@OFFICE_UID@,gid=@OFFICE_GID@\n");
	for (const manifest of [base, target])
		Object.assign(manifest.artifacts.find((a) => a.file === "qorpera-office-private.mount.in")!, {
			bytes: mountBytes.length,
			sha256: hash(mountBytes),
		});
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
		const rendered = Buffer.from(renderOfficeImageMount(mountBytes.toString(), 1000, 1000));
		const files = base.artifacts.map((a) => ({
			...((COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS as readonly string[]).includes(a.file)
				? { path: `/opt/qorpera-office/${a.file}`, mode: 0o444 }
				: officeImageDestination(a.file)),
			bytes: a.file === "qorpera-office-private.mount.in" ? rendered.length : a.bytes,
			sha256: a.file === "qorpera-office-private.mount.in" ? hash(rendered) : a.sha256,
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
		const manifests = {
			base: baseBytes,
			target: Buffer.from(JSON.stringify(target)),
			baseInstallationReceipt: Buffer.from(JSON.stringify(baseReceipt)),
			baseMountTemplate: mountBytes,
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
describe("pure signed code-only package verification", () => {
	it("allows exactly 14 code differences while retaining complete baseline inventory", () => {
		const f = fixture(),
			v = f.run();
		expect(v.changedArtifacts.map((a) => a.file)).toEqual([...COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS]);
		expect(v.targetArtifacts.length).toBe(v.baseArtifacts.length + 3);
		expect(v.inventorySha256).toBe(officeDigest(v.targetInstalledArtifacts));
		expect(v.targetInstalledArtifacts).toHaveLength(v.targetArtifacts.length + 4);
		expect(v.changedArtifacts.every((a) => a.mode === 0o444 && a.path.startsWith("/opt/qorpera-office/"))).toBe(true);
		expect(Object.isFrozen(v.targetArtifacts[0])).toBe(true);
		f.statement.target.service.sha256 = hash("caller mutation");
		expect(v.statement.target.service.sha256).not.toBe(f.statement.target.service.sha256);
	});
	it("requires a claimable measured revision even when base and target are identical", () => {
		const f = fixture();
		f.base.artifacts = structuredClone(f.target.artifacts);
		const v = f.run();
		expect(v.changedArtifacts).toEqual([]);
		expect(v.baseArtifacts).toEqual(v.targetArtifacts);
	});
	it.each(["render", "uid", "unit-reference", "bwrap", "extra-path", "template-bytes"])(
		"rejects a signed but inconsistent installed mapping %s",
		(kind) => {
			const f = fixture(),
				s = f.signed();
			const receipt = JSON.parse(s.manifests.baseInstallationReceipt.toString()) as {
				uid: number;
				files: { path: string; mode: number; bytes: number; sha256: string }[];
			};
			if (kind === "render")
				receipt.files.find((a) => a.path.endsWith(".mount"))!.sha256 = hash("unrendered template");
			if (kind === "uid") receipt.uid = 1001;
			if (kind === "unit-reference")
				receipt.files = receipt.files.filter(
					(a) => a.path !== "/opt/qorpera-office/qorpera-company-computer.service",
				);
			if (kind === "bwrap")
				receipt.files.find((a) => a.path.endsWith("/qorpera-browser-bwrap"))!.sha256 = hash("foreign binary");
			if (kind === "extra-path")
				receipt.files.push({ path: "/etc/unrelated", bytes: 1, mode: 0o444, sha256: hash("unexpected") });
			if (kind === "template-bytes") s.manifests.baseMountTemplate = Buffer.from("changed template");
			s.manifests.baseInstallationReceipt = Buffer.from(JSON.stringify(receipt));
			f.statement.compatibility.baseInstallationReceiptSha256 = hash(s.manifests.baseInstallationReceipt);
			s.trust.baseInstallationReceiptSha256 = f.statement.compatibility.baseInstallationReceiptSha256;
			f.plan.statementSha256 = officeDigest(f.statement);
			s.trust.statementSha256 = f.plan.statementSha256;
			s.trust.planSha256 = officeDigest(f.plan);
			s.envelope.signature.value = sign(
				null,
				Buffer.from(officeCanonical(f.statement)),
				f.old.keys.privateKey,
			).toString("base64");
			expect(() => verifyLxdOfficeCodePackageProvision(s.envelope, f.plan, s.trust, s.manifests, f.reset)).toThrow(
				"OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED",
			);
		},
	);
	it.each([
		"dependency",
		"unit",
		"wallpaper",
		"playwright",
		"addition",
		"removal",
		"reset-missing",
		"duplicate",
		"traversal",
		"overflow",
		"zero",
		"aggregate",
	])("rejects signed unsafe inventory %s", (kind) => {
		const f = fixture();
		if (kind === "dependency")
			f.target.artifacts.find((a) => a.file === "node_modules/playwright-core/package.json")!.sha256 =
				hash("tampered");
		if (kind === "unit") f.target.artifacts.find((a) => a.file === "qorpera-company-computer.service")!.bytes++;
		if (kind === "wallpaper")
			f.target.artifacts.find((a) => a.file.startsWith("wallpapers/"))!.sha256 = hash("wallpaper");
		if (kind === "playwright") f.target.playwright = "2.0.0";
		if (kind === "addition")
			f.target.artifacts.push({ file: "node_modules/playwright-core/extra.js", bytes: 1, sha256: hash("extra") });
		if (kind === "removal") f.target.artifacts = f.target.artifacts.filter((a) => a.file !== "LICENSE");
		if (kind === "reset-missing")
			f.target.artifacts = f.target.artifacts.filter(
				(a) => a.file !== COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS[0],
			);
		if (kind === "duplicate") f.target.artifacts.push(f.target.artifacts[0]);
		if (kind === "traversal") f.target.artifacts.push({ file: "../escape.mjs", bytes: 1, sha256: hash("escape") });
		if (kind === "overflow") f.target.artifacts[0].bytes = 32 * 1024 ** 2 + 1;
		if (kind === "zero") f.target.artifacts[0].bytes = 0;
		if (kind === "aggregate") for (const a of f.target.artifacts.slice(0, 5)) a.bytes = 32 * 1024 ** 2;
		expect(f.run).toThrow("OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED");
	});
	it.each([
		"key",
		"statement",
		"plan",
		"base-receipt",
		"dependencies",
		"unsigned",
		"manifest-bytes",
		"reset-binding",
		"image",
		"service",
		"command-reuse",
	])("rejects substituted trust or identity %s", (kind) => {
		const f = fixture();
		if (kind === "image") f.statement.base.imageSha256 = hash("other image");
		if (kind === "service") f.statement.target.service.sha256 = hash("other service");
		if (kind === "command-reuse") f.plan.installCommandId = f.reset.commands.createCommandId;
		const s = f.signed();
		if (kind === "key") s.trust.verificationKeySpki = fixture().old.trust.verificationKeySpki;
		if (kind === "statement") s.trust.statementSha256 = hash("other statement");
		if (kind === "plan") s.trust.planSha256 = hash("other plan");
		if (kind === "base-receipt") s.trust.baseInstallationReceiptSha256 = hash("other installation");
		if (kind === "dependencies") s.trust.unchangedExternalDependenciesSha256 = hash("other dependencies");
		if (kind === "unsigned") f.statement.target.sourceCommit = "f".repeat(40);
		if (kind === "manifest-bytes") s.manifests.target = Buffer.concat([s.manifests.target, Buffer.from(" ")]);
		if (kind === "reset-binding") f.reset.rootIncarnationId = randomUUID();
		expect(() => verifyLxdOfficeCodePackageProvision(s.envelope, f.plan, s.trust, s.manifests, f.reset)).toThrow(
			"OFFICE_CODE_PACKAGE_PROVISION_UNCONFIRMED",
		);
	});
	it("binds requests and historical receipts without granting installation authority", () => {
		const f = fixture(),
			v = f.run();
		const request = {
			schema: "qorpera.office-code-package-provision-request/v1",
			plan: v.plan,
			planSha256: v.planSha256,
			bootId: randomUUID(),
			restoreSha256: hash("restore"),
			challengeId: randomUUID(),
			targetRevision: 1,
			capabilityRevision: 1,
			targetManifestSha256: v.statement.target.packageManifestSha256,
		};
		expect(verifyLxdOfficeCodePackageProvisionRequest(request, v)).toEqual(request);
		const receipt = {
			schema: "qorpera.office-code-package-provision-receipt/v1",
			planSha256: v.planSha256,
			provisionId: v.plan.provisionId,
			resetId: v.plan.resetId,
			rootIncarnationId: v.plan.rootIncarnationId,
			bootId: request.bootId,
			commandId: v.plan.installCommandId,
			requestSha256: officeDigest(request),
			restoreSha256: request.restoreSha256,
			state: "installed",
			targetRevision: 1,
			packageManifestSha256: v.statement.target.packageManifestSha256,
			installedInventorySha256: v.inventorySha256,
			sourceCommit: v.statement.target.sourceCommit,
			runtimeBundle: v.statement.target.runtimeBundle,
			service: v.statement.target.service,
		};
		expect(verifyLxdOfficeCodePackageProvisionReceipt(receipt, request, v)).toEqual(receipt);
		for (const change of [
			{ bootId: randomUUID() },
			{ requestSha256: hash("changed request") },
			{ installedInventorySha256: hash("partial") },
			{ targetRevision: 2 },
			{ runtimeBundle: { ...receipt.runtimeBundle, version: 23 } },
		])
			expect(() => verifyLxdOfficeCodePackageProvisionReceipt({ ...receipt, ...change }, request, v)).toThrow();
		expect(() =>
			verifyLxdOfficeCodePackageProvisionRequest({ ...request, targetManifestSha256: hash("wrong") }, v),
		).toThrow();
	});
	it("retains service-only rejection of non-service code changes", () => {
		const f = officeSoftwareFixture();
		f.next.artifacts.find((a) => a.file === "qorpera-company-computer-preparation.mjs")!.sha256 =
			hash("changed preparation");
		f.manifests.next = Buffer.from(JSON.stringify(f.next));
		f.statement.next.packageManifestSha256 = hash(f.manifests.next);
		f.envelope.signature.value = sign(null, Buffer.from(officeCanonical(f.statement)), f.keys.privateKey).toString(
			"base64",
		);
		f.plan.statementSha256 = officeDigest(f.statement);
		f.trust.statementSha256 = f.plan.statementSha256;
		f.trust.planSha256 = officeDigest(f.plan);
		expect(() => verifyLxdOfficeServiceSoftware(f.envelope, f.plan, f.trust, f.manifests)).toThrow();
	});
});
