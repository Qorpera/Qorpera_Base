import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCompanyComputerResetPlan } from "@qorpera/contracts";
import { parseLxdOfficeCodePackageLaneDocument } from "./lxd-office-code-package-lane.ts";
import {
	verifyLxdOfficeCodePackageProvision,
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "./lxd-office-code-package-provision-verification.ts";
import { parseLxdOfficeCodePackageProbe } from "./lxd-office-code-package-transport.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { readLxdOfficeProtectedFile, readLxdOfficeProtectedImageManifestFile } from "./lxd-office-physical-host.ts";
import { assertLxdOfficePhysicalBinding, type LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface LxdOfficePackageHistoryPorts {
	readProtected?: typeof readLxdOfficeProtectedFile;
	readManifest?: typeof readLxdOfficeProtectedImageManifestFile;
}
/** Prior-root provenance uses only signed immutable public records. It never
 * loads a provider credential, follows current config, stages into the new root,
 * or restores prior authority. Actual current invocation proof remains separate. */
export async function assertLxdOfficeRetainedCodePackageRoot(
	root: string,
	binding: LxdOfficeGuestBinding,
	policy: Readonly<LxdOfficePhysicalPolicy>,
	rootIncarnationId: string,
	signal: AbortSignal,
	ports: LxdOfficePackageHistoryPorts = {},
) {
	assertLxdOfficePhysicalBinding(policy, binding);
	if (!idPattern.test(rootIncarnationId)) throw new Error("OFFICE_CODE_PACKAGE_PRIOR_ROOT_UNCONFIRMED");
	let match: string | undefined,
		scanned = 0,
		descriptors = 0;
	const directory = await opendir(root);
	for await (const entry of directory) {
		signal.throwIfAborted();
		if (++scanned > 32768) throw new Error("OFFICE_CODE_PACKAGE_HISTORY_LIMIT");
		const m = /^code-package-material-([0-9a-f-]{36})\.json$/.exec(entry.name);
		if (!m) continue;
		if (!idPattern.test(m[1]!) || !entry.isFile() || ++descriptors > 4096)
			throw new Error("OFFICE_CODE_PACKAGE_HISTORY_UNCONFIRMED");
		const r = officeRecord((await readRecord(join(root, entry.name), 65536)).value, [
				"schema",
				"binding",
				"document",
				"resetPlan",
			]),
			plan = parseCompanyComputerResetPlan(r.resetPlan);
		if (plan.rootIncarnationId !== rootIncarnationId) continue;
		if (
			match ||
			r.schema !== "qorpera.lxd-office-code-package-material/v1" ||
			!isDeepStrictEqual(r.binding, binding) ||
			plan.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding)
		)
			throw new Error("OFFICE_CODE_PACKAGE_PRIOR_ROOT_UNCONFIRMED");
		match = m[1];
	}
	if (!match) throw new Error("OFFICE_CODE_PACKAGE_PRIOR_ROOT_UNCONFIRMED");
	return readLxdOfficeCodePackagePublicHistory(root, binding, policy, match, signal, ports);
}
export async function readLxdOfficeCodePackagePublicHistory(
	root: string,
	binding: LxdOfficeGuestBinding,
	policy: Readonly<LxdOfficePhysicalPolicy>,
	id: string,
	signal: AbortSignal,
	ports: LxdOfficePackageHistoryPorts = {},
) {
	if (!idPattern.test(id)) throw new Error("OFFICE_CODE_PACKAGE_HISTORY_UNCONFIRMED");
	const read = ports.readProtected ?? readLxdOfficeProtectedFile,
		manifestRead = ports.readManifest ?? readLxdOfficeProtectedImageManifestFile,
		owned: Buffer[] = [];
	const retain = (b: Buffer) => {
		owned.push(b);
		signal.throwIfAborted();
		return b;
	};
	try {
		assertLxdOfficePhysicalBinding(policy, binding);
		const descriptor = officeRecord((await readRecord(join(root, `code-package-material-${id}.json`), 65536)).value, [
				"schema",
				"binding",
				"document",
				"resetPlan",
			]),
			resetPlan = parseCompanyComputerResetPlan(descriptor.resetPlan);
		if (
			descriptor.schema !== "qorpera.lxd-office-code-package-material/v1" ||
			!isDeepStrictEqual(descriptor.binding, binding) ||
			resetPlan.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding)
		)
			throw new Error("binding");
		const document = parseLxdOfficeCodePackageLaneDocument({
				schema: "qorpera.lxd-office-code-package-lane/v1",
				...(descriptor.document as object),
			}),
			r = officeRecord((await readRecord(join(root, `code-package-packet-${id}.json`), 4 * 1024 ** 2)).value, [
				"schema",
				"request",
				"resetPlan",
				"custody",
				"restore",
				"originPreparationSha256",
				"envelope",
			]);
		const requestValue = officeRecord(r.request, [
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
		const manifests = {
			base: retain(await manifestRead(document.baseManifestPath)),
			target: retain(await manifestRead(document.targetManifestPath)),
			baseInstallationReceipt: retain(await manifestRead(document.baseInstallationReceiptPath)),
			baseMountTemplate: retain(await read(document.baseMountTemplatePath, 65536)),
		};
		const verified = verifyLxdOfficeCodePackageProvision(
				r.envelope,
				requestValue.plan,
				document.trust,
				manifests,
				resetPlan,
			),
			request = verifyLxdOfficeCodePackageProvisionRequest(r.request, verified);
		if (
			verified.plan.provisionId !== id ||
			r.schema !== "qorpera.office-code-package-control/v1" ||
			!isDeepStrictEqual(r.resetPlan, resetPlan) ||
			createHash("sha256").update(manifests.base).digest("hex") !== policy.image.guestPackageManifestSha256 ||
			verified.statement.base.imageSha256 !== binding.imageFingerprint ||
			verified.statement.base.bootstrapSha256 !== binding.bootstrapSha256
		)
			throw new Error("identity");
		const original = (await readRecord(join(root, `code-package-original-${id}.json`), 16 * 1024 ** 2)).bytes,
			initial = (await readRecord(join(root, `preparation-request-${binding.allocationId}.json`), 16 * 1024 ** 2))
				.bytes;
		if (
			!original.equals(initial) ||
			createHash("sha256").update(original).digest("hex") !== r.originPreparationSha256
		)
			throw new Error("origin");
		const receipt = verifyLxdOfficeCodePackageProvisionReceipt(
				(await readRecord(join(root, `code-package-root-receipt-${id}.json`), 65536)).value,
				request,
				verified,
			),
			claim = officeRecord((await readRecord(join(root, `code-package-root-claim-${id}.json`), 65536)).value, [
				"schema",
				"requestSha256",
				"packetSha256",
				"probe",
			]);
		if (
			claim.schema !== "qorpera.office-code-package-install-claim/v1" ||
			claim.requestSha256 !== officeDigest(request) ||
			claim.packetSha256 !== officeDigest(r)
		)
			throw new Error("claim");
		const probe = officeRecord(claim.probe, [
			"schema",
			"purpose",
			"provisionId",
			"probeId",
			"packetSha256",
			"bootId",
			"challengeId",
			"nonce",
			"monotonicNs",
		]);
		parseLxdOfficeCodePackageProbe(probe, {
			purpose: "install",
			provisionId: id,
			probeId: probe.probeId as string,
			packetSha256: officeDigest(r),
			bootId: request.bootId,
			challengeId: request.challengeId,
		});
		const completed = officeRecord((await readRecord(join(root, `code-package-completed-${id}.json`), 65536)).value, [
			"schema",
			"packetSha256",
			"receipt",
			"evidenceSha256",
		]);
		if (
			completed.schema !== "qorpera.lxd-office-code-package-completed/v1" ||
			completed.packetSha256 !== officeDigest(r) ||
			!isDeepStrictEqual(completed.receipt, receipt)
		)
			throw new Error("completion");
		officeSha(completed.evidenceSha256);
		signal.throwIfAborted();
		return {
			provisionId: id,
			rootIncarnationId: resetPlan.rootIncarnationId,
			planSha256: verified.planSha256,
			receiptSha256: officeDigest(receipt),
			claimSha256: officeDigest(claim),
			receipt,
			claim,
		};
	} catch (error) {
		throw new Error("OFFICE_CODE_PACKAGE_HISTORY_UNCONFIRMED", { cause: error });
	} finally {
		for (const b of owned) b.fill(0);
	}
}
