import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CompanyComputerPreparationCommand,
	type CompanyComputerServiceSoftwareInvocationChallenge,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
} from "../../packages/contracts/src/index.ts";
import { officeRecord, officeSha } from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";
import { measureCompanyComputerServiceSoftware } from "../../packages/runtime/src/cloud-company-computer-service-software-measurement.ts";
import { OFFICE_SOFTWARE_TOOLS, runPinnedOfficeSoftwareTool } from "./office-software-control-launcher.ts";

export const OFFICE_SOFTWARE_MEASUREMENT_TOOL = OFFICE_SOFTWARE_TOOLS.measure;
export const OFFICE_SOFTWARE_MEASUREMENT_CLAIM_SCHEMA = "qorpera.office-software-measurement-claim/v1";
export const OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA = "qorpera.office-software-measurement-receipt/v1";
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const canonical = (value: unknown): string => {
	const sorted = (item: unknown): unknown =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, entry]) => [key, sorted(entry)]),
				)
			: item;
	return `${JSON.stringify(sorted(value))}\n`;
};

/** Public paths under the root-only preparation directory. The incoming file
 * is staged by the provider; claim and receipt are published by this tool. */
export const officeSoftwareMeasurementPaths = Object.freeze({
	incoming: (requestSha256: string) => `${root}/software-measurement-incoming-${officeSha(requestSha256)}.json`,
	claim: (challengeId: string) => `${root}/software-measurement-claim-${challengeId}.json`,
	receipt: (challengeId: string) => `${root}/software-measurement-${challengeId}.json`,
});

/** CLI arguments carry no secret: command UUID, canonical request digest, boot
 * UUID and the independently pinned tool digest. `--locked` is internal. */
export function parseOfficeSoftwareMeasurementArgs(args: readonly string[]) {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 4) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_ARGUMENTS");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	return { locked, command, toolSha256: officeSha(values[3]) };
}

export interface OfficeSoftwareMeasurementPorts {
	/** Must verify the real preparation flock is owned by this process in the
	 * command's boot. Called before any durable local work and again before
	 * publication. */
	lockAndBoot(command: CompanyComputerPreparationCommand): Promise<void>;
	read(path: string, limit: number, mode: number): Promise<Buffer>;
	/** Atomic no-overwrite publication; returns false when an identical file
	 * already exists and throws on a different existing file. */
	publish(path: string, bytes: Buffer, mode: number): Promise<boolean>;
	measure(
		command: CompanyComputerPreparationCommand,
		challenge: Readonly<CompanyComputerServiceSoftwareInvocationChallenge>,
		signal: AbortSignal,
	): Promise<{ evidence: unknown; evidenceSha256: string }>;
}
export type OfficeSoftwareMeasurementReceipt = Readonly<{
	schema: typeof OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA;
	challengeId: string;
	evidence: ReturnType<typeof parseCompanyComputerServiceSoftwareInvocationEvidence>;
	evidenceSha256: string;
}>;

