import { createHash } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerBootConfigurationCompletion,
	type CompanyComputerPreparationRequest,
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResumeObservationCanonical,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import { verifyCompanyComputerBootPredecessor } from "./cloud-company-computer-boot-predecessor.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	type CompanyComputerPreparationUnitState,
	OFFICE_PREPARATION_CONTROL_ROOT as incomingRoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
} from "./cloud-company-computer-preparation-control.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";
import { createCompanyComputerServiceStartSystemdManager } from "./cloud-company-computer-service-start-systemd.ts";
import {
	type CompanyComputerServiceStopObservation,
	createCompanyComputerServiceStopSystemdManager,
} from "./cloud-company-computer-service-stop-systemd.ts";

export interface CompanyComputerBootConfigurationManager {
	inspect(
		signal: AbortSignal,
	): Promise<CompanyComputerServiceStopObservation & { preparation: CompanyComputerPreparationUnitState }>;
}
export function createCompanyComputerBootConfigurationSystemdManager(): CompanyComputerBootConfigurationManager {
	const start = createCompanyComputerServiceStartSystemdManager(),
		stop = createCompanyComputerServiceStopSystemdManager();
	return {
		async inspect(signal) {
			const before = await start.inspect(signal),
				after = await stop.inspect(signal);
			if (!isDeepStrictEqual(before.service, after.service)) throw new Error("office changed during inspection");
			return { ...after, preparation: before.preparation };
		},
	};
}
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
/** The `linux` section every root helper expects for one retained
 * preparation on a given boot. Only the boot and receipt binding vary. */
export function companyComputerLinuxServiceSection(
	request: CompanyComputerPreparationRequest,
	bootId: string,
	receiptPath: string,
	receiptSha256: string,
) {
	return {
		layout: companyComputerPreparationAdoptionReceipt(request).layout,
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
			bootId,
			adoptionReceiptPath: receiptPath,
			adoptionReceiptSha256: receiptSha256,
		},
	};
}
let pending = false;
/** Current provider/SQL authority belongs to the caller. This root-only helper
 * binds immutable predecessor history and actual retained-mount custody to one
 * new boot. It neither starts a unit nor replays initial preparation. */
