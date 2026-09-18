import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_CONFIGURATION_FILES,
	COMPANY_COMPUTER_RESET_PHASES,
	type CompanyComputerResetPhase,
	type CompanyComputerResetPlan,
	companyComputerBootDirectory,
	parseCompanyComputerCodePackageProvisionReceipt,
	parseCompanyComputerCodePackageProvisionRequest,
	parseCompanyComputerResetConfigurationRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import type { LxdHostInventory } from "../../src/lxd-client.ts";
import { officeCanonical, officeDigest } from "../../src/lxd-office-image-provenance.ts";
import type { LxdOfficeResetSuccessorLane } from "../../src/lxd-office-reset-successor-lane.ts";
import {
	type LxdOfficeResetCodePackageLane,
	type LxdOfficeResetInput,
	LxdOfficeResetWorker,
} from "../../src/lxd-office-reset-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "../../src/lxd-office-start-control.ts";
import { nodeAdmissionFixture } from "./node-admission.ts";
import { officeCodePackageMaterialFixture } from "./office-code-package-material.ts";
import { officeImagePackageBytes, officeImagePackageFixture } from "./office-image-package.ts";
import { serviceStartId as id } from "./office-service-start.ts";
import { officeStopWorkerFixture } from "./office-stop-worker.ts";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const signal = (): AbortSignal => new AbortController().signal;
type GuestFile = { content: Buffer; uid: number; gid: number; mode: number };
const OUTBOX = "/var/lib/qorpera-office-events";
function outboxCanonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(outboxCanonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b, "en"))
				.map(([key, item]) => [key, outboxCanonical(item)]),
		);
	return value;
}
const outboxBytes = (value: unknown) => Buffer.from(`${JSON.stringify(outboxCanonical(value))}\n`);

/** Synthetic SQL reset authority mirroring the migration's phase machine:
 * ordered phases, nonce-bound five-second challenges, custody/restore digest
 * retention, reset successor preparation/readiness/activation. Physical
 * observations are the LXD/guest map below; no PostgreSQL is involved. */
