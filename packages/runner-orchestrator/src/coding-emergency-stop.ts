import { randomUUID } from "node:crypto";
import { assertLxdCodingVmInstance, type LxdCodingVmBinding, lxdCodingVmPlan } from "./coding-vm.ts";
import type { LxdTrackedClient } from "./lxd-client.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type State = "dispatching" | "accepted" | "stopped" | "recovery-required";
export interface CodingEmergencyStopOptions {
	requestId: string;
	leaseToken: string;
	owner: string;
	machineIdSha256: string;
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	client: Pick<LxdTrackedClient, "getInstance" | "submitInstanceOperation" | "inspectInstanceOperation">;
	signal: AbortSignal;
}

/** SQL owns the immutable dispatch record. No filesystem or NAS operation is
 * required, and an ambiguous dispatch is never retried. A stopped observation
 * neither releases capacity nor proves a storage writer exclusion fence. */
export async function reconcileCodingEmergencyStop(options: CodingEmergencyStopOptions): Promise<{
	state: "stopped" | "pending" | "recovery-required";
	workerId: string;
	allocationId: string;
	instanceSha256: string;
}> {
	const args = {
		p_request_id: options.requestId,
		p_lease_token: options.leaseToken,
		p_owner: options.owner,
		p_machine_id_sha256: options.machineIdSha256,
	};
	const started = performance.now();
	const boundSignal = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
	const description = (await options.control.call("qorpera_describe_coding_cleanup", args, boundSignal)) as {
		schema: string;
		binding: LxdCodingVmBinding;
		admission: Record<string, unknown>;
	};
	if (!description || description.schema !== "qorpera.coding-cleanup/v1")
		throw new Error("CODING_CLEANUP_DESCRIPTOR_INVALID");
	const plan = lxdCodingVmPlan(description.binding),
		permit = description.admission;
	if (
		!permit ||
		permit.schema !== "qorpera.coding-vm-admission/v1" ||
		permit.intent !== "stop" ||
		permit.workerId !== plan.binding.workerId ||
		permit.allocationId !== plan.binding.allocationId ||
		permit.instanceSha256 !== plan.instanceSha256 ||
		typeof permit.nodeId !== "string" ||
		!UUID.test(permit.nodeId) ||
		!Number.isSafeInteger(permit.nodeVersion) ||
		Number(permit.nodeVersion) < 1 ||
		!Number.isSafeInteger(permit.validForMs) ||
		Number(permit.validForMs) < 1 ||
		Number(permit.validForMs) > 5000
	)
		throw new Error("CODING_CLEANUP_DESCRIPTOR_INVALID");
	const remaining = Number(permit.validForMs) - (performance.now() - started);
	if (remaining < 1) throw new Error("CODING_CLEANUP_AUTHORITY_EXPIRED");
	const signal = AbortSignal.any([boundSignal, AbortSignal.timeout(Math.max(1, Math.floor(remaining)))]);
	const result = (state: "stopped" | "pending" | "recovery-required") => ({
		state,
		workerId: plan.binding.workerId,
		allocationId: plan.binding.allocationId,
		instanceSha256: plan.instanceSha256,
	});
	const parse = (
		value: unknown,
	): { requestId: string; claimId: string; operationId: string | null; state: State; dispatch: boolean } => {
		const stop = value as Record<string, unknown>;
		if (
			!stop ||
			stop.schema !== "qorpera.coding-emergency-stop/v1" ||
			typeof stop.requestId !== "string" ||
			!UUID.test(stop.requestId) ||
			typeof stop.id !== "string" ||
			!UUID.test(stop.id) ||
			stop.workerId !== plan.binding.workerId ||
			stop.allocationId !== plan.binding.allocationId ||
			stop.instanceSha256 !== plan.instanceSha256 ||
			typeof stop.claimId !== "string" ||
			!UUID.test(stop.claimId) ||
			typeof stop.dispatch !== "boolean" ||
			!["dispatching", "accepted", "stopped", "recovery-required"].includes(String(stop.state)) ||
			(stop.operationId !== null && (typeof stop.operationId !== "string" || !UUID.test(stop.operationId))) ||
			(["accepted", "stopped"].includes(String(stop.state)) && stop.operationId === null) ||
			(stop.dispatch && (stop.state !== "dispatching" || stop.operationId !== null))
		)
			throw new Error("CODING_EMERGENCY_RECEIPT_INVALID");
		return stop as unknown as {
			requestId: string;
			claimId: string;
			operationId: string | null;
			state: State;
			dispatch: boolean;
		};
	};
	// Validate the exact retained instance before creating an irreversible intent.
	const instance = await options.client.getInstance(plan.binding.project, plan.request.name, signal);
	if (!instance) return result("recovery-required");
	assertLxdCodingVmInstance(plan.binding, instance);
	const claimId = randomUUID();
	let stop = parse(
		await options.control.call(
			"qorpera_claim_coding_emergency_stop",
			{ ...args, p_binding_text: JSON.stringify(plan.binding), p_claim_id: claimId },
			signal,
		),
	);
	const record = async (state: Exclude<State, "dispatching">, operationId: string | null) =>
		parse(
			await options.control.call(
				"qorpera_record_coding_emergency_stop",
				{ ...args, p_claim_id: stop.claimId, p_operation_id: operationId, p_state: state },
				options.signal,
			),
		);
	if (stop.dispatch) {
		// A fresh dispatch belongs to this request. A later cancellation may
		// only observe the original request's already-owned operation.
		if (stop.claimId !== claimId || stop.requestId !== options.requestId)
			throw new Error("CODING_EMERGENCY_CLAIM_DIFFERS");
		try {
			signal.throwIfAborted();
			const reference = await options.client.submitInstanceOperation(
				plan.binding.project,
				{ action: "stop", name: plan.request.name },
				signal,
			);
			if (
				reference.project !== plan.binding.project ||
				reference.instanceName !== plan.request.name ||
				!UUID.test(reference.operationId)
			)
				throw new Error("CODING_EMERGENCY_OPERATION_DIFFERS");
			// Preserve accepted custody after the short dispatch permit ends.
			stop = await record("accepted", reference.operationId);
		} catch {
			// A committed accepted record may have lost its reply. Leave the durable
			// state untouched so a later observer can recover that exact operation.
			return result("recovery-required");
		}
	}
	if (stop.state === "dispatching" || stop.state === "recovery-required") return result("recovery-required");
	if (stop.state === "accepted") {
		const state = await options.client.inspectInstanceOperation(
			{ project: plan.binding.project, instanceName: plan.request.name, operationId: stop.operationId! },
			signal,
		);
		if (state === "pending") return result("pending");
		if (state === "failed") {
			await record("recovery-required", stop.operationId);
			return result("recovery-required");
		}
	}
	const observed = await options.client.getInstance(plan.binding.project, plan.request.name, signal);
	if (!observed) return result("recovery-required");
	assertLxdCodingVmInstance(plan.binding, observed);
	if (observed.status !== "Stopped" || observed.statusCode !== 102) return result("recovery-required");
	if (stop.state !== "stopped") await record("stopped", stop.operationId);
	return result("stopped");
}
