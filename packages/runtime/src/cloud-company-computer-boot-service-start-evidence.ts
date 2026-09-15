import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerBootServiceStartRequest,
	type CompanyComputerPreparationCommand,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerBootAdoptionReceipt,
	parseCompanyComputerBootConfigurationCompletion,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	readCompanyComputerPreparationProtected as read,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";
import { readCompanyComputerStopHistory } from "./cloud-company-computer-stop-history.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
/** Read-only retained boot evidence. No old /run state, copied-content replay
 * or initial preparation invocation is needed. Caller must close descriptors. */
export async function readCompanyComputerBootServiceStartEvidence(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerBootServiceStartRequest,
	signal: AbortSignal,
) {
	await assertCompanyComputerPreparationLockAndBoot(command);
	const directory = companyComputerBootDirectory(command.bootId),
		successor = request.successor.request,
		attestation = successor.attestation,
		evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	const retain = async (path: string, limit: number, mode: number) => {
		signal.throwIfAborted();
		const bytes = await read(path, limit, mode);
		evidence.push({ path, bytes, mode });
		return bytes;
	};
	const configuredBytes = await retain(`${directory}/configuration-completion.json`, 16384, 0o600);
	if (hash(configuredBytes) !== request.configurationCompletionSha256) throw new Error("configuration differs");
	const configured = parseCompanyComputerBootConfigurationCompletion(json(configuredBytes), request.configuration),
		originalBytes = await retain(
			"/etc/qorpera-office/preparation.json",
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			0o444,
		),
		original = parseCompanyComputerPreparationRequest(json(originalBytes)),
		originalReceipt = companyComputerPreparationAdoptionReceipt(original),
		originBytes = await retain("/etc/qorpera-office/adoption.json", 16384, 0o444),
		receiptBytes = await retain(companyComputerBootAdoptionReceiptPath(command.bootId), 16384, 0o444),
		receipt = parseCompanyComputerBootAdoptionReceipt(json(receiptBytes));
	if (
		hash(originalBytes) !== configured.originPreparationSha256 ||
		!originBytes.equals(encode(originalReceipt)) ||
		hash(receiptBytes) !== attestation.adoptionReceiptSha256 ||
		!isDeepStrictEqual(receipt, {
			schema: "qorpera.office-state-retained/v1",
			state: "complete",
			scope: original.scope,
			computerGeneration: original.computerGeneration,
			allocationId: original.allocationId,
			instanceSha256: original.instanceSha256,
			imageSha256: original.imageSha256,
			bootstrapSha256: original.bootstrapSha256,
			bootId: command.bootId,
			layout: originalReceipt.layout,
			workbenchMount: original.workbenchMount,
			origin: {
				bootId: original.bootId,
				preparationSha256: hash(originalBytes),
				adoptionReceiptSha256: hash(originBytes),
			},
			bootIntent: {
				schema: "qorpera.office-boot-intent-request/v1",
				bootIntentId: successor.bootIntentId,
				activationId: attestation.activationId,
				predecessor: successor.predecessor,
				stopHistorySha256: successor.stopHistorySha256,
				powerOffCompletionSha256: successor.powerOffCompletionSha256,
			},
			bootObservationSha256: successor.bootObservationSha256,
		})
	)
		throw new Error("retained receipt differs");
	const claim = await retain(`${directory}/configuration-claim.json`, 4096, 0o600);
	if (
		!claim.equals(
			encode({
				schema: "qorpera.office-boot-configuration-claim/v1",
				command: configured.command,
				bootIntentId: successor.bootIntentId,
				activationId: attestation.activationId,
			}),
		)
	)
		throw new Error("configuration claim differs");
	const verifyHistory = async () => {
		const archive = await readCompanyComputerStopHistory(
			successor.predecessor.startup.bootId,
			successor.predecessor.activationId,
		);
		try {
			if (
				archive.manifestSha256 !== successor.stopHistorySha256 ||
				archive.manifest.command.commandId === command.commandId
			)
				throw new Error("stop history differs");
			const stopBytes = archive.files.get(
				`${root}/service-stop-incoming-${archive.manifest.command.requestSha256}.json`,
			);
			if (!stopBytes || hash(stopBytes) !== archive.manifest.command.requestSha256)
				throw new Error("stop request differs");
			const stop = parseCompanyComputerServiceStopRequest(json(stopBytes));
			if (!isDeepStrictEqual(stop.revocation.request, successor.predecessor)) throw new Error("predecessor differs");
			parseCompanyComputerServiceStopCompletion(
				json(archive.files.get(archive.manifest.completionPath)!),
				archive.manifest.command,
				stop,
			);
		} finally {
			for (const bytes of archive.files.values()) bytes.fill(0);
		}
	};
	await verifyHistory();
	const workbench = await openCompanyComputerRetainedWorkbench(original, signal);
	try {
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			const credentialsRoot = await assertCompanyComputerBootCredentials(command);
			for (const { path, bytes, mode } of evidence)
				if (!(await read(path, bytes.length, mode)).equals(bytes)) throw new Error("retained evidence changed");
			await workbench.verify();
			await verifyHistory();
			for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
				const bytes = await read(
					`${credentialsRoot}/${file}`,
					COMPANY_COMPUTER_CONFIGURATION_LIMITS[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
					0o400,
				);
				try {
					if (bytes.length !== configured.files[file].bytes || hash(bytes) !== configured.files[file].sha256)
						throw new Error("boot credentials changed");
					if (key === "configuration") {
						const config = parseCompanyComputerServiceConfig(bytes.toString("utf8"));
						if (
							config.native.port !== attestation.nativePort ||
							config.viewer.port !== attestation.viewerPort ||
							!isDeepStrictEqual(config.scope, original.scope) ||
							config.computerGeneration !== original.computerGeneration ||
							!isDeepStrictEqual(companyComputerLinuxBinding(config.linux), {
								layout: originalReceipt.layout,
								limits: original.limits,
								workbenchMount: original.workbenchMount,
								privateWorkbenchMount: {
									filesystem: "tmpfs",
									source: "tmpfs",
									root: "/",
									mountPoint: "/run/qorpera-office/private",
								},
								displayRuntimeRoot: "/run/qorpera-office/display",
								browserRuntimeRoot: "/run/qorpera-office/browser",
								captureRoot: "/run/qorpera-office/captures",
								attestation: {
									allocationId: original.allocationId,
									instanceSha256: original.instanceSha256,
									imageSha256: original.imageSha256,
									bootstrapSha256: original.bootstrapSha256,
									bootId: command.bootId,
									adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(command.bootId),
									adoptionReceiptSha256: hash(receiptBytes),
								},
							})
						)
							throw new Error("boot configuration differs");
					}
				} finally {
					bytes.fill(0);
				}
			}
			await workbench.verify();
			signal.throwIfAborted();
		};
		await verify();
		return { verify, close: workbench.close };
	} catch (error) {
		await workbench.close();
		throw error;
	}
}
