import { mkdtemp, readFile, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompanyComputerLifecycleRequest } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LxdOfficeConfigurationRequest } from "../src/lxd-office-configuration-worker.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../src/lxd-office-inventory-worker.ts";
import { publish } from "../src/lxd-office-journal-files.ts";
import { LxdOfficeLifecycle, runLxdOfficeLifecycle } from "../src/lxd-office-lifecycle.ts";
import { lxdOfficePhysicalPolicySha256 } from "../src/lxd-office-physical-policy.ts";
import type { LxdOfficeResumeWorker } from "../src/lxd-office-resume-worker.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const intentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const allocationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "office-lifecycle-")));
	roots.push(root);
	const { policy } = officePhysicalFixture();
	policy.journal.path = root;
	policy.journal.mountPoint = root;
	const g = policy.guest;
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId,
		allocationId,
		providerBindingSha256: "c".repeat(64),
		hostBootId: intentId,
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: "/synthetic",
			mountId: "1",
			entries: [],
			totalBytes: 0,
		},
	};
	const observationSha256 = officeDigest(observation);
	const request: LxdOfficeConfigurationRequest = {
		intentId,
		observationSha256,
		input: { synthetic: true },
		reviewPath: "/protected/review.json",
		writerFencePath: "/protected/writers.json",
		serviceBootstrapPath: "/protected/service.json",
	};
	const state = {
		office: "provisioning",
		intent: "requested" as string | null,
		enabled: true,
		reservation: null as unknown,
		plan: undefined as unknown,
		recovery: undefined as unknown,
		resume: undefined as unknown,
		reset: undefined as unknown,
		idle: null as unknown,
		kernel: true,
	};
	const calls: string[] = [];
	const record = async (phase: string) => {
		calls.push(phase);
	};
	const operation = (phase: string, result: unknown) =>
		vi.fn(async () => {
			await record(phase);
			return result;
		});
	const workers = {
		creation: {
			reconcileSettled: vi.fn(async () => {
				await record("creation");
				state.intent = "reserved";
				state.reservation = { allocationId, instanceSha256: "a".repeat(64), providerBindingSha256: "c".repeat(64) };
				return { state: "awaiting_adoption" as const, intentId, allocationId, instanceSha256: "a".repeat(64) };
			}),
		},
		inventory: {
			inspectSettled: vi.fn(async () => {
				await record("inventory");
				const evidencePath = join(root, `inventory-${observationSha256}.json`);
				await publish(root, `inventory-${observationSha256}.json`, Buffer.from(JSON.stringify(observation)));
				return { observation, observationSha256, evidencePath };
			}),
		},
		adoption: { copySettled: operation("adoption", { state: "copied" }) },
		boot: { reconcileSettled: operation("boot", { state: "awaiting_preparation" }) },
		preparation: { reconcileSettled: operation("preparation", { state: "awaiting_activation" }) },
		configuration: { reconcileSettled: operation("configuration", { state: "awaiting_activation" }) },
		activation: {
			reconcileSettled: vi.fn(async () => {
				await record("activation");
				state.office = "active";
				return { state: "active" };
			}),
		},
	};
	const registry = {
		call: vi.fn(async (method: string) =>
			method === "qorpera_reconcile_runtime_office_idle"
				? {
						schema: "qorpera.office-idle-policy/v1",
						request: state.idle,
						wakeRequested: false,
					}
				: {
						schema: "qorpera.office-provider-status/v1",
						scope: {
							companyId: g.companyId,
							environmentId: g.environmentId,
							companyComputerId: g.companyComputerId,
							logicalComputerId: g.logicalComputerId,
						},
						computerGeneration: g.computerGeneration,
						providerId: g.providerId,
						providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
						providerVersion: 1,
						preparationEnabled: state.enabled,
						officeState: state.office,
						imageSha256: g.imageFingerprint,
						bootstrapSha256: g.bootstrapSha256,
						intent:
							state.intent === null
								? null
								: {
										schema: "qorpera.office-start-intent/v1",
										intentId,
										companyComputerId: g.companyComputerId,
										computerGeneration: g.computerGeneration,
										state: state.intent,
									},
						reservation: state.reservation,
					},
		),
	};
	const kernelLock = vi.fn(async () => {
		if (!state.kernel) throw new Error("lock missing");
	});
	const readProtected = vi.fn(async (path: string) => {
		if (path.endsWith(".reset")) {
			if (!state.reset) throw Object.assign(new Error("missing reset"), { code: "ENOENT" });
			return Buffer.from(JSON.stringify(state.reset));
		}
		if (path.endsWith(".resume")) {
			if (!state.resume) throw Object.assign(new Error("missing resume"), { code: "ENOENT" });
			return Buffer.from(JSON.stringify(state.resume));
		}
		if (path.endsWith(".recovery")) {
			if (!state.recovery) throw Object.assign(new Error("missing recovery"), { code: "ENOENT" });
			return Buffer.from(JSON.stringify(state.recovery));
		}
		if (!state.plan) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return Buffer.from(JSON.stringify(state.plan));
	});
	const recovery = parseCompanyComputerLifecycleRequest({
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId: intentId,
		action: "replace",
		activationId: intentId,
		providerId: g.providerId,
		providerPolicySha256: lxdOfficePhysicalPolicySha256(policy),
		startup: {
			scope: {
				companyId: g.companyId,
				environmentId: g.environmentId,
				companyComputerId: g.companyComputerId,
				logicalComputerId: g.logicalComputerId,
			},
			computerGeneration: g.computerGeneration,
			allocationId,
			instanceSha256: "a".repeat(64),
			imageSha256: g.imageFingerprint,
			bootstrapSha256: g.bootstrapSha256,
			bootId: intentId,
			configurationSha256: "d".repeat(64),
			serviceInvocationId: "e".repeat(32),
		},
	});
	const stopWorker = {
		reconcileSettled: vi.fn(async () => {
			calls.push("stop");
			state.office = "maintenance";
			return {
				state: "stopped" as const,
				intentId,
				allocationId,
				transitionId: recovery.transitionId,
				commandId: intentId,
				acknowledgedAtMs: 2000,
			};
		}),
	};
	const successorWorker = {
		reconcileSettled: vi.fn(async () => {
			calls.push("restart");
			if (!state.enabled) throw new Error("preparation disabled");
			state.office = "active";
			return {
				state: "active" as const,
				intentId,
				allocationId,
				transitionId: recovery.transitionId,
				activationId: allocationId,
				commandId: intentId,
				serviceInvocationId: "f".repeat(32),
			};
		}),
	};
	const powerOffWorker = {
		reconcileSettled: vi.fn(async () => ({
			state: "powered_off" as const,
			intentId,
			allocationId,
			transitionId: recovery.transitionId,
			commandId: intentId,
		})),
	};
	const resumeWorker = {
		reconcileSettled: vi.fn<LxdOfficeResumeWorker["reconcileSettled"]>(async (_intent, request) => ({
			state: "awaiting_configuration" as const,
			intentId,
			allocationId,
			bootIntentId: request.bootIntentId,
			activationId: request.activationId,
			startCommandId: intentId,
			bootId: allocationId,
			instanceSha256: "a".repeat(64),
			bootObservationSha256: "b".repeat(64),
		})),
	};
	const resetPlan = (predecessor: unknown) => ({
		schema: "qorpera.lxd-office-reset-plan/v1",
		resetId: "77777777-7777-4777-8777-777777777771",
		intentId,
		predecessor,
		preparationObservationSha256: "1".repeat(64),
		providerBindingSha256: "c".repeat(64),
		nodeId: null,
		predecessorRootIncarnationId: null,
		rootIncarnationId: "77777777-7777-4777-8777-777777777772",
		successorActivationId: "77777777-7777-4777-8777-777777777773",
		commands: {
			stopCommandId: "77777777-7777-4777-8777-777777777774",
			deleteCommandId: "77777777-7777-4777-8777-777777777775",
			createCommandId: "77777777-7777-4777-8777-777777777776",
			startCommandId: "77777777-7777-4777-8777-777777777777",
		},
		custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" },
	});
	const resetWorker = {
		result: { state: "active", phase: "active" } as { state: string; phase: string; reason?: string },
		reconcileSettled: vi.fn(
			async (input: { intentId: string; plan: { resetId: string; successorActivationId: string } }) => {
				calls.push("reset");
				if (resetWorker.result.state === "active") state.office = "active";
				return {
					...resetWorker.result,
					intentId: input.intentId,
					allocationId,
					resetId: input.plan.resetId,
					transitionId: recovery.transitionId,
					activationId: input.plan.successorActivationId,
					...(resetWorker.result.state === "active" ? { serviceInvocationId: "f".repeat(32) } : {}),
				};
			},
		),
	};
	const bootConfigurationWorker = {
		reconcileSettled: vi.fn(async (input: { request: { bootIntentId: string; activationId: string } }) => ({
			state: "awaiting_boot_admission" as const,
			intentId,
			allocationId,
			bootIntentId: input.request.bootIntentId,
			activationId: input.request.activationId,
			bootId: allocationId,
			resumeStartCommandId: intentId,
			bootObservationSha256: "b".repeat(64),
			commandId: intentId,
			requestSha256: "d".repeat(64),
			observationSha256: "e".repeat(64),
		})),
	};
	const bootActivationWorker = {
		reconcileSettled: vi.fn(async (input: { request: { bootIntentId: string; activationId: string } }) => {
			const stage = JSON.parse(
				await readFile(
					join(root, `recovery-boot-activation-stage-${allocationId}-${recovery.transitionId}.json`),
					"utf8",
				),
			);
			expect(stage.configurationObservationSha256).toBe("e".repeat(64));
			state.office = "active";
			return {
				state: "active" as const,
				intentId,
				allocationId,
				bootIntentId: input.request.bootIntentId,
				activationId: input.request.activationId,
				bootId: allocationId,
				commandId: intentId,
				configurationObservationSha256: "e".repeat(64),
				serviceInvocationId: "f".repeat(32),
			};
		}),
	};
	const preparePackageInvocation = vi.fn<
		NonNullable<NonNullable<ConstructorParameters<typeof LxdOfficeLifecycle>[3]>["preparePackageInvocation"]>
	>(async () => undefined);
	const open = (resetImagePackageManifestPath?: string, codePackageLanePath?: string, idleMs?: number) =>
		new LxdOfficeLifecycle(
			{ policy, check: vi.fn(), inspect: vi.fn() },
			registry,
			{
				idleMs,
				planPath: "/protected/lifecycle.json",
				resetImagePackageManifestPath,
				codePackageLanePath,
				inventoryLimits: {
					maxEntries: 100,
					maxDepth: 4,
					maxFileBytes: 1024,
					maxTotalBytes: 4096,
					maxManifestBytes: 65536,
				},
			},
			{
				preparePackageInvocation,
				workers: workers as unknown as NonNullable<ConstructorParameters<typeof LxdOfficeLifecycle>[3]>["workers"],
				kernelLock,
				readProtected,
				stopWorker,
				successorWorker,
				powerOffWorker,
				resumeWorker,
				bootConfigurationWorker,
				bootActivationWorker,
				resetWorker: resetWorker as unknown as NonNullable<
					ConstructorParameters<typeof LxdOfficeLifecycle>[3]
				>["resetWorker"],
			},
		);
	const approve = () => {
		state.plan = { schema: "qorpera.lxd-office-lifecycle-plan/v1", request };
	};
	const toPhase = async (index: number) => {
		approve();
		for (let i = 0; i < index; i++) expect((await open().reconcile(signal())).state).toBe("progressed");
	};
	return {
		root,
		state,
		workers,
		calls,
		open,
		approve,
		toPhase,
		request,
		observationSha256,
		kernelLock,
		registry,
		stopWorker,
		successorWorker,
		powerOffWorker,
		resumeWorker,
		bootConfigurationWorker,
		bootActivationWorker,
		resetWorker,
		preparePackageInvocation,
		resetPlan,
		recovery,
	};
}

