import { createHash, verify } from "node:crypto";
import {
	parseCompanyComputerServiceSoftwareEnvelope,
	parseCompanyComputerServiceSoftwarePlan,
	parseCompanyComputerServiceSoftwareReceipt,
} from "@qorpera/contracts";
import { parseOfficeImagePackage } from "./lxd-office-image-installation.ts";
import { officeCanonical, officeDigest, officeImagePublicKey, officeSha } from "./lxd-office-image-provenance.ts";

/** Verification only: trusted digests/key must come from protected enrollment.
 * No filesystem inspection, signing, installation, stop acknowledgement or
 * current SQL/startup authority is supplied by these historical documents. */
export function verifyLxdOfficeServiceSoftware(
	envelopeValue: unknown,
	planValue: unknown,
	trust: { verificationKeySpki: string; statementSha256: string; planSha256: string },
	manifests: { previous: Buffer; next: Buffer },
) {
	try {
		const envelope = parseCompanyComputerServiceSoftwareEnvelope(envelopeValue);
		const plan = parseCompanyComputerServiceSoftwarePlan(planValue);
		const statement = envelope.statement;
		const signature = Buffer.from(envelope.signature.value, "base64");
		if (
			signature.length !== 64 ||
			signature.toString("base64") !== envelope.signature.value ||
			officeDigest(statement) !== officeSha(trust.statementSha256) ||
			officeDigest(plan) !== officeSha(trust.planSha256) ||
			plan.statementSha256 !== trust.statementSha256 ||
			plan.predecessor.startup.imageSha256 !== statement.base.imageSha256 ||
			plan.predecessor.startup.bootstrapSha256 !== statement.base.bootstrapSha256 ||
			!verify(
				null,
				Buffer.from(officeCanonical(statement)),
				officeImagePublicKey(trust.verificationKeySpki),
				signature,
			)
		)
			throw new Error("unconfirmed");
		const inventories = (["previous", "next"] as const).map((revision) => {
			const bytes = manifests[revision];
			if (
				!Buffer.isBuffer(bytes) ||
				bytes.length < 1 ||
				bytes.length > 1024 ** 2 ||
				createHash("sha256").update(bytes).digest("hex") !== statement[revision].packageManifestSha256
			)
				throw new Error("manifest differs");
			const parsed = parseOfficeImagePackage(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
			const service = parsed.artifacts.find((a) => a.file === "qorpera-company-computer-service.mjs");
			if (
				!service ||
				service.path !== statement[revision].service.path ||
				service.bytes !== statement[revision].service.bytes ||
				service.sha256 !== statement[revision].service.sha256
			)
				throw new Error("service differs");
			return {
				playwright: parsed.playwright,
				artifacts: Object.fromEntries(parsed.artifacts.filter((a) => a !== service).map((a) => [a.file, a])),
			};
		});
		if (officeCanonical(inventories[0]) !== officeCanonical(inventories[1]))
			throw new Error("non-service artifact changed");
		return Object.freeze({ statement, plan, planSha256: trust.planSha256 });
	} catch {
		throw new Error("OFFICE_SERVICE_SOFTWARE_UNCONFIRMED");
	}
}

/** A matching receipt remains historical data; callers must independently
 * establish root custody and inspect bytes before any successor admission. */
export function verifyLxdOfficeServiceSoftwareReceipt(
	receiptValue: unknown,
	envelopeValue: unknown,
	planValue: unknown,
	trust: Parameters<typeof verifyLxdOfficeServiceSoftware>[2],
	manifests: Parameters<typeof verifyLxdOfficeServiceSoftware>[3],
) {
	try {
		const verified = verifyLxdOfficeServiceSoftware(envelopeValue, planValue, trust, manifests);
		const receipt = parseCompanyComputerServiceSoftwareReceipt(receiptValue);
		if (
			receipt.planSha256 !== verified.planSha256 ||
			officeDigest(receipt.plan) !== verified.planSha256 ||
			officeCanonical(receipt.service) !== officeCanonical(verified.statement.next.service) ||
			Date.parse(receipt.installedAt) < Date.parse(verified.statement.acceptance.testedAt)
		)
			throw new Error("unconfirmed");
		return receipt;
	} catch {
		throw new Error("OFFICE_SERVICE_SOFTWARE_RECEIPT_UNCONFIRMED");
	}
}
