import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { type LxdOfficeSoftwareClient, LxdUnixClient } from "./lxd-client.ts";
import { assertOfficeAdoptionKernelLock } from "./lxd-office-adoption-files.ts";
import type { LxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { readRecord } from "./lxd-office-journal-files.ts";
import { LxdOfficePhysicalGate } from "./lxd-office-physical-gate.ts";
import { readLxdOfficeCredentialFile, readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";
import { lxdOfficePhysicalPolicySha256, officePhysicalPath } from "./lxd-office-physical-policy.ts";
import { LxdOfficeProviderHttpRegistry } from "./lxd-office-provider-registry.ts";
import { verifyLxdOfficeServiceSoftware } from "./lxd-office-service-software.ts";
import { LxdOfficeSoftwareControl, type LxdOfficeSoftwareRegistry } from "./lxd-office-software-control.ts";
import { loadLxdOfficeSoftwareLane } from "./lxd-office-software-lane.ts";
import {
	createLxdOfficeSoftwareInstallPhysical,
	stageLxdOfficeSoftwareInstall,
	stageLxdOfficeSoftwareTools,
} from "./lxd-office-software-transport.ts";

export const OFFICE_SOFTWARE_UPDATE_STEPS = ["enroll", "begin", "stage", "install", "status"] as const;
export type LxdOfficeSoftwareUpdateStep = (typeof OFFICE_SOFTWARE_UPDATE_STEPS)[number];
type Client = Pick<
	LxdOfficeSoftwareClient,
	"pushOfficeSoftwareFile" | "submitOfficeSoftwareControl" | "inspectOfficeSoftwareControl" | "readOfficeSoftwareFile"
>;
export interface LxdOfficeSoftwareUpdatePorts {
	readProtected?: typeof readLxdOfficeProtectedFile;
	readCredential?: typeof readLxdOfficeCredentialFile;
	readArtifact?: typeof readLxdOfficeSoftwareArtifact;
	kernelLock?: typeof assertOfficeAdoptionKernelLock;
	openGate?: (
		policyPath: string,
		provenancePath: string,
		signal: AbortSignal,
	) => Promise<Pick<LxdOfficePhysicalGate, "policy" | "check">>;
	registry?: (registryUrl: string, credential: string) => LxdOfficeSoftwareRegistry;
	client?: (socketPath: string) => Client;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const credentialRecord = (value: unknown, minimum: number, maximum: number) => {
	const r = officeRecord(value, ["path", "bytes", "sha256"]);
	if (!Number.isSafeInteger(r.bytes) || (r.bytes as number) < minimum || (r.bytes as number) > maximum)
		throw new Error("credential");
	return { path: officePhysicalPath(r.path), bytes: r.bytes as number, sha256: officeSha(r.sha256) };
};

/** One protected root-owned document names every input of one governed
 * service-only revision. The retained stop request/command/acknowledgement
 * are the stop worker's own journal records under the same journal root;
 * their names derive from the signed plan's predecessor. No secret is stored
 * here: both credentials are separate protected files. */
export function parseLxdOfficeSoftwareUpdateConfig(value: unknown) {
	try {
		const r = officeRecord(value, [
			"schema",
			"policyPath",
			"provenancePath",
			"registryUrl",
			"registryCredential",
			"capabilityCredential",
			"expectedRevision",
			"tools",
			"toolPackageDir",
			"envelopePath",
			"planPath",
			"trustPath",
			"previousManifestPath",
			"nextManifestPath",
			"servicePath",
			"journalRoot",
		]);
		const tools = officeRecord(r.tools, ["install", "measure"]);
		if (
			r.schema !== "qorpera.lxd-office-software-update/v1" ||
			typeof r.registryUrl !== "string" ||
			!Number.isSafeInteger(r.expectedRevision) ||
			(r.expectedRevision as number) < 0 ||
			(r.expectedRevision as number) > 9007199254740989
		)
			throw new Error("config");
		// Validate the endpoint without loading a credential or sending a request.
		new LxdOfficeProviderHttpRegistry(r.registryUrl, "validation-only-".repeat(3));
		const capability = credentialRecord(r.capabilityCredential, 64, 64);
		return Object.freeze({
			policyPath: officePhysicalPath(r.policyPath),
			provenancePath: officePhysicalPath(r.provenancePath),
			registryUrl: r.registryUrl,
			registryCredential: credentialRecord(r.registryCredential, 32, 4096),
			capabilityCredential: Object.freeze({ ...capability, bytes: 64 as const }),
			expectedRevision: r.expectedRevision as number,
			tools: Object.freeze({ install: officeSha(tools.install), measure: officeSha(tools.measure) }),
			toolPackageDir: officePhysicalPath(r.toolPackageDir),
			envelopePath: officePhysicalPath(r.envelopePath),
			planPath: officePhysicalPath(r.planPath),
			trustPath: officePhysicalPath(r.trustPath),
			previousManifestPath: officePhysicalPath(r.previousManifestPath),
			nextManifestPath: officePhysicalPath(r.nextManifestPath),
			servicePath: officePhysicalPath(r.servicePath),
			journalRoot: officePhysicalPath(r.journalRoot),
		});
	} catch {
		throw new Error("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID");
	}
}

/** Larger root-owned inputs (service bytes, tools, manifests) exceed the
 * protected metadata reader's bound. Custody is checked the same way; every
 * byte read here is additionally pinned by a digest from the signed
 * statement, the operator tool pins or the tool package manifest. */
export async function readLxdOfficeSoftwareArtifact(path: string, limit: number): Promise<Buffer> {
	officePhysicalPath(path);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 ** 2)
		throw new Error("INVALID_OFFICE_FILE_LIMIT");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.uid !== 0 ||
			(before.mode & 0o6022) !== 0 ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > limit ||
			(await realpath(path)) !== path
		)
			throw new Error("OFFICE_HOST_FILE_UNPROTECTED");
		const bytes = Buffer.alloc(before.size + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = await file.read(bytes, size, bytes.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		const after = await file.stat();
		if (
			size !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			after.ino !== before.ino
		)
			throw new Error("OFFICE_HOST_FILE_CHANGED");
		return bytes.subarray(0, size);
	} finally {
		await file.close();
	}
}

function parseToolPackage(value: unknown, pins: { install: string; measure: string }) {
	const r = officeRecord(value, [
		"schema",
		"platform",
		"minimumNode",
		"artifacts",
		"purpose",
		"historicalOfficeImageUnchanged",
	]);
	if (
		r.schema !== "qorpera.office-software-control-package/v2" ||
		r.platform !== "linux" ||
		r.purpose !== "temporary-provider-root-control" ||
		r.historicalOfficeImageUnchanged !== true ||
		!Array.isArray(r.artifacts) ||
		r.artifacts.length !== 2
	)
		throw new Error("tool package");
	const files: Record<"install" | "measure", { file: string; bytes: number; sha256: string }> = {
		install: { file: "", bytes: 0, sha256: "" },
		measure: { file: "", bytes: 0, sha256: "" },
	};
	for (const entry of r.artifacts) {
		const a = officeRecord(entry, ["purpose", "file", "path", "bytes", "sha256", "mode"]);
		const purpose = a.purpose === "install" || a.purpose === "measure" ? a.purpose : undefined;
		if (
			!purpose ||
			files[purpose].file ||
			a.file !== (purpose === "install" ? "software-control.mjs" : "software-measurement-control.mjs") ||
			a.path !== `/run/qorpera-office-preparation/${a.file}` ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 1 ||
			(a.bytes as number) > 16 * 1024 ** 2 ||
			officeSha(a.sha256) !== pins[purpose]
		)
			throw new Error("tool package differs from operator pins");
		files[purpose] = { file: a.file as string, bytes: a.bytes as number, sha256: a.sha256 as string };
	}
	if (!files.install.file || !files.measure.file) throw new Error("tool package incomplete");
	return files;
}

export interface LxdOfficeSoftwareUpdateResult {
	schema: "qorpera.lxd-office-software-update-result/v1";
	step: LxdOfficeSoftwareUpdateStep;
	updateId: string;
	allocationId: string;
	expectedRevision: number;
	targetRevision: number;
	result: unknown;
}
/** One step of one update attempt, under the lifecycle's own process-owned
 * kernel lock (the ordinary provider service must therefore be stopped and
 * this process started under the same flock). Never loops, never retries an
 * uncertain physical call; an unconfirmed step is retained by the transport's
 * journal records and needs the operator's explicit next invocation. Every
 * result is closed metadata without either credential. */
export async function runLxdOfficeSoftwareUpdate(
	configPath: string,
	step: LxdOfficeSoftwareUpdateStep,
	evidenceSha256: string | undefined,
	signal: AbortSignal,
	ports: LxdOfficeSoftwareUpdatePorts = {},
): Promise<LxdOfficeSoftwareUpdateResult> {
	const readProtected = ports.readProtected ?? readLxdOfficeProtectedFile,
		readCredential = ports.readCredential ?? readLxdOfficeCredentialFile,
		readArtifact = ports.readArtifact ?? readLxdOfficeSoftwareArtifact,
		kernelLock = ports.kernelLock ?? assertOfficeAdoptionKernelLock,
		openGate =
			ports.openGate ?? ((policy, provenance, checked) => LxdOfficePhysicalGate.open(policy, provenance, checked)),
		createRegistry = ports.registry ?? ((url, key) => new LxdOfficeProviderHttpRegistry(url, key)),
		createClient = ports.client ?? ((socketPath) => new LxdUnixClient(socketPath));
	const fail = (code: string): never => {
		throw new Error(code);
	};
	if (!OFFICE_SOFTWARE_UPDATE_STEPS.includes(step) || (step === "enroll") !== (evidenceSha256 !== undefined))
		fail("OFFICE_SOFTWARE_UPDATE_ARGUMENTS_INVALID");
	signal.throwIfAborted();
	const config = parseLxdOfficeSoftwareUpdateConfig(
		await readProtected(officePhysicalPath(configPath), 16384)
			.then(decode)
			.catch(() => fail("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID")),
	);
	const evidence = evidenceSha256 === undefined ? undefined : officeSha(evidenceSha256);
	const gate = await openGate(config.policyPath, config.provenancePath, signal).catch(() =>
		fail("OFFICE_SOFTWARE_UPDATE_POLICY_UNCONFIRMED"),
	);
	const policy = gate.policy;
	if (policy.journal.path !== config.journalRoot) fail("OFFICE_SOFTWARE_UPDATE_CONFIG_INVALID");
	await kernelLock(config.journalRoot).catch(() => fail("OFFICE_SOFTWARE_UPDATE_LOCK_REQUIRED"));
	signal.throwIfAborted();
	// Signed inputs, exact bytes and the retained stop records are all verified
	// before any credential is loaded or any network/LXD call is made.
	const inputs = await loadInputs(config, policy, readProtected, readArtifact).catch(() =>
		fail("OFFICE_SOFTWARE_UPDATE_INPUTS_UNCONFIRMED"),
	);
	const { verified, binding } = inputs;
	signal.throwIfAborted();
	const { control, capability, installToolSha256 } = await openControl(
		config,
		inputs,
		readCredential,
		createRegistry,
	).catch(() => fail("OFFICE_SOFTWARE_UPDATE_CREDENTIAL_UNCONFIRMED"));
	const physical = async () => {
		const checked = await gate.check(binding, signal);
		return { signal: AbortSignal.any([signal, checked.signal]), client: createClient(policy.host.socketPath) };
	};
	let result: unknown;
	try {
		if (step === "enroll") result = await control.enroll(evidence!, signal);
		else if (step === "begin") result = await control.begin(inputs.acknowledgement, signal);
		else if (step === "status") result = await control.status(signal);
		else if (step === "stage") {
			const { signal: checked, client } = await physical();
			const tools = await stageLxdOfficeSoftwareTools(client, binding, inputs.tools, config.tools, checked);
			const staged = await stageLxdOfficeSoftwareInstall(
				client,
				binding,
				{
					envelope: inputs.envelope,
					plan: inputs.plan,
					trust: inputs.trust,
					manifests: inputs.manifests,
					serviceBytes: inputs.serviceBytes,
					providerCapability: capability,
				},
				checked,
			);
			if (staged.trustSha256 !== inputs.trustSha256) throw new Error("trust staging differs");
			result = { tools, ...staged };
		} else {
			const { signal: checked, client } = await physical();
			const install = createLxdOfficeSoftwareInstallPhysical(config.journalRoot, binding, client, {
				envelope: inputs.envelope,
				plan: inputs.plan,
				trust: inputs.trust,
				manifests: inputs.manifests,
				stop: inputs.stop,
				stopCommand: inputs.stopCommand,
				acknowledgement: inputs.acknowledgement,
				toolSha256: installToolSha256,
				trustSha256: inputs.trustSha256,
			});
			result = await control.install(install, checked);
		}
	} catch {
		fail(`OFFICE_SOFTWARE_UPDATE_${step.toUpperCase()}_UNCONFIRMED`);
	}
	return Object.freeze({
		schema: "qorpera.lxd-office-software-update-result/v1",
		step,
		updateId: verified.plan.updateId,
		allocationId: binding.allocationId,
		expectedRevision: config.expectedRevision,
		targetRevision: config.expectedRevision + 1,
		result: structuredClone(result),
	});
}

/** Both credentials are read through the protected credential reader, bound
 * to the configured digests, and never returned in a result or journal. */
async function openControl(
	config: ReturnType<typeof parseLxdOfficeSoftwareUpdateConfig>,
	inputs: Awaited<ReturnType<typeof loadInputs>>,
	readCredential: typeof readLxdOfficeCredentialFile,
	createRegistry: NonNullable<LxdOfficeSoftwareUpdatePorts["registry"]>,
) {
	const credential = await readCredential(config.registryCredential.path, 4096);
	try {
		if (
			credential.byteLength !== config.registryCredential.bytes ||
			hash(credential) !== config.registryCredential.sha256
		)
			throw new Error("credential differs");
		const registry = createRegistry(config.registryUrl, new TextDecoder("utf8", { fatal: true }).decode(credential));
		const lane = await loadLxdOfficeSoftwareLane(
			{
				plan: inputs.verified.plan,
				expectedRevision: config.expectedRevision,
				expectedService: inputs.verified.statement.previous.service,
				tools: config.tools,
				capabilityCredential: config.capabilityCredential,
			},
			readCredential,
		);
		const control = new LxdOfficeSoftwareControl(
			{
				envelope: inputs.envelope,
				plan: inputs.plan,
				trust: inputs.trust,
				manifests: inputs.manifests,
				expectedRevision: config.expectedRevision,
				providerCapability: lane.providerCapability,
			},
			registry,
		);
		return { control, capability: lane.providerCapability, installToolSha256: lane.installToolSha256 };
	} finally {
		credential.fill(0);
	}
}

async function loadInputs(
	config: ReturnType<typeof parseLxdOfficeSoftwareUpdateConfig>,
	policy: LxdOfficePhysicalGate["policy"],
	readProtected: typeof readLxdOfficeProtectedFile,
	readArtifact: typeof readLxdOfficeSoftwareArtifact,
) {
	const envelope = decode(await readProtected(config.envelopePath, 65536)),
		plan = decode(await readProtected(config.planPath, 65536));
	const trustRecord = officeRecord(decode(await readProtected(config.trustPath, 4096)), [
		"verificationKeySpki",
		"statementSha256",
		"planSha256",
	]);
	if (typeof trustRecord.verificationKeySpki !== "string") throw new Error("trust");
	const trust = {
		verificationKeySpki: trustRecord.verificationKeySpki,
		statementSha256: officeSha(trustRecord.statementSha256),
		planSha256: officeSha(trustRecord.planSha256),
	};
	const manifests = {
		previous: await readArtifact(config.previousManifestPath, 1024 ** 2),
		next: await readArtifact(config.nextManifestPath, 1024 ** 2),
	};
	const verified = verifyLxdOfficeServiceSoftware(envelope, plan, trust, manifests);
	const next = verified.statement.next.service;
	const serviceBytes = await readArtifact(config.servicePath, next.bytes);
	if (serviceBytes.length !== next.bytes || hash(serviceBytes) !== next.sha256) throw new Error("service differs");
	const toolPackage = parseToolPackage(
		decode(await readArtifact(join(config.toolPackageDir, "manifest.json"), 65536)),
		config.tools,
	);
	const tools = {
		install: await readArtifact(join(config.toolPackageDir, toolPackage.install.file), toolPackage.install.bytes),
		measure: await readArtifact(join(config.toolPackageDir, toolPackage.measure.file), toolPackage.measure.bytes),
	};
	for (const purpose of ["install", "measure"] as const)
		if (tools[purpose].length !== toolPackage[purpose].bytes || hash(tools[purpose]) !== config.tools[purpose])
			throw new Error("tool differs");
	const { predecessor } = verified.plan;
	const binding: LxdOfficeGuestBinding = {
		schema: "qorpera.lxd-office-guest/v2",
		...policy.guest,
		allocationId: predecessor.startup.allocationId,
		providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
	};
	if (
		predecessor.providerId !== policy.guest.providerId ||
		predecessor.providerPolicySha256 !== binding.providerPolicySha256 ||
		predecessor.startup.scope.companyId !== policy.guest.companyId ||
		predecessor.startup.scope.environmentId !== policy.guest.environmentId ||
		predecessor.startup.scope.companyComputerId !== policy.guest.companyComputerId ||
		predecessor.startup.scope.logicalComputerId !== policy.guest.logicalComputerId ||
		predecessor.startup.computerGeneration !== policy.guest.computerGeneration ||
		predecessor.startup.imageSha256 !== policy.guest.imageFingerprint ||
		predecessor.startup.bootstrapSha256 !== policy.guest.bootstrapSha256
	)
		throw new Error("predecessor differs from policy");
	const suffix = `${predecessor.startup.allocationId}-${predecessor.transitionId}`;
	const stopRecord = officeRecord(
		(await readRecord(join(config.journalRoot, `service-stop-request-${suffix}.json`), 65536)).value,
		["schema", "request", "command"],
	);
	const completion = officeRecord(
		(await readRecord(join(config.journalRoot, `service-stop-completed-${suffix}.json`), 65536)).value,
		["schema", "intentId", "allocationId", "transitionId", "commandId", "receipt"],
	);
	const stop = parseCompanyComputerServiceStopRequest(stopRecord.request),
		stopCommand = parseCompanyComputerPreparationCommand(stopRecord.command);
	const acknowledgement = parseCompanyComputerServiceStopAcknowledgement(completion.receipt, stop, stopCommand);
	if (
		stopRecord.schema !== "qorpera.lxd-office-stop-request/v1" ||
		completion.schema !== "qorpera.lxd-office-stop-completion/v1" ||
		completion.allocationId !== predecessor.startup.allocationId ||
		completion.transitionId !== predecessor.transitionId ||
		completion.commandId !== stopCommand.commandId ||
		!isDeepStrictEqual(stop.revocation.request, predecessor) ||
		officeDigest(acknowledgement) !== verified.plan.stopAcknowledgementSha256
	)
		throw new Error("stop records differ");
	const trustSha256 = hash(Buffer.from(officeCanonical(trust)));
	return {
		envelope,
		plan,
		trust,
		manifests,
		serviceBytes,
		tools,
		verified,
		binding,
		stop,
		stopCommand,
		acknowledgement,
		trustSha256,
	};
}
