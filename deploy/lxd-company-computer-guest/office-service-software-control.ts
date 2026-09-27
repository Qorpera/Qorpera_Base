import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readBoundedCloudResponse, supabaseServiceHeaders } from "../../packages/cloud-client/src/cloud-request.ts";
import {
	companyComputerServiceSoftwareChangedFiles,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
} from "../../packages/contracts/src/index.ts";
import {
	officeDigest,
	officeRecord,
	officeSha,
} from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";
import {
	installLxdOfficeServiceSoftwareFiles,
	type LxdOfficeServiceSoftwareFilesOptions,
} from "../../packages/runner-orchestrator/src/lxd-office-service-software-files.ts";
import { verifyLxdOfficeServiceSoftware } from "../../packages/runner-orchestrator/src/lxd-office-service-software.ts";
import { readCompanyComputerBootServiceStartEvidence } from "../../packages/runtime/src/cloud-company-computer-boot-service-start-evidence.ts";
import { assertCompanyComputerImageArtifact } from "../../packages/runtime/src/cloud-company-computer-linux-host.ts";
import {
	assertCompanyComputerPreparationLockAndBoot,
	readCompanyComputerPreparationProtected,
	OFFICE_PREPARATION_CONTROL_ROOT as root,
} from "../../packages/runtime/src/cloud-company-computer-preparation-control.ts";
import { parseCompanyComputerServiceConfig } from "../../packages/runtime/src/cloud-company-computer-service-config.ts";
import { readCompanyComputerResetRetainedEvidence } from "../../packages/runtime/src/cloud-company-computer-reset-successor-evidence.ts";
import { readCompanyComputerServiceStartEvidence } from "../../packages/runtime/src/cloud-company-computer-service-start-evidence.ts";
import {
	assertCompanyComputerServiceStopped,
	createCompanyComputerServiceStopSystemdManager,
} from "../../packages/runtime/src/cloud-company-computer-service-stop-systemd.ts";
import { readCompanyComputerStopHistory } from "../../packages/runtime/src/cloud-company-computer-stop-history.ts";
import { readCompanyComputerStopInvocation } from "../../packages/runtime/src/cloud-company-computer-stop-invocation.ts";
import { maskOfficeSelfUpdateUnits } from "./office-self-update-mask.ts";
import { OFFICE_SOFTWARE_TOOLS, runPinnedOfficeSoftwareTool } from "./office-software-control-launcher.ts";

export const OFFICE_SOFTWARE_CONTROL_TOOL = OFFICE_SOFTWARE_TOOLS.install;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const positive = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 9007199254740990)
		throw new Error("OFFICE_SOFTWARE_CONTROL_NUMBER");
	return value as number;
};
/** This assembly is outside the packages: neither runtime nor provider source
 * imports the other. The operator pins this temporary control tool separately
 * from the unchanged historical office image and service-only signed statement. */
export function parseOfficeSoftwareControlArgs(args: readonly string[]) {
	const locked = args[0] === "--locked",
		values = locked ? args.slice(1) : args;
	if (values.length !== 5) throw new Error("OFFICE_SOFTWARE_CONTROL_ARGUMENTS");
	const command = parseCompanyComputerPreparationCommand({
		commandId: values[0],
		requestSha256: values[1],
		bootId: values[2],
	});
	return { locked, command, toolSha256: officeSha(values[3]), trustSha256: officeSha(values[4]) };
}

/** Every check consumes the ORIGINAL challenge lifetime. The clock starts
 * before the RPC, and refreshing the same challenge can only shorten it. */
