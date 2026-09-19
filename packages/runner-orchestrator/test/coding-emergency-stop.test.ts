import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reconcileCodingEmergencyStop } from "../src/coding-emergency-stop.ts";
import { type LxdCodingVmBinding, lxdCodingVmPlan } from "../src/coding-vm.ts";
import type { LxdInstanceRecord, LxdOperationState } from "../src/lxd-client.ts";
import { codingStorageFixture } from "./helpers/coding-storage.ts";

function fixture() {
	const scope = { workerId: randomUUID(), companyId: randomUUID(), environmentId: randomUUID() };
	const binding: LxdCodingVmBinding = {
		...scope,
		schema: "qorpera.lxd-coding-vm/v2",
		allocationId: randomUUID(),
		storage: codingStorageFixture(scope),
		providerId: "coding",
		providerPolicySha256: "a".repeat(64),
		repository: { host: "github.com", owner: "Qorpera", name: "project", baseBranch: "main" },
		project: "coding",
		imageFingerprint: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		storagePool: "coding",
		network: "coding",
		cpus: 2,
		memoryBytes: 2147483648,
		rootDiskBytes: 4294967296,
	};
	const plan = lxdCodingVmPlan(binding),
		operationId = randomUUID();
	const instance: LxdInstanceRecord = {
		name: plan.request.name,
		type: "virtual-machine",
		status: "Running",
		statusCode: 103,
		profiles: [],
		config: { ...plan.request.config, "volatile.base_image": binding.imageFingerprint },
		expandedConfig: { ...plan.request.config, "volatile.base_image": binding.imageFingerprint },
		devices: plan.request.devices,
		expandedDevices: plan.request.devices,
	};
	const description = {
		schema: "qorpera.coding-cleanup/v1",
		binding,
		admission: {
			schema: "qorpera.coding-vm-admission/v1",
			workerId: binding.workerId,
			allocationId: binding.allocationId,
			instanceSha256: plan.instanceSha256,
			intent: "stop",
			validForMs: 5000,
			nodeId: randomUUID(),
			nodeVersion: 1,
		},
	};
	let saved: Record<string, unknown> | undefined;
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_describe_coding_cleanup") return description;
			if (method === "qorpera_claim_coding_emergency_stop") {
				if (saved) return { ...saved, dispatch: false };
				saved = {
					schema: "qorpera.coding-emergency-stop/v1",
					id: randomUUID(),
					requestId: args.p_request_id,
					workerId: binding.workerId,
					allocationId: binding.allocationId,
					instanceSha256: plan.instanceSha256,
					claimId: args.p_claim_id,
					operationId: null,
					state: "dispatching",
					dispatch: false,
				};
				return { ...saved, dispatch: true };
			}
			if (method === "qorpera_record_coding_emergency_stop") {
				saved = { ...saved, operationId: args.p_operation_id, state: args.p_state };
				return saved;
			}
			throw new Error("unexpected RPC");
		}),
	};
	const client = {
		getInstance: vi.fn(async (): Promise<LxdInstanceRecord | undefined> => instance),
		submitInstanceOperation: vi.fn(async () => ({
			project: binding.project,
			instanceName: plan.request.name,
			operationId,
		})),
		inspectInstanceOperation: vi.fn(async (): Promise<LxdOperationState> => {
			instance.status = "Stopped";
			instance.statusCode = 102;
			return "succeeded";
		}),
	};
	const options = {
		requestId: randomUUID(),
		leaseToken: randomUUID(),
		owner: "coding",
		machineIdSha256: "d".repeat(64),
		control,
		client,
		signal: new AbortController().signal,
	};
	return { options, client, control, instance, description, operationId, plan };
}
describe("NAS-independent emergency coding stop", () => {
	it("records one stop and confirms the exact stopped instance, preserving the SQL fence", async () => {
		const f = fixture();
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("stopped");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("stopped");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
		expect(f.client.submitInstanceOperation.mock.calls[0]).toEqual([
			f.plan.binding.project,
			{ action: "stop", name: f.plan.request.name },
			expect.any(AbortSignal),
		]);
		expect(f.control.call.mock.calls.some(([method]) => /release|delete|recover/.test(method))).toBe(false);
	});
	it("never replays an unknown stop dispatch", async () => {
		const f = fixture();
		f.client.submitInstanceOperation.mockRejectedValue(new Error("reply lost"));
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("reconciles accepted operation after its SQL reply was lost", async () => {
		const f = fixture(),
			call = f.control.call.getMockImplementation()!;
		let lost = true;
		f.control.call.mockImplementation(async (method, args) => {
			const result = await call(method, args);
			if (method === "qorpera_record_coding_emergency_stop" && args.p_state === "accepted" && lost) {
				lost = false;
				throw new Error("lost");
			}
			return result;
		});
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("stopped");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("keeps a pending operation pending", async () => {
		const f = fixture();
		f.client.inspectInstanceOperation.mockResolvedValue("pending");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("pending");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("pending");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("never treats operation success alone as physical stop", async () => {
		const f = fixture();
		f.client.inspectInstanceOperation.mockResolvedValue("succeeded");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect(f.control.call.mock.calls.some(([, args]) => args.p_state === "stopped")).toBe(false);
	});
	it("retains a failed stop without replay or capacity release", async () => {
		const f = fixture();
		f.client.inspectInstanceOperation.mockResolvedValue("failed");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("rejects instance drift before dispatch", async () => {
		const f = fixture();
		f.instance.expandedConfig = { ...f.instance.expandedConfig, "raw.lxc": "unsafe" };
		await expect(reconcileCodingEmergencyStop(f.options)).rejects.toThrow("DRIFTED");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("requires historical SQL custody even when current deployment policy changes", async () => {
		const f = fixture();
		f.control.call.mockRejectedValue(new Error("custody differs"));
		await expect(reconcileCodingEmergencyStop(f.options)).rejects.toThrow("custody differs");
		expect(f.client.getInstance).not.toHaveBeenCalled();
	});
	it("does not claim an absent instance as stopped", async () => {
		const f = fixture();
		f.client.getInstance.mockResolvedValue(undefined);
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).not.toHaveBeenCalled();
	});
	it("lets separately authorized cancellation reconcile the original operation without redispatch", async () => {
		const f = fixture();
		f.client.inspectInstanceOperation.mockResolvedValueOnce("pending");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("pending");
		expect(
			(await reconcileCodingEmergencyStop({ ...f.options, requestId: randomUUID(), leaseToken: randomUUID() }))
				.state,
		).toBe("stopped");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
	it("keeps an already-stopped rejected dispatch explicit instead of pretending an accepted operation", async () => {
		const f = fixture();
		f.instance.status = "Stopped";
		f.instance.statusCode = 102;
		f.client.submitInstanceOperation.mockRejectedValue(new Error("already stopped"));
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect((await reconcileCodingEmergencyStop(f.options)).state).toBe("recovery-required");
		expect(f.client.submitInstanceOperation).toHaveBeenCalledTimes(1);
	});
});
