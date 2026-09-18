import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseCompanyComputerServiceStartRequest } from "@qorpera/contracts";
import { expect, vi } from "vitest";
import type { LxdOfficeActivationRegistry } from "../../src/lxd-office-activation-control.ts";
import { LxdOfficeActivationWorker } from "../../src/lxd-office-activation-worker.ts";
import { officeConfigurationWorkerFixture } from "./office-configuration-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";

const signal = () => new AbortController().signal;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function officeActivationWorkerFixture(roots: string[], configured = true) {
	const f = await officeConfigurationWorkerFixture(roots);
	if (configured) await f.worker.reconcile(f.request, signal());
	return createOfficeActivationWorkerFixture(f);
}

export function createOfficeActivationWorkerFixture(f: Awaited<ReturnType<typeof officeConfigurationWorkerFixture>>) {
	let state: Record<string, unknown> | undefined,
		transitions = 0;
	const registry = vi.fn<LxdOfficeActivationRegistry["call"]>(async (method, args, checked) => {
		checked.throwIfAborted();
		if (method === "qorpera_prepare_runtime_office_activation") {
			state ??= {
				schema: "qorpera.office-activation/v1",
				intentId: f.request.intentId,
				companyComputerId: f.binding.companyComputerId,
				computerGeneration: f.binding.computerGeneration,
				allocationId: f.binding.allocationId,
				attestation: args.p_attestation,
				state: "prepared",
				serviceInvocationId: null,
				readinessFresh: false,
			};
		} else if (!state) throw new Error("activation absent");
		if (method === "qorpera_activate_runtime_office") {
			if (args.p_service_invocation_id !== state!.serviceInvocationId || state!.state === "prepared")
				throw new Error("invocation differs");
			if (state!.state === "ready") {
				if (!state!.readinessFresh) throw new Error("readiness expired");
				transitions++;
			}
			state!.state = "active";
		}
		return structuredClone(state);
	});
	let staged: Buffer | undefined;
	const stage = vi
		.spyOn(f.client, "pushOfficeServiceStartRequest")
		.mockImplementation(async (_project, _name, sha, bytes) => {
			expect(hash(bytes)).toBe(sha);
			staged = Buffer.from(bytes);
		});
	const readStage = vi
		.spyOn(f.client, "readOfficeServiceStartRequest")
		.mockImplementation(async (_project, _name, sha, length) => {
			if (!staged || staged.length !== length || hash(staged) !== sha) throw new Error("staging differs");
			return { content: Buffer.from(staged), uid: 0, gid: 0, mode: 0o400 };
		});
	const completionPath = "/run/qorpera-office-preparation/service-start-completion.json";
	const exec = vi
		.spyOn(f.client, "submitOfficeServiceStart")
		.mockImplementation(async (project, instanceName, command) => {
			if (!staged || state?.state !== "prepared") throw new Error("not prepared");
			const request = parseCompanyComputerServiceStartRequest(JSON.parse(staged.toString()));
			const completion = {
				schema: "qorpera.office-service-start-completion/v1",
				command,
				activationId: request.attestation.activationId,
				configurationCompletionSha256: request.configurationCompletionSha256,
				configurationSha256: request.attestation.configurationSha256,
				serviceInvocationId: "a".repeat(32),
				mainPid: 700,
				controlGroup: "/system.slice/qorpera-company-computer.service",
			};
			f.guest.set(completionPath, {
				uid: 0,
				gid: 0,
				mode: 0o600,
				content: Buffer.from(`${JSON.stringify(completion)}\n`),
			});
			Object.assign(state, {
				state: "ready",
				serviceInvocationId: completion.serviceInvocationId,
				readinessFresh: true,
			});
			return { project, instanceName, operationId: id(40) };
		});
	const poll = vi.spyOn(f.client, "inspectOfficeServiceStart").mockResolvedValue("succeeded");
	const inspect = vi
		.spyOn(f.client, "submitOfficeServiceInspection")
		.mockImplementation(async (project, instanceName, _command, inspectionId) => {
			const completion = f.guest.get(completionPath);
			if (!completion) throw new Error("completion missing");
			f.guest.set(`/run/qorpera-office-preparation/service-inspection-${inspectionId}.json`, {
				uid: 0,
				gid: 0,
				mode: 0o600,
				content: Buffer.from(
					JSON.stringify({
						schema: "qorpera.office-service-inspection/v1",
						inspectionId,
						start: JSON.parse(completion.content.toString()),
					}),
				),
			});
			return { project, instanceName, operationId: id(41) };
		});
	const create = () =>
		new LxdOfficeActivationWorker(
			{ policy: f.policy, check: f.check },
			{ call: f.call },
			{ call: registry },
			{
				client: f.client,
				kernelLock: f.kernelLock,
				readProtected: f.readProtected,
				readCredential: f.readCredential,
			},
		);
	return {
		...f,
		configuration: { exec: f.exec, stage: f.stage, names: f.names },
		stage,
		readStage,
		exec,
		poll,
		inspect,
		registry,
		create,
		worker: create(),
		completionPath,
		state: () => state,
		transitions: () => transitions,
		names: {
			seed: join(f.root, `activation-request-${f.binding.allocationId}.json`),
			index: join(f.root, `activation-intent-${f.binding.allocationId}.json`),
			completion: join(f.root, `activation-completed-${f.binding.allocationId}.json`),
			journal: join(f.root, `service-start-${f.binding.allocationId}`),
		},
	};
}