export async function installOfficeSoftwareWithinChallenge(
	options: Omit<LxdOfficeServiceSoftwareFilesOptions, "authorize">,
	expected: { challengeId: string; targetRevision: number; capabilityRevision: number },
	ports: {
		verifyLocal(signal: AbortSignal): Promise<void>;
		check(signal: AbortSignal): Promise<unknown>;
		install: typeof installLxdOfficeServiceSoftwareFiles;
	},
	signal: AbortSignal,
) {
	const verified = verifyLxdOfficeServiceSoftware(options.envelope, options.plan, options.trust, options.manifests);
	parseCompanyComputerPreparationCommand({
		commandId: expected.challengeId,
		requestSha256: verified.planSha256,
		bootId: verified.plan.predecessor.startup.bootId,
	});
	positive(expected.targetRevision);
	positive(expected.capabilityRevision);
	let deadline = Number.POSITIVE_INFINITY;
	const authorize = async (caller: AbortSignal) => {
		caller.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("OFFICE_SOFTWARE_CONTROL_EXPIRED");
		await ports.verifyLocal(caller);
		const started = performance.now();
		const challenge = officeRecord(await ports.check(caller), [
			"schema",
			"challengeId",
			"plan",
			"planSha256",
			"statement",
			"targetRevision",
			"validForMs",
			"capabilityRevision",
		]);
		const validForMs = positive(challenge.validForMs);
		if (
			validForMs > 5000 ||
			challenge.schema !== "qorpera.office-software-install-challenge/v1" ||
			challenge.challengeId !== expected.challengeId ||
			challenge.planSha256 !== verified.planSha256 ||
			challenge.targetRevision !== expected.targetRevision ||
			challenge.capabilityRevision !== expected.capabilityRevision ||
			!isDeepStrictEqual(challenge.plan, verified.plan) ||
			!isDeepStrictEqual(challenge.statement, verified.statement)
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_CHALLENGE");
		deadline = Math.min(deadline, started + validForMs);
		if (performance.now() >= deadline) throw new Error("OFFICE_SOFTWARE_CONTROL_EXPIRED");
		await ports.verifyLocal(caller);
		caller.throwIfAborted();
		if (performance.now() >= deadline) throw new Error("OFFICE_SOFTWARE_CONTROL_EXPIRED");
	};
	await authorize(signal);
	const bounded = AbortSignal.any([
		signal,
		AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now()))),
	]);
	const receipt = await ports.install({ ...options, authorize }, bounded);
	bounded.throwIfAborted();
	if (performance.now() >= deadline) throw new Error("OFFICE_SOFTWARE_CONTROL_EXPIRED");
	return receipt;
}

