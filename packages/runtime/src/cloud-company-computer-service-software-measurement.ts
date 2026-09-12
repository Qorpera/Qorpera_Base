import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_CGROUP,
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceSoftwareInvocationChallenge,
	parseCompanyComputerServiceSoftwareInvocationEvidence,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import { readCompanyComputerBootServiceStartEvidence } from "./cloud-company-computer-boot-service-start-evidence.ts";
import { readCompanyComputerLinuxMetadata } from "./cloud-company-computer-linux-host.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	readCompanyComputerPreparationProtected,
} from "./cloud-company-computer-preparation-control.ts";
import { readCompanyComputerResetServiceStartEvidence } from "./cloud-company-computer-reset-successor-evidence.ts";
import { parseCompanyComputerServiceConfig } from "./cloud-company-computer-service-config.ts";
import { companyComputerSuccessorClaimPath } from "./cloud-company-computer-service-invocation-evidence.ts";
import { openCompanyComputerInstalledServiceSoftware } from "./cloud-company-computer-service-software-file.ts";
import { assertCompanyComputerServiceRunning } from "./cloud-company-computer-service-start-control.ts";
import { readCompanyComputerServiceStartEvidence } from "./cloud-company-computer-service-start-evidence.ts";
import { createCompanyComputerServiceStartSystemdManager } from "./cloud-company-computer-service-start-systemd.ts";
import { createCompanyComputerServiceStopSystemdManager } from "./cloud-company-computer-service-stop-systemd.ts";
import { readCompanyComputerStopInvocation } from "./cloud-company-computer-stop-invocation.ts";

