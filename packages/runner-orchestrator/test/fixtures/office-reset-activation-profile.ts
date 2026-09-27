import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CompanyComputerResetServiceStartCompletion } from "@qorpera/contracts";
import { expect, vi } from "vitest";
import type { LxdOfficeCodePackageRegistry } from "../../src/lxd-office-code-package-control.ts";
import { LxdOfficeCodePackageProvisionLane } from "../../src/lxd-office-code-package-provision-lane.ts";
import { officeCanonical } from "../../src/lxd-office-image-provenance.ts";
import { createLxdOfficeResetSuccessorLane } from "../../src/lxd-office-reset-successor-lane.ts";
import { LxdOfficeResetWorker, type LxdOfficeResetWorkerRegistry } from "../../src/lxd-office-reset-worker.ts";
import { officeCodePackagePipelineFixture } from "./office-code-package-pipeline.ts";
import { officeResetWorkerFixture } from "./office-reset-worker.ts";

const packageMethods = new Set<Parameters<LxdOfficeCodePackageRegistry["call"]>[0]>([
	"qorpera_enroll_office_package_provision",
	"qorpera_check_office_package_provision",
	"qorpera_check_office_package_provision_observation",
	"qorpera_ack_office_package_provision",
	"qorpera_office_package_provision_status",
	"qorpera_check_office_package_invocation",
	"qorpera_ack_office_package_invocation",
]);
type Stage = { stage: string; atMs: number; elapsedMs: number; gateRemainingMs: number | null; aborted: boolean };

/** Production reset worker, typed nonce inspector, package lane/control and
 * durable journals. Only physical host/LXD/guest/SQL transports are synthetic.
 * The preparation antecedent is untimed. The final attempt uses real monotonic
 * five-second gate leases and bounded cancellable transport/guest delays. */