async function readServiceCandidate(path: string, size: number) {
	await assertCompanyComputerImageArtifact(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== 0n ||
			before.gid !== 0n ||
			before.nlink !== 1n ||
			(before.mode & 0o7777n) !== 0o400n ||
			before.size !== BigInt(size) ||
			size < 1 ||
			size > 32 * 1024 ** 2
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_CANDIDATE");
		const bytes = Buffer.alloc(size + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await file.read(bytes, length, bytes.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		const after = await file.stat({ bigint: true }),
			named = await lstat(path, { bigint: true });
		const keys = ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeNs", "ctimeNs"] as const;
		if (length !== size || keys.some((key) => before[key] !== after[key] || before[key] !== named[key]))
			throw new Error("OFFICE_SOFTWARE_CONTROL_CANDIDATE");
		return bytes.subarray(0, length);
	} finally {
		await file.close();
	}
}

async function lockedInstall(input: ReturnType<typeof parseOfficeSoftwareControlArgs>, signal: AbortSignal) {
	const { command } = input;
	await assertCompanyComputerPreparationLockAndBoot(command);
	const evidence: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	const read = async (path: string, limit: number, mode: number) => {
		const bytes = await readCompanyComputerPreparationProtected(path, limit, mode);
		evidence.push({ path, bytes, mode });
		return bytes;
	};
	let closeMaterial: (() => Promise<void>) | undefined;
	try {
		const requestBytes = await read(`${root}/software-incoming-${command.requestSha256}.json`, 65536, 0o400);
		if (hash(requestBytes) !== command.requestSha256) throw new Error("OFFICE_SOFTWARE_CONTROL_REQUEST");
		const packet = officeRecord(decode(requestBytes), [
			"schema",
			"envelope",
			"plan",
			"stop",
			"stopCommand",
			"acknowledgement",
			"challengeId",
			"targetRevision",
			"capabilityRevision",
		]);
		if (packet.schema !== "qorpera.office-software-control/v1") throw new Error("OFFICE_SOFTWARE_CONTROL_REQUEST");
		const trustBytes = await read(`${root}/software-trust-${input.trustSha256}.json`, 4096, 0o400);
		if (hash(trustBytes) !== input.trustSha256) throw new Error("OFFICE_SOFTWARE_CONTROL_TRUST");
		const trustValue = officeRecord(decode(trustBytes), ["verificationKeySpki", "statementSha256", "planSha256"]);
		if (typeof trustValue.verificationKeySpki !== "string") throw new Error("OFFICE_SOFTWARE_CONTROL_TRUST");
		const trust = {
			verificationKeySpki: trustValue.verificationKeySpki,
			statementSha256: officeSha(trustValue.statementSha256),
			planSha256: officeSha(trustValue.planSha256),
		};
		const manifests = {
			previous: await read(`${root}/software-previous-manifest-${trust.planSha256}.json`, 1024 ** 2, 0o400),
			next: await read(`${root}/software-next-manifest-${trust.planSha256}.json`, 1024 ** 2, 0o400),
		};
		const { plan, statement } = verifyLxdOfficeServiceSoftware(packet.envelope, packet.plan, trust, manifests);
		if (
			command.bootId !== plan.predecessor.startup.bootId ||
			[
				plan.updateId,
				plan.predecessor.transitionId,
				plan.predecessor.activationId,
				plan.successorActivationId,
			].includes(command.commandId)
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_IDENTITY");
		const stop = parseCompanyComputerServiceStopRequest(packet.stop),
			stopCommand = parseCompanyComputerPreparationCommand(packet.stopCommand);
		const acknowledgement = parseCompanyComputerServiceStopAcknowledgement(packet.acknowledgement, stop, stopCommand);
		if (
			!isDeepStrictEqual(stop.revocation.request, plan.predecessor) ||
			officeDigest(acknowledgement) !== plan.stopAcknowledgementSha256 ||
			stopCommand.commandId === command.commandId
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_STOP");
		const prior = await readCompanyComputerStopInvocation(plan.predecessor.activationId, command.bootId, read);
		if (
			hash(prior.bytes) !== stop.startCompletionSha256 ||
			prior.start.serviceInvocationId !== plan.predecessor.startup.serviceInvocationId ||
			prior.start.command.commandId === command.commandId
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_PREDECESSOR");
		const material =
			prior.kind === "original"
				? await readCompanyComputerServiceStartEvidence(command, prior.request, signal)
				: prior.kind === "reset" || prior.kind === "reset_restart"
					? await readCompanyComputerResetRetainedEvidence(command, prior.origin.request, signal)
					: await readCompanyComputerBootServiceStartEvidence(command, prior.origin.request, signal);
		if ("close" in material) closeMaterial = material.close;
		const configBytes = await read(prior.configurationPath, 16384, 0o400);
		const config = parseCompanyComputerServiceConfig(configBytes.toString("utf8"));
		if (
			!isDeepStrictEqual(plan.predecessor.startup, {
				scope: config.scope,
				computerGeneration: config.computerGeneration,
				allocationId: config.linux.attestation.allocationId,
				instanceSha256: config.linux.attestation.instanceSha256,
				imageSha256: config.linux.attestation.imageSha256,
				bootstrapSha256: config.linux.attestation.bootstrapSha256,
				bootId: config.linux.attestation.bootId,
				configurationSha256: hash(configBytes),
				serviceInvocationId: prior.start.serviceInvocationId,
			})
		)
			throw new Error("OFFICE_SOFTWARE_CONTROL_CONFIGURATION");
		const registryBytes = await read(`${dirname(prior.configurationPath)}/registry`, 8192, 0o400);
		const capabilityBytes = await read(`${root}/software-capability-${plan.updateId}`, 64, 0o400);
		const registryKey = registryBytes.toString("utf8"),
			capability = capabilityBytes.toString("utf8");
		if (!/^[\x21-\x7e]{32,8192}$/.test(registryKey) || !/^[0-9a-f]{64}$/.test(capability))
			throw new Error("OFFICE_SOFTWARE_CONTROL_CREDENTIAL");
		const archived = await readCompanyComputerStopHistory(command.bootId, plan.predecessor.activationId);
		const archiveSha = archived.manifestSha256;
		try {
			if (
				!isDeepStrictEqual(archived.manifest.command, stopCommand) ||
				archived.manifest.completionPath !== prior.stopPaths.completion ||
				!isDeepStrictEqual(decode(archived.files.get(prior.stopPaths.completion)!), acknowledgement.inspection.stop)
			)
				throw new Error("OFFICE_SOFTWARE_CONTROL_STOP_HISTORY");
			const claim = await read(prior.stopPaths.claim, 8192, 0o600);
			if (!claim.equals(archived.files.get(prior.stopPaths.claim)!))
				throw new Error("OFFICE_SOFTWARE_CONTROL_STOP_HISTORY");
			const stopBytes = await read(`${root}/service-stop-incoming-${stopCommand.requestSha256}.json`, 65536, 0o400);
			if (hash(stopBytes) !== stopCommand.requestSha256 || !isDeepStrictEqual(decode(stopBytes), stop))
				throw new Error("OFFICE_SOFTWARE_CONTROL_STOP_HISTORY");
		} finally {
			for (const bytes of archived.files.values()) bytes.fill(0);
		}
		const completedStop = await read(prior.stopPaths.completion, 8192, 0o600);
		if (!isDeepStrictEqual(decode(completedStop), acknowledgement.inspection.stop))
			throw new Error("OFFICE_SOFTWARE_CONTROL_STOP_HISTORY");
		const serviceBytes = await readServiceCandidate(
			`${root}/software-service-${statement.next.service.sha256}.mjs`,
			statement.next.service.bytes,
		);
		// A guest-code revision stages each changed entry under its content digest.
		const files: Record<string, Buffer> = {};
		for (const entry of companyComputerServiceSoftwareChangedFiles(statement))
			files[entry.file] = await readServiceCandidate(`${root}/software-file-${entry.sha256}`, entry.bytes);
		// After every local check and before this tool's own challenge check (the
		// provider's 5 s install challenge is already running; the helper keeps
		// its work small): the image stops updating itself before any service lands.
		await maskOfficeSelfUpdateUnits();
		const manager = createCompanyComputerServiceStopSystemdManager();
		const verifyLocal = async (checked: AbortSignal) => {
			checked.throwIfAborted();
			await assertCompanyComputerPreparationLockAndBoot(command);
			await material.verify();
			for (const item of evidence) {
				const current = await readCompanyComputerPreparationProtected(item.path, item.bytes.length, item.mode);
				try {
					if (!current.equals(item.bytes)) throw new Error("OFFICE_SOFTWARE_CONTROL_CUSTODY");
				} finally {
					current.fill(0);
				}
			}
			const archive = await readCompanyComputerStopHistory(command.bootId, plan.predecessor.activationId);
			try {
				if (archive.manifestSha256 !== archiveSha) throw new Error("OFFICE_SOFTWARE_CONTROL_STOP_HISTORY");
			} finally {
				for (const bytes of archive.files.values()) bytes.fill(0);
			}
			const observed = await manager.inspect(checked);
			assertCompanyComputerServiceStopped(observed);
			if (
				observed.service.invocationId &&
				observed.service.invocationId !== acknowledgement.inspection.stop.stoppedInvocationId
			)
				throw new Error("OFFICE_SOFTWARE_CONTROL_NEW_INVOCATION");
			checked.throwIfAborted();
		};
		return await installOfficeSoftwareWithinChallenge(
			{ envelope: packet.envelope, plan, trust, manifests, serviceBytes, files },
			{
				challengeId: String(packet.challengeId),
				targetRevision: positive(packet.targetRevision),
				capabilityRevision: positive(packet.capabilityRevision),
			},
			{
				verifyLocal,
				install: installLxdOfficeServiceSoftwareFiles,
				async check(checked) {
					const response = await fetch(`${config.registryUrl}/rest/v1/rpc/qorpera_check_office_software_install`, {
						method: "POST",
						redirect: "error",
						signal: AbortSignal.any([checked, AbortSignal.timeout(3000)]),
						headers: { ...supabaseServiceHeaders(registryKey), "content-type": "application/json" },
						body: JSON.stringify({
							p_update_id: plan.updateId,
							p_challenge_id: packet.challengeId,
							p_provider_capability: capability,
						}),
					});
					if (!response.ok) {
						await response.body?.cancel();
						throw new Error("OFFICE_SOFTWARE_CONTROL_AUTHORITY");
					}
					return decode(await readBoundedCloudResponse(response, 65536, checked));
				},
			},
			signal,
		);
	} finally {
		try {
			await closeMaterial?.();
		} finally {
			for (const item of evidence) item.bytes.fill(0);
		}
	}
}

export async function runOfficeSoftwareControl(args: readonly string[]): Promise<void> {
	const input = parseOfficeSoftwareControlArgs(args);
	await runPinnedOfficeSoftwareTool("install", args, input, import.meta.url, (signal) => lockedInstall(input, signal));
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--help")
		console.log(
			"Pinned temporary root software installation control. Requires independent provider capability, exact stopped history and continuous preparation flock. Masks the image's apt self-update units first. Does not start or activate a service.",
		);
	else
		runOfficeSoftwareControl(process.argv.slice(2)).catch(() => {
			console.error("OFFICE_SOFTWARE_CONTROL_UNCONFIRMED");
			process.exitCode = 1;
		});
}
