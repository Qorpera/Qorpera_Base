import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCompanyComputerResetPlan } from "@qorpera/contracts";
import type { LxdOfficeCodePackageClient } from "./lxd-client.ts";
import type { LxdOfficeCodePackageRegistry } from "./lxd-office-code-package-control.ts";
import { readLxdOfficeCodePackagePublicHistory } from "./lxd-office-code-package-history.ts";
import { parseLxdOfficeCodePackageLaneDocument } from "./lxd-office-code-package-lane.ts";
import { loadLxdOfficeCodePackageMaterial } from "./lxd-office-code-package-material.ts";
import { LxdOfficeCodePackageProvisionLane } from "./lxd-office-code-package-provision-lane.ts";
import {
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "./lxd-office-code-package-provision-verification.ts";
import {
	type LxdOfficeCodePackagePacket,
	parseLxdOfficeCodePackageProbe,
} from "./lxd-office-code-package-transport.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { assertLxdOfficePhysicalBinding, type LxdOfficePhysicalPolicy } from "./lxd-office-physical-policy.ts";
import { lxdOfficeProviderBindingSha256 } from "./lxd-office-start-control.ts";

export interface LxdOfficePreparedPackageInvocation {
	measure: LxdOfficeInvocationMeasurement;
	dispose: () => void;
}
/** Discover only the exact public journal on the current root. A definite absent
 * directory permits the historical lane; missing, conflicting or unsafe retained
 * evidence never does. Restaging is done before the fresh inspection deadline. */
export async function prepareLxdOfficeRetainedCodePackageInvocation(
	options: {
		root: string;
		binding: LxdOfficeGuestBinding;
		policy: Readonly<LxdOfficePhysicalPolicy>;
		client: LxdOfficeCodePackageClient;
		registry: LxdOfficeCodePackageRegistry;
	},
	signal: AbortSignal,
	ports: Parameters<typeof loadLxdOfficeCodePackageMaterial>[4] = {},
): Promise<LxdOfficePreparedPackageInvocation | undefined> {
	const { root, binding, client, registry, policy } = options;
	assertLxdOfficePhysicalBinding(policy, binding);
	const id = await client.discoverOfficeCodePackage(binding.project, lxdOfficeGuestPlan(binding).request.name, signal);
	if (id === undefined) return undefined;
	const descriptor = officeRecord((await readRecord(join(root, `code-package-material-${id}.json`), 65536)).value, [
		"schema",
		"binding",
		"document",
		"resetPlan",
	]);
	const resetPlan = parseCompanyComputerResetPlan(descriptor.resetPlan);
	if (
		descriptor.schema !== "qorpera.lxd-office-code-package-material/v1" ||
		!isDeepStrictEqual(descriptor.binding, binding) ||
		resetPlan.providerBindingSha256 !== lxdOfficeProviderBindingSha256(binding)
	)
		throw new Error("OFFICE_CODE_PACKAGE_RETAINED_BINDING_UNCONFIRMED");
	const document = parseLxdOfficeCodePackageLaneDocument({
		schema: "qorpera.lxd-office-code-package-lane/v1",
		...officeRecord(descriptor.document, Object.keys(descriptor.document as object)),
	});
	const historical = await readLxdOfficeCodePackagePublicHistory(root, binding, policy, id, signal, ports);
	const material = await loadLxdOfficeCodePackageMaterial(document, policy, resetPlan, signal, ports);
	try {
		if (material.verified.plan.provisionId !== id) throw new Error("provision differs");
		const r = officeRecord((await readRecord(join(root, `code-package-packet-${id}.json`), 4 * 1024 ** 2)).value, [
			"schema",
			"request",
			"resetPlan",
			"custody",
			"restore",
			"originPreparationSha256",
			"envelope",
		]);
		const request = verifyLxdOfficeCodePackageProvisionRequest(r.request, material.verified);
		if (
			r.schema !== "qorpera.office-code-package-control/v1" ||
			!isDeepStrictEqual(r.envelope, material.envelope) ||
			!isDeepStrictEqual(r.resetPlan, resetPlan)
		)
			throw new Error("packet differs");
		const packet = r as unknown as LxdOfficeCodePackagePacket,
			original = (await readRecord(join(root, `code-package-original-${id}.json`), 16 * 1024 ** 2)).bytes,
			initial = (await readRecord(join(root, `preparation-request-${binding.allocationId}.json`), 16 * 1024 ** 2))
				.bytes;
		if (
			!original.equals(initial) ||
			createHash("sha256").update(original).digest("hex") !== packet.originPreparationSha256
		)
			throw new Error("origin differs");
		const read = async (file: "claim" | "installed") => {
			const result = await client.readOfficeCodePackageReceipt(
				binding.project,
				lxdOfficeGuestPlan(binding).request.name,
				id,
				file,
				signal,
			);
			if (result.uid !== 0 || result.gid !== 0 || result.mode !== 0o400) throw new Error("custody");
			return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(result.content)) as unknown;
		};
		const receipt = verifyLxdOfficeCodePackageProvisionReceipt(await read("installed"), request, material.verified),
			claim = officeRecord(await read("claim"), ["schema", "requestSha256", "packetSha256", "probe"]);
		if (
			claim.schema !== "qorpera.office-code-package-install-claim/v1" ||
			claim.requestSha256 !== officeDigest(request) ||
			claim.packetSha256 !== officeDigest(packet)
		)
			throw new Error("claim differs");
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
			packetSha256: officeDigest(packet),
			bootId: request.bootId,
			challengeId: request.challengeId,
		});
		if (!isDeepStrictEqual(claim, historical.claim) || !isDeepStrictEqual(receipt, historical.receipt))
			throw new Error("root history differs");
		const completed = officeRecord((await readRecord(join(root, `code-package-completed-${id}.json`), 65536)).value, [
			"schema",
			"packetSha256",
			"receipt",
			"evidenceSha256",
		]);
		if (
			completed.schema !== "qorpera.lxd-office-code-package-completed/v1" ||
			completed.packetSha256 !== officeDigest(packet) ||
			!isDeepStrictEqual(completed.receipt, receipt)
		)
			throw new Error("completion differs");
		officeSha(completed.evidenceSha256);
		const lane = new LxdOfficeCodePackageProvisionLane({ root, binding, material, client, registry, resetPlan }),
			pins = await lane.prepareInvocation(packet, original, signal);
		return {
			measure: (activationId, startup, deadline, caller) =>
				lane.measureInvocation(pins, activationId, startup, deadline, caller),
			dispose: () => material.dispose(),
		};
	} catch (error) {
		material.dispose();
		throw new Error("OFFICE_CODE_PACKAGE_RETAINED_UNCONFIRMED", { cause: error });
	}
}
