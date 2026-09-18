import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_LIMITS,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceStartRequest,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerConfigurationCompletion,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	type CompanyComputerPreparationUnitState,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { parseCompanyComputerServiceConfig } from "./cloud-company-computer-service-config.ts";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));

/** Immutable preparation/configuration evidence shared by first start and
 * explicit restart. It verifies installed credentials without inspecting or
 * repairing mutable workbench/profile contents. Secret buffers are wiped as
 * soon as each hash has been checked. Caller measures the actual fixed units. */
export async function readCompanyComputerServiceStartEvidence(
	command: CompanyComputerPreparationCommand,
	request: CompanyComputerServiceStartRequest,
	signal: AbortSignal,
) {
	await assertCompanyComputerPreparationLockAndBoot(command);
	signal.throwIfAborted();
	const configuredBytes = await readCompanyComputerPreparationProtected(
		`${root}/configuration-completion.json`,
		8192,
		0o600,
	);
	if (hash(configuredBytes) !== request.configurationCompletionSha256)
		throw new Error("configuration evidence differs");
	const configured = parseCompanyComputerConfigurationCompletion(json(configuredBytes), request.configuration);
	const preparationBytes = await readCompanyComputerPreparationProtected(
		"/etc/qorpera-office/preparation.json",
		COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
		0o444,
	);
	if (hash(preparationBytes) !== configured.preparation.requestSha256) throw new Error("preparation differs");
	const preparation = parseCompanyComputerPreparationRequest(json(preparationBytes));
	if (preparation.bootId !== command.bootId) throw new Error("boot differs");
	const reportBytes = await readCompanyComputerPreparationProtected(`${root}/result.json`, 65536, 0o600);
	const preparationCompletion = await readCompanyComputerPreparationProtected(`${root}/completion.json`, 65536, 0o600);
	if (hash(preparationCompletion) !== configured.preparationCompletionSha256)
		throw new Error("preparation completion differs");
	const receiptBytes = encode(companyComputerPreparationAdoptionReceipt(preparation));
	if (hash(receiptBytes) !== request.attestation.adoptionReceiptSha256) throw new Error("receipt differs");
	const completed = parseCompanyComputerPreparationCompletion(json(preparationCompletion), preparation, {
		commandId: configured.preparation.commandId,
		requestSha256: configured.preparation.requestSha256,
		contentSha256: hash(JSON.stringify(preparation.entries)),
		reportSha256: hash(reportBytes),
		adoptionReceiptSha256: hash(receiptBytes),
	});
	if (!isDeepStrictEqual(json(reportBytes), completed.report)) throw new Error("report differs");
	const evidence = [
		[`${root}/configuration-completion.json`, configuredBytes, 0o600],
		[
			`${root}/configuration-claim.json`,
			encode({
				schema: "qorpera.office-configuration-claim/v1",
				command: configured.command,
				preparation: configured.preparation,
			}),
			0o600,
		],
		["/etc/qorpera-office/preparation.json", preparationBytes, 0o444],
		[`${root}/result.json`, reportBytes, 0o600],
		[`${root}/completion.json`, preparationCompletion, 0o600],
		[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, receiptBytes, 0o444],
	] as const;
	const expectedPreparation: CompanyComputerPreparationUnitState = {
		invocationId: completed.invocationId,
		activeState: "active",
		subState: "exited",
		result: "success",
		mainPid: 0,
		controlPid: 0,
		jobId: 0,
		execMainCode: 1,
		execMainStatus: 0,
	};
	return {
		preparation: expectedPreparation,
		async verify() {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			const bootCredentialsRoot = await assertCompanyComputerBootCredentials(command);
			const directory = await lstat("/etc/qorpera-office/credentials");
			if (
				!directory.isDirectory() ||
				directory.isSymbolicLink() ||
				directory.uid !== 0 ||
				directory.gid !== 0 ||
				(directory.mode & 0o7777) !== 0o700
			)
				throw new Error("credential directory changed");
			for (const [path, bytes, mode] of evidence)
				if (!(await readCompanyComputerPreparationProtected(path, bytes.length, mode)).equals(bytes))
					throw new Error("evidence changed");
			for (const credentialsRoot of ["/etc/qorpera-office/credentials", bootCredentialsRoot]) {
				for (const [name, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
					const bytes = await readCompanyComputerPreparationProtected(
						`${credentialsRoot}/${file}`,
						COMPANY_COMPUTER_CONFIGURATION_LIMITS[name as keyof typeof COMPANY_COMPUTER_CONFIGURATION_LIMITS],
						0o400,
					);
					try {
						if (bytes.length !== configured.files[file].bytes || hash(bytes) !== configured.files[file].sha256)
							throw new Error("installed credentials changed");
						if (file === "config.json") {
							const config = parseCompanyComputerServiceConfig(bytes.toString("utf8"));
							if (
								config.native.port !== request.attestation.nativePort ||
								config.viewer.port !== request.attestation.viewerPort ||
								!isDeepStrictEqual(config.scope, preparation.scope) ||
								config.computerGeneration !== preparation.computerGeneration ||
								config.linux.attestation.bootId !== command.bootId ||
								config.linux.attestation.adoptionReceiptSha256 !== hash(receiptBytes)
							)
								throw new Error("config differs");
						}
					} finally {
						bytes.fill(0);
					}
				}
			}
			signal.throwIfAborted();
		},
	};
}
