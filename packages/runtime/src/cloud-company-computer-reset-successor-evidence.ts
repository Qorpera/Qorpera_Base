import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	type CompanyComputerLifecycleRequest,
	type CompanyComputerPreparationCommand,
	type CompanyComputerResetConfigurationCompletion,
	type CompanyComputerResetServiceStartRequest,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetConfigurationCompletion,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { companyComputerLinuxServiceSection } from "./cloud-company-computer-boot-configuration-control.ts";
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
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Paths that must be absent on a recreated root: no historical credential
 * directory and no claim of an initial preparation, first start or stop. */
export const COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS = Object.freeze([
	"/etc/qorpera-office/credentials",
	`${root}/claim.json`,
	`${root}/completion.json`,
	`${root}/service-start-claim.json`,
	`${root}/service-start-completion.json`,
	`${root}/service-stop-claim.json`,
	`${root}/boot-service-start-claim.json`,
	`${root}/boot-service-start-completion.json`,
]);
/** The image's tmpfiles layout (qorpera-office-preparation.conf) creates the
 * credential directory itself, root-only and empty, on every boot of a fresh
 * root. Only a credential directory that holds anything, or is not that exact
 * private empty directory, is historical authority. */
const CREDENTIAL_DIRECTORY = "/etc/qorpera-office/credentials";
async function assertResetRootPaths(paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(path);
		} catch (error) {
			if (missing(error)) continue;
			throw error;
		}
		if (
			path === CREDENTIAL_DIRECTORY &&
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.uid === 0 &&
			stat.gid === 0 &&
			(stat.mode & 0o7777) === 0o700 &&
			(await readdir(path)).length === 0
		)
			continue;
		throw new Error("stale root authority present");
	}
}
export async function assertCompanyComputerResetRootClean(activationId: string): Promise<void> {
	await assertResetRootPaths([
		...COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS,
		`${root}/service-stop-claim-${activationId}.json`,
	]);
}
/** Retained lifecycle callers independently prove the exact current invocation
 * and its stop/successor claims. An acknowledged stop of the immutable origin
 * is expected history here, never permission to replay its initial start. */
export const readCompanyComputerResetRetainedEvidence = (
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerResetServiceStartRequest,
	signal: AbortSignal,
) => readResetMaterial(command, request, signal, true);
export const readCompanyComputerResetServiceStartEvidence = (
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerResetServiceStartRequest,
	signal: AbortSignal,
) => readResetMaterial(command, request, signal, false);

/** The restored public stop history of the predecessor must be the sealed
 * archive of the exact retained `replace` request. Its bytes are history only. */
export async function verifyCompanyComputerResetPredecessorHistory(
	predecessor: CompanyComputerLifecycleRequest,
	command: CompanyComputerPreparationCommand,
	signal: AbortSignal,
): Promise<string> {
	const archive = await readCompanyComputerStopHistory(predecessor.startup.bootId, predecessor.activationId);
	try {
		signal.throwIfAborted();
		if (
			predecessor.action !== "replace" ||
			archive.manifest.command.bootId !== predecessor.startup.bootId ||
			archive.manifest.command.commandId === command.commandId
		)
			throw new Error("predecessor history differs");
		const stopBytes = archive.files.get(
			`${root}/service-stop-incoming-${archive.manifest.command.requestSha256}.json`,
		);
		if (!stopBytes || hash(stopBytes) !== archive.manifest.command.requestSha256)
			throw new Error("predecessor stop request missing");
		const stop = parseCompanyComputerServiceStopRequest(json(stopBytes));
		if (!isDeepStrictEqual(stop.revocation.request, predecessor)) throw new Error("predecessor stop differs");
		const completion = archive.files.get(archive.manifest.completionPath);
		if (!completion) throw new Error("predecessor stop completion missing");
		parseCompanyComputerServiceStopCompletion(json(completion), archive.manifest.command, stop);
		return archive.manifestSha256;
	} finally {
		for (const bytes of archive.files.values()) bytes.fill(0);
	}
}
/** Read-only reset successor evidence on the recreated root: the restored
 * original preparation and receipt, the acknowledged reset configuration in
 * this boot's directory, the installed credentials and retained NAS custody.
 * No credential leaves this process and nothing here can start a unit. */
