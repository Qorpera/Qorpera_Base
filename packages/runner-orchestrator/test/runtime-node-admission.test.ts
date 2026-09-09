import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NODE_CAPACITY_REFUSALS,
	type RuntimeNodeMachine,
	reserveRuntimeNodeMachine,
} from "../src/runtime-node-admission.ts";
import { nodeAdmissionFixture } from "./fixtures/node-admission.ts";

const machine: RuntimeNodeMachine = {
	allocationId: "34000000-0000-4000-8000-000000000088",
	providerKind: "office",
	providerId: "36000000-0000-4000-8000-000000000001",
	policySha256: "f".repeat(64),
	instanceSha256: "b".repeat(64),
	machineIdSha256: "c".repeat(64),
	cpuMillis: 2000,
	memoryBytes: 2147483648,
};
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe("shared node admission at the provider dispatch boundary", () => {
	it("retains the login allocation kind and adapter without borrowing a runner or office", async () => {
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => nodeAdmissionFixture(args));
		await expect(
			reserveRuntimeNodeMachine({ ...machine, providerKind: "login", providerId: "lxd" }, { call }, signal()),
		).resolves.toMatchObject({ state: "reserved" });
		expect(call.mock.calls[0][1]).toMatchObject({
			p_provider_kind: "login",
			p_provider_id: "lxd",
			p_allocation_id: machine.allocationId,
		});
	});
	it("pins the exact physical allocation, host, policy and CPU/RAM demand", async () => {
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => nodeAdmissionFixture(args));
		const result = await reserveRuntimeNodeMachine(machine, { call }, signal());
		expect(result.state).toBe("reserved");
		expect(call).toHaveBeenCalledOnce();
		expect(call.mock.calls[0]).toEqual([
			"qorpera_reserve_runtime_node_machine",
			{
				p_allocation_id: machine.allocationId,
				p_provider_kind: "office",
				p_provider_id: machine.providerId,
				p_policy_sha256: machine.policySha256,
				p_instance_sha256: machine.instanceSha256,
				p_machine_id_sha256: machine.machineIdSha256,
				p_cpu_millis: 2000,
				p_memory_bytes: 2147483648,
			},
			expect.any(AbortSignal),
		]);
	});
	it.each(NODE_CAPACITY_REFUSALS)("returns explicit refusal %s without retry or release", async (reason) => {
		const call = vi.fn(async () => ({ state: "refused", reason }));
		await expect(reserveRuntimeNodeMachine(machine, { call }, signal())).resolves.toEqual({
			state: "refused",
			reason,
		});
		expect(call).toHaveBeenCalledOnce();
	});
	it.each([
		{ cpuMillis: 1000 },
		{ memoryBytes: 1 },
		{ allocationId: "34000000-0000-4000-8000-000000000089" },
		{ instanceSha256: "d".repeat(64) },
		{ nodeId: "bad" },
		{ nodeVersion: 0 },
		{ validForMs: 5001 },
		{ validForMs: 0 },
		{ extra: true },
	])("rejects changed or incomplete admission %j", async (change) => {
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => ({
			...nodeAdmissionFixture(args),
			...change,
		}));
		await expect(reserveRuntimeNodeMachine(machine, { call }, signal())).rejects.toThrow(
			"NODE_ADMISSION_UNCONFIRMED",
		);
	});
	it("subtracts all RPC time from the grant before dispatch", async () => {
		vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1007);
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => ({
			...nodeAdmissionFixture(args),
			validForMs: 5,
		}));
		await expect(reserveRuntimeNodeMachine(machine, { call }, signal())).rejects.toThrow("NODE_ADMISSION_EXPIRED");
	});
	it("retains uncertain allocation results without automatic replay", async () => {
		const call = vi.fn(async () => {
			throw new Error("reply lost after commit");
		});
		await expect(reserveRuntimeNodeMachine(machine, { call }, signal())).rejects.toThrow("reply lost");
		expect(call).toHaveBeenCalledOnce();
	});
	it("does not release late admission after cancellation", async () => {
		const stop = new AbortController();
		const call = vi.fn(async (_method: string, args: Record<string, unknown>) => {
			stop.abort();
			return nodeAdmissionFixture(args);
		});
		await expect(reserveRuntimeNodeMachine(machine, { call }, stop.signal)).rejects.toThrow();
		expect(call).toHaveBeenCalledOnce();
	});
	it.each([
		{ cpuMillis: 1.5 },
		{ memoryBytes: 0 },
		{ machineIdSha256: "bad" },
		{ providerKind: "worker" },
		{ allocationId: "bad" },
	])("rejects malformed demand before IO %j", async (change) => {
		const call = vi.fn();
		await expect(
			reserveRuntimeNodeMachine({ ...machine, ...change } as RuntimeNodeMachine, { call }, signal()),
		).rejects.toThrow("INVALID_RUNTIME_NODE_MACHINE");
		expect(call).not.toHaveBeenCalled();
	});
});
