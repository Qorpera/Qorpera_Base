import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	type CompanyComputerOutageRecovery,
	type CompanyComputerOutageSuccessor,
	companyComputerBootAdoptionReceiptPath,
	companyComputerBootDirectory,
	companyComputerOutageAdoptionReceipt,
	companyComputerOutageAdoptionReceiptCanonical,
	companyComputerOutageResumeObservationCanonical,
	companyComputerOutageTerminationAcknowledgementCanonical,
	companyComputerPreparationAdoptionReceipt,
	parseCompanyComputerOutageConfigurationRequest,
	parseCompanyComputerOutageServiceStartRequest,
	parseCompanyComputerOutageSuccessorRequest,
	parseCompanyComputerOutageTerminationRequest,
	parseCompanyComputerPreparationRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { PaidComputerGuard, PaidComputerGuardJournal, type PaidComputerPermit } from "../../src/computer-paid-guard.ts";
import { LxdPaidComputerGuardPhysical } from "../../src/computer-paid-guard-lxd.ts";
import type { LxdInstanceRecord, LxdTrackedClient } from "../../src/lxd-client.ts";
import { OFFICE_COMPUTER_OUTAGE_RPC } from "../../src/lxd-office-computer-outage.ts";
import { lxdOfficeGuestPlan } from "../../src/lxd-office-guest.ts";
import { OFFICE_IMAGE_OUTAGE_PACKAGE_FILES } from "../../src/lxd-office-image-installation.ts";
import { publish } from "../../src/lxd-office-journal-files.ts";
import { LxdOfficeOperationJournal } from "../../src/lxd-office-operations.ts";
import { LxdOfficeOutageAdmissionWorker } from "../../src/lxd-office-outage-admission-worker.ts";
import { LxdOfficeOutageConfigurationWorker } from "../../src/lxd-office-outage-configuration-worker.ts";
import { LxdOfficeOutageResumeWorker } from "../../src/lxd-office-outage-resume-worker.ts";
import { LxdOfficeOutageTerminationWorker } from "../../src/lxd-office-outage-termination-worker.ts";
import { LxdOfficePaidComputer } from "../../src/lxd-office-paid-computer.ts";
import { lxdOfficePhysicalPolicySha256 } from "../../src/lxd-office-physical-policy.ts";
import type { LxdOfficeServiceBootstrap } from "../../src/lxd-office-service-bootstrap.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { RuntimeComputerController } from "../../src/runtime-computer-controller.ts";
import { officeImagePackageFixture } from "./office-image-package.ts";
import { acceptOfficeGuardUsage, sampleOfficeGuardUsage } from "./office-paid-usage.ts";
import { officePhysicalFixture } from "./office-physical-policy.ts";

