import { createHash } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_ADOPTION_RECEIPT_PATH,
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES,
	COMPANY_COMPUTER_PREPARATION_MAX_BYTES,
	type CompanyComputerOutageConfigurationCompletion,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerOutageAdoptionReceipt,
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageResumeObservationCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerOutageConfigurationRequest,
	parseCompanyComputerOutageTerminationInspection,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import {
	type CompanyComputerBootConfigurationManager,
	companyComputerLinuxServiceSection,
} from "./cloud-company-computer-boot-configuration-control.ts";
import { assertCompanyComputerBootCredentials } from "./cloud-company-computer-boot-credentials.ts";
import { readCompanyComputerOutagePredecessor } from "./cloud-company-computer-outage-predecessor.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	OFFICE_PREPARATION_CONTROL_ROOT as incomingRoot,
	publishCompanyComputerPreparationProtected as publish,
	readCompanyComputerPreparationProtected as read,
} from "./cloud-company-computer-preparation-control.ts";
import { openCompanyComputerRetainedWorkbench } from "./cloud-company-computer-retained-workbench.ts";
import {
	companyComputerLinuxBinding,
	parseCompanyComputerServiceConfig,
} from "./cloud-company-computer-service-config.ts";

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
/** Current provider/SQL authority belongs to the caller. This root-only helper
 * binds immutable predecessor history and actual retained-mount custody to one
 * new boot. It neither starts a unit nor replays initial preparation. */
export async function controlCompanyComputerOutageConfiguration(
	value: unknown,
	manager: CompanyComputerBootConfigurationManager,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_OUTAGE_CONFIGURATION_PENDING");
	pending = true;
	const buffers: Buffer[] = [];
	let workbench: Awaited<ReturnType<typeof openCompanyComputerRetainedWorkbench>> | undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		await assertCompanyComputerPreparationLockAndBoot(command);
		const stagedPath = `${incomingRoot}/outage-configuration-incoming-${command.requestSha256}.json`;
		const staged = await read(stagedPath, COMPANY_COMPUTER_OUTAGE_CONFIGURATION_MAX_BYTES, 0o400);
		buffers.push(staged);
		if (hash(staged) !== command.requestSha256) throw new Error("staged packet changed");
		const input = parseCompanyComputerOutageConfigurationRequest(decode(staged)),
			recovery = input.recovery,
			intent = recovery.request;
		if (input.observation.bootId !== command.bootId) throw new Error("boot proof differs");
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
			observationSha256 = hash(companyComputerOutageResumeObservationCanonical(input.observation, recovery));
		const receipt = companyComputerOutageAdoptionReceipt(
				original,
				input.originPreparationSha256,
				originSha256,
				recovery,
				input.observation,
				input.termination,
				observationSha256,
				hash(companyComputerOutageTerminationAcknowledgementCanonical(input.termination)),
			),
			receiptBytes = Buffer.from(`${companyComputerOutageAdoptionReceiptCanonical(receipt)}\n`);
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
		const inspection = input.termination.request.inspection,
			inspectionPath = `${incomingRoot}/outage-termination-inspection-${inspection.inspectionId}.json`,
			inspectionBytes = await read(inspectionPath, 16384, 0o600);
		buffers.push(inspectionBytes);
		// The provider canonicalizes the packet, and SQL JSON may reorder keys.
		// Match the complete validated inspection, then pin the original guest
		// bytes for every subsequent custody check without rewriting the file.
		if (!isDeepStrictEqual(parseCompanyComputerOutageTerminationInspection(decode(inspectionBytes)), inspection))
			throw new Error("outage termination inspection differs");
		const verifyHistory = async () => {
			const evidence = await readCompanyComputerOutagePredecessor(
				{
					startup: recovery.predecessor.startup,
					bootId: command.bootId,
					originPreparationSha256: input.originPreparationSha256,
				},
				read,
				signal,
			);
			try {
				if (
					evidence.originAdoptionReceiptSha256 !== inspection.originAdoptionReceiptSha256 ||
					evidence.predecessorAdoptionReceiptSha256 !== inspection.predecessorAdoptionReceiptSha256 ||
					evidence.predecessorConfigurationSha256 !== inspection.predecessorConfigurationSha256 ||
					inspection.bootObservationSha256 !== observationSha256
				)
					throw new Error("outage termination retained proof differs");
				const confirmed = await read(inspectionPath, 16384, 0o600);
				try {
					if (!confirmed.equals(inspectionBytes)) throw new Error("outage termination inspection differs");
				} finally {
					confirmed.fill(0);
				}
				await evidence.verify();
			} finally {
				evidence.close();
			}
		};
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
		const completion: CompanyComputerOutageConfigurationCompletion = {
			schema: "qorpera.office-outage-configuration-completion/v1",
			command,
			recoveryId: intent.recoveryId,
			activationId: intent.activationId,
			originPreparationSha256: input.originPreparationSha256,
			adoptionReceiptSha256: receiptSha256,
			bootObservationSha256: observationSha256,
			files: Object.fromEntries(
				[...contents].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: hash(bytes) }]),
			) as CompanyComputerOutageConfigurationCompletion["files"],
		};
		const completedBytes = encode(completion),
			claim = encode({
				schema: "qorpera.office-outage-configuration-claim/v1",
				command,
				recoveryId: intent.recoveryId,
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
		throw new Error("OFFICE_OUTAGE_CONFIGURATION_UNCONFIRMED");
	} finally {
		try {
			await workbench?.close();
		} finally {
			for (const bytes of buffers) bytes.fill(0);
			pending = false;
		}
	}
}
