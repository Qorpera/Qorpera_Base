import { AsyncLocalStorage } from "node:async_hooks";
import { LxdUnixClient } from "../../packages/runner-orchestrator/src/lxd-client.ts";
import { LxdOfficeCodePackageControl } from "../../packages/runner-orchestrator/src/lxd-office-code-package-control.ts";
import { LxdOfficeCodePackageProvisionLane } from "../../packages/runner-orchestrator/src/lxd-office-code-package-provision-lane.ts";
import { LxdOfficePhysicalGate } from "../../packages/runner-orchestrator/src/lxd-office-physical-gate.ts";
import { LxdOfficeResetControl, LxdOfficeResetSuccessorControl } from "../../packages/runner-orchestrator/src/lxd-office-reset-control.ts";
import { LxdOfficeResetWorker } from "../../packages/runner-orchestrator/src/lxd-office-reset-worker.ts";
import { LxdOfficeTypedInspectionControl } from "../../packages/runner-orchestrator/src/lxd-office-typed-inspection.ts";
import { OFFICE_RESET_TIMING_SCHEMA, OFFICE_RESET_TIMING_STAGES } from "./office-lifecycle-timing-evidence.mjs";

type Stage = typeof OFFICE_RESET_TIMING_STAGES[number];
interface Row {
	stage: Stage; atMs: number; elapsedMs: number; outcome: "fulfilled" | "rejected";
	parentAborted: boolean; operationAborted: boolean | null; physicalAborted: boolean | null; physicalRemainingMs: number | null;
	physicalLease: number | null;
}
interface PhysicalObservation { sequence: number; deadline: number; signal?: AbortSignal }
interface Trace {
	attempt: number; started: number; caller: AbortSignal; physical?: PhysicalObservation; leases: number;
	total: number; pending: number; first: Row[]; recent: Row[]; settled: boolean;
}
const context = new AsyncLocalStorage<Trace>();
const signal = (value: unknown) => value instanceof AbortSignal ? value : undefined;
const elapsed = (from: number) => Math.max(0, Math.min(600000, Math.floor(performance.now() - from)));
function safe(call: () => unknown) {
	try {
		const result = call();
		if (result instanceof Promise) void result.then(undefined, () => {});
	} catch { /* Diagnostics never alter execution. */ }
}

/** Attaches observers without awaiting or replacing the original Promise.
 * Observer exceptions and rejected observer promises cannot affect the method.
 * Exported for exact receiver/argument/value/error/Promise identity tests. */
export function observeOfficeTimingMethod<T extends object, K extends keyof T>(
	target: T, key: K, observe: (args: readonly unknown[], outcome: "fulfilled" | "rejected", value: unknown, started: number) => void,
	enter?: (args: readonly unknown[], started: number) => void,
) {
	const descriptor = Object.getOwnPropertyDescriptor(target, key);
	if (!descriptor || typeof descriptor.value !== "function") throw new Error("OFFICE_TIMING_METHOD_UNAVAILABLE");
	const original: (...args: unknown[]) => unknown = descriptor.value;
	const wrapper = function (this: T, ...args: unknown[]) {
		const started = performance.now();
		safe(() => enter?.(args, started));
		let result: unknown;
		try { result = Reflect.apply(original, this, args); }
		catch (error) { safe(() => observe(args, "rejected", error, started)); throw error; }
		if (result instanceof Promise) {
			// Both callbacks return normally, including when the observer throws.
			void result.then(value => { safe(() => observe(args, "fulfilled", value, started)); },
				error => { safe(() => observe(args, "rejected", error, started)); });
		} else safe(() => observe(args, "fulfilled", result, started));
		return result;
	};
	Object.defineProperty(target, key, { ...descriptor, value: wrapper });
	return () => { if (Object.getOwnPropertyDescriptor(target, key)?.value === wrapper) Object.defineProperty(target, key, descriptor); };
}

function record(trace: Trace, physical: PhysicalObservation | undefined, stage: Stage, args: readonly unknown[], signalIndex: number, outcome: Row["outcome"], started: number) {
	if (trace.settled) return;
	const operationAborted = signal(args[signalIndex])?.aborted ?? null;
	const parentAborted = trace.caller.aborted;
	const physicalAborted = physical?.signal?.aborted ?? null;
	const row: Row = { stage, atMs: Math.max(0, Math.floor(started - trace.started)), elapsedMs: elapsed(started), outcome,
		parentAborted, operationAborted, physicalAborted,
		physicalLease: physical?.sequence ?? null,
		physicalRemainingMs: physical === undefined ? null : Math.max(0, Math.min(5000, Math.floor(physical.deadline - performance.now()))) };
	trace.total++;
	if (trace.first.length < 24) trace.first.push(row);
	else { if (trace.recent.length === 72) trace.recent.shift(); trace.recent.push(row); }
}

/** Acceptance process only. All production methods, receivers, arguments,
 * signals, promises, results and errors remain the actual ones. No clock,
 * authority, transport or worker port is replaced. Lexical host/NAS/archive
 * validation is deliberately visible only as uninstrumented gaps. */