export function officeResetRegistryFixture(plan: CompanyComputerResetPlan, planSha256: string) {
	const state = {
		phase: null as CompanyComputerResetPhase | null,
		revision: 0,
		custodySha256: null as string | null,
		restoreSha256: null as string | null,
		successor: null as Record<string, unknown> | null,
		challengeValidForMs: 5000,
		challenges: new Map<string, { phase: string; evidenceSha256: string; revision: number; expiresAt: number }>(),
		acked: new Map<string, { challengeId: string; evidence: unknown }>(),
		loseAck: new Set<string>(),
		losePrepare: false,
		loseActivate: false,
		nodeRefused: false,
		packageEnrolled: false,
		packageInstalled: false,
		packageMeasured: false,
		calls: [] as string[],
	};
	const index = (phase: CompanyComputerResetPhase | null) =>
		phase === null ? -1 : COMPANY_COMPUTER_RESET_PHASES.indexOf(phase);
	const status = () => ({
		schema: "qorpera.office-reset/v1",
		resetId: plan.resetId,
		phase: state.phase,
		revision: state.revision,
		rootIncarnationId: plan.rootIncarnationId,
		successorActivationId: plan.successorActivationId,
		custodySha256: state.custodySha256,
		restoreSha256: state.restoreSha256,
		stopAcknowledgedAtMs: 2000,
		officeRevision: 12,
		privacyVersion: 1,
		validForMs: 5000,
	});
	const successorResult = () => ({
		schema: "qorpera.office-reset-successor/v1",
		request: state.successor!.request,
		state: state.successor!.state,
		serviceInvocationId: state.successor!.serviceInvocationId,
		readinessFresh: state.successor!.readinessFresh,
		stopAcknowledgedAtMs: 2000,
		officeRevision: 12,
		privacyVersion: 1,
		validForMs: 5000,
	});
	const call = vi.fn(async (method: string, args: Record<string, unknown>, checked: AbortSignal) => {
		checked.throwIfAborted();
		state.calls.push(method);
		if (method === "qorpera_reserve_runtime_node_machine")
			return state.nodeRefused
				? { state: "refused", reason: "NODE_CAPACITY_EXHAUSTED" }
				: nodeAdmissionFixture(args);
		if (method.endsWith("reset_successor") || method.endsWith("reset_successor_status")) {
			const request = args.p_request as { attestation: { activationId: string; bootId: string } };
			if (method === "qorpera_prepare_runtime_office_reset_successor") {
				if (!state.packageInstalled) throw new Error("package absent");
				if (!state.successor) {
					if (state.phase !== "restored") throw new Error("chain incomplete");
					state.successor = {
						request: structuredClone(args.p_request),
						state: "prepared",
						serviceInvocationId: null,
						readinessFresh: false,
					};
					state.phase = "prepared";
					state.revision++;
					if (state.losePrepare) {
						state.losePrepare = false;
						throw new Error("lost committed preparation reply");
					}
				}
				expect(state.successor.request).toEqual(args.p_request);
				return successorResult();
			}
			if (!state.successor) throw new Error("successor unavailable");
			expect(state.successor.request).toEqual(args.p_request);
			expect(request.attestation.activationId).toBe(plan.successorActivationId);
			if (method === "qorpera_activate_runtime_office_reset_successor") {
				if (!state.packageMeasured) throw new Error("package measurement absent");
				if (state.successor.state === "prepared" || !state.successor.readinessFresh) throw new Error("not ready");
				expect(args.p_service_invocation_id).toBe(state.successor.serviceInvocationId);
				if (state.successor.state !== "active") {
					state.successor.state = "active";
					state.phase = "active";
					state.revision++;
					if (state.loseActivate) {
						state.loseActivate = false;
						throw new Error("lost committed activation reply");
					}
				}
			}
			return successorResult();
		}
		expect(args.p_plan).toEqual(plan);
		if (method === "qorpera_begin_runtime_office_reset") {
			if (!state.packageEnrolled) throw new Error("package relation absent");
			expect(args.p_plan_sha256).toBe(planSha256);
			if (state.phase === null) {
				state.phase = "fenced";
				state.revision = 1;
			}
			return status();
		}
		if (method === "qorpera_runtime_office_reset_status") {
			if (state.phase === null) throw new Error("identity unavailable");
			return status();
		}
		const challengeResult = (challengeId: string) => {
			const challenge = state.challenges.get(challengeId)!,
				validForMs = Math.min(state.challengeValidForMs, Math.floor(challenge.expiresAt - performance.now()));
			if (validForMs < 1) throw new Error("challenge expired");
			return {
				schema: "qorpera.office-reset-phase-challenge/v1",
				challengeId,
				resetId: plan.resetId,
				phase: challenge.phase,
				revision: challenge.revision,
				officeRevision: 12,
				privacyVersion: 1,
				evidenceSha256: challenge.evidenceSha256,
				validForMs,
			};
		};
		if (method === "qorpera_prepare_runtime_office_reset_phase") {
			const phase = args.p_phase as CompanyComputerResetPhase,
				challengeId = args.p_challenge_id as string;
			if (index(phase) !== index(state.phase) + 1) throw new Error("phase order");
			const existing = state.challenges.get(challengeId);
			if (existing) {
				if (existing.phase !== phase || existing.evidenceSha256 !== args.p_evidence_sha256)
					throw new Error("changed");
			} else {
				if ([...state.challenges.values()].filter((c) => c.phase === phase).length >= 64) throw new Error("budget");
				state.challenges.set(challengeId, {
					phase,
					evidenceSha256: args.p_evidence_sha256 as string,
					revision: state.revision,
					expiresAt: performance.now() + 5000,
				});
			}
			return challengeResult(challengeId);
		}
		if (method === "qorpera_check_runtime_office_reset_phase") {
			const challenge = state.challenges.get(args.p_challenge_id as string);
			if (!challenge || challenge.revision !== state.revision) throw new Error("challenge unavailable");
			return challengeResult(args.p_challenge_id as string);
		}
		if (method === "qorpera_ack_runtime_office_reset_phase") {
			const challengeId = args.p_challenge_id as string,
				challenge = state.challenges.get(challengeId),
				evidence = args.p_evidence as { phase: string; observation: Record<string, unknown> };
			if (!challenge || evidence.phase !== challenge.phase) throw new Error("challenge unavailable");
			if (officeDigest(evidence) !== challenge.evidenceSha256) throw new Error("evidence differs");
			if (state.phase === challenge.phase) {
				const acked = state.acked.get(challenge.phase);
				if (acked?.challengeId !== challengeId) throw new Error("cannot be rebound");
				expect(acked.evidence).toEqual(evidence);
				return status();
			}
			if (index(challenge.phase as CompanyComputerResetPhase) !== index(state.phase) + 1)
				throw new Error("phase order");
			if (challenge.revision !== state.revision || performance.now() >= challenge.expiresAt)
				throw new Error("expired or changed");
			state.phase = challenge.phase as CompanyComputerResetPhase;
			state.revision++;
			state.acked.set(challenge.phase, { challengeId, evidence: structuredClone(evidence) });
			if (challenge.phase === "custodied") state.custodySha256 = challenge.evidenceSha256;
			if (challenge.phase === "restored") state.restoreSha256 = challenge.evidenceSha256;
			if (state.loseAck.has(challenge.phase)) {
				state.loseAck.delete(challenge.phase);
				throw new Error(`lost committed ${challenge.phase} acknowledgement`);
			}
			return status();
		}
		throw new Error(`unexpected registry call ${method}`);
	});
	return { state, call, status };
}

