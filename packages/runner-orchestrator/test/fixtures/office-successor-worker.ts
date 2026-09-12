import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CompanyComputerServiceSoftwarePlan,
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerServiceRestartCompletion,
	parseCompanyComputerServiceRestartRequest,
	parseCompanyComputerServiceSuccessorRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import type { LxdOfficeInvocationMeasurement } from "../../src/lxd-office-invocation-measurement.ts";
import { LxdOfficeSuccessorWorker } from "../../src/lxd-office-successor-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";
import { officeStopWorkerFixture } from "./office-stop-worker.ts";

export async function officeSuccessorWorkerFixture(roots: string[]) {
	const f = await officeStopWorkerFixture(roots);
	await f.worker.reconcile(f.activation.request.intentId, f.request, new AbortController().signal);
	const state = {
		current: undefined as CompanyComputerServiceSuccessor | undefined,
		enabled: true,
		physical: true,
		ready: true,
		preparations: 0,
		activations: 0,
	};
	const seed = join(f.root, `successor-request-${f.binding.allocationId}-${f.request.transitionId}.json`);
	const prepared = join(f.root, `successor-prepared-${f.binding.allocationId}-${f.request.transitionId}.json`);
	const registry = vi.fn<ConstructorParameters<typeof LxdOfficeSuccessorWorker>[1]["call"]>(
		async (method, args, signal) => {
			signal.throwIfAborted();
			const request = parseCompanyComputerServiceSuccessorRequest(args.p_request);
			expect(JSON.parse(await readFile(seed, "utf8")).request).toEqual(request);
			if (method === "qorpera_prepare_runtime_office_successor" && !state.current) {
				if (!state.enabled) throw new Error("disabled");
				state.preparations++;
				state.current = {
					schema: "qorpera.office-service-successor/v1",
					request,
					state: "prepared",
					serviceInvocationId: null,
					readinessFresh: false,
					stopAcknowledgedAtMs: 2000,
					officeRevision: 13,
					privacyVersion: 11,
					validForMs: 5000,
				};
			}
			if (!state.current) throw new Error("not prepared");
			expect(state.current.request).toEqual(request);
			if (method === "qorpera_check_runtime_office_successor" && !state.enabled)
				throw new Error("authority unavailable");
			if (method === "qorpera_activate_runtime_office_successor") {
				if (!state.enabled || state.current.state === "prepared" || !state.current.readinessFresh)
					throw new Error("not ready");
				expect(args.p_service_invocation_id).toBe(state.current.serviceInvocationId);
				if (state.current.state !== "active") state.activations++;
				state.current = { ...state.current, state: "active" };
			}
			return structuredClone(state.current);
		},
	);
	let staged: Buffer | undefined;
	const stage = vi
		.spyOn(f.client, "pushOfficeServiceRestartRequest")
		.mockImplementation(async (_p, _n, _hash, bytes) => {
			staged = Buffer.from(bytes);
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeServiceRestartRequest")
		.mockImplementation(async () => ({ uid: 0, gid: 0, mode: 0o400, content: Buffer.from(staged!) }));
	const exec = vi
		.spyOn(f.client, "submitOfficeServiceRestart")
		.mockImplementation(async (project, instanceName, command) => {
			const request = parseCompanyComputerServiceRestartRequest(JSON.parse(staged!.toString()));
			expect(state.current?.state).toBe("prepared");
			expect(
				JSON.parse(
					await readFile(
						join(
							f.root,
							`service-restart-${f.binding.allocationId}-${request.start.attestation.activationId}`,
							"000000.json",
						),
						"utf8",
					),
				).kind,
			).toBe("dispatch");
			if (state.physical) {
				const completion = parseCompanyComputerServiceRestartCompletion(
					{
						schema: "qorpera.office-service-start-completion/v1",
						command,
						activationId: request.start.attestation.activationId,
						configurationCompletionSha256: request.start.configurationCompletionSha256,
						configurationSha256: request.start.attestation.configurationSha256,
						serviceInvocationId: "c".repeat(32),
						mainPid: 700,
						controlGroup: "/system.slice/qorpera-company-computer.service",
					},
					command,
					request,
				);
				f.guest.set(`/run/qorpera-office-preparation/service-restart-completion-${completion.activationId}.json`, {
					uid: 0,
					gid: 0,
					mode: 0o600,
					content: Buffer.from(JSON.stringify(completion)),
				});
				if (state.ready)
					state.current = {
						...state.current!,
						state: "ready",
						readinessFresh: true,
						serviceInvocationId: completion.serviceInvocationId,
					};
			}
			return { project, instanceName, operationId: id(95) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeServiceRestart").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeServiceRestartInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			const activationId = state.current!.request.attestation.activationId;
			const start = JSON.parse(
				f.guest
					.get(`/run/qorpera-office-preparation/service-restart-completion-${activationId}.json`)!
					.content.toString(),
			);
			f.guest.set(`/run/qorpera-office-preparation/service-restart-inspection-${inspectionId}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o600,
				content: Buffer.from(
					JSON.stringify({ schema: "qorpera.office-service-inspection/v1", inspectionId, start }),
				),
			});
			return { project, instanceName, operationId: id(96) };
		});
	const create = (
		ports: {
			softwarePlan?: CompanyComputerServiceSoftwarePlan;
			measureInvocation?: LxdOfficeInvocationMeasurement;
		} = {},
	) =>
		new LxdOfficeSuccessorWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{ client: f.client, kernelLock: f.kernelLock, ...ports },
		);
	const paths = () => {
		const suffix = `${f.binding.allocationId}-${state.current!.request.attestation.activationId}`;
		return {
			seed,
			prepared,
			packet: join(f.root, `service-restart-request-${suffix}.json`),
			index: join(f.root, `service-restart-intent-${suffix}.json`),
			journal: join(f.root, `service-restart-${suffix}`),
			completion: join(f.root, `successor-completed-${suffix}.json`),
		};
	};
	return { ...f, stop: f, state, registry, stage, readStage, exec, poll, inspect, create, worker: create(), paths };
}
