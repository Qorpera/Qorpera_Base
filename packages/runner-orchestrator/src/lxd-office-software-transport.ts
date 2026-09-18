import { createHash, randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
	type CompanyComputerServiceSoftwareArtifact,
	type CompanyComputerServiceSoftwareFile,
	type CompanyComputerServiceSoftwareInvocationChallenge,
	type CompanyComputerStartupIdentity,
	companyComputerServiceSoftwareChangedFiles,
	companyComputerServiceSoftwareMeasurementText,
	parseCompanyComputerPreparationCommand,
	parseCompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerServiceStopRequest,
	parseCompanyComputerStartupIdentity,
} from "@qorpera/contracts";
import {
	type LxdOfficeSoftwareClient,
	type LxdOperationReference,
	OFFICE_SOFTWARE_INSTALLED_SERVICE,
	OFFICE_SOFTWARE_JOURNAL_ROOT,
	OFFICE_SOFTWARE_STAGING_ROOT,
} from "./lxd-client.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeInvocationMeasurement } from "./lxd-office-invocation-measurement.ts";
import { publish, readRecord } from "./lxd-office-journal-files.ts";
import {
	verifyLxdOfficeServiceSoftware,
	verifyLxdOfficeServiceSoftwareReceipt,
} from "./lxd-office-service-software.ts";
import type { LxdOfficeSoftwareInstallChallenge } from "./lxd-office-software-control.ts";
import {
	acknowledgeLxdOfficeSoftwareInvocation,
	type LxdOfficeSoftwareInvocationRegistry,
} from "./lxd-office-software-invocation-control.ts";

const MAX_ATTEMPTS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
type Client = Pick<
	LxdOfficeSoftwareClient,
	"pushOfficeSoftwareFile" | "submitOfficeSoftwareControl" | "inspectOfficeSoftwareControl" | "readOfficeSoftwareFile"
>;
type Verification = Parameters<typeof verifyLxdOfficeServiceSoftware>;

/** Finite retained attempts per update/activation. Exhaustion needs explicit
 * reviewed recovery; records are never deleted to reclaim a slot. */
async function assertAttemptBudget(root: string, prefix: string, signal: AbortSignal) {
	const attempts = new Set<string>();
	const directory = await opendir(root);
	let count = 0;
	for await (const entry of directory) {
		signal.throwIfAborted();
		if (++count > 4096) throw new Error("software journal scan limit");
		if (!entry.name.startsWith(prefix)) continue;
		const match =
			/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:-accepted|-evidence)?\.json$/.exec(
				entry.name.slice(prefix.length),
			);
		if (!match || !entry.isFile()) throw new Error("invalid software attempt record");
		attempts.add(match[1]);
		if (attempts.size >= MAX_ATTEMPTS) throw new Error("software attempt budget exhausted");
	}
}
function assertReference(reference: LxdOperationReference, project: string, name: string) {
	if (
		!isDeepStrictEqual(reference, { project, instanceName: name, operationId: reference.operationId }) ||
		typeof reference.operationId !== "string" ||
		!UUID.test(reference.operationId)
	)
		throw new Error("software operation differs");
}
/** One attempt: durable dispatch record, staged packet, exec of a pinned tool,
 * retained acceptance, polling and root read-back, all inside the caller's
 * original deadline. Uncertain outcomes stay retained; nothing is retried. */