const signal = () => new AbortController().signal;
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export async function officeOutageWorkerFixture(roots: string[]) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-outage-")));
	roots.push(root);
	const { policy, binding } = officePhysicalFixture();
	const manifest = officeImagePackageFixture();
	manifest.artifacts.push(
		...OFFICE_IMAGE_OUTAGE_PACKAGE_FILES.map((file) => ({ file, bytes: 1, sha256: "a".repeat(64) })),
	);
	const imagePackageManifest = Buffer.from(JSON.stringify(manifest));
	policy.image.guestPackageManifestSha256 = createHash("sha256").update(imagePackageManifest).digest("hex");
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	binding.providerPolicySha256 = lxdOfficePhysicalPolicySha256(policy);
	const plan = lxdOfficeGuestPlan(binding),
		permitId = randomUUID(),
		clock = { hostMachineIdSha256: policy.host.machineIdSha256, hostBootId: randomUUID(), uptimeMs: 100000 };
	let guestBootId = randomUUID();
	const files = new Map<string, { content: Buffer; uid: number; gid: number; mode: number }>();
	const config = {
		...plan.request.config,
		"volatile.uuid": randomUUID(),
		"volatile.base_image": binding.imageFingerprint,
	};
	const vm: LxdInstanceRecord = {
		name: plan.request.name,
		type: "virtual-machine",
		profiles: [],
		status: "Stopped",
		statusCode: 102,
		config,
		expandedConfig: { ...config },
		devices: plan.request.devices,
		expandedDevices: plan.request.devices,
	};
	const client = {
		getInstance: vi.fn(async () => structuredClone(vm)),
		getInstanceState: vi.fn(async () => ({ status: vm.status, statusCode: vm.statusCode, network: {} })),
		submitInstanceOperation: vi.fn(
			async (project: string, request: Parameters<LxdTrackedClient["submitInstanceOperation"]>[1]) => {
				if (request.action === "create") return { project, instanceName: vm.name, operationId: randomUUID() };
				if (request.action !== "start" && request.action !== "stop") throw new Error("unexpected physical effect");
				vm.status = request.action === "start" ? "Running" : "Stopped";
				vm.statusCode = request.action === "start" ? 103 : 102;
				if (request.action === "start" && permit?.permitId !== permitId) guestBootId = randomUUID();
				return { project, instanceName: vm.name, operationId: randomUUID() };
			},
		),
		inspectInstanceOperation: vi.fn(async () => "succeeded" as const),
		readInstanceClock: vi.fn(async () => ({ bootId: guestBootId, uptimeMs: 1000 })),
		readInstanceFile: vi.fn(async (_project: string, _name: string, path: string) =>
			files.has(path)
				? { ...files.get(path)!, content: Buffer.from(files.get(path)!.content) }
				: {
						content: Buffer.from(path === "/proc/uptime" ? "1.00 0.00\n" : `${guestBootId}\n`),
						uid: 0,
						gid: 0,
						mode: 0o444,
					},
		),
		submitOfficeOutageTermination: vi.fn(),
		inspectOfficeOutageTermination: vi.fn(),
		pushOfficeOutageTerminationRequest: vi.fn(),
		readOfficeOutageTerminationRequest: vi.fn(),
		submitOfficeOutageConfiguration: vi.fn(),
		inspectOfficeOutageConfiguration: vi.fn(),
		pushOfficeOutageConfigurationRequest: vi.fn(),
		readOfficeOutageConfigurationRequest: vi.fn(),
		submitOfficeOutageServiceStart: vi.fn(),
		inspectOfficeOutageServiceStart: vi.fn(),
		pushOfficeOutageServiceStartRequest: vi.fn(),
		readOfficeOutageServiceStartRequest: vi.fn(),
		submitOfficeOutageServiceInspection: vi.fn(),
	};
	const guardRoot = join(root, "guard");
	await mkdir(guardRoot, { mode: 0o700 });
	const openGuard = () =>
		new PaidComputerGuard(
			new PaidComputerGuardJournal(guardRoot),
			new LxdPaidComputerGuardPhysical(client, async () => ({ ...clock })),
			async () => ({ ...clock }),
			{
				usageCapture: {
					capture: async () => ({
						host: { ...clock },
						guestBootId,
						guestUptimeMs: 1000,
						evidenceSha256: "e".repeat(64),
						observedAt: new Date().toISOString(),
					}),
				},
			},
		);
	let guard = openGuard();
	await guard.initialize();
	let permit: PaidComputerPermit | null = null,
		lastSample: Record<string, unknown> | null = null,
		outage: Record<string, unknown> | undefined,
		loseOutageReply = false,
		orderly = false;
	const permits = new Map<string, PaidComputerPermit>();
	let recovery: CompanyComputerOutageRecovery | undefined,
		ack: Record<string, unknown> | undefined,
		loseAck = false;
	let successor: CompanyComputerOutageSuccessor | undefined,
		loseActivationReply = false;
	const activation = {
		activationId: randomUUID(),
		providerId: binding.providerId,
		providerPolicySha256: binding.providerPolicySha256,
		startup: {
			scope: {
				companyId: binding.companyId,
				environmentId: binding.environmentId,
				companyComputerId: binding.companyComputerId,
				logicalComputerId: binding.logicalComputerId,
			},
			computerGeneration: binding.computerGeneration,
			allocationId: binding.allocationId,
			instanceSha256: plan.instanceSha256,
			imageSha256: binding.imageFingerprint,
			bootstrapSha256: binding.bootstrapSha256,
			bootId: guestBootId,
			configurationSha256: "a".repeat(64),
			serviceInvocationId: "b".repeat(32),
		},
	};
	const registry = {
		call: vi.fn(async () => ({
			schema: "qorpera.office-provider-activation/v1",
			officeState: outage || orderly ? "maintenance" : "active",
			activation: structuredClone(activation),
		})),
	};
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>): Promise<unknown> => {
			const request = args.p_request as Record<string, unknown>;
			if (method === "qorpera_check_runtime_office_outage_configuration") {
				if (!ack || successor) throw new Error("wrong configuration phase");
				expect(request).toEqual({ recovery: recovery!.request, termination: ack });
				return {
					schema: "qorpera.office-outage-configuration-authority/v1",
					recovery,
					termination: ack,
					validForMs: 5000,
				};
			}
			if (method.includes("office_outage_successor")) {
				if (!successor) {
					if (method !== "qorpera_prepare_runtime_office_outage_successor")
						throw new Error("unprepared successor");
					successor = {
						schema: "qorpera.office-outage-successor/v1",
						request: parseCompanyComputerOutageSuccessorRequest(request),
						state: "prepared",
						serviceInvocationId: null,
						readinessFresh: false,
						officeRevision: 4,
						privacyVersion: recovery!.privacyVersion,
					};
				}
				if (method === "qorpera_activate_runtime_office_outage_successor") {
					expect(request.successor).toEqual(successor.request);
					expect(request.serviceInvocationId).toBe(successor.serviceInvocationId);
					if (successor.state !== "ready" && successor.state !== "active") throw new Error("readiness required");
					successor = { ...successor, state: "active" };
					if (loseActivationReply) {
						loseActivationReply = false;
						throw new Error("lost activation reply");
					}
				} else expect(request).toEqual(successor.request);
				return method.includes("check")
					? { schema: "qorpera.office-outage-successor-authority/v1", successor, validForMs: 5000 }
					: successor;
			}
			if (method === "qorpera_prepare_runtime_office_outage_termination") {
				if (ack) throw new Error("base authority consumed");
				return { schema: "qorpera.office-outage-termination-challenge/v1", request, recovery, validForMs: 5000 };
			}
			if (method === "qorpera_ack_runtime_office_outage_termination") {
				if (!ack)
					ack = {
						schema: "qorpera.office-outage-termination-acknowledgement/v1",
						request: structuredClone(request),
						officeRevision: 4,
						acknowledgedAtMs: Date.now(),
					};
				expect(request).toEqual(ack.request);
				if (loseAck) {
					loseAck = false;
					throw new Error("lost committed ACK");
				}
				return ack;
			}
			if (method.includes("office_outage_recovery")) {
				if (method.includes("check") && ack) throw new Error("base authority consumed");
				if (!recovery)
					recovery = {
						schema: "qorpera.office-outage-recovery/v1",
						request: request as unknown as CompanyComputerOutageRecovery["request"],
						predecessor: activation,
						state: "prepared",
						officeRevision: 3,
						privacyState: "shared",
						privacyVersion: 0,
						privacyChallenge: null,
						drains: [],
					};
				expect(request).toEqual(recovery.request);
				return method.includes("check")
					? { schema: "qorpera.office-outage-recovery-authority/v1", recovery, validForMs: 5000 }
					: recovery;
			}
			if (method === OFFICE_COMPUTER_OUTAGE_RPC) {
				expect(JSON.parse(await readFile(requestPath, "utf8"))).toEqual(request);
				if (!outage) {
					expect(request.activation).toEqual(activation);
					expect(permit?.guestBootId).toBe(activation.startup.bootId);
					outage = {
						schema: "qorpera.office-computer-outage/v1",
						request: structuredClone(request),
						state: orderly ? "orderly" : "held",
						officeRevision: 3,
						registeredAtMs: Date.now(),
					};
				}
				expect(request).toEqual(outage.request);
				if (loseOutageReply) {
					loseOutageReply = false;
					throw new Error("lost committed outage reply");
				}
				return structuredClone(outage);
			}
			if (method === "qorpera_describe_runtime_computer_prestart") {
				const described = permits.get(String(request.requestId));
				return {
					state: described?.state ?? "absent",
					permit: described ?? null,
					lastSample: described?.permitId === permit?.permitId ? lastSample : null,
				};
			}
			if (method === "qorpera_describe_runtime_computer_permit")
				return { mode: "paid", permit: permit?.state === "closed" ? null : permit, lastSample };
			if (method === "qorpera_prepare_runtime_computer_permit") {
				expect(request).toMatchObject({ schema: "qorpera.runtime-computer-prepare/v3", usageProducer: "guard-v1" });
				if (permit && permit.state !== "closed") throw new Error("duplicate reservation");
				if (permit) {
					expect(request.requestId).toBe(recovery?.request.startCommandId);
					lastSample = null;
				}
				permit = {
					schema: "qorpera.computer-usage-permit/v2",
					prestart: request.prestart as PaidComputerPermit["prestart"],
					mode: "paid",
					permitId: String(request.requestId),
					allocationId: binding.allocationId,
					instanceSha256: plan.instanceSha256,
					nodeId: randomUUID(),
					epoch: randomUUID(),
					generation: 1,
					reservationId: randomUUID(),
					hostBootId: clock.hostBootId,
					guestBootId: null,
					physicalId: null,
					issuedAt: "2026-09-25T12:00:00.000Z",
					deadline: "2026-09-25T12:05:30.000Z",
					state: "prepared",
					validForMs: 330000,
					windowMs: 300000,
					stopReserveMs: 30000,
					tariffVersion: 1,
					cpuMillis: binding.cpus * 1000,
					memoryBytes: binding.memoryBytes,
				};
				permits.set(permit.permitId, permit);
				return permit;
			}
			if (method === "qorpera_record_computer_guard_samples") {
				if (!permit) throw new Error("permit required");
				const receipt = acceptOfficeGuardUsage(request, permit, lastSample);
				permit = receipt.permit;
				lastSample = receipt.lastSample;
				permits.set(permit.permitId, permit);
				return receipt;
			}
			if (!permit || request.generation !== permit.generation) throw new Error("SQL generation differs");
			const sample = request.sample as Record<string, unknown>;
			if (
				sample.observationId !== lastSample?.observationId &&
				sample.previousObservationId !== (lastSample?.observationId ?? null)
			)
				throw new Error("SQL predecessor differs");
			lastSample = structuredClone(sample);
			if (method === "qorpera_bind_runtime_computer_permit")
				permit = { ...permit, state: "bound", guestBootId, physicalId: config["volatile.uuid"] };
			else if (method === "qorpera_finish_runtime_computer_permit") permit = { ...permit, state: "closed" };
			else if (method !== "qorpera_checkpoint_runtime_computer_permit")
				throw new Error("unexpected accounting effect");
			permits.set(permit.permitId, permit);
			return permit;
		}),
	};
	const createController = () =>
		new RuntimeComputerController({ control, guard, client, clock: async () => ({ ...clock }) });
	let controller = createController(),
		adapter = new LxdOfficePaidComputer(policy, controller, control);
	const requestPath = join(root, `paid-outage-request-${binding.allocationId}-${permitId}.json`),
		receiptPath = join(root, `paid-outage-receipt-${binding.allocationId}-${permitId}.json`);
	await adapter.prepareStart(binding, permitId, { kind: "initial", intentId: randomUUID(), mappings: [] }, signal());
	const intentId = randomUUID(),
		createCommandId = randomUUID();
	const journal = await LxdOfficeOperationJournal.open(
		root,
		intentId,
		binding,
		client,
		false,
		undefined,
		adapter.operations(binding),
	);
	await publish(
		root,
		`intent-${intentId}.json`,
		Buffer.from(JSON.stringify({ schema: "qorpera.lxd-office-creation/v1", intentId, binding, createCommandId })),
	);
	await journal.reconcile(createCommandId, "create", signal());
	await journal.reconcile(permitId, "start", signal());
	await guard.sweep();
	await sampleOfficeGuardUsage(guard);
	await controller.maintain(signal());
	const original = parseCompanyComputerPreparationRequest({
		schema: "qorpera.office-guest-preparation/v1",
		scope: activation.startup.scope,
		computerGeneration: binding.computerGeneration,
		allocationId: binding.allocationId,
		instanceSha256: plan.instanceSha256,
		imageSha256: binding.imageFingerprint,
		bootstrapSha256: binding.bootstrapSha256,
		bootId: guestBootId,
		uid: 1000,
		gid: 1000,
		copy: {
			adoptionId: randomUUID(),
			observationSha256: "1".repeat(64),
			planSha256: "2".repeat(64),
			reviewSha256: "3".repeat(64),
			outputInventorySha256: "4".repeat(64),
		},
		workbenchMount: { filesystem: "virtiofs", source: "workbench", root: "/", mountPoint: "/var/lib/qorpera-office" },
		limits: { memoryBytes: binding.memoryBytes, pids: 100, cpuQuota: 100000, cpuPeriod: 100000 },
		entries: [".", "desktop", "profiles", "screens", "workbench"].map((path) => ({
			path,
			kind: "directory",
			mode: 0o700,
			bytes: 0,
			sha256: null,
		})),
	});
	await publish(root, `preparation-request-${binding.allocationId}.json`, Buffer.from(JSON.stringify(original)));
	await publish(
		root,
		`preparation-observation-${binding.allocationId}.json`,
		Buffer.from(
			JSON.stringify({
				commandId: randomUUID(),
				bootId: original.bootId,
				requestSha256: hash(JSON.stringify(original)),
			}),
		),
	);
	client.pushOfficeOutageTerminationRequest.mockImplementation(async (_p, _n, digest, bytes) => {
		files.set(`/run/qorpera-office-preparation/outage-termination-incoming-${digest}.json`, {
			content: Buffer.from(bytes),
			uid: 0,
			gid: 0,
			mode: 0o400,
		});
	});
	client.readOfficeOutageTerminationRequest.mockImplementation(async (_p, _n, digest) =>
		files.get(`/run/qorpera-office-preparation/outage-termination-incoming-${digest}.json`),
	);
	client.submitOfficeOutageTermination.mockImplementation(async (project, instanceName, command) => {
		const request = parseCompanyComputerOutageTerminationRequest(
				JSON.parse(
					files
						.get(`/run/qorpera-office-preparation/outage-termination-incoming-${command.requestSha256}.json`)!
						.content.toString(),
				),
			),
			observation = request.challenge.request.observation;
		const inspection = {
			schema: "qorpera.office-outage-termination-inspection/v1",
			command,
			inspectionId: request.challenge.request.inspectionId,
			recoveryId: request.challenge.recovery.request.recoveryId,
			startCommandId: observation.startCommandId,
			bootId: observation.bootId,
			hostBootId: observation.hostBootId,
			physicalInstanceId: observation.physicalInstanceId,
			bootObservationSha256: request.challenge.request.bootObservationSha256,
			originPreparationSha256: request.originPreparationSha256,
			originAdoptionReceiptSha256: createHash("sha256")
				.update(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`)
				.digest("hex"),
			predecessorConfigurationSha256: activation.startup.configurationSha256,
			predecessorAdoptionReceiptSha256: "a".repeat(64),
			cgroupState: "empty",
			preparationState: "unstarted",
			serviceState: "unstarted",
		};
		files.set(
			`/run/qorpera-office-preparation/outage-termination-inspection-${request.challenge.request.inspectionId}.json`,
			{ content: Buffer.from(JSON.stringify(inspection)), uid: 0, gid: 0, mode: 0o600 },
		);
		return { project, instanceName, operationId: randomUUID() };
	});
	client.inspectOfficeOutageTermination.mockResolvedValue("succeeded");
	const serviceBootstrapPath = "/protected/bootstrap.json";
	let bootstrap: LxdOfficeServiceBootstrap | undefined, secrets: Record<string, string> | undefined;
	const configureSources = async () => {
		const key = join(root, "key.pem"),
			cert = join(root, "cert.pem");
		const generated = spawnSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				key,
				"-out",
				cert,
				"-days",
				"1",
				"-subj",
				"/CN=office.invalid",
			],
			{ timeout: 10000, stdio: "pipe" },
		);
		if (generated.status !== 0) throw new Error("TLS fixture generation failed");
		secrets = {
			registry: "r".repeat(64),
			native: "n".repeat(43),
			objects: "o".repeat(43),
			tlsCert: await readFile(cert, "utf8"),
			tlsKey: await readFile(key, "utf8"),
		};
		bootstrap = {
			schema: "qorpera.lxd-office-service-bootstrap/v1",
			providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
			registryUrl: "https://registry.invalid",
			captureObjectGatewayUrl: "https://objects.invalid",
			native: { host: "0.0.0.0", port: 9443 },
			viewer: { host: "0.0.0.0", port: 9444, origins: ["https://client.invalid"] },
			credentials: Object.fromEntries(
				Object.entries(secrets).map(([name, value]) => [
					name,
					{ path: `/protected/${name}`, bytes: Buffer.byteLength(value), sha256: hash(value) },
				]),
			) as LxdOfficeServiceBootstrap["credentials"],
		};
		await publish(
			root,
			`configuration-intent-${binding.allocationId}.json`,
			Buffer.from(
				JSON.stringify({ bootId: original.bootId, serviceBootstrapSha256: hash(JSON.stringify(bootstrap)) }),
			),
		);
	};
	const sources = {
		readProtected: async (path: string) => {
			if (path !== serviceBootstrapPath || !bootstrap) throw new Error("unexpected bootstrap");
			return Buffer.from(JSON.stringify(bootstrap));
		},
		readCredential: async (path: string) => {
			const value = secrets?.[path.slice("/protected/".length)];
			if (!value) throw new Error("unexpected credential");
			return Buffer.from(value);
		},
	};
	client.pushOfficeOutageConfigurationRequest.mockImplementation(async (_p, _n, digest, bytes) =>
		files.set(`/run/qorpera-office-preparation/outage-configuration-incoming-${digest}.json`, {
			content: Buffer.from(bytes),
			uid: 0,
			gid: 0,
			mode: 0o400,
		}),
	);
	client.readOfficeOutageConfigurationRequest.mockImplementation(async (_p, _n, digest) => ({
		...files.get(`/run/qorpera-office-preparation/outage-configuration-incoming-${digest}.json`)!,
		content: Buffer.from(
			files.get(`/run/qorpera-office-preparation/outage-configuration-incoming-${digest}.json`)!.content,
		),
	}));
	client.submitOfficeOutageConfiguration.mockImplementation(async (project, instanceName, command) => {
		const body = parseCompanyComputerOutageConfigurationRequest(
			JSON.parse(
				files
					.get(`/run/qorpera-office-preparation/outage-configuration-incoming-${command.requestSha256}.json`)!
					.content.toString(),
			),
		);
		const bootHash = hash(companyComputerOutageResumeObservationCanonical(body.observation, body.recovery)),
			receipt = companyComputerOutageAdoptionReceipt(
				original,
				body.originPreparationSha256,
				hash(`${JSON.stringify(companyComputerPreparationAdoptionReceipt(original))}\n`),
				body.recovery,
				body.observation,
				body.termination,
				bootHash,
				hash(companyComputerOutageTerminationAcknowledgementCanonical(body.termination)),
			),
			receiptBytes = Buffer.from(`${companyComputerOutageAdoptionReceiptCanonical(receipt)}\n`),
			directory = companyComputerBootDirectory(command.bootId);
		const installed = Object.fromEntries(
			Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
				const content = Buffer.from(body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
				files.set(`${directory}/credentials/${file}`, { content, uid: 0, gid: 0, mode: 0o400 });
				return [file, { bytes: content.length, sha256: hash(content) }];
			}),
		);
		const completion = {
			schema: "qorpera.office-outage-configuration-completion/v1",
			command,
			recoveryId: body.recovery.request.recoveryId,
			activationId: body.recovery.request.activationId,
			originPreparationSha256: body.originPreparationSha256,
			adoptionReceiptSha256: hash(receiptBytes),
			bootObservationSha256: bootHash,
			files: installed,
		};
		files.set(`${directory}/configuration-completion.json`, {
			content: Buffer.from(`${JSON.stringify(completion)}\n`),
			uid: 0,
			gid: 0,
			mode: 0o600,
		});
		files.set(`${directory}/configuration-claim.json`, {
			content: Buffer.from(
				JSON.stringify({
					schema: "qorpera.office-outage-configuration-claim/v1",
					command,
					recoveryId: body.recovery.request.recoveryId,
					activationId: body.recovery.request.activationId,
				}),
			),
			uid: 0,
			gid: 0,
			mode: 0o600,
		});
		files.set(companyComputerBootAdoptionReceiptPath(command.bootId), {
			content: receiptBytes,
			uid: 0,
			gid: 0,
			mode: 0o444,
		});
		files.set("/run/qorpera-office-preparation/control.lock", {
			content: Buffer.alloc(0),
			uid: 0,
			gid: 0,
			mode: 0o600,
		});
		return { project, instanceName, operationId: randomUUID() };
	});
	client.inspectOfficeOutageConfiguration.mockResolvedValue("succeeded");
	client.pushOfficeOutageServiceStartRequest.mockImplementation(async (_p, _n, digest, bytes) =>
		files.set(`/run/qorpera-office-preparation/outage-service-start-incoming-${digest}.json`, {
			content: Buffer.from(bytes),
			uid: 0,
			gid: 0,
			mode: 0o400,
		}),
	);
	client.readOfficeOutageServiceStartRequest.mockImplementation(async (_p, _n, digest) => ({
		...files.get(`/run/qorpera-office-preparation/outage-service-start-incoming-${digest}.json`)!,
		content: Buffer.from(
			files.get(`/run/qorpera-office-preparation/outage-service-start-incoming-${digest}.json`)!.content,
		),
	}));
	client.submitOfficeOutageServiceStart.mockImplementation(async (project, instanceName, command) => {
		const body = parseCompanyComputerOutageServiceStartRequest(
			JSON.parse(
				files
					.get(`/run/qorpera-office-preparation/outage-service-start-incoming-${command.requestSha256}.json`)!
					.content.toString(),
			),
		);
		if (!successor || successor.state !== "prepared") throw new Error("duplicate service start");
		const completion = {
			schema: "qorpera.office-outage-service-start-completion/v1",
			command,
			recoveryId: body.successor.request.recovery.recoveryId,
			activationId: body.successor.request.attestation.activationId,
			configurationCompletionSha256: body.configurationCompletionSha256,
			configurationSha256: body.successor.request.attestation.configurationSha256,
			serviceInvocationId: "c".repeat(32),
			mainPid: 101,
			controlGroup: "/system.slice/qorpera-company-computer.service",
		};
		files.set("/run/qorpera-office-preparation/outage-service-start-completion.json", {
			content: Buffer.from(JSON.stringify(completion)),
			uid: 0,
			gid: 0,
			mode: 0o600,
		});
		files.set("/run/qorpera-office-preparation/outage-service-start-claim.json", {
			content: Buffer.from(
				JSON.stringify({
					schema: "qorpera.office-outage-service-start-claim/v1",
					command,
					recoveryId: body.successor.request.recovery.recoveryId,
					activationId: body.successor.request.attestation.activationId,
					configurationCompletionSha256: body.configurationCompletionSha256,
				}),
			),
			uid: 0,
			gid: 0,
			mode: 0o600,
		});
		successor = {
			...successor,
			state: "ready",
			serviceInvocationId: completion.serviceInvocationId,
			readinessFresh: true,
		};
		return { project, instanceName, operationId: randomUUID() };
	});
	client.inspectOfficeOutageServiceStart.mockResolvedValue("succeeded");
	client.submitOfficeOutageServiceInspection.mockImplementation(
		async (project, instanceName, _command, inspectionId) => {
			const start = JSON.parse(
				files.get("/run/qorpera-office-preparation/outage-service-start-completion.json")!.content.toString(),
			);
			files.set(`/run/qorpera-office-preparation/outage-service-inspection-${inspectionId}.json`, {
				content: Buffer.from(
					JSON.stringify({ schema: "qorpera.office-outage-service-inspection/v1", inspectionId, start }),
				),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
			return { project, instanceName, operationId: randomUUID() };
		},
	);
	const worker = () =>
		new LxdOfficeOutageResumeWorker(
			{ policy, check: async () => ({ hostBootId: clock.hostBootId, signal: signal(), validForMs: 5000 }) },
			control,
			{ paidComputer: adapter, client, imagePackageManifest, kernelLock: async () => {} },
		);
	return {
		files,
		sources,
		configureSources,
		serviceBootstrapPath,
		admission: (measureInvocation = vi.fn(async () => {})) =>
			new LxdOfficeOutageAdmissionWorker(
				new LxdOfficeOutageConfigurationWorker(
					new LxdOfficeOutageTerminationWorker(worker(), client),
					client,
					sources,
				),
				client,
				{ measureInvocation },
			),
		loseActivation: () => {
			loseActivationReply = true;
		},
		intentId,
		worker,
		clock,
		vm,
		journal,
		termination: () => new LxdOfficeOutageTerminationWorker(worker(), client),
		loseAck: () => {
			loseAck = true;
		},
		root,
		policy,
		binding,
		client,
		control,
		registry,
		activation,
		permitId,
		requestPath,
		receiptPath,
		sampleUsage: () => sampleOfficeGuardUsage(guard),
		guard: () => guard,
		controller: () => controller,
		adapter: () => adapter,
		setOrderly: () => {
			orderly = true;
		},
		loseReply: () => {
			loseOutageReply = true;
		},
		stop: async () => {
			clock.uptimeMs += 300001;
			await guard.sweep();
			await sampleOfficeGuardUsage(guard);
		},
		restart: async () => {
			guard = openGuard();
			await guard.initialize();
			controller = createController();
			adapter = new LxdOfficePaidComputer(policy, controller, control);
		},
	};
}