/** Stopped replace predecessor (real journals from the stop fixture), a
 * synthetic LXD/root map with a diagnostic outbox and sealed history, a
 * provider-owned archive root, and a synthetic guest successor lane. */
export async function officeResetWorkerFixture(roots: string[], predecessorRootIncarnationId: string | null = null) {
	const f = await officeStopWorkerFixture(roots, "replace");
	await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
	const imagePackageManifestPath = join(f.root, "original-image-manifest.json");
	const originalRead = f.readProtected.getMockImplementation()!;
	f.readProtected.mockImplementation(async (path, ...args) =>
		path === imagePackageManifestPath ? officeImagePackageBytes() : originalRead(path, ...args),
	);
	const archiveRoot = await realpath(await mkdtemp(join(tmpdir(), "office-reset-archive-")));
	roots.push(archiveRoot);
	await chmod(archiveRoot, 0o700);
	const guest = f.guest as Map<string, GuestFile>;
	const scope = f.request.startup.scope,
		outboxUid = 1001,
		outboxGid = 1001;
	const record = (lifetime: number, sequence: number, state: string) => ({
		schema: "qorpera.runtime-screen-observation/v1",
		startup: f.request.startup,
		binding: {
			...scope,
			computerGeneration: 1,
			screenId: id(60),
			screenOrdinal: 1,
			screenGeneration: 1,
			staffAgentId: id(61),
		},
		privacy: null,
		event: {
			lifetimeId: id(lifetime),
			eventId: id(lifetime * 10 + sequence),
			sequence,
			observedAt: "2026-09-12T00:00:00.000Z",
			state,
			reason: state === "ready" ? "DESKTOP_READY" : "SCREEN_REQUESTED",
		},
	});
	const outbox = new Map<string, Buffer>([
		["scope.json", outboxBytes({ schema: "qorpera.screen-outbox-scope/v1", scope })],
		[`${id(70)}-0000000000000001.json`, outboxBytes(record(70, 1, "requested"))],
		[`${id(70)}-0000000000000002.json`, outboxBytes(record(70, 2, "ready"))],
	]);
	for (const [name, content] of outbox)
		guest.set(`${OUTBOX}/${name}`, { content, uid: outboxUid, gid: outboxGid, mode: 0o600 });
	const dirs = new Set<string>([
		OUTBOX,
		`/etc/qorpera-office/history/${f.request.startup.bootId}/${f.request.activationId}`,
	]);
	// The predecessor's preparation identity is the retained activation attestation's.
	const activationSeed = JSON.parse(await readFile(f.activation.names.seed, "utf8")) as {
		request: { attestation: { preparationObservationSha256: string } };
	};
	const plan: CompanyComputerResetPlan = {
		schema: "qorpera.lxd-office-reset-plan/v1",
		resetId: id(200),
		intentId: f.activation.request.intentId,
		predecessor: f.request,
		preparationObservationSha256: activationSeed.request.attestation.preparationObservationSha256,
		providerBindingSha256: lxdOfficeProviderBindingSha256(f.binding),
		nodeId: null,
		predecessorRootIncarnationId,
		rootIncarnationId: id(201),
		successorActivationId: id(202),
		commands: { stopCommandId: id(210), deleteCommandId: id(211), createCommandId: id(212), startCommandId: id(213) },
		custody: { archiveRoot },
	};
	const planSha256 = officeDigest(plan);
	const registry = officeResetRegistryFixture(plan, planSha256);
	const packageMaterial = officeCodePackageMaterialFixture({
		policy: f.policy,
		binding: f.binding,
		configure: (code) => {
			Object.assign(code.base, officeImagePackageFixture());
			Object.assign(code.target, officeImagePackageFixture());
			Object.assign(code.reset, plan);
			Object.assign(code.statement.base, {
				imageSha256: f.binding.imageFingerprint,
				bootstrapSha256: f.binding.bootstrapSha256,
			});
			Object.assign(code.plan, {
				resetId: plan.resetId,
				rootIncarnationId: plan.rootIncarnationId,
				successorActivationId: plan.successorActivationId,
			});
		},
	});
	const codePackageLanePath = join(f.root, "code-package-lane.json");
	packageMaterial.files.set(
		codePackageLanePath,
		Buffer.from(JSON.stringify({ schema: "qorpera.lxd-office-code-package-lane/v1", ...packageMaterial.document })),
	);
	const previousProtected = f.readProtected.getMockImplementation()!,
		previousCredential = f.readCredential.getMockImplementation()!;
	f.readProtected.mockImplementation(async (path: string, limit = 65536) =>
		packageMaterial.files.has(path) ? packageMaterial.ports.readProtected(path, limit) : previousProtected(path),
	);
	f.readCredential.mockImplementation(async (path: string, limit = 65536) =>
		packageMaterial.files.has(path) ? packageMaterial.ports.readCredential(path, limit) : previousCredential(path),
	);
	const packageEvents: string[] = [];
	const packageLane = {
		enroll: vi.fn<LxdOfficeResetCodePackageLane["enroll"]>(async () => {
			packageEvents.push("enroll");
			registry.state.packageEnrolled = true;
			return {
				state: "enrolled",
				currentPackageRevision: 0,
				capabilityRevision: 1,
				request: null,
				requestSha256: null,
				receipt: null,
				receiptSha256: null,
				installationEvidenceSha256: null,
			};
		}),
		ensure: vi.fn<LxdOfficeResetCodePackageLane["ensure"]>(async (context, checked, authorize) => {
			checked.throwIfAborted();
			await authorize();
			expect(["restored", "prepared", "active"]).toContain(registry.state.phase);
			expect(context.restoreSha256).toBe(registry.state.restoreSha256);
			expect(context.resetPlan).toEqual(plan);
			packageEvents.push("ensure");
			registry.state.packageInstalled = true;
			const request = parseCompanyComputerCodePackageProvisionRequest({
				schema: "qorpera.office-code-package-provision-request/v1",
				plan: packageMaterial.plan,
				planSha256: packageMaterial.trust.planSha256,
				bootId: context.bootId,
				restoreSha256: context.restoreSha256,
				challengeId: id(650),
				targetRevision: 1,
				capabilityRevision: 1,
				targetManifestSha256: packageMaterial.statement.target.packageManifestSha256,
			});
			const receipt = parseCompanyComputerCodePackageProvisionReceipt({
				schema: "qorpera.office-code-package-provision-receipt/v1",
				planSha256: request.planSha256,
				provisionId: request.plan.provisionId,
				resetId: plan.resetId,
				rootIncarnationId: plan.rootIncarnationId,
				bootId: context.bootId,
				commandId: request.plan.installCommandId,
				requestSha256: officeDigest(request),
				restoreSha256: context.restoreSha256,
				state: "installed",
				targetRevision: 1,
				packageManifestSha256: request.targetManifestSha256,
				installedInventorySha256: "6".repeat(64),
				sourceCommit: packageMaterial.statement.target.sourceCommit,
				runtimeBundle: packageMaterial.statement.target.runtimeBundle,
				service: packageMaterial.statement.target.service,
			});
			return {
				packet: {
					schema: "qorpera.office-code-package-control/v1",
					request,
					resetPlan: plan,
					custody: context.custody,
					restore: context.restore,
					originPreparationSha256: hash(context.originalPreparation),
					envelope: packageMaterial.envelope,
				},
				receipt,
			};
		}),
		prepareInvocation: vi.fn<LxdOfficeResetCodePackageLane["prepareInvocation"]>(async (packet) => {
			packageEvents.push("stage");
			return { packetSha256: officeDigest(packet), trustSha256: officeDigest(packageMaterial.document.trust) };
		}),
		measureInvocation: vi.fn<LxdOfficeResetCodePackageLane["measureInvocation"]>(
			async (_pins, activationId, startup, deadline, checked) => {
				checked.throwIfAborted();
				expect(performance.now()).toBeLessThan(deadline);
				expect(activationId).toBe(plan.successorActivationId);
				expect(startup.serviceInvocationId).toBe("c".repeat(32));
				expect(packageEvents.at(-1)).toBe("stage");
				packageEvents.push("measure");
				registry.state.packageMeasured = true;
			},
		),
	};

	const vm = {
		state: "running" as "running" | "stopped" | "absent",
		bootId: f.request.startup.bootId,
		freshBootId: id(300),
	};
	const current = (await f.client.getInstance(f.binding.project, "unused", signal()))!;
	f.get.mockImplementation(async () =>
		vm.state === "absent"
			? undefined
			: {
					...structuredClone(current),
					status: vm.state === "running" ? "Running" : "Stopped",
					statusCode: vm.state === "running" ? 103 : 102,
				},
	);
	const vmState = vi.spyOn(f.client, "getInstanceState").mockImplementation(async () => ({
		status: vm.state === "running" ? "Running" : "Stopped",
		statusCode: vm.state === "running" ? 103 : 102,
		network: {},
	}));
	const listing = vi.spyOn(f.client, "listOfficeResetDirectory").mockImplementation(async (_p, _n, path) => {
		const names = new Set<string>();
		for (const key of guest.keys())
			if (key.startsWith(`${path}/`)) names.add(key.slice(path.length + 1).split("/")[0]);
		for (const dir of dirs) if (dir.startsWith(`${path}/`)) names.add(dir.slice(path.length + 1).split("/")[0]);
		if (!dirs.has(path) && names.size === 0) throw new Error("LXD_OFFICE_RESET_LISTING_UNCONFIRMED");
		return [...names].sort();
	});
	const readReset = vi.spyOn(f.client, "readOfficeResetFile").mockImplementation(async (_p, _n, path, limit) => {
		const file = guest.get(path);
		if (!file || file.content.length > limit) throw new Error("LXD_OFFICE_RESET_READBACK_UNCONFIRMED");
		return { ...file, content: Buffer.from(file.content) };
	});
	const pushDirectory = vi.spyOn(f.client, "pushOfficeResetDirectory").mockImplementation(async (_p, _n, path) => {
		if (vm.state !== "running") throw new Error("guest offline");
		dirs.add(path);
	});
	const pushFile = vi
		.spyOn(f.client, "pushOfficeResetFile")
		.mockImplementation(async (_p, _n, path, content, uid, gid, mode) => {
			if (vm.state !== "running") throw new Error("guest offline");
			guest.set(path, { content: Buffer.from(content), uid, gid, mode });
		});
	const inventory: LxdHostInventory = {
		server: {
			project: "default",
			certificateSha256: f.policy.host.certificateSha256,
			serverName: f.policy.host.serverName,
			serverVersion: f.policy.host.serverVersion,
			architecture: f.policy.host.architecture,
		},
		instances: [{ ...structuredClone(current), project: f.binding.project, location: "" }],
	};
	const hostInventory = vi
		.spyOn(f.client, "inspectHostInventory")
		.mockImplementation(async () => structuredClone(inventory));
	const journalRoot = join(f.root, f.binding.allocationId);
	const submit = vi.spyOn(f.client, "submitInstanceOperation").mockImplementation(async (project, action) => {
		const name = action.action === "create" ? action.request.name : action.name;
		expect(name).toBe(current.name);
		if (action.action === "stop") vm.state = "stopped";
		if (action.action === "delete") {
			vm.state = "absent";
			for (const key of [...guest.keys()]) guest.delete(key);
			dirs.clear();
		}
		if (action.action === "create") {
			vm.state = "stopped";
			guest.set("/proc/sys/kernel/random/boot_id", {
				content: Buffer.from(`${vm.freshBootId}\n`),
				uid: 0,
				gid: 0,
				mode: 0o444,
			});
			guest.set("/run/qorpera-office-preparation/control.lock", {
				content: Buffer.alloc(0),
				uid: 0,
				gid: 0,
				mode: 0o600,
			});
		}
		if (action.action === "start") {
			vm.state = "running";
			vm.bootId = vm.freshBootId;
		}
		return { project, instanceName: name, operationId: id(400 + submit.mock.calls.length) };
	});
	const poll = vi.spyOn(f.client, "inspectInstanceOperation").mockResolvedValue("succeeded");
	const nas = { verifications: 0, layoutSha256: "5".repeat(64), fail: false };
	const nasCustody = vi.fn(async () => ({
		layoutSha256: nas.layoutSha256,
		adoptionId: id(6),
		verify: async () => {
			nas.verifications++;
			if (nas.fail) throw new Error("OFFICE_RESET_NAS_CUSTODY_CHANGED");
		},
		close: async () => {},
	}));
	/** Synthetic guest lane: installs the packet's material under the fresh
	 * boot directory and reports a running invocation without any transport. */
	const lane = {
		configure: vi.fn<LxdOfficeResetSuccessorLane["configure"]>(async (input) => {
			const body = parseCompanyComputerResetConfigurationRequest(JSON.parse(input.request.toString()));
			expect(JSON.parse(body.material.configuration).linux.attestation.bootId).toBe(input.bootId);
			expect(input.bootId).toBe(vm.freshBootId);
			expect(hash(input.request)).toBe(input.command.requestSha256);
			expect(body.predecessor).toEqual(plan.predecessor);
			const files = Object.fromEntries(
				Object.entries(COMPANY_COMPUTER_CONFIGURATION_FILES).map(([key, file]) => {
					const content = Buffer.from(body.material[key as keyof typeof COMPANY_COMPUTER_CONFIGURATION_FILES]);
					guest.set(`${companyComputerBootDirectory(input.bootId)}/credentials/${file}`, {
						content,
						uid: 0,
						gid: 0,
						mode: 0o400,
					});
					return [file, { bytes: content.length, sha256: hash(content) }];
				}),
			) as Awaited<ReturnType<LxdOfficeResetSuccessorLane["configure"]>>;
			expect(files).toEqual(input.expected.files);
			return files;
		}),
		start: vi.fn<LxdOfficeResetSuccessorLane["start"]>(async (input) => {
			expect(registry.state.successor?.state).toBe("prepared");
			expect(input.claimed).toBe(false);
			Object.assign(registry.state.successor!, {
				state: "ready",
				serviceInvocationId: "c".repeat(32),
				readinessFresh: true,
			});
			return {
				schema: "qorpera.office-reset-service-start-completion/v1",
				command: input.command,
				resetId: plan.resetId,
				activationId: plan.successorActivationId,
				configurationCompletionSha256: "d".repeat(64),
				configurationSha256: input.successor.request.attestation.configurationSha256,
				serviceInvocationId: "c".repeat(32),
				mainPid: 700,
				controlGroup: "/system.slice/qorpera-company-computer.service",
			};
		}),
		inspect: vi.fn<LxdOfficeResetSuccessorLane["inspect"]>(async (input) => {
			expect(input.plan.successorActivationId).toBe(plan.successorActivationId);
			return {
				serviceInvocationId: input.completion.serviceInvocationId,
				configurationSha256: input.completion.configurationSha256,
			};
		}),
	};
	const input: LxdOfficeResetInput = {
		intentId: f.activation.request.intentId,
		plan,
		planSha256,
		serviceBootstrapPath: f.activation.request.serviceBootstrapPath,
		imagePackageManifestPath,
		codePackageLanePath,
	};
	const create = (ports: { successorLane?: LxdOfficeResetSuccessorLane | null } = {}) =>
		new LxdOfficeResetWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry.call },
			{
				client: f.client,
				kernelLock: f.kernelLock,
				readProtected: f.readProtected,
				readCredential: f.readCredential,
				nasCustody,
				readManifest: packageMaterial.ports.readManifest,
				readArtifact: packageMaterial.ports.readArtifact,
				codePackageLane: () => packageLane,
				successorLane: ports.successorLane === null ? undefined : (ports.successorLane ?? lane),
			},
		);
	const run = (ports?: { successorLane?: LxdOfficeResetSuccessorLane | null }, s: AbortSignal = signal()) =>
		create(ports).reconcile(input, s);
	/** Advance phase by phase until the requested state or a hold. */
	const until = async (target: string, limit = 12) => {
		let result = await run();
		for (let tick = 0; tick < limit && result.state !== target && result.state === "progressed"; tick++)
			result = await run();
		return result;
	};
	/** Exactly n reconciliation ticks, each with a fresh worker object. */
	const ticks = async (count: number) => {
		let result = await run();
		for (let tick = 1; tick < count; tick++) result = await run();
		return result;
	};
	const suffix = `${f.binding.allocationId}-${plan.resetId}`;
	return {
		...f,
		stop: f,
		archiveRoot,
		guest,
		dirs,
		outbox,
		outboxUid,
		outboxGid,
		plan,
		planSha256,
		input,
		registry,
		packageMaterial,
		packageLane,
		packageEvents,
		vm,
		vmState,
		listing,
		readReset,
		pushDirectory,
		pushFile,
		hostInventory,
		inventory,
		submit,
		poll,
		nas,
		nasCustody,
		lane,
		journalRoot,
		create,
		run,
		until,
		ticks,
		paths: {
			seed: join(f.root, `reset-seed-${suffix}.json`),
			custody: join(f.root, `reset-custody-${suffix}.json`),
			restore: join(f.root, `reset-restore-${suffix}.json`),
			successor: join(f.root, `reset-successor-request-${suffix}.json`),
			configuration: join(f.root, `reset-configuration-${suffix}.json`),
			started: join(f.root, `reset-service-started-${suffix}.json`),
			done: join(f.root, `reset-completed-${suffix}.json`),
			journalRoot: (purpose: "reset-configuration" | "reset-service-start") =>
				join(f.root, `${purpose}-${f.binding.allocationId}-${plan.successorActivationId}`),
			journal: (purpose: "reset-configuration" | "reset-service-start", file: string) =>
				join(f.root, `${purpose}-${f.binding.allocationId}-${plan.successorActivationId}`, file),
			phase: (n: number) => join(f.root, `reset-phase-${suffix}-${n}.json`),
			archive: join(archiveRoot, plan.resetId),
		},
		canonical: officeCanonical,
	};
}
