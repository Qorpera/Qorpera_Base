import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PaidComputerGuardClient } from "../../packages/runner-orchestrator/src/computer-paid-guard-ipc.ts";
import { readPaidComputerHostClock } from "../../packages/runner-orchestrator/src/computer-paid-guard-lxd.ts";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { lxdResourceBytes } from "../../packages/runner-orchestrator/src/lxd-native-node-policy.ts";
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
	disposableRun: { githubHosted: true; companyId: string };
	/** Stop/settle when the calling lifecycle test is finished with this VM. */
	close: boolean;
	/** Wait on real clocks for one production window renewal. */
	renew?: boolean;
	signal: AbortSignal;
}) {
	assert.equal(process.platform, "linux", "Real Linux host required");
	assert.equal(process.env.GITHUB_ACTIONS, "true");
	assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
	assert.equal(options.disposableRun.githubHosted, true);
	const client = new LxdUnixClient(options.lxdSocketPath);
	const guard = new PaidComputerGuardClient(options.guardSocketPath);
	const calls: WorkloadUsageCall[] = [];
	const control: RuntimeComputerControllerOptions["control"] = {
		async call(method, args, signal) {
			const result = await options.control.call(method, args, signal);
			const request = args.p_request as Record<string, unknown> | undefined;
			if (request?.sample) calls.push({ method, args: structuredClone(args) });
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
	// Recovery creates a zero-charge gap if the prior process already bound the
	// VM. The first running sample starts continuity, then real time advances it.
	await controller.observe(allocation, options.signal);
	await delay(1100, undefined, { signal: options.signal });
	await controller.observe(allocation, options.signal);
	if (options.renew) {
		const end = Date.now() + 330000;
		let renewed = false;
		while (Date.now() < end) {
			await delay(5000, undefined, { signal: options.signal });
			await controller.observe(allocation, options.signal);
			if ((await guard.status(original.permit.permitId, options.signal)).permit.generation > original.permit.generation) { renewed = true; break; }
		}
		assert(renewed, "Actual funded window did not renew");
		const renewal = calls.at(-1);
		assert(renewal && renewal.method === "qorpera_renew_runtime_computer_permit");
		await control.call(renewal.method, structuredClone(renewal.args), options.signal);
		await controller.observe(allocation, options.signal);
	}
	await delay(1100, undefined, { signal: options.signal });
	await controller.observe(allocation, options.signal);
	const firstRunning = calls.map((call) => (call.args.p_request as Record<string, unknown>).sample as Record<string, unknown>)
		.find((sample) => sample.state === "running");
	assert(firstRunning, "Guest Linux clock never became observable");
	const lastCall = calls.at(-1);
	assert(lastCall && lastCall.method === "qorpera_checkpoint_runtime_computer_permit", "Expected checkpoint before replay");
	// Replay the exact real observation through actual SQL. The evidence reader
	// verifies one sample/checkpoint and one eventual cumulative debit.
	await control.call(lastCall.method, structuredClone(lastCall.args), options.signal);
	const beforeRestart = await guard.status(original.permit.permitId, options.signal);
	controller = new RuntimeComputerController(controllerOptions);
	assert.equal(await controller.recover(options.context, options.signal), "paid");
	await controller.observe(allocation, options.signal);
	const restartSample = (calls.at(-1)!.args.p_request as Record<string, unknown>).sample as Record<string, unknown>;
	assert.equal(restartSample.state, "gap", "Controller restart must not infer unobserved time");
	const afterRestart = await guard.status(original.permit.permitId, options.signal);
	assert.equal(afterRestart.deadlineUptimeMs, beforeRestart.deadlineUptimeMs, "Controller restart extended physical funding deadline");
	await delay(1100, undefined, { signal: options.signal });
	await controller.observe(allocation, options.signal);
	await delay(1100, undefined, { signal: options.signal });
	await controller.observe(allocation, options.signal);
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
		await controller.settleStopped(allocation, options.signal);
		const terminal = calls.at(-1)!;
		assert.equal(terminal.method, "qorpera_finish_runtime_computer_permit");
		await control.call(terminal.method, structuredClone(terminal.args), options.signal);
	}
	return {
		permitId: original.permit.permitId,
		physicalSamples: calls.map((call) => (call.args.p_request as Record<string, unknown>).sample),
		physicalId: original.machine.physicalInstanceId,
		hostBootId: firstRunning.hostBootId,
		guestBootId: firstRunning.guestBootId,
		shape: { cpuMillis: original.permit.cpuMillis, memoryBytes: original.permit.memoryBytes },
		kind: options.context.providerKind === "office" ? "company_computer" : "agent_sandbox",
		closed: options.close,
		checks: { actualLxdVm: true, actualLinuxClocks: true, exactCheckpointReplay: true, controllerRestartGap: true,
			deadlineUnchangedByRestart: true, actualWindowRenewal: options.renew === true, exactRenewalReplay: options.renew === true, physicalStopped: options.close, exactFinishReplay: options.close },
		stopReceipt,
	};
}
