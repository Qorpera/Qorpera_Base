import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerConfigurationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationCompletion,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	type CompanyComputerPreparationManager,
	OFFICE_PREPARATION_CONTROL_ROOT,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
} from "./cloud-company-computer-preparation-control.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";

export const OFFICE_CONFIGURATION_MAX_BYTES = COMPANY_COMPUTER_CONFIGURATION_MAX_BYTES;
const root = OFFICE_PREPARATION_CONTROL_ROOT;
const credentialsRoot = "/etc/qorpera-office/credentials";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const decode = (value: Buffer) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(value)) as unknown;
const files = COMPANY_COMPUTER_CONFIGURATION_FILES;
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

let pending = false;
/** Fixed-file credential installation under the preparation kernel lock.
 * The caller must already retain current provider/cloud authority. This helper
 * verifies the actual completed preparation and never activates or starts the
 * ordinary service. Its manager port only inspects; no start method is used. */
export async function controlCompanyComputerConfiguration(
	value: unknown,
	manager: Pick<CompanyComputerPreparationManager, "inspect">,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_CONFIGURATION_PENDING");
	pending = true;
	const buffers: Buffer[] = [];
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		const bootCredentialsRoot = `${companyComputerBootDirectory(command.bootId)}/credentials`;
		await assertCompanyComputerPreparationLockAndBoot(command);
		const staged = await readCompanyComputerPreparationProtected(
			`${root}/configuration-incoming-${command.requestSha256}.json`,
			OFFICE_CONFIGURATION_MAX_BYTES,
			0o400,
		);
		buffers.push(staged);
		if (hash(staged) !== command.requestSha256) throw new Error("staging");
		const input = parseCompanyComputerConfigurationRequest(decode(staged));
		const preparation = parseCompanyComputerPreparationCommand(input.preparation);
		if (preparation.bootId !== command.bootId || preparation.commandId === command.commandId)
			throw new Error("command");
		const contents = new Map<string, Buffer>();
		for (const [name, file] of Object.entries(files)) {
			const text = input[name as keyof typeof files];
			const bytes = Buffer.from(text);
			buffers.push(bytes);
			contents.set(file, bytes);
		}
		const config = parseCompanyComputerServiceConfig(input.configuration as string);
		createSecureContext({
			cert: contents.get("tls-cert.pem"),
			key: contents.get("tls-key.pem"),
			minVersion: "TLSv1.3",
		});
		const requestBytes = await readCompanyComputerPreparationProtected(
			"/etc/qorpera-office/preparation.json",
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			0o444,
		);
		if (hash(requestBytes) !== preparation.requestSha256) throw new Error("preparation request");
		const request = parseCompanyComputerPreparationRequest(decode(requestBytes));
		if (request.bootId !== command.bootId) throw new Error("boot");
		const receipt = companyComputerPreparationAdoptionReceipt(request);
		const receiptBytes = encode(receipt);
		const receiptSha256 = hash(receiptBytes);
		if (
			!isDeepStrictEqual(config.scope, request.scope) ||
			config.computerGeneration !== request.computerGeneration ||
			!isDeepStrictEqual(companyComputerLinuxBinding(config.linux), {
				layout: receipt.layout,
				limits: request.limits,
				workbenchMount: request.workbenchMount,
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
					allocationId: request.allocationId,
					instanceSha256: request.instanceSha256,
					imageSha256: request.imageSha256,
					bootstrapSha256: request.bootstrapSha256,
					bootId: request.bootId,
					adoptionReceiptPath: COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
					adoptionReceiptSha256: receiptSha256,
				},
			})
		)
			throw new Error("configuration binding");
		const reportBytes = await readCompanyComputerPreparationProtected(`${root}/result.json`, 65536, 0o600);
		const completionBytes = await readCompanyComputerPreparationProtected(`${root}/completion.json`, 65536, 0o600);
		const completion = parseCompanyComputerPreparationCompletion(decode(completionBytes), request, {
			commandId: preparation.commandId,
			requestSha256: preparation.requestSha256,
			contentSha256: hash(JSON.stringify(request.entries)),
			reportSha256: hash(reportBytes),
			adoptionReceiptSha256: receiptSha256,
		});
		if (!isDeepStrictEqual(decode(reportBytes), completion.report)) throw new Error("report");
		const directory = await lstat(credentialsRoot);
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			directory.uid !== 0 ||
			directory.gid !== 0 ||
			(directory.mode & 0o7777) !== 0o700
		)
			throw new Error("credential directory");
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			// The concrete manager additionally requires the exact installed ordinary
			// unit to remain inactive/dead, with no pending job or running process.
			if (
				!isDeepStrictEqual(await manager.inspect(signal), {
					invocationId: completion.invocationId,
					activeState: "active",
					subState: "exited",
					result: "success",
					mainPid: 0,
					controlPid: 0,
					jobId: 0,
					execMainCode: 1,
					execMainStatus: 0,
				})
			)
				throw new Error("invocation");
			for (const [path, bytes, mode] of [
				["/etc/qorpera-office/preparation.json", requestBytes, 0o444],
				[`${root}/result.json`, reportBytes, 0o600],
				[`${root}/completion.json`, completionBytes, 0o600],
				[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, receiptBytes, 0o444],
				[`${root}/configuration-incoming-${command.requestSha256}.json`, staged, 0o400],
			] as const) {
				if (!(await readCompanyComputerPreparationProtected(path, bytes.length, mode)).equals(bytes))
					throw new Error("evidence changed");
			}
			signal.throwIfAborted();
		};
		const installed = {
			schema: "qorpera.office-configuration-completion/v1",
			command,
			preparation,
			preparationCompletionSha256: hash(completionBytes),
			adoptionReceiptSha256: receiptSha256,
			files: Object.fromEntries(
				[...contents].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: hash(bytes) }]),
			),
		};
		const installedBytes = encode(installed);
		const readInstalled = async () => {
			await assertCompanyComputerBootCredentials(command);
			for (const installedRoot of [credentialsRoot, bootCredentialsRoot]) {
				for (const [file, bytes] of contents) {
					const installed = await readCompanyComputerPreparationProtected(
						`${installedRoot}/${file}`,
						bytes.length,
						0o400,
					);
					try {
						if (!installed.equals(bytes)) throw new Error("installed changed");
					} finally {
						installed.fill(0);
					}
				}
			}
		};
		await verify();
		let acknowledged = false;
		try {
			const existing = await readCompanyComputerPreparationProtected(
				`${root}/configuration-completion.json`,
				8192,
				0o600,
			);
			if (!existing.equals(installedBytes)) throw new Error("completion changed");
			acknowledged = true;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		const claim = encode({ schema: "qorpera.office-configuration-claim/v1", command, preparation });
		if (acknowledged) {
			if (
				!(await readCompanyComputerPreparationProtected(`${root}/configuration-claim.json`, 4096, 0o600)).equals(
					claim,
				)
			)
				throw new Error("claim changed");
			await readInstalled();
		} else {
			await publishCompanyComputerPreparationProtected(`${root}/configuration-claim.json`, claim, 0o600);
			await assertCompanyComputerBootCredentials(command, true);
			for (const installedRoot of [credentialsRoot, bootCredentialsRoot]) {
				for (const [file, bytes] of contents) {
					await verify();
					await publishCompanyComputerPreparationProtected(`${installedRoot}/${file}`, bytes, 0o400);
				}
			}
			await readInstalled();
		}
		await verify();
		await publishCompanyComputerPreparationProtected(`${root}/configuration-completion.json`, installedBytes, 0o600);
		return installed;
	} catch {
		// Never expose TLS/parser messages or the staged credential document.
		throw new Error("OFFICE_CONFIGURATION_UNCONFIRMED");
	} finally {
		for (const bytes of buffers) bytes.fill(0);
		pending = false;
	}
}