async function readResetMaterial(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerResetServiceStartRequest,
	signal: AbortSignal,
	retained: boolean,
) {
	await assertCompanyComputerPreparationLockAndBoot(command);
	const successor = request.request,
		{ attestation, predecessor } = successor,
		directory = companyComputerBootDirectory(command.bootId),
		evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	const retain = async (path: string, limit: number, mode: number) => {
		signal.throwIfAborted();
		const bytes = await read(path, limit, mode);
		evidence.push({ path, bytes, mode });
		return bytes;
	};
	if (attestation.bootId !== command.bootId || predecessor.startup.bootId === command.bootId)
		throw new Error("boot differs");
	await assertResetRootPaths(
		retained
			? COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS
			: [
					...COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS,
					`${root}/service-stop-claim-${attestation.activationId}.json`,
				],
	);
	const configuredBytes = await retain(
			`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION}`,
			16384,
			0o600,
		),
		configuredValue = json(configuredBytes) as CompanyComputerResetConfigurationCompletion,
		configured = parseCompanyComputerResetConfigurationCompletion(configuredValue, {
			...configuredValue,
			resetId: successor.resetId,
			rootIncarnationId: successor.rootIncarnationId,
			activationId: attestation.activationId,
			adoptionReceiptSha256: attestation.adoptionReceiptSha256,
		});
	if (
		configured.command.bootId !== command.bootId ||
		configured.command.commandId === command.commandId ||
		configured.files["config.json"].sha256 !== attestation.configurationSha256
	)
		throw new Error("configuration binding differs");
	const claim = await retain(`${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM}`, 4096, 0o600);
	if (
		!claim.equals(
			encode({
				schema: "qorpera.office-reset-configuration-claim/v1",
				command: configured.command,
				resetId: successor.resetId,
				rootIncarnationId: successor.rootIncarnationId,
				activationId: attestation.activationId,
			}),
		)
	)
		throw new Error("configuration claim differs");
	const originalBytes = await retain(
			"/etc/qorpera-office/preparation.json",
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			0o444,
		),
		original = parseCompanyComputerPreparationRequest(json(originalBytes)),
		receiptBytes = encode(companyComputerPreparationAdoptionReceipt(original)),
		restoredReceipt = await retain(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444);
	if (
		hash(originalBytes) !== configured.originPreparationSha256 ||
		original.bootId === command.bootId ||
		original.allocationId !== predecessor.startup.allocationId ||
		!restoredReceipt.equals(receiptBytes) ||
		hash(receiptBytes) !== attestation.adoptionReceiptSha256
	)
		throw new Error("restored origin differs");
	const expectedLinux = companyComputerLinuxServiceSection(
		original,
		command.bootId,
		COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
		hash(receiptBytes),
	);
	const verifyHistory = () => verifyCompanyComputerResetPredecessorHistory(predecessor, command, signal);
	await verifyHistory();
	const workbench = await openCompanyComputerRetainedWorkbench(original, signal);
	try {
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await assertResetRootPaths(
				retained
					? COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS
					: [
							...COMPANY_COMPUTER_RESET_FORBIDDEN_ROOT_PATHS,
							`${root}/service-stop-claim-${attestation.activationId}.json`,
						],
			);
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
						throw new Error("reset credentials changed");
					if (key === "configuration") {
						const config = parseCompanyComputerServiceConfig(bytes.toString("utf8"));
						if (
							config.native.port !== attestation.nativePort ||
							config.viewer.port !== attestation.viewerPort ||
							!isDeepStrictEqual(config.scope, original.scope) ||
							config.computerGeneration !== original.computerGeneration ||
							!isDeepStrictEqual(companyComputerLinuxBinding(config.linux), expectedLinux)
						)
							throw new Error("reset configuration differs");
					}
				} finally {
					bytes.fill(0);
				}
			}
			await workbench.verify();
			signal.throwIfAborted();
		};
		await verify();
		return { configured, configurationCompletionSha256: hash(configuredBytes), verify, close: workbench.close };
	} catch (error) {
		await workbench.close();
		throw error;
	}
}
