import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCompanyComputerBootIntentRequest } from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficeResumeWorker } from "../../src/lxd-office-resume-worker.ts";
import { officeStopHash } from "../../src/lxd-office-stop-evidence.ts";
import { nodeAdmissionFixture } from "./node-admission.ts";
import { officePowerOffWorkerFixture } from "./office-power-off-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";

const signal = (): AbortSignal => new AbortController().signal;
export async function officeResumeWorkerFixture(roots: string[], action: "reboot" | "power_off" = "power_off") {
	const f = await officePowerOffWorkerFixture(roots, action);
	await f.run();
	return createOfficeResumeWorkerFixture(f);
}

export async function createOfficeResumeWorkerFixture(
	f: Awaited<ReturnType<typeof officePowerOffWorkerFixture>>,
	identity = { bootIntentId: id(101), activationId: id(102), bootId: id(103), operationId: id(104) },
) {
	const power = JSON.parse(await readFile(f.paths.seed, "utf8"));
	const request = parseCompanyComputerBootIntentRequest({
		schema: "qorpera.office-boot-intent-request/v1",
		bootIntentId: identity.bootIntentId,
		activationId: identity.activationId,
		predecessor: f.request,
		stopHistorySha256: power.stopHistorySha256,
		powerOffCompletionSha256: officeStopHash(await readFile(f.paths.done)),
	});
	const intent = {
		schema: "qorpera.office-boot-intent/v1",
		request,
		state: "prepared",
		stopAcknowledgedAtMs: 2000,
		officeRevision: 12,
		privacyVersion: 1,
		validForMs: 5000,
	};
	const suffix = `${f.binding.allocationId}-${f.request.transitionId}`,
		names = {
			seed: join(f.root, `resume-request-${suffix}.json`),
			prepared: join(f.root, `resume-prepared-${suffix}.json`),
			observation: join(f.root, `resume-observation-${suffix}.json`),
			done: join(f.root, `resume-completed-${suffix}.json`),
		};
	const registry = vi.fn<ConstructorParameters<typeof LxdOfficeResumeWorker>[1]["call"]>(
		async (method, args, checked) => {
			checked.throwIfAborted();
			if (method === "qorpera_reserve_runtime_node_machine") return nodeAdmissionFixture(args);
			expect(args.p_request).toEqual(request);
			expect(JSON.parse(await readFile(names.seed, "utf8")).request).toEqual(request);
			if (method === "qorpera_check_runtime_office_boot_intent" && intent.state !== "prepared")
				throw new Error("already handed off");
			return structuredClone(intent);
		},
	);
	const nextEvent = (await readdir(f.paths.journal)).filter((name) => /^\d{6}\.json$/.test(name)).length;
	f.submit.mockClear();
	f.poll.mockClear();
	f.submit.mockImplementation(async (project, action, checked) => {
		checked.throwIfAborted();
		expect(action.action).toBe("start");
		expect(
			JSON.parse(await readFile(join(f.paths.journal, `${String(nextEvent).padStart(6, "0")}.json`), "utf8")),
		).toMatchObject({
			kind: "dispatch",
			action: "start",
			commandId: JSON.parse(await readFile(names.seed, "utf8")).startCommandId,
		});
		expect(registry.mock.calls.some(([method]) => method === "qorpera_check_runtime_office_boot_intent")).toBe(true);
		if (f.state.physical) {
			f.state.status = "Running";
			f.state.statusCode = 103;
			f.guest.get("/proc/sys/kernel/random/boot_id")!.content = Buffer.from(identity.bootId);
		}
		return {
			project,
			instanceName: "name" in action ? action.name : action.request.name,
			operationId: identity.operationId,
		};
	});
	const create = () =>
		new LxdOfficeResumeWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{ client: f.client, kernelLock: f.kernelLock },
		);
	const run = (checked: AbortSignal = signal()) => create().reconcile(f.activation.request.intentId, request, checked);
	return { ...f, powerOff: f, request, intent, names, registry, create, run };
}