async function attempt<T>(
	root: string,
	binding: LxdOfficeGuestBinding,
	client: Client,
	input: {
		prefix: string;
		nonce: string;
		dispatch: Record<string, unknown>;
		packet: { fileName: string; bytes: Buffer };
		tool: "install" | "measure";
		args: readonly string[];
		deadline: number;
		readback: (fresh: () => void) => Promise<T>;
		evidence: (result: T) => Record<string, unknown>;
	},
	signal: AbortSignal,
): Promise<T> {
	const fresh = () => {
		signal.throwIfAborted();
		if (performance.now() >= input.deadline) throw new Error("software attempt expired");
	};
	const { project } = binding,
		name = lxdOfficeGuestPlan(binding).request.name;
	fresh();
	await assertAttemptBudget(root, input.prefix, signal);
	const recordName = `${input.prefix}${input.nonce}.json`;
	fresh();
	if (!(await publish(root, recordName, Buffer.from(officeCanonical(input.dispatch)))))
		throw new Error("software attempt already dispatched");
	const checked = async () => {
		fresh();
		if (!isDeepStrictEqual((await readRecord(join(root, recordName))).value, input.dispatch))
			throw new Error("software dispatch changed");
		fresh();
		return signal;
	};
	await client.pushOfficeSoftwareFile(project, name, input.packet.fileName, input.packet.bytes, await checked());
	const reference = await client.submitOfficeSoftwareControl(project, name, input.tool, input.args, await checked());
	assertReference(reference, project, name);
	// Retain acceptance even if cancellation arrived with the response.
	if (
		!(await publish(
			root,
			`${input.prefix}${input.nonce}-accepted.json`,
			Buffer.from(
				officeCanonical({ schema: "qorpera.lxd-office-software-accepted/v1", nonce: input.nonce, reference }),
			),
		))
	)
		throw new Error("software acceptance changed");
	for (;;) {
		const state = await client.inspectOfficeSoftwareControl(reference, await checked());
		fresh();
		if (state === "succeeded") break;
		if (state !== "pending") throw new Error("software tool failed");
		await delay(50, undefined, { signal });
	}
	await checked();
	const result = await input.readback(fresh);
	fresh();
	if (
		!(await publish(
			root,
			`${input.prefix}${input.nonce}-evidence.json`,
			Buffer.from(
				officeCanonical({
					schema: "qorpera.lxd-office-software-evidence/v1",
					nonce: input.nonce,
					evidence: input.evidence(result),
				}),
			),
		))
	)
		throw new Error("software evidence changed");
	fresh();
	return result;
}

export interface LxdOfficeSoftwareToolPins {
	install: string;
	measure: string;
}
/** Stage both pinned tools. Their digests are pinned by the operator; a
 * mismatching bundle is refused before any upload. */
export async function stageLxdOfficeSoftwareTools(
	client: Pick<Client, "pushOfficeSoftwareFile">,
	binding: LxdOfficeGuestBinding,
	tools: { install: Buffer; measure: Buffer },
	pins: LxdOfficeSoftwareToolPins,
	signal: AbortSignal,
): Promise<Readonly<LxdOfficeSoftwareToolPins>> {
	const { project } = binding,
		name = lxdOfficeGuestPlan(binding).request.name;
	const result = { install: officeSha(pins.install), measure: officeSha(pins.measure) };
	for (const tool of ["install", "measure"] as const) {
		if (!Buffer.isBuffer(tools[tool]) || hash(tools[tool]) !== result[tool])
			throw new Error("OFFICE_SOFTWARE_TOOL_PIN_DIFFERS");
		signal.throwIfAborted();
		await client.pushOfficeSoftwareFile(
			project,
			name,
			tool === "install" ? "software-control.mjs" : "software-measurement-control.mjs",
			tools[tool],
			signal,
		);
	}
	return Object.freeze(result);
}

export interface LxdOfficeSoftwareInstallStaging {
	envelope: Verification[0];
	plan: Verification[1];
	trust: Verification[2];
	manifests: Verification[3];
	serviceBytes: Buffer;
	/** Exact bytes of every changed guest code entry of a guest-code revision. */
	files?: Readonly<Record<string, Buffer>>;
	/** Exactly 64 lowercase hex characters; root/provider custody only. */
	providerCapability: string;
}
/** Stage the signed inputs, target bytes and the capability for one update.
 * The packet itself is staged per attempt because it binds a challenge. */
