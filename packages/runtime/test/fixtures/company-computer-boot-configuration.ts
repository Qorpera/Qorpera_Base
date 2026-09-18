import { createHash } from "node:crypto";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerBootConfigurationCompletion,
	type CompanyComputerPreparationRequest,
	companyComputerBootAdoptionReceipt,
	companyComputerBootAdoptionReceiptPath,
	companyComputerPreparationAdoptionReceipt,
	companyComputerResumeObservationCanonical,
	companyComputerStopHistoryDirectory,
	parseCompanyComputerBootConfigurationRequest,
	parseCompanyComputerBootIntent,
	parseCompanyComputerBootIntentRequest,
	parseCompanyComputerPreparationRequest,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStopHistoryManifest,
} from "@qorpera/contracts";

export const bootFixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const bootFixtureHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const bootFixtureEncode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const id = bootFixtureId,
	hash = bootFixtureHash,
	encode = bootFixtureEncode;

/** Synthetic predecessor/SQL/VM evidence. Linux probes independently measure
 * the current kernel and mount and seed these explicitly historical records. */
export function bootConfigurationFixture(
	options: {
		bootId?: string;
		uid?: number;
		mount?: CompanyComputerPreparationRequest["workbenchMount"];
		original?: Partial<CompanyComputerPreparationRequest>;
		tlsCert?: string;
		tlsKey?: string;
	} = {},
) {
	const original = parseCompanyComputerPreparationRequest({
		schema: "qorpera.office-guest-preparation/v1",
		scope: { companyId: id(1), environmentId: id(2), companyComputerId: id(3), logicalComputerId: id(4) },
		computerGeneration: 1,
		allocationId: id(5),
		instanceSha256: "a".repeat(64),
		imageSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		bootId: id(7),
		uid: options.uid ?? 1000,
		gid: options.uid ?? 1000,
		copy: {
			adoptionId: id(6),
			observationSha256: "d".repeat(64),
			planSha256: "e".repeat(64),
			reviewSha256: "f".repeat(64),
			outputInventorySha256: "1".repeat(64),
		},
		workbenchMount: options.mount ?? {
			filesystem: "virtiofs",
			source: "lxd_workbench",
			root: "/",
			mountPoint: "/var/lib/qorpera-office",
		},
		limits: { memoryBytes: 256 * 1024 ** 2, pids: 64, cpuQuota: 100000, cpuPeriod: 100000 },
		entries: [
			...[".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
				path,
				kind: "directory",
				mode: 0o700,
				bytes: 0,
				sha256: null,
			})),
			{ path: "workbench/note", kind: "file", mode: 0o600, bytes: 3, sha256: hash("old") },
		],
		...options.original,
	});
	const originReceipt = companyComputerPreparationAdoptionReceipt(original);
	const configuration = {
		schema: "qorpera.company-computer-service/v1",
		scope: original.scope,
		computerGeneration: 1,
		registryUrl: "https://registry.invalid",
		captureObjectGatewayUrl: "https://objects.invalid",
		native: { host: "127.0.0.1", port: 9443 },
		viewer: { host: "127.0.0.1", port: 9444, origins: ["https://app.invalid"] },
		linux: {
			layout: originReceipt.layout,
			limits: original.limits,
			workbenchMount: original.workbenchMount,
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
				allocationId: original.allocationId,
				instanceSha256: original.instanceSha256,
				imageSha256: original.imageSha256,
				bootstrapSha256: original.bootstrapSha256,
				bootId: original.bootId,
				adoptionReceiptPath: "/etc/qorpera-office/adoption.json",
				adoptionReceiptSha256: hash(encode(originReceipt)),
			},
		},
	};
	const oldConfiguration = JSON.stringify(configuration);
	const predecessor = {
		schema: "qorpera.office-lifecycle-request/v1",
		action: "reboot",
		transitionId: id(8),
		activationId: id(9),
		providerId: id(10),
		providerPolicySha256: "2".repeat(64),
		startup: {
			scope: original.scope,
			computerGeneration: 1,
			allocationId: original.allocationId,
			instanceSha256: original.instanceSha256,
			imageSha256: original.imageSha256,
			bootstrapSha256: original.bootstrapSha256,
			bootId: original.bootId,
			configurationSha256: hash(oldConfiguration),
			serviceInvocationId: "3".repeat(32),
		},
	};
	const stopRequest = parseCompanyComputerServiceStopRequest({
		schema: "qorpera.office-service-stop-request/v1",
		revocation: {
			schema: "qorpera.office-lifecycle-transition/v1",
			request: predecessor,
			state: "draining",
			revocationRevision: 3,
			requestedAtMs: 1000,
			drains: [],
		},
		startCompletionSha256: "4".repeat(64),
	});
	const stopCommand = { commandId: id(11), requestSha256: hash(encode(stopRequest)), bootId: original.bootId };
	const stopCompletion = parseCompanyComputerServiceStopCompletion(
		{
			schema: "qorpera.office-service-stop-completion/v1",
			command: stopCommand,
			transitionId: predecessor.transitionId,
			activationId: predecessor.activationId,
			revocationRevision: 3,
			configurationSha256: predecessor.startup.configurationSha256,
			startCompletionSha256: stopRequest.startCompletionSha256,
			fromServiceInvocationId: predecessor.startup.serviceInvocationId,
			observedInvocationId: predecessor.startup.serviceInvocationId,
			stoppedInvocationId: null,
			controlGroup: "/system.slice/qorpera-company-computer.service",
			cgroupState: "absent",
		},
		stopCommand,
		stopRequest,
	);
	const incoming = "/run/qorpera-office-preparation",
		stopCompletionPath = `${incoming}/service-stop-completion.json`;
	const originFiles = new Map([
		["/etc/qorpera-office/preparation.json", { bytes: encode(original), mode: 0o444 }],
		["/etc/qorpera-office/adoption.json", { bytes: encode(originReceipt), mode: 0o444 }],
		["/etc/qorpera-office/credentials/config.json", { bytes: Buffer.from(oldConfiguration), mode: 0o400 }],
	]);
	const sources = new Map([
		...[...originFiles].filter(([path]) => !path.endsWith("/preparation.json")),
		[
			`${incoming}/service-stop-incoming-${stopCommand.requestSha256}.json`,
			{ bytes: encode(stopRequest), mode: 0o400 },
		],
		[stopCompletionPath, { bytes: encode(stopCompletion), mode: 0o600 }],
	] as const);
	const manifest = parseCompanyComputerStopHistoryManifest(
		{
			schema: "qorpera.office-stop-history/v1",
			command: stopCommand,
			activationId: predecessor.activationId,
			completionPath: stopCompletionPath,
			entries: [...sources]
				.map(([path, f]) => ({ path, bytes: f.bytes.length, sha256: hash(f.bytes), mode: f.mode }))
				.sort((a, b) => (a.path < b.path ? -1 : 1)),
		},
		original.bootId,
		predecessor.activationId,
	);
	const historyDirectory = companyComputerStopHistoryDirectory(original.bootId, predecessor.activationId);
	const archiveFiles = new Map([
		[`${historyDirectory}/manifest.json`, encode(manifest)],
		[`${historyDirectory}/claim.json`, encode(manifest)],
		...[...sources.values()].map((f): [string, Buffer] => [
			`${historyDirectory}/${hash(f.bytes)}.json`,
			Buffer.from(f.bytes),
		]),
	]);
	const powerOffCompletion = encode({
		schema: "qorpera.lxd-office-power-off-completion/v1",
		intentId: id(12),
		allocationId: original.allocationId,
		transitionId: predecessor.transitionId,
		commandId: id(13),
		requestSha256: "5".repeat(64),
		operationId: id(14),
		instanceSha256: original.instanceSha256,
		hostBootId: id(15),
	}).toString("utf8");
	const intent = parseCompanyComputerBootIntentRequest({
		schema: "qorpera.office-boot-intent-request/v1",
		bootIntentId: id(16),
		activationId: id(17),
		predecessor,
		stopHistorySha256: hash(encode(manifest)),
		powerOffCompletionSha256: hash(powerOffCompletion),
	});
	const bootIntent = parseCompanyComputerBootIntent(
		{
			schema: "qorpera.office-boot-intent/v1",
			request: intent,
			state: "prepared",
			stopAcknowledgedAtMs: 1100,
			officeRevision: 4,
			privacyVersion: 2,
			validForMs: 5000,
		},
		intent,
	);
	const observation = {
		schema: "qorpera.lxd-office-resume-observation/v1",
		intentId: id(12),
		allocationId: original.allocationId,
		bootIntentId: intent.bootIntentId,
		activationId: intent.activationId,
		startCommandId: id(18),
		requestSha256: "6".repeat(64),
		powerOffCompletionSha256: intent.powerOffCompletionSha256,
		stopHistorySha256: intent.stopHistorySha256,
		hostBootId: id(15),
		bootId: options.bootId ?? id(19),
		instanceSha256: original.instanceSha256,
		operationId: id(20),
	} as const;
	const originPreparationSha256 = hash(encode(original)),
		bootObservationSha256 = hash(companyComputerResumeObservationCanonical(observation, intent));
	const receipt = companyComputerBootAdoptionReceipt(
		original,
		originPreparationSha256,
		hash(encode(originReceipt)),
		intent,
		observation,
		bootObservationSha256,
	);
	configuration.linux.attestation = {
		...configuration.linux.attestation,
		bootId: observation.bootId,
		adoptionReceiptPath: companyComputerBootAdoptionReceiptPath(observation.bootId),
		adoptionReceiptSha256: hash(encode(receipt)),
	};
	const input = parseCompanyComputerBootConfigurationRequest({
		schema: "qorpera.office-boot-configuration-request/v1",
		originPreparationSha256,
		bootIntent,
		observation,
		powerOffCompletion,
		material: {
			configuration: JSON.stringify(configuration),
			registry: "r".repeat(64),
			native: "n".repeat(43),
			objects: "o".repeat(43),
			tlsCert: options.tlsCert ?? "synthetic certificate",
			tlsKey: options.tlsKey ?? "synthetic key",
		},
	});
	const command = { commandId: id(21), requestSha256: hash(encode(input)), bootId: observation.bootId };
	const completion: CompanyComputerBootConfigurationCompletion = {
		schema: "qorpera.office-boot-configuration-completion/v1",
		command,
		bootIntentId: intent.bootIntentId,
		activationId: intent.activationId,
		originPreparationSha256,
		adoptionReceiptSha256: hash(encode(receipt)),
		bootObservationSha256,
		files: Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
				const bytes = Buffer.from(input.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
				return [file, { bytes: bytes.length, sha256: hash(bytes) }];
			}),
		) as CompanyComputerBootConfigurationCompletion["files"],
	};
	return {
		original,
		originReceipt,
		originFiles,
		archiveFiles,
		historyDirectory,
		input,
		command,
		receipt,
		completion,
		configuration,
	};
}