export function installOfficeLifecycleTiming(emit: (value: unknown) => void) {
	const restore: Array<() => void> = [];
	let attempt = 0;
	const observe = <T extends object, K extends keyof T>(target: T, key: K, stage: Stage | ((args: readonly unknown[]) => Stage), signalIndex: number, physical = false) => {
		const entries = new WeakMap<readonly unknown[], { trace: Trace; physical?: PhysicalObservation }>();
		restore.push(observeOfficeTimingMethod(target, key, (args, outcome, value, started) => {
			const entry = entries.get(args);
			if (!entry) return;
			entries.delete(args);
			const { trace } = entry;
			trace.pending--;
			if (physical && outcome === "fulfilled" && value && typeof value === "object" && "signal" in value)
				if (entry.physical) entry.physical.signal = signal(value.signal);
			record(trace, entry.physical, typeof stage === "function" ? stage(args) : stage, args, signalIndex, outcome, started);
		}, (args, started) => {
			const trace = context.getStore();
			if (!trace || trace.settled) return;
			if (physical) trace.physical = { sequence: ++trace.leases, deadline: started + 5000 };
			// A check creates a new nested inspect; it must not inherit an older gate.
			entries.set(args, { trace, physical: stage === "physical_check" ? undefined : trace.physical });
			trace.pending++;
		}));
	};
	try {
		observe(LxdOfficePhysicalGate.prototype, "inspect", "physical_inspect", 0, true);
		observe(LxdOfficePhysicalGate.prototype, "check", "physical_check", 1);
		observe(LxdUnixClient.prototype, "getInstance", "guest_instance", 2);
		observe(LxdUnixClient.prototype, "readInstanceFile", args => args[2] === "/proc/sys/kernel/random/boot_id" ? "guest_boot_read" : "guest_read", 4);
		observe(LxdOfficeTypedInspectionControl.prototype, "inspectAndUse", "typed_inspection", 5);
		observe(LxdUnixClient.prototype, "submitOfficeResetServiceInspection", "reset_control_submit", 4);
		observe(LxdUnixClient.prototype, "inspectOfficeResetServiceStart", "reset_control_poll", 1);
		observe(LxdOfficeCodePackageProvisionLane.prototype, "prepareInvocation", "package_staging", 2);
		observe(LxdOfficeCodePackageProvisionLane.prototype, "measureInvocation", "package_measurement", 4);
		observe(LxdUnixClient.prototype, "submitOfficeCodePackageTool", args => {
			const mode: unknown = Array.isArray(args[5]) ? args[5][0] : undefined;
			return mode === "probe" ? "package_probe" : mode === "invocation" ? "package_invocation" : mode === "observation" ? "package_observation"
				: mode === "preflight" ? "package_preflight" : mode === "install" ? "package_install" : "package_tool";
		}, 6);
		observe(LxdUnixClient.prototype, "inspectOfficeCodePackageTool", "package_poll", 1);
		observe(LxdUnixClient.prototype, "readOfficeCodePackageFile", "package_file_read", 5);
		observe(LxdUnixClient.prototype, "pushOfficeCodePackageFile", "package_file_push", 5);
		observe(LxdUnixClient.prototype, "pushOfficeCodePackageDirectory", "package_directory", 4);
		observe(LxdUnixClient.prototype, "readOfficeCodePackageReceipt", "package_receipt", 4);
		observe(LxdOfficeResetControl.prototype, "status", "reset_status", 0);
		observe(LxdOfficeResetSuccessorControl.prototype, "check", "successor_check", 0);
		observe(LxdOfficeResetSuccessorControl.prototype, "status", "successor_status", 0);
		observe(LxdOfficeResetSuccessorControl.prototype, "activate", "successor_activate", 2);
		observe(LxdOfficeCodePackageControl.prototype, "invocation", "package_challenge", 3);
		observe(LxdOfficeCodePackageControl.prototype, "acknowledgeInvocation", "package_ack", 2);
		const target = LxdOfficeResetWorker.prototype;
		for (const key of ["reconcile", "reconcileSettled"] as const) {
		const original = target[key];
		const wrapper: typeof original = function (this: LxdOfficeResetWorker, input, caller) {
			const trace: Trace = { attempt: ++attempt, started: performance.now(), caller, leases: 0, total: 0, pending: 0, first: [], recent: [], settled: false };
			return context.run(trace, () => {
				const finish = (outcome: Row["outcome"]) => {
					safe(() => {
						trace.settled = true;
						return emit({ schema: OFFICE_RESET_TIMING_SCHEMA, attempt: trace.attempt, elapsedMs: elapsed(trace.started), outcome,
							parentAborted: caller.aborted, total: trace.total, omitted: trace.total - trace.first.length - trace.recent.length,
							pendingAtSettlement: trace.pending,
							records: [...trace.first, ...trace.recent] });
					});
				};
				let result: ReturnType<typeof original>;
				try { result = original.call(this, input, caller); }
				catch (error) { finish("rejected"); throw error; }
				void result.then(() => finish("fulfilled"), () => finish("rejected"));
				return result;
			});
		};
		target[key] = wrapper;
		restore.push(() => { if (target[key] === wrapper) target[key] = original; });
		}
	} catch (error) {
		for (const undo of restore.reverse()) undo();
		throw error;
	}
	return () => { for (const undo of restore.reverse()) undo(); };
}