export async function stageLxdOfficeSoftwareInstall(
	client: Pick<Client, "pushOfficeSoftwareFile">,
	binding: LxdOfficeGuestBinding,
	staging: LxdOfficeSoftwareInstallStaging,
	signal: AbortSignal,
): Promise<Readonly<{ trustSha256: string; planSha256: string }>> {
	const verified = verifyLxdOfficeServiceSoftware(staging.envelope, staging.plan, staging.trust, staging.manifests);
	const { project } = binding,
		name = lxdOfficeGuestPlan(binding).request.name;
	if (verified.plan.predecessor.startup.allocationId !== binding.allocationId)
		throw new Error("OFFICE_SOFTWARE_ALLOCATION_DIFFERS");
	const next = verified.statement.next.service;
	if (
		!Buffer.isBuffer(staging.serviceBytes) ||
		staging.serviceBytes.length !== next.bytes ||
		hash(staging.serviceBytes) !== next.sha256 ||
		typeof staging.providerCapability !== "string" ||
		!/^[0-9a-f]{64}$/.test(staging.providerCapability)
	)
		throw new Error("OFFICE_SOFTWARE_STAGING_DIFFERS");
	const trustBytes = Buffer.from(
		officeCanonical({
			verificationKeySpki: staging.trust.verificationKeySpki,
			statementSha256: officeSha(staging.trust.statementSha256),
			planSha256: officeSha(staging.trust.planSha256),
		}),
	);
	const trustSha256 = hash(trustBytes);
	const files: Array<[string, Buffer]> = [
		[`software-trust-${trustSha256}.json`, trustBytes],
		[`software-previous-manifest-${verified.planSha256}.json`, Buffer.from(staging.manifests.previous)],
		[`software-next-manifest-${verified.planSha256}.json`, Buffer.from(staging.manifests.next)],
		[`software-service-${next.sha256}.mjs`, Buffer.from(staging.serviceBytes)],
	];
	// A guest-code revision also stages every changed entry under its digest.
	const changed = companyComputerServiceSoftwareChangedFiles(verified.statement);
	const provided = staging.files ?? {};
	if (Object.keys(provided).some((file) => !changed.some((entry) => entry.file === file)))
		throw new Error("OFFICE_SOFTWARE_STAGING_DIFFERS");
	for (const entry of changed) {
		const bytes = provided[entry.file];
		if (!Buffer.isBuffer(bytes) || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256)
			throw new Error("OFFICE_SOFTWARE_STAGING_DIFFERS");
		files.push([`software-file-${entry.sha256}`, Buffer.from(bytes)]);
	}
	for (const [fileName, bytes] of files) {
		signal.throwIfAborted();
		await client.pushOfficeSoftwareFile(project, name, fileName, bytes, signal);
	}
	const capability = Buffer.from(staging.providerCapability, "ascii");
	try {
		signal.throwIfAborted();
		await client.pushOfficeSoftwareFile(
			project,
			name,
			`software-capability-${verified.plan.updateId}`,
			capability,
			signal,
		);
	} finally {
		capability.fill(0);
	}
	return Object.freeze({ trustSha256, planSha256: verified.planSha256 });
}

export interface LxdOfficeSoftwareInstallTransport {
	envelope: Verification[0];
	plan: Verification[1];
	trust: Verification[2];
	manifests: Verification[3];
	/** Typed service-stop request, its retained command and SQL acknowledgement,
	 * exactly as retained by the stop worker; the guest tool rechecks them. */
	stop: unknown;
	stopCommand: unknown;
	acknowledgement: unknown;
	toolSha256: string;
	trustSha256: string;
}
/** Physical callback for LxdOfficeSoftwareControl.install: stage the challenge
 * packet, run the pinned install tool under the guest flock, read back the root
 * receipt and independently measure installed bytes through the LXD file API. */
