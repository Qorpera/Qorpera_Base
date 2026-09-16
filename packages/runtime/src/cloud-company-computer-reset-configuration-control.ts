import { createHash } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM,
	COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION,
	COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES,
	type CompanyComputerResetConfigurationCompletion,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResetAdoptionReceipt,
	companyComputerResetAdoptionReceiptPath,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerResetConfigurationRequest,
} from "@qorpera/contracts";
import {
	type CompanyComputerBootConfigurationManager,
	companyComputerLinuxServiceSection,
	createCompanyComputerBootConfigurationSystemdManager,
} from "./cloud-company-computer-boot-configuration-control.ts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	OFFICE_PREPARATION_CONTROL_ROOT as incomingRoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
} from "./cloud-company-computer-preparation-control.ts";
import {
	assertCompanyComputerResetRootClean,
	verifyCompanyComputerResetPredecessorHistory,
} from "./cloud-company-computer-reset-successor-evidence.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";

export {
	createCompanyComputerBootConfigurationSystemdManager as createCompanyComputerResetConfigurationSystemdManager,
};
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const inactive = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
};
let pending = false;
/** Root-only configuration of a recreated office root after a governed reset.
 * It binds the carried original preparation to the restored public receipt
 * and the predecessor's restored stop history, restores only that public
 * preparation document, installs fresh credentials under this boot's
 * directory and never starts a unit, replays preparation or reads any
 * historical credential. Current provider/SQL authority belongs to the caller. */