const path = COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function absent(path: string) {
	try {
		await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error("OFFICE_SOFTWARE_MEASUREMENT_INVOCATION_SUPERSEDED");
}
async function processIdentity(pid: number) {
	const cgroup = await readCompanyComputerLinuxMetadata(`/proc/${pid}/cgroup`, 4096);
	const command = await readCompanyComputerLinuxMetadata(`/proc/${pid}/cmdline`, 4096);
	const stat = await readCompanyComputerLinuxMetadata(`/proc/${pid}/stat`, 4096);
	const end = stat.lastIndexOf(") "),
		startTicks = stat
			.slice(end + 2)
			.trim()
			.split(/\s+/)[19];
	if (
		cgroup !== `0::${COMPANY_COMPUTER_SERVICE_CGROUP}\n` ||
		command !== `/usr/bin/node\0${path}\0` ||
		!stat.startsWith(`${pid} (`) ||
		end < 0 ||
		!/^([RSDI])\s/.test(stat.slice(end + 2)) ||
		!/^[1-9][0-9]{0,19}$/.test(startTicks ?? "")
	)
		throw new Error("OFFICE_SOFTWARE_MEASUREMENT_PROCESS_DIFFERS");
	return { pid, startTicks };
}
let pending = false;
/** Read-only protected measurement under the already-held preparation flock.
 * command.requestSha256 binds MeasurementText(parsed challenge). No capability
 * secret or remote input can select a path/manager. The caller must enforce its
 * original RPC deadline through measurement, acknowledgement and activation;
 * this helper never resets validForMs. Installed-before-start ordering remains
 * the governed worker's responsibility: disk bytes do not prove loaded JS. */
export async function measureCompanyComputerServiceSoftware(
	value: unknown,
	challengeValue: unknown,
	signal: AbortSignal,
) {
	if (pending) throw new Error("OFFICE_SOFTWARE_MEASUREMENT_PENDING");
	pending = true;
	let installed: Awaited<ReturnType<typeof openCompanyComputerInstalledServiceSoftware>> | undefined;
	let bootMaterial:
		| Awaited<ReturnType<typeof readCompanyComputerBootServiceStartEvidence>>
		| Awaited<ReturnType<typeof readCompanyComputerResetServiceStartEvidence>>
		| undefined;
	try {
		signal.throwIfAborted();
		const command = parseCompanyComputerPreparationCommand(value),
			challenge = parseCompanyComputerServiceSoftwareInvocationChallenge(challengeValue);
		if (
			command.bootId !== challenge.startup.bootId ||
			command.requestSha256 !== hash(companyComputerServiceSoftwareMeasurementText(challenge))
		)
			throw new Error("challenge binding");
		await assertCompanyComputerPreparationLockAndBoot(command);
		installed = await openCompanyComputerInstalledServiceSoftware(signal);
		if (!isDeepStrictEqual(installed.service, challenge.service)) throw new Error("installed service differs");
		const retained: { path: string; bytes: Buffer; mode: number }[] = [];
		const read = async (path: string, limit: number, mode: number) => {
			signal.throwIfAborted();
			const bytes = await readCompanyComputerPreparationProtected(path, limit, mode);
			retained.push({ path, bytes, mode });
			return bytes;
		};
		const invocation = await readCompanyComputerStopInvocation(challenge.activationId, command.bootId, read);
		if (
			invocation.start.command.commandId === command.commandId ||
			invocation.start.serviceInvocationId !== challenge.startup.serviceInvocationId ||
			invocation.start.configurationSha256 !== challenge.startup.configurationSha256
		)
			throw new Error("invocation differs");
		const originalMaterial =
			invocation.kind === "original"
				? await readCompanyComputerServiceStartEvidence(command, invocation.request, signal)
				: undefined;
		if (invocation.kind === "reset")
			bootMaterial = await readCompanyComputerResetServiceStartEvidence(command, invocation.request, signal);
		else if (invocation.kind !== "original")
			bootMaterial = await readCompanyComputerBootServiceStartEvidence(command, invocation.origin.request, signal);
		const material = originalMaterial ?? bootMaterial!;
		const expectedPreparation = originalMaterial?.preparation ?? {
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
		const startManager = createCompanyComputerServiceStartSystemdManager(),
			currentManager = createCompanyComputerServiceStopSystemdManager();
		const verify = async () => {
			signal.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			for (const path of [
				invocation.stopPaths.claim,
				invocation.stopPaths.completion,
				companyComputerSuccessorClaimPath(challenge.activationId),
			])
				await absent(path);
			await material.verify();
			const initial = await startManager.inspect(signal),
				observed = await currentManager.inspect(signal);
			if (
				!isDeepStrictEqual(initial.preparation, expectedPreparation) ||
				!isDeepStrictEqual(initial.service, observed.service) ||
				observed.cgroupState !== "populated"
			)
				throw new Error("units differ");
			assertCompanyComputerServiceRunning(observed.service);
			if (
				observed.service.invocationId !== invocation.start.serviceInvocationId ||
				observed.service.mainPid !== invocation.start.mainPid ||
				observed.service.controlGroup !== invocation.start.controlGroup
			)
				throw new Error("current invocation differs");
			const process = await processIdentity(observed.service.mainPid);
			const bytes = await readCompanyComputerPreparationProtected(invocation.configurationPath, 65536, 0o400);
			try {
				const config = parseCompanyComputerServiceConfig(new TextDecoder("utf8", { fatal: true }).decode(bytes));
				const startup = parseCompanyComputerStartupIdentity({
					scope: config.scope,
					computerGeneration: config.computerGeneration,
					allocationId: config.linux.attestation.allocationId,
					instanceSha256: config.linux.attestation.instanceSha256,
					imageSha256: config.linux.attestation.imageSha256,
					bootstrapSha256: config.linux.attestation.bootstrapSha256,
					bootId: config.linux.attestation.bootId,
					configurationSha256: hash(bytes),
					serviceInvocationId: observed.service.invocationId,
				});
				if (!isDeepStrictEqual(startup, challenge.startup)) throw new Error("startup differs");
			} finally {
				bytes.fill(0);
			}
			for (const record of retained)
				if (
					!(await readCompanyComputerPreparationProtected(record.path, record.bytes.length, record.mode)).equals(
						record.bytes,
					)
				)
					throw new Error("evidence changed");
			await installed!.verify();
			const final = await currentManager.inspect(signal);
			if (
				!isDeepStrictEqual(final, observed) ||
				!isDeepStrictEqual(await processIdentity(observed.service.mainPid), process)
			)
				throw new Error("process changed during measurement");
			await assertCompanyComputerPreparationLockAndBoot(command);
			signal.throwIfAborted();
			return { service: observed.service, process };
		};
		const before = await verify(),
			after = await verify();
		if (!isDeepStrictEqual(before, after)) throw new Error("invocation changed");
		const evidence = parseCompanyComputerServiceSoftwareInvocationEvidence(
			{
				schema: "qorpera.office-software-invocation-evidence/v1",
				challengeId: challenge.challengeId,
				activationId: challenge.activationId,
				startup: challenge.startup,
				revision: challenge.revision,
				capabilityRevision: challenge.capabilityRevision,
				service: installed.service,
				mainPid: after.service.mainPid,
				controlGroup: after.service.controlGroup,
				configurationCompletionSha256: invocation.start.configurationCompletionSha256,
				serviceStartCompletionSha256: hash(invocation.bytes),
			},
			challenge,
		);
		return Object.freeze({ evidence, evidenceSha256: hash(companyComputerServiceSoftwareMeasurementText(evidence)) });
	} catch {
		throw new Error("OFFICE_SOFTWARE_INVOCATION_UNCONFIRMED");
	} finally {
		try {
			await bootMaterial?.close();
		} finally {
			try {
				await installed?.close();
			} finally {
				pending = false;
			}
		}
	}
}
