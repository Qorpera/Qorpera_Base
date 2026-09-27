import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { lxdResourceBytes } from "../../packages/runner-orchestrator/src/lxd-native-node-policy.ts";
import { assertWorkloadRun } from "./workload-usage-host.mjs";
import {
	RuntimeComputerController,
	type RuntimeComputerContext,
	type RuntimeComputerControllerOptions,
} from "../../packages/runner-orchestrator/src/runtime-computer-controller.ts";

export interface WorkloadUsageCall {
	method: string;
	/** Non-secret controller request only. The control port injects host auth. */
	args: Record<string, unknown>;
}

/** Only observed producer payloads and exact legacy observations; no clocks
 * are inferred from upload time or reconstructed by the evidence harness. */
export function workloadUsageSamples(calls: readonly WorkloadUsageCall[]): Record<string, unknown>[] {
 return calls.flatMap(({ args }) => {
  const request = args.p_request as Record<string, unknown> | undefined;
  if (request?.sample) return [request.sample as Record<string, unknown>];
  if (Array.isArray(request?.entries)) return request.entries.map((frame) => JSON.parse(String(frame.entryText)).sample as Record<string, unknown>);
  return [];
 });
}

/** Exercise an already prepared, started and independently enrolled disposable
 * VM. The caller owns initial admission/start and database setup. This function
 * uses only actual LXD reads, Linux clocks, the real daemon and production
 * controller; it does not accept injectable physical ports, fake clocks or
 * caller-created samples. It must not run alongside another controller for the
 * same allocation. No guest model or external paid provider is invoked. */