export async function controlCompanyComputerResetConfiguration(
	value: unknown,
	manager: CompanyComputerBootConfigurationManager,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_RESET_CONFIGURATION_PENDING");
	pending = true;
	const buffers: Buffer[] = [];
	let workbench: Awaited<ReturnType<typeof openCompanyComputerRetainedWorkbench>> | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		await assertCompanyComputerPreparationLockAndBoot(command);
		const stagedPath = `${incomingRoot}/reset-configuration-incoming-${command.requestSha256}.json`;
		const staged = await read(stagedPath, COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES, 0o400);
		buffers.push(staged);
		if (hash(staged) !== command.requestSha256) throw new Error("staged packet changed");
		const input = parseCompanyComputerResetConfigurationRequest(decode(staged)),
			{ predecessor } = input;
		const originalBytes = Buffer.from(input.originPreparation);
		buffers.push(originalBytes);
		if (hash(originalBytes) !== input.originPreparationSha256) throw new Error("original preparation differs");
		const original = parseCompanyComputerPreparationRequest(decode(originalBytes));
		if (original.bootId === command.bootId || predecessor.startup.bootId === command.bootId)
			throw new Error("boot not distinct");
		const receiptBytes = encode(companyComputerPreparationAdoptionReceipt(original)),
			receiptSha256 = hash(receiptBytes);
		if (receiptSha256 !== input.adoptionReceiptSha256) throw new Error("original receipt differs");
		if (!(await read(COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, 16384, 0o444)).equals(receiptBytes))
			throw new Error("restored receipt differs");
		await assertCompanyComputerResetRootClean(input.activationId);
		// The original preparation document is allowlisted public provenance. It
		// is restored once from the provider's retained bytes; a different
		// surviving copy is never replaced.
		let preparationRestored = false;
		try {
			if (
				!(await read("/etc/qorpera-office/preparation.json", COMPANY_COMPUTER_PREPARATION_MAX_BYTES, 0o444)).equals(
					originalBytes,
				)
			)
				throw new Error("retained preparation differs");
			preparationRestored = true;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		await verifyCompanyComputerResetPredecessorHistory(predecessor, command, signal);
		const config = parseCompanyComputerServiceConfig(input.material.configuration);
		if (
			!isDeepStrictEqual(config.scope, original.scope) ||
			config.computerGeneration !== original.computerGeneration ||
			!isDeepStrictEqual(
				companyComputerLinuxBinding(config.linux),
				companyComputerLinuxServiceSection(
					original,
					command.bootId,
					COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
					receiptSha256,
				),
			)
		)
			throw new Error("new configuration differs");
		const contents = new Map<string, Buffer>();
		for (const [key, file] of Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES)) {
			const bytes = Buffer.from(input.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
			buffers.push(bytes);
			contents.set(file, bytes);
		}
		createSecureContext({
			cert: contents.get("tls-cert.pem"),
			key: contents.get("tls-key.pem"),
			minVersion: "TLSv1.3",
		});
		workbench = await openCompanyComputerRetainedWorkbench(original, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await assertCompanyComputerResetRootClean(input.activationId);
			const state = await manager.inspect(signal);
			if (
				!isDeepStrictEqual(state.preparation, inactive) ||
				!isDeepStrictEqual(state.service, { ...inactive, controlGroup: "", restarts: 0 }) ||
				!["absent", "empty"].includes(state.cgroupState)
			)
				throw new Error("units must remain unstarted in this boot");
			for (const [path, bytes, mode] of [
				[stagedPath, staged, 0o400],
				[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, receiptBytes, 0o444],
				...(preparationRestored ? [["/etc/qorpera-office/preparation.json", originalBytes, 0o444] as const] : []),
			] as const) {
				const current = await read(path, bytes.length, mode);
				try {
					if (!current.equals(bytes)) throw new Error("retained evidence changed");
				} finally {
					current.fill(0);
				}
			}
			await verifyCompanyComputerResetPredecessorHistory(predecessor, command, signal);
			await workbench!.verify();
			signal.throwIfAborted();
		};
		const directory = companyComputerBootDirectory(command.bootId),
			completionPath = `${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_COMPLETION}`,
			claimPath = `${directory}/${COMPANY_COMPUTER_RESET_CONFIGURATION_CLAIM}`;
		const completion: CompanyComputerResetConfigurationCompletion = {
			schema: "qorpera.office-reset-configuration-completion/v1",
			command,
			resetId: input.resetId,
			rootIncarnationId: input.rootIncarnationId,
			activationId: input.activationId,
			originPreparationSha256: input.originPreparationSha256,
			adoptionReceiptSha256: receiptSha256,
			files: Object.fromEntries(
				[...contents].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: hash(bytes) }]),
			) as CompanyComputerResetConfigurationCompletion["files"],
		};
		const completedBytes = encode(completion),
			claim = encode({
				schema: "qorpera.office-reset-configuration-claim/v1",
				command,
				resetId: input.resetId,
				rootIncarnationId: input.rootIncarnationId,
				activationId: input.activationId,
			});
		await verify();
		let acknowledged = false;
		try {
			const retained = await read(completionPath, 16384, 0o600);
			if (!retained.equals(completedBytes)) throw new Error("completion changed");
			acknowledged = true;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		if (acknowledged) {
			if (!preparationRestored) throw new Error("acknowledged configuration without preparation");
			await assertCompanyComputerBootCredentials(command);
			if (!(await read(claimPath, 4096, 0o600)).equals(claim)) throw new Error("claim changed");
		} else {
			if (!preparationRestored) {
				await publish("/etc/qorpera-office/preparation.json", originalBytes, 0o444);
				preparationRestored = true;
			}
			await assertCompanyComputerBootCredentials(command, true);
			await publish(claimPath, claim, 0o600);
			for (const [file, bytes] of contents) {
				await verify();
				await publish(`${directory}/credentials/${file}`, bytes, 0o400);
			}
		}
		for (const [file, bytes] of contents) {
			const current = await read(`${directory}/credentials/${file}`, bytes.length, 0o400);
			try {
				if (!current.equals(bytes)) throw new Error("installed credentials differ");
			} finally {
				current.fill(0);
			}
		}
		// The reset-born boot's retained receipt: public (0444) so the service's
		// readiness check can bind the original attested receipt to this boot.
		const retainedPath = companyComputerResetAdoptionReceiptPath(command.bootId),
			retainedBytes = encode(companyComputerResetAdoptionReceipt(input, command.bootId));
		try {
			if (!(await read(retainedPath, 16384, 0o444)).equals(retainedBytes))
				throw new Error("retained receipt differs");
		} catch (error) {
			if (!missing(error)) throw error;
			await publish(retainedPath, retainedBytes, 0o444);
		}
		await verify();
		await assertCompanyComputerBootCredentials(command);
		await publish(completionPath, completedBytes, 0o600);
		return completion;
	} catch (error) {
		throw new Error("OFFICE_RESET_CONFIGURATION_UNCONFIRMED", { cause: error });
	} finally {
		try {
			await workbench?.close();
		} finally {
			for (const bytes of buffers) bytes.fill(0);
			pending = false;
		}
	}
}