export function createLxdOfficeSoftwareInstallPhysical(
	root: string,
	bindingValue: LxdOfficeGuestBinding,
	client: Client,
	transport: LxdOfficeSoftwareInstallTransport,
) {
	const binding = lxdOfficeGuestPlan(bindingValue).binding;
	const verified = verifyLxdOfficeServiceSoftware(
		transport.envelope,
		transport.plan,
		transport.trust,
		transport.manifests,
	);
	const { plan, statement } = verified;
	const stop = parseCompanyComputerServiceStopRequest(transport.stop),
		stopCommand = parseCompanyComputerPreparationCommand(transport.stopCommand);
	const acknowledgement = parseCompanyComputerServiceStopAcknowledgement(transport.acknowledgement, stop, stopCommand);
	if (
		!isDeepStrictEqual(stop.revocation.request, plan.predecessor) ||
		officeDigest(acknowledgement) !== plan.stopAcknowledgementSha256 ||
		plan.predecessor.startup.allocationId !== binding.allocationId
	)
		throw new Error("OFFICE_SOFTWARE_STOP_DIFFERS");
	const toolSha256 = officeSha(transport.toolSha256),
		trustSha256 = officeSha(transport.trustSha256);
	const reserved = new Set([
		plan.updateId,
		plan.predecessor.transitionId,
		plan.predecessor.activationId,
		plan.successorActivationId,
		stopCommand.commandId,
	]);
	return async (
		challenge: Readonly<LxdOfficeSoftwareInstallChallenge>,
		deadline: number,
		signal: AbortSignal,
	): Promise<{ receipt: unknown; measuredService: unknown; measuredFiles?: unknown; evidenceSha256: string }> => {
		if (
			challenge.planSha256 !== verified.planSha256 ||
			!isDeepStrictEqual(challenge.plan, plan) ||
			!isDeepStrictEqual(challenge.statement, statement) ||
			!UUID.test(challenge.challengeId) ||
			reserved.has(challenge.challengeId)
		)
			throw new Error("OFFICE_SOFTWARE_CHALLENGE_DIFFERS");
		let commandId = randomUUID();
		while (reserved.has(commandId) || commandId === challenge.challengeId) commandId = randomUUID();
		const packet = {
			schema: "qorpera.office-software-control/v1",
			envelope: transport.envelope,
			plan,
			stop,
			stopCommand,
			acknowledgement,
			challengeId: challenge.challengeId,
			targetRevision: challenge.targetRevision,
			capabilityRevision: challenge.capabilityRevision,
		};
		const bytes = Buffer.from(officeCanonical(packet));
		const command = parseCompanyComputerPreparationCommand({
			commandId,
			requestSha256: hash(bytes),
			bootId: plan.predecessor.startup.bootId,
		});
		const expected = statement.next.service;
		return attempt(
			root,
			binding,
			client,
			{
				prefix: `software-install-${binding.allocationId}-${plan.updateId}-`,
				nonce: challenge.challengeId,
				dispatch: {
					schema: "qorpera.lxd-office-software-install-dispatch/v1",
					binding,
					updateId: plan.updateId,
					challengeId: challenge.challengeId,
					command,
					toolSha256,
					trustSha256,
					targetRevision: challenge.targetRevision,
					capabilityRevision: challenge.capabilityRevision,
				},
				packet: { fileName: `software-incoming-${command.requestSha256}.json`, bytes },
				tool: "install",
				args: [command.commandId, command.requestSha256, command.bootId, toolSha256, trustSha256],
				deadline,
				async readback(fresh) {
					const { project } = binding,
						name = lxdOfficeGuestPlan(binding).request.name;
					const receiptFile = await client.readOfficeSoftwareFile(
						project,
						name,
						`${OFFICE_SOFTWARE_JOURNAL_ROOT}/${plan.updateId}/installed.json`,
						65536,
						signal,
					);
					fresh();
					if (receiptFile.uid !== 0 || receiptFile.gid !== 0 || receiptFile.mode !== 0o400)
						throw new Error("software receipt custody");
					const receipt = verifyLxdOfficeServiceSoftwareReceipt(
						decode(receiptFile.content),
						transport.envelope,
						plan,
						transport.trust,
						transport.manifests,
					);
					// Independent host-side byte measurement of the installed target.
					const installed = await client.readOfficeSoftwareFile(
						project,
						name,
						OFFICE_SOFTWARE_INSTALLED_SERVICE,
						expected.bytes,
						signal,
					);
					fresh();
					if (
						installed.uid !== 0 ||
						installed.gid !== 0 ||
						installed.mode !== 0o444 ||
						installed.content.length !== expected.bytes ||
						hash(installed.content) !== expected.sha256
					)
						throw new Error("software installed bytes differ");
					const measuredService: CompanyComputerServiceSoftwareArtifact = {
						path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
						bytes: installed.content.length,
						sha256: expected.sha256,
					};
					// Every guest code entry of a guest-code revision is measured host-side too.
					const measuredFiles: CompanyComputerServiceSoftwareFile[] = [];
					for (const entry of statement.next.files ?? []) {
						const file = await client.readOfficeSoftwareFile(project, name, entry.path, entry.bytes, signal);
						fresh();
						if (
							file.uid !== 0 ||
							file.gid !== 0 ||
							file.mode !== entry.mode ||
							file.content.length !== entry.bytes ||
							hash(file.content) !== entry.sha256
						)
							throw new Error("software installed guest code differs");
						measuredFiles.push({ ...entry });
					}
					const evidence = {
						schema: "qorpera.lxd-office-software-install-evidence/v1",
						updateId: plan.updateId,
						challengeId: challenge.challengeId,
						command,
						toolSha256,
						trustSha256,
						targetRevision: challenge.targetRevision,
						capabilityRevision: challenge.capabilityRevision,
						receipt,
						measuredService,
						...(statement.next.files ? { measuredFiles } : {}),
						installedFile: { uid: installed.uid, gid: installed.gid, mode: installed.mode },
					};
					return { receipt, measuredService, measuredFiles, evidenceSha256: officeDigest(evidence), evidence };
				},
				evidence: (result) => result.evidence,
			},
			signal,
		);
	};
}