export async function exerciseRuntimeWorkloadUsage(options: {
	context: RuntimeComputerContext;
	guardSocketPath: string;
	lxdSocketPath: string;
	control: RuntimeComputerControllerOptions["control"];
	/** Fresh disposable-run provenance checked by the owning Linux harness. */
	disposableRun: ({ githubHosted: true } | { hostReceiptPath: string }) & { companyId: string };
	/** Stop/settle when the calling lifecycle test is finished with this VM. */
	close: boolean;
	/** Wait on real clocks for one production window renewal. */
	renew?: boolean;
	signal: AbortSignal;
}) {
	assert.equal(process.platform, "linux", "Real Linux host required");
	const { companyId: _companyId, ...provenance } = options.disposableRun;
	await assertWorkloadRun(provenance);
	const client = new LxdUnixClient(options.lxdSocketPath);
	const guard = new PaidComputerGuardClient(options.guardSocketPath);
	const calls: WorkloadUsageCall[] = [];
	const control: RuntimeComputerControllerOptions["control"] = {
		async call(method, args, signal) {
			const result = await options.control.call(method, args, signal);
			const request = args.p_request as Record<string, unknown> | undefined;
			if (request?.sample || Array.isArray(request?.entries)) calls.push({ method, args: structuredClone(args) });
			return result;
		},
	};
	const controllerOptions = { client, guard, control, clock: readPaidComputerHostClock };
	let controller = new RuntimeComputerController(controllerOptions);
	const allocation = options.context.allocationId;
	assert.equal(await controller.recover(options.context, options.signal), "paid");
	const original = await controller.guardRecord(allocation, options.signal);
	assert(original && original.machine.kind === "runtime" && original.phase === "running" && original.startSettled && original.startSucceeded);
	const target = original.machine.physicalTarget;
	const physical = await client.getInstance(target.project, target.instanceName, options.signal);
	assert(physical?.type === "virtual-machine" && physical.status === "Running");
	assert.equal(physical.config["volatile.uuid"], original.machine.physicalInstanceId);
	assert(/^[1-9][0-9]{0,3}$/.test(physical.expandedConfig["limits.cpu"]), "Exactly sized physical CPU required");
	assert.equal(Number(physical.expandedConfig["limits.cpu"]) * 1000, original.permit.cpuMillis, "Billed CPU differs from physical VM");
	const memory = physical.expandedConfig["limits.memory"];
	assert.equal(/^[1-9][0-9]{0,15}$/.test(memory) ? Number(memory) : lxdResourceBytes(memory), original.permit.memoryBytes, "Billed memory differs from physical VM");
	assert.equal(original.usageRequired, true, "Fresh physical acceptance requires the independent guard producer");
	const nextRunning = async (after: unknown = null) => {
		const deadline = Date.now() + 25000;
		while (Date.now() < deadline) {
			await controller.observe(allocation, options.signal);
			const latest = workloadUsageSamples(calls).at(-1);
			if (latest?.state === "running" && latest.observationId !== after) return latest;
			await delay(500, undefined, { signal: options.signal });
		}
		throw new Error("No new actual guard clock observation");
	};
	const firstRunning = await nextRunning();
	await nextRunning(firstRunning.observationId);
	if (options.renew) {
		const end = Date.now() + 330000;
		let renewed = false;
		while (Date.now() < end) {
			await delay(5000, undefined, { signal: options.signal });
			await controller.observe(allocation, options.signal);
			if ((await guard.status(original.permit.permitId, options.signal)).permit.generation > original.permit.generation) { renewed = true; break; }
		}
		assert(renewed, "Actual funded window did not renew");
		const renewal = calls.findLast((call) => call.method === "qorpera_renew_runtime_computer_permit");
		assert(renewal, "No actual renewal request captured");
		await control.call(renewal.method, structuredClone(renewal.args), options.signal);
	}
	const lastCall = calls.findLast((call) => call.method === "qorpera_record_computer_guard_samples");
	assert(lastCall, "Expected guard upload before replay");
	await control.call(lastCall.method, structuredClone(lastCall.args), options.signal);
	const beforeRestart = await guard.status(original.permit.permitId, options.signal);
	const beforeOutage = await guard.readUsage(original.permit.permitId, undefined, options.signal);
	// No provider/controller metering runs in this interval. The separate daemon
	// must retain actual physical observations longer than the SQL gap threshold.
	await delay(20000, undefined, { signal: options.signal });
	const duringOutage = await guard.readUsage(original.permit.permitId, { afterSequence: beforeOutage.head.sequence }, options.signal);
	const outageFrames = duringOutage.entries.filter((frame) => frame.sequence > beforeOutage.head.sequence);
	assert(outageFrames.length >= 3, "Independent guard did not observe the controller outage");
	assert(outageFrames.every((frame) => JSON.parse(frame.entryText).sample.state === "running"), "Controller outage contains unconfirmed physical clocks");
	controller = new RuntimeComputerController(controllerOptions);
	assert.equal(await controller.recover(options.context, options.signal), "paid");
	await controller.observe(allocation, options.signal);
	const uploadedIds = new Set(workloadUsageSamples(calls).map((sample) => sample.observationId));
	assert(outageFrames.every((frame) => uploadedIds.has(JSON.parse(frame.entryText).sample.observationId)), "Retained outage prefix was not uploaded");
	const afterRestart = await guard.status(original.permit.permitId, options.signal);
	assert.equal(afterRestart.deadlineUptimeMs, beforeRestart.deadlineUptimeMs, "Controller restart extended physical funding deadline");
	await nextRunning(workloadUsageSamples(calls).at(-1)?.observationId);
	let stopReceipt = null;
	if (options.close) {
		await controller.stop(allocation, options.signal);
		const deadline = Date.now() + 45000;
		while (Date.now() < deadline) {
			const status = await guard.status(original.permit.permitId, options.signal);
			if (status.phase === "stopped" && status.stopReceipt) { stopReceipt = status.stopReceipt; break; }
			await delay(500, undefined, { signal: options.signal });
		}
		assert(stopReceipt, "Physical stop was not confirmed");
		assert.equal((await client.getInstance(target.project, target.instanceName, options.signal))?.status, "Stopped");
		while (Date.now() < deadline && controller.manages(allocation)) {
			await controller.settleStopped(allocation, options.signal);
			if (controller.manages(allocation)) await delay(500, undefined, { signal: options.signal });
		}
		assert.equal(controller.manages(allocation), false, "Sealed producer prefix did not settle");
		const terminal = calls.at(-1)!;
		assert.equal(terminal.method, "qorpera_finish_runtime_computer_permit");
		await control.call(terminal.method, structuredClone(terminal.args), options.signal);
	}
	return {
		permitId: original.permit.permitId,
		physicalSamples: workloadUsageSamples(calls),
		controllerOutage: { beforeSequence: beforeOutage.head.sequence, afterSequence: duringOutage.head.sequence, physicalFrames: outageFrames.length, controllerSilentMs: 20000,
			observationIds: outageFrames.map((frame) => JSON.parse(frame.entryText).sample.observationId as string) },
		physicalId: original.machine.physicalInstanceId,
		hostBootId: firstRunning.hostBootId,
		guestBootId: firstRunning.guestBootId,
		shape: { cpuMillis: original.permit.cpuMillis, memoryBytes: original.permit.memoryBytes },
		kind: options.context.providerKind === "office" ? "company_computer" : "agent_sandbox",
		closed: options.close,
		checks: { actualLxdVm: true, actualLinuxClocks: true, exactGuardUploadReplay: true, independentGuardDuringControllerOutage: true,
			deadlineUnchangedByRestart: true, actualWindowRenewal: options.renew === true, exactRenewalReplay: options.renew === true, physicalStopped: options.close, exactFinishReplay: options.close },
		stopReceipt,
	};
}
