import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CompanyComputerServiceSuccessor,
	parseCompanyComputerBootServiceRestartCompletion,
	parseCompanyComputerBootServiceRestartRequest,
	parseCompanyComputerServiceSuccessorRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeSuccessorWorker } from "../../src/lxd-office-successor-worker.ts";
import { officeBootStopWorkerFixture } from "./office-boot-stop-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";

export async function officeBootSuccessorWorkerFixture(roots: string[]) {
	const f = await officeBootStopWorkerFixture(roots);
	await f.run();
	return createOfficeBootSuccessorWorkerFixture(f);
}

type BootSuccessorFixture = Pick<
	Awaited<ReturnType<typeof officeBootStopWorkerFixture>>,
	"root" | "binding" | "request" | "guest" | "client" | "policy" | "check" | "kernelLock"
> & { activation: { input: { intentId: string }; paths: { completion: string } } };

export async function createOfficeBootSuccessorWorkerFixture<T extends BootSuccessorFixture>(f: T) {
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
		.spyOn(f.client, "pushOfficeBootServiceRestartRequest")
		.mockImplementation(async (_p, _n, _hash, bytes) => {
			staged = Buffer.from(bytes);
			f.guest.set(`/run/qorpera-office-preparation/boot-service-restart-incoming-${_hash}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o400,
				content: Buffer.from(bytes),
			});
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeBootServiceRestartRequest")
		.mockImplementation(async () => ({ uid: 0, gid: 0, mode: 0o400, content: Buffer.from(staged!) }));
	const exec = vi
		.spyOn(f.client, "submitOfficeBootServiceRestart")
		.mockImplementation(async (project, instanceName, command) => {
			const request = parseCompanyComputerBootServiceRestartRequest(JSON.parse(staged!.toString()));
			expect(state.current?.state).toBe("prepared");
			expect(
				JSON.parse(
					await readFile(
						join(
							f.root,
							`boot-service-restart-${f.binding.allocationId}-${request.successor.request.attestation.activationId}`,
							"000000.json",
						),
						"utf8",
					),
				).kind,
			).toBe("dispatch");
			if (state.physical) {
				f.guest.set(
					`/run/qorpera-office-preparation/service-successor-${request.stop.revocation.request.activationId}.json`,
					{
						uid: 0,
						gid: 0,
						mode: 0o600,
						content: Buffer.from(
							JSON.stringify({
								schema: "qorpera.office-boot-service-successor-claim/v1",
								command,
								...(request.origin.schema === "qorpera.office-outage-service-start-request/v1"
									? { recoveryId: request.origin.successor.request.recovery.recoveryId }
									: { bootIntentId: request.origin.successor.request.bootIntentId }),
								originActivationId: request.origin.successor.request.attestation.activationId,
								activationId: request.successor.request.attestation.activationId,
								predecessorActivationId: request.stop.revocation.request.activationId,
								stopCompletionSha256: request.stopCompletionSha256,
							}),
						),
					},
				);
				const completion = parseCompanyComputerBootServiceRestartCompletion(
					{
						schema: "qorpera.office-boot-service-restart-completion/v1",
						...(request.origin.schema === "qorpera.office-outage-service-start-request/v1"
							? { recoveryId: request.origin.successor.request.recovery.recoveryId }
							: { bootIntentId: request.origin.successor.request.bootIntentId }),
						originActivationId: request.origin.successor.request.attestation.activationId,
						command,
						activationId: request.successor.request.attestation.activationId,
						configurationCompletionSha256: request.origin.configurationCompletionSha256,
						configurationSha256: request.successor.request.attestation.configurationSha256,
						serviceInvocationId: "d".repeat(32),
						mainPid: 700,
						controlGroup: "/system.slice/qorpera-company-computer.service",
					},
					command,
					request,
				);
				f.guest.set(
					`/run/qorpera-office-preparation/boot-service-restart-completion-${completion.activationId}.json`,
					{
						uid: 0,
						gid: 0,
						mode: 0o600,
						content: Buffer.from(JSON.stringify(completion)),
					},
				);
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
	const poll = vi.spyOn(f.client, "inspectOfficeBootServiceRestart").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeBootServiceRestartInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			const activationId = state.current!.request.attestation.activationId;
			const start = JSON.parse(
				f.guest
					.get(`/run/qorpera-office-preparation/boot-service-restart-completion-${activationId}.json`)!
					.content.toString(),
			);
			f.guest.set(`/run/qorpera-office-preparation/boot-service-restart-inspection-${inspectionId}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o600,
				content: Buffer.from(
					JSON.stringify({ schema: "qorpera.office-boot-service-restart-inspection/v1", inspectionId, start }),
				),
			});
			return { project, instanceName, operationId: id(96) };
		});
	const create = () =>
		new LxdOfficeSuccessorWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{ client: f.client, kernelLock: f.kernelLock },
		);
	const paths = () => {
		const suffix = `${f.binding.allocationId}-${state.current!.request.attestation.activationId}`;
		return {
			seed,
			prepared,
			packet: join(f.root, `boot-service-restart-request-${suffix}.json`),
			index: join(f.root, `boot-service-restart-intent-${suffix}.json`),
			journal: join(f.root, `boot-service-restart-${suffix}`),
			completion: join(f.root, `successor-completed-${suffix}.json`),
		};
	};
	const controls = {
		intentId: f.activation.input.intentId,
		originCompletion: f.activation.paths.completion,
		stop: f,
		state,
		registry,
		stage,
		readStage,
		exec,
		poll,
		inspect,
		create,
		worker: create(),
		paths,
	};
	return { ...(f as Omit<T, keyof typeof controls>), ...controls };
}