/** Physical callback for acknowledgeLxdOfficeSoftwareInvocation: stage the
 * exact canonical challenge, run the pinned read-only measurement tool and read
 * back its closed receipt. Evidence verification stays in the control. */
export function createLxdOfficeSoftwareMeasurementPhysical(
	root: string,
	bindingValue: LxdOfficeGuestBinding,
	client: Client,
	toolSha256Value: string,
	tool?: Buffer,
) {
	const binding = lxdOfficeGuestPlan(bindingValue).binding,
		toolSha256 = officeSha(toolSha256Value);
	if (tool !== undefined && (!Buffer.isBuffer(tool) || hash(tool) !== toolSha256))
		throw new Error("OFFICE_SOFTWARE_TOOL_PIN_DIFFERS");
	return async (
		challenge: Readonly<CompanyComputerServiceSoftwareInvocationChallenge>,
		deadline: number,
		signal: AbortSignal,
	): Promise<{ evidence: unknown; evidenceSha256: string }> => {
		if (challenge.startup.allocationId !== binding.allocationId)
			throw new Error("OFFICE_SOFTWARE_ALLOCATION_DIFFERS");
		// The guest staging root is a tmpfs: a boot activation measures on a
		// fresh boot where nothing the update lane staged survives.
		if (tool !== undefined) {
			signal.throwIfAborted();
			await client.pushOfficeSoftwareFile(
				binding.project,
				lxdOfficeGuestPlan(binding).request.name,
				"software-measurement-control.mjs",
				tool,
				signal,
			);
		}
		const text = companyComputerServiceSoftwareMeasurementText(challenge),
			bytes = Buffer.from(text);
		let commandId = randomUUID();
		while (commandId === challenge.challengeId || commandId === challenge.activationId) commandId = randomUUID();
		const command = parseCompanyComputerPreparationCommand({
			commandId,
			requestSha256: hash(bytes),
			bootId: challenge.startup.bootId,
		});
		return attempt(
			root,
			binding,
			client,
			{
				prefix: `software-measurement-${binding.allocationId}-${challenge.activationId}-`,
				nonce: challenge.challengeId,
				dispatch: {
					schema: "qorpera.lxd-office-software-measurement-dispatch/v1",
					binding,
					activationId: challenge.activationId,
					challengeId: challenge.challengeId,
					command,
					toolSha256,
					revision: challenge.revision,
					capabilityRevision: challenge.capabilityRevision,
				},
				packet: { fileName: `software-measurement-incoming-${command.requestSha256}.json`, bytes },
				tool: "measure",
				args: [command.commandId, command.requestSha256, command.bootId, toolSha256],
				deadline,
				async readback(fresh) {
					const file = await client.readOfficeSoftwareFile(
						binding.project,
						lxdOfficeGuestPlan(binding).request.name,
						`${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-${challenge.challengeId}.json`,
						16384,
						signal,
					);
					fresh();
					if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400)
						throw new Error("software measurement custody");
					const value = officeRecord(decode(file.content), [
						"schema",
						"challengeId",
						"evidence",
						"evidenceSha256",
					]);
					if (
						value.schema !== "qorpera.office-software-measurement-receipt/v1" ||
						value.challengeId !== challenge.challengeId
					)
						throw new Error("software measurement receipt differs");
					return { evidence: value.evidence, evidenceSha256: officeSha(value.evidenceSha256) };
				},
				evidence: (result) => ({
					challengeId: challenge.challengeId,
					command,
					evidenceSha256: result.evidenceSha256,
				}),
			},
			signal,
		);
	};
}

