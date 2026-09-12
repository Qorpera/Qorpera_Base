import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerPreparationCommand,
} from "@qorpera/contracts";
import type { LxdOfficeCodePackageClient } from "./lxd-client.ts";
import { type LxdOfficeCodePackageCommand, runLxdOfficeCodePackageCommand } from "./lxd-office-code-package-command.ts";
import type { LxdOfficeCodePackageMaterial } from "./lxd-office-code-package-material.ts";
import { verifyLxdOfficeCodePackageProvisionRequest } from "./lxd-office-code-package-provision-verification.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";

export interface LxdOfficeCodePackagePacket {
	schema: "qorpera.office-code-package-control/v1";
	request: CompanyComputerCodePackageProvisionRequest;
	resetPlan: unknown;
	custody: unknown;
	restore: unknown;
	originPreparationSha256: string;
	envelope: unknown;
}
const bytes = (value: unknown) => Buffer.from(officeCanonical(value));
const decode = (value: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value));
/** Inputs have already been verified by the protected material loader. Staging
 * contains no provider capability, ordinary registry credential or arbitrary
 * destination. These public bytes remain separately pinned by the fixed loader. */
export async function stageLxdOfficeCodePackage(
	client: LxdOfficeCodePackageClient,
	binding: LxdOfficeGuestBinding,
	material: LxdOfficeCodePackageMaterial,
	packet: LxdOfficeCodePackagePacket,
	originalPreparation: Buffer,
	signal: AbortSignal,
) {
	const request = verifyLxdOfficeCodePackageProvisionRequest(packet.request, material.verified),
		id = request.plan.provisionId,
		{ project } = binding,
		name = lxdOfficeGuestPlan(binding).request.name;
	if (
		packet.schema !== "qorpera.office-code-package-control/v1" ||
		!isDeepStrictEqual(packet.envelope, material.envelope) ||
		officeDigest(packet.resetPlan) !== request.plan.resetPlanSha256
	)
		throw new Error("OFFICE_CODE_PACKAGE_STAGING_UNCONFIRMED");
	if (createHash("sha256").update(originalPreparation).digest("hex") !== packet.originPreparationSha256)
		throw new Error("OFFICE_CODE_PACKAGE_ORIGIN_UNCONFIRMED");
	const packetBytes = bytes(packet),
		trustBytes = bytes(material.document.trust);
	if (packetBytes.length > 4 * 1024 ** 2 || trustBytes.length > 4096)
		throw new Error("OFFICE_CODE_PACKAGE_STAGING_UNCONFIRMED");
	await client.pushOfficeCodePackageDirectory(project, name, id, "root", signal);
	await client.pushOfficeCodePackageDirectory(project, name, id, "artifacts", signal);
	const files: [string, Buffer][] = [
		["packet.json", packetBytes],
		["original-preparation.json", originalPreparation],
		["trust.json", trustBytes],
		["base-manifest.json", material.manifests.base],
		["target-manifest.json", material.manifests.target],
		["base-installation.json", material.manifests.baseInstallationReceipt],
		["base-mount-template", material.manifests.baseMountTemplate],
		["bootstrap.cjs", material.tools.bootstrap],
		["measure.cjs", material.tools.measure],
		...[...material.artifacts].map(([file, content]): [string, Buffer] => [`artifacts/${file}`, content]),
	];
	for (const [file, content] of files) {
		signal.throwIfAborted();
		await client.pushOfficeCodePackageFile(project, name, id, file, content, signal);
		const read = await client.readOfficeCodePackageFile(project, name, id, file, content.length, signal);
		if (read.uid !== 0 || read.gid !== 0 || read.mode !== 0o400 || !read.content.equals(content))
			throw new Error("OFFICE_CODE_PACKAGE_STAGING_UNCONFIRMED");
	}
	return { packetSha256: officeDigest(packet), trustSha256: officeDigest(material.document.trust) };
}
export async function readLxdOfficeCodePackagePublic(
	client: LxdOfficeCodePackageClient,
	binding: LxdOfficeGuestBinding,
	id: string,
	file: string,
	signal: AbortSignal,
) {
	const result = await client.readOfficeCodePackageFile(
		binding.project,
		lxdOfficeGuestPlan(binding).request.name,
		id,
		file,
		65536,
		signal,
	);
	if (result.uid !== 0 || result.gid !== 0 || result.mode !== 0o400)
		throw new Error("OFFICE_CODE_PACKAGE_ROOT_CUSTODY_UNCONFIRMED");
	return decode(result.content);
}
export function parseLxdOfficeCodePackageProbe(
	value: unknown,
	expected: {
		purpose: "install" | "measure";
		provisionId: string;
		probeId: string;
		packetSha256: string;
		bootId: string;
		challengeId: string;
	},
) {
	const r = officeRecord(value, [
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
	parseCompanyComputerPreparationCommand({ commandId: r.probeId, bootId: r.bootId, requestSha256: r.packetSha256 });
	const command = parseCompanyComputerPreparationCommand({
		commandId: r.nonce,
		bootId: r.bootId,
		requestSha256: r.packetSha256,
	});
	if (
		!isDeepStrictEqual(
			{ ...r, nonce: undefined, monotonicNs: undefined },
			{ schema: "qorpera.office-code-package-probe/v1", ...expected, nonce: undefined, monotonicNs: undefined },
		) ||
		typeof r.monotonicNs !== "string" ||
		!/^[1-9][0-9]{0,23}$/.test(r.monotonicNs)
	)
		throw new Error("OFFICE_CODE_PACKAGE_PROBE_UNCONFIRMED");
	return { ...expected, nonce: command.commandId, monotonicNs: r.monotonicNs };
}
export async function awaitLxdOfficeCodePackageCommand(
	root: string,
	binding: LxdOfficeGuestBinding,
	command: LxdOfficeCodePackageCommand,
	client: LxdOfficeCodePackageClient,
	signal: AbortSignal,
	authorize: () => Promise<void>,
) {
	for (;;) {
		const result = await runLxdOfficeCodePackageCommand(root, binding, command, client, signal, authorize);
		if (result.state !== "pending") return result;
		await delay(25, undefined, { signal });
	}
}
/** The install dispatch intent is retained BEFORE requesting SQL authority.
 * A lost permission reply or process death can only lead to observation; a
 * successor process cannot manufacture a new install dispatch from status. */
export async function claimLxdOfficeCodePackageInstall(
	root: string,
	request: CompanyComputerCodePackageProvisionRequest,
	packetSha256: string,
) {
	const name = `code-package-install-intent-${request.plan.provisionId}.json`,
		record = { schema: "qorpera.lxd-office-code-package-install-intent/v1", request, packetSha256 };
	const won = await publish(root, name, bytes(record));
	if (!isDeepStrictEqual((await readRecord(join(root, name), 65536)).value, record))
		throw new Error("OFFICE_CODE_PACKAGE_INSTALL_INTENT_UNCONFIRMED");
	return won;
}
/** Fresh independent attempt identifiers for non-mutating probes. */
export const newLxdOfficeCodePackageProbeId = () => randomUUID();
