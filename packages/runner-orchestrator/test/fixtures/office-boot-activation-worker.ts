import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type CompanyComputerBootSuccessor,
	companyComputerBootDirectory,
	parseCompanyComputerBootServiceStartCompletion,
	parseCompanyComputerBootServiceStartRequest,
	parseCompanyComputerBootSuccessorRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeBootActivationWorker } from "../../src/lxd-office-boot-activation-worker.ts";
import type { LxdOfficeInvocationMeasurement } from "../../src/lxd-office-invocation-measurement.ts";
import { officeBootConfigurationWorkerFixture } from "./office-boot-configuration-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";

export async function officeBootActivationWorkerFixture(roots: string[]) {
	const f = await officeBootConfigurationWorkerFixture(roots);
	await f.run();
	return createOfficeBootActivationWorkerFixture(f);
}

type BootActivationFixture = Pick<
	Awaited<ReturnType<typeof officeBootConfigurationWorkerFixture>>,
	| "root"
	| "binding"
	| "request"
	| "guest"
	| "client"
	| "intent"
	| "policy"
	| "check"
	| "kernelLock"
	| "readProtected"
	| "readCredential"
	| "input"
> & { names: { observation: string } };

export async function createOfficeBootActivationWorkerFixture<T extends BootActivationFixture>(f: T) {
	const configured = JSON.parse(await readFile(f.names.observation, "utf8")),
		configuration = configured.completion;
	for (const path of f.guest.keys()) if (path.startsWith("/run/qorpera-office-preparation/")) f.guest.delete(path);
	const put = (path: string, value: unknown, mode = 0o600) =>
		f.guest.set(path, { uid: 0, gid: 0, mode, content: Buffer.from(JSON.stringify(value)) });
	f.guest.set("/run/qorpera-office-preparation/control.lock", {
		uid: 0,
		gid: 0,
		mode: 0o600,
		content: Buffer.alloc(0),
	});
	put(`${companyComputerBootDirectory(configuration.command.bootId)}/configuration-claim.json`, {
		schema: "qorpera.office-boot-configuration-claim/v1",
		command: configuration.command,
		bootIntentId: f.request.bootIntentId,
		activationId: f.request.activationId,
	});
	const suffix = `${f.binding.allocationId}-${f.request.activationId}`,
		paths = {
			seed: join(f.root, `boot-successor-request-${suffix}.json`),
			prepared: join(f.root, `boot-successor-prepared-${suffix}.json`),
			packet: join(f.root, `boot-service-start-request-${suffix}.json`),
			index: join(f.root, `boot-service-start-intent-${suffix}.json`),
			journal: join(f.root, `boot-service-start-${suffix}`),
			completion: join(f.root, `boot-successor-completed-${suffix}.json`),
		};
	const state = {
		current: undefined as CompanyComputerBootSuccessor | undefined,
		enabled: true,
		physical: true,
		ready: true,
		preparations: 0,
		activations: 0,
	};
	const registry = vi.fn<ConstructorParameters<typeof LxdOfficeBootActivationWorker>[1]["call"]>(
		async (method, args, checked) => {
			checked.throwIfAborted();
			const request = parseCompanyComputerBootSuccessorRequest(args.p_request);
			expect(JSON.parse(await readFile(paths.seed, "utf8")).request).toEqual(request);
			if (method === "qorpera_prepare_runtime_office_boot_successor" && !state.current) {
				if (!state.enabled) throw new Error("disabled");
				state.preparations++;
				f.intent.state = "admitted";
				state.current = {
					schema: "qorpera.office-boot-successor/v1",
					request,
					state: "prepared",
					serviceInvocationId: null,
					readinessFresh: false,
					stopAcknowledgedAtMs: f.intent.stopAcknowledgedAtMs,
					officeRevision: f.intent.officeRevision,
					privacyVersion: f.intent.privacyVersion,
					validForMs: 5000,
				};
			}
			if (!state.current) throw new Error("not prepared");
			expect(state.current.request).toEqual(request);
			if (
				method === "qorpera_check_runtime_office_boot_successor" &&
				!state.enabled &&
				state.current.state !== "active"
			)
				throw new Error("disabled");
			if (method === "qorpera_activate_runtime_office_boot_successor") {
				if (
					state.current.state !== "active" &&
					(!state.enabled || state.current.state === "prepared" || !state.current.readinessFresh)
				)
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
		.spyOn(f.client, "pushOfficeBootServiceStartRequest")
		.mockImplementation(async (_p, _n, sha, bytes) => {
			staged = Buffer.from(bytes);
			f.guest.set(`/run/qorpera-office-preparation/boot-service-start-incoming-${sha}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o400,
				content: Buffer.from(bytes),
			});
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeBootServiceStartRequest")
		.mockImplementation(async () => ({ uid: 0, gid: 0, mode: 0o400, content: Buffer.from(staged!) }));
	const completionPath = "/run/qorpera-office-preparation/boot-service-start-completion.json";
	const exec = vi
		.spyOn(f.client, "submitOfficeBootServiceStart")
		.mockImplementation(async (project, instanceName, command) => {
			const request = parseCompanyComputerBootServiceStartRequest(JSON.parse(staged!.toString()));
			expect(state.current?.state).toBe("prepared");
			expect(JSON.parse(await readFile(join(paths.journal, "000000.json"), "utf8")).kind).toBe("dispatch");
			if (state.physical) {
				put("/run/qorpera-office-preparation/boot-service-start-claim.json", {
					schema: "qorpera.office-boot-service-start-claim/v1",
					command,
					bootIntentId: f.request.bootIntentId,
					activationId: f.request.activationId,
					configurationCompletionSha256: request.configurationCompletionSha256,
				});
				const completion = parseCompanyComputerBootServiceStartCompletion(
					{
						schema: "qorpera.office-boot-service-start-completion/v1",
						command,
						bootIntentId: f.request.bootIntentId,
						activationId: f.request.activationId,
						configurationCompletionSha256: request.configurationCompletionSha256,
						configurationSha256: request.successor.request.attestation.configurationSha256,
						serviceInvocationId:
							f.request.activationId === id(102) ? "c".repeat(32) : f.request.activationId.replaceAll("-", ""),
						mainPid: 700,
						controlGroup: "/system.slice/qorpera-company-computer.service",
					},
					command,
					request,
				);
				put(completionPath, completion);
				if (state.ready)
					state.current = {
						...state.current!,
						state: "ready",
						readinessFresh: true,
						serviceInvocationId: completion.serviceInvocationId,
					};
			}
			return { project, instanceName, operationId: id(125) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeBootServiceStart").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeBootServiceInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			put(`/run/qorpera-office-preparation/boot-service-inspection-${inspectionId}.json`, {
				schema: "qorpera.office-boot-service-inspection/v1",
				inspectionId,
				start: JSON.parse(f.guest.get(completionPath)!.content.toString()),
			});
			return { project, instanceName, operationId: id(126) };
		});
	const create = (ports: { measureInvocation?: LxdOfficeInvocationMeasurement } = {}) =>
		new LxdOfficeBootActivationWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{
				client: f.client,
				kernelLock: f.kernelLock,
				readProtected: f.readProtected,
				readCredential: f.readCredential,
				...ports,
			},
		);
	const controls = {
		configuration: f,
		state,
		registry,
		stage,
		readStage,
		exec,
		poll,
		inspect,
		create,
		paths,
		completionPath,
		run: (signal: AbortSignal = new AbortController().signal) => create().reconcile(f.input, signal),
	};
	return { ...(f as Omit<T, keyof typeof controls>), ...controls };
}
