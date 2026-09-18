import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStartRequest,
} from "@qorpera/contracts";
import {
	assertCompanyComputerNoServiceStopClaim,
	assertCompanyComputerPreparationLockAndBoot,
	publishCompanyComputerPreparationProtected,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "./cloud-company-computer-preparation-control.ts";
import { readCompanyComputerServiceStartEvidence } from "./cloud-company-computer-service-start-evidence.ts";
import type {
	CompanyComputerServiceStartManager,
	CompanyComputerServiceUnitState,
} from "./cloud-company-computer-service-start-systemd.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const json = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const neverStarted: CompanyComputerServiceUnitState = {
	invocationId: "",
	activeState: "inactive",
	subState: "dead",
	result: "success",
	mainPid: 0,
	controlPid: 0,
	jobId: 0,
	execMainCode: 0,
	execMainStatus: 0,
	controlGroup: "",
	restarts: 0,
};
export function assertCompanyComputerServiceRunning(state: CompanyComputerServiceUnitState): void {
	if (
		!/^(?!0{32}$)[0-9a-f]{32}$/.test(state.invocationId) ||
		!Number.isSafeInteger(state.mainPid) ||
		state.mainPid < 1 ||
		!isDeepStrictEqual(state, {
			...neverStarted,
			invocationId: state.invocationId,
			activeState: "active",
			subState: "running",
			mainPid: state.mainPid,
			controlGroup: "/system.slice/qorpera-company-computer.service",
		})
	)
		throw new Error("service not running");
}
let pending = false;
/** Starts only the fixed ordinary service, under the existing kernel flock.
 * The claim precedes systemctl. A surviving claim can recover a running unit
 * but never repeat a start whose outcome is unknown. Completion means the
 * measured unit is running; only the separate SQL handshake grants readiness.
 * Every replay rechecks protected configuration and the actual invocation. */
export async function controlCompanyComputerServiceStart(
	value: unknown,
	manager: CompanyComputerServiceStartManager,
	signal: AbortSignal,
	inspectOnly = false,
) {
	if (pending) throw new Error("OFFICE_SERVICE_START_PENDING");
	pending = true;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value);
		await assertCompanyComputerPreparationLockAndBoot(command);
		await assertCompanyComputerNoServiceStopClaim();
		const staged = await readCompanyComputerPreparationProtected(
			`${root}/service-start-incoming-${command.requestSha256}.json`,
			COMPANY_COMPUTER_SERVICE_START_MAX_BYTES,
			0o400,
		);
		if (hash(staged) !== command.requestSha256) throw new Error("staging changed");
		const request = parseCompanyComputerServiceStartRequest(json(staged));
		if (
			request.attestation.bootId !== command.bootId ||
			[request.configuration.command.commandId, request.configuration.preparation.commandId].includes(
				command.commandId,
			)
		)
			throw new Error("command differs");
		const material = await readCompanyComputerServiceStartEvidence(command, request, signal);
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await assertCompanyComputerNoServiceStopClaim();
			if (
				!(
					await readCompanyComputerPreparationProtected(
						`${root}/service-start-incoming-${command.requestSha256}.json`,
						staged.length,
						0o400,
					)
				).equals(staged)
			)
				throw new Error("staging changed");
			await material.verify();
			const observed = await manager.inspect(signal);
			if (!isDeepStrictEqual(observed.preparation, material.preparation))
				throw new Error("preparation unit changed");
			signal.throwIfAborted();
			return observed.service;
		};
		const claimBytes = encode({
			schema: "qorpera.office-service-start-claim/v1",
			command,
			activationId: request.attestation.activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
		});
		const claimPath = `${root}/service-start-claim.json`,
			completionPath = `${root}/service-start-completion.json`;
		let claim: Buffer | undefined, completion: Buffer | undefined;
		try {
			claim = await readCompanyComputerPreparationProtected(claimPath, 4096, 0o600);
		} catch (error) {
			if (!absent(error)) throw error;
		}
		try {
			completion = await readCompanyComputerPreparationProtected(completionPath, 8192, 0o600);
		} catch (error) {
			if (!absent(error)) throw error;
		}
		if (claim && !claim.equals(claimBytes)) throw new Error("claim differs");
		if (completion && !claim) throw new Error("claim missing");
		if (inspectOnly && (!claim || !completion)) throw new Error("completed start required for inspection");
		let state = await verify();
		if (!claim) {
			if (!isDeepStrictEqual(state, neverStarted)) throw new Error("unclaimed service");
			await publishCompanyComputerPreparationProtected(claimPath, claimBytes, 0o600);
			signal.throwIfAborted();
			if (!isDeepStrictEqual(await verify(), neverStarted)) throw new Error("service changed before start");
			await manager.start(signal);
			state = await verify();
		}
		assertCompanyComputerServiceRunning(state);
		const result = {
			schema: "qorpera.office-service-start-completion/v1",
			command,
			activationId: request.attestation.activationId,
			configurationCompletionSha256: request.configurationCompletionSha256,
			configurationSha256: request.attestation.configurationSha256,
			serviceInvocationId: state.invocationId,
			mainPid: state.mainPid,
			controlGroup: state.controlGroup,
		};
		const resultBytes = encode(result);
		if (completion && !completion.equals(resultBytes)) throw new Error("completed invocation changed");
		if (
			!(await readCompanyComputerPreparationProtected(claimPath, 4096, 0o600)).equals(claimBytes) ||
			!isDeepStrictEqual(await verify(), state)
		)
			throw new Error("service changed during confirmation");
		if (!inspectOnly) await publishCompanyComputerPreparationProtected(completionPath, resultBytes, 0o600);
		return result;
	} catch {
		throw new Error("OFFICE_SERVICE_START_UNCONFIRMED");
	} finally {
		pending = false;
	}
}

/** Fresh independent readback for a provider-owned inspection nonce. This
 * cannot start a unit or reconstruct a missing start acknowledgement. A
 * provider must bound the whole new inspection operation; a retained file or
 * an old successful LXD operation alone does not prove current liveness. */
export async function inspectCompanyComputerServiceStart(
	value: unknown,
	inspectionId: string,
	manager: CompanyComputerServiceStartManager,
	signal: AbortSignal,
) {
	const command = parseCompanyComputerPreparationCommand(value);
	const inspection = parseCompanyComputerPreparationCommand({ ...command, commandId: inspectionId });
	if (inspection.commandId === command.commandId) throw new Error("OFFICE_SERVICE_INSPECTION_IDENTITY_DIFFERS");
	await assertCompanyComputerPreparationLockAndBoot(command);
	const start = await controlCompanyComputerServiceStart(command, manager, signal, true);
	const result = { schema: "qorpera.office-service-inspection/v1", inspectionId, start };
	await assertCompanyComputerPreparationLockAndBoot(command);
	signal.throwIfAborted();
	await publishCompanyComputerPreparationProtected(
		`${root}/service-inspection-${inspectionId}.json`,
		encode(result),
		0o600,
	);
	return result;
}