export async function controlCompanyComputerBootConfiguration(
	value: unknown,
	manager: CompanyComputerBootConfigurationManager,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_BOOT_CONFIGURATION_PENDING");
	pending = true;
	const buffers: Buffer[] = [];
	let workbench: Awaited<ReturnType<typeof openCompanyComputerRetainedWorkbench>> | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		await assertCompanyComputerPreparationLockAndBoot(command);
		const stagedPath = `${incomingRoot}/boot-configuration-incoming-${command.requestSha256}.json`;
		const staged = await read(stagedPath, COMPANY_COMPUTER_BOOT_CONFIGURATION_MAX_BYTES, 0o400);
		buffers.push(staged);
		if (hash(staged) !== command.requestSha256) throw new Error("staged packet changed");
		const input = parseCompanyComputerBootConfigurationRequest(decode(staged)),
			intent = input.bootIntent.request;
		if (
			input.observation.bootId !== command.bootId ||
			hash(input.powerOffCompletion) !== intent.powerOffCompletionSha256
		)
			throw new Error("boot proof differs");
		const originalBytes = await read(
			"/etc/qorpera-office/preparation.json",
			COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
			0o444,
		);
		buffers.push(originalBytes);
		if (hash(originalBytes) !== input.originPreparationSha256) throw new Error("original preparation differs");
		const original = parseCompanyComputerPreparationRequest(decode(originalBytes)),
			originBytes = encode(companyComputerPreparationAdoptionReceipt(original));
		const originSha256 = hash(originBytes),
			observationSha256 = hash(companyComputerResumeObservationCanonical(input.observation, intent));
		const receipt = companyComputerBootAdoptionReceipt(
				original,
				input.originPreparationSha256,
				originSha256,
				intent,
				input.observation,
				observationSha256,
			),
			receiptBytes = encode(receipt);
		const receiptPath = companyComputerBootAdoptionReceiptPath(command.bootId),
			receiptSha256 = hash(receiptBytes);
		const config = parseCompanyComputerServiceConfig(input.material.configuration);
		if (
			!isDeepStrictEqual(config.scope, original.scope) ||
			config.computerGeneration !== original.computerGeneration ||
			!isDeepStrictEqual(
				companyComputerLinuxBinding(config.linux),
				companyComputerLinuxServiceSection(original, command.bootId, receiptPath, receiptSha256),
			)
		)
			throw new Error("new configuration differs");
		const originalConfig = await read("/etc/qorpera-office/credentials/config.json", 16384, 0o400);
		buffers.push(originalConfig);
		const prior = parseCompanyComputerServiceConfig(originalConfig.toString("utf8"));
		if (
			!isDeepStrictEqual(prior.scope, original.scope) ||
			prior.computerGeneration !== original.computerGeneration ||
			!isDeepStrictEqual(
				companyComputerLinuxBinding(prior.linux),
				companyComputerLinuxServiceSection(
					original,
					original.bootId,
					COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
					originSha256,
				),
			)
		)
			throw new Error("original configuration differs");
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
		const verifyHistory = () =>
			verifyCompanyComputerBootPredecessor(
				{
					command,
					intent,
					original,
					originPreparationSha256: input.originPreparationSha256,
					originReceipt: originBytes,
					originalConfiguration: originalConfig,
				},
				read,
				signal,
			);
		await verifyHistory();
		workbench = await openCompanyComputerRetainedWorkbench(original, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			const state = await manager.inspect(signal);
			if (
				!isDeepStrictEqual(state.preparation, inactive) ||
				!isDeepStrictEqual(state.service, { ...inactive, controlGroup: "", restarts: 0 }) ||
				!["absent", "empty"].includes(state.cgroupState)
			)
				throw new Error("units must remain unstarted in this boot");
			for (const [path, bytes, mode] of [
				[stagedPath, staged, 0o400],
				["/etc/qorpera-office/preparation.json", originalBytes, 0o444],
				[COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH, originBytes, 0o444],
				["/etc/qorpera-office/credentials/config.json", originalConfig, 0o400],
			] as const) {
				const current = await read(path, bytes.length, mode);
				try {
					if (!current.equals(bytes)) throw new Error("retained evidence changed");
				} finally {
					current.fill(0);
				}
			}
			await verifyHistory();
			await workbench!.verify();
			signal.throwIfAborted();
		};
		const directory = companyComputerBootDirectory(command.bootId),
			completionPath = `${directory}/configuration-completion.json`,
			claimPath = `${directory}/configuration-claim.json`;
		const completion: CompanyComputerBootConfigurationCompletion = {
			schema: "qorpera.office-boot-configuration-completion/v1",
			command,
			bootIntentId: intent.bootIntentId,
			activationId: intent.activationId,
			originPreparationSha256: input.originPreparationSha256,
			adoptionReceiptSha256: receiptSha256,
			bootObservationSha256: observationSha256,
			files: Object.fromEntries(
				[...contents].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: hash(bytes) }]),
			) as CompanyComputerBootConfigurationCompletion["files"],
		};
		const completedBytes = encode(completion),
			claim = encode({
				schema: "qorpera.office-boot-configuration-claim/v1",
				command,
				bootIntentId: intent.bootIntentId,
				activationId: intent.activationId,
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
			await assertCompanyComputerBootCredentials(command);
			if (!(await read(claimPath, 4096, 0o600)).equals(claim)) throw new Error("claim changed");
		} else {
			await assertCompanyComputerBootCredentials(command, true);
			await publish(claimPath, claim, 0o600);
			await publish(receiptPath, receiptBytes, 0o444);
			for (const [file, bytes] of contents) {
				await verify();
				await publish(`${directory}/credentials/${file}`, bytes, 0o400);
			}
		}
		if (!(await read(receiptPath, 16384, 0o444)).equals(receiptBytes)) throw new Error("receipt changed");
		for (const [file, bytes] of contents) {
			const current = await read(`${directory}/credentials/${file}`, bytes.length, 0o400);
			try {
				if (!current.equals(bytes)) throw new Error("installed credentials differ");
			} finally {
				current.fill(0);
			}
		}
		await verifyHistory();
		await verify();
		await assertCompanyComputerBootCredentials(command);
		await publish(completionPath, completedBytes, 0o600);
		return completion;
	} catch {
		throw new Error("OFFICE_BOOT_CONFIGURATION_UNCONFIRMED");
	} finally {
		try {
			await workbench?.close();
		} finally {
			for (const bytes of buffers) bytes.fill(0);
			pending = false;
		}
	}
}
