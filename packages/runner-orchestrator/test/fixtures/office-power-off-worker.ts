import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompanyComputerLifecycleRequest } from "@qorpera/contracts";
import { expect, vi } from "vitest";
import { LxdOfficePowerOffWorker } from "../../src/lxd-office-power-off-worker.ts";
import { serviceStartId as id } from "./office-service-start.ts";
import { officeStopWorkerFixture } from "./office-stop-worker.ts";

const signal = (): AbortSignal => new AbortController().signal;
export async function officePowerOffWorkerFixture(
	roots: string[],
	action: CompanyComputerLifecycleRequest["action"] = "power_off",
) {
	const f = await officeStopWorkerFixture(roots, action);
	await f.worker.reconcile(f.activation.request.intentId, f.request, signal());
	return createOfficePowerOffWorkerFixture(f);
}

export async function createOfficePowerOffWorkerFixture(
	f: Omit<Awaited<ReturnType<typeof officeStopWorkerFixture>>, "instance">,
) {
	const current = (await f.client.getInstance(f.binding.project, "unused", signal()))!;
	const state = { status: "Running", statusCode: 103, absent: false, physical: true };
	const instance = vi.spyOn(f.client, "getInstance").mockImplementation(async () =>
		state.absent
			? undefined
			: {
					...structuredClone(current),
					status: state.status,
					statusCode: state.statusCode,
				},
	);
	const vmState = vi
		.spyOn(f.client, "getInstanceState")
		.mockImplementation(async () => ({ status: state.status, statusCode: state.statusCode, network: {} }));
	const suffix = `${f.binding.allocationId}-${f.request.transitionId}`;
	const paths = {
		seed: join(f.root, `power-off-request-${suffix}.json`),
		done: join(f.root, `power-off-completed-${suffix}.json`),
		journal: join(f.root, f.binding.allocationId),
	};
	const nextEvent = (await readdir(paths.journal)).filter((name) => /^\d{6}\.json$/.test(name)).length;
	const submit = vi.spyOn(f.client, "submitInstanceOperation").mockImplementation(async (project, action) => {
		expect(action).toEqual({ action: "stop", name: current.name });
		const seed = JSON.parse(await readFile(paths.seed, "utf8"));
		expect(
			JSON.parse(await readFile(join(paths.journal, `${String(nextEvent).padStart(6, "0")}.json`), "utf8")),
		).toMatchObject({
			kind: "dispatch",
			action: "stop",
			commandId: seed.commandId,
		});
		if (state.physical) {
			state.status = "Stopped";
			state.statusCode = 102;
		}
		return { project, instanceName: current.name, operationId: id(nextEvent === 6 ? 98 : 500 + nextEvent) };
	});
	const poll = vi.spyOn(f.client, "inspectInstanceOperation").mockResolvedValue("succeeded");
	submit.mockClear();
	poll.mockClear();
	// Node demand suspension after a confirmed explicit power-off (20260923060000).
	const suspension: { value: unknown } = {
		value: {
			state: "suspended",
			allocationId: f.binding.allocationId,
			nodeId: "36000000-0000-4000-8000-000000000010",
			suspendedAt: "2026-09-23T15:00:00.000000+00:00",
		},
	};
	const stopRegistry = f.registry.getMockImplementation()!;
	const registry = vi.fn(async (...args: Parameters<typeof stopRegistry>) => {
		if ((args[0] as string) === "qorpera_suspend_runtime_node_machine") {
			args[2].throwIfAborted();
			if (suspension.value instanceof Error) throw suspension.value;
			return structuredClone(suspension.value);
		}
		return stopRegistry(...args);
	});
	const create = () =>
		new LxdOfficePowerOffWorker(
			{ policy: f.policy, check: f.check },
			{ call: registry },
			{ client: f.client, kernelLock: f.kernelLock },
		);
	const run = (s: AbortSignal = signal()) => create().reconcile(f.activation.request.intentId, f.request, s);
	const suspensions = () =>
		registry.mock.calls.filter(([method]) => (method as string) === "qorpera_suspend_runtime_node_machine");
	return { ...f, state, instance, vmState, submit, poll, registry, suspension, suspensions, paths, create, run };
}