export async function officeResetActivationProfile(roots: string[]) {
	const f = await officeResetWorkerFixture(roots);
	const pipeline = await officeCodePackagePipelineFixture(f.packageMaterial);
	let active = false;
	let started = 0;
	let gateDeadline: number | null = null;
	let outstanding = 0;
	let peak = 0;
	let completion: CompanyComputerResetServiceStartCompletion | undefined;
	let onStage: ((stage: string) => void) | undefined;
	let delayScale: 1 | 0.25 = 1;
	const stages: Stage[] = [];
	const counts: Record<string, number> = {};
	const note = (stage: string, at: number, signal: AbortSignal) => {
		if (!active) return;
		counts[stage] = (counts[stage] ?? 0) + 1;
		stages.push({
			stage,
			atMs: Math.round(at - started),
			elapsedMs: Math.round(performance.now() - at),
			gateRemainingMs: gateDeadline === null ? null : Math.round(gateDeadline - performance.now()),
			aborted: signal.aborted,
		});
	};
	const timed = async <T>(stage: string, milliseconds: number, signal: AbortSignal, run: () => Promise<T>) => {
		const at = performance.now();
		outstanding++;
		peak = Math.max(peak, outstanding);
		try {
			if (active) onStage?.(stage);
			signal.throwIfAborted();
			if (active && milliseconds) await delay(Math.ceil(milliseconds * delayScale), undefined, { signal });
			const value = await run();
			signal.throwIfAborted();
			return value;
		} finally {
			outstanding--;
			note(stage, at, signal);
		}
	};
	const check = async (...args: Parameters<LxdOfficeResetWorkerRegistry["call"]>) => {
		const [method, params, signal] = args;
		return timed(`sql:${method}`, 100, signal, async () => {
			if (packageMethods.has(method as Parameters<LxdOfficeCodePackageRegistry["call"]>[0])) {
				const result = await pipeline.registry.call(
					method as Parameters<LxdOfficeCodePackageRegistry["call"]>[0],
					params,
					signal,
				);
				if (method === "qorpera_enroll_office_package_provision") f.registry.state.packageEnrolled = true;
				if (method === "qorpera_ack_office_package_provision") f.registry.state.packageInstalled = true;
				if (method === "qorpera_ack_office_package_invocation") f.registry.state.packageMeasured = true;
				return result;
			}
			return f.registry.call(method, params, signal);
		});
	};
	vi.spyOn(f.client, "discoverOfficeCodePackage").mockImplementation(pipeline.client.discoverOfficeCodePackage);
	vi.spyOn(f.client, "pushOfficeCodePackageDirectory").mockImplementation((...args) =>
		timed("package:directory", 20, args[4], () => pipeline.client.pushOfficeCodePackageDirectory(...args)),
	);
	vi.spyOn(f.client, "pushOfficeCodePackageFile").mockImplementation((...args) =>
		timed(
			args[3].startsWith("challenge-") ? "package:challenge-push" : "package:stage-push",
			args[3].startsWith("challenge-") ? 100 : 20,
			args[5],
			() => pipeline.client.pushOfficeCodePackageFile(...args),
		),
	);
	vi.spyOn(f.client, "readOfficeCodePackageFile").mockImplementation((...args) =>
		timed(
			args[3].startsWith("probe-") || args[3].startsWith("invocation-")
				? "package:result-read"
				: "package:stage-read",
			args[3].startsWith("probe-") || args[3].startsWith("invocation-") ? 100 : 20,
			args[5],
			() => pipeline.client.readOfficeCodePackageFile(...args),
		),
	);
	vi.spyOn(f.client, "readOfficeCodePackageReceipt").mockImplementation((...args) =>
		timed("package:receipt-read", 20, args[4], () => pipeline.client.readOfficeCodePackageReceipt(...args)),
	);
	vi.spyOn(f.client, "submitOfficeCodePackageTool").mockImplementation((...args) =>
		timed(`package:exec:${args[5][0]}`, 1500, args[6], () => pipeline.client.submitOfficeCodePackageTool(...args)),
	);
	vi.spyOn(f.client, "inspectOfficeCodePackageTool").mockImplementation((...args) =>
		timed("package:poll", 100, args[1], () => pipeline.client.inspectOfficeCodePackageTool(...args)),
	);

	const read = vi.spyOn(f.client, "readInstanceFile"),
		originalRead = read.getMockImplementation()!;
	read.mockImplementation((...args) =>
		timed("guest:read", 100, args[4] ?? new AbortController().signal, () => originalRead(...args)),
	);
	const originalGet = f.get.getMockImplementation()!;
	f.get.mockImplementation((...args) =>
		timed("guest:instance", 100, args[2] ?? new AbortController().signal, () => originalGet(...args)),
	);
	vi.spyOn(f.client, "submitOfficeResetServiceInspection").mockImplementation(
		(project, instanceName, command, inspectionId, signal) =>
			timed("inspection:exec", 200, signal ?? new AbortController().signal, async () => {
				if (!completion) throw new Error("profile completion missing");
				expect(command).toEqual(completion.command);
				f.guest.set(`/run/qorpera-office-preparation/reset-service-inspection-${inspectionId}.json`, {
					content: Buffer.from(
						officeCanonical({
							schema: "qorpera.office-reset-service-inspection/v1",
							inspectionId,
							start: completion,
						}),
					),
					uid: 0,
					gid: 0,
					mode: 0o600,
				});
				return { project, instanceName, operationId: randomUUID() };
			}),
	);
	vi.spyOn(f.client, "inspectOfficeResetServiceStart").mockImplementation((_reference, signal) =>
		timed("inspection:poll", 100, signal ?? new AbortController().signal, async () => "succeeded" as const),
	);
	const originalGate = f.check.getMockImplementation()!;
	const gate = async (
		binding: Parameters<ConstructorParameters<typeof LxdOfficeResetWorker>[0]["check"]>[0],
		caller: AbortSignal,
	) => {
		const at = performance.now();
		const authority = AbortSignal.any([caller, AbortSignal.timeout(5000)]);
		gateDeadline = at + 5000;
		return timed("physical:gate", 200, authority, async () => {
			expect(binding).toEqual(f.binding);
			const value = await originalGate();
			return { ...value, signal: authority, validForMs: Math.floor(at + 5000 - performance.now()) };
		});
	};
	const originalNas = f.nasCustody.getMockImplementation()!;
	const nasCustody = async (...args: Parameters<typeof originalNas>) => {
		const nas = await originalNas(...args);
		return { ...nas, verify: () => timed("physical:nas", 100, new AbortController().signal, nas.verify) };
	};
	const transportLane = createLxdOfficeResetSuccessorLane(f.root, f.client);
	const run = (caller: AbortSignal = new AbortController().signal, settle = false) =>
		new LxdOfficeResetWorker(
			{ policy: f.policy, check: gate },
			{ call: check },
			{
				client: f.client,
				kernelLock: f.kernelLock,
				readProtected: f.readProtected,
				readCredential: f.readCredential,
				readManifest: f.packageMaterial.ports.readManifest,
				readArtifact: f.packageMaterial.ports.readArtifact,
				nasCustody,
				successorLane: {
					configure: f.lane.configure,
					start: async (input, signal) => {
						completion = await f.lane.start(input, signal);
						return completion;
					},
					inspect: (input, signal) =>
						timed("stage:inspection", 0, signal, () => transportLane.inspect(input, signal)),
				},
				codePackageLane: (options) => {
					const lane = new LxdOfficeCodePackageProvisionLane(options);
					return {
						enroll: (signal) => lane.enroll(signal),
						ensure: (context, signal, authorize) =>
							timed("stage:ensure", 0, signal, () => lane.ensure(context, signal, authorize)),
						prepareInvocation: (packet, original, signal) =>
							timed("stage:staging", 0, signal, () => lane.prepareInvocation(packet, original, signal)),
						measureInvocation: (pins, activationId, startup, deadline, signal) =>
							timed("stage:measurement", 0, signal, () =>
								lane.measureInvocation(pins, activationId, startup, deadline, signal),
							),
					};
				},
			},
		)[settle ? "reconcileSettled" : "reconcile"](f.input, caller);
	return {
		f,
		pipeline,
		run,
		async prepare() {
			for (let count = 0; count < 10 && f.registry.state.phase !== "prepared"; count++) await run();
			expect(f.registry.state.phase).toBe("prepared");
		},
		arm(stageCallback?: (stage: string) => void, scale: 1 | 0.25 = 1) {
			active = true;
			started = performance.now();
			gateDeadline = null;
			onStage = stageCallback;
			delayScale = scale;
			stages.length = 0;
			peak = 0;
		},
		profile: () => ({
			delayScale,
			elapsedMs: Math.round(performance.now() - started),
			outstanding,
			peak,
			counts,
			stages,
			resetState: f.registry.state.phase,
			packageMeasured: f.registry.state.packageMeasured,
			activationCalls: f.registry.state.calls.filter(
				(method) => method === "qorpera_activate_runtime_office_reset_successor",
			).length,
		}),
	};
}
