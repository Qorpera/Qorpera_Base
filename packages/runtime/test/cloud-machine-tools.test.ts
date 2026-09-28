import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
import { type CloudMachineCommandGateway, CloudMachineCommandRefusal } from "../src/cloud-machine-command-http.ts";
import { cloudMachineTools } from "../src/cloud-machine-tools.ts";
import { CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";
import {
	type CloudNativeToolOperations,
	cloudNativeToolOperationEnvelope,
} from "../src/cloud-native-tool-operations.ts";
import { CLOUD_RUNTIME_TOOL_OPERATIONS } from "../src/cloud-runtime-observability.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fixture(machines: { name: string; state: string }[] = [{ name: "build-a", state: "running" }]) {
	const { authority, binding } = nativeToolAuthorityFixture();
	const identity = authority.identity;
	const listed = machines.map((machine) => ({
		machineId: randomUUID(),
		cpus: 2,
		memoryGiB: 4,
		diskGiB: 40,
		...machine,
	}));
	const receiptId = randomUUID();
	const receipt = (machineId: string, commandId: string, state = "running") => ({
		schema: "qorpera.machine-command-result/v1",
		machineId,
		commandId,
		inputSha256: "a".repeat(64),
		state,
		exitCode: state === "succeeded" ? 0 : null,
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
	});
	const control = {
		call: vi.fn(async (method: string, args: Record<string, unknown>) => {
			if (method === "qorpera_native_machine_manage") {
				const request = args.p_request as { action: string; machine?: string };
				if (request.action === "list") return { schema: "qorpera.machine-list/v1", machines: listed };
				const machine = listed.find((entry) => entry.name === request.machine);
				return machine
					? {
							schema: "qorpera.machine-change/v1",
							machine: { ...machine, state: request.action === "stop" ? "stopping" : "deleting" },
						}
					: {
							schema: "qorpera.machine-change/v1",
							refused: { reason: "MACHINE_NOT_FOUND", message: "no machine" },
						};
			}
			if (method === "qorpera_native_machine_start")
				return args.p_action === "authorize"
					? { state: "authorized" }
					: { schema: "qorpera.machine-start/v1", machine: { ...listed[0], state: "waiting", queuePosition: 2 } };
			throw new Error(`unexpected ${method}`);
		}),
	};
	const gateway = {
		start: vi.fn<CloudMachineCommandGateway["start"]>(
			async (scope, input) => receipt(scope.machineId, input.commandId) as never,
		),
		read: vi.fn<CloudMachineCommandGateway["read"]>(
			async (scope, input) => receipt(scope.machineId, input.commandId, "succeeded") as never,
		),
		cancel: vi.fn<CloudMachineCommandGateway["cancel"]>(
			async (scope, commandId) => receipt(scope.machineId, commandId, "cancelled") as never,
		),
	};
	const execute = vi.fn<CloudNativeToolOperations["execute"]>(async (options) => {
		await options.authorize(options.operation, identity, options.signal);
		return (
			await options.perform(options.operation, {
				identity,
				receiptId,
				inputSha256: "a".repeat(64),
				idempotencyKey: "b".repeat(64),
				signal: options.signal,
			})
		).content;
	});
	const tools = cloudMachineTools({
		binding,
		identity,
		control: control as unknown as CloudCompanyPathControl,
		operations: { execute },
		gateway,
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: identity.companyId,
		runId: identity.runId,
		identity,
		tools,
		assertActive: async () => undefined,
		signal: new AbortController().signal,
	});
	const content = (result: { contentItems: { text: string }[] }) =>
		JSON.parse(
			JSON.parse(result.contentItems[0].text).content.text ??
				JSON.stringify(JSON.parse(result.contentItems[0].text).content.value),
		);
	return { identity, binding, listed, receiptId, control, gateway, execute, tools, boundary, content };
}