export interface LxdOfficeInvocationMeasurementOptions {
	root: string;
	client: Client;
	registry: LxdOfficeSoftwareInvocationRegistry;
	/** Builds the enrolled guest binding for the measured allocation. */
	binding: (allocationId: string) => LxdOfficeGuestBinding;
	/** Separate operator-enrolled provider capability; never journaled. */
	providerCapability: string;
	expectedRevision: number;
	expectedService: CompanyComputerServiceSoftwareArtifact;
	measurementToolSha256: string;
	/** Exact pinned measurement tool bytes; staged again before every measurement. */
	measurementTool?: Buffer;
}
/** Concrete LxdOfficeInvocationMeasurement for successor and boot activation
 * workers: fresh capability-bound SQL challenge, protected guest measurement,
 * acknowledgement, all inside the worker's original inspection deadline. */
export function createLxdOfficeInvocationMeasurement(
	options: LxdOfficeInvocationMeasurementOptions,
): LxdOfficeInvocationMeasurement {
	if (typeof options.providerCapability !== "string" || !/^[0-9a-f]{64}$/.test(options.providerCapability))
		throw new Error("OFFICE_SOFTWARE_AUTHORITY_INVALID");
	const measurementToolSha256 = officeSha(options.measurementToolSha256);
	const expectedService: CompanyComputerServiceSoftwareArtifact = {
		path: COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH,
		bytes: options.expectedService.bytes,
		sha256: officeSha(options.expectedService.sha256),
	};
	return async (activationId: string, startupValue: Readonly<CompanyComputerStartupIdentity>, deadline, signal) => {
		const startup = parseCompanyComputerStartupIdentity(startupValue);
		const binding = lxdOfficeGuestPlan(options.binding(startup.allocationId)).binding;
		if (binding.allocationId !== startup.allocationId) throw new Error("OFFICE_SOFTWARE_ALLOCATION_DIFFERS");
		const physical = createLxdOfficeSoftwareMeasurementPhysical(
			options.root,
			binding,
			options.client,
			measurementToolSha256,
			options.measurementTool,
		);
		await acknowledgeLxdOfficeSoftwareInvocation(
			{
				activationId,
				startup,
				expectedRevision: options.expectedRevision,
				expectedService,
				providerCapability: options.providerCapability,
				inspectionDeadline: deadline,
			},
			options.registry,
			physical,
			signal,
		);
	};
}