async function absent(ports: OfficeSoftwareMeasurementPorts, path: string, limit: number): Promise<Buffer | undefined> {
	try {
		return await ports.read(path, limit, 0o400);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** One challenge, one claim, one receipt. Rules:
 * - The staged request must be the exact canonical challenge text and its digest.
 * - A claim is published BEFORE measuring. An identical retained claim with a
 *   retained receipt returns that receipt unchanged (exact replay).
 * - An identical claim without a receipt is an incomplete attempt: it holds and
 *   needs a fresh SQL challenge; measurement is never rerun for the same nonce.
 * - A different claim, a receipt without claim, or a receipt that does not
 *   bind this challenge holds. Nothing is ever deleted. */
export async function measureOfficeSoftwareWithinClaim(
	input: { command: CompanyComputerPreparationCommand; toolSha256: string },
	ports: OfficeSoftwareMeasurementPorts,
	signal: AbortSignal,
): Promise<OfficeSoftwareMeasurementReceipt> {
	const command = parseCompanyComputerPreparationCommand(input.command),
		toolSha256 = officeSha(input.toolSha256);
	signal.throwIfAborted();
	await ports.lockAndBoot(command);
	const requestBytes = await ports.read(officeSoftwareMeasurementPaths.incoming(command.requestSha256), 16384, 0o400);
	if (hash(requestBytes) !== command.requestSha256) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_REQUEST");
	const challenge = parseCompanyComputerServiceSoftwareInvocationChallenge(decode(requestBytes));
	if (
		Buffer.from(companyComputerServiceSoftwareMeasurementText(challenge)).compare(requestBytes) !== 0 ||
		challenge.startup.bootId !== command.bootId ||
		challenge.challengeId === command.commandId
	)
		throw new Error("OFFICE_SOFTWARE_MEASUREMENT_REQUEST");
	const claim = Buffer.from(
		canonical({
			schema: OFFICE_SOFTWARE_MEASUREMENT_CLAIM_SCHEMA,
			challengeId: challenge.challengeId,
			activationId: challenge.activationId,
			command,
			toolSha256,
		}),
	);
	const claimPath = officeSoftwareMeasurementPaths.claim(challenge.challengeId),
		receiptPath = officeSoftwareMeasurementPaths.receipt(challenge.challengeId);
	const retainedClaim = await absent(ports, claimPath, 4096),
		retainedReceipt = await absent(ports, receiptPath, 16384);
	const parseReceipt = (bytes: Buffer): OfficeSoftwareMeasurementReceipt => {
		const value = officeRecord(decode(bytes), ["schema", "challengeId", "evidence", "evidenceSha256"]);
		const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(value.evidence, challenge);
		const evidenceSha256 = hash(companyComputerServiceSoftwareMeasurementText(evidence));
		if (
			value.schema !== OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA ||
			value.challengeId !== challenge.challengeId ||
			officeSha(value.evidenceSha256) !== evidenceSha256
		)
			throw new Error("OFFICE_SOFTWARE_MEASUREMENT_RECEIPT");
		return Object.freeze({ schema: OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA, challengeId: challenge.challengeId, evidence, evidenceSha256 });
	};
	if (retainedReceipt && !retainedClaim) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_UNCLAIMED");
	if (retainedClaim) {
		if (!retainedClaim.equals(claim)) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_CLAIM_CONFLICT");
		if (!retainedReceipt) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_CLAIM_INCOMPLETE");
		return parseReceipt(retainedReceipt);
	}
	signal.throwIfAborted();
	await ports.lockAndBoot(command);
	if (!(await ports.publish(claimPath, claim, 0o400))) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_CLAIM_RACED");
	const measured = await ports.measure(command, challenge, signal);
	const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(measured.evidence, challenge);
	const evidenceSha256 = hash(companyComputerServiceSoftwareMeasurementText(evidence));
	if (evidenceSha256 !== officeSha(measured.evidenceSha256)) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_EVIDENCE");
	const receipt = Buffer.from(
		canonical({ schema: OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_SCHEMA, challengeId: challenge.challengeId, evidence, evidenceSha256 }),
	);
	signal.throwIfAborted();
	await ports.lockAndBoot(command);
	if (!(await ports.publish(receiptPath, receipt, 0o400))) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_RECEIPT_RACED");
	return parseReceipt(receipt);
}

export async function runOfficeSoftwareMeasurementControl(args: readonly string[]): Promise<void> {
	const input = parseOfficeSoftwareMeasurementArgs(args);
	await runPinnedOfficeSoftwareTool("measure", args, input, import.meta.url, (signal) =>
		measureOfficeSoftwareWithinClaim(input, {
			lockAndBoot: assertCompanyComputerPreparationLockAndBoot,
			read: readCompanyComputerPreparationProtected,
			publish: publishCompanyComputerPreparationProtected,
			measure: measureCompanyComputerServiceSoftware,
		}, signal),
	);
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Pinned temporary root software invocation measurement. Reads a staged canonical challenge, claims its nonce once, measures the actual running service under the preparation flock and publishes a closed receipt. No SQL, capability, start or activation.",
		);
	else
		runOfficeSoftwareMeasurementControl(process.argv.slice(2)).catch(() => {
			console.error("OFFICE_SOFTWARE_MEASUREMENT_UNCONFIRMED");
			process.exitCode = 1;
		});
}
