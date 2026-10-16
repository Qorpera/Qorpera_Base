import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	COMPANY_COMPUTER_SERVICE_CGROUP,
	type CompanyComputerLifecycleRequest,
	type CompanyComputerServiceStopAcknowledgement,
	parseCompanyComputerLifecycleRequest,
	parseCompanyComputerLifecycleTransition,
	parseCompanyComputerServiceStopCompletion,
	parseCompanyComputerServiceStopRequest,
} from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeServiceStopWorker } from "../../src/lxd-office-service-stop-worker.ts";
import { officeActivationWorkerFixture } from "./office-activation-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";
import { officeStopHistoryFixture } from "./office-stop-history.ts";

export async function officeStopWorkerFixture(
	roots: string[],
	action: CompanyComputerLifecycleRequest["action"] = "service_restart",
) {
	const f = await officeActivationWorkerFixture(roots);
	await f.worker.reconcile(f.request, new AbortController().signal);
	return { ...f, ...(await createOfficeStopWorkerFixture(f, action)), activation: f };
}

export async function createOfficeStopWorkerFixture(
	f: Pick<
		Awaited<ReturnType<typeof officeActivationWorkerFixture>>,
		"root" | "binding" | "guest" | "client" | "check" | "kernelLock" | "policy" | "completionPath"
	> & { request: { intentId: string } },
	action: CompanyComputerLifecycleRequest["action"] = "service_restart",
	configurationPath = "/etc/qorpera-office/credentials/config.json",
	initial = true,
	transitionId = id(initial ? 90 : 130),
) {
	const config = JSON.parse(f.guest.get(configurationPath)!.content.toString());
	const start = JSON.parse(f.guest.get(f.completionPath)!.content.toString());
	const request = parseCompanyComputerLifecycleRequest({
		schema: "qorpera.office-lifecycle-request/v1",
		transitionId,
		action,
		activationId: start.activationId,
		providerId: f.binding.providerId,
		providerPolicySha256: f.binding.providerPolicySha256,
		startup: {
			scope: config.scope,
			computerGeneration: config.computerGeneration,
			allocationId: f.binding.allocationId,
			instanceSha256: config.linux.attestation.instanceSha256,
			imageSha256: f.binding.imageFingerprint,
			bootstrapSha256: f.binding.bootstrapSha256,
			bootId: config.linux.attestation.bootId,
			configurationSha256: start.configurationSha256,
			serviceInvocationId: start.serviceInvocationId,
		},
	});
	const revocation = parseCompanyComputerLifecycleTransition(
		{
			schema: "qorpera.office-lifecycle-transition/v1",
			request,
			state: "draining",
			revocationRevision: 12,
			requestedAtMs: 1000,
			drains: [],
		},
		request,
	);
	const state = {
		revoked: false,
		receipt: null as CompanyComputerServiceStopAcknowledgement | null,
		revocations: 0,
		acknowledgements: 0,
		physical: true,
	};
	const names = {
		seed: join(f.root, `recovery-request-${f.binding.allocationId}${initial ? "" : `-${request.activationId}`}.json`),
		revocation: join(
			f.root,
			`recovery-revocation-${f.binding.allocationId}${initial ? "" : `-${request.activationId}`}.json`,
		),
		stop: join(f.root, `service-stop-request-${f.binding.allocationId}-${request.transitionId}.json`),
		index: join(f.root, `service-stop-intent-${f.binding.allocationId}-${request.transitionId}.json`),
		journal: join(f.root, `service-stop-${f.binding.allocationId}-${request.transitionId}`),
		done: join(f.root, `service-stop-completed-${f.binding.allocationId}-${request.transitionId}.json`),
	};
	const registry = vi.fn<ConstructorParameters<typeof LxdOfficeServiceStopWorker>[1]["call"]>(
		async (method, args, signal) => {
			signal.throwIfAborted();
			expect(args.p_request).toEqual(request);
			expect(JSON.parse(await readFile(names.seed, "utf8")).request).toEqual(request);
			if (method === "qorpera_begin_runtime_office_lifecycle") {
				if (!state.revoked) state.revocations++;
				state.revoked = true;
				return structuredClone(revocation);
			}
			if (!state.revoked) throw new Error("not revoked");
			if (method === "qorpera_runtime_office_lifecycle_status") return structuredClone(revocation);
			if (method === "qorpera_runtime_office_stop_status") return structuredClone(state.receipt);
			if (method === "qorpera_prepare_runtime_office_stop")
				return {
					schema: "qorpera.office-service-stop-challenge/v1",
					inspectionId: args.p_inspection_id,
					command: args.p_command,
					transitionId: request.transitionId,
					revocationRevision: 12,
					officeRevision: 12,
					privacyVersion: 1,
					drains: [],
					validForMs: 5000,
				};
			if (method === "qorpera_ack_runtime_office_stop") {
				state.acknowledgements++;
				state.receipt = {
					schema: "qorpera.office-service-stop-acknowledgement/v1",
					state: "stopped",
					request,
					inspection: args.p_inspection as CompanyComputerServiceStopAcknowledgement["inspection"],
					acknowledgedAtMs: 2000,
				};
				return structuredClone(state.receipt);
			}
			throw new Error("unexpected registry call");
		},
	);
	let staged: Buffer | undefined;
	const stage = vi.spyOn(f.client, "pushOfficeServiceStopRequest").mockImplementation(async (_p, _n, _sha, bytes) => {
		staged = Buffer.from(bytes);
	});
	const readStage = vi
		.spyOn(f.client, "readOfficeServiceStopRequest")
		.mockImplementation(async () => ({ content: Buffer.from(staged!), uid: 0, gid: 0, mode: 0o400 }));
	const completionPath = `/run/qorpera-office-preparation/service-stop-completion${initial ? "" : `-${request.activationId}`}.json`;
	const exec = vi
		.spyOn(f.client, "submitOfficeServiceStop")
		.mockImplementation(async (project, instanceName, command) => {
			expect(state.revoked).toBe(true);
			expect(JSON.parse(await readFile(join(names.journal, "000000.json"), "utf8")).kind).toBe("dispatch");
			const stopRequest = parseCompanyComputerServiceStopRequest(JSON.parse(staged!.toString()));
			const completion = parseCompanyComputerServiceStopCompletion(
				{
					schema: "qorpera.office-service-stop-completion/v1",
					command,
					transitionId: request.transitionId,
					activationId: request.activationId,
					revocationRevision: revocation.revocationRevision,
					configurationSha256: request.startup.configurationSha256,
					startCompletionSha256: stopRequest.startCompletionSha256,
					fromServiceInvocationId: request.startup.serviceInvocationId,
					observedInvocationId: request.startup.serviceInvocationId,
					stoppedInvocationId: request.startup.serviceInvocationId,
					controlGroup: COMPANY_COMPUTER_SERVICE_CGROUP,
					cgroupState: "absent",
				},
				command,
				stopRequest,
			);
			if (state.physical) {
				f.guest.set(`/run/qorpera-office-preparation/service-stop-incoming-${command.requestSha256}.json`, {
					uid: 0,
					gid: 0,
					mode: 0o400,
					content: Buffer.from(staged!),
				});
				f.guest.set(completionPath, {
					uid: 0,
					gid: 0,
					mode: 0o600,
					content: Buffer.from(JSON.stringify(completion)),
				});
				for (const [path, content] of officeStopHistoryFixture(
					f.guest,
					command,
					request.activationId,
					completionPath,
				))
					f.guest.set(path, { uid: 0, gid: 0, mode: 0o600, content });
			}
			return { project, instanceName, operationId: id(91) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeServiceStop").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeServiceStopInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			const stop = JSON.parse(f.guest.get(completionPath)!.content.toString());
			f.guest.set(`/run/qorpera-office-preparation/service-stop-inspection-${inspectionId}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o600,
				content: Buffer.from(
					JSON.stringify({
						schema: "qorpera.office-service-stop-inspection/v1",
						inspectionId,
						stop,
						cgroupState: "absent",
					}),
				),
			});
			return { project, instanceName, operationId: id(92) };
		});
	const create = (now?: () => number) =>
		new LxdOfficeServiceStopWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{ client: f.client, kernelLock: f.kernelLock, now },
		);
	return {
		...f,
		activation: f,
		request,
		revocation,
		registry,
		state,
		names,
		stage,
		readStage,
		exec,
		poll,
		inspect,
		completionPath,
		create,
		worker: create(),
	};
}