describe("serialized office lifecycle", () => {
	it.each(["boot", "resume"])("forwards paid cancellation diagnosis while retaining the %s phase", async (phase) => {
		const f = await fixture();
		const reason = "OFFICE_PAID_START_ABANDONED";
		if (phase === "boot") {
			await f.toPhase(4);
			f.workers.boot.reconcileSettled.mockResolvedValue({ state: "failed", reason });
		} else {
			await f.toPhase(7);
			await f.open().reconcile(signal());
			const predecessor = { ...f.recovery, action: "reboot" };
			f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: predecessor };
			f.state.resume = {
				schema: "qorpera.lxd-office-resume-plan/v1",
				request: {
					schema: "qorpera.office-boot-intent-request/v1",
					bootIntentId: intentId,
					activationId: allocationId,
					predecessor,
					stopHistorySha256: "a".repeat(64),
					powerOffCompletionSha256: "b".repeat(64),
				},
			};
			await f.open().reconcile(signal());
			await f.open().reconcile(signal());
			f.resumeWorker.reconcileSettled.mockResolvedValue({
				state: "failed",
				reason,
				intentId,
				allocationId,
				bootIntentId: intentId,
				activationId: allocationId,
				startCommandId: intentId,
			});
		}
		for (let i = 0; i < 2; i++)
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "failed", phase, reason });
		expect(f.bootConfigurationWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("drives SQL-admitted idle through the real loop and existing stop workers", async () => {
		const f = await fixture();
		await f.toPhase(7);
		expect((await f.open().reconcile(signal())).state).toBe("active");
		f.state.idle = { ...f.recovery, action: "power_off" };
		expect(await f.open(undefined, undefined, 300000).reconcile(signal())).toMatchObject({
			state: "progressed",
			phase: "service_stop",
		});
		expect(await f.open(undefined, undefined, 300000).reconcile(signal())).toMatchObject({
			state: "powered_off",
			phase: "power_off",
		});
		expect(f.resumeWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledTimes(1);
	});
	it("retained completed protected recovery permits later idle while a fresh operator plan takes precedence", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "service_restart" },
		};
		await f.open(undefined, undefined, 300000).reconcile(signal());
		expect((await f.open(undefined, undefined, 300000).reconcile(signal())).state).toBe("active");
		const idleRequest = { ...f.recovery, action: "power_off", transitionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
		f.state.idle = idleRequest;
		f.stopWorker.reconcileSettled.mockResolvedValueOnce({
			state: "stopped",
			intentId,
			allocationId,
			transitionId: idleRequest.transitionId,
			commandId: intentId,
			acknowledgedAtMs: 3000,
		});
		expect(await f.open(undefined, undefined, 300000).reconcile(signal())).toMatchObject({
			state: "progressed",
			transitionId: idleRequest.transitionId,
		});
		const calls = f.registry.call.mock.calls.filter(
			([method]) => method === "qorpera_reconcile_runtime_office_idle",
		).length;
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "replace", transitionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
		};
		await f.open(undefined, undefined, 300000).reconcile(signal());
		expect(
			f.registry.call.mock.calls.filter(([method]) => method === "qorpera_reconcile_runtime_office_idle"),
		).toHaveLength(calls);
	});
	async function atConfigurationStage() {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		const predecessor = { ...f.recovery, action: "reboot" };
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: predecessor };
		f.state.resume = {
			schema: "qorpera.lxd-office-resume-plan/v1",
			request: {
				schema: "qorpera.office-boot-intent-request/v1",
				bootIntentId: intentId,
				activationId: allocationId,
				predecessor,
				stopHistorySha256: "a".repeat(64),
				powerOffCompletionSha256: "b".repeat(64),
			},
		};
		for (const phase of ["service_stop", "power_off", "resume"])
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase });
		return f;
	}
	it.each(["pending", "unknown", "failed", "awaiting_readiness"] as const)(
		"keeps %s activation after configuration handoff",
		async (state) => {
			const f = await atConfigurationStage();
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({
				state: "progressed",
				phase: "boot_configuration",
			});
			const original = f.bootActivationWorker.reconcileSettled.getMockImplementation()!;
			f.bootActivationWorker.reconcileSettled.mockImplementation(
				async (...args) => ({ ...(await original(...args)), state }) as never,
			);
			for (let i = 0; i < 2; i++)
				await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state, phase: "boot_activation" });
			expect(f.bootConfigurationWorker.reconcileSettled).toHaveBeenCalledOnce();
			expect(f.resumeWorker.reconcileSettled).toHaveBeenCalledOnce();
		},
	);
	it.each(["request", "prepared", "completed"])("refuses a lost activation stage with retained %s", async (kind) => {
		const f = await atConfigurationStage();
		await f.open().reconcile(signal());
		await unlink(join(f.root, `recovery-boot-activation-stage-${allocationId}-${f.recovery.transitionId}.json`));
		await publish(f.root, `boot-successor-${kind}-${allocationId}-${allocationId}.json`, Buffer.from("{}"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.bootConfigurationWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.bootActivationWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("rechecks once after process replacement and avoids repeated active inspections", async () => {
		const f = await atConfigurationStage();
		await f.open().reconcile(signal());
		const active = f.open();
		await expect(active.reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "boot_activation" });
		await expect(active.reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "boot_activation" });
		expect(f.bootActivationWorker.reconcileSettled).toHaveBeenCalledOnce();
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "boot_activation" });
		expect(f.bootActivationWorker.reconcileSettled).toHaveBeenCalledTimes(2);
	});
	it("refuses activation derived from a different configuration observation", async () => {
		const f = await atConfigurationStage();
		await f.open().reconcile(signal());
		const original = f.bootActivationWorker.reconcileSettled.getMockImplementation()!;
		f.bootActivationWorker.reconcileSettled.mockImplementation(async (...args) => ({
			...(await original(...args)),
			configurationObservationSha256: "f".repeat(64),
		}));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it.each(["error", "maintenance"])(
		"reinspects the retained boot after %s interrupts active confirmation",
		async (kind) => {
			const f = await atConfigurationStage();
			await f.open().reconcile(signal());
			const active = f.open();
			await active.reconcile(signal());
			expect(f.bootActivationWorker.reconcileSettled).toHaveBeenCalledOnce();
			const recovery = f.state.recovery;
			if (kind === "error") {
				f.kernelLock.mockRejectedValueOnce(new Error("lock unconfirmed"));
				await expect(active.reconcile(signal())).rejects.toThrow("UNCONFIRMED");
			} else {
				f.state.office = "maintenance";
				f.state.recovery = undefined;
				await expect(active.reconcile(signal())).resolves.toMatchObject({ state: "held" });
				f.state.office = "active";
				f.state.recovery = recovery;
			}
			await expect(active.reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "boot_activation" });
			expect(f.bootActivationWorker.reconcileSettled).toHaveBeenCalledTimes(2);
			expect(f.bootConfigurationWorker.reconcileSettled).toHaveBeenCalledOnce();
		},
	);
	it.each(["pending", "unknown", "failed"] as const)(
		"keeps %s boot configuration on its own forward stage",
		async (state) => {
			const f = await atConfigurationStage(),
				original = f.bootConfigurationWorker.reconcileSettled.getMockImplementation()!;
			f.bootConfigurationWorker.reconcileSettled.mockImplementation(
				async (...args) => ({ ...(await original(...args)), state }) as never,
			);
			for (let i = 0; i < 2; i++)
				await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state, phase: "boot_configuration" });
			expect(f.resumeWorker.reconcileSettled).toHaveBeenCalledOnce();
			expect(f.powerOffWorker.reconcileSettled).toHaveBeenCalledOnce();
		},
	);
	it.each(["intent", "observation", "completed"])(
		"refuses lost configuration stage when later %s evidence survives",
		async (kind) => {
			const f = await atConfigurationStage();
			await unlink(join(f.root, `recovery-configuration-stage-${allocationId}-${f.recovery.transitionId}.json`));
			await publish(f.root, `boot-configuration-${kind}-${allocationId}-${allocationId}.json`, Buffer.from("{}"));
			await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
			expect(f.resumeWorker.reconcileSettled).toHaveBeenCalledOnce();
			expect(f.bootConfigurationWorker.reconcileSettled).not.toHaveBeenCalled();
		},
	);
	it("refuses configuration evidence for a different resumed observation", async () => {
		const f = await atConfigurationStage(),
			original = f.bootConfigurationWorker.reconcileSettled.getMockImplementation()!;
		f.bootConfigurationWorker.reconcileSettled.mockImplementation(async (...args) => ({
			...(await original(...args)),
			bootObservationSha256: "f".repeat(64),
		}));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it.each(["reboot", "power_off"] as const)("advances %s through a separate explicit resume stage", async (action) => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		const predecessor = { ...f.recovery, action };
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: predecessor };
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "service_stop" });
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "powered_off", phase: "power_off" });
		expect(f.resumeWorker.reconcileSettled).not.toHaveBeenCalled();
		const request = {
			schema: "qorpera.office-boot-intent-request/v1",
			bootIntentId: intentId,
			activationId: allocationId,
			predecessor,
			stopHistorySha256: "a".repeat(64),
			powerOffCompletionSha256: "b".repeat(64),
		};
		f.state.resume = { schema: "qorpera.lxd-office-resume-plan/v1", request };
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "power_off" });
		const stops = f.powerOffWorker.reconcileSettled.mock.calls.length;
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "resume" });
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({
			state: "progressed",
			phase: "boot_configuration",
		});
		for (let i = 0; i < 2; i++)
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({
				state: "active",
				phase: "boot_activation",
				activationId: allocationId,
			});
		expect(f.resumeWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.bootConfigurationWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.bootActivationWorker.reconcileSettled).toHaveBeenCalledTimes(2);
		expect(f.powerOffWorker.reconcileSettled).toHaveBeenCalledTimes(stops);
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
		f.state.resume = undefined;
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		expect(f.powerOffWorker.reconcileSettled).toHaveBeenCalledTimes(stops);
	});
	it("refuses a missing resume stage after VM start identity has been persisted", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "reboot" },
		};
		await f.open().reconcile(signal());
		await publish(f.root, `resume-request-${allocationId}-${f.recovery.transitionId}.json`, Buffer.from("{}"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		expect(f.powerOffWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.resumeWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("advances explicit power-off after stop and recovers without reading the stopped guest", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "power_off" },
		};
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "service_stop" });
		for (let n = 0; n < 2; n++)
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({
				state: "powered_off",
				phase: "power_off",
			});
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.powerOffWorker.reconcileSettled).toHaveBeenCalledTimes(2);
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("holds a stopped replace without a protected reset plan and never dispatches the reset worker", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: f.recovery };
		for (let n = 0; n < 2; n++)
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "held", phase: "service_stop" });
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledTimes(2);
		expect(f.resetWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.powerOffWorker.reconcileSettled).not.toHaveBeenCalled();
		// A plan for a different predecessor grants nothing either.
		f.state.reset = f.resetPlan({ ...f.recovery, transitionId: allocationId });
		await expect(f.open().reconcile(signal())).rejects.toSatisfy(
			(error: Error) =>
				error.message === "OFFICE_LIFECYCLE_UNCONFIRMED" &&
				(error.cause as Error).message === "OFFICE_RESET_PLAN_PREDECESSOR_DIFFERS",
		);
		f.state.reset = f.resetPlan({ ...f.recovery, action: "reboot" });
		await expect(f.open().reconcile(signal())).rejects.toSatisfy(
			(error: Error) =>
				error.message === "OFFICE_LIFECYCLE_UNCONFIRMED" &&
				(error.cause as Error).message === "INVALID_OFFICE_RESET_PLAN",
		);
		expect(f.resetWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("advances a stopped replace into the governed reset under a protected plan and caches only active", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: f.recovery };
		f.state.reset = f.resetPlan(f.recovery);
		f.resetWorker.result = { state: "held", phase: "stopped", reason: "OFFICE_RESET_OUTBOX_REMNANT" };
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "service_stop" });
		const plan = f.resetPlan(f.recovery);
		await expect(
			f.open("/protected/image-manifest.json", "/protected/package-lane.json").reconcile(signal()),
		).resolves.toEqual({
			state: "held",
			phase: "reset",
			intentId,
			transitionId: f.recovery.transitionId,
			activationId: plan.successorActivationId,
			resetId: plan.resetId,
			resetPhase: "stopped",
			reason: "OFFICE_RESET_OUTBOX_REMNANT",
		});
		expect(f.resetWorker.reconcileSettled).toHaveBeenLastCalledWith(
			{
				intentId,
				plan,
				planSha256: officeDigest(plan),
				serviceBootstrapPath: f.request.serviceBootstrapPath,
				imagePackageManifestPath: "/protected/image-manifest.json",
				codePackageLanePath: "/protected/package-lane.json",
			},
			expect.any(AbortSignal),
		);
		f.resetWorker.result = { state: "active", phase: "active" };
		const lifecycle = f.open();
		await expect(lifecycle.reconcile(signal())).resolves.toMatchObject({
			state: "active",
			phase: "reset",
			resetPhase: "active",
			resetId: plan.resetId,
		});
		await expect(lifecycle.reconcile(signal())).resolves.toMatchObject({ state: "active", resetPhase: "active" });
		expect(f.resetWorker.reconcileSettled).toHaveBeenCalledTimes(2);
		await f.open().reconcile(signal());
		expect(f.resetWorker.reconcileSettled).toHaveBeenCalledTimes(3);
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
		// A result for another reset identity is never accepted.
		f.resetWorker.reconcileSettled.mockResolvedValueOnce({
			state: "active",
			phase: "active",
			intentId,
			allocationId,
			resetId: plan.rootIncarnationId,
			transitionId: f.recovery.transitionId,
			activationId: plan.successorActivationId,
		});
		await expect(f.open().reconcile(signal())).rejects.toSatisfy(
			(error: Error) =>
				error.message === "OFFICE_LIFECYCLE_UNCONFIRMED" &&
				(error.cause as Error).message === "reset result differs",
		);
	});
	it("refuses a lost power-off forward stage instead of rerunning service shutdown", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "power_off" },
		};
		await publish(f.root, `power-off-request-${allocationId}-${f.recovery.transitionId}.json`, Buffer.from("{}"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		expect(f.stopWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.powerOffWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("holds restart before dispatch when retained package discovery is unconfirmed", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "service_restart" },
		};
		await f.open().reconcile(signal());
		f.preparePackageInvocation.mockRejectedValue(new Error("package history unavailable"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("prepares package staging before restart worker and disposes it after settlement", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "service_restart" },
		};
		await f.open().reconcile(signal());
		const dispose = vi.fn();
		f.preparePackageInvocation.mockResolvedValue({ measure: vi.fn(), dispose });
		await f.open().reconcile(signal());
		expect(f.preparePackageInvocation.mock.invocationCallOrder[0]).toBeLessThan(
			f.successorWorker.reconcileSettled.mock.invocationCallOrder[0]!,
		);
		expect(dispose).toHaveBeenCalledOnce();
	});
	it("holds reboot activation before dispatch when retained package discovery is unconfirmed", async () => {
		const f = await atConfigurationStage();
		await f.open().reconcile(signal());
		f.preparePackageInvocation.mockRejectedValue(new Error("package history unavailable"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.bootActivationWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("advances stop to restart once, holds disabled restart, and reinspects only after process recovery", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		const request = { ...f.recovery, action: "service_restart" };
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request };
		f.state.enabled = false;
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "progressed", phase: "service_stop" });
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
		f.state.enabled = true;
		const lifecycle = f.open();
		await expect(lifecycle.reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "service_restart" });
		await lifecycle.reconcile(signal());
		expect(f.successorWorker.reconcileSettled).toHaveBeenCalledTimes(2);
		await f.open().reconcile(signal());
		expect(f.successorWorker.reconcileSettled).toHaveBeenCalledTimes(3);
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
	});
	it("refuses a lost forward recovery stage after successor preparation", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "service_restart" },
		};
		await publish(f.root, `successor-request-${allocationId}-${f.recovery.transitionId}.json`, Buffer.from("{}"));
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.stopWorker.reconcileSettled).not.toHaveBeenCalled();
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("keeps the supervisor slot until a cancelled successor worker settles", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...f.recovery, action: "service_restart" },
		};
		await f.open().reconcile(signal());
		let release!: () => void, enter!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const original = f.successorWorker.reconcileSettled.getMockImplementation()!;
		f.successorWorker.reconcileSettled.mockImplementationOnce(async () => {
			enter();
			await blocked;
			return original();
		});
		const abort = new AbortController();
		const result = f.open().reconcile(abort.signal);
		await entered;
		abort.abort();
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_PENDING");
		release();
		await expect(result).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		await expect(f.open().reconcile(signal())).resolves.toMatchObject({ state: "active", phase: "service_restart" });
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
	});
	it("refuses a changed recovery request after the forward stop stage", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		const request = { ...f.recovery, action: "service_restart" };
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request };
		await f.open().reconcile(signal());
		f.state.recovery = {
			schema: "qorpera.lxd-office-recovery-plan/v1",
			request: { ...request, startup: { ...request.startup, serviceInvocationId: "f".repeat(32) } },
		};
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledOnce();
		expect(f.successorWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("runs only explicit recovery from active or maintenance, including disabled preparation", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: f.recovery };
		f.state.enabled = false;
		const previous = [...f.calls];
		for (let i = 0; i < 2; i++)
			await expect(f.open().reconcile(signal())).resolves.toMatchObject({
				state: "held",
				phase: "service_stop",
				transitionId: f.recovery.transitionId,
				acknowledgedAtMs: 2000,
			});
		expect(f.calls).toEqual([...previous, "stop", "stop"]);
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledWith(intentId, f.recovery, expect.any(AbortSignal));
		f.state.recovery = undefined;
		await expect(f.open().reconcile(signal())).resolves.toEqual({ state: "held", intentId });
		expect(f.stopWorker.reconcileSettled).toHaveBeenCalledTimes(2);
	});
	it.each(["unactivated", "allocation", "schema"])("refuses recovery with %s authority", async (fault) => {
		const f = await fixture();
		await f.toPhase(7);
		if (fault !== "unactivated") await f.open().reconcile(signal());
		f.state.recovery = {
			schema: fault === "schema" ? "unrecognized" : "qorpera.lxd-office-recovery-plan/v1",
			request:
				fault === "allocation"
					? { ...f.recovery, startup: { ...f.recovery.startup, allocationId: intentId } }
					: f.recovery,
		};
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
		expect(f.stopWorker.reconcileSettled).not.toHaveBeenCalled();
	});
	it("keeps the supervisor slot until a cancelled stop worker settles", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await f.open().reconcile(signal());
		f.state.recovery = { schema: "qorpera.lxd-office-recovery-plan/v1", request: f.recovery };
		let release!: () => void, enter!: () => void;
		const blocked = new Promise<void>((resolve) => {
				release = resolve;
			}),
			entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
		const original = f.stopWorker.reconcileSettled.getMockImplementation()!;
		f.stopWorker.reconcileSettled.mockImplementationOnce(async () => {
			enter();
			await blocked;
			return original();
		});
		const abort = new AbortController(),
			pending = f.open().reconcile(abort.signal);
		await entered;
		abort.abort();
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_PENDING");
		release();
		await expect(pending).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
	});
	it("restarts between every phase, waits for protected review, and never replays earlier phases after active", async () => {
		const f = await fixture();
		await f.toPhase(2);
		f.state.plan = undefined;
		for (let i = 0; i < 3; i++)
			expect(await f.open().reconcile(signal())).toMatchObject({
				state: "awaiting_review",
				observationSha256: f.observationSha256,
			});
		expect(f.calls).toEqual(["creation", "inventory"]);
		f.approve();
		for (let i = 2; i < 7; i++) expect((await f.open().reconcile(signal())).state).toBe("progressed");
		const service = f.open();
		expect((await service.reconcile(signal())).state).toBe("active");
		f.state.enabled = false;
		for (let i = 0; i < 4; i++) expect((await service.reconcile(signal())).state).toBe("active");
		expect(f.calls).toEqual([
			"creation",
			"inventory",
			"adoption",
			"boot",
			"preparation",
			"configuration",
			"activation",
		]);
		expect((await f.open().reconcile(signal())).state).toBe("active");
		expect(f.calls.filter((v) => v === "activation")).toHaveLength(2);
	});
	it.each([0, 1, 2, 3, 4, 5, 6, 7])(
		"refuses a missing phase %i without dispatching an earlier worker",
		async (index) => {
			const f = await fixture();
			await f.toPhase(7);
			await unlink(join(f.root, `lifecycle-${intentId}-${index}.json`));
			// Losing only the final activation fence could otherwise replay configuration.
			if (index === 7) f.state.office = "active";
			const before = [...f.calls];
			await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_UNCONFIRMED");
			expect(f.calls).toEqual(before);
		},
	);
	it.each(["cancelled", "disabled", "maintenance", "retired"])(
		"holds %s without starting any phase or releasing capacity",
		async (kind) => {
			const f = await fixture();
			await f.toPhase(4);
			if (kind === "cancelled") f.state.intent = kind;
			else if (kind === "disabled") f.state.enabled = false;
			else f.state.office = kind;
			const before = [...f.calls];
			expect((await f.open().reconcile(signal())).state).toBe("held");
			expect(f.calls).toEqual(before);
			expect(f.state.reservation).not.toBeNull();
		},
	);
	it("does not create demand, and requires the actual kernel-lock port even while idle", async () => {
		const f = await fixture();
		f.state.intent = null;
		expect(await f.open().reconcile(signal())).toEqual({ state: "idle" });
		expect(f.calls).toEqual([]);
		f.state.kernel = false;
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
	});
	it("retains the process-wide slot across cancellation and replacement objects until worker settlement", async () => {
		const f = await fixture();
		let release!: () => void, entered!: () => void;
		const started = new Promise<void>((r) => {
			entered = r;
		});
		const stopped = new Promise<void>((r) => {
			release = r;
		});
		f.workers.creation.reconcileSettled = vi.fn(async () => {
			entered();
			await stopped;
			throw new Error("cancelled");
		});
		const controller = new AbortController();
		let settled = false;
		const run = f
			.open()
			.reconcile(controller.signal)
			.catch(() => {
				settled = true;
			});
		await started;
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		await expect(f.open().reconcile(signal())).rejects.toThrow("OFFICE_LIFECYCLE_PENDING");
		release();
		await run;
		f.state.intent = null;
		expect(await f.open().reconcile(signal())).toEqual({ state: "idle" });
	});
	it.each(["pending", "unknown", "failed"])("keeps %s in the original phase after restart", async (state) => {
		const f = await fixture();
		await f.toPhase(4);
		f.workers.boot.reconcileSettled = vi.fn(async () => ({ state }));
		for (let i = 0; i < 2; i++) expect(await f.open().reconcile(signal())).toMatchObject({ phase: "boot", state });
		expect(f.calls).toEqual(["creation", "inventory", "adoption"]);
	});
	it("pins the operator request and refuses replacement before activation", async () => {
		const f = await fixture();
		await f.toPhase(7);
		f.request.serviceBootstrapPath = "/protected/replaced.json";
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.calls).not.toContain("activation");
	});
	it("refuses phase rollback while SQL is still provisioning but service dispatch already exists", async () => {
		const f = await fixture();
		await f.toPhase(7);
		await publish(f.root, `activation-request-${allocationId}.json`, Buffer.from("{}"));
		await unlink(join(f.root, `lifecycle-${intentId}-7.json`));
		const before = [...f.calls];
		await expect(f.open().reconcile(signal())).rejects.toThrow("UNCONFIRMED");
		expect(f.calls).toEqual(before);
	});
	it("writes the next phase before dispatch and retains that phase after a lost response", async () => {
		const f = await fixture();
		await f.toPhase(7);
		f.workers.activation.reconcileSettled = vi.fn(async () => {
			const record = JSON.parse(await readFile(join(f.root, `lifecycle-${intentId}-7.json`), "utf8"));
			expect(record.phase).toBe("activation");
			f.state.office = "active";
			throw new Error("lost committed reply, secret");
		});
		await expect(f.open().reconcile(signal())).rejects.toThrow(/^OFFICE_LIFECYCLE_UNCONFIRMED$/);
		f.workers.activation.reconcileSettled = vi.fn(async () => ({ state: "active" }));
		expect((await f.open().reconcile(signal())).state).toBe("active");
		expect(f.calls.filter((phase) => phase === "configuration")).toHaveLength(1);
	});
	it("does not overlap ticks or exit before a cancelled worker settles", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const block = new Promise<void>((r) => {
			release = r;
		});
		const controller = new AbortController();
		const reconcile = vi.fn(async () => {
			await block;
			return { state: "idle" as const };
		});
		let finished = false;
		const onResult = vi.fn();
		const run = runLxdOfficeLifecycle({ reconcile }, controller.signal, onResult, vi.fn()).then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(60000);
		expect(reconcile).toHaveBeenCalledTimes(1);
		controller.abort();
		await Promise.resolve();
		expect(finished).toBe(false);
		release();
		await run;
		expect(onResult).not.toHaveBeenCalled();
	});
	it("continues reconciliation when result and failure observers throw or reject", async () => {
		vi.useRealTimers();
		const controller = new AbortController();
		const reconcile = vi
			.fn()
			.mockResolvedValueOnce({ state: "active" })
			.mockRejectedValueOnce(new Error("worker unavailable"))
			.mockResolvedValue({ state: "idle" });
		const onResult = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("sink failed");
			})
			.mockImplementation(() => {
				controller.abort();
				return Promise.reject(new Error("sink rejected"));
			});
		const onError = vi.fn(() => {
			throw new Error("error sink failed");
		});
		const run = runLxdOfficeLifecycle({ reconcile }, controller.signal, onResult, onError, 1000);
		await run;
		expect(reconcile).toHaveBeenCalledTimes(3);
		expect(onResult).toHaveBeenCalledTimes(2);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
