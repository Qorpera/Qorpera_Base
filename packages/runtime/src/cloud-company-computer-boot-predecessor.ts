import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	type CompanyComputerBootIntentRequest,
	type CompanyComputerPreparationCommand,
	type CompanyComputerPreparationRequest,
	companyComputerBootDirectory,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { readCompanyComputerBootServiceInvocation } from "./cloud-company-computer-boot-invocation-evidence.ts";
import { OFFICE_PREPARATION_CONTROL_ROOT as root } from "./cloud-company-computer-preparation-control.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";
import type { CompanyComputerProtectedEvidenceReader } from "./cloud-company-computer-service-invocation-evidence.ts";
import { readCompanyComputerStopHistory } from "./cloud-company-computer-stop-history.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** The initial preparation is permanent; the most recently stopped activation
 * can belong to any later boot. Read its sealed public archive with the actual
 * wire parsers, then require the retained boot's persistent records to match.
 * No volatile previous-boot path is read from the current /run directory. */
export async function verifyCompanyComputerBootPredecessor(
	input: {
		command: CompanyComputerPreparationCommand;
		intent: CompanyComputerBootIntentRequest;
		original: CompanyComputerPreparationRequest;
		originPreparationSha256: string;
		originReceipt: Buffer;
		originalConfiguration: Buffer;
	},
	read: CompanyComputerProtectedEvidenceReader,
	signal: AbortSignal,
) {
	const { command, intent, original, originReceipt, originalConfiguration } = input,
		predecessor = intent.predecessor,
		archive = await readCompanyComputerStopHistory(predecessor.startup.bootId, predecessor.activationId);
	const buffers: Buffer[] = [];
	try {
		signal.throwIfAborted();
		if (
			archive.manifestSha256 !== intent.stopHistorySha256 ||
			archive.manifest.command.commandId === command.commandId
		)
			throw new Error("shutdown history differs");
		const archived: CompanyComputerProtectedEvidenceReader = async (path, limit, mode) => {
			signal.throwIfAborted();
			const entry = archive.manifest.entries.find((entry) => entry.path === path),
				bytes = archive.files.get(path);
			if (
				!entry ||
				!bytes ||
				entry.mode !== mode ||
				bytes.length > limit ||
				bytes.length !== entry.bytes ||
				hash(bytes) !== entry.sha256
			)
				throw new Error("archived predecessor file differs");
			return bytes;
		};
		const stopBytes = await archived(
			`${root}/service-stop-incoming-${archive.manifest.command.requestSha256}.json`,
			65536,
			0o400,
		);
		if (hash(stopBytes) !== archive.manifest.command.requestSha256) throw new Error("shutdown request missing");
		const stop = parseCompanyComputerServiceStopRequest(decode(stopBytes));
		if (!isDeepStrictEqual(stop.revocation.request, predecessor)) throw new Error("shutdown predecessor differs");
		parseCompanyComputerServiceStopCompletion(
			decode(await archived(archive.manifest.completionPath, 8192, 0o600)),
			archive.manifest.command,
			stop,
		);
		if (predecessor.startup.bootId === original.bootId) {
			if (hash(originalConfiguration) !== predecessor.startup.configurationSha256)
				throw new Error("original configuration differs");
			for (const [path, bytes, mode] of [
				[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, originReceipt, 0o444],
				["/etc/qorpera-office/credentials/config.json", originalConfiguration, 0o400],
			] as const)
				if (!(await archived(path, bytes.length, mode)).equals(bytes)) throw new Error("archived origin differs");
			return;
		}
		const selected = await readCompanyComputerBootServiceInvocation(
			predecessor.activationId,
			predecessor.startup.bootId,
			archived,
		);
		if (
			hash(selected.bytes) !== stop.startCompletionSha256 ||
			selected.start.serviceInvocationId !== predecessor.startup.serviceInvocationId ||
			selected.start.configurationSha256 !== predecessor.startup.configurationSha256
		)
			throw new Error("archived activation differs");
		const receiptBytes = await archived(selected.adoptionPath, 16384, 0o444),
			receipt = parseCompanyComputerBootAdoptionReceipt(decode(receiptBytes));
		if (
			!isDeepStrictEqual(receipt.origin, {
				bootId: original.bootId,
				preparationSha256: input.originPreparationSha256,
				adoptionReceiptSha256: hash(originReceipt),
			}) ||
			!isDeepStrictEqual(receipt.layout, JSON.parse(originReceipt.toString()).layout) ||
			!isDeepStrictEqual(receipt.workbenchMount, original.workbenchMount)
		)
			throw new Error("archived preparation origin differs");
		const configBytes = await archived(selected.configurationPath, 16384, 0o400),
			config = parseCompanyComputerServiceConfig(configBytes.toString("utf8")),
			initialConfig = parseCompanyComputerServiceConfig(originalConfiguration.toString("utf8"));
		if (
			hash(configBytes) !== predecessor.startup.configurationSha256 ||
			!isDeepStrictEqual(config.scope, original.scope) ||
			config.computerGeneration !== original.computerGeneration ||
			!isDeepStrictEqual(companyComputerLinuxBinding(config.linux), {
				...companyComputerLinuxBinding(initialConfig.linux),
				attestation: {
					...initialConfig.linux.attestation,
					bootId: predecessor.startup.bootId,
					adoptionReceiptPath: selected.adoptionPath,
					adoptionReceiptSha256: hash(receiptBytes),
				},
			})
		)
			throw new Error("archived configuration differs");
		const directory = companyComputerBootDirectory(predecessor.startup.bootId);
		for (const entry of archive.manifest.entries.filter((entry) => entry.path.startsWith(`${directory}/`))) {
			const current = await read(entry.path, entry.bytes, entry.mode);
			buffers.push(current);
			if (!current.equals(archive.files.get(entry.path)!)) throw new Error("retained predecessor changed");
		}
		signal.throwIfAborted();
	} finally {
		for (const bytes of [...buffers, ...archive.files.values()]) bytes.fill(0);
	}
}
