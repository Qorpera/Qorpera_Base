import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerStartupIdentity,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerOutageAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetAdoptionReceipt,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { companyComputerLinuxServiceSection } from "./cloud-company-computer-boot-configuration-control.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";
import type { CompanyComputerProtectedEvidenceReader } from "./cloud-company-computer-service-invocation-evidence.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Recover identity from retained root files after abrupt loss of /run. This
 * proves neither clean guest shutdown nor current admission. The caller must
 * independently prove fresh boot, never-started units and retained mount custody.
 * Mutable company/profile/workbench contents are never inspected or restored. */
export async function readCompanyComputerOutagePredecessor(
	input: { startup: CompanyComputerStartupIdentity; bootId: string; originPreparationSha256: string },
	read: CompanyComputerProtectedEvidenceReader,
	signal: AbortSignal,
) {
	const startup = parseCompanyComputerStartupIdentity(input.startup),
		evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	const retain = async (path: string, limit: number, mode: number) => {
		signal.throwIfAborted();
		const bytes = await read(path, limit, mode);
		evidence.push({ path, bytes, mode });
		return bytes;
	};
	const close = () => {
		for (const { bytes } of evidence) bytes.fill(0);
	};
	try {
		const originalBytes = await retain(
				"/etc/qorpera-office/preparation.json",
				COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
				0o444,
			),
			original = parseCompanyComputerPreparationRequest(decode(originalBytes)),
			originBytes = await retain(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444),
			originReceipt = companyComputerPreparationAdoptionReceipt(original);
		if (
			hash(originalBytes) !== input.originPreparationSha256 ||
			!originBytes.equals(Buffer.from(`${JSON.stringify(originReceipt)}\n`)) ||
			input.bootId === startup.bootId ||
			input.bootId === original.bootId ||
			!isDeepStrictEqual(startup.scope, original.scope) ||
			startup.computerGeneration !== original.computerGeneration ||
			startup.allocationId !== original.allocationId ||
			startup.instanceSha256 !== original.instanceSha256 ||
			startup.imageSha256 !== original.imageSha256 ||
			startup.bootstrapSha256 !== original.bootstrapSha256
		)
			throw new Error("outage preparation origin differs");
		// A reset recreates the root without historical credentials. Only this
		// exact predecessor's retained config is needed; its attested hash comes
		// from SQL and its complete Linux binding must match permanent preparation.
		const originalBoot = startup.bootId === original.bootId,
			configurationBytes = await retain(
				originalBoot
					? "/etc/qorpera-office/credentials/config.json"
					: `${companyComputerBootDirectory(startup.bootId)}/credentials/config.json`,
				16384,
				0o400,
			),
			config = parseCompanyComputerServiceConfig(configurationBytes.toString("utf8")),
			resetBorn =
				!originalBoot && config.linux.attestation.adoptionReceiptPath === COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
			adoptionPath =
				originalBoot || resetBorn
					? COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH
					: companyComputerBootAdoptionReceiptPath(startup.bootId),
			adoptionBytes = originalBoot || resetBorn ? originBytes : await retain(adoptionPath, 16384, 0o444);
		if (!originalBoot) {
			const decoded = decode(
					resetBorn
						? await retain(companyComputerResetAdoptionReceiptPath(startup.bootId), 16384, 0o444)
						: adoptionBytes,
				),
				receipt = resetBorn
					? parseCompanyComputerResetAdoptionReceipt(decoded)
					: decoded &&
							typeof decoded === "object" &&
							"schema" in decoded &&
							decoded.schema === "qorpera.office-state-outage-retained/v1"
						? parseCompanyComputerOutageAdoptionReceipt(decoded)
						: parseCompanyComputerBootAdoptionReceipt(decoded);
			if (
				receipt.bootId !== startup.bootId ||
				!isDeepStrictEqual(receipt.scope, original.scope) ||
				receipt.computerGeneration !== original.computerGeneration ||
				receipt.allocationId !== original.allocationId ||
				receipt.instanceSha256 !== original.instanceSha256 ||
				receipt.imageSha256 !== original.imageSha256 ||
				receipt.bootstrapSha256 !== original.bootstrapSha256 ||
				!isDeepStrictEqual(receipt.origin, {
					bootId: original.bootId,
					preparationSha256: hash(originalBytes),
					adoptionReceiptSha256: hash(originBytes),
				}) ||
				!isDeepStrictEqual(receipt.layout, originReceipt.layout) ||
				!isDeepStrictEqual(receipt.workbenchMount, original.workbenchMount)
			)
				throw new Error("outage retained adoption differs");
		}
		if (
			hash(configurationBytes) !== startup.configurationSha256 ||
			!isDeepStrictEqual(config.scope, original.scope) ||
			config.computerGeneration !== original.computerGeneration ||
			!isDeepStrictEqual(
				companyComputerLinuxBinding(config.linux),
				companyComputerLinuxServiceSection(original, startup.bootId, adoptionPath, hash(adoptionBytes)),
			)
		)
			throw new Error("outage predecessor configuration differs");
		const verify = async () => {
			for (const file of evidence) {
				signal.throwIfAborted();
				const bytes = await read(file.path, file.bytes.length, file.mode);
				try {
					if (!bytes.equals(file.bytes)) throw new Error("outage predecessor changed");
				} finally {
					bytes.fill(0);
				}
			}
			signal.throwIfAborted();
		};
		await verify();
		return {
			original,
			originPreparationSha256: hash(originalBytes),
			originAdoptionReceiptSha256: hash(originBytes),
			predecessorConfigurationSha256: hash(configurationBytes),
			predecessorAdoptionReceiptSha256: hash(adoptionBytes),
			verify,
			close,
		};
	} catch (error) {
		close();
		throw error;
	}
}