describe("machine tools", () => {
	it("are the seven machine operations the runtime observes by name", () => {
		const f = fixture();
		expect(f.tools.map((tool) => tool.name)).toEqual([
			"machine_start",
			"machine_run",
			"machine_read",
			"machine_cancel",
			"machine_stop",
			"machine_delete",
			"machine_list",
		]);
		for (const tool of f.tools) expect(CLOUD_RUNTIME_TOOL_OPERATIONS).toContain(tool.name);
		f.boundary.close();
	});

	it("starts a machine through a receipt: the exact envelope is authorized, then begun once", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "suite", name: "build-b", purpose: "Run the SQL suite", cpus: 8, memoryGiB: 16 };
			const result = await f.boundary.invoke("s1", "qorpera", "machine_start", args);
			expect(result.success).toBe(true);
			const operation = f.execute.mock.calls[0][0].operation;
			expect(operation).toEqual({
				tool: "machine_start",
				toolVersion: "qorpera.machine-tools/v1",
				logicalOperationKey: "suite",
				arguments: {
					name: "build-b",
					purpose: "Run the SQL suite",
					cpus: 8,
					memoryGiB: 16,
					diskGiB: 40,
					lifetime: "task",
				},
				target: { realm: "company_machine" },
				requiresCompanyRevision: false,
			});
			const [authorize, begin] = f.control.call.mock.calls;
			expect(authorize).toEqual([
				"qorpera_native_machine_start",
				{
					p_binding: f.binding,
					p_envelope: cloudNativeToolOperationEnvelope(f.identity, operation),
					p_action: "authorize",
				},
				expect.any(AbortSignal),
			]);
			expect(begin?.[1]).toMatchObject({
				p_action: "begin",
				p_receipt_id: f.receiptId,
				p_envelope: authorize?.[1].p_envelope,
			});
		} finally {
			f.boundary.close();
		}
	});

	it("wakes a machine by name only, and needs a purpose for a new one", async () => {
		const f = fixture();
		try {
			expect(
				(await f.boundary.invoke("w", "qorpera", "machine_start", { operationKey: "wake", machine: "build-a" }))
					.success,
			).toBe(true);
			expect(f.execute.mock.calls[0][0].operation.arguments).toEqual({ machine: "build-a" });
			for (const [index, bad] of [
				{ operationKey: "x", machine: "build-a", cpus: 2 },
				{ operationKey: "x", name: "no-purpose" },
				{ operationKey: "x", name: "Bad Name", purpose: "x" },
				{ operationKey: "x", name: "big", purpose: "x", cpus: 65 },
			].entries())
				expect((await f.boundary.invoke(`bad-${index}`, "qorpera", "machine_start", bad)).success).toBe(false);
		} finally {
			f.boundary.close();
		}
	});

	it("runs a command on a running machine with its handle bound to the receipt, and no deadline unless asked", async () => {
		const f = fixture();
		try {
			const args = { operationKey: "suite:1", machine: "build-a", command: "npm test", notify: true };
			expect((await f.boundary.invoke("r1", "qorpera", "machine_run", args)).success).toBe(true);
			expect(f.gateway.start).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				{ commandId: f.receiptId, inputSha256: "a".repeat(64), command: "npm test", timeoutMs: null, notify: true },
				expect.any(AbortSignal),
			);
			expect(f.execute.mock.calls[0][0].operation).toMatchObject({
				tool: "machine_run",
				arguments: args,
				target: { realm: "company_machine", machineId: f.listed[0].machineId },
			});
		} finally {
			f.boundary.close();
		}
	});

	it("answers an executor's refusal as a refused result: nothing started", async () => {
		const f = fixture();
		try {
			f.gateway.start.mockRejectedValueOnce(new CloudMachineCommandRefusal("MACHINE_COMMAND_ENDED"));
			const given = await f.boundary.invoke("r1", "qorpera", "machine_run", {
				operationKey: "suite:1",
				machine: "build-a",
				command: "npm test",
			});
			expect(given.success).toBe(true);
			expect(given.contentItems[0].text).toContain("MACHINE_COMMAND_ENDED");
			f.gateway.start.mockRejectedValueOnce(new Error("MACHINE_NOT_RUNNING"));
			const stopped = await f.boundary.invoke("r2", "qorpera", "machine_run", {
				operationKey: "suite:2",
				machine: "build-a",
				command: "npm test",
			});
			expect(stopped.contentItems[0].text).toContain("MACHINE_NOT_RUNNING");
		} finally {
			f.boundary.close();
		}
	});

	it("tells the agent when a machine is missing or not running, without a receipt", async () => {
		const f = fixture([{ name: "waiting-one", state: "waiting" }]);
		try {
			const notRunning = await f.boundary.invoke("r1", "qorpera", "machine_run", {
				operationKey: "k",
				machine: "waiting-one",
				command: "true",
			});
			expect(notRunning.success).toBe(true);
			expect(notRunning.contentItems[0].text).toContain("MACHINE_NOT_RUNNING");
			const missing = await f.boundary.invoke("r2", "qorpera", "machine_read", {
				machine: "nobody",
				commandId: randomUUID(),
			});
			expect(missing.contentItems[0].text).toContain("MACHINE_NOT_FOUND");
			expect(f.execute).not.toHaveBeenCalled();
			expect(f.gateway.start).not.toHaveBeenCalled();
		} finally {
			f.boundary.close();
		}
	});

	it("reads, cancels, stops, deletes and lists", async () => {
		const f = fixture();
		try {
			const commandId = randomUUID();
			expect(
				(await f.boundary.invoke("a", "qorpera", "machine_read", { machine: "build-a", commandId, tail: true }))
					.success,
			).toBe(true);
			expect(f.gateway.read).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				{ commandId, tail: true, limit: 4096 },
				expect.any(AbortSignal),
			);
			expect(
				(
					await f.boundary.invoke("b", "qorpera", "machine_cancel", {
						operationKey: "c",
						machine: "build-a",
						commandId,
					})
				).success,
			).toBe(true);
			expect(f.gateway.cancel).toHaveBeenCalledWith(
				{ machineId: f.listed[0].machineId },
				commandId,
				expect.any(AbortSignal),
			);
			const stop = await f.boundary.invoke("c", "qorpera", "machine_stop", { machine: "build-a" });
			expect(stop.contentItems[0].text).toContain("stopping");
			const gone = await f.boundary.invoke("d", "qorpera", "machine_delete", { machine: "nobody" });
			expect(gone.contentItems[0].text).toContain("MACHINE_NOT_FOUND");
			const list = await f.boundary.invoke("e", "qorpera", "machine_list", {});
			expect(list.contentItems[0].text).toContain("build-a");
		} finally {
			f.boundary.close();
		}
	});
});
